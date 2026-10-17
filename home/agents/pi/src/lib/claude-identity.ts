import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";

import { attributionFields, readAttribution, readFingerprintFlow } from "./claude-attribution.ts";
import { readFingerprint } from "./claude-fingerprint.ts";
import { discoverCliProfile, type CliProfile } from "./claude-profile.ts";
import { readRequestIdentity } from "./claude-request-identity.ts";
import { extractCliSigner, validateCliChecksum } from "./claude-signer.ts";
import { JavaScript } from "./javascript.ts";
import { awaitAbort, cached } from "./promise.ts";
import { errorMessage } from "./settings.ts";

const Text = Type.String();

const Count = Type.Integer({ minimum: 0 });

const Bytes = Type.Codec(Type.String())
  .Decode((text): Buffer => Buffer.from(text, "base64"))
  .Encode((bytes) => bytes.toString("base64"));

const LauncherStamp = Type.Object({ path: Text, target: Text, stamp: Text });

// Save only binary-derived fields. Never add account, device, or session IDs.
const Source = Type.Object({
  launchers: Type.Array(LauncherStamp),
  executable: Text,
  executableStamp: Text,
  version: Text,
  signer: Type.Object({
    seed: Type.Codec(Type.String({ pattern: "^\\d+$" }))
      .Decode(BigInt)
      .Encode(String),
    bodyMarker: Bytes,
    modelMarker: Bytes,
    omissions: Type.Immutable(
      Type.Array(
        Type.Object({
          kind: Type.Union([Type.Literal("array"), Type.Literal("string"), Type.Literal("number")]),
          marker: Bytes,
        }),
      ),
    ),
    placeholder: Bytes,
    window: Count,
    checksumOffset: Count,
    checksumDigits: Count,
  }),
  piPrompt: Text,
  runtimePath: Text,
  runtimeStamp: Text,
  profilePath: Text,
  prefix: Text,
  salt: Text,
  indices: Type.Array(Count),
  padding: Text,
  algorithm: Text,
  digestLength: Count,
  origin: Text,
});

type LauncherStamp = StaticDecode<typeof LauncherStamp>;

type SourceIdentity = StaticDecode<typeof Source>;

export interface ClaudeIdentity extends SourceIdentity {
  profile: CliProfile;
  subscriptionType: string;
  organizationId: string;
}

function launcherTarget(source: string): string {
  const matches = source.matchAll(/^[ \t]*exec(?: -a "[^"]+")? "([^"]+)"(?:[ \t]|$)/gm);
  const first = matches.next();

  if (first.done || !matches.next().done) {
    throw new Error("Claude CLI launcher format changed or is ambiguous. Request blocked.");
  }

  return field(first.value, 1);
}

function field(match: RegExpExecArray, index: number): string {
  const value = match[index];

  if (value === undefined) {
    throw new Error("Claude CLI identity is incomplete. Request blocked.");
  }

  return value;
}

function fileStamp(path: string): string {
  const info = statSync(path);

  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

const runFile = promisify(execFile);

const AuthStatus = Type.Object({
  loggedIn: Type.Literal(true),
  authMethod: Type.Literal("claude.ai"),
  apiProvider: Type.Literal("firstParty"),
  subscriptionType: Type.String({ minLength: 1 }),
  email: Type.String({ minLength: 1 }),
  orgId: Type.String({ minLength: 1 }),
});

async function readSubscription(launcher: string) {
  const { stdout } = await runFile(launcher, ["auth", "status", "--json"], {
    timeout: 5000,
    maxBuffer: 65_536,
  });

  const status: unknown = JSON.parse(stdout);

  if (!Value.Check(AuthStatus, status)) {
    throw new Error("Claude CLI OAuth plan is unavailable. Request blocked.");
  }

  return {
    subscriptionType: status.subscriptionType,
    organizationId: status.orgId,
    accountKey: createHash("sha256").update(status.email).digest("hex"),
  };
}

const ProbeBody = Type.Object({
  messages: Type.Array(
    Type.Object({
      role: Text,
      content: Type.Union([
        Text,
        Type.Array(Type.Object({ type: Text, text: Type.Optional(Text) })),
      ]),
    }),
  ),
});

export function requestFingerprint(text: string, identity: SourceIdentity): string {
  const sample = identity.indices.map((index) => text[index] || identity.padding).join("");

  return createHash(identity.algorithm)
    .update(`${identity.salt}${sample}${identity.version}`)
    .digest("hex")
    .slice(0, identity.digestLength);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const sources = new Map<string, Promise<SourceIdentity>>();

// Sources read from source-identity.json rather than scanned in this process.
const savedSources = new WeakSet<SourceIdentity>();

const SavedSource = Type.Object({ code: Text, source: Source });

const savedPath = () =>
  join(getAgentDir(), "extensions", "anthropic-billing", "source-identity.json");

// Edits to the scanning code invalidate saved sources.
function scanHash(): string {
  const hash = createHash("sha256");

  for (const file of [
    "claude-identity",
    "javascript",
    "acorn-parser",
    "bun-modules",
    "claude-fingerprint",
    "claude-attribution",
    "claude-request-identity",
    "claude-signer",
    "claude-signer-arm64",
    "claude-signer-x64",
    "binary",
    "macho",
    "elf",
  ]) {
    hash.update(readFileSync(new URL(`./${file}.ts`, import.meta.url)));
  }

  hash.update(readFileSync(new URL(import.meta.resolve("acorn"))));

  return hash.digest("hex");
}

function readSavedSource(launcher: string, version: string): SourceIdentity | undefined {
  try {
    const { code, source } = Value.Decode(
      SavedSource,
      JSON.parse(readFileSync(savedPath(), "utf8")),
    );

    assertCliUnchanged(source);

    if (
      code !== scanHash() ||
      source.version !== version ||
      source.launchers[0]?.path !== resolve(launcher)
    ) {
      return undefined;
    }

    savedSources.add(source);

    return source;
  } catch {
    return undefined;
  }
}

function saveSource(source: SourceIdentity): void {
  const path = savedPath();
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;

  try {
    const saved = Value.Encode(SavedSource, { code: scanHash(), source });

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (cause) {
    rmSync(tmp, { force: true });
    throw new Error(
      `Couldn't save the Claude CLI identity to ${path}. ${errorMessage(cause)}. Request blocked.`,
      { cause },
    );
  }
}

const subscriptions = new Map<string, ReturnType<typeof readSubscription>>();

const profiles = new Map<string, Promise<CliProfile>>();

async function readExecutable(launcher: string) {
  const launchers: LauncherStamp[] = [];
  const seen = new Set<string>();
  let path = resolve(launcher);

  for (;;) {
    const target = await realpath(path);

    if (seen.has(target)) {
      throw Object.assign(
        new Error("Claude CLI launcher chain contains a cycle. Request blocked."),
        { code: "CLAUDE_LAUNCHER_CYCLE" },
      );
    }

    seen.add(target);
    const stamp = fileStamp(target);
    launchers.push({ path, target, stamp });
    const bytes = await readFile(target);

    if (bytes.subarray(0, 2).toString() !== "#!") {
      return { launchers, executable: target, executableStamp: stamp, bytes };
    }

    const next = launcherTarget(bytes.toString());

    if (!isAbsolute(next) || next.includes("$") || next.includes("\x60")) {
      throw new Error("Claude CLI launcher uses an unsupported shell target. Request blocked.");
    }

    path = next;
  }
}

async function sourceIdentity(launcher: string, version: string): Promise<SourceIdentity> {
  const { launchers, executable, executableStamp, bytes } = await readExecutable(launcher);
  const signer = extractCliSigner(bytes);
  const runtimePath = process.execPath;
  const runtimeStamp = fileStamp(runtimePath);

  const source = new JavaScript(bytes);
  const { builder, prefix } = readAttribution(source, version);
  const flow = readFingerprintFlow(source, builder);
  const fingerprintValues = readFingerprint(version, flow.caller);
  const { prompt, ...requestValues } = readRequestIdentity(source, flow.selector);

  return {
    launchers,
    executable,
    executableStamp,
    version,
    prefix,
    ...fingerprintValues,
    ...requestValues,
    piPrompt: prompt,
    runtimePath,
    runtimeStamp,
    signer,
  };
}

function verifyProfile(identity: SourceIdentity, profile: CliProfile): void {
  const { device_id: device, account_uuid: account, session_id: session } = profile.metadataUserId;

  if (!device || !account || !session || !profile.attributionText.startsWith(identity.prefix)) {
    throw new Error("Claude CLI OAuth profile identity is incomplete. Request blocked.");
  }

  if (!validateCliChecksum(profile.rawBody, identity.signer)) {
    throw new Error("Claude CLI signer doesn't match its captured request. Request blocked.");
  }

  verifyFingerprint(identity, profile);
  verifyTraceFields(identity, profile);
}

function verifyFingerprint(identity: SourceIdentity, profile: CliProfile): void {
  const body: unknown = JSON.parse(profile.rawBody);

  if (!Value.Check(ProbeBody, body)) {
    throw new Error("Claude CLI fingerprint probe format changed. Request blocked.");
  }

  if (!JSON.stringify(body.messages).includes(profile.probePrompt)) {
    throw new Error("Claude CLI did not send the supplied fingerprint probe. Request blocked.");
  }

  // The CLI hashes the prompt before adding system reminders, so hash the probe prompt itself.
  const expected = `${identity.version}.${requestFingerprint(profile.probePrompt, identity)}`;

  if (attributionFields(profile.attributionText, identity.prefix).get("cc_version") !== expected) {
    throw new Error("Claude CLI fingerprint doesn't match its captured request. Request blocked.");
  }
}

function verifyTraceFields(identity: SourceIdentity, profile: CliProfile): void {
  const fields = attributionFields(profile.attributionText, identity.prefix);
  const prompt = fields.get("cc_prompt_id");
  const values = Object.values(profile.headers);
  const session = profile.metadataUserId.session_id;

  const request = values.filter((value) => isUuid(value) && value !== prompt && value !== session);

  if (
    prompt === undefined ||
    !values.includes(prompt) ||
    session === undefined ||
    !values.includes(session) ||
    request.length === 0
  ) {
    throw new Error("Claude CLI request ID headers changed. Request blocked.");
  }

  for (const name of ["cc_prompt_index", "cc_turn_index"]) {
    const value = fields.get(name);

    if (value === undefined || !/^\d+$/.test(value)) {
      throw new Error("Claude CLI attribution counters changed. Request blocked.");
    }
  }
}

// A saved source can be from an older scan, so a mismatch rescans once. A mismatch with a source
// scanned in this process fails right away.
async function verifiedSource(
  launcher: string,
  version: string,
  sourceKey: string,
  source: SourceIdentity,
  captured: CliProfile,
): Promise<SourceIdentity> {
  try {
    verifyProfile(source, captured);

    return source;
  } catch (cause) {
    if (!savedSources.has(source)) {
      throw cause;
    }

    sources.delete(sourceKey);

    const scanned = await cached(sources, sourceKey, () => sourceIdentity(launcher, version));

    verifyProfile(scanned, captured);

    return scanned;
  }
}

async function captureProfile(
  launcher: string,
  version: string,
  model: string,
  sourceKey: string,
  source: SourceIdentity,
): Promise<CliProfile> {
  const captured = await discoverCliProfile(launcher, model);
  const verified = await verifiedSource(launcher, version, sourceKey, source, captured);

  saveSource(verified);

  return captured;
}

export async function readClaudeIdentity(
  launcher: string,
  version: string,
  model: string,
  signal?: AbortSignal,
  validateSubscription?: (subscriptionType: string) => void,
): Promise<ClaudeIdentity> {
  const sourceKey = `${launcher}:${version}`;

  const loadSource = () =>
    cached(
      sources,
      sourceKey,
      async () => readSavedSource(launcher, version) ?? sourceIdentity(launcher, version),
    );

  const [loaded, { accountKey, ...subscription }] = await awaitAbort(
    Promise.all([loadSource(), cached(subscriptions, sourceKey, () => readSubscription(launcher))]),
    signal,
  );

  assertCliUnchanged(loaded);

  validateSubscription?.(subscription.subscriptionType);
  const profileKey = `${loaded.executableStamp}:${subscription.organizationId}:${accountKey}:${model}`;

  const profile = await awaitAbort(
    cached(profiles, profileKey, () => captureProfile(launcher, version, model, sourceKey, loaded)),
    signal,
  );

  // Reload because captureProfile may have replaced the source.
  const source = await awaitAbort(loadSource(), signal);
  assertCliUnchanged(source);

  return { ...source, profile, ...subscription };
}

export function assertCliUnchanged(identity: SourceIdentity): void {
  if (
    identity.launchers.some(
      ({ path, target, stamp }) => realpathSync(path) !== target || fileStamp(target) !== stamp,
    ) ||
    fileStamp(identity.executable) !== identity.executableStamp ||
    process.execPath !== identity.runtimePath ||
    fileStamp(identity.runtimePath) !== identity.runtimeStamp
  ) {
    throw new Error(
      "Claude CLI or pi runtime changed during this session. Reload pi before sending Anthropic OAuth requests.",
    );
  }
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { discoverCliProfile, type CliProfile } from "./claude-profile.ts";
import { extractCliSigner, validateCliChecksum, type CliSignerConfig } from "./claude-signer.ts";
import { awaitAbort, cached } from "./promise.ts";

export interface ClaudeIdentity {
  launchers: readonly LauncherStamp[];
  executable: string;
  executableStamp: string;
  version: string;
  profile: CliProfile;
  subscriptionType: string;
  organizationId: string;
  signer: CliSignerConfig;
  piPrompt: string;
  runtimePath: string;
  runtimeStamp: string;
  profilePath: string;
  prefix: string;
  salt: string;
  indices: number[];
  padding: string;
  algorithm: string;
  digestLength: number;
  origin: string;
}

interface LauncherStamp {
  path: string;
  target: string;
  stamp: string;
}

function matched(source: string, pattern: RegExp, name: string): RegExpExecArray {
  const matches = source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`));
  const first = matches.next();

  if (first.done || !matches.next().done) {
    throw new Error(`Claude CLI ${name} format changed or is ambiguous. Request blocked.`);
  }

  return first.value;
}

function field(match: RegExpExecArray, index: number): string {
  const value = match[index];

  if (value === undefined) {
    throw new Error("Claude CLI identity is incomplete. Request blocked.");
  }

  return value;
}

function escapedIdentifier(name: string): string {
  return name.replaceAll("$", "\\$");
}

function fingerprint(source: string, version: string) {
  const match = matched(
    source,
    /import\{createHash as ([$\w]+)\}from"(?:node:)?crypto";var ([$\w]+)="([^"]+)";.{0,800}?function [$\w]+\(([$\w]+),([$\w]+)\)\{let ([$\w]+)=\[([\d,]+)\]\.map\(\(([$\w]+)\)=>\4\[\8\]\|\|"([^"]+)"\)\.join\(""\),([$\w]+)=`\$\{\2\}\$\{\6\}\$\{\5\}`;return \1\("([^"]+)"\)\.update\(\10\)\.digest\("hex"\)\.slice\(0,(\d+)\)\}/,
    "fingerprint",
  );

  const reader = matched(
    match[0],
    /function ([$\w]+)\(([$\w]+)\)\{let ([$\w]+)=\2\.find\(\(([$\w]+)\)=>\4\.type==="user"&&!\4\.isMeta\);if\(!\3\)return"";let ([$\w]+)=\3\.message\.content;if\(typeof \5==="string"\)return \5;if\(Array\.isArray\(\5\)\)\{let ([$\w]+)=\5\.find\(\(([$\w]+)\)=>\7\.type==="text"\);if\(\6&&\6\.type==="text"\)return \6\.text\}return""\}/,
    "first-user text reader",
  );

  const hash = matched(
    match[0],
    /function ([$\w]+)\([^)]*,[^)]*\)\{let [$\w]+=\[/,
    "fingerprint function name",
  );

  const after = source.slice(match.index + match[0].length, match.index + match[0].length + 2000);

  const caller = matched(
    after,
    /^function ([$\w]+)\(([$\w]+)\)\{let ([$\w]+)=([$\w]+)\(\2\);return ([$\w]+)\(\3,\{[^}]+VERSION:"([^"]+)"[^}]+\}\.VERSION\)\}/,
    "request fingerprint caller",
  );

  if (
    field(caller, 4) !== field(reader, 1) ||
    field(caller, 5) !== field(hash, 1) ||
    field(caller, 6) !== version
  ) {
    throw new Error("Claude CLI fingerprint call changed. Request blocked.");
  }

  return {
    caller: field(caller, 1),
    salt: field(match, 3),
    indices: field(match, 7).split(",").map(Number),
    padding: field(match, 9),
    algorithm: field(match, 11),
    digestLength: Number(field(match, 12)),
  };
}

function attributionSuffixes(setup: string, interpolations: string, cch: string): void {
  const variables = Array.from(interpolations.matchAll(/\$\{([$\w]+)\}/g), (match) =>
    field(match, 1),
  );

  const labels = [
    "cc_workload",
    "cc_is_subagent",
    "cc_prev_req",
    "cc_prompt_id",
    "cc_turn_origin",
    "cc_prompt_index",
  ];

  if (variables.shift() !== cch || variables.length !== labels.length) {
    throw new Error("Claude CLI attribution fields changed. Request blocked.");
  }

  for (const [index, variable] of variables.entries()) {
    const label = labels[index];
    const symbol = escapedIdentifier(variable);

    const literal = field(
      matched(
        setup,
        new RegExp(`[,;]${symbol}=[^;]{0,400}?[\x60"] ((${label})=[^\x60"]+)[\x60"]:""`),
        "optional attribution field",
      ),
      1,
    );

    const fields = Array.from(literal.matchAll(/\b(cc_\w+)=/g), (match) => field(match, 1));
    const expected = index === labels.length - 1 ? `${label},cc_turn_index` : label;

    if (fields.join(",") !== expected) {
      throw new Error("Claude CLI optional attribution fields changed. Request blocked.");
    }
  }
}

function attribution(source: string, version: string) {
  const prefix = field(
    matched(
      source,
      /var ([$\w]+)="([^"]+billing[^"]+:)";function [$\w]+\([^)]*\)\{let ([$\w]+)=[$\w]+\.text;return typeof \3==="string"&&\3\.startsWith\(\1\)/,
      "attribution prefix",
    ),
    2,
  );

  const builder = matched(
    source,
    /function ([$\w]+)\(([$\w,]+)\)\{(.{0,3000}?),([$\w]+)=`([^`]+) cc_version=\$\{([$\w]+)\}; cc_entrypoint=\$\{([$\w]+)\};((?:\$\{[$\w]+\})+)`;return [$\w]+\(`attribution header \$\{\4\}`\),\4\}/,
    "complete attribution builder",
  );

  const setup = field(builder, 3);

  const bindings = matched(
    setup,
    /let ([$\w]+)=`\$\{\{[^}]+VERSION:"([^"]+)"[^}]+\}\.VERSION\}\.\$\{([$\w]+)\}`,([$\w]+)=process\.env\.CLAUDE_CODE_ENTRYPOINT\?\?"[^"]+",([$\w]+)=[^;]{0,200}\?"( cch=[^"]+;)":""/,
    "attribution bindings",
  );

  if (
    field(builder, 5) !== prefix ||
    field(builder, 6) !== field(bindings, 1) ||
    field(builder, 7) !== field(bindings, 4) ||
    field(bindings, 2) !== version ||
    field(bindings, 3) !== field(builder, 2).split(",")[0]
  ) {
    throw new Error("Claude CLI attribution bindings changed. Request blocked.");
  }

  attributionSuffixes(setup, field(builder, 8), field(bindings, 5));

  return { builder: field(builder, 1), prefix, cch: field(bindings, 6) };
}

function assertFingerprintFlow(source: string, caller: string, builder: string): void {
  const bridge = matched(
    source,
    new RegExp(
      `function ([$\\w]+)\\(([$\\w]+),([$\\w]+),([$\\w]+)\\)\\{let ([$\\w]+)=${escapedIdentifier(builder)}\\(\\4\\.fingerprint,\\4\\.agentContext,\\4\\.previousRequestId,\\4\\.promptId,\\4\\.turnOrigin,\\4\\.turnPosition\\),([$\\w]+)=[$\\w]+\\(\\[\\5,\\3,\\.\\.\\.\\2\\]\\.filter\\(Boolean\\)\\);return [$\\w]+\\(\\6\\),\\6\\}`,
    ),
    "fingerprint attribution bridge",
  );

  matched(
    source,
    new RegExp(
      `let ([$\\w]+)=${escapedIdentifier(caller)}\\(([$\\w]+)\\),.{0,1000}?[$\\w]+=${escapedIdentifier(field(bridge, 1))}\\([^,]+,[^,]+,\\{fingerprint:\\1,agentContext:[^}]+\\}\\)`,
    ),
    "request fingerprint flow",
  );
}

function requestIdentity(source: string) {
  const prompt = field(
    matched(
      source,
      /var ([$\w]+)="([^"]+)",([$\w]+)="([^"]+)",([$\w]+)="([^"]+)",[$\w]+=\[\1,\3,\5\],[$\w]+=new Set\([$\w]+\);function [^{]+\{[^}]+\}function [^{]+\{[^}]+isNonInteractive[^}]+\}return \1\}/,
      "identity prompt selector",
    ),
    2,
  );

  const host = field(
    matched(
      source,
      /function [$\w]+\(e\)\{try\{let t=new URL\(e\)\.host;return\["([^"]+)"\]\.includes\(t\)\}catch\{return!1\}\}/,
      "first-party host",
    ),
    1,
  );

  const profilePath = field(
    matched(
      source,
      /function [$\w]+\(e\)\{let n=`\$\{[$\w]+\(\)\.BASE_API_URL\}([^`]+)`;try\{let r=await [$\w]+\.get\(n,\{headers:\{"User-Agent":[$\w]+\(\),Authorization:`Bearer \$\{e\}`/,
      "OAuth profile endpoint",
    ),
    1,
  );

  return { prompt, profilePath, origin: `https://${host}` };
}

function fileStamp(path: string): string {
  const info = statSync(path);

  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

type SourceIdentity = Omit<ClaudeIdentity, "profile" | "subscriptionType" | "organizationId">;

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

const Text = Type.String();

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

export function attributionFields(profile: CliProfile): Map<string, string> {
  return new Map(
    Array.from(profile.attributionText.matchAll(/\b(cc_\w+|cch)=([^;]+);/g), (match) => [
      field(match, 1),
      field(match, 2),
    ]),
  );
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const sources = new Map<string, Promise<SourceIdentity>>();

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

    const next = field(
      matched(bytes.toString(), /^[ \t]*exec(?: -a "[^"]+")? "([^"]+)"(?:[ \t]|$)/m, "launcher"),
      1,
    );

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

  const source = bytes.toString("latin1");
  const { caller, ...fingerprintValues } = fingerprint(source, version);
  const { builder, prefix } = attribution(source, version);
  const { prompt, ...requestValues } = requestIdentity(source);

  assertFingerprintFlow(source, caller, builder);

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
  verifyTraceFields(profile);
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

  if (attributionFields(profile).get("cc_version") !== expected) {
    throw new Error("Claude CLI fingerprint doesn't match its captured request. Request blocked.");
  }
}

function verifyTraceFields(profile: CliProfile): void {
  const fields = attributionFields(profile);
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

export async function readClaudeIdentity(
  launcher: string,
  version: string,
  model: string,
  signal?: AbortSignal,
  validateSubscription?: (subscriptionType: string) => void,
): Promise<ClaudeIdentity> {
  const sourceKey = `${launcher}:${version}`;

  const source = await awaitAbort(
    cached(sources, sourceKey, () => sourceIdentity(launcher, version)),
    signal,
  );

  assertCliUnchanged(source);

  const { accountKey, ...subscription } = await awaitAbort(
    cached(subscriptions, sourceKey, () => readSubscription(launcher)),
    signal,
  );

  validateSubscription?.(subscription.subscriptionType);
  const profileKey = `${source.executableStamp}:${subscription.organizationId}:${accountKey}:${model}`;

  const profile = await awaitAbort(
    cached(profiles, profileKey, async () => {
      const captured = await discoverCliProfile(launcher, model);
      verifyProfile(source, captured);

      return captured;
    }),
    signal,
  );

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

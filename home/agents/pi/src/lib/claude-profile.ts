import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const timeoutMs = 15_000;

const probePrompt = "Reply exactly OK. No other text.";

const TextBlock = Type.Object({ type: Type.Literal("text"), text: Type.String() });

const MessagesRequest = Type.Object({
  model: Type.String(),
  stream: Type.Literal(true),
  max_tokens: Type.Number({ minimum: 1 }),
  system: Type.Array(TextBlock, { minItems: 2 }),
  messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Unknown() })),
  metadata: Type.Object({ user_id: Type.String() }),
  // The first request has no earlier reply to name.
  diagnostics: Type.Optional(
    Type.Object({ previous_message_id: Type.Null() }, { additionalProperties: false }),
  ),
});

const UserId = Type.Record(Type.String(), Type.String(), { minProperties: 1 });

export interface CliProfile {
  readonly probePrompt: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly identityPrompt: string;
  /** Replace the probe's per-request fields before sending. */
  readonly attributionText: string;
  /** Do not log or save these account, device, and session IDs. */
  readonly metadataUserId: Readonly<Record<string, string>>;
  readonly model: string;
  readonly rawBody: string;
  /** The request carries `diagnostics: { previous_message_id: null }`. */
  readonly diagnostics: boolean;
}

const transportHeaders = new Set([
  "host",
  "content-length",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "accept-encoding",
]);

// Headers yields lowercase names.
const secretHeaderParts = [
  "auth",
  "cookie",
  "apikey",
  "api-key",
  "api_key",
  "token",
  "secret",
  "credential",
];

export function profileHeaders(headers: Headers): Readonly<Record<string, string>> {
  const excluded = new Set(transportHeaders);

  for (const name of (headers.get("connection") ?? "").split(",")) {
    excluded.add(name.trim().toLowerCase());
  }

  const entries = [...headers].filter(
    ([name]) => !excluded.has(name) && !secretHeaderParts.some((part) => name.includes(part)),
  );

  return Object.freeze(Object.fromEntries(entries));
}

export function assertOAuthRequest(headers: Headers): void {
  if (!headers.get("authorization")?.startsWith("Bearer sk-ant-oat") || headers.has("x-api-key")) {
    throw new Error("Claude CLI profile probe requires normal CLI OAuth authentication.");
  }
}

function captureProfile(headers: Headers, rawBody: string): CliProfile {
  assertOAuthRequest(headers);

  const body: unknown = JSON.parse(rawBody);

  if (!Value.Check(MessagesRequest, body)) {
    throw new Error("Claude CLI profile request format changed.");
  }

  const userId: unknown = JSON.parse(body.metadata.user_id);

  if (!Value.Check(UserId, userId)) {
    throw new Error("Claude CLI metadata.user_id format changed.");
  }

  const [attribution, identity] = body.system;

  if (attribution === undefined || identity === undefined) {
    throw new Error("Claude CLI profile is missing its system identity blocks.");
  }

  return Object.freeze({
    probePrompt,
    headers: profileHeaders(headers),
    identityPrompt: identity.text,
    attributionText: attribution.text,
    metadataUserId: Object.freeze({ ...userId }),
    model: body.model,
    rawBody,
    diagnostics: body.diagnostics !== undefined,
  });
}

/** A streamed reply from the local mock. */
export interface MockReply {
  readonly id: string;
  readonly model: string;
  readonly stopReason: "end_turn" | "tool_use";
  /** Events of the content blocks. */
  readonly content: readonly (readonly [string, unknown])[];
  readonly headers?: Readonly<Record<string, string>>;
}

export const okText = [
  [
    "content_block_start",
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
] as const;

export function mockReply(reply: MockReply): Response {
  const start = {
    type: "message_start",
    message: {
      id: reply.id,
      type: "message",
      role: "assistant",
      model: reply.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  };

  const end = {
    type: "message_delta",
    delta: { stop_reason: reply.stopReason, stop_sequence: null },
    usage: { output_tokens: 1 },
  };

  const events = [
    ["message_start", start],
    ...reply.content,
    ["message_delta", end],
    ["message_stop", { type: "message_stop" }],
  ] as const;

  const stream = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");

  return new Response(stream, {
    headers: { ...reply.headers, "content-type": "text/event-stream" },
  });
}

// Like a normal `claude --print` run, except where the local mock needs otherwise.
function probeEnvironment(origin: string, added: Readonly<Record<string, string>>) {
  const env = { ...Bun.env };

  for (const name of [
    // The profile must come from the stored claude.ai OAuth login, as pi's requests use OAuth.
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    // May hold secrets, which the profile would save and replay.
    "ANTHROPIC_CUSTOM_HEADERS",
    // pi talks to Anthropic's first-party API.
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    // Would log the probe's requests.
    "CLAUDE_CODE_DEBUG_LOG_FILE",
    // The mock is plain HTTP and its requests carry the OAuth token, so no proxy may see them.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete env[name];
  }

  return {
    ...env,
    ANTHROPIC_BASE_URL: origin,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    // Keeps the billing header and checksum, which the CLI sends only to first-party URLs.
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
    // --print sets this. An inherited value, such as when pi runs inside Claude Code, would change
    // cc_entrypoint and the user agent.
    CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
    // Doesn't change the requests, and keeps memory files out of ~/.claude for the temp directory.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ...added,
  };
}

/** Arguments for a `claude --print` probe run that answers `prompt` with only `tools` available. */
export function cliArguments(
  executable: string,
  model: string,
  prompt: string,
  tools: readonly string[],
): string[] {
  const allowed = tools.length === 0 ? [] : ["--allowedTools", tools.join(",")];

  return [
    executable,
    "-p",
    prompt,
    "--model",
    model,
    "--tools",
    tools.join(","),
    ...allowed,
    "--system-prompt",
    "Answer briefly.",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--output-format",
    "json",
  ];
}

export interface LocalCliRun {
  readonly args: readonly string[];
  /** Added to the probe environment, after probeEnvironment's own settings. */
  readonly env: Readonly<Record<string, string>>;
  /** Prefix of the temporary directory the CLI runs in. */
  readonly tempPrefix: string;
  /** Prepares that directory before the CLI starts. */
  readonly setup?: (cwd: string) => Promise<void>;
  readonly timeoutMs: number;
  readonly timeoutMessage: string;
  /** The run fails with this if the CLI exits with an error or `handle` throws. */
  readonly failureMessage: string;
  readonly handle: (request: Request, cwd: string) => Promise<Response>;
}

// Runs the CLI in a temporary directory against a local mock API, so model requests stay local.
// The CLI may still refresh its OAuth token, fetch feature flags, and send telemetry.
export async function runLocalCli(run: LocalCliRun): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), run.tempPrefix));

  try {
    await run.setup?.(cwd);
    await serveCli(run, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// Serves only POST /v1/messages on 127.0.0.1 and runs the CLI against it until it exits.
async function serveCli(run: LocalCliRun, cwd: string): Promise<void> {
  let handleFailed = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 1_048_576,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages") {
        return new Response("Local profile capture never forwards requests.", { status: 404 });
      }

      try {
        return await run.handle(request, cwd);
      } catch {
        // The error may contain credentials or request data, so the run fails with
        // failureMessage instead.
        handleFailed = true;

        return new Response("Invalid local CLI request.", { status: 400 });
      }
    },
    error() {
      return new Response("Local CLI profile capture failed.", { status: 500 });
    },
  });

  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    child = Bun.spawn([...run.args], {
      cwd,
      env: probeEnvironment(server.url.origin, run.env),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(run.timeoutMessage)), run.timeoutMs);
    });

    const code = await Promise.race([child.exited, timedOut]);

    if (code !== 0 || handleFailed) {
      throw new Error(run.failureMessage);
    }
  } finally {
    clearTimeout(timer);

    try {
      if (child !== undefined) {
        child.kill("SIGKILL");
        await child.exited;
      }
    } finally {
      await server.stop(true);
    }
  }
}

export async function discoverCliProfile(
  executable: string,
  model: string,
  env: Readonly<Record<string, string>>,
): Promise<CliProfile> {
  const failureMessage = "Claude CLI OAuth profile probe did not complete a valid local request.";
  let profile: CliProfile | undefined;

  await runLocalCli({
    args: cliArguments(executable, model, probePrompt, []),
    env,
    tempPrefix: "claude-profile-",
    timeoutMs,
    timeoutMessage: "Claude CLI profile probe timed out.",
    failureMessage,
    async handle(request) {
      const captured = captureProfile(request.headers, await request.text());
      profile ??= captured;

      return mockReply({
        id: "local-profile-probe",
        model: captured.model,
        stopReason: "end_turn",
        content: okText,
      });
    },
  });

  if (profile === undefined) {
    throw new Error(failureMessage);
  }

  return profile;
}

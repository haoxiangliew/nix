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
});

const UserId = Type.Record(Type.String(), Type.String(), { minProperties: 1 });

export interface CliProfile {
  readonly probePrompt: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly identityPrompt: string;
  /** From the probe request. Replace its per-request fields before sending. */
  readonly attributionText: string;
  /** Account, device, and session IDs. Don't log or save them. */
  readonly metadataUserId: Readonly<Record<string, string>>;
  readonly model: string;
  readonly rawBody: string;
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

function profileHeaders(headers: Headers): Readonly<Record<string, string>> {
  const excluded = new Set(transportHeaders);

  for (const name of (headers.get("connection") ?? "").split(",")) {
    excluded.add(name.trim().toLowerCase());
  }

  const entries = [...headers].filter(
    ([name]) =>
      !excluded.has(name) && !/(?:auth|cookie|api[-_]?key|token|secret|credential)/i.test(name),
  );

  return Object.freeze(Object.fromEntries(entries));
}

function captureProfile(headers: Headers, rawBody: string): CliProfile {
  if (!headers.get("authorization")?.startsWith("Bearer sk-ant-oat") || headers.has("x-api-key")) {
    throw new Error("Claude CLI profile probe requires normal CLI OAuth authentication.");
  }

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
  });
}

function mockMessage(model: string): Response {
  const events = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "local-profile-probe",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ] as const;

  const stream = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");

  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function probeEnvironment(origin: string) {
  const env = { ...Bun.env };

  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_DEBUG_LOG_FILE",
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
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
    CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16",
    MAX_THINKING_TOKENS: "0",
  };
}

function probeArguments(executable: string, model: string): string[] {
  return [
    executable,
    "-p",
    probePrompt,
    "--model",
    model,
    "--tools",
    "",
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

async function runProbe(executable: string, model: string, cwd: string): Promise<CliProfile> {
  let profile: CliProfile | undefined;
  let captureFailed = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 1_048_576,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages") {
        return new Response("Local profile capture never forwards requests.", { status: 404 });
      }

      try {
        const captured = captureProfile(request.headers, await request.text());
        profile ??= captured;

        return mockMessage(captured.model);
      } catch {
        // Drop the error, since it may contain headers, credentials, or the request.
        captureFailed = true;

        return new Response("Invalid local CLI profile request.", { status: 400 });
      }
    },
    error() {
      return new Response("Local CLI profile capture failed.", { status: 500 });
    },
  });

  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    child = Bun.spawn(probeArguments(executable, model), {
      cwd,
      env: probeEnvironment(server.url.origin),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Claude CLI profile probe timed out.")), timeoutMs);
    });

    const code = await Promise.race([child.exited, timedOut]);

    if (code !== 0 || captureFailed || profile === undefined) {
      throw new Error("Claude CLI OAuth profile probe did not complete a valid local request.");
    }

    return profile;
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

/**
 * Runs the CLI against a local mock API, so model requests never leave the machine. The CLI may
 * still refresh its OAuth token.
 */
export async function discoverCliProfile(executable: string, model: string): Promise<CliProfile> {
  const cwd = await mkdtemp(join(tmpdir(), "claude-profile-"));

  try {
    return await runProbe(executable, model, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

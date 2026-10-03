import type { FetchFunction } from "@earendil-works/pi-ai";

import { normalizeContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";
import { Value } from "typebox/value";

function anthropicProvider() {
  const provider = builtinProviders().find((candidate) => candidate.id === "anthropic");

  if (provider === undefined || provider.baseUrl === undefined) {
    throw new Error("Pi's built-in Anthropic provider is unavailable. Request blocked.");
  }

  return provider;
}

export const piAnthropicProvider = anthropicProvider();

const Serialized = Type.String({ minLength: 1 });

const ProbeBody = Type.Object({
  system: Type.Array(
    Type.Object({ type: Type.Literal("text"), text: Type.String({ minLength: 1 }) }),
  ),
});

export interface PiIdentity {
  prompt: string;
  userAgent: string;
  app: string;
}

function probePrompt(serialized: string): string {
  const body: unknown = JSON.parse(serialized);
  const prompt = Value.Check(ProbeBody, body) ? body.system[0]?.text : undefined;

  if (prompt === undefined) {
    throw new Error("Pi's Anthropic OAuth probe system prompt changed. Request blocked.");
  }

  return prompt;
}

function capturedIdentity(
  input: Parameters<FetchFunction>[0],
  init: RequestInit | undefined,
  apiKey: string,
): PiIdentity {
  if (!Value.Check(Serialized, init?.body)) {
    throw new Error("Pi's Anthropic OAuth probe body is not serialized JSON. Request blocked.");
  }

  const prompt = probePrompt(init.body);

  const headers = new Headers(
    init.headers ?? (input instanceof Request ? input.headers : undefined),
  );

  const userAgent = headers.get("user-agent");
  const app = headers.get("x-app");

  if (
    userAgent === null ||
    app === null ||
    headers.get("authorization") !== `Bearer ${apiKey}` ||
    headers.has("x-api-key")
  ) {
    throw new Error("Pi's Anthropic OAuth probe format changed. Request blocked.");
  }

  return { prompt, userAgent, app };
}

export async function readPiIdentity(apiKey: string, signal?: AbortSignal): Promise<PiIdentity> {
  signal?.throwIfAborted();

  const model = piAnthropicProvider
    .getModels()
    .find((candidate) => candidate.api === "anthropic-messages");

  if (model === undefined) {
    throw new Error("Pi's Anthropic Messages model catalog is unavailable. Request blocked.");
  }

  let captured: PiIdentity | undefined;
  let failure: unknown;

  // A local fetch keeps the probe off the network and out of the billing wrapper.
  const capture = async (input: Parameters<FetchFunction>[0], init?: RequestInit) => {
    try {
      captured = capturedIdentity(input, init, apiKey);
    } catch (cause) {
      failure = cause;
    }

    // The SDK doesn't retry a 400.
    return Response.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "Local identity capture." },
      },
      { status: 400 },
    );
  };

  const fetch = Object.assign(capture, globalThis.fetch);
  const timeout = AbortSignal.timeout(5000);

  const result = await piAnthropicProvider
    .streamSimple(
      { ...model, baseUrl: "http://127.0.0.1:0" },
      normalizeContext({
        messages: [{ role: "user", content: "Identity probe.", timestamp: Date.now() }],
      }),
      {
        apiKey,
        fetch,
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
        env: {},
      },
    )
    .result();

  signal?.throwIfAborted();

  if (failure !== undefined || captured === undefined || result.stopReason !== "error") {
    throw Object.assign(
      new Error("Pi's Anthropic OAuth identity capture failed. Request blocked.", {
        cause: failure,
      }),
      { code: "PI_IDENTITY_CAPTURE" },
    );
  }

  return captured;
}

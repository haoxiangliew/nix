import type { FetchFunction } from "@earendil-works/pi-ai";

import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { assertBillingReady, billingQuotaError } from "./billing-quota.ts";
import {
  assertCliUnchanged,
  attributionFields,
  isUuid,
  requestFingerprint,
  type ClaudeIdentity,
} from "./claude-identity.ts";
import { signCliBody } from "./claude-signer.ts";
import { piAnthropicProvider, readPiIdentity } from "./pi-identity.ts";
import { awaitAbort, cached } from "./promise.ts";

const targetOrigin = new URL(piAnthropicProvider.baseUrl!).origin;

const Text = Type.String();

const Block = Type.Object({ type: Text, text: Type.Optional(Text) });

const Payload = Type.Object({
  model: Text,
  system: Type.Array(Block),
  messages: Type.Array(Type.Object({ role: Text, content: Type.Union([Text, Type.Array(Block)]) })),
  metadata: Type.Optional(Type.Record(Text, Type.Unknown())),
});

const AccountProfile = Type.Object({
  account: Type.Object({ uuid: Text }),
  organization: Type.Object({ uuid: Text }),
});

type Payload = Static<typeof Payload>;

type FetchInput = Parameters<FetchFunction>[0];

interface PreparedRequest {
  init: RequestInit;
  subscriptionType: string;
  session: BillingSession;
}

export interface BillingSession {
  sessionId: string;
  promptId: string;
  promptIndex: number;
  turnIndex: number;
  quotaError?: Error;
}

export type BillingIdentity =
  | Error
  | ((model: string, signal: AbortSignal | undefined) => Promise<ClaudeIdentity>);

const accounts = new Map<string, Promise<void>>();

function firstUserText(payload: Payload): string {
  const content = payload.messages.find((message) => message.role === "user")?.content;

  if (Value.Check(Text, content)) {
    return content;
  }

  return content?.find((block) => block.type === "text")?.text ?? "";
}

function billingBlock(payload: Payload, identity: ClaudeIdentity, session: BillingSession): string {
  const fields = attributionFields(identity.profile);

  const replacements = new Map([
    ["cc_version", `${identity.version}.${requestFingerprint(firstUserText(payload), identity)}`],
    ["cch", identity.signer.placeholder.subarray(identity.signer.checksumOffset).toString("ascii")],
    ["cc_prompt_id", session.promptId],
    [
      "cc_prompt_index",
      String(Number(fields.get("cc_prompt_index")) + Math.max(0, session.promptIndex)),
    ],
    ["cc_turn_index", String(Number(fields.get("cc_turn_index")) + session.turnIndex)],
  ]);

  return identity.profile.attributionText.replace(
    /\b(cc_\w+|cch)=([^;]+);/g,
    (original, name: string) =>
      replacements.has(name) ? `${name}=${replacements.get(name)};` : original,
  );
}

async function assertHeaders(
  headers: Headers,
  identity: ClaudeIdentity,
  signal?: AbortSignal,
): Promise<void> {
  const original = await readPiIdentity(
    headers.get("authorization")!.slice("Bearer ".length),
    signal,
  );

  if (
    original.prompt !== identity.piPrompt ||
    headers.get("user-agent") !== original.userAgent ||
    headers.has("x-api-key") ||
    headers.get("x-app") !== original.app
  ) {
    throw new Error("Pi's Anthropic OAuth identity headers changed. Request blocked.");
  }
}

function tracedHeaders(identity: ClaudeIdentity, session: BillingSession): Headers {
  const fields = attributionFields(identity.profile);
  const metadata = identity.profile.metadataUserId;

  const values = new Map<string, string>([
    [metadata.session_id!, session.sessionId],
    [metadata.account_uuid!, metadata.account_uuid!],
    [metadata.device_id!, metadata.device_id!],
  ]);

  const prompt = fields.get("cc_prompt_id");

  if (prompt !== undefined) {
    values.set(prompt, session.promptId);
  }

  const headers = new Headers();

  for (const [name, value] of Object.entries(identity.profile.headers)) {
    if (isUuid(value) && !values.has(value)) {
      values.set(value, crypto.randomUUID());
    }

    headers.set(name, values.get(value) ?? value);
  }

  return headers;
}

function mirrorHeaders(headers: Headers, identity: ClaudeIdentity, session: BillingSession): void {
  const captured = tracedHeaders(identity, session);

  const betas = new Set(
    (captured.get("anthropic-beta") ?? "")
      .split(",")
      .map((beta) => beta.trim())
      .filter(Boolean),
  );

  for (const beta of (headers.get("anthropic-beta") ?? "").split(",")) {
    if (beta.trim() !== "") {
      betas.add(beta.trim());
    }
  }

  const stale = Array.from(headers.keys()).filter(
    (name) => name.startsWith("x-stainless-") && !captured.has(name),
  );

  for (const name of stale) {
    headers.delete(name);
  }

  for (const [name, value] of captured) {
    headers.set(name, value);
  }

  headers.set("anthropic-beta", [...betas].join(","));
  headers.delete("content-length");
}

function attributedBody(
  payload: Payload,
  identity: ClaudeIdentity,
  session: BillingSession,
): string {
  const [first, ...rest] = payload.system;

  if (first?.type !== "text" || first.text !== identity.piPrompt) {
    throw new Error("Pi's original Anthropic OAuth identity prompt changed. Request blocked.");
  }

  const system = [
    { type: "text", text: billingBlock(payload, identity, session) },
    { ...first, text: identity.profile.identityPrompt },
    ...rest,
  ];

  const metadata = {
    ...payload.metadata,
    user_id: JSON.stringify({ ...identity.profile.metadataUserId, session_id: session.sessionId }),
  };

  return signCliBody(JSON.stringify({ ...payload, system, metadata }), identity.signer);
}

async function fetchAccount(
  upstream: FetchFunction,
  headers: Headers,
  identity: ClaudeIdentity,
): Promise<void> {
  try {
    const response = await upstream(new URL(identity.profilePath, identity.origin), {
      headers: {
        authorization: headers.get("authorization")!,
        "user-agent": identity.profile.headers["user-agent"]!,
        "content-type": "application/json",
        "cache-control": "no-cache",
      },
      signal: AbortSignal.timeout(10_000),
    });

    const profile: unknown = await response.json();

    if (
      !response.ok ||
      !Value.Check(AccountProfile, profile) ||
      profile.account.uuid !== identity.profile.metadataUserId.account_uuid ||
      profile.organization.uuid !== identity.organizationId
    ) {
      throw new Error("account mismatch");
    }
  } catch (cause) {
    throw new Error(
      "Pi's Anthropic OAuth account could not be matched to the Claude CLI. Request blocked.",
      { cause },
    );
  }
}

async function assertAccount(
  upstream: FetchFunction,
  headers: Headers,
  identity: ClaudeIdentity,
  signal: AbortSignal | undefined,
): Promise<void> {
  const key =
    createHash("sha256").update(headers.get("authorization")!).digest("hex") +
    identity.profile.metadataUserId.account_uuid +
    identity.organizationId;

  await awaitAbort(
    cached(accounts, key, () => fetchAccount(upstream, headers, identity)),
    signal,
  );
}

function messageUrl(input: FetchInput): URL | null {
  const url = URL.parse(input instanceof Request ? input.url : String(input));

  return url?.pathname === "/v1/messages" ? url : null;
}

function isPost(input: FetchInput, init: RequestInit | undefined): boolean {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");

  return method.toUpperCase() === "POST";
}

function requestHeaders(input: FetchInput, init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

function isOAuth(headers: Headers): boolean {
  return headers.get("authorization")?.startsWith("Bearer sk-ant-oat") === true;
}

function parsePayload(init: RequestInit | undefined): Payload {
  if (!Value.Check(Text, init?.body)) {
    throw new Error(
      "Pi's Anthropic OAuth request body is no longer serialized JSON. Request blocked.",
    );
  }

  const payload: unknown = JSON.parse(init.body);

  if (!Value.Check(Payload, payload)) {
    throw new Error("Pi's Anthropic OAuth payload format changed. Request blocked.");
  }

  return payload;
}

async function prepareRequest(
  upstream: FetchFunction,
  init: RequestInit | undefined,
  headers: Headers,
  identity: ClaudeIdentity,
  session: BillingSession,
  payload: Payload,
): Promise<PreparedRequest> {
  const signal = init?.signal ?? undefined;
  assertBillingReady(identity.subscriptionType, session.quotaError);
  await assertHeaders(headers, identity, signal);
  await assertAccount(upstream, headers, identity, signal);
  assertCliUnchanged(identity);
  const body = attributedBody(payload, identity, session);
  mirrorHeaders(headers, identity, session);
  session.turnIndex++;

  return { init: { ...init, headers, body }, subscriptionType: identity.subscriptionType, session };
}

async function checkedResponse(
  response: Response,
  subscriptionType: string,
  session: BillingSession,
): Promise<Response> {
  if (!response.ok) {
    return response;
  }

  const cause = billingQuotaError(response.headers, subscriptionType);

  if (cause === undefined) {
    return response;
  }

  session.quotaError = cause;

  try {
    await response.body?.cancel();
  } catch (error) {
    return blockedResponse(
      new Error(`${cause.message} Response cancellation failed.`, { cause: error }),
    );
  }

  return blockedResponse(cause);
}

function blockedResponse(cause: unknown): Response {
  const message =
    cause instanceof Error
      ? cause.message
      : "Anthropic OAuth billing check failed. Request blocked.";

  // The SDK retries thrown fetch errors but not a 400.
  return Response.json(
    { type: "error", error: { type: "invalid_request_error", message } },
    { status: 400 },
  );
}

async function prepareOAuth(
  upstream: FetchFunction,
  init: RequestInit | undefined,
  headers: Headers,
  identity: BillingIdentity,
  session: BillingSession | undefined,
  url: URL,
): Promise<PreparedRequest> {
  if (identity instanceof Error) {
    throw identity;
  }

  const payload = parsePayload(init);
  const resolved = await identity(payload.model, init?.signal ?? undefined);

  if (url.origin !== resolved.origin) {
    throw new Error("Pi and Claude CLI Anthropic origins differ. Request blocked.");
  }

  if (session === undefined || session.sessionId === "") {
    throw new Error("Pi's session identity is unavailable. Request blocked.");
  }

  return prepareRequest(upstream, init, headers, resolved, session, payload);
}

function billedUrl(input: FetchInput, init: RequestInit | undefined, headers: Headers) {
  const url = messageUrl(input);

  return url?.origin === targetOrigin && isPost(input, init) && isOAuth(headers) ? url : null;
}

async function prepare(
  upstream: FetchFunction,
  init: RequestInit | undefined,
  headers: Headers,
  identity: BillingIdentity,
  session: BillingSession | undefined,
  url: URL,
): Promise<PreparedRequest | Response> {
  const signal = init?.signal ?? undefined;

  try {
    signal?.throwIfAborted();
    const prepared = await prepareOAuth(upstream, init, headers, identity, session, url);
    signal?.throwIfAborted();
    assertBillingReady(prepared.subscriptionType, prepared.session.quotaError);

    return prepared;
  } catch (cause) {
    signal?.throwIfAborted();

    return blockedResponse(cause);
  }
}

export function billingFetch(
  upstream: FetchFunction,
  identity: BillingIdentity,
  session?: BillingSession,
): FetchFunction {
  const wrapped = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const headers = requestHeaders(input, init);
    const url = billedUrl(input, init, headers);

    if (url === null) {
      return upstream(input, init);
    }

    const prepared = await prepare(upstream, init, headers, identity, session, url);

    if (prepared instanceof Response) {
      return prepared;
    }

    const response = await upstream(input, prepared.init);

    return checkedResponse(response, prepared.subscriptionType, prepared.session);
  };

  return Object.assign(wrapped, upstream);
}

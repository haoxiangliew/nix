import type { FetchFunction } from "@earendil-works/pi-ai";

import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import {
  hasBeta,
  isRequestId,
  isUuid,
  orderedBody,
  toolDurationsHeader,
  toolDurationsValue,
  toolsUsedHeader,
  toolsUsedValue,
  withPreviousRequest,
} from "./billing-fields.ts";
import { assertBillingReady, billingQuotaError } from "./billing-quota.ts";
import { recordToolsUsed, type BillingSession, type ThreadState } from "./billing-session.ts";
import {
  noteRefusedContinue,
  planThread,
  threadResponse,
  ThreadField,
  type ThreadPlan,
} from "./billing-thread.ts";
import { attributionFields, attributionText } from "./claude-attribution.ts";
import { assertCliUnchanged, cliVersion, type ClaudeIdentity } from "./claude-identity.ts";
import { signCliBody } from "./claude-signer.ts";
import { threadsBetaPrefix, type TurnFormat } from "./claude-turns.ts";
import { requestHeaders, type FetchInput } from "./fetch.ts";
import { piAnthropicProvider, readPiIdentity } from "./pi-identity.ts";
import { awaitAbort, cached } from "./promise.ts";

const targetOrigin = new URL(piAnthropicProvider.baseUrl!).origin;

const Text = Type.String();

const Block = Type.Object({ type: Text, text: Type.Optional(Text) });

const ToolUse = Type.Object({ type: Type.Literal("tool_use"), name: Text });

// A thread continue has no system prompt or tools. The server keeps the ones it was created with.
const Payload = Type.Object({
  model: Text,
  system: Type.Optional(Type.Array(Block)),
  messages: Type.Array(Type.Object({ role: Text, content: Type.Union([Text, Type.Array(Block)]) })),
  max_tokens: Type.Integer({ minimum: 1 }),
  metadata: Type.Optional(Type.Record(Text, Type.Unknown())),
  tools: Type.Optional(Type.Array(Type.Object({ name: Text }))),
  thread: ThreadField,
  diagnostics: Type.Optional(Type.Never()),
});

const AccountProfile = Type.Object({
  account: Type.Object({ uuid: Text }),
  organization: Type.Object({ uuid: Text }),
});

type Payload = Static<typeof Payload>;

interface PreparedRequest {
  init: RequestInit;
  subscriptionType: string;
  session: BillingSession;
  main: boolean;
  plan: ThreadPlan;
}

interface RequestContext {
  /** Undefined when the request doesn't depend on the CLI's later requests. */
  turns: TurnFormat | undefined;
  /** A request of the agent loop, not compaction, cache warming, or an extension call. */
  main: boolean;
}

export type { BillingSession };

type BillingIdentity =
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

// Like the CLI, the turn index counts prompts, not requests. The prompt index advances only when
// the profile's turn origin is human, and a --print profile's origin isn't.
function billingBlock(
  ccVersion: string,
  identity: ClaudeIdentity,
  session: BillingSession,
  previousRequest: string | undefined,
): string {
  const fields = attributionFields(identity.profile.attributionText, identity.prefix);
  const prompts = Math.max(0, session.promptIndex);
  const promptStep = fields.get("cc_turn_origin") === "human" ? 1 : 0;

  const replacements = new Map([
    ["cc_version", ccVersion],
    ["cch", identity.signer.placeholder.subarray(identity.signer.checksumOffset).toString("ascii")],
    ["cc_prompt_id", session.promptId],
    ["cc_prompt_index", String(Number(fields.get("cc_prompt_index")) + promptStep * prompts)],
    ["cc_turn_index", String(Number(fields.get("cc_turn_index")) + prompts)],
  ]);

  const updated = new Map(
    [...fields].map(([name, value]) => [name, replacements.get(name) ?? value]),
  );

  return attributionText(
    identity.prefix,
    previousRequest === undefined ? updated : withPreviousRequest(updated, previousRequest),
  );
}

// The CLI names the request-id of the conversation's last reply.
function previousRequestId(session: BillingSession, turns: RequestContext["turns"]) {
  const requestId = session.reply?.requestId;

  return turns?.previousRequest === true && isRequestId(requestId) ? requestId : undefined;
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
  const fields = attributionFields(identity.profile.attributionText, identity.prefix);
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

function betaHeader(captured: Headers, headers: Headers, withThreads: boolean): string {
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

  return [...betas].filter((beta) => withThreads || !beta.startsWith(threadsBetaPrefix)).join(",");
}

function turnHeaders(
  headers: Headers,
  identity: ClaudeIdentity,
  session: BillingSession,
  context: RequestContext,
): void {
  // Set only when the CLI sent the header as `[]` on its first request.
  if (identity.profile.headers[toolsUsedHeader] === toolsUsedValue([])) {
    headers.set(toolsUsedHeader, toolsUsedValue(session.toolsUsed));
  }

  const durations =
    context.main && context.turns?.toolDurations === true
      ? toolDurationsValue(session.toolRuns)
      : undefined;

  if (durations === undefined) {
    headers.delete(toolDurationsHeader);
  } else {
    headers.set(toolDurationsHeader, durations);
  }
}

function mirrorHeaders(
  headers: Headers,
  identity: ClaudeIdentity,
  session: BillingSession,
  context: RequestContext,
): void {
  const captured = tracedHeaders(identity, session);

  // If the CLI doesn't thread, requests drop the threads beta.
  const betas = betaHeader(captured, headers, context.turns?.threads !== false);

  const stale = Array.from(headers.keys()).filter(
    (name) => name.startsWith("x-stainless-") && !captured.has(name),
  );

  for (const name of stale) {
    headers.delete(name);
  }

  for (const [name, value] of captured) {
    headers.set(name, value);
  }

  headers.set("anthropic-beta", betas);
  headers.delete("content-length");
  turnHeaders(headers, identity, session, context);
}

function cliSystem(payload: Payload, identity: ClaudeIdentity): unknown[] {
  const [first, ...rest] = payload.system ?? [];

  if (first?.type !== "text" || first.text !== identity.piPrompt) {
    throw new Error("Pi's original Anthropic OAuth identity prompt changed. Request blocked.");
  }

  return [{ ...first, text: identity.profile.identityPrompt }, ...rest];
}

// A continue repeats the stored system prompt and tools only when the CLI would.
function bodyParts(payload: Payload, identity: ClaudeIdentity, plan: ThreadPlan): ThreadState {
  if (plan.type !== "continue") {
    return {
      ccVersion: cliVersion(firstUserText(payload), identity),
      system: cliSystem(payload, identity),
      tools: payload.tools,
    };
  }

  if (payload.system !== undefined || payload.tools !== undefined) {
    throw new Error("Pi's Anthropic OAuth payload format changed. Request blocked.");
  }

  const { state, full } = plan;

  return {
    ccVersion: state.ccVersion,
    system: full ? state.system : [],
    tools: full ? state.tools : undefined,
  };
}

function toolUses(payload: Payload): string[] {
  return payload.messages
    .flatMap(({ role, content }) => (role === "assistant" && Array.isArray(content) ? content : []))
    .flatMap((block) => (Value.Check(ToolUse, block) ? [block.name] : []));
}

// Like the CLI, which keeps this per agent, only the main loop's own requests update wireTools,
// toolsUsed and thread. Only a create starts a thread, so a request without one keeps it.
function remember(
  session: BillingSession,
  payload: Payload,
  parts: ThreadState,
  plan: ThreadPlan,
  main: boolean,
) {
  if (!main || plan.type === "continue") {
    return;
  }

  if (payload.tools !== undefined) {
    session.wireTools = payload.tools.map((tool) => tool.name);
  }

  recordToolsUsed(session, toolUses(payload));

  if (plan.type === "create") {
    session.thread = parts;
  }
}

function diagnostics(
  identity: ClaudeIdentity,
  session: BillingSession,
  main: boolean,
): { previous_message_id: string | null } | undefined {
  const gated = hasBeta(identity.profile.headers["anthropic-beta"], "cache-diagnosis-");

  if (!main || !gated || !identity.profile.diagnostics) {
    return undefined;
  }

  return { previous_message_id: session.reply?.messageId ?? null };
}

function attributedBody(
  payload: Payload,
  identity: ClaudeIdentity,
  session: BillingSession,
  parts: ThreadState,
  context: RequestContext,
): string {
  const billing = billingBlock(
    parts.ccVersion,
    identity,
    session,
    previousRequestId(session, context.turns),
  );

  const metadata = {
    ...payload.metadata,
    user_id: JSON.stringify({ ...identity.profile.metadataUserId, session_id: session.sessionId }),
  };

  const body = {
    ...payload,
    system: [{ type: "text", text: billing }, ...parts.system],
    tools: parts.tools,
    metadata,
    diagnostics: diagnostics(identity, session, context.main),
  };

  return signCliBody(JSON.stringify(orderedBody(body)), identity.signer);
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
      "Pi couldn't match its Anthropic OAuth account to the Claude CLI. Request blocked.",
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

// The multi-request probe runs only once a request depends on what the CLI sends after its first
// request. A failed probe blocks the request.
async function turnFormat(
  identity: ClaudeIdentity,
  payload: Payload,
  headers: Headers,
  session: BillingSession,
  signal: AbortSignal | undefined,
): Promise<RequestContext["turns"]> {
  if (
    payload.thread === undefined &&
    !hasBeta(headers.get("anthropic-beta"), threadsBetaPrefix) &&
    session.reply === undefined &&
    session.toolRuns.length === 0
  ) {
    return undefined;
  }

  return identity.readTurns(signal);
}

// pi's cache warmer repeats the last request with max_tokens 1 and no thread, and may do so while
// the reply streams. The agent loop asks for more, unless the context window is full.
function isCacheRefresh(payload: Payload): boolean {
  return payload.max_tokens === 1 && payload.thread === undefined;
}

function isMainRequest(session: BillingSession, side: boolean, payload: Payload): boolean {
  return !side && session.awaitingReply && !session.compacting && !isCacheRefresh(payload);
}

async function prepareRequest(
  upstream: FetchFunction,
  init: RequestInit | undefined,
  headers: Headers,
  identity: ClaudeIdentity,
  session: BillingSession,
  payload: Payload,
  side: boolean,
): Promise<PreparedRequest | Response> {
  const signal = init?.signal ?? undefined;
  assertBillingReady(identity.subscriptionType, session.quotaError);
  await assertHeaders(headers, identity, signal);
  await assertAccount(upstream, headers, identity, signal);
  assertCliUnchanged(identity);
  const turns = await turnFormat(identity, payload, headers, session, signal);
  const plan = planThread(payload.thread, turns, session);

  if (plan.type === "refuse") {
    return threadResponse(plan.code);
  }

  const context = { turns, main: isMainRequest(session, side, payload) };
  const parts = bodyParts(payload, identity, plan);
  remember(session, payload, parts, plan, context.main);
  const body = attributedBody(payload, identity, session, parts, context);
  mirrorHeaders(headers, identity, session, context);

  return {
    init: { ...init, headers, body },
    subscriptionType: identity.subscriptionType,
    session,
    main: context.main,
    plan,
  };
}

async function checkedResponse(response: Response, prepared: PreparedRequest): Promise<Response> {
  const { session, subscriptionType } = prepared;

  if (!response.ok) {
    await noteRefusedContinue(response, prepared.plan, session);

    return response;
  }

  if (prepared.main) {
    session.responseRequestId = response.headers.get("request-id") ?? undefined;
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

  // Like the SDK, pi retries thrown fetch errors but not a 400.
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
  side: boolean,
): Promise<PreparedRequest | Response> {
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

  return prepareRequest(upstream, init, headers, resolved, session, payload, side);
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
  side: boolean,
): Promise<PreparedRequest | Response> {
  const signal = init?.signal ?? undefined;

  try {
    signal?.throwIfAborted();
    const prepared = await prepareOAuth(upstream, init, headers, identity, session, url, side);
    signal?.throwIfAborted();

    if (!(prepared instanceof Response)) {
      assertBillingReady(prepared.subscriptionType, prepared.session.quotaError);
    }

    return prepared;
  } catch (cause) {
    signal?.throwIfAborted();

    return blockedResponse(cause);
  }
}

/** `side` marks extension calls, which the CLI would send outside its agent loop. */
export function billingFetch(
  upstream: FetchFunction,
  identity: BillingIdentity,
  session?: BillingSession,
  side = false,
): FetchFunction {
  const wrapped = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const headers = requestHeaders(input, init);
    const url = billedUrl(input, init, headers);

    if (url === null) {
      return upstream(input, init);
    }

    const prepared = await prepare(upstream, init, headers, identity, session, url, side);

    if (prepared instanceof Response) {
      return prepared;
    }

    const response = await upstream(input, prepared.init);

    return checkedResponse(response, prepared);
  };

  return Object.assign(wrapped, upstream);
}

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { BillingReply, BillingSession, ThreadState } from "./billing-session.ts";
import type { TurnFormat } from "./claude-turns.ts";

import { featureValue } from "./claude-flags.ts";

const Thread = Type.Union([
  Type.Object({ type: Type.Literal("create") }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal("continue"), previous_message_id: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

export const ThreadField = Type.Optional(Thread);

const ApiError = Type.Object({
  error: Type.Object({
    details: Type.Optional(Type.Object({ error_code: Type.Optional(Type.String()) })),
  }),
});

// The CLI's default and limits for tengu_jaunty_charm.
const minLifetimeSeconds = 300;

const maxLifetimeSeconds = 3600;

const Lifetime = Type.Integer({ minimum: minLifetimeSeconds, maximum: maxLifetimeSeconds });

// tengu_jaunty_charm as the CLI reads it. Any other value turns client-side expiry off.
const Charm = Type.Object({
  ttl_seconds: Lifetime,
  cc_closed_turn_ttl_seconds: Type.Optional(Type.Union([Lifetime, Type.Null()])),
});

export type ThreadErrorCode = "thread_not_found" | "thread_unsupported_request";

export type ThreadPlan =
  | { readonly type: "none" | "create" }
  | { readonly type: "continue"; readonly state: ThreadState; readonly full: boolean };

/** A plan to send, or an error response pi-ai reads as a thread signal. */
export type ThreadDecision =
  | ThreadPlan
  | { readonly type: "refuse"; readonly code: ThreadErrorCode };

type PiThread = Static<typeof Thread>;

// Error responses pi-ai reads as thread signals. It resends as a new thread, or without threads.
export function threadResponse(code: ThreadErrorCode): Response {
  const missing = code === "thread_not_found";

  return Response.json(
    {
      type: "error",
      error: {
        type: missing ? "not_found_error" : "invalid_request_error",
        message: missing
          ? "The message thread is missing or idle past its lifetime."
          : "The Claude CLI does not use message threads for this account.",
        details: { error_code: code },
      },
    },
    { status: missing ? 404 : 400 },
  );
}

// Like the CLI, tengu_jaunty_charm sets the thread lifetime, and a separate one after a finished
// turn.
function lifetimeMs(openTurn: boolean): number | undefined {
  const charm = featureValue("tengu_jaunty_charm", Charm, { ttl_seconds: minLifetimeSeconds });

  if (charm === undefined) {
    return undefined;
  }

  const open = charm.ttl_seconds;
  const closed = charm.cc_closed_turn_ttl_seconds ?? open;

  return closed < open ? undefined : (openTurn ? open : closed) * 1000;
}

function expired(reply: BillingReply): boolean {
  const lifetime = lifetimeMs(reply.toolUse);

  return lifetime !== undefined && Date.now() - reply.endedAt >= lifetime;
}

function continuePlan(
  thread: Extract<PiThread, { type: "continue" }>,
  threads: "billing" | "full",
  session: BillingSession,
): ThreadDecision {
  const { thread: state, reply } = session;

  if (
    state === undefined ||
    reply === undefined ||
    reply.messageId !== thread.previous_message_id ||
    expired(reply)
  ) {
    return { type: "refuse", code: "thread_not_found" };
  }

  return { type: "continue", state, full: threads === "full" || session.fullThreadFields };
}

export function planThread(
  thread: PiThread | undefined,
  turns: TurnFormat | undefined,
  session: BillingSession,
): ThreadDecision {
  if (thread === undefined) {
    return { type: "none" };
  }

  if (!turns?.threads) {
    return { type: "refuse", code: "thread_unsupported_request" };
  }

  return thread.type === "create"
    ? { type: "create" }
    : continuePlan(thread, turns.threads, session);
}

// The fields a fingerprint mismatch names, read the way the CLI reads them. It returns undefined
// for any other response, and an empty list if the message names no fields.
async function mismatchedFields(response: Response): Promise<string[] | undefined> {
  const text = await response.clone().text();
  const code = errorCode(text);

  // The CLI also treats a 400 without an error code as a mismatch if its message names differing
  // fields. Matching only the code would keep sending continues the server refuses.
  const mismatch =
    code === undefined ? text.includes("differing field") : code === "thread_fingerprint_mismatch";

  if (!mismatch) {
    return undefined;
  }

  const named = /differing field\(s\):\s*([A-Za-z_,\s-]+)/i.exec(text)?.[1];

  return named?.split(",").map((name) => name.trim().toLowerCase()) ?? [];
}

// A 400 from a proxy or gateway may not be JSON. Such a body names no error code.
function errorCode(text: string): string | undefined {
  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }

    throw error;
  }

  return Value.Check(ApiError, body) ? body.error.details?.error_code : undefined;
}

// Like the CLI, a refused continue that left the system prompt or tools to the server sends them
// in full for the rest of the session.
export async function noteRefusedContinue(
  response: Response,
  plan: ThreadPlan,
  session: BillingSession,
): Promise<void> {
  if (plan.type !== "continue" || plan.full || response.status !== 400) {
    return;
  }

  const fields = await mismatchedFields(response);

  if (
    fields !== undefined &&
    (fields.length === 0 ||
      fields.includes("system") ||
      (plan.state.tools !== undefined && fields.includes("tools")))
  ) {
    session.fullThreadFields = true;
  }
}

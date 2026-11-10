import type { FetchFunction } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { billingFetch, type BillingSession } from "./lib/anthropic-billing.ts";
import { assertBillingReady } from "./lib/billing-quota.ts";
import {
  BILLING_SIDE_HEADER,
  BILLING_TOKEN_HEADER,
  routeBillingRegistry,
} from "./lib/billing-registry.ts";
import {
  endReply,
  endRun,
  endTurn,
  newSession,
  startPrompt,
  startQueuedPrompt,
  startTurn,
} from "./lib/billing-session.ts";
import { readClaudeIdentity, type ClaudeIdentity } from "./lib/claude-identity.ts";
import { registerFetchWrapper, requestHeaders, type FetchInput } from "./lib/fetch.ts";
import { awaitAbort } from "./lib/promise.ts";

type BillingHandler = (upstream: FetchFunction, side: boolean) => FetchFunction;

interface Shared {
  handlers: Map<string, BillingHandler>;
  sessions: Map<string, BillingSession>;
}

declare global {
  var anthropicBillingState: Shared | undefined;
}

async function locateCli(pi: ExtensionAPI): Promise<{ path: string; version: string }> {
  const [versionResult, pathResult] = await Promise.all([
    pi.exec("claude", ["--version"], { timeout: 5000 }),
    pi.exec("which", ["claude"], { timeout: 5000 }),
  ]);

  const version = /^(\d+\.\d+\.\d+)\b/m.exec(versionResult.stdout)?.[1];
  const path = pathResult.stdout.trim();

  if (versionResult.code !== 0 || pathResult.code !== 0 || version === undefined || path === "") {
    throw new Error("Pi can't find the installed Claude CLI. Request blocked.");
  }

  return { path, version };
}

function untag(input: FetchInput, init: RequestInit | undefined) {
  const headers = requestHeaders(input, init);

  const token = headers.get(BILLING_TOKEN_HEADER);
  const side = headers.has(BILLING_SIDE_HEADER);

  if (token === null && !side) {
    return { token, side, init };
  }

  headers.delete(BILLING_TOKEN_HEADER);
  headers.delete(BILLING_SIDE_HEADER);

  return { token, side, init: { ...init, headers } };
}

function createRouter(shared: Shared, upstream: FetchFunction): FetchFunction {
  const wrapped = (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const routed = untag(input, init);

    const handler = routed.token === null ? undefined : shared.handlers.get(routed.token);

    const send =
      handler === undefined
        ? billingFetch(
            upstream,
            new Error("Anthropic billing session is unavailable. Request blocked."),
          )
        : handler(upstream, routed.side);

    return send(input, routed.init);
  };

  return Object.assign(wrapped, upstream);
}

export default function (pi: ExtensionAPI) {
  const shared: Shared = (globalThis.anthropicBillingState ??= {
    handlers: new Map(),
    sessions: new Map(),
  });

  const token = crypto.randomUUID();

  registerFetchWrapper("anthropic-billing", (upstream) => createRouter(shared, upstream));

  let cli: Promise<{ path: string; version: string }> | undefined;
  let session = newSession("");

  const identity = async (
    model: string,
    signal?: AbortSignal,
    owner = session,
  ): Promise<ClaudeIdentity> => {
    cli ??= locateCli(pi).catch((cause: unknown) => {
      cli = undefined;
      throw cause;
    });
    const { path, version } = await awaitAbort(cli, signal);

    return readClaudeIdentity(path, version, model, signal, (subscriptionType) =>
      assertBillingReady(subscriptionType, owner.quotaError),
    );
  };

  const discover = async (ctx: ExtensionContext) => {
    if (ctx.model?.provider !== "anthropic" || !ctx.modelRegistry.isUsingOAuth(ctx.model)) {
      return;
    }

    try {
      await identity(ctx.model.id);
    } catch (cause) {
      ctx.ui.notify(
        cause instanceof Error
          ? cause.message
          : "Claude CLI profile discovery failed. Request blocked.",
        "error",
      );
    }
  };

  // Startup and model switches don't wait for discovery. Requests wait for the same cached lookup.
  const prefetch = (ctx: ExtensionContext): void => {
    void discover(ctx).catch(() => {
      // The session ended before the error notice could show.
    });
  };

  function setSession(ctx: ExtensionContext): void {
    const id = ctx.sessionManager.getSessionId();

    if (session.sessionId !== id) {
      session = shared.sessions.get(id) ?? newSession(id);
      shared.sessions.set(id, session);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    setSession(ctx);
    shared.handlers.set(token, (upstream, side) => {
      const owner = session;

      return billingFetch(upstream, (model, signal) => identity(model, signal, owner), owner, side);
    });
    routeBillingRegistry(ctx.modelRegistry, token);
    prefetch(ctx);
  });

  pi.on("model_select", async (_event, ctx) => prefetch(ctx));

  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user") {
      return;
    }

    setSession(ctx);
    startPrompt(session);
  });

  // The CLI's per-request fields follow its agent loop. It sends one request per turn and runs tools
  // between turns.
  pi.on("turn_start", async (_event, ctx) => {
    setSession(ctx);
    startTurn(session);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "user") {
      setSession(ctx);
      startQueuedPrompt(session);
    }

    if (event.message.role === "assistant") {
      setSession(ctx);
      endReply(session, event.message);
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    setSession(ctx);
    endTurn(session, event.toolResults);
  });

  pi.on("agent_end", async (_event, ctx) => {
    setSession(ctx);
    endRun(session);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    setSession(ctx);
    session.compacting = true;
  });

  pi.on("session_compact", async (_event, ctx) => {
    setSession(ctx);
    session.compacting = false;
  });

  pi.on("session_compact_failed", async (_event, ctx) => {
    setSession(ctx);
    session.compacting = false;
  });

  pi.on("before_provider_headers", async (event, ctx) => {
    if (ctx.model?.provider === "anthropic") {
      setSession(ctx);
      event.headers[BILLING_TOKEN_HEADER] = token;
    }
  });

  pi.on("session_shutdown", async () => {
    shared.handlers.delete(token);
  });
}

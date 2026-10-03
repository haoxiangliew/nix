import type { FetchFunction } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { billingFetch, type BillingSession } from "./lib/anthropic-billing.ts";
import { assertBillingReady } from "./lib/billing-quota.ts";
import { BILLING_SESSION_HEADER } from "./lib/billing-session.ts";
import { readClaudeIdentity, type ClaudeIdentity } from "./lib/claude-identity.ts";
import { registerFetchWrapper, type FetchWrapper } from "./lib/fetch.ts";
import { awaitAbort } from "./lib/promise.ts";

const TAG = "x-pi-anthropic-billing";

type FetchInput = Parameters<FetchFunction>[0];

interface Handler {
  sessionId: () => string;
  wrap: FetchWrapper;
}

interface Shared {
  handlers: Map<string, Handler>;
  sessions: Map<string, BillingSession>;
}

declare global {
  var anthropicBilling: Shared | undefined;
}

async function locateCli(pi: ExtensionAPI): Promise<{ path: string; version: string }> {
  const [versionResult, pathResult] = await Promise.all([
    pi.exec("claude", ["--version"], { timeout: 5000 }),
    pi.exec("which", ["claude"], { timeout: 5000 }),
  ]);

  const version = /^(\d+\.\d+\.\d+)\b/m.exec(versionResult.stdout)?.[1];
  const path = pathResult.stdout.trim();

  if (versionResult.code !== 0 || pathResult.code !== 0 || version === undefined || path === "") {
    throw new Error(
      "Could not locate the installed Claude CLI. Anthropic OAuth requests are blocked.",
    );
  }

  return { path, version };
}

function untag(input: FetchInput, init: RequestInit | undefined) {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );

  const token = headers.get(TAG);
  const sessionId = headers.get(BILLING_SESSION_HEADER);

  if (token === null && sessionId === null) {
    return { token, sessionId, init };
  }

  headers.delete(TAG);
  headers.delete(BILLING_SESSION_HEADER);

  return { token, sessionId, init: { ...init, headers } };
}

function selectedHandler(
  shared: Shared,
  token: string | null,
  sessionId: string | null,
): FetchWrapper | undefined {
  if (token !== null) {
    return shared.handlers.get(token)?.wrap;
  }

  const matches = Array.from(shared.handlers.values()).filter(
    (handler) => sessionId === null || handler.sessionId() === sessionId,
  );

  return matches.length === 1 ? matches[0]?.wrap : undefined;
}

function createRouter(shared: Shared, upstream: FetchFunction): FetchFunction {
  const wrapped = (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const routed = untag(input, init);

    const handler = selectedHandler(shared, routed.token, routed.sessionId);

    const send =
      handler === undefined
        ? billingFetch(
            upstream,
            new Error("Anthropic billing session is unavailable or ambiguous. Request blocked."),
          )
        : handler(upstream);

    return send(input, routed.init);
  };

  return Object.assign(wrapped, upstream);
}

function newSession(sessionId: string): BillingSession {
  return { sessionId, promptId: crypto.randomUUID(), promptIndex: -1, turnIndex: 0 };
}

export default function (pi: ExtensionAPI) {
  const shared: Shared = (globalThis.anthropicBilling ??= {
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
      await identity(ctx.model.id, ctx.signal);
    } catch (cause) {
      ctx.ui.notify(
        cause instanceof Error
          ? cause.message
          : "Claude CLI profile discovery failed. Request blocked.",
        "error",
      );
    }
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
    shared.handlers.set(token, {
      sessionId: () => session.sessionId,
      wrap: (upstream) => {
        const owner = session;

        return billingFetch(upstream, (model, signal) => identity(model, signal, owner), owner);
      },
    });
    await discover(ctx);
  });

  pi.on("model_select", async (_event, ctx) => discover(ctx));

  pi.on("before_agent_start", async (_event, ctx) => {
    setSession(ctx);
    session.promptId = crypto.randomUUID();
    session.promptIndex++;
  });

  pi.on("before_provider_headers", async (event, ctx) => {
    if (ctx.model?.provider === "anthropic") {
      setSession(ctx);
      event.headers[TAG] = token;
    }
  });

  pi.on("session_shutdown", async () => {
    shared.handlers.delete(token);
  });
}

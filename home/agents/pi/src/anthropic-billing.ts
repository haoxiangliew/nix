import type { FetchFunction } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { billingFetch, type BillingSession } from "./lib/anthropic-billing.ts";
import { assertBillingReady } from "./lib/billing-quota.ts";
import { BILLING_TOKEN_HEADER, routeBillingRegistry } from "./lib/billing-registry.ts";
import { readClaudeIdentity, type ClaudeIdentity } from "./lib/claude-identity.ts";
import {
  registerFetchWrapper,
  requestHeaders,
  type FetchInput,
  type FetchWrapper,
} from "./lib/fetch.ts";
import { awaitAbort } from "./lib/promise.ts";

interface Shared {
  handlers: Map<string, FetchWrapper>;
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
    throw new Error("Pi can't find the installed Claude CLI. Request blocked.");
  }

  return { path, version };
}

function untag(input: FetchInput, init: RequestInit | undefined) {
  const headers = requestHeaders(input, init);

  const token = headers.get(BILLING_TOKEN_HEADER);

  if (token === null) {
    return { token, init };
  }

  headers.delete(BILLING_TOKEN_HEADER);

  return { token, init: { ...init, headers } };
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
    shared.handlers.set(token, (upstream) => {
      const owner = session;

      return billingFetch(upstream, (model, signal) => identity(model, signal, owner), owner);
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
    session.promptId = crypto.randomUUID();
    session.promptIndex++;
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

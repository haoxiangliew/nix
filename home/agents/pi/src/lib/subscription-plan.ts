/**
 * Looks up the subscription plan of an OAuth login, such as `pro 200` or `ultra`. The OpenAI plan
 * is a claim in the access token. The Anthropic plan comes from `claude auth status`, so it is the
 * plan of the Claude CLI's login.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { readClaudeAuthStatus } from "./claude-auth.ts";
import { chatgptClaim } from "./openai-token.ts";
import { errorMessage } from "./settings.ts";

// Other plans, such as `plus` and `business`, show as they are.
const CHATGPT_PLANS = new Map([
  ["prolite", "pro 100"],
  ["pro", "pro 200"],
  ["promax", "pro 500"],
  ["team", "business"],
  ["ent26", "enterprise"],
]);

function chatgptPlanLabel(plan: string): string {
  const known = CHATGPT_PLANS.get(plan);

  if (known !== undefined) {
    return known;
  }

  if (plan.startsWith("self_serve_business_")) {
    return "business";
  }

  return plan.startsWith("enterprise_cbp_") ? "enterprise" : plan;
}

const ChatgptPlan = Type.Object({ chatgpt_plan_type: Type.String({ minLength: 1 }) });

// `claude auth status` gives Max plans a tier of `max_5x`, `max_20x`, or `max_other`.
const MaxTier = Type.Object({ planTier: Type.String() });

// Max 20x became Ultra but kept its tier name. `max_other` stays `max`.
const CLAUDE_MAX_TIERS = new Map([
  ["max_5x", "max"],
  ["max_20x", "ultra"],
]);

async function readChatgptPlan(ctx: ExtensionContext): Promise<string> {
  // Unlike getApiKeyForProvider, this throws when the token refresh fails.
  const token = (await ctx.modelRegistry.getProviderAuth("openai-codex"))?.auth.apiKey;

  if (token === undefined) {
    throw new Error("openai-codex has no login");
  }

  return chatgptPlanLabel(chatgptClaim(token, ChatgptPlan, "ChatGPT plan").chatgpt_plan_type);
}

async function readClaudePlan(): Promise<string | undefined> {
  const status = await readClaudeAuthStatus("claude");
  const { loggedIn, authMethod, subscriptionType } = status;

  if (!loggedIn) {
    return undefined;
  }

  if (!authMethod) {
    throw new Error("claude auth status names no login method");
  }

  if (authMethod !== "claude.ai") {
    return undefined;
  }

  if (!subscriptionType) {
    throw new Error("claude auth status names no plan for the claude.ai login");
  }

  if (subscriptionType !== "max") {
    return subscriptionType;
  }

  if (!Value.Check(MaxTier, status)) {
    throw new Error("claude auth status names no tier for the Max plan");
  }

  return CLAUDE_MAX_TIERS.get(status.planTier) ?? "max";
}

type PlanReader = (ctx: ExtensionContext) => Promise<string | undefined>;

const readers = new Map<string, PlanReader>([
  ["openai-codex", readChatgptPlan],
  ["anthropic", readClaudePlan],
]);

export interface PlanTracker {
  /** Call when the session ends. Lookups that finish later don't warn or redraw. */
  dispose(): void;
  /** Looks up the current model's plan again, unless a lookup is running. */
  load(ctx: ExtensionContext): void;
  /** The plan's label, or undefined while unknown. */
  label(provider: string): string | undefined;
}

/**
 * Looks plans up in the background and calls `onChange` when a lookup ends. A failed lookup shows a
 * warning.
 */
export function trackPlans(onChange: () => void): PlanTracker {
  const labels = new Map<string, string>();
  const loading = new Set<string>();
  // A session's `ctx` throws after the session ends.
  let disposed = false;

  const load = (ctx: ExtensionContext) => {
    const provider = ctx.model?.provider;
    const reader = provider === undefined ? undefined : readers.get(provider);

    if (provider === undefined || reader === undefined) {
      return;
    }

    if (loading.has(provider)) {
      return;
    }

    loading.add(provider);
    void lookup(ctx, provider, reader);
  };

  const lookup = async (ctx: ExtensionContext, provider: string, reader: PlanReader) => {
    let label: string | undefined;
    let failure: string | undefined;

    try {
      label = await reader(ctx);
    } catch (error) {
      failure = errorMessage(error);
    }

    loading.delete(provider);

    if (label === undefined) {
      labels.delete(provider);
    } else {
      labels.set(provider, label);
    }

    if (disposed) {
      return;
    }

    if (failure !== undefined) {
      ctx.ui.notify(`Couldn't read the ${provider} plan. ${failure}`, "warning");
    }

    onChange();
  };

  return {
    dispose() {
      disposed = true;
    },
    load,
    label: (provider) => labels.get(provider),
  };
}

/**
 * Prices a speed change in a large session whose prompt cache is warm. Anthropic and OpenAI cache
 * a prompt for one speed, so the first request at a new speed pays for the whole context again, at
 * the new speed's price. Compacting at the old speed first reads the cache, and leaves only the
 * compacted session to pay for. fast.ts offers that choice.
 *
 * A session counts as large at `summaryFork.idle.minTokens`, as it does for idle compaction. The
 * prices are estimates. They come from pi's catalog and an estimate of the compacted session.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { calculateCost, getPromptCacheTtlMs } from "@earendil-works/pi-ai";

import { cacheAge, lastReplyEntry } from "./cache-refresh.ts";
import { loadSettings, piSettings } from "./settings.ts";
import { messageTokens, SUMMARY_FORK_KEY, SummaryFork } from "./summary-fork.ts";

// Anthropic bills a cache write that lasts this long at twice the input price.
const LONG_CACHE_MS = 60 * 60_000;

// A compaction summary takes about this many tokens. The median in past sessions was near 4,000.
const SUMMARY_TOKENS = 4000;

export interface SpeedSwitch {
  // The context the session holds now.
  tokens: number;
  // Dollars for the first request at the new speed if the session switches as it is.
  rewrite: number;
  // Dollars to compact at the old speed, plus the first request at the new speed.
  compacted: number;
}

function price(model: Model<Api>, part: Partial<Usage>): number {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...part,
  };

  return calculateCost(model, usage).total;
}

// What a request pays for context the cache doesn't hold. A provider that doesn't bill cache
// writes bills that context as input.
function uncached(model: Model<Api>, tokens: number): number {
  if (model.cost.cacheWrite === 0) {
    return price(model, { input: tokens });
  }

  const long = (getPromptCacheTtlMs(model, undefined) ?? 0) >= LONG_CACHE_MS;

  return price(model, { cacheWrite: tokens, cacheWrite1h: long ? tokens : 0 });
}

// The tokens of the session's cache if it is warm and belongs to this model. A cache with no known
// lifetime doesn't count as warm.
function warmTokens(ctx: ExtensionContext, model: Model<Api>): number | undefined {
  const branch = ctx.sessionManager.getBranch();
  const reply = lastReplyEntry(branch);
  const ttlMs = getPromptCacheTtlMs(model, undefined);

  if (!reply || ttlMs === undefined) {
    return undefined;
  }

  const { provider, model: id } = reply.message;
  const age = cacheAge(branch, Date.now() - Date.parse(reply.timestamp));

  if (provider !== model.provider || id !== model.id || age > ttlMs) {
    return undefined;
  }

  return ctx.getContextUsage()?.tokens ?? undefined;
}

// Compaction keeps the system prompt, the tools, the most recent messages, and the summary. Pi's
// projection has no system prompt or tools, so their size is the context minus its messages.
function compactedTokens(ctx: ExtensionContext, model: Model<Api>, tokens: number): number {
  const conversation = messageTokens(ctx.sessionManager.buildSessionProjection().messages);
  const { keepRecentTokens } = piSettings(ctx).getCompactionSettings(model);

  return Math.min(tokens, Math.max(0, tokens - conversation) + keepRecentTokens + SUMMARY_TOKENS);
}

export interface Speeds {
  // The multiples of the standard rate that the old and new speeds cost.
  from: number;
  to: number;
  // Whether the summary fork can repeat the session's last request. If it can't, as after a
  // restart, it reads the session uncached at the standard rate.
  replays: boolean;
}

// Returns undefined if the change needs no decision, because the session is running, small, or has
// no warm cache for this model. A session that is running switches at once, because it can't
// compact mid-turn.
export function speedSwitch(
  ctx: ExtensionContext,
  model: Model<Api>,
  { from, to, replays }: Speeds,
): SpeedSwitch | undefined {
  const { minTokens } = loadSettings(SUMMARY_FORK_KEY, SummaryFork).idle;
  const tokens = ctx.isIdle() ? warmTokens(ctx, model) : undefined;

  if (tokens === undefined || tokens < minTokens) {
    return undefined;
  }

  const summary = replays
    ? from * price(model, { cacheRead: tokens, output: SUMMARY_TOKENS })
    : price(model, { input: tokens, output: SUMMARY_TOKENS });

  return {
    tokens,
    rewrite: to * uncached(model, tokens),
    compacted: summary + to * uncached(model, compactedTokens(ctx, model, tokens)),
  };
}

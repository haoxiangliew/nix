/**
 * The session entry compaction.ts adds for each idle prompt-cache refresh. Extensions can't add
 * pi's usage entries, so statusline.ts counts these toward the session's cost. This file also tells
 * how old a session's prompt cache is, from its replies and refreshes.
 */

import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { getPromptCacheTtlMs } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const CACHE_REFRESH = "cache-refresh";

export interface CacheRefresh {
  model: string;
  usage: Usage;
}

const Costed = Type.Object({
  usage: Type.Object({ cost: Type.Object({ total: Type.Number() }) }),
});

type MessageEntry = Extract<SessionEntry, { type: "message" }>;

type Reply = MessageEntry & { message: Extract<MessageEntry["message"], { role: "assistant" }> };

export function lastReplyEntry(entries: SessionEntry[]): Reply | undefined {
  return entries.findLast(
    (candidate): candidate is Reply =>
      candidate.type === "message" && candidate.message.role === "assistant",
  );
}

// When the session's last reply was saved. The session file has this after a restart.
export function lastReply(entries: SessionEntry[]): number | undefined {
  const entry = lastReplyEntry(entries);

  return entry && Date.parse(entry.timestamp);
}

function lastRefresh(entries: SessionEntry[]): number | undefined {
  const entry = entries.findLast(
    (candidate) => candidate.type === "custom" && candidate.customType === CACHE_REFRESH,
  );

  return entry && Date.parse(entry.timestamp);
}

// How long ago a request last used the session's cache. Idle refreshes use it too.
export function cacheAge(entries: SessionEntry[], idleMs: number): number {
  const refreshed = lastRefresh(entries);

  return refreshed === undefined ? idleMs : Math.min(idleMs, Date.now() - refreshed);
}

export function cacheExpired(model: Model<Api>, age: number): boolean {
  const ttlMs = getPromptCacheTtlMs(model, undefined);

  return ttlMs !== undefined && age > ttlMs;
}

export function cacheRefreshCost(entry: Extract<SessionEntry, { type: "custom" }>): number {
  return entry.customType === CACHE_REFRESH && Value.Check(Costed, entry.data)
    ? entry.data.usage.cost.total
    : 0;
}

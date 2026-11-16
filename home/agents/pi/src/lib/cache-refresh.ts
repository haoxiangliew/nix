/**
 * The session entry compaction.ts adds for each idle prompt-cache refresh. Extensions can't add
 * pi's usage entries, so statusline.ts counts these toward the session's cost.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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

export function cacheRefreshCost(entry: Extract<SessionEntry, { type: "custom" }>): number {
  return entry.customType === CACHE_REFRESH && Value.Check(Costed, entry.data)
    ? entry.data.usage.cost.total
    : 0;
}

/**
 * The parts of compaction.ts that fast.ts uses. Its settings are under the `summaryFork` key of
 * settings.json. fast.ts reads `idle.minTokens`, so a speed change and an idle session count as
 * large at the same size. fast.ts also asks whether the summary fork can repeat the session's last
 * request.
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

type AgentMessage = Parameters<typeof estimateTokens>[0];

// Pi uses the `compaction` key.
export const SUMMARY_FORK_KEY = "summaryFork";

// compaction.ts answers on this pi.events channel during emit, with the request it recorded. It
// doesn't answer if it has none, as after a restart.
export const RECORDED_REQUEST = "summary-fork:recorded-request";

export const RecordedQuery = Type.Object({ done: Type.Function([Type.Unknown()], Type.Void()) });

export interface Recorded {
  model: string;
  leafId: string | null;
}

const Idle = Type.Object(
  {
    // The extensions ignore a session with less context than this.
    minTokens: Type.Integer({ minimum: 0, default: 150_000 }),
    // Refresh the prompt cache until the session has been idle this long. 0 never refreshes it.
    warmMinutes: Type.Number({ minimum: 0, default: 240 }),
    // Compact the session when the refreshes stop.
    compact: Type.Boolean({ default: true }),
  },
  { additionalProperties: false, default: {} },
);

export type Idle = Static<typeof Idle>;

export const SummaryFork = Type.Object(
  {
    // Compact at this share of the model's context window. The fork gets the rest.
    compactAt: Type.Number({ minimum: 0.5, maximum: 0.95, default: 0.9 }),
    idle: Idle,
  },
  { additionalProperties: false, default: {} },
);

export type SummaryFork = Static<typeof SummaryFork>;

export function messageTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

// The entries after leafId. A missing leaf or a later summary invalidates the recorded context.
export function entriesSince(
  entries: SessionEntry[],
  leafId: string | null,
): SessionEntry[] | undefined {
  const start = leafId === null ? 0 : entries.findIndex((entry) => entry.id === leafId) + 1;

  if (start === 0 && leafId !== null) {
    return undefined;
  }

  const since = entries.slice(start);

  return since.some((entry) => entry.type === "compaction" || entry.type === "branch_summary")
    ? undefined
    : since;
}

// Whether the summary fork can repeat the last request of this model's session, which reads the
// prompt cache at the speed that request used.
export function forkReplays(pi: ExtensionAPI, entries: SessionEntry[], model: string): boolean {
  const answers: Recorded[] = [];

  pi.events.emit(RECORDED_REQUEST, {
    done: (answer: Recorded) => {
      answers.push(answer);
    },
  });

  const [recorded] = answers;

  return (
    recorded !== undefined &&
    recorded.model === model &&
    entriesSince(entries, recorded.leafId) !== undefined
  );
}

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import { toolsUsedName, type ToolRun } from "./billing-fields.ts";

export interface BillingReply {
  readonly messageId: string;
  /** request-id of the response that carried the reply. */
  readonly requestId?: string;
  readonly endedAt: number;
  readonly toolUse: boolean;
}

/**
 * Body fields that differ between a full request and a thread continue. A continue repeats them
 * from the request that created the message thread.
 */
export interface ThreadState {
  readonly ccVersion: string;
  /** System blocks after the billing block, as sent. */
  readonly system: readonly unknown[];
  readonly tools?: unknown;
}

export interface BillingSession {
  sessionId: string;
  promptId: string;
  promptIndex: number;
  quotaError?: Error;
  /** The agent loop is waiting for a model reply, so its requests are main-loop requests. */
  awaitingReply: boolean;
  compacting: boolean;
  /** request-id of the last main-loop response, until its reply ends. */
  responseRequestId?: string;
  reply?: BillingReply;
  /** Tool names in first-use order, as requests send them. */
  toolsUsed: string[];
  /** Tool names of the last main-loop request that listed tools. */
  wireTools: readonly string[];
  /** Tools whose results this turn's request sends. */
  toolRuns: readonly ToolRun[];
  /** Tools the last turn ran, for the next turn. */
  finishedTools: readonly ToolRun[];
  /** The main loop's message thread. Side calls don't change it. */
  thread?: ThreadState;
  /** The API refused a continue without the full system prompt and tools. */
  fullThreadFields: boolean;
  /** The last turn's reply called no tools, so the agent loop would have stopped. */
  loopWouldStop: boolean;
}

// pi-ai sends Claude Code's casing for its built-in tools under OAuth.
function wireToolName(session: BillingSession, name: string): string {
  const tools = session.wireTools;

  return (
    tools.find((tool) => tool === name) ??
    tools.find((tool) => tool.toLowerCase() === name.toLowerCase()) ??
    name
  );
}

export function newSession(sessionId: string): BillingSession {
  return {
    sessionId,
    promptId: crypto.randomUUID(),
    promptIndex: -1,
    awaitingReply: false,
    compacting: false,
    toolsUsed: [],
    wireTools: [],
    toolRuns: [],
    finishedTools: [],
    fullThreadFields: false,
    loopWouldStop: false,
  };
}

export function recordToolsUsed(session: BillingSession, names: readonly string[]): void {
  const used = session.toolsUsed;

  for (const name of names) {
    const recorded = toolsUsedName(name);

    if (!used.includes(recorded)) {
      used.push(recorded);
    }
  }
}

export function startPrompt(session: BillingSession): void {
  session.promptId = crypto.randomUUID();
  session.promptIndex++;
  session.loopWouldStop = false;
}

// Like the CLI, a user message after a reply without tools starts a new prompt. One that arrives
// while tools run joins the current prompt.
export function startQueuedPrompt(session: BillingSession): void {
  if (session.loopWouldStop) {
    startPrompt(session);
  }
}

export function startTurn(session: BillingSession): void {
  session.awaitingReply = true;
  session.toolRuns = session.finishedTools;
  session.finishedTools = [];
}

export function endReply(session: BillingSession, message: AssistantMessage): void {
  const requestId = session.responseRequestId;
  session.awaitingReply = false;
  session.responseRequestId = undefined;

  if (
    message.provider !== "anthropic" ||
    message.responseId === undefined ||
    message.stopReason === "error"
  ) {
    return;
  }

  const calls = message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []));

  session.reply = {
    messageId: message.responseId,
    requestId,
    endedAt: Date.now(),
    toolUse: calls.length > 0,
  };

  recordToolsUsed(
    session,
    calls.map((name) => wireToolName(session, name)),
  );
}

export function endTurn(session: BillingSession, results: readonly ToolResultMessage[]): void {
  session.awaitingReply = false;
  session.loopWouldStop = results.length === 0;
  session.toolRuns = [];
  session.finishedTools = results.flatMap(({ toolName, durationMs }) =>
    durationMs === undefined ? [] : [{ name: wireToolName(session, toolName), durationMs }],
  );
}

export function endRun(session: BillingSession): void {
  session.awaitingReply = false;
  session.loopWouldStop = false;
  session.toolRuns = [];
  session.finishedTools = [];
}

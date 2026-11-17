/**
 * Writes compaction and branch summaries from a fork of the session, so the summary sees full tool
 * results. The fork repeats the last recorded request with the summary request added, so it reads
 * the prompt cache and keeps the settings other extensions add, such as /fast's. A request that
 * isn't JSON, such as Google's, is sent as pi builds it. After a restart there's no recorded
 * request, so the fork rebuilds the context and writes no cache. Pi compacts at a fixed reserve per
 * model, so this also compacts at the end of a turn once context reaches `compactAt` of the window.
 * A fork over `compactAt` drops its oldest turns. If a fork for pi's compaction or a branch summary
 * fails, pi's summarizer runs. If an end-of-turn fork fails, compaction waits for pi's threshold.
 *
 * Pi's idle cache warming stops after 30 minutes, which is before the first refresh of a one-hour
 * cache. So this also repeats the last request of a large idle session with a one-token reply to
 * renew its cache, then compacts the session once it has been idle long enough, while the cache is
 * still warm.
 *
 * None of that runs while the machine sleeps or pi is closed. So the first prompt to a large session
 * compacts it first, if the session was idle for `idle.warmMinutes` and its cache expired. The
 * compaction's fork reads the session uncached and writes no cache for the conversation. That costs
 * less than writing the whole context again.
 *
 * The `summaryFork` key in settings.json configures this extension.
 */

import type { Api, AssistantMessage, Model, Usage, UserMessage } from "@earendil-works/pi-ai";
import type {
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionContext,
  FileOperations,
  InputEvent,
  SessionBeforeCompactEvent,
  SessionBeforeTreeEvent,
  SessionEntry,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import {
  CACHE_WARMING_MAX_IDLE_AGE_MS,
  contentText,
  getCacheWarmingDelayMs,
  getPromptCacheTtlMs,
  hasApi,
  isCacheWarmingReplayable,
  retryAssistantCall,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  estimateTokens,
  findCutPoint,
  generateBranchSummary,
  getLatestCompactionEntry,
  prepareBranchEntries,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { CACHE_REFRESH, type CacheRefresh } from "./lib/cache-refresh.ts";
import { errorMessage, loadOrReport, piSettings } from "./lib/settings.ts";

type AgentMessage = ContextWithSystemEvent["messages"][number];

const NAME = "compaction";

// Pi uses the `compaction` key.
const KEY = "summaryFork";

const HEAD_ROLES = new Set<string>(["system", "compactionSummary", "branchSummary"]);

const Idle = Type.Object(
  {
    // The extension ignores an idle session with less context than this.
    minTokens: Type.Integer({ minimum: 0, default: 150_000 }),
    // Refresh the prompt cache until the session has been idle this long. 0 never refreshes it.
    warmMinutes: Type.Number({ minimum: 0, default: 240 }),
    // Compact the session when the refreshes stop.
    compact: Type.Boolean({ default: true }),
  },
  { additionalProperties: false, default: {} },
);

type Idle = Static<typeof Idle>;

const Config = Type.Object(
  {
    // Compact at this share of the model's context window. The fork gets the rest.
    compactAt: Type.Number({ minimum: 0.5, maximum: 0.95, default: 0.9 }),
    idle: Idle,
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

// A request body as pi-ai builds it. Google's carries an abort signal, so it isn't JSON.
type Json = string | number | boolean | null | undefined | Json[] | Fields;

interface Fields {
  [key: string]: Json;
}

const Primitive = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  Type.Undefined(),
]);

const Dictionary = Type.Record(Type.String(), Type.Unknown());

const FileLists = Type.Object({
  readFiles: Type.Array(Type.String()),
  modifiedFiles: Type.Array(Type.String()),
});

type FileLists = Static<typeof FileLists>;

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface Request {
  model: string;
  leafId: string | null;
  messages: AgentMessage[];
  thinkingLevel: ThinkingLevel;
  payload?: Fields;
  sentAt?: number;
}

// A request pi sent, so the provider has cached it.
type Sent = Request & { payload: Fields; sentAt: number };

// A replayed fork uses the recorded request's thinking level, so its thinking settings match the
// recorded ones.
interface ForkInput {
  messages: AgentMessage[];
  thinkingLevel: ThinkingLevel;
  payload?: Fields;
}

interface Sending {
  messages: AgentMessage[];
  thinkingLevel: ThinkingLevel;
  maxTokens?: number;
  // A retry can arrive after the cache expires, so a refresh doesn't retry.
  retry: boolean;
  // Returns the body to send in place of the one pi-ai built, or undefined to keep that one.
  rewrite: (built: Fields) => Fields | undefined;
}

// An idle session whose cache this extension refreshes.
interface IdleRun {
  readonly idleSince: number;
  readonly ttlMs: number;
  readonly delayMs: number;
  readonly controller: AbortController;
  // When a request last read the cache, which restarts its lifetime.
  touchedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

type Forked = { text: string; usage: Usage } | { failure: string };

// Pi does not export these prompts. Keep the copies unchanged.
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

// The fork keeps the session's tools, unlike pi's summarizer.
const NO_TOOLS = "Do not call any tools. Reply with only the summary.";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function isJson(value: unknown): value is Json {
  if (Value.Check(Primitive, value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJson);
  }

  return (
    Value.Check(Dictionary, value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(isJson)
  );
}

function isFields(value: Json): value is Fields {
  return !Value.Check(Primitive, value) && !Array.isArray(value);
}

function itemsOf(body: Fields, key: string): Json[] {
  const items = body[key];

  return Array.isArray(items) ? items : [];
}

// The conversation is the top-level array whose items have roles. Tools and system blocks have
// none.
function conversationKey(body: Fields): string | undefined {
  return Object.keys(body).find((key) =>
    itemsOf(body, key).some((item) => isFields(item) && Value.Check(Type.String(), item.role)),
  );
}

// Anthropic and some OpenAI-compatible APIs mark cache breakpoints with cache_control.
function stripCacheControl(item: Json): Json {
  const content = isFields(item) ? item.content : undefined;

  if (!isFields(item) || !Array.isArray(content)) {
    return item;
  }

  return {
    ...item,
    content: content.map((block) => {
      if (!isFields(block)) {
        return block;
      }

      const { cache_control: _breakpoint, ...rest } = block;

      return rest;
    }),
  };
}

function sameItems(a: Json[], b: Json[]): boolean {
  return JSON.stringify(a.map(stripCacheControl)) === JSON.stringify(b.map(stripCacheControl));
}

// Managed-effort models end each payload with a system message that sets the effort.
function conversationLength(items: Json[]): number {
  let length = items.length;
  let last = items[length - 1];

  while (length > 0 && isFields(last) && last.role === "system") {
    length--;
    last = items[length - 1];
  }

  return length;
}

// The recorded value, except that a number takes the smaller of the two. pi-ai fits output limits
// and thinking budgets to the room left in the window, and the fork has more input, so its own are
// no larger. A number an extension lowered keeps its value.
function merge(recorded: Json, built: Json): Json {
  if (recorded === undefined) {
    return built;
  }

  if (Value.Check(Type.Number(), recorded) && Value.Check(Type.Number(), built)) {
    return Math.min(recorded, built);
  }

  return isFields(recorded) && isFields(built) ? mergeFields(recorded, built) : recorded;
}

function mergeFields(recorded: Fields, built: Fields): Fields {
  const keys = new Set([...Object.keys(recorded), ...Object.keys(built)]);

  return Object.fromEntries([...keys].map((key) => [key, merge(recorded[key], built[key])]));
}

// If the built conversation starts with the recorded one, reuses the recorded prefix and request
// settings.
function replayPayload(recorded: Fields, built: Fields, key: string): Fields | undefined {
  const recordedItems = itemsOf(recorded, key);
  const builtItems = itemsOf(built, key);
  const length = conversationLength(recordedItems);
  const prefix = recordedItems.slice(0, length);

  if (length === 0 || !sameItems(builtItems.slice(0, length), prefix)) {
    return undefined;
  }

  const rest = builtItems.slice(length).map(stripCacheControl);

  return { ...mergeFields(recorded, built), [key]: [...prefix, ...rest] };
}

// Without the recorded prefix, or once the cache has expired, nothing reads this conversation's
// cache, so this drops the message breakpoints. It keeps the system and tool breakpoints because
// the session shares them. A body with no conversation is sent as pi-ai built it.
function forkPayload(
  recorded: Fields | undefined,
  built: Fields,
  expired: boolean,
): Fields | undefined {
  const key = conversationKey(built);

  if (key === undefined) {
    return undefined;
  }

  const replayed = recorded && replayPayload(recorded, built, key);

  if (replayed && !expired) {
    return replayed;
  }

  const body = replayed ?? built;

  return { ...body, [key]: itemsOf(body, key).map(stripCacheControl) };
}

// When the session's last reply was saved. The session file has this after a restart.
function lastReply(entries: SessionEntry[]): number | undefined {
  const entry = entries.findLast(
    (candidate) => candidate.type === "message" && candidate.message.role === "assistant",
  );

  return entry && Date.parse(entry.timestamp);
}

function lastRefresh(entries: SessionEntry[]): number | undefined {
  const entry = entries.findLast(
    (candidate) => candidate.type === "custom" && candidate.customType === CACHE_REFRESH,
  );

  return entry && Date.parse(entry.timestamp);
}

// How long ago a request last used the session's cache. Idle refreshes use it too.
function cacheAge(ctx: ExtensionContext, idleMs: number): number {
  const refreshed = lastRefresh(ctx.sessionManager.getBranch());

  return refreshed === undefined ? idleMs : Math.min(idleMs, Date.now() - refreshed);
}

function cacheExpired(model: Model<Api>, age: number): boolean {
  const ttlMs = getPromptCacheTtlMs(model, undefined);

  return ttlMs !== undefined && age > ttlMs;
}

// A missing leaf or a later summary invalidates the recorded context.
function messagesSince(entries: SessionEntry[], leafId: string | null): AgentMessage[] | undefined {
  const start = leafId === null ? 0 : entries.findIndex((entry) => entry.id === leafId) + 1;

  if (start === 0 && leafId !== null) {
    return undefined;
  }

  const since = entries.slice(start);

  if (since.some((entry) => entry.type === "compaction" || entry.type === "branch_summary")) {
    return undefined;
  }

  return since.flatMap((entry) => sessionEntryToContextMessages(entry));
}

// Anthropic binds a thinking block to the conversation before it. Compaction replaces that
// conversation with a summary, so Anthropic drops the blocks in the messages compaction kept, each
// time it gets the whole history. This leaves them out from the first request after a compaction,
// for the models whose requests ask Anthropic to drop them.
function withoutUnboundThinking(
  messages: AgentMessage[],
  entries: SessionEntry[],
  model: Model<Api> | undefined,
): AgentMessage[] {
  const compacted = getLatestCompactionEntry(entries);

  if (
    !compacted ||
    !model ||
    !hasApi(model, "anthropic-messages") ||
    model.compat?.supportsMidConvoEffort !== true
  ) {
    return messages;
  }

  const compactedAt = Date.parse(compacted.timestamp);

  return messages.map((message) => {
    if (message.role !== "assistant" || message.timestamp >= compactedAt) {
      return message;
    }

    const content = message.content.filter((block) => block.type !== "thinking");

    // Anthropic rejects an assistant message with no content.
    return content.length > 0 && content.length < message.content.length
      ? { ...message, content }
      : message;
  });
}

function forkFailure(reply: AssistantMessage): string | undefined {
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    return reply.errorMessage ?? reply.stopReason;
  }

  if (reply.stopReason === "length") {
    return "the summary hit the output cap";
  }

  if (reply.content.some((block) => block.type === "toolCall")) {
    return "the fork tried to call a tool";
  }

  return undefined;
}

// A refresh that wrote the cache found it expired or sent a request the cache doesn't match. Each
// one costs as much as the miss it should prevent.
function refreshFailure(reply: AssistantMessage): string | undefined {
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    return reply.errorMessage ?? reply.stopReason;
  }

  const { input, cacheRead, cacheWrite } = reply.usage;

  return cacheRead < input + cacheWrite
    ? `it read only ${cacheShare(reply.usage)} of its input from the cache`
    : undefined;
}

// Pi's own idle warming covers a cache whose refresh comes within its 30-minute limit. This
// returns the times of a cache it leaves to expire.
function refreshTimes(model: Model<Api>): { ttlMs: number; delayMs: number } | undefined {
  const ttlMs = getPromptCacheTtlMs(model, undefined);
  const delayMs = ttlMs === undefined ? undefined : getCacheWarmingDelayMs(ttlMs);

  return ttlMs !== undefined && delayMs !== undefined && delayMs > CACHE_WARMING_MAX_IDLE_AGE_MS
    ? { ttlMs, delayMs }
    : undefined;
}

// Like pi, this allows a late timer half of the time left before the cache expires. A timer that
// fires later, as after the machine slept, may find the cache expired, and a request would then
// write it again.
function refreshDeadline(run: IdleRun): number {
  return run.touchedAt + run.delayMs + (run.ttlMs - run.delayMs) / 2;
}

function reasoningOf(thinkingLevel: ThinkingLevel) {
  return thinkingLevel === "off" ? undefined : thinkingLevel;
}

function wantsIdle(ctx: ExtensionContext, cfg: Idle): boolean {
  const used = ctx.getContextUsage()?.tokens ?? 0;

  return (cfg.warmMinutes > 0 || cfg.compact) && used >= cfg.minTokens;
}

function wantsColdCompaction(ctx: ExtensionContext, cfg: Idle, idleMs: number): boolean {
  const used = ctx.getContextUsage()?.tokens ?? 0;

  return cfg.compact && used >= cfg.minTokens && idleMs >= cfg.warmMinutes * 60_000;
}

function tokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function nextTurn(messages: AgentMessage[], from: number, end: number): number | undefined {
  for (let i = from; i < end; i++) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }

  return undefined;
}

// Keeps the leading system messages and summaries, the last turn, and the summary request, and
// drops whole turns between them until the context fits. Returns undefined if it can't fit.
function fitWindow(
  messages: AgentMessage[],
  limit: number,
): { messages: AgentMessage[]; dropped: number } | undefined {
  let head = 0;

  while (HEAD_ROLES.has(messages[head]?.role ?? "")) {
    head++;
  }

  let excess = tokens(messages) - limit;
  let start = head;

  while (excess > 0) {
    const next = nextTurn(messages, start + 1, messages.length - 1);

    if (next === undefined) {
      return undefined;
    }

    excess -= tokens(messages.slice(start, next).filter((message) => message.role !== "system"));
    start = next;
  }

  // System messages contain tool changes, so this keeps the ones in dropped turns.
  const dropped = messages.slice(head, start);
  const toolChanges = dropped.filter((message) => message.role === "system");

  return {
    messages: [...messages.slice(0, head), ...toolChanges, ...messages.slice(start)],
    dropped: dropped.length - toolChanges.length,
  };
}

// Runs from the previous compaction's kept entry to a cut that keeps keepRecentTokens. Pi cuts the
// session projection, which skips context edits, so the cuts can differ when the span has edits.
function compactionSpan(ctx: ExtensionContext, entries: SessionEntry[], model: Model<Api>) {
  const keptId = getLatestCompactionEntry(entries)?.firstKeptEntryId;
  const keptIndex = entries.findIndex((entry) => entry.id === keptId);
  const start = Math.max(0, keptIndex);
  const { keepRecentTokens } = piSettings(ctx).getCompactionSettings(model);
  const cut = findCutPoint(entries, start, entries.length, keepRecentTokens).firstKeptEntryIndex;
  const kept = entries[cut];

  return cut > start && kept ? { start, cut, keptId: kept.id } : undefined;
}

// Pi keeps the system prompt out of the session, so this fills it in.
function rebuiltContext(ctx: ExtensionContext): AgentMessage[] {
  return ctx.sessionManager
    .buildSessionProjection()
    .messages.map((message, i) =>
      i === 0 && message.role === "system" && !message.content
        ? { ...message, content: ctx.getSystemPrompt() }
        : message,
    );
}

// The fork sees the whole context, so this names the message the branch starts at.
function branchStart(entries: SessionEntry[]): string {
  const first = entries
    .flatMap((entry) => sessionEntryToContextMessages(entry))
    .find((message): message is UserMessage => message.role === "user");

  const start = first ? contentText(first.content, "").trim().slice(0, 200) : "";

  return start
    ? `The branch starts at the user message that begins "${start}". Summarize that message and what follows. The other branch shares the messages before it.`
    : "";
}

function cacheShare(usage: Usage): string {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;

  return input === 0 ? "0%" : `${Math.round((usage.cacheRead / input) * 100)}%`;
}

function fileLists(fileOps: FileOperations): FileLists {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);

  return {
    readFiles: [...fileOps.read].filter((path) => !modified.has(path)).toSorted(),
    modifiedFiles: [...modified].toSorted(),
  };
}

function formatFileLists({ readFiles, modifiedFiles }: FileLists): string {
  const sections = [
    readFiles.length > 0 ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "",
    modifiedFiles.length > 0
      ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`
      : "",
  ].filter(Boolean);

  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

// Pi skips file lists in extension summaries. These lists use pi's format, so clear fromHook
// to include them in the next branch summary.
function asPiSummaries(entries: SessionEntry[]): SessionEntry[] {
  return entries.map((entry) =>
    entry.type === "branch_summary" && entry.fromHook && Value.Check(FileLists, entry.details)
      ? { ...entry, fromHook: false }
      : entry,
  );
}

function withPreviousFiles(fileOps: FileOperations, entries: SessionEntry[]): FileOperations {
  const details = getLatestCompactionEntry(entries)?.details;
  const read = new Set(fileOps.read);
  const edited = new Set(fileOps.edited);

  if (Value.Check(FileLists, details)) {
    details.readFiles.forEach((path) => read.add(path));
    details.modifiedFiles.forEach((path) => edited.add(path));
  }

  return { read, written: new Set(fileOps.written), edited };
}

function active(ctx: ExtensionContext): { cfg: Config; model: Model<Api> } | undefined {
  const cfg = loadOrReport(ctx, NAME, KEY, Config);

  return cfg && ctx.model ? { cfg, model: ctx.model } : undefined;
}

function withFocus(prompt: string, focus: string | undefined): string {
  return focus ? `${prompt}\n\nAdditional focus: ${focus}` : prompt;
}

function treeSummary(summary: string, files: FileLists, usage: Usage | undefined) {
  return { summary: { summary, usage, details: files } };
}

async function piBranchSummary(
  event: SessionBeforeTreeEvent,
  ctx: ExtensionContext,
  model: Model<Api>,
  thinkingLevel: ThinkingLevel,
) {
  const { preparation, signal } = event;
  const settings = piSettings(ctx);

  // Returning nothing lets pi summarize, but pi would drop the file lists from this extension's
  // earlier summaries.
  const result = await generateBranchSummary(asPiSummaries(preparation.entriesToSummarize), {
    model,
    signal,
    customInstructions: preparation.customInstructions,
    replaceInstructions: preparation.replaceInstructions,
    reserveTokens: settings.getBranchSummarySettings().reserveTokens,
    thinkingLevel,
    retry: settings.getRetrySettings(),
    streamFn: (requestModel, context, options) =>
      ctx.modelRegistry.streamSimple(requestModel, context, options),
  });

  if (result.aborted) {
    return { cancel: true };
  }

  if (result.error !== undefined || result.summary === undefined) {
    ctx.ui.notify(result.error ?? "Branch summarization returned no summary", "error");

    return { cancel: true };
  }

  const files = { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [] };

  return treeSummary(result.summary, files, result.usage);
}

async function send(
  ctx: ExtensionContext,
  model: Model<Api>,
  sending: Sending,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  const settings = piSettings(ctx);
  const { thinkingLevel, maxTokens, retry, rewrite } = sending;

  // before_provider_request doesn't run for this request, so other extensions' changes come only
  // from the replayed request.
  const call = () =>
    ctx.modelRegistry
      .streamSimple(
        model,
        { messages: convertToLlm(sending.messages) },
        {
          signal,
          reasoning: reasoningOf(thinkingLevel),
          maxTokens,
          sessionId: ctx.sessionManager.getSessionId(),
          disableContinuation: true,
          transport: settings.getTransport(),
          thinkingBudgets: settings.getThinkingBudgets(),
          onPayload: (built) => (isJson(built) && isFields(built) ? rewrite(built) : undefined),
          maxRetries: retry ? undefined : 0,
        },
      )
      .result();

  return retry ? retryAssistantCall(call, settings.getRetrySettings(), signal) : call();
}

export default function compaction(pi: ExtensionAPI) {
  let request: Request | undefined;

  // Retry a failed fork on the next run, not on every turn.
  let failedThisRun = false;

  let idle: IdleRun | undefined;

  // Idle refreshes since the last run, which the next run reports.
  let refreshes = 0;

  // The kind of compaction pi is running because this extension asked for it.
  let unprompted: "Idle" | "Cold-cache" | undefined;

  // If a `context` handler changes the list, pi merges the mid-conversation system messages into
  // the first one, which changes the cached prefix. Pi sends this event's list as returned.
  pi.on("context_with_system", (event, ctx) => {
    const messages = withoutUnboundThinking(
      event.messages,
      ctx.sessionManager.getBranch(),
      ctx.model,
    );

    request = ctx.model && {
      model: `${ctx.model.provider}/${ctx.model.id}`,
      leafId: ctx.sessionManager.getLeafId(),
      messages,
      thinkingLevel: pi.getThinkingLevel(),
    };

    return { messages };
  });

  pi.on("before_provider_request", (event) => {
    if (request && isJson(event.payload) && isFields(event.payload)) {
      request.payload = event.payload;
      request.sentAt = Date.now();
    }
  });

  // The recorded request, if the provider has it cached and the session still continues from it.
  function sentRequest(ctx: ExtensionContext, model: Model<Api>): Sent | undefined {
    const { payload, sentAt } = request ?? {};

    if (
      !request ||
      payload === undefined ||
      sentAt === undefined ||
      request.model !== `${model.provider}/${model.id}`
    ) {
      return undefined;
    }

    return messagesSince(ctx.sessionManager.getBranch(), request.leafId)
      ? { ...request, payload, sentAt }
      : undefined;
  }

  function forkInput(ctx: ExtensionContext, model: Model<Api>): ForkInput {
    const recorded = request?.model === `${model.provider}/${model.id}` ? request : undefined;
    const since = recorded && messagesSince(ctx.sessionManager.getBranch(), recorded.leafId);

    if (!recorded || !since) {
      return { messages: rebuiltContext(ctx), thinkingLevel: pi.getThinkingLevel() };
    }

    const { thinkingLevel, payload } = recorded;

    return { messages: [...recorded.messages, ...since], thinkingLevel, payload };
  }

  // How long ago the session last sent a request or got a reply. Idle refreshes don't count.
  function idleTime(ctx: ExtensionContext): number | undefined {
    const branch = ctx.sessionManager.getBranch();
    // The recorded request counts only if this branch continues from it.
    const sentAt = request && messagesSince(branch, request.leafId) ? request.sentAt : undefined;
    const last = Math.max(lastReply(branch) ?? 0, sentAt ?? 0);

    return last > 0 ? Date.now() - last : undefined;
  }

  async function fork(
    ctx: ExtensionContext,
    cfg: Config,
    model: Model<Api>,
    prompt: string,
    signal: AbortSignal,
  ): Promise<Forked> {
    const input = forkInput(ctx, model);
    const idleMs = idleTime(ctx);
    const expired = idleMs !== undefined && cacheExpired(model, cacheAge(ctx, idleMs));
    const limit = model.contextWindow > 0 ? cfg.compactAt * model.contextWindow : Infinity;
    const ask = userMessage(`${prompt}\n\n${NO_TOOLS}`);
    const fitted = fitWindow([...input.messages, ask], limit);

    if (!fitted) {
      return { failure: "the latest turn alone is too big to fork" };
    }

    if (fitted.dropped > 0) {
      ctx.ui.notify(`Summary fork dropped the ${fitted.dropped} oldest messages to fit`, "warning");
    }

    const reply = await send(
      ctx,
      model,
      {
        messages: fitted.messages,
        thinkingLevel: input.thinkingLevel,
        retry: true,
        rewrite: (built) => forkPayload(input.payload, built, expired),
      },
      signal,
    );

    const summary = contentText(reply.content, "").trim();
    const failure = forkFailure(reply) ?? (summary ? undefined : "the fork returned no summary");

    if (failure !== undefined) {
      return { failure };
    }

    ctx.ui.notify(
      `Summary fork read ${cacheShare(reply.usage)} of its input from the cache`,
      "info",
    );

    return { text: summary, usage: reply.usage };
  }

  async function forkSafely(
    ctx: ExtensionContext,
    cfg: Config,
    model: Model<Api>,
    prompt: string,
    signal: AbortSignal,
  ): Promise<Forked> {
    try {
      return await fork(ctx, cfg, model, prompt, signal);
    } catch (error) {
      return { failure: errorMessage(error) };
    }
  }

  async function compactionSummary(
    ctx: ExtensionContext,
    cfg: Config,
    model: Model<Api>,
    fileOps: FileOperations,
    entries: SessionEntry[],
    focus: string | undefined,
    signal: AbortSignal,
  ) {
    const prompt = withFocus(SUMMARIZATION_PROMPT, focus);
    const forked = await forkSafely(ctx, cfg, model, prompt, signal);

    if ("failure" in forked) {
      return forked;
    }

    const files = fileLists(withPreviousFiles(fileOps, entries));

    return {
      summary: `${forked.text}${formatFileLists(files)}`,
      usage: forked.usage,
      details: files,
    };
  }

  async function onTree(event: SessionBeforeTreeEvent, ctx: ExtensionContext) {
    const { preparation, signal } = event;
    const { entriesToSummarize, customInstructions } = preparation;
    const settings = active(ctx);

    if (!settings || !preparation.userWantsSummary || entriesToSummarize.length === 0) {
      return;
    }

    const { cfg, model } = settings;

    const instructions =
      customInstructions && preparation.replaceInstructions
        ? customInstructions
        : withFocus(BRANCH_SUMMARY_PROMPT, customInstructions);

    const start = branchStart(entriesToSummarize);
    const prompt = start ? `${instructions}\n\n${start}` : instructions;
    const forked = await forkSafely(ctx, cfg, model, prompt, signal);

    if (signal.aborted) {
      return { cancel: true };
    }

    if ("failure" in forked) {
      ctx.ui.notify(
        `Branch summary fork failed: ${forked.failure}. Using pi's summarizer.`,
        "warning",
      );

      return piBranchSummary(event, ctx, model, pi.getThinkingLevel());
    }

    const files = fileLists(prepareBranchEntries(asPiSummaries(entriesToSummarize)).fileOps);

    return treeSummary(
      `${BRANCH_SUMMARY_PREAMBLE}${forked.text}${formatFileLists(files)}`,
      files,
      forked.usage,
    );
  }

  async function onCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
    const { preparation, signal } = event;
    const settings = active(ctx);

    if (!settings) {
      return;
    }

    const { cfg, model } = settings;

    const result = await compactionSummary(
      ctx,
      cfg,
      model,
      preparation.fileOps,
      event.branchEntries,
      event.customInstructions,
      signal,
    );

    if (signal.aborted) {
      return { cancel: true };
    }

    // The user didn't ask for this compaction, and pi's summarizer would send the whole session
    // again. So a failed fork leaves the session as it is.
    if ("failure" in result && unprompted) {
      ctx.ui.notify(
        `${unprompted} compaction fork failed: ${result.failure}. The session isn't compacted.`,
        "warning",
      );

      return { cancel: true };
    }

    if ("failure" in result) {
      ctx.ui.notify(`Compaction fork failed: ${result.failure}. Using pi's summarizer.`, "warning");

      return;
    }

    const { firstKeptEntryId, tokensBefore } = preparation;

    return { compaction: { ...result, firstKeptEntryId, tokensBefore } };
  }

  function shouldCompact(ctx: ExtensionContext, cfg: Config, model: Model<Api>): boolean {
    const used = ctx.getContextUsage()?.tokens ?? 0;

    return !failedThisRun && model.contextWindow > 0 && used >= cfg.compactAt * model.contextWindow;
  }

  async function onTurnEnd(event: TurnEndEvent, ctx: ExtensionContext) {
    const settings = active(ctx);

    if (!settings || !shouldCompact(ctx, settings.cfg, settings.model)) {
      return;
    }

    const { cfg, model } = settings;
    const entries = ctx.sessionManager.getBranch();
    const span = compactionSpan(ctx, entries, model);

    if (!span) {
      return;
    }

    const summarized = asPiSummaries(entries.slice(span.start, span.cut));
    const fileOps = prepareBranchEntries(summarized).fileOps;
    const signal = ctx.signal ?? new AbortController().signal;

    ctx.ui.setWorkingMessage("Compacting context...");

    try {
      const result = await compactionSummary(ctx, cfg, model, fileOps, entries, undefined, signal);

      if ("failure" in result) {
        failedThisRun = !signal.aborted;
        ctx.ui.notify(
          `Compaction fork failed: ${result.failure}. Pi compacts at its own threshold.`,
          "warning",
        );

        return;
      }

      // Each handler's entries replace the earlier ones, so this keeps other extensions' entries.
      return {
        entries: [
          ...event.entries,
          { type: "compaction" as const, ...result, firstKeptEntryId: span.keptId },
        ],
      };
    } finally {
      ctx.ui.setWorkingMessage();
    }
  }

  function disarm() {
    if (!idle) {
      return;
    }

    clearTimeout(idle.timer);
    idle.controller.abort();
    idle = undefined;
  }

  function schedule(ctx: ExtensionContext, run: IdleRun) {
    const wait = Math.max(0, run.touchedAt + run.delayMs - Date.now());

    run.timer = setTimeout(() => void onIdleTimer(ctx, run), wait);
    // The timer doesn't keep `pi --print` running.
    run.timer.unref();
  }

  function arm(ctx: ExtensionContext) {
    disarm();

    const settings = active(ctx);
    const sent = settings && sentRequest(ctx, settings.model);
    const times = settings && refreshTimes(settings.model);

    if (!settings || !sent || !times || !wantsIdle(ctx, settings.cfg.idle)) {
      return;
    }

    idle = {
      ...times,
      idleSince: Date.now(),
      controller: new AbortController(),
      touchedAt: sent.sentAt,
    };

    schedule(ctx, idle);
  }

  // Repeats the recorded request with a one-token reply, which renews its cache entry.
  async function refresh(ctx: ExtensionContext, run: IdleRun, model: Model<Api>, sent: Sent) {
    const { messages, thinkingLevel, payload } = sent;
    const sentAt = Date.now();

    const reply = await send(
      ctx,
      model,
      {
        messages,
        thinkingLevel,
        maxTokens: 1,
        retry: false,
        rewrite: (built) => mergeFields(payload, built),
      },
      run.controller.signal,
    );

    // A new run, model, or session disarmed the timer during the request.
    if (idle !== run) {
      return;
    }

    if (reply.stopReason !== "error" && reply.stopReason !== "aborted") {
      pi.appendEntry<CacheRefresh>(CACHE_REFRESH, { model: sent.model, usage: reply.usage });
    }

    const failure = refreshFailure(reply);

    if (failure !== undefined) {
      disarm();
      ctx.ui.notify(`Idle cache refresh stopped: ${failure}`, "warning");

      return;
    }

    run.touchedAt = sentAt;
    refreshes++;
    schedule(ctx, run);
  }

  // Resolves when the compaction ends, whether or not it compacted the session.
  function compactUnprompted(
    ctx: ExtensionContext,
    kind: NonNullable<typeof unprompted>,
    notice: string,
  ): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();

    unprompted = kind;

    ctx.compact({
      onComplete: () => {
        unprompted = undefined;
        ctx.ui.notify(`${notice} Turn this off with \`summaryFork.idle.compact\`.`, "info");
        resolve();
      },
      // Pi reports the error.
      onError: () => {
        unprompted = undefined;
        resolve();
      },
    });

    return promise;
  }

  // Pi waits for this handler before it starts the run, so the prompt goes to the compacted
  // session. The idle timer has already compacted an awake session that was idle for
  // `idle.warmMinutes`. After a shorter idle, the session keeps its context and pi writes the cache
  // again.
  async function onInput(_event: InputEvent, ctx: ExtensionContext) {
    const idleMs = ctx.isIdle() ? idleTime(ctx) : undefined;
    const settings = idleMs === undefined ? undefined : active(ctx);

    if (
      idleMs === undefined ||
      !settings ||
      !wantsColdCompaction(ctx, settings.cfg.idle, idleMs) ||
      !cacheExpired(settings.model, cacheAge(ctx, idleMs))
    ) {
      return;
    }

    disarm();

    await compactUnprompted(
      ctx,
      "Cold-cache",
      `Compacted before this prompt, because the prompt cache expired during ${Math.round(idleMs / 60_000)} idle minutes.`,
    );
  }

  async function idleStep(ctx: ExtensionContext, run: IdleRun) {
    const waiting = ctx.isIdle() && !ctx.hasPendingMessages();
    const settings = waiting ? active(ctx) : undefined;
    const sent = settings && sentRequest(ctx, settings.model);

    if (!settings || !sent || Date.now() > refreshDeadline(run)) {
      disarm();

      return;
    }

    const { model, cfg } = settings;
    const warm = Date.now() - run.idleSince < cfg.idle.warmMinutes * 60_000;

    // If the model can't repeat the request with a one-token reply, this compacts the session now.
    if (warm && isCacheWarmingReplayable(model, { reasoning: reasoningOf(sent.thinkingLevel) })) {
      await refresh(ctx, run, model, sent);

      return;
    }

    disarm();

    if (cfg.idle.compact) {
      void compactUnprompted(ctx, "Idle", "Compacted while idle, before the prompt cache expired.");
    }
  }

  async function onIdleTimer(ctx: ExtensionContext, run: IdleRun) {
    if (idle !== run) {
      return;
    }

    try {
      await idleStep(ctx, run);
    } catch (error) {
      // After a disarm the session may be gone, and with it ctx.
      if (idle === run) {
        disarm();
        ctx.ui.notify(`Idle cache refresh stopped: ${errorMessage(error)}`, "warning");
      }
    }
  }

  pi.on("input", onInput);
  pi.on("turn_end", onTurnEnd);
  pi.on("agent_start", (_event, ctx) => {
    const count = refreshes;

    refreshes = 0;
    disarm();

    if (count > 0) {
      ctx.ui.notify(
        `Refreshed the prompt cache ${count === 1 ? "once" : `${count} times`} while idle`,
        "info",
      );
    }
  });
  pi.on("agent_end", () => {
    failedThisRun = false;
  });
  pi.on("agent_settled", (_event, ctx) => {
    arm(ctx);
  });
  // Each of these changes the context, so the recorded request no longer matches it.
  pi.on("model_select", disarm);
  pi.on("session_tree", disarm);
  pi.on("session_compact", disarm);

  pi.on("session_shutdown", disarm);
  pi.on("session_before_tree", onTree);
  pi.on("session_before_compact", onCompact);
}

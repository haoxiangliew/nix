/**
 * Writes compaction and branch summaries by forking the session, as Claude Code and Codex do. The
 * fork resends the session's conversation with a summary request after it, so it sees full tool
 * results and can write up to the model's output limit.
 *
 * Each session request records the messages pi sends, the final payload, and the session leaf. A
 * fork sends those messages plus the entries added since. When its payload starts with the
 * recorded messages, it reuses the recorded payload's system prompt, tools, thinking, and fast
 * mode, so it reads the conversation from the prompt cache. Without a recording, such as after a
 * restart, the fork rebuilds the context from the session and writes no conversation cache.
 *
 * Pi's trigger is a fixed reserve per model, so this compacts at the end of a turn once context
 * reaches `compactAt` of the window. Pi's own compaction (overflow, /compact) forks too. A fork over
 * `compactAt` drops its oldest turns. Pi's summarizer runs when a fork fails. Configured by
 * `summaryFork` in settings.json.
 */

import type { Api, AssistantMessage, Model, Usage, UserMessage } from "@earendil-works/pi-ai";
import type {
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionContext,
  FileOperations,
  SessionBeforeCompactEvent,
  SessionBeforeTreeEvent,
  SessionEntry,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { retryAssistantCall } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  estimateTokens,
  findCutPoint,
  generateBranchSummary,
  getLatestCompactionEntry,
  prepareBranchEntries,
  sessionEntryToContextMessages,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { errorMessage, loadOrReport } from "./lib/settings.ts";

type AgentMessage = ContextWithSystemEvent["messages"][number];

const NAME = "compaction";

// Pi uses the `compaction` key.
const KEY = "summaryFork";

// Cap on pi's branch summarizer after a failed fork, OpenCode's default. Pi's own is 4,096.
const FALLBACK_BRANCH_TOKENS = 32_000;

// Trimming keeps these at the start of the context.
const HEAD_ROLES = new Set<string>(["system", "compactionSummary", "branchSummary"]);

const Config = Type.Object(
  {
    // Compact at this share of the model's context window. The fork gets the rest.
    compactAt: Type.Number({ minimum: 0.5, maximum: 0.95, default: 0.9 }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

const Block = Type.Object({ cache_control: Type.Optional(Type.Unknown()) });

const Payload = Type.Object({
  model: Type.String(),
  max_tokens: Type.Number(),
  messages: Type.Array(
    Type.Object({ role: Type.String(), content: Type.Union([Type.String(), Type.Array(Block)]) }),
  ),
});

type Payload = Static<typeof Payload>;

type PayloadMessage = Payload["messages"][number];

const FileLists = Type.Object({
  readFiles: Type.Array(Type.String()),
  modifiedFiles: Type.Array(Type.String()),
});

type FileLists = Static<typeof FileLists>;

interface Request {
  model: string;
  leafId: string | null;
  messages: AgentMessage[];
  payload?: Payload;
}

interface ForkInput {
  messages: AgentMessage[];
  payload?: Payload;
}

type Forked = { text: string; usage: Usage } | { failure: string };

// Pi's prompts, copied verbatim since pi doesn't export them.
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

function stripCacheControl(message: PayloadMessage): PayloadMessage {
  if (!Array.isArray(message.content)) {
    return message;
  }

  return {
    ...message,
    content: message.content.map((block) => {
      const copy = { ...block };

      delete copy.cache_control;

      return copy;
    }),
  };
}

function sameMessages(a: PayloadMessage[], b: PayloadMessage[]): boolean {
  return JSON.stringify(a.map(stripCacheControl)) === JSON.stringify(b.map(stripCacheControl));
}

// Managed-effort models end each payload with a system message that sets the effort.
function conversationLength(messages: PayloadMessage[]): number {
  let length = messages.length;

  while (length > 0 && messages[length - 1]?.role === "system") {
    length--;
  }

  return length;
}

// When the built conversation starts with the recorded one, sends that part as recorded, cache
// breakpoint included, under the recorded settings. Keeps the built max_tokens, which pi-ai has
// fit to the room left in the window.
function replayPayload(recorded: Payload, built: Payload): Payload | undefined {
  const length = conversationLength(recorded.messages);
  const prefix = recorded.messages.slice(0, length);

  if (!sameMessages(built.messages.slice(0, length), prefix)) {
    return undefined;
  }

  const rest = built.messages.slice(length).map(stripCacheControl);

  return { ...recorded, messages: [...prefix, ...rest], max_tokens: built.max_tokens };
}

// Without the recorded prefix, a message breakpoint would write a cache that nothing reads. The
// system prompt and tool breakpoints stay, since the session shares them.
function forkPayload(recorded: Payload | undefined, built: Payload): Payload {
  const replayed = recorded && replayPayload(recorded, built);

  return replayed ?? { ...built, messages: built.messages.map(stripCacheControl) };
}

// Undefined when the branch no longer contains the recorded leaf, or a summary since then changes
// how pi builds the context.
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

// Drops whole turns from the front, after the system message and earlier summaries, until the
// messages fit under limit. The last turn and the summary request stay. Undefined when they alone
// are over the limit.
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

  // System messages carry tool changes, so dropped turns keep theirs.
  const dropped = messages.slice(head, start);
  const toolChanges = dropped.filter((message) => message.role === "system");

  return {
    messages: [...messages.slice(0, head), ...toolChanges, ...messages.slice(start)],
    dropped: dropped.length - toolChanges.length,
  };
}

// The span a compaction summarizes, picked as pi picks it: from the previous compaction's kept
// entry up to a cut that keeps keepRecentTokens. Undefined when there's nothing to summarize.
function compactionSpan(ctx: ExtensionContext, entries: SessionEntry[], model: Model<Api>) {
  const keptId = getLatestCompactionEntry(entries)?.firstKeptEntryId;
  const keptIndex = entries.findIndex((entry) => entry.id === keptId);
  const start = Math.max(0, keptIndex);
  const { keepRecentTokens } = SettingsManager.create(ctx.cwd).getCompactionSettings(model);
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

function textOf(content: UserMessage["content"] | AssistantMessage["content"]): string {
  if (!Array.isArray(content)) {
    return content;
  }

  return [...content].flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

// The fork sees the whole context, so this names the message the branch starts at.
function branchStart(entries: SessionEntry[]): string {
  const first = entries
    .flatMap((entry) => sessionEntryToContextMessages(entry))
    .find((message): message is UserMessage => message.role === "user");

  const start = first ? textOf(first.content).trim().slice(0, 200) : "";

  return start
    ? `The branch starts at the user message that begins "${start}". Summarize that message and what follows. Earlier messages are shared context.`
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

// Pi skips file lists in summaries from extensions. This extension's have pi's format, so marking
// them as pi's carries the lists into the next branch summary.
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
) {
  const { preparation, signal } = event;
  const settings = SettingsManager.create(ctx.cwd);
  const maxTokens = Math.min(FALLBACK_BRANCH_TOKENS, model.maxTokens || FALLBACK_BRANCH_TOKENS);

  const result = await generateBranchSummary(asPiSummaries(preparation.entriesToSummarize), {
    model,
    signal,
    customInstructions: preparation.customInstructions,
    replaceInstructions: preparation.replaceInstructions,
    // Pi's reserve leaves room for its 4,096-token output, not this one.
    reserveTokens: settings.getBranchSummarySettings().reserveTokens + maxTokens,
    retry: settings.getRetrySettings(),
    streamFn: (requestModel, context, options) =>
      ctx.modelRegistry.streamSimple(requestModel, context, { ...options, maxTokens }),
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

export default function compaction(pi: ExtensionAPI) {
  let request: Request | undefined;

  // Set after a failed compaction fork, so it waits for the next run instead of every turn.
  let failedThisRun = false;

  pi.on("context_with_system", (event, ctx) => {
    request = ctx.model && {
      model: `${ctx.model.provider}/${ctx.model.id}`,
      leafId: ctx.sessionManager.getLeafId(),
      messages: event.messages,
    };
  });

  pi.on("before_provider_request", (event) => {
    if (request && Value.Check(Payload, event.payload)) {
      request.payload = event.payload;
    }
  });

  function forkInput(ctx: ExtensionContext, model: Model<Api>): ForkInput {
    const recorded = request?.model === `${model.provider}/${model.id}` ? request : undefined;
    const since = recorded && messagesSince(ctx.sessionManager.getBranch(), recorded.leafId);

    if (!recorded || !since) {
      return { messages: rebuiltContext(ctx) };
    }

    return { messages: [...recorded.messages, ...since], payload: recorded.payload };
  }

  async function send(
    ctx: ExtensionContext,
    model: Model<Api>,
    input: ForkInput,
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    const thinkingLevel = pi.getThinkingLevel();
    const { payload } = input;

    return retryAssistantCall(
      () =>
        ctx.modelRegistry
          .streamSimple(
            model,
            { messages: convertToLlm(input.messages) },
            {
              signal,
              reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
              sessionId: ctx.sessionManager.getSessionId(),
              onPayload: (built) =>
                Value.Check(Payload, built) ? forkPayload(payload, built) : undefined,
            },
          )
          .result(),
      SettingsManager.create(ctx.cwd).getRetrySettings(),
      signal,
    );
  }

  async function fork(
    ctx: ExtensionContext,
    cfg: Config,
    model: Model<Api>,
    prompt: string,
    signal: AbortSignal,
  ): Promise<Forked> {
    const input = forkInput(ctx, model);
    const limit = model.contextWindow > 0 ? cfg.compactAt * model.contextWindow : Infinity;
    const ask = userMessage(`${prompt}\n\n${NO_TOOLS}`);
    const fitted = fitWindow([...input.messages, ask], limit);

    if (!fitted) {
      return { failure: "the latest turn alone is too big to fork" };
    }

    if (fitted.dropped > 0) {
      ctx.ui.notify(`Summary fork dropped the ${fitted.dropped} oldest messages to fit`, "warning");
    }

    const reply = await send(ctx, model, { ...input, messages: fitted.messages }, signal);
    const summary = textOf(reply.content).trim();
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

      return piBranchSummary(event, ctx, model);
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

      // Each handler's entries replace the ones before, so this keeps other extensions'.
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

  pi.on("turn_end", onTurnEnd);
  pi.on("agent_end", () => {
    failedThisRun = false;
  });
  pi.on("session_before_tree", onTree);
  pi.on("session_before_compact", onCompact);
}

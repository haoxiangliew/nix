/**
 * One-line footer: talk, auto-mode review, stall warning, model, thinking, fast, folder, branch,
 * context, cost, tokens since the last user message, tok/s, and TTFT. Configured by `statusline`
 * in settings.json. Invalid settings keep pi's built-in footer.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { Type, type Static } from "typebox";

import { isModelOutput } from "./lib/output.ts";
import { loadOrReport } from "./lib/settings.ts";

const SEGMENTS = [
  "talk",
  "autoMode",
  "stall",
  "model",
  "thinking",
  "fast",
  "cwd",
  "context",
  "cost",
  "tokens",
  "speed",
] as const;

const Config = Type.Object(
  {
    // Which segments to show, in order.
    segments: Type.Array(Type.Enum(SEGMENTS), { uniqueItems: true, default: [...SEGMENTS] }),
  },
  { additionalProperties: false, default: {} },
);

type Segment = (typeof SEGMENTS)[number];

type Config = Static<typeof Config>;

interface Speed {
  ttftMs?: number;
  tokensPerSecond?: number;
}

// Tokens since the last user message, summed over its model requests. Input includes cached
// tokens, so it grows with each request.
interface Totals {
  input: number;
  output: number;
  // Anthropic reports output tokens only when a reply ends, so a streaming reply is estimated.
  estimated: boolean;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }

  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }

  return `${tokens}`;
}

function formatCwd(cwd: string): string {
  const home = homedir();

  return cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function contextColor(percent: number | null): "muted" | "warning" | "error" {
  if (percent === null || percent <= 70) {
    return "muted";
  }

  return percent <= 90 ? "warning" : "error";
}

function formatContext(usage: ContextUsage, theme: Theme): string {
  const { percent } = usage;
  const shown = percent === null ? "?" : `${Math.round(percent)}%`;

  return theme.fg(contextColor(percent), `${shown}/${formatTokens(usage.contextWindow)}`);
}

// Counts the same entries as pi's built-in footer.
const COSTED_ENTRIES = new Set(["usage", "compaction", "branch_summary"]);

function messageCost(entry: Extract<SessionEntry, { type: "message" }>): number {
  const { message } = entry;

  return message.role === "assistant" || message.role === "toolResult"
    ? (message.usage?.cost.total ?? 0)
    : 0;
}

function entryCost(entry: SessionEntry): number {
  if (entry.type === "message") {
    return messageCost(entry);
  }

  return COSTED_ENTRIES.has(entry.type) && "usage" in entry ? (entry.usage?.cost.total ?? 0) : 0;
}

// The built-in footer treats kimi-coding as a subscription despite its API key.
function isSubscription(ctx: ExtensionContext): boolean {
  const { model, modelRegistry } = ctx;

  if (model === undefined) {
    return false;
  }

  return (
    model.provider === "kimi-coding" ||
    (modelRegistry.isUsingOAuth(model) &&
      modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true)
  );
}

function formatCost(ctx: ExtensionContext): string | undefined {
  const cost = ctx.sessionManager.getEntries().reduce((sum, entry) => sum + entryCost(entry), 0);
  const subscription = isSubscription(ctx);

  if (cost === 0 && !subscription) {
    return undefined;
  }

  return `$${cost.toFixed(2)}${subscription ? " (sub)" : ""}`;
}

function formatTotals(totals: Totals | undefined): string | undefined {
  if (totals === undefined) {
    return undefined;
  }

  const output = `${totals.estimated ? "~" : ""}${formatTokens(totals.output)}`;

  return `↑${formatTokens(totals.input)} ↓${output}`;
}

function formatSpeed(speed: Speed): string[] {
  const parts: string[] = [];

  if (speed.tokensPerSecond !== undefined) {
    parts.push(`${Math.round(speed.tokensPerSecond)} tok/s`);
  }

  if (speed.ttftMs !== undefined) {
    parts.push(`ttft ${(speed.ttftMs / 1000).toFixed(1)}s`);
  }

  return parts;
}

function trackSpeed(pi: ExtensionAPI, onChange: () => void): Speed {
  const speed: Speed = {};
  let requestStart: number | undefined;
  let firstToken: number | undefined;

  // Fires after context transforms and auth refresh, right before the payload is sent.
  pi.on("before_provider_request", async () => {
    requestStart = Date.now();
    firstToken = undefined;
  });

  pi.on("message_update", async (event) => {
    if (requestStart === undefined || firstToken !== undefined || !isModelOutput(event)) {
      return;
    }

    firstToken = Date.now();
    speed.ttftMs = firstToken - requestStart;
    onChange();
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant" || firstToken === undefined) {
      return;
    }

    const { stopReason, usage } = event.message;
    const seconds = (Date.now() - firstToken) / 1000;
    const failed = stopReason === "error" || stopReason === "aborted";

    // A reply that arrives in one burst gives no usable rate.
    if (!failed && usage.output > 0 && seconds >= 0.25) {
      speed.tokensPerSecond = usage.output / seconds;
    }

    requestStart = undefined;
    firstToken = undefined;
    onChange();
  });

  return speed;
}

function inputTokens(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function trackTotals(pi: ExtensionAPI, onChange: () => void): () => Totals | undefined {
  let done: Totals | undefined;
  let current: Totals | undefined;

  pi.on("before_agent_start", async () => {
    done = { input: 0, output: 0, estimated: false };
    current = done;
    onChange();
  });

  pi.on("message_update", async (event) => {
    const { message } = event;

    if (done === undefined || message.role !== "assistant") {
      return;
    }

    current = {
      input: done.input + inputTokens(message.usage),
      output: done.output + estimateTokens(message),
      estimated: true,
    };
    onChange();
  });

  pi.on("message_end", async (event) => {
    const { message } = event;

    if (done === undefined || message.role !== "assistant") {
      return;
    }

    done = {
      input: done.input + inputTokens(message.usage),
      output: done.output + message.usage.output,
      estimated: false,
    };
    current = done;
    onChange();
  });

  return () => current;
}

export default function (pi: ExtensionAPI) {
  let requestRender: (() => void) | undefined;

  const speed = trackSpeed(pi, () => requestRender?.());
  const totals = trackTotals(pi, () => requestRender?.());

  pi.on("session_start", async (_event, ctx) => {
    const config = loadOrReport(ctx, "The custom status line", "statusline", Config);

    if (config === undefined) {
      return;
    }

    const { segments } = config;

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();

      const unsubscribe = footerData.onBranchChange(requestRender);

      return {
        dispose() {
          unsubscribe();
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const statuses = footerData.getExtensionStatuses();

          const tint = (color: Parameters<Theme["fg"]>[0], text: string | undefined) =>
            text && theme.fg(color, text);

          const pieces: Record<Segment, () => (string | undefined)[]> = {
            talk: () => [statuses.get("talk")],
            autoMode: () => [tint("warning", statuses.get("auto-mode"))],
            model: () => [ctx.model && theme.fg("accent", `${ctx.model.provider}/${ctx.model.id}`)],
            thinking: () => [theme.fg("muted", pi.getThinkingLevel())],
            fast: () => [statuses.get("fast")],
            stall: () => [tint("error", statuses.get("stall-watchdog"))],
            tokens: () => [tint("muted", formatTotals(totals()))],
            cwd: () => {
              const branch = footerData.getGitBranch();

              return [
                formatCwd(ctx.cwd) + (branch === null ? "" : theme.fg("muted", ` (${branch})`)),
              ];
            },
            context: () => {
              const usage = ctx.getContextUsage();

              return [usage && formatContext(usage, theme)];
            },
            cost: () => [tint("muted", formatCost(ctx))],
            speed: () => formatSpeed(speed).map((part) => theme.fg("muted", part)),
          };

          const parts = segments
            .flatMap((segment) => pieces[segment]())
            .filter((part) => part !== undefined);

          return [truncateToWidth(parts.join(theme.fg("dim", " · ")), width)];
        },
      };
    });
  });
}

/**
 * One-line footer: talk, model, thinking, fast, folder, branch, context, cost, tok/s, and TTFT.
 */

import { homedir } from "node:os";

import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

interface Speed {
  ttftMs?: number;
  tokensPerSecond?: number;
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
    if (
      event.message.role !== "assistant" ||
      requestStart === undefined ||
      firstToken !== undefined
    ) {
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

export default function (pi: ExtensionAPI) {
  let requestRender: (() => void) | undefined;

  const speed = trackSpeed(pi, () => requestRender?.());

  pi.on("session_start", async (_event, ctx) => {
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
          const branch = footerData.getGitBranch();
          const usage = ctx.getContextUsage();
          const model = ctx.model && theme.fg("accent", `${ctx.model.provider}/${ctx.model.id}`);
          const cost = formatCost(ctx);

          const parts = [
            statuses.get("talk"),
            model,
            theme.fg("muted", pi.getThinkingLevel()),
            statuses.get("fast"),
            formatCwd(ctx.cwd) + (branch === null ? "" : theme.fg("muted", ` (${branch})`)),
            usage && formatContext(usage, theme),
            cost && theme.fg("muted", cost),
            ...formatSpeed(speed).map((part) => theme.fg("muted", part)),
          ].filter((part) => part !== undefined);

          return [truncateToWidth(parts.join(theme.fg("dim", " · ")), width)];
        },
      };
    });
  });
}

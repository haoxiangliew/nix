/**
 * /fast sends `speed: "fast"` to Anthropic Opus and the priority service tier to OpenAI.
 * In the /fast picker, enter applies the choice to this session and ctrl+s also saves it as the
 * default in settings.json.
 * --fast starts with it on.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DynamicBorder,
  getAgentDir,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageEndEvent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

const FAST_BETA = "fast-mode-2026-02-01";

const FAST_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);

// Fast mode bills every token category at twice the standard rate on all FAST_MODELS.
const FAST_COST_MULTIPLIER = 2;

const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);

type Backend = "anthropic" | "openai";

type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

type Cost = AssistantMessage["usage"]["cost"];

interface Settings {
  fastMode?: boolean;
}

interface Choice {
  enabled: boolean;
  persist: boolean;
}

interface OptionState {
  selected: boolean;
  current: boolean;
  saved: boolean;
}

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function readSettings(): Settings {
  const path = settingsPath();

  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function readDefault(): boolean {
  try {
    return readSettings().fastMode === true;
  } catch {
    return false;
  }
}

// Keeps the other keys in settings.json. pi rewrites only the settings it changed, so `fastMode`
// survives pi's own saves.
function writeDefault(value: boolean): void {
  const path = settingsPath();
  const tmp = `${path}.${process.pid}.tmp`;

  writeFileSync(tmp, `${JSON.stringify({ ...readSettings(), fastMode: value }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
}

function backend(model: ExtensionContext["model"]): Backend | undefined {
  if (model?.provider === "anthropic" && FAST_MODELS.has(model.id)) {
    return "anthropic";
  }

  if (model !== undefined && OPENAI_PROVIDERS.has(model.provider)) {
    return "openai";
  }

  return undefined;
}

// pi prices Anthropic replies at standard rates because it ignores `usage.speed`. A fast request
// either runs fast or fails, so a completed reply to one was billed at the fast rate.
function billedFast(message: AssistantMessage): boolean {
  return (
    message.provider === "anthropic" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted" &&
    FAST_MODELS.has(message.responseModel ?? message.model)
  );
}

function fastCost(cost: Cost): Cost {
  const input = cost.input * FAST_COST_MULTIPLIER;
  const output = cost.output * FAST_COST_MULTIPLIER;
  const cacheRead = cost.cacheRead * FAST_COST_MULTIPLIER;
  const cacheWrite = cost.cacheWrite * FAST_COST_MULTIPLIER;

  return {
    ...cost,
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
  };
}

function optionLine(theme: Theme, value: boolean, state: OptionState): string {
  const label = value ? "on" : "off";
  const cursor = state.selected ? theme.fg("accent", "→ ") : "  ";
  const check = state.current ? theme.fg("accent", "✓ ") : "  ";
  const badge = state.saved ? theme.fg("muted", " · default") : "";

  return `${cursor}${check}${state.selected ? theme.fg("accent", label) : label}${badge}`;
}

function pickerFrame(ctx: ExtensionContext, theme: Theme, list: Container): Container {
  const model = ctx.model === undefined ? "no model" : `${ctx.model.provider}/${ctx.model.id}`;
  const support = backend(ctx.model) === undefined ? theme.fg("warning", " (unsupported)") : "";

  const hints = [
    keyHint("tui.select.confirm", "to select"),
    keyHint("app.models.save", "to set as default"),
    keyHint("tui.select.cancel", "to cancel"),
  ].join(theme.fg("dim", " · "));

  const frame = new Container();

  for (const child of [
    new DynamicBorder(),
    new Spacer(1),
    new Text(theme.fg("muted", `Fast mode for ${model}`) + support, 0, 0),
    new Spacer(1),
    list,
    new Spacer(1),
    new Text(`  ${hints}`, 0, 0),
    new DynamicBorder(),
  ]) {
    frame.addChild(child);
  }

  return frame;
}

function pick(ctx: ExtensionContext, enabled: boolean): Promise<Choice | undefined> {
  const savedDefault = readDefault();
  const options = [true, false];

  return ctx.ui.custom<Choice | undefined>((tui, theme, keybindings, done) => {
    let index = options.indexOf(enabled);

    const list = new Container();

    function updateList(): void {
      list.clear();

      for (const [i, value] of options.entries()) {
        const state = {
          selected: i === index,
          current: value === enabled,
          saved: value === savedDefault,
        };

        list.addChild(new Text(optionLine(theme, value, state), 0, 0));
      }
    }

    const container = pickerFrame(ctx, theme, list);

    updateList();

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        if (
          keybindings.matches(data, "tui.select.up") ||
          keybindings.matches(data, "tui.select.down")
        ) {
          index = (index + 1) % options.length;
          updateList();
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          done({ enabled: options[index], persist: false });
        } else if (keybindings.matches(data, "app.models.save")) {
          done({ enabled: options[index], persist: true });
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
        }

        tui.requestRender();
      },
    };
  });
}

function choose(arg: string, ctx: ExtensionContext, enabled: boolean): Promise<Choice | undefined> {
  if (arg === "on" || arg === "off") {
    return Promise.resolve({ enabled: arg === "on", persist: false });
  }

  if (ctx.mode !== "tui") {
    return Promise.resolve({ enabled: !enabled, persist: false });
  }

  return pick(ctx, enabled);
}

// Rewrites outgoing payloads while fast mode is on and bills the replies at the fast rate.
function handleRequests(pi: ExtensionAPI, isEnabled: () => boolean): void {
  // Whether the request in flight asked Anthropic for fast mode.
  let fastRequest = false;

  pi.on("before_provider_request", async (event, ctx) => {
    const target = isEnabled() ? backend(ctx.model) : undefined;
    const { payload } = event;

    fastRequest = false;

    if (target === undefined || !(payload instanceof Object)) {
      return;
    }

    if (target === "openai") {
      return { ...payload, service_tier: "priority" };
    }

    const betas = "betas" in payload && Array.isArray(payload.betas) ? payload.betas : [];

    fastRequest = true;

    return { ...payload, speed: "fast", betas: [...new Set([...betas, FAST_BETA])] };
  });

  pi.on("message_end", async (event) => {
    const { message } = event;

    if (message.role !== "assistant" || !fastRequest) {
      return;
    }

    fastRequest = false;

    if (!billedFast(message)) {
      return;
    }

    return {
      message: { ...message, usage: { ...message.usage, cost: fastCost(message.usage.cost) } },
    };
  });
}

export default function (pi: ExtensionAPI) {
  let enabled = false;

  handleRequests(pi, () => enabled);

  pi.registerFlag("fast", {
    description: "Start in fast mode (Anthropic Opus, OpenAI)",
    type: "boolean",
    default: false,
  });

  function apply(ctx: ExtensionContext): void {
    const status =
      backend(ctx.model) === undefined
        ? ctx.ui.theme.fg("muted", "fast (unsupported model)")
        : ctx.ui.theme.fg("accent", "fast");

    ctx.ui.setStatus("fast", enabled ? status : undefined);
  }

  pi.registerCommand("fast", {
    description: "Select fast mode (on, off)",
    handler: async (args, ctx) => {
      const choice = await choose(args.trim(), ctx, enabled);

      if (choice === undefined) {
        return;
      }

      enabled = choice.enabled;
      apply(ctx);
      pi.appendEntry("fast-mode", enabled);

      if (choice.persist) {
        writeDefault(enabled);
      }

      ctx.ui.notify(
        `${choice.persist ? "Default fast mode" : "Fast mode"}: ${enabled ? "on" : "off"}`,
      );
    },
  });

  pi.on("model_select", async (_event, ctx) => {
    apply(ctx);
  });

  // Resumed sessions keep their last choice. New sessions use --fast or the saved default.
  pi.on("session_start", async (_event, ctx) => {
    const saved = ctx.sessionManager
      .getEntries()
      .findLast((e) => e.type === "custom" && e.customType === "fast-mode");

    enabled =
      saved?.type === "custom" ? saved.data === true : pi.getFlag("fast") === true || readDefault();
    apply(ctx);
  });
}

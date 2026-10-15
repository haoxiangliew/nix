/**
 * /fast sends `speed: "fast"` to supported Anthropic models and the priority service tier to
 * OpenAI. In the picker, enter applies the choice to this session and ctrl+s also saves it as the
 * default. --fast starts with it on. The `fast` key in settings.json configures it.
 */

import {
  DynamicBorder,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageEndEvent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { loadOrReport, loadSettings, saveSetting } from "./lib/settings.ts";

const Config = Type.Object(
  {
    models: Type.Array(Type.String(), {
      default: ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"],
    }),
    beta: Type.String({ minLength: 1, default: "fast-mode-2026-02-01" }),
    costMultiplier: Type.Number({ minimum: 1, default: 2 }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

const FastMode = Type.Boolean({ default: false });

const Payload = Type.Object({ betas: Type.Optional(Type.Array(Type.String())) });

const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);

type Backend = "anthropic" | "openai";

type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

type Cost = AssistantMessage["usage"]["cost"];

interface Choice {
  enabled: boolean;
  persist: boolean;
}

interface OptionState {
  selected: boolean;
  current: boolean;
  saved: boolean;
}

function readDefault(): boolean {
  return loadSettings("fastMode", FastMode);
}

function backend(model: ExtensionContext["model"], config: Config): Backend | undefined {
  if (model?.provider === "anthropic" && config.models.includes(model.id)) {
    return "anthropic";
  }

  if (model !== undefined && OPENAI_PROVIDERS.has(model.provider)) {
    return "openai";
  }

  return undefined;
}

// Pi ignores usage.speed when pricing replies. A fast request either runs fast or fails, so
// Anthropic bills a completed reply at the fast rate.
function billedFast(message: AssistantMessage, config: Config): boolean {
  return (
    message.provider === "anthropic" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted" &&
    config.models.includes(message.responseModel ?? message.model)
  );
}

function fastCost(cost: Cost, multiplier: number): Cost {
  const input = cost.input * multiplier;
  const output = cost.output * multiplier;
  const cacheRead = cost.cacheRead * multiplier;
  const cacheWrite = cost.cacheWrite * multiplier;

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

function pickerFrame(
  ctx: ExtensionContext,
  config: Config,
  theme: Theme,
  list: Container,
): Container {
  const model = ctx.model === undefined ? "no model" : `${ctx.model.provider}/${ctx.model.id}`;

  const support =
    backend(ctx.model, config) === undefined ? theme.fg("warning", " (unsupported)") : "";

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

function pick(
  ctx: ExtensionContext,
  config: Config,
  enabled: boolean,
): Promise<Choice | undefined> {
  const savedDefault = readDefault();
  const options = [true, false];

  return ctx.ui.custom<Choice | undefined>((tui, theme, keybindings, done) => {
    let selected = enabled;

    const list = new Container();

    function updateList(): void {
      list.clear();

      for (const value of options) {
        const state = {
          selected: value === selected,
          current: value === enabled,
          saved: value === savedDefault,
        };

        list.addChild(new Text(optionLine(theme, value, state), 0, 0));
      }
    }

    const container = pickerFrame(ctx, config, theme, list);

    updateList();

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        if (
          keybindings.matches(data, "tui.select.up") ||
          keybindings.matches(data, "tui.select.down")
        ) {
          selected = !selected;
          updateList();
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          done({ enabled: selected, persist: false });
        } else if (keybindings.matches(data, "app.models.save")) {
          done({ enabled: selected, persist: true });
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
        }

        tui.requestRender();
      },
    };
  });
}

function choose(
  arg: string,
  ctx: ExtensionContext,
  config: Config,
  enabled: boolean,
): Promise<Choice | undefined> {
  if (arg === "on" || arg === "off") {
    return Promise.resolve({ enabled: arg === "on", persist: false });
  }

  if (arg !== "") {
    ctx.ui.notify(`Unknown /fast argument "${arg}". Use on or off.`, "error");

    return Promise.resolve(undefined);
  }

  if (ctx.mode !== "tui") {
    return Promise.resolve({ enabled: !enabled, persist: false });
  }

  return pick(ctx, config, enabled);
}

function handleRequests(pi: ExtensionAPI, current: () => Config | undefined): void {
  // The config of the request in flight. /fast can change current() before the reply ends.
  let fastConfig: Config | undefined;

  pi.on("before_provider_request", async (event, ctx) => {
    const config = current();
    const { payload } = event;

    fastConfig = undefined;

    if (config === undefined || !Value.Check(Payload, payload)) {
      return;
    }

    const target = backend(ctx.model, config);

    if (target === undefined) {
      return;
    }

    // Mutate in place so compaction.ts records these changes regardless of handler order.
    if (target === "openai") {
      return Object.assign(payload, { service_tier: "priority" });
    }

    const betas = payload.betas ?? [];

    fastConfig = config;

    return Object.assign(payload, { speed: "fast", betas: [...new Set([...betas, config.beta])] });
  });

  pi.on("message_end", async (event) => {
    const { message } = event;
    const config = fastConfig;

    if (message.role !== "assistant" || config === undefined) {
      return;
    }

    fastConfig = undefined;

    if (!billedFast(message, config)) {
      return;
    }

    const cost = fastCost(message.usage.cost, config.costMultiplier);

    return { message: { ...message, usage: { ...message.usage, cost } } };
  });
}

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let config: Config | undefined;

  handleRequests(pi, () => (enabled ? config : undefined));

  pi.registerFlag("fast", {
    description: "Start in fast mode (Anthropic Opus, OpenAI)",
    type: "boolean",
    default: false,
  });

  function apply(ctx: ExtensionContext): void {
    if (config === undefined) {
      return;
    }

    const status =
      backend(ctx.model, config) === undefined
        ? ctx.ui.theme.fg("muted", "fast (unsupported model)")
        : ctx.ui.theme.fg("accent", "fast");

    ctx.ui.setStatus("fast", enabled ? status : undefined);
  }

  pi.registerCommand("fast", {
    description: "Select fast mode (on, off)",
    handler: async (args, ctx) => {
      if (config === undefined) {
        ctx.ui.notify("Fast mode is off because `fast` in settings.json is invalid.", "error");

        return;
      }

      const choice = await choose(args.trim(), ctx, config, enabled);

      if (choice === undefined) {
        return;
      }

      enabled = choice.enabled;
      apply(ctx);
      pi.appendEntry("fast-mode", enabled);

      if (choice.persist) {
        saveSetting("fastMode", enabled);
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
    config = loadOrReport(ctx, "Fast mode", "fast", Config);

    if (config === undefined) {
      enabled = false;
      ctx.ui.setStatus("fast", undefined);

      return;
    }

    const saved = ctx.sessionManager
      .getEntries()
      .findLast((e) => e.type === "custom" && e.customType === "fast-mode");

    enabled =
      saved?.type === "custom" ? saved.data === true : pi.getFlag("fast") === true || readDefault();
    apply(ctx);
  });
}

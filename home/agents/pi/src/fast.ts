/**
 * /fast picks a speed. Fast sends `speed: "fast"` to supported Anthropic models and the priority
 * service tier to OpenAI. Ultrafast sends OpenAI's ultrafast service tier to the models that
 * support it and the fast speed to other models. In the picker, enter applies the speed to this
 * session and ctrl+s also saves it as the default. --fast and --ultrafast start with that speed.
 * The `fast` key in settings.json configures it.
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
      default: ["claude-fable-5-2", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"],
    }),
    beta: Type.String({ minLength: 1, default: "fast-mode-2026-02-01" }),
    costMultiplier: Type.Number({ minimum: 1, default: 2 }),
    ultrafastModels: Type.Array(Type.String(), {
      default: ["gpt-6.2-astra", "gpt-6.2-sol"],
    }),
    ultrafastCostMultiplier: Type.Number({ minimum: 1, default: 6 }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

const SPEEDS = ["off", "fast", "ultrafast"] as const;

type Speed = (typeof SPEEDS)[number];

// Settings and session entries saved before ultrafast hold true for fast and false for off.
const FastMode = Type.Union(
  [Type.Boolean(), Type.Literal("off"), Type.Literal("fast"), Type.Literal("ultrafast")],
  { default: "off" },
);

const Payload = Type.Object({ betas: Type.Optional(Type.Array(Type.String())) });

// The last event of an OpenAI response. Its service_tier is the tier that served the reply, which
// can differ from the requested tier.
const ResponseDone = Type.Object({
  type: Type.Union([
    Type.Literal("response.completed"),
    Type.Literal("response.incomplete"),
    Type.Literal("response.done"),
  ]),
  response: Type.Object({ service_tier: Type.String() }),
});

const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);

// "anthropic" is Anthropic's fast mode. The others are OpenAI service tiers.
type Tier = "anthropic" | "priority" | "ultrafast";

type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

type Cost = AssistantMessage["usage"]["cost"];

interface Choice {
  speed: Speed;
  persist: boolean;
}

interface OptionState {
  selected: boolean;
  current: boolean;
  saved: boolean;
}

// The request in flight. It keeps its own config and tier because /fast can change the speed
// before the reply ends.
interface Request {
  config: Config;
  tier: Tier;
  served?: string;
}

const NEXT: Record<Speed, Speed> = { off: "fast", fast: "ultrafast", ultrafast: "off" };

const PREVIOUS: Record<Speed, Speed> = { off: "ultrafast", fast: "off", ultrafast: "fast" };

function toSpeed(value: Static<typeof FastMode>): Speed {
  if (value === true) {
    return "fast";
  }

  if (value === false) {
    return "off";
  }

  return value;
}

function readDefault(): Speed {
  return toSpeed(loadSettings("fastMode", FastMode));
}

function tierFor(model: ExtensionContext["model"], config: Config, speed: Speed): Tier | undefined {
  if (speed === "off" || model === undefined) {
    return undefined;
  }

  if (model.provider === "anthropic") {
    return config.models.includes(model.id) ? "anthropic" : undefined;
  }

  if (!OPENAI_PROVIDERS.has(model.provider)) {
    return undefined;
  }

  return speed === "ultrafast" && config.ultrafastModels.includes(model.id)
    ? "ultrafast"
    : "priority";
}

function tierLabel(tier: Tier): Speed {
  return tier === "ultrafast" ? "ultrafast" : "fast";
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

function scaleCost(cost: Cost, multiplier: number): Cost {
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

// The multiple of pi's price that the reply cost, or undefined if pi priced it right.
function multiplierFor(message: AssistantMessage, request: Request): number | undefined {
  const { config, tier, served } = request;

  if (tier === "anthropic") {
    return billedFast(message, config) ? config.costMultiplier : undefined;
  }

  // Pi prices an ultrafast reply at the standard rate.
  return served === "ultrafast" ? config.ultrafastCostMultiplier : undefined;
}

function optionLine(
  theme: Theme,
  speed: Speed,
  state: OptionState,
  tier: Tier | undefined,
): string {
  const cursor = state.selected ? theme.fg("accent", "→ ") : "  ";
  const check = state.current ? theme.fg("accent", "✓ ") : "  ";
  const label = state.selected ? theme.fg("accent", speed) : speed;

  const fallback =
    speed === "ultrafast" && tier !== undefined && tier !== "ultrafast"
      ? theme.fg("muted", " · fast on this model")
      : "";

  const badge = state.saved ? theme.fg("muted", " · default") : "";

  return `${cursor}${check}${label}${fallback}${badge}`;
}

function pickerFrame(
  ctx: ExtensionContext,
  config: Config,
  theme: Theme,
  list: Container,
): Container {
  const model = ctx.model === undefined ? "no model" : `${ctx.model.provider}/${ctx.model.id}`;

  const support =
    tierFor(ctx.model, config, "fast") === undefined ? theme.fg("warning", " (unsupported)") : "";

  const hints = [
    keyHint("tui.select.confirm", "to select"),
    keyHint("app.models.save", "to set as default"),
    keyHint("tui.select.cancel", "to cancel"),
  ].join(theme.fg("dim", " · "));

  const frame = new Container();

  for (const child of [
    new DynamicBorder(),
    new Spacer(1),
    new Text(theme.fg("muted", `Speed for ${model}`) + support, 0, 0),
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

function pick(ctx: ExtensionContext, config: Config, current: Speed): Promise<Choice | undefined> {
  const savedDefault = readDefault();

  return ctx.ui.custom<Choice | undefined>((tui, theme, keybindings, done) => {
    let selected = current;

    const list = new Container();

    function updateList(): void {
      list.clear();

      for (const speed of SPEEDS) {
        const state = {
          selected: speed === selected,
          current: speed === current,
          saved: speed === savedDefault,
        };

        list.addChild(
          new Text(optionLine(theme, speed, state, tierFor(ctx.model, config, speed)), 0, 0),
        );
      }
    }

    const container = pickerFrame(ctx, config, theme, list);

    updateList();

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.up")) {
          selected = PREVIOUS[selected];
          updateList();
        } else if (keybindings.matches(data, "tui.select.down")) {
          selected = NEXT[selected];
          updateList();
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          done({ speed: selected, persist: false });
        } else if (keybindings.matches(data, "app.models.save")) {
          done({ speed: selected, persist: true });
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
  current: Speed,
): Promise<Choice | undefined> {
  const speed = arg === "on" ? "fast" : SPEEDS.find((s) => s === arg);

  if (speed !== undefined) {
    return Promise.resolve({ speed, persist: false });
  }

  if (arg !== "") {
    ctx.ui.notify(`Unknown /fast argument "${arg}". Use on, off, fast, or ultrafast.`, "error");

    return Promise.resolve(undefined);
  }

  if (ctx.mode !== "tui") {
    return Promise.resolve({ speed: current === "off" ? "fast" : "off", persist: false });
  }

  return pick(ctx, config, current);
}

function handleRequests(pi: ExtensionAPI, current: () => [Config, Speed] | undefined): void {
  let request: Request | undefined;

  pi.on("before_provider_request", async (event, ctx) => {
    const settings = current();
    const { payload } = event;

    request = undefined;

    if (settings === undefined || !Value.Check(Payload, payload)) {
      return;
    }

    const [config, speed] = settings;
    const tier = tierFor(ctx.model, config, speed);

    if (tier === undefined) {
      return;
    }

    request = { config, tier };

    // Mutate in place so compaction.ts records these changes regardless of handler order.
    if (tier !== "anthropic") {
      return Object.assign(payload, { service_tier: tier });
    }

    const betas = payload.betas ?? [];

    return Object.assign(payload, { speed: "fast", betas: [...new Set([...betas, config.beta])] });
  });

  pi.on("provider_stream_event", async (event) => {
    if (request !== undefined && Value.Check(ResponseDone, event.data)) {
      request.served = event.data.response.service_tier;
    }
  });

  pi.on("message_end", async (event) => {
    const { message } = event;

    if (message.role !== "assistant" || request === undefined) {
      return;
    }

    const multiplier = multiplierFor(message, request);

    request = undefined;

    if (multiplier === undefined) {
      return;
    }

    const cost = scaleCost(message.usage.cost, multiplier);

    return { message: { ...message, usage: { ...message.usage, cost } } };
  });
}

export default function (pi: ExtensionAPI) {
  let speed: Speed = "off";
  let config: Config | undefined;

  handleRequests(pi, () => (config === undefined ? undefined : [config, speed]));

  pi.registerFlag("fast", {
    description: "Start in fast mode (Anthropic Fable and Opus, OpenAI)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ultrafast", {
    description: "Start in ultrafast mode (OpenAI GPT-6.2 Astra and Sol, fast on other models)",
    type: "boolean",
    default: false,
  });

  function apply(ctx: ExtensionContext): void {
    if (config === undefined) {
      return;
    }

    const { theme } = ctx.ui;
    const tier = tierFor(ctx.model, config, speed);
    let status: string | undefined;

    if (speed === "off") {
      status = undefined;
    } else if (tier === undefined) {
      status = theme.fg("muted", `${speed} (unsupported model)`);
    } else if (tierLabel(tier) === speed) {
      status = theme.fg("accent", speed);
    } else {
      status = theme.fg("accent", tierLabel(tier)) + theme.fg("muted", ` (no ${speed})`);
    }

    ctx.ui.setStatus("fast", status);
  }

  pi.registerCommand("fast", {
    description: "Select a speed (off, fast, ultrafast)",
    handler: async (args, ctx) => {
      if (config === undefined) {
        ctx.ui.notify("Fast mode is off because `fast` in settings.json is invalid.", "error");

        return;
      }

      const choice = await choose(args.trim(), ctx, config, speed);

      if (choice === undefined) {
        return;
      }

      speed = choice.speed;
      apply(ctx);
      pi.appendEntry("fast-mode", speed);

      if (choice.persist) {
        saveSetting("fastMode", speed);
      }

      ctx.ui.notify(`${choice.persist ? "Default speed" : "Speed"}: ${speed}`);
    },
  });

  pi.on("model_select", async (_event, ctx) => {
    apply(ctx);
  });

  function startSpeed(): Speed {
    if (pi.getFlag("ultrafast") === true) {
      return "ultrafast";
    }

    return pi.getFlag("fast") === true ? "fast" : readDefault();
  }

  // Resumed sessions and /tree use the branch's last choice. A branch without one uses --ultrafast,
  // --fast, or the saved default.
  function restore(ctx: ExtensionContext): void {
    const saved = ctx.sessionManager
      .getBranch()
      .findLast((e) => e.type === "custom" && e.customType === "fast-mode");

    if (saved?.type !== "custom") {
      speed = startSpeed();
    } else if (Value.Check(FastMode, saved.data)) {
      speed = toSpeed(saved.data);
    } else {
      throw new Error(`fast-mode session entry holds ${JSON.stringify(saved.data)}`);
    }

    apply(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    config = loadOrReport(ctx, "Fast mode", "fast", Config);

    if (config === undefined) {
      speed = "off";
      ctx.ui.setStatus("fast", undefined);

      return;
    }

    restore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (config !== undefined) {
      restore(ctx);
    }
  });
}

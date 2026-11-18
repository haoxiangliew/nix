/**
 * /fast picks a speed. Fast sends `speed: "fast"` to supported Anthropic models and the priority
 * service tier to OpenAI. Ultrafast sends OpenAI's ultrafast service tier and Anthropic's fast
 * mode. On openai-codex, the account's model catalog decides which tiers a model gets. Each
 * model keeps its own speed in settings.json. --fast and --ultrafast set every model's speed until
 * /fast changes one. The `fast` key in settings.json configures it.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

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

import { errorMessage, loadOrReport, loadSettings, saveSetting } from "./lib/settings.ts";

const Config = Type.Object(
  {
    models: Type.Array(Type.String(), {
      default: ["claude-fable-5-2", "claude-opus-5-5"],
    }),
    beta: Type.String({ minLength: 1, default: "fast-mode-2026-02-01" }),
    costMultiplier: Type.Number({ minimum: 1, default: 2 }),
    // openai models with ultrafast. Other openai models get fast.
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

const SpeedSetting = Type.Enum(SPEEDS);

const SpeedByModel = Type.Record(Type.String(), SpeedSetting);

// Speeds by `provider/id`. Older settings hold one speed for every model: true for fast, false for
// off, or a speed.
const FastMode = Type.Union([SpeedByModel, Type.Boolean(), SpeedSetting], { default: {} });

declare global {
  // Set once /fast changes a speed. It outlasts the extension reload on /new and /resume, so
  // --fast and --ultrafast stop applying for the rest of the process.
  var fastFlagsCleared: boolean | undefined;
}

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

// "anthropic" is Anthropic's fast mode. The others are OpenAI service tiers.
type Tier = "anthropic" | "priority" | "ultrafast";

// The service tiers the openai-codex account can request, by model id.
type Tiers = ReadonlyMap<string, ReadonlySet<string>>;

type Catalog = (ctx: ExtensionContext, model: Model<Api>) => Promise<Tiers>;

const CodexModels = Type.Object({
  models: Type.Array(
    Type.Object({
      slug: Type.String(),
      service_tiers: Type.Optional(Type.Array(Type.Object({ id: Type.String() }))),
    }),
  ),
});

const CODEX_RELEASE_URL = "https://registry.npmjs.org/@openai/codex/latest";

const NpmRelease = Type.Object({ version: Type.String({ minLength: 1 }) });

const JWT_CLAIM = "https://api.openai.com/auth";

const AccessToken = Type.Object({
  [JWT_CLAIM]: Type.Object({ chatgpt_account_id: Type.String({ minLength: 1 }) }),
});

// Codex refreshes its catalog after this long.
const CATALOG_TTL_MS = 5 * 60_000;

// Requests reuse a failed download's error for this long, so they don't each wait during an outage.
const CATALOG_RETRY_MS = 30_000;

const CATALOG_TIMEOUT_MS = 5_000;

type Speeds = Record<Speed, Tier | undefined>;

type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

type Cost = AssistantMessage["usage"]["cost"];

interface OptionState {
  selected: boolean;
  current: boolean;
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

function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function savedSpeed(model: Model<Api>): Speed {
  const saved = loadSettings("fastMode", FastMode);

  if (Value.Check(SpeedByModel, saved)) {
    return saved[modelKey(model)] ?? "off";
  }

  if (saved === true) {
    return "fast";
  }

  return saved === false ? "off" : saved;
}

// Replaces an older setting for every model, so the other models go back to off.
function saveSpeed(model: Model<Api>, speed: Speed): void {
  const saved = loadSettings("fastMode", FastMode);
  const speeds = Value.Check(SpeedByModel, saved) ? { ...saved } : {};

  if (speed === "off") {
    delete speeds[modelKey(model)];
  } else {
    speeds[modelKey(model)] = speed;
  }

  saveSetting("fastMode", speeds);
}

function accountId(token: string): string {
  const [, payload] = token.split(".");

  const claims: unknown =
    payload === undefined ? undefined : JSON.parse(Buffer.from(payload, "base64url").toString());

  if (!Value.Check(AccessToken, claims)) {
    throw new Error("The openai-codex login has no ChatGPT account ID");
  }

  return claims[JWT_CLAIM].chatgpt_account_id;
}

async function latestCodexVersion(): Promise<string> {
  const response = await fetch(CODEX_RELEASE_URL, {
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`npm returned HTTP ${response.status} for the latest Codex release`);
  }

  const body: unknown = await response.json();

  if (!Value.Check(NpmRelease, body)) {
    throw new Error("npm returned an unexpected format for the latest Codex release");
  }

  return body.version;
}

async function downloadTiers(
  url: string,
  headers: Headers,
  version: string,
): Promise<Map<string, Set<string>>> {
  const response = await fetch(`${url}?client_version=${encodeURIComponent(version)}`, {
    headers,
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`The openai-codex model catalog returned HTTP ${response.status}`);
  }

  const body: unknown = await response.json();

  if (!Value.Check(CodexModels, body)) {
    throw new Error("The openai-codex model catalog has an unexpected format");
  }

  return new Map(
    body.models.map(({ slug, service_tiers = [] }) => [
      slug,
      new Set(service_tiers.map((t) => t.id)),
    ]),
  );
}

// Follows pi-ai's resolveCodexUrl, which accepts a base URL with or without /codex.
function catalogUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/codex\/responses$/, "/codex");

  return `${base.endsWith("/codex") ? base : `${base}/codex`}/models`;
}

interface CatalogRequest {
  account: string;
  url: string;
  headers: Headers;
}

async function catalogRequest(ctx: ExtensionContext, model: Model<Api>): Promise<CatalogRequest> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);

  if (!auth.ok) {
    throw new Error(auth.error);
  }

  if (auth.apiKey === undefined) {
    throw new Error("openai-codex has no login");
  }

  const account = accountId(auth.apiKey);
  const headers = new Headers();

  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (value !== null) {
      headers.set(name, value);
    }
  }

  headers.set("Authorization", `Bearer ${auth.apiKey}`);
  headers.set("chatgpt-account-id", account);
  headers.set("originator", "pi");

  return { account, url: catalogUrl(auth.baseUrl ?? model.baseUrl), headers };
}

interface CatalogEntry {
  startedAt: number;
  failed: boolean;
  refreshing: boolean;
  tiers: Promise<Tiers>;
}

// Each account's catalog. After the TTL, callers get the old tiers while a new download runs, and
// that download's result replaces them, error or not. A failed entry gives every caller its error
// until CATALOG_RETRY_MS passes. The catalog rejects a request without client_version, so each
// download sends the latest Codex release.
function codexCatalog(): Catalog {
  const entries = new Map<string, CatalogEntry>();
  let version: string | undefined;

  function start({ url, headers }: CatalogRequest): CatalogEntry {
    const tiers = (async () => {
      version ??= await latestCodexVersion();

      return downloadTiers(url, headers, version);
    })();

    const entry: CatalogEntry = { startedAt: Date.now(), failed: false, refreshing: false, tiers };

    // Callers get the error from tiers. This only marks the entry.
    tiers.catch(() => {
      entry.failed = true;
    });

    return entry;
  }

  return async (ctx, model) => {
    const request = await catalogRequest(ctx, model);
    const entry = entries.get(request.account);
    const age = entry === undefined ? Infinity : Date.now() - entry.startedAt;

    if (entry === undefined || (entry.failed && age > CATALOG_RETRY_MS)) {
      const fresh = start(request);

      entries.set(request.account, fresh);

      return fresh.tiers;
    }

    if (!entry.failed && !entry.refreshing && age > CATALOG_TTL_MS) {
      const next = start(request);
      const replace = () => entries.set(request.account, next);

      entry.refreshing = true;
      void next.tiers.then(replace, replace);
    }

    return entry.tiers;
  };
}

async function tierFor(
  ctx: ExtensionContext,
  catalog: Catalog,
  config: Config,
  speed: Speed,
): Promise<Tier | undefined> {
  const { model } = ctx;

  if (speed === "off" || model === undefined) {
    return undefined;
  }

  if (model.provider === "anthropic") {
    return config.models.includes(model.id) ? "anthropic" : undefined;
  }

  if (model.provider === "openai") {
    return speed === "ultrafast" && config.ultrafastModels.includes(model.id)
      ? "ultrafast"
      : "priority";
  }

  if (model.provider !== "openai-codex") {
    return undefined;
  }

  return codexTier((await catalog(ctx, model)).get(model.id) ?? new Set(), speed);
}

function codexTier(tiers: ReadonlySet<string>, speed: Speed): Tier | undefined {
  if (speed === "ultrafast" && tiers.has("ultrafast")) {
    return "ultrafast";
  }

  return tiers.has("priority") ? "priority" : undefined;
}

async function speedsFor(ctx: ExtensionContext, catalog: Catalog, config: Config): Promise<Speeds> {
  return {
    off: undefined,
    fast: await tierFor(ctx, catalog, config, "fast"),
    ultrafast: await tierFor(ctx, catalog, config, "ultrafast"),
  };
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

  return `${cursor}${check}${label}${fallback}`;
}

function supportNote(theme: Theme, speeds: Speeds, failed: boolean): string {
  if (failed) {
    return theme.fg("error", " (catalog failed)");
  }

  return speeds.fast === undefined ? theme.fg("warning", " (unsupported)") : "";
}

function pickerFrame(
  ctx: ExtensionContext,
  speeds: Speeds,
  failed: boolean,
  theme: Theme,
  list: Container,
): Container {
  const model = ctx.model === undefined ? "no model" : `${ctx.model.provider}/${ctx.model.id}`;

  const support = supportNote(theme, speeds, failed);

  const hints = [
    keyHint("tui.select.confirm", "to select"),
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

function pick(
  ctx: ExtensionContext,
  speeds: Speeds,
  current: Speed,
  failed: boolean,
): Promise<Speed | undefined> {
  return ctx.ui.custom<Speed | undefined>((tui, theme, keybindings, done) => {
    let selected = current;

    const list = new Container();

    function updateList(): void {
      list.clear();

      for (const speed of SPEEDS) {
        const state = { selected: speed === selected, current: speed === current };

        list.addChild(new Text(optionLine(theme, speed, state, speeds[speed]), 0, 0));
      }
    }

    const container = pickerFrame(ctx, speeds, failed, theme, list);

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
          done(selected);
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
        }

        tui.requestRender();
      },
    };
  });
}

async function pickWithCatalog(
  ctx: ExtensionContext,
  load: () => Promise<Speeds>,
  current: Speed,
): Promise<Speed | undefined> {
  let speeds: Speeds;
  let failed = false;

  // The tier lookup fails when npm or the catalog is down. The picker shows the error and still
  // opens, so off stays selectable. Requests report the same error.
  try {
    speeds = await load();
  } catch (cause) {
    ctx.ui.notify(errorMessage(cause), "error");
    speeds = { off: undefined, fast: undefined, ultrafast: undefined };
    failed = true;
  }

  return pick(ctx, speeds, current, failed);
}

async function choose(
  arg: string,
  ctx: ExtensionContext,
  speeds: () => Promise<Speeds>,
  current: Speed,
): Promise<Speed | undefined> {
  const speed = arg === "on" ? "fast" : SPEEDS.find((s) => s === arg);

  if (speed !== undefined) {
    return speed;
  }

  if (arg !== "") {
    ctx.ui.notify(`Unknown /fast argument "${arg}". Use on, off, fast, or ultrafast.`, "error");

    return undefined;
  }

  if (ctx.mode !== "tui") {
    return current === "off" ? "fast" : "off";
  }

  return pickWithCatalog(ctx, speeds, current);
}

function statusText(theme: Theme, speed: Speed, tier: Tier | undefined): string | undefined {
  if (speed === "off") {
    return undefined;
  }

  if (tier === undefined) {
    return theme.fg("muted", `${speed} (unsupported model)`);
  }

  if (tierLabel(tier) === speed) {
    return theme.fg("accent", speed);
  }

  return theme.fg("accent", tierLabel(tier)) + theme.fg("muted", ` (no ${speed})`);
}

function handleRequests(
  pi: ExtensionAPI,
  resolve: (ctx: ExtensionContext) => Promise<[Config, Tier | undefined] | undefined>,
): void {
  let request: Request | undefined;

  pi.on("before_provider_request", async (event, ctx) => {
    const settings = await resolve(ctx);
    const { payload } = event;

    request = undefined;

    if (settings === undefined || !Value.Check(Payload, payload)) {
      return;
    }

    const [config, tier] = settings;

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
  let config: Config | undefined;
  // Holds the --fast or --ultrafast speed until /fast changes a model's speed.
  let flagSpeed: Speed | undefined;
  // Counts status updates, so a slow catalog download can't overwrite a newer status.
  let updates = 0;
  const catalog = codexCatalog();

  function speedOf(model: Model<Api> | undefined): Speed {
    return model === undefined ? "off" : (flagSpeed ?? savedSpeed(model));
  }

  // Requests look up their tier through apply, so the footer shows the tier each request sends.
  handleRequests(pi, apply);

  pi.registerFlag("fast", {
    description: "Start in fast mode (Anthropic Fable and Opus, OpenAI)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("ultrafast", {
    description: "Start in ultrafast mode (OpenAI, fast on Anthropic)",
    type: "boolean",
    default: false,
  });

  // Looks up the current model's tier and shows it in the footer.
  async function apply(ctx: ExtensionContext): Promise<[Config, Tier | undefined] | undefined> {
    if (config === undefined) {
      return undefined;
    }

    const settings = config;
    const { theme } = ctx.ui;
    const update = ++updates;
    const speed = speedOf(ctx.model);
    let tier: Tier | undefined;

    try {
      tier = await tierFor(ctx, catalog, settings, speed);
    } catch (error) {
      // Pi reports the rethrown error. The status shows that this speed has no tier.
      if (update === updates) {
        ctx.ui.setStatus("fast", theme.fg("error", `${speed} (catalog failed)`));
      }

      throw error;
    }

    if (update === updates) {
      ctx.ui.setStatus("fast", statusText(theme, speed, tier));
    }

    return [settings, tier];
  }

  // Startup and model switches don't wait for the catalog. Requests share the same download.
  function applyLater(ctx: ExtensionContext): void {
    void apply(ctx)
      .catch((cause: unknown) => ctx.ui.notify(errorMessage(cause), "error"))
      .catch(() => {
        // The session ended before the error notice could show.
      });
  }

  pi.registerCommand("fast", {
    description: "Select a speed (off, fast, ultrafast)",
    handler: async (args, ctx) => {
      if (config === undefined) {
        ctx.ui.notify("Fast mode is off because `fast` in settings.json is invalid.", "error");

        return;
      }

      const { model } = ctx;

      if (model === undefined) {
        ctx.ui.notify("Select a model before setting its speed.", "error");

        return;
      }

      const settings = config;

      const speed = await choose(
        args.trim(),
        ctx,
        () => speedsFor(ctx, catalog, settings),
        speedOf(model),
      );

      if (speed === undefined) {
        return;
      }

      saveSpeed(model, speed);
      globalThis.fastFlagsCleared = true;
      flagSpeed = undefined;
      ctx.ui.notify(`Speed for ${modelKey(model)}: ${speed}`);
      await apply(ctx);
    },
  });

  pi.on("model_select", async (_event, ctx) => {
    applyLater(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    config = loadOrReport(ctx, "Fast mode", "fast", Config);

    if (config === undefined) {
      ctx.ui.setStatus("fast", undefined);

      return;
    }

    if (globalThis.fastFlagsCleared === true) {
      flagSpeed = undefined;
    } else if (pi.getFlag("ultrafast") === true) {
      flagSpeed = "ultrafast";
    } else if (pi.getFlag("fast") === true) {
      flagSpeed = "fast";
    }

    applyLater(ctx);
  });
}

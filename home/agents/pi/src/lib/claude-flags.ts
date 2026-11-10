import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

// Reads the Claude CLI's feature flags the way a normal `claude` run does. The probes point the CLI
// at a local mock, and these flags keep them behaving like that run.

type Environment = Readonly<Record<string, string | undefined>>;

const ClaudeConfig = Type.Object({
  cachedGrowthBookFeatures: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/** "enabled" uses GrowthBook, "disk" only its saved copy, and "off" the built-in defaults. */
type FlagSource = "enabled" | "disk" | "off";

type GateVariable =
  | "CLAUDE_CODE_TETHER_LIVE"
  | "CLAUDE_CODE_HUMBLE_HAMMOCK"
  | "CLAUDE_CODE_STELLAR_DRIFT";

type GateEnvironment = Partial<Record<GateVariable, "0" | "1">>;

export interface ProbeFlags {
  /** Variables the probes add to the CLI's environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Changes when the flags a normal run would use change. */
  readonly key: string;
}

let saved: { stamp: string; features: ReadonlyMap<string, unknown> } | undefined;

// Parses booleans like the CLI. Anything else is unset.
function triBool(value: string | undefined): boolean | undefined {
  const text = value?.toLowerCase().trim();

  if (text !== undefined && ["1", "true", "yes", "on"].includes(text)) {
    return true;
  }

  return text !== undefined && ["0", "false", "no", "off"].includes(text) ? false : undefined;
}

function enabled(value: string | undefined): boolean {
  return triBool(value) === true;
}

// GrowthBook runs unless feature flags or telemetry are off, or a custom OAuth URL is set.
function flagSource(env: Environment): FlagSource {
  const flagsOff =
    enabled(env.CLAUDE_CODE_DISABLE_FEATURE_FLAGS) || enabled(env.DISABLE_GROWTHBOOK);

  const telemetryOff =
    Boolean(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) ||
    Boolean(env.DISABLE_TELEMETRY) ||
    enabled(env.DO_NOT_TRACK);

  if (!flagsOff && !telemetryOff && !customOAuth(env)) {
    return "enabled";
  }

  return !flagsOff && telemetryOff && enabled(env.CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF)
    ? "disk"
    : "off";
}

function customOAuth(env: Environment): boolean {
  return (env.CLAUDE_CODE_CUSTOM_OAUTH_URL?.trim() ?? "") !== "";
}

function isFilled(path: string): boolean {
  const info = statSync(path, { throwIfNoEntry: false });

  return info !== undefined && info.isFile() && info.size > 0;
}

// The CLI keeps using a legacy ~/.claude/.config.json while it has content.
function configPath(env: Environment): string {
  const legacy = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".config.json");

  if (isFilled(legacy)) {
    return legacy;
  }

  const suffix = customOAuth(env) ? "-custom-oauth" : "";

  return join(env.CLAUDE_CONFIG_DIR || homedir(), `.claude${suffix}.json`);
}

function stampOf(path: string): string | undefined {
  const info = statSync(path, { throwIfNoEntry: false });

  return info === undefined ? undefined : `${path}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

// GrowthBook's saved flags. A missing config means none are saved, as in the CLI.
function savedFeatures(env: Environment): ReadonlyMap<string, unknown> {
  const path = configPath(env);

  try {
    const stamp = stampOf(path);

    if (stamp === undefined) {
      return new Map();
    }

    if (saved?.stamp !== stamp) {
      const config: unknown = JSON.parse(readFileSync(path, "utf8"));

      if (!Value.Check(ClaudeConfig, config)) {
        throw new Error("unexpected config shape");
      }

      saved = { stamp, features: new Map(Object.entries(config.cachedGrowthBookFeatures ?? {})) };
    }

    return saved.features;
  } catch (cause) {
    throw new Error(`Claude CLI feature flags in ${path} are unreadable. Request blocked.`, {
      cause,
    });
  }
}

/**
 * The value a normal run reads for `name` from its saved GrowthBook copy when it starts. It is
 * undefined if the value doesn't match `schema`.
 */
export function featureValue<Schema extends TSchema>(
  name: string,
  schema: Schema,
  fallback: Static<Schema>,
  env: Environment = Bun.env,
): Static<Schema> | undefined {
  const value = flagSource(env) === "off" ? fallback : (savedFeatures(env).get(name) ?? fallback);

  return Value.Check(schema, value) ? value : undefined;
}

function isFirstPartyUrl(value: string | undefined): boolean {
  if (!value) {
    return true;
  }

  return URL.parse(value)?.host === "api.anthropic.com";
}

function booleanFeature(name: string, env: Environment): boolean {
  const value = featureValue(name, Type.Boolean(), false, env);

  if (value === undefined) {
    throw new Error(`Claude CLI feature flag ${name} has an unexpected value. Request blocked.`);
  }

  return value;
}

// Like the CLI, the run's own ANTHROPIC_BASE_URL decides first, then tengu_curious_tower. The CLI
// checks its other conditions itself during the probe, such as the provider, experimental betas,
// HIPAA, and ZDR.
function liveGate(env: Environment): boolean {
  return isFirstPartyUrl(env.ANTHROPIC_BASE_URL) && booleanFeature("tengu_curious_tower", env);
}

// CLAUDE_CODE_TETHER_LIVE=1 also turns these on. A normal run reads them from GrowthBook.
const forcedByLiveGate = [
  ["CLAUDE_CODE_HUMBLE_HAMMOCK", "tengu_humble_hammock"],
  ["CLAUDE_CODE_STELLAR_DRIFT", "tengu_stellar_drift"],
] as const;

function gateEnvironment(env: Environment): GateEnvironment {
  if (triBool(env.CLAUDE_CODE_TETHER_LIVE) !== undefined) {
    return {};
  }

  if (!liveGate(env)) {
    return { CLAUDE_CODE_TETHER_LIVE: "0" };
  }

  const added: GateEnvironment = { CLAUDE_CODE_TETHER_LIVE: "1" };

  for (const [variable, feature] of forcedByLiveGate) {
    if (triBool(env[variable]) === undefined && !booleanFeature(feature, env)) {
      added[variable] = "0";
    }
  }

  return added;
}

// Flags that decide the probe environment, which models the CLI threads, or how it continues a
// thread. GrowthBook flips some other flags on each fetch, such as tengu_quiet_badger, and each
// probe fetches, so the key leaves them out.
const keyFlags = [
  "tengu_curious_tower",
  "tengu_humble_hammock",
  "tengu_stellar_drift",
  "tengu_quiet_heron",
  "tengu_twinkly_sunrise",
  "tengu_curious_tower_stateless_models",
];

/**
 * The probes point ANTHROPIC_BASE_URL at a local mock, which turns the CLI's message-thread gate
 * off. So they set CLAUDE_CODE_TETHER_LIVE, CLAUDE_CODE_HUMBLE_HAMMOCK and
 * CLAUDE_CODE_STELLAR_DRIFT to what a normal run would compute, unless the user already set them.
 */
export function readProbeFlags(env: Environment = Bun.env): ProbeFlags {
  const source = flagSource(env);
  const added = gateEnvironment(env);
  const flags = keyFlags.map((name) => featureValue(name, Type.Unknown(), null, env));

  return { env: added, key: JSON.stringify({ source, added, flags }) };
}

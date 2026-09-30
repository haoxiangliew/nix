/**
 * Extension settings, stored under top-level keys of pi's settings.json and validated against a
 * TypeBox schema. Unknown keys and invalid values are errors, so a typo turns the extension off.
 * pi skips this directory because it has no index.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

type SettingsError = ReturnType<typeof Value.Errors>[number];

const SettingsFile = Type.Object({});

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function readSettings(): Static<typeof SettingsFile> {
  const path = settingsPath();
  const settings: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};

  if (!Value.Check(SettingsFile, settings)) {
    throw new Error("settings.json must hold a JSON object");
  }

  return settings;
}

// "/context/threadTokens" becomes "context.threadTokens".
function describe(error: SettingsError): string[] {
  const at = error.instancePath.slice(1).replaceAll("/", ".");

  if (error.keyword === "additionalProperties") {
    return error.params.additionalProperties.map(
      (key) => `unknown key ${at ? `${at}.` : ""}${key}`,
    );
  }

  if (error.keyword === "enum") {
    return [`${at} must be one of ${error.params.allowedValues.join(", ")}`];
  }

  return [at ? `${at} ${error.message}` : error.message];
}

// The schema's defaults fill whatever settings.json leaves out, so every schema needs a `default`.
export function loadSettings<S extends TSchema>(key: string, schema: S): Static<S> {
  const stored = Value.Pointer.Get(readSettings(), `/${key}`);
  const value: unknown = Value.Default(schema, structuredClone(stored));

  if (Value.Check(schema, value)) {
    return value;
  }

  // An unknown key also fails as a `false` schema, which additionalProperties already reports.
  const problems = Value.Errors(schema, value)
    .filter((error) => error.keyword !== "boolean")
    .flatMap(describe);

  throw new Error(`${key} in settings.json: ${problems.join("; ")}`);
}

// Returns undefined after showing the error, so the caller stays off.
export function loadOrReport<S extends TSchema>(
  ctx: ExtensionContext,
  name: string,
  key: string,
  schema: S,
): Static<S> | undefined {
  try {
    return loadSettings(key, schema);
  } catch (error) {
    ctx.ui.notify(`${name} is off. ${errorMessage(error)}`, "error");

    return undefined;
  }
}

// Keeps the other keys. pi rewrites only the settings it changed, so this one survives pi's saves.
export function saveSetting(key: string, value: boolean): void {
  const path = settingsPath();
  const tmp = `${path}.${process.pid}.tmp`;
  const settings = readSettings();

  Value.Pointer.Set(settings, `/${key}`, value);
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

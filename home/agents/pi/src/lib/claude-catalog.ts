import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { ClaudeIdentity } from "./claude-identity.ts";

import { isUuid } from "./billing-fields.ts";
import { billingFilePath, writePrivateFile } from "./files.ts";

// The interactive CLI fetches this list for its model picker. `claude --print` doesn't, so the
// profile probe never sees this request, and its headers follow the CLI's source instead.
const SURFACE = "cc";
const CLIENT_PLATFORM = "claude_code_cli";
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1_048_576;

/** The CLI refetches on each launch and treats a list older than this as stale. */
export const CATALOG_TTL_MS = 60 * 60 * 1000;

// One line of printable text, as the CLI requires of the names and badges it shows.
const Label = Type.String({ minLength: 1, maxLength: 80, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });

const Count = Type.Integer({ minimum: 1 });

const Row = Type.Object({
  id: Type.String({ pattern: "^claude-[a-z0-9-]+$" }),
  name: Label,
  disabled: Type.Optional(Type.Boolean()),
  section: Type.Optional(Type.String()),
  offered_on: Type.Optional(Type.Array(Type.String())),
  program_badge: Type.Optional(Type.Unknown()),
  runtime: Type.Optional(
    Type.Object({
      max_input_tokens: Type.Optional(Count),
      max_output_tokens: Type.Optional(Count),
      capabilities: Type.Optional(Type.Array(Type.String())),
    }),
  ),
});

type Row = Static<typeof Row>;

const Badge = Type.Object({ message: Label, variant: Type.Optional(Type.String()) });

const Body = Type.Object({
  model_selector_config: Type.Optional(
    Type.Array(
      Type.Object({ id: Type.String(), models: Type.Optional(Type.Array(Type.Unknown())) }),
    ),
  ),
});

const Denial = Type.Object({
  error: Type.Object({ details: Type.Object({ error_code: Type.String() }) }),
});

// A 403 with one of these codes means the token can't read the list.
const NARROWED_TOKEN = new Set(["oauth_scope_insufficient", "oauth_token_narrowed"]);

const CatalogModel = Type.Object({
  id: Type.String(),
  name: Type.String(),
  badge: Type.Optional(Type.Object({ message: Type.String(), warning: Type.Boolean() })),
  contextWindow: Type.Optional(Count),
  maxTokens: Type.Optional(Count),
  /** The API answers this model's safety refusals with another model, as with Fable. */
  refusalFallback: Type.Boolean(),
});

export type CatalogModel = Static<typeof CatalogModel>;

// Holds no account, organization, or token values. `scope` is a hash of the account and
// organization, so pi can tell which login the catalog belongs to.
const Catalog = Type.Object({
  scope: Type.String(),
  fetchedAt: Type.Integer({ minimum: 0 }),
  etag: Type.Optional(Type.String()),
  models: Type.Array(CatalogModel),
});

export type Catalog = Static<typeof Catalog>;

const savedPath = () => billingFilePath("model-catalog.json");

function readSavedText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    // No refresh has saved a catalog yet.
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return undefined;
    }

    throw cause;
  }
}

/** The catalog the last refresh saved, if any. Throws if the file can't be read or is invalid. */
export function readSavedCatalog(): Catalog | undefined {
  const path = savedPath();
  const text = readSavedText(path);

  if (text === undefined) {
    return undefined;
  }

  let saved: unknown;

  try {
    saved = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${path} isn't valid JSON`, { cause });
  }

  if (!Value.Check(Catalog, saved)) {
    throw new Error(`${path} has an unexpected format`);
  }

  return saved;
}

export function saveCatalog(catalog: Catalog): void {
  writePrivateFile(savedPath(), JSON.stringify(catalog));
}

export function deleteSavedCatalog(): void {
  rmSync(savedPath(), { force: true });
}

function organization(identity: ClaudeIdentity): string {
  const org = identity.organizationId.toLowerCase();

  if (!isUuid(org)) {
    throw new Error("the Claude CLI's organization ID isn't a UUID");
  }

  return org;
}

export function catalogScope(identity: ClaudeIdentity): string {
  return createHash("sha256")
    .update(`${organization(identity)}:${identity.profile.metadataUserId.account_uuid}`)
    .digest("hex");
}

// The probe runs `claude --print`, whose user agent names the sdk-cli entrypoint. The interactive
// CLI, which fetches the catalog, names cli.
function cliUserAgent(identity: ClaudeIdentity): string {
  if (
    identity.profile.headers["user-agent"] !== `claude-cli/${identity.version} (external, sdk-cli)`
  ) {
    throw new Error("the Claude CLI's user agent format changed");
  }

  return `claude-cli/${identity.version} (external, cli)`;
}

function displayName(name: string): string {
  return name.startsWith("Claude ") ? name : `Claude ${name}`;
}

// Like the CLI, ignores a badge it can't read and keeps the model.
function catalogModel(row: Row): CatalogModel {
  const badge = Value.Check(Badge, row.program_badge) ? row.program_badge : undefined;
  const runtime = row.runtime;

  return {
    id: row.id,
    name: displayName(row.name),
    ...(badge && { badge: { message: badge.message, warning: badge.variant === "warning" } }),
    ...(runtime?.max_input_tokens && { contextWindow: runtime.max_input_tokens }),
    ...(runtime?.max_output_tokens && { maxTokens: runtime.max_output_tokens }),
    refusalFallback: runtime?.capabilities?.includes("refusal_fallback") === true,
  };
}

// Stops reading once the body passes MAX_BYTES, which cancels the response.
async function readLimited(body: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of body) {
    size += chunk.byteLength;

    if (size > MAX_BYTES) {
      throw new Error("the model catalog is too large");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

// Like the CLI, skips disabled and deprecated rows, and rows not offered on Anthropic's own API.
function listed(row: Row): boolean {
  return (
    row.disabled !== true &&
    row.section !== "deprecated" &&
    (row.offered_on?.includes("first_party") ?? true)
  );
}

// Like the CLI, skips invalid rows. A response without the cc list has no models, so the saved ones
// are dropped.
async function readCatalog(response: Response): Promise<CatalogModel[]> {
  if (response.body === null) {
    throw new Error("the model catalog response has no body");
  }

  const body: unknown = JSON.parse(await readLimited(response.body));

  if (!Value.Check(Body, body)) {
    throw new Error("the model catalog has an unexpected format");
  }

  const rows = body.model_selector_config?.find((config) => config.id === SURFACE)?.models ?? [];

  return rows.flatMap((row) => (Value.Check(Row, row) && listed(row) ? [catalogModel(row)] : []));
}

async function denialCode(response: Response): Promise<string | undefined> {
  if (response.body === null) {
    return undefined;
  }

  const text = await readLimited(response.body);
  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch (cause) {
    throw new Error("the model catalog returned HTTP 403 with a body that isn't JSON", { cause });
  }

  return Value.Check(Denial, body) ? body.error.details.error_code : undefined;
}

// Like the CLI, clears the badges but keeps the models when the token can't read the list.
async function deniedModels(
  response: Response,
  previous: Catalog | undefined,
): Promise<CatalogModel[]> {
  const failure = new Error(`the model catalog returned HTTP ${response.status}`);

  if (response.status !== 403) {
    await response.body?.cancel();
    throw failure;
  }

  const code = await denialCode(response);

  if (code === undefined || !NARROWED_TOKEN.has(code)) {
    throw failure;
  }

  return (previous?.models ?? []).map((model) => {
    const { badge: _, ...rest } = model;

    return rest;
  });
}

// The headers of the CLI's request for a claude.ai account, in its order.
function catalogHeaders(identity: ClaudeIdentity, token: string, etag: string | undefined) {
  const headers = new Headers({
    accept: "application/json, text/plain, */*",
    "user-agent": cliUserAgent(identity),
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-client-platform": CLIENT_PLATFORM,
    "x-organization-uuid": organization(identity),
  });

  if (etag !== undefined) {
    headers.set("if-none-match", etag);
  }

  return headers;
}

/**
 * Fetches the account's model catalog as the interactive CLI does. It revalidates `previous`, which
 * must belong to the same login.
 */
export async function fetchCatalog(
  identity: ClaudeIdentity,
  token: string,
  previous: Catalog | undefined,
): Promise<Catalog> {
  const scope = catalogScope(identity);
  const etag = previous?.etag;

  const response = await fetch(
    new URL(
      `/api/organizations/${organization(identity)}/model_selector/${SURFACE}`,
      identity.origin,
    ),
    {
      headers: catalogHeaders(identity, token, etag),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  const fetchedAt = Date.now();

  if (response.status === 304 && previous !== undefined && etag !== undefined) {
    return { ...previous, fetchedAt };
  }

  if (!response.ok) {
    return { scope, fetchedAt, models: await deniedModels(response, previous) };
  }

  const models = await readCatalog(response);
  const next = response.headers.get("etag");

  return { scope, fetchedAt, ...(next !== null && { etag: next }), models };
}

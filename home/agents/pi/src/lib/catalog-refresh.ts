import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ClaudeIdentity } from "./claude-identity.ts";

import { assertAccount, targetOrigin } from "./anthropic-billing.ts";
import { catalogBadge, catalogProvider } from "./catalog-models.ts";
import {
  CATALOG_TTL_MS,
  catalogScope,
  deleteSavedCatalog,
  fetchCatalog,
  readSavedCatalog,
  saveCatalog,
  type Catalog,
} from "./claude-catalog.ts";
import { offline } from "./offline.ts";
import { errorMessage } from "./settings.ts";

const STATUS = "cvp";
const RETRY_MS = 5 * 60 * 1000;

type Registry = ExtensionContext["modelRegistry"];

interface Refresh {
  scope: string;
  startedAt: number;
  failed: boolean;
  result: Promise<Catalog>;
}

// Sessions in one process, such as subagents', share a refresh.
let latest: Refresh | undefined;

// True when the CLI switched logins during this catalog's refresh and the new login's refresh has
// started.
function superseded(catalog: Catalog): boolean {
  return latest !== undefined && latest.scope !== catalog.scope;
}

function usesOAuth(registry: Registry): boolean {
  const model = registry.getAll().find(({ provider }) => provider === "anthropic");

  return model !== undefined && registry.isUsingOAuth(model);
}

function reusable(refresh: Refresh | undefined, scope: string): refresh is Refresh {
  const wait = refresh?.failed === true ? RETRY_MS : CATALOG_TTL_MS;

  return refresh?.scope === scope && Date.now() - refresh.startedAt < wait;
}

function sharedRefresh(scope: string, load: () => Promise<Catalog>): Promise<Catalog> {
  if (reusable(latest, scope)) {
    return latest.result;
  }

  const refresh: Refresh = { scope, startedAt: Date.now(), failed: false, result: load() };
  latest = refresh;

  // Starts the retry delay. Callers get the error from `result`.
  refresh.result.catch(() => {
    refresh.failed = true;
  });

  return refresh.result;
}

async function oauthToken(registry: Registry, model: Model<Api>): Promise<string> {
  const auth = await registry.getApiKeyAndHeaders(model);

  if (!auth.ok) {
    throw new Error(auth.error);
  }

  if (auth.apiKey?.startsWith("sk-ant-oat") !== true) {
    throw new Error("pi has no Anthropic OAuth token");
  }

  return auth.apiKey;
}

async function download(
  registry: Registry,
  model: Model<Api>,
  identity: ClaudeIdentity,
  previous: Catalog | undefined,
): Promise<Catalog> {
  if (identity.origin !== targetOrigin) {
    throw new Error("pi and the Claude CLI use different Anthropic origins");
  }

  const token = await oauthToken(registry, model);
  const headers = new Headers({ authorization: `Bearer ${token}` });

  await assertAccount(fetch, headers, identity, undefined);

  const catalog = await fetchCatalog(identity, token, previous);

  if (!superseded(catalog)) {
    saveCatalog(catalog);
  }

  return catalog;
}

export interface CatalogUpdates {
  /**
   * Shows an error reading the saved catalog, drops the catalog unless Anthropic uses OAuth, and
   * shows the model's badge.
   */
  start(ctx: ExtensionContext): void;
  /**
   * Fetches the catalog with `model`'s OAuth token, unless pi fetched it in the last hour or is
   * offline. Shows the first failure.
   */
  refresh(ctx: ExtensionContext, model: Model<Api>, identity: ClaudeIdentity): Promise<void>;
  /** Shows the selected model's badge, such as CVP access, in the `cvp` status. */
  showBadge(ctx: ExtensionContext): void;
}

// pi keeps a selected model that's no longer listed, so the next request with it fails.
function checkSelected(ctx: ExtensionContext): void {
  const selected = ctx.model;

  if (
    selected?.provider === "anthropic" &&
    ctx.modelRegistry.find(selected.provider, selected.id) === undefined
  ) {
    ctx.ui.notify(
      `${selected.id} isn't in your Claude model catalog anymore. Choose another model in /model.`,
      "warning",
    );
  }
}

interface StartupCatalog {
  catalog?: Catalog;
  readError?: string;
}

function readStartupCatalog(): StartupCatalog {
  try {
    return { catalog: readSavedCatalog() };
  } catch (cause) {
    // Extension load can't show the error, so start() does. A refresh replaces the file.
    return { readError: errorMessage(cause) };
  }
}

/**
 * Adds the models in the account's Claude Code catalog to pi's Anthropic models, and adds the
 * catalog's badges to their names. It starts from the saved catalog, which may belong to another
 * login until the first refresh.
 */
export function catalogUpdates(pi: ExtensionAPI): CatalogUpdates {
  let { catalog, readError } = readStartupCatalog();
  let registered = false;
  let warned = false;

  const register = (next: Catalog | undefined) => {
    catalog = next;
    const provider = next && catalogProvider(next.models);

    if (provider !== undefined) {
      pi.registerProvider(provider);
      registered = true;
    } else if (registered) {
      pi.unregisterProvider("anthropic");
      registered = false;
    }
  };

  register(catalog);

  const showBadge = (ctx: ExtensionContext) => {
    const model = ctx.model;

    const badge =
      model?.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model)
        ? catalogBadge(catalog?.models, model.id)
        : undefined;

    ctx.ui.setStatus(
      STATUS,
      badge && ctx.ui.theme.fg(badge.warning ? "warning" : "muted", badge.message),
    );
  };

  const start = (ctx: ExtensionContext) => {
    if (readError !== undefined) {
      ctx.ui.notify(`Couldn't read the saved Claude model catalog: ${readError}`, "warning");
      readError = undefined;
    }

    // The catalog belongs to an OAuth login, so pi drops it when Anthropic uses an API key or has
    // no login.
    if (catalog !== undefined && !usesOAuth(ctx.modelRegistry)) {
      register(undefined);
    }

    showBadge(ctx);
  };

  // Drops another login's catalog before fetching, so a failed fetch doesn't keep it.
  const load = (registry: Registry, model: Model<Api>, identity: ClaudeIdentity) => {
    const scope = catalogScope(identity);

    if (catalog !== undefined && catalog.scope !== scope) {
      register(undefined);
      deleteSavedCatalog();
    }

    if (offline() || (catalog !== undefined && Date.now() - catalog.fetchedAt < CATALOG_TTL_MS)) {
      return Promise.resolve(catalog);
    }

    const previous = catalog;

    return sharedRefresh(scope, () => download(registry, model, identity, previous));
  };

  const refresh = async (ctx: ExtensionContext, model: Model<Api>, identity: ClaudeIdentity) => {
    const before = catalog;

    try {
      const next = await load(ctx.modelRegistry, model, identity);

      if (next !== undefined && next !== catalog && !superseded(next)) {
        register(next);
      }
    } catch (cause) {
      // Fetching the catalog is optional, so a failure leaves the models as they are.
      if (!warned) {
        warned = true;
        ctx.ui.notify(
          `Couldn't refresh the Claude model catalog: ${errorMessage(cause)}`,
          "warning",
        );
      }
    }

    showBadge(ctx);

    if (catalog !== before) {
      checkSelected(ctx);
    }
  };

  return { start, refresh, showBadge };
}

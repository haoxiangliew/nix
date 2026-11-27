import { isModelType, type Api, type Model, type Provider } from "@earendil-works/pi-ai";

import type { CatalogModel } from "./claude-catalog.ts";

import { piAnthropicProvider } from "./pi-identity.ts";

// Fable is Mythos with added safety measures, so pi's Fable entry describes Mythos except for the
// fields the catalog sets.
function twinId(id: string): string | undefined {
  return id.startsWith("claude-mythos-")
    ? id.replace("claude-mythos-", "claude-fable-")
    : undefined;
}

function withoutFallback(compat: Model<Api>["compat"]): Model<Api>["compat"] {
  if (compat === undefined || !("allowedFallbackModels" in compat)) {
    return compat;
  }

  const { allowedFallbackModels: _, ...rest } = compat;

  return rest;
}

function addedModel(twin: Model<Api>, entry: CatalogModel): Model<Api> {
  return {
    ...twin,
    id: entry.id,
    name: entry.name,
    contextWindow: entry.contextWindow ?? twin.contextWindow,
    maxTokens: entry.maxTokens ?? twin.maxTokens,
    compat: entry.refusalFallback ? twin.compat : withoutFallback(twin.compat),
  };
}

function labelled(model: Model<Api>, entry: CatalogModel | undefined): Model<Api> {
  return entry?.badge === undefined
    ? model
    : { ...model, name: `${model.name} (${entry.badge.message})` };
}

function additions(base: readonly Model<Api>[], catalog: readonly CatalogModel[]) {
  const known = new Set(base.map((model) => model.id));

  return catalog.flatMap((entry) => {
    const twin = known.has(entry.id) ? undefined : base.find(({ id }) => id === twinId(entry.id));

    return twin === undefined ? [] : [addedModel(twin, entry)];
  });
}

/** pi's Anthropic models, plus the models the catalog adds, with catalog badges in their names. */
function catalogModels(
  base: readonly Model<Api>[],
  catalog: readonly CatalogModel[],
): Model<Api>[] {
  const entries = new Map(catalog.map((entry) => [entry.id, entry]));

  return [...base, ...additions(base, catalog)].map((model) =>
    labelled(model, entries.get(model.id)),
  );
}

export function catalogBadge(
  catalog: readonly CatalogModel[] | undefined,
  id: string,
): CatalogModel["badge"] {
  return catalog?.find((entry) => entry.id === id)?.badge;
}

/**
 * pi's built-in Anthropic provider with the catalog's models, or undefined if the catalog adds or
 * labels no model. Registering it replaces the built-in provider, so pi stops applying pi.dev's
 * catalog updates to Anthropic models.
 */
export function catalogProvider(catalog: readonly CatalogModel[]): Provider | undefined {
  const base = piAnthropicProvider;
  const builtIn = base.getModels();
  const models = catalogModels(builtIn, catalog);

  if (
    models.length === builtIn.length &&
    models.every(({ name }, index) => name === builtIn[index]?.name)
  ) {
    return undefined;
  }

  const all = [
    ...models,
    ...(base.getAllModels?.() ?? []).filter((model) => !isModelType(model, "chat")),
  ];

  return { ...base, getModels: () => models, getAllModels: () => all };
}

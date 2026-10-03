import type { FetchFunction } from "@earendil-works/pi-ai";

export type FetchWrapper = (upstream: FetchFunction) => FetchFunction;

interface Shared {
  base: FetchFunction;
  wrappers: Map<string, FetchWrapper>;
}

declare global {
  var piFetchWrappers: Shared | undefined;
}

export function registerFetchWrapper(name: string, wrapper: FetchWrapper): void {
  const shared: Shared = (globalThis.piFetchWrappers ??= {
    base: globalThis.fetch,
    wrappers: new Map(),
  });

  shared.wrappers.set(name, wrapper);

  let fetch = shared.base;

  for (const wrap of shared.wrappers.values()) {
    fetch = wrap(fetch);
  }

  globalThis.fetch = fetch;
}

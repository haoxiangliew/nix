import type { FetchFunction } from "@earendil-works/pi-ai";

export type FetchWrapper = (upstream: FetchFunction) => FetchFunction;

export type FetchInput = Parameters<FetchFunction>[0];

// init.headers replaces a Request's own headers, as in fetch().
export function requestHeaders(input: FetchInput, init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

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

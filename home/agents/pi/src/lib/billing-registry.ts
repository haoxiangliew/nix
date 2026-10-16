import type { ModelsRequestTransforms, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const BILLING_TOKEN_HEADER = "x-pi-anthropic-billing";

type Registry = Pick<ExtensionContext["modelRegistry"], "stream" | "streamSimple" | "complete">;

function taggedOptions<T extends ModelsRequestTransforms | undefined>(
  provider: string,
  options: T,
  token: string,
): T {
  if (provider !== "anthropic") {
    return options;
  }

  const transform = options?.transformHeaders;

  return {
    ...options,
    transformHeaders: async (headers: ProviderHeaders): Promise<ProviderHeaders> => ({
      ...(transform === undefined ? headers : await transform(headers)),
      [BILLING_TOKEN_HEADER]: token,
    }),
  };
}

// Pi doesn't fire before_provider_headers for calls through ctx.modelRegistry, so tag them here.
// Each session has its own registry, so patching it can't affect another session.
export function routeBillingRegistry(registry: Registry, token: string): void {
  const stream = registry.stream.bind(registry);
  const streamSimple = registry.streamSimple.bind(registry);
  const complete = registry.complete.bind(registry);

  Object.assign(registry, {
    stream: (model, context, options) =>
      stream(model, context, taggedOptions(model.provider, options, token)),
    streamSimple: (model, context, options) =>
      streamSimple(model, context, taggedOptions(model.provider, options, token)),
    complete: (model, context, options) =>
      complete(model, context, taggedOptions(model.provider, options, token)),
  } satisfies Registry);
}

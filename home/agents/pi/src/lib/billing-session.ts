import type { ProviderHeaders } from "@earendil-works/pi-ai";

export const BILLING_SESSION_HEADER = "x-pi-billing-session";

export function billingSessionHeaders(
  provider: string,
  sessionId: string,
): ProviderHeaders | undefined {
  if (provider !== "anthropic" || !globalThis.anthropicBilling?.handlers.size) {
    return undefined;
  }

  return { [BILLING_SESSION_HEADER]: sessionId };
}

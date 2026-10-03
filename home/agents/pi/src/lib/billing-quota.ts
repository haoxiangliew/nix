export function assertBillingReady(subscriptionType: string, quotaError?: Error): void {
  if (subscriptionType !== "enterprise" && quotaError !== undefined) {
    throw quotaError;
  }
}

export function billingQuotaError(headers: Headers, subscriptionType: string): Error | undefined {
  if (subscriptionType === "enterprise") {
    return undefined;
  }

  const claim = headers.get("anthropic-ratelimit-unified-representative-claim");

  if (subscriptionType !== "" && claim !== null && claim !== "" && claim !== "overage") {
    return undefined;
  }

  return Object.assign(
    new Error(
      "Anthropic reported usage credits or an unknown billing route for this subscription. " +
        "Further requests in this session are blocked. The triggering request may already be charged.",
    ),
    { code: "ANTHROPIC_BILLING_QUOTA" },
  );
}

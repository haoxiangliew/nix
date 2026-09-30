// stall-watchdog.ts emits these around a retry countdown, so attention.ts holds its "Ready for
// input" notification while pi is about to retry.
export const STALL_RETRY_PENDING = "stall-watchdog:retry-pending";

export const STALL_RETRY_DONE = "stall-watchdog:retry-done";

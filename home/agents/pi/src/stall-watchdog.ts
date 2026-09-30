/**
 * Aborts a provider request that streams no model output, then retries it after a backoff shown in
 * the status line. Anthropic keeps stalled streams alive with SSE pings, which reset pi's
 * httpIdleTimeoutMs, so pi would otherwise wait forever. Waiting for the first output gets a longer
 * limit than a stream that stops, because prefill and queueing can delay the start. Retries back off
 * like OpenCode's. Configured by `stallWatchdog` in settings.json.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getKeybindings, isKeyRelease } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

import { STALL_RETRY_DONE, STALL_RETRY_PENDING } from "./lib/events.ts";
import { isModelOutput } from "./lib/output.ts";
import { loadOrReport } from "./lib/settings.ts";

const Config = Type.Object(
  {
    firstTokenMs: Type.Integer({ minimum: 1000, default: 180_000 }),
    idleMs: Type.Integer({ minimum: 1000, default: 90_000 }),
    // Silence before the status line shows the countdown.
    warnMs: Type.Integer({ minimum: 1000, default: 30_000 }),
    // Per user message, so a provider that keeps stalling can't loop.
    maxRetries: Type.Integer({ minimum: 0, default: 5 }),
    // Doubles with each retry, up to maxRetryDelayMs.
    retryDelayMs: Type.Integer({ minimum: 0, default: 2000 }),
    maxRetryDelayMs: Type.Integer({ minimum: 0, default: 30_000 }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

const NAME = "stall-watchdog";

// Spreads out retries from sessions that stalled at the same moment.
const JITTER = 0.25;

const RETRY_MESSAGE =
  "The previous response stalled and the stall watchdog aborted it. Continue from where it stopped.";

interface Request {
  lastOutput: number;
  streaming: boolean;
  ticker: ReturnType<typeof setInterval>;
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function elapsed(ms: number): string {
  return clock(Math.floor(ms / 1000));
}

// Rounds up, so a countdown reaches 0:00 only when the time is up.
function remaining(ms: number): string {
  return clock(Math.max(0, Math.ceil(ms / 1000)));
}

function backoff(cfg: Config, attempt: number): number {
  const base = cfg.retryDelayMs * 2 ** (attempt - 1);

  return Math.min(Math.ceil(base * (1 + JITTER * Math.random())), cfg.maxRetryDelayMs);
}

export default function (pi: ExtensionAPI) {
  let config: Config | undefined;
  let request: Request | undefined;
  // Pi's cache warmer sends requests between turns that never stream replies, so only requests
  // made while a turn waits for its reply are watched.
  let awaitingReply = false;
  // Why the watchdog aborted the current run, if it did.
  let stall: string | undefined;
  let retries = 0;
  let countdown: ReturnType<typeof setInterval> | undefined;
  let stopListening: (() => void) | undefined;

  function disarm(ctx: ExtensionContext): void {
    clearInterval(request?.ticker);
    request = undefined;
    ctx.ui.setStatus(NAME, undefined);
  }

  function cancelRetry(ctx: ExtensionContext): void {
    if (countdown !== undefined) {
      pi.events.emit(STALL_RETRY_DONE, undefined);
    }

    clearInterval(countdown);
    countdown = undefined;
    stopListening?.();
    stopListening = undefined;
    ctx.ui.setStatus(NAME, undefined);
  }

  function cancelByUser(ctx: ExtensionContext): void {
    cancelRetry(ctx);
    ctx.ui.notify("Cancelled the stall retry.", "info");
  }

  function nextStep(cfg: Config): string {
    return retries < cfg.maxRetries ? `retry ${retries + 1}/${cfg.maxRetries}` : "abort";
  }

  function check(ctx: ExtensionContext, cfg: Config, current: Request): void {
    const silent = Date.now() - current.lastOutput;
    const limit = current.streaming ? cfg.idleMs : cfg.firstTokenMs;

    if (silent >= limit) {
      stall = `${current.streaming ? "Output stopped" : "No output"} for ${elapsed(silent)}`;
      disarm(ctx);
      ctx.abort();

      return;
    }

    const status = `no output ${elapsed(silent)}, ${nextStep(cfg)} in ${remaining(limit - silent)}`;

    ctx.ui.setStatus(NAME, silent >= cfg.warnMs ? status : undefined);
  }

  // Waits without blocking pi, so app.interrupt or a new message can cancel it.
  function scheduleRetry(ctx: ExtensionContext, attempt: string, wait: number): void {
    const due = Date.now() + wait;

    const tick = (): void => {
      const left = due - Date.now();

      if (left > 0) {
        ctx.ui.setStatus(NAME, `${attempt} in ${remaining(left)}`);

        return;
      }

      cancelRetry(ctx);
      ctx.ui.notify(`Sending ${attempt}.`, "info");
      pi.sendMessage(
        { customType: NAME, content: RETRY_MESSAGE, display: true },
        { triggerTurn: true },
      );
    };

    // Consumes the key, so it doesn't also count toward pi's double-Esc tree view.
    stopListening = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data) || !getKeybindings().matches(data, "app.interrupt")) {
        return undefined;
      }

      cancelByUser(ctx);

      return { consume: true };
    });
    pi.events.emit(STALL_RETRY_PENDING, undefined);
    countdown = setInterval(tick, 250);
    tick();
  }

  pi.on("session_start", async (_event, ctx) => {
    config = loadOrReport(ctx, "The stall watchdog", "stallWatchdog", Config);
  });

  pi.on("turn_start", async () => {
    awaitingReply = true;
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    const cfg = config;

    if (cfg === undefined || !awaitingReply) {
      return;
    }

    disarm(ctx);

    const current: Request = {
      lastOutput: Date.now(),
      streaming: false,
      ticker: setInterval(() => check(ctx, cfg, current), 1000),
    };

    current.ticker.unref();
    request = current;
  });

  pi.on("message_update", async (event, ctx) => {
    if (request !== undefined && isModelOutput(event)) {
      request.lastOutput = Date.now();
      request.streaming = true;
      ctx.ui.setStatus(NAME, undefined);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "assistant") {
      awaitingReply = false;
      disarm(ctx);
    }
  });

  // An abort skips agent_before_settle, so the retry starts a new turn once pi settles.
  pi.on("agent_settled", async (_event, ctx) => {
    const reason = stall;
    const cfg = config;

    awaitingReply = false;
    stall = undefined;

    if (reason === undefined || cfg === undefined) {
      return;
    }

    if (retries >= cfg.maxRetries) {
      ctx.ui.notify(`${reason}, so the request was aborted. Send "continue" to retry.`, "warning");

      return;
    }

    retries += 1;

    const wait = backoff(cfg, retries);
    const attempt = `retry ${retries}/${cfg.maxRetries}`;

    ctx.ui.notify(
      `${reason}. Starting ${attempt} in ${remaining(wait)}. Interrupt to cancel.`,
      "warning",
    );
    scheduleRetry(ctx, attempt, wait);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension" && countdown !== undefined) {
      cancelByUser(ctx);
    }
  });

  pi.on("before_agent_start", async () => {
    retries = 0;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    disarm(ctx);
    cancelRetry(ctx);
    stall = undefined;
  });
}

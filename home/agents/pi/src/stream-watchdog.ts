/**
 * Fails an Anthropic request whose stream stalls, so pi's auto-retry sends it again. Anthropic
 * keeps a stalled stream open with SSE pings, pi drops pings before extensions see them, and Bun
 * ignores httpIdleTimeoutMs. So this wraps fetch and times the headers, the first event, and the
 * gaps between events and between bytes. The error says "timed out", which pi's auto-retry
 * matches. The `streamWatchdog` key in settings.json configures it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { registerFetchWrapper, type FetchInput } from "./lib/fetch.ts";
import { errorMessage, loadOrReport } from "./lib/settings.ts";

const Config = Type.Object(
  {
    // Wait for response headers, plus uploadMsPer32KB for each 32 KB of request body.
    headersMs: Type.Integer({ minimum: 1000, default: 60_000 }),
    uploadMsPer32KB: Type.Integer({ minimum: 0, default: 1000 }),
    firstEventMs: Type.Integer({ minimum: 1000, default: 60_000 }),
    // Pings don't count, so this catches a stream that pings but never generates.
    eventIdleMs: Type.Integer({ minimum: 1000, default: 90_000 }),
    // Applies once events start. Pings count, so this catches a dead connection.
    byteIdleMs: Type.Integer({ minimum: 1000, default: 60_000 }),
    warnMs: Type.Integer({ minimum: 1000, default: 30_000 }),
    // "stalls" logs every request that didn't finish. "all" also logs finished ones.
    log: Type.Enum(["off", "stalls", "all"], { default: "stalls" }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

type Ui = ExtensionContext["ui"];

interface Session {
  config: Config;
  // Clear at shutdown so in-flight requests stop using this UI.
  ui: Ui | undefined;
  awaitingReply: boolean;
}

// Subagents run in the same process, so every copy of this extension shares this state.
interface Shared {
  sessions: Map<string, Session>;
}

interface Untagged {
  init: RequestInit | undefined;
  tag: string | null;
}

declare global {
  var streamWatchdog: Shared | undefined;
}

// statusline.ts shows this key in its `stall` segment.
const STATUS = "stream-watchdog";

// Names the session that sent a request. The wrapper removes it before the request goes out.
const TAG = "x-pi-stream-watchdog";

const LOG_FILE = "stream-watchdog.jsonl";

class StallError extends Error {
  override name = "StallError";
}

interface Limit {
  what: string;
  since: number;
  ms: number;
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function elapsed(ms: number): string {
  return clock(Math.floor(ms / 1000));
}

// Round up so the countdown shows 0:00 only after the deadline.
function remaining(ms: number): string {
  return clock(Math.max(0, Math.ceil(ms / 1000)));
}

const JsonBody = Type.String();

function streamBody(input: FetchInput, init: RequestInit | undefined): string | undefined {
  const url = URL.parse(input instanceof Request ? input.url : String(input));
  const body = init?.body;

  if (url?.host !== "api.anthropic.com" || url.pathname !== "/v1/messages") {
    return undefined;
  }

  return Value.Check(JsonBody, body) && body.includes('"stream":true') ? body : undefined;
}

class EventNames {
  #decoder = new TextDecoder();
  #partial = "";

  read(chunk: Uint8Array): string[] {
    const lines = (this.#partial + this.#decoder.decode(chunk, { stream: true })).split(/\r?\n|\r/);

    this.#partial = lines.pop() ?? "";

    return lines.flatMap((line) => (line.startsWith("event:") ? [line.slice(6).trim()] : []));
  }
}

class Watch {
  readonly started = Date.now();
  readonly upstream = new AbortController();
  requestId: string | undefined;
  headersAt: number | undefined;
  firstEventAt: number | undefined;
  lastEvent = 0;
  lastByte = 0;
  maxEventGap = 0;
  maxByteGap = 0;
  events = 0;
  pings = 0;
  bytes = 0;
  // watchBody sets this once the body exists. Before that, aborting upstream rejects the fetch.
  onStall: (error: StallError) => void = () => undefined;
  #ticker: ReturnType<typeof setInterval>;
  #ended = false;

  constructor(
    readonly bodyBytes: number,
    readonly cfg: Config,
    readonly display: Session | undefined,
  ) {
    this.#ticker = setInterval(() => this.check(), 1000);
    this.#ticker.unref();
  }

  limit(): Limit {
    const { cfg } = this;

    if (this.headersAt === undefined) {
      const upload = Math.ceil(this.bodyBytes / 32_768) * cfg.uploadMsPer32KB;

      return { what: "no response headers", since: this.started, ms: cfg.headersMs + upload };
    }

    if (this.firstEventAt === undefined) {
      return { what: "no events", since: this.headersAt, ms: cfg.firstEventMs };
    }

    const events = { what: "no events", since: this.lastEvent, ms: cfg.eventIdleMs };
    const bytes = { what: "no bytes", since: this.lastByte, ms: cfg.byteIdleMs };

    return bytes.since + bytes.ms < events.since + events.ms ? bytes : events;
  }

  check(): void {
    const { what, since, ms } = this.limit();
    const silent = Date.now() - since;

    if (silent >= ms) {
      const id = this.requestId === undefined ? "" : ` (${this.requestId})`;

      const error = new StallError(
        `Anthropic request timed out: ${what} for ${elapsed(silent)}${id}`,
      );

      this.end("stall", error);
      this.upstream.abort(error);
      this.onStall(error);

      return;
    }

    const status = `${what} ${elapsed(silent)}, abort in ${remaining(ms - silent)}`;

    this.display?.ui?.setStatus(STATUS, silent >= this.cfg.warnMs ? status : undefined);
  }

  receivedHeaders(response: Response): void {
    const now = Date.now();

    this.headersAt = now;
    this.lastEvent = now;
    this.lastByte = now;
    this.requestId = response.headers.get("request-id") ?? undefined;
  }

  received(chunk: Uint8Array, names: string[]): void {
    const now = Date.now();

    this.maxByteGap = Math.max(this.maxByteGap, now - this.lastByte);
    this.lastByte = now;
    this.bytes += chunk.byteLength;

    for (const name of names) {
      this.receivedEvent(name, now);
    }
  }

  receivedEvent(name: string, now: number): void {
    if (name === "ping") {
      this.pings += 1;

      return;
    }

    if (this.firstEventAt === undefined) {
      this.firstEventAt = now;
    } else {
      this.maxEventGap = Math.max(this.maxEventGap, now - this.lastEvent);
    }

    this.lastEvent = now;
    this.events += 1;

    // The reply is complete at message_stop, and pi-ai stops reading at an error event, so the
    // clock stops at either. The watchdog doesn't catch a connection held open after message_stop.
    if (name === "message_stop" || name === "error") {
      this.end(name === "error" ? "error event" : "done");
    }
  }

  end(outcome: string, error?: Error): void {
    if (this.#ended) {
      return;
    }

    this.#ended = true;
    clearInterval(this.#ticker);

    this.display?.ui?.setStatus(STATUS, undefined);

    if (this.cfg.log === "all" || (this.cfg.log === "stalls" && outcome !== "done")) {
      record(this, outcome, error);
    }
  }
}

// A stall or an interrupt errors the body at once, since a read on a dead socket may never return.
function watchBody(
  source: ReadableStream<Uint8Array>,
  watch: Watch,
  outer: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const names = new EventNames();
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
  let open = true;

  function settle(): boolean {
    const wasOpen = open;

    open = false;
    outer?.removeEventListener("abort", onAbort);

    return wasOpen;
  }

  function fail(cause: unknown): void {
    if (settle()) {
      sink?.error(cause);
    }

    reader.cancel(cause).catch(() => undefined);
  }

  function onAbort(): void {
    watch.end("aborted");
    fail(outer?.reason);
  }

  watch.onStall = fail;
  outer?.addEventListener("abort", onAbort, { once: true });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
    },
    async pull(controller) {
      const result = await reader.read().catch((cause: unknown) => {
        watch.end("failed", cause instanceof Error ? cause : undefined);
        fail(cause);

        return undefined;
      });

      if (result === undefined || !open) {
        return;
      }

      if (result.done) {
        watch.end("closed");
        settle();
        controller.close();

        return;
      }

      watch.received(result.value, names.read(result.value));
      controller.enqueue(result.value);
    },
    cancel(reason) {
      watch.end("cancelled");
      settle();

      return reader.cancel(reason);
    },
  });
}

// The SDK maps an error whose message says "timed out" to APIConnectionTimeoutError, which pi
// retries.
function fetchFailed(watch: Watch, outer: AbortSignal | undefined, cause: unknown): never {
  const reason: unknown = watch.upstream.signal.reason;

  watch.end(outer?.aborted ? "aborted" : "failed", cause instanceof Error ? cause : undefined);

  throw reason instanceof StallError ? reason : cause;
}

async function watched(
  original: typeof fetch,
  input: FetchInput,
  init: RequestInit | undefined,
  watch: Watch,
): Promise<Response> {
  const outer = init?.signal ?? undefined;
  const signal = outer ? AbortSignal.any([outer, watch.upstream.signal]) : watch.upstream.signal;

  const response = await original(input, { ...init, signal }).catch((cause: unknown) =>
    fetchFailed(watch, outer, cause),
  );

  if (signal.aborted) {
    fetchFailed(watch, outer, signal.reason);
  }

  watch.receivedHeaders(response);

  if (!response.ok || response.body === null) {
    watch.end(`HTTP ${response.status}`);

    return response;
  }

  return new Response(watchBody(response.body, watch, outer), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function record(watch: Watch, outcome: string, error?: Error): void {
  const since = (at: number | undefined): number | null =>
    at === undefined ? null : at - watch.started;

  const entry = {
    at: new Date(watch.started).toISOString(),
    outcome,
    error: error?.message,
    requestId: watch.requestId,
    bodyKB: Math.round(watch.bodyBytes / 1024),
    headersMs: since(watch.headersAt),
    firstEventMs: since(watch.firstEventAt),
    maxEventGapMs: watch.maxEventGap,
    maxByteGapMs: watch.maxByteGap,
    events: watch.events,
    pings: watch.pings,
    bytes: watch.bytes,
    durationMs: Date.now() - watch.started,
  };

  try {
    appendFileSync(join(getAgentDir(), LOG_FILE), `${JSON.stringify(entry)}\n`);
  } catch (cause) {
    reportLogFailure(cause);
  }
}

// record() can run inside setInterval. Report log failures instead of crashing from the timer.
let logFailureReported = false;

function reportLogFailure(cause: unknown): void {
  if (logFailureReported) {
    return;
  }

  logFailureReported = true;

  for (const session of globalThis.streamWatchdog?.sessions.values() ?? []) {
    session.ui?.notify(`The stream watchdog can't write its log. ${errorMessage(cause)}`, "error");

    return;
  }
}

function untag(init: RequestInit | undefined): Untagged {
  if (init?.headers === undefined) {
    return { init, tag: null };
  }

  const headers = new Headers(init.headers);
  const tag = headers.get(TAG);

  if (tag === null) {
    return { init, tag };
  }

  headers.delete(TAG);

  return { init: { ...init, headers }, tag };
}

// Untagged requests use any session's config because all sessions read the same settings file.
function configFor(shared: Shared, session: Session | undefined): Config | undefined {
  return session?.config ?? shared.sessions.values().next().value?.config;
}

function createWrapper(shared: Shared, upstream: typeof fetch): typeof fetch {
  const wrapper = (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const untagged = untag(init);
    const session = untagged.tag === null ? undefined : shared.sessions.get(untagged.tag);
    const config = configFor(shared, session);
    const body = config === undefined ? undefined : streamBody(input, untagged.init);

    if (config === undefined || body === undefined) {
      return upstream(input, untagged.init);
    }

    // Cache warming also sends requests during tool execution. Do not show a countdown for it.
    const display = session?.awaitingReply === true ? session : undefined;
    const watch = new Watch(Buffer.byteLength(body), config, display);

    return watched(upstream, input, untagged.init, watch);
  };

  return Object.assign(wrapper, upstream);
}

export default function (pi: ExtensionAPI) {
  const shared: Shared = (globalThis.streamWatchdog ??= {
    sessions: new Map(),
  });

  const token = crypto.randomUUID();
  let session: Session | undefined;

  function stop(): void {
    if (session !== undefined) {
      session.ui = undefined;
    }

    session = undefined;
    shared.sessions.delete(token);
  }

  function setAwaitingReply(value: boolean): void {
    if (session !== undefined) {
      session.awaitingReply = value;
    }
  }

  registerFetchWrapper("stream-watchdog", (upstream) => createWrapper(shared, upstream));

  pi.on("session_start", async (_event, ctx) => {
    const config = loadOrReport(ctx, "The stream watchdog", "streamWatchdog", Config);

    stop();

    if (config === undefined) {
      return;
    }

    session = { config, ui: ctx.ui, awaitingReply: false };
    shared.sessions.set(token, session);
  });

  // The wrapper watches only api.anthropic.com. Another provider's websocket request skips fetch,
  // so a tag on it would reach that provider.
  pi.on("before_provider_headers", async (event, ctx) => {
    if (session !== undefined && ctx.model?.provider === "anthropic") {
      event.headers[TAG] = token;
    }
  });

  pi.on("turn_start", async () => {
    setAwaitingReply(true);
  });

  pi.on("message_end", async (event) => {
    if (event.message.role === "assistant") {
      setAwaitingReply(false);
    }
  });

  pi.on("agent_settled", async () => {
    setAwaitingReply(false);
  });

  pi.on("session_shutdown", async () => {
    stop();
  });
}

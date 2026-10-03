/**
 * Fails an Anthropic request whose stream goes quiet, so pi's auto-retry sends it again. Pi can't
 * see these stalls. Anthropic keeps a stalled stream open with SSE pings, pi drops pings before
 * extensions see them, and the Bun build ignores httpIdleTimeoutMs. So this wraps fetch and times
 * the response headers, the first event, the gap between events (not counting pings), and the gap
 * between bytes (counting pings). The error says "timed out", which pi's auto-retry matches.
 * Configured by `streamWatchdog` in settings.json.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { registerFetchWrapper } from "./lib/fetch.ts";
import { errorMessage, loadOrReport } from "./lib/settings.ts";

const Config = Type.Object(
  {
    // Wait for response headers, plus uploadMsPer32KB for each 32 KB of request body.
    headersMs: Type.Integer({ minimum: 1000, default: 60_000 }),
    uploadMsPer32KB: Type.Integer({ minimum: 0, default: 1000 }),
    // Wait from the headers to the first event, which covers queueing and prefill.
    firstEventMs: Type.Integer({ minimum: 1000, default: 180_000 }),
    // Pings don't count, so this catches a server that holds the stream open without generating.
    eventIdleMs: Type.Integer({ minimum: 1000, default: 90_000 }),
    // Applies once events flow. Pings count, so this catches a dead connection.
    byteIdleMs: Type.Integer({ minimum: 1000, default: 60_000 }),
    // Silence before the status line shows the countdown.
    warnMs: Type.Integer({ minimum: 1000, default: 30_000 }),
    // "stalls" logs every request that didn't finish. "all" also logs finished ones, to tune limits.
    log: Type.Enum(["off", "stalls", "all"], { default: "stalls" }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

// The tsconfig has no DOM lib, so RequestInfo isn't available.
type FetchInput = Parameters<typeof fetch>[0];

type Ui = ExtensionContext["ui"];

interface Session {
  config: Config;
  // Cleared at shutdown, so a request still in flight stops writing to a stale UI.
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

/** Formats a duration as m:ss, rounding down. */
function elapsed(ms: number): string {
  return clock(Math.floor(ms / 1000));
}

/** Formats time left as m:ss, rounding up so a countdown reaches 0:00 only when the time is up. */
function remaining(ms: number): string {
  return clock(Math.max(0, Math.ceil(ms / 1000)));
}

const JsonBody = Type.String();

// Returns the body of a streamed Messages API call, which the SDK sends as a JSON string.
function streamBody(input: FetchInput, init: RequestInit | undefined): string | undefined {
  const url = URL.parse(input instanceof Request ? input.url : String(input));
  const body = init?.body;

  if (url?.host !== "api.anthropic.com" || url.pathname !== "/v1/messages") {
    return undefined;
  }

  return Value.Check(JsonBody, body) && body.includes('"stream":true') ? body : undefined;
}

// Holds a line split across chunks until the rest arrives.
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
  // Set once the body exists. Before that, aborting upstream rejects the fetch.
  onStall: (error: StallError) => void = () => undefined;
  #ticker: ReturnType<typeof setInterval>;
  #ended = false;

  // display is the session whose UI shows the countdown, if any.
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

    // pi-ai stops reading after either, so stop the clock even if the server holds the stream.
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

// record() runs inside setInterval, where a throw would crash pi, so it reports the first failure
// to a session instead.
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

// Removes the session tag, so it never reaches the network.
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

// An untagged request, such as a branch summary, uses any session's config. They all read the same
// settings.json.
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

    // Only a request made while a turn waits for its reply shows a countdown, since pi's cache
    // warmer also sends requests while tools run.
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

  // The wrapper only watches api.anthropic.com, and a tag on another provider's websocket request
  // would reach that provider.
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

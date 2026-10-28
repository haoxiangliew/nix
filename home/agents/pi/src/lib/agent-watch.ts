/**
 * Watches agents in herdr or Rex panes and tells pi when one settles. herdr-agents.ts and rex.ts
 * pass in how their multiplexer finds, prompts, and follows an agent.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { truncateToWidth } from "@earendil-works/pi-tui";
import { setTimeout as sleep } from "node:timers/promises";

import { elapsed, trimRead } from "./agent-output.ts";
import { errorMessage } from "./settings.ts";

// An agent that shows no activity in this time after a prompt may not have it.
export const STALL_MS = 5000;

// How long keys get to take effect before the tool reads the agent's state.
export const KEYS_SETTLE_MS = 2000;

// How often the wait after a slash command checks whether the agent started working.
const WORK_CHECK_MS = 100;

const SCREEN_LINES = 20;

const SETTLED = new Set(["idle", "done", "blocked", "error"]);

// These need the user, so they count even before the agent worked.
const URGENT = new Set(["blocked", "error"]);

export const WILL_MESSAGE = "You'll get a message when it's done, idle, blocked, or failed.";

export interface Agent {
  pane: string;
  name?: string;
  status: string;
}

export type WatchEvent = { kind: "status"; status: string } | { kind: "exited" };

export interface Subscription {
  close(): void;
}

export type Request =
  | { kind: "watch" }
  | { kind: "prompt"; prompt: string }
  | { kind: "keys"; keys: string[] };

/** What a multiplexer gives the watcher. */
export interface Backend {
  // Names the multiplexer in messages, such as `Rex`.
  title: string;
  // Prefix of the multiplexer's tools, such as `rex` in rex_read.
  tools: string;
  agentOf(target: string, signal?: AbortSignal): Promise<Agent>;
  // Whether a lookup failed because the agent exited.
  exited(error: Error): boolean;
  // Resolves once the stream is live, so no later event is lost. onFail gets errors and the stream
  // ending.
  subscribe(
    pane: string,
    onEvent: (event: WatchEvent) => void,
    onFail: (error: Error) => void,
  ): Promise<Subscription>;
  prompt(pane: string, prompt: string, signal?: AbortSignal): Promise<void>;
  keys(pane: string, keys: string[], signal?: AbortSignal): Promise<void>;
  screen(pane: string, signal?: AbortSignal): Promise<string>;
}

interface Watch {
  name?: string;
  // Waiting to tell pi about the last prompt, keys, or watch call.
  armed: boolean;
  // Worked since it was armed, so a settled state means the work finished.
  active: boolean;
  // A prompt is going out, so a settled state may still be the earlier task's.
  sending: boolean;
  // Started working again during the send, after settling, so that work is this prompt's.
  restarted: boolean;
  status: string;
  since: number;
  // Changes each time the watch is armed, so a stall check from an earlier arm leaves a newer one
  // alone.
  arm: number;
  // Counts status events, so a lookup can tell whether an event came in while it ran.
  events: number;
  subscription: Subscription;
}

// A copy of the watch that a failed call restores.
type WatchState = Pick<Watch, "name" | "armed" | "active" | "status" | "since" | "arm" | "events">;

function snapshot({ name, armed, active, status, since, arm, events }: Watch): WatchState {
  return { name, armed, active, status, since, arm, events };
}

export function label(pane: string, name: string | undefined): string {
  return name === undefined ? `\`${pane}\`` : `\`${name}\` (\`${pane}\`)`;
}

/** Names a tool's target, an agent of the multiplexer `title` or a pane that runs none. */
export function targetLabel(
  title: string,
  target: { kind: "agent" | "pane"; pane: string; name?: string },
): string {
  return target.kind === "agent"
    ? `${title} agent ${label(target.pane, target.name)}`
    : `pane \`${target.pane}\``;
}

export function requestOf({ prompt, keys }: { prompt?: string; keys?: string[] }): Request {
  if (prompt !== undefined && keys !== undefined) {
    throw new Error("Pass either `prompt` or `keys`, not both.");
  }

  if (keys?.length === 0) {
    throw new Error("`keys` needs at least one key.");
  }

  if (keys !== undefined) {
    return { kind: "keys", keys };
  }

  return prompt === undefined ? { kind: "watch" } : { kind: "prompt", prompt };
}

function stateColor(status: string): ThemeColor {
  if (status === "working") {
    return "accent";
  }

  if (status === "blocked") {
    return "warning";
  }

  if (status === "error") {
    return "error";
  }

  return SETTLED.has(status) ? "success" : "muted";
}

function widgetLines(
  title: string,
  rows: [string, Watch][],
  theme: Theme,
  width: number,
): string[] {
  const now = Date.now();
  const nameWidth = Math.max(...rows.map(([pane, watch]) => (watch.name ?? pane).length));

  const lines = rows.map(([pane, watch], index) => {
    const branch = theme.fg("dim", index === rows.length - 1 ? "└─" : "├─");
    const name = theme.fg("mdCode", (watch.name ?? pane).padEnd(nameWidth));
    const state = theme.fg(stateColor(watch.status), watch.status);
    const time = theme.fg("dim", ` · ${elapsed(now - watch.since)}`);

    return `${branch} ${name}  ${state}${time}`;
  });

  return [theme.fg("accent", `● ${title}`), ...lines].map((line) => truncateToWidth(line, width));
}

// A just-prompted agent can report idle before it gets the prompt, so a settled state counts only
// after the agent worked.
function finished({ armed, active, status }: Watch): boolean {
  return armed && (URGENT.has(status) || (active && SETTLED.has(status)));
}

/** Watches agents for one multiplexer's tools, and shows the ones pi waits on above the editor. */
export function createWatcher(pi: ExtensionAPI, backend: Backend) {
  const { title, tools } = backend;
  const widget = `${tools}-agents`;
  const watches = new Map<string, Watch>();
  const queues = new Map<string, Promise<unknown>>();
  let context: ExtensionContext | undefined;
  let live = false;
  let shown = false;
  let tui: TUI | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;

  function agentLabel(pane: string, name: string | undefined): string {
    return `${title} agent ${label(pane, name)}`;
  }

  function tell(content: string): void {
    if (live) {
      pi.sendMessage(
        { customType: `${tools}-agent`, content, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }
  }

  function waiting(): [string, Watch][] {
    return [...watches].filter(([, watch]) => watch.armed);
  }

  function hide(ui: ExtensionUIContext): void {
    clearInterval(ticker);
    ticker = undefined;
    tui = undefined;

    if (shown) {
      shown = false;
      ui.setWidget(widget, undefined);
    }
  }

  // pi stacks widgets in the order they're added and moves a re-added one to the end, so this adds
  // the widget once and then only repaints it, keeping its place next to other widgets. Its theme
  // is a live proxy, so it never needs adding again.
  function refresh(): void {
    const ui = context?.ui;

    if (ui === undefined) {
      return;
    }

    if (waiting().length === 0) {
      hide(ui);

      return;
    }

    if (shown) {
      tui?.requestRender();

      return;
    }

    shown = true;
    ui.setWidget(widget, (instance, theme) => {
      tui = instance;

      return {
        render: (width: number) => widgetLines(title, waiting(), theme, width),
        invalidate: () => undefined,
      };
    });

    clearInterval(ticker);
    ticker = setInterval(() => tui?.requestRender(), 1000);
    ticker.unref();
  }

  function unwatch(pane: string): void {
    watches.get(pane)?.subscription.close();
    watches.delete(pane);
    refresh();
  }

  // A watch closes once it has nothing to report, so no subscription outlives the wait.
  function settle(pane: string, message: string): void {
    tell(message);
    unwatch(pane);
  }

  // Tells the model when a watch it relies on ends without a result.
  function stop(pane: string, reason: string): void {
    const watch = watches.get(pane);

    if (watch?.armed === true) {
      tell(
        `Stopped watching ${agentLabel(pane, watch.name)}: ${reason}. Check on it with ${tools}_read.`,
      );
    }

    unwatch(pane);
  }

  // Returns whether it told pi the agent finished.
  function report(pane: string, watch: Watch): boolean {
    if (watches.get(pane) !== watch || watch.sending || !finished(watch)) {
      return false;
    }

    settle(
      pane,
      `${agentLabel(pane, watch.name)} is ${watch.status}. Read its output with ${tools}_read.`,
    );

    return true;
  }

  // Events from an earlier subscription of the pane don't reach a newer watch.
  function onEvent(pane: string, watch: Watch, event: WatchEvent): void {
    if (watches.get(pane) !== watch) {
      return;
    }

    if (event.kind === "exited") {
      stop(pane, "the agent exited");

      return;
    }

    watch.events += 1;
    watch.restarted ||= watch.sending && event.status === "working" && watch.status !== "working";
    watch.status = event.status;
    watch.active ||= event.status === "working";

    if (!report(pane, watch)) {
      refresh();
    }
  }

  async function open(pane: string): Promise<Watch> {
    // Events that come in before the watch exists wait for it.
    const early: WatchEvent[] = [];
    let watch: Watch | undefined;
    let failure: Error | undefined;

    const subscription = await backend.subscribe(
      pane,
      (event) => {
        if (watch === undefined) {
          early.push(event);
        } else {
          onEvent(pane, watch, event);
        }
      },
      (error) => {
        if (watch === undefined) {
          failure = error;
        } else if (watches.get(pane) === watch) {
          stop(pane, error.message);
        }
      },
    );

    const created: Watch = {
      armed: false,
      active: false,
      sending: false,
      restarted: false,
      status: "unknown",
      since: 0,
      arm: 0,
      events: 0,
      subscription,
    };

    watch = created;
    watches.set(pane, created);
    early.forEach((event) => onEvent(pane, created, event));

    if (failure !== undefined) {
      stop(pane, failure.message);

      throw failure;
    }

    return created;
  }

  // Calls on one key run one at a time, so a failed send never undoes another call's arm, and
  // only one call opens a pane's subscription.
  function serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (queues.get(key) ?? Promise.resolve()).then(task);
    // The next call waits for this one to end either way. This call's caller still gets its error.
    const tail = Promise.allSettled([result]);

    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) {
        queues.delete(key);
      }
    });

    return result;
  }

  // Closes a watch that nothing waits on.
  function release(pane: string, watch: Watch): void {
    if (!watch.armed && watches.get(pane) === watch) {
      unwatch(pane);
    }
  }

  // Puts back the arm from before a failed send. That arm's stall check may have seen this call's
  // arm and skipped, so it runs again.
  function restore(pane: string, watch: Watch, before: WatchState): void {
    const { status, events, active, ...fields } = before;

    // Work this call's lookup or events saw came after the earlier arm, so it counts for that arm.
    Object.assign(watch, fields, { active: active || watch.active });

    // An event during the send is newer than the status from before.
    if (watch.events === events) {
      watch.status = status;
    }

    release(pane, watch);

    // A finish this call's arm held back is reported now.
    if (report(pane, watch)) {
      return;
    }

    if (watch.armed && !watch.active) {
      checkStall(pane, watch);
    }

    refresh();
  }

  // An agent that never starts working would otherwise leave the model waiting forever.
  function checkStall(pane: string, watch: Watch): void {
    const arm = watch.arm;

    setTimeout(() => {
      if (watch.armed && !watch.active && watch.arm === arm && watches.get(pane) === watch) {
        settle(
          pane,
          `${agentLabel(pane, watch.name)} didn't start working within ${STALL_MS / 1000} seconds, so it may not have the prompt. Check on it with ${tools}_read.`,
        );
      }
    }, STALL_MS).unref();
  }

  // Returns the watch's state from before, for a failed send to put back.
  function armWatch(watch: Watch, agent: Agent, prompted: boolean): WatchState {
    // The agent can exit, or the subscription can end, during the lookup.
    if (watches.get(agent.pane) !== watch) {
      throw new Error(
        `The watch on ${agentLabel(agent.pane, agent.name)} closed before it was armed. Call ${tools}_watch again.`,
      );
    }

    const before = snapshot(watch);

    Object.assign(watch, {
      name: agent.name,
      armed: true,
      active: agent.status === "working",
      // A busy agent may report nothing new when a prompt reaches it, so it shows as working.
      status: prompted && agent.status !== "working" ? "prompted" : agent.status,
      since: Date.now(),
      arm: watch.arm + 1,
    });

    refresh();

    return before;
  }

  // A busy agent's earlier task can finish while the prompt goes out. Its idle or done doesn't
  // count for this prompt, so the watch waits for the agent to work again. Work that started after
  // that finish, or on an agent that wasn't busy, is this prompt's.
  function afterSend(pane: string, watch: Watch, busy: boolean): void {
    watch.sending = false;

    if (watches.get(pane) !== watch) {
      return;
    }

    const earlierFinish = busy && !watch.restarted;

    if (earlierFinish && watch.status !== "working" && !URGENT.has(watch.status)) {
      watch.active = false;
      watch.status = "prompted";
    }

    report(pane, watch);
  }

  async function sendPrompt(
    watch: Watch,
    agent: Agent,
    prompt: string,
    before: WatchState,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    watch.sending = true;
    watch.restarted = false;

    try {
      await backend.prompt(agent.pane, prompt, signal);
    } catch (error) {
      watch.sending = false;
      restore(agent.pane, watch, before);

      throw error;
    }

    afterSend(agent.pane, watch, agent.status === "working");
  }

  // The second lookup reads the status after the subscription starts. An event that comes in while
  // it runs is newer than what it read.
  async function currentAgent(
    pane: string,
    watch: Watch,
    signal: AbortSignal | undefined,
  ): Promise<Agent> {
    const seen = watch.events;

    // A failed lookup or a cancel closes the watch only if nothing waits on it.
    try {
      const agent = await backend.agentOf(pane, signal);

      signal?.throwIfAborted();

      return watch.events === seen ? agent : { ...agent, status: watch.status };
    } catch (error) {
      release(pane, watch);

      throw error;
    }
  }

  // Watches the agent if it's working. Returns whether pi waits on it. A watch an earlier call
  // armed still counts, even before the agent starts working.
  async function watchAgent(
    pane: string,
    signal: AbortSignal | undefined,
  ): Promise<{ agent: Agent; pending: boolean }> {
    const watch = watches.get(pane) ?? (await open(pane));
    const agent = await currentAgent(pane, watch, signal);

    if (agent.status === "working") {
      armWatch(watch, agent, false);
    } else {
      release(pane, watch);
    }

    return { agent, pending: watch.armed };
  }

  async function watchPane(pane: string, signal: AbortSignal | undefined): Promise<string> {
    const { agent, pending } = await watchAgent(pane, signal);
    const name = agentLabel(pane, agent.name);

    const next = `${WILL_MESSAGE} End your turn or keep working.`;

    if (!pending) {
      return `${name} is ${agent.status}, so there's nothing to wait for.`;
    }

    return agent.status === "working"
      ? `Watching ${name}. ${next}`
      : `${name} is ${agent.status}, but you're already waiting on it. ${next}`;
  }

  async function promptPane(
    pane: string,
    prompt: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const watch = watches.get(pane) ?? (await open(pane));
    const agent = await currentAgent(pane, watch, signal);
    const before = armWatch(watch, agent, true);

    await sendPrompt(watch, agent, prompt, before, signal);

    // A slash command such as /review or /new can open a menu or finish without starting a turn,
    // so the agent may never work.
    if (prompt.trimStart().startsWith("/")) {
      return checkAfter(pane, "the command", () => afterCommand(pane, watch, signal));
    }

    checkStall(pane, watch);

    return `Prompted ${agentLabel(pane, agent.name)}. ${WILL_MESSAGE} End your turn or keep working.`;
  }

  // Waits as long as the stall check would, then reports the agent's state and screen instead of
  // a stall message. A watch the agent never worked for stops waiting.
  async function afterCommand(
    pane: string,
    watch: Watch,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const deadline = Date.now() + STALL_MS;

    try {
      await sleep(KEYS_SETTLE_MS, undefined, { signal });

      while (!watch.active && watches.get(pane) === watch && Date.now() < deadline) {
        await sleep(WORK_CHECK_MS, undefined, { signal });
      }
    } finally {
      if (!watch.active) {
        watch.armed = false;
      }
    }

    return showAgent(pane, "the command", signal);
  }

  // Keys usually answer a dialog or interrupt the agent, so this reports the result right away
  // instead of a message later. Their result replaces the message an earlier watch would send.
  async function keysPane(
    pane: string,
    keys: string[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    await withoutWatch(pane, () => backend.keys(pane, keys, signal));

    return checkAfter(pane, "the keys", async () => {
      await sleep(KEYS_SETTLE_MS, undefined, { signal });

      return showAgent(pane, "the keys", signal);
    });
  }

  // What was sent went out, so a failed check says so, or pi may send it again. On failure, this
  // also closes the paused watch, unless the check armed it again.
  async function checkAfter(
    pane: string,
    what: string,
    check: () => Promise<string>,
  ): Promise<string> {
    try {
      return await check();
    } catch (error) {
      const watch = watches.get(pane);

      if (watch !== undefined) {
        release(pane, watch);
      }

      throw new Error(
        `Sent ${what} to ${agentLabel(pane, undefined)}, but checking on it failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async function showAgent(
    pane: string,
    what: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    // Keys such as ctrl+c can quit the agent, which is a result, not a failure.
    const watched = await watchAgent(pane, signal).catch((cause: unknown) => {
      if (cause instanceof Error && backend.exited(cause)) {
        return undefined;
      }

      throw cause;
    });

    if (watched === undefined) {
      return `Sent ${what} to ${agentLabel(pane, undefined)}, and the agent exited.`;
    }

    const { agent, pending } = watched;
    const screen = trimRead(await backend.screen(pane, signal), SCREEN_LINES);
    const next = pending ? ` ${WILL_MESSAGE}` : "";

    return `Sent ${what} to ${agentLabel(pane, agent.name)}. It's ${agent.status}.${next} Its screen:${screen}`;
  }

  // Holds back an armed watch's message while a call acts on the agent, and puts the watch back if
  // that fails.
  async function withoutWatch<T>(pane: string, task: () => Promise<T>): Promise<void> {
    const watch = watches.get(pane);

    if (watch === undefined) {
      await task();

      return;
    }

    const before = snapshot(watch);

    watch.armed = false;
    refresh();

    try {
      await task();
    } catch (error) {
      restore(pane, watch, before);

      throw error;
    }
  }

  function runRequest(
    pane: string,
    request: Request,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (request.kind === "prompt") {
      return promptPane(pane, request.prompt, signal);
    }

    return request.kind === "keys" ? keysPane(pane, request.keys, signal) : watchPane(pane, signal);
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    live = true;
  });

  pi.on("session_shutdown", async () => {
    live = false;
    [...watches.keys()].forEach(unwatch);
    context = undefined;
  });

  return { serial, unwatch, withoutWatch, runRequest, promptPane };
}

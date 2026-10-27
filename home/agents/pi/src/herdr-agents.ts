/**
 * Tools that let pi run herdr agents without calling the herdr CLI from bash.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { Socket } from "node:net";

import {
  DEFAULT_MAX_BYTES,
  defineTool,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import {
  AgentGet,
  AgentList,
  HERDR_TIMEOUT_MS,
  HerdrError,
  PaneCurrent,
  PaneLayout,
  PaneSplit,
  StatusEvent,
  TabCreated,
  herdr,
  herdrJson,
  subscribe,
  type AgentInfo,
} from "./lib/herdr.ts";
import { tildify, untildify } from "./lib/paths.ts";
import { errorMessage } from "./lib/settings.ts";

// A prompt is pasted, so a long one takes longer than a lookup.
const SEND_TIMEOUT_MS = 15_000;

// herdr waits this long for a new agent to be ready.
const START_TIMEOUT_MS = 60_000;

// Matches herdr's own --wait, which gives up on a prompt that shows no activity in this time.
const STALL_MS = 5000;

// How long keys get to take effect before the tool reads the agent's state.
const KEYS_SETTLE_MS = 2000;

const SCREEN_LINES = 20;

// herdr_read leaves out blank lines and divider lines, so it asks herdr for this many times as
// many lines as it returns.
const READ_SLACK = 2;

// herdr can take about 15 seconds to collect an idle agent's history, and 5 more to restore its
// screen.
const READ_TIMEOUT_MS = 30_000;

// herdr collects history only from an idle agent. `done` is idle, but the user hasn't looked at it yet.
const READABLE = new Set(["idle", "done"]);

// A split to the right leaves each half at least this many columns, or the split goes down.
const MIN_SPLIT_COLUMNS = 100;

// A split down leaves each half at least this many rows, or herdr_start refuses to split.
const MIN_SPLIT_ROWS = 15;

const WIDGET = "herdr-agents";

const SETTLED = new Set(["idle", "done", "blocked"]);

const WILL_MESSAGE = "You'll get a message when it's done, idle, or blocked.";

const socketPath = process.env.HERDR_ENV === "1" ? process.env.HERDR_SOCKET_PATH : undefined;

const AgentParam = Type.String({
  description: "Unique live agent name or the pane ID hosting the agent",
});

const WatchParams = Type.Object({
  agent: AgentParam,
  prompt: Type.Optional(Type.String({ description: "Text to submit to the agent" })),
  keys: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Logical keys to send instead of a prompt, such as `esc` to interrupt, `enter`, or `down`. `ctrl+c` can quit the agent.",
    }),
  ),
});

const StartParams = Type.Object({
  name: Type.String({
    pattern: "^[a-z][a-z0-9_-]{0,31}$",
    description: "Unique agent name, such as `reviewer`",
  }),
  kind: Type.Optional(
    Type.String({ description: "Agent kind, such as `pi`, `claude`, or `codex`. Default `pi`." }),
  ),
  prompt: Type.Optional(Type.String({ description: "First task for the agent" })),
  placement: Type.Optional(
    Type.Union([Type.Literal("split"), Type.Literal("tab")], {
      description: "`split` (default) splits your pane. `tab` opens a new tab in your workspace.",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory. Default your own." })),
  args: Type.Optional(
    Type.Array(Type.String(), { description: "Arguments for the agent's own command line" }),
  ),
});

const ReadParams = Type.Object({
  agent: AgentParam,
  lines: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 1000, description: "Lines to read. Default 120." }),
  ),
  source: Type.Optional(
    Type.Union([Type.Literal("recent"), Type.Literal("visible")], {
      description:
        "`recent` (default) reads scrollback, or only the screen while the agent isn't idle. `visible` reads only the screen.",
    }),
  ),
});

const CloseParams = Type.Object({ agent: AgentParam });

interface Agent {
  pane: string;
  name?: string;
  status: string;
}

interface Watch {
  name?: string;
  // Waiting to tell pi about the last prompt, keys, or watch call.
  armed: boolean;
  // Worked since it was armed, so a settled state means the work finished.
  active: boolean;
  status: string;
  since: number;
  // Changes each time the watch is armed, so a stall check from an earlier arm leaves a newer one
  // alone.
  arm: number;
  // Counts status events, so a lookup can tell whether an event came in while it ran.
  events: number;
  socket: Socket;
}

// A copy of the watch that a failed call restores.
type WatchState = Pick<Watch, "name" | "armed" | "active" | "status" | "since" | "arm" | "events">;

function snapshot({ name, armed, active, status, since, arm, events }: Watch): WatchState {
  return { name, armed, active, status, since, arm, events };
}

type Request =
  | { kind: "watch" }
  | { kind: "prompt"; prompt: string }
  | { kind: "keys"; keys: string[] };

interface Result {
  content: { type: "text"; text: string }[];
  details: undefined;
}

function text(content: string): Result {
  return { content: [{ type: "text", text: content }], details: undefined };
}

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stateColor(status: string): ThemeColor {
  if (status === "working") {
    return "accent";
  }

  if (status === "blocked") {
    return "warning";
  }

  return SETTLED.has(status) ? "success" : "muted";
}

function widgetLines(rows: [string, Watch][], theme: Theme, width: number): string[] {
  const now = Date.now();
  const nameWidth = Math.max(...rows.map(([pane, watch]) => (watch.name ?? pane).length));

  const lines = rows.map(([pane, watch], index) => {
    const branch = theme.fg("dim", index === rows.length - 1 ? "└─" : "├─");
    const name = theme.fg("mdCode", (watch.name ?? pane).padEnd(nameWidth));
    const state = theme.fg(stateColor(watch.status), watch.status);
    const time = theme.fg("dim", ` · ${elapsed(now - watch.since)}`);

    return `${branch} ${name}  ${state}${time}`;
  });

  return [theme.fg("accent", "● Herdr"), ...lines].map((line) => truncateToWidth(line, width));
}

// A just-prompted agent can report idle before it gets the prompt, so a settled state counts only
// after the agent worked. Blocked needs input, so it counts right away.
function finished(watch: Watch, status: string): boolean {
  return watch.armed && (status === "blocked" || (watch.active && SETTLED.has(status)));
}

function requestOf({ prompt, keys }: Static<typeof WatchParams>): Request {
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

// Agent output has many blank lines and divider lines, so only lines with text count.
function nonBlank(output: string, limit: number): string {
  return output
    .split("\n")
    .filter((line) => !/^[\s\u2500-\u257f]*$/.test(line))
    .slice(-limit)
    .join("\n");
}

function label(pane: string, name: string | undefined): string {
  return name === undefined ? `\`${pane}\`` : `\`${name}\` (\`${pane}\`)`;
}

function agentLine(agent: AgentInfo, ownPane: string): string {
  const own = agent.pane_id === ownPane ? " (you)" : "";

  return [
    `${agent.name ?? "-"}${own}`,
    agent.pane_id,
    agent.agent ?? "-",
    agent.agent_status,
    tildify(agent.cwd ?? ""),
  ].join("  ");
}

export default function (pi: ExtensionAPI) {
  if (socketPath === undefined) {
    return;
  }

  const path = socketPath;
  const watches = new Map<string, Watch>();
  const queues = new Map<string, Promise<unknown>>();
  let context: ExtensionContext | undefined;
  let live = false;
  let shown = false;
  let tui: TUI | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;

  function run(args: string[], timeout?: number, signal?: AbortSignal): Promise<string> {
    return herdr(pi, args, timeout, signal);
  }

  function tell(content: string): void {
    if (live) {
      pi.sendMessage(
        { customType: "herdr-agent", content, display: true },
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
      ui.setWidget(WIDGET, undefined);
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
    ui.setWidget(WIDGET, (instance, theme) => {
      tui = instance;

      return {
        render: (width: number) => widgetLines(waiting(), theme, width),
        invalidate: () => undefined,
      };
    });

    clearInterval(ticker);
    ticker = setInterval(() => tui?.requestRender(), 1000);
    ticker.unref();
  }

  function unwatch(pane: string): void {
    watches.get(pane)?.socket.destroy();
    watches.delete(pane);
    refresh();
  }

  // A watch closes once it has nothing to report, so no socket outlives the wait.
  function settle(pane: string, message: string): void {
    tell(message);
    unwatch(pane);
  }

  // Tells the model when a watch it relies on ends without a result.
  function stop(pane: string, reason: string): void {
    const watch = watches.get(pane);

    if (watch?.armed === true) {
      tell(
        `Stopped watching herdr agent ${label(pane, watch.name)}: ${reason}. Check on it with herdr_read.`,
      );
    }

    unwatch(pane);
  }

  function onEvent(pane: string, line: string): void {
    const event: unknown = JSON.parse(line);

    if (!Value.Check(StatusEvent, event)) {
      throw new Error(`unexpected herdr event: ${line.slice(0, 200)}`);
    }

    const watch = watches.get(pane);
    const { agent, agent_status: status } = event.data;

    if (watch === undefined) {
      return;
    }

    // herdr leaves out the agent, or sends null, once it exits.
    if (agent === undefined || agent === null) {
      stop(pane, "the agent exited");

      return;
    }

    watch.events += 1;
    watch.status = status;
    watch.active ||= status === "working";

    if (!report(pane, watch)) {
      refresh();
    }
  }

  // Returns whether it told pi the agent finished.
  function report(pane: string, watch: Watch): boolean {
    if (watches.get(pane) !== watch || !finished(watch, watch.status)) {
      return false;
    }

    settle(
      pane,
      `Herdr agent ${label(pane, watch.name)} is ${watch.status}. Read its output with herdr_read.`,
    );

    return true;
  }

  async function agentOf(target: string, signal?: AbortSignal): Promise<Agent> {
    const parsed = await herdrJson(
      pi,
      AgentGet,
      ["agent", "get", target],
      HERDR_TIMEOUT_MS,
      signal,
    ).catch((cause: unknown) => {
      throw cause instanceof HerdrError && !cause.killed
        ? new HerdrError(`${cause.message}. List agents with herdr_agents.`, cause.code, false, {
            cause,
          })
        : cause;
    });

    const { pane_id: pane, name, agent_status: status } = parsed.result.agent;

    return { pane, name, status };
  }

  async function open(pane: string): Promise<Watch> {
    // Events in the same read as the confirmation arrive before the watch exists, so they wait.
    const early: string[] = [];
    let ready = false;

    const socket = await subscribe(
      path,
      pane,
      (line) => (ready ? onEvent(pane, line) : early.push(line)),
      (error) => stop(pane, error.message),
    );

    const watch: Watch = {
      armed: false,
      active: false,
      status: "unknown",
      since: 0,
      arm: 0,
      events: 0,
      socket,
    };

    // A clean close, such as a herdr restart, sends no error. A newer watch of the pane stays.
    socket.on("close", () => {
      if (watches.get(pane) === watch) {
        stop(pane, "herdr closed the connection");
      }
    });

    watches.set(pane, watch);
    ready = true;

    // readLines stops the watch on a bad line. These lines were held back from it, so a bad one
    // stops the watch here.
    try {
      early.forEach((line) => onEvent(pane, line));
    } catch (error) {
      stop(pane, errorMessage(error));

      throw error;
    }

    return watch;
  }

  // Calls on one pane run one at a time, so a failed send never undoes another call's arm, and
  // only one call opens the pane's subscription.
  function serial<T>(pane: string, task: () => Promise<T>): Promise<T> {
    const result = (queues.get(pane) ?? Promise.resolve()).then(task);
    // The next call waits for this one to end either way. This call's caller still gets its error.
    const tail = Promise.allSettled([result]);

    queues.set(pane, tail);
    void tail.then(() => {
      if (queues.get(pane) === tail) {
        queues.delete(pane);
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

  // An agent that never starts working would otherwise leave the model waiting for good.
  function checkStall(pane: string, watch: Watch): void {
    const arm = watch.arm;

    setTimeout(() => {
      if (watch.armed && !watch.active && watch.arm === arm && watches.get(pane) === watch) {
        settle(
          pane,
          `Herdr agent ${label(pane, watch.name)} didn't start working within ${STALL_MS / 1000} seconds, so it may not have the prompt. Check on it with herdr_read.`,
        );
      }
    }, STALL_MS).unref();
  }

  // Returns the watch's state from before, for a failed send to put back.
  function armWatch(watch: Watch, agent: Agent, prompted: boolean): WatchState {
    // The agent can exit, or herdr can close the connection, during the lookup.
    if (watches.get(agent.pane) !== watch) {
      throw new Error(
        `The watch on herdr agent ${label(agent.pane, agent.name)} closed before it was armed. Call herdr_watch again.`,
      );
    }

    const before = snapshot(watch);

    Object.assign(watch, {
      name: agent.name,
      armed: true,
      active: agent.status === "working",
      status: prompted ? "prompted" : agent.status,
      since: Date.now(),
      arm: watch.arm + 1,
    });

    refresh();

    return before;
  }

  async function sendPrompt(
    watch: Watch,
    agent: Agent,
    prompt: string,
    before: WatchState,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      await run(["agent", "prompt", agent.pane, prompt], SEND_TIMEOUT_MS, signal);
    } catch (error) {
      restore(agent.pane, watch, before);

      throw error;
    }

    checkStall(agent.pane, watch);
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
      const agent = await agentOf(pane, signal);

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
    const name = label(pane, agent.name);

    const next = `${WILL_MESSAGE} End your turn or keep working.`;

    if (!pending) {
      return `Herdr agent ${name} is ${agent.status}, so there's nothing to wait for.`;
    }

    return agent.status === "working"
      ? `Watching herdr agent ${name}. ${next}`
      : `Herdr agent ${name} is ${agent.status}, but you're already waiting on it. ${next}`;
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

    return `Prompted herdr agent ${label(pane, agent.name)}. ${WILL_MESSAGE} End your turn or keep working.`;
  }

  // Keys usually answer a dialog or interrupt the agent, so this reports the result right away
  // instead of a message later. Their result replaces the message an earlier watch would send.
  async function keysPane(
    pane: string,
    keys: string[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    await withoutWatch(pane, () =>
      run(["agent", "send-keys", pane, ...keys], SEND_TIMEOUT_MS, signal),
    );

    // The keys went out, so a later failure says so, or pi may send them again. On failure, this
    // also closes the paused watch, unless the check armed it again.
    try {
      return await afterKeys(pane, signal);
    } catch (error) {
      const watch = watches.get(pane);

      if (watch !== undefined) {
        release(pane, watch);
      }

      throw new Error(
        `Sent the keys to herdr agent \`${pane}\`, but checking on it failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async function afterKeys(pane: string, signal: AbortSignal | undefined): Promise<string> {
    await sleep(KEYS_SETTLE_MS, undefined, { signal });

    // Keys such as ctrl+c can quit the agent, which is a result, not a failure.
    const watched = await watchAgent(pane, signal).catch((cause: unknown) => {
      if (cause instanceof HerdrError && cause.code === "agent_not_found") {
        return undefined;
      }

      throw cause;
    });

    if (watched === undefined) {
      return `Sent the keys to herdr agent \`${pane}\`, and the agent exited.`;
    }

    const { agent, pending } = watched;

    const screen = await run(
      ["agent", "read", pane, "--source", "visible"],
      HERDR_TIMEOUT_MS,
      signal,
    );

    const next = pending ? ` ${WILL_MESSAGE}` : "";

    return `Sent the keys to herdr agent ${label(pane, agent.name)}. It's ${agent.status}.${next} Its screen:\n\n${nonBlank(screen, SCREEN_LINES)}`;
  }

  // Holds back an armed watch's message while a call acts on the agent, and puts the watch back if
  // that fails.
  async function withoutWatch(pane: string, task: () => Promise<string>): Promise<void> {
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

  // --current resolves pi's own pane even after it moved, unlike HERDR_PANE_ID.
  async function currentPane(
    signal: AbortSignal | undefined,
  ): Promise<{ pane: string; workspace: string }> {
    const current = await herdrJson(
      pi,
      PaneCurrent,
      ["pane", "current", "--current"],
      HERDR_TIMEOUT_MS,
      signal,
    );

    const { pane_id: pane, workspace_id: workspace } = current.result.pane;

    return { pane, workspace };
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

  async function splitDirection(pane: string, signal: AbortSignal | undefined): Promise<string> {
    const layout = await herdrJson(
      pi,
      PaneLayout,
      ["pane", "layout", "--pane", pane],
      HERDR_TIMEOUT_MS,
      signal,
    );

    const rect = layout.result.layout.panes.find((item) => item.pane_id === pane)?.rect;

    if (rect === undefined) {
      throw new Error(`herdr's layout doesn't list this pane, ${pane}`);
    }

    if (rect.width / 2 >= MIN_SPLIT_COLUMNS) {
      return "right";
    }

    if (rect.height / 2 >= MIN_SPLIT_ROWS) {
      return "down";
    }

    throw new Error(
      `Your pane is ${rect.width}x${rect.height}, too small to split again. Start the agent with \`placement: "tab"\`, or close an agent you started with herdr_close.`,
    );
  }

  // Parallel starts split pi's pane one at a time, so each sees the layout the last one left.
  async function splitPane(cwd: string, signal: AbortSignal | undefined): Promise<string> {
    const { pane: parent } = await currentPane(signal);

    return serial(`split ${parent}`, async () => {
      const direction = await splitDirection(parent, signal);
      const args = ["pane", "split", parent, "--direction", direction, "--cwd", cwd, "--no-focus"];
      const split = await herdrJson(pi, PaneSplit, args, HERDR_TIMEOUT_MS, signal);

      return split.result.pane.pane_id;
    });
  }

  // Returns the new pane. Focus stays with the user.
  async function openPane(
    params: Static<typeof StartParams>,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (params.placement !== "tab") {
      return splitPane(cwd, signal);
    }

    const { workspace } = await currentPane(signal);

    const created = await herdrJson(
      pi,
      TabCreated,
      [
        "tab",
        "create",
        "--workspace",
        workspace,
        "--cwd",
        cwd,
        "--label",
        params.name,
        "--no-focus",
      ],
      HERDR_TIMEOUT_MS,
      signal,
    );

    return created.result.root_pane.pane_id;
  }

  // herdr checks too, but only after a pane opens in the user's layout.
  async function checkName(name: string, signal: AbortSignal | undefined): Promise<void> {
    const list = await herdrJson(pi, AgentList, ["agent", "list"], HERDR_TIMEOUT_MS, signal);
    const taken = list.result.agents.find((agent) => agent.name === name);

    if (taken !== undefined) {
      throw new Error(
        `A herdr agent named \`${name}\` already runs in ${taken.pane_id}. Pick another name.`,
      );
    }
  }

  // Returns whether the agent is ready. herdr keeps an agent that's blocked during startup, so its
  // pane stays. Any other failure leaves an empty pane, which this closes.
  async function startAgent(
    pane: string,
    params: Static<typeof StartParams>,
    kind: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const extra = params.args === undefined ? [] : ["--", ...params.args];
    const args = ["agent", "start", params.name, "--kind", kind, "--pane", pane];

    try {
      await run(
        [...args, "--timeout", String(START_TIMEOUT_MS), ...extra],
        START_TIMEOUT_MS + 5000,
        signal,
      );

      return true;
    } catch (error) {
      if (error instanceof HerdrError && error.code === "agent_not_ready") {
        return false;
      }

      await run(["pane", "close", pane]).catch((cause: unknown) => {
        throw new AggregateError(
          [error, cause],
          `${errorMessage(error)}. Closing its new pane ${pane} failed too: ${errorMessage(cause)}`,
          { cause: error },
        );
      });

      throw error;
    }
  }

  const startTool = defineTool({
    name: "herdr_start",
    label: "Herdr Start",
    description:
      "Start a coding agent in a new herdr pane next to yours, or in a new tab, and optionally give it its first task. With a prompt, you get a message when the agent is done, idle, or blocked. The user's focus stays where it is.",
    promptSnippet: "Start a herdr agent in a new pane or tab, with an optional first task",
    promptGuidelines: [
      "Use the herdr_* tools for herdr agents instead of the herdr CLI.",
      'Start herdr agents with herdr_start, with a short unique name and the first task as `prompt`. Use `placement: "tab"` only when the user asks for a tab.',
    ],
    parameters: StartParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      await checkName(params.name, signal);

      // herdr resolves a relative cwd against its server's directory, so it goes in absolute.
      const cwd = resolve(ctx.cwd, untildify(params.cwd ?? "."));
      const pane = await openPane(params, cwd, signal);
      const kind = params.kind ?? "pi";
      const where = params.placement === "tab" ? "a new tab" : "a new pane";
      const started = `Started ${kind} agent ${label(pane, params.name)} in ${where}.`;

      if (!(await startAgent(pane, params, kind, signal))) {
        return text(
          `${started} It's blocked during startup, so it didn't get a prompt. Read it with herdr_read, and ask the user before you answer it.`,
        );
      }

      const { prompt } = params;

      if (prompt === undefined) {
        return text(`${started} Give it a task with herdr_watch.`);
      }

      // The agent runs even if its first prompt fails, so the error says where.
      try {
        return text(`${started} ${await serial(pane, () => promptPane(pane, prompt, signal))}`);
      } catch (error) {
        throw new Error(`${started} Its first prompt failed: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    },
  });

  const watchTool = defineTool({
    name: "herdr_watch",
    label: "Herdr Watch",
    description: `Prompt a herdr agent or send it keys. A prompt returns right away, and you get a message when the agent is done, idle, or blocked. Keys wait ${KEYS_SETTLE_MS / 1000} seconds, then return the agent's state and screen. With only \`agent\`, wait on an agent that's already working.`,
    promptSnippet: "Prompt a herdr agent or send it keys, and get a message when it settles",
    promptGuidelines: [
      "After you prompt a herdr agent, end your turn or keep working until its message arrives. Don't poll it with herdr_read, bash, or `sleep`. Keys return the agent's state and screen, so don't check on it after them.",
      "To prompt several herdr agents at once, call herdr_watch once per agent in parallel.",
      "When a herdr agent is blocked on an approval or a question, read it with herdr_read and ask the user before you answer it with keys.",
    ],
    parameters: WatchParams,
    async execute(_toolCallId, params, signal) {
      const request = requestOf(params);
      const { pane } = await agentOf(params.agent, signal);

      return text(await serial(pane, () => runRequest(pane, request, signal)));
    },
  });

  async function readPane(
    pane: string,
    params: Static<typeof ReadParams>,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const agent = await agentOf(pane, signal);
    const lines = params.lines ?? 120;
    const history = params.source !== "visible" && READABLE.has(agent.status);
    const source = history ? "recent-unwrapped" : "visible";
    const raw = String(lines * READ_SLACK);
    const args = ["agent", "read", pane, "--source", source, "--lines", raw];
    const read = nonBlank(await run(args, READ_TIMEOUT_MS, signal), lines);
    // One line of a log can be huge, so the output gets the byte limit of pi's own bash output.
    const output = truncateTail(read, { maxLines: lines, maxBytes: DEFAULT_MAX_BYTES });

    const notes = [
      params.source !== "visible" && !history ? " It isn't idle, so this is only its screen." : "",
      output.truncated ? ` Its output is cut to the last ${formatSize(DEFAULT_MAX_BYTES)}.` : "",
    ].join("");

    return `Herdr agent ${label(pane, agent.name)} is ${agent.status}.${notes}\n\n${output.content}`;
  }

  const readTool = defineTool({
    name: "herdr_read",
    label: "Herdr Read",
    description:
      "Read a herdr agent's state and recent output, without blank lines. Read an agent after its message arrives.",
    promptSnippet: "Read a herdr agent's state and recent output",
    promptGuidelines: [
      "If herdr_read doesn't show a herdr agent's whole response, ask the agent to write it to a file and reply with the path, then read the file.",
    ],
    parameters: ReadParams,
    async execute(_toolCallId, params, signal) {
      const { pane } = await agentOf(params.agent, signal);

      // herdr collects history by scrolling the agent, which a prompt sent meanwhile cuts short.
      return text(await serial(pane, () => readPane(pane, params, signal)));
    },
  });

  const agentsTool = defineTool({
    name: "herdr_agents",
    label: "Herdr Agents",
    description:
      "List the agents running in herdr panes: name, pane, kind, state, and working directory. `(you)` marks your own pane.",
    promptSnippet: "List the agents running in herdr",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const list = await herdrJson(pi, AgentList, ["agent", "list"], HERDR_TIMEOUT_MS, signal);
      const { pane } = await currentPane(signal);
      const lines = list.result.agents.map((agent) => agentLine(agent, pane));

      return text(lines.length === 0 ? "No agents are running in herdr." : lines.join("\n"));
    },
  });

  const closeTool = defineTool({
    name: "herdr_close",
    label: "Herdr Close",
    description: "Close a herdr agent's pane, which ends the agent.",
    promptSnippet: "Close a herdr agent's pane",
    promptGuidelines: [
      "Close only herdr agents you started, unless the user asks you to close others.",
    ],
    parameters: CloseParams,
    async execute(_toolCallId, params, signal) {
      const agent = await agentOf(params.agent, signal);
      const { pane } = await currentPane(signal);

      if (agent.pane === pane) {
        throw new Error("That's your own pane.");
      }

      await serial(agent.pane, async () => {
        await withoutWatch(agent.pane, () =>
          run(["pane", "close", agent.pane], HERDR_TIMEOUT_MS, signal),
        );
        unwatch(agent.pane);
      });

      return text(`Closed herdr agent ${label(agent.pane, agent.name)} and its pane.`);
    },
  });

  pi.registerTool(startTool);
  pi.registerTool(watchTool);
  pi.registerTool(readTool);
  pi.registerTool(agentsTool);
  pi.registerTool(closeTool);

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    live = true;
  });

  pi.on("session_shutdown", async () => {
    live = false;
    [...watches.keys()].forEach(unwatch);
    context = undefined;
  });
}

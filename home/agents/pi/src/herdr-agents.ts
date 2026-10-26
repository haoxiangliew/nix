/**
 * Adds a `herdr_watch` tool. It prompts a herdr agent or sends it keys, then messages pi when the
 * agent is done, idle, or blocked, so pi doesn't poll. Without a prompt or keys it waits on an agent
 * that's already working. No settings.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createConnection, type Socket } from "node:net";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { errorMessage } from "./lib/settings.ts";

const HERDR_TIMEOUT_MS = 2000;

// A prompt is pasted, so a long one takes longer than a lookup.
const SEND_TIMEOUT_MS = 15_000;

// Matches herdr's own --wait, which gives up on a prompt that shows no activity in this time.
const STALL_MS = 5000;

const WIDGET = "herdr-agents";

const SETTLED = new Set(["idle", "done", "blocked"]);

const socketPath = process.env.HERDR_ENV === "1" ? process.env.HERDR_SOCKET_PATH : undefined;

const Params = Type.Object({
  agent: Type.String({ description: "Unique live agent name or the pane ID hosting the agent" }),
  prompt: Type.Optional(Type.String({ description: "Text to submit to the agent" })),
  keys: Type.Optional(
    Type.Array(Type.String(), {
      description: "Logical keys to send instead of a prompt, such as `esc`, `enter`, or `ctrl+c`",
    }),
  ),
});

const AgentGet = Type.Object({
  // herdr leaves out the name of an unnamed agent.
  result: Type.Object({
    agent: Type.Object({
      pane_id: Type.String(),
      agent_status: Type.String(),
      name: Type.Optional(Type.String()),
    }),
  }),
});

const Started = Type.Object({
  result: Type.Object({ type: Type.Literal("subscription_started") }),
});

const StatusEvent = Type.Object({
  event: Type.Literal("pane.agent_status_changed"),
  data: Type.Object({
    agent_status: Type.String(),
    agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  }),
});

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
  // Whether the last arm sent a prompt, for the stall message.
  prompted: boolean;
  // Counts status events, so a lookup can tell whether an event came in while it ran.
  events: number;
  socket: Socket;
}

// The watch before a call arms it, for a failed send to put back.
type WatchState = Pick<
  Watch,
  "name" | "armed" | "active" | "status" | "since" | "arm" | "prompted" | "events"
>;

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

// herdr's socket is a boundary, so an error in a line goes to onError instead of escaping the
// listener and crashing pi.
function readLines(
  socket: Socket,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
): void {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString();

    const lines = buffer.split("\n");

    buffer = lines.pop() ?? "";

    try {
      lines.filter((line) => line.trim() !== "").forEach(onLine);
    } catch (error) {
      onError(new Error(errorMessage(error)));
    }
  });
}

// Resolves once herdr confirms the subscription, so no status change is missed after that.
function subscribe(
  path: string,
  pane: string,
  onEvent: (line: string) => void,
  onFail: (error: Error) => void,
): Promise<Socket> {
  const socket = createConnection(path);

  const request = {
    id: "subscribe",
    method: "events.subscribe",
    params: { subscriptions: [{ type: "pane.agent_status_changed", pane_id: pane }] },
  };

  return new Promise((resolve, reject) => {
    let started = false;

    const fail = (error: Error): void => {
      socket.destroy();

      if (started) {
        onFail(error);
      } else {
        reject(error);
      }
    };

    socket.setTimeout(HERDR_TIMEOUT_MS, () =>
      fail(new Error("herdr didn't confirm the subscription")),
    );
    socket.on("error", fail);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));

    // Destroying the socket clears its timeout, so a close before the reply has to reject.
    socket.on("close", () => reject(new Error("herdr closed the socket before confirming")));

    readLines(
      socket,
      (line) => {
        if (started) {
          onEvent(line);

          return;
        }

        if (!Value.Check(Started, JSON.parse(line))) {
          throw new Error(`herdr refused the subscription: ${line.slice(0, 200)}`);
        }

        started = true;
        socket.setTimeout(0);
        resolve(socket);
      },
      fail,
    );
  });
}

interface Command {
  action: "prompt" | "send-keys";
  args: string[];
}

// A herdr call killed by its timeout or a cancel. It may have run anyway.
class Killed extends Error {}

// What to send the agent, or undefined to only watch it.
function commandOf({ prompt, keys }: Static<typeof Params>): Command | undefined {
  if (prompt !== undefined && keys !== undefined) {
    throw new Error("Pass either `prompt` or `keys`, not both.");
  }

  if (keys?.length === 0) {
    throw new Error("`keys` needs at least one key.");
  }

  if (keys !== undefined) {
    return { action: "send-keys", args: keys };
  }

  return prompt === undefined ? undefined : { action: "prompt", args: [prompt] };
}

function label(pane: string, name: string | undefined): string {
  return name === undefined ? `\`${pane}\`` : `\`${name}\` (\`${pane}\`)`;
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
        `Stopped watching herdr agent ${label(pane, watch.name)}: ${reason}. Check on it yourself.`,
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
      `Herdr agent ${label(pane, watch.name)} is ${watch.status}. Read its output with \`herdr agent read ${watch.name ?? pane} --source recent-unwrapped --lines 120\`.`,
    );

    return true;
  }

  // pi.exec reports a killed process with code 0, so a kill is checked first.
  async function herdr(args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
    const result = await pi.exec("herdr", args, { timeout, signal });
    const call = `herdr ${args.slice(0, 2).join(" ")}`;

    if (result.killed) {
      throw new Killed(
        signal?.aborted === true
          ? `${call} was cancelled`
          : `${call} timed out after ${timeout / 1000} seconds`,
      );
    }

    if (result.code !== 0) {
      throw new Error(`${call} failed: ${result.stderr.trim()}`);
    }

    return result.stdout;
  }

  async function agentOf(target: string, signal?: AbortSignal): Promise<Agent> {
    const stdout = await herdr(["agent", "get", target], HERDR_TIMEOUT_MS, signal).catch(
      (cause: unknown) => {
        throw cause instanceof Killed
          ? cause
          : new Error(`${errorMessage(cause)}. Check the name with \`herdr agent list\`.`, {
              cause,
            });
      },
    );

    const parsed: unknown = JSON.parse(stdout);

    if (!Value.Check(AgentGet, parsed)) {
      throw new Error(`unexpected herdr agent get output: ${stdout.slice(0, 200)}`);
    }

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
      prompted: false,
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
  function serial<T>(pane: string, run: () => Promise<T>): Promise<T> {
    const result = (queues.get(pane) ?? Promise.resolve()).then(run);
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

    const reason = watch.prompted
      ? ", so it may not have the prompt. Check on it yourself."
      : " after the keys, so there's nothing to wait for.";

    setTimeout(() => {
      if (watch.armed && !watch.active && watch.arm === arm && watches.get(pane) === watch) {
        settle(
          pane,
          `Herdr agent ${label(pane, watch.name)} didn't start working within ${STALL_MS / 1000} seconds${reason}`,
        );
      }
    }, STALL_MS).unref();
  }

  // Returns the watch's state from before, for a failed send to put back.
  function armWatch(watch: Watch, agent: Agent, command: Command | undefined): WatchState {
    // The agent can exit, or herdr can close the connection, during the lookup.
    if (watches.get(agent.pane) !== watch) {
      throw new Error(
        `The watch on herdr agent ${label(agent.pane, agent.name)} closed before it was armed. Call herdr_watch again.`,
      );
    }

    const { name, armed, active, status, since, arm, prompted, events } = watch;
    const before: WatchState = { name, armed, active, status, since, arm, prompted, events };

    // herdr refuses a prompt to a blocked agent, but keys answer it. So after keys, a blocked
    // agent counts as active, and an Esc that leaves it idle still reports.
    const answered = command?.action === "send-keys" && agent.status === "blocked";

    Object.assign(watch, {
      name: agent.name,
      armed: true,
      active: agent.status === "working" || answered,
      status: command === undefined ? agent.status : "prompted",
      since: Date.now(),
      arm: watch.arm + 1,
      prompted: command?.action === "prompt",
    });

    refresh();

    return before;
  }

  async function send(
    watch: Watch,
    agent: Agent,
    command: Command,
    before: WatchState,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const args = ["agent", command.action, agent.pane, ...command.args];

    try {
      await herdr(args, SEND_TIMEOUT_MS, signal);
    } catch (error) {
      restore(agent.pane, watch, before);

      throw error instanceof Killed
        ? new Error(
            `${error.message}. That doesn't prove it wasn't delivered, so read the agent before sending again.`,
            { cause: error },
          )
        : error;
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

  // A watch an earlier call armed still reports, even before the agent starts working.
  function notWorking(pane: string, watch: Watch, agent: Agent): ReturnType<typeof text> {
    if (watch.armed) {
      return text(
        `Herdr agent ${label(pane, agent.name)} is ${agent.status}, but you're already waiting on it. You'll get a message when it's done, idle, or blocked. End your turn or keep working.`,
      );
    }

    release(pane, watch);

    return text(
      `Herdr agent ${label(pane, agent.name)} is ${agent.status}, so there's nothing to wait for.`,
    );
  }

  async function watchPane(
    pane: string,
    command: Command | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ReturnType<typeof text>> {
    const watch = watches.get(pane) ?? (await open(pane));
    const agent = await currentAgent(pane, watch, signal);

    if (command === undefined && agent.status !== "working") {
      return notWorking(pane, watch, agent);
    }

    const before = armWatch(watch, agent, command);

    if (command !== undefined) {
      await send(watch, agent, command, before, signal);
    }

    const verb =
      command === undefined
        ? "Watching"
        : command.action === "prompt"
          ? "Prompted"
          : "Sent the keys to";

    return text(
      `${verb} herdr agent ${label(pane, agent.name)}. You'll get a message when it's done, idle, or blocked. End your turn or keep working.`,
    );
  }

  const tool = defineTool({
    name: "herdr_watch",
    label: "Herdr Watch",
    description:
      "Prompt a herdr agent or send it keys, then return right away and get a message when the agent is done, idle, or blocked. With only `agent`, wait on an agent that's already working. The agent must already be running; start it with `herdr agent start`.",
    promptSnippet: "Prompt a herdr agent or send it keys, and get a message when it settles",
    promptGuidelines: [
      "Use herdr_watch to prompt a herdr agent or send it keys instead of `herdr agent prompt` or `herdr agent send-keys` in bash. It messages you when the agent is done, idle, or blocked. Until then, end your turn or keep working, and don't poll the agent with `herdr agent get`, `read`, or `wait`.",
      "To prompt several herdr agents at once, call herdr_watch once per agent in parallel.",
    ],
    parameters: Params,
    async execute(_toolCallId, params, signal) {
      const command = commandOf(params);
      const { pane } = await agentOf(params.agent, signal);

      return serial(pane, () => watchPane(pane, command, signal));
    },
  });

  pi.registerTool(tool);

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

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }], details: undefined };
}

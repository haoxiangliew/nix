/**
 * Wakes pi when a herdr agent that pi prompted stops working, so pi doesn't poll. Before a bash call
 * runs `herdr agent prompt` without --wait, it subscribes to that agent's status on herdr's event
 * socket. When the agent settles or needs input, it sends a message with its state, and pi reads the
 * output itself. If watching stops first, the message says so. No settings.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createConnection, type Socket } from "node:net";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { errorMessage } from "./lib/settings.ts";

const HERDR_TIMEOUT_MS = 2000;

const WIDGET = "herdr-agents";

const SETTLED = new Set(["idle", "done", "blocked"]);

// Keys answer a blocked agent, so they need a message like a prompt does.
const ACTIONS = new Set(["start", "prompt", "send-keys"]);

const VALUE_OPTIONS = new Set(["--until", "--timeout", "--pane", "--kind"]);

// Wrappers and shell keywords that run the next word as the command.
const WRAPPERS = new Set([
  "command",
  "env",
  "exec",
  "nohup",
  "time",
  "do",
  "then",
  "else",
  "elif",
  "{",
  "!",
]);

// Comments, double-quoted words, single-quoted words, command separators, and bare words.
const TOKEN = /(?<=^|\s)#[^\n]*|"((?:[^"\\]|\\.)*)"|'([^']*)'|(&&|\|\||[;|&\n])|([^\s"';|&]+)/g;

const RULE =
  "After you prompt a herdr agent without `--wait`, or answer it with `herdr agent send-keys`, an extension tracks its state for you through herdr's event socket. It messages you when the agent is done, idle, or blocked on input. It also messages you if it stops watching, for example because the agent exited, or can't watch at all. It doesn't watch `herdr --machine` prompts. Don't poll a watched agent with `sleep`, `herdr agent get`, `herdr agent read`, or `herdr agent wait` while you wait. End your turn or keep working instead. After the message, read the agent's output with `herdr agent read`.";

const socketPath = process.env.HERDR_ENV === "1" ? process.env.HERDR_SOCKET_PATH : undefined;

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

interface HerdrCall {
  action: string;
  target?: string;
  pane?: string;
  wait: boolean;
}

interface Armed {
  pane: string;
  before: Pick<Watch, "name" | "armed" | "active" | "status" | "since">;
}

interface Agent {
  pane: string;
  name?: string;
  // An agent started in the same command has no status yet.
  status?: string;
}

// Matches herdr's own --wait, which gives up on a prompt that shows no activity in this time.
const STALL_MS = 5000;

// A heredoc and its body, up to the line with its closing word. The body is text, not commands.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\t*\2(?=\n|$)/g;

interface Watch {
  name?: string;
  // Waiting for a message about the last prompt.
  armed: boolean;
  // Worked since the last prompt, so a settled state means the prompt finished.
  active: boolean;
  status: string;
  since: number;
  socket: Socket;
}

// Splits a shell command into the arguments of each simple command. Quotes group words.
function simpleCommands(command: string): string[][] {
  const commands: string[][] = [[]];

  for (const [token, double, single, separator, word] of command
    .replaceAll(HEREDOC, "$3")
    .replaceAll("\\\n", " ")
    .matchAll(TOKEN)) {
    if (separator !== undefined) {
      commands.push([]);
    } else if (!token.startsWith("#")) {
      commands.at(-1)?.push(double ?? single ?? word ?? "");
    }
  }

  return commands;
}

// Returns how many values the option takes.
function readOption(
  call: Omit<HerdrCall, "action">,
  arg: string,
  next: string | undefined,
): number {
  if (arg === "--wait" || arg === "--until") {
    call.wait = true;
  }

  if (arg === "--pane") {
    call.pane = next;
  }

  return VALUE_OPTIONS.has(arg) ? 1 : 0;
}

// A prompt's text follows its target and can look like an option, so it's skipped.
function parseOptions(args: string[], hasText: boolean): Omit<HerdrCall, "action"> {
  const call: Omit<HerdrCall, "action"> = { wait: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--") {
      break;
    }

    if (call.target === undefined && !arg.startsWith("-")) {
      call.target = arg;
      index += hasText ? 1 : 0;
    } else {
      index += readOption(call, arg, args[index + 1]);
    }
  }

  return call;
}

// Skips variable assignments and wrappers such as `env` and `timeout 60`.
function commandStart(args: string[]): number {
  let index = 0;

  while (index < args.length) {
    const arg = args[index] ?? "";

    if (arg === "timeout") {
      index += 2;
    } else if (WRAPPERS.has(arg) || /^[A-Za-z_]\w*=/.test(arg)) {
      index += 1;
    } else {
      return index;
    }
  }

  return index;
}

// --machine targets another server, so `herdr --machine x agent …` doesn't match.
function herdrCall(args: string[]): HerdrCall | undefined {
  const at = commandStart(args);
  // A subshell can start with `(herdr`.
  const program = (args[at] ?? "").replace(/^\(+/, "");
  const [group, action, ...rest] = args.slice(at + 1);

  if (program !== "herdr" && !program.endsWith("/herdr")) {
    return undefined;
  }

  if (group !== "agent" || !ACTIONS.has(action ?? "")) {
    return undefined;
  }

  return { action: action ?? "", ...parseOptions(rest, action === "prompt") };
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

// A just-started agent reports idle before it gets the prompt, so a settled state counts only
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

export default function (pi: ExtensionAPI) {
  const watches = new Map<string, Watch>();
  // Panes each bash call armed, with their watch from before, restored if the call never ran.
  const pending = new Map<string, Armed[]>();
  const openings = new Map<string, Promise<Watch>>();
  let context: ExtensionContext | undefined;
  let live = false;
  let shown = false;
  let tui: TUI | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;

  // The model waits for these messages instead of polling, so problems go to it too.
  function tell(content: string): void {
    if (live) {
      pi.sendMessage(
        { customType: "herdr-agent", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }
  }

  function label(pane: string, watch: Watch | undefined): string {
    return watch?.name === undefined ? `\`${pane}\`` : `\`${watch.name}\` (\`${pane}\`)`;
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

  // Tells the model when a watch it relies on ends without a result.
  function stop(pane: string, reason: string): void {
    const watch = watches.get(pane);

    if (watch?.armed === true) {
      tell(`Stopped watching herdr agent ${label(pane, watch)}: ${reason}. Check on it yourself.`);
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

    watch.status = status;
    watch.active = watch.active || status === "working";

    if (finished(watch, status)) {
      watch.armed = false;
      tell(`Herdr agent ${label(pane, watch)} is ${status}.`);
    }

    refresh();
  }

  async function agentOf(target: string): Promise<Agent> {
    const result = await pi.exec("herdr", ["agent", "get", target], { timeout: HERDR_TIMEOUT_MS });

    if (result.code !== 0) {
      throw new Error(`herdr agent get ${target} failed: ${result.stderr.trim()}`);
    }

    const parsed: unknown = JSON.parse(result.stdout);

    if (!Value.Check(AgentGet, parsed)) {
      throw new Error(`unexpected herdr agent get output: ${result.stdout.slice(0, 200)}`);
    }

    const { pane_id: pane, name, agent_status: status } = parsed.result.agent;

    return { pane, name, status };
  }

  // A prompt that the agent never acts on, because it failed or got lost, would otherwise leave
  // the model waiting for good.
  function checkStall(pane: string, watch: Watch, since: number): void {
    setTimeout(() => {
      if (watch.armed && !watch.active && watch.since === since && watches.get(pane) === watch) {
        watch.armed = false;
        tell(
          `Herdr agent ${label(pane, watch)} didn't start working within ${STALL_MS / 1000} seconds, so it may not have the prompt. Check on it yourself.`,
        );
        refresh();
      }
    }, STALL_MS).unref();
  }

  // A prompt with --wait returns once the agent settles, so it needs no message.
  function disarm(target: string): void {
    for (const [pane, watch] of watches) {
      if (pane === target || watch.name === target) {
        watch.armed = false;
      }
    }
  }

  async function open(path: string, pane: string): Promise<Watch> {
    const socket = await subscribe(
      path,
      pane,
      (line) => onEvent(pane, line),
      (error) => stop(pane, error.message),
    );

    const watch: Watch = { armed: false, active: false, status: "unknown", since: 0, socket };

    // A clean close, such as a herdr restart, sends no error. A newer watch of the pane stays.
    socket.on("close", () => {
      if (watches.get(pane) === watch) {
        stop(pane, "herdr closed the connection");
      }
    });

    watches.set(pane, watch);

    return watch;
  }

  // Nested calls from a codemode script can run at once, so they share a subscription that's still
  // opening instead of each opening their own.
  function watchOf(path: string, pane: string): Promise<Watch> {
    const watch = watches.get(pane);

    if (watch !== undefined) {
      return Promise.resolve(watch);
    }

    const opening = openings.get(pane) ?? open(path, pane).finally(() => openings.delete(pane));

    openings.set(pane, opening);

    return opening;
  }

  async function arm(
    path: string,
    agent: Agent,
    action: string,
    toolCallId: string,
  ): Promise<void> {
    const watch = await watchOf(path, agent.pane);
    const { name, armed, active, status, since } = watch;
    const before = { name, armed, active, status, since };

    pending.set(toolCallId, [...(pending.get(toolCallId) ?? []), { pane: agent.pane, before }]);

    // herdr refuses a prompt to a blocked agent, but keys answer it. So after keys, a blocked agent
    // counts as active, and an Esc that leaves it idle still reports.
    const answered = action === "send-keys" && agent.status === "blocked";

    watch.name = agent.name;
    watch.armed = true;
    watch.active = agent.status === "working" || answered;
    watch.status = "prompted";
    watch.since = Date.now();
  }

  async function watchCommand(path: string, command: string, toolCallId: string): Promise<void> {
    // An agent started earlier in the same command doesn't exist yet, so --pane gives its pane.
    const started = new Map<string, string>();

    for (const call of simpleCommands(command).map(herdrCall)) {
      if (call?.target === undefined) {
        continue;
      }

      const startedPane = started.get(call.target);

      if (call.action === "start" && call.pane !== undefined) {
        started.set(call.target, call.pane);
      } else if (call.wait) {
        disarm(call.target);
      } else if (call.action !== "start") {
        const agent =
          startedPane === undefined
            ? await agentOf(call.target)
            : { pane: startedPane, name: call.target };

        await arm(path, agent, call.action, toolCallId);
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    live = true;
  });

  pi.on("session_shutdown", async () => {
    live = false;
    [...watches.keys()].forEach(unwatch);
    pending.clear();
    context = undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const options = event.systemPromptOptions;

    if (socketPath !== undefined && options.selectedTools.includes("bash")) {
      (options.toolGuidelines["bash"] ??= []).push(RULE);
    }
  });

  // Watching is best effort, so a failure tells the model to check on its agents instead of
  // blocking the command.
  pi.on("tool_call", async (event) => {
    if (socketPath === undefined || !isToolCallEventType("bash", event)) {
      return;
    }

    try {
      await watchCommand(socketPath, event.input.command, event.toolCallId);
    } catch (error) {
      tell(
        `Couldn't watch the herdr agents in this command: ${errorMessage(error)}. Check on them yourself.`,
      );
    }

    refresh();
  });

  // Unlike tool_result, this also fires for calls a hook blocked or the user aborted. Those never
  // ran, so they sent no prompts. A call that ran and failed may have sent them, so those watches
  // stay and the model hears why.
  pi.on("tool_execution_end", async (event) => {
    const armed = pending.get(event.toolCallId) ?? [];

    pending.delete(event.toolCallId);

    for (const { pane, before } of armed) {
      const watch = watches.get(pane);

      if (watch === undefined) {
        continue;
      }

      // A call that never ran sent no prompt, so the watch goes back to how it was, which keeps an
      // earlier prompt's watch.
      if (event.durationMs === undefined) {
        Object.assign(watch, before);
      } else {
        checkStall(pane, watch, watch.since);
      }
    }

    refresh();
  });
}

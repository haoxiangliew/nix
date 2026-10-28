/**
 * Tools that let pi run agents in Rex panes without calling the rex CLI from bash. Agents report
 * their state to Rex with OSC 7501, which these tools watch.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Type, type Static } from "typebox";

import { matchedOutput, text, trimRead } from "./lib/agent-output.ts";
import {
  KEYS_SETTLE_MS,
  STALL_MS,
  createWatcher,
  label,
  requestOf,
  targetLabel,
  type Agent,
} from "./lib/agent-watch.ts";
import { multiplexer } from "./lib/multiplexer.ts";
import { orCleanUp, splitSide } from "./lib/panes.ts";
import { tildify, untildify } from "./lib/paths.ts";
import {
  BlockList,
  Created,
  Modes,
  Process,
  ProgramStatus,
  Pwd,
  REX_TIMEOUT_MS,
  RexError,
  Size,
  rex,
  rexJson,
  firstBlock,
  rootRecord,
  paneStatus,
  subscribe,
  type BlockInfo,
  type StatusRecord,
} from "./lib/rex.ts";
import { errorMessage } from "./lib/settings.ts";

// A prompt is pasted, so a long one takes longer than a lookup.
const SEND_TIMEOUT_MS = 15_000;

// Capture returns the whole scrollback, which can be large.
const CAPTURE_TIMEOUT_MS = 10_000;

// How long a new agent gets to report its first state.
const START_TIMEOUT_MS = 30_000;

const START_CHECK_MS = 250;

// How long a new pane's shell gets to start reading input.
const SHELL_TIMEOUT_MS = 10_000;

// How many panes rex_agents looks up at once. Each lookup runs up to three rex commands.
const LOOKUP_BATCH = 4;

// The terminal mode a shell turns on while it reads a command.
const BRACKETED_PASTE = 2004;

// How often rex_run reads the pane while it waits for `wait_for`.
const OUTPUT_CHECK_MS = 500;

// Each check captures the whole scrollback, so the wait between checks doubles up to this.
const MAX_OUTPUT_CHECK_MS = 5000;

// What rex_start says about an agent that can't take its first prompt yet.
const NOT_READY = new Map([
  ["blocked", "is blocked during startup"],
  ["error", "failed during startup"],
]);

const session = multiplexer === "rex" ? process.env.REX_SESSION : undefined;

const ownBlock = process.env.REX_BLOCK;

// Rex names the escape key `escape`, but `esc` is what a model is likely to send.
const KEY_ALIASES = new Map([["esc", "escape"]]);

const NAME_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";

const AgentParam = Type.String({
  description: "Unique live agent name or the block ID of the pane hosting the agent",
});

const WatchParams = Type.Object({
  agent: AgentParam,
  prompt: Type.Optional(Type.String({ description: "Text to submit to the agent" })),
  keys: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Keys to send instead of a prompt, such as `escape` to interrupt, `enter`, or `down`. Join modifiers with `+`. `ctrl+c` can quit the agent.",
    }),
  ),
});

const Placement = Type.Optional(
  Type.Union([Type.Literal("split"), Type.Literal("tab")], {
    description: "`split` (default) splits your pane. `tab` opens a new tab in your session.",
  }),
);

const CwdParam = Type.Optional(
  Type.String({ description: "Working directory. Default your own." }),
);

const StartParams = Type.Object({
  name: Type.String({
    pattern: NAME_PATTERN,
    description: "Unique agent name, such as `reviewer`",
  }),
  kind: Type.Optional(
    Type.String({
      description: "Agent command, such as `pi`, `claude`, or `codex`. Default `pi`.",
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "First task for the agent" })),
  placement: Placement,
  cwd: CwdParam,
  args: Type.Optional(
    Type.Array(Type.String(), { description: "Arguments for the agent's own command line" }),
  ),
});

const TargetParam = Type.String({
  description: "Agent name, or the block ID of any pane, such as one rex_run opened",
});

const ReadParams = Type.Object({
  target: TargetParam,
  lines: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 1000, description: "Lines to read. Default 120." }),
  ),
});

const TargetParams = Type.Object({ target: TargetParam });

const RunParams = Type.Object({
  command: Type.String({ description: "Shell command to run" }),
  label: Type.Optional(
    Type.String({
      pattern: NAME_PATTERN,
      description: "Unique name for the pane, and its tab if it gets one",
    }),
  ),
  placement: Placement,
  cwd: CwdParam,
  wait_for: Type.Optional(
    Type.String({
      description:
        "JavaScript regular expression to wait for in the output, such as `listening on`",
    }),
  ),
  timeout_seconds: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 600,
      description: "How long to wait for `wait_for`. Default 60.",
    }),
  ),
});

interface Placed {
  pane: string;
  where: string;
}

type Target = { kind: "agent"; pane: string; name?: string } | { kind: "pane"; pane: string };

// The pane also shows the prompt and shell startup output, such as direnv's, so only lines after
// the typed command count. The shell shows each line of a multi-line command, in order. Returns
// undefined while the screen doesn't show the whole command.
function outputLines(screen: string, command: string): string[] | undefined {
  const lines = screen.split("\n");
  let at = -1;

  for (const typed of command.split("\n").filter((line) => line.trim() !== "")) {
    at = lines.findIndex((line, index) => index > at && line.includes(typed));

    if (at === -1) {
      return undefined;
    }
  }

  return lines.slice(at + 1);
}

// A command that clears the screen clears the prompt and startup output too, so once `marker`, the
// first line shown before the command, is gone, the whole screen is output.
function outputOf(screen: string, command: string, marker: string | undefined): string[] {
  const after = outputLines(screen, command);

  if (after !== undefined) {
    return after;
  }

  return marker !== undefined && !screen.includes(marker) ? screen.split("\n") : [];
}

async function inBatches<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];

  for (let start = 0; start < items.length; start += LOOKUP_BATCH) {
    results.push(...(await Promise.all(items.slice(start, start + LOOKUP_BATCH).map(task))));
  }

  return results;
}

function cwdOf(pwd: string | undefined): string {
  if (pwd === undefined) {
    return "";
  }

  // OSC 7 URLs carry the host, which fileURLToPath rejects on macOS.
  return tildify(pwd.startsWith("file://") ? decodeURIComponent(new URL(pwd).pathname) : pwd);
}

function agentLine(block: BlockInfo, app: string, state: string, cwd: string): string {
  const own = block.block_id === ownBlock ? " (you)" : "";

  return [`${block.label ?? "-"}${own}`, block.block_id, app, state, cwd].join("  ");
}

export default function (pi: ExtensionAPI) {
  if (session === undefined || ownBlock === undefined) {
    return;
  }

  const own = ownBlock;
  const sessionId = session;
  const inSession = ["-s", sessionId];

  function run(args: string[], timeout?: number, signal?: AbortSignal): Promise<string> {
    return rex(pi, args, timeout, signal);
  }

  async function blocks(signal?: AbortSignal): Promise<BlockInfo[]> {
    const args = ["block", "ls", ...inSession, "--json"];

    return (await rexJson(pi, BlockList, args, REX_TIMEOUT_MS, signal)).blocks;
  }

  // Names are block labels, which Rex doesn't keep unique.
  async function blockOf(target: string, signal?: AbortSignal): Promise<BlockInfo> {
    const all = await blocks(signal);

    // Block IDs contain `:` and names pi gives panes don't. A label with `:` set in Rex itself can
    // only be reached by its block ID.
    const byId = target.includes(":");

    const [found, ...others] = all.filter((block) =>
      byId ? block.block_id === target : block.label === target,
    );

    if (found === undefined) {
      throw new RexError(
        `This Rex session has no pane \`${target}\`. List agents with rex_agents.`,
        true,
      );
    }

    if (others.length > 0) {
      throw new Error(`Several panes are named \`${target}\`. Use a block ID from rex_agents.`);
    }

    return found;
  }

  function programStatus(pane: string, signal?: AbortSignal) {
    const call = ["block", "call", ...inSession, "-b", pane, "program_status"];

    return rexJson(pi, ProgramStatus, call, REX_TIMEOUT_MS, signal);
  }

  // A done or error record outlives its program, so a record counts only while the process that
  // reported it is still in the foreground. Otherwise input would go to the shell instead.
  async function liveRecord(pane: string, signal?: AbortSignal): Promise<StatusRecord | undefined> {
    const call = ["block", "call", ...inSession, "-b", pane, "process"];

    const [status, process] = await Promise.all([
      programStatus(pane, signal),
      rexJson(pi, Process, call, REX_TIMEOUT_MS, signal),
    ]);

    const root = rootRecord(status);
    const owner = root?.owner?.pid;

    return owner !== undefined && owner === process.foreground?.pid ? root : undefined;
  }

  async function stateOf(pane: string, signal?: AbortSignal): Promise<string | undefined> {
    return (await liveRecord(pane, signal))?.state;
  }

  async function agentOf(target: string, signal?: AbortSignal): Promise<Agent> {
    const { block_id: pane, label: name } = await blockOf(target, signal);
    const status = await stateOf(pane, signal);

    if (status === undefined) {
      throw new RexError(
        `Pane ${label(pane, name)} runs no agent that reports its state to Rex. List agents with rex_agents.`,
        true,
      );
    }

    return { pane, name, status };
  }

  // A paste keeps a multi-line prompt in one message, and Enter submits it.
  async function submit(pane: string, prompt: string, signal?: AbortSignal): Promise<void> {
    const event = { type: "paste", payload: { text: prompt } };
    const params = JSON.stringify({ session_id: sessionId, block_id: pane, event });

    await run(["api", "call", "block.event", params], SEND_TIMEOUT_MS, signal);
    await run(["send-key", ...inSession, "-b", pane, "enter"], SEND_TIMEOUT_MS, signal);
  }

  function capture(pane: string, signal: AbortSignal | undefined): Promise<string> {
    const args = ["capture", ...inSession, "-b", pane, "--trim", "--unwrap"];

    return run(args, CAPTURE_TIMEOUT_MS, signal);
  }

  const { serial, unwatch, withoutWatch, runRequest, promptPane } = createWatcher(pi, {
    title: "Rex",
    tools: "rex",
    agentOf,
    exited: (error) => error instanceof RexError && error.notFound,
    // Events report only changes, so the records from before the stream started come from a lookup.
    // Without them, a dialog that closes would leave the agent blocked.
    subscribe: async (pane, onEvent, onFail) => {
      const status = paneStatus();

      const subscription = await subscribe(
        sessionId,
        (event) => {
          const update = event.block === pane ? status.update(event) : undefined;

          if (update !== undefined) {
            onEvent(update);
          }
        },
        onFail,
      );

      const { records } = await orCleanUp(
        () => programStatus(pane),
        async () => subscription.close(),
        "Closing the event stream",
      );

      status.seed(records);

      return subscription;
    },
    prompt: submit,
    keys: async (pane, keys, signal) => {
      const sent = keys.map((key) => KEY_ALIASES.get(key) ?? key);

      await run(["send-key", ...inSession, "-b", pane, ...sent], SEND_TIMEOUT_MS, signal);
    },
    screen: capture,
  });

  async function splitDirection(signal: AbortSignal | undefined): Promise<string> {
    const args = ["block", "call", ...inSession, "-b", own, "size"];
    const { columns, rows } = await rexJson(pi, Size, args, REX_TIMEOUT_MS, signal);

    return splitSide(columns, rows, "rex") === "right" ? "right" : "below";
  }

  // Parallel starts split pi's pane one at a time, so each sees the layout the last one left.
  // Without a command, the pane runs the user's shell.
  function splitPane(
    name: string | undefined,
    cwd: string,
    command: string[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return serial(`split ${own}`, async () => {
      const where = ["-b", own, "--split", await splitDirection(signal)];
      const labeled = name === undefined ? [] : ["--label", name];
      const args = ["split", ...inSession, ...where, ...labeled, "--focus=false", "-c", cwd];

      const created = await rexJson(
        pi,
        Created,
        [...args, "--json", ...command],
        REX_TIMEOUT_MS,
        signal,
      );

      return firstBlock(created);
    });
  }

  // The name labels both the tab and its pane.
  async function createTab(
    name: string | undefined,
    cwd: string,
    command: string[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const labeled = name === undefined ? [] : [name];
    const args = ["window", "new", ...inSession, ...labeled, "--focus=false", "-c", cwd, "--json"];
    const created = await rexJson(pi, Created, [...args, ...command], REX_TIMEOUT_MS, signal);
    const pane = firstBlock(created);

    if (name !== undefined) {
      await orClose(pane, () =>
        run(["block", "rename", ...inSession, pane, name], REX_TIMEOUT_MS, signal),
      );
    }

    return pane;
  }

  // Rex doesn't keep labels unique, so parallel calls check and take a name one at a time.
  function openNamed(
    name: string,
    placement: "split" | "tab" | undefined,
    cwd: string,
    command: string[],
    signal: AbortSignal | undefined,
  ): Promise<Placed> {
    return serial("names", async () => {
      await checkName(name, signal);

      return openPane(name, placement, cwd, command, signal);
    });
  }

  // Without a name, the pane keeps Rex's default label.
  async function openPane(
    name: string | undefined,
    placement: "split" | "tab" | undefined,
    cwd: string,
    command: string[],
    signal: AbortSignal | undefined,
  ): Promise<Placed> {
    const argv = command.length === 0 ? [] : ["--", ...command];

    return placement === "tab"
      ? { pane: await createTab(name, cwd, argv, signal), where: "a new tab" }
      : { pane: await splitPane(name, cwd, argv, signal), where: "a new pane" };
  }

  async function checkName(name: string, signal: AbortSignal | undefined): Promise<void> {
    const taken = (await blocks(signal)).find((block) => block.label === name);

    if (taken !== undefined) {
      throw new Error(
        `A Rex pane named \`${name}\` already exists, ${taken.block_id}. Pick another name.`,
      );
    }
  }

  // A failed call leaves a pane it opened, which this closes before it rethrows. The pane may have
  // closed already, when its program exited.
  function orClose<T>(pane: string, task: () => Promise<T>): Promise<T> {
    const cleanUp = async () => {
      await run(["block", "close", ...inSession, pane]).catch((cause: unknown) => {
        if (!(cause instanceof RexError && cause.notFound)) {
          throw cause;
        }
      });
    };

    return orCleanUp(task, cleanUp, `Closing pane ${pane}`);
  }

  // Returns the agent's first state, or undefined if it reports none in time, as when it shows a
  // startup dialog before its interface. A pane that closes means the agent exited.
  async function firstState(
    pane: string,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const deadline = Date.now() + START_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const state = await stateOf(pane, signal).catch((cause: unknown) => {
        throw cause instanceof RexError && cause.notFound
          ? new Error("The agent exited during startup.", { cause })
          : cause;
      });

      if (state !== undefined) {
        return state;
      }

      await sleep(START_CHECK_MS, undefined, { signal });
    }

    return undefined;
  }

  async function targetOf(target: string, signal: AbortSignal | undefined): Promise<Target> {
    const { block_id: pane, label: name } = await blockOf(target, signal);

    return (await stateOf(pane, signal)) === undefined
      ? { kind: "pane", pane }
      : { kind: "agent", pane, name };
  }

  // Shells turn on bracketed paste while they read a command. The terminal would echo input typed
  // before that, and the shell would show it again on its prompt.
  async function shellReady(pane: string, signal: AbortSignal | undefined): Promise<void> {
    const args = ["block", "call", ...inSession, "-b", pane, "modes"];
    const deadline = Date.now() + SHELL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const { modes } = await rexJson(pi, Modes, args, REX_TIMEOUT_MS, signal);

      if (modes.some((mode) => mode.number === BRACKETED_PASTE && mode.set)) {
        return;
      }

      await sleep(START_CHECK_MS, undefined, { signal });
    }

    throw new Error(
      `The shell in pane ${pane} didn't start reading input within ${SHELL_TIMEOUT_MS / 1000} seconds.`,
    );
  }

  async function waitOutput(
    pane: string,
    command: string,
    marker: string | undefined,
    pattern: RegExp,
    seconds: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const deadline = Date.now() + seconds * 1000;
    let delay = OUTPUT_CHECK_MS;

    while (Date.now() < deadline) {
      const screen = await capture(pane, signal);
      const line = outputOf(screen, command, marker).find((output) => pattern.test(output));

      if (line !== undefined) {
        return line;
      }

      await sleep(delay, undefined, { signal });
      delay = Math.min(delay * 2, MAX_OUTPUT_CHECK_MS);
    }

    throw new Error(`no line matched \`${pattern.source}\` within ${seconds} seconds`);
  }

  async function runInPane(
    params: Static<typeof RunParams>,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const pattern = params.wait_for === undefined ? undefined : new RegExp(params.wait_for);

    const { label: name, placement } = params;

    const { pane, where } = await (name === undefined
      ? openPane(undefined, placement, cwd, [], signal)
      : openNamed(name, placement, cwd, [], signal));

    // The shell runs it like a typed command, so the user's shell setup, such as direnv, applies.
    const marker = await orClose(pane, async () => {
      await shellReady(pane, signal);

      const prompt = await capture(pane, signal);

      await run(["send", ...inSession, "-b", pane, "--", params.command], SEND_TIMEOUT_MS, signal);
      await run(["send-key", ...inSession, "-b", pane, "enter"], SEND_TIMEOUT_MS, signal);

      return prompt.split("\n").find((line) => line.trim() !== "");
    });

    const running = `Running \`${params.command}\` in pane \`${pane}\`, in ${where}.`;

    if (pattern === undefined) {
      return `${running} Read its output with rex_read, and close it with rex_close.`;
    }

    const seconds = params.timeout_seconds ?? 60;

    return matchedOutput(running, pattern.source, "rex", () =>
      waitOutput(pane, params.command, marker, pattern, seconds, signal),
    );
  }

  async function startAgent(
    params: Static<typeof StartParams>,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<{ pane: string; started: string; state: string | undefined }> {
    const kind = params.kind ?? "pi";
    const command = [kind, ...(params.args ?? [])];
    const { pane, where } = await openNamed(params.name, params.placement, cwd, command, signal);

    const started = `Started ${kind} agent ${label(pane, params.name)} in ${where}.`;
    const state = await orClose(pane, () => firstState(pane, signal));

    return { pane, started, state };
  }

  const startTool = defineTool({
    name: "rex_start",
    label: "Rex Start",
    description:
      "Start a coding agent in a new Rex pane next to yours or in a new tab, and optionally give it its first task. With a prompt, you get a message when the agent is done, idle, blocked, or failed. A prompt that starts with `/` instead returns the agent's state and screen, like rex_watch. The user's focus stays where it is. The pane closes when the agent exits.",
    promptSnippet: "Start an agent in a new Rex pane or tab, with an optional first task",
    promptGuidelines: [
      "Use the rex_* tools to run agents and commands in Rex panes instead of the rex CLI.",
      'Start Rex agents with rex_start, with a short unique name and the first task as `prompt`. Use `placement: "tab"` only when the user asks for a tab. Give work in one checkout to subagents unless the user asks for a Rex agent.',
    ],
    parameters: StartParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = resolve(ctx.cwd, untildify(params.cwd ?? "."));
      const { pane, started, state } = await startAgent(params, cwd, signal);

      const problem =
        state === undefined ? "hasn't reported that it's ready" : NOT_READY.get(state);

      if (problem !== undefined) {
        return text(
          `${started} It ${problem}, so it didn't get a prompt. Read it with rex_read, and ask the user what to do.`,
        );
      }

      const { prompt } = params;

      if (prompt === undefined) {
        return text(`${started} Give it a task with rex_watch.`);
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
    name: "rex_watch",
    label: "Rex Watch",
    description: `Prompt a Rex agent or send it keys. A prompt returns right away, and you get a message when the agent is done, idle, blocked, or failed. Keys wait ${KEYS_SETTLE_MS / 1000} seconds, then return the agent's state and screen. So does a prompt that starts with \`/\`, after up to ${STALL_MS / 1000} seconds for the agent to start working. With only \`agent\`, wait on an agent that's already working.`,
    promptSnippet: "Prompt a Rex agent or send it keys, and get a message when it settles",
    promptGuidelines: [
      "After you prompt a Rex agent, end your turn or keep working until its message arrives. Don't poll it with rex_read, bash, or `sleep`. Keys and slash commands return the agent's state and screen, so don't check on it after them.",
      "To prompt several Rex agents at once, call rex_watch once per agent in parallel.",
      "When a Rex agent is blocked on an approval or a question, read it with rex_read and ask the user before you answer it with keys.",
    ],
    parameters: WatchParams,
    async execute(_toolCallId, params, signal) {
      const request = requestOf(params);
      const { pane } = await agentOf(params.agent, signal);

      return text(await serial(pane, () => runRequest(pane, request, signal)));
    },
  });

  async function readPane(
    target: Target,
    lines: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const output = trimRead(await capture(target.pane, signal), lines);

    if (target.kind === "pane") {
      return `Pane \`${target.pane}\` runs no agent.${output}`;
    }

    const status = (await stateOf(target.pane, signal)) ?? "gone";

    return `Rex agent ${label(target.pane, target.name)} is ${status}.${output}`;
  }

  const readTool = defineTool({
    name: "rex_read",
    label: "Rex Read",
    description:
      "Read a Rex agent's state and recent output, or any pane's output, without blank lines. Read an agent after its message arrives.",
    promptSnippet: "Read a Rex agent's state and recent output, or a pane's output",
    promptGuidelines: [
      "If rex_read doesn't show a Rex agent's whole response, ask the agent to write it to a file and reply with the path, then read the file.",
    ],
    parameters: ReadParams,
    async execute(_toolCallId, params, signal) {
      const target = await targetOf(params.target, signal);

      return text(await serial(target.pane, () => readPane(target, params.lines ?? 120, signal)));
    },
  });

  // A pane can close between the listing and these calls, as when its agent exits, so it's skipped.
  async function agentRow(block: BlockInfo, signal: AbortSignal | undefined) {
    const call = ["block", "call", ...inSession, "-b", block.block_id];

    const row = async () => {
      const root = await liveRecord(block.block_id, signal);

      if (root === undefined) {
        return undefined;
      }

      const pwd = await rexJson(pi, Pwd, [...call, "pwd"], REX_TIMEOUT_MS, signal);

      return agentLine(block, root.effective_app ?? "-", root.state, cwdOf(pwd.pwd));
    };

    return row().catch((cause: unknown) => {
      if (cause instanceof RexError && cause.notFound) {
        return undefined;
      }

      throw cause;
    });
  }

  const agentsTool = defineTool({
    name: "rex_agents",
    label: "Rex Agents",
    description:
      "List the agents in this Rex session's panes, which are the programs that report their state to Rex: name, block ID, program, state, and working directory. `(you)` marks your own pane.",
    promptSnippet: "List the agents running in Rex",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const rows = await inBatches(await blocks(signal), (block) => agentRow(block, signal));

      const lines = rows.filter((row) => row !== undefined);

      return text(
        lines.length === 0 ? "No agents are running in this Rex session." : lines.join("\n"),
      );
    },
  });

  const closeTool = defineTool({
    name: "rex_close",
    label: "Rex Close",
    description: "Close a Rex pane, which ends the agent or command running in it.",
    promptSnippet: "Close a Rex agent's or command's pane",
    promptGuidelines: [
      "Close only Rex agents and panes you started, unless the user asks you to close others.",
    ],
    parameters: TargetParams,
    async execute(_toolCallId, params, signal) {
      const target = await targetOf(params.target, signal);
      const { pane } = target;

      if (pane === own) {
        throw new Error("That's your own pane.");
      }

      await serial(pane, async () => {
        await withoutWatch(pane, () =>
          run(["block", "close", ...inSession, pane], REX_TIMEOUT_MS, signal),
        );
        unwatch(pane);
      });

      return text(
        `Closed ${targetLabel("Rex", target)}${target.kind === "agent" ? " and its pane" : ""}.`,
      );
    },
  });

  const runTool = defineTool({
    name: "rex_run",
    label: "Rex Run",
    description:
      "Run a shell command in a new Rex pane next to yours, or in a new tab, where the user can watch it. With `wait_for`, wait until its output matches. The user's focus stays where it is.",
    promptSnippet: "Run a command in a new Rex pane the user can watch",
    promptGuidelines: [
      "Use rex_run for a command the user should see in Rex, such as a dev server. Run commands only you need with bash or background tasks.",
    ],
    parameters: RunParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = resolve(ctx.cwd, untildify(params.cwd ?? "."));

      return text(await runInPane(params, cwd, signal));
    },
  });

  const focusTool = defineTool({
    name: "rex_focus",
    label: "Rex Focus",
    description: "Switch the user's Rex view to an agent's or command's pane.",
    promptSnippet: "Switch the user's Rex view to a pane",
    promptGuidelines: ["Use rex_focus only when the user asks to see an agent or pane."],
    parameters: TargetParams,
    async execute(_toolCallId, params, signal) {
      const target = await targetOf(params.target, signal);

      await run(["block", "focus", ...inSession, target.pane], REX_TIMEOUT_MS, signal);

      return text(`Focused ${targetLabel("Rex", target)}.`);
    },
  });

  pi.registerTool(startTool);
  pi.registerTool(watchTool);
  pi.registerTool(readTool);
  pi.registerTool(agentsTool);
  pi.registerTool(closeTool);
  pi.registerTool(runTool);
  pi.registerTool(focusTool);
}

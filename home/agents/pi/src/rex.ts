/**
 * Tools that let pi run agents in Rex panes without calling the rex CLI from bash. Agents report
 * their state to Rex with OSC 7501, which these tools watch. Agents can be in any session, and git
 * worktrees open as tabs through worktree.lua, which home/agents/default.nix puts in ~/.config/rex.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Type, type Static, type TSchema } from "typebox";

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
import { CommandError, parseOutput } from "./lib/command.ts";
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
  SessionList,
  SessionView,
  type SessionWindow,
  Size,
  WorktreeOpened,
  WorktreeRemoved,
  WorktreeState,
  rex,
  rexJson,
  firstBlock,
  rootRecord,
  paneStatus,
  subscribe,
  type StatusRecord,
} from "./lib/rex.ts";
import { errorMessage } from "./lib/settings.ts";
import {
  BaseParam,
  PathParam,
  RemoveParams,
  RepoCwdParam,
  checkWorktreePlacement,
  describeWorktree,
} from "./lib/worktree.ts";

// A prompt is pasted, so a long one takes longer than a lookup.
const SEND_TIMEOUT_MS = 15_000;

// Capture returns the whole scrollback, which can be large.
const CAPTURE_TIMEOUT_MS = 10_000;

// worktree.lua can wait 11 minutes for another call on the same worktree, then give
// `git worktree add` 10 minutes, since it checks out every file. A minute more covers the rest.
const WORKTREE_TIMEOUT_MS = (660 + 600 + 60) * 1000;

// How long a new agent gets to report its first state.
const START_TIMEOUT_MS = 30_000;

const START_CHECK_MS = 250;

// How long a new pane's shell gets to start reading input.
const SHELL_TIMEOUT_MS = 10_000;

// How many panes or sessions the tools look up at once. Each lookup runs up to three rex commands.
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

const CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");

// worktree.lua's exit status for a worktree it won't remove, since it has uncommitted changes.
const DIRTY_EXIT = 10;

// Run as a script, not as the configuration's action, which Rex stops after 30 seconds.
const WORKTREE_SCRIPT = join(CONFIG_HOME, "rex", "worktree.lua");

const REX_STATE = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "rex");

const WORKTREE_STATE = join(REX_STATE, "worktrees.json");

// Rex names the escape key `escape`, but `esc` is what a model is likely to send.
const KEY_ALIASES = new Map([["esc", "escape"]]);

const NAME_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";

const AgentParam = Type.String({
  description:
    "Unique live agent name, `session/name` for one in another Rex session, or the block ID of the pane hosting the agent",
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

const SessionParam = Type.Optional(
  Type.String({
    description: "Rex session to open in, by label or ID. Default yours.",
  }),
);

const TabParam = Type.Optional(
  Type.String({
    description:
      'With `placement: "split"`, the tab whose focused pane to split, by label or window ID. Default your pane, or the active tab of another `session`.',
  }),
);

const RunPlacement = Type.Optional(
  Type.Union([Type.Literal("split"), Type.Literal("tab")], {
    description:
      "`split` (default) splits your pane, or a pane `tab` or `session` names. `tab` opens a new tab in your session or `session`.",
  }),
);

const WorktreeFields = {
  branch: Type.Optional(
    Type.String({
      description:
        "Branch to check out. A new one starts from `base`, and one that only a remote has tracks it.",
    }),
  ),
  base: BaseParam,
  path: PathParam,
};

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
  placement: Type.Optional(
    Type.Union([Type.Literal("split"), Type.Literal("tab"), Type.Literal("worktree")], {
      description:
        "`split` (default) splits your pane, or a pane `tab` or `session` names. `tab` opens a new tab in your session or `session`. `worktree` opens a git worktree of `cwd`'s repository in its own tab, or splits that tab if it's open.",
    }),
  ),
  session: SessionParam,
  tab: TabParam,
  ...WorktreeFields,
  cwd: Type.Optional(
    Type.String({
      description:
        'Working directory. Default your own. With `placement: "worktree"`, any directory in the repository.',
    }),
  ),
  args: Type.Optional(
    Type.Array(Type.String(), { description: "Arguments for the agent's own command line" }),
  ),
});

const WorktreeParams = Type.Object({ ...WorktreeFields, cwd: RepoCwdParam, session: SessionParam });

const TargetParam = Type.String({
  description:
    "Agent name, `session/name` for one in another Rex session, or the block ID of any pane, such as one rex_run opened",
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
  placement: RunPlacement,
  session: SessionParam,
  tab: TabParam,
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

interface Pane {
  block_id: string;
  label?: string;
  // Left out for a detached pane.
  window_id?: string;
  window_label?: string;
  session_id: string;
  session_label?: string;
}

interface Placed {
  pane: string;
  where: string;
}

/** Where a new pane goes: a session, and for a split, the pane it splits. */
interface Location {
  session: string;
  anchor: string;
  // Names the tab or session when it isn't pi's own, for messages.
  elsewhere: string;
}

type Target = { kind: "agent"; pane: string; name?: string } | { kind: "pane"; pane: string };

// The arguments of the worktree.lua actions pi runs.
interface WorktreeActions {
  worktree_open: {
    branch?: string;
    base?: string;
    path?: string;
    cwd: string;
    session?: string;
    label?: string;
    command?: string[];
    focus: boolean;
  };
  worktree_remove: { branch?: string; path?: string; cwd: string; force: boolean };
}

/** A worktree.lua action that failed, with the exit status of the `rex do` that ran it. */
class WorktreeError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

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

// How a name reads from another session.
function qualified(pane: Pane): string {
  return `${pane.session_label ?? pane.session_id}/${pane.label ?? pane.block_id}`;
}

// A tab by label or window ID, or the active tab.
function tabIn(
  { windows, active_window_id: active }: Static<typeof SessionView>,
  named: string,
  tab: string | undefined,
): SessionWindow {
  const [window, ...others] = (windows ?? []).filter((one) =>
    tab === undefined ? one.window_id === active : one.window_id === tab || one.label === tab,
  );

  if (window === undefined || others.length > 0) {
    const why = window === undefined ? "No tab" : "Several tabs";

    throw new Error(`${why} of ${named} ${tab === undefined ? "is active" : `is \`${tab}\``}.`);
  }

  return window;
}

// The worktree each worktree tab shows. worktree.lua writes the file when it opens its first tab, so
// until then there is none.
async function worktreeTabs(): Promise<Map<string, { path: string; branch?: string }>> {
  const json = await readFile(WORKTREE_STATE, "utf8").catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return undefined;
    }

    throw cause;
  });

  if (json === undefined) {
    return new Map();
  }

  return new Map(Object.entries(parseOutput(WorktreeState, json, tildify(WORKTREE_STATE)).windows));
}

// Detached panes are in no tab.
function tabHeading(pane: Pane, worktrees: Map<string, { path: string; branch?: string }>): string {
  if (pane.window_id === undefined) {
    return "Detached panes";
  }

  const worktree = worktrees.get(pane.window_id);
  const shows = worktree === undefined ? "" : `, ${describeWorktree(worktree)}`;

  return `Tab \`${pane.window_label ?? "-"}\` (${pane.window_id}${shows})`;
}

export default function (pi: ExtensionAPI) {
  if (session === undefined || ownBlock === undefined) {
    return;
  }

  const own = ownBlock;
  const sessionId = session;

  // The session of each pane a lookup found. Rex finds a block only in the session it's told.
  const sessionOf = new Map<string, string>([[own, sessionId]]);

  // Names of agents whose worktree is still being made, which checkName treats as taken.
  const reserved = new Set<string>();

  function inSession(pane: string): string[] {
    return ["-s", sessionOf.get(pane) ?? sessionId];
  }

  function run(args: string[], timeout?: number, signal?: AbortSignal): Promise<string> {
    return rex(pi, args, timeout, signal);
  }

  async function sessions(signal?: AbortSignal) {
    return (await rexJson(pi, SessionList, ["ls", "--json"], REX_TIMEOUT_MS, signal)).sessions;
  }

  function view(id: string, signal?: AbortSignal) {
    const args = ["api", "call", "session.view", JSON.stringify({ session_id: id })];

    return rexJson(pi, SessionView, args, REX_TIMEOUT_MS, signal);
  }

  // Every pane in every session, pi's own session first, with detached panes last. A session that
  // closes meanwhile is skipped. With `tabs`, panes are in tab order and have their tab's label,
  // which takes a session.view call per session that finding a pane doesn't need.
  async function panes(signal?: AbortSignal, tabs = false): Promise<Pane[]> {
    const all = await sessions(signal);

    const ordered = [
      ...all.filter((one) => one.session_id === sessionId),
      ...all.filter((one) => one.session_id !== sessionId),
    ];

    const listings = await inBatches(ordered, async (one) => {
      const args = ["block", "ls", "-s", one.session_id, "--json"];

      try {
        const [listed, shown] = await Promise.all([
          rexJson(pi, BlockList, args, REX_TIMEOUT_MS, signal),
          tabs ? view(one.session_id, signal) : undefined,
        ]);

        return { one, blocks: listed.blocks ?? [], windows: shown?.windows ?? [] };
      } catch (cause) {
        if (cause instanceof RexError && cause.notFound) {
          return undefined;
        }

        throw cause;
      }
    });

    return listings.flatMap((listing) => (listing === undefined ? [] : sessionPanes(listing)));
  }

  function sessionPanes({
    one,
    blocks,
    windows,
  }: {
    one: Static<typeof SessionList>["sessions"][number];
    blocks: NonNullable<Static<typeof BlockList>["blocks"]>;
    windows: SessionWindow[];
  }): Pane[] {
    const order = new Map(windows.map((window, index) => [window.window_id, index]));
    const labels = new Map(windows.map((window) => [window.window_id, window.label]));

    const rank = (window?: string) =>
      window === undefined ? windows.length : (order.get(window) ?? windows.length);

    return blocks
      .toSorted((a, b) => rank(a.window_id) - rank(b.window_id))
      .map((block): Pane => {
        sessionOf.set(block.block_id, one.session_id);

        return {
          block_id: block.block_id,
          label: block.label,
          window_id: block.window_id,
          window_label: block.window_id === undefined ? undefined : labels.get(block.window_id),
          session_id: one.session_id,
          session_label: one.label,
        };
      });
  }

  // Names are block labels, which Rex doesn't keep unique. A bare name in pi's session wins,
  // then one in any session. `session/name` picks the session.
  async function blockOf(target: string, signal?: AbortSignal): Promise<Pane> {
    const all = await panes(signal);
    const slash = target.lastIndexOf("/");
    const inOne = slash === -1 ? undefined : target.slice(0, slash);
    const name = slash === -1 ? target : target.slice(slash + 1);

    // Block IDs contain `:` and names pi gives panes don't. A label with `:` set in Rex itself can
    // only be reached by its block ID.
    const byId = name.includes(":");

    const matches = all.filter(
      (pane) =>
        (byId ? pane.block_id === name : pane.label === name) &&
        (inOne === undefined || pane.session_label === inOne || pane.session_id === inOne),
    );

    const mine = matches.filter((pane) => pane.session_id === sessionId);
    const [found, ...others] = inOne === undefined && mine.length > 0 ? mine : matches;

    if (found === undefined) {
      throw new RexError(
        `No Rex session has a pane \`${target}\`. List agents with rex_agents.`,
        true,
      );
    }

    if (others.length > 0) {
      const names = [found, ...others].map((pane) => `\`${qualified(pane)}\` (${pane.block_id})`);

      throw new Error(
        `Several panes are named \`${target}\`: ${names.join(", ")}. Use \`session/name\` or a block ID.`,
      );
    }

    return found;
  }

  function programStatus(pane: string, signal?: AbortSignal) {
    const call = ["block", "call", ...inSession(pane), "-b", pane, "program_status"];

    return rexJson(pi, ProgramStatus, call, REX_TIMEOUT_MS, signal);
  }

  // A done or error record outlives its program, so a record counts only while the process that
  // reported it is still in the foreground. Otherwise input would go to the shell instead.
  async function liveRecord(pane: string, signal?: AbortSignal): Promise<StatusRecord | undefined> {
    const call = ["block", "call", ...inSession(pane), "-b", pane, "process"];

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
    const target = { session_id: sessionOf.get(pane) ?? sessionId, block_id: pane };
    const params = JSON.stringify({ ...target, event });

    await run(["api", "call", "block.event", params], SEND_TIMEOUT_MS, signal);
    await run(["send-key", ...inSession(pane), "-b", pane, "enter"], SEND_TIMEOUT_MS, signal);
  }

  function capture(pane: string, signal: AbortSignal | undefined): Promise<string> {
    const args = ["capture", ...inSession(pane), "-b", pane, "--trim", "--unwrap"];

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
        sessionOf.get(pane) ?? sessionId,
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

      await run(["send-key", ...inSession(pane), "-b", pane, ...sent], SEND_TIMEOUT_MS, signal);
    },
    screen: capture,
  });

  // A session no app shows keeps its panes at 80x24, so a pane in another session splits right
  // without a size check. pi's own session is usually the one the user sees.
  async function splitDirection(anchor: string, signal: AbortSignal | undefined): Promise<string> {
    if ((sessionOf.get(anchor) ?? sessionId) !== sessionId) {
      return "right";
    }

    const args = ["block", "call", ...inSession(anchor), "-b", anchor, "size"];
    const { columns, rows } = await rexJson(pi, Size, args, REX_TIMEOUT_MS, signal);
    const pane = anchor === own ? undefined : `Pane ${anchor}`;

    return splitSide(columns, rows, "rex", pane) === "right" ? "right" : "below";
  }

  // A session by label or ID, or pi's own.
  async function sessionNamed(
    wanted: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ id: string; named: string }> {
    const all = await sessions(signal);
    const target = wanted ?? sessionId;
    const byId = all.find((one) => one.session_id === target);

    const [found, ...others] =
      byId === undefined ? all.filter((one) => one.label === target) : [byId];

    if (found === undefined) {
      throw new Error(`No Rex session is \`${target}\`.`);
    }

    if (others.length > 0) {
      const ids = [found, ...others].map((one) => one.session_id).join(", ");

      throw new Error(`Several Rex sessions are named \`${target}\`: ${ids}. Use a session ID.`);
    }

    return { id: found.session_id, named: `session \`${found.label ?? found.session_id}\`` };
  }

  // The focused pane of a tab, by label or window ID, or of the active tab.
  async function tabAnchor(
    id: string,
    named: string,
    tab: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ anchor: string; tabName: string }> {
    const window = tabIn(await view(id, signal), named, tab);
    const tabName = window.label ?? window.window_id;
    const anchor = window.focused_block_id ?? window.layers?.[0]?.blocks?.[0]?.block_id;

    if (anchor === undefined) {
      throw new Error(`Tab \`${tabName}\` of ${named} has no pane to split.`);
    }

    sessionOf.set(anchor, id);

    return { anchor, tabName };
  }

  // Where a new pane goes: pi's session or `session`, and for a split, the pane to split.
  async function locationOf(
    params: { session?: string; tab?: string; placement?: string },
    signal: AbortSignal | undefined,
  ): Promise<Location> {
    if (params.session === undefined && params.tab === undefined) {
      return { session: sessionId, anchor: own, elsewhere: "" };
    }

    const { id, named } = await sessionNamed(params.session, signal);
    const ofSession = id === sessionId ? "" : ` of ${named}`;

    if (params.placement === "tab") {
      if (params.tab !== undefined) {
        throw new Error('`tab` names a tab to split, so it needs `placement: "split"`.');
      }

      return { session: id, anchor: own, elsewhere: ofSession };
    }

    if (params.tab === undefined && id === sessionId) {
      return { session: id, anchor: own, elsewhere: "" };
    }

    const { anchor, tabName } = await tabAnchor(id, named, params.tab, signal);

    return { session: id, anchor, elsewhere: ` in tab \`${tabName}\`${ofSession}` };
  }

  // Parallel starts split a pane one at a time, so each sees the layout the last one left. Without a
  // command, the pane runs the user's shell.
  function splitPane(
    name: string | undefined,
    where: Location,
    cwd: string,
    command: string[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const { anchor } = where;

    return serial(`split ${anchor}`, async () => {
      const at = ["-b", anchor, "--split", await splitDirection(anchor, signal)];
      const labeled = name === undefined ? [] : ["--label", name];
      const args = ["split", ...inSession(anchor), ...at, ...labeled, "--focus=false", "-c", cwd];

      const created = await rexJson(
        pi,
        Created,
        [...args, "--json", ...command],
        REX_TIMEOUT_MS,
        signal,
      );

      const pane = firstBlock(created);

      sessionOf.set(pane, where.session);

      return pane;
    });
  }

  // The name labels both the tab and its pane.
  async function createTab(
    name: string | undefined,
    where: Location,
    cwd: string,
    command: string[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const labeled = name === undefined ? [] : [name];
    const scope = ["-s", where.session];
    const args = ["window", "new", ...scope, ...labeled, "--focus=false", "-c", cwd, "--json"];
    const created = await rexJson(pi, Created, [...args, ...command], REX_TIMEOUT_MS, signal);
    const pane = firstBlock(created);

    sessionOf.set(pane, where.session);

    if (name !== undefined) {
      await orClose(pane, () =>
        run(["block", "rename", ...scope, pane, name], REX_TIMEOUT_MS, signal),
      );
    }

    return pane;
  }

  // Rex doesn't keep labels unique, so parallel calls check and take a name one at a time.
  function openNamed(
    name: string,
    placement: "split" | "tab" | undefined,
    where: Location,
    cwd: string,
    command: string[],
    signal: AbortSignal | undefined,
  ): Promise<Placed> {
    return serial("names", async () => {
      await checkName(name, signal);

      return openPane(name, placement, where, cwd, command, signal);
    });
  }

  // Without a name, the pane keeps Rex's default label.
  async function openPane(
    name: string | undefined,
    placement: "split" | "tab" | undefined,
    where: Location,
    cwd: string,
    command: string[],
    signal: AbortSignal | undefined,
  ): Promise<Placed> {
    const argv = command.length === 0 ? [] : ["--", ...command];

    return placement === "tab"
      ? {
          pane: await createTab(name, where, cwd, argv, signal),
          where: `a new tab${where.elsewhere}`,
        }
      : {
          pane: await splitPane(name, where, cwd, argv, signal),
          where: `a new pane${where.elsewhere}`,
        };
  }

  // Names are unique across sessions, so a bare name finds one agent from any of them. A name
  // reserved for an agent whose worktree is still being made is taken too.
  async function checkName(name: string, signal: AbortSignal | undefined): Promise<void> {
    if (reserved.has(name)) {
      throw new Error(
        `A Rex agent named \`${name}\` is starting in a worktree. Pick another name.`,
      );
    }

    const taken = (await panes(signal)).find((pane) => pane.label === name);

    if (taken !== undefined) {
      throw new Error(
        `A Rex pane named \`${name}\` already exists, \`${qualified(taken)}\` (${taken.block_id}). Pick another name.`,
      );
    }
  }

  // A failed call leaves a pane it opened, which this closes before it rethrows. The pane may have
  // closed already, when its program exited.
  function orClose<T>(pane: string, task: () => Promise<T>): Promise<T> {
    const cleanUp = async () => {
      await run(["block", "close", ...inSession(pane), pane]).catch((cause: unknown) => {
        if (!(cause instanceof RexError && cause.notFound)) {
          throw cause;
        }
      });
    };

    return orCleanUp(task, cleanUp, `Closing pane ${pane}`);
  }

  // Runs one of worktree.lua's actions as pi's pane, so it knows which tab and directory pi is in.
  // Its errors are its own messages, without the rex command around them.
  async function worktreeAction<A extends keyof WorktreeActions, T extends TSchema>(
    schema: T,
    action: A,
    args: WorktreeActions[A],
    signal: AbortSignal | undefined,
  ): Promise<Static<T>> {
    await access(WORKTREE_SCRIPT).catch((cause: unknown) => {
      throw new Error(
        `${tildify(WORKTREE_SCRIPT)} isn't installed, so Rex can't manage worktrees. Apply the home-manager configuration.`,
        { cause },
      );
    });

    const call = ["do", "-s", sessionId, "-b", own, WORKTREE_SCRIPT, "--action", action];

    const stdout = await run(
      [...call, "--args", JSON.stringify(args)],
      WORKTREE_TIMEOUT_MS,
      signal,
    ).catch((cause: unknown) => {
      const failed = cause instanceof Error ? cause.cause : undefined;

      throw failed instanceof CommandError && !failed.killed && failed.stderr !== ""
        ? new WorktreeError(failed.stderr.replace(/^Error: /, ""), failed.exitCode, { cause })
        : cause;
    });

    return parseOutput(schema, stdout, action);
  }

  async function openWorktree(
    request: Static<typeof WorktreeParams> & { label?: string; command?: string[] },
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<Static<typeof WorktreeOpened>> {
    const { branch, base, path, session: where, label: name, command } = request;

    const args = {
      branch,
      base,
      path: path === undefined ? undefined : resolve(cwd, untildify(path)),
      cwd,
      session: where,
      label: name,
      command,
      focus: false,
    };

    const opened = await worktreeAction(WorktreeOpened, "worktree_open", args, signal);

    if (opened.block_id !== undefined) {
      sessionOf.set(opened.block_id, opened.session_id);
    }

    return opened;
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

  async function targetOf(
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<{ target: Target; found: Pane }> {
    const found = await blockOf(target, signal);
    const { block_id: pane, label: name } = found;

    return (await stateOf(pane, signal)) === undefined
      ? { target: { kind: "pane", pane }, found }
      : { target: { kind: "agent", pane, name }, found };
  }

  // Shells turn on bracketed paste while they read a command. The terminal would echo input typed
  // before that, and the shell would show it again on its prompt.
  async function shellReady(pane: string, signal: AbortSignal | undefined): Promise<void> {
    const args = ["block", "call", ...inSession(pane), "-b", pane, "modes"];
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
    const location = await locationOf(params, signal);

    const { pane, where } = await (name === undefined
      ? openPane(undefined, placement, location, cwd, [], signal)
      : openNamed(name, placement, location, cwd, [], signal));

    // The shell runs it like a typed command, so the user's shell setup, such as direnv, applies.
    const marker = await orClose(pane, async () => {
      await shellReady(pane, signal);

      const prompt = await capture(pane, signal);
      const scope = inSession(pane);

      await run(["send", ...scope, "-b", pane, "--", params.command], SEND_TIMEOUT_MS, signal);
      await run(["send-key", ...scope, "-b", pane, "enter"], SEND_TIMEOUT_MS, signal);

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

  // A worktree's open tab is used from any session, so a message names the tab's session when it
  // isn't pi's own.
  async function sessionNote(id: string, signal: AbortSignal | undefined): Promise<string> {
    if (id === sessionId) {
      return "";
    }

    const found = (await sessions(signal)).find((one) => one.session_id === id);

    return ` of session \`${found?.label ?? id}\``;
  }

  // worktree.lua splits the worktree's tab when it's open, or opens one, with the agent in it.
  async function worktreePane(
    params: Static<typeof StartParams>,
    command: string[],
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<Placed> {
    if (params.tab !== undefined) {
      throw new Error('`tab` names a tab to split, so it needs `placement: "split"`.');
    }

    const opened = await openWorktree({ ...params, label: params.name, command }, cwd, signal);
    const pane = opened.block_id;

    if (pane === undefined) {
      throw new Error(`worktree_open opened ${describeWorktree(opened)} but started no pane.`);
    }

    const tab = opened.tab === "new" ? "a new tab" : "its open tab";
    const made = opened.created ? "the new" : "the";
    const elsewhere = await orClose(pane, () => sessionNote(opened.session_id, signal));

    return { pane, where: `${tab}${elsewhere} for ${made} ${describeWorktree(opened)}` };
  }

  async function inWorktree(
    params: Static<typeof StartParams>,
    command: string[],
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<Placed> {
    const { name } = params;

    await serial("names", async () => {
      await checkName(name, signal);
      reserved.add(name);
    });

    try {
      return await worktreePane(params, command, cwd, signal);
    } finally {
      reserved.delete(name);
    }
  }

  async function startAgent(
    params: Static<typeof StartParams>,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<{ pane: string; started: string; state: string | undefined }> {
    const kind = params.kind ?? "pi";
    const command = [kind, ...(params.args ?? [])];
    const { placement } = params;

    checkWorktreePlacement(params);

    // `git worktree add` can take minutes, so the name is reserved instead of holding the lock that
    // other starts wait on.
    const { pane, where } =
      placement === "worktree"
        ? await inWorktree(params, command, cwd, signal)
        : await openNamed(
            params.name,
            placement,
            await locationOf(params, signal),
            cwd,
            command,
            signal,
          );

    const started = `Started ${kind} agent ${label(pane, params.name)} in ${where}.`;
    const state = await orClose(pane, () => firstState(pane, signal));

    return { pane, started, state };
  }

  const startTool = defineTool({
    name: "rex_start",
    label: "Rex Start",
    description:
      "Start a coding agent in a new Rex pane next to yours, in a new tab, in another session, or in a git worktree's tab, and optionally give it its first task. With a prompt, you get a message when the agent is done, idle, blocked, or failed. A prompt that starts with `/` instead returns the agent's state and screen, like rex_watch. The user's focus stays where it is. The pane closes when the agent exits.",
    promptSnippet:
      "Start an agent in a new Rex pane, tab, or worktree, with an optional first task",
    promptGuidelines: [
      "Use the rex_* tools to run agents and commands in Rex panes instead of the rex CLI.",
      'Start Rex agents with rex_start, with a short unique name and the first task as `prompt`. Use `placement: "tab"` only when the user asks for a tab, `session` or `tab` only when the user names one, and `placement: "worktree"` when the agent should work on its own branch.',
      'Give work in a git worktree to a Rex agent, not the subagent tool. Start it with rex_start and `placement: "worktree"`, with `branch` for a new or existing worktree or `path` for an existing one. Give work in one checkout to subagents unless the user asks for a Rex agent.',
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

  const worktreeTool = defineTool({
    name: "rex_worktree",
    label: "Rex Worktree",
    description:
      'Create a git worktree, or open an existing one by `path` or `branch`, in its own Rex tab. A new worktree goes in the directory ~/.config/rex/worktree.json sets. Returns its path, so you can work in it yourself. To have an agent work in a worktree, use rex_start with `placement: "worktree"` instead of the subagent tool.',
    promptSnippet: "Create or open a git worktree in a Rex tab",
    promptGuidelines: [
      "Make, open, and remove git worktrees with rex_worktree, rex_start, and rex_worktree_remove instead of `git worktree add` or `git worktree remove`, so each gets a Rex tab. This includes checkouts for reviewing a PR.",
    ],
    parameters: WorktreeParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = resolve(ctx.cwd, untildify(params.cwd ?? "."));
      const opened = await openWorktree(params, cwd, signal);
      const how = opened.created ? "Created" : "Opened the existing";
      const tab = opened.tab === "new" ? "a new Rex tab" : "its open Rex tab";
      const elsewhere = await sessionNote(opened.session_id, signal);

      return text(
        `${how} ${describeWorktree(opened)}, in ${tab} ${opened.window_id}${elsewhere}. Work there with absolute paths, or \`cd\` into it in bash. To hand it to an agent, use rex_start with \`placement: "worktree"\` and this \`path\`, not the subagent tool.`,
      );
    },
  });

  const removeTool = defineTool({
    name: "rex_worktree_remove",
    label: "Rex Worktree Remove",
    description:
      "Remove a git worktree and close its Rex tabs, which ends any agent running there. Its branch is kept. Refuses a worktree with uncommitted changes unless `force` is set, the repository's main checkout, and the worktree or tab you run in.",
    promptSnippet: "Remove a git worktree and close its Rex tabs",
    promptGuidelines: [
      "Remove a worktree with rex_worktree_remove when you made it and its work is committed and done, or when the user asks. Pass `force: true` only when the user says to discard its uncommitted changes.",
    ],
    parameters: RemoveParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = resolve(ctx.cwd, untildify(params.cwd ?? "."));

      const args = {
        branch: params.branch,
        path: params.path === undefined ? undefined : resolve(cwd, untildify(params.path)),
        cwd,
        force: params.force === true,
      };

      const removed = await worktreeAction(WorktreeRemoved, "worktree_remove", args, signal).catch(
        (cause: unknown) => {
          throw cause instanceof WorktreeError && cause.exitCode === DIRTY_EXIT
            ? new Error(
                `${errorMessage(cause)} Ask the user before you remove it with \`force: true\`.`,
                { cause },
              )
            : cause;
        },
      );

      const tabs = removed.closed_tabs === 1 ? "its tab" : `its ${removed.closed_tabs} tabs`;

      const closed =
        removed.closed_tabs === 0 ? "" : ` and closed ${tabs}, which ended anything running there`;

      const kept = removed.branch === undefined ? "" : ` Its branch \`${removed.branch}\` is kept.`;

      return text(`Removed ${describeWorktree({ path: removed.path })}${closed}.${kept}`);
    },
  });

  const watchTool = defineTool({
    name: "rex_watch",
    label: "Rex Watch",
    description: `Prompt a Rex agent in any session or send it keys. A prompt returns right away, and you get a message when the agent is done, idle, blocked, or failed. Keys wait ${KEYS_SETTLE_MS / 1000} seconds, then return the agent's state and screen. So does a prompt that starts with \`/\`, after up to ${STALL_MS / 1000} seconds for the agent to start working. With only \`agent\`, wait on an agent that's already working.`,
    promptSnippet: "Prompt a Rex agent or send it keys, and get a message when it settles",
    promptGuidelines: [
      "After you prompt a Rex agent, end your turn or keep working until its message arrives. Don't poll it with rex_read, bash, or `sleep`. Keys and slash commands return the agent's state and screen, so don't check on it after them.",
      "To prompt several Rex agents at once, call rex_watch once per agent in parallel.",
      "When a Rex agent is blocked on an approval or a question, read it with rex_read and ask the user before you answer it with keys.",
      "Agents you didn't start, including ones in other Rex sessions, belong to the user. Prompt or send keys to one only when the user asks.",
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
      "Read a Rex agent's state and recent output, or any pane's output, in any session, without blank lines. Read an agent after its message arrives.",
    promptSnippet: "Read a Rex agent's state and recent output, or a pane's output",
    promptGuidelines: [
      "If rex_read doesn't show a Rex agent's whole response, ask the agent to write it to a file and reply with the path, then read the file.",
    ],
    parameters: ReadParams,
    async execute(_toolCallId, params, signal) {
      const { target } = await targetOf(params.target, signal);

      return text(await serial(target.pane, () => readPane(target, params.lines ?? 120, signal)));
    },
  });

  // A shell reports its directory with OSC 7. A pane that runs an agent directly has none, so its
  // foreground process's directory stands in.
  async function paneCwd(call: string[], signal: AbortSignal | undefined): Promise<string> {
    const { pwd } = await rexJson(pi, Pwd, [...call, "pwd"], REX_TIMEOUT_MS, signal);

    if (pwd !== undefined) {
      return cwdOf(pwd);
    }

    const process = await rexJson(pi, Process, [...call, "process"], REX_TIMEOUT_MS, signal);

    return cwdOf(process.foreground?.cwd);
  }

  // A pane can close between the listing and these calls, as when its agent exits, so it's skipped.
  async function agentRow(pane: Pane, signal: AbortSignal | undefined) {
    const call = ["block", "call", ...inSession(pane.block_id), "-b", pane.block_id];

    const row = async () => {
      const root = await liveRecord(pane.block_id, signal);

      if (root === undefined) {
        return undefined;
      }

      const cwd = await paneCwd(call, signal);
      const you = pane.block_id === own ? " (you)" : "";

      return {
        pane,
        line: [
          `${pane.label ?? "-"}${you}`,
          pane.block_id,
          root.effective_app ?? "-",
          root.state,
          cwd,
        ].join("  "),
      };
    };

    return row().catch((cause: unknown) => {
      if (cause instanceof RexError && cause.notFound) {
        return undefined;
      }

      throw cause;
    });
  }

  // Agents under their session and tab, pi's session first.
  function agentTree(
    rows: { pane: Pane; line: string }[],
    worktrees: Map<string, { path: string; branch?: string }>,
  ): string {
    const lines: string[] = [];
    let lastSession: string | undefined;
    let lastTab: string | undefined;

    for (const { pane, line } of rows) {
      if (pane.session_id !== lastSession) {
        const yours = pane.session_id === sessionId ? ", yours" : "";

        lines.push(`Session \`${pane.session_label ?? "-"}\` (${pane.session_id}${yours})`);
        lastSession = pane.session_id;
        lastTab = undefined;
      }

      const tab = tabHeading(pane, worktrees);

      if (tab !== lastTab) {
        lines.push(`  ${tab}`);
        lastTab = tab;
      }

      lines.push(`    ${line}`);
    }

    return lines.join("\n");
  }

  const agentsTool = defineTool({
    name: "rex_agents",
    label: "Rex Agents",
    description:
      "List the agents in every Rex session's panes, which are the programs that report their state to Rex, under their session and tab: name, block ID, program, state, and working directory. `(you)` marks your own pane, and worktree tabs show their worktree. Reach an agent in another session as `session/name`.",
    promptSnippet: "List the agents running in Rex, in every session",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const [all, worktrees] = await Promise.all([panes(signal, true), worktreeTabs()]);
      const rows = await inBatches(all, (pane) => agentRow(pane, signal));
      const found = rows.filter((row) => row !== undefined);

      return text(
        found.length === 0 ? "No agents are running in Rex." : agentTree(found, worktrees),
      );
    },
  });

  const closeTool = defineTool({
    name: "rex_close",
    label: "Rex Close",
    description: "Close a Rex pane in any session, which ends the agent or command running in it.",
    promptSnippet: "Close a Rex agent's or command's pane",
    promptGuidelines: [
      "Close only Rex agents and panes you started, unless the user asks you to close others.",
    ],
    parameters: TargetParams,
    async execute(_toolCallId, params, signal) {
      const { target } = await targetOf(params.target, signal);
      const { pane } = target;

      if (pane === own) {
        throw new Error("That's your own pane.");
      }

      await serial(pane, async () => {
        await withoutWatch(pane, () =>
          run(["block", "close", ...inSession(pane), pane], REX_TIMEOUT_MS, signal),
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
      "Run a shell command in a new Rex pane next to yours, in a new tab, or in another session, where the user can watch it. With `wait_for`, wait until its output matches. The user's focus stays where it is.",
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
    description:
      "Switch the user's Rex view to an agent's or command's pane, in any session. Switching to another session needs Remote Control on in the Rex app's settings.",
    promptSnippet: "Switch the user's Rex view to a pane",
    promptGuidelines: ["Use rex_focus only when the user asks to see an agent or pane."],
    parameters: TargetParams,
    async execute(_toolCallId, params, signal) {
      const { target, found } = await targetOf(params.target, signal);
      const focused = `Focused ${targetLabel("Rex", target)}`;

      await run(["block", "focus", ...inSession(target.pane), target.pane], REX_TIMEOUT_MS, signal);

      if (found.session_id === sessionId) {
        return text(`${focused}.`);
      }

      // The app shows one session at a time, and only switches for the CLI with Remote Control on.
      // Rex reports that refusal like any other failure, so every failure says the pane is focused.
      const tab = found.window_id === undefined ? [] : [`window_id=${found.window_id}`];
      const select = ["do", "session.select", `session_id=${found.session_id}`, ...tab];

      const where = `session \`${found.session_label ?? found.session_id}\``;

      await run(select, REX_TIMEOUT_MS, signal).catch((cause: unknown) => {
        throw signal?.aborted === true
          ? cause
          : new Error(
              `${focused} in ${where}, but the Rex app didn't switch to it. Turning on Remote Control in the app's settings lets it switch. ${errorMessage(cause)}`,
              { cause },
            );
      });

      return text(`${focused}, in ${where}.`);
    },
  });

  pi.registerTool(startTool);
  pi.registerTool(worktreeTool);
  pi.registerTool(removeTool);
  pi.registerTool(watchTool);
  pi.registerTool(readTool);
  pi.registerTool(agentsTool);
  pi.registerTool(closeTool);
  pi.registerTool(runTool);
  pi.registerTool(focusTool);
}

/**
 * Tools that let pi run herdr agents without calling the herdr CLI from bash.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
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
  type Subscription,
  type WatchEvent,
} from "./lib/agent-watch.ts";
import { parseOutput, runCommand } from "./lib/command.ts";
import {
  AgentGet,
  AgentList,
  HERDR_TIMEOUT_MS,
  HerdrError,
  OutputMatched,
  PaneCurrent,
  PaneGet,
  PaneLayout,
  PaneSplit,
  StatusEvent,
  TabCreated,
  WorktreeList,
  WorktreeOpened,
  WorktreeRemoved,
  herdr,
  herdrJson,
  subscribe,
  type AgentInfo,
  type WorktreeInfo,
} from "./lib/herdr.ts";
import { multiplexer } from "./lib/multiplexer.ts";
import { orCleanUp, splitSide } from "./lib/panes.ts";
import { tildify, untildify } from "./lib/paths.ts";
import { errorMessage } from "./lib/settings.ts";

// A prompt is pasted, so a long one takes longer than a lookup.
const SEND_TIMEOUT_MS = 15_000;

// `git worktree add` checks out every file, which takes a while in a big repository.
const WORKTREE_TIMEOUT_MS = 60_000;

const GIT_TIMEOUT_MS = 10_000;

// herdr waits this long for a new agent to be ready.
const START_TIMEOUT_MS = 60_000;

// herdr_read leaves out blank lines and divider lines, so it asks herdr for this many times as
// many lines as it returns.
const READ_SLACK = 2;

// herdr can take about 15 seconds to collect an idle agent's history, and 5 more to restore its
// screen.
const READ_TIMEOUT_MS = 30_000;

// herdr collects history only from an idle agent. `done` is idle, but the user hasn't looked at it yet.
const READABLE = new Set(["idle", "done"]);

const socketPath = multiplexer === "herdr" ? process.env.HERDR_SOCKET_PATH : undefined;

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

const WorktreeFields = {
  branch: Type.Optional(
    Type.String({
      description:
        "Branch to check out. herdr creates it from `base` if it doesn't exist, and names one if you leave it out.",
    }),
  ),
  base: Type.Optional(
    Type.String({
      description:
        "Ref a new branch starts from, such as `origin/main`. Default the checkout's HEAD.",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description: "An existing worktree to open, instead of `branch` and `base`.",
    }),
  ),
};

const CwdParam = Type.Optional(
  Type.String({
    description:
      "Any directory in the repository, including another worktree. Default your own directory.",
  }),
);

const WorktreeParams = Type.Object({ ...WorktreeFields, cwd: CwdParam });

const RemoveParams = Type.Object({
  branch: Type.Optional(Type.String({ description: "Branch of the worktree to remove" })),
  path: Type.Optional(Type.String({ description: "Path of the worktree to remove" })),
  cwd: CwdParam,
  force: Type.Optional(
    Type.Boolean({
      description: "Discard the worktree's uncommitted changes. Only when the user says to.",
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
    Type.Union([Type.Literal("split"), Type.Literal("tab"), Type.Literal("worktree")], {
      description:
        "`split` (default) splits your pane. `tab` opens a new tab in your workspace. `worktree` opens a git worktree of `cwd`'s repository in its own workspace, in the repository's space.",
    }),
  ),
  ...WorktreeFields,
  cwd: Type.Optional(Type.String({ description: "Working directory. Default your own." })),
  args: Type.Optional(
    Type.Array(Type.String(), { description: "Arguments for the agent's own command line" }),
  ),
});

// Agent names can't contain `:`, so a target with one is a pane ID.
const TargetParam = Type.String({
  description: "Agent name, or the ID of any pane, such as one herdr_run opened",
});

const ReadParams = Type.Object({
  target: TargetParam,
  lines: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 1000, description: "Lines to read. Default 120." }),
  ),
  source: Type.Optional(
    Type.Union([Type.Literal("recent"), Type.Literal("visible")], {
      description:
        "`recent` (default) reads scrollback, or only the screen while an agent isn't idle. `visible` reads only the screen.",
    }),
  ),
});

const TargetParams = Type.Object({ target: TargetParam });

const RunParams = Type.Object({
  command: Type.String({ description: "Shell command to run" }),
  label: Type.Optional(
    Type.String({ description: "Name for the pane, and its tab if it gets one" }),
  ),
  placement: Type.Optional(
    Type.Union([Type.Literal("split"), Type.Literal("tab")], {
      description: "`split` (default) splits your pane. `tab` opens a new tab in your workspace.",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory. Default your own." })),
  wait_for: Type.Optional(
    Type.String({
      description: "Regular expression to wait for in the output, such as `listening on`",
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

interface Checkout {
  path: string;
  branch?: string;
  workspace: string;
  // The workspace's first pane, unless the workspace was already open and the pane may be in use.
  pane?: string;
  // The branch already had a worktree.
  reused: boolean;
}

// A new pane for an agent, and where it is.
interface Placed {
  pane: string;
  where: string;
}

type Target =
  | { kind: "agent"; pane: string; name?: string }
  | { kind: "pane"; pane: string; tab: string };

function checkWorktreeRequest({ path, branch, base }: Static<typeof WorktreeParams>): void {
  if (path !== undefined && (branch !== undefined || base !== undefined)) {
    throw new Error("Pass `path` to open an existing worktree, or `branch` and `base`, not both.");
  }
}

// Opening a worktree again would rename its workspace, so one that's open is used as it is.
function alreadyOpen(existing: WorktreeInfo | undefined): Checkout | undefined {
  const openIn = existing?.open_workspace_id;

  if (existing === undefined || openIn === undefined || openIn === null) {
    return undefined;
  }

  return {
    path: existing.path,
    branch: existing.branch ?? undefined,
    workspace: openIn,
    reused: true,
  };
}

// The pane shows the command as it runs, so a pattern that matches the command matches right away.
// herdr uses Rust's regex syntax, so a pattern JavaScript can't compile goes to herdr unchecked.
function checkWaitFor({ command, wait_for: pattern }: Static<typeof RunParams>): void {
  if (pattern === undefined) {
    return;
  }

  let regex: RegExp;

  try {
    regex = new RegExp(pattern);
  } catch {
    return;
  }

  if (regex.test(command)) {
    throw new Error(
      `\`wait_for\` matches the command itself, which the pane shows as it runs. Use a pattern only its output has.`,
    );
  }
}

// Refuses what herdr can't remove, and the worktree pi runs in, even from another workspace.
async function removable(
  repo: string,
  existing: WorktreeInfo | undefined,
  branch: string | undefined,
  home: string,
): Promise<WorktreeInfo> {
  if (existing === undefined) {
    throw new Error(`No worktree of ${tildify(repo)} has branch \`${branch}\`.`);
  }

  if (existing.path === repo) {
    throw new Error(
      `${tildify(repo)} is the repository's main checkout, which herdr doesn't remove.`,
    );
  }

  // herdr lists real paths, so pi's directory is compared as one too.
  const here = await realpath(home);

  if (here === existing.path || here.startsWith(`${existing.path}/`)) {
    throw new Error(
      `You run in ${tildify(existing.path)}, so removing it would remove your own directory.`,
    );
  }

  return existing;
}

function flag(name: string, value: string | undefined): string[] {
  return value === undefined ? [] : [name, value];
}

function describe({ path, branch }: Pick<Checkout, "path" | "branch">): string {
  return `worktree ${tildify(path)}${branch === undefined ? "" : ` on \`${branch}\``}`;
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

function statusEvent(line: string): WatchEvent {
  const { agent, agent_status: status } = parseOutput(StatusEvent, line, "herdr event").data;

  // herdr leaves out the agent, or sends null, once it exits.
  return agent === undefined || agent === null ? { kind: "exited" } : { kind: "status", status };
}

export default function (pi: ExtensionAPI) {
  if (socketPath === undefined) {
    return;
  }

  const path = socketPath;

  function run(args: string[], timeout?: number, signal?: AbortSignal): Promise<string> {
    return herdr(pi, args, timeout, signal);
  }

  async function follow(
    pane: string,
    onEvent: (event: WatchEvent) => void,
    onFail: (error: Error) => void,
  ): Promise<Subscription> {
    const socket = await subscribe(path, pane, (line) => onEvent(statusEvent(line)), onFail);

    // A clean close, such as a herdr restart, sends no error.
    socket.on("close", () => onFail(new Error("herdr closed the connection")));

    return { close: () => socket.destroy() };
  }

  const { serial, unwatch, withoutWatch, runRequest, promptPane } = createWatcher(pi, {
    title: "Herdr",
    tools: "herdr",
    agentOf,
    exited: (error) => error instanceof HerdrError && error.code === "agent_not_found",
    subscribe: follow,
    prompt: async (pane, prompt, signal) => {
      await run(["agent", "prompt", pane, prompt], SEND_TIMEOUT_MS, signal);
    },
    keys: async (pane, keys, signal) => {
      await run(["agent", "send-keys", pane, ...keys], SEND_TIMEOUT_MS, signal);
    },
    screen: (pane, signal) =>
      run(["agent", "read", pane, "--source", "visible"], HERDR_TIMEOUT_MS, signal),
  });

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

    return splitSide(rect.width, rect.height, "herdr");
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

  async function createTab(
    workspace: string,
    cwd: string,
    name: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const args = ["tab", "create", "--workspace", workspace, "--cwd", cwd, "--label", name];

    const created = await herdrJson(
      pi,
      TabCreated,
      [...args, "--no-focus"],
      HERDR_TIMEOUT_MS,
      signal,
    );

    return created.result.root_pane.pane_id;
  }

  async function git(
    cwd: string,
    args: string[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const call = `git ${args[0] ?? ""} in ${tildify(cwd)}`;
    const options = { call, timeout: GIT_TIMEOUT_MS, signal };

    return (await runCommand(pi, "git", ["-C", cwd, ...args], options)).trim();
  }

  // herdr starts new worktrees from the main checkout, so a relative ref such as the default `HEAD`
  // would mean its commit instead of the one at `cwd`.
  async function baseCommit(
    cwd: string,
    base: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return git(cwd, ["rev-parse", "--verify", `${base ?? "HEAD"}^{commit}`], signal);
  }

  // A worktree's workspace joins the space of its repository's main checkout, and herdr refuses to
  // start from a linked worktree. Listing works from any checkout and names the main one.
  async function worktreesOf(cwd: string, signal: AbortSignal | undefined) {
    const args = ["worktree", "list", "--cwd", cwd];
    const list = await herdrJson(pi, WorktreeList, args, WORKTREE_TIMEOUT_MS, signal);

    return { repo: list.result.source.source_checkout_path, worktrees: list.result.worktrees };
  }

  async function worktreeArgs(
    cwd: string,
    repo: string,
    { branch, base }: Static<typeof WorktreeParams>,
    existing: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    if (existing !== undefined) {
      return ["worktree", "open", "--cwd", repo, "--path", existing];
    }

    const commit = await baseCommit(cwd, base, signal);

    return ["worktree", "create", "--cwd", repo, ...flag("--branch", branch), "--base", commit];
  }

  // Finds the worktree that `path` or `branch` names, and the repository's main checkout. A path is
  // listed from itself, so it can be in another repository.
  async function locate(
    cwd: string,
    { branch, path: wanted }: { branch?: string; path?: string },
    signal: AbortSignal | undefined,
  ): Promise<{ repo: string; existing: WorktreeInfo | undefined }> {
    // herdr lists real paths, such as /private/tmp for /tmp.
    const at = wanted === undefined ? undefined : await realpath(resolve(cwd, untildify(wanted)));
    const { repo, worktrees } = await worktreesOf(at ?? cwd, signal);

    const existing = worktrees.find((worktree) =>
      at === undefined ? branch !== undefined && worktree.branch === branch : worktree.path === at,
    );

    if (at !== undefined && existing === undefined) {
      throw new Error(`${tildify(at)} isn't a worktree of its repository.`);
    }

    return { repo, existing };
  }

  // git checks a branch out in one worktree only, so a branch that has one reuses it. Either way,
  // herdr opens the worktree in its own workspace.
  async function openWorktree(
    cwd: string,
    request: Static<typeof WorktreeParams>,
    name: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Checkout> {
    checkWorktreeRequest(request);

    const { branch, base } = request;
    const { repo, existing } = await locate(cwd, request, signal);

    if (existing !== undefined && base !== undefined) {
      throw new Error(
        `Branch \`${branch}\` already has a worktree at ${tildify(existing.path)}, so it can't start from \`${base}\`.`,
      );
    }

    const reused = alreadyOpen(existing);

    if (reused !== undefined) {
      return reused;
    }

    const args = await worktreeArgs(cwd, repo, request, existing?.path, signal);
    const target = [...flag("--label", name), "--no-focus"];

    const opened = await herdrJson(
      pi,
      WorktreeOpened,
      [...args, ...target],
      WORKTREE_TIMEOUT_MS,
      signal,
    );

    const { workspace, root_pane: root, worktree, already_open: wasOpen } = opened.result;

    return {
      path: worktree.path,
      branch: worktree.branch ?? undefined,
      workspace: workspace.workspace_id,
      pane: wasOpen === true ? undefined : root.pane_id,
      reused: existing !== undefined,
    };
  }

  // herdr removes a worktree by its workspace, so one that isn't open gets opened first.
  async function workspaceOf(
    repo: string,
    worktree: WorktreeInfo,
    signal: AbortSignal | undefined,
  ): Promise<{ workspace: string; opened: boolean }> {
    const openIn = worktree.open_workspace_id;

    if (openIn !== undefined && openIn !== null) {
      return { workspace: openIn, opened: false };
    }

    const args = ["worktree", "open", "--cwd", repo, "--path", worktree.path, "--no-focus"];
    const opened = await herdrJson(pi, WorktreeOpened, args, WORKTREE_TIMEOUT_MS, signal);

    // Another client can open it after the list, and its workspace isn't this call's to close.
    const { workspace, already_open: wasOpen } = opened.result;

    return { workspace: workspace.workspace_id, opened: wasOpen !== true };
  }

  // A workspace this call opened only to remove the worktree closes again if herdr refuses, such
  // as for uncommitted changes.
  async function removeIn(
    worktree: WorktreeInfo,
    { workspace, opened }: { workspace: string; opened: boolean },
    force: boolean,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const args = ["worktree", "remove", "--workspace", workspace, ...(force ? ["--force"] : [])];
    const remove = () => herdrJson(pi, WorktreeRemoved, args, WORKTREE_TIMEOUT_MS, signal);

    await (opened ? orClose(["workspace", "close", workspace], remove) : remove()).catch(
      (cause: unknown) => {
        throw cause instanceof HerdrError && cause.code === "dirty_worktree_requires_force"
          ? new Error(
              `${tildify(worktree.path)} has uncommitted changes. Commit them, or ask the user before you remove it with \`force: true\`.`,
              { cause },
            )
          : cause;
      },
    );
  }

  async function removeWorktree(
    cwd: string,
    home: string,
    params: Static<typeof RemoveParams>,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const { repo, existing } = await locate(cwd, params, signal);
    const worktree = await removable(repo, existing, params.branch, home);

    // Only an open workspace can be pi's, so this check comes before anything gets opened.
    if (worktree.open_workspace_id === (await currentPane(signal)).workspace) {
      throw new Error("You run in that worktree's workspace, so removing it would end you.");
    }

    const target = await workspaceOf(repo, worktree, signal);

    await removeIn(worktree, target, params.force === true, signal);

    const kept =
      worktree.branch === undefined || worktree.branch === null
        ? ""
        : ` Its branch \`${worktree.branch}\` is kept.`;

    return `Removed ${describe({ path: worktree.path })} and closed its herdr workspace ${target.workspace}, which ended anything running there.${kept}`;
  }

  async function worktreePane(
    params: Static<typeof StartParams>,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<Placed> {
    const checkout = await openWorktree(cwd, params, params.name, signal);

    const pane =
      checkout.pane ?? (await createTab(checkout.workspace, checkout.path, params.name, signal));

    return { pane, where: `the ${describe(checkout)}` };
  }

  // Focus stays with the user.
  async function openPane(
    params: Static<typeof StartParams>,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<Placed> {
    if (params.placement === "worktree") {
      return worktreePane(params, cwd, signal);
    }

    if (params.branch !== undefined || params.base !== undefined || params.path !== undefined) {
      throw new Error('`branch`, `base`, and `path` need `placement: "worktree"`.');
    }

    if (params.placement === "tab") {
      const { workspace } = await currentPane(signal);

      return { pane: await createTab(workspace, cwd, params.name, signal), where: "a new tab" };
    }

    return { pane: await splitPane(cwd, signal), where: "a new pane" };
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

  // A failed call leaves a pane or workspace it opened, which `close` closes before this rethrows.
  function orClose<T>(close: string[], task: () => Promise<T>): Promise<T> {
    const cleanUp = async () => {
      await run(close);
    };

    return orCleanUp(task, cleanUp, `Cleaning up with \`herdr ${close.join(" ")}\``);
  }

  // Returns whether the agent is ready. herdr keeps an agent that's blocked during startup, so its
  // pane stays.
  async function startAgent(
    pane: string,
    params: Static<typeof StartParams>,
    kind: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const extra = params.args === undefined ? [] : ["--", ...params.args];
    const args = ["agent", "start", params.name, "--kind", kind, "--pane", pane];
    const timeout = ["--timeout", String(START_TIMEOUT_MS)];

    return orClose(["pane", "close", pane], () =>
      run([...args, ...timeout, ...extra], START_TIMEOUT_MS + 5000, signal).then(
        () => true,
        (cause: unknown) => {
          if (cause instanceof HerdrError && cause.code === "agent_not_ready") {
            return false;
          }

          throw cause;
        },
      ),
    );
  }

  async function targetOf(target: string, signal: AbortSignal | undefined): Promise<Target> {
    if (!target.includes(":")) {
      const { pane, name } = await agentOf(target, signal);

      return { kind: "agent", pane, name };
    }

    const got = await herdrJson(pi, PaneGet, ["pane", "get", target], HERDR_TIMEOUT_MS, signal);
    const { pane_id: pane, tab_id: tab, agent } = got.result.pane;

    return agent === undefined || agent === null
      ? { kind: "pane", pane, tab }
      : { kind: "agent", pane };
  }

  // Turns herdr's timeout into a message that names the pattern and the wait.
  async function waitOutput(
    pane: string,
    pattern: string,
    seconds: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const args = ["pane", "wait-output", pane, "--regex", pattern, "--source", "recent-unwrapped"];
    const timeout = seconds * 1000;

    const matched = await herdrJson(
      pi,
      OutputMatched,
      [...args, "--timeout", String(timeout)],
      timeout + 5000,
      signal,
    ).catch((cause: unknown) => {
      throw cause instanceof HerdrError && cause.code === "timeout"
        ? new Error(`no line matched \`${pattern}\` within ${seconds} seconds`, { cause })
        : cause;
    });

    return matched.result.matched_line;
  }

  async function runInPane(
    params: Static<typeof RunParams>,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    checkWaitFor(params);

    const { label: name, placement } = params;
    const { pane, where } = await openPane({ name: name ?? "run", placement }, cwd, signal);

    await orClose(["pane", "close", pane], async () => {
      if (name !== undefined) {
        await run(["pane", "rename", pane, name], HERDR_TIMEOUT_MS, signal);
      }

      await run(["pane", "run", pane, params.command], SEND_TIMEOUT_MS, signal);
    });

    const running = `Running \`${params.command}\` in pane \`${pane}\`, in ${where}.`;

    const { wait_for: pattern } = params;

    if (pattern === undefined) {
      return `${running} Read its output with herdr_read, and close it with herdr_close.`;
    }

    const seconds = params.timeout_seconds ?? 60;

    return matchedOutput(running, pattern, "herdr", () =>
      waitOutput(pane, pattern, seconds, signal),
    );
  }

  const startTool = defineTool({
    name: "herdr_start",
    label: "Herdr Start",
    description:
      "Start a coding agent in a new herdr pane next to yours, in a new tab, or in a git worktree, and optionally give it its first task. With a prompt, you get a message when the agent is done, idle, blocked, or failed. A prompt that starts with `/` instead returns the agent's state and screen, like herdr_watch. The user's focus stays where it is.",
    promptSnippet:
      "Start a herdr agent in a new pane, tab, or worktree, with an optional first task",
    promptGuidelines: [
      "Use the herdr_* tools instead of the herdr CLI.",
      'Start herdr agents with herdr_start, with a short unique name and the first task as `prompt`. Use `placement: "tab"` only when the user asks for a tab, and `placement: "worktree"` when the agent should work on its own branch.',
      'Give work in a herdr worktree to a herdr agent, not the subagent tool. Start it with herdr_start and `placement: "worktree"`, with `branch` for a new worktree or `path` for an existing one. Give work in one checkout to subagents unless the user asks for a herdr agent.',
    ],
    parameters: StartParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      await checkName(params.name, signal);

      // herdr resolves a relative cwd against its server's directory, so it goes in absolute.
      const cwd = resolve(ctx.cwd, untildify(params.cwd ?? "."));
      const { pane, where } = await openPane(params, cwd, signal);
      const kind = params.kind ?? "pi";
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

  const worktreeTool = defineTool({
    name: "herdr_worktree",
    label: "Herdr Worktree",
    description:
      'Create a git worktree through herdr, or open an existing one by `path` or `branch`, in its own herdr workspace. Returns its path, so you can work in it yourself. To have an agent work in a worktree, use herdr_start with `placement: "worktree"` instead of the subagent tool.',
    promptSnippet: "Create or open a git worktree through herdr",
    promptGuidelines: [
      "Make, open, and remove git worktrees with herdr_worktree, herdr_start, and herdr_worktree_remove instead of `git worktree add` or `git worktree remove`, so herdr keeps track of them. This includes checkouts for reviewing a PR.",
    ],
    parameters: WorktreeParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = resolve(ctx.cwd, untildify(params.cwd ?? "."));
      const checkout = await openWorktree(cwd, params, undefined, signal);
      const how = checkout.reused ? "Opened the existing" : "Created";

      return text(
        `${how} ${describe(checkout)}, in herdr workspace ${checkout.workspace}. Work there with absolute paths, or \`cd\` into it in bash. To hand it to an agent, use herdr_start with \`placement: "worktree"\` and this \`path\`, not the subagent tool.`,
      );
    },
  });

  const removeTool = defineTool({
    name: "herdr_worktree_remove",
    label: "Herdr Worktree Remove",
    description:
      "Remove a git worktree through herdr and close its workspace, which ends any agent running there. Its branch is kept. herdr refuses a worktree with uncommitted changes unless `force` is set.",
    promptSnippet: "Remove a git worktree through herdr",
    promptGuidelines: [
      "Remove a worktree with herdr_worktree_remove when you made it and its work is committed and done, or when the user asks. Pass `force: true` only when the user says to discard its uncommitted changes.",
    ],
    parameters: RemoveParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if ((params.branch === undefined) === (params.path === undefined)) {
        throw new Error("Pass either `branch` or `path`.");
      }

      const cwd = resolve(ctx.cwd, untildify(params.cwd ?? "."));

      return text(await removeWorktree(cwd, ctx.cwd, params, signal));
    },
  });

  const watchTool = defineTool({
    name: "herdr_watch",
    label: "Herdr Watch",
    description: `Prompt a herdr agent or send it keys. A prompt returns right away, and you get a message when the agent is done, idle, blocked, or failed. Keys wait ${KEYS_SETTLE_MS / 1000} seconds, then return the agent's state and screen. So does a prompt that starts with \`/\`, after up to ${STALL_MS / 1000} seconds for the agent to start working. With only \`agent\`, wait on an agent that's already working.`,
    promptSnippet: "Prompt a herdr agent or send it keys, and get a message when it settles",
    promptGuidelines: [
      "After you prompt a herdr agent, end your turn or keep working until its message arrives. Don't poll it with herdr_read, bash, or `sleep`. Keys and slash commands return the agent's state and screen, so don't check on it after them.",
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
    const output = trimRead(await run(args, READ_TIMEOUT_MS, signal), lines);
    const screenOnly = params.source !== "visible" && !history;
    const note = screenOnly ? " It isn't idle, so this is only its screen." : "";

    return `Herdr agent ${label(pane, agent.name)} is ${agent.status}.${note}${output}`;
  }

  async function readPlain(
    pane: string,
    params: Static<typeof ReadParams>,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const lines = params.lines ?? 120;
    const source = params.source === "visible" ? "visible" : "recent-unwrapped";
    const args = ["pane", "read", pane, "--source", source, "--lines", String(lines * READ_SLACK)];

    return `Pane \`${pane}\` runs no agent.${trimRead(await run(args, READ_TIMEOUT_MS, signal), lines)}`;
  }

  const readTool = defineTool({
    name: "herdr_read",
    label: "Herdr Read",
    description:
      "Read a herdr agent's state and recent output, or any pane's output, without blank lines. Read an agent after its message arrives.",
    promptSnippet: "Read a herdr agent's state and recent output, or a pane's output",
    promptGuidelines: [
      "If herdr_read doesn't show a herdr agent's whole response, ask the agent to write it to a file and reply with the path, then read the file.",
    ],
    parameters: ReadParams,
    async execute(_toolCallId, params, signal) {
      const target = await targetOf(params.target, signal);
      const { pane } = target;

      // herdr collects history by scrolling the agent, which a prompt sent meanwhile cuts short.
      return text(
        await serial(pane, () =>
          target.kind === "agent"
            ? readPane(pane, params, signal)
            : readPlain(pane, params, signal),
        ),
      );
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
    description: "Close a herdr pane, which ends the agent or command running in it.",
    promptSnippet: "Close a herdr agent's or command's pane",
    promptGuidelines: [
      "Close only herdr agents and panes you started, unless the user asks you to close others.",
    ],
    parameters: TargetParams,
    async execute(_toolCallId, params, signal) {
      const target = await targetOf(params.target, signal);
      const { pane } = target;

      if (pane === (await currentPane(signal)).pane) {
        throw new Error("That's your own pane.");
      }

      await serial(pane, async () => {
        await withoutWatch(pane, () => run(["pane", "close", pane], HERDR_TIMEOUT_MS, signal));
        unwatch(pane);
      });

      return text(
        `Closed ${targetLabel("herdr", target)}${target.kind === "agent" ? " and its pane" : ""}.`,
      );
    },
  });

  const runTool = defineTool({
    name: "herdr_run",
    label: "Herdr Run",
    description:
      "Run a shell command in a new herdr pane next to yours, or in a new tab, where the user can watch it. With `wait_for`, wait until its output matches. The user's focus stays where it is.",
    promptSnippet: "Run a command in a new herdr pane the user can watch",
    promptGuidelines: [
      "Use herdr_run for a command the user should see in herdr, such as a dev server. Run commands only you need with bash or background tasks.",
    ],
    parameters: RunParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = resolve(ctx.cwd, untildify(params.cwd ?? "."));

      return text(await runInPane(params, cwd, signal));
    },
  });

  const focusTool = defineTool({
    name: "herdr_focus",
    label: "Herdr Focus",
    description:
      "Switch the user's herdr view to an agent, or to the tab of a pane that runs none.",
    promptSnippet: "Switch the user's herdr view to an agent or pane",
    promptGuidelines: ["Use herdr_focus only when the user asks to see an agent or pane."],
    parameters: TargetParams,
    async execute(_toolCallId, params, signal) {
      const target = await targetOf(params.target, signal);

      const args =
        target.kind === "agent" ? ["agent", "focus", target.pane] : ["tab", "focus", target.tab];

      await run(args, HERDR_TIMEOUT_MS, signal);

      return text(`Focused ${targetLabel("herdr", target)}.`);
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

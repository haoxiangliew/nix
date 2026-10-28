/**
 * Runs the herdr CLI and subscribes to agent status events on herdr's socket.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createConnection, type Socket } from "node:net";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { CommandError, parseOutput, runCommand } from "./command.ts";
import { readLines } from "./lines.ts";

export const HERDR_TIMEOUT_MS = 2000;

// herdr agent actions that deliver input to the agent.
const SENDS = new Set(["prompt", "send-keys"]);

type Exec = Pick<ExtensionAPI, "exec">;

/** A failed herdr command, with herdr's error code when it printed one. */
export class HerdrError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    // Killed by its timeout or a cancel, so it may have run anyway.
    readonly killed = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// herdr leaves out the name of an unnamed agent, and the kind once the agent exits.
const AgentInfo = Type.Object({
  pane_id: Type.String(),
  agent_status: Type.String(),
  name: Type.Optional(Type.String()),
  agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  cwd: Type.Optional(Type.String()),
});

export type AgentInfo = Static<typeof AgentInfo>;

export const AgentGet = Type.Object({ result: Type.Object({ agent: AgentInfo }) });

export const AgentList = Type.Object({ result: Type.Object({ agents: Type.Array(AgentInfo) }) });

const Pane = Type.Object({ pane_id: Type.String() });

export const PaneSplit = Type.Object({ result: Type.Object({ pane: Pane }) });

// herdr leaves out `agent`, or sends null, for a pane that runs none.
export const PaneGet = Type.Object({
  result: Type.Object({
    pane: Type.Object({
      pane_id: Type.String(),
      tab_id: Type.String(),
      agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  }),
});

// herdr answers a wait only once a line matches, so the line is always there.
export const OutputMatched = Type.Object({
  result: Type.Object({ matched_line: Type.String() }),
});

export const PaneCurrent = Type.Object({
  result: Type.Object({
    pane: Type.Object({ pane_id: Type.String(), workspace_id: Type.String() }),
  }),
});

export const TabCreated = Type.Object({ result: Type.Object({ root_pane: Pane }) });

// herdr leaves out the branch of a detached checkout, and the workspace of one that isn't open.
const Worktree = Type.Object({
  path: Type.String(),
  branch: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  open_workspace_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export type WorktreeInfo = Static<typeof Worktree>;

export const WorktreeRemoved = Type.Object({
  result: Type.Object({ workspace_id: Type.String(), path: Type.String() }),
});

export const WorktreeList = Type.Object({
  result: Type.Object({
    // The repository's main checkout, even when listed from a linked worktree.
    source: Type.Object({ source_checkout_path: Type.String() }),
    worktrees: Type.Array(Worktree),
  }),
});

// What `worktree create` and `worktree open` return. Only open reports `already_open`.
export const WorktreeOpened = Type.Object({
  result: Type.Object({
    workspace: Type.Object({ workspace_id: Type.String() }),
    root_pane: Pane,
    worktree: Worktree,
    already_open: Type.Optional(Type.Boolean()),
  }),
});

export const PaneLayout = Type.Object({
  result: Type.Object({
    layout: Type.Object({
      panes: Type.Array(
        Type.Object({
          pane_id: Type.String(),
          rect: Type.Object({ width: Type.Number(), height: Type.Number() }),
        }),
      ),
    }),
  }),
});

const Started = Type.Object({
  result: Type.Object({ type: Type.Literal("subscription_started") }),
});

export const StatusEvent = Type.Object({
  event: Type.Literal("pane.agent_status_changed"),
  data: Type.Object({
    agent_status: Type.String(),
    agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  }),
});

// herdr prints server errors as JSON with a code, and usage errors as text.
export async function herdr(
  pi: Exec,
  args: string[],
  timeout = HERDR_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  const call = `herdr ${args.slice(0, 2).join(" ")}`;

  // Adds herdr's error code, and warns that a killed send may have reached the agent.
  try {
    return await runCommand(pi, "herdr", args, { call, timeout, signal });
  } catch (error) {
    if (!(error instanceof CommandError)) {
      throw error;
    }

    const sent =
      error.killed && SENDS.has(args[1] ?? "")
        ? ". That doesn't prove it wasn't delivered, so read the agent before sending again"
        : "";

    const code = /"code":"(\w+)"/.exec(error.stderr)?.[1];

    throw new HerdrError(`${error.message}${sent}`, code, error.killed, { cause: error });
  }
}

export async function herdrJson<T extends TSchema>(
  pi: Exec,
  schema: T,
  args: string[],
  timeout = HERDR_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Static<T>> {
  const stdout = await herdr(pi, args, timeout, signal);

  return parseOutput(schema, stdout, `herdr ${args.slice(0, 2).join(" ")}`);
}

/** Resolves once herdr confirms the subscription, so no status change is missed after that. */
export function subscribe(
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

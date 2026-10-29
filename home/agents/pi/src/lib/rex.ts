/**
 * Runs the Rex CLI and streams a Rex session's events.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { spawn } from "node:child_process";
import { join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import type { Subscription, WatchEvent } from "./agent-watch.ts";

import { CommandError, parseOutput, runCommand } from "./command.ts";
import { readLines } from "./lines.ts";

export const REX_TIMEOUT_MS = 2000;

// The CLI of the server this terminal belongs to. nix-darwin drops its directory from PATH.
const REX = process.env.REX_BIN_DIR === undefined ? "rex" : join(process.env.REX_BIN_DIR, "rex");

// Rex exits with this when a target, such as a block, doesn't exist.
const NOT_FOUND_EXIT = 3;

// Rex commands that deliver input to a terminal. `rex api call` delivers it only with this method.
const SENDS = new Set(["send", "send-key"]);
const SEND_METHOD = "block.event";

type Exec = Pick<ExtensionAPI, "exec">;

export class RexError extends Error {
  constructor(
    message: string,
    // Rex couldn't find the target, such as a block that closed.
    readonly notFound: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const Block = Type.Object({
  block_id: Type.String(),
  label: Type.Optional(Type.String()),
  window_id: Type.Optional(Type.String()),
});

// Every block in a session, including detached ones, which a session's view leaves out. Rex sends
// null or leaves out an empty list.
export const BlockList = Type.Object({
  blocks: Type.Optional(Type.Union([Type.Array(Block), Type.Null()])),
});

export const SessionList = Type.Object({
  sessions: Type.Array(
    Type.Object({ session_id: Type.String(), label: Type.Optional(Type.String()) }),
  ),
});

// One session's tabs and their panes. Floating panes are in later layers. Rex sends null or leaves
// out an empty list, as for a session with no tabs.
export const SessionView = Type.Object({
  active_window_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  windows: Type.Optional(
    Type.Union([
      Type.Array(
        Type.Object({
          window_id: Type.String(),
          label: Type.Optional(Type.String()),
          focused_block_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          layers: Type.Optional(
            Type.Union([
              Type.Array(
                Type.Object({
                  blocks: Type.Optional(Type.Union([Type.Array(Block), Type.Null()])),
                }),
              ),
              Type.Null(),
            ]),
          ),
        }),
      ),
      Type.Null(),
    ]),
  ),
});

export type SessionWindow = NonNullable<Static<typeof SessionView>["windows"]>[number];

// What worktree.lua's actions return.
export const WorktreeOpened = Type.Object({
  path: Type.String(),
  branch: Type.Optional(Type.String()),
  created: Type.Boolean(),
  session_id: Type.String(),
  window_id: Type.String(),
  // A new pane, when the call asked for a command or opened a new tab.
  block_id: Type.Optional(Type.String()),
  tab: Type.Union([Type.Literal("new"), Type.Literal("existing")]),
});

export const WorktreeRemoved = Type.Object({
  path: Type.String(),
  branch: Type.Optional(Type.String()),
  closed_tabs: Type.Number(),
});

// worktree.lua's state file, which maps each worktree tab to its worktree.
export const WorktreeState = Type.Object({
  windows: Type.Record(
    Type.String(),
    Type.Object({ path: Type.String(), branch: Type.Optional(Type.String()) }),
  ),
});

// Rex leaves out `id` for the root record, which holds the program's own state.
const StatusRecord = Type.Object({
  id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  state: Type.String(),
  effective_app: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  // The process that reported the record.
  owner: Type.Optional(Type.Union([Type.Object({ pid: Type.Number() }), Type.Null()])),
});

export type StatusRecord = Static<typeof StatusRecord>;

export const ProgramStatus = Type.Object({ records: Type.Array(StatusRecord) });

export const Created = Type.Object({
  window_id: Type.Optional(Type.String()),
  block_ids: Type.Array(Type.String(), { minItems: 1 }),
});

// What `rex new --json` prints: the session and its first tab, with its one pane.
export const NewSession = Type.Object({
  session_id: Type.String(),
  initial_windows: Type.Array(Created, { minItems: 1 }),
});

export const Size = Type.Object({ columns: Type.Number(), rows: Type.Number() });

// A file:// URL when the shell reports it with OSC 7, and left out until something reports one.
export const Pwd = Type.Object({ pwd: Type.Optional(Type.String()) });

export const Modes = Type.Object({
  modes: Type.Array(Type.Object({ number: Type.Number(), set: Type.Boolean() })),
});

// Rex leaves out the foreground process, or sends null, when it can't tell.
export const Process = Type.Object({
  foreground: Type.Optional(
    Type.Union([
      Type.Object({ pid: Type.Number(), cwd: Type.Optional(Type.String()) }),
      Type.Null(),
    ]),
  ),
});

const SessionEvent = Type.Object({
  payload: Type.Object({
    event: Type.Object({ type: Type.String(), payload: Type.Optional(Type.Unknown()) }),
  }),
});

const ClientConnected = Type.Object({
  principal: Type.Object({ pid: Type.Optional(Type.Number()) }),
});

const BlockEvent = Type.Object({
  block_id: Type.String(),
  name: Type.String(),
  payload: Type.Optional(Type.Unknown()),
});

const BlockClosed = Type.Object({ block_id: Type.String() });

const StatusChanged = Type.Object({
  id: Type.String(),
  record: Type.Object({ state: Type.String() }),
});

const StatusRemoved = Type.Object({ ids: Type.Array(Type.String()), reason: Type.String() });

// Removal reasons that mean the program is gone. A live program can clear its own records, as pi
// does while it suspends, and a reset or eviction drops records of programs that still run.
const GONE = new Set(["child_exited", "prompt", "foreground"]);

/**
 * What a watch needs from a session's events. `id` is the record's, and empty for the root record,
 * which holds the program's own state.
 */
export type RexEvent =
  | { kind: "connected"; pid?: number }
  | { kind: "status"; block: string; id: string; status: string }
  | { kind: "removed"; block: string; ids: string[] }
  | { kind: "exited"; block: string };

export type PaneEvent = Exclude<RexEvent, { kind: "connected" }>;

// An event Rex sends in an undocumented shape stops the watch, so pi doesn't silently miss a state
// change.
function invalid(what: string, payload: string): Error {
  return new Error(`unexpected Rex ${what} event: ${payload.slice(0, 200)}`);
}

function blockEvent({
  block_id: block,
  name,
  payload,
}: Static<typeof BlockEvent>): RexEvent | undefined {
  if (name === "child_exited") {
    return { kind: "exited", block };
  }

  if (name === "program_status_changed") {
    if (!Value.Check(StatusChanged, payload)) {
      throw invalid(name, JSON.stringify(payload));
    }

    return { kind: "status", block, id: payload.id, status: payload.record.state };
  }

  if (name !== "program_status_removed") {
    return undefined;
  }

  if (!Value.Check(StatusRemoved, payload)) {
    throw invalid(name, JSON.stringify(payload));
  }

  return payload.ids.includes("") && GONE.has(payload.reason)
    ? { kind: "exited", block }
    : { kind: "removed", block, ids: payload.ids };
}

// Rex leaves out the root record's id or sends null, and events give it as "".
function recordId(record: StatusRecord): string {
  return record.id ?? "";
}

// A blocked record with an id makes the agent blocked. Otherwise the agent has the root record's
// state.
function blockedById(states: Iterable<[string, string]>): boolean {
  return [...states].some(([id, state]) => id !== "" && state === "blocked");
}

/** Tracks one pane's records to give the agent's state, as blockedById describes. */
export function paneStatus() {
  // Record states by id, with "" for the root.
  const states = new Map<string, string>();
  // Ids an event reported, which are newer than a lookup.
  const reported = new Set<string>();

  return {
    /** Fills in the records no event has reported yet, from a program_status lookup. */
    seed(records: StatusRecord[]): void {
      for (const record of records) {
        const id = recordId(record);

        if (!reported.has(id)) {
          states.set(id, record.state);
        }
      }
    },

    /** Returns the agent's state after an event, or undefined while it's unknown. */
    update(event: PaneEvent): WatchEvent | undefined {
      if (event.kind === "exited") {
        return { kind: "exited" };
      }

      const ids = event.kind === "removed" ? event.ids : [event.id];

      ids.forEach((id) => reported.add(id));

      if (event.kind === "removed") {
        ids.forEach((id) => states.delete(id));
      } else {
        states.set(event.id, event.status);
      }

      const status = blockedById(states) ? "blocked" : states.get("");

      return status === undefined ? undefined : { kind: "status", status };
    },
  };
}

/** Parses one line of `rex events --json`, or returns undefined for an event a watch ignores. */
export function parseEvent(line: string): RexEvent | undefined {
  const parsed: unknown = JSON.parse(line);

  if (!Value.Check(SessionEvent, parsed)) {
    throw invalid("session", line);
  }

  const { type, payload } = parsed.payload.event;

  if (type === "client_connected") {
    if (!Value.Check(ClientConnected, payload)) {
      throw invalid(type, JSON.stringify(payload));
    }

    return { kind: "connected", pid: payload.principal.pid };
  }

  if (type === "block_closed") {
    if (!Value.Check(BlockClosed, payload)) {
      throw invalid(type, JSON.stringify(payload));
    }

    return { kind: "exited", block: payload.block_id };
  }

  if (type !== "block_event") {
    return undefined;
  }

  if (!Value.Check(BlockEvent, payload)) {
    throw invalid(type, JSON.stringify(payload));
  }

  return blockEvent(payload);
}

/**
 * The root record, which holds the program's own state, or undefined when it reports none. Its
 * state is the agent's, as blockedById describes.
 */
export function rootRecord(status: Static<typeof ProgramStatus>): StatusRecord | undefined {
  const root = status.records.find((record) => recordId(record) === "");

  const states = status.records.map((record): [string, string] => [recordId(record), record.state]);

  return root !== undefined && blockedById(states) ? { ...root, state: "blocked" } : root;
}

export function firstBlock({ block_ids: [block] }: Static<typeof Created>): string {
  if (block === undefined) {
    throw new Error("Rex created no pane");
  }

  return block;
}

export async function rex(
  pi: Exec,
  args: string[],
  timeout = REX_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  const call = `rex ${args.slice(0, 2).join(" ")}`;

  // Warns that a killed send may have reached the terminal.
  try {
    return await runCommand(pi, REX, args, { call, timeout, signal });
  } catch (error) {
    if (!(error instanceof CommandError)) {
      throw error;
    }

    const sent =
      error.killed && (SENDS.has(args[0] ?? "") || (args[0] === "api" && args[2] === SEND_METHOD))
        ? ". That doesn't prove it wasn't delivered, so read the terminal before sending again"
        : "";

    const notFound = error.exitCode === NOT_FOUND_EXIT;

    throw new RexError(`${error.message}${sent}`, notFound, { cause: error });
  }
}

export async function rexJson<T extends TSchema>(
  pi: Exec,
  schema: T,
  args: string[],
  timeout = REX_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<Static<T>> {
  const stdout = await rex(pi, args, timeout, signal);

  return parseOutput(schema, stdout, `rex ${args.slice(0, 2).join(" ")}`);
}

/**
 * Streams a session's events. Resolves once Rex reports this stream's own connection, so no event
 * after that is missed. onFail gets errors and the stream ending, but not close().
 */
export function subscribe(
  session: string,
  onEvent: (event: PaneEvent) => void,
  onFail: (error: Error) => void,
): Promise<Subscription> {
  const child = spawn(REX, ["events", "-s", session, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let started = false;
    let closed = false;
    let stderr = "";

    const subscription = {
      close: () => {
        closed = true;
        child.kill();
      },
    };

    const fail = (error: Error): void => {
      if (closed) {
        return;
      }

      subscription.close();
      clearTimeout(timer);

      if (started) {
        onFail(error);
      } else {
        reject(error);
      }
    };

    const timer = setTimeout(
      () => fail(new Error("Rex didn't start the event stream")),
      REX_TIMEOUT_MS,
    );

    child.on("error", fail);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 200);
    });
    // "close" comes after stderr ends, so the error includes its start.
    child.on("close", () => {
      const why = stderr.trim();

      fail(new Error(`Rex ended the event stream${why === "" ? "" : `: ${why}`}`));
    });

    readLines(
      child.stdout,
      (line) => {
        // Lines already read can arrive after close().
        if (closed) {
          return;
        }

        const event = parseEvent(line);

        if (started) {
          if (event !== undefined && event.kind !== "connected") {
            onEvent(event);
          }

          return;
        }

        if (event?.kind === "connected" && event.pid === child.pid) {
          started = true;
          clearTimeout(timer);
          resolve(subscription);
        }
      },
      fail,
    );
  });
}

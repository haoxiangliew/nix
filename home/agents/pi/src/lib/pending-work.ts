/**
 * Counts the work a pi session still waits on after its run ends: background tasks that call back,
 * background subagents, and agents in other panes. Each of these starts another run when it
 * finishes, so the session isn't done yet. attention.ts reports such a session as working.
 *
 * pi-better-background-tasks has no API for its tasks, so this reads its files. Anything it can't
 * read counts as no pending work. So if those files change, pi reports done early again, and no
 * session stays working forever.
 */

import type { SubagentsService } from "@gotgenes/pi-subagents";

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

// A task's result starts a run of its own, a moment after the task ends. A task that ended less
// than this long ago still counts.
const RESULT_GRACE_MS = 10_000;

// How long a durable task gets to start its runner.
const CLAIM_GRACE_MS = 60_000;

const TASKS = join(tmpdir(), "pi-better-background-tasks");
const LEGACY = join(TASKS, "tasks");
const OBSERVED = join(TASKS, "supervisor", "observed");
const DURABLE = join(TASKS, "supervisor", "tasks");

const Origin = Type.Object({ sessionId: Type.Optional(Type.String()) });

// tasks/<id>/meta.json, for tasks pi runs itself.
const LegacyMeta = Type.Object({
  status: Type.String(),
  callback: Type.Optional(Type.Boolean()),
  callbackOrigin: Type.Optional(Origin),
  callbackSentAt: Type.Optional(Type.Number()),
  callbackSuppressedAt: Type.Optional(Type.Number()),
  pid: Type.Optional(Type.Integer()),
  pidStartTime: Type.Optional(Type.String()),
  // The process that runs a watch's checks. A watch has no pid.
  spawnPid: Type.Optional(Type.Integer()),
  spawnPidStartTime: Type.Optional(Type.String()),
  endedAt: Type.Optional(Type.Number()),
});

// supervisor/observed/<id>.json, which says who a durable task reports to.
const Observed = Type.Object({
  parentOrigin: Origin,
  callback: Type.Optional(Type.Boolean()),
  callbackDeliveredAt: Type.Optional(Type.Number()),
  outboxDelivered: Type.Optional(Type.Boolean()),
});

// supervisor/tasks/<id>/, which the task's runner writes.
const Launch = Type.Object({ createdAt: Type.Number() });
const Claim = Type.Object({ pid: Type.Integer(), pidStartTime: Type.Optional(Type.String()) });
const Result = Type.Object({ status: Type.String(), endedAt: Type.Number() });

export interface PendingWork {
  // Background tasks that are running, or whose result is about to arrive.
  tasks: number;
  subagents: number;
  // Agents in other panes that the session waits on.
  agents: number;
}

type AgentCount = () => number;

declare global {
  // Extensions may each load their own copy of this module, so the counts are global.
  var piPendingAgentCounts: Set<AgentCount> | undefined;
}

function agentCounts(): Set<AgentCount> {
  return (globalThis.piPendingAgentCounts ??= new Set());
}

/** Adds a count of the agents a session waits on. Returns a function that removes it. */
export function countPendingAgents(count: AgentCount): () => void {
  agentCounts().add(count);

  return () => agentCounts().delete(count);
}

function readJson<T extends TSchema>(path: string, schema: T): Static<T> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));

    return Value.Check(schema, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function entries(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

// When the process started, as pi-better-background-tasks records it, or undefined when it's gone.
function startTime(pid: number): string | undefined {
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });

    return started.trim() || undefined;
  } catch (error) {
    // ps exits with 1 when no process has the PID.
    if (error instanceof Error && "status" in error && error.status === 1) {
      return undefined;
    }

    throw error;
  }
}

// Another process can reuse the PID, and it has a different start time.
function alive(pid: number | undefined, started: string | undefined): boolean {
  const actual = pid === undefined ? undefined : startTime(pid);

  return actual !== undefined && (started === undefined || actual === started);
}

function justEnded(endedAt: number | undefined, now: number): boolean {
  return endedAt !== undefined && now - endedAt < RESULT_GRACE_MS;
}

function legacyPending(id: string, session: string, now: number): boolean {
  const meta = readJson(join(LEGACY, id, "meta.json"), LegacyMeta);

  if (meta === undefined || meta.callback === false || meta.callbackOrigin?.sessionId !== session) {
    return false;
  }

  if (meta.status === "running") {
    return meta.pid === undefined
      ? alive(meta.spawnPid, meta.spawnPidStartTime)
      : alive(meta.pid, meta.pidStartTime);
  }

  const reported = meta.callbackSentAt !== undefined || meta.callbackSuppressedAt !== undefined;

  return !reported && meta.status !== "cancelled" && justEnded(meta.endedAt, now);
}

// A runner that died without a result leaves its task looking like it still runs.
function durableRunning(directory: string, now: number): boolean {
  const claim = readJson(join(directory, "claim.json"), Claim);

  if (claim !== undefined) {
    return alive(claim.pid, claim.pidStartTime);
  }

  const launch = readJson(join(directory, "launch.json"), Launch);

  return launch !== undefined && now - launch.createdAt < CLAIM_GRACE_MS;
}

function durablePending(file: string, session: string, now: number): boolean {
  const observed = readJson(join(OBSERVED, file), Observed);

  if (
    observed === undefined ||
    observed.callback === false ||
    observed.parentOrigin.sessionId !== session
  ) {
    return false;
  }

  const directory = join(DURABLE, file.replace(/\.json$/, ""));
  const result = readJson(join(directory, "result.json"), Result);

  if (result === undefined) {
    return durableRunning(directory, now);
  }

  const delivered = observed.callbackDeliveredAt !== undefined || observed.outboxDelivered === true;

  return !delivered && result.status !== "cancelled" && justEnded(result.endedAt, now);
}

function pendingTasks(session: string): number {
  const now = Date.now();
  const legacy = entries(LEGACY).filter((id) => legacyPending(id, session, now));
  const durable = entries(OBSERVED).filter((file) => durablePending(file, session, now));

  return legacy.length + durable.length;
}

function pendingSubagents(subagents: SubagentsService | undefined): number {
  const agents = subagents?.listAgents() ?? [];

  return agents.filter(({ status }) => status === "queued" || status === "running").length;
}

function pendingAgents(): number {
  return [...agentCounts()].reduce((total, count) => total + count(), 0);
}

/** The work the session with this ID waits on, or undefined when there is none. */
export function pendingWork(
  session: string,
  subagents: SubagentsService | undefined,
): PendingWork | undefined {
  const work = {
    tasks: pendingTasks(session),
    subagents: pendingSubagents(subagents),
    agents: pendingAgents(),
  };

  return work.tasks + work.subagents + work.agents === 0 ? undefined : work;
}

function counted(count: number, noun: string): string[] {
  return count === 0 ? [] : [`${count} ${noun}${count === 1 ? "" : "s"}`];
}

export function describePending({ tasks, subagents, agents }: PendingWork): string {
  const parts = [
    ...counted(tasks, "background task"),
    ...counted(subagents, "subagent"),
    ...counted(agents, "agent"),
  ];

  return `Waiting on ${parts.join(", ")}`;
}

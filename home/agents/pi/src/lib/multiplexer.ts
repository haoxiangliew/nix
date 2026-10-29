/**
 * Finds the terminal multiplexer whose pane runs pi. Panes inherit environment variables such as
 * HERDR_ENV and REX_SESSION from whatever started the multiplexer, so this walks pi's process
 * ancestry instead, and the nearest multiplexer wins.
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export type Multiplexer = "herdr" | "rex";

// Agents that can run pi, such as from a bash tool or in a PTY of their own.
const AGENTS = new Set(["pi", "claude", "codex"]);

function processes(): Map<number, { parent: number; name: string }> {
  // comm is last, so a path with spaces stays whole.
  const table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], {
    encoding: "utf8",
    timeout: 2000,
  });

  return new Map(
    table.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);

      return match === null
        ? []
        : [[Number(match[1]), { parent: Number(match[2]), name: basename(match[3] ?? "") }]];
    }),
  );
}

// The nearest multiplexer, and the processes between it and pi, nearest first.
type Ancestry = { multiplexer?: Multiplexer; between: number[] };

function find(): Ancestry {
  const all = processes();
  const between: number[] = [];

  for (let pid = process.ppid; pid > 1;) {
    const entry = all.get(pid);

    if (entry === undefined) {
      return { between };
    }

    if (entry.name === "herdr" || entry.name === "rex") {
      return { multiplexer: entry.name, between };
    }

    between.push(pid);
    pid = entry.parent;
  }

  return { between };
}

const found = find();

export const multiplexer = found.multiplexer;

/**
 * Whether another agent started pi inside its pane, rather than the pane's shell. comm names the
 * executable, which a wrapper such as Claude Code's hides, so this reads each process's argv0.
 */
export function startedByAgent(): boolean {
  if (found.between.length === 0) {
    return false;
  }

  const table = execFileSync("ps", ["-o", "args=", "-p", found.between.join(",")], {
    encoding: "utf8",
    timeout: 2000,
  });

  return table
    .split("\n")
    .some((args) => AGENTS.has(basename(args.trim().split(" ")[0] ?? "").replace(/^-/, "")));
}

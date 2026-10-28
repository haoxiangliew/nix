/**
 * Finds the terminal multiplexer whose pane runs pi. Panes inherit environment variables such as
 * HERDR_ENV and REX_SESSION from whatever started the multiplexer, so this walks pi's process
 * ancestry instead, and the nearest multiplexer wins.
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export type Multiplexer = "herdr" | "rex";

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

function find(): Multiplexer | undefined {
  const all = processes();

  for (let pid = process.ppid; pid > 1;) {
    const entry = all.get(pid);

    if (entry === undefined) {
      return undefined;
    }

    if (entry.name === "herdr" || entry.name === "rex") {
      return entry.name;
    }

    pid = entry.parent;
  }

  return undefined;
}

export const multiplexer = find();

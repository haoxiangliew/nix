/**
 * Tells Rex which session pi runs in its pane, so home/agents/rex/agent_resume.lua can resume it
 * with `pi --session <file>` after the Rex server restarts. Rex can't see the session itself. Each
 * session start writes a record named for the pane's block to ~/.local/state/rex/agents, and
 * agent_resume.lua decides when it's stale.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { multiplexer, startedByAgent } from "./lib/multiplexer.ts";

const RECORDS = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "rex",
  "agents",
);

const block = multiplexer === "rex" ? process.env.REX_BLOCK : undefined;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Subagents, print or RPC runs, and a pi another agent started share the pane with its owner.
    if (block === undefined || ctx.mode !== "tui" || startedByAgent()) {
      return;
    }

    const sm = ctx.sessionManager;

    const record = {
      agent: "pi",
      session: sm.getSessionId(),
      file: sm.getSessionFile(),
      cwd: ctx.cwd,
      pid: process.pid,
    };

    const path = join(RECORDS, block.replace(/^block:/, ""));
    const temporary = `${path}.${process.pid}.tmp`;

    // Renamed into place, so Rex never reads half a record.
    mkdirSync(RECORDS, { recursive: true });
    writeFileSync(temporary, JSON.stringify(record));
    renameSync(temporary, path);
  });
}

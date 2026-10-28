/**
 * Runs a command with pi.exec, fails on a kill or a non-zero exit, and checks its JSON output.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/** A command that exited non-zero, timed out, or was cancelled. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    // Killed by its timeout or a cancel, so it may have run anyway.
    readonly killed: boolean,
    // The exit status, unless the command was killed.
    readonly exitCode?: number,
  ) {
    super(message);
  }
}

interface RunOptions {
  // Names the command in errors.
  call: string;
  timeout: number;
  signal?: AbortSignal;
}

// pi.exec reports a killed process with code 0, so a kill is checked first.
export async function runCommand(
  pi: Pick<ExtensionAPI, "exec">,
  command: string,
  args: string[],
  { call, timeout, signal }: RunOptions,
): Promise<string> {
  const result = await pi.exec(command, args, { timeout, signal });

  if (result.killed) {
    const why =
      signal?.aborted === true ? "was cancelled" : `timed out after ${timeout / 1000} seconds`;

    throw new CommandError(`${call} ${why}`, "", true);
  }

  if (result.code !== 0) {
    const stderr = result.stderr.trim();

    throw new CommandError(`${call} failed: ${stderr}`, stderr, false, result.code);
  }

  return result.stdout;
}

/** Parses a command's JSON output and checks it against schema. `call` names the command in errors. */
export function parseOutput<T extends TSchema>(schema: T, stdout: string, call: string): Static<T> {
  const parsed: unknown = JSON.parse(stdout);

  if (!Value.Check(schema, parsed)) {
    throw new Error(`unexpected output from ${call}: ${stdout.slice(0, 200)}`);
  }

  return parsed;
}

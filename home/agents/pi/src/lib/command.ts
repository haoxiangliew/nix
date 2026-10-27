/**
 * Runs a command with pi.exec and fails on a kill or a non-zero exit.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A command that exited non-zero, timed out, or was cancelled. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    // Killed by its timeout or a cancel, so it may have run anyway.
    readonly killed: boolean,
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

    throw new CommandError(`${call} failed: ${stderr}`, stderr, false);
  }

  return result.stdout;
}

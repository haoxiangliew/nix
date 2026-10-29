/**
 * Pane layout and cleanup shared by the herdr and Rex agent tools.
 */

import { errorMessage } from "./settings.ts";

// A split to the right leaves each half at least this many columns, or the split goes down.
const MIN_SPLIT_COLUMNS = 100;

// A split down leaves each half at least this many rows, or the pane is too small to split.
const MIN_SPLIT_ROWS = 15;

/**
 * Picks where to split a pane, pi's own unless `pane` names another, or throws when it's too small.
 */
export function splitSide(
  columns: number,
  rows: number,
  tools: string,
  pane = "Your pane",
): "right" | "down" {
  if (columns / 2 >= MIN_SPLIT_COLUMNS) {
    return "right";
  }

  if (rows / 2 >= MIN_SPLIT_ROWS) {
    return "down";
  }

  throw new Error(
    `${pane} is ${columns}x${rows}, too small to split again. Use \`placement: "tab"\`, or close a pane you started with ${tools}_close.`,
  );
}

/**
 * Runs task, and if it fails, runs cleanUp before rethrowing, as when a call leaves a pane it
 * opened. `what` names the cleanup in the error when it fails too.
 */
export async function orCleanUp<T>(
  task: () => Promise<T>,
  cleanUp: () => Promise<void>,
  what: string,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    await cleanUp().catch((cause: unknown) => {
      throw new AggregateError(
        [error, cause],
        `${errorMessage(error)}. ${what} failed too: ${errorMessage(cause)}`,
        { cause: error },
      );
    });

    throw error;
  }
}

/**
 * Splits a stream into lines.
 */

import type { Readable } from "node:stream";

import { errorMessage } from "./settings.ts";

/**
 * Calls onLine for each non-blank line. The stream is a boundary, so an error in a line goes to
 * onError instead of escaping the listener and crashing pi.
 */
export function readLines(
  stream: Readable,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
): void {
  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;

    const lines = buffer.split("\n");

    buffer = lines.pop() ?? "";

    try {
      lines.filter((line) => line.trim() !== "").forEach(onLine);
    } catch (error) {
      onError(new Error(errorMessage(error)));
    }
  });
}

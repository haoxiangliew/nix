/**
 * Formats tool results and agent output for the herdr and Rex agent tools.
 */

import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";

import { errorMessage } from "./settings.ts";

export interface Result {
  content: { type: "text"; text: string }[];
  details: undefined;
}

export function text(content: string): Result {
  return { content: [{ type: "text", text: content }], details: undefined };
}

export function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Agent output has many blank lines and divider lines, so only lines with text count.
export function nonBlank(output: string, limit: number): string {
  return output
    .split("\n")
    .filter((line) => !/^[\s\u2500-\u257f]*$/.test(line))
    .slice(-limit)
    .join("\n");
}

// Keeps the last lines with text. One line of a log can be huge, so the output also gets the byte
// limit of pi's own bash output. Returns a note when it cuts, then the output.
export function trimRead(read: string, lines: number): string {
  const output = truncateTail(nonBlank(read, lines), {
    maxLines: lines,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  const note = output.truncated
    ? ` Its output is cut to the last ${formatSize(DEFAULT_MAX_BYTES)}.`
    : "";

  return `${note}\n\n${output.content}`;
}

/**
 * Reports the line `wait` finds in a running command's output. The command keeps running, so a
 * failed wait names the `<tools>_read` and `<tools>_close` tools that can check on it.
 */
export async function matchedOutput(
  running: string,
  pattern: string,
  tools: string,
  wait: () => Promise<string>,
): Promise<string> {
  const line = await wait().catch((cause: unknown) => {
    throw new Error(
      `${running} Waiting for its output failed: ${errorMessage(cause)}. The command still runs there. Read it with ${tools}_read, or close it with ${tools}_close.`,
      { cause },
    );
  });

  // One line of a log can be huge.
  const matched = truncateTail(line.trim(), { maxBytes: DEFAULT_MAX_BYTES });
  const cut = matched.truncated ? ` It's cut to the last ${formatSize(DEFAULT_MAX_BYTES)}.` : "";

  return `${running} Its output matched \`${pattern}\`:${cut}\n\n${matched.content}`;
}

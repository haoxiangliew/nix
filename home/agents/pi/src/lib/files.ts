import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Path of a file `anthropic-billing.ts` saves. */
export function billingFilePath(name: string): string {
  return join(getAgentDir(), "extensions", "anthropic-billing", name);
}

/**
 * Writes `text` to `path` with one rename, so readers never see part of it. Only the user can read
 * the file.
 */
export function writePrivateFile(path: string, text: string): void {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;

  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (cause) {
    rmSync(tmp, { force: true });
    throw cause;
  }
}

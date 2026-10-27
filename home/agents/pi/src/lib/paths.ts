import { homedir } from "node:os";
import { join } from "node:path";

/** Expands a leading `~` to the home directory, as a shell does. */
export function untildify(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Shows a path under the home directory with `~`. */
export function tildify(path: string): string {
  const home = homedir();

  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

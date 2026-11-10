import { homedir } from "node:os";
import { join } from "node:path";

export function untildify(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function tildify(path: string): string {
  const home = homedir();

  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

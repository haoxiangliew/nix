/**
 * Registers MCP servers from `.mcp.json` files in each folder from a configured root down to the
 * session's folder. Pi's own MCP support reads only `~/.pi/agent/mcp.json` and a trusted project's
 * `.pi/mcp.json`. Nearer files override farther ones. The root's own file always loads, and files
 * below it load only in a trusted project. Expands ${VAR} and ${VAR:-default} as Claude Code does,
 * since pi expands only ${VAR}, and only in env and headers. Configured by `mcpAncestors` in
 * settings.json.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  McpServerConfig,
} from "@earendil-works/pi-coding-agent";

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { errorMessage, loadOrReport } from "./lib/settings.ts";

const Config = Type.Object(
  {
    roots: Type.Array(Type.String(), { default: [] }),
  },
  { additionalProperties: false, default: {} },
);

type Config = Static<typeof Config>;

const Entry = Type.Object({
  url: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  cwd: Type.Optional(Type.String()),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

type Entry = Static<typeof Entry>;

const McpFile = Type.Object({ mcpServers: Type.Record(Type.String(), Entry) });

type Report = (message: string) => void;

type Servers = Map<string, McpServerConfig>;

const FILE = ".mcp.json";

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(path);
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);

  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// The deepest root that contains cwd, then each folder below it down to cwd.
function folders(roots: string[], cwd: string): string[] {
  let root: string | undefined;

  for (const candidate of roots.map(expandHome)) {
    if (contains(candidate, cwd) && candidate.length > (root?.length ?? -1)) {
      root = candidate;
    }
  }

  if (root === undefined) {
    return [];
  }

  const chain: string[] = [];

  for (let dir = cwd; ; dir = dirname(dir)) {
    chain.unshift(dir);

    if (dir === root) {
      return chain;
    }
  }
}

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

// With defaultsOnly, leaves ${VAR} for pi.
function expand(value: string, defaultsOnly: boolean): string {
  return value.replace(VARIABLE, (match, name: string, fallback: string | undefined) => {
    const set = process.env[name];

    if (fallback !== undefined) {
      return set === undefined || set === "" ? fallback : set;
    }

    if (defaultsOnly) {
      return match;
    }

    if (set === undefined) {
      throw new Error(`${name} is not set`);
    }

    return set;
  });
}

function expandRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return (
    record &&
    // A value starting with ! is a shell command, which expands its own variables.
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        value.startsWith("!") ? value : expand(value, true),
      ]),
    )
  );
}

// Pi resolves a relative cwd against the session's folder, but the file means its own folder.
function resolveCwd(dir: string, cwd: string): string {
  return isAbsolute(cwd) || cwd.startsWith("~") ? cwd : resolve(dir, cwd);
}

function expandFull(value: string | undefined): string | undefined {
  return value === undefined ? undefined : expand(value, false);
}

function expandEntry(dir: string, entry: Entry): Entry {
  const cwd = expandFull(entry.cwd);

  const expanded = {
    ...entry,
    url: expandFull(entry.url),
    command: expandFull(entry.command),
    args: entry.args?.map((arg) => expand(arg, false)),
    cwd: cwd === undefined ? undefined : resolveCwd(dir, cwd),
    env: expandRecord(entry.env),
    headers: expandRecord(entry.headers),
  };

  // Pi tells stdio and HTTP servers apart by which keys exist, so unset fields must be absent.
  return Object.fromEntries(Object.entries(expanded).filter(([, value]) => value !== undefined));
}

// Later calls override earlier ones, so a nearer folder wins.
function addFile(servers: Servers, dir: string, report: Report): void {
  const path = join(dir, FILE);

  if (!existsSync(path)) {
    return;
  }

  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (!Value.Check(McpFile, parsed)) {
    throw new Error("expected an mcpServers object");
  }

  for (const [name, entry] of Object.entries(parsed.mcpServers)) {
    try {
      // SAFETY: registerMcpServer validates the entry and throws if it isn't a server config.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      servers.set(name, expandEntry(dir, entry) as McpServerConfig);
    } catch (cause) {
      report(`Skipped MCP server ${name} in ${path}. ${errorMessage(cause)}`);
    }
  }
}

function collect(ctx: ExtensionContext, cfg: Config): Servers {
  const chain = folders(cfg.roots, resolve(ctx.cwd));
  // The root is the user's own folder. Folders below it may be cloned repositories.
  const allowed = ctx.isProjectTrusted() ? chain : chain.slice(0, 1);
  const servers: Servers = new Map();
  const report: Report = (message) => ctx.ui.notify(message, "error");

  for (const dir of allowed) {
    try {
      addFile(servers, dir, report);
    } catch (cause) {
      report(`Skipped ${join(dir, FILE)}. ${errorMessage(cause)}`);
    }
  }

  return servers;
}

export default function (pi: ExtensionAPI) {
  let registered: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    const cfg = loadOrReport(ctx, "The MCP ancestors extension", "mcpAncestors", Config);

    for (const name of registered) {
      pi.unregisterMcpServer(name);
    }

    registered = [];

    if (cfg === undefined) {
      return;
    }

    for (const [name, config] of collect(ctx, cfg)) {
      try {
        pi.registerMcpServer(name, config);
        registered.push(name);
      } catch (cause) {
        ctx.ui.notify(`Skipped MCP server ${name}. ${errorMessage(cause)}`, "error");
      }
    }
  });
}

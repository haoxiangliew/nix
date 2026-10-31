/**
 * Registers MCP servers from `.mcp.json` files in each folder from a configured root down to the
 * session's folder, as Claude Code does. Nearer files win. Untrusted projects load none. Expands
 * ${VAR} and ${VAR:-default}, since pi expands variables only in env and headers and has no
 * defaults. The `mcpAncestors` key in settings.json configures it.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  McpServerConfig,
} from "@earendil-works/pi-coding-agent";

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { untildify } from "./lib/paths.ts";
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
  return resolve(untildify(path));
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);

  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

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

    if (dirname(dir) === dir) {
      throw new Error(`${root} doesn't contain ${cwd}`);
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

function expandRecord(record: Record<string, string>): Record<string, string> {
  // A value starting with ! is a shell command, which expands its own variables.
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      value.startsWith("!") ? value : expand(value, true),
    ]),
  );
}

// Resolve relative cwd against the config file's directory, not the session's.
function resolveCwd(dir: string, cwd: string): string {
  return isAbsolute(cwd) || cwd.startsWith("~") ? cwd : resolve(dir, cwd);
}

// Pi picks between url and command, so keep both when both are set. Pi tells stdio and HTTP servers
// apart by which keys exist, so leave unset fields out.
function expandEntry(dir: string, entry: Entry): McpServerConfig {
  const { url, command, args, cwd, env, headers, ...rest } = entry;
  const fields: Omit<Entry, "url" | "command"> = rest;

  if (args !== undefined) {
    fields.args = args.map((arg) => expand(arg, false));
  }

  if (cwd !== undefined) {
    fields.cwd = resolveCwd(dir, expand(cwd, false));
  }

  if (env !== undefined) {
    fields.env = expandRecord(env);
  }

  if (headers !== undefined) {
    fields.headers = expandRecord(headers);
  }

  const stdio = command === undefined ? undefined : { ...fields, command: expand(command, false) };

  if (url !== undefined) {
    return { ...(stdio ?? fields), url: expand(url, false) };
  }

  if (stdio === undefined) {
    throw new Error("expected a url or a command");
  }

  return stdio;
}

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
      servers.set(name, expandEntry(dir, entry));
    } catch (cause) {
      report(`Skipped MCP server ${name} in ${path}. ${errorMessage(cause)}`);
    }
  }
}

function collect(ctx: ExtensionContext, cfg: Config): Servers {
  const servers: Servers = new Map();
  const report: Report = (message) => ctx.ui.notify(message, "error");

  for (const dir of folders(cfg.roots, resolve(ctx.cwd))) {
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

    if (cfg === undefined || !ctx.isProjectTrusted()) {
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

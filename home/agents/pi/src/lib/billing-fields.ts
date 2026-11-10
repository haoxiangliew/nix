// Per-request fields Claude Code derives from its conversation, in its own formats.

export const toolDurationsHeader = "x-claude-code-prev-tool-durations";

export const toolsUsedHeader = "x-claude-code-sandy-plover";

/** Whether an `anthropic-beta` header value lists a beta whose name starts with `prefix`. */
export function hasBeta(value: string | null | undefined, prefix: string): boolean {
  return (value ?? "").split(",").some((beta) => beta.trim().startsWith(prefix));
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// Body keys in the order the CLI writes them. Unknown keys go between the two groups.
const leadingKeys = [
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "metadata",
  "max_tokens",
  "thinking",
  "temperature",
  "context_management",
];

const trailingKeys = ["output_config", "speed", "thread", "diagnostics", "stream"];

// The CLI lists these built-in tools after all others.
const coreTools = new Set([
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "NotebookEdit",
  "TodoWrite",
  "Agent",
  "Task",
  "ToolSearch",
  "EnterPlanMode",
  "ExitPlanMode",
]);

const unreadableTool = "unreadable-tools-used-before-summary";

const maxToolsUsed = 64;

const maxToolsUsedBytes = 7168;

const maxToolDurations = 32;

const maxToolDurationsLength = 4096;

// Fields that follow cc_prev_req in the CLI's billing header.
const laterThanPreviousRequest = new Set([
  "cc_prompt_id",
  "cc_turn_origin",
  "cc_prompt_index",
  "cc_turn_index",
  "cc_gateway",
  "cc_project",
  "cc_project_src",
  "cc_prev_msg",
  "cc_prev_prompt_index",
  "cc_prev_turn_index",
]);

export interface ToolRun {
  readonly name: string;
  readonly durationMs: number;
}

function keyRank(key: string): number {
  const leading = leadingKeys.indexOf(key);

  if (leading !== -1) {
    return leading;
  }

  const trailing = trailingKeys.indexOf(key);

  return leadingKeys.length + (trailing === -1 ? 0 : 1 + trailing);
}

export function orderedBody<Value>(body: Readonly<Record<string, Value>>): Record<string, Value> {
  return Object.fromEntries(
    Object.entries(body).toSorted(([first], [second]) => keyRank(first) - keyRank(second)),
  );
}

export function isRequestId(value: string | undefined): value is string {
  return value !== undefined && /^req_[A-Za-z0-9_-]{1,36}$/.test(value);
}

export function withPreviousRequest(
  fields: ReadonlyMap<string, string>,
  requestId: string,
): Map<string, string> {
  const entries = [...fields].filter(([name]) => name !== "cc_prev_req");
  const index = entries.findIndex(([name]) => laterThanPreviousRequest.has(name));

  entries.splice(index === -1 ? entries.length : index, 0, ["cc_prev_req", requestId]);

  return new Map(entries);
}

export function toolsUsedName(name: string): string {
  return /^[A-Za-z0-9_.:-]{1,256}$/.test(name) ? name : unreadableTool;
}

function encodeToolsUsed(names: readonly string[]): string[] {
  const entries: string[] = [];
  let size = 2;

  for (const name of names) {
    if (entries.length === maxToolsUsed) {
      break;
    }

    const entry = JSON.stringify({ name });
    const cost = entry.length + (entries.length === 0 ? 0 : 1);

    if (size + cost > maxToolsUsedBytes) {
      break;
    }

    entries.push(entry);
    size += cost;
  }

  return entries;
}

// Names come from toolsUsedName, so they are short ASCII.
export function toolsUsedValue(names: readonly string[]): string {
  const ordered = [
    ...names.filter((name) => !coreTools.has(name)),
    ...names.filter((name) => coreTools.has(name)),
  ];

  let entries = encodeToolsUsed(ordered);

  if (entries.length < names.length) {
    entries = encodeToolsUsed([unreadableTool, ...ordered]);
  }

  return `[${entries.join(",")}]`;
}

function encodeToolName(name: string): string {
  return name.replace(/%|[;=, ]|[^\x20-\x7e]/gu, (character) => encodeURIComponent(character));
}

export function toolDurationsValue(runs: readonly ToolRun[]): string | undefined {
  const parts: string[] = [];
  let length = 0;

  for (const { name, durationMs } of runs) {
    if (parts.length >= maxToolDurations) {
      break;
    }

    if (!Number.isFinite(durationMs)) {
      continue;
    }

    const part = `${encodeToolName(name)}=${Math.max(0, Math.round(durationMs))}`;
    const separator = parts.length > 0 ? 1 : 0;

    if (length + separator + part.length > maxToolDurationsLength) {
      break;
    }

    length += separator + part.length;
    parts.push(part);
  }

  return parts.length > 0 ? parts.join(";") : undefined;
}

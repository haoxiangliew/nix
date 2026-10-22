/**
 * Wakes pi when a herdr agent that pi prompted stops working, so pi doesn't poll. Before a bash call
 * runs `herdr agent prompt` without --wait, it subscribes to that agent's status on herdr's event
 * socket. When the agent settles or needs input, it sends a message with its state, and pi reads the
 * output itself. If watching stops first, the message says so. No settings.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createConnection, type Socket } from "node:net";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  forEachChild,
  parse,
  type Assignment,
  type Command,
  type For,
  type SyntaxNode,
  type Word,
  type WordPart,
} from "unbash";

import { errorMessage } from "./lib/settings.ts";

const HERDR_TIMEOUT_MS = 2000;

const WIDGET = "herdr-agents";

const SETTLED = new Set(["idle", "done", "blocked"]);

// Keys answer a blocked agent, so they need a message like a prompt does.
const ACTIONS = new Set(["start", "prompt", "send-keys"]);

const VALUE_OPTIONS = new Set(["--until", "--timeout", "--pane", "--kind"]);

// Wrappers that run the next word after their options as the command.
const WRAPPERS = new Set(["builtin", "command", "env", "exec", "nice", "nohup", "time"]);

// Wrapper options that take a value, such as `-u` in `env -u NAME` or `-s` in `timeout -s KILL`.
const WRAPPER_VALUE_OPTIONS = new Set(["-a", "-C", "-k", "-n", "-S", "-s", "-u"]);

const RULE =
  "After you prompt a herdr agent without `--wait` or send it keys, an extension messages you when the agent is done, idle, or blocked, or when it can't watch the agent. Don't poll a watched agent with `sleep` or `herdr agent get`, `read`, or `wait`. End your turn or keep working, then read the output with `herdr agent read`. The extension can watch an agent when its name is written in the call, in a variable set earlier in the command, or in a `for` loop over listed names.";

const socketPath = process.env.HERDR_ENV === "1" ? process.env.HERDR_SOCKET_PATH : undefined;

const AgentGet = Type.Object({
  // herdr leaves out the name of an unnamed agent.
  result: Type.Object({
    agent: Type.Object({
      pane_id: Type.String(),
      agent_status: Type.String(),
      name: Type.Optional(Type.String()),
    }),
  }),
});

const Started = Type.Object({
  result: Type.Object({ type: Type.Literal("subscription_started") }),
});

const StatusEvent = Type.Object({
  event: Type.Literal("pane.agent_status_changed"),
  data: Type.Object({
    agent_status: Type.String(),
    agent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  }),
});

interface HerdrCall {
  action: string;
  target?: string;
  pane?: string;
  wait: boolean;
}

interface Armed {
  pane: string;
  before: Pick<Watch, "name" | "armed" | "active" | "status" | "since">;
}

interface Agent {
  pane: string;
  name?: string;
  // An agent started in the same command has no status yet.
  status?: string;
}

// Matches herdr's own --wait, which gives up on a prompt that shows no activity in this time.
const STALL_MS = 5000;

// Nested loops multiply the commands to check, and checking blocks the tool call.
const MAX_VISITS = 20_000;

// Bash runs these in a child process, so their assignments don't reach later commands.
const CHILD_SCOPES = new Set(["Subshell", "CommandExpansion", "ProcessSubstitution", "Coproc"]);

// In these, the first child always runs and the others may not.
const BRANCHES = new Set(["If", "Case", "AndOr"]);

// These run their children any number of times.
const LOOPS = new Set(["While", "Select", "ArithmeticFor"]);

// Built-ins that can set the variables named in their arguments.
const VAR_WRITERS = new Set([
  "declare",
  "export",
  "getopts",
  "let",
  "local",
  "mapfile",
  "printf",
  "read",
  "readarray",
  "readonly",
  "typeset",
  "unset",
]);

// Built-ins where `-i` evaluates values as arithmetic and `-n` makes a name refer to another
// variable.
const DECLARERS = new Set(["declare", "local", "typeset"]);

// Shells whose `-c` script the walk reads.
const SHELLS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);

const DEFAULT_IFS = " \t\n";

// Variables these built-ins set without naming them.
const IMPLICIT_WRITES = new Map([
  ["getopts", ["OPTARG", "OPTIND"]],
  ["mapfile", ["MAPFILE"]],
  ["read", ["REPLY"]],
  ["readarray", ["MAPFILE"]],
]);

// Commands that run their arguments as another command, which this can't watch.
const RUNNERS = new Set(["find", "parallel", "sudo", "watch", "xargs"]);

// Traps that run between commands, so their action can change variables at any point.
const STEP_TRAPS = new Set(["DEBUG", "ERR", "RETURN"]);

// Built-ins that can set any variable.
const ANY_WRITERS = new Set(["eval", "source", "."]);

type Vars = Map<string, string>;

// A command argument, with its value when it doesn't need the shell.
interface Item {
  arg: string;
  value: string | undefined;
}

interface Definition {
  body: SyntaxNode;
  // The script the body's positions point into.
  source: string;
}

interface Walk {
  source: string;
  calls: HerdrCall[];
  visits: number;
  // Function bodies by name, walked where the function is called. A function defined in a part
  // that may not run has each possible body.
  functions: Map<string, Definition[]>;
  // Functions being walked, so a recursive call stops.
  calling: Set<string>;
  // After `declare -n`, an assignment can set another variable.
  nameref: boolean;
  // Names declared with `-i` or `-n`, whose assigned values bash changes.
  typed: Set<string>;
  // After `trap … DEBUG`, any command can change any variable.
  trapped: boolean;
  // Source of the herdr agent calls it can't watch, such as `xargs herdr` or `herdr --machine`.
  missed: Set<string>;
}

interface Watch {
  name?: string;
  // Waiting for a message about the last prompt.
  armed: boolean;
  // Worked since the last prompt, so a settled state means the prompt finished.
  active: boolean;
  status: string;
  since: number;
  socket: Socket;
}

// Undefined when the value needs the shell, such as `$(…)`, a glob, or an unknown variable.
function partValue(part: WordPart, vars: Vars): string | undefined {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      return part.value;
    case "DoubleQuoted":
      return joinParts(part.parts, vars);
    case "SimpleExpansion":
      return vars.get(part.text.slice(1));
    case "ParameterExpansion":
      return part.prefix === undefined && part.index === undefined && part.operation === undefined
        ? vars.get(part.parameter)
        : undefined;
    default:
      return undefined;
  }
}

function joinParts(parts: readonly WordPart[], vars: Vars): string | undefined {
  let value = "";

  for (const part of parts) {
    const piece = partValue(part, vars);

    if (piece === undefined) {
      return undefined;
    }

    value += piece;
  }

  return value;
}

function wordValue(word: Word, vars: Vars): string | undefined {
  return word.parts === undefined ? word.value : joinParts(word.parts, vars);
}

function isUnquotedExpansion(part: WordPart): boolean {
  return part.type === "SimpleExpansion" || part.type === "ParameterExpansion";
}

// Joins the parts into fields. The value of an unquoted variable splits on `separators`.
function joinFields(
  parts: readonly WordPart[],
  vars: Vars,
  separators: RegExp | undefined,
): string[] | undefined {
  const fields = [""];

  for (const part of parts) {
    const value = partValue(part, vars);

    if (value === undefined) {
      return undefined;
    }

    const [first = "", ...rest] =
      separators !== undefined && isUnquotedExpansion(part) ? value.split(separators) : [value];

    fields.push(`${fields.pop() ?? ""}${first}`, ...rest);
  }

  return fields.filter((field) => field !== "");
}

// An unquoted variable splits on the characters in `IFS`, as in the shell. Literal and quoted
// parts stay whole.
function splitWord(word: Word, vars: Vars): string[] | undefined {
  const ifs = vars.get("IFS");

  if (word.parts?.some(isUnquotedExpansion) !== true) {
    const value = wordValue(word, vars);

    return value === undefined ? undefined : [value];
  }

  if (ifs === undefined) {
    return undefined;
  }

  const separators = new RegExp(`[${ifs.replaceAll(/[\\\]^-]/g, "\\$&")}]+`);

  return joinFields(word.parts, vars, ifs === "" ? undefined : separators);
}

// An unknown value, array, or indexed element makes the variable unknown.
function assign(walk: Walk, item: Assignment, vars: Vars): void {
  if (walk.nameref) {
    vars.clear();

    return;
  }

  const value =
    item.value.type === "Word" && item.index === undefined && !walk.typed.has(item.name)
      ? wordValue(item.value, vars)
      : undefined;

  const base = item.append === true ? vars.get(item.name) : "";

  if (value === undefined || base === undefined) {
    vars.delete(item.name);
  } else {
    vars.set(item.name, base + value);
  }
}

function forgetNames(text: string, pattern: RegExp, vars: Vars): void {
  for (const name of text.match(pattern) ?? []) {
    vars.delete(name);
  }
}

// Returns whether an option such as `-i`, `-n`, or `-l` makes bash change the assigned values. An
// option that needs the shell could be any of them.
function readOptions(walk: Walk, node: Command, program: string, vars: Vars): boolean {
  if (!DECLARERS.has(program)) {
    return false;
  }

  const options = node.args.flatMap((arg) => {
    const value = arg.type === "Word" ? wordValue(arg, vars) : "";

    return value === undefined || /^[-+]/.test(value) ? [value] : [];
  });

  walk.nameref ||= options.some((option) => option?.includes("n") ?? true);

  return options.some((option) => option === undefined || /[inulc]/.test(option));
}

// `printf` only sets the variable after `-v`, or attached as in `-vname`. The others can set any
// name in their arguments, and some set one they don't name. An undefined value is a name that
// needs the shell.
function writtenValues(node: Command, program: string, vars: Vars): (string | undefined)[] {
  const values = node.args.flatMap((arg) => (arg.type === "Word" ? [wordValue(arg, vars)] : []));

  if (program !== "printf") {
    return [...(IMPLICIT_WRITES.get(program) ?? []), ...values];
  }

  const flag = values.findIndex((value) => value?.startsWith("-v") === true);
  const option = values[flag] ?? "";

  if (flag === -1) {
    return [];
  }

  return option === "-v" ? values.slice(flag + 1, flag + 2) : [option.slice(2)];
}

// Variables a built-in may set become unknown, except literal assignments such as `export a=b`.
// `let` can set any name in its expressions. The others set the name each argument starts with.
// A name that needs the shell could be any variable.
function readWrites(walk: Walk, node: Command, program: string, vars: Vars): void {
  const typed = readOptions(walk, node, program, vars);
  const pattern = program === "let" ? /[A-Za-z_]\w*/g : /^[A-Za-z_]\w*/;

  for (const value of writtenValues(node, program, vars)) {
    if (value === undefined) {
      vars.clear();
    } else if (typed) {
      // `declare -i "n=1"` names `n`.
      value.match(/^[A-Za-z_]\w*/)?.forEach((name) => walk.typed.add(name));
    }

    forgetNames(value ?? "", pattern, vars);
  }

  for (const arg of node.args) {
    if (arg.type === "Assignment") {
      if (typed) {
        walk.typed.add(arg.name);
      }

      assign(walk, arg, vars);
    }
  }
}

// A function's body runs where it's called. A recursive call could change any variable.
function callFunction(walk: Walk, program: string, vars: Vars): void {
  const definitions = walk.functions.get(program) ?? [];

  if (definitions.length === 0) {
    return;
  }

  if (walk.calling.has(program)) {
    vars.clear();

    return;
  }

  const source = walk.source;

  walk.calling.add(program);

  for (const definition of definitions) {
    walk.source = definition.source;

    if (hasJump(definition.body, /^return$/)) {
      visitSkippable(walk, [definition.body], vars);
    } else {
      maybe(walk, definition.body, vars);
    }
  }

  walk.source = source;
  walk.calling.delete(program);
}

// Assignments before a function call, as in `a=b f`, only last for the call.
function runFunction(walk: Walk, node: Command, program: string, vars: Vars): void {
  const assignments = node.prefix.flatMap((item) => (item.type === "Assignment" ? [item] : []));

  if (!walk.functions.has(program) || assignments.length === 0) {
    callFunction(walk, program, vars);

    return;
  }

  const inner = copyVars(vars);

  readAssignments(walk, node, inner);
  callFunction(walk, program, inner);

  for (const { name } of assignments) {
    const value = vars.get(name);

    if (value === undefined) {
      inner.delete(name);
    } else {
      inner.set(name, value);
    }
  }

  intersect(vars, inner);
}

// A function defined in a part that may not run keeps its earlier bodies too.
function keepDefinitions(walk: Walk, before: Map<string, Definition[]>): void {
  for (const [name, definitions] of walk.functions) {
    const earlier = before.get(name) ?? [];

    if (definitions !== earlier) {
      const bodies = new Set(earlier.map((definition) => definition.body));

      walk.functions.set(name, [
        ...earlier,
        ...definitions.filter((definition) => !bodies.has(definition.body)),
      ]);
    }
  }
}

// Functions defined in a child shell don't reach its parent.
function inChild(walk: Walk, run: () => void): void {
  const { functions, nameref, typed, trapped } = walk;

  walk.functions = new Map(functions);
  walk.typed = new Set(typed);
  run();
  Object.assign(walk, { functions, nameref, typed, trapped });
}

// A new shell starts with no functions, and only exported variables, which aren't tracked.
function walkScript(walk: Walk, script: string): void {
  const { source, functions, nameref, typed, trapped } = walk;
  const fresh = { functions: new Map(), nameref: false, typed: new Set(), trapped: false };

  Object.assign(walk, { source: script, ...fresh });
  visit(walk, parse(script), new Map([["IFS", DEFAULT_IFS]]));
  Object.assign(walk, { source, functions, nameref, typed, trapped });
}

// Returns where the `-c` script is, reading options up to `--` or the first other argument.
function scriptIndex(args: string[], at: number): number | undefined {
  for (let index = at + 1; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
      return index + 1;
    }

    if (arg === "--" || !/^[-+]/.test(arg)) {
      return undefined;
    }

    // `-o name` and `-O name` take a value.
    index += /^[-+][oO]$/.test(arg) ? 1 : 0;
  }

  return undefined;
}

function readShell(walk: Walk, node: Command, args: string[], values: Item[], at: number): void {
  const index = SHELLS.has(args[at]?.split("/").at(-1) ?? "") ? scriptIndex(args, at) : undefined;
  const script = index === undefined ? undefined : values[index];

  if (script?.value !== undefined) {
    walkScript(walk, script.value);
  } else if (script?.arg.includes("herdr") === true) {
    walk.missed.add(walk.source.slice(node.pos, node.end));
  }
}

// Whether the command runs `herdr agent prompt` or `send-keys` in a way this can't watch, with
// `--machine` or through a command such as `xargs`. A call that waits needs no watch.
function runsHerdrAgent(args: string[], at: number): boolean {
  const herdr = args.findIndex(isHerdr);
  const agent = herdr === -1 ? -1 : args.indexOf("agent", herdr);
  const runs = herdr === at || (herdr > at && RUNNERS.has(args[at] ?? ""));
  const waits = args.includes("--wait") || args.includes("--until");

  const action = agent === -1 ? undefined : args[agent + 1];

  return runs && !waits && (action === "prompt" || action === "send-keys");
}

function readAssignments(walk: Walk, node: Command, vars: Vars): void {
  for (const item of node.prefix) {
    if (item.type === "Assignment") {
      assign(walk, item, vars);
    }
  }
}

// A word that needs the shell keeps its source text, so its agent can't be found.
function commandItems(node: Command, vars: Vars): Item[] {
  return [node.name, ...node.args].flatMap((arg): Item[] => {
    if (arg?.type !== "Word") {
      return [];
    }

    const pieces = splitWord(arg, vars);

    return pieces === undefined
      ? [{ arg: arg.text, value: undefined }]
      : pieces.map((piece) => ({ arg: piece, value: piece }));
  });
}

// Returns the program, which may be a function to run.
function readCommand(walk: Walk, node: Command, vars: Vars): string {
  // A command of only assignments sets variables for the commands after it.
  if (node.name === undefined) {
    readAssignments(walk, node, vars);

    return "";
  }

  const items = commandItems(node, vars);
  const args = items.map((item) => item.arg);
  const at = commandStart(args);
  const program = args[at] ?? "";
  const call = herdrCall(args);

  if (call !== undefined) {
    walk.calls.push(call);
  } else if (runsHerdrAgent(args, at)) {
    walk.missed.add(walk.source.slice(node.pos, node.end));
  }

  readShell(walk, node, args, items, at);
  walk.trapped ||= program === "trap" && args.slice(at + 2).some((arg) => STEP_TRAPS.has(arg));

  // These can also define any function.
  if (ANY_WRITERS.has(program)) {
    vars.clear();
    walk.functions = new Map();
  } else if (VAR_WRITERS.has(program)) {
    readWrites(walk, node, program, vars);
  }

  return program;
}

// Arithmetic and `${name:=value}` can set variables, so every name they use becomes unknown.
function readExpansionWrites(walk: Walk, node: SyntaxNode, vars: Vars): void {
  if (node.type.startsWith("Arithmetic") && node.type !== "ArithmeticFor") {
    forgetNames(walk.source.slice(node.pos, node.end), /[A-Za-z_]\w*/g, vars);
  } else if (node.type === "ParameterExpansion" && node.operation?.type === "Default") {
    if (node.operation.operator.includes("=")) {
      vars.delete(node.parameter);
    }
  }
}

function childrenOf(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];

  forEachChild(node, (child) => children.push(child));

  return children;
}

// Keeps the variables that have the same value in both maps.
function intersect(vars: Vars, other: Vars): void {
  for (const [name, value] of vars) {
    if (other.get(name) !== value) {
      vars.delete(name);
    }
  }
}

// A part that may not run keeps only the variables it leaves unchanged.
function maybe(walk: Walk, node: SyntaxNode, vars: Vars): void {
  const inner = copyVars(vars);
  const functions = new Map(walk.functions);

  visit(walk, node, inner);
  intersect(vars, inner);
  keepDefinitions(walk, functions);
}

// The written names of each map that records its writes.
const recorders = new WeakMap<Vars, Set<string>>();

// Records every variable a body writes, even one it later sets back.
function recorder(vars: Vars, written: Set<string>): Vars {
  const inner = new Map(vars);

  recorders.set(inner, written);

  inner.set = (name, value) => {
    written.add(name);
    Map.prototype.set.call(inner, name, value);

    return inner;
  };

  inner.delete = (name) => {
    written.add(name);

    return Map.prototype.delete.call(inner, name);
  };

  inner.clear = () => {
    inner.forEach((_value, name) => written.add(name));
    Map.prototype.clear.call(inner);
  };

  return inner;
}

// A copy inside a body that may stop early records its writes too.
function copyVars(vars: Vars): Vars {
  const written = recorders.get(vars);

  return written === undefined ? new Map(vars) : recorder(vars, written);
}

// `break`, `continue`, and `return` can stop a body at any point, so every variable it writes
// becomes unknown.
function visitSkippable(walk: Walk, nodes: SyntaxNode[], vars: Vars): void {
  const written = new Set<string>();
  const inner = recorder(vars, written);
  const functions = new Map(walk.functions);

  nodes.forEach((node) => visit(walk, node, inner));
  written.forEach((name) => vars.delete(name));
  keepDefinitions(walk, functions);
}

// Runs the body until it changes no known variable, dropping the ones it changes. Only the last
// pass keeps its calls, because earlier passes may have used values that a later run changes.
function repeat(walk: Walk, nodes: SyntaxNode[], vars: Vars): void {
  for (;;) {
    const known = vars.size;
    const calls = walk.calls.length;

    visitSkippable(walk, nodes, vars);

    if (vars.size === known) {
      return;
    }

    walk.calls.length = calls;
  }
}

// A `for` over known words runs its body once per word, so `rv$n` resolves to each agent's name.
function visitFor(walk: Walk, node: For, vars: Vars): void {
  const lists = node.wordlist?.map((word) => splitWord(word, vars));
  const name = node.name.value;

  // Bash changes a value assigned to a name declared with `-i` or `-n`.
  const typed = walk.nameref || walk.typed.has(name);

  if (typed || lists?.every((list): list is string[] => list !== undefined) !== true) {
    vars.delete(name);
    repeat(walk, childrenOf(node), vars);

    return;
  }

  const jumps = hasJump(node.body, /^(?:break|continue)$/);

  for (const word of lists.flat()) {
    vars.set(name, word);

    if (jumps) {
      visitSkippable(walk, [node.body], vars);
    } else {
      visit(walk, node.body, vars);
    }
  }

  // `break` can skip the remaining words.
  if (jumps) {
    vars.delete(name);
  }
}

function hasJump(node: SyntaxNode, jumps: RegExp): boolean {
  if (node.type === "Command" && jumps.test(node.name?.value ?? "")) {
    return true;
  }

  return childrenOf(node).some((child) => hasJump(child, jumps));
}

function isChildScope(node: SyntaxNode): boolean {
  return CHILD_SCOPES.has(node.type) || (node.type === "Statement" && node.background === true);
}

function visitChildren(walk: Walk, node: SyntaxNode, vars: Vars): void {
  if (node.type === "For") {
    visitFor(walk, node, vars);

    return;
  }

  const children = childrenOf(node);

  if (node.type === "Function") {
    walk.functions.set(node.name.value, [{ body: node.body, source: walk.source }]);
  } else if (LOOPS.has(node.type)) {
    // `select` sets its variable to the chosen word.
    if (node.type === "Select") {
      vars.delete(node.name.value);
    }

    repeat(walk, children, vars);
  } else if (isChildScope(node)) {
    const inner = new Map(vars);

    inChild(walk, () => children.forEach((child) => visit(walk, child, inner)));
  } else if (node.type === "Pipeline" && node.commands.length > 1) {
    children.forEach((child) => inChild(walk, () => visit(walk, child, new Map(vars))));
  } else if (BRANCHES.has(node.type)) {
    children.forEach((child, index) =>
      index === 0 ? visit(walk, child, vars) : maybe(walk, child, vars),
    );
  } else {
    children.forEach((child) => visit(walk, child, vars));
  }
}

function visit(walk: Walk, node: SyntaxNode, vars: Vars): void {
  walk.visits += 1;

  if (walk.visits > MAX_VISITS) {
    throw new Error("its loops run too many commands to check");
  }

  const source = walk.source;

  // Positions inside an escaped backtick script index its own decoded source.
  if (node.type === "Script" && node.source !== undefined) {
    walk.source = node.source;
  }

  readExpansionWrites(walk, node, vars);
  // Bash expands a command's words before it assigns or runs anything.
  visitChildren(walk, node, vars);

  if (node.type === "Command") {
    if (walk.trapped) {
      vars.clear();
    }

    runFunction(walk, node, readCommand(walk, node, vars), vars);
  }

  walk.source = source;
}

// Finds herdr agent calls without running the command, following variables bash would set.
function herdrCalls(command: string): Pick<Walk, "calls" | "missed"> {
  // Most commands don't mention herdr, so they skip parsing.
  if (!command.includes("herdr")) {
    return { calls: [], missed: new Set() };
  }

  const walk: Walk = {
    source: command,
    calls: [],
    visits: 0,
    functions: new Map(),
    calling: new Set(),
    nameref: false,
    typed: new Set(),
    trapped: false,
    missed: new Set(),
  };

  walkScript(walk, command);

  // A call sent again needs one watch. Keeping the last one keeps a prompt after a `--wait`.
  const keys = walk.calls.map((call) => JSON.stringify(call));
  const calls = walk.calls.filter((_call, index) => keys.lastIndexOf(keys[index] ?? "") === index);

  return { calls, missed: walk.missed };
}

// Returns how many values the option takes.
function readOption(
  call: Omit<HerdrCall, "action">,
  arg: string,
  next: string | undefined,
): number {
  if (arg === "--wait" || arg === "--until") {
    call.wait = true;
  }

  if (arg === "--pane") {
    call.pane = next;
  }

  return VALUE_OPTIONS.has(arg) ? 1 : 0;
}

// A prompt's text follows its target and can look like an option, so it's skipped.
function parseOptions(args: string[], hasText: boolean): Omit<HerdrCall, "action"> {
  const call: Omit<HerdrCall, "action"> = { wait: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--") {
      break;
    }

    if (call.target === undefined && !arg.startsWith("-")) {
      call.target = arg;
      index += hasText ? 1 : 0;
    } else {
      index += readOption(call, arg, args[index + 1]);
    }
  }

  return call;
}

function skipOptions(args: string[], start: number): number {
  let index = start;

  while (args[index]?.startsWith("-") === true) {
    const arg = args[index] ?? "";

    index += WRAPPER_VALUE_OPTIONS.has(arg) ? 2 : 1;

    if (arg === "--") {
      break;
    }
  }

  return index;
}

// Skips variable assignments and wrappers such as `env -i` and `timeout -s KILL 60`.
function commandStart(args: string[]): number {
  let index = 0;

  while (index < args.length) {
    const arg = args[index] ?? "";

    if (arg === "timeout") {
      index = skipOptions(args, index + 1) + 1;
    } else if (WRAPPERS.has(arg)) {
      index = skipOptions(args, index + 1);
    } else if (/^[A-Za-z_]\w*=/.test(arg)) {
      index += 1;
    } else {
      return index;
    }
  }

  return index;
}

function isHerdr(arg: string): boolean {
  return arg === "herdr" || arg.endsWith("/herdr");
}

// --machine targets another server, so `herdr --machine x agent …` doesn't match.
function herdrCall(args: string[]): HerdrCall | undefined {
  const at = commandStart(args);
  const program = args[at] ?? "";
  const [group, action, ...rest] = args.slice(at + 1);

  if (!isHerdr(program)) {
    return undefined;
  }

  if (group !== "agent" || !ACTIONS.has(action ?? "")) {
    return undefined;
  }

  return { action: action ?? "", ...parseOptions(rest, action === "prompt") };
}

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stateColor(status: string): ThemeColor {
  if (status === "working") {
    return "accent";
  }

  if (status === "blocked") {
    return "warning";
  }

  return SETTLED.has(status) ? "success" : "muted";
}

function widgetLines(rows: [string, Watch][], theme: Theme, width: number): string[] {
  const now = Date.now();
  const nameWidth = Math.max(...rows.map(([pane, watch]) => (watch.name ?? pane).length));

  const lines = rows.map(([pane, watch], index) => {
    const branch = theme.fg("dim", index === rows.length - 1 ? "└─" : "├─");
    const name = theme.fg("mdCode", (watch.name ?? pane).padEnd(nameWidth));
    const state = theme.fg(stateColor(watch.status), watch.status);
    const time = theme.fg("dim", ` · ${elapsed(now - watch.since)}`);

    return `${branch} ${name}  ${state}${time}`;
  });

  return [theme.fg("accent", "● Herdr"), ...lines].map((line) => truncateToWidth(line, width));
}

// A just-started agent reports idle before it gets the prompt, so a settled state counts only
// after the agent worked. Blocked needs input, so it counts right away.
function finished(watch: Watch, status: string): boolean {
  return watch.armed && (status === "blocked" || (watch.active && SETTLED.has(status)));
}

// herdr's socket is a boundary, so an error in a line goes to onError instead of escaping the
// listener and crashing pi.
function readLines(
  socket: Socket,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
): void {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString();

    const lines = buffer.split("\n");

    buffer = lines.pop() ?? "";

    try {
      lines.filter((line) => line.trim() !== "").forEach(onLine);
    } catch (error) {
      onError(new Error(errorMessage(error)));
    }
  });
}

// Resolves once herdr confirms the subscription, so no status change is missed after that.
function subscribe(
  path: string,
  pane: string,
  onEvent: (line: string) => void,
  onFail: (error: Error) => void,
): Promise<Socket> {
  const socket = createConnection(path);

  const request = {
    id: "subscribe",
    method: "events.subscribe",
    params: { subscriptions: [{ type: "pane.agent_status_changed", pane_id: pane }] },
  };

  return new Promise((resolve, reject) => {
    let started = false;

    const fail = (error: Error): void => {
      socket.destroy();

      if (started) {
        onFail(error);
      } else {
        reject(error);
      }
    };

    socket.setTimeout(HERDR_TIMEOUT_MS, () =>
      fail(new Error("herdr didn't confirm the subscription")),
    );
    socket.on("error", fail);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));

    // Destroying the socket clears its timeout, so a close before the reply has to reject.
    socket.on("close", () => reject(new Error("herdr closed the socket before confirming")));

    readLines(
      socket,
      (line) => {
        if (started) {
          onEvent(line);

          return;
        }

        if (!Value.Check(Started, JSON.parse(line))) {
          throw new Error(`herdr refused the subscription: ${line.slice(0, 200)}`);
        }

        started = true;
        socket.setTimeout(0);
        resolve(socket);
      },
      fail,
    );
  });
}

export default function (pi: ExtensionAPI) {
  const watches = new Map<string, Watch>();
  // Panes each bash call armed, with their watch from before, restored if the call never ran.
  const pending = new Map<string, Armed[]>();
  const openings = new Map<string, Promise<Watch>>();
  let context: ExtensionContext | undefined;
  let live = false;
  let shown = false;
  let tui: TUI | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;

  // The model waits for these messages instead of polling, so problems go to it too.
  function tell(content: string): void {
    if (live) {
      pi.sendMessage(
        { customType: "herdr-agent", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }
  }

  function label(pane: string, watch: Watch | undefined): string {
    return watch?.name === undefined ? `\`${pane}\`` : `\`${watch.name}\` (\`${pane}\`)`;
  }

  function waiting(): [string, Watch][] {
    return [...watches].filter(([, watch]) => watch.armed);
  }

  function hide(ui: ExtensionUIContext): void {
    clearInterval(ticker);
    ticker = undefined;
    tui = undefined;

    if (shown) {
      shown = false;
      ui.setWidget(WIDGET, undefined);
    }
  }

  // pi stacks widgets in the order they're added and moves a re-added one to the end, so this adds
  // the widget once and then only repaints it, keeping its place next to other widgets. Its theme
  // is a live proxy, so it never needs adding again.
  function refresh(): void {
    const ui = context?.ui;

    if (ui === undefined) {
      return;
    }

    if (waiting().length === 0) {
      hide(ui);

      return;
    }

    if (shown) {
      tui?.requestRender();

      return;
    }

    shown = true;
    ui.setWidget(WIDGET, (instance, theme) => {
      tui = instance;

      return {
        render: (width: number) => widgetLines(waiting(), theme, width),
        invalidate: () => undefined,
      };
    });

    clearInterval(ticker);
    ticker = setInterval(() => tui?.requestRender(), 1000);
    ticker.unref();
  }

  function unwatch(pane: string): void {
    watches.get(pane)?.socket.destroy();
    watches.delete(pane);
    refresh();
  }

  // Tells the model when a watch it relies on ends without a result.
  function stop(pane: string, reason: string): void {
    const watch = watches.get(pane);

    if (watch?.armed === true) {
      tell(`Stopped watching herdr agent ${label(pane, watch)}: ${reason}. Check on it yourself.`);
    }

    unwatch(pane);
  }

  function onEvent(pane: string, line: string): void {
    const event: unknown = JSON.parse(line);

    if (!Value.Check(StatusEvent, event)) {
      throw new Error(`unexpected herdr event: ${line.slice(0, 200)}`);
    }

    const watch = watches.get(pane);
    const { agent, agent_status: status } = event.data;

    if (watch === undefined) {
      return;
    }

    // herdr leaves out the agent, or sends null, once it exits.
    if (agent === undefined || agent === null) {
      stop(pane, "the agent exited");

      return;
    }

    watch.status = status;
    watch.active = watch.active || status === "working";

    if (finished(watch, status)) {
      watch.armed = false;
      tell(`Herdr agent ${label(pane, watch)} is ${status}.`);
    }

    refresh();
  }

  async function agentOf(target: string): Promise<Agent> {
    const result = await pi.exec("herdr", ["agent", "get", target], { timeout: HERDR_TIMEOUT_MS });

    if (result.code !== 0) {
      throw new Error(`herdr agent get ${target} failed: ${result.stderr.trim()}`);
    }

    const parsed: unknown = JSON.parse(result.stdout);

    if (!Value.Check(AgentGet, parsed)) {
      throw new Error(`unexpected herdr agent get output: ${result.stdout.slice(0, 200)}`);
    }

    const { pane_id: pane, name, agent_status: status } = parsed.result.agent;

    return { pane, name, status };
  }

  // A prompt that the agent never acts on, because it failed or got lost, would otherwise leave
  // the model waiting for good.
  function checkStall(pane: string, watch: Watch, since: number): void {
    setTimeout(() => {
      if (watch.armed && !watch.active && watch.since === since && watches.get(pane) === watch) {
        watch.armed = false;
        tell(
          `Herdr agent ${label(pane, watch)} didn't start working within ${STALL_MS / 1000} seconds, so it may not have the prompt. Check on it yourself.`,
        );
        refresh();
      }
    }, STALL_MS).unref();
  }

  // A prompt with --wait returns once the agent settles, so it needs no message.
  function disarm(target: string): void {
    for (const [pane, watch] of watches) {
      if (pane === target || watch.name === target) {
        watch.armed = false;
      }
    }
  }

  async function open(path: string, pane: string): Promise<Watch> {
    const socket = await subscribe(
      path,
      pane,
      (line) => onEvent(pane, line),
      (error) => stop(pane, error.message),
    );

    const watch: Watch = { armed: false, active: false, status: "unknown", since: 0, socket };

    // A clean close, such as a herdr restart, sends no error. A newer watch of the pane stays.
    socket.on("close", () => {
      if (watches.get(pane) === watch) {
        stop(pane, "herdr closed the connection");
      }
    });

    watches.set(pane, watch);

    return watch;
  }

  // Nested calls from a codemode script can run at once, so they share a subscription that's still
  // opening instead of each opening their own.
  function watchOf(path: string, pane: string): Promise<Watch> {
    const watch = watches.get(pane);

    if (watch !== undefined) {
      return Promise.resolve(watch);
    }

    const opening = openings.get(pane) ?? open(path, pane).finally(() => openings.delete(pane));

    openings.set(pane, opening);

    return opening;
  }

  async function arm(
    path: string,
    agent: Agent,
    action: string,
    toolCallId: string,
  ): Promise<void> {
    const watch = await watchOf(path, agent.pane);
    const { name, armed, active, status, since } = watch;
    const before = { name, armed, active, status, since };

    const entries = pending.get(toolCallId) ?? [];

    // The first entry keeps the state from before the call, which a call that never ran restores.
    if (!entries.some((entry) => entry.pane === agent.pane)) {
      pending.set(toolCallId, [...entries, { pane: agent.pane, before }]);
    }

    // herdr refuses a prompt to a blocked agent, but keys answer it. So after keys, a blocked agent
    // counts as active, and an Esc that leaves it idle still reports.
    const answered = action === "send-keys" && agent.status === "blocked";

    watch.name = agent.name;
    watch.armed = true;
    watch.active = agent.status === "working" || answered;
    watch.status = "prompted";
    watch.since = Date.now();
  }

  async function watchCommand(path: string, command: string, toolCallId: string): Promise<void> {
    // An agent started earlier in the same command doesn't exist yet, so --pane gives its pane.
    const started = new Map<string, string>();
    const { calls, missed } = herdrCalls(command);

    for (const call of calls) {
      if (call.target === undefined) {
        continue;
      }

      const startedPane = started.get(call.target);

      if (call.action === "start" && call.pane !== undefined) {
        started.set(call.target, call.pane);
      } else if (call.wait) {
        disarm(call.target);
      } else if (call.action !== "start") {
        const agent =
          startedPane === undefined
            ? await agentOf(call.target)
            : { pane: startedPane, name: call.target };

        await arm(path, agent, call.action, toolCallId);
      }
    }

    if (missed.size > 0) {
      const snippets = [...missed].map((text) => `\`${text.slice(0, 200)}\``);

      throw new Error(`it can't read ${snippets.join(", ")}`);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    live = true;
  });

  pi.on("session_shutdown", async () => {
    live = false;
    [...watches.keys()].forEach(unwatch);
    pending.clear();
    context = undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const options = event.systemPromptOptions;

    if (socketPath !== undefined && options.selectedTools.includes("bash")) {
      (options.toolGuidelines["bash"] ??= []).push(RULE);
    }
  });

  // Watching is best effort, so a failure tells the model to check on its agents instead of
  // blocking the command.
  pi.on("tool_call", async (event) => {
    if (socketPath === undefined || !isToolCallEventType("bash", event)) {
      return;
    }

    try {
      await watchCommand(socketPath, event.input.command, event.toolCallId);
    } catch (error) {
      const panes = new Set((pending.get(event.toolCallId) ?? []).map(({ pane }) => pane));

      // A later `--wait` in the command can disarm a pane.
      const watched = [...panes].flatMap((pane) => {
        const watch = watches.get(pane);

        return watch?.armed === true ? [label(pane, watch)] : [];
      });

      const fallback =
        "you prompted, run `herdr agent wait <name>` as a background task, with `--machine` if the prompt used it.";

      tell(
        watched.length === 0
          ? `Couldn't watch the herdr agents in this command: ${errorMessage(error)}. For each agent ${fallback}`
          : `Couldn't watch every herdr agent in this command: ${errorMessage(error)}. It's watching ${watched.join(", ")}. For any other agent ${fallback}`,
      );
    }

    refresh();
  });

  // Unlike tool_result, this also fires for calls a hook blocked or the user aborted. Those never
  // ran, so they sent no prompts. A call that ran and failed may have sent them, so those watches
  // stay and the model hears why.
  pi.on("tool_execution_end", async (event) => {
    const armed = pending.get(event.toolCallId) ?? [];

    pending.delete(event.toolCallId);

    for (const { pane, before } of armed) {
      const watch = watches.get(pane);

      if (watch === undefined) {
        continue;
      }

      // A call that never ran sent no prompt, so the watch goes back to how it was, which keeps an
      // earlier prompt's watch.
      if (event.durationMs === undefined) {
        Object.assign(watch, before);
      } else {
        checkStall(pane, watch, watch.since);
      }
    }

    refresh();
  });
}

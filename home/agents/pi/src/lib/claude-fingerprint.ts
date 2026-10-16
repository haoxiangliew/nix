import type { AnyNode, BlockStatement, FunctionDeclaration, Program, Statement } from "acorn";

import {
  capture,
  declarations,
  match,
  name,
  numeric,
  one,
  present,
  property,
  same,
  staticName,
  text,
  walk,
  type Match,
  type SymbolReference,
} from "./javascript.ts";

interface FunctionPattern {
  code: string;
  parameters: number;
  minimumStatements: number;
  normalizedStatements: number;
}

const hashPattern: FunctionPattern = {
  parameters: 2,
  // The two adjacent declarations may be combined into one statement.
  minimumStatements: 2,
  normalizedStatements: 3,
  code: [
    "function $hash($input, $version) {",
    'let $sample = $indices.map(($index) => $input[$index] || $padding).join("");',
    "let $joined = `${$salt}${$sample}${$version}`;",
    'return $crypto($algorithm).update($joined).digest("hex").slice(0, $length);',
    "}",
  ].join("\n"),
};

const readerPattern: FunctionPattern = {
  parameters: 1,
  minimumStatements: 6,
  normalizedStatements: 6,
  code: `function $reader($messages) {
  let $first = $messages.find(($message) => $message.type === "user" && !$message.isMeta);
  if (!$first) return "";
  let $content = $first.message.content;
  if (typeof $content === "string") return $content;
  if (Array.isArray($content)) {
    let $block = $content.find(($part) => $part.type === "text");
    if ($block && $block.type === "text") return $block.text;
  }
  return "";
}`,
};

const callerPattern: FunctionPattern = {
  parameters: 1,
  minimumStatements: 2,
  normalizedStatements: 2,
  code: `function $caller($messages) {
  let $first = $reader($messages);
  return $hash($first, $cli.VERSION);
}`,
};

function blocked(): never {
  throw new Error("Claude CLI fingerprint relationships changed. Request blocked.");
}

// Treat `let a = x, b = y` and two declarations identically, without changing
// evaluation order or accepting extra statements. Never modify the shared AST.
function split(statement: Statement): Statement[] {
  if (statement.type === "VariableDeclaration") {
    return statement.declarations.map((declaration) => ({
      ...statement,
      declarations: [declaration],
    }));
  }

  return [normalize(statement)];
}

function block(node: BlockStatement): BlockStatement {
  return { ...node, body: node.body.flatMap(split) };
}

function normalize(node: Statement): Statement {
  if (node.type === "BlockStatement") {
    return block(node);
  }

  if (node.type === "IfStatement") {
    return {
      ...node,
      consequent: normalize(node.consequent),
      alternate: node.alternate ? normalize(node.alternate) : node.alternate,
    };
  }

  return node;
}

function functions(module: Program): FunctionDeclaration[] {
  return module.body.flatMap((node) => (node.type === "FunctionDeclaration" ? [node] : []));
}

function functionCandidate(node: FunctionDeclaration, pattern: FunctionPattern): boolean {
  const items = node.body.body;

  // Check lengths without copying or visiting potentially enormous UI bodies.
  // Normalization only splits declarations; it never removes a statement.
  if (
    node.params.length !== pattern.parameters ||
    items.length < pattern.minimumStatements ||
    items.length > pattern.normalizedStatements
  ) {
    return false;
  }

  const total = items.reduce(
    (sum, statement) =>
      sum + (statement.type === "VariableDeclaration" ? statement.declarations.length : 1),
    0,
  );

  return total === pattern.normalizedStatements;
}

function matches(
  nodes: FunctionDeclaration[],
  pattern: FunctionPattern,
  bindings?: ReadonlyMap<string, AnyNode>,
): Match[] {
  return nodes.flatMap((node) => {
    if (!functionCandidate(node, pattern)) {
      return [];
    }

    const normalized = { ...node, body: block(node.body) };
    const result = match(normalized, pattern.code, bindings);

    return result ? [result] : [];
  });
}

function identifiers(result: Match, keys: string[]): string[] {
  return keys.map((key) => name(capture(result, key)));
}

function unshadowed(result: Match, references: string[], locals: string[]): void {
  const bindings = identifiers(result, locals);

  for (const reference of identifiers(result, references)) {
    if (bindings.includes(reference)) {
      blocked();
    }
  }
}

function cryptoImport(module: Program, identifier: AnyNode): void {
  const imports = module.body.filter(
    (node) =>
      node.type === "ImportDeclaration" &&
      ["crypto", "node:crypto"].includes(text(node.source)) &&
      node.specifiers.some(
        (specifier) =>
          specifier.type === "ImportSpecifier" &&
          same(specifier.local, identifier) &&
          staticName(specifier.imported) === "createHash",
      ),
  );

  one(imports, "fingerprint crypto import binding");
}

function cliVersion(cli: AnyNode): string {
  // A later spread or duplicate key could replace VERSION at runtime. Require
  // ordinary static properties as in the CLI's embedded build metadata object.
  if (
    cli.type !== "ObjectExpression" ||
    cli.properties.some(
      (item) => item.type !== "Property" || item.computed || item.kind !== "init" || item.method,
    )
  ) {
    blocked();
  }

  return text(property(cli, "VERSION"));
}

function count(node: AnyNode | null): number {
  const value = numeric(present(node, "fingerprint number"));

  if (!Number.isSafeInteger(value) || value < 0) {
    blocked();
  }

  return value;
}

export function readFingerprint(version: string, candidate: SymbolReference) {
  const { module } = candidate;
  const topFunctions = functions(module);
  const hash = one(matches(topFunctions, hashPattern), "fingerprint function");
  const reader = one(matches(topFunctions, readerPattern), "first-user text reader");

  const caller = one(
    matches(
      topFunctions,
      callerPattern,
      new Map([
        ["reader", capture(reader, "reader")],
        ["hash", capture(hash, "hash")],
      ]),
    ),
    "request fingerprint caller",
  );

  if (name(capture(caller, "caller")) !== candidate.name) {
    blocked();
  }

  cryptoImport(module, capture(hash, "crypto"));
  unshadowed(hash, ["crypto", "salt"], ["hash", "input", "version", "sample", "joined"]);
  unshadowed(hash, ["input"], ["index"]);
  unshadowed(caller, ["reader", "hash"], ["caller", "messages", "first"]);

  const moduleVariables = declarations(module);

  const moduleBindings: AnyNode[] = module.body.flatMap((node): AnyNode[] => {
    if (node.type === "ImportDeclaration") {
      return node.specifiers.map((specifier) => specifier.local);
    }

    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      return [node.id];
    }

    return [];
  });

  moduleBindings.push(...moduleVariables.map((node) => node.id));

  // The reader must use the built-in Array, not an identically named binding.
  if (
    identifiers(reader, ["reader", "messages", "first", "content", "block"]).includes("Array") ||
    moduleBindings.some((binding) =>
      [...walk(binding)].some((node) => node.type === "Identifier" && name(node) === "Array"),
    )
  ) {
    blocked();
  }

  // Only module-level declarations can supply this free variable.
  const saltDeclaration = one(
    moduleVariables.filter((node) => same(node.id, capture(hash, "salt"))),
    "fingerprint salt binding",
  );

  const salt = text(present(saltDeclaration.init, "fingerprint salt"));
  const indicesNode = capture(hash, "indices");

  if (indicesNode.type !== "ArrayExpression") {
    blocked();
  }

  const indices = indicesNode.elements.map(count);
  const padding = text(capture(hash, "padding"));
  const algorithm = text(capture(hash, "algorithm"));

  if (
    !salt ||
    !padding ||
    !algorithm ||
    indices.length === 0 ||
    cliVersion(capture(caller, "cli")) !== version
  ) {
    blocked();
  }

  return {
    salt,
    indices,
    padding,
    algorithm,
    digestLength: count(capture(hash, "length")),
  };
}

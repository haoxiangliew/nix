import type {
  AnyNode,
  AwaitExpression,
  BlockStatement,
  Expression,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  ObjectExpression,
  Pattern,
  Property,
  Program,
  Statement,
  VariableDeclarator,
} from "acorn";

import {
  type BlockFunction,
  type FunctionNode,
  type JavaScript,
  type SymbolReference,
  capture,
  childNodes,
  cooked,
  declaredFunction,
  functions,
  hasBlock,
  match,
  one,
  optionalProperty,
  present,
  scope,
  stringLiteral,
  text,
  walk,
} from "./javascript.ts";

function blocked(description: string): never {
  throw new Error(`Claude CLI ${description} changed or is unsupported. Request blocked.`);
}

interface Lexical {
  sameBinding(left: AnyNode, right: AnyNode): boolean;
  unchanged(identifier: AnyNode): boolean;
}

interface Body extends Lexical {
  root: AnyNode;
  bindings: Map<string, VariableDeclarator[]>;
}

function body(root: AnyNode, lexical: Lexical, visit?: (node: AnyNode) => void): Body {
  const bindings = new Map<string, VariableDeclarator[]>();

  for (const node of scope(root)) {
    visit?.(node);

    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") {
      continue;
    }

    const values = bindings.get(node.id.name) ?? [];
    values.push(node);
    bindings.set(node.id.name, values);
  }

  return { ...lexical, root, bindings };
}

function declarator(context: Body, id: Identifier): VariableDeclarator | undefined {
  const declarations = context.bindings.get(id.name);

  return declarations && one(declarations, `binding ${id.name}`);
}

// Discovery only: a matching spelling is not proof of a lexical binding. Keep
// all possible declarations here; binding() still rejects ambiguous/shadowed ids.
function hasStringInitializer(context: Body, id: AnyNode): boolean {
  return (
    id.type === "Identifier" &&
    (context.bindings.get(id.name)?.some((declaration) => isString(declaration.init)) ?? false)
  );
}

function binding(context: Body, id: AnyNode): Expression | undefined {
  if (id.type !== "Identifier") {
    return undefined;
  }

  const declaration = declarator(context, id);

  if (!declaration || !context.sameBinding(id, declaration.id) || !context.unchanged(id)) {
    return undefined;
  }

  return declaration.init ?? undefined;
}

function parameter(fn: FunctionNode): Identifier | undefined {
  const [first] = fn.params;

  return fn.params.length === 1 && first?.type === "Identifier" ? first : undefined;
}

function syncParameter(fn: FunctionNode): Identifier | undefined {
  return fn.async || fn.generator ? undefined : parameter(fn);
}

function member(context: Body, node: AnyNode, object: AnyNode, key: string): boolean {
  if (node.type === "ChainExpression") {
    node = node.expression;
  }

  if (node.type !== "MemberExpression") {
    return false;
  }

  const property = node.property;

  const matchesKey = node.computed
    ? property.type === "Literal" && property.value === key
    : property.type === "Identifier" && property.name === key;

  return matchesKey && context.sameBinding(node.object, object);
}

function returned(node: Statement): Expression | undefined {
  if (node.type === "BlockStatement") {
    if (node.body.length !== 1) {
      return undefined;
    }

    node = node.body[0]!;
  }

  return node.type === "ReturnStatement" ? (node.argument ?? undefined) : undefined;
}

function isString(node: AnyNode | null | undefined): boolean {
  return !!node && !!stringLiteral(node);
}

function promptBranches(
  context: Body,
  node: Statement,
  options: Identifier,
): Expression[] | undefined {
  const expression = returned(node);

  if (expression?.type === "Identifier") {
    return [expression];
  }

  if (
    expression?.type === "ConditionalExpression" &&
    member(context, expression.test, options, "hasAppendSystemPrompt")
  ) {
    return [expression.consequent, expression.alternate];
  }

  return node.type === "BlockStatement" ? appendBranches(context, node, options) : undefined;
}

function appendBranches(
  context: Body,
  node: BlockStatement,
  options: Identifier,
): Expression[] | undefined {
  if (node.body.length !== 2) {
    return undefined;
  }

  const [append, last] = node.body;

  if (!append || !last || !appendBranch(context, append, options)) {
    return undefined;
  }

  const returns = [append.consequent, last].map(returned);

  return returns.every((value) => value !== undefined) ? returns : undefined;
}

function appendBranch(context: Body, node: Statement, options: Identifier): node is IfStatement {
  return (
    node.type === "IfStatement" &&
    !node.alternate &&
    member(context, node.test, options, "hasAppendSystemPrompt")
  );
}

function recordedOverride(context: Body, node: Statement, options: Identifier): boolean {
  if (node.type !== "IfStatement" || node.alternate) {
    return false;
  }

  const test = node.test;
  const result = returned(node.consequent);

  return (
    test.type === "BinaryExpression" &&
    test.operator === "!==" &&
    member(context, test.left, options, "recorded") &&
    !!match(test.right, "void 0") &&
    !!result &&
    member(context, result, options, "recorded")
  );
}

interface Triple {
  id: Pattern;
  elements: Identifier[];
}

function promptTriples(context: Body): Triple[] {
  const triples: Triple[] = [];

  for (const node of scope(context.root)) {
    if (node.type !== "VariableDeclarator" || node.init?.type !== "ArrayExpression") {
      continue;
    }

    const elements = node.init.elements.filter(
      (id): id is Identifier => id?.type === "Identifier" && hasStringInitializer(context, id),
    );

    if (node.init.elements.length === 3 && elements.length === 3) {
      triples.push({ id: node.id, elements });
    }
  }

  return triples;
}

function sameTriple(context: Body, triple: Triple, ids: AnyNode[]): boolean {
  return (
    ids.every((id) => triple.elements.some((element) => context.sameBinding(id, element))) &&
    ids.every((id, index) => ids.findIndex((other) => context.sameBinding(id, other)) === index)
  );
}

function verifySelector(
  context: Body,
  statements: Statement[],
  branch: IfStatement,
  options: Identifier,
  fallback: Expression,
): void {
  if (branch.alternate || statements.at(-2) !== branch) {
    blocked("identity prompt selector");
  }

  for (const prefix of statements.slice(0, -2)) {
    // Provider-specific early returns may select the same default prompt.
    // The `recorded` override is allowed but is not the default prompt.
    const result =
      prefix.type === "IfStatement" && !prefix.alternate ? returned(prefix.consequent) : undefined;

    if (
      !(result && context.sameBinding(result, fallback)) &&
      !recordedOverride(context, prefix, options)
    ) {
      blocked("identity prompt selector");
    }
  }
}

function builtin(context: Body, node: AnyNode, expected: string): boolean {
  return (
    node.type === "Identifier" &&
    node.name === expected &&
    !context.bindings.has(expected) &&
    !context.sameBinding(node, node)
  );
}

function initializesSet(context: Body, node: AnyNode, array: Triple): node is VariableDeclarator {
  if (node.type !== "VariableDeclarator" || !node.init) {
    return false;
  }

  const init = match(node.init, "new $constructor($array)");

  return (
    !!init &&
    builtin(context, capture(init, "constructor"), "Set") &&
    context.sameBinding(capture(init, "array"), array.id)
  );
}

function verifyPromptSet(context: Body, fns: BlockFunction[], array: Triple): void {
  const sets = [...scope(context.root)].filter((node) => initializesSet(context, node, array));
  const set = one(sets, "identity prompt set");

  const predicates = fns.filter((candidate) => {
    const value = syncParameter(candidate);

    if (!value) {
      return false;
    }

    const result = returned(candidate.body);
    const predicate = result && match(result, "$set.has($value)");

    return (
      !!predicate &&
      context.sameBinding(capture(predicate, "set"), set.id) &&
      context.sameBinding(capture(predicate, "value"), value)
    );
  });

  one(predicates, "identity prompt membership predicate");
}

function constant(context: Body, id: AnyNode): string {
  return text(present(binding(context, id), "identity prompt constant"));
}

function promptSelector(
  fn: FunctionDeclaration,
  triples: Triple[],
  context: Body,
  fns: BlockFunction[],
): string[] {
  const options = syncParameter(fn);

  if (!options || triples.length === 0) {
    return [];
  }

  const statements = fn.body.body;
  const last = statements.at(-1);
  const fallback = last && returned(last);

  if (!fallback || !hasStringInitializer(context, fallback)) {
    return [];
  }

  const branches = statements.filter(
    (node): node is IfStatement =>
      node.type === "IfStatement" && member(context, node.test, options, "isNonInteractive"),
  );

  if (branches.length === 0) {
    return [];
  }

  const branch = one(branches, "identity non-interactive branch");
  const choices = promptBranches(context, branch.consequent, options);

  if (!choices) {
    return [];
  }

  const ids = [fallback, ...choices];

  const arrays = triples.filter(
    (triple) =>
      sameTriple(context, triple, ids) &&
      triple.elements.every((id) => isString(binding(context, id))),
  );

  if (!arrays.length) {
    return [];
  }

  const array = one(arrays, "identity prompt triple");
  verifySelector(context, statements, branch, options, fallback);
  verifyPromptSet(context, fns, array);

  if (new Set(array.elements.map((id) => constant(context, id))).size !== 3) {
    blocked("identity prompt constants");
  }

  return [constant(context, fallback)];
}

function hostBlock(fn: BlockFunction): BlockStatement | undefined {
  const statements = fn.body.body;
  const attempt = statements[0];

  if (
    fn.async ||
    fn.generator ||
    statements.length !== 1 ||
    attempt?.type !== "TryStatement" ||
    !attempt.handler ||
    attempt.finalizer
  ) {
    return undefined;
  }

  const failure = returned(attempt.handler.body);

  return failure && isFalse(failure) ? attempt.block : undefined;
}

function isFalse(node: AnyNode): boolean {
  return (node.type === "Literal" && node.value === false) || !!match(node, "!1");
}

function hostOrigin(hostname: string): string {
  // Reject paths, credentials, queries, and normalized host spellings.
  const origin = `https://${hostname}`;
  let parsed: URL;

  try {
    parsed = new URL(origin);
  } catch {
    return blocked("first-party host");
  }

  if (parsed.origin !== origin || parsed.host !== hostname || parsed.pathname !== "/") {
    blocked("first-party host");
  }

  return origin;
}

function resolve(node: AnyNode, local: Body, outer?: Body): AnyNode | undefined {
  if (node.type !== "Identifier") {
    return node;
  }

  return binding(local, node) ?? (outer && binding(outer, node));
}

function readHosts(fn: BlockFunction, globals: Body): string[] {
  const url = parameter(fn);
  const block = hostBlock(fn);

  return url && block ? hostPredicate(block, url, globals) : [];
}

function hostPredicate(block: BlockStatement, url: Identifier, globals: Body): string[] {
  const statements = block.body;

  if (statements.slice(0, -1).some((node) => node.type !== "VariableDeclaration")) {
    return [];
  }

  const last = statements.at(-1);
  const expression = last && returned(last);
  const includes = expression && match(expression, "$allowed.includes($host)");

  if (!includes) {
    return [];
  }

  const local = body(block, globals);
  const host = resolve(capture(includes, "host"), local);

  if (!host || !urlHost(host, url, local, globals)) {
    return [];
  }

  const array = resolve(capture(includes, "allowed"), local, globals);

  if (array?.type !== "ArrayExpression") {
    return [];
  }

  const allowed = one(array.elements, "first-party host allowlist");

  return [hostOrigin(text(present(allowed, "first-party host")))];
}

function urlHost(node: AnyNode, url: Identifier, local: Body, globals: Body): boolean {
  const host = match(node, "new $constructor($url).host");

  return (
    !!host &&
    builtin(globals, capture(host, "constructor"), "URL") &&
    !local.bindings.has("URL") &&
    globals.sameBinding(capture(host, "url"), url)
  );
}

function template(
  node: AnyNode,
  prefix: string,
): { expression: Expression; suffix: string } | undefined {
  if (node.type !== "TemplateLiteral" || node.expressions.length !== 1) {
    return undefined;
  }

  const [head, tail] = node.quasis;

  return head && tail && cooked(head) === prefix
    ? { expression: node.expressions[0]!, suffix: cooked(tail) }
    : undefined;
}

function exportedBinding(context: Body, identifier: Identifier): boolean {
  for (const node of walk(context.root)) {
    if (
      node.type === "ExportNamedDeclaration" &&
      node.declaration?.type === "VariableDeclaration" &&
      node.declaration.declarations.some((value) => context.sameBinding(value.id, identifier))
    ) {
      return true;
    }
  }

  return false;
}

// Only object spreads copy this binding without exposing the original object.
// Reject mutation, aliases, calls, and iteration.
function spreadOnly(context: Body, identifier: Identifier): boolean {
  const spreads = new Set<AnyNode>();

  for (const parent of walk(context.root)) {
    if (parent.type === "ObjectExpression") {
      for (const property of parent.properties) {
        if (property.type === "SpreadElement") {
          spreads.add(property);
        }
      }
    }

    for (const node of childNodes(parent)) {
      if (!context.sameBinding(node, identifier)) {
        continue;
      }

      const declaration = parent.type === "VariableDeclarator" && parent.id === node;
      const spread = spreads.has(parent);

      if (!declaration && !spread) {
        return false;
      }
    }
  }

  return true;
}

function spreadSource(node: AnyNode, local: Body, globals: Body): ObjectExpression | undefined {
  if (node.type === "ObjectExpression") {
    return node;
  }

  const value = resolve(node, local, globals);

  if (
    node.type !== "Identifier" ||
    value?.type !== "ObjectExpression" ||
    value.end > node.start ||
    exportedBinding(globals, node) ||
    !spreadOnly(globals, node)
  ) {
    return undefined;
  }

  return value;
}

function nonHeaderProperty(node: Property): boolean {
  // Getters run during spreading and could mutate the source object.
  if (node.computed || node.kind !== "init") {
    return false;
  }

  if (node.key.type === "Literal") {
    return String(node.key.value) !== "headers";
  }

  return node.key.type === "Identifier" && node.key.name !== "headers";
}

function excludesHeaders(
  node: AnyNode,
  local: Body,
  globals: Body,
  checked: Map<ObjectExpression, boolean>,
): boolean {
  const object = spreadSource(node, local, globals);

  if (!object) {
    return false;
  }

  const cached = checked.get(object);

  if (cached !== undefined) {
    return cached;
  }

  const safe = object.properties.every((property) =>
    property.type === "SpreadElement"
      ? excludesHeaders(property.argument, local, globals, checked)
      : nonHeaderProperty(property),
  );

  checked.set(object, safe);

  return safe;
}

function profileHeaders(options: AnyNode, local: Body, globals: Body): AnyNode | undefined {
  if (options.type !== "ObjectExpression") {
    return undefined;
  }

  const checked = new Map<ObjectExpression, boolean>();

  for (const property of options.properties) {
    if (
      property.type === "SpreadElement" &&
      !excludesHeaders(property.argument, local, globals, checked)
    ) {
      return undefined;
    }
  }

  // Only omit spreads after proving they cannot define or overwrite headers.
  const properties = options.properties.filter((property) => property.type !== "SpreadElement");

  return optionalProperty({ ...options, properties }, "headers");
}

function authenticated(local: Body, globals: Body, options: AnyNode, token: Identifier): boolean {
  const headers = profileHeaders(options, local, globals);

  if (headers?.type !== "ObjectExpression") {
    return false;
  }

  const authorization = optionalProperty(headers, "Authorization");
  const bearer = authorization && template(authorization, "Bearer ");

  if (!bearer || bearer.suffix !== "" || !local.sameBinding(bearer.expression, token)) {
    return false;
  }

  const agent = optionalProperty(headers, "User-Agent");

  return !!agent && !!match(agent, "$agent()");
}

function profilePath(
  node: AwaitExpression,
  token: Identifier,
  local: Body,
  globals: Body,
): string[] {
  const get = match(node.argument, "$client.get($endpoint, $options)");

  if (!get) {
    return [];
  }

  const value = resolve(capture(get, "endpoint"), local);
  const path = value && template(value, "");

  if (!path || !match(path.expression, "$config().BASE_API_URL")) {
    return [];
  }

  if (!authenticated(local, globals, capture(get, "options"), token)) {
    return [];
  }

  return [checkedProfilePath(path.suffix)];
}

function checkedProfilePath(path: string): string {
  const base = "https://claude-profile.invalid";
  const url = new URL(path, base);

  if (!path.startsWith("/") || url.origin !== base || url.pathname !== path) {
    blocked("OAuth profile path");
  }

  return path;
}

function readProfilePaths(fn: BlockFunction, globals: Body): string[] {
  const token = parameter(fn);

  if (!token || !fn.async || fn.generator) {
    return [];
  }

  const awaits: AwaitExpression[] = [];

  const local = body(fn.body, globals, (node) => {
    if (node.type === "AwaitExpression") {
      awaits.push(node);
    }
  });

  return awaits.flatMap((node) => profilePath(node, token, local, globals));
}

interface RequestIdentity {
  prompt: string;
  profilePath: string;
  origin: string;
}

export function readRequestIdentity(js: JavaScript, selector: SymbolReference): RequestIdentity {
  const contexts = new WeakMap<Program, { globals: Body; fns: BlockFunction[] }>();

  function context(root: Program) {
    let result = contexts.get(root);

    if (!result) {
      const lexical: Lexical = {
        sameBinding: (left, right) => js.sameBinding(root, left, right),
        unchanged: (identifier) => js.unchanged(root, identifier),
      };

      result = { globals: body(root, lexical), fns: functions(root).filter(hasBlock) };
      contexts.set(root, result);
    }

    return result;
  }

  const { globals: promptGlobals, fns: promptFunctions } = context(selector.module);

  const prompts = promptSelector(
    declaredFunction(selector),
    promptTriples(promptGlobals),
    promptGlobals,
    promptFunctions,
  );

  const candidates = js.selectGroups(
    [
      ["ANTHROPIC_BASE_URL", "host", "includes"],
      ["BASE_API_URL", "Bearer "],
    ],
    (root, matched) => {
      const { globals, fns } = context(root);
      const found: { kind: "host" | "profilePath"; value: string }[] = [];

      for (const fn of fns) {
        if (matched[0]) {
          found.push(...readHosts(fn, globals).map((value) => ({ kind: "host" as const, value })));
        }

        if (matched[1]) {
          found.push(
            ...readProfilePaths(fn, globals).map((value) => ({
              kind: "profilePath" as const,
              value,
            })),
          );
        }
      }

      return found;
    },
  );

  const hosts = candidates.flatMap(({ kind, value }) => (kind === "host" ? [value] : []));

  const profilePaths = candidates.flatMap(({ kind, value }) =>
    kind === "profilePath" ? [value] : [],
  );

  return {
    prompt: one(prompts, "identity prompt selector"),
    profilePath: one(profilePaths, "OAuth profile endpoint"),
    origin: one(hosts, "first-party host"),
  };
}

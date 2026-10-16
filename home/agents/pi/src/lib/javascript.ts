import {
  tokenizer,
  type AnonymousFunctionDeclaration,
  type AnyNode,
  type ArrowFunctionExpression,
  type BlockStatement,
  type Declaration,
  type ExportNamedDeclaration,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  type ImportDeclaration,
  type Literal,
  type ObjectExpression,
  type Pattern,
  type Program,
  type Property,
  type SpreadElement,
  type TemplateElement,
  type Token,
  type VariableDeclaration,
  type VariableDeclarator,
} from "acorn";

import { parse } from "./acorn-parser.ts";
import { readBunModules, type BunModule } from "./bun-modules.ts";

export interface Match {
  node: AnyNode;
  captures: ReadonlyMap<string, AnyNode>;
}

export interface SymbolReference {
  module: Program;
  name: string;
}

export type FunctionNode =
  | FunctionDeclaration
  | AnonymousFunctionDeclaration
  | FunctionExpression
  | ArrowFunctionExpression;

export type BlockFunction = FunctionNode & { body: BlockStatement };

const metadata = new Set(["start", "end", "loc", "range", "raw"]);

const leafTypes = new Set([
  "Literal",
  "TemplateElement",
  "ThisExpression",
  "Super",
  "PrivateIdentifier",
  "EmptyStatement",
  "DebuggerStatement",
]);

const scopeTypes = new Set([
  "BlockStatement",
  "CatchClause",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "SwitchStatement",
  "ClassExpression",
  "ClassDeclaration",
  "StaticBlock",
]);

function unsupported(description: string): never {
  throw new Error(`Claude CLI ${description} is unsupported. Request blocked.`);
}

type Field =
  | AnyNode
  | (AnyNode | null)[]
  | Literal["value"]
  | Literal["regex"]
  | TemplateElement["value"];

type Composite = Extract<Field, object>;

function isComposite(value: Field): value is Composite {
  return value instanceof Object;
}

function isNode(value: Field): value is AnyNode {
  return isComposite(value) && "type" in value;
}

export function one<T>(values: readonly T[], description: string): T {
  const value = values[0];

  if (values.length !== 1 || value === undefined) {
    throw new Error(`Claude CLI ${description} changed or is ambiguous. Request blocked.`);
  }

  return value;
}

export function present<T>(value: T | null | undefined, description: string): T {
  if (value === null || value === undefined) {
    return unsupported(description);
  }

  return value;
}

export function capture(result: Match, key: string): AnyNode {
  return present(result.captures.get(key), "syntax capture");
}

export function name(node: AnyNode): string {
  if (node.type !== "Identifier") {
    return unsupported("identifier syntax");
  }

  return node.name;
}

// Only a string equals its own String().
export function stringLiteral(node: AnyNode): string | undefined {
  if (node.type !== "Literal") {
    return undefined;
  }

  const value = String(node.value);

  return value === node.value ? value : undefined;
}

export function text(node: AnyNode): string {
  return stringLiteral(node) ?? unsupported("string syntax");
}

// Only a number other than NaN equals its own Number().
export function numeric(node: AnyNode): number {
  if (node.type !== "Literal" || Number(node.value) !== node.value) {
    return unsupported("number syntax");
  }

  if (!Number.isFinite(node.value)) {
    unsupported("non-finite number syntax");
  }

  return node.value;
}

export function cooked(node: TemplateElement): string {
  return present(node.value.cooked, "template syntax");
}

export function isFunction(node: AnyNode): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

export function hasBlock(fn: FunctionNode): fn is BlockFunction {
  return fn.body.type === "BlockStatement";
}

function nestedBody(node: AnyNode): boolean {
  return isFunction(node) || node.type === "ClassDeclaration" || node.type === "ClassExpression";
}

// Metadata fields never hold nodes, so they need no filtering here.
export function childNodes(node: AnyNode): AnyNode[] {
  const values: Field[] = Object.values(node);
  const result: AnyNode[] = [];

  for (const value of values) {
    if (isNode(value)) {
      result.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          result.push(item);
        }
      }
    }
  }

  return result;
}

function* descendants(root: AnyNode, scoped: boolean): Generator<AnyNode> {
  const stack = [root];

  while (stack.length) {
    const node = stack.pop()!;
    yield node;
    const next = childNodes(node);

    for (let index = next.length - 1; index >= 0; index -= 1) {
      const part = next[index]!;

      if (!(scoped && nestedBody(part))) {
        stack.push(part);
      }
    }
  }
}

export function* walk(root: AnyNode): Generator<AnyNode> {
  yield* descendants(root, false);
}

// Inspect one lexical body without confusing nested functions/classes' reused names.
export function* scope(root: AnyNode): Generator<AnyNode> {
  yield* descendants(root, true);
}

export function declarations(body: BlockStatement | Program): VariableDeclarator[] {
  return body.body.flatMap((statement) =>
    statement.type === "VariableDeclaration" ? statement.declarations : [],
  );
}

export function functions(root: AnyNode): FunctionNode[] {
  const result: FunctionNode[] = [];

  for (const node of walk(root)) {
    if (isFunction(node)) {
      result.push(node);
    }
  }

  return result;
}

function propertyKey(node: Property | SpreadElement): string {
  // An unknown computed key or spread can replace even an otherwise static property.
  if (node.type !== "Property" || node.computed) {
    return unsupported("object property syntax");
  }

  const key = node.key;

  if (key.type === "Identifier") {
    return key.name;
  }

  if (key.type !== "Literal") {
    return unsupported("object property key");
  }

  // The grammar allows only string, number, and bigint literal keys.
  return String(key.value);
}

function propertyValue(node: Property | SpreadElement, key: string): Expression[] {
  if (propertyKey(node) !== key) {
    return [];
  }

  if (node.type !== "Property" || node.kind !== "init" || node.method) {
    return unsupported("object property value");
  }

  // This special initializer changes the prototype instead of defining an own property.
  if (key === "__proto__" && !node.shorthand) {
    return unsupported("object prototype initializer");
  }

  return [node.value];
}

function propertyValues(root: ObjectExpression, key: string): Expression[] {
  return root.properties.flatMap((node) => propertyValue(node, key));
}

export function optionalProperty(root: ObjectExpression, key: string): Expression | undefined {
  const values = propertyValues(root, key);

  return values.length ? one(values, `object property ${key}`) : undefined;
}

export function property(root: AnyNode, key: string): Expression {
  if (root.type !== "ObjectExpression") {
    return unsupported("object syntax");
  }

  return one(propertyValues(root, key), `object property ${key}`);
}

function entries(value: Composite): [string, Field][] {
  const fields: [string, Field][] = Object.entries(value);

  return fields.filter(([key]) => !metadata.has(key));
}

type Captures = Map<string, AnyNode>;

function placeholder(actual: Field, expected: Identifier, captures: Captures): boolean {
  if (!isNode(actual)) {
    return false;
  }

  const key = expected.name.slice(1);
  const bound = captures.get(key);

  if (bound) {
    // A captured subtree is an exact binding, not another structural pattern.
    return equivalent(actual, bound);
  }

  captures.set(key, actual);

  return true;
}

function declarationKind(left: Composite, right: Composite): boolean {
  if (
    !isNode(left) ||
    !isNode(right) ||
    left.type !== "VariableDeclaration" ||
    right.type !== "VariableDeclaration"
  ) {
    return false;
  }

  // Patterns written with let/var also match const. Patterns written with const match only const.
  return ["let", "var"].includes(right.kind) && ["let", "var", "const"].includes(left.kind);
}

function recordsEqual(left: Composite, right: Composite, captures?: Captures): boolean {
  const leftFields = new Map(entries(left));
  const rightFields = entries(right);

  return (
    leftFields.size === rightFields.length &&
    rightFields.every(([key, value]) => {
      if (!leftFields.has(key)) {
        return false;
      }

      if (captures && key === "kind" && declarationKind(left, right)) {
        return true;
      }

      return equivalent(leftFields.get(key), value, captures);
    })
  );
}

function arraysEqual(actual: (AnyNode | null)[], expected: Field, captures?: Captures): boolean {
  return (
    Array.isArray(expected) &&
    actual.length === expected.length &&
    actual.every((item, index) => equivalent(item, expected[index], captures))
  );
}

function equivalent(actual: Field, expected: Field, captures?: Captures): boolean {
  if (
    captures &&
    isNode(expected) &&
    expected.type === "Identifier" &&
    expected.name.startsWith("$")
  ) {
    return placeholder(actual, expected, captures);
  }

  if (Array.isArray(actual)) {
    return arraysEqual(actual, expected, captures);
  }

  if (Array.isArray(expected)) {
    return false;
  }

  if (isComposite(actual) && isComposite(expected)) {
    return recordsEqual(actual, expected, captures);
  }

  return Object.is(actual, expected);
}

export function same(left: AnyNode, right: AnyNode): boolean {
  return equivalent(left, right);
}

function parseModule(source: string): Program {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" });
}

const patterns = new Map<string, AnyNode>();

function pattern(code: string): AnyNode {
  const previous = patterns.get(code);

  if (previous) {
    return previous;
  }

  const statement = one(parseModule(code).body, "AST pattern");
  const node = statement.type === "ExpressionStatement" ? statement.expression : statement;
  patterns.set(code, node);

  return node;
}

// $identifiers in patterns capture AST nodes, not source text. Repeated captures must agree.
export function match(
  node: AnyNode,
  code: string,
  bindings?: ReadonlyMap<string, AnyNode>,
): Match | undefined {
  const captures = new Map(bindings);

  return equivalent(node, pattern(code), captures) ? { node, captures } : undefined;
}

interface LexicalScope {
  parent?: LexicalScope;
  functionScope: boolean;
  dynamic?: boolean;
  // Repeated declarations are deliberately ambiguous, not last-declaration-wins.
  bindings: Map<string, Identifier | null>;
}

function lexicalScope(parent?: LexicalScope, functionScope = false): LexicalScope {
  return { parent, functionScope, bindings: new Map() };
}

function bindingNames(node: Pattern, assignment = false): Identifier[] {
  switch (node.type) {
    case "Identifier":
      return [node];
    case "RestElement":
      return bindingNames(node.argument, assignment);
    case "AssignmentPattern":
      return bindingNames(node.left, assignment);
    case "ObjectPattern":
      return node.properties.flatMap((part) =>
        bindingNames(part.type === "RestElement" ? part.argument : part.value, assignment),
      );
    case "ArrayPattern":
      return node.elements.flatMap((part) => (part ? bindingNames(part, assignment) : []));
    case "MemberExpression":
      return assignment ? [] : unsupported("binding pattern");
    default:
      return unsupported("binding pattern");
  }
}

class Bindings {
  private readonly scopes = new WeakMap<Identifier, LexicalScope>();
  private readonly writes: Identifier[] = [];
  private readonly evals: Identifier[] = [];
  private readonly mutated = new WeakSet<Identifier>();

  constructor(root: Program) {
    this.visit(root, lexicalScope(undefined, true));

    for (const identifier of this.writes) {
      const binding = this.resolve(identifier);

      if (binding) {
        this.mutated.add(binding);
      }
    }

    for (const callee of this.evals) {
      this.markDynamic(callee);
    }
  }

  private markDynamic(callee: Identifier): void {
    if (this.resolve(callee)) {
      return;
    }

    let environment = this.scopes.get(callee);

    while (environment) {
      environment.dynamic = true;
      environment = environment.parent;
    }
  }

  private effects(node: AnyNode): void {
    switch (node.type) {
      case "AssignmentExpression":
        this.writes.push(...bindingNames(node.left, true));
        break;
      case "UpdateExpression":
        if (node.argument.type !== "Identifier" && node.argument.type !== "MemberExpression") {
          unsupported("update target");
        }

        this.writes.push(...bindingNames(node.argument, true));
        break;
      case "ForInStatement":
      case "ForOfStatement":
        if (node.left.type !== "VariableDeclaration") {
          this.writes.push(...bindingNames(node.left, true));
        }

        break;
      case "CallExpression":
        if (node.callee.type === "Identifier" && node.callee.name === "eval" && !node.optional) {
          this.evals.push(node.callee);
        }

        break;
    }
  }

  private declare(node: Pattern, environment: LexicalScope): void {
    for (const identifier of bindingNames(node)) {
      const key = identifier.name;
      const previous = environment.bindings.get(key);

      environment.bindings.set(
        key,
        environment.bindings.has(key) && previous !== identifier ? null : identifier,
      );
    }
  }

  private enter(node: AnyNode, outer: LexicalScope): LexicalScope {
    if (isFunction(node)) {
      let parent = outer;

      if (node.type === "FunctionExpression" && node.id) {
        parent = lexicalScope(outer);
        this.declare(node.id, parent);
      }

      const current = lexicalScope(parent, true);

      for (const parameter of node.params) {
        this.declare(parameter, current);
      }

      return current;
    }

    return scopeTypes.has(node.type) ? lexicalScope(outer, node.type === "StaticBlock") : outer;
  }

  private variables(node: VariableDeclaration, current: LexicalScope): void {
    let target = current;

    if (node.kind === "var") {
      while (!target.functionScope && target.parent) {
        target = target.parent;
      }
    }

    for (const declaration of node.declarations) {
      this.declare(declaration.id, target);
    }
  }

  private imports(node: ImportDeclaration, current: LexicalScope): void {
    for (const specifier of node.specifiers) {
      this.declare(specifier.local, current);
    }
  }

  private declarations(node: AnyNode, current: LexicalScope, outer: LexicalScope): void {
    switch (node.type) {
      case "FunctionDeclaration":
        if (node.id) {
          this.declare(node.id, outer);
        }

        break;
      case "ClassDeclaration":
        if (node.id) {
          this.declare(node.id, outer);
          this.declare(node.id, current);
        }

        break;
      case "ClassExpression":
      case "CatchClause": {
        const declared = node.type === "CatchClause" ? node.param : node.id;

        if (declared) {
          this.declare(declared, current);
        }

        break;
      }

      case "ImportDeclaration":
        this.imports(node, current);
        break;
      case "VariableDeclaration":
        this.variables(node, current);
        break;
    }
  }

  private visit(node: AnyNode, outer: LexicalScope): void {
    if (node.type === "Identifier") {
      this.scopes.set(node, outer);

      return;
    }

    if (leafTypes.has(node.type)) {
      return;
    }

    const current = this.enter(node, outer);
    this.declarations(node, current, outer);
    this.effects(node);

    this.visitParts(node, outer, current);

    if (node.type === "FunctionDeclaration" && node.id) {
      this.scopes.set(node.id, outer);
    }
  }

  private visitParts(node: AnyNode, outer: LexicalScope, current: LexicalScope): void {
    // Body vars must not shadow references in default parameter initializers.
    const body = isFunction(node) ? node.body : undefined;
    const bodyScope = body ? lexicalScope(current, true) : current;
    // The switch's discriminant is outside the cases' lexical environment.
    const discriminant = node.type === "SwitchStatement" ? node.discriminant : undefined;

    for (const part of childNodes(node)) {
      if (part === body) {
        this.visit(part, bodyScope);
      } else {
        this.visit(part, part === discriminant ? outer : current);
      }
    }
  }

  private environment(identifier: Identifier): LexicalScope | undefined {
    let environment = this.scopes.get(identifier);

    while (environment && !environment.bindings.has(identifier.name)) {
      environment = environment.parent;
    }

    return environment;
  }

  unchanged(identifier: Identifier): boolean {
    const binding = this.resolve(identifier);

    return !!binding && !this.mutated.has(binding) && !this.environment(identifier)?.dynamic;
  }

  resolve(identifier: Identifier): Identifier | undefined {
    return this.environment(identifier)?.bindings.get(identifier.name) ?? undefined;
  }
}

type ModuleExports = Map<string, Identifier>;

export function staticName(node: Identifier | Literal): string {
  return node.type === "Identifier" ? node.name : text(node);
}

function exportedDeclaration(declaration: Declaration): Identifier[] {
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations.flatMap((part) => bindingNames(part.id));
  }

  return [declaration.id];
}

function namedExports(statement: ExportNamedDeclaration, exports: ModuleExports): void {
  for (const specifier of statement.specifiers) {
    if (statement.source) {
      continue;
    }

    if (specifier.local.type !== "Identifier") {
      unsupported("export specifier");
    }

    exports.set(staticName(specifier.exported), specifier.local);
  }

  if (statement.declaration) {
    for (const identifier of exportedDeclaration(statement.declaration)) {
      exports.set(identifier.name, identifier);
    }
  }
}

function exportsOf(root: Program): ModuleExports {
  const exports: ModuleExports = new Map();

  for (const statement of root.body) {
    if (statement.type === "ExportNamedDeclaration") {
      namedExports(statement, exports);
    } else if (statement.type === "ExportDefaultDeclaration") {
      const declaration = functionDeclaration(statement)?.id ?? statement.declaration;

      if (declaration.type === "Identifier") {
        exports.set("default", declaration);
      }
    }
  }

  return exports;
}

function isNamedFunction(node: AnyNode): node is FunctionDeclaration {
  return node.type === "FunctionDeclaration" && node.id !== null;
}

function functionDeclaration(statement: AnyNode): FunctionDeclaration | undefined {
  if (
    statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportDefaultDeclaration"
  ) {
    return statement.declaration ? functionDeclaration(statement.declaration) : undefined;
  }

  return isNamedFunction(statement) ? statement : undefined;
}

export function declaredFunction(target: SymbolReference): FunctionDeclaration {
  const declared = target.module.body.flatMap((statement) => {
    const fn = functionDeclaration(statement);

    return fn && fn.id.name === target.name ? [fn] : [];
  });

  return one(declared, "referenced function");
}

function importedName(specifier: ImportDeclaration["specifiers"][number]): string | undefined {
  switch (specifier.type) {
    case "ImportSpecifier":
      return staticName(specifier.imported);
    case "ImportDefaultSpecifier":
      return "default";
    default:
      return undefined;
  }
}

interface ImportBinding {
  exported: string;
  source: string;
}

function importBinding(module: Program, binding: Identifier): ImportBinding | undefined {
  for (const statement of module.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }

    const specifier = statement.specifiers.find((part) => part.local === binding);

    if (specifier) {
      const exported = importedName(specifier);

      return exported === undefined ? undefined : { exported, source: text(statement.source) };
    }
  }

  return undefined;
}

const openingTokens = new Set(["{", "(", "[", "${"]);
const closingTokens = new Set(["}", ")", "]"]);

interface ImportProbe {
  reading: boolean;
  symbols: Set<string>;
  path: string;
  names: Set<string>;
}

function tokenText(token: Token): string | undefined {
  return "value" in token ? String(token.value) : undefined;
}

function importSource(value: string | undefined, probe: ImportProbe): boolean {
  return (
    value === probe.path &&
    [...probe.names].some(
      (exported) =>
        probe.symbols.has(exported) || (exported === "default" && probe.symbols.size > 0),
    )
  );
}

function importToken(
  label: string,
  value: string | undefined,
  depth: number,
  probe: ImportProbe,
): boolean {
  if (!probe.reading) {
    return false;
  }

  if (label === "string" && depth === 0) {
    probe.reading = false;

    return importSource(value, probe);
  }

  if ((label === "name" || label === "string") && value !== undefined) {
    probe.symbols.add(value);
  }

  if (label === ";" && depth === 0) {
    probe.reading = false;
  }

  return false;
}

function tokenDepth(label: string, depth: number): number {
  if (openingTokens.has(label)) {
    return depth + 1;
  }

  return closingTokens.has(label) ? depth - 1 : depth;
}

function topImport(label: string, depth: number, previous: string): boolean {
  return label === "import" && depth === 0 && previous !== "." && previous !== "?.";
}

function importsSymbol(source: string, path: string, names: Set<string>): boolean {
  const probe: ImportProbe = { reading: false, symbols: new Set(), path, names };
  let depth = 0;
  let previous = "";

  for (const token of tokenizer(source, { ecmaVersion: "latest", sourceType: "module" })) {
    const label = token.type.label;

    if (topImport(label, depth, previous)) {
      probe.reading = true;
      probe.symbols = new Set();
    } else if (importToken(label, tokenText(token), depth, probe)) {
      return true;
    }

    depth = tokenDepth(label, depth);
    previous = label;
  }

  return false;
}

function contains(file: BunModule, needles: Buffer[]): boolean {
  return needles.every((needle) => file.source.includes(needle));
}

export class JavaScript {
  private readonly files: Map<string, BunModule>;
  private readonly parsed = new Map<string, Program>();
  private readonly paths = new WeakMap<Program, string>();
  private readonly bindings = new WeakMap<Program, Bindings>();
  private readonly exports = new WeakMap<Program, ModuleExports>();

  constructor(bytes: Buffer) {
    this.files = new Map(readBunModules(bytes).map((file) => [file.path, file]));
  }

  private environment(module: Program): Bindings {
    let bindings = this.bindings.get(module);

    if (!bindings) {
      bindings = new Bindings(module);
      this.bindings.set(module, bindings);
    }

    return bindings;
  }

  private binding(module: Program, node: Identifier): Identifier | undefined {
    return this.environment(module).resolve(node);
  }

  private moduleExports(module: Program): ModuleExports {
    let exports = this.exports.get(module);

    if (!exports) {
      exports = exportsOf(module);
      this.exports.set(module, exports);
    }

    return exports;
  }

  private exportNames(target: SymbolReference): Set<string> {
    const local = declaredFunction(target).id;
    const names = new Set<string>();

    for (const [exported, identifier] of this.moduleExports(target.module)) {
      if (this.binding(target.module, identifier) === local) {
        names.add(exported);
      }
    }

    return names;
  }

  private modulePath(module: Program): string {
    return present(this.paths.get(module), "module identity");
  }

  sameBinding(module: Program, left: AnyNode, right: AnyNode): boolean {
    if (left.type !== "Identifier" || right.type !== "Identifier") {
      return false;
    }

    const binding = this.binding(module, left);

    return binding !== undefined && binding === this.binding(module, right);
  }

  unchanged(module: Program, identifier: AnyNode): boolean {
    return identifier.type === "Identifier" && this.environment(module).unchanged(identifier);
  }

  references(module: Program, identifier: AnyNode, target: SymbolReference): boolean {
    if (identifier.type !== "Identifier" || !this.unchanged(module, identifier)) {
      return false;
    }

    const binding = this.binding(module, identifier);
    const local = declaredFunction(target).id;

    if (!binding || !this.unchanged(target.module, local)) {
      return false;
    }

    if (module === target.module) {
      return binding === local;
    }

    const imported = importBinding(module, binding);

    return (
      !!imported &&
      imported.source === this.modulePath(target.module) &&
      this.exportNames(target).has(imported.exported)
    );
  }

  private localFunction(module: Program, binding: Identifier): SymbolReference | undefined {
    const declared = module.body.flatMap((statement) => {
      const fn = functionDeclaration(statement);

      return fn && fn.id === binding ? [fn] : [];
    });

    if (!declared.length || !this.unchanged(module, binding)) {
      return undefined;
    }

    return { module, name: one(declared, "referenced function").id.name };
  }

  referenceNames(module: Program, target: SymbolReference): ReadonlySet<string> {
    if (module === target.module) {
      return new Set([target.name]);
    }

    const path = this.modulePath(target.module);
    const exports = this.exportNames(target);
    const result = new Set<string>();

    for (const statement of module.body) {
      if (statement.type !== "ImportDeclaration" || text(statement.source) !== path) {
        continue;
      }

      for (const specifier of statement.specifiers) {
        const exported = importedName(specifier);

        if (exported !== undefined && exports.has(exported)) {
          result.add(specifier.local.name);
        }
      }
    }

    return result;
  }

  resolveFunction(module: Program, identifier: AnyNode): SymbolReference | undefined {
    if (identifier.type !== "Identifier" || !this.unchanged(module, identifier)) {
      return undefined;
    }

    const binding = this.binding(module, identifier);

    if (!binding) {
      return undefined;
    }

    const local = this.localFunction(module, binding);

    if (local) {
      return local;
    }

    const imported = importBinding(module, binding);
    const file = imported && this.files.get(imported.source);

    if (!file || !imported) {
      return undefined;
    }

    const target = this.embedded(file);
    const exported = this.moduleExports(target).get(imported.exported);
    const definition = exported && this.binding(target, exported);

    return definition ? this.localFunction(target, definition) : undefined;
  }

  private source(file: BunModule): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.source);
  }

  private embedded(file: BunModule): Program {
    let root = this.parsed.get(file.path);

    if (!root) {
      try {
        root = parseModule(this.source(file));
      } catch (error) {
        throw new Error(
          `Claude CLI embedded JavaScript ${file.path} is unsupported. Request blocked.`,
          { cause: error },
        );
      }

      this.parsed.set(file.path, root);
      this.paths.set(root, file.path);
    }

    return root;
  }

  private needles(markers: string[]): Buffer[] {
    if (!markers.length || markers.some((marker) => !marker || marker.includes("\0"))) {
      return unsupported("JavaScript module marker");
    }

    return markers.map((marker) => Buffer.from(marker));
  }

  importers(target: SymbolReference, ...markers: string[]): Program[] {
    const needles = this.needles(markers);
    const path = this.modulePath(target.module);
    const exports = this.exportNames(target);

    // Tokens only pre-filter modules. Parsed imports and exports are still checked.
    const modules: Program[] = [];

    for (const file of this.files.values()) {
      if (contains(file, needles) && importsSymbol(this.source(file), path, exports)) {
        modules.push(this.embedded(file));
      }
    }

    return modules;
  }

  select<T>(markers: string[], select: (module: Program) => T[]): T[] {
    return this.selectGroups([markers], select);
  }

  // Overlapping queries share one parse. Modules without results are released.
  selectGroups<T>(
    groups: string[][],
    select: (module: Program, matched: readonly boolean[]) => T[],
  ): T[] {
    if (!groups.length) {
      return unsupported("JavaScript module query");
    }

    const queries = groups.map((markers) => this.needles(markers));
    const found: T[] = [];

    for (const file of this.files.values()) {
      const matched = queries.map((needles) => contains(file, needles));

      if (!matched.some(Boolean)) {
        continue;
      }

      const retained = this.parsed.has(file.path);
      const root = this.embedded(file);
      const candidates = select(root, matched);
      found.push(...candidates);

      if (!retained && !candidates.length) {
        this.parsed.delete(file.path);
      }
    }

    return found;
  }
}

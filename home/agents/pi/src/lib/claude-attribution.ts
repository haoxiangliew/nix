import type {
  AnyNode,
  BlockStatement,
  CallExpression,
  Expression,
  Pattern,
  Program,
  TemplateLiteral,
  VariableDeclarator,
} from "acorn";

import {
  capture,
  childNodes,
  cooked,
  declarations,
  functions,
  hasBlock,
  isFunction,
  match,
  name,
  one,
  present,
  property,
  same,
  scope,
  stringLiteral,
  text,
  walk,
  type BlockFunction,
  type FunctionNode,
  type JavaScript,
  type Match,
  type SymbolReference,
} from "./javascript.ts";

// The builder must interpolate each group exactly once, even if it evaluates to "".
const requiredOptionalGroups = [
  ["cch"],
  ["cc_workload"],
  ["cc_is_subagent"],
  ["cc_prev_req"],
  ["cc_prompt_id"],
  ["cc_turn_origin"],
  ["cc_prompt_index", "cc_turn_index"],
];

const requiredOptionalFields = requiredOptionalGroups.flat();

const protectedFields = ["cc_version", "cc_entrypoint", "cc_gateway", ...requiredOptionalFields];

const fieldNameCharacters = new Set("abcdefghijklmnopqrstuvwxyz0123456789_");

// Name matching is only a necessary filter. Keep shadowed spellings here;
// functionBridges/functionFlows still prove the actual lexical references.
function relatedFunctions(
  js: JavaScript,
  module: Program,
  target: SymbolReference,
): ReadonlySet<FunctionNode> {
  const names = js.referenceNames(module, target);
  const owners = new Set<FunctionNode>();

  function visit(node: AnyNode, owner: FunctionNode | undefined): void {
    if (isFunction(node)) {
      owner = node;
    }

    if (
      owner &&
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      names.has(node.callee.name)
    ) {
      owners.add(owner);
    }

    for (const part of childNodes(node)) {
      visit(part, owner);
    }
  }

  if (names.size) {
    visit(module, undefined);
  }

  return owners;
}

function tail(fn: BlockFunction): Expression {
  const last = fn.body.body.at(-1);

  if (last?.type !== "ReturnStatement" || !last.argument) {
    throw new Error("Claude CLI attribution return changed. Request blocked.");
  }

  const value = last.argument;

  return value.type === "SequenceExpression"
    ? one(value.expressions.slice(-1), "return value")
    : value;
}

function valueOf(body: BlockStatement, identifier: AnyNode): Expression {
  const binding = one(
    declarations(body).filter((node) => same(node.id, identifier)),
    "attribution binding",
  );

  return present(binding.init, "attribution initializer");
}

function declaration(body: BlockStatement, value: AnyNode): Pattern {
  return one(
    declarations(body).filter((node) => node.init === value),
    "attribution declaration",
  ).id;
}

function unchanged(
  js: JavaScript,
  module: Program,
  body: BlockStatement,
  identifiers: AnyNode[],
): void {
  for (const node of walk(body)) {
    if (node.type !== "AssignmentExpression" && node.type !== "UpdateExpression") {
      continue;
    }

    let target: AnyNode = node.type === "AssignmentExpression" ? node.left : node.argument;

    while (target.type === "MemberExpression") {
      target = target.object;
    }

    if (
      [...walk(target)].some((part) =>
        identifiers.some((identifier) => js.sameBinding(module, part, identifier)),
      )
    ) {
      throw new Error("Claude CLI attribution binding is reassigned. Request blocked.");
    }
  }
}

function before(left: AnyNode, right: AnyNode): boolean {
  return left.end <= right.start;
}

function suffix(node: AnyNode): string[] {
  if (node.type !== "ConditionalExpression" || text(node.alternate) !== "") {
    throw new Error("Claude CLI optional attribution changed. Request blocked.");
  }

  const value = node.consequent;
  const literals = value.type === "TemplateLiteral" ? value.quasis.map(cooked) : [text(value)];

  // NUL stands for one whole interpolated value. Reject literals that already contain NUL.
  if (literals.some((literal) => literal.includes("\0"))) {
    throw new Error("Claude CLI attribution literal changed. Request blocked.");
  }

  return attributionEntries(literals.join("\0")).map(([field]) => field);
}

// Fields are " name=value;" entries. Names are lowercase snake_case, so an interpolated NUL
// can only appear in a value.
function attributionEntries(source: string): [string, string][] {
  const entries = source.split(";");

  if (entries.length < 2 || entries.pop() !== "") {
    throw new Error("Claude CLI attribution field terminator changed. Request blocked.");
  }

  return entries.map((entry) => {
    const separator = entry.indexOf("=");
    const field = entry.slice(1, separator);

    if (
      !entry.startsWith(" ") ||
      separator < 2 ||
      !field.split("").every((character) => fieldNameCharacters.has(character))
    ) {
      throw new Error("Claude CLI attribution field changed. Request blocked.");
    }

    return [field, entry.slice(separator + 1)];
  });
}

export function attributionFields(attribution: string, prefix: string): Map<string, string> {
  if (!attribution.startsWith(prefix)) {
    throw new Error("Claude CLI attribution prefix changed. Request blocked.");
  }

  const entries = attributionEntries(attribution.slice(prefix.length));
  const fields = new Map(entries);

  if (fields.size !== entries.length) {
    throw new Error("Claude CLI attribution fields are duplicated. Request blocked.");
  }

  return fields;
}

export function attributionText(prefix: string, fields: ReadonlyMap<string, string>): string {
  return `${prefix}${[...fields].map(([field, value]) => ` ${field}=${value};`).join("")}`;
}

function entrypoint(node: AnyNode): void {
  const alternatives: AnyNode[] = [];

  function flatten(value: AnyNode): void {
    if (value.type === "LogicalExpression" && value.operator === "??") {
      flatten(value.left);
      flatten(value.right);
    } else {
      alternatives.push(value);
    }
  }

  flatten(node);
  const fallback = alternatives.pop();
  const environment = alternatives.pop();

  if (
    !fallback ||
    !text(fallback) ||
    !environment ||
    !match(environment, "process.env.CLAUDE_CODE_ENTRYPOINT")
  ) {
    throw new Error("Claude CLI entrypoint fallback changed. Request blocked.");
  }

  for (const host of alternatives) {
    if (
      host.type !== "CallExpression" ||
      host.arguments.length !== 0 ||
      !["Identifier", "MemberExpression"].includes(host.callee.type)
    ) {
      throw new Error("Claude CLI host entrypoint selection changed. Request blocked.");
    }
  }
}

function readPrefix(js: JavaScript, module: Program, fn: FunctionNode, prefix: string): boolean {
  const [parameter] = fn.params;

  if (!hasBlock(fn) || fn.params.length !== 1 || !parameter) {
    return false;
  }

  const returns = [...scope(fn.body)].flatMap((node) =>
    node.type === "ReturnStatement" ? [node] : [],
  );

  const argument = returns.length === 1 ? returns[0]?.argument : undefined;

  const result =
    argument && match(argument, 'typeof $value === "string" && $value.startsWith($prefix)');

  if (!result || !readsBlock(js, module, fn.body, parameter, result)) {
    return false;
  }

  const known = declarations(module).some(
    (node) =>
      js.sameBinding(module, node.id, capture(result, "prefix")) &&
      node.init?.type === "Literal" &&
      node.init.value === prefix,
  );

  if (known) {
    unchanged(js, module, fn.body, [capture(result, "value"), capture(result, "prefix")]);
  }

  return known;
}

function readsBlock(
  js: JavaScript,
  module: Program,
  body: BlockStatement,
  parameter: Pattern,
  result: Match,
): boolean {
  const values = declarations(body).filter((node) => same(node.id, capture(result, "value")));

  if (values.length !== 1) {
    return false;
  }

  const variable = one(values, "prefix text binding");
  const read = variable.init && match(variable.init, "$block.text");

  return (
    !!read &&
    js.sameBinding(module, capture(read, "block"), parameter) &&
    js.sameBinding(module, capture(result, "value"), variable.id)
  );
}

function prefixReader(js: JavaScript, prefix: string): void {
  const readers = js.select([prefix, "startsWith"], (module) =>
    functions(module).filter((fn) => readPrefix(js, module, fn, prefix)),
  );

  one(readers, "attribution prefix reader");
}

function builderTemplate(body: BlockStatement): TemplateLiteral[] {
  const templates: TemplateLiteral[] = [];

  for (const node of scope(body)) {
    if (
      node.type === "TemplateLiteral" &&
      cooked(one(node.quasis.slice(0, 1), "template prefix")).includes(" cc_version=")
    ) {
      templates.push(node);
    }
  }

  return templates;
}

function templateBindings(template: TemplateLiteral) {
  const literals = template.quasis.map(cooked);
  const [versionId, entrypointId, ...optional] = template.expressions;
  const first = literals[0];
  const marker = " cc_version=";

  if (
    !first?.endsWith(marker) ||
    literals[1] !== "; cc_entrypoint=" ||
    literals[2] !== ";" ||
    literals.slice(3).some((value) => value !== "")
  ) {
    throw new Error("Claude CLI attribution template changed. Request blocked.");
  }

  if (!versionId || !entrypointId) {
    throw new Error("Claude CLI attribution fields are incomplete. Request blocked.");
  }

  return { prefix: first.slice(0, -marker.length), versionId, entrypointId, optional };
}

function versionBinding(fn: BlockFunction, identifier: AnyNode, version: string): void {
  const binding = match(valueOf(fn.body, identifier), "`${$metadata.VERSION}.${$fingerprint}`");

  if (
    !binding ||
    text(property(capture(binding, "metadata"), "VERSION")) !== version ||
    !same(capture(binding, "fingerprint"), one(fn.params.slice(0, 1), "fingerprint parameter"))
  ) {
    throw new Error("Claude CLI attribution version binding changed. Request blocked.");
  }
}

function checksumSource(node: AnyNode): boolean {
  return (
    node.type === "ConditionalExpression" && !!stringLiteral(node.consequent)?.startsWith(" cch=")
  );
}

function optionalGroup(body: BlockStatement, value: Expression): string[] {
  const fields = suffix(value);

  const required = requiredOptionalGroups.some(
    (group) =>
      group.length === fields.length && group.every((field, index) => fields[index] === field),
  );

  const gateway = match(
    value,
    '($backend === "gateway" || $enabled) && !$foreign ? ` cc_gateway=${$enabled ? "1" : "env"};` : ""',
  );

  // Allow new cc_* groups that don't reuse a known field name.
  const extension = fields.every(
    (field) => field.startsWith("cc_") && !protectedFields.includes(field),
  );

  if (!required && !gateway && !extension) {
    throw new Error("Claude CLI optional attribution group changed. Request blocked.");
  }

  if (
    fields[0] === "cch" &&
    one([...scope(body)].filter(checksumSource), "checksum attribution source") !== value
  ) {
    throw new Error("Claude CLI checksum attribution binding changed. Request blocked.");
  }

  return fields;
}

function optionalFields(
  js: JavaScript,
  module: Program,
  body: BlockStatement,
  optional: Expression[],
): void {
  const fields: string[] = [];

  for (const expression of optional) {
    const value = expression.type === "Identifier" ? valueOf(body, expression) : expression;

    if (
      expression.type === "Identifier" &&
      !js.sameBinding(module, expression, declaration(body, value))
    ) {
      throw new Error("Claude CLI optional attribution binding changed. Request blocked.");
    }

    fields.push(...optionalGroup(body, value));
  }

  if (
    new Set(fields).size !== fields.length ||
    requiredOptionalFields.some((field) => !fields.includes(field))
  ) {
    throw new Error("Claude CLI optional attribution fields changed. Request blocked.");
  }
}

function validateBuilder(
  js: JavaScript,
  module: Program,
  fn: BlockFunction,
  template: TemplateLiteral,
  version: string,
): string {
  const body = fn.body;
  const { prefix, versionId, entrypointId, optional } = templateBindings(template);
  versionBinding(fn, versionId, version);
  entrypoint(valueOf(body, entrypointId));
  optionalFields(js, module, body, optional);
  const result = declaration(body, template);

  if (valueOf(body, result) !== template || !js.sameBinding(module, tail(fn), result)) {
    throw new Error("Claude CLI attribution return binding changed. Request blocked.");
  }

  const bindings = [
    versionId,
    entrypointId,
    ...optional.filter((node) => node.type === "Identifier"),
  ];

  if (bindings.some((identifier) => !before(valueOf(body, identifier), template))) {
    throw new Error("Claude CLI attribution initialization order changed. Request blocked.");
  }

  unchanged(js, module, body, [result, ...bindings, ...fn.params]);

  return prefix;
}

function functionName(fn: FunctionNode): string {
  return name(present(fn.id, "attribution function name"));
}

interface Attribution {
  builder: SymbolReference;
  prefix: string;
}

export function readAttribution(js: JavaScript, version: string): Attribution {
  const candidates = js.select(["cc_version="], (module) =>
    functions(module).flatMap((fn) =>
      hasBlock(fn) ? builderTemplate(fn.body).map((template) => ({ module, fn, template })) : [],
    ),
  );

  const { module, fn, template } = one(candidates, "attribution builder");
  const prefix = validateBuilder(js, module, fn, template, version);
  prefixReader(js, prefix);

  return { builder: { module, name: functionName(fn) }, prefix };
}

function bridgeResult(
  js: JavaScript,
  module: Program,
  fn: BlockFunction,
  attributionCall: AnyNode,
  combined: AnyNode,
  combine: AnyNode,
): Pattern {
  const body = fn.body;
  const result = declaration(body, combined);

  if (
    valueOf(body, result) !== combined ||
    !js.sameBinding(module, tail(fn), result) ||
    !before(attributionCall, combined) ||
    combine.type !== "Identifier" ||
    declarations(body).length !== 2
  ) {
    throw new Error("Claude CLI attribution bridge return changed. Request blocked.");
  }

  return result;
}

function bridgeAssembly(body: BlockStatement, inputs: ReadonlyMap<string, AnyNode>): Match {
  return one(
    declarations(body).flatMap((part) => {
      const value =
        part.init &&
        match(part.init, "$combine([$attribution, $identity, ...$system].filter(Boolean))", inputs);

      return value ? [value] : [];
    }),
    "attribution bridge assembly",
  );
}

function bridgeParameters(fn: FunctionNode): Map<string, AnyNode> | undefined {
  const [system, identity, options] = fn.params;

  if (fn.params.length !== 3 || !system || !identity || !options) {
    return undefined;
  }

  return new Map<string, AnyNode>([
    ["system", system],
    ["identity", identity],
    ["options", options],
  ]);
}

function functionBridges(
  js: JavaScript,
  module: Program,
  fn: FunctionNode,
  builder: SymbolReference,
): SymbolReference[] {
  const bindings = bridgeParameters(fn);

  if (
    !bindings ||
    !hasBlock(fn) ||
    fn.body.body.slice(0, -1).some((statement) => statement.type !== "VariableDeclaration")
  ) {
    return [];
  }

  const body = fn.body;
  const candidates: SymbolReference[] = [];

  for (const variable of declarations(body)) {
    const call =
      variable.init &&
      match(
        variable.init,
        "$builder($options.fingerprint, $options.agentContext, $options.previousRequestId, $options.promptId, $options.turnOrigin, $options.turnPosition)",
        bindings,
      );

    if (!variable.init || !call || !js.references(module, capture(call, "builder"), builder)) {
      continue;
    }

    const attribution = variable.id;
    const combined = bridgeAssembly(body, new Map([...bindings, ["attribution", attribution]]));

    const result = bridgeResult(
      js,
      module,
      fn,
      variable.init,
      combined.node,
      capture(combined, "combine"),
    );

    unchanged(js, module, body, [attribution, result, ...fn.params]);
    candidates.push({ module, name: functionName(fn) });
  }

  return candidates;
}

interface FingerprintFlow {
  caller: SymbolReference;
  selector: SymbolReference;
}

function flowInitializer(
  js: JavaScript,
  module: Program,
  body: BlockStatement,
  bindings: VariableDeclarator[],
  identifier: AnyNode,
  consumer: AnyNode,
): Expression | undefined {
  if (identifier.type !== "Identifier") {
    return undefined;
  }

  const candidates = bindings.filter((binding) => js.sameBinding(module, binding.id, identifier));

  if (!candidates.length) {
    return undefined;
  }

  const init = one(candidates, "request flow binding").init;

  if (!init || !before(init, consumer)) {
    return undefined;
  }

  unchanged(js, module, body, [identifier]);

  return init;
}

function flowCaller(js: JavaScript, module: Program, call: AnyNode): SymbolReference | undefined {
  if (call.type !== "CallExpression" || call.optional) {
    return undefined;
  }

  const args = call.arguments;

  if (args.length !== 1 || args[0]?.type === "SpreadElement") {
    return undefined;
  }

  return js.resolveFunction(module, call.callee);
}

function bridgeInputs(
  js: JavaScript,
  module: Program,
  consumer: CallExpression,
  assembly: SymbolReference,
): { options: AnyNode; identity: AnyNode } | undefined {
  const [, identity, options] = consumer.arguments;

  if (
    consumer.optional ||
    consumer.arguments.length !== 3 ||
    options?.type !== "ObjectExpression" ||
    !identity ||
    !js.references(module, consumer.callee, assembly)
  ) {
    return undefined;
  }

  property(options, "agentContext");

  return { options, identity };
}

function consumerFlow(
  js: JavaScript,
  module: Program,
  body: BlockStatement,
  bindings: VariableDeclarator[],
  consumer: CallExpression,
  assembly: SymbolReference,
): FingerprintFlow | undefined {
  const inputs = bridgeInputs(js, module, consumer, assembly);

  if (!inputs) {
    return undefined;
  }

  const { options, identity } = inputs;

  const fingerprint = flowInitializer(
    js,
    module,
    body,
    bindings,
    property(options, "fingerprint"),
    consumer,
  );

  const selection =
    identity.type === "CallExpression"
      ? identity
      : flowInitializer(js, module, body, bindings, identity, consumer);

  if (!fingerprint || !selection) {
    return undefined;
  }

  const caller = flowCaller(js, module, fingerprint);
  const selector = flowCaller(js, module, selection);

  return caller && selector ? { caller, selector } : undefined;
}

function functionFlows(
  js: JavaScript,
  module: Program,
  fn: FunctionNode,
  assembly: SymbolReference,
): FingerprintFlow[] {
  if (!hasBlock(fn)) {
    return [];
  }

  const calls: CallExpression[] = [];
  const bindings: VariableDeclarator[] = [];

  for (const node of scope(fn.body)) {
    if (node.type === "CallExpression") {
      calls.push(node);
    } else if (node.type === "VariableDeclarator" && node.init) {
      bindings.push(node);
    }
  }

  return calls.flatMap((consumer) => {
    const flow = consumerFlow(js, module, fn.body, bindings, consumer, assembly);

    return flow ? [flow] : [];
  });
}

export function readFingerprintFlow(js: JavaScript, builder: SymbolReference): FingerprintFlow {
  const flows: FingerprintFlow[] = [];

  const modules = new Set([
    builder.module,
    ...js.importers(builder, "previousRequestId", "turnPosition"),
  ]);

  for (const module of modules) {
    for (const fn of relatedFunctions(js, module, builder)) {
      for (const assembly of functionBridges(js, module, fn, builder)) {
        const consumers = new Set([
          assembly.module,
          ...js.importers(assembly, "fingerprint", "agentContext"),
        ]);

        for (const consumer of consumers) {
          for (const request of relatedFunctions(js, consumer, assembly)) {
            flows.push(...functionFlows(js, consumer, request, assembly));
          }
        }
      }
    }
  }

  return one(flows, "request fingerprint flow");
}

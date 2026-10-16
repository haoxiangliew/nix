import { Parser, type Options } from "acorn";

interface NameIndex {
  seen: number;
  first: Map<string, number>;
}

const indexes = new WeakMap<string[], NameIndex>();
const nativeIndexOf = Array.prototype.indexOf;
const minimumIndexedSize = 64;

function indexedIndexOf(this: string[], value: string, from?: number): number {
  if (this.length < minimumIndexedSize || (from !== undefined && from !== 0)) {
    return nativeIndexOf.call(this, value, from);
  }

  let index = indexes.get(this);

  if (!index || index.seen > this.length) {
    index = { seen: 0, first: new Map() };
    indexes.set(this, index);
  }

  for (let position = index.seen; position < this.length; position += 1) {
    const entry = this[position]!;

    if (!index.first.has(entry)) {
      index.first.set(entry, position);
    }
  }

  index.seen = this.length;

  return index.first.get(value) ?? -1;
}

// Acorn's private parser state, so every field is checked at runtime.
interface RootScope {
  var: unknown;
  lexical: unknown;
  functions: unknown;
}

function rootScope(parser: Parser): RootScope {
  const stack = "scopeStack" in parser ? parser.scopeStack : undefined;
  const scope: unknown = Array.isArray(stack) && stack.length === 1 ? stack[0] : undefined;

  if (!(scope instanceof Object && "var" in scope && "lexical" in scope && "functions" in scope)) {
    throw new Error("Acorn's root scope layout changed. Request blocked.");
  }

  return scope;
}

function indexRootScope(parser: Parser): void {
  const scope = rootScope(parser);

  for (const names of [scope.var, scope.lexical, scope.functions]) {
    if (!Array.isArray(names) || names.length !== 0) {
      throw new Error("Acorn's root name lists changed. Request blocked.");
    }

    Object.defineProperty(names, "indexOf", {
      value: indexedIndexOf,
      configurable: true,
      writable: true,
    });
  }
}

class RootIndexedParser extends Parser {
  protected constructor(options: Options, input: string, startPos?: number) {
    super(options, input, startPos);
    indexRootScope(this);
  }
}

// Acorn checks root-scope redeclarations with Array#indexOf, which is O(n²) on
// large bundles. Index the root name lists; Acorn only appends to them.
export function parse(source: string, options: Options) {
  return RootIndexedParser.parse(source, options);
}

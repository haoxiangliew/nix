import { posix } from "node:path";

import { readAddress } from "./binary.ts";
import { X64Elf } from "./elf.ts";
import { Arm64MachO } from "./macho.ts";

export interface BunModule {
  path: string;
  source: Buffer;
}

// Bun's serialized standalone graph: six StringPointers (u32 offset/length),
// encoding/loader/format/side bytes. Unknown layouts fail closed.
// https://github.com/oven-sh/bun/blob/main/src/standalone_graph/StandaloneModuleGraph.rs
const recordBytes = 52;
const offsetsBytes = 32;
const trailer = Buffer.from("\n---- Bun! ----\n");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function requireGraph(condition: boolean): asserts condition {
  if (!condition) {
    throw new Error("Claude CLI embedded module table is unsupported. Request blocked.");
  }
}

function region(graph: Buffer, start: number, length: number): Buffer {
  requireGraph(start <= graph.length && length <= graph.length - start);

  return graph.subarray(start, start + length);
}

function pointer(graph: Buffer, offset: number, terminator = 0): Buffer {
  const start = graph.readUInt32LE(offset);
  const length = graph.readUInt32LE(offset + 4);
  const value = region(graph, start, length);

  if (terminator && (length || start)) {
    requireGraph(region(graph, start + length, terminator).every((byte) => byte === 0));
  }

  return value;
}

function moduleName(bytes: Buffer): string {
  const path = decoder.decode(bytes);
  requireGraph(
    path.startsWith("/$bunfs/root/") && !path.includes("\0") && posix.normalize(path) === path,
  );

  return path;
}

interface ModuleRecord {
  path: string;
  source?: Buffer;
}

function moduleRecord(graph: Buffer, table: Buffer, offset: number): ModuleRecord {
  const record = table.byteOffset - graph.byteOffset + offset;

  for (let field = 0; field < 48; field += 8) {
    pointer(graph, record + field);
  }

  const path = moduleName(pointer(graph, record, 1));
  const encoding = table[offset + 48]!;
  const loader = table[offset + 49]!;
  const format = table[offset + 50]!;
  const side = table[offset + 51]!;
  requireGraph(encoding <= 2 && loader <= 21 && format <= 2 && side <= 1);
  pointer(graph, record + 8, encoding === 2 ? 2 : 1);
  pointer(graph, record + 40, 1);

  if (loader > 3) {
    return { path };
  }

  requireGraph(loader === 1 && encoding === 1 && (format === 1 || format === 2));
  const source = pointer(graph, record + 8);
  requireGraph(source.length > 0);

  return { path, source };
}

function modules(graph: Buffer, table: Buffer): BunModule[] {
  requireGraph(table.length > 0 && table.length % recordBytes === 0);
  const names = new Set<string>();
  const result: BunModule[] = [];

  for (let offset = 0; offset < table.length; offset += recordBytes) {
    const record = moduleRecord(graph, table, offset);
    requireGraph(!names.has(record.path));
    names.add(record.path);

    if (record.source) {
      result.push({ path: record.path, source: record.source });
    }
  }

  requireGraph(result.length > 0);

  return result;
}

function parseGraph(bytes: Buffer): BunModule[] {
  requireGraph(bytes.length >= offsetsBytes + trailer.length);
  const offsets = bytes.length - offsetsBytes - trailer.length;
  requireGraph(bytes.subarray(offsets + offsetsBytes).equals(trailer));
  requireGraph(
    readAddress(bytes, offsets) === offsets && (bytes.readUInt32LE(offsets + 28) & ~0x3fff) === 0,
  );
  const contents = bytes.subarray(0, offsets);
  const table = region(contents, bytes.readUInt32LE(offsets + 8), bytes.readUInt32LE(offsets + 12));
  requireGraph(bytes.readUInt32LE(offsets + 16) < table.length / recordBytes);
  const argv = region(contents, bytes.readUInt32LE(offsets + 20), bytes.readUInt32LE(offsets + 24));
  requireGraph(region(contents, argv.byteOffset - contents.byteOffset + argv.length, 1)[0] === 0);

  return modules(contents, table);
}

function section(bytes: Buffer): Buffer {
  requireGraph(bytes.length >= 4);

  switch (bytes.readUInt32LE(0)) {
    case 0xfeedfacf:
      return new Arm64MachO(bytes).section("__BUN", "__bun");
    case 0x464c457f:
      return new X64Elf(bytes).section(".bun");
    default:
      throw new Error("Claude CLI module container is unsupported. Request blocked.");
  }
}

export function readBunModules(bytes: Buffer): BunModule[] {
  const blob = section(bytes);
  requireGraph(blob.length >= 8);
  const length = readAddress(blob, 0);
  requireGraph(length <= blob.length - 8);

  return parseGraph(blob.subarray(8, 8 + length));
}

import { createHash } from "node:crypto";

import type { CliOmission, CliSignerConfig } from "./claude-signer.ts";

import { requireSupported } from "./binary.ts";
import { Arm64MachO } from "./macho.ts";

type Pattern = readonly (readonly [number, number])[];

type BlockKind = "signer" | "helper" | "hash";

const anchor: Pattern = [
  [0xd2800001, 0xffe0001f],
  [0xf2a00001, 0xffe0001f],
  [0xf2c00001, 0xffe0001f],
  [0xf2e00001, 0xffe0001f],
  [0x910003e0, 0xffc003ff],
  [0x94000000, 0xfc000000],
  [0xd10003a0, 0xffc003ff],
  [0xaa1903e1, 0xffffffff],
  [0xaa1803e2, 0xffffffff],
  [0xd2800003, 0xffffffff],
  [0x94000000, 0xfc000000],
];

// SHA-256 of each block's instructions with addresses and constants masked out.
const schemas = {
  signer: {
    words: 191,
    digest: "eeddf2633ed6bf0975430420cb8d4b4abaf69f56eed1ca1ef9b714d105154c94",
  },
  helper: {
    words: 228,
    digest: "f262eddd85d47b8b9b80fe87aa3b90b9ca4f33d4a8793743108551f33efa5d45",
  },
  hash: { words: 214, digest: "9bb9ecb6c755f94690b370c70d757912da4dc91ca03e0eeb4e77f4512c0355a6" },
} satisfies Record<BlockKind, { words: number; digest: string }>;

function masked(word: number, mask: number): number {
  return (word & mask) >>> 0;
}

function matches(words: readonly number[], index: number, pattern: Pattern): boolean {
  return pattern.every(
    ([value, mask], offset) => masked(words[index + offset] ?? 0, mask) === value,
  );
}

function uniquePattern(words: readonly number[], pattern: Pattern): number {
  let found = -1;

  for (let index = 0; index <= words.length - pattern.length; index += 1) {
    if (matches(words, index, pattern)) {
      requireSupported(found === -1);
      found = index;
    }
  }

  requireSupported(found !== -1);

  return found;
}

function findAnchor(image: Arm64MachO): number {
  const { bytes, text } = image;
  let found = -1;

  for (
    let offset = text.offset;
    offset <= text.offset + text.size - anchor.length * 4;
    offset += 4
  ) {
    if (masked(bytes.readUInt32LE(offset), anchor[0]![1]) !== anchor[0]![0]) {
      continue;
    }

    const words = image.words(text.address + (offset - text.offset), anchor.length);

    if (matches(words, 0, anchor)) {
      requireSupported(found === -1);
      found = text.address + (offset - text.offset);
    }
  }

  requireSupported(found !== -1);

  return found;
}

function isAdrp(word: number): boolean {
  return masked(word, 0x9f000000) === 0x90000000;
}

function addressSchema(word: number, previous: number): number {
  if (isAdrp(word)) {
    return masked(word, 0x9f00001f);
  }

  if (isAdrp(previous)) {
    const op = masked(word, 0xffc00000);

    if ([0x91000000, 0x3dc00000, 0xfd400000].includes(op)) {
      return masked(word, 0xffc003ff);
    }

    return word;
  }

  return masked(word, 0xfc000000) === 0x94000000 ? masked(word, 0xfc000000) : word;
}

function signerSchema(word: number, next: number): number {
  const wide = masked(word, 0x7f800000);
  const register = word & 31;
  const variable = word >>> 31 === 1 ? register === 1 : register === 3;

  if ([0x52800000, 0x72800000].includes(wide) && variable) {
    return masked(word, 0xffe0001f);
  }

  if (masked(word, 0xffe00000) === 0x52800000 && masked(next, 0xffc003e0) === 0x390003e0) {
    return masked(word, 0xffe0001f);
  }

  return word;
}

function checkSchema(words: readonly number[], kind: BlockKind): void {
  const schema = schemas[kind];
  requireSupported(words.length === schema.words);
  const normalized = Buffer.alloc(words.length * 4);
  words.forEach((word, index) => {
    let value = addressSchema(word, words[index - 1] ?? 0);

    if (kind === "signer") {
      const valueSchema = signerSchema(word, words[index + 1] ?? 0);

      if (valueSchema !== word) {
        value = valueSchema;
      }
    }

    normalized.writeUInt32LE(value, index * 4);
  });
  requireSupported(createHash("sha256").update(normalized).digest("hex") === schema.digest);
}

function signed(value: number, bits: number): number {
  return value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
}

function branchTarget(pc: number, word: number): number {
  requireSupported(masked(word, 0xfc000000) === 0x94000000);

  return pc + signed(word & 0x03ffffff, 26) * 4;
}

function pageAddress(pc: number, word: number): number {
  requireSupported(isAdrp(word));
  const displacement = ((word >>> 5) & 0x7ffff) * 4 + ((word >>> 29) & 3);

  return Math.floor(pc / 4096) * 4096 + signed(displacement, 21) * 4096;
}

function immediate(word: number): number {
  return (word >>> 10) & 0xfff;
}

function calls(words: readonly number[], address: number): number[] {
  return words.flatMap((word, index) =>
    masked(word, 0xfc000000) === 0x94000000 ? [branchTarget(address + index * 4, word)] : [],
  );
}

interface Value {
  kind: "integer" | "address" | "stack";
  value: number;
}

interface Search {
  kind: "address" | "stack";
  bytes: Buffer;
}

function wideValue(word: number, registers: Map<number, Value>): void {
  const register = word & 31;
  const value = ((word >>> 5) & 0xffff) * 2 ** (((word >>> 21) & 3) * 16);
  const op = masked(word, 0x7f800000);

  if (op === 0x52800000) {
    registers.set(register, { kind: "integer", value });
  } else {
    registers.delete(register);
  }
}

function addValue(word: number, registers: Map<number, Value>): void {
  const source = (word >>> 5) & 31;
  const base = source === 31 ? { kind: "stack" as const, value: 0 } : registers.get(source);
  const register = word & 31;

  if (base === undefined) {
    registers.delete(register);

    return;
  }

  registers.set(register, { kind: base.kind, value: base.value + immediate(word) });
}

function copyValue(word: number, registers: Map<number, Value>): void {
  const register = word & 31;
  const source = registers.get((word >>> 16) & 31);

  if (source === undefined) {
    registers.delete(register);
  } else {
    registers.set(register, source);
  }
}

function storeByte(word: number, registers: Map<number, Value>, stack: Map<number, number>): void {
  const value = registers.get(word & 31);
  requireSupported(value?.kind === "integer" && value.value >= 0 && value.value <= 255);
  stack.set(immediate(word), value.value);
}

function searchBytes(
  image: Arm64MachO,
  registers: Map<number, Value>,
  stack: Map<number, number>,
): Search {
  const source = registers.get(2);
  const size = registers.get(3);
  requireSupported(source !== undefined && source.kind !== "integer" && size?.kind === "integer");
  requireSupported(size.value > 0 && size.value <= 512);

  if (source.kind === "address") {
    return { kind: source.kind, bytes: Buffer.from(image.slice(source.value, size.value)) };
  }

  const bytes = Buffer.alloc(size.value);

  for (let index = 0; index < size.value; index += 1) {
    const byte = stack.get(source.value + index);
    requireSupported(byte !== undefined);
    bytes[index] = byte;
  }

  return { kind: source.kind, bytes };
}

function interpretWord(
  word: number,
  pc: number,
  registers: Map<number, Value>,
  stack: Map<number, number>,
): void {
  if (isAdrp(word)) {
    registers.set(word & 31, { kind: "address", value: pageAddress(pc, word) });
  } else if (masked(word, 0xffc00000) === 0x91000000) {
    addValue(word, registers);
  } else if (masked(word, 0x7f800000) === 0x52800000 || masked(word, 0x7f800000) === 0x72800000) {
    wideValue(word, registers);
  } else if (masked(word, 0xffe0ffe0) === 0xaa0003e0) {
    copyValue(word, registers);
  } else if (masked(word, 0xffc003e0) === 0x390003e0) {
    storeByte(word, registers, stack);
  }
}

function readSearches(
  image: Arm64MachO,
  words: readonly number[],
  address: number,
  searchTarget: number,
): Search[] {
  const registers = new Map<number, Value>();
  const stack = new Map<number, number>();
  const result: Search[] = [];
  words.forEach((word, index) => {
    const pc = address + index * 4;

    if (masked(word, 0xfc000000) === 0x94000000) {
      if (branchTarget(pc, word) === searchTarget) {
        result.push(searchBytes(image, registers, stack));
      }

      for (let register = 0; register <= 18; register += 1) {
        registers.delete(register);
      }
    } else {
      interpretWord(word, pc, registers, stack);
    }
  });

  return result;
}

function vectors(image: Arm64MachO, words: readonly number[], address: number): bigint[][] {
  const result: bigint[][] = [];
  words.forEach((word, index) => {
    const load = words[index + 1] ?? 0;

    if (!isAdrp(word) || masked(load, 0xffc00000) !== 0x3dc00000) {
      return;
    }

    requireSupported((word & 31) === ((load >>> 5) & 31));
    const data = image.slice(pageAddress(address + index * 4, word) + immediate(load) * 16, 16);
    result.push([data.readBigInt64LE(0), data.readBigInt64LE(8)]);
  });

  return result;
}

function verifyHash(image: Arm64MachO, address: number): void {
  const words = image.words(address, schemas.hash.words);
  checkSchema(words, "hash");
  const constants = vectors(image, words, address);
  requireSupported(constants.length === 1);
  requireSupported(BigInt.asUintN(64, constants[0]![0]!) === 0x60ea27eeadc0b5d6n);
  requireSupported(BigInt.asUintN(64, constants[0]![1]!) === 0xc2b2ae3d27d4eb4fn);
  const targets = calls(words, address);
  requireSupported(targets.length === 3 && targets.every((target) => target === targets[0]));
}

function signerBlock(image: Arm64MachO, seedAddress: number) {
  const lower = Math.max(image.text.address, seedAddress - 512 * 4);
  const before = image.words(lower, (seedAddress - lower) / 4);

  const start = uniquePattern(before, [
    [0x52800008, 0xffe0001f],
    [0x390343e8, 0xffffffff],
    [0x52800009, 0xffe0001f],
    [0x390347e9, 0xffffffff],
  ]);

  const address = lower + start * 4;
  const words = image.words(address, schemas.signer.words);
  checkSchema(words, "signer");
  requireSupported(words.at(-2) === 0x39001109 && words.at(-1) === 0xbd000100);

  return { address, words };
}

function signerTargets(
  image: Arm64MachO,
  seedAddress: number,
  seed: readonly number[],
  words: readonly number[],
  address: number,
) {
  const hash = branchTarget(seedAddress + 5 * 4, seed[5]!);
  const helper = branchTarget(seedAddress + 10 * 4, seed[10]!);
  const targets = calls(words, address);
  requireSupported(targets.length === 11);
  const search = targets[0]!;

  const expected = [
    search,
    search,
    search,
    hash,
    helper,
    search,
    hash + 19 * 4,
    helper,
    hash + 19 * 4,
    hash + 19 * 4,
    hash + 114 * 4,
  ];

  requireSupported(targets.every((target, index) => target === expected[index]));
  verifyHash(image, hash);

  return { search, helper, hash };
}

function checksumLayout(
  image: Arm64MachO,
  words: readonly number[],
  address: number,
  placeholder: Buffer,
) {
  const offsetIndex = uniquePattern(words, [[0x91000120, 0xffc003ff]]);
  const endIndex = uniquePattern(words, [[0x91000121, 0xffc003ff]]);
  const checksumOffset = immediate(words[offsetIndex]!);
  const checksumDigits = immediate(words[endIndex]!) - checksumOffset;
  const shifts = vectors(image, words, address).flat();
  requireSupported(
    shifts.length === 4 && shifts.every((value, index) => value === [-8n, 0n, -16n, -12n][index]),
  );
  const checksumBits = Number(-shifts[2]!) + 4;
  requireSupported(
    checksumDigits * 4 === checksumBits && placeholder.length === checksumOffset + checksumDigits,
  );

  const windowIndex = uniquePattern(words, [
    [0x91000008, 0xffc003ff],
    [0xeb18011f, 0xffffffff],
    [0x9a983108, 0xffffffff],
  ]);

  const window = immediate(words[windowIndex]!);
  requireSupported(window >= placeholder.length);

  return { checksumOffset, checksumDigits, window };
}

function omissionMarkers(image: Arm64MachO, helper: number, search: number): CliOmission[] {
  const words = image.words(helper, schemas.helper.words);
  checkSchema(words, "helper");
  const targets = calls(words, helper);
  requireSupported(targets.slice(0, 3).every((target) => target === search));
  const searches = readSearches(image, words, helper, search);
  requireSupported(searches.length === 3 && searches.every((item) => item.kind === "address"));
  const kinds = ["array", "string", "number"] as const;

  return searches.map((item, index) => ({ kind: kinds[index]!, marker: item.bytes }));
}

export function extractArm64CliSigner(bytes: Buffer): CliSignerConfig {
  const image = new Arm64MachO(bytes);
  const seedAddress = findAnchor(image);
  const anchorWords = image.words(seedAddress, anchor.length);
  const block = signerBlock(image, seedAddress);
  const targets = signerTargets(image, seedAddress, anchorWords, block.words, block.address);
  const searches = readSearches(image, block.words, block.address, targets.search);
  requireSupported(searches.length === 4);
  requireSupported(searches.map((item) => item.kind).join(",") === "stack,address,stack,address");

  const seed = anchorWords
    .slice(0, 4)
    .reduce(
      (value, word, index) => value | (BigInt((word >>> 5) & 0xffff) << BigInt(index * 16)),
      0n,
    );

  const placeholder = searches[2]!.bytes;

  return {
    seed,
    bodyMarker: searches[1]!.bytes,
    modelMarker: searches[3]!.bytes,
    omissions: omissionMarkers(image, targets.helper, targets.search),
    placeholder,
    ...checksumLayout(image, block.words, block.address, placeholder),
  };
}

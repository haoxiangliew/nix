import { createHash } from "node:crypto";

import type { CliOmission, CliSignerConfig } from "./claude-signer.ts";

import { requireSupported } from "./binary.ts";
import { X64Elf } from "./elf.ts";

type Span = readonly [number, number];

interface Schema {
  readonly size: number;
  readonly digest: string;
  readonly relocations: readonly number[];
  readonly values: readonly Span[];
}

// The digest is SHA-256 of the signer code with the `relocations` and `values` byte ranges zeroed.
const signerSchema: Schema = {
  size: 1189,
  digest: "876ff3b7ea1d72f0b9ea5594aea4bf2c797599c7683d91d44e8cab885376f8f1",
  relocations: [
    104, 130, 226, 243, 257, 330, 356, 531, 566, 583, 597, 697, 718, 827, 843, 851, 871, 878, 896,
    903, 908, 913, 966, 974, 1104, 1116, 1142, 1154,
  ],
  values: [
    ...Array.from({ length: 12 }, (_, index): Span => [index * 7 + 6, 1]),
    ...Array.from({ length: 9 }, (_, index): Span => [180 + index * 4, 1]),
    ...Array.from({ length: 4 }, (_, index): Span => [449 + index * 17, 8]),
    [284, 4],
    [995, 1],
    [999, 1],
  ],
};

const helperSchema: Schema = {
  size: 1141,
  digest: "3cb437d0c01aaf760ca2df32f233c1bbc9f67d73c11d4cce2ca44a659a4f02cd",
  relocations: [
    51, 64, 81, 308, 321, 338, 455, 468, 482, 578, 586, 602, 609, 627, 634, 639, 644, 957, 968, 973,
    978, 995, 1002, 1020, 1027, 1032, 1037, 1051, 1059, 1064, 1069, 1086, 1093, 1111, 1118, 1123,
    1128,
  ],
  values: [],
};

const updateSchema: Schema = {
  size: 427,
  digest: "14d4592e8eb6bcfbdb9a14da9395b20e690cb8ce8714c0e036bf68c7637ba0cd",
  relocations: [59, 120, 404],
  values: [],
};

const digestSchema: Schema = {
  size: 699,
  digest: "89a81efb5f6f01aea3aacbf8168231e8ea16409da3cf5912bca7e8128de93c75",
  relocations: [],
  values: [],
};

function checkSchema(image: X64Elf, address: number, schema: Schema): Buffer {
  const code = image.code(address, schema.size);
  const normalized = Buffer.from(code);

  for (const offset of schema.relocations) {
    normalized.fill(0, offset, offset + 4);
  }

  for (const [offset, size] of schema.values) {
    normalized.fill(0, offset, offset + size);
  }

  requireSupported(createHash("sha256").update(normalized).digest("hex") === schema.digest);

  return code;
}

function findSigner(image: X64Elf): number {
  const text = image.code(image.text.address, image.text.fileSize);
  const firstStore = Buffer.from("48898528ffffff48b8", "hex");

  const stores = ["48898530ffffff48b8", "48898538ffffff48b8", "48898540ffffff"].map((hex) =>
    Buffer.from(hex, "hex"),
  );

  let cursor = 0;
  let found = -1;

  while (cursor < text.length) {
    const position = text.indexOf(firstStore, cursor);

    if (position === -1) {
      break;
    }

    cursor = position + 1;

    const matched = stores.every((expected, index) => {
      const offset = position + (index + 1) * 17;

      return text.subarray(offset, offset + expected.length).equals(expected);
    });

    if (matched) {
      requireSupported(found === -1);
      found = image.text.address + position - 457;
    }
  }

  requireSupported(found !== -1);

  return found;
}

function relative(code: Buffer, address: number, operand: number, end: number): number {
  const target = address + end + code.readInt32LE(operand);
  requireSupported(Number.isSafeInteger(target) && target >= 0);

  return target;
}

function callTarget(code: Buffer, address: number, offset: number): number {
  requireSupported(code[offset] === 0xe8);

  return relative(code, address, offset + 1, offset + 5);
}

function marker(image: X64Elf, code: Buffer, offset: number): Buffer {
  requireSupported(code[offset] === 0xba && code[offset + 5] === 0xb9);
  const address = code.readUInt32LE(offset + 1);
  const size = code.readUInt32LE(offset + 6);
  requireSupported(size > 0 && size <= 256);

  return Buffer.from(image.slice(address, size));
}

function stackString(code: Buffer, first: number, count: number, stride: number): Buffer {
  const result = Buffer.alloc(count);

  for (let index = 0; index < count; index += 1) {
    result[index] = code[first + index * stride]!;
  }

  return result;
}

function unsigned(value: bigint): bigint {
  return BigInt.asUintN(64, value);
}

function signerSeed(image: X64Elf, code: Buffer, address: number): bigint {
  const update = callTarget(code, address, 696);
  requireSupported(callTarget(code, address, 826) === update);
  requireSupported(callTarget(code, address, 965) === update);
  const hash = checkSchema(image, update, updateSchema);
  checkSchema(image, callTarget(code, address, 973), digestSchema);
  const prime2 = hash.readBigUInt64LE(77);
  const prime1 = hash.readBigUInt64LE(87);
  const lanes = Array.from({ length: 4 }, (_, index) => code.readBigUInt64LE(449 + index * 17));
  const seed = lanes[2]!;
  requireSupported(lanes[0] === unsigned(seed + prime1 + prime2));
  requireSupported(lanes[1] === unsigned(seed + prime2));
  requireSupported(lanes[3] === unsigned(seed - prime1));

  return seed;
}

function omissions(image: X64Elf, code: Buffer, address: number, search: number): CliOmission[] {
  const helper = callTarget(code, address, 530);
  requireSupported(callTarget(code, address, 717) === helper);
  const instructions = checkSchema(image, helper, helperSchema);
  const operands = [81, 338, 482];
  requireSupported(
    operands.every((offset) => relative(instructions, helper, offset, offset + 4) === search),
  );
  const kinds = ["array", "string", "number"] as const;
  const markers = [63, 320, 467];

  return markers.map((offset, index) => ({
    kind: kinds[index]!,
    marker: marker(image, instructions, offset),
  }));
}

// The signer calls its search function through a GOT slot. All four calls must use the same slot.
function searchSlot(code: Buffer, address: number): number {
  const operands = [130, 257, 356, 597];
  const search = relative(code, address, operands[0]!, operands[0]! + 4);
  requireSupported(
    operands.every((offset) => relative(code, address, offset, offset + 4) === search),
  );

  return search;
}

function checksumLayout(image: X64Elf, code: Buffer, address: number, placeholder: Buffer) {
  const window = code.readUInt32LE(284);
  const checksumOffset = code[995]!;
  const checksumDigits = code[999]! - checksumOffset;
  const checksumBits = code[1081]! + 4;
  requireSupported(checksumDigits > 0 && checksumDigits * 4 === checksumBits);
  requireSupported(placeholder.length === checksumOffset + checksumDigits);
  requireSupported(window >= placeholder.length && window <= 65536);

  const vectors = [
    image.slice(relative(code, address, 1104, 1108), 16),
    image.slice(relative(code, address, 1116, 1120), 4),
    image.slice(relative(code, address, 1142, 1146), 16),
    image.slice(relative(code, address, 1154, 1158), 16),
  ];

  // The checksum code uses these tables to print lowercase hex.
  requireSupported(
    vectors[0]!.equals(Buffer.from([15, 15, 15, 255, ...Array<number>(12).fill(0)])),
  );
  requireSupported(vectors[1]!.equals(Buffer.from([10, 10, 10, 160])));
  requireSupported(vectors[2]!.equals(Buffer.from([48, 48, 48, 48, ...Array<number>(12).fill(0)])));
  requireSupported(vectors[3]!.equals(Buffer.from([87, 87, 87, 87, ...Array<number>(12).fill(0)])));

  return { window, checksumOffset, checksumDigits };
}

export function extractElfCliSigner(bytes: Buffer): CliSignerConfig {
  const image = new X64Elf(bytes);
  const address = findSigner(image);
  const code = checkSchema(image, address, signerSchema);
  const search = searchSlot(code, address);
  image.slice(search, 8);
  const placeholder = stackString(code, 180, 9, 4);

  return {
    seed: signerSeed(image, code, address),
    bodyMarker: marker(image, code, 242),
    modelMarker: marker(image, code, 582),
    omissions: omissions(image, code, address, search),
    placeholder,
    ...checksumLayout(image, code, address, placeholder),
  };
}

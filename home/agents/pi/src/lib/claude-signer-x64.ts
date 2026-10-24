import {
  Decoder,
  DecoderOptions,
  FlowControl,
  InstructionInfoFactory,
  MemorySizeExt,
  Mnemonic,
  OpAccess,
  OpKind,
  Register,
  RegisterExt,
  RoundingControl,
  type Instruction as DecodedInstruction,
} from "iced-x86";
import { createHash } from "node:crypto";

import type { CliOmission, CliSignerConfig } from "./claude-signer.ts";

import { requireSupported } from "./binary.ts";
import {
  laneOffsets,
  omissionKinds,
  requestPath,
  searchLimit,
  unsigned,
} from "./claude-signer-constants.ts";
import { X64Elf } from "./elf.ts";

type BlockKind = "signer" | "helper" | "update" | "digest";

// SHA-256 of each block's non-NOP instructions, normalized by InstructionSchema.
const schemas = {
  signer: {
    instructions: 219,
    digest: "254ebd8e7e560c7d18f32a59426e6e3b8b61eb983e37d92ccc7d531aea3432cd",
  },
  helper: {
    instructions: 228,
    digest: "5eebcb117c1de760267f80d04ba26b5a18ee2167a7907e99652ee3e5ce6949b6",
  },
  update: {
    instructions: 114,
    digest: "4fb0ac3f153476eee057cb81d5a9dd184187b6897aafc8c97e6d9051ea30ff30",
  },
  digest: {
    instructions: 180,
    digest: "9527ce7b5cc43a6fdf97cdfbe5326ba225e8d4949bec1d823894c793465d59f9",
  },
} satisfies Record<BlockKind, { instructions: number; digest: string }>;

// Direct calls in the signer block, in order. Searches are indirect calls through one slot.
const signerCallLayout = ["helper", "update", "helper", "update", "update", "digest"] as const;

// Needle source of each search: request path, body marker, placeholder, model marker.
const searchSources = ["stack", "integer", "stack", "integer"] as const;

const checksumDigits = 5;

// Byte and instruction limits for each decoded region.
const limits = {
  seedBytes: 256,
  seedInstructions: 8,
  signerLookback: 2048,
  signerBytes: 4096,
  functionBytes: 8192,
  window: 65536,
};

// SysV argument registers, and the registers a call may clobber.
const argumentRegisters = [
  Register.RDI,
  Register.RSI,
  Register.RDX,
  Register.RCX,
  Register.R8,
  Register.R9,
];

const callerSaved = [
  Register.RAX,
  Register.RCX,
  Register.RDX,
  Register.RSI,
  Register.RDI,
  Register.R8,
  Register.R9,
  Register.R10,
  Register.R11,
];

const written = new Set([
  OpAccess.Write,
  OpAccess.CondWrite,
  OpAccess.ReadWrite,
  OpAccess.ReadCondWrite,
]);

type Operand =
  | { kind: "register"; register: Register }
  | { kind: "immediate"; value: bigint }
  | { kind: "branch"; address: number }
  | Memory;

interface Memory {
  kind: "memory";
  base: Register;
  index: Register;
  scale: number;
  displacement: number;
  size: number;
}

interface Instruction {
  address: number;
  next: number;
  mnemonic: Mnemonic;
  flow: FlowControl;
  operands: readonly Operand[];
  writes: readonly Register[];
  memoryWrite: boolean;
}

function decodeOperand(instruction: DecodedInstruction, index: number): Operand | undefined {
  const kind = instruction.opKind(index);

  if (kind === OpKind.Register) {
    return { kind: "register", register: instruction.opRegister(index) };
  }

  if (kind === OpKind.Memory) {
    const displacement = Number(instruction.memoryDisplacement);

    return Number.isSafeInteger(displacement)
      ? {
          kind: "memory",
          base: instruction.memoryBase,
          index: instruction.memoryIndex,
          scale: instruction.memoryIndexScale,
          displacement,
          size: MemorySizeExt.size(instruction.memorySize),
        }
      : undefined;
  }

  if (kind === OpKind.NearBranch64) {
    const address = Number(instruction.nearBranchTarget);

    return Number.isSafeInteger(address) ? { kind: "branch", address } : undefined;
  }

  return kind >= OpKind.Immediate8 && kind <= OpKind.Immediate32to64
    ? { kind: "immediate", value: instruction.immediate(index) }
    : undefined;
}

function plainPrefixes(instruction: DecodedInstruction): boolean {
  return (
    !instruction.hasLockPrefix &&
    !instruction.hasRepPrefix &&
    !instruction.hasRepnePrefix &&
    (instruction.segmentPrefix === Register.None || instruction.mnemonic === Mnemonic.Nop)
  );
}

function plainEvex(instruction: DecodedInstruction): boolean {
  return (
    instruction.opMask === Register.None &&
    !instruction.zeroingMasking &&
    instruction.roundingControl === RoundingControl.None &&
    !instruction.suppressAllExceptions
  );
}

function decodeOperands(instruction: DecodedInstruction): Operand[] | undefined {
  const operands: Operand[] = [];

  for (let index = 0; index < instruction.opCount; index += 1) {
    const operand = decodeOperand(instruction, index);

    if (operand === undefined) {
      return undefined;
    }

    operands.push(operand);
  }

  return operands;
}

// Returns undefined for instructions the interpreter doesn't model.
function copyInstruction(
  instruction: DecodedInstruction,
  factory: InstructionInfoFactory,
): Instruction | undefined {
  if (instruction.isInvalid || !plainPrefixes(instruction) || !plainEvex(instruction)) {
    return undefined;
  }

  const operands = decodeOperands(instruction);

  if (operands === undefined) {
    return undefined;
  }

  const info = factory.info(instruction);
  const registers = info.usedRegisters();

  try {
    return {
      address: Number(instruction.ip),
      next: Number(instruction.nextIP),
      mnemonic: instruction.mnemonic,
      flow: instruction.flowControl,
      operands,
      writes: registers
        .filter((register) => written.has(register.access))
        .map((register) => RegisterExt.fullRegister(register.register)),
      memoryWrite: operands.some(
        (operand, index) => operand.kind === "memory" && written.has(info.opAccess(index)),
      ),
    };
  } finally {
    registers.forEach((register) => register.free());
    info.free();
  }
}

// Copies into plain JS objects and frees every WASM allocation. Returns undefined if any
// instruction is unsupported.
function decodeX64(
  bytes: Buffer,
  address: number,
  stop: (instruction: Instruction) => boolean = () => false,
): Instruction[] | undefined {
  const decoder = new Decoder(64, bytes, DecoderOptions.None);
  const factory = new InstructionInfoFactory();
  decoder.ip = BigInt(address);
  const result: Instruction[] = [];

  try {
    while (decoder.canDecode) {
      const decoded = decoder.decode();
      let instruction: Instruction | undefined;

      try {
        instruction = copyInstruction(decoded, factory);
      } finally {
        decoded.free();
      }

      if (instruction === undefined) {
        return undefined;
      }

      result.push(instruction);

      if (stop(instruction)) {
        break;
      }
    }
  } finally {
    factory.free();
    decoder.free();
  }

  return result;
}

const significant = (instructions: readonly Instruction[]) =>
  instructions.filter((instruction) => instruction.mnemonic !== Mnemonic.Nop);

// Decodes until `count` non-NOP instructions. Returns undefined if there are fewer.
function decodeSignificant(
  bytes: Buffer,
  address: number,
  count: number,
): Instruction[] | undefined {
  let found = 0;

  const instructions = decodeX64(bytes, address, (instruction) => {
    found += instruction.mnemonic === Mnemonic.Nop ? 0 : 1;

    return found === count;
  });

  return found === count ? instructions : undefined;
}

function requireCode(instructions: Instruction[] | undefined): Instruction[] {
  requireSupported(instructions !== undefined);

  return instructions;
}

type Value =
  | { kind: "integer"; value: bigint }
  | { kind: "stack"; base: Register; offset: number }
  | { kind: "slot"; address: number };

interface Call {
  instruction: Instruction;
  target: Value | undefined;
  arguments: readonly (Value | undefined)[];
  stack: ReadonlyMap<string, number>;
}

interface Store {
  instruction: Instruction;
  memory: Memory;
  value: Value | undefined;
}

interface Analysis {
  calls: Call[];
  stores: Store[];
}

function stackKey(base: Register, offset: number): string {
  return `${base}:${offset}`;
}

function isStack(memory: Memory): boolean {
  return [Register.RBP, Register.RSP].includes(memory.base) && memory.index === Register.None;
}

function operandValue(
  operand: Operand | undefined,
  registers: ReadonlyMap<Register, Value>,
): Value | undefined {
  if (operand?.kind === "immediate") {
    return { kind: "integer", value: operand.value };
  }

  if (operand?.kind === "branch") {
    return { kind: "integer", value: BigInt(operand.address) };
  }

  if (operand?.kind === "register") {
    return registers.get(RegisterExt.fullRegister(operand.register));
  }

  if (operand?.kind === "memory" && operand.base === Register.RIP) {
    return { kind: "slot", address: operand.displacement };
  }

  return undefined;
}

function leaValue(memory: Operand | undefined): Value | undefined {
  if (memory?.kind !== "memory") {
    return undefined;
  }

  if (isStack(memory)) {
    return { kind: "stack", base: memory.base, offset: memory.displacement };
  }

  if (memory.base === Register.RIP) {
    return { kind: "integer", value: BigInt(memory.displacement) };
  }

  return undefined;
}

function resultValue(
  instruction: Instruction,
  registers: ReadonlyMap<Register, Value>,
): Value | undefined {
  const [destination, source] = instruction.operands;

  if (instruction.mnemonic === Mnemonic.Mov) {
    return operandValue(source, registers);
  }

  if (instruction.mnemonic === Mnemonic.Lea) {
    return leaValue(source);
  }

  if (
    instruction.mnemonic === Mnemonic.Xor &&
    destination?.kind === "register" &&
    source?.kind === "register" &&
    destination.register === source.register
  ) {
    return { kind: "integer", value: 0n };
  }

  return undefined;
}

function writeRegister(
  registers: Map<Register, Value>,
  destination: Operand | undefined,
  value: Value | undefined,
): void {
  if (destination?.kind !== "register" || value === undefined) {
    return;
  }

  const size = RegisterExt.size(destination.register);

  if (size < 4 || (size === 4 && value.kind !== "integer")) {
    return;
  }

  registers.set(
    RegisterExt.fullRegister(destination.register),
    value.kind === "integer"
      ? { kind: "integer", value: BigInt.asUintN(size * 8, value.value) }
      : value,
  );
}

function writeStack(stack: Map<string, number>, memory: Memory, value: Value | undefined): void {
  if (!isStack(memory)) {
    return;
  }

  for (let index = 0; index < memory.size; index += 1) {
    const key = stackKey(memory.base, memory.displacement + index);
    stack.delete(key);

    if (value?.kind === "integer") {
      stack.set(key, Number((value.value >> BigInt(index * 8)) & 255n));
    }
  }
}

// Tracks constants through straight-line code only. Unmodeled writes clear tracked values.
// Check the block's schema before trusting the results.
function analyzeX64(instructions: readonly Instruction[]): Analysis {
  const registers = new Map<Register, Value>();
  const stack = new Map<string, number>();
  const calls: Call[] = [];
  const stores: Store[] = [];

  for (const instruction of instructions) {
    if ([FlowControl.Call, FlowControl.IndirectCall].includes(instruction.flow)) {
      calls.push({
        instruction,
        target: operandValue(instruction.operands[0], registers),
        arguments: argumentRegisters.map((register) => registers.get(register)),
        stack: new Map(stack),
      });

      callerSaved.forEach((register) => registers.delete(register));
      continue;
    }

    const value = resultValue(instruction, registers);
    instruction.writes.forEach((register) => registers.delete(register));
    const destination = instruction.operands[0];
    writeRegister(registers, destination, value);

    if (destination?.kind === "memory" && instruction.memoryWrite) {
      stores.push({ instruction, memory: destination, value });
      writeStack(stack, destination, value);
    }
  }

  return { calls, stores };
}

type Token = string | number | readonly Token[];

function mapped(image: X64Elf, value: bigint): boolean {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && image.contains(Number(value));
}

// Normalizes a block so its digest ignores NOPs, branch encodings, stack frame position,
// and relocated addresses. Branches keep their targets, stack references keep their
// layout, and data and call addresses keep their aliasing. Extracted constants are masked.
// Hashes the contents of every 4- and 16-byte RIP-relative operand, such as the hex tables.
class InstructionSchema {
  private readonly aliases = new Map<number, number>();
  private readonly stackBases = new Map<Register, number>();
  private readonly indices = new Map<number, number>();

  constructor(
    private readonly image: X64Elf,
    private readonly code: readonly Instruction[],
    private readonly variables: ReadonlySet<number>,
    private readonly window: Instruction | undefined,
  ) {
    let index = 0;

    for (const instruction of code) {
      this.indices.set(instruction.address, index);
      index += instruction.mnemonic === Mnemonic.Nop ? 0 : 1;
    }
  }

  private alias(address: number): number {
    if (!this.aliases.has(address)) {
      this.aliases.set(address, this.aliases.size);
    }

    return this.aliases.get(address)!;
  }

  private displacement(value: Memory, instruction: Instruction): Token {
    if (instruction.address === this.window?.address) {
      return ["value"];
    }

    if (value.base === Register.RIP) {
      return value.size === 16 || value.size === 4
        ? ["table", this.image.slice(value.displacement, value.size).toString("hex")]
        : ["address", this.alias(value.displacement)];
    }

    if (isStack(value)) {
      if (!this.stackBases.has(value.base)) {
        this.stackBases.set(value.base, value.displacement);
      }

      return value.displacement - this.stackBases.get(value.base)!;
    }

    return value.displacement;
  }

  private branch(address: number): Token {
    requireSupported(this.image.executable(address));
    const internal = this.indices.get(address);

    if (internal !== undefined) {
      return ["branch", ["internal", internal]];
    }

    requireSupported(address < this.code[0]!.address || address >= this.code.at(-1)!.next);

    return ["branch", ["external", this.alias(address)]];
  }

  private operand(value: Operand, instruction: Instruction): Token {
    if (value.kind === "register") {
      return ["register", value.register];
    }

    if (value.kind === "branch") {
      return this.branch(value.address);
    }

    if (value.kind === "memory") {
      const { base, index, scale, size } = value;

      return ["memory", base, index, scale, size, this.displacement(value, instruction)];
    }

    if (this.variables.has(instruction.address)) {
      return ["value"];
    }

    return mapped(this.image, value.value)
      ? ["address", this.alias(Number(value.value))]
      : ["integer", value.value.toString()];
  }

  normalize(): Token[] {
    return significant(this.code).map((instruction) => [
      instruction.mnemonic,
      instruction.flow,
      instruction.operands.map((value) => this.operand(value, instruction)),
    ]);
  }
}

function checkSchema(
  image: X64Elf,
  code: readonly Instruction[],
  kind: BlockKind,
  variables: ReadonlySet<number> = new Set(),
  window?: Instruction,
): void {
  const schema = schemas[kind];
  const normalized = new InstructionSchema(image, code, variables, window).normalize();
  requireSupported(normalized.length === schema.instructions);
  const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  requireSupported(digest === schema.digest);
}

interface Seed {
  address: number;
  value: bigint;
  stores: readonly Store[];
}

interface Load {
  index: number;
  value: bigint;
}

// Every MOV r64, imm64 in .text except the last limits.seedBytes bytes, including ones
// inside other instructions.
function immediateLoads(text: Buffer): Load[] {
  const loads: Load[] = [];

  for (let index = 0; index + limits.seedBytes < text.length; index += 1) {
    if ((text[index]! & 0xf8) === 0x48 && (text[index + 1]! & 0xf8) === 0xb8) {
      loads.push({ index, value: text.readBigUInt64LE(index + 2) });
    }
  }

  return loads;
}

// Returns offsets of imm64 loads followed, within limits.seedBytes, by imm64 loads of all
// four lanes for one seed.
function seedCandidates(text: Buffer): number[] {
  const loads = immediateLoads(text);

  return loads.flatMap(({ index, value }, position) => {
    const values = new Set<bigint>();

    for (
      let next = position;
      next < loads.length && loads[next]!.index < index + limits.seedBytes;
      next += 1
    ) {
      values.add(loads[next]!.value);
    }

    const lanes = laneOffsets.some((offset) =>
      laneOffsets.every((lane) => values.has(unsigned(value - offset + lane))),
    );

    return lanes ? [index] : [];
  });
}

function laneValue(store: Store, first: Memory, index: number): bigint | undefined {
  const { memory, value } = store;

  const lane =
    isStack(memory) &&
    memory.base === first.base &&
    memory.size === 8 &&
    memory.displacement === first.displacement + index * 8;

  return lane && value?.kind === "integer" ? value.value : undefined;
}

function seedAt(image: X64Elf, address: number): Seed | undefined {
  const instructions = decodeSignificant(
    image.code(address, limits.seedBytes),
    address,
    limits.seedInstructions,
  );

  const stores = instructions === undefined ? [] : analyzeX64(instructions).stores;
  const first = stores[0]?.memory;

  if (first === undefined || stores.length !== laneOffsets.length) {
    return undefined;
  }

  const lanes = stores.map((store, index) => laneValue(store, first, index));

  if (lanes[0] === undefined) {
    return undefined;
  }

  const seed = unsigned(lanes[0] - laneOffsets[0]!);

  return lanes.every((lane, index) => lane === unsigned(seed + laneOffsets[index]!))
    ? { address, value: seed, stores }
    : undefined;
}

function byteStore(
  store: Store | undefined,
): store is Store & { value: { kind: "integer"; value: bigint } } {
  return (
    store !== undefined &&
    store.value?.kind === "integer" &&
    isStack(store.memory) &&
    store.memory.size === 1
  );
}

// The signer block starts with consecutive byte stores of the request path.
function isSignerStart(image: X64Elf, address: number, seed: Seed): boolean {
  const prefix = decodeX64(image.code(address, seed.address - address), address);

  if (prefix === undefined) {
    return false;
  }

  const stores = new Map(analyzeX64(prefix).stores.map((store) => [store.instruction, store]));
  const path: (Store & { value: { value: bigint } })[] = [];

  for (const instruction of significant(prefix)) {
    const store = stores.get(instruction);

    if (instruction.mnemonic !== Mnemonic.Mov || !byteStore(store)) {
      break;
    }

    path.push(store);
  }

  const first = path[0]?.memory;

  return (
    first !== undefined &&
    path.length === requestPath.length &&
    path.every(
      ({ memory, value }, index) =>
        memory.base === first.base &&
        memory.displacement === first.displacement + index &&
        value.value === BigInt(requestPath[index]!),
    )
  );
}

function signerStarts(image: X64Elf, seed: Seed): number[] {
  const lower = Math.max(image.text.address, seed.address - limits.signerLookback);
  const bytes = image.code(lower, seed.address - lower);
  const starts: number[] = [];

  // 0xc6 is MOV r/m8, imm8.
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0xc6 && isSignerStart(image, lower + index, seed)) {
      starts.push(lower + index);
    }
  }

  return starts;
}

function findSeed(image: X64Elf): { seed: Seed; start: number } {
  const text = image.code(image.text.address, image.text.fileSize);
  const candidates: { seed: Seed; start: number }[] = [];

  for (const index of seedCandidates(text)) {
    const seed = seedAt(image, image.text.address + index);

    if (seed !== undefined) {
      candidates.push(...signerStarts(image, seed).map((start) => ({ seed, start })));
    }
  }

  requireSupported(candidates.length === 1);

  return candidates[0]!;
}

// The signer block ends at the exit of its first conditional branch.
function signerBlock(image: X64Elf, seed: Seed, address: number): Instruction[] {
  const head = requireCode(
    decodeX64(
      image.code(address, limits.signerBytes),
      address,
      (instruction) => instruction.flow === FlowControl.ConditionalBranch,
    ),
  );

  const exit = head.at(-1)!.operands[0];

  requireSupported(
    exit?.kind === "branch" &&
      exit.address > seed.address &&
      exit.address - address <= limits.signerBytes,
  );

  const instructions = requireCode(decodeX64(image.code(address, exit.address - address), address));
  requireSupported(instructions.some((instruction) => instruction.address === seed.address));

  return instructions;
}

function functionBlock(image: X64Elf, address: number, kind: BlockKind): Instruction[] {
  const end = image.text.address + image.text.fileSize;

  const instructions = requireCode(
    decodeSignificant(
      image.code(address, Math.min(limits.functionBytes, end - address)),
      address,
      schemas[kind].instructions,
    ),
  );

  requireSupported(instructions.some((instruction) => instruction.flow === FlowControl.Return));
  checkSchema(image, instructions, kind);

  return instructions;
}

function integer(value: Value | undefined): number {
  requireSupported(value?.kind === "integer");
  const result = Number(value.value);
  requireSupported(Number.isSafeInteger(result) && result >= 0);

  return result;
}

function searchBytes(image: X64Elf, call: Call): Buffer {
  const source = call.arguments[2];
  const size = integer(call.arguments[3]);
  requireSupported(source !== undefined && size > 0 && size <= searchLimit);

  if (source.kind === "integer") {
    return Buffer.from(image.slice(integer(source), size));
  }

  requireSupported(source.kind === "stack");

  return Buffer.from(
    Array.from({ length: size }, (_, index) => {
      const byte = call.stack.get(stackKey(source.base, source.offset + index));
      requireSupported(byte !== undefined);

      return byte;
    }),
  );
}

function sameStack(values: readonly (Value | undefined)[]): boolean {
  const first = values[0];

  return (
    first?.kind === "stack" &&
    values.every(
      (value) =>
        value?.kind === "stack" && value.base === first.base && value.offset === first.offset,
    )
  );
}

type Callee = (typeof signerCallLayout)[number];

function callees(direct: readonly Call[]): Record<Callee, number> {
  const targets = new Map<Callee, number>();

  signerCallLayout.forEach((callee, index) => {
    const call = direct[index]!;
    requireSupported(call.instruction.flow === FlowControl.Call);
    const target = integer(call.target);
    requireSupported((targets.get(callee) ?? target) === target);
    targets.set(callee, target);
  });

  requireSupported(new Set(targets.values()).size === targets.size);

  return {
    helper: targets.get("helper")!,
    update: targets.get("update")!,
    digest: targets.get("digest")!,
  };
}

// Helper calls share one state argument; hash calls share the state seeded with the lanes.
function requireCallState(direct: readonly Call[], seed: Seed): void {
  const helper = direct.filter((_, index) => signerCallLayout[index] === "helper");
  const hash = direct.filter((_, index) => signerCallLayout[index] !== "helper");

  requireSupported(
    sameStack(helper.map((call) => call.arguments[0])) &&
      sameStack(hash.map((call) => call.arguments[0])),
  );

  const first = hash[0]!.arguments[0];
  const lane = seed.stores[0]!.memory;

  requireSupported(
    first?.kind === "stack" && first.base === lane.base && first.offset + 8 === lane.displacement,
  );
}

function signerCalls(image: X64Elf, instructions: readonly Instruction[], seed: Seed) {
  const { calls } = analyzeX64(instructions);
  const searches = calls.filter((call) => call.instruction.flow === FlowControl.IndirectCall);
  const direct = calls.filter((call) => call.instruction.flow === FlowControl.Call);

  requireSupported(
    searches.length === searchSources.length && direct.length === signerCallLayout.length,
  );

  const slot = searches[0]!.target;

  requireSupported(
    slot?.kind === "slot" &&
      image.contains(slot.address, 8) &&
      searches.every(
        (call, index) =>
          call.target?.kind === "slot" &&
          call.target.address === slot.address &&
          call.arguments[2]?.kind === searchSources[index],
      ),
  );

  requireCallState(direct, seed);
  const targets = callees(direct);
  functionBlock(image, targets.update, "update");
  functionBlock(image, targets.digest, "digest");

  return { searches, digest: direct.at(-1)!, slot: slot.address, helper: targets.helper };
}

// Returns how many bytes past the body marker the signer searches for the placeholder.
function windowLimit(
  instructions: readonly Instruction[],
  searches: readonly Call[],
  placeholder: Buffer,
) {
  const between = instructions.filter(
    (instruction) =>
      instruction.address > searches[1]!.instruction.address &&
      instruction.address < searches[2]!.instruction.address,
  );

  const candidates = between.filter(
    (instruction) =>
      instruction.mnemonic === Mnemonic.Lea &&
      instruction.operands[1]?.kind === "memory" &&
      !isStack(instruction.operands[1]) &&
      instruction.operands[1].index === Register.None &&
      instruction.operands[1].displacement >= placeholder.length,
  );

  requireSupported(candidates.length === 1);
  const instruction = candidates[0]!;
  const operand = instruction.operands[1];
  requireSupported(operand?.kind === "memory" && operand.displacement <= limits.window);

  return { window: operand.displacement, instruction };
}

function checksumLayout(instructions: readonly Instruction[], digest: Call, placeholder: Buffer) {
  const after = instructions.filter(
    (instruction) => instruction.address > digest.instruction.address,
  );

  const offset = after.find((instruction) => instruction.mnemonic === Mnemonic.Lea);
  const memory = offset?.operands[1];
  requireSupported(memory?.kind === "memory" && !isStack(memory) && memory.index === Register.None);

  const end = after.find(
    (instruction) =>
      instruction.mnemonic === Mnemonic.Add &&
      instruction.operands[0]?.kind === "register" &&
      instruction.operands[0].register === memory.base &&
      instruction.operands[1]?.kind === "immediate",
  );

  requireSupported(end?.operands[1]?.kind === "immediate");
  const checksumOffset = memory.displacement;
  const digits = Number(end.operands[1].value) - checksumOffset;

  requireSupported(
    checksumOffset > 0 &&
      digits === checksumDigits &&
      placeholder.length === checksumOffset + digits &&
      placeholder.subarray(checksumOffset).equals(Buffer.from("0".repeat(digits))),
  );

  return { checksumOffset, checksumDigits: digits };
}

// Immediate stores of the seed lanes and of stack byte strings such as the request path and
// placeholder.
function signerVariables(instructions: readonly Instruction[], seed: Seed): ReadonlySet<number> {
  const end = seed.stores.at(-1)!.instruction.next;

  return new Set(
    instructions.flatMap((instruction) => {
      const [destination, source] = instruction.operands;
      const lane = instruction.address >= seed.address && instruction.address < end;
      const byte = destination?.kind === "memory" && destination.size === 1 && isStack(destination);

      const variable =
        instruction.mnemonic === Mnemonic.Mov && source?.kind === "immediate" && (lane || byte);

      return variable ? [instruction.address] : [];
    }),
  );
}

function omissionMarkers(image: X64Elf, helper: number, slot: number): CliOmission[] {
  const searches = analyzeX64(functionBlock(image, helper, "helper")).calls.filter(
    (call) => call.instruction.flow === FlowControl.IndirectCall,
  );

  requireSupported(
    searches.length === omissionKinds.length &&
      searches.every((call) => call.target?.kind === "slot" && call.target.address === slot),
  );

  return searches.map((call, index) => ({
    kind: omissionKinds[index]!,
    marker: searchBytes(image, call),
  }));
}

export function extractElfCliSigner(bytes: Buffer): CliSignerConfig {
  const image = new X64Elf(bytes);
  const { seed, start } = findSeed(image);
  const block = signerBlock(image, seed, start);
  const targets = signerCalls(image, block, seed);

  const [path, bodyMarker, placeholder, modelMarker] = targets.searches.map((call) =>
    searchBytes(image, call),
  );

  requireSupported(path!.equals(requestPath));
  const window = windowLimit(block, targets.searches, placeholder!);
  checkSchema(image, block, "signer", signerVariables(block, seed), window.instruction);

  return {
    seed: seed.value,
    bodyMarker: bodyMarker!,
    modelMarker: modelMarker!,
    omissions: omissionMarkers(image, targets.helper, targets.slot),
    placeholder: placeholder!,
    window: window.window,
    ...checksumLayout(block, targets.digest, placeholder!),
  };
}

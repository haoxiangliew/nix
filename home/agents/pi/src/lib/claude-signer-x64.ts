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
    instructions: 227,
    digest: "4bd33c4721ec83b69c424bfe3d3bfde892f16310594d74bc7a781ca44f756c05",
  },
  helper: {
    instructions: 251,
    digest: "3108186ac03f7bb92ba5af41abd9495161551c626c8584304e53202448d65bf1",
  },
  update: {
    instructions: 116,
    digest: "abc69fcf94a5bf0ac02ab7e2fac5baaa1a6cdf30a3d3c0e5ae19362be6801832",
  },
  digest: {
    instructions: 113,
    digest: "c718ef01ba10dc92c27bbe24f40fa409f3a889264b5d7c2b31dc80239e129276",
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

function registerValue(
  register: Register,
  registers: ReadonlyMap<Register, Value>,
): Value | undefined {
  const value = registers.get(register) ?? registers.get(RegisterExt.fullRegister(register));

  if (value?.kind !== "integer") {
    return RegisterExt.size(register) === 8 ? value : undefined;
  }

  const high =
    !registers.has(register) &&
    [Register.AH, Register.BH, Register.CH, Register.DH].includes(register);

  return {
    kind: "integer",
    value: BigInt.asUintN(RegisterExt.size(register) * 8, value.value >> (high ? 8n : 0n)),
  };
}

function clearRegisters(registers: Map<Register, Value>, clobbered: readonly Register[]): void {
  for (const register of registers.keys()) {
    if (clobbered.includes(RegisterExt.fullRegister(register))) {
      registers.delete(register);
    }
  }
}

// Rewrite a store through a register that holds a stack address as a stack slot. Call this before
// the instruction overwrites the register.
function storeMemory(
  operand: Operand | undefined,
  registers: ReadonlyMap<Register, Value>,
): Memory | undefined {
  if (operand?.kind !== "memory") {
    return undefined;
  }

  const base = registers.get(operand.base);

  return operand.index === Register.None && base?.kind === "stack"
    ? { ...operand, base: base.base, displacement: base.offset + operand.displacement }
    : operand;
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
    return registerValue(operand.register, registers);
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

// Writes narrower than 32 bits set only that subregister. The upper bits stay unknown.
function writeRegister(
  registers: Map<Register, Value>,
  destination: Operand | undefined,
  value: Value | undefined,
): void {
  if (destination?.kind !== "register" || value === undefined) {
    return;
  }

  const size = RegisterExt.size(destination.register);

  if (size < 8 && value.kind !== "integer") {
    return;
  }

  registers.set(
    size < 4 ? destination.register : RegisterExt.fullRegister(destination.register),
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

      clearRegisters(registers, callerSaved);
      continue;
    }

    const value = resultValue(instruction, registers);
    const destination = instruction.operands[0];
    const memory = storeMemory(destination, registers);
    clearRegisters(registers, instruction.writes);
    writeRegister(registers, destination, value);

    if (memory !== undefined && instruction.memoryWrite) {
      stores.push({ instruction, memory, value });
      writeStack(stack, memory, value);
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
    private readonly exit?: number,
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

    // A target inside the decoded range must start a decoded instruction or be the signer's
    // shared exit, immediately after its path guard.
    requireSupported(
      address === this.exit || address < this.code[0]!.address || address >= this.code.at(-1)!.next,
    );

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

  const exit =
    kind === "signer"
      ? code.find((instruction) => instruction.flow === FlowControl.ConditionalBranch)?.next
      : undefined;

  const normalized = new InstructionSchema(image, code, variables, window, exit).normalize();
  const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");

  if (normalized.length !== schema.instructions || digest !== schema.digest) {
    throw new Error(
      `The installed Claude CLI build is unsupported (${kind} instruction schema). Request blocked.`,
    );
  }
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
    memory.index === Register.None &&
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

// The path uses low-byte registers for repeated characters. Decode only its construction
// and length guard, not the unrelated code after it.
function isSignerStart(image: X64Elf, address: number, seed: Seed): boolean {
  const prefix = decodeX64(
    image.code(address, seed.address - address),
    address,
    (instruction) => instruction.flow === FlowControl.ConditionalBranch,
  );

  if (prefix === undefined) {
    return false;
  }

  const path = analyzeX64(prefix).stores;
  const first = path[0]?.memory;

  return (
    first !== undefined &&
    path.length === requestPath.length &&
    path.every(
      (store, index) =>
        byteStore(store) &&
        store.memory.base === first.base &&
        store.memory.displacement === first.displacement + index &&
        store.value.value === BigInt(requestPath[index]!),
    )
  );
}

function signerStarts(image: X64Elf, seed: Seed): number[] {
  const lower = Math.max(image.text.address, seed.address - limits.signerLookback);
  const bytes = image.code(lower, seed.address - lower);
  const starts: number[] = [];

  // MOV AL, '/' starts the path construction. This only filters candidates;
  // isSignerStart checks every byte.
  for (let index = 0; index < bytes.length; index += 1) {
    if (
      bytes[index] === 0xb0 &&
      bytes[index + 1] === requestPath[0] &&
      isSignerStart(image, lower + index, seed)
    ) {
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

// The path guard jumps over unrelated code into the signer. Decode reachable instructions
// until the signer jumps to exit, the instruction after the guard. The schema checks every
// branch target.
function signerBlock(image: X64Elf, seed: Seed, address: number): Instruction[] {
  const head = requireCode(
    decodeX64(
      image.code(address, limits.signerBytes),
      address,
      (instruction) => instruction.flow === FlowControl.ConditionalBranch,
    ),
  );

  const guard = head.at(-1)!;
  const entry = guard.operands[0];
  requireSupported(
    entry?.kind === "branch" && entry.address > guard.next && entry.address < seed.address,
  );
  const body = reachableCode(image, entry.address, guard.next, seed);

  return [...head, ...body];
}

function successors(instruction: Instruction): number[] {
  if ([FlowControl.ConditionalBranch, FlowControl.UnconditionalBranch].includes(instruction.flow)) {
    const target = instruction.operands[0];
    requireSupported(target?.kind === "branch");

    return instruction.flow === FlowControl.UnconditionalBranch
      ? [target.address]
      : [target.address, instruction.next];
  }

  requireSupported(
    [FlowControl.Next, FlowControl.Call, FlowControl.IndirectCall].includes(instruction.flow),
  );

  return [instruction.next];
}

// Decodes in address order and stops after the first JMP to exit past the seed.
// The schema checks branch targets past that JMP, but they aren't decoded.
function reachableCode(image: X64Elf, entry: number, exit: number, seed: Seed): Instruction[] {
  const bound = Math.min(
    seed.address + limits.signerBytes,
    image.text.address + image.text.fileSize,
  );

  const pending = new Set([entry]);
  const decoded = new Map<number, Instruction>();
  let end: number | undefined;

  while (pending.size > 0) {
    const current = Math.min(...pending);
    pending.delete(current);

    if (current < entry || current >= (end ?? bound) || decoded.has(current)) {
      continue;
    }

    const [instruction] = requireCode(
      decodeX64(image.code(current, Math.min(15, bound - current)), current, () => true),
    );

    requireSupported(instruction !== undefined);
    requireSupported(decoded.size < 1024);
    decoded.set(current, instruction);
    const next = successors(instruction);
    next.forEach((address) => pending.add(address));

    if (
      instruction.flow === FlowControl.UnconditionalBranch &&
      next[0] === exit &&
      current > seed.address
    ) {
      end = instruction.next;
    }
  }

  const body = [...decoded.values()].toSorted((left, right) => left.address - right.address);
  requireSupported(end !== undefined);
  requireSupported(body.at(-1)?.next === end);
  requireSupported(decoded.has(seed.address));
  requireSupported(
    body.every((instruction, index) => index === 0 || body[index - 1]!.next <= instruction.address),
  );

  return body;
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
function requireCallState(direct: readonly Call[], seed: Seed, stores: readonly Store[]): void {
  const helper = direct.filter((_, index) => signerCallLayout[index] === "helper");
  const hash = direct.filter((_, index) => signerCallLayout[index] !== "helper");

  requireSupported(
    sameStack(helper.map((call) => call.arguments[0])) &&
      sameStack(hash.map((call) => call.arguments[0])),
  );

  const first = hash[0]!.arguments[0];

  const resolved = seed.stores.map((store) =>
    stores.find((candidate) => candidate.instruction.address === store.instruction.address),
  );

  const lane = resolved[0]?.memory;
  requireSupported(
    lane !== undefined &&
      isStack(lane) &&
      resolved.every(
        (store, index) =>
          store !== undefined &&
          laneValue(store, lane, index) === unsigned(seed.value + laneOffsets[index]!),
      ),
  );

  requireSupported(
    first?.kind === "stack" && first.base === lane.base && first.offset + 8 === lane.displacement,
  );
}

function signerCalls(image: X64Elf, instructions: readonly Instruction[], seed: Seed) {
  const { calls, stores } = analyzeX64(instructions);
  const indirect = calls.filter((call) => call.instruction.flow === FlowControl.IndirectCall);
  const direct = calls.filter((call) => call.instruction.flow === FlowControl.Call);

  requireSupported(
    indirect.length === searchSources.length + 1 && direct.length === signerCallLayout.length,
  );

  const searches = indirect.slice(0, searchSources.length);
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

  requireCallState(direct, seed, stores);
  const targets = callees(direct);
  functionBlock(image, targets.update, "update");
  functionBlock(image, targets.digest, "digest");

  return {
    searches,
    digest: direct.at(-1)!,
    slot: slot.address,
    helper: targets.helper,
    quoteSlot: quoteSearchSlot(image, indirect.at(-1)!, slot.address),
  };
}

// The long-string path searches for a single closing quote through a distinct slot.
// The schema pins its surrounding bounds checks and short-string scalar loop.
function quoteSearchSlot(image: X64Elf, call: Call, searchSlot: number): number {
  requireSupported(
    call.target?.kind === "slot" &&
      call.target.address !== searchSlot &&
      image.contains(call.target.address, 8) &&
      call.arguments[2]?.kind === "integer" &&
      call.arguments[2].value === 0x22n,
  );

  return call.target.address;
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

function byteDestination(operand: Operand | undefined): boolean {
  return (
    (operand?.kind === "memory" && operand.size === 1 && isStack(operand)) ||
    (operand?.kind === "register" && RegisterExt.size(operand.register) === 1)
  );
}

// The schema masks immediate MOVs that store the seed lanes or build the stack strings before the
// seed. It keeps later byte constants. For example, AL=1 is the model-found flag.
function signerVariables(instructions: readonly Instruction[], seed: Seed): ReadonlySet<number> {
  const end = seed.stores.at(-1)!.instruction.next;

  return new Set(
    instructions.flatMap((instruction) => {
      const [destination, source] = instruction.operands;
      const lane = instruction.address >= seed.address && instruction.address < end;
      const byte = instruction.address < seed.address && byteDestination(destination);

      const variable =
        instruction.mnemonic === Mnemonic.Mov && source?.kind === "immediate" && (lane || byte);

      return variable ? [instruction.address] : [];
    }),
  );
}

function omissionMarkers(
  image: X64Elf,
  helper: number,
  slot: number,
  quoteSlot: number,
): CliOmission[] {
  const indirect = analyzeX64(functionBlock(image, helper, "helper")).calls.filter(
    (call) => call.instruction.flow === FlowControl.IndirectCall,
  );

  const searches = indirect.filter(
    (call) => call.target?.kind === "slot" && call.target.address === slot,
  );

  const quotes = indirect.filter((call) => !searches.includes(call));

  requireSupported(searches.length === omissionKinds.length && quotes.length === 1);
  requireSupported(quoteSearchSlot(image, quotes[0]!, slot) === quoteSlot);

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
    omissions: omissionMarkers(image, targets.helper, targets.slot, targets.quoteSlot),
    placeholder: placeholder!,
    window: window.window,
    ...checksumLayout(block, targets.digest, placeholder!),
  };
}

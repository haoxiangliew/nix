import {
  readAddress,
  requireRange,
  requireSupported,
  sliceSegment,
  type Segment,
} from "./binary.ts";

export interface ElfSegment extends Segment {
  readonly flags: number;
}

function readSegment(bytes: Buffer, cursor: number): ElfSegment {
  const segment = {
    flags: bytes.readUInt32LE(cursor + 4),
    offset: readAddress(bytes, cursor + 8),
    address: readAddress(bytes, cursor + 16),
    fileSize: readAddress(bytes, cursor + 32),
    size: readAddress(bytes, cursor + 40),
  };

  requireRange(bytes, segment.offset, segment.fileSize);
  requireSupported(segment.fileSize <= segment.size);
  requireSupported(Number.isSafeInteger(segment.address + segment.size));
  const alignment = readAddress(bytes, cursor + 48);

  if (alignment > 1) {
    requireSupported(2 ** Math.floor(Math.log2(alignment)) === alignment);
    requireSupported(segment.address % alignment === segment.offset % alignment);
  }

  return segment;
}

function requireDisjoint(segments: readonly ElfSegment[]): void {
  const ordered = segments.toSorted((left, right) => left.address - right.address);

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    requireSupported(previous.address + previous.size <= ordered[index]!.address);
  }
}

export class X64Elf {
  readonly text: ElfSegment;
  private readonly segments: ElfSegment[] = [];

  constructor(readonly bytes: Buffer) {
    requireRange(bytes, 0, 64);
    requireSupported(bytes.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])));
    requireSupported([0, 3].includes(bytes[7]!));
    requireSupported([2, 3].includes(bytes.readUInt16LE(16)));
    requireSupported(bytes.readUInt16LE(18) === 62 && bytes.readUInt32LE(20) === 1);
    requireSupported(bytes.readUInt16LE(52) === 64 && bytes.readUInt16LE(54) === 56);
    const offset = readAddress(bytes, 32);
    const count = bytes.readUInt16LE(56);
    requireSupported(count > 0 && count < 0xffff);
    requireRange(bytes, offset, count * 56);

    for (let index = 0; index < count; index += 1) {
      const cursor = offset + index * 56;

      if (bytes.readUInt32LE(cursor) === 1) {
        this.segments.push(readSegment(bytes, cursor));
      }
    }

    requireDisjoint(this.segments);
    const executable = this.segments.filter((segment) => (segment.flags & 1) !== 0);
    requireSupported(executable.length === 1 && executable[0]!.fileSize > 0);
    this.text = executable[0]!;
  }

  slice(address: number, size: number): Buffer {
    return sliceSegment(this.bytes, this.segments, address, size);
  }

  code(address: number, size: number): Buffer {
    requireSupported(address >= this.text.address);
    requireSupported(size >= 0 && size <= this.text.fileSize - (address - this.text.address));

    return this.slice(address, size);
  }
}

import {
  readAddress,
  requireRange,
  requireSupported,
  sliceSegment,
  type Segment,
} from "./binary.ts";

interface ElfSegment extends Segment {
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

interface SectionTable {
  offset: number;
  count: number;
  names: Buffer;
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

  private sectionTable(): SectionTable {
    const bytes = this.bytes;
    const offset = readAddress(bytes, 40);
    const count = bytes.readUInt16LE(60);
    const strings = bytes.readUInt16LE(62);
    requireSupported(bytes.readUInt16LE(58) === 64 && count > 0 && strings < count);
    requireRange(bytes, offset, count * 64);
    const header = offset + strings * 64;
    requireSupported(bytes.readUInt32LE(header + 4) === 3);
    const start = readAddress(bytes, header + 24);
    const length = readAddress(bytes, header + 32);
    requireRange(bytes, start, length);

    return { offset, count, names: bytes.subarray(start, start + length) };
  }

  section(sectionName: string): Buffer {
    const { offset, count, names } = this.sectionTable();
    const matches: number[] = [];

    for (let index = 0; index < count; index += 1) {
      const header = offset + index * 64;
      const start = this.bytes.readUInt32LE(header);
      const end = names.indexOf(0, start);
      requireSupported(start < names.length && end !== -1);

      if (names.subarray(start, end).toString("latin1") === sectionName) {
        matches.push(header);
      }
    }

    requireSupported(matches.length === 1);
    const selected = matches[0]!;
    requireSupported(this.bytes.readUInt32LE(selected + 4) === 1);
    const start = readAddress(this.bytes, selected + 24);
    const size = readAddress(this.bytes, selected + 32);
    const contents = this.slice(readAddress(this.bytes, selected + 16), size);
    requireSupported(contents.byteOffset - this.bytes.byteOffset === start);

    return contents;
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

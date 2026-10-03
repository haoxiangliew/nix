import {
  readAddress,
  requireRange,
  requireSupported,
  sliceSegment,
  type Segment,
} from "./binary.ts";

export interface MachSection {
  address: number;
  offset: number;
  size: number;
}

function requireSection(segment: Segment, section: MachSection): void {
  const fileDelta = section.offset - segment.offset;
  const virtualDelta = section.address - segment.address;

  requireSupported(
    fileDelta >= 0 &&
      virtualDelta === fileDelta &&
      section.size <= segment.fileSize - fileDelta &&
      section.size <= segment.size - virtualDelta,
  );
}

function name(bytes: Buffer, offset: number): string {
  return (
    bytes
      .subarray(offset, offset + 16)
      .toString("ascii")
      .split("\0", 1)[0] ?? ""
  );
}

export class Arm64MachO {
  readonly text: MachSection;
  private readonly segments: Segment[] = [];

  constructor(readonly bytes: Buffer) {
    requireRange(bytes, 0, 32);
    requireSupported(bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c);
    const count = bytes.readUInt32LE(16);
    const end = 32 + bytes.readUInt32LE(20);
    requireRange(bytes, 32, end - 32);
    const sections: MachSection[] = [];
    let cursor = 32;

    for (let i = 0; i < count; i += 1) {
      requireRange(bytes, cursor, 8);
      const size = bytes.readUInt32LE(cursor + 4);
      requireSupported(size >= 8 && cursor + size <= end);

      if (bytes.readUInt32LE(cursor) === 0x19) {
        this.readSegment(cursor, size, sections);
      }

      cursor += size;
    }

    requireSupported(cursor === end && sections.length === 1);
    this.text = sections[0]!;
    requireSupported(this.text.address % 4 === 0 && this.text.size % 4 === 0);
  }

  private readSegment(cursor: number, size: number, sections: MachSection[]): void {
    requireSupported(size >= 72);
    const bytes = this.bytes;

    const segment = {
      address: readAddress(bytes, cursor + 24),
      size: readAddress(bytes, cursor + 32),
      offset: readAddress(bytes, cursor + 40),
      fileSize: readAddress(bytes, cursor + 48),
    };

    requireRange(bytes, segment.offset, segment.fileSize);
    requireSupported(segment.fileSize <= segment.size);
    requireSupported(Number.isSafeInteger(segment.address + segment.size));
    this.segments.push(segment);
    const count = bytes.readUInt32LE(cursor + 64);
    requireSupported(72 + count * 80 <= size);

    for (let i = 0; i < count; i += 1) {
      const section = cursor + 72 + i * 80;

      if (name(bytes, section) === "__text" && name(bytes, section + 16) === "__TEXT") {
        const text = {
          address: readAddress(bytes, section + 32),
          size: readAddress(bytes, section + 40),
          offset: bytes.readUInt32LE(section + 48),
        };

        requireRange(bytes, text.offset, text.size);
        requireSection(segment, text);
        sections.push(text);
      }
    }
  }

  slice(address: number, size: number): Buffer {
    return sliceSegment(this.bytes, this.segments, address, size);
  }

  words(address: number, count: number): number[] {
    requireSupported(
      address % 4 === 0 &&
        address >= this.text.address &&
        count * 4 <= this.text.size - (address - this.text.address),
    );

    const bytes = this.slice(address, count * 4);

    return Array.from({ length: count }, (_, index) => bytes.readUInt32LE(index * 4));
  }
}

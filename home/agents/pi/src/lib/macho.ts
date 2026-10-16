import {
  readAddress,
  requireRange,
  requireSupported,
  sliceSegment,
  type Segment,
} from "./binary.ts";

interface MachSection {
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
      .toString("latin1")
      .split("\0", 1)[0] ?? ""
  );
}

interface NamedSection extends MachSection {
  segment: Segment;
  segmentName: string;
  name: string;
}

export class Arm64MachO {
  readonly text: MachSection;
  private readonly segments: Segment[] = [];
  private readonly sections: NamedSection[] = [];

  constructor(readonly bytes: Buffer) {
    requireRange(bytes, 0, 32);
    requireSupported(bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c);
    const count = bytes.readUInt32LE(16);
    const end = 32 + bytes.readUInt32LE(20);
    requireRange(bytes, 32, end - 32);
    let cursor = 32;

    for (let i = 0; i < count; i += 1) {
      requireRange(bytes, cursor, 8);
      const size = bytes.readUInt32LE(cursor + 4);
      requireSupported(size >= 8 && cursor + size <= end);

      if (bytes.readUInt32LE(cursor) === 0x19) {
        this.readSegment(cursor, size);
      }

      cursor += size;
    }

    requireSupported(cursor === end);
    this.text = this.find("__TEXT", "__text");
    requireSupported(this.text.address % 4 === 0 && this.text.size % 4 === 0);
  }

  private readSegment(cursor: number, size: number): void {
    requireSupported(size >= 72);
    const bytes = this.bytes;
    const segmentName = name(bytes, cursor + 8);

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

      if (name(bytes, section + 16) === segmentName) {
        this.sections.push({
          segment,
          segmentName,
          name: name(bytes, section),
          address: readAddress(bytes, section + 32),
          size: readAddress(bytes, section + 40),
          offset: bytes.readUInt32LE(section + 48),
        });
      }
    }
  }

  // Zero-fill sections have no file data, so check only the selected section.
  private find(segmentName: string, sectionName: string): MachSection {
    const matches = this.sections.filter(
      (section) => section.segmentName === segmentName && section.name === sectionName,
    );

    requireSupported(matches.length === 1);
    const selected = matches[0]!;
    requireRange(this.bytes, selected.offset, selected.size);
    requireSection(selected.segment, selected);

    return { address: selected.address, size: selected.size, offset: selected.offset };
  }

  section(segmentName: string, sectionName: string): Buffer {
    const selected = this.find(segmentName, sectionName);

    return this.bytes.subarray(selected.offset, selected.offset + selected.size);
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

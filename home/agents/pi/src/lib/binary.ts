export interface Segment {
  readonly address: number;
  readonly offset: number;
  readonly size: number;
  readonly fileSize: number;
}

export function requireSupported(condition: boolean): asserts condition {
  if (!condition) {
    throw new Error("The installed Claude CLI build is unsupported. Request blocked.");
  }
}

export function requireRange(bytes: Buffer, offset: number, size: number): void {
  requireSupported(Number.isSafeInteger(offset) && Number.isSafeInteger(size));
  requireSupported(offset >= 0 && size >= 0 && offset <= bytes.length - size);
}

export function readAddress(bytes: Buffer, offset: number): number {
  const value = Number(bytes.readBigUInt64LE(offset));
  requireSupported(Number.isSafeInteger(value));

  return value;
}

export function sliceSegment(
  bytes: Buffer,
  segments: readonly Segment[],
  address: number,
  size: number,
): Buffer {
  requireSupported(Number.isSafeInteger(address) && address >= 0);
  requireSupported(Number.isSafeInteger(size) && size >= 0);

  const matches = segments.filter(
    (segment) => address >= segment.address && address - segment.address <= segment.fileSize - size,
  );

  requireSupported(matches.length === 1);
  const offset = matches[0]!.offset + (address - matches[0]!.address);
  requireRange(bytes, offset, size);

  return bytes.subarray(offset, offset + size);
}

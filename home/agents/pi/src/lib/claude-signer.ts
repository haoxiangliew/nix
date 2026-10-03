import { requireSupported } from "./binary.ts";
import { extractArm64CliSigner } from "./claude-signer-arm64.ts";
import { extractElfCliSigner } from "./claude-signer-x64.ts";

export interface CliOmission {
  readonly kind: "array" | "string" | "number";
  readonly marker: Buffer;
}

export interface CliSignerConfig {
  readonly seed: bigint;
  readonly bodyMarker: Buffer;
  readonly modelMarker: Buffer;
  readonly omissions: readonly CliOmission[];
  readonly placeholder: Buffer;
  readonly window: number;
  readonly checksumOffset: number;
  readonly checksumDigits: number;
}

export function extractCliSigner(bytes: Buffer): CliSignerConfig {
  requireSupported(bytes.length >= 4);

  switch (bytes.readUInt32LE(0)) {
    case 0xfeedfacf:
      return extractArm64CliSigner(bytes);
    case 0x464c457f:
      return extractElfCliSigner(bytes);
    default:
      throw new Error("Unsupported Claude CLI executable format. Request blocked.");
  }
}

interface Span {
  start: number;
  end: number;
}

function arrayEnd(bytes: Buffer, start: number): number | null {
  let depth = 1;
  let quoted = false;

  for (let index = start; index < bytes.length; index += 1) {
    const byte = bytes[index];

    if (quoted) {
      if (byte === 0x5c) {
        index += 1;
      } else if (byte === 0x22) {
        quoted = false;
      }
    } else if (byte === 0x22) {
      quoted = true;
    } else if (byte === 0x5b) {
      depth += 1;
    } else if (byte === 0x5d) {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return null;
}

function withComma(bytes: Buffer, span: Span, cursor: number): Span {
  if (bytes[span.end] === 0x2c) {
    return { start: span.start, end: span.end + 1 };
  }

  return {
    start: span.start > cursor && bytes[span.start - 1] === 0x2c ? span.start - 1 : span.start,
    end: span.end,
  };
}

function digitEnd(bytes: Buffer, start: number): number {
  let end = start;

  while (end < bytes.length && bytes[end]! >= 0x30 && bytes[end]! <= 0x39) {
    end += 1;
  }

  return end;
}

interface RawSpan {
  start: number;
  end: number | null;
}

interface SpanCursor {
  span: RawSpan | null | undefined;
  find: (cursor: number) => RawSpan | null;
}

function nextSpan(source: SpanCursor, cursor: number): RawSpan | null {
  if (source.span === undefined || (source.span !== null && source.span.start < cursor)) {
    source.span = source.find(cursor);
  }

  return source.span;
}

function fieldSpan(bytes: Buffer, cursor: number, omission: CliOmission): RawSpan | null {
  let search = cursor;

  while (search < bytes.length) {
    const start = bytes.indexOf(omission.marker, search);

    if (start === -1) {
      return null;
    }

    const value = start + omission.marker.length;

    if (omission.kind === "number") {
      const end = digitEnd(bytes, value);

      if (end > value) {
        return { start, end };
      }

      search = value;
      continue;
    }

    const end = omission.kind === "array" ? arrayEnd(bytes, value) : bytes.indexOf(0x22, value) + 1;

    return { start, end: end === 0 ? null : end };
  }

  return null;
}

function nextField(bytes: Buffer, cursor: number, sources: readonly SpanCursor[]): Span | null {
  let first: Span | null = null;

  for (const source of sources) {
    const raw = nextSpan(source, cursor);

    if (raw === null || raw.end === null) {
      continue;
    }

    const span = withComma(bytes, { start: raw.start, end: raw.end }, cursor);

    if (first === null || span.start < first.start) {
      first = span;
    }
  }

  return first;
}

function modelSpan(bytes: Buffer, cursor: number, config: CliSignerConfig): RawSpan | null {
  const start = bytes.indexOf(config.modelMarker, cursor);

  if (start === -1) {
    return null;
  }

  const value = start + config.modelMarker.length;
  const end = bytes.indexOf(0x22, value);

  return { start, end: end === -1 ? null : end };
}

function preimage(bytes: Buffer, config: CliSignerConfig): Buffer {
  const parts: Buffer[] = [];

  const fields: SpanCursor[] = config.omissions.map((omission) => ({
    span: undefined,
    find: (cursor) => fieldSpan(bytes, cursor, omission),
  }));

  const models: SpanCursor = {
    span: undefined,
    find: (cursor) => modelSpan(bytes, cursor, config),
  };

  let cursor = 0;

  while (cursor < bytes.length) {
    const field = nextField(bytes, cursor, fields);
    const model = nextSpan(models, cursor);

    if (field !== null && (model === null || field.start <= model.start)) {
      requireSupported(field.start >= cursor && field.end > field.start);
      parts.push(bytes.subarray(cursor, field.start));
      cursor = field.end;
    } else if (model !== null && model.end !== null) {
      parts.push(bytes.subarray(cursor, model.start + config.modelMarker.length));
      cursor = model.end;
    } else {
      parts.push(bytes.subarray(cursor));
      break;
    }
  }

  return Buffer.concat(parts);
}

function placeholderPosition(bytes: Buffer, config: CliSignerConfig): number {
  const prefix = bytes.indexOf(config.bodyMarker);
  requireSupported(prefix !== -1);
  const limit = Math.min(bytes.length, prefix + config.window);
  const position = bytes.subarray(prefix, limit).indexOf(config.placeholder);
  requireSupported(position !== -1);

  return prefix + position;
}

function sign(bytes: Buffer, config: CliSignerConfig): void {
  const position = placeholderPosition(bytes, config);
  const hash = Bun.hash.xxHash64(preimage(bytes, config), config.seed);

  const checksum = (hash & ((1n << BigInt(config.checksumDigits * 4)) - 1n))
    .toString(16)
    .padStart(config.checksumDigits, "0");

  bytes.write(checksum, position + config.checksumOffset, config.checksumDigits, "ascii");
}

export function signCliBody(body: string, config: CliSignerConfig): string {
  const bytes = Buffer.from(body, "utf8");
  sign(bytes, config);

  return bytes.toString("utf8");
}

export function validateCliChecksum(body: string, config: CliSignerConfig): boolean {
  const signed = Buffer.from(body, "utf8");
  const bytes = Buffer.from(signed);
  const prefix = bytes.indexOf(config.bodyMarker);

  if (prefix === -1) {
    return false;
  }

  const marker = config.placeholder.subarray(0, config.checksumOffset);
  const limit = Math.min(bytes.length, prefix + config.window);
  const relative = bytes.subarray(prefix, limit).indexOf(marker);

  if (relative === -1 || prefix + relative + config.placeholder.length > limit) {
    return false;
  }

  config.placeholder.copy(bytes, prefix + relative);
  sign(bytes, config);

  return bytes.equals(signed);
}

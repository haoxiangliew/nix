// Values both signer extractors match against the Claude CLI binary.

export const omissionKinds = ["array", "string", "number"] as const;

export const requestPath = Buffer.from("/v1/messages");

// Largest search needle, in bytes.
export const searchLimit = 512;

const prime1 = 0x9e3779b185ebca87n;
const prime2 = 0xc2b2ae3d27d4eb4fn;

export function unsigned(value: bigint): bigint {
  return BigInt.asUintN(64, value);
}

// XXH64 initial state lanes, as offsets from the seed.
export const laneOffsets: readonly bigint[] = [
  unsigned(prime1 + prime2),
  prime2,
  0n,
  unsigned(-prime1),
];

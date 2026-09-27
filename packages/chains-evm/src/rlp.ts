import { concatBytes } from '@noble/hashes/utils.js';

/**
 * Minimal RLP (Recursive Length Prefix) encoder, the serialization format
 * of Ethereum transactions. Only encoding is needed — the wallet never
 * parses untrusted RLP. Rules (Ethereum Yellow Paper, appendix B):
 *  - a single byte < 0x80 encodes as itself
 *  - a byte string of length <= 55 encodes as (0x80 + length) || bytes
 *  - a longer byte string as (0xb7 + lenOfLen) || length || bytes
 *  - a list's payload is the concatenation of its encoded items, prefixed
 *    with (0xc0 + length) or (0xf7 + lenOfLen) || length
 * Cross-checked against ethers.js in tests.
 */

export type RlpInput = Uint8Array | RlpInput[];

export function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0]! < 0x80) return input;
    return concatBytes(encodeLength(input.length, 0x80), input);
  }
  const payload = concatBytes(...input.map(rlpEncode));
  return concatBytes(encodeLength(payload.length, 0xc0), payload);
}

function encodeLength(length: number, offset: number): Uint8Array {
  if (length <= 55) return new Uint8Array([offset + length]);
  const lengthBytes = minimalBytes(BigInt(length));
  return concatBytes(new Uint8Array([offset + 55 + lengthBytes.length]), lengthBytes);
}

/** Big-endian integer with no leading zeros; zero is the empty string. */
export function minimalBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('RLP integers must be non-negative');
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

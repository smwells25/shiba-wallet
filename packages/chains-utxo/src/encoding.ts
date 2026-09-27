import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';

/**
 * Byte-level helpers for Bitcoin's wire format. These are serialization
 * conveniences only; all cryptography comes from @noble packages.
 */

export { bytesToHex, concatBytes, hexToBytes };

/** Serializes a number as a 4-byte little-endian unsigned integer. */
export function u32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`u32le: value out of range: ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/** Serializes a satoshi amount as an 8-byte little-endian unsigned integer. */
export function u64le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64le: value out of range: ${value}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/**
 * Bitcoin's variable-length integer ("CompactSize"): counts below 0xfd are a
 * single byte; larger counts get a 1-byte marker followed by a 2-, 4-, or
 * 8-byte little-endian value.
 */
export function varInt(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`varInt: value out of range: ${value}`);
  }
  if (value < 0xfd) return new Uint8Array([value]);
  if (value <= 0xffff) {
    return concatBytes(new Uint8Array([0xfd]), new Uint8Array([value & 0xff, value >> 8]));
  }
  if (value <= 0xffffffff) return concatBytes(new Uint8Array([0xfe]), u32le(value));
  return concatBytes(new Uint8Array([0xff]), u64le(BigInt(value)));
}

/** Byte length the CompactSize encoding of a count occupies. */
export function varIntSize(value: number): number {
  if (value < 0xfd) return 1;
  if (value <= 0xffff) return 3;
  if (value <= 0xffffffff) return 5;
  return 9;
}

/** Returns a reversed copy (Bitcoin displays txids byte-reversed). */
export function reverseBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes).reverse();
}

/**
 * Converts a display-order (big-endian) txid hex string into the
 * little-endian 32 bytes used inside the transaction wire format.
 */
export function txidToBytes(txid: string): Uint8Array {
  const bytes = hexToBytes(txid);
  if (bytes.length !== 32) {
    throw new Error(`txid must be 32 bytes of hex, got ${bytes.length}`);
  }
  return reverseBytes(bytes);
}

/**
 * Byte-level encoding helpers for the Solana legacy transaction wire format.
 *
 * Everything in this file is pure and offline. The format facts are taken
 * from the official transaction structure reference,
 * https://solana.com/docs/core/transactions/transaction-structure (fetched
 * 2026-09-27), which states that "all variable-length arrays (signatures,
 * account keys, instructions) are prefixed with a compact-u16 length
 * encoding" and that the encoding "uses 1 byte for values 0-127 and 2-3
 * bytes for larger values".
 */

/**
 * Encodes a length as a compact-u16 ("shortvec") value.
 *
 * The scheme is a little-endian base-128 varint capped at three bytes:
 * each byte carries seven data bits in its low bits, least significant
 * group first, and the high bit is a continuation flag that says another
 * byte follows. This matches the reference implementation in
 * @solana/web3.js 1.x (src/utils/shortvec-encoding.ts, function
 * encodeLength), which shifts the remaining value right by seven bits per
 * byte and sets 0x80 on every byte except the last.
 *
 * Examples: 0 -> [0x00], 127 -> [0x7f], 128 -> [0x80, 0x01],
 * 16383 -> [0xff, 0x7f], 16384 -> [0x80, 0x80, 0x01].
 */
export function encodeShortU16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`compact-u16 value out of range: ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value;
  for (;;) {
    const sevenBits = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      // Last group: continuation bit stays clear.
      bytes.push(sevenBits);
      break;
    }
    // More groups follow: set the continuation bit.
    bytes.push(sevenBits | 0x80);
  }
  return Uint8Array.from(bytes);
}

/**
 * Decodes a compact-u16 value starting at `offset`. Returns the value and
 * the number of bytes consumed. Used by tests to round-trip the encoder and
 * by any future transaction parsing.
 */
export function decodeShortU16(
  bytes: Uint8Array,
  offset = 0,
): { value: number; bytesRead: number } {
  let value = 0;
  let bytesRead = 0;
  for (;;) {
    const byte = bytes[offset + bytesRead];
    if (byte === undefined) {
      throw new Error('compact-u16 ran past end of buffer');
    }
    // Add this byte's seven data bits at the correct position.
    value |= (byte & 0x7f) << (7 * bytesRead);
    bytesRead += 1;
    if ((byte & 0x80) === 0) break;
    if (bytesRead === 3) {
      throw new Error('compact-u16 is at most three bytes');
    }
  }
  if (value > 0xffff) {
    throw new Error(`decoded compact-u16 exceeds u16 range: ${value}`);
  }
  return { value, bytesRead };
}

/** Encodes a u32 as four little-endian bytes. */
export function u32ToLeBytes(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`u32 value out of range: ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/** Encodes a u64 as eight little-endian bytes. Lamport amounts are u64. */
export function u64ToLeBytes(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64 value out of range: ${value}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** Concatenates byte arrays into one. */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** Constant-free byte equality check for 32-byte public keys and the like. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

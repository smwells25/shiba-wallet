import { describe, expect, it } from 'vitest';
import { decodeShortU16, encodeShortU16 } from '../src/encoding.js';

/**
 * Edge cases for compact-u16 ("shortvec") length encoding. Expected bytes
 * follow from the documented scheme (seven data bits per byte, least
 * significant group first, high bit as continuation flag; see
 * solana.com/docs/core/transactions/transaction-structure and the
 * encodeLength implementation in @solana/web3.js 1.x): the boundaries sit
 * at 127/128 (one to two bytes) and 16383/16384 (two to three bytes).
 */
const cases: Array<[number, number[]]> = [
  [0, [0x00]],
  [127, [0x7f]],
  [128, [0x80, 0x01]],
  [16383, [0xff, 0x7f]],
  [16384, [0x80, 0x80, 0x01]],
];

describe('encodeShortU16', () => {
  it.each(cases)('encodes %d to the spec bytes', (value, expected) => {
    expect([...encodeShortU16(value)]).toEqual(expected);
  });

  it('round-trips every edge case through the decoder', () => {
    for (const [value, expected] of cases) {
      const decoded = decodeShortU16(encodeShortU16(value));
      expect(decoded.value).toBe(value);
      expect(decoded.bytesRead).toBe(expected.length);
    }
  });

  it('encodes the u16 maximum in three bytes', () => {
    expect([...encodeShortU16(0xffff)]).toEqual([0xff, 0xff, 0x03]);
    expect(decodeShortU16(encodeShortU16(0xffff)).value).toBe(0xffff);
  });

  it('rejects negatives, fractions, and values beyond u16', () => {
    expect(() => encodeShortU16(-1)).toThrow(/out of range/);
    expect(() => encodeShortU16(1.5)).toThrow(/out of range/);
    expect(() => encodeShortU16(0x10000)).toThrow(/out of range/);
  });
});

describe('decodeShortU16', () => {
  it('reports bytes consumed so callers can advance a cursor', () => {
    // 0x80 0x01 is 128, followed by unrelated trailing bytes.
    const decoded = decodeShortU16(Uint8Array.from([0x80, 0x01, 0xaa]), 0);
    expect(decoded).toEqual({ value: 128, bytesRead: 2 });
  });

  it('throws on a truncated buffer', () => {
    expect(() => decodeShortU16(Uint8Array.from([0x80]))).toThrow(/end of buffer/);
  });
});

import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/** Hex helpers shared across the EVM adapter. All hex is 0x-prefixed. */

export function toBytes(hex: string): Uint8Array {
  if (!hex.startsWith('0x')) throw new Error(`Expected 0x-prefixed hex, got: ${hex}`);
  return hexToBytes(hex.slice(2));
}

export function toHex(bytes: Uint8Array): string {
  return '0x' + bytesToHex(bytes);
}

export function bigintToHex(value: bigint): string {
  if (value < 0n) throw new Error('Negative values cannot be hex-encoded');
  return '0x' + value.toString(16);
}

/** Left-pads a value to one 32-byte ABI word. */
export function toWord(value: bigint | Uint8Array): Uint8Array {
  const word = new Uint8Array(32);
  if (typeof value === 'bigint') {
    if (value < 0n || value >= 1n << 256n) throw new Error('Value out of uint256 range');
    let v = value;
    for (let i = 31; i >= 0 && v > 0n; i--) {
      word[i] = Number(v & 0xffn);
      v >>= 8n;
    }
  } else {
    if (value.length > 32) throw new Error('Byte value longer than one word');
    word.set(value, 32 - value.length);
  }
  return word;
}

/** Packs two uint128 values into one bytes32 (high 128 bits, low 128 bits). */
export function packUint128Pair(high: bigint, low: bigint): Uint8Array {
  const max = 1n << 128n;
  if (high < 0n || high >= max || low < 0n || low >= max) {
    throw new Error('Value out of uint128 range');
  }
  return toWord((high << 128n) | low);
}

/**
 * abi.encode for a sequence of static (word-sized) values only. Sufficient
 * for the ERC-4337 hash preimages, which pre-hash all dynamic bytes fields.
 */
export function abiEncodeWords(words: Uint8Array[]): Uint8Array {
  return concatBytes(...words);
}

export function keccak(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes);
}

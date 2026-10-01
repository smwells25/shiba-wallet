import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { toBytes, toWord } from './encoding.js';

/**
 * Minimal Solidity ABI encoder covering the value shapes the wallet needs
 * (function calls on accounts and factories): address, uint256, bytesN
 * (fixed-size, 1 to 32 bytes), bytes, tuples, and dynamic arrays of those.
 * Follows the standard head/tail encoding: static values inline, dynamic
 * values as offsets into a tail region relative to the start of the current
 * sequence. Cross-checked against ethers.js in tests. Intentionally not a
 * general-purpose encoder — extend it only when a new call shape is
 * actually needed. (bytesN and tuples were added for Kernel v3: its
 * initialize() takes a bytes21 validation id and its ERC-7579 batch
 * execution data is an abi-encoded Execution[] tuple array.)
 */

export type AbiValue =
  | { kind: 'address'; value: string }
  | { kind: 'uint256'; value: bigint }
  /** bytesN for N in 1..32: left-aligned in its word, zero-padded on the right. */
  | { kind: 'fixedBytes'; value: Uint8Array }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'tuple'; items: AbiValue[] }
  | { kind: 'array'; items: AbiValue[] };

function isDynamic(value: AbiValue): boolean {
  if (value.kind === 'bytes' || value.kind === 'array') return true;
  if (value.kind === 'tuple') return value.items.some(isDynamic);
  return false;
}

/** Size in bytes a static value occupies in the head of its sequence. */
function staticSize(value: AbiValue): number {
  if (value.kind === 'tuple') return value.items.reduce((sum, item) => sum + staticSize(item), 0);
  return 32;
}

function encodeStatic(value: AbiValue): Uint8Array {
  switch (value.kind) {
    case 'address':
      return toWord(toBytes(value.value));
    case 'uint256':
      return toWord(value.value);
    case 'fixedBytes': {
      if (value.value.length < 1 || value.value.length > 32) {
        throw new Error(`bytesN must be 1 to 32 bytes, got ${value.value.length}`);
      }
      const word = new Uint8Array(32);
      word.set(value.value, 0);
      return word;
    }
    case 'tuple':
      // A tuple with only static members is encoded inline.
      return encodeSequence(value.items);
    default:
      throw new Error(`${value.kind} is not a static type`);
  }
}

function encodeDynamic(value: AbiValue): Uint8Array {
  if (value.kind === 'bytes') {
    const padded = new Uint8Array(Math.ceil(value.value.length / 32) * 32);
    padded.set(value.value);
    return concatBytes(toWord(BigInt(value.value.length)), padded);
  }
  if (value.kind === 'array') {
    return concatBytes(toWord(BigInt(value.items.length)), encodeSequence(value.items));
  }
  if (value.kind === 'tuple') {
    // A tuple with any dynamic member is itself dynamic: its encoding lives
    // in the tail and is the head/tail encoding of its members.
    return encodeSequence(value.items);
  }
  throw new Error(`${value.kind} is not a dynamic type`);
}

/** Encodes a parameter list (or array element / tuple member list) with head/tail layout. */
export function encodeSequence(values: AbiValue[]): Uint8Array {
  const headSize = values.reduce(
    (sum, value) => sum + (isDynamic(value) ? 32 : staticSize(value)),
    0,
  );
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailOffset = headSize;
  for (const value of values) {
    if (isDynamic(value)) {
      heads.push(toWord(BigInt(tailOffset)));
      const tail = encodeDynamic(value);
      tails.push(tail);
      tailOffset += tail.length;
    } else {
      heads.push(encodeStatic(value));
    }
  }
  return concatBytes(...heads, ...tails);
}

/** 4-byte selector: first bytes of keccak256 of the canonical signature. */
export function selector(signature: string): Uint8Array {
  return keccak_256(utf8ToBytes(signature)).slice(0, 4);
}

export function encodeFunctionCall(signature: string, args: AbiValue[]): Uint8Array {
  return concatBytes(selector(signature), encodeSequence(args));
}

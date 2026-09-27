import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { toBytes, toWord } from './encoding.js';

/**
 * Minimal Solidity ABI encoder covering the value shapes the wallet needs
 * (function calls on accounts and factories): address, uint256, bytes, and
 * dynamic arrays of those. Follows the standard head/tail encoding: static
 * values inline, dynamic values as offsets into a tail region relative to
 * the start of the current sequence. Cross-checked against ethers.js in
 * tests. Intentionally not a general-purpose encoder — extend it only when
 * a new call shape is actually needed.
 */

export type AbiValue =
  | { kind: 'address'; value: string }
  | { kind: 'uint256'; value: bigint }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'array'; items: AbiValue[] };

function isDynamic(value: AbiValue): boolean {
  return value.kind === 'bytes' || value.kind === 'array';
}

function encodeStatic(value: AbiValue): Uint8Array {
  switch (value.kind) {
    case 'address':
      return toWord(toBytes(value.value));
    case 'uint256':
      return toWord(value.value);
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
  throw new Error(`${value.kind} is not a dynamic type`);
}

/** Encodes a parameter list (or array element list) with head/tail layout. */
export function encodeSequence(values: AbiValue[]): Uint8Array {
  const headSize = values.length * 32;
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

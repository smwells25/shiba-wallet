import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * SLIP-0010 hierarchical derivation for ed25519 (used by Solana and other
 * ed25519 chains). @scure/bip32 only implements secp256k1, so the ed25519
 * branch is implemented here directly from the SLIP-0010 spec and validated
 * against the official SLIP-0010 test vectors in the test suite.
 *
 * ed25519 supports hardened derivation only; SLIP-0010 defines no normal
 * (non-hardened) child keys for this curve, so every index is forced hardened.
 */

const HARDENED_OFFSET = 0x80000000;
const ED25519_CURVE_KEY = utf8ToBytes('ed25519 seed');

export interface Slip10Node {
  privateKey: Uint8Array;
  chainCode: Uint8Array;
}

export function slip10MasterFromSeed(seed: Uint8Array): Slip10Node {
  const i = hmac(sha512, ED25519_CURVE_KEY, seed);
  return { privateKey: i.slice(0, 32), chainCode: i.slice(32) };
}

function ser32(index: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, index, false);
  return out;
}

export function slip10DeriveChild(node: Slip10Node, index: number): Slip10Node {
  const hardenedIndex = index >= HARDENED_OFFSET ? index : index + HARDENED_OFFSET;
  const data = concatBytes(new Uint8Array([0]), node.privateKey, ser32(hardenedIndex));
  const i = hmac(sha512, node.chainCode, data);
  return { privateKey: i.slice(0, 32), chainCode: i.slice(32) };
}

/**
 * Derives a path like "m/44'/501'/0'/0'". Indices without an apostrophe are
 * still derived hardened, per SLIP-0010's ed25519 rules.
 */
export function slip10DerivePath(seed: Uint8Array, path: string): Slip10Node {
  const segments = parsePath(path);
  let node = slip10MasterFromSeed(seed);
  for (const index of segments) {
    node = slip10DeriveChild(node, index);
  }
  return node;
}

function parsePath(path: string): number[] {
  const parts = path.split('/');
  if (parts[0] !== 'm') {
    throw new Error(`Derivation path must start with "m": ${path}`);
  }
  return parts.slice(1).map((part) => {
    const raw = part.endsWith("'") || part.endsWith('h') ? part.slice(0, -1) : part;
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
      throw new Error(`Invalid path segment "${part}" in ${path}`);
    }
    return index + HARDENED_OFFSET;
  });
}

import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes } from '@noble/hashes/utils.js';
import type { DerivedAccount } from '@shiba-wallet/core';
import { minimalBytes, rlpEncode, type RlpInput } from './rlp.js';
import { toBytes, toHex } from './encoding.js';

/**
 * EIP-1559 (type-2) transaction building and signing for plain EOA sends —
 * the path that needs no bundler and works on every EVM chain. Layout per
 * EIP-1559: the signing payload is
 *   keccak256(0x02 || rlp([chainId, nonce, maxPriorityFeePerGas,
 *     maxFeePerGas, gasLimit, to, value, data, accessList]))
 * and the wire form appends [yParity, r, s] to the same list. The owner
 * key's recoverable signature supplies yParity directly (recid 0/1).
 * Byte-identical output with ethers.js is asserted in tests.
 */

export interface AccessListEntry {
  address: string;
  storageKeys: string[];
}

export interface Eip1559Transaction {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  /** Recipient; omit only for contract deployment. */
  to?: string;
  value: bigint;
  data?: Uint8Array;
  accessList?: AccessListEntry[];
}

const TX_TYPE_2 = new Uint8Array([0x02]);

function baseFields(tx: Eip1559Transaction): RlpInput[] {
  return [
    minimalBytes(tx.chainId),
    minimalBytes(tx.nonce),
    minimalBytes(tx.maxPriorityFeePerGas),
    minimalBytes(tx.maxFeePerGas),
    minimalBytes(tx.gasLimit),
    tx.to ? toBytes(tx.to) : new Uint8Array(0),
    minimalBytes(tx.value),
    tx.data ?? new Uint8Array(0),
    (tx.accessList ?? []).map((entry) => [
      toBytes(entry.address),
      entry.storageKeys.map(toBytes),
    ]),
  ];
}

/**
 * The nine EIP-1559 payload fields as RLP input, in order. Exported for the
 * EIP-7702 set-code transaction (./eip7702.ts), whose payload starts with
 * exactly these fields and appends the authorization list.
 */
export function eip1559PayloadFields(tx: Eip1559Transaction): RlpInput[] {
  return baseFields(tx);
}

/** The digest the sender signs. */
export function eip1559SigningHash(tx: Eip1559Transaction): Uint8Array {
  return keccak_256(concatBytes(TX_TYPE_2, rlpEncode(baseFields(tx))));
}

export interface SignedEip1559 {
  /** Full wire bytes, ready for eth_sendRawTransaction (0x02 || rlp...). */
  raw: Uint8Array;
  rawHex: string;
  /** keccak256 of the wire bytes: the transaction hash. */
  txHash: string;
}

/**
 * Signs with a seed-derived account (r || s || recid from core) and returns
 * the broadcastable raw transaction.
 */
export function signEip1559(tx: Eip1559Transaction, account: DerivedAccount): SignedEip1559 {
  const signature = account.sign(eip1559SigningHash(tx));
  if (signature.length !== 65) {
    throw new Error(`Expected 65-byte recoverable signature, got ${signature.length}`);
  }
  const recid = signature[64]!;
  if (recid !== 0 && recid !== 1) {
    throw new Error(`Expected recovery id 0 or 1, got ${recid}`);
  }
  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);
  const fields = [
    ...baseFields(tx),
    // yParity: RLP-minimal, so 0 encodes as the empty string.
    recid === 0 ? new Uint8Array(0) : new Uint8Array([1]),
    stripLeadingZeros(r),
    stripLeadingZeros(s),
  ];
  const raw = concatBytes(TX_TYPE_2, rlpEncode(fields));
  return { raw, rawHex: toHex(raw), txHash: toHex(keccak_256(raw)) };
}

/** Strips leading zero bytes (RLP integers are minimal big-endian). */
export function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start++;
  return bytes.slice(start);
}

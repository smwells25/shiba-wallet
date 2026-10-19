import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress, type DerivedAccount } from '@shiba-wallet/core';
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

// ---------------------------------------------------------------------------
// A signature made elsewhere (cold signing, phase 22 item 3)
// ---------------------------------------------------------------------------
//
// An air-gapped signer returns only (yParity, r, s) for the payload digest
// eip1559SigningHash(tx). The two functions below let the watch-only half
// verify that signature against the transaction IT built and attach it,
// without ever holding a key. They are additions: signEip1559 above is
// unchanged. Layout per EIP-1559 (ethereum/EIPs EIPS/eip-1559.md): the
// signed transaction is
//   0x02 || rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas,
//     gas_limit, destination, amount, data, access_list, signature_y_parity,
//     signature_r, signature_s])
// with y_parity, r and s as RLP integers (minimal big-endian), exactly the
// three fields signEip1559 appends. Byte-identical output with ethers'
// Transaction.serialized is asserted in test/eoa-tx.test.ts.

/** A recoverable secp256k1 signature over eip1559SigningHash(tx). */
export interface Eip1559Signature {
  /** The recovery bit (0 or 1); EIP-1559 carries it as signature_y_parity. */
  yParity: 0 | 1;
  /** 32 bytes, big-endian. */
  r: Uint8Array;
  /** 32 bytes, big-endian; must be at most secp256k1n / 2 (EIP-2). */
  s: Uint8Array;
}

const SECP256K1_ORDER = secp256k1.Point.Fn.ORDER;
const SECP256K1_HALF_ORDER = SECP256K1_ORDER >> 1n;

function assertSignatureShape(signature: Eip1559Signature): void {
  if (signature.yParity !== 0 && signature.yParity !== 1) throw new Error('yParity must be 0 or 1');
  if (!(signature.r instanceof Uint8Array) || signature.r.length !== 32) throw new Error('r must be 32 bytes');
  if (!(signature.s instanceof Uint8Array) || signature.s.length !== 32) throw new Error('s must be 32 bytes');
  const r = BigInt(toHex(signature.r));
  const s = BigInt(toHex(signature.s));
  if (r === 0n || r >= SECP256K1_ORDER) throw new Error('r is outside the secp256k1 range');
  // EIP-2 (Homestead): a transaction whose s is above secp256k1n / 2 is
  // invalid, so a node would refuse it; refuse it here first.
  if (s === 0n || s > SECP256K1_HALF_ORDER) throw new Error('s is above secp256k1n/2 (EIP-2) or zero');
}

/**
 * The address that signed `tx` with `signature` (EIP-55), recovered over
 * eip1559SigningHash(tx) as a node does. Throws on a malformed or
 * high-s signature, or one that does not recover to a point.
 */
export function recoverEip1559Signer(tx: Eip1559Transaction, signature: Eip1559Signature): string {
  assertSignatureShape(signature);
  const recovered = new Uint8Array(65);
  recovered[0] = signature.yParity;
  recovered.set(signature.r, 1);
  recovered.set(signature.s, 33);
  const point = secp256k1.Signature.fromBytes(recovered, 'recovered').recoverPublicKey(eip1559SigningHash(tx));
  return toChecksumAddress(keccak_256(point.toBytes(false).subarray(1)).slice(12));
}

/**
 * The broadcastable raw transaction for `tx` with a signature made
 * elsewhere: the nine payload fields followed by yParity, r and s, the same
 * encoding signEip1559 produces. Checks the signature's shape (and EIP-2's
 * low s) but NOT who signed: callers compare recoverEip1559Signer with the
 * expected sender first.
 */
export function serializeSignedEip1559(tx: Eip1559Transaction, signature: Eip1559Signature): SignedEip1559 {
  assertSignatureShape(signature);
  const fields = [
    ...baseFields(tx),
    signature.yParity === 0 ? new Uint8Array(0) : new Uint8Array([1]),
    stripLeadingZeros(signature.r),
    stripLeadingZeros(signature.s),
  ];
  const raw = concatBytes(TX_TYPE_2, rlpEncode(fields));
  return { raw, rawHex: toHex(raw), txHash: toHex(keccak_256(raw)) };
}

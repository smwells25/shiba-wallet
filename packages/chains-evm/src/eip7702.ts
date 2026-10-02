import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress, type DerivedAccount } from '@shiba-wallet/core';
import { parseDelegationIndicator } from './contract-risk.js';
import { bigintToHex, keccak, toBytes, toHex } from './encoding.js';
import {
  eip1559PayloadFields,
  stripLeadingZeros,
  type Eip1559Transaction,
  type SignedEip1559,
} from './eoa-tx.js';
import { minimalBytes, rlpEncode, type RlpInput } from './rlp.js';
import type { JsonRpcTransport } from './rpc.js';

/**
 * EIP-7702 "Set Code for EOAs": authorization tuples, the set-code
 * (type 0x04) transaction, delegation-indicator reads, and revocation.
 *
 * Primary source: EIP-7702, status Final, ethereum/EIPs EIPS/eip-7702.md at
 * commit bbc3f95844c37612a2f1b9e7477990bb717ecfa0 (2025-10-07), fetched
 * 2026-10-01 (eips.ethereum.org/EIPS/eip-7702). Quoted facts:
 *
 *  - Parameters: SET_CODE_TX_TYPE = 0x04, MAGIC = 0x05,
 *    PER_AUTH_BASE_COST = 12500, PER_EMPTY_ACCOUNT_COST = 25000.
 *  - TransactionPayload = rlp([chain_id, nonce, max_priority_fee_per_gas,
 *    max_fee_per_gas, gas_limit, destination, value, data, access_list,
 *    authorization_list, signature_y_parity, signature_r, signature_s]) with
 *    authorization_list = [[chain_id, address, nonce, y_parity, r, s], ...].
 *    The outer fields follow EIP-4844 semantics, so "a null destination is
 *    not valid". The outer signature is over
 *    keccak256(SET_CODE_TX_TYPE || TransactionPayload) (the payload without
 *    the three signature fields, as for every typed transaction). "The
 *    transaction is considered invalid if the length of authorization_list
 *    is zero."
 *  - Tuple bounds: chain_id < 2**256, nonce < 2**64, len(address) == 20,
 *    y_parity < 2**8, r < 2**256, s < 2**256.
 *  - Per tuple: the chain id must be 0 or the current chain; nonce must be
 *    below 2**64 - 1; authority = ecrecover(msg, y_parity, r, s) with
 *    msg = keccak(MAGIC || rlp([chain_id, address, nonce])) and s <=
 *    secp256k1n/2 (EIP-2); the authority's code must be empty or already a
 *    delegation; the authority's nonce must EQUAL the tuple nonce; then the
 *    code becomes 0xef0100 || address and the authority's nonce increases
 *    by one. "If address is 0x0000000000000000000000000000000000000000, do
 *    not write the delegation indicator. Clear the account's code" — that is
 *    revocation.
 *  - "The authorization list is processed before the execution portion of
 *    the transaction begins, but after the sender's nonce is incremented."
 *    Consequence for a SELF-SPONSORED transaction (the authority is also the
 *    transaction sender): the tuple nonce must be the transaction nonce + 1.
 *    For a tuple carried by someone else's transaction (a relayer or a
 *    bundler), it is the authority's current nonce.
 *  - Failed tuples are skipped, not fatal; "if transaction execution results
 *    in failure ... the processed delegation indicators is not rolled back".
 *  - EXTCODESIZE of a delegated account returns 23, the size of
 *    0xef0100 || address (the indicator itself is what eth_getCode returns).
 *  - Security: chain_id 0 makes a tuple valid on every chain. This module
 *    refuses to sign chain_id 0 — the wallet only ever binds an
 *    authorization to one chain.
 */

export const EIP7702_SET_CODE_TX_TYPE = 0x04;
export const EIP7702_AUTH_MAGIC = 0x05;
/** Intrinsic gas charged per authorization tuple (EIP-7702 Gas Costs). */
export const EIP7702_PER_EMPTY_ACCOUNT_COST = 25_000n;
/** Refunded per tuple whose authority already existed (EIP-7702 Behavior step 7). */
export const EIP7702_PER_AUTH_BASE_COST = 12_500n;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const SECP256K1_N = secp256k1.Point.Fn.ORDER;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;
const TWO_POW_64 = 1n << 64n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The three signed fields of an authorization tuple. */
export interface Eip7702Authorization {
  /** Chain the delegation is valid on. 0 would mean every chain; refused when signing. */
  chainId: bigint;
  /** Delegate contract whose code the EOA will run; ZERO_ADDRESS revokes. */
  address: string;
  /** The authority's account nonce at the moment the tuple is processed. */
  nonce: bigint;
}

/** A signed tuple, [chain_id, address, nonce, y_parity, r, s]. */
export interface SignedEip7702Authorization extends Eip7702Authorization {
  yParity: 0 | 1;
  /** 32-byte big-endian r. */
  r: Uint8Array;
  /** 32-byte big-endian s (low-s, per EIP-2). */
  s: Uint8Array;
}

function checkAuthorizationFields(auth: Eip7702Authorization): void {
  if (!ADDRESS_RE.test(auth.address)) throw new Error(`Invalid delegate address: ${auth.address}`);
  if (auth.chainId < 0n || auth.chainId >= 1n << 256n) throw new Error('Authorization chain id out of range');
  // Processing requires nonce < 2**64 - 1 (Behavior step 2), which is stricter
  // than the validity bound nonce < 2**64.
  if (auth.nonce < 0n || auth.nonce >= TWO_POW_64 - 1n) {
    throw new Error('Authorization nonce out of range (must be below 2**64 - 1)');
  }
}

/** rlp([chain_id, address, nonce]) — the signed tuple body. */
function authorizationBody(auth: Eip7702Authorization): RlpInput[] {
  return [minimalBytes(auth.chainId), toBytes(auth.address), minimalBytes(auth.nonce)];
}

/** msg = keccak256(MAGIC || rlp([chain_id, address, nonce])), the digest the authority signs. */
export function eip7702AuthorizationDigest(auth: Eip7702Authorization): Uint8Array {
  checkAuthorizationFields(auth);
  return keccak_256(
    concatBytes(new Uint8Array([EIP7702_AUTH_MAGIC]), rlpEncode(authorizationBody(auth))),
  );
}

/**
 * Signs an authorization tuple with a seed-derived EOA. Refuses chain id 0
 * (a tuple valid on every chain) by design; the y-parity is the secp256k1
 * recovery id (0/1), and s is checked against secp256k1n/2.
 */
export function signEip7702Authorization(
  auth: Eip7702Authorization,
  account: DerivedAccount,
): SignedEip7702Authorization {
  if (auth.chainId === 0n) {
    throw new Error('Refusing to sign an EIP-7702 authorization for chain id 0 (valid on every chain)');
  }
  const signature = account.sign(eip7702AuthorizationDigest(auth));
  if (signature.length !== 65) throw new Error(`Expected a 65-byte signature, got ${signature.length}`);
  const recid = signature[64]!;
  if (recid !== 0 && recid !== 1) throw new Error(`Expected recovery id 0 or 1, got ${recid}`);
  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);
  if (BigInt(toHex(s)) > SECP256K1_HALF_N) throw new Error('Signer produced a high-s signature (EIP-2)');
  const signed: SignedEip7702Authorization = {
    chainId: auth.chainId,
    address: toChecksumAddress(toBytes(auth.address)),
    nonce: auth.nonce,
    yParity: recid as 0 | 1,
    r,
    s,
  };
  const authority = recoverEip7702Authority(signed);
  if (authority.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`Authorization recovers to ${authority}, not the signing account ${account.address}`);
  }
  return signed;
}

/** ecrecover over the tuple, as a node does in Behavior step 3. Throws on an invalid tuple. */
export function recoverEip7702Authority(auth: SignedEip7702Authorization): string {
  if (auth.r.length !== 32 || auth.s.length !== 32) throw new Error('r and s must be 32 bytes');
  if (auth.yParity !== 0 && auth.yParity !== 1) throw new Error('yParity must be 0 or 1');
  if (BigInt(toHex(auth.s)) > SECP256K1_HALF_N) throw new Error('s is above secp256k1n/2 (EIP-2)');
  const recovered = new Uint8Array(65);
  recovered[0] = auth.yParity;
  recovered.set(auth.r, 1);
  recovered.set(auth.s, 33);
  const point = secp256k1.Signature.fromBytes(recovered, 'recovered').recoverPublicKey(
    eip7702AuthorizationDigest(auth),
  );
  return toChecksumAddress(keccak(point.toBytes(false).subarray(1)).slice(12));
}

/**
 * The unsigned tuple that REVOKES a delegation: address = 0x00..00, which
 * EIP-7702 Behavior step 8 defines as "clear the account's code".
 * `nonce` follows the same rule as any tuple (txNonce + 1 when the EOA sends
 * the transaction itself — see selfSponsoredAuthorizationNonce).
 */
export function revokeDelegationAuthorization(chainId: bigint, nonce: bigint): Eip7702Authorization {
  return { chainId, address: ZERO_ADDRESS, nonce };
}

/**
 * Tuple nonce for a tuple whose authority also SENDS the transaction: the
 * sender's nonce is incremented before the authorization list is processed,
 * so the tuple must carry txNonce + 1 (EIP-7702 Behavior, first paragraph,
 * with step 6).
 */
export function selfSponsoredAuthorizationNonce(txNonce: bigint): bigint {
  return txNonce + 1n;
}

/**
 * Bundler JSON wire form of a signed tuple, the `eip7702Auth` member of a
 * UserOperation (ERC-4337 "Support for EIP-7702 authorizations"; ERC-7769
 * eth_sendUserOperation example). Field names and encodings:
 *  - Alchemy's eth_sendUserOperation schema (www.alchemy.com/docs/wallets/
 *    api-reference/bundler-api/bundler-api-endpoints/eth-send-user-operation,
 *    fetched 2026-10-01): required chainId, nonce, address, yParity, r, s,
 *    all 0x-hex strings;
 *  - viem 2.57.2 account-abstraction/utils/formatters/userOperationRequest.ts
 *    (the formatter the ZeroDev SDK goes through): chainId and nonce as
 *    minimal hex quantities, r and s padded to 32 bytes, yParity padded to
 *    one byte ("0x00"/"0x01").
 * This mirrors viem byte for byte.
 */
export interface RpcEip7702Auth {
  chainId: string;
  address: string;
  nonce: string;
  yParity: string;
  r: string;
  s: string;
}

export function toRpcEip7702Auth(auth: SignedEip7702Authorization): RpcEip7702Auth {
  return {
    address: auth.address,
    chainId: bigintToHex(auth.chainId),
    nonce: bigintToHex(auth.nonce),
    r: toHex(auth.r),
    s: toHex(auth.s),
    yParity: auth.yParity === 0 ? '0x00' : '0x01',
  };
}

// ---------------------------------------------------------------------------
// Set-code (type 0x04) transaction
// ---------------------------------------------------------------------------

/** An EIP-1559-shaped transaction plus a NON-EMPTY authorization list. `to` is mandatory. */
export interface Eip7702Transaction extends Eip1559Transaction {
  to: string;
  authorizationList: SignedEip7702Authorization[];
}

function setCodePayloadFields(tx: Eip7702Transaction): RlpInput[] {
  if (!tx.to) throw new Error('A set-code transaction needs a destination (EIP-7702: null destination is invalid)');
  if (tx.authorizationList.length === 0) {
    throw new Error('A set-code transaction needs at least one authorization (EIP-7702)');
  }
  return [
    ...eip1559PayloadFields(tx),
    tx.authorizationList.map((auth) => {
      checkAuthorizationFields(auth);
      if (auth.r.length !== 32 || auth.s.length !== 32) throw new Error('r and s must be 32 bytes');
      return [
        ...authorizationBody(auth),
        minimalBytes(BigInt(auth.yParity)),
        stripLeadingZeros(auth.r),
        stripLeadingZeros(auth.s),
      ];
    }),
  ];
}

/** keccak256(0x04 || rlp(payload without signature)), the digest the sender signs. */
export function eip7702SigningHash(tx: Eip7702Transaction): Uint8Array {
  return keccak_256(
    concatBytes(new Uint8Array([EIP7702_SET_CODE_TX_TYPE]), rlpEncode(setCodePayloadFields(tx))),
  );
}

/** Signs a set-code transaction; the result is ready for eth_sendRawTransaction. */
export function signEip7702Transaction(tx: Eip7702Transaction, account: DerivedAccount): SignedEip1559 {
  const fields = setCodePayloadFields(tx);
  const signature = account.sign(
    keccak_256(concatBytes(new Uint8Array([EIP7702_SET_CODE_TX_TYPE]), rlpEncode(fields))),
  );
  if (signature.length !== 65) throw new Error(`Expected a 65-byte signature, got ${signature.length}`);
  const recid = signature[64]!;
  if (recid !== 0 && recid !== 1) throw new Error(`Expected recovery id 0 or 1, got ${recid}`);
  const raw = concatBytes(
    new Uint8Array([EIP7702_SET_CODE_TX_TYPE]),
    rlpEncode([
      ...fields,
      minimalBytes(BigInt(recid)),
      stripLeadingZeros(signature.slice(0, 32)),
      stripLeadingZeros(signature.slice(32, 64)),
    ]),
  );
  return { raw, rawHex: toHex(raw), txHash: toHex(keccak_256(raw)) };
}

/**
 * Intrinsic gas of a set-code transaction with empty data and no access
 * list: 21000 + PER_EMPTY_ACCOUNT_COST per tuple (EIP-7702 Gas Costs). A
 * floor for gas limits, not an estimate of execution.
 */
export function setCodeIntrinsicGas(authorizationCount: number, data: Uint8Array = new Uint8Array(0)): bigint {
  let gas = 21_000n + EIP7702_PER_EMPTY_ACCOUNT_COST * BigInt(authorizationCount);
  for (const byte of data) gas += byte === 0 ? 4n : 16n;
  return gas;
}

// ---------------------------------------------------------------------------
// Delegation status
// ---------------------------------------------------------------------------

export type DelegationStatus =
  /** No code: a plain EOA (never delegated, or revoked). */
  | { kind: 'none' }
  /** Code is exactly 0xef0100 || delegate. */
  | { kind: 'delegated'; delegate: string }
  /** Any other code: a contract, not an EOA this wallet can delegate. */
  | { kind: 'contract' };

/** Reads eth_getCode and classifies it with contract-risk.ts's indicator parser. */
export async function readDelegationStatus(
  node: JsonRpcTransport,
  address: string,
  block: string = 'latest',
): Promise<DelegationStatus> {
  const code = (await node('eth_getCode', [address, block])) as string;
  if (typeof code !== 'string') throw new Error('eth_getCode returned a non-string result');
  if (code === '0x' || code === '0x0' || code === '') return { kind: 'none' };
  const delegate = parseDelegationIndicator(code);
  return delegate ? { kind: 'delegated', delegate } : { kind: 'contract' };
}

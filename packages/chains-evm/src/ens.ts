import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { encodeFunctionCall, selector } from './abi.js';
import { keccak, toBytes, toHex } from './encoding.js';
import type { JsonRpcTransport } from './rpc.js';

/**
 * ENS forward resolution (name -> Ethereum address) through the ENS
 * Universal Resolver, for the Send screen's recipient field (phase 14
 * item 2, feature 74).
 *
 * Sources, all fetched 2026-10-04:
 *
 * - ENS documentation (github.com/ensdomains/docs at f84e60e5,
 *   src/pages/resolvers/universal.mdx): "The Universal Resolver should be
 *   treated as the canonical entrypoint to ENS for name resolution.
 *   `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` is the official deployment
 *   address on Ethereum Mainnet and testnets". Forward resolution is
 *   "`resolve(bytes name, bytes data)` which returns `(bytes data, address
 *   resolver)`", where `name` is the DNS-encoded, normalized name and
 *   `data` is "a single ABI-encoded call to the resolver for that name".
 *   The same page lists the errors ResolverNotFound(bytes),
 *   ResolverNotContract(bytes,address), UnsupportedResolverProfile(bytes4),
 *   ResolverError(bytes), ReverseAddressMismatch(string,bytes) and
 *   HttpError(uint16,string).
 * - Sepolia: src/pages/learn/deployments.mdx says Sepolia runs the ENSv2
 *   contracts and its Universal Resolver; the ENSv2 address list
 *   (ensdomains/contracts-v2 at 07e55a05, contracts/docs/addresses/
 *   sepolia.md) names UpgradableUniversalResolverProxy at the same
 *   0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe. Read live on 2026-10-04:
 *   the proxy has the same 2,491 bytes of code (keccak 0xf7ead24f…74c5) on
 *   Ethereum mainnet and Sepolia, and NO code on Base Sepolia.
 * - Namehash: EIP-137 (ethereum/ERCs ERCS/erc-137.md), with its test
 *   vectors namehash('') = 0x00…00, namehash('eth') = 0x93cdeb70…,
 *   namehash('foo.eth') = 0xde9b09fd…; DNS encoding per the ENS docs
 *   src/pages/resolution/names.mdx ("One byte to denote the length of the
 *   label, the UTF-8 encoded bytes for the label, … one final NUL (0x00)
 *   byte").
 * - The address record: EIP-137's addr(bytes32 node) returns the Ethereum
 *   address. ENSIP-9 (ensdomains/ensips ensips/9.md, Backwards
 *   Compatibility): "The value returned by addr(node) from ENSIP-1 should
 *   always match the value returned by addr(node, 60) (60 is the coin type
 *   ID for Ethereum)". This module reads coin type 60 through addr(bytes32)
 *   because every resolver implements it, and never reads other coin types
 *   (ENSIP-11 per-chain addresses are out of scope).
 * - Normalisation: ENSIP-15 (ensdomains/ensips ensips/15.md). This module
 *   does NOT implement ENSIP-15; it accepts only the ASCII subset described
 *   at normalizeEnsNameAscii, for which ENSIP-15's result is known exactly.
 * - Offchain names: EIP-3668 (CCIP-Read) defines
 *   `OffchainLookup(address sender, string[] urls, bytes callData, bytes4
 *   callbackFunction, bytes extraData)`. This module does not follow it:
 *   following it means fetching URLs supplied by a contract, which reveals
 *   the device's IP address and the looked-up name to a server the user
 *   never chose. Such names are refused with reason 'offchain'.
 *
 * Nothing here signs anything or touches keys; the module only reads.
 */

/** The ENS Universal Resolver (a DAO-owned proxy) on Ethereum mainnet and Sepolia. */
export const ENS_UNIVERSAL_RESOLVER = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';

/**
 * Chain ids on which this wallet resolves names through
 * ENS_UNIVERSAL_RESOLVER: Ethereum mainnet and Sepolia (the ENS docs'
 * "Ethereum Mainnet and testnets"; Holesky is being phased out and is not a
 * profile of this wallet). Every other chain is refused, including layer 2
 * test networks, where the address has no code.
 */
export const ENS_RESOLUTION_CHAIN_IDS: readonly bigint[] = [1n, 11155111n];

/** SLIP-44 / ENSIP-9 coin type of Ethereum; the only coin type this module reads. */
export const ENS_COIN_TYPE_ETH = 60n;

/** Longest name accepted, in bytes (a guard on input size, not an ENS rule). */
export const ENS_MAX_NAME_BYTES = 255;

// ---------------------------------------------------------------------------
// Names: the ASCII subset, namehash, DNS encoding
// ---------------------------------------------------------------------------

/** Why a name was refused by normalizeEnsNameAscii. */
export type EnsNameProblem =
  | 'empty'
  | 'not-ascii-subset'
  | 'empty-label'
  | 'single-label'
  | 'label-extension'
  | 'too-long';

export type EnsNameCheck =
  | { ok: true; name: string }
  | { ok: false; problem: EnsNameProblem };

/**
 * Normalizes a name ONLY when it lies in a conservative ASCII subset for
 * which ENSIP-15's output is known exactly; refuses everything else.
 *
 * Accepted input: labels of ASCII letters a–z and A–Z, digits 0–9 and the
 * hyphen-minus, separated by single full stops, with at least two labels.
 * Leading and trailing whitespace is trimmed (ENSIP-15 Algorithm: "leading
 * and trailing whitespace should be trimmed before normalization").
 *
 * Why this equals ENSIP-15 for the accepted set: per ENSIP-15 the only
 * label separator is U+002E; A–Z are mapped to a–z (example
 * `"_$A" → "_$a"`); and a label that is a single ASCII Text token is valid
 * unless "`5F (_)` occurs other than at the start" (not accepted here at
 * all) or "the 3rd and 4th characters … both [are] `2D (-)`" (refused
 * here as 'label-extension'). The unit tests compare this function with
 * ethers' ensNormalize (which uses @adraffy/ens-normalize, the reference
 * implementation the ENS docs name) on every accepted vector.
 *
 * Deliberately refused even though ENSIP-15 may accept them: any non-ASCII
 * character (emoji, accented and non-Latin scripts — the look-alike risk is
 * highest there), `$`, `_`, and single-label names such as "eth".
 */
export function normalizeEnsNameAscii(input: string): EnsNameCheck {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, problem: 'empty' };
  if (!/^[A-Za-z0-9.-]+$/.test(trimmed)) return { ok: false, problem: 'not-ascii-subset' };
  const name = trimmed.toLowerCase();
  const labels = name.split('.');
  if (labels.some((label) => label === '')) return { ok: false, problem: 'empty-label' };
  if (labels.length < 2) return { ok: false, problem: 'single-label' };
  if (labels.some((label) => /^..--/.test(label))) return { ok: false, problem: 'label-extension' };
  if (name.length > ENS_MAX_NAME_BYTES) return { ok: false, problem: 'too-long' };
  return { ok: true, name };
}

function requireNormalized(name: string): void {
  const check = normalizeEnsNameAscii(name);
  if (!check.ok || check.name !== name) {
    throw new EnsResolutionError(
      'invalid-name',
      `"${name}" is not a normalized name in the supported ASCII subset`,
    );
  }
}

/** keccak256 of one label's UTF-8 bytes (EIP-137 labelhash). */
export function labelhash(label: string): Uint8Array {
  return keccak(utf8ToBytes(label));
}

/**
 * EIP-137 namehash of an already-normalized name: namehash('') is 32 zero
 * bytes, and namehash(label + '.' + rest) =
 * keccak256(namehash(rest) || labelhash(label)). Throws on an empty label
 * (e.g. "a..eth"), which has no defined hash.
 */
export function namehash(name: string): Uint8Array {
  let node: Uint8Array = new Uint8Array(32);
  if (name === '') return node;
  const labels = name.split('.');
  for (let i = labels.length - 1; i >= 0; i--) {
    const label = labels[i]!;
    if (label === '') throw new Error('namehash: empty label');
    node = keccak(concatBytes(node, labelhash(label)));
  }
  return node;
}

/**
 * DNS wire encoding of a name, as the Universal Resolver expects it: for
 * each label one length byte then its UTF-8 bytes, then a final 0x00.
 * Labels must be 1 to 255 bytes (the length is one byte).
 */
export function dnsEncodeName(name: string): Uint8Array {
  if (name === '') return new Uint8Array([0]);
  const parts: Uint8Array[] = [];
  for (const label of name.split('.')) {
    const bytes = utf8ToBytes(label);
    if (bytes.length === 0) throw new Error('dnsEncodeName: empty label');
    if (bytes.length > 255) throw new Error('dnsEncodeName: label longer than 255 bytes');
    parts.push(new Uint8Array([bytes.length]), bytes);
  }
  parts.push(new Uint8Array([0]));
  return concatBytes(...parts);
}

// ---------------------------------------------------------------------------
// Calldata and decoding
// ---------------------------------------------------------------------------

/** addr(bytes32 node): the EIP-137 Ethereum address record (= coin type 60). */
export function encodeEnsAddrCall(node: Uint8Array): Uint8Array {
  if (node.length !== 32) throw new Error('node must be 32 bytes');
  return encodeFunctionCall('addr(bytes32)', [{ kind: 'fixedBytes', value: node }]);
}

/** Universal Resolver resolve(bytes name, bytes data). */
export function encodeUniversalResolve(dnsName: Uint8Array, data: Uint8Array): Uint8Array {
  return encodeFunctionCall('resolve(bytes,bytes)', [
    { kind: 'bytes', value: dnsName },
    { kind: 'bytes', value: data },
  ]);
}

function wordToBigint(bytes: Uint8Array, offset: number): bigint {
  if (offset + 32 > bytes.length) throw new Error('truncated ABI word');
  return BigInt(toHex(bytes.slice(offset, offset + 32)));
}

/**
 * Strict decoder for resolve()'s return value `(bytes result, address
 * resolver)`: the head is exactly two words (offset, address), the offset
 * must be 0x40, the address word must have 12 zero high bytes, the bytes
 * length must fit, and the padding after the bytes must be zero with no
 * trailing data. Anything else throws — a malformed answer is never read
 * as an address.
 */
export function decodeUniversalResolveResult(returnData: Uint8Array): {
  result: Uint8Array;
  resolver: string;
} {
  if (returnData.length < 96) throw new Error('resolve() returned too few bytes');
  const offset = wordToBigint(returnData, 0);
  if (offset !== 64n) throw new Error('resolve() returned an unexpected bytes offset');
  const resolverWord = returnData.slice(32, 64);
  if (resolverWord.slice(0, 12).some((b) => b !== 0)) {
    throw new Error('resolve() returned a malformed resolver address');
  }
  const length = wordToBigint(returnData, 64);
  if (length > BigInt(returnData.length)) throw new Error('resolve() bytes length out of range');
  const len = Number(length);
  const padded = Math.ceil(len / 32) * 32;
  if (96 + padded !== returnData.length) {
    throw new Error('resolve() returned trailing or missing bytes');
  }
  const result = returnData.slice(96, 96 + len);
  if (returnData.slice(96 + len).some((b) => b !== 0)) {
    throw new Error('resolve() returned non-zero padding');
  }
  return { result, resolver: toChecksumAddress(resolverWord.slice(12)) };
}

/**
 * Decodes addr(bytes32)'s result: exactly one 32-byte word whose 12 high
 * bytes are zero. Returns the checksummed address, or null for the zero
 * address (no address record set). Throws on any other shape.
 */
export function decodeEnsAddrResult(result: Uint8Array): string | null {
  if (result.length !== 32) throw new Error(`addr() returned ${result.length} bytes, expected 32`);
  if (result.slice(0, 12).some((b) => b !== 0)) throw new Error('addr() returned a malformed address word');
  const address = result.slice(12);
  if (address.every((b) => b === 0)) return null;
  return toChecksumAddress(address);
}

// ---------------------------------------------------------------------------
// Reverts
// ---------------------------------------------------------------------------

/** Error selectors, computed from their signatures (pinned against ethers in tests). */
export const ENS_ERROR_SELECTORS = {
  offchainLookup: toHex(selector('OffchainLookup(address,string[],bytes,bytes4,bytes)')),
  resolverNotFound: toHex(selector('ResolverNotFound(bytes)')),
  resolverNotContract: toHex(selector('ResolverNotContract(bytes,address)')),
  unsupportedResolverProfile: toHex(selector('UnsupportedResolverProfile(bytes4)')),
  resolverError: toHex(selector('ResolverError(bytes)')),
  httpError: toHex(selector('HttpError(uint16,string)')),
} as const;

export type EnsRevertKind =
  | 'offchain-lookup'
  | 'resolver-not-found'
  | 'resolver-not-contract'
  | 'unsupported-resolver-profile'
  | 'resolver-error'
  | 'http-error'
  | 'unknown';

/** Classifies revert data from a Universal Resolver call by its 4-byte selector. */
export function classifyEnsRevert(revertData: string): EnsRevertKind {
  const sel = revertData.slice(0, 10).toLowerCase();
  if (sel === ENS_ERROR_SELECTORS.offchainLookup) return 'offchain-lookup';
  if (sel === ENS_ERROR_SELECTORS.resolverNotFound) return 'resolver-not-found';
  if (sel === ENS_ERROR_SELECTORS.resolverNotContract) return 'resolver-not-contract';
  if (sel === ENS_ERROR_SELECTORS.unsupportedResolverProfile) return 'unsupported-resolver-profile';
  if (sel === ENS_ERROR_SELECTORS.resolverError) return 'resolver-error';
  if (sel === ENS_ERROR_SELECTORS.httpError) return 'http-error';
  return 'unknown';
}

/**
 * Revert data from a thrown JSON-RPC error: the error's `data` property as
 * a hex string, or `data.data` (the two shapes nodes use for eth_call
 * reverts — the same rule as simulate.ts). Undefined when absent.
 */
export function revertDataOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  if (typeof data === 'string' && /^0x[0-9a-fA-F]*$/.test(data)) return data;
  if (typeof data === 'object' && data !== null) {
    const inner = (data as { data?: unknown }).data;
    if (typeof inner === 'string' && /^0x[0-9a-fA-F]*$/.test(inner)) return inner;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type EnsResolutionErrorReason =
  /** The name is not a normalized name in the supported ASCII subset. */
  | 'invalid-name'
  /** The endpoint serves a chain on which this wallet does not resolve names. */
  | 'unsupported-chain'
  /** The endpoint's eth_chainId differs from the chain the caller expected. */
  | 'wrong-chain'
  /** The name needs CCIP-Read (EIP-3668), which this wallet does not follow. */
  | 'offchain'
  /** No resolver is set for the name (it is not registered, or has no resolver). */
  | 'no-resolver'
  /** The resolver has no Ethereum address for the name (the zero address). */
  | 'no-address'
  /** The resolver failed, is not a contract, or does not support addr(). */
  | 'resolver-error'
  /** The answer did not have the expected shape. */
  | 'malformed';

export class EnsResolutionError extends Error {
  readonly reason: EnsResolutionErrorReason;
  constructor(reason: EnsResolutionErrorReason, message: string) {
    super(message);
    this.name = 'EnsResolutionError';
    this.reason = reason;
  }
}

/** A successful forward resolution. */
export interface EnsForwardResolution {
  /** The normalized name that was looked up. */
  name: string;
  /** Its EIP-137 namehash, 0x-hex. */
  node: string;
  /** The Ethereum address (coin type 60), EIP-55 checksummed, never the zero address. */
  address: string;
  /** The resolver the Universal Resolver used, checksummed. */
  resolver: string;
  /** The Universal Resolver that answered. */
  universalResolver: string;
  /** The chain the endpoint reported (eth_chainId) — whose ENS registry answered. */
  chainId: bigint;
}

/**
 * Resolves `name` (already normalized; see normalizeEnsNameAscii) to its
 * Ethereum address through the Universal Resolver on the endpoint behind
 * `transport`, which must report `expectedChainId` (1 or 11155111).
 *
 * Errors: EnsResolutionError for every ENS-level outcome (see its
 * reasons); transport failures (network, HTTP, rate limits) are rethrown
 * unchanged so the caller's endpoint failover rule can see them. Revert
 * data is read from the thrown error's `data` (see revertDataOf); a
 * transport that drops it turns every revert into a rethrown error, never
 * into a wrong answer.
 */
export async function resolveEnsAddress(
  transport: JsonRpcTransport,
  name: string,
  expectedChainId: bigint,
): Promise<EnsForwardResolution> {
  requireNormalized(name);
  if (!ENS_RESOLUTION_CHAIN_IDS.includes(expectedChainId)) {
    throw new EnsResolutionError(
      'unsupported-chain',
      `ENS names are not resolved on chain ${expectedChainId.toString()}`,
    );
  }
  const reported = BigInt((await transport('eth_chainId', [])) as string);
  if (reported !== expectedChainId) {
    throw new EnsResolutionError(
      'wrong-chain',
      `The endpoint serves chain ${reported.toString()}, not ${expectedChainId.toString()}`,
    );
  }
  const node = namehash(name);
  const data = encodeUniversalResolve(dnsEncodeName(name), encodeEnsAddrCall(node));
  let raw: unknown;
  try {
    raw = await transport('eth_call', [{ to: ENS_UNIVERSAL_RESOLVER, data: toHex(data) }, 'latest']);
  } catch (error) {
    const revert = revertDataOf(error);
    if (revert === undefined) throw error;
    const kind = classifyEnsRevert(revert);
    switch (kind) {
      case 'offchain-lookup':
        throw new EnsResolutionError(
          'offchain',
          `${name} is resolved off-chain (EIP-3668 CCIP-Read), which this wallet does not follow`,
        );
      case 'resolver-not-found':
        throw new EnsResolutionError('no-resolver', `${name} has no resolver`);
      case 'resolver-not-contract':
      case 'unsupported-resolver-profile':
      case 'resolver-error':
      case 'http-error':
        throw new EnsResolutionError('resolver-error', `Resolving ${name} failed (${kind})`);
      default:
        throw new EnsResolutionError(
          'resolver-error',
          `Resolving ${name} reverted with unknown error ${revert.slice(0, 10)}`,
        );
    }
  }
  if (typeof raw !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(raw)) {
    throw new EnsResolutionError('malformed', 'eth_call returned a non-hex result');
  }
  if (raw === '0x') {
    // An empty return from a call to the Universal Resolver means there is
    // no contract at its address on this endpoint's chain.
    throw new EnsResolutionError('malformed', 'The ENS Universal Resolver returned nothing (no contract?)');
  }
  let decoded: { result: Uint8Array; resolver: string };
  let address: string | null;
  try {
    decoded = decodeUniversalResolveResult(toBytes(raw));
    address = decodeEnsAddrResult(decoded.result);
  } catch (e) {
    throw new EnsResolutionError('malformed', e instanceof Error ? e.message : 'malformed answer');
  }
  if (decoded.resolver === '0x0000000000000000000000000000000000000000') {
    throw new EnsResolutionError('no-resolver', `${name} has no resolver`);
  }
  if (address === null) {
    throw new EnsResolutionError('no-address', `${name} has no Ethereum address record`);
  }
  return {
    name,
    node: toHex(node),
    address,
    resolver: decoded.resolver,
    universalResolver: ENS_UNIVERSAL_RESOLVER,
    chainId: reported,
  };
}

/**
 * The forward-verification rule used before anything is quoted: resolve
 * the same name again on the same chain and compare. `changed` is true when
 * the address now differs from the one the user was shown (case-insensitive
 * comparison of the 20 bytes); callers must then refuse to continue with
 * the old address and show the new one instead. Errors propagate as in
 * resolveEnsAddress (a name that stopped resolving is refused, not reused).
 */
export async function reverifyEnsResolution(
  transport: JsonRpcTransport,
  shown: Pick<EnsForwardResolution, 'name' | 'address' | 'chainId'>,
): Promise<{ changed: boolean; current: EnsForwardResolution }> {
  const current = await resolveEnsAddress(transport, shown.name, shown.chainId);
  return {
    changed: current.address.toLowerCase() !== shown.address.toLowerCase(),
    current,
  };
}

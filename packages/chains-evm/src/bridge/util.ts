import { toChecksumAddress } from '@shiba-wallet/core';
import { toBytes, toHex, toWord } from '../encoding.js';
import { encodeErc20Approve } from '../erc20.js';
import type { BridgeAsset, BridgePin } from './types.js';

/** Shared helpers for the bridge adapters. Pure; no network. */

export const ZERO_ADDRESS_LOWER = '0x0000000000000000000000000000000000000000';

/**
 * Returns the EIP-55 form of an address. Refuses anything that is not 20
 * bytes of hex, and a mixed-case address whose checksum is wrong (a typo or
 * a tampered value), instead of silently accepting it.
 */
export function checksumAddress(address: string, what = 'address'): string {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`The ${what} must be a 20-byte hex address starting with 0x.`);
  }
  const checksummed = toChecksumAddress(toBytes(address.toLowerCase()));
  const body = address.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && address !== checksummed) {
    throw new Error(`The ${what} ${address} has an invalid EIP-55 checksum.`);
  }
  return checksummed;
}

export function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS_LOWER;
}

/** An address left-padded into a 32-byte word, as LayerZero and CCTP carry recipients. */
export function addressToBytes32(address: string): string {
  return toHex(toWord(toBytes(checksumAddress(address).toLowerCase())));
}

/** A uint256 (or address) as the 0x + 64-hex word a CallPolicy rule takes. */
export function word(value: bigint | string): string {
  if (typeof value === 'bigint') return toHex(toWord(value));
  return toHex(toWord(toBytes(value.toLowerCase())));
}

/** An "equal" pin at a byte offset after the selector. */
export function equalPin(field: string, offset: number, value: bigint | string): BridgePin {
  return { field, rule: { condition: 'equal', offset, params: [word(value)] } };
}

/** A "less than or equal" pin (an upper bound). */
export function capPin(field: string, offset: number, max: bigint): BridgePin {
  return { field, rule: { condition: 'lessThanOrEqual', offset, params: [word(max)] } };
}

/** A "greater than or equal" pin (a floor). */
export function floorPin(field: string, offset: number, min: bigint): BridgePin {
  return { field, rule: { condition: 'greaterThanOrEqual', offset, params: [word(min)] } };
}

export function assertUint(value: bigint, bits: number, what: string): void {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(bits)) {
    throw new Error(`The ${what} must be an unsigned ${bits}-bit integer.`);
  }
}

export function sameAsset(a: BridgeAsset, b: BridgeAsset): boolean {
  if (a.kind !== b.kind || a.decimals !== b.decimals || a.symbol !== b.symbol) return false;
  if (a.kind === 'erc20' && b.kind === 'erc20') return a.address.toLowerCase() === b.address.toLowerCase();
  return true;
}

/** The largest approval any bridge adapter will build: anything at or above 2^255 is treated as "unlimited" and refused. */
export const MAX_EXACT_APPROVAL = (1n << 255n) - 1n;

/**
 * An exact ERC-20 approve(spender, amount) for a bridge, with both words
 * pinned. Refuses zero and anything that looks like an unlimited approval:
 * the wallet's standing rule is exact approvals only (docs/BRIDGING.md
 * section 3).
 */
export function exactApprovalCall(chainId: number, token: string, spender: string, amount: bigint, label: string) {
  if (amount <= 0n) throw new Error('A bridge approval must be for more than zero.');
  if (amount > MAX_EXACT_APPROVAL) throw new Error('The wallet never builds an unlimited approval; approve the exact amount instead.');
  const tokenAddress = checksumAddress(token, 'token');
  const spenderAddress = checksumAddress(spender, 'spender');
  return {
    purpose: 'approve' as const,
    chainId,
    to: tokenAddress,
    value: 0n,
    data: encodeErc20Approve(spenderAddress, amount),
    label,
    selector: '0x095ea7b3',
    pins: [equalPin('spender', 0, spenderAddress), equalPin('amount', 32, amount)],
    unpinnable: [] as string[],
    valueLimit: 0n,
  };
}

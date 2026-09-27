import { encodeFunctionCall } from './abi.js';
import { toBytes } from './encoding.js';
import { toChecksumAddress } from '@shiba-wallet/core';

/**
 * ERC-20 calldata helpers. These produce the `data` field of a Call, which
 * flows through SmartAccountClient.sendCalls (so a token transfer can ride
 * a sponsored, batched UserOperation) or into a plain EOA transaction. Read
 * calls return the encoded eth_call payload plus a decoder for the result.
 */

export function encodeErc20Transfer(to: string, amount: bigint): Uint8Array {
  return encodeFunctionCall('transfer(address,uint256)', [
    { kind: 'address', value: to },
    { kind: 'uint256', value: amount },
  ]);
}

export function encodeErc20Approve(spender: string, amount: bigint): Uint8Array {
  return encodeFunctionCall('approve(address,uint256)', [
    { kind: 'address', value: spender },
    { kind: 'uint256', value: amount },
  ]);
}

export function encodeErc20TransferFrom(
  from: string,
  to: string,
  amount: bigint,
): Uint8Array {
  return encodeFunctionCall('transferFrom(address,address,uint256)', [
    { kind: 'address', value: from },
    { kind: 'address', value: to },
    { kind: 'uint256', value: amount },
  ]);
}

export function encodeErc20BalanceOf(owner: string): Uint8Array {
  return encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: owner }]);
}

/** Decodes a uint256 word returned by eth_call (balanceOf, allowance...). */
export function decodeUint256(result: string): bigint {
  const bytes = toBytes(result);
  if (bytes.length !== 32) {
    throw new Error(`Expected a 32-byte uint256 word, got ${bytes.length} bytes`);
  }
  return BigInt(result);
}

/** Decodes an address returned by eth_call as a checksummed string. */
export function decodeAddress(result: string): string {
  const bytes = toBytes(result);
  if (bytes.length !== 32) {
    throw new Error(`Expected a 32-byte word, got ${bytes.length} bytes`);
  }
  return toChecksumAddress(bytes.slice(12));
}

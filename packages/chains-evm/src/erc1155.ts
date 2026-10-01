import { encodeFunctionCall, selector } from './abi.js';

/**
 * ERC-1155 calldata helpers for the wallet's NFT send flow.
 *
 * Function signatures are taken verbatim from the ERC-1155 text
 * (https://github.com/ethereum/ERCs/blob/master/ERCS/erc-1155.md, checked
 * 2026-10-01):
 *
 *   function safeTransferFrom(address _from, address _to, uint256 _id,
 *                             uint256 _value, bytes calldata _data) external;
 *   function balanceOf(address _owner, uint256 _id) external view returns (uint256);
 *
 * As in erc721.ts, selectors are computed from the canonical signature
 * strings with keccak256 (abi.ts selector) and pinned against ethers in the
 * tests; no selector hex is pasted. The standard requires safeTransferFrom
 * to revert when the holder's balance is below `_value`, when `_to` is the
 * zero address, and when a contract recipient rejects the transfer in
 * onERC1155Received, so all of those surface in the eth_call pre-flight.
 */

export const ERC1155_SAFE_TRANSFER_FROM_SIGNATURE =
  'safeTransferFrom(address,address,uint256,uint256,bytes)';
export const ERC1155_BALANCE_OF_SIGNATURE = 'balanceOf(address,uint256)';

/** keccak256("safeTransferFrom(address,address,uint256,uint256,bytes)")[0:4]. */
export const ERC1155_SAFE_TRANSFER_FROM_SELECTOR: Uint8Array = selector(
  ERC1155_SAFE_TRANSFER_FROM_SIGNATURE,
);
/** keccak256("balanceOf(address,uint256)")[0:4]. */
export const ERC1155_BALANCE_OF_SELECTOR: Uint8Array = selector(ERC1155_BALANCE_OF_SIGNATURE);

const MAX_UINT256 = (1n << 256n) - 1n;

function assertUint256(value: bigint, what: string): void {
  if (value < 0n || value > MAX_UINT256) throw new Error(`ERC-1155 ${what} must be a uint256`);
}

/**
 * safeTransferFrom(from, to, id, amount, data) calldata. `data` defaults to
 * empty bytes: the standard passes it unaltered to onERC1155Received and
 * assigns it no meaning, and the wallet has nothing to say to recipients.
 * A zero amount is refused here because a wallet transfer of nothing is
 * always a mistake (the standard itself would permit it).
 */
export function encodeErc1155SafeTransferFrom(
  from: string,
  to: string,
  id: bigint,
  amount: bigint,
  data: Uint8Array = new Uint8Array(0),
): Uint8Array {
  assertUint256(id, 'token id');
  assertUint256(amount, 'amount');
  if (amount === 0n) throw new Error('ERC-1155 transfer amount must be greater than zero');
  return encodeFunctionCall(ERC1155_SAFE_TRANSFER_FROM_SIGNATURE, [
    { kind: 'address', value: from },
    { kind: 'address', value: to },
    { kind: 'uint256', value: id },
    { kind: 'uint256', value: amount },
    { kind: 'bytes', value: data },
  ]);
}

/** balanceOf(owner, id) eth_call payload; decode the result with decodeUint256. */
export function encodeErc1155BalanceOf(owner: string, id: bigint): Uint8Array {
  assertUint256(id, 'token id');
  return encodeFunctionCall(ERC1155_BALANCE_OF_SIGNATURE, [
    { kind: 'address', value: owner },
    { kind: 'uint256', value: id },
  ]);
}

/**
 * ERC-1155 metadata URI id substitution, per the standard's Metadata
 * section: if the string "{id}" exists in a URI (or any metadata JSON
 * value), clients MUST replace it with the token id in hexadecimal,
 * lowercase [0-9a-f], no 0x prefix, left-padded with zeros to 64
 * characters. Example from the text: id 314592 (0x4CCE0) becomes
 * 000000000000000000000000000000000000000000000000000000000004cce0.
 */
export function substituteErc1155Id(template: string, id: bigint): string {
  assertUint256(id, 'token id');
  if (!template.includes('{id}')) return template;
  return template.split('{id}').join(id.toString(16).padStart(64, '0'));
}

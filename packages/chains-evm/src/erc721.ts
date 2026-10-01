import { encodeFunctionCall, selector } from './abi.js';

/**
 * ERC-721 calldata helpers for the wallet's NFT send flow.
 *
 * Function signatures are taken verbatim from the ERC-721 text
 * (https://github.com/ethereum/ERCs/blob/master/ERCS/erc-721.md, checked
 * 2026-10-01):
 *
 *   function ownerOf(uint256 _tokenId) external view returns (address);
 *   function safeTransferFrom(address _from, address _to, uint256 _tokenId) external payable;
 *
 * The 4-byte selectors are NOT pasted constants: they are computed at load
 * time as the first four bytes of keccak256 over the canonical signature
 * strings below (abi.ts selector), and the tests pin them against ethers'
 * Interface. The three-argument safeTransferFrom is the overload the
 * standard defines as "identical to the other function with an extra data
 * parameter, except this function just sets data to ''". Being the "safe"
 * variant, it calls onERC721Received on a contract recipient and reverts
 * when the recipient cannot accept NFTs, which the wallet's eth_call
 * pre-flight surfaces before anything is signed.
 */

export const ERC721_OWNER_OF_SIGNATURE = 'ownerOf(uint256)';
export const ERC721_SAFE_TRANSFER_FROM_SIGNATURE = 'safeTransferFrom(address,address,uint256)';

/** keccak256("safeTransferFrom(address,address,uint256)")[0:4]. */
export const ERC721_SAFE_TRANSFER_FROM_SELECTOR: Uint8Array = selector(
  ERC721_SAFE_TRANSFER_FROM_SIGNATURE,
);
/** keccak256("ownerOf(uint256)")[0:4]. */
export const ERC721_OWNER_OF_SELECTOR: Uint8Array = selector(ERC721_OWNER_OF_SIGNATURE);

const MAX_UINT256 = (1n << 256n) - 1n;

function assertTokenId(tokenId: bigint): void {
  if (tokenId < 0n || tokenId > MAX_UINT256) {
    throw new Error('ERC-721 token id must be a uint256');
  }
}

/** safeTransferFrom(from, to, tokenId) calldata (sent with value 0). */
export function encodeErc721SafeTransferFrom(
  from: string,
  to: string,
  tokenId: bigint,
): Uint8Array {
  assertTokenId(tokenId);
  return encodeFunctionCall(ERC721_SAFE_TRANSFER_FROM_SIGNATURE, [
    { kind: 'address', value: from },
    { kind: 'address', value: to },
    { kind: 'uint256', value: tokenId },
  ]);
}

/** ownerOf(tokenId) eth_call payload; decode the result with decodeAddress. */
export function encodeErc721OwnerOf(tokenId: bigint): Uint8Array {
  assertTokenId(tokenId);
  return encodeFunctionCall(ERC721_OWNER_OF_SIGNATURE, [{ kind: 'uint256', value: tokenId }]);
}

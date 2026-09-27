/**
 * CAIP-19 asset identifiers: chain-agnostic ids for any on-chain asset,
 * fungible or not. Examples:
 *
 *   eip155:1/slip44:60                      native ETH
 *   eip155:1/erc20:0xa0b8...eb48            an ERC-20 token (e.g. USDC)
 *   eip155:1/erc721:0xb47e...0544/1234      one ERC-721 NFT (token id 1234)
 *   eip155:1/erc1155:0x1234.../7            an ERC-1155 token class
 *   solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjF...   an SPL token
 *
 * Using CAIP-19 as the universal asset key means the wallet can represent
 * every current and future token standard without core changes: a new
 * standard is just a new asset namespace string that some chain adapter
 * knows how to handle.
 */

export interface AssetId {
  /** CAIP-2 chain id, e.g. "eip155:1". */
  chainId: string;
  /** Asset namespace, e.g. "slip44", "erc20", "erc721", "erc1155", "token". */
  namespace: string;
  /** Asset reference: contract address, mint address, or SLIP-44 coin type. */
  reference: string;
  /** Optional token id for individual NFTs. */
  tokenId?: string;
}

const CHAIN_ID_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const NAMESPACE_RE = /^[-a-z0-9]{3,8}$/;
const REFERENCE_RE = /^[-.%a-zA-Z0-9]{1,128}$/;
const TOKEN_ID_RE = /^[-.%a-zA-Z0-9]{1,78}$/;

export function formatAssetId(asset: AssetId): string {
  validateAssetId(asset);
  const base = `${asset.chainId}/${asset.namespace}:${asset.reference}`;
  return asset.tokenId === undefined ? base : `${base}/${asset.tokenId}`;
}

export function parseAssetId(id: string): AssetId {
  const parts = id.split('/');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`Invalid CAIP-19 asset id: ${id}`);
  }
  const [chainId, assetPart, tokenId] = parts;
  const colon = assetPart!.indexOf(':');
  if (colon === -1) throw new Error(`Invalid CAIP-19 asset id: ${id}`);
  const asset: AssetId = {
    chainId: chainId!,
    namespace: assetPart!.slice(0, colon),
    reference: assetPart!.slice(colon + 1),
    ...(tokenId !== undefined ? { tokenId } : {}),
  };
  validateAssetId(asset);
  return asset;
}

function validateAssetId(asset: AssetId): void {
  if (!CHAIN_ID_RE.test(asset.chainId)) {
    throw new Error(`Invalid CAIP-2 chain id: ${asset.chainId}`);
  }
  if (!NAMESPACE_RE.test(asset.namespace)) {
    throw new Error(`Invalid asset namespace: ${asset.namespace}`);
  }
  if (!REFERENCE_RE.test(asset.reference)) {
    throw new Error(`Invalid asset reference: ${asset.reference}`);
  }
  if (asset.tokenId !== undefined && !TOKEN_ID_RE.test(asset.tokenId)) {
    throw new Error(`Invalid token id: ${asset.tokenId}`);
  }
}

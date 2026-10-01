import { formatAssetId, parseAssetId, type AssetId } from './caip19.js';

/**
 * Asset metadata model. Core stores only descriptions of assets; balances,
 * transfers, and metadata fetching are chain-adapter concerns (they need
 * network access, which core never has).
 */

export interface FungibleAsset {
  kind: 'fungible';
  assetId: AssetId;
  symbol: string;
  name: string;
  /** Display decimals, e.g. 6 for USDC, 18 for ETH, 9 for SOL. */
  decimals: number;
  /** Optional logo URL; UI concern, never fetched by core. */
  iconUrl?: string;
}

export interface NonFungibleAsset {
  kind: 'nonFungible';
  assetId: AssetId;
  name: string;
  /** Collection-level standard hint, e.g. "erc721", "erc1155". */
  standard: string;
}

export type Asset = FungibleAsset | NonFungibleAsset;

/** CAIP-19 namespaces of the EVM NFT standards the wallet can send. */
export type NftNamespace = 'erc721' | 'erc1155';

const MAX_UINT256 = (1n << 256n) - 1n;
const DECIMAL_TOKEN_ID = /^(0|[1-9][0-9]{0,77})$/;

/**
 * Canonical CAIP-19 id for one EVM NFT: `{chainId}/{namespace}:{contract}/
 * {tokenId}` with the token id written in decimal (the form used by the
 * CAIP-19 erc721 example and by ERC-721/1155 indexers). Token ids are
 * uint256 values, so they are taken as bigint and range-checked; a
 * JavaScript number could not represent most real ids exactly.
 */
export function nonFungibleAssetId(
  chainId: string,
  namespace: NftNamespace,
  contract: string,
  tokenId: bigint,
): AssetId {
  if (tokenId < 0n || tokenId > MAX_UINT256) {
    throw new Error('NFT token id must be a uint256');
  }
  const assetId: AssetId = { chainId, namespace, reference: contract, tokenId: tokenId.toString(10) };
  formatAssetId(assetId); // validates every part
  return assetId;
}

/**
 * The exact token id of an NFT asset id. Only the canonical decimal form
 * produced by nonFungibleAssetId is accepted (no sign, no leading zeros,
 * no hex), so one token can never be addressed by two different ids.
 */
export function nonFungibleTokenId(assetId: AssetId | string): bigint {
  const parsed = typeof assetId === 'string' ? parseAssetId(assetId) : assetId;
  if (parsed.namespace !== 'erc721' && parsed.namespace !== 'erc1155') {
    throw new Error(`Not an NFT asset namespace: ${parsed.namespace}`);
  }
  const raw = parsed.tokenId;
  if (raw === undefined || !DECIMAL_TOKEN_ID.test(raw)) {
    throw new Error(`NFT asset id needs a canonical decimal token id: ${raw ?? '(none)'}`);
  }
  const value = BigInt(raw);
  if (value > MAX_UINT256) throw new Error('NFT token id must be a uint256');
  return value;
}

/**
 * User- and app-curated asset list. Nothing here is a source of truth about
 * the chain: registering an asset only tells the wallet to track it. The
 * registry is serializable so the app can persist the user's token list.
 */
export class AssetRegistry {
  private assets = new Map<string, Asset>();

  add(asset: Asset): void {
    this.assets.set(formatAssetId(asset.assetId), asset);
  }

  remove(assetId: AssetId | string): boolean {
    return this.assets.delete(normalizeId(assetId));
  }

  get(assetId: AssetId | string): Asset | undefined {
    return this.assets.get(normalizeId(assetId));
  }

  /** All tracked assets, optionally filtered to one chain. */
  list(chainId?: string): Asset[] {
    const all = [...this.assets.values()];
    return chainId === undefined
      ? all
      : all.filter((a) => a.assetId.chainId === chainId);
  }

  toJSON(): Asset[] {
    return this.list();
  }

  static fromJSON(assets: Asset[]): AssetRegistry {
    const registry = new AssetRegistry();
    for (const asset of assets) registry.add(asset);
    return registry;
  }
}

function normalizeId(assetId: AssetId | string): string {
  return typeof assetId === 'string'
    ? formatAssetId(parseAssetId(assetId))
    : formatAssetId(assetId);
}

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

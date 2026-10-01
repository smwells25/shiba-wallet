import { describe, expect, it } from 'vitest';
import { formatAssetId, parseAssetId } from '../src/assets/caip19.js';
import {
  AssetRegistry,
  nonFungibleAssetId,
  nonFungibleTokenId,
  type FungibleAsset,
  type NonFungibleAsset,
} from '../src/assets/assets.js';

describe('CAIP-19 asset ids', () => {
  it('round-trips an ERC-20 id', () => {
    const id = 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const parsed = parseAssetId(id);
    expect(parsed).toEqual({
      chainId: 'eip155:1',
      namespace: 'erc20',
      reference: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    });
    expect(formatAssetId(parsed)).toBe(id);
  });

  it('round-trips an ERC-721 id with a token id', () => {
    const id = 'eip155:1/erc721:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1234';
    const parsed = parseAssetId(id);
    expect(parsed.tokenId).toBe('1234');
    expect(formatAssetId(parsed)).toBe(id);
  });

  it('round-trips a native-coin slip44 id and an SPL token id', () => {
    expect(formatAssetId(parseAssetId('eip155:1/slip44:60'))).toBe('eip155:1/slip44:60');
    const spl = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    expect(formatAssetId(parseAssetId(spl))).toBe(spl);
  });

  it('rejects malformed ids', () => {
    expect(() => parseAssetId('eip155:1')).toThrow(/Invalid CAIP-19/);
    expect(() => parseAssetId('eip155:1/erc20')).toThrow(/Invalid CAIP-19/);
    expect(() => parseAssetId('nonsense/erc20:0xabc')).toThrow(/Invalid CAIP-2/);
    expect(() => parseAssetId('eip155:1/erc20:0xabc/1/2')).toThrow(/Invalid CAIP-19/);
  });
});

describe('AssetRegistry', () => {
  const usdc: FungibleAsset = {
    kind: 'fungible',
    assetId: parseAssetId('eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
  };
  const nft: NonFungibleAsset = {
    kind: 'nonFungible',
    assetId: parseAssetId('eip155:1/erc721:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1'),
    name: 'Example NFT #1',
    standard: 'erc721',
  };

  it('tracks, lists, and removes assets across chains', () => {
    const registry = new AssetRegistry();
    registry.add(usdc);
    registry.add(nft);
    expect(registry.list().length).toBe(2);
    expect(registry.list('eip155:1').length).toBe(2);
    expect(registry.list('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp').length).toBe(0);
    expect(registry.get('eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')?.kind).toBe('fungible');
    expect(registry.remove(nft.assetId)).toBe(true);
    expect(registry.list().length).toBe(1);
  });

  it('serializes and restores the user token list', () => {
    const registry = new AssetRegistry();
    registry.add(usdc);
    const restored = AssetRegistry.fromJSON(JSON.parse(JSON.stringify(registry)));
    const roundTripped = restored.get(usdc.assetId);
    expect(roundTripped).toEqual(usdc);
  });
});

describe('NFT asset ids', () => {
  const contract = '0x0000000000696760E15f265e828DB644A0c242EB';
  // A real token id observed in the 2026-10-01 indexer probe (> 2^53).
  const big = 34454361969670104802583458346517400542074712368450903800518897101070583190115n;
  const max = (1n << 256n) - 1n;

  it('formats decimal token ids exactly and round-trips them', () => {
    const id = nonFungibleAssetId('eip155:1', 'erc721', contract, big);
    expect(formatAssetId(id)).toBe(`eip155:1/erc721:${contract}/${big.toString()}`);
    expect(nonFungibleTokenId(formatAssetId(id))).toBe(big);
    const maxId = nonFungibleAssetId('eip155:11155111', 'erc1155', contract, max);
    expect(maxId.tokenId).toHaveLength(78);
    expect(nonFungibleTokenId(maxId)).toBe(max);
    expect(nonFungibleTokenId(nonFungibleAssetId('eip155:1', 'erc1155', contract, 0n))).toBe(0n);
  });

  it('rejects out-of-range ids and non-canonical token id forms', () => {
    expect(() => nonFungibleAssetId('eip155:1', 'erc721', contract, -1n)).toThrow(/uint256/);
    expect(() => nonFungibleAssetId('eip155:1', 'erc721', contract, max + 1n)).toThrow(/uint256/);
    expect(() => nonFungibleTokenId(`eip155:1/erc721:${contract}/007`)).toThrow(/canonical/);
    expect(() => nonFungibleTokenId(`eip155:1/erc721:${contract}/0x1f`)).toThrow(/canonical/);
    expect(() => nonFungibleTokenId(`eip155:1/erc721:${contract}`)).toThrow(/canonical/);
    expect(() => nonFungibleTokenId(`eip155:1/erc20:${contract}/1`)).toThrow(/namespace/);
    expect(() => nonFungibleTokenId(`eip155:1/erc721:${contract}/${(max + 1n).toString()}`)).toThrow(/uint256/);
  });

  it('tracks NFT assets built from the helper in the registry', () => {
    const asset: NonFungibleAsset = {
      kind: 'nonFungible',
      assetId: nonFungibleAssetId('eip155:1', 'erc721', contract, big),
      name: 'vitalik.wei',
      standard: 'erc721',
    };
    const restored = AssetRegistry.fromJSON(JSON.parse(JSON.stringify(AssetRegistry.fromJSON([asset]))));
    expect(restored.get(asset.assetId)).toEqual(asset);
  });
});

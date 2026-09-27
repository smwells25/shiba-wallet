import { describe, expect, it } from 'vitest';
import { formatAssetId, parseAssetId } from '../src/assets/caip19.js';
import { AssetRegistry, type FungibleAsset, type NonFungibleAsset } from '../src/assets/assets.js';

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

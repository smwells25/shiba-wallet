import { describe, expect, it } from 'vitest';
import { Interface } from 'ethers';
import {
  ERC721_OWNER_OF_SELECTOR,
  ERC721_SAFE_TRANSFER_FROM_SELECTOR,
  encodeErc721OwnerOf,
  encodeErc721SafeTransferFrom,
} from '../src/erc721.js';
import {
  ERC1155_BALANCE_OF_SELECTOR,
  ERC1155_SAFE_TRANSFER_FROM_SELECTOR,
  encodeErc1155BalanceOf,
  encodeErc1155SafeTransferFrom,
  substituteErc1155Id,
} from '../src/erc1155.js';
import {
  NftIndexerHttpError,
  alchemyNftOwnershipProvider,
  mapAlchemyOwnedNft,
  normalizeNftBaseUrl,
  parseDecimalUint256,
  verifyNftOwnershipEndpoint,
  type NftHttpFetch,
} from '../src/nft-indexer.js';
import { toHex } from '../src/encoding.js';

// Human-readable ABI fragments written from the ERC-721 / ERC-1155 texts
// (ethereum/ERCs ERCS/erc-721.md and erc-1155.md). ethers computes its own
// selectors from these, independently of the engine's keccak call.
const erc721 = new Interface([
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);
const erc1155 = new Interface([
  'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
]);

const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const B = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const BIG_ID = 34454361969670104802583458346517400542074712368450903800518897101070583190115n;
const MAX = (1n << 256n) - 1n;

describe('ERC-721 calldata vs ethers', () => {
  it('pins the computed selectors against ethers', () => {
    expect(toHex(ERC721_SAFE_TRANSFER_FROM_SELECTOR)).toBe(
      erc721.getFunction('safeTransferFrom(address,address,uint256)')!.selector,
    );
    expect(toHex(ERC721_OWNER_OF_SELECTOR)).toBe(erc721.getFunction('ownerOf')!.selector);
  });

  it('encodes safeTransferFrom identically, including ids above 2^53 and max uint256', () => {
    for (const id of [0n, 1n, 9007199254740993n, BIG_ID, MAX]) {
      expect(toHex(encodeErc721SafeTransferFrom(A, B, id))).toBe(
        erc721.encodeFunctionData('safeTransferFrom(address,address,uint256)', [A, B, id]),
      );
    }
  });

  it('encodes ownerOf identically and rejects out-of-range ids', () => {
    expect(toHex(encodeErc721OwnerOf(BIG_ID))).toBe(erc721.encodeFunctionData('ownerOf', [BIG_ID]));
    expect(() => encodeErc721SafeTransferFrom(A, B, -1n)).toThrow(/uint256/);
    expect(() => encodeErc721OwnerOf(MAX + 1n)).toThrow(/uint256/);
  });
});

describe('ERC-1155 calldata vs ethers', () => {
  it('pins the computed selectors against ethers', () => {
    expect(toHex(ERC1155_SAFE_TRANSFER_FROM_SELECTOR)).toBe(
      erc1155.getFunction('safeTransferFrom')!.selector,
    );
    expect(toHex(ERC1155_BALANCE_OF_SELECTOR)).toBe(erc1155.getFunction('balanceOf')!.selector);
  });

  it('encodes safeTransferFrom with empty and non-empty data identically', () => {
    expect(toHex(encodeErc1155SafeTransferFrom(A, B, BIG_ID, 26n))).toBe(
      erc1155.encodeFunctionData('safeTransferFrom', [A, B, BIG_ID, 26n, '0x']),
    );
    const data = new Uint8Array(37).map((_, i) => i + 1);
    expect(toHex(encodeErc1155SafeTransferFrom(A, B, 7n, MAX, data))).toBe(
      erc1155.encodeFunctionData('safeTransferFrom', [A, B, 7n, MAX, toHex(data)]),
    );
  });

  it('encodes balanceOf identically; refuses a zero amount', () => {
    expect(toHex(encodeErc1155BalanceOf(A, BIG_ID))).toBe(
      erc1155.encodeFunctionData('balanceOf', [A, BIG_ID]),
    );
    expect(() => encodeErc1155SafeTransferFrom(A, B, 1n, 0n)).toThrow(/greater than zero/);
  });

  it('substitutes {id} exactly as the standard example shows', () => {
    // ERC-1155 Metadata section: id 314592 (0x4CCE0).
    expect(substituteErc1155Id('https://token-cdn-domain/{id}.json', 314592n)).toBe(
      'https://token-cdn-domain/000000000000000000000000000000000000000000000000000000000004cce0.json',
    );
    expect(substituteErc1155Id('ipfs://cid/{id}/{id}', 1n)).toBe(
      `ipfs://cid/${'1'.padStart(64, '0')}/${'1'.padStart(64, '0')}`,
    );
    expect(substituteErc1155Id('https://x/7.json', 7n)).toBe('https://x/7.json');
  });
});

// ---------------------------------------------------------------------------
// Alchemy getNFTsForOwner adapter. Fixtures follow the documented example
// response plus the shapes observed in the 2026-10-01 live probe.
// ---------------------------------------------------------------------------

const DUSK = {
  contract: {
    address: '0x0bEed7099AF7514cCEDF642CfEA435731176Fb02',
    name: 'DuskBreakers',
    symbol: 'DUSK',
    totalSupply: '10000',
    tokenType: 'ERC721',
    openSeaMetadata: { collectionName: 'DuskBreakers' },
    isSpam: null,
  },
  tokenId: '28',
  tokenType: 'ERC721',
  name: 'DuskBreaker #28',
  description: 'Breakers have the honor of serving humanity.',
  image: {
    cachedUrl: 'https://nft-cdn.alchemy.com/eth-mainnet/1f9e8be3feb42b5b66452537a4032668',
    thumbnailUrl: 'https://res.cloudinary.com/alchemyapi/image/upload/thumbnailv2/eth-mainnet/1f9e',
    pngUrl: 'https://res.cloudinary.com/alchemyapi/image/upload/convert-png/eth-mainnet/1f9e',
    contentType: 'image/png',
    size: 1474037,
    originalUrl: 'https://duskbreakers.gg/breaker_images/28.png',
  },
  raw: {
    tokenUri: 'https://api.duskbreakers.gg/metadata/duskbreakers/28',
    metadata: { name: 'DuskBreaker #28', image: 'https://duskbreakers.gg/breaker_images/28.png' },
    error: null,
  },
  collection: { name: 'DuskBreakers', slug: 'duskbreakers' },
  tokenUri: 'https://api.duskbreakers.gg/metadata/duskbreakers/28',
  balance: '1',
};

const WEI_NAME = {
  ...DUSK,
  contract: {
    address: '0x0000000000696760e15f265e828db644a0c242eb',
    name: 'Wei Name Service',
    tokenType: 'ERC721',
    isSpam: false,
  },
  tokenId: BIG_ID.toString(),
  name: 'vitalik.wei',
  image: { ...DUSK.image, contentType: 'image/svg+xml', originalUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
  collection: { name: 'Wei Name Service' },
};

const KNIGHT_1155 = {
  contract: {
    address: '0x209cE666978779756Ae1E747608cD93e4dFf45fD',
    name: 'Knight of Chains Genesis',
    tokenType: 'ERC1155',
    openseaMetadata: { collectionName: 'Knight of Chains Genesis.' },
    isSpam: 'true',
  },
  tokenId: '97',
  tokenType: 'ERC1155',
  name: null,
  description: null,
  image: { cachedUrl: null, thumbnailUrl: null, pngUrl: null, contentType: null, originalUrl: null },
  raw: { tokenUri: 'https://knightsofchain.link/ipfs/97', metadata: {}, error: null },
  tokenUri: 'https://knightsofchain.link/ipfs/97',
  balance: '18446744073709551617',
};

function fakeFetch(
  pages: Record<string, unknown>,
  status = 200,
): { fetchFn: NftHttpFetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchFn: async (url) => {
      urls.push(url);
      const key = new URL(url).searchParams.get('pageKey') ?? 'first';
      return { ok: status >= 200 && status < 300, status, json: async () => pages[key] };
    },
  };
}

const VALID_AT = {
  blockNumber: 26100003,
  blockHash: null,
  blockTimestamp: '2026-10-01T20:57:35Z',
};

describe('alchemyNftOwnershipProvider', () => {
  it('builds the documented request and maps entries exactly', async () => {
    const { fetchFn, urls } = fakeFetch({
      first: { ownedNfts: [DUSK, WEI_NAME, KNIGHT_1155], totalCount: 3, validAt: VALID_AT, pageKey: 'abc-123' },
    });
    const provider = alchemyNftOwnershipProvider('https://eth-mainnet.g.alchemy.com/nft/v3/KEY/', {
      fetchFn,
      pageSize: 50,
    });
    const page = await provider.getOwnedNfts(A);
    expect(urls[0]).toBe(
      `https://eth-mainnet.g.alchemy.com/nft/v3/KEY/getNFTsForOwner?owner=${A}&withMetadata=true&pageSize=50`,
    );
    expect(page.skipped).toBe(0);
    expect(page.totalCount).toBe(3);
    expect(page.nextCursor).toBe('abc-123');
    expect(page.validAt).toEqual({
      blockNumber: 26100003n,
      blockHash: null,
      blockTimestamp: '2026-10-01T20:57:35Z',
    });

    const [dusk, wei, knight] = page.nfts;
    expect(dusk).toMatchObject({
      contract: '0x0bEed7099AF7514cCEDF642CfEA435731176Fb02',
      tokenId: 28n,
      standard: 'erc721',
      balance: 1n,
      name: 'DuskBreaker #28',
      collectionName: 'DuskBreakers',
      contractSymbol: 'DUSK',
      tokenUri: 'https://api.duskbreakers.gg/metadata/duskbreakers/28',
      metadataMissing: false,
      spam: null,
    });
    expect(dusk!.media.pngUrl).toBe(DUSK.image.pngUrl);
    expect(dusk!.media.metadataImage).toBe('https://duskbreakers.gg/breaker_images/28.png');

    // > 2^53 token id, exact; lowercase address checksummed; boolean isSpam.
    expect(wei!.tokenId).toBe(BIG_ID);
    expect(wei!.contract).toBe('0x0000000000696760E15f265e828DB644A0c242EB');
    expect(wei!.spam).toBe(false);
    expect(wei!.media.contentType).toBe('image/svg+xml');

    // ERC-1155: exact balance above 2^64, string isSpam, openseaMetadata spelling.
    expect(knight).toMatchObject({
      standard: 'erc1155',
      tokenId: 97n,
      balance: 18446744073709551617n,
      name: null,
      collectionName: 'Knight of Chains Genesis.',
      metadataMissing: true,
      spam: true,
    });
  });

  it('passes the pageKey back verbatim and ends when pageKey is null', async () => {
    const { fetchFn, urls } = fakeFetch({
      first: { ownedNfts: [DUSK], pageKey: '88434286-7eaa-472d-8739-32a0497c2a18', validAt: VALID_AT },
      '88434286-7eaa-472d-8739-32a0497c2a18': { ownedNfts: [KNIGHT_1155], pageKey: null, validAt: VALID_AT },
    });
    const provider = alchemyNftOwnershipProvider('https://x.example/nft/v3/K', { fetchFn });
    const first = await provider.getOwnedNfts(A);
    const second = await provider.getOwnedNfts(A, { cursor: first.nextCursor });
    expect(urls[1]).toContain('pageKey=88434286-7eaa-472d-8739-32a0497c2a18');
    expect(urls[0]).toContain('pageSize=100');
    expect(second.nfts.map((n) => n.tokenId)).toEqual([97n]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('skips and counts entries it cannot represent exactly', () => {
    const bad = [
      { ...DUSK, tokenId: '0x1c' }, // hex id: not the documented decimal form
      { ...DUSK, tokenId: 28 }, // JSON number: precision unknowable
      { ...DUSK, tokenId: (MAX + 1n).toString() }, // out of uint256 range
      { ...DUSK, tokenType: 'NO_SUPPORTED_NFT_STANDARD', contract: { ...DUSK.contract, tokenType: 'NO_SUPPORTED_NFT_STANDARD' } },
      { ...DUSK, balance: '2' }, // ERC-721 with balance 2 is inconsistent
      { ...KNIGHT_1155, balance: undefined }, // ERC-1155 needs a balance
      { ...KNIGHT_1155, balance: '0' },
      { ...KNIGHT_1155, balance: '1.5' },
      { ...DUSK, contract: { ...DUSK.contract, address: '0x1234' } },
      null,
    ];
    for (const entry of bad) expect(mapAlchemyOwnedNft(entry)).toBeNull();
    // Contract-level tokenType is used when the top-level one is absent.
    expect(mapAlchemyOwnedNft({ ...DUSK, tokenType: undefined })?.standard).toBe('erc721');
  });

  it('turns HTTP failures into typed errors with plain messages', async () => {
    const unauthorized = alchemyNftOwnershipProvider('https://x.example/nft/v3/bad', {
      fetchFn: fakeFetch({}, 401).fetchFn,
    });
    await expect(unauthorized.getOwnedNfts(A)).rejects.toBeInstanceOf(NftIndexerHttpError);
    await expect(unauthorized.getOwnedNfts(A)).rejects.toThrow(/API key/);

    const rpcUrl = alchemyNftOwnershipProvider('https://eth-mainnet.g.alchemy.com/v2/KEY', {
      fetchFn: fakeFetch({}, 404).fetchFn,
    });
    await expect(rpcUrl.getOwnedNfts(A)).rejects.toThrow(/JSON-RPC URL/);

    const notNft = alchemyNftOwnershipProvider('https://x.example', {
      fetchFn: fakeFetch({ first: { jsonrpc: '2.0', result: '0x1' } }).fetchFn,
    });
    await expect(notNft.getOwnedNfts(A)).rejects.toThrow(/ownedNfts/);
    await expect(notNft.getOwnedNfts('vitalik.eth')).rejects.toThrow(/0x address/);
  });
});

describe('verifyNftOwnershipEndpoint', () => {
  it('requires validAt and probes with a single-entry page', async () => {
    const ok = fakeFetch({ first: { ownedNfts: [DUSK], validAt: VALID_AT, pageKey: 'more' } });
    const result = await verifyNftOwnershipEndpoint(
      alchemyNftOwnershipProvider('https://x.example/nft/v3/K', { fetchFn: ok.fetchFn }),
      A,
    );
    expect(ok.urls[0]).toContain('pageSize=1');
    expect(result.sampleCount).toBe(1);
    expect(result.validAt.blockNumber).toBe(26100003n);

    const noValidAt = fakeFetch({ first: { ownedNfts: [] } });
    await expect(
      verifyNftOwnershipEndpoint(
        alchemyNftOwnershipProvider('https://x.example/nft/v3/K', { fetchFn: noValidAt.fetchFn }),
        A,
      ),
    ).rejects.toThrow(/validAt/);
  });
});

describe('helpers', () => {
  it('parses decimal uint256 strings exactly and nothing else', () => {
    expect(parseDecimalUint256('0')).toBe(0n);
    expect(parseDecimalUint256(MAX.toString())).toBe(MAX);
    expect(parseDecimalUint256((MAX + 1n).toString())).toBeNull();
    expect(parseDecimalUint256('-1')).toBeNull();
    expect(parseDecimalUint256(' 1')).toBeNull();
    expect(parseDecimalUint256(1)).toBeNull();
  });

  it('normalizes pasted base URLs without inventing paths', () => {
    expect(normalizeNftBaseUrl(' https://h/nft/v3/K/getNFTsForOwner/ ')).toBe('https://h/nft/v3/K');
    expect(normalizeNftBaseUrl('https://h/v2/K')).toBe('https://h/v2/K');
  });
});

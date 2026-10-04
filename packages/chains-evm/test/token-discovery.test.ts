import { describe, expect, it } from 'vitest';
import { getAddress } from 'ethers';
import {
  TOKEN_BALANCES_MAX_PAGE_SIZE,
  TokenDiscoveryUnsupportedError,
  collectTokenBalances,
  indexerTokenBalanceProvider,
  isMethodUnsupportedError,
  parseTokenBalancesResult,
} from '../src/token-discovery.js';
import type { JsonRpcTransport } from '../src/rpc.js';

/**
 * Fixtures follow the result shape documented at
 * https://www.alchemy.com/docs/data/token-api/token-api-endpoints/alchemy-get-token-balances
 * plus what live read-only probes showed on 2026-10-04: lower-case
 * addresses, 32-byte hex balances, zero balances included, and a `pageKey`
 * (the last contract of the page) only while more entries exist.
 */

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const SEPOLIA_USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const SEPOLIA_EURC = '0x08210f9170f89ab7658f0b5e3ff39b0e03c594d4';
const SEPOLIA_WETH = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';

const word = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;

interface Call {
  method: string;
  params: unknown[];
}

function fakeTransport(pages: Record<string, unknown>, calls: Call[] = []): JsonRpcTransport {
  return async (method, params) => {
    calls.push({ method, params });
    const options = params[2] as { pageKey?: string };
    const key = options?.pageKey ?? 'first';
    if (!(key in pages)) throw new Error(`unexpected pageKey ${key}`);
    return pages[key];
  };
}

describe('alchemy_getTokenBalances request', () => {
  it('sends [owner, "erc20", {maxCount}] and caps maxCount at the documented 100', async () => {
    const calls: Call[] = [];
    const provider = indexerTokenBalanceProvider(
      fakeTransport({ first: { address: ME.toLowerCase(), tokenBalances: [] } }, calls),
    );
    await provider.page(ME, { pageSize: 500 });
    expect(calls).toEqual([
      { method: 'alchemy_getTokenBalances', params: [ME, 'erc20', { maxCount: TOKEN_BALANCES_MAX_PAGE_SIZE }] },
    ]);
    expect(TOKEN_BALANCES_MAX_PAGE_SIZE).toBe(100);
  });

  it('passes the cursor back as options.pageKey', async () => {
    const calls: Call[] = [];
    const provider = indexerTokenBalanceProvider(
      fakeTransport({ [SEPOLIA_USDC]: { address: ME, tokenBalances: [] } }, calls),
    );
    await provider.page(ME, { cursor: SEPOLIA_USDC, pageSize: 3 });
    expect(calls[0]!.params[2]).toEqual({ maxCount: 3, pageKey: SEPOLIA_USDC });
  });

  it('refuses an owner that is not an address before any request', async () => {
    const calls: Call[] = [];
    const provider = indexerTokenBalanceProvider(fakeTransport({}, calls));
    await expect(provider.page('0x1234')).rejects.toThrow(/Not an EVM address/);
    expect(calls).toHaveLength(0);
  });
});

describe('parseTokenBalancesResult', () => {
  it('parses exact bigint balances, checksums contracts, keeps zero entries and the pageKey', () => {
    const big = (1n << 255n) + 12345n; // far above 2^53: must stay exact
    const page = parseTokenBalancesResult(
      {
        address: ME.toLowerCase(),
        tokenBalances: [
          { contractAddress: SEPOLIA_EURC, tokenBalance: word(0x2717c55n) },
          { contractAddress: SEPOLIA_USDC, tokenBalance: word(big) },
          { contractAddress: SEPOLIA_WETH, tokenBalance: word(0n) },
        ],
        pageKey: SEPOLIA_WETH,
      },
      ME,
    );
    expect(page.balances).toEqual([
      { contract: getAddress(SEPOLIA_EURC), balance: 0x2717c55n },
      { contract: getAddress(SEPOLIA_USDC), balance: big },
      { contract: getAddress(SEPOLIA_WETH), balance: 0n },
    ]);
    expect(page.failures).toEqual([]);
    expect(page.nextCursor).toBe(SEPOLIA_WETH);
  });

  it('treats a missing or empty pageKey as the last page', () => {
    expect(parseTokenBalancesResult({ tokenBalances: [] }, ME).nextCursor).toBeNull();
    expect(parseTokenBalancesResult({ tokenBalances: [], pageKey: '' }, ME).nextCursor).toBeNull();
  });

  it('reports per-entry errors and malformed entries without guessing a balance', () => {
    const page = parseTokenBalancesResult(
      {
        tokenBalances: [
          { contractAddress: SEPOLIA_USDC, tokenBalance: null, error: 'execution reverted' },
          { contractAddress: SEPOLIA_EURC, tokenBalance: word(5n), error: { message: 'both set' } },
          { contractAddress: SEPOLIA_WETH, tokenBalance: '12' },
          { contractAddress: SEPOLIA_WETH, tokenBalance: `0x${'f'.repeat(65)}` },
          { contractAddress: '0x1234', tokenBalance: word(1n) },
          { tokenBalance: word(1n) },
          null,
        ],
      },
      ME,
    );
    expect(page.balances).toEqual([]);
    expect(page.failures.map((f) => f.contract)).toEqual([
      getAddress(SEPOLIA_USDC),
      getAddress(SEPOLIA_EURC),
      getAddress(SEPOLIA_WETH),
      getAddress(SEPOLIA_WETH),
      null,
      null,
      null,
    ]);
    expect(page.failures[0]!.reason).toBe('execution reverted');
    expect(page.failures[1]!.reason).toBe('both set');
    expect(page.failures[3]!.reason).toMatch(/not a hex uint256/);
  });

  it('accepts a short hex balance (fewer than 64 digits) exactly', () => {
    const page = parseTokenBalancesResult(
      { tokenBalances: [{ contractAddress: SEPOLIA_USDC, tokenBalance: '0x0' }, { contractAddress: SEPOLIA_EURC, tokenBalance: '0xde0b6b3a7640000' }] },
      ME,
    );
    expect(page.balances.map((b) => b.balance)).toEqual([0n, 10n ** 18n]);
  });

  it('throws on an answer for another address or without a tokenBalances array', () => {
    expect(() =>
      parseTokenBalancesResult({ address: SEPOLIA_USDC, tokenBalances: [] }, ME),
    ).toThrow(/answered for/);
    expect(() => parseTokenBalancesResult({ address: ME }, ME)).toThrow(/no tokenBalances array/);
    expect(() => parseTokenBalancesResult(null, ME)).toThrow(/no result object/);
    expect(() => parseTokenBalancesResult([], ME)).toThrow(/no result object/);
  });
});

describe('unsupported endpoints', () => {
  it('maps -32601 and "Unsupported method" answers to TokenDiscoveryUnsupportedError', async () => {
    const notFound = Object.assign(new Error('RPC error -32601: the method alchemy_getTokenBalances does not exist/is not available'), { code: -32601 });
    const alchemyStyle = new Error('RPC error -32600: Unsupported method: alchemy_getTokenBalances (alchemy_getTokenBalances)');
    for (const err of [notFound, alchemyStyle]) {
      const provider = indexerTokenBalanceProvider(async () => {
        throw err;
      });
      await expect(provider.page(ME)).rejects.toBeInstanceOf(TokenDiscoveryUnsupportedError);
    }
  });

  it('passes other failures through unchanged (network not enabled, HTTP errors)', async () => {
    const disabled = new Error('RPC error -32600: BASE_SEPOLIA is not enabled for this app. (alchemy_getTokenBalances)');
    expect(isMethodUnsupportedError(disabled)).toBe(false);
    const provider = indexerTokenBalanceProvider(async () => {
      throw disabled;
    });
    await expect(provider.page(ME)).rejects.toBe(disabled);
    expect(isMethodUnsupportedError(new Error('RPC HTTP error 503 for alchemy_getTokenBalances'))).toBe(false);
  });
});

describe('collectTokenBalances', () => {
  it('walks every page, hides zero balances, dedupes contracts and reports completeness', async () => {
    const provider = indexerTokenBalanceProvider(
      fakeTransport({
        first: {
          tokenBalances: [
            { contractAddress: SEPOLIA_EURC, tokenBalance: word(7n) },
            { contractAddress: SEPOLIA_WETH, tokenBalance: word(0n) },
          ],
          pageKey: SEPOLIA_WETH,
        },
        [SEPOLIA_WETH]: {
          tokenBalances: [
            { contractAddress: SEPOLIA_EURC, tokenBalance: word(999n) },
            { contractAddress: SEPOLIA_USDC, tokenBalance: word(36000000n) },
            { contractAddress: SEPOLIA_USDC, tokenBalance: null, error: 'x' },
          ],
        },
      }),
    );
    const out = await collectTokenBalances(provider, ME, { pageSize: 2 });
    expect(out.holdings).toEqual([
      { contract: getAddress(SEPOLIA_EURC), balance: 7n },
      { contract: getAddress(SEPOLIA_USDC), balance: 36000000n },
    ]);
    expect(out.zeroCount).toBe(1);
    expect(out.failures).toHaveLength(1);
    expect(out.complete).toBe(true);
    expect(out.pages).toBe(2);
  });

  it('stops at maxPages and says the list is incomplete', async () => {
    let n = 0;
    const provider = indexerTokenBalanceProvider(async () => ({
      tokenBalances: [{ contractAddress: `0x${(++n).toString(16).padStart(40, '0')}`, tokenBalance: word(1n) }],
      pageKey: `k${n}`,
    }));
    const out = await collectTokenBalances(provider, ME, { maxPages: 3 });
    expect(out.pages).toBe(3);
    expect(out.holdings).toHaveLength(3);
    expect(out.complete).toBe(false);
  });

  it('stops on a repeated cursor instead of looping, and reports incomplete', async () => {
    let calls = 0;
    const provider = indexerTokenBalanceProvider(async () => {
      calls += 1;
      return { tokenBalances: [], pageKey: 'same' };
    });
    const out = await collectTokenBalances(provider, ME, { maxPages: 10 });
    expect(calls).toBe(2);
    expect(out.complete).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { zeroExSwapProvider, type SwapQuoteRequest } from '../src/swap.js';

const REQUEST: SwapQuoteRequest = {
  chainId: 1n,
  sellToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  buyToken: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  sellAmount: 100_000_000n, // 100 USDC
  taker: '0x1111111111111111111111111111111111111111',
  slippageBps: 50,
};

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return { ok: status === 200, status, json: async () => body } as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

const GOOD_BODY = {
  liquidityAvailable: true,
  sellAmount: '100000000',
  buyAmount: '38912345678901234567',
  minBuyAmount: '38717783950506728234',
  transaction: {
    to: '0x2222222222222222222222222222222222222222',
    data: '0xdeadbeef',
    value: '0',
    gas: '285000',
  },
};

describe('zeroExSwapProvider', () => {
  it('sends the documented params and headers, parses exact bigints', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: GOOD_BODY }));
    const provider = zeroExSwapProvider({ apiKey: 'test-key', fetchFn });
    const result = await provider.getQuote(REQUEST);

    const { url, init } = calls[0]!;
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://api.0x.org/swap/allowance-holder/quote');
    expect(parsed.searchParams.get('chainId')).toBe('1');
    expect(parsed.searchParams.get('sellAmount')).toBe('100000000');
    expect(parsed.searchParams.get('taker')).toBe(REQUEST.taker);
    expect(parsed.searchParams.get('slippageBps')).toBe('50');
    const headers = init!.headers as Record<string, string>;
    expect(headers['0x-api-key']).toBe('test-key');
    expect(headers['0x-version']).toBe('v2');

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 38912345678901234567 exceeds 2^53: exact bigint parsing matters.
      expect(result.quote.buyAmount).toBe(38_912_345_678_901_234_567n);
      expect(result.quote.minBuyAmount).toBe(38_717_783_950_506_728_234n);
      expect(result.quote.transaction.gas).toBe(285_000n);
      expect(result.quote.transaction.value).toBe(0n);
    }
  });

  it('reports no-liquidity distinctly from errors', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      body: { liquidityAvailable: false },
    }));
    const result = await zeroExSwapProvider({ apiKey: 'k', fetchFn }).getQuote(REQUEST);
    expect(result).toEqual({ ok: false, reason: 'no-liquidity' });
  });

  it('surfaces HTTP failures and incomplete quotes as errors', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 429, body: {} }));
    const rateLimited = await zeroExSwapProvider({ apiKey: 'k', fetchFn }).getQuote(REQUEST);
    expect(rateLimited.ok).toBe(false);
    if (!rateLimited.ok) expect(rateLimited.detail).toMatch(/HTTP 429/);

    const { fetchFn: incomplete } = fakeFetch(() => ({
      status: 200,
      body: { liquidityAvailable: true, buyAmount: '1' }, // missing fields
    }));
    const bad = await zeroExSwapProvider({ apiKey: 'k', fetchFn: incomplete }).getQuote(REQUEST);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.detail).toMatch(/incomplete/);
  });
});

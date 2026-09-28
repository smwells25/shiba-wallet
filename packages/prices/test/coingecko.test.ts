import { describe, expect, it } from 'vitest';
import {
  COINGECKO_BASE_URL,
  coinGeckoPriceProvider,
  parseRetryAfter,
} from '../src/coingecko.js';
import type { FetchLike } from '../src/types.js';

const ETH = 'eip155:1/slip44:60';
const BTC = 'bip122:000000000019d6689c085ae165831e93/slip44:0';
const DOGE = 'bip122:1a91e3dace36e2be3bf030a65679fe82/slip44:3';
const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501';
const USDC = 'eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_LOWER = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WBTC = 'eip155:1/erc20:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
const WBTC_LOWER = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';

// The body recorded from the live keyless probe of 2026-09-28
// (/simple/price?ids=bitcoin,ethereum,dogecoin,solana&vs_currencies=usd
//  &include_last_updated_at=true&precision=full), verbatim.
const LIVE_NATIVE_BODY =
  '{"bitcoin":{"usd":83250.90730785819,"last_updated_at":1790610840},' +
  '"ethereum":{"usd":2675.9166588303415,"last_updated_at":1790610850},' +
  '"dogecoin":{"usd":0.09323210326398859,"last_updated_at":1790610830},' +
  '"solana":{"usd":118.48628492841699,"last_updated_at":1790610830}}';
// Recorded from the live keyless /simple/token_price/ethereum probe.
const LIVE_USDC_BODY = '{"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48":{"usd":0.99988,"last_updated_at":1790610660}}';

interface FakeResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  throws?: Error;
}

function fakeFetch(handler: (url: string) => FakeResponse) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const r = handler(url);
    if (r.throws) throw r.throws;
    const status = r.status ?? 200;
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => r.body ?? '',
    };
  };
  return { fetchFn, calls };
}

describe('coinGeckoPriceProvider: request construction', () => {
  it('prices all four natives in one keyless /simple/price call', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: LIVE_NATIVE_BODY }));
    await coinGeckoPriceProvider({ fetchFn }).getPrices([ETH, BTC, DOGE, SOL], 'USD');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${COINGECKO_BASE_URL}/simple/price?ids=ethereum,bitcoin,dogecoin,solana` +
        '&vs_currencies=usd&include_last_updated_at=true&precision=full',
    );
    expect(calls[0]!.url.startsWith('https://api.coingecko.com/api/v3/')).toBe(true);
    expect(calls[0]!.headers).toEqual({ accept: 'application/json' });
  });

  it('sends a demo key only as the x-cg-demo-api-key header', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: LIVE_NATIVE_BODY }));
    await coinGeckoPriceProvider({ fetchFn, demoApiKey: ' CG-test ' }).getPrices([ETH], 'usd');
    expect(calls[0]!.headers['x-cg-demo-api-key']).toBe('CG-test');
    expect(calls[0]!.url).not.toContain('CG-test');
    expect(calls[0]!.url).not.toContain('x_cg_demo_api_key');
  });

  it('keyless: one lowercase contract per /simple/token_price request', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: '{}' }));
    await coinGeckoPriceProvider({ fetchFn }).getPrices([USDC, WBTC], 'usd');
    expect(calls.map((c) => c.url)).toEqual([
      `${COINGECKO_BASE_URL}/simple/token_price/ethereum?contract_addresses=${USDC_LOWER}` +
        '&vs_currencies=usd&include_last_updated_at=true&precision=full',
      `${COINGECKO_BASE_URL}/simple/token_price/ethereum?contract_addresses=${WBTC_LOWER}` +
        '&vs_currencies=usd&include_last_updated_at=true&precision=full',
    ]);
  });

  it('with a demo key: contracts batched comma-separated', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: '{}' }));
    await coinGeckoPriceProvider({ fetchFn, demoApiKey: 'k' }).getPrices([USDC, WBTC], 'eur');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`contract_addresses=${USDC_LOWER},${WBTC_LOWER}&vs_currencies=eur`);
  });

  it('respects an explicit maxContractsPerRequest', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: '{}' }));
    const third = 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7';
    await coinGeckoPriceProvider({ fetchFn, maxContractsPerRequest: 2 }).getPrices(
      [USDC, WBTC, third],
      'usd',
    );
    expect(calls).toHaveLength(2);
    expect(() => coinGeckoPriceProvider({ fetchFn, maxContractsPerRequest: 0 })).toThrow();
  });

  it('natives first, then tokens; duplicates and case variants collapse to one key', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: '{}' }));
    const usdcLowerId = `eip155:1/erc20:${USDC_LOWER}`;
    await coinGeckoPriceProvider({ fetchFn }).getPrices([USDC, ETH, ETH, usdcLowerId], 'usd');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('/simple/price?ids=ethereum&');
    expect(calls[1]!.url).toContain(`contract_addresses=${USDC_LOWER}&`);
  });

  it('makes no call for assets it cannot price', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: '{}' }));
    const result = await coinGeckoPriceProvider({ fetchFn }).getPrices(
      [
        'eip155:11155111/slip44:60', // Sepolia ETH: testnet, no market price
        'eip155:137/erc20:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // unsupported platform
        'eip155:1/erc721:0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb/1234',
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'not a caip id',
        'constructor',
        '__proto__',
      ],
      'usd',
    );
    expect(calls).toHaveLength(0);
    expect(result.quotes.size).toBe(0);
    expect(result.failed.size).toBe(0);
  });

  it('rejects an invalid currency code', async () => {
    const { fetchFn } = fakeFetch(() => ({ body: '{}' }));
    await expect(coinGeckoPriceProvider({ fetchFn }).getPrices([ETH], 'us d')).rejects.toThrow();
    await expect(coinGeckoPriceProvider({ fetchFn }).getPrices([ETH], 'usd&x=1')).rejects.toThrow();
  });

  it('honors a baseUrl override with or without trailing slash', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: '{}' }));
    await coinGeckoPriceProvider({ fetchFn, baseUrl: 'https://proxy.example/cg/' }).getPrices([ETH], 'usd');
    expect(calls[0]!.url.startsWith('https://proxy.example/cg/simple/price?')).toBe(true);
  });
});

describe('coinGeckoPriceProvider: response parsing', () => {
  it('parses the recorded live native body with exact vendor digits', async () => {
    const { fetchFn } = fakeFetch(() => ({ body: LIVE_NATIVE_BODY }));
    const { quotes, failed } = await coinGeckoPriceProvider({ fetchFn }).getPrices(
      [ETH, BTC, DOGE, SOL],
      'usd',
    );
    expect(failed.size).toBe(0);
    expect(quotes.get(ETH)).toEqual({
      assetId: ETH,
      currency: 'usd',
      price: '2675.9166588303415',
      updatedAtMs: 1790610850_000,
      provider: 'coingecko',
    });
    expect(quotes.get(BTC)!.price).toBe('83250.90730785819');
    expect(quotes.get(DOGE)!.price).toBe('0.09323210326398859');
    expect(quotes.get(SOL)!.price).toBe('118.48628492841699');
  });

  it('maps the lowercase contract key back to the caller\'s checksummed asset id', async () => {
    const { fetchFn } = fakeFetch(() => ({ body: LIVE_USDC_BODY }));
    const { quotes } = await coinGeckoPriceProvider({ fetchFn }).getPrices([USDC], 'usd');
    expect(quotes.get(USDC)).toEqual({
      assetId: USDC,
      currency: 'usd',
      price: '0.99988',
      updatedAtMs: 1790610660_000,
      provider: 'coingecko',
    });
  });

  it('keeps tiny exponent-notation prices exact', async () => {
    const { fetchFn } = fakeFetch(() => ({ body: '{"ethereum":{"usd":1.2345e-9}}' }));
    const { quotes } = await coinGeckoPriceProvider({ fetchFn }).getPrices([ETH], 'usd');
    expect(quotes.get(ETH)!.price).toBe('0.0000000012345');
    expect(quotes.get(ETH)!.updatedAtMs).toBeUndefined();
  });

  it('missing, empty, null, and zero entries are absent, never zero', async () => {
    // Live behaviour: an unsupported vs_currency returns {"ethereum":{}}.
    const { fetchFn } = fakeFetch(() => ({
      body: '{"ethereum":{},"bitcoin":{"usd":null},"dogecoin":{"usd":0,"last_updated_at":1},"unrequested":{"usd":5}}',
    }));
    const { quotes, failed } = await coinGeckoPriceProvider({ fetchFn }).getPrices(
      [ETH, BTC, DOGE, SOL],
      'usd',
    );
    expect(quotes.size).toBe(0);
    expect(failed.size).toBe(0);
  });

  it('only reads the requested currency', async () => {
    const { fetchFn } = fakeFetch(() => ({ body: '{"ethereum":{"usd":2000,"eur":1800.5}}' }));
    const { quotes } = await coinGeckoPriceProvider({ fetchFn }).getPrices([ETH], 'EUR');
    expect(quotes.get(ETH)).toMatchObject({ currency: 'eur', price: '1800.5' });
  });

  it.each([
    ['top-level array', '[{"usd":1}]'],
    ['entry is a string', '{"ethereum":"2000"}'],
    ['price is a string', '{"ethereum":{"usd":"2000"}}'],
    ['price is negative', '{"ethereum":{"usd":-1}}'],
    ['price is an object', '{"ethereum":{"usd":{"v":1}}}'],
    ['timestamp is fractional', '{"ethereum":{"usd":1,"last_updated_at":1.5}}'],
    ['timestamp is a string', '{"ethereum":{"usd":1,"last_updated_at":"1790610850"}}'],
    ['invalid JSON', '{"ethereum":{"usd":1}'],
    ['HTML page', '<html>busy</html>'],
    ['empty body', ''],
    ['error envelope with HTTP 200', '{"status":{"error_code":429,"error_message":"slow down"}}'],
  ])('rejects a malformed response (%s) as failed, not absent', async (_label, body) => {
    const { fetchFn } = fakeFetch(() => ({ body }));
    const { quotes, failed } = await coinGeckoPriceProvider({ fetchFn }).getPrices([ETH, BTC], 'usd');
    expect(quotes.size).toBe(0);
    expect(failed.get(ETH)?.kind).toBe('malformed');
    expect(failed.get(BTC)?.kind).toBe('malformed');
  });
});

describe('coinGeckoPriceProvider: failures', () => {
  it('HTTP 429 is rate-limited with Retry-After, and later requests are skipped', async () => {
    const { fetchFn, calls } = fakeFetch((url) =>
      url.includes('/simple/price')
        ? {
            status: 429,
            headers: { 'Retry-After': '30' },
            body: '{"status":{"error_code":429,"error_message":"You\'ve exceeded the Rate Limit."}}',
          }
        : { body: LIVE_USDC_BODY },
    );
    const { quotes, failed } = await coinGeckoPriceProvider({ fetchFn }).getPrices([ETH, USDC], 'usd');
    expect(calls).toHaveLength(1);
    expect(quotes.size).toBe(0);
    expect(failed.get(ETH)).toMatchObject({ kind: 'rate-limited', status: 429, retryAfterMs: 30_000 });
    expect(failed.get(USDC)?.kind).toBe('rate-limited');
  });

  it('HTTP 429 without Retry-After leaves retryAfterMs undefined', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 429, body: '{}' }));
    const { failed } = await coinGeckoPriceProvider({ fetchFn }).getPrices([ETH], 'usd');
    expect(failed.get(ETH)?.kind).toBe('rate-limited');
    expect(failed.get(ETH)?.retryAfterMs).toBeUndefined();
  });

  it('other HTTP errors fail only their own request; the rest still price', async () => {
    // Recorded live: more than one contract without a key -> HTTP 400, 10012.
    const { fetchFn } = fakeFetch((url) =>
      url.includes('/simple/token_price')
        ? { status: 400, body: '{"error_code":10012,"status":{"error_message":"exceeds the allowed limit of 1 contract address"}}' }
        : { body: LIVE_NATIVE_BODY },
    );
    const { quotes, failed } = await coinGeckoPriceProvider({ fetchFn }).getPrices([ETH, USDC], 'usd');
    expect(quotes.get(ETH)!.price).toBe('2675.9166588303415');
    expect(failed.get(USDC)).toMatchObject({ kind: 'http', status: 400 });
    expect(failed.has(ETH)).toBe(false);
  });

  it('a throwing transport is a network failure', async () => {
    const { fetchFn } = fakeFetch(() => ({ throws: new TypeError('Network request failed') }));
    const { failed } = await coinGeckoPriceProvider({ fetchFn }).getPrices([ETH], 'usd');
    expect(failed.get(ETH)?.kind).toBe('network');
    expect(failed.get(ETH)?.message).toContain('Network request failed');
  });

  it('no call at all for an empty request', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ body: '{}' }));
    const result = await coinGeckoPriceProvider({ fetchFn }).getPrices([], 'usd');
    expect(calls).toHaveLength(0);
    expect(result.quotes.size + result.failed.size).toBe(0);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  it('parses delta-seconds and HTTP-dates', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter('Mon, 28 Sep 2026 12:01:30 GMT', now)).toBe(90_000);
    expect(parseRetryAfter('Mon, 28 Sep 2026 11:00:00 GMT', now)).toBe(0);
  });
  it('returns undefined for absent or garbage values', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { cachedPriceProvider } from '../src/cache.js';
import { coinGeckoPriceProvider } from '../src/coingecko.js';
import {
  PriceError,
  type FetchLike,
  type PriceProvider,
  type PriceQuote,
  type PriceResult,
} from '../src/types.js';

const ETH = 'eip155:1/slip44:60';
const BTC = 'bip122:000000000019d6689c085ae165831e93/slip44:0';
const UNKNOWN = 'eip155:1/erc721:0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb/1';

type Behavior = 'ok' | 'network' | 'rate-limited' | 'throw';

/** A scriptable inner provider with a manual clock and call log. */
function harness(prices: Record<string, string>) {
  let t = 1_000_000;
  let behavior: Behavior = 'ok';
  let retryAfterMs: number | undefined;
  const releases: Array<() => void> = [];
  let gated = false;
  const calls: Array<{ assetIds: string[]; currency: string }> = [];

  const inner: PriceProvider = {
    name: 'fake',
    async getPrices(assetIds, currency): Promise<PriceResult> {
      calls.push({ assetIds: [...assetIds], currency });
      if (gated) await new Promise<void>((resolve) => releases.push(resolve));
      const result: PriceResult = { quotes: new Map(), failed: new Map() };
      if (behavior === 'throw') throw new Error('provider exploded');
      for (const id of assetIds) {
        if (behavior === 'network') {
          result.failed.set(id, new PriceError('network', 'offline'));
        } else if (behavior === 'rate-limited') {
          result.failed.set(
            id,
            new PriceError('rate-limited', '429', {
              status: 429,
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            }),
          );
        } else if (prices[id] !== undefined) {
          const quote: PriceQuote = { assetId: id, currency, price: prices[id]!, provider: 'fake' };
          result.quotes.set(id, quote);
        }
      }
      return result;
    },
  };

  return {
    inner,
    calls,
    now: () => t,
    advance: (ms: number) => (t += ms),
    setBehavior: (b: Behavior, retryAfter?: number) => {
      behavior = b;
      retryAfterMs = retryAfter;
    },
    gate: () => (gated = true),
    open: () => {
      gated = false;
      for (const release of releases.splice(0)) release();
    },
  };
}

describe('cachedPriceProvider: TTL', () => {
  it('serves fresh values without calling the vendor, refetches after TTL', async () => {
    const h = harness({ [ETH]: '2000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });

    const first = await cache.getPrices([ETH], 'usd');
    expect(first.quotes.get(ETH)).toMatchObject({ price: '2000', fetchedAtMs: 1_000_000 });
    expect(first.quotes.get(ETH)!.stale).toBeUndefined();

    h.advance(59_999);
    await cache.getPrices([ETH], 'USD'); // currency normalised to the same key
    expect(h.calls).toHaveLength(1);

    h.advance(1);
    const third = await cache.getPrices([ETH], 'usd');
    expect(h.calls).toHaveLength(2);
    expect(third.quotes.get(ETH)!.fetchedAtMs).toBe(1_060_000);
  });

  it('keys by currency', async () => {
    const h = harness({ [ETH]: '2000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    await cache.getPrices([ETH], 'usd');
    await cache.getPrices([ETH], 'eur');
    expect(h.calls.map((c) => c.currency)).toEqual(['usd', 'eur']);
  });

  it('only fetches the expired or missing part of a request', async () => {
    const h = harness({ [ETH]: '2000', [BTC]: '80000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    await cache.getPrices([ETH], 'usd');
    const both = await cache.getPrices([ETH, BTC], 'usd');
    expect(h.calls[1]!.assetIds).toEqual([BTC]);
    expect(both.quotes.size).toBe(2);
  });

  it('caches "cannot price" answers for the TTL too', async () => {
    const h = harness({ [ETH]: '2000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    const r1 = await cache.getPrices([UNKNOWN], 'usd');
    const r2 = await cache.getPrices([UNKNOWN], 'usd');
    expect(h.calls).toHaveLength(1);
    expect(r1.quotes.size + r1.failed.size + r2.quotes.size + r2.failed.size).toBe(0);
  });

  it('validates options', () => {
    const h = harness({});
    expect(() => cachedPriceProvider(h.inner, { ttlMs: -1 })).toThrow();
    expect(() => cachedPriceProvider(h.inner, { ttlMs: 60_000, maxStaleMs: 1_000 })).toThrow();
    expect(() => cachedPriceProvider(h.inner, { ttlMs: 1, backoffBaseMs: 0 })).toThrow();
  });
});

describe('cachedPriceProvider: stale-on-error', () => {
  it('serves the last value flagged stale within maxStaleMs, then reports failure', async () => {
    const h = harness({ [ETH]: '2000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, maxStaleMs: 300_000, now: h.now });
    await cache.getPrices([ETH], 'usd');

    h.setBehavior('network');
    h.advance(120_000);
    const stale = await cache.getPrices([ETH], 'usd');
    expect(stale.quotes.get(ETH)).toMatchObject({ price: '2000', stale: true, fetchedAtMs: 1_000_000 });
    expect(stale.failed.size).toBe(0);

    h.advance(180_000); // exactly maxStaleMs old: still served
    expect((await cache.getPrices([ETH], 'usd')).quotes.get(ETH)?.stale).toBe(true);

    h.advance(1); // beyond maxStaleMs
    const gone = await cache.getPrices([ETH], 'usd');
    expect(gone.quotes.size).toBe(0);
    expect(gone.failed.get(ETH)?.kind).toBe('network');
  });

  it('a failure with nothing cached is reported as failed', async () => {
    const h = harness({ [ETH]: '2000' });
    h.setBehavior('network');
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    const r = await cache.getPrices([ETH], 'usd');
    expect(r.failed.get(ETH)?.kind).toBe('network');
  });

  it('recovery replaces the stale value with a fresh one', async () => {
    const h = harness({ [ETH]: '2000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    await cache.getPrices([ETH], 'usd');
    h.setBehavior('network');
    h.advance(60_000);
    expect((await cache.getPrices([ETH], 'usd')).quotes.get(ETH)?.stale).toBe(true);
    h.setBehavior('ok');
    const fresh = await cache.getPrices([ETH], 'usd');
    expect(fresh.quotes.get(ETH)!.stale).toBeUndefined();
    expect(fresh.quotes.get(ETH)!.fetchedAtMs).toBe(1_060_000);
  });

  it('a throwing provider is contained as a per-asset network failure', async () => {
    const h = harness({ [ETH]: '2000' });
    h.setBehavior('throw');
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    const r = await cache.getPrices([ETH, BTC], 'usd');
    expect(r.failed.get(ETH)).toMatchObject({ kind: 'network', message: 'provider exploded' });
    expect(r.failed.get(BTC)?.kind).toBe('network');
  });
});

describe('cachedPriceProvider: in-flight dedupe', () => {
  it('concurrent identical requests share one vendor call', async () => {
    const h = harness({ [ETH]: '2000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    h.gate();
    const a = cache.getPrices([ETH], 'usd');
    const b = cache.getPrices([ETH], 'usd');
    await Promise.resolve();
    h.open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(h.calls).toHaveLength(1);
    expect(ra.quotes.get(ETH)!.price).toBe('2000');
    expect(rb.quotes.get(ETH)!.price).toBe('2000');
  });

  it('overlapping requests only fetch what is not already in flight', async () => {
    const h = harness({ [ETH]: '2000', [BTC]: '80000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    h.gate();
    const a = cache.getPrices([ETH], 'usd');
    const b = cache.getPrices([ETH, BTC], 'usd');
    // Both vendor calls are issued synchronously and are now parked.
    expect(h.calls.map((c) => c.assetIds)).toEqual([[ETH], [BTC]]);
    h.open();
    const [, rb] = await Promise.all([a, b]);
    expect(h.calls.map((c) => c.assetIds)).toEqual([[ETH], [BTC]]);
    expect(rb.quotes.size).toBe(2);
  });

  it('a new call after the in-flight one settles goes to the cache, not the vendor', async () => {
    const h = harness({ [ETH]: '2000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    await Promise.all([cache.getPrices([ETH], 'usd'), cache.getPrices([ETH], 'usd')]);
    await cache.getPrices([ETH], 'usd');
    expect(h.calls).toHaveLength(1);
  });
});

describe('cachedPriceProvider: 429 backoff', () => {
  it('backs off exponentially without Retry-After and resets after success', async () => {
    const h = harness({ [ETH]: '2000' });
    const cache = cachedPriceProvider(h.inner, {
      ttlMs: 60_000,
      now: h.now,
      backoffBaseMs: 60_000,
      backoffMaxMs: 150_000,
    });

    h.setBehavior('rate-limited');
    const first = await cache.getPrices([ETH], 'usd');
    expect(first.failed.get(ETH)?.kind).toBe('rate-limited');
    expect(cache.backoffUntilMs()).toBe(1_060_000);

    // Inside the window: no vendor call, rate-limited with the remaining wait.
    h.advance(30_000);
    const paused = await cache.getPrices([ETH], 'usd');
    expect(h.calls).toHaveLength(1);
    expect(paused.failed.get(ETH)).toMatchObject({ kind: 'rate-limited', retryAfterMs: 30_000 });

    // Window over: one more call, second consecutive 429 doubles the wait.
    h.advance(30_000);
    await cache.getPrices([ETH], 'usd');
    expect(h.calls).toHaveLength(2);
    expect(cache.backoffUntilMs()).toBe(1_060_000 + 120_000);

    // Third consecutive 429 is capped at backoffMaxMs.
    h.advance(120_000);
    await cache.getPrices([ETH], 'usd');
    expect(cache.backoffUntilMs()).toBe(1_180_000 + 150_000);

    // Success resets the doubling.
    h.advance(150_000);
    h.setBehavior('ok');
    expect((await cache.getPrices([ETH], 'usd')).quotes.get(ETH)!.price).toBe('2000');
    h.advance(60_000);
    h.setBehavior('rate-limited');
    await cache.getPrices([ETH], 'usd');
    expect(cache.backoffUntilMs()).toBe(h.now() + 60_000);
  });

  it('honors a vendor Retry-After', async () => {
    const h = harness({ [ETH]: '2000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    h.setBehavior('rate-limited', 5_000);
    await cache.getPrices([ETH], 'usd');
    expect(cache.backoffUntilMs()).toBe(1_005_000);
    h.advance(5_000);
    h.setBehavior('ok');
    await cache.getPrices([ETH], 'usd');
    expect(h.calls).toHaveLength(2);
  });

  it('serves stale values during backoff', async () => {
    const h = harness({ [ETH]: '2000', [BTC]: '80000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    await cache.getPrices([ETH], 'usd');
    h.advance(60_000);
    h.setBehavior('rate-limited');
    const r = await cache.getPrices([ETH, BTC], 'usd');
    expect(r.quotes.get(ETH)).toMatchObject({ price: '2000', stale: true });
    expect(r.failed.get(BTC)?.kind).toBe('rate-limited');

    h.advance(10_000); // inside backoff: still stale, still no call
    const r2 = await cache.getPrices([ETH], 'usd');
    expect(r2.quotes.get(ETH)?.stale).toBe(true);
    expect(h.calls).toHaveLength(2);
  });

  it('clear() drops values and backoff', async () => {
    const h = harness({ [ETH]: '2000' });
    const cache = cachedPriceProvider(h.inner, { ttlMs: 60_000, now: h.now });
    h.setBehavior('rate-limited');
    await cache.getPrices([ETH], 'usd');
    cache.clear();
    expect(cache.backoffUntilMs()).toBe(0);
    h.setBehavior('ok');
    expect((await cache.getPrices([ETH], 'usd')).quotes.get(ETH)!.price).toBe('2000');
  });
});

describe('cachedPriceProvider over the CoinGecko adapter', () => {
  it('end to end: fetch, cache, 429 -> stale, backoff honored', async () => {
    let t = 0;
    let status = 200;
    const urls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      urls.push(url);
      return {
        ok: status === 200,
        status,
        headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' && status === 429 ? '90' : null) },
        text: async () => '{"ethereum":{"usd":2675.9166588303415,"last_updated_at":1790610850}}',
      };
    };
    const cache = cachedPriceProvider(coinGeckoPriceProvider({ fetchFn, now: () => t }), {
      ttlMs: 60_000,
      now: () => t,
    });
    expect(cache.name).toBe('coingecko');
    expect((await cache.getPrices([ETH], 'usd')).quotes.get(ETH)!.price).toBe('2675.9166588303415');
    t = 30_000;
    await cache.getPrices([ETH], 'usd');
    expect(urls).toHaveLength(1);

    t = 61_000;
    status = 429;
    const limited = await cache.getPrices([ETH], 'usd');
    expect(limited.quotes.get(ETH)).toMatchObject({ stale: true, price: '2675.9166588303415' });
    expect(cache.backoffUntilMs()).toBe(61_000 + 90_000);

    t = 100_000;
    status = 200;
    await cache.getPrices([ETH], 'usd');
    expect(urls).toHaveLength(2); // still backing off

    t = 151_000;
    const fresh = await cache.getPrices([ETH], 'usd');
    expect(urls).toHaveLength(3);
    expect(fresh.quotes.get(ETH)!.stale).toBeUndefined();
  });
});

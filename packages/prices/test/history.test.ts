import { describe, expect, it } from 'vitest';
import {
  COINGECKO_HISTORY_MAX_DAYS,
  HISTORY_POINT_TOLERANCE_MS,
  documentedGranularity,
  fetchMarketChartRange,
  marketChartRangeUrl,
  nearestPricePoint,
  parseMarketChartBody,
} from '../src/history.js';
import { parseJsonLossless } from '../src/json.js';
import { PriceError, type FetchLike } from '../src/types.js';

// The first three price points of a live keyless probe of 2026-10-12
// (/coins/ethereum/market_chart/range, a 3-day range, precision=full),
// verbatim; market_caps and total_volumes trimmed to one point each.
const LIVE_BODY =
  '{"prices":[[1791518400000,2491.7034609181637],[1791522000000,2485.655005877573],' +
  '[1791525600000,2489.7536347781065]],"market_caps":[[1791518400000,300760000000.1]],' +
  '"total_volumes":[[1791518400000,15000000000.5]]}';

// The refusal recorded live on 2026-10-12 for a range starting 400 days ago.
const RANGE_REFUSAL =
  '{"error":{"status":{"timestamp":"2026-10-12T03:20:10.570+00:00","error_code":10012,' +
  '"error_message":"Your request exceeds the allowed time range. Public API users are limited to querying ' +
  'historical data within the past 365 days. Upgrade to a paid plan to enjoy full historical data access: ' +
  'https://www.coingecko.com/en/api/pricing. "}}}';

function fake(status: number, body: string) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body };
  };
  return { fetchFn, calls };
}

describe('market chart range', () => {
  it('builds the documented URL', () => {
    expect(marketChartRangeUrl({ coinId: 'ethereum', currency: 'USD', fromSec: 100, toSec: 200 })).toBe(
      'https://api.coingecko.com/api/v3/coins/ethereum/market_chart/range?vs_currency=usd&from=100&to=200&precision=full',
    );
    expect(() => marketChartRangeUrl({ coinId: 'eth/../x', currency: 'usd', fromSec: 1, toSec: 2 })).toThrow();
    expect(() => marketChartRangeUrl({ coinId: 'ethereum', currency: 'usd', fromSec: 5, toSec: 5 })).toThrow();
  });

  it('parses the live body digit for digit', async () => {
    const { fetchFn, calls } = fake(200, LIVE_BODY);
    const points = await fetchMarketChartRange({ coinId: 'ethereum', currency: 'usd', fromSec: 1, toSec: 2 }, { fetchFn });
    expect(points).toEqual([
      { timeMs: 1791518400000, price: '2491.7034609181637' },
      { timeMs: 1791522000000, price: '2485.655005877573' },
      { timeMs: 1791525600000, price: '2489.7536347781065' },
    ]);
    expect(calls[0]!.headers['x-cg-demo-api-key']).toBeUndefined();
  });

  it('sends a Demo key only as the header', async () => {
    const { fetchFn, calls } = fake(200, LIVE_BODY);
    await fetchMarketChartRange({ coinId: 'ethereum', currency: 'usd', fromSec: 1, toSec: 2 }, { fetchFn, demoApiKey: 'k' });
    expect(calls[0]!.headers['x-cg-demo-api-key']).toBe('k');
    expect(calls[0]!.url).not.toContain('k&');
  });

  it('names the 365-day limit on the recorded refusal', async () => {
    const { fetchFn } = fake(401, RANGE_REFUSAL);
    const error = await fetchMarketChartRange({ coinId: 'ethereum', currency: 'usd', fromSec: 1, toSec: 2 }, { fetchFn }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PriceError);
    expect((error as PriceError).status).toBe(401);
    expect((error as PriceError).message).toContain(`past ${COINGECKO_HISTORY_MAX_DAYS} days`);
  });

  it('reports 429 as rate-limited', async () => {
    const { fetchFn } = fake(429, '');
    const error = await fetchMarketChartRange({ coinId: 'bitcoin', currency: 'usd', fromSec: 1, toSec: 2 }, { fetchFn }).catch(
      (e: unknown) => e,
    );
    expect((error as PriceError).kind).toBe('rate-limited');
  });

  it('refuses malformed bodies instead of half-trusting them', () => {
    expect(() => parseMarketChartBody(parseJsonLossless('{}'))).toThrow(PriceError);
    expect(() => parseMarketChartBody(parseJsonLossless('{"prices":[[1,2,3]]}'))).toThrow(PriceError);
    expect(() => parseMarketChartBody(parseJsonLossless('{"prices":[[1.5,2]]}'))).toThrow(PriceError);
    expect(() => parseMarketChartBody(parseJsonLossless('{"prices":[[1,"2"]]}'))).toThrow(PriceError);
    expect(() => parseMarketChartBody(parseJsonLossless('{"prices":[[1,-2]]}'))).toThrow(PriceError);
  });

  it('sorts, de-duplicates and drops zero prices', () => {
    const points = parseMarketChartBody(parseJsonLossless('{"prices":[[3,1.5],[1,2],[3,1.25],[2,0]]}'));
    expect(points).toEqual([
      { timeMs: 1, price: '2' },
      { timeMs: 3, price: '1.25' },
    ]);
  });
});

describe('granularity and nearest point', () => {
  const now = 1_800_000_000;
  it('follows the documented automatic granularity', () => {
    expect(documentedGranularity(now - 3_600, now, now)).toBe('5-minute');
    expect(documentedGranularity(now - 86_400 * 3, now, now)).toBe('hourly');
    expect(documentedGranularity(now - 86_400 * 90, now, now)).toBe('hourly');
    expect(documentedGranularity(now - 86_400 * 91, now, now)).toBe('daily');
    expect(documentedGranularity(now - 86_400 - 7_200, now - 7_200, now)).toBe('hourly');
  });

  it('picks the nearest point within the tolerance only', () => {
    const points = [
      { timeMs: 0, price: '1' },
      { timeMs: 3_600_000, price: '2' },
    ];
    expect(nearestPricePoint(points, 1_000_000, HISTORY_POINT_TOLERANCE_MS.hourly)?.price).toBe('1');
    expect(nearestPricePoint(points, 1_800_000, HISTORY_POINT_TOLERANCE_MS.hourly)?.price).toBe('1');
    expect(nearestPricePoint(points, 2_000_000, HISTORY_POINT_TOLERANCE_MS.hourly)?.price).toBe('2');
    expect(nearestPricePoint(points, 3_600_000 + HISTORY_POINT_TOLERANCE_MS.hourly, HISTORY_POINT_TOLERANCE_MS.hourly)?.price).toBe('2');
    expect(nearestPricePoint(points, 3_600_001 + HISTORY_POINT_TOLERANCE_MS.hourly, HISTORY_POINT_TOLERANCE_MS.hourly)).toBeNull();
    expect(nearestPricePoint([], 0, 1)).toBeNull();
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COINGECKO_HISTORY_MAX_DAYS,
  HISTORY_POINT_TOLERANCE_MS,
  documentedGranularity,
  fetchMarketChartRange,
  fetchTokenMarketChartRange,
  marketChartRangeUrl,
  nearestPricePoint,
  parseMarketChartBody,
  tokenMarketChartRangeUrl,
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

// ONE keyless answer recorded on 2026-10-26 04:20:38 UTC (see the module
// comment of src/history.ts): GET /coins/ethereum/contract/<mainnet USDC>/
// market_chart/range?vs_currency=usd&from=1792713600&to=1792886400&precision=full,
// HTTP 200, saved byte for byte. No key was sent and the file holds none.
const HERE = dirname(fileURLToPath(import.meta.url));
const USDC_FIXTURE = 'coingecko-usdc-ethereum-contract-range-2026-10-23.json';
const USDC_BODY = readFileSync(join(HERE, 'fixtures', USDC_FIXTURE), 'utf8');
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

describe('token market chart range (by asset platform and contract)', () => {
  it('reads the recorded fixture unchanged', () => {
    expect(createHash('sha256').update(USDC_BODY).digest('hex')).toBe(
      '1823c7e309055ebe4e4e58499063959cf54b45e56a43f6fc25b2109a409dc24f',
    );
    expect(/[0-9a-fA-F]{32,}/.test(USDC_BODY)).toBe(false);
  });

  it('builds the documented path with the contract lowercased', () => {
    expect(
      tokenMarketChartRangeUrl({ platformId: 'ethereum', contract: USDC, currency: 'USD', fromSec: 1792713600, toSec: 1792886400 }),
    ).toBe(
      'https://api.coingecko.com/api/v3/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' +
        '/market_chart/range?vs_currency=usd&from=1792713600&to=1792886400&precision=full',
    );
    const bad = (over: Partial<Parameters<typeof tokenMarketChartRangeUrl>[0]>) => () =>
      tokenMarketChartRangeUrl({ platformId: 'ethereum', contract: USDC, currency: 'usd', fromSec: 1, toSec: 2, ...over });
    expect(bad({ platformId: 'eth/../x' })).toThrow();
    expect(bad({ platformId: '' })).toThrow();
    expect(bad({ contract: USDC.slice(0, 41) })).toThrow();
    expect(bad({ contract: `${USDC}/../x` })).toThrow();
    expect(bad({ contract: 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' })).toThrow();
    expect(bad({ fromSec: 5, toSec: 5 })).toThrow();
  });

  it('parses the recorded answer digit for digit: 49 hourly points, ascending', async () => {
    const { fetchFn, calls } = fake(200, USDC_BODY);
    const points = await fetchTokenMarketChartRange(
      { platformId: 'ethereum', contract: USDC, currency: 'usd', fromSec: 1792713600, toSec: 1792886400 },
      { fetchFn },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/market_chart/range?');
    expect(calls[0]!.headers['x-cg-demo-api-key']).toBeUndefined();
    expect(points).toHaveLength(49);
    expect(points[0]).toEqual({ timeMs: 1792713600000, price: '0.9995158052936925' });
    expect(points[1]).toEqual({ timeMs: 1792717200000, price: '0.9994997037521707' });
    expect(points[48]).toEqual({ timeMs: 1792886400000, price: '0.9995300448283739' });
    for (let i = 1; i < points.length; i++) expect(points[i]!.timeMs - points[i - 1]!.timeMs).toBe(3_600_000);
    // The same body through the coin-id parser gives the same points (one shape).
    expect(parseMarketChartBody(parseJsonLossless(USDC_BODY))).toEqual(points);
  });

  it('refuses a malformed answer instead of half-trusting it', async () => {
    // The recorded answer with one price turned into a string.
    const broken = USDC_BODY.replace('[1792717200000,0.9994997037521707]', '[1792717200000,"0.9994997037521707"]');
    expect(broken).not.toBe(USDC_BODY);
    const { fetchFn } = fake(200, broken);
    const error = await fetchTokenMarketChartRange(
      { platformId: 'ethereum', contract: USDC, currency: 'usd', fromSec: 1, toSec: 2 },
      { fetchFn },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PriceError);
    expect((error as PriceError).kind).toBe('malformed');
    const { fetchFn: noPrices } = fake(200, '{"market_caps":[],"total_volumes":[]}');
    await expect(
      fetchTokenMarketChartRange({ platformId: 'ethereum', contract: USDC, currency: 'usd', fromSec: 1, toSec: 2 }, { fetchFn: noPrices }),
    ).rejects.toMatchObject({ kind: 'malformed' });
    const { fetchFn: notJson } = fake(200, USDC_BODY.slice(0, 200));
    await expect(
      fetchTokenMarketChartRange({ platformId: 'ethereum', contract: USDC, currency: 'usd', fromSec: 1, toSec: 2 }, { fetchFn: notJson }),
    ).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('reports HTTP errors, the 365-day refusal and 429 like the coin form', async () => {
    const { fetchFn } = fake(401, RANGE_REFUSAL);
    const refused = await fetchTokenMarketChartRange(
      { platformId: 'ethereum', contract: USDC, currency: 'usd', fromSec: 1, toSec: 2 },
      { fetchFn },
    ).catch((e: unknown) => e);
    expect((refused as PriceError).message).toContain(`past ${COINGECKO_HISTORY_MAX_DAYS} days`);
    const { fetchFn: limited } = fake(429, '');
    await expect(
      fetchTokenMarketChartRange({ platformId: 'ethereum', contract: USDC, currency: 'usd', fromSec: 1, toSec: 2 }, { fetchFn: limited }),
    ).rejects.toMatchObject({ kind: 'rate-limited' });
    const { fetchFn: missing } = fake(404, '{"error":"coin not found"}');
    await expect(
      fetchTokenMarketChartRange({ platformId: 'ethereum', contract: USDC, currency: 'usd', fromSec: 1, toSec: 2 }, { fetchFn: missing }),
    ).rejects.toMatchObject({ kind: 'http', status: 404 });
  });
});

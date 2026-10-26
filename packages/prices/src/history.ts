/**
 * Historical prices from CoinGecko's public ("Demo / Keyless") API, for the
 * wallet's profit-and-loss view (feature 97).
 *
 * Verified 2026-10-12 against CoinGecko's official documentation:
 *
 * - GET /coins/{id}/market_chart/range?vs_currency=..&from=..&to=..
 *   &precision=full is listed for the Demo / Keyless API ("Coin Charts"
 *   section of https://docs.coingecko.com/demo/reference/endpoint-overview.md).
 *   `from` and `to` are UNIX timestamps (the page also accepts ISO dates);
 *   the answer is { prices: [[unix ms, price], ...], market_caps: [...],
 *   total_volumes: [...] }:
 *   https://docs.coingecko.com/demo/reference/coins-id-market-chart-range.md
 * - Automatic granularity when `interval` is not given: 1 day from the
 *   current time → 5-minutely; 1 day from any other time → hourly; 2–90
 *   days → hourly; above 90 days → daily (00:00 UTC). Same page.
 * - "Historical data via the Demo API is restricted to the past 365 days."
 *   Same page (and the /coins/{id}/history page).
 * - Cache / update frequency of this endpoint: every 5 minutes. Same page.
 * - Rate limits: Demo plan 100 calls/min; keyless is "IP-based rate
 *   limiting — shared across all users on the same IP"; every request counts,
 *   4xx and 5xx included: https://docs.coingecko.com/docs/errors-and-rate-limits.md
 *
 * Observed in live keyless probes on 2026-10-12 (not in the docs):
 *
 * - A 30-day and a 3-day range answered hourly points exactly 3,600,000 ms
 *   apart; a 200-day range answered daily points 86,400,000 ms apart. The
 *   newest hourly point of a range ending "now" was about 2 h 25 min old.
 * - A range starting 400 days ago answered HTTP 401 with
 *   {"error":{"status":{"error_code":10012,"error_message":"Your request
 *   exceeds the allowed time range. Public API users are limited to querying
 *   historical data within the past 365 days. ..."}}}.
 *
 * The TOKEN form (phase 23 item 8, second slice), read 2026-10-26 04:19 UTC
 * from CoinGecko's official documentation:
 *
 * - https://docs.coingecko.com/demo/reference/endpoint-overview.md, "Coin
 *   Charts" (the Demo / Keyless list): "| /coins/{id}/contract
 *   /{contract_address}/market_chart/range | Historical chart data within a
 *   time range by asset platform and token contract address |".
 * - https://docs.coingecko.com/demo/reference/contract-address-market-chart-range.md
 *   (OpenAPI "get /coins/{id}/contract/{contract_address}/market_chart/range",
 *   server https://api.coingecko.com/api/v3): path `id` "Asset platform ID.
 *   *refers to /asset_platforms", path `contract_address` "The contract
 *   address of token.", query `vs_currency` (required), `from` and `to`
 *   (required, "Starting date in UNIX timestamp." / "Ending date in UNIX
 *   timestamp."), `precision` (optional, "full" or 0–18); the answer is the
 *   same CoinsMarketChart object as the coin-id range ("prices",
 *   "market_caps", "total_volumes", each "[timestamp, value] pairs"). The
 *   page states the same auto-granularity table ("1 day from current time |
 *   5-minutely", "1 day from any other time | hourly", "2–90 days | hourly",
 *   "Above 90 days | daily (00:00 UTC)") and "Historical data via the Demo
 *   API is restricted to the past 365 days."; its "Cache / Update
 *   Frequency:" line is EMPTY in the fetched page (the coin-id page's is now
 *   empty too), so the 5-minute cache figure above is not re-confirmed.
 * - Asset platform ids, from ONE keyless GET /asset_platforms answer of
 *   2026-10-26 04:20 UTC (470 platforms; "chain_identifier" is "Chainlist's
 *   chain ID" per the asset-platforms-list page): chain 1 → "ethereum",
 *   8453 → "base", 42161 → "arbitrum-one", 10 → "optimistic-ethereum". Only
 *   "ethereum" is used (coingecko.ts COINGECKO_TOKEN_PLATFORMS, the same
 *   table the spot token price uses); the wallet has no Base, Arbitrum One
 *   or OP Mainnet profile, so those three are recorded here and not mapped.
 * - Rate limits as above (https://docs.coingecko.com/docs/errors-and-rate-limits.md,
 *   re-read the same day: "Demo plan: 100 calls/min.", "Keyless (no API
 *   key): IP-based rate limiting — shared across all users on the same IP.",
 *   "All requests count toward your per-minute rate limit — including 4xx
 *   and 5xx errors.").
 * - Recorded keyless answer (the fixture
 *   test/fixtures/coingecko-usdc-ethereum-contract-range-2026-10-23.json):
 *   mainnet USDC 0xa0b8…eb48 on "ethereum", from 1792713600 (2026-10-23
 *   00:00 UTC) to 1792886400 (2026-10-25 00:00 UTC), precision=full: HTTP
 *   200, 49 price points exactly 3,600,000 ms apart from the first second
 *   to the last, keys prices / market_caps / total_volumes; response
 *   headers cache-control "max-age=30, public, must-revalidate,
 *   s-maxage=300" (observed, not documented).
 *
 * Prices are kept as the vendor's decimal literal, digit for digit, through
 * the lossless JSON parser (as the spot-price adapter does); they remain
 * indicative market prices, never execution prices.
 */

import { isZeroDecimal, jsonNumberToDecimal } from './decimal.js';
import { isJsonNumber, isJsonObject, parseJsonLossless, type JsonValue } from './json.js';
import { COINGECKO_BASE_URL, COINGECKO_DEMO_KEY_HEADER } from './coingecko.js';
import { PriceError, normalizeCurrency, type FetchLike } from './types.js';

/** The documented look-back limit of the Demo / Keyless API, in days. */
export const COINGECKO_HISTORY_MAX_DAYS = 365;

/** One historical price point. */
export interface HistoricalPricePoint {
  /** Unix ms as the vendor reported it. */
  timeMs: number;
  /** Price of one whole unit, plain non-negative decimal (vendor digits). */
  price: string;
}

/** The granularity CoinGecko documents for a range (automatic granularity). */
export type HistoryGranularity = '5-minute' | 'hourly' | 'daily';

/**
 * The granularity CoinGecko documents for a range of `fromSec`..`toSec`
 * (automatic granularity, no `interval` parameter): up to one day ending
 * now → 5-minutely; up to 90 days → hourly; above 90 days → daily.
 * `nowSec` decides whether a one-day range ends "now" (within an hour).
 */
export function documentedGranularity(fromSec: number, toSec: number, nowSec: number): HistoryGranularity {
  const span = toSec - fromSec;
  if (span <= 86_400 && nowSec - toSec <= 3_600) return '5-minute';
  if (span <= 90 * 86_400) return 'hourly';
  return 'daily';
}

/**
 * How far from a transaction's time the nearest point may be and still be
 * used as "the price at that time", per granularity. A judgement: half the
 * spacing plus the lag of the newest point seen live (about 2 h 25 min for
 * hourly data), rounded up.
 */
export const HISTORY_POINT_TOLERANCE_MS: Readonly<Record<HistoryGranularity, number>> = {
  '5-minute': 15 * 60_000,
  hourly: 3 * 3_600_000,
  daily: 36 * 3_600_000,
};

export interface MarketChartRangeRequest {
  /** CoinGecko coin id, e.g. "ethereum". */
  coinId: string;
  /** Fiat currency code, e.g. "usd". */
  currency: string;
  /** Unix seconds. */
  fromSec: number;
  /** Unix seconds. */
  toSec: number;
}

/** A token's range, by CoinGecko asset platform and contract address. */
export interface TokenMarketChartRangeRequest {
  /** CoinGecko asset platform id, e.g. "ethereum" (see the module comment). */
  platformId: string;
  /** The token contract, 0x + 40 hex digits in any case; sent lowercase. */
  contract: string;
  /** Fiat currency code, e.g. "usd". */
  currency: string;
  /** Unix seconds. */
  fromSec: number;
  /** Unix seconds. */
  toSec: number;
}

export interface MarketChartRangeConfig {
  fetchFn?: FetchLike;
  demoApiKey?: string;
  baseUrl?: string;
}

const COIN_ID_RE = /^[a-z0-9-]{1,80}$/;

const CONTRACT_RE = /^0x[0-9a-fA-F]{40}$/;

/** The query string shared by both range forms: currency, whole seconds, full precision. */
function rangeQuery(currency: string, fromSec: number, toSec: number): string {
  const vs = normalizeCurrency(currency);
  const from = Math.floor(fromSec);
  const to = Math.floor(toSec);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
    throw new Error('Invalid time range');
  }
  return `?vs_currency=${encodeURIComponent(vs)}&from=${from}&to=${to}&precision=full`;
}

/** The request URL for a range (exported for the tests). */
export function marketChartRangeUrl(request: MarketChartRangeRequest, baseUrl: string = COINGECKO_BASE_URL): string {
  if (!COIN_ID_RE.test(request.coinId)) throw new Error(`Invalid CoinGecko coin id: ${JSON.stringify(request.coinId)}`);
  const query = rangeQuery(request.currency, request.fromSec, request.toSec);
  return `${baseUrl.replace(/\/+$/, '')}/coins/${request.coinId}/market_chart/range${query}`;
}

/**
 * The request URL for a token's range by asset platform and contract
 * (exported for the tests): /coins/{platform}/contract/{contract}/market_chart/range,
 * the contract lowercased (the case the vendor's own examples use).
 */
export function tokenMarketChartRangeUrl(
  request: TokenMarketChartRangeRequest,
  baseUrl: string = COINGECKO_BASE_URL,
): string {
  if (!COIN_ID_RE.test(request.platformId)) {
    throw new Error(`Invalid CoinGecko asset platform id: ${JSON.stringify(request.platformId)}`);
  }
  if (!CONTRACT_RE.test(request.contract)) throw new Error(`Invalid token contract address: ${JSON.stringify(request.contract)}`);
  const query = rangeQuery(request.currency, request.fromSec, request.toSec);
  return (
    `${baseUrl.replace(/\/+$/, '')}/coins/${request.platformId}/contract/${request.contract.toLowerCase()}` +
    `/market_chart/range${query}`
  );
}

/**
 * Fetches the price points of one coin over a range. Throws a PriceError
 * ('rate-limited', 'http', 'network', 'malformed'); an HTTP 401 whose body
 * carries CoinGecko's error code 10012 (the 365-day limit) is reported as
 * 'http' with status 401 and a message saying so.
 */
export async function fetchMarketChartRange(
  request: MarketChartRangeRequest,
  config: MarketChartRangeConfig = {},
): Promise<HistoricalPricePoint[]> {
  return fetchChart(marketChartRangeUrl(request, config.baseUrl ?? COINGECKO_BASE_URL), config);
}

/**
 * Fetches the price points of one TOKEN over a range, by asset platform and
 * contract, with exactly the rules of fetchMarketChartRange (the same
 * errors, the same strict parser). The answer does not repeat the contract,
 * so the caller must key any cache by platform AND contract.
 */
export async function fetchTokenMarketChartRange(
  request: TokenMarketChartRangeRequest,
  config: MarketChartRangeConfig = {},
): Promise<HistoricalPricePoint[]> {
  return fetchChart(tokenMarketChartRangeUrl(request, config.baseUrl ?? COINGECKO_BASE_URL), config);
}

async function fetchChart(url: string, config: MarketChartRangeConfig): Promise<HistoricalPricePoint[]> {
  const fetchFn: FetchLike = config.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const headers: Record<string, string> = { accept: 'application/json' };
  const key = config.demoApiKey?.trim();
  if (key) headers[COINGECKO_DEMO_KEY_HEADER] = key;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(url, { method: 'GET', headers });
  } catch (err) {
    throw new PriceError('network', `CoinGecko request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (response.status === 429) {
    throw new PriceError('rate-limited', 'CoinGecko rate limit exceeded (HTTP 429)', { status: 429 });
  }
  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    if (response.ok) {
      throw new PriceError('network', `CoinGecko response unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!response.ok) {
    const rangeLimit = response.status === 401 && /"error_code"\s*:\s*10012\b/.test(text);
    throw new PriceError(
      'http',
      rangeLimit
        ? `CoinGecko refused the range: its free API serves only the past ${COINGECKO_HISTORY_MAX_DAYS} days (HTTP 401, error 10012)`
        : `CoinGecko answered HTTP ${response.status}`,
      { status: response.status },
    );
  }
  let body: JsonValue;
  try {
    body = parseJsonLossless(text);
  } catch (err) {
    throw new PriceError('malformed', `CoinGecko response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseMarketChartBody(body);
}

/**
 * Parses a market_chart (or market_chart/range) body into ascending,
 * de-duplicated price points. Strict: a body without a `prices` array, or
 * a point that is not [integer ms, non-negative number], throws a
 * 'malformed' PriceError so a half-understood answer is never used. Points
 * with a zero price are dropped (no usable market data at that time).
 */
export function parseMarketChartBody(body: JsonValue): HistoricalPricePoint[] {
  if (!isJsonObject(body)) throw new PriceError('malformed', 'CoinGecko chart is not a JSON object');
  const prices = body.get('prices');
  if (!Array.isArray(prices)) throw new PriceError('malformed', 'CoinGecko chart has no prices array');
  const byTime = new Map<number, string>();
  for (const point of prices) {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new PriceError('malformed', 'CoinGecko chart point is not a [time, price] pair');
    }
    const [rawTime, rawPrice] = point;
    if (!isJsonNumber(rawTime) || !/^\d+$/.test(rawTime.literal)) {
      throw new PriceError('malformed', 'CoinGecko chart time is not a whole number of milliseconds');
    }
    const timeMs = Number(rawTime.literal);
    if (!Number.isSafeInteger(timeMs)) throw new PriceError('malformed', 'CoinGecko chart time is out of range');
    if (!isJsonNumber(rawPrice)) throw new PriceError('malformed', 'CoinGecko chart price is not a number');
    let price: string;
    try {
      price = jsonNumberToDecimal(rawPrice.literal);
    } catch (err) {
      throw new PriceError('malformed', `CoinGecko chart price: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (isZeroDecimal(price)) continue;
    byTime.set(timeMs, price);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([timeMs, price]) => ({ timeMs, price }));
}

/**
 * The point nearest to `timeMs` (ties go to the earlier point), or null when
 * the nearest one is farther than `toleranceMs`. `points` must be ascending
 * (parseMarketChartBody returns them so).
 */
export function nearestPricePoint(
  points: readonly HistoricalPricePoint[],
  timeMs: number,
  toleranceMs: number,
): HistoricalPricePoint | null {
  if (points.length === 0) return null;
  // Binary search for the first point at or after timeMs.
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.timeMs < timeMs) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < points.length ? points[lo]! : null;
  const before = lo > 0 ? points[lo - 1]! : null;
  let best: HistoricalPricePoint | null = null;
  if (before && after) best = timeMs - before.timeMs <= after.timeMs - timeMs ? before : after;
  else best = before ?? after;
  if (!best || Math.abs(best.timeMs - timeMs) > toleranceMs) return null;
  return best;
}

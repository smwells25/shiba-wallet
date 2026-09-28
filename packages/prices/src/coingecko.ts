/**
 * CoinGecko price adapter over the public ("Demo / Keyless") API.
 *
 * Verified 2026-09-28 against CoinGecko's current official documentation:
 *
 * - Root URL https://api.coingecko.com/api/v3 for the Demo plan AND for
 *   keyless calls (the Pro plan uses pro-api.coingecko.com instead):
 *   https://docs.coingecko.com/demo/reference/authentication.md and
 *   https://docs.coingecko.com/demo/reference/endpoint-overview.md
 *   ("Complete list of endpoints available in the Demo / Keyless API").
 * - Optional Demo key: header `x-cg-demo-api-key` (recommended by the docs;
 *   the query-string alternative is deliberately not used so the key never
 *   appears in URLs or logs). The key is supplied by the caller at runtime
 *   and is never defaulted or stored here.
 * - GET /simple/price?ids=..&vs_currencies=..&include_last_updated_at=true
 *   &precision=full, response { "<coin id>": { "<currency>": number,
 *   "last_updated_at": unix seconds } }:
 *   https://docs.coingecko.com/demo/reference/simple-price.md
 * - GET /simple/token_price/{asset platform id}?contract_addresses=..
 *   &vs_currencies=..&include_last_updated_at=true&precision=full, response
 *   keyed by lowercase contract address with the same inner shape:
 *   https://docs.coingecko.com/demo/reference/simple-token-price.md
 * - Rate limits: Demo plan 100 calls/min; keyless is "IP-based rate
 *   limiting — shared across all users on the same IP", with no published
 *   number; every request counts, including 4xx/5xx answers; 429 means the
 *   limit was exceeded: https://docs.coingecko.com/docs/errors-and-rate-limits.md
 * - Vendor cache: prices refresh every 60 s on the Demo / Keyless API.
 *
 * Observed in live keyless probes on 2026-09-28 (not in the docs):
 *
 * - Keyless calls work without any header.
 * - /simple/token_price accepts only ONE contract address per keyless
 *   request (HTTP 400, error_code 10012, "exceeds the allowed limit of 1
 *   contract address ... the allowed limit may be adjusted periodically").
 *   The documented limit is 515 per request, which is what this adapter
 *   uses when a Demo key is configured (that limit was not verified live
 *   because no Demo key was available).
 * - Keyless 429s arrived after roughly six requests within one minute from
 *   a single IP, with no Retry-After header observed on the 429 body.
 * - Without `precision`, prices come back rounded to about five significant
 *   digits (e.g. 2676.3); `precision=full` returns the full float
 *   (e.g. 2675.9166588303415), so this adapter always requests it.
 */

import { isZeroDecimal, jsonNumberToDecimal } from './decimal.js';
import { isJsonNumber, isJsonObject, parseJsonLossless, type JsonValue } from './json.js';
import {
  PriceError,
  normalizeCurrency,
  type FetchLike,
  type PriceProvider,
  type PriceQuote,
  type PriceResult,
} from './types.js';

export const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';
export const COINGECKO_DEMO_KEY_HEADER = 'x-cg-demo-api-key';

/**
 * Native coins by their CAIP-19 id. The CAIP-2 chain ids and SLIP-44 coin
 * types match @shiba-wallet/core (chains/evm.ts, chains/utxo.ts,
 * chains/solana.ts). The CoinGecko coin ids were confirmed by a live
 * /simple/price call returning a price under each key. Testnet assets
 * (e.g. Sepolia ETH, eip155:11155111/slip44:60) are intentionally absent:
 * they have no market price.
 */
export const COINGECKO_NATIVE_IDS: Readonly<Record<string, string>> = {
  'eip155:1/slip44:60': 'ethereum',
  'bip122:000000000019d6689c085ae165831e93/slip44:0': 'bitcoin',
  'bip122:1a91e3dace36e2be3bf030a65679fe82/slip44:3': 'dogecoin',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501': 'solana',
};

/**
 * CoinGecko asset platform ids for ERC-20 token pricing by contract, keyed
 * by CAIP-2 chain id. "ethereum" was confirmed live with USDC.
 */
export const COINGECKO_TOKEN_PLATFORMS: Readonly<Record<string, string>> = {
  'eip155:1': 'ethereum',
};

/** Documented per-request contract limit for /simple/token_price. */
const DOCUMENTED_MAX_CONTRACTS = 515;
/** Observed keyless per-request contract limit (see module comment). */
const KEYLESS_MAX_CONTRACTS = 1;
/** Documented per-request id limit for /simple/price. */
const MAX_IDS_PER_REQUEST = 515;

const ERC20_RE = /^(eip155:\d+)\/erc20:(0x[0-9a-fA-F]{40})$/;

export interface CoinGeckoConfig {
  /** Transport; defaults to the global fetch. */
  fetchFn?: FetchLike;
  /** Optional Demo plan key, sent as the x-cg-demo-api-key header. */
  demoApiKey?: string;
  /** Override for tests or a proxy. Defaults to COINGECKO_BASE_URL. */
  baseUrl?: string;
  /**
   * Contracts per /simple/token_price request. Defaults to 1 without a key
   * (observed keyless limit) and 515 with a Demo key (documented limit).
   */
  maxContractsPerRequest?: number;
  /** Replaces COINGECKO_NATIVE_IDS (CAIP-19 id -> CoinGecko coin id). */
  nativeIds?: Readonly<Record<string, string>>;
  /** Replaces COINGECKO_TOKEN_PLATFORMS (CAIP-2 id -> asset platform id). */
  tokenPlatforms?: Readonly<Record<string, string>>;
  /** Clock for Retry-After HTTP-dates; defaults to Date.now. */
  now?: () => number;
}

interface PlannedRequest {
  url: string;
  /** Response key (coin id or lowercase address) -> requested asset ids. */
  keys: Map<string, string[]>;
}

export function coinGeckoPriceProvider(config: CoinGeckoConfig = {}): PriceProvider {
  const fetchFn: FetchLike = config.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const base = (config.baseUrl ?? COINGECKO_BASE_URL).replace(/\/+$/, '');
  const apiKey = config.demoApiKey?.trim() || undefined;
  const maxContracts =
    config.maxContractsPerRequest ?? (apiKey ? DOCUMENTED_MAX_CONTRACTS : KEYLESS_MAX_CONTRACTS);
  if (!Number.isInteger(maxContracts) || maxContracts < 1) {
    throw new Error(`Invalid maxContractsPerRequest: ${maxContracts}`);
  }
  const nativeIds = config.nativeIds ?? COINGECKO_NATIVE_IDS;
  const tokenPlatforms = config.tokenPlatforms ?? COINGECKO_TOKEN_PLATFORMS;
  const now = config.now ?? Date.now;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey) headers[COINGECKO_DEMO_KEY_HEADER] = apiKey;

  const plan = (assetIds: readonly string[], currency: string): PlannedRequest[] => {
    const coinKeys = new Map<string, string[]>();
    const tokenKeysByPlatform = new Map<string, Map<string, string[]>>();
    for (const assetId of new Set(assetIds)) {
      // Own-property check so ids like "constructor" never hit the prototype.
      const coinId = Object.prototype.hasOwnProperty.call(nativeIds, assetId)
        ? nativeIds[assetId]
        : undefined;
      if (typeof coinId === 'string') {
        push(coinKeys, coinId, assetId);
        continue;
      }
      const erc20 = ERC20_RE.exec(assetId);
      const platform =
        erc20 && Object.prototype.hasOwnProperty.call(tokenPlatforms, erc20[1]!)
          ? tokenPlatforms[erc20[1]!]
          : undefined;
      if (erc20 && typeof platform === 'string') {
        let byAddress = tokenKeysByPlatform.get(platform);
        if (!byAddress) tokenKeysByPlatform.set(platform, (byAddress = new Map()));
        push(byAddress, erc20[2]!.toLowerCase(), assetId);
      }
      // Anything else is unsupported by this provider and stays unpriced.
    }

    const common = `vs_currencies=${encodeURIComponent(currency)}&include_last_updated_at=true&precision=full`;
    const requests: PlannedRequest[] = [];
    for (const chunk of chunks([...coinKeys.keys()], MAX_IDS_PER_REQUEST)) {
      requests.push({
        url: `${base}/simple/price?ids=${chunk.map(encodeURIComponent).join(',')}&${common}`,
        keys: new Map(chunk.map((k) => [k, coinKeys.get(k)!])),
      });
    }
    for (const [platform, byAddress] of tokenKeysByPlatform) {
      for (const chunk of chunks([...byAddress.keys()], maxContracts)) {
        requests.push({
          url:
            `${base}/simple/token_price/${encodeURIComponent(platform)}` +
            `?contract_addresses=${chunk.join(',')}&${common}`,
          keys: new Map(chunk.map((k) => [k, byAddress.get(k)!])),
        });
      }
    }
    return requests;
  };

  /** Runs one request, recording quotes; returns the error if it failed. */
  const run = async (
    request: PlannedRequest,
    currency: string,
    result: PriceResult,
  ): Promise<PriceError | undefined> => {
    try {
      const body = await fetchJson(fetchFn, request.url, headers, now);
      const quotes = parseSimplePriceBody(body, request.keys, currency);
      for (const quote of quotes) result.quotes.set(quote.assetId, quote);
      return undefined;
    } catch (err) {
      const error =
        err instanceof PriceError
          ? err
          : new PriceError('network', `CoinGecko request failed: ${errorMessage(err)}`);
      markFailed(result, request, error);
      return error;
    }
  };

  return {
    name: 'coingecko',
    async getPrices(assetIds, currencyInput): Promise<PriceResult> {
      const currency = normalizeCurrency(currencyInput);
      const result: PriceResult = { quotes: new Map(), failed: new Map() };
      // Requests run one after another rather than in parallel: the keyless
      // limit is small and shared per IP, and a 429 on one request makes
      // the rest pointless, so later requests are skipped once rate-limited.
      let rateLimited: PriceError | undefined;
      for (const request of plan(assetIds, currency)) {
        if (rateLimited) {
          markFailed(result, request, rateLimited);
          continue;
        }
        const error = await run(request, currency, result);
        if (error?.kind === 'rate-limited') rateLimited = error;
      }
      return result;
    },
  };
}

async function fetchJson(
  fetchFn: FetchLike,
  url: string,
  headers: Record<string, string>,
  now: () => number,
): Promise<JsonValue> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(url, { method: 'GET', headers });
  } catch (err) {
    throw new PriceError('network', `CoinGecko request failed: ${errorMessage(err)}`);
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
    throw new PriceError('rate-limited', 'CoinGecko rate limit exceeded (HTTP 429)', {
      status: 429,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (!response.ok) {
    throw new PriceError('http', `CoinGecko answered HTTP ${response.status}`, {
      status: response.status,
    });
  }
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new PriceError('network', `CoinGecko response unreadable: ${errorMessage(err)}`);
  }
  try {
    return parseJsonLossless(text);
  } catch (err) {
    throw new PriceError('malformed', `CoinGecko response is not valid JSON: ${errorMessage(err)}`);
  }
}

/**
 * Parses a /simple/price or /simple/token_price body. `keys` maps each
 * response key the request asked for (coin id or lowercase contract address)
 * to the caller's asset ids. Keys missing from the body, entries without the
 * requested currency, null prices, and zero prices are left unpriced. A body
 * that does not have the documented shape throws a 'malformed' PriceError so
 * the whole request is reported as failed rather than half-trusted.
 */
export function parseSimplePriceBody(
  body: JsonValue,
  keys: ReadonlyMap<string, readonly string[]>,
  currency: string,
): PriceQuote[] {
  if (!isJsonObject(body)) {
    throw new PriceError('malformed', 'CoinGecko response is not a JSON object');
  }
  // A vendor error envelope delivered with HTTP 200 must not be mistaken for
  // "nothing priced".
  const status = body.get('status');
  if (!keys.has('status') && isJsonObject(status) && status.has('error_code')) {
    throw new PriceError('malformed', 'CoinGecko returned an error envelope');
  }

  const byLowerKey = new Map<string, JsonValue>();
  for (const [key, value] of body) byLowerKey.set(key.toLowerCase(), value);

  const quotes: PriceQuote[] = [];
  for (const [key, assetIds] of keys) {
    const entry = byLowerKey.get(key.toLowerCase());
    if (entry === undefined || entry === null) continue;
    if (!isJsonObject(entry)) {
      throw new PriceError('malformed', `CoinGecko entry for ${key} is not an object`);
    }
    const rawPrice = entry.get(currency);
    if (rawPrice === undefined || rawPrice === null) continue;
    if (!isJsonNumber(rawPrice)) {
      throw new PriceError('malformed', `CoinGecko price for ${key} is not a number`);
    }
    let price: string;
    try {
      price = jsonNumberToDecimal(rawPrice.literal);
    } catch (err) {
      throw new PriceError('malformed', `CoinGecko price for ${key}: ${errorMessage(err)}`);
    }
    // A zero price means the vendor has no usable market data; showing
    // "$0.00" would be a false statement about the asset's value.
    if (isZeroDecimal(price)) continue;

    let updatedAtMs: number | undefined;
    const rawUpdated = entry.get('last_updated_at');
    if (rawUpdated !== undefined && rawUpdated !== null) {
      const seconds = isJsonNumber(rawUpdated) && /^\d+$/.test(rawUpdated.literal)
        ? Number(rawUpdated.literal)
        : NaN;
      if (!Number.isSafeInteger(seconds * 1000)) {
        throw new PriceError('malformed', `CoinGecko last_updated_at for ${key} is not a Unix time`);
      }
      updatedAtMs = seconds * 1000;
    }

    for (const assetId of assetIds) {
      quotes.push({
        assetId,
        currency,
        price,
        provider: 'coingecko',
        ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
      });
    }
  }
  return quotes;
}

/**
 * Parses an HTTP Retry-After header (delta-seconds, or an HTTP-date in the
 * preferred IMF-fixdate form, per RFC 9110 sections 10.2.3 and 5.6.7) into
 * milliseconds from `nowMs`. Returns undefined when absent or unparseable;
 * the obsolete RFC 850 and asctime date forms are not accepted.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : undefined;
  }
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) {
    return undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

function markFailed(result: PriceResult, request: PlannedRequest, error: PriceError): void {
  for (const assetIds of request.keys.values()) {
    for (const assetId of assetIds) result.failed.set(assetId, error);
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

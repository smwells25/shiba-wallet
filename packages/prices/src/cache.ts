/**
 * Caching and rate-limit wrapper for any PriceProvider.
 *
 * - Fresh values (younger than ttlMs) are served without a vendor call.
 * - Concurrent requests for the same (asset, currency) share one in-flight
 *   vendor call instead of issuing duplicates.
 * - When the vendor call for an asset fails, the last good value is served
 *   instead if it is no older than maxStaleMs, marked `stale: true`;
 *   otherwise the asset is reported in `failed`.
 * - "Cannot price this asset" answers are cached for ttlMs as well, so
 *   unsupported assets do not trigger a vendor call on every refresh.
 * - After an HTTP 429 the wrapper stops calling the vendor until the backoff
 *   window ends: the vendor's Retry-After if it sent one, otherwise an
 *   exponential delay (backoffBaseMs, doubling per consecutive 429, capped at
 *   backoffMaxMs). During backoff, stale values are served where allowed and
 *   everything else is reported as rate-limited. A successful vendor answer
 *   resets the doubling.
 */

import {
  PriceError,
  normalizeCurrency,
  type PriceProvider,
  type PriceQuote,
  type PriceResult,
} from './types.js';

export interface CachedPriceProviderOptions {
  /** How long a fetched value counts as fresh. */
  ttlMs: number;
  /**
   * How old a value may be and still be served, flagged stale, when the
   * vendor call fails. Default 15 minutes. Must be >= ttlMs.
   */
  maxStaleMs?: number;
  /** Clock, injectable for tests. Default Date.now. */
  now?: () => number;
  /** First backoff after a 429 without Retry-After. Default 60 s. */
  backoffBaseMs?: number;
  /** Upper bound for the exponential backoff. Default 10 minutes. */
  backoffMaxMs?: number;
}

export interface CachedPriceProvider extends PriceProvider {
  /** Drops all cached values and any active backoff. */
  clear(): void;
  /** Unix ms until which vendor calls are suspended (0 when not backing off). */
  backoffUntilMs(): number;
}

interface CacheEntry {
  /** null records that the provider cannot price this asset. */
  quote: PriceQuote | null;
  fetchedAtMs: number;
}

type Outcome =
  | { kind: 'quote'; quote: PriceQuote }
  | { kind: 'absent' }
  | { kind: 'failed'; error: PriceError };

const DEFAULT_MAX_STALE_MS = 15 * 60_000;
const DEFAULT_BACKOFF_BASE_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 10 * 60_000;

export function cachedPriceProvider(
  inner: PriceProvider,
  options: CachedPriceProviderOptions,
): CachedPriceProvider {
  const ttlMs = options.ttlMs;
  const maxStaleMs = options.maxStaleMs ?? Math.max(DEFAULT_MAX_STALE_MS, ttlMs);
  const now = options.now ?? Date.now;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  if (!(ttlMs >= 0)) throw new Error(`Invalid ttlMs: ${ttlMs}`);
  if (!(maxStaleMs >= ttlMs)) throw new Error('maxStaleMs must be >= ttlMs');
  if (!(backoffBaseMs > 0) || !(backoffMaxMs >= backoffBaseMs)) {
    throw new Error('Invalid backoff bounds');
  }

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<Outcome>>();
  let backoffUntil = 0;
  let consecutive429 = 0;

  const keyOf = (assetId: string, currency: string): string => `${currency}\u0000${assetId}`;

  const fetchBatch = (assetIds: string[], currency: string): Map<string, Promise<Outcome>> => {
    const batch: Promise<Map<string, Outcome>> = inner
      .getPrices(assetIds, currency)
      .then((result) => absorb(result, assetIds, currency))
      .catch((err: unknown) => {
        // Providers should report failures per asset, but a throwing
        // provider must not break callers either.
        const error =
          err instanceof PriceError
            ? err
            : new PriceError('network', err instanceof Error ? err.message : String(err));
        if (error.kind === 'rate-limited') startBackoff(error);
        return new Map(assetIds.map((id): [string, Outcome] => [id, { kind: 'failed', error }]));
      });

    const perAsset = new Map<string, Promise<Outcome>>();
    for (const assetId of assetIds) {
      const key = keyOf(assetId, currency);
      const promise = batch.then((outcomes) => outcomes.get(assetId)!);
      inFlight.set(key, promise);
      void promise.finally(() => {
        if (inFlight.get(key) === promise) inFlight.delete(key);
      });
      perAsset.set(assetId, promise);
    }
    return perAsset;
  };

  const absorb = (
    result: PriceResult,
    assetIds: string[],
    currency: string,
  ): Map<string, Outcome> => {
    const fetchedAtMs = now();
    const outcomes = new Map<string, Outcome>();
    let rateLimit: PriceError | undefined;
    let anySuccess = false;
    for (const assetId of assetIds) {
      const key = keyOf(assetId, currency);
      const quote = result.quotes.get(assetId);
      const error = result.failed.get(assetId);
      if (quote) {
        const stamped: PriceQuote = { ...quote, assetId, fetchedAtMs };
        delete stamped.stale;
        cache.set(key, { quote: stamped, fetchedAtMs });
        outcomes.set(assetId, { kind: 'quote', quote: stamped });
        anySuccess = true;
      } else if (error) {
        outcomes.set(assetId, { kind: 'failed', error });
        if (error.kind === 'rate-limited') rateLimit = error;
      } else {
        cache.set(key, { quote: null, fetchedAtMs });
        outcomes.set(assetId, { kind: 'absent' });
        anySuccess = true;
      }
    }
    if (rateLimit) startBackoff(rateLimit);
    else if (anySuccess) consecutive429 = 0;
    return outcomes;
  };

  const startBackoff = (error: PriceError): void => {
    consecutive429 += 1;
    const exponential = Math.min(backoffBaseMs * 2 ** (consecutive429 - 1), backoffMaxMs);
    const delay = error.retryAfterMs ?? exponential;
    backoffUntil = Math.max(backoffUntil, now() + delay);
  };

  return {
    name: inner.name,

    async getPrices(assetIdsInput, currencyInput): Promise<PriceResult> {
      const currency = normalizeCurrency(currencyInput);
      const assetIds = [...new Set(assetIdsInput)];
      const t = now();
      const pending = new Map<string, Promise<Outcome> | Outcome>();
      const toFetch: string[] = [];

      for (const assetId of assetIds) {
        const key = keyOf(assetId, currency);
        const entry = cache.get(key);
        if (entry && t - entry.fetchedAtMs < ttlMs) {
          pending.set(
            assetId,
            entry.quote ? { kind: 'quote', quote: entry.quote } : { kind: 'absent' },
          );
          continue;
        }
        const shared = inFlight.get(key);
        if (shared) pending.set(assetId, shared);
        else toFetch.push(assetId);
      }

      if (toFetch.length > 0) {
        if (t < backoffUntil) {
          const error = new PriceError('rate-limited', 'Price lookups paused after a rate limit', {
            retryAfterMs: backoffUntil - t,
          });
          for (const assetId of toFetch) pending.set(assetId, { kind: 'failed', error });
        } else {
          for (const [assetId, promise] of fetchBatch(toFetch, currency)) {
            pending.set(assetId, promise);
          }
        }
      }

      const result: PriceResult = { quotes: new Map(), failed: new Map() };
      for (const [assetId, value] of pending) {
        const outcome = await value;
        if (outcome.kind === 'quote') {
          result.quotes.set(assetId, { ...outcome.quote, assetId });
        } else if (outcome.kind === 'failed') {
          const entry = cache.get(keyOf(assetId, currency));
          if (entry && now() - entry.fetchedAtMs <= maxStaleMs) {
            if (entry.quote) {
              result.quotes.set(assetId, { ...entry.quote, assetId, stale: true });
            }
            // A recent "cannot price" answer stays unpriced, not failed.
          } else {
            result.failed.set(assetId, outcome.error);
          }
        }
      }
      return result;
    },

    clear(): void {
      cache.clear();
      backoffUntil = 0;
      consecutive429 = 0;
    },

    backoffUntilMs(): number {
      return backoffUntil;
    },
  };
}

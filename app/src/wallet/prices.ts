import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  COINGECKO_BASE_URL,
  COINGECKO_DEMO_KEY_HEADER,
  cachedPriceProvider,
  coinGeckoPriceProvider,
  fiatValue,
  type CachedPriceProvider,
  type FetchLike,
  type PriceQuote,
  type PriceResult,
} from '@shiba-wallet/prices';
import {
  bitcoinKeyProvider,
  dogecoinKeyProvider,
  evmKeyProvider,
  formatAssetId,
  solanaKeyProvider,
} from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
// Explicit .ts extensions: this module is imported by scripts/check-prices.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import { DEFAULT_NETWORKS, resolveActiveNetworks } from '../config/defaults.ts';
import { maskAmount, type KeyValueStore } from '../config/prefs.ts';
import { groupThousands } from './balances.ts';

/**
 * Fiat price glue for the app (phase 6, item 2, app half) over the engine
 * package @shiba-wallet/prices (packages/prices): one shared, cached
 * CoinGecko provider, the CAIP-19 ids the app prices, the optional
 * CoinGecko Demo API-key store, and the display formatting.
 *
 * What is priced, and what never is:
 *  - native coins of the four MAINNET networks in config/defaults.ts
 *    (DEFAULT_NETWORKS), under the CAIP-19 id core itself uses for a native
 *    asset: "<CAIP-2 chain id>/slip44:<SLIP-44 coin type>" (see the examples
 *    in packages/core/src/assets/caip19.ts, and the coin types on core's key
 *    providers);
 *  - tracked ERC-20 tokens under their tracked-store CAIP-19 id verbatim
 *    (formatAssetId of the stored asset, wallet/tokens.ts);
 *  - NEVER a testnet asset. While Sepolia test mode is on, the EVM slot's
 *    active network is Sepolia, and both helpers below return null for it,
 *    so no price request is made for it and no mainnet price can ever be
 *    attached to test ETH or to a token shown on a testnet screen. (The
 *    engine also leaves "eip155:11155111/slip44:60" unpriced; this is a
 *    second, app-level guard.)
 *
 * Privacy: prices are fetched from CoinGecko (api.coingecko.com), which
 * sees the device's IP address and which assets are being priced. Settings
 * says so, and the "Show fiat values" preference (config/prefs.ts, default
 * on) turns every price request off: fetchPrices below returns before any
 * storage read or network call when it is disabled.
 *
 * Precision: amounts stay exact bigints in base units; the fiat value is
 * computed only by the engine's fiatValue (pure bigint math, one rounding
 * step). No floating-point arithmetic touches an amount or a price here.
 *
 * Deliberately free of React Native imports beyond the AsyncStorage default
 * parameter (the swap.ts / indexer.ts precedent), so scripts/check-prices.mjs
 * exercises this exact code under plain Node with a fake fetch.
 */

/** The only fiat currency this pass. */
export const PRICE_CURRENCY = 'usd';
/** Cache freshness: prices younger than this are served without a request. */
export const PRICE_TTL_MS = 120_000;
/** A failed refresh may fall back to a cached price at most this old (flagged stale). */
export const PRICE_MAX_STALE_MS = 30 * 60_000;
/**
 * A price whose vendor timestamp is older than this gets the "price from
 * N min ago" marker even when the cache did not flag it stale (for example
 * an illiquid token CoinGecko has not re-priced for a while).
 */
export const PRICE_OLD_AFTER_MS = 10 * 60_000;

const PRICE_CONFIG_KEY = 'shiba-wallet.price-config.v1';

// ---------------------------------------------------------------------------
// CAIP-19 ids
// ---------------------------------------------------------------------------

/**
 * SLIP-44 coin types by CAIP-2 chain id, read from core's key providers
 * (never restated by hand), so the native id here is always the one core
 * derives keys for.
 */
const COIN_TYPES: ReadonlyMap<string, number> = new Map(
  [evmKeyProvider, bitcoinKeyProvider, dogecoinKeyProvider, solanaKeyProvider].map(
    (p) => [p.chainId, p.coinType] as const,
  ),
);

/** CAIP-2 ids of the mainnet networks (config/defaults.ts); testnets are never listed there. */
const MAINNET_CHAIN_IDS: ReadonlySet<string> = new Set(DEFAULT_NETWORKS.map((n) => n.chainId));

/**
 * The CAIP-19 id to price a chain slot's native coin under, or null when it
 * must not be priced.
 *
 *   slotChainId           the stable slot id accounts carry (e.g. 'eip155:1')
 *   activeNetworkChainId  the network serving that slot right now
 *                         (NetworkEndpoint.network.chainId — 'eip155:11155111'
 *                         for the EVM slot in Sepolia test mode)
 *
 * Null whenever the slot is being served by a different network (test
 * mode), when the active network is not one of the mainnet networks, or
 * when core has no key provider for it.
 */
export function nativePriceAssetId(
  slotChainId: string,
  activeNetworkChainId: string,
): string | null {
  if (slotChainId !== activeNetworkChainId) return null;
  if (!MAINNET_CHAIN_IDS.has(activeNetworkChainId)) return null;
  const coinType = COIN_TYPES.get(activeNetworkChainId);
  if (coinType === undefined) return null;
  return formatAssetId({
    chainId: activeNetworkChainId,
    namespace: 'slip44',
    reference: String(coinType),
  });
}

/**
 * The CAIP-19 id to price a tracked token under (its tracked-store id
 * verbatim), or null when it must not be priced: the token is not on the
 * ACTIVE EVM chain, or the active EVM chain is not a mainnet.
 */
export function tokenPriceAssetId(token: FungibleAsset, activeEvmCaip2: string): string | null {
  if (token.assetId.chainId !== activeEvmCaip2) return null;
  if (!MAINNET_CHAIN_IDS.has(activeEvmCaip2)) return null;
  return formatAssetId(token.assetId);
}

/**
 * The native-coin price ids for every chain slot under the given mode, in
 * slot order (null where a slot must not be priced). Built on
 * resolveActiveNetworks (config/defaults.ts), the single place that maps a
 * slot to its active network, so in Sepolia test mode the EVM slot yields
 * null. Computed up front (not per loaded balance) so Home asks for all
 * natives in one request instead of one per arriving balance.
 */
export function nativePriceIds(sepolia: boolean): (string | null)[] {
  return resolveActiveNetworks(sepolia).map(({ slot, network }) =>
    nativePriceAssetId(slot, network.chainId),
  );
}

// ---------------------------------------------------------------------------
// Transport: the Demo key only ever goes to api.coingecko.com
// ---------------------------------------------------------------------------

/**
 * Wraps a fetch so a request carrying the Demo-key header is refused unless
 * it targets the CoinGecko API root. The engine adapter already sends only
 * to its base URL (which the app never overrides); this makes "the key goes
 * to api.coingecko.com and nowhere else" hold even if that ever changes.
 * The global fetch is looked up per call (not captured), so tests can swap
 * it.
 */
export function guardedCoinGeckoFetch(fetchFn?: FetchLike): FetchLike {
  return (url, init) => {
    const headers = init?.headers ?? {};
    const carriesKey = Object.keys(headers).some(
      (h) => h.toLowerCase() === COINGECKO_DEMO_KEY_HEADER,
    );
    if (carriesKey && !url.startsWith(`${COINGECKO_BASE_URL}/`)) {
      return Promise.reject(new Error('Refusing to send the CoinGecko key to another host'));
    }
    const inner = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    return inner(url, init);
  };
}

// ---------------------------------------------------------------------------
// The shared, cached provider
// ---------------------------------------------------------------------------

let shared: { apiKey: string | null; provider: CachedPriceProvider } | null = null;

/**
 * The one app-wide price provider: cachedPriceProvider over the CoinGecko
 * adapter, 120 s TTL, stale fallback up to 30 min. Rebuilt (with an empty
 * cache) whenever the Demo key changes, so a newly saved or cleared key
 * takes effect on the next refresh. `fetchFn` is used only when the
 * instance is (re)built; tests call resetSharedPriceProvider first.
 */
export function sharedPriceProvider(
  apiKey: string | null,
  options: { fetchFn?: FetchLike; now?: () => number } = {},
): CachedPriceProvider {
  if (shared && shared.apiKey === apiKey) return shared.provider;
  const inner = coinGeckoPriceProvider({
    fetchFn: guardedCoinGeckoFetch(options.fetchFn),
    ...(apiKey ? { demoApiKey: apiKey } : {}),
  });
  const provider = cachedPriceProvider(inner, {
    ttlMs: PRICE_TTL_MS,
    maxStaleMs: PRICE_MAX_STALE_MS,
    ...(options.now ? { now: options.now } : {}),
  });
  shared = { apiKey, provider };
  return provider;
}

/** Drops the shared instance (tests; never needed by screens). */
export function resetSharedPriceProvider(): void {
  shared = null;
}

/**
 * Prices the given CAIP-19 ids in USD through the shared provider. Nulls
 * in `assetIds` (assets that must not be priced) are skipped. Returns only
 * the priced quotes; failures and unpriceable assets are simply absent —
 * the UI renders nothing for them.
 *
 * When `enabled` is false (the Show-fiat preference is off, or preferences
 * have not loaded yet) this returns an empty map BEFORE any storage read or
 * network request: turning fiat off stops all price traffic.
 */
export async function fetchPrices(
  assetIds: readonly (string | null | undefined)[],
  options: {
    enabled: boolean;
    store?: KeyValueStore;
    fetchFn?: FetchLike;
    now?: () => number;
  },
): Promise<Map<string, PriceQuote>> {
  if (!options.enabled) return new Map();
  const ids = [...new Set(assetIds.filter((id): id is string => typeof id === 'string'))];
  if (ids.length === 0) return new Map();
  const config = await getPriceConfig(options.store ?? AsyncStorage);
  const provider = sharedPriceProvider(config.demoApiKey, {
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let result: PriceResult;
  try {
    result = await provider.getPrices(ids, PRICE_CURRENCY);
  } catch {
    // The provider reports vendor failures per asset and should not throw;
    // if it does anyway, prices are just absent.
    return new Map();
  }
  return result.quotes;
}

// ---------------------------------------------------------------------------
// Optional CoinGecko Demo API key (verify-before-save)
// ---------------------------------------------------------------------------

export interface PriceConfig {
  demoApiKey: string | null;
  /** ISO timestamp of the successful save-time check. */
  verifiedAt: string | null;
}

async function loadRawConfig(store: KeyValueStore): Promise<Record<string, unknown>> {
  try {
    const raw = await store.getItem(PRICE_CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // Corrupt JSON or unavailable storage: behave as keyless rather than
    // break Settings or Home (swap.ts / aa.ts discipline).
    return {};
  }
}

/** The stored price configuration (nulls when no key is saved: keyless). */
export async function getPriceConfig(store: KeyValueStore = AsyncStorage): Promise<PriceConfig> {
  const entry = await loadRawConfig(store);
  const demoApiKey =
    typeof entry.demoApiKey === 'string' && entry.demoApiKey !== '' ? entry.demoApiKey : null;
  return {
    demoApiKey,
    verifiedAt:
      demoApiKey && typeof entry.verifiedAt === 'string' && entry.verifiedAt !== ''
        ? entry.verifiedAt
        : null,
  };
}

/** The asset the save-time check prices: native ETH on Ethereum mainnet. */
const VERIFY_ASSET_ID = nativePriceAssetId('eip155:1', 'eip155:1')!;

/**
 * Checks and saves a CoinGecko Demo API key; throws (persisting nothing)
 * when the check fails. The check is ONE live GET /simple/price for ETH/USD
 * through the engine adapter with the key in the x-cg-demo-api-key header
 * (to api.coingecko.com only), without the cache so it always reaches the
 * vendor. It passes only when that call returns a usable ETH price.
 *
 * Status mapping, per docs.coingecko.com/docs/errors-and-rate-limits.md
 * (checked 2026-09-28): 401 "Missing or invalid API key", 403 "Access
 * blocked by the server", 429 "Rate limit exceeded", and 400 for invalid
 * requests (the same page lists error 10010/10011 for a key of the wrong
 * type, e.g. a Pro key on the Demo root).
 *
 * LIMIT OF THIS CHECK: in a live probe on 2026-09-28 CoinGecko answered a
 * made-up Demo key with HTTP 200 and a normal price, and the Demo API
 * lists no key-status endpoint (docs.coingecko.com/demo/reference/
 * endpoint-overview.md: only /ping). So a pass proves the request with the
 * key works, NOT that CoinGecko recognized the key; Settings words its
 * status line accordingly.
 *
 * The key is never logged and never placed in an error message.
 */
export async function setPriceDemoKey(
  key: string,
  options: { store?: KeyValueStore; fetchFn?: FetchLike } = {},
): Promise<void> {
  const store = options.store ?? AsyncStorage;
  const trimmed = key.trim();
  if (!/^\S{1,200}$/.test(trimmed)) {
    throw new Error('Enter the CoinGecko Demo API key (a single token with no spaces).');
  }
  const provider = coinGeckoPriceProvider({
    demoApiKey: trimmed,
    fetchFn: guardedCoinGeckoFetch(options.fetchFn),
  });
  let result: PriceResult;
  try {
    result = await provider.getPrices([VERIFY_ASSET_ID], PRICE_CURRENCY);
  } catch {
    throw new Error('The price check could not run. Nothing was saved — try again.');
  }
  if (result.quotes.has(VERIFY_ASSET_ID)) {
    await store.setItem(
      PRICE_CONFIG_KEY,
      JSON.stringify({ demoApiKey: trimmed, verifiedAt: new Date().toISOString() }),
    );
    // Rebuild the shared provider with the new key on its next use.
    resetSharedPriceProvider();
    return;
  }
  const error = result.failed.get(VERIFY_ASSET_ID);
  if (!error) {
    throw new Error(
      'CoinGecko answered without an ETH price, so the key could not be checked. ' +
        'Nothing was saved — try again later.',
    );
  }
  if (error.kind === 'rate-limited') {
    throw new Error(
      'CoinGecko is rate-limiting requests from this network right now. ' +
        'Nothing was saved — wait a minute and try again.',
    );
  }
  if (error.kind === 'http' && error.status === 401) {
    throw new Error(
      'CoinGecko rejected this key (missing or invalid API key). Nothing was ' +
        'saved — check the key on your CoinGecko developer dashboard.',
    );
  }
  if (error.kind === 'http' && error.status === 400) {
    throw new Error(
      'CoinGecko refused the request (HTTP 400). A Pro key cannot be used here — ' +
        'only a Demo key works with api.coingecko.com. Nothing was saved.',
    );
  }
  if (error.kind === 'http' && error.status === 403) {
    throw new Error('CoinGecko blocked the request (HTTP 403). Nothing was saved.');
  }
  if (error.kind === 'network') {
    throw new Error(
      'Could not reach CoinGecko to check the key. Nothing was saved — check ' +
        'your connection and try again.',
    );
  }
  throw new Error(
    `The price check failed (${error.kind}${error.status ? `, HTTP ${error.status}` : ''}). ` +
      'Nothing was saved — try again in a moment.',
  );
}

/** Removes the stored Demo key; prices go back to keyless requests. */
export async function clearPriceDemoKey(store: KeyValueStore = AsyncStorage): Promise<void> {
  await store.setItem(PRICE_CONFIG_KEY, JSON.stringify({}));
  resetSharedPriceProvider();
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export interface FiatDisplay {
  /** "≈ $3,412.57", "< $0.01", or "≈ ••••" when amounts are hidden. */
  text: string;
  /** "price from 12 min ago" for stale or old prices, else null. */
  staleNote: string | null;
}

/** "12 min ago", "3 h ago", "2 days ago". */
export function describeAge(ageMs: number): string {
  const minutes = Math.max(1, Math.floor(ageMs / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * The stale marker for a quote, or null when it is fresh. A quote is
 * marked when the cache served it stale after a failed refresh, or when the
 * vendor's own timestamp is older than PRICE_OLD_AFTER_MS. The age is
 * measured from the vendor's last update (falling back to the fetch time),
 * i.e. how old the PRICE is, not how old the request was.
 */
export function staleNoteFor(quote: PriceQuote, nowMs: number = Date.now()): string | null {
  const basis = quote.updatedAtMs ?? quote.fetchedAtMs;
  const age = basis === undefined ? undefined : Math.max(0, nowMs - basis);
  const old = age !== undefined && age > PRICE_OLD_AFTER_MS;
  if (!quote.stale && !old) return null;
  return age === undefined ? 'price may be outdated' : `price from ${describeAge(age)}`;
}

/**
 * The fiat display for an exact amount, or null when nothing should be
 * shown: no quote (missing, failed, unpriceable, test asset), a zero or
 * negative amount, or a value the engine cannot compute. Never "$0.00" for
 * a missing price, never error text.
 *
 *   amount    exact base units (wei, sat, lamports, token base units)
 *   decimals  the asset's on-chain decimals
 *
 * With `hidden` (the Hide-amounts preference) the value is masked through
 * maskAmount exactly like crypto amounts, and the output is identical for
 * every value (including "< $0.01") so nothing about the size leaks.
 */
export function formatFiat(
  quote: PriceQuote | undefined,
  amount: bigint,
  decimals: number,
  options: { hidden: boolean; nowMs?: number },
): FiatDisplay | null {
  if (!quote || amount <= 0n) return null;
  let value: { value: string; belowPrecision: boolean };
  try {
    value = fiatValue(amount, decimals, quote.price);
  } catch {
    return null;
  }
  if (options.hidden) {
    return { text: `≈ ${maskAmount('', true)}`, staleNote: null };
  }
  const text = value.belowPrecision ? '< $0.01' : `≈ $${groupThousands(value.value)}`;
  return { text, staleNote: staleNoteFor(quote, options.nowMs ?? Date.now()) };
}

/** One-line form for rows: "≈ $3,412.57 · price from 12 min ago". */
export function fiatLine(display: FiatDisplay | null): string | null {
  if (!display) return null;
  return display.staleNote ? `${display.text} · ${display.staleNote}` : display.text;
}

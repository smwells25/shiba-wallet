import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PriceQuote } from '@shiba-wallet/prices';
import { usePrefs } from './PrefsContext';
import { fetchPrices } from './prices';

export interface PricesHook {
  /** Priced assets by CAIP-19 id. Anything absent renders no fiat value. */
  quotes: Map<string, PriceQuote>;
  /** Re-requests the current id set (pull-to-refresh). Cheap: the shared cache has a 120 s TTL. */
  refresh: () => Promise<void>;
}

const EMPTY: Map<string, PriceQuote> = new Map();

/**
 * USD quotes for a set of CAIP-19 ids, through the one shared cached
 * CoinGecko provider (./prices.ts). Pass null for assets that must not be
 * priced (testnet assets; see nativePriceAssetId / tokenPriceAssetId).
 *
 * Same discipline as useBalances/useHistory: a generation counter drops
 * late responses — here bumped on every request, on unmount, and when fiat
 * display is turned off, so an older in-flight answer can never overwrite a
 * newer one (e.g. across a Sepolia toggle). Nothing is requested until the
 * stored preferences have loaded AND "Show fiat values" is on; turning it
 * off clears the quotes immediately and stops all requests.
 *
 * Failures are silent by design: a failed or missing price simply has no
 * entry, and the screens render nothing for it.
 */
export function usePrices(assetIds: readonly (string | null | undefined)[]): PricesHook {
  const { ready, showFiat } = usePrefs();
  const enabled = ready && showFiat;
  const [quotes, setQuotes] = useState<Map<string, PriceQuote>>(EMPTY);
  const generation = useRef(0);

  // A stable key for the id set, so a new array with the same ids does not
  // retrigger the effect. The memoized array is rebuilt from the key, so its
  // identity changes exactly when the set of ids changes.
  const idsKey = JSON.stringify(
    [...new Set(assetIds.filter((id): id is string => typeof id === 'string'))].sort(),
  );
  const ids = useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);

  // Turning fiat display off clears the stored quotes while rendering, so
  // turning it back on starts empty instead of showing old prices until the
  // new answer arrives.
  if (!enabled && quotes !== EMPTY) setQuotes(EMPTY);

  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    if (!enabled) {
      setQuotes(EMPTY);
      return;
    }
    const next = await fetchPrices(ids, { enabled });
    if (generation.current === gen) setQuotes(next);
  }, [enabled, ids]);

  // Requests the current id set whenever it or the enabled flag changes.
  // This repeats refresh's request inline because refresh also clears the
  // quotes synchronously when disabled, which an effect must not do.
  useEffect(() => {
    const gen = ++generation.current;
    if (enabled) {
      void (async () => {
        const next = await fetchPrices(ids, { enabled });
        if (generation.current === gen) setQuotes(next);
      })();
    }
    return () => {
      generation.current += 1;
    };
  }, [enabled, ids]);

  return { quotes: enabled ? quotes : EMPTY, refresh };
}

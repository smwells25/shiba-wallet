import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAssetId } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
import { getEndpoint } from '../config/networks';
import { EVM_CHAIN_ID } from './send';
import { fetchErc20Balance } from './erc20';
import { formatUnits } from './balances';
import { listTokens } from './tokens';
import type { BalanceState } from './useBalances';

/**
 * Tracked ERC-20 token balances for the Home screen, keyed by CAIP-19
 * asset id. Same discipline as useBalances (native coins): tokens are
 * fetched concurrently and fail independently — one token's balanceOf
 * failing shows a retry state on that row only. The token list itself is
 * re-read from AsyncStorage on every reload, so additions/removals made on
 * the Tokens screen show up when Home regains focus, and endpoint edits in
 * Settings take effect on the next refresh.
 */
export interface TokenBalancesHook {
  /** The tracked tokens, in stored order. */
  tokens: FungibleAsset[];
  /** Per-token balance state, keyed by CAIP-19 id. */
  tokenBalances: Record<string, BalanceState>;
  /** Re-reads the token list and re-fetches every balance. */
  reloadTokens: () => Promise<void>;
  /** Re-fetches one token's balance (row-level retry). */
  refreshToken: (assetId: string) => Promise<void>;
}

export function useTokenBalances(evmAddress: string | undefined): TokenBalancesHook {
  const [tokens, setTokens] = useState<FungibleAsset[]>([]);
  const [tokenBalances, setTokenBalances] = useState<Record<string, BalanceState>>({});
  // Bump on unmount so late responses from an unmounted screen are dropped.
  const generation = useRef(0);

  const setTokenState = useCallback((assetId: string, state: BalanceState) => {
    setTokenBalances((prev) => ({ ...prev, [assetId]: state }));
  }, []);

  const fetchToken = useCallback(
    async (token: FungibleAsset, owner: string) => {
      const gen = generation.current;
      const id = formatAssetId(token.assetId);
      setTokenState(id, { status: 'loading' });
      try {
        const endpoint = await getEndpoint(EVM_CHAIN_ID);
        if (!endpoint?.url) {
          if (generation.current === gen) {
            setTokenState(id, { status: 'unavailable', note: 'No Ethereum endpoint configured.' });
          }
          return;
        }
        const amount = await fetchErc20Balance(endpoint.url, token.assetId.reference, owner);
        if (generation.current === gen) {
          setTokenState(id, {
            status: 'ok',
            display: formatUnits(amount, token.decimals),
            symbol: token.symbol,
          });
        }
      } catch (e) {
        if (generation.current === gen) {
          setTokenState(id, {
            status: 'error',
            message: e instanceof Error ? e.message : 'Token balance fetch failed',
          });
        }
      }
    },
    [setTokenState],
  );

  const reloadTokens = useCallback(async () => {
    if (!evmAddress) return;
    const gen = generation.current;
    try {
      const list = await listTokens();
      if (generation.current !== gen) return;
      setTokens(list);
      // Drop stale states for tokens no longer tracked.
      setTokenBalances((prev) => {
        const keep: Record<string, BalanceState> = {};
        for (const token of list) {
          const id = formatAssetId(token.assetId);
          const existing = prev[id];
          if (existing) keep[id] = existing;
        }
        return keep;
      });
      await Promise.allSettled(list.map((token) => fetchToken(token, evmAddress)));
    } catch {
      // listTokens falls back internally; reaching here means storage is
      // unusable — keep the last known list rather than blanking the UI.
    }
  }, [evmAddress, fetchToken]);

  const refreshToken = useCallback(
    async (assetId: string) => {
      if (!evmAddress) return;
      const token = tokens.find((t) => formatAssetId(t.assetId) === assetId);
      if (token) await fetchToken(token, evmAddress);
    },
    [tokens, evmAddress, fetchToken],
  );

  // No self-triggered initial load: the caller drives loads (Home uses
  // useFocusEffect, which fires on mount and on every regained focus, and
  // re-fires when the address changes because reloadTokens' identity
  // changes). Loading here too would double-fetch every mount. The
  // generation bump on unmount still drops late responses.
  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, []);

  return { tokens, tokenBalances, reloadTokens, refreshToken };
}

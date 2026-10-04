import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAssetId } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
// Explicit .ts extensions: scripts/check-failover.mjs imports
// loadTokenBalance from this module under Node's type stripping, which
// resolves relative specifiers literally (Metro accepts both forms).
import { callWithFailover, getEndpoint, type NetworkEndpoint } from '../config/networks.ts';
import { EVM_CHAIN_ID } from './send.ts';
import { fetchErc20Balance } from './erc20.ts';
import { formatBalanceDisplay } from './balances.ts';
import { listTokens } from './tokens.ts';
import type { BalanceState } from './useBalances.ts';

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

/** One token's balance, or why there is none. */
export type TokenBalanceLoad =
  | { status: 'ok'; amount: bigint; endpoint: NetworkEndpoint }
  | { status: 'unavailable'; note: string };

/**
 * Fetches one tracked ERC-20 balance through the EVM endpoint resolved NOW
 * (override, or the current default choice), with the shared failover rule
 * (config/networks.ts callWithFailover): a failing default is reported and
 * the balanceOf call repeated once on the next healthy candidate. This is
 * the same rule as useBalances.ts loadNativeBalance, so a dead default
 * hostname never leaves the token rows stuck on an error while the native
 * row next to them has already moved on. Errors that survive the failover
 * are thrown for the row's retryable error state. React-free so
 * scripts/check-failover.mjs runs the exact code.
 */
export async function loadTokenBalance(
  contract: string,
  owner: string,
  options: { retryDelayMs?: number } = {},
): Promise<TokenBalanceLoad> {
  // EVM_CHAIN_ID is the stable slot id; getEndpoint translates it to the
  // ACTIVE network (Sepolia in test mode), exactly like the native row.
  const endpoint = await getEndpoint(EVM_CHAIN_ID);
  if (!endpoint || endpoint.url === null) {
    return { status: 'unavailable', note: 'No Ethereum endpoint configured.' };
  }
  const outcome = await callWithFailover({ ...endpoint, url: endpoint.url }, (ep) =>
    fetchErc20Balance(ep.url, contract, owner, options.retryDelayMs),
  );
  return { status: 'ok', amount: outcome.value, endpoint: outcome.endpoint };
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
        const load = await loadTokenBalance(token.assetId.reference, owner);
        if (generation.current !== gen) return;
        if (load.status === 'unavailable') {
          setTokenState(id, { status: 'unavailable', note: load.note });
          return;
        }
        setTokenState(id, {
          status: 'ok',
          display: formatBalanceDisplay(load.amount, token.decimals),
          symbol: token.symbol,
          amount: load.amount,
          decimals: token.decimals,
          // The network of the endpoint that actually answered.
          networkChainId: load.endpoint.network.chainId,
        });
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

  // A different owner address (account switch) invalidates every
  // in-flight balanceOf and every shown balance: bump the generation so
  // late responses for the previous address are dropped, and clear the
  // rows so no previous-account amount is ever shown under the new one.
  // (App.tsx also remounts the navigator on a switch; this keeps the hook
  // correct on its own.) Declared before the caller's focus effect, so the
  // reload for the new address runs under the new generation.
  const lastAddress = useRef(evmAddress);
  useEffect(() => {
    if (lastAddress.current === evmAddress) return;
    lastAddress.current = evmAddress;
    generation.current += 1;
    setTokenBalances({});
  }, [evmAddress]);

  return { tokens, tokenBalances, reloadTokens, refreshToken };
}

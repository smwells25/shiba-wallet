import { useCallback, useEffect, useRef, useState } from 'react';
import { getAllEndpoints, getEndpoint, reportEndpointFailure } from '../config/networks';
import { fetchNativeBalance, formatUnits } from './balances';
import type { ChainAccount } from './WalletContext';

/**
 * Per-chain balance state. Chains are fetched concurrently and fail
 * independently: one endpoint being down must never blank the others.
 */
export type BalanceState =
  | { status: 'loading' }
  | {
      status: 'ok';
      display: string;
      symbol: string;
      /** Exact balance in base units (for the fiat value; display stays `display`). */
      amount: bigint;
      /** The asset's decimals, paired with `amount`. */
      decimals: number;
      /**
       * CAIP-2 id of the network that produced this balance (the ACTIVE
       * network: 'eip155:11155111' for the EVM slot in Sepolia test mode),
       * so a price is only ever attached to the network it belongs to.
       */
      networkChainId: string;
    }
  /** Endpoint answered badly or not at all; retryable. */
  | { status: 'error'; message: string }
  /** No endpoint configured for this chain (e.g. Dogecoin by default). */
  | { status: 'unavailable'; note?: string };

export interface BalancesHook {
  balances: Record<string, BalanceState>;
  /** True while a pull-to-refresh pass is in flight. */
  refreshing: boolean;
  /** Re-fetches every chain (pull-to-refresh). */
  refreshAll: () => Promise<void>;
  /** Re-fetches one chain (row-level retry). */
  refreshOne: (chainId: string) => Promise<void>;
}

/**
 * Fetches native balances for the given accounts. Endpoints are re-resolved
 * from config on every pass, so edits made in Settings take effect on the
 * next refresh without an app restart.
 */
export function useBalances(accounts: ChainAccount[]): BalancesHook {
  const [balances, setBalances] = useState<Record<string, BalanceState>>({});
  const [refreshing, setRefreshing] = useState(false);
  // Bump on unmount so late responses from an unmounted screen are dropped.
  const generation = useRef(0);

  const setChainState = useCallback((chainId: string, state: BalanceState) => {
    setBalances((prev) => ({ ...prev, [chainId]: state }));
  }, []);

  const fetchChain = useCallback(
    async (account: ChainAccount) => {
      const gen = generation.current;
      setChainState(account.chainId, { status: 'loading' });
      try {
        const endpoints = await getAllEndpoints();
        // Accounts carry the stable SLOT id (e.g. 'eip155:1' even while
        // Sepolia test mode swaps the network underneath), so the match
        // must use forChainId — matching network.chainId broke EVM
        // balances in test mode (emulator-validation finding #2).
        const endpoint = endpoints.find((e) => e.forChainId === account.chainId);
        if (!endpoint) {
          setChainState(account.chainId, {
            status: 'unavailable',
            note: 'No network configuration for this chain.',
          });
          return;
        }
        if (!endpoint.url) {
          if (generation.current === gen) {
            setChainState(account.chainId, {
              status: 'unavailable',
              note: endpoint.network.note,
            });
          }
          return;
        }
        let used = endpoint;
        let amount: bigint;
        try {
          amount = await fetchNativeBalance(
            endpoint.network.kind,
            endpoint.url,
            account.address,
            endpoint.headers,
          );
        } catch (e) {
          // A DEFAULT endpoint that fails a real request is dropped from the
          // in-memory choice and the chain's candidates are probed again
          // (config/endpoint-probe.ts). If that lands on a different healthy
          // candidate, retry once through it; otherwise surface the error.
          // User overrides are never switched away from.
          if (endpoint.isOverride || !endpoint.defaultChoice) throw e;
          if (!reportEndpointFailure(endpoint.network.chainId, endpoint.url)) throw e;
          const next = await getEndpoint(account.chainId);
          if (
            !next?.url ||
            next.url === endpoint.url ||
            next.isOverride ||
            next.network.chainId !== endpoint.network.chainId
          ) {
            throw e;
          }
          used = next;
          amount = await fetchNativeBalance(
            next.network.kind,
            next.url,
            account.address,
            next.headers,
          );
        }
        if (generation.current === gen) {
          setChainState(account.chainId, {
            status: 'ok',
            display: formatUnits(amount, used.network.decimals),
            symbol: used.network.symbol,
            amount,
            decimals: used.network.decimals,
            networkChainId: used.network.chainId,
          });
        }
      } catch (e) {
        if (generation.current === gen) {
          setChainState(account.chainId, {
            status: 'error',
            message: e instanceof Error ? e.message : 'Balance fetch failed',
          });
        }
      }
    },
    [setChainState],
  );

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      // Concurrent, independently settled: fetchChain never rejects (it
      // writes its own error state), so allSettled is belt and braces.
      await Promise.allSettled(accounts.map((account) => fetchChain(account)));
    } finally {
      setRefreshing(false);
    }
  }, [accounts, fetchChain]);

  const refreshOne = useCallback(
    async (chainId: string) => {
      const account = accounts.find((a) => a.chainId === chainId);
      if (account) await fetchChain(account);
    },
    [accounts, fetchChain],
  );

  // Initial load, re-run if the account set changes (e.g. wallet re-import).
  useEffect(() => {
    generation.current += 1;
    void Promise.allSettled(accounts.map((account) => fetchChain(account)));
    return () => {
      generation.current += 1;
    };
  }, [accounts, fetchChain]);

  return { balances, refreshing, refreshAll, refreshOne };
}

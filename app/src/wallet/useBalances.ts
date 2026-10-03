import { useCallback, useEffect, useRef, useState } from 'react';
// Explicit .ts extensions: scripts/check-failover.mjs imports
// loadNativeBalance from this module under Node's type stripping.
import { callWithFailover, getEndpoint, type NetworkEndpoint } from '../config/networks.ts';
import { fetchNativeBalance, formatUnits } from './balances.ts';
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

/** One chain's native balance, or why there is none. */
export type NativeBalanceLoad =
  | { status: 'ok'; amount: bigint; endpoint: NetworkEndpoint }
  | { status: 'unavailable'; note?: string };

/**
 * Fetches one chain's native balance through the endpoint resolved NOW
 * (override, or the current default choice), with the shared failover
 * rule: a failing default is reported and the request repeated once on the
 * next healthy candidate (config/networks.ts callWithFailover). Errors that
 * survive that are thrown for the caller's retryable error state.
 * React-free so scripts/check-failover.mjs runs the exact code.
 */
export async function loadNativeBalance(
  slotChainId: string,
  address: string,
  options: { retryDelayMs?: number } = {},
): Promise<NativeBalanceLoad> {
  // Accounts carry the stable SLOT id (e.g. 'eip155:1' even while Sepolia
  // test mode swaps the network underneath); getEndpoint matches slots
  // first — matching network.chainId broke EVM balances in test mode
  // (emulator-validation finding #2).
  const endpoint = await getEndpoint(slotChainId);
  if (!endpoint) return { status: 'unavailable', note: 'No network configuration for this chain.' };
  if (endpoint.url === null) {
    return { status: 'unavailable', ...(endpoint.network.note ? { note: endpoint.network.note } : {}) };
  }
  const outcome = await callWithFailover({ ...endpoint, url: endpoint.url }, (ep) =>
    fetchNativeBalance(ep.network.kind, ep.url, address, ep.headers, options.retryDelayMs),
  );
  return { status: 'ok', amount: outcome.value, endpoint: outcome.endpoint };
}

/**
 * Fetches native balances for the given accounts. Endpoints are re-resolved
 * from config on every pass, so edits made in Settings take effect on the
 * next refresh without an app restart. `activeEvmChainId` is the ACTIVE EVM
 * network (config/evm-chain.ts caip2): when it flips (mainnet <-> Sepolia)
 * the rows are fetched again so the EVM row never shows the other mode's
 * number.
 */
export function useBalances(accounts: ChainAccount[], activeEvmChainId?: string): BalancesHook {
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
        const load = await loadNativeBalance(account.chainId, account.address);
        if (generation.current !== gen) return;
        if (load.status === 'unavailable') {
          setChainState(account.chainId, { status: 'unavailable', note: load.note });
          return;
        }
        const used = load.endpoint;
        setChainState(account.chainId, {
          status: 'ok',
          display: formatUnits(load.amount, used.network.decimals),
          symbol: used.network.symbol,
          amount: load.amount,
          decimals: used.network.decimals,
          networkChainId: used.network.chainId,
        });
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

  // Initial load, re-run if the account set changes (e.g. wallet re-import)
  // or the active EVM network flips (mainnet <-> Sepolia): a flip reloads
  // every row, so the EVM row never shows the other mode's number. Flips
  // are rare and deliberate (Settings → Developer), so reloading the three
  // unaffected rows too is a fair price for one simple rule.
  useEffect(() => {
    generation.current += 1;
    void Promise.allSettled(accounts.map((account) => fetchChain(account)));
    return () => {
      generation.current += 1;
    };
  }, [accounts, fetchChain, activeEvmChainId]);

  return { balances, refreshing, refreshAll, refreshOne };
}

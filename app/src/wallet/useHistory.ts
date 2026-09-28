import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from '@shiba-wallet/core';
import { getEndpoint, type NetworkEndpoint } from '../config/networks';
import { historySourceFor, type HistorySource } from './history';
import { getIndexerConfig } from './indexer';

/**
 * State machine for one chain's activity list, with the same discipline as
 * useBalances: endpoints are re-resolved from config on every reload (so
 * Settings edits take effect without a restart), a generation counter drops
 * late responses after unmount or reload, and errors are retryable without
 * losing what already rendered.
 */
export type HistoryState =
  | { status: 'loading' }
  /** No provider can serve this chain right now (EVM, or no endpoint). */
  | { status: 'unavailable'; note: string }
  /** The first page failed; retryable. */
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      entries: HistoryEntry[];
      /** Cursor for the next (older) page; undefined when exhausted. */
      nextCursor?: string;
      loadingMore: boolean;
      /** A load-more failure; the entries already shown are kept. */
      loadMoreError: string | null;
    };

export interface HistoryHook {
  state: HistoryState;
  /** True while a pull-to-refresh reload is in flight. */
  refreshing: boolean;
  /** Re-fetches the first page (initial load, retry, pull-to-refresh). */
  reload: () => Promise<void>;
  /** Fetches the next page and appends it. No-op when already exhausted. */
  loadMore: () => Promise<void>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'History fetch failed';
}

/**
 * Resolves the chain's history source, re-reading configuration each time
 * (like getEndpoint) so Settings edits take effect on the next reload. EVM
 * chains additionally consult the history-indexer config from
 * ./indexer.ts; a stored URL there passed save-time verification.
 */
async function sourceForEndpoint(endpoint: NetworkEndpoint): Promise<HistorySource> {
  const indexerUrl =
    endpoint.network.kind === 'evm-jsonrpc'
      ? (await getIndexerConfig(endpoint.network.chainId)).url
      : null;
  return historySourceFor(endpoint.network.kind, endpoint.url, indexerUrl, endpoint.headers);
}

export function useHistory(chainId: string, address: string): HistoryHook {
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  // Serializes load-more calls: FlatList's onEndReached can fire repeatedly
  // while one page is already in flight.
  const loadingMoreRef = useRef(false);

  const reload = useCallback(async () => {
    const gen = ++generation.current;
    setRefreshing(true);
    setState((prev) => (prev.status === 'ok' ? prev : { status: 'loading' }));
    try {
      const endpoint = await getEndpoint(chainId);
      if (gen !== generation.current) return;
      if (!endpoint) {
        setState({ status: 'unavailable', note: 'No network configuration for this chain.' });
        return;
      }
      const source = await sourceForEndpoint(endpoint);
      if (gen !== generation.current) return;
      if (source.status === 'unavailable') {
        setState({ status: 'unavailable', note: source.note });
        return;
      }
      const page = await source.provider.getHistory(address);
      if (gen !== generation.current) return;
      setState({
        status: 'ok',
        entries: page.entries,
        nextCursor: page.nextCursor,
        loadingMore: false,
        loadMoreError: null,
      });
    } catch (e) {
      if (gen === generation.current) {
        setState({ status: 'error', message: errorMessage(e) });
      }
    } finally {
      if (gen === generation.current) setRefreshing(false);
    }
  }, [chainId, address]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    const gen = generation.current;
    let cursor: string | undefined;
    setState((prev) => {
      if (prev.status !== 'ok' || !prev.nextCursor) return prev;
      cursor = prev.nextCursor;
      return { ...prev, loadingMore: true, loadMoreError: null };
    });
    if (!cursor) return;
    loadingMoreRef.current = true;
    try {
      const endpoint = await getEndpoint(chainId);
      if (gen !== generation.current) return;
      const source = endpoint
        ? await sourceForEndpoint(endpoint)
        : ({ status: 'unavailable', note: '' } as const);
      if (gen !== generation.current) return;
      if (source.status === 'unavailable') {
        // The endpoint was removed between pages; keep what is shown.
        setState((prev) =>
          prev.status === 'ok'
            ? { ...prev, loadingMore: false, loadMoreError: 'Endpoint no longer configured' }
            : prev,
        );
        return;
      }
      const page = await source.provider.getHistory(address, cursor);
      if (gen !== generation.current) return;
      setState((prev) => {
        if (prev.status !== 'ok') return prev;
        // Cheap dedupe, in case a transaction confirmed between the first
        // (mempool + confirmed) page and this confirmed-only page. Keyed
        // by uid when present (one EVM transaction can yield several
        // legitimate entries sharing its hash), by id otherwise.
        const seen = new Set(prev.entries.map((entry) => entry.uid ?? entry.id));
        const fresh = page.entries.filter((entry) => !seen.has(entry.uid ?? entry.id));
        return {
          status: 'ok',
          entries: [...prev.entries, ...fresh],
          nextCursor: page.nextCursor,
          loadingMore: false,
          loadMoreError: null,
        };
      });
    } catch (e) {
      if (gen === generation.current) {
        setState((prev) =>
          prev.status === 'ok' ? { ...prev, loadingMore: false, loadMoreError: errorMessage(e) } : prev,
        );
      }
    } finally {
      loadingMoreRef.current = false;
    }
  }, [chainId, address]);

  // Initial load; re-run if the chain or address changes.
  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  return { state, refreshing, reload, loadMore };
}

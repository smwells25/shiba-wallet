import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from '@shiba-wallet/core';
import { getEndpoint, type NetworkEndpoint } from '../config/networks';
import {
  historyNotesAfterPage,
  historySourceFor,
  type HistoryNotes,
  type HistorySource,
} from './history';
import { listTokens } from './tokens';
import type { TrackedTokenRef } from './token-history';
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
      /** Source-level caveat (e.g. the tracked-token logs fallback). */
      note?: string;
      /** The endpoint's own refusal text, verbatim, shown under the note. */
      noteDetail?: string;
      /**
       * Block range answered so far by the tracked-token logs fallback
       * (token-history.ts); absent for other sources.
       */
      coverage?: HistoryNotes['coverage'];
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
async function sourceForEndpoint(
  endpoint: NetworkEndpoint,
  walletAddress: string,
): Promise<HistorySource> {
  const isEvm = endpoint.network.kind === 'evm-jsonrpc';
  const indexerUrl = isEvm ? (await getIndexerConfig(endpoint.network.chainId)).url : null;
  // Tracked tokens power the logs fallback when no indexer is configured
  // (mainnet only: tracked tokens are mainnet assets and are hidden in
  // Sepolia test mode, so the fallback naturally stays mainnet-scoped).
  let evmTokenLogs: { walletAddress: string; tokens: TrackedTokenRef[] } | undefined;
  if (isEvm && !indexerUrl && endpoint.network.chainId === 'eip155:1') {
    const tokens = await listTokens();
    if (tokens.length > 0) {
      evmTokenLogs = {
        walletAddress,
        tokens: tokens.map((t) => ({
          address: t.assetId.reference,
          symbol: t.symbol,
          decimals: t.decimals,
        })),
      };
    }
  }
  return historySourceFor(
    endpoint.network.kind,
    endpoint.url,
    indexerUrl,
    endpoint.headers,
    evmTokenLogs,
  );
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
      const source = await sourceForEndpoint(endpoint, address);
      if (gen !== generation.current) return;
      if (source.status === 'unavailable') {
        setState({ status: 'unavailable', note: source.note });
        return;
      }
      const page = await source.provider.getHistory(address);
      if (gen !== generation.current) return;
      const notes = historyNotesAfterPage(source.note ? { note: source.note } : {}, page);
      setState({
        status: 'ok',
        entries: page.entries,
        nextCursor: page.nextCursor,
        loadingMore: false,
        loadMoreError: null,
        ...notes,
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
        ? await sourceForEndpoint(endpoint, address)
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
        // The note fields carry over (a logs-fallback page updates them
        // with the range answered so far, including a refusal that ended
        // paging); without this the partial-history caveat would vanish
        // after the first "Load more".
        const notes = historyNotesAfterPage(
          {
            ...(prev.note !== undefined ? { note: prev.note } : {}),
            ...(prev.noteDetail !== undefined ? { noteDetail: prev.noteDetail } : {}),
            ...(prev.coverage !== undefined ? { coverage: prev.coverage } : {}),
          },
          page,
        );
        return {
          status: 'ok',
          entries: [...prev.entries, ...fresh],
          nextCursor: page.nextCursor,
          loadingMore: false,
          loadMoreError: null,
          ...notes,
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

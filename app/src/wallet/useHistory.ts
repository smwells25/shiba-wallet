import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryEntry, HistoryPage } from '@shiba-wallet/core';
// Explicit .ts extensions: scripts/check-failover.mjs imports
// loadHistoryPage from this module under Node's type stripping.
import { callWithFailover, getEndpoint, type NetworkEndpoint } from '../config/networks.ts';
import {
  historyNotesAfterPage,
  historySourceFor,
  type HistoryNotes,
  type HistorySource,
} from './history.ts';
import { listTokens } from './tokens.ts';
import type { TrackedTokenRef } from './token-history.ts';
import { getIndexerConfig } from './indexer.ts';

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
): Promise<{ source: HistorySource; viaIndexer: boolean }> {
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
  return {
    source: historySourceFor(
      endpoint.network.kind,
      endpoint.url,
      indexerUrl,
      endpoint.headers,
      evmTokenLogs,
    ),
    viaIndexer: indexerUrl !== null,
  };
}

/** One page of a chain's history, or why there is none. */
export type HistoryPageLoad =
  | { status: 'unavailable'; note: string }
  | { status: 'ok'; page: HistoryPage; note?: string };

/**
 * Fetches one history page (the first when `cursor` is undefined) through
 * the endpoint resolved NOW, with the shared failover rule
 * (config/networks.ts callWithFailover): a failing DEFAULT node endpoint is
 * reported and the page is fetched once more through the next healthy
 * candidate. A configured history indexer is user configuration, like an
 * override, so it is never failed over, and its failures are never charged
 * to the node endpoint. Cursors are chain data (a txid, a signature, a
 * block number, a Blockbook page), so later pages may come from a
 * different candidate of the same chain. React-free so
 * scripts/check-failover.mjs runs the exact code.
 */
export async function loadHistoryPage(
  chainId: string,
  address: string,
  cursor?: string,
): Promise<HistoryPageLoad> {
  const endpoint = await getEndpoint(chainId);
  if (!endpoint) return { status: 'unavailable', note: 'No network configuration for this chain.' };
  const first = await sourceForEndpoint(endpoint, address);
  if (first.source.status === 'unavailable') return { status: 'unavailable', note: first.source.note };
  const firstSource = first.source;
  if (first.viaIndexer || endpoint.url === null) {
    const page = await firstSource.provider.getHistory(address, cursor);
    return { status: 'ok', page, ...(firstSource.note ? { note: firstSource.note } : {}) };
  }
  const outcome = await callWithFailover({ ...endpoint, url: endpoint.url }, async (ep) => {
    // The first attempt reuses the source built above; a retry builds a
    // fresh one from the new candidate so nothing of the failed one is kept.
    const source = ep.url === endpoint.url ? firstSource : (await sourceForEndpoint(ep, address)).source;
    if (source.status === 'unavailable') throw new Error(source.note);
    const page = await source.provider.getHistory(address, cursor);
    return { page, note: source.note };
  });
  return {
    status: 'ok',
    page: outcome.value.page,
    ...(outcome.value.note ? { note: outcome.value.note } : {}),
  };
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
      const load = await loadHistoryPage(chainId, address);
      if (gen !== generation.current) return;
      if (load.status === 'unavailable') {
        setState({ status: 'unavailable', note: load.note });
        return;
      }
      const { page } = load;
      const notes = historyNotesAfterPage(load.note ? { note: load.note } : {}, page);
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
      const load = await loadHistoryPage(chainId, address, cursor);
      if (gen !== generation.current) return;
      if (load.status === 'unavailable') {
        // The endpoint was removed between pages; keep what is shown.
        setState((prev) =>
          prev.status === 'ok'
            ? { ...prev, loadingMore: false, loadMoreError: 'Endpoint no longer configured' }
            : prev,
        );
        return;
      }
      const { page } = load;
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

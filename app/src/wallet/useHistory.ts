import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryPage } from '@shiba-wallet/core';
// Explicit .ts extensions: scripts/check-failover.mjs imports
// loadHistoryPage from this module under Node's type stripping.
import { callWithFailover, getEndpoint, type NetworkEndpoint } from '../config/networks.ts';
import { historySourceFor, indexerHistoryStreams, type HistorySource } from './history.ts';
import { listTokens } from './tokens.ts';
import type { TrackedTokenRef } from './token-history.ts';
import { getIndexerConfig } from './indexer.ts';
import { createMergedHistoryFeed, type HistoryStream, type SmartAccountHistoryStatus } from './smart-account-history.ts';
import {
  createHistoryController,
  type HistoryController,
  type HistorySession,
  type HistorySnapshot,
  type HistoryState,
  type SessionPage,
} from './history-controller.ts';

export type { HistoryState } from './history-controller.ts';

/**
 * The Activity list of one chain: the state machine lives in
 * history-controller.ts (React-free, pinned by check-activity); this file
 * resolves where a page comes from and wraps the controller in a hook.
 * Endpoints are re-resolved from config on every reload (so Settings edits
 * take effect without a restart).
 */
export interface HistoryHook {
  state: HistoryState;
  /** True while a pull-to-refresh reload is in flight. */
  refreshing: boolean;
  /** Re-fetches the first page (initial load, retry, pull-to-refresh). */
  reload: () => Promise<void>;
  /** Fetches the next page and appends it. No-op when exhausted or while one is loading. */
  loadMore: () => Promise<void>;
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
): Promise<{ source: HistorySource; viaIndexer: boolean; indexerUrl: string | null }> {
  const isEvm = endpoint.network.kind === 'evm-jsonrpc';
  const indexerUrl = isEvm ? (await getIndexerConfig(endpoint.network.chainId)).url : null;
  // Tracked tokens power the logs fallback when no indexer is configured.
  // Tokens are per chain since phase 13 item 1, so the fallback reads the
  // list of the chain the endpoint serves (its own CAIP-2 id) and never
  // searches one network's contracts on another.
  let evmTokenLogs: { walletAddress: string; tokens: TrackedTokenRef[] } | undefined;
  if (isEvm && !indexerUrl) {
    const tokens = await listTokens(endpoint.network.chainId);
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
    indexerUrl,
  };
}

/** One page of a chain's history, or why there is none. */
export type HistoryPageLoad =
  | { status: 'unavailable'; note: string }
  | {
      status: 'ok';
      page: HistoryPage;
      note?: string;
      /** Set when a smart account was passed in: whether its history is on this page. */
      smartAccount?: SmartAccountHistoryStatus;
    };

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
  options: { smartAccount?: string | null } = {},
): Promise<HistoryPageLoad> {
  const endpoint = await getEndpoint(chainId);
  if (!endpoint) return { status: 'unavailable', note: 'No network configuration for this chain.' };
  const first = await sourceForEndpoint(endpoint, address);
  if (first.source.status === 'unavailable') return { status: 'unavailable', note: first.source.note };
  const firstSource = first.source;
  // The active account's smart account (smart-account-history.ts) is
  // listed only through a history indexer, by openHistorySession's
  // time-ordered merge; this cursor path never lists it. With an indexer it
  // serves the account's own pages (no smart account); the tracked-token
  // logs fallback is built for one address and reports the smart account
  // as skipped.
  const smartAccount = options.smartAccount ?? null;
  if (first.viaIndexer || endpoint.url === null) {
    const page = await firstSource.provider.getHistory(address, cursor);
    return {
      status: 'ok',
      page,
      ...(firstSource.note ? { note: firstSource.note } : {}),
      ...(smartAccount && !first.viaIndexer ? { smartAccount: 'skipped' as const } : {}),
    };
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
    ...(smartAccount ? { smartAccount: 'skipped' as const } : {}),
  };
}

/**
 * One reading of a chain's history (history-controller.ts HistorySession).
 * The first fill() resolves the source NOW: with a history indexer every
 * page comes from the time-ordered merge of one-sided streams
 * (smart-account-history.ts createMergedHistoryFeed — the account's sent
 * and received transfers, plus its smart account's when `smartAccount` is
 * given); otherwise each page comes from loadHistoryPage with the cursor
 * held here (the failover rule unchanged). `streamsFor` lets the check
 * scripts give the indexer streams a fake transport.
 */
export function openHistorySession(
  chainId: string,
  address: string,
  options: {
    smartAccount?: string | null;
    streamsFor?: (indexerUrl: string, address: string, smartAccount: string | null) => HistoryStream[];
  } = {},
): HistorySession {
  const smartAccount = options.smartAccount ?? null;
  const streamsFor = options.streamsFor ?? ((url, who, smart) => indexerHistoryStreams(url, who, smart));
  let route: null | { kind: 'merged'; fill: () => Promise<void>; take: () => SessionPage | null } | { kind: 'cursor' } = null;
  let cursor: string | undefined;
  let ready: SessionPage | null = null;
  let inflight: Promise<void> | null = null;

  async function cursorPage(): Promise<void> {
    const load = await loadHistoryPage(chainId, address, cursor, { smartAccount });
    if (load.status === 'unavailable') {
      ready = { status: 'unavailable', note: load.note };
      return;
    }
    cursor = load.page.nextCursor;
    ready = {
      status: 'ok',
      page: load.page,
      hasMore: Boolean(load.page.nextCursor),
      ...(load.note ? { note: load.note } : {}),
      ...(load.smartAccount ? { smartAccount: load.smartAccount } : {}),
    };
  }

  async function load(): Promise<void> {
    if (route === null) {
      const endpoint = await getEndpoint(chainId);
      if (!endpoint) {
        ready = { status: 'unavailable', note: 'No network configuration for this chain.' };
        return;
      }
      const first = await sourceForEndpoint(endpoint, address);
      if (first.source.status === 'unavailable') {
        ready = { status: 'unavailable', note: first.source.note };
        return;
      }
      if (first.indexerUrl !== null) {
        const feed = createMergedHistoryFeed(streamsFor(first.indexerUrl, address, smartAccount));
        const note = first.source.note;
        route = {
          kind: 'merged',
          fill: () => feed.fill(),
          take: () => {
            const page = feed.take();
            if (!page) return null;
            return {
              status: 'ok',
              page: { entries: page.entries },
              hasMore: page.hasMore,
              ...(note ? { note } : {}),
              ...(page.smartAccount ? { smartAccount: page.smartAccount } : {}),
            };
          },
        };
      } else {
        route = { kind: 'cursor' };
      }
    }
    if (route.kind === 'merged') {
      await route.fill();
      ready = route.take();
      return;
    }
    await cursorPage();
  }

  return {
    fill() {
      if (ready) return Promise.resolve();
      if (inflight) return inflight;
      inflight = load().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    take() {
      const page = ready;
      ready = null;
      return page;
    },
  };
}

/**
 * `extra.smartAccount` is the active account's smart-account address to
 * list next to `address` (null for none); while `extra.ready` is false
 * (the screen is still reading the smart-account settings) nothing is
 * loaded, so the list is fetched once with its final address set.
 */
export function useHistory(
  chainId: string,
  address: string,
  extra: { smartAccount: string | null; ready: boolean } = { smartAccount: null, ready: true },
): HistoryHook {
  const { smartAccount, ready } = extra;
  const [snap, setSnap] = useState<HistorySnapshot>({ state: { status: 'loading' }, refreshing: false });
  const controller = useRef<HistoryController | null>(null);

  useEffect(() => {
    if (!ready) return;
    const c = createHistoryController({
      open: () => openHistorySession(chainId, address, { smartAccount }),
      onChange: setSnap,
    });
    controller.current = c;
    // reload() publishes its first state (loading) at once.
    void c.reload();
    return () => {
      c.dispose();
      if (controller.current === c) controller.current = null;
    };
  }, [chainId, address, smartAccount, ready]);

  const reload = useCallback(async () => {
    await controller.current?.reload();
  }, []);
  const loadMore = useCallback(async () => {
    await controller.current?.loadMore();
  }, []);

  return { state: snap.state, refreshing: snap.refreshing, reload, loadMore };
}

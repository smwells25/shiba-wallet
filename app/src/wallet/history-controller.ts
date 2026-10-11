import type { HistoryEntry, HistoryPage } from '@shiba-wallet/core';
// Explicit .ts extensions: scripts/check-activity.mjs loads this module
// under Node's type stripping.
import { historyNotesAfterPage, type HistoryNotes } from './history.ts';
import type { SmartAccountHistoryStatus } from './smart-account-history.ts';

/**
 * The Activity list's state machine, free of React so the check scripts
 * drive the exact code with fakes (useHistory.ts wraps it in a hook).
 *
 * Why it exists (emulator pass of 2026-10-11, finding F3): the list's
 * "Load more" footer once showed only a spinner for over ten minutes. The
 * old hook read the next page's cursor INSIDE a React state updater and
 * returned early when the variable was still empty. React runs an updater
 * at once only when the component has no other update pending (the
 * eager-state path of dispatchSetState in the installed renderer,
 * react-native 0.86.3 Libraries/Renderer/implementations/ReactFabric-dev.js
 * lines 6966–6971: `0 === fiber.lanes && (null === alternate || 0 ===
 * alternate.lanes)`); the Activity screen updates constantly while
 * scrolling (decoded sentences, visible rows), so the updater was often
 * deferred to the next render. The load then returned without fetching,
 * and the deferred updater later set `loadingMore: true` with nothing left
 * to clear it: a spinner forever, with the "Load more" link hidden behind
 * it.
 *
 * Here the cursor lives in the session (a plain object the controller
 * holds, like a ref), never in React state, and every state change is
 * computed from the controller's own copy and then published. Rules:
 *  - one load-more at a time (an in-flight flag; a second call while one
 *    runs does nothing);
 *  - every page load is raced against HISTORY_PAGE_TIMEOUT_MS; a load more
 *    that fails or times out ends with `loadMoreError` set (the footer
 *    "Could not load more — tap to retry"), never with a spinner;
 *  - a timed-out load is not lost: the session keeps loading, and a retry
 *    joins the same load (or takes its result if it finished meanwhile),
 *    so nothing is fetched or listed twice;
 *  - a reload (pull to refresh, retry of the first page) opens a new
 *    session; answers of the old one are dropped (a generation counter).
 */

/** How long one page may take before the list offers a retry. */
export const HISTORY_PAGE_TIMEOUT_MS = 60_000;

/** The footer after a failed or timed-out "Load more"; tapping it tries again. */
export const LOAD_MORE_RETRY_FOOTER = 'Could not load more — tap to retry';

/** The technical line under that footer (or the first page's error) when a page timed out. */
export const HISTORY_PAGE_TIMEOUT_MESSAGE = 'The history endpoint did not answer within 60 seconds.';

export type HistoryState =
  | { status: 'loading' }
  /** No provider can serve this chain right now (EVM, or no endpoint). */
  | { status: 'unavailable'; note: string }
  /** The first page failed; retryable. */
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      entries: HistoryEntry[];
      /** True while older entries can be loaded. */
      hasMore: boolean;
      loadingMore: boolean;
      /** A load-more failure or timeout; the entries already shown are kept. */
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
      /**
       * Whether the active account's smart-account history is listed too
       * (smart-account-history.ts); absent when no smart account was
       * passed in.
       */
      smartAccount?: SmartAccountHistoryStatus;
    };

/** One page a session made ready. */
export type SessionPage =
  | { status: 'unavailable'; note: string }
  | {
      status: 'ok';
      /** The entries to append (and, for the logs fallback, its coverage). */
      page: HistoryPage;
      hasMore: boolean;
      note?: string;
      smartAccount?: SmartAccountHistoryStatus;
    };

/**
 * One reading of a chain's history from the newest entry backwards. The
 * session holds its own position (cursor or stream buffers).
 */
export interface HistorySession {
  /**
   * Loads the next page. A call while one is loading returns the same
   * promise; a call while a page is ready resolves at once. A rejection
   * leaves the session where it was, so the next call tries again.
   */
  fill(): Promise<void>;
  /** The page made ready by fill(), removed from the session; null when none is ready. */
  take(): SessionPage | null;
}

export interface HistorySnapshot {
  state: HistoryState;
  /** True while a pull-to-refresh reload is in flight. */
  refreshing: boolean;
}

export interface HistoryController {
  /** Re-fetches the first page through a new session (initial load, retry, pull to refresh). */
  reload(): Promise<void>;
  /** Fetches the next page and appends it; does nothing while one is loading or when there is no more. */
  loadMore(): Promise<void>;
  snapshot(): HistorySnapshot;
  /** Drops every later answer (unmount). */
  dispose(): void;
}

class PageTimeoutError extends Error {
  constructor() {
    super(HISTORY_PAGE_TIMEOUT_MESSAGE);
    this.name = 'PageTimeoutError';
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'History fetch failed';
}

export function createHistoryController(options: {
  open: () => HistorySession;
  onChange: (snapshot: HistorySnapshot) => void;
  timeoutMs?: number;
  /** Timer functions (the check scripts pass fakes). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): HistoryController {
  const timeoutMs = options.timeoutMs ?? HISTORY_PAGE_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let snap: HistorySnapshot = { state: { status: 'loading' }, refreshing: false };
  let generation = 0;
  let session: HistorySession | null = null;
  let moreInFlight = false;
  let disposed = false;

  const publish = (next: HistorySnapshot) => {
    snap = next;
    if (!disposed) options.onChange(snap);
  };
  const setState = (state: HistoryState) => publish({ ...snap, state });

  /** session.fill() raced against the page timeout, then the page it made ready. */
  async function nextPage(s: HistorySession): Promise<SessionPage> {
    let handle: unknown = null;
    try {
      await Promise.race([
        s.fill(),
        new Promise<never>((_, reject) => {
          handle = setTimer(() => reject(new PageTimeoutError()), timeoutMs);
        }),
      ]);
    } finally {
      if (handle !== null) clearTimer(handle);
    }
    const page = s.take();
    if (!page) throw new Error('History page missing');
    return page;
  }

  async function reload(): Promise<void> {
    if (disposed) return;
    const gen = ++generation;
    const s = options.open();
    session = s;
    // A load-more of the previous session no longer counts.
    moreInFlight = false;
    const prev = snap.state;
    publish({
      refreshing: true,
      state: prev.status === 'ok' ? { ...prev, loadingMore: false, loadMoreError: null } : { status: 'loading' },
    });
    try {
      const page = await nextPage(s);
      if (gen !== generation) return;
      if (page.status === 'unavailable') {
        setState({ status: 'unavailable', note: page.note });
        return;
      }
      const notes = historyNotesAfterPage(page.note ? { note: page.note } : {}, page.page);
      setState({
        status: 'ok',
        entries: page.page.entries,
        hasMore: page.hasMore,
        loadingMore: false,
        loadMoreError: null,
        ...notes,
        ...(page.smartAccount ? { smartAccount: page.smartAccount } : {}),
      });
    } catch (e) {
      if (gen === generation) setState({ status: 'error', message: errorMessage(e) });
    } finally {
      if (gen === generation) publish({ ...snap, refreshing: false });
    }
  }

  async function loadMore(): Promise<void> {
    const current = snap.state;
    if (disposed || moreInFlight || !session || current.status !== 'ok' || !current.hasMore) return;
    moreInFlight = true;
    const gen = generation;
    const s = session;
    setState({ ...current, loadingMore: true, loadMoreError: null });
    try {
      const page = await nextPage(s);
      if (gen !== generation) return;
      const prev = snap.state;
      if (prev.status !== 'ok') return;
      if (page.status === 'unavailable') {
        // The endpoint was removed between pages; keep what is shown.
        setState({ ...prev, loadingMore: false, loadMoreError: 'Endpoint no longer configured' });
        return;
      }
      // Defence in depth: an entry already listed (same uid) is never
      // listed twice (a transaction confirmed between a first page that
      // included the mempool and a confirmed-only later page).
      const seen = new Set(prev.entries.map((entry) => entry.uid ?? entry.id));
      const fresh = page.page.entries.filter((entry) => !seen.has(entry.uid ?? entry.id));
      // The note fields carry over (a logs-fallback page updates them with
      // the range answered so far, including a refusal that ended paging).
      const notes = historyNotesAfterPage(
        {
          ...(prev.note !== undefined ? { note: prev.note } : {}),
          ...(prev.noteDetail !== undefined ? { noteDetail: prev.noteDetail } : {}),
          ...(prev.coverage !== undefined ? { coverage: prev.coverage } : {}),
        },
        page.page,
      );
      setState({
        status: 'ok',
        entries: [...prev.entries, ...fresh],
        hasMore: page.hasMore,
        loadingMore: false,
        loadMoreError: null,
        ...notes,
        // Once failed, the smart-account history stays failed until a reload.
        ...(prev.smartAccount === 'failed' || page.smartAccount === 'failed'
          ? { smartAccount: 'failed' as const }
          : prev.smartAccount !== undefined
            ? { smartAccount: prev.smartAccount }
            : page.smartAccount !== undefined
              ? { smartAccount: page.smartAccount }
              : {}),
      });
    } catch (e) {
      if (gen === generation) {
        const prev = snap.state;
        if (prev.status === 'ok') setState({ ...prev, loadingMore: false, loadMoreError: errorMessage(e) });
      }
    } finally {
      if (gen === generation) moreInFlight = false;
    }
  }

  return {
    reload,
    loadMore,
    snapshot: () => snap,
    dispose() {
      disposed = true;
      generation += 1;
    },
  };
}

import type { HistoryEntry, HistoryPage } from '@shiba-wallet/core';

/**
 * The Activity list of one EVM account through a history indexer, merged
 * IN TIME ORDER from several cursored streams, with the account's smart
 * account listed next to it (emulator re-check of 2026-10-11, finding 4;
 * redesigned after the pass of the same day, findings F1 and F2: the
 * first version paged the account's stream and the smart account's stream
 * independently and appended each page below the last, so a later page
 * could repeat a transaction already listed as a smart-account row, and
 * the list went out of time order across pages and even within one page).
 *
 * STREAMS. The engine's indexer provider (packages/chains-evm/src/
 * indexer-history.ts, alchemy_getAssetTransfers ordered by block, newest
 * first) is used ONE-SIDED (its `direction` option): transfers sent by an
 * address, and transfers received by it, are separate streams, each in
 * block order. The two-sided provider cannot be merged by time, because
 * its two queries page independently and one of its pages already mixes
 * time ranges. So the account has two streams (sent, received) and its
 * smart account two more.
 *
 * THE MERGE RULE. Each stream keeps a buffer of entries fetched but not
 * yet listed, and a frontier: the block of the oldest entry it has fetched
 * (before its first fetch, +infinity). A stream that has nothing more
 * (no cursor) has no frontier. The bound is the LATEST (highest) frontier
 * among the streams that still have more. An entry is listed only when its
 * block is STRICTLY above the bound: then every stream has fetched every
 * entry of that block, because a stream is in block order. (Strictly, not
 * "at or after": a page boundary can split one block, and one transaction
 * can produce several entries — a token transfer and a native movement —
 * so the rest of the bound's block may still be on the next page.) While
 * fewer than PAGE_TARGET entries are listable, the stream(s) whose
 * frontier IS the bound are fetched (the stream "ahead" holds the others
 * back), at most MAX_FETCH_ROUNDS times per page. When no stream has more,
 * everything left is listable. Listed entries are ordered by block, newest
 * first; within one block, the account's own entries come before the
 * smart account's, each stream's own order kept. So the list is in time
 * order across every page.
 *
 * ONE TRANSACTION, ONE PLACE. Every entry of a transaction is in one
 * block, so when it is listed every stream has already fetched all of that
 * transaction's entries. Then:
 *  - the account's own entries are listed as the SAME objects the provider
 *    returned; if the smart account's streams also hold an entry with the
 *    same transaction hash, the own entries are marked as involving the
 *    smart account (involvesSmartAccount(entry) — a side record, so the
 *    objects are not changed) and the row shows "with smart account";
 *  - the smart account's entries of a transaction that has ANY entry of
 *    the account's own are NOT listed (no mirror row: the live case
 *    0x341db91c…, Account 1 → its Kernel account 0.0015, is listed once,
 *    as Account 1's "−0.0015" row whose sentence reads "Sent 0.0015 test
 *    ETH to your smart account");
 *  - every other smart-account entry is listed as a copy marked
 *    `smartAccount: true` with its uid prefixed "smart-account:" (so list
 *    keys never collide); its direction and amount are the smart
 *    account's;
 *  - an entry listed by both one-sided streams of one address (a
 *    self-transfer: the same uid) is listed once.
 *
 * FAILURES. A failure of one of the account's own streams fails the page;
 * whatever the other streams fetched in the same round is kept, and the
 * next call fetches again (nothing is listed twice and nothing skipped). A
 * failure of a smart-account stream never hides the account's own
 * entries: both smart-account streams stop, their unlisted entries are
 * dropped, the page reports 'failed', and they are not queried again until
 * a reload (pull to refresh).
 *
 * The tracked-token logs fallback (token-history.ts) is built for one
 * wallet address and searches block windows of Transfer logs; a second
 * address would double that scan, so it is not extended — useHistory.ts
 * reports the smart account as skipped and the screen says so.
 *
 * Free of React Native imports so the check scripts run the exact code.
 */

/** A history entry that belongs to the smart account, not the account's own address. */
export interface SmartAccountHistoryEntry extends HistoryEntry {
  smartAccount: true;
}

/** True for an entry of the smart account's history (the row shows a "smart account" marker). */
export function isSmartAccountEntry(entry: HistoryEntry): boolean {
  return (entry as Partial<SmartAccountHistoryEntry>).smartAccount === true;
}

/** Whether a page includes the smart account's entries. */
export type SmartAccountHistoryStatus = 'included' | 'failed' | 'skipped';

/** Entries listed per page when the streams have that many (a judgement; the first version listed up to 100). */
export const PAGE_TARGET = 50;
/** Fetch rounds per page at most (each fetches the stream or streams holding the others back). */
export const MAX_FETCH_ROUNDS = 8;

/** One cursored stream: one side of one address, in block order, newest first. */
export interface HistoryStream {
  /** 'own' = the account's own address; 'smart' = its smart account. */
  group: 'own' | 'smart';
  /** The page after `cursor` (the first page when undefined). */
  fetch(cursor: string | undefined): Promise<HistoryPage>;
}

/** What one fill() of a merged feed makes ready. */
export interface MergedHistoryPage {
  /** The entries to append, newest first, all older than everything listed before. */
  entries: HistoryEntry[];
  /** True while a stream has more or entries are still held back. */
  hasMore: boolean;
  /** Present when smart-account streams were given. */
  smartAccount?: 'included' | 'failed';
}

/** A merged feed: fill() loads the next page (one at a time), take() hands it over. */
export interface MergedHistoryFeed {
  /**
   * Loads the next page. A call while one is loading returns the same
   * promise; a call while a page is ready resolves at once. A rejection
   * leaves the feed able to try again.
   */
  fill(): Promise<void>;
  /** The page made ready by fill(), removed from the feed; null when none is ready. */
  take(): MergedHistoryPage | null;
}

const involved = new WeakSet<HistoryEntry>();

/**
 * True for one of the account's own entries whose transaction the smart
 * account's history also lists (its mirror row is not shown; the row says
 * "with smart account").
 */
export function involvesSmartAccount(entry: HistoryEntry): boolean {
  return involved.has(entry);
}

/** Block height for ordering; an entry without one (pending) counts as newest. */
function heightOf(entry: HistoryEntry): number {
  return entry.blockHeight ?? Number.MAX_SAFE_INTEGER;
}

interface StreamState {
  stream: HistoryStream;
  buffer: HistoryEntry[];
  cursor: string | undefined;
  fetched: boolean;
  /** No more pages. */
  done: boolean;
  /** Block of the oldest entry fetched so far; +Infinity before the first fetch. */
  frontier: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The time-ordered merge described in the file comment. `streams` are
 * fetched in their given order within a round (the account's sent and
 * received streams first, then the smart account's).
 */
export function createMergedHistoryFeed(
  streams: readonly HistoryStream[],
  options: { pageTarget?: number; maxRounds?: number } = {},
): MergedHistoryFeed {
  const pageTarget = options.pageTarget ?? PAGE_TARGET;
  const maxRounds = options.maxRounds ?? MAX_FETCH_ROUNDS;
  const states: StreamState[] = streams.map((stream) => ({
    stream,
    buffer: [],
    cursor: undefined,
    fetched: false,
    done: false,
    frontier: Number.POSITIVE_INFINITY,
  }));
  const hasSmart = streams.some((s) => s.group === 'smart');
  let smartFailed = false;
  const hashes = { own: new Set<string>(), smart: new Set<string>() };
  const listedUids = { own: new Set<string>(), smart: new Set<string>() };
  let ready: MergedHistoryPage | null = null;
  let inflight: Promise<void> | null = null;

  const live = () => states.filter((s) => !s.done);
  const bound = () => live().reduce((max, s) => Math.max(max, s.frontier), Number.NEGATIVE_INFINITY);
  const listable = () => {
    const b = bound();
    return states.reduce((n, s) => n + s.buffer.filter((e) => heightOf(e) > b).length, 0);
  };

  const dropSmart = () => {
    smartFailed = true;
    for (const s of states) {
      if (s.stream.group !== 'smart') continue;
      s.done = true;
      s.buffer = [];
    }
  };

  async function fetchRound(targets: StreamState[]): Promise<void> {
    const results = await Promise.allSettled(targets.map((s) => s.stream.fetch(s.fetched ? s.cursor : undefined)));
    let ownError: unknown = null;
    let smartError = false;
    results.forEach((result, i) => {
      const s = targets[i]!;
      if (s.done) return; // a smart stream dropped by another's failure in this round
      if (result.status === 'rejected') {
        if (s.stream.group === 'own') ownError ??= result.reason;
        else smartError = true;
        return;
      }
      const page = result.value;
      s.fetched = true;
      s.buffer.push(...page.entries);
      for (const entry of page.entries) hashes[s.stream.group].add(entry.id.toLowerCase());
      if (page.entries.length > 0) s.frontier = Math.min(s.frontier, heightOf(page.entries[page.entries.length - 1]!));
      s.cursor = page.nextCursor || undefined;
      if (!s.cursor) s.done = true;
    });
    if (smartError) dropSmart();
    if (ownError !== null) throw ownError instanceof Error ? ownError : new Error(errorText(ownError));
  }

  function emit(): HistoryEntry[] {
    const b = bound();
    const candidates: { entry: HistoryEntry; group: 'own' | 'smart'; order: number }[] = [];
    let order = 0;
    for (const s of states) {
      const keep: HistoryEntry[] = [];
      for (const entry of s.buffer) {
        if (heightOf(entry) > b) candidates.push({ entry, group: s.stream.group, order: order++ });
        else keep.push(entry);
      }
      s.buffer = keep;
    }
    // Newest block first; within a block the account's own entries first,
    // then each stream's own order.
    candidates.sort(
      (x, y) =>
        heightOf(y.entry) - heightOf(x.entry) ||
        (x.group === y.group ? 0 : x.group === 'own' ? -1 : 1) ||
        x.order - y.order,
    );
    const out: HistoryEntry[] = [];
    for (const { entry, group } of candidates) {
      const uid = entry.uid ?? entry.id;
      if (listedUids[group].has(uid)) continue;
      listedUids[group].add(uid);
      const hash = entry.id.toLowerCase();
      if (group === 'own') {
        if (hashes.smart.has(hash)) involved.add(entry);
        out.push(entry);
      } else if (!hashes.own.has(hash)) {
        const marked: SmartAccountHistoryEntry = { ...entry, smartAccount: true, uid: `smart-account:${uid}` };
        out.push(marked);
      }
    }
    return out;
  }

  async function load(): Promise<void> {
    for (let round = 0; ; round++) {
      const streamsLeft = live();
      if (streamsLeft.length === 0 || listable() >= pageTarget || round >= maxRounds) break;
      const b = bound();
      await fetchRound(streamsLeft.filter((s) => s.frontier === b));
    }
    const entries = emit();
    ready = {
      entries,
      hasMore: live().length > 0 || states.some((s) => s.buffer.length > 0),
      ...(hasSmart ? { smartAccount: smartFailed ? ('failed' as const) : ('included' as const) } : {}),
    };
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

/** Short form used in the notes: 0x1234…abcd. */
function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** The Activity screen's line about the smart account's history, or null when there is none to say. */
export function smartAccountHistoryNote(status: SmartAccountHistoryStatus | undefined, smartAccount: string | null): string | null {
  if (!smartAccount || status === undefined) return null;
  const short = shortAddress(smartAccount);
  switch (status) {
    case 'included':
      return (
        `Your smart account (${short}) is listed too. Its rows are marked "smart account", and their ` +
        'direction and amount are what the smart account sent or received.'
      );
    case 'failed':
      return (
        `Your smart account’s transactions (${short}) could not be loaded right now, so only this ` +
        'account’s own address is listed. Pull down to try again.'
      );
    case 'skipped':
      return (
        `Your smart account’s transactions (${short}) are not listed: without a history indexer the ` +
        'wallet searches only this account’s own address. A history indexer (Settings → Ethereum ' +
        'history indexer) lists both.'
      );
  }
}

import type { HistoryEntry, HistoryPage, HistoryProvider } from '@shiba-wallet/core';

/**
 * The active account's smart-account history next to its own (emulator
 * re-check of 2026-10-11, finding 4: the Activity screen listed only the
 * account's own address, so the transactions of its Kernel smart account —
 * EntryPoint bundles sent by a bundler, which move value from the smart
 * account in internal calls — never appeared, and a note saved for a
 * smart-account send could not be seen).
 *
 * The EVM history indexer (packages/chains-evm/src/indexer-history.ts,
 * alchemy_getAssetTransfers) is queried by address: HistoryProvider
 * .getHistory(address, cursor) takes any address, and the provider's own
 * cursor carries only that query's pageKeys. So the smart account's
 * history is one more getHistory call on the same provider per page (the
 * provider sends its usual two requests for it: transfers sent by the
 * address and transfers received by it). The two streams are merged here:
 *
 *  - the account's own entries are kept exactly as the provider returned
 *    them (the same objects, in the same order);
 *  - a smart-account entry whose transaction hash is already listed for
 *    the account's own address is dropped (one transaction, one place:
 *    for example a top-up from the account to its own smart account);
 *  - every other smart-account entry is marked (`smartAccount: true`, its
 *    uid prefixed so list keys never collide) and inserted by block,
 *    newest first, after the account's own entries of the same block.
 *
 * The cursor holds both streams' cursors; a stream that is exhausted is
 * not queried again. A failure of the smart-account query never hides the
 * account's own entries: the page carries them, reports the failure, and
 * the smart-account stream is not queried again until a reload. A failure
 * of the account's own query fails the page as before.
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

/** A page built by withSmartAccountHistory. */
export interface SmartAccountHistoryPage extends HistoryPage {
  smartAccountHistory: { address: string; status: 'included' | 'failed'; error?: string };
}

/** The smart-account report of a page, if it came from withSmartAccountHistory. */
export function smartAccountHistoryOf(page: HistoryPage): SmartAccountHistoryPage['smartAccountHistory'] | undefined {
  const report = (page as Partial<SmartAccountHistoryPage>).smartAccountHistory;
  return report && typeof report === 'object' ? report : undefined;
}

/** Marks the composite cursor, so a provider's own cursor is never mistaken for it. */
const CURSOR_VERSION = 'own+smart-account-1';

interface CompositeCursor {
  v: typeof CURSOR_VERSION;
  own?: string;
  smart?: string;
}

function encodeCursor(state: { own?: string; smart?: string }): string | undefined {
  if (state.own === undefined && state.smart === undefined) return undefined;
  return JSON.stringify({ v: CURSOR_VERSION, ...state });
}

function decodeCursor(cursor: string): CompositeCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new Error('Unrecognized history cursor');
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== CURSOR_VERSION) {
    throw new Error('Unrecognized history cursor');
  }
  const p = parsed as { own?: unknown; smart?: unknown };
  return {
    v: CURSOR_VERSION,
    ...(typeof p.own === 'string' ? { own: p.own } : {}),
    ...(typeof p.smart === 'string' ? { smart: p.smart } : {}),
  };
}

/** Block height for ordering; an entry without one (pending) counts as newest. */
function heightOf(entry: HistoryEntry): number {
  return entry.blockHeight ?? Number.POSITIVE_INFINITY;
}

/**
 * Merges one page of the account's own entries with one page of its smart
 * account's entries (see the file comment). `shownIds` are transaction
 * hashes already listed on earlier pages; smart-account entries for them
 * are dropped too.
 */
export function mergeSmartAccountEntries(
  own: readonly HistoryEntry[],
  smart: readonly HistoryEntry[],
  shownIds: Iterable<string> = [],
): HistoryEntry[] {
  const listed = new Set<string>([...shownIds].map((id) => id.toLowerCase()));
  for (const entry of own) listed.add(entry.id.toLowerCase());
  const marked: SmartAccountHistoryEntry[] = smart
    .filter((entry) => !listed.has(entry.id.toLowerCase()))
    .map((entry) => ({ ...entry, smartAccount: true as const, uid: `smart-account:${entry.uid ?? entry.id}` }))
    // Stable: equal heights keep the provider's order.
    .sort((a, b) => heightOf(b) - heightOf(a));
  const out: HistoryEntry[] = [];
  let next = 0;
  for (const entry of own) {
    while (next < marked.length && heightOf(marked[next]!) > heightOf(entry)) out.push(marked[next++]!);
    out.push(entry);
  }
  while (next < marked.length) out.push(marked[next++]!);
  return out;
}

/**
 * Entries of a later page that are not yet listed: the uid rule the
 * Activity list always applied, plus a smart-account entry whose
 * transaction is already listed (from either stream) is dropped. The
 * account's own entries are never dropped for a smart-account row.
 */
export function freshHistoryEntries(previous: readonly HistoryEntry[], page: readonly HistoryEntry[]): HistoryEntry[] {
  const seenUids = new Set(previous.map((entry) => entry.uid ?? entry.id));
  const seenIds = new Set(previous.map((entry) => entry.id.toLowerCase()));
  return page.filter((entry) => {
    if (seenUids.has(entry.uid ?? entry.id)) return false;
    return !(isSmartAccountEntry(entry) && seenIds.has(entry.id.toLowerCase()));
  });
}

/**
 * A provider that lists `smartAccount`'s history next to the queried
 * address's, through the same `base` provider (one more getHistory call
 * per page while the smart-account stream has more).
 */
export function withSmartAccountHistory(base: HistoryProvider, smartAccount: string): HistoryProvider {
  return {
    async getHistory(address: string, cursor?: string): Promise<SmartAccountHistoryPage> {
      const state = cursor === undefined ? null : decodeCursor(cursor);
      const queryOwn = state === null || state.own !== undefined;
      const querySmart = state === null || state.smart !== undefined;
      const [ownPage, smartResult] = await Promise.all([
        queryOwn ? base.getHistory(address, state?.own) : Promise.resolve(null),
        querySmart
          ? base.getHistory(smartAccount, state?.smart).then(
              (page) => ({ ok: true as const, page }),
              (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
            )
          : Promise.resolve(null),
      ]);
      const smartPage = smartResult?.ok ? smartResult.page : null;
      const entries = mergeSmartAccountEntries(ownPage?.entries ?? [], smartPage?.entries ?? []);
      const nextCursor = encodeCursor({
        ...(ownPage?.nextCursor ? { own: ownPage.nextCursor } : {}),
        ...(smartPage?.nextCursor ? { smart: smartPage.nextCursor } : {}),
      });
      const failed = smartResult !== null && !smartResult.ok;
      return {
        entries,
        ...(nextCursor ? { nextCursor } : {}),
        smartAccountHistory: {
          address: smartAccount,
          status: failed ? 'failed' : 'included',
          ...(failed && smartResult && !smartResult.ok ? { error: smartResult.error } : {}),
        },
      };
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

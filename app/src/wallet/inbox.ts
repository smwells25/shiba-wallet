/**
 * The notifications inbox (phase 22 item 5, feature 83): an in-app list of
 * what the wallet has told the user, kept on this phone only.
 *
 * What is recorded, each at the one place where the wallet already decides
 * to tell the user (one write per event; a second report of the same event
 * finds its entry and writes nothing):
 *  - a recurring payment or swap that fell due: the in-app banner
 *    (components/RecurringDueBanner.tsx) and the phone reminder
 *    (notifications.ts syncRecurring) report the SAME event key — the
 *    reminder's identifier plus the slot's due time — so a slot announced
 *    by both is listed once, with the sentence of whichever came first;
 *  - a takeover attempt found by the Inheritance check (the notification
 *    notifications.ts observeTakeovers posts);
 *  - a price alert that fired (components/PriceAlertMonitor.tsx: the banner
 *    and, when reminders are on, the notification come from one check, so
 *    one entry);
 *  - a WalletConnect or in-app-browser request that was sent (the sent view,
 *    wc-sent.ts wcSentResult), a speed-up or cancellation that was sent, and
 *    the notice saying which transaction a block included
 *    (components/PendingTransactions.tsx).
 *
 * A reminder that is SCHEDULED for a later time is stored with that time and
 * stays hidden until it arrives; when the wallet cancels or moves the
 * reminder before then, the future entry is dropped with it.
 *
 * Secret-free by construction: an entry holds a kind, how it was shown, a
 * time, a title, the sentence shown at the time, whether it was read, and
 * two 16-hex tags (sha256 of the event key, never the key itself). The
 * screen it opens follows from the kind; no chain id, account, address,
 * hash or amount is stored beyond what the sentence itself showed, and any
 * run of 32 or more hex characters a sentence might carry is shortened
 * before it is stored (a parse refuses one, too). Never a key, never a PIN.
 *
 * Stored through the storage seam under one wallet-scoped key
 * (STORE_KEYS.inbox), so a second wallet (the duress PIN's decoy) has its
 * own inbox. Strict parse: an entry that does not read back exactly makes
 * the store read-only (the readable entries are still shown) until the user
 * resets it. At most INBOX_MAX_ENTRIES entries; the oldest is evicted.
 *
 * Node-loadable (scripts/check-inbox.mjs): no React or React Native import.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
// Explicit .ts extensions: loaded by the check scripts under Node's type stripping.
import { STRIPPED_NAME_CHARS } from './names.ts';
import { t, type StringId } from '../i18n/index.ts';
import {
  AsyncStorage,
  STORE_KEYS,
  lazyAppStore,
  readStoreItem,
  removeStoreItem,
  storeProfileOf,
  writeStoreItem,
  type KeyValueStore,
  type RemovableKeyValueStore,
} from './store-keys.ts';

export const INBOX_KEY = STORE_KEYS.inbox.name;
/** The most entries kept; recording one more evicts the oldest (by its time). */
export const INBOX_MAX_ENTRIES = 200;
const MAX_TITLE = 80;
const MAX_TEXT = 600;

export type InboxKind = 'recurring-due' | 'swap-due' | 'takeover' | 'price-alert' | 'sent' | 'replacement';
/** How the wallet told the user: its own screen, a phone notification, or a phone reminder set for that time. */
export type InboxVia = 'in-app' | 'notification' | 'scheduled';
/** The screen an entry opens: the same one its banner or notification opens. */
export type InboxTarget = 'Sessions' | 'Inheritance' | 'PriceAlerts' | 'Activity';

const KINDS: readonly InboxKind[] = ['recurring-due', 'swap-due', 'takeover', 'price-alert', 'sent', 'replacement'];
const VIAS: readonly InboxVia[] = ['in-app', 'notification', 'scheduled'];

/** The screen each kind opens (fixed: nothing stored can point anywhere else). */
export const INBOX_TARGET_BY_KIND: Readonly<Record<InboxKind, InboxTarget>> = Object.freeze({
  'recurring-due': 'Sessions',
  'swap-due': 'Sessions',
  takeover: 'Inheritance',
  'price-alert': 'PriceAlerts',
  sent: 'Activity',
  replacement: 'Activity',
});

export interface InboxEntry {
  /** 16 hex: sha256 of the event key. Two reports of one event have the same id. */
  id: string;
  /** 16 hex: sha256 of the event's group (a reminder's identifier, else the event key). */
  group: string;
  kind: InboxKind;
  via: InboxVia;
  /** Unix milliseconds: when it was shown (a scheduled reminder: when it is set to appear). */
  at: number;
  title: string;
  /** The plain sentence shown at the time. */
  text: string;
  read: boolean;
}

export interface InboxState {
  entries: InboxEntry[];
  /** True when the stored inbox did not read back in full: writes are refused until it is reset. */
  readOnly: boolean;
}

/** What a recorder reports. `key` and `group` are hashed before anything is stored. */
export interface InboxEvent {
  key: string;
  group?: string;
  kind: InboxKind;
  via: InboxVia;
  at: number;
  title: string;
  text: string;
}

export type InboxRecordOutcome = 'recorded' | 'duplicate' | 'read-only' | 'failed';

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const INBOX_TITLE = 'Inbox';
export const INBOX_INTRO =
  'What the wallet has told you: reminders, alerts and sent transactions, newest first. The list is kept on this ' +
  'phone only and never leaves it; it holds the sentence that was shown at the time, never a key.';
export const INBOX_PIN_NOTE =
  'The app PIN is on, so the wallet posts no phone notifications. The inbox still lists what the wallet showed you on ' +
  'its own screens, such as the recurring-payment banner, price alerts and sent transactions.';
export const INBOX_SCHEDULED_NOTE =
  'A phone reminder is listed at the time it was set to appear. Android may show one a little late, and after a ' +
  'force stop it does not show it at all until the wallet is opened again.';
export const INBOX_EMPTY = 'Nothing yet. Reminders, alerts and sent transactions will be listed here.';
export const INBOX_READ_ONLY_MESSAGE =
  'The inbox stored on this phone could not be read in full, so nothing new is added to it. The entries that could ' +
  'be read are shown. Reset the inbox to start a new, empty list.';
export const INBOX_RESET_TITLE = 'Reset the inbox?';
export const INBOX_RESET_BODY = 'Every entry in the inbox is deleted from this phone. Nothing else changes.';
export const INBOX_MARK_ALL_READ = 'Mark all read';

// The labels come from the string table (../i18n/en.ts, phase 22 item 6);
// in English each is the text it was before ("Recurring payment",
// "shown in the wallet", "Opens Activity" …), pinned by scripts/check-i18n.mjs.
const KIND_LABEL: Record<InboxKind, StringId> = {
  'recurring-due': 'inbox.kind.recurringDue',
  'swap-due': 'inbox.kind.swapDue',
  takeover: 'inbox.kind.takeover',
  'price-alert': 'inbox.kind.priceAlert',
  sent: 'inbox.kind.sent',
  replacement: 'inbox.kind.replacement',
};
const VIA_LABEL: Record<InboxVia, StringId> = {
  'in-app': 'inbox.via.inApp',
  notification: 'inbox.via.notification',
  scheduled: 'inbox.via.scheduled',
};

export function inboxKindLabel(kind: InboxKind): string {
  return t(KIND_LABEL[kind]);
}
export function inboxViaLabel(via: InboxVia): string {
  return t(VIA_LABEL[via]);
}

const TARGET_LABEL: Record<InboxTarget, StringId> = {
  Sessions: 'inbox.target.sessions',
  Inheritance: 'inbox.target.inheritance',
  PriceAlerts: 'inbox.target.priceAlerts',
  Activity: 'inbox.target.activity',
};
export function inboxTargetHint(target: InboxTarget): string {
  return t(TARGET_LABEL[target]);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "2026-10-19 03:30 UTC". */
export function inboxTimeText(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

export function inboxUnreadText(count: number): string {
  return count === 0 ? t('inbox.unread.none') : count === 1 ? t('inbox.unread.one') : t('inbox.unread.many', { count });
}

/** The Home link's text: "Inbox" or "Inbox (3 unread)". */
export function inboxLinkText(unread: number): string {
  return unread > 0 ? t('inbox.link', { count: unread }) : t('inbox.title');
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** 16 hex: the first 64 bits of sha256(text). Recomputable, not reversible. */
export function inboxTag(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text))).slice(0, 16);
}

/** Any run of 32+ hex characters (an address, a hash, a key): the store never holds one. */
export const LONG_HEX = /[0-9a-fA-F]{32,}/;

/** Shortens every long hex run to its first and last four characters ("0x1234…abcd"). */
export function shortenLongHex(text: string): string {
  return text.replace(/[0-9a-fA-F]{32,}/g, (h) => `${h.slice(0, 4)}…${h.slice(-4)}`);
}

function cleanText(raw: string, max: number): string {
  const cleaned = shortenLongHex(
    raw
      .normalize('NFC')
      .replace(STRIPPED_NAME_CHARS, '')
      .replace(/\s+/gu, ' ')
      .trim(),
  );
  const chars = Array.from(cleaned);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : cleaned;
}

/** The entry an event becomes (new, unread). Throws for an event that cannot be stored. */
export function entryFromEvent(event: InboxEvent): InboxEntry {
  if (!KINDS.includes(event.kind)) throw new Error('Unknown inbox kind.');
  if (!VIAS.includes(event.via)) throw new Error('Unknown inbox source.');
  if (!Number.isSafeInteger(event.at) || event.at < 0) throw new Error('An inbox time is a non-negative integer.');
  const title = cleanText(event.title, MAX_TITLE);
  const text = cleanText(event.text, MAX_TEXT);
  if (title === '' || text === '') throw new Error('An inbox entry needs a title and a sentence.');
  return {
    id: inboxTag(`event|${event.key}`),
    group: inboxTag(`group|${event.group ?? event.key}`),
    kind: event.kind,
    via: event.via,
    at: event.at,
    title,
    text,
    read: false,
  };
}

/**
 * The entries the screen shows at `nowMs`, newest first: everything except a
 * reminder set for a later time (it has not been shown yet).
 */
export function visibleInboxEntries(entries: readonly InboxEntry[], nowMs: number): InboxEntry[] {
  return entries.filter((e) => !(e.via === 'scheduled' && e.at > nowMs)).sort((a, b) => b.at - a.at);
}

export function inboxUnreadCount(entries: readonly InboxEntry[], nowMs: number): number {
  return visibleInboxEntries(entries, nowMs).filter((e) => !e.read).length;
}

/** Adds one entry, dropping a pending reminder it replaces, evicting the oldest past the cap. */
export function withEntry(entries: readonly InboxEntry[], entry: InboxEntry, nowMs: number): InboxEntry[] {
  let next = entries.filter(
    // A reminder moved to another time replaces the earlier pending one.
    (e) => !(entry.via === 'scheduled' && e.via === 'scheduled' && e.group === entry.group && e.at > nowMs),
  );
  next = [...next, entry];
  while (next.length > INBOX_MAX_ENTRIES) {
    let oldest = 0;
    for (let i = 1; i < next.length; i += 1) if (next[i]!.at < next[oldest]!.at) oldest = i;
    next.splice(oldest, 1);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Parse / serialize (strict)
// ---------------------------------------------------------------------------

const ENTRY_KEYS = ['at', 'group', 'id', 'kind', 'read', 'text', 'title', 'via'];
const TAG = /^[0-9a-f]{16}$/;

function parseEntry(raw: unknown): InboxEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).sort();
  if (keys.length !== ENTRY_KEYS.length || keys.some((k, i) => k !== ENTRY_KEYS[i])) return null;
  if (typeof r.id !== 'string' || !TAG.test(r.id)) return null;
  if (typeof r.group !== 'string' || !TAG.test(r.group)) return null;
  if (typeof r.kind !== 'string' || !KINDS.includes(r.kind as InboxKind)) return null;
  if (typeof r.via !== 'string' || !VIAS.includes(r.via as InboxVia)) return null;
  if (typeof r.at !== 'number' || !Number.isSafeInteger(r.at) || r.at < 0) return null;
  if (typeof r.read !== 'boolean') return null;
  for (const [field, max] of [['title', MAX_TITLE], ['text', MAX_TEXT]] as const) {
    const v = r[field];
    if (typeof v !== 'string' || v === '' || Array.from(v).length > max || LONG_HEX.test(v)) return null;
  }
  return {
    id: r.id,
    group: r.group,
    kind: r.kind as InboxKind,
    via: r.via as InboxVia,
    at: r.at,
    title: r.title as string,
    text: r.text as string,
    read: r.read,
  };
}

/** Reads the stored text: every entry that reads back, and whether anything did not. */
export function parseInbox(text: string | null): InboxState {
  if (text === null || text === '') return { entries: [], readOnly: false };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { entries: [], readOnly: true };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { entries: [], readOnly: true };
  const d = doc as Record<string, unknown>;
  const keys = Object.keys(d).sort();
  const shapeOk = keys.length === 2 && keys[0] === 'entries' && keys[1] === 'version' && d.version === 1;
  if (!Array.isArray(d.entries)) return { entries: [], readOnly: true };
  const entries: InboxEntry[] = [];
  const ids = new Set<string>();
  let bad = !shapeOk || d.entries.length > INBOX_MAX_ENTRIES;
  for (const raw of d.entries) {
    const e = parseEntry(raw);
    if (!e || ids.has(e.id)) {
      bad = true;
      continue;
    }
    ids.add(e.id);
    entries.push(e);
  }
  return { entries, readOnly: bad };
}

export function serializeInbox(entries: readonly InboxEntry[]): string {
  return JSON.stringify({
    version: 1,
    entries: entries.map((e) => ({
      id: e.id,
      group: e.group,
      kind: e.kind,
      via: e.via,
      at: e.at,
      title: e.title,
      text: e.text,
      read: e.read,
    })),
  });
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface Inbox {
  load(): Promise<InboxState>;
  /** One write per event: an event already listed (same key) writes nothing. Never throws. */
  record(event: InboxEvent): Promise<InboxRecordOutcome>;
  /** Drops the not-yet-shown reminder entries of one group (a reminder cancelled before its time). Never throws. */
  dropScheduled(group: string): Promise<void>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
  /** Writes an empty inbox (also the way out of a damaged one). */
  reset(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** Bumped by the wipe: every inbox forgets the ids it remembered (a new wallet starts empty). */
let memoryEpoch = 0;

export function createInbox(deps: { store: KeyValueStore; now?: () => number }): Inbox {
  const now = deps.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  let queue: Promise<unknown> = Promise.resolve();
  /** Ids known to be stored, per profile (skips a read for an event already listed). */
  const known = new Map<string, Set<string>>();
  let epoch = memoryEpoch;
  const profileId = () => storeProfileOf(deps.store).id;
  const knownSet = () => {
    if (epoch !== memoryEpoch) {
      known.clear();
      epoch = memoryEpoch;
    }
    let s = known.get(profileId());
    if (!s) {
      s = new Set();
      known.set(profileId(), s);
    }
    return s;
  };

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }
  function notify(): void {
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // A listener never affects the store.
      }
    }
  }
  async function read(): Promise<InboxState> {
    const state = parseInbox(await readStoreItem(deps.store, INBOX_KEY));
    const set = knownSet();
    set.clear();
    for (const e of state.entries) set.add(e.id);
    return state;
  }
  async function write(entries: InboxEntry[]): Promise<void> {
    await writeStoreItem(deps.store, INBOX_KEY, serializeInbox(entries));
    const set = knownSet();
    set.clear();
    for (const e of entries) set.add(e.id);
  }
  async function edit(change: (entries: InboxEntry[]) => InboxEntry[] | null): Promise<void> {
    const state = await read();
    if (state.readOnly) return;
    const next = change(state.entries);
    if (next === null) return;
    await write(next);
    notify();
  }

  return {
    load: () => serial(read),
    record: (event) =>
      serial(async () => {
        let entry: InboxEntry;
        try {
          entry = entryFromEvent(event);
        } catch {
          return 'failed' as const;
        }
        if (knownSet().has(entry.id)) return 'duplicate' as const;
        try {
          const state = await read();
          if (state.entries.some((e) => e.id === entry.id)) return 'duplicate' as const;
          if (state.readOnly) return 'read-only' as const;
          await write(withEntry(state.entries, entry, now()));
          notify();
          return 'recorded' as const;
        } catch {
          return 'failed' as const;
        }
      }),
    dropScheduled: (group) =>
      serial(async () => {
        const tag = inboxTag(`group|${group}`);
        const t = now();
        try {
          await edit((entries) => {
            const next = entries.filter((e) => !(e.via === 'scheduled' && e.group === tag && e.at > t));
            return next.length === entries.length ? null : next;
          });
        } catch {
          // A pending entry left behind shows only once its time has come.
        }
      }),
    markRead: (id) =>
      serial(() =>
        edit((entries) => {
          if (!entries.some((e) => e.id === id && !e.read)) return null;
          return entries.map((e) => (e.id === id ? { ...e, read: true } : e));
        }),
      ),
    markAllRead: () =>
      serial(() => {
        const t = now();
        return edit((entries) => {
          const visible = new Set(visibleInboxEntries(entries, t).map((e) => e.id));
          if (!entries.some((e) => visible.has(e.id) && !e.read)) return null;
          return entries.map((e) => (visible.has(e.id) ? { ...e, read: true } : e));
        });
      }),
    reset: () =>
      serial(async () => {
        await write([]);
        notify();
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let appInstance: Inbox | null = null;

/** The app's inbox (AsyncStorage, loaded lazily through the storage seam). */
export function appInbox(): Inbox {
  if (!appInstance) appInstance = createInbox({ store: lazyAppStore() });
  return appInstance;
}

/**
 * The wipe (WalletContext): removes the inbox of the wallet the store is
 * scoped to, and makes every inbox forget the ids it remembered, so a new
 * wallet starts empty and nothing of the old one is treated as already listed.
 */
export async function wipeInbox(store: RemovableKeyValueStore = AsyncStorage): Promise<void> {
  memoryEpoch += 1;
  if (store.removeItem) await removeStoreItem(store, INBOX_KEY);
  else await writeStoreItem(store, INBOX_KEY, serializeInbox([]));
  memoryEpoch += 1;
}

// ---------------------------------------------------------------------------
// Events built here (the recorders pass only what they already show)
// ---------------------------------------------------------------------------

/** The key of one due slot of a recurring payment or swap: its reminder identifier and the slot's due time (unix seconds). */
export function dueEventKey(identifier: string, slotAt: number): string {
  return `due|${identifier}|${slotAt}`;
}
/** The group of every due slot of one recurring payment or swap (its reminder identifier). */
export function dueEventGroup(identifier: string): string {
  return `due|${identifier}`;
}

/** A request from a dApp (WalletConnect or the in-app browser) that was sent: the sent view's title and line. */
export function wcSentInboxEvent(
  result: { key: string; title: string; dappName: string; network: string; txid: string | null; userOpHash: string | null; detail?: string | null },
  nowMs: number,
): InboxEvent {
  return {
    // The queue key alone can repeat across launches (the browser's ids are
    // counters); the hash it was sent under cannot.
    key: `wc-sent|${result.network}|${result.key}|${result.txid ?? ''}|${result.userOpHash ?? ''}`,
    kind: 'sent',
    via: 'in-app',
    at: nowMs,
    title: result.title,
    text: `Sent for ${result.dappName}.${result.detail ? ` ${result.detail}` : ''}`,
  };
}

/** A speed-up or cancellation the network endpoint accepted (the alert PendingTransactions shows). */
export function replacementSentInboxEvent(args: { chain: string; txid: string; title: string; text: string; nowMs: number }): InboxEvent {
  return { key: `replacement-sent|${args.chain}|${args.txid.toLowerCase()}`, kind: 'sent', via: 'in-app', at: args.nowMs, title: args.title, text: args.text };
}

/** The notice saying which transaction of a replaced nonce a block included. */
export function replacementNoticeInboxEvent(args: {
  chain: string;
  from: string;
  nonce: string;
  minedHash: string;
  outcome: string;
  resolvedAt: number;
  text: string;
}): InboxEvent {
  const title = args.outcome === 'replaced' ? 'Sped up' : args.outcome === 'cancelled' ? 'Cancelled' : 'Original transaction included';
  return {
    key: `replacement|${args.chain}|${args.from.toLowerCase()}|${args.nonce}|${args.minedHash.toLowerCase()}`,
    kind: 'replacement',
    via: 'in-app',
    at: args.resolvedAt,
    title,
    text: args.text,
  };
}

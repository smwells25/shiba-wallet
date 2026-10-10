import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HistoryEntry } from '@shiba-wallet/core';
// Explicit .ts extensions: scripts/check-notes.mjs loads this module under
// Node's type stripping, which resolves relative specifiers literally.
import type { KeyValueStore } from './tokens.ts';
import { sanitizeDisplayName } from './names.ts';
import { formatUnits } from './balances.ts';

/**
 * Transaction notes and receipts (feature 87).
 *
 * NOTES. A private note per transaction, written by the user on the Send
 * success screen or on an Activity row. Notes are stored only on this phone
 * (AsyncStorage under TX_NOTES_KEY), are never sent to any server, never
 * synced and never included in a backup or the recovery phrase; the wallet
 * wipe deletes them (wipeTransactionNotes). Notes are the user's own words
 * and are therefore never masked by Hide amounts.
 *
 * KEY RULE. A note belongs to a NETWORK (the CAIP-2 id of the network the
 * transaction is on — the ACTIVE EVM profile's id for the EVM slot, e.g.
 * "eip155:11155111" on Ethereum Sepolia) and a TRANSACTION ID (the id the
 * Activity list shows: an EVM transaction hash, a Bitcoin or Dogecoin txid,
 * a Solana signature). It is not tied to an account, so a transfer between
 * two of the wallet's own accounts shows the same note on both.
 *
 * Smart-account operations are known by their UserOperation hash first;
 * the hash of the bundle transaction that carried them arrives later with
 * the receipt (and is what Activity lists). So:
 *  - A note saved before the bundle transaction is known is stored under
 *    the UserOperation hash ("op:" record).
 *  - When the transaction hash becomes known (linkUserOperation, called by
 *    the success screen when the receipt arrives, or a later save that
 *    passes both ids), the note MOVES to the transaction id ("tx:" record)
 *    and keeps the UserOperation hash on the record.
 *  - findNote looks up the transaction id first, then — when the caller
 *    knows which UserOperations the transaction carried (Activity's decoded
 *    rows) — any "op:" record for those hashes, so a note whose receipt
 *    never arrived on the success screen still appears once the row is
 *    decoded.
 *  - If a note already exists under the transaction id when a link would
 *    move another one there, nothing is merged or overwritten: both stay
 *    stored and the transaction-id note is the one shown.
 *
 * STORE DISCIPLINE (as the contacts store): a versioned JSON document,
 * strictly re-validated on every read. A store that cannot be parsed, has
 * an unknown version, or holds any entry that fails validation is
 * READ-ONLY: the valid notes are still shown, every write is refused with a
 * sentence pointing to "Reset notes", and nothing is silently dropped or
 * overwritten. Writes go through one queue per store so a save and a link
 * never interleave their read-modify-write steps.
 *
 * RECEIPTS. activityCsv builds a plain CSV file (RFC 4180: CRLF line ends,
 * every field in double quotes, a double quote doubled) of the entries the
 * Activity screen has loaded — never more — with their notes. Every field
 * that starts with = + - @ or a tab, carriage return or line feed gets a
 * leading apostrophe, the mitigation in OWASP's "CSV Injection" page
 * (https://owasp.org/www-community/attacks/CSV_Injection, now served at
 * https://community.owasp.org/attacks/CSV_Injection; read 2026-10-10: the
 * formula-start characters are =, +, -, @, tab, carriage return and line
 * feed; prepend a single quote, double every double quote, wrap each cell in
 * double quotes), so a note or a
 * token symbol cannot run as a spreadsheet formula. Amounts and fees are
 * exact decimal strings from bigints (formatUnits with every decimal kept),
 * never floating point.
 *
 * Deliberately free of React Native imports (AsyncStorage is only the
 * default store) so scripts/check-notes.mjs runs the exact code.
 */

export const TX_NOTES_KEY = 'shiba-wallet.tx-notes.v1';
const STORE_VERSION = 1;

/** Maximum note length, in Unicode code points. */
export const MAX_NOTE_LENGTH = 280;

/**
 * Most notes kept on this phone (all networks together). A judgement that
 * keeps the single stored document small (2,000 × 280 code points is at
 * most a few megabytes in the worst case); a save beyond it is refused
 * with a sentence, never by deleting older notes.
 */
export const MAX_NOTES = 2000;

export const NOTES_READ_ONLY_MESSAGE =
  'Your transaction notes could not be read completely, so nothing was changed. ' +
  'Use "Reset notes" on the Activity screen to start again with no notes.';

/** Shown next to the note field on the success screens and the editor. */
export const NOTE_PRIVACY_LINE =
  'Notes are kept only on this phone. They are not sent anywhere, not backed up by your ' +
  'recovery phrase and are deleted when the wallet is wiped. Hide amounts does not hide them.';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** CAIP-2 syntax: namespace [-a-z0-9]{3,8} ":" reference [-_a-zA-Z0-9]{1,32}. */
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const EVM_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UTXO_TXID_RE = /^[0-9a-fA-F]{64}$/;
/** A Solana signature: 64 bytes in base58 (at most 88 characters). */
const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

type Family = 'eip155' | 'bip122' | 'solana';

function familyOf(network: string): Family | null {
  if (typeof network !== 'string' || !CAIP2_RE.test(network)) return null;
  const namespace = network.slice(0, network.indexOf(':'));
  return namespace === 'eip155' || namespace === 'bip122' || namespace === 'solana' ? namespace : null;
}

/** The network id when notes are supported for it, else null. */
export function normalizeNoteNetwork(network: string): string | null {
  return familyOf(network) ? network : null;
}

/**
 * The stored form of a transaction id on a network, or null when it is not
 * a valid id there. Hex ids (EVM hashes, Bitcoin and Dogecoin txids) are
 * lowercased because hex is case-insensitive; Solana signatures are base58,
 * where case matters, and are kept exactly.
 */
export function normalizeTxId(network: string, id: string): string | null {
  if (typeof id !== 'string') return null;
  switch (familyOf(network)) {
    case 'eip155':
      return EVM_HASH_RE.test(id) ? id.toLowerCase() : null;
    case 'bip122':
      return UTXO_TXID_RE.test(id) ? id.toLowerCase() : null;
    case 'solana':
      return SOLANA_SIGNATURE_RE.test(id) ? id : null;
    default:
      return null;
  }
}

/** A UserOperation hash exists only on EVM networks. */
export function normalizeUserOpHash(network: string, hash: string): string | null {
  if (familyOf(network) !== 'eip155' || typeof hash !== 'string') return null;
  return EVM_HASH_RE.test(hash) ? hash.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

export type NoteValidation = { ok: true; note: string } | { ok: false; error: string };

/**
 * Cleans a note: line breaks and tabs become spaces, then the app's shared
 * display-name sanitizer runs (./names.ts sanitizeDisplayName: NFC,
 * control / bidirectional / invisible characters removed, every whitespace
 * run collapsed to one space, trimmed), then the length is bounded to at most
 * MAX_NOTE_LENGTH code points. An empty result is valid and means "no
 * note" (saving it removes the note).
 */
export function sanitizeNote(raw: string): NoteValidation {
  if (typeof raw !== 'string') return { ok: false, error: 'A note must be text.' };
  // The shared sanitizer refuses only an empty result when the length bound
  // is unlimited; the 280 bound and its wording are this module's own.
  // Line breaks and tabs become spaces first: the shared sanitizer removes
  // every C0 control character, which would otherwise glue the words on
  // either side of a line break together.
  const cleaned = sanitizeDisplayName(raw.replace(/[\t\n\v\f\r]/g, ' '), Number.MAX_SAFE_INTEGER, 'note');
  const note = cleaned.ok ? cleaned.name : '';
  const length = Array.from(note).length;
  if (length > MAX_NOTE_LENGTH) {
    return {
      ok: false,
      error: `A note can be at most ${MAX_NOTE_LENGTH} characters (this one is ${length}).`,
    };
  }
  return { ok: true, note };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** One stored note. */
export interface TransactionNote {
  network: string;
  /** The transaction id (stored form), or null while only the UserOperation is known. */
  txid: string | null;
  /** The UserOperation hash for smart-account operations, else null. */
  userOpHash: string | null;
  text: string;
  /** ISO 8601 time of the last save. */
  updatedAt: string;
}

export interface NoteBook {
  /** Every valid note, all networks. */
  notes: TransactionNote[];
  /**
   * True when the stored data could not be read completely (bad JSON, an
   * unknown version, or an entry that failed validation). Writes are
   * refused in that state; resetNotes is the explicit way out.
   */
  readOnly: boolean;
}

/** The store: AsyncStorage satisfies it; removeItem is used by the wipe when present. */
export type NotesStore = KeyValueStore & { removeItem?: (key: string) => Promise<void> };

interface RawRecord {
  text: string;
  updatedAt: string;
  userOpHash?: string;
}

interface RawStore {
  version: number;
  networks: Record<string, Record<string, unknown>>;
}

type ReadResult =
  | { state: 'empty' }
  | { state: 'ok'; raw: RawStore; notes: TransactionNote[]; dropped: number }
  | { state: 'unreadable' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const RECORD_FIELDS = new Set(['text', 'updatedAt', 'userOpHash']);

/** Re-validates one stored record; null when it was not written by this module. */
function reviveRecord(network: string, key: string, value: unknown): TransactionNote | null {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).some((field) => !RECORD_FIELDS.has(field))) return null;
  const { text, updatedAt, userOpHash } = value as Partial<RawRecord>;
  if (typeof text !== 'string' || typeof updatedAt !== 'string') return null;
  const clean = sanitizeNote(text);
  if (!clean.ok || clean.note === '' || clean.note !== text) return null;
  if (Number.isNaN(Date.parse(updatedAt))) return null;
  if (key.startsWith('tx:')) {
    const id = key.slice(3);
    if (normalizeTxId(network, id) !== id) return null;
    if (userOpHash !== undefined && normalizeUserOpHash(network, userOpHash) !== userOpHash) return null;
    return { network, txid: id, userOpHash: userOpHash ?? null, text, updatedAt };
  }
  if (key.startsWith('op:')) {
    const hash = key.slice(3);
    if (userOpHash !== undefined) return null;
    if (normalizeUserOpHash(network, hash) !== hash) return null;
    return { network, txid: null, userOpHash: hash, text, updatedAt };
  }
  return null;
}

async function readRaw(store: NotesStore): Promise<ReadResult> {
  let text: string | null;
  try {
    text = await store.getItem(TX_NOTES_KEY);
  } catch {
    // Storage itself failed: treat as unreadable so nothing is written over
    // data that may well still be there.
    return { state: 'unreadable' };
  }
  if (text === null) return { state: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'unreadable' };
  }
  if (!isPlainObject(parsed) || parsed.version !== STORE_VERSION || !isPlainObject(parsed.networks)) {
    return { state: 'unreadable' };
  }
  const networks: Record<string, Record<string, unknown>> = {};
  const notes: TransactionNote[] = [];
  let dropped = 0;
  for (const [network, records] of Object.entries(parsed.networks)) {
    if (!normalizeNoteNetwork(network) || !isPlainObject(records)) {
      dropped += 1;
      continue;
    }
    networks[network] = { ...records };
    for (const [key, value] of Object.entries(records)) {
      const note = reviveRecord(network, key, value);
      if (note) notes.push(note);
      else dropped += 1;
    }
  }
  return { state: 'ok', raw: { version: STORE_VERSION, networks }, notes, dropped };
}

/** Loads every note. Never throws. */
export async function loadNotes(store: NotesStore = AsyncStorage): Promise<NoteBook> {
  const read = await readRaw(store);
  if (read.state === 'empty') return { notes: [], readOnly: false };
  if (read.state === 'unreadable') return { notes: [], readOnly: true };
  return { notes: read.notes, readOnly: read.dropped > 0 };
}

// One queue per store: every write runs after the previous one finished.
const queues = new WeakMap<object, Promise<unknown>>();

function serialized<T>(store: NotesStore, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(store) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    store,
    next.catch(() => undefined),
  );
  return next;
}

/** Loads the store for a write; refuses a read-only store. */
async function loadForWrite(store: NotesStore): Promise<{ raw: RawStore; count: number }> {
  const read = await readRaw(store);
  if (read.state === 'unreadable' || (read.state === 'ok' && read.dropped > 0)) {
    throw new Error(NOTES_READ_ONLY_MESSAGE);
  }
  if (read.state === 'empty') return { raw: { version: STORE_VERSION, networks: {} }, count: 0 };
  return { raw: read.raw, count: read.notes.length };
}

async function writeRaw(raw: RawStore, store: NotesStore): Promise<void> {
  // Networks left without notes are dropped from the document.
  for (const [network, records] of Object.entries(raw.networks)) {
    if (Object.keys(records).length === 0) delete raw.networks[network];
  }
  await store.setItem(TX_NOTES_KEY, JSON.stringify(raw));
}

/** Which transaction a note belongs to. At least one id is required. */
export interface NoteRef {
  txid?: string | null;
  userOpHash?: string | null;
}

function resolveRef(network: string, ref: NoteRef): { txid: string | null; userOpHash: string | null } {
  if (!normalizeNoteNetwork(network)) throw new Error(`Notes are not supported for network ${network}.`);
  const txid = ref.txid ? normalizeTxId(network, ref.txid) : null;
  if (ref.txid && !txid) throw new Error('This transaction id is not valid on this network.');
  const userOpHash = ref.userOpHash ? normalizeUserOpHash(network, ref.userOpHash) : null;
  if (ref.userOpHash && !userOpHash) throw new Error('This UserOperation hash is not valid on this network.');
  if (!txid && !userOpHash) throw new Error('A note needs a transaction id or a UserOperation hash.');
  return { txid, userOpHash };
}

/**
 * Saves (or, with an empty text after cleaning, removes) the note for one
 * transaction. With a transaction id the note is stored under it — moving a
 * note saved earlier under the same UserOperation hash — and keeps the
 * UserOperation hash when one is known. With only a UserOperation hash it is
 * stored under that hash, unless a transaction-id note already carries the
 * hash (it was linked), which is then updated instead. Throws, persisting
 * nothing, for an invalid id or text, a read-only store, or MAX_NOTES.
 * Returns the saved note, or null when the note was removed.
 */
export function saveNote(
  network: string,
  ref: NoteRef,
  rawText: string,
  options: { store?: NotesStore; now?: () => Date } = {},
): Promise<TransactionNote | null> {
  const store = options.store ?? AsyncStorage;
  // Validate before queueing so a bad call fails at once.
  const ids = resolveRef(network, ref);
  const clean = sanitizeNote(rawText);
  if (!clean.ok) return Promise.reject(new Error(clean.error));
  return serialized(store, async () => {
    const { raw, count } = await loadForWrite(store);
    const records: Record<string, unknown> = { ...(raw.networks[network] ?? {}) };
    raw.networks[network] = records;
    let txid = ids.txid;
    let userOpHash = ids.userOpHash;
    if (!txid && userOpHash) {
      // Already linked: the note lives under the transaction id now.
      for (const [key, value] of Object.entries(records)) {
        if (key.startsWith('tx:') && isPlainObject(value) && value.userOpHash === userOpHash) {
          txid = key.slice(3);
          break;
        }
      }
    }
    const key = txid ? `tx:${txid}` : `op:${userOpHash}`;
    const existing = records[key];
    if (txid && !userOpHash && isPlainObject(existing) && typeof existing.userOpHash === 'string') {
      // Keep the UserOperation hash a linked record already carries.
      userOpHash = existing.userOpHash;
    }
    const opKey = txid && userOpHash ? `op:${userOpHash}` : null;
    const removedOp = opKey !== null && opKey in records;
    if (clean.note === '') {
      delete records[key];
      if (opKey) delete records[opKey];
      await writeRaw(raw, store);
      return null;
    }
    const isNew = !(key in records) && !removedOp;
    if (isNew && count >= MAX_NOTES) {
      throw new Error(
        `This phone already keeps ${MAX_NOTES} transaction notes, the most the wallet stores. ` +
          'Remove a note you no longer need first.',
      );
    }
    const updatedAt = (options.now ?? (() => new Date()))().toISOString();
    const record: RawRecord = {
      text: clean.note,
      updatedAt,
      ...(txid && userOpHash ? { userOpHash } : {}),
    };
    records[key] = record;
    if (opKey) delete records[opKey];
    await writeRaw(raw, store);
    return { network, txid: txid ?? null, userOpHash: userOpHash ?? null, text: clean.note, updatedAt };
  });
}

/**
 * Called when a smart-account operation's bundle transaction becomes known:
 * moves a note stored under the UserOperation hash to the transaction id.
 * Returns 'moved', 'none' (no note under the hash), 'kept-separate' (a note
 * already exists under the transaction id; both are kept and the
 * transaction-id note is shown) or 'read-only' (the store is damaged;
 * nothing changed). Never throws for a bad store; throws for invalid ids.
 */
export function linkUserOperation(
  network: string,
  userOpHash: string,
  txid: string,
  store: NotesStore = AsyncStorage,
): Promise<'moved' | 'none' | 'kept-separate' | 'read-only'> {
  const hash = normalizeUserOpHash(network, userOpHash);
  const id = normalizeTxId(network, txid);
  if (!hash || !id) return Promise.reject(new Error('Invalid UserOperation hash or transaction id.'));
  return serialized(store, async () => {
    let loaded: { raw: RawStore };
    try {
      loaded = await loadForWrite(store);
    } catch {
      return 'read-only' as const;
    }
    const records = loaded.raw.networks[network];
    const op = records?.[`op:${hash}`];
    if (!records || !isPlainObject(op)) return 'none' as const;
    if (`tx:${id}` in records) return 'kept-separate' as const;
    records[`tx:${id}`] = { text: op.text, updatedAt: op.updatedAt, userOpHash: hash };
    delete records[`op:${hash}`];
    await writeRaw(loaded.raw, store);
    return 'moved' as const;
  });
}

/** Replaces the store with an empty one (the explicit way out of a read-only store). */
export function resetNotes(store: NotesStore = AsyncStorage): Promise<void> {
  return serialized(store, () =>
    store.setItem(TX_NOTES_KEY, JSON.stringify({ version: STORE_VERSION, networks: {} })),
  );
}

/** Deletes every note (the wallet wipe). */
export function wipeTransactionNotes(store: NotesStore = AsyncStorage): Promise<void> {
  return serialized(store, async () => {
    if (store.removeItem) await store.removeItem(TX_NOTES_KEY);
    else await store.setItem(TX_NOTES_KEY, JSON.stringify({ version: STORE_VERSION, networks: {} }));
  });
}

/** Lookup structure for many rows (built once per load). */
export interface NoteIndex {
  byTx: Map<string, TransactionNote>;
  byOp: Map<string, TransactionNote>;
}

export function indexNotes(notes: readonly TransactionNote[]): NoteIndex {
  const byTx = new Map<string, TransactionNote>();
  const byOp = new Map<string, TransactionNote>();
  for (const note of notes) {
    if (note.txid) byTx.set(`${note.network}|${note.txid}`, note);
    else if (note.userOpHash) byOp.set(`${note.network}|${note.userOpHash}`, note);
  }
  return { byTx, byOp };
}

/**
 * The note shown for a transaction: the note stored under its id, else a
 * note stored under one of the UserOperation hashes it is known to carry
 * (Activity's decoded rows), else null.
 */
export function findNote(
  index: NoteIndex,
  network: string,
  txid: string,
  userOpHashes: readonly string[] = [],
): TransactionNote | null {
  const id = normalizeTxId(network, txid);
  if (id) {
    const hit = index.byTx.get(`${network}|${id}`);
    if (hit) return hit;
  }
  for (const raw of userOpHashes) {
    const hash = normalizeUserOpHash(network, raw);
    const hit = hash ? index.byOp.get(`${network}|${hash}`) : undefined;
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export const ACTIVITY_CSV_HEADER: readonly string[] = [
  'network',
  'date (UTC)',
  'direction',
  'amount',
  'asset',
  'fee',
  'fee asset',
  'counterparty',
  'transaction id',
  'explorer URL',
  'note',
];

export const ACTIVITY_CSV_MIME_TYPE = 'text/csv';
/** Apple's UTI for .csv (UTTypeCommaSeparatedText in the SDK's UTCoreTypes.h). */
export const ACTIVITY_CSV_UTI = 'public.comma-separated-values-text';
export const ACTIVITY_EXPORT_DIRECTORY = 'activity-export';

/** Under the Export button on the Activity screen. */
export function activityExportNote(loadedCount: number): string {
  const entries = loadedCount === 1 ? '1 entry' : `${loadedCount} entries`;
  return (
    `Exports the ${entries} loaded on this screen as a .csv file through the share sheet — ` +
    'not the whole history of the address; use Load more first to include older ones. ' +
    'The file contains addresses, exact amounts and your notes in clear text, even while ' +
    'Hide amounts is on. The temporary copy on this phone is deleted a minute after the share ' +
    'sheet closes.'
  );
}

/** Characters that make a spreadsheet read a cell as a formula (OWASP CSV Injection). */
const FORMULA_START_RE = /^[=+\-@\t\r\n]/;

/** Prefixes an apostrophe to a value a spreadsheet would read as a formula. */
export function defuseFormula(value: string): string {
  return FORMULA_START_RE.test(value) ? `'${value}` : value;
}

/** One CSV field: formula-defused, then quoted per RFC 4180 (quotes doubled). */
export function csvField(value: string): string {
  return `"${defuseFormula(value).replace(/"/g, '""')}"`;
}

/** Lines end with CRLF (RFC 4180 section 2), including the last one. */
export function csvDocument(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** Same words as history.ts directionLabel (pinned by check-notes). */
function directionWord(direction: HistoryEntry['direction']): string {
  return direction === 'in' ? 'Received' : direction === 'out' ? 'Sent' : 'Self';
}

/** "2026-10-10T08:15:00Z" for a timestamp; "block N" / "pending" / "" otherwise. */
export function exportDate(entry: Pick<HistoryEntry, 'timestamp' | 'confirmed' | 'blockHeight'>): string {
  if (entry.timestamp !== null && Number.isFinite(entry.timestamp)) {
    return new Date(entry.timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  if (!entry.confirmed) return 'pending';
  return entry.blockHeight !== undefined ? `block ${entry.blockHeight}` : '';
}

export interface ActivityExportInput {
  /** CAIP-2 id of the network the entries are on. */
  network: string;
  /** Its display label ("Ethereum Sepolia"). */
  networkLabel: string;
  /** The entries loaded on the screen, in screen order. Nothing else is exported. */
  entries: readonly HistoryEntry[];
  /** The network's native coin (fees, and amounts without an asset). */
  nativeSymbol: string;
  nativeDecimals: number;
  /** The notes to look rows up in. */
  notes: NoteIndex;
  /** Explorer link for a transaction id, or null. */
  explorerUrlFor: (txid: string) => string | null;
  /** The decoded counterparty for a transaction, when already known (no new requests). */
  counterpartyFor?: (txid: string) => string | null;
  /** UserOperation hashes a transaction is known to carry (decoded rows). */
  userOpHashesFor?: (txid: string) => readonly string[];
}

/** The data rows (without the header), one per loaded entry, in order. */
export function activityExportRows(input: ActivityExportInput): string[][] {
  const networkCell = `${input.networkLabel} (${input.network})`;
  return input.entries.map((entry) => {
    let amount = '';
    let asset = '';
    if (entry.assetAmount !== undefined && entry.assetDecimals !== undefined) {
      amount = formatUnits(entry.assetAmount, entry.assetDecimals, entry.assetDecimals);
      asset = entry.assetSymbol ?? '';
    } else if (entry.assetSymbol !== undefined) {
      // A token movement whose exact amount the provider did not supply:
      // the asset is named and the amount left empty rather than guessed.
      asset = entry.assetSymbol;
    } else if (entry.amount !== undefined) {
      amount = formatUnits(entry.amount, input.nativeDecimals, input.nativeDecimals);
      asset = input.nativeSymbol;
    }
    const fee = entry.fee !== undefined ? formatUnits(entry.fee, input.nativeDecimals, input.nativeDecimals) : '';
    const note = findNote(input.notes, input.network, entry.id, input.userOpHashesFor?.(entry.id) ?? []);
    return [
      networkCell,
      exportDate(entry),
      directionWord(entry.direction) + (entry.failed ? ' (failed)' : ''),
      amount,
      asset,
      fee,
      fee === '' ? '' : input.nativeSymbol,
      input.counterpartyFor?.(entry.id) ?? '',
      entry.id,
      input.explorerUrlFor(entry.id) ?? '',
      note?.text ?? '',
    ];
  });
}

/** The whole CSV file: header plus one row per loaded entry. */
export function activityCsv(input: ActivityExportInput): string {
  return csvDocument([ACTIVITY_CSV_HEADER, ...activityExportRows(input)]);
}

/**
 * shiba-activity_<network>_<account short>_<date>.csv, e.g.
 * shiba-activity_eip155-11155111_0x772e-F44F_2026-10-10.csv. Only letters,
 * digits and hyphens appear between the underscores.
 */
export function activityExportFileName(network: string, address: string, now: Date = new Date()): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9-]/g, '-');
  const short = address.length > 12 ? `${address.slice(0, 6)}-${address.slice(-4)}` : address;
  const date = now.toISOString().slice(0, 10);
  return `shiba-activity_${safe(network)}_${safe(short)}_${date}.csv`;
}

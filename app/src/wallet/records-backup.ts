// RECORDS BACKUP (feature 47; phase 22 item 4): one encrypted file holding
// the wallet's own RECORDS — what the recovery phrase cannot derive — and
// never a key: no recovery phrase, no seed, no private key, no session key,
// no PIN. The file is encrypted under a key derived from the open wallet's
// recovery phrase, so the phrase alone opens it again, on this phone or on a
// fresh install after the phrase was restored. No service and no account:
// the file goes wherever the user shares it.
//
// WHAT IS IN IT. The stored documents of nine record kinds, each exactly as
// its own store wrote it (the same JSON text, byte for byte):
//   contacts, transaction notes, networks the user added, tracked tokens (one
//   document per network), guardian recovery records, multi-signature
//   account records, bridge transfers, price alerts and followed prices, and
//   spending limits.
// Every key is declared in the storage seam (store-keys.ts) with scope
// 'wallet' or 'device'; the module refuses at load time any kind whose key is
// a 'secret' one, so nothing from the secure store can ever be written into
// a backup. The keys are read through the seam with the ACTIVE storage
// profile, so a decoy wallet (duress PIN, wallet/duress.ts) backs up its own
// records and never reads the real wallet's (the networks the user added
// are a device setting, shared by both wallets by design).
//
// WHAT IS NOT IN IT, deliberately: session keys and imported private keys
// (secret material; a session key never leaves the phone, and an imported
// key is restored only from the copy the user kept), passkeys (held by the
// phone's passkey provider), the WalletConnect smart-account bindings and
// the browser connections (they describe connections that live in other
// storage and are not restored), pending transactions, spending history,
// recovery progress, inheritance and notification bookkeeping (transient
// state that would be wrong on another phone), account names and watched
// addresses (the account list is managed by WalletContext; a follow-up).
//
// THE FILE FORMAT (version 1). Bytes, then RFC 4648 base64 with padding
// (@scure/base `base64`, index.d.ts "base64 from RFC 4648. Padded."), as one
// line of text so the share sheet can carry it (RecordFileActions.tsx
// shareTextFile):
//
//   offset  bytes  field
//   0       4      magic "SWRB" (0x53 0x57 0x52 0x42)
//   4       1      format version, 0x01
//   5       32     HKDF salt (random per file)
//   37      12     AES-GCM nonce (random per file)
//   49      n+16   AES-256-GCM ciphertext of the payload, then its 16-byte tag
//
// The first 49 bytes (the header) are the GCM additional authenticated data,
// so a changed version, salt or nonce fails the tag like a changed
// ciphertext. The key is HKDF-SHA256(seed, salt, RECORDS_BACKUP_HKDF_INFO, 32)
// (storage.ts recordsBackupKeyFromSeed: the seed is the BIP-39 seed of the
// phrase with the empty passphrase). Because every file has a fresh random
// salt, every file has its own key, so a random 96-bit nonce is used once per
// key by construction. AES-256-GCM is @noble/ciphers 2.4.0 `gcm(key, nonce,
// AAD)` (aes.d.ts; README "AEADs (gcm, …) authenticate data: ciphertext
// includes a 16-byte tag, `decrypt` throws on tampering"). The check script
// pins the whole format against Node's own crypto (hkdfSync, aes-256-gcm),
// a second, independent implementation.
//
// THE PAYLOAD is UTF-8 JSON with exactly four keys: type (the string
// "shiba-wallet-records-backup"), version (the number 1), createdAt (ISO
// 8601) and documents (an object from each declared key to its stored text).
//
// RESTORING merges: a record absent on this phone is added through its own
// store's existing write function (which re-validates it exactly as when it
// was first saved; a network the user added is verified again through its
// RPC address); a record already here (same key) is never overwritten. Each
// stored document of the backup first goes through its store's own strict
// reader (run on an in-memory copy), so nothing that reader refuses is
// imported. A failure of a whole step (for example a store on this phone
// that cannot be read) stops the restore there; what earlier steps restored
// stays, and the report names the step.
//
// Loads under Node's type stripping (scripts/check-records-backup.mjs drives
// it with in-memory stores and a fake key deriver).

import { gcm } from '@noble/ciphers/aes.js';
// bytesToUtf8 uses TextDecoder (@noble/ciphers utils.js); Expo SDK 57
// installs TextDecoder in its winter runtime (expo/src/winter/runtime.native.ts
// line 15), and Node has it built in.
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils.js';
// randomBytes uses crypto.getRandomValues (@noble/hashes utils.js), which
// src/polyfills.ts installs from expo-crypto before anything else loads.
import { randomBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import {
  AsyncStorage,
  STORE_KEYS,
  readStoreItem,
  storeKeyScope,
  writeStoreItem,
  type KeyValueStore,
  type RemovableKeyValueStore,
} from './store-keys.ts';
import { RECORDS_BACKUP_SALT_BYTES } from './storage.ts';
import { addContact, exactMatchKey, loadContacts } from './contacts.ts';
import { NOTES_READ_ONLY_MESSAGE, loadNotes, saveNote } from './notes.ts';
import {
  CUSTOM_NETWORKS_READ_ONLY_MESSAGE,
  addCustomNetwork,
  ensureCustomNetworksLoaded,
  loadCustomNetworks,
  type CustomNetworkRecord,
  type VerifyOptions,
} from './custom-networks.ts';
import { MAINNET_TOKENS_KEY, addToken, isTokenChain, listTokens, tokenStoreKey } from './tokens.ts';
import { loadRecoveryRecords, saveRecoveryMetadata } from './recovery.ts';
import {
  MULTISIG_STORE_DAMAGED,
  exportMultisigAccount,
  importMultisigRecord,
  listMultisigRecords,
  multisigListEntries,
  parseMultisigAccountImport,
  renameMultisigRecord,
  type OwnAccount,
} from './multisig.ts';
import {
  BRIDGE_TRANSFERS_KEY,
  bridgeRecordFromStored,
  bridgeRecordToStored,
  bridgeTransfersReadOnly,
  bridgeTransfersWritten,
  listBridgeTransfers,
  loadBridgeTransfers,
  parseBridgeTransfers,
  pruneBridgeTransfers,
  type BridgeTransferRecord,
} from './bridge.ts';
import {
  PRICE_ALERTS_DAMAGED_MESSAGE,
  addAlert,
  addToWatchlist,
  parsePriceAlertBook,
  serializePriceAlertBook,
  updatePriceAlerts,
  type PriceAlertBook,
} from './price-alerts.ts';
import { listSpendingPolicies, listSpendingScopes, saveSpendingPolicy } from './spending-policy.ts';
import { EVM_MAINNET, allEvmProfiles } from '../config/evm-chain.ts';

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

/** "SWRB": the first four bytes of every records-backup file. */
export const RECORDS_BACKUP_MAGIC: Uint8Array = Uint8Array.of(0x53, 0x57, 0x52, 0x42);
/** The file format this version writes and reads. */
export const RECORDS_BACKUP_FORMAT_VERSION = 1;
/** AES-GCM nonce bytes (the size @noble/ciphers' gcm and NIST SP 800-38D recommend). */
export const RECORDS_BACKUP_NONCE_BYTES = 12;
/** AES-GCM tag bytes. */
export const RECORDS_BACKUP_TAG_BYTES = 16;
/** Magic + version + salt + nonce. */
export const RECORDS_BACKUP_HEADER_BYTES = 4 + 1 + RECORDS_BACKUP_SALT_BYTES + RECORDS_BACKUP_NONCE_BYTES;
/** The payload's "type". */
export const RECORDS_BACKUP_PAYLOAD_TYPE = 'shiba-wallet-records-backup';
/** Largest file accepted (base64 characters): a judgement, far above the stores' own caps. */
export const RECORDS_BACKUP_MAX_TEXT_LENGTH = 16 * 1024 * 1024;

/** Where shareTextFile writes the export (its own directory under the cache). */
export const RECORDS_BACKUP_DIRECTORY = 'records-backup-export';
/**
 * The file is base64 text: text/plain, and the system-declared plain-text
 * UTI (UniformTypeIdentifiers UTCoreTypes.h, "UTI: public.plain-text").
 */
export const RECORDS_BACKUP_MIME_TYPE = 'text/plain';
export const RECORDS_BACKUP_UTI = 'public.plain-text';

/** shiba-records-backup_2026-10-19.txt — the date only (UTC), no address or name. */
export function recordsBackupFileName(now: Date = new Date()): string {
  return `shiba-records-backup_${now.toISOString().slice(0, 10)}.txt`;
}

// ---------------------------------------------------------------------------
// Sentences (exact strings, pinned by scripts/check-records-backup.mjs)
// ---------------------------------------------------------------------------

export const RECORDS_BACKUP_SECTION_TITLE = 'Records backup';

export const RECORDS_BACKUP_WHAT_NOTE =
  'A records backup is one file with the records this wallet keeps on this phone: contacts, transaction notes, ' +
  'networks you added, tracked tokens, guardian recovery records, multi-signature account records, bridge ' +
  'transfers, price alerts and spending limits. It contains no private key, no recovery phrase and no PIN.';

export const RECORDS_BACKUP_KEY_NOTE =
  'The file is encrypted with a key made from this wallet’s recovery phrase, so only this recovery phrase can open ' +
  'it — on this phone, or on another phone after you restore the phrase there. If you lose the recovery phrase, ' +
  'this backup is lost with it.';

export const RECORDS_BACKUP_NOT_INCLUDED_NOTE =
  'Not in the backup and not restored by it: session keys (they never leave this phone; a payment, subscription ' +
  'or recurring swap must be revoked and set up again), imported private keys (only the copy of the key you kept ' +
  'yourself can restore such an account) and passkeys (the phone’s passkey provider holds them, not this wallet). ' +
  'Account names, watched addresses, connected apps, pending transactions and spending history are not included ' +
  'either.';

export const RECORDS_BACKUP_MERGE_NOTE =
  'Restoring adds only the records that are not on this phone yet. A record that is already here — the same ' +
  'contact address, note, network, token, account, transfer, alert or limit — is kept exactly as it is and never ' +
  'overwritten. Each record is checked as when it was first saved, and a network you added is checked again ' +
  'through its RPC address. A multi-signature account comes back without its operation history.';

export const RECORDS_BACKUP_FILE_NOTE =
  'The file is shared through the share sheet (for example to your cloud drive). The temporary copy on this phone ' +
  'is deleted a minute after the share sheet closes.';

export const RECORDS_BACKUP_EXPORT_BUTTON = 'Export records backup';
export const RECORDS_BACKUP_IMPORT_BUTTON = 'Restore from a records backup';
export const RECORDS_BACKUP_DIALOG_TITLE = 'Save the records backup';
export const RECORDS_BACKUP_SHARE_UNAVAILABLE =
  'Sharing files is not available on this device, so the records backup could not be saved.';

export const RECORDS_BACKUP_NOTHING_TO_EXPORT =
  'There are no records on this phone to back up yet, so no file was made.';

export const RECORDS_BACKUP_NOT_A_BACKUP =
  'This file is not a Shiba Wallet records backup, or it is incomplete. Nothing was restored.';

export const RECORDS_BACKUP_WRONG_PHRASE =
  'This backup was made by a different recovery phrase, or the file is damaged.';

export function recordsBackupNewerFormatMessage(version: number): string {
  return (
    `This records backup uses format ${version}, which this version of the wallet cannot read. Update the app and ` +
    'try again. Nothing was restored.'
  );
}

export const RECORDS_BACKUP_BAD_CONTENTS =
  'The backup opened, but its contents are not in the form this version of the wallet expects, so nothing was ' +
  'restored.';

export const RECORDS_BACKUP_CONFIRM_TITLE = 'Restore records from this backup?';

/** Why one record was not restored, when its own store gave no sentence. */
export const RECORD_REFUSED_REASON = 'it did not pass this wallet’s checks for that kind of record';
export const TOKEN_NETWORK_MISSING_REASON = 'the network it belongs to is not on this phone';
export const BRIDGE_CAP_REASON = 'the list keeps only the newest 64 transfers';

export const CONTACTS_STORE_UNREADABLE = 'The contacts on this phone could not be read, so none were added.';
export const RECOVERY_STORE_UNREADABLE = 'The recovery records on this phone could not be read, so none were added.';
export const BRIDGE_STORE_UNREADABLE =
  'The list of bridge transfers on this phone could not be read in full, so none were added.';
export const SPENDING_STORE_UNREADABLE = 'The spending limits on this phone could not be read, so none were added.';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RecordsBackupFailure = 'not-a-backup' | 'newer-format' | 'wrong-phrase' | 'bad-contents' | 'nothing';

/** A refusal of the whole file, with its plain sentence as the message. */
export class RecordsBackupError extends Error {
  reason: RecordsBackupFailure;
  // No TS parameter properties: Node's strip-only type stripping rejects them.
  constructor(reason: RecordsBackupFailure, message: string) {
    super(message);
    this.reason = reason;
    this.name = 'RecordsBackupError';
  }
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The 49-byte header: magic, version, salt, nonce. */
export function recordsBackupHeader(salt: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (salt.length !== RECORDS_BACKUP_SALT_BYTES) throw new Error(`The salt is ${RECORDS_BACKUP_SALT_BYTES} bytes.`);
  if (nonce.length !== RECORDS_BACKUP_NONCE_BYTES) throw new Error(`The nonce is ${RECORDS_BACKUP_NONCE_BYTES} bytes.`);
  return concatBytes(RECORDS_BACKUP_MAGIC, Uint8Array.of(RECORDS_BACKUP_FORMAT_VERSION), salt, nonce);
}

/**
 * Seals `plaintext` into the file's bytes (header ‖ AES-256-GCM ciphertext ‖
 * tag, the header as the additional authenticated data). Deterministic for
 * given inputs; the check script pins it against Node's crypto.
 */
export function sealRecordsBackup(plaintext: Uint8Array, key: Uint8Array, salt: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('The records-backup key is 32 bytes.');
  const header = recordsBackupHeader(salt, nonce);
  return concatBytes(header, gcm(key, nonce, header).encrypt(plaintext));
}

/** The parts of a file, checked for shape only (before any key is asked for). */
export interface RecordsBackupEnvelope {
  header: Uint8Array;
  salt: Uint8Array;
  nonce: Uint8Array;
  sealed: Uint8Array;
}

const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Reads the file's text: base64 (surrounding white space ignored), the
 * magic, the format version and the minimum length. Throws a
 * RecordsBackupError with a plain sentence; asks for no key, so a file that
 * is not a backup is refused without any prompt.
 */
export function parseRecordsBackupFile(text: string): RecordsBackupEnvelope {
  if (typeof text !== 'string' || text.length > RECORDS_BACKUP_MAX_TEXT_LENGTH) {
    throw new RecordsBackupError('not-a-backup', RECORDS_BACKUP_NOT_A_BACKUP);
  }
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0 || !BASE64_TEXT.test(trimmed)) {
    throw new RecordsBackupError('not-a-backup', RECORDS_BACKUP_NOT_A_BACKUP);
  }
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(trimmed);
  } catch {
    throw new RecordsBackupError('not-a-backup', RECORDS_BACKUP_NOT_A_BACKUP);
  }
  if (bytes.length < 5 || !RECORDS_BACKUP_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new RecordsBackupError('not-a-backup', RECORDS_BACKUP_NOT_A_BACKUP);
  }
  const version = bytes[4]!;
  if (version !== RECORDS_BACKUP_FORMAT_VERSION) {
    if (version > RECORDS_BACKUP_FORMAT_VERSION) {
      throw new RecordsBackupError('newer-format', recordsBackupNewerFormatMessage(version));
    }
    throw new RecordsBackupError('not-a-backup', RECORDS_BACKUP_NOT_A_BACKUP);
  }
  if (bytes.length < RECORDS_BACKUP_HEADER_BYTES + RECORDS_BACKUP_TAG_BYTES) {
    throw new RecordsBackupError('not-a-backup', RECORDS_BACKUP_NOT_A_BACKUP);
  }
  return {
    header: bytes.slice(0, RECORDS_BACKUP_HEADER_BYTES),
    salt: bytes.slice(5, 5 + RECORDS_BACKUP_SALT_BYTES),
    nonce: bytes.slice(5 + RECORDS_BACKUP_SALT_BYTES, RECORDS_BACKUP_HEADER_BYTES),
    sealed: bytes.slice(RECORDS_BACKUP_HEADER_BYTES),
  };
}

/** Decrypts an envelope; a failed tag (another phrase, or a changed file) → RECORDS_BACKUP_WRONG_PHRASE. */
export function openRecordsBackup(envelope: RecordsBackupEnvelope, key: Uint8Array): Uint8Array {
  try {
    return gcm(key, envelope.nonce, envelope.header).decrypt(envelope.sealed);
  } catch {
    throw new RecordsBackupError('wrong-phrase', RECORDS_BACKUP_WRONG_PHRASE);
  }
}

// ---------------------------------------------------------------------------
// The record kinds
// ---------------------------------------------------------------------------

export type RecordKind =
  | 'custom-networks'
  | 'contacts'
  | 'tokens'
  | 'notes'
  | 'recovery-records'
  | 'multisig'
  | 'bridge-transfers'
  | 'price-alerts'
  | 'spending-limits';

/** The order of restoring: networks first, so tokens and contacts on them can be checked. */
export const RECORD_KIND_ORDER: readonly RecordKind[] = [
  'custom-networks',
  'contacts',
  'tokens',
  'notes',
  'recovery-records',
  'multisig',
  'bridge-transfers',
  'price-alerts',
  'spending-limits',
];

export const RECORD_KIND_LABELS: Readonly<Record<RecordKind, string>> = Object.freeze({
  'custom-networks': 'Networks you added',
  contacts: 'Contacts',
  tokens: 'Tracked tokens',
  notes: 'Transaction notes',
  'recovery-records': 'Guardian recovery records',
  multisig: 'Multi-signature accounts',
  'bridge-transfers': 'Bridge transfers',
  'price-alerts': 'Price alerts and followed prices',
  'spending-limits': 'Spending limits',
});

/** The one declared key of each single-document kind (tokens has one per network). */
const SINGLE_KEYS: Readonly<Record<Exclude<RecordKind, 'tokens'>, string>> = Object.freeze({
  'custom-networks': STORE_KEYS.customNetworks.name,
  contacts: STORE_KEYS.contacts.name,
  notes: STORE_KEYS.txNotes.name,
  'recovery-records': STORE_KEYS.recoveryRecords.name,
  multisig: STORE_KEYS.multisig.name,
  'bridge-transfers': STORE_KEYS.bridgeTransfers.name,
  'price-alerts': STORE_KEYS.priceAlerts.name,
  'spending-limits': STORE_KEYS.spendingPolicies.name,
});

// Never a secret-scope key (the secure store): checked once, at load.
for (const key of [...Object.values(SINGLE_KEYS), STORE_KEYS.tokens.name, STORE_KEYS.tokensPerChain.name]) {
  if (storeKeyScope(key) === 'secret') throw new Error(`A records backup can never hold the secret key ${key}.`);
}

const EVM_CAIP2 = /^eip155:[1-9][0-9]{0,15}$/;

/** The network of a tracked-token key, or null when the key is not one. */
export function tokenKeyChain(key: string): string | null {
  if (key === MAINNET_TOKENS_KEY) return EVM_MAINNET.caip2;
  const prefix = STORE_KEYS.tokensPerChain.name;
  if (!key.startsWith(prefix)) return null;
  const chain = key.slice(prefix.length);
  if (!EVM_CAIP2.test(chain) || chain === EVM_MAINNET.caip2 || tokenStoreKey(chain) !== key) return null;
  return chain;
}

/** Which kind a payload key belongs to, or null (the file is then refused). */
export function recordKindOfKey(key: string): RecordKind | null {
  for (const kind of Object.keys(SINGLE_KEYS) as Exclude<RecordKind, 'tokens'>[]) {
    if (SINGLE_KEYS[kind] === key) return kind;
  }
  return tokenKeyChain(key) !== null ? 'tokens' : null;
}

// ---------------------------------------------------------------------------
// In-memory copies (the stores' own readers run on them)
// ---------------------------------------------------------------------------

/** A store held in memory only (never the phone's storage). */
export function memoryRecordStore(): KeyValueStore {
  const items = new Map<string, string>();
  return {
    getItem: (k) => Promise.resolve(items.has(k) ? (items.get(k) as string) : null),
    setItem: (k, v) => {
      items.set(k, v);
      return Promise.resolve();
    },
  };
}

/** An in-memory store holding one document under its key (through the seam, so the reader finds it). */
async function scratchWith(key: string, text: string): Promise<KeyValueStore> {
  const scratch = memoryRecordStore();
  await writeStoreItem(scratch, key, text);
  return scratch;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What a store's own reader made of one stored document. */
interface Inspection<T> {
  /** The records the reader accepted. */
  records: T[];
  /** Entries in the document the reader did not accept. */
  dropped: number;
}

// --- contacts ---------------------------------------------------------------

interface BackupContact {
  networkId: string;
  name: string;
  address: string;
  createdAt: string;
}

async function inspectContacts(text: string): Promise<Inspection<BackupContact> | null> {
  const doc = parseJson(text);
  if (!isPlainObject(doc) || !isPlainObject(doc.networks)) return null;
  const scratch = await scratchWith(SINGLE_KEYS.contacts, text);
  const records: BackupContact[] = [];
  let entries = 0;
  for (const [networkId, list] of Object.entries(doc.networks)) {
    entries += Array.isArray(list) ? list.length : 1;
    const loaded = await loadContacts(networkId, scratch);
    if (loaded.unreadable) return null;
    records.push(...loaded.contacts);
  }
  return { records, dropped: entries - records.length };
}

// --- notes ------------------------------------------------------------------

interface BackupNote {
  network: string;
  txid: string | null;
  userOpHash: string | null;
  text: string;
  updatedAt: string;
}

async function inspectNotes(text: string): Promise<Inspection<BackupNote> | null> {
  const doc = parseJson(text);
  if (!isPlainObject(doc) || !isPlainObject(doc.networks)) return null;
  let entries = 0;
  for (const records of Object.values(doc.networks)) entries += isPlainObject(records) ? Object.keys(records).length : 1;
  const book = await loadNotes(await scratchWith(SINGLE_KEYS.notes, text));
  // Read-only with nothing accepted: the document itself was refused (an
  // empty, well-formed document reads as not read-only).
  if (book.readOnly && book.notes.length === 0) return null;
  return { records: book.notes, dropped: Math.max(0, entries - book.notes.length) };
}

// --- custom networks --------------------------------------------------------

async function inspectCustomNetworks(text: string): Promise<Inspection<CustomNetworkRecord> | null> {
  const doc = parseJson(text);
  if (!isPlainObject(doc) || !Array.isArray(doc.networks)) return null;
  const book = await loadCustomNetworks(await scratchWith(SINGLE_KEYS['custom-networks'], text));
  if (book.readOnly && book.networks.length === 0) return null;
  return { records: book.networks, dropped: Math.max(0, doc.networks.length - book.networks.length) };
}

// --- tokens -----------------------------------------------------------------

interface BackupToken {
  chain: string;
  asset: Awaited<ReturnType<typeof listTokens>>[number];
}

async function inspectTokens(key: string, text: string): Promise<(Inspection<BackupToken> & { chainKnown: boolean }) | null> {
  const chain = tokenKeyChain(key);
  const doc = parseJson(text);
  if (chain === null || !Array.isArray(doc)) return null;
  if (!isTokenChain(chain)) return { records: [], dropped: doc.length, chainKnown: false };
  const assets = await listTokens(chain, await scratchWith(key, text));
  return {
    records: assets.map((asset) => ({ chain, asset })),
    dropped: Math.max(0, doc.length - assets.length),
    chainKnown: true,
  };
}

// --- recovery records -------------------------------------------------------

async function inspectRecoveryRecords(text: string): Promise<Inspection<Awaited<ReturnType<typeof loadRecoveryRecords>>['entries'][number]> | null> {
  const doc = parseJson(text);
  if (!isPlainObject(doc) || !isPlainObject(doc.entries)) return null;
  const loaded = await loadRecoveryRecords(await scratchWith(SINGLE_KEYS['recovery-records'], text));
  if (loaded.unreadable) return null;
  return { records: loaded.entries, dropped: Math.max(0, Object.keys(doc.entries).length - loaded.entries.length) };
}

// --- multisig ---------------------------------------------------------------

async function inspectMultisig(text: string): Promise<Inspection<Awaited<ReturnType<typeof listMultisigRecords>>[number]> | null> {
  const doc = parseJson(text);
  if (!isPlainObject(doc) || !Array.isArray(doc.records)) return null;
  const scratch = await scratchWith(SINGLE_KEYS.multisig, text);
  if ((await multisigListEntries(scratch)) === null) return null;
  const records = await listMultisigRecords(undefined, scratch);
  return { records, dropped: Math.max(0, doc.records.length - records.length) };
}

// --- bridge transfers -------------------------------------------------------

async function inspectBridgeTransfers(text: string): Promise<(Inspection<BridgeTransferRecord> & { version: number }) | null> {
  const doc = parseJson(text);
  if (!isPlainObject(doc) || !Array.isArray(doc.records) || typeof doc.version !== 'number') return null;
  const parsed = parseBridgeTransfers(text);
  if (parsed.readOnly && parsed.records.length === 0) return null;
  return { records: parsed.records, dropped: Math.max(0, doc.records.length - parsed.records.length), version: doc.version };
}

// --- price alerts -----------------------------------------------------------

async function inspectPriceAlerts(text: string): Promise<{ book: PriceAlertBook; count: number } | null> {
  // The reader is all-or-nothing (parsePriceAlertBook returns null for any
  // flaw), so there are no partially accepted documents.
  const book = parsePriceAlertBook(text);
  return book ? { book, count: book.watchlist.length + book.alerts.length } : null;
}

// --- spending limits --------------------------------------------------------

type ScopedPolicy = {
  scope: Awaited<ReturnType<typeof listSpendingScopes>>['scopes'][number]['scope'];
  policy: Awaited<ReturnType<typeof listSpendingPolicies>>['policies'][number];
};

async function inspectSpendingLimits(text: string): Promise<Inspection<ScopedPolicy> | null> {
  // All-or-nothing too: one malformed entry marks the whole document damaged.
  const scratch = await scratchWith(SINGLE_KEYS['spending-limits'], text);
  const scopes = await listSpendingScopes(scratch);
  if (scopes.damaged) return null;
  const records: ScopedPolicy[] = [];
  for (const { scope } of scopes.scopes) {
    for (const policy of (await listSpendingPolicies(scope, scratch)).policies) records.push({ scope, policy });
  }
  return { records, dropped: 0 };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** What one kind contributed to an export. */
export interface RecordsExportKindSummary {
  kind: RecordKind;
  label: string;
  /** Records the store's own reader accepted (what a restore can bring back). */
  records: number;
  /** Stored documents of this kind that could not be read at all and were left out. */
  unreadableDocuments: number;
}

export interface RecordsBackupCollection {
  documents: Record<string, string>;
  summary: RecordsExportKindSummary[];
  total: number;
}

/** The stored text of a key, or null (absent or unreadable storage). */
async function readDocument(store: KeyValueStore, key: string): Promise<string | null> {
  try {
    return await readStoreItem(store, key);
  } catch {
    return null;
  }
}

async function inspectAny(kind: RecordKind, key: string, text: string): Promise<number | null> {
  switch (kind) {
    case 'contacts':
      return (await inspectContacts(text))?.records.length ?? null;
    case 'notes':
      return (await inspectNotes(text))?.records.length ?? null;
    case 'custom-networks':
      return (await inspectCustomNetworks(text))?.records.length ?? null;
    case 'tokens':
      return (await inspectTokens(key, text))?.records.length ?? null;
    case 'recovery-records':
      return (await inspectRecoveryRecords(text))?.records.length ?? null;
    case 'multisig':
      return (await inspectMultisig(text))?.records.length ?? null;
    case 'bridge-transfers':
      return (await inspectBridgeTransfers(text))?.records.length ?? null;
    case 'price-alerts':
      return (await inspectPriceAlerts(text))?.count ?? null;
    case 'spending-limits':
      return (await inspectSpendingLimits(text))?.records.length ?? null;
  }
}

/**
 * Reads every record document of the open wallet through the storage seam
 * (the ACTIVE profile's keys; the networks the user added are device-wide)
 * and checks each with its store's own reader. A document the reader cannot
 * read at all is left out and counted; nothing else is changed or written.
 */
export async function collectRecordsBackup(store: KeyValueStore = AsyncStorage): Promise<RecordsBackupCollection> {
  await ensureCustomNetworksLoaded(store);
  const tokenKeys = [...new Set(allEvmProfiles().map((p) => tokenStoreKey(p.caip2)))];
  const documents: Record<string, string> = {};
  const summary: RecordsExportKindSummary[] = [];
  let total = 0;
  for (const kind of RECORD_KIND_ORDER) {
    const keys = kind === 'tokens' ? tokenKeys : [SINGLE_KEYS[kind]];
    const entry: RecordsExportKindSummary = { kind, label: RECORD_KIND_LABELS[kind], records: 0, unreadableDocuments: 0 };
    for (const key of keys) {
      const text = await readDocument(store, key);
      if (text === null) continue;
      const count = await inspectAny(kind, key, text);
      if (count === null) {
        entry.unreadableDocuments += 1;
        continue;
      }
      documents[key] = text;
      entry.records += count;
    }
    total += entry.records;
    summary.push(entry);
  }
  return { documents, summary, total };
}

/** The payload JSON for a collection (exactly the four keys). */
export function recordsBackupPayload(documents: Record<string, string>, createdAt: Date): string {
  return JSON.stringify({
    type: RECORDS_BACKUP_PAYLOAD_TYPE,
    version: RECORDS_BACKUP_FORMAT_VERSION,
    createdAt: createdAt.toISOString(),
    documents,
  });
}

/** Derives the file's key from its salt (WalletContext.deriveRecordsBackupKey: one device prompt). */
export type RecordsBackupKeyDeriver = (salt: Uint8Array) => Promise<Uint8Array>;

export interface RecordsBackupExport {
  /** The file's text (one line of base64). */
  text: string;
  fileName: string;
  summary: RecordsExportKindSummary[];
  total: number;
}

/**
 * Collects the records (no prompt), refuses an empty collection, then asks
 * for the key once (one device prompt) and seals the file. The key is zeroed
 * afterwards.
 */
export async function exportRecordsBackup(options: {
  deriveKey: RecordsBackupKeyDeriver;
  store?: KeyValueStore;
  now?: () => Date;
  random?: (bytes: number) => Uint8Array;
}): Promise<RecordsBackupExport> {
  const store = options.store ?? AsyncStorage;
  const now = (options.now ?? (() => new Date()))();
  const random = options.random ?? ((n: number) => randomBytes(n));
  const collected = await collectRecordsBackup(store);
  if (Object.keys(collected.documents).length === 0) {
    throw new RecordsBackupError('nothing', RECORDS_BACKUP_NOTHING_TO_EXPORT);
  }
  const salt = random(RECORDS_BACKUP_SALT_BYTES);
  const nonce = random(RECORDS_BACKUP_NONCE_BYTES);
  const key = await options.deriveKey(salt);
  try {
    const sealed = sealRecordsBackup(utf8ToBytes(recordsBackupPayload(collected.documents, now)), key, salt, nonce);
    return { text: base64.encode(sealed), fileName: recordsBackupFileName(now), summary: collected.summary, total: collected.total };
  } finally {
    key.fill(0);
  }
}

/**
 * The line shown after Export: how many records the file holds, per kind
 * (kinds with records only), and that it was handed to the share sheet.
 *
 * Pass p22b: it used to say "Backed up N records" although the share sheet
 * had been cancelled and the file went nowhere. expo-sharing's shareAsync
 * resolves the same way whatever the user does in the sheet: on Android
 * SharingModule.kt resolves null in OnActivityResult for its request code
 * without reading the result code (expo-sharing 57.0.22, lines 80–84), and
 * on iOS the activity controller's completionWithItemsHandler resolves nil
 * for every outcome (SharingModule.swift lines 24–31). So the wallet cannot
 * know whether a backup was saved, and says so.
 */
export function describeRecordsExport(result: Pick<RecordsBackupExport, 'summary' | 'total'>): string {
  const parts = result.summary.filter((s) => s.records > 0).map((s) => `${s.label}: ${s.records}`);
  const left = result.summary.filter((s) => s.unreadableDocuments > 0).map((s) => s.label);
  const head =
    `A backup of ${result.total} ${result.total === 1 ? 'record' : 'records'} was prepared and handed to the share sheet` +
    (parts.length > 0 ? ` (${parts.join('; ')}).` : '.') +
    ' Whether it was saved depends on what you chose there; this wallet cannot tell.';
  return left.length === 0
    ? head
    : `${head} Left out because they could not be read on this phone: ${left.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** The decrypted payload, checked for its exact shape. */
export interface RecordsBackupPayload {
  createdAt: string;
  documents: Record<string, string>;
}

/** Parses the decrypted JSON strictly: exactly four keys, a known type and version, declared keys only. */
export function parseRecordsBackupPayload(text: string): RecordsBackupPayload {
  const bad = () => new RecordsBackupError('bad-contents', RECORDS_BACKUP_BAD_CONTENTS);
  const doc = parseJson(text);
  if (!isPlainObject(doc)) throw bad();
  const keys = Object.keys(doc).sort();
  if (keys.join(',') !== 'createdAt,documents,type,version') throw bad();
  if (doc.type !== RECORDS_BACKUP_PAYLOAD_TYPE || doc.version !== RECORDS_BACKUP_FORMAT_VERSION) throw bad();
  if (typeof doc.createdAt !== 'string' || Number.isNaN(Date.parse(doc.createdAt))) throw bad();
  if (!isPlainObject(doc.documents)) throw bad();
  const documents: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc.documents)) {
    if (recordKindOfKey(key) === null || typeof value !== 'string') throw bad();
    documents[key] = value;
  }
  return { createdAt: doc.createdAt, documents };
}

/** What a restore did for one kind. */
export interface RecordsImportKindReport {
  kind: RecordKind;
  label: string;
  /** Records in the backup (accepted by the store's reader, plus those it refused). */
  inBackup: number;
  added: number;
  alreadyHere: number;
  notRestored: number;
  /** Plain reasons for records not restored (distinct, at most three). */
  reasons: string[];
  /** Set when the whole step failed: the restore stopped here. */
  failure: string | null;
}

export interface RecordsImportReport {
  createdAt: string;
  kinds: RecordsImportKindReport[];
  /** The kind whose step failed (the restore stopped there), or null. */
  stoppedAt: RecordKind | null;
}

/** What a restore needs from the screen. */
export interface RecordsImportContext {
  store?: KeyValueStore & RemovableKeyValueStore;
  /** This wallet's accounts (public data): a multisig is restored only with one of its phrase signers. */
  ownAccounts: readonly OwnAccount[];
  /** Options for re-verifying a network the user added (fetch, clock, timeout). */
  verifyNetwork?: VerifyOptions;
}

class StepFailure extends Error {}

function messageOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function newReport(kind: RecordKind): RecordsImportKindReport {
  return { kind, label: RECORD_KIND_LABELS[kind], inBackup: 0, added: 0, alreadyHere: 0, notRestored: 0, reasons: [], failure: null };
}

function refuse(report: RecordsImportKindReport, reason: string, count = 1): void {
  if (count <= 0) return;
  report.notRestored += count;
  if (!report.reasons.includes(reason) && report.reasons.length < 3) report.reasons.push(reason);
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function dateOr(iso: string, fallback: Date): Date {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? fallback : new Date(t);
}

async function restoreContacts(text: string, store: KeyValueStore, report: RecordsImportKindReport): Promise<void> {
  const seen = await inspectContacts(text);
  if (!seen) throw new StepFailure(RECORDS_BACKUP_BAD_CONTENTS);
  report.inBackup = seen.records.length + seen.dropped;
  refuse(report, RECORD_REFUSED_REASON, seen.dropped);
  const networks = [...new Set(seen.records.map((c) => c.networkId))];
  for (const networkId of networks) {
    if ((await loadContacts(networkId, store)).unreadable) throw new StepFailure(CONTACTS_STORE_UNREADABLE);
  }
  for (const c of seen.records) {
    const live = (await loadContacts(c.networkId, store)).contacts;
    const key = exactMatchKey(c.networkId, c.address);
    if (key !== null && live.some((l) => exactMatchKey(c.networkId, l.address) === key)) {
      report.alreadyHere += 1;
      continue;
    }
    try {
      await addContact(c.networkId, c.name, c.address, { store, now: () => dateOr(c.createdAt, new Date()) });
      report.added += 1;
    } catch (e) {
      refuse(report, messageOf(e));
    }
  }
}

async function restoreNotes(text: string, store: KeyValueStore, report: RecordsImportKindReport): Promise<void> {
  const seen = await inspectNotes(text);
  if (!seen) throw new StepFailure(RECORDS_BACKUP_BAD_CONTENTS);
  report.inBackup = seen.records.length + seen.dropped;
  refuse(report, RECORD_REFUSED_REASON, seen.dropped);
  const live = await loadNotes(store);
  if (live.readOnly) throw new StepFailure(NOTES_READ_ONLY_MESSAGE);
  const here = [...live.notes];
  for (const n of seen.records) {
    // The same transaction (by id) or the same UserOperation: never overwritten.
    const present = here.some(
      (l) => l.network === n.network && ((n.txid !== null && l.txid === n.txid) || (n.userOpHash !== null && l.userOpHash === n.userOpHash)),
    );
    if (present) {
      report.alreadyHere += 1;
      continue;
    }
    try {
      const saved = await saveNote(n.network, { txid: n.txid, userOpHash: n.userOpHash }, n.text, {
        store,
        now: () => dateOr(n.updatedAt, new Date()),
      });
      if (saved) here.push(saved);
      report.added += 1;
    } catch (e) {
      refuse(report, messageOf(e));
    }
  }
}

async function restoreCustomNetworks(
  text: string,
  store: KeyValueStore,
  verify: VerifyOptions | undefined,
  report: RecordsImportKindReport,
): Promise<void> {
  const seen = await inspectCustomNetworks(text);
  if (!seen) throw new StepFailure(RECORDS_BACKUP_BAD_CONTENTS);
  report.inBackup = seen.records.length + seen.dropped;
  refuse(report, RECORD_REFUSED_REASON, seen.dropped);
  await ensureCustomNetworksLoaded(store);
  if ((await loadCustomNetworks(store)).readOnly) throw new StepFailure(CUSTOM_NETWORKS_READ_ONLY_MESSAGE);
  for (const r of seen.records) {
    const live = (await loadCustomNetworks(store)).networks;
    if (live.some((l) => l.chainId === r.chainId)) {
      report.alreadyHere += 1;
      continue;
    }
    try {
      await addCustomNetwork(
        {
          name: r.name,
          chainId: r.chainId,
          rpcUrl: r.rpcUrl,
          nativeSymbol: r.nativeSymbol,
          nativeDecimals: String(r.nativeDecimals),
          explorerUrl: r.explorerUrl ?? '',
          testnet: r.testnet,
        },
        { ...(verify ?? {}), store, clock: () => dateOr(r.addedAt, new Date()) },
      );
      report.added += 1;
    } catch (e) {
      refuse(report, messageOf(e));
    }
  }
}

async function restoreTokens(key: string, text: string, store: KeyValueStore, report: RecordsImportKindReport): Promise<void> {
  const seen = await inspectTokens(key, text);
  if (!seen) throw new StepFailure(RECORDS_BACKUP_BAD_CONTENTS);
  report.inBackup += seen.records.length + seen.dropped;
  refuse(report, seen.chainKnown ? RECORD_REFUSED_REASON : TOKEN_NETWORK_MISSING_REASON, seen.dropped);
  for (const t of seen.records) {
    const live = await listTokens(t.chain, store);
    if (live.some((l) => l.assetId.chainId === t.asset.assetId.chainId && sameText(l.assetId.reference, t.asset.assetId.reference))) {
      report.alreadyHere += 1;
      continue;
    }
    try {
      await addToken(t.asset, store);
      report.added += 1;
    } catch (e) {
      refuse(report, messageOf(e));
    }
  }
}

async function restoreRecoveryRecords(text: string, store: KeyValueStore, report: RecordsImportKindReport): Promise<void> {
  const seen = await inspectRecoveryRecords(text);
  if (!seen) throw new StepFailure(RECORDS_BACKUP_BAD_CONTENTS);
  report.inBackup = seen.records.length + seen.dropped;
  refuse(report, RECORD_REFUSED_REASON, seen.dropped);
  if ((await loadRecoveryRecords(store)).unreadable) throw new StepFailure(RECOVERY_STORE_UNREADABLE);
  for (const entry of seen.records) {
    const live = (await loadRecoveryRecords(store)).entries;
    if (live.some((l) => l.metadata.chainId === entry.metadata.chainId && sameText(l.metadata.account, entry.metadata.account))) {
      report.alreadyHere += 1;
      continue;
    }
    try {
      await saveRecoveryMetadata(entry.metadata, store, { now: entry.updatedAt });
      report.added += 1;
    } catch (e) {
      refuse(report, messageOf(e));
    }
  }
}

async function restoreMultisig(
  text: string,
  store: KeyValueStore,
  ownAccounts: readonly OwnAccount[],
  report: RecordsImportKindReport,
): Promise<void> {
  const seen = await inspectMultisig(text);
  if (!seen) throw new StepFailure(RECORDS_BACKUP_BAD_CONTENTS);
  report.inBackup = seen.records.length + seen.dropped;
  refuse(report, RECORD_REFUSED_REASON, seen.dropped);
  if ((await multisigListEntries(store)) === null) throw new StepFailure(MULTISIG_STORE_DAMAGED);
  for (const record of seen.records) {
    const live = await listMultisigRecords(undefined, store);
    if (live.some((l) => l.chain === record.chain && sameText(l.address, record.address))) {
      report.alreadyHere += 1;
      continue;
    }
    try {
      // The same path as "Add a multisig from a record": the account facts
      // are re-derived and checked (CREATE2 address, pinned deployment,
      // signer set), and one of this wallet's phrase accounts must sign.
      const parsed = parseMultisigAccountImport(exportMultisigAccount(record).json);
      const added = await importMultisigRecord(parsed, ownAccounts, store, record.createdAt);
      report.added += 1;
      if (added.name !== record.name) {
        try {
          await renameMultisigRecord(added.id, record.name, store);
        } catch {
          // The record stays under its default name.
        }
      }
    } catch (e) {
      refuse(report, messageOf(e));
    }
  }
}

function storableBridgeRecord(r: BridgeTransferRecord): boolean {
  return bridgeRecordFromStored(bridgeRecordToStored(r)) !== null;
}

async function restoreBridgeTransfers(text: string, store: KeyValueStore, report: RecordsImportKindReport): Promise<void> {
  const seen = await inspectBridgeTransfers(text);
  if (!seen) throw new StepFailure(RECORDS_BACKUP_BAD_CONTENTS);
  report.inBackup = seen.records.length + seen.dropped;
  refuse(report, RECORD_REFUSED_REASON, seen.dropped);
  await loadBridgeTransfers(store);
  if (bridgeTransfersReadOnly()) throw new StepFailure(BRIDGE_STORE_UNREADABLE);
  const live = listBridgeTransfers();
  const absent: BridgeTransferRecord[] = [];
  for (const r of seen.records) {
    const present = live.some(
      (l) =>
        l.id === r.id ||
        (r.sourceTxHash !== null && sameText(l.sourceTxHash, r.sourceTxHash)) ||
        (r.userOpHash !== null && sameText(l.userOpHash, r.userOpHash)),
    );
    if (present || absent.some((a) => a.id === r.id)) report.alreadyHere += 1;
    else absent.push(r);
  }
  if (absent.length === 0) return;
  const merged = pruneBridgeTransfers([...live, ...absent]).filter(storableBridgeRecord);
  const kept = new Set(merged.map((r) => r.id));
  const doc = JSON.stringify({ version: seen.version, records: merged.map(bridgeRecordToStored) });
  // Written only when the store's own reader accepts the whole new list.
  const check = parseBridgeTransfers(doc);
  if (check.readOnly || check.records.length !== merged.length) throw new StepFailure(BRIDGE_STORE_UNREADABLE);
  await bridgeTransfersWritten();
  await writeStoreItem(store, BRIDGE_TRANSFERS_KEY, doc);
  await loadBridgeTransfers(store);
  for (const r of absent) {
    if (kept.has(r.id)) report.added += 1;
    else refuse(report, BRIDGE_CAP_REASON);
  }
}

async function restorePriceAlerts(text: string, store: KeyValueStore, report: RecordsImportKindReport): Promise<void> {
  const seen = await inspectPriceAlerts(text);
  if (!seen) throw new StepFailure(RECORDS_BACKUP_BAD_CONTENTS);
  report.inBackup = seen.count;
  const incoming = seen.book;
  let tally = { added: 0, alreadyHere: 0, refused: [] as string[] };
  try {
    tally = await updatePriceAlerts((book) => {
      let next = book;
      const out = { added: 0, alreadyHere: 0, refused: [] as string[] };
      for (const assetId of incoming.watchlist) {
        if (next.watchlist.includes(assetId)) {
          out.alreadyHere += 1;
          continue;
        }
        try {
          next = addToWatchlist(next, assetId);
          out.added += 1;
        } catch (e) {
          out.refused.push(messageOf(e));
        }
      }
      for (const alert of incoming.alerts) {
        if (next.alerts.some((a) => a.assetId === alert.assetId && a.direction === alert.direction && a.threshold === alert.threshold)) {
          out.alreadyHere += 1;
          continue;
        }
        try {
          const created = addAlert(next, {
            assetId: alert.assetId,
            direction: alert.direction,
            threshold: alert.threshold,
            quote: null,
            nowMs: alert.createdAt,
          });
          // Keep the alert's state as it was (tripped stays tripped, so a
          // restored alert does not fire again for a crossing already seen).
          const restored = {
            ...created.result.alert,
            state: alert.state,
            ...(alert.firedAt !== undefined ? { firedAt: alert.firedAt, firedPrice: alert.firedPrice } : {}),
          };
          const candidate: PriceAlertBook = {
            ...created.book,
            alerts: created.book.alerts.map((a) => (a.id === restored.id ? restored : a)),
          };
          if (parsePriceAlertBook(serializePriceAlertBook(candidate)) === null) {
            out.refused.push(RECORD_REFUSED_REASON);
            continue;
          }
          next = candidate;
          out.added += 1;
        } catch (e) {
          out.refused.push(messageOf(e));
        }
      }
      return { book: next, result: out };
    }, store);
  } catch (e) {
    throw new StepFailure(e instanceof Error && e.message === PRICE_ALERTS_DAMAGED_MESSAGE ? PRICE_ALERTS_DAMAGED_MESSAGE : messageOf(e));
  }
  report.added += tally.added;
  report.alreadyHere += tally.alreadyHere;
  for (const reason of tally.refused) refuse(report, reason);
}

async function restoreSpendingLimits(text: string, store: KeyValueStore, report: RecordsImportKindReport): Promise<void> {
  const seen = await inspectSpendingLimits(text);
  if (!seen) throw new StepFailure(RECORDS_BACKUP_BAD_CONTENTS);
  report.inBackup = seen.records.length;
  if ((await listSpendingScopes(store)).damaged) throw new StepFailure(SPENDING_STORE_UNREADABLE);
  for (const { scope, policy } of seen.records) {
    const live = await listSpendingPolicies(scope, store);
    if (live.damaged) throw new StepFailure(SPENDING_STORE_UNREADABLE);
    if (live.policies.some((l) => sameText(l.token, policy.token) && l.windowSeconds === policy.windowSeconds)) {
      report.alreadyHere += 1;
      continue;
    }
    try {
      // A restored limit only ever adds a limit; its token is the one it
      // names (it was offered when the limit was first saved).
      await saveSpendingPolicy(
        scope,
        {
          token: policy.token,
          symbol: policy.symbol,
          decimals: policy.decimals,
          cap: policy.cap,
          windowSeconds: policy.windowSeconds,
          allowOverride: policy.allowOverride,
          countFees: policy.countFees,
        },
        [policy.token],
        { store, now: policy.createdAt },
      );
      report.added += 1;
    } catch (e) {
      refuse(report, messageOf(e));
    }
  }
}

/**
 * Restores a records backup into the open wallet:
 *
 *  1. the file is read for its shape (no prompt; a file that is not a
 *     backup is refused at once);
 *  2. the key is derived from the file's salt (one device prompt;
 *     deriveKey refuses unless the active account is a phrase account);
 *  3. the payload is decrypted (a failed tag: another phrase or a changed
 *     file) and parsed strictly;
 *  4. each kind is merged in RECORD_KIND_ORDER through its store's own
 *     functions (see the header comment). A step that fails stops the
 *     restore; earlier steps' records stay.
 */
export async function importRecordsBackup(options: {
  text: string;
  deriveKey: RecordsBackupKeyDeriver;
  context: RecordsImportContext;
}): Promise<RecordsImportReport> {
  const envelope = parseRecordsBackupFile(options.text);
  const key = await options.deriveKey(envelope.salt);
  let plaintext: Uint8Array;
  try {
    plaintext = openRecordsBackup(envelope, key);
  } finally {
    key.fill(0);
  }
  let json: string;
  try {
    json = bytesToUtf8(plaintext);
  } catch {
    throw new RecordsBackupError('bad-contents', RECORDS_BACKUP_BAD_CONTENTS);
  } finally {
    plaintext.fill(0);
  }
  const payload = parseRecordsBackupPayload(json);
  const store = options.context.store ?? AsyncStorage;
  const result: RecordsImportReport = { createdAt: payload.createdAt, kinds: [], stoppedAt: null };
  const entries = Object.entries(payload.documents);
  for (const kind of RECORD_KIND_ORDER) {
    const docs = entries.filter(([k]) => recordKindOfKey(k) === kind);
    if (docs.length === 0) continue;
    const report = newReport(kind);
    result.kinds.push(report);
    try {
      for (const [key2, text] of docs) {
        switch (kind) {
          case 'custom-networks':
            await restoreCustomNetworks(text, store, options.context.verifyNetwork, report);
            break;
          case 'contacts':
            await restoreContacts(text, store, report);
            break;
          case 'tokens':
            await restoreTokens(key2, text, store, report);
            break;
          case 'notes':
            await restoreNotes(text, store, report);
            break;
          case 'recovery-records':
            await restoreRecoveryRecords(text, store, report);
            break;
          case 'multisig':
            await restoreMultisig(text, store, options.context.ownAccounts, report);
            break;
          case 'bridge-transfers':
            await restoreBridgeTransfers(text, store, report);
            break;
          case 'price-alerts':
            await restorePriceAlerts(text, store, report);
            break;
          case 'spending-limits':
            await restoreSpendingLimits(text, store, report);
            break;
        }
      }
    } catch (e) {
      report.failure = messageOf(e);
      result.stoppedAt = kind;
      break;
    }
  }
  return result;
}

/** The restore's report as plain sentences, one per kind (and the stop, if any). */
export function describeRecordsImport(report: RecordsImportReport): string[] {
  const lines: string[] = [];
  for (const k of report.kinds) {
    const parts = [`${k.added} added`, `${k.alreadyHere} already on this phone`];
    if (k.notRestored > 0) parts.push(`${k.notRestored} not restored (${k.reasons.join('; ')})`);
    lines.push(`${k.label}: ${parts.join(', ')}.`);
    if (k.failure !== null) {
      lines.push(`Restoring stopped at ${k.label.toLowerCase()}: ${k.failure} The records restored before this step stay on this phone.`);
    }
  }
  if (lines.length === 0) lines.push('The backup held no records, so nothing was restored.');
  return lines;
}

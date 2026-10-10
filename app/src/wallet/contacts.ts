import AsyncStorage from '@react-native-async-storage/async-storage';
import { BITCOIN, DOGECOIN, addressToScriptPubKey } from '@shiba-wallet/chains-utxo';
// Explicit .ts extensions: this module is imported by scripts/check-contacts.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import type { KeyValueStore } from './tokens.ts';
import { sanitizeDisplayName, type NameValidation } from './names.ts';
import {
  BITCOIN_CHAIN_ID,
  DOGECOIN_CHAIN_ID,
  EVM_CHAIN_ID,
  SOLANA_CHAIN_ID,
  validateRecipient,
} from './send.ts';
import { EVM_TEST_PROFILES, isCustomNetworkId } from '../config/evm-chain.ts';

/**
 * Contacts (Tier 1 feature 73): per-chain named addresses.
 *
 * STORAGE. AsyncStorage under a versioned key, one array of contacts per
 * CAIP-2 network id. The key is the ACTIVE network's id, exactly like the
 * other per-chain stores (config/networks.ts overrides, wallet/indexer.ts,
 * wallet/aa.ts): with Sepolia test mode on, the EVM slot resolves to
 * "eip155:11155111", so Sepolia contacts and mainnet contacts live under
 * different keys and a contact saved in one mode never appears in the
 * other. Contacts are public configuration, not key material, so they stay
 * out of expo-secure-store (wallet/storage.ts remains the only module that
 * touches it). Every function takes an injectable KeyValueStore so
 * scripts/check-contacts.mjs exercises the exact store code under Node.
 *
 * VALIDATION. Every address that is saved goes through validateRecipient
 * in ./send.ts — the same engine-backed path the send screen uses — and
 * only its normalized form is stored (EVM: EIP-55 checksummed; bech32:
 * lowercase, the BIP-173 canonical encoding). Invalid addresses never
 * persist. Stored entries are re-validated on every load, so a tampered or
 * otherwise invalid entry is never displayed as a contact.
 *
 * ANTI-POISONING RULES (address-poisoning attacks send dust from a vanity
 * address that shares the first and last characters of an address the
 * victim uses, hoping the victim copies it from their history):
 *  - Labeling a recipient with a contact name is EXACT-MATCH ONLY:
 *    EVM addresses compare case-insensitively on the full 20 bytes;
 *    Bitcoin/Dogecoin compare the decoded output script byte for byte;
 *    Solana compares the canonical base58 string byte for byte. No prefix,
 *    suffix or fuzzy matching is ever used to label anything.
 *  - The ONE use of prefix/suffix comparison is findLookalikes, which only
 *    ever produces a WARNING ("looks similar to your contact X but is
 *    DIFFERENT"), never a label.
 *  - Contact names are sanitized (control, bidi-override and invisible
 *    characters removed) so a name cannot visually impersonate another or
 *    reorder the surrounding text.
 *  - Screens must always render a matched contact's name TOGETHER with the
 *    full address, never the name alone.
 */

const CONTACTS_KEY = 'shiba-wallet.contacts.v1';
const STORE_VERSION = 1;

/** Maximum contact-name length, in Unicode code points. */
export const MAX_CONTACT_NAME_LENGTH = 40;

/** Number of leading and trailing characters the look-alike check compares. */
export const LOOKALIKE_AFFIX_LENGTH = 4;

export interface Contact {
  /** CAIP-2 id of the network this address belongs to (the store key). */
  networkId: string;
  /** Sanitized display name (1–40 code points). */
  name: string;
  /** Validated, normalized address (EIP-55 for EVM, lowercase bech32). */
  address: string;
  /** ISO timestamp of when the contact was added. */
  createdAt: string;
}

/** CAIP-2 ids of the EVM test networks (every test profile in config/evm-chain.ts). */
const EVM_TEST_NETWORK_IDS: readonly string[] = EVM_TEST_PROFILES.map((p) => p.caip2);

/**
 * The network ids contacts can be saved for: the four launch chains plus
 * the EVM test networks (the EVM slot while a test network is chosen).
 */
export const CONTACT_NETWORK_IDS: readonly string[] = [
  EVM_CHAIN_ID,
  ...EVM_TEST_NETWORK_IDS,
  BITCOIN_CHAIN_ID,
  DOGECOIN_CHAIN_ID,
  SOLANA_CHAIN_ID,
];

/**
 * Maps a network id to the chain id validateRecipient expects. EVM address
 * syntax and EIP-55 checksums are identical on every EVM chain, and the
 * send flow validates test-network recipients through the EVM slot id
 * ('eip155:1') as well, so every EVM network shares that path.
 */
function validationChainFor(networkId: string): string | null {
  // A network the user added (feature 33) holds contacts like a test
  // network does, under its own CAIP-2 id, while it is registered.
  if (networkId === EVM_CHAIN_ID || EVM_TEST_NETWORK_IDS.includes(networkId) || isCustomNetworkId(networkId)) {
    return EVM_CHAIN_ID;
  }
  if (
    networkId === BITCOIN_CHAIN_ID ||
    networkId === DOGECOIN_CHAIN_ID ||
    networkId === SOLANA_CHAIN_ID
  ) {
    return networkId;
  }
  return null;
}

export type ContactAddressValidation =
  | { ok: true; address: string }
  | { ok: false; error: string };

/**
 * Validates an address for a contact on one network through the send
 * flow's validateRecipient and returns the form that is stored. For
 * bech32 addresses the lowercase form is stored: BIP-173 permits all-
 * uppercase input (QR alphanumeric mode) but defines lowercase as the
 * canonical output, and the engine decodes both identically.
 */
export function validateContactAddress(networkId: string, raw: string): ContactAddressValidation {
  const chain = validationChainFor(networkId);
  if (!chain) return { ok: false, error: `Contacts are not supported for network ${networkId}.` };
  const result = validateRecipient(chain, raw);
  if (!result.ok) return { ok: false, error: result.error };
  let address = result.normalized;
  if (chain === BITCOIN_CHAIN_ID && address.toLowerCase().startsWith(`${BITCOIN.bech32Hrp}1`)) {
    address = address.toLowerCase();
  }
  return { ok: true, address };
}

/**
 * The canonical comparison key for EXACT matching, or null when the
 * address does not validate on this network.
 *  - EVM: the lowercase 0x-prefixed 40-hex form (case-insensitive over the
 *    full 20 bytes; EIP-55 casing carries no identity).
 *  - Bitcoin / Dogecoin: hex of the output script the address decodes to
 *    (the engine's addressToScriptPubKey — the exact bytes a send pays).
 *  - Solana: the base58 string itself (base58 of a fixed 32-byte key is a
 *    bijection, so the string is canonical).
 */
export function exactMatchKey(networkId: string, raw: string): string | null {
  const validation = validateContactAddress(networkId, raw);
  if (!validation.ok) return null;
  const chain = validationChainFor(networkId);
  if (chain === EVM_CHAIN_ID) return validation.address.toLowerCase();
  if (chain === BITCOIN_CHAIN_ID || chain === DOGECOIN_CHAIN_ID) {
    const script = addressToScriptPubKey(
      validation.address,
      chain === BITCOIN_CHAIN_ID ? BITCOIN : DOGECOIN,
    );
    return Array.from(script, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return validation.address;
}

// ---------------------------------------------------------------------------
// Name sanitization
// ---------------------------------------------------------------------------

/**
 * Contact names use the app-wide display-name rules in ./names.ts: NFC
 * normalization, removal of control, bidirectional-formatting and
 * invisible characters (so a name cannot visually impersonate another or
 * reorder the surrounding text), whitespace collapsing, trimming, and a
 * length of 1–40 code points.
 */
export type { NameValidation } from './names.ts';

export function sanitizeContactName(raw: string): NameValidation {
  return sanitizeDisplayName(raw, MAX_CONTACT_NAME_LENGTH, 'contact');
}

// ---------------------------------------------------------------------------
// Matching (pure; screens pass in the list they loaded)
// ---------------------------------------------------------------------------

/** The contact whose address EXACTLY equals `raw` on this network, or null. */
export function findExactContact(
  networkId: string,
  raw: string,
  contacts: readonly Contact[],
): Contact | null {
  const key = exactMatchKey(networkId, raw);
  if (key === null) return null;
  for (const contact of contacts) {
    if (contact.networkId !== networkId) continue;
    if (exactMatchKey(networkId, contact.address) === key) return contact;
  }
  return null;
}

/** Lowercased display form used by the look-alike comparison. */
function lookalikeForm(address: string): string {
  return address.toLowerCase();
}

/**
 * Contacts whose address shares the first 4 AND last 4 characters with
 * `raw` while NOT being the same address — the classic address-poisoning
 * pattern. This is the only prefix/suffix comparison in the app, and its
 * result may only ever be shown as a warning, never as a label.
 *
 * The comparison is deliberately broad, because a false alarm costs a
 * second look while a miss can cost the funds: it runs case-insensitively
 * on every chain, and on the literal address string, so fixed prefixes
 * ("0x", "bc1q", "D") count toward the four leading characters and make
 * the check wider, not narrower. An exact match is never a look-alike.
 */
export function findLookalikes(
  networkId: string,
  raw: string,
  contacts: readonly Contact[],
): Contact[] {
  const key = exactMatchKey(networkId, raw);
  const validated = validateContactAddress(networkId, raw);
  if (key === null || !validated.ok) return [];
  const candidate = lookalikeForm(validated.address);
  if (candidate.length < LOOKALIKE_AFFIX_LENGTH * 2) return [];
  const head = candidate.slice(0, LOOKALIKE_AFFIX_LENGTH);
  const tail = candidate.slice(-LOOKALIKE_AFFIX_LENGTH);
  return contacts.filter((contact) => {
    if (contact.networkId !== networkId) return false;
    if (exactMatchKey(networkId, contact.address) === key) return false;
    const other = lookalikeForm(contact.address);
    return (
      other.length >= LOOKALIKE_AFFIX_LENGTH * 2 &&
      other.slice(0, LOOKALIKE_AFFIX_LENGTH) === head &&
      other.slice(-LOOKALIKE_AFFIX_LENGTH) === tail
    );
  });
}

export type RecipientContactMatch =
  | { kind: 'exact'; contact: Contact }
  | { kind: 'lookalike'; contacts: Contact[] }
  | { kind: 'none' };

/**
 * Classifies a recipient against the saved contacts: an exact match wins
 * (and never also produces a look-alike warning); otherwise any look-alike
 * contacts; otherwise none. Invalid addresses classify as none — the send
 * screen already blocks them with the validation error.
 */
export function matchRecipient(
  networkId: string,
  raw: string,
  contacts: readonly Contact[],
): RecipientContactMatch {
  const exact = findExactContact(networkId, raw, contacts);
  if (exact) return { kind: 'exact', contact: exact };
  const similar = findLookalikes(networkId, raw, contacts);
  if (similar.length > 0) return { kind: 'lookalike', contacts: similar };
  return { kind: 'none' };
}

/** The look-alike warning text, naming every similar contact. */
export function lookalikeWarning(contacts: readonly Contact[]): string {
  const names = contacts.map((c) => `“${c.name}”`).join(', ');
  return (
    `This address looks similar to your contact ${names} but is DIFFERENT. ` +
    'Check every character.'
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ContactBookLoad {
  /** Valid contacts for the requested network, oldest first. */
  contacts: Contact[];
  /**
   * True when the stored data could not be fully read: unparseable JSON,
   * an unknown format version, or entries that failed re-validation. The
   * valid remainder (possibly nothing) is still returned.
   */
  corrupt: boolean;
  /**
   * True when the whole store is unreadable (bad JSON or unknown version).
   * Writes are refused in that state so an unreadable store — possibly
   * written by a newer app version — is never silently overwritten; the
   * user can clear it explicitly with resetContacts.
   */
  unreadable: boolean;
}

interface RawStore {
  version: number;
  networks: Record<string, unknown>;
}

type ReadResult =
  | { state: 'empty' }
  | { state: 'ok'; raw: RawStore }
  | { state: 'unreadable' };

async function readRaw(store: KeyValueStore): Promise<ReadResult> {
  let text: string | null;
  try {
    text = await store.getItem(CONTACTS_KEY);
  } catch {
    // Storage itself failed: behave as unreadable so nothing is written
    // over data that may well still be there.
    return { state: 'unreadable' };
  }
  if (text === null) return { state: 'empty' };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as RawStore).version === STORE_VERSION &&
      (parsed as RawStore).networks &&
      typeof (parsed as RawStore).networks === 'object' &&
      !Array.isArray((parsed as RawStore).networks)
    ) {
      return { state: 'ok', raw: parsed as RawStore };
    }
    return { state: 'unreadable' };
  } catch {
    return { state: 'unreadable' };
  }
}

/**
 * Re-validates one stored entry. Returns the contact only when its name is
 * already in sanitized form and its address is already in the normalized
 * form validation produces — anything else was not written by this module
 * and is not trusted for display.
 */
function reviveEntry(networkId: string, value: unknown): Contact | null {
  if (!value || typeof value !== 'object') return null;
  const e = value as Partial<Contact>;
  if (typeof e.name !== 'string' || typeof e.address !== 'string') return null;
  const name = sanitizeContactName(e.name);
  if (!name.ok || name.name !== e.name) return null;
  const address = validateContactAddress(networkId, e.address);
  if (!address.ok || address.address !== e.address) return null;
  return {
    networkId,
    name: e.name,
    address: e.address,
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : '',
  };
}

function reviveNetwork(networkId: string, value: unknown): { contacts: Contact[]; dropped: number } {
  if (!Array.isArray(value)) {
    return { contacts: [], dropped: value === undefined ? 0 : 1 };
  }
  const contacts: Contact[] = [];
  const seenKeys = new Set<string>();
  let dropped = 0;
  for (const entry of value) {
    const contact = reviveEntry(networkId, entry);
    const key = contact ? exactMatchKey(networkId, contact.address) : null;
    // A duplicate address can only come from tampering; keep the first.
    if (!contact || key === null || seenKeys.has(key)) {
      dropped += 1;
      continue;
    }
    seenKeys.add(key);
    contacts.push(contact);
  }
  return { contacts, dropped };
}

/** Loads one network's contacts. Never throws. */
export async function loadContacts(
  networkId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<ContactBookLoad> {
  const read = await readRaw(store);
  if (read.state === 'empty') return { contacts: [], corrupt: false, unreadable: false };
  if (read.state === 'unreadable') return { contacts: [], corrupt: true, unreadable: true };
  const { contacts, dropped } = reviveNetwork(networkId, read.raw.networks[networkId]);
  return { contacts, corrupt: dropped > 0, unreadable: false };
}

/** Convenience: just the contacts for a network (empty on any failure). */
export async function listContacts(
  networkId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<Contact[]> {
  return (await loadContacts(networkId, store)).contacts;
}

const UNREADABLE_MESSAGE =
  'Your saved contacts could not be read, so nothing was changed. ' +
  'Use "Reset contacts" on the Contacts screen to start a fresh list.';

/**
 * Loads the store for a write. Refuses when it is unreadable. Other
 * networks' raw entries are carried over verbatim; the target network's
 * list is the re-validated one (invalid entries in it are not written back).
 */
async function loadForWrite(
  networkId: string,
  store: KeyValueStore,
): Promise<{ raw: RawStore; contacts: Contact[] }> {
  if (!validationChainFor(networkId)) {
    throw new Error(`Contacts are not supported for network ${networkId}.`);
  }
  const read = await readRaw(store);
  if (read.state === 'unreadable') throw new Error(UNREADABLE_MESSAGE);
  const raw: RawStore =
    read.state === 'ok'
      ? { version: STORE_VERSION, networks: { ...read.raw.networks } }
      : { version: STORE_VERSION, networks: {} };
  return { raw, contacts: reviveNetwork(networkId, raw.networks[networkId]).contacts };
}

async function writeNetwork(
  raw: RawStore,
  networkId: string,
  contacts: Contact[],
  store: KeyValueStore,
): Promise<void> {
  raw.networks[networkId] = contacts.map((c) => ({
    name: c.name,
    address: c.address,
    createdAt: c.createdAt,
  }));
  await store.setItem(CONTACTS_KEY, JSON.stringify(raw));
}

function sameName(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/**
 * Thrown by addContact when the new address looks like (but is not) an
 * existing contact's address. The screen shows the warning and may retry
 * with acknowledgeLookalike: true after an explicit confirmation.
 */
export class LookalikeContactError extends Error {
  readonly similar: Contact[];
  constructor(similar: Contact[]) {
    super(lookalikeWarning(similar));
    this.name = 'LookalikeContactError';
    this.similar = similar;
  }
}

/**
 * Adds a contact. Throws (persisting nothing) when the name or address is
 * invalid, the address is already saved on this network (the message
 * names the existing contact), the name is already used on this network,
 * the store is unreadable, or — unless acknowledgeLookalike is set — the
 * address looks like a different saved contact's address.
 */
export async function addContact(
  networkId: string,
  rawName: string,
  rawAddress: string,
  options: { store?: KeyValueStore; acknowledgeLookalike?: boolean; now?: () => Date } = {},
): Promise<Contact> {
  const store = options.store ?? AsyncStorage;
  const name = sanitizeContactName(rawName);
  if (!name.ok) throw new Error(name.error);
  const address = validateContactAddress(networkId, rawAddress);
  if (!address.ok) throw new Error(address.error);
  const { raw, contacts } = await loadForWrite(networkId, store);
  const existing = findExactContact(networkId, address.address, contacts);
  if (existing) {
    throw new Error(
      `This address is already saved as your contact “${existing.name}”.`,
    );
  }
  const nameClash = contacts.find((c) => sameName(c.name, name.name));
  if (nameClash) {
    throw new Error(
      `You already have a contact named “${nameClash.name}” on this network. ` +
        'Use a different name so the two can never be confused.',
    );
  }
  const similar = findLookalikes(networkId, address.address, contacts);
  if (similar.length > 0 && !options.acknowledgeLookalike) {
    throw new LookalikeContactError(similar);
  }
  const contact: Contact = {
    networkId,
    name: name.name,
    address: address.address,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  await writeNetwork(raw, networkId, [...contacts, contact], store);
  return contact;
}

/** Renames the contact with this exact address. Same name rules as add. */
export async function renameContact(
  networkId: string,
  address: string,
  rawName: string,
  store: KeyValueStore = AsyncStorage,
): Promise<Contact> {
  const name = sanitizeContactName(rawName);
  if (!name.ok) throw new Error(name.error);
  const { raw, contacts } = await loadForWrite(networkId, store);
  const target = findExactContact(networkId, address, contacts);
  if (!target) throw new Error('That contact no longer exists.');
  const nameClash = contacts.find(
    (c) => c !== target && sameName(c.name, name.name),
  );
  if (nameClash) {
    throw new Error(
      `You already have a contact named “${nameClash.name}” on this network. ` +
        'Use a different name so the two can never be confused.',
    );
  }
  const renamed: Contact = { ...target, name: name.name };
  await writeNetwork(
    raw,
    networkId,
    contacts.map((c) => (c === target ? renamed : c)),
    store,
  );
  return renamed;
}

/** Deletes the contact with this exact address; returns false if absent. */
export async function deleteContact(
  networkId: string,
  address: string,
  store: KeyValueStore = AsyncStorage,
): Promise<boolean> {
  const { raw, contacts } = await loadForWrite(networkId, store);
  const target = findExactContact(networkId, address, contacts);
  if (!target) return false;
  await writeNetwork(
    raw,
    networkId,
    contacts.filter((c) => c !== target),
    store,
  );
  return true;
}

/**
 * Deletes every contact saved for ONE network: the step that removes a
 * network the user added (feature 33, wallet/custom-networks.ts). The other
 * networks' raw entries are written back verbatim. Refuses (changing
 * nothing) when the store is unreadable, and refuses the built-in networks.
 * Returns how many entries were stored for the network (0 when none).
 */
export async function forgetContactsForNetwork(
  networkId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<number> {
  if (CONTACT_NETWORK_IDS.includes(networkId)) {
    throw new Error(`The contacts of a built-in network are never deleted this way (${networkId}).`);
  }
  const read = await readRaw(store);
  if (read.state === 'empty') return 0;
  if (read.state === 'unreadable') throw new Error(UNREADABLE_MESSAGE);
  if (!Object.prototype.hasOwnProperty.call(read.raw.networks, networkId)) return 0;
  const stored = read.raw.networks[networkId];
  const count = Array.isArray(stored) ? stored.length : 1;
  const networks = { ...read.raw.networks };
  delete networks[networkId];
  await store.setItem(CONTACTS_KEY, JSON.stringify({ version: STORE_VERSION, networks }));
  return count;
}

/**
 * Replaces the whole contacts store with an empty one (every network).
 * The explicit recovery path for an unreadable store; the screen asks for
 * confirmation first.
 */
export async function resetContacts(store: KeyValueStore = AsyncStorage): Promise<void> {
  await store.setItem(CONTACTS_KEY, JSON.stringify({ version: STORE_VERSION, networks: {} }));
}

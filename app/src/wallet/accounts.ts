import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChainKeyProvider, DerivedAccount } from '@shiba-wallet/core';
import { toChecksumAddress } from '@shiba-wallet/core';
// Explicit .ts extensions: this module is imported by scripts/check-accounts.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import { CHAINS } from './chains.ts';
import { sanitizeDisplayName, type NameValidation } from './names.ts';
import type { KeyValueStore } from './tokens.ts';
import {
  WATCH_ONLY_NO_DERIVATION,
  defaultImportedName,
  defaultWatchOnlyName,
  importedAccountId,
  importedSlotOf,
  isImportedAccountId,
  isWatchOnlyAccountId,
  watchOnlyAccountId,
  watchOnlySlotOf,
} from './account-ids.ts';

export {
  IMPORTED_ACCOUNT_ID_BASE,
  IMPORTED_KEY_PATH,
  importedAccountId,
  importedSlotOf,
  isImportedAccountId,
  isWatchOnlyAccountId,
  smartAccountSaltFor,
  watchOnlyAccountId,
  watchOnlySlotOf,
} from './account-ids.ts';

/**
 * Multiple accounts (Tier 1 feature 4; ADR D8 in docs/ARCHITECTURE.md).
 *
 * One recovery phrase backs up every account. The user-facing "Account N"
 * (index N = 0, 1, 2, …) is a pure function of the seed and N, mapped to
 * per-chain derivation arguments by derivationArgsFor below — the ONLY
 * place that mapping exists. Every derivation in the app (display
 * addresses and signing keys) goes through it.
 *
 * STORAGE. The account list (index, name, hidden flag), the active index
 * and the next unused index live in AsyncStorage under a versioned key.
 * They are public labels, not key material: the mnemonic stays in
 * expo-secure-store (./storage.ts) and nothing here touches it. Every
 * function takes an injectable KeyValueStore so scripts/check-accounts.mjs
 * exercises the exact store code under Node.
 *
 * INDEX RULES.
 *  - Adding an account always takes `nextIndex`, a persisted high-water
 *    mark, so an index is never handed out twice.
 *  - Hiding only hides: the entry (and its index) stays in the list, so a
 *    later "add" can never silently land on a key that was already in use
 *    under a different name. A hidden account can be shown again.
 *  - Account 0 always exists and can never be hidden.
 *  - The active account can only be a visible account.
 *  - If storage is unreadable, the store falls back to the default
 *    (Account 1 = index 0, active). No funds are affected: re-adding
 *    accounts walks the same indices and therefore the same keys.
 *
 * IMPORTED ACCOUNTS (feature 12, ADR D9). An account whose key was imported
 * is listed here too, with `imported: true` and an id in the separate range
 * of ./account-ids.ts (2^31 + vault slot). It is never derived from the
 * phrase, never counts toward MAX_ACCOUNTS or nextIndex, and is never
 * hidden: it is removed instead, which deletes its key (WalletContext asks
 * for an explicit confirmation first). The key itself and the account's
 * address live only in the imported-key vault in ./storage.ts; this list
 * holds only the name. reconcileImportedAccounts keeps the two in step: a
 * key in the vault always has an entry, and an entry without a key goes.
 *
 * WATCH-ONLY ACCOUNTS (feature 10). An Ethereum address the user follows
 * without any key. Its entry carries `watchOnly: true`, an id in the
 * watch-only range of ./account-ids.ts and the address itself (EIP-55),
 * which is public data and the ONLY thing the wallet knows about it: there
 * is nothing in secure storage for a watch-only account. It never counts
 * toward MAX_ACCOUNTS or nextIndex, is never hidden (it is removed, which
 * deletes nothing secret), and its slot is never reused (`nextWatchSlot`,
 * written only once a watch-only account has existed, so the stored form of
 * a list without one is unchanged byte for byte).
 */

const ACCOUNTS_KEY = 'shiba-wallet.accounts.v1';
const STORE_VERSION = 1;

/** Maximum account-name length, in Unicode code points. */
export const MAX_ACCOUNT_NAME_LENGTH = 32;

/**
 * Upper bound on the number of account indices ever created (visible or
 * hidden). A practical limit, far below the BIP-32 bound below: the public
 * addresses of every account are derived at launch (one seed stretch, then
 * four derivations per account), so the list must stay small.
 */
export const MAX_ACCOUNTS = 50;

/**
 * BIP-32 index bound: an index used in a hardened segment (Bitcoin,
 * Dogecoin and Solana put the account index there) must be below 2^31.
 */
export const BIP32_HARDENED_OFFSET = 0x80000000;

export interface WalletAccount {
  /**
   * Derivation index (see derivationArgsFor) for an account from the
   * phrase; for an imported account, its id in the imported range of
   * ./account-ids.ts, which is NOT a derivation index. Never reused.
   */
  index: number;
  /** Sanitized display name, 1–32 code points. */
  name: string;
  /** Hidden accounts keep their index and keys; they are only not listed. */
  hidden: boolean;
  /** Present (true) only for an account whose key was imported (never derived). */
  imported?: true;
  /** Present (true) only for a watch-only account: an address with no key in this wallet. */
  watchOnly?: true;
  /** A watch-only account's EIP-55 address (absent for every other account). */
  address?: string;
}

export interface AccountsState {
  /** Every account ever created, ascending by index (hidden ones included). */
  accounts: WalletAccount[];
  /** Index of the active account; always a visible account. */
  activeIndex: number;
  /** The index the next "Add account" takes; > every DERIVED index in `accounts`. */
  nextIndex: number;
  /**
   * The slot the next watch-only account takes; > every watch-only slot ever
   * used. Absent (meaning 0) until the first watch-only account is added.
   */
  nextWatchSlot?: number;
}

/** "Account 1" for index 0, "Account 2" for index 1, and so on. */
export function defaultAccountName(index: number): string {
  return `Account ${index + 1}`;
}

export function defaultAccountsState(): AccountsState {
  return {
    accounts: [{ index: 0, name: defaultAccountName(0), hidden: false }],
    activeIndex: 0,
    nextIndex: 1,
  };
}

export function sanitizeAccountName(raw: string): NameValidation {
  return sanitizeDisplayName(raw, MAX_ACCOUNT_NAME_LENGTH, 'account');
}

function isValidIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < BIP32_HARDENED_OFFSET
  );
}

/**
 * Rebuilds a trustworthy state from whatever was stored. Entries with an
 * invalid or duplicate index are dropped; an invalid name falls back to
 * the default name (the account itself is kept — dropping it would hide
 * funds); account 0 is re-inserted if missing and forced visible; an
 * invalid or hidden active index falls back to 0; nextIndex never goes
 * below max(index) + 1.
 */
function reviveState(raw: unknown): AccountsState {
  if (typeof raw !== 'object' || raw === null) return defaultAccountsState();
  const r = raw as {
    version?: unknown;
    accounts?: unknown;
    activeIndex?: unknown;
    nextIndex?: unknown;
    nextWatchSlot?: unknown;
  };
  if (r.version !== STORE_VERSION || !Array.isArray(r.accounts)) return defaultAccountsState();

  const byIndex = new Map<number, WalletAccount>();
  for (const entry of r.accounts) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as {
      index?: unknown;
      name?: unknown;
      hidden?: unknown;
      imported?: unknown;
      watchOnly?: unknown;
      address?: unknown;
    };
    if (e.watchOnly === true) {
      // A watch-only account: only an id in the watch-only range and a
      // well-formed EIP-55 address are accepted (anything else is dropped:
      // nothing is lost, the user can add the address again), it is never
      // hidden, and it can never also be an imported entry.
      if (e.imported !== undefined) continue;
      if (typeof e.index !== 'number' || !isWatchOnlyAccountId(e.index) || byIndex.has(e.index)) continue;
      if (typeof e.address !== 'string' || canonicalEvmAddress(e.address) !== e.address) continue;
      const fallback = defaultWatchOnlyName(watchOnlySlotOf(e.index));
      const name = typeof e.name === 'string' ? sanitizeAccountName(e.name) : null;
      byIndex.set(e.index, {
        index: e.index,
        name: name && name.ok && name.name === e.name ? name.name : fallback,
        hidden: false,
        watchOnly: true,
        address: e.address,
      });
      continue;
    }
    if (e.imported === true) {
      // An imported account: only an id in the imported range is accepted,
      // and it is never hidden (it is removed instead).
      if (typeof e.index !== 'number' || !isImportedAccountId(e.index) || byIndex.has(e.index)) continue;
      const fallback = defaultImportedName(importedSlotOf(e.index));
      const name = typeof e.name === 'string' ? sanitizeAccountName(e.name) : null;
      byIndex.set(e.index, {
        index: e.index,
        name: name && name.ok && name.name === e.name ? name.name : fallback,
        hidden: false,
        imported: true,
      });
      continue;
    }
    if (!isValidIndex(e.index) || byIndex.has(e.index)) continue;
    const name = typeof e.name === 'string' ? sanitizeAccountName(e.name) : null;
    byIndex.set(e.index, {
      index: e.index,
      name: name && name.ok && name.name === e.name ? name.name : defaultAccountName(e.index),
      hidden: e.index === 0 ? false : e.hidden === true,
    });
  }
  if (!byIndex.has(0)) byIndex.set(0, { index: 0, name: defaultAccountName(0), hidden: false });

  const accounts = [...byIndex.values()].sort((a, b) => a.index - b.index);
  // Imported and watch-only ids sit above every derivation index, so the
  // high-water mark is taken over the derived accounts only.
  const maxIndex = Math.max(...accounts.filter((a) => !a.imported && !a.watchOnly).map((a) => a.index));
  const storedNext = isValidIndex(r.nextIndex) ? r.nextIndex : 0;
  const nextIndex = Math.max(storedNext, maxIndex + 1);
  const active =
    isValidIndex(r.activeIndex) ||
    (typeof r.activeIndex === 'number' && (isImportedAccountId(r.activeIndex) || isWatchOnlyAccountId(r.activeIndex)))
      ? byIndex.get(r.activeIndex)
      : undefined;
  const state: AccountsState = {
    accounts,
    activeIndex: active && !active.hidden ? active.index : 0,
    nextIndex,
  };
  // The watch-only high-water mark: never below the stored value, never
  // below one past the highest slot still listed.
  const watchSlots = accounts.filter((a) => a.watchOnly).map((a) => watchOnlySlotOf(a.index));
  const storedWatchNext =
    typeof r.nextWatchSlot === 'number' && Number.isSafeInteger(r.nextWatchSlot) && r.nextWatchSlot > 0
      ? Math.min(r.nextWatchSlot, MAX_WATCH_ONLY_SLOT_COUNT)
      : 0;
  const nextWatchSlot = Math.max(storedWatchNext, watchSlots.length > 0 ? Math.max(...watchSlots) + 1 : 0);
  if (nextWatchSlot > 0) state.nextWatchSlot = nextWatchSlot;
  return state;
}

/** Loads the account list. Never throws: unreadable storage yields the default. */
export async function loadAccounts(store: KeyValueStore = AsyncStorage): Promise<AccountsState> {
  let raw: string | null;
  try {
    raw = await store.getItem(ACCOUNTS_KEY);
  } catch {
    return defaultAccountsState();
  }
  if (raw === null) return defaultAccountsState();
  try {
    return reviveState(JSON.parse(raw));
  } catch {
    return defaultAccountsState();
  }
}

async function saveAccounts(state: AccountsState, store: KeyValueStore): Promise<void> {
  await store.setItem(
    ACCOUNTS_KEY,
    JSON.stringify({
      version: STORE_VERSION,
      accounts: state.accounts,
      activeIndex: state.activeIndex,
      nextIndex: state.nextIndex,
      // Written only once a watch-only account has existed, so a list
      // without one is stored exactly as before (feature 10).
      ...(state.nextWatchSlot ? { nextWatchSlot: state.nextWatchSlot } : {}),
    }),
  );
}

/** Restores the default list (used on wallet wipe and on create/import). */
export async function resetAccounts(store: KeyValueStore = AsyncStorage): Promise<AccountsState> {
  const state = defaultAccountsState();
  await saveAccounts(state, store);
  return state;
}

/** The visible accounts, ascending by index. */
export function visibleAccounts(state: AccountsState): WalletAccount[] {
  return state.accounts.filter((a) => !a.hidden);
}

function findAccount(state: AccountsState, index: number): WalletAccount {
  const account = state.accounts.find((a) => a.index === index);
  if (!account) throw new Error(`There is no account with index ${index}.`);
  return account;
}

/**
 * Creates the next account (index = nextIndex). The name defaults to
 * "Account N+1"; a supplied name is sanitized and refused when invalid.
 * Does not switch to the new account.
 */
export async function addAccount(
  rawName: string | null = null,
  store: KeyValueStore = AsyncStorage,
): Promise<{ state: AccountsState; account: WalletAccount }> {
  const state = await loadAccounts(store);
  const derivedCount = state.accounts.filter((a) => !a.imported && !a.watchOnly).length;
  if (derivedCount >= MAX_ACCOUNTS || state.nextIndex >= BIP32_HARDENED_OFFSET) {
    throw new Error(`This wallet already has the maximum of ${MAX_ACCOUNTS} accounts.`);
  }
  const index = state.nextIndex;
  let name = defaultAccountName(index);
  if (rawName !== null && rawName.trim() !== '') {
    const validation = sanitizeAccountName(rawName);
    if (!validation.ok) throw new Error(validation.error);
    name = validation.name;
  }
  const account: WalletAccount = { index, name, hidden: false };
  const next: AccountsState = {
    accounts: [...state.accounts, account],
    activeIndex: state.activeIndex,
    nextIndex: index + 1,
    ...(state.nextWatchSlot ? { nextWatchSlot: state.nextWatchSlot } : {}),
  };
  await saveAccounts(next, store);
  return { state: next, account };
}

export async function renameAccount(
  index: number,
  rawName: string,
  store: KeyValueStore = AsyncStorage,
): Promise<AccountsState> {
  const validation = sanitizeAccountName(rawName);
  if (!validation.ok) throw new Error(validation.error);
  const state = await loadAccounts(store);
  findAccount(state, index);
  const next: AccountsState = {
    ...state,
    accounts: state.accounts.map((a) => (a.index === index ? { ...a, name: validation.name } : a)),
  };
  await saveAccounts(next, store);
  return next;
}

/**
 * Hides an account. Account 0 can never be hidden, and neither can the
 * active account (switch first) — so the active account is always
 * visible. The index stays reserved; the keys are untouched.
 */
export async function hideAccount(
  index: number,
  store: KeyValueStore = AsyncStorage,
): Promise<AccountsState> {
  if (index === 0) throw new Error('The wallet\'s first account cannot be hidden.');
  const state = await loadAccounts(store);
  const account = findAccount(state, index);
  if (account.imported) throw new Error(IMPORTED_HIDE_REFUSAL);
  if (account.watchOnly) throw new Error(WATCH_ONLY_HIDE_REFUSAL);
  if (state.activeIndex === index) {
    throw new Error(`${account.name} is the active account. Switch to another account first.`);
  }
  const next: AccountsState = {
    ...state,
    accounts: state.accounts.map((a) => (a.index === index ? { ...a, hidden: true } : a)),
  };
  await saveAccounts(next, store);
  return next;
}

/** Shows a hidden account again (same index, same keys, same name). */
export async function unhideAccount(
  index: number,
  store: KeyValueStore = AsyncStorage,
): Promise<AccountsState> {
  const state = await loadAccounts(store);
  findAccount(state, index);
  const next: AccountsState = {
    ...state,
    accounts: state.accounts.map((a) => (a.index === index ? { ...a, hidden: false } : a)),
  };
  await saveAccounts(next, store);
  return next;
}

// ---------------------------------------------------------------------------
// Imported accounts (feature 12; ADR D9)
// ---------------------------------------------------------------------------

/** Refusal for "Hide" on an imported account. */
export const IMPORTED_HIDE_REFUSAL =
  'An imported account cannot be hidden. Remove it instead (Settings → Accounts); removing deletes ' +
  'its private key from this phone after you confirm.';

/** Upper bound on imported keys held at once (the vault enforces it too). */
export const MAX_IMPORTED_ACCOUNTS = 10;

/**
 * Adds the list entry for imported-key vault slot `slot` (the vault entry
 * must already exist). Does not switch to it.
 */
export async function addImportedAccountEntry(
  slot: number,
  rawName: string | null = null,
  store: KeyValueStore = AsyncStorage,
): Promise<{ state: AccountsState; account: WalletAccount }> {
  const state = await loadAccounts(store);
  const id = importedAccountId(slot);
  if (state.accounts.some((a) => a.index === id)) throw new Error('This imported key is already listed.');
  let name = defaultImportedName(slot);
  if (rawName !== null && rawName.trim() !== '') {
    const validation = sanitizeAccountName(rawName);
    if (!validation.ok) throw new Error(validation.error);
    name = validation.name;
  }
  const account: WalletAccount = { index: id, name, hidden: false, imported: true };
  const next: AccountsState = { ...state, accounts: [...state.accounts, account].sort((a, b) => a.index - b.index) };
  await saveAccounts(next, store);
  return { state: next, account };
}

/**
 * Removes an imported account's list entry. The active account cannot be
 * removed (switch first). The caller deletes the key from the vault FIRST,
 * after the user's explicit confirmation; a leftover entry without a key is
 * also dropped by reconcileImportedAccounts at the next launch.
 */
export async function removeImportedAccountEntry(
  id: number,
  store: KeyValueStore = AsyncStorage,
): Promise<AccountsState> {
  const state = await loadAccounts(store);
  const account = findAccount(state, id);
  if (!account.imported) throw new Error('Only an imported account can be removed.');
  if (state.activeIndex === id) {
    throw new Error(`${account.name} is the active account. Switch to another account first.`);
  }
  const next: AccountsState = { ...state, accounts: state.accounts.filter((a) => a.index !== id) };
  await saveAccounts(next, store);
  return next;
}

/**
 * Brings the list in step with the imported-key vault (pure). `vaultSlots`
 * is the list of slots the vault holds, or null when the vault's record of
 * them could not be read (then nothing is added or dropped):
 *  - a slot without an entry gets one ("Imported N"), so a key on this
 *    phone is never invisible, e.g. after the account list was reset;
 *  - an imported entry without a slot is dropped (its key is gone), and if
 *    it was active, Account 1 becomes active.
 * Returns changed = false when nothing differs.
 */
export function reconcileImportedAccounts(
  state: AccountsState,
  vaultSlots: readonly number[] | null,
): { state: AccountsState; changed: boolean } {
  if (vaultSlots === null) return { state, changed: false };
  const ids = new Set(vaultSlots.map((slot) => importedAccountId(slot)));
  const kept = state.accounts.filter((a) => !a.imported || ids.has(a.index));
  const present = new Set(kept.map((a) => a.index));
  const added: WalletAccount[] = [...ids]
    .filter((id) => !present.has(id))
    .map((id) => ({ index: id, name: defaultImportedName(importedSlotOf(id)), hidden: false, imported: true }));
  const changed = kept.length !== state.accounts.length || added.length > 0;
  if (!changed) return { state, changed: false };
  const accounts = [...kept, ...added].sort((a, b) => a.index - b.index);
  const activeStillThere = accounts.some((a) => a.index === state.activeIndex && !a.hidden);
  return {
    state: {
      accounts,
      activeIndex: activeStillThere ? state.activeIndex : 0,
      nextIndex: state.nextIndex,
      ...(state.nextWatchSlot ? { nextWatchSlot: state.nextWatchSlot } : {}),
    },
    changed: true,
  };
}

/** reconcileImportedAccounts, persisted when something changed. */
export async function reconcileStoredImportedAccounts(
  vaultSlots: readonly number[] | null,
  store: KeyValueStore = AsyncStorage,
): Promise<AccountsState> {
  const current = await loadAccounts(store);
  const { state, changed } = reconcileImportedAccounts(current, vaultSlots);
  if (changed) await saveAccounts(state, store);
  return state;
}

// ---------------------------------------------------------------------------
// Watch-only accounts (feature 10)
// ---------------------------------------------------------------------------

/** Number of watch-only slot values the id range allows (MAX_WATCH_ONLY_SLOT + 1). */
const MAX_WATCH_ONLY_SLOT_COUNT = 0x100000;

/** Upper bound on watch-only accounts listed at once. */
export const MAX_WATCH_ONLY_ACCOUNTS = 20;

/** Refusal for "Hide" on a watch-only account. */
export const WATCH_ONLY_HIDE_REFUSAL =
  'A watch-only account cannot be hidden. Remove it instead (Settings → Accounts); removing deletes ' +
  'nothing secret, because the wallet holds no key for it.';

/** Refusal when the address is already a watch-only account. */
export function watchOnlyDuplicateError(name: string, address: string): string {
  return `This address is already watched as ${name} (${address}).`;
}

/**
 * EIP-55 form of a 0x-prefixed 40-hex-digit address, or null for anything
 * else. Used to re-check stored watch-only addresses; user input goes
 * through the send flow's validateRecipient (./watch-only.ts), which also
 * refuses a wrong checksum instead of silently fixing it.
 */
export function canonicalEvmAddress(address: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const hex = address.slice(2).toLowerCase();
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return toChecksumAddress(bytes);
}

/**
 * Adds a watch-only account for `address` (already validated and in EIP-55
 * form; the caller also refuses an address that is one of the wallet's own
 * accounts, which this store cannot see). Refuses a duplicate watch-only
 * address and an address that is not in EIP-55 form. Does not switch to it.
 */
export async function addWatchOnlyAccountEntry(
  address: string,
  rawName: string | null = null,
  store: KeyValueStore = AsyncStorage,
): Promise<{ state: AccountsState; account: WalletAccount }> {
  if (canonicalEvmAddress(address) !== address) {
    throw new Error('A watch-only address must be a checksummed (EIP-55) Ethereum address.');
  }
  const state = await loadAccounts(store);
  const existing = state.accounts.find((a) => a.watchOnly && a.address?.toLowerCase() === address.toLowerCase());
  if (existing) throw new Error(watchOnlyDuplicateError(existing.name, existing.address ?? address));
  if (state.accounts.filter((a) => a.watchOnly).length >= MAX_WATCH_ONLY_ACCOUNTS) {
    throw new Error(`This wallet already watches the maximum of ${MAX_WATCH_ONLY_ACCOUNTS} addresses.`);
  }
  const slot = state.nextWatchSlot ?? 0;
  if (slot >= MAX_WATCH_ONLY_SLOT_COUNT) {
    throw new Error('No watch-only slot is left in this wallet.');
  }
  let name = defaultWatchOnlyName(slot);
  if (rawName !== null && rawName.trim() !== '') {
    const validation = sanitizeAccountName(rawName);
    if (!validation.ok) throw new Error(validation.error);
    name = validation.name;
  }
  const account: WalletAccount = { index: watchOnlyAccountId(slot), name, hidden: false, watchOnly: true, address };
  const next: AccountsState = {
    ...state,
    accounts: [...state.accounts, account].sort((a, b) => a.index - b.index),
    nextWatchSlot: slot + 1,
  };
  await saveAccounts(next, store);
  return { state: next, account };
}

/**
 * Removes a watch-only account. Nothing secret exists for it, so nothing
 * else is deleted. The active account cannot be removed (switch first).
 */
export async function removeWatchOnlyAccountEntry(
  id: number,
  store: KeyValueStore = AsyncStorage,
): Promise<AccountsState> {
  const state = await loadAccounts(store);
  const account = findAccount(state, id);
  if (!account.watchOnly) throw new Error('Only a watch-only account can be removed this way.');
  if (state.activeIndex === id) {
    throw new Error(`${account.name} is the active account. Switch to another account first.`);
  }
  const next: AccountsState = { ...state, accounts: state.accounts.filter((a) => a.index !== id) };
  await saveAccounts(next, store);
  return next;
}

/** Persists a new active account; it must exist and be visible. */
export async function setActiveAccount(
  index: number,
  store: KeyValueStore = AsyncStorage,
): Promise<AccountsState> {
  const state = await loadAccounts(store);
  const account = findAccount(state, index);
  if (account.hidden) throw new Error(`${account.name} is hidden. Show it again before using it.`);
  const next: AccountsState = { ...state, activeIndex: index };
  await saveAccounts(next, store);
  return next;
}

// ---------------------------------------------------------------------------
// Derivation mapping (recovery-critical; ADR D8)
// ---------------------------------------------------------------------------

const BITCOIN_CAIP2 = 'bip122:000000000019d6689c085ae165831e93';
const DOGECOIN_CAIP2 = 'bip122:1a91e3dace36e2be3bf030a65679fe82';
const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/**
 * Maps the user-facing account index to the (account, addressIndex)
 * arguments of core's ChainKeyProvider.deriveAccount, per chain family:
 *
 *   EVM (every eip155 chain) → account 0, addressIndex N
 *                               path m/44'/60'/0'/0/N (MetaMask convention)
 *   Bitcoin                  → account N, addressIndex 0
 *                               path m/84'/0'/N'/0/0 (BIP-44/BIP-84 accounts)
 *   Dogecoin                 → account N, addressIndex 0
 *                               path m/44'/3'/N'/0/0 (BIP-44 accounts)
 *   Solana                   → account N (addressIndex unused)
 *                               path m/44'/501'/N'/0' (Phantom convention)
 *
 * The EVM row deliberately does NOT use account = N: that would give the
 * account-level layout m/44'/60'/N'/0/0, which a MetaMask import of the
 * same phrase would never find (MetaMask's eth-hd-keyring derives
 * m/44'/60'/0'/0 and then child i for account i).
 *
 * Known divergence: Phantom's default Bitcoin path increments the ADDRESS
 * index (m/84'/0'/0'/0/{index}); this wallet uses the BIP-44 account level
 * for Bitcoin, so Bitcoin accounts beyond the first do not round-trip with
 * Phantom. See ADR D8. Index 0 reproduces exactly the
 * (0, 0) arguments the app used before multiple accounts existed, for all
 * four chains. Unknown chains throw: a new chain family must make this
 * decision explicitly here, never inherit a default.
 */
export function derivationArgsFor(
  chainId: string,
  accountIndex: number,
): { account: number; addressIndex: number } {
  if (isWatchOnlyAccountId(accountIndex)) throw new Error(WATCH_ONLY_NO_DERIVATION);
  if (!isValidIndex(accountIndex)) {
    throw new Error(`Invalid account index ${String(accountIndex)}.`);
  }
  if (chainId.startsWith('eip155:')) return { account: 0, addressIndex: accountIndex };
  if (chainId === BITCOIN_CAIP2 || chainId === DOGECOIN_CAIP2 || chainId === SOLANA_CAIP2) {
    return { account: accountIndex, addressIndex: 0 };
  }
  throw new Error(`No account derivation mapping is defined for chain ${chainId}.`);
}

/** Derives the key of account `accountIndex` on the provider's chain. */
export function deriveForAccount(
  provider: ChainKeyProvider,
  seed: Uint8Array,
  accountIndex: number,
): DerivedAccount {
  const { account, addressIndex } = derivationArgsFor(provider.chainId, accountIndex);
  return provider.deriveAccount(seed, account, addressIndex);
}

/** One derived address for one chain, safe to keep in app state. */
export interface ChainAccount {
  chainId: string;
  name: string;
  symbol: string;
  accent: string;
  address: string;
  path: string;
}

/**
 * Public data (addresses, paths) of one account on every launch chain.
 * The DerivedAccount objects — whose sign closures capture private keys —
 * are dropped before this returns; the caller owns and zeroes the seed.
 */
export function deriveChainAccounts(seed: Uint8Array, accountIndex: number): ChainAccount[] {
  return CHAINS.map(({ provider, symbol, accent }) => {
    const derived = deriveForAccount(provider, seed, accountIndex);
    return {
      chainId: provider.chainId,
      name: provider.name,
      symbol,
      accent,
      address: derived.address,
      path: derived.path,
    };
  });
}

/**
 * Address equality for the signer check: EVM addresses compare over the
 * 20 bytes (EIP-55 casing carries no identity); every other chain's
 * address string is canonical as derived and compares exactly.
 */
export function sameAccountAddress(chainId: string, a: string, b: string): boolean {
  if (chainId.startsWith('eip155:')) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export const ACCOUNT_CHANGED_MESSAGE =
  'The active account changed after this was prepared, so nothing was signed. ' +
  'Review it again from the account you want to use.';

/**
 * The signing half of WalletContext.signWith, kept pure so the check
 * script runs the exact code: derives the ACTIVE account's key for one
 * chain and refuses — before any signing — unless it controls exactly the
 * address the caller prepared the operation for. The caller owns the seed
 * and must not retain the returned DerivedAccount.
 */
export function deriveSignerFor(
  provider: ChainKeyProvider,
  seed: Uint8Array,
  activeIndex: number,
  expectAddress: string,
): DerivedAccount {
  const account = deriveForAccount(provider, seed, activeIndex);
  if (!sameAccountAddress(provider.chainId, account.address, expectAddress)) {
    throw new Error(ACCOUNT_CHANGED_MESSAGE);
  }
  return account;
}

/** "0x9858Ef…Eda94" style short form for labels (never for confirmation). */
export function shortAccountAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** "Account 2 (0x6Fac…b9C0)" — a name is always shown with its address. */
export function accountLabel(name: string, evmAddress: string | null): string {
  return evmAddress ? `${name} (${shortAccountAddress(evmAddress)})` : name;
}

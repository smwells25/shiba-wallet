import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChainKeyProvider, DerivedAccount } from '@shiba-wallet/core';
// Explicit .ts extensions: this module is imported by scripts/check-accounts.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import { CHAINS } from './chains.ts';
import { sanitizeDisplayName, type NameValidation } from './names.ts';
import type { KeyValueStore } from './tokens.ts';

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
  /** Derivation index (see derivationArgsFor). Never reused. */
  index: number;
  /** Sanitized display name, 1–32 code points. */
  name: string;
  /** Hidden accounts keep their index and keys; they are only not listed. */
  hidden: boolean;
}

export interface AccountsState {
  /** Every account ever created, ascending by index (hidden ones included). */
  accounts: WalletAccount[];
  /** Index of the active account; always a visible account. */
  activeIndex: number;
  /** The index the next "Add account" takes; > every index in `accounts`. */
  nextIndex: number;
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
  const r = raw as { version?: unknown; accounts?: unknown; activeIndex?: unknown; nextIndex?: unknown };
  if (r.version !== STORE_VERSION || !Array.isArray(r.accounts)) return defaultAccountsState();

  const byIndex = new Map<number, WalletAccount>();
  for (const entry of r.accounts) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { index?: unknown; name?: unknown; hidden?: unknown };
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
  const maxIndex = accounts[accounts.length - 1]!.index;
  const storedNext = isValidIndex(r.nextIndex) ? r.nextIndex : 0;
  const nextIndex = Math.max(storedNext, maxIndex + 1);
  const active = isValidIndex(r.activeIndex) ? byIndex.get(r.activeIndex) : undefined;
  return {
    accounts,
    activeIndex: active && !active.hidden ? active.index : 0,
    nextIndex,
  };
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
  if (state.accounts.length >= MAX_ACCOUNTS || state.nextIndex >= BIP32_HARDENED_OFFSET) {
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

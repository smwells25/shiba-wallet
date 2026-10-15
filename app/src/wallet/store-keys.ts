// The storage seam (duress wallet, Stage 1: docs/DURESS_WALLET.md section
// 5.2). Every "shiba-wallet." storage key the app uses is declared here, and
// every read, write, delete and listing of such a key goes through the
// functions below. scripts/check-storage-seam.mjs fails on any key literal,
// any AsyncStorage or expo-secure-store call, and any getItem / setItem /
// removeItem call outside this module (apart from an explicit allow-list of
// files that move in a later slice).
//
// Why a seam: a decoy wallet (feature 53) must never show the real wallet's
// records. Today there is one wallet, and every key resolves to itself
// (scopedStoreKey is the identity for the primary profile, pinned by the
// check). A later stage can give a second profile its own copy of every
// per-wallet record by passing a profile to scopedStoreKey, without
// touching any caller.
//
// Behaviour is byte-identical to the direct calls this module replaced: the
// same key strings, the same values (callers still build their own JSON),
// and the same error behaviour (each wrapper returns the underlying call's
// promise unchanged; none of them is async, catches or retries).
//
// This module must load under Node's type stripping (the check scripts drive
// the wallet modules with injected fakes), so it imports expo-secure-store as
// a TYPE only; the native module is handed in by WalletContext.tsx through
// storage.ts (bindSecureStore). AsyncStorage is imported here and nowhere
// else in app/src/wallet: callers that need the default store import the
// re-export below and pass it on, never call it themselves.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type * as ExpoSecureStore from 'expo-secure-store';

/**
 * The app's default key-value store (AsyncStorage). Re-exported so callers
 * can keep it as their injectable default (`store: KeyValueStore =
 * AsyncStorage`); every access to it still goes through readStoreItem /
 * writeStoreItem / removeStoreItem.
 */
export { AsyncStorage };

// ---------------------------------------------------------------------------
// Store shapes
// ---------------------------------------------------------------------------

/** The subset of the AsyncStorage API the wallet's stores need (injectable). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** A store that may also delete (AsyncStorage does; some test fakes do not). */
export type RemovableKeyValueStore = KeyValueStore & { removeItem?: (key: string) => Promise<void> };

export interface SecureStoreItemOptions {
  keychainService?: string;
  requireAuthentication?: boolean;
  authenticationPrompt?: string;
  keychainAccessible?: number;
}

/** The subset of expo-secure-store the vault uses (storage.ts). */
export interface SecureStoreBackend {
  getItemAsync(key: string, options: SecureStoreItemOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options: SecureStoreItemOptions): Promise<void>;
  deleteItemAsync(key: string, options: SecureStoreItemOptions): Promise<void>;
  /** expo-secure-store canUseBiometricAuthentication() (synchronous). */
  canUseBiometricAuthentication(): boolean;
  /** The package's WHEN_UNLOCKED_THIS_DEVICE_ONLY constant. */
  whenUnlockedThisDeviceOnly: number;
}

/** Adapts the real expo-secure-store module to SecureStoreBackend. */
export function nativeSecureStoreAdapter(mod: typeof ExpoSecureStore): SecureStoreBackend {
  return {
    getItemAsync: (key, options) => mod.getItemAsync(key, options),
    setItemAsync: (key, value, options) => mod.setItemAsync(key, value, options),
    deleteItemAsync: (key, options) => mod.deleteItemAsync(key, options),
    canUseBiometricAuthentication: () => mod.canUseBiometricAuthentication(),
    whenUnlockedThisDeviceOnly: mod.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
}

// ---------------------------------------------------------------------------
// The key registry
// ---------------------------------------------------------------------------

/**
 * What a key belongs to:
 *  - 'wallet': per-wallet data (accounts, contacts, notes, records of what
 *    this wallet did or holds). A decoy wallet must have its own copy.
 *  - 'device': device-wide settings (preferences, endpoints, API keys,
 *    networks the user added). Shared by every wallet on the phone.
 *  - 'secret': expo-secure-store items (the phrase, imported and session
 *    keys, and the vault's own metadata and public caches). Per wallet.
 */
export type StoreKeyScope = 'wallet' | 'device' | 'secret';

export interface StoreKeyDeclaration {
  /** The key, or for a prefix the fixed part every such key starts with. */
  readonly name: string;
  readonly scope: StoreKeyScope;
  /** 'exact' = one key; 'prefix' = a family of keys (name + a suffix). */
  readonly match: 'exact' | 'prefix';
  /** Where the key lives. */
  readonly backing: 'async-storage' | 'secure-store';
}

/** The fixed start of every key this app stores. */
export const STORE_KEY_ROOT = 'shiba-wallet.';

function declare(
  name: string,
  scope: StoreKeyScope,
  match: 'exact' | 'prefix' = 'exact',
  backing: 'async-storage' | 'secure-store' = 'async-storage',
): StoreKeyDeclaration {
  return Object.freeze({ name, scope, match, backing });
}

/**
 * Every storage key of the app, by role. The module that owns a store
 * exports its own constant equal to the `name` here (e.g. accounts.ts's
 * ACCOUNTS_KEY), so existing imports keep working.
 */
export const STORE_KEYS = Object.freeze({
  // --- AsyncStorage, per wallet ---------------------------------------------
  accounts: declare('shiba-wallet.accounts.v1', 'wallet'),
  contacts: declare('shiba-wallet.contacts.v1', 'wallet'),
  /** Mainnet's tracked tokens (the original key, kept byte for byte). */
  tokens: declare('shiba-wallet.tokens.v1', 'wallet'),
  /** Every other chain's tracked tokens: shiba-wallet.tokens.v1.<CAIP-2>. */
  tokensPerChain: declare('shiba-wallet.tokens.v1.', 'wallet', 'prefix'),
  txNotes: declare('shiba-wallet.tx-notes.v1', 'wallet'),
  sessions: declare('shiba-wallet.sessions.v1', 'wallet'),
  multisig: declare('shiba-wallet.multisig.v1', 'wallet'),
  recoveryRecords: declare('shiba-wallet.recovery-records.v1', 'wallet'),
  recoveryProgress: declare('shiba-wallet.recovery-progress.v1', 'wallet'),
  inheritance: declare('shiba-wallet.inheritance.v1', 'wallet'),
  passkeys: declare('shiba-wallet.passkeys.v1', 'wallet'),
  spendingPolicies: declare('shiba-wallet.spending-policies.v1', 'wallet'),
  spendingHistory: declare('shiba-wallet.spending-history.v1', 'wallet'),
  pendingTx: declare('shiba-wallet.pending-tx.v1', 'wallet'),
  browserConnections: declare('shiba-wallet.browser-connections.v1', 'wallet'),
  wcSmartBindings: declare('shiba-wallet.wc-smart-bindings.v1', 'wallet'),
  wcCalls: declare('shiba-wallet.wc-calls.v1', 'wallet'),
  /** Whether WalletConnect was ever used (the launch marker). */
  wcUsed: declare('shiba-wallet.wc-used.v1', 'wallet'),
  /**
   * Smart-account configuration. MIXED: per-chain bundler URLs and factory
   * addresses (device-like) together with recovered accounts and EIP-7702
   * owners (per wallet). Declared 'wallet' so a decoy never sees the real
   * wallet's accounts; Stage 2 must split it or copy the device fields.
   */
  aaConfig: declare('shiba-wallet.aa-config.v1', 'wallet'),
  priceAlerts: declare('shiba-wallet.price-alerts.v1', 'wallet'),
  /** Reminder bookkeeping (seen takeover hashes, the "may have scheduled" flag). */
  notifications: declare('shiba-wallet.notifications.v1', 'wallet'),

  // --- AsyncStorage, device-wide ---------------------------------------------
  prefs: declare('shiba-wallet.prefs.v1', 'device'),
  rpcEndpoints: declare('shiba-wallet.rpc-endpoints.v1', 'device'),
  customNetworks: declare('shiba-wallet.custom-networks.v1', 'device'),
  wcConfig: declare('shiba-wallet.wc-config.v1', 'device'),
  priceConfig: declare('shiba-wallet.price-config.v1', 'device'),
  swapConfig: declare('shiba-wallet.swap-config.v1', 'device'),
  blockbook: declare('shiba-wallet.blockbook.v1', 'device'),
  evmIndexer: declare('shiba-wallet.evm-indexer.v1', 'device'),
  nftIndexer: declare('shiba-wallet.nft-indexer.v1', 'device'),

  // --- expo-secure-store -----------------------------------------------------
  mnemonic: declare('shiba-wallet.mnemonic.v1', 'secret', 'exact', 'secure-store'),
  protectedMnemonic: declare('shiba-wallet.mnemonic.v2', 'secret', 'exact', 'secure-store'),
  vaultMeta: declare('shiba-wallet.vault-meta.v1', 'secret', 'exact', 'secure-store'),
  publicAccount: declare('shiba-wallet.public-account.v1.', 'secret', 'prefix', 'secure-store'),
  sessionKey: declare('shiba-wallet.session-key.v1.', 'secret', 'prefix', 'secure-store'),
  protectedSessionKey: declare('shiba-wallet.session-key.v2.', 'secret', 'prefix', 'secure-store'),
  importedKeysMeta: declare('shiba-wallet.imported-keys.v1', 'secret', 'exact', 'secure-store'),
  importedKey: declare('shiba-wallet.imported-key.v1.', 'secret', 'prefix', 'secure-store'),
  protectedImportedKey: declare('shiba-wallet.imported-key.v2.', 'secret', 'prefix', 'secure-store'),
});

/**
 * The keychain service of the protected secure-store copies (a separate
 * Keystore key / Keychain service, so the standard and protected copies can
 * never collide). A service name, not a key.
 */
export const PROTECTED_SECURE_STORE_SERVICE = 'shiba-wallet.protected';

/**
 * Identifiers of local notifications (expo-notifications), not storage keys.
 * Declared here so that every "shiba-wallet." name lives in one place; they
 * are per wallet (a reminder names a record of this wallet), which Stage 2
 * must take into account (docs/DURESS_WALLET.md section 7.4).
 */
export const NOTIFICATION_ID_NAMES = Object.freeze({
  root: 'shiba-wallet.',
  recurring: 'shiba-wallet.recurring.',
  takeover: 'shiba-wallet.takeover.',
  priceAlert: 'shiba-wallet.price-alert.',
});

const DECLARATIONS: readonly StoreKeyDeclaration[] = Object.values(STORE_KEYS);

/** Thrown for a key this module does not declare (a programming error). */
export class UndeclaredStoreKeyError extends Error {
  constructor(key: string) {
    super(`The storage key "${key}" is not declared in the app's storage-key registry.`);
    this.name = 'UndeclaredStoreKeyError';
  }
}

/** The declaration a key falls under: an exact match first, else the longest prefix. */
export function storeKeyDeclaration(key: string): StoreKeyDeclaration {
  let best: StoreKeyDeclaration | null = null;
  for (const d of DECLARATIONS) {
    if (d.match === 'exact') {
      if (d.name === key) return d;
    } else if (key.startsWith(d.name) && (!best || d.name.length > best.name.length)) {
      best = d;
    }
  }
  if (!best) throw new UndeclaredStoreKeyError(key);
  return best;
}

/** The scope of a declared key. Throws UndeclaredStoreKeyError otherwise. */
export function storeKeyScope(key: string): StoreKeyScope {
  return storeKeyDeclaration(key).scope;
}

// ---------------------------------------------------------------------------
// Profiles and the scope function
// ---------------------------------------------------------------------------

/**
 * Whose records a key addresses. Stage 1 has exactly one profile, the
 * primary one, whose keys are the names above unchanged (no migration).
 * Nothing in the app passes another profile yet, and this module offers no
 * way to make another profile the default: Stage 2 (the duress PIN) adds
 * that, decided before any wallet data is loaded.
 */
export interface StoreProfile {
  readonly id: string;
  /** null for the primary profile; otherwise 1–16 lower-case letters or digits. */
  readonly keyPrefix: string | null;
}

export const PRIMARY_STORE_PROFILE: StoreProfile = Object.freeze({ id: 'primary', keyPrefix: null });

/** The reserved segment a non-primary profile's keys carry (no declared key uses it). */
export const PROFILE_KEY_SEGMENT = 'profile-';

/**
 * The key actually used in the store for `key` under `profile`.
 *
 * Primary profile (the only one in use): the key unchanged, for every scope.
 * Another profile: 'device' keys unchanged (shared settings); 'wallet' and
 * 'secret' keys become shiba-wallet.profile-<prefix>.<rest of the key>, a
 * name no declared key can have, so the two profiles can never read each
 * other's records. Throws for an undeclared key in either case.
 */
export function scopedStoreKey(key: string, profile: StoreProfile = PRIMARY_STORE_PROFILE): string {
  const scope = storeKeyScope(key);
  if (profile.keyPrefix === null || scope === 'device') return key;
  if (!/^[a-z0-9]{1,16}$/.test(profile.keyPrefix)) {
    throw new Error('A storage profile prefix is 1 to 16 lower-case letters or digits.');
  }
  return `${STORE_KEY_ROOT}${PROFILE_KEY_SEGMENT}${profile.keyPrefix}.${key.slice(STORE_KEY_ROOT.length)}`;
}

// ---------------------------------------------------------------------------
// Access (the only functions that read, write, delete or list keys)
// ---------------------------------------------------------------------------

/** store.getItem for a declared key. */
export function readStoreItem(store: KeyValueStore, key: string): Promise<string | null> {
  return store.getItem(scopedStoreKey(key));
}

/** store.setItem for a declared key. The value is written exactly as given. */
export function writeStoreItem(store: KeyValueStore, key: string, value: string): Promise<void> {
  return store.setItem(scopedStoreKey(key), value);
}

/**
 * store.removeItem for a declared key. Callers check `store.removeItem`
 * first (a store without it keeps its old fallback of writing an empty
 * value), so the throw below is unreachable from the app's code.
 */
export function removeStoreItem(store: RemovableKeyValueStore, key: string): Promise<void> {
  if (!store.removeItem) throw new Error('This store cannot remove items.');
  return store.removeItem(scopedStoreKey(key));
}

/**
 * The app's keys present in a store that can list its keys (AsyncStorage's
 * getAllKeys), in the order the store returns them. Not used by the app yet;
 * Stage 2 needs it to find and wipe a profile's records.
 */
export async function listStoreKeys(store: { getAllKeys(): Promise<readonly string[]> }): Promise<string[]> {
  return (await store.getAllKeys()).filter((k) => k.startsWith(STORE_KEY_ROOT));
}

/** backend.getItemAsync for a declared secure-store key. */
export function readSecureItem(
  backend: SecureStoreBackend,
  key: string,
  options: SecureStoreItemOptions,
): Promise<string | null> {
  return backend.getItemAsync(scopedStoreKey(key), options);
}

/** backend.setItemAsync for a declared secure-store key. */
export function writeSecureItem(
  backend: SecureStoreBackend,
  key: string,
  value: string,
  options: SecureStoreItemOptions,
): Promise<void> {
  return backend.setItemAsync(scopedStoreKey(key), value, options);
}

/** backend.deleteItemAsync for a declared secure-store key. */
export function deleteSecureItem(
  backend: SecureStoreBackend,
  key: string,
  options: SecureStoreItemOptions,
): Promise<void> {
  return backend.deleteItemAsync(scopedStoreKey(key), options);
}

/**
 * The app's default store, loaded only on first use (for modules that do not
 * want AsyncStorage evaluated at import time, e.g. the notification
 * controller). Same calls as the store itself, so access still goes through
 * readStoreItem / writeStoreItem.
 */
export function lazyAppStore(): KeyValueStore {
  let storePromise: Promise<KeyValueStore> | null = null;
  const store = (): Promise<KeyValueStore> => {
    if (!storePromise) storePromise = import('@react-native-async-storage/async-storage').then((m) => m.default);
    return storePromise;
  };
  return {
    getItem: async (k) => (await store()).getItem(k),
    setItem: async (k, v) => (await store()).setItem(k, v),
  };
}

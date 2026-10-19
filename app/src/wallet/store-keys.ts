// The storage seam (duress wallet, Stage 1: docs/DURESS_WALLET.md section
// 5.2). Every "shiba-wallet." storage key the app uses is declared here, and
// every read, write, delete and listing of such a key goes through the
// functions below. scripts/check-storage-seam.mjs fails on any key literal,
// any AsyncStorage or expo-secure-store call, and any getItem / setItem /
// removeItem call outside this module; its allow-list is empty since every
// remaining caller moved here (phase 21). The one exception it pins is
// WalletContext.tsx's value import of expo-secure-store, which binds the
// native module once and calls nothing.
//
// Why a seam: a decoy wallet (feature 53) must never show the real wallet's
// records. The primary profile's keys resolve to themselves (scopedStoreKey
// is the identity for the primary profile, pinned by the check). Since
// Stage 2 a second profile (the decoy of a duress PIN, wallet/duress.ts) has
// its own copy of every per-wallet record: the active profile (memory only)
// scopes every key, without touching any caller.
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
   * addresses (device settings) together with recovered accounts and
   * EIP-7702 owners (per wallet). Declared 'wallet' so a decoy never sees
   * the real wallet's accounts. The endpoint fields are shared by every
   * wallet on the phone all the same: aa.ts reads and writes them through
   * the PRIMARY profile's copy of this record whichever profile is active
   * (aa.ts AA_ENDPOINT_FIELDS), so the decoy shows the same bundler row as
   * the real wallet, and keeps only its own account links under its prefix.
   */
  aaConfig: declare('shiba-wallet.aa-config.v1', 'wallet'),
  priceAlerts: declare('shiba-wallet.price-alerts.v1', 'wallet'),
  /** Reminder bookkeeping (seen takeover hashes, the "may have scheduled" flag). */
  notifications: declare('shiba-wallet.notifications.v1', 'wallet'),
  /**
   * Bridge transfers sent from the Bridge screen (wallet/bridge.ts): what
   * was sent, by which provider, and the last final status, so tracking
   * survives a restart. Public data only (hashes, addresses, amounts).
   */
  bridgeTransfers: declare('shiba-wallet.bridge-transfers.v1', 'wallet'),
  /**
   * The notifications inbox (wallet/inbox.ts, phase 22 item 5): what the
   * wallet has told the user (reminders, alerts, sent transactions), as
   * the sentences shown at the time plus 16-hex tags. Per wallet, so a
   * decoy keeps its own list. Secret-free (no key, no PIN, no long hex).
   */
  inbox: declare('shiba-wallet.inbox.v1', 'wallet'),

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
  /**
   * The app language (Settings → Language, phase 22 item 6; i18n/
   * language-store.ts): 'system', 'en' or 'es'. Device-wide on purpose, so
   * every wallet profile opens in the same language.
   */
  language: declare('shiba-wallet.language.v1', 'device'),

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
  /**
   * The app-lock PIN record (duress wallet Stage 2, wallet/pin.ts): one
   * fixed-shape record holding the primary and the duress PIN slots and the
   * wrong-PIN counter. Declared 'secret' (it lives in the secure store), but
   * it belongs to the DEVICE, not to one wallet: it must be read before any
   * profile is chosen and must be the same record whichever PIN is typed,
   * so wallet/pin.ts always addresses it through a store bound to the
   * PRIMARY profile (profileBoundSecureBackend), never the active one. A
   * neutral name ("app-lock"), so a listing of key names does not say
   * "duress".
   */
  appLock: declare('shiba-wallet.app-lock.v1', 'secret', 'exact', 'secure-store'),
});

/**
 * The keychain service of the protected secure-store copies (a separate
 * Keystore key / Keychain service, so the standard and protected copies can
 * never collide). A service name, not a key.
 */
export const PROTECTED_SECURE_STORE_SERVICE = 'shiba-wallet.protected';

/**
 * Identifiers of local notifications (expo-notifications), not storage keys.
 * Declared here so that every "shiba-wallet." name lives in one place. They
 * are per wallet (a reminder names a record of this wallet): the PRIMARY
 * profile's identifiers are these names unchanged, and another profile's
 * carry its prefix (notificationIdNames below), so a decoy session plans,
 * schedules and cancels only its own reminders (docs/DURESS_WALLET.md
 * section 5.2). Every identifier of every profile still starts with `root`,
 * the one prefix the wallet ever cancels by (turning reminders off, a wipe).
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
 * Whose records a key addresses. The primary profile's keys are the names
 * above unchanged (no migration). Stage 2 (the duress PIN, wallet/duress.ts)
 * adds a second profile for the decoy wallet; which one is active is
 * decided by the PIN pad before any wallet data is loaded (see the active
 * profile below).
 */
export interface StoreProfile {
  readonly id: string;
  /** null for the primary profile; otherwise 1–16 lower-case letters or digits. */
  readonly keyPrefix: string | null;
}

export const PRIMARY_STORE_PROFILE: StoreProfile = Object.freeze({ id: 'primary', keyPrefix: null });

/** The reserved segment a non-primary profile's keys carry (no declared key uses it). */
export const PROFILE_KEY_SEGMENT = 'profile-';

const PROFILE_PREFIX = /^[a-z0-9]{1,16}$/;

function assertProfile(profile: StoreProfile): StoreProfile {
  if (profile.keyPrefix !== null && !PROFILE_PREFIX.test(profile.keyPrefix)) {
    throw new Error('A storage profile prefix is 1 to 16 lower-case letters or digits.');
  }
  return profile;
}

/*
 * THE ACTIVE PROFILE (duress wallet Stage 2; docs/DURESS_WALLET.md sections
 * 5.2 and 7.7 item 2). Every key a caller reads or writes through this
 * module is scoped by the active profile unless the store it passes is bound
 * to a profile (profileBoundStore / profileBoundSecureBackend). The active
 * profile is held in MEMORY ONLY: it is never written to any store (the
 * check-duress suite scans for that), so nothing on the phone records which
 * wallet was opened last. It starts as the primary profile at every launch;
 * WalletContext changes it only after the app PIN pad decided which wallet
 * the typed PIN opens (wallet/duress.ts), before it loads anything, and
 * resets it to the primary profile when the wallet is removed.
 */
let activeProfile: StoreProfile = PRIMARY_STORE_PROFILE;

/** The profile every unbound read and write uses now. */
export function activeStoreProfile(): StoreProfile {
  return activeProfile;
}

/**
 * Makes `profile` the active one (memory only). Only WalletContext calls it,
 * from the PIN unlock and the wipe; a malformed prefix is refused.
 */
export function setActiveStoreProfile(profile: StoreProfile): void {
  assertProfile(profile);
  activeProfile = profile.keyPrefix === null ? PRIMARY_STORE_PROFILE : Object.freeze({ ...profile });
}

/**
 * The key actually used in the store for `key` under `profile` (the active
 * profile when omitted).
 *
 * Primary profile: the key unchanged, for every scope.
 * Another profile: 'device' keys unchanged (shared settings); 'wallet' and
 * 'secret' keys become shiba-wallet.profile-<prefix>.<rest of the key>, a
 * name no declared key can have, so the two profiles can never read each
 * other's records. Throws for an undeclared key in either case.
 */
export function scopedStoreKey(key: string, profile: StoreProfile = activeProfile): string {
  const scope = storeKeyScope(key);
  if (profile.keyPrefix === null || scope === 'device') return key;
  assertProfile(profile);
  return `${STORE_KEY_ROOT}${PROFILE_KEY_SEGMENT}${profile.keyPrefix}.${key.slice(STORE_KEY_ROOT.length)}`;
}

/**
 * The inverse of scopedStoreKey for a name found in a store (a listing):
 * which profile prefix it carries (null = the primary profile) and the
 * declared key it stands for. null for a name that is not one of the app's
 * keys under any profile.
 */
export function parseStoredKeyName(raw: string): { keyPrefix: string | null; key: string } | null {
  if (!raw.startsWith(STORE_KEY_ROOT)) return null;
  const rest = raw.slice(STORE_KEY_ROOT.length);
  let keyPrefix: string | null = null;
  let key = raw;
  if (rest.startsWith(PROFILE_KEY_SEGMENT)) {
    const dot = rest.indexOf('.', PROFILE_KEY_SEGMENT.length);
    if (dot < 0) return null;
    keyPrefix = rest.slice(PROFILE_KEY_SEGMENT.length, dot);
    if (!PROFILE_PREFIX.test(keyPrefix)) return null;
    key = `${STORE_KEY_ROOT}${rest.slice(dot + 1)}`;
  }
  try {
    const scope = storeKeyScope(key);
    // A device key never carries a prefix, and a prefixed name must be one
    // scopedStoreKey would produce.
    if (keyPrefix !== null && scope === 'device') return null;
  } catch {
    return null;
  }
  return { keyPrefix, key };
}

/** A store or backend that carries its own profile (see profileBoundStore). */
interface ProfileBound {
  readonly storeProfile?: StoreProfile;
}

function profileOf(target: object): StoreProfile {
  return (target as ProfileBound).storeProfile ?? activeProfile;
}

/**
 * The profile a store's keys are scoped by: its own when it is bound
 * (profileBoundStore), else the active one. Lets a store module tell
 * whether it is reading the primary wallet's records.
 */
export function storeProfileOf(target: object): StoreProfile {
  return profileOf(target);
}

/**
 * The local-notification identifier names of `profile` (the active one when
 * omitted): NOTIFICATION_ID_NAMES unchanged for the primary profile; for
 * another profile every kind gains the profile's segment after the root
 * (e.g. shiba-wallet.profile-w2.recurring.), so the two wallets' reminders
 * never share an identifier and neither planner ever touches the other's.
 */
export function notificationIdNames(profile: StoreProfile = activeProfile): Readonly<Record<keyof typeof NOTIFICATION_ID_NAMES, string>> {
  if (profile.keyPrefix === null) return NOTIFICATION_ID_NAMES;
  assertProfile(profile);
  const root = `${STORE_KEY_ROOT}${PROFILE_KEY_SEGMENT}${profile.keyPrefix}.`;
  const kind = (name: string) => `${root}${name.slice(NOTIFICATION_ID_NAMES.root.length)}`;
  return Object.freeze({
    root,
    recurring: kind(NOTIFICATION_ID_NAMES.recurring),
    takeover: kind(NOTIFICATION_ID_NAMES.takeover),
    priceAlert: kind(NOTIFICATION_ID_NAMES.priceAlert),
  });
}

/**
 * A view of `store` whose every key, through the functions below, is scoped
 * by `profile` whatever the active profile is. Used to set up and remove the
 * second wallet from the first, and to address the device's PIN record.
 * Its methods call the store's own methods (as methods of the store).
 */
export function profileBoundStore<S extends KeyValueStore>(store: S, profile: StoreProfile): KeyValueStore & RemovableKeyValueStore & ProfileBound {
  const bound: KeyValueStore & RemovableKeyValueStore & ProfileBound = {
    storeProfile: Object.freeze({ ...assertProfile(profile) }),
    getItem: (k) => store.getItem(k),
    setItem: (k, v) => store.setItem(k, v),
  };
  const removable = store as RemovableKeyValueStore;
  if (removable.removeItem) bound.removeItem = (k) => removable.removeItem!(k);
  return bound;
}

/** The secure-store counterpart of profileBoundStore. */
export function profileBoundSecureBackend(backend: SecureStoreBackend, profile: StoreProfile): SecureStoreBackend & ProfileBound {
  return {
    storeProfile: Object.freeze({ ...assertProfile(profile) }),
    getItemAsync: (k, o) => backend.getItemAsync(k, o),
    setItemAsync: (k, v, o) => backend.setItemAsync(k, v, o),
    deleteItemAsync: (k, o) => backend.deleteItemAsync(k, o),
    canUseBiometricAuthentication: () => backend.canUseBiometricAuthentication(),
    whenUnlockedThisDeviceOnly: backend.whenUnlockedThisDeviceOnly,
  };
}

// ---------------------------------------------------------------------------
// Access (the only functions that read, write, delete or list keys)
// ---------------------------------------------------------------------------

/** store.getItem for a declared key. */
export function readStoreItem(store: KeyValueStore, key: string): Promise<string | null> {
  return store.getItem(scopedStoreKey(key, profileOf(store)));
}

/** store.setItem for a declared key. The value is written exactly as given. */
export function writeStoreItem(store: KeyValueStore, key: string, value: string): Promise<void> {
  return store.setItem(scopedStoreKey(key, profileOf(store)), value);
}

/**
 * store.removeItem for a declared key. Callers check `store.removeItem`
 * first (a store without it keeps its old fallback of writing an empty
 * value), so the throw below is unreachable from the app's code.
 */
export function removeStoreItem(store: RemovableKeyValueStore, key: string): Promise<void> {
  if (!store.removeItem) throw new Error('This store cannot remove items.');
  return store.removeItem(scopedStoreKey(key, profileOf(store)));
}

/**
 * The app's keys present in a store that can list its keys (AsyncStorage's
 * getAllKeys), in the order the store returns them, as stored (with any
 * profile prefix; parseStoredKeyName reads them). Used by the wipe of a
 * wallet that has an app PIN, which removes both profiles' records.
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
  return backend.getItemAsync(scopedStoreKey(key, profileOf(backend)), options);
}

/** backend.setItemAsync for a declared secure-store key. */
export function writeSecureItem(
  backend: SecureStoreBackend,
  key: string,
  value: string,
  options: SecureStoreItemOptions,
): Promise<void> {
  return backend.setItemAsync(scopedStoreKey(key, profileOf(backend)), value, options);
}

/** backend.deleteItemAsync for a declared secure-store key. */
export function deleteSecureItem(
  backend: SecureStoreBackend,
  key: string,
  options: SecureStoreItemOptions,
): Promise<void> {
  return backend.deleteItemAsync(scopedStoreKey(key, profileOf(backend)), options);
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

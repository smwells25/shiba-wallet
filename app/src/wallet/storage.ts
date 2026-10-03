// Type-only import: this module must load under Node's type stripping
// (scripts/check-storage.mjs drives it with an injected fake), and the real
// expo-secure-store package cannot be evaluated outside React Native. The
// native module is handed in once by WalletContext.tsx (bindSecureStore).
import type * as ExpoSecureStore from 'expo-secure-store';
import { isValidMnemonic } from '@shiba-wallet/core';

/**
 * NON-CUSTODIAL INVARIANT — the single most important property of this
 * wallet. The BIP-39 mnemonic is the root of every key on every chain, and
 * it lives ONLY in expo-secure-store: the iOS Keychain on iOS, and on
 * Android an AES-256-GCM ciphertext in a private SharedPreferences file
 * whose key lives in the Android Keystore.
 *
 *   - It is never written to AsyncStorage or any other plain storage.
 *   - It is never logged (no console.log of mnemonics or seeds anywhere).
 *   - It is never sent over the network to anyone, including us.
 *
 * Every read and write of the mnemonic in the app goes through this module
 * so the invariant is enforceable in one place. If you find yourself
 * importing expo-secure-store anywhere else to touch key material, stop and
 * route it through here instead. (WalletContext.tsx imports the package
 * only to hand the native module to bindSecureStore below.)
 *
 * ---------------------------------------------------------------------------
 * Two storage classes for the phrase (threat-model finding N-01)
 * ---------------------------------------------------------------------------
 *
 * STANDARD: expo-secure-store with keychainAccessible
 * WHEN_UNLOCKED_THIS_DEVICE_ONLY and no requireAuthentication. Encrypted at
 * rest and never migrated by OS backups, but any code running in the app
 * process can read it while the phone is unlocked, without any prompt.
 * This is what every install used before this change.
 *
 * PROTECTED: the same package with requireAuthentication: true. What that
 * does, from the installed expo-secure-store 57.0.4 sources and the SDK 57
 * docs (docs.expo.dev/versions/v57.0.0/sdk/securestore):
 *
 *  Android (android/.../AESEncryptor.kt, AuthenticationHelper.kt,
 *  AuthenticationPrompt.kt, SecureStoreModule.kt): the value is encrypted
 *  with an AES-256-GCM Keystore key generated with
 *  setUserAuthenticationRequired(true) and no validity duration, i.e. the
 *  key may be used only through a BiometricPrompt CryptoObject, once per
 *  operation. Writes AND reads each show the system biometric prompt. The
 *  prompt accepts BIOMETRIC_STRONG (class 3) biometrics only and its
 *  negative button is "Cancel": there is NO PIN/password fallback.
 *  canUseBiometricAuthentication() is BiometricManager.canAuthenticate(
 *  BIOMETRIC_STRONG) == success, so a phone with no enrolled strong
 *  biometric (or only a "weak" face unlock) cannot use protected storage.
 *
 *  iOS (ios/SecureStoreModule.swift): the item gets a SecAccessControl with
 *  .biometryCurrentSet and the chosen accessibility class. Reading an
 *  existing item shows Face ID / Touch ID; creating a NEW item does not
 *  prompt (the docs: "the user is prompted to authenticate only when
 *  reading or updating an existing value"). The write throws unless the
 *  app's Info.plist has NSFaceIDUsageDescription; the expo-secure-store
 *  config plugin (already listed in app.json) writes a default one for
 *  development and store builds, but Expo Go on iOS lacks it (docs: "not
 *  supported in Expo Go when biometric authentication is available due to
 *  a missing NSFaceIDUsageDescription key") — such a write fails and the
 *  phrase stays in standard storage.
 *
 *  Both platforms: the protected copy is IRREVERSIBLY INVALIDATED when the
 *  enrolled biometrics change. Android KeyGenParameterSpec.Builder
 *  setInvalidatedByBiometricEnrollment (default true for per-use biometric
 *  keys): "irreversibly invalidated when a new biometric is enrolled, or
 *  when all existing biometrics are deleted", and setUserAuthenticationRequired:
 *  also "once the secure lock screen is disabled ... or forcibly reset".
 *  Apple, biometryCurrentSet: "The item is invalidated if fingers are added
 *  or removed for Touch ID, or if the user re-enrolls for Face ID."
 *  After that this phone can never read the phrase again; the user must
 *  restore from the written backup. THIS IS THE PRICE OF PROTECTED STORAGE,
 *  and it is why the protection policy below is a single, visible switch.
 *
 * What protected storage buys: the phrase cannot be decrypted without a
 * fresh biometric match, so code running in the app process (an injected
 * library, a compromised dependency) or an attacker with the app's files
 * cannot read it silently; every read raises a system prompt the user did
 * not ask for. What it does not buy: protection once the user approves a
 * prompt for a malicious request, or against a compromised OS.
 *
 * Emulators: the docs warn that "emulators/simulators do not require
 * biometric authentication when retrieving secrets". On Android the
 * module still shows the prompt for protected items (it decides from the
 * item's own requireAuthentication flag), but the emulator's Keystore is
 * software-only, so emulator runs prove the flow, not hardware enforcement.
 *
 * ---------------------------------------------------------------------------
 * Layout in secure storage
 * ---------------------------------------------------------------------------
 *
 *  shiba-wallet.mnemonic.v1        standard copy (default keychain service)
 *  shiba-wallet.mnemonic.v2        protected copy, keychain service
 *                                  "shiba-wallet.protected" (a separate
 *                                  Keystore key / Keychain service, so the
 *                                  two copies can never collide)
 *  shiba-wallet.vault-meta.v1      standard: where the phrase lives and the
 *                                  outcome of the last protection attempt
 *  shiba-wallet.public-account.v1.N standard: account N's public addresses
 *                                  and paths, so launching the app does not
 *                                  have to open the phrase (and raise a
 *                                  prompt) just to draw the Home screen
 *
 * The meta entry is needed because the existence of a protected item
 * cannot be tested without a prompt on either platform.
 */

// ---------------------------------------------------------------------------
// Backend (the native module, or a test fake)
// ---------------------------------------------------------------------------

export interface SecureStoreItemOptions {
  keychainService?: string;
  requireAuthentication?: boolean;
  authenticationPrompt?: string;
  keychainAccessible?: number;
}

/** The subset of expo-secure-store this module uses. */
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
export function nativeSecureStoreBackend(mod: typeof ExpoSecureStore): SecureStoreBackend {
  return {
    getItemAsync: (key, options) => mod.getItemAsync(key, options),
    setItemAsync: (key, value, options) => mod.setItemAsync(key, value, options),
    deleteItemAsync: (key, options) => mod.deleteItemAsync(key, options),
    canUseBiometricAuthentication: () => mod.canUseBiometricAuthentication(),
    whenUnlockedThisDeviceOnly: mod.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
}

// ---------------------------------------------------------------------------
// Constants and policy
// ---------------------------------------------------------------------------

export const MNEMONIC_KEY = 'shiba-wallet.mnemonic.v1';
export const PROTECTED_MNEMONIC_KEY = 'shiba-wallet.mnemonic.v2';
export const PROTECTED_KEYCHAIN_SERVICE = 'shiba-wallet.protected';
export const VAULT_META_KEY = 'shiba-wallet.vault-meta.v1';
export const PUBLIC_ACCOUNT_KEY_PREFIX = 'shiba-wallet.public-account.v1.';
const SESSION_KEY_PREFIX = 'shiba-wallet.session-key.v1.';
const PROTECTED_SESSION_KEY_PREFIX = 'shiba-wallet.session-key.v2.';

/**
 * How the phrase is protected:
 *  - 'automatic': move it into protected storage whenever the device can
 *    (right after a wallet is created or imported, and for existing
 *    installs at the next biometric approval);
 *  - 'opt-in': only when upgradePhraseProtection() is called (a Settings
 *    button);
 *  - 'off': never (an already protected phrase stays readable).
 *
 * DECISION (Chairperson, 2026-10-02): 'opt-in' — users are not forced into
 * biometrics; protection is a choice made from Settings.
 * The invalidation rule above means that adding a fingerprint or resetting
 * Face ID makes this phone unable to open an automatically protected phrase,
 * and the user must restore from the written backup. Moving every existing
 * install's phrase silently into that regime is too surprising, so the move
 * is a user choice made from Settings, where the trade-off is explained.
 * 'automatic' remains available for a build that wants it.
 */
export type PhraseProtectionPolicy = 'automatic' | 'opt-in' | 'off';
export const PHRASE_PROTECTION_POLICY: PhraseProtectionPolicy = 'opt-in';

/**
 * How long a phrase opened by the approval prompt (openPhraseForApproval)
 * stays available to the signing call that follows it. Single use. Long
 * enough for "approve → sign" on a slow network, short enough that an
 * unused copy does not linger; an expired copy only costs a second prompt.
 */
export const PHRASE_TICKET_TTL_MS = 30_000;

export const PROMPTS = {
  protectWrite: 'Protect your recovery phrase with biometrics',
  protectCheckNewWallet: 'Confirm your protected recovery phrase',
  signFallback: 'Approve signing with your recovery phrase',
  sessionKeyWrite: 'Protect the new session key with biometrics',
  sessionKeyRead: 'Use the session key',
  checkExisting: 'Check the wallet already stored on this phone',
} as const;

// ---------------------------------------------------------------------------
// Errors and status
// ---------------------------------------------------------------------------

export type PhraseAccessFailure = 'cancelled' | 'unreadable' | 'failed';

export const PHRASE_UNREADABLE_MESSAGE =
  'This phone can no longer open your recovery phrase. Its biometric protection was reset ' +
  '(for example, a fingerprint or face was added or removed, or the screen lock was turned off), ' +
  'and the system deletes protected keys when that happens. Nothing was signed and your funds are ' +
  'untouched on-chain. To keep using this wallet here, remove it in Settings and import your ' +
  'written recovery phrase again.';

export const OTHER_WALLET_STORED_MESSAGE =
  'Another wallet’s recovery phrase is still stored on this phone, so it was not replaced. ' +
  'Restart the app to open that wallet; to replace it, remove it in Settings first (after ' +
  'checking that its recovery phrase is written down).';

/** Thrown when the phrase exists but could not be opened. */
export class PhraseAccessError extends Error {
  reason: PhraseAccessFailure;
  // No TS parameter properties: Node's strip-only type stripping rejects them.
  constructor(reason: PhraseAccessFailure, message: string) {
    super(message);
    this.reason = reason;
    this.name = 'PhraseAccessError';
  }
}

/** Why the phrase is in standard storage. */
export type StandardStorageReason =
  /** canUseBiometricAuthentication() is false: no strong biometric enrolled (or no hardware). */
  | 'no-strong-biometrics'
  /** Eligible, but no attempt has run yet (policy 'opt-in', or before the first approval). */
  | 'not-attempted'
  /** The user cancelled a protection prompt; offered again at the next approval after a restart. */
  | 'cancelled'
  /** The platform refused the protected write (e.g. Expo Go on iOS, Keystore error). */
  | 'platform-refused'
  /** The protected copy did not read back identical; it was discarded. */
  | 'verify-failed'
  /** The protected copy became unreadable while the standard copy still existed; the wallet fell back to it. */
  | 'reverted'
  | 'policy-off';

export interface StorageProtection {
  /**
   * 'protected' — only the biometric-bound copy exists;
   * 'standard'  — the phrase is in standard storage (see reason);
   * 'unreadable' — the protected copy exists in name but the system can no
   *   longer open it (biometrics changed): restore from the written backup;
   * 'none' — no wallet on this phone.
   */
  phrase: 'none' | 'standard' | 'protected' | 'unreadable';
  /** Set when phrase === 'standard'. */
  reason: StandardStorageReason | null;
  /** The platform's error text from the last failed attempt, verbatim, or null. */
  detail: string | null;
  /** True when the device can hold protected items right now (strong biometrics enrolled). */
  biometricsAvailable: boolean;
  /** When the phrase moved into protected storage (ms since epoch), or null. */
  protectedSince: number | null;
  /** True while a standard copy still sits next to the protected one (migration not finished). */
  standardCopyPresent: boolean;
  /** Where a NEWLY created session key would be stored. */
  sessionKeys: 'standard' | 'protected';
  policy: PhraseProtectionPolicy;
  /** True when upgradePhraseProtection() would attempt a move now. */
  canProtectNow: boolean;
}

export type UpgradeOutcome =
  | 'protected'
  | 'already-protected'
  | 'no-wallet'
  | 'no-strong-biometrics'
  | 'policy-off'
  | 'cancelled'
  | 'platform-refused'
  | 'verify-failed'
  | 'failed'
  /** An automatic attempt already ran (and did not succeed) since the app started. */
  | 'skipped';

export interface UpgradeResult {
  outcome: UpgradeOutcome;
  /** Platform error text, verbatim, when a step failed. */
  detail: string | null;
}

/** Result of the approval gate (biometric.ts requireLocalAuth). */
export type ApprovalGateResult =
  /** The system prompt for the protected phrase succeeded; the phrase is held for the next signing call. */
  | { kind: 'authenticated' }
  /** The user cancelled the system prompt. */
  | { kind: 'cancelled' }
  /** No protected phrase to open (or it could not be opened): use the app-level prompt instead. */
  | { kind: 'fallback'; detail: string | null };

// ---------------------------------------------------------------------------
// Meta record
// ---------------------------------------------------------------------------

interface AttemptRecord {
  at: number;
  outcome: UpgradeOutcome | 'reverted';
  detail: string | null;
}

interface VaultMeta {
  v: 1;
  phrase: 'standard' | 'protected';
  protectedSince: number | null;
  attempt: AttemptRecord | null;
  unreadableSince: number | null;
}

const UPGRADE_OUTCOMES: readonly string[] = [
  'protected',
  'already-protected',
  'no-wallet',
  'no-strong-biometrics',
  'policy-off',
  'cancelled',
  'platform-refused',
  'verify-failed',
  'failed',
  'reverted',
];

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Strict parse; 'corrupt' for anything that is not a well-formed record. */
export function parseVaultMeta(raw: string | null): VaultMeta | null | 'corrupt' {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return 'corrupt';
  }
  if (typeof v !== 'object' || v === null) return 'corrupt';
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || (o.phrase !== 'standard' && o.phrase !== 'protected')) return 'corrupt';
  let attempt: AttemptRecord | null = null;
  if (o.attempt !== null && o.attempt !== undefined) {
    const a = o.attempt as Record<string, unknown>;
    if (
      typeof a !== 'object' ||
      typeof a.outcome !== 'string' ||
      !UPGRADE_OUTCOMES.includes(a.outcome) ||
      numOrNull(a.at) === null
    ) {
      return 'corrupt';
    }
    attempt = {
      at: a.at as number,
      outcome: a.outcome as AttemptRecord['outcome'],
      detail: typeof a.detail === 'string' ? a.detail : null,
    };
  }
  return {
    v: 1,
    phrase: o.phrase,
    protectedSince: numOrNull(o.protectedSince),
    attempt,
    unreadableSince: numOrNull(o.unreadableSince),
  };
}

// ---------------------------------------------------------------------------
// Public account cache entries
// ---------------------------------------------------------------------------

/** Account N's public data on one chain (no key material). */
export interface PublicChainEntry {
  chainId: string;
  address: string;
  path: string;
}

const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const PATH = /^m(\/[0-9]+'?){1,8}$/;
const MAX_CACHED_INDEX = 0x7fffffff;

function validEntries(v: unknown): PublicChainEntry[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 32) return null;
  const out: PublicChainEntry[] = [];
  for (const e of v) {
    if (typeof e !== 'object' || e === null) return null;
    const { chainId, address, path } = e as Record<string, unknown>;
    if (typeof chainId !== 'string' || !CAIP2.test(chainId)) return null;
    if (typeof address !== 'string' || address.length === 0 || address.length > 128) return null;
    if (!/^[0-9A-Za-z]+$/.test(address)) return null;
    if (typeof path !== 'string' || !PATH.test(path)) return null;
    out.push({ chainId, address, path });
  }
  return out;
}

function publicAccountKey(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > MAX_CACHED_INDEX) {
    throw new Error('Invalid account index');
  }
  return PUBLIC_ACCOUNT_KEY_PREFIX + index;
}

// ---------------------------------------------------------------------------
// Session-key ids
// ---------------------------------------------------------------------------

/**
 * ids come from sessions.ts sessionVaultId ("<chain decimal>.<account>.<permission id>");
 * the installed expo-secure-store 57.0.4 allows only alphanumerics, ".", "-"
 * and "_" in keys (SecureStore.d.ts), which the pattern below enforces.
 */
const SESSION_VAULT_ID = /^[0-9]+\.0x[0-9a-f]{40}\.[0-9a-f]{8}$/;

function checkSessionId(id: string): string {
  if (!SESSION_VAULT_ID.test(id)) throw new Error('Invalid session key id');
  return id;
}

// ---------------------------------------------------------------------------
// The vault
// ---------------------------------------------------------------------------

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'Unknown secure-storage error';
}

/**
 * Both platforms report a user cancel only through the error text:
 * Android AuthenticationPrompt.kt "User canceled the authentication"
 * (ERROR_USER_CANCELED and ERROR_NEGATIVE_BUTTON), iOS
 * SecureStoreExceptions.swift errSecUserCanceled "User canceled the
 * operation." Anything else (lockout, Keystore errors) is a failure.
 */
export function isCancellation(e: unknown): boolean {
  return /cancel/i.test(errorText(e));
}

export interface KeyVaultOptions {
  policy?: PhraseProtectionPolicy;
  now?: () => number;
  ticketTtlMs?: number;
}

export interface KeyVault {
  /** Where the phrase lives, without any prompt. */
  phraseLocation(): Promise<'none' | 'standard' | 'protected'>;
  /**
   * The phrase for one operation. Uses a phrase just opened by the approval
   * gate when one is held (single use), otherwise reads it — which shows the
   * system prompt `prompt` when the phrase is protected. null = no wallet.
   * Throws PhraseAccessError when a phrase exists but cannot be opened.
   */
  readPhrase(prompt: string): Promise<string | null>;
  /**
   * Stores a NEW wallet's phrase (create / import) in standard storage.
   * Callers then run upgrade() to move it into protected storage; doing it
   * in two steps means a failed or cancelled protection step can never lose
   * the phrase. Refuses (OTHER_WALLET_STORED_MESSAGE) to replace a
   * DIFFERENT valid phrase that is still readable: onboarding is reachable
   * only when no wallet was found, but a launch-time storage error can also
   * land there, and a new wallet must never silently overwrite the old one.
   * An unreadable (invalidated) protected copy, an invalid leftover, or the
   * same phrase again is replaced.
   */
  saveNewPhrase(phrase: string): Promise<void>;
  /** Moves the phrase into protected storage (the migration state machine). */
  upgrade(options?: { prompt?: string; checkPrompt?: string; holdForSigning?: boolean; automatic?: boolean }): Promise<UpgradeResult>;
  /** The approval gate (see ApprovalGateResult). */
  openPhraseForApproval(prompt: string): Promise<ApprovalGateResult>;
  /** Forgets a phrase held by the approval gate. */
  dropTicket(): void;
  /** Deletes every copy of the phrase and the meta record. */
  removePhrase(): Promise<void>;
  status(): Promise<StorageProtection>;
  savePublicAccount(index: number, entries: PublicChainEntry[]): Promise<void>;
  loadPublicAccount(index: number): Promise<PublicChainEntry[] | null>;
  deletePublicAccounts(indices: number[]): Promise<void>;
  sessionKeys: {
    save(id: string, privateKeyHex: string): Promise<void>;
    load(id: string): Promise<string | null>;
    remove(id: string): Promise<void>;
  };
}

export function createKeyVault(backend: SecureStoreBackend, options: KeyVaultOptions = {}): KeyVault {
  const policy = options.policy ?? PHRASE_PROTECTION_POLICY;
  const now = options.now ?? (() => Date.now());
  const ticketTtl = options.ticketTtlMs ?? PHRASE_TICKET_TTL_MS;

  const STANDARD: SecureStoreItemOptions = {
    keychainAccessible: backend.whenUnlockedThisDeviceOnly,
  };
  const protectedOptions = (prompt: string): SecureStoreItemOptions => ({
    keychainService: PROTECTED_KEYCHAIN_SERVICE,
    requireAuthentication: true,
    // Android shows this as the BiometricPrompt title; it must not be empty.
    authenticationPrompt: prompt.trim() === '' ? PROMPTS.signFallback : prompt,
    keychainAccessible: backend.whenUnlockedThisDeviceOnly,
  });
  const PROTECTED_NO_PROMPT: SecureStoreItemOptions = {
    keychainService: PROTECTED_KEYCHAIN_SERVICE,
    keychainAccessible: backend.whenUnlockedThisDeviceOnly,
  };

  // A phrase opened by the approval gate, for the signing call that follows.
  let ticket: { phrase: string; expiresAt: number } | null = null;
  // Automatic attempts that the user cancelled or the platform refused are
  // not repeated until the next app start (a new vault instance).
  let automaticAttemptDone = false;
  // Android refuses a second BiometricPrompt while one is open
  // ("Authentication is already in progress"), so every operation that can
  // prompt runs one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const canProtect = (): boolean => {
    try {
      return backend.canUseBiometricAuthentication() === true;
    } catch {
      return false;
    }
  };

  async function readMeta(): Promise<VaultMeta | null | 'corrupt'> {
    try {
      return parseVaultMeta(await backend.getItemAsync(VAULT_META_KEY, STANDARD));
    } catch {
      return 'corrupt';
    }
  }

  async function writeMeta(meta: VaultMeta): Promise<void> {
    await backend.setItemAsync(VAULT_META_KEY, JSON.stringify(meta), STANDARD);
  }

  async function patchMeta(patch: Partial<VaultMeta>): Promise<void> {
    const current = await readMeta();
    const base: VaultMeta =
      current && current !== 'corrupt'
        ? current
        : { v: 1, phrase: 'standard', protectedSince: null, attempt: null, unreadableSince: null };
    await writeMeta({ ...base, ...patch });
  }

  async function recordAttempt(outcome: AttemptRecord['outcome'], detail: string | null): Promise<void> {
    try {
      await patchMeta({ attempt: { at: now(), outcome, detail } });
    } catch {
      // Bookkeeping only; the phrase itself is unaffected.
    }
  }

  /**
   * Location from the meta record plus the standard copy (no prompt).
   * A corrupt meta record with no standard copy is treated as protected:
   * the safe direction, because a protected copy must never be mistaken for
   * "no wallet" and overwritten by a new one.
   */
  async function locate(): Promise<{
    location: 'none' | 'standard' | 'protected';
    standardCopy: string | null;
    meta: VaultMeta | null | 'corrupt';
  }> {
    const meta = await readMeta();
    const standardCopy = await backend.getItemAsync(MNEMONIC_KEY, STANDARD);
    if (meta && meta !== 'corrupt' && meta.phrase === 'protected') {
      return { location: 'protected', standardCopy, meta };
    }
    if (meta === 'corrupt') {
      return { location: standardCopy !== null ? 'standard' : 'protected', standardCopy, meta };
    }
    return { location: standardCopy !== null ? 'standard' : 'none', standardCopy, meta };
  }

  function takeTicket(): string | null {
    const t = ticket;
    ticket = null;
    if (!t || now() > t.expiresAt) return null;
    return t.phrase;
  }

  function holdTicket(phrase: string): void {
    ticket = { phrase, expiresAt: now() + ticketTtl };
  }

  /**
   * Opens the protected copy. Returns the phrase; on a null answer (the
   * system invalidated the key) falls back to a standard copy when one is
   * still present — making it the wallet's copy again — and otherwise
   * records the phrase as unreadable and throws.
   */
  async function openProtected(
    prompt: string,
    standardCopy: string | null,
  ): Promise<{ phrase: string; authenticated: boolean }> {
    let value: string | null;
    try {
      value = await backend.getItemAsync(PROTECTED_MNEMONIC_KEY, protectedOptions(prompt));
    } catch (e) {
      if (isCancellation(e)) {
        throw new PhraseAccessError('cancelled', 'Authentication cancelled. Nothing was signed.');
      }
      throw new PhraseAccessError(
        'failed',
        `Secure storage could not open your recovery phrase (${errorText(e)}). Nothing was signed.`,
      );
    }
    if (value === null) {
      if (standardCopy !== null) {
        // The migration had not finished deleting the standard copy, so it
        // is still the wallet's phrase: go back to standard storage.
        await patchMeta({ phrase: 'standard', protectedSince: null, unreadableSince: null }).catch(
          () => undefined,
        );
        await recordAttempt('reverted', 'The protected copy could no longer be opened.');
        // No system prompt was shown (the key was already invalid), so this
        // is NOT a user verification.
        return { phrase: standardCopy, authenticated: false };
      }
      await patchMeta({ unreadableSince: now() }).catch(() => undefined);
      throw new PhraseAccessError('unreadable', PHRASE_UNREADABLE_MESSAGE);
    }
    // A successful read clears an earlier "unreadable" mark.
    const meta = await readMeta();
    if (meta && meta !== 'corrupt' && meta.unreadableSince !== null) {
      await patchMeta({ unreadableSince: null }).catch(() => undefined);
    }
    if (standardCopy !== null) {
      if (standardCopy === value) {
        // Finishes an interrupted migration: the protected copy was just
        // read back with the same content, so the standard copy can go.
        await backend.deleteItemAsync(MNEMONIC_KEY, STANDARD).catch(() => undefined);
      }
      // A DIFFERENT standard copy is left alone: when in doubt, never delete.
    }
    return { phrase: value, authenticated: true };
  }

  async function readPhraseInner(prompt: string): Promise<string | null> {
    const held = takeTicket();
    if (held !== null) return held;
    const { location, standardCopy } = await locate();
    if (location === 'none') return null;
    if (location === 'standard') return standardCopy;
    return (await openProtected(prompt, standardCopy)).phrase;
  }

  /**
   * THE MIGRATION STATE MACHINE. Each step either completes or leaves the
   * standard copy untouched; the standard copy is deleted only after the
   * protected copy has been read back identical AND the meta record says
   * "protected". Failure at any step therefore leaves a readable phrase:
   *
   *   S0 locate: standard copy present? (else nothing to move)
   *   S1 eligibility: canUseBiometricAuthentication()
   *   S2 write protected copy        fail → delete partial protected copy, stop
   *   S3 read it back, compare       fail/mismatch → delete protected copy, stop
   *   S4 meta := protected           fail → delete protected copy, stop
   *   S5 delete standard copy        fail → retried at the next protected read
   *                                  (openProtected compares, then deletes)
   */
  async function upgradeInner(opts: {
    prompt?: string;
    checkPrompt?: string;
    holdForSigning?: boolean;
  }): Promise<UpgradeResult> {
    if (policy === 'off') return { outcome: 'policy-off', detail: null };
    const { location, standardCopy } = await locate();
    if (location === 'none' || standardCopy === null) {
      return { outcome: location === 'protected' ? 'already-protected' : 'no-wallet', detail: null };
    }
    if (location === 'protected') {
      // A standard copy left behind by an interrupted migration (S5). The
      // protected copy is never rewritten from it (it could, in a corner
      // case, be different); it is read back instead, and openProtected
      // deletes the standard copy only when both are identical.
      try {
        await openProtected(opts.checkPrompt ?? PROMPTS.protectCheckNewWallet, standardCopy);
        return { outcome: 'already-protected', detail: null };
      } catch (e) {
        const outcome: UpgradeOutcome = isCancellation(e) ? 'cancelled' : 'failed';
        return { outcome, detail: errorText(e) };
      }
    }
    // S1
    if (!canProtect()) {
      await recordAttempt('no-strong-biometrics', null);
      return { outcome: 'no-strong-biometrics', detail: null };
    }
    const phrase = standardCopy;
    const cleanUp = async () => {
      await backend.deleteItemAsync(PROTECTED_MNEMONIC_KEY, PROTECTED_NO_PROMPT).catch(() => undefined);
    };
    // S2
    try {
      await backend.setItemAsync(
        PROTECTED_MNEMONIC_KEY,
        phrase,
        protectedOptions(opts.prompt ?? PROMPTS.protectWrite),
      );
    } catch (e) {
      await cleanUp();
      const outcome: UpgradeOutcome = isCancellation(e) ? 'cancelled' : 'platform-refused';
      await recordAttempt(outcome, errorText(e));
      return { outcome, detail: errorText(e) };
    }
    // S3
    let readBack: string | null;
    try {
      readBack = await backend.getItemAsync(
        PROTECTED_MNEMONIC_KEY,
        protectedOptions(opts.checkPrompt ?? PROMPTS.protectCheckNewWallet),
      );
    } catch (e) {
      await cleanUp();
      const outcome: UpgradeOutcome = isCancellation(e) ? 'cancelled' : 'verify-failed';
      await recordAttempt(outcome, errorText(e));
      return { outcome, detail: errorText(e) };
    }
    if (readBack !== phrase) {
      await cleanUp();
      const detail =
        readBack === null
          ? 'The protected copy could not be read back.'
          : 'The protected copy read back different from the original.';
      await recordAttempt('verify-failed', detail);
      return { outcome: 'verify-failed', detail };
    }
    // S4
    try {
      await writeMeta({
        v: 1,
        phrase: 'protected',
        protectedSince: now(),
        attempt: { at: now(), outcome: 'protected', detail: null },
        unreadableSince: null,
      });
    } catch (e) {
      await cleanUp();
      await recordAttempt('failed', errorText(e));
      return { outcome: 'failed', detail: errorText(e) };
    }
    // S5
    await backend.deleteItemAsync(MNEMONIC_KEY, STANDARD).catch(() => undefined);
    if (opts.holdForSigning) holdTicket(phrase);
    return { outcome: 'protected', detail: null };
  }

  async function statusInner(): Promise<StorageProtection> {
    const { location, standardCopy, meta } = await locate();
    const m = meta && meta !== 'corrupt' ? meta : null;
    const biometricsAvailable = canProtect();
    const sessionKeys: 'standard' | 'protected' =
      location === 'protected' && biometricsAvailable ? 'protected' : 'standard';
    if (location === 'none') {
      return {
        phrase: 'none',
        reason: null,
        detail: null,
        biometricsAvailable,
        protectedSince: null,
        standardCopyPresent: false,
        sessionKeys,
        policy,
        canProtectNow: false,
      };
    }
    if (location === 'protected') {
      return {
        phrase: m?.unreadableSince ? 'unreadable' : 'protected',
        reason: null,
        detail: m?.unreadableSince ? PHRASE_UNREADABLE_MESSAGE : null,
        biometricsAvailable,
        protectedSince: m?.protectedSince ?? null,
        standardCopyPresent: standardCopy !== null,
        sessionKeys,
        policy,
        canProtectNow: false,
      };
    }
    let reason: StandardStorageReason;
    const last = m?.attempt ?? null;
    if (policy === 'off') reason = 'policy-off';
    else if (!biometricsAvailable) reason = 'no-strong-biometrics';
    else if (!last || last.outcome === 'no-strong-biometrics' || last.outcome === 'no-wallet') {
      reason = 'not-attempted';
    } else if (last.outcome === 'cancelled') reason = 'cancelled';
    else if (last.outcome === 'verify-failed') reason = 'verify-failed';
    else if (last.outcome === 'reverted') reason = 'reverted';
    else reason = 'platform-refused';
    return {
      phrase: 'standard',
      reason,
      detail: reason === 'not-attempted' || reason === 'no-strong-biometrics' ? null : (last?.detail ?? null),
      biometricsAvailable,
      protectedSince: null,
      standardCopyPresent: true,
      sessionKeys,
      policy,
      canProtectNow: policy !== 'off' && biometricsAvailable,
    };
  }

  const vault: KeyVault = {
    phraseLocation: () => serial(async () => (await locate()).location),

    readPhrase: (prompt) => serial(() => readPhraseInner(prompt)),

    saveNewPhrase: (phrase) =>
      serial(async () => {
        ticket = null;
        const { location, standardCopy } = await locate();
        if (location === 'standard' && standardCopy !== null && standardCopy !== phrase && isValidMnemonic(standardCopy)) {
          throw new Error(OTHER_WALLET_STORED_MESSAGE);
        }
        if (location === 'protected') {
          try {
            const opened = await openProtected(PROMPTS.checkExisting, standardCopy);
            if (opened.phrase !== phrase && isValidMnemonic(opened.phrase)) {
              throw new Error(OTHER_WALLET_STORED_MESSAGE);
            }
          } catch (e) {
            // Unreadable: there is nothing left to lose; replace it.
            if (!(e instanceof PhraseAccessError && e.reason === 'unreadable')) {
              if (e instanceof PhraseAccessError && e.reason === 'cancelled') {
                throw new Error('Authentication cancelled. Nothing was changed.');
              }
              throw e;
            }
          }
          ticket = null;
        }
        automaticAttemptDone = false;
        // A leftover protected copy belongs to a removed wallet (or is an
        // unreadable one); it must not shadow the new phrase.
        await backend.deleteItemAsync(PROTECTED_MNEMONIC_KEY, PROTECTED_NO_PROMPT).catch(() => undefined);
        await backend.setItemAsync(MNEMONIC_KEY, phrase, STANDARD);
        await writeMeta({ v: 1, phrase: 'standard', protectedSince: null, attempt: null, unreadableSince: null });
      }),

    upgrade: (opts = {}) =>
      serial(async () => {
        if (opts.automatic) {
          if (policy !== 'automatic') return { outcome: 'policy-off', detail: null } as UpgradeResult;
          if (automaticAttemptDone) return { outcome: 'skipped', detail: null } as UpgradeResult;
        }
        const result = await upgradeInner(opts);
        if (opts.automatic && (result.outcome === 'cancelled' || result.outcome === 'platform-refused' || result.outcome === 'verify-failed' || result.outcome === 'failed')) {
          automaticAttemptDone = true;
        }
        return result;
      }),

    openPhraseForApproval: (prompt) =>
      serial(async (): Promise<ApprovalGateResult> => {
        ticket = null;
        const { location, standardCopy } = await locate();
        if (location === 'protected') {
          try {
            const opened = await openProtected(prompt, standardCopy);
            if (!opened.authenticated) {
              // Fell back to the standard copy without any prompt.
              return { kind: 'fallback', detail: 'The protected copy could no longer be opened.' };
            }
            holdTicket(opened.phrase);
            return { kind: 'authenticated' };
          } catch (e) {
            if (e instanceof PhraseAccessError && e.reason === 'cancelled') return { kind: 'cancelled' };
            // Unreadable or failed: the app-level prompt still guards the
            // approval (e.g. the lock screen must stay unlockable); the
            // signing call will report the problem in plain words.
            return { kind: 'fallback', detail: errorText(e) };
          }
        }
        if (location === 'standard' && policy === 'automatic' && !automaticAttemptDone && canProtect()) {
          // Existing installs move at their first approval: the protection
          // prompts double as this approval's user verification.
          const result = await upgradeInner({
            prompt: PROMPTS.protectWrite,
            checkPrompt: prompt,
            holdForSigning: true,
          });
          if (result.outcome === 'protected') return { kind: 'authenticated' };
          if (
            result.outcome === 'cancelled' ||
            result.outcome === 'platform-refused' ||
            result.outcome === 'verify-failed' ||
            result.outcome === 'failed'
          ) {
            automaticAttemptDone = true;
          }
          // A cancelled PROTECTION prompt is not a cancelled approval: the
          // user is asked again with the ordinary prompt for what they
          // actually started.
          return { kind: 'fallback', detail: result.detail };
        }
        return { kind: 'fallback', detail: null };
      }),

    dropTicket: () => {
      ticket = null;
    },

    removePhrase: () =>
      serial(async () => {
        ticket = null;
        await backend.deleteItemAsync(PROTECTED_MNEMONIC_KEY, PROTECTED_NO_PROMPT);
        await backend.deleteItemAsync(MNEMONIC_KEY, STANDARD);
        // Meta last: if a delete above failed, the record still says where
        // the remaining copy is.
        await backend.deleteItemAsync(VAULT_META_KEY, STANDARD);
      }),

    status: () => serial(statusInner),

    savePublicAccount: async (index, entries) => {
      const valid = validEntries(entries);
      if (!valid) throw new Error('Invalid public account data');
      await backend.setItemAsync(publicAccountKey(index), JSON.stringify({ v: 1, index, chains: valid }), STANDARD);
    },

    loadPublicAccount: async (index) => {
      let raw: string | null;
      try {
        raw = await backend.getItemAsync(publicAccountKey(index), STANDARD);
      } catch {
        return null;
      }
      if (raw === null) return null;
      try {
        const v = JSON.parse(raw) as { v?: unknown; index?: unknown; chains?: unknown };
        if (v.v !== 1 || v.index !== index) return null;
        return validEntries(v.chains);
      } catch {
        return null;
      }
    },

    deletePublicAccounts: async (indices) => {
      for (const index of indices) {
        await backend.deleteItemAsync(publicAccountKey(index), STANDARD).catch(() => undefined);
      }
    },

    sessionKeys: {
      /**
       * Session private keys (see ./sessions.ts) are key material too. A
       * NEW key goes into protected storage when the phrase itself is
       * protected and the device can hold protected items; otherwise into
       * standard storage (as before). Keys created before this change stay
       * where they are until revoked or forgotten — every grant carries a
       * mandatory expiry, and moving each one would cost two extra prompts.
       * A user cancel of the protection prompt aborts the save (the install
       * then does not go ahead); a platform refusal falls back to standard
       * storage so a session can still be created.
       */
      save: (id, privateKeyHex) =>
        serial(async () => {
          checkSessionId(id);
          if (!/^0x[0-9a-f]{64}$/i.test(privateKeyHex)) throw new Error('A session key is 32 bytes of hex');
          const { location } = await locate();
          if (location === 'protected' && canProtect()) {
            try {
              await backend.setItemAsync(
                PROTECTED_SESSION_KEY_PREFIX + id,
                privateKeyHex,
                protectedOptions(PROMPTS.sessionKeyWrite),
              );
              await backend.deleteItemAsync(SESSION_KEY_PREFIX + id, STANDARD).catch(() => undefined);
              return;
            } catch (e) {
              await backend
                .deleteItemAsync(PROTECTED_SESSION_KEY_PREFIX + id, PROTECTED_NO_PROMPT)
                .catch(() => undefined);
              if (isCancellation(e)) throw new Error('Authentication cancelled. The session key was not created.');
            }
          }
          await backend.setItemAsync(SESSION_KEY_PREFIX + id, privateKeyHex, STANDARD);
        }),
      load: (id) =>
        serial(async () => {
          checkSessionId(id);
          const protectedKey = await backend.getItemAsync(
            PROTECTED_SESSION_KEY_PREFIX + id,
            protectedOptions(PROMPTS.sessionKeyRead),
          );
          if (protectedKey !== null) return protectedKey;
          return backend.getItemAsync(SESSION_KEY_PREFIX + id, STANDARD);
        }),
      remove: (id) =>
        serial(async () => {
          checkSessionId(id);
          await backend.deleteItemAsync(PROTECTED_SESSION_KEY_PREFIX + id, PROTECTED_NO_PROMPT);
          await backend.deleteItemAsync(SESSION_KEY_PREFIX + id, STANDARD);
        }),
    },
  };
  return vault;
}

// ---------------------------------------------------------------------------
// The app's single vault
// ---------------------------------------------------------------------------

let appVault: KeyVault | null = null;

/** Called once at startup (WalletContext.tsx) with the native module. */
export function bindSecureStore(backend: SecureStoreBackend, options: KeyVaultOptions = {}): void {
  appVault = createKeyVault(backend, options);
}

function vault(): KeyVault {
  if (!appVault) throw new Error('Secure storage is not initialised');
  return appVault;
}

export const phraseLocation = (): Promise<'none' | 'standard' | 'protected'> => vault().phraseLocation();
export const readPhrase = (prompt: string): Promise<string | null> => vault().readPhrase(prompt);
export const saveNewPhrase = (phrase: string): Promise<void> => vault().saveNewPhrase(phrase);
export const deleteMnemonic = (): Promise<void> => vault().removePhrase();
export const savePublicAccount = (index: number, entries: PublicChainEntry[]): Promise<void> =>
  vault().savePublicAccount(index, entries);
export const loadPublicAccount = (index: number): Promise<PublicChainEntry[] | null> =>
  vault().loadPublicAccount(index);
export const deletePublicAccounts = (indices: number[]): Promise<void> => vault().deletePublicAccounts(indices);

/** Drops a phrase held by the approval gate (e.g. when the app goes to the background). */
export function dropPhraseTicket(): void {
  appVault?.dropTicket();
}

/**
 * The approval gate used by biometric.ts requireLocalAuth: when the phrase
 * is protected, the system prompt that opens it IS the user verification,
 * and the opened phrase is held for the signing call that follows, so the
 * user sees one prompt per operation instead of two. When the vault is not
 * bound (never in the app) or nothing is protected, returns 'fallback'.
 */
export async function openPhraseForApproval(prompt: string): Promise<ApprovalGateResult> {
  if (!appVault) return { kind: 'fallback', detail: null };
  return appVault.openPhraseForApproval(prompt);
}

/**
 * For Settings: where the phrase is kept and why. Never throws; an
 * unexpected storage error reads as standard storage with the error text.
 */
export async function storageProtection(): Promise<StorageProtection> {
  try {
    return await vault().status();
  } catch (e) {
    return {
      phrase: 'standard',
      reason: 'platform-refused',
      detail: errorText(e),
      biometricsAvailable: false,
      protectedSince: null,
      standardCopyPresent: true,
      sessionKeys: 'standard',
      policy: PHRASE_PROTECTION_POLICY,
      canProtectNow: false,
    };
  }
}

/**
 * For a Settings "Protect with biometrics" button (and the 'opt-in'
 * policy): runs the migration now. Shows the system prompt (Android: twice
 * — the protected write and the read-back check; iOS: once, for the
 * read-back). Never loses the phrase; see the state machine above.
 */
export function upgradePhraseProtection(): Promise<UpgradeResult> {
  return vault().upgrade({ prompt: PROMPTS.protectWrite, checkPrompt: PROMPTS.protectCheckNewWallet });
}

/**
 * Policy 'automatic' only (otherwise a no-op): run right after a new wallet
 * is stored (WalletContext activate). Never throws; the outcome is recorded
 * for storageProtection().
 */
export async function upgradePhraseProtectionIfAutomatic(): Promise<UpgradeResult> {
  try {
    return await vault().upgrade({
      automatic: true,
      prompt: PROMPTS.protectWrite,
      checkPrompt: PROMPTS.protectCheckNewWallet,
    });
  } catch (e) {
    return { outcome: 'failed', detail: errorText(e) };
  }
}

/**
 * The session-key vault used by ./sessions.ts (interface unchanged: save /
 * load / remove by sessionVaultId). See the vault's sessionKeys comment for
 * where each key is stored.
 */
export const sessionKeyVault = {
  save: (id: string, privateKeyHex: string): Promise<void> => vault().sessionKeys.save(id, privateKeyHex),
  load: (id: string): Promise<string | null> => vault().sessionKeys.load(id),
  remove: (id: string): Promise<void> => vault().sessionKeys.remove(id),
};

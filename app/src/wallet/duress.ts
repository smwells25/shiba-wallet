/**
 * The duress PIN and its decoy wallet (feature 53; docs/DURESS_WALLET.md
 * sections 6 and 7, Stage 2). Free of React and React Native so
 * scripts/check-duress.mjs drives it under Node with fakes.
 *
 * THE DECOY. With an app PIN set (wallet/pin.ts), the real wallet can add a
 * second, duress PIN. That PIN opens a separate wallet — the decoy — whose
 * recovery phrase is the BIP-85 child at index 0 of the real phrase, with
 * the real phrase's word count and English words
 * (m/83696968'/39'/0'/{words}'/0'; packages/core/src/bip85.ts, checked
 * against BIP-85's official vectors). Consequences, stated on screen:
 *  - one written phrase backs up both: whoever holds the real phrase can
 *    always re-derive the decoy (the real phrase + index 0; nothing else is
 *    written down, and no index is stored on the phone);
 *  - the decoy's phrase cannot be turned back into the real one (BIP-85's
 *    HMAC-SHA512 step), so revealing the decoy's phrase under coercion gives
 *    away nothing of the real wallet.
 *
 * WHERE IT LIVES. The decoy's phrase and every record it makes are stored
 * under the second storage profile (DECOY_STORE_PROFILE): the storage seam
 * (store-keys.ts scopedStoreKey) moves its 'wallet' and 'secret' keys to
 * shiba-wallet.profile-w2.…, while 'device' keys (preferences, endpoints,
 * networks) are shared. Which profile is active is decided by the PIN typed
 * on the lock screen, before anything is loaded, and kept in memory only.
 *
 * THE HONEST CLAIM (section 4.3), on every screen that sets up or describes
 * the feature: someone looking at the screen sees an ordinary wallet;
 * anyone who copies the app's files can tell two wallets exist; funding the
 * decoy from the real wallet links them on-chain.
 */

import { bip85ChildMnemonic, mnemonicWordCount } from '@shiba-wallet/core';
import {
  PRIMARY_STORE_PROFILE,
  STORE_KEYS,
  listStoreKeys,
  parseStoredKeyName,
  profileBoundStore,
  removeStoreItem,
  setActiveStoreProfile,
  storeKeyScope,
  type RemovableKeyValueStore,
  type SecureStoreBackend,
  type StoreProfile,
} from './store-keys.ts';
import { deletePinRecord } from './pin.ts';

/** The decoy wallet's storage profile. A neutral prefix: key names are visible on Android. */
export const DECOY_STORE_PROFILE: StoreProfile = Object.freeze({ id: 'second', keyPrefix: 'w2' });

/** The BIP-85 child index of the decoy (fixed for every user; section 7.2). */
export const DECOY_BIP85_INDEX = 0;

/** The decoy's phrase: the BIP-85 child at index 0, with the parent's word count. */
export function deriveDecoyPhrase(realPhrase: string): string {
  const words = mnemonicWordCount(realPhrase);
  return bip85ChildMnemonic(realPhrase, DECOY_BIP85_INDEX, words);
}

/** The storage profile a PIN slot opens. */
export function profileForSlot(slot: 'primary' | 'duress'): StoreProfile {
  return slot === 'primary' ? PRIMARY_STORE_PROFILE : DECOY_STORE_PROFILE;
}

// ---------------------------------------------------------------------------
// Whether an app PIN is set (a device fact, shared by PrefsContext, the lock
// gate and WalletContext; memory only, read from the PIN record at launch).
// ---------------------------------------------------------------------------

type Listener = () => void;
let appPinOn: boolean | null = null;
const listeners = new Set<Listener>();

export const appPinPresence = {
  /** null until the record has been read at launch. */
  get(): boolean | null {
    return appPinOn;
  },
  set(on: boolean | null): void {
    if (appPinOn === on) return;
    appPinOn = on;
    for (const l of [...listeners]) l();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** The auto-lock a set app PIN uses when the stored choice is "off" (1 minute, the shortest choice). */
export const APP_PIN_DEFAULT_AUTO_LOCK_MS = 60_000;

/**
 * What the screens see (PrefsContext), given the stored preferences and
 * whether an app PIN is set: with a PIN, auto-lock is never off, screen
 * protection is on and notifications are off (section 7.4), whatever is
 * stored; the stored values are kept for when the PIN is turned off.
 */
export function effectivePrefs(
  prefs: { autoLockMs: number | null; screenProtection: boolean; notifications: boolean },
  appPinOn: boolean,
): { autoLockMs: number | null; screenProtection: boolean; notifications: boolean } {
  return {
    autoLockMs: appPinOn ? (prefs.autoLockMs ?? APP_PIN_DEFAULT_AUTO_LOCK_MS) : prefs.autoLockMs,
    screenProtection: appPinOn ? true : prefs.screenProtection,
    notifications: appPinOn ? false : prefs.notifications,
  };
}

// ---------------------------------------------------------------------------
// Set-up and removal of the decoy wallet
// ---------------------------------------------------------------------------

/** The part of a key vault (storage.ts KeyVault) the decoy set-up and the wipe use. */
export interface ProfileVault {
  phraseLocation(): Promise<'none' | 'standard' | 'protected'>;
  saveNewPhrase(phrase: string): Promise<void>;
  removePhrase(): Promise<void>;
  deletePublicAccounts(indices: number[]): Promise<void>;
  importedKeys: { removeAll(): Promise<void> };
  sessionKeys: { save(id: string, privateKeyHex: string): Promise<void>; load(id: string): Promise<string | null>; remove(id: string): Promise<void> };
}

/**
 * Stores the decoy's phrase in the decoy profile (standard secure storage,
 * like any newly created wallet; the user can protect it with biometrics
 * from Settings while the decoy is open). The vault refuses to replace a
 * DIFFERENT valid phrase, and the derivation is deterministic, so setting a
 * duress PIN again after removing it finds the same phrase. Returns the
 * word count only — never the phrase.
 */
export async function setUpDecoyWallet(realPhrase: string, decoyVault: ProfileVault): Promise<{ words: number }> {
  const decoy = deriveDecoyPhrase(realPhrase);
  await decoyVault.saveNewPhrase(decoy);
  return { words: decoy.split(' ').length };
}

/** Whether a decoy wallet exists (its phrase is stored in the decoy profile). No prompt. */
export async function decoyWalletExists(decoyVault: ProfileVault): Promise<boolean> {
  return (await decoyVault.phraseLocation()) !== 'none';
}

/** A store that can list and delete its keys (AsyncStorage). */
export interface SweepableStore extends RemovableKeyValueStore {
  getAllKeys(): Promise<readonly string[]>;
  removeItem(key: string): Promise<void>;
}

/**
 * Every per-wallet record in `store` (AsyncStorage), of every profile: the
 * names to delete when the wallet is removed. Device keys (preferences,
 * endpoints, networks the user added, API keys) are shared settings and are
 * kept, as the wipe always kept them.
 */
export async function walletRecordsToRemove(store: SweepableStore): Promise<{ keyPrefix: string | null; key: string }[]> {
  const out: { keyPrefix: string | null; key: string }[] = [];
  for (const raw of await listStoreKeys(store)) {
    const parsed = parseStoredKeyName(raw);
    if (!parsed) continue;
    if (storeKeyScope(parsed.key) === 'device') continue;
    out.push(parsed);
  }
  return out;
}

function profileOfPrefix(keyPrefix: string | null): StoreProfile {
  if (keyPrefix === null) return PRIMARY_STORE_PROFILE;
  if (keyPrefix === DECOY_STORE_PROFILE.keyPrefix) return DECOY_STORE_PROFILE;
  return { id: `other-${keyPrefix}`, keyPrefix };
}

/**
 * Deletes every per-wallet AsyncStorage record of ONE profile (the second
 * wallet, when its duress PIN or the app PIN is removed). The real wallet's
 * records are never touched by it.
 */
export async function removeProfileRecords(store: SweepableStore, profile: StoreProfile): Promise<number> {
  let removed = 0;
  for (const { keyPrefix, key } of await walletRecordsToRemove(store)) {
    if (keyPrefix !== profile.keyPrefix) continue;
    await removeStoreItem(profileBoundStore(store, profile), key);
    removed += 1;
  }
  return removed;
}

export interface WipeBothArgs {
  /** The app's AsyncStorage. */
  store: SweepableStore;
  /** The secure-store backend (the PIN record is deleted through it). */
  backend: SecureStoreBackend;
  /** A vault bound to `profile` (storage.ts createProfileVault). */
  vaultFor(profile: StoreProfile): ProfileVault;
  /**
   * The per-wallet resets the ordinary wipe runs, given the profile's bound
   * store and vault: sessions (with their keys), recovery data, passkeys,
   * spending limits, browser connections, notes, multisig records, the
   * pending list, price alerts, the account list.
   */
  resetRecords(store: RemovableKeyValueStore, vault: ProfileVault): Promise<void>;
  /** Indices of the public account cache (MAX_ACCOUNTS of them). */
  publicAccountIndices: number[];
}

/**
 * "Remove wallet" while an app PIN exists (section 7.3): removes BOTH
 * wallets, whichever one is open, and the PIN record. The decoy first, so a
 * failure leaves the real wallet intact for a retry; within each profile the
 * imported keys first (a failure there stops the wipe, as in the ordinary
 * wipe). Then every per-wallet AsyncStorage record of every profile that is
 * still there (listStoreKeys — this catches the records the ordinary wipe
 * keeps, e.g. contacts and tracked tokens, and the stores no reset knows
 * about), then the PIN record, and the active profile returns to the
 * primary one. The dialog text is the same in both wallets.
 */
export async function wipeBothWallets(args: WipeBothArgs): Promise<void> {
  for (const profile of [DECOY_STORE_PROFILE, PRIMARY_STORE_PROFILE]) {
    const vault = args.vaultFor(profile);
    await vault.importedKeys.removeAll();
    const bound = profileBoundStore(args.store, profile);
    await args.resetRecords(bound, vault).catch(() => undefined);
    await vault.removePhrase();
    await vault.deletePublicAccounts(args.publicAccountIndices);
  }
  for (const { keyPrefix, key } of await walletRecordsToRemove(args.store)) {
    await removeStoreItem(profileBoundStore(args.store, profileOfPrefix(keyPrefix)), key).catch(() => undefined);
  }
  await deletePinRecord(args.backend);
  setActiveStoreProfile(PRIMARY_STORE_PROFILE);
  appPinPresence.set(false);
}

/** The secure-store keys a profile can hold, by name (for the checks and the design record). */
export function secureKeyNamesOf(maxAccounts: number, importedSlots: number): string[] {
  const names = [STORE_KEYS.mnemonic.name, STORE_KEYS.protectedMnemonic.name, STORE_KEYS.vaultMeta.name, STORE_KEYS.importedKeysMeta.name];
  for (let i = 0; i < maxAccounts; i += 1) names.push(`${STORE_KEYS.publicAccount.name}${i}`);
  for (let i = 0; i < importedSlots; i += 1) names.push(`${STORE_KEYS.importedKey.name}${i}`, `${STORE_KEYS.protectedImportedKey.name}${i}`);
  return names;
}

// ---------------------------------------------------------------------------
// The backup check before a PIN or a duress PIN is turned on (section 7.5)
// ---------------------------------------------------------------------------

/**
 * The app does not record that the backup quiz was passed: a wallet is
 * stored only after it (ConfirmBackupScreen → confirmCreate), or was
 * imported from a phrase the user typed. So the PIN set-up checks the
 * written backup again: two word positions, chosen at random, which the
 * user types from the paper. Returns the two zero-based positions.
 */
export function backupCheckPositions(wordCount: number, random: (n: number) => Uint8Array): [number, number] {
  if (!Number.isInteger(wordCount) || wordCount < 2) throw new Error('A recovery phrase has at least 12 words.');
  const pick = (): number => {
    // Rejection sampling over one byte, so every position is equally likely.
    const limit = 256 - (256 % wordCount);
    for (;;) {
      const b = random(1)[0];
      if (b < limit) return b % wordCount;
    }
  };
  const a = pick();
  let b = pick();
  while (b === a) b = pick();
  return a < b ? [a, b] : [b, a];
}

/** True when both typed words equal the phrase's words at those positions (case and spaces ignored). */
export function backupWordsMatch(phrase: string, positions: readonly number[], typed: readonly string[]): boolean {
  const words = phrase.trim().split(/\s+/);
  if (positions.length !== typed.length || positions.length === 0) return false;
  let ok = true;
  for (let i = 0; i < positions.length; i += 1) {
    if ((typed[i] ?? '').trim().toLowerCase() !== words[positions[i]]) ok = false;
  }
  return ok;
}

/** "word 3 and word 9" style label (one-based) for the backup check. */
export function backupCheckLabel(positions: readonly number[]): string {
  return positions.map((p) => `word ${p + 1}`).join(' and ');
}

// ---------------------------------------------------------------------------
// User-facing copy (pinned by scripts/check-duress.mjs)
// ---------------------------------------------------------------------------

export const APP_PIN_SECTION_TITLE = 'App PIN';
export const APP_PIN_SWITCH_LABEL = 'Use a PIN to unlock';
export const APP_PIN_WHAT_NOTE =
  "With a PIN, the wallet's own lock screen asks for a 6-digit PIN each time the wallet is opened and after auto-lock, instead of your fingerprint or face. The PIN is an extra lock inside this app: your device's own lock still protects the secure storage that holds your recovery phrase, and sending still asks for your fingerprint, face or device passcode.";
export const APP_PIN_LIMITS_NOTE =
  "What the PIN does not protect against: someone who copies this app's storage from the phone can try every 6-digit PIN on a computer, so the PIN stops guessing at the screen only. After 5 wrong PINs the lock screen waits 30 seconds, and the wait doubles with each further wrong PIN up to 1 hour; it never wipes the wallet. There is no PIN reset: if you forget it, clear the app's data or reinstall it, and restore the wallet from your recovery phrase.";
export const APP_PIN_COSTS_NOTE =
  'While the PIN is on, auto-lock cannot be turned off, screen protection stays on, and the wallet posts no notifications: no reminders for recurring payments or swaps, no price alerts, and no alert when someone starts a recovery or takeover of one of your accounts. You see those the next time you open the wallet.';
export const APP_PIN_BACKUP_NOTE =
  'To turn the PIN on, first type two words of your recovery phrase from your written backup, to confirm you still have it.';
export const APP_PIN_ON_STATUS = 'The app PIN is on.';
export const APP_PIN_OFF_STATUS = 'The app PIN is off. The wallet unlocks with your fingerprint, face or device passcode.';

/** The one sentence the Notifications section shows while an app PIN is on (section 7.4). */
export const NOTIFICATIONS_OFF_WITH_PIN =
  'Notifications are off while the app PIN is on: a notification can be read on the lock screen without your PIN.';

export const SCREEN_PROTECTION_WITH_PIN_NOTE =
  'Screen protection stays on while the app PIN is on, so the app switcher and screenshots never show the wallet.';
export const AUTO_LOCK_WITH_PIN_NOTE =
  'While the app PIN is on, auto-lock cannot be turned off: the wallet asks for the PIN when it is opened and after this time in the background.';

export const DURESS_SECTION_TITLE = 'Duress PIN';
export const DURESS_EXPLANATION =
  'A duress PIN opens a separate wallet instead of this one, for when someone forces you to open your wallet. Keep a small amount in it and use it now and then so it looks lived in.';
/** The honest claim (section 4.3), shown on every duress screen (three sentences). */
export const DURESS_HONEST_CLAIM =
  "The duress PIN opens a separate wallet instead of this one, so someone looking at the screen sees an ordinary wallet. Anyone who copies this app's files from the phone can tell that two wallets exist, and a 6-digit PIN can be guessed from such a copy. Funding the second wallet from this wallet links them on-chain.";
export const DURESS_FUNDING_NOTE =
  'Fund the second wallet from an exchange or another source that has never sent to or received from this wallet. A transfer between the two wallets links them permanently on the blockchain.';
export const DURESS_BACKUP_NOTE =
  "The second wallet is derived from this wallet's recovery phrase (BIP-85, child index 0), so backing up that one phrase backs up both: restoring this phrase and setting a duress PIN again brings the same second wallet back. Its own recovery phrase does not reveal this wallet's: someone shown it learns nothing of this wallet.";
export const DURESS_NEEDS_PIN = 'Turn the app PIN on first: a duress PIN works only on top of it.';
export const DURESS_SET_STATUS = 'A duress PIN is set.';
export const DURESS_NOT_SET_STATUS = 'No duress PIN is set.';
export const DURESS_MUST_DIFFER = 'The duress PIN must be different from your app PIN. Nothing was changed.';
/**
 * The ending of an action that this wallet cannot complete (adding a
 * duress PIN or removing the PIN while the wallet open is the second
 * wallet; see docs/DURESS_WALLET.md section 7.9). True, and says nothing
 * about which wallet is open.
 */
export const PIN_ACTION_NOT_COMPLETED = 'This could not be completed on this phone. Nothing was changed.';

export const REMOVE_PIN_CONFIRM_TITLE = 'Remove the app PIN?';
export const REMOVE_PIN_CONFIRM_BODY =
  'The wallet will unlock with your fingerprint, face or device passcode again, and notifications can be turned back on.';
export const REMOVE_PIN_WITH_DURESS_BODY =
  'The wallet will unlock with your fingerprint, face or device passcode again. Removing the app PIN also removes the duress PIN and deletes the second wallet from this phone; it can be brought back from this recovery phrase by setting a duress PIN again. Move any funds you want to keep out of the second wallet first.';
export const REMOVE_DURESS_CONFIRM_TITLE = 'Remove the duress PIN?';
export const REMOVE_DURESS_CONFIRM_BODY =
  'The duress PIN stops working and the second wallet is deleted from this phone. It can be brought back from this recovery phrase by setting a duress PIN again. Move any funds you want to keep out of the second wallet first.';

export const PIN_PAD_TITLE = 'Enter your PIN';

/** Appended to the "Wipe wallet?" dialog while an app PIN is on: the same words in both wallets. */
export const WIPE_WITH_PIN_NOTE =
  'With the app PIN on, this removes everything the wallet keeps on this phone, and the app PIN itself.';

/** Settings → Privacy prompts and results of the PIN flows. */
export const PIN_PROMPTS = Object.freeze({
  current: 'Type your current PIN',
  choose: 'Choose a 6-digit PIN',
  chooseAgain: 'Type the new PIN again',
  chooseDuress: 'Choose a 6-digit duress PIN',
  chooseDuressAgain: 'Type the duress PIN again',
});
export const PIN_BACKUP_PROMPT = 'Confirm your recovery phrase backup';
export const PIN_BACKUP_MISMATCH =
  'Those words do not match your recovery phrase. Check your written backup; nothing was changed.';
export const PIN_RESULTS = Object.freeze({
  on: 'The app PIN is on. The wallet asks for it the next time it is opened or locks.',
  changed: 'The PIN was changed.',
  off: 'The app PIN is off.',
  duressSet: 'The duress PIN is set. It opens the second wallet.',
  duressChanged: 'The duress PIN was changed.',
  duressRemoved: 'The duress PIN was removed and the second wallet was deleted from this phone.',
});

/**
 * The readiness row's reason (`duress-pin`, advisory, every network; at
 * most three sentences, as config/readiness.ts requires): the same claim,
 * worded for a list of features.
 */
export const DURESS_READINESS_REASON =
  "A duress PIN opens a separate wallet instead of the real one, so someone looking at the screen sees an ordinary wallet. Anyone who copies this app's files from the phone can tell that two wallets exist, and a 6-digit PIN can be guessed from such a copy. Funding the second wallet from the real wallet links them on-chain.";

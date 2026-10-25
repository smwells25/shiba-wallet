import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { createMnemonic, isValidMnemonic, mnemonicToSeed } from '@shiba-wallet/core';
import type { DerivedAccount } from '@shiba-wallet/core';
import { CHAINS, chainByCaip2 } from './chains';
import {
  appSecureBackend,
  bindSecureStore,
  createProfileVault,
  deriveRecordsBackupKey as deriveRecordsBackupKeyInVault,
  RECORDS_BACKUP_PROMPTS,
  deleteMnemonic,
  deletePublicAccounts,
  dropPhraseTicket,
  importedKeyVault,
  loadPublicAccount,
  nativeSecureStoreBackend,
  phraseLocation,
  PROMPTS,
  readPhrase,
  saveNewPhrase,
  savePublicAccount,
  sessionKeyVault,
  setApprovalTarget,
  upgradePhraseProtectionIfAutomatic,
  type ImportedKeyInfo,
  type PublicChainEntry,
} from './storage';
import {
  IMPORTED_KEY_EVM_ONLY,
  IMPORTED_KEY_PATH,
  IMPORTED_NAME_SUFFIX,
  MULTISIG_PATH,
  WATCH_ONLY_NAME_SUFFIX,
  WATCH_ONLY_PATH,
  approvalTargetFor,
  assertAccountCanSign,
  defaultImportedName,
  importedAccountId,
  importedSlotOf,
  isImportedAccountId,
  isMultisigAccountId,
  isWatchOnlyAccountId,
} from './account-ids';
import { checkWatchAddress, type KnownAccount } from './watch-only';
import { requireLocalAuth } from './biometric';
import { duplicateImportError, importedKeyBytes, importedSignerFor, parsePrivateKeyInput } from './imported-keys';
import {
  AsyncStorage,
  activeStoreProfile,
  profileBoundStore,
  setActiveStoreProfile,
  type RemovableKeyValueStore,
} from './store-keys';
import {
  attemptPin,
  clearDuressSlot,
  deletePinRecord,
  isNearCopy,
  notUsableMessage,
  pinRefusalMessage,
  pinCountdownOf,
  readPinRecord,
  sameLockSecret,
  setAppPin,
  setLockSlots,
  setPinSlot,
  PIN_DAMAGED_MESSAGE,
  PinRecordDamagedError,
  lockCheckFailedMessage,
  type LockKind,
  type PinCountdown,
  type PinSlot,
} from './pin';
import {
  DECOY_STORE_PROFILE,
  DURESS_MUST_DIFFER,
  PIN_ACTION_NOT_COMPLETED,
  appLockKind,
  appPinPresence,
  decoyWalletExists,
  profileForSlot,
  removeProfileRecords,
  setUpDecoyWallet,
  wipeBothWallets,
  type ProfileVault,
  type SweepableStore,
} from './duress';
import { forgetAllSessions } from './sessions';
import { addAaOperationSentListener, addAaSentListener } from './aa';
import { recoveryRecordListener, wipeRecoveryData } from './recovery';
import { forgetBrowserConnections } from './browser-sites';
import { wipeTransactionNotes } from './notes';
import { pendingUserOpRecorder, resetPendingRegistry } from './pending-transactions';
import { walletConnectFollowProfile } from './walletconnect';
import { resetBridgeTransfers } from './bridge';
import { wipeInbox } from './inbox';
import { resetPriceAlerts } from './price-alerts';
import { resetPendingHandles } from './handle';
import {
  addMultisigStoreListener,
  multisigListEntries,
  resetMultisigRecords,
  type MultisigAccountEntry,
} from './multisig';
import { resetPasskeys } from './passkeys';
import { installSpendingRecorder, resetSpendingLimits } from './spending-policy';
import {
  MAX_ACCOUNTS,
  MAX_IMPORTED_ACCOUNTS,
  addAccount as addAccountToStore,
  addImportedAccountEntry,
  addWatchOnlyAccountEntry,
  removeWatchOnlyAccountEntry,
  reconcileImportedAccounts,
  reconcileMultisigAccounts,
  reconcileStoredImportedAccounts,
  reconcileStoredMultisigAccounts,
  removeImportedAccountEntry,
  sanitizeAccountName,
  defaultAccountsState,
  deriveChainAccounts,
  deriveSignerFor,
  hideAccount as hideAccountInStore,
  loadAccounts,
  renameAccount as renameAccountInStore,
  resetAccounts,
  setActiveAccount,
  unhideAccount as unhideAccountInStore,
  type AccountsState,
  type ChainAccount,
} from './accounts';

export type { ChainAccount } from './accounts';

// The one place the native secure-store module is handed to ./storage.ts,
// which owns every read and write of key material (see its header). Done at
// module load so the vault exists before any screen (e.g. the Sessions
// screen's sessionKeyVault) can use it.
bindSecureStore(nativeSecureStoreBackend(SecureStore));

export type WalletStatus = 'loading' | 'no-wallet' | 'ready';

/** One account of the wallet as the UI lists it (public data only). */
export interface AccountView {
  /**
   * Derivation index (docs/ARCHITECTURE.md ADR D8) for an account from the
   * recovery phrase; for an imported account, its id in the imported range
   * (./account-ids.ts), which is not a derivation index.
   */
  index: number;
  /**
   * The name every screen shows. For an imported account it always ends in
   * IMPORTED_NAME_SUFFIX (" (imported key)"), so no screen can show the
   * account without saying where its key came from (ADR D9).
   */
  name: string;
  /** The name as stored (what Rename edits). */
  storedName: string;
  hidden: boolean;
  /** True for an account whose key was imported: the recovery phrase does NOT back it up. */
  imported: boolean;
  /**
   * True for a watch-only account (feature 10): an address with NO key in
   * this wallet. Such an account is never in `accountList` (only in
   * `watchOnlyAccounts`), can be the active account, and every signing path
   * refuses it.
   */
  watchOnly: boolean;
  /**
   * True for a multi-signature account (feature 24; listed since phase 18
   * item 3): a Kernel account no single key of this wallet controls. Like a
   * watch-only account it is never in `accountList` (only in
   * `multisigAccounts`), can be the active account, and every signing path
   * refuses it; its operations are built on the Multisig screen.
   */
  multisig: boolean;
  /**
   * For a multisig account: its record's network, this wallet's signer for
   * it and its shape label; null for every other account. `name` is the
   * shape label too ("Multisig 2 (2-of-3)").
   */
  multisigInfo: MultisigAccountInfo | null;
  /**
   * The account's EVM address (m/44'/60'/0'/0/index for a phrase account,
   * the imported key's address otherwise), or null if not known yet.
   */
  evmAddress: string | null;
}

/** What the account views know about a multisig account (public data from its record). */
export interface MultisigAccountInfo {
  /** CAIP-2 network the record belongs to; the Multisig screen builds its operations only there. */
  chain: string;
  /** This wallet's signer for it (a recovery-phrase account's EVM address). */
  localSigner: string;
  /** "Multisig 2 (2-of-3)". */
  label: string;
}

/** What importPrivateKey did. */
export interface ImportKeyResult {
  account: AccountView;
  /** Set when the key could not be put in biometric-protected storage although the phrase is (platform words). */
  protectionDetail: string | null;
}

interface WalletContextValue {
  status: WalletStatus;
  /**
   * The ACTIVE account's addresses on the launch chains; empty until
   * status is 'ready'. Every screen reads its addresses from here, so an
   * account switch re-targets balances, receive, send, activity, swap
   * and WalletConnect at once.
   */
  accounts: ChainAccount[];
  /** The active account (possibly a watch-only one); null until status is 'ready'. */
  activeAccount: AccountView | null;
  /**
   * Every account this wallet holds a KEY for (recovery-phrase and imported
   * accounts), ascending by index, hidden ones included. Watch-only
   * accounts are deliberately NOT in this list: every caller that treats
   * this list as "your own accounts" (the risk card, own-address labels,
   * WalletConnect bindings, guardians and owner changes) must never count
   * an address the wallet cannot sign for. They are in `watchOnlyAccounts`.
   */
  accountList: AccountView[];
  /** The watch-only accounts (feature 10), ascending by id; no key exists for any of them. */
  watchOnlyAccounts: AccountView[];
  /**
   * The multi-signature accounts (feature 24), ascending by id, one per
   * record of the multisig store; no single key of this wallet signs for
   * any of them, so they are never in `accountList`.
   */
  multisigAccounts: AccountView[];
  /** The account (from `accountList`, never a watch-only one) whose EVM address this is, or null. */
  accountForEvmAddress: (address: string) => AccountView | null;
  /** Makes a visible account the active one (persisted). */
  switchAccount: (index: number) => Promise<void>;
  /** Creates the next account (never reusing an index); does not switch. */
  addAccount: (name?: string | null) => Promise<AccountView>;
  renameAccount: (index: number, name: string) => Promise<void>;
  /**
   * Adds a watch-only account for an EVM address (feature 10): validated by
   * the send flow's validateRecipient, refused when it is already one of
   * this wallet's accounts or already watched. Stores public data only.
   * Does not switch to it.
   */
  addWatchOnly: (address: string, name?: string | null) => Promise<AccountView>;
  /** Removes a non-active watch-only account (nothing secret is deleted). */
  removeWatchOnly: (index: number) => Promise<void>;
  /** Hides a non-active account other than the first; keys are unaffected. */
  hideAccount: (index: number) => Promise<void>;
  unhideAccount: (index: number) => Promise<void>;
  /**
   * Validates an EVM private key (engine code), refuses one already in the
   * wallet, stores it through ./storage.ts and adds an "Imported N"
   * account. Does not switch to it. The caller must clear its own copy of
   * the input afterwards.
   */
  importPrivateKey: (input: string, name?: string | null) => Promise<ImportKeyResult>;
  /**
   * Deletes an imported account's key from this phone and removes the
   * account. The screen must have asked for an explicit confirmation that
   * states the consequence. The active account cannot be removed.
   */
  removeImportedAccount: (index: number) => Promise<void>;
  /**
   * Reads an imported account's private key for display (Settings), after
   * the caller's requireLocalAuth gate for that key. null when it could not
   * be opened (the error message is thrown instead when there is one).
   */
  revealImportedKey: (index: number) => Promise<string>;
  /**
   * Mnemonic generated by beginCreate and not yet persisted. Held only in
   * memory while the user completes the backup flow.
   */
  pendingMnemonic: string | null;
  /** Generates a fresh mnemonic for the create-wallet flow (not persisted yet). */
  beginCreate: () => void;
  /** Discards a pending mnemonic without persisting it. */
  cancelCreate: () => void;
  /** Persists the pending mnemonic after the backup quiz and unlocks the wallet. */
  confirmCreate: () => Promise<void>;
  /** Validates and persists a user-supplied mnemonic, then unlocks the wallet. */
  importExisting: (mnemonic: string) => Promise<void>;
  /** Reads the mnemonic back from secure storage (Settings reveal). */
  revealMnemonic: () => Promise<string | null>;
  /**
   * Re-derives the ACTIVE account's signing key for one chain and hands it
   * to fn for the duration of one signing operation. `expectAddress` is
   * the address the operation was prepared for (the confirm screen's
   * "From"): if the active account's key does not control exactly that
   * address — e.g. the account was switched after the quote — nothing is
   * signed and the call throws. Keys are never kept resident: the seed is
   * zeroed before this resolves, and the DerivedAccount (whose sign
   * closure captures the private key) must not be stored by callers.
   */
  signWith: <T>(
    chainId: string,
    expectAddress: string,
    fn: (account: DerivedAccount) => Promise<T>,
  ) => Promise<T>;
  /** Deletes the mnemonic from secure storage and resets to onboarding. */
  wipe: () => Promise<void>;
  /**
   * APP PIN (duress wallet Stage 2; ./pin.ts, ./duress.ts). True from launch
   * until a PIN is accepted when an app PIN is set: nothing of either wallet
   * is loaded before then (the PIN decides which wallet opens).
   */
  awaitingPin: boolean;
  /**
   * Checks a PIN typed on the lock screen. On success the wallet the PIN
   * belongs to is open when this resolves (reloaded through the storage seam
   * when it is not the one already open). The message is the same words
   * whichever wallet a PIN would open. A wrong PIN that starts a wait, and
   * a PIN refused because a wait runs, also return the wait's stamped end
   * (`countdown`), which the lock screen's PinPad counts down.
   */
  unlockWithPin: (pin: string) => Promise<{ ok: true } | { ok: false; message: string; countdown?: PinCountdown }>;
  /**
   * Which PIN slot opened this session (memory only; null without an app
   * PIN). Settings uses it to act on the open wallet's own PIN; no screen
   * renders it.
   */
  pinSessionSlot: PinSlot | null;
  /** Changes whenever a PIN opened a different wallet (LockGate remounts the screens on it). */
  profileKey: number;
  /** Turns the app lock on (Settings, after the backup check): a PIN, or a passphrase when `kind` is "phr". */
  turnOnAppPin: (pin: string, kind?: LockKind) => Promise<void>;
  /**
   * Switches the app lock between a PIN and a passphrase
   * (docs/DURESS_WALLET.md section 8.2.7): checks the current secret, then
   * rewrites BOTH slots in one write with the new app secret and — when a
   * duress secret exists — the new duress secret of the same kind. Only the
   * real wallet can; under the second wallet the steps end with the neutral
   * sentence.
   */
  switchAppLockKind: (currentSecret: string, kind: LockKind, nextAppSecret: string, nextDuressSecret: string | null) => Promise<void>;
  /** Changes the open wallet's PIN after checking its current PIN. */
  changeAppPin: (currentPin: string, nextPin: string) => Promise<void>;
  /** Turns the app PIN off after checking the current PIN (and removes a duress PIN and its wallet). */
  turnOffAppPin: (currentPin: string) => Promise<void>;
  /** True when a duress PIN is set and this session can know it (the real wallet); no prompt. */
  duressPinSet: () => Promise<boolean>;
  /**
   * Adds a duress PIN: checks the app PIN, derives the second wallet from
   * `realPhrase` (BIP-85 index 0), stores it in the second profile, then
   * sets the duress slot. The caller read the phrase through the approval
   * gate and drops it afterwards.
   */
  addDuressPin: (currentPin: string, duressPin: string, realPhrase: string) => Promise<void>;
  changeDuressPin: (currentPin: string, nextDuressPin: string) => Promise<void>;
  removeDuressPin: (currentPin: string) => Promise<void>;
  /**
   * RECORDS BACKUP (feature 47; ./records-backup.ts): the encryption key of
   * one records-backup file, derived from the open wallet's recovery phrase
   * behind ONE device prompt (./storage.ts deriveRecordsBackupKey). Refused
   * before any read or prompt unless the active account comes from the
   * phrase. The phrase and the seed never leave the vault's function; the
   * caller zeroes the returned key after use.
   */
  deriveRecordsBackupKey: (salt: Uint8Array, purpose: 'export' | 'import') => Promise<Uint8Array>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

/**
 * Derives the public data (addresses, paths) of the given accounts on
 * every launch chain from the mnemonic, through the single mapping in
 * ./accounts.ts. The 64-byte seed is zeroed before returning and the
 * DerivedAccount objects (which capture private keys in their sign
 * closures) are dropped inside deriveChainAccounts; only addresses and
 * paths leave this function. Signing re-derives on demand (signWith).
 */
function derivePublic(mnemonic: string, indices: number[]): Record<number, ChainAccount[]> {
  const seed = mnemonicToSeed(mnemonic);
  try {
    const out: Record<number, ChainAccount[]> = {};
    for (const index of indices) out[index] = deriveChainAccounts(seed, index);
    return out;
  } finally {
    seed.fill(0);
  }
}

const EVM_SLOT = 'eip155:1';

/** Public data for the secure-storage account cache (no key material). */
function toPublicEntries(accounts: ChainAccount[]): PublicChainEntry[] {
  return accounts.map(({ chainId, address, path }) => ({ chainId, address, path }));
}

/**
 * Rebuilds ChainAccount rows from cached public entries, in launch-chain
 * order with the current display metadata. null unless every launch chain
 * is present (an incomplete entry is re-derived instead of half-shown).
 */
function hydratePublic(entries: PublicChainEntry[] | null): ChainAccount[] | null {
  if (!entries) return null;
  const out: ChainAccount[] = [];
  for (const { provider, symbol, accent } of CHAINS) {
    const entry = entries.find((e) => e.chainId === provider.chainId);
    if (!entry) return null;
    out.push({
      chainId: provider.chainId,
      name: provider.name,
      symbol,
      accent,
      address: entry.address,
      path: entry.path,
    });
  }
  return out;
}

/** Best-effort write of the public cache; a failure only costs a later re-derivation. */
async function cachePublic(derived: Record<number, ChainAccount[]>): Promise<void> {
  for (const [index, accounts] of Object.entries(derived)) {
    await savePublicAccount(Number(index), toPublicEntries(accounts)).catch(() => undefined);
  }
}

/**
 * The rows of an imported account: its Ethereum address only, labelled with
 * IMPORTED_KEY_PATH instead of a derivation path. There is deliberately no
 * Bitcoin, Dogecoin or Solana row; Home shows those networks as not
 * available for an imported key.
 */
function importedRows(info: ImportedKeyInfo): ChainAccount[] {
  const evm = CHAINS.find((c) => c.provider.chainId === EVM_SLOT)!;
  return [
    {
      chainId: EVM_SLOT,
      name: evm.provider.name,
      symbol: evm.symbol,
      accent: evm.accent,
      address: info.address,
      path: IMPORTED_KEY_PATH,
    },
  ];
}

/** The imported accounts' rows from the vault's public record (no prompt). */
function importedRowsFrom(keys: readonly ImportedKeyInfo[]): Record<number, ChainAccount[]> {
  const out: Record<number, ChainAccount[]> = {};
  for (const info of keys) out[importedAccountId(info.slot)] = importedRows(info);
  return out;
}

/** Phrase-derived indices of a list (imported, watch-only and multisig ids are never derived). */
function derivedIndices(state: AccountsState): number[] {
  return state.accounts.filter((a) => !a.imported && !a.watchOnly && !a.multisig).map((a) => a.index);
}

/**
 * The row of a watch-only account: its Ethereum address only, from the
 * account store, labelled with WATCH_ONLY_PATH instead of a derivation path.
 * Home shows Bitcoin, Dogecoin and Solana as not available for it.
 */
function watchOnlyRows(address: string): ChainAccount[] {
  const evm = CHAINS.find((c) => c.provider.chainId === EVM_SLOT)!;
  return [
    {
      chainId: EVM_SLOT,
      name: evm.provider.name,
      symbol: evm.symbol,
      accent: evm.accent,
      address,
      path: WATCH_ONLY_PATH,
    },
  ];
}

/** The watch-only accounts' rows from the account store (public data; no prompt, no secure storage). */
function watchOnlyRowsFrom(state: AccountsState): Record<number, ChainAccount[]> {
  const out: Record<number, ChainAccount[]> = {};
  for (const a of state.accounts) {
    if (a.watchOnly && a.address) out[a.index] = watchOnlyRows(a.address);
  }
  return out;
}

/**
 * The row of a multi-signature account: its Ethereum address only (from the
 * account store, which mirrors the multisig store), labelled with
 * MULTISIG_PATH instead of a derivation path. Home shows Bitcoin, Dogecoin
 * and Solana as not available for it.
 */
function multisigRows(address: string): ChainAccount[] {
  const evm = CHAINS.find((c) => c.provider.chainId === EVM_SLOT)!;
  return [
    {
      chainId: EVM_SLOT,
      name: evm.provider.name,
      symbol: evm.symbol,
      accent: evm.accent,
      address,
      path: MULTISIG_PATH,
    },
  ];
}

/** The multisig accounts' rows from the account store (public data; no prompt, no secure storage). */
function multisigRowsFrom(state: AccountsState): Record<number, ChainAccount[]> {
  const out: Record<number, ChainAccount[]> = {};
  for (const a of state.accounts) {
    if (a.multisig && a.address) out[a.index] = multisigRows(a.address);
  }
  return out;
}

/** The account views' facts per multisig id, from the multisig store's entries. */
function multisigInfoFrom(entries: readonly MultisigAccountEntry[] | null): Record<number, MultisigAccountInfo> {
  const out: Record<number, MultisigAccountInfo> = {};
  for (const e of entries ?? []) out[e.id] = { chain: e.chain, localSigner: e.localSigner, label: e.label };
  return out;
}

/**
 * The account list brought in step with the multisig store (a record always
 * has an entry; an entry whose record is gone is dropped). An unreadable
 * multisig store leaves the list as it is. The result is computed from
 * `state` (so a list reconciled in memory only, e.g. after a failed write,
 * is kept) and persisted only when something changed; a failed write costs
 * nothing but a repeat at the next launch. Never throws.
 */
async function withStoredMultisigs(
  state: AccountsState,
): Promise<{ state: AccountsState; entries: MultisigAccountEntry[] | null }> {
  const entries = await multisigListEntries().catch(() => null);
  const next = reconcileMultisigAccounts(state, entries);
  if (next.changed) await reconcileStoredMultisigAccounts(entries).catch(() => undefined);
  return { state: next.state, entries };
}

/** Every index the cache can hold (accounts are hidden, never deleted, so indices stay below MAX_ACCOUNTS). */
const ALL_CACHE_INDICES = Array.from({ length: MAX_ACCOUNTS }, (_, i) => i);

const PROMPT_LOAD_ACCOUNTS = 'Unlock Shiba Wallet to show your accounts';
const PROMPT_NEW_ACCOUNT = 'Unlock your recovery phrase to create the account';
const PROMPT_CHECK_IMPORT = 'Unlock your recovery phrase to check the key is not already in the wallet';

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>('loading');
  const [accountsState, setAccountsState] = useState<AccountsState | null>(null);
  // Public data only (see derivePublic); keyed by account index.
  const [derived, setDerived] = useState<Record<number, ChainAccount[]>>({});
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);
  // Facts per multisig account id (record network, signer, shape label).
  const [multisigInfo, setMultisigInfo] = useState<Record<number, MultisigAccountInfo>>({});
  // App PIN (duress wallet Stage 2): whether the launch waits for a PIN,
  // which slot opened this session (memory only), a key that changes when
  // a PIN opened a different wallet, and the load requests the PIN unlock
  // makes (the launch effect below runs again for each).
  const [awaitingPin, setAwaitingPin] = useState(false);
  const awaitingPinRef = useRef(false);
  const [pinSessionSlot, setPinSessionSlot] = useState<PinSlot | null>(null);
  const pinSessionSlotRef = useRef<PinSlot | null>(null);
  const [profileKey, setProfileKey] = useState(0);
  const [loadRequest, setLoadRequest] = useState(0);
  const loadWaiters = useRef<(() => void)[]>([]);
  // The multisig store listener reconciles only while a wallet is open.
  const statusRef = useRef<WalletStatus>('loading');
  useLayoutEffect(() => {
    statusRef.current = status;
  });

  // signWith reads the active index through a ref so a signing call made
  // after a switch can never use a stale closure's index.
  const activeIndexRef = useRef(0);
  // The last committed list (the multisig store listener skips a commit
  // that would change nothing).
  const accountsRef = useRef<AccountsState | null>(null);
  const commitAccounts = useCallback((state: AccountsState | null) => {
    const active = state?.activeIndex ?? 0;
    activeIndexRef.current = active;
    accountsRef.current = state;
    // The approval gate opens the secret of the account that will sign
    // (./storage.ts): the phrase, the active imported account's key, or
    // nothing for a watch-only or multi-signature account (no key of this
    // wallet signs for it; signWith refuses it), so a device check while one
    // is active never opens the recovery phrase.
    setApprovalTarget(approvalTargetFor(active));
    setAccountsState(state);
  }, []);

  // Account-store mutations run one at a time (rapid taps must not lose
  // updates between the store's read and write).
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const serialized = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(task, task);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  // Recovery records (phase 8 item 4): a Kernel v3.3 account's record is
  // started on its first accepted smart-account operation, whichever screen
  // sent it (aa.ts notifies after the bundler accepted; public data only).
  useEffect(() => addAaSentListener(recoveryRecordListener(AsyncStorage)), []);

  // Stuck-operation coverage (phase 20 item 3): every smart-account
  // operation the bundler accepted — from Send, Swap, Staking, Sessions
  // (installs, revokes, payments, swaps), WalletConnect and the in-app
  // browser, multisig submits — is recorded in the pending registry, so
  // Activity shows its status and "Check status". Registered once here.
  useEffect(() => addAaOperationSentListener(pendingUserOpRecorder(AsyncStorage)), []);

  // App-enforced spending limits (phase 12 item 3): record what left the
  // account, but only after the node (sendEvm) or the bundler (sendAa)
  // accepted the send; failed sends are never recorded.
  useEffect(() => installSpendingRecorder(AsyncStorage), []);

  // A phrase held by the approval gate (./storage.ts) never outlives the
  // app's time in the foreground. Only 'background' counts: iOS reports
  // 'inactive' while its own Face ID prompt is up, and dropping the phrase
  // that prompt just opened would only cause a second prompt.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') dropPhraseTicket();
    });
    return () => sub.remove();
  }, []);

  // On launch, check secure storage for an existing wallet.
  //  - Standard storage: read the phrase (no prompt) and derive, as before.
  //  - Protected storage: draw the accounts from the public cache, so the
  //    app starts without a biometric prompt; only an account missing from
  //    the cache needs the phrase (one system prompt).
  useEffect(() => {
    let cancelled = false;
    /**
     * The account list brought in step with the imported-key vault (a key
     * on this phone always has an entry; an entry whose key is gone is
     * dropped), plus the imported accounts' rows from the vault's public
     * record. No prompt: the record holds addresses only.
     */
    const loadAccountsWithImported = async () => {
      const list = await importedKeyVault.list().catch(() => ({ keys: [] as ImportedKeyInfo[], damaged: true }));
      const withImported = await reconcileStoredImportedAccounts(list.damaged ? null : list.keys.map((k) => k.slot)).catch(
        async () => reconcileImportedAccounts(await loadAccounts(), list.damaged ? null : list.keys.map((k) => k.slot)).state,
      );
      // Multi-signature accounts (phase 18 item 3): every stored multisig is
      // listed as an account; public data only, no prompt.
      const { state, entries } = await withStoredMultisigs(withImported);
      setMultisigInfo(multisigInfoFrom(entries));
      return { state, imported: importedRowsFrom(list.keys) };
    };
    (async () => {
      try {
        if (loadRequest === 0) {
          // APP PIN first (./pin.ts): when one is set, NOTHING of either
          // wallet is read before the lock screen has checked a PIN, because
          // the PIN decides which wallet (storage profile) opens. A record
          // that cannot be read counts as set (fail closed).
          let pinOn: boolean;
          try {
            const lockRecord = await readPinRecord(appSecureBackend());
            pinOn = lockRecord !== null;
            // The lock screen draws the pad or the passphrase field from the
            // record's kind, read here with the record and before any wallet.
            if (lockRecord) appLockKind.set(lockRecord.kind);
          } catch {
            pinOn = true;
          }
          if (cancelled) return;
          appPinPresence.set(pinOn);
          if (pinOn) {
            awaitingPinRef.current = true;
            setAwaitingPin(true);
            return;
          }
        } else {
          // A PIN opened a wallet (./duress.ts profileForSlot set the active
          // profile before this run): drop the other wallet's state first.
          setStatus('loading');
          setDerived({});
          setMultisigInfo({});
          commitAccounts(null);
        }
        const location = await phraseLocation();
        if (cancelled) return;
        if (location === 'none') {
          setStatus('no-wallet');
          return;
        }
        if (location === 'standard') {
          const mnemonic = await readPhrase(PROMPT_LOAD_ACCOUNTS);
          if (cancelled) return;
          if (!mnemonic || !isValidMnemonic(mnemonic)) {
            setStatus('no-wallet');
            return;
          }
          const { state, imported } = await loadAccountsWithImported();
          if (cancelled) return;
          const fresh = derivePublic(mnemonic, derivedIndices(state));
          setDerived({ ...fresh, ...imported, ...watchOnlyRowsFrom(state), ...multisigRowsFrom(state) });
          commitAccounts(state);
          setStatus('ready');
          void cachePublic(fresh);
          return;
        }
        const { state, imported } = await loadAccountsWithImported();
        if (cancelled) return;
        const fromCache: Record<number, ChainAccount[]> = {
          ...imported,
          ...watchOnlyRowsFrom(state),
          ...multisigRowsFrom(state),
        };
        const missing: number[] = [];
        for (const index of derivedIndices(state)) {
          const rows = hydratePublic(await loadPublicAccount(index));
          if (rows) fromCache[index] = rows;
          else missing.push(index);
        }
        if (missing.length > 0) {
          // Rare (the cache is written whenever addresses are derived). If
          // the prompt is cancelled or the phrase cannot be opened, the
          // wallet still opens with the cached accounts; a missing one is
          // derived again when it is next switched to.
          try {
            const mnemonic = await readPhrase(PROMPT_LOAD_ACCOUNTS);
            if (mnemonic && isValidMnemonic(mnemonic)) {
              const fresh = derivePublic(mnemonic, missing);
              Object.assign(fromCache, fresh);
              void cachePublic(fresh);
            }
          } catch {
            // Shown later: signing reports why the phrase cannot be opened.
          }
        }
        if (cancelled) return;
        setDerived(fromCache);
        commitAccounts(state);
        setStatus('ready');
      } catch {
        // Secure storage unavailable (e.g. locked device edge case): fall
        // back to onboarding rather than crash. Nothing is deleted.
        if (!cancelled) setStatus('no-wallet');
      } finally {
        if (!cancelled) {
          const waiters = loadWaiters.current;
          loadWaiters.current = [];
          for (const w of waiters) w();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commitAccounts, loadRequest]);

  /** Runs the launch load again (for the active profile) and resolves when it finished. */
  const reloadWallet = useCallback(
    () =>
      new Promise<void>((resolve) => {
        loadWaiters.current.push(resolve);
        setLoadRequest((n) => n + 1);
      }),
    [],
  );

  const setSessionSlot = useCallback((slot: PinSlot | null) => {
    pinSessionSlotRef.current = slot;
    setPinSessionSlot(slot);
  }, []);

  const unlockWithPin = useCallback(
    async (pin: string): Promise<{ ok: true } | { ok: false; message: string; countdown?: PinCountdown }> => {
      let outcome;
      try {
        outcome = await attemptPin(appSecureBackend(), pin);
      } catch (e) {
        // The lock's own word: "The PIN could not be checked. Try again." or
        // the passphrase form (the kind is the device fact read at launch).
        return { ok: false, message: e instanceof PinRecordDamagedError ? PIN_DAMAGED_MESSAGE : lockCheckFailedMessage(appLockKind.get()) };
      }
      if (outcome.kind !== 'opened') {
        const message = pinRefusalMessage(outcome, Date.now());
        const countdown = pinCountdownOf(outcome);
        return countdown ? { ok: false, message, countdown } : { ok: false, message };
      }
      const profile = profileForSlot(outcome.slot);
      const switching = awaitingPinRef.current || activeStoreProfile().id !== profile.id;
      setSessionSlot(outcome.slot);
      if (switching) {
        // The other wallet's opened secret must never serve this one.
        dropPhraseTicket();
        setActiveStoreProfile(profile);
        // The SDK keeps one client per wallet (./walletconnect.ts): the other
        // wallet's stops listening to the relay while this one is open.
        void walletConnectFollowProfile(profile);
        // The Bridge screen's list in memory belongs to the other wallet.
        void resetBridgeTransfers();
        setProfileKey((k) => k + 1);
        await reloadWallet();
      }
      awaitingPinRef.current = false;
      setAwaitingPin(false);
      return { ok: true };
    },
    [reloadWallet, setSessionSlot],
  );

  /** The current PIN of the OPEN wallet (Settings); throws the lock screen's sentence otherwise. */
  const checkSessionPin = useCallback(async (pin: string): Promise<PinSlot> => {
    const slot = pinSessionSlotRef.current ?? 'primary';
    const outcome = await attemptPin(appSecureBackend(), pin, {}, slot);
    if (outcome.kind !== 'opened') throw new Error(pinRefusalMessage(outcome, Date.now()));
    return slot;
  }, []);

  const turnOnAppPin = useCallback(
    async (pin: string, kind: LockKind = 'pin') => {
      await setAppPin(appSecureBackend(), pin, {}, kind);
      setSessionSlot('primary');
      appLockKind.set(kind);
      appPinPresence.set(true);
    },
    [setSessionSlot],
  );

  /** Whether a duress secret is the app secret again (a PIN) or a near copy of it (a passphrase), for the lock's kind. */
  const duressTooClose = useCallback(async (appSecret: string, duressSecret: string): Promise<string | null> => {
    const kind = (await readPinRecord(appSecureBackend()))?.kind ?? 'pin';
    if (kind === 'pin') return sameLockSecret('pin', appSecret, duressSecret) ? DURESS_MUST_DIFFER : null;
    return isNearCopy(appSecret, duressSecret) ? notUsableMessage('phr') : null;
  }, []);

  const changeAppPin = useCallback(
    async (currentPin: string, nextPin: string) => {
      const slot = await checkSessionPin(currentPin);
      await setPinSlot(appSecureBackend(), slot, nextPin);
    },
    [checkSessionPin],
  );

  const decoyVault = useCallback((): ProfileVault => createProfileVault(DECOY_STORE_PROFILE), []);

  /** Removes the second wallet's keys and every record of its profile (the real wallet's are not touched). */
  const removeDecoyWallet = useCallback(async () => {
    const vault = decoyVault();
    await vault.importedKeys.removeAll();
    await forgetAllSessions(profileBoundStore(AsyncStorage, DECOY_STORE_PROFILE), vault.sessionKeys).catch(() => undefined);
    await vault.removePhrase();
    await vault.deletePublicAccounts(ALL_CACHE_INDICES);
    await removeProfileRecords(AsyncStorage as unknown as SweepableStore, DECOY_STORE_PROFILE);
  }, [decoyVault]);

  const turnOffAppPin = useCallback(
    async (currentPin: string) => {
      const slot = await checkSessionPin(currentPin);
      // Opened by the duress PIN: the PIN is not removed here, because doing
      // so would leave the real wallet without its PIN (rule 4 of
      // docs/DURESS_WALLET.md section 1.2). The sentence says nothing about
      // which wallet is open (section 7.9).
      if (slot !== 'primary') throw new Error(PIN_ACTION_NOT_COMPLETED);
      if (await decoyWalletExists(decoyVault())) await removeDecoyWallet();
      await deletePinRecord(appSecureBackend());
      appPinPresence.set(false);
      appLockKind.set('pin');
      setSessionSlot(null);
    },
    [checkSessionPin, decoyVault, removeDecoyWallet, setSessionSlot],
  );

  const duressPinSet = useCallback(async () => {
    if (pinSessionSlotRef.current !== 'primary') return false;
    return decoyWalletExists(decoyVault());
  }, [decoyVault]);

  const addDuressPin = useCallback(
    async (currentPin: string, duressPin: string, realPhrase: string) => {
      const slot = await checkSessionPin(currentPin);
      // Only the real wallet can add one (section 7.1); under the second
      // wallet the steps run the same way and end with a neutral sentence.
      if (slot !== 'primary') throw new Error(PIN_ACTION_NOT_COMPLETED);
      // Checked BEFORE the second wallet is set up, in the lock's own form.
      const tooClose = await duressTooClose(currentPin, duressPin);
      if (tooClose) throw new Error(tooClose);
      await setUpDecoyWallet(realPhrase, decoyVault());
      await setPinSlot(appSecureBackend(), 'duress', duressPin);
    },
    [checkSessionPin, decoyVault, duressTooClose],
  );

  const changeDuressPin = useCallback(
    async (currentPin: string, nextDuressPin: string) => {
      const slot = await checkSessionPin(currentPin);
      if (slot !== 'primary') throw new Error(PIN_ACTION_NOT_COMPLETED);
      const tooClose = await duressTooClose(currentPin, nextDuressPin);
      if (tooClose) throw new Error(tooClose);
      await setPinSlot(appSecureBackend(), 'duress', nextDuressPin);
    },
    [checkSessionPin, duressTooClose],
  );

  const switchAppLockKind = useCallback(
    async (currentSecret: string, kind: LockKind, nextAppSecret: string, nextDuressSecret: string | null) => {
      const slot = await checkSessionPin(currentSecret);
      // Only the real wallet can rewrite both slots; under the second wallet
      // the steps run the same way and end with the neutral sentence
      // (docs/DURESS_WALLET.md section 8.2.7).
      if (slot !== 'primary') throw new Error(PIN_ACTION_NOT_COMPLETED);
      // A second wallet without a duress secret of the new kind would be
      // left with no way to open it: refuse rather than orphan it.
      const decoy = await decoyWalletExists(decoyVault());
      if (decoy !== (nextDuressSecret !== null)) throw new Error('The duress secret must be chosen again together with the app lock. Nothing was changed.');
      await setLockSlots(appSecureBackend(), kind, nextAppSecret, nextDuressSecret);
      appLockKind.set(kind);
    },
    [checkSessionPin, decoyVault],
  );

  const removeDuressPin = useCallback(
    async (currentPin: string) => {
      const slot = await checkSessionPin(currentPin);
      if (slot !== 'primary') throw new Error(PIN_ACTION_NOT_COMPLETED);
      await clearDuressSlot(appSecureBackend());
      await removeDecoyWallet();
    },
    [checkSessionPin, removeDecoyWallet],
  );

  const beginCreate = useCallback(() => {
    // 128 bits = 12 words. Entropy comes from crypto.getRandomValues via the
    // expo-crypto polyfill installed in src/polyfills.ts.
    setPendingMnemonic(createMnemonic(128));
  }, []);

  const cancelCreate = useCallback(() => {
    setPendingMnemonic(null);
  }, []);

  const activate = useCallback(
    async (mnemonic: string) => {
      // Standard storage first, then (policy 'automatic') the move into
      // biometric-protected storage: the two-step order means a cancelled
      // or refused protection prompt can never cost the phrase. Android
      // shows two system prompts here (protected write + read-back check),
      // iOS one (the read-back). Any outcome other than success leaves the
      // wallet working from standard storage, and Settings shows why.
      await saveNewPhrase(mnemonic);
      // A cache left by a previous wallet must never label this one.
      await deletePublicAccounts(ALL_CACHE_INDICES);
      const fresh = derivePublic(mnemonic, [0]);
      await cachePublic(fresh);
      await upgradePhraseProtectionIfAutomatic();
      // A new or imported wallet starts with the default list (Account 1 =
      // index 0). Further accounts of an imported phrase reappear with
      // their original keys when added again, because indices are handed
      // out in order.
      const reset = await resetAccounts().catch(() => defaultAccountsState());
      // Imported keys are not part of any phrase. A wipe deletes them, so
      // normally there are none here; any left on this phone (an interrupted
      // wipe) are listed again rather than silently deleted, because the
      // phrase cannot bring them back.
      const list = await importedKeyVault.list().catch(() => ({ keys: [] as ImportedKeyInfo[], damaged: true }));
      const withImported =
        list.damaged || list.keys.length === 0
          ? reset
          : await reconcileStoredImportedAccounts(list.keys.map((k) => k.slot)).catch(() => reset);
      // Multisig records are public bookkeeping; a wipe removes them, so
      // normally there are none here. Any left (an interrupted wipe) are
      // listed again, as on the Multisig screen.
      const { state, entries } = await withStoredMultisigs(withImported);
      setMultisigInfo(multisigInfoFrom(entries));
      setDerived({ ...fresh, ...importedRowsFrom(list.keys), ...multisigRowsFrom(state) });
      commitAccounts(state);
      setPendingMnemonic(null);
      setStatus('ready');
    },
    [commitAccounts],
  );

  const confirmCreate = useCallback(async () => {
    if (!pendingMnemonic) {
      throw new Error('No wallet creation in progress');
    }
    await activate(pendingMnemonic);
  }, [pendingMnemonic, activate]);

  const importExisting = useCallback(
    async (raw: string) => {
      const mnemonic = raw.trim().toLowerCase().split(/\s+/).join(' ');
      if (!isValidMnemonic(mnemonic)) {
        throw new Error('Invalid BIP-39 mnemonic (bad word or checksum)');
      }
      await activate(mnemonic);
    },
    [activate],
  );

  // Uses the phrase the Settings approval prompt just opened (no second
  // prompt). Returns null when it cannot be opened (cancelled, or the
  // protected copy became unreadable — Settings' storage-protection row
  // then explains the latter).
  const revealMnemonic = useCallback(async () => {
    try {
      return await readPhrase('Reveal recovery phrase');
    } catch {
      return null;
    }
  }, []);

  // Mirror of `derived` for the async account actions below. It is updated
  // after every commit (refs must not be written while rendering); a layout
  // effect runs before any passive effect or later event can read it.
  // ensureDerived also writes it directly so a caller sees fresh entries
  // before the state update has rendered.
  const derivedRef = useRef(derived);
  useLayoutEffect(() => {
    derivedRef.current = derived;
  });

  /** Derives public data for indices not derived yet (e.g. after an add). */
  const ensureDerived = useCallback(async (indices: number[]) => {
    // Imported accounts come from the vault's public record, never from the phrase.
    const importedMissing = indices.filter((i) => isImportedAccountId(i) && derivedRef.current[i] === undefined);
    if (importedMissing.length > 0) {
      const list = await importedKeyVault.list();
      const rows = importedRowsFrom(list.keys.filter((k) => importedMissing.includes(importedAccountId(k.slot))));
      setDerived((prev) => ({ ...prev, ...rows }));
      derivedRef.current = { ...derivedRef.current, ...rows };
    }
    // Watch-only accounts come from the account store (their address is all
    // the wallet knows), never from the phrase or the imported-key vault.
    const watchMissing = indices.filter((i) => isWatchOnlyAccountId(i) && derivedRef.current[i] === undefined);
    if (watchMissing.length > 0) {
      const all = watchOnlyRowsFrom(await loadAccounts());
      const rows: Record<number, ChainAccount[]> = {};
      for (const i of watchMissing) if (all[i]) rows[i] = all[i];
      setDerived((prev) => ({ ...prev, ...rows }));
      derivedRef.current = { ...derivedRef.current, ...rows };
    }
    // Multisig accounts come from the account store too (their address,
    // mirrored from the multisig store), never from the phrase.
    const multisigMissing = indices.filter((i) => isMultisigAccountId(i) && derivedRef.current[i] === undefined);
    if (multisigMissing.length > 0) {
      const all = multisigRowsFrom(await loadAccounts());
      const rows: Record<number, ChainAccount[]> = {};
      for (const i of multisigMissing) if (all[i]) rows[i] = all[i];
      setDerived((prev) => ({ ...prev, ...rows }));
      derivedRef.current = { ...derivedRef.current, ...rows };
    }
    let missing = indices.filter(
      (i) => !isImportedAccountId(i) && !isWatchOnlyAccountId(i) && !isMultisigAccountId(i) && derivedRef.current[i] === undefined,
    );
    if (missing.length === 0) return;
    // The public cache first (no prompt), then the phrase for the rest.
    const cached: Record<number, ChainAccount[]> = {};
    for (const index of missing) {
      const rows = hydratePublic(await loadPublicAccount(index));
      if (rows) cached[index] = rows;
    }
    missing = missing.filter((i) => cached[i] === undefined);
    let fresh: Record<number, ChainAccount[]> = {};
    if (missing.length > 0) {
      const mnemonic = await readPhrase(PROMPT_NEW_ACCOUNT);
      if (!mnemonic) throw new Error('No wallet found in secure storage');
      fresh = derivePublic(mnemonic, missing);
      await cachePublic(fresh);
    }
    Object.assign(fresh, cached);
    setDerived((prev) => ({ ...prev, ...fresh }));
    derivedRef.current = { ...derivedRef.current, ...fresh };
  }, []);
  const switchAccount = useCallback(
    (index: number) =>
      serialized(async () => {
        await ensureDerived([index]);
        commitAccounts(await setActiveAccount(index));
      }),
    [serialized, ensureDerived, commitAccounts],
  );

  // The multisig store changed (a create, import, rename, removal or an
  // operation's progress on the Multisig screen): bring the account list and
  // the multisig rows in step. Public data only; no prompt. A removed
  // multisig that was active hands over to Account 1 (reconcile).
  const refreshMultisigAccounts = useCallback(
    () =>
      serialized(async () => {
        if (statusRef.current !== 'ready') return;
        const { state, entries } = await withStoredMultisigs(await loadAccounts());
        if (statusRef.current !== 'ready') return;
        const info = multisigInfoFrom(entries);
        setMultisigInfo((prev) => (JSON.stringify(prev) === JSON.stringify(info) ? prev : info));
        if (JSON.stringify(state) === JSON.stringify(accountsRef.current)) return;
        const rows = multisigRowsFrom(state);
        setDerived((prev) => {
          const next: Record<number, ChainAccount[]> = {};
          for (const [key, value] of Object.entries(prev)) {
            if (!isMultisigAccountId(Number(key))) next[Number(key)] = value;
          }
          return { ...next, ...rows };
        });
        const kept: Record<number, ChainAccount[]> = {};
        for (const [key, value] of Object.entries(derivedRef.current)) {
          if (!isMultisigAccountId(Number(key))) kept[Number(key)] = value;
        }
        derivedRef.current = { ...kept, ...rows };
        commitAccounts(state);
      }),
    [serialized, commitAccounts],
  );
  useEffect(() => addMultisigStoreListener(() => void refreshMultisigAccounts().catch(() => undefined)), [refreshMultisigAccounts]);

  const addAccount = useCallback(
    (name: string | null = null) =>
      serialized(async () => {
        const { state, account } = await addAccountToStore(name);
        await ensureDerived([account.index]);
        commitAccounts(state);
        const evmAddress =
          derivedRef.current[account.index]?.find((c) => c.chainId === EVM_SLOT)?.address ?? null;
        return {
          index: account.index,
          name: account.name,
          storedName: account.name,
          hidden: account.hidden,
          imported: false,
          watchOnly: false,
          multisig: false,
          multisigInfo: null,
          evmAddress,
        };
      }),
    [serialized, ensureDerived, commitAccounts],
  );

  const renameAccount = useCallback(
    (index: number, name: string) =>
      serialized(async () => {
        commitAccounts(await renameAccountInStore(index, name));
      }),
    [serialized, commitAccounts],
  );

  const hideAccount = useCallback(
    (index: number) =>
      serialized(async () => {
        commitAccounts(await hideAccountInStore(index));
      }),
    [serialized, commitAccounts],
  );

  const unhideAccount = useCallback(
    (index: number) =>
      serialized(async () => {
        await ensureDerived([index]);
        commitAccounts(await unhideAccountInStore(index));
      }),
    [serialized, ensureDerived, commitAccounts],
  );

  const importPrivateKey = useCallback(
    (input: string, name: string | null = null) =>
      serialized(async (): Promise<ImportKeyResult> => {
        const parsed = parsePrivateKeyInput(input);
        if (!parsed.ok) throw new Error(parsed.error);
        // The name is checked before anything is stored.
        let cleanName: string | null = null;
        if (name !== null && name.trim() !== '') {
          const validation = sanitizeAccountName(name);
          if (!validation.ok) throw new Error(validation.error);
          cleanName = validation.name;
        }
        const state = await loadAccounts();
        if (state.accounts.filter((a) => a.imported).length >= MAX_IMPORTED_ACCOUNTS) {
          throw new Error(`This wallet already holds the maximum of ${MAX_IMPORTED_ACCOUNTS} imported keys.`);
        }
        // Every listed phrase account (hidden ones included) must be known to
        // refuse a key that is already in the wallet; the public cache
        // usually has them, otherwise the phrase is opened once.
        const phraseIndices = derivedIndices(state);
        if (phraseIndices.some((i) => derivedRef.current[i] === undefined)) {
          const cached: Record<number, ChainAccount[]> = {};
          const missing: number[] = [];
          for (const index of phraseIndices) {
            if (derivedRef.current[index] !== undefined) continue;
            const rows = hydratePublic(await loadPublicAccount(index));
            if (rows) cached[index] = rows;
            else missing.push(index);
          }
          if (missing.length > 0) {
            const mnemonic = await readPhrase(PROMPT_CHECK_IMPORT);
            if (!mnemonic) throw new Error('No wallet found in secure storage');
            Object.assign(cached, derivePublic(mnemonic, missing));
          }
          setDerived((prev) => ({ ...prev, ...cached }));
          derivedRef.current = { ...derivedRef.current, ...cached };
        }
        const list = await importedKeyVault.list();
        const existing = [
          ...state.accounts
            .filter((a) => !a.imported && !a.watchOnly && !a.multisig)
            .map((a) => ({
              name: a.name,
              imported: false,
              evmAddress: derivedRef.current[a.index]?.find((c) => c.chainId === EVM_SLOT)?.address ?? null,
            })),
          ...list.keys.map((k) => ({
            name: `${state.accounts.find((a) => a.index === importedAccountId(k.slot))?.name ?? 'an imported account'}${IMPORTED_NAME_SUFFIX}`,
            imported: true,
            evmAddress: k.address,
          })),
          // A watched address (feature 10) is refused too: the watch-only
          // entry must be removed first, so one address is never listed as
          // both an account the wallet signs for and one it only watches.
          ...state.accounts
            .filter((a) => a.watchOnly)
            .map((a) => ({
              name: `${a.name}${WATCH_ONLY_NAME_SUFFIX}`,
              imported: false,
              watchOnly: true,
              evmAddress: a.address ?? null,
            })),
        ];
        const duplicate = duplicateImportError(parsed.address, existing);
        if (duplicate) throw new Error(duplicate);
        const saved = await importedKeyVault.save(parsed.hex, parsed.address);
        // The key is stored. Listing it cannot be allowed to fail the import:
        // if writing the named entry fails, the default entry ("Imported N")
        // is added by reconciliation instead (and again at the next launch).
        const nextState = await addImportedAccountEntry(saved.info.slot, cleanName)
          .then((r) => r.state)
          .catch(async () => reconcileStoredImportedAccounts((await importedKeyVault.list()).keys.map((k) => k.slot)))
          .catch(async () => reconcileImportedAccounts(await loadAccounts(), [...list.keys.map((k) => k.slot), saved.info.slot]).state);
        const rows = { [importedAccountId(saved.info.slot)]: importedRows(saved.info) };
        setDerived((prev) => ({ ...prev, ...rows }));
        derivedRef.current = { ...derivedRef.current, ...rows };
        commitAccounts(nextState);
        const id = importedAccountId(saved.info.slot);
        const storedName = nextState.accounts.find((a) => a.index === id)?.name ?? defaultImportedName(saved.info.slot);
        return {
          account: {
            index: id,
            storedName,
            name: `${storedName}${IMPORTED_NAME_SUFFIX}`,
            hidden: false,
            imported: true,
            watchOnly: false,
            multisig: false,
            multisigInfo: null,
            evmAddress: saved.info.address,
          },
          protectionDetail: saved.protectionDetail,
        };
      }),
    [serialized, commitAccounts],
  );

  const removeImportedAccount = useCallback(
    (index: number) =>
      serialized(async () => {
        const slot = importedSlotOf(index);
        const state = await loadAccounts();
        if (state.activeIndex === index) {
          const name = state.accounts.find((a) => a.index === index)?.name ?? 'This account';
          throw new Error(`${name}${IMPORTED_NAME_SUFFIX} is the active account. Switch to another account first.`);
        }
        // The key first, then the list entry: a failed delete keeps the
        // account listed, so the user can see the key is still there.
        await importedKeyVault.remove(slot);
        const next = await removeImportedAccountEntry(index).catch(async () =>
          reconcileStoredImportedAccounts((await importedKeyVault.list()).keys.map((k) => k.slot)),
        );
        setDerived((prev) => {
          const copy = { ...prev };
          delete copy[index];
          return copy;
        });
        commitAccounts(next);
      }),
    [serialized, commitAccounts],
  );

  const addWatchOnly = useCallback(
    (address: string, name: string | null = null) =>
      serialized(async (): Promise<AccountView> => {
        // The name is checked before anything is stored.
        let cleanName: string | null = null;
        if (name !== null && name.trim() !== '') {
          const validation = sanitizeAccountName(name);
          if (!validation.ok) throw new Error(validation.error);
          cleanName = validation.name;
        }
        const state = await loadAccounts();
        // Every account the wallet holds a key for, hidden ones included,
        // with the address it is known by (the public cache or the
        // imported-key record; no prompt). A phrase account whose address is
        // not known yet is looked up in the public cache first; one that is
        // in neither is skipped (the same known gap as the key import:
        // checking it would need the phrase).
        const list = await importedKeyVault.list().catch(() => ({ keys: [] as ImportedKeyInfo[], damaged: true }));
        const known: KnownAccount[] = [];
        for (const a of state.accounts) {
          if (a.watchOnly) {
            known.push({ name: `${a.name}${WATCH_ONLY_NAME_SUFFIX}`, evmAddress: a.address ?? null, kind: 'watch-only' });
            continue;
          }
          if (a.multisig) {
            known.push({ name: multisigInfo[a.index]?.label ?? a.name, evmAddress: a.address ?? null, kind: 'multisig' });
            continue;
          }
          if (a.imported) {
            const info = list.keys.find((k) => importedAccountId(k.slot) === a.index);
            known.push({ name: `${a.name}${IMPORTED_NAME_SUFFIX}`, evmAddress: info?.address ?? null, kind: 'imported' });
            continue;
          }
          let rows: ChainAccount[] | undefined = derivedRef.current[a.index];
          if (rows === undefined) rows = hydratePublic(await loadPublicAccount(a.index)) ?? undefined;
          known.push({
            name: a.name,
            evmAddress: rows?.find((c) => c.chainId === EVM_SLOT)?.address ?? null,
            kind: 'phrase',
          });
        }
        const checked = checkWatchAddress(address, known);
        if (!checked.ok) throw new Error(checked.error);
        const { state: next, account } = await addWatchOnlyAccountEntry(checked.address, cleanName);
        const rows = { [account.index]: watchOnlyRows(checked.address) };
        setDerived((prev) => ({ ...prev, ...rows }));
        derivedRef.current = { ...derivedRef.current, ...rows };
        commitAccounts(next);
        return {
          index: account.index,
          storedName: account.name,
          name: `${account.name}${WATCH_ONLY_NAME_SUFFIX}`,
          hidden: false,
          imported: false,
          watchOnly: true,
          multisig: false,
          multisigInfo: null,
          evmAddress: checked.address,
        };
      }),
    [serialized, commitAccounts, multisigInfo],
  );

  const removeWatchOnly = useCallback(
    (index: number) =>
      serialized(async () => {
        // Nothing secret exists for a watch-only account: only its list
        // entry (public data) is deleted.
        const next = await removeWatchOnlyAccountEntry(index);
        setDerived((prev) => {
          const copy = { ...prev };
          delete copy[index];
          return copy;
        });
        commitAccounts(next);
      }),
    [serialized, commitAccounts],
  );

  // Uses the key the reveal's approval prompt just opened (no second prompt).
  const revealImportedKey = useCallback(async (index: number) => {
    return importedKeyVault.read(importedSlotOf(index), PROMPTS.importedKeyReveal);
  }, []);

  const signWith = useCallback(
    async <T,>(
      chainId: string,
      expectAddress: string,
      fn: (account: DerivedAccount) => Promise<T>,
    ): Promise<T> => {
      // Feature 10: a watch-only account has no key anywhere in the wallet.
      // Refused FIRST, before the chain lookup and before anything is read
      // from secure storage, so no prompt is shown and nothing is opened.
      assertAccountCanSign(activeIndexRef.current);
      const chain = chainByCaip2(chainId);
      if (!chain) throw new Error(`Unknown chain ${chainId}`);
      const index = activeIndexRef.current;
      if (isImportedAccountId(index)) {
        // An imported account (ADR D9): its own key, from the imported-key
        // vault — the key the approval prompt just opened, or one system
        // prompt when it is protected. EVM chains only, and only if the key
        // controls exactly the prepared address (importedSignerFor). The
        // key bytes are zeroed after the operation; the hex string cannot
        // be (threat-model N-03, the same limit as the phrase).
        if (!chain.provider.chainId.startsWith('eip155:')) throw new Error(IMPORTED_KEY_EVM_ONLY);
        const hex = await importedKeyVault.read(importedSlotOf(index), PROMPTS.importedKeySign);
        const keyBytes = importedKeyBytes(hex);
        try {
          const account = importedSignerFor(chain.provider, keyBytes, expectAddress);
          return await fn(account);
        } finally {
          keyBytes.fill(0);
        }
      }
      // The phrase the approval prompt just opened, or (protected storage,
      // nothing held) one system prompt. Throws PhraseAccessError with a
      // plain-language message when it cannot be opened.
      const mnemonic = await readPhrase(PROMPTS.signFallback);
      if (!mnemonic) throw new Error('No wallet found in secure storage');
      const seed = mnemonicToSeed(mnemonic);
      try {
        // The active account's key, and only if it controls exactly the
        // address the operation was prepared for (see ./accounts.ts).
        const account = deriveSignerFor(chain.provider, seed, index, expectAddress);
        return await fn(account);
      } finally {
        seed.fill(0);
      }
    },
    [],
  );

  const wipe = useCallback(async () => {
    // With an app PIN (duress wallet Stage 2): "Remove wallet" removes BOTH
    // wallets, whichever is open, every per-wallet record of both storage
    // profiles and the PIN record (./duress.ts wipeBothWallets;
    // docs/DURESS_WALLET.md section 7.3). The same resets as below run for
    // each wallet, through stores and vaults bound to its profile.
    if (appPinPresence.get()) {
      const resetRecords = async (store: RemovableKeyValueStore, vault: ProfileVault) => {
        await forgetAllSessions(store, vault.sessionKeys).catch(() => undefined);
        await wipeRecoveryData(store).catch(() => undefined);
        await resetPasskeys(store).catch(() => undefined);
        await resetSpendingLimits(store).catch(() => undefined);
        await forgetBrowserConnections(store).catch(() => undefined);
        await wipeTransactionNotes(store).catch(() => undefined);
        await resetMultisigRecords(store).catch(() => undefined);
        await resetPendingRegistry(store).catch(() => undefined);
        await resetPriceAlerts(store).catch(() => undefined);
        await resetBridgeTransfers(store).catch(() => undefined);
        await wipeInbox(store).catch(() => undefined);
        await resetPendingHandles(store).catch(() => undefined);
        await resetAccounts(store).catch(() => undefined);
      };
      await wipeBothWallets({
        store: AsyncStorage as unknown as SweepableStore,
        backend: appSecureBackend(),
        vaultFor: (profile) => createProfileVault(profile),
        resetRecords,
        publicAccountIndices: ALL_CACHE_INDICES,
      });
      dropPhraseTicket();
      setDerived({});
      setMultisigInfo({});
      commitAccounts(null);
      setPendingMnemonic(null);
      setSessionSlot(null);
      setProfileKey((k) => k + 1);
      setStatus('no-wallet');
      return;
    }
    // Imported private keys (feature 12) first: if deleting them fails, the
    // wipe stops before anything else is removed, so an imported key can
    // never outlive the wallet it belongs to unnoticed.
    await importedKeyVault.removeAll();
    // Session keys (phase 8 item 2) are key material too: delete them from
    // secure storage with the list (best-effort; on-chain grants are not
    // affected — the Sessions screen warns about that before a wipe).
    await forgetAllSessions(AsyncStorage, sessionKeyVault).catch(() => undefined);
    // Recovery records, recoveries in progress and recovered-account
    // attachments are local bookkeeping (no key material); they go with the
    // wallet. Nothing on-chain changes. Settings offers the record export
    // before this runs.
    await wipeRecoveryData(AsyncStorage).catch(() => undefined);
    // Passkey details (phase 8 item 3) are public metadata only (the private
    // key lives in the platform authenticator); they go with the wallet. An
    // installed passkey stays installed on-chain — Settings says so.
    await resetPasskeys(AsyncStorage).catch(() => undefined);
    // Spending limits and their record are per-address settings of this
    // wallet; they go with it.
    await resetSpendingLimits(AsyncStorage).catch(() => undefined);
    // In-app browser connections (feature 79) are public per-site records of
    // this wallet's accounts; they go with it (WalletConnectContext also
    // clears the bridge's memory when the status becomes 'no-wallet').
    await forgetBrowserConnections(AsyncStorage).catch(() => undefined);
    await wipeTransactionNotes(AsyncStorage).catch(() => undefined);
    await resetMultisigRecords(AsyncStorage).catch(() => undefined);
    // The pending-transaction registry holds only hashes, nonces and fees
    // of this wallet's own broadcasts; a wipe forgets them with the rest.
    await resetPendingRegistry(AsyncStorage).catch(() => undefined);
    // The price-alert watchlist holds only asset ids and thresholds; a
    // wipe forgets it with the rest (CTO, phase 20 item 1).
    await resetPriceAlerts(AsyncStorage).catch(() => undefined);
    // Bridge transfers (./bridge.ts) are public records of this wallet's
    // sends; a wipe forgets them with the rest.
    await resetBridgeTransfers(AsyncStorage).catch(() => undefined);
    await wipeInbox(AsyncStorage).catch(() => undefined);
    await resetPendingHandles(AsyncStorage).catch(() => undefined);
    await deleteMnemonic();
    // The public account cache (addresses only) goes with the wallet.
    await deletePublicAccounts(ALL_CACHE_INDICES);
    await resetAccounts().catch(() => undefined);
    setDerived({});
    setMultisigInfo({});
    commitAccounts(null);
    setPendingMnemonic(null);
    setStatus('no-wallet');
  }, [commitAccounts, setSessionSlot]);

  // Accounts the wallet holds a key for. Watch-only and multi-signature
  // accounts are filtered out here on purpose (see the `accountList` doc
  // comment above).
  const accountList = useMemo<AccountView[]>(
    () =>
      (accountsState?.accounts ?? []).filter((a) => !a.watchOnly && !a.multisig).map((a) => ({
        index: a.index,
        name: a.imported ? `${a.name}${IMPORTED_NAME_SUFFIX}` : a.name,
        storedName: a.name,
        hidden: a.hidden,
        imported: a.imported === true,
        watchOnly: false,
        multisig: false,
        multisigInfo: null,
        evmAddress: derived[a.index]?.find((c) => c.chainId === EVM_SLOT)?.address ?? null,
      })),
    [accountsState, derived],
  );

  // Watch-only accounts (feature 10): the name always ends in
  // WATCH_ONLY_NAME_SUFFIX, and the address comes from the account store.
  const watchOnlyAccounts = useMemo<AccountView[]>(
    () =>
      (accountsState?.accounts ?? [])
        .filter((a) => a.watchOnly)
        .map((a) => ({
          index: a.index,
          name: `${a.name}${WATCH_ONLY_NAME_SUFFIX}`,
          storedName: a.name,
          hidden: false,
          imported: false,
          watchOnly: true,
          multisig: false,
          multisigInfo: null,
          evmAddress: a.address ?? null,
        })),
    [accountsState],
  );

  // Multi-signature accounts (feature 24): named as every screen names them
  // ("Multisig 2 (2-of-3)", from the record), the address from the account
  // store (mirrored from the multisig store).
  const multisigAccounts = useMemo<AccountView[]>(
    () =>
      (accountsState?.accounts ?? [])
        .filter((a) => a.multisig)
        .map((a) => {
          const info = multisigInfo[a.index] ?? null;
          return {
            index: a.index,
            name: info?.label ?? a.name,
            storedName: a.name,
            hidden: false,
            imported: false,
            watchOnly: false,
            multisig: true,
            multisigInfo: info,
            evmAddress: a.address ?? null,
          };
        }),
    [accountsState, multisigInfo],
  );

  const activeIndex = accountsState?.activeIndex ?? 0;
  const activeAccount = useMemo(
    () =>
      accountsState
        ? (accountList.find((a) => a.index === activeIndex) ??
          watchOnlyAccounts.find((a) => a.index === activeIndex) ??
          multisigAccounts.find((a) => a.index === activeIndex) ??
          null)
        : null,
    [accountsState, accountList, watchOnlyAccounts, multisigAccounts, activeIndex],
  );
  const accounts = useMemo(() => derived[activeIndex] ?? [], [derived, activeIndex]);

  // Searches `accountList` only: a watched address is never "one of your
  // accounts" (WalletConnect labels and bindings, recovery screens).
  const accountForEvmAddress = useCallback(
    (address: string) => {
      const lower = address.toLowerCase();
      return accountList.find((a) => a.evmAddress?.toLowerCase() === lower) ?? null;
    },
    [accountList],
  );

  // Records backup (feature 47): one device prompt opens the phrase for this
  // derivation only (target 'phrase', whatever the active account's own
  // approval target is); see ./storage.ts deriveRecordsBackupKey.
  const deriveRecordsBackupKey = useCallback(
    (salt: Uint8Array, purpose: 'export' | 'import') =>
      deriveRecordsBackupKeyInVault({
        activeAccountId: activeIndexRef.current,
        prompt: RECORDS_BACKUP_PROMPTS[purpose],
        salt,
        gate: requireLocalAuth,
      }),
    [],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      accounts,
      activeAccount,
      accountList,
      watchOnlyAccounts,
      multisigAccounts,
      accountForEvmAddress,
      switchAccount,
      addAccount,
      addWatchOnly,
      removeWatchOnly,
      renameAccount,
      hideAccount,
      unhideAccount,
      importPrivateKey,
      removeImportedAccount,
      revealImportedKey,
      pendingMnemonic,
      beginCreate,
      cancelCreate,
      confirmCreate,
      importExisting,
      revealMnemonic,
      signWith,
      wipe,
      awaitingPin,
      unlockWithPin,
      pinSessionSlot,
      profileKey,
      turnOnAppPin,
      changeAppPin,
      turnOffAppPin,
      duressPinSet,
      addDuressPin,
      changeDuressPin,
      removeDuressPin,
      switchAppLockKind,
      deriveRecordsBackupKey,
    }),
    [
      status,
      accounts,
      activeAccount,
      accountList,
      watchOnlyAccounts,
      multisigAccounts,
      accountForEvmAddress,
      switchAccount,
      addAccount,
      addWatchOnly,
      removeWatchOnly,
      renameAccount,
      hideAccount,
      unhideAccount,
      importPrivateKey,
      removeImportedAccount,
      revealImportedKey,
      pendingMnemonic,
      beginCreate,
      cancelCreate,
      confirmCreate,
      importExisting,
      revealMnemonic,
      signWith,
      wipe,
      awaitingPin,
      unlockWithPin,
      pinSessionSlot,
      profileKey,
      turnOnAppPin,
      changeAppPin,
      turnOffAppPin,
      duressPinSet,
      addDuressPin,
      changeDuressPin,
      removeDuressPin,
      switchAppLockKind,
      deriveRecordsBackupKey,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside WalletProvider');
  return ctx;
}

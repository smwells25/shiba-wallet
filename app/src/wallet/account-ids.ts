/**
 * Account ids: which accounts come from the recovery phrase and which come
 * from an imported private key (Tier 1 feature 12; ADR D9 in
 * docs/ARCHITECTURE.md).
 *
 * Every account in the wallet has one numeric id, the `index` field the
 * account store, the navigator key, the WalletConnect bindings and the
 * per-account caches already use. There are two disjoint ranges:
 *
 *  - 0 to 2^31 - 1: an account DERIVED from the recovery phrase. The id is
 *    its derivation index N (ADR D8, accounts.ts derivationArgsFor), and its
 *    smart account uses salt N (ADR D4).
 *  - 2^31 + k (k = 0, 1, 2, …): an account whose key was IMPORTED into slot
 *    k of the imported-key vault (storage.ts). Its id is not a derivation
 *    index. derivationArgsFor refuses every id at or above 2^31 (it is not a
 *    valid BIP-32 index for the hardened segments of Bitcoin, Dogecoin and
 *    Solana, and accounts.ts checks the bound for every chain), so any code
 *    path that tries to derive a key for an imported account from the
 *    phrase fails closed with an error instead of silently using a phrase
 *    key that happens to share the number.
 *  - 3 × 2^30 + k (k = 0, 1, 2, …): a WATCH-ONLY account (feature 10): an
 *    Ethereum address the user asked to follow, with NO key anywhere in the
 *    wallet. Its id is neither a derivation index nor an imported-key slot:
 *    derivationArgsFor refuses it (it is at or above 2^31), the imported-key
 *    helpers refuse it (it is outside the imported range, which
 *    isImportedAccountId bounds exactly), smartAccountSaltFor refuses it,
 *    and assertAccountCanSign refuses it before signing reads anything.
 *  - 13 × 2^28 + k (0xD0000000 + k, k = 0, 1, 2, …): a MULTI-SIGNATURE
 *    account (feature 24, phase 17 item 1): a Kernel v3.3 account whose
 *    root validator is the weighted signer module, so NO single key in this
 *    wallet controls it. Its id is neither a derivation index, an
 *    imported-key slot nor a watch-only slot: derivationArgsFor refuses it
 *    (it is at or above 2^31), the imported-key and watch-only helpers
 *    refuse it (it is outside both of their exactly bounded ranges),
 *    smartAccountSaltFor refuses it (the multisig IS the smart account; its
 *    CREATE2 index lives in its record, ./multisig.ts), and
 *    assertAccountCanSign refuses it before signing reads anything (its
 *    operations are approved by co-signers on the Multisig screen).
 *
 * This module has no imports so that every other module (including the
 * Node-loaded check scripts) can use it without pulling in React Native.
 */

/** First id of the imported range: 2^31, the first value derivationArgsFor refuses. */
export const IMPORTED_ACCOUNT_ID_BASE = 0x80000000;

/**
 * Highest imported slot number the id range allows. Slots are never reused
 * (the vault keeps a high-water mark), so this bounds imports over the
 * wallet's whole life, far above the cap on keys held at once.
 */
export const MAX_IMPORTED_SLOT = 0xfffff;

/** True for an id in the imported range (a well-formed one). */
export function isImportedAccountId(id: number): boolean {
  return (
    Number.isSafeInteger(id) &&
    id >= IMPORTED_ACCOUNT_ID_BASE &&
    id - IMPORTED_ACCOUNT_ID_BASE <= MAX_IMPORTED_SLOT
  );
}

/**
 * First id of the watch-only range: 3 × 2^30. It sits far above the whole
 * imported range (2^31 to 2^31 + MAX_IMPORTED_SLOT), so the two ranges can
 * never overlap, and below 2^32, so every id stays an ordinary safe integer.
 */
export const WATCH_ONLY_ACCOUNT_ID_BASE = 0xc0000000;

/**
 * Highest watch-only slot number the id range allows. Like imported slots,
 * watch-only slots are never reused (the account store keeps a high-water
 * mark), so a per-account cache keyed by the id can never show one watched
 * address's data under another.
 */
export const MAX_WATCH_ONLY_SLOT = 0xfffff;

/** True for an id in the watch-only range (a well-formed one). */
export function isWatchOnlyAccountId(id: number): boolean {
  return (
    Number.isSafeInteger(id) &&
    id >= WATCH_ONLY_ACCOUNT_ID_BASE &&
    id - WATCH_ONLY_ACCOUNT_ID_BASE <= MAX_WATCH_ONLY_SLOT
  );
}

/** The account id of watch-only slot `slot`. */
export function watchOnlyAccountId(slot: number): number {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot > MAX_WATCH_ONLY_SLOT) {
    throw new Error(`Invalid watch-only slot ${String(slot)}.`);
  }
  return WATCH_ONLY_ACCOUNT_ID_BASE + slot;
}

/** The watch-only slot of a watch-only account id; throws for any other id. */
export function watchOnlySlotOf(id: number): number {
  if (!isWatchOnlyAccountId(id)) throw new Error(`Account ${String(id)} is not a watch-only account.`);
  return id - WATCH_ONLY_ACCOUNT_ID_BASE;
}

/** True for an id in the recovery-phrase range: a BIP-32 derivation index (0 to 2^31 - 1). */
export function isPhraseAccountId(id: number): boolean {
  return Number.isSafeInteger(id) && id >= 0 && id < IMPORTED_ACCOUNT_ID_BASE;
}

/** The account id of imported-key vault slot `slot`. */
export function importedAccountId(slot: number): number {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot > MAX_IMPORTED_SLOT) {
    throw new Error(`Invalid imported-key slot ${String(slot)}.`);
  }
  return IMPORTED_ACCOUNT_ID_BASE + slot;
}

/** The imported-key vault slot of an imported account id; throws for any other id. */
export function importedSlotOf(id: number): number {
  if (!isImportedAccountId(id)) throw new Error(`Account ${String(id)} is not an imported-key account.`);
  return id - IMPORTED_ACCOUNT_ID_BASE;
}

/**
 * The CREATE2 salt of an account's smart account (SimpleAccount salt or
 * Kernel index).
 *
 *  - A derived account N uses salt N (ADR D4 and D8), unchanged.
 *  - An imported account uses salt 0. Uniqueness does not need the id,
 *    because the owner key already differs from every other account's, and a
 *    fixed salt needs no bookkeeping: whoever holds the imported key can
 *    recompute the address from the key, the factory and index 0 alone.
 *    The address is NOT recoverable from the recovery phrase: it is a
 *    function of the imported key, which the phrase does not contain.
 */
export function smartAccountSaltFor(id: number): number {
  // A watch-only account has no key, so it can own no smart account: any
  // address computed for it would be one the wallet can never sign for.
  if (isWatchOnlyAccountId(id)) throw new Error(WATCH_ONLY_NO_SMART_ACCOUNT);
  // A multi-signature account is itself the smart account; it has no owner
  // key whose salt could be taken (its CREATE2 index is in its record).
  if (isMultisigAccountId(id)) throw new Error(MULTISIG_NO_SMART_ACCOUNT);
  if (isImportedAccountId(id)) return 0;
  if (!Number.isSafeInteger(id) || id < 0 || id >= IMPORTED_ACCOUNT_ID_BASE) {
    throw new Error(`Invalid account index ${String(id)}.`);
  }
  return id;
}

/**
 * The `path` an imported key's account carries where a derivation path
 * would be (core DerivedAccount.path, the Home and Receive rows). It is not
 * a BIP-32 path on purpose, so every place that records paths
 * (isBip32Path below) leaves it out.
 */
export const IMPORTED_KEY_PATH = 'imported-key';

const BIP32 = /^m(\/[0-9]+'?){1,8}$/;

/** True for a BIP-32 path such as m/44'/60'/0'/0/3; false for IMPORTED_KEY_PATH. */
export function isBip32Path(path: string | null | undefined): path is string {
  return typeof path === 'string' && BIP32.test(path);
}

/** "Imported 1" for slot 0, "Imported 2" for slot 1, and so on. */
export function defaultImportedName(slot: number): string {
  return `Imported ${slot + 1}`;
}

/**
 * The label appended to an imported account's name everywhere it is shown
 * (AccountView.name in WalletContext), so no screen can show the account
 * without saying where its key came from.
 */
export const IMPORTED_NAME_SUFFIX = ' (imported key)';

/**
 * The Chairperson's condition (2026-10-04), in the words every screen that
 * shows an imported account uses.
 */
export const IMPORTED_KEY_NOT_BACKED_UP =
  'This account comes from an imported private key. Your recovery phrase does NOT back it up: if ' +
  'this phone is lost or the wallet is removed, the account and its funds are lost unless you kept ' +
  'the private key yourself.';

/** Shown where a non-Ethereum chain would be for an imported account. */
export const IMPORTED_KEY_NO_CHAIN =
  'Not available for an imported key. An imported Ethereum private key has an Ethereum address ' +
  'only; use an account from your recovery phrase for this network.';

/** Thrown by signing for any non-EVM chain while an imported account is active. */
export const IMPORTED_KEY_EVM_ONLY =
  'This account comes from an imported Ethereum private key, so it can only sign on Ethereum ' +
  'networks. Nothing was signed.';

// ---------------------------------------------------------------------------
// Watch-only accounts (feature 10)
// ---------------------------------------------------------------------------

/**
 * The `path` a watch-only account carries where a derivation path would be
 * (core DerivedAccount.path, the Home row). Not a BIP-32 path on purpose,
 * so isBip32Path is false for it and nothing records it as one.
 */
export const WATCH_ONLY_PATH = 'watch-only';

/** "Watched 1" for slot 0, "Watched 2" for slot 1, and so on. */
export function defaultWatchOnlyName(slot: number): string {
  return `Watched ${slot + 1}`;
}

/**
 * The label appended to a watch-only account's name everywhere it is shown
 * (AccountView.name in WalletContext), so no screen can show the account
 * without saying the wallet holds no key for it.
 */
export const WATCH_ONLY_NAME_SUFFIX = ' (watch-only)';

/** The notice on Home and in the account lists while a watch-only account is shown. */
export const WATCH_ONLY_NOTICE =
  'Watch-only: this wallet can show this address but holds no key for it. It cannot send, sign or ' +
  'recover anything for it.';

/** Thrown by every signing path while a watch-only account is active (WalletContext.signWith). */
export const WATCH_ONLY_SIGN_REFUSAL =
  'This is a watch-only account: the wallet holds no key for it, so it cannot sign or send. Nothing ' +
  'was signed.';

/** Thrown by smartAccountSaltFor for a watch-only id. */
export const WATCH_ONLY_NO_SMART_ACCOUNT =
  'A watch-only account has no key, so it cannot own a smart account in this wallet.';

/** Thrown by derivationArgsFor for a watch-only id. */
export const WATCH_ONLY_NO_DERIVATION =
  'A watch-only account has no key and no derivation path; nothing can be derived for it.';

/** Shown where a non-Ethereum chain would be for a watch-only account. */
export const WATCH_ONLY_NO_CHAIN =
  'Not available for a watch-only address. A watched Ethereum address has no address on this network.';

/**
 * Refuses, before anything is read from secure storage, every signing
 * request for an account id that has no key in this wallet: a watch-only
 * account (with the plain sentence above), a multi-signature account (no
 * single key signs for it), or any id outside the phrase and imported
 * ranges (a malformed id). Called first by
 * WalletContext.signWith; phrase and imported ids pass unchanged.
 */
export function assertAccountCanSign(id: number): void {
  if (isWatchOnlyAccountId(id)) throw new Error(WATCH_ONLY_SIGN_REFUSAL);
  if (isMultisigAccountId(id)) throw new Error(MULTISIG_SIGN_REFUSAL);
  if (!isPhraseAccountId(id) && !isImportedAccountId(id)) {
    throw new Error(`Invalid account index ${String(id)}.`);
  }
}

// ---------------------------------------------------------------------------
// Multi-signature accounts (feature 24, phase 17 item 1)
// ---------------------------------------------------------------------------

/**
 * First id of the multi-signature range: 0xD0000000 (13 × 2^28). It sits
 * above the whole watch-only range (0xC0000000 to 0xC0000000 +
 * MAX_WATCH_ONLY_SLOT) and below 2^32, so the four ranges never overlap and
 * every id stays an ordinary safe integer.
 */
export const MULTISIG_ACCOUNT_ID_BASE = 0xd0000000;

/**
 * Highest multi-signature slot number the id range allows. Slots are never
 * reused (the multisig store keeps a high-water mark), so a per-account
 * cache keyed by the id can never show one multisig's data under another.
 */
export const MAX_MULTISIG_SLOT = 0xfffff;

/** True for an id in the multi-signature range (a well-formed one). */
export function isMultisigAccountId(id: number): boolean {
  return Number.isSafeInteger(id) && id >= MULTISIG_ACCOUNT_ID_BASE && id - MULTISIG_ACCOUNT_ID_BASE <= MAX_MULTISIG_SLOT;
}

/** The account id of multi-signature slot `slot`. */
export function multisigAccountId(slot: number): number {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot > MAX_MULTISIG_SLOT) {
    throw new Error(`Invalid multisig slot ${String(slot)}.`);
  }
  return MULTISIG_ACCOUNT_ID_BASE + slot;
}

/** The multi-signature slot of a multisig account id; throws for any other id. */
export function multisigSlotOf(id: number): number {
  if (!isMultisigAccountId(id)) throw new Error(`Account ${String(id)} is not a multi-signature account.`);
  return id - MULTISIG_ACCOUNT_ID_BASE;
}

/** "Multisig 1" for slot 0, "Multisig 2" for slot 1, and so on. */
export function defaultMultisigName(slot: number): string {
  return `Multisig ${slot + 1}`;
}

/**
 * The `path` a multi-signature account carries where a derivation path
 * would be. Not a BIP-32 path on purpose (isBip32Path is false for it).
 */
export const MULTISIG_PATH = 'multisig';

/** Thrown by every signing path while a multi-signature account is active. */
export const MULTISIG_SIGN_REFUSAL =
  'This is a multi-signature account: no single key in this wallet can sign for it. Its operations are ' +
  'approved by its co-signers and submitted from the Multisig screen. Nothing was signed.';

/** Thrown by smartAccountSaltFor for a multi-signature id. */
export const MULTISIG_NO_SMART_ACCOUNT =
  'A multi-signature account is itself a smart account; it has no owner key and no salt of its own in ' +
  'this wallet.';

/** Thrown by derivationArgsFor for a multi-signature id. */
export const MULTISIG_NO_DERIVATION =
  'A multi-signature account has no key and no derivation path; nothing can be derived for it.';

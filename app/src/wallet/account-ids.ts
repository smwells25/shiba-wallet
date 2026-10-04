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

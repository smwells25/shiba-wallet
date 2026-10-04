// Single private-key import (Tier 1 feature 12; ADR D9 in
// docs/ARCHITECTURE.md). Pure functions over the engine's key code, kept
// free of React Native so scripts/check-key-import.mjs runs this exact file
// under Node's type stripping.
//
// The Chairperson approved the feature (2026-10-04) on the condition that an
// imported account is labelled everywhere as NOT covered by the recovery
// phrase; the sentences shared by every screen live in ./account-ids.ts.

import type { ChainKeyProvider, DerivedAccount } from '@shiba-wallet/core';
import { evmAccountFromPrivateKey, isValidEvmPrivateKey, publicKeyToEvmAddress } from '@shiba-wallet/core';
import { ACCOUNT_CHANGED_MESSAGE } from './accounts.ts';
import { IMPORTED_KEY_EVM_ONLY, IMPORTED_KEY_PATH } from './account-ids.ts';

export type ParsedPrivateKey =
  | {
      ok: true;
      /** Canonical form stored in the vault: 0x + 64 lowercase hex. */
      hex: string;
      /** EIP-55 address, computed by core (noble). */
      address: string;
    }
  | { ok: false; error: string };

export const KEY_EMPTY_ERROR = 'Paste or scan an Ethereum private key.';
export const KEY_LOOKS_LIKE_PHRASE_ERROR =
  'This looks like a recovery phrase, not a private key. Only single Ethereum private keys can be ' +
  'imported here; a recovery phrase replaces the whole wallet and is entered when the wallet is set up.';
export const KEY_NOT_HEX_ERROR =
  'A private key contains only the characters 0–9 and a–f (it may start with 0x). Check what was pasted.';
export const KEY_ZERO_ERROR = 'This value is zero, which is not a valid private key.';
export const KEY_OUT_OF_RANGE_ERROR =
  'This value is not a valid Ethereum private key: it is not below the secp256k1 curve order.';
export const KEY_ADDRESS_INSTEAD_ERROR =
  'This is an Ethereum address (40 characters), not a private key (64 characters). An address cannot ' +
  'be imported as an account.';

export function keyLengthError(length: number): string {
  return (
    'An Ethereum private key is 64 hexadecimal characters (32 bytes), optionally starting with 0x. ' +
    `This one has ${length}.`
  );
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Validates pasted, typed or scanned text as an EVM private key, with the
 * engine's own range check (core isValidEvmPrivateKey → @noble/curves
 * secp256k1.utils.isValidSecretKey: 1 ≤ key < n) and address derivation
 * (core publicKeyToEvmAddress). Accepts 64 hex characters with or without
 * 0x, in any letter case, with surrounding whitespace. Nothing else is
 * accepted: no other encodings, no keystore files, no other chains.
 */
export function parsePrivateKeyInput(raw: string): ParsedPrivateKey {
  const text = raw.trim();
  if (text === '') return { ok: false, error: KEY_EMPTY_ERROR };
  if (/\s/.test(text) && text.split(/\s+/).length >= 12 && /^[a-z\s]+$/i.test(text)) {
    return { ok: false, error: KEY_LOOKS_LIKE_PHRASE_ERROR };
  }
  const body = /^0x/i.test(text) ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]*$/.test(body)) return { ok: false, error: KEY_NOT_HEX_ERROR };
  if (body.length === 40) return { ok: false, error: KEY_ADDRESS_INSTEAD_ERROR };
  if (body.length !== 64) return { ok: false, error: keyLengthError(body.length) };
  const lower = body.toLowerCase();
  const bytes = hexToBytes(lower);
  try {
    if (bytes.every((b) => b === 0)) return { ok: false, error: KEY_ZERO_ERROR };
    if (!isValidEvmPrivateKey(bytes)) return { ok: false, error: KEY_OUT_OF_RANGE_ERROR };
    return { ok: true, hex: `0x${lower}`, address: publicKeyToEvmAddress(bytes) };
  } finally {
    bytes.fill(0);
  }
}

/** An account the import is checked against (public data only). */
export interface ExistingAccount {
  name: string;
  imported: boolean;
  evmAddress: string | null;
}

/**
 * Refuses an import whose address is already in the wallet: one of the
 * listed accounts from the recovery phrase (hidden ones included), or an
 * imported key. Returns the plain sentence, or null when the key is new.
 * Only LISTED phrase accounts can be checked; a key that equals a phrase
 * account the user has not added yet cannot be recognised without deriving
 * every possible index.
 */
export function duplicateImportError(address: string, accounts: readonly ExistingAccount[]): string | null {
  const lower = address.toLowerCase();
  const match = accounts.find((a) => a.evmAddress?.toLowerCase() === lower);
  if (!match) return null;
  if (match.imported) {
    return `This key is already imported as ${match.name} (${match.evmAddress}). It was not imported again.`;
  }
  return (
    `This key belongs to ${match.name} (${match.evmAddress}), which already comes from your recovery ` +
    'phrase. It is already in this wallet, so it was not imported.'
  );
}

/**
 * The signing half of WalletContext.signWith for an imported account, kept
 * pure so the check script runs the exact code: builds the engine's
 * DerivedAccount for the key (core evmAccountFromPrivateKey — the same
 * signing closure as a derived EVM key) and refuses — before any signing —
 * unless the provider is an EVM one and the key controls exactly the
 * address the operation was prepared for. The caller zeroes `keyBytes`
 * after the operation and must not retain the returned account.
 */
export function importedSignerFor(
  provider: ChainKeyProvider,
  keyBytes: Uint8Array,
  expectAddress: string,
): DerivedAccount {
  if (!provider.chainId.startsWith('eip155:')) throw new Error(IMPORTED_KEY_EVM_ONLY);
  const account = evmAccountFromPrivateKey(keyBytes, IMPORTED_KEY_PATH);
  if (account.address.toLowerCase() !== expectAddress.toLowerCase()) {
    throw new Error(ACCOUNT_CHANGED_MESSAGE);
  }
  return account;
}

/** 0x + 64 hex → 32 bytes (the caller zeroes them). */
export function importedKeyBytes(hex: string): Uint8Array {
  if (!/^0x[0-9a-f]{64}$/.test(hex)) throw new Error('The stored imported key is malformed.');
  return hexToBytes(hex.slice(2));
}

// ---------------------------------------------------------------------------
// Screen copy (pinned by scripts/check-key-import.mjs)
// ---------------------------------------------------------------------------

export const IMPORT_KEY_INTRO =
  'Add an Ethereum account from a single private key, for example one exported from another ' +
  'wallet. Only Ethereum-network private keys (64 hexadecimal characters) can be imported; Bitcoin, ' +
  'Dogecoin and Solana keys are not supported, and an imported account has no address on those ' +
  'networks.';

export const IMPORT_KEY_TRUST_WARNING =
  'Only import a key on a phone you trust. Anyone who has this key controls the account, and it is ' +
  'stored only in this phone’s secure storage.';

export const IMPORT_KEY_CLIPBOARD_WARNING =
  'If you copied the key, it may still be on the clipboard, where other apps can read it. Use Clear ' +
  'clipboard below, and check that a keyboard clipboard history did not keep a copy.';

export const IMPORT_KEY_SAVED_TITLE = 'Private key imported';

export function importKeySavedMessage(name: string, address: string, protectionDetail: string | null): string {
  const storage = protectionDetail
    ? ` It is in standard secure storage because biometric protection was not possible (${protectionDetail}); Settings → Recovery phrase protection can try again.`
    : '';
  return (
    `${name} (${address}) was added. Your recovery phrase does NOT back up this account: keep the ` +
    `private key somewhere safe yourself.${storage} ${IMPORT_KEY_CLIPBOARD_WARNING}`
  );
}

export const REMOVE_IMPORTED_TITLE = 'Remove this imported account?';

export function removeImportedMessage(name: string, address: string): string {
  return (
    `This deletes the private key of ${name} (${address}) from this phone. Your recovery phrase cannot ` +
    'bring it back: unless you kept the private key yourself, this account and everything it holds ' +
    'will be lost for good. Funds on-chain are not moved.'
  );
}

export const REMOVE_IMPORTED_CONFIRM_TITLE = 'Delete the private key?';
export const REMOVE_IMPORTED_CONFIRM_MESSAGE =
  'Only continue if you have the private key written down or stored elsewhere, or the account is empty.';

export const REVEAL_IMPORTED_TITLE = 'Show this private key?';
export const REVEAL_IMPORTED_MESSAGE =
  'Make sure no one can see your screen. Anyone who sees this key controls the account. Keeping a ' +
  'copy of it is the only backup this account has.';

export const REVEAL_IMPORTED_COPY_NOTE =
  'Copy places the key on the clipboard, which other apps can read; the wallet empties the clipboard ' +
  '60 seconds after you copy (or when you return to the wallet after that) and when you close this ' +
  'view. Keyboards that keep a clipboard history of their own may still hold a copy.';

import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export type MnemonicStrength = 128 | 160 | 192 | 224 | 256;

/**
 * Generates a new BIP-39 mnemonic. 128 bits = 12 words, 256 bits = 24 words.
 * This is the single root secret of the wallet: every asset on every chain
 * derives from it, so it is the only thing a user must back up.
 */
export function createMnemonic(strength: MnemonicStrength = 128): string {
  return generateMnemonic(wordlist, strength);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

/**
 * Converts a mnemonic (plus optional BIP-39 passphrase) to the 64-byte seed
 * that feeds BIP-32 / SLIP-0010 derivation. Throws on invalid mnemonics so a
 * mistyped backup can never silently derive a different wallet.
 */
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Uint8Array {
  if (!isValidMnemonic(mnemonic)) {
    throw new Error('Invalid BIP-39 mnemonic (bad word or checksum)');
  }
  return mnemonicToSeedSync(mnemonic, passphrase);
}

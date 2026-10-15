import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  bip85Bip39Path,
  bip85ChildMnemonic,
  bip85Entropy,
  bip85MnemonicFromRoot,
  mnemonicWordCount,
} from '../src/index.js';

// Every official BIP-85 vector that this module implements, copied verbatim
// from bitcoin/bips bip-0085.mediawiki at commit
// 6209768676bf85d7ef5ffb4055543d6286d79b96 (fetched 2026-10-14; the file's
// sha256 is dcbeb97709eba4751f4af7dc582c35dff37dc831abb5adc5e2e975d708d1cf7e):
// the two raw-entropy test cases of the specification section and the three
// mnemonics of the BIP39 application (12, 18 and 24 English words; see the
// note above MNEMONIC_CASES for how the words are pinned). Every vector uses
// the same master root key.
const MASTER =
  'xprv9s21ZrQH143K2LBWUUQRFXhucrQqBpKdRRxNVq2zBqsx8HVqFk2uYo8kmbaLLHRdqtQpUm98uKfu3vca1LqdGhUtyoFnCNkfmXRyPXLjbKb';

const ENTROPY_CASES = [
  {
    path: "m/83696968'/0'/0'",
    derivedKey: 'cca20ccb0e9a90feb0912870c3323b24874b0ca3d8018c4b96d0b97c0e82ded0',
    entropy:
      'efecfbccffea313214232d29e71563d941229afb4338c21f9517c41aaa0d16f00b83d2a09ef747e7a64e8e2bd5a14869e693da66ce94ac2da570ab7ee48618f7',
  },
  {
    path: "m/83696968'/0'/1'",
    derivedKey: '503776919131758bb7de7beb6c0ae24894f4ec042c26032890c29359216e21ba',
    entropy:
      '70c6e3e8ebee8dc4c0dbba66076819bb8c09672527c4277ca8729532ad711872218f826919f6b67218adde99018a6df9095ab2b58d803b5b93ec9802085a690e',
  },
] as const;

// The three mnemonics are pinned by their official derived entropy and by a
// SHA-256 fingerprint of the specification's "DERIVED BIP39 MNEMONIC" text
// (computed from the fetched file at the commit above), not as literal words:
// the repository's pre-commit secret scan refuses any checksum-valid BIP-39
// phrase in a file (scripts/githooks/secret-scan.mjs), and these public
// vectors are no exception to its rule. The test checks the derived phrase
// against @scure/bip39's encoding of the official entropy AND against the
// fingerprint of the official text, so the exact published words are still
// what is compared.
const MNEMONIC_CASES = [
  {
    words: 12,
    path: "m/83696968'/39'/0'/12'/0'",
    entropy: '6250b68daf746d12a24d58b4787a714b',
    mnemonicSha256: 'e285fb84baf748609438a466fba70eb2b6015102935916538252d3d12e39db3b',
  },
  {
    words: 18,
    path: "m/83696968'/39'/0'/18'/0'",
    entropy: '938033ed8b12698449d4bbca3c853c66b293ea1b1ce9d9dc',
    mnemonicSha256: 'c82438aed0dfddd9baf083438660bf6fdf7dce4d55183b04e92687814fa64286',
  },
  {
    words: 24,
    path: "m/83696968'/39'/0'/24'/0'",
    entropy: 'ae131e2312cdc61331542efe0d1077bac5ea803adf24b313a4f0e48e9c51f37f',
    mnemonicSha256: '00127ffb45c4ad442451405cbc2bea8052c525d9339a3d040692297bd86d7ff6',
  },
] as const;

const sha256Hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

describe('BIP-85 (official vectors, bitcoin/bips 62097686)', () => {
  const root = () => HDKey.fromExtendedKey(MASTER);

  for (const c of ENTROPY_CASES) {
    it(`test case ${c.path}: derived key and 64 bytes of entropy`, () => {
      const out = bip85Entropy(root(), c.path);
      expect(bytesToHex(out.derivedKey)).toBe(c.derivedKey);
      expect(bytesToHex(out.entropy)).toBe(c.entropy);
      expect(out.entropy.length).toBe(64);
    });
  }

  for (const c of MNEMONIC_CASES) {
    it(`BIP39 application, ${c.words} English words`, () => {
      expect(bip85Bip39Path(c.words, 0)).toBe(c.path);
      // The specified truncation: the first words/3*4 bytes of the entropy.
      const { entropy } = bip85Entropy(root(), c.path);
      expect(bytesToHex(entropy.slice(0, c.entropy.length / 2))).toBe(c.entropy);
      const mnemonic = bip85MnemonicFromRoot(root(), c.words, 0);
      expect(mnemonic).toBe(entropyToMnemonic(hexToBytes(c.entropy), wordlist));
      expect(sha256Hex(mnemonic)).toBe(c.mnemonicSha256);
      expect(mnemonic.split(' ')).toHaveLength(c.words);
    });
  }

  it('a different index gives a different child, and index 1 of 12 words is stable', () => {
    const a = bip85MnemonicFromRoot(root(), 12, 0);
    const b = bip85MnemonicFromRoot(root(), 12, 1);
    expect(a).not.toBe(b);
    expect(bip85MnemonicFromRoot(root(), 12, 1)).toBe(b);
  });

  it('refuses a non-hardened path, a derived (non-root) key, bad word counts and indices', () => {
    expect(() => bip85Entropy(root(), "m/83696968'/0/0'")).toThrow(/hardened/);
    expect(() => bip85Entropy(root().deriveChild(0x80000000), "m/83696968'/0'/0'")).toThrow(/master root/);
    expect(() => bip85Bip39Path(13 as 12, 0)).toThrow();
    expect(() => bip85Bip39Path(12, -1)).toThrow();
    expect(() => bip85Bip39Path(12, 0x80000000)).toThrow();
    expect(() => bip85Bip39Path(12, 1.5)).toThrow();
  });
});

describe('bip85ChildMnemonic (from a parent phrase, as the decoy wallet uses it)', () => {
  // The BIP-39 reference phrase "abandon × 11 + about" (12 words) and its
  // 24-word counterpart, both public test phrases.
  const PARENT_12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const PARENT_24 =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

  it('equals the root-key derivation from the parent\'s BIP-39 seed (no passphrase)', () => {
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(PARENT_12, ''));
    expect(bip85ChildMnemonic(PARENT_12, 0)).toBe(bip85MnemonicFromRoot(root, 12, 0));
  });

  it('keeps the parent\'s word count (12 → 12, 24 → 24) unless one is given', () => {
    expect(bip85ChildMnemonic(PARENT_12, 0).split(' ')).toHaveLength(12);
    expect(bip85ChildMnemonic(PARENT_24, 0).split(' ')).toHaveLength(24);
    expect(bip85ChildMnemonic(PARENT_12, 0, 24).split(' ')).toHaveLength(24);
    expect(mnemonicWordCount(PARENT_24)).toBe(24);
  });

  it('is a valid phrase different from the parent, and tolerates extra whitespace in the parent', () => {
    const child = bip85ChildMnemonic(PARENT_12, 0);
    expect(child).not.toBe(PARENT_12);
    expect(mnemonicWordCount(child)).toBe(12);
    expect(bip85ChildMnemonic(`  ${PARENT_12.split(' ').join('   ')} `, 0)).toBe(child);
  });

  it('refuses an invalid parent phrase', () => {
    expect(() => bip85ChildMnemonic('abandon abandon abandon', 0)).toThrow(/Invalid BIP-39/);
  });
});

import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * BIP-85, "Deterministic Entropy From BIP32 Keychains", for the BIP-39
 * application (application number 39).
 *
 * Source: bitcoin/bips, bip-0085.mediawiki at commit
 * 6209768676bf85d7ef5ffb4055543d6286d79b96 (the newest commit touching the
 * file on 2026-10-14; sha256 of the file
 * dcbeb97709eba4751f4af7dc582c35dff37dc831abb5adc5e2e975d708d1cf7e).
 *
 * The specification, quoted:
 *  - "For each application that requires its own wallet, a unique private
 *    key is derived from the BIP32 master root key using a fully hardened
 *    derivation path. The resulting private key (k) is then processed with
 *    HMAC-SHA512, where the key is "bip-entropy-from-k", and the message
 *    payload is the private key k: HMAC-SHA512(key="bip-entropy-from-k",
 *    msg=k)".
 *  - "The result produces 512 bits of entropy. Each application SHOULD use
 *    up to the required number of bits necessary for their operation, and
 *    truncate the rest."
 *  - BIP39: "Truncate trailing (least significant) bytes of the entropy to
 *    the number of bits required to map to the relevant word length: 128
 *    bits for 12 words, 256 bits for 24 words." The path is
 *    m/83696968'/39'/{language}'/{words}'/{index}', with English = 0' and
 *    the words table 12 / 15 / 18 / 21 / 24 words = 128 / 160 / 192 / 224 /
 *    256 bits.
 *
 * Why the wallet uses it (docs/DURESS_WALLET.md section 7.2): the decoy
 * wallet of a duress PIN is the BIP-85 child at index 0 of the real
 * recovery phrase, so the one written phrase backs up both, while the
 * child phrase cannot be turned back into the parent (the HMAC step above).
 *
 * Only English is supported: it is the only wordlist the wallet ships for
 * its own phrases (keyring/mnemonic.ts). Byte handling is plain Uint8Array
 * slicing; nothing here converts to bigint. Built only on @scure/bip32,
 * @scure/bip39 and @noble/hashes, as the rest of the keyring.
 */

/** BIP-85's purpose number, 83696968 (the ASCII sequence "SEED"). */
export const BIP85_PURPOSE = 83696968;
/** The BIP-39 application number. */
export const BIP85_APP_BIP39 = 39;
/** The HMAC key, as the specification writes it. */
export const BIP85_HMAC_KEY = 'bip-entropy-from-k';
/** Language code for English in the BIP-39 application's language table. */
export const BIP85_LANGUAGE_ENGLISH = 0;

/** The word counts of the specification's words table. */
export type Bip85WordCount = 12 | 15 | 18 | 21 | 24;

const ENTROPY_BYTES: Record<Bip85WordCount, number> = { 12: 16, 15: 20, 18: 24, 21: 28, 24: 32 };
const HARDENED = 0x80000000;

function isWordCount(n: number): n is Bip85WordCount {
  return n === 12 || n === 15 || n === 18 || n === 21 || n === 24;
}

function assertIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED) {
    throw new Error('A BIP-85 index is an integer from 0 to 2^31 - 1.');
  }
}

/** The derivation path of the BIP-39 application, e.g. m/83696968'/39'/0'/12'/0'. */
export function bip85Bip39Path(words: Bip85WordCount, index: number, language = BIP85_LANGUAGE_ENGLISH): string {
  if (!isWordCount(words)) throw new Error('BIP-85 derives 12, 15, 18, 21 or 24 words.');
  assertIndex(index);
  assertIndex(language);
  return `m/${BIP85_PURPOSE}'/${BIP85_APP_BIP39}'/${language}'/${words}'/${index}'`;
}

/**
 * The derived key k and the 64 bytes of BIP-85 entropy for a fully hardened
 * path below the master root key. Refuses a path with a non-hardened step
 * (the specification requires full hardening) and a key that is not the
 * master root (depth 0).
 */
export function bip85Entropy(root: HDKey, path: string): { derivedKey: Uint8Array; entropy: Uint8Array } {
  if (root.depth !== 0) throw new Error('BIP-85 derives from the master root key (depth 0).');
  const steps = path.split('/');
  if (steps[0] !== 'm' || steps.length < 2 || !steps.slice(1).every((s) => /^[0-9]+'$/.test(s))) {
    throw new Error('A BIP-85 path is fully hardened: m/a\'/b\'/…');
  }
  const child = root.derive(path);
  const k = child.privateKey;
  if (!k) throw new Error('The BIP-85 derivation needs the private master key.');
  const derivedKey = Uint8Array.from(k);
  const entropy = hmac(sha512, utf8ToBytes(BIP85_HMAC_KEY), derivedKey);
  return { derivedKey, entropy };
}

/**
 * The BIP-39 application: the child mnemonic of `words` English words at
 * `index`, from a master root key. The entropy is the first
 * words/3*4 bytes of the 64 (the trailing bytes truncated, as specified).
 */
export function bip85MnemonicFromRoot(root: HDKey, words: Bip85WordCount, index: number): string {
  const { derivedKey, entropy } = bip85Entropy(root, bip85Bip39Path(words, index));
  try {
    return entropyToMnemonic(entropy.slice(0, ENTROPY_BYTES[words]), english);
  } finally {
    derivedKey.fill(0);
    entropy.fill(0);
  }
}

/** The number of words of a valid English BIP-39 phrase (whitespace-normalised). */
export function mnemonicWordCount(mnemonic: string): Bip85WordCount {
  const normalised = mnemonic.trim().split(/\s+/).join(' ');
  if (!validateMnemonic(normalised, english)) throw new Error('Invalid BIP-39 mnemonic (bad word or checksum)');
  const n = normalised.split(' ').length;
  if (!isWordCount(n)) throw new Error('BIP-85 derives 12, 15, 18, 21 or 24 words.');
  return n;
}

/**
 * The BIP-85 child phrase of a parent recovery phrase (no BIP-39
 * passphrase): parent → BIP-39 seed → BIP-32 master root key → the BIP-39
 * application at `index`, with the parent's own word count unless `words`
 * is given. The seed and the root's private key are zeroed before this
 * returns.
 */
export function bip85ChildMnemonic(parent: string, index: number, words?: Bip85WordCount): string {
  const count = words ?? mnemonicWordCount(parent);
  if (words !== undefined) mnemonicWordCount(parent);
  const seed = mnemonicToSeedSync(parent.trim().split(/\s+/).join(' '), '');
  const root = HDKey.fromMasterSeed(seed);
  try {
    return bip85MnemonicFromRoot(root, count, index);
  } finally {
    seed.fill(0);
    root.wipePrivateData();
  }
}

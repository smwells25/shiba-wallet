/**
 * The English indefinite article ("a" or "an") before a word, for sentences
 * that name a network or a coin in English ("Point the camera at an
 * Ethereum address…"). The iOS second pass (phase 24 item 4, finding 5) saw
 * "at a Ethereum address".
 *
 * The rule is the written one: "an" before a word that starts with a, e, i
 * or o, "a" otherwise. English chooses by SOUND, so a word starting with a
 * "u" sound like "you" (Uniswap) takes "a" here, which is right, while one
 * starting with a silent "h" or a vowel-sounding letter name ("L2", "X
 * Layer") would need "an" and gets "a" — a limit of the written rule. Every
 * built-in network label (config/evm-chain.ts) and coin name the wallet
 * shows starts with a letter for which the written rule and the sound
 * agree; a name the user typed for a custom network may not.
 *
 * Pure (no React Native import), loaded by scripts/check-i18n.mjs.
 */
// Explicit .ts extension: loaded by the check scripts under Node's type stripping.
import { t } from './index.ts';

export function englishIndefiniteArticle(word: string): 'a' | 'an' {
  return /^[aeio]/i.test(word.trim()) ? 'an' : 'a';
}

/**
 * The Send screen's scanner sentence, "Point the camera at a/an <network>
 * address or payment-request QR code. …": two entries, one per article
 * (send.scan.rationale and send.scan.rationaleAn), so each language keeps
 * its own whole sentence; in Spanish both read the same.
 */
export function sendScanRationale(network: string): string {
  return englishIndefiniteArticle(network) === 'an'
    ? t('send.scan.rationaleAn', { network })
    : t('send.scan.rationale', { network });
}

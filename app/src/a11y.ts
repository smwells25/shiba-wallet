/**
 * Pure helpers for what screen readers say (pass p20c, TalkBack findings).
 * No React Native imports, so scripts/check-devmode.mjs and the other
 * offline checks can load this file directly.
 */

/**
 * The spoken name of a text link: its visible text without the decorative
 * arrow and check mark ("Send ↗" → "Send", "Passkey ✓" → "Passkey"), so the
 * name a screen reader says is the text a sighted person sees (WCAG 2.2
 * success criterion 2.5.3 "Label in Name"); anything more goes in the hint.
 */
export function spokenLinkText(text: string): string {
  return text.replace(/\s*[↗✓]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * An address as the wallet shows it and as a screen reader should say it:
 * "0x772e…F44F" (the first six and last four characters). TalkBack read the
 * full 42 characters of a multisig address (pass p20c finding 5).
 */
export function spokenShortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * The one spoken label of a Home token row (pass p20c finding 3): the
 * symbol, the row's second line, then the balance, in that order on every
 * row (TalkBack read the badge's symbol as a separate item, and wstETH's
 * balance before its Send link). The Send action follows as the row's
 * action, not as a separate element.
 */
export function tokenRowSpokenLabel(p: { symbol: string; subtitle: string; balance: string }): string {
  return `${p.symbol}, ${p.subtitle.replace(/ · /g, ', ')}. ${p.balance}`;
}

/**
 * A token symbol for speech, with its full name when the wallet knows one
 * that differs ("Liquid staked Ether 2.0 (stETH)"): TalkBack spelled
 * "STETH" and "WSTETH" letter by letter (pass p20c finding 6).
 */
export function spokenTokenName(symbol: string, name: string | null | undefined): string {
  const n = (name ?? '').trim();
  return n !== '' && n.toLowerCase() !== symbol.toLowerCase() ? `${n} (${symbol})` : symbol;
}

/**
 * The spoken label of a source link: the site's name, not the raw URL
 * ("https: 2 Slashapp.uniswap.org"). `https://docs.lido.fi/guides/x` →
 * "docs.lido.fi". An unparseable string is returned unchanged.
 */
export function spokenSiteName(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:@]+)/i.exec(url.trim());
  return m ? m[1]!.toLowerCase().replace(/^www\./, '') : url;
}

/**
 * The spoken label of an Apps site card (pass p20c finding 10): the host,
 * then what activating it does.
 */
export function appSiteCardSpokenLabel(origin: string): string {
  return `${spokenSiteName(origin)}, opens in the wallet's browser`;
}

/** The account switcher's line under an imported account's row. */
export const SWITCHER_IMPORTED_LINE = 'Imported key, Ethereum only — not backed up by your recovery phrase';

/**
 * The spoken label of a recovery-phrase or imported account's row in the
 * account switcher (pass p20c finding 5): the name, the short address the
 * row shows and, for an imported key, the row's warning line. The selected
 * row's ✓ is not part of it — "selected" comes from accessibilityState.
 */
export function switcherRowSpokenLabel(account: { name: string; evmAddress: string | null; imported?: boolean }): string {
  const parts = [account.name];
  if (account.evmAddress) parts.push(spokenShortAddress(account.evmAddress));
  if (account.imported) parts.push(SWITCHER_IMPORTED_LINE);
  return parts.join(', ');
}

/**
 * A sentence with every full Ethereum address in it shortened for speech
 * ("Balances of your regular account 0x772e…F44F"); TalkBack read the
 * 42-character address on the Staking screen (pass p20c finding 6).
 */
export function withShortAddresses(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{40}\b/g, (a) => spokenShortAddress(a));
}

/**
 * The spoken label of a payload QR code (recovery records, guardian
 * approvals, multisig requests, approvals and records, the multisig
 * address): "QR code: Multisig signing request — part 1 of 2".
 */
export function payloadQrSpokenLabel(caption: string, label?: string): string {
  return `QR code: ${label ?? caption}`;
}

/**
 * The start of an Activity row's spoken label (pass p20c finding 12): the
 * transaction's sentence; or, for the second row of the same transaction
 * (a token transfer and its native leg are listed as two rows), "Same
 * transaction as the row above." instead of the same sentence again; or
 * the loading label while the sentence may still arrive.
 */
export function activityRowSpokenLead(p: {
  sentence: string | null;
  loading: boolean;
  sameAsAbove: boolean;
  loadingLabel: string;
}): string {
  if (p.sameAsAbove) return 'Same transaction as the row above. ';
  if (p.sentence) return `${p.sentence}. `;
  return p.loading ? `${p.loadingLabel}. ` : '';
}

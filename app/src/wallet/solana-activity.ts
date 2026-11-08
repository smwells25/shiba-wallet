// Solana Activity rows for token transfers (pass p24-unblock finding 2).
//
// The engine's Solana history provider (packages/chains-solana history.ts)
// now reports a token transfer as a token entry — direction, assetAmount,
// assetDecimals, contract = the mint (base-58, exactly as the node reported
// it) and, when the transaction names exactly one, the other owner as
// counterparty — followed by a native entry only when lamports other than
// the fee moved too. The provider knows no symbols, so this module labels a
// mint from the wallet's OWN lists only: the tokens the user tracked on that
// network (each confirmed by its full mint) and the engine's known-token
// table for that network (KNOWN_SOLANA_TOKENS, by exact mint). A symbol a
// mint claims for itself on-chain is never used here, so a look-alike mint
// is shown by its (shortened) mint, never as "USDC".
//
// React-free with explicit .ts extensions, so scripts/check-spl-tokens.mjs
// runs this exact file under Node's type stripping.
import type { FungibleAsset, HistoryEntry } from '@shiba-wallet/core';
import { KNOWN_SOLANA_TOKENS } from '@shiba-wallet/chains-solana';
import { t } from '../i18n/index.ts';
import { maskAmount } from '../config/prefs.ts';
import { formatUnits } from './balances.ts';

/**
 * mint → symbol for one Solana network: the tracked tokens of that network
 * first (the user's own confirmed list), then the engine's known tokens of
 * that network. Keys are mints exactly as written (base-58 is
 * case-sensitive, so nothing is lowercased).
 */
export function solanaTokenSymbols(caip2: string, tracked: readonly FungibleAsset[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const token of tracked) {
    if (token.assetId.chainId === caip2 && token.assetId.namespace === 'token') map.set(token.assetId.reference, token.symbol);
  }
  for (const known of KNOWN_SOLANA_TOKENS) {
    if (known.caip2 === caip2 && !map.has(known.mint)) map.set(known.mint, known.symbol);
  }
  return map;
}

/** A Solana address or mint shortened for a row: the first four and the last four characters ("9WMg…471n"). */
export function shortSolanaAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/**
 * The entry with its symbol filled in from the wallet's own lists, when its
 * mint is on one of them and the entry carries no symbol yet; otherwise the
 * entry unchanged (a native entry, or a mint the wallet does not know: its
 * row and its export then name the mint).
 */
export function labelSolanaEntry(entry: HistoryEntry, symbols: ReadonlyMap<string, string>): HistoryEntry {
  if (entry.contract === undefined || entry.assetSymbol !== undefined) return entry;
  const symbol = symbols.get(entry.contract);
  return symbol === undefined ? entry : { ...entry, assetSymbol: symbol };
}

/** What the row's amount column names next to a token amount: the symbol, else the shortened mint. */
export function solanaRowAsset(entry: HistoryEntry): string | null {
  if (entry.contract === undefined) return null;
  return entry.assetSymbol ?? shortSolanaAddress(entry.contract);
}

/**
 * The row's sentence for a Solana entry, or null when there is nothing to
 * add to the row's own title and amount:
 *  - a token entry: what moved (exact amount and symbol, or "of the token
 *    with mint …" for a mint the wallet does not know) and to or from whom
 *    — the counterparty shortened, or a plain statement that the
 *    transaction does not name one;
 *  - the native entry that follows a token entry of the same transaction
 *    (`companion`): that these lamports moved besides the fee, in the same
 *    transaction;
 *  - any other native entry: null (the row says enough).
 * Amounts are masked by Hide amounts like the row's own amount.
 */
export function solanaActivitySentence(
  entry: HistoryEntry,
  options: { hidden: boolean; nativeSymbol: string; nativeDecimals: number; companion: boolean },
): string | null {
  if (entry.contract !== undefined && entry.assetAmount !== undefined && entry.assetDecimals !== undefined) {
    if (entry.direction === 'self') return null;
    const amount = maskAmount(formatUnits(entry.assetAmount, entry.assetDecimals, entry.assetDecimals), options.hidden);
    const asset = entry.assetSymbol ?? t('activity.solana.unknownToken', { mint: shortSolanaAddress(entry.contract) });
    const party = entry.counterparty !== undefined ? shortSolanaAddress(entry.counterparty) : null;
    if (entry.direction === 'out') {
      return party !== null
        ? t('activity.solana.sent', { amount, asset, to: party })
        : t('activity.solana.sentUnnamed', { amount, asset });
    }
    return party !== null
      ? t('activity.solana.received', { amount, asset, from: party })
      : t('activity.solana.receivedUnnamed', { amount, asset });
  }
  if (!options.companion || entry.amount === undefined || entry.direction === 'self') return null;
  const amount = maskAmount(formatUnits(entry.amount, options.nativeDecimals, options.nativeDecimals), options.hidden);
  return entry.direction === 'out'
    ? t('activity.solana.nativeOut', { amount, symbol: options.nativeSymbol })
    : t('activity.solana.nativeIn', { amount, symbol: options.nativeSymbol });
}

/**
 * True for the native entry of a transaction that also has a token entry in
 * the list (the provider lists the token entries first, then the native one
 * with the same id).
 */
export function isSolanaTokenCompanion(entry: HistoryEntry, entries: readonly HistoryEntry[]): boolean {
  return entry.contract === undefined && entries.some((other) => other.id === entry.id && other.contract !== undefined);
}

import type { FungibleAsset, HistoryEntry } from '@shiba-wallet/core';
import {
  HISTORY_POINT_TOLERANCE_MS,
  nearestPricePoint,
  type HistoricalPricePoint,
  type HistoryGranularity,
  type PriceQuote,
} from '@shiba-wallet/prices';
// Explicit .ts extensions: scripts/check-pnl.mjs loads this module under
// Node's type stripping, which resolves relative specifiers literally.
import { formatBalanceDisplay } from './balances.ts';
import { describeAge, historySourceFor, staleNoteFor, tokenPriceAssetId, PRICE_HISTORY_MAX_DAYS } from './prices.ts';
import { ZERO_MONEY, formatMoney, moneyAdd, moneyOf, moneyReduce, moneySub, type Money } from './portfolio.ts';
import type { SmartAccountHistoryStatus } from './smart-account-history.ts';

/**
 * Performance and profit / loss (phase 20 item 1, feature 97), for the
 * native coin of a MAINNET network, from the history this wallet loads
 * (the Activity feed: the account's own transfers merged with its smart
 * account's) and CoinGecko's prices.
 *
 * Nothing is invented: when the loaded history or the prices cannot support
 * a figure, the result is a GAP with one plain sentence per reason, and no
 * figure at all. The rules, each also stated on screen:
 *
 *  - Method: average cost. Every purchase adds coins and their cost to one
 *    pool; every sale removes coins at the pool's average cost; realised
 *    profit or loss is the sale's value minus that cost.
 *  - What counts as a purchase or a sale: a CONFIRMED native transfer FROM
 *    or TO an address that is not one of this wallet's own (every account it
 *    holds a key for, their smart accounts, its multisig accounts). The
 *    wallet cannot see what was actually paid or received, so a transfer in
 *    is valued as a purchase, and a transfer out as a sale, at CoinGecko's US
 *    dollar price nearest to its time.
 *  - Transfers between the wallet's own addresses and self-transfers are
 *    neither (counted and reported). Failed transactions moved nothing
 *    (skipped). Pending transactions are not in the balance either
 *    (skipped until confirmed).
 *  - Historical prices: CoinGecko's /coins/{id}/market_chart/range on the
 *    free API, which serves only the past 365 days; the nearest point must
 *    lie within HISTORY_POINT_TOLERANCE_MS of the transaction. A transaction
 *    older than that, or with no point near it, is a gap — NOT valued at
 *    today's price, which is not a cost basis.
 *  - Network fees: the history indexer does not list them. When the loaded
 *    history shows more coins received than are held now (and nothing else
 *    explains it), the difference is ASSUMED to be network fees and removed
 *    at average cost; it is shown on its own line and is not part of
 *    realised profit or loss. The opposite (more held than the history
 *    explains) is a gap.
 *  - Unrealised profit or loss: the coins held now at today's CoinGecko
 *    price, minus their remaining cost.
 *  - Tokens (computeTokenPnl, phase 23 item 8): only a token TRACKED on a
 *    MAIN network (tokenPnlAsset), and only the entries whose
 *    HistoryEntry.contract equals that token's exact contract. A transfer of
 *    another contract that calls itself by the same symbol is a look-alike:
 *    left out and counted. A token transfer that names no contract cannot be
 *    told apart from the real one, so it is a gap, never a guess. Network
 *    fees are paid in the native coin, never in the token, so a token's
 *    shortfall is never assumed to be fees: it is a gap. On screen
 *    (phase 23 item 8, second slice) a token is offered only through
 *    pnlTokenChoices: tracked, on the ACTIVE main network, with a price id,
 *    and with a price history CoinGecko serves by its exact contract
 *    (prices.ts historySourceFor: /coins/{platform}/contract/{contract}/
 *    market_chart/range). A history request that is not mapped still
 *    answers 'unsupported', and the result is the token gap sentence below.
 *
 * Exact: amounts are bigints, money is an exact fraction (portfolio.ts
 * Money), rounded to the cent only for display. Free of React Native
 * imports so scripts/check-pnl.mjs runs the exact code.
 */

export interface PnlAsset {
  /** The mainnet CAIP-19 id CoinGecko prices it under. */
  priceId: string;
  /** "ETH". */
  symbol: string;
  decimals: number;
}

/** A tracked ERC-20 token on a main network (tokenPnlAsset builds it). */
export interface PnlTokenAsset extends PnlAsset {
  /** The token's contract, lowercase 0x-prefixed (HistoryEntry.contract's convention). */
  contract: string;
}

/** The input of computeTokenPnl: the same as the native one, for a token. */
export type PnlTokenInput = Omit<PnlInput, 'asset'> & { asset: PnlTokenAsset };

export type PnlPriceHistory =
  | { status: 'ok'; points: HistoricalPricePoint[]; granularity: HistoryGranularity }
  | { status: 'unavailable'; reason: 'fiat-off' | 'unsupported' | 'out-of-range' }
  | { status: 'failed'; message: string }
  /** Not asked (another gap made it pointless). */
  | { status: 'not-requested' };

export interface PnlInput {
  asset: PnlAsset;
  /** The loaded entries, newest first, as the Activity list holds them. */
  entries: readonly HistoryEntry[];
  /** True while older entries exist that are not loaded. */
  hasMore: boolean;
  /**
   * The smart account whose history is merged in, and whether it was
   * (smart-account-history.ts). null when the account has none.
   */
  smartAccount: { address: string; status: SmartAccountHistoryStatus | undefined } | null;
  /** Every address of this wallet (any case): accounts, smart accounts, multisigs. */
  ownAddresses: readonly string[];
  /** The current balance of the addresses whose history is loaded (EOA + smart account), exact; null if unread. */
  balance: bigint | null;
  prices: PnlPriceHistory;
  /** Today's spot quote for the asset, or null. */
  currentQuote: PriceQuote | null;
  nowMs: number;
}

export type PnlResult =
  | {
      kind: 'gap';
      /** Full sentences, each starting "Profit and loss cannot be worked out for <SYM>: ". */
      reasons: string[];
      /** The assumption lines that still apply (for context). */
      notes: string[];
    }
  | {
      kind: 'ok';
      held: bigint;
      /** Cost of the coins held now (after any assumed fees). */
      costBasis: Money;
      /** Cost per whole coin, or null when nothing is held. */
      averageCost: Money | null;
      marketValue: Money;
      unrealised: Money;
      realised: Money;
      /** Coins assumed spent on network fees, and their cost removed. */
      assumedFees: bigint;
      assumedFeesCost: Money;
      purchases: number;
      sales: number;
      /** The rules and counts behind the figures, as sentences. */
      notes: string[];
    };

/** The tolerance in words, for the notes. */
function toleranceText(granularity: HistoryGranularity): string {
  const ms = HISTORY_POINT_TOLERANCE_MS[granularity];
  return ms >= 3_600_000 ? `${ms / 3_600_000} hours` : `${ms / 60_000} minutes`;
}

/** "2026-10-12 (UTC)". */
export function utcDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} (UTC)`;
}

function isNative(entry: HistoryEntry): boolean {
  // A named contract makes it a token even when the indexer reported no
  // symbol and no amount (an NFT with a null asset name, for example).
  return entry.assetSymbol === undefined && entry.assetAmount === undefined && entry.contract === undefined;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Money × num / den, exact. */
function moneyScale(m: Money, num: bigint, den: bigint): Money {
  if (den === 0n) throw new Error('Division by zero');
  const sign = den < 0n ? -1n : 1n;
  return moneyReduce({ n: m.n * num * sign, d: m.d * den * sign });
}

/**
 * The line above the P&L figures saying how much history is loaded.
 * `hasMore` is the history source's own answer (a cursor or a stream with
 * pages left): it says older entries CAN be searched, not that any exist —
 * so a first page that found nothing must not claim "older ones exist"
 * (pass p20b finding 3).
 */
export function pnlHistoryLoadedLine(count: number, hasMore: boolean): string {
  if (count === 0) {
    return hasMore
      ? 'No transactions were found in the history searched so far; older history has not been searched yet.'
      : 'No transactions were found: the history is empty.';
  }
  return `${count} ${count === 1 ? 'entry' : 'entries'} of history loaded${hasMore ? '; older ones exist' : ', which is all of it'}.`;
}

/** The cutoff of the free API's history window, in ms. */
export function historyCutoffMs(nowMs: number): number {
  return nowMs - PRICE_HISTORY_MAX_DAYS * 86_400_000;
}

/** Unix seconds range the price history must cover for these entries, or null when none needs a price. */
export function pnlPriceRange(
  input: Pick<PnlInput, 'entries' | 'ownAddresses' | 'nowMs'> & { asset?: PnlAsset | PnlTokenAsset },
): { fromSec: number; toSec: number } | null {
  const own = new Set(input.ownAddresses.map((a) => a.toLowerCase()));
  let oldest: number | null = null;
  const cutoff = historyCutoffMs(input.nowMs) / 1000;
  // A token's range covers only the entries of its exact contract; without a
  // token asset, the native coin's (unchanged).
  const contract = input.asset && 'contract' in input.asset ? input.asset.contract.toLowerCase() : null;
  const isThisAsset = (e: HistoryEntry) =>
    contract === null ? isNative(e) : !isNative(e) && e.contract !== undefined && e.contract.toLowerCase() === contract;
  for (const e of input.entries) {
    if (!isThisAsset(e) || e.failed || !e.confirmed || e.timestamp === null) continue;
    if (e.direction === 'self' || !e.counterparty || own.has(e.counterparty.toLowerCase())) continue;
    if (e.timestamp < cutoff) continue;
    if (oldest === null || e.timestamp < oldest) oldest = e.timestamp;
  }
  if (oldest === null) return null;
  const nowSec = Math.floor(input.nowMs / 1000);
  // A day of margin before the oldest transaction, never before the window;
  // both ends on whole hours so the range (and the request) stays the same
  // for an hour instead of changing with every render.
  const hour = 3_600;
  const earliest = Math.ceil(cutoff / hour) * hour + hour;
  const from = Math.max(earliest, Math.floor((oldest - 86_400) / hour) * hour);
  return { fromSec: from, toSec: Math.ceil(nowSec / hour) * hour };
}

/**
 * Why the native profit and loss leaves tokens out (its note on token
 * transfers). Until phase 23 item 8's second slice it said token profit and
 * loss was "not offered yet"; tracked tokens on the active main network now
 * have their own buttons (pnlTokenChoices).
 */
export const TOKEN_PNL_SEPARATE =
  'Profit and loss for a token is worked out separately, from that token’s own transfers: each ERC-20 token tracked ' +
  'on the active main network that CoinGecko prices has its own button.';

const CONTRACT_RE = /^0x[0-9a-f]{40}$/;

/**
 * The profit-and-loss asset for a TRACKED token, or the sentence that
 * refuses it: only an ERC-20 token whose CAIP-19 id is on the active EVM
 * network, that network a main network (prices.ts tokenPriceAssetId, the
 * same rule its spot price follows), with a 20-byte contract address.
 */
export function tokenPnlAsset(
  token: FungibleAsset,
  activeEvmCaip2: string,
): { status: 'ok'; asset: PnlTokenAsset } | { status: 'refused'; reason: string } {
  const gap = (why: string) => ({ status: 'refused' as const, reason: `Profit and loss cannot be worked out for ${token.symbol}: ${why}` });
  if (token.assetId.namespace !== 'erc20') return gap('it is not an ERC-20 token.');
  const contract = token.assetId.reference.toLowerCase();
  if (!CONTRACT_RE.test(contract)) return gap('its contract address is not a 20-byte address.');
  const priceId = tokenPriceAssetId(token, activeEvmCaip2);
  if (priceId === null) {
    return gap('it is not a token tracked on a main network that is active now, so it has no price (test-network tokens have no value).');
  }
  return { status: 'ok', asset: { priceId, symbol: token.symbol, decimals: token.decimals, contract } };
}

/**
 * The tracked tokens the profit-and-loss section offers a button for, in the
 * stored order: exactly the tokens tokenPnlAsset accepts on `activeEvmCaip2`
 * (an ERC-20 on the ACTIVE network, that network a MAIN network, a 20-byte
 * contract) whose price history the wallet reads by contract
 * (prices.ts historySourceFor answers 'token'). A test-network token never
 * appears ("test, no value"), nor a token of another network, nor one
 * CoinGecko is not asked about. A contract listed twice is offered once.
 */
export function pnlTokenChoices(tokens: readonly FungibleAsset[], activeEvmCaip2: string): PnlTokenAsset[] {
  const out: PnlTokenAsset[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const chosen = tokenPnlAsset(token, activeEvmCaip2);
    if (chosen.status !== 'ok') continue;
    const source = historySourceFor(chosen.asset.priceId);
    if (!source || source.kind !== 'token' || source.contract !== chosen.asset.contract) continue;
    if (seen.has(chosen.asset.contract)) continue;
    seen.add(chosen.asset.contract);
    out.push(chosen.asset);
  }
  return out;
}

/**
 * A token button's title: "<SYMBOL> on <network>", with the short contract
 * added when another offered token (or the network's own coin) carries the
 * same symbol, so two buttons never read alike.
 */
export function pnlTokenChipTitle(
  asset: PnlTokenAsset,
  offered: readonly PnlTokenAsset[],
  networkLabel: string,
  nativeSymbol: string,
): string {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const clash =
    same(asset.symbol, nativeSymbol) || offered.some((o) => o.contract !== asset.contract && same(o.symbol, asset.symbol));
  const short = `${asset.contract.slice(0, 6)}…${asset.contract.slice(-4)}`;
  return `${asset.symbol}${clash ? ` (${short})` : ''} on ${networkLabel}`;
}

/** The entries one profit-and-loss run counts, and how each is valued. */
interface PnlMode {
  kind: 'native' | 'token';
  /** The entries that are this asset (before the purchase / sale rules). */
  selected: HistoryEntry[];
  /** The exact amount of this asset an entry moved, in its base units. */
  amountOf: (entry: HistoryEntry) => bigint | undefined;
  /** Gap sentences (without the "cannot be worked out for X: " lead) about which entries are this asset. */
  identityGaps: string[];
  /** Notes about entries left out as other assets. */
  identityNotes: string[];
}

function nativeMode(input: Pick<PnlInput, 'entries' | 'asset'>): PnlMode {
  const sym = input.asset.symbol;
  const native = input.entries.filter(isNative);
  const tokenCount = input.entries.length - native.length;
  const identityNotes: string[] = [];
  if (tokenCount > 0) {
    identityNotes.push(
      `${plural(tokenCount, 'token transfer is', 'token transfers are')} in the loaded history and ${tokenCount === 1 ? 'is' : 'are'} not part of these ${sym} ` +
        `figures. ${TOKEN_PNL_SEPARATE}`,
    );
  }
  return { kind: 'native', selected: native, amountOf: (e) => e.amount, identityGaps: [], identityNotes };
}

function sameSymbol(a: string | undefined, b: string): boolean {
  return a !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function tokenMode(input: Pick<PnlTokenInput, 'entries' | 'asset'>): PnlMode {
  const { symbol: sym, decimals } = input.asset;
  const contract = input.asset.contract.toLowerCase();
  if (!CONTRACT_RE.test(contract)) throw new Error(`Not a token contract address: ${input.asset.contract}`);
  const selected: HistoryEntry[] = [];
  let lookAlike = 0;
  let otherAssets = 0;
  let unidentified = 0;
  let otherDecimals = 0;
  for (const e of input.entries) {
    if (isNative(e)) {
      otherAssets += 1;
      continue;
    }
    if (e.contract === undefined) {
      // Which token moved is unknown: it may be this one under another label.
      unidentified += 1;
      continue;
    }
    if (e.contract.toLowerCase() !== contract) {
      if (sameSymbol(e.assetSymbol, sym)) lookAlike += 1;
      else otherAssets += 1;
      continue;
    }
    if (e.assetAmount !== undefined && e.assetDecimals !== decimals) {
      otherDecimals += 1;
      continue;
    }
    selected.push(e);
  }
  const identityGaps: string[] = [];
  const identityNotes: string[] = [
    `Only transfers of the tracked ${sym} contract ${contract} are counted.`,
  ];
  if (unidentified > 0) {
    identityGaps.push(
      `${plural(unidentified, 'token transfer does', 'token transfers do')} not name ${unidentified === 1 ? 'its' : 'their'} contract, so ` +
        `${unidentified === 1 ? 'it' : 'they'} cannot be told apart from the tracked ${sym}.`,
    );
  }
  if (otherDecimals > 0) {
    identityGaps.push(
      `${plural(otherDecimals, 'transfer', 'transfers')} of its contract ${otherDecimals === 1 ? 'reports' : 'report'} a number of decimals other ` +
        `than the ${decimals} this wallet has for ${sym}, so ${otherDecimals === 1 ? 'its amount is' : 'their amounts are'} not certain.`,
    );
  }
  if (lookAlike > 0) {
    identityNotes.push(
      `${plural(lookAlike, 'transfer of a token', 'transfers of tokens')} from another contract ${lookAlike === 1 ? 'calls itself' : 'call themselves'} ` +
        `${sym}; ${lookAlike === 1 ? 'it is' : 'they are'} not the tracked ${sym} and ${lookAlike === 1 ? 'is' : 'are'} left out.`,
    );
  }
  if (otherAssets > 0) {
    identityNotes.push(
      `${plural(otherAssets, 'transfer', 'transfers')} of the network’s own coin or of other tokens ${otherAssets === 1 ? 'is' : 'are'} not part of these ${sym} figures.`,
    );
  }
  return { kind: 'token', selected, amountOf: (e) => e.assetAmount, identityGaps, identityNotes };
}

/**
 * Works out profit and loss, or the gaps that prevent it. Every gap found is
 * reported (not only the first), so the user sees everything that is missing.
 */
export function computeNativePnl(input: PnlInput): PnlResult {
  return computePnl(input, nativeMode(input));
}

/**
 * Profit and loss for a tracked token (tokenPnlAsset): the same rules as the
 * native coin's, counting only the entries of the token's exact contract, and
 * with no assumed fees (a token pays none).
 */
export function computeTokenPnl(input: PnlTokenInput): PnlResult {
  return computePnl(input, tokenMode(input));
}

function computePnl(input: PnlInput, mode: PnlMode): PnlResult {
  const sym = input.asset.symbol;
  const decimals = input.asset.decimals;
  const gap = (why: string) => `Profit and loss cannot be worked out for ${sym}: ${why}`;
  const reasons: string[] = [];
  const notes: string[] = [];
  const own = new Set(input.ownAddresses.map((a) => a.toLowerCase()));
  const cutoffMs = historyCutoffMs(input.nowMs);

  if (input.hasMore) {
    const oldest = input.entries.reduce<number | null>(
      (min, e) => (e.timestamp !== null && (min === null || e.timestamp < min) ? e.timestamp : min),
      null,
    );
    reasons.push(
      gap(
        input.entries.length === 0
          ? 'no transactions were found in the history searched so far, and older history has not been searched yet. Load older history until it is complete.'
          : oldest === null
            ? 'older transactions are not loaded yet. Load older history until it is complete.'
            : `transactions before ${utcDate(oldest * 1000)} are not in the loaded history. Load older history until it is complete.`,
      ),
    );
  }
  if (input.smartAccount) {
    if (input.smartAccount.status === 'failed') {
      reasons.push(gap('the smart account’s history could not be loaded, so its transfers are missing. Pull down to try again.'));
    } else if (input.smartAccount.status !== 'included') {
      reasons.push(
        gap('the smart account’s history is not listed by the current history source (it needs a history indexer), so its transfers are missing.'),
      );
    }
  }

  for (const why of mode.identityGaps) reasons.push(gap(why));
  notes.push(...mode.identityNotes);
  const amountOf = mode.amountOf;

  let failed = 0;
  let pending = 0;
  let ownTransfers = 0;
  const external: HistoryEntry[] = [];
  let noAmount = 0;
  let noCounterparty = 0;
  let noTime = 0;
  let tooOld = 0;
  for (const e of mode.selected) {
    if (e.failed) {
      failed += 1;
      continue;
    }
    if (!e.confirmed) {
      pending += 1;
      continue;
    }
    const moved = amountOf(e);
    if (moved === undefined) {
      noAmount += 1;
      continue;
    }
    if (moved === 0n) continue;
    if (e.direction === 'self') {
      ownTransfers += 1;
      continue;
    }
    if (!e.counterparty) {
      noCounterparty += 1;
      continue;
    }
    if (own.has(e.counterparty.toLowerCase())) {
      ownTransfers += 1;
      continue;
    }
    if (e.timestamp === null) {
      noTime += 1;
      continue;
    }
    if (e.timestamp * 1000 < cutoffMs) {
      tooOld += 1;
      continue;
    }
    external.push(e);
  }
  if (noAmount > 0) reasons.push(gap(`${plural(noAmount, 'transaction', 'transactions')} in the loaded history ${noAmount === 1 ? 'has' : 'have'} no amount.`));
  if (noCounterparty > 0) {
    reasons.push(
      gap(
        `${plural(noCounterparty, 'transaction does', 'transactions do')} not name the other address, so transfers between your own ` +
          'accounts cannot be told apart from purchases and sales.',
      ),
    );
  }
  if (noTime > 0) reasons.push(gap(`${plural(noTime, 'transaction has', 'transactions have')} no time, so no price at that time can be found.`));
  if (tooOld > 0) {
    reasons.push(
      gap(
        `${plural(tooOld, 'transaction', 'transactions')} before ${utcDate(cutoffMs)} ${tooOld === 1 ? 'is' : 'are'} older than the ` +
          `${PRICE_HISTORY_MAX_DAYS} days of price history CoinGecko’s free service provides, so there is no price at ${tooOld === 1 ? 'its' : 'their'} time. ` +
          'Today’s price is not used instead, because it is not a cost basis.',
      ),
    );
  }
  if (ownTransfers > 0) {
    notes.push(
      `${plural(ownTransfers, 'transfer', 'transfers')} between your own addresses (accounts, smart accounts, multi-signature ` +
        `accounts) ${ownTransfers === 1 ? 'is' : 'are'} not counted as a purchase or a sale.`,
    );
  }
  if (failed > 0) {
    notes.push(
      `${plural(failed, 'failed transaction moved', 'failed transactions moved')} ${mode.kind === 'native' ? 'no coins' : `no ${sym}`} and ${failed === 1 ? 'is' : 'are'} skipped.`,
    );
  }
  if (pending > 0) notes.push(`${plural(pending, 'pending transaction is', 'pending transactions are')} not counted until confirmed.`);

  if (input.balance === null) reasons.push(gap('the current balance could not be read. Pull down to try again.'));
  if (!input.currentQuote) reasons.push(gap('today’s price is not available from CoinGecko right now.'));

  let points: HistoricalPricePoint[] = [];
  let granularity: HistoryGranularity = 'hourly';
  if (external.length > 0) {
    switch (input.prices.status) {
      case 'ok':
        points = input.prices.points;
        granularity = input.prices.granularity;
        break;
      case 'unavailable':
        reasons.push(
          gap(
            input.prices.reason === 'fiat-off'
              ? 'Show fiat values is off (Settings → Prices), so no prices are requested.'
              : input.prices.reason === 'out-of-range'
                ? `its transactions are older than the ${PRICE_HISTORY_MAX_DAYS} days of price history CoinGecko’s free service provides.`
                : mode.kind === 'token'
                  ? 'this wallet does not read CoinGecko’s price history for tokens yet (only for the native coins of the main networks), so there is no price at the time of its transfers.'
                  : 'CoinGecko has no price history for it.',
          ),
        );
        break;
      case 'failed':
        reasons.push(gap(`the price history could not be read (${input.prices.message}).`));
        break;
      case 'not-requested':
        reasons.push(gap('the price history was not requested.'));
        break;
    }
  }

  // Valuation of every counted transfer, oldest first.
  const ordered = [...external].sort(
    (a, b) => a.timestamp! - b.timestamp! || (a.blockHeight ?? 0) - (b.blockHeight ?? 0),
  );
  const priced: { entry: HistoryEntry; price: string }[] = [];
  let noPoint = 0;
  if (input.prices.status === 'ok') {
    const tolerance = HISTORY_POINT_TOLERANCE_MS[granularity];
    for (const e of ordered) {
      const point = nearestPricePoint(points, e.timestamp! * 1000, tolerance);
      if (!point) noPoint += 1;
      else priced.push({ entry: e, price: point.price });
    }
    if (noPoint > 0) {
      reasons.push(
        gap(
          `no CoinGecko price was found within ${toleranceText(granularity)} of ${plural(noPoint, 'transaction', 'transactions')}.`,
        ),
      );
    }
  }

  if (reasons.length > 0) return { kind: 'gap', reasons, notes };

  // Average-cost pool.
  let qty = 0n;
  let cost: Money = ZERO_MONEY;
  let realised: Money = ZERO_MONEY;
  let purchases = 0;
  let sales = 0;
  for (const { entry, price } of priced) {
    const amount = amountOf(entry)!;
    const value = moneyOf(amount, decimals, price);
    if (entry.direction === 'in') {
      qty += amount;
      cost = moneyAdd(cost, value);
      purchases += 1;
      continue;
    }
    // 'out' to someone else: a sale at that time's price.
    if (amount > qty) {
      return {
        kind: 'gap',
        reasons: [
          gap(
            `the loaded history shows more ${sym} sent than received before ${utcDate(entry.timestamp! * 1000)}, so ` +
              'earlier transactions are missing from it.',
          ),
        ],
        notes,
      };
    }
    const costOut = moneyScale(cost, amount, qty);
    realised = moneyAdd(realised, moneySub(value, costOut));
    cost = moneySub(cost, costOut);
    qty -= amount;
    sales += 1;
  }

  const balance = input.balance!;
  if (balance > qty) {
    return {
      kind: 'gap',
      reasons: [
        gap(
          `the balance is ${formatBalanceDisplay(balance - qty, decimals)} ${sym} more than the loaded history explains, so some ` +
            `${sym} arrived in a way the history does not list.`,
        ),
      ],
      notes,
    };
  }
  let assumedFees = 0n;
  let assumedFeesCost: Money = ZERO_MONEY;
  if (qty > balance && mode.kind === 'token') {
    // Network fees are paid in the native coin, never in a token.
    return {
      kind: 'gap',
      reasons: [
        gap(
          `the loaded history shows ${formatBalanceDisplay(qty - balance, decimals)} ${sym} more received than is held now, and ` +
            `network fees are not paid in ${sym}, so some ${sym} left in a way the history does not list.`,
        ),
      ],
      notes,
    };
  }
  if (qty > balance) {
    assumedFees = qty - balance;
    assumedFeesCost = moneyScale(cost, assumedFees, qty);
    cost = moneySub(cost, assumedFeesCost);
    qty = balance;
    notes.push(
      `${formatBalanceDisplay(assumedFees, decimals)} ${sym} that the loaded history shows as received is no longer held, and no ` +
        'listed transfer explains it. The wallet assumes it paid network fees (the history does not list fees) and removes it ' +
        'at its average cost. Fees are not counted in realised profit or loss. If that assumption is wrong, these figures are wrong.',
    );
  }

  const quote = input.currentQuote!;
  const marketValue = moneyOf(qty, decimals, quote.price);
  const unrealised = moneySub(marketValue, cost);
  let unit = 1n;
  for (let i = 0; i < decimals; i++) unit *= 10n;
  const averageCost = qty > 0n ? moneyScale(cost, unit, qty) : null;
  const age = staleNoteFor(quote, input.nowMs);
  const quoteTime = quote.updatedAtMs ?? quote.fetchedAtMs;
  notes.unshift(
    mode.kind === 'native'
      ? 'Method: average cost. Each purchase adds coins and their cost to one pool; each sale, and each fee, removes coins at ' +
          'the pool’s average cost.'
      : `Method: average cost. Each purchase adds ${sym} and its cost to one pool; each sale removes ${sym} at the pool’s ` +
          `average cost. Network fees are paid in the network’s own coin, not in ${sym}, and are not part of these figures.`,
    `Receiving ${sym} from someone else counts as buying it, and sending ${sym} to someone else counts as selling it, at ` +
      'CoinGecko’s US dollar price at that time: the wallet cannot see what you actually paid or were paid.',
    `The price at a transaction’s time is CoinGecko’s price nearest to it (${granularity === 'daily' ? 'daily' : granularity === 'hourly' ? 'hourly' : 'every 5 minutes'} for ` +
      `this range), never more than ${toleranceText(granularity)} away.`,
    `Unrealised profit or loss uses today’s CoinGecko price${
      quoteTime !== undefined ? ` (${age ?? `from ${describeAge(Math.max(60_000, input.nowMs - quoteTime))}`})` : ''
    }.`,
    'These figures are estimates for your information, not tax or accounting records.',
  );
  return {
    kind: 'ok',
    held: qty,
    costBasis: cost,
    averageCost,
    marketValue,
    unrealised,
    realised,
    assumedFees,
    assumedFeesCost,
    purchases,
    sales,
    notes,
  };
}

/** The figure lines of an ok result, masked under Hide amounts. */
export function pnlFigureLines(
  result: Extract<PnlResult, { kind: 'ok' }>,
  asset: Pick<PnlAsset, 'symbol' | 'decimals'>,
  hidden: boolean,
): { label: string; text: string }[] {
  const amount = (a: bigint) => (hidden ? '••••' : formatBalanceDisplay(a, asset.decimals));
  const lines = [
    { label: 'Held now', text: `${amount(result.held)} ${asset.symbol}` },
    { label: 'Value at today’s price', text: formatMoney(result.marketValue, { hidden }) },
    { label: 'Cost of what is held', text: formatMoney(result.costBasis, { hidden }) },
    {
      label: 'Average cost',
      text: result.averageCost ? `${formatMoney(result.averageCost, { hidden })} per ${asset.symbol}` : 'nothing held',
    },
    { label: 'Unrealised profit or loss', text: formatMoney(result.unrealised, { hidden, signed: true }) },
    { label: 'Realised profit or loss', text: formatMoney(result.realised, { hidden, signed: true }) },
  ];
  if (result.assumedFees > 0n) {
    lines.push({
      label: 'Assumed network fees (not in realised)',
      text: `${amount(result.assumedFees)} ${asset.symbol}, cost ${formatMoney(result.assumedFeesCost, { hidden })}`,
    });
  }
  lines.push({ label: 'Counted', text: `${plural(result.purchases, 'purchase', 'purchases')}, ${plural(result.sales, 'sale', 'sales')}` });
  return lines;
}

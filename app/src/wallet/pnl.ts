import type { HistoryEntry } from '@shiba-wallet/core';
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
import { describeAge, staleNoteFor, PRICE_HISTORY_MAX_DAYS } from './prices.ts';
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
 *  - Tokens: not offered. The loaded history names a token only by the
 *    symbol the indexer reports (HistoryEntry has no contract field), so a
 *    look-alike token could not be told apart from the real one.
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
  return entry.assetSymbol === undefined && entry.assetAmount === undefined;
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

/** The cutoff of the free API's history window, in ms. */
export function historyCutoffMs(nowMs: number): number {
  return nowMs - PRICE_HISTORY_MAX_DAYS * 86_400_000;
}

/** Unix seconds range the price history must cover for these entries, or null when none needs a price. */
export function pnlPriceRange(input: Pick<PnlInput, 'entries' | 'ownAddresses' | 'nowMs'>): { fromSec: number; toSec: number } | null {
  const own = new Set(input.ownAddresses.map((a) => a.toLowerCase()));
  let oldest: number | null = null;
  const cutoff = historyCutoffMs(input.nowMs) / 1000;
  for (const e of input.entries) {
    if (!isNative(e) || e.failed || !e.confirmed || e.timestamp === null) continue;
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
 * Works out profit and loss, or the gaps that prevent it. Every gap found is
 * reported (not only the first), so the user sees everything that is missing.
 */
export function computeNativePnl(input: PnlInput): PnlResult {
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
        oldest === null
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

  const native = input.entries.filter(isNative);
  const tokenCount = input.entries.length - native.length;
  if (tokenCount > 0) {
    notes.push(
      `${plural(tokenCount, 'token transfer is', 'token transfers are')} in the loaded history and ${tokenCount === 1 ? 'is' : 'are'} not part of these ${sym} ` +
        'figures. Profit and loss for tokens is not offered: the history names a token only by the symbol the history ' +
        'service reports, not by its contract, so a look-alike token could not be told apart from the real one.',
    );
  }

  let failed = 0;
  let pending = 0;
  let ownTransfers = 0;
  const external: HistoryEntry[] = [];
  let noAmount = 0;
  let noCounterparty = 0;
  let noTime = 0;
  let tooOld = 0;
  for (const e of native) {
    if (e.failed) {
      failed += 1;
      continue;
    }
    if (!e.confirmed) {
      pending += 1;
      continue;
    }
    if (e.amount === undefined) {
      noAmount += 1;
      continue;
    }
    if (e.amount === 0n) continue;
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
  if (failed > 0) notes.push(`${plural(failed, 'failed transaction moved', 'failed transactions moved')} no coins and ${failed === 1 ? 'is' : 'are'} skipped.`);
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
    const amount = entry.amount!;
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
    'Method: average cost. Each purchase adds coins and their cost to one pool; each sale, and each fee, removes coins at ' +
      'the pool’s average cost.',
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

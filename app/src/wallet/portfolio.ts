import type { FungibleAsset } from '@shiba-wallet/core';
import { formatAssetId } from '@shiba-wallet/core';
import { parseDecimal, type PriceQuote } from '@shiba-wallet/prices';
// Explicit .ts extensions: scripts/check-portfolio.mjs loads this module under
// Node's type stripping, which resolves relative specifiers literally.
import { nativePriceAssetId, staleNoteFor, describeAge, tokenPriceAssetId } from './prices.ts';
import { formatBalanceDisplay, groupThousands, spokenAmount } from './balances.ts';
import { maskAmount } from '../config/prefs.ts';

/**
 * The unified portfolio (phase 20 item 1, feature 96): net worth across the
 * accounts and networks this wallet holds, built from the same balance reads
 * and the same CoinGecko spot prices the Home screen uses.
 *
 * WHAT IS READ, AND WHY IT IS MORE THAN HOME. Home reads the ACTIVE account
 * only: one native balance per network slot plus the tracked tokens on the
 * active EVM network. A net worth needs every account, so this screen reads,
 * per account: the native coin on each network slot the account has an
 * address for, plus every tracked token on the active EVM network, and the
 * same for each account's smart account (EVM only). That is more than Home,
 * so it is bounded (planPortfolio): at most PORTFOLIO_MAX_READS balance reads
 * per refresh, PORTFOLIO_READ_CONCURRENCY at a time, only when the screen
 * opens or is pulled to refresh — never in the background. Reads beyond the
 * bound are listed as not read and not counted. Prices come through the
 * shared cached provider (usePrices), so ids Home asked for in the last two
 * minutes cost no request.
 *
 * HONESTY RULES (the price provider's, unchanged): a test-network asset is
 * never priced (its price id is null) and is shown as "test, no value"; an
 * asset CoinGecko has no price for is "no price" and not counted; a price is
 * only attached to a balance read from the network the price belongs to (the
 * id is re-derived from the network that answered, as Home does); watched
 * addresses are summed separately and never enter the net worth; Hide amounts
 * masks every amount and every value.
 *
 * EXACTNESS. Amounts stay bigints in base units; every value is an exact
 * fraction (Money) of amount × price, summed exactly, and rounded to the
 * cent only for display. So the net worth equals the sum of the per-asset,
 * per-network and per-account values exactly (each displayed part is rounded
 * on its own, so displayed parts may differ from the displayed total by a
 * cent or two — the screen says so).
 *
 * Free of React Native imports so scripts/check-portfolio.mjs runs the exact
 * code under plain Node.
 */

// ---------------------------------------------------------------------------
// Exact money
// ---------------------------------------------------------------------------

/** An exact non-negative-or-negative amount of US dollars: n / d, d > 0. */
export interface Money {
  n: bigint;
  d: bigint;
}

export const ZERO_MONEY: Money = { n: 0n, d: 1n };

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

function pow10(k: number): bigint {
  let out = 1n;
  for (let i = 0; i < k; i++) out *= 10n;
  return out;
}

export function moneyReduce(m: Money): Money {
  if (m.d <= 0n) throw new Error('Invalid money denominator');
  const g = gcd(m.n, m.d);
  return { n: m.n / g, d: m.d / g };
}

export function moneyAdd(a: Money, b: Money): Money {
  return moneyReduce({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
}

export function moneySub(a: Money, b: Money): Money {
  return moneyReduce({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
}

export function moneySum(parts: readonly Money[]): Money {
  return parts.reduce(moneyAdd, ZERO_MONEY);
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.n * b.d === b.n * a.d;
}

export function moneyCompare(a: Money, b: Money): number {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The exact value of `amount` base units at `price` (one whole unit, plain decimal). */
export function moneyOf(amount: bigint, decimals: number, price: string): Money {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error(`Invalid decimals: ${decimals}`);
  const { units, scale } = parseDecimal(price);
  return moneyReduce({ n: amount * units, d: pow10(decimals + scale) });
}

/** Cents, rounded half away from zero. */
export function moneyCents(m: Money): bigint {
  const r = moneyReduce(m);
  const scaled = abs(r.n) * 100n;
  let q = scaled / r.d;
  if ((scaled % r.d) * 2n >= r.d) q += 1n;
  return r.n < 0n ? -q : q;
}

/** "1,234.57" (no sign) from cents. */
function centsText(cents: bigint): string {
  const a = abs(cents).toString().padStart(3, '0');
  return groupThousands(`${a.slice(0, -2)}.${a.slice(-2)}`);
}

/**
 * The display of an exact value: "$1,234.57", "< $0.01" for a value that is
 * not zero but rounds to zero, "$0.00" for zero. `signed` adds "+" / "−"
 * (for profit and loss). With `hidden` (Hide amounts) the output is the same
 * mask for every value, so nothing about its size leaks.
 */
export function formatMoney(m: Money, options: { hidden: boolean; signed?: boolean }): string {
  if (options.hidden) return maskAmount('', true);
  const cents = moneyCents(m);
  const negative = cents < 0n || (cents === 0n && m.n < 0n);
  const sign = options.signed ? (m.n === 0n ? '' : negative ? '−' : '+') : negative ? '−' : '';
  if (cents === 0n && m.n !== 0n) return `${sign}< $0.01`;
  return `${sign}$${centsText(cents)}`;
}

/** The spoken form: "1,234.57 US dollars", "less than one cent", "hidden". */
export function spokenMoney(m: Money, options: { hidden: boolean; signed?: boolean }): string {
  if (options.hidden) return 'hidden';
  const cents = moneyCents(m);
  const negative = m.n < 0n;
  const prefix = options.signed && m.n !== 0n ? (negative ? 'minus ' : 'plus ') : negative ? 'minus ' : '';
  if (cents === 0n && m.n !== 0n) return `${prefix}less than one cent`;
  return `${prefix}${centsText(cents)} US dollars`;
}

// ---------------------------------------------------------------------------
// What is read
// ---------------------------------------------------------------------------

/** At most this many balance reads per refresh (a judgement; Home reads 4 + the tracked tokens). */
export const PORTFOLIO_MAX_READS = 60;
/** Reads in flight at once (a judgement: public endpoints rate-limit bursts). */
export const PORTFOLIO_READ_CONCURRENCY = 4;

/** How an account is held. Watched addresses are never part of the net worth. */
export type PortfolioAccountKind = 'phrase' | 'imported' | 'multisig' | 'watch';

/** One account as the screen hands it in (public data only; nothing here needs a key). */
export interface PortfolioAccountInput {
  /** Stable key, e.g. "phrase:0", "imported:2147483648". */
  key: string;
  name: string;
  kind: PortfolioAccountKind;
  hidden: boolean;
  /** The account's EVM address, or null when not known yet. */
  evmAddress: string | null;
  /**
   * Addresses on the other network slots (Bitcoin, Dogecoin, Solana) by
   * slot id — only recovery-phrase accounts have them, and only when this
   * phone already knows them (the public account cache); null when not known.
   */
  otherAddresses: Readonly<Record<string, string>> | null;
  /** The account's smart-account address on the active EVM network (known without a request), or null. */
  smartAccount: string | null;
  /** For a multisig: the CAIP-2 network its record belongs to. */
  multisigChain?: string;
}

/** One network slot under the current mode. */
export interface PortfolioSlot {
  /** Stable slot id (the mainnet CAIP-2 id), e.g. "eip155:1". */
  slot: string;
  /** The network serving it now (e.g. "eip155:11155111" in Sepolia test mode). */
  networkChainId: string;
  /** "Ethereum", "Ethereum Sepolia", "Bitcoin". */
  label: string;
  /** "ETH", "test ETH", "BTC". */
  symbol: string;
  decimals: number;
  testnet: boolean;
  evm: boolean;
}

export interface PortfolioAsset {
  /** CAIP-19 id on the network that serves it. */
  id: string;
  slot: string;
  networkChainId: string;
  networkLabel: string;
  symbol: string;
  decimals: number;
  kind: 'native' | 'token';
  /** For a token: its tracked-store asset (for tokenPriceAssetId). */
  token?: FungibleAsset;
  testnet: boolean;
}

/** One address of one account. `role` says what it is. */
export interface PortfolioAddress {
  accountKey: string;
  accountName: string;
  kind: PortfolioAccountKind;
  hidden: boolean;
  role: 'own' | 'smart';
  /** "Account 1", "Account 1’s smart account". */
  label: string;
  address: string;
}

export interface PortfolioReadTask {
  key: string;
  holder: PortfolioAddress;
  asset: PortfolioAsset;
}

export interface PortfolioPlan {
  tasks: PortfolioReadTask[];
  /** Planned but not read because of PORTFOLIO_MAX_READS. */
  notRead: PortfolioReadTask[];
  /** Recovery-phrase accounts whose non-EVM addresses this phone does not know yet. */
  missingOtherAddresses: string[];
  /** Multisig accounts recorded for another network than the active EVM one (not read). */
  otherNetworkMultisigs: string[];
  /** Accounts with no known EVM address (not read on EVM). */
  missingEvmAddresses: string[];
}

/** The order the bound cuts in: own funds first, watched addresses last. */
const KIND_ORDER: Record<PortfolioAccountKind, number> = { phrase: 0, imported: 1, multisig: 2, watch: 3 };

export function taskKey(holder: Pick<PortfolioAddress, 'address'>, asset: Pick<PortfolioAsset, 'id'>): string {
  return `${asset.id}|${holder.address.toLowerCase()}`;
}

/**
 * Plans the balance reads: per account, its EVM address and its smart
 * account on the active EVM network (native coin + every tracked token on
 * that network), and for a recovery-phrase account its Bitcoin, Dogecoin
 * and Solana addresses when known. A multisig is read only on the network
 * its record belongs to. Duplicate addresses are read once (the first
 * account listing them keeps them). The first `maxReads` tasks in the order
 * phrase → imported → multisig → watched (each account's own address before
 * its smart account) are read; the rest are returned in `notRead`.
 */
export function planPortfolio(args: {
  accounts: readonly PortfolioAccountInput[];
  slots: readonly PortfolioSlot[];
  /** Tracked tokens on the active EVM network. */
  tokens: readonly FungibleAsset[];
  maxReads?: number;
}): PortfolioPlan {
  const maxReads = args.maxReads ?? PORTFOLIO_MAX_READS;
  const evmSlot = args.slots.find((s) => s.evm) ?? null;
  const evmAssets: PortfolioAsset[] = [];
  if (evmSlot) {
    evmAssets.push(nativeAsset(evmSlot));
    for (const token of args.tokens) {
      if (token.assetId.chainId !== evmSlot.networkChainId) continue;
      evmAssets.push({
        id: formatAssetId(token.assetId),
        slot: evmSlot.slot,
        networkChainId: evmSlot.networkChainId,
        networkLabel: evmSlot.label,
        symbol: token.symbol,
        decimals: token.decimals,
        kind: 'token',
        token,
        testnet: evmSlot.testnet,
      });
    }
  }
  const sorted = [...args.accounts].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const all: PortfolioReadTask[] = [];
  const seen = new Set<string>();
  const missingOtherAddresses: string[] = [];
  const otherNetworkMultisigs: string[] = [];
  const missingEvmAddresses: string[] = [];
  const add = (holder: PortfolioAddress, asset: PortfolioAsset) => {
    const key = taskKey(holder, asset);
    if (seen.has(key)) return;
    seen.add(key);
    all.push({ key, holder, asset });
  };
  for (const account of sorted) {
    const base = { accountKey: account.key, accountName: account.name, kind: account.kind, hidden: account.hidden };
    if (account.kind === 'multisig' && evmSlot && account.multisigChain !== evmSlot.networkChainId) {
      otherNetworkMultisigs.push(account.name);
      continue;
    }
    if (evmSlot) {
      if (account.evmAddress) {
        const own: PortfolioAddress = { ...base, role: 'own', label: account.name, address: account.evmAddress };
        for (const asset of evmAssets) add(own, asset);
      } else {
        missingEvmAddresses.push(account.name);
      }
      if (account.smartAccount && (account.kind === 'phrase' || account.kind === 'imported')) {
        const smart: PortfolioAddress = {
          ...base,
          role: 'smart',
          label: `${account.name}’s smart account`,
          address: account.smartAccount,
        };
        for (const asset of evmAssets) add(smart, asset);
      }
    }
    if (account.kind === 'phrase') {
      const others = args.slots.filter((s) => !s.evm);
      if (!account.otherAddresses) {
        if (others.length > 0) missingOtherAddresses.push(account.name);
      } else {
        for (const slot of others) {
          const address = account.otherAddresses[slot.slot];
          if (address) add({ ...base, role: 'own', label: account.name, address }, nativeAsset(slot));
        }
      }
    }
  }
  return {
    tasks: all.slice(0, maxReads),
    notRead: all.slice(maxReads),
    missingOtherAddresses,
    otherNetworkMultisigs,
    missingEvmAddresses,
  };
}

function nativeAsset(slot: PortfolioSlot): PortfolioAsset {
  return {
    id: `${slot.networkChainId}/native`,
    slot: slot.slot,
    networkChainId: slot.networkChainId,
    networkLabel: slot.label,
    symbol: slot.symbol,
    decimals: slot.decimals,
    kind: 'native',
    testnet: slot.testnet,
  };
}

/** The price ids to ask CoinGecko for (null-free; test assets give none). */
export function portfolioPriceIds(plan: Pick<PortfolioPlan, 'tasks'>): string[] {
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    const id = priceIdFor(t.asset, t.asset.networkChainId);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * The price id for an asset as read from `answeredBy` (the network that
 * actually produced the balance), or null: re-derived from the answering
 * network exactly as Home does, so a balance read across a mode flip can
 * never pick up a mainnet price.
 */
export function priceIdFor(asset: PortfolioAsset, answeredBy: string): string | null {
  if (asset.kind === 'native') return nativePriceAssetId(asset.slot, answeredBy);
  if (!asset.token || answeredBy !== asset.networkChainId) return null;
  return tokenPriceAssetId(asset.token, answeredBy);
}

/**
 * Runs the planned reads, at most `concurrency` at a time; a read never
 * rejects the whole run (its error is recorded). Results are keyed by task key.
 */
export async function runPortfolioReads(
  tasks: readonly PortfolioReadTask[],
  read: (task: PortfolioReadTask) => Promise<PortfolioReadResult>,
  concurrency: number = PORTFOLIO_READ_CONCURRENCY,
  onResult?: (key: string, result: PortfolioReadResult) => void,
): Promise<Map<string, PortfolioReadResult>> {
  const results = new Map<string, PortfolioReadResult>();
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      let result: PortfolioReadResult;
      try {
        result = await read(task);
      } catch (e) {
        result = { status: 'error', message: e instanceof Error ? e.message : 'The balance could not be read.' };
      }
      results.set(task.key, result);
      onResult?.(task.key, result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  return results;
}

export type PortfolioReadResult =
  | { status: 'ok'; amount: bigint; decimals: number; networkChainId: string }
  | { status: 'error'; message: string }
  | { status: 'unavailable'; note?: string };

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

/** How an asset is valued. */
export type ValueStatus = 'priced' | 'test' | 'no-price';

export interface PortfolioHolding {
  task: PortfolioReadTask;
  amount: bigint;
  decimals: number;
  status: ValueStatus;
  /** Exact value when priced, else null. */
  value: Money | null;
  quote: PriceQuote | null;
}

export interface AssetTotal {
  asset: PortfolioAsset;
  /** Exact sum of the counted (non-watched) holdings, base units. */
  amount: bigint;
  status: ValueStatus;
  value: Money | null;
  quote: PriceQuote | null;
}

export interface GroupTotal {
  key: string;
  label: string;
  value: Money;
  holdings: PortfolioHolding[];
  /** Holdings that are test assets or unpriced (listed, not valued). */
  unvalued: number;
}

export interface PortfolioSummary {
  /** The net worth: every priced holding EXCEPT watched addresses. */
  netWorth: Money;
  /** The watched addresses' priced total, never part of the net worth. */
  watchedTotal: Money;
  byAsset: AssetTotal[];
  byNetwork: GroupTotal[];
  byAccount: GroupTotal[];
  watchedByAccount: GroupTotal[];
  /** Counts for the "not counted" lines. */
  failedReads: number;
  unavailableReads: number;
  /** Symbols of non-test assets held with no price. */
  unpricedSymbols: string[];
  /** Symbols of test-network assets held (shown as "test, no value"). */
  testSymbols: string[];
  /** The oldest vendor time among the prices used (Unix ms), or null. */
  oldestPriceMs: number | null;
  /** True when every read answered and every held non-test asset was priced. */
  complete: boolean;
}

/**
 * Builds the aggregate from the read results and the quotes. Exact: the net
 * worth equals the sum of byAsset values, of byNetwork values and of
 * byAccount values (moneyEquals). A zero balance is listed nowhere.
 */
export function computePortfolio(args: {
  plan: Pick<PortfolioPlan, 'tasks' | 'notRead'>;
  results: ReadonlyMap<string, PortfolioReadResult>;
  quotes: ReadonlyMap<string, PriceQuote>;
}): PortfolioSummary {
  const holdings: PortfolioHolding[] = [];
  let failedReads = 0;
  let unavailableReads = 0;
  for (const task of args.plan.tasks) {
    const result = args.results.get(task.key);
    if (!result) {
      failedReads += 1;
      continue;
    }
    if (result.status === 'error') {
      failedReads += 1;
      continue;
    }
    if (result.status === 'unavailable') {
      unavailableReads += 1;
      continue;
    }
    // Answered by another network than planned (the mode changed while the
    // reads ran): the plan is stale, so the read is not used.
    if (result.networkChainId !== task.asset.networkChainId) {
      failedReads += 1;
      continue;
    }
    if (result.amount <= 0n) continue;
    const priceId = priceIdFor(task.asset, result.networkChainId);
    const quote = priceId ? (args.quotes.get(priceId) ?? null) : null;
    const status: ValueStatus = task.asset.testnet ? 'test' : quote ? 'priced' : 'no-price';
    holdings.push({
      task,
      amount: result.amount,
      decimals: result.decimals,
      status,
      value: status === 'priced' && quote ? moneyOf(result.amount, result.decimals, quote.price) : null,
      quote: status === 'priced' ? quote : null,
    });
  }
  const counted = holdings.filter((h) => h.task.holder.kind !== 'watch');
  const watched = holdings.filter((h) => h.task.holder.kind === 'watch');

  const byAssetMap = new Map<string, AssetTotal>();
  for (const h of counted) {
    const id = h.task.asset.id;
    const prev = byAssetMap.get(id);
    if (!prev) {
      byAssetMap.set(id, { asset: h.task.asset, amount: h.amount, status: h.status, value: h.value, quote: h.quote });
      continue;
    }
    prev.amount += h.amount;
    if (h.value && prev.value) prev.value = moneyAdd(prev.value, h.value);
    else if (h.value && !prev.value) {
      prev.value = h.value;
      prev.status = 'priced';
      prev.quote = h.quote;
    }
  }
  // An asset with some priced and some unpriced holdings cannot occur (one
  // price id per asset and network), but a mixed total would be wrong, so
  // the value is recomputed from the exact amount when the asset is priced.
  for (const total of byAssetMap.values()) {
    if (total.quote) total.value = moneyOf(total.amount, total.asset.decimals, total.quote.price);
  }

  const group = (list: PortfolioHolding[], keyOf: (h: PortfolioHolding) => [string, string]): GroupTotal[] => {
    const map = new Map<string, GroupTotal>();
    for (const h of list) {
      const [key, label] = keyOf(h);
      let g = map.get(key);
      if (!g) map.set(key, (g = { key, label, value: ZERO_MONEY, holdings: [], unvalued: 0 }));
      g.holdings.push(h);
      if (h.value) g.value = moneyAdd(g.value, h.value);
      else g.unvalued += 1;
    }
    return [...map.values()];
  };

  const netWorth = moneySum(counted.map((h) => h.value ?? ZERO_MONEY));
  const watchedTotal = moneySum(watched.map((h) => h.value ?? ZERO_MONEY));
  const unpricedSymbols = uniq(counted.concat(watched).filter((h) => h.status === 'no-price').map((h) => h.task.asset.symbol));
  const testSymbols = uniq(counted.concat(watched).filter((h) => h.status === 'test').map((h) => h.task.asset.symbol));
  let oldestPriceMs: number | null = null;
  for (const h of holdings) {
    const t = h.quote ? (h.quote.updatedAtMs ?? h.quote.fetchedAtMs ?? null) : null;
    if (t !== null && (oldestPriceMs === null || t < oldestPriceMs)) oldestPriceMs = t;
  }
  return {
    netWorth,
    watchedTotal,
    byAsset: [...byAssetMap.values()],
    byNetwork: group(counted, (h) => [h.task.asset.networkChainId, h.task.asset.networkLabel]),
    byAccount: group(counted, (h) => [h.task.holder.accountKey, h.task.holder.accountName]),
    watchedByAccount: group(watched, (h) => [h.task.holder.accountKey, h.task.holder.accountName]),
    failedReads,
    unavailableReads,
    unpricedSymbols,
    testSymbols,
    oldestPriceMs,
    complete:
      failedReads === 0 &&
      unavailableReads === 0 &&
      args.plan.notRead.length === 0 &&
      unpricedSymbols.length === 0,
  };
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const PORTFOLIO_TITLE = 'Portfolio';

/** What is counted (the network name of the active EVM profile is filled in). */
export function portfolioCountedNote(evmLabel: string): string {
  return (
    `Counted: the native coins of ${evmLabel}, Bitcoin, Dogecoin and Solana, and the tokens you track on ${evmLabel}, ` +
    'for every account this wallet holds a key for (hidden accounts included), each account’s smart account on ' +
    `${evmLabel}, and your multi-signature accounts recorded for ${evmLabel}. Multi-signature accounts are counted in ` +
    'full, although their co-signers share control of them.'
  );
}

export const PORTFOLIO_NOT_COUNTED_NOTE =
  'Not counted: watched addresses (shown separately, because they are not your funds), test-network assets ' +
  '(they have no value), tokens you do not track, NFTs, EntryPoint deposits, assets on networks other than the ' +
  'active ones, assets CoinGecko has no price for, and balances that could not be read. Bitcoin, Dogecoin and ' +
  'Solana are read only for accounts from your recovery phrase whose addresses this phone already knows.';

export const PORTFOLIO_READS_NOTE =
  `This screen reads the balance of every account, which takes more requests than the Home screen (Home reads ` +
  `only the active account): one per account, network and tracked token, at most ${PORTFOLIO_MAX_READS} per ` +
  `refresh and ${PORTFOLIO_READ_CONCURRENCY} at a time. It reads only when you open it or pull down to refresh.`;

export const PORTFOLIO_ROUNDING_NOTE =
  'Each figure is rounded to the cent on its own, so the parts can differ from the total by a cent or two.';

export const PORTFOLIO_FIAT_OFF_NOTE =
  'Show fiat values is off (Settings → Prices), so no prices are requested and no net worth can be shown. ' +
  'The balances below are still read.';

export const PORTFOLIO_WATCHED_HEADING = 'Watched addresses (not your funds)';

export const PORTFOLIO_WATCHED_NOTE =
  'Watched addresses are other people’s or your own addresses this wallet holds no key for. Their total is shown ' +
  'only here and is never added to your net worth.';

/** The "not complete" lines under the total, each only when it applies. */
export function portfolioGapLines(summary: PortfolioSummary, plan: PortfolioPlan): string[] {
  const out: string[] = [];
  if (plan.notRead.length > 0) {
    out.push(
      `${plural(plan.notRead.length, 'balance was', 'balances were')} not read, to keep this screen’s network ` +
        `requests bounded (at most ${PORTFOLIO_MAX_READS} per refresh); ${plan.notRead.length === 1 ? 'it is' : 'they are'} not counted.`,
    );
  }
  if (summary.failedReads > 0) {
    out.push(`${plural(summary.failedReads, 'balance', 'balances')} could not be read and ${summary.failedReads === 1 ? 'is' : 'are'} not counted. Pull down to try again.`);
  }
  if (summary.unavailableReads > 0) {
    out.push(
      `${plural(summary.unavailableReads, 'balance', 'balances')} could not be read because no endpoint is configured for ` +
        `${summary.unavailableReads === 1 ? 'its network' : 'their network'} (for example Dogecoin, Settings → Network endpoints); not counted.`,
    );
  }
  if (summary.unpricedSymbols.length > 0) {
    out.push(`No price from CoinGecko for ${listText(summary.unpricedSymbols)}; not counted.`);
  }
  if (summary.testSymbols.length > 0) {
    out.push(`${listText(summary.testSymbols)} ${summary.testSymbols.length === 1 ? 'is a test-network asset' : 'are test-network assets'}: test, no value.`);
  }
  if (plan.missingOtherAddresses.length > 0) {
    out.push(
      `The Bitcoin, Dogecoin and Solana addresses of ${listText(plan.missingOtherAddresses)} are not known on this phone ` +
        'yet, so they were not read. Make the account active once on the Home screen to add them.',
    );
  }
  if (plan.otherNetworkMultisigs.length > 0) {
    out.push(`${listText(plan.otherNetworkMultisigs)} ${plan.otherNetworkMultisigs.length === 1 ? 'is' : 'are'} recorded for another network and ${plan.otherNetworkMultisigs.length === 1 ? 'was' : 'were'} not read.`);
  }
  if (plan.missingEvmAddresses.length > 0) {
    out.push(`The Ethereum address of ${listText(plan.missingEvmAddresses)} is not known yet, so it was not read.`);
  }
  return out;
}

/** "Prices: CoinGecko, US dollars, the oldest from 3 min ago." */
export function portfolioPriceSourceLine(summary: Pick<PortfolioSummary, 'oldestPriceMs'>, nowMs: number): string | null {
  if (summary.oldestPriceMs === null) return null;
  const age = Math.max(0, nowMs - summary.oldestPriceMs);
  const when = age < 60_000 ? 'less than a minute ago' : describeAge(age);
  return `Prices: CoinGecko, in US dollars; the oldest price used is from ${when}. Indicative market prices, not what a sale would fetch.`;
}

/** The amount display of one holding or total ("0.5 ETH", "••••"). */
export function amountText(amount: bigint, decimals: number, symbol: string, hidden: boolean): string {
  return `${maskAmount(formatBalanceDisplay(amount, decimals), hidden)} ${symbol}`;
}

/** The value display of one holding or total. */
export function valueText(status: ValueStatus, value: Money | null, hidden: boolean): string {
  if (status === 'test') return 'test, no value';
  if (status === 'no-price' || !value) return 'no price';
  return `≈ ${formatMoney(value, { hidden })}`;
}

/** The screen-reader label of one holding or asset row. */
export function holdingSpokenLabel(args: {
  label: string;
  amount: bigint;
  decimals: number;
  symbol: string;
  status: ValueStatus;
  value: Money | null;
  quote: PriceQuote | null;
  hidden: boolean;
  nowMs: number;
}): string {
  // A test asset has no value and an unpriced one no price, so Hide amounts
  // hides only their amount: "value hidden" would suggest a value exists
  // (pass p20b finding 11). Neither says anything about the holdings.
  const value =
    args.status === 'test'
      ? 'test asset, no value'
      : args.status === 'no-price' || !args.value
        ? 'no price'
        : args.hidden
          ? 'value hidden'
          : `about ${spokenMoney(args.value, { hidden: false })}`;
  if (args.hidden) return `${args.label}: ${args.symbol}, amount hidden, ${value}`;
  const amount = `${spokenAmount(formatBalanceDisplay(args.amount, args.decimals))} ${args.symbol}`;
  const stale = args.quote ? staleNoteFor(args.quote, args.nowMs) : null;
  return `${args.label}: ${amount}, ${value}${stale ? `, ${stale}` : ''}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "A", "A and B", "A, B and C". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}

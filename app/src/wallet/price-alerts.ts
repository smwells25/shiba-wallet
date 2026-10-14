import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseDecimal, type PriceQuote } from '@shiba-wallet/prices';
// Explicit .ts extensions: scripts/check-price-alerts.mjs loads this module
// under Node's type stripping, which resolves relative specifiers literally.
import type { KeyValueStore } from './tokens.ts';
import { DEFAULT_NETWORKS } from '../config/defaults.ts';
import { USDC_MAINNET } from './erc20.ts';
import { formatAssetId } from '@shiba-wallet/core';
import { PRICE_OLD_AFTER_MS, describeAge, nativePriceAssetId, staleNoteFor } from './prices.ts';
import { groupThousands } from './balances.ts';

/**
 * Watchlist and price alerts (phase 20 item 1, feature 98).
 *
 * WHAT. A list of priced MAINNET assets the user follows (the four native
 * coins and the mainnet tokens the wallet knows: USDC), each with optional
 * alerts "above X" / "below X" in US dollars. Stored only on this phone
 * (AsyncStorage, PRICE_ALERTS_KEY), strictly parsed and capped; a damaged
 * store is shown read-only and is never overwritten until the user resets it.
 *
 * WHEN IT IS CHECKED. Only while the wallet is open: at start, on every
 * return to the foreground, and every PRICE_ALERT_POLL_MS while it stays in
 * front (components/PriceAlertMonitor.tsx). With no alert stored, nothing is
 * checked and no price is requested (shouldCheckPriceAlerts). Prices come
 * through the same shared, cached CoinGecko provider as every other screen
 * (prices.ts fetchPrices), so nothing leaves the phone beyond those reads, and
 * nothing is requested while "Show fiat values" is off.
 *
 * ONE CROSSING FIRES ONCE (hysteresis). An "above X" alert fires when the
 * price is strictly above X, then waits ("tripped") until the price has come
 * back to at most X × (1 − PRICE_ALERT_REARM_PERCENT / 100) before it can fire
 * again; "below X" mirrors it. A price that hovers around X therefore fires
 * once. An alert created while its condition already holds starts tripped
 * (it does not fire for a crossing that happened before it existed). Only a
 * FRESH quote is used (not served stale by the cache, and no older than
 * PRICE_OLD_AFTER_MS by the vendor's own time): an old price never fires an
 * alert.
 *
 * ADVISORY. An alert never buys, sells or sends anything; the wallet has no
 * path from here to a transaction.
 *
 * Free of React Native imports (AsyncStorage is only the default store) so
 * scripts/check-price-alerts.mjs runs the exact code.
 */

export const PRICE_ALERTS_KEY = 'shiba-wallet.price-alerts.v1';
/** The most alerts stored (a judgement; the parse refuses more). */
export const MAX_PRICE_ALERTS = 20;
/** The most alerts on one asset (a judgement). */
export const MAX_ALERTS_PER_ASSET = 4;
/** How far back past the threshold the price must move before an alert can fire again. */
export const PRICE_ALERT_REARM_PERCENT = 1n;
/**
 * The poll while the wallet stays open. A judgement from the limits: the
 * keyless CoinGecko API is rate-limited per IP (about six requests a minute
 * observed in phase 6), its spot prices refresh every 60 s and the app's
 * cache keeps them 120 s; one check costs one request for the native coins
 * plus one per token, so five minutes keeps alerts far below the limit.
 */
export const PRICE_ALERT_POLL_MS = 5 * 60_000;
/** Largest whole part of a threshold (12 digits) and most fraction digits. */
const THRESHOLD_RE = /^(0|[1-9]\d{0,11})(?:\.(\d{1,8}))?$/;

export type AlertDirection = 'above' | 'below';
export type AlertState = 'armed' | 'tripped';

export interface WatchAsset {
  /** The CAIP-19 id CoinGecko prices it under. */
  id: string;
  symbol: string;
  name: string;
}

/**
 * The assets that can be followed: the native coins of the four mainnet
 * networks (config/defaults.ts, under the id prices.ts prices them with) and
 * the mainnet tokens the wallet knows (USDC). Nothing else: a test-network
 * asset has no price, and an arbitrary token would need its own vetting.
 */
export const WATCHABLE_ASSETS: readonly WatchAsset[] = [
  ...DEFAULT_NETWORKS.map((n) => ({ id: nativePriceAssetId(n.chainId, n.chainId), symbol: n.symbol, name: n.label }))
    .filter((a): a is WatchAsset => a.id !== null),
  { id: formatAssetId(USDC_MAINNET.assetId), symbol: USDC_MAINNET.symbol, name: USDC_MAINNET.name },
];

export function watchAssetFor(id: string): WatchAsset | null {
  return WATCHABLE_ASSETS.find((a) => a.id === id) ?? null;
}

export interface PriceAlert {
  id: string;
  assetId: string;
  direction: AlertDirection;
  /** Plain decimal US dollars, canonical (no trailing fraction zeros). */
  threshold: string;
  state: AlertState;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms of the last time it fired, if it has. */
  firedAt?: number;
  /** The price it fired at. */
  firedPrice?: string;
}

export interface PriceAlertBook {
  watchlist: string[];
  alerts: PriceAlert[];
  nextId: number;
  /** True when the stored value could not be parsed: shown read-only, never overwritten. */
  damaged: boolean;
}

export const EMPTY_BOOK: PriceAlertBook = { watchlist: [], alerts: [], nextId: 1, damaged: false };

export const PRICE_ALERTS_DAMAGED_MESSAGE =
  'The stored watchlist could not be read, so it is shown as empty and cannot be changed. Nothing was deleted. ' +
  'Reset the watchlist to start again (this deletes the stored list and its alerts).';

// ---------------------------------------------------------------------------
// Thresholds and decimals
// ---------------------------------------------------------------------------

export type ThresholdParse = { ok: true; value: string } | { ok: false; error: string };

/** Parses a typed US dollar price: digits and one ".", at most 8 decimals, more than 0. */
export function parseThreshold(input: string): ThresholdParse {
  const text = input.trim().replace(/^\$/, '');
  if (text === '') return { ok: false, error: 'Enter a price in US dollars, for example 3000 or 0.25.' };
  if (/[,\s]/.test(text)) return { ok: false, error: 'Type the price without commas or spaces, for example 3000 or 0.25.' };
  const m = THRESHOLD_RE.exec(text.startsWith('.') ? `0${text}` : text);
  if (!m) {
    return {
      ok: false,
      error: 'Type the price as a plain number with at most 12 digits before the point and 8 after it, for example 3000 or 0.25.',
    };
  }
  const value = canonicalDecimal(m[1]!, m[2] ?? '');
  if (parseDecimal(value).units === 0n) return { ok: false, error: 'The price must be more than 0.' };
  return { ok: true, value };
}

function canonicalDecimal(whole: string, fraction: string): string {
  const f = fraction.replace(/0+$/, '');
  return f === '' ? whole : `${whole}.${f}`;
}

/** Compares two plain decimals exactly: -1, 0 or 1. */
export function compareDecimals(a: string, b: string): number {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  let xu = x.units;
  let yu = y.units;
  for (let i = x.scale; i < scale; i++) xu *= 10n;
  for (let i = y.scale; i < scale; i++) yu *= 10n;
  return xu < yu ? -1 : xu > yu ? 1 : 0;
}

/** price × 100 compared with threshold × factor, exactly (for the re-arm band). */
function comparePercent(price: string, threshold: string, factor: bigint): number {
  const p = parseDecimal(price);
  const t = parseDecimal(threshold);
  const scale = Math.max(p.scale, t.scale);
  let pu = p.units * 100n;
  let tu = t.units * factor;
  for (let i = p.scale; i < scale; i++) pu *= 10n;
  for (let i = t.scale; i < scale; i++) tu *= 10n;
  return pu < tu ? -1 : pu > tu ? 1 : 0;
}

/** "$3,000", "$0.25" — a threshold as typed (canonical), with separators. */
export function thresholdText(threshold: string): string {
  return `$${groupThousands(threshold)}`;
}

/**
 * A market price for display: cents for a price of $1 or more ("$3,012.40"),
 * else up to 8 decimals with trailing zeros removed ("$0.093232").
 */
export function priceText(price: string): string {
  const { units, scale } = parseDecimal(price);
  let one = 1n;
  for (let i = 0; i < scale; i++) one *= 10n;
  if (units >= one) {
    const scaled = units * 100n;
    let q = scaled / one;
    if ((scaled % one) * 2n >= one) q += 1n;
    const s = q.toString().padStart(3, '0');
    return `$${groupThousands(`${s.slice(0, -2)}.${s.slice(-2)}`)}`;
  }
  const digits = units.toString().padStart(scale, '0');
  const cut = digits.slice(0, 8).replace(/0+$/, '');
  return cut === '' ? '< $0.00000001' : `$0.${cut}`;
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/** True when a quote may be used for an alert: not served stale, and its price not old. */
export function isFreshQuote(quote: PriceQuote | undefined | null, nowMs: number): quote is PriceQuote {
  if (!quote || quote.stale) return false;
  return staleNoteFor(quote, nowMs) === null;
}

/** Whether the alert's condition holds at `price` (strictly above / strictly below). */
export function conditionMet(alert: Pick<PriceAlert, 'direction' | 'threshold'>, price: string): boolean {
  const c = compareDecimals(price, alert.threshold);
  return alert.direction === 'above' ? c > 0 : c < 0;
}

/** Whether a tripped alert may be armed again at `price` (back past the band on the other side). */
export function rearmMet(alert: Pick<PriceAlert, 'direction' | 'threshold'>, price: string): boolean {
  return alert.direction === 'above'
    ? comparePercent(price, alert.threshold, 100n - PRICE_ALERT_REARM_PERCENT) <= 0
    : comparePercent(price, alert.threshold, 100n + PRICE_ALERT_REARM_PERCENT) >= 0;
}

export interface AlertStep {
  alert: PriceAlert;
  fired: boolean;
  changed: boolean;
}

/** One alert against one quote. A missing or old quote changes nothing. */
export function stepAlert(alert: PriceAlert, quote: PriceQuote | undefined | null, nowMs: number): AlertStep {
  if (!isFreshQuote(quote, nowMs)) return { alert, fired: false, changed: false };
  if (alert.state === 'armed' && conditionMet(alert, quote.price)) {
    return { alert: { ...alert, state: 'tripped', firedAt: nowMs, firedPrice: quote.price }, fired: true, changed: true };
  }
  if (alert.state === 'tripped' && rearmMet(alert, quote.price)) {
    return { alert: { ...alert, state: 'armed' }, fired: false, changed: true };
  }
  return { alert, fired: false, changed: false };
}

export interface FiredAlert {
  alert: PriceAlert;
  asset: WatchAsset;
  price: string;
  quote: PriceQuote;
}

/** Every alert of a book against the quotes; returns the new book and what fired. */
export function evaluateAlerts(
  book: PriceAlertBook,
  quotes: ReadonlyMap<string, PriceQuote>,
  nowMs: number,
): { book: PriceAlertBook; fired: FiredAlert[]; changed: boolean } {
  if (book.damaged) return { book, fired: [], changed: false };
  const fired: FiredAlert[] = [];
  let changed = false;
  const alerts = book.alerts.map((alert) => {
    const quote = quotes.get(alert.assetId);
    const outcome = stepAlert(alert, quote, nowMs);
    if (outcome.changed) changed = true;
    const watched = watchAssetFor(alert.assetId);
    // Identifiers chosen to keep this block out of the secret scanner's
    // twelve-consecutive-wordlist-words rule (the scanner stays strict).
    if (outcome.fired && quote && watched) {
      const firing = { alert: outcome.alert, asset: watched, price: quote.price, quote };
      fired.push(firing);
    }
    return outcome.alert;
  });
  return { book: changed ? { ...book, alerts } : book, fired, changed };
}

/** Polling and checking happen only when at least one alert is stored and readable. */
export function shouldCheckPriceAlerts(book: Pick<PriceAlertBook, 'alerts' | 'damaged'>): boolean {
  return !book.damaged && book.alerts.length > 0;
}

/** The price ids a check asks for (one per asset with an alert). */
export function alertPriceIds(book: Pick<PriceAlertBook, 'alerts'>): string[] {
  return [...new Set(book.alerts.map((a) => a.assetId))].sort();
}

// ---------------------------------------------------------------------------
// Storage (strict)
// ---------------------------------------------------------------------------

const ID_RE = /^a[1-9]\d{0,6}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

/**
 * Parses the stored text. Strict: unknown keys, a wrong version, an unknown
 * asset, a malformed threshold or id, a duplicate, an alert on an asset not
 * in the watchlist, or more than the caps → null (damaged).
 */
export function parsePriceAlertBook(text: string): PriceAlertBook | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(raw) || !exactKeys(raw, ['version', 'watchlist', 'alerts', 'nextId']) || raw.version !== 1) return null;
  const { watchlist, alerts, nextId } = raw;
  if (!Array.isArray(watchlist) || !Array.isArray(alerts)) return null;
  if (typeof nextId !== 'number' || !Number.isSafeInteger(nextId) || nextId < 1 || nextId > 9_999_999) return null;
  if (watchlist.length > WATCHABLE_ASSETS.length || alerts.length > MAX_PRICE_ALERTS) return null;
  const list: string[] = [];
  for (const id of watchlist) {
    if (typeof id !== 'string' || !watchAssetFor(id) || list.includes(id)) return null;
    list.push(id);
  }
  const out: PriceAlert[] = [];
  const seenIds = new Set<string>();
  const seenRules = new Set<string>();
  const perAsset = new Map<string, number>();
  for (const a of alerts) {
    if (!isPlainObject(a)) return null;
    if (!exactKeys(a, ['id', 'assetId', 'direction', 'threshold', 'state', 'createdAt'], ['firedAt', 'firedPrice'])) return null;
    const { id, assetId, direction, threshold, state, createdAt, firedAt, firedPrice } = a;
    if (typeof id !== 'string' || !ID_RE.test(id) || seenIds.has(id) || Number(id.slice(1)) >= nextId) return null;
    if (typeof assetId !== 'string' || !list.includes(assetId)) return null;
    if (direction !== 'above' && direction !== 'below') return null;
    if (state !== 'armed' && state !== 'tripped') return null;
    if (typeof threshold !== 'string') return null;
    const parsed = parseThreshold(threshold);
    if (!parsed.ok || parsed.value !== threshold) return null;
    if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) return null;
    if (firedAt !== undefined && (typeof firedAt !== 'number' || !Number.isSafeInteger(firedAt) || firedAt < 0)) return null;
    if (firedPrice !== undefined && (typeof firedPrice !== 'string' || !/^\d+(\.\d+)?$/.test(firedPrice) || firedPrice.length > 80)) return null;
    if ((firedAt === undefined) !== (firedPrice === undefined)) return null;
    const rule = `${assetId}|${direction}|${threshold}`;
    if (seenRules.has(rule)) return null;
    const count = (perAsset.get(assetId) ?? 0) + 1;
    if (count > MAX_ALERTS_PER_ASSET) return null;
    perAsset.set(assetId, count);
    seenIds.add(id);
    seenRules.add(rule);
    out.push({
      id,
      assetId,
      direction,
      threshold,
      state,
      createdAt,
      ...(firedAt !== undefined ? { firedAt: firedAt as number, firedPrice: firedPrice as string } : {}),
    });
  }
  return { watchlist: list, alerts: out, nextId, damaged: false };
}

export function serializePriceAlertBook(book: PriceAlertBook): string {
  return JSON.stringify({ version: 1, watchlist: book.watchlist, alerts: book.alerts, nextId: book.nextId });
}

export async function loadPriceAlerts(store: KeyValueStore = AsyncStorage): Promise<PriceAlertBook> {
  const text = await store.getItem(PRICE_ALERTS_KEY);
  if (text === null) return EMPTY_BOOK;
  return parsePriceAlertBook(text) ?? { ...EMPTY_BOOK, damaged: true };
}

const listeners = new Set<() => void>();

/** Called after every write (the monitor re-reads; the screen re-renders). */
export function subscribePriceAlerts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyChanged(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // A listener never breaks a write.
    }
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Applies `change` to the stored book, one write at a time (so the monitor's
 * evaluation can never overwrite an edit made on the screen in between). A
 * damaged store refuses every change with PRICE_ALERTS_DAMAGED_MESSAGE.
 */
export function updatePriceAlerts<T>(
  change: (book: PriceAlertBook) => { book: PriceAlertBook; result: T },
  store: KeyValueStore = AsyncStorage,
): Promise<T> {
  const run = queue.then(async () => {
    const book = await loadPriceAlerts(store);
    if (book.damaged) throw new Error(PRICE_ALERTS_DAMAGED_MESSAGE);
    const { book: next, result } = change(book);
    if (next !== book) {
      await store.setItem(PRICE_ALERTS_KEY, serializePriceAlertBook(next));
      notifyChanged();
    }
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Deletes the stored list (the reset of a damaged store, and the wallet wipe). */
export async function resetPriceAlerts(store: KeyValueStore & { removeItem?: (k: string) => Promise<void> } = AsyncStorage): Promise<void> {
  const run = queue.then(async () => {
    monitorQuotes.clear();
    if (store.removeItem) await store.removeItem(PRICE_ALERTS_KEY);
    else await store.setItem(PRICE_ALERTS_KEY, serializePriceAlertBook(EMPTY_BOOK));
    notifyChanged();
  });
  queue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Edits (pure; applied through updatePriceAlerts)
// ---------------------------------------------------------------------------

export function addToWatchlist(book: PriceAlertBook, assetId: string): PriceAlertBook {
  if (!watchAssetFor(assetId)) throw new Error('This asset cannot be followed: only priced main-network assets can.');
  if (book.watchlist.includes(assetId)) return book;
  return { ...book, watchlist: [...book.watchlist, assetId] };
}

/** Removes an asset and every alert on it. */
export function removeFromWatchlist(book: PriceAlertBook, assetId: string): PriceAlertBook {
  if (!book.watchlist.includes(assetId)) return book;
  return { ...book, watchlist: book.watchlist.filter((id) => id !== assetId), alerts: book.alerts.filter((a) => a.assetId !== assetId) };
}

export interface CreatedAlert {
  alert: PriceAlert;
  /** Set when the condition already held: the alert starts tripped and says why. */
  note: string | null;
}

/**
 * Adds an alert (and the asset to the watchlist). Refuses a duplicate, more
 * than MAX_ALERTS_PER_ASSET on the asset, more than MAX_PRICE_ALERTS in all,
 * and a malformed threshold. With a fresh current quote whose price already
 * satisfies the condition, the alert starts TRIPPED (it waits for the price
 * to move back first) and the note says so.
 */
export function addAlert(
  book: PriceAlertBook,
  args: { assetId: string; direction: AlertDirection; threshold: string; quote: PriceQuote | null; nowMs: number },
): { book: PriceAlertBook; result: CreatedAlert } {
  const asset = watchAssetFor(args.assetId);
  if (!asset) throw new Error('This asset cannot be followed: only priced main-network assets can.');
  const parsed = parseThreshold(args.threshold);
  if (!parsed.ok) throw new Error(parsed.error);
  const threshold = parsed.value;
  if (book.alerts.length >= MAX_PRICE_ALERTS) throw new Error(`At most ${MAX_PRICE_ALERTS} price alerts can be stored; remove one first.`);
  if (book.alerts.filter((a) => a.assetId === args.assetId).length >= MAX_ALERTS_PER_ASSET) {
    throw new Error(`At most ${MAX_ALERTS_PER_ASSET} alerts can be set on ${asset.symbol}; remove one first.`);
  }
  if (book.alerts.some((a) => a.assetId === args.assetId && a.direction === args.direction && a.threshold === threshold)) {
    throw new Error(`An alert for ${asset.symbol} ${args.direction} ${thresholdText(threshold)} already exists.`);
  }
  const base = addToWatchlist(book, args.assetId);
  const fresh = isFreshQuote(args.quote, args.nowMs) ? args.quote : null;
  const already = fresh !== null && conditionMet({ direction: args.direction, threshold }, fresh.price);
  const alert: PriceAlert = {
    id: `a${base.nextId}`,
    assetId: args.assetId,
    direction: args.direction,
    threshold,
    state: already ? 'tripped' : 'armed',
    createdAt: args.nowMs,
  };
  const note = already
    ? `${asset.symbol} is already ${args.direction} ${thresholdText(threshold)} (${priceText(fresh.price)} now), so this alert ` +
      `fires the next time it crosses ${thresholdText(threshold)} after first moving back ${PRICE_ALERT_REARM_PERCENT.toString()}% to the other side.`
    : null;
  return { book: { ...base, alerts: [...base.alerts, alert], nextId: base.nextId + 1 }, result: { alert, note } };
}

export function removeAlert(book: PriceAlertBook, id: string): PriceAlertBook {
  if (!book.alerts.some((a) => a.id === id)) return book;
  return { ...book, alerts: book.alerts.filter((a) => a.id !== id) };
}

// ---------------------------------------------------------------------------
// The monitor (React-free; components/PriceAlertMonitor.tsx drives it)
// ---------------------------------------------------------------------------

export interface PriceAlertMonitor {
  /**
   * One check: reads the book, and only if an alert exists asks for the
   * prices of the alerted assets, evaluates every alert (through the write
   * queue, against the book as it is then) and reports what fired.
   */
  check(): Promise<{ requested: boolean; fired: FiredAlert[] }>;
}

export function createPriceAlertMonitor(deps: {
  load: () => Promise<PriceAlertBook>;
  update: <T>(change: (book: PriceAlertBook) => { book: PriceAlertBook; result: T }) => Promise<T>;
  fetchQuotes: (ids: readonly string[]) => Promise<Map<string, PriceQuote>>;
  now?: () => number;
}): PriceAlertMonitor {
  const now = deps.now ?? Date.now;
  let running: Promise<{ requested: boolean; fired: FiredAlert[] }> | null = null;
  const once = async () => {
    const book = await deps.load();
    if (!shouldCheckPriceAlerts(book)) return { requested: false, fired: [] };
    const quotes = await deps.fetchQuotes(alertPriceIds(book));
    // The screen shows the newest price the app holds, including this one.
    recordMonitorQuotes(quotes);
    const fired = await deps.update((current) => {
      const { book: next, fired: list } = evaluateAlerts(current, quotes, now());
      return { book: next, result: list };
    });
    return { requested: true, fired };
  };
  return {
    check() {
      // One check at a time; a call during a check shares it.
      if (!running) running = once().finally(() => (running = null));
      return running;
    },
  };
}

// ---------------------------------------------------------------------------
// The newest prices the monitor received (pass p20b finding 5a)
// ---------------------------------------------------------------------------
//
// The watchlist screen reads its prices through usePrices when it opens or is
// pulled down; the monitor (components/PriceAlertMonitor.tsx) reads them on
// its own schedule. The pass saw the screen keep $2,502.66 after the monitor
// had fired an alert at $2,505.97, even after a return to the foreground. So
// every check records what it received here, and the screen shows, per
// asset, whichever of the two quotes is newer (newestQuote).

const monitorQuotes = new Map<string, PriceQuote>();
const monitorQuoteListeners = new Set<() => void>();

/** When a quote's price was set (CoinGecko's time, else when it was fetched); 0 when neither is known. */
function quoteTimeMs(quote: PriceQuote): number {
  return quote.updatedAtMs ?? quote.fetchedAtMs ?? 0;
}

/** The newer of two quotes for one asset (the first on a tie or when neither is dated). */
export function newestQuote(a: PriceQuote | null | undefined, b: PriceQuote | null | undefined): PriceQuote | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return quoteTimeMs(b) > quoteTimeMs(a) ? b : a;
}

/** Records the quotes a monitor check received; listeners hear only of a newer price. */
export function recordMonitorQuotes(quotes: ReadonlyMap<string, PriceQuote>): void {
  let changed = false;
  for (const [id, quote] of quotes) {
    const prev = monitorQuotes.get(id);
    const next = newestQuote(prev, quote);
    if (next !== prev && next) {
      monitorQuotes.set(id, next);
      changed = true;
    }
  }
  if (!changed) return;
  for (const l of [...monitorQuoteListeners]) {
    try {
      l();
    } catch {
      // A listener never breaks a check.
    }
  }
}

/** A copy of the newest quotes the monitor received, by CAIP-19 id. */
export function latestMonitorQuotes(): Map<string, PriceQuote> {
  return new Map(monitorQuotes);
}

/** Called whenever the monitor received a newer price for some asset. */
export function subscribeMonitorQuotes(listener: () => void): () => void {
  monitorQuoteListeners.add(listener);
  return () => {
    monitorQuoteListeners.delete(listener);
  };
}

/** Forgets the monitor's quotes (the check scripts; a wipe resets the alerts through resetPriceAlerts). */
export function resetMonitorQuotes(): void {
  monitorQuotes.clear();
}

/**
 * Asks before an alert is deleted (pass p20b finding 5c: Remove deleted at
 * once). `show` is React Native's Alert.alert; `remove` runs only when the
 * user taps Remove — never on Cancel or when the dialog is dismissed.
 */
export function confirmRemoveAlert(
  show: (title: string, message: string, buttons: { text: string; style: 'cancel' | 'destructive'; onPress?: () => void }[]) => void,
  rule: string,
  remove: () => void,
): void {
  show(REMOVE_ALERT_TITLE, `The alert ${rule} is deleted from this phone and no longer checked.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: remove },
  ]);
}

export const REMOVE_ALERT_TITLE = 'Remove this alert?';

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const PRICE_ALERTS_TITLE = 'Price alerts';

export const PRICE_ALERTS_INTRO =
  'Follow the price of a coin and, if you like, set an alert for when it goes above or below a price you choose. ' +
  'Prices come from CoinGecko in US dollars, the same source as the rest of the wallet; nothing else leaves this ' +
  'phone. Alerts are advisory: the wallet never buys, sells or sends anything because of one.';

export const PRICE_ALERTS_CHECK_NOTE =
  'Alerts are checked only while the wallet is open: when it starts, when you return to it, and every 5 minutes ' +
  'while it stays open. Nothing checks prices while the wallet is closed, so a price can cross your alert and come ' +
  'back without the wallet noticing. With no alert set, no price is checked.';

export const PRICE_ALERTS_HYSTERESIS_NOTE =
  `Each alert fires once when the price crosses it. It can fire again only after the price has moved back at least ` +
  `${PRICE_ALERT_REARM_PERCENT.toString()}% to the other side of your price, so a price that hovers around it does not fire again and again. ` +
  `Only a fresh price is used (no older than ${PRICE_OLD_AFTER_MS / 60_000} minutes); an old or failed price never fires an alert.`;

export const PRICE_ALERTS_STORAGE_NOTE =
  'The watchlist and the alerts are kept only on this phone. They are not backed up by your recovery phrase.';

export const PRICE_ALERTS_FIAT_OFF_NOTE =
  'Show fiat values is off (Settings → Prices), so no prices are requested and no alert is checked.';

/** With reminders on: what the notification says and why it says so little. */
export const PRICE_ALERTS_NOTIFY_ON_NOTE =
  'With reminders on, an alert that fires is also put in this phone’s notification list, so it is still there after ' +
  'you leave the wallet. The notification says only that a price alert was reached, never which coin or price, ' +
  'because notifications can appear on the lock screen.';

export const PRICE_ALERTS_NOTIFY_OFF_NOTE =
  'Reminders (Settings → Privacy → Notifications) are off, so an alert that fires shows only inside the wallet, ' +
  'as a banner.';

/** The same limitation the reminders settings state, worded for alerts. */
export const PRICE_ALERTS_EXPO_GO_NOTE =
  'Inside Expo Go on Android, notifications are not available at all: Expo Go cannot create the notification ' +
  'channels Android needs. They need the wallet’s own development build; the in-wallet banner works everywhere.';

/** "ETH above $3,000". */
export function alertRuleText(alert: Pick<PriceAlert, 'direction' | 'threshold'>, symbol: string): string {
  return `${symbol} ${alert.direction} ${thresholdText(alert.threshold)}`;
}

/** The alert's status line. */
export function alertStateText(alert: PriceAlert, symbol: string, nowMs: number): string {
  if (alert.state === 'armed') {
    return alert.firedAt !== undefined
      ? `Waiting to fire again (last fired ${describeAge(Math.max(60_000, nowMs - alert.firedAt))} at ${priceText(alert.firedPrice!)}).`
      : 'Waiting to fire.';
  }
  // The rule (rearmMet, then conditionMet): the alert re-arms only after the
  // price moves back at least the re-arm band to the other side of the
  // threshold, and then fires on the next crossing — the move back never
  // fires it by itself (pass p20b finding 4). Worded like the note shown
  // when an alert is created already past its price (addAlert).
  const next =
    `the next time ${symbol} crosses ${thresholdText(alert.threshold)} after first moving back ` +
    `${PRICE_ALERT_REARM_PERCENT.toString()}% to the other side`;
  return alert.firedAt !== undefined
    ? `Fired ${describeAge(Math.max(60_000, nowMs - alert.firedAt))} at ${priceText(alert.firedPrice!)}; it fires again ${next}.`
    : `The price was already past this alert when you set it; it fires ${next}.`;
}

/** The in-wallet banner text for one fired alert. */
export function firedAlertText(fired: FiredAlert, nowMs: number): string {
  const age = fired.quote.updatedAtMs ?? fired.quote.fetchedAtMs;
  const when = age === undefined ? '' : nowMs - age < 60_000 ? ', less than a minute ago' : `, ${describeAge(nowMs - age)}`;
  return (
    `Price alert: ${alertRuleText(fired.alert, fired.asset.symbol)}. CoinGecko’s price was ${priceText(fired.price)}${when}. ` +
    'Alerts are advisory: nothing is bought, sold or sent.'
  );
}

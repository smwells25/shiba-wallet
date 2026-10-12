// Phase 20 item 1, feature 97: profit and loss (src/wallet/pnl.ts) and the
// historical-price glue (src/wallet/prices.ts fetchPriceHistory) OFFLINE.
// Hand-made history entries in the shapes the history providers return, an
// hourly price series in the market_chart/range shape, and a fake fetch:
// the average-cost figures exact to the fraction, transfers between the
// wallet's own addresses excluded, assumed fees kept out of realised, every
// gap sentence (incomplete history, the 365-day window, missing counterparty,
// amount, time, price point, balance, today's price, the smart account),
// tokens refused, Hide amounts, and the price request discipline (one
// request, none when fiat is off, none out of range, cached). Ends with
// mutants written from scratch copies of pnl.ts, each caught.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-pnl.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as L from '../src/wallet/pnl.ts';
import { formatMoney, moneyEquals, moneyOf, moneySub, moneySum } from '../src/wallet/portfolio.ts';
import { fetchPriceHistory, resetPriceHistoryCache, resetSharedPriceProvider } from '../src/wallet/prices.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const ETH = 10n ** 18n;
const NOW = 1_791_770_400_000; // 2026-10-12 01:00 UTC
const H = 3_600;
const nowSec = NOW / 1000;
const ME = '0x0000000000000000000000000000000000000001';
const SMART = '0x0000000000000000000000000000000000000011';
const EXCHANGE = '0x00000000000000000000000000000000000000e1';
const SHOP = '0x00000000000000000000000000000000000000e2';
const t1 = nowSec - 30 * 86_400; // purchase 2 ETH at $2000
const t2 = nowSec - 20 * 86_400; // purchase 1 ETH at $3000
const t3 = nowSec - 10 * 86_400; // sale 1.5 ETH at $4000
const t4 = nowSec - 5 * 86_400; // own transfer 0.5 ETH to the smart account

const entry = (id, ts, direction, amount, counterparty, extra = {}) => ({
  id,
  timestamp: ts,
  confirmed: true,
  blockHeight: ts,
  direction,
  amount,
  ...(counterparty ? { counterparty } : {}),
  ...extra,
});
// Newest first, as the Activity list holds them.
const baseEntries = [
  entry('0x4', t4, 'out', ETH / 2n, SMART),
  entry('0x3', t3, 'out', (3n * ETH) / 2n, SHOP),
  entry('0x2', t2, 'in', ETH, EXCHANGE),
  entry('0x1', t1, 'in', 2n * ETH, EXCHANGE),
];
// Hourly points from 31 days ago to now; $2000 before t2, $3000 before t3, $4000 after.
const points = [];
for (let s = nowSec - 31 * 86_400; s <= nowSec; s += H) {
  points.push({ timeMs: s * 1000, price: s < t2 - H / 2 ? '2000' : s < t3 - H / 2 ? '3000' : '4000' });
}
const quote = { assetId: 'eip155:1/slip44:60', currency: 'usd', price: '3500', provider: 'coingecko', updatedAtMs: NOW - 60_000, fetchedAtMs: NOW - 30_000 };
const base = {
  asset: { priceId: 'eip155:1/slip44:60', symbol: 'ETH', decimals: 18 },
  entries: baseEntries,
  hasMore: false,
  smartAccount: { address: SMART, status: 'included' },
  ownAddresses: [ME, SMART],
  balance: (14n * ETH) / 10n, // 1.5 held per history − 0.1 assumed fees
  prices: { status: 'ok', points, granularity: 'hourly' },
  currentQuote: quote,
  nowMs: NOW,
};
const usd = (n, d = 1n) => ({ n, d });

// ===========================================================================
console.log('check-pnl: average cost, exact');
// ===========================================================================
const r = L.computeNativePnl(base);
{
  check('the result is computed (no gap)', r.kind === 'ok', JSON.stringify(r.reasons ?? []));
  check('realised = 1.5 × $4000 − 1.5 × $2333.33… = +$2,500 exactly', r.kind === 'ok' && moneyEquals(r.realised, usd(2500n)));
  check('held = 1.4 ETH (the balance)', r.kind === 'ok' && r.held === (14n * ETH) / 10n);
  check('assumed fees = 0.1 ETH at average cost $233.33…', r.kind === 'ok' && r.assumedFees === ETH / 10n && moneyEquals(r.assumedFeesCost, usd(700n, 3n)));
  check('cost of what is held = $3,266.66… exactly', r.kind === 'ok' && moneyEquals(r.costBasis, usd(9800n, 3n)));
  check('unrealised = 1.4 × $3500 − $3,266.66… = +$1,633.33… exactly', r.kind === 'ok' && moneyEquals(r.unrealised, moneySub(moneyOf((14n * ETH) / 10n, 18, '3500'), usd(9800n, 3n))));
  check('average cost = $2,333.33… per ETH', r.kind === 'ok' && moneyEquals(r.averageCost, usd(7000n, 3n)));
  check('cost + fees + sold cost = everything bought ($7,000)', r.kind === 'ok' && moneyEquals(moneySum([r.costBasis, r.assumedFeesCost, usd(3500n)]), usd(7000n)));
  check('2 purchases and 1 sale counted', r.kind === 'ok' && r.purchases === 2 && r.sales === 1);
  const lines = L.pnlFigureLines(r, { symbol: 'ETH', decimals: 18 }, false);
  check('figure lines read as designed', JSON.stringify(lines.map((l) => l.text)) === JSON.stringify(['1.4 ETH', '$4,900.00', '$3,266.67', '$2,333.33 per ETH', '+$1,633.33', '+$2,500.00', '0.1 ETH, cost $233.33', '2 purchases, 1 sale']), JSON.stringify(lines.map((l) => l.text)));
  check('every assumption is stated', r.kind === 'ok' &&
    r.notes.some((n) => n.startsWith('Method: average cost.')) &&
    r.notes.some((n) => n.includes('counts as buying it') && n.includes('counts as selling it')) &&
    r.notes.some((n) => n.includes('nearest to it (hourly for this range), never more than 3 hours away')) &&
    r.notes.some((n) => n.startsWith('Unrealised profit or loss uses today’s CoinGecko price')) &&
    r.notes.some((n) => n.includes('assumes it paid network fees') && n.includes('Fees are not counted in realised profit or loss')) &&
    r.notes.some((n) => n.includes('not tax or accounting records')));
}

// ===========================================================================
console.log('check-pnl: transfers between your own addresses are not purchases or sales');
// ===========================================================================
{
  check('the own transfer is reported as not counted', r.kind === 'ok' && r.notes.includes('1 transfer between your own addresses (accounts, smart accounts, multi-signature accounts) is not counted as a purchase or a sale.'));
  const without = L.computeNativePnl({ ...base, entries: baseEntries.slice(1) });
  check('removing the own transfer changes nothing', without.kind === 'ok' && r.kind === 'ok' && moneyEquals(without.realised, r.realised) && moneyEquals(without.unrealised, r.unrealised));
  const caseInsensitive = L.computeNativePnl({ ...base, ownAddresses: [ME.toUpperCase().replace('0X', '0x'), SMART.toUpperCase().replace('0X', '0x')] });
  check('own addresses match regardless of letter case', caseInsensitive.kind === 'ok' && moneyEquals(caseInsensitive.realised, usd(2500n)));
  const self = L.computeNativePnl({ ...base, entries: [entry('0x9', t4, 'self', ETH, ME), ...baseEntries] });
  check('a self-transfer is not counted either', self.kind === 'ok' && moneyEquals(self.realised, usd(2500n)));
}

// ===========================================================================
console.log('check-pnl: fees are not in realised');
// ===========================================================================
{
  const noFees = L.computeNativePnl({ ...base, balance: (15n * ETH) / 10n });
  check('realised is the same with or without the assumed fees', noFees.kind === 'ok' && moneyEquals(noFees.realised, usd(2500n)) && noFees.assumedFees === 0n);
  check('with no shortfall there is no fee line', noFees.kind === 'ok' && !L.pnlFigureLines(noFees, { symbol: 'ETH', decimals: 18 }, false).some((l) => l.label.startsWith('Assumed')));
}

// ===========================================================================
console.log('check-pnl: every gap is a sentence and no figure');
// ===========================================================================
const reasonsOf = (input) => {
  const out = L.computeNativePnl(input);
  return out.kind === 'gap' ? out.reasons : [];
};
{
  const gap = (s) => `Profit and loss cannot be worked out for ETH: ${s}`;
  check('incomplete history', reasonsOf({ ...base, hasMore: true }).includes(gap(`transactions before ${L.utcDate(t1 * 1000)} are not in the loaded history. Load older history until it is complete.`)));
  check('the date in it is UTC', L.utcDate(t1 * 1000) === '2026-09-12 (UTC)', L.utcDate(t1 * 1000));
  const old = entry('0x0', nowSec - 400 * 86_400, 'in', ETH, EXCHANGE);
  check('older than the 365-day window: "N transactions before <date>"', reasonsOf({ ...base, entries: [...baseEntries, old] }).includes(
    gap(`1 transaction before ${L.utcDate(NOW - 365 * 86_400_000)} is older than the 365 days of price history CoinGecko’s free service provides, so there is no price at its time. Today’s price is not used instead, because it is not a cost basis.`)));
  check('no counterparty (e.g. Bitcoin providers)', reasonsOf({ ...base, entries: baseEntries.map((e) => ({ ...e, counterparty: undefined })) }).includes(
    gap('4 transactions do not name the other address, so transfers between your own accounts cannot be told apart from purchases and sales.')));
  check('no amount', reasonsOf({ ...base, entries: [...baseEntries, entry('0x7', t1, 'in', undefined, EXCHANGE)] }).includes(gap('1 transaction in the loaded history has no amount.')));
  check('no time', reasonsOf({ ...base, entries: [...baseEntries, entry('0x8', null, 'in', ETH, EXCHANGE)] }).includes(gap('1 transaction has no time, so no price at that time can be found.')));
  check('price history failed', reasonsOf({ ...base, prices: { status: 'failed', message: 'CoinGecko answered HTTP 500' } }).includes(gap('the price history could not be read (CoinGecko answered HTTP 500).')));
  check('fiat values off', reasonsOf({ ...base, prices: { status: 'unavailable', reason: 'fiat-off' } }).includes(gap('Show fiat values is off (Settings → Prices), so no prices are requested.')));
  const sparse = points.filter((p) => Math.abs(p.timeMs - t2 * 1000) > 4 * H * 1000);
  check('no price point within the tolerance', reasonsOf({ ...base, prices: { status: 'ok', points: sparse, granularity: 'hourly' } }).includes(gap('no CoinGecko price was found within 3 hours of 1 transaction.')));
  check('balance unread', reasonsOf({ ...base, balance: null }).includes(gap('the current balance could not be read. Pull down to try again.')));
  check('today’s price missing', reasonsOf({ ...base, currentQuote: null }).includes(gap('today’s price is not available from CoinGecko right now.')));
  check('more held than the history explains', reasonsOf({ ...base, balance: 2n * ETH }).includes(gap('the balance is 0.5 ETH more than the loaded history explains, so some ETH arrived in a way the history does not list.')));
  check('more sent than received', reasonsOf({ ...base, entries: baseEntries.slice(0, 2) }).includes(gap(`the loaded history shows more ETH sent than received before ${L.utcDate(t3 * 1000)}, so earlier transactions are missing from it.`)));
  check('the smart account’s history failed', reasonsOf({ ...base, smartAccount: { address: SMART, status: 'failed' } }).includes(gap('the smart account’s history could not be loaded, so its transfers are missing. Pull down to try again.')));
  check('the smart account’s history skipped (no indexer)', reasonsOf({ ...base, smartAccount: { address: SMART, status: 'skipped' } }).some((s) => s.includes('not listed by the current history source')));
  const many = L.computeNativePnl({ ...base, hasMore: true, balance: null, currentQuote: null });
  check('every gap is reported, not only the first', many.kind === 'gap' && many.reasons.length === 3);
  check('a gap carries no figure', many.kind === 'gap' && !('realised' in many) && many.reasons.every((s) => !/\$/.test(s)));
}

// ===========================================================================
console.log('check-pnl: tokens, failed and pending entries');
// ===========================================================================
{
  const token = entry('0x5', t2, 'in', 0n, EXCHANGE, { assetSymbol: 'USDC', assetAmount: 5_000_000n, assetDecimals: 6 });
  const withToken = L.computeNativePnl({ ...base, entries: [token, ...baseEntries] });
  check('a token transfer is not part of the ETH figures and the refusal is stated', withToken.kind === 'ok' && moneyEquals(withToken.realised, usd(2500n)) &&
    withToken.notes.some((n) => n.startsWith('1 token transfer is in the loaded history') && n.includes('a look-alike token could not be told apart')));
  const failedTx = entry('0x6', t2, 'out', ETH, SHOP, { failed: true });
  const pending = { ...entry('0x7', null, 'in', ETH, EXCHANGE), confirmed: false };
  const r2 = L.computeNativePnl({ ...base, entries: [pending, failedTx, ...baseEntries] });
  check('failed and pending transactions are skipped and said', r2.kind === 'ok' && moneyEquals(r2.realised, usd(2500n)) &&
    r2.notes.includes('1 failed transaction moved no coins and is skipped.') && r2.notes.includes('1 pending transaction is not counted until confirmed.'));
}

// ===========================================================================
console.log('check-pnl: Hide amounts');
// ===========================================================================
{
  const lines = L.pnlFigureLines(r, { symbol: 'ETH', decimals: 18 }, true);
  check('every figure is masked (only the counts remain)', lines.filter((l) => l.label !== 'Counted').every((l) => !/\d/.test(l.text)), JSON.stringify(lines));
}

// ===========================================================================
console.log('check-pnl: the price range');
// ===========================================================================
{
  const range = L.pnlPriceRange(base);
  check('hour-aligned, a day before the oldest counted transfer, up to now', range && range.fromSec % H === 0 && range.toSec % H === 0 && range.fromSec <= t1 - 86_400 && range.fromSec > t1 - 86_400 - H && range.toSec >= nowSec);
  check('stable within the hour (the same range a minute later)', JSON.stringify(L.pnlPriceRange({ ...base, nowMs: NOW + 60_000 })) === JSON.stringify(L.pnlPriceRange({ ...base, nowMs: NOW + 120_000 })));
  check('never before the 365-day window', L.pnlPriceRange({ ...base, entries: [entry('0x1', nowSec - 364.9 * 86_400, 'in', ETH, EXCHANGE)] }).fromSec >= nowSec - 365 * 86_400);
  check('none when nothing needs a price (only own transfers)', L.pnlPriceRange({ ...base, entries: [baseEntries[0]] }) === null);
}

// ===========================================================================
console.log('check-pnl: the historical price request (prices.ts fetchPriceHistory)');
// ===========================================================================
{
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (url.includes('/bitcoin/')) {
      return { ok: false, status: 401, headers: { get: () => null }, text: async () => '{"error":{"status":{"error_code":10012,"error_message":"Your request exceeds the allowed time range."}}}' };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"prices":[[1791518400000,2491.7034609181637],[1791522000000,2485.655005877573]],"market_caps":[],"total_volumes":[]}' };
  };
  const store = { getItem: async () => null, setItem: async () => undefined };
  resetPriceHistoryCache();
  resetSharedPriceProvider();
  const opts = { enabled: true, store, fetchFn: fakeFetch, now: () => NOW };
  const ok = await fetchPriceHistory('eip155:1/slip44:60', nowSec - 30 * 86_400, nowSec, opts);
  check('one request to /coins/ethereum/market_chart/range with precision=full', calls.length === 1 && calls[0].url.startsWith('https://api.coingecko.com/api/v3/coins/ethereum/market_chart/range?vs_currency=usd&from=') && calls[0].url.endsWith('&precision=full'), calls[0]?.url);
  check('the points keep the vendor digits; 30 days is hourly', ok.status === 'ok' && ok.points[0].price === '2491.7034609181637' && ok.granularity === 'hourly');
  await fetchPriceHistory('eip155:1/slip44:60', nowSec - 30 * 86_400, nowSec, opts);
  check('the same range again is served from the cache (no request)', calls.length === 1);
  const off = await fetchPriceHistory('eip155:1/slip44:60', nowSec - 30 * 86_400, nowSec, { ...opts, enabled: false });
  check('Show fiat values off: no request', off.status === 'unavailable' && off.reason === 'fiat-off' && calls.length === 1);
  const far = await fetchPriceHistory('eip155:1/slip44:60', nowSec - 400 * 86_400, nowSec, opts);
  check('a range older than 365 days: no request', far.status === 'unavailable' && far.reason === 'out-of-range' && calls.length === 1);
  const token = await fetchPriceHistory('eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', nowSec - 86_400 * 2, nowSec, opts);
  check('a token has no history read: no request', token.status === 'unavailable' && token.reason === 'unsupported' && calls.length === 1);
  const test = await fetchPriceHistory('eip155:11155111/slip44:60', nowSec - 86_400 * 2, nowSec, opts);
  check('a test-network coin has no history read: no request', test.status === 'unavailable' && test.reason === 'unsupported' && calls.length === 1);
  const refused = await fetchPriceHistory('bip122:000000000019d6689c085ae165831e93/slip44:0', nowSec - 200 * 86_400, nowSec, opts);
  check('the vendor’s 365-day refusal is named', refused.status === 'failed' && refused.message.includes('past 365 days') && calls.length === 2);
  check('200 days is daily granularity (documented)', (await fetchPriceHistory('eip155:1/slip44:60', nowSec - 200 * 86_400, nowSec, opts)).granularity === 'daily');
}

// ===========================================================================
console.log('Mutation checks (scratch copies of pnl.ts)');
// ===========================================================================
const MUTANT_DIR = join(HERE, `.mutants-pnl-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(from, to) {
  const relPath = 'src/wallet/pnl.ts';
  const original = readFileSync(join(HERE, '..', relPath), 'utf8');
  if (!original.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(HERE, '..', relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-pnl.ts`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
{
  const m1 = await importMutant("    if (own.has(e.counterparty.toLowerCase())) {\n      ownTransfers += 1;\n      continue;\n    }\n", '');
  const r1 = m1.computeNativePnl(base);
  check('mutant (own transfers counted as sales) is caught', !(r1.kind === 'ok' && moneyEquals(r1.realised, usd(2500n))));
  const m2 = await importMutant('  if (input.hasMore) {', '  if (false) {');
  check('mutant (incomplete history accepted) is caught', m2.computeNativePnl({ ...base, hasMore: true }).kind === 'ok');
  const m3 = await importMutant('    if (e.timestamp * 1000 < cutoffMs) {\n      tooOld += 1;\n      continue;\n    }\n', '');
  const old = entry('0x0', nowSec - 400 * 86_400, 'in', ETH, EXCHANGE);
  const r3 = m3.computeNativePnl({ ...base, entries: [...baseEntries, old], prices: { status: 'ok', points: [{ timeMs: (nowSec - 400 * 86_400) * 1000, price: '3500' }, ...points], granularity: 'hourly' } });
  check('mutant (a transaction outside the window valued anyway) is caught', r3.kind === 'ok');
  const m4 = await importMutant('    cost = moneySub(cost, assumedFeesCost);\n', '    cost = moneySub(cost, assumedFeesCost);\n    realised = moneySub(realised, assumedFeesCost);\n');
  const r4 = m4.computeNativePnl(base);
  check('mutant (fees counted in realised) is caught', r4.kind === 'ok' && !moneyEquals(r4.realised, usd(2500n)));
  const m5 = await importMutant("    if (!e.counterparty) {\n      noCounterparty += 1;\n      continue;\n    }\n", "    if (!e.counterparty) {\n      external.push(e);\n      continue;\n    }\n");
  const noCp = { ...base, entries: baseEntries.slice(1).map((e) => ({ ...e, counterparty: undefined })) };
  check('…the same input is a gap on the real module', L.computeNativePnl(noCp).kind === 'gap');
  check('mutant (entries without a counterparty treated as external) is caught', m5.computeNativePnl(noCp).kind === 'ok');
}

console.log(`\nformatMoney sanity: ${formatMoney(usd(2500n), { hidden: false, signed: true })}`);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

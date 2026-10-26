// Phase 20 item 1, feature 97: profit and loss (src/wallet/pnl.ts) and the
// historical-price glue (src/wallet/prices.ts fetchPriceHistory) OFFLINE.
// Hand-made history entries in the shapes the history providers return, an
// hourly price series in the market_chart/range shape, and a fake fetch:
// the average-cost figures exact to the fraction, transfers between the
// wallet's own addresses excluded, assumed fees kept out of realised, every
// gap sentence (incomplete history, the 365-day window, missing counterparty,
// amount, time, price point, balance, today's price, the smart account),
// tokens (a tracked token counted by its exact contract, look-alikes left out,
// a contract-less token transfer a gap, no assumed fees), Hide amounts, and the price request discipline (one
// request, none when fiat is off, none out of range, cached). Phase 23 item 8,
// second slice: a tracked token's price history by contract (the request,
// the cache keyed by contract, the recorded keyless USDC answer in
// packages/prices/test/fixtures driving exact token figures), which tokens
// get a button (pnlTokenChoices) and the panel's source. Ends with mutants
// written from scratch copies of pnl.ts and prices.ts, each caught.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-pnl.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as L from '../src/wallet/pnl.ts';
import { formatMoney, moneyEquals, moneyOf, moneySub, moneySum } from '../src/wallet/portfolio.ts';
import { fetchPriceHistory, historySourceFor, resetPriceHistoryCache, resetSharedPriceProvider } from '../src/wallet/prices.ts';

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
  check('a token transfer is not part of the ETH figures, and where token figures are is stated', withToken.kind === 'ok' && moneyEquals(withToken.realised, usd(2500n)) &&
    withToken.notes.includes('1 token transfer is in the loaded history and is not part of these ETH figures. Profit and loss for a token is worked out separately, from that token’s own transfers: each ERC-20 token tracked on the active main network that CoinGecko prices has its own button.') &&
    !withToken.notes.some((n) => n.includes('not offered yet')) &&
    !withToken.notes.some((n) => n.includes('look-alike')), JSON.stringify(withToken.notes));
  const withContract = L.computeNativePnl({ ...base, entries: [{ ...token, contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }, ...baseEntries] });
  check('…a token transfer that names its contract changes nothing in the ETH figures', withContract.kind === 'ok' && moneyEquals(withContract.realised, usd(2500n)) &&
    JSON.stringify(withContract.notes) === JSON.stringify(withToken.notes));
  const failedTx = entry('0x6', t2, 'out', ETH, SHOP, { failed: true });
  const pending = { ...entry('0x7', null, 'in', ETH, EXCHANGE), confirmed: false };
  const r2 = L.computeNativePnl({ ...base, entries: [pending, failedTx, ...baseEntries] });
  check('failed and pending transactions are skipped and said', r2.kind === 'ok' && moneyEquals(r2.realised, usd(2500n)) &&
    r2.notes.includes('1 failed transaction moved no coins and is skipped.') && r2.notes.includes('1 pending transaction is not counted until confirmed.'));
}

// ===========================================================================
console.log('check-pnl: a tracked token, counted by its exact contract (phase 23 item 8)');
// ===========================================================================
const UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'; // the contract under test (any 20 bytes would do)
const UNI_CHECKSUM = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
const LOOKALIKE = '0x00000000000000000000000000000000000000aa';
const UNIT = 10n ** 6n; // a 6-decimal token keeps the arithmetic readable
const tok = (id, ts, direction, amount, counterparty, extra = {}) => ({
  id, timestamp: ts, confirmed: true, blockHeight: ts, direction,
  assetSymbol: 'UNI', assetAmount: amount, assetDecimals: 6, contract: UNI,
  ...(counterparty ? { counterparty } : {}), ...extra,
});
const tokenEntries = [
  tok('0xt4', t4, 'out', 10n * UNIT, SMART), // own transfer
  tok('0xt3', t3, 'out', 75n * UNIT, SHOP), // sale of 75 at $8
  tok('0xt2', t2, 'in', 50n * UNIT, EXCHANGE), // purchase of 50 at $6
  tok('0xt1', t1, 'in', 100n * UNIT, EXCHANGE), // purchase of 100 at $5
];
const tokenPoints = [];
for (let s = nowSec - 31 * 86_400; s <= nowSec; s += H) {
  tokenPoints.push({ timeMs: s * 1000, price: s < t2 - H / 2 ? '5' : s < t3 - H / 2 ? '6' : '8' });
}
const TOKEN_ASSET = { priceId: `eip155:1/erc20:${UNI_CHECKSUM}`, symbol: 'UNI', decimals: 6, contract: UNI };
const tokenBase = {
  ...base,
  asset: TOKEN_ASSET,
  // Old-shaped native entries (no contract) stay in the history as the Activity list holds them.
  entries: [...tokenEntries, ...baseEntries],
  balance: 75n * UNIT,
  prices: { status: 'ok', points: tokenPoints, granularity: 'hourly' },
  currentQuote: { ...quote, assetId: TOKEN_ASSET.priceId, price: '7' },
};
const tr = L.computeTokenPnl(tokenBase);
{
  const tgap = (s) => `Profit and loss cannot be worked out for UNI: ${s}`;
  const treasons = (input) => {
    const out = L.computeTokenPnl(input);
    return out.kind === 'gap' ? out.reasons : [];
  };
  check('computed from the token’s own entries (no gap)', tr.kind === 'ok', JSON.stringify(tr.reasons ?? []));
  check('average cost $5.33… per UNI; realised = 75 × $8 − 75 × $5.33… = +$200 exactly', tr.kind === 'ok' && moneyEquals(tr.realised, usd(200n)) && moneyEquals(tr.averageCost, usd(16n, 3n)));
  check('held 75 UNI; cost of what is held $400; unrealised = 75 × $7 − $400 = +$125', tr.kind === 'ok' && tr.held === 75n * UNIT && moneyEquals(tr.costBasis, usd(400n)) && moneyEquals(tr.unrealised, usd(125n)));
  check('2 purchases and 1 sale; no assumed fees for a token', tr.kind === 'ok' && tr.purchases === 2 && tr.sales === 1 && tr.assumedFees === 0n);
  check('the figure lines name the token', tr.kind === 'ok' && JSON.stringify(L.pnlFigureLines(tr, TOKEN_ASSET, false).map((l) => l.text)) === JSON.stringify(['75 UNI', '$525.00', '$400.00', '$5.33 per UNI', '+$125.00', '+$200.00', '2 purchases, 1 sale']), JSON.stringify(tr.kind === 'ok' && L.pnlFigureLines(tr, TOKEN_ASSET, false).map((l) => l.text)));
  check('the method note says fees are not in the token', tr.kind === 'ok' && tr.notes[0] === 'Method: average cost. Each purchase adds UNI and its cost to one pool; each sale removes UNI at the pool’s average cost. Network fees are paid in the network’s own coin, not in UNI, and are not part of these figures.');
  check('the contract counted is stated, and the native entries are said to be left out', tr.kind === 'ok' &&
    tr.notes.includes(`Only transfers of the tracked UNI contract ${UNI} are counted.`) &&
    tr.notes.includes('4 transfers of the network’s own coin or of other tokens are not part of these UNI figures.') &&
    tr.notes.includes('1 transfer between your own addresses (accounts, smart accounts, multi-signature accounts) is not counted as a purchase or a sale.'), JSON.stringify(tr.notes));

  // A look-alike: another contract that calls itself UNI.
  const fake = tok('0xf1', t2, 'in', 1_000n * UNIT, EXCHANGE, { contract: LOOKALIKE });
  const withFake = L.computeTokenPnl({ ...tokenBase, entries: [fake, ...tokenBase.entries] });
  check('a look-alike (same symbol, another contract) is left out: the figures are unchanged', withFake.kind === 'ok' && moneyEquals(withFake.realised, usd(200n)) && withFake.held === 75n * UNIT);
  check('…and counted in a sentence', withFake.kind === 'ok' && withFake.notes.includes('1 transfer of a token from another contract calls itself UNI; it is not the tracked UNI and is left out.'), JSON.stringify(withFake.notes));
  const twoFakes = L.computeTokenPnl({ ...tokenBase, entries: [fake, { ...fake, id: '0xf2', assetSymbol: 'uni ' }, ...tokenBase.entries] });
  check('…plural, and the symbol compared without case or edge spaces', twoFakes.kind === 'ok' && twoFakes.notes.includes('2 transfers of tokens from another contract call themselves UNI; they are not the tracked UNI and are left out.'));
  const otherToken = L.computeTokenPnl({ ...tokenBase, entries: [tok('0xo1', t2, 'in', 5n * UNIT, EXCHANGE, { assetSymbol: 'DAI', contract: '0x6b175474e89094c44da98b954eedeac495271d0f' }), ...tokenBase.entries] });
  check('another token (other symbol, other contract) is an other asset, not a look-alike', otherToken.kind === 'ok' && otherToken.notes.includes('5 transfers of the network’s own coin or of other tokens are not part of these UNI figures.') && !otherToken.notes.some((n) => n.includes('calls itself')));
  check('the contract is compared without case (a checksummed entry is still the token)', L.computeTokenPnl({ ...tokenBase, entries: tokenBase.entries.map((e) => (e.contract ? { ...e, contract: UNI_CHECKSUM } : e)) }).kind === 'ok');

  // A token transfer without a contract (an entry built before the field existed, or a provider that did not know it).
  const noContract = (e) => { const { contract: _c, ...rest } = e; return rest; };
  check('a token transfer that names no contract is a gap (it could be the tracked token under another label), never a guess',
    treasons({ ...tokenBase, entries: [noContract(tok('0xn1', t2, 'in', 1n, EXCHANGE, { assetSymbol: 'SOMETHING' })), ...tokenBase.entries] })
      .includes(tgap('1 token transfer does not name its contract, so it cannot be told apart from the tracked UNI.')));
  check('…plural', treasons({ ...tokenBase, entries: tokenEntries.map(noContract) }).includes(tgap('4 token transfers do not name their contract, so they cannot be told apart from the tracked UNI.')));
  check('old-shaped native entries (no contract) are never a gap for a token', tr.kind === 'ok' && baseEntries.every((e) => !('contract' in e)));
  check('another number of decimals on the token’s own contract is a gap',
    treasons({ ...tokenBase, entries: [tok('0xd1', t2, 'in', 5n, EXCHANGE, { assetDecimals: 18 }), ...tokenBase.entries] })
      .includes(tgap('1 transfer of its contract reports a number of decimals other than the 6 this wallet has for UNI, so its amount is not certain.')));
  check('no amount on the token’s own entry is a gap', treasons({ ...tokenBase, entries: [tok('0xa1', t2, 'in', undefined, EXCHANGE), ...tokenBase.entries] }).includes(tgap('1 transaction in the loaded history has no amount.')));

  // Fees are never assumed for a token.
  check('less held than the history shows is a gap for a token (fees are not paid in it)',
    treasons({ ...tokenBase, balance: 70n * UNIT }).includes(tgap('the loaded history shows 5 UNI more received than is held now, and network fees are not paid in UNI, so some UNI left in a way the history does not list.')));
  check('more held than the history explains is the native gap sentence', treasons({ ...tokenBase, balance: 80n * UNIT }).includes(tgap('the balance is 5 UNI more than the loaded history explains, so some UNI arrived in a way the history does not list.')));

  // Today: the wallet reads no price history for tokens.
  // The bounded-broadcast follow-ups (phase 23): since the contract route
  // (4325590) the wallet DOES read token price histories, so "unsupported"
  // can only mean the token's chain is not a mapped main network; the old
  // "does not read … for tokens yet" sentence would be untrue.
  check('a token whose price history is not read: the gap says why (its network is not a mapped main network), never "not … for tokens yet"',
    treasons({ ...tokenBase, prices: { status: 'unavailable', reason: 'unsupported' } })
      .includes(tgap('its network is not a main network for which this wallet reads CoinGecko’s price history of tokens (a main network with a CoinGecko asset platform mapped for it), so there is no price at the time of its transfers.')) && L.TOKEN_PNL_UNSUPPORTED_REASON === 'its network is not a main network for which this wallet reads CoinGecko’s price history of tokens (a main network with a CoinGecko asset platform mapped for it), so there is no price at the time of its transfers.' &&
      !/for tokens yet|only for the native coins/.test(readFileSync(join(HERE, '..', 'src/wallet/pnl.ts'), 'utf8')));
  check('…the native sentence for "unsupported" is unchanged',
    reasonsOf({ ...base, prices: { status: 'unavailable', reason: 'unsupported' } }).includes('Profit and loss cannot be worked out for ETH: CoinGecko has no price history for it.'));
  check('a failed transfer of the token “moved no UNI”', (() => {
    const out = L.computeTokenPnl({ ...tokenBase, entries: [tok('0xx1', t2, 'in', UNIT, EXCHANGE, { failed: true }), ...tokenBase.entries] });
    return out.kind === 'ok' && out.notes.includes('1 failed transaction moved no UNI and is skipped.');
  })());

  // The price range covers only the token's own contract.
  const range = L.pnlPriceRange({ ...tokenBase });
  const nativeRange = L.pnlPriceRange({ ...tokenBase, asset: undefined });
  check('the price range of a token starts from its own oldest counted transfer', range && range.fromSec <= t1 - 86_400 && range.fromSec > t1 - 86_400 - H);
  const olderFake = tok('0xf9', nowSec - 60 * 86_400, 'in', UNIT, EXCHANGE, { contract: LOOKALIKE });
  check('…a look-alike older transfer does not widen it', JSON.stringify(L.pnlPriceRange({ ...tokenBase, entries: [...tokenBase.entries, olderFake] })) === JSON.stringify(range));
  check('…and without a token asset the range is the native one, as before', JSON.stringify(nativeRange) === JSON.stringify(L.pnlPriceRange(base)));

  // tokenPnlAsset: only a tracked ERC-20 token on an active main network.
  const usdcMain = { kind: 'fungible', assetId: { chainId: 'eip155:1', namespace: 'erc20', reference: UNI_CHECKSUM }, symbol: 'UNI', name: 'Uniswap', decimals: 18 };
  const ok = L.tokenPnlAsset(usdcMain, 'eip155:1');
  check('a mainnet ERC-20 token tracked on the active mainnet: its price id and its lowercased contract',
    ok.status === 'ok' && ok.asset.priceId === `eip155:1/erc20:${UNI_CHECKSUM}` && ok.asset.contract === UNI && ok.asset.decimals === 18, JSON.stringify(ok));
  const sepolia = { ...usdcMain, assetId: { ...usdcMain.assetId, chainId: 'eip155:11155111' } };
  check('a test-network token is refused with its sentence',
    JSON.stringify(L.tokenPnlAsset(sepolia, 'eip155:11155111')) === JSON.stringify({ status: 'refused', reason: 'Profit and loss cannot be worked out for UNI: it is not a token tracked on a main network that is active now, so it has no price (test-network tokens have no value).' }));
  check('a mainnet token while another network is active is refused the same way', L.tokenPnlAsset(usdcMain, 'eip155:11155111').status === 'refused');
  check('an NFT is not an ERC-20 token', L.tokenPnlAsset({ ...usdcMain, assetId: { ...usdcMain.assetId, namespace: 'erc721' } }, 'eip155:1').reason === 'Profit and loss cannot be worked out for UNI: it is not an ERC-20 token.');
  const nameless = { id: '0xnft', timestamp: t2, confirmed: true, blockHeight: t2, direction: 'in', contract: LOOKALIKE, counterparty: EXCHANGE };
  const withNameless = L.computeNativePnl({ ...base, entries: [nameless, ...baseEntries] });
  check('a token entry with a contract but no symbol or amount (an NFT the indexer did not name) is a token, not an ETH transfer without an amount',
    withNameless.kind === 'ok' && moneyEquals(withNameless.realised, usd(2500n)) && withNameless.notes.some((n) => n.startsWith('1 token transfer is in the loaded history')), JSON.stringify(withNameless.kind === 'gap' ? withNameless.reasons : withNameless.notes));
  check('the native result for the same history is unchanged by the token entries (they are other assets there)',
    (() => {
      const n = L.computeNativePnl({ ...base, entries: [...tokenEntries, ...baseEntries] });
      return n.kind === 'ok' && moneyEquals(n.realised, usd(2500n)) && n.notes.some((x) => x.startsWith('4 token transfers are in the loaded history'));
    })());
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
  const test = await fetchPriceHistory('eip155:11155111/slip44:60', nowSec - 86_400 * 2, nowSec, opts);
  check('a test-network coin has no history read: no request', test.status === 'unavailable' && test.reason === 'unsupported' && calls.length === 1);
  // Tokens (phase 23 item 8, second slice): mainnet ERC-20 tokens are read by contract.
  const usdc = await fetchPriceHistory('eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', nowSec - 86_400 * 2, nowSec, opts);
  check('a mainnet token: one request to /coins/ethereum/contract/<its contract, lowercase>/market_chart/range',
    usdc.status === 'ok' && calls.length === 2 &&
      calls[1].url.startsWith('https://api.coingecko.com/api/v3/coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/market_chart/range?vs_currency=usd&from=') &&
      calls[1].url.endsWith('&precision=full'), calls[1]?.url);
  const testToken = await fetchPriceHistory('eip155:11155111/erc20:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', nowSec - 86_400 * 2, nowSec, opts);
  check('a test-network token has no history read: no request', testToken.status === 'unavailable' && testToken.reason === 'unsupported' && calls.length === 2);
  const baseToken = await fetchPriceHistory('eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', nowSec - 86_400 * 2, nowSec, opts);
  check('a token of a chain that is not one of the wallet’s main networks (Base): no request', baseToken.status === 'unavailable' && baseToken.reason === 'unsupported' && calls.length === 2);
  const nft = await fetchPriceHistory('eip155:1/erc721:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', nowSec - 86_400 * 2, nowSec, opts);
  check('an NFT id or a malformed id: no request', nft.status === 'unavailable' && (await fetchPriceHistory('eip155:1/erc20:0xA0b8', nowSec - 86_400, nowSec, opts)).status === 'unavailable' && calls.length === 2);
  check('historySourceFor maps the native coin to its coin id and a mainnet token to (ethereum, lowercase contract), nothing else',
    JSON.stringify(historySourceFor('eip155:1/slip44:60')) === JSON.stringify({ kind: 'coin', coinId: 'ethereum' }) &&
      JSON.stringify(historySourceFor('eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')) === JSON.stringify({ kind: 'token', platformId: 'ethereum', contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' }) &&
      historySourceFor('eip155:11155111/erc20:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238') === null &&
      historySourceFor('constructor') === null);
  const dai = await fetchPriceHistory('eip155:1/erc20:0x6B175474E89094C44Da98b954EedeAC495271d0F', nowSec - 86_400 * 2, nowSec, opts);
  check('a second token over the same range makes its OWN request (the cache is keyed by contract)',
    dai.status === 'ok' && calls.length === 3 && calls[2].url.includes('/contract/0x6b175474e89094c44da98b954eedeac495271d0f/'), calls[2]?.url);
  await fetchPriceHistory('eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', nowSec - 86_400 * 2, nowSec, opts);
  check('…and the first token again is served from its own cache entry', calls.length === 3);
  const refused = await fetchPriceHistory('bip122:000000000019d6689c085ae165831e93/slip44:0', nowSec - 200 * 86_400, nowSec, opts);
  check('the vendor’s 365-day refusal is named', refused.status === 'failed' && refused.message.includes('past 365 days') && calls.length === 4);
  check('200 days is daily granularity (documented)', (await fetchPriceHistory('eip155:1/slip44:60', nowSec - 200 * 86_400, nowSec, opts)).granularity === 'daily');
}

// ===========================================================================
console.log('check-pnl: token profit and loss from the recorded keyless USDC answer (phase 23 item 8, second slice)');
// ===========================================================================
// The ONE keyless answer recorded on 2026-10-26 (packages/prices/test/fixtures):
// /coins/ethereum/contract/0xa0b8…eb48/market_chart/range, 2026-10-23 00:00 to
// 2026-10-25 00:00 UTC, 49 hourly points. A synthetic history is placed exactly
// on three of its points, so every figure is the fixture's prices, exact.
const USDC_FIXTURE = readFileSync(join(HERE, '..', '..', 'packages', 'prices', 'test', 'fixtures', 'coingecko-usdc-ethereum-contract-range-2026-10-23.json'), 'utf8');
const USDC_CHECKSUM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC = USDC_CHECKSUM.toLowerCase();
const USDC_TOKEN = { kind: 'fungible', assetId: { chainId: 'eip155:1', namespace: 'erc20', reference: USDC_CHECKSUM }, symbol: 'USDC', name: 'USD Coin', decimals: 6 };
const NOW_T = 1_792_890_000_000; // 2026-10-25 01:00 UTC
const U = 10n ** 6n;
const usdcTx = (id, ts, direction, amount, counterparty, extra = {}) => ({
  id, timestamp: ts, confirmed: true, blockHeight: ts, direction,
  assetSymbol: 'USDC', assetAmount: amount, assetDecimals: 6, contract: USDC, counterparty, ...extra,
});
const tA = 1_792_720_800; // point 2: 0.9995026714754317
const tB = 1_792_800_000; // point 24: 0.9997198080018516
const tC = 1_792_857_600; // point 40: 0.9996848575625291
const usdcEntries = [
  usdcTx('0xu3', tC, 'out', 300n * U, SHOP), // a sale of 300
  usdcTx('0xu2', tB, 'in', 500n * U, EXCHANGE), // a purchase of 500
  usdcTx('0xu1', tA, 'in', 1_000n * U, EXCHANGE), // a purchase of 1,000
  entry('0xe1', tA, 'in', ETH, EXCHANGE), // the network's own coin: not part of USDC
];
// An exact fraction from a decimal literal, independent of the module under test.
const frac = (lit) => { const [w, f = ''] = lit.split('.'); return { n: BigInt(w + f), d: 10n ** BigInt(f.length) }; };
const mul = (a, b) => ({ n: a.n * b.n, d: a.d * b.d });
const add = (a, b) => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const sub = (a, b) => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const amt = (base) => ({ n: base, d: U });
{
  const choices = L.pnlTokenChoices([USDC_TOKEN], 'eip155:1');
  const USDC_ASSET = choices[0];
  check('the tracked mainnet USDC is offered, with its price id and lowercase contract',
    choices.length === 1 && USDC_ASSET.priceId === `eip155:1/erc20:${USDC_CHECKSUM}` && USDC_ASSET.contract === USDC && USDC_ASSET.decimals === 6, JSON.stringify(choices));
  const own = [ME];
  const range = L.pnlPriceRange({ entries: usdcEntries, ownAddresses: own, nowMs: NOW_T, asset: USDC_ASSET });
  const calls = [];
  const fixtureFetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => USDC_FIXTURE };
  };
  resetPriceHistoryCache();
  resetSharedPriceProvider();
  const history = await fetchPriceHistory(USDC_ASSET.priceId, range.fromSec, range.toSec, {
    enabled: true, store: { getItem: async () => null, setItem: async () => undefined }, fetchFn: fixtureFetch, now: () => NOW_T,
  });
  check('the price history is one request by USDC’s own contract', calls.length === 1 && calls[0].includes(`/coins/ethereum/contract/${USDC}/market_chart/range?`), calls[0]);
  check('the recorded answer gives 49 hourly points, digit for digit', history.status === 'ok' && history.points.length === 49 && history.granularity === 'hourly' &&
    history.points[2].price === '0.9995026714754317' && history.points[24].price === '0.9997198080018516' && history.points[40].price === '0.9996848575625291');
  const usdcInput = {
    asset: USDC_ASSET,
    entries: usdcEntries,
    hasMore: false,
    smartAccount: null,
    ownAddresses: own,
    balance: 1_200n * U,
    prices: { status: 'ok', points: history.points, granularity: history.granularity },
    currentQuote: { assetId: USDC_ASSET.priceId, currency: 'usd', price: '0.9998', provider: 'coingecko', updatedAtMs: NOW_T - 60_000, fetchedAtMs: NOW_T - 30_000 },
    nowMs: NOW_T,
  };
  const ur = L.computeTokenPnl(usdcInput);
  const p1 = frac('0.9995026714754317'), p2 = frac('0.9997198080018516'), p3 = frac('0.9996848575625291');
  const cost = add(mul(amt(1_000n * U), p1), mul(amt(500n * U), p2));
  const costOut = mul(cost, { n: 300n, d: 1_500n });
  const realised = sub(mul(amt(300n * U), p3), costOut);
  const remaining = sub(cost, costOut);
  const unrealised = sub(mul(amt(1_200n * U), frac('0.9998')), remaining);
  check('computed from the fixture prices (no gap)', ur.kind === 'ok', JSON.stringify(ur.reasons ?? []));
  check('realised = 300 × p(C) − 300/1500 of the pool’s cost, exact to the fraction', ur.kind === 'ok' && moneyEquals(ur.realised, realised));
  check('cost of what is held = 1200/1500 of the pool’s cost; unrealised at $0.9998 exact', ur.kind === 'ok' && moneyEquals(ur.costBasis, remaining) && moneyEquals(ur.unrealised, unrealised));
  check('held 1,200 USDC; 2 purchases and 1 sale; no assumed fees', ur.kind === 'ok' && ur.held === 1_200n * U && ur.purchases === 2 && ur.sales === 1 && ur.assumedFees === 0n);
  check('the figure lines', ur.kind === 'ok' && JSON.stringify(L.pnlFigureLines(ur, USDC_ASSET, false).map((l) => l.text)) ===
    // Worked by hand: cost 1,000 × 0.99950267… + 500 × 0.99971980… = $1,499.36…;
    // 1,200/1,500 of it held = $1,199.49…; realised 300 × 0.99968485… − $299.87… = +$0.03…;
    // value 1,200 × $0.9998 = $1,199.76; unrealised +$0.26994… → +$0.27.
    JSON.stringify(['1200 USDC', '$1,199.76', '$1,199.49', '$1.00 per USDC', '+$0.27', '+$0.03', '2 purchases, 1 sale']), JSON.stringify(ur.kind === 'ok' && L.pnlFigureLines(ur, USDC_ASSET, false).map((l) => l.text)));
  check('the notes name the contract counted and the coin left out', ur.kind === 'ok' &&
    ur.notes.includes(`Only transfers of the tracked USDC contract ${USDC} are counted.`) &&
    ur.notes.includes('1 transfer of the network’s own coin or of other tokens is not part of these USDC figures.'), JSON.stringify(ur.notes));
  // A look-alike: another contract that calls itself USDC, with a large "purchase".
  const fakeUsdc = usdcTx('0xfake', tB, 'in', 1_000_000n * U, EXCHANGE, { contract: LOOKALIKE });
  const withFakeUsdc = L.computeTokenPnl({ ...usdcInput, entries: [fakeUsdc, ...usdcEntries] });
  check('a look-alike “USDC” is left out: the figures are the same to the fraction', withFakeUsdc.kind === 'ok' && moneyEquals(withFakeUsdc.realised, realised) && moneyEquals(withFakeUsdc.costBasis, remaining) && withFakeUsdc.held === 1_200n * U);
  check('…and the look-alike note says so', withFakeUsdc.kind === 'ok' && withFakeUsdc.notes.includes('1 transfer of a token from another contract calls itself USDC; it is not the tracked USDC and is left out.'), JSON.stringify(withFakeUsdc.notes));
  check('…an older look-alike does not widen the price range', JSON.stringify(L.pnlPriceRange({ entries: [usdcTx('0xold', tA - 30 * 86_400, 'in', U, EXCHANGE, { contract: LOOKALIKE }), ...usdcEntries], ownAddresses: own, nowMs: NOW_T, asset: USDC_ASSET })) === JSON.stringify(range));
  // Nothing in the fixture near a transaction outside its range: the gap, not a figure.
  const outside = L.computeTokenPnl({ ...usdcInput, entries: [usdcTx('0xu0', tA - 2 * 86_400, 'in', 100n * U, EXCHANGE), ...usdcEntries], balance: 1_300n * U });
  check('a transfer the recorded range has no price near is a gap sentence', outside.kind === 'gap' && outside.reasons.includes('Profit and loss cannot be worked out for USDC: no CoinGecko price was found within 3 hours of 1 transaction.'), JSON.stringify(outside));
  // Every gap sentence of the first slice is unchanged.
  check('…the token “unsupported” sentence (reworded in the bounded-broadcast follow-ups, see above)', (() => {
    const out = L.computeTokenPnl({ ...usdcInput, prices: { status: 'unavailable', reason: 'unsupported' } });
    return out.kind === 'gap' && out.reasons.includes('Profit and loss cannot be worked out for USDC: its network is not a main network for which this wallet reads CoinGecko’s price history of tokens (a main network with a CoinGecko asset platform mapped for it), so there is no price at the time of its transfers.');
  })());
  {
    const panelSrc = readFileSync(join(HERE, '..', 'src/screens/PortfolioViews.tsx'), 'utf8');
    check('the panel\'s retry hint fits a coin and a token alike: "choose it again", never "choose the coin again"',
      panelSrc.includes('Pull down or choose it again to retry.') && !panelSrc.includes('choose the coin again'));
  }
}

// ===========================================================================
console.log('check-pnl: which tokens get a profit-and-loss button (pnlTokenChoices)');
// ===========================================================================
{
  const sepoliaUsdc = { kind: 'fungible', assetId: { chainId: 'eip155:11155111', namespace: 'erc20', reference: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' }, symbol: 'USDC', name: 'USDC', decimals: 6 };
  const dai = { kind: 'fungible', assetId: { chainId: 'eip155:1', namespace: 'erc20', reference: '0x6B175474E89094C44Da98b954EedeAC495271d0F' }, symbol: 'DAI', name: 'Dai', decimals: 18 };
  const fakeTracked = { ...USDC_TOKEN, assetId: { ...USDC_TOKEN.assetId, reference: '0x00000000000000000000000000000000000000Aa' } };
  const ids = (list) => list.map((a) => a.contract);
  check('mainnet active: every tracked mainnet ERC-20 with a price id, in stored order', JSON.stringify(ids(L.pnlTokenChoices([USDC_TOKEN, dai], 'eip155:1'))) === JSON.stringify([USDC, dai.assetId.reference.toLowerCase()]));
  check('a test network active: none (its tokens have no value; a mainnet token is not on the active network)',
    L.pnlTokenChoices([sepoliaUsdc], 'eip155:11155111').length === 0 && L.pnlTokenChoices([USDC_TOKEN], 'eip155:11155111').length === 0);
  check('a test-network token in a mainnet list is never offered', JSON.stringify(ids(L.pnlTokenChoices([sepoliaUsdc, USDC_TOKEN], 'eip155:1'))) === JSON.stringify([USDC]));
  check('an NFT or a token of a chain the wallet has no main network for is never offered',
    L.pnlTokenChoices([{ ...dai, assetId: { ...dai.assetId, namespace: 'erc721' } }, { ...dai, assetId: { ...dai.assetId, chainId: 'eip155:8453' } }], 'eip155:1').length === 0);
  check('a contract listed twice (any case) is offered once', L.pnlTokenChoices([USDC_TOKEN, { ...USDC_TOKEN, assetId: { ...USDC_TOKEN.assetId, reference: USDC } }], 'eip155:1').length === 1);
  const both = L.pnlTokenChoices([USDC_TOKEN, fakeTracked], 'eip155:1');
  check('two tracked tokens with the same symbol: two buttons, each title naming its short contract',
    both.length === 2 && L.pnlTokenChipTitle(both[0], both, 'Ethereum', 'ETH') === 'USDC (0xa0b8…eb48) on Ethereum' &&
      L.pnlTokenChipTitle(both[1], both, 'Ethereum', 'ETH') === 'USDC (0x0000…00aa) on Ethereum');
  check('…a unique symbol keeps the short title', L.pnlTokenChipTitle(L.pnlTokenChoices([USDC_TOKEN], 'eip155:1')[0], L.pnlTokenChoices([USDC_TOKEN], 'eip155:1'), 'Ethereum', 'ETH') === 'USDC on Ethereum');
  check('…a token calling itself the network’s coin is told apart too', L.pnlTokenChipTitle({ ...both[1], symbol: 'eth' }, [both[1]], 'Ethereum', 'ETH') === 'eth (0x0000…00aa) on Ethereum');
  const panel = readFileSync(join(HERE, '..', 'src/screens/PortfolioViews.tsx'), 'utf8');
  check('the panel offers tokens only from pnlTokenChoices, only with the EVM slot priced on the active network',
    panel.includes('const evmSlot = usable.find((s) => s.evm && s.networkChainId === evmCaip2) ?? null;') &&
      panel.includes('pnlTokenChoices(tracked.tokens, evmCaip2)') &&
      panel.includes("...(evmSlot ? tokenChoices.map((asset) => ({ kind: 'token' as const, slot: evmSlot, asset })) : [])") &&
      panel.includes('computeTokenPnl({ ...common, asset: token })') &&
      panel.includes("loadTokenBalance(contract, h, { expectedChain: evmCaip2 })"));
  check('the intro says which coins and tokens are offered and that test-network ones are not',
    panel.includes("'CoinGecko’s prices. It is offered for the native coin of a main network and for each ERC-20 token tracked on ' +") &&
      panel.includes("'the active main network that CoinGecko prices, a token counted only by its own contract: test-network coins and ' +") &&
      panel.includes("'tokens have no price, so they are not offered.") && !panel.includes('tokens are not offered (see the notes)'));
}

// ===========================================================================
console.log('check-pnl: an empty first page is not "older ones exist" (pass p20b finding 3)');
// ===========================================================================
{
  const gap = (s) => `Profit and loss cannot be worked out for ETH: ${s}`;
  check('0 entries with more to search: says nothing was found so far, not that older ones exist',
    L.pnlHistoryLoadedLine(0, true) === 'No transactions were found in the history searched so far; older history has not been searched yet.', L.pnlHistoryLoadedLine(0, true));
  check('0 entries and nothing more: the history is empty',
    L.pnlHistoryLoadedLine(0, false) === 'No transactions were found: the history is empty.', L.pnlHistoryLoadedLine(0, false));
  check('a loaded page keeps its wording byte for byte',
    L.pnlHistoryLoadedLine(1, true) === '1 entry of history loaded; older ones exist.' &&
      L.pnlHistoryLoadedLine(4, false) === '4 entries of history loaded, which is all of it.');
  const emptyMore = reasonsOf({ ...base, entries: [], hasMore: true });
  check('the gap with an empty first page says nothing was found yet, not "not loaded yet"',
    emptyMore.includes(gap('no transactions were found in the history searched so far, and older history has not been searched yet. Load older history until it is complete.')) &&
      !emptyMore.some((x) => x.includes('older transactions are not loaded yet')), JSON.stringify(emptyMore));
  const panel = readFileSync(join(HERE, '..', 'src/screens/PortfolioViews.tsx'), 'utf8');
  check('the P&L panel draws the line from pnlHistoryLoadedLine (no inline "older ones exist")',
    panel.includes('{pnlHistoryLoadedLine(entries.length, hasMore)}') && !panel.includes("'; older ones exist'"));
  // The no-counterparty gap needs at least one entry (the record's "always
  // shows" was too strong): one confirmed Bitcoin transfer without the other
  // address raises it.
  const BTC = { priceId: 'bip122:000000000019d6689c085ae165831e93/slip44:0', symbol: 'BTC', decimals: 8 };
  const btc = L.computeNativePnl({
    ...base,
    asset: BTC,
    entries: [entry('btc1', t1, 'in', 100_000n, undefined)],
    smartAccount: null,
    ownAddresses: ['bc1qexample'],
    balance: 100_000n,
  });
  check('one Bitcoin entry with no counterparty shows the no-counterparty gap',
    btc.kind === 'gap' && btc.reasons.includes('Profit and loss cannot be worked out for BTC: 1 transaction does not name the other address, so transfers between your own accounts cannot be told apart from purchases and sales.'),
    JSON.stringify(btc));
  const btcEmpty = L.computeNativePnl({ ...base, asset: BTC, entries: [], smartAccount: null, ownAddresses: ['bc1qexample'], balance: 0n });
  check('…and an empty Bitcoin history raises no such gap (nothing to tell apart)',
    !(btcEmpty.kind === 'gap' && btcEmpty.reasons.some((x) => x.includes('do not name') || x.includes('does not name'))));
}

// ===========================================================================
console.log('Mutation checks (scratch copies of pnl.ts)');
// ===========================================================================
const MUTANT_DIR = join(HERE, `.mutants-pnl-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(from, to, relPath = 'src/wallet/pnl.ts', more = []) {
  const original = readFileSync(join(HERE, '..', relPath), 'utf8');
  let source = original;
  for (const [f, t] of [[from, to], ...more]) {
    if (!source.includes(f)) throw new Error(`mutation anchor not found: ${f}`);
    source = source.replace(f, t);
  }
  const originalDir = dirname(join(HERE, '..', relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-${relPath.split('/').pop()}`);
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
  const m6 = await importMutant("  if (count === 0) {", "  if (false) {");
  const m7 = await importMutant('    if (e.contract.toLowerCase() !== contract) {', '    if (false) {');
  const fake = { id: '0xf1', timestamp: t2, confirmed: true, blockHeight: t2, direction: 'in', assetSymbol: 'UNI', assetAmount: 1_000n * UNIT, assetDecimals: 6, contract: LOOKALIKE, counterparty: EXCHANGE };
  const r7 = m7.computeTokenPnl({ ...tokenBase, entries: [fake, ...tokenBase.entries] });
  check('mutant (a look-alike accepted as the tracked token) is caught', !(r7.kind === 'ok' && moneyEquals(r7.realised, usd(200n)) && r7.held === 75n * UNIT));
  const m8 = await importMutant('    if (isNative(e)) {\n      otherAssets += 1;\n      continue;\n    }\n    if (e.contract === undefined) {', '    if (e.contract === undefined) {');
  check('mutant (an old-shaped entry without a contract refused, the native ones included) is caught', m8.computeTokenPnl(tokenBase).kind === 'gap');
  const m9 = await importMutant('    if (e.contract === undefined) {\n      // Which token moved is unknown: it may be this one under another label.\n      unidentified += 1;\n      continue;\n    }\n', '    if (e.contract === undefined) {\n      otherAssets += 1;\n      continue;\n    }\n');
  check('mutant (a token transfer without a contract silently ignored) is caught', m9.computeTokenPnl({ ...tokenBase, entries: [{ ...fake, contract: undefined, assetSymbol: 'SOMETHING' }, ...tokenBase.entries] }).kind === 'ok');
  const m10 = await importMutant("  if (qty > balance && mode.kind === 'token') {", "  if (false) {");
  const r10 = m10.computeTokenPnl({ ...tokenBase, balance: 70n * UNIT });
  check('mutant (a token shortfall assumed to be network fees) is caught', r10.kind === 'ok' && r10.assumedFees === 5n * UNIT);
  check('mutant (the old "0 entries … older ones exist" line) is caught', m6.pnlHistoryLoadedLine(0, true) === '0 entries of history loaded; older ones exist.');

  // Phase 23 item 8, second slice.
  const sepoliaUsdc = { kind: 'fungible', assetId: { chainId: 'eip155:11155111', namespace: 'erc20', reference: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' }, symbol: 'USDC', name: 'USDC', decimals: 6 };
  const m11 = await importMutant('    const chosen = tokenPnlAsset(token, activeEvmCaip2);', '    const chosen = tokenPnlAsset(token, token.assetId.chainId);');
  check('mutant (a token checked against its own chain, not the active one: a mainnet token offered while a test network is active) is caught',
    m11.pnlTokenChoices([USDC_TOKEN], 'eip155:11155111').length === 1);
  const m12 = await importMutant('  if (priceId === null) {', '  if (false) {', 'src/wallet/pnl.ts', [
    ["    if (!source || source.kind !== 'token' || source.contract !== chosen.asset.contract) continue;\n", "    void source;\n"],
  ]);
  check('mutant (both guards gone: a test-network token offered) is caught', m12.pnlTokenChoices([sepoliaUsdc], 'eip155:11155111').length === 1);
  const m13 = await importMutant('    if (e.contract.toLowerCase() !== contract) {', '    if (false) {');
  const fakeUsdc = { id: '0xfake', timestamp: 1_792_800_000, confirmed: true, blockHeight: 1_792_800_000, direction: 'in', assetSymbol: 'USDC', assetAmount: 10n ** 12n, assetDecimals: 6, contract: LOOKALIKE, counterparty: EXCHANGE };
  const usdcAsset = L.pnlTokenChoices([USDC_TOKEN], 'eip155:1')[0];
  const fixturePoints = JSON.parse(USDC_FIXTURE).prices.map(([t, p]) => ({ timeMs: t, price: String(p) }));
  const lookalikeInput = {
    asset: usdcAsset, entries: [fakeUsdc, ...usdcEntries], hasMore: false, smartAccount: null, ownAddresses: [ME], balance: 1_200n * U,
    prices: { status: 'ok', points: fixturePoints, granularity: 'hourly' },
    currentQuote: { assetId: usdcAsset.priceId, currency: 'usd', price: '0.9998', provider: 'coingecko', updatedAtMs: NOW_T - 60_000, fetchedAtMs: NOW_T - 30_000 },
    nowMs: NOW_T,
  };
  check('…the real module leaves the look-alike out of the fixture case', L.computeTokenPnl(lookalikeInput).kind === 'ok');
  const r13 = m13.computeTokenPnl(lookalikeInput);
  check('mutant (a look-alike “USDC” counted in the fixture case) is caught', !(r13.kind === 'ok' && r13.held === 1_200n * U && r13.purchases === 2));
  const m14 = await importMutant('`token:${source.platformId}:${source.contract}|${from}|${to}`', '`token:${source.platformId}|${from}|${to}`', 'src/wallet/prices.ts');
  {
    const urls = [];
    const fetchFn = async (url) => {
      urls.push(url);
      const body = url.includes(USDC) ? USDC_FIXTURE : '{"prices":[[1792713600000,1.001]],"market_caps":[],"total_volumes":[]}';
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
    };
    const opts = { enabled: true, store: { getItem: async () => null, setItem: async () => undefined }, fetchFn, now: () => NOW_T };
    m14.resetPriceHistoryCache();
    await m14.fetchPriceHistory(usdcAsset.priceId, 1_792_713_600, 1_792_886_400, opts);
    const daiRes = await m14.fetchPriceHistory('eip155:1/erc20:0x6B175474E89094C44Da98b954EedeAC495271d0F', 1_792_713_600, 1_792_886_400, opts);
    check('mutant (the history cache keyed without the contract: another contract’s prices used) is caught',
      urls.length === 1 && daiRes.status === 'ok' && daiRes.points.length === 49);
  }
}

console.log(`\nformatMoney sanity: ${formatMoney(usd(2500n), { hidden: false, signed: true })}`);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

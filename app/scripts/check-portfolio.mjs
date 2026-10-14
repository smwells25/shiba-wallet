// Phase 20 item 1, feature 96: the unified portfolio (src/wallet/portfolio.ts)
// OFFLINE. Exercises the exact module the Portfolio screen runs under Node's
// type stripping, with hand-made read results and CoinGecko-shaped quotes:
// exact money, the read plan and its bound, the aggregate equal to the sum
// of its parts to the wei and to the exact dollar fraction, test assets
// never priced, watched addresses kept out of the net worth, Hide amounts
// masking every figure, the "not counted" sentences, and the screen's reuse
// of Home's loaders and price hook (source pins). Ends with mutants written
// from scratch copies of portfolio.ts (never git checkout), each caught.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-portfolio.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as P from '../src/wallet/portfolio.ts';
import { USDC_MAINNET } from '../src/wallet/erc20.ts';
import { KNOWN_TEST_NETWORK_TOKENS } from '../src/wallet/tokens.ts';

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

const ETH_ID = 'eip155:1/slip44:60';
const BTC_SLOT = 'bip122:000000000019d6689c085ae165831e93';
const DOGE_SLOT = 'bip122:1a91e3dace36e2be3bf030a65679fe82';
const SOL_SLOT = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const BTC_ID = `${BTC_SLOT}/slip44:0`;
const USDC_ID = `eip155:1/erc20:${USDC_MAINNET.assetId.reference}`;
const SEPOLIA = 'eip155:11155111';
const SEPOLIA_USDC = KNOWN_TEST_NETWORK_TOKENS[SEPOLIA][0];

const mainnetSlots = [
  { slot: 'eip155:1', networkChainId: 'eip155:1', label: 'Ethereum', symbol: 'ETH', decimals: 18, testnet: false, evm: true },
  { slot: BTC_SLOT, networkChainId: BTC_SLOT, label: 'Bitcoin', symbol: 'BTC', decimals: 8, testnet: false, evm: false },
  { slot: DOGE_SLOT, networkChainId: DOGE_SLOT, label: 'Dogecoin', symbol: 'DOGE', decimals: 8, testnet: false, evm: false },
  { slot: SOL_SLOT, networkChainId: SOL_SLOT, label: 'Solana', symbol: 'SOL', decimals: 9, testnet: false, evm: false },
];
const sepoliaSlots = [
  { slot: 'eip155:1', networkChainId: SEPOLIA, label: 'Ethereum Sepolia', symbol: 'test ETH', decimals: 18, testnet: true, evm: true },
  ...mainnetSlots.slice(1),
];

const A = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const accounts = [
  { key: 'phrase:0', name: 'Account 1', kind: 'phrase', hidden: false, evmAddress: A(1), otherAddresses: { [BTC_SLOT]: 'bc1qa', [DOGE_SLOT]: 'Da', [SOL_SLOT]: 'Sa' }, smartAccount: A(11) },
  { key: 'phrase:1', name: 'Account 2 (hidden)', kind: 'phrase', hidden: true, evmAddress: A(2), otherAddresses: null, smartAccount: null },
  { key: 'watch:3221225472', name: 'Watched 1', kind: 'watch', hidden: false, evmAddress: A(9), otherAddresses: null, smartAccount: null },
  { key: 'imported:2147483648', name: 'Imported 1 (imported key)', kind: 'imported', hidden: false, evmAddress: A(3), otherAddresses: null, smartAccount: A(13) },
  { key: 'multisig:3489660928', name: 'Multisig 1 (2-of-3)', kind: 'multisig', hidden: false, evmAddress: A(4), otherAddresses: null, smartAccount: null, multisigChain: 'eip155:1' },
  { key: 'multisig:3489660929', name: 'Multisig 2 (2-of-3)', kind: 'multisig', hidden: false, evmAddress: A(5), otherAddresses: null, smartAccount: null, multisigChain: SEPOLIA },
];
const quote = (assetId, price, extra = {}) => ({ assetId, currency: 'usd', price, provider: 'coingecko', updatedAtMs: 1_800_000_000_000, fetchedAtMs: 1_800_000_000_000, ...extra });

// ===========================================================================
console.log('check-portfolio: exact money');
// ===========================================================================
{
  const m = P.moneyOf(1_500_000_000_000_000_000n, 18, '2491.7034609181637');
  check('moneyOf is exact (1.5 ETH × 2491.7034609181637 = 3737.55519137724555)', P.moneyEquals(m, { n: 373755519137724555n, d: 100000000000000n }));
  check('formatMoney rounds half away from zero to the cent', P.formatMoney({ n: 3737555n, d: 1000n }, { hidden: false }) === '$3,737.56');
  check('formatMoney groups thousands', P.formatMoney({ n: 123456789n, d: 100n }, { hidden: false }) === '$1,234,567.89');
  check('a non-zero value below a cent reads "< $0.01"', P.formatMoney({ n: 1n, d: 1000n }, { hidden: false }) === '< $0.01');
  check('zero reads "$0.00"', P.formatMoney(P.ZERO_MONEY, { hidden: false }) === '$0.00');
  check('signed values carry + and −', P.formatMoney({ n: 150n, d: 100n }, { hidden: false, signed: true }) === '+$1.50' && P.formatMoney({ n: -150n, d: 100n }, { hidden: false, signed: true }) === '−$1.50');
  check('Hide amounts: every value is the same mask', new Set([P.ZERO_MONEY, { n: 1n, d: 1000n }, { n: 99999999n, d: 1n }].map((v) => P.formatMoney(v, { hidden: true }))).size === 1 && P.formatMoney({ n: 5n, d: 1n }, { hidden: true }) === '••••');
  check('spokenMoney says hidden under Hide amounts', P.spokenMoney({ n: 5n, d: 1n }, { hidden: true }) === 'hidden');
  check('moneySum of fractions with different denominators is exact', P.moneyEquals(P.moneySum([{ n: 1n, d: 3n }, { n: 1n, d: 6n }]), { n: 1n, d: 2n }));
}

// ===========================================================================
console.log('check-portfolio: the read plan and its bound');
// ===========================================================================
const tokens = [USDC_MAINNET];
const plan = P.planPortfolio({ accounts, slots: mainnetSlots, tokens });
{
  const keys = plan.tasks.map((t) => `${t.holder.label}|${t.asset.symbol}|${t.asset.networkLabel}`);
  check('Account 1: ETH and USDC on its address and on its smart account, plus BTC, DOGE and SOL', ['Account 1|ETH|Ethereum', 'Account 1|USDC|Ethereum', 'Account 1’s smart account|ETH|Ethereum', 'Account 1’s smart account|USDC|Ethereum', 'Account 1|BTC|Bitcoin', 'Account 1|DOGE|Dogecoin', 'Account 1|SOL|Solana'].every((k) => keys.includes(k)), keys.join(', '));
  check('a phrase account with unknown non-EVM addresses is listed, not guessed', plan.missingOtherAddresses.join() === 'Account 2 (hidden)' && !keys.some((k) => k.startsWith('Account 2 (hidden)|BTC')));
  check('a multisig recorded for another network is not read and is named', plan.otherNetworkMultisigs.join() === 'Multisig 2 (2-of-3)');
  check('a watch-only address is read on EVM only, last', plan.tasks.at(-1).holder.kind === 'watch' && plan.tasks.filter((t) => t.holder.kind === 'watch').every((t) => t.asset.slot === 'eip155:1'));
  check('an imported account gets its smart account too', keys.includes('Imported 1 (imported key)’s smart account|ETH|Ethereum'));
  check('total planned reads: 7 + 2 + 4 + 2 + 2 = 17', plan.tasks.length === 17 && plan.notRead.length === 0, String(plan.tasks.length));
  const bounded = P.planPortfolio({ accounts, slots: mainnetSlots, tokens, maxReads: 5 });
  check('the bound cuts at maxReads, own funds first and watched addresses last', bounded.tasks.length === 5 && bounded.notRead.length === 12 && bounded.tasks.every((t) => t.holder.kind === 'phrase') && bounded.notRead.at(-1).holder.kind === 'watch');
  check('the default bound is 60 reads, 4 at a time', P.PORTFOLIO_MAX_READS === 60 && P.PORTFOLIO_READ_CONCURRENCY === 4);
  const dup = P.planPortfolio({ accounts: [accounts[0], { ...accounts[2], evmAddress: A(1).toUpperCase().replace('0X', '0x') }], slots: mainnetSlots, tokens });
  check('the same address listed twice is read once (a watched copy of an own address)', dup.tasks.filter((t) => t.holder.address.toLowerCase() === A(1)).length === 2);
  check('the price ids are the mainnet ids (ETH, USDC, BTC, DOGE, SOL)', JSON.stringify(P.portfolioPriceIds(plan)) === JSON.stringify([ETH_ID, USDC_ID, BTC_ID, `${DOGE_SLOT}/slip44:3`, `${SOL_SLOT}/slip44:501`].sort()));
}

// Reads: Account 1 holds 1 wei + 10^18 − 1 wei of ETH across address and smart account (exactly 1 ETH),
// USDC 2.5, BTC 0.1; imported 3 ETH; multisig 0.5 ETH; watched 100 ETH; DOGE unavailable; SOL fails.
const results = new Map();
const put = (label, symbol, result) => {
  const t = plan.tasks.find((x) => x.holder.label === label && x.asset.symbol === symbol);
  if (!t) throw new Error(`no task ${label} ${symbol}`);
  results.set(t.key, result);
};
const ok = (amount, decimals, networkChainId) => ({ status: 'ok', amount, decimals, networkChainId });
put('Account 1', 'ETH', ok(1n, 18, 'eip155:1'));
put('Account 1’s smart account', 'ETH', ok(999_999_999_999_999_999n, 18, 'eip155:1'));
put('Account 1', 'USDC', ok(2_500_000n, 6, 'eip155:1'));
put('Account 1’s smart account', 'USDC', ok(0n, 6, 'eip155:1'));
put('Account 1', 'BTC', ok(10_000_000n, 8, BTC_SLOT));
put('Account 1', 'DOGE', { status: 'unavailable', note: 'No public keyless Dogecoin API is known.' });
put('Account 1', 'SOL', { status: 'error', message: 'fetch failed' });
put('Account 2 (hidden)', 'ETH', ok(0n, 18, 'eip155:1'));
put('Account 2 (hidden)', 'USDC', ok(0n, 6, 'eip155:1'));
put('Imported 1 (imported key)', 'ETH', ok(3_000_000_000_000_000_000n, 18, 'eip155:1'));
put('Imported 1 (imported key)', 'USDC', ok(0n, 6, 'eip155:1'));
put('Imported 1 (imported key)’s smart account', 'ETH', ok(0n, 18, 'eip155:1'));
put('Imported 1 (imported key)’s smart account', 'USDC', ok(0n, 6, 'eip155:1'));
put('Multisig 1 (2-of-3)', 'ETH', ok(500_000_000_000_000_000n, 18, 'eip155:1'));
put('Multisig 1 (2-of-3)', 'USDC', ok(0n, 6, 'eip155:1'));
put('Watched 1', 'ETH', ok(100_000_000_000_000_000_000n, 18, 'eip155:1'));
put('Watched 1', 'USDC', ok(0n, 6, 'eip155:1'));
const quotes = new Map([
  [ETH_ID, quote(ETH_ID, '2491.7034609181637')],
  [USDC_ID, quote(USDC_ID, '0.99988')],
  [BTC_ID, quote(BTC_ID, '83250.90730785819')],
]);
const summary = P.computePortfolio({ plan, results, quotes });

// ===========================================================================
console.log('check-portfolio: the aggregate equals the sum of its parts');
// ===========================================================================
{
  const eth = summary.byAsset.find((a) => a.asset.symbol === 'ETH');
  check('ETH total is exact to the wei (1 + (10^18 − 1) + 3·10^18 + 0.5·10^18; watched excluded)', eth.amount === 4_500_000_000_000_000_000n, String(eth.amount));
  const expected = P.moneySum([
    P.moneyOf(4_500_000_000_000_000_000n, 18, '2491.7034609181637'),
    P.moneyOf(2_500_000n, 6, '0.99988'),
    P.moneyOf(10_000_000n, 8, '83250.90730785819'),
  ]);
  check('net worth = Σ asset values (exact fraction)', P.moneyEquals(summary.netWorth, expected));
  check('net worth = Σ by-asset values', P.moneyEquals(summary.netWorth, P.moneySum(summary.byAsset.map((a) => a.value ?? P.ZERO_MONEY))));
  check('net worth = Σ by-network values', P.moneyEquals(summary.netWorth, P.moneySum(summary.byNetwork.map((g) => g.value))));
  check('net worth = Σ by-account values', P.moneyEquals(summary.netWorth, P.moneySum(summary.byAccount.map((g) => g.value))));
  check('net worth displays $19,540.26 (11,212.665574… + 2.4997 + 8,325.090730…)', P.formatMoney(summary.netWorth, { hidden: false }) === '$19,540.26', P.formatMoney(summary.netWorth, { hidden: false }));
  check('a multisig is counted in the net worth', summary.byAccount.some((g) => g.label === 'Multisig 1 (2-of-3)'));
  check('zero balances are listed nowhere', summary.byAccount.every((g) => g.holdings.every((h) => h.amount > 0n)) && !summary.byAccount.some((g) => g.label === 'Account 2 (hidden)'));
}

// ===========================================================================
console.log('check-portfolio: watched addresses are separated');
// ===========================================================================
{
  check('the watched balance is NOT in the net worth', !summary.byAccount.some((g) => g.label === 'Watched 1') && summary.byAsset.every((a) => a.amount < 100_000_000_000_000_000_000n));
  check('the watched total is its own figure', P.moneyEquals(summary.watchedTotal, P.moneyOf(100_000_000_000_000_000_000n, 18, '2491.7034609181637')) && summary.watchedByAccount.length === 1);
  check('the watched heading says it is not your funds', P.PORTFOLIO_WATCHED_HEADING === 'Watched addresses (not your funds)' && P.PORTFOLIO_WATCHED_NOTE.includes('never added to your net worth'));
}

// ===========================================================================
console.log('check-portfolio: test-network assets are never priced');
// ===========================================================================
{
  const tplan = P.planPortfolio({ accounts: accounts.slice(0, 1), slots: sepoliaSlots, tokens: [SEPOLIA_USDC] });
  const tres = new Map();
  for (const t of tplan.tasks) tres.set(t.key, ok(t.asset.slot === 'eip155:1' ? 5_000_000n : 1n, t.asset.decimals, t.asset.networkChainId));
  // Even with every mainnet price present, and even a quote keyed by the test ids, nothing on Sepolia is valued.
  const tq = new Map([...quotes, [`${SEPOLIA}/slip44:60`, quote(`${SEPOLIA}/slip44:60`, '2000')], [`${SEPOLIA}/erc20:${SEPOLIA_USDC.assetId.reference}`, quote('x', '1')]]);
  const ts = P.computePortfolio({ plan: tplan, results: tres, quotes: tq });
  const testRows = ts.byAsset.filter((a) => a.asset.networkChainId === SEPOLIA);
  check('Sepolia ETH and test USDC: status "test", no value', testRows.length === 2 && testRows.every((a) => a.status === 'test' && a.value === null));
  check('…shown as "test, no value"', P.valueText('test', null, false) === 'test, no value');
  check('…and listed in the gap lines', P.portfolioGapLines(ts, tplan).some((l) => l.endsWith('are test-network assets: test, no value.')));
  check('no price id is requested for a test asset', P.portfolioPriceIds(tplan).every((id) => !id.startsWith(SEPOLIA)));
  check('priceIdFor gives null for a test-network native coin and token', P.priceIdFor(tplan.tasks[0].asset, SEPOLIA) === null && P.priceIdFor(tplan.tasks[1].asset, SEPOLIA) === null);
  check('the net worth holds only the mainnet BTC (test ETH adds nothing)', P.moneyEquals(ts.netWorth, P.moneyOf(1n, 8, '83250.90730785819')));
  // A balance answered by another network than planned (the mode changed during the reads) is not used.
  const mres = new Map(tres);
  mres.set(tplan.tasks[0].key, ok(5n, 18, 'eip155:1'));
  const ms = P.computePortfolio({ plan: tplan, results: mres, quotes: tq });
  check('a read answered by another network is not used (counted as not read)', ms.failedReads === 1 && ms.byAsset.find((a) => a.asset.symbol === 'test ETH')?.amount === 5_000_000n);
}

// ===========================================================================
console.log('check-portfolio: Hide amounts masks every figure');
// ===========================================================================
{
  const h = summary.byAccount[0].holdings[0];
  const spoken = P.holdingSpokenLabel({ label: 'Main account', amount: h.amount, decimals: h.decimals, symbol: 'ETH', status: h.status, value: h.value, quote: h.quote, hidden: true, nowMs: 1_800_000_000_000 });
  check('amountText is masked', P.amountText(123456789n, 6, 'USDC', true) === '•••• USDC');
  check('valueText is masked', P.valueText('priced', { n: 5n, d: 1n }, true) === '≈ ••••');
  check('the spoken label holds no digits', !/\d/.test(spoken) && spoken.includes('hidden'), spoken);
  // Pass p20b finding 11: a test asset under Hide amounts read "amount
  // hidden, value hidden" although it has no value.
  const hiddenTest = P.holdingSpokenLabel({ label: 'Account 1, USDC on Ethereum Sepolia', amount: 41_089_603n, decimals: 6, symbol: 'USDC', status: 'test', value: null, quote: null, hidden: true, nowMs: 0 });
  check('hidden test asset: "amount hidden, test asset, no value", never "value hidden"',
    hiddenTest === 'Account 1, USDC on Ethereum Sepolia: USDC, amount hidden, test asset, no value', hiddenTest);
  check('hidden unpriced asset: "amount hidden, no price"',
    P.holdingSpokenLabel({ label: 'Account 1', amount: 5n, decimals: 0, symbol: 'XYZ', status: 'no-price', value: null, quote: null, hidden: true, nowMs: 0 }) === 'Account 1: XYZ, amount hidden, no price');
  check('hidden priced asset keeps "amount hidden, value hidden" byte for byte',
    P.holdingSpokenLabel({ label: 'Account 1', amount: 10_000_000n, decimals: 8, symbol: 'BTC', status: 'priced', value: P.moneyOf(10_000_000n, 8, '83250.90730785819'), quote: null, hidden: true, nowMs: 0 }) === 'Account 1: BTC, amount hidden, value hidden');
  check('unmasked test asset unchanged', P.holdingSpokenLabel({ label: 'Account 1, USDC on Ethereum Sepolia', amount: 41_089_603n, decimals: 6, symbol: 'USDC', status: 'test', value: null, quote: null, hidden: false, nowMs: 0 }) === 'Account 1, USDC on Ethereum Sepolia: 41.089603 USDC, test asset, no value');
  check('unmasked, the spoken label says the amount and the value', P.holdingSpokenLabel({ label: 'Account 1', amount: 10_000_000n, decimals: 8, symbol: 'BTC', status: 'priced', value: P.moneyOf(10_000_000n, 8, '83250.90730785819'), quote: null, hidden: false, nowMs: 0 }) === 'Account 1: 0.1 BTC, about 8,325.09 US dollars');
}

// ===========================================================================
console.log('check-portfolio: what is not counted is said');
// ===========================================================================
{
  const lines = P.portfolioGapLines(summary, plan);
  check('a failed read is said', lines.includes('1 balance could not be read and is not counted. Pull down to try again.'), lines.join(' | '));
  check('an unconfigured network is said', lines.some((l) => l.startsWith('1 balance could not be read because no endpoint is configured')));
  check('unknown non-EVM addresses are said', lines.some((l) => l.startsWith('The Bitcoin, Dogecoin and Solana addresses of Account 2 (hidden) are not known on this phone yet')));
  check('the other-network multisig is said', lines.includes('Multisig 2 (2-of-3) is recorded for another network and was not read.'));
  check('the summary is not complete', summary.complete === false);
  const bounded = P.planPortfolio({ accounts, slots: mainnetSlots, tokens, maxReads: 5 });
  const bs = P.computePortfolio({ plan: bounded, results: new Map(), quotes });
  check('reads beyond the bound are said', P.portfolioGapLines(bs, bounded)[0] === '12 balances were not read, to keep this screen’s network requests bounded (at most 60 per refresh); they are not counted.');
  const unpriced = P.computePortfolio({ plan, results, quotes: new Map([[ETH_ID, quotes.get(ETH_ID)]]) });
  check('a held mainnet asset with no price is "no price" and said', unpriced.unpricedSymbols.join() === 'USDC,BTC' && P.portfolioGapLines(unpriced, plan).includes('No price from CoinGecko for USDC and BTC; not counted.'));
  check('the counted sentence names the active network', P.portfolioCountedNote('Ethereum').startsWith('Counted: the native coins of Ethereum, Bitcoin, Dogecoin and Solana, and the tokens you track on Ethereum'));
  check('the not-counted sentence lists test assets and watched addresses', P.PORTFOLIO_NOT_COUNTED_NOTE.includes('watched addresses') && P.PORTFOLIO_NOT_COUNTED_NOTE.includes('test-network assets (they have no value)'));
  check('the price source line names CoinGecko and the age', P.portfolioPriceSourceLine({ oldestPriceMs: 1_800_000_000_000 }, 1_800_000_180_000) === 'Prices: CoinGecko, in US dollars; the oldest price used is from 3 min ago. Indicative market prices, not what a sale would fetch.');
  check('the reads note says it reads more than Home, and the bound', P.PORTFOLIO_READS_NOTE.includes('more requests than the Home screen') && P.PORTFOLIO_READS_NOTE.includes('at most 60 per refresh'));
}

// ===========================================================================
console.log('check-portfolio: reads are bounded in flight');
// ===========================================================================
{
  let inFlight = 0;
  let peak = 0;
  const res = await P.runPortfolioReads(plan.tasks, async (t) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight -= 1;
    if (t.asset.symbol === 'SOL') throw new Error('down');
    return ok(1n, t.asset.decimals, t.asset.networkChainId);
  });
  check('at most 4 reads at once', peak === 4, String(peak));
  check('every task gets a result; a thrown read becomes an error result', res.size === plan.tasks.length && [...res.values()].filter((r) => r.status === 'error').length === 1);
}

// ===========================================================================
console.log('check-portfolio: the screen reuses Home’s loaders and price hook (source pins)');
// ===========================================================================
{
  const screen = readFileSync(join(HERE, '..', 'src', 'screens', 'PortfolioScreen.tsx'), 'utf8');
  check('balances through loadNativeBalance / loadTokenBalance (Home’s failover rule)', screen.includes("from '../wallet/useBalances'") && screen.includes('loadNativeBalance(') && screen.includes("from '../wallet/useTokenBalances'"));
  check('prices through usePrices (the shared cache)', screen.includes('usePrices(plan ? portfolioPriceIds(plan) : [])'));
  check('no transport of its own and nothing that signs', !/httpTransport|signWith|requireLocalAuth|sendAa|prepareEvmSend/.test(screen));
  const home = readFileSync(join(HERE, '..', 'src', 'screens', 'HomeScreen.tsx'), 'utf8');
  check('Home links to Portfolio and Price alerts', home.includes("navigation.navigate('Portfolio')") && home.includes("navigation.navigate('PriceAlerts')"));
}

// ===========================================================================
console.log('Mutation checks (scratch copies of portfolio.ts)');
// ===========================================================================
const MUTANT_DIR = join(HERE, `.mutants-portfolio-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(from, to) {
  const relPath = 'src/wallet/portfolio.ts';
  const original = readFileSync(join(HERE, '..', relPath), 'utf8');
  if (!original.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(HERE, '..', relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-portfolio.ts`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
{
  // 1. Watched addresses counted in the net worth.
  const m1 = await importMutant("const counted = holdings.filter((h) => h.task.holder.kind !== 'watch');", 'const counted = holdings;');
  const s1 = m1.computePortfolio({ plan, results, quotes });
  check('mutant (watched counted) is caught', !m1.moneyEquals(s1.netWorth, summary.netWorth));
  // 2. Test assets priced (the testnet guard removed).
  const m2 = await importMutant("const status: ValueStatus = task.asset.testnet ? 'test' : quote ? 'priced' : 'no-price';", "const status: ValueStatus = quote ? 'priced' : 'no-price';");
  const tplan = m2.planPortfolio({ accounts: accounts.slice(0, 1), slots: sepoliaSlots, tokens: [] });
  const tres = new Map(tplan.tasks.map((t) => [t.key, ok(5n, t.asset.decimals, t.asset.networkChainId)]));
  const s2 = m2.computePortfolio({ plan: tplan, results: tres, quotes: new Map() });
  check('mutant (test guard removed) is caught: test ETH no longer reads "test"', !s2.byAsset.some((a) => a.status === 'test'));
  const mHidden = await importMutant("  if (args.hidden) return `${args.label}: ${args.symbol}, amount hidden, ${value}`;", "  if (args.hidden) return `${args.label}: ${args.symbol}, amount hidden, value hidden`;");
  check('mutant (the old "amount hidden, value hidden" for every asset) is caught',
    mHidden.holdingSpokenLabel({ label: 'A', amount: 1n, decimals: 0, symbol: 'USDC', status: 'test', value: null, quote: null, hidden: true, nowMs: 0 }) === 'A: USDC, amount hidden, value hidden');
  // 3. A rounding per holding instead of exact sums: the aggregate drifts from the parts.
  const m3 = await importMutant('export function moneyAdd(a: Money, b: Money): Money {\n  return moneyReduce({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });', 'export function moneyAdd(a: Money, b: Money): Money {\n  return moneyReduce({ n: (a.n * 100n / a.d) + (b.n * 100n / b.d), d: 100n });');
  const s3 = m3.computePortfolio({ plan, results, quotes });
  const exact = P.moneySum([P.moneyOf(4_500_000_000_000_000_000n, 18, '2491.7034609181637'), P.moneyOf(2_500_000n, 6, '0.99988'), P.moneyOf(10_000_000n, 8, '83250.90730785819')]);
  check('mutant (truncating sums) is caught', !P.moneyEquals(s3.netWorth, exact));
  // 4. Hide amounts not masking.
  const m4 = await importMutant("  if (options.hidden) return maskAmount('', true);\n  const cents = moneyCents(m);\n  const negative", '  const cents = moneyCents(m);\n  const negative');
  check('mutant (mask removed) is caught', m4.formatMoney({ n: 5n, d: 1n }, { hidden: true }) !== '••••');
  // 5. The read bound removed.
  const m5 = await importMutant('tasks: all.slice(0, maxReads),\n    notRead: all.slice(maxReads),', 'tasks: all,\n    notRead: [],');
  check('mutant (bound removed) is caught', m5.planPortfolio({ accounts, slots: mainnetSlots, tokens, maxReads: 5 }).tasks.length !== 5);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

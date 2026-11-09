// Phase 25 item 2, feature 99: portfolio insights and the risk overview
// (src/wallet/insights.ts, src/screens/InsightsScreen.tsx).
//
// OFFLINE. Drives the exact module the screen runs under Node's type
// stripping, with fakes for every source: a Portfolio reading built by the
// real portfolio.ts from hand-made balances and quotes, Approvals-screen
// items in the shapes approvals.ts produces, stored pending records, a
// storageProtection() result, spending scopes, a price-alert book and the
// endpoint peek. Covers every line's computation, the honesty rules (a
// failed read is "could not be read", never a figure; test assets never in a
// share; Hide amounts masks every amount, value and share; the masks and the
// addresses spoken in words), the memory-only snapshots (keyed by profile,
// accounts, network and owner), config/networks.ts peekEndpointHealth (no
// probe, overrides named), the source pins (the route, the Portfolio button,
// the Settings row, the Approvals and Portfolio hand-overs, no HomeScreen
// edit, no request of the module's or the screen's own), and ends with
// mutants written from scratch copies of insights.ts (never git checkout).
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-insights.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as I from '../src/wallet/insights.ts';
import * as P from '../src/wallet/portfolio.ts';
import { USDC_MAINNET } from '../src/wallet/erc20.ts';
import { KNOWN_TEST_NETWORK_TOKENS } from '../src/wallet/tokens.ts';
import { en } from '../src/i18n/en.ts';
import { es } from '../src/i18n/es.ts';
import { STORE_KEYS } from '../src/wallet/store-keys.ts';
import { peekEndpointHealth, getEndpoint } from '../src/config/networks.ts';
import { DEFAULT_NETWORKS } from '../src/config/defaults.ts';
import { MULTISIG_ALLOWED_ROUTES, WATCH_ONLY_ALLOWED_ROUTES, multisigRouteRefusal, watchOnlyRouteRefusal } from '../src/wallet/watch-only.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const read = (rel) => readFileSync(join(APP, rel), 'utf8');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

const MASK = '••••';
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const SPENDER = '0x1111111254EEB25477B68fb85Ed929f73A960582';
const OPERATOR = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC';
const NOW = 1_800_000_000_000;
const ETH_ID = 'eip155:1/slip44:60';
const USDC_ID = `eip155:1/erc20:${USDC_MAINNET.assetId.reference}`;
const BTC_SLOT = 'bip122:000000000019d6689c085ae165831e93';
const BTC_ID = `${BTC_SLOT}/slip44:0`;
const SEPOLIA = 'eip155:11155111';
const MAX = 2n ** 256n - 1n;

// ---------------------------------------------------------------------------
// A Portfolio reading, built by the real portfolio.ts (the screen's own path)
// ---------------------------------------------------------------------------
const slots = [
  { slot: 'eip155:1', networkChainId: 'eip155:1', label: 'Ethereum', symbol: 'ETH', decimals: 18, testnet: false, evm: true },
  { slot: BTC_SLOT, networkChainId: BTC_SLOT, label: 'Bitcoin', symbol: 'BTC', decimals: 8, testnet: false, evm: false },
];
const accountInputs = [
  { key: 'phrase:0', name: 'Account 1', kind: 'phrase', hidden: false, evmAddress: A(1), otherAddresses: { [BTC_SLOT]: 'bc1qa' }, smartAccount: null },
  { key: 'watch:3221225472', name: 'Watched 1', kind: 'watch', hidden: false, evmAddress: A(9), otherAddresses: null, smartAccount: null },
];
const plan = P.planPortfolio({ accounts: accountInputs, slots, tokens: [USDC_MAINNET] });
const ok = (amount, decimals, networkChainId) => ({ status: 'ok', amount, decimals, networkChainId });
const resultsFor = (overrides = {}) => {
  const r = new Map();
  for (const t of plan.tasks) {
    const k = `${t.holder.label}|${t.asset.symbol}`;
    const preset = {
      'Account 1|ETH': ok(1_000_000_000_000_000_000n, 18, 'eip155:1'), // 1 ETH at $3,000 = $3,000
      'Account 1|USDC': ok(1_000_000_000n, 6, 'eip155:1'), // 1,000 USDC at $1 = $1,000
      'Account 1|BTC': ok(1_000_000n, 8, BTC_SLOT), // 0.01 BTC at $100,000 = $1,000
      'Watched 1|ETH': ok(100_000_000_000_000_000_000n, 18, 'eip155:1'), // 100 ETH, never counted
      'Watched 1|USDC': ok(0n, 6, 'eip155:1'),
    };
    r.set(t.key, overrides[k] ?? preset[k]);
  }
  return r;
};
const quotes = new Map([
  [ETH_ID, { assetId: ETH_ID, currency: 'usd', price: '3000', provider: 'coingecko', updatedAtMs: NOW, fetchedAtMs: NOW }],
  [USDC_ID, { assetId: USDC_ID, currency: 'usd', price: '1', provider: 'coingecko', updatedAtMs: NOW, fetchedAtMs: NOW }],
  [BTC_ID, { assetId: BTC_ID, currency: 'usd', price: '100000', provider: 'coingecko', updatedAtMs: NOW, fetchedAtMs: NOW }],
]);
const summary = P.computePortfolio({ plan, results: resultsFor(), quotes });
const snapshot = (over = {}) => ({ profile: 'primary', key: 'K', summary, notRead: 0, showFiat: true, at: NOW - 3 * 60_000, ...over });

const ctx = (over = {}) => ({
  hidden: false,
  nowMs: NOW,
  profile: 'primary',
  portfolioKey: 'K',
  evm: { caip2: 'eip155:1', label: 'Ethereum', testnet: false },
  solanaDevnet: false,
  account: { name: 'Account 1', evmAddress: A(1) },
  counts: { watched: 1, imported: 1, multisig: 0, hidden: 2 },
  appLock: { on: false, kind: 'pin' },
  autoLockMs: 60_000,
  ...over,
});
const texts = (section) => section.lines.map((l) => l.text);

// ===========================================================================
console.log('check-insights: concentration (shares of the counted net worth)');
// ===========================================================================
{
  const sec = I.concentrationSection(snapshot(), ctx());
  const t = texts(sec);
  check('net worth is $5,000 from the real portfolio.ts, the watched 100 ETH not counted', P.formatMoney(summary.netWorth, { hidden: false }) === '$5,000.00', P.formatMoney(summary.netWorth, { hidden: false }));
  check('by asset, largest first: ETH 60.0%, USDC 20.0%, BTC 20.0% (exact fractions, a tenth of a percent for display)',
    t.includes('ETH on Ethereum: 60.0% of the counted net worth ($3,000.00)') &&
      t.includes('USDC on Ethereum: 20.0% of the counted net worth ($1,000.00)') &&
      t.includes('BTC on Bitcoin: 20.0% of the counted net worth ($1,000.00)') &&
      t.indexOf('ETH on Ethereum: 60.0% of the counted net worth ($3,000.00)') < t.indexOf('USDC on Ethereum: 20.0% of the counted net worth ($1,000.00)'), t);
  check('by network: Ethereum 80.0%, Bitcoin 20.0%',
    t.includes('Ethereum: 80.0% of the counted net worth ($4,000.00)') && t.includes('Bitcoin: 20.0% of the counted net worth ($1,000.00)'), t);
  check('the rounding sentence and the watched sentence are stated', t.includes(en['insights.concentration.rounding']) && t.includes(en['insights.concentration.watched']));
  check('the source names the Portfolio screen and its age', sec.source === 'Source: the Portfolio screen, read 3 min ago.' && sec.link === 'Portfolio', sec.source);
  check('no watched figure appears anywhere (100 ETH = $300,000)', !t.some((x) => x.includes('300,000')));

  const hid = I.concentrationSection(snapshot(), ctx({ hidden: true }));
  check('Hide amounts: every share and every value is the mask', hid.lines.filter((l) => l.id.startsWith('asset:') || l.id.startsWith('network:')).every((l) => l.text === `${l.text.split(':')[0]}: ${MASK} of the counted net worth (${MASK})`) && !texts(hid).some((x) => /\d+\.\d%|\$\d/.test(x)), texts(hid));
  check('…and the screen reader hears "(amount hidden)", never the bullets', hid.lines.every((l) => !l.spoken.includes(MASK)) && hid.lines.some((l) => l.spoken.includes('(amount hidden) of the counted net worth ((amount hidden))')));

  check('no reading in this session: a statement naming the Portfolio screen, no figure',
    JSON.stringify(texts(I.concentrationSection(null, ctx()))) === JSON.stringify([en['insights.concentration.none']]) && I.concentrationSection(null, ctx()).source === 'Source: the Portfolio screen.');
  check('Show fiat values off at the reading: no share is worked out', JSON.stringify(texts(I.concentrationSection(snapshot({ showFiat: false }), ctx()))) === JSON.stringify([en['insights.concentration.fiatOff']]));

  // A failed read: the share is of what was counted, and the line says so (never a figure for the failed balance).
  const failedSummary = P.computePortfolio({ plan, results: resultsFor({ 'Account 1|BTC': { status: 'error', message: 'fetch failed' } }), quotes });
  const f = texts(I.concentrationSection(snapshot({ summary: failedSummary, notRead: 2 }), ctx()));
  check('a failed read: "did not count every balance … (3)" first, BTC absent, ETH 75.0% of what was counted',
    f[0] === 'The Portfolio screen did not count every balance (balances not read or that could not be read: 3), so these are shares of what was counted.' &&
      !f.some((x) => x.startsWith('BTC')) && f.includes('ETH on Ethereum: 75.0% of the counted net worth ($3,000.00)'), f);

  // Test assets are never in a share; a test-network-only portfolio has nothing priced.
  const tplan = P.planPortfolio({
    accounts: accountInputs.slice(0, 1),
    slots: [{ slot: 'eip155:1', networkChainId: SEPOLIA, label: 'Ethereum Sepolia', symbol: 'test ETH', decimals: 18, testnet: true, evm: true }],
    tokens: [KNOWN_TEST_NETWORK_TOKENS[SEPOLIA][0]],
  });
  const tres = new Map(tplan.tasks.map((t) => [t.key, ok(5n * 10n ** 18n, t.asset.decimals, t.asset.networkChainId)]));
  const tsum = P.computePortfolio({ plan: tplan, results: tres, quotes });
  const tt = texts(I.concentrationSection(snapshot({ summary: tsum }), ctx()));
  check('a test-network portfolio: nothing priced, the test assets named "test, no value", no share and no dollar figure',
    tt.includes(en['insights.concentration.nothingPriced']) && tt.includes('Not in the shares, test-network assets (test, no value): test ETH and USDC.') && !tt.some((x) => /%|\$/.test(x)), tt);
  // An unpriced main-network asset is named, not valued.
  const npSummary = P.computePortfolio({ plan, results: resultsFor(), quotes: new Map([[ETH_ID, quotes.get(ETH_ID)], [USDC_ID, quotes.get(USDC_ID)]]) });
  const np = texts(I.concentrationSection(snapshot({ summary: npSummary }), ctx()));
  check('an unpriced asset (BTC with no quote): named, not in the shares; ETH 75.0%',
    np.includes('Not in the shares, assets CoinGecko has no price for: BTC.') && np.includes('ETH on Ethereum: 75.0% of the counted net worth ($3,000.00)'), np);

  check('shareText: a third reads 33.3%, two thirds 66.7% (half up), a tiny share "less than 0.1%", a zero whole no share',
    I.shareText({ n: 1n, d: 3n }, { n: 1n, d: 1n }, false) === '33.3%' && I.shareText({ n: 2n, d: 3n }, { n: 1n, d: 1n }, false) === '66.7%' &&
      I.shareText({ n: 1n, d: 100_000n }, { n: 1n, d: 1n }, false) === 'less than 0.1%' && I.shareText({ n: 1n, d: 1n }, { n: 0n, d: 1n }, false) === null &&
      I.shareText({ n: 1n, d: 1n }, { n: 1n, d: 1n }, false) === '100.0%' && I.shareText({ n: 1n, d: 2000n }, { n: 1n, d: 1n }, false) === '0.1%');
}

// ===========================================================================
console.log('check-insights: token approvals (unlimited ones first)');
// ===========================================================================
const scan = {
  chainCaip2: 'eip155:1', owner: A(1), headBlock: 20_000_000n, scannedFromBlock: 19_928_000n,
  tokens: [], collections: [], erc20: [], operators: [], logsScanned: 3, skippedLogs: 0, refused: null, exhausted: false,
};
const erc20 = (symbol, decimals, live, spender = SPENDER) => ({
  kind: 'erc20', key: `${symbol}|${spender}`.toLowerCase(), chainCaip2: 'eip155:1', owner: A(1), contract: A(77), loggedBlock: 1n, loggedTxHash: '0x00',
  symbol, decimals, spender, loggedValue: 5n, live,
});
const items = [
  erc20('AAA', 6, { status: 'ok', value: 12_500_000n }),
  erc20('DAI', 18, { status: 'ok', value: 0n }), // revoked: not active
  erc20('ZZZ', 6, { status: 'ok', value: MAX }),
  erc20('USDC', 6, { status: 'error', message: 'timeout' }), // unconfirmed
  { kind: 'operator', key: 'nft|op', chainCaip2: 'eip155:1', owner: A(1), contract: A(78), loggedBlock: 2n, loggedTxHash: '0x01', title: 'Shibas', operator: OPERATOR, loggedApproved: true, live: { status: 'ok', value: true } },
];
const approvalsSnap = { profile: 'primary', chainCaip2: 'eip155:1', owner: A(1), scan, items, at: NOW - 30_000 };
{
  const sec = I.approvalsSection(approvalsSnap, ctx());
  const t = texts(sec);
  const lines = sec.lines.filter((l) => l.id.startsWith('item:')).map((l) => l.text);
  check('counts: 3 active, of which 1 unlimited (the revoked and the unreadable one are not active)', t[0] === 'Active approvals: 3, of which unlimited: 1.', t[0]);
  check('the unlimited approval is listed first, then the others in the Approvals screen\'s order',
    lines[0] === `ZZZ: Unlimited ZZZ, approved to ${SPENDER}` && lines[1] === `AAA: 12.5 AAA, approved to ${SPENDER}` && lines[2] === `Shibas: Can transfer ALL your items in this collection, approved to ${OPERATOR}` && lines.length === 3, lines);
  check('an approval whose state could not be read is counted as such, never as a figure', t.includes('Approvals whose current state could not be read (not counted as active): 1.') && !t.some((x) => x.startsWith('USDC:')));
  check('the searched range is stated (the Approvals screen\'s own sentence)', t.some((x) => x.startsWith('Searched approval events in blocks 19928000–20000000')));
  check('the source names the search, the account, the network and its age', sec.source === 'Source: the Approvals screen’s search for Account 1 on Ethereum, read less than a minute ago.', sec.source);
  check('spoken: addresses shortened (0x1111…0582), never the full 42 characters', sec.lines.find((l) => l.id.startsWith('item:')).spoken === 'ZZZ: Unlimited ZZZ, approved to 0x1111…0582');
  const hid = I.approvalsSection(approvalsSnap, ctx({ hidden: true }));
  const h = hid.lines.filter((l) => l.id.startsWith('item:'));
  check('Hide amounts: a finite allowance is masked, "Unlimited" stays (a risk marker, as on the Approvals screen)',
    h[1].text === `AAA: ${MASK} AAA, approved to ${SPENDER}` && h[0].text.startsWith('ZZZ: Unlimited ZZZ') && h[1].spoken === 'AAA: (amount hidden) AAA, approved to 0x1111…0582');
  check('no search in this session: a statement naming Approvals, no figure', JSON.stringify(texts(I.approvalsSection(null, ctx()))) === JSON.stringify([en['insights.approvals.none'].replace('{account}', 'Account 1').replace('{network}', 'Ethereum')]));
  check('no account with an Ethereum address: said so', texts(I.approvalsSection(null, ctx({ account: null })))[0] === en['insights.approvals.noAccount']);
  const none = texts(I.approvalsSection({ ...approvalsSnap, items: [items[1]] }, ctx()));
  check('only a revoked approval: 0 active and "No active approval was found in the blocks … searched"', none[0] === 'Active approvals: 0, of which unlimited: 0.' && none.includes(en['insights.approvals.noneActive']));
  const refused = texts(I.approvalsSection({ ...approvalsSnap, scan: { ...scan, refused: { fromBlock: 1n, toBlock: 2n, message: 'archive' } } }, ctx()));
  check('a refused older search keeps the Approvals screen\'s "NOT shown" sentence', refused.some((x) => x.includes('Approvals granted before the searched range are NOT shown')));
}

// ===========================================================================
console.log('check-insights: the session snapshots (memory only, keyed)');
// ===========================================================================
{
  I.forgetInsightSnapshots();
  const key = I.portfolioSnapshotKey([{ index: 0, evmAddress: A(1).toUpperCase().replace('0X', '0x'), hidden: false }], 'eip155:1');
  check('the key is the network, every account index, address (lower case) and hidden flag', key === `eip155:1|0:${A(1)}:0`, key);
  I.recordPortfolioSnapshot(snapshot({ key }));
  check('the reading is found for the same profile and key', I.latestPortfolioSnapshot('primary', key) !== null);
  check('…never for another profile (the duress wallet\'s profile w2 sees nothing)', I.latestPortfolioSnapshot('w2', key) === null);
  check('…never for other accounts or another network', I.latestPortfolioSnapshot('primary', I.portfolioSnapshotKey([{ index: 0, evmAddress: A(1), hidden: true }], 'eip155:1')) === null &&
    I.latestPortfolioSnapshot('primary', I.portfolioSnapshotKey([{ index: 0, evmAddress: A(1), hidden: false }], SEPOLIA)) === null);
  I.recordApprovalsSnapshot(approvalsSnap);
  check('the approvals search is found by profile, network and owner (any case)', I.latestApprovalsSnapshot('primary', 'eip155:1', A(1).toUpperCase().replace('0X', '0x')) === approvalsSnap);
  check('…never for another profile, network or owner', I.latestApprovalsSnapshot('w2', 'eip155:1', A(1)) === null && I.latestApprovalsSnapshot('primary', SEPOLIA, A(1)) === null && I.latestApprovalsSnapshot('primary', 'eip155:1', A(2)) === null);
  for (let i = 0; i < 12; i += 1) I.recordApprovalsSnapshot({ ...approvalsSnap, owner: A(100 + i) });
  check(`at most ${I.MAX_APPROVAL_SNAPSHOTS} searches are remembered, the oldest dropped first`, I.latestApprovalsSnapshot('primary', 'eip155:1', A(1)) === null && I.latestApprovalsSnapshot('primary', 'eip155:1', A(111)) !== null && I.latestApprovalsSnapshot('primary', 'eip155:1', A(103)) === null && I.latestApprovalsSnapshot('primary', 'eip155:1', A(104)) !== null);
  I.forgetInsightSnapshots();
  check('forgetInsightSnapshots clears both', I.latestPortfolioSnapshot('primary', key) === null && I.latestApprovalsSnapshot('primary', 'eip155:1', A(111)) === null);
}

// ===========================================================================
console.log('check-insights: the phrase, the lock and auto-lock');
// ===========================================================================
const protection = (over = {}) => ({
  phrase: 'standard', reason: 'not-attempted', detail: null, biometricsAvailable: true, protectedSince: null, standardCopyPresent: false,
  sessionKeys: 'standard', policy: 'opt-in', canProtectNow: true, importedKeys: { total: 0, standard: 0, protected: 0, unreadable: 0, damaged: false }, ...over,
});
{
  const { describeProtectionStatus } = await import('../src/wallet/phrase-protection-copy.ts');
  const reads = { protection: { status: 'ok', value: protection() } };
  const k = texts(I.keysSection(reads, ctx()));
  check('the phrase line is the sentence Settings shows (describeProtectionStatus)', k[0] === describeProtectionStatus(protection()).text);
  const imp = protection({ importedKeys: { total: 1, standard: 1, protected: 0, unreadable: 0, damaged: false } });
  const ki = texts(I.keysSection({ protection: { status: 'ok', value: imp } }, ctx()));
  check('an imported key: its storage line follows (Settings\' own note, incl. "does not back up")', ki[1] === describeProtectionStatus(imp).importedNote && /does not back up/i.test(ki[1]), ki);
  check('a failed read: "could not be read", nothing about the phrase\'s state', JSON.stringify(texts(I.keysSection({ protection: { status: 'error', message: 'x' } }, ctx())).slice(0, 1)) === JSON.stringify([en['insights.protection.error']]));
  check('no app lock: "no app PIN or passphrase is on" (the device\'s own prompt)', k.includes(en['insights.lock.off']));
  check('an app PIN / passphrase / not read yet', texts(I.keysSection(reads, ctx({ appLock: { on: true, kind: 'pin' } }))).includes(en['insights.lock.pin']) &&
    texts(I.keysSection(reads, ctx({ appLock: { on: true, kind: 'phr' } }))).includes(en['insights.lock.passphrase']) &&
    texts(I.keysSection(reads, ctx({ appLock: { on: null, kind: 'pin' } }))).includes(en['insights.lock.unknown']));
  check('auto-lock on at 5 min / off', texts(I.keysSection(reads, ctx({ autoLockMs: 300_000 }))).includes('Auto-lock is on: after 5 min in the background, and every time the wallet starts afresh.') &&
    texts(I.keysSection(reads, ctx({ autoLockMs: null }))).includes(en['insights.autoLock.off']));
  check('no duress PIN is ever mentioned (a line about it would give the second wallet away)', !Object.entries(en).some(([id, v]) => id.startsWith('insights.') && /duress|second wallet|decoy/i.test(v)));
}

// ===========================================================================
console.log('check-insights: transactions waiting (the stored pending list)');
// ===========================================================================
const tx = (hash, nonce, sentAt, action = 'send', from = A(1)) => ({
  kind: 'tx', chain: 'eip155:1', hash, nonce, from, to: A(2), value: '1', data: '0x', maxFeePerGas: '1', maxPriorityFeePerGas: '1', gasLimit: '21000', sentAt, action, replaces: null,
});
{
  const records = [
    tx(`0x${'a'.repeat(64)}`, '5', NOW - 20 * 60_000),
    tx(`0x${'b'.repeat(64)}`, '5', NOW - 60_000, 'speed-up'), // same nonce: one waiting transaction
    tx(`0x${'c'.repeat(64)}`, '6', NOW - 60_000),
    { kind: 'userop', chain: 'eip155:1', userOpHash: `0x${'d'.repeat(64)}`, sender: A(3), owner: A(1), sentAt: NOW - 11 * 60_000, resend: null },
    { kind: 'resolved', chain: 'eip155:1', from: A(1), nonce: '4', outcome: 'replaced', minedHash: `0x${'e'.repeat(64)}`, block: '1', success: true, original: `0x${'e'.repeat(64)}`, hashes: [], resolvedAt: NOW },
  ];
  const t = texts(I.pendingSection({ pending: { status: 'ok', value: { records, readOnly: false } } }, ctx()));
  check('two waiting regular transactions (a speed-up shares its nonce), one sent more than 10 minutes ago', t[0] === 'Regular-account transactions handed to the network and not yet seen included: 2 (sent more than 10 minutes ago: 1).', t[0]);
  check('one smart-account operation, sent more than 10 minutes ago; a resolved notice is not waiting', t[1] === 'Smart-account operations handed to a bundler and not yet seen included: 1 (sent more than 10 minutes ago: 1).', t[1]);
  check('the unknown-outcome note covers every account and network', t[2] === en['insights.pending.note']);
  check('nothing waiting', JSON.stringify(texts(I.pendingSection({ pending: { status: 'ok', value: { records: [records[4]], readOnly: false } } }, ctx()))) === JSON.stringify([en['insights.pending.none']]));
  check('a damaged list: said so first', texts(I.pendingSection({ pending: { status: 'ok', value: { records: [], readOnly: true } } }, ctx()))[0] === en['insights.pending.readOnly']);
  check('a failed read: "could not be read", no count', JSON.stringify(texts(I.pendingSection({ pending: { status: 'error', message: 'x' } }, ctx()))) === JSON.stringify([en['insights.pending.error']]));
  check('its link is Activity', I.pendingSection({ pending: { status: 'error', message: 'x' } }, ctx()).link === 'Activity');
}

// ===========================================================================
console.log('check-insights: network endpoints (the last check, never a probe)');
// ===========================================================================
{
  const primary = 'https://primary.example/rpc';
  const peeks = [
    { label: 'Ethereum', defaultUrls: [primary, 'https://second.example'], overrideUrl: null, choice: { url: 'https://second.example', index: 1, total: 2, healthy: true, primaryUnreachable: true, primaryFailureKind: 'stale' } },
    { label: 'Bitcoin', defaultUrls: ['https://btc.example'], overrideUrl: null, choice: { url: 'https://btc.example', index: 0, total: 1, healthy: true, primaryUnreachable: false } },
    { label: 'Solana', defaultUrls: ['https://sol.example'], overrideUrl: null, choice: null },
    { label: 'Dogecoin', defaultUrls: [], overrideUrl: null, choice: null },
    { label: 'Ethereum Sepolia', defaultUrls: [primary], overrideUrl: 'https://my.node.example:8545/path', choice: null },
    { label: 'Base', defaultUrls: [primary, 'https://b.example'], overrideUrl: null, choice: { url: primary, index: 0, total: 2, healthy: false, primaryUnreachable: true } },
  ];
  const t = texts(I.endpointsSection({ endpoints: { status: 'ok', value: peeks } }));
  check('a stale primary: the Settings fallback sentence, named', t[0] === 'Ethereum: The primary default (primary.example) is behind the chain right now (its newest block is older than expected), so a fallback default is in use. The primary is tried again on the next app launch or whenever the fallback fails.', t[0]);
  check('a primary that passed', t[1] === 'Bitcoin: the primary default (btc.example) passed the last check.');
  check('not checked yet in this session', t[2] === 'Solana: not checked yet in this session (the wallet checks the default endpoints the first time it reads from the network).');
  check('no endpoint set', t[3] === 'Dogecoin: no endpoint is set.');
  check('the user\'s own endpoint: named by host, never checked', t[4] === 'Ethereum Sepolia: your own endpoint (my.node.example); the wallet does not check it in the background.');
  check('none answered', t[5] === 'Base: None of the 2 default endpoints answered the last check (the primary is primary.example). Requests may fail until one recovers; you can set a custom endpoint with Edit.', t[5]);
  check('a failed read', JSON.stringify(texts(I.endpointsSection({ endpoints: { status: 'error', message: 'x' } }))) === JSON.stringify([en['insights.endpoint.error']]));

  // config/networks.ts peekEndpointHealth: storage plus the resolver's cache, no probe.
  const mem = new Map();
  const store = { getItem: async (k) => mem.get(k) ?? null, setItem: async (k, v) => void mem.set(k, v) };
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new TypeError('fetch failed: offline fake');
  };
  try {
    const before = await peekEndpointHealth({ store });
    check('peekEndpointHealth lists every active network and makes NO request', fetches === 0 && before.length === DEFAULT_NETWORKS.length && before.every((p) => p.choice === null), { fetches, n: before.length });
    const eth = DEFAULT_NETWORKS.find((n) => n.kind === 'evm-jsonrpc');
    mem.set(STORE_KEYS.rpcEndpoints.name, JSON.stringify({ [eth.chainId]: 'https://own.example/rpc' }));
    const own = (await peekEndpointHealth({ store })).find((p) => p.networkChainId === eth.chainId);
    check('an override is reported as the user\'s own endpoint, with no choice and no request', own.overrideUrl === 'https://own.example/rpc' && own.choice === null && fetches === 0);
    mem.delete(STORE_KEYS.rpcEndpoints.name);
    await getEndpoint(eth.chainId, { store }); // the wallet's own first read probes the defaults (the fake answers nothing)
    const probed = fetches;
    const after = (await peekEndpointHealth({ store })).find((p) => p.networkChainId === eth.chainId);
    check('after the wallet\'s own read, the peek returns that check\'s choice (unhealthy here) and asks nothing more',
      probed > 0 && fetches === probed && after.choice !== null && after.choice.healthy === false && after.choice.primaryUnreachable === true, { probed, fetches, choice: after.choice });
    check('…and the line is the Settings sentence for it', I.endpointsSection({ endpoints: { status: 'ok', value: [after] } }).lines[0].text.includes('None of the'));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ===========================================================================
console.log('check-insights: accounts, limits, alerts and the network in use');
// ===========================================================================
{
  const a = texts(I.accountsSection(ctx()));
  check('watched, imported (not backed up), multisig and hidden counts', a[0] === 'Watched addresses (no key in this wallet, never counted in your net worth): 1.' &&
    a[1] === 'Accounts from imported private keys (not backed up by your recovery phrase; keep each key yourself): 1.' &&
    a[2] === 'Multi-signature accounts (their co-signers share control): 0.' && a[3] === 'Hidden accounts (hidden from the list, still in the wallet): 2.', a);
  const book = { watchlist: ['x', 'y'], alerts: [{}, {}, {}], nextId: 4, damaged: false };
  const scopes = { scopes: [{ scope: { chain: 'eip155:1', owner: A(1).toUpperCase().replace('0X', '0x') }, count: 2 }, { scope: { chain: SEPOLIA, owner: A(1) }, count: 1 }], damaged: false };
  const l = texts(I.limitsSection({ spendingScopes: { status: 'ok', value: scopes }, priceAlerts: { status: 'ok', value: book } }, ctx()));
  check('limits: 2 pairs, 3 limits, enforced by this app; 2 for the active account on this network', l[0] === 'Spending limits are set for 2 account and network pairs (3 limits); this app enforces them, not the chain.' && l[1] === 'For Account 1 on Ethereum: 2 limits.', l);
  check('alerts: 3 set, 2 prices followed', l[2] === 'Price alerts set: 3; prices followed: 2.');
  const none = texts(I.limitsSection({ spendingScopes: { status: 'ok', value: { scopes: [], damaged: false } }, priceAlerts: { status: 'ok', value: { ...book, alerts: [] } } }, ctx()));
  check('no limit set', none[0] === en['insights.limits.none'] && none[1] === 'Price alerts set: 0; prices followed: 2.');
  const bad = texts(I.limitsSection({ spendingScopes: { status: 'ok', value: { scopes: [], damaged: true } }, priceAlerts: { status: 'error', message: 'x' } }, ctx()));
  check('damaged limits and an unreadable alert book: "could not be read", no count', JSON.stringify(bad) === JSON.stringify([en['insights.limits.error'], en['insights.alerts.error']]));
  check('a main network / a test network / Solana devnet on',
    texts(I.networkSection(ctx()))[0] === 'Ethereum is a main network: its funds are real.' &&
      JSON.stringify(texts(I.networkSection(ctx({ evm: { caip2: SEPOLIA, label: 'Ethereum Sepolia', testnet: true }, solanaDevnet: true })))) ===
        JSON.stringify(['Ethereum Sepolia is a test network: its coins and tokens have no value.', en['insights.network.solanaDevnet']]));
}

// ===========================================================================
console.log('check-insights: readInsights settles every source on its own');
// ===========================================================================
{
  const reads = await I.readInsights({
    protection: async () => protection(),
    pending: async () => {
      throw new Error('store unavailable');
    },
    spendingScopes: async () => ({ scopes: [], damaged: false }),
    priceAlerts: async () => ({ watchlist: [], alerts: [], nextId: 1, damaged: false }),
    endpoints: async () => [],
  });
  check('one failing source is "error" and the others are read', reads.pending.status === 'error' && reads.pending.message === 'store unavailable' && reads.protection.status === 'ok' && reads.spendingScopes.status === 'ok');
  const all = I.buildInsightSections({ reads, portfolio: null, approvals: null, ctx: ctx() });
  check('the sections keep a fixed order', all.map((s) => s.id).join() === 'network,concentration,approvals,keys,pending,endpoints,accounts,limits');
  check('every section has a source line beginning "Source:"', all.every((s) => s.source.startsWith('Source:')));
  check('every line\'s spoken form holds no mask and no full address', all.every((s) => s.lines.every((l) => !l.spoken.includes(MASK) && !/0x[0-9a-fA-F]{40}/.test(l.spoken))));
}

// ===========================================================================
console.log('check-insights: strings (English and the Spanish draft)');
// ===========================================================================
{
  const ids = Object.keys(en).filter((id) => id.startsWith('insights.'));
  const ph = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  check(`${ids.length} insights ids, each with a Spanish draft that differs from the English and keeps its placeholders`,
    ids.length >= 70 && ids.every((id) => typeof es[id] === 'string' && es[id] !== en[id] || id === 'insights.endpoint.fallback') && ids.every((id) => ph(en[id]) === ph(es[id])));
  const src = read('src/wallet/insights.ts') + read('src/screens/InsightsScreen.tsx') + read('src/screens/PortfolioScreen.tsx') + read('src/screens/SettingsScreen.tsx');
  check('every insights id is used by its id in the source', ids.every((id) => src.includes(`'${id}'`)));
  check('no sentence gives advice beyond naming a screen to open (no "should", "must", "we recommend")', ids.every((id) => !/\b(should|must|recommend)\b/i.test(en[id])));
}

// ===========================================================================
console.log('check-insights: source pins (the route, the entries, no request of its own)');
// ===========================================================================
{
  const app = read('App.tsx');
  const nav = read('src/navigation.ts');
  const portfolio = read('src/screens/PortfolioScreen.tsx');
  const settings = read('src/screens/SettingsScreen.tsx');
  const approvals = read('src/screens/ApprovalsScreen.tsx');
  const home = read('src/screens/HomeScreen.tsx');
  const screen = read('src/screens/InsightsScreen.tsx');
  const mod = read('src/wallet/insights.ts');
  const networks = read('src/config/networks.ts');
  check('App.tsx registers the route "Insights" titled "Risk overview"', app.includes(`<Stack.Screen name="Insights" component={InsightsScreen} options={{ title: 'Risk overview' }} />`));
  check('navigation.ts declares Insights with no params', /\n  Insights: undefined;\n/.test(nav));
  check('Portfolio: a "Risk overview" button opens Insights', portfolio.includes(`<Button title={t('insights.open')} variant="secondary" accessibilityHint={t('insights.open.hint')} onPress={() => navigation.navigate('Insights')} />`));
  check('Portfolio hands over only a COMPLETE reading (every read answered), keyed by profile and accounts',
    /if \(!plan \|\| !summary \|\| loading \|\| pending > 0\) return;\s+recordPortfolioSnapshot\(\{\s+profile: activeStoreProfile\(\)\.id,\s+key: portfolioSnapshotKey\(/.test(portfolio));
  check('Settings → Privacy: the row after "Open the inbox"', /navigation\.navigate\('Inbox'\)\} \/>\n\s+<Button title=\{t\('insights\.open'\)\} variant="secondary" accessibilityHint=\{t\('insights\.open\.hint'\)\} onPress=\{\(\) => navigation\.navigate\('Insights'\)\} \/>/.test(settings));
  check('Approvals hands over every shown list, keyed by profile, network and owner', /if \(state\.status !== 'ok' \|\| !owner\) return;\s+recordApprovalsSnapshot\(\{\s+profile: activeStoreProfile\(\)\.id,\s+chainCaip2: state\.scan\.chainCaip2,\s+owner,/.test(approvals));
  check('HomeScreen is not edited by this slice (no Insights link there)', !home.includes('Insights') && !home.includes('insights.'));
  check('the module makes no request and writes nothing (no fetch, transport, endpoint lookup, probe, store write or signer)',
    !/\bfetch\(|Transport|getEndpoint|getAllEndpoints|probeEndpoint|resolve\(|writeStoreItem|setItem|signWith|requireLocalAuth|eth_/.test(mod));
  check('the screen makes no request: no balance, price, approvals scan or endpoint resolution, nothing that signs',
    !/\bfetch\(|usePrices|loadNativeBalance|loadTokenBalance|startApprovalScan|readLiveApprovals|getEndpoint|getAllEndpoints|httpTransport|signWith|requireLocalAuth|prepareEvmSend/.test(screen) && screen.includes('peekEndpointHealth()'));
  const peekBody = networks.slice(networks.indexOf('export async function peekEndpointHealth'), networks.indexOf('export async function peekEndpointHealth') + 1400);
  check('peekEndpointHealth only peeks the resolver (never resolve / resolveNetworkUrl / a probe)', peekBody.includes('defaultResolver.peek(network.chainId)') && !/defaultResolver\.resolve|resolveNetworkUrl|probeEndpoint|resolveSlot/.test(peekBody));
  check('headings are headings', (screen.match(/accessibilityRole="header"/g) ?? []).length === 1 && screen.includes('{section.title}'));
  check('masks and addresses are spoken through the a11y helpers (spokenMaskedText, withShortAddresses)', mod.includes('spoken: spokenMaskedText(withShortAddresses(text))') && screen.includes('accessibilityLabel: l.spoken'));
  check('nothing is coloured by an invented rule: no danger or warning colour, no WarningBox of its own', !/theme\.danger|warningText|WarningBox/.test(screen));
  check('the "see <screen>" links are offered only where the route gate allows them', screen.includes('watchOnlyRouteRefusal(route) === null') && screen.includes('multisigRouteRefusal(route) === null'));
  check('the route is on both read-only allow lists (watch-only and multisig)', WATCH_ONLY_ALLOWED_ROUTES.includes('Insights') && MULTISIG_ALLOWED_ROUTES.includes('Insights') && watchOnlyRouteRefusal('Insights') === null && multisigRouteRefusal('Insights') === null);
}

// ===========================================================================
console.log('Mutation checks (scratch copies of insights.ts)');
// ===========================================================================
const MUTANT_DIR = join(HERE, `.mutants-insights-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(from, to) {
  const relPath = 'src/wallet/insights.ts';
  const original = read(relPath);
  if (!original.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(APP, relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-insights.ts`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
{
  const firstItem = (M) => M.approvalsSection(approvalsSnap, ctx()).lines.find((l) => l.id.startsWith('item:')).text;
  const m1 = await importMutant('return [...active.filter((i) => isUnlimitedNow(i)), ...active.filter((i) => !isUnlimitedNow(i))];', 'return active;');
  check('mutant caught: unlimited approvals no longer first', !firstItem(m1).startsWith('ZZZ: Unlimited'));
  const m2 = await importMutant('  if (hidden) return maskAmount(\'\', true);\n', '');
  check('mutant caught: Hide amounts no longer masks the shares', /\d\.\d%/.test(texts(m2.concentrationSection(snapshot(), ctx({ hidden: true }))).join()));
  const m3 = await importMutant("  if (missing > 0) out.push(line('incomplete', t('insights.concentration.incomplete', { count: missing })));\n", '');
  const failedSummary = P.computePortfolio({ plan, results: resultsFor({ 'Account 1|BTC': { status: 'error', message: 'x' } }), quotes });
  check('mutant caught: a failed read no longer said (the shares look complete)', !texts(m3.concentrationSection(snapshot({ summary: failedSummary }), ctx()))[0].startsWith('The Portfolio screen did not count'));
  const m4 = await importMutant("  if (!snapshot.showFiat) return { ...base, lines: [line('fiat-off', t('insights.concentration.fiatOff'))], source };\n", '');
  check('mutant caught: a reading made with fiat off is shown as shares', texts(m4.concentrationSection(snapshot({ showFiat: false }), ctx()))[0] !== en['insights.concentration.fiatOff']);
  const m5 = await importMutant("  return { id, text, spoken: spokenMaskedText(withShortAddresses(text)) };", '  return { id, text, spoken: text };');
  check('mutant caught: the bullets and the full address spoken', m5.approvalsSection(approvalsSnap, ctx({ hidden: true })).lines.some((l) => l.spoken.includes(MASK) || /0x[0-9a-fA-F]{40}/.test(l.spoken)));
  const m6 = await importMutant("      const key = `${r.chain}|${r.from}|${r.nonce}`;", '      const key = r.hash;');
  const recs = [tx(`0x${'a'.repeat(64)}`, '5', NOW - 60_000), tx(`0x${'b'.repeat(64)}`, '5', NOW - 30_000, 'speed-up')];
  check('mutant caught: a speed-up counted as a second waiting transaction', !texts(m6.pendingSection({ pending: { status: 'ok', value: { records: recs, readOnly: false } } }, ctx()))[0].includes(': 1 ('));
  const m7 = await importMutant('  return s && s.key === key ? s : null;', '  return s ?? null;');
  m7.recordPortfolioSnapshot(snapshot({ key: 'A' }));
  check('mutant caught: a reading for other accounts or another network is shown', m7.latestPortfolioSnapshot('primary', 'B') !== null);
  const m8 = await importMutant('  const s = portfolioSnapshots.get(profile);', '  const s = [...portfolioSnapshots.values()].pop();');
  m8.recordPortfolioSnapshot(snapshot({ profile: 'primary', key: 'K' }));
  check('mutant caught: the duress wallet\'s profile sees the primary wallet\'s reading', m8.latestPortfolioSnapshot('w2', 'K') !== null);
  const m9 = await importMutant('    if (e.overrideUrl !== null) {', '    if (false) {');
  check('mutant caught: the user\'s own endpoint reported as a default', !m9.endpointsSection({ endpoints: { status: 'ok', value: [{ label: 'X', defaultUrls: ['https://d.example'], overrideUrl: 'https://own.example', choice: null }] } }).lines[0].text.includes('your own endpoint'));
  const m10 = await importMutant('    ctx.appLock.on === null\n      ? t(\'insights.lock.unknown\')\n      : !ctx.appLock.on', '    !ctx.appLock.on');
  check('mutant caught: a lock not read yet reported as off', texts(m10.keysSection({ protection: { status: 'ok', value: protection() } }, ctx({ appLock: { on: null, kind: 'pin' } }))).includes(en['insights.lock.off']));
  const m11 = await importMutant('  if ((num % den) * 2n >= den) tenths += 1n;\n', '');
  check('mutant caught: two thirds truncated to 66.6%', m11.shareText({ n: 2n, d: 3n }, { n: 1n, d: 1n }, false) === '66.6%');
  const m12 = await importMutant('  const net = s.netWorth;', '  const net = s.watchedTotal;');
  check('mutant caught: shares taken of a total that includes the watched addresses', !texts(m12.concentrationSection(snapshot(), ctx())).includes('ETH on Ethereum: 60.0% of the counted net worth ($3,000.00)'));
  const m13 = await importMutant('    if (r.kind === \'tx\') {', "    if (r.kind === 'tx' || r.kind === 'resolved') {");
  const resolvedOnly = [{ kind: 'resolved', chain: 'eip155:1', from: A(1), nonce: '4', outcome: 'replaced', minedHash: `0x${'e'.repeat(64)}`, block: '1', success: true, original: `0x${'e'.repeat(64)}`, hashes: [], resolvedAt: NOW, sentAt: NOW }];
  check('mutant caught: a settled (resolved) nonce counted as waiting', texts(m13.pendingSection({ pending: { status: 'ok', value: { records: resolvedOnly, readOnly: false } } }, ctx()))[0] !== en['insights.pending.none']);
  check(`${mutantCount} mutants written and each caught above`, mutantCount >= 8);
}

console.log(`\ncheck-insights: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

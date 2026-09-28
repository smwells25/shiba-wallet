// Exercises the fiat-price glue (src/wallet/prices.ts) and the Show-fiat
// preference (src/config/prefs.ts) OFFLINE: a fake fetch answers with
// CoinGecko-shaped bodies (the /simple/price and /simple/token_price shapes
// documented in packages/prices/src/coingecko.ts), so the exact modules the
// app runs are tested without a network and without a real key. Covers the
// CAIP-19 mapping, "toggle off makes no request", "test mode is never
// priced", masking, "< $0.01", the stale marker, separators, the shared
// provider's rebuild on key change, and the Demo-key store's
// verify-before-save discipline (every reject case persists nothing).
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-prices.mjs            # offline only
//   node scripts/check-prices.mjs --live     # plus ONE keyless read-only probe
//
// The live probe makes two keyless GET requests to api.coingecko.com (the
// four natives in one call, USDC by contract in another) through the app
// glue and prints the formatted values. No key is used or stored.

import { formatAssetId } from '@shiba-wallet/core';
import { COINGECKO_BASE_URL, COINGECKO_NATIVE_IDS } from '@shiba-wallet/prices';
import {
  PRICE_MAX_STALE_MS,
  PRICE_OLD_AFTER_MS,
  PRICE_TTL_MS,
  clearPriceDemoKey,
  describeAge,
  fetchPrices,
  fiatLine,
  formatFiat,
  getPriceConfig,
  guardedCoinGeckoFetch,
  nativePriceAssetId,
  nativePriceIds,
  resetSharedPriceProvider,
  setPriceDemoKey,
  sharedPriceProvider,
  staleNoteFor,
  tokenPriceAssetId,
} from '../src/wallet/prices.ts';
import { DEFAULT_PREFS, loadPrefs, maskAmount, savePrefs } from '../src/config/prefs.ts';
import { groupThousands } from '../src/wallet/balances.ts';
import { groupThousands as simulationGroupThousands } from '../src/wallet/simulation.ts';
import { USDC_MAINNET } from '../src/wallet/erc20.ts';

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

async function checkRejects(name, promiseFn, messagePattern) {
  try {
    const value = await promiseFn();
    check(name, false, `expected a rejection, got ${JSON.stringify(value)}`);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, messagePattern.test(message), `error was: ${message}`);
    return e;
  }
}

function memoryStore(initial = new Map()) {
  const mem = initial;
  const store = {
    reads: 0,
    getItem: async (key) => {
      store.reads += 1;
      return mem.has(key) ? mem.get(key) : null;
    },
    setItem: async (key, value) => {
      mem.set(key, value);
    },
    raw: mem,
  };
  return store;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ETH = 'eip155:1/slip44:60';
const BTC = 'bip122:000000000019d6689c085ae165831e93/slip44:0';
const DOGE = 'bip122:1a91e3dace36e2be3bf030a65679fe82/slip44:3';
const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501';
const SEPOLIA_ETH = 'eip155:11155111/slip44:60';
const USDC_ID = formatAssetId(USDC_MAINNET.assetId);
const USDC_ADDR = USDC_MAINNET.assetId.reference.toLowerCase();
const PRICE_KEY_STORAGE = 'shiba-wallet.price-config.v1';

const T0 = 1_790_000_000_000; // fixed clock (ms)

// Vendor answer knobs; the fake serves CoinGecko-shaped bodies.
let server = {};
let calls = [];

function defaultServer() {
  return {
    status: 200,
    throwNetwork: false,
    rawBody: null, // when set, served verbatim (malformed-body cases)
    omitEthereum: false,
    lastUpdatedSec: Math.floor(T0 / 1000),
    prices: {
      ethereum: '2674.343997069859',
      bitcoin: '83272.12',
      dogecoin: '0.1234567',
      solana: '181.5',
    },
    usdc: '0.9998',
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

const fakeFetch = async (url, init = {}) => {
  calls.push({ url, headers: { ...(init.headers ?? {}) } });
  if (server.throwNetwork) throw new TypeError('fetch failed (fake offline)');
  if (server.status !== 200) return response(server.status, '{"status":{"error_code":1}}');
  if (server.rawBody !== null) return response(200, server.rawBody);
  const parsed = new URL(url);
  const updated = server.lastUpdatedSec;
  if (parsed.pathname.endsWith('/simple/price')) {
    const ids = (parsed.searchParams.get('ids') ?? '').split(',');
    const entries = ids
      .filter((id) => server.prices[id] !== undefined && !(id === 'ethereum' && server.omitEthereum))
      .map((id) => `"${id}":{"usd":${server.prices[id]},"last_updated_at":${updated}}`);
    return response(200, `{${entries.join(',')}}`);
  }
  if (parsed.pathname.endsWith('/simple/token_price/ethereum')) {
    const addrs = (parsed.searchParams.get('contract_addresses') ?? '').split(',');
    const entries = addrs
      .filter((a) => a === USDC_ADDR)
      .map((a) => `"${a}":{"usd":${server.usdc},"last_updated_at":${updated}}`);
    return response(200, `{${entries.join(',')}}`);
  }
  return response(404, '{}');
};

function reset() {
  server = defaultServer();
  calls = [];
  resetSharedPriceProvider();
}

// ---------------------------------------------------------------------------
// 1. CAIP-19 mapping
// ---------------------------------------------------------------------------
console.log('\nCAIP-19 mapping');

{
  const mainnet = nativePriceIds(false);
  check(
    'mainnet native ids are the four slip44 ids, in slot order',
    JSON.stringify(mainnet) === JSON.stringify([ETH, BTC, DOGE, SOL]),
    JSON.stringify(mainnet),
  );
  check(
    'every app native id is one the engine adapter can price (COINGECKO_NATIVE_IDS)',
    mainnet.every((id) => Object.prototype.hasOwnProperty.call(COINGECKO_NATIVE_IDS, id)),
  );
  const testMode = nativePriceIds(true);
  check('Sepolia test mode: the EVM slot is null (never priced)', testMode[0] === null);
  check(
    'Sepolia test mode: the other three natives are unchanged',
    JSON.stringify(testMode.slice(1)) === JSON.stringify([BTC, DOGE, SOL]),
  );
  check(
    'nativePriceAssetId: EVM slot served by Sepolia is null',
    nativePriceAssetId('eip155:1', 'eip155:11155111') === null,
  );
  check(
    'nativePriceAssetId: Sepolia as its own slot is null (not a mainnet)',
    nativePriceAssetId('eip155:11155111', 'eip155:11155111') === null,
  );
  check(
    'nativePriceAssetId: unknown chain is null',
    nativePriceAssetId('eip155:137', 'eip155:137') === null,
  );
  check(
    'tracked USDC prices under its tracked-store id verbatim',
    tokenPriceAssetId(USDC_MAINNET, 'eip155:1') === USDC_ID &&
      USDC_ID === 'eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDC_ID,
  );
  check(
    'tracked USDC is null while the active EVM chain is Sepolia',
    tokenPriceAssetId(USDC_MAINNET, 'eip155:11155111') === null,
  );
  const sepoliaToken = {
    ...USDC_MAINNET,
    assetId: { ...USDC_MAINNET.assetId, chainId: 'eip155:11155111' },
  };
  check(
    'a token on Sepolia is null even when Sepolia is active',
    tokenPriceAssetId(sepoliaToken, 'eip155:11155111') === null,
  );
}

// ---------------------------------------------------------------------------
// 2. Show-fiat preference and "toggle off makes no request"
// ---------------------------------------------------------------------------
console.log('\nShow-fiat preference');

{
  check('DEFAULT_PREFS.showFiat is ON', DEFAULT_PREFS.showFiat === true);
  const store = memoryStore();
  check('fresh install loads showFiat = true', (await loadPrefs(store)).showFiat === true);
  await savePrefs({ showFiat: false }, store);
  check('showFiat = false round-trips', (await loadPrefs(store)).showFiat === false);
  await savePrefs({ hideAmounts: true }, store);
  check('other pref writes keep showFiat', (await loadPrefs(store)).showFiat === false);
  store.raw.set('shiba-wallet.prefs.v1', '{"showFiat":"yes"}');
  check('a non-boolean stored value falls back to ON', (await loadPrefs(store)).showFiat === true);
  store.raw.set('shiba-wallet.prefs.v1', '{not json');
  check('corrupt prefs fall back to ON', (await loadPrefs(store)).showFiat === true);
}

{
  reset();
  const store = memoryStore();
  const quotes = await fetchPrices([ETH, BTC, USDC_ID], {
    enabled: false,
    store,
    fetchFn: fakeFetch,
    now: () => T0,
  });
  check('toggle off: no quotes', quotes.size === 0);
  check('toggle off: ZERO fetch calls', calls.length === 0, `${calls.length} calls`);
  check('toggle off: not even a storage read', store.reads === 0);
}

{
  reset();
  const quotes = await fetchPrices([null, undefined, null], {
    enabled: true,
    store: memoryStore(),
    fetchFn: fakeFetch,
  });
  check('only unpriceable (null) ids: no request at all', quotes.size === 0 && calls.length === 0);
}

// ---------------------------------------------------------------------------
// 3. Fetching: batching, token chunking, cache
// ---------------------------------------------------------------------------
console.log('\nFetching through the shared cached provider');

{
  reset();
  const now = () => T0;
  const ids = [...nativePriceIds(false), tokenPriceAssetId(USDC_MAINNET, 'eip155:1')];
  const quotes = await fetchPrices(ids, { enabled: true, store: memoryStore(), fetchFn: fakeFetch, now });
  check('keyless: 2 requests (natives batched, USDC by contract)', calls.length === 2, `${calls.length}`);
  check(
    'every request goes to the CoinGecko API root',
    calls.every((c) => c.url.startsWith(`${COINGECKO_BASE_URL}/`)),
  );
  check(
    'keyless requests carry no key header',
    calls.every((c) => !Object.keys(c.headers).some((h) => h.toLowerCase() === 'x-cg-demo-api-key')),
  );
  check(
    'natives in ONE /simple/price call with all four coin ids',
    calls.some(
      (c) =>
        c.url.includes('/simple/price?ids=ethereum,bitcoin,dogecoin,solana&') &&
        c.url.includes('vs_currencies=usd'),
    ),
  );
  check(
    'USDC via /simple/token_price/ethereum by lowercase contract',
    calls.some((c) => c.url.includes(`/simple/token_price/ethereum?contract_addresses=${USDC_ADDR}&`)),
  );
  check('all five assets priced', [ETH, BTC, DOGE, SOL, USDC_ID].every((id) => quotes.has(id)));
  check('vendor digits kept verbatim', quotes.get(ETH)?.price === '2674.343997069859');

  calls = [];
  await fetchPrices(ids, { enabled: true, store: memoryStore(), fetchFn: fakeFetch, now });
  check('within the 120 s TTL a refresh makes no request', calls.length === 0);
  check('TTL / max-stale constants', PRICE_TTL_MS === 120_000 && PRICE_MAX_STALE_MS === 1_800_000);
}

// ---------------------------------------------------------------------------
// 4. Test mode is never priced — even if the vendor would answer
// ---------------------------------------------------------------------------
console.log('\nSepolia test mode');

{
  reset();
  const ids = [
    ...nativePriceIds(true),
    tokenPriceAssetId(USDC_MAINNET, 'eip155:11155111'),
    // Belt and braces: even a Sepolia id passed straight in stays unpriced
    // (the engine adapter does not recognise it).
    SEPOLIA_ETH,
  ];
  const quotes = await fetchPrices(ids, {
    enabled: true,
    store: memoryStore(),
    fetchFn: fakeFetch,
    now: () => T0,
  });
  check('no token_price request in test mode', !calls.some((c) => c.url.includes('token_price')));
  check(
    'the ethereum coin id is never requested in test mode',
    !calls.some((c) => /[?&,]ids=([^&]*,)?ethereum[,&]/.test(c.url)),
    calls.map((c) => c.url).join(' | '),
  );
  check('no quote for Sepolia ETH', !quotes.has(SEPOLIA_ETH));
  check('no quote for mainnet ETH either', !quotes.has(ETH));
  check('BTC/DOGE/SOL still priced in test mode', [BTC, DOGE, SOL].every((id) => quotes.has(id)));
  // The screens look quotes up by the id derived from the ACTIVE network;
  // for a Sepolia balance that id is null, so formatFiat gets no quote.
  const sepoliaBalanceId = nativePriceAssetId('eip155:1', 'eip155:11155111');
  check(
    'a Sepolia balance renders no fiat',
    sepoliaBalanceId === null &&
      formatFiat(sepoliaBalanceId ? quotes.get(sepoliaBalanceId) : undefined, 10n ** 18n, 18, {
        hidden: false,
      }) === null,
  );
}

// ---------------------------------------------------------------------------
// 5. Formatting: separators, "< $0.01", masking, missing price
// ---------------------------------------------------------------------------
console.log('\nFormatting');

const q = (price, extra = {}) => ({
  assetId: 'x',
  currency: 'usd',
  price,
  provider: 'coingecko',
  updatedAtMs: T0,
  fetchedAtMs: T0,
  ...extra,
});
const WEI = 10n ** 18n;

{
  check('groupThousands moved to balances.ts, re-exported unchanged', groupThousands === simulationGroupThousands);
  check('groupThousands 1234567.89', groupThousands('1234567.89') === '1,234,567.89');
  check('groupThousands 999.00 untouched', groupThousands('999.00') === '999.00');

  const big = formatFiat(q('2674.343997069859'), 1000n * WEI, 18, { hidden: false, nowMs: T0 });
  check('1000 ETH at 2674.343997069859 = "≈ $2,674,344.00"', big?.text === '≈ $2,674,344.00', big?.text);
  const usdc = formatFiat(q('0.9998'), 1_234_567_890_123n, 6, { hidden: false, nowMs: T0 });
  check('1,234,567.890123 USDC at 0.9998 = "≈ $1,234,320.98"', usdc?.text === '≈ $1,234,320.98', usdc?.text);
  const btc = formatFiat(q('83272.12'), 50_000_000n, 8, { hidden: false, nowMs: T0 });
  check('0.5 BTC at 83272.12 = "≈ $41,636.06"', btc?.text === '≈ $41,636.06', btc?.text);
  const small = formatFiat(q('181.5'), 5_000_000n, 9, { hidden: false, nowMs: T0 });
  check('0.005 SOL at 181.5 = "≈ $0.91"', small?.text === '≈ $0.91', small?.text);

  const dust = formatFiat(q('2674.34'), 1n, 18, { hidden: false, nowMs: T0 });
  check('1 wei is "< $0.01" (belowPrecision)', dust?.text === '< $0.01', dust?.text);
  check('missing quote renders nothing', formatFiat(undefined, WEI, 18, { hidden: false }) === null);
  check('zero amount renders nothing (never "$0.00")', formatFiat(q('2674.34'), 0n, 18, { hidden: false }) === null);
  check('unparseable price renders nothing', formatFiat(q('1e5'), WEI, 18, { hidden: false }) === null);
  check('fiatLine(null) is null', fiatLine(null) === null);

  const masked = formatFiat(q('2674.34'), 1000n * WEI, 18, { hidden: true, nowMs: T0 });
  const maskedDust = formatFiat(q('2674.34'), 1n, 18, { hidden: true, nowMs: T0 });
  check('hidden: fiat masked with maskAmount', masked?.text === `≈ ${maskAmount('x', true)}`, masked?.text);
  check('hidden: "< $0.01" masked identically (size never leaks)', maskedDust?.text === masked?.text);
  check('hidden: no stale note either', masked?.staleNote === null);
  const maskedStale = formatFiat(q('2674.34', { stale: true, updatedAtMs: T0 - 20 * 60_000 }), WEI, 18, {
    hidden: true,
    nowMs: T0,
  });
  check('hidden + stale: still just the mask', fiatLine(maskedStale) === masked?.text);
}

// ---------------------------------------------------------------------------
// 6. Stale marker
// ---------------------------------------------------------------------------
console.log('\nStale marker');

{
  check('describeAge 12 min', describeAge(12 * 60_000 + 5_000) === '12 min ago');
  check('describeAge floors to at least 1 min', describeAge(10_000) === '1 min ago');
  check('describeAge 3 h', describeAge(3 * 3_600_000 + 60_000) === '3 h ago');
  check('describeAge 2 days', describeAge(49 * 3_600_000) === '2 days ago');
  check('fresh quote: no marker', staleNoteFor(q('1'), T0 + 60_000) === null);
  check(
    'unflagged but vendor timestamp older than 10 min: marker',
    staleNoteFor(q('1', { updatedAtMs: T0 - 11 * 60_000 }), T0) === 'price from 11 min ago',
  );
  check('PRICE_OLD_AFTER_MS is 10 min', PRICE_OLD_AFTER_MS === 600_000);
  check(
    'stale-flagged quote without timestamps: generic marker',
    staleNoteFor({ assetId: 'x', currency: 'usd', price: '1', provider: 'p', stale: true }, T0) ===
      'price may be outdated',
  );
  check('device clock behind the vendor: no negative age, no marker', staleNoteFor(q('1'), T0 - 5_000) === null);

  // End to end through the cache: success at T0, vendor down 12 min later.
  reset();
  let now = T0;
  const opts = { enabled: true, store: memoryStore(), fetchFn: fakeFetch, now: () => now };
  await fetchPrices([ETH], opts);
  now = T0 + 12 * 60_000;
  server.status = 500;
  const quotes = await fetchPrices([ETH], opts);
  const quote = quotes.get(ETH);
  check('vendor failure within 30 min serves the cached price, flagged stale', quote?.stale === true);
  const display = formatFiat(quote, WEI, 18, { hidden: false, nowMs: now });
  check(
    'stale display: "≈ $2,674.34 · price from 12 min ago"',
    fiatLine(display) === '≈ $2,674.34 · price from 12 min ago',
    fiatLine(display),
  );
  now = T0 + 31 * 60_000;
  const tooOld = await fetchPrices([ETH], opts);
  check('older than 30 min and still failing: no price at all', !tooOld.has(ETH));
}

// ---------------------------------------------------------------------------
// 7. Demo-key store: verify-before-save
// ---------------------------------------------------------------------------
console.log('\nDemo-key store (verify-before-save)');

const KEY = 'CG-fakeDemoKeyForOfflineTests1';

// Capture console output: the key must never be logged.
const logged = [];
const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
function captureConsole() {
  for (const name of ['log', 'error', 'warn', 'info']) {
    console[name] = (...args) => {
      logged.push(args.map(String).join(' '));
      originals[name](...args);
    };
  }
}
captureConsole();

async function rejectCase(name, setup, pattern, key = KEY) {
  reset();
  setup();
  const store = memoryStore();
  const err = await checkRejects(`${name}: refused`, () => setPriceDemoKey(key, { store, fetchFn: fakeFetch }), pattern);
  check(`${name}: nothing persisted`, !store.raw.has(PRICE_KEY_STORAGE));
  check(
    `${name}: key not in the error message`,
    !(err instanceof Error) || !err.message.includes(KEY),
  );
}

await rejectCase('empty key', () => {}, /Enter the CoinGecko Demo API key/, '   ');
await rejectCase('key with spaces', () => {}, /Enter the CoinGecko Demo API key/, 'CG abc');
{
  reset();
  const store = memoryStore();
  await setPriceDemoKey('', { store, fetchFn: fakeFetch }).catch(() => {});
  check('malformed key input makes no request', calls.length === 0);
}
await rejectCase('HTTP 401 (invalid key)', () => (server.status = 401), /rejected this key/);
await rejectCase('HTTP 400 (wrong key type)', () => (server.status = 400), /HTTP 400/);
await rejectCase('HTTP 403', () => (server.status = 403), /HTTP 403/);
await rejectCase('HTTP 429', () => (server.status = 429), /rate-limiting/);
await rejectCase('HTTP 500', () => (server.status = 500), /HTTP 500/);
await rejectCase('network failure', () => (server.throwNetwork = true), /Could not reach CoinGecko/);
await rejectCase('malformed JSON body', () => (server.rawBody = '{"ethereum":'), /malformed/);
await rejectCase('200 without an ETH price', () => (server.omitEthereum = true), /without an ETH price/);

{
  reset();
  const store = memoryStore();
  await setPriceDemoKey(`  ${KEY}  `, { store, fetchFn: fakeFetch });
  check('accept: exactly ONE request', calls.length === 1, `${calls.length}`);
  check('accept: it is /simple/price for ethereum in usd', /\/simple\/price\?ids=ethereum&vs_currencies=usd/.test(calls[0]?.url ?? ''));
  check('accept: sent only to api.coingecko.com', (calls[0]?.url ?? '').startsWith('https://api.coingecko.com/api/v3/'));
  check('accept: key in the x-cg-demo-api-key header', calls[0]?.headers['x-cg-demo-api-key'] === KEY);
  check('accept: key never in the URL', !(calls[0]?.url ?? '').includes(KEY));
  const config = await getPriceConfig(store);
  check('accept: trimmed key persisted', config.demoApiKey === KEY);
  check('accept: verifiedAt is an ISO timestamp', typeof config.verifiedAt === 'string' && !Number.isNaN(Date.parse(config.verifiedAt)));

  // The shared provider picks the key up and is rebuilt when it changes.
  calls = [];
  resetSharedPriceProvider();
  await fetchPrices([ETH], { enabled: true, store, fetchFn: fakeFetch, now: () => T0 });
  check('stored key is used by fetchPrices', calls[0]?.headers['x-cg-demo-api-key'] === KEY);
  const before = sharedPriceProvider(KEY);
  check('same key: same shared instance', sharedPriceProvider(KEY) === before);
  const other = sharedPriceProvider('CG-another');
  check('changed key: provider rebuilt', other !== before);

  await clearPriceDemoKey(store);
  const cleared = await getPriceConfig(store);
  check('clear: back to keyless', cleared.demoApiKey === null && cleared.verifiedAt === null);
  calls = [];
  await fetchPrices([ETH], { enabled: true, store, fetchFn: fakeFetch, now: () => T0 });
  check(
    'after clear: requests carry no key (rebuilt, not served from the keyed cache)',
    calls.length === 1 && calls[0].headers['x-cg-demo-api-key'] === undefined,
  );
}

{
  const store = memoryStore();
  store.raw.set(PRICE_KEY_STORAGE, '{corrupt');
  const config = await getPriceConfig(store);
  check('corrupt stored config reads as keyless', config.demoApiKey === null);
}

{
  calls = [];
  const guarded = guardedCoinGeckoFetch(fakeFetch);
  let refused = false;
  try {
    await guarded('https://evil.example/api/v3/simple/price?ids=ethereum', {
      headers: { 'x-cg-demo-api-key': KEY },
    });
  } catch {
    refused = true;
  }
  check('transport guard: the key header is never sent to another host', refused && calls.length === 0);
  await guarded('https://evil.example/x', { headers: { accept: 'application/json' } });
  check('transport guard: keyless requests are not affected', calls.length === 1);
}

check('the key never appeared in console output', !logged.some((line) => line.includes(KEY)));
Object.assign(console, originals);

// ---------------------------------------------------------------------------
// Optional live probe (keyless, read-only)
// ---------------------------------------------------------------------------

if (process.argv.includes('--live')) {
  console.log('\nLIVE keyless probe (api.coingecko.com, 2 requests)');
  resetSharedPriceProvider();
  const ids = [...nativePriceIds(false), tokenPriceAssetId(USDC_MAINNET, 'eip155:1')];
  const quotes = await fetchPrices(ids, { enabled: true, store: memoryStore() });
  for (const [id, decimals, amount, label] of [
    [ETH, 18, 10n ** 18n, '1 ETH'],
    [BTC, 8, 10n ** 8n, '1 BTC'],
    [DOGE, 8, 1000n * 10n ** 8n, '1000 DOGE'],
    [SOL, 9, 10n ** 9n, '1 SOL'],
    [USDC_ID, 6, 100n * 10n ** 6n, '100 USDC'],
  ]) {
    const line = fiatLine(formatFiat(quotes.get(id), amount, decimals, { hidden: false }));
    console.log(`  ${label.padEnd(10)} ${line ?? '(no price)'}  raw=${quotes.get(id)?.price ?? '-'}`);
  }
  check('live: all five assets priced keylessly', [ETH, BTC, DOGE, SOL, USDC_ID].every((id) => quotes.has(id)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// Phase 20 item 1, feature 98: the watchlist and price alerts
// (src/wallet/price-alerts.ts), their notification (src/wallet/notifications.ts
// presentPriceAlert) and the monitor's discipline (components/
// PriceAlertMonitor.tsx, source pins) OFFLINE: the assets that can be
// followed (priced mainnet only), threshold parsing, "above"/"below" strictly,
// hysteresis (one crossing fires once), only fresh quotes, the monitor that
// asks for no price when nothing is set, the strict parse with its caps,
// writes refused on a damaged store, and the notification's text that names
// no coin and no price. Ends with mutants from scratch copies of
// price-alerts.ts, each caught.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-price-alerts.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as A from '../src/wallet/price-alerts.ts';
import {
  CHANNEL_PRICE_ALERTS,
  PRICE_ALERT_BODY,
  PRICE_ALERT_ID_PREFIX,
  PRICE_ALERT_TITLE,
  createNotificationCenter,
  priceAlertContent,
  screenFromNotificationData,
} from '../src/wallet/notifications.ts';

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
function memoryStore(initial = {}) {
  const mem = new Map(Object.entries(initial));
  return {
    mem,
    writes: 0,
    async getItem(k) {
      return mem.has(k) ? mem.get(k) : null;
    },
    async setItem(k, v) {
      this.writes += 1;
      mem.set(k, v);
    },
    async removeItem(k) {
      mem.delete(k);
    },
  };
}

const ETH = 'eip155:1/slip44:60';
const BTC = 'bip122:000000000019d6689c085ae165831e93/slip44:0';
const USDC = 'eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const NOW = 1_800_000_000_000;
const q = (price, extra = {}) => ({ assetId: ETH, currency: 'usd', price, provider: 'coingecko', updatedAtMs: NOW - 30_000, fetchedAtMs: NOW - 10_000, ...extra });

// ===========================================================================
console.log('check-price-alerts: what can be followed');
// ===========================================================================
{
  const ids = A.WATCHABLE_ASSETS.map((a) => `${a.symbol}=${a.id}`);
  check('the four mainnet coins and USDC, nothing else', JSON.stringify(ids) === JSON.stringify([
    `ETH=${ETH}`,
    `BTC=${BTC}`,
    'DOGE=bip122:1a91e3dace36e2be3bf030a65679fe82/slip44:3',
    'SOL=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',
    `USDC=${USDC}`,
  ]), ids.join(', '));
  check('a test-network asset cannot be followed', A.watchAssetFor('eip155:11155111/slip44:60') === null && (() => {
    try {
      A.addToWatchlist(A.EMPTY_BOOK, 'eip155:11155111/slip44:60');
      return false;
    } catch (e) {
      return e.message === 'This asset cannot be followed: only priced main-network assets can.';
    }
  })());
}

// ===========================================================================
console.log('check-price-alerts: thresholds');
// ===========================================================================
{
  const p = (s) => A.parseThreshold(s);
  check('"3000" and "$3000" parse to 3000', p('3000').value === '3000' && p('$3000').value === '3000');
  check('"3000.10" is kept canonical as 3000.1; ".5" as 0.5', p('3000.10').value === '3000.1' && p('.5').value === '0.5');
  check('commas are refused with a sentence', p('3,000').error === 'Type the price without commas or spaces, for example 3000 or 0.25.');
  check('zero is refused', p('0').error === 'The price must be more than 0.' && p('0.00').ok === false);
  check('more than 8 decimals is refused', p('1.123456789').ok === false && p('0.00000001').ok === true);
  check('an empty field asks for a price', p('  ').error === 'Enter a price in US dollars, for example 3000 or 0.25.');
  check('price display: cents at $1 or more, digits below', A.priceText('3012.4') === '$3,012.40' && A.priceText('0.09323210326398859') === '$0.0932321' && A.thresholdText('3000') === '$3,000');
}

// ===========================================================================
console.log('check-price-alerts: above / below and one crossing fires once');
// ===========================================================================
const above = { id: 'a1', assetId: ETH, direction: 'above', threshold: '3000', state: 'armed', createdAt: NOW };
const below = { id: 'a2', assetId: ETH, direction: 'below', threshold: '2000', state: 'armed', createdAt: NOW };
function run(alert, prices) {
  let a = alert;
  const fired = [];
  for (const price of prices) {
    const step = A.stepAlert(a, q(price), NOW);
    a = step.alert;
    fired.push(step.fired);
  }
  return { alert: a, fired };
}
{
  check('"above" is strict: equal to the threshold does not fire', run(above, ['3000']).fired[0] === false);
  check('"above" fires above the threshold', run(above, ['3000.01']).fired[0] === true);
  check('"below" is strict and fires below', run(below, ['2000']).fired[0] === false && run(below, ['1999.99']).fired[0] === true);
  const hover = run(above, ['3001', '2999', '3001', '2980', '3002']);
  check('a price hovering around the threshold fires once (no re-arm within 1%)', JSON.stringify(hover.fired) === JSON.stringify([true, false, false, false, false]) && hover.alert.state === 'tripped');
  const again = run(above, ['3001', '2970', '3001']);
  check('after moving back 1% ($2,970) it re-arms and the next crossing fires again', JSON.stringify(again.fired) === JSON.stringify([true, false, true]));
  const down = run(below, ['1999', '2010', '1990', '2020', '1980']);
  check('"below" mirrors it (re-arm at +1%: $2,020)', JSON.stringify(down.fired) === JSON.stringify([true, false, false, false, true]));
  check('a fired alert records when and at what price', hover.alert.firedAt === NOW && hover.alert.firedPrice === '3001');
}

// ===========================================================================
console.log('check-price-alerts: only fresh prices');
// ===========================================================================
{
  check('a quote served stale by the cache fires nothing', A.stepAlert(above, q('9999', { stale: true }), NOW).fired === false);
  check('a quote whose price is over 10 minutes old fires nothing', A.stepAlert(above, q('9999', { updatedAtMs: NOW - 11 * 60_000 }), NOW).fired === false);
  check('a missing quote changes nothing', A.stepAlert(above, undefined, NOW).changed === false);
}

// ===========================================================================
console.log('check-price-alerts: adding alerts');
// ===========================================================================
{
  const { book, result } = A.addAlert(A.EMPTY_BOOK, { assetId: ETH, direction: 'above', threshold: '3000.50', quote: q('2500'), nowMs: NOW });
  check('an alert is added armed, its asset to the watchlist, ids from nextId', result.alert.state === 'armed' && result.alert.id === 'a1' && book.watchlist.join() === ETH && book.nextId === 2 && result.alert.threshold === '3000.5' && result.note === null);
  const already = A.addAlert(A.EMPTY_BOOK, { assetId: ETH, direction: 'above', threshold: '2000', quote: q('2500'), nowMs: NOW });
  check('an alert whose condition already holds starts tripped and says why', already.result.alert.state === 'tripped' &&
    already.result.note === 'ETH is already above $2,000 ($2,500.00 now), so this alert fires the next time it crosses $2,000 after first moving back 1% to the other side.');
  check('…and does not fire on the next check', A.stepAlert(already.result.alert, q('2600'), NOW).fired === false);
  const dupErr = (() => {
    try {
      A.addAlert(book, { assetId: ETH, direction: 'above', threshold: '3000.5', quote: null, nowMs: NOW });
      return null;
    } catch (e) {
      return e.message;
    }
  })();
  check('a duplicate alert is refused', dupErr === 'An alert for ETH above $3,000.5 already exists.', dupErr);
  let b = A.EMPTY_BOOK;
  for (const t of ['1', '2', '3', '4']) b = A.addAlert(b, { assetId: BTC, direction: 'above', threshold: t, quote: null, nowMs: NOW }).book;
  const capErr = (() => {
    try {
      A.addAlert(b, { assetId: BTC, direction: 'above', threshold: '5', quote: null, nowMs: NOW });
      return null;
    } catch (e) {
      return e.message;
    }
  })();
  check('at most 4 alerts on one asset', capErr === 'At most 4 alerts can be set on BTC; remove one first.');
  const removed = A.removeFromWatchlist(b, BTC);
  check('removing an asset removes its alerts', removed.alerts.length === 0 && removed.watchlist.length === 0);
}

// ===========================================================================
console.log('check-price-alerts: the monitor asks for nothing when nothing is set');
// ===========================================================================
{
  const mk = (initialBook) => {
    const store = memoryStore(initialBook === null ? {} : { [A.PRICE_ALERTS_KEY]: initialBook });
    const asked = [];
    const monitor = A.createPriceAlertMonitor({
      load: () => A.loadPriceAlerts(store),
      update: (change) => A.updatePriceAlerts(change, store),
      fetchQuotes: async (ids) => {
        asked.push(ids);
        return new Map([[ETH, q('3100')]]);
      },
      now: () => NOW,
    });
    return { store, asked, monitor };
  };
  const empty = mk(null);
  const r0 = await empty.monitor.check();
  check('no stored list: no price request', r0.requested === false && empty.asked.length === 0);
  const watchOnly = mk(JSON.stringify({ version: 1, watchlist: [ETH, BTC], alerts: [], nextId: 1 }));
  await watchOnly.monitor.check();
  check('a watchlist with no alert: no price request', watchOnly.asked.length === 0);
  const damaged = mk('{"version":1,"oops":true}');
  await damaged.monitor.check();
  check('a damaged list: no price request', damaged.asked.length === 0);
  check('shouldCheckPriceAlerts is false for an empty or damaged list', !A.shouldCheckPriceAlerts(A.EMPTY_BOOK) && !A.shouldCheckPriceAlerts({ alerts: [above], damaged: true }) && A.shouldCheckPriceAlerts({ alerts: [above], damaged: false }));
  const one = mk(A.serializePriceAlertBook({ watchlist: [ETH, BTC], alerts: [above], nextId: 2, damaged: false }));
  const [r1, r2] = await Promise.all([one.monitor.check(), one.monitor.check()]);
  check('an alert set: ONE request, for the alerted asset only (BTC is watched, not alerted)', one.asked.length === 1 && JSON.stringify(one.asked[0]) === JSON.stringify([ETH]));
  check('…and it fires once, stored as tripped', r1.fired.length === 1 && r1 === r2 && JSON.parse(one.store.mem.get(A.PRICE_ALERTS_KEY)).alerts[0].state === 'tripped');
  const r3 = await one.monitor.check();
  check('the next check (same price) fires nothing', r3.fired.length === 0 && r3.requested === true);
  check('the fired banner text names the alert, the price, the source and "advisory"', A.firedAlertText(r1.fired[0], NOW) === 'Price alert: ETH above $3,000. CoinGecko’s price was $3,100.00, less than a minute ago. Alerts are advisory: nothing is bought, sold or sent.');
  check('the poll is every 5 minutes', A.PRICE_ALERT_POLL_MS === 300_000);
}

// ===========================================================================
console.log('check-price-alerts: strict storage');
// ===========================================================================
{
  const good = { version: 1, watchlist: [ETH], alerts: [{ id: 'a1', assetId: ETH, direction: 'above', threshold: '3000', state: 'armed', createdAt: 1 }], nextId: 2 };
  const parse = (o) => A.parsePriceAlertBook(JSON.stringify(o));
  check('a valid list round-trips', JSON.stringify(parse(good)) === JSON.stringify({ watchlist: good.watchlist, alerts: good.alerts, nextId: 2, damaged: false }) && A.serializePriceAlertBook(parse(good)) === JSON.stringify(good));
  check('an unknown top-level key is refused', parse({ ...good, extra: 1 }) === null);
  check('another version is refused', parse({ ...good, version: 2 }) === null);
  check('an unknown asset is refused', parse({ ...good, watchlist: [ETH, 'eip155:1/erc20:0x0000000000000000000000000000000000000bad'] }) === null);
  check('an alert on an asset not in the watchlist is refused', parse({ ...good, watchlist: [BTC] }) === null);
  check('a non-canonical threshold is refused', parse({ ...good, alerts: [{ ...good.alerts[0], threshold: '3000.0' }] }) === null);
  check('an unknown alert key is refused', parse({ ...good, alerts: [{ ...good.alerts[0], note: 'x' }] }) === null);
  check('an id not below nextId is refused', parse({ ...good, nextId: 1 }) === null);
  check('firedAt without firedPrice is refused', parse({ ...good, alerts: [{ ...good.alerts[0], firedAt: 5 }] }) === null);
  check('a duplicate rule is refused', parse({ ...good, alerts: [good.alerts[0], { ...good.alerts[0], id: 'a2' }], nextId: 3 }) === null);
  const many = Array.from({ length: 21 }, (_, i) => ({ ...good.alerts[0], id: `a${i + 1}`, threshold: String(i + 1), assetId: ETH }));
  check('more than 20 alerts is refused', parse({ ...good, alerts: many, nextId: 30 }) === null);
  check('the caps are 20 alerts and 4 per asset', A.MAX_PRICE_ALERTS === 20 && A.MAX_ALERTS_PER_ASSET === 4);
  const store = memoryStore({ [A.PRICE_ALERTS_KEY]: 'not json' });
  const book = await A.loadPriceAlerts(store);
  check('a damaged store loads as damaged and empty', book.damaged === true && book.alerts.length === 0);
  const err = await A.updatePriceAlerts((b) => ({ book: A.addToWatchlist(b, ETH), result: null }), store).then(() => null, (e) => e.message);
  check('a damaged store refuses every write and is not overwritten', err === A.PRICE_ALERTS_DAMAGED_MESSAGE && store.writes === 0 && store.mem.get(A.PRICE_ALERTS_KEY) === 'not json');
  await A.resetPriceAlerts(store);
  check('reset deletes the stored list', !store.mem.has(A.PRICE_ALERTS_KEY));
}

// ===========================================================================
console.log('check-price-alerts: the notification');
// ===========================================================================
{
  const content = priceAlertContent();
  check('the title is "Price alert"; the body names no coin, no price, no amount', content.title === PRICE_ALERT_TITLE && PRICE_ALERT_TITLE === 'Price alert' && !/\d|\$|ETH|BTC|USDC/.test(PRICE_ALERT_BODY));
  check('a tap opens the price alerts (allow-listed)', screenFromNotificationData(content.data) === 'PriceAlerts' && screenFromNotificationData({ screen: 'Send' }) === null);
  check('its own channel, default importance', CHANNEL_PRICE_ALERTS.id === 'price-alerts' && CHANNEL_PRICE_ALERTS.importance === 'default');
  const store = memoryStore();
  let loads = 0;
  const shown = [];
  const channels = [];
  const native = {
    platform: 'android',
    async ensureChannels(list) {
      channels.push(...list.map((c) => c.id));
    },
    async schedule(req) {
      shown.push(req);
    },
  };
  const center = createNotificationCenter({ loadNative: async () => { loads += 1; return native; }, store });
  check('reminders off: nothing is loaded or shown', (await center.presentPriceAlert({ enabled: false, alertKey: 'a1' })) === 'off' && loads === 0 && shown.length === 0);
  const out = await center.presentPriceAlert({ enabled: true, alertKey: 'a1' });
  check('reminders on: the channel is created, then shown at once on it', out === 'presented' && channels.join() === 'price-alerts' && shown.length === 1 && shown[0].at === null && shown[0].channelId === 'price-alerts');
  check('the identifier is the wallet’s price-alert prefix (cancelled by "off")', shown[0].identifier.startsWith(PRICE_ALERT_ID_PREFIX) && PRICE_ALERT_ID_PREFIX.startsWith('shiba-wallet.'));
  check('the bookkeeping records that something may be shown (so "off" cleans up)', JSON.parse(store.mem.get('shiba-wallet.notifications.v1')).mayHaveScheduled === true);
  const broken = createNotificationCenter({ loadNative: async () => { throw new Error('missing'); }, store: memoryStore() });
  check('a missing module is a quiet failure that leaves the reminders status alone', (await broken.presentPriceAlert({ enabled: true, alertKey: 'a1' })) === 'failed' && broken.status() === null);
}

// ===========================================================================
console.log('check-price-alerts: the monitor and the screen (source pins)');
// ===========================================================================
{
  const mon = readFileSync(join(HERE, '..', 'src', 'components', 'PriceAlertMonitor.tsx'), 'utf8');
  check('checks only when an alert exists and fiat values are on', mon.includes("const enabled = ready && showFiat && status === 'ready' && hasAlerts;") && mon.includes('if (!enabled) return;'));
  check('the timer exists only while enabled and in front', mon.includes('if (!enabled || !active) return undefined;') && mon.includes('PRICE_ALERT_POLL_MS'));
  check('prices through the shared cached provider', mon.includes('fetchPrices(ids, { enabled: true })'));
  check('nothing that signs or sends', !/signWith|requireLocalAuth|sendAa|prepareEvmSend|navigate\('Send'|navigate\('Swap'/.test(mon));
  const app = readFileSync(join(HERE, '..', 'App.tsx'), 'utf8');
  check('the monitor is mounted once in App.tsx', (app.match(/<PriceAlertMonitor \/>/g) ?? []).length === 1);
  const screen = readFileSync(join(HERE, '..', 'src', 'screens', 'PriceAlertsScreen.tsx'), 'utf8');
  check('the screen states the reminders status exactly as Settings does, and the Expo Go limit', screen.includes('describeNotificationsStatus(badStatus)') && screen.includes('PRICE_ALERTS_EXPO_GO_NOTE'));
  check('the Expo Go sentence says notifications need the development build', A.PRICE_ALERTS_EXPO_GO_NOTE.includes('Expo Go cannot create the notification channels') && A.PRICE_ALERTS_EXPO_GO_NOTE.includes('development build'));
  check('alerts are called advisory', A.PRICE_ALERTS_INTRO.includes('Alerts are advisory') && A.PRICE_ALERTS_CHECK_NOTE.includes('Nothing checks prices while the wallet is closed'));
}

// ===========================================================================
console.log('Mutation checks (scratch copies of price-alerts.ts)');
// ===========================================================================
const MUTANT_DIR = join(HERE, `.mutants-price-alerts-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(from, to) {
  const relPath = 'src/wallet/price-alerts.ts';
  const original = readFileSync(join(HERE, '..', relPath), 'utf8');
  if (!original.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(HERE, '..', relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-price-alerts.ts`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
{
  const m1 = await importMutant("  if (alert.state === 'tripped' && rearmMet(alert, quote.price)) {", "  if (alert.state === 'tripped' && !conditionMet(alert, quote.price)) {");
  let a = above;
  const fired = [];
  for (const p of ['3001', '2999', '3001']) {
    const s = m1.stepAlert(a, q(p), NOW);
    a = s.alert;
    fired.push(s.fired);
  }
  check('mutant (no hysteresis) is caught: a hovering price fires twice', fired.filter(Boolean).length === 2);
  const m2 = await importMutant('  return !book.damaged && book.alerts.length > 0;', '  return true;');
  const asked = [];
  const mon = m2.createPriceAlertMonitor({ load: async () => m2.EMPTY_BOOK, update: async () => [], fetchQuotes: async (ids) => (asked.push(ids), new Map()), now: () => NOW });
  await mon.check();
  check('mutant (checks with nothing set) is caught: a request is made', asked.length === 1);
  const m3 = await importMutant("!exactKeys(raw, ['version', 'watchlist', 'alerts', 'nextId']) || ", '');
  check('mutant (loose parse) is caught: an unknown key is accepted', m3.parsePriceAlertBook(JSON.stringify({ version: 1, watchlist: [], alerts: [], nextId: 1, extra: true })) !== null);
  const m4 = await importMutant('  if (!quote || quote.stale) return false;\n  return staleNoteFor(quote, nowMs) === null;', '  return Boolean(quote);');
  check('mutant (old prices used) is caught', m4.stepAlert(above, q('9999', { stale: true }), NOW).fired === true);
  const m5 = await importMutant("return alert.direction === 'above' ? c > 0 : c < 0;", "return alert.direction === 'above' ? c >= 0 : c <= 0;");
  check('mutant (equal counts as a crossing) is caught', m5.stepAlert(above, q('3000'), NOW).fired === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

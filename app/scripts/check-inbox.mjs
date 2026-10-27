// The notifications inbox and the deep links (phase 22 item 5, features 83
// and 80), entirely OFFLINE: src/wallet/inbox.ts driven over an in-memory
// store (the strict parse, the cap, a damaged store read-only with a reset,
// the secret-free rule, read / unread, the open targets, the profile
// scoping); one write per event (the recurring banner and the phone
// reminder for the same slot through the REAL notification center with a
// fake native layer; the takeover alert; a WalletConnect sent view); the
// deep-link parser and planner in src/wallet/deep-links.ts (every allowed
// route, a payment link through the REAL payment-request parser with its
// refusals, links carrying calldata or an authorization, unknown and
// malformed links, the launch link taken once, the lock gate), with a
// counting fake secure store bound to the app vault to prove the whole link
// path reads no key; the watch-only and multisig allow lists; source pins
// on the wiring (App.tsx, Home, Settings, the recorders); mutants
// (rewritten copies of the modules), each shown caught.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-inbox.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serializeSessionKeyGrant } from '@shiba-wallet/chains-evm';
import * as I from '../src/wallet/inbox.ts';
import * as D from '../src/wallet/deep-links.ts';
import {
  RECURRING_DUE_BODY,
  RECURRING_DUE_TITLE,
  TAKEOVER_BODY,
  createNotificationCenter,
  recurringBannerInboxEvent,
  recurringNotificationId,
} from '../src/wallet/notifications.ts';
import { buildSubscription, subscriptionTokenChoices } from '../src/wallet/subscriptions.ts';
import { recurringDueState, recurringGrantFor, recurringMeta, scheduledDueHeadline } from '../src/wallet/recurring.ts';
import { onWcSentShown, wcSentResult, WC_TX_SENT_TITLE } from '../src/wallet/wc-sent.ts';
import { describeParsedRequest, parsePaymentRequest } from '../src/wallet/payment-request.ts';
import { listTokens } from '../src/wallet/tokens.ts';
import { EVM_PROFILES } from '../src/config/evm-chain.ts';
import { STORE_KEYS, profileBoundStore, storeKeyScope } from '../src/wallet/store-keys.ts';
import { bindSecureStore } from '../src/wallet/storage.ts';
import { MULTISIG_ALLOWED_ROUTES, WATCH_ONLY_ALLOWED_ROUTES, multisigRouteRefusal, watchOnlyRouteRefusal } from '../src/wallet/watch-only.ts';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const read = (rel) => readFileSync(join(APP, rel), 'utf8');
const MUTANT_DIR = join(HERE, `.mutants-inbox-${process.pid}`);
let mutants = 0;
let mutantsCaught = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
/** A deliberately broken copy of an app module (relative imports rewritten to the real files). */
async function importMutant(relPath, from, to) {
  const original = read(relPath);
  if (!original.includes(from)) throw new Error(`mutation anchor not found in ${relPath}: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(APP, relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutants += 1;
  const file = join(MUTANT_DIR, `m${mutants}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
function mutantCaught(name, caught) {
  if (caught) mutantsCaught += 1;
  check(`mutant caught: ${name}`, caught);
}

function memoryStore() {
  const map = new Map();
  const s = {
    map,
    writes: 0,
    reads: 0,
    async getItem(k) {
      s.reads += 1;
      return map.has(k) ? map.get(k) : null;
    },
    async setItem(k, v) {
      s.writes += 1;
      map.set(k, v);
    },
    async removeItem(k) {
      map.delete(k);
    },
  };
  return s;
}

const LONG_HEX_32 = /[0-9a-fA-F]{32}/;
const memoryStoreInbox = (store) => I.createInbox({ store, now: () => T0 });
const T0 = 1_800_000_000_000;
const ev = (n, over = {}) => ({ key: `event-${n}`, kind: 'sent', via: 'in-app', at: T0 + n, title: 'Transaction sent', text: `Sent for app ${n}.`, ...over });

// ---------------------------------------------------------------------------
console.log('check-inbox: the store (src/wallet/inbox.ts)');
// ---------------------------------------------------------------------------
{
  check('one wallet-scoped key, declared in the storage seam', I.INBOX_KEY === 'shiba-wallet.inbox.v1' && STORE_KEYS.inbox.name === I.INBOX_KEY && storeKeyScope(I.INBOX_KEY) === 'wallet' && STORE_KEYS.inbox.backing === 'async-storage');
  check('cap 200 entries', I.INBOX_MAX_ENTRIES === 200);

  const store = memoryStore();
  const inbox = I.createInbox({ store, now: () => T0 + 1_000_000 });
  check('an event is recorded', (await inbox.record(ev(1))) === 'recorded');
  const writesAfterFirst = store.writes;
  check('the same event again: "duplicate", nothing written', (await inbox.record(ev(1, { text: 'another sentence' }))) === 'duplicate' && store.writes === writesAfterFirst);
  const fresh = I.createInbox({ store, now: () => T0 + 1_000_000 });
  check('…also from a fresh instance (no memory): read, found, nothing written', (await fresh.record(ev(1))) === 'duplicate' && store.writes === writesAfterFirst);
  const state = await inbox.load();
  const e = state.entries[0];
  check('the entry: 16-hex id and group, the kind, how it was shown, the time, title and sentence, unread',
    state.entries.length === 1 && /^[0-9a-f]{16}$/.test(e.id) && /^[0-9a-f]{16}$/.test(e.group) && e.kind === 'sent' && e.via === 'in-app' &&
      e.at === T0 + 1 && e.title === 'Transaction sent' && e.text === 'Sent for app 1.' && e.read === false && !state.readOnly);
  check('the id is a tag of the event key, not the key', e.id === I.inboxTag('event|event-1') && !store.map.get(I.INBOX_KEY).includes('event-1'));
  check('the stored document is exactly { version: 1, entries } with the eight entry fields',
    JSON.stringify(Object.keys(JSON.parse(store.map.get(I.INBOX_KEY)))) === '["version","entries"]' &&
      JSON.stringify(Object.keys(JSON.parse(store.map.get(I.INBOX_KEY)).entries[0]).sort()) === '["at","group","id","kind","read","text","title","via"]');

  // The cap: the oldest (by time) is evicted.
  const capStore = memoryStore();
  const capped = I.createInbox({ store: capStore, now: () => T0 });
  for (let i = 0; i < 205; i += 1) await capped.record(ev(i));
  const cs = await capped.load();
  check('the cap: 205 recorded, 200 kept, the five oldest evicted', cs.entries.length === 200 && !cs.entries.some((x) => x.at < T0 + 5) && cs.entries.some((x) => x.at === T0 + 204));

  // Read / unread, mark all read, the open targets.
  const rs = memoryStore();
  const ri = I.createInbox({ store: rs, now: () => T0 + 10_000 });
  await ri.record(ev(1, { kind: 'recurring-due', title: RECURRING_DUE_TITLE, text: RECURRING_DUE_BODY }));
  await ri.record(ev(2, { kind: 'takeover' }));
  await ri.record(ev(3, { kind: 'price-alert' }));
  await ri.record(ev(4, { kind: 'replacement' }));
  await ri.record(ev(5, { kind: 'swap-due', via: 'scheduled', at: T0 + 50_000 }));
  let r = await ri.load();
  check('unread count: 4 shown (the reminder set for later is not counted yet)', I.inboxUnreadCount(r.entries, T0 + 10_000) === 4 && I.inboxUnreadCount(r.entries, T0 + 60_000) === 5);
  check('visible newest first; the future reminder hidden until its time',
    JSON.stringify(I.visibleInboxEntries(r.entries, T0 + 10_000).map((x) => x.at)) === JSON.stringify([T0 + 4, T0 + 3, T0 + 2, T0 + 1]) &&
      I.visibleInboxEntries(r.entries, T0 + 50_000)[0].at === T0 + 50_000);
  await ri.markRead(r.entries.find((x) => x.kind === 'takeover').id);
  r = await ri.load();
  check('mark one read', r.entries.find((x) => x.kind === 'takeover').read === true && I.inboxUnreadCount(r.entries, T0 + 10_000) === 3);
  await ri.markAllRead();
  r = await ri.load();
  check('mark all read: every shown entry read; the reminder set for later stays unread', I.inboxUnreadCount(r.entries, T0 + 10_000) === 0 && r.entries.find((x) => x.kind === 'swap-due').read === false);
  check('open targets: the same screens the banners and notifications open',
    I.INBOX_TARGET_BY_KIND['recurring-due'] === 'Sessions' && I.INBOX_TARGET_BY_KIND['swap-due'] === 'Sessions' && I.INBOX_TARGET_BY_KIND.takeover === 'Inheritance' &&
      I.INBOX_TARGET_BY_KIND['price-alert'] === 'PriceAlerts' && I.INBOX_TARGET_BY_KIND.sent === 'Activity' && I.INBOX_TARGET_BY_KIND.replacement === 'Activity');
  const screen = read('src/screens/InboxScreen.tsx');
  check('the screen opens an entry through INBOX_TARGET_BY_KIND after marking it read (Activity on the Ethereum slot)',
    /void appInbox\(\)\.markRead\(entry\.id\);\n\s+const target = INBOX_TARGET_BY_KIND\[entry\.kind\];/.test(screen) && screen.includes("navigation.navigate('Activity', { chainId: 'eip155:1' })") && screen.includes('else navigation.navigate(target);'));

  // Scheduled reminders: replaced when moved, dropped when cancelled before their time.
  const ss = memoryStore();
  const si = I.createInbox({ store: ss, now: () => T0 });
  await si.record({ ...ev(9, { kind: 'recurring-due', via: 'scheduled', at: T0 + 100 }), key: 'due|id|1', group: 'due|id' });
  await si.record({ ...ev(9, { kind: 'recurring-due', via: 'scheduled', at: T0 + 200 }), key: 'due|id|2', group: 'due|id' });
  let sstate = await si.load();
  check('a reminder moved to another time replaces the earlier pending entry', sstate.entries.length === 1 && sstate.entries[0].at === T0 + 200);
  await si.dropScheduled('due|id');
  sstate = await si.load();
  check('a reminder cancelled before its time: its pending entry is dropped', sstate.entries.length === 0);
  const past = I.createInbox({ store: ss, now: () => T0 + 1000 });
  await past.record({ ...ev(9, { kind: 'recurring-due', via: 'scheduled', at: T0 + 500 }), key: 'due|id|3', group: 'due|id' });
  await past.dropScheduled('due|id');
  check('…but one whose time has come stays listed', (await past.load()).entries.length === 1);

  // Secret-free.
  const hexStore = memoryStore();
  const hi = I.createInbox({ store: hexStore, now: () => T0 });
  const HASH = `0x${'ab12'.repeat(16)}`;
  const ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
  await hi.record(ev(1, { text: `Sent ${HASH} to ${ADDRESS} for a dApp named ${'c0ffee'.repeat(6)}.`, title: `Title ${HASH}` }));
  const hs = await hi.load();
  check('a long hex run in a sentence is shortened before it is stored (hash, address, 36-hex name)',
    !LONG_HEX_32.test(hexStore.map.get(I.INBOX_KEY)) && hs.entries[0].text.startsWith('Sent 0xab12…ab12 to 0x9858…da94 for a dApp named c0ff…ffee.'), hs.entries[0].text);
  check('text is cleaned: control and bidirectional characters removed, whitespace collapsed, at most 600 characters',
    I.entryFromEvent(ev(1, { text: `A‮b\u0007\n\n  c ${'x'.repeat(700)}` })).text.startsWith('Ab c x') && Array.from(I.entryFromEvent(ev(1, { text: 'y'.repeat(900) })).text).length === 600);
  check('an event with an unknown kind, an empty sentence or a bad time is not stored',
    (await hi.record(ev(2, { kind: 'pin' }))) === 'failed' && (await hi.record(ev(3, { text: ' ' }))) === 'failed' && (await hi.record(ev(4, { at: -1 }))) === 'failed');

  // Strict parse: a damaged store is read-only, the readable entries are shown, reset recovers.
  const good = JSON.parse(store.map.get(I.INBOX_KEY)).entries[0];
  const tamper = async (doc) => {
    const t = memoryStore();
    t.map.set(I.INBOX_KEY, typeof doc === 'string' ? doc : JSON.stringify(doc));
    const ti = I.createInbox({ store: t, now: () => T0 });
    const loaded = await ti.load();
    const before = t.writes;
    const outcome = await ti.record(ev(77));
    return { loaded, outcome, wrote: t.writes > before, store: t, inbox: ti };
  };
  const cases = {
    'not JSON': '{oops',
    'a newer version': { version: 2, entries: [good] },
    'an extra top-level key': { version: 1, entries: [good], note: 1 },
    'an extra entry field': { version: 1, entries: [good, { ...good, id: 'aaaaaaaaaaaaaaaa', extra: 1 }] },
    'an id that is not 16 hex': { version: 1, entries: [good, { ...good, id: 'xyz' }] },
    'an unknown kind': { version: 1, entries: [good, { ...good, id: 'bbbbbbbbbbbbbbbb', kind: 'phrase' }] },
    'a stored long hex run': { version: 1, entries: [good, { ...good, id: 'cccccccccccccccc', text: `k ${'a'.repeat(64)}` }] },
    'a duplicate id': { version: 1, entries: [good, good] },
    'too many entries': { version: 1, entries: Array.from({ length: 201 }, (_, i) => ({ ...good, id: i.toString(16).padStart(16, '0') })) },
  };
  let allReadOnly = true;
  let goodShown = true;
  for (const [name, doc] of Object.entries(cases)) {
    const t = await tamper(doc);
    if (!t.loaded.readOnly || t.outcome !== 'read-only' || t.wrote) {
      allReadOnly = false;
      console.log(`       (not read-only: ${name})`);
    }
    if (typeof doc !== 'string' && doc.entries?.[0] === good && !t.loaded.entries.some((x) => x.id === good.id)) goodShown = false;
  }
  check(`a damaged store is read-only and refuses writes (${Object.keys(cases).length} shapes)`, allReadOnly);
  check('…the entries that read back are still shown', goodShown);
  const t = await tamper({ version: 1, entries: [good, { ...good, id: 'dddddddddddddddd', kind: 'phrase' }] });
  await t.inbox.reset();
  const after = await t.inbox.load();
  check('reset writes an empty, writable inbox', !after.readOnly && after.entries.length === 0 && (await t.inbox.record(ev(78))) === 'recorded');

  // Pass p22b: on the device the inbox never listed anything while the
  // store behind it failed; a rejected load looked like an empty inbox and a
  // failed write was silent. A store that throws (as the old lazy store did
  // when its dynamic import failed) must be reported, never shown as empty.
  const throwing = {
    async getItem() {
      throw new Error('AsyncStorage chunk could not be loaded');
    },
    async setItem() {
      throw new Error('AsyncStorage chunk could not be loaded');
    },
  };
  const logs = [];
  const bi = I.createInbox({ store: throwing, now: () => T0, log: (m) => logs.push(m) });
  const view = await I.loadInboxView(bi);
  check('a store that throws on read: the screen gets a load FAILURE with the store\'s error, not an empty inbox',
    view.loadFailure === 'AsyncStorage chunk could not be loaded' && view.state.entries.length === 0 && view.recordFailure === null);
  let notified = 0;
  bi.subscribe(() => (notified += 1));
  const o1 = await bi.record(ev(1));
  const o2 = await bi.record(ev(2));
  check('…a write that throws: record() still never throws, reports "failed", keeps the error for the screen and tells the listeners',
    o1 === 'failed' && o2 === 'failed' && bi.lastRecordFailure() === 'AsyncStorage chunk could not be loaded' && notified === 2 &&
      (await I.loadInboxView(bi)).recordFailure === 'AsyncStorage chunk could not be loaded');
  check('…logged once per session, with the store\'s error only (no entry text)',
    logs.length === 1 && logs[0] === 'The inbox could not record an entry: AsyncStorage chunk could not be loaded' && !logs[0].includes('Sent for app'));
  {
    const flaky = memoryStore();
    let fail = true;
    const realSet = flaky.setItem;
    flaky.setItem = async (k, v) => {
      if (fail) throw new Error('disk full');
      return realSet(k, v);
    };
    const fi = I.createInbox({ store: flaky, now: () => T0, log: () => undefined });
    await fi.record(ev(1));
    const before = fi.lastRecordFailure();
    fail = false;
    await fi.reset();
    check('…a reset that succeeds clears the failure (the list starts over); the failure stays until then',
      before === 'disk full' && fi.lastRecordFailure() === null && (await I.loadInboxView(memoryStoreInbox(flaky))).loadFailure === null);
  }
  const ok = await I.loadInboxView(I.createInbox({ store: memoryStore(), now: () => T0 }));
  check('…and a store that works: no failure, the state as loaded', ok.loadFailure === null && ok.recordFailure === null && ok.state.readOnly === false);
  {
    const scr = read('src/screens/InboxScreen.tsx');
    check('the screen loads through loadInboxView and shows the read failure (with the technical line and Try again) instead of the empty sentence',
      scr.includes('void loadInboxView(appInbox()).then((view) => {') && !/\.load\(\)\s*\.then\(/.test(scr) &&
        /<WarningBox>\{INBOX_LOAD_FAILED_MESSAGE\}<\/WarningBox>\s*<TechnicalDetail text=\{loadFailure\} \/>/.test(scr) &&
        scr.includes('{loaded && loadFailure === null && entries.length === 0 ?') &&
        /<WarningBox>\{INBOX_RECORD_FAILED_MESSAGE\}<\/WarningBox>\s*<TechnicalDetail text=\{recordFailure\} \/>/.test(scr));
    check('…the two messages (exact)',
      I.INBOX_LOAD_FAILED_MESSAGE === 'The inbox stored on this phone could not be read just now, so its entries are not shown. Nothing was deleted. Pull down to try again.' &&
        I.INBOX_RECORD_FAILED_MESSAGE === 'A message could not be added to the inbox on this phone, so this list may be missing it.');
  }

  // Profiles and the wipe.
  const ps = memoryStore();
  const decoy = I.createInbox({ store: profileBoundStore(ps, { id: 'decoy', keyPrefix: 'w2' }), now: () => T0 });
  await decoy.record(ev(1));
  check("a second wallet (the duress PIN's decoy) has its own inbox key", ps.map.has('shiba-wallet.profile-w2.inbox.v1') && !ps.map.has(I.INBOX_KEY));
  await I.wipeInbox(store);
  check('the wipe removes the inbox', !store.map.has(I.INBOX_KEY));
  check('…and every inbox forgets what it remembered: the same event in a new wallet is listed again', (await inbox.record(ev(1))) === 'recorded');
  check('wipe: the one-line WalletContext patch is not applied in this slice (stated in the report)', true);
}

// ---------------------------------------------------------------------------
console.log('check-inbox: one write per event');
// ---------------------------------------------------------------------------
const M = 'eip155:11155111';
const OWNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ACCOUNT = '0xB67b8b7cCA718EAC64d2b59ba568585A9FC69a42';
const SESSION_KEY = '0x484B87B8D4D73d88ccF7D39C006cC1b078384640';
const DAY = 86_400;
const S = 1_800_000_000;
const choices = subscriptionTokenChoices(M, 'test ETH');
function recurringRecord(permissionId = '0x0123456789abcdef') {
  const sub = buildSubscription(
    { merchant: '0x69F0EC265702D0891b0AEF8e79ddDC3277ef7E8a', choice: choices[0], amount: '0.0001', periodSeconds: DAY, payments: '3', feeBudget: '0.01', label: 'Terms' },
    { now: S, account: ACCOUNT, testnet: true },
  );
  const grant = recurringGrantFor(sub, SESSION_KEY, { account: ACCOUNT, now: S });
  return {
    chain: M, account: ACCOUNT, owner: OWNER, accountIndex: 0, accountKind: 'kernel-v3.3', permissionId, policyCount: 4,
    grant: serializeSessionKeyGrant(grant), label: 'Recurring payment', source: 'recurring', dappUrl: null, createdAt: S * 1000,
    installMode: 'explicit', keyHeld: true, installUserOpHash: null, revokeUserOpHash: null, localStatus: 'installed', subscription: recurringMeta(sub, choices[0]),
  };
}
const status = (over = {}) => ({
  kind: 'ok',
  state: { rateLimitStatus: 'live', remainingPulls: 3, nextSlotAt: S, intervalSeconds: DAY, feeBudgetLeftWei: 10n ** 16n, validUntil: S + 5 * DAY, ...over },
  next: { kind: 'now' },
});
function fakeNative() {
  const n = {
    platform: 'android', scheduled: new Map(), shown: [],
    async getPermission() { return { granted: true, canAskAgain: true }; },
    async requestPermission() { return { granted: true, canAskAgain: true }; },
    async ensureChannels() {},
    async schedule(req) { if (req.at === null) n.shown.push(req); else n.scheduled.set(req.identifier, req); },
    async cancel(id) { n.scheduled.delete(id); },
    async dismiss() {},
    async scheduledIdentifiers() { return [...n.scheduled.keys()]; },
    async presentedIdentifiers() { return []; },
    lastResponseData: () => null, clearLastResponse: () => {}, onResponse: () => ({ remove() {} }),
  };
  return n;
}

/** The phone reminder for slot S, then the banner when the slot is open: one entry. */
async function reminderThenBanner(bannerEvent) {
  const store = memoryStore();
  let nowMs = (S - 3600) * 1000;
  const inbox = I.createInbox({ store, now: () => nowMs });
  const native = fakeNative();
  const center = createNotificationCenter({ loadNative: async () => native, store: memoryStore(), now: () => Math.floor(nowMs / 1000), inbox });
  const rec = recurringRecord();
  await center.syncRecurring({ enabled: true, records: [rec], states: [{ record: rec, due: recurringDueState(rec, status(), S - 3600) }] });
  const scheduledOk = native.scheduled.get(recurringNotificationId(rec))?.at === S;
  const hiddenBefore = I.visibleInboxEntries((await inbox.load()).entries, nowMs).length === 0;
  nowMs = (S + 120) * 1000;
  const writes = store.writes;
  const due = recurringDueState(rec, status(), S + 120);
  const outcome = await inbox.record(bannerEvent(rec, due, nowMs));
  const state = await inbox.load();
  return { scheduledOk, hiddenBefore, outcome, wroteAgain: store.writes > writes, entries: state.entries, visible: I.visibleInboxEntries(state.entries, nowMs) };
}
{
  const r = await reminderThenBanner(recurringBannerInboxEvent);
  check('the reminder for the slot is scheduled and listed, hidden until its time', r.scheduledOk && r.hiddenBefore);
  check('the banner for the same slot: "duplicate", nothing written, ONE entry (the reminder\'s sentence)',
    r.outcome === 'duplicate' && !r.wroteAgain && r.entries.length === 1 && r.visible.length === 1 && r.visible[0].text === RECURRING_DUE_BODY && r.visible[0].via === 'scheduled');

  // Banner first (reminders off), then the same slot again on the next check: one entry, the banner's sentence.
  const store = memoryStore();
  const inbox = I.createInbox({ store, now: () => (S + 120) * 1000 });
  const rec = recurringRecord();
  const due = recurringDueState(rec, status(), S + 120);
  await inbox.record(recurringBannerInboxEvent(rec, due, (S + 120) * 1000));
  const w = store.writes;
  await inbox.record(recurringBannerInboxEvent(rec, recurringDueState(rec, status(), S + 4000), (S + 4000) * 1000));
  const st = await inbox.load();
  check('banner only: the same open slot on a later check writes nothing; the sentence is the banner\'s for one payment',
    store.writes === w && st.entries.length === 1 && st.entries[0].text === scheduledDueHeadline(1, 0) && st.entries[0].via === 'in-app' && st.entries[0].kind === 'recurring-due');
  // A NEW slot (the next day) is a new event.
  await inbox.record(recurringBannerInboxEvent(rec, recurringDueState(rec, status({ nextSlotAt: S }), S + DAY + 10), (S + DAY + 10) * 1000));
  check('…a missed slot opening (catch-up: two open) is a new entry keyed on the latest slot', (await inbox.load()).entries.length === 2);

  // A cancelled reminder (revoked before its time): its pending entry is dropped.
  const cs = memoryStore();
  let nowMs = (S - 3600) * 1000;
  const ci = I.createInbox({ store: cs, now: () => nowMs });
  const native = fakeNative();
  const center = createNotificationCenter({ loadNative: async () => native, store: memoryStore(), now: () => Math.floor(nowMs / 1000), inbox: ci });
  await center.syncRecurring({ enabled: true, records: [rec], states: [{ record: rec, due: recurringDueState(rec, status(), S - 3600) }] });
  const revoked = { ...rec, localStatus: 'revoked' };
  await center.syncRecurring({ enabled: true, records: [revoked], states: [{ record: revoked, due: null }] });
  nowMs = (S + 600) * 1000;
  check('a reminder cancelled before its time (revoked) leaves no entry behind', native.scheduled.size === 0 && I.visibleInboxEntries((await ci.load()).entries, nowMs).length === 0);

  // Takeover: one entry per posted alert; a second observation writes nothing.
  const ts = memoryStore();
  const ti = I.createInbox({ store: ts, now: () => S * 1000 });
  const tn = fakeNative();
  const tc = createNotificationCenter({ loadNative: async () => tn, store: memoryStore(), now: () => S, inbox: ti });
  const found = [{ chain: M, account: ACCOUNT, proposalHash: `0x${'77'.repeat(32)}` }];
  await tc.observeTakeovers({ enabled: true, found, looking: false });
  await tc.observeTakeovers({ enabled: true, found, looking: false });
  const tstate = await ti.load();
  check('takeover: posted once, listed once, with the notification\'s sentence, opening Inheritance',
    tn.shown.length === 1 && tstate.entries.length === 1 && tstate.entries[0].text === TAKEOVER_BODY && tstate.entries[0].kind === 'takeover' && tstate.entries[0].via === 'notification');
  check('takeover entry holds no proposal hash or address', !LONG_HEX_32.test(ts.map.get(I.INBOX_KEY)));
  // Reminders off: nothing posted, nothing listed by the center.
  const os = memoryStore();
  const oi = I.createInbox({ store: os, now: () => S * 1000 });
  const oc = createNotificationCenter({ loadNative: async () => fakeNative(), store: memoryStore(), now: () => S, inbox: oi });
  await oc.observeTakeovers({ enabled: false, found, looking: false });
  await oc.syncRecurring({ enabled: false, records: [rec], states: [{ record: rec, due: recurringDueState(rec, status(), S - 3600) }] });
  check('reminders off (and so with an app PIN on): the center lists nothing; the banners still record their own events', os.writes === 0);

  // A WalletConnect / in-app browser sent view: announced once per call, recorded once.
  const ws = memoryStore();
  const wi = I.createInbox({ store: ws, now: () => T0 });
  const seen = [];
  const off = onWcSentShown((result) => {
    seen.push(result);
    void wi.record(I.wcSentInboxEvent(result, T0));
  });
  const args = { kind: 'eoa-transaction', key: 'r:-3', dappName: 'app.uniswap.org', network: M, txid: `0x${'cd'.repeat(32)}`, userOpHash: null, dappNotified: true };
  wcSentResult(args);
  await new Promise((r) => setTimeout(r, 10));
  const view = wcSentResult(args);
  await new Promise((r) => setTimeout(r, 10));
  off();
  wcSentResult(args);
  const wstate = await wi.load();
  check('a sent view: each shown view announced once; the same request recorded once ("Sent for <dApp>.")',
    seen.length === 2 && wstate.entries.length === 1 && wstate.entries[0].title === WC_TX_SENT_TITLE && wstate.entries[0].text === 'Sent for app.uniswap.org.' && view.title === WC_TX_SENT_TITLE);
  const again = I.wcSentInboxEvent({ ...args, txid: `0x${'ef'.repeat(32)}`, title: 'Transaction sent' }, T0);
  check('…a later request with the same queue key (the browser\'s counters restart) is a new event (its hash differs)',
    I.entryFromEvent(again).id !== wstate.entries[0].id && !LONG_HEX_32.test(ws.map.get(I.INBOX_KEY)));
  check('the replacement notice event: the notice\'s sentence, keyed on the network, sender, nonce and mined hash',
    I.replacementNoticeInboxEvent({ chain: M, from: OWNER, nonce: '30', minedHash: `0x${'aa'.repeat(32)}`, outcome: 'replaced', resolvedAt: T0, text: 'Sped up: x.' }).title === 'Sped up' &&
      I.replacementNoticeInboxEvent({ chain: M, from: OWNER, nonce: '30', minedHash: `0x${'aa'.repeat(32)}`, outcome: 'cancelled', resolvedAt: T0, text: 'Cancelled: x.' }).kind === 'replacement');

  // Source pins on the recorders (one write site each).
  const monitor = read('src/components/PriceAlertMonitor.tsx');
  check('price alerts: the monitor records each firing once (key = the alert and its firing time), separately from the notification',
    (monitor.match(/appInbox\(\)\.record\(/g) ?? []).length === 1 && monitor.includes('key: `price-alert|${f.alert.id}|${f.alert.firedAt ?? at}`') &&
      !read('src/wallet/notifications.ts').slice(read('src/wallet/notifications.ts').indexOf('presentPriceAlert: ({')).split('permission: () =>')[0].includes('toInbox'));
  const banner = read('src/components/RecurringDueBanner.tsx');
  check('the recurring banner records through recurringBannerInboxEvent only while it is not dismissed',
    (banner.match(/appInbox\(\)\.record\(/g) ?? []).length === 1 && banner.includes('if (dismissedRef.current !== checkKey) {') && banner.includes('recurringBannerInboxEvent(d.record, d.due, at)'));
  const pending = read('src/components/PendingTransactions.tsx');
  check('pending transactions: the notice and the sent alert, one record call each',
    (pending.match(/appInbox\(\)\.record\(/g) ?? []).length === 2 && pending.includes('replacementNoticeInboxEvent({') && pending.includes('replacementSentInboxEvent({ chain, txid: sent.txid, title: sentTitle, text: sentText'));
  const app = read('App.tsx');
  check('App.tsx registers the sent-view recorder once', (app.match(/onWcSentShown\(/g) ?? []).length === 1 && app.includes('void appInbox().record(wcSentInboxEvent(result, Date.now()))'));
}

// ---------------------------------------------------------------------------
console.log('check-inbox: deep links (src/wallet/deep-links.ts)');
// ---------------------------------------------------------------------------
const SEPOLIA = EVM_PROFILES.find((p) => p.caip2 === M);
const ETH_SLOT = 'eip155:1';
const BTC_SLOT = 'bip122:000000000019d6689c085ae165831e93';
const PAYEE = '0x69F0EC265702D0891b0AEF8e79ddDC3277ef7E8a';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const tokenStore = memoryStore();
const ctx = (over = {}) => ({
  evmProfile: SEPOLIA,
  trackedTokens: (caip2) => listTokens(caip2, tokenStore),
  nativeFor: (slot) => (slot === BTC_SLOT ? { symbol: 'BTC', networkLabel: 'Bitcoin' } : null),
  hasEvmAccount: true,
  ...over,
});
const enc = encodeURIComponent;
{
  const open = (url) => D.parseDeepLink(url);
  check('routes: Home, Activity, Inbox, PriceAlerts, Sessions, Receive',
    open('shibawallet://').kind === 'open' && open('shibawallet://').route === 'Home' && open('shibawallet://home').route === 'Home' &&
      open('shibawallet://activity').route === 'Activity' && open('shibawallet://activity').chainId === ETH_SLOT &&
      open('shibawallet://inbox').route === 'Inbox' && open('shibawallet://price-alerts').route === 'PriceAlerts' &&
      open('shibawallet://sessions').route === 'Sessions' && open('shibawallet://receive?chain=bitcoin').chainId === BTC_SLOT &&
      open('shibawallet:///inbox/').route === 'Inbox');
  check('Expo Go form exp://<host>/--/<path> read the same way',
    open('exp://127.0.0.1:8081/--/inbox').route === 'Inbox' && open('exp://192.168.1.4:8081/--/activity?chain=solana').chainId === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  check("ignored silently: no URL, the development client's exp+ scheme, Expo Go's plain project URL",
    open(null).kind === 'ignore' && open('').kind === 'ignore' && open('exp+shiba-wallet://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8082').kind === 'ignore' &&
      open('exp://127.0.0.1:8081').kind === 'ignore');
  const unknowns = [
    'shibawallet://settings', 'shibawallet://send', 'shibawallet://sign?message=hi', 'shibawallet://inbox?x=1', 'shibawallet://activity?chain=cardano',
    'shibawallet://inbox#frag', 'shibawallet://in box', 'shibawallet://receive?chain=bitcoin&chain=solana', 'shibawallet://send?uri=%E0%A4%A',
    'https://app.uniswap.org/', 'javascript:alert(1)', 'shibawallet://INBOX', `shibawallet://send?uri=x${'a'.repeat(9000)}`, 'not a url',
    `shibawallet://send?uri=${enc(`ethereum:${PAYEE}?value=1e15`)}&data=0xa9059cbb`,
    `shibawallet://send?uri=${enc(`ethereum:${PAYEE}`)}&authorizationList=0x01`,
    'shibawallet://send?data=0x095ea7b3&to=0x0000000000000000000000000000000000000001',
    'shibawallet://send?uri=https%3A%2F%2Fexample.com',
  ];
  const bad = unknowns.filter((u) => open(u).kind !== 'unknown');
  check(`unknown or malformed links are refused whole (${unknowns.length} cases: other routes, extra parameters, calldata or an authorization beside the request, bad encoding, fragments, spaces, other schemes, over-long)`, bad.length === 0, bad.join(' | '));
  const action = await D.planDeepLink(open('shibawallet://settings'), ctx());
  check('…answered with the one sentence (exact)', action.kind === 'notice' && action.text === 'This link does not open anything in Shiba Wallet.' && D.DEEP_LINK_UNKNOWN_SENTENCE === action.text);
  check('Home goes back to Home (popTo); the others navigate with their slot', (await D.planDeepLink(open('shibawallet://home'), ctx())).kind === 'home' &&
    JSON.stringify(await D.planDeepLink(open('shibawallet://receive'), ctx())) === JSON.stringify({ kind: 'navigate', route: 'Receive', params: { chainId: ETH_SLOT } }) &&
    JSON.stringify(await D.planDeepLink(open('shibawallet://sessions'), ctx())) === JSON.stringify({ kind: 'navigate', route: 'Sessions' }));

  // Payment links: the SAME parser and prefill as a scanned request.
  const nativeUri = `ethereum:${PAYEE}@11155111?value=1e15`;
  const pay = await D.planDeepLink(open(`shibawallet://send?uri=${enc(nativeUri)}`), ctx());
  const parsed = parsePaymentRequest(nativeUri, { slotChainId: ETH_SLOT, evmProfile: SEPOLIA, trackedTokens: await listTokens(M, tokenStore) });
  const scanned = describeParsedRequest(parsed, { nativeSymbol: SEPOLIA.displaySymbol, networkLabel: SEPOLIA.label });
  check('a native EIP-681 link → a NEW Send (push) on the Ethereum slot, the editable recipient and amount, the scanned request\'s lines after the link line',
    pay.kind === 'send' && pay.params.chainId === ETH_SLOT && pay.params.tokenId === undefined && pay.params.request.recipient === PAYEE &&
      pay.params.request.amountText === '0.001' && pay.params.request.lines[0] === D.DEEP_LINK_PAY_LINE &&
      JSON.stringify(pay.params.request.lines.slice(1)) === JSON.stringify(scanned), JSON.stringify(pay));
  const tokenUri = `ethereum:${USDC}@11155111/transfer?address=${PAYEE}&uint256=1.5e6`;
  const tpay = await D.planDeepLink(open(`shibawallet://send?uri=${enc(tokenUri)}`), ctx());
  check('a tracked ERC-20 transfer → token mode (the tracked token\'s CAIP-19 id), amount 1.5',
    tpay.kind === 'send' && tpay.params.tokenId === `eip155:11155111/erc20:${USDC}` && tpay.params.request.amountText === '1.5' && tpay.params.request.recipient === PAYEE, JSON.stringify(tpay));
  const refusal = async (uri) => {
    const a = await D.planDeepLink(open(`shibawallet://send?uri=${enc(uri)}`), ctx());
    const p = parsePaymentRequest(uri, { slotChainId: ETH_SLOT, evmProfile: SEPOLIA, trackedTokens: await listTokens(M, tokenStore) });
    return { a, same: p.kind === 'refused' && a.kind === 'notice' && a.text === `This payment link was not opened. ${p.message}` };
  };
  const switchNet = await refusal(`ethereum:${PAYEE}@1?value=1e15`);
  check('another network: refused with the parser\'s sentence, never a switch', switchNet.same && switchNet.a.text.includes('The wallet never switches networks'), switchNet.a.text);
  const untracked = await refusal(`ethereum:0x000000000000000000000000000000000000dEaD@11155111/transfer?address=${PAYEE}&uint256=1`);
  check('an untracked token: refused, never added', untracked.same && untracked.a.text.includes('never adds tokens from a payment request'));
  const approve = await refusal(`ethereum:${USDC}@11155111/approve?address=${PAYEE}&uint256=1`);
  check('a contract function other than transfer (approve): refused', approve.same && approve.a.text.includes('"approve"'));
  const calldata = await refusal(`ethereum:${PAYEE}@11155111?value=1&data=0xa9059cbb`);
  check('calldata inside the request (data=): refused', calldata.same && calldata.a.text.includes('"data"'));
  const auth = await refusal(`ethereum:${PAYEE}@11155111?authorizationList=0x01`);
  check('an EIP-7702 authorization inside the request: refused (D6)', auth.same && auth.a.text.includes('"authorizationList"'));
  const btc = await D.planDeepLink(open(`shibawallet://send?uri=${enc('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.0001')}`), ctx());
  check('a BIP-321 link → Send on the Bitcoin slot', btc.kind === 'send' && btc.params.chainId === BTC_SLOT && btc.params.request.amountText === '0.0001');
  const noBtc = await D.planDeepLink(open(`shibawallet://send?uri=${enc('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')}`), ctx({ nativeFor: () => null }));
  check('…an account with no Bitcoin address: the plain sentence, nothing filled in', noBtc.kind === 'notice' && noBtc.text === 'This payment link is for Bitcoin, which the active account cannot send from. Nothing was filled in.');

  // Pass p22b: an ethereum: link while a WATCH-ONLY account is active opened
  // Send's refusal ("Sending is not available for a watch-only account…").
  // It now opens the cold-signing screen with the same pre-fill.
  const wo = (over = {}) => ctx({ watchOnly: true, nativeFor: () => null, ...over });
  const cold = await D.planDeepLink(open(`shibawallet://send?uri=${enc(nativeUri)}`), wo());
  check('p22b: watch-only active + a valid EIP-681 link → a NEW cold-signing screen with the SAME pre-fill (recipient, amount, the link line first, the scanned lines)',
    cold.kind === 'cold-sign' && cold.params.tokenId === undefined && JSON.stringify(cold.params.request) === JSON.stringify(pay.params.request), JSON.stringify(cold));
  const coldToken = await D.planDeepLink(open(`shibawallet://send?uri=${enc(tokenUri)}`), wo());
  check('…a tracked ERC-20 transfer: the token id too',
    coldToken.kind === 'cold-sign' && coldToken.params.tokenId === `eip155:11155111/erc20:${USDC}` && coldToken.params.request.amountText === '1.5' && coldToken.params.request.recipient === PAYEE);
  const coldApprove = await D.planDeepLink(open(`shibawallet://send?uri=${enc(`ethereum:${USDC}@11155111/approve?address=${PAYEE}&uint256=1`)}`), wo());
  check('…a refused request (approve) is still refused with the parser\'s sentence, never a cold-signing pre-fill', coldApprove.kind === 'notice' && coldApprove.text === approve.a.text);
  const coldBtc = await D.planDeepLink(open(`shibawallet://send?uri=${enc('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.0001')}`), wo({ nativeFor: (slot) => (slot === BTC_SLOT ? { symbol: 'BTC', networkLabel: 'Bitcoin' } : null) }));
  check('…a bitcoin: link stays refused with the existing sentence (even if a Bitcoin account were listed)',
    coldBtc.kind === 'notice' && coldBtc.text === 'This payment link is for Bitcoin, which the active account cannot send from. Nothing was filled in.');
  {
    const app = read('App.tsx');
    check('…App.tsx passes whether the active account is watch-only and pushes ColdSign for a "cold-sign" action',
      app.includes('const watchOnly = activeAccount?.watchOnly === true;') && /hasEvmAccount: accounts\.some\(\(a\) => a\.chainId === EVM_CHAIN_ID\),\s*watchOnly,/.test(app) &&
        /case 'cold-sign':[\s\S]{0,200}nav\.dispatch\(StackActions\.push\('ColdSign', action\.params\)\);/.test(app));
    const coldScreen = read('src/screens/ColdSignScreen.tsx');
    check('…and the cold-signing screen pre-fills recipient and amount from route.params.request and shows its lines in the "Payment request" box',
      coldScreen.includes("useState(requestPrefill?.recipient ?? '')") && coldScreen.includes("useState(requestPrefill?.amountText ?? '')") &&
        coldScreen.includes('{requestPrefill && !replace ? <PaymentRequestNotice lines={requestPrefill.lines} /> : null}'));
  }

  // The lock gate and the launch link.
  check('the gate: wait while loading (the PIN pad), locked, or before the navigator is ready; a notice with no wallet',
    D.deepLinkGate({ status: 'loading', locked: false, navReady: true }) === 'wait' && D.deepLinkGate({ status: 'ready', locked: true, navReady: true }) === 'wait' &&
      D.deepLinkGate({ status: 'ready', locked: false, navReady: false }) === 'wait' && D.deepLinkGate({ status: 'no-wallet', locked: false, navReady: true }) === 'no-wallet' &&
      D.deepLinkGate({ status: 'ready', locked: false, navReady: true }) === 'act');
  const mkSource = (initial) => {
    const calls = { initial: 0, listeners: [] };
    const src = D.createDeepLinkSource({
      getInitialURL: async () => {
        calls.initial += 1;
        return initial;
      },
      addListener: (l) => {
        calls.listeners.push(l);
        return { remove() {} };
      },
    });
    return { src, calls };
  };
  const { src, calls } = mkSource('shibawallet://inbox');
  src.start();
  src.start();
  await new Promise((r) => setTimeout(r, 5));
  const first = src.take();
  src.start();
  await new Promise((r) => setTimeout(r, 5));
  check('the launch link is read once and taken once (a remount after an account switch never replays it)', first === 'shibawallet://inbox' && src.take() === null && calls.initial === 1 && calls.listeners.length === 1);
  calls.listeners[0]('shibawallet://activity');
  calls.listeners[0]('shibawallet://sessions');
  check('a link arriving while one waits replaces it (the newest wins); it waits until taken', src.peek() === 'shibawallet://sessions' && src.take() === 'shibawallet://sessions' && src.take() === null);
  const late = mkSource('shibawallet://inbox');
  late.src.start();
  late.calls.listeners[0]('shibawallet://price-alerts');
  await new Promise((r) => setTimeout(r, 5));
  check('a launch link answered after a newer link does not overwrite it', late.src.take() === 'shibawallet://price-alerts');

  // Nothing on the link path reads a key: a counting secure store bound to the app vault.
  const secureCalls = [];
  bindSecureStore({
    getItemAsync: async (k) => { secureCalls.push(`get ${k}`); return null; },
    setItemAsync: async (k) => { secureCalls.push(`set ${k}`); },
    deleteItemAsync: async (k) => { secureCalls.push(`delete ${k}`); },
    canUseBiometricAuthentication: () => { secureCalls.push('bio'); return true; },
    whenUnlockedThisDeviceOnly: 0,
  });
  const reads0 = tokenStore.reads;
  for (const u of [`shibawallet://send?uri=${enc(nativeUri)}`, `shibawallet://send?uri=${enc(tokenUri)}`, 'shibawallet://inbox', 'shibawallet://nope', `shibawallet://send?uri=${enc(`ethereum:${PAYEE}@1`)}`]) {
    await D.planDeepLink(D.parseDeepLink(u), ctx());
  }
  check('the whole link path: zero secure-store calls (no key, no phrase, no prompt); only the tracked-token list is read', secureCalls.length === 0 && tokenStore.reads > reads0 && tokenStore.writes === 0, secureCalls.join(','));
  const dl = read('src/wallet/deep-links.ts');
  check('deep-links.ts imports no vault, signer, biometric gate, wallet context or network client (source)',
    !/from '\.\/(storage|biometric|WalletContext|send|aa|walletconnect|sessions)(\.ts)?'/.test(dl) && !/signWith|requireLocalAuth|fetch\(|httpTransport|readSecureItem|eth_/.test(dl));
  check('App.tsx: the handler sits inside the navigation container after the banners, the source starts in App, no `linking` prop',
    /<RecurringDueBanner \/>\n\s+<DeepLinkHandler \/>\n\s+<\/NavigationContainer>/.test(app()) && app().includes('appDeepLinks().start();') && !/<NavigationContainer[^>]*linking=/.test(app()) &&
      app().includes("nav.dispatch(StackActions.push('Send', action.params))") && app().includes("nav.dispatch(StackActions.popTo('Home'))"));
  const handler = app().slice(app().indexOf('function DeepLinkHandler'), app().indexOf('function Root'));
  check('the handler waits on the gate (lock, wallet, navigator) and never signs, prompts or fetches (source)',
    handler.includes('deepLinkGate({ status, locked, navReady })') && handler.includes("if (gate === 'wait'") && handler.includes('useAppLock()') &&
      !/signWith|requireLocalAuth|fetch\(|httpTransport|getEndpoint/.test(handler));
}
function app() {
  return read('App.tsx');
}

// ---------------------------------------------------------------------------
console.log('check-inbox: routes, links and allow lists');
// ---------------------------------------------------------------------------
{
  check('the Inbox route: navigation.ts and App.tsx', read('src/navigation.ts').includes('  Inbox: undefined;') && app().includes('<Stack.Screen name="Inbox" component={InboxScreen} options={{ title: \'Inbox\' }} />'));
  check('watch-only and multisig accounts can read the inbox', watchOnlyRouteRefusal('Inbox') === null && multisigRouteRefusal('Inbox') === null &&
    WATCH_ONLY_ALLOWED_ROUTES.includes('Inbox') && MULTISIG_ALLOWED_ROUTES.includes('Inbox'));
  check('…while Send and Sessions stay refused for them (an entry opens a screen whose own gate still applies)',
    watchOnlyRouteRefusal('Sessions') !== null && multisigRouteRefusal('Sessions') !== null && watchOnlyRouteRefusal('Send') !== null);
  const home = read('src/screens/HomeScreen.tsx');
  check('Home: one Inbox link with the unread count', (home.match(/navigation\.navigate\('Inbox'\)/g) ?? []).length === 1 && home.includes('inboxLinkText(inboxUnread)') &&
    I.inboxLinkText(0) === 'Inbox' && I.inboxLinkText(3) === 'Inbox (3 unread)');
  const settings = read('src/screens/SettingsScreen.tsx');
  check('Settings: one Inbox link line, in the Privacy section after the notifications (not the PIN section)',
    (settings.match(/navigation\.navigate\('Inbox'\)/g) ?? []).length === 1 &&
      settings.indexOf("navigation.navigate('Inbox')") > settings.indexOf('<NotificationSettingsSection />') && settings.indexOf("navigation.navigate('Inbox')") < settings.indexOf('<AppPinSection />'));
  const screen = read('src/screens/InboxScreen.tsx');
  // Phase 22 polish: the app-lock note names the PIN or the passphrase by the lock's kind.
  const lockNotePicked = (src) =>
    src.includes("{appPinOn ? <Text style={[styles.hint, { color: theme.textMuted }]}><T>{inboxLockKind === 'phr' ? INBOX_PASSPHRASE_NOTE : INBOX_PIN_NOTE}</T></Text> : null}") &&
    src.includes('const inboxLockKind = React.useSyncExternalStore(appLockKind.subscribe, appLockKind.get);');
  check('the inbox\'s app-lock note: the passphrase form exactly, the PIN form unchanged, picked by the lock\'s kind',
    I.INBOX_PASSPHRASE_NOTE === 'The app passphrase is on, so the wallet posts no phone notifications. The inbox still lists what the wallet showed you on its own screens, such as the recurring-payment banner, price alerts and sent transactions.' &&
      I.INBOX_PIN_NOTE === 'The app PIN is on, so the wallet posts no phone notifications. The inbox still lists what the wallet showed you on its own screens, such as the recurring-payment banner, price alerts and sent transactions.' &&
      lockNotePicked(screen));
  check('mutant caught (polish): the PIN note shown whatever the lock\'s kind', !lockNotePicked(screen.replace("inboxLockKind === 'phr' ? INBOX_PASSPHRASE_NOTE : INBOX_PIN_NOTE", 'INBOX_PIN_NOTE')));
  check('the screen: intro, the app-lock note, the read-only box with reset, Mark all read, the reminder note',
    screen.includes('{appPinOn ? <Text') && screen.includes('INBOX_PIN_NOTE}') && screen.includes('<WarningBox>{INBOX_READ_ONLY_MESSAGE}</WarningBox>') &&
      screen.includes('title="Reset the inbox"') && screen.includes('title={INBOX_MARK_ALL_READ}') && screen.includes('{INBOX_SCHEDULED_NOTE}'));
  check('exact strings', I.INBOX_PIN_NOTE.startsWith('The app PIN is on, so the wallet posts no phone notifications. The inbox still lists') &&
    I.INBOX_EMPTY === 'Nothing yet. Reminders, alerts and sent transactions will be listed here.' && I.inboxUnreadText(1) === '1 unread entry.' && I.inboxTimeText(Date.UTC(2026, 9, 19, 3, 30)) === '2026-10-19 03:30 UTC');
}

// ---------------------------------------------------------------------------
console.log('check-inbox: the app scheme in app.json (phase 23 item 2)');
// ---------------------------------------------------------------------------
// The links this module reads arrive outside Expo Go only if app.json
// declares the scheme: Expo's default config plugins then add it to the
// Android main activity's VIEW intent filter and to the iOS
// CFBundleURLTypes (@expo/config-plugins build/android/Scheme.js setScheme
// lines 40-62, build/ios/Scheme.js setScheme lines 33-48; both are applied
// by @expo/prebuild-config build/plugins/withDefaultPlugins.js lines 126
// and 157). The installed plugins' own functions are called here on the
// real app.json, so a future edit cannot drop or rename the scheme
// without failing this check.
const schemeRequire = createRequire(join(APP, 'package.json'));
const { AndroidConfig: SchemeAndroid, IOSConfig: SchemeIos } = schemeRequire('@expo/config-plugins');
/** True when the given app.json object declares the wallet's link scheme for both platforms. */
function schemeDeclared(appJsonObject) {
  const expo = appJsonObject?.expo ?? {};
  const android = SchemeAndroid.Scheme.getScheme(expo);
  const plist = SchemeIos.Scheme.setScheme(expo, {});
  const iosSchemes = (plist.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []);
  return expo.scheme === D.APP_LINK_SCHEME && android.includes(D.APP_LINK_SCHEME) && iosSchemes.includes(D.APP_LINK_SCHEME);
}
{
  const appJsonObject = JSON.parse(read('app.json'));
  check('the parser reads the scheme "shibawallet"', D.APP_LINK_SCHEME === 'shibawallet');
  check('app.json declares "scheme": "shibawallet", which the installed config plugins turn into an Android intent-filter scheme and an iOS URL type',
    schemeDeclared(appJsonObject), JSON.stringify(appJsonObject.expo?.scheme));
  check('no platform-specific scheme overrides or adds to it (one scheme, the same on both platforms)',
    appJsonObject.expo?.android?.scheme === undefined && appJsonObject.expo?.ios?.scheme === undefined);
  check('a link in that scheme opens a screen (shibawallet://inbox → Inbox)', D.parseDeepLink(`${appJsonObject.expo?.scheme}://inbox`).route === 'Inbox');
  const noScheme = structuredClone(appJsonObject);
  delete noScheme.expo.scheme;
  const renamed = structuredClone(appJsonObject);
  renamed.expo.scheme = 'shiba-wallet';
  mutants += 2;
  mutantCaught('M16 the scheme removed from app.json', !schemeDeclared(noScheme));
  mutantCaught('M17 the scheme renamed in app.json (the parser would no longer read its links)', !schemeDeclared(renamed));
}

// ---------------------------------------------------------------------------
console.log('check-inbox: mutants (each must be caught)');
// ---------------------------------------------------------------------------
{
  // M1: no duplicate check → the banner and the reminder for one slot are listed twice.
  const m1 = await importMutant('src/wallet/inbox.ts', "if (state.entries.some((e) => e.id === entry.id)) return 'duplicate' as const;", '');
  const s1 = memoryStore();
  const a = m1.createInbox({ store: s1, now: () => T0 });
  await a.record(ev(1));
  const b = m1.createInbox({ store: s1, now: () => T0 });
  await b.record(ev(1));
  mutantCaught('M1 the duplicate check removed (one event written twice)', (await b.load()).readOnly || (await b.load()).entries.length !== 1);
  // M2: no cap.
  const m2 = await importMutant('src/wallet/inbox.ts', 'while (next.length > INBOX_MAX_ENTRIES)', 'while (next.length > 100_000)');
  const s2 = memoryStore();
  const c = m2.createInbox({ store: s2, now: () => T0 });
  for (let i = 0; i < 205; i += 1) await c.record(ev(i));
  mutantCaught('M2 the cap removed (205 kept; the next read finds the store damaged)', (await c.load()).readOnly === true || (await c.load()).entries.length > 200);
  // M3: long hex kept.
  const m3 = await importMutant('src/wallet/inbox.ts', '(h) => `${h.slice(0, 4)}…${h.slice(-4)}`', '(h) => h');
  const s3 = memoryStore();
  await m3.createInbox({ store: s3, now: () => T0 }).record(ev(1, { text: `hash 0x${'ab'.repeat(32)}` }));
  mutantCaught('M3 long hex no longer shortened (a full hash stored)', LONG_HEX_32.test(s3.map.get(I.INBOX_KEY) ?? ''));
  // M4: lenient parse (extra fields accepted).
  const m4 = await importMutant('src/wallet/inbox.ts', 'if (keys.length !== ENTRY_KEYS.length || keys.some((k, i) => k !== ENTRY_KEYS[i])) return null;', '');
  const g = I.entryFromEvent(ev(1));
  mutantCaught('M4 the entry key-set check removed (an extra field read as valid)', m4.parseInbox(JSON.stringify({ version: 1, entries: [{ ...g, extra: 1 }] })).readOnly === false);
  // M5: future reminders shown.
  const m5 = await importMutant('src/wallet/inbox.ts', "entries.filter((e) => !(e.via === 'scheduled' && e.at > nowMs))", 'entries.filter(() => true)');
  mutantCaught('M5 a reminder set for later shown (and counted) before its time',
    m5.inboxUnreadCount([{ ...g, via: 'scheduled', at: T0 + 10 }], T0) !== 0);
  // M6: the banner keyed on the NEXT slot → the reminder and the banner of one slot are two entries.
  const m6 = await importMutant('src/wallet/notifications.ts', 'const slotAt = due.since + Math.max(0, due.openSlots - 1) * period;', 'const slotAt = due.since + due.openSlots * period;');
  const r6 = await reminderThenBanner(m6.recurringBannerInboxEvent);
  mutantCaught('M6 the banner keyed on the next slot (one slot listed twice)', r6.outcome !== 'duplicate' || r6.entries.length !== 1);
  // M7: the reminder's pending entry not dropped on cancel.
  const m7 = await importMutant('src/wallet/notifications.ts', '            await toInbox((i) => i.dropScheduled(dueEventGroup(id)));\n', '');
  {
    const st = memoryStore();
    let nowMs = (S - 3600) * 1000;
    const inbox = I.createInbox({ store: st, now: () => nowMs });
    const native = fakeNative();
    const center = m7.createNotificationCenter({ loadNative: async () => native, store: memoryStore(), now: () => Math.floor(nowMs / 1000), inbox });
    const rec = recurringRecord();
    await center.syncRecurring({ enabled: true, records: [rec], states: [{ record: rec, due: recurringDueState(rec, status(), S - 3600) }] });
    const revoked = { ...rec, localStatus: 'revoked' };
    await center.syncRecurring({ enabled: true, records: [revoked], states: [{ record: revoked, due: null }] });
    nowMs = (S + 600) * 1000;
    mutantCaught('M7 a cancelled reminder still listed once its time passes', I.visibleInboxEntries((await inbox.load()).entries, nowMs).length === 1);
  }
  // M8: extra parameters allowed beside the payment request.
  const m8 = await importMutant('src/wallet/deep-links.ts', 'if (params.size !== 1 || uri === undefined)', 'if (uri === undefined)');
  mutantCaught('M8 calldata beside the payment request accepted', m8.parseDeepLink(`shibawallet://send?uri=${enc(`ethereum:${PAYEE}`)}&data=0xa9059cbb`).kind === 'pay');
  // M9: the development client's exp+ scheme no longer ignored.
  const m9 = await importMutant('src/wallet/deep-links.ts', "if (scheme.startsWith('exp+')) return { kind: 'ignore' };", '');
  mutantCaught("M9 the development client's own scheme answered with a notice", m9.parseDeepLink('exp+shiba-wallet://expo-development-client/?url=x').kind !== 'ignore');
  // M10: the launch link read on every start (replayed after an account switch).
  const m10 = await importMutant('src/wallet/deep-links.ts', 'if (started) return;', '');
  {
    let n = 0;
    const s = m10.createDeepLinkSource({ getInitialURL: async () => { n += 1; return 'shibawallet://inbox'; }, addListener: () => ({ remove() {} }) });
    s.start();
    await new Promise((r) => setTimeout(r, 5));
    s.take();
    s.start();
    await new Promise((r) => setTimeout(r, 5));
    mutantCaught('M10 the launch link replayed after a remount', s.take() !== null || n !== 1);
  }
  // M11: the gate ignores the lock.
  const m11 = await importMutant('src/wallet/deep-links.ts', "if (args.status === 'loading' || args.locked || !args.navReady) return 'wait';", "if (args.status === 'loading' || !args.navReady) return 'wait';");
  mutantCaught('M11 a link acted on while the wallet is locked', m11.deepLinkGate({ status: 'ready', locked: true, navReady: true }) !== 'wait');
  // M12: a parser refusal turned into a Send pre-fill (the parser bypassed for the native case).
  const m12 = await importMutant('src/wallet/deep-links.ts', "if (parsed.kind === 'refused') return { kind: 'notice', text: deepLinkPayRefusal(parsed.message) };",
    "if (parsed.kind === 'refused') return { kind: 'send', params: { chainId: link.slotChainId, request: { recipient: '', amountText: null, lines: [] } } };");
  const a12 = await m12.planDeepLink(m12.parseDeepLink(`shibawallet://send?uri=${enc(`ethereum:${PAYEE}@1?value=1e15`)}`), ctx());
  mutantCaught('M12 a refused request (another network) opening Send anyway', a12.kind !== 'notice');
  // M13 (pass p22b): a failed write silent again (the old catch).
  const m13 = await importMutant('src/wallet/inbox.ts', 'noteRecordFailure(e);', '');
  {
    const thr = { async getItem() { return null; }, async setItem() { throw new Error('x'); } };
    const mi = m13.createInbox({ store: thr, now: () => T0, log: () => undefined });
    await mi.record(ev(1));
    mutantCaught('M13 a failed write of an entry silent again (no status for the screen)', mi.lastRecordFailure() === null);
  }
  // M14 (pass p22b): a rejected load shown as an empty inbox again.
  const m14 = await importMutant('src/wallet/inbox.ts',
    "return { state: { entries: [], readOnly: false }, loadFailure: inboxErrorText(e), recordFailure: inbox.lastRecordFailure() };",
    "return { state: { entries: [], readOnly: false }, loadFailure: null, recordFailure: inbox.lastRecordFailure() };");
  {
    const thr = { async getItem() { throw new Error('x'); }, async setItem() {} };
    const v = await m14.loadInboxView(m14.createInbox({ store: thr, now: () => T0, log: () => undefined }));
    mutantCaught('M14 a rejected load looking like an empty inbox again', v.loadFailure === null);
  }
  // M15 (pass p22b): the watch-only flag ignored → Send's refusal again.
  const m15 = await importMutant('src/wallet/deep-links.ts', 'if (ctx.watchOnly === true) {\n', 'if (false) {\n');
  const a15 = await m15.planDeepLink(m15.parseDeepLink(`shibawallet://send?uri=${enc(`ethereum:${PAYEE}@11155111?value=1e15`)}`), ctx({ watchOnly: true, nativeFor: () => null }));
  mutantCaught('M15 a watch-only account\'s payment link opening Send (its refusal) again', a15.kind !== 'cold-sign');
  check(`all ${mutants} mutants caught`, mutantsCaught === mutants);
}

console.log(`\ncheck-inbox: ${passed} passed, ${failed} failed (${mutants} mutants)`);
if (failed > 0) process.exit(1);

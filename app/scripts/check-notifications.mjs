// Local reminders (phase 17 item 2), entirely OFFLINE: the preference
// (src/config/prefs.ts), the planning and the controller in
// src/wallet/notifications.ts driven through a fake of the native layer
// (permission state, Android channels, a scheduled-request map keyed by
// identifier as the installed library keeps it), the read helpers added to
// recurring.ts and inheritance.ts, the lock-screen content rule as a
// property check over generated records, and the wiring (App.tsx,
// SettingsScreen.tsx, the import rule that keeps expo-notifications' push
// code and its Expo Go throw out of the bundle; source checks).
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-notifications.mjs

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serializeSessionKeyGrant } from '@shiba-wallet/chains-evm';
import { DEFAULT_PREFS, loadPrefs, savePrefs } from '../src/config/prefs.ts';
import {
  CHANNEL_PAYMENTS,
  CHANNEL_SECURITY,
  NOTIFICATIONS_DENIED_TEXT,
  NOTIFICATIONS_LIMITS_NOTE,
  NOTIFICATIONS_PRIVACY_NOTE,
  NOTIFICATIONS_SECTION_TITLE,
  NOTIFICATIONS_STORE_KEY,
  NOTIFICATIONS_SWITCH_LABEL,
  NOTIFICATIONS_WHAT_NOTE,
  NOTIFICATION_ID_PREFIX,
  RECURRING_DUE_BODY,
  RECURRING_DUE_TITLE,
  RECURRING_ID_PREFIX,
  TAKEOVER_BODY,
  TAKEOVER_ID_PREFIX,
  TAKEOVER_TITLE,
  createNotificationCenter,
  describeNotificationsStatus,
  planRecurringSync,
  planTakeoverAlerts,
  recurringDueContent,
  recurringNotificationId,
  recurringReminderAt,
  screenFromNotificationData,
  takeoverContent,
  takeoverNotificationId,
} from '../src/wallet/notifications.ts';
import { loadSessions, saveSessionRecord } from '../src/wallet/sessions.ts';
import { buildSubscription, subscriptionTokenChoices } from '../src/wallet/subscriptions.ts';
import {
  findDueRecurringPayments,
  readRecurringDueStates,
  recurringDueState,
  recurringEndsAt,
  recurringGrantFor,
  recurringMeta,
} from '../src/wallet/recurring.ts';
import { INHERITANCE_STORE_KEY, listFoundTakeoverApprovals } from '../src/wallet/inheritance.ts';

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

const appDir = new URL('..', import.meta.url).pathname;
const read = (rel) => readFileSync(join(appDir, rel), 'utf8');

function memoryStore() {
  const map = new Map();
  return {
    map,
    async getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
  };
}

const M = 'eip155:11155111';
const OWNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ACCOUNT = '0xB67b8b7cCA718EAC64d2b59ba568585A9FC69a42';
const SESSION_KEY = '0x484B87B8D4D73d88ccF7D39C006cC1b078384640';
const DAY = 86_400;
const S = 1_800_000_000;

/** Deterministic pseudo-random numbers (no Math.random: the run is reproducible). */
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}
const rand = rng(20261010);
const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const randomAddress = () => `0x${hex(40)}`;

const choices = subscriptionTokenChoices(M, 'test ETH');

/** A real recurring record (the same builders as the Sessions screen), as stored after a confirmed set-up. */
function recurringRecord({
  payee = '0x69F0EC265702D0891b0AEF8e79ddDC3277ef7E8a',
  amount = '0.0001',
  periodSeconds = DAY,
  payments = '3',
  start = S,
  permissionId = `0x${hex(8)}`,
  label = 'Recurring payment',
  choice = choices[0],
  account = ACCOUNT,
  owner = OWNER,
  localStatus = 'installed',
  keyHeld = true,
} = {}) {
  const sub = buildSubscription(
    { merchant: payee, choice, amount, periodSeconds, payments, feeBudget: '0.01', label: 'Terms' },
    { now: start, account, testnet: true },
  );
  const grant = recurringGrantFor(sub, SESSION_KEY, { account, now: start });
  return {
    chain: M,
    account,
    owner,
    accountIndex: 0,
    accountKind: 'kernel-v3.3',
    permissionId: permissionId.toLowerCase(),
    policyCount: 4,
    grant: serializeSessionKeyGrant(grant),
    label,
    source: 'recurring',
    dappUrl: null,
    createdAt: start * 1000,
    installMode: 'explicit',
    keyHeld,
    installUserOpHash: null,
    revokeUserOpHash: null,
    localStatus,
    subscription: recurringMeta(sub, choice),
  };
}

/** A status as readSubscriptionStatus returns it (only the fields recurringDueState reads). */
function status(over = {}) {
  return {
    kind: 'ok',
    state: { rateLimitStatus: 'live', remainingPulls: 3, nextSlotAt: S, intervalSeconds: DAY, feeBudgetLeftWei: 10n ** 16n, validUntil: S + 4 * DAY, ...over },
    next: { kind: 'now' },
  };
}

/**
 * A fake of the native layer. Scheduled requests live in a Map keyed by
 * identifier (the installed library stores them that way:
 * SharedPreferencesNotificationsStore on Android, and a request with the
 * same identifier replaces the earlier one), `shown` collects every
 * presentation, `log` the call order.
 */
function fakeNative({ permission = { granted: false, canAskAgain: true }, grantOnRequest = true, platform = 'android' } = {}) {
  const n = {
    platform,
    perm: { ...permission },
    scheduled: new Map(),
    shown: [],
    channels: new Map(),
    log: [],
    requests: 0,
    async getPermission() {
      n.log.push('getPermission');
      return { ...n.perm };
    },
    async requestPermission() {
      n.log.push('requestPermission');
      n.requests += 1;
      n.perm = grantOnRequest ? { granted: true, canAskAgain: true } : { granted: false, canAskAgain: false };
      return { ...n.perm };
    },
    async ensureChannels(list) {
      n.log.push('ensureChannels');
      for (const c of list) n.channels.set(c.id, c);
    },
    async schedule(req) {
      n.log.push(`schedule:${req.identifier}`);
      if (req.at === null) n.shown.push(req);
      else n.scheduled.set(req.identifier, req);
    },
    async cancel(id) {
      n.log.push(`cancel:${id}`);
      n.scheduled.delete(id);
    },
    async dismiss() {},
    async scheduledIdentifiers() {
      return [...n.scheduled.keys()];
    },
    lastResponseData: () => null,
    clearLastResponse: () => {},
    onResponse: () => ({ remove() {} }),
  };
  return n;
}

function centerWith(native, { store = memoryStore(), now = () => S, failLoads = 0 } = {}) {
  const counter = { loads: 0, failLoads };
  const center = createNotificationCenter({
    loadNative: async () => {
      counter.loads += 1;
      if (counter.failLoads > 0) {
        counter.failLoads -= 1;
        throw new Error("Cannot find native module 'ExpoNotificationScheduler'");
      }
      return native;
    },
    store,
    now,
  });
  return { center, counter, store };
}

// ---------------------------------------------------------------------------
console.log('check-notifications: the preference (default OFF)');
// ---------------------------------------------------------------------------
{
  check('DEFAULT_PREFS.notifications is false', DEFAULT_PREFS.notifications === false);
  const fresh = memoryStore();
  check('nothing stored: off', (await loadPrefs(fresh)).notifications === false);
  for (const [label, stored] of [['"yes"', 'yes'], ['1', 1], ['null', null], ['an object', { on: true }], ['"true"', 'true']]) {
    const s = memoryStore();
    await s.setItem('shiba-wallet.prefs.v1', JSON.stringify({ notifications: stored }));
    const p = await loadPrefs(s);
    check(`stored ${label}: off (only an explicit true turns reminders on)`, p.notifications === false);
  }
  const s = memoryStore();
  await savePrefs({ notifications: true }, s);
  check('saved true reads back on', (await loadPrefs(s)).notifications === true);
  await savePrefs({ notifications: false }, s);
  check('saved false reads back off', (await loadPrefs(s)).notifications === false);
  const prefsSrc = read('src/config/prefs.ts');
  check('the prefs key used above is the real one', prefsSrc.includes("'shiba-wallet.prefs.v1'"));
}

// ---------------------------------------------------------------------------
console.log('check-notifications: copy and the lock-screen content rule');
// ---------------------------------------------------------------------------
{
  check('section title and switch label', NOTIFICATIONS_SECTION_TITLE === 'Notifications' && NOTIFICATIONS_SWITCH_LABEL === 'Remind me when something is due');
  check('the note says what is scheduled (recurring payments, takeover alerts) and that nothing is sent',
    NOTIFICATIONS_WHAT_NOTE.includes('recurring payments falls due') && NOTIFICATIONS_WHAT_NOTE.includes('recovery of one of your accounts') &&
      NOTIFICATIONS_WHAT_NOTE.includes('A reminder never sends anything'));
  check('the privacy note: on this phone, no service, nothing leaves the device, kind of event only',
    NOTIFICATIONS_PRIVACY_NOTE.includes('No notification service is used') && NOTIFICATIONS_PRIVACY_NOTE.includes('nothing about them leaves the device') &&
      NOTIFICATIONS_PRIVACY_NOTE.includes('never an amount, an address or a name'));
  check('the limits note names force stop, merchant subscriptions and auto-lock as not included',
    NOTIFICATIONS_LIMITS_NOTE.includes('force stop') && NOTIFICATIONS_LIMITS_NOTE.includes('merchant subscriptions') && NOTIFICATIONS_LIMITS_NOTE.includes('auto-lock reminders'));
  const r = recurringDueContent();
  const t = takeoverContent();
  check('recurring reminder content (exact)',
    r.title === 'Recurring payment due' && r.body === 'A recurring payment is due. Open the wallet to review it; nothing is sent until you confirm it.' &&
      JSON.stringify(r.data) === JSON.stringify({ screen: 'Sessions', kind: 'recurring-due' }));
  check('takeover alert content (exact)',
    t.title === 'Account recovery started' &&
      t.body === 'Someone started a recovery of one of your accounts. Open the wallet to review it, and veto it if you did not expect it.' &&
      JSON.stringify(t.data) === JSON.stringify({ screen: 'Inheritance', kind: 'takeover' }));
  const clean = (text) => !/[0-9]/.test(text) && !/0x/i.test(text);
  check('no digit and no "0x" in any title or body', [RECURRING_DUE_TITLE, RECURRING_DUE_BODY, TAKEOVER_TITLE, TAKEOVER_BODY].every(clean));
  check('the content functions take no record (nothing from a record can reach them)', recurringDueContent.length === 0 && takeoverContent.length === 0);
  check('status sentences', describeNotificationsStatus({ state: 'off' }) === 'Reminders are off. Nothing is scheduled.' &&
    describeNotificationsStatus({ state: 'on' }) === 'Reminders are on.' && describeNotificationsStatus({ state: 'blocked' }) === NOTIFICATIONS_DENIED_TEXT &&
    describeNotificationsStatus({ state: 'unavailable', detail: 'X' }).endsWith('Technical detail: X'));
  check('tap routing: only Sessions and Inheritance are opened',
    screenFromNotificationData({ screen: 'Sessions' }) === 'Sessions' && screenFromNotificationData({ screen: 'Inheritance' }) === 'Inheritance' &&
      screenFromNotificationData({ screen: 'Send' }) === null && screenFromNotificationData({ screen: 'Settings' }) === null &&
      screenFromNotificationData(null) === null && screenFromNotificationData('Sessions') === null);

  // Property check: generated records with amounts, payees, names and labels;
  // everything the center hands to the native layer must stay free of them.
  const native = fakeNative({ permission: { granted: true, canAskAgain: true } });
  const { center } = centerWith(native, { now: () => S - 10 * DAY });
  const names = ['Alice', 'Bob Smith', 'Landlord', 'Mum', 'Zoë', 'ACME GmbH'];
  const amounts = ['0.0001', '0.25', '1', '12.5', '0.003', '42'];
  const states = [];
  const secrets = [];
  for (let i = 0; i < 40; i++) {
    const name = names[i % names.length];
    const payee = randomAddress();
    const amount = amounts[Math.floor(rand() * amounts.length)];
    const rec = recurringRecord({ payee, amount, label: `Pay ${name} ${amount}`, periodSeconds: (1 + Math.floor(rand() * 30)) * DAY, start: S + i * 3600 });
    secrets.push(name, payee.toLowerCase(), payee.slice(2, 10).toLowerCase(), amount, rec.permissionId, rec.account.toLowerCase(), rec.owner.toLowerCase());
    states.push({ record: rec, due: recurringDueState(rec, status({ nextSlotAt: S + i * 3600 }), S - 10 * DAY) });
  }
  await center.syncRecurring({ enabled: true, records: states.map((s) => s.record), states });
  const found = Array.from({ length: 10 }, () => ({ chain: M, account: randomAddress(), proposalHash: `0x${hex(64)}` }));
  for (const f of found) secrets.push(f.account.toLowerCase(), f.proposalHash.slice(2, 14));
  await center.observeTakeovers({ enabled: true, found, looking: false });
  const handed = [...native.scheduled.values(), ...native.shown];
  check('property: 40 reminders and 10 alerts were handed to the native layer', native.scheduled.size === 40 && native.shown.length === 10, `${native.scheduled.size}/${native.shown.length}`);
  const leaks = [];
  for (const req of handed) {
    const visible = `${req.content.title}\n${req.content.body}`.toLowerCase();
    if (!clean(visible)) leaks.push(`digit/0x: ${visible}`);
    for (const s of secrets) if (visible.includes(String(s).toLowerCase())) leaks.push(`${s} in content`);
    const dataKeys = Object.keys(req.content.data).sort().join(',');
    if (dataKeys !== 'kind,screen') leaks.push(`data keys ${dataKeys}`);
    const data = JSON.stringify(req.content.data).toLowerCase();
    if (/0x|[0-9]/.test(data)) leaks.push(`data ${data}`);
    for (const s of secrets) if (req.identifier.toLowerCase().includes(String(s).toLowerCase()) && String(s).length >= 6) leaks.push(`${s} in identifier`);
  }
  check('property: no title, body or data carries a digit, "0x", an amount, an address, a name or a payee; identifiers carry no address or id', leaks.length === 0, leaks.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------
console.log('check-notifications: identifiers');
// ---------------------------------------------------------------------------
{
  const a = recurringRecord({ permissionId: '0x0a0b0c0d' });
  const b = recurringRecord({ permissionId: '0x0a0b0c0e' });
  const idA = recurringNotificationId(a);
  check('scheme: shiba-wallet.recurring.<8 hex scope>.<16 hex record>', /^shiba-wallet\.recurring\.[0-9a-f]{8}\.[0-9a-f]{16}$/.test(idA), idA);
  check('stable: the same record gives the same identifier (also with other letter case)',
    idA === recurringNotificationId({ ...a }) && idA === recurringNotificationId({ ...a, account: a.account.toUpperCase().replace('0X', '0x'), permissionId: a.permissionId.toUpperCase().replace('0X', '0x') }));
  check('different payments give different identifiers', idA !== recurringNotificationId(b));
  check('the same network + owner share the scope part; another owner does not',
    idA.split('.')[2] === recurringNotificationId(b).split('.')[2] && idA.split('.')[2] !== recurringNotificationId({ ...a, owner: '0x16DA000000000000000000000000000000000C5C' }).split('.')[2]);
  const t = takeoverNotificationId({ chain: M, account: ACCOUNT, proposalHash: `0x${'ab'.repeat(32)}` });
  check('takeover scheme: shiba-wallet.takeover.<16 hex>', /^shiba-wallet\.takeover\.[0-9a-f]{16}$/.test(t) && t.startsWith(TAKEOVER_ID_PREFIX) && t.startsWith(NOTIFICATION_ID_PREFIX), t);
  check('every prefix is under the wallet prefix', RECURRING_ID_PREFIX.startsWith(NOTIFICATION_ID_PREFIX) && TAKEOVER_ID_PREFIX.startsWith(NOTIFICATION_ID_PREFIX));
}

// ---------------------------------------------------------------------------
console.log('check-notifications: when a recurring reminder fires');
// ---------------------------------------------------------------------------
{
  const rec = recurringRecord({ periodSeconds: DAY, payments: '3', start: S });
  const end = recurringEndsAt(rec);
  check('the installed grant ends one period after the terms (grace)', end === S + 4 * DAY, String(end - S));
  const later = recurringDueState(rec, status(), S - 100);
  check('before the first slot: at the slot', later.kind === 'later' && recurringReminderAt(rec, later, S - 100) === S);
  const due = recurringDueState(rec, status(), S + 10);
  check('one payment due now: the reminder is for the NEXT slot (the banner shows the open one)', due.kind === 'due' && recurringReminderAt(rec, due, S + 10) === S + DAY);
  const catchUp = recurringDueState(rec, status(), S + DAY + 10);
  check('two open (one missed): the reminder is for the third slot', catchUp.kind === 'due' && catchUp.openSlots === 2 && recurringReminderAt(rec, catchUp, S + DAY + 10) === S + 2 * DAY);
  const allOpen = recurringDueState(rec, status(), S + 2 * DAY + 10);
  check('every remaining payment already open: no reminder', allOpen.kind === 'due' && allOpen.openSlots === 3 && recurringReminderAt(rec, allOpen, S + 2 * DAY + 10) === null);
  const lastLeft = recurringDueState(rec, status({ remainingPulls: 1, nextSlotAt: S + 2 * DAY }), S + 2 * DAY + 10);
  check('the last payment due now: no reminder after it', lastLeft.kind === 'due' && recurringReminderAt(rec, lastLeft, S + 2 * DAY + 10) === null);
  const done = recurringDueState(rec, status({ remainingPulls: 0, nextSlotAt: S + 3 * DAY }), S + 10);
  check('completed (all sent): none', done.kind === 'completed' && recurringReminderAt(rec, done, S + 10) === null);
  const revoked = recurringDueState(rec, status({ rateLimitStatus: 'deprecated' }), S);
  check('inactive on-chain: none', revoked.kind === 'inactive' && recurringReminderAt(rec, revoked, S) === null);
  check('unknown / not ready / read failed: none',
    recurringReminderAt(rec, { kind: 'unknown', reason: 'x' }, S) === null &&
      recurringReminderAt(rec, recurringDueState({ ...rec, keyHeld: false }, status(), S), S) === null && recurringReminderAt(rec, null, S) === null);
  check('never at or before now', recurringReminderAt(rec, { kind: 'later', at: S, remaining: 3, sent: 0, total: 3, feeBudgetLeftWei: 0n }, S) === null);
  const lateSlot = { kind: 'due', since: S + 3 * DAY + 100, openSlots: 1, remaining: 2, sent: 1, total: 3, feeBudgetLeftWei: 0n };
  check('a next slot after the grant ends: none', recurringReminderAt(rec, lateSlot, S + 3 * DAY + 200) === null);
}

// ---------------------------------------------------------------------------
console.log('check-notifications: planning recurring reminders');
// ---------------------------------------------------------------------------
{
  const a = recurringRecord({ permissionId: '0x00000001' });
  const b = recurringRecord({ permissionId: '0x00000002' });
  const ida = recurringNotificationId(a);
  const idb = recurringNotificationId(b);
  const foreign = 'other-app.reminder';
  const now = S - 100;
  const plan = planRecurringSync({ scheduled: [], records: [a, b], states: [{ record: a, due: recurringDueState(a, status(), now) }, { record: b, due: null }], now });
  check('schedules a "later" payment at its slot; a failed read schedules nothing', plan.schedule.length === 1 && plan.schedule[0].identifier === ida && plan.schedule[0].at === S && plan.cancel.length === 0);
  const keep = planRecurringSync({ scheduled: [ida, idb, foreign], records: [a, b], states: [{ record: b, due: null }], now });
  check('a failed read leaves the existing reminder in place; nothing outside the wallet prefix is touched', keep.cancel.length === 0 && keep.schedule.length === 0);
  const revokedPlan = planRecurringSync({ scheduled: [ida, idb], records: [{ ...a, localStatus: 'revoked' }, b], states: [], now });
  check('revoked locally: cancelled without any network read', JSON.stringify(revokedPlan.cancel) === JSON.stringify([ida]) && revokedPlan.schedule.length === 0);
  const forgot = planRecurringSync({ scheduled: [ida, idb], records: [b], states: [], now });
  check('forgotten (record gone): cancelled', JSON.stringify(forgot.cancel) === JSON.stringify([ida]));
  const keyGone = planRecurringSync({ scheduled: [ida], records: [{ ...a, keyHeld: false }], states: [], now });
  check('payment key gone: cancelled', JSON.stringify(keyGone.cancel) === JSON.stringify([ida]));
  const revoking = planRecurringSync({ scheduled: [ida], records: [{ ...a, localStatus: 'revoking' }], states: [], now });
  check('revoke in progress: cancelled', JSON.stringify(revoking.cancel) === JSON.stringify([ida]));
  const completed = planRecurringSync({
    scheduled: [ida],
    records: [a],
    states: [{ record: a, due: recurringDueState(a, status({ remainingPulls: 0, nextSlotAt: S + 3 * DAY }), now) }],
    now,
  });
  check('completed on-chain: cancelled', JSON.stringify(completed.cancel) === JSON.stringify([ida]) && completed.schedule.length === 0);
  const subscription = { ...a, source: 'subscription' };
  const merchant = planRecurringSync({ scheduled: [], records: [subscription], states: [{ record: subscription, due: { kind: 'later', at: S, remaining: 1, sent: 0, total: 1, feeBudgetLeftWei: 0n } }], now });
  check('a merchant subscription never gets a reminder (that is the merchant’s job)', merchant.schedule.length === 0);
  const dup = planRecurringSync({ scheduled: [], records: [a], states: [{ record: a, due: recurringDueState(a, status(), now) }, { record: { ...a }, due: recurringDueState(a, status(), now) }], now });
  check('the same payment listed twice is planned once', dup.schedule.length === 1);
}

// ---------------------------------------------------------------------------
console.log('check-notifications: nothing while off');
// ---------------------------------------------------------------------------
{
  const native = fakeNative({ permission: { granted: true, canAskAgain: true } });
  const { center, counter, store } = centerWith(native);
  const rec = recurringRecord();
  await center.syncRecurring({ enabled: false, records: [rec], states: [{ record: rec, due: recurringDueState(rec, status(), S - 100) }] });
  await center.observeTakeovers({ enabled: false, found: [{ chain: M, account: ACCOUNT, proposalHash: `0x${'11'.repeat(32)}` }], looking: false });
  check('sync and observe with reminders off: the native module is not even loaded, nothing scheduled or shown',
    counter.loads === 0 && native.scheduled.size === 0 && native.shown.length === 0 && native.log.length === 0);
  await center.cleanupIfOff();
  check('cleanup with nothing ever scheduled: no load, no write', counter.loads === 0 && !store.map.has(NOTIFICATIONS_STORE_KEY));
  check('nothing scheduled after the off-path at all', native.scheduled.size === 0);
}

// ---------------------------------------------------------------------------
console.log('check-notifications: turning on (permission once; channels first)');
// ---------------------------------------------------------------------------
{
  const native = fakeNative({ permission: { granted: false, canAskAgain: true } });
  const { center } = centerWith(native);
  const first = await center.enable({ found: [] });
  check('first enable: granted after one request', first.ok === true && native.requests === 1);
  check('Android: both channels created BEFORE the permission request (docs: the Android 13 prompt needs a channel)',
    native.log.indexOf('ensureChannels') !== -1 && native.log.indexOf('ensureChannels') < native.log.indexOf('requestPermission') &&
      native.channels.get('payments-due')?.importance === 'default' && native.channels.get('security-alerts')?.importance === 'high' &&
      CHANNEL_PAYMENTS.name === 'Payments due' && CHANNEL_SECURITY.name === 'Security alerts');
  const second = await center.enable({ found: [] });
  check('enabling again does not ask again', second.ok === true && native.requests === 1);

  const denied = fakeNative({ permission: { granted: false, canAskAgain: true }, grantOnRequest: false });
  const d = centerWith(denied);
  const out = await d.center.enable({ found: [] });
  check('refused: not ok (reason denied), nothing scheduled', out.ok === false && out.reason === 'denied' && denied.scheduled.size === 0 && d.center.status()?.state === 'blocked');
  const again = await d.center.enable({ found: [] });
  check('after a refusal the system no longer allows asking: no second prompt', again.ok === false && denied.requests === 1);

  const missing = fakeNative();
  const u = centerWith(missing, { failLoads: 1 });
  const unavailable = await u.center.enable({ found: [] });
  check('module missing (a build without it): unavailable with the technical detail',
    unavailable.ok === false && unavailable.reason === 'unavailable' && /ExpoNotificationScheduler/.test(unavailable.detail) && u.center.status()?.state === 'unavailable');
  const retry = await u.center.enable({ found: [] });
  check('a failed load is not cached: the next attempt loads again', retry.ok === true && u.counter.loads === 2);
}

// ---------------------------------------------------------------------------
console.log('check-notifications: scheduling from the current due state, replacing, cancelling');
// ---------------------------------------------------------------------------
{
  const sessions = memoryStore();
  const a = recurringRecord({ permissionId: '0x000000aa', start: S });
  const b = recurringRecord({ permissionId: '0x000000bb', start: S + 3600 });
  const c = recurringRecord({ permissionId: '0x000000cc', start: S, localStatus: 'installing' });
  const other = recurringRecord({ permissionId: '0x000000dd', owner: '0x16DA000000000000000000000000000000000C5C' });
  for (const r of [a, b, c, other]) await saveSessionRecord(r, sessions);
  check('the stored records load back (as the app stores them)', (await loadSessions(sessions)).records.length === 4);
  const chainState = new Map([
    [a.permissionId, status({ nextSlotAt: S })],
    [b.permissionId, status({ nextSlotAt: S + 3600 })],
  ]);
  const reads = [];
  const readStatus = async (r) => {
    reads.push(r.permissionId);
    const s = chainState.get(r.permissionId);
    if (!s) throw new Error('unexpected read');
    return s;
  };
  let now = S - 100;
  const { records, states } = await readRecurringDueStates({ chain: M, owner: OWNER, readStatus, store: sessions, now });
  check('readRecurringDueStates: only this owner’s confirmed payments with the key on this phone are read (read-only)',
    states.length === 2 && JSON.stringify(reads.sort()) === JSON.stringify([a.permissionId, b.permissionId].sort()) && records.length === 4);
  const due = await findDueRecurringPayments({ chain: M, owner: OWNER, readStatus, store: sessions, now: S + 10 });
  check('findDueRecurringPayments unchanged: the same candidates (both due at S + 10? only a; b opens at S + 3600)', due.checked === 2 && due.due.length === 1 && due.due[0].record.permissionId === a.permissionId);
  const mainnet = await readRecurringDueStates({ chain: 'eip155:1', owner: OWNER, readStatus, store: sessions, now });
  check('mainnet: nothing read (session keys are test-network only)', mainnet.states.length === 0 && mainnet.records.length === 0);

  const native = fakeNative({ permission: { granted: true, canAskAgain: true } });
  const store = memoryStore();
  const { center } = centerWith(native, { store, now: () => now });
  await center.enable({ found: [] });
  await center.syncRecurring({ enabled: true, records, states });
  check('enabled: one reminder per payment at the moment it falls due',
    native.scheduled.size === 2 && native.scheduled.get(recurringNotificationId(a))?.at === S && native.scheduled.get(recurringNotificationId(b))?.at === S + 3600);
  check('reminders use the "Payments due" channel', [...native.scheduled.values()].every((r) => r.channelId === 'payments-due'));
  check('the store records that something may be scheduled', JSON.parse(store.map.get(NOTIFICATIONS_STORE_KEY)).mayHaveScheduled === true);
  const before = [...native.scheduled.keys()].sort().join();
  await center.syncRecurring({ enabled: true, records, states });
  await center.syncRecurring({ enabled: true, records, states });
  check('rescheduling replaces instead of duplicating (stable identifiers)', native.scheduled.size === 2 && [...native.scheduled.keys()].sort().join() === before);
  // One payment sent: the chain moves on; the same identifier moves to the next slot.
  now = S + 10;
  chainState.set(a.permissionId, status({ remainingPulls: 2, nextSlotAt: S + DAY }));
  const after = await readRecurringDueStates({ chain: M, owner: OWNER, readStatus, store: sessions, now });
  await center.syncRecurring({ enabled: true, records: after.records, states: after.states });
  check('after a payment the reminder moves to the next slot (same identifier)', native.scheduled.size === 2 && native.scheduled.get(recurringNotificationId(a))?.at === S + DAY);
  // b completed on-chain.
  chainState.set(b.permissionId, status({ remainingPulls: 0, nextSlotAt: S + 3 * DAY }));
  const done = await readRecurringDueStates({ chain: M, owner: OWNER, readStatus, store: sessions, now });
  await center.syncRecurring({ enabled: true, records: done.records, states: done.states });
  check('completed: its reminder is cancelled', !native.scheduled.has(recurringNotificationId(b)) && native.scheduled.has(recurringNotificationId(a)));
  // a revoked locally: the local pass (no network) cancels it.
  await saveSessionRecord({ ...a, localStatus: 'revoked' }, sessions);
  const local = await loadSessions(sessions);
  const readsBefore = reads.length;
  await center.syncRecurring({ enabled: true, records: local.records, states: [] });
  check('revoked: cancelled by the local pass, with no status read', native.scheduled.size === 0 && reads.length === readsBefore);
}

// ---------------------------------------------------------------------------
console.log('check-notifications: takeover alerts (once per proposal)');
// ---------------------------------------------------------------------------
{
  const native = fakeNative({ permission: { granted: true, canAskAgain: true } });
  const store = memoryStore();
  const { center } = centerWith(native, { store });
  const P = (n) => ({ chain: M, account: ACCOUNT, proposalHash: `0x${n.repeat(64)}` });
  const old = P('0');
  await center.enable({ found: [old] });
  await center.observeTakeovers({ enabled: true, found: [old], looking: false });
  check('turning on never replays attempts found before', native.shown.length === 0);
  await center.observeTakeovers({ enabled: true, found: [old, P('1')], looking: false });
  check('a new attempt found while the user is not looking: one immediate alert',
    native.shown.length === 1 && native.shown[0].at === null && native.shown[0].identifier === takeoverNotificationId(P('1')) && native.shown[0].channelId === 'security-alerts' &&
      native.shown[0].content.title === TAKEOVER_TITLE && native.shown[0].content.data.screen === 'Inheritance');
  await center.observeTakeovers({ enabled: true, found: [old, P('1')], looking: false });
  await center.observeTakeovers({ enabled: true, found: [old, P('1')], looking: false });
  check('the same proposal never alerts twice', native.shown.length === 1);
  await center.observeTakeovers({ enabled: true, found: [old, P('1'), P('2')], looking: true });
  check('found while the user is looking at the Inheritance screen: marked seen, no alert', native.shown.length === 1);
  await center.observeTakeovers({ enabled: true, found: [old, P('1'), P('2')], looking: false });
  check('…and it does not alert later either', native.shown.length === 1);
  await center.observeTakeovers({ enabled: true, found: [old, P('1'), P('2'), P('3'), { ...P('4'), chain: 'eip155:84532' }], looking: false });
  check('two more attempts (another network too): two alerts, one per proposal', native.shown.length === 3);
  const stored = JSON.parse(store.map.get(NOTIFICATIONS_STORE_KEY));
  check('the seen list holds hashes only (no address, no proposal hash)',
    stored.seenTakeovers.length === 5 && stored.seenTakeovers.every((h) => /^[0-9a-f]{16}$/.test(h)) && !JSON.stringify(stored).toLowerCase().includes(ACCOUNT.slice(2, 12).toLowerCase()));
  // A second controller on the same store (the app restarted) keeps "once".
  const restarted = fakeNative({ permission: { granted: true, canAskAgain: true } });
  const again = centerWith(restarted, { store });
  await again.center.observeTakeovers({ enabled: true, found: [old, P('1'), P('2'), P('3')], looking: false });
  check('after a restart the same proposals stay announced once', restarted.shown.length === 0);

  // listFoundTakeoverApprovals over the scan's own stored format.
  const scans = memoryStore();
  const entry = (hashes) => ({
    startBlock: '100',
    scannedThrough: '160',
    startsAtInstall: true,
    lastCheckedAt: 1,
    found: hashes.map((h, i) => ({ proposalHash: h, txHash: `0x${'cd'.repeat(32)}`, blockNumber: String(120 + i), from: OWNER, approvers: [OWNER] })),
  });
  await scans.setItem(INHERITANCE_STORE_KEY, JSON.stringify({
    version: 1,
    entries: {
      [`${M}|${ACCOUNT.toLowerCase()}`]: entry([`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`]),
      [`eip155:84532|${OWNER.toLowerCase()}`]: entry([`0x${'cc'.repeat(32)}`]),
      'broken-key': entry([`0x${'dd'.repeat(32)}`]),
      [`${M}|0x0000000000000000000000000000000000000001`]: { startBlock: 'x' },
    },
  }));
  const listed = await listFoundTakeoverApprovals(scans);
  check('listFoundTakeoverApprovals: every stored approval with its network and account; malformed entries skipped',
    listed.length === 3 && listed[0].chain === M && listed[0].account === ACCOUNT.toLowerCase() && listed[2].chain === 'eip155:84532' && listed[2].proposalHash === `0x${'cc'.repeat(32)}`,
    JSON.stringify(listed));
  check('listFoundTakeoverApprovals: nothing stored → empty', (await listFoundTakeoverApprovals(memoryStore())).length === 0);
}

// ---------------------------------------------------------------------------
console.log('check-notifications: turning off and the wipe cancel everything (and only ours)');
// ---------------------------------------------------------------------------
{
  const native = fakeNative({ permission: { granted: true, canAskAgain: true } });
  const store = memoryStore();
  const { center, counter } = centerWith(native, { store, now: () => S - 100 });
  await center.enable({ found: [] });
  const r = recurringRecord();
  await center.syncRecurring({ enabled: true, records: [r], states: [{ record: r, due: recurringDueState(r, status(), S - 100) }] });
  native.scheduled.set('another-library.timer', { identifier: 'another-library.timer' });
  await center.disable();
  check('disable: every reminder of this wallet cancelled, a foreign one left alone',
    native.scheduled.size === 1 && native.scheduled.has('another-library.timer'));
  check('disable: the bookkeeping is reset', JSON.parse(store.map.get(NOTIFICATIONS_STORE_KEY)).mayHaveScheduled === false);

  // The wipe path: reminders off + cleanupIfOff (the scheduler does both when the wallet is gone).
  native.scheduled.delete('another-library.timer');
  await center.syncRecurring({ enabled: true, records: [r], states: [{ record: r, due: recurringDueState(r, status(), S - 100) }] });
  const loadsBefore = counter.loads;
  await center.cleanupIfOff();
  check('cleanup after a schedule (wipe / turned off elsewhere): cancelled', native.scheduled.size === 0);
  await center.cleanupIfOff();
  check('a second cleanup has nothing to do', native.scheduled.size === 0 && counter.loads === loadsBefore);

  // Serialization: a disable queued right after a sync wins.
  const slow = fakeNative({ permission: { granted: true, canAskAgain: true } });
  const origSchedule = slow.schedule;
  slow.schedule = async (req) => {
    await new Promise((res) => setTimeout(res, 5));
    return origSchedule(req);
  };
  const s2 = centerWith(slow, { now: () => S - 100 });
  const recs = [recurringRecord(), recurringRecord(), recurringRecord()];
  const syncing = s2.center.syncRecurring({ enabled: true, records: recs, states: recs.map((x) => ({ record: x, due: recurringDueState(x, status(), S - 100) })) });
  const disabling = s2.center.disable();
  await Promise.all([syncing, disabling]);
  check('operations run one at a time: a disable issued during a sync leaves nothing scheduled', slow.scheduled.size === 0);
}

// ---------------------------------------------------------------------------
console.log('check-notifications: wiring and the import rule (source)');
// ---------------------------------------------------------------------------
{
  const app = read('App.tsx');
  const navStart = app.indexOf('<NavigationContainer');
  const navEnd = app.indexOf('</NavigationContainer>');
  const at = app.indexOf('<NotificationScheduler />');
  check('App.tsx mounts the scheduler once, inside the navigation container, after the navigator',
    app.split('<NotificationScheduler />').length === 2 && at > navStart && at < navEnd && at > app.indexOf('</Stack.Navigator>') &&
      app.includes("import { NotificationScheduler } from './src/components/NotificationScheduler';"));
  const settings = read('src/screens/SettingsScreen.tsx');
  const privacy = settings.indexOf('{SCREEN_PROTECTION_TITLE}');
  const section = settings.indexOf('<NotificationSettingsSection />');
  const prices = settings.indexOf('>Prices<');
  check('Settings shows the Notifications subsection inside the Privacy section (before Prices)', privacy > 0 && section > privacy && section < prices);
  const component = read('src/components/NotificationScheduler.tsx');
  check('the scheduler reads only (no payment, signing, key or bundler path)',
    !/payRecurringPayment|sendSessionCalls|signWith|requireLocalAuth|planRecurringPayment|createAaClient|vault/.test(component));
  check('the switch turns on only after enable() succeeded (the permission request)', /const outcome = await appNotifications\(\)\.enable\(/.test(component) && /if \(outcome\.ok\) await setNotifications\(true\);/.test(component));
  check('a wiped wallet turns reminders off and cleans up', /status === 'no-wallet' && notifications\) void setNotifications\(false\)/.test(component) && /cleanupIfOff\(\)/.test(component));

  // Only notifications.ts touches expo-notifications, and never its index.
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(join(appDir, 'src'));
  files.push(join(appDir, 'App.tsx'), join(appDir, 'index.ts'));
  const importers = files.filter((f) => /['"]expo-notifications/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(appDir.length));
  check('the only module that imports expo-notifications is src/wallet/notifications.ts', JSON.stringify(importers) === JSON.stringify(['src/wallet/notifications.ts']), JSON.stringify(importers));
  const lib = read('src/wallet/notifications.ts');
  const specs = [...lib.matchAll(/(?:import\(|from )\s*'(expo-notifications[^']*)'/g)].map((m) => m[1]);
  check('it never imports the package index (whose push-token side effect throws in Expo Go on Android)',
    specs.length > 0 && specs.every((s) => s.startsWith('expo-notifications/build/')) && !specs.includes('expo-notifications'), JSON.stringify(specs));
  check('no push-token API is used anywhere in the app',
    !files.some((f) =>
      /getExpoPushTokenAsync|getDevicePushTokenAsync|addPushTokenListener|setAutoServerRegistrationEnabledAsync|registerTaskAsync/.test(
        readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
      ),
    ));
  // The transitive closure of the deep-imported build files, from the installed package.
  const build = join(appDir, 'node_modules/expo-notifications/build');
  const seen = new Set();
  const nativeNames = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/requireNativeModule\(\s*'([^']+)'/g)) nativeNames.add(m[1]);
    for (const m of src.matchAll(/(?:from|import)\s*'(\.[^']+)'/g)) {
      for (const suffix of ['.android.js', '.ios.js', '.native.js', '.js']) {
        const target = join(dirname(file), m[1]) + suffix;
        if (existsSync(target)) visit(target);
      }
    }
  };
  for (const s of specs) {
    const base = join(appDir, 'node_modules', s);
    let any = false;
    for (const suffix of ['.android.js', '.ios.js', '.native.js', '.js']) {
      if (existsSync(base + suffix)) {
        visit(base + suffix);
        any = true;
      }
    }
    if (!any) check(`deep import exists: ${s}`, false);
  }
  const closure = [...seen].map((f) => f.slice(build.length + 1));
  check('the deep imports never reach the push-token code, its Expo Go throw or the package index',
    closure.length > 10 && !closure.some((f) => /DevicePushTokenAutoRegistration|TokenEmitter|warnOfExpoGoPushUsage|getExpoPushTokenAsync|getDevicePushTokenAsync|updateDevicePushTokenAsync|^index\.js$/.test(f)),
    closure.join(','));
  const androidList = lib.slice(lib.indexOf('android: ['), lib.indexOf('],', lib.indexOf('android: [')));
  const missing = [...nativeNames].filter((n) => !androidList.includes(`'${n}'`));
  check('every native module the imported files bind is checked before loading them (Android list)', nativeNames.size >= 5 && missing.length === 0, `missing: ${missing.join(', ')}`);
  const appJson = JSON.parse(read('app.json'));
  check('no expo-notifications config plugin (no push entitlement; the library manifest carries the permissions)',
    !(appJson.expo.plugins ?? []).some((p) => (Array.isArray(p) ? p[0] : p) === 'expo-notifications'));
  const manifest = read('node_modules/expo-notifications/android/src/main/AndroidManifest.xml');
  check('the installed library declares POST_NOTIFICATIONS and RECEIVE_BOOT_COMPLETED itself',
    manifest.includes('android.permission.POST_NOTIFICATIONS') && manifest.includes('android.permission.RECEIVE_BOOT_COMPLETED'));
  const pkg = JSON.parse(read('package.json'));
  check('expo-notifications is a dependency on the SDK 57 line', /^~57\./.test(pkg.dependencies['expo-notifications'] ?? ''));
  const privacyDoc = readFileSync(join(appDir, '../docs/PRIVACY.md'), 'utf8');
  check('docs/PRIVACY.md describes the local reminders and that no notification server is contacted',
    /Local reminders/.test(privacyDoc) && /no push service/i.test(privacyDoc));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

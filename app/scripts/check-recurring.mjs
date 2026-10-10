// Phase 15 item 1: recurring payments pushed by this phone ("pay X every N to
// Y"), entirely OFFLINE. Exercises the exact app modules
// (src/wallet/recurring.ts, sessions.ts, subscriptions.ts, spending-policy.ts
// and the real storage.ts vault over a fake secure-store backend) under
// Node's type stripping against fakes:
//  - the grant is EXACTLY the subscription template (field-for-field, and the
//    Kernel permission id and validatorData);
//  - the review copy (batching residual first; "only while the wallet is
//    open"; the prompts stated exactly);
//  - the install through the same explicit root-signed path, the record
//    source 'recurring', the key kept in the vault and never in AsyncStorage;
//  - the NO-HAND-OVER invariant (export, release, hand-over offer, test button);
//  - due detection against fakes: period boundaries, catch-up of missed slots
//    as RateLimitPolicy allows, the end date, count exhaustion, inactive,
//    unknown and not-ready;
//  - the foreground check reads no key and contacts no bundler;
//  - the CONFIRM-BEFORE-SUBMIT rule (runRecurringPayment) behaviourally and in
//    the screen's source;
//  - a full payment signed by the payment key alone (ethers recovers the
//    session address, never the owner), for the native currency and USDC;
//  - the NO-PHRASE-READ invariant: during a payment the secure store is asked
//    only for the payment key — zero reads of the recovery phrase — with the
//    exact system prompts (protected: "Use the session key"; standard: none);
//  - app-only spending limits before a payment (blocked → nothing read or
//    sent; allowed → recorded after acceptance; unreadable → fail closed);
//  - refusals in plain words (AA22, CallPolicy errors, PolicyFailed(i), a
//    revoked permission), the card kept;
//  - revocation deletes the key, as for every session; mainnet readiness.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-recurring.mjs
//
// Nothing is signed against a live chain and nothing is broadcast.

import { readFileSync } from 'node:fs';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  KERNEL_PERMISSION_MODULES,
  KERNEL_V3_3,
  SUBSCRIPTION_NATIVE,
  createSessionKeyAccount,
  encodePermissionInstall,
  getUserOpHash,
  sessionNonceKey,
  toBytes,
  toHex,
} from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import { createAaClient, sendAa } from '../src/wallet/aa.ts';
import {
  SESSIONS_KEY,
  finalizeSessionInstall,
  forgetAllSessions,
  installSession,
  loadSessions,
  prepareSessionInstall,
  prepareSessionRevoke,
  releaseSessionKey,
  revokeApprovalPrompt,
  revokeConfirmCopy,
  revokeSession,
  saveSessionRecord,
  sessionCanBeTested,
  sessionCarriesTerms,
  sessionProgressTitle,
  sessionRevokeKeySentence,
  sessionStatusText,
  sessionVaultId,
  SESSION_UNREACHABLE_TITLE,
  isNodeEndpointFailure,
  isTransportFailure,
  markNodeErrors,
  recurringGraceSeconds,
  termsMatchGrant,
  unknownStatusFrom,
} from '../src/wallet/sessions.ts';
import { NO_ANSWER_SENTENCE, isEndpointFailure, runWithEndpointFailover } from '../src/config/endpoint-probe.ts';
import {
  RECURRING_KEY_NEVER_EXPORTED,
  buildSubscription,
  buildSubscriptionKeyExport,
  markSubscriptionKeyExported,
  subscriptionGrantFor,
  subscriptionHandoverOffer,
  readSubscriptionStatus,
  subscriptionInstallFunding,
  subscriptionKeyStatusText,
  subscriptionMeta,
  subscriptionRecords,
  subscriptionTokenChoices,
} from '../src/wallet/subscriptions.ts';
import {
  RECURRING_CARD_NOTE,
  RECURRING_COMPLETED_TEXT,
  RECURRING_NOT_SENT_SENTENCE,
  RECURRING_OUTCOME_UNKNOWN_SENTENCE,
  RECURRING_OUTCOME_UNKNOWN_TITLE,
  RECURRING_KEY_HOLDER_TEXT,
  RECURRING_PAY_PROMPT_NOTE,
  RECURRING_REFUSED_TITLE,
  RECURRING_SPENDING_NOTE,
  RECURRING_WHILE_OPEN_NOTE,
  RecurringNotDueError,
  RecurringSpendingError,
  RecurringStatusUnreachableError,
  isRecurringNodeFailure,
  readStatusWithFailover,
  recurringAttemptLine,
  recurringEndOf,
  recurringEndedLine,
  recurringEndsAt,
  describeRecurringPaymentError,
  findDueRecurringPayments,
  openSlotCount,
  payRecurringPayment,
  planRecurringPayment,
  recurringConfirmMessage,
  recurringDueHeadline,
  recurringDueState,
  recurringFinalDatesLine,
  recurringGrantFor,
  recurringKeyStatusText,
  recurringMeta,
  recurringNames,
  recurringRecords,
  recurringRefusalSentence,
  recurringReview,
  recurringShortWindowWarning,
  recurringStatusLines,
  recurringSummary,
  runRecurringPayment,
} from '../src/wallet/recurring.ts';
import {
  NATIVE_TOKEN,
  listSpendRecords,
  saveSpendingPolicy,
} from '../src/wallet/spending-policy.ts';
import { describeSendError } from '../src/wallet/send.ts';
import {
  MNEMONIC_KEY,
  PROMPTS,
  PROTECTED_MNEMONIC_KEY,
  createKeyVault,
} from '../src/wallet/storage.ts';
import {
  KERNEL_ACCOUNT_0,
  OWNER_0,
  TEST_MNEMONIC,
  decodeKernelExecute,
  fakeBundler,
  fakeKernelNode,
  fromRpcOp,
  memoryStore,
} from './fakes-kernel.mjs';

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
async function caught(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const abi = ethers.AbiCoder.defaultAbiCoder();
const sel = (s) => ethers.id(s).slice(0, 10);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const pad32 = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** The text of `name`'s body (from its declaration to the next top-level declaration marker). */
function body(text, start, end) {
  const a = text.indexOf(start);
  const b = end ? text.indexOf(end, a + start.length) : text.length;
  return a < 0 ? '' : text.slice(a, b < 0 ? text.length : b);
}

const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);
const M = 'eip155:11155111';
const CHAIN_ID = 11155111n;
const ACCOUNT = KERNEL_ACCOUNT_0;
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const PAYEE = '0x69F0EC265702D0891b0AEF8e79ddDC3277ef7E8a';
const DAY = 86_400;
const TX_HASH = '0x' + 'cd'.repeat(32);
const NOW = Math.floor(Date.now() / 1000);

function fakeVault() {
  const map = new Map();
  const vault = {
    map,
    loads: 0,
    save: async (id, value) => void map.set(id, value),
    load: async (id) => {
      vault.loads += 1;
      return map.has(id) ? map.get(id) : null;
    },
    remove: async (id) => void map.delete(id),
  };
  return vault;
}

/** Fake node: Kernel fake + the permission views + RateLimitPolicy / GasPolicy reads (as in check-subscriptions.mjs). */
function fakeNode() {
  const base = fakeKernelNode({ chainIdHex: '0xaa36a7', deployedAccounts: new Set([ACCOUNT]) });
  const state = { currentNonce: 1, permissions: new Map(), rate: new Map(), gas: new Map() };
  const calls = [];
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      const b = '0x' + data.slice(10);
      if (same(to, ACCOUNT) && data.startsWith(sel('currentNonce()'))) return word(state.currentNonce);
      if (same(to, ACCOUNT) && data.startsWith(sel('validationConfig(bytes21)'))) {
        const [vId] = abi.decode(['bytes21'], b);
        const p = state.permissions.get(vId.slice(4, 12).toLowerCase());
        return abi.encode(['uint32', 'address'], [p ? p.nonce : 0, p ? '0x0000000000000000000000000000000000000001' : ZERO]);
      }
      if (same(to, ACCOUNT) && data.startsWith(sel('permissionConfig(bytes4)'))) {
        const [pid] = abi.decode(['bytes4'], b);
        const p = state.permissions.get(pid.slice(2).toLowerCase());
        return abi.encode(['tuple(bytes2,address,bytes22[])'], [[p ? '0x0002' : '0x0000', p ? KERNEL_PERMISSION_MODULES.ecdsaSigner : ZERO, p ? p.policies : []]]);
      }
      if (same(to, ACCOUNT) && data.startsWith(sel('isAllowedSelector(bytes21,bytes4)'))) {
        const [vId] = abi.decode(['bytes21', 'bytes4'], b);
        return word(state.permissions.has(vId.slice(4, 12).toLowerCase()) ? 1 : 0);
      }
      if (data.startsWith(sel('status(bytes32,address)'))) {
        const [id] = abi.decode(['bytes32', 'address'], b);
        const key = id.slice(2, 10).toLowerCase();
        return word(state.permissions.has(key) ? 1 : state.rate.has(key) ? 2 : 0);
      }
      if (same(to, KERNEL_PERMISSION_MODULES.rateLimitPolicy) && data.startsWith(sel('rateLimitConfigs(bytes32,address)'))) {
        const [id] = abi.decode(['bytes32', 'address'], b);
        const r = state.rate.get(id.slice(2, 10).toLowerCase()) ?? { interval: 0, count: 0, startAt: 0 };
        return abi.encode(['uint48', 'uint48', 'uint48'], [r.interval, r.count, r.startAt]);
      }
      if (same(to, KERNEL_PERMISSION_MODULES.gasPolicy) && data.startsWith(sel('gasPolicyConfig(bytes32,address)'))) {
        const [id] = abi.decode(['bytes32', 'address'], b);
        return abi.encode(['uint128', 'bool', 'address'], [state.gas.get(id.slice(2, 10).toLowerCase()) ?? 0n, false, ZERO]);
      }
      if (same(to, KERNEL_PERMISSION_MODULES.ecdsaSigner) && data.startsWith(sel('signer(bytes32,address)'))) {
        const [id] = abi.decode(['bytes32', 'address'], b);
        const p = state.permissions.get(id.slice(2, 10).toLowerCase());
        return pad32(p ? p.signer : ZERO);
      }
      if (same(to, ENTRYPOINT_V07) && data.startsWith(sel('getNonce(address,uint192)'))) {
        const [, key] = abi.decode(['address', 'uint192'], b);
        return word(BigInt(key) << 64n);
      }
    }
    return base(method, params);
  };
  transport.calls = calls;
  transport.state = state;
  transport.install = (pid, signer, grant) => {
    const key = pid.replace(/^0x/, '').toLowerCase();
    state.currentNonce += 1;
    const modules = [KERNEL_PERMISSION_MODULES.callPolicy, KERNEL_PERMISSION_MODULES.timestampPolicy, KERNEL_PERMISSION_MODULES.gasPolicy, KERNEL_PERMISSION_MODULES.rateLimitPolicy];
    state.permissions.set(key, { nonce: state.currentNonce, signer, policies: modules.map((m) => '0x0000' + m.slice(2)) });
    state.rate.set(key, { interval: grant.rateLimit.intervalSeconds, count: grant.rateLimit.count, startAt: grant.rateLimit.startAt });
    state.gas.set(key, grant.gasBudgetWei);
  };
  /** Emulates one accepted payment (RateLimitPolicy: count − 1, startAt + interval). */
  transport.paid = (pid) => {
    const key = pid.replace(/^0x/, '').toLowerCase();
    const r = state.rate.get(key);
    state.rate.set(key, { ...r, count: r.count - 1, startAt: r.startAt + r.interval });
  };
  transport.revoked = (pid) => void state.permissions.delete(pid.replace(/^0x/, '').toLowerCase());
  return transport;
}

function kernelBundle(node, bundler) {
  return createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: KERNEL_V3_3.factory,
    chainId: CHAIN_ID,
    accountIndex: 0,
    accountType: 'kernel-v3.3',
    transportFor: (url) => (url.includes('bundler') ? bundler : node),
  });
}

const choices = subscriptionTokenChoices(M, 'test ETH');
const native = choices[0];
const usdc = choices.find((c) => same(c.token, USDC));

/** Installs one recurring payment through the real path and confirms it (fakes). */
async function installRecurring({ node, bundle, store, vault, choice = native, amount = '0.0001', periodSeconds = DAY, payments = '3', now = NOW }) {
  const sub = buildSubscription(
    { merchant: PAYEE, choice, amount, periodSeconds, payments, feeBudget: '0.01', label: recurringNames('', PAYEE, null).termsLabel },
    { now, account: ACCOUNT, testnet: true },
  );
  const keyBytes = ethers.randomBytes(32);
  const keyAddress = createSessionKeyAccount(keyBytes.slice()).address;
  const grant = recurringGrantFor(sub, keyAddress, { account: ACCOUNT, now });
  const { install, quote } = await prepareSessionInstall(bundle, OWNER_0, ACCOUNT, grant, { now });
  const res = await installSession({
    quote, install, grant, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3',
    label: recurringNames('', PAYEE, null).recordLabel, source: 'recurring', subscription: recurringMeta(sub, choice),
    sessionPrivateKey: keyBytes.slice(), store, vault, submit: (q) => sendAa(bundle, owner, q),
  });
  node.install(res.record.permissionId, keyAddress, grant);
  const fin = await finalizeSessionInstall(bundle, res.record, store, { timeoutMs: 1000, pollMs: 1 });
  return { record: fin.record, sub, grant, keyHex: ethers.hexlify(keyBytes).toLowerCase(), keyAddress, status: fin.status };
}

// ---------------------------------------------------------------------------
console.log('check-recurring: the grant is the subscription template');
// ---------------------------------------------------------------------------
{
  const KEY = '0x484B87B8D4D73d88ccF7D39C006cC1b078384640';
  const S = 1790000000;
  for (const [label, choice, amount] of [['native', native, '0.001'], ['USDC', usdc, '5']]) {
    const sub = buildSubscription({ merchant: PAYEE, choice, amount, periodSeconds: 30 * DAY, payments: '3', feeBudget: '0.003', label: 'Rent' }, { now: S, account: ACCOUNT });
    const r = recurringGrantFor(sub, KEY, { account: ACCOUNT, now: S - 10 });
    const g = subscriptionGrantFor(sub, KEY, { account: ACCOUNT, now: S - 10 });
    // Finding 3 of the 2026-10-09 rehearsal: the grant ends ONE PERIOD after the terms (grace for a late last payment).
    check(`${label}: recurringGrantFor = subscriptionGrantFor with ONLY validUntil one period later (grace)`,
      json(r) === json({ ...g, validUntil: g.validUntil + 30 * DAY }) && r.validUntil === sub.validUntil + 30 * DAY && g.validUntil === sub.validUntil, json(r));
    const ri = encodePermissionInstall(r, { chainId: CHAIN_ID, account: ACCOUNT, currentNonce: 3, validationNonce: 0, now: S - 10 });
    const gi = encodePermissionInstall({ ...g, validUntil: g.validUntil + 30 * DAY }, { chainId: CHAIN_ID, account: ACCOUNT, currentNonce: 3, validationNonce: 0, now: S - 10 });
    check(`${label}: the install is the subscription template's with only TimestampPolicy's validUntil moved (permission id and validatorData)`,
      toHex(ri.permissionId) === toHex(gi.permissionId) && toHex(ri.validatorData) === toHex(gi.validatorData));
    check(`${label}: one allowed call, validAfter = start, rate limit {period, payments (NOT payments + 1), start}, fee budget`,
      r.calls.length === 1 && r.validAfter === S && r.rateLimit.count === 3 && r.rateLimit.count === g.rateLimit.count && r.rateLimit.intervalSeconds === 30 * DAY && r.rateLimit.startAt === S && r.gasBudgetWei === 3_000_000_000_000_000n);
    check(`${label}: recurringMeta equals subscriptionMeta (hand-over time null)`, json(recurringMeta(sub, choice)) === json(subscriptionMeta(sub, choice)) && recurringMeta(sub, choice).keyExportedAt === null);
  }
  const rsrc = src('../src/wallet/recurring.ts');
  check('source: recurringGrantFor delegates to subscriptionGrantFor with the one-period grace (one template, no copy)',
    /export function recurringGrantFor[\s\S]{0,260}return subscriptionGrantFor\(sub, sessionKey, \{ \.\.\.context, graceSeconds: recurringGraceSeconds\(sub\) \}\);/.test(rsrc) && recurringGraceSeconds({ periodSeconds: 120 }) === 120);
  const subSrc = src('../src/wallet/subscriptions.ts');
  check('source: the grace moves only the grant\'s validUntil, after the engine built the grant, and is validated again by the engine',
    /const grant = subscriptionToGrant\(sub, sessionKey, \{ account: context\.account, now: context\.now \}\);[\s\S]{0,300}const extended: SessionKeyGrant = \{ \.\.\.grant, validUntil: grant\.validUntil \+ grace \};\s*validateSessionKeyGrant\(extended,/.test(subSrc));
  const S2 = 1790000000;
  const sub2 = buildSubscription({ merchant: PAYEE, choice: native, amount: '0.001', periodSeconds: 120, payments: '3', feeBudget: '0.003', label: 'x' }, { now: S2, account: ACCOUNT, testnet: true });
  const plain = subscriptionGrantFor(sub2, KEY, { account: ACCOUNT, now: S2 });
  check('subscriptionGrantFor without a grace is the engine grant unchanged (merchant subscriptions keep their end)',
    plain.validUntil === sub2.validUntil && json(subscriptionGrantFor(sub2, KEY, { account: ACCOUNT, now: S2, graceSeconds: 0 })) === json(plain));
  check('a negative or fractional grace is refused',
    /grace period/.test((await caught(() => subscriptionGrantFor(sub2, KEY, { account: ACCOUNT, now: S2, graceSeconds: -1 })))?.message ?? '') &&
      /grace period/.test((await caught(() => subscriptionGrantFor(sub2, KEY, { account: ACCOUNT, now: S2, graceSeconds: 1.5 })))?.message ?? ''));
  check('names: typed or contact name → "Recurring payment: <name>", else "Recurring payment to 0x69F0…7E8a"',
    recurringNames('Rent', PAYEE, null).recordLabel === 'Recurring payment: Rent' && recurringNames('', PAYEE, 'Landlord').recordLabel === 'Recurring payment: Landlord' &&
      recurringNames('', PAYEE, null).recordLabel === 'Recurring payment to 0x69F0…7E8a' && recurringNames('', PAYEE, null).termsLabel === 'to 0x69F0…7E8a');
  check('sessionCarriesTerms: subscription and recurring only', sessionCarriesTerms('recurring') && sessionCarriesTerms('subscription') && !sessionCarriesTerms('manual') && !sessionCarriesTerms('erc7715'));
}

// ---------------------------------------------------------------------------
console.log('check-recurring: review copy');
// ---------------------------------------------------------------------------
{
  const sub = buildSubscription({ merchant: PAYEE, choice: usdc, amount: '5', periodSeconds: 30 * DAY, payments: '2', feeBudget: '0.003', label: 'Rent' }, { now: Date.UTC(2026, 9, 10) / 1000, account: ACCOUNT });
  const r = recurringReview(sub, { tokenSymbol: 'USDC', tokenDecimals: 6, nativeSymbol: 'test ETH', payeeName: 'Landlord' });
  // 2 payments of 30 days from 2026-10-10 plus one period of grace: the grant ends 2027-01-08 (the terms 2026-12-09).
  check('sentence names the payee, amount, period, the GRANT\'s end date (grace included) and the confirmation',
    r.sentence === `Pays Landlord (${PAYEE}) up to 5 USDC every 30 days until 2027-01-08 00:00 UTC: at most one payment per period, each sent by this wallet after you confirm it.`, r.sentence);
  check('"Nothing after" is the grant\'s end, with when the last payment falls due',
    r.enforced[2] === 'Nothing after 2027-01-08 00:00 UTC. The last payment falls due 2026-11-09 00:00 UTC and can be sent until then.', r.enforced[2]);
  check('the catch-up caveat explains the grace and that it allows no extra payment',
    /The end date is one period after the last payment falls due, so a late last payment can still be sent too; this does not allow any extra payment\.$/.test(r.caveats[1]), r.caveats[1]);
  const installedOld = recurringReview(sub, { tokenSymbol: 'USDC', tokenDecimals: 6, nativeSymbol: 'test ETH', endsAt: sub.validUntil });
  check('an installed record WITHOUT grace (set up before this change) prints its own end and no grace sentence',
    /until 2026-12-09 00:00 UTC:/.test(installedOld.sentence) && installedOld.enforced[2].startsWith('Nothing after 2026-12-09 00:00 UTC.') && !/one period after/.test(installedOld.caveats[1]));
  check('recurringEndOf = terms end + one period', recurringEndOf(sub) === sub.validUntil + 30 * DAY);
  check('the FIRST caveat is the batching residual: per-transfer cap, up to the whole balance, payee only',
    /^ONE PAYMENT OPERATION CAN HOLD SEVERAL TRANSFERS\./.test(r.caveats[0]) && /does not add them up/.test(r.caveats[0]) && /up to everything this account holds in USDC/.test(r.caveats[0]) && r.caveats[0].includes(`only to ${PAYEE}`));
  check('on-chain lines: token contract and payee, count and first date, end, fee budget, no ERC-1271',
    r.enforced[0] === `Only USDC (contract ${USDC}) transfers to ${PAYEE}, at most 5 USDC each.` &&
      r.enforced[1] === 'At most 2 payments in total: the first from 2026-10-10 00:00 UTC, then one more every 30 days.' &&
      r.enforced[3] === 'Network fees for the payments are paid by your account, at most 0.003 test ETH in total.' && /cannot sign messages, logins or permits/.test(r.enforced[4]));
  check('caveats cover catch-up, the key on this phone (wipe stops payments) and revocation',
    /Missed payments are not lost/.test(r.caveats[1]) && /Wiping the wallet[\s\S]*payments then stop/.test(r.caveats[2]) && /Revoke/.test(r.caveats[3]));
  check('"only while the wallet is open" is stated plainly, with no background work',
    /sent only while this wallet is open/.test(RECURRING_WHILE_OPEN_NOTE) && /Nothing is sent in the\s+background/.test(RECURRING_WHILE_OPEN_NOTE) && /only after you confirm/.test(RECURRING_WHILE_OPEN_NOTE) && /only while this wallet is open/.test(RECURRING_CARD_NOTE));
  check(`the prompt note quotes the vault's real session-key prompt ("${PROMPTS.sessionKeyRead}") and says the phrase is never opened`,
    RECURRING_PAY_PROMPT_NOTE.includes(`"${PROMPTS.sessionKeyRead}"`) && /recovery phrase is never opened/.test(RECURRING_PAY_PROMPT_NOTE));
  check('spending note: limits checked before each payment; the fee is not counted', /checked before each payment/.test(RECURRING_SPENDING_NOTE) && /not counted/.test(RECURRING_SPENDING_NOTE));
  check('short terms warn (2 min × 3 = 8 minutes with the grace) and long ones do not',
    /last only 8 minutes in total \(3 payments of 2 minutes\)/.test(recurringShortWindowWarning({ startAt: 1000, validUntil: 1360, periodSeconds: 120 }) ?? '') && recurringShortWindowWarning({ startAt: 0, validUntil: 3 * DAY, periodSeconds: DAY }) === null);
  check('final dates line: nothing after the grant\'s end (3 × 2 min + 2 min grace)', recurringFinalDatesLine({ ...sub, startAt: 1_800_000_000, validUntil: 1_800_000_000 + 3 * 120, periodSeconds: 120 }) ===
    'Final terms: the first payment is due from 2027-01-15 08:00 UTC, then one more every 2 minutes (3 in total); nothing after 2027-01-15 08:08 UTC.');
}

// ---------------------------------------------------------------------------
console.log('check-recurring: install (same explicit root-signed path) and the stored record');
// ---------------------------------------------------------------------------
const store = memoryStore();
const vault = fakeVault();
const node = fakeNode();
const bundler = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
const bundle = kernelBundle(node, bundler);
const main = await installRecurring({ node, bundle, store, vault });
{
  const { record } = main;
  const vid = sessionVaultId(M, ACCOUNT, record.permissionId);
  check('record: source recurring, terms kept, key held, hand-over time null, installed and active',
    record.source === 'recurring' && record.keyHeld && record.subscription.keyExportedAt === null && record.localStatus === 'installed' && main.status.kind === 'active');
  check('the payment key is in the vault, never in the AsyncStorage-shaped store', vault.map.get(vid) === main.keyHex && !(await store.getItem(SESSIONS_KEY)).toLowerCase().includes(main.keyHex.slice(2)));
  const loaded = (await loadSessions(store)).records;
  check('the list reloads it as recurring; recurringRecords picks it, subscriptionRecords does not',
    loaded.length === 1 && recurringRecords(loaded).length === 1 && subscriptionRecords(loaded).length === 0);
  check('summary line', recurringSummary(record, 'Landlord') === `0.0001 test ETH every 1 day to Landlord (${PAYEE})`, recurringSummary(record, 'Landlord'));
  // A fresh grant on a fresh chain (the main one is installed already).
  const freshNode = fakeNode();
  const freshBundle = kernelBundle(freshNode, fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } }));
  const freshKey = createSessionKeyAccount(ethers.randomBytes(32)).address;
  const freshGrant = recurringGrantFor(main.sub, freshKey, { account: ACCOUNT, now: NOW });
  const pre = await prepareSessionInstall(freshBundle, OWNER_0, ACCOUNT, freshGrant, { now: NOW }).catch((e) => e);
  const noKey = pre instanceof Error ? pre : await caught(() => installSession({
    quote: pre.quote, install: pre.install, grant: freshGrant, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3',
    label: 'x', source: 'recurring', subscription: recurringMeta(main.sub, native), sessionPrivateKey: null, store: memoryStore(), vault: fakeVault(), submit: async () => ({ userOpHash: '0x' + '11'.repeat(32) }),
  }));
  check('a recurring install without the key on this device is refused before anything is stored', /needs its key on this device/.test(noKey?.message ?? ''), noKey?.message);
  const handed = pre instanceof Error ? pre : await caught(() => installSession({
    quote: pre.quote, install: pre.install, grant: freshGrant, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3',
    label: 'x', source: 'recurring', subscription: { ...recurringMeta(main.sub, native), keyExportedAt: 1 }, sessionPrivateKey: ethers.randomBytes(32), store: memoryStore(), vault: fakeVault(), submit: async () => ({ userOpHash: '0x' + '11'.repeat(32) }),
  }));
  check('…and one claiming a hand-over time is refused', /never handed over/.test(handed?.message ?? ''), handed?.message);
  const raw = JSON.parse(await store.getItem(SESSIONS_KEY));
  const k = Object.keys(raw.records)[0];
  const tampered = memoryStore();
  raw.records[k].subscription.keyExportedAt = 1_800_000_000_000;
  await tampered.setItem(SESSIONS_KEY, JSON.stringify(raw));
  const tl = await loadSessions(tampered);
  check('a stored recurring record that claims a hand-over is dropped (flagged corrupt)', tl.records.length === 0 && tl.corrupt);
  const stripped = memoryStore();
  const raw2 = JSON.parse(await store.getItem(SESSIONS_KEY));
  delete raw2.records[k].subscription;
  await stripped.setItem(SESSIONS_KEY, JSON.stringify(raw2));
  check('a recurring record without terms is dropped', (await loadSessions(stripped)).records.length === 0);
}

// ---------------------------------------------------------------------------
console.log('check-recurring: the key is never handed over');
// ---------------------------------------------------------------------------
{
  const { record } = main;
  const vid = sessionVaultId(M, ACCOUNT, record.permissionId);
  const loadsBefore = vault.loads;
  const exp = await caught(() => buildSubscriptionKeyExport(record, vault));
  check('the hand-over payload is refused for a recurring payment, without reading the vault', exp?.message === RECURRING_KEY_NEVER_EXPORTED && vault.loads === loadsBefore);
  const mark = await caught(() => markSubscriptionKeyExported(record, store, vault));
  check('"the merchant has the key" is refused; the key stays in the vault', mark?.message === RECURRING_KEY_NEVER_EXPORTED && vault.map.has(vid));
  const rel = await caught(() => releaseSessionKey(record, store, vault));
  check('releaseSessionKey refuses a recurring payment (only revoke, forget or a wipe remove its key)', /never leaves this device/.test(rel?.message ?? '') && vault.map.has(vid));
  check('no hand-over offer, no subscription key line, no Test button', subscriptionHandoverOffer(record, { kind: 'active', expired: false }) === 'none' && subscriptionKeyStatusText(record) === '' && sessionCanBeTested(record) === false);
  check('the review\'s key-holder phrase has no nested parentheses and says the key never leaves the phone',
    `Session key (held by ${RECURRING_KEY_HOLDER_TEXT})`.match(/\(/g).length === 1 && /never shown or exported/.test(RECURRING_KEY_HOLDER_TEXT));
  check('key status line', recurringKeyStatusText(record) === 'Payment key on this phone only (never shown or exported); deleted from this phone when you revoke.');
  const screen = src('../src/screens/SessionsScreen.tsx');
  const section = body(screen, 'Recurring payments</Text>', '>Subscriptions</Text>');
  check('the recurring cards offer no key hand-over, no key screen and no Test button (source)',
    section.length > 500 && !/onShowKey|Hand the key|onTest\(|SubscriptionKeyHandover/.test(section));
  check('the recurring card states "only while the wallet is open" (source)', screen.includes('{RECURRING_CARD_NOTE}') && screen.includes('<WarningBox>{RECURRING_WHILE_OPEN_NOTE}</WarningBox>'));
}

// ---------------------------------------------------------------------------
console.log('check-recurring: due detection (RateLimitPolicy semantics)');
// ---------------------------------------------------------------------------
{
  const { record } = main;
  const S = 1_800_000_000;
  const terms = { ...JSON.parse(JSON.stringify(record.subscription.terms)), startAt: S, validUntil: S + 3 * 120, periodSeconds: 120 };
  // The installed grant ends one period after the terms (grace): S + 480.
  const rec = { ...record, grant: { ...record.grant, validUntil: S + 480 }, subscription: { ...record.subscription, terms } };
  const st = (over) => ({ kind: 'ok', state: { rateLimitStatus: 'live', remainingPulls: 3, nextSlotAt: S, intervalSeconds: 120, feeBudgetLeftWei: 10n ** 16n, validUntil: S + 480, ...over }, next: { kind: 'now' } });
  const at = (over, now) => recurringDueState(rec, st(over), now);
  check('one second before the first slot: later (at the start)', at({}, S - 1).kind === 'later' && at({}, S - 1).at === S);
  check('exactly at the slot: due (validAfter <= block time), one open slot, 0 of 3 sent', (() => { const d = at({}, S); return d.kind === 'due' && d.openSlots === 1 && d.sent === 0 && d.total === 3; })());
  check('after one payment (count 2, start + 1 period): later until S + 120, due at S + 120',
    at({ remainingPulls: 2, nextSlotAt: S + 120 }, S + 119).kind === 'later' && at({ remainingPulls: 2, nextSlotAt: S + 120 }, S + 120).kind === 'due' && at({ remainingPulls: 2, nextSlotAt: S + 120 }, S + 120).sent === 1);
  check('catch-up: at S + 250 with nothing sent, 3 slots are open (missed periods are not lost)', at({}, S + 250).openSlots === 3);
  check('catch-up is capped by the remaining count', at({ remainingPulls: 2, nextSlotAt: S }, S + 359).openSlots === 2);
  check('catch-up stops at the end date (a slot that opens after validUntil does not count)',
    openSlotCount({ nextSlotAt: S, intervalSeconds: 120, remainingPulls: 5, validUntil: S + 200 }, S + 199) === 2 && openSlotCount({ nextSlotAt: S, intervalSeconds: 120, remainingPulls: 5, validUntil: S + 200 }, S + 500) === 2);
  check('no slot open: 0', openSlotCount({ nextSlotAt: S + 10, intervalSeconds: 120, remainingPulls: 3, validUntil: S + 360 }, S) === 0);
  const usedUp = at({ remainingPulls: 0, nextSlotAt: S + 360 }, S + 100);
  check('count exhausted: completed, all sent', usedUp.kind === 'completed' && usedUp.reason === 'all-sent' && usedUp.sent === 3);
  const late = at({ remainingPulls: 1, nextSlotAt: S + 240 }, S + 400);
  check('GRACE: after the terms\' end (S + 360) the last payment is still due until the grant\'s end (S + 480)',
    late.kind === 'due' && late.openSlots === 1 && late.sent === 2 && at({ remainingPulls: 1, nextSlotAt: S + 240 }, S + 480).kind === 'due');
  check('…and the count still bounds it: with all 3 sent, nothing more is due inside the grace period',
    at({ remainingPulls: 0, nextSlotAt: S + 360 }, S + 400).kind === 'completed' && openSlotCount({ nextSlotAt: S + 240, intervalSeconds: 120, remainingPulls: 1, validUntil: S + 480 }, S + 479) === 1);
  const ended = at({ remainingPulls: 2, nextSlotAt: S + 120 }, S + 481);
  check('end date (the grant\'s) passed with payments left: completed (ended), 1 of 3 sent', ended.kind === 'completed' && ended.reason === 'ended' && ended.sent === 1);
  check('revoked on-chain (RateLimitPolicy status deprecated): inactive', at({ rateLimitStatus: 'deprecated' }, S).kind === 'inactive');
  check('read failure: unknown with the reason', recurringDueState(rec, { kind: 'unknown', reason: 'the network endpoint did not answer' }, S).kind === 'unknown');
  check('set-up not confirmed / key gone / revoked locally: not ready (nothing offered)',
    recurringDueState({ ...rec, localStatus: 'installing' }, st({}), S).kind === 'not-ready' &&
      recurringDueState({ ...rec, keyHeld: false }, st({}), S).kind === 'not-ready' &&
      recurringDueState({ ...rec, localStatus: 'revoked' }, st({}), S).kind === 'not-ready');
  check('a subscription record is never treated as a recurring payment', recurringDueState({ ...rec, source: 'subscription' }, st({}), S).kind === 'not-ready');
  const lines = (over, now) => recurringStatusLines(rec, at(over, now), 'test ETH');
  check('lines: due now / sent count / fee budget left',
    json(lines({}, S)) === json([`Payment due now (since 2027-01-15 08:00 UTC).`, '0 of 3 payments sent.', 'Fee budget left: 0.01 test ETH.']), json(lines({}, S)));
  check('lines: catch-up says how many were missed and that they go one at a time',
    lines({}, S + 250)[0] === '3 payments due now (the first since 2027-01-15 08:00 UTC). 2 were missed; your account allows them to be sent now, one at a time.', lines({}, S + 250)[0]);
  check('lines: later, completed (all sent), completed (ended)',
    lines({ remainingPulls: 2, nextSlotAt: S + 120 }, S + 5)[0] === 'Next payment: not before 2027-01-15 08:02 UTC.' &&
      lines({ remainingPulls: 0, nextSlotAt: S + 360 }, S + 5)[0] === 'Completed: all 3 payments were sent.' &&
      lines({ remainingPulls: 2, nextSlotAt: S + 120 }, S + 500)[0] === 'Ended 2027-01-15 08:08 UTC: 1 of 3 payments were sent; 2 were not sent before the end date.',
    lines({ remainingPulls: 2, nextSlotAt: S + 120 }, S + 500)[0]);
  check('ended line: one unsent payment in the singular; an "ended" count with nothing unsent has no unsent clause',
    recurringEndedLine(rec, { sent: 2, total: 3 }) === 'Ended 2027-01-15 08:08 UTC: 2 of 3 payments were sent; 1 was not sent before the end date.' &&
      recurringEndedLine(rec, { sent: 3, total: 3 }) === 'Ended 2027-01-15 08:08 UTC: 3 of 3 payments were sent.' && !/^Completed:/.test(recurringEndedLine(rec, { sent: 2, total: 3 })));
  check('the completed box no longer opens with "Completed:" (it also shows for an ended grant with payments unsent)',
    RECURRING_COMPLETED_TEXT === 'No more payments can be sent. Revoke it to remove the permission from your account (the payment key is deleted from this phone too); it is then forgotten here.');
  check('headline', recurringDueHeadline(0) === null && recurringDueHeadline(1) === '1 recurring payment is due. Each is sent only after you confirm it on the Sessions screen.' && /^2 recurring payments are due\./.test(recurringDueHeadline(2)));
  // Against the fake node: the on-chain read moves with emulated payments.
  const d0 = recurringDueState(record, { kind: 'ok', state: { rateLimitStatus: 'live', remainingPulls: 3, nextSlotAt: NOW, intervalSeconds: DAY, feeBudgetLeftWei: 1n, validUntil: NOW + 3 * DAY }, next: { kind: 'now' } }, NOW);
  check('fresh install against the fake chain: due right away (the first payment is due at Start)', d0.kind === 'due');
}

// ---------------------------------------------------------------------------
console.log('check-recurring: the foreground check never reads a key or sends');
// ---------------------------------------------------------------------------
{
  const { record } = main;
  const s2 = memoryStore();
  // One due recurring payment, one subscription (ignored), one of another owner and one on another chain (ignored).
  await saveSessionRecord(record, s2);
  await saveSessionRecord({ ...record, permissionId: '0x00000001', source: 'subscription' }, s2);
  await saveSessionRecord({ ...record, permissionId: '0x00000002', owner: '0x000000000000000000000000000000000000dEaD' }, s2);
  const reads = [];
  const sendsBefore = bundler.calls.length;
  const loadsBefore = vault.loads;
  const nodeBefore = node.calls.length;
  const found = await findDueRecurringPayments({
    chain: M, owner: OWNER_0, store: s2, now: NOW,
    readStatus: async (r) => {
      reads.push(r.permissionId);
      const { readSubscriptionStatus } = await import('../src/wallet/subscriptions.ts');
      return readSubscriptionStatus(node, r, NOW);
    },
  });
  check('finds exactly the due recurring payment of this owner on this chain', found.due.length === 1 && found.checked === 1 && reads.length === 1 && found.due[0].due.kind === 'due');
  check('…with ZERO bundler calls and ZERO key reads (only read-only node calls)',
    bundler.calls.length === sendsBefore && vault.loads === loadsBefore && node.calls.slice(nodeBefore).every((c) => c.method === 'eth_call'));
  const empty = memoryStore();
  let asked = 0;
  const none = await findDueRecurringPayments({ chain: M, owner: OWNER_0, store: empty, readStatus: async () => { asked += 1; throw new Error('x'); } });
  check('no recurring payment on this device: no network request at all', none.due.length === 0 && asked === 0);
  let mainnetAsked = 0;
  const mn = await findDueRecurringPayments({ chain: 'eip155:1', owner: OWNER_0, store: s2, readStatus: async () => { mainnetAsked += 1; throw new Error('x'); } });
  check('mainnet (session keys not cleared): nothing checked', mn.due.length === 0 && mainnetAsked === 0);
  const banner = src('../src/components/RecurringDueBanner.tsx');
  check('the banner uses the read-only check and has no path to a payment, a key or the phrase (source)',
    banner.includes('findDueRecurringPayments(') && !/payRecurringPayment|planRecurringPayment|runRecurringPayment|sendSessionCalls|sessionKeyVault|requireLocalAuth|signWith|storage'/.test(banner));
  const rsrc = src('../src/wallet/recurring.ts');
  const finder = body(rsrc, 'export async function findDueRecurringPayments', '\n}\n');
  check('findDueRecurringPayments has no vault, bundler or send (source)', finder.length > 200 && !/sendSessionCalls|payRecurringPayment|vault|bundler/i.test(finder.replace(/\/\*[\s\S]*?\*\//g, '')));
  const app = src('../../app/App.tsx');
  check('App.tsx mounts the banner inside the navigation container, after the navigator',
    /<\/Stack\.Navigator>[\s\S]{0,300}<RecurringDueBanner \/>[\s\S]{0,40}<\/NavigationContainer>/.test(app));
  check('the banner re-checks when the app returns to the foreground (source)', /AppState\.addEventListener\('change'/.test(banner) && /next === 'active'/.test(banner));
}

// ---------------------------------------------------------------------------
console.log('check-recurring: confirm before submit');
// ---------------------------------------------------------------------------
{
  const order = [];
  const plan = { tag: 'plan' };
  const declined = await runRecurringPayment({
    plan: async () => (order.push('plan'), plan),
    confirm: async () => (order.push('confirm'), false),
    pay: async () => (order.push('pay'), 'sent'),
  });
  check('declined: pay is never called', declined.outcome === 'cancelled' && order.join() === 'plan,confirm');
  order.length = 0;
  const truthy = await runRecurringPayment({ plan: async () => plan, confirm: async () => 'yes', pay: async () => (order.push('pay'), 'sent') });
  check('only an exact true confirms (a truthy non-boolean does not)', truthy.outcome === 'cancelled' && order.length === 0);
  order.length = 0;
  const ok = await runRecurringPayment({
    plan: async () => (order.push('plan'), plan),
    confirm: async (p) => (order.push(p === plan ? 'confirm(plan)' : 'confirm(?)'), true),
    pay: async (p) => (order.push(p === plan ? 'pay(plan)' : 'pay(?)'), 'sent'),
  });
  check('confirmed: plan → confirm(plan) → pay(plan), in that order', ok.outcome === 'sent' && ok.result === 'sent' && order.join() === 'plan,confirm(plan),pay(plan)', order.join());
  order.length = 0;
  const err = await caught(() => runRecurringPayment({
    plan: async () => { throw new RecurringNotDueError('not due', { kind: 'inactive' }); },
    confirm: async () => (order.push('confirm'), true),
    pay: async () => (order.push('pay'), 'sent'),
  }));
  check('a plan that fails never reaches the dialog or the payment', err instanceof RecurringNotDueError && order.length === 0);

  const screen = src('../src/screens/SessionsScreen.tsx');
  check('the screen sends a recurring payment in exactly one place: the pay step of runRecurringPayment (source)',
    (screen.match(/payRecurringPayment\(/g) ?? []).length === 1 && /runRecurringPayment\(\{[\s\S]{0,200}plan: \(\) => activeEvmNodeRunner\(\(node\) => planRecurringPayment\(\{ node, record \}\), \{ isFailure: isRecurringNodeFailure \}\),[\s\S]{0,40}confirm: \(plan\) => \{[\s\S]{0,120}return confirmPaymentDialog\(plan\);[\s\S]{0,80}\},\s*pay: \(plan\) => \{[\s\S]{0,80}return quoteOnNode\(\(b\) => payRecurringPayment\(\{ bundle: b, plan, vault: sessionKeyVault \}\)\)/.test(screen));
  const dialog = body(screen, 'const confirmPaymentDialog =', 'const onPayNow =');
  check('the dialog resolves true only from "Send payment"; Cancel and dismiss resolve false (source)',
    /text: 'Cancel', style: 'cancel', onPress: \(\) => resolve\(false\)/.test(dialog) && /text: 'Send payment', onPress: \(\) => resolve\(true\)/.test(dialog) && /onDismiss: \(\) => resolve\(false\)/.test(dialog) && (dialog.match(/resolve\(true\)/g) ?? []).length === 1);
  const refresh = body(screen, 'const refreshRecord = useCallback(', 'const reloadList = useCallback(');
  const reload = body(screen, 'const reloadList = useCallback(', 'useFocusEffect(reloadList)');
  check('loading, focusing and refreshing never pay (source)', refresh.length > 100 && reload.length > 50 && !/onPayNow|runRecurringPayment|payRecurringPayment/.test(refresh + reload));
  check('the only caller of onPayNow is the card\'s "Send the payment now" button (source)',
    (screen.match(/onPayNow\(/g) ?? []).length === 1 && /title="Send the payment now"[\s\S]{0,260}onPress=\{\(\) => void onPayNow\(r\)\}/.test(screen));
  const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const onPay = code(body(screen, 'const onPayNow = async', 'const onRevokeQuote = async'));
  check('a payment never opens the recovery phrase or the owner key: no requireLocalAuth or signWith on the payment path (source)',
    onPay.length > 200 && !/requireLocalAuth|signWith/.test(onPay) && !/requireLocalAuth|signWith/.test(code(dialog)));
}

// ---------------------------------------------------------------------------
console.log('check-recurring: a payment, signed by the payment key alone');
// ---------------------------------------------------------------------------
{
  const { record } = main;
  const loadsBefore = vault.loads;
  const plan = await planRecurringPayment({ node, record, now: NOW });
  check('plan: due, one transfer of the full amount to the payee, no key read, no bundler call',
    plan.due.kind === 'due' && same(plan.call.to, PAYEE) && plan.call.value === 100_000_000_000_000n && plan.call.data.length === 0 && vault.loads === loadsBefore);
  const msg = recurringConfirmMessage(plan, { nativeSymbol: 'test ETH', payeeName: 'Landlord' });
  check('confirmation text: amount, payee, smart account, the signer, fee source and the exact prompts',
    msg.startsWith(`Send 0.0001 test ETH to Landlord (${PAYEE}) from your smart account ${ACCOUNT}.`) && /fee budget \(0\.01 test ETH left\)/.test(msg) && msg.endsWith(RECURRING_PAY_PROMPT_NOTE), msg);
  check('the dialog says ONCE that the payment key signs, not the account key (finding 5)',
    (msg.match(/not your account key/g) ?? []).length === 1 && !/own key signs it/.test(msg) && msg === `Send 0.0001 test ETH to Landlord (${PAYEE}) from your smart account ${ACCOUNT}. The network fee comes from your smart account and counts against the fee budget (0.01 test ETH left). ${RECURRING_PAY_PROMPT_NOTE}`, msg);
  const { userOpHash } = await payRecurringPayment({ bundle, plan, vault, store, now: NOW });
  const op = fromRpcOp(bundler.lastOp);
  const hash = getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID);
  const signer = ethers.recoverAddress(ethers.hashMessage(hash), toHex(op.signature.slice(1)));
  check('op: sender = the Kernel account, nonce on the permission key, signature 0xff + 65 bytes',
    same(op.sender, ACCOUNT) && op.nonce >> 64n === sessionNonceKey(record.permissionId) && op.signature.length === 66 && op.signature[0] === 0xff && typeof userOpHash === 'string');
  check('signature recovers (ethers) to the PAYMENT key, not the owner', same(signer, main.keyAddress) && !same(signer, OWNER_0));
  const exec = decodeKernelExecute(op.callData);
  check('calldata executes exactly one plain transfer of 0.0001 test ETH to the payee (ethers decode)',
    exec.callType === 0 && exec.calls.length === 1 && same(exec.calls[0].to, PAYEE) && exec.calls[0].value === 100_000_000_000_000n && exec.calls[0].data === '0x');
  check('the payment key was read exactly once', vault.loads === loadsBefore + 1);
  node.paid(record.permissionId);
  const after = await caught(() => planRecurringPayment({ node, record, now: NOW + 5 }));
  check('right after a payment the next one is refused locally as not due (no key read, no bundler call)',
    after instanceof RecurringNotDueError && /not due yet: the next one can be sent from /.test(after.message) && /Nothing was sent\./.test(after.message));

  // USDC (an ERC-20) on the same path.
  const s3 = memoryStore();
  const v3 = fakeVault();
  const n3 = fakeNode();
  const b3 = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
  const k3 = kernelBundle(n3, b3);
  const u = await installRecurring({ node: n3, bundle: k3, store: s3, vault: v3, choice: usdc, amount: '5' });
  const up = await planRecurringPayment({ node: n3, record: u.record, now: NOW });
  await payRecurringPayment({ bundle: k3, plan: up, vault: v3, store: s3, now: NOW });
  const ue = decodeKernelExecute(fromRpcOp(b3.lastOp).callData);
  const [to, amount] = new ethers.Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer', ue.calls[0].data);
  check('USDC: one call to the token contract, transfer(payee, 5 USDC), no value', ue.calls.length === 1 && same(ue.calls[0].to, USDC) && ue.calls[0].value === 0n && same(to, PAYEE) && amount === 5_000_000n);
}

// ---------------------------------------------------------------------------
console.log('check-recurring: no recovery-phrase read during a payment (real vault, fake secure store)');
// ---------------------------------------------------------------------------
function secureStoreShim() {
  const items = new Map();
  const shim = {
    gets: [],
    prompts: [],
    whenUnlockedThisDeviceOnly: 7,
    canUseBiometricAuthentication: () => true,
    async getItemAsync(key, opts) {
      shim.gets.push(key);
      const rec = items.get(`${opts?.keychainService ?? 'default'}|${key}`);
      if (!rec) return null;
      if (rec.auth) shim.prompts.push(opts?.authenticationPrompt);
      return rec.value;
    },
    async setItemAsync(key, value, opts) {
      if (opts?.requireAuthentication) shim.prompts.push(opts.authenticationPrompt);
      items.set(`${opts?.keychainService ?? 'default'}|${key}`, { value, auth: !!opts?.requireAuthentication });
    },
    async deleteItemAsync(key, opts) {
      items.delete(`${opts?.keychainService ?? 'default'}|${key}`);
    },
  };
  return shim;
}
for (const protectedPhrase of [true, false]) {
  const shim = secureStoreShim();
  const kv = createKeyVault(shim);
  await kv.saveNewPhrase(TEST_MNEMONIC);
  if (protectedPhrase) {
    const up = await kv.upgrade({ prompt: 'write', checkPrompt: 'check' });
    if (up.outcome !== 'protected') check('setup: the phrase moved to protected storage', false, JSON.stringify(up));
  }
  const s4 = memoryStore();
  const n4 = fakeNode();
  const b4 = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
  const k4 = kernelBundle(n4, b4);
  const r4 = await installRecurring({ node: n4, bundle: k4, store: s4, vault: kv.sessionKeys });
  const plan = await planRecurringPayment({ node: n4, record: r4.record, now: NOW });
  shim.gets.length = 0;
  shim.prompts.length = 0;
  await payRecurringPayment({ bundle: k4, plan, vault: kv.sessionKeys, store: s4, now: NOW });
  const phraseReads = shim.gets.filter((k) => k === MNEMONIC_KEY || k === PROTECTED_MNEMONIC_KEY);
  const label = protectedPhrase ? 'protected phrase' : 'standard phrase';
  check(`${label}: ZERO recovery-phrase reads during the payment`, phraseReads.length === 0, shim.gets.join(', '));
  check(`${label}: the secure store was asked only for this payment's key`,
    shim.gets.length > 0 && shim.gets.every((k) => k.endsWith(sessionVaultId(M, ACCOUNT, r4.record.permissionId))), shim.gets.join(', '));
  check(`${label}: system prompts during the payment = ${protectedPhrase ? `["${PROMPTS.sessionKeyRead}"]` : 'none'}`,
    json(shim.prompts) === json(protectedPhrase ? [PROMPTS.sessionKeyRead] : []), json(shim.prompts));
  check(`${label}: the operation is signed by the payment key`, same(ethers.recoverAddress(ethers.hashMessage(getUserOpHash(fromRpcOp(b4.lastOp), ENTRYPOINT_V07, CHAIN_ID)), toHex(fromRpcOp(b4.lastOp).signature.slice(1))), r4.keyAddress));
}
{
  const rsrc = src('../src/wallet/recurring.ts');
  check('recurring.ts has no path to the phrase or the owner key (no storage, biometric, WalletContext import; no signWith)',
    !/from '\.\/storage|from '\.\/biometric|WalletContext|signWith\(|loadMnemonic|mnemonicToSeed|requireLocalAuth/.test(rsrc));
}

// ---------------------------------------------------------------------------
console.log('check-recurring: spending limits (this app only) before a payment');
// ---------------------------------------------------------------------------
{
  const s5 = memoryStore();
  const v5 = fakeVault();
  const n5 = fakeNode();
  const b5 = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
  const k5 = kernelBundle(n5, b5);
  const r5 = await installRecurring({ node: n5, bundle: k5, store: s5, vault: v5 });
  const scope = { chain: M, owner: OWNER_0 };
  const policy = await saveSpendingPolicy(scope, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 50_000_000_000_000n, windowSeconds: 3600 }, [NATIVE_TOKEN], { store: s5, now: NOW });
  const plan = await planRecurringPayment({ node: n5, record: r5.record, now: NOW });
  const sendsBefore = b5.calls.filter((c) => c.method === 'eth_sendUserOperation').length;
  const loadsBefore = v5.loads;
  const blocked = await caught(() => payRecurringPayment({ bundle: k5, plan, vault: v5, store: s5, now: NOW }));
  check('over a limit: refused with the over-limit sentence, never sent over a limit, no "send anyway"',
    blocked instanceof RecurringSpendingError && blocked.title === 'Over your spending limit' && /would go over your spending limit for test ETH/.test(blocked.message) &&
      /never sent over a limit/.test(blocked.message) && !/Send anyway/.test(blocked.message));
  check('…before the key is read and before any bundler call', v5.loads === loadsBefore && b5.calls.filter((c) => c.method === 'eth_sendUserOperation').length === sendsBefore);
  await saveSpendingPolicy(scope, { id: policy.id, token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 10n ** 18n, windowSeconds: 3600 }, [NATIVE_TOKEN], { store: s5, now: NOW });
  const { userOpHash } = await payRecurringPayment({ bundle: k5, plan, vault: v5, store: s5, now: NOW });
  const hist = await listSpendRecords(scope, s5);
  check('within the limit: sent, and recorded after acceptance with the payment amount and the userOpHash',
    hist.records.length === 1 && hist.records[0].amount === 100_000_000_000_000n && hist.records[0].ref === userOpHash && hist.records[0].kind === 'transfer');
  const damaged = memoryStore();
  await damaged.setItem('shiba-wallet.spending-policies.v1', '{broken');
  const loads2 = v5.loads;
  const unreadable = await caught(() => payRecurringPayment({ bundle: k5, plan, vault: v5, store: damaged, now: NOW }));
  check('unreadable limits fail closed: refused, no key read', unreadable instanceof RecurringSpendingError && unreadable.title === 'Spending limits could not be checked' && /Nothing was sent\./.test(unreadable.message) && v5.loads === loads2);
  // A bundler refusal: nothing recorded.
  const b6 = fakeBundler({ sendError: 'RPC error -32500: UserOperation reverted with reason: AA22 expired or not due (eth_sendUserOperation)' });
  const k6 = kernelBundle(n5, b6);
  const before = (await listSpendRecords(scope, s5)).records.length;
  const refused = await caught(() => payRecurringPayment({ bundle: k6, plan, vault: v5, store: s5, now: NOW }));
  check('a payment the bundler refuses is not recorded in the spending history', refused instanceof Error && (await listSpendRecords(scope, s5)).records.length === before);
}

// ---------------------------------------------------------------------------
console.log('check-recurring: refusals in plain words');
// ---------------------------------------------------------------------------
{
  check('selectors pinned against ethers: CallViolatesValueRule 0x7b5812d4, CallViolatesParamRule 0x59d52e40, PolicyFailed 0x3e4983f6',
    sel('CallViolatesValueRule()') === '0x7b5812d4' && sel('CallViolatesParamRule()') === '0x59d52e40' && sel('PolicyFailed(uint256)') === '0x3e4983f6');
  const live = {
    early: 'RPC error -32500: UserOperation reverted with reason: AA22 expired or not due (eth_sendUserOperation)',
    overCap: 'RPC error -32500: UserOperation reverted during simulation with reason: AA23 reverted 0x7b5812d4 (eth_estimateUserOperationGas)',
    param: 'RPC error -32500: AA23 reverted 0x59d52e40',
    exhausted: 'RPC error -32500: UserOperation reverted during simulation with reason: AA23 reverted 0x3e4983f60000000000000000000000000000000000000000000000000000000000000003 (eth_estimateUserOperationGas)',
    gas: 'RPC error -32500: AA23 reverted 0x3e4983f60000000000000000000000000000000000000000000000000000000000000002',
    revoked: 'RPC error -32500: UserOperation reverted during simulation with reason: AA23 reverted 0x (eth_estimateUserOperationGas)',
  };
  check('AA22 (the live early-pull text of phase 12) → not due yet', /it is not due yet, or the recurring payment has ended\. Nothing was paid\./.test(recurringRefusalSentence(live.early) ?? ''));
  check('CallViolatesValueRule → above the cap', /above the cap per payment/.test(recurringRefusalSentence(live.overCap) ?? ''));
  check('CallViolatesParamRule → recipient or amount outside the terms', /recipient or the amount is outside the terms/.test(recurringRefusalSentence(live.param) ?? ''));
  check('PolicyFailed(3) → payments used up or not due; PolicyFailed(2) → fee budget used up',
    /already sent, or the next one is not due yet/.test(recurringRefusalSentence(live.exhausted) ?? '') && /fee budget is used up/.test(recurringRefusalSentence(live.gas) ?? ''));
  check('AA23 with empty revert data → revoked', /not installed any more/.test(recurringRefusalSentence(live.revoked) ?? ''));
  check('unknown text → no sentence (falls back to the session wording)', recurringRefusalSentence('RPC error -32000: boom') === null);
  const d = describeRecurringPaymentError(new Error(live.overCap), { accountType: 'kernel-v3.3', symbol: 'test ETH' }, describeSendError);
  check('described: "Payment not sent", the sentence, then the bundler text as technical detail (no URL)',
    d.title === RECURRING_REFUSED_TITLE && /^Your account refused this payment: the amount is above the cap per payment\. Nothing was paid\.\n\nTechnical detail: JSON-RPC error -32500: .*AA23 reverted 0x7b5812d4/.test(d.detail), d.detail);
  const withUrl = describeRecurringPaymentError(new Error('RPC error -32500: AA22 expired or not due https://rpc.zerodev.app/api/v3/secret/chain/11155111'), { accountType: 'kernel-v3.3', symbol: 'x' }, describeSendError);
  check('an endpoint URL in a refusal never reaches the screen', !/https?:|zerodev|secret/.test(withUrl.detail), withUrl.detail);
  check('not-due and spending errors keep their own words',
    describeRecurringPaymentError(new RecurringNotDueError('This payment is not due yet.', { kind: 'inactive' }), { accountType: 'kernel-v3.3', symbol: 'x' }, describeSendError).detail === 'This payment is not due yet.' &&
      describeRecurringPaymentError(new RecurringSpendingError('T', 'M'), { accountType: 'kernel-v3.3', symbol: 'x' }, describeSendError).title === 'T');
  const screen = src('../src/screens/SessionsScreen.tsx');
  const refusal = body(screen, 'const showPayRefusal = (', 'const confirmPaymentDialog =');
  check('a refused payment: alert + reason kept on the card + status re-read; the record is not removed (source)',
    /Alert\.alert\(title, detail\)/.test(refusal) && /setPayRefusals\(\(prev\) => \(\{ \.\.\.prev, \[key\]: recurringAttemptLine\(outcome, detail\) \}\)\)/.test(refusal) && /refreshRecord\(record\)/.test(refusal) && !/forget|writeRecord|resetSessions/i.test(refusal));
}

// ---------------------------------------------------------------------------
console.log('check-recurring: revoke (key deleted as for every session), completion and wipe');
// ---------------------------------------------------------------------------
{
  const s7 = memoryStore();
  const v7 = fakeVault();
  const n7 = fakeNode();
  const b7 = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
  const k7 = kernelBundle(n7, b7);
  const r7 = await installRecurring({ node: n7, bundle: k7, store: s7, vault: v7 });
  const vid = sessionVaultId(M, ACCOUNT, r7.record.permissionId);
  const q = await prepareSessionRevoke(k7, OWNER_0, r7.record);
  const rev = await revokeSession({ record: r7.record, quote: q, store: s7, vault: v7, submit: (qq) => sendAa(k7, owner, qq) });
  check('revocation (owner-signed): the payment key is deleted from the vault once the bundler accepts, record revoking', !v7.map.has(vid) && rev.record.keyHeld === false && rev.record.localStatus === 'revoking');
  const recovered = ethers.recoverAddress(ethers.hashMessage(getUserOpHash(fromRpcOp(b7.lastOp), ENTRYPOINT_V07, CHAIN_ID)), toHex(fromRpcOp(b7.lastOp).signature));
  check('…signed by the OWNER as root (the payment key cannot revoke)', same(recovered, OWNER_0));
  const nowKeyless = await caught(() => planRecurringPayment({ node: n7, record: rev.record, now: NOW }));
  check('after revoking nothing can be paid (not ready, plain text)', nowKeyless instanceof RecurringNotDueError && /revoked/.test(nowKeyless.message));
  check('revoke copy and prompt say "recurring payment"',
    revokeConfirmCopy({ source: 'recurring' }, 'Rent').button === 'Revoke recurring payment' && revokeConfirmCopy({ source: 'recurring' }, 'Rent').heading === 'Stop recurring payment “Rent”' &&
      revokeApprovalPrompt({ source: 'recurring' }) === 'Approve revoking this recurring payment');
  check('progress titles', sessionProgressTitle('recurring') === 'Recurring payment set-up sent to the bundler' && sessionProgressTitle('recurring-payment') === 'Payment sent to the bundler' &&
    sessionProgressTitle('recurring-revoke') === 'Recurring payment revocation sent to the bundler');
  const screen = src('../src/screens/SessionsScreen.tsx');
  check('a completed recurring payment offers "Revoke and forget", which forgets only after the chain shows it revoked (source)',
    /title="Revoke and forget"[\s\S]{0,120}onRevokeQuote\(r, \{ forgetAfter: true \}\)/.test(screen) &&
      /if \(target\.forgetAfter && receipt\.success !== false && status\.kind === 'revoked'\) \{\s*forgetSession\(/.test(screen));
  check('the review and install use the recurring wording and source (source)',
    screen.includes("await requireLocalAuth('Approve this recurring payment')") && /source: 'recurring' as const, subscription: recurringMeta\(/.test(screen) && screen.includes("const startButton = recurring ? 'Start recurring payment' : 'Start subscription';"));
  // Wipe: every key the list knows, recurring included.
  const s8 = memoryStore();
  const v8 = fakeVault();
  const n8 = fakeNode();
  const k8 = kernelBundle(n8, fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } }));
  const r8 = await installRecurring({ node: n8, bundle: k8, store: s8, vault: v8 });
  const w = await forgetAllSessions(s8, v8);
  check('wallet wipe deletes the recurring payment key and the list', w.keysRemoved === 1 && v8.map.size === 0 && (await loadSessions(s8)).records.length === 0 && r8.record.keyHeld);
}

// ---------------------------------------------------------------------------
console.log('check-recurring: mainnet readiness');
// ---------------------------------------------------------------------------
{
  const v9 = fakeVault();
  const mainnetRecord = { ...main.record, chain: 'eip155:1' };
  const nodeCalls = node.calls.length;
  const e1 = await caught(() => planRecurringPayment({ node, record: mainnetRecord, now: NOW }));
  check('planning a mainnet payment is refused before any request', /only on test networks|test networks/.test(e1?.message ?? '') && node.calls.length === nodeCalls, e1?.message);
  const e2 = await caught(() => payRecurringPayment({ bundle, plan: { record: mainnetRecord, terms: JSON.parse('{}'), call: { to: PAYEE, value: 1n, data: new Uint8Array(0) }, due: { kind: 'due' } }, vault: v9 }));
  check('paying a mainnet plan is refused before the vault is read', /test networks/.test(e2?.message ?? '') && v9.loads === 0, e2?.message);
}

// ---------------------------------------------------------------------------
console.log('check-recurring: network failures in plain words, never "refused" (2026-10-09 rehearsal, finding 1)');
// ---------------------------------------------------------------------------
/** The exact shape Expo SDK 57's fetch throws (expo/src/winter/fetch/FetchErrors.ts: a plain Error, NOT a TypeError). */
const expoFetchError = (host = 'ethereum-sepolia-rpc.publicnode.com') =>
  new Error(`fetch failed: java.net.UnknownHostException: Unable to resolve host "${host}": No address associated with hostname`);
const noJava = (t) => !/java\.net|UnknownHostException/.test(t);
{
  const e = expoFetchError();
  // The root cause of the raw alert was that endpoint-probe's isEndpointFailure
  // accepted "fetch failed" only on a TypeError, while Expo's fetch throws a
  // plain Error; it now recognises the Expo shape app-wide, and sessions.ts
  // keeps its own clause as a harmless second line.
  check('endpoint-probe isEndpointFailure now recognises the Expo shape app-wide (it is not a TypeError)', isEndpointFailure(e) && !(e instanceof TypeError));
  check('sessions.ts isTransportFailure recognises it; the engine\'s "UTXO fetch failed: HTTP 400" answer and a revert are not transport failures',
    isTransportFailure(e) && !isTransportFailure(new Error('UTXO fetch failed: HTTP 400 for bc1q')) && !isTransportFailure(new Error('RPC error 3: execution reverted')) && isTransportFailure(new TypeError('Network request failed')));
  const st = unknownStatusFrom(expoFetchError());
  check('status read: "the network endpoint did not answer" with the cleaned detail, flagged for failover, no Java class',
    st.endpointFailure === true && st.reason.startsWith('the network endpoint did not answer (') && noJava(st.reason) && /Unable to resolve host/.test(st.reason), st.reason);
  const label = sessionStatusText(st);
  const { record } = main;
  const unknownDue = recurringDueState(record, st, NOW);
  check('the card shows "Status unknown: …" ONCE: the due lines skip the same line the status label shows',
    json(recurringStatusLines(record, unknownDue, 'test ETH', label)) === json([]) && json(recurringStatusLines(record, unknownDue, 'test ETH')) === json([label]));

  // Payment step: the node does not answer at the FIRST request (chain id), before the key is read.
  const s10 = memoryStore();
  const v10 = fakeVault();
  const n10 = fakeNode();
  const b10 = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
  const k10 = kernelBundle(n10, b10);
  const r10 = await installRecurring({ node: n10, bundle: k10, store: s10, vault: v10 });
  const plan10 = await planRecurringPayment({ node: n10, record: r10.record, now: NOW });
  const deadNode = async (method, params) => {
    if (method === 'eth_chainId') throw expoFetchError();
    return n10(method, params);
  };
  const loads10 = v10.loads;
  const sends10 = b10.calls.length;
  const dead = await caught(() => payRecurringPayment({ bundle: kernelBundle(deadNode, b10), plan: plan10, vault: v10, store: s10, now: NOW }));
  check('a dead node is found BEFORE the payment key is read (chain id first) and before any bundler call',
    dead instanceof Error && isNodeEndpointFailure(dead) && v10.loads === loads10 && b10.calls.length === sends10, dead?.message);
  const d1 = describeRecurringPaymentError(dead, { accountType: 'kernel-v3.3', symbol: 'test ETH' }, describeSendError);
  check('described as NOT SENT: the unreachable title, the no-answer sentence, nothing sent, a cleaned technical detail',
    d1.outcome === 'not-sent' && d1.title === SESSION_UNREACHABLE_TITLE && d1.detail.startsWith(`${NO_ANSWER_SENTENCE} ${RECURRING_NOT_SENT_SENTENCE}\n\nTechnical detail: `) &&
      noJava(d1.title + d1.detail) && /Unable to resolve host/.test(d1.detail) && !/refused/i.test(d1.title + d1.detail), d1.detail);
  check('exact not-sent sentence', RECURRING_NOT_SENT_SENTENCE === 'The payment was not handed to the bundler, so nothing was sent and none of the allowed payments was used up. Try again once the connection is back.');
  const line1 = recurringAttemptLine(d1.outcome, d1.detail);
  check('card line: "not sent", never "refused", no raw exception',
    line1 === 'Last payment attempt not sent: the network could not be reached before the payment was handed to the bundler, so nothing was sent. Try again once the connection is back.', line1);

  // The node dies AFTER the key was read (the account's code check inside sendCalls): still nothing submitted.
  const midNode = async (method, params) => {
    if (method === 'eth_getCode') throw expoFetchError();
    return n10(method, params);
  };
  const mid = await caught(() => payRecurringPayment({ bundle: kernelBundle(midNode, b10), plan: plan10, vault: v10, store: s10, now: NOW }));
  check('a node failure inside sendCalls (after the key read): marked as the node\'s, eth_sendUserOperation never called, described as not sent',
    isNodeEndpointFailure(mid) && !b10.calls.slice(sends10).some((c) => c.method === 'eth_sendUserOperation') &&
      describeRecurringPaymentError(mid, { accountType: 'kernel-v3.3', symbol: 'x' }, describeSendError).outcome === 'not-sent', mid?.message);

  // The bundler does not answer the ESTIMATE: nothing submitted.
  const estDead = Object.assign(async (method, params) => {
    if (method === 'eth_estimateUserOperationGas') throw expoFetchError('rpc.zerodev.app');
    return b10(method, params);
  }, { calls: b10.calls });
  const est = await caught(() => payRecurringPayment({ bundle: kernelBundle(n10, estDead), plan: plan10, vault: v10, store: s10, now: NOW }));
  const d2 = describeRecurringPaymentError(est, { accountType: 'kernel-v3.3', symbol: 'x' }, describeSendError);
  check('bundler unreachable at the estimate (before submission): not sent, and not a node failure (never failed over)',
    d2.outcome === 'not-sent' && !isNodeEndpointFailure(est) && !isRecurringNodeFailure(est) && noJava(d2.detail), d2.detail);

  // The bundler connection fails DURING eth_sendUserOperation: the outcome is open.
  const sendDead = async (method, params) => {
    if (method === 'eth_sendUserOperation') throw expoFetchError('rpc.zerodev.app');
    return b10(method, params);
  };
  const sub = await caught(() => payRecurringPayment({ bundle: kernelBundle(n10, sendDead), plan: plan10, vault: v10, store: s10, now: NOW }));
  const d3 = describeRecurringPaymentError(sub, { accountType: 'kernel-v3.3', symbol: 'x' }, describeSendError);
  check('failure during submission: "Payment status unknown", the nonce decides, refresh before sending again; never "not sent" or "refused"',
    d3.outcome === 'outcome-unknown' && d3.title === RECURRING_OUTCOME_UNKNOWN_TITLE && d3.title === 'Payment status unknown' && d3.detail.startsWith(RECURRING_OUTCOME_UNKNOWN_SENTENCE) &&
      /nonce for this payment key decides/.test(d3.detail) && /Refresh status before sending again/.test(d3.detail) && !/nothing was sent|refused/i.test(d3.title + d3.detail) && noJava(d3.detail) &&
      !isRecurringNodeFailure(sub), d3.detail);
  check('card line for an open outcome',
    recurringAttemptLine(d3.outcome, d3.detail) === 'Last payment attempt: outcome unknown (the connection failed while it was being sent). Tap Refresh status and wait for the count before sending again.');
  const unreadable = describeRecurringPaymentError(new RecurringNotDueError('Its on-chain status could not be read (The permission is only partly installed on-chain.), so nothing was sent.', { kind: 'unknown', reason: 'x' }), { accountType: 'kernel-v3.3', symbol: 'x' }, describeSendError);
  check('a status unreadable for another reason is "failed", not "refused"; a real not-due stays "refused"',
    unreadable.outcome === 'failed' && recurringAttemptLine(unreadable.outcome, unreadable.detail).startsWith('Last payment attempt failed: Its on-chain status could not be read') &&
      describeRecurringPaymentError(new RecurringNotDueError('This payment is not due yet.', { kind: 'later', at: 1 }), { accountType: 'kernel-v3.3', symbol: 'x' }, describeSendError).outcome === 'refused');
  const unplaced = describeRecurringPaymentError(expoFetchError(), { accountType: 'kernel-v3.3', symbol: 'x' }, describeSendError);
  check('a transport failure the wallet cannot place (unmarked) is treated as an open outcome, never as "nothing was sent"', unplaced.outcome === 'outcome-unknown');
  check('an on-chain refusal keeps "refused" on the card',
    recurringAttemptLine('refused', 'Your account refused this payment: it is not due yet, or the recurring payment has ended. Nothing was paid.\n\nTechnical detail: x') ===
      'Last payment attempt refused: Your account refused this payment: it is not due yet, or the recurring payment has ended. Nothing was paid.' &&
      describeRecurringPaymentError(new Error('RPC error -32500: AA22 expired or not due'), { accountType: 'kernel-v3.3', symbol: 'x' }, describeSendError).outcome === 'refused');

  // The plan's status read does not answer: a network failure, not "Payment not sent … status could not be read".
  const deadRead = async () => { throw expoFetchError(); };
  const p1 = await caught(() => planRecurringPayment({ node: deadRead, record: r10.record, now: NOW }));
  const d4 = describeRecurringPaymentError(p1, { accountType: 'kernel-v3.3', symbol: 'x' }, describeSendError);
  check('plan read unanswered: RecurringStatusUnreachableError, described as not sent with the cleaned detail, failover-eligible',
    p1 instanceof RecurringStatusUnreachableError && isRecurringNodeFailure(p1) && d4.outcome === 'not-sent' && d4.title === SESSION_UNREACHABLE_TITLE &&
      /\n\nTechnical detail: fetch failed: Unable to resolve host/.test(d4.detail) && noJava(d4.detail), d4.detail);
}

// ---------------------------------------------------------------------------
console.log('check-recurring: endpoint failover for the status read, the plan and the payment (node only, once)');
// ---------------------------------------------------------------------------
{
  const s11 = memoryStore();
  const v11 = fakeVault();
  const n11 = fakeNode();
  const b11 = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
  const k11 = kernelBundle(n11, b11);
  const r11 = await installRecurring({ node: n11, bundle: k11, store: s11, vault: v11 });
  let plannedValue = null;
  const A = { url: 'https://a.example', isOverride: false, defaultChoice: { healthy: true }, network: { chainId: M } };
  const B = { url: 'https://b.example', isOverride: false, defaultChoice: { healthy: true }, network: { chainId: M } };
  const deadA = async () => { throw expoFetchError('a.example'); };
  const nodes = { [A.url]: deadA, [B.url]: n11 };
  const reports = [];
  // The real failover rule (endpoint-probe.ts runWithEndpointFailover), shaped like the app's activeEvmNodeRunner.
  const runner = (operation, options) =>
    runWithEndpointFailover(A, (ep) => operation(markNodeErrors(nodes[ep.url])), {
      reResolve: async () => B,
      report: (chain, url) => (reports.push(url), true),
      isFailure: options.isFailure,
    }).then((o) => o.value);
  const st = await readStatusWithFailover(runner, (node) => readSubscriptionStatus(node, r11.record, NOW));
  check('status read: endpoint A does not answer (Expo error) → reported and read once more on B → a real answer',
    st.kind === 'ok' && reports.length === 1 && reports[0] === A.url, json(st));
  reports.length = 0;
  const bothDead = (operation, options) =>
    runWithEndpointFailover(A, (ep) => operation(markNodeErrors(deadA)), { reResolve: async () => B, report: (c, u) => (reports.push(u), true), isFailure: options.isFailure }).then((o) => o.value);
  const st2 = await readStatusWithFailover(bothDead, (node) => readSubscriptionStatus(node, r11.record, NOW));
  check('both endpoints silent: no third attempt, the plain "unknown" answer is returned (not thrown)', st2.kind === 'unknown' && st2.endpointFailure === true && reports.length === 2 && noJava(st2.reason));
  const override = { ...A, isOverride: true };
  let overrideCalls = 0;
  const overrideRunner = (operation, options) =>
    runWithEndpointFailover(override, (ep) => (overrideCalls += 1, operation(markNodeErrors(deadA))), { reResolve: async () => B, report: () => true, isFailure: options.isFailure }).then((o) => o.value);
  const st3 = await readStatusWithFailover(overrideRunner, (node) => readSubscriptionStatus(node, r11.record, NOW));
  check('a user override is never worked around', st3.kind === 'unknown' && overrideCalls === 1);

  reports.length = 0;
  const planned = await caught(async () => {
    plannedValue = await runner((node) => planRecurringPayment({ node, record: r11.record, now: NOW }), { isFailure: isRecurringNodeFailure });
  });
  check('plan: fails over once on the unanswered read and plans on B', planned === null && plannedValue?.due.kind === 'due' && reports.length === 1, planned?.message);
  // Continue with a plan made directly on B when the failover check above failed.
  const plan = plannedValue ?? (await planRecurringPayment({ node: n11, record: r11.record, now: NOW }));

  // The payment: bundles per endpoint, like the screen's quoteOnNode (isNodeEndpointFailure).
  const bundles = { [A.url]: kernelBundle(deadA, b11), [B.url]: k11 };
  reports.length = 0;
  const loads = v11.loads;
  const sendsBefore = b11.calls.filter((c) => c.method === 'eth_sendUserOperation').length;
  let paid = null;
  const payError = await caught(async () => {
    paid = await runWithEndpointFailover(A, (ep) => payRecurringPayment({ bundle: bundles[ep.url], plan, vault: v11, store: s11, now: NOW }), {
      reResolve: async () => B, report: (c, u) => (reports.push(u), true), isFailure: isNodeEndpointFailure,
    });
  });
  check('payment: the dead node A is failed over to B; ONE submission; the payment key read ONCE (A failed before the key read)',
    payError === null && paid.switched && typeof paid.value.userOpHash === 'string' && b11.calls.filter((c) => c.method === 'eth_sendUserOperation').length === sendsBefore + 1 &&
      v11.loads === loads + 1 && reports.length === 1);
  const sendDead = async (method, params) => {
    if (method === 'eth_sendUserOperation') throw expoFetchError('rpc.zerodev.app');
    return b11(method, params);
  };
  let attemptsOnB = 0;
  const noRetry = await caught(() => runWithEndpointFailover(B, (ep) => (attemptsOnB += 1, payRecurringPayment({ bundle: kernelBundle(n11, sendDead), plan, vault: v11, store: s11, now: NOW })), {
    reResolve: async () => A, report: () => true, isFailure: isNodeEndpointFailure,
  }));
  check('a BUNDLER failure is never failed over (the submission may have been received): one attempt, the error surfaces', noRetry instanceof Error && attemptsOnB === 1);

  const screen = src('../src/screens/SessionsScreen.tsx');
  const banner = src('../src/components/RecurringDueBanner.tsx');
  check('the screen\'s status reads go through readStatusWithFailover on the active endpoint (source)',
    /return await readStatusWithFailover\(activeEvmNodeRunner, read\);/.test(screen));
  check('the banner\'s due check reads through readStatusWithFailover too (source; before, withEndpoint never saw an error)',
    /readStatusWithFailover\(activeEvmNodeRunner, \(node\) => readSubscriptionStatus\(node, record\)\)/.test(banner) &&
      /withEndpoint\(EVM_CHAIN_ID, \(endpoint\) => operation\(markNodeErrors\(httpTransport\(endpoint\.url\)\)\), options\)/.test(banner));
  const sess = src('../src/wallet/sessions.ts');
  const sendBody = body(sess, 'export async function sendSessionCalls', 'export function sessionOperationNonceKey');
  check('sendSessionCalls reads the chain id BEFORE the vault, marks node and bundler errors, and signs through the marked transports (source)',
    sendBody.indexOf('await nodeClient.chainId()') > 0 && sendBody.indexOf('await nodeClient.chainId()') < sendBody.indexOf('args.vault.load(') &&
      /const node = markNodeErrors\(bundle\.node\);/.test(sendBody) && /const bundler = markBundlerErrors\(bundle\.bundler\);/.test(sendBody) && /node: spec\.routeNode\(node\),/.test(sendBody) && /^\s*bundler,$/m.test(sendBody));
}

// ---------------------------------------------------------------------------
console.log('check-recurring: the grace period end to end (finding 3)');
// ---------------------------------------------------------------------------
{
  const { record, sub } = main;
  const { parseSessionKeyGrant, serializeSessionKeyGrant } = await import('@shiba-wallet/chains-evm');
  check('the installed record carries the grant\'s end one period after the terms (recurringEndsAt)', recurringEndsAt(record) === sub.validUntil + DAY && parseSessionKeyGrant(record.grant).validUntil === sub.validUntil + DAY);
  const g = parseSessionKeyGrant(record.grant);
  check('termsMatchGrant: recurring with grace ✓; recurring without grace (set up before) ✓; two periods ✗; a SUBSCRIPTION with grace ✗',
    termsMatchGrant('recurring', sub, g) && termsMatchGrant('recurring', sub, { ...g, validUntil: sub.validUntil }) &&
      !termsMatchGrant('recurring', sub, { ...g, validUntil: sub.validUntil + 2 * DAY }) && !termsMatchGrant('subscription', sub, g));
  // Stored records: an old (no-grace) recurring record still loads; a subscription record carrying a grace is dropped.
  const raw = JSON.parse(await store.getItem(SESSIONS_KEY));
  const k = Object.keys(raw.records)[0];
  const oldStyle = memoryStore();
  const raw1 = JSON.parse(JSON.stringify(raw));
  raw1.records[k].grant = serializeSessionKeyGrant({ ...g, validUntil: sub.validUntil });
  await oldStyle.setItem(SESSIONS_KEY, JSON.stringify(raw1));
  const ol = await loadSessions(oldStyle);
  check('a recurring record installed before the grace (grant end = terms end) still loads', ol.records.length === 1 && !ol.corrupt && recurringEndsAt(ol.records[0]) === sub.validUntil);
  const asSub = memoryStore();
  const raw2 = JSON.parse(JSON.stringify(raw));
  raw2.records[k].source = 'subscription';
  await asSub.setItem(SESSIONS_KEY, JSON.stringify(raw2));
  check('a SUBSCRIPTION record whose grant ends after its terms is dropped (grace only for recurring payments)', (await loadSessions(asSub)).records.length === 0);
  const st = await readSubscriptionStatus(node, record, NOW);
  check('readSubscriptionStatus uses the INSTALLED grant\'s end (TimestampPolicy), not the terms\'', st.kind === 'ok' && st.state.validUntil === sub.validUntil + DAY);

  // A payment inside the grace period passes the local checks (before, assertSubscriptionPull refused it).
  const s12 = memoryStore();
  const v12 = fakeVault();
  const n12 = fakeNode();
  const b12 = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
  const k12 = kernelBundle(n12, b12);
  const r12 = await installRecurring({ node: n12, bundle: k12, store: s12, vault: v12, periodSeconds: 120, payments: '3', now: NOW });
  n12.paid(r12.record.permissionId);
  n12.paid(r12.record.permissionId);
  const afterEnd = await caught(() => planRecurringPayment({ node: n12, record: r12.record, now: NOW + 4 * 120 + 1 }));
  check('after the grant\'s end (terms + one period) the unsent payment is refused locally as ended',
    afterEnd instanceof RecurringNotDueError && afterEnd.due.kind === 'completed' && afterEnd.due.reason === 'ended' && /ended/.test(afterEnd.message), afterEnd?.message);
  const inGrace = NOW + 3 * 120 + 30; // after the terms' end, before the grant's end
  let lastPlan = null;
  let sent = null;
  const graceError = await caught(async () => {
    lastPlan = await planRecurringPayment({ node: n12, record: r12.record, now: inGrace });
    sent = await payRecurringPayment({ bundle: k12, plan: lastPlan, vault: v12, store: s12, now: inGrace });
  });
  check('the LAST payment sent late, inside the grace period: planned, checked locally and submitted',
    graceError === null && lastPlan.due.kind === 'due' && lastPlan.due.sent === 2 && typeof sent.userOpHash === 'string', graceError?.message);
  n12.paid(r12.record.permissionId);
  const fourth = await caught(() => planRecurringPayment({ node: n12, record: r12.record, now: inGrace + 10 }));
  check('…and no fourth payment inside the grace period: all 3 sent', fourth instanceof RecurringNotDueError && /already sent/.test(fourth.message));
}

// ---------------------------------------------------------------------------
console.log('check-recurring: copy (finding 5) and the due-state timer (finding 2)');
// ---------------------------------------------------------------------------
{
  const payeeErr = (await caught(() => buildSubscription({ merchant: '0x123', choice: native, amount: '1', periodSeconds: DAY, payments: '3', feeBudget: '0.01', label: 'x' }, { now: NOW, account: ACCOUNT, recipientLabel: 'Payee' })))?.message ?? '';
  const merchErr = (await caught(() => buildSubscription({ merchant: '0x123', choice: native, amount: '1', periodSeconds: DAY, payments: '3', feeBudget: '0.01', label: 'x' }, { now: NOW, account: ACCOUNT })))?.message ?? '';
  check('the payee error is labelled "Payee:" on the recurring form; subscriptions keep "Merchant:"', /^Payee: An Ethereum address is 0x/.test(payeeErr) && /^Merchant: /.test(merchErr), payeeErr);
  const screen = src('../src/screens/SessionsScreen.tsx');
  check('the form passes "Payee" for a recurring payment (source)', screen.includes("{ now, account, testnet: evmChain.testnet, recipientLabel: mode === 'recurring' ? 'Payee' : 'Merchant' }"));
  const q = { amount: 0n, fee: 1_000n, senderBalance: 2_000n, deposit: undefined, sponsored: false, sender: ACCOUNT };
  const g = { startAt: 0, validUntil: 360, periodSeconds: 120, feeBudgetWei: 1_000n, amountPerPeriod: 10n, token: SUBSCRIPTION_NATIVE };
  const rec = subscriptionInstallFunding(q, g, 'test ETH', 'recurring').shortfall ?? '';
  const subs = subscriptionInstallFunding(q, g, 'test ETH').shortfall ?? '';
  check('the funding box says "Payments" for a recurring payment, "Pulls" for a subscription',
    rec.endsWith('Payments the account cannot pay for will fail; fund the smart account to cover them.') && !/Pulls/.test(rec) && subs.endsWith('Pulls the account cannot pay for will fail; fund the smart account to cover them.'), rec);
  check('the review passes the mode to the funding lines (source)', screen.includes("const funding = subscriptionInstallFunding(shown, sub, symbol, recurring ? 'recurring' : 'subscription');"));
  check('revoke screen: "the payment key is deleted from this phone" for a recurring payment; sessions keep their sentence',
    sessionRevokeKeySentence({ keyHeld: true, source: 'recurring' }) === 'Signed by your account key. Once the bundler accepts it, the payment key is deleted from this phone.' &&
      sessionRevokeKeySentence({ keyHeld: false, source: 'recurring' }) === 'Signed by your account key. The payment key is no longer on this phone; once the revocation is included on-chain, any copy of it stops working.' &&
      sessionRevokeKeySentence({ keyHeld: true, source: 'manual' }) === 'Signed by your account key. Once the bundler accepts it, the session key is deleted from this device.');

  // Finding 2: due state re-evaluated on a timer and on return to the foreground.
  check('the list computes the due state from a ticking clock, not the render-time clock (source)',
    /due: subStatus === undefined \|\| subStatus === 'loading' \? null : recurringDueState\(record, subStatus, nowTick\),/.test(screen) && !/recurringDueStateNow\(/.test(screen));
  check('the clock ticks every 30 s while focused; a return to the foreground re-reads every record (source)',
    /const isFocused = useIsFocused\(\);\s*useOnAppActive\(reloadList, isFocused\);\s*const nowTick = useClockTick\(30_000, isFocused\);/.test(screen));
  const banner = src('../src/components/RecurringDueBanner.tsx');
  const tick = body(banner, 'export function useClockTick', '\n}\n');
  check('useClockTick: interval while enabled, refreshed on enable and on AppState active, cleared on cleanup (source)',
    /useOnAppActive\(update, enabled\);/.test(tick) && /if \(!enabled\) return undefined;/.test(tick) && /setInterval\(update, intervalMs\)/.test(tick) && /setTimeout\(update, 0\)/.test(tick) && /clearInterval\(id\)/.test(tick));
  check('the banner and the screen share ONE AppState listener implementation (useOnAppActive; source)',
    (banner.match(/AppState\.addEventListener\(/g) ?? []).length === 1 && /useOnAppActive\(useCallback\(\(\) => setGeneration\(\(g\) => g \+ 1\), \[\]\)\);/.test(banner) && !/AppState/.test(screen));
  // Behaviour of the due arithmetic the timer drives: the same facts, a later clock.
  const S = 1_800_000_000;
  const terms = { ...JSON.parse(JSON.stringify(main.record.subscription.terms)), startAt: S, validUntil: S + 360, periodSeconds: 120 };
  const r = { ...main.record, grant: { ...main.record.grant, validUntil: S + 480 }, subscription: { ...main.record.subscription, terms } };
  const facts = { kind: 'ok', state: { rateLimitStatus: 'live', remainingPulls: 2, nextSlotAt: S + 120, intervalSeconds: 120, feeBudgetLeftWei: 1n, validUntil: S + 480 }, next: { kind: 'later' } };
  check('the same on-chain facts read at S + 60 give "later", and at the next tick (S + 120) "due" — no network needed',
    recurringDueState(r, facts, S + 60).kind === 'later' && recurringDueState(r, facts, S + 120).kind === 'due');
}

console.log(`\ncheck-recurring: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

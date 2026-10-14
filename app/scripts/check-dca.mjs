// Phase 19 item 2, app half: recurring swaps (dollar-cost averaging) on a
// session key held by this phone — "Swap X test ETH for USDC every N" on
// Ethereum Sepolia, from the smart account only. Entirely OFFLINE: the exact
// app modules (src/wallet/dca.ts, sessions.ts, subscriptions.ts, recurring.ts,
// notifications.ts, config/readiness.ts) under Node's type stripping, against
// fakes (a Kernel node with the permission policies, Uniswap's factory, the
// pinned pool and QuoterV2; a fake bundler; a fake vault). Covers:
//  - the readiness row 'dca' (test networks only, enforced) and the
//    Sepolia-only offer with the engine's sentence verbatim;
//  - the terms from the form (pinned router, WETH9 in, USDC out, the 0.05%
//    pool, the account as recipient, the floor from a live quote at a visible
//    percentage, a grace of one period) and every refusal in the engine's
//    DCA_* words;
//  - the review in the design note's order, the market lines (full pool and
//    router addresses, exact USDC), the funding and fee-budget sentences;
//  - the install through the real explicit path, the strict stored record
//    (a hand-over time, altered terms or another recipient drop it), the
//    key never leaving the phone (export, hand-over, release, test op);
//  - the due check (findDueRecurringPayments now includes swaps; read-only),
//    the banner headline, the reminders;
//  - each period: a swap before its slot refused locally, the minimum from a
//    fresh quote less 1% and never below the floor, confirm-before-send, the
//    swap signed by the swap key alone, a batch / another recipient / a
//    minimum below the floor refused BEFORE any request or key read;
//  - the outcome decoded from a receipt (received vs quote; a reverted swap
//    used its period; a batched operation flagged), refusals in plain words;
//  - source pins on the screen (one send path, the dialog, no owner key).
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-dca.mjs
//
// Nothing is signed against a live chain and nothing is broadcast.

import { readFileSync } from 'node:fs';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  DCA_AMOUNT_REFUSAL,
  DCA_BATCH_REFUSAL,
  DCA_FEE_BUDGET_REFUSAL,
  DCA_FLOOR_ZERO_REFUSAL,
  DCA_MINIMUM_BELOW_FLOOR_REFUSAL,
  DCA_NATIVE,
  DCA_RECIPIENT_REFUSAL,
  DCA_UNSUPPORTED_CHAIN_REFUSAL,
  ENTRYPOINT_V07,
  KERNEL_PERMISSION_MODULES,
  KERNEL_V3_3,
  UNISWAP_V3_SEPOLIA,
  UNISWAP_V3_SWAP_TOPIC,
  buildDcaSwapCall,
  createSessionKeyAccount,
  dcaGrantFor,
  decodeDcaSwapData,
  getUserOpHash,
  parseSessionKeyGrant,
  sessionNonceKey,
  toHex,
} from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import { createAaClient } from '../src/wallet/aa.ts';
import {
  DCA_SOURCE,
  SESSIONS_KEY,
  finalizeSessionInstall,
  installSession,
  loadSessions,
  newSessionKey,
  prepareSessionInstall,
  releaseSessionKey,
  revokeApprovalPrompt,
  revokeConfirmCopy,
  saveDcaLastSwap,
  saveSessionRecord,
  sendSessionCalls,
  sessionCanBeTested,
  sessionIsScheduled,
  sessionProgressTitle,
  sessionRevokeKeySentence,
  sessionVaultId,
} from '../src/wallet/sessions.ts';
import {
  DCA_KEY_NEVER_EXPORTED,
  buildSubscriptionKeyExport,
  customPeriodSeconds,
  defaultFeeBudgetWei,
  feeBudgetTooSmallBlock,
  feeBudgetTooSmallWarning,
  fitFeeBudgetToInstall,
  markSubscriptionKeyExported,
  minimumViableFeeBudgetWei,
  readSubscriptionStatus,
  subscriptionHandoverOffer,
  suggestedFeeBudget,
} from '../src/wallet/subscriptions.ts';
import {
  RecurringNotDueError,
  RecurringStatusUnreachableError,
  dcaDueState,
  findDueRecurringPayments,
  readRecurringDueStates,
  scheduledDueHeadline,
} from '../src/wallet/recurring.ts';
import {
  DCA_AUDIT_NOTE,
  DCA_CARD_NOTE,
  DCA_FLOOR_PERCENT_REFUSAL,
  DCA_INSTALL_GAS_RECORDED,
  DCA_NOT_SENT_SENTENCE,
  DCA_PAY_PROMPT_NOTE,
  DCA_POOL,
  DCA_REFUSED_TITLE,
  DCA_FEE_BUDGET_CLEAR_NOTE,
  DCA_FLOOR_FIXED_FUTURE,
  DCA_FLOOR_FIXED_PAST,
  DCA_SWAP_GAS_ALLOWANCE,
  DCA_SWAP_LARGEST_RECORDED_CHARGE_GAS,
  DCA_TOKEN_OUT,
  DCA_WHILE_OPEN_NOTE,
  bpsText,
  buildDcaTerms,
  dcaAttemptLine,
  dcaConfirmMessage,
  dcaFeeBudgetCapNote,
  dcaFeeBudgetFormHint,
  dcaFeeBudgetFormNote,
  dcaFeeBudgetPricingNote,
  dcaFeeBudgetSuggestionHint,
  dcaFinalDatesLine,
  dcaGrantForTerms,
  dcaInstallFunding,
  dcaKeyOnlyLine,
  dcaLastSwapFrom,
  dcaLastSwapLines,
  dcaMarketLines,
  dcaMeta,
  dcaNetworkRefusal,
  dcaOutcomeLine,
  dcaRefusalSentence,
  dcaReview,
  dcaSetupCostNote,
  dcaSetupFundingWarning,
  dcaStatusLines,
  dcaSummary,
  describeDcaSwapError,
  parseFloorPercent,
  payDcaSwap,
  planDcaSwap,
  readDcaMarket,
  restartDcaAt,
  runDcaSwap,
} from '../src/wallet/dca.ts';
import {
  RECURRING_SWAP_DUE_BODY,
  RECURRING_SWAP_DUE_TITLE,
  planRecurringSync,
  recurringNotificationId,
  recurringReminderAt,
  recurringReminderEligible,
  recurringSwapDueContent,
} from '../src/wallet/notifications.ts';
import {
  FEATURE_READINESS,
  FeatureNotAllowedError,
  featureReadiness,
  isFeatureAllowed,
  readinessGate,
} from '../src/config/readiness.ts';
import { describeSendError } from '../src/wallet/send.ts';
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
import { createKeyVault } from '../src/wallet/storage.ts';

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
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
function body(text, start, end) {
  const a = text.indexOf(start);
  const b = end ? text.indexOf(end, a + start.length) : text.length;
  return a < 0 ? '' : text.slice(a, b < 0 ? text.length : b);
}
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);
const M = 'eip155:11155111';
const CHAIN_ID = 11155111n;
const ACCOUNT = KERNEL_ACCOUNT_0;
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const POOL = '0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1';
const ROUTER = UNISWAP_V3_SEPOLIA.swapRouter02;
const WETH = UNISWAP_V3_SEPOLIA.weth9;
const TX_HASH = '0x' + 'cd'.repeat(32);
const NOW = Math.floor(Date.now() / 1000);
const PERIOD = 300;
const AMOUNT = 10_000_000_000_000n; // 0.00001 test ETH (the live run's amount)
const QUOTE = 468_502n; // the live run's quote, USDC base units
const FLOOR = (QUOTE * 9500n) / 10_000n; // 445,076
const DRAFT = { amount: '0.00001', periodSeconds: PERIOD, count: '3', feeBudget: '0.01', floorPercent: '95', label: '' };

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

/** Fake node: Kernel + permission views + the policies (as check-recurring) + Uniswap's factory, pool and QuoterV2. */
function fakeNode({ quote = QUOTE, liquidity = 13_157_000_000_000_000n, factoryPool = POOL } = {}) {
  const base = fakeKernelNode({ chainIdHex: '0xaa36a7', deployedAccounts: new Set([ACCOUNT]) });
  const state = { currentNonce: 1, permissions: new Map(), rate: new Map(), gas: new Map(), quote };
  const calls = [];
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      const b = '0x' + data.slice(10);
      // Uniswap v3 (Sepolia, pinned in the engine).
      if (same(to, UNISWAP_V3_SEPOLIA.factory) && data.startsWith(sel('getPool(address,address,uint24)'))) return pad32(factoryPool);
      if (same(to, POOL)) {
        if (data.startsWith(sel('factory()'))) return pad32(UNISWAP_V3_SEPOLIA.factory);
        if (data.startsWith(sel('token0()'))) return pad32(USDC);
        if (data.startsWith(sel('token1()'))) return pad32(WETH);
        if (data.startsWith(sel('fee()'))) return word(500);
        if (data.startsWith(sel('liquidity()'))) return word(liquidity);
        if (data.startsWith(sel('slot0()'))) return '0x' + [word(1n << 96n), word(0), word(0), word(0), word(0), word(0), word(1)].map((w) => w.slice(2)).join('');
      }
      if (same(to, UNISWAP_V3_SEPOLIA.quoterV2) && data.startsWith(sel('quoteExactInputSingle((address,address,uint256,uint24,uint160))'))) {
        return '0x' + [word(state.quote), word(1n << 96n), word(1), word(90_000)].map((w) => w.slice(2)).join('');
      }
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
  /** One swap counted by RateLimitPolicy (count − 1, startAt + interval). */
  transport.swapped = (pid) => {
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

function termsAt(now = NOW, draft = DRAFT, quotedOut = QUOTE) {
  return buildDcaTerms(draft, { now, account: ACCOUNT, chainId: CHAIN_ID, quotedOut, nativeSymbol: 'test ETH' });
}

/** Installs one recurring swap through the real explicit path and confirms it (fakes). */
async function installDca({ node, bundle, store, vault, now = NOW, draft = DRAFT }) {
  const { terms, floorBps } = termsAt(now, draft);
  const keyBytes = ethers.randomBytes(32);
  const keyAddress = createSessionKeyAccount(keyBytes.slice()).address;
  const grant = dcaGrantForTerms(terms, keyAddress, now);
  const { install, quote } = await prepareSessionInstall(bundle, OWNER_0, ACCOUNT, grant, { now });
  const res = await installSession({
    quote, install, grant, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3',
    label: `Recurring swap: ${terms.label}`, source: 'dca', dca: dcaMeta(terms, { nativeSymbol: 'test ETH', floorBps, quoteAtReview: QUOTE }),
    sessionPrivateKey: keyBytes.slice(), store, vault, submit: async () => ({ userOpHash: '0x' + 'ee'.repeat(32) }),
  });
  node.install(res.record.permissionId, keyAddress, grant);
  const fin = await finalizeSessionInstall(bundle, res.record, store, { timeoutMs: 1000, pollMs: 1 });
  return { record: fin.record, terms, grant, keyAddress, keyHex: ethers.hexlify(keyBytes).toLowerCase() };
}

// ---------------------------------------------------------------------------
console.log('check-dca: readiness and the network');
// ---------------------------------------------------------------------------
{
  const row = FEATURE_READINESS.find((f) => f.id === 'dca');
  check('readiness row "dca" exists: testnet-only, enforced, titled', !!row && row.status === 'testnet-only' && row.enforced === true && row.title === 'Recurring swaps (dollar-cost averaging)');
  check('its reason states the static floor, batching, the unaudited modules and pools, and the estimate reservation',
    !!row && /minimum price is fixed at set-up and does not follow the market/.test(row.reason) && /batches several swaps/.test(row.reason) &&
      /no published audit/.test(row.reason) && /not verified against published source/.test(row.reason) && /unusually large balance just to estimate/.test(row.reason), row?.reason);
  check('evidence cites C1–C3, W9, F-14, T-64 and T-69', !!row && ['C1', 'C2', 'C3', 'W9', 'F-14', 'T-64', 'T-69'].every((i) => row.evidence.includes(i)));
  check('refused on mainnet, allowed on Sepolia (and a gate is shown on mainnet)',
    !isFeatureAllowed('dca', 'eip155:1') && isFeatureAllowed('dca', M) && readinessGate('dca', 'eip155:1')?.feature.id === 'dca' && readinessGate('dca', M) === null);
  check('offered only on Ethereum Sepolia: the engine’s sentence verbatim elsewhere',
    dcaNetworkRefusal(M) === null && dcaNetworkRefusal('eip155:84532') === DCA_UNSUPPORTED_CHAIN_REFUSAL && dcaNetworkRefusal('eip155:421614') === DCA_UNSUPPORTED_CHAIN_REFUSAL);
  const e = await caught(() => buildDcaTerms(DRAFT, { now: NOW, account: ACCOUNT, chainId: 84532n, quotedOut: QUOTE, nativeSymbol: 'test ETH' }));
  check('terms for Base Sepolia are refused with DCA_UNSUPPORTED_CHAIN_REFUSAL', e?.message === DCA_UNSUPPORTED_CHAIN_REFUSAL, e?.message);
  check('the gates name the row in the send and plan paths (source)',
    /assertFeatureAllowed\('dca', record\.chain\);/.test(src('../src/wallet/sessions.ts')) &&
      (src('../src/wallet/dca.ts').match(/assertFeatureAllowed\('dca', record\.chain\);/g) ?? []).length === 2 &&
      /assertFeatureAllowed\('dca', args\.chain\);/.test(src('../src/wallet/sessions.ts')));
}

// ---------------------------------------------------------------------------
console.log('check-dca: terms from the form, refusals verbatim');
// ---------------------------------------------------------------------------
{
  const { terms, floorBps } = termsAt();
  check('pinned router, ETH in (WETH9), USDC out, the 0.05% pool, the account as recipient',
    same(terms.router, ROUTER) && terms.tokenIn === DCA_NATIVE && same(terms.tokenOut, USDC) && terms.fee === 500 && same(DCA_POOL.pool, POOL) &&
      same(terms.account, ACCOUNT) && same(terms.recipient, ACCOUNT) && same(DCA_TOKEN_OUT, USDC));
  check('amount, period, count and fee budget exact; start = now; a grace of one period',
    terms.amountIn === AMOUNT && terms.periodSeconds === PERIOD && terms.count === 3 && terms.feeBudgetWei === 10_000_000_000_000_000n && terms.startAt === NOW && terms.graceSeconds === PERIOD);
  check('the floor is 95% of the live quote, rounded down (445,076 of 468,502)', floorBps === 9500 && terms.minimumOut === FLOOR && FLOOR === 445_076n);
  check('floor percentages: "95" → 9500, "97.5" → 9750, "0.01" → 1, "100" → 10000; "abc", "0", "100.5", "95.123" refused',
    parseFloorPercent('95') === 9500 && parseFloorPercent('97.5') === 9750 && parseFloorPercent('0.01') === 1 && parseFloorPercent('100') === 10000 &&
      ['abc', '0', '100.5', '95.123', ''].every((t) => { try { parseFloorPercent(t); return false; } catch (x) { return x.message === DCA_FLOOR_PERCENT_REFUSAL; } }));
  const refuse = async (draft, quote = QUOTE) => (await caught(() => termsAt(NOW, { ...DRAFT, ...draft }, quote)))?.message;
  check('amount 0 → the engine’s DCA_AMOUNT_REFUSAL', (await refuse({ amount: '0' })) === DCA_AMOUNT_REFUSAL);
  check('no fee budget → the engine’s DCA_FEE_BUDGET_REFUSAL', (await refuse({ feeBudget: '' })) === DCA_FEE_BUDGET_REFUSAL);
  check('a floor that rounds to zero → the engine’s DCA_FLOOR_ZERO_REFUSAL', (await refuse({ floorPercent: '0.01' }, 50n)) === DCA_FLOOR_ZERO_REFUSAL);
  check('a count that is not a number → the engine’s sentence', (await refuse({ count: 'x' })) === 'The number of swaps must be between 1 and 10000.');
  check('more than 120 swaps → the app’s cap', (await refuse({ count: '121' })) === 'This wallet offers at most 120 swaps per plan.');
  check('an empty amount → a plain sentence', (await refuse({ amount: '' })) === 'Enter the amount of test ETH to swap each period.');
  check('a period under 60 seconds → the engine’s sentence', (await refuse({ periodSeconds: 30 })) === 'The period must be a whole number of seconds, at least 60.');
  check('restartDcaAt moves only the start (same floor, amount, grace)', (() => {
    const r = restartDcaAt(terms, NOW + 77);
    return r.startAt === NOW + 77 && r.minimumOut === terms.minimumOut && r.amountIn === terms.amountIn && r.graceSeconds === terms.graceSeconds;
  })());
  const KEY = '0x484B87B8D4D73d88ccF7D39C006cC1b078384640';
  const g = dcaGrantForTerms(terms, KEY, NOW);
  check('the grant is the engine’s dcaGrantFor exactly', JSON.stringify(g, (_k, v) => (typeof v === 'bigint' ? `${v}` : v)) === JSON.stringify(dcaGrantFor(terms, KEY, { now: NOW }), (_k, v) => (typeof v === 'bigint' ? `${v}` : v)));
  check('grant: one allowed call (the router), value cap = amount, rate limit {period, 3, start}, ends start + 4 periods (grace)',
    g.calls.length === 1 && same(g.calls[0].target, ROUTER) && g.calls[0].valueLimit === AMOUNT && g.rateLimit.count === 3 && g.rateLimit.intervalSeconds === PERIOD &&
      g.rateLimit.startAt === NOW && g.validUntil === NOW + 4 * PERIOD && g.gasBudgetWei === terms.feeBudgetWei);
  const recipientRule = g.calls[0].rules.find((r) => r.offset === 96);
  const floorRule = g.calls[0].rules.find((r) => r.offset === 160);
  check('the call rules pin the recipient to the account (EQUAL) and the minimum to the floor (GTE)',
    recipientRule?.condition === 'equal' && same('0x' + recipientRule.params[0].slice(26), ACCOUNT) && floorRule?.condition === 'greaterThanOrEqual' && BigInt(floorRule.params[0]) === FLOOR);

  // Custom period (shared with the recurring-payment form): the form offers
  // whole minutes/hours/days as well as the presets, so a plan can run on a
  // real cadence, not only the 2-minute test preset. The engine's dcaGrantFor
  // takes periodSeconds, so a 1-hour custom period builds the grant with
  // intervalSeconds 3600 and the terms carry it.
  const oneHour = customPeriodSeconds('1', 3600, true);
  check('customPeriodSeconds("1", hours) = 3600 (shared with the recurring form)', oneHour.ok && oneHour.seconds === 3600);
  const { terms: hourlyTerms } = termsAt(NOW, { ...DRAFT, periodSeconds: 3600 });
  const hourlyGrant = dcaGrantForTerms(hourlyTerms, KEY, NOW);
  check('a 1-hour custom period builds the grant with periodSeconds 3600 and the RateLimitPolicy interval 3600',
    hourlyTerms.periodSeconds === 3600 && hourlyTerms.graceSeconds === 3600 && hourlyGrant.rateLimit.intervalSeconds === 3600 && hourlyGrant.validUntil === NOW + 4 * 3600);
  check('the DCA form offers the preset row and the same custom minutes/hours/days control as the recurring form (source)', (() => {
    const dv = src('../src/screens/DcaViews.tsx');
    return /subscriptionPeriodPresets\(props\.testnet\)\.map/.test(dv) && /form\.periodCustom/.test(dv) && /SUBSCRIPTION_PERIOD_UNITS\.map/.test(dv) &&
      /customPeriodSeconds\(dcaForm\.customCount, dcaForm\.customUnit, evmChain\.testnet\)/.test(src('../src/screens/SessionsScreen.tsx'));
  })());
}

// ---------------------------------------------------------------------------
console.log('check-dca: review, market, funding and fee budget');
// ---------------------------------------------------------------------------
{
  const { terms } = termsAt(Date.UTC(2026, 9, 11, 12, 0, 0) / 1000);
  const r = dcaReview(terms, { nativeSymbol: 'test ETH' });
  check('the batching residual is its own first box (the engine’s words)',
    /^ONE OPERATION CAN HOLD SEVERAL SWAPS\./.test(r.batching) && /up to everything this account holds/.test(r.batching));
  const order = [
    /^THE MINIMUM DOES NOT FOLLOW THE PRICE\. 0\.445076 USDC per swap was fixed when the plan was set up\./,
    /^There is no deadline:/,
    /^A swap that reverts still uses up its period/,
    /stays in the router, where anyone can take it/,
    /^The swap key can only buy USDC for this account/,
    /^Missed periods are not lost/,
    /^Revoke at any time/,
    /^The swap key lives in this phone’s secure storage/,
  ];
  check('the caveats come in the design note’s order: floor, deadline, revert, router residual, key-only, catch-up (then revoke, key home)',
    r.caveats.length === order.length && order.every((re, i) => re.test(r.caveats[i])), r.caveats.map((c) => c.slice(0, 30)).join(' | '));
  check('key-only line (exact)', r.caveats[4] === dcaKeyOnlyLine(ACCOUNT) &&
    dcaKeyOnlyLine(ACCOUNT) === `The swap key can only buy USDC for this account: it may call only Uniswap’s SwapRouter02 to sell exactly the plan’s amount in the pinned pool, with this smart account (${ACCOUNT}) as the only recipient. It cannot send your ETH or tokens anywhere else, approve a spender, or sign messages, logins or permits.`);
  check('catch-up names the last due date, the end (two periods later) and that no extra swap is allowed',
    r.caveats[5].endsWith('The last swap falls due 2026-10-11 12:10 UTC and can be sent until 2026-10-11 12:20 UTC: the end date is two periods after it (one period more than the swaps alone need, as a grace period), so a late last swap can still be sent; this does not allow any extra swap.'), r.caveats[5]);
  check('sentence: amount, period, count, end and the floor (engine describeDca)',
    r.sentence === 'Swaps 0.00001 test ETH for USDC every 5 minutes, 3 times, until 2026-10-11 12:20 UTC; each swap must return at least 0.445076 USDC.', r.sentence);
  check('on-chain lines name the router and pool in full and the account', r.enforced[0].includes(ROUTER) && r.enforced[0].includes(POOL) && r.enforced[2].includes(ACCOUNT));
  const lines = dcaMarketLines({ amountIn: AMOUNT, quotedOut: QUOTE, floorBps: 9500, nativeSymbol: 'test ETH' });
  check('market lines: the pool and router in full, the quote and the floor in exact USDC',
    lines[0] === `Pool: Uniswap v3 USDC/WETH 0.05%, ${POOL} (checked against Uniswap’s factory ${UNISWAP_V3_SEPOLIA.factory} on every read).` &&
      lines[1] === `Router: Uniswap SwapRouter02, ${ROUTER}.` &&
      lines[2] === `Quote just now (Uniswap QuoterV2 ${UNISWAP_V3_SEPOLIA.quoterV2}): 0.00001 test ETH → 0.468502 USDC. A quote is a reading at one block, not a promise.` &&
      lines[3] === 'Minimum to receive per swap: 95% of that quote = 0.445076 USDC, fixed at set-up.', lines.join('\n'));
  check('before a quote: only the pool and router lines', dcaMarketLines({ amountIn: AMOUNT, quotedOut: null, floorBps: 9500, nativeSymbol: 'test ETH' }).length === 2);
  check('a percentage that rounds the floor to zero says so', /rounds down to 0 USDC, which is refused/.test(dcaMarketLines({ amountIn: 1n, quotedOut: 50n, floorBps: 1, nativeSymbol: 'test ETH' })[3]));
  check('bpsText: 9500 → 95%, 9750 → 97.5%, 100 → 1%', bpsText(9500) === '95%' && bpsText(9750) === '97.5%' && bpsText(100) === '1%');
  const cost = dcaSetupCostNote(2_310_000_000n, 'test ETH');
  check('set-up cost: the recorded 7,015,028 gas / 0.0081 ETH / 0.012 ETH and today’s equivalents at the signed fee',
    /used 7,015,028 gas \(about 0\.0081 ETH at about 1\.155 gwei\)/.test(cost) && /about 0\.012 ETH/.test(cost) &&
      cost.includes('At the fee this wallet signs at today (2.31 gwei per gas), 7,015,028 gas is about 0.01620471468 test ETH') &&
      cost.includes('reservation of about 8,000,000 gas is about 0.01848 test ETH') && DCA_INSTALL_GAS_RECORDED === 7_015_028n, cost);
  check('without a fee: only the recorded figures', !/At the fee/.test(dcaSetupCostNote(null, 'test ETH')));
  const warn = dcaSetupFundingWarning({ maxFeePerGas: 2_310_000_000n, balance: 11_000_000_000_000_000n, deposit: 0n, account: ACCOUNT, nativeSymbol: 'test ETH' });
  check('a funding warning below the reservation (0.011 held vs about 0.01848) names the address; none above it',
    !!warn && warn.includes(ACCOUNT) && warn.includes('0.01848 test ETH') &&
      dcaSetupFundingWarning({ maxFeePerGas: 2_310_000_000n, balance: 20_000_000_000_000_000n, deposit: 0n, account: ACCOUNT, nativeSymbol: 'test ETH' }) === null);
  const sug = suggestedFeeBudget({ payments: 3, maxFeePerGas: 2_310_000_000n, balance: null, nativeAmountPerPayment: AMOUNT, gasAllowance: DCA_SWAP_GAS_ALLOWANCE });
  check('fee-budget suggestion: 3 swaps × 1,800,000 gas × 2.31 gwei × 2 = 0.024948 test ETH', sug.wei === 3n * 1_800_000n * 2_310_000_000n * 2n && sug.wei === 24_948_000_000_000_000n);
  const capped = suggestedFeeBudget({ payments: 3, maxFeePerGas: 2_310_000_000n, balance: 10_000_000_000_000_000n, nativeAmountPerPayment: AMOUNT, installFeeFromBalance: 1_000_000_000_000_000n, gasAllowance: DCA_SWAP_GAS_ALLOWANCE });
  check('capped at what is left after every swap’s amount and the set-up’s fee', capped.capped && capped.wei === 10_000_000_000_000_000n - 3n * AMOUNT - 1_000_000_000_000_000n);
  check('the cap note speaks of swaps', /usual budget for this many swaps/.test(dcaFeeBudgetCapNote(1n, 2n, 'test ETH', 3n)) && /set-up’s own worst-case network fee/.test(dcaFeeBudgetCapNote(1n, 2n, 'test ETH', 3n)));
  const pricing = dcaFeeBudgetPricingNote({ budgetWei: sug.wei, count: 3, maxFeePerGas: 2_310_000_000n, source: 'bundler', edited: false, nativeSymbol: 'test ETH' });
  check('pricing note: the signed fee, 1,800,000 gas per swap doubled, covers all 3, and the recorded signed-limit charges',
    pricing.startsWith('Fee budget priced at 2.31 gwei per gas — the fee each swap is signed at today (the bundler’s current fee plus 100% headroom): 1,800,000 gas per swap (0.004158 test ETH), doubled because fees move; at 1,800,000 gas each it covers all 3 swaps.') &&
      pricing.endsWith(' The three swaps run on 2026-10-11 were charged 1,420,113, 1,204,793 and 1,205,388 gas (their signed gas limits) against their budget.'), pricing);
  const quote = { amount: 0n, fee: 8_000_000_000_000_000n, senderBalance: 11_000_000_000_000_000n, deposit: 0n, sponsored: false, sender: ACCOUNT };
  const f = dcaInstallFunding(quote, { amountIn: AMOUNT, count: 3, feeBudgetWei: 13_860_000_000_000_000n }, 'test ETH');
  check('funding: Start offered, and a shortfall warning when the swaps plus the budget exceed what is left',
    f.canStart && f.block === null && /the swaps \(3 × 0\.00001 test ETH\) and the fee budget can use up to/.test(f.shortfall ?? ''), f.shortfall);
  const blocked = dcaInstallFunding({ ...quote, senderBalance: 1n }, { amountIn: AMOUNT, count: 3, feeBudgetWei: 1n }, 'test ETH');
  check('funding: no Start when the balance and deposit cannot cover the set-up’s worst case', !blocked.canStart && /cannot pay for the set-up/.test(blocked.block ?? '') && blocked.block.includes(ACCOUNT));

  // The 2026-10-11 DCA in-app finding: the keep-back could auto-fit a budget
  // below ONE swap's worst-case fee (DCA_SWAP_GAS_ALLOWANCE × the signed fee),
  // so the plan installed but the account refused its first swap on-chain
  // after the set-up fee was spent. The fit now refuses that (too-small) and
  // Start is withheld; a too-small TYPED budget is warned about, not blocked.
  const FEE = 2_310_000_004n;
  const swapMin = minimumViableFeeBudgetWei(FEE, DCA_SWAP_GAS_ALLOWANCE);
  check('one swap’s worst-case fee = DCA_SWAP_GAS_ALLOWANCE (1,800,000 gas) × the signed fee',
    DCA_SWAP_GAS_ALLOWANCE === 1_800_000n && swapMin === DCA_SWAP_GAS_ALLOWANCE * FEE && swapMin === 4_158_000_007_200_000n);
  // Phase 20 item 0 finding 2: the allowance must cover what GasPolicy really
  // charged the live swaps — (pVG + vGL + cGL) of the SIGNED limits × the
  // signed maxFeePerGas — read back from the three bundle transactions'
  // handleOps input: script swap 1 (block 11,893,108), script swap 2
  // (11,893,119) and the in-app swap (11,894,126).
  const LIVE_SWAPS = [
    { vgl: 987_890n, cgl: 379_444n, pvg: 52_779n, maxFee: 1_155_000_004n, charged: 1_640_230_520_680_452n },
    { vgl: 772_557n, cgl: 379_444n, pvg: 52_792n, maxFee: 1_155_000_003n, charged: 1_391_535_918_614_379n },
    { vgl: 863_242n, cgl: 291_880n, pvg: 50_266n, maxFee: 2_310_000_004n, charged: 2_784_446_284_821_552n },
  ];
  const liveGas = LIVE_SWAPS.map((x) => x.vgl + x.cgl + x.pvg);
  check('the recorded live swaps: signed limits × signed fee = the charge, 1,420,113 / 1,204,793 / 1,205,388 gas',
    LIVE_SWAPS.every((x, i) => liveGas[i] * x.maxFee === x.charged) && liveGas.join() === '1420113,1204793,1205388' &&
      DCA_SWAP_LARGEST_RECORDED_CHARGE_GAS === 1_420_113n);
  check('the allowance exceeds the largest live per-swap charge (1,420,113 gas) with a stated margin (≥ 25%)',
    DCA_SWAP_GAS_ALLOWANCE > DCA_SWAP_LARGEST_RECORDED_CHARGE_GAS && DCA_SWAP_GAS_ALLOWANCE * 100n >= DCA_SWAP_LARGEST_RECORDED_CHARGE_GAS * 125n);
  check('the minimum-viable budget now exceeds the largest live-observed per-swap charge at the same fee (old 1,000,000 did not)',
    swapMin > DCA_SWAP_LARGEST_RECORDED_CHARGE_GAS * FEE && 1_000_000n * FEE < DCA_SWAP_LARGEST_RECORDED_CHARGE_GAS * FEE);
  {
    // A plan whose keep-back is exactly one live swap's charge: it passed the
    // old 1,000,000-gas check and could be refused on-chain at swap 1; it is
    // now blocked before anything is signed.
    const live = DCA_SWAP_LARGEST_RECORDED_CHARGE_GAS * FEE;
    const q = { amount: 0n, fee: 1_000_000_000_000_000n, total: 1_000_000_000_000_000n, senderBalance: live, deposit: 10n ** 18n, sponsored: false, sender: ACCOUNT };
    const between = await fitFeeBudgetToInstall({
      payments: 3, maxFeePerGas: FEE, nativeAmountPerPayment: 0n, gasAllowance: DCA_SWAP_GAS_ALLOWANCE,
      feeBudgetWei: defaultFeeBudgetWei(3, FEE, DCA_SWAP_GAS_ALLOWANCE), attempt: { quote: q }, requote: async () => ({ quote: q }),
    });
    check('a budget of one live swap’s charge (1,420,113 gas × fee) is blocked as too small (cannot-fit), not installed',
      between.kind === 'cannot-fit' && between.reason === 'too-small' && between.fittedBudget === live, between.kind);
    check('…and a typed budget of that size gets the too-small warning',
      feeBudgetTooSmallWarning({ feeBudgetWei: live, edited: true, maxFeePerGas: FEE, gasAllowance: DCA_SWAP_GAS_ALLOWANCE, nativeSymbol: 'test ETH', word: 'swap' }) !== null);
  }
  const quoteAt = (balance) => ({ amount: 0n, fee: 1_000_000_000_000_000n, total: 1_000_000_000_000_000n, senderBalance: balance, deposit: 10n ** 18n, sponsored: false, sender: ACCOUNT });
  const tinySwap = await fitFeeBudgetToInstall({
    payments: 3, maxFeePerGas: FEE, nativeAmountPerPayment: 0n, gasAllowance: DCA_SWAP_GAS_ALLOWANCE,
    feeBudgetWei: defaultFeeBudgetWei(3, FEE, DCA_SWAP_GAS_ALLOWANCE), attempt: { quote: quoteAt(1_000_000_000_000_000n) }, requote: async () => ({ quote: quoteAt(1_000_000_000_000_000n) }),
  });
  check('a swap budget fitted below one swap’s worst-case fee is refused (cannot-fit, too-small)',
    tinySwap.kind === 'cannot-fit' && tinySwap.reason === 'too-small' && tinySwap.fittedBudget === 1_000_000_000_000_000n && tinySwap.minViable === swapMin);
  check('the DCA block and typed warning use the word "swap"',
    feeBudgetTooSmallBlock({ fittedBudget: tinySwap.fittedBudget, minViable: swapMin, nativeSymbol: 'test ETH', word: 'swap' }) ===
      'This plan cannot run: after the one-time set-up fee, only 0.001 test ETH could be kept back for the swaps, but one swap can cost up to 0.0041580000072 test ETH at today’s fee. Add about 0.0031580000072 test ETH to the smart account, or set a larger fee budget. Nothing was signed.' &&
      feeBudgetTooSmallWarning({ feeBudgetWei: 1n, edited: true, maxFeePerGas: FEE, gasAllowance: DCA_SWAP_GAS_ALLOWANCE, nativeSymbol: 'test ETH', word: 'swap' })
        === 'The fee budget you entered (0.000000000000000001 test ETH) is below one swap’s worst-case network fee (0.0041580000072 test ETH) at today’s fee, so your account will probably refuse the first swap and the plan will not run. Set a larger fee budget unless you are sure the fee will be lower.');
  // Well-funded: unchanged — no regression to the set-up keep-back.
  const richSwap = await fitFeeBudgetToInstall({
    payments: 3, maxFeePerGas: FEE, nativeAmountPerPayment: 0n, gasAllowance: DCA_SWAP_GAS_ALLOWANCE,
    feeBudgetWei: defaultFeeBudgetWei(3, FEE, DCA_SWAP_GAS_ALLOWANCE), attempt: { quote: quoteAt(10n ** 18n) }, requote: async () => { throw new Error('should not re-quote a well-funded plan'); },
  });
  check('a well-funded recurring-swap plan is unchanged (fitted, nothing lowered, budget ≥ one swap)',
    richSwap.kind === 'fitted' && richSwap.lowered === null && richSwap.feeBudgetWei === defaultFeeBudgetWei(3, FEE, DCA_SWAP_GAS_ALLOWANCE) && richSwap.feeBudgetWei >= swapMin);
  check('the DCA review withholds Start on a too-small auto-fit and renders the swap too-small warning (source)',
    /fit\.reason === 'too-small'[\s\S]{0,180}feeBudgetTooSmallBlock\(\{ fittedBudget: fit\.fittedBudget, minViable: fit\.minViable, nativeSymbol: symbol, word: 'swap' \}\)/.test(src('../src/screens/SessionsScreen.tsx')) &&
      /feeBudgetTooSmallWarning\(\{[\s\S]{0,260}word: 'swap'/.test(src('../src/screens/DcaViews.tsx')));
  check('final dates line', dcaFinalDatesLine(terms) === 'Final terms: the first swap is due from 2026-10-11 12:00 UTC, then one more every 5 minutes (3 in total); nothing after 2026-10-11 12:20 UTC. Each swap must return at least 0.445076 USDC.', dcaFinalDatesLine(terms));
  check('notes: while-open, prompts, audit', /Nothing is swapped in the background/.test(DCA_WHILE_OPEN_NOTE) && /"Use the session key"/.test(DCA_PAY_PROMPT_NOTE) && /recovery phrase is\s+never opened/.test(DCA_PAY_PROMPT_NOTE) &&
    /no swap is ever sent in the background/.test(DCA_CARD_NOTE) && /not verified against published source/.test(DCA_AUDIT_NOTE));
}

// ---------------------------------------------------------------------------
console.log('check-dca: install, stored record, the key never leaves the phone');
// ---------------------------------------------------------------------------
const node = fakeNode();
const bundler = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
const bundle = kernelBundle(node, bundler);
const store = memoryStore();
const vault = fakeVault();
const main = await installDca({ node, bundle, store, vault });
{
  const { record } = main;
  check('record: source dca, installed, key held, the terms and symbols stored, no subscription meta',
    record.source === DCA_SOURCE && record.localStatus === 'installed' && record.keyHeld && !!record.dca && !record.subscription &&
      record.dca.symbolIn === 'test ETH' && record.dca.symbolOut === 'USDC' && record.dca.decimalsOut === 6 && record.dca.floorBps === 9500 &&
      record.dca.quoteAtReview === '468502' && record.dca.keyExportedAt === null && record.dca.lastSwap === null);
  const stored = await store.getItem(SESSIONS_KEY);
  check('the key is in the vault, never in the public list', vault.map.get(sessionVaultId(M, ACCOUNT, record.permissionId)) === main.keyHex && !stored.includes(main.keyHex.slice(2)));
  const reload = await loadSessions(store);
  check('the stored record loads back unchanged', reload.records.length === 1 && reload.records[0].source === 'dca' && !reload.corrupt);
  check('sessionIsScheduled: dca too (never listed or tested as a plain session)', sessionIsScheduled('dca') && !sessionCanBeTested(record));
  const tamper = async (mutate) => {
    const raw = JSON.parse(await store.getItem(SESSIONS_KEY));
    const key = Object.keys(raw.records)[0];
    mutate(raw.records[key]);
    const s2 = memoryStore();
    await s2.setItem(SESSIONS_KEY, JSON.stringify(raw));
    return loadSessions(s2);
  };
  const handed = await tamper((r) => { r.dca.keyExportedAt = 1790000000000; });
  check('a stored hand-over time drops the record as corrupt', handed.records.length === 0 && handed.corrupt);
  const lower = await tamper((r) => { r.dca.terms.minimumOut = '1'; });
  check('terms that no longer match the grant (a lower floor) drop the record', lower.records.length === 0 && lower.corrupt);
  const other = await tamper((r) => { r.dca.terms.account = OWNER_0; });
  check('terms for another account drop the record', other.records.length === 0 && other.corrupt);
  const asRecurring = await tamper((r) => { r.source = 'recurring'; });
  check('dca terms on another source drop the record', asRecurring.records.length === 0 && asRecurring.corrupt);
  const noMeta = await tamper((r) => { delete r.dca; });
  check('a dca record without its terms is dropped', noMeta.records.length === 0 && noMeta.corrupt);
  const badLast = await tamper((r) => { r.dca.lastSwap = { userOpHash: 'x' }; });
  check('a malformed last-swap entry drops the record', badLast.records.length === 0 && badLast.corrupt);

  const loads = vault.loads;
  const ex = await caught(() => buildSubscriptionKeyExport(record, vault));
  check('the key export is refused with its own sentence, without reading the vault', ex?.message === DCA_KEY_NEVER_EXPORTED && vault.loads === loads);
  const mk = await caught(() => markSubscriptionKeyExported(record, store, vault));
  check('marking a hand-over is refused; the key stays', mk?.message === DCA_KEY_NEVER_EXPORTED && vault.map.has(sessionVaultId(M, ACCOUNT, record.permissionId)));
  const rel = await caught(() => releaseSessionKey(record, store, vault));
  check('releasing the key is refused; the key stays', rel?.message === 'A recurring swap’s key never leaves this device. Revoke the recurring swap instead.' && vault.map.has(sessionVaultId(M, ACCOUNT, record.permissionId)));
  check('no hand-over is ever offered', subscriptionHandoverOffer(record, { kind: 'active', expired: false }) === 'none');
  const { terms, floorBps } = termsAt();
  const keyBytes = ethers.randomBytes(32);
  const keyAddress = createSessionKeyAccount(keyBytes.slice()).address;
  const grant = dcaGrantForTerms(terms, keyAddress, NOW);
  const { install, quote } = await prepareSessionInstall(bundle, OWNER_0, ACCOUNT, grant, { now: NOW });
  const base = { quote, install, grant, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3', label: 'x', source: 'dca', store: memoryStore(), vault: fakeVault(), submit: async () => ({ userOpHash: '0x' + 'ee'.repeat(32) }) };
  const meta = dcaMeta(terms, { nativeSymbol: 'test ETH', floorBps, quoteAtReview: QUOTE });
  const noKey = await caught(() => installSession({ ...base, dca: meta, sessionPrivateKey: null }));
  check('an install without the key on this device is refused', noKey?.message === 'A recurring swap needs its key on this device. Nothing was signed.');
  const preHanded = await caught(() => installSession({ ...base, dca: { ...meta, keyExportedAt: 1 }, sessionPrivateKey: keyBytes.slice() }));
  check('an install claiming a hand-over is refused', preHanded?.message === 'A recurring swap’s key is never handed over. Nothing was signed.');
  const mismatch = await caught(() => installSession({ ...base, dca: dcaMeta({ ...terms, minimumOut: terms.minimumOut - 1n }, { nativeSymbol: 'test ETH', floorBps, quoteAtReview: QUOTE }), sessionPrivateKey: keyBytes.slice() }));
  check('an install whose terms do not match the grant is refused', mismatch?.message === 'The recurring-swap terms do not match the grant being installed. Nothing was signed.');
  const noTerms = await caught(() => installSession({ ...base, sessionPrivateKey: keyBytes.slice() }));
  check('an install as dca without terms is refused', noTerms?.message === 'Recurring-swap terms belong exactly to recurring-swap grants. Nothing was signed.');
  check('revoke wording, prompt, key sentence and progress titles',
    revokeConfirmCopy(record, 'Recurring swap: x').heading === 'Stop recurring swap “Recurring swap: x”' && revokeConfirmCopy(record, 'x').button === 'Revoke recurring swap' &&
      revokeApprovalPrompt(record) === 'Approve revoking this recurring swap' &&
      sessionRevokeKeySentence(record) === 'Signed by your account key. Once the bundler accepts it, the swap key is deleted from this phone.' &&
      sessionProgressTitle('dca') === 'Recurring swap set-up sent to the bundler' && sessionProgressTitle('dca-swap') === 'Swap sent to the bundler' &&
      sessionProgressTitle('dca-revoke') === 'Recurring swap revocation sent to the bundler');
}

// ---------------------------------------------------------------------------
console.log('check-dca: due detection, banner, reminders');
// ---------------------------------------------------------------------------
{
  const { record } = main;
  const status = await readSubscriptionStatus(node, record, NOW);
  check('the shared status read works for a recurring swap (RateLimitPolicy / GasPolicy)', status.kind === 'ok' && status.state.remainingPulls === 3 && status.state.intervalSeconds === PERIOD);
  const before = dcaDueState(record, status, NOW - 1);
  const due = dcaDueState(record, status, NOW + 1);
  const catchUp = dcaDueState(record, status, NOW + PERIOD + 1);
  check('before the first slot: later; at it: due (1 open); a period later: 2 open (catch-up)',
    before.kind === 'later' && before.at === NOW && due.kind === 'due' && due.openSlots === 1 && catchUp.kind === 'due' && catchUp.openSlots === 2);
  check('card lines in swap words', dcaStatusLines(record, due, 'test ETH').join(' | ').startsWith('Swap due now (since ') &&
    dcaStatusLines(record, catchUp, 'test ETH')[0].includes('2 swaps due now') && dcaStatusLines(record, due, 'test ETH').includes('0 of 3 swaps sent.') &&
    dcaStatusLines(record, before, 'test ETH')[0].startsWith('Next swap: not before '));
  check('card summary', dcaSummary(record) === '0.00001 test ETH → USDC every 5 minutes (at least 0.445076 USDC each, 95% of the quote at set-up)', dcaSummary(record));
  let reads = 0;
  const found = await findDueRecurringPayments({ chain: M, owner: OWNER_0, store, now: NOW + 1, readStatus: async (r) => (reads += 1, readSubscriptionStatus(node, r, NOW + 1)) });
  check('the foreground check includes recurring swaps (one read, due)', found.checked === 1 && reads === 1 && found.due.length === 1 && found.due[0].record.source === 'dca');
  const states = await readRecurringDueStates({ chain: M, owner: OWNER_0, store, now: NOW + 1, readStatus: (r) => readSubscriptionStatus(node, r, NOW + 1) });
  check('the reminders’ status read includes recurring swaps', states.states.length === 1 && states.states[0].due?.kind === 'due');

  // The 2026-10-11 DCA pass: an ENDED (or revoked) plan still showed "1
  // recurring swap is due". The due computation must never call an ended or
  // revoked plan due, and the foreground check must drop it.
  const END = parseSessionKeyGrant(record.grant).validUntil;
  const endedStatus = await readSubscriptionStatus(node, record, END + 1000);
  const ended = dcaDueState(record, endedStatus, END + 1000);
  check('an ended plan (now past the grant end) with swaps still unsent is completed (ended), never due', ended.kind === 'completed' && ended.reason === 'ended');
  const endedFound = await findDueRecurringPayments({ chain: M, owner: OWNER_0, store, now: END + 1000, readStatus: (r) => readSubscriptionStatus(node, r, END + 1000) });
  check('the foreground check counts no due swap once the plan has ended (candidate still installed, but not due)', endedFound.checked === 1 && endedFound.due.length === 0);
  const revoked = dcaDueState({ ...record, localStatus: 'revoked' }, endedStatus, NOW + 1);
  check('a revoked recurring swap is never due (not-ready locally, and dropped from the foreground candidates)',
    revoked.kind === 'not-ready' && (await findDueRecurringPayments({ chain: M, owner: OWNER_0, store: await (async () => { const s = memoryStore(); await saveSessionRecord({ ...record, localStatus: 'revoked' }, s); return s; })(), now: NOW + 1, readStatus: async () => status })).due.length === 0);
  check('headline: payments unchanged, swaps named',
    scheduledDueHeadline(1, 0) === '1 recurring payment is due. Each is sent only after you confirm it on the Sessions screen.' &&
      scheduledDueHeadline(0, 1) === '1 recurring swap is due. Each is sent only after you confirm it on the Sessions screen.' &&
      scheduledDueHeadline(0, 2) === '2 recurring swaps are due. Each is sent only after you confirm it on the Sessions screen.' &&
      scheduledDueHeadline(2, 1) === '2 recurring payments and 1 recurring swap are due. Each is sent only after you confirm it on the Sessions screen.' &&
      scheduledDueHeadline(0, 0) === null);
  const finder = body(src('../src/wallet/recurring.ts'), 'export async function findDueRecurringPayments', '\n}\n');
  check('the finder has no vault, bundler or send (source)', finder.length > 200 && !/sendSessionCalls|payDcaSwap|vault|bundler/i.test(code(finder)));
  const banner = src('../src/components/RecurringDueBanner.tsx');
  check('the banner counts swaps and has no path to a swap (source)', /scheduledDueHeadline\(result\.payments, result\.swaps\)/.test(banner) && !/payDcaSwap|planDcaSwap|runDcaSwap|sendSessionCalls|sessionKeyVault/.test(banner));
  check('reminders: a recurring swap is eligible; its reminder is for the next slot (grant interval) and uses swap words',
    recurringReminderEligible(record) && recurringReminderAt(record, due, NOW + 1) === NOW + PERIOD &&
      recurringSwapDueContent().title === RECURRING_SWAP_DUE_TITLE && RECURRING_SWAP_DUE_TITLE === 'Recurring swap due' &&
      RECURRING_SWAP_DUE_BODY === 'A recurring swap is due. Open the wallet to review it; nothing is swapped until you confirm it.' &&
      recurringSwapDueContent().data.screen === 'Sessions' && recurringSwapDueContent.length === 0);
  const plan = planRecurringSync({ scheduled: [], records: [record], states: [{ record, due }], now: NOW + 1 });
  check('the sync plan schedules it, marked as a swap', plan.schedule.length === 1 && plan.schedule[0].identifier === recurringNotificationId(record) && plan.schedule[0].swap === true && plan.schedule[0].at === NOW + PERIOD);
  check('a revoked swap is not eligible', !recurringReminderEligible({ ...record, localStatus: 'revoking' }) && !recurringReminderEligible({ ...record, keyHeld: false }));
  check('the scheduler picks the swap words for swap entries (source)', /content: s\.swap \? recurringSwapDueContent\(\) : recurringDueContent\(\)/.test(src('../src/wallet/notifications.ts')));
}

// ---------------------------------------------------------------------------
console.log('check-dca: each period — plan, confirm, swap');
// ---------------------------------------------------------------------------
{
  const { record, keyAddress } = main;
  const loads = vault.loads;
  const bundlerCalls = bundler.calls.length;
  const early = await caught(() => planDcaSwap({ node, record, now: NOW - 1 }));
  check('a swap before its slot is refused locally (no key read, no bundler call)',
    early instanceof RecurringNotDueError && /^This swap is not due yet: the next one can be sent from /.test(early.message) && /Nothing was swapped\.$/.test(early.message) &&
      vault.loads === loads && bundler.calls.length === bundlerCalls);
  let plan = null;
  const planErr = await caught(async () => {
    plan = await planDcaSwap({ node, record, now: NOW + 1 });
  });
  check('a due swap is planned (no local refusal)', planErr === null && plan !== null, planErr?.message);
  if (!plan) {
    console.log(`check-dca: ${passed} passed, ${failed} failed (stopped: no plan)`);
    process.exit(1);
  }
  const p = decodeDcaSwapData(plan.calls[0].data);
  const asked = (QUOTE * 9900n) / 10_000n; // 463,816
  check('plan: one call to the router, value = the amount, recipient = the account, minimum = fresh quote − 1% (463,816)',
    plan.calls.length === 1 && same(plan.calls[0].to, ROUTER) && plan.calls[0].value === AMOUNT && same(p.recipient, ACCOUNT) && p.amountIn === AMOUNT &&
      plan.minimumOut === asked && p.amountOutMinimum === asked && asked === 463_816n && same(p.tokenIn, WETH) && same(p.tokenOut, USDC) && p.fee === 500 && p.sqrtPriceLimitX96 === 0n);
  check('the plan read no key and called no bundler', vault.loads === loads && bundler.calls.length === bundlerCalls);
  node.state.quote = 400_000n; // the price fell below the floor
  let crashed = null;
  const crashErr = await caught(async () => {
    crashed = await planDcaSwap({ node, record, now: NOW + 1 });
  });
  check('a quote below the floor: the swap asks EXACTLY the floor, never less',
    crashErr === null && crashed.minimumOut === FLOOR && decodeDcaSwapData(crashed.calls[0].data).amountOutMinimum === FLOOR, crashErr?.message);
  node.state.quote = QUOTE;
  const badPool = fakeNode({ factoryPool: '0x' + '12'.repeat(20) });
  badPool.install(record.permissionId, keyAddress, main.grant);
  const poolErr = await caught(() => planDcaSwap({ node: badPool, record, now: NOW + 1 }));
  check('a pool the factory does not confirm is refused before any quote', /not the pinned/.test(poolErr?.message ?? ''), poolErr?.message);
  const msg = dcaConfirmMessage(plan, { nativeSymbol: 'test ETH' });
  check('confirmation text: amount, the minimum and where it comes from, the floor, the period cost of a revert, the fee budget, the prompts',
    msg === `Swap 0.00001 test ETH for at least 0.463816 USDC from your smart account ${ACCOUNT}. The quote just now is 0.468502 USDC; this swap asks for that less 1%, never less than the plan’s minimum of 0.445076 USDC. If the pool pays less when the swap runs, it reverts and that period’s swap is used up (only the network fee is lost). The network fee comes from your smart account and counts against the fee budget (0.01 test ETH left). ${DCA_PAY_PROMPT_NOTE}`, msg);

  const order = [];
  const declined = await runDcaSwap({ plan: async () => (order.push('plan'), plan), confirm: async () => (order.push('confirm'), false), pay: async () => (order.push('pay'), 'x') });
  check('declined: the swap is never sent', declined.outcome === 'cancelled' && order.join() === 'plan,confirm');
  const truthy = await runDcaSwap({ plan: async () => plan, confirm: async () => 'yes', pay: async () => 'x' });
  check('only an exact true confirms', truthy.outcome === 'cancelled');

  // Local refusals BEFORE any request or key read.
  const nodeCalls = node.calls.length;
  const loads2 = vault.loads;
  const swap = plan.calls[0];
  const batch = await caught(() => sendSessionCalls({ bundle, record, calls: [swap, swap], vault, now: NOW + 1 }));
  check('a batch of two in-rule swaps is refused (DCA_BATCH_REFUSAL) before any request or key read',
    batch?.message === DCA_BATCH_REFUSAL && vault.loads === loads2 && node.calls.length === nodeCalls, batch?.message);
  const terms = plan.terms;
  const otherRecipient = { ...swap, data: buildDcaSwapCall({ ...terms, account: OWNER_0, recipient: OWNER_0 }).data };
  const rec = await caught(() => sendSessionCalls({ bundle, record, calls: [otherRecipient], vault, now: NOW + 1 }));
  check('a swap paying another recipient is refused (DCA_RECIPIENT_REFUSAL) before any request or key read',
    rec?.message === DCA_RECIPIENT_REFUSAL && vault.loads === loads2 && node.calls.length === nodeCalls, rec?.message);
  const lowData = (() => {
    const d = new Uint8Array(swap.data);
    d.set(ethers.getBytes(word(FLOOR - 1n)), 4 + 160);
    return d;
  })();
  const low = await caught(() => sendSessionCalls({ bundle, record, calls: [{ ...swap, data: lowData }], vault, now: NOW + 1 }));
  check('a swap asking less than the floor is refused (DCA_MINIMUM_BELOW_FLOOR_REFUSAL) before any request or key read',
    low?.message === DCA_MINIMUM_BELOW_FLOOR_REFUSAL && vault.loads === loads2 && node.calls.length === nodeCalls, low?.message);
  const lowPay = await caught(() => payDcaSwap({ bundle, plan: { ...plan, calls: [{ ...swap, data: lowData }] }, vault, store, now: NOW + 1 }));
  check('payDcaSwap refuses the same before the spending check or the key', lowPay?.message === DCA_MINIMUM_BELOW_FLOOR_REFUSAL && vault.loads === loads2);

  // The swap, signed by the swap key alone.
  const sent = await payDcaSwap({ bundle, plan, vault, store, now: NOW + 1 });
  const op = fromRpcOp(bundler.lastOp);
  const hash = getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID);
  const signer = ethers.recoverAddress(ethers.hashMessage(hash), toHex(op.signature.slice(1)));
  check('op: sender = the Kernel account, nonce on the permission key, signature 0xff + 65 bytes',
    same(op.sender, ACCOUNT) && op.nonce >> 64n === sessionNonceKey(record.permissionId) && op.signature.length === 66 && op.signature[0] === 0xff && typeof sent.userOpHash === 'string');
  check('the signature recovers (ethers) to the SWAP key, not the owner', same(signer, keyAddress) && !same(signer, OWNER_0));
  const exec = decodeKernelExecute(op.callData);
  const decoded = new ethers.Interface(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))']).decodeFunctionData('exactInputSingle', exec.calls[0].data)[0];
  check('calldata executes exactly one exactInputSingle to the router (ethers decode): the account as recipient, the amount, the asked minimum',
    exec.callType === 0 && exec.calls.length === 1 && same(exec.calls[0].to, ROUTER) && exec.calls[0].value === AMOUNT &&
      same(decoded.recipient, ACCOUNT) && decoded.amountIn === AMOUNT && decoded.amountOutMinimum === asked && same(decoded.tokenIn, WETH) && same(decoded.tokenOut, USDC) && decoded.fee === 500n);
  check('the swap key was read exactly once', vault.loads === loads2 + 1);
  node.swapped(record.permissionId);
  const again = await caught(() => planDcaSwap({ node, record, now: NOW + 5 }));
  check('right after a swap the next one is refused locally as not due', again instanceof RecurringNotDueError && /not due yet/.test(again.message));
  check('the swap path uses kernelDcaSpec for recurring swaps (source)',
    /const spec = dcaTerms\s*\?\s*kernelDcaSpec\(/.test(src('../src/wallet/sessions.ts')) && /assertDcaSwap\(dcaTerms, grant\.sessionKey, args\.calls,/.test(src('../src/wallet/sessions.ts')));

  // The outcome, decoded from the receipt.
  const topicAddr = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  const signedWord = (n) => '0x' + BigInt.asUintN(256, n).toString(16).padStart(64, '0');
  const swapLog = (recipient) => ({
    address: POOL,
    topics: [UNISWAP_V3_SWAP_TOPIC, topicAddr(ROUTER), topicAddr(recipient)],
    data: '0x' + [signedWord(-QUOTE), signedWord(AMOUNT), word(1n << 96n), word(1n), signedWord(-200000n)].map((w) => w.slice(2)).join(''),
  });
  const transferLog = { address: USDC, topics: [ethers.id('Transfer(address,address,uint256)'), topicAddr(POOL), topicAddr(ACCOUNT)], data: word(QUOTE) };
  const uoe = (success) => ({
    address: ENTRYPOINT_V07,
    topics: [ethers.id('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'), sent.userOpHash, topicAddr(ACCOUNT), topicAddr(ZERO)],
    data: '0x' + [word(0), word(success ? 1 : 0), word(1), word(1)].map((w) => w.slice(2)).join(''),
  });
  const args = { terms: plan.terms, quotedOut: plan.quote.amountOut, minimumOut: plan.minimumOut, userOpHash: sent.userOpHash, at: NOW + 1, txHash: TX_HASH };
  const ok = dcaLastSwapFrom({ ...args, receipt: { receipt: { logs: [swapLog(ACCOUNT), transferLog, uoe(true)] } }, success: true });
  check('decoded outcome: swapped, 468,502 USDC received, not batched', ok.outcome === 'swapped' && ok.received === '468502' && !ok.batched && ok.quotedOut === '468502' && ok.askedMinimum === '463816');
  const reverted = dcaLastSwapFrom({ ...args, receipt: { receipt: { logs: [uoe(false)] } }, success: null });
  check('an included swap that reverted: outcome reverted (it used its period)', reverted.outcome === 'reverted' && reverted.received === null);
  const batched = dcaLastSwapFrom({ ...args, receipt: { receipt: { logs: [swapLog(ACCOUNT), swapLog(ACCOUNT), uoe(true)] } }, success: true });
  check('two swaps of the pinned pool in one operation are flagged as batched', batched.batched === true);
  const pending = dcaLastSwapFrom({ ...args, receipt: null, success: null });
  check('no receipt yet: pending', pending.outcome === 'pending');
  const savedOk = await saveDcaLastSwap(record, ok, store);
  check('the outcome is stored on the record and loads back', savedOk.dca.lastSwap.outcome === 'swapped' && (await loadSessions(store)).records[0].dca.lastSwap.received === '468502');
  const okLines = dcaLastSwapLines(savedOk);
  check('card: received vs the quote, the asked minimum and the floor (exact)',
    okLines[0] === `Last swap (${new Date((NOW + 1) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC): received 0.468502 USDC for 0.00001 test ETH; the quote just before sending was 0.468502 USDC, and the swap asked for at least 0.463816 USDC (the plan’s minimum is 0.445076 USDC).`, okLines[0]);
  const revLines = dcaLastSwapLines({ ...savedOk, dca: { ...savedOk.dca, lastSwap: reverted } });
  check('card: a reverted swap "used its period"', /reverted on-chain and used its period: nothing was swapped and no test ETH left the account except the network fee\./.test(revLines[0]), revLines[0]);
  const batchLines = dcaLastSwapLines({ ...savedOk, dca: { ...savedOk.dca, lastSwap: batched } });
  check('card: a batched operation tells the user to revoke if it was not theirs', /If you did not send it, revoke this plan now\./.test(batchLines[1] ?? ''));
  check('progress line for the swap', dcaOutcomeLine(ok, plan.terms, 'test ETH') === 'Received 0.468502 USDC for 0.00001 test ETH (the quote just before sending was 0.468502 USDC; the swap asked for at least 0.463816 USDC).' &&
    /used its period/.test(dcaOutcomeLine(reverted, plan.terms, 'test ETH')));
  const badSave = await caught(() => saveDcaLastSwap(record, { ...ok, received: '-1' }, store));
  check('a malformed outcome is never stored', /malformed/.test(badSave?.message ?? ''));
}

// ---------------------------------------------------------------------------
console.log('check-dca: refusals in plain words');
// ---------------------------------------------------------------------------
{
  const ctx = { accountType: 'kernel-v3.3', symbol: 'test ETH' };
  const d = (e) => describeDcaSwapError(e, ctx, describeSendError);
  const aa22 = d(new Error('-32500: AA22 expired or not due'));
  check('AA22 → refused, not due or ended', aa22.outcome === 'refused' && aa22.title === DCA_REFUSED_TITLE && aa22.detail.startsWith('Your account refused this swap: it is not due yet, or the recurring swap has ended. Nothing was swapped.'));
  check('CallViolatesParamRule → outside the plan', /pair, pool, amount, recipient or minimum is outside the plan/.test(dcaRefusalSentence(`AA23 reverted ${sel('CallViolatesParamRule()')}`) ?? ''));
  check('CallViolatesValueRule → more ETH than the amount', /more test ETH than the plan’s amount/.test(dcaRefusalSentence(`AA23 reverted ${sel('CallViolatesValueRule()')}`) ?? ''));
  check('PolicyFailed(2) → the fee budget is used up', /the fee budget is used up/.test(dcaRefusalSentence(`reverted ${sel('PolicyFailed(uint256)')}${'0'.repeat(63)}2`) ?? ''));
  check('"Too little received" at the bundler → nothing swapped, the period not used', /period was not used/.test(dcaRefusalSentence('execution reverted: Too little received') ?? ''));
  check('a revoked permission (AA23 reverted 0x)', /not installed any more/.test(dcaRefusalSentence('AA23 reverted 0x') ?? ''));
  const unreachable = d(new RecurringStatusUnreachableError('the endpoint did not answer (fetch failed: x)'));
  check('an unanswered status read → not sent, never "refused"', unreachable.outcome === 'not-sent' && unreachable.detail.includes(DCA_NOT_SENT_SENTENCE));
  check('attempt lines', dcaAttemptLine('refused', 'A.\n\nB') === 'Last swap attempt refused: A.' && /outcome unknown/.test(dcaAttemptLine('outcome-unknown', 'x')));
}

// ---------------------------------------------------------------------------
console.log('check-dca: the screen (source)');
// ---------------------------------------------------------------------------
{
  const screen = src('../src/screens/SessionsScreen.tsx');
  check('the screen sends a swap in exactly one place: the pay step of runDcaSwap (source)',
    (screen.match(/payDcaSwap\(/g) ?? []).length === 1 &&
      /runDcaSwap\(\{[\s\S]{0,200}plan: \(\) => activeEvmNodeRunner\(\(node\) => planDcaSwap\(\{ node, record \}\), \{ isFailure: isRecurringNodeFailure \}\),[\s\S]{0,40}confirm: \(plan\) => \{[\s\S]{0,120}return confirmSwapDialog\(plan\);[\s\S]{0,80}\},\s*pay: \(plan\) => \{[\s\S]{0,80}return quoteOnNode\(\(b\) => payDcaSwap\(\{ bundle: b, plan, vault: sessionKeyVault \}\)\)/.test(screen));
  const dialog = body(screen, 'const confirmSwapDialog =', 'const onSwapNow =');
  check('the dialog resolves true only from "Swap now"; Cancel and dismiss resolve false (source)',
    /text: 'Cancel', style: 'cancel', onPress: \(\) => resolve\(false\)/.test(dialog) && /text: 'Swap now', onPress: \(\) => resolve\(true\)/.test(dialog) &&
      /onDismiss: \(\) => resolve\(false\)/.test(dialog) && (dialog.match(/resolve\(true\)/g) ?? []).length === 1);
  const onSwap = code(body(screen, 'const onSwapNow = async', 'const onShowKey = async'));
  check('a swap never opens the recovery phrase or the owner key (source)', onSwap.length > 200 && !/requireLocalAuth|signWith/.test(onSwap));
  check('the only caller of onSwapNow is the card’s "Swap now" (source)',
    (screen.match(/onSwapNow\(/g) ?? []).length === 1 && /onSwapNow=\{\(\) => void onSwapNow\(r\)\}/.test(screen) && /title="Swap now"/.test(src('../src/screens/DcaViews.tsx')));
  const refresh = body(screen, 'const refreshRecord = useCallback(', 'const reloadList = useCallback(');
  check('loading and refreshing never swap (source)', refresh.length > 100 && !/onSwapNow|runDcaSwap|payDcaSwap/.test(refresh));
  check('"New recurring swap" is gated by the dca row and the network (source)',
    /title="New recurring swap"[\s\S]{0,300}disabled=\{listFlags\.unreadable \|\| readiness !== null \|\| dcaReadiness !== null \|\| dcaNetworkNote !== null\}/.test(screen) &&
      /const dcaReadiness = readinessGate\('dca', evmChain\.caip2\);/.test(screen));
  check('Start asks for the owner’s device check and installs as source dca with the terms (source)',
    /requireLocalAuth\('Approve this recurring swap'\)/.test(screen) && /source: DCA_SOURCE,\s*\n\s*dca: dcaMeta\(p\.terms,/.test(screen));
  const views = code(src('../src/screens/DcaViews.tsx'));
  const review = body(views, 'export function DcaReviewView', 'export function DcaListHeading');
  const iBatch = review.indexOf('<WarningBox>{review.batching}</WarningBox>');
  const iFloor = review.indexOf('{floorCaveat ? <WarningBox>{floorCaveat}</WarningBox> : null}');
  const iRest = review.indexOf('{restCaveats.map(');
  const iSentence = review.indexOf('{review.sentence}');
  check('the review renders the batching box first, then the floor box, then the other caveats, before anything else (source)',
    iBatch > 0 && iBatch < iFloor && iFloor < iRest && iRest < iSentence, `${iBatch} ${iFloor} ${iRest} ${iSentence}`);
  const card = body(views, 'export function DcaCard', 'const styles');
  check('a live card shows the batching and floor warnings (source)', /\{live \? <WarningBox>\{review\.batching\}<\/WarningBox> : null\}/.test(card) && /\{live && review\.caveats\[0\] \? <WarningBox>\{review\.caveats\[0\]\}<\/WarningBox> : null\}/.test(card));
  check('the form shows the pool, router and quote lines and the set-up cost (source)', /dcaMarketLines\(/.test(views) && /dcaSetupCostNote\(/.test(views) && /dcaSetupFundingWarning\(/.test(views));
}

// ---------------------------------------------------------------------------
console.log('check-dca: mainnet');
// ---------------------------------------------------------------------------
{
  const mainnetRecord = { ...main.record, chain: 'eip155:1' };
  const e1 = await caught(() => planDcaSwap({ node, record: mainnetRecord, now: NOW + 1 }));
  check('planning on mainnet is refused before any request', e1 instanceof FeatureNotAllowedError);
  check('featureReadiness("dca") resolves', featureReadiness('dca').id === 'dca');
}

// ---------------------------------------------------------------------------
console.log('check-dca: phase 20 item 0 findings 1 and 3 (fee-budget hint, the floor clause tense)');
// ---------------------------------------------------------------------------
{
  const { terms } = termsAt(Date.UTC(2026, 9, 11, 12, 0, 0) / 1000);
  const onReview = dcaReview(terms, { nativeSymbol: 'test ETH', stage: 'review' });
  const onCard = dcaReview(terms, { nativeSymbol: 'test ETH', stage: 'set-up' });
  check('the review (before set-up) says the minimum "will be fixed when the plan is set up"',
    onReview.caveats[0].startsWith('THE MINIMUM DOES NOT FOLLOW THE PRICE. 0.445076 USDC per swap will be fixed when the plan is set up. ') &&
      !onReview.caveats[0].includes(DCA_FLOOR_FIXED_PAST), onReview.caveats[0]);
  check('an installed plan’s card keeps the past tense ("was fixed when the plan was set up")',
    onCard.caveats[0].startsWith('THE MINIMUM DOES NOT FOLLOW THE PRICE. 0.445076 USDC per swap was fixed when the plan was set up. ') &&
      !onCard.caveats[0].includes(DCA_FLOOR_FIXED_FUTURE), onCard.caveats[0]);
  check('only that clause changes; every other caveat is identical between the two stages',
    onReview.caveats.slice(1).join('|') === onCard.caveats.slice(1).join('|') && onReview.batching === onCard.batching);
  const dv = src('../src/screens/DcaViews.tsx');
  check('the review screen asks for the review stage, the card for the set-up stage (source)',
    dv.includes("dcaReview(terms, { nativeSymbol: symbol, stage: 'review' })") && dv.includes("dcaReview(dcaTermsOf(r), { nativeSymbol: symbol, stage: 'set-up' })"));

  // Finding 1: after the auto-fit block the field shows the budget lowered to
  // what can be kept back, and the hint must say so (it said it followed the
  // suggestion for the number of swaps).
  const symbol = 'test ETH';
  const plain = dcaFeeBudgetFormHint({ source: 'bundler', suggestion: { capped: false, spare: 10n ** 18n, uncapped: 1n }, installKeptBack: null, nativeSymbol: symbol });
  check('not capped: the suggestion hint, unchanged', plain === dcaFeeBudgetSuggestionHint('bundler') && /it follows that number until you type your own figure/.test(plain));
  const spare = 1_000_000_000_000_000n;
  const uncapped = 24_948_000_000_000_000n;
  const kept = 3_000_000_000_000_000n;
  const capped = dcaFeeBudgetFormHint({ source: 'bundler', suggestion: { capped: true, spare, uncapped }, installKeptBack: kept, nativeSymbol: symbol });
  check('capped (after a blocked review): the hint names the lowered figure shown, the usual budget and the set-up fee kept back',
    capped === `${dcaFeeBudgetCapNote(spare, uncapped, symbol, kept)} ${DCA_FEE_BUDGET_CLEAR_NOTE}` &&
      capped.startsWith('Lowered to what your account can spare (0.001 test ETH); the usual budget for this many swaps would be 0.024948 test ETH.') &&
      capped.includes('0.003 test ETH is kept back for the set-up’s own worst-case network fee.') &&
      capped.endsWith('The field shows this lowered figure; clearing a figure you typed brings it back, not the usual budget.'), capped);
  check('capped: the hint no longer claims the field follows the suggestion', !/it follows that number/.test(capped) && !capped.includes('Suggested from'));
  const none = dcaFeeBudgetFormHint({ source: 'bundler', suggestion: { capped: true, spare: 0n, uncapped }, installKeptBack: kept, nativeSymbol: symbol });
  check('nothing to spare: the cap note alone (the field is empty)', none === dcaFeeBudgetCapNote(0n, uncapped, symbol, kept) && /Fund the account first/.test(none));
  const screen = src('../src/screens/SessionsScreen.tsx');
  check('the form renders dcaFeeBudgetFormNote (the hint with how to show it) from the same suggestion the field shows, with the kept-back set-up fee (source)',
    /dcaFeeBudgetFormNote\(\{\s*source: props\.feeFacts\.feeSource,\s*suggestion: props\.feeSuggestion,\s*installKeptBack: props\.installKeptBack,/.test(dv) &&
      !/dcaFeeBudgetSuggestionHint\(/.test(dv) &&
      /feeBudgetText=\{dcaFeeBudgetText\}\s*feeSuggestion=\{dcaFeeSuggestion\}\s*installKeptBack=\{subInstallKeepBack\}/.test(screen) &&
      /const dcaFeeBudgetText = dcaForm\.feeEdited\s*\? dcaForm\.feeBudget\s*: dcaFeeSuggestion\.wei !== null/.test(screen));
}

// ---------------------------------------------------------------------------
console.log('check-dca: pass p20c findings 8 and 17 (the refusal announced once; the cap note never in muted grey)');
// ---------------------------------------------------------------------------
{
  const { formFeeHintShown } = await import('../src/wallet/subscriptions.ts');
  const symbol = 'test ETH';
  const plainNote = dcaFeeBudgetFormNote({ source: 'bundler', suggestion: { capped: false, spare: 10n ** 18n, uncapped: 1n }, installKeptBack: null, nativeSymbol: symbol });
  const capNote = dcaFeeBudgetFormNote({ source: 'bundler', suggestion: { capped: true, spare: 10n ** 15n, uncapped: 2n * 10n ** 16n }, installKeptBack: 3n * 10n ** 15n, nativeSymbol: symbol });
  const noneNote = dcaFeeBudgetFormNote({ source: 'bundler', suggestion: { capped: true, spare: 0n, uncapped: 2n * 10n ** 16n }, installKeptBack: 3n * 10n ** 15n, nativeSymbol: symbol });
  check('the plain suggestion is a hint (warning false); its text equals dcaFeeBudgetFormHint',
    plainNote.warning === false && plainNote.text === dcaFeeBudgetSuggestionHint('bundler'));
  check('the cap note (the account cannot fund the usual budget) is a WARNING, with and without anything to spare',
    capNote.warning === true && noneNote.warning === true && /Fund the account first/.test(noneNote.text));
  check('formFeeHintShown: shown while the suggestion is used and no refusal is on screen; hidden once the user typed a budget or Review refused',
    formFeeHintShown({ feeEdited: false, formError: null }) === true &&
      formFeeHintShown({ feeEdited: true, formError: null }) === false &&
      formFeeHintShown({ feeEdited: false, formError: 'This plan cannot run: …' }) === false);
  const dv = src('../src/screens/DcaViews.tsx');
  check('DcaViews: the cap note renders in a WarningBox, the plain suggestion in the muted hint style (source)',
    /return note\.warning \? \(\s*<WarningBox>\{note\.text\}<\/WarningBox>\s*\) : \(\s*<Text style=\{\[styles\.hint, \{ color: theme\.textMuted \}\]\}>\{note\.text\}<\/Text>/.test(dv) &&
      !dv.includes('dcaFeeBudgetFormHint('));
  check('DcaViews: the note is shown only through formFeeHintShown with the form error, so the shortfall is said once (source)',
    dv.includes('formFeeHintShown({ feeEdited: form.feeEdited, formError: props.error })'));
  check('DcaViews: the Review refusal is an announced WarningBox (live region + focus) (source)',
    dv.includes('{props.error ? <WarningBox announce>{props.error}</WarningBox> : null}'));
  const ss = src('../src/screens/SessionsScreen.tsx');
  check('Sessions (subscription and recurring forms, and the session-grant form): the suggestion and the cap note follow formFeeHintShown, and every Review refusal is announced (source)',
    (ss.match(/formFeeHintShown\(\{ feeEdited: subForm\.feeEdited, formError \}\)/g) ?? []).length === 2 &&
      (ss.match(/\{formError \? <WarningBox announce>\{formError\}<\/WarningBox> : null\}/g) ?? []).length === 2 &&
      !ss.includes('{formError ? <WarningBox>{formError}</WarningBox> : null}'));
  const comp = src('../src/components.tsx');
  check('WarningBox announce: one accessible element, an Android polite live region, and a focus event on the box when it appears or its text changes (source)',
    comp.includes("{...(announce ? { accessible: true, accessibilityLiveRegion: 'polite' as const } : {})}") &&
      /if \(!announce \|\| !ref\.current\) return;\s*AccessibilityInfo\.sendAccessibilityEvent\(ref\.current, 'focus'\);\s*\}, \[announce, spoken\]\);/.test(comp));
}

// ---------------------------------------------------------------------------
console.log('check-dca: phase 20 item 0 finding 8 (a review never started leaves no key in secure storage)');
// ---------------------------------------------------------------------------
{
  // The real key vault (storage.ts createKeyVault) over a fake expo-secure-store.
  const items = new Map();
  const shim = {
    sets: 0,
    whenUnlockedThisDeviceOnly: 7,
    canUseBiometricAuthentication: () => true,
    async getItemAsync(key, opts) { return items.get(`${opts?.keychainService ?? 'default'}|${key}`)?.value ?? null; },
    async setItemAsync(key, value, opts) { shim.sets += 1; items.set(`${opts?.keychainService ?? 'default'}|${key}`, { value }); },
    async deleteItemAsync(key, opts) { items.delete(`${opts?.keychainService ?? 'default'}|${key}`); },
  };
  const kv = createKeyVault(shim);
  await kv.saveNewPhrase(TEST_MNEMONIC);
  const baseline = items.size;
  const setsBefore = shim.sets;
  const n = fakeNode();
  const b = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
  const k = kernelBundle(n, b);
  // What onDcaReview does before the confirm screen, twice (two Reviews,
  // each with a new key, neither started): a fresh key, the terms, the grant
  // and the bundler's quote of the set-up.
  const reviews = [];
  for (let i = 0; i < 2; i += 1) {
    const key = newSessionKey();
    const { terms } = termsAt(NOW);
    const grant = dcaGrantForTerms(terms, key.address, NOW);
    const { install, quote } = await prepareSessionInstall(k, OWNER_0, ACCOUNT, grant, { now: NOW });
    reviews.push({ key, terms, grant, install, quote });
  }
  check('two reviews show two different session-key addresses (a new key per review, by design)', reviews[0].key.address !== reviews[1].key.address);
  check('reviews never started leave ZERO new entries in secure storage (the key is held in memory only)', items.size === baseline && shim.sets === setsBefore, `${items.size} vs ${baseline}, ${shim.sets - setsBefore} writes`);
  // Start on the second review: exactly one key is written, under the record's vault id.
  const r = reviews[1];
  const res = await installSession({
    quote: r.quote, install: r.install, grant: r.grant, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3',
    label: `Recurring swap: ${r.terms.label}`, source: 'dca', dca: dcaMeta(r.terms, { nativeSymbol: 'test ETH', floorBps: 9500, quoteAtReview: QUOTE }),
    sessionPrivateKey: r.key.privateKey, store: memoryStore(), vault: kv.sessionKeys, submit: async () => ({ userOpHash: '0x' + 'ee'.repeat(32) }),
  });
  check('a started review leaves exactly ONE new key, the started review’s, under its record’s vault id',
    items.size === baseline + 1 && (await kv.sessionKeys.load(sessionVaultId(M, ACCOUNT, res.record.permissionId))) === ethers.hexlify(r.key.privateKey).toLowerCase());
  const screen = code(src('../src/screens/SessionsScreen.tsx'));
  const handler = (start, end) => body(screen, start, end);
  const reviewBodies = [
    handler('const onReview = async', 'const onInstall = async'),
    handler('const onSubReview = async', 'const onSubInstall = async'),
    handler('const onDcaReview = async', 'const onDcaInstall = async'),
  ];
  check('no review handler (session, subscription / recurring payment, recurring swap) touches the key vault or installs (source)',
    reviewBodies.every((b2) => b2.length > 200 && !/sessionKeyVault|installSession\(|\.save\(/.test(b2)), reviewBodies.map((b2) => b2.length).join(','));
  check('each review first discards (zeroes) any earlier unsubmitted key, and zeroes its own key on every early return (source)',
    reviewBodies.every((b2) => /discardPending\(\);/.test(b2.slice(0, 400)) && /key\.privateKey\.fill\(0\)/.test(b2)));
  check('discardPending zeroes all three pending keys and also runs when the screen unmounts (source)',
    /const discardPending = useCallback\(\(\) => \{\s*pending\.current\?\.privateKey\.fill\(0\);[\s\S]{0,200}subPending\.current\?\.privateKey\.fill\(0\);[\s\S]{0,200}dcaPending\.current\?\.privateKey\.fill\(0\);/.test(screen) &&
      /useEffect\(\(\) => discardPending, \[discardPending\]\);/.test(screen));
}

console.log(`check-dca: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// Phase 12 item 2 (app half): subscriptions on Kernel session keys, entirely
// OFFLINE. Exercises the exact app modules (src/wallet/subscriptions.ts and
// sessions.ts) under Node's type stripping against fakes:
//  - the form → SubscriptionGrant → session grant mapping, pinned end to end
//    against the ZeroDev SDK vector the engine tests use (permission id and
//    validatorData for 5 USDC / 30 days / 3 payments), and decoded with
//    ethers: ONE allowed call (USDC transfer, recipient EQUAL merchant,
//    amount LESS_THAN_OR_EQUAL cap), TimestampPolicy, GasPolicy and
//    RateLimitPolicy {interval = period, count = payments, startAt = now};
//  - the review copy (engine sentence, on-chain lines, the batch caveat first);
//  - the install through the SAME explicit root-signed path as any session,
//    with the subscription terms stored beside the grant and re-checked on
//    every load (tampered terms drop the record);
//  - the key hand-over: shown once, only after the install is confirmed,
//    deleted from the vault on confirmation, never in the AsyncStorage store,
//    and the wallet can no longer pull or show it afterwards;
//  - the status lines from RateLimitPolicy / GasPolicy reads;
//  - the Sessions screen's TESTNET badge on theme tokens.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-subscriptions.mjs
//
// Nothing is signed against a live chain and nothing is broadcast.

import { readFileSync } from 'node:fs';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  KERNEL_PERMISSION_MODULES,
  KERNEL_V3_3,
  SUBSCRIPTION_MIN_PERIOD_SECONDS,
  SUBSCRIPTION_NATIVE,
  createSessionKeyAccount,
  encodePermissionInstall,
  getUserOpHash,
  kernelPermissionFromGrant,
  sessionNonceKey,
  subscriptionToGrant,
  toBytes,
  toHex,
} from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import { createAaClient, sendAa } from '../src/wallet/aa.ts';
import {
  SESSIONS_KEY,
  describeGrantLimits,
  finalizeSessionInstall,
  installSession,
  loadSessions,
  prepareSessionInstall,
  saveSessionRecord,
  sendSessionCalls,
  sessionCanBeTested,
  sessionVaultId,
} from '../src/wallet/sessions.ts';
import {
  SUBSCRIPTION_KEY_CLIPBOARD_CLEAR_MS,
  SUBSCRIPTION_KEY_CLIPBOARD_WARNING,
  SUBSCRIPTION_KEY_FILE_DELETE_DELAY_MS,
  SUBSCRIPTION_KEY_FILE_DIRECTORY,
  SUBSCRIPTION_KEY_FILE_MIME_TYPE,
  SUBSCRIPTION_KEY_HOLDER_TEXT,
  SUBSCRIPTION_REQUOTE_FEE_TOLERANCE_PERCENT,
  SUBSCRIPTION_START_NOTE,
  SUBSCRIPTION_KEY_EXPORT_TYPE,
  SUBSCRIPTION_KEY_WARNING,
  createClipboardAutoClear,
  feeBudgetCapNote,
  restartSubscriptionAt,
  shareSubscriptionKeyFile,
  sortSubscriptionRecords,
  subscriptionFinalDatesLine,
  subscriptionKeyFileName,
  subscriptionNames,
  subscriptionRequoteNeedsReview,
  suggestedFeeBudget,
  SUBSCRIPTION_MAX_PAYMENTS,
  SUBSCRIPTION_PULL_GAS_ALLOWANCE,
  buildSubscription,
  buildSubscriptionKeyExport,
  defaultFeeBudgetWei,
  markSubscriptionKeyExported,
  readSubscriptionStatus,
  subscriptionGrantFor,
  subscriptionKeyStatusText,
  subscriptionMeta,
  subscriptionRecords,
  subscriptionReview,
  subscriptionStatusLines,
  subscriptionSummary,
  subscriptionTokenChoices,
  termsOf,
  SUBSCRIPTION_EXPIRED_UNHANDED_TEXT,
  SUBSCRIPTION_MAX_PERIOD_SECONDS,
  SUBSCRIPTION_SHORT_WINDOW_SECONDS,
  checkSubscriptionPeriod,
  customPeriodSeconds,
  subscriptionDisplayTitle,
  subscriptionHandoverOffer,
  subscriptionInstallFunding,
  subscriptionInstallKeepBack,
  subscriptionMinPeriodSeconds,
  subscriptionPeriodPresets,
  subscriptionShortWindowWarning,
} from '../src/wallet/subscriptions.ts';
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

const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);
const M = 'eip155:11155111';
const CHAIN_ID = 11155111n;
const ACCOUNT = KERNEL_ACCOUNT_0;
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const MERCHANT = '0x000000000000000000000000000000000000bEEF';
const MONTH = 2_592_000;
const TX_HASH = '0x' + 'cd'.repeat(32);
/** ZeroDev SDK vector (packages/chains-evm/test/kernel-subscription.test.ts). */
const SDK_SESSION_KEY = '0x484B87B8D4D73d88ccF7D39C006cC1b078384640';
const SDK_S = 1790000000;
const SDK_PERMISSION_ID = '0x869d0c9f';
const SDK_VALIDATOR_DATA_HASH = '0x23ba027a7294f71aa7b37d5eedf5da6ed974fbc117a617efec49908e06112107';

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

/**
 * Fake node: Kernel fake + the permission views the engine reads (as in
 * check-sessions.mjs) + RateLimitPolicy.rateLimitConfigs / GasPolicy
 * .gasPolicyConfig / status for the subscription reads.
 */
function fakeNode() {
  const base = fakeKernelNode({ chainIdHex: '0xaa36a7', deployedAccounts: new Set([ACCOUNT]) });
  const state = { currentNonce: 1, permissions: new Map(), rate: new Map(), gas: new Map() };
  const calls = [];
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      const body = '0x' + data.slice(10);
      if (same(to, ACCOUNT) && data.startsWith(sel('currentNonce()'))) return word(state.currentNonce);
      if (same(to, ACCOUNT) && data.startsWith(sel('validationConfig(bytes21)'))) {
        const [vId] = abi.decode(['bytes21'], body);
        const p = state.permissions.get(vId.slice(4, 12).toLowerCase());
        return abi.encode(['uint32', 'address'], [p ? p.nonce : 0, p ? '0x0000000000000000000000000000000000000001' : ZERO]);
      }
      if (same(to, ACCOUNT) && data.startsWith(sel('permissionConfig(bytes4)'))) {
        const [pid] = abi.decode(['bytes4'], body);
        const p = state.permissions.get(pid.slice(2).toLowerCase());
        return abi.encode(['tuple(bytes2,address,bytes22[])'], [[p ? '0x0002' : '0x0000', p ? KERNEL_PERMISSION_MODULES.ecdsaSigner : ZERO, p ? p.policies : []]]);
      }
      if (same(to, ACCOUNT) && data.startsWith(sel('isAllowedSelector(bytes21,bytes4)'))) {
        const [vId] = abi.decode(['bytes21', 'bytes4'], body);
        return word(state.permissions.has(vId.slice(4, 12).toLowerCase()) ? 1 : 0);
      }
      if (data.startsWith(sel('status(bytes32,address)'))) {
        const [id] = abi.decode(['bytes32', 'address'], body);
        const key = id.slice(2, 10).toLowerCase();
        return word(state.permissions.has(key) ? 1 : state.rate.has(key) ? 2 : 0);
      }
      if (same(to, KERNEL_PERMISSION_MODULES.rateLimitPolicy) && data.startsWith(sel('rateLimitConfigs(bytes32,address)'))) {
        const [id] = abi.decode(['bytes32', 'address'], body);
        const r = state.rate.get(id.slice(2, 10).toLowerCase()) ?? { interval: 0, count: 0, startAt: 0 };
        return abi.encode(['uint48', 'uint48', 'uint48'], [r.interval, r.count, r.startAt]);
      }
      if (same(to, KERNEL_PERMISSION_MODULES.gasPolicy) && data.startsWith(sel('gasPolicyConfig(bytes32,address)'))) {
        const [id] = abi.decode(['bytes32', 'address'], body);
        return abi.encode(['uint128', 'bool', 'address'], [state.gas.get(id.slice(2, 10).toLowerCase()) ?? 0n, false, ZERO]);
      }
      if (same(to, KERNEL_PERMISSION_MODULES.ecdsaSigner) && data.startsWith(sel('signer(bytes32,address)'))) {
        const [id] = abi.decode(['bytes32', 'address'], body);
        const p = state.permissions.get(id.slice(2, 10).toLowerCase());
        return pad32(p ? p.signer : ZERO);
      }
      if (same(to, ENTRYPOINT_V07) && data.startsWith(sel('getNonce(address,uint192)'))) {
        const [, key] = abi.decode(['address', 'uint192'], body);
        return word(BigInt(key) << 64n);
      }
    }
    return base(method, params);
  };
  transport.calls = calls;
  transport.state = state;
  /** Emulates the inclusion of the install (policies [call, timestamp, gas, rateLimit]). */
  transport.install = (pid, signer, grant) => {
    const key = pid.replace(/^0x/, '').toLowerCase();
    state.currentNonce += 1;
    const modules = [KERNEL_PERMISSION_MODULES.callPolicy, KERNEL_PERMISSION_MODULES.timestampPolicy, KERNEL_PERMISSION_MODULES.gasPolicy, KERNEL_PERMISSION_MODULES.rateLimitPolicy];
    state.permissions.set(key, { nonce: state.currentNonce, signer, policies: modules.map((m) => '0x0000' + m.slice(2)) });
    state.rate.set(key, { interval: grant.rateLimit.intervalSeconds, count: grant.rateLimit.count, startAt: grant.rateLimit.startAt });
    state.gas.set(key, grant.gasBudgetWei);
  };
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
const usdc = choices.find((c) => same(c.token, USDC));
const native = choices[0];

// ---------------------------------------------------------------------------
console.log('check-subscriptions: token choices and the form');
// ---------------------------------------------------------------------------
check('Sepolia choices: native first, then Circle USDC and EURC (tokens.ts known list, 6 decimals)',
  native.token === SUBSCRIPTION_NATIVE && native.decimals === 18 && native.symbol === 'test ETH' && usdc?.decimals === 6 && choices.some((c) => c.symbol === 'EURC') && choices.length === 3);
check('mainnet offers only the native currency (no known test tokens; readiness keeps sessions off mainnet anyway)', subscriptionTokenChoices('eip155:1', 'ETH').length === 1);
const draft = { merchant: MERCHANT.toLowerCase(), choice: usdc, amount: '5', periodSeconds: MONTH, payments: '3', feeBudget: '0.003', label: 'Streaming' };
const sub = buildSubscription(draft, { now: SDK_S, account: ACCOUNT });
check('form → terms: checksummed merchant, exact 6-decimal amount, start now, expiry = now + 3 periods, exact fee budget',
  sub.merchant === MERCHANT && sub.token === USDC && sub.amountPerPeriod === 5_000_000n && sub.periodSeconds === MONTH && sub.startAt === SDK_S && sub.validUntil === SDK_S + 3 * MONTH && sub.feeBudgetWei === 3_000_000_000_000_000n && sub.label === 'Streaming');
const formErr = async (patch) => (await caught(() => buildSubscription({ ...draft, ...patch }, { now: SDK_S, account: ACCOUNT })))?.message ?? '';
check('form refusals: bad merchant (send screen text), zero amount, too many decimals, non-preset period, payments out of range, bad fee budget',
  /^Merchant: An Ethereum address is 0x/.test(await formErr({ merchant: '0x123' })) &&
    /more than zero/.test(await formErr({ amount: '0' })) &&
    /^Amount:/.test(await formErr({ amount: '1.0000001' })) &&
    /Choose a period/.test(await formErr({ periodSeconds: 999 })) &&
    /1 to 120/.test(await formErr({ payments: String(SUBSCRIPTION_MAX_PAYMENTS + 1) })) &&
    /1 to 120/.test(await formErr({ payments: '1.5' })) &&
    /^Fee budget:/.test(await formErr({ feeBudget: 'abc' })));
const ownErr = (await caught(() => subscriptionGrantFor({ ...sub, merchant: ACCOUNT }, SDK_SESSION_KEY, { account: ACCOUNT, now: SDK_S })))?.message;
check('the engine’s refusal is surfaced verbatim (merchant = your own account)', ownErr === 'The merchant must not be your own account.', ownErr);
const noFee = (await caught(() => subscriptionGrantFor({ ...sub, feeBudgetWei: 0n }, SDK_SESSION_KEY, { account: ACCOUNT, now: SDK_S })))?.message;
check('a fee budget is mandatory (engine text)', /fee budget/.test(noFee ?? ''), noFee);
check('default fee budget = payments × 500k gas × maxFeePerGas × 2 (live pulls charged 302k–368k gas)', SUBSCRIPTION_PULL_GAS_ALLOWANCE === 500_000n && defaultFeeBudgetWei(3, 2_000_000_000n) === 3n * 500_000n * 2_000_000_000n * 2n);

// ---------------------------------------------------------------------------
console.log('check-subscriptions: grant mapping (pinned to the ZeroDev SDK, decoded with ethers)');
// ---------------------------------------------------------------------------
const sdkGrant = subscriptionGrantFor(sub, SDK_SESSION_KEY, { account: ACCOUNT, now: SDK_S - 10 });
{
  const inst = encodePermissionInstall(sdkGrant, { chainId: CHAIN_ID, account: '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106', currentNonce: 3, validationNonce: 0, now: SDK_S - 10 });
  check('form-built grant → permission id equals the SDK’s (toPermissionValidator, flag 0x0002)', toHex(inst.permissionId) === SDK_PERMISSION_ID, toHex(inst.permissionId));
  check('…and validatorData equals the SDK’s getEnableData byte for byte', ethers.keccak256(inst.validatorData) === SDK_VALIDATOR_DATA_HASH);
  check('ONE allowed call; validAfter = start; validUntil = expiry; gas budget; rate limit {period, 3, start}',
    sdkGrant.calls.length === 1 && sdkGrant.validAfter === SDK_S && sdkGrant.validUntil === SDK_S + 3 * MONTH && sdkGrant.gasBudgetWei === 3_000_000_000_000_000n &&
      sdkGrant.rateLimit.count === 3 && sdkGrant.rateLimit.intervalSeconds === MONTH && sdkGrant.rateLimit.startAt === SDK_S);
  const permission = kernelPermissionFromGrant(sdkGrant);
  check('policies in order: CallPolicy, TimestampPolicy, GasPolicy, RateLimitPolicy; signer SKIP_SIGNATURE (0x0002)',
    permission.policies.map((p) => p.module).join() === [KERNEL_PERMISSION_MODULES.callPolicy, KERNEL_PERMISSION_MODULES.timestampPolicy, KERNEL_PERMISSION_MODULES.gasPolicy, KERNEL_PERMISSION_MODULES.rateLimitPolicy].join() && permission.signer.flag === 2);
  const [perms] = abi.decode(['tuple(bytes1 callType, address target, bytes4 selector, uint256 valueLimit, tuple(uint8 condition, uint64 offset, bytes32[] params)[] rules)[]'], toHex(permission.policies[0].data));
  const p0 = perms[0];
  check('CallPolicy permission (ethers decode): CALL to USDC, transfer(address,uint256) selector, 0 value',
    perms.length === 1 && p0[0] === '0x00' && same(p0[1], USDC) && p0[2] === new ethers.Interface(['function transfer(address,uint256)']).getFunction('transfer').selector && p0[3] === 0n);
  check('rule 0: EQUAL (0) at offset 0 = the merchant word; rule 1: LESS_THAN_OR_EQUAL (4) at offset 32 = 5 USDC',
    p0[4].length === 2 && p0[4][0][0] === 0n && p0[4][0][1] === 0n && p0[4][0][2][0] === abi.encode(['address'], [MERCHANT]) &&
      p0[4][1][0] === 4n && p0[4][1][1] === 32n && p0[4][1][2][0] === abi.encode(['uint256'], [5_000_000n]));
  check('TimestampPolicy data = abi.encode(uint48 start, uint48 expiry)', toHex(permission.policies[1].data) === abi.encode(['uint48', 'uint48'], [SDK_S, SDK_S + 3 * MONTH]));
  check('GasPolicy data = abi.encode(uint128 budget, false, 0x0)', toHex(permission.policies[2].data) === abi.encode(['uint128', 'bool', 'address'], [3_000_000_000_000_000n, false, ZERO]));
  check('RateLimitPolicy data = packed uint48 interval ‖ count ‖ startAt (ethers solidityPacked)',
    toHex(permission.policies[3].data) === ethers.solidityPacked(['uint48', 'uint48', 'uint48'], [MONTH, 3, SDK_S]).toLowerCase());
  const nativeSub = buildSubscription({ ...draft, choice: native, amount: '0.000000000000001', periodSeconds: 120 }, { now: SDK_S, account: ACCOUNT, testnet: true });
  const nativeGrant = subscriptionGrantFor(nativeSub, SDK_SESSION_KEY, { account: ACCOUNT, now: SDK_S - 10 });
  check('native: one call to the merchant, no function, value cap = 1000 wei, rate limit {120 s, 3, start}',
    nativeGrant.calls.length === 1 && nativeGrant.calls[0].target === MERCHANT && nativeGrant.calls[0].selector === null && nativeGrant.calls[0].valueLimit === 1000n && nativeGrant.rateLimit.intervalSeconds === 120);
}

// ---------------------------------------------------------------------------
console.log('check-subscriptions: review copy');
// ---------------------------------------------------------------------------
{
  const r = subscriptionReview({ ...sub, startAt: Date.UTC(2026, 9, 3) / 1000, validUntil: Date.UTC(2026, 11, 2) / 1000 }, { tokenSymbol: 'USDC', tokenDecimals: 6, nativeSymbol: 'test ETH', merchantName: 'Streamy' });
  check('sentence: "Lets <merchant> take up to 5 USDC every 30 days until <date>; at most one pull per period."',
    r.sentence === `Lets Streamy (${MERCHANT}) take up to 5 USDC every 30 days until 2026-12-02 00:00 UTC; at most one pull per period.`, r.sentence);
  check('on-chain lines name the token contract, the merchant, the per-transfer cap, the count, the fee budget and the ERC-1271 switch-off',
    r.enforced[0] === `Only USDC (contract ${USDC}) transfers to ${MERCHANT}, at most 5 USDC each.` &&
      /^At most 2 pulls in total: the first from 2026-10-03 00:00 UTC, then one more every 30 days\.$/.test(r.enforced[1]) &&
      r.enforced[3] === 'Network fees for the pulls are paid by your account, at most 0.003 test ETH in total.' &&
      /cannot sign messages, logins or permits/.test(r.enforced[4]));
  check('the FIRST caveat is the batch residual: per-transfer cap, not a per-period total, up to the whole balance',
    /^ONE PULL CAN HOLD SEVERAL TRANSFERS\./.test(r.caveats[0]) && /does not add\s+them up/.test(r.caveats[0]) && /up to everything this account holds in USDC/.test(r.caveats[0]) && /Keep only what you are willing to pay/.test(r.caveats[0]));
  check('caveats also cover catch-up of missed pulls, who holds the key and revocation', /Missed pulls are not lost/.test(r.caveats[1]) && /Whoever holds the subscription key/.test(r.caveats[2]) && /Revoke/.test(r.caveats[3]));
  const limits = describeGrantLimits(sdkGrant, 'test ETH');
  check('the grant review states RateLimitPolicy as it works: a total count, slots from the start, catch-up, per operation',
    limits.includes('Rate limit: at most 3 operations in total, one more becoming valid every 2592000 s from 2026-09-21 14:13:20 UTC; a missed slot can be used later. Counted per operation, not per transfer.'),
    limits.join(' | '));
  check('…and warns when a rate limit has no start time (every slot already open)',
    describeGrantLimits({ ...sdkGrant, rateLimit: { count: 3, intervalSeconds: 60, startAt: 0 } }, 'test ETH').some((l) => /no start time: every slot is already open/.test(l)));
  check('hand-over warning says shown once and deleted after confirmation', /shown once/.test(SUBSCRIPTION_KEY_WARNING) && /deleted from this device/.test(SUBSCRIPTION_KEY_WARNING));
}

// ---------------------------------------------------------------------------
console.log('check-subscriptions: install (same explicit root-signed path) and stored terms');
// ---------------------------------------------------------------------------
const NOW = Math.floor(Date.now() / 1000);
const store = memoryStore();
const vault = fakeVault();
const node = fakeNode();
const bundler = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
const bundle = kernelBundle(node, bundler);
const live = buildSubscription({ ...draft, periodSeconds: 120, payments: '3' }, { now: NOW, account: ACCOUNT, testnet: true });
const keyBytes = ethers.randomBytes(32);
const keyHex = ethers.hexlify(keyBytes).toLowerCase();
const sessionAccount = createSessionKeyAccount(keyBytes.slice());
const liveGrant = subscriptionGrantFor(live, sessionAccount.address, { account: ACCOUNT, now: NOW });
let record;
{
  const { install, quote } = await prepareSessionInstall(bundle, OWNER_0, ACCOUNT, liveGrant, { now: NOW });
  check('quote = exactly the engine’s two install self-calls from the deployed Kernel account', quote.calls.length === 2 && quote.calls.every((c, i) => toHex(c.data) === toHex(install.installCalls[i].data) && same(c.to, ACCOUNT)) && !quote.eip7702);
  const wrongTerms = await caught(() => installSession({ quote, install, grant: liveGrant, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3', label: 'Subscription: x', source: 'subscription', subscription: subscriptionMeta({ ...live, amountPerPeriod: 6_000_000n }, usdc), sessionPrivateKey: keyBytes.slice(), store, vault, submit: async () => ({ userOpHash: '0x' }) }));
  check('terms that do not match the grant are refused before anything is stored', /do not match the grant/.test(wrongTerms?.message ?? '') && vault.map.size === 0 && (await store.getItem(SESSIONS_KEY)) === null);
  const noTerms = await caught(() => installSession({ quote, install, grant: liveGrant, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3', label: 'x', source: 'subscription', sessionPrivateKey: keyBytes.slice(), store, vault, submit: async () => ({ userOpHash: '0x' }) }));
  check('a subscription without terms (or terms on a manual session) is refused', /belong exactly to subscription grants/.test(noTerms?.message ?? ''));
  const res = await installSession({
    quote, install, grant: liveGrant, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3',
    label: 'Subscription: Streaming', source: 'subscription', subscription: subscriptionMeta(live, usdc),
    sessionPrivateKey: keyBytes.slice(), store, vault,
    submit: (q) => sendAa(bundle, owner, q),
  });
  record = res.record;
  const op = fromRpcOp(bundler.lastOp);
  const recovered = ethers.recoverAddress(ethers.hashMessage(getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID)), toHex(op.signature));
  check('the install op is ROOT-signed (ethers recovers the owner EOA) and executes the two install calls', same(recovered, OWNER_0) && decodeKernelExecute(op.callData).calls.length === 2);
  const loaded = (await loadSessions(store)).records[0];
  check('stored record: source subscription, terms kept, key held (until the hand-over), keyExportedAt null',
    loaded.source === 'subscription' && loaded.subscription.tokenSymbol === 'USDC' && loaded.subscription.tokenDecimals === 6 && loaded.keyHeld && loaded.subscription.keyExportedAt === null && termsOf(loaded).amountPerPeriod === 5_000_000n);
  check('subscriptionRecords picks it; the Test button is never offered for a subscription', subscriptionRecords([loaded]).length === 1 && sessionCanBeTested(loaded) === false && sessionCanBeTested({ ...loaded, source: 'manual' }) === true);
  check('summary line', subscriptionSummary(loaded, 'Streamy') === `5 USDC every 2 minutes to Streamy (${MERCHANT}) (token ${USDC})`, subscriptionSummary(loaded, 'Streamy'));
  const raw = await store.getItem(SESSIONS_KEY);
  check('the AsyncStorage-shaped store never holds the private key', !raw.toLowerCase().includes(keyHex.slice(2)));

  // Tampered terms on disk: the record no longer matches its grant → dropped and flagged.
  const tampered = memoryStore();
  const parsed = JSON.parse(raw);
  const k = Object.keys(parsed.records)[0];
  parsed.records[k].subscription.terms.amountPerPeriod = '50000000';
  await tampered.setItem(SESSIONS_KEY, JSON.stringify(parsed));
  const tl = await loadSessions(tampered);
  check('stored terms that no longer map to the stored grant drop the record (flagged corrupt)', tl.records.length === 0 && tl.corrupt);
  const stripped = memoryStore();
  const p2 = JSON.parse(raw);
  delete p2.records[k].subscription;
  await stripped.setItem(SESSIONS_KEY, JSON.stringify(p2));
  check('a subscription record without terms is dropped', (await loadSessions(stripped)).records.length === 0);

  const early = await caught(() => buildSubscriptionKeyExport(loaded, vault));
  check('the key cannot be shown before the install is confirmed on-chain', /confirmed on-chain/.test(early?.message ?? ''));
  node.install(loaded.permissionId, sessionAccount.address, liveGrant);
  const fin = await finalizeSessionInstall(bundle, loaded, store, { timeoutMs: 1000, pollMs: 1 });
  record = fin.record;
  check('finalize → installed / active (same path as any session)', record.localStatus === 'installed' && fin.status.kind === 'active');
}

// ---------------------------------------------------------------------------
console.log('check-subscriptions: status from RateLimitPolicy / GasPolicy');
// ---------------------------------------------------------------------------
{
  const st = await readSubscriptionStatus(node, record, NOW);
  check('read: live, 3 payments left, next slot = start, fee budget = the grant’s', st.kind === 'ok' && st.state.remainingPulls === 3 && st.state.nextSlotAt === NOW && st.state.feeBudgetLeftWei === 3_000_000_000_000_000n && st.next.kind === 'now');
  const lines = subscriptionStatusLines(record, st, 'test ETH');
  check('lines: due now, 0 of 3 taken, fee budget left', /^Next payment: due now/.test(lines[0]) && lines[1] === '0 of 3 payments taken.' && lines[2] === 'Fee budget left: 0.003 test ETH.', lines.join(' | '));
  const key = record.permissionId.slice(2);
  node.state.rate.set(key, { interval: 120, count: 2, startAt: NOW + 120 });
  const st2 = await readSubscriptionStatus(node, record, NOW + 5);
  const lines2 = subscriptionStatusLines(record, st2, 'test ETH');
  check('after one pull: next payment not before the next slot, 1 of 3 taken', st2.next.kind === 'later' && /^Next payment: not before /.test(lines2[0]) && lines2[1] === '1 of 3 payments taken.', lines2.join(' | '));
  node.state.rate.set(key, { interval: 120, count: 0, startAt: NOW + 360 });
  check('all taken', subscriptionStatusLines(record, await readSubscriptionStatus(node, record, NOW + 300), 'test ETH')[0] === 'All payments taken.');
  node.state.rate.set(key, { interval: 120, count: 2, startAt: NOW + 120 });
  const broken = await readSubscriptionStatus(async () => { throw new Error('RPC error -32000: down'); }, record, NOW);
  check('read failure → "Status unknown" with the reason, never a guess', broken.kind === 'unknown' && /Status unknown: RPC error -32000: down/.test(subscriptionStatusLines(record, broken, 'test ETH')[0]));
}

// ---------------------------------------------------------------------------
console.log('check-subscriptions: key hand-over (shown once, then deleted)');
// ---------------------------------------------------------------------------
{
  const payload = await buildSubscriptionKeyExport(record, vault);
  check('payload: type, chain, account, permission id, nonce key, signer module, terms and THE key from the vault',
    payload.type === SUBSCRIPTION_KEY_EXPORT_TYPE && payload.chainId === '11155111' && payload.account === ACCOUNT && payload.permissionId === record.permissionId &&
      payload.nonceKey === '0x' + sessionNonceKey(record.permissionId).toString(16) && payload.signerModule === KERNEL_PERMISSION_MODULES.ecdsaSigner &&
      payload.sessionPrivateKey === keyHex && same(payload.sessionKey, sessionAccount.address) && payload.subscription.amountPerPeriod === '5000000' && payload.entryPoint === ENTRYPOINT_V07);
  check('payload key derives (ethers) to the grant’s session address', same(new ethers.Wallet(payload.sessionPrivateKey).address, sessionAccount.address));
  check('…and its terms map back to the installed grant (a keeper can check pulls locally)', JSON.stringify(subscriptionToGrant(termsOf(record), payload.sessionKey, { now: null }).calls.map((c) => c.target)) === JSON.stringify([USDC]));
  check('key status before the hand-over', /Key still on this device/.test(subscriptionKeyStatusText(record)));
  const after = await markSubscriptionKeyExported(record, store, vault, 1_800_000_000_000);
  const vid = sessionVaultId(M, ACCOUNT, record.permissionId);
  check('confirmation deletes the key from the vault and records the time; keyHeld false', !vault.map.has(vid) && after.keyHeld === false && after.subscription.keyExportedAt === 1_800_000_000_000);
  const reloaded = (await loadSessions(store)).records[0];
  check('stored record reflects the hand-over (and still never holds the key)', reloaded.keyHeld === false && reloaded.subscription.keyExportedAt === 1_800_000_000_000 && !(await store.getItem(SESSIONS_KEY)).includes(keyHex.slice(2)));
  check('key status after the hand-over names the time', /^Key handed to the merchant 2027-01-15 08:00:00 UTC and deleted/.test(subscriptionKeyStatusText(reloaded)), subscriptionKeyStatusText(reloaded));
  const again = await caught(() => buildSubscriptionKeyExport(reloaded, vault));
  check('the key can never be shown again', /already handed over/.test(again?.message ?? ''));
  const twice = await caught(() => markSubscriptionKeyExported(reloaded, store, vault));
  check('a second hand-over confirmation is refused', /not on this device/.test(twice?.message ?? ''));
  const loadsBefore = vault.loads;
  const pull = await caught(() => sendSessionCalls({ bundle, record: reloaded, calls: [{ to: USDC, value: 0n, data: toBytes(new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [MERCHANT, 1n])) }], vault, now: NOW + 1 }));
  check('the wallet cannot pull with a handed-over key (plain message, vault not read)', /handed to the merchant/.test(pull?.message ?? '') && vault.loads === loadsBefore, pull?.message);
  // Defence in depth: a tampered record claiming keyHeld with a hand-over time is refused too.
  const bogus = { ...reloaded, keyHeld: true };
  check('a record that says "handed over" is never exported even if keyHeld were set', /already handed over/.test((await caught(() => buildSubscriptionKeyExport(bogus, vault)))?.message ?? ''));
  await saveSessionRecord(reloaded, store);
}

// ---------------------------------------------------------------------------
console.log('check-subscriptions: Sessions screen source checks');
// ---------------------------------------------------------------------------
{
  const screen = readFileSync(new URL('../src/screens/SessionsScreen.tsx', import.meta.url), 'utf8');
  check('TESTNET badge uses theme.testnetFill / theme.onTestnetFill (no hard-coded #e07800 or white)',
    screen.includes('backgroundColor: theme.testnetFill') && screen.includes('color: theme.onTestnetFill') && !/#e07800/i.test(screen) && !/'#ffffff'/i.test(screen));
  check('subscriptions install through installSession with source "subscription" (the same explicit path)', /source: 'subscription'/.test(screen) && /installSession\(/.test(screen));
  check('the key screen blocks screenshots (expo-screen-capture) while it is open', /preventScreenCaptureAsync\('subscription-key'\)/.test(screen) && /allowScreenCaptureAsync\('subscription-key'\)/.test(screen));
  check('showing the key and approving the subscription both pass the biometric gate', /requireLocalAuth\('Show the subscription key/.test(screen) && /requireLocalAuth\('Approve this subscription'\)/.test(screen));
  check('the Test button is gated on sessionCanBeTested', /usable && sessionCanBeTested\(r\)/.test(screen));
  check('the batch caveat is rendered in a WarningBox on the review and the list card', (screen.match(/<WarningBox>\{(batchCaveat|review\.caveats\[0\])\}<\/WarningBox>/g) ?? []).length >= 2);
}


// ---------------------------------------------------------------------------
console.log('check-subscriptions: phase 12 rehearsal fixes (findings 1–7 and 9)');
// ---------------------------------------------------------------------------
const screenSrc = readFileSync(new URL('../src/screens/SessionsScreen.tsx', import.meta.url), 'utf8');
{
  // Finding 1: the clock starts when Start is tapped.
  const REVIEW_OPENED = NOW - 600; // the user read the review for ten minutes
  const reviewed = buildSubscription({ ...draft, choice: native, amount: '0.000000000000001', periodSeconds: 120, payments: '3' }, { now: REVIEW_OPENED, account: ACCOUNT, testnet: true });
  const stale = await caught(() => subscriptionGrantFor(reviewed, SDK_SESSION_KEY, { account: ACCOUNT, now: NOW }));
  check('the problem reproduced: terms fixed at Review (3 × 2 min) have expired ten minutes later (engine refusal)', /already have expired/.test(stale?.message ?? ''), stale?.message);
  const restarted = restartSubscriptionAt(reviewed, NOW);
  check('restartSubscriptionAt: start = now, expiry moves by the same amount, still 3 payments, every other term unchanged',
    restarted.startAt === NOW && restarted.validUntil === NOW + 360 && restarted.merchant === reviewed.merchant && restarted.amountPerPeriod === reviewed.amountPerPeriod &&
      restarted.feeBudgetWei === reviewed.feeBudgetWei && restarted.periodSeconds === 120 && restarted.label === reviewed.label);
  const key2 = ethers.randomBytes(32);
  const key2Account = createSessionKeyAccount(key2.slice());
  const g2 = subscriptionGrantFor(restarted, key2Account.address, { account: ACCOUNT, now: NOW });
  check('the restarted grant passes the engine: validAfter = rate-limit start = now, 3 operations, expiry now + 6 min',
    g2.validAfter === NOW && g2.rateLimit.startAt === NOW && g2.rateLimit.count === 3 && g2.validUntil === NOW + 360);
  const store2 = memoryStore();
  const vault2 = fakeVault();
  const { install: inst2, quote: q2 } = await prepareSessionInstall(bundle, OWNER_0, ACCOUNT, g2, { now: NOW });
  const res2 = await installSession({
    quote: q2, install: inst2, grant: g2, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3',
    label: subscriptionNames('', MERCHANT, null).recordLabel, source: 'subscription', subscription: subscriptionMeta(restarted, native),
    sessionPrivateKey: key2.slice(), store: store2, vault: vault2, submit: (q) => sendAa(bundle, owner, q),
  });
  check('the install carries the RESTARTED terms (stored start = the time Start was tapped)', termsOf(res2.record).startAt === NOW && termsOf(res2.record).validUntil === NOW + 360);
  check('the success screen line states the final dates and the count',
    subscriptionFinalDatesLine(restarted) === `Final terms: the first payment can be taken from ${new Date(NOW * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC, then one more every 2 minutes (3 in total); nothing after ${new Date((NOW + 360) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    subscriptionFinalDatesLine(restarted));
  check('requote tolerance: same fee or +20% → no second review; +21% or sponsorship ended → review again',
    SUBSCRIPTION_REQUOTE_FEE_TOLERANCE_PERCENT === 20n &&
      !subscriptionRequoteNeedsReview({ fee: 100n, sponsored: false }, { fee: 100n, sponsored: false }) &&
      !subscriptionRequoteNeedsReview({ fee: 100n, sponsored: false }, { fee: 120n, sponsored: false }) &&
      subscriptionRequoteNeedsReview({ fee: 100n, sponsored: false }, { fee: 121n, sponsored: false }) &&
      subscriptionRequoteNeedsReview({ fee: 0n, sponsored: true }, { fee: 50n, sponsored: false }) &&
      !subscriptionRequoteNeedsReview({ fee: 100n, sponsored: false }, { fee: 0n, sponsored: true }));
  const inst = screenSrc.slice(screenSrc.indexOf('const onSubInstall = async'), screenSrc.indexOf('const onShowKey = async'));
  const at = (needle) => inst.indexOf(needle);
  check('onSubInstall order: restart the clock → re-quote → fee re-check → biometric gate → installSession',
    at('restartSubscriptionAt(reviewed.subscription, now)') > 0 && at('restartSubscriptionAt(') < at('prepareSessionInstall(') &&
      at('prepareSessionInstall(') < at('subscriptionRequoteNeedsReview(') && at('subscriptionRequoteNeedsReview(') < at("requireLocalAuth('Approve this subscription')") &&
      at("requireLocalAuth('Approve this subscription')") < at('installSession(') && /quote: p\.quote,\s*\n\s*install: p\.install,\s*\n\s*grant: p\.grant/.test(inst));
  check('the review explains that the start is fixed when Start is tapped', screenSrc.includes('{SUBSCRIPTION_START_NOTE}') && /when you tap Start subscription/.test(SUBSCRIPTION_START_NOTE));

  // Finding 2: review order and scroll position.
  const confirm = screenSrc.slice(screenSrc.indexOf('key="sub-confirm"'), screenSrc.indexOf('Technical details (the grant as installed)'));
  const w = confirm.indexOf('<WarningBox>{batchCaveat}</WarningBox>');
  const sentenceAt = confirm.indexOf('{review.sentence}');
  const enforcedAt = confirm.indexOf('Your account enforces on-chain:');
  check('review order: the batch warning box FIRST, then the plain sentence, then the on-chain bullets', w > 0 && w < sentenceAt && sentenceAt < enforcedAt, `${w} ${sentenceAt} ${enforcedAt}`);
  const scrollViews = (screenSrc.match(/<ScrollView\b/g) ?? []).length;
  const keyed = (screenSrc.match(/<ScrollView key="[a-z-]+"/g) ?? []).length;
  check('every phase’s ScrollView has its own key (a fresh view opens at the top instead of reusing the previous scroll offset)', scrollViews > 0 && scrollViews === keyed, `${keyed}/${scrollViews}`);

  // Finding 3: the fee budget follows the payment count and is capped.
  const s3 = suggestedFeeBudget({ payments: 3, maxFeePerGas: 2_000_000_000n, balance: 10n ** 18n, nativeAmountPerPayment: 0n });
  const s6 = suggestedFeeBudget({ payments: 6, maxFeePerGas: 2_000_000_000n, balance: 10n ** 18n, nativeAmountPerPayment: 0n });
  check('suggestion follows the payment count (6 payments = twice 3)', s3.wei === defaultFeeBudgetWei(3, 2_000_000_000n) && s6.wei === 2n * s3.wei && !s6.capped);
  const poor = suggestedFeeBudget({ payments: 6, maxFeePerGas: 2_000_000_000n, balance: 4_000_000_000_000_000n, nativeAmountPerPayment: 0n });
  check('capped at the balance when the account cannot afford it (the rehearsal’s ~0.006 > balance)', poor.capped && poor.wei === 4_000_000_000_000_000n && poor.uncapped === s6.wei);
  const nat = suggestedFeeBudget({ payments: 3, maxFeePerGas: 2_000_000_000n, balance: 4_000_000_000_000_000n, nativeAmountPerPayment: 1_000_000_000_000_000n });
  check('native subscription: the payments themselves are set aside first (4 − 3 × 1 = 1 milli-ETH spare)', nat.capped && nat.wei === 1_000_000_000_000_000n && nat.spare === 1_000_000_000_000_000n);
  const none = suggestedFeeBudget({ payments: 3, maxFeePerGas: 2_000_000_000n, balance: 1n, nativeAmountPerPayment: 1n });
  check('nothing to spare → no pre-fill and a note saying to fund the account', none.wei === null && none.capped && /Fund the account first/.test(feeBudgetCapNote(none.spare, none.uncapped, 'test ETH')));
  check('cap note names what can be spared and the usual budget', feeBudgetCapNote(1_000_000_000_000_000n, 6_000_000_000_000_000n, 'test ETH') === 'Lowered to what your account can spare (0.001 test ETH); the usual budget for this many payments would be 0.006 test ETH. Fund the account or enter a budget by hand.');
  check('invalid payment count or unknown fee → no suggestion', suggestedFeeBudget({ payments: 0, maxFeePerGas: 1n, balance: null, nativeAmountPerPayment: 0n }).wei === null && suggestedFeeBudget({ payments: 3, maxFeePerGas: null, balance: 1n, nativeAmountPerPayment: 0n }).wei === null);
  check('the form shows the suggestion until the user types (feeEdited) and submits what it shows',
    /value=\{subFeeBudgetText\}/.test(screenSrc) && /feeEdited: t\.trim\(\) !== ''/.test(screenSrc) && /feeBudget: subFeeBudgetText,/.test(screenSrc) && /payments: Number\(subForm\.payments\.trim\(\)\)/.test(screenSrc));

  // Finding 4: default names and list order.
  check('unnamed: "Subscription to 0x0000…bEEF" (never "Subscription: Subscription"); terms label "to 0x0000…bEEF"',
    subscriptionNames('', MERCHANT, null).recordLabel === 'Subscription to 0x0000…bEEF' && subscriptionNames('  ', MERCHANT, null).termsLabel === 'to 0x0000…bEEF');
  check('typed name or contact name: "Subscription: <name>"', subscriptionNames('Streaming', MERCHANT, 'Streamy').recordLabel === 'Subscription: Streaming' && subscriptionNames('', MERCHANT, 'Streamy').recordLabel === 'Subscription: Streamy');
  check('the default terms label passes the engine’s name rule', subscriptionGrantFor({ ...restarted, label: subscriptionNames('', MERCHANT, null).termsLabel }, SDK_SESSION_KEY, { account: ACCOUNT, now: NOW }).calls.length === 1);
  check('the screen no longer falls back to the literal "Subscription"', !/\|\| 'Subscription'/.test(screenSrc) && /label: p\.recordLabel/.test(screenSrc));
  const rec = (localStatus, createdAt) => ({ localStatus, createdAt, permissionId: `${localStatus}${createdAt}` });
  const sorted = sortSubscriptionRecords([rec('revoked', 300), rec('installed', 100), rec('failed', 400), rec('installing', 200), rec('revoked', 50)]);
  check('list order: live (newest first), then failed, then revoked — an old live one above a new revoked one',
    sorted.map((r) => r.permissionId).join() === 'installing200,installed100,failed400,revoked300,revoked50', sorted.map((r) => r.permissionId).join());
  check('the Subscriptions list renders through sortSubscriptionRecords', /\{sortSubscriptionRecords\(records\.filter\(/.test(screenSrc));

  // Finding 5: per-card refresh and refresh on focus.
  check('each subscription card has its own "Refresh status" calling refreshRecord(r); the list reloads on focus',
    /onPress=\{\(\) => refreshRecord\(r\)\}/.test(screenSrc) && /useFocusEffect\(reloadList\)/.test(screenSrc));

  // Finding 7: copy.
  check('key holder phrase has no nested parentheses', `Session key (held by ${SUBSCRIPTION_KEY_HOLDER_TEXT})`.match(/\(/g).length === 1 && screenSrc.includes('sessionKeyHolder={SUBSCRIPTION_KEY_HOLDER_TEXT}'));
}

{
  // Finding 9: the key leaves as a FILE, never as shared plain text.
  const events = [];
  let scheduled = null;
  const deps = (opts = {}) => ({
    available: async () => opts.available ?? true,
    sweep: () => events.push('sweep'),
    write: (name, text) => {
      events.push(`write:${name}:${text.length}`);
      return { uri: `file:///cache/${SUBSCRIPTION_KEY_FILE_DIRECTORY}/${name}`, remove: () => events.push('remove') };
    },
    share: async (uri) => {
      events.push(`share:${uri}`);
      if (opts.shareFails) throw new Error('share failed');
    },
    schedule: (fn, ms) => {
      scheduled = { fn, ms };
      events.push(`schedule:${ms}`);
    },
  });
  const name = subscriptionKeyFileName({ chainId: '11155111', permissionId: '0x762FB3F6' });
  check('file name: chain and permission id only (public data), .json', name === 'shiba-subscription-key_11155111_0x762fb3f6.json');
  await shareSubscriptionKeyFile('{"k":1}', name, deps());
  check('share: sweep leftovers → write → share the FILE uri → delete scheduled after the sheet closes',
    events.join('|') === `sweep|write:${name}:7|share:file:///cache/${SUBSCRIPTION_KEY_FILE_DIRECTORY}/${name}|schedule:${SUBSCRIPTION_KEY_FILE_DELETE_DELAY_MS}` && SUBSCRIPTION_KEY_FILE_DELETE_DELAY_MS === 10_000,
    events.join('|'));
  scheduled.fn();
  check('…and the scheduled deletion removes the file', events.at(-1) === 'remove');
  events.length = 0;
  const failed2 = await caught(() => shareSubscriptionKeyFile('{"k":1}', name, deps({ shareFails: true })));
  check('share failure: the file is deleted at once and the error is shown', failed2?.message === 'share failed' && events.at(-1) === 'remove' && !events.some((e) => e.startsWith('schedule')));
  events.length = 0;
  const unavailable = await caught(() => shareSubscriptionKeyFile('{"k":1}', name, deps({ available: false })));
  check('no file sharing on the device: refused before anything is written', /not available/.test(unavailable?.message ?? '') && events.length === 0);
  check('mime type application/json (same as the recovery record file)', SUBSCRIPTION_KEY_FILE_MIME_TYPE === 'application/json');

  // Clipboard: copy, then overwrite with "" after 60 s (or when the screen closes).
  const writes = [];
  const timers = [];
  const clip = createClipboardAutoClear({
    setString: async (t) => void writes.push(t),
    setTimer: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimer: (h) => { timers[h].cleared = true; },
  });
  await clip.clearNow();
  check('leaving without copying never touches the clipboard', writes.length === 0);
  await clip.copy('SECRET');
  check('copy writes the key and schedules the overwrite at 60 s', writes.join('|') === 'SECRET' && timers[0].ms === 60_000 && SUBSCRIPTION_KEY_CLIPBOARD_CLEAR_MS === 60_000 && clip.pending());
  timers[0].fn();
  await new Promise((r) => setTimeout(r, 0));
  check('after 60 s the clipboard is overwritten with an empty string', writes.join('|') === 'SECRET|' && !clip.pending());
  await clip.copy('SECRET2');
  await clip.copy('SECRET3');
  check('a second copy replaces the pending timer', timers[1].cleared === true && !timers[2].cleared);
  await clip.clearNow();
  check('clearNow (screen closed) overwrites a pending copy at once and cancels its timer', writes.at(-1) === '' && timers[2].cleared);
  check('warning says the clipboard is readable by other apps and when it is emptied', /can be read by other apps/.test(SUBSCRIPTION_KEY_CLIPBOARD_WARNING) && /60 seconds/.test(SUBSCRIPTION_KEY_CLIPBOARD_WARNING));

  const handover = readFileSync(new URL('../src/components/SubscriptionKeyHandover.tsx', import.meta.url), 'utf8');
  check('the key screen uses the file + auto-clear hand-over, not the plain-text ShareActions',
    /<SubscriptionKeyHandoverActions text=\{keyExport\.text\} fileName=\{keyExport\.fileName\} \/>/.test(screenSrc) && !/ShareActions/.test(screenSrc));
  check('the hand-over component never shares text: expo-sharing shareAsync on a file uri, no React Native Share',
    /Sharing\.shareAsync\(uri,/.test(handover) && !/\bShare\.share\(/.test(handover) && !/from 'react-native';[^\n]*\bShare\b/.test(handover) && /mimeType: SUBSCRIPTION_KEY_FILE_MIME_TYPE/.test(handover));
  check('on unmount it overwrites a pending copy and sweeps leftover files', /keyClipboard\.clearNow\(\)/.test(handover) && /sweepSubscriptionKeyFiles\(\);/.test(handover));
  check('screenshots stay blocked while the key screen is open', /preventScreenCaptureAsync\('subscription-key'\)/.test(screenSrc));
}

// ---------------------------------------------------------------------------
console.log('check-subscriptions: phase 13 item 4 follow-ups (custom period, install fee, expired hand-over, legacy titles, Copied mark)');
// ---------------------------------------------------------------------------
{
  // 1. Periods: the testing preset only on test networks; custom periods within bounds.
  check('"2 minutes (testing)" is offered on test networks only',
    subscriptionPeriodPresets(true).some((p) => p.seconds === 120) && !subscriptionPeriodPresets(false).some((p) => p.seconds === 120) && subscriptionPeriodPresets(false).length === 4);
  check('custom period minimum = the engine’s SUBSCRIPTION_MIN_PERIOD_SECONDS (60 s) on test networks, 1 hour elsewhere; maximum 365 days',
    subscriptionMinPeriodSeconds(true) === SUBSCRIPTION_MIN_PERIOD_SECONDS && SUBSCRIPTION_MIN_PERIOD_SECONDS === 60 && subscriptionMinPeriodSeconds(false) === 3600 && SUBSCRIPTION_MAX_PERIOD_SECONDS === 365 * 86400);
  const c = (n, u, t = true) => customPeriodSeconds(n, u, t);
  check('custom: 45 minutes / 6 hours / 14 days → seconds', c('45', 60).seconds === 2700 && c(' 6 ', 3600).seconds === 21600 && c('14', 86400).seconds === 14 * 86400);
  check('custom refusals: empty, zero, fractions, signs, letters, unknown unit',
    !c('', 60).ok && !c('0', 60).ok && !c('1.5', 3600).ok && !c('-3', 60).ok && !c('ten', 60).ok && /unit/.test(c('5', 7).error));
  check('custom bounds: 1 minute OK on a test network, refused elsewhere; 366 days refused; 365 days OK',
    c('1', 60).ok && c('1', 60, false).error === 'Period: from 1 hour to 365 days.' && /to 365 days/.test(c('366', 86400).error) && c('365', 86400).ok);
  check('checkSubscriptionPeriod: whole minutes only, else "Choose a period."', checkSubscriptionPeriod(999, true) === 'Choose a period.' && checkSubscriptionPeriod(120, true) === null && checkSubscriptionPeriod(120, false) !== null);
  const custom90 = buildSubscription({ ...draft, periodSeconds: 90 * 60 }, { now: SDK_S, account: ACCOUNT, testnet: true });
  check('buildSubscription accepts a custom period and the engine maps it (rate limit interval = the period)',
    custom90.periodSeconds === 5400 && subscriptionGrantFor(custom90, SDK_SESSION_KEY, { account: ACCOUNT, now: SDK_S - 10 }).rateLimit.intervalSeconds === 5400);
  check('buildSubscription refuses 2 minutes off test networks (the default context is the stricter one)',
    /from 1 hour/.test((await caught(() => buildSubscription({ ...draft, periodSeconds: 120 }, { now: SDK_S, account: ACCOUNT })))?.message ?? ''));
  const short = buildSubscription({ ...draft, periodSeconds: 120, payments: '3' }, { now: NOW, account: ACCOUNT, testnet: true });
  const warn = subscriptionShortWindowWarning(short);
  check('short terms (3 × 2 min = 6 min) warn on the review, naming the total and the hand-over',
    SUBSCRIPTION_SHORT_WINDOW_SECONDS === 600 && warn === 'These terms last only 6 minutes in total (3 payments of 2 minutes). Handing the key to the merchant and the merchant\'s first pull happen inside the first period, so some payments may never be taken. Choose a longer period or more payments unless this is a quick test.', warn);
  check('exactly ten minutes or more: no warning', subscriptionShortWindowWarning({ startAt: 1000, validUntil: 1600, periodSeconds: 120 }) === null && subscriptionShortWindowWarning({ startAt: 1000, validUntil: 1599, periodSeconds: 60 }) !== null);

  // 2. The install's own fee: kept back by the pre-fill, checked on the review.
  const q = (over) => ({ amount: 0n, fee: 1_000n, senderBalance: 10_000n, deposit: undefined, sponsored: false, sender: ACCOUNT, ...over });
  check('keep-back = the part of the install fee the balance pays (deposit first; sponsored → 0)',
    subscriptionInstallKeepBack(q({})) === 1_000n && subscriptionInstallKeepBack(q({ deposit: 400n })) === 600n && subscriptionInstallKeepBack(q({ deposit: 5_000n })) === 0n && subscriptionInstallKeepBack(q({ sponsored: true })) === 0n);
  const kept = suggestedFeeBudget({ payments: 3, maxFeePerGas: 2_000_000_000n, balance: 4_000_000_000_000_000n, nativeAmountPerPayment: 1_000_000_000_000_000n, installFeeFromBalance: 300_000_000_000_000n });
  check('pre-fill cap keeps back the install fee (4 − 3 × 1 − 0.3 = 0.7 milli-ETH)', kept.capped && kept.wei === 700_000_000_000_000n);
  check('…the cap note says what was kept back; without it the note is unchanged',
    feeBudgetCapNote(700_000_000_000_000n, 6_000_000_000_000_000n, 'test ETH', 300_000_000_000_000n).endsWith(' 0.0003 test ETH is kept back for the install\'s own worst-case network fee.') &&
      feeBudgetCapNote(1_000_000_000_000_000n, 6_000_000_000_000_000n, 'test ETH') === 'Lowered to what your account can spare (0.001 test ETH); the usual budget for this many payments would be 0.006 test ETH. Fund the account or enter a budget by hand.');
  const g = { startAt: 0, validUntil: 360, periodSeconds: 120, feeBudgetWei: 1_000n, amountPerPeriod: 10n, token: SUBSCRIPTION_NATIVE };
  const fine = subscriptionInstallFunding(q({}), g, 'test ETH');
  check('affordable install: Start offered, no warnings', fine.canStart && !fine.block && !fine.depositNote && !fine.shortfall);
  // The rehearsal: fee 0.001895 > balance 0.001427, payable only because of the 0.000474 deposit.
  const viaDeposit = subscriptionInstallFunding(q({ fee: 1_895_000n, senderBalance: 1_427_000n, deposit: 474_000n }), { ...g, feeBudgetWei: 1n, amountPerPeriod: 0n, token: USDC }, 'test ETH');
  check('fee above the balance but covered by the deposit: Start offered, with a note naming the deposit',
    viaDeposit.canStart && /EntryPoint deposit \(0\.000000000000474 test ETH\) pays the difference/.test(viaDeposit.depositNote ?? ''), viaDeposit.depositNote);
  const blocked = subscriptionInstallFunding(q({ fee: 1_895_000n, senderBalance: 1_427_000n, deposit: 467_999n }), g, 'test ETH');
  check('balance + deposit below the install fee: NO Start, and the block names the address to fund',
    !blocked.canStart && blocked.block?.includes(`Fund the smart account address ${ACCOUNT}`) && /Nothing was signed\.$/.test(blocked.block ?? ''), blocked.block);
  check('the review hides Start when the install cannot be paid (source)', /\{funding\.canStart \? \(\s*<Button title="Start subscription"/.test(screenSrc) && screenSrc.includes('{funding.block ? <WarningBox>{funding.block}</WarningBox> : null}'));
  const tight = subscriptionInstallFunding(q({ fee: 1_000n, senderBalance: 2_000n }), g, 'test ETH');
  check('payments + fee budget above what the install leaves: a warning, Start still offered',
    tight.canStart && /keeps at most 0\.000000000000001 test ETH/.test(tight.shortfall ?? '') && /the payments and the fee budget can use up to 0\.00000000000000103 test ETH/.test(tight.shortfall ?? ''), tight.shortfall);
  check('sponsored install: never blocked', subscriptionInstallFunding(q({ fee: 0n, senderBalance: 0n, sponsored: true }), { ...g, feeBudgetWei: 0n, amountPerPeriod: 0n }, 'x').canStart);
  check('Review lowers an UNEDITED pre-fill to keep the install fee back and quotes again (source)',
    /if \(!subForm\.feeEdited\) \{[\s\S]{0,200}subscriptionInstallKeepBack\(quote\)[\s\S]{0,900}refit\.wei < subscription\.feeBudgetWei[\s\S]{0,300}prepareSessionInstall\(bundle, owner, account, grant, \{ now \}\)/.test(screenSrc));

  // 3. Expired before the hand-over: no hand-over, only Revoke / Forget.
  const base = { ...record, keyHeld: true, localStatus: 'installed', subscription: { ...record.subscription, keyExportedAt: null } };
  const validUntil = termsOf(base).validUntil;
  check('active and in time → the hand-over is offered', subscriptionHandoverOffer(base, { kind: 'active', expired: false }, validUntil - 1) === 'offer');
  check('expired by the stored terms (even while the on-chain read is loading) → "expired", no hand-over',
    subscriptionHandoverOffer(base, 'loading', validUntil) === 'expired' && subscriptionHandoverOffer(base, { kind: 'active', expired: false }, validUntil + 5) === 'expired');
  check('expired per the on-chain read → "expired"', subscriptionHandoverOffer(base, { kind: 'active', expired: true }, validUntil - 100) === 'expired');
  check('handed over, not installed, or not active → nothing',
    subscriptionHandoverOffer({ ...base, subscription: { ...base.subscription, keyExportedAt: 1 } }, { kind: 'active', expired: false }, 0) === 'none' &&
      subscriptionHandoverOffer({ ...base, localStatus: 'installing' }, { kind: 'active', expired: false }, 0) === 'none' &&
      subscriptionHandoverOffer(base, { kind: 'revoked' }, 0) === 'none');
  const late = await caught(() => buildSubscriptionKeyExport(base, vault, validUntil));
  check('the export itself refuses an expired subscription', /has expired/.test(late?.message ?? ''), late?.message);
  check('the card says it expired and points at Revoke', /expired before its key was handed to the merchant/.test(SUBSCRIPTION_EXPIRED_UNHANDED_TEXT) && screenSrc.includes("{handover === 'expired' ? <WarningBox>{SUBSCRIPTION_EXPIRED_UNHANDED_TEXT}</WarningBox> : null}") && screenSrc.includes("{handover === 'offer' ? ("));

  // 4. Legacy titles derived at render time.
  const legacy = { ...record, label: 'Subscription: Subscription', subscription: { ...record.subscription, terms: { ...record.subscription.terms, label: 'Subscription' } } };
  check('a legacy "Subscription: Subscription" record reads "Subscription to 0x0000…bEEF"', subscriptionDisplayTitle(legacy, null) === 'Subscription to 0x0000…bEEF');
  check('…or the merchant’s contact name', subscriptionDisplayTitle(legacy, 'Streamy') === 'Subscription: Streamy');
  check('other titles are kept as stored (incl. a typed name)', subscriptionDisplayTitle(record, 'Streamy') === record.label && subscriptionDisplayTitle({ ...legacy, subscription: { ...legacy.subscription, terms: { ...legacy.subscription.terms, label: 'Gym' } } }, null) === 'Subscription: Subscription');
  check('cards, their refresh label and the revoke title use the derived title (source)',
    screenSrc.includes('const title = subscriptionDisplayTitle(r, nameFor(terms.merchant));') && screenSrc.includes('{title}</Text>') && screenSrc.includes('Revoke session “{revokeTitle}”'));

  // 5. "Copied ✓" follows the clipboard helper.
  const timers = [];
  const writes = [];
  const clip = createClipboardAutoClear({
    setString: async (t) => void writes.push(t),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: () => {},
  });
  const seen = [];
  const off = clip.subscribe(() => seen.push(clip.pending()));
  await clip.copy('SECRET');
  check('subscribers hear the copy (pending true)', seen.join() === 'true');
  timers[0].fn();
  await new Promise((r) => setTimeout(r, 0));
  check('…and the overwrite after 60 s (pending false), so the mark clears', seen.join() === 'true,false' && writes.at(-1) === '');
  await clip.copy('SECRET2');
  await clip.clearNow();
  check('…and clearNow when the screen closes', seen.join() === 'true,false,true,false');
  off();
  await clip.copy('SECRET3');
  check('unsubscribe stops notifications', seen.length === 4);
  const handoverSrc = readFileSync(new URL('../src/components/SubscriptionKeyHandover.tsx', import.meta.url), 'utf8');
  check('the Copy button’s mark is the helper’s pending state (no separate copied flag)',
    handoverSrc.includes('const copied = useSyncExternalStore(keyClipboard.subscribe, keyClipboard.pending);') && !/setCopied/.test(handoverSrc));
}

console.log(`\ncheck-subscriptions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

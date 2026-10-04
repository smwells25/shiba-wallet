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
  SUBSCRIPTION_KEY_EXPORT_TYPE,
  SUBSCRIPTION_KEY_WARNING,
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
  const nativeSub = buildSubscription({ ...draft, choice: native, amount: '0.000000000000001', periodSeconds: 120 }, { now: SDK_S, account: ACCOUNT });
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
const live = buildSubscription({ ...draft, periodSeconds: 120, payments: '3' }, { now: NOW, account: ACCOUNT });
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

console.log(`\ncheck-subscriptions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

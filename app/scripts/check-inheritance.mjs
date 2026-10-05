// Phase 14 item 4: the inheritance switch (a test-network demonstration on
// the guardian modules), entirely OFFLINE. Exercises the exact app module
// src/wallet/inheritance.ts (with recovery.ts and aa.ts) under Node's type
// stripping against fakes:
//  - the copy: the risk statement verbatim (first thing on every surface),
//    the limits, the heir-side notes;
//  - the rules: test networks only (refused before any request elsewhere),
//    the acknowledgement, the preset delays (never 0, at most 365 days,
//    never wrapping at 2^48), 1 to 5 heirs, one guardian set per account;
//  - eligibility refusals reused from the guardian flow (imported owner,
//    SimpleAccount, EIP-7702, undeployed) with their exact sentences;
//  - install: the engine's calls, the record written with role "heirs"
//    BEFORE submission, the role kept by finalize, sync and merge;
//  - remove: the uninstall calls plus a veto per known pending takeover,
//    decoded independently with ethers;
//  - "check for takeover attempts": the scan starts at the install block,
//    finds an approveWithSig naming the account, adds it to the watch list,
//    reports coverage honestly, continues where it stopped, and does NOT see
//    an approval made through another contract (the stated limit);
//  - the heir exposure sentences.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-inheritance.mjs
//
// Nothing is signed against a live chain and nothing is broadcast.

import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  KERNEL_RECOVERY_MODULES,
  KERNEL_V3_3,
  buildGuardianRecoveryRequest,
  createSessionKeyAccount,
  encodeApproveWithSig,
  encodeVetoCall,
  getUserOpHash,
  guardianInstallCalls,
  guardianNonceKey,
  guardianUninstallCalls,
  parseRecoveryMetadata,
  serializeRecoveryMetadata,
  signGuardianApproval,
  toBytes,
  toHex,
  selector,
} from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import { createAaClient, sendAa } from '../src/wallet/aa.ts';
import {
  GUARDIAN_7702_REFUSAL,
  GUARDIAN_IMPORTED_REFUSAL,
  GUARDIAN_SIMPLE_REFUSAL,
  GUARDIAN_UNDEPLOYED_REFUSAL,
  ensureFactoryKernelRecord,
  finalizeGuardianOperation,
  getRecoveryRecord,
  mergeRecoveryMetadata,
  resolveGuardianAccount,
  submitGuardianOperation,
  syncRecordGuardiansFromChain,
} from '../src/wallet/recovery.ts';
import {
  HEIRS_ON_GUARDIANS_NOTE,
  HEIR_NEW_OWNER_NOTE,
  HEIR_SIDE_NOTE,
  INHERITANCE_ACK_REQUIRED,
  INHERITANCE_DELAY_PRESETS,
  INHERITANCE_GUARDIANS_CONFLICT,
  INHERITANCE_HOW_IT_WORKS,
  INHERITANCE_PRODUCTION_NEEDS,
  INHERITANCE_REMOVE_NOTE,
  INHERITANCE_RISK_STATEMENT,
  INHERITANCE_SCAN_BLOCKS_PER_CHECK,
  INHERITANCE_STORE_KEY,
  INHERITANCE_TESTNET_ONLY,
  INHERITANCE_TITLE,
  MAX_HEIRS,
  MAX_INHERITANCE_DELAY_SECONDS,
  assertInheritanceAllowed,
  buildHeirSet,
  canReviewHeirs,
  checkTakeoverAttempts,
  clearTakeoverScanState,
  describeHeirExposure,
  getTakeoverScanState,
  heirRemovalCalls,
  inheritanceConflict,
  isHeirRecord,
  prepareHeirInstallQuote,
  prepareHeirRemoveQuote,
  takeoverCoverageText,
  takeoverStatusText,
  validateInheritanceDelay,
  heirCount,
} from '../src/wallet/inheritance.ts';
import { KERNEL_ACCOUNT_0, OWNER_0, TEST_MNEMONIC, decodeKernelExecute, fakeBundler, fakeKernelNode, memoryStore } from './fakes-kernel.mjs';

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
const sel = (s) => toHex(selector(s));
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const pad32 = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';
const HOOK_ONLY_ENTRYPOINT = '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF';
const LIST_END = '0xffffffffffffffffffffffffffffffffffffffff';
const ERC1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const M = 'eip155:11155111';
const CHAIN_ID = 11155111n;
const W = KERNEL_RECOVERY_MODULES.weightedEcdsaValidator;
const RA = KERNEL_RECOVERY_MODULES.recoveryAction;
const VALIDATOR = KERNEL_V3_3.ecdsaValidator;
const ACCOUNT = KERNEL_ACCOUNT_0;
const INSTALL_TX = '0x' + 'cd'.repeat(32);
const INSTALL_BLOCK = 5_000n;

const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
const heirNewOwner = evmKeyProvider.deriveAccount(seed, 0, 9);
seed.fill(0);
// Fixed heir keys (test-only).
const heirA = createSessionKeyAccount(toBytes('0x' + '11'.repeat(32)));
const heirB = createSessionKeyAccount(toBytes('0x' + '22'.repeat(32)));
const heirC = createSessionKeyAccount(toBytes('0x' + '33'.repeat(32)));

/**
 * Fake node: fakeKernelNode plus the read surface of Kernel v3.3, the ECDSA
 * validator, the weighted validator and EntryPoint getNonce (as in
 * check-recovery.mjs), and full blocks for the takeover scan: `blocks` maps
 * a block number to its transactions.
 */
function fakeNode({ head = INSTALL_BLOCK + 100n } = {}) {
  const accounts = new Map();
  const calls = [];
  const blocks = new Map();
  const base = fakeKernelNode({ chainIdHex: '0xaa36a7', deployedAccounts: new Set() });
  const acct = (a) => accounts.get(a.toLowerCase());
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_blockNumber') return '0x' + transport.head.toString(16);
    if (method === 'eth_getBlockByNumber' && params[0] !== 'latest') {
      const n = BigInt(params[0]);
      if (n > transport.head) return null;
      return { number: params[0], transactions: params[1] ? (blocks.get(n) ?? []) : (blocks.get(n) ?? []).map((t) => t.hash) };
    }
    if (method === 'eth_getTransactionReceipt') {
      return same(params[0], INSTALL_TX) ? { status: '0x1', blockNumber: '0x' + INSTALL_BLOCK.toString(16) } : null;
    }
    if (method === 'eth_getCode') {
      const a = acct(params[0]);
      if (a) return a.code;
      return base(method, params);
    }
    if (method === 'eth_getStorageAt') {
      const a = acct(params[0]);
      if (a && params[1].toLowerCase() === ERC1967_SLOT) return pad32(a.implementation);
      return word(0);
    }
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      const body = '0x' + data.slice(10);
      const a = acct(to);
      if (a) {
        if (data.startsWith(sel('rootValidator()'))) return '0x01' + VALIDATOR.slice(2).toLowerCase() + '00'.repeat(11);
        if (data.startsWith(sel('validationConfig(bytes21)'))) {
          return abi.encode(['uint32', 'address'], [a.guardians ? 2 : 0, a.guardians ? '0x0000000000000000000000000000000000000001' : ZERO]);
        }
        if (data.startsWith(sel('isAllowedSelector(bytes21,bytes4)'))) return word(a.guardians ? 1 : 0);
        if (data.startsWith(sel('selectorConfig(bytes4)'))) {
          return a.guardians
            ? abi.encode(['address', 'address', 'bytes1'], [HOOK_ONLY_ENTRYPOINT, RA, '0xff'])
            : abi.encode(['address', 'address', 'bytes1'], [ZERO, ZERO, '0x00']);
        }
      }
      if (same(to, VALIDATOR) && data.startsWith(sel('ecdsaValidatorStorage(address)'))) {
        const [who] = abi.decode(['address'], body);
        return pad32(acct(who)?.owner ?? ZERO);
      }
      if (same(to, W)) {
        if (data.startsWith(sel('weightedStorage(address)'))) {
          const [who] = abi.decode(['address'], body);
          const s = acct(who);
          if (!s || !s.guardians) return abi.encode(['uint24', 'uint24', 'uint48', 'address'], [0, 0, 0, ZERO]);
          const asc = [...s.guardians.guardians].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));
          const total = asc.reduce((t, g) => t + g.weight, 0);
          return abi.encode(['uint24', 'uint24', 'uint48', 'address'], [total, s.guardians.threshold, s.guardians.delaySeconds, asc[0].address]);
        }
        if (data.startsWith(sel('guardian(address,address)'))) {
          const [g, who] = abi.decode(['address', 'address'], body);
          const asc = [...(acct(who)?.guardians?.guardians ?? [])].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));
          const i = asc.findIndex((x) => same(x.address, g));
          if (i < 0) return abi.encode(['uint24', 'address'], [0, ZERO]);
          return abi.encode(['uint24', 'address'], [asc[i].weight, i + 1 < asc.length ? asc[i + 1].address : LIST_END]);
        }
        if (data.startsWith(sel('proposalStatus(bytes32,address)'))) {
          const [hash, who] = abi.decode(['bytes32', 'address'], body);
          const p = acct(who)?.proposals.get(hash.toLowerCase());
          return abi.encode(['uint8', 'uint48'], [p?.status ?? 0, p?.validAfter ?? 0]);
        }
        if (data.startsWith(sel('getApproval(address,bytes32)'))) {
          const [who, hash] = abi.decode(['address', 'bytes32'], body);
          const s = acct(who);
          const p = s?.proposals.get(hash.toLowerCase());
          const weight = p?.weight ?? 0;
          return abi.encode(['uint256', 'bool'], [weight, p?.status !== 2 && weight >= (s?.guardians?.threshold ?? 1)]);
        }
      }
      if (same(to, ENTRYPOINT_V07) && data.startsWith(sel('getNonce(address,uint192)'))) {
        const [who, key] = abi.decode(['address', 'uint192'], body);
        const s = acct(who);
        return word((key << 64n) | (key === 0n ? (s?.rootSeq ?? 0n) : 0n));
      }
    }
    return base(method, params);
  };
  transport.head = head;
  transport.calls = calls;
  transport.blocks = blocks;
  transport.add = (address, state) =>
    accounts.set(address.toLowerCase(), {
      code: '0x6001',
      implementation: KERNEL_V3_3.implementation,
      guardians: null,
      proposals: new Map(),
      rootSeq: 1n,
      ...state,
    });
  transport.get = acct;
  return transport;
}

function kernelBundle(node, bundler, { accountType = 'kernel-v3.3', accountIndex = 0, chainId = CHAIN_ID } = {}) {
  return createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: KERNEL_V3_3.factory,
    chainId,
    accountIndex,
    accountType,
    transportFor: (url) => (url.includes('bundler') ? bundler : node),
  });
}

async function freshRecord(store) {
  return ensureFactoryKernelRecord({
    chain: M,
    account: ACCOUNT,
    accountIndex: 0,
    owner: OWNER_0,
    ownerPath: owner.path,
    factory: KERNEL_V3_3.factory,
    implementation: KERNEL_V3_3.implementation,
    ecdsaValidator: VALIDATOR,
    store,
  });
}

// ---------------------------------------------------------------------------
console.log('check-inheritance: the copy (risk statement first, limits, heir side)');
// ---------------------------------------------------------------------------
check('title', INHERITANCE_TITLE === 'Inheritance (demonstration)');
check(
  'risk statement verbatim',
  INHERITANCE_RISK_STATEMENT ===
    'Read this first: your heir can sign messages AS THIS ACCOUNT from the moment you add them — not after the delay. ' +
      'Those signatures can move your tokens: with one signature the heir can give itself an allowance on this account’s ' +
      'USDC (USDC’s permit accepts the account’s signatures) or move any token you have approved to Permit2, and then ' +
      'take it. They also work for sign-in requests and off-chain orders. The delay and your veto protect only the change ' +
      'of owner, never these signatures. Add as heir only someone you would trust with everything in this account today.',
);
check('how-it-works: the heir starts the clock; veto possible until execution', /the heir starts the clock/.test(INHERITANCE_HOW_IT_WORKS[0]) && /even after the delay has passed/.test(INHERITANCE_HOW_IT_WORKS[0]));
check('how-it-works: detection limits stated', /does not announce approvals/.test(INHERITANCE_HOW_IT_WORKS[1]) && /through another contract/.test(INHERITANCE_HOW_IT_WORKS[1]));
check('how-it-works: no proof of life; re-adding revives', /no “I am still here” button/.test(INHERITANCE_HOW_IT_WORKS[2]) && /revives them/.test(INHERITANCE_HOW_IT_WORKS[2]));
check('how-it-works: one guardian set per account', INHERITANCE_HOW_IT_WORKS[3] === 'An account has one guardian set: it holds either guardians or heirs, not both.');
check('production needs: refuse signatures, events, real proof of life', /refuses every message signature/.test(INHERITANCE_PRODUCTION_NEEDS) && /emit events/.test(INHERITANCE_PRODUCTION_NEEDS) && /proof of life/.test(INHERITANCE_PRODUCTION_NEEDS));
check('remove note: vetoes known takeovers, unknown ones revive', /vetoes every takeover this wallet knows about/.test(INHERITANCE_REMOVE_NOTE) && /comes back to life/.test(INHERITANCE_REMOVE_NOTE));
check('heir-side notes', /you are the heir/.test(HEIR_SIDE_NOTE) && /veto it until it executes/.test(HEIR_SIDE_NOTE) && /other than your heir address/.test(HEIR_NEW_OWNER_NOTE));
check('Guardians-screen note', HEIRS_ON_GUARDIANS_NOTE === 'These are heirs, set up on the Inheritance (demonstration) screen. Manage them there.');

// ---------------------------------------------------------------------------
console.log('check-inheritance: rules (network, delay, heirs)');
// ---------------------------------------------------------------------------
{
  const main = await caught(() => Promise.resolve().then(() => assertInheritanceAllowed('eip155:1')));
  check('mainnet refused with the demonstration sentence', main?.message === INHERITANCE_TESTNET_ONLY, main?.message);
  check('Ethereum Sepolia and Base Sepolia allowed', (await caught(() => Promise.resolve().then(() => assertInheritanceAllowed(M)))) === null && (await caught(() => Promise.resolve().then(() => assertInheritanceAllowed('eip155:84532')))) === null);
  const unknown = await caught(() => Promise.resolve().then(() => assertInheritanceAllowed('eip155:8453')));
  check('Base MAINNET (and any unknown chain) refused', unknown?.message === INHERITANCE_TESTNET_ONLY);
  // Phase 14 integration: the readiness switchboard lists inheritance
  // (testnet-only, enforced) and the gate consults it; Arbitrum Sepolia is a
  // test network like the other two.
  {
    const { featureReadiness, isFeatureAllowed } = await import('../src/config/readiness.ts');
    const row = featureReadiness('inheritance');
    check('readiness row: inheritance is testnet-only and enforced, citing T-68 and F-60',
      row.status === 'testnet-only' && row.enforced === true && ['T-68', 'F-60', 'C1'].every((i) => row.evidence.includes(i)) &&
        !isFeatureAllowed('inheritance', 'eip155:1') && isFeatureAllowed('inheritance', 'eip155:421614'));
    check('Arbitrum Sepolia allowed by the gate', (await caught(() => Promise.resolve().then(() => assertInheritanceAllowed('eip155:421614')))) === null);
    check('the gate names the switchboard row', (await import('node:fs')).readFileSync(new URL('../src/wallet/inheritance.ts', import.meta.url), 'utf8').includes("!isFeatureAllowed('inheritance', caip2)"));
  }
  check('delay presets: 10 min, 30, 90, 180, 365 days', JSON.stringify(INHERITANCE_DELAY_PRESETS.map((p) => p.seconds)) === JSON.stringify([600, 2_592_000, 7_776_000, 15_552_000, 31_536_000]));
  check('every preset passes; 365 days is the maximum', INHERITANCE_DELAY_PRESETS.every((p) => validateInheritanceDelay(p.seconds) === null) && MAX_INHERITANCE_DELAY_SECONDS === 31_536_000);
  check('delay 0 (no veto), 1 day (not offered) and 2^48 - 1 (would wrap) refused', validateInheritanceDelay(0) !== null && validateInheritanceDelay(86_400) !== null && validateInheritanceDelay(2 ** 48 - 1) !== null);
  // Phase 14 integration: behind the preset rule, the engine now refuses any
  // delay that could wrap (MAX_GUARDIAN_DELAY_SECONDS), and the screen shows
  // that refusal verbatim (validateGuardianSetForAccount, recovery.ts).
  {
    const { GUARDIAN_DELAY_TOO_LONG: TOO_LONG } = await import('@shiba-wallet/chains-evm');
    const { validateGuardianSetForAccount } = await import('../src/wallet/recovery.ts');
    const heirOnly = (delaySeconds) => ({ guardians: [{ address: heirA.address, weight: 1 }], threshold: 1, delaySeconds });
    check('the engine refuses a wrapping heir delay with its sentence; the longest preset passes',
      validateGuardianSetForAccount(heirOnly(2 ** 48 - 1), { account: ACCOUNT, owner: OWNER_0 }) === TOO_LONG &&
        validateGuardianSetForAccount(heirOnly(MAX_INHERITANCE_DELAY_SECONDS), { account: ACCOUNT, owner: OWNER_0 }) === null);
  }
  const one = buildHeirSet({ drafts: [{ address: heirA.address, label: 'Sister', weight: '1' }], threshold: '1', delaySeconds: 600 });
  check('one heir, threshold 1, 10-minute delay', one.set.guardians.length === 1 && one.set.threshold === 1 && one.set.delaySeconds === 600 && one.labels[heirA.address.toLowerCase()] === 'Sister');
  const six = await caught(() => Promise.resolve().then(() => buildHeirSet({ drafts: Array.from({ length: MAX_HEIRS + 1 }, (_, i) => ({ address: '0x' + (i + 1).toString(16).padStart(40, '0'), label: '', weight: '1' })), threshold: '1', delaySeconds: 600 })));
  check('more than 5 heirs refused', six?.message === 'At most 5 heirs.');
  const none = await caught(() => Promise.resolve().then(() => buildHeirSet({ drafts: [], threshold: '1', delaySeconds: 600 })));
  check('no heir refused', none?.message === 'Name at least one heir.');
  const noDelay = await caught(() => Promise.resolve().then(() => buildHeirSet({ drafts: [{ address: heirA.address, label: '', weight: '1' }], threshold: '1', delaySeconds: 0 })));
  check('delay 0 refused before the guardian rules', noDelay?.message === 'Choose one of the delays offered.');
  const badAddress = await caught(() => Promise.resolve().then(() => buildHeirSet({ drafts: [{ address: '0x1234', label: '', weight: '1' }], threshold: '1', delaySeconds: 600 })));
  check('a malformed heir address is refused by the send flow’s validation, named "Heir 1"', badAddress && /^Heir 1: /.test(badAddress.message) && !/Guardian|recipient/i.test(badAddress.message), badAddress?.message);
  // Phase 14 emulator finding 4: an empty heir row said "Guardian 1: Enter a
  // recipient address."; and Review was enabled with no heir at all.
  const blank = await caught(() => Promise.resolve().then(() => buildHeirSet({ drafts: [{ address: '  ', label: '', weight: '1' }], threshold: '1', delaySeconds: 600 })));
  check('an empty heir row: "Heir 1: Enter the heir’s address."', blank?.message === 'Heir 1: Enter the heir’s address.', blank?.message);
  const blankSecond = await caught(() => Promise.resolve().then(() => buildHeirSet({ drafts: [{ address: heirA.address, label: '', weight: '1' }, { address: '', label: '', weight: '1' }], threshold: '1', delaySeconds: 600 })));
  check('an empty second row names "Heir 2"', blankSecond?.message === 'Heir 2: Enter the heir’s address.', blankSecond?.message);
  const { buildGuardianSet } = await import('../src/wallet/recovery.ts');
  const blankGuardian = await caught(() => Promise.resolve().then(() => buildGuardianSet({ drafts: [{ address: '', label: '', weight: '1' }], threshold: '1', delaySeconds: 600, noVetoAcknowledged: false })));
  check('the guardian form keeps "Guardian 1" and no longer says "recipient"', blankGuardian?.message === 'Guardian 1: Enter the guardian’s address.', blankGuardian?.message);
  const empty = [{ address: '', label: '', weight: '1' }];
  const filled = [{ address: heirA.address, label: '', weight: '1' }];
  check('heirCount counts only rows with an address', heirCount(empty) === 0 && heirCount([...empty, ...filled]) === 1 && heirCount([]) === 0);
  check('Review stays disabled with zero heirs even when the acknowledgement is on',
    canReviewHeirs({ drafts: empty, acknowledged: true }) === false && canReviewHeirs({ drafts: [], acknowledged: true }) === false);
  check('Review stays disabled without the acknowledgement', canReviewHeirs({ drafts: filled, acknowledged: false }) === false);
  check('Review is enabled with one heir and the acknowledgement', canReviewHeirs({ drafts: filled, acknowledged: true }) === true);
  const { readFileSync: readSrc, writeFileSync: writeSrc, mkdirSync: mkdirSrc, rmSync: rmSrc } = await import('node:fs');
  const screenSrc = readSrc(new URL('../src/screens/InheritanceScreen.tsx', import.meta.url), 'utf8');
  check('the screen’s Review button uses canReviewHeirs (source)',
    screenSrc.includes('disabled={!canReviewHeirs({ drafts, acknowledged: ack })}') && !screenSrc.includes('disabled={!ack}'));
  // Mutation: canReviewHeirs without the heir count must fail the zero-heir check.
  const inhSrc = readSrc(new URL('../src/wallet/inheritance.ts', import.meta.url), 'utf8');
  const anchor = '  return args.acknowledged && heirCount(args.drafts) > 0;';
  check('mutation anchor present (zero-heir rule)', inhSrc.includes(anchor));
  const { dirname: dn, resolve: rs, join: jn } = await import('node:path');
  const { fileURLToPath: f2p, pathToFileURL: p2f } = await import('node:url');
  const here = dn(f2p(import.meta.url));
  const original = rs(here, '../src/wallet');
  const mdir = jn(here, `.mutants-inheritance-${process.pid}`);
  mkdirSrc(mdir, { recursive: true });
  try {
    const mutated = inhSrc
      .replace(anchor, '  return args.acknowledged;')
      .replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${p2f(rs(original, spec)).href}'`);
    const file = jn(mdir, 'inheritance.ts');
    writeSrc(file, mutated);
    const m = await import(p2f(file).href);
    check('M-h1 caught: without the heir count Review would be enabled with zero heirs', m.canReviewHeirs({ drafts: empty, acknowledged: true }) === true);
  } finally {
    rmSrc(mdir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
console.log('check-inheritance: exposure in heir words');
// ---------------------------------------------------------------------------
{
  const single = describeHeirExposure({ guardians: [{ address: heirA.address, weight: 1 }], threshold: 1, delaySeconds: 600 }, () => 'Sister');
  check('single heir: total signing power, named', single === `Your heir Sister (${heirA.address}) alone can sign messages as this account from the moment this set is installed.`, single);
  const pair = describeHeirExposure({ guardians: [{ address: heirA.address, weight: 1 }, { address: heirB.address, weight: 1 }], threshold: 2, delaySeconds: 600 });
  check('2-of-2: ONE heir alone can sign (repeated-signer finding)', /^ONE heir alone can sign messages as this account/.test(pair) && pair.includes(heirA.address) && pair.includes(heirB.address), pair);
  const five = describeHeirExposure({ guardians: [heirA, heirB, heirC, createSessionKeyAccount(toBytes('0x' + '44'.repeat(32))), createSessionKeyAccount(toBytes('0x' + '55'.repeat(32)))].map((g) => ({ address: g.address, weight: 1 })), threshold: 3, delaySeconds: 600 });
  check('3-of-5: 2 heirs can sign, the takeover needs 3', five === '2 heirs together can sign messages as this account from the moment this set is installed; the takeover itself needs 3.', five);
}

// ---------------------------------------------------------------------------
console.log('check-inheritance: eligibility (reused guardian refusals)');
// ---------------------------------------------------------------------------
{
  const node = fakeNode();
  node.add(ACCOUNT, { owner: OWNER_0 });
  const bundler = fakeBundler();
  const imported = await resolveGuardianAccount(kernelBundle(node, bundler, { accountIndex: 2 ** 31 }), OWNER_0);
  check('imported-key owner refused with the guardian sentence, no request', !imported.ok && imported.reason === GUARDIAN_IMPORTED_REFUSAL && node.calls.length === 0);
  const simple = await resolveGuardianAccount(kernelBundle(node, bundler, { accountType: 'simple' }), OWNER_0);
  check('SimpleAccount refused', !simple.ok && simple.reason === GUARDIAN_SIMPLE_REFUSAL);
  const delegated = await resolveGuardianAccount(kernelBundle(node, bundler, { accountType: 'kernel-7702' }), OWNER_0);
  check('EIP-7702 upgrade refused', !delegated.ok && delegated.reason === GUARDIAN_7702_REFUSAL);
  const bare = fakeNode();
  const undeployed = await resolveGuardianAccount(kernelBundle(bare, bundler), OWNER_0);
  check('undeployed Kernel account refused', !undeployed.ok && undeployed.reason === GUARDIAN_UNDEPLOYED_REFUSAL, JSON.stringify(undeployed));
  const ok = await resolveGuardianAccount(kernelBundle(node, bundler), OWNER_0);
  check('a deployed Kernel account owned by a phrase account is eligible', ok.ok && ok.account === ACCOUNT);
}

// ---------------------------------------------------------------------------
console.log('check-inheritance: install (owner-signed), record role "heirs"');
// ---------------------------------------------------------------------------
{
  const node = fakeNode();
  node.add(ACCOUNT, { owner: OWNER_0 });
  const bundler = fakeBundler({ receipt: { success: true, receipt: { transactionHash: INSTALL_TX } } });
  const bundle = kernelBundle(node, bundler);
  const store = memoryStore();
  await freshRecord(store);
  const entry0 = await getRecoveryRecord(M, ACCOUNT, store);
  const { set, labels } = buildHeirSet({ drafts: [{ address: heirA.address, label: 'Sister', weight: '1' }], threshold: '1', delaySeconds: 600 });
  const state0 = (await resolveGuardianAccount(bundle, OWNER_0)).state;

  const mainBundle = kernelBundle(node, bundler, { chainId: 1n });
  const beforeMain = node.calls.length;
  const onMain = await caught(() => prepareHeirInstallQuote(mainBundle, OWNER_0, ACCOUNT, set, labels, { acknowledged: true, state: state0, entry: entry0 }));
  check('mainnet install refused with ZERO network calls', onMain?.message === INHERITANCE_TESTNET_ONLY && node.calls.length === beforeMain);
  const beforeAck = node.calls.length;
  const noAck = await caught(() => prepareHeirInstallQuote(bundle, OWNER_0, ACCOUNT, set, labels, { acknowledged: false, state: state0, entry: entry0 }));
  check('no acknowledgement → refused with ZERO network calls', noAck?.message === INHERITANCE_ACK_REQUIRED && node.calls.length === beforeAck);
  const guardianState = { ...state0, validatorInitialized: true, validationInstalled: true };
  const conflict = await caught(() => prepareHeirInstallQuote(bundle, OWNER_0, ACCOUNT, set, labels, { acknowledged: true, state: guardianState, entry: entry0 }));
  check('existing guardians (not labelled heirs) → one-set refusal', conflict?.message === INHERITANCE_GUARDIANS_CONFLICT);
  check('inheritanceConflict: nothing installed → null', inheritanceConflict(state0, entry0) === null);

  const op = await prepareHeirInstallQuote(bundle, OWNER_0, ACCOUNT, set, labels, { acknowledged: true, state: state0, entry: entry0 });
  const expected = guardianInstallCalls(ACCOUNT, set, { owner: OWNER_0 });
  check('install calls equal the engine guardianInstallCalls; quote role "heirs"', op.role === 'heirs' && op.kind === 'install' && op.calls.every((c, i) => toHex(c.data) === toHex(expected[i].data)));
  const estimated = decodeKernelExecute(bundler.lastEstimated.callData);
  const iface = new ethers.Interface(['function installModule(uint256 moduleType, address module, bytes initData)']);
  const first = iface.decodeFunctionData('installModule', estimated.calls[0].data);
  const [validatorData] = abi.decode(['bytes', 'bytes', 'bytes'], ethers.hexlify(ethers.getBytes(first[2]).slice(20)));
  const [gs, ws, threshold, delay] = abi.decode(['address[]', 'uint24[]', 'uint24', 'uint48'], validatorData);
  check('ethers decode: WeightedECDSAValidator, one heir weight 1, threshold 1, delay 600', same(first[1], W) && gs.length === 1 && same(gs[0], heirA.address) && ws[0] === 1n && threshold === 1n && delay === 600n);

  let seen = null;
  const { userOpHash } = await submitGuardianOperation({
    operation: op,
    chain: M,
    store,
    submit: async (q) => {
      seen = (await getRecoveryRecord(M, ACCOUNT, store)).metadata.guardians;
      return sendAa(bundle, owner, q);
    },
  });
  check('record says role "heirs" (with the label) BEFORE submission', seen?.role === 'heirs' && seen.guardians[0].label === 'Sister');
  const sent = bundler.lastOp;
  const signer = ethers.verifyMessage(
    ethers.getBytes(
      toHex(
        getUserOpHash(
          { ...sent, nonce: BigInt(sent.nonce), callData: toBytes(sent.callData), callGasLimit: BigInt(sent.callGasLimit), verificationGasLimit: BigInt(sent.verificationGasLimit), preVerificationGas: BigInt(sent.preVerificationGas), maxFeePerGas: BigInt(sent.maxFeePerGas), maxPriorityFeePerGas: BigInt(sent.maxPriorityFeePerGas), signature: toBytes(sent.signature) },
          ENTRYPOINT_V07,
          CHAIN_ID,
        ),
      ),
    ),
    sent.signature,
  );
  check('install signed by the OWNER key (recovered by ethers)', same(signer, OWNER_0));
  node.get(ACCOUNT).guardians = set;
  const fin = await finalizeGuardianOperation({ bundle, userOpHash, chain: M, account: ACCOUNT, kind: 'install', store, timeoutMs: 1000, pollMs: 1 });
  const after = await getRecoveryRecord(M, ACCOUNT, store);
  check('after inclusion: install tx recorded, role kept', fin.matches && after.metadata.guardians.installTxHash === INSTALL_TX && after.metadata.guardians.role === 'heirs' && isHeirRecord(after));
  const text = serializeRecoveryMetadata(after.metadata);
  check('canonical record carries "role":"heirs" and re-parses identically', text.includes('"role":"heirs"') && serializeRecoveryMetadata(parseRecoveryMetadata(text)) === text);
  const synced = await syncRecordGuardiansFromChain(node, M, ACCOUNT, store);
  check('sync from chain keeps the role for the same set', synced.metadata.guardians.role === 'heirs');
  const rebuilt = { ...after.metadata, guardians: null };
  const merged = mergeRecoveryMetadata(after.metadata, rebuilt, { chainGuardians: (await resolveGuardianAccount(bundle, OWNER_0)).state });
  check('merge with a rebuilt record keeps the role (chain set equals the labelled set)', merged.guardians?.role === 'heirs');
  const st = (await resolveGuardianAccount(bundle, OWNER_0)).state;
  check('inheritanceConflict: heirs installed and labelled → null (manage here)', inheritanceConflict(st, after) === null);
  const relabelled = { ...after, metadata: { ...after.metadata, guardians: { ...after.metadata.guardians, role: undefined } } };
  check('inheritanceConflict: the same set without the heirs label → guardians conflict', inheritanceConflict(st, relabelled) === INHERITANCE_GUARDIANS_CONFLICT);

  // -------------------------------------------------------------------------
  console.log('check-inheritance: check for takeover attempts');
  // -------------------------------------------------------------------------
  const request = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: ACCOUNT, newOwner: heirNewOwner.address, nonce: guardianNonceKey(KERNEL_RECOVERY_MODULES, 7) << 64n, guardians: set.guardians });
  const approveTx = encodeApproveWithSig(request, [signGuardianApproval(heirA, toBytes(request.approvalDigest))]);
  const otherRequest = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: '0x959E8dF4f03033134A791f887209B75aeb13D95a', newOwner: heirNewOwner.address, nonce: guardianNonceKey() << 64n });
  const otherTx = encodeApproveWithSig(otherRequest, [signGuardianApproval(heirA, toBytes(otherRequest.approvalDigest))]);
  const hiddenRequest = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: ACCOUNT, newOwner: heirNewOwner.address, nonce: guardianNonceKey(KERNEL_RECOVERY_MODULES, 8) << 64n, guardians: set.guardians });
  const hiddenTx = encodeApproveWithSig(hiddenRequest, [signGuardianApproval(heirA, toBytes(hiddenRequest.approvalDigest))]);
  const multicall = '0x' + '77'.repeat(20);
  node.blocks.set(INSTALL_BLOCK + 10n, [
    { hash: '0x' + 'a1'.repeat(32), from: heirNewOwner.address, to: W, input: toHex(approveTx.data) },
    { hash: '0x' + 'a2'.repeat(32), from: heirNewOwner.address, to: W, input: toHex(otherTx.data) },
  ]);
  // An approval relayed through another contract: an internal call, invisible to the scan (the stated limit).
  node.blocks.set(INSTALL_BLOCK + 20n, [{ hash: '0x' + 'a3'.repeat(32), from: heirNewOwner.address, to: multicall, input: toHex(hiddenTx.data) }]);
  node.get(ACCOUNT).proposals.set(request.callDataAndNonceHash.toLowerCase(), { status: 1, validAfter: 2_000_000_600, weight: 1 });
  node.get(ACCOUNT).proposals.set(hiddenRequest.callDataAndNonceHash.toLowerCase(), { status: 1, validAfter: 2_000_000_600, weight: 1 });
  node.head = INSTALL_BLOCK + 100n;

  const now = 2_000_000_000_000; // ms
  const first1 = await checkTakeoverAttempts({ node, chain: M, chainId: CHAIN_ID, account: ACCOUNT, threshold: 1, store, now });
  check('first check starts at the install block (from the record’s install transaction)', first1.startsAtInstall && first1.startBlock === INSTALL_BLOCK && first1.scannedFrom === INSTALL_BLOCK);
  check(`one check reads ${INSTALL_BLOCK} … +${INSTALL_SCAN_LAST()} (60 blocks)`, first1.scannedTo === INSTALL_BLOCK + BigInt(INHERITANCE_SCAN_BLOCKS_PER_CHECK) - 1n);
  check('found the approveWithSig naming this account, not the other account’s', first1.newlyFound.length === 1 && first1.newlyFound[0].proposalHash === request.callDataAndNonceHash.toLowerCase() && same(first1.newlyFound[0].approvers[0], heirA.address));
  check('the found takeover is watched and pending (approved, vetoable)', first1.pending.length === 1 && first1.pending[0].hash === request.callDataAndNonceHash.toLowerCase() && first1.pending[0].canVeto);
  check('the approval relayed through another contract is NOT found (stated limit)', !first1.views.some((v) => v.hash === hiddenRequest.callDataAndNonceHash.toLowerCase()));
  check('remaining blocks reported (101 since install − 60 scanned = 41)', first1.remainingBlocks === 41n);
  const coverage = takeoverCoverageText(first1);
  check(
    'coverage sentence never claims more than was read',
    coverage ===
      `Scanning from block ${INSTALL_BLOCK} (when the heirs were installed). This check read blocks ${INSTALL_BLOCK}–${INSTALL_BLOCK + 59n}. 41 newer blocks are not scanned yet: check again to continue. Only approvals sent directly to the guardian contract are found.`,
    coverage,
  );
  const stored = await getTakeoverScanState(M, ACCOUNT, store);
  check('scan state stored (cursor, found transaction)', stored.scannedThrough === (INSTALL_BLOCK + 59n).toString() && stored.found.length === 1 && stored.found[0].txHash === '0x' + 'a1'.repeat(32));
  const second = await checkTakeoverAttempts({ node, chain: M, chainId: CHAIN_ID, account: ACCOUNT, threshold: 1, store, now: now + 60_000 });
  check('second check continues where the first stopped and reaches the head', second.scannedFrom === INSTALL_BLOCK + 60n && second.scannedTo === INSTALL_BLOCK + 100n && second.remainingBlocks === 0n && /Every block up to the latest one has been scanned/.test(takeoverCoverageText(second)));
  const nowSeconds = 2_000_000_000;
  check('status text: approved, counting down, "Veto it now if you are still here."', takeoverStatusText(second.pending[0], nowSeconds) === 'TAKEOVER APPROVED by your heir: it can execute in 10 min. Veto it now if you are still here.', takeoverStatusText(second.pending[0], nowSeconds));
  check('status text: delay passed', /delay has passed: your heir can execute it at any moment/.test(takeoverStatusText(second.pending[0], nowSeconds + 601)));
  // No install transaction known: the first check says earlier blocks were not scanned.
  const store2 = memoryStore();
  await freshRecord(store2);
  const noInstall = await checkTakeoverAttempts({ node, chain: M, chainId: CHAIN_ID, account: ACCOUNT, threshold: 1, store: store2, now });
  check('without an install transaction: starts 60 blocks before the head and says so', !noInstall.startsAtInstall && noInstall.startBlock === node.head - 59n && /the first check; earlier blocks were not scanned/.test(takeoverCoverageText(noInstall)));
  // A shared request (the heir told the owner) is watched too: the hidden approval becomes visible.
  const { addWatchedProposal } = await import('../src/wallet/recovery.ts');
  await addWatchedProposal(M, ACCOUNT, hiddenRequest.callDataAndNonceHash, store, now);
  const shared = await checkTakeoverAttempts({ node, chain: M, chainId: CHAIN_ID, account: ACCOUNT, threshold: 1, store, now: now + 120_000 });
  check('a takeover the heir shared is watched and pending even though the scan cannot see it', shared.pending.length === 2);

  // -------------------------------------------------------------------------
  console.log('check-inheritance: remove heirs + veto the known takeovers');
  // -------------------------------------------------------------------------
  const calls = heirRemovalCalls(ACCOUNT, [request.callDataAndNonceHash, request.callDataAndNonceHash.toUpperCase().replace('0X', '0x')]);
  check('removal = the engine uninstall calls, then ONE veto per distinct takeover', calls.length === 4 && guardianUninstallCalls(ACCOUNT).every((c, i) => toHex(c.data) === toHex(calls[i].data)) && toHex(calls[3].data) === toHex(encodeVetoCall(request.callDataAndNonceHash).data));
  const remove = await prepareHeirRemoveQuote(bundle, OWNER_0, ACCOUNT, shared.views);
  const vetoIface = new ethers.Interface(['function veto(bytes32 _callDataAndNonceHash)']);
  const decoded = decodeKernelExecute(bundler.lastEstimated.callData).calls;
  const vetoed = decoded.slice(3).map((c) => vetoIface.decodeFunctionData('veto', c.data)[0].toLowerCase());
  check('the quoted batch vetoes both pending takeovers (decoded by ethers), sent to the validator', remove.vetoed.length === 2 && decoded.length === 5 && decoded.slice(3).every((c) => same(c.to, W)) && vetoed.includes(request.callDataAndNonceHash.toLowerCase()) && vetoed.includes(hiddenRequest.callDataAndNonceHash.toLowerCase()));
  node.get(ACCOUNT).proposals.set(request.callDataAndNonceHash.toLowerCase(), { status: 2, validAfter: 2_000_000_600, weight: 1 });
  const afterVeto = await checkTakeoverAttempts({ node, chain: M, chainId: CHAIN_ID, account: ACCOUNT, threshold: 1, store, now: now + 180_000 });
  check('a vetoed takeover is no longer pending and offers no Veto', afterVeto.pending.length === 1 && afterVeto.views.some((v) => v.state?.status === 'rejected' && !v.canVeto));
  const { userOpHash: removeHash } = await submitGuardianOperation({ operation: remove, chain: M, store, submit: (q) => sendAa(bundle, owner, q) });
  check('removal clears the heirs from the record', typeof removeHash === 'string' && (await getRecoveryRecord(M, ACCOUNT, store)).metadata.guardians === null);
  await clearTakeoverScanState(M, ACCOUNT, store);
  check('scan state forgotten after removal', (await getTakeoverScanState(M, ACCOUNT, store)) === null && store._map.has(INHERITANCE_STORE_KEY));
  // Removal is never gated: it works on mainnet too (it fails here only on the fake's state, not on a gate).
  const mainRemove = await caught(() => prepareHeirRemoveQuote(mainBundle, OWNER_0, ACCOUNT, []));
  check('removal is not refused by the test-network rule', mainRemove === null || mainRemove.message !== INHERITANCE_TESTNET_ONLY, mainRemove?.message);
}

function INSTALL_SCAN_LAST() {
  return INHERITANCE_SCAN_BLOCKS_PER_CHECK - 1;
}

console.log(`\ncheck-inheritance: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

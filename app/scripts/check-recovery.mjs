// Phase 8 item 4 (app half): guardians and social recovery, entirely
// OFFLINE. Exercises the exact app modules (src/wallet/recovery.ts, aa.ts,
// walletconnect.ts) under Node's type stripping against fakes:
//  - recovery metadata: create / export / import / verify round trips,
//    tampered records refused by the engine's strict parser, store
//    discipline (corrupt storage, export marker), the first-use listener;
//  - eligibility refusals (EIP-7702 upgrade — pinned to the engine's own
//    text —, SimpleAccount, undeployed, foreign owner);
//  - guardian-set validation refusals surfaced verbatim from the engine;
//  - the exposure warning for a 2-of-2 with equal weights and a 3-of-5;
//  - the 48 h default delay and the no-veto acknowledgement;
//  - install / renew / remove / veto calldata equal to the engine's (and
//    decoded independently with ethers), the record written BEFORE
//    submission and restored when the bundler refuses;
//  - recovery: request build → guardian approval (signature recovered by
//    ethers' EIP-712 verifier) → approval checks → approvals assembly →
//    doRecovery operation (calldata equal to the engine's, signature
//    recovered by ethers) on the no-delay path; approveWithSig (raw tx
//    decoded by ethers) → delay → final operation on the delay path;
//  - the recovered account attaches only after the on-chain owner check;
//  - wipe removes nothing from the chain (zero node calls) but the record
//    export is offered first;
//  - WalletConnect refuses guardian approvals and guardian-module calls;
//  - record files: the export file-name rule, the exact canonical bytes
//    written to and read back from a real file, and import refusals (strict
//    parser on a tampered file, wrong type, oversize, extra text);
//  - owner rotation ("Change owner"): the refusal matrix, the calls equal to
//    the engine's ownerRotationCalls / the kernel-rotate-owner.mjs script's
//    plan (and decoded independently with ethers), the owner signature, the
//    owner-history append, the attachment move, failure / abandon / resume.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-recovery.mjs
//
// Nothing is signed against a live chain and nothing is broadcast.

import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  KERNEL_RECOVERY_MODULES,
  KERNEL_RECOVERY_SELECTOR,
  KERNEL_V3_3,
  assembleGuardianApprovals,
  buildGuardianRecoveryRequest,
  createSessionKeyAccount,
  encodeApproveWithSig,
  encodeRecoveryCallData,
  encodeVetoCall,
  getUserOpHash,
  guardianInstallCalls,
  guardianNonceKey,
  guardianRenewCall,
  guardianUninstallCalls,
  kernelValidatorId,
  ownerRotationCalls,
  predictKernelAddress,
  prepareGuardianInstall,
  recordOwnerChange,
  selector,
  toBytes,
  serializeRecoveryMetadata,
  toHex,
  verifyRecoveryMetadataOnChain,
} from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import {
  AA_DEPOSIT_TOPUP_VERIFICATION_GAS,
  RECOVERED_7702_CONFLICT,
  ROTATION_TARGET_HAS_OTHER_ACCOUNT,
  createAaClient,
  createAaClientFromConfig,
  getAaConfig,
  resolveAaSender,
  sendAa,
  AA_QUOTE_ALREADY_USED,
  setAccountEip7702,
  setRecoveredAccount,
} from '../src/wallet/aa.ts';
import {
  DEFAULT_GUARDIAN_DELAY_SECONDS,
  DELAY_PRESETS,
  GUARDIANS_AUDIT_NOTE,
  GUARDIANS_TRUST_LINES,
  GUARDIAN_7702_REFUSAL,
  GUARDIAN_NOT_OWNER_REFUSAL,
  GUARDIAN_ROOT_VALIDATOR_HAZARD,
  GUARDIAN_SIMPLE_REFUSAL,
  GUARDIAN_UNDEPLOYED_REFUSAL,
  NO_VETO_ACK_REQUIRED,
  OWNER_ROTATION_7702_REFUSAL,
  OWNER_ROTATION_7702_TARGET,
  OWNER_ROTATION_FOREIGN_TARGET,
  OWNER_ROTATION_GUARDIAN_TARGET,
  OWNER_ROTATION_NO_GUARDIANS,
  OWNER_ROTATION_NO_RECORD,
  OWNER_ROTATION_NOT_OWNER_REFUSAL,
  OWNER_ROTATION_RECORD_STALE,
  OWNER_ROTATION_SAME_OWNER,
  OWNER_ROTATION_SIMPLE_REFUSAL,
  OWNER_ROTATION_UNDEPLOYED_REFUSAL,
  QR_MAX_BYTES,
  RECORD_FILE_MAX_BYTES,
  RECORD_FILE_MIME_TYPE,
  RECORD_FILE_NAME_PATTERN,
  RECOVERY_RECORDS_KEY,
  REQUEST_NOT_ROOT_REFUSAL,
  addApprovalToProgress,
  addWatchedProposal,
  approvalTypedDataJson,
  assertGuardianModulesSafe,
  attachRecoveredAccount,
  buildGuardianSet,
  delayPresetsFor,
  describeGuardianExposure,
  encodeRecoveryRequestPayload,
  ensureFactoryKernelRecord,
  evmAccountPath,
  exportAllRecordsText,
  finalizeGuardianOperation,
  finalizeOwnerRotation,
  findRecoveryTransaction,
  formatDuration,
  getRecoveryProgress,
  getRecoveryRecord,
  checkOwnerRotationTarget,
  listPendingOwnerRotations,
  loadRecoveryProgressList,
  loadRecoveryRecords,
  markRecordExported,
  parseRecordFile,
  parseRecordText,
  parseRecoveryRequestPayload,
  prepareApproveWithSig,
  prepareGuardianInstallQuote,
  prepareGuardianRemoveQuote,
  prepareGuardianRenewQuote,
  prepareGuardianSubmission,
  prepareOwnerRotationQuote,
  prepareRecoveryStart,
  prepareVetoQuote,
  readGuardianStatus,
  readProposalView,
  readRecoveryStage,
  mergeRecoveryMetadata,
  rebuildRecoveryRecord,
  rebuildRecoveryRecordFromChain,
  recordExport,
  recordExportFileName,
  recordFileContents,
  recoveryApprovalProgress,
  recoveryRecordListener,
  recoveryRequestShareText,
  resetRecoveryRecords,
  resolveGuardianAccount,
  reviewRecordImport,
  reviewRecoveryRequest,
  saveRecoveryMetadata,
  saveRecoveryProgress,
  sendApproveWithSig,
  signRecoveryApproval,
  submitGuardianOperation,
  submitGuardianRecovery,
  submitOwnerRotation,
  syncRecordGuardiansFromChain,
  userOpReceiptBlock,
  applyRecordImport,
  validateGuardianSetForAccount,
  waitAndFinalizeOwnerRotation,
  wipeRecoveryData,
} from '../src/wallet/recovery.ts';
import { GUARDIAN_WC_REFUSAL, WcRequestRejection, parseWcRequest } from '../src/wallet/walletconnect.ts';
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
// Guardians, guardian recovery and owner changes are 'testnet-only' in the
// mainnet readiness table (src/config/readiness.ts, phase 9 item 6), so
// every flow here runs on Sepolia; the mainnet refusals are checked at the
// end and in check-readiness.mjs. (The record-file section keeps mainnet
// records: export and import are not gated.)
const M = 'eip155:11155111';
const CHAIN_ID = 11155111n;
const W = KERNEL_RECOVERY_MODULES.weightedEcdsaValidator;
const RA = KERNEL_RECOVERY_MODULES.recoveryAction;
const VALIDATOR = KERNEL_V3_3.ecdsaValidator;

const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
const newOwner = evmKeyProvider.deriveAccount(seed, 0, 9); // the "new wallet" owner key
seed.fill(0);
const ACCOUNT = KERNEL_ACCOUNT_0;
// Fixed guardian keys (test-only; never used anywhere else).
const gA = createSessionKeyAccount(toBytes('0x' + '11'.repeat(32)));
const gB = createSessionKeyAccount(toBytes('0x' + '22'.repeat(32)));
const gC = createSessionKeyAccount(toBytes('0x' + '33'.repeat(32)));
const outsider = createSessionKeyAccount(toBytes('0x' + '44'.repeat(32)));
const wA = new ethers.Wallet('0x' + '11'.repeat(32));
const wB = new ethers.Wallet('0x' + '22'.repeat(32));

/**
 * Fake node: fakeKernelNode (factory views, balances, fees) plus an
 * emulation of the read-only surface the engine's recovery module uses —
 * Kernel v3.3 rootValidator / validationConfig / isAllowedSelector /
 * selectorConfig, the ECDSA validator's owner, the weighted validator's
 * weightedStorage / guardian list / proposalStatus / getApproval, the
 * ERC-1967 implementation slot, EntryPoint getNonce per key, plus
 * transaction plumbing (estimate, nonce, raw broadcast, receipts, logs).
 * State is changed by the test to emulate inclusion.
 */
function fakeGuardianNode({ chainIdHex = '0xaa36a7' } = {}) {
  const accounts = new Map(); // lower address -> state
  const calls = [];
  const raw = [];
  const logs = [];
  const base = fakeKernelNode({ chainIdHex, deployedAccounts: new Set() });
  const acct = (a) => accounts.get(a.toLowerCase());
  const transport = async (method, params) => {
    calls.push({ method, params });
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
    if (method === 'eth_estimateGas') return '0x186a0';
    if (method === 'eth_getTransactionCount') return '0x5';
    if (method === 'eth_sendRawTransaction') {
      raw.push(params[0]);
      return ethers.keccak256(params[0]);
    }
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x64' };
    if (method === 'eth_blockNumber') return '0x2710';
    if (method === 'eth_getLogs') {
      const [f] = params;
      return logs.filter((l) => same(l.address, f.address) && f.topics.every((t, i) => t === null || same(t, l.topics[i])));
    }
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      const body = '0x' + data.slice(10);
      const a = acct(to);
      if (a) {
        if (data.startsWith(sel('rootValidator()'))) {
          const root = a.rootEcdsa ? '01' + VALIDATOR.slice(2).toLowerCase() : '01' + '77'.repeat(20);
          return '0x' + root + '00'.repeat(11);
        }
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
        const s = acct(who);
        return pad32(s ? s.owner : ZERO);
      }
      if (same(to, W)) {
        if (data.startsWith(sel('weightedStorage(address)'))) {
          const [who] = abi.decode(['address'], body);
          const s = acct(who);
          if (!s || !s.guardians) return abi.encode(['uint24', 'uint24', 'uint48', 'address'], [0, 0, 0, ZERO]);
          // Kernel's list: the LAST added (smallest address) is first.
          const asc = [...s.guardians.guardians].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));
          const total = asc.reduce((t, g) => t + g.weight, 0);
          return abi.encode(['uint24', 'uint24', 'uint48', 'address'], [total, s.guardians.threshold, s.guardians.delaySeconds, asc[0].address]);
        }
        if (data.startsWith(sel('guardian(address,address)'))) {
          const [g, who] = abi.decode(['address', 'address'], body);
          const s = acct(who);
          const asc = [...(s?.guardians?.guardians ?? [])].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));
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
        const seq = key === 0n ? (s?.rootSeq ?? 0n) : (s?.guardianSeq ?? 0n);
        return word((key << 64n) | seq);
      }
    }
    return base(method, params);
  };
  transport.calls = calls;
  transport.raw = raw;
  transport.logs = logs;
  transport.add = (address, state) =>
    accounts.set(address.toLowerCase(), {
      code: '0x6001',
      implementation: KERNEL_V3_3.implementation,
      rootEcdsa: true,
      guardians: null,
      proposals: new Map(),
      rootSeq: 1n,
      guardianSeq: 0n,
      ...state,
    });
  transport.get = acct;
  return transport;
}

function kernelBundle(node, bundler, { accountType = 'kernel-v3.3', recoveredAccount } = {}) {
  return createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: KERNEL_V3_3.factory,
    chainId: CHAIN_ID,
    accountIndex: 0,
    accountType,
    ...(recoveredAccount ? { recoveredAccount } : {}),
    transportFor: (url) => (url.includes('bundler') ? bundler : node),
  });
}

const set2of2 = (delaySeconds = DEFAULT_GUARDIAN_DELAY_SECONDS) => ({
  guardians: [
    { address: gA.address, weight: 1 },
    { address: gB.address, weight: 1 },
  ],
  threshold: 2,
  delaySeconds,
});

// ---------------------------------------------------------------------------
console.log('check-recovery: recovery metadata (create / export / import / verify)');
// ---------------------------------------------------------------------------
{
  const store = memoryStore();
  const created = await ensureFactoryKernelRecord({
    chain: M,
    account: ACCOUNT,
    accountIndex: 0,
    owner: OWNER_0,
    ownerPath: owner.path,
    factory: KERNEL_V3_3.factory,
    implementation: KERNEL_V3_3.implementation,
    ecdsaValidator: VALIDATOR,
    store,
    now: 1_700_000_000_000,
  });
  const meta = created.entry.metadata;
  check('record created for the factory Kernel account (CREATE2 lineage checked by the engine)', created.created && meta.account === ACCOUNT && meta.chainId === M && meta.deployment.index === '0');
  check('first owner = deployment owner with its BIP-32 path', meta.owners.length === 1 && meta.owners[0].owner === OWNER_0 && meta.owners[0].source === 'deployment' && meta.owners[0].derivationPath === "m/44'/60'/0'/0/0");
  const again = await ensureFactoryKernelRecord({ chain: M, account: ACCOUNT, accountIndex: 0, owner: OWNER_0, ownerPath: owner.path, factory: KERNEL_V3_3.factory, implementation: KERNEL_V3_3.implementation, ecdsaValidator: VALIDATOR, store });
  check('second call keeps the existing record', !again.created);
  const wrong = await caught(() =>
    ensureFactoryKernelRecord({ chain: M, account: ACCOUNT, accountIndex: 1, owner: OWNER_0, ownerPath: null, factory: KERNEL_V3_3.factory, implementation: KERNEL_V3_3.implementation, ecdsaValidator: VALIDATOR, store: memoryStore() }),
  );
  check('a wrong index (address is not the CREATE2 result) is refused by the engine', wrong && /is not the Kernel v3\.3 address of/.test(wrong.message), wrong?.message);

  const exp = recordExport(meta);
  check('export JSON parses back to an identical record', JSON.stringify(parseRecordText(exp.json)) === JSON.stringify(meta));
  check('the share text (header + JSON) parses back too', JSON.stringify(parseRecordText(exp.shareText)) === JSON.stringify(meta));
  check('a small record fits one QR code', exp.qrValue === exp.json && exp.bytes <= QR_MAX_BYTES);

  // Tampered records: the engine's strict parser re-checks the lineage.
  const tamperAccount = exp.json.replace(ACCOUNT, '0x' + ACCOUNT.slice(2, -1) + (ACCOUNT.endsWith('2') ? '3' : '2'));
  const e1 = await caught(() => parseRecordText(tamperAccount));
  check('tampered account address refused (lineage)', e1 && /account does not match the deployment/.test(e1.message), e1?.message);
  const tamperOwner = JSON.parse(exp.json);
  tamperOwner.owners[0].owner = newOwner.address;
  const e2 = await caught(() => parseRecordText(JSON.stringify(tamperOwner)));
  check('tampered deployment owner refused', e2 && /owners\[0\] must be the deployment owner/.test(e2.message), e2?.message);
  const tamperGuardians = JSON.parse(exp.json);
  tamperGuardians.guardians = { weightedEcdsaValidator: W, recoveryAction: RA, guardians: [{ address: gA.address, weight: 1 }], threshold: 5, delaySeconds: 0, installTxHash: null };
  const e3 = await caught(() => parseRecordText(JSON.stringify(tamperGuardians)));
  check('tampered guardian threshold refused (engine set validation)', e3 && /exceeds the total guardian weight/.test(e3.message), e3?.message);
  const e4 = await caught(() => parseRecordText('hello'));
  check('text without a record refused plainly', e4 && /No recovery record found/.test(e4.message));

  // Verify on-chain.
  const node = fakeGuardianNode();
  node.add(ACCOUNT, { owner: OWNER_0 });
  const status = await readGuardianStatus(node, ACCOUNT, created.entry);
  check('verifyRecoveryMetadataOnChain: matching record → ok', status.recordCheck.ok, JSON.stringify(status.recordCheck));
  const withGuardians = await saveRecoveryMetadata({ ...meta, guardians: { weightedEcdsaValidator: W, recoveryAction: RA, guardians: set2of2().guardians, threshold: 2, delaySeconds: DEFAULT_GUARDIAN_DELAY_SECONDS, installTxHash: null } }, memoryStore());
  const mismatch = await verifyRecoveryMetadataOnChain(node, withGuardians.metadata);
  check('record listing guardians that are not on-chain → reported', !mismatch.ok && mismatch.problems.includes('record lists guardians, but none are active on-chain'), JSON.stringify(mismatch));
  node.get(ACCOUNT).owner = newOwner.address;
  const moved = await verifyRecoveryMetadataOnChain(node, meta);
  check('owner changed on-chain → reported', !moved.ok && moved.problems.some((p) => p.startsWith('owner is ')), JSON.stringify(moved));

  // Import on restore: the owner is matched against the wallet's accounts.
  node.get(ACCOUNT).owner = OWNER_0;
  const owned = [{ index: 0, address: OWNER_0, path: owner.path }, { index: 9, address: newOwner.address, path: newOwner.path }];
  const review = await reviewRecordImport(node, exp.shareText, owned);
  check('import review: verified, owned by account index 0, derivable (no attachment needed)', review.verification.ok && review.ownerAccount?.index === 0 && review.needsAttach === false);
  node.get(ACCOUNT).owner = newOwner.address;
  const review2 = await reviewRecordImport(node, exp.json, owned);
  check('import review after an owner change: owned by index 9, NOT derivable → needs attachment', review2.ownerAccount?.index === 9 && review2.needsAttach === true);

  // Store discipline.
  check('exportedAt starts empty', created.entry.exportedAt === null);
  const marked = await markRecordExported(M, ACCOUNT, store, 123);
  check('markRecordExported sets the marker', marked.exportedAt === 123);
  const changed = await saveRecoveryMetadata({ ...meta, guardians: { weightedEcdsaValidator: W, recoveryAction: RA, guardians: set2of2().guardians, threshold: 2, delaySeconds: 3600, installTxHash: null } }, store);
  check('changing the record clears the export marker (backup out of date)', changed.exportedAt === null);
  const corrupt = memoryStore();
  await corrupt.setItem(RECOVERY_RECORDS_KEY, '{not json');
  const load = await loadRecoveryRecords(corrupt);
  check('unreadable store → empty + flags', load.entries.length === 0 && load.unreadable && load.corrupt);
  const writeErr = await caught(() => saveRecoveryMetadata(meta, corrupt));
  check('writes refused while unreadable', writeErr && /could not be read/.test(writeErr.message));
  await resetRecoveryRecords(corrupt);
  check('reset makes the store usable again', (await saveRecoveryMetadata(meta, corrupt)).metadata.account === ACCOUNT);

  // Rebuild from the original owner (restore without a backup).
  const rebuilt = rebuildRecoveryRecord({ chainId: CHAIN_ID, account: ACCOUNT, originalOwner: OWNER_0, recordedAt: 1 });
  check('rebuild without a known index finds index 0', rebuilt.deployment.index === '0' && rebuilt.account === ACCOUNT);
  const rebuildErr = await caught(() => rebuildRecoveryRecord({ chainId: CHAIN_ID, account: ACCOUNT, originalOwner: newOwner.address, recordedAt: 1 }));
  check('rebuild with the wrong original owner is refused', rebuildErr && /at any index from 0 to 49/.test(rebuildErr.message));
}

// ---------------------------------------------------------------------------
console.log('check-recovery: first-use listener (aa.ts send fan-out)');
// ---------------------------------------------------------------------------
{
  const node = fakeGuardianNode();
  node.add(ACCOUNT, { owner: OWNER_0 });
  const bundler = fakeBundler();
  const store = memoryStore();
  const bundle = kernelBundle(node, bundler);
  const listener = recoveryRecordListener(store);
  const quote = { sender: ACCOUNT };
  await listener({ bundle, owner: { address: OWNER_0, path: owner.path }, quote, userOpHash: '0x' + 'ab'.repeat(32) });
  check('Kernel factory bundle → record started', (await getRecoveryRecord(M, ACCOUNT, store)) !== null);
  const s2 = memoryStore();
  await recoveryRecordListener(s2)({ bundle: kernelBundle(node, bundler, { accountType: 'kernel-7702' }), owner: { address: OWNER_0, path: owner.path }, quote: { sender: OWNER_0 }, userOpHash: '0x' + 'ab'.repeat(32) });
  check('EIP-7702 bundle → no record (no CREATE2 lineage; guardians cannot protect it)', (await loadRecoveryRecords(s2)).entries.length === 0);
  await recoveryRecordListener(s2)({ bundle: createAaClient({ nodeUrl: 'n', bundlerUrl: 'bundler', factory: '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985', chainId: CHAIN_ID, transportFor: () => node }), owner: { address: OWNER_0, path: owner.path }, quote: { sender: ACCOUNT }, userOpHash: '0x' + 'ab'.repeat(32) });
  check('SimpleAccount bundle → no record', (await loadRecoveryRecords(s2)).entries.length === 0);
  await recoveryRecordListener(s2)({ bundle: kernelBundle(node, bundler, { recoveredAccount: ACCOUNT }), owner: { address: OWNER_0, path: owner.path }, quote: { sender: ACCOUNT }, userOpHash: '0x' + 'ab'.repeat(32) });
  check('recovered-account bundle → no new record (it is attached with its own)', (await loadRecoveryRecords(s2)).entries.length === 0);
}

// ---------------------------------------------------------------------------
console.log('check-recovery: eligibility refusals');
// ---------------------------------------------------------------------------
{
  const bundler = fakeBundler();
  const deployed = fakeGuardianNode();
  deployed.add(ACCOUNT, { owner: OWNER_0 });
  const ok = await resolveGuardianAccount(kernelBundle(deployed, bundler), OWNER_0);
  check('deployed Kernel v3.3 account owned by this EOA → eligible, guardians not installed', ok.ok && ok.account === ACCOUNT && ok.kind === 'factory' && ok.state.validatorInitialized === false, JSON.stringify(ok, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const undeployed = await resolveGuardianAccount(kernelBundle(fakeGuardianNode(), bundler), OWNER_0);
  check('undeployed Kernel account → refusal', !undeployed.ok && undeployed.reason === GUARDIAN_UNDEPLOYED_REFUSAL);
  const simple = createAaClient({ nodeUrl: 'n', bundlerUrl: 'bundler', factory: '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985', chainId: CHAIN_ID, transportFor: (u) => (u.includes('bundler') ? bundler : deployed) });
  const s = await resolveGuardianAccount(simple, OWNER_0);
  check('SimpleAccount → refusal', !s.ok && s.reason === GUARDIAN_SIMPLE_REFUSAL);
  const delegated = fakeGuardianNode();
  delegated.add(OWNER_0, { code: '0xef0100' + KERNEL_V3_3.implementation.slice(2).toLowerCase(), owner: ZERO });
  const up = await resolveGuardianAccount(kernelBundle(delegated, bundler, { accountType: 'kernel-7702' }), OWNER_0);
  check('EIP-7702 upgrade → refusal with the engine text', !up.ok && up.reason === GUARDIAN_7702_REFUSAL);
  const engineErr = await caught(() => prepareGuardianInstall(delegated, { account: OWNER_0, set: set2of2() }));
  check('GUARDIAN_7702_REFUSAL is exactly the engine prepareGuardianInstall message', engineErr?.message === GUARDIAN_7702_REFUSAL, engineErr?.message);
  const foreign = fakeGuardianNode();
  foreign.add(ACCOUNT, { owner: newOwner.address });
  const recoveredBundle = kernelBundle(foreign, bundler, { recoveredAccount: ACCOUNT });
  const notOwner = await resolveGuardianAccount(recoveredBundle, OWNER_0);
  check('recovered-account bundle whose on-chain owner is someone else → engine refusal, nothing installed', !notOwner.ok && /is owned by/.test(notOwner.reason), notOwner.reason);
  const factoryForeign = await resolveGuardianAccount(kernelBundle(foreign, bundler), OWNER_0);
  check('factory account whose owner changed → not-owner refusal', !factoryForeign.ok && factoryForeign.reason === GUARDIAN_NOT_OWNER_REFUSAL);
}

// ---------------------------------------------------------------------------
console.log('check-recovery: guardian set form and engine refusals (verbatim)');
// ---------------------------------------------------------------------------
{
  const ctx = { account: ACCOUNT, owner: OWNER_0 };
  check('default delay is 48 h, never 0', DEFAULT_GUARDIAN_DELAY_SECONDS === 172_800 && DELAY_PRESETS.some((p) => p.seconds === 172_800 && /default/.test(p.label)));
  check('the 10-minute delay is offered on test networks only', delayPresetsFor(true).some((p) => p.seconds === 600) && !delayPresetsFor(false).some((p) => p.seconds === 600) && delayPresetsFor(false).every((p) => p.seconds === 0 || p.seconds >= 86_400));
  check('formatDuration(48 h) / (7 d)', formatDuration(172_800) === '48 h' && formatDuration(604_800) === '7 d' && formatDuration(3_900) === '1 h 5 min');
  const drafts = [
    { address: gA.address.toLowerCase(), label: 'Alice', weight: '1' },
    { address: gB.address, label: '', weight: '1' },
  ];
  const noAck = await caught(() => buildGuardianSet({ drafts, threshold: '2', delaySeconds: 0, noVetoAcknowledged: false }));
  check('delay 0 without the no-veto acknowledgement → refused', noAck?.message === NO_VETO_ACK_REQUIRED);
  const withAck = buildGuardianSet({ drafts, threshold: '2', delaySeconds: 0, noVetoAcknowledged: true });
  check('delay 0 with the acknowledgement → accepted', withAck.set.delaySeconds === 0);
  const built = buildGuardianSet({ drafts, threshold: '2', delaySeconds: DEFAULT_GUARDIAN_DELAY_SECONDS, noVetoAcknowledged: false });
  check('set built with EIP-55 addresses, labels kept by address', built.set.guardians[0].address === gA.address && built.labels[gA.address.toLowerCase()] === 'Alice' && built.set.delaySeconds === 172_800);
  const badAddr = await caught(() => buildGuardianSet({ drafts: [{ address: '0x123', label: '', weight: '1' }], threshold: '1', delaySeconds: 3600, noVetoAcknowledged: false }));
  check('malformed address → plain input error', badAddr && /^Guardian 1: /.test(badAddr.message));
  const v = (set) => validateGuardianSetForAccount(set, ctx);
  check('duplicate guardian → engine text', v({ guardians: [{ address: gA.address, weight: 1 }, { address: gA.address.toLowerCase(), weight: 1 }], threshold: 1, delaySeconds: 3600 }) === 'guardians[1] duplicates an earlier guardian');
  check('threshold above total → engine text', v({ guardians: [{ address: gA.address, weight: 1 }], threshold: 2, delaySeconds: 3600 }) === 'threshold 2 exceeds the total guardian weight 1; recovery would be impossible');
  check('owner as guardian → engine text', v({ guardians: [{ address: OWNER_0, weight: 1 }], threshold: 1, delaySeconds: 3600 }) === "guardians[0] is the account's current owner; the owner cannot also be a guardian");
  check('account as guardian → engine text', v({ guardians: [{ address: ACCOUNT, weight: 1 }], threshold: 1, delaySeconds: 3600 }) === 'guardians[0] is the account itself; an account cannot guard its own recovery');
  check('weight 0 → engine text', v({ guardians: [{ address: gA.address, weight: 0 }], threshold: 1, delaySeconds: 3600 }) === 'guardians[0].weight must be an integer from 1 to 16777215');
  check('threshold 0 → engine text', v({ guardians: [{ address: gA.address, weight: 1 }], threshold: 0, delaySeconds: 3600 }) === 'threshold must be a positive integer (0 would disable recovery)');
  check('valid set → null', v(set2of2()) === null);
}

// ---------------------------------------------------------------------------
console.log('check-recovery: the mandatory exposure warning');
check('copy: no developer file paths in the audit note shown to users', !/packages\/|\.ts\b|Engine notes/.test(GUARDIANS_AUDIT_NOTE));
check('copy: the trust lines do not point at a delay "below" (they render after the delay picker)', GUARDIANS_TRUST_LINES.every((l) => !/delay below|delay above/.test(l)) && GUARDIANS_TRUST_LINES.some((l) => /recovery delay protects only the change of owner/.test(l)));
// ---------------------------------------------------------------------------
{
  const two = describeGuardianExposure(set2of2(), (a) => (same(a, gA.address) ? 'Alice' : null));
  check('2-of-2 equal weights: ONE guardian can sign messages', two.exposure.signatureMinimumGuardians === 1 && two.exposure.singleGuardianCanSign && two.exposure.recoveryMinimumGuardians === 2);
  check('2-of-2 warning names the design-note facts (alone, immediately, no delay, no veto) and both guardians', /^ONE guardian alone can sign messages as this account immediately, with no delay and no veto/.test(two.signing) && two.signing.includes(`Alice (${gA.address})`) && two.signing.includes(gB.address));
  check('2-of-2: "fewer than the 2 guardians your threshold needs" sentence present', two.weaker !== null && two.weaker.startsWith('That is fewer than the 2 guardians'));
  check('2-of-2 recovery line: 2 guardians, veto within 48 h', two.recovery === 'Replacing your key needs 2 guardians (threshold 2 of total weight 2). They approve on-chain first; the change can execute 48 h later, and until it executes you can veto it from this wallet.', two.recovery);
  const five = { guardians: [gA, gB, gC, outsider, newOwner].map((g) => ({ address: g.address, weight: 1 })), threshold: 3, delaySeconds: 0 };
  const e5 = describeGuardianExposure(five);
  check('3-of-5 equal weights: 2 guardians can sign, recovery needs 3', e5.exposure.signatureMinimumGuardians === 2 && e5.exposure.recoveryMinimumGuardians === 3 && e5.soloSigners.length === 0);
  check('3-of-5 warning in the design-note wording', e5.signing === '2 guardians together — or one, if a guardian holds at least half the threshold weight — can sign messages as this account immediately, with no delay and no veto.', e5.signing);
  check('3-of-5 with no delay: "you cannot veto it"', e5.recovery.endsWith('With no delay this happens in one operation and you cannot veto it.'));
  const heavy = describeGuardianExposure({ guardians: [{ address: gA.address, weight: 2 }, { address: gB.address, weight: 1 }, { address: gC.address, weight: 1 }], threshold: 4, delaySeconds: 3600 });
  check('weights 2/1/1 threshold 4: the weight-2 guardian signs alone (2·2 ≥ 4), recovery needs 3', heavy.exposure.signatureMinimumGuardians === 1 && heavy.soloSigners.length === 1 && same(heavy.soloSigners[0].address, gA.address) && heavy.exposure.recoveryMinimumGuardians === 3);
}

// ---------------------------------------------------------------------------
console.log('check-recovery: install (owner-signed), record before submission');
// ---------------------------------------------------------------------------
let installedRecordStore;
{
  const node = fakeGuardianNode();
  node.add(ACCOUNT, { owner: OWNER_0 });
  const bundler = fakeBundler({ receipt: { success: true, receipt: { transactionHash: '0x' + 'cd'.repeat(32) } } });
  const bundle = kernelBundle(node, bundler);
  const store = memoryStore();
  installedRecordStore = store;
  await ensureFactoryKernelRecord({ chain: M, account: ACCOUNT, accountIndex: 0, owner: OWNER_0, ownerPath: owner.path, factory: KERNEL_V3_3.factory, implementation: KERNEL_V3_3.implementation, ecdsaValidator: VALIDATOR, store });
  const { set, labels } = buildGuardianSet({ drafts: [{ address: gA.address, label: 'Alice', weight: '1' }, { address: gB.address, label: 'Bob', weight: '1' }], threshold: '2', delaySeconds: DEFAULT_GUARDIAN_DELAY_SECONDS, noVetoAcknowledged: false });

  const before = node.calls.length;
  const invalid = await caught(() => prepareGuardianInstallQuote(bundle, OWNER_0, ACCOUNT, { ...set, threshold: 3 }, labels));
  check('invalid set refused with the engine text and ZERO network calls', invalid?.message === 'threshold 3 exceeds the total guardian weight 2; recovery would be impossible' && node.calls.length === before);
  const hazard = await caught(() => assertGuardianModulesSafe({ weightedEcdsaValidator: VALIDATOR, recoveryAction: RA }));
  check('finding (4): a guardian module equal to the owner validator is refused', hazard?.message === GUARDIAN_ROOT_VALIDATOR_HAZARD);

  const op = await prepareGuardianInstallQuote(bundle, OWNER_0, ACCOUNT, set, labels);
  const expected = guardianInstallCalls(ACCOUNT, set, { owner: OWNER_0 });
  check('install calls equal the engine guardianInstallCalls', op.calls.length === 2 && op.calls.every((c, i) => toHex(c.data) === toHex(expected[i].data) && c.to === expected[i].to));
  const estimated = decodeKernelExecute(bundler.lastEstimated.callData);
  const iface = new ethers.Interface(['function installModule(uint256 moduleType, address module, bytes initData)']);
  const first = iface.decodeFunctionData('installModule', estimated.calls[0].data);
  const second = iface.decodeFunctionData('installModule', estimated.calls[1].data);
  check('ethers decode: installModule(1, WeightedECDSAValidator) then installModule(3, RecoveryAction)', estimated.calls.length === 2 && first[0] === 1n && same(first[1], W) && second[0] === 3n && same(second[1], RA) && same(estimated.calls[0].to, ACCOUNT));
  check('ethers decode: the validator is NOT the owner validator (finding 4)', !same(first[1], VALIDATOR));
  const initData = ethers.getBytes(first[2]);
  const [validatorData, , selectorData] = abi.decode(['bytes', 'bytes', 'bytes'], ethers.hexlify(initData.slice(20)));
  const [gs, ws, threshold, delay] = abi.decode(['address[]', 'uint24[]', 'uint24', 'uint48'], validatorData);
  check('ethers decode: guardians descending, weights, threshold 2, delay 172800, only selector doRecovery', BigInt(gs[0]) > BigInt(gs[1]) && ws.every((w) => w === 1n) && threshold === 2n && delay === 172_800n && selectorData === KERNEL_RECOVERY_SELECTOR);

  // Submission: the record is written BEFORE submit; restored on refusal.
  let seenBySubmit = null;
  const refused = await caught(() =>
    submitGuardianOperation({
      operation: op,
      chain: M,
      store,
      submit: async () => {
        seenBySubmit = (await getRecoveryRecord(M, ACCOUNT, store)).metadata.guardians;
        throw new Error('RPC error -32500: bundler refused');
      },
    }),
  );
  check('record lists the guardians before the operation is submitted', seenBySubmit !== null && seenBySubmit.guardians.length === 2 && seenBySubmit.delaySeconds === 172_800);
  check('bundler refusal → error surfaced verbatim, previous record restored', refused?.message === 'RPC error -32500: bundler refused' && (await getRecoveryRecord(M, ACCOUNT, store)).metadata.guardians === null);
  const { userOpHash, entry } = await submitGuardianOperation({
    operation: op,
    chain: M,
    store,
    submit: (q) => sendAa(bundle, owner, q),
  });
  const sent = bundler.lastOp;
  const signer = ethers.verifyMessage(ethers.getBytes(toHex(getUserOpHash({ ...sent, nonce: BigInt(sent.nonce), callData: toBytes(sent.callData), callGasLimit: BigInt(sent.callGasLimit), verificationGasLimit: BigInt(sent.verificationGasLimit), preVerificationGas: BigInt(sent.preVerificationGas), maxFeePerGas: BigInt(sent.maxFeePerGas), maxPriorityFeePerGas: BigInt(sent.maxPriorityFeePerGas), signature: toBytes(sent.signature) }, ENTRYPOINT_V07, CHAIN_ID))), sent.signature);
  check('install op signed by the OWNER key (EIP-191 over the userOpHash, recovered by ethers)', same(signer, OWNER_0) && typeof userOpHash === 'string' && entry.metadata.guardians.guardians.some((g) => g.label === 'Alice'));
  node.get(ACCOUNT).guardians = set;
  const fin = await finalizeGuardianOperation({ bundle, userOpHash, chain: M, account: ACCOUNT, kind: 'install', store, timeoutMs: 1000, pollMs: 1 });
  const after = await getRecoveryRecord(M, ACCOUNT, store);
  check('after inclusion the chain matches the record; install tx recorded', fin.matches && fin.state.active && after.metadata.guardians.installTxHash === '0x' + 'cd'.repeat(32));
  const st = await readGuardianStatus(node, ACCOUNT, after);
  check('status: guardians read back from the chain, record verifies on-chain', st.state.set.guardians.length === 2 && st.state.set.delaySeconds === 172_800 && st.recordCheck.ok, JSON.stringify(st.recordCheck));
  const twice = await caught(() => prepareGuardianInstallQuote(bundle, OWNER_0, ACCOUNT, set, labels));
  check('installing again is refused by the engine (already configured)', twice && /Guardians are already configured/.test(twice.message));

  // Renew / remove / veto calldata equal to the engine's.
  const renewSet = { ...set, threshold: 1 };
  const renew = await prepareGuardianRenewQuote(bundle, OWNER_0, ACCOUNT, renewSet, labels);
  check('renew = the engine guardianRenewCall (to the validator)', renew.calls.length === 1 && same(renew.calls[0].to, W) && toHex(renew.calls[0].data) === toHex(guardianRenewCall(renewSet, { account: ACCOUNT, owner: OWNER_0 }).data));
  const remove = await prepareGuardianRemoveQuote(bundle, OWNER_0, ACCOUNT);
  check('remove = the engine guardianUninstallCalls', remove.calls.every((c, i) => toHex(c.data) === toHex(guardianUninstallCalls(ACCOUNT)[i].data)) && remove.calls.length === 3);
  const hash = '0x' + '5a'.repeat(32);
  node.get(ACCOUNT).proposals.set(hash, { status: 1, validAfter: 2_000_000_000, weight: 2 });
  const veto = await prepareVetoQuote(bundle, OWNER_0, ACCOUNT, hash);
  check('veto = the engine encodeVetoCall, root-signed from the account', veto.calls.length === 1 && toHex(veto.calls[0].data) === toHex(encodeVetoCall(hash).data) && same(veto.quote.sender, ACCOUNT));
  node.get(ACCOUNT).proposals.set(hash, { status: 3, validAfter: 0, weight: 2 });
  const noVeto = await caught(() => prepareVetoQuote(bundle, OWNER_0, ACCOUNT, hash));
  check('veto refused for an executed proposal', noVeto && /nothing to veto/.test(noVeto.message));

  // Watched proposals with countdown.
  node.get(ACCOUNT).proposals.set(hash, { status: 1, validAfter: 1_000_100, weight: 2 });
  const watched = await addWatchedProposal(M, ACCOUNT, hash, store, 1);
  const view = await readProposalView(node, ACCOUNT, watched.watched[0], 2, 1_000_000);
  check('watched proposal: approved, 100 s left, vetoable', view.canVeto && view.secondsUntilValid === 100 && /can execute in 1 min/.test(view.text), view.text);
  node.get(ACCOUNT).proposals.set(hash, { status: 2, validAfter: 1_000_100, weight: 2 });
  const vetoed = await readProposalView(node, ACCOUNT, watched.watched[0], 2, 1_000_000);
  check('after the veto: "can never execute", no Veto button', !vetoed.canVeto && /can never execute/.test(vetoed.text));

  // Reconciliation after an interrupted operation.
  node.get(ACCOUNT).guardians = null;
  const synced = await syncRecordGuardiansFromChain(node, M, ACCOUNT, store);
  check('sync from chain: guardians gone on-chain → record cleared', synced.metadata.guardians === null);
}

// ---------------------------------------------------------------------------
console.log('check-recovery: recovery on a new wallet (no delay)');
// ---------------------------------------------------------------------------
{
  const node = fakeGuardianNode();
  node.add(ACCOUNT, { owner: OWNER_0, guardians: set2of2(0) });
  const start = await prepareRecoveryStart(node, { chainId: CHAIN_ID, account: ACCOUNT.toLowerCase(), newOwner: newOwner.address });
  const nonce = guardianNonceKey() << 64n;
  const engineRequest = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: ACCOUNT, newOwner: newOwner.address, nonce, guardians: set2of2(0).guardians });
  check('request built from the chain equals the engine buildGuardianRecoveryRequest', start.kind === 'recoverable' && JSON.stringify(start.request) === JSON.stringify(engineRequest) && start.currentOwner === OWNER_0);
  check('doRecovery calldata equals the engine encodeRecoveryCallData', start.request.callData === toHex(encodeRecoveryCallData(newOwner.address)));
  const dec = new ethers.Interface(['function doRecovery(address validator, bytes data)']).decodeFunctionData('doRecovery', start.request.callData);
  check('ethers decode: doRecovery(ECDSA validator, 20-byte new owner)', same(dec[0], VALIDATOR) && same(dec[1], newOwner.address));

  // Refusals.
  const none = fakeGuardianNode();
  none.add(ACCOUNT, { owner: OWNER_0 });
  const noGuardians = await caught(() => prepareRecoveryStart(none, { chainId: CHAIN_ID, account: ACCOUNT, newOwner: newOwner.address }));
  check('no guardians installed → engine refusal', noGuardians && /has no active guardian recovery/.test(noGuardians.message), noGuardians?.message);
  const eoa = fakeGuardianNode();
  eoa.add(ACCOUNT, { code: '0xef0100' + KERNEL_V3_3.implementation.slice(2), owner: OWNER_0, guardians: set2of2(0) });
  const e7702 = await caught(() => prepareRecoveryStart(eoa, { chainId: CHAIN_ID, account: ACCOUNT, newOwner: newOwner.address }));
  check('EIP-7702 EOA → not recoverable', e7702 && /EIP-7702-delegated EOA/.test(e7702.message));
  const impl = fakeGuardianNode();
  impl.add(ACCOUNT, { owner: OWNER_0, guardians: set2of2(0), implementation: '0x' + '12'.repeat(20) });
  const eImpl = await caught(() => prepareRecoveryStart(impl, { chainId: CHAIN_ID, account: ACCOUNT, newOwner: newOwner.address }));
  check('foreign implementation → not recoverable', eImpl && /implementation is/.test(eImpl.message));
  const asGuardian = await caught(() => prepareRecoveryStart(node, { chainId: CHAIN_ID, account: ACCOUNT, newOwner: gA.address }));
  check('new owner = a guardian → engine refusal', asGuardian && /must not be one of the guardians/.test(asGuardian.message));
  const mine = await prepareRecoveryStart(node, { chainId: CHAIN_ID, account: ACCOUNT, newOwner: OWNER_0 });
  check('already the owner → "already-owner" (attach instead)', mine.kind === 'already-owner');

  // Payload round trip, QR, tampering.
  const payload = encodeRecoveryRequestPayload(start.request);
  const parsed = parseRecoveryRequestPayload(recoveryRequestShareText(start.request));
  check('request payload / share text parse back to the same request', JSON.stringify(parsed.request) === JSON.stringify(start.request) && parsed.approvals.length === 0);
  // Phase 10 copy check: the share text names the path that exists in the
  // app (SettingsScreen's "Guardians (social recovery)" section and its
  // "Approve a recovery (as a guardian)" button).
  const settingsSrc = readFileSync(new URL('../src/screens/SettingsScreen.tsx', import.meta.url), 'utf8');
  const shareText = recoveryRequestShareText(start.request);
  check('share text points to Settings → Guardians (social recovery) → Approve a recovery (as a guardian), which exists',
    shareText.includes('Settings → Guardians (social recovery) → Approve a recovery (as a guardian)') &&
      settingsSrc.includes('Guardians (social recovery)</Text>') &&
      /title="Approve a recovery \(as a guardian\)"[\s\S]{0,120}navigate\('ApproveRecovery'\)/.test(settingsSrc));
  const tampered = JSON.parse(payload);
  tampered.request.callData = tampered.request.callData.slice(0, -2) + 'ff';
  const tErr = await caught(() => parseRecoveryRequestPayload(JSON.stringify(tampered)));
  check('tampered request refused (engine re-derivation)', tErr && /callData does not match/.test(tErr.message), tErr?.message);
  const code = QRCode.create(payload, { errorCorrectionLevel: 'L' });
  const raster = rasterize(code.modules, 4, 4);
  check(`request QR round-trips through jsqr (v${code.version}, ECL L)`, jsQR(raster.rgba, raster.px, raster.px)?.data === payload);
  const big = 'x'.repeat(QR_MAX_BYTES);
  const bigCode = QRCode.create(big, { errorCorrectionLevel: 'L' });
  const bigRaster = rasterize(bigCode.modules, 3, 4);
  check(`QR_MAX_BYTES (${QR_MAX_BYTES}) fits one ECL-L code and decodes (v${bigCode.version})`, jsQR(bigRaster.rgba, bigRaster.px, bigRaster.px)?.data === big);
  const typed = JSON.parse(approvalTypedDataJson(start.request));
  const ethersDigest = ethers.TypedDataEncoder.hash(typed.domain, { Approve: typed.types.Approve }, typed.message);
  check('typed data for other wallets hashes (ethers) to the engine approval digest', ethersDigest === start.request.approvalDigest);

  // Guardian side: review and approve.
  const review = await reviewRecoveryRequest(node, { text: payload, activeChainId: CHAIN_ID, guardianAddress: gA.address });
  check('guardian review: A is a guardian, owner and proposal read from the chain', review.guardian?.address === gA.address && review.currentOwner === OWNER_0 && review.proposal.status === 'ongoing' && review.nonceMatches);
  const { signature: sigA, payload: approvalA } = signRecoveryApproval(gA, review);
  const recovered = ethers.verifyTypedData(typed.domain, { Approve: typed.types.Approve }, typed.message, toHex(sigA));
  check('guardian approval signature recovered by ethers (EIP-712) to the guardian', recovered === wA.address && same(recovered, gA.address));
  const outsiderReview = await reviewRecoveryRequest(node, { text: payload, activeChainId: CHAIN_ID, guardianAddress: outsider.address });
  const notGuardian = await caught(() => signRecoveryApproval(outsider, outsiderReview));
  check('a non-guardian cannot sign (nothing signed)', outsiderReview.guardian === null && notGuardian && /is not a guardian/.test(notGuardian.message));
  // A Sepolia request reviewed while the wallet is on mainnet: the
  // readiness gate refuses first (guardians are testnet-only).
  const wrongChain = await caught(() => reviewRecoveryRequest(node, { text: payload, activeChainId: 1n, guardianAddress: gA.address }));
  check('request for another chain refused (mainnet: by the readiness gate)', wrongChain && /only on test networks/.test(wrongChain.message), wrongChain?.message);
  const otherValidator = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: ACCOUNT, newOwner: newOwner.address, nonce, ecdsaValidator: W });
  const odd = await caught(() => reviewRecoveryRequest(node, { text: encodeRecoveryRequestPayload(otherValidator), activeChainId: CHAIN_ID, guardianAddress: gA.address }));
  check('request whose doRecovery targets a non-owner validator refused', odd?.message === REQUEST_NOT_ROOT_REFUSAL);

  // New wallet: collect approvals.
  let progress = {
    chain: M,
    ownerIndex: 9,
    newOwner: newOwner.address,
    account: ACCOUNT,
    request: start.request,
    set: start.set,
    approvals: [],
    approveTxHash: null,
    metadata: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const addA = addApprovalToProgress(progress, approvalA);
  check('approval payload verified (signer = guardian A) and added', addA.added && same(addA.guardian.address, gA.address));
  progress = addA.progress;
  check('the same guardian twice is ignored', addApprovalToProgress(progress, toHex(sigA)).added === false);
  const forged = toHex(signRecoveryApproval(gA, review).signature); // valid A sig
  const rawOutsider = outsider.sign(toBytes(start.request.approvalDigest));
  rawOutsider[64] += 27;
  const outsiderSig = toHex(rawOutsider);
  const eOut = await caught(() => addApprovalToProgress(progress, outsiderSig));
  check('approval from a non-guardian refused by verifyGuardianApproval', eOut && /who is not a guardian/.test(eOut.message), eOut?.message);
  const otherReq = buildGuardianRecoveryRequest({ chainId: CHAIN_ID, account: ACCOUNT, newOwner: gC.address, nonce, guardians: set2of2(0).guardians });
  const eOther = await caught(() => addApprovalToProgress(progress, JSON.stringify({ ...JSON.parse(approvalA), callDataAndNonceHash: otherReq.callDataAndNonceHash })));
  check('approval for a different proposal refused', eOther && /different proposal/.test(eOther.message));
  check('claimed guardian must match the signer', (await caught(() => addApprovalToProgress({ ...progress, approvals: [] }, JSON.stringify({ ...JSON.parse(approvalA), guardian: gB.address }))))?.message.includes('claims to be from'));
  void forged;
  const prog = recoveryApprovalProgress(progress);
  check('no delay: weight 1 of 2, guardian B can submit (its own weight completes it)', prog.weight === 1 && prog.possibleSubmitters.length === 1 && same(prog.possibleSubmitters[0].address, gB.address));
  const stage = await readRecoveryStage(node, progress, 1);
  check('stage: ready for a guardian to submit', stage.stage.kind === 'ready-to-submit');
  const noDelayApprove = await caught(() => prepareApproveWithSig(node, { progress, from: newOwner.address }));
  check('approveWithSig refused for a no-delay set (approvals ride in the operation)', noDelayApprove && /no delay/.test(noDelayApprove.message));

  // Persisted progress survives a reload.
  const pstore = memoryStore();
  await saveRecoveryProgress(progress, pstore);
  const reloaded = await getRecoveryProgress(M, newOwner.address, pstore);
  check('recovery in progress persists (request, set, approvals)', reloaded && reloaded.approvals.length === 1 && JSON.stringify(reloaded.request) === JSON.stringify(progress.request));

  // Guardian B submits the final operation.
  const bundler = fakeBundler();
  const subPayload = encodeRecoveryRequestPayload(progress.request, progress.approvals);
  const reviewB = await reviewRecoveryRequest(node, { text: subPayload, activeChainId: CHAIN_ID, guardianAddress: gB.address });
  check('submission payload carries A’s verified approval', reviewB.approvals.length === 1 && same(reviewB.approvals[0].guardian.address, gA.address) && reviewB.invalidApprovals.length === 0);
  const lone = await caught(() => prepareGuardianSubmission({ node, bundler, chainId: CHAIN_ID, request: progress.request, approvals: [], submitter: gB.address }));
  check('submitter alone below threshold → engine refusal verbatim', lone?.message === 'Approvals carry weight 1, below the threshold 2', lone?.message);
  const notG = await caught(() => prepareGuardianSubmission({ node, bundler, chainId: CHAIN_ID, request: progress.request, approvals: reviewB.approvals.map((a) => a.signature), submitter: outsider.address }));
  check('a non-guardian cannot submit', notG && /only a guardian can submit/.test(notG.message));
  const quote = await prepareGuardianSubmission({ node, bundler, chainId: CHAIN_ID, request: progress.request, approvals: reviewB.approvals.map((a) => a.signature), submitter: gB.address });
  const engineAssembled = assembleGuardianApprovals(progress.request, start.set, [sigA], gB.address);
  check('approvals assembly equals the engine assembleGuardianApprovals', quote.approvals.length === 1 && toHex(quote.approvals[0]) === toHex(engineAssembled.approvals[0]));
  const { userOpHash } = await submitGuardianRecovery({ quote, node, bundler, chainId: CHAIN_ID, signer: gB });
  const op = bundler.lastOp;
  check('recovery op: sender = account, nonce = the approved guardian-lane nonce, callData = doRecovery (engine)', same(op.sender, ACCOUNT) && BigInt(op.nonce) === nonce && op.callData === progress.request.callData && !op.factory);
  const sig = ethers.getBytes(op.signature);
  const engineOp = { sender: op.sender, nonce: BigInt(op.nonce), callData: toBytes(op.callData), callGasLimit: BigInt(op.callGasLimit), verificationGasLimit: BigInt(op.verificationGasLimit), preVerificationGas: BigInt(op.preVerificationGas), maxFeePerGas: BigInt(op.maxFeePerGas), maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas), signature: new Uint8Array(0) };
  const opHash = getUserOpHash(engineOp, ENTRYPOINT_V07, CHAIN_ID);
  check('op signature = A’s approval || B’s EIP-191 signature over the userOpHash (ethers)', sig.length === 130 && ethers.hexlify(sig.slice(0, 65)) === toHex(sigA) && same(ethers.verifyMessage(opHash, ethers.hexlify(sig.slice(65))), wB.address) && typeof userOpHash === 'string');
  check('guardian quote: the submitted worst case equals the displayed one (fees exact, deposit top-up headroom mirrored)',
    BigInt(op.maxFeePerGas) === quote.maxFeePerGas && BigInt(op.maxPriorityFeePerGas) === quote.maxPriorityFeePerGas &&
      BigInt(op.verificationGasLimit) === quote.verificationGasLimit &&
      (BigInt(op.callGasLimit) + BigInt(op.verificationGasLimit) + BigInt(op.preVerificationGas)) * BigInt(op.maxFeePerGas) === quote.fee,
    `${op.verificationGasLimit} vs ${quote.verificationGasLimit}`);
  const wrongSigner = await caught(() => submitGuardianRecovery({ quote, node, bundler, chainId: CHAIN_ID, signer: gA }));
  check('submission refuses a signer other than the quoted guardian', wrongSigner && /prepared for guardian/.test(wrongSigner.message));
  const sendsBefore = bundler.calls.filter((c) => c.method === 'eth_sendUserOperation').length;
  const resubmit = await caught(() => submitGuardianRecovery({ quote, node, bundler, chainId: CHAIN_ID, signer: gB }));
  check('the submitted guardian quote cannot be sent a second time (re-quote first)',
    resubmit?.message === AA_QUOTE_ALREADY_USED && bundler.calls.filter((c) => c.method === 'eth_sendUserOperation').length === sendsBefore, resubmit?.message);

  // After inclusion: attach only after the on-chain owner check.
  const aaStore = memoryStore();
  await aaStore.setItem('shiba-wallet.aa-config.v1', JSON.stringify({ [M]: { bundlerUrl: 'https://bundler.example', bundlerVerifiedAt: 'x', accountType: 'kernel-v3.3', factory: KERNEL_V3_3.factory, kernelValidator: VALIDATOR, factoryImplementation: KERNEL_V3_3.implementation } }));
  const meta = rebuildRecoveryRecord({ chainId: CHAIN_ID, account: ACCOUNT, originalOwner: OWNER_0, index: 0, recordedAt: 1 });
  const early = await caught(() => attachRecoveredAccount({ node, chain: M, account: ACCOUNT, owner: newOwner.address, ownerPath: newOwner.path, metadata: meta, store: aaStore, aaStore }));
  check('before the owner changed on-chain: NOT attached (verifyKernelAccountForOwner)', early && /^Not attached: owner is /.test(early.message) && (await getAaConfig(M, aaStore)).recoveredAccounts.length === 0, early?.message);
  node.get(ACCOUNT).owner = newOwner.address;
  node.get(ACCOUNT).guardianSeq = 1n;
  const bundleTx = '0x' + 'e1'.repeat(32);
  node.logs.push({ address: VALIDATOR, topics: [ethers.id('OwnerRegistered(address,address)'), pad32(ACCOUNT), pad32(newOwner.address)], transactionHash: bundleTx, blockNumber: '0x2700' });
  const stageDone = await readRecoveryStage(node, progress, 1);
  check('stage after inclusion: recovered', stageDone.stage.kind === 'recovered');
  const found = await findRecoveryTransaction(node, ACCOUNT, newOwner.address);
  check('the recovery transaction is found from the OwnerRegistered log', found?.txHash === bundleTx && found.blockNumber === String(0x2700));
  const attached = await attachRecoveredAccount({ node, chain: M, account: ACCOUNT, owner: newOwner.address, ownerPath: newOwner.path, metadata: meta, change: { txHash: found.txHash, userOpHash, blockNumber: found.blockNumber }, store: aaStore, aaStore });
  const cfg = await getAaConfig(M, aaStore);
  check('attached after the owner check; owner history appended (guardian-recovery, tx + userOpHash, path)', attached.historyUpdated && cfg.recoveredAccounts.length === 1 && cfg.recoveredAccounts[0].account === ACCOUNT && attached.entry.metadata.owners.length === 2 && attached.entry.metadata.owners[1].source === 'guardian-recovery' && attached.entry.metadata.owners[1].txHash === bundleTx && attached.entry.metadata.owners[1].derivationPath === "m/44'/60'/0'/0/9");
  check('the updated record verifies on-chain (owner + guardians)', (await verifyRecoveryMetadataOnChain(node, { ...attached.entry.metadata, guardians: { weightedEcdsaValidator: W, recoveryAction: RA, guardians: set2of2(0).guardians, threshold: 2, delaySeconds: 0, installTxHash: null } })).ok);
  const recBundle = createAaClientFromConfig(cfg, { nodeUrl: 'https://node.example', chainId: CHAIN_ID, accountIndex: 9, ownerAddress: newOwner.address, transportFor: (u) => (u.includes('bundler') ? fakeBundler() : node) });
  check('smart-account sends by the new owner use the recovered account (not its own CREATE2 address)', recBundle.recovered?.account === ACCOUNT && (await resolveAaSender(recBundle, newOwner.address)) === ACCOUNT && !same(predictKernelAddress(newOwner.address, { index: 9n }), ACCOUNT));
  const conflict = await caught(() => setAccountEip7702(M, newOwner.address, true, aaStore));
  check('an owner with a recovered account cannot also opt into the 7702 upgrade', conflict?.message === RECOVERED_7702_CONFLICT);
  const eligibleNow = await resolveGuardianAccount(recBundle, newOwner.address);
  check('the recovered account is eligible for the Guardians screen (kind recovered, guardians still installed)', eligibleNow.ok && eligibleNow.kind === 'recovered' && eligibleNow.state.active);
}

// ---------------------------------------------------------------------------
console.log('check-recovery: recovery with a delay (approveWithSig, countdown, final op)');
// ---------------------------------------------------------------------------
{
  const node = fakeGuardianNode();
  node.add(ACCOUNT, { owner: OWNER_0, guardians: set2of2(3600) });
  const start = await prepareRecoveryStart(node, { chainId: CHAIN_ID, account: ACCOUNT, newOwner: newOwner.address });
  let progress = { chain: M, ownerIndex: 9, newOwner: newOwner.address, account: ACCOUNT, request: start.request, set: start.set, approvals: [], approveTxHash: null, metadata: null, createdAt: 1, updatedAt: 1 };
  const review = await reviewRecoveryRequest(node, { text: encodeRecoveryRequestPayload(start.request), activeChainId: CHAIN_ID, guardianAddress: gA.address });
  progress = addApprovalToProgress(progress, signRecoveryApproval(gA, review).payload).progress;
  check('stage with weight 1 of 2: collecting', (await readRecoveryStage(node, progress, 1)).stage.kind === 'collecting');
  const short = await caught(() => prepareApproveWithSig(node, { progress, from: newOwner.address }));
  check('approveWithSig refused below the threshold', short && /below the threshold 2/.test(short.message));
  const reviewB = await reviewRecoveryRequest(node, { text: encodeRecoveryRequestPayload(start.request), activeChainId: CHAIN_ID, guardianAddress: gB.address });
  progress = addApprovalToProgress(progress, toHex(signRecoveryApproval(gB, reviewB).signature)).progress;
  check('stage with weight 2 of 2: ready to send the approvals on-chain', (await readRecoveryStage(node, progress, 1)).stage.kind === 'ready-to-approve');
  const wrongFrom = await caught(() => prepareApproveWithSig(node, { progress, from: OWNER_0 }));
  check('approveWithSig must come from the new owner account', wrongFrom && /becomes the new owner/.test(wrongFrom.message));
  const q = await prepareApproveWithSig(node, { progress, from: newOwner.address });
  const expectedCall = encodeApproveWithSig(start.request, progress.approvals.map((a) => toBytes(a)));
  check('approveWithSig calldata equals the engine encodeApproveWithSig', toHex(q.data) === toHex(expectedCall.data) && same(q.to, W) && q.gasLimit === 120_000n);
  const txid = await sendApproveWithSig(node, newOwner, q);
  const tx = ethers.Transaction.from(node.raw[node.raw.length - 1]);
  check('raw tx (ethers): from the NEW OWNER’s EOA, to the validator, 0 value, the approvals calldata', same(tx.from, newOwner.address) && same(tx.to, W) && tx.value === 0n && tx.data === toHex(expectedCall.data) && tx.chainId === CHAIN_ID && typeof txid === 'string');
  const wrongSigner = await caught(() => sendApproveWithSig(node, owner, q));
  check('approveWithSig signer must be the quoted EOA', wrongSigner && /Nothing was signed/.test(wrongSigner.message));
  node.get(ACCOUNT).proposals.set(start.request.callDataAndNonceHash.toLowerCase(), { status: 1, validAfter: 5_000, weight: 2 });
  const waiting = await readRecoveryStage(node, progress, 1_400);
  check('stage after approval: waiting with a countdown', waiting.stage.kind === 'waiting' && waiting.stage.secondsLeft === 3_600);
  const bundler = fakeBundler();
  const early = await caught(() => prepareGuardianSubmission({ node, bundler, chainId: CHAIN_ID, request: start.request, approvals: [], submitter: gA.address, now: 1_400 }));
  check('final op refused before the delay is over', early && /delay is not over/.test(early.message));
  check('stage after the delay: ready to submit', (await readRecoveryStage(node, progress, 5_000)).stage.kind === 'ready-to-submit');
  const quote = await prepareGuardianSubmission({ node, bundler, chainId: CHAIN_ID, request: start.request, approvals: progress.approvals.map((a) => toBytes(a)), submitter: gA.address, now: 5_000 });
  check('approved proposal: the operation carries NO approvals', quote.approvals.length === 0);
  await submitGuardianRecovery({ quote, node, bundler, chainId: CHAIN_ID, signer: gA });
  const op = bundler.lastOp;
  const engineOp = { sender: op.sender, nonce: BigInt(op.nonce), callData: toBytes(op.callData), callGasLimit: BigInt(op.callGasLimit), verificationGasLimit: BigInt(op.verificationGasLimit), preVerificationGas: BigInt(op.preVerificationGas), maxFeePerGas: BigInt(op.maxFeePerGas), maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas), signature: new Uint8Array(0) };
  check('final op signature: 65 bytes, the guardian’s EIP-191 signature over the userOpHash (ethers)', ethers.getBytes(op.signature).length === 65 && same(ethers.verifyMessage(getUserOpHash(engineOp, ENTRYPOINT_V07, CHAIN_ID), op.signature), wA.address));
  node.get(ACCOUNT).proposals.set(start.request.callDataAndNonceHash.toLowerCase(), { status: 2, validAfter: 5_000, weight: 2 });
  check('vetoed proposal → stage vetoed', (await readRecoveryStage(node, progress, 5_000)).stage.kind === 'vetoed');
  const restart = await prepareRecoveryStart(node, { chainId: CHAIN_ID, account: ACCOUNT, newOwner: newOwner.address });
  check('after a veto, a new request moves to the next guardian lane (parallel key 1): a fresh proposal id', restart.kind === 'recoverable' && BigInt(restart.request.nonce) >> 64n === guardianNonceKey(KERNEL_RECOVERY_MODULES, 1) && restart.request.callDataAndNonceHash !== start.request.callDataAndNonceHash);
  const lane1 = { ...progress, request: restart.request, approvals: [] };
  check('the new lane starts collecting (its own nonce, not the vetoed one)', (await readRecoveryStage(node, lane1, 5_000)).stage.kind === 'collecting');
  node.get(ACCOUNT).proposals.set(restart.request.callDataAndNonceHash.toLowerCase(), { status: 1, validAfter: 5_000, weight: 2 });
  const lane1Bundler = fakeBundler();
  const lane1Quote = await prepareGuardianSubmission({ node, bundler: lane1Bundler, chainId: CHAIN_ID, request: restart.request, approvals: [], submitter: gB.address, now: 6_000 });
  await submitGuardianRecovery({ quote: lane1Quote, node, bundler: lane1Bundler, chainId: CHAIN_ID, signer: gB });
  check('the final op on lane 1 carries the lane-1 nonce (engine spec routes the nonce read)', BigInt(lane1Bundler.lastOp.nonce) === BigInt(restart.request.nonce) && lane1Bundler.lastOp.callData === restart.request.callData);
  node.get(ACCOUNT).proposals.set(start.request.callDataAndNonceHash.toLowerCase(), { status: 0, validAfter: 0, weight: 0 });
  node.get(ACCOUNT).guardianSeq = 3n;
  check('guardian nonce moved → stage stale (approvals void)', (await readRecoveryStage(node, progress, 5_000)).stage.kind === 'stale');
}

// ---------------------------------------------------------------------------
console.log('check-recovery: a rebuilt record never replaces a richer one (phase 10 bug 2)');
// ---------------------------------------------------------------------------
{
  // The emulator run: Account 1 owned the Kernel account and its record
  // listed the guardians; the recovering side (Account 2, same device)
  // rebuilt a record from the original owner — with no guardians — and the
  // attach REPLACED Account 1's record, so both sides then reported
  // "guardians are configured on-chain but not in the record".
  const node = fakeGuardianNode();
  const chainSet = set2of2(600);
  node.add(ACCOUNT, { owner: OWNER_0, guardians: chainSet });
  const store = memoryStore();
  await store.setItem('shiba-wallet.aa-config.v1', JSON.stringify({ [M]: { bundlerUrl: 'https://bundler.example', bundlerVerifiedAt: 'x', accountType: 'kernel-v3.3', factory: KERNEL_V3_3.factory, kernelValidator: VALIDATOR, factoryImplementation: KERNEL_V3_3.implementation } }));
  const INSTALL_TX = '0x' + 'ab'.repeat(32);
  const created = await ensureFactoryKernelRecord({ chain: M, account: ACCOUNT, accountIndex: 0, owner: OWNER_0, ownerPath: owner.path, factory: KERNEL_V3_3.factory, implementation: KERNEL_V3_3.implementation, ecdsaValidator: VALIDATOR, store });
  const ownerSide = await saveRecoveryMetadata(
    {
      ...created.entry.metadata,
      guardians: { weightedEcdsaValidator: W, recoveryAction: RA, guardians: [{ address: gA.address, weight: 1, label: 'Alice' }, { address: gB.address, weight: 1, label: 'Bob' }], threshold: 2, delaySeconds: 600, installTxHash: INSTALL_TX },
    },
    store,
  );
  check('owner side: the record lists the labelled guardians and matches the chain', (await verifyRecoveryMetadataOnChain(node, ownerSide.metadata)).ok);
  const labelsOf = (m) => Object.fromEntries((m.guardians?.guardians ?? []).map((g) => [g.address.toLowerCase(), g.label ?? null]));

  // The rebuild itself.
  const plain = rebuildRecoveryRecord({ chainId: CHAIN_ID, account: ACCOUNT, originalOwner: OWNER_0, recordedAt: 2 });
  check('(the old input) a plain rebuild has no guardians', plain.guardians === null);
  const elsewhere = await rebuildRecoveryRecordFromChain({ node, chainId: CHAIN_ID, account: ACCOUNT, originalOwner: OWNER_0, recordedAt: 2, store: memoryStore() });
  check('rebuild on another device: the guardian set comes from the chain (no labels to know)', elsewhere.guardians?.guardians.length === 2 && elsewhere.guardians.threshold === 2 && elsewhere.guardians.delaySeconds === 600 && Object.values(labelsOf(elsewhere)).every((l) => l === null));
  check('…so it verifies on-chain instead of reporting guardians missing from the record', (await verifyRecoveryMetadataOnChain(node, elsewhere)).ok);
  const here = await rebuildRecoveryRecordFromChain({ node, chainId: CHAIN_ID, account: ACCOUNT, originalOwner: OWNER_0, recordedAt: 2, store });
  check('rebuild on the owner’s device: labels, install tx and the owner’s derivation path are kept', labelsOf(here)[gA.address.toLowerCase()] === 'Alice' && labelsOf(here)[gB.address.toLowerCase()] === 'Bob' && here.guardians.installTxHash === INSTALL_TX && here.owners[0].derivationPath === owner.path);
  check('a rebuild saves nothing by itself', JSON.stringify((await getRecoveryRecord(M, ACCOUNT, store)).metadata) === JSON.stringify(ownerSide.metadata));

  // The recovery completes; the recovering side attaches with the record
  // rebuilt elsewhere (the worst case: no labels).
  node.get(ACCOUNT).owner = newOwner.address;
  const RECOVERY_TX = '0x' + 'e2'.repeat(32);
  const attached = await attachRecoveredAccount({ node, chain: M, account: ACCOUNT, owner: newOwner.address, ownerPath: newOwner.path, metadata: elsewhere, change: { txHash: RECOVERY_TX, userOpHash: null, blockNumber: '100' }, store, aaStore: store });
  const after = (await getRecoveryRecord(M, ACCOUNT, store)).metadata;
  check('attach MERGED into the existing record: guardians and their labels kept, install tx kept', attached.historyUpdated && labelsOf(after)[gA.address.toLowerCase()] === 'Alice' && after.guardians.installTxHash === INSTALL_TX);
  check('…owner history appended (guardian recovery) with the original owner’s path kept', after.owners.length === 2 && after.owners[0].derivationPath === owner.path && after.owners[1].source === 'guardian-recovery' && same(after.owners[1].owner, newOwner.address) && after.owners[1].txHash === RECOVERY_TX);
  check('…and it verifies on-chain (no "guardians are configured on-chain but not in the record")', (await verifyRecoveryMetadataOnChain(node, after)).ok, JSON.stringify(await verifyRecoveryMetadataOnChain(node, after)));
  await attachRecoveredAccount({ node, chain: M, account: ACCOUNT, owner: newOwner.address, ownerPath: newOwner.path, metadata: plain, change: { txHash: RECOVERY_TX, userOpHash: null, blockNumber: '100' }, store, aaStore: store });
  const again = (await getRecoveryRecord(M, ACCOUNT, store)).metadata;
  check('attaching again with a plain rebuild changes nothing (no duplicate history, labels kept)', JSON.stringify(again) === JSON.stringify(after));

  // An imported backup never replaces a richer record either.
  const importNode = fakeGuardianNode();
  importNode.add(ACCOUNT, { owner: OWNER_0, guardians: chainSet });
  const importStore = memoryStore();
  await saveRecoveryMetadata(ownerSide.metadata, importStore);
  const review = await reviewRecordImport(importNode, recordExport(plain).json, [{ index: 0, address: OWNER_0, path: owner.path }]);
  const imported = await applyRecordImport({ node: importNode, review, store: importStore, aaStore: importStore });
  check('importing a thinner backup keeps the device’s labelled guardian record', !imported.attached && labelsOf(imported.entry.metadata)[gB.address.toLowerCase()] === 'Bob' && imported.entry.metadata.guardians.installTxHash === INSTALL_TX);

  // mergeRecoveryMetadata rules.
  const other = predictKernelAddress(OWNER_0, { index: 1n });
  const otherMeta = rebuildRecoveryRecord({ chainId: CHAIN_ID, account: other, originalOwner: OWNER_0, index: 1, recordedAt: 1 });
  check('merge refuses records of different accounts', /different accounts/.test((await caught(() => mergeRecoveryMetadata(ownerSide.metadata, otherMeta)))?.message ?? ''));
  const none = { validationInstalled: false, recoveryAllowed: false, recoveryRouted: false, validatorInitialized: false, set: null, active: false };
  check('the chain decides: no guardians on-chain → none in the merged record', mergeRecoveryMetadata(ownerSide.metadata, plain, { chainGuardians: none }).guardians === null);
  check('an unread chain keeps the recorded set (never guessed)', mergeRecoveryMetadata(ownerSide.metadata, plain, { chainGuardians: null }).guardians?.guardians.length === 2);
  const X = '0x' + '71'.repeat(20);
  const Y = '0x' + '72'.repeat(20);
  const withX = recordOwnerChange(plain, { owner: X, source: 'owner-rotation', txHash: '0x' + '01'.repeat(32), userOpHash: null, blockNumber: null, derivationPath: null, recordedAt: 3 });
  const withY = recordOwnerChange(plain, { owner: Y, source: 'owner-rotation', txHash: '0x' + '02'.repeat(32), userOpHash: null, blockNumber: null, derivationPath: null, recordedAt: 3 });
  check('diverged histories: the existing one is kept by default', same(mergeRecoveryMetadata(withX, withY).owners[1].owner, X));
  check('…unless only the incoming one ends at the owner read from the chain', same(mergeRecoveryMetadata(withX, withY, { currentOwner: Y }).owners[1].owner, Y));
  check('a longer incoming history extends a shorter existing one', mergeRecoveryMetadata(plain, withX).owners.length === 2);
}

// ---------------------------------------------------------------------------
console.log('check-recovery: the install result is read at the including block (phase 10 bug 3)');
// ---------------------------------------------------------------------------
{
  // The success screen said "does not match the chain yet" while the status
  // card read a moment later said "Matches the chain ✓": the receipt came
  // from the bundler's node, the read from the wallet's lagging RPC.
  const INCLUSION = 0x2000n;
  const pre = fakeGuardianNode();
  pre.add(ACCOUNT, { owner: OWNER_0 });
  const post = fakeGuardianNode();
  post.add(ACCOUNT, { owner: OWNER_0, guardians: set2of2() });
  const makeLagging = () => {
    let head = INCLUSION - 3n;
    let polls = 0;
    const t = async (method, params) => {
      if (method === 'eth_blockNumber') {
        polls += 1;
        if (polls > 2) head = INCLUSION + 1n;
        return '0x' + head.toString(16);
      }
      if (method === 'eth_call') {
        if (params[1] === 'latest') return pre(method, params); // a backend still behind
        if (BigInt(params[1]) > head) throw new Error('RPC error -32000: header not found');
        return post(method, [params[0], 'latest']);
      }
      return post(method, params);
    };
    t.polls = () => polls;
    return t;
  };
  const guardianRecord = { weightedEcdsaValidator: W, recoveryAction: RA, guardians: set2of2().guardians, threshold: 2, delaySeconds: DEFAULT_GUARDIAN_DELAY_SECONDS, installTxHash: null };
  const seedRecord = async () => {
    const st = memoryStore();
    const c = await ensureFactoryKernelRecord({ chain: M, account: ACCOUNT, accountIndex: 0, owner: OWNER_0, ownerPath: owner.path, factory: KERNEL_V3_3.factory, implementation: KERNEL_V3_3.implementation, ecdsaValidator: VALIDATOR, store: st });
    await saveRecoveryMetadata({ ...c.entry.metadata, guardians: guardianRecord }, st); // as written before submission
    return st;
  };
  const BUNDLE_TX = '0x' + 'cb'.repeat(32);
  const lagging = makeLagging();
  const st = await seedRecord();
  const withBlock = fakeBundler({ receipt: { success: true, receipt: { transactionHash: BUNDLE_TX, blockNumber: '0x' + INCLUSION.toString(16) } } });
  const fin = await finalizeGuardianOperation({ bundle: kernelBundle(lagging, withBlock), userOpHash: '0x' + 'aa'.repeat(32), chain: M, account: ACCOUNT, kind: 'install', store: st, timeoutMs: 1000, pollMs: 1 });
  check('after the receipt, the state is read at the including block: matches, guardians active, install tx recorded', fin.matches && fin.state.active && (await getRecoveryRecord(M, ACCOUNT, st)).metadata.guardians.installTxHash === BUNDLE_TX && lagging.polls() >= 3);
  const st2 = await seedRecord();
  const noBlock = fakeBundler({ receipt: { success: true, receipt: { transactionHash: BUNDLE_TX } } });
  const old = await finalizeGuardianOperation({ bundle: kernelBundle(makeLagging(), noBlock), userOpHash: '0x' + 'aa'.repeat(32), chain: M, account: ACCOUNT, kind: 'install', store: st2, timeoutMs: 1000, pollMs: 1 });
  check('control: a receipt without a block falls back to "latest" (the run’s symptom: no match)', !old.matches && !old.state.active);
  check('userOpReceiptBlock: nested (ERC-4337 shape), flattened, and junk → null', userOpReceiptBlock({ receipt: { blockNumber: '0x10' } }) === 16n && userOpReceiptBlock({ blockNumber: '0x11' }) === 17n && userOpReceiptBlock({ receipt: { blockNumber: 16 } }) === null && userOpReceiptBlock(null) === null && userOpReceiptBlock({ receipt: { blockNumber: '0xzz' } }) === null);
}

// ---------------------------------------------------------------------------
console.log('check-recovery: wipe (nothing on-chain) and the export offer');
// ---------------------------------------------------------------------------
{
  const node = fakeGuardianNode();
  const store = memoryStore();
  const meta = rebuildRecoveryRecord({ chainId: CHAIN_ID, account: ACCOUNT, originalOwner: OWNER_0, index: 0, recordedAt: 1 });
  await saveRecoveryMetadata(meta, store);
  await saveRecoveryProgress({ chain: M, ownerIndex: 9, newOwner: newOwner.address, account: null, request: null, set: null, approvals: [], approveTxHash: null, metadata: null, createdAt: 1, updatedAt: 1 }, store);
  await store.setItem('shiba-wallet.aa-config.v1', JSON.stringify({ [M]: { recoveredAccounts: [{ owner: newOwner.address, account: ACCOUNT, attachedAt: 'x' }] } }));
  const offer = exportAllRecordsText((await loadRecoveryRecords(store)).entries);
  check('before wiping, the export offer contains the record (parseable)', offer !== null && offer.includes(ACCOUNT) && parseRecordText(offer).account === ACCOUNT);
  const callsBefore = node.calls.length;
  const { recordsRemoved } = await wipeRecoveryData(store);
  check('wipe removes local records, recoveries in progress and attachments', recordsRemoved === 1 && (await loadRecoveryRecords(store)).entries.length === 0 && (await loadRecoveryProgressList(store)).length === 0 && (await getAaConfig(M, store)).recoveredAccounts.length === 0);
  check('wipe makes ZERO chain calls (nothing on-chain is removed)', node.calls.length === callsBefore);
  check('nothing to offer after the wipe', exportAllRecordsText([]) === null);
  void installedRecordStore;
}

// ---------------------------------------------------------------------------
console.log('check-recovery: WalletConnect never approves or submits a recovery');
// ---------------------------------------------------------------------------
{
  // WalletConnect parsing is not gated by the readiness table, and these
  // refusals must hold on mainnet too, so this section keeps chain 1.
  const WC_M = 'eip155:1';
  const ev = (method, params) => ({ id: 1, topic: 't', params: { chainId: WC_M, request: { method, params } } });
  const rej = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof WcRequestRejection ? e : null;
    }
  };
  // parseWcRequest below runs with its default (mainnet) chain; WalletConnect
  // parsing is not gated, so this request stays on chain 1.
  const request = buildGuardianRecoveryRequest({ chainId: 1n, account: ACCOUNT, newOwner: newOwner.address, nonce: guardianNonceKey() << 64n });
  const typed = JSON.parse(approvalTypedDataJson(request));
  const r1 = rej(() => parseWcRequest(ev('eth_signTypedData_v4', [gA.address, JSON.stringify(typed)]), gA.address));
  check('eth_signTypedData_v4 for a guardian Approve → refused', r1 && r1.message === GUARDIAN_WC_REFUSAL);
  const r2 = rej(() => parseWcRequest(ev('eth_sendTransaction', [{ from: gA.address, to: W, data: toHex(encodeApproveWithSig(request, [toBytes('0x' + '11'.repeat(65))]).data) }]), gA.address));
  check('eth_sendTransaction to the guardian validator → refused', r2 && r2.message === GUARDIAN_WC_REFUSAL);
  const r3 = rej(() => parseWcRequest(ev('eth_sendTransaction', [{ from: gA.address, to: ACCOUNT, data: request.callData }]), gA.address));
  check('eth_sendTransaction carrying doRecovery → refused', r3 && r3.message === GUARDIAN_WC_REFUSAL);
  const r4 = rej(() =>
    parseWcRequest(
      ev('wallet_sendCalls', [{ version: '2.0.0', from: ACCOUNT, chainId: '0x1', atomicRequired: true, calls: [{ to: RA, data: '0x' }] }]),
      ACCOUNT,
      WC_M,
      { smartAccount: { accountType: 'kernel-v3.3', signsMessages: true } },
    ),
  );
  check('wallet_sendCalls with a call to the RecoveryAction → refused', r4 && r4.message === GUARDIAN_WC_REFUSAL);
  const fine = parseWcRequest(ev('eth_sendTransaction', [{ from: gA.address, to: '0x000000000000000000000000000000000000dEaD', value: '0x1' }]), gA.address);
  check('an ordinary transaction still parses', fine.kind === 'transaction');
  check('kernelValidatorId sanity (guardian validation id is 0x01 || validator)', toHex(kernelValidatorId(W)).toLowerCase() === ('0x01' + W.slice(2)).toLowerCase());
}

// ---------------------------------------------------------------------------
console.log('check-recovery: record files (.json export / import)');
// ---------------------------------------------------------------------------
{
  const meta = rebuildRecoveryRecord({ chainId: 1n, account: ACCOUNT, originalOwner: OWNER_0, index: 0, recordedAt: 1_700_000_000 });
  const day = new Date(Date.UTC(2026, 9, 2, 23, 59, 59));
  const name = recordExportFileName(meta, day);
  check('file name: product, network, account short form, UTC date', name === 'shiba-recovery-record_ethereum_0xB67b-9a42_2026-10-02.json', name);
  check('file name matches the published pattern and uses only [A-Za-z0-9._-]', RECORD_FILE_NAME_PATTERN.test(name) && /^[A-Za-z0-9._-]+$/.test(name));
  const sepoliaMeta = rebuildRecoveryRecord({ chainId: 11155111n, account: ACCOUNT, originalOwner: OWNER_0, index: 0, recordedAt: 1 });
  check('file name on Sepolia says "sepolia"', recordExportFileName(sepoliaMeta, day) === 'shiba-recovery-record_sepolia_0xB67b-9a42_2026-10-02.json');
  const baseMeta = rebuildRecoveryRecord({ chainId: 8453n, account: ACCOUNT, originalOwner: OWNER_0, index: 0, recordedAt: 1 });
  const baseName = recordExportFileName(baseMeta, day);
  check('file name on another chain uses its CAIP-2 id without ":"', baseName === 'shiba-recovery-record_eip155-8453_0xB67b-9a42_2026-10-02.json' && RECORD_FILE_NAME_PATTERN.test(baseName), baseName);

  const contents = recordFileContents(meta);
  check('file contents are exactly the engine serializeRecoveryMetadata output (no header, no newline)', contents === serializeRecoveryMetadata(meta) && !contents.endsWith('\n'));
  const dir = mkdtempSync(join(tmpdir(), 'shiba-record-'));
  try {
    const path = join(dir, name);
    writeFileSync(path, contents, 'utf8');
    const bytes = readFileSync(path);
    check('bytes on disk equal the serializer output byte for byte', Buffer.compare(bytes, Buffer.from(serializeRecoveryMetadata(meta), 'utf8')) === 0);
    const read = parseRecordFile(bytes.toString('utf8'), { name, size: statSync(path).size, mimeType: RECORD_FILE_MIME_TYPE });
    check('file import parses back to an identical record', JSON.stringify(read.metadata) === JSON.stringify(meta));
    check('round trip is byte-exact: serialize(parse(file)) === file', serializeRecoveryMetadata(read.metadata) === bytes.toString('utf8'));
    check('the imported text is accepted by the EXISTING paste path (parseRecordText)', JSON.stringify(parseRecordText(read.text)) === JSON.stringify(meta));

    // A tampered file: refused by the engine's strict parser (same path as pasted text).
    const tampered = contents.replace(ACCOUNT, '0x' + ACCOUNT.slice(2, -1) + (ACCOUNT.endsWith('2') ? '3' : '2'));
    writeFileSync(path, tampered, 'utf8');
    const tErr = await caught(() => parseRecordFile(readFileSync(path, 'utf8'), { name, size: statSync(path).size }));
    check('tampered file (account changed) refused by the strict parser', tErr && /account does not match the deployment/.test(tErr.message), tErr?.message);
    const t2 = JSON.parse(contents);
    t2.owners.push({ owner: newOwner.address, source: 'owner-rotation', txHash: null, userOpHash: null, blockNumber: null, derivationPath: null, recordedAt: 2 });
    const t2Err = await caught(() => parseRecordFile(JSON.stringify(t2), { name }));
    check('tampered file (owner change without a hash) refused by the strict parser', t2Err && /must reference its transaction or UserOperation/.test(t2Err.message), t2Err?.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const wrongType = await caught(() => parseRecordFile(contents, { name: 'record.txt', mimeType: 'text/plain' }));
  check('a non-JSON file (name and type) is refused', wrongType && /\.json file/.test(wrongType.message));
  check('application/json with charset and no .json name is accepted', parseRecordFile(contents, { name: 'download', mimeType: 'application/json; charset=utf-8' }).metadata.account === ACCOUNT);
  check('a UTF-8 byte-order mark and surrounding whitespace are accepted', parseRecordFile('﻿\n' + contents + '\n', { name }).text === contents);
  const big = await caught(() => parseRecordFile(contents, { name, size: RECORD_FILE_MAX_BYTES + 1 }));
  check('a file above the size cap is refused before parsing', big && /larger than 64 KiB/.test(big.message));
  const bigText = await caught(() => parseRecordFile(contents + ' '.repeat(RECORD_FILE_MAX_BYTES), { name }));
  check('oversized text is refused even when the picker reports no size', bigText && /larger than/.test(bigText.message));
  const share = await caught(() => parseRecordFile(recordExport(meta).shareText, { name }));
  check('a share text (header + JSON) saved as .json is refused (one record and nothing else)', share && /exactly one JSON record/.test(share.message));
  const two = await caught(() => parseRecordFile(contents + contents, { name }));
  check('two records in one file are refused', two && /exactly one JSON record/.test(two.message));
  const garbage = await caught(() => parseRecordFile('{"version":1', { name }));
  check('truncated JSON is refused', garbage && /exactly one JSON record/.test(garbage.message));
}

// ---------------------------------------------------------------------------
console.log('check-recovery: owner rotation ("Change owner")');
// ---------------------------------------------------------------------------
{
  check('evmAccountPath(N) equals the core provider path m/44\'/60\'/0\'/0/N', evmAccountPath(9) === newOwner.path && evmAccountPath(0) === owner.path);
  const KERNEL_CONFIG = { bundlerUrl: 'https://bundler.example', bundlerVerifiedAt: 'x', accountType: 'kernel-v3.3', factory: KERNEL_V3_3.factory, kernelValidator: VALIDATOR, factoryImplementation: KERNEL_V3_3.implementation };
  const freshStores = async (extra = {}) => {
    const store = memoryStore();
    await store.setItem('shiba-wallet.aa-config.v1', JSON.stringify({ [M]: { ...KERNEL_CONFIG, ...extra } }));
    return store;
  };
  const W0 = { index: 0, name: 'Account 1', address: OWNER_0, path: owner.path };
  const W9 = { index: 9, name: 'Account 10', address: newOwner.address, path: newOwner.path };
  const walletOwners = [W0, W9];
  const rotateArgs = (store, config, extra = {}) => ({
    ownerAddress: OWNER_0,
    ownerIndex: 0,
    ownerPath: owner.path,
    newOwner: W9,
    walletOwners,
    removeGuardians: false,
    chain: M,
    config,
    store,
    ...extra,
  });

  // Local refusals (no network request).
  {
    const node = fakeGuardianNode();
    node.add(ACCOUNT, { owner: OWNER_0 });
    const bundler = fakeBundler();
    const bundle = kernelBundle(node, bundler);
    const store = await freshStores();
    const config = await getAaConfig(M, store);
    const before = node.calls.length;
    const foreign = await caught(() => prepareOwnerRotationQuote(bundle, rotateArgs(store, config, { newOwner: { index: 4, name: 'x', address: outsider.address, path: "m/44'/60'/0'/0/4" } })));
    check('a key outside this wallet is refused, zero network calls', foreign?.message === OWNER_ROTATION_FOREIGN_TARGET && node.calls.length === before, foreign?.message);
    const sameOwner = await caught(() => prepareOwnerRotationQuote(bundle, rotateArgs(store, config, { newOwner: W0 })));
    check('the current owner as the new owner is refused, zero network calls', sameOwner?.message === OWNER_ROTATION_SAME_OWNER && node.calls.length === before);
    const s7702 = await freshStores({ eip7702Owners: [newOwner.address] });
    const c7702 = await getAaConfig(M, s7702);
    const up = await caught(() => prepareOwnerRotationQuote(bundle, rotateArgs(s7702, c7702)));
    check('a new owner upgraded with EIP-7702 on this chain is refused, zero network calls', up?.message === OWNER_ROTATION_7702_TARGET && node.calls.length === before);
    const sLinked = await freshStores();
    await setRecoveredAccount(M, newOwner.address, '0x' + '12'.repeat(20), sLinked);
    const cLinked = await getAaConfig(M, sLinked);
    const linked = await caught(() => prepareOwnerRotationQuote(bundle, rotateArgs(sLinked, cLinked)));
    check('a new owner that already uses another recovered account is refused (after the account is known), nothing signed', linked?.message === ROTATION_TARGET_HAS_OTHER_ACCOUNT && bundler.lastOp === undefined, linked?.message);
    check('checkOwnerRotationTarget: an acceptable target → null', checkOwnerRotationTarget({ account: ACCOUNT, currentOwner: OWNER_0, newOwner: newOwner.address, walletOwners, guardians: null, config }) === null);
    check('checkOwnerRotationTarget: a guardian → refusal', checkOwnerRotationTarget({ account: ACCOUNT, currentOwner: OWNER_0, newOwner: newOwner.address, walletOwners, guardians: [{ address: newOwner.address, weight: 1 }], config }) === OWNER_ROTATION_GUARDIAN_TARGET);
  }

  // On-chain refusals.
  {
    const bundler = fakeBundler();
    const store = await freshStores();
    const config = await getAaConfig(M, store);
    const und = await caught(() => prepareOwnerRotationQuote(kernelBundle(fakeGuardianNode(), bundler), rotateArgs(store, config)));
    check('undeployed account → refusal worded for an owner change', und?.message === OWNER_ROTATION_UNDEPLOYED_REFUSAL, und?.message);
    const deployed = fakeGuardianNode();
    deployed.add(ACCOUNT, { owner: OWNER_0 });
    const simple = createAaClient({ nodeUrl: 'n', bundlerUrl: 'bundler', factory: '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985', chainId: CHAIN_ID, transportFor: (u) => (u.includes('bundler') ? bundler : deployed) });
    const sErr = await caught(() => prepareOwnerRotationQuote(simple, rotateArgs(store, config)));
    check('SimpleAccount → refusal', sErr?.message === OWNER_ROTATION_SIMPLE_REFUSAL);
    const delegated = fakeGuardianNode();
    delegated.add(OWNER_0, { code: '0xef0100' + KERNEL_V3_3.implementation.slice(2).toLowerCase(), owner: ZERO });
    const dErr = await caught(() => prepareOwnerRotationQuote(kernelBundle(delegated, bundler, { accountType: 'kernel-7702' }), rotateArgs(store, config)));
    check('EIP-7702 upgrade → refusal', dErr?.message === OWNER_ROTATION_7702_REFUSAL);
    const foreignOwned = fakeGuardianNode();
    foreignOwned.add(ACCOUNT, { owner: outsider.address });
    const fErr = await caught(() => prepareOwnerRotationQuote(kernelBundle(foreignOwned, bundler), rotateArgs(store, config)));
    check('account owned by someone else (foreign owner) → refusal', fErr?.message === OWNER_ROTATION_NOT_OWNER_REFUSAL);
    const recNode = fakeGuardianNode();
    recNode.add(ACCOUNT, { owner: newOwner.address });
    const noRec = await caught(() =>
      prepareOwnerRotationQuote(kernelBundle(recNode, bundler, { recoveredAccount: ACCOUNT }), rotateArgs(memoryStore(), config, { ownerAddress: newOwner.address, ownerIndex: 9, ownerPath: newOwner.path, newOwner: W0 })),
    );
    check('recovered account without a recovery record → refused (nothing signed)', noRec?.message === OWNER_ROTATION_NO_RECORD);
    const staleStore = await freshStores();
    await saveRecoveryMetadata(rebuildRecoveryRecord({ chainId: CHAIN_ID, account: ACCOUNT, originalOwner: OWNER_0, index: 0, recordedAt: 1 }), staleStore);
    const stale = await caught(() =>
      prepareOwnerRotationQuote(kernelBundle(recNode, bundler, { recoveredAccount: ACCOUNT }), rotateArgs(staleStore, config, { ownerAddress: newOwner.address, ownerIndex: 9, ownerPath: newOwner.path, newOwner: W0 })),
    );
    check('record whose latest owner is not the on-chain owner → refused', stale?.message === OWNER_ROTATION_RECORD_STALE);
    const noGuardians = await caught(() => prepareOwnerRotationQuote(kernelBundle(deployed, bundler), rotateArgs(store, config, { removeGuardians: true })));
    check('"also remove guardians" with none installed → refused', noGuardians?.message === OWNER_ROTATION_NO_GUARDIANS);
    const guarded = fakeGuardianNode();
    guarded.add(ACCOUNT, { owner: OWNER_0, guardians: { guardians: [{ address: newOwner.address, weight: 1 }, { address: gB.address, weight: 1 }], threshold: 2, delaySeconds: 3600 } });
    const gStore = await freshStores();
    const gErr = await caught(() => prepareOwnerRotationQuote(kernelBundle(guarded, bundler), rotateArgs(gStore, config)));
    check('a new owner that is a guardian on-chain → refused', gErr?.message === OWNER_ROTATION_GUARDIAN_TARGET);
  }

  // Deposit top-up headroom (live finding, 2026-10-02): the emulator's
  // "Change owner" was refused by Alchemy's bundler (Rundler) with -32502
  // "Simulation ran out of gas for entity: account" after its own estimate
  // passed, because Rundler estimates verification gas with zero fees (no
  // EntryPoint deposit top-up), while the real operation had to top up the
  // deposit during validation. Pins the submitted operation's shape: the
  // headroom (aa.ts AA_DEPOSIT_TOPUP_VERIFICATION_GAS) is on the signed
  // verificationGasLimit exactly when the deposit is below the prefund.
  check('the deposit top-up headroom is 40,000 verification gas', AA_DEPOSIT_TOPUP_VERIFICATION_GAS === 40_000n);
  for (const [label, deposit, expectHeadroom] of [
    ['deposit below the prefund (account tops up during validation)', 0n, true],
    ['deposit already covers the prefund', 10n ** 18n, false],
  ]) {
    const inner = fakeGuardianNode();
    inner.add(ACCOUNT, { owner: OWNER_0 });
    const depositReads = [];
    const node = async (method, params) => {
      if (method === 'eth_call' && same(params[0].to, ENTRYPOINT_V07) && params[0].data.startsWith(sel('balanceOf(address)'))) {
        const [who] = abi.decode(['address'], '0x' + params[0].data.slice(10));
        depositReads.push(who);
        return word(deposit);
      }
      return inner(method, params);
    };
    const bundler = fakeBundler();
    const bundle = kernelBundle(node, bundler);
    const store = await freshStores();
    const config = await getAaConfig(M, store);
    const rotation = await prepareOwnerRotationQuote(bundle, rotateArgs(store, config));
    const expectedVgl = 0x222n + (expectHeadroom ? AA_DEPOSIT_TOPUP_VERIFICATION_GAS : 0n);
    check(`${label}: quote verificationGasLimit ${expectedVgl}, worst-case fee includes it`,
      rotation.quote.verificationGasLimit === expectedVgl &&
      rotation.quote.fee === (0x111n + expectedVgl + 0x333n) * rotation.quote.maxFeePerGas);
    await submitOwnerRotation({ rotation, chain: M, store, submit: (q) => sendAa(bundle, owner, q) });
    const sentOp = fromRpc(bundler.lastOp);
    check(`${label}: SUBMITTED op has verificationGasLimit ${expectedVgl} (call 0x111, pre-verification 0x333 unchanged), signed by the current owner over that exact op`,
      sentOp.verificationGasLimit === expectedVgl && sentOp.callGasLimit === 0x111n && sentOp.preVerificationGas === 0x333n &&
      same(ethers.verifyMessage(getUserOpHash(sentOp, ENTRYPOINT_V07, CHAIN_ID), bundler.lastOp.signature), OWNER_0));
    check(`${label}: the deposit was read for the smart account itself (quote and send)`, depositReads.length === 2 && depositReads.every((a) => same(a, ACCOUNT)));
  }

  // The happy path: factory account → Account 10 (attachment needed), then back.
  {
    const node = fakeGuardianNode();
    node.add(ACCOUNT, { owner: OWNER_0 });
    const bundler = fakeBundler({ receipt: { success: true, receipt: { transactionHash: '0x' + 'ce'.repeat(32) } } });
    const bundle = kernelBundle(node, bundler);
    const store = await freshStores();
    const config = await getAaConfig(M, store);
    const rotation = await prepareOwnerRotationQuote(bundle, rotateArgs(store, config));
    const engineCalls = ownerRotationCalls(newOwner.address, { account: ACCOUNT, guardians: undefined });
    check('calls equal the engine ownerRotationCalls (the script’s plan without REMOVE_GUARDIANS)', rotation.calls.length === 2 && rotation.calls.every((c, i) => same(c.to, engineCalls[i].to) && c.value === 0n && toHex(c.data) === toHex(engineCalls[i].data)));
    const vIface = new ethers.Interface(['function onUninstall(bytes data)', 'function onInstall(bytes data)']);
    check('ethers encoding: onUninstall(0x) then onInstall(bytes20 new owner), both to the ECDSA validator',
      same(rotation.calls[0].to, VALIDATOR) && same(rotation.calls[1].to, VALIDATOR) &&
      toHex(rotation.calls[0].data) === vIface.encodeFunctionData('onUninstall', ['0x']) &&
      toHex(rotation.calls[1].data) === vIface.encodeFunctionData('onInstall', [newOwner.address.toLowerCase()]));
    const est = decodeKernelExecute(bundler.lastEstimated.callData);
    const decodedInstall = vIface.decodeFunctionData('onInstall', est.calls[1].data);
    check('the estimated operation (Kernel execute, ethers decode) carries exactly those two calls, sender = the account',
      est.calls.length === 2 && same(bundler.lastEstimated.sender, ACCOUNT) && same(est.calls[0].to, VALIDATOR) && same(decodedInstall[0], newOwner.address));
    check('quote facts: factory account, current owner, attachment needed, own smart account named', rotation.kind === 'factory' && rotation.currentOwner === OWNER_0 && rotation.attach === true && same(rotation.newOwnerOwnSmartAccount, predictKernelAddress(newOwner.address, { index: 9n })));
    check('the record was started for the factory account (CREATE2 lineage)', (await getRecoveryRecord(M, ACCOUNT, store))?.metadata.owners.length === 1);

    // Bundler refusal: verbatim error, record untouched.
    // (A quote can be submitted once; the refused attempt uses its own quote.)
    const refusedRotation = await prepareOwnerRotationQuote(bundle, rotateArgs(store, config));
    const refusedBundler = fakeBundler({ sendError: 'RPC error -32500: bundler refused' });
    const refused = await caught(() => submitOwnerRotation({ rotation: refusedRotation, chain: M, store, submit: (q) => sendAa(kernelBundle(node, refusedBundler), owner, q) }));
    check('bundler refusal → error verbatim, record unchanged', refused?.message === 'RPC error -32500: bundler refused' && (await getRecoveryRecord(M, ACCOUNT, store)).metadata.owners.length === 1);
    const resent = await caught(() => submitOwnerRotation({ rotation: refusedRotation, chain: M, store, submit: (q) => sendAa(bundle, owner, q) }));
    check('the refused quote cannot be sent again (the retry must re-quote), nothing submitted', resent?.message === AA_QUOTE_ALREADY_USED && (await getRecoveryRecord(M, ACCOUNT, store)).metadata.owners.length === 1);
    const tamperedQuote = { ...rotation, quote: { ...rotation.quote, calls: [rotation.calls[0]] } };
    const tq = await caught(() => submitOwnerRotation({ rotation: tamperedQuote, chain: M, store, submit: async () => ({ userOpHash: '0x' + '00'.repeat(32) }) }));
    check('a quote whose calls differ from the rotation is refused before signing', tq && /Nothing was signed/.test(tq.message));

    const sub = await submitOwnerRotation({ rotation, chain: M, store, submit: (q) => sendAa(bundle, owner, q), now: 1_800_000_000_000 });
    const op = fromRpc(bundler.lastOp);
    check('the operation is signed by the CURRENT owner key (EIP-191 over the userOpHash, ethers)', same(ethers.verifyMessage(getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID), bundler.lastOp.signature), OWNER_0));
    const tail = sub.entry.metadata.owners.at(-1);
    check('after acceptance the record lists the new owner: owner-rotation, userOpHash, no tx yet, BIP-32 path', sub.recordError === null && sub.entry.metadata.owners.length === 2 && tail.owner === newOwner.address && tail.source === 'owner-rotation' && tail.userOpHash === sub.userOpHash.toLowerCase() && tail.txHash === null && tail.derivationPath === "m/44'/60'/0'/0/9" && tail.recordedAt === 1_800_000_000);
    const pend = await listPendingOwnerRotations(M, walletOwners, store);
    check('the unsettled change is listed as pending (for resume after a restart)', pend.length === 1 && pend[0].account === ACCOUNT && pend[0].previousOwner === OWNER_0 && pend[0].newOwner.index === 9);

    // Not included yet: pending, nothing moved.
    const early = await finalizeOwnerRotation({ node, chain: M, account: ACCOUNT, previousOwner: OWNER_0, newOwner: W9, removeGuardians: false, userOpHash: sub.userOpHash, receipt: null, config, store });
    check('chain still shows the previous owner → pending, no attachment', early.state === 'pending' && (await getAaConfig(M, store)).recoveredAccounts.length === 0);

    // Included.
    node.get(ACCOUNT).owner = newOwner.address;
    const { outcome } = await waitAndFinalizeOwnerRotation({ bundle, rotation, userOpHash: sub.userOpHash, chain: M, previous: sub.previous, config, store, timeoutMs: 1000, pollMs: 1 });
    const after = await getRecoveryRecord(M, ACCOUNT, store);
    const afterTail = after.metadata.owners.at(-1);
    check('after inclusion: done, owner re-read on-chain, record verifies', outcome.state === 'done' && outcome.recordCheck.ok, JSON.stringify(outcome));
    check('owner history: the owner-rotation entry got the bundle tx hash and block 100', after.metadata.owners.length === 2 && afterTail.txHash === '0x' + 'ce'.repeat(32) && afterTail.blockNumber === '100' && afterTail.userOpHash === sub.userOpHash.toLowerCase());
    const cfg = await getAaConfig(M, store);
    check('attachment moved: Account 10 → the account; the previous owner has none', cfg.recoveredAccounts.length === 1 && same(cfg.recoveredAccounts[0].owner, newOwner.address) && same(cfg.recoveredAccounts[0].account, ACCOUNT));
    const recBundle = createAaClientFromConfig(cfg, { nodeUrl: 'https://node.example', chainId: CHAIN_ID, accountIndex: 9, ownerAddress: newOwner.address, transportFor: (u) => (u.includes('bundler') ? fakeBundler() : node) });
    check('smart-account sends by the new owner now use this account', (await resolveAaSender(recBundle, newOwner.address)) === ACCOUNT);
    check('nothing pending any more', (await listPendingOwnerRotations(M, walletOwners, store)).length === 0);
    const again = await finalizeOwnerRotation({ node, chain: M, account: ACCOUNT, previousOwner: OWNER_0, newOwner: W9, removeGuardians: false, userOpHash: sub.userOpHash, receipt: null, config, store });
    check('finalize is idempotent (no duplicate history entry, one attachment)', again.state === 'done' && (await getRecoveryRecord(M, ACCOUNT, store)).metadata.owners.length === 2 && (await getAaConfig(M, store)).recoveredAccounts.length === 1);
    const abandonLate = await caught(() => finalizeOwnerRotation({ node, chain: M, account: ACCOUNT, previousOwner: OWNER_0, newOwner: W9, removeGuardians: false, userOpHash: sub.userOpHash, config, store, abandon: true }));
    check('an included change cannot be "forgotten"', abandonLate && /cannot be abandoned/.test(abandonLate.message));

    // Rotate back to Account 1, whose own derivation yields the account: no attachment.
    const back = await prepareOwnerRotationQuote(recBundle, rotateArgs(store, cfg, { ownerAddress: newOwner.address, ownerIndex: 9, ownerPath: newOwner.path, newOwner: W0 }));
    check('rotating back: recovered kind, no attachment needed (Account 1 derives this address)', back.kind === 'recovered' && back.attach === false && back.newOwnerOwnSmartAccount === null);
    const backBundler = fakeBundler({ receipt: { success: true, receipt: { transactionHash: '0x' + 'cf'.repeat(32) } } });
    const backBundle = createAaClientFromConfig(cfg, { nodeUrl: 'https://node.example', chainId: CHAIN_ID, accountIndex: 9, ownerAddress: newOwner.address, transportFor: (u) => (u.includes('bundler') ? backBundler : node) });
    const back2 = await prepareOwnerRotationQuote(backBundle, rotateArgs(store, cfg, { ownerAddress: newOwner.address, ownerIndex: 9, ownerPath: newOwner.path, newOwner: W0 }));
    const backSub = await submitOwnerRotation({ rotation: back2, chain: M, store, submit: (q) => sendAa(backBundle, newOwner, q) });
    check('rotation back signed by the recovered account’s current owner (Account 10)', same(ethers.verifyMessage(getUserOpHash(fromRpc(backBundler.lastOp), ENTRYPOINT_V07, CHAIN_ID), backBundler.lastOp.signature), newOwner.address));
    node.get(ACCOUNT).owner = OWNER_0;
    const backOut = await waitAndFinalizeOwnerRotation({ bundle: backBundle, rotation: back2, userOpHash: backSub.userOpHash, chain: M, previous: backSub.previous, config: cfg, store, timeoutMs: 1000, pollMs: 1 });
    const hist = (await getRecoveryRecord(M, ACCOUNT, store)).metadata.owners;
    check('after rotating back: three owners (deployment, owner-rotation, owner-rotation), last = Account 1 with its path', backOut.outcome.state === 'done' && hist.length === 3 && hist.map((o) => o.source).join(',') === 'deployment,owner-rotation,owner-rotation' && hist[2].owner === OWNER_0 && hist[2].derivationPath === "m/44'/60'/0'/0/0");
    check('attachment removed: Account 1 uses the account through its own derivation', (await getAaConfig(M, store)).recoveredAccounts.length === 0);
  }

  // With guardians: removal mirrors the script's REMOVE_GUARDIANS plan; record cleared with the change.
  {
    const node = fakeGuardianNode();
    node.add(ACCOUNT, { owner: OWNER_0, guardians: set2of2() });
    const bundler = fakeBundler();
    const bundle = kernelBundle(node, bundler);
    const store = await freshStores();
    const config = await getAaConfig(M, store);
    const keep = await prepareOwnerRotationQuote(bundle, rotateArgs(store, config));
    check('guardians kept: only the two owner-validator calls', keep.calls.length === 2 && keep.guardians?.guardians.length === 2);
    const rotation = await prepareOwnerRotationQuote(bundle, rotateArgs(store, config, { removeGuardians: true }));
    const scriptPlan = [...ownerRotationCalls(newOwner.address, { account: ACCOUNT, guardians: set2of2().guardians }), ...guardianUninstallCalls(ACCOUNT)];
    check('with removal: calls equal the script plan (ownerRotationCalls + guardianUninstallCalls)', rotation.calls.length === 5 && rotation.calls.every((c, i) => same(c.to, scriptPlan[i].to) && toHex(c.data) === toHex(scriptPlan[i].data)));
    const withGuardians = await getRecoveryRecord(M, ACCOUNT, store);
    await saveRecoveryMetadata({ ...withGuardians.metadata, guardians: { weightedEcdsaValidator: W, recoveryAction: RA, guardians: set2of2().guardians, threshold: 2, delaySeconds: DEFAULT_GUARDIAN_DELAY_SECONDS, installTxHash: null } }, store);
    const sub = await submitOwnerRotation({ rotation, chain: M, store, submit: (q) => sendAa(bundle, owner, q) });
    check('record after acceptance: new owner and no guardians', sub.entry.metadata.guardians === null && sub.entry.metadata.owners.at(-1).owner === newOwner.address);

    // Reverted on-chain: the saved previous record comes back (guardians included).
    const failed = await finalizeOwnerRotation({ node, chain: M, account: ACCOUNT, previousOwner: OWNER_0, newOwner: W9, removeGuardians: true, userOpHash: sub.userOpHash, receipt: { success: false, txHash: '0x' + 'dd'.repeat(32) }, previous: sub.previous, config, store });
    const restored = await getRecoveryRecord(M, ACCOUNT, store);
    check('reverted operation → failed; previous record restored (one owner, guardians back)', failed.state === 'failed' && restored.metadata.owners.length === 1 && restored.metadata.guardians?.guardians.length === 2 && (await getAaConfig(M, store)).recoveredAccounts.length === 0);

    // Resume after a restart: no saved previous record; "forget" drops the tail and re-reads guardians.
    // A fresh quote: the first one was already submitted once.
    const rotationAgain = await prepareOwnerRotationQuote(bundle, rotateArgs(store, config, { removeGuardians: true }));
    const sub2 = await submitOwnerRotation({ rotation: rotationAgain, chain: M, store, submit: (q) => sendAa(bundle, owner, q) });
    const pend = await listPendingOwnerRotations(M, walletOwners, store);
    check('restart: the change is listed as pending', sub2.entry.metadata.owners.length === 2 && pend.length === 1);
    const forgot = await finalizeOwnerRotation({ node, chain: M, account: ACCOUNT, previousOwner: pend[0].previousOwner, newOwner: pend[0].newOwner, removeGuardians: false, userOpHash: pend[0].userOpHash, config, store, abandon: true });
    const afterForget = await getRecoveryRecord(M, ACCOUNT, store);
    check('forget while the chain shows the previous owner → tail dropped, guardians re-read from the chain', forgot.state === 'failed' && afterForget.metadata.owners.length === 1 && afterForget.metadata.guardians?.guardians.length === 2 && (await listPendingOwnerRotations(M, walletOwners, store)).length === 0);
  }

  // Unverified: the new owner shows on-chain but the account is not the pinned Kernel proxy.
  {
    const node = fakeGuardianNode();
    node.add(ACCOUNT, { owner: OWNER_0 });
    const bundle = kernelBundle(node, fakeBundler());
    const store = await freshStores();
    const config = await getAaConfig(M, store);
    const rotation = await prepareOwnerRotationQuote(bundle, rotateArgs(store, config));
    const sub = await submitOwnerRotation({ rotation, chain: M, store, submit: (q) => sendAa(bundle, owner, q) });
    node.get(ACCOUNT).owner = newOwner.address;
    node.get(ACCOUNT).implementation = '0x' + '77'.repeat(20);
    const out = await finalizeOwnerRotation({ node, chain: M, account: ACCOUNT, previousOwner: OWNER_0, newOwner: W9, removeGuardians: false, userOpHash: sub.userOpHash, config, store });
    check('ownership check fails → unverified, nothing attached', out.state === 'unverified' && out.problems.some((p) => /implementation is/.test(p)) && (await getAaConfig(M, store)).recoveredAccounts.length === 0);
    node.get(ACCOUNT).owner = outsider.address;
    const other = await finalizeOwnerRotation({ node, chain: M, account: ACCOUNT, previousOwner: OWNER_0, newOwner: W9, removeGuardians: false, userOpHash: sub.userOpHash, config, store });
    check('owned by neither → other-owner, nothing changed', other.state === 'other-owner' && same(other.owner, outsider.address));
  }
}

function fromRpc(op) {
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    callData: toBytes(op.callData),
    callGasLimit: BigInt(op.callGasLimit),
    verificationGasLimit: BigInt(op.verificationGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    maxFeePerGas: BigInt(op.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
    signature: new Uint8Array(0),
  };
}

function rasterize(modules, scale, quiet) {
  const size = modules.size;
  const px = (size + 2 * quiet) * scale;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const p = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4;
          rgba[p] = rgba[p + 1] = rgba[p + 2] = 0;
        }
      }
    }
  }
  return { rgba, px };
}

// ---------------------------------------------------------------------------
console.log('check-recovery: mainnet readiness gate (phase 9 item 6)');
// ---------------------------------------------------------------------------
{
  const node = fakeGuardianNode({ chainIdHex: '0x1' });
  const bundler = fakeBundler();
  const mainnet = createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: KERNEL_V3_3.factory,
    chainId: 1n,
    accountIndex: 0,
    accountType: 'kernel-v3.3',
    transportFor: (url) => (url.includes('bundler') ? bundler : node),
  });
  const gated = (e) => /only on test networks/.test(e?.message ?? '');
  const MAIN = 'eip155:1';
  const store = memoryStore();
  let submitted = false;
  const submit = async () => {
    submitted = true;
    return { userOpHash: '0x' + '00'.repeat(32) };
  };
  const results = [
    ['prepareGuardianInstallQuote', await caught(() => prepareGuardianInstallQuote(mainnet, OWNER_0, ACCOUNT, {}, {}))],
    ['prepareGuardianRenewQuote', await caught(() => prepareGuardianRenewQuote(mainnet, OWNER_0, ACCOUNT, {}, {}))],
    ['submitGuardianOperation (install)', await caught(() => submitGuardianOperation({ operation: { kind: 'install', calls: [], quote: { calls: [] } }, chain: MAIN, store, submit }))],
    ['prepareRecoveryStart', await caught(() => prepareRecoveryStart(node, { chainId: 1n, account: ACCOUNT, newOwner: newOwner.address }))],
    ['prepareApproveWithSig', await caught(() => prepareApproveWithSig(node, { progress: { chain: MAIN }, from: newOwner.address }))],
    ['sendApproveWithSig', await caught(() => sendApproveWithSig(node, newOwner, { chainId: 1n, from: newOwner.address }))],
    ['reviewRecoveryRequest', await caught(() => reviewRecoveryRequest(node, { text: '{}', activeChainId: 1n, guardianAddress: gA.address }))],
    ['signRecoveryApproval', await caught(() => Promise.resolve().then(() => signRecoveryApproval(gA, { request: { chainId: '1' }, guardian: { address: gA.address } })))],
    ['prepareGuardianSubmission', await caught(() => prepareGuardianSubmission({ node, bundler, chainId: 1n, request: {}, approvals: [], submitter: gA.address }))],
    ['submitGuardianRecovery', await caught(() => submitGuardianRecovery({ quote: { submitter: gA.address }, node, bundler, chainId: 1n, signer: gA }))],
    ['attachRecoveredAccount', await caught(() => attachRecoveredAccount({ node, chain: MAIN, account: ACCOUNT, owner: newOwner.address, ownerPath: null, metadata: null, store, aaStore: store }))],
    ['prepareOwnerRotationQuote', await caught(() => prepareOwnerRotationQuote(mainnet, { ownerAddress: OWNER_0, ownerIndex: 0, ownerPath: null, newOwner: { address: newOwner.address, index: 9, path: null }, walletOwners: [], removeGuardians: false, chain: MAIN, config: {}, store }))],
    ['submitOwnerRotation', await caught(() => submitOwnerRotation({ rotation: { calls: [], quote: { calls: [] } }, chain: MAIN, store, submit }))],
  ];
  for (const [name, e] of results) check(`mainnet ${name} refused with the readiness reason`, gated(e), e?.message);
  check('…with ZERO node or bundler calls, nothing stored and nothing submitted', node.calls.length === 0 && bundler.calls.length === 0 && store._map.size === 0 && !submitted, `${node.calls.length}/${bundler.calls.length}/${store._map.size}`);
  // Undo paths stay open on mainnet: removing guardians and vetoing are not
  // gated (whatever else they fail on with this bare fake, it is not the gate).
  const remove = await caught(() => prepareGuardianRemoveQuote(mainnet, OWNER_0, ACCOUNT));
  const veto = await caught(() => prepareVetoQuote(mainnet, OWNER_0, ACCOUNT, '0x' + '12'.repeat(32)));
  check('mainnet guardian removal and veto are NOT refused by the readiness gate', !gated(remove) && !gated(veto), `${remove?.message} / ${veto?.message}`);
}

console.log(`\ncheck-recovery: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

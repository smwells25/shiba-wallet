// Multi-signature accounts in the app (feature 24, phase 17 item 1), fully
// OFFLINE. It loads the exact app modules under Node's type stripping and
// checks, against a fake Sepolia node and a fake bundler (fakes-kernel.mjs):
//
//  - the create form's rules (buildMultisigConfig): checksum, duplicates,
//    the wallet's own signer, weights, threshold, the two-signer policy, and
//    the "this phone holds two keys" warning;
//  - the counterfactual address, pinned against the engine's
//    predictKernelMultisigAddress and an ethers CREATE2 computation, and the
//    CREATE2 index rule (0 unless this phone already holds the same set);
//  - the record store: create, reload, tampered records dropped (the address
//    is recomputed), a damaged list refusing writes, export / import round
//    trip and every import refusal;
//  - the request / approval round trip through the app glue, the
//    co-signer review, every approval refusal, the threshold-not-reached
//    refusal and the submitter-in-approvals refusal (app and engine);
//  - the full submit pipeline: the deploying operation submitted to the
//    fake bundler, with the co-signer approval and the final signature
//    RECOVERED BY ETHERS (EIP-712 Approve digest and EIP-191 userOpHash),
//    the factory data and call data decoded by ethers;
//  - the gate order: the device check before signWith, on both the submit
//    and the co-signer path; a cancelled check signs nothing;
//  - every refusal: WalletConnect / browser offer, ERC-1271, guardians /
//    sessions / passkeys / inheritance (createAaClientFromConfig), 7702 and
//    owner change wording, readiness gating on mainnet with zero requests,
//    and the account-id refusals of every derivation / salt / vault helper;
//  - the fixes for the 2026-10-10 emulator findings: the co-signer weight
//    bar, funding advice only on funding refusals (with a figure on AA21),
//    the multisig's own funding sentences, the deployment refresh, error
//    placement and the sentence period, the EntryPoint deposit, the own-
//    address set (risk card and success screen) and the exposure line seen
//    from this phone;
//  - mutation checks: the threshold, the submitter rule and the readiness
//    gate, and each of the fixes above, broken in a scratch copy, must be
//    caught.
//
// Every key is disposable: the public BIP-39 test mnemonic ("abandon ...
// about"). Nothing touches the network.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-multisig.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { evmAccountFromPrivateKey, evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  KERNEL_MULTISIG_VALIDATOR,
  KERNEL_V3_3,
  MULTISIG_ERC1271_REFUSAL,
  approveMultisigRequest,
  buildMultisigSigningRequest,
  encodeKernelMultisigInitialize,
  getUserOpHash,
  kernelProxyInitCodeHash,
  predictKernelMultisigAddress,
  selector,
  toHex,
} from '@shiba-wallet/chains-evm';
import {
  IMPORTED_ACCOUNT_ID_BASE,
  MAX_IMPORTED_SLOT,
  MAX_MULTISIG_SLOT,
  MAX_WATCH_ONLY_SLOT,
  MULTISIG_ACCOUNT_ID_BASE,
  MULTISIG_NO_DERIVATION,
  MULTISIG_NO_SMART_ACCOUNT,
  MULTISIG_SIGN_REFUSAL,
  WATCH_ONLY_ACCOUNT_ID_BASE,
  assertAccountCanSign,
  importedSlotOf,
  isImportedAccountId,
  isMultisigAccountId,
  isPhraseAccountId,
  isWatchOnlyAccountId,
  multisigAccountId,
  multisigSlotOf,
  smartAccountSaltFor,
  watchOnlySlotOf,
} from '../src/wallet/account-ids.ts';
import {
  MULTISIG_HIDE_REFUSAL,
  addAccount,
  derivationArgsFor,
  hideAccount,
  loadAccounts,
  reconcileMultisigAccounts,
  reconcileStoredMultisigAccounts,
} from '../src/wallet/accounts.ts';
import {
  AA_MULTISIG_FUNDING_TITLE,
  AaFeeRoseError,
  AaFundingError,
  MULTISIG_CONFIG_BUNDLE_REFUSAL,
  aaAccountTypeLabel,
  aaAccountTypeSignsMessages,
  aaReadinessBlock,
  aaSenderLabel,
  aaTypeFeatures,
  createAaClient,
  createAaClientFromConfig,
  createMultisigAaClient,
  getAaConfig,
  prepareAaCalls,
  sendAa,
  signHashAsSmartAccount,
} from '../src/wallet/aa.ts';
import {
  MULTISIG_ALLOWED_ROUTES,
  multisigRouteRefusal,
  walletConnectAddressFor,
  watchOnlyRouteRefusal,
} from '../src/wallet/watch-only.ts';
import {
  READINESS_TESTNET_HINT,
  featureReadiness,
  readinessRefusal,
} from '../src/config/readiness.ts';
import { EVM_PROFILES, MULTISIG_VERIFIED_NETWORKS, multisigNetworkVerified } from '../src/config/evm-chain.ts';
import {
  MULTISIG_ACCOUNT_PAYLOAD,
  MULTISIG_APPROVAL_PAYLOAD,
  MULTISIG_DEPLOYED_MATCH_NOTE,
  MULTISIG_DEPLOYED_NOT_VISIBLE_NOTE,
  MULTISIG_DEPLOYMENT,
  MULTISIG_DEPLOY_NOTE,
  MULTISIG_DEPOSIT_ROW_LABEL,
  MULTISIG_FEES_LINE,
  MULTISIG_FUND_AND_RETRY,
  MULTISIG_RECORDED_DEPLOY_COST_NOTE,
  MULTISIG_RECORDED_LATER_COST_NOTE,
  MULTISIG_FRESH_DEPLOY_NOTE,
  MULTISIG_REQUEST_PAYLOAD,
  MULTISIG_SINGLE_SIGNER_REFUSAL,
  MULTISIG_STORE_DAMAGED,
  MULTISIG_SUBMITTER_APPROVAL_REFUSAL,
  MULTISIG_UNAUDITED_NOTE,
  MULTISIG_FILE_MIME_TYPE,
  MULTISIG_FILE_NAME_PATTERN,
  MULTISIG_FILE_UTI,
  MULTISIG_QR_PART_MAX_BYTES,
  MULTISIG_QR_TOO_LARGE,
  MULTISIG_SCAN_APPROVAL_NOTE,
  MULTISIG_SCAN_APPROVAL_RATIONALE,
  MULTISIG_SCAN_APPROVAL_TITLE,
  MULTISIG_SCAN_NEXT_TITLE,
  MULTISIG_SCAN_RECORD_NOTE,
  MULTISIG_SCAN_RECORD_RATIONALE,
  MULTISIG_SCAN_RECORD_TITLE,
  MULTISIG_SCAN_REQUEST_NOTE,
  MULTISIG_SCAN_REQUEST_RATIONALE,
  MULTISIG_SCAN_REQUEST_TITLE,
  MULTISIG_SCAN_START_OVER_TITLE,
  MultisigAuthCancelledError,
  acceptMultisigQrScan,
  externalApprovalSignature,
  multisigApprovalTypedData,
  multisigFileContents,
  multisigFileRefusal,
  multisigQrPagedNote,
  multisigQrPartCaption,
  multisigQrProgressLine,
  multisigRequestShareText,
  splitMultisigQrParts,
  addMultisigApproval,
  asSentence,
  buildMultisigConfig,
  checkMultisigNetwork,
  chooseMultisigIndex,
  cosignWithGate,
  listMultisigCosignerApprovals,
  recordMultisigCosignerApproval,
  reviveCosignedEntry,
  multisigCosignedHistoryLine,
  multisigCosignedHistoryDetail,
  multisigPreviewNote,
  multisigRiskTarget,
  MULTISIG_PREVIEW_NOTE,
  MULTISIG_PREVIEW_UNDEPLOYED_NOTE,
  MAX_MULTISIG_COSIGNED_HISTORY,
  createMultisigRecord,
  describeMultisigCall,
  encodeMultisigApprovalPayload,
  encodeMultisigRequestPayload,
  exportMultisigAccount,
  importMultisigRecord,
  listMultisigRecords,
  multisigAddressFor,
  multisigChainNote,
  multisigConfigOf,
  multisigCosignerBarLabel,
  multisigDisplayName,
  multisigExportFileName,
  multisigExposureLine,
  multisigFeatureRefusal,
  multisigFileText,
  multisigFundingFigure,
  multisigFundsLine,
  multisigListEntries,
  MULTISIG_ACCOUNTS_HEADING,
  MULTISIG_ACCOUNTS_LIST_HINT,
  multisigAccountListLine,
  multisigLocalSignsLine,
  multisigNotReadyHint,
  multisigShapeLabel,
  multisigSubmitApprovalsLine,
  multisigSubmitErrorText,
  multisigThresholdNotReached,
  multisigWeightProgress,
  ownMultisigAddresses,
  parseMultisigAccountImport,
  parseMultisigRequestPayload,
  prepareMultisigRequest,
  prepareMultisigSubmission,
  readMultisigFunds,
  readMultisigOnChain,
  recordMultisigOutcome,
  refreshMultisigDeployment,
  refreshMultisigListDeployments,
  removeMultisigRecord,
  resetMultisigRecords,
  reviewMultisigRequestAsCosigner,
  saveMultisigOperation,
  submitMultisigWithGate,
} from '../src/wallet/multisig.ts';
import { USEROP_HASH, decodeKernelExecute, fakeBundler, fakeKernelNode, fromRpcOp, memoryStore } from './fakes-kernel.mjs';

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
function throwsWith(fn, includes) {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof Error && (includes === undefined || e.message.includes(includes));
  }
}
const isRefusal = (e) => e instanceof Error && e.name === 'FeatureNotAllowedError' && e.message.endsWith(READINESS_TESTNET_HINT);

const HERE = dirname(fileURLToPath(import.meta.url));
const MUTANT_DIR = join(HERE, `.mutants-multisig-${process.pid}`);
let mutants = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
/** A deliberately broken copy of an app module (relative imports rewritten to the real files). */
async function importMutant(relPath, from, to) {
  const original = readFileSync(join(HERE, '..', relPath), 'utf8');
  if (!original.includes(from)) throw new Error(`mutation anchor not found in ${relPath}: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(HERE, '..', relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutants += 1;
  const file = join(MUTANT_DIR, `m${mutants}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// Disposable keys, fakes
// ---------------------------------------------------------------------------
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(TEST_MNEMONIC);
const S0 = evmKeyProvider.deriveAccount(seed, 0, 0); // this wallet's Account 1 (the submitter)
const S5 = evmKeyProvider.deriveAccount(seed, 0, 5); // co-signer
const S6 = evmKeyProvider.deriveAccount(seed, 0, 6); // co-signer
const S7 = evmKeyProvider.deriveAccount(seed, 0, 7); // NOT a signer
const SEPOLIA = 'eip155:11155111';
const MAINNET = 'eip155:1';
const NODE_URL = 'https://node.example';
const BUNDLER_URL = 'https://bundler.example';
const RECIPIENT = ethers.getAddress('0x' + 'aa'.repeat(20));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const sel = (sig) => toHex(selector(sig));
const abi = ethers.AbiCoder.defaultAbiCoder();
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const pad32 = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const CONFIG_2_OF_3 = {
  signers: [
    { address: S0.address, weight: 1 },
    { address: S5.address, weight: 1 },
    { address: S6.address, weight: 1 },
  ],
  threshold: 2,
  delaySeconds: 0,
};
const DRAFT = { localSigner: S0.address, localWeight: '1', cosigners: [{ address: S5.address, weight: '1' }, { address: S6.address, weight: '1' }], threshold: '2' };

/**
 * Fake Sepolia node for a multisig: everything fakes-kernel's node serves,
 * plus KernelFactory.getAddress for a MULTISIG initData (computed with
 * ethers: salt = keccak256(initData || bytes32 index), CREATE2 over the
 * engine's proxy init-code hash), EntryPoint.getNonce, and — when the
 * account is deployed — Kernel rootValidator() and the weighted validator's
 * weightedStorage / guardian list for `onChainSet`.
 */
function multisigNode({ deployed = new Set(), nonce = 0n, onChainSet = CONFIG_2_OF_3, rootIsWeighted = true, balance = 10n ** 18n, counter = null } = {}) {
  const base = fakeKernelNode({ chainIdHex: '0xaa36a7', codeAt: { [KERNEL_MULTISIG_VALIDATOR.toLowerCase()]: true }, deployedAccounts: deployed, balance });
  const sorted = [...onChainSet.signers].sort((a, b) => (BigInt(b.address) > BigInt(a.address) ? 1 : -1));
  const transport = async (method, params) => {
    if (counter) counter.n += 1;
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      if (same(to, KERNEL_V3_3.factory) && data.startsWith(sel('getAddress(bytes,bytes32)'))) {
        const [initData, salt] = abi.decode(['bytes', 'bytes32'], '0x' + data.slice(10));
        const create2Salt = ethers.keccak256(ethers.concat([initData, salt]));
        return pad32(ethers.getCreate2Address(KERNEL_V3_3.factory, create2Salt, toHex(kernelProxyInitCodeHash(KERNEL_V3_3.implementation))));
      }
      if (same(to, ENTRYPOINT_V07) && data.startsWith(sel('getNonce(address,uint192)'))) return word(nonce);
      if (data.startsWith(sel('rootValidator()'))) {
        const v = rootIsWeighted ? KERNEL_MULTISIG_VALIDATOR : KERNEL_V3_3.ecdsaValidator;
        return '0x01' + v.slice(2).toLowerCase() + '0'.repeat(22);
      }
      if (same(to, KERNEL_MULTISIG_VALIDATOR) && data.startsWith(sel('weightedStorage(address)'))) {
        const total = onChainSet.signers.reduce((s, x) => s + x.weight, 0);
        return word(total) + word(onChainSet.threshold).slice(2) + word(0).slice(2) + pad32(sorted[0].address).slice(2);
      }
      if (same(to, KERNEL_MULTISIG_VALIDATOR) && data.startsWith(sel('guardian(address,address)'))) {
        const signer = ethers.getAddress('0x' + data.slice(34, 74));
        const i = sorted.findIndex((s) => same(s.address, signer));
        const next = i + 1 < sorted.length ? sorted[i + 1].address : '0x' + 'ff'.repeat(20);
        return word(sorted[i].weight) + pad32(next).slice(2);
      }
    }
    return base(method, params);
  };
  transport.calls = base.calls;
  return transport;
}
const transportsFor = (node, bundler) => (url) => (url === NODE_URL ? node : bundler);
const signWithAs = (account, log) => async (chainId, expect, fn) => {
  log.push(`signWith:${expect}`);
  if (!same(account.address, expect)) throw new Error('signWith: active account changed');
  return fn(account);
};
const authOk = (log) => async (prompt) => {
  log.push(`auth:${prompt}`);
  return { ok: true };
};
const authCancel = (log) => async (prompt) => {
  log.push(`auth:${prompt}`);
  return { ok: false, message: 'Authentication cancelled.' };
};
const OWN = [
  { name: 'Account 1', address: S0.address, kind: 'phrase' },
];

// ===========================================================================
console.log('check-multisig: account ids (a new range every helper refuses)');
// ===========================================================================
{
  const M0 = multisigAccountId(0);
  check('the multisig range starts at 0xD0000000 and stays a safe integer below 2^32', MULTISIG_ACCOUNT_ID_BASE === 0xd0000000 && M0 === 0xd0000000 && multisigAccountId(MAX_MULTISIG_SLOT) < 2 ** 32);
  check('disjoint from the phrase, imported and watch-only ranges',
    MULTISIG_ACCOUNT_ID_BASE > WATCH_ONLY_ACCOUNT_ID_BASE + MAX_WATCH_ONLY_SLOT && WATCH_ONLY_ACCOUNT_ID_BASE > IMPORTED_ACCOUNT_ID_BASE + MAX_IMPORTED_SLOT &&
      !isPhraseAccountId(M0) && !isImportedAccountId(M0) && !isWatchOnlyAccountId(M0) && isMultisigAccountId(M0) &&
      !isMultisigAccountId(0) && !isMultisigAccountId(IMPORTED_ACCOUNT_ID_BASE) && !isMultisigAccountId(WATCH_ONLY_ACCOUNT_ID_BASE) &&
      !isMultisigAccountId(MULTISIG_ACCOUNT_ID_BASE + MAX_MULTISIG_SLOT + 1));
  check('slot round trip; malformed slots refused', multisigSlotOf(multisigAccountId(7)) === 7 && throwsWith(() => multisigAccountId(-1)) && throwsWith(() => multisigAccountId(MAX_MULTISIG_SLOT + 1)) && throwsWith(() => multisigSlotOf(5)));
  check('derivationArgsFor refuses a multisig id on every chain (plain sentence)',
    ['eip155:1', 'bip122:000000000019d6689c085ae165831e93', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'].every((c) => throwsWith(() => derivationArgsFor(c, M0), MULTISIG_NO_DERIVATION)));
  check('smartAccountSaltFor refuses a multisig id', throwsWith(() => smartAccountSaltFor(M0), MULTISIG_NO_SMART_ACCOUNT));
  check('assertAccountCanSign refuses a multisig id (signWith calls it FIRST, before any secure-store read)', throwsWith(() => assertAccountCanSign(M0), MULTISIG_SIGN_REFUSAL));
  check('the imported-key and watch-only slot helpers refuse a multisig id', throwsWith(() => importedSlotOf(M0)) && throwsWith(() => watchOnlySlotOf(M0)));
  const ctxSrc = readFileSync(join(HERE, '..', 'src', 'wallet', 'WalletContext.tsx'), 'utf8');
  const sw = ctxSrc.slice(ctxSrc.indexOf('const signWith = useCallback('));
  check('WalletContext.signWith still opens with assertAccountCanSign(activeIndexRef.current) (source pin)', /\{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*assertAccountCanSign\(activeIndexRef\.current\);/.test(sw.slice(0, 1200)));
  check('createAaClient refuses a multisig id (no salt) and the multisig type', throwsWith(() => createAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, factory: KERNEL_V3_3.factory, accountType: 'kernel-v3.3', accountIndex: M0, transportFor: () => async () => '0x' }), MULTISIG_NO_SMART_ACCOUNT) &&
    throwsWith(() => createAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, factory: KERNEL_V3_3.factory, accountType: 'kernel-multisig', transportFor: () => async () => '0x' }), 'createMultisigAaClient'));

  // The account store: a multisig entry kind, reconciled from the multisig store.
  const store = memoryStore();
  const recs = [{ id: M0, address: ethers.getAddress('0x' + '12'.repeat(20)), name: 'Multisig 1' }];
  const r1 = reconcileMultisigAccounts(await loadAccounts(store), recs);
  check('reconcile adds the entry (multisig, never hidden, its address)', r1.changed && r1.state.accounts.some((a) => a.index === M0 && a.multisig === true && a.hidden === false && a.address === recs[0].address));
  await reconcileStoredMultisigAccounts(recs, store);
  const loaded = await loadAccounts(store);
  check('…persisted and revived', loaded.accounts.some((a) => a.index === M0 && a.multisig));
  check('…does not move nextIndex ("Add account" still takes index 1)', loaded.nextIndex === 1 && (await addAccount(null, store)).account.index === 1);
  check('…cannot be hidden', (await caught(() => hideAccount(M0, store)))?.message === MULTISIG_HIDE_REFUSAL);
  const r2 = reconcileMultisigAccounts({ ...loaded, activeIndex: M0 }, []);
  check('reconcile drops an entry whose record is gone (Account 1 becomes active)', r2.changed && !r2.state.accounts.some((a) => a.multisig) && r2.state.activeIndex === 0);
  check('reconcile with an unreadable multisig list (null) changes nothing', reconcileMultisigAccounts(loaded, null).changed === false);
  const tampered = memoryStore();
  tampered._map.set('shiba-wallet.accounts.v1', JSON.stringify({ version: 1, activeIndex: 0, nextIndex: 1, accounts: [
    { index: 0, name: 'Account 1', hidden: false },
    { index: M0, name: 'M', hidden: false, multisig: true, address: 'not an address' },
    { index: 5, name: 'X', hidden: false, multisig: true, address: recs[0].address },
    { index: M0 + 1, name: 'Y', hidden: false, multisig: true, watchOnly: true, address: recs[0].address },
  ] }));
  check('tampered multisig entries are dropped (bad address, id outside the range, two kinds at once)', !(await loadAccounts(tampered)).accounts.some((a) => a.multisig));
}

// ===========================================================================
console.log('check-multisig: the create form (buildMultisigConfig)');
// ===========================================================================
{
  const ok = buildMultisigConfig(DRAFT, OWN);
  check('a 2-of-3 with this wallet’s signer and two co-signers is accepted, delay 0', ok.ok && ok.config.signers.length === 3 && ok.config.threshold === 2 && ok.config.delaySeconds === 0 && ok.warnings.length === 0);
  const lower = buildMultisigConfig({ ...DRAFT, cosigners: [{ address: S5.address.toLowerCase(), weight: '1' }, DRAFT.cosigners[1]] }, OWN);
  check('an all-lowercase address is accepted and stored in EIP-55 form', lower.ok && lower.config.signers[1].address === S5.address);
  const badSum = S5.address.slice(0, 2) + S5.address.slice(2, 3).toLowerCase() === S5.address.slice(0, 3) ? S5.address.replace(/[a-f]/, (c) => c.toUpperCase()) : S5.address.replace(/[A-F]/, (c) => c.toLowerCase());
  const cases = [
    ['no co-signer', { ...DRAFT, cosigners: [] }, 'at least one co-signer'],
    ['ten co-signers', { ...DRAFT, cosigners: Array.from({ length: 10 }, (_, i) => ({ address: ethers.getAddress('0x' + (i + 1).toString(16).padStart(40, '0')), weight: '1' })) }, 'At most 9'],
    ['a wrong checksum', { ...DRAFT, cosigners: [{ address: badSum, weight: '1' }, DRAFT.cosigners[1]] }, 'Co-signer 1'],
    ['an empty address', { ...DRAFT, cosigners: [{ address: ' ', weight: '1' }] }, 'enter the co-signer'],
    ['the wallet’s own signer as a co-signer', { ...DRAFT, cosigners: [{ address: S0.address, weight: '1' }] }, 'own signer'],
    ['a repeated co-signer', { ...DRAFT, cosigners: [DRAFT.cosigners[0], { address: S5.address.toLowerCase(), weight: '1' }] }, 'repeats'],
    ['weight 0', { ...DRAFT, cosigners: [{ address: S5.address, weight: '0' }, DRAFT.cosigners[1]] }, 'weight must be'],
    ['weight 101', { ...DRAFT, localWeight: '101' }, 'weight must be'],
    ['threshold 0', { ...DRAFT, threshold: '0' }, 'threshold'],
    ['threshold above the total', { ...DRAFT, threshold: '4' }, 'exceeds the total'],
    ['threshold 1 (one signer could act)', { ...DRAFT, threshold: '1' }, MULTISIG_SINGLE_SIGNER_REFUSAL],
    ['a heavy signer reaching the threshold alone', { ...DRAFT, localWeight: '3', threshold: '3' }, MULTISIG_SINGLE_SIGNER_REFUSAL],
  ];
  for (const [name, draft, expect] of cases) {
    const r = buildMultisigConfig(draft, OWN);
    check(`refused: ${name}`, !r.ok && r.error.includes(expect), r.ok ? 'accepted' : r.error);
  }
  const warn = buildMultisigConfig(DRAFT, [...OWN, { name: 'Account 6', address: S5.address, kind: 'phrase' }]);
  check('a co-signer that is another account of this wallet is allowed but warned about', warn.ok && warn.warnings.length === 1 && warn.warnings[0].includes('Account 6') && warn.warnings[0].includes('two of the keys'));
  check('shape labels: "2-of-3" for equal weights, weighted otherwise', multisigShapeLabel(CONFIG_2_OF_3) === '2-of-3' && multisigShapeLabel({ signers: [{ weight: 2 }, { weight: 1 }, { weight: 1 }], threshold: 3 }) === 'weight 3 of 4, 3 signers' && multisigShapeLabel({ signers: [{ weight: 2 }, { weight: 2 }], threshold: 4 }) === '2-of-2');
}

// ===========================================================================
console.log('check-multisig: honesty lines (exact text)');
// ===========================================================================
{
  // Finding 9 of the 2026-10-10 emulator pass: the line counts SIGNERS (the
  // old "Any 2 co-signers together" counted this wallet's signer as a
  // co-signer) and, with this phone's signer known, says whether the other
  // signers can act without this phone.
  const TAIL = '; for messages the deployed validator needs only 1, so this account must never be used to sign logins, orders or token permits — the wallet refuses that.';
  check('exposure line for a 2-of-3 without a local signer (operations 2, messages 1), exact',
    multisigExposureLine(CONFIG_2_OF_3) === `Any 2 of the 3 signers together can send an operation${TAIL}`, multisigExposureLine(CONFIG_2_OF_3));
  check('exposure line for a 2-of-3 seen from this phone: the 2 co-signers can act WITHOUT this phone, exact',
    multisigExposureLine(CONFIG_2_OF_3, S0.address) === `Any 2 of the 3 signers together can send an operation — including the 2 co-signers without this phone${TAIL}`,
    multisigExposureLine(CONFIG_2_OF_3, S0.address));
  const S8 = evmKeyProvider.deriveAccount(seed, 0, 8);
  const TWO_OF_FOUR = { signers: [...CONFIG_2_OF_3.signers, { address: S8.address, weight: 1 }], threshold: 2, delaySeconds: 0 };
  check('exposure line for a 2-of-4 from this phone: any 2 of the 3 co-signers, exact',
    multisigExposureLine(TWO_OF_FOUR, S0.address) === `Any 2 of the 4 signers together can send an operation — including any 2 of the 3 co-signers without this phone${TAIL}`);
  const THREE_OF_THREE = { ...CONFIG_2_OF_3, threshold: 3 };
  check('exposure line for a 3-of-3 from this phone: this phone is always needed, exact',
    multisigExposureLine(THREE_OF_THREE, S0.address) ===
      'Every operation needs all 3 signers, so this phone’s signer is always one of them; for messages the deployed validator needs only 2, so this account must never be used to sign logins, orders or token permits — the wallet refuses that.',
    multisigExposureLine(THREE_OF_THREE, S0.address));
  const w = { signers: [{ address: S0.address, weight: 2 }, { address: S5.address, weight: 1 }, { address: S6.address, weight: 1 }], threshold: 3, delaySeconds: 0 };
  check('exposure line for a weighted set names the weight and the minimum', multisigExposureLine(w) === `Signers whose weights add up to 3 (at least 2 of them) can send an operation${TAIL}`, multisigExposureLine(w));
  check('weighted, this phone weight 2 of threshold 3: the co-signers (weight 2) cannot act alone, exact',
    multisigExposureLine(w, S0.address) ===
      `Signers whose weights add up to 3 (at least 2 of them) can send an operation — and this phone’s signer is always one of them, because the co-signers’ combined weight 2 is below the threshold 3${TAIL}`,
    multisigExposureLine(w, S0.address));
  const w2 = { signers: [{ address: S0.address, weight: 1 }, { address: S5.address, weight: 2 }, { address: S6.address, weight: 1 }], threshold: 3, delaySeconds: 0 };
  check('weighted, the co-signers reach the threshold together: they can act without this phone, exact',
    multisigExposureLine(w2, S0.address) === `Signers whose weights add up to 3 (at least 2 of them) can send an operation — including the 2 co-signers together, without this phone${TAIL}`,
    multisigExposureLine(w2, S0.address));
  check('fees line, exact', MULTISIG_FEES_LINE === 'Co-signers approve the calls and the nonce, not the network fee or paymaster, which the submitter sets.');
  check('fresh-deploy note says never converting and why', /never converts an existing account/.test(MULTISIG_FRESH_DEPLOY_NOTE) && /old single-key validator installed/.test(MULTISIG_FRESH_DEPLOY_NOTE) && /backdoor/.test(MULTISIG_FRESH_DEPLOY_NOTE));
  check('unaudited note names the audit status and test networks', /no published audit/.test(MULTISIG_UNAUDITED_NOTE) && /test networks only/.test(MULTISIG_UNAUDITED_NOTE));
  check('guardians and inheritance are refused for the collision; passkeys and session keys as not offered',
    /collide on one validation id/.test(multisigFeatureRefusal('guardians')) && /collide/.test(multisigFeatureRefusal('inheritance')) &&
      /not offered/.test(multisigFeatureRefusal('passkeys')) && /without the co-signers/.test(multisigFeatureRefusal('passkeys')) &&
      /not offered/.test(multisigFeatureRefusal('session-keys')) && /never been tested/.test(multisigFeatureRefusal('session-keys')));
  check('7702 and owner change are "not applicable"; WalletConnect, browser and messages carry the engine refusal',
    /not applicable/.test(multisigFeatureRefusal('eip7702')) && /no single owner key/.test(multisigFeatureRefusal('owner-rotation')) &&
      multisigFeatureRefusal('walletconnect').endsWith(MULTISIG_ERC1271_REFUSAL) && multisigFeatureRefusal('browser').endsWith(MULTISIG_ERC1271_REFUSAL) &&
      multisigFeatureRefusal('message-signing') === MULTISIG_ERC1271_REFUSAL);
  // Every phase of the screen renders the honesty block (source pin).
  const screen = readFileSync(join(HERE, '..', 'src', 'screens', 'MultisigScreen.tsx'), 'utf8');
  const views = readFileSync(join(HERE, '..', 'src', 'screens', 'MultisigViews.tsx'), 'utf8');
  check('screen: every phase goes through shell(), which renders <MultisigHonesty> with this phone’s signer (source pin)', (screen.match(/return shell\(/g) ?? []).length >= 13 && /<MultisigHonesty config=\{config\} localSigner=\{localSigner\} \/>/.test(screen) && !/return \(\s*<ScrollView/.test(screen));
  check('screen: the readiness card is in the shell and every starting button is disabled when gated', /readinessCard/.test(screen) && (screen.match(/disabled=\{readiness !== null/g) ?? []).length >= 8);
  check('views: the honesty block shows the exposure (with this phone’s signer), fees, message refusal and audit lines', /multisigExposureLine\(config, localSigner\)/.test(views) && /MULTISIG_FEES_LINE/.test(views) && /MULTISIG_ERC1271_REFUSAL/.test(views) && /MULTISIG_UNAUDITED_NOTE/.test(views));
  check('screen: the list, the co-signer review and every record phase pass this phone’s signer to the exposure line',
    /multisigExposureLine\(multisigConfigOf\(r\), r\.localSigner\)/.test(screen) && /r\.config,\s*r\.signer\.address,/.test(screen) && (screen.match(/selected\.localSigner,\n\s*\);/g) ?? []).length >= 5 && /reviewed\.config,\s*phraseSigner,/.test(screen));
  // Phase 20 item 3: the multisig confirm shows the balance-change preview
  // (every call, simulated from the multisig's own address against the
  // quote's endpoint) and the risk card, before "Approve and submit".
  const confirm = screen.slice(screen.indexOf("if ((phase === 'confirm' || phase === 'sending') && selected && op && submission)"), screen.indexOf("if (phase === 'progress' && selected && progress)"));
  const previewAt = confirm.indexOf('<BalanceChangePreview');
  const riskAt = confirm.indexOf('<RiskWarnings url={nodeUrl} wallet={q.sender} {...multisigRiskTarget(q.calls)} />');
  const approveAt = confirm.indexOf('title="Approve and submit"');
  check('confirm: balance-change preview of every call from the multisig, with the multisig note (source)',
    previewAt > 0 && /batch=\{q\.calls\.map\(\(c\) => \(\{ from: q\.sender, to: c\.to, value: c\.value, data: c\.data \}\)\)\}/.test(confirm) &&
      /url=\{nodeUrl\}/.test(confirm.slice(previewAt, previewAt + 400)) && confirm.includes('note={multisigPreviewNote(q.deployed)}'));
  check('confirm: the risk card for the first call (recipient as counterparty), both above Approve (source)', riskAt > previewAt && approveAt > riskAt);
  check('preview note: deployed, exact', multisigPreviewNote(true) === 'Simulated as direct calls from the multisig account. The network fee the multisig pays through the EntryPoint is shown separately above and is not part of this list.');
  check('preview note: not deployed adds the deployment sentence, exact',
    multisigPreviewNote(false) === `${MULTISIG_PREVIEW_NOTE} The multisig is not deployed yet: this operation deploys it first, which the simulation leaves out (deploying it moves no funds apart from the network fee).` &&
      MULTISIG_PREVIEW_UNDEPLOYED_NOTE.startsWith('The multisig is not deployed yet'));
  {
    const tokenAddr = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
    const recipient = '0x69f0b8c9b3a0d6b5f5e1fe8a2e5d3b0f2c17e8aa';
    const transfer = ethers.getBytes(new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [recipient, 5n]));
    const t1 = multisigRiskTarget([{ to: tokenAddr, value: 0n, data: transfer }]);
    check('risk target: an exact ERC-20 transfer names its recipient as the counterparty (checksummed)', t1.to === tokenAddr && t1.counterparty === ethers.getAddress(recipient) && t1.data === transfer);
    const t2 = multisigRiskTarget([{ to: recipient, value: 7n, data: new Uint8Array(0) }]);
    check('risk target: a native send has no counterparty (the card checks the recipient itself)', t2.to === recipient && t2.counterparty === undefined);
    check('risk target: a transfer that also sends ETH, or a longer calldata, keeps the generic card',
      multisigRiskTarget([{ to: tokenAddr, value: 1n, data: transfer }]).counterparty === undefined &&
        multisigRiskTarget([{ to: tokenAddr, value: 0n, data: new Uint8Array([...transfer, 0]) }]).counterparty === undefined);
    check('risk target: only the first call is described (as the Send screen does)', multisigRiskTarget([{ to: recipient, value: 1n, data: new Uint8Array(0) }, { to: tokenAddr, value: 0n, data: transfer }]).to === recipient);
  }
  check('History: the detail renders this account’s co-signer approvals, the list the others (source)',
    screen.includes('<MultisigCosignedHistory entries={cosignedHere} />') && screen.includes('<MultisigCosignedHistory entries={cosignedElsewhere} />') &&
      /setCosigned\(await listMultisigCosignerApprovals\(\{ chain \}\)\)/.test(screen) && /multisigCosignedHistoryLine\(e\)/.test(views));
  // Phase 20 item 3: a multisig submit goes to the pending registry as 'multisig'.
  const msSrc = readFileSync(join(HERE, '..', 'src', 'wallet', 'multisig.ts'), 'utf8');
  check("submitMultisigWithGate passes kind 'multisig' to sendAa (pending registry)", msSrc.includes("(signer) => sendAa(bundle, signer, quote, { kind: 'multisig' }));"));
  check('screen: keys only via signWith after requireLocalAuth (no key APIs, no readPhrase)', !/readPhrase|importedKeyVault|mnemonicToSeed|deriveAccount/.test(screen) && /requireAuth: requireLocalAuth/.test(screen));
}

// ===========================================================================
console.log('check-multisig: counterfactual address and the CREATE2 index');
// ===========================================================================
{
  const engine = predictKernelMultisigAddress(CONFIG_2_OF_3, { index: 0n });
  check('app address = engine predictKernelMultisigAddress (index 0, pinned deployment)', multisigAddressFor(CONFIG_2_OF_3, 0n) === engine, engine);
  const node = multisigNode();
  const factoryAnswer = await node('eth_call', [{ to: KERNEL_V3_3.factory, data: new ethers.Interface(['function getAddress(bytes,bytes32)']).encodeFunctionData('getAddress', [
    toHex(encodeKernelMultisigInitialize(CONFIG_2_OF_3)), ethers.zeroPadValue('0x00', 32)]) }, 'latest']);
  check('…and equals an ethers CREATE2 computation (keccak256(initData || bytes32 0) over the proxy init-code hash)', same(ethers.getAddress('0x' + factoryAnswer.slice(26)), engine));
  const reordered = { ...CONFIG_2_OF_3, signers: [...CONFIG_2_OF_3.signers].reverse() };
  check('the order the signers are entered in does not change the address', multisigAddressFor(reordered, 0n) === engine);
  check('another threshold, weight or index gives another address',
    multisigAddressFor({ ...CONFIG_2_OF_3, threshold: 3 }, 0n) !== engine && multisigAddressFor(CONFIG_2_OF_3, 1n) !== engine &&
      multisigAddressFor({ ...CONFIG_2_OF_3, signers: CONFIG_2_OF_3.signers.map((s, i) => ({ ...s, weight: i === 0 ? 2 : 1 })), threshold: 3 }, 0n) !== engine);
  const recSep = [{ chain: SEPOLIA, address: engine }];
  check('chooseMultisigIndex: 0 normally, 1 when this phone holds the same set on the same network, 0 on another network',
    chooseMultisigIndex(CONFIG_2_OF_3, SEPOLIA, []) === 0n && chooseMultisigIndex(CONFIG_2_OF_3, SEPOLIA, recSep) === 1n && chooseMultisigIndex(CONFIG_2_OF_3, 'eip155:84532', recSep) === 0n);
}

// ===========================================================================
console.log('check-multisig: records (create, reload, tamper, damaged list)');
// ===========================================================================
const store = memoryStore();
let record;
{
  const node = multisigNode();
  check('network check passes on the fake Sepolia (chain id, module code, Kernel deployment)', (await checkMultisigNetwork(node, SEPOLIA)).length === 0);
  const noModule = fakeKernelNode({ chainIdHex: '0xaa36a7' });
  check('network check names a missing weighted signer module', (await checkMultisigNetwork(noModule, SEPOLIA)).some((p) => p.includes('has no code')));
  check('network check refuses another chain id', (await checkMultisigNetwork(fakeKernelNode({ chainIdHex: '0x1' }), SEPOLIA))[0]?.includes('chain id 1'));
  // Finding 5: the "Check this network" sentence must end with a full stop.
  // The engine's verifyKernelDeployment message (e.g. "KernelFactory … has no
  // code on this chain") carries none, so checkMultisigNetwork adds it.
  const noFactory = fakeKernelNode({ chainIdHex: '0xaa36a7', codeAt: { [KERNEL_MULTISIG_VALIDATOR.toLowerCase()]: true, [KERNEL_V3_3.factory.toLowerCase()]: false } });
  const kProblems = await checkMultisigNetwork(noFactory, SEPOLIA);
  check('the Kernel-deployment-did-not-verify sentence ends with a full stop (finding 5)',
    kProblems.some((p) => /^The Kernel v3\.3 deployment did not verify on this network: .+\.$/.test(p)), kProblems.join(' | '));
  check('every network-check problem ends with terminal punctuation',
    (await checkMultisigNetwork(noModule, SEPOLIA)).every((p) => /[.!?]$/.test(p)) && kProblems.every((p) => /[.!?]$/.test(p)));

  record = await createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address, now: 1 }, store);
  check('created: id in the multisig range, "Multisig 1 (2-of-3)", index 0, the engine address, not deployed, delay 0',
    record.id === multisigAccountId(0) && multisigDisplayName(record) === 'Multisig 1 (2-of-3)' && record.index === '0' &&
      record.address === multisigAddressFor(CONFIG_2_OF_3, 0n) && record.deployed.deployed === false && record.delaySeconds === 0 && record.localSigner === S0.address);
  check('the record holds no secret (no private key, mnemonic or seed field; only addresses and numbers)', !/priv|mnemonic|seed|secret/i.test(store._map.get('shiba-wallet.multisig.v1')));
  const second = await createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address, name: 'Team', now: 2 }, store);
  check('the same set again on the same network takes index 1, slot 1, its own name', second.index === '1' && second.id === multisigAccountId(1) && second.name === 'Team' && second.address !== record.address);
  await removeMultisigRecord(second.id, store);
  const third = await createMultisigRecord({ chain: SEPOLIA, config: { ...CONFIG_2_OF_3, threshold: 3 }, localSigner: S0.address, now: 3 }, store);
  check('slots are never reused after a removal (slot 2)', third.id === multisigAccountId(2));
  await removeMultisigRecord(third.id, store);
  check('list / entries reload the record', (await listMultisigRecords(SEPOLIA, store)).length === 1 && (await multisigListEntries(store))[0].id === record.id);
  check('a localSigner outside the set is refused', (await caught(() => createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S7.address }, memoryStore())))?.message.includes('must be one of'));
  check('a one-signer-can-act set is refused by the store too', (await caught(() => createMultisigRecord({ chain: SEPOLIA, config: { ...CONFIG_2_OF_3, threshold: 1 }, localSigner: S0.address }, memoryStore())))?.message === MULTISIG_SINGLE_SIGNER_REFUSAL);

  const raw = JSON.parse(store._map.get('shiba-wallet.multisig.v1'));
  const t1 = memoryStore();
  t1._map.set('shiba-wallet.multisig.v1', JSON.stringify({ ...raw, records: [{ ...raw.records[0], address: RECIPIENT }] }));
  check('a record whose address does not follow from its signer set is dropped on load', (await listMultisigRecords(undefined, t1)).length === 0);
  const t2 = memoryStore();
  t2._map.set('shiba-wallet.multisig.v1', JSON.stringify({ ...raw, records: [{ ...raw.records[0], deployment: { ...raw.records[0].deployment, weightedValidator: RECIPIENT } }] }));
  check('a record with a non-pinned signer module is dropped on load', (await listMultisigRecords(undefined, t2)).length === 0);
  const t3 = memoryStore();
  t3._map.set('shiba-wallet.multisig.v1', JSON.stringify({ ...raw, records: [{ ...raw.records[0], id: 5 }] }));
  check('a record with an id outside the multisig range is dropped on load', (await listMultisigRecords(undefined, t3)).length === 0);
  const damaged = memoryStore();
  damaged._map.set('shiba-wallet.multisig.v1', '{not json');
  check('a damaged list reads as empty, refuses every write and is not overwritten',
    (await listMultisigRecords(undefined, damaged)).length === 0 && (await caught(() => createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, damaged)))?.message === MULTISIG_STORE_DAMAGED &&
      damaged._map.get('shiba-wallet.multisig.v1') === '{not json' && (await multisigListEntries(damaged)) === null);
}

// ===========================================================================
console.log('check-multisig: export / import round trip (a co-signer adds the same account)');
// ===========================================================================
{
  const exported = exportMultisigAccount(record);
  const parsedExport = JSON.parse(exported.json);
  check('export: typed payload, no local id, name or history, QR-sized', parsedExport.type === MULTISIG_ACCOUNT_PAYLOAD && parsedExport.id === undefined && parsedExport.name === undefined && parsedExport.operations === undefined && exported.qrValue === exported.json);
  check('share text says it contains no secrets and carries the JSON', exported.shareText.includes('contains no secrets') && exported.shareText.includes(exported.json));
  const other = memoryStore();
  const parsed = parseMultisigAccountImport(exported.shareText);
  const imported = await importMultisigRecord(parsed, [{ name: 'Account 6', address: S5.address, kind: 'phrase' }], other, 9);
  check('import on the co-signer’s phone: same address, set, threshold and index; its own signer is local', imported.address === record.address && imported.index === record.index && imported.threshold === 2 && imported.localSigner === S5.address && imported.origin === 'imported');
  check('import refuses a duplicate on the same network', (await caught(() => importMultisigRecord(parsed, [{ name: 'Account 6', address: S5.address, kind: 'phrase' }], other)))?.message.includes('already in this wallet'));
  check('import refuses when no phrase account of this wallet is a signer (an imported key does not count)',
    (await caught(() => importMultisigRecord(parsed, [{ name: 'Imported 1', address: S5.address, kind: 'imported' }], memoryStore())))?.message.includes('None of this wallet’s recovery-phrase accounts'));
  const tamper = (patch) => JSON.stringify({ ...parsedExport, ...patch });
  check('import refuses an address that does not follow from the signer set', throwsWith(() => parseMultisigAccountImport(tamper({ account: RECIPIENT })), 'is not the address of this signer set'));
  check('import refuses a changed threshold (the address no longer matches)', throwsWith(() => parseMultisigAccountImport(tamper({ threshold: 3 })), 'is not the address'));
  check('import refuses a non-pinned signer module', throwsWith(() => parseMultisigAccountImport(tamper({ weightedValidator: RECIPIENT })), 'deployment addresses'));
  check('import refuses a delay', throwsWith(() => parseMultisigAccountImport(tamper({ delaySeconds: 60 })), 'without a delay'));
  check('import refuses a request or approval pasted by mistake', throwsWith(() => parseMultisigAccountImport(JSON.stringify({ type: MULTISIG_REQUEST_PAYLOAD })), 'signing request') && throwsWith(() => parseMultisigAccountImport(JSON.stringify({ type: MULTISIG_APPROVAL_PAYLOAD })), 'approval'));
  const mainnetParsed = parseMultisigAccountImport(tamper({ chainId: '1' }));
  const e = await caught(() => importMultisigRecord(mainnetParsed, [{ name: 'Account 6', address: S5.address, kind: 'phrase' }], memoryStore()));
  check('import refuses a mainnet record with the multisig readiness text', isRefusal(e) && e.message === readinessRefusal('multisig'), e?.message);
  check('file helper: a .json with exactly one object passes; other names, sizes and a share text are refused',
    multisigFileText('﻿ ' + exported.json + '\n', { name: 'x.json' }) === exported.json && throwsWith(() => multisigFileText(exported.json, { name: 'x.txt', mimeType: 'text/plain' }), '.json') &&
      throwsWith(() => multisigFileText(exported.shareText, { name: 'x.json' }), 'exactly one JSON object') && throwsWith(() => multisigFileText(exported.json, { name: 'x.json', size: 70_000 }), 'larger'));
  check('file names follow the pattern', /^shiba-multisig-request_sepolia_0x[0-9a-fA-F]{4}-[0-9a-fA-F]{4}_2026-10-10\.json$/.test(multisigExportFileName('request', SEPOLIA, record.address, new Date('2026-10-10T12:00:00Z'))));
}

// ===========================================================================
console.log('check-multisig: request, co-signer review and approvals');
// ===========================================================================
let op;
let approvalPayload;
{
  const counter = { n: 0 };
  const node = multisigNode({ counter });
  const calls = [{ to: RECIPIENT, value: 10n ** 14n, data: new Uint8Array(0) }];
  op = await prepareMultisigRequest({ record, calls, node, nativeSymbol: 'test ETH', now: 5 }, store);
  check('request built with no key: nonce 0, deploys (undeployed account), collecting, summary from the calls',
    op.nonce === '0' && op.deploys === true && op.status === 'collecting' && op.summary === `Send 0.0001 test ETH (100000000000000 wei) to ${RECIPIENT}.` && counter.n > 0);
  const engineReq = buildMultisigSigningRequest({ chainId: 11155111n, account: record.address, calls, nonce: 0n });
  check('the request equals the engine’s buildMultisigSigningRequest', JSON.stringify(op.request) === JSON.stringify(engineReq));
  // Independent hashes with ethers.
  const cdnh = ethers.keccak256(abi.encode(['address', 'bytes', 'uint256'], [record.address, op.request.callData, 0n]));
  const domain = { name: 'WeightedECDSAValidator', version: '0.0.3', chainId: 11155111, verifyingContract: KERNEL_MULTISIG_VALIDATOR };
  const types = { Approve: [{ name: 'callDataAndNonceHash', type: 'bytes32' }] };
  const digest = ethers.TypedDataEncoder.hash(domain, types, { callDataAndNonceHash: cdnh });
  check('request id = keccak256(abi.encode(sender, callData, nonce)) and the approval digest = EIP-712 Approve (ethers)', op.requestId === cdnh && op.request.approvalDigest === digest);

  const payload = encodeMultisigRequestPayload(record, op);
  const parsed = parseMultisigRequestPayload(payload);
  check('request payload round trip: calls re-encode to the call data, account facts give the address', parsed.calls.length === 1 && same(parsed.calls[0].to, RECIPIENT) && parsed.calls[0].value === 10n ** 14n && parsed.request.account === record.address);
  const pj = JSON.parse(payload);
  check('a request whose listed calls differ from its call data is refused', throwsWith(() => parseMultisigRequestPayload(JSON.stringify({ ...pj, calls: [{ ...pj.calls[0], value: '1' }] })), 'do not match'));
  check('a request with a tampered call data is refused by the engine hash re-derivation', throwsWith(() => parseMultisigRequestPayload(JSON.stringify({ ...pj, request: { ...pj.request, callData: pj.request.callData.slice(0, -2) + (pj.request.callData.endsWith('ff') ? '00' : 'ff') } })), 'does not match'));
  check('a request whose account facts give another address is refused', throwsWith(() => parseMultisigRequestPayload(JSON.stringify({ ...pj, account: { ...pj.account, threshold: 3 } })), 'is not the address'));

  const ctx = { activeChain: SEPOLIA, activeAddress: S5.address, ownAccounts: [{ name: 'Account 6', address: S5.address, kind: 'phrase' }], records: [], nativeSymbol: 'test ETH' };
  const review = reviewMultisigRequestAsCosigner(multisigRequestShareTextSafe(payload), ctx);
  check('co-signer review: account, network, nonce, signer weight, the calls described by THIS wallet, exposure line',
    review.request.account === record.address && review.networkLabel === 'Ethereum Sepolia' && review.request.nonce === '0' && review.signer.address === S5.address && review.signer.weight === 1 &&
      review.described[0] === `Send 0.0001 test ETH (100000000000000 wei) to ${RECIPIENT}.` && review.exposureLine === multisigExposureLine(CONFIG_2_OF_3, S5.address) && review.warnings.some((w) => w.includes('not in this wallet')));
  check('co-signer review: the exposure line is seen from THIS co-signer’s phone (the other 2 can act without it)', review.exposureLine.includes('including the 2 co-signers without this phone'));
  check('review refuses another network than the active one', throwsWith(() => reviewMultisigRequestAsCosigner(payload, { ...ctx, activeChain: 'eip155:84532' }), 'but the active network is Base Sepolia'));
  check('review refuses when the active account is not a signer, naming the account that is', throwsWith(() => reviewMultisigRequestAsCosigner(payload, { ...ctx, activeAddress: S7.address }), 'Account 6'));
  check('review refuses when no account of this wallet is a signer', throwsWith(() => reviewMultisigRequestAsCosigner(payload, { ...ctx, activeAddress: S7.address, ownAccounts: [] }), 'None of this wallet’s accounts'));

  // The co-signer approves: the device check first, then signWith.
  const log = [];
  const cancelled = await caught(() => cosignWithGate({ review, requireAuth: authCancel(log), signWith: signWithAs(S5, log) }));
  check('co-sign: a cancelled device check signs nothing (signWith never called)', cancelled instanceof MultisigAuthCancelledError && log.length === 1 && log[0].startsWith('auth:'));
  log.length = 0;
  const out = await cosignWithGate({ review, requireAuth: authOk(log), signWith: signWithAs(S5, log) });
  check('co-sign: the device check comes BEFORE signWith, which is asked for the active co-signer address', log.length === 2 && log[0] === 'auth:Approve this multisig operation as a co-signer' && log[1] === `signWith:${S5.address}`);
  const appr = JSON.parse(out.payload);
  check('co-sign: the approval payload names chain, account, request id and signer', appr.type === MULTISIG_APPROVAL_PAYLOAD && appr.chainId === '11155111' && appr.account === record.address && appr.requestId === op.requestId && appr.signer === S5.address);
  check('co-sign: the signature recovers to the co-signer over the EIP-712 Approve digest (ethers)', ethers.recoverAddress(digest, appr.signature) === S5.address);
  check('co-sign: signWith handing a different account is refused (nothing signed)', (await caught(() => cosignWithGate({ review, requireAuth: authOk([]), signWith: async (_c, _e, fn) => fn(S6) })))?.message.includes('must come from'));
  approvalPayload = out.payload;

  // Phase 20 item 3: this phone's History records the approval it gave as a
  // co-signer — secret-free, strict, after the signature exists, never on a
  // cancelled check or a refused signer, and never withholding the approval.
  {
    const cs = memoryStore();
    let t = 1_791_800_000_000;
    const now = () => t;
    const before = await caught(() => cosignWithGate({ review, requireAuth: authCancel([]), signWith: signWithAs(S5, []), store: cs, now }));
    check('co-signer history: a cancelled device check records nothing', before instanceof MultisigAuthCancelledError && (await listMultisigCosignerApprovals({}, cs)).length === 0);
    await caught(() => cosignWithGate({ review, requireAuth: authOk([]), signWith: async (_c, _e, fn) => fn(S6), store: cs, now }));
    check('co-signer history: a refused signer records nothing', (await listMultisigCosignerApprovals({}, cs)).length === 0);
    const rec = await cosignWithGate({ review, requireAuth: authOk([]), signWith: signWithAs(S5, []), store: cs, now });
    const entries = await listMultisigCosignerApprovals({ chain: SEPOLIA, account: record.address }, cs);
    check('co-signer history: one entry with request id, account, chain, nonce, summary, signer and time',
      rec.recorded === true && entries.length === 1 && entries[0].kind === 'approved-as-cosigner' && entries[0].requestId === op.requestId &&
        entries[0].account === record.address && entries[0].chain === SEPOLIA && entries[0].nonce === '0' &&
        entries[0].summary === `Send 0.0001 test ETH (100000000000000 wei) to ${RECIPIENT}.` && entries[0].signer === S5.address && entries[0].approvedAt === t,
      JSON.stringify(entries));
    const raw = await cs.getItem('shiba-wallet.multisig.v1');
    check('co-signer history: secret-free (no approval signature stored)', !raw.includes(JSON.parse(rec.payload).signature.slice(2, 40)));
    check('History line, exact', multisigCosignedHistoryLine(entries[0]) === `Approved as co-signer: Send 0.0001 test ETH (100000000000000 wei) to ${RECIPIENT}. (request ${op.requestId.slice(0, 10)}…)`);
    check('History detail: nonce, approving account, UTC time, and no claim about inclusion',
      multisigCosignedHistoryDetail(entries[0]) === `Nonce 0 · approved by ${S5.address} on 2026-10-12 10:13 UTC. Whether it was submitted is up to the submitter; this phone does not track it.`,
      multisigCosignedHistoryDetail(entries[0]));
    t += 60_000;
    await cosignWithGate({ review, requireAuth: authOk([]), signWith: signWithAs(S5, []), store: cs, now });
    const again = await listMultisigCosignerApprovals({}, cs);
    check('co-signer history: approving the same request again replaces the entry (newest time)', again.length === 1 && again[0].approvedAt === t);
    check('co-signer history: filtered by network and account', (await listMultisigCosignerApprovals({ chain: 'eip155:84532' }, cs)).length === 0 && (await listMultisigCosignerApprovals({ account: S7.address }, cs)).length === 0);
    // Cap.
    for (let i = 0; i < MAX_MULTISIG_COSIGNED_HISTORY + 3; i += 1) {
      await recordMultisigCosignerApproval({ ...review, request: { ...review.request, callDataAndNonceHash: '0x' + (i + 1).toString(16).padStart(64, '0') } }, t + i + 1, cs);
    }
    const capped = await listMultisigCosignerApprovals({}, cs);
    check('co-signer history: capped, newest first', capped.length === MAX_MULTISIG_COSIGNED_HISTORY && capped[0].approvedAt === t + MAX_MULTISIG_COSIGNED_HISTORY + 3);
    // Strict parse.
    const good = capped[0];
    check('strict entry parse: the stored shape revives', reviveCosignedEntry({ ...good }) !== null);
    check('strict entry parse: an extra key, a bad request id, a bad kind or a zero time is refused',
      reviveCosignedEntry({ ...good, signature: '0x00' }) === null && reviveCosignedEntry({ ...good, requestId: '0x12' }) === null &&
        reviveCosignedEntry({ ...good, kind: 'submitted' }) === null && reviveCosignedEntry({ ...good, approvedAt: 0 }) === null && reviveCosignedEntry({ ...good, summary: 'x'.repeat(501) }) === null);
    const doc = JSON.parse(await cs.getItem('shiba-wallet.multisig.v1'));
    await cs.setItem('shiba-wallet.multisig.v1', JSON.stringify({ ...doc, cosigned: [{ ...good, extra: 1 }, good] }));
    check('a malformed stored entry is dropped, the valid one kept', (await listMultisigCosignerApprovals({}, cs)).length === 1);
    await cs.setItem('shiba-wallet.multisig.v1', JSON.stringify({ ...doc, cosigned: 'oops' }));
    check('a non-list "cosigned" makes the store damaged (writes refused, approval still returned)',
      (await caught(() => recordMultisigCosignerApproval(review, t, cs)))?.message === MULTISIG_STORE_DAMAGED &&
        (await cosignWithGate({ review, requireAuth: authOk([]), signWith: signWithAs(S5, []), store: cs, now })).recorded === false);
    const legacy = memoryStore();
    await legacy.setItem('shiba-wallet.multisig.v1', JSON.stringify({ version: 1, nextSlot: doc.nextSlot, records: doc.records }));
    check('a store written before phase 20 (no "cosigned") still loads its records and records approvals',
      (await listMultisigRecords(undefined, legacy)).length === doc.records.length && (await recordMultisigCosignerApproval(review, t, legacy)).requestId === op.requestId);
  }

  // The submitting side adds approvals.
  const p0 = multisigWeightProgress(record, op);
  check('progress before approvals: weight 1 (this wallet’s signer) of 2, not ready', p0.weight === 1 && p0.threshold === 2 && p0.localWeight === 1 && !p0.ready);
  // Finding 2 (CTO decision): the submitter still counts, but the bar shows
  // co-signer weight collected versus co-signer weight needed, and a separate
  // line says this wallet signs only when you submit.
  check('progress before approvals: co-signer weight 0 of 1 needed',
    p0.cosignerWeight === 0 && p0.cosignerNeeded === 1 && !p0.cosignersAlone && multisigCosignerBarLabel(p0) === 'Co-signer approvals: weight 0 of 1 needed (1 still needed)', multisigCosignerBarLabel(p0));
  check('the wallet’s own signer has its own line, exact', multisigLocalSignsLine(p0) === 'This wallet signs the remaining weight 1 when you submit.');
  check('the not-ready hint names co-signer weight, exact', multisigNotReadyHint(p0) === 'Submitting needs co-signer approvals of weight 1; the approvals so far reach 0.');
  const { op: op2, added } = addMultisigApproval(record, op, approvalPayload);
  check('an approval payload is added: weight 2 of 2, ready, approval id = keccak256(signature)', added.address === S5.address && multisigWeightProgress(record, op2).ready && op2.approvalIds[0].approvalId === ethers.keccak256(appr.signature));
  const p1 = multisigWeightProgress(record, op2);
  check('after one co-signer approval (threshold met WITH this wallet): "weight 1 of 1 needed — ready", not cosignersAlone, local line kept (finding 4)',
    !p1.cosignersAlone && multisigCosignerBarLabel(p1) === 'Co-signer approvals: weight 1 of 1 needed — ready', multisigCosignerBarLabel(p1));
  // Finding 4: when the co-signers alone already meet the threshold, the bar
  // must not read "weight 2 of 1 needed" and the "this wallet signs the
  // remaining weight" clause is dropped.
  const { op: opBoth } = addMultisigApproval(record, op2, approveMultisigRequest(op.request, S6).signature);
  const pBoth = multisigWeightProgress(record, opBoth);
  check('both co-signers approve (co-signers alone meet the threshold): cosignersAlone true and the bar says so, exact',
    pBoth.cosignersAlone === true && pBoth.cosignerWeight === 2 && pBoth.ready &&
      multisigCosignerBarLabel(pBoth) === 'Co-signer approvals: weight 2 (threshold 2 met by co-signers alone) — ready',
    multisigCosignerBarLabel(pBoth));
  check('the confirm sentence separates co-signer weight from what this wallet signs, exact',
    multisigSubmitApprovalsLine(p1) ===
      'Co-signer approvals: weight 1 (1 needed). This wallet signs the remaining weight 1 when you submit, for weight 2 of the threshold 2. Your device check comes next; this wallet’s signer then signs the final operation, and the signer module checks every approval again.',
    multisigSubmitApprovalsLine(p1));
  const weightedRecord = { ...record, signers: [{ address: S0.address, weight: 2 }, { address: S5.address, weight: 1 }, { address: S6.address, weight: 1 }], threshold: 3 };
  const pw = multisigWeightProgress(weightedRecord, op);
  check('weighted (this wallet 2 of threshold 3): co-signer weight needed is 1', pw.cosignerNeeded === 1 && pw.localWeight === 2 && multisigLocalSignsLine(pw) === 'This wallet signs the remaining weight 2 when you submit.');
  const bare = approveMultisigRequest(op.request, S6);
  check('a bare 65-byte signature from another wallet is accepted (signer recovered)', addMultisigApproval(record, op, bare.signature).added.address === S6.address);
  check('the engine’s bare {signer, signature} JSON is accepted', addMultisigApproval(record, op, JSON.stringify(bare)).added.address === S6.address);
  check('refused: the same co-signer twice', throwsWith(() => addMultisigApproval(record, op2, approvalPayload), 'already added'));
  check('refused: an approval from a non-signer', throwsWith(() => addMultisigApproval(record, op, approveMultisigRequest(op.request, S7).signature), 'not a signer'));
  check('the non-signer refusal is shown as a sentence: the engine’s words plus a period (finding 6)',
    throwsWith(() => addMultisigApproval(record, op, approveMultisigRequest(op.request, S7).signature), `${S7.address} is not a signer of this multisig.`));
  check('…and an app sentence that already ends with a period is unchanged', throwsWith(() => addMultisigApproval(record, op2, approvalPayload), `An approval from ${S5.address} was already added.`) &&
    asSentence('Already a sentence.') === 'Already a sentence.' && asSentence('no period') === 'no period.');
  const own = approveMultisigRequest(op.request, S0);
  check('refused: this wallet’s own signer as a co-signer approval (the submitter rule)', throwsWith(() => addMultisigApproval(record, op, JSON.stringify(own)), MULTISIG_SUBMITTER_APPROVAL_REFUSAL));
  const otherReq = buildMultisigSigningRequest({ chainId: 11155111n, account: record.address, calls, nonce: 1n });
  const stale = approveMultisigRequest(otherReq, S5);
  check('refused: an approval payload for another request id', throwsWith(() => addMultisigApproval(record, op, encodeMultisigApprovalPayload(otherReq, stale)), 'another request'));
  check('refused: a stale bare approval (another nonce) does not recover to a signer', throwsWith(() => addMultisigApproval(record, op, JSON.stringify(stale)), 'recovers to'));
  const badSig = appr.signature.slice(0, 10) + (appr.signature[10] === 'a' ? 'b' : 'a') + appr.signature.slice(11);
  check('refused: a tampered signature', throwsWith(() => addMultisigApproval(record, op, JSON.stringify({ ...appr, signature: badSig }))));
  check('refused: a request pasted where an approval goes', throwsWith(() => addMultisigApproval(record, op, payload), 'not an approval'));
  await saveMultisigOperation(record.id, op, store);
  record = (await listMultisigRecords(SEPOLIA, store))[0];
  check('the operation is stored on the record (collecting, request id)', record.operations[0].requestId === op.requestId && record.operations[0].status === 'collecting');
}

function multisigRequestShareTextSafe(payload) {
  // The share text is what a co-signer usually pastes: a header, the payload,
  // then a second JSON block (typed data). The parser takes the first object.
  return `MULTISIG SIGNING REQUEST\n\n${payload}\n\nOther wallets:\n{"types":{}}`;
}

// ===========================================================================
console.log('check-multisig: threshold and submitter refusals');
// ===========================================================================
{
  const counter = { n: 0 };
  const node = multisigNode({ counter });
  const bundler = fakeBundler();
  const e = await caught(() => prepareMultisigSubmission({ record, op, nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, transportFor: transportsFor(node, bundler) }));
  check('threshold not reached: refused with the plain sentence before any request', e?.message === multisigThresholdNotReached(1, 2) && counter.n === 0 && bundler.calls.length === 0, e?.message);
  // Engine defense in depth: the spec refuses the submitter among the approvals at signing time.
  const own = approveMultisigRequest(op.request, S0);
  const bundle = createMultisigAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, chainId: 11155111n, accountId: record.id, account: record.address, config: CONFIG_2_OF_3, index: 0n, submitter: S0.address, approvals: [own], transportFor: transportsFor(node, bundler) });
  const quote = await prepareAaCalls(bundle, S0.address, [{ to: RECIPIENT, value: 10n ** 14n, data: new Uint8Array(0) }]);
  const se = await caught(() => sendAa(bundle, S0, quote));
  check('engine: the submitter among the approvals is refused at signing; nothing reaches eth_sendUserOperation', /must not also appear/.test(se?.message ?? '') && !bundler.calls.some((c) => c.method === 'eth_sendUserOperation'), se?.message);
  const lone = createMultisigAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, chainId: 11155111n, accountId: record.id, account: record.address, config: CONFIG_2_OF_3, index: 0n, submitter: S0.address, approvals: [], transportFor: transportsFor(node, bundler) });
  const q2 = await prepareAaCalls(lone, S0.address, [{ to: RECIPIENT, value: 10n ** 14n, data: new Uint8Array(0) }]);
  const le = await caught(() => sendAa(lone, S0, q2));
  check('engine: below the threshold is refused at signing too', /below the threshold 2/.test(le?.message ?? '') && !bundler.calls.some((c) => c.method === 'eth_sendUserOperation'), le?.message);
  check('a submitter outside the signer set cannot build a bundle', throwsWith(() => createMultisigAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, chainId: 11155111n, accountId: record.id, account: record.address, config: CONFIG_2_OF_3, index: 0n, submitter: S7.address, approvals: [], transportFor: transportsFor(node, bundler) }), 'not one of the multisig signers'));
}

// ===========================================================================
console.log('check-multisig: the full submit pipeline (deploy + first operation), recovered by ethers');
// ===========================================================================
{
  const { op: ready } = addMultisigApproval(record, op, approvalPayload);
  await saveMultisigOperation(record.id, ready, store);
  const node = multisigNode();
  const bundler = fakeBundler();
  const { bundle, quote } = await prepareMultisigSubmission({ record, op: ready, nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, transportFor: transportsFor(node, bundler) });
  check('quote: the multisig sender, deploys, multisig type, self-paid, fee > 0', quote.sender === record.address && quote.deployed === false && quote.accountType === 'kernel-multisig' && quote.sponsored === false && quote.fee > 0n);
  check('confirm label for the sender row', aaSenderLabel(quote) === 'From multi-signature account (co-signers approved)');
  check('the estimate carried the collected approval plus a stub in the signature', bundler.lastEstimated.signature.length === 2 + 130 * 2 && bundler.lastEstimated.signature.slice(2, 132) === JSON.parse(approvalPayload).signature.slice(2));

  // Cancelled device check: nothing signed, nothing sent.
  const log = [];
  const cancelled = await caught(() => submitMultisigWithGate({ record, op: ready, bundle, quote, requireAuth: authCancel(log), signWith: signWithAs(S0, log), store }));
  check('submit: a cancelled device check signs and sends nothing', cancelled instanceof MultisigAuthCancelledError && log.length === 1 && !bundler.calls.some((c) => c.method === 'eth_sendUserOperation'));
  log.length = 0;
  const { userOpHash } = await submitMultisigWithGate({ record, op: ready, bundle, quote, requireAuth: authOk(log), signWith: signWithAs(S0, log), store });
  check('submit: the device check comes BEFORE signWith, which is asked for this wallet’s signer', log.length === 2 && log[0].startsWith('auth:Approve submitting this multisig operation') && log[1] === `signWith:${S0.address}`);
  check('submit returns the bundler hash', userOpHash === USEROP_HASH);
  const sent = bundler.lastOp;
  const deploy = new ethers.Interface(['function deployWithFactory(address factory, bytes createData, bytes32 salt)']).decodeFunctionData('deployWithFactory', sent.factoryData);
  const init = new ethers.Interface(['function initialize(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)']).decodeFunctionData('initialize', deploy[1]);
  const [signers, weights, threshold, delay] = abi.decode(['address[]', 'uint24[]', 'uint24', 'uint48'], init[2]);
  check('deployment: meta factory → KernelFactory, salt = index 0, root = 0x01 || weighted validator, no hook (ethers decode)',
    same(sent.factory, KERNEL_V3_3.metaFactory) && same(deploy[0], KERNEL_V3_3.factory) && BigInt(deploy[2]) === 0n &&
      init[0].toLowerCase() === ('0x01' + KERNEL_MULTISIG_VALIDATOR.slice(2)).toLowerCase() && init[1] === ethers.ZeroAddress);
  check('deployment: the signer set sorted descending, weights 1, threshold 2, delay 0 (ethers decode)',
    signers.length === 3 && signers.every((s, i) => i === 0 || BigInt(signers[i - 1]) > BigInt(s)) && [S0, S5, S6].every((x) => signers.some((s) => same(s, x.address))) &&
      weights.every((w) => w === 1n) && threshold === 2n && delay === 0n);
  const exec = decodeKernelExecute(sent.callData);
  check('call data = the approved transfer (ethers decode) and equals the request’s', exec.calls.length === 1 && same(exec.calls[0].to, RECIPIENT) && exec.calls[0].value === 10n ** 14n && sent.callData.toLowerCase() === ready.request.callData);
  const sig = sent.signature;
  check('signature = one 65-byte approval + one 65-byte final signature', sig.length === 2 + 130 * 2);
  const cdnh = ethers.keccak256(abi.encode(['address', 'bytes', 'uint256'], [sent.sender, sent.callData, BigInt(sent.nonce)]));
  const digest = ethers.TypedDataEncoder.hash({ name: 'WeightedECDSAValidator', version: '0.0.3', chainId: 11155111, verifyingContract: KERNEL_MULTISIG_VALIDATOR }, { Approve: [{ name: 'callDataAndNonceHash', type: 'bytes32' }] }, { callDataAndNonceHash: cdnh });
  check('approval part recovers to the co-signer over the Approve digest of the FINAL op (ethers)', ethers.recoverAddress(digest, '0x' + sig.slice(2, 132)) === S5.address);
  const hash = getUserOpHash(fromRpcOp(sent), ENTRYPOINT_V07, 11155111n);
  check('final part is this wallet’s signer over EIP-191(userOpHash), recovered by ethers', ethers.verifyMessage(hash, '0x' + sig.slice(132)) === S0.address);
  record = (await listMultisigRecords(SEPOLIA, store))[0];
  check('the operation is marked submitted with its userOpHash; it deploys', record.operations[0].status === 'submitted' && record.operations[0].userOpHash === USEROP_HASH && record.operations[0].deploys === true);
  check('the same quote cannot be submitted twice', (await caught(() => submitMultisigWithGate({ record, op: ready, bundle, quote, requireAuth: authOk([]), signWith: signWithAs(S0, []), store })))?.message.includes('already submitted'));
  await recordMultisigOutcome(record.id, ready.requestId, { success: true, txHash: '0x' + '77'.repeat(32) }, store);
  record = (await listMultisigRecords(SEPOLIA, store))[0];
  check('outcome: succeeded, tx recorded, account marked deployed, signatures dropped, approval ids kept',
    record.operations[0].status === 'succeeded' && record.operations[0].txHash === '0x' + '77'.repeat(32) && record.deployed.deployed === true &&
      record.operations[0].approvals.length === 0 && record.operations[0].approvalIds.length === 1);
  check('submitting needs a collecting operation (a finished one is refused)', (await caught(() => prepareMultisigSubmission({ record, op: record.operations[0], nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, transportFor: transportsFor(node, bundler) })))?.message.includes('already submitted'));
}

// ===========================================================================
console.log('check-multisig: a deployed account is checked on-chain before a request');
// ===========================================================================
{
  const deployed = new Set([record.address]);
  const goodState = await readMultisigOnChain(multisigNode({ deployed }), record);
  check('deployed and matching: no problems', goodState.deployed && goodState.problems.length === 0);
  const next = await prepareMultisigRequest({ record, calls: [{ to: RECIPIENT, value: 1n, data: new Uint8Array(0) }], node: multisigNode({ deployed, nonce: 1n }), nativeSymbol: 'test ETH' }, store);
  check('the next request uses the on-chain nonce and does not deploy', next.nonce === '1' && next.deploys === false);
  const wrongRoot = await readMultisigOnChain(multisigNode({ deployed, rootIsWeighted: false }), record);
  check('a root validator other than the weighted module is reported', wrongRoot.problems.some((p) => p.includes('root validator')));
  const otherSet = await readMultisigOnChain(multisigNode({ deployed, onChainSet: { ...CONFIG_2_OF_3, threshold: 3 } }), record);
  check('a different on-chain threshold is reported, and a request is refused', otherSet.problems.some((p) => p.includes('threshold on-chain is 3')) &&
    (await caught(() => prepareMultisigRequest({ record, calls: [{ to: RECIPIENT, value: 1n, data: new Uint8Array(0) }], node: multisigNode({ deployed, onChainSet: { ...CONFIG_2_OF_3, threshold: 3 } }), nativeSymbol: 'test ETH' }, memoryStore())))?.message.includes('does not match'));
  check('describeMultisigCall: a token transfer on a known token and a contract call',
    describeMultisigCall({ to: RECIPIENT, value: 0n, data: ethers.getBytes(new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [S5.address, 1500000n])) }, 'test ETH', [{ contract: RECIPIENT, symbol: 'USDC', decimals: 6 }]) ===
      `Transfer 1.5 USDC (1500000 base units) to ${S5.address}, through the token contract ${RECIPIENT}.` &&
      describeMultisigCall({ to: RECIPIENT, value: 0n, data: new Uint8Array([1, 2, 3, 4, 5]) }, 'test ETH').includes('function selector 0x01020304') &&
      describeMultisigCall({ to: RECIPIENT, value: 1000n, data: new Uint8Array(0) }, 'test ETH') === `Send 0.000000000000001 test ETH (1000 wei) to ${RECIPIENT}.`);
}

// ===========================================================================
console.log('check-multisig: a rebuilt identical request replaces the stale record (finding 2)');
// ===========================================================================
{
  const fresh = memoryStore();
  const r0 = await createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, fresh);
  const calls = [{ to: RECIPIENT, value: 10n ** 14n, data: new Uint8Array(0) }];
  const node = multisigNode();
  const first = await prepareMultisigRequest({ record: r0, calls, node, nativeSymbol: 'test ETH' }, fresh);
  const again = await prepareMultisigRequest({ record: r0, calls, node, nativeSymbol: 'test ETH' }, fresh);
  check('rebuilding an identical request yields the same request id (same call data and nonce)', again.requestId === first.requestId);
  const stored = (await listMultisigRecords(SEPOLIA, fresh))[0];
  const sameId = stored.operations.filter((o) => o.requestId.toLowerCase() === first.requestId.toLowerCase());
  check('only ONE operation is kept for that request id — the new collecting one, not a stale abandoned duplicate (finding 2)',
    sameId.length === 1 && sameId[0].status === 'collecting' && stored.operations.length === 1, JSON.stringify(stored.operations.map((o) => o.status)));
  // The mutant: without the dedupe filter, the stale abandoned record survives
  // and History would show the request id twice.
  const mDedupe = await importMutant('src/wallet/multisig.ts',
    '    r.operations = r.operations.filter((o) => o.requestId.toLowerCase() !== op.requestId.toLowerCase());\n    r.operations.unshift(op);',
    '    r.operations.unshift(op);');
  const ms = memoryStore();
  const mr = await mDedupe.createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, ms);
  await mDedupe.prepareMultisigRequest({ record: mr, calls, node: multisigNode(), nativeSymbol: 'test ETH' }, ms);
  await mDedupe.prepareMultisigRequest({ record: mr, calls, node: multisigNode(), nativeSymbol: 'test ETH' }, ms);
  const mStored = (await mDedupe.listMultisigRecords(SEPOLIA, ms))[0];
  check('M-dedupe caught: without the filter two records share one request id', mStored.operations.length === 2 &&
    mStored.operations[0].requestId.toLowerCase() === mStored.operations[1].requestId.toLowerCase());
}

// ===========================================================================
console.log('check-multisig: funding refusals (findings 3 and 4 of the 2026-10-10 emulator pass)');
// ===========================================================================
{
  const fresh = memoryStore();
  const r0 = await createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, fresh);
  const calls = [{ to: RECIPIENT, value: 10n ** 14n, data: new Uint8Array(0) }];
  const op0 = await prepareMultisigRequest({ record: r0, calls, node: multisigNode(), nativeSymbol: 'test ETH' }, fresh);
  const { op: ready0 } = addMultisigApproval(r0, op0, approveMultisigRequest(op0.request, S5).signature);
  const submit = (node, bundler) => prepareMultisigSubmission({ record: r0, op: ready0, nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, transportFor: transportsFor(node, bundler) });

  // (4) The wallet's own pre-check on an empty multisig: the multisig's own sentences.
  const empty = await caught(() => submit(multisigNode({ balance: 0n }), fakeBundler()));
  check('empty multisig: AaFundingError titled "This multisig account needs funds first."', empty instanceof AaFundingError && empty.title === AA_MULTISIG_FUNDING_TITLE && AA_MULTISIG_FUNDING_TITLE === 'This multisig account needs funds first.', empty?.title);
  check('…its message is the multisig’s own, exact (no "smart account", no "owner address")',
    empty?.message ===
      `Insufficient funds: the multisig pays its own network fee from its balance and EntryPoint deposit, and sending 100000000000000 wei plus its network fee exceeds the balance of 0 wei held by the multisig ${r0.address}. Fund the multisig address ${r0.address}, then review again. A multisig can receive funds before it is deployed; its first operation deploys it.`,
    empty?.message);
  const emptyText = multisigSubmitErrorText(empty, { record: r0, deploys: true, symbol: 'test ETH' });
  check('…the screen text: title, message, then the fund-and-retry note (no estimate figure: the bundler was not asked)',
    emptyText === `This multisig account needs funds first.\n\n${empty.message}\n\n${MULTISIG_FUND_AND_RETRY}` && !/smart account|owner address/.test(emptyText), emptyText);

  // AA21 from the bundler's estimate: the multisig wording, and a figure.
  const AA21 = "UserOperation reverted during simulation with reason: AA21 didn't pay prefund";
  const est = await caught(() => submit(multisigNode(), fakeBundler({ estimateError: AA21 })));
  check('AA21 at the estimate: AaFundingError with the multisig title and wording, the bundler’s words kept',
    est instanceof AaFundingError && est.title === AA_MULTISIG_FUNDING_TITLE && est.message.startsWith('Insufficient funds: the multisig pays its own network fee') &&
      est.message.endsWith(`\n\nThe bundler's message: ${AA21}`) && !/smart account|owner address/.test(est.message), est?.message);
  const noQuote = multisigSubmitErrorText(est, { record: r0, deploys: true, symbol: 'test ETH', lastQuote: null, funds: { balance: 2n * 10n ** 15n, deposit: 0n } });
  check('…without an earlier quote on Sepolia: "unknown because the estimate itself was refused" + the RECORDED range, then fund-and-retry',
    noQuote === `This multisig account needs funds first.\n\n${est.message}\n\nThe exact amount is unknown because the estimate itself was refused. ${MULTISIG_RECORDED_DEPLOY_COST_NOTE}\n\n${MULTISIG_FUND_AND_RETRY}`, noQuote);
  check('the recorded range is the run’s figures, labelled as recorded, not a quote, exact',
    MULTISIG_RECORDED_DEPLOY_COST_NOTE ===
      'For scale only: in this wallet’s recorded test run on Ethereum Sepolia (2026-10-10), the first operation of a 2-of-3 multisig, which also deployed it, was quoted at a worst-case network fee of about 0.0036 to 0.0066 test ETH at different fee levels and actually cost about 0.0020 test ETH. That is a recorded range, not a quote for this operation; fees change.');
  check('…a non-deploying operation names the recorded later-operation figure instead',
    multisigFundingFigure({ chain: SEPOLIA, deploys: false, lastQuote: null, funds: null, symbol: 'test ETH' }) === `The exact amount is unknown because the estimate itself was refused. ${MULTISIG_RECORDED_LATER_COST_NOTE}` &&
      /about 0\.0013 to 0\.0023 test ETH .* actually cost about 0\.0008 test ETH/.test(MULTISIG_RECORDED_LATER_COST_NOTE));
  check('…on another network no recorded figure is shown (they are Sepolia figures)',
    multisigFundingFigure({ chain: 'eip155:84532', deploys: true, lastQuote: null, funds: null, symbol: 'test ETH' }) === 'The exact amount is unknown because the estimate itself was refused.');
  const E18 = 10n ** 18n;
  const lq = { fee: 6_600_000n * 10n ** 9n, amount: 10n ** 14n }; // 0.0066 fee, 0.0001 amount
  check('with the last accepted quote: the worst case from it and the shortfall against the balance read now, exact',
    multisigFundingFigure({ chain: SEPOLIA, deploys: true, lastQuote: lq, funds: { balance: 2n * 10n ** 15n, deposit: 0n }, symbol: 'test ETH' }) ===
      'The last accepted quote for this operation had a worst-case network fee of 0.0066 test ETH. At that figure the balance must hold 0.0067 test ETH (the amount 0.0001 test ETH plus the fee). It holds 0.002 test ETH, so send at least 0.0047 test ETH to the multisig, and a little more, because the fee changes between quotes.',
    multisigFundingFigure({ chain: SEPOLIA, deploys: true, lastQuote: lq, funds: { balance: 2n * 10n ** 15n, deposit: 0n }, symbol: 'test ETH' }));
  check('…a deposit pays the fee first (EntryPoint v0.7), so it lowers what the balance must hold, exact',
    multisigFundingFigure({ chain: SEPOLIA, deploys: false, lastQuote: lq, funds: { balance: 2n * 10n ** 15n, deposit: 10n ** 15n }, symbol: 'test ETH' }) ===
      'The last accepted quote for this operation had a worst-case network fee of 0.0066 test ETH. The EntryPoint deposit of 0.001 test ETH pays the fee first, so at that figure the balance must hold 0.0057 test ETH (the amount 0.0001 test ETH plus the rest of the fee). It holds 0.002 test ETH, so send at least 0.0037 test ETH to the multisig, and a little more, because the fee changes between quotes.');
  check('…a balance that covered the last quote: the fee rose since; no invented figure',
    /which would have covered that quote, so the fee or the gas estimate has risen since; the new figure is unknown/.test(
      multisigFundingFigure({ chain: SEPOLIA, deploys: true, lastQuote: lq, funds: { balance: E18, deposit: 0n }, symbol: 'test ETH' })));
  const withQuote = multisigSubmitErrorText(est, { record: r0, deploys: true, symbol: 'test ETH', lastQuote: lq, funds: { balance: 2n * 10n ** 15n, deposit: 0n } });
  check('…the screen text uses the last quote when there is one (and no recorded range)', withQuote.includes('The last accepted quote for this operation') && !withQuote.includes('For scale only'));

  // (3) Never the funding advice on a fee-rose or any other refusal.
  const rose = new AaFeeRoseError('The bundler\'s minimum fee rose: it now asks for more.', 'floor');
  const roseText = multisigSubmitErrorText(rose, { record: r0, deploys: true, symbol: 'test ETH' });
  check('a fee-rose refusal gets NO fund-and-retry note and no figure (finding 3)', !roseText.includes(MULTISIG_FUND_AND_RETRY) && !roseText.includes('estimate itself') && roseText.startsWith('The network fee rose.'), roseText);
  const other = multisigSubmitErrorText(new Error('RPC error -32602: something else'), { record: r0, deploys: true, symbol: 'test ETH' });
  check('any other refusal gets NO funding advice either (shown as its message)', other === 'RPC error -32602: something else');
  const rawAa21 = multisigSubmitErrorText(new Error(`RPC error -32500: ${AA21}`), { record: r0, deploys: false, symbol: 'test ETH', lastQuote: null, funds: null });
  check('a raw AA21 at submission: the multisig funding title and sentence, a figure, then fund-and-retry',
    rawAa21.startsWith(`This multisig account needs funds first.\n\nThe multisig ${r0.address} cannot pay for this operation's network fee: the multisig pays its own network fee from its balance and EntryPoint deposit, and they are too small. Fund the multisig address ${r0.address}, then try again.`) &&
      rawAa21.includes(MULTISIG_RECORDED_LATER_COST_NOTE) && rawAa21.endsWith(MULTISIG_FUND_AND_RETRY) && !/smart account|owner address/.test(rawAa21), rawAa21);
  check('fund-and-retry note, exact', MULTISIG_FUND_AND_RETRY === 'The co-signer approvals stay valid while you fund the multisig, as long as no other operation uses this nonce: fund it, then review and submit again without collecting them again.');
  const screenSrc = readFileSync(join(HERE, '..', 'src', 'screens', 'MultisigScreen.tsx'), 'utf8');
  check('screen: both the quote and the submit failure go through multisigSubmitErrorText (no unconditional fund-and-retry)',
    (screenSrc.match(/setError\(await submitErrorText\(e\)\)/g) ?? []).length === 2 && /multisigSubmitErrorText\(e, \{/.test(screenSrc) && !/MULTISIG_FUND_AND_RETRY/.test(screenSrc) && /setLastQuote\(\{ recordId: selected\.id, requestId: op\.requestId, fee: prepared\.quote\.fee, amount: prepared\.quote\.amount \}\)/.test(screenSrc));
}

// ===========================================================================
console.log('check-multisig: deployment refresh, deposit, own addresses (findings 5, 7, 8)');
// ===========================================================================
{
  const fresh = memoryStore();
  const r0 = await createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, fresh);
  check('chain note: not deployed on-chain and not in the record → the deploy note', multisigChainNote(r0, { deployed: false, problems: [] }) === MULTISIG_DEPLOY_NOTE);
  const deployedNode = multisigNode({ deployed: new Set([r0.address]) });
  const refreshed = await refreshMultisigDeployment(deployedNode, r0, fresh);
  const stored = (await listMultisigRecords(SEPOLIA, fresh))[0];
  check('refresh after a deploying operation: "Deployed; … match this record." and the record is stored as deployed (finding 5)',
    refreshed.note === MULTISIG_DEPLOYED_MATCH_NOTE && MULTISIG_DEPLOYED_MATCH_NOTE === 'Deployed; its signer set and threshold on-chain match this record.' && refreshed.record.deployed.deployed === true && stored.deployed.deployed === true);
  const lagging = await refreshMultisigDeployment(multisigNode(), stored, fresh);
  check('the receipt said deployed but the endpoint shows no code yet: never "Not deployed yet"', lagging.note === MULTISIG_DEPLOYED_NOT_VISIBLE_NOTE && !lagging.note.startsWith('Not deployed yet'));
  const problems = await refreshMultisigDeployment(multisigNode({ deployed: new Set([r0.address]), onChainSet: { ...CONFIG_2_OF_3, threshold: 3 } }), stored, fresh);
  check('a mismatch on-chain is still reported', problems.note.startsWith('On-chain check: ') && problems.note.includes('threshold on-chain is 3'));
  const screenSrc = readFileSync(join(HERE, '..', 'src', 'screens', 'MultisigScreen.tsx'), 'utf8');
  const backHandler = screenSrc.slice(screenSrc.indexOf('title="Back to the multisig"'), screenSrc.indexOf('title="Back to the multisig"') + 700);
  check('screen: "Back to the multisig" re-reads the records and re-opens the detail (a fresh on-chain read), and the receipt refreshes the note',
    /reload\(\)\.then\(/.test(backHandler) && /openDetail\(list\.find\(\(r\) => r\.id === id\) \?\? selected\)/.test(backHandler) &&
      /refreshChainNote\(list\?\.find\(\(r\) => r\.id === submitted\.id\) \?\? submitted\)/.test(screenSrc) && /refreshMultisigDeployment\(node, record\)/.test(screenSrc) && !/readMultisigOnChain/.test(screenSrc));

  // Item 3 emulator finding 3: the LIST said "not deployed yet" for a
  // deployed multisig until its detail was opened.
  {
    const ls = memoryStore();
    const a = await createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, ls);
    const b = await createMultisigRecord({ chain: SEPOLIA, config: { ...CONFIG_2_OF_3, threshold: 3 }, localSigner: S0.address }, ls);
    const counter = { n: 0 };
    const node = multisigNode({ deployed: new Set([a.address]), counter });
    const changed = await refreshMultisigListDeployments(node, await listMultisigRecords(SEPOLIA, ls), ls);
    const after = await listMultisigRecords(SEPOLIA, ls);
    check('list refresh: a record stored undeployed whose address has code on the node reads "deployed" afterwards; the other stays undeployed',
      JSON.stringify(changed) === JSON.stringify([a.id]) && after.find((r) => r.id === a.id).deployed.deployed === true && after.find((r) => r.id === b.id).deployed.deployed === false);
    check('…one eth_getCode read per undeployed record and nothing else', counter.n === 2);
    counter.n = 0;
    await refreshMultisigListDeployments(node, after, ls);
    check('…a record already stored as deployed is not read again', counter.n === 1);
    const failing = async () => { throw new TypeError('fetch failed: Unable to resolve host'); };
    const fs = memoryStore();
    const c = await createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, fs);
    const before = JSON.stringify(await listMultisigRecords(SEPOLIA, fs));
    const none = await refreshMultisigListDeployments(failing, await listMultisigRecords(SEPOLIA, fs), fs);
    check('…a failed read keeps the stored facts, throws nothing and changes nothing',
      none.length === 0 && JSON.stringify(await listMultisigRecords(SEPOLIA, fs)) === before && (await listMultisigRecords(SEPOLIA, fs))[0].id === c.id);
    const emptyCode = async (method) => (method === 'eth_getCode' ? '0x' : null);
    check('…an address without code stays "not deployed yet"', (await refreshMultisigListDeployments(emptyCode, await listMultisigRecords(SEPOLIA, fs), fs)).length === 0);
    const screen = readFileSync(join(HERE, '..', 'src', 'screens', 'MultisigScreen.tsx'), 'utf8');
    const focus = screen.slice(screen.indexOf('useFocusEffect('), screen.indexOf('useFocusEffect(') + 1100);
    check('screen: on focus the list is read, every undeployed record on the active network is refreshed, and the list re-read when one changed',
      /reload\(\)\s*\.then\(async \(list\) => \{/.test(focus) && focus.includes('const changed = await refreshMultisigListDeployments(node, list);') &&
        focus.includes('if (changed.length > 0 && active) await reload();') && focus.includes('[reload, setError, node]'));
    const mList = await importMutant('src/wallet/multisig.ts', '      await markMultisigDeployed(record.id, {}, store);\n      changed.push(record.id);\n', '');
    const ms = memoryStore();
    const m0 = await mList.createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, ms);
    await mList.refreshMultisigListDeployments(multisigNode({ deployed: new Set([m0.address]) }), await listMultisigRecords(SEPOLIA, ms), ms);
    check('M-list caught: without the write the list still says "not deployed yet"', (await listMultisigRecords(SEPOLIA, ms))[0].deployed.deployed === false);
  }

  // (6) Errors render above the actions, never after Back.
  check('screen: the shell no longer renders the error after the phase (below Back); every phase places {errorBox} itself',
    !/\{children\}\s*\{errorBox\}/.test(screenSrc) && (screenSrc.match(/\{errorBox\}/g) ?? []).length >= 13);
  const collect = screenSrc.slice(screenSrc.indexOf("if (phase === 'collect'"), screenSrc.indexOf("if ((phase === 'confirm'"));
  // Finding 6: the error now sits ABOVE the approval inputs (right under
  // "2. Add each approval you receive"), so a keyboard-open error is not
  // pushed off-screen below "Add an approval from a file".
  check('screen: in the collect phase the error sits above the approval inputs (after "2. Add each approval", before the scan/paste/file buttons and "3. Submit")',
    collect.indexOf('{errorBox}') > collect.indexOf('2. Add each approval you receive') &&
      collect.indexOf('{errorBox}') < collect.indexOf('Add approval') &&
      collect.indexOf('{errorBox}') < collect.indexOf('Add an approval from a file') &&
      collect.indexOf('{errorBox}') < collect.indexOf('3. Submit'));
  check('screen: the shell scroll view keeps keyboardShouldPersistTaps="handled" (one tap on the approval buttons with the keyboard open, as the note views do — finding 6)',
    /<ScrollView style=\{screenStyle\(theme\)\}[^>]*keyboardShouldPersistTaps="handled"/.test(screenSrc));
  check('screen: the file-pick catch routes through multisigFileRefusal, never raw fail(e) (finding 1)',
    /picked = await pickRecordFile\(\);\s*\}\s*catch \(e\) \{[\s\S]*?setError\(multisigFileRefusal\(e\)\);/.test(screenSrc));
  check('screen: the collect phase uses the co-signer bar (no "✓ This wallet’s signer … signs last" line)',
    /<MultisigWeightBar progress=\{p\} \/>/.test(collect) && !/signs last when you submit/.test(screenSrc) && /multisigNotReadyHint\(p\)/.test(collect) && /multisigSubmitApprovalsLine\(/.test(screenSrc));
  const viewsSrc = readFileSync(join(HERE, '..', 'src', 'screens', 'MultisigViews.tsx'), 'utf8');
  check('views: the bar shows multisigCosignerBarLabel and, separately, multisigLocalSignsLine only when the co-signers do NOT meet the threshold alone (finding 4)',
    /multisigCosignerBarLabel\(progress\)/.test(viewsSrc) && /multisigLocalSignsLine\(progress\)/.test(viewsSrc) && /progress\.cosignerWeight \/ need/.test(viewsSrc) &&
      /progress\.cosignersAlone \? null : \(/.test(viewsSrc));

  // (7) The EntryPoint deposit next to the balance.
  const DEP = 697_000_000_000_000n;
  const fundsNode = multisigNode();
  const depositNode = async (method, params) => {
    if (method === 'eth_call' && same(params[0].to, ENTRYPOINT_V07) && params[0].data.startsWith(sel('balanceOf(address)'))) {
      return same('0x' + params[0].data.slice(34, 74), r0.address) ? word(DEP) : word(0);
    }
    return fundsNode(method, params);
  };
  const held = await readMultisigFunds(depositNode, r0.address);
  check('readMultisigFunds: the balance and the EntryPoint balanceOf(account) deposit', held.balance === 10n ** 18n && held.deposit === DEP);
  const broken = await readMultisigFunds(async () => { throw new Error('down'); }, r0.address);
  check('…each is null when it cannot be read (never throws)', broken.balance === null && broken.deposit === null);
  const fmt = (wei) => `${ethers.formatEther(wei)} test ETH`;
  check('list line: balance · "EntryPoint deposit (pays fees first): X", exact',
    multisigFundsLine({ balance: 507_000_000_000_000n, deposit: DEP }, fmt) === '0.000507 test ETH · EntryPoint deposit (pays fees first): 0.000697 test ETH' &&
      MULTISIG_DEPOSIT_ROW_LABEL === 'EntryPoint deposit (pays fees first)' && multisigFundsLine(undefined, fmt) === 'Balance loading…',
    multisigFundsLine({ balance: 507_000_000_000_000n, deposit: DEP }, fmt));
  check('screen: the detail view shows the deposit row with its note, and the list uses multisigFundsLine',
    /label=\{MULTISIG_DEPOSIT_ROW_LABEL\}/.test(screenSrc) && /sub=\{MULTISIG_DEPOSIT_NOTE\}/.test(screenSrc) && /multisigFundsLine\(funds\[r\.address\], formatNative\)/.test(screenSrc) && /readMultisigFunds\(node, r\.address\)/.test(screenSrc));

  // (8) The wallet's own multisig addresses, named as every screen names them.
  const own = await ownMultisigAddresses(SEPOLIA, fresh);
  check('ownMultisigAddresses: every stored multisig on the network, labelled "Multisig 1 (2-of-3)"', own.length === 1 && own[0].address === r0.address && own[0].label === 'Multisig 1 (2-of-3)', JSON.stringify(own));
  check('…none on another network, and none from an unreadable list', (await ownMultisigAddresses('eip155:84532', fresh)).length === 0 &&
    (await ownMultisigAddresses(SEPOLIA, { getItem: async () => { throw new Error('locked'); }, setItem: async () => undefined, removeItem: async () => undefined })).length === 0);
  const hookSrc = readFileSync(join(HERE, '..', 'src', 'wallet', 'useOwnAddresses.ts'), 'utf8');
  check('useOwnEvmAddresses (success screen, "Save as contact") includes the stored multisigs of the active network',
    /ownMultisigAddresses\(evmChain\.caip2\)/.test(hookSrc) && /ownWalletAddresses\(accountList, aa, multisigs\)/.test(hookSrc));
}

// ===========================================================================
console.log('check-multisig: refusals (WalletConnect, browser, ERC-1271, guardians, sessions, passkeys, 7702)');
// ===========================================================================
{
  check('WalletConnect / browser address: null for a multisig active account', walletConnectAddressFor({ watchOnly: false, multisig: true }, S0.address) === null && walletConnectAddressFor({ watchOnly: false }, S0.address) === S0.address);
  check('the multisig type never signs messages and is labelled transactions only', aaAccountTypeSignsMessages('kernel-multisig') === false && /transactions only/.test(aaAccountTypeLabel('kernel-multisig')));
  const counter = { n: 0 };
  const counting = () => async () => {
    counter.n += 1;
    throw new Error('no request expected');
  };
  const cfg = await getAaConfig(SEPOLIA, memoryStore());
  const e = await caught(() => createAaClientFromConfig({ ...cfg, bundlerUrl: BUNDLER_URL, factory: KERNEL_V3_3.factory, kernelValidator: KERNEL_V3_3.ecdsaValidator, accountType: 'kernel-v3.3' }, { nodeUrl: NODE_URL, chainId: 11155111n, accountIndex: record.id, transportFor: counting }));
  check('createAaClientFromConfig (the bundle WalletConnect, the browser, sessions, guardians, inheritance and passkeys use) refuses a multisig id, zero requests', e?.message === MULTISIG_CONFIG_BUNDLE_REFUSAL && counter.n === 0, e?.message);
  const node = multisigNode();
  const bundler = fakeBundler();
  const bundle = createMultisigAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, chainId: 11155111n, accountId: record.id, account: record.address, config: CONFIG_2_OF_3, index: 0n, submitter: S0.address, approvals: [], transportFor: transportsFor(node, bundler) });
  const before = node.calls.length;
  const se = await caught(() => signHashAsSmartAccount(bundle, S0, new Uint8Array(32), record.address));
  check('signHashAsSmartAccount refuses a multisig with MULTISIG_ERC1271_REFUSAL before any request', se?.message === MULTISIG_ERC1271_REFUSAL && node.calls.length === before);
  check('the multisig spec has no ERC-1271 signing', bundle.spec.signErc1271 === undefined);
  const wcSrc = readFileSync(join(HERE, '..', 'src', 'wallet', 'walletconnect.ts'), 'utf8');
  check('a stored WalletConnect smart binding accepts only kernel-v3.3 or simple (source pin)', wcSrc.includes("(v.accountType !== 'kernel-v3.3' && v.accountType !== 'simple')"));
  const browserSrc = readFileSync(join(HERE, '..', 'src', 'wallet', 'browser-bridge.ts'), 'utf8');
  check('the browser bridge never builds a multisig bundle (source check)', !/createMultisigAaClient|kernel-multisig/.test(browserSrc));
  check('route allow list for an active multisig: Multisig, Receive and (read-only) Approvals allowed; Send, Swap, Connections, Apps, Sessions, Guardians, Inheritance, Passkey, UpgradeAccount, Staking refused',
    multisigRouteRefusal('Multisig') === null && multisigRouteRefusal('Receive') === null && multisigRouteRefusal('Approvals') === null &&
      ['Send', 'Swap', 'Connections', 'Apps', 'Sessions', 'Guardians', 'Inheritance', 'Passkey', 'UpgradeAccount', 'OwnerRotation', 'ProveOwnership', 'SpendingLimits', 'Staking', 'SomeFutureRoute'].every((r) => multisigRouteRefusal(r) !== null) &&
      MULTISIG_ALLOWED_ROUTES.length === 13 &&
      JSON.stringify(MULTISIG_ALLOWED_ROUTES) === JSON.stringify(['Home', 'Activity', 'Nfts', 'NftDetail', 'Tokens', 'Approvals', 'Settings', 'Contacts', 'ImportKey', 'Portfolio', 'PriceAlerts', 'Receive', 'Multisig']));
  check('…and a watch-only account is refused the Multisig screen by name', watchOnlyRouteRefusal('Multisig')?.startsWith('Multi-signature accounts is not available for a watch-only account'));
  check('aaTypeFeatures / aaReadinessBlock: the multisig row first, then Kernel', aaTypeFeatures('kernel-multisig').join() === 'multisig,kernel-smart-account' && aaReadinessBlock(MAINNET, 'kernel-multisig') === 'multisig' && aaReadinessBlock(SEPOLIA, 'kernel-multisig') === null);
}

// ===========================================================================
console.log('check-multisig: readiness gating on mainnet (refused before any request)');
// ===========================================================================
{
  const f = featureReadiness('multisig');
  check('readiness row: testnet-only, enforced, cites C1, F-62 and T-70', f.status === 'testnet-only' && f.enforced && ['C1', 'F-62', 'T-70'].every((i) => f.evidence.includes(i)));
  const st = memoryStore();
  const created = await caught(() => createMultisigRecord({ chain: MAINNET, config: CONFIG_2_OF_3, localSigner: S0.address }, st));
  check('create on mainnet: the multisig refusal, nothing stored', isRefusal(created) && created.message === readinessRefusal('multisig') && st._map.size === 0);
  const counter = { n: 0 };
  const countingNode = async () => {
    counter.n += 1;
    throw new Error('no request expected');
  };
  check('network check on mainnet: refused, zero requests', isRefusal(await caught(() => checkMultisigNetwork(countingNode, MAINNET))) && counter.n === 0);
  const mainnetRecord = { ...record, chain: MAINNET };
  const pr = await caught(() => prepareMultisigRequest({ record: mainnetRecord, calls: [{ to: RECIPIENT, value: 1n, data: new Uint8Array(0) }], node: countingNode, nativeSymbol: 'ETH' }, memoryStore()));
  check('build a request on mainnet: refused, zero requests', isRefusal(pr) && pr.message === readinessRefusal('multisig') && counter.n === 0);
  const sub = await caught(() => prepareMultisigSubmission({ record: mainnetRecord, op: { ...op, status: 'collecting' }, nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, transportFor: () => countingNode }));
  check('submit on mainnet: refused, zero requests', isRefusal(sub) && counter.n === 0);
  const cb = await caught(() => createMultisigAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, chainId: 1n, accountId: record.id, account: record.address, config: CONFIG_2_OF_3, index: 0n, submitter: S0.address, approvals: [], transportFor: () => countingNode }));
  check('the multisig bundle on mainnet: the multisig refusal, zero requests', isRefusal(cb) && cb.message === readinessRefusal('multisig') && counter.n === 0);
  const mainReq = buildMultisigSigningRequest({ chainId: 1n, account: record.address, calls: [{ to: RECIPIENT, value: 1n, data: new Uint8Array(0) }], nonce: 0n });
  const mainPayload = JSON.stringify({ type: MULTISIG_REQUEST_PAYLOAD, version: 1, request: mainReq, account: { ...JSON.parse(exportMultisigAccount(record).json), chainId: '1' }, calls: [{ to: RECIPIENT, value: '1', data: '0x' }] });
  const rv = await caught(() => reviewMultisigRequestAsCosigner(mainPayload, { activeChain: MAINNET, activeAddress: S5.address, ownAccounts: [], records: [], nativeSymbol: 'ETH' }));
  check('co-signer review on mainnet: refused', isRefusal(rv) && rv.message === readinessRefusal('multisig'));
  // sendAa refuses a multisig bundle whose chain is a main network.
  const node = multisigNode();
  const bundler = fakeBundler();
  const bundle = createMultisigAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, chainId: 11155111n, accountId: record.id, account: record.address, config: CONFIG_2_OF_3, index: 0n, submitter: S0.address, approvals: [], transportFor: transportsFor(node, bundler) });
  const se = await caught(() => sendAa({ ...bundle, chainId: 1n }, S0, { kind: 'aa', accountType: 'kernel-multisig', calls: [], sender: record.address }));
  check('sendAa refuses a multisig operation on a main network', isRefusal(se) && se.message === readinessRefusal('multisig'));
}

// ===========================================================================
console.log('check-multisig: mutation checks (broken copies must be caught)');
// ===========================================================================
{
  // M1 — the threshold: the app's ready flag always true.
  const m1 = await importMutant('src/wallet/multisig.ts', '    ready: weight >= record.threshold,\n', '    ready: true,\n');
  const fresh = { ...op, status: 'collecting', approvals: [], approvalIds: [] };
  check('M1 caught: without the threshold check the progress says ready at weight 1 of 2 (the real one does not)', m1.multisigWeightProgress(record, fresh).ready === true && multisigWeightProgress(record, fresh).ready === false);
  const node = multisigNode();
  const bundler = fakeBundler();
  const m1e = await caught(() => m1.prepareMultisigSubmission({ record, op: fresh, nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, transportFor: transportsFor(node, bundler) }));
  check('M1 caught: the mutant goes to the bundler instead of refusing with the threshold sentence', m1e?.message !== multisigThresholdNotReached(1, 2) && bundler.calls.some((c) => c.method === 'eth_estimateUserOperationGas'));

  // M2 — the submitter rule: the local signer's approval accepted.
  const m2 = await importMutant('src/wallet/multisig.ts', '  if (sameAddress(added.address, record.localSigner)) throw new Error(MULTISIG_SUBMITTER_APPROVAL_REFUSAL);\n', '');
  const own = JSON.stringify(approveMultisigRequest(op.request, S0));
  let m2ok = false;
  try {
    m2ok = m2.addMultisigApproval(record, fresh, own).added.address === S0.address;
  } catch {
    m2ok = false;
  }
  check('M2 caught: without the submitter rule the wallet’s own approval is counted (the real one refuses)', m2ok && throwsWith(() => addMultisigApproval(record, fresh, own), MULTISIG_SUBMITTER_APPROVAL_REFUSAL));

  // M3 — the readiness gate in createMultisigRecord removed: the mainnet refusal is no longer the multisig one.
  const m3 = await importMutant('src/wallet/multisig.ts', "  assertFeatureAllowed('multisig', params.chain);\n  assertFeatureAllowed('kernel-smart-account', params.chain);", "  assertFeatureAllowed('kernel-smart-account', params.chain);");
  const m3e = await caught(() => m3.createMultisigRecord({ chain: MAINNET, config: CONFIG_2_OF_3, localSigner: S0.address }, memoryStore()));
  check('M3 caught: without the multisig gate the create refusal is not the multisig readiness text', m3e?.message !== readinessRefusal('multisig'));

  // M4 — the readiness gate in prepareMultisigRequest removed: requests reach the node on mainnet.
  const m4 = await importMutant('src/wallet/multisig.ts', "  const { record, calls, node } = params;\n  assertFeatureAllowed('multisig', record.chain);", '  const { record, calls, node } = params;');
  const counter = { n: 0 };
  const countingNode = async () => {
    counter.n += 1;
    throw new Error('no request expected');
  };
  await caught(() => m4.prepareMultisigRequest({ record: { ...record, chain: MAINNET }, calls: [{ to: RECIPIENT, value: 1n, data: new Uint8Array(0) }], node: countingNode, nativeSymbol: 'ETH' }, memoryStore()));
  check('M4 caught: without the gate a mainnet request reaches the node (the real one makes zero requests)', counter.n > 0);

  // M5 — the readiness gate of the multisig bundle (aa.ts) removed.
  const m5 = await importMutant('src/wallet/aa.ts', "  assertFeatureAllowed('multisig', caip2);\n", '');
  const m5e = await caught(() => m5.createMultisigAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, chainId: 1n, accountId: record.id, account: record.address, config: CONFIG_2_OF_3, index: 0n, submitter: S0.address, approvals: [], transportFor: () => countingNode }));
  check('M5 caught: without the bundle gate the refusal is not the multisig readiness text', m5e?.message !== readinessRefusal('multisig'));

  // M6 — the ERC-1271 refusal removed: the generic "no ERC-1271 support" text appears instead.
  const m6 = await importMutant('src/wallet/aa.ts', "  if (bundle.accountType === 'kernel-multisig' || bundle.multisig) throw new Error(MULTISIG_ERC1271_REFUSAL);\n", '');
  const node6 = multisigNode();
  const b6 = m6.createMultisigAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, chainId: 11155111n, accountId: record.id, account: record.address, config: CONFIG_2_OF_3, index: 0n, submitter: S0.address, approvals: [], transportFor: transportsFor(node6, fakeBundler()) });
  const m6e = await caught(() => m6.signHashAsSmartAccount(b6, S0, new Uint8Array(32), record.address));
  check('M6 caught: without the multisig refusal the plain-language reason is lost', m6e?.message !== MULTISIG_ERC1271_REFUSAL);

  // M7 — the derivation refusal removed: a multisig id reaches the generic index error.
  const m7 = await importMutant('src/wallet/accounts.ts', '  if (isMultisigAccountId(accountIndex)) throw new Error(MULTISIG_NO_DERIVATION);\n', '');
  check('M7 caught: without the refusal the derivation error loses its plain sentence', !throwsWith(() => m7.derivationArgsFor('eip155:1', multisigAccountId(0)), MULTISIG_NO_DERIVATION));

  // Fix slice for the 2026-10-10 emulator findings: each behaviour change, broken in a copy, must be caught.
  const r8 = { address: record.address, chain: SEPOLIA };
  // M8 (finding 3) — funding advice on every refusal.
  const m8 = await importMutant('src/wallet/multisig.ts', '  if (!funding) return base;\n', '');
  const m8text = m8.multisigSubmitErrorText(new Error('RPC error -32602: something else'), { record: r8, deploys: true, symbol: 'test ETH' });
  check('M8 caught: without the funding-only rule a non-funding refusal gets the fund-and-retry note (the real one does not)',
    m8text.includes(MULTISIG_FUND_AND_RETRY) && !multisigSubmitErrorText(new Error('RPC error -32602: something else'), { record: r8, deploys: true, symbol: 'test ETH' }).includes(MULTISIG_FUND_AND_RETRY));
  // M9 (finding 4) — the multisig wording in aa.ts removed: the smart-account text comes back.
  const m9 = await importMutant('src/wallet/aa.ts', '  if (p.multisig === true) return aaMultisigFundingMessage(p);\n', '');
  const m9msg = m9.aaFundingMessage({ sender: record.address, amount: 1n, fee: null, balance: 0n, sponsored: false, deployed: false, multisig: true });
  check('M9 caught: without the multisig branch the funding text says "smart account … (not the owner address)"', /smart account/.test(m9msg) && /owner address/.test(m9msg));
  // M10 (finding 2) — the co-signer weight needed counted as the whole threshold.
  const m10 = await importMutant('src/wallet/multisig.ts', '  const cosignerNeeded = Math.max(0, record.threshold - localWeight);\n', '  const cosignerNeeded = record.threshold;\n');
  const fresh10 = { ...op, status: 'collecting', approvals: [], approvalIds: [] };
  check('M10 caught: without subtracting this wallet’s weight the bar reads "weight 0 of 2 needed" (the real one: of 1)',
    m10.multisigCosignerBarLabel(m10.multisigWeightProgress(record, fresh10)).includes('of 2 needed') && multisigCosignerBarLabel(multisigWeightProgress(record, fresh10)).includes('of 1 needed'));
  // M11 (finding 9) — the "without this phone" condition inverted.
  const m11 = await importMutant('src/wallet/multisig.ts', '      if (fewest !== null) {\n', '      if (fewest === null) {\n');
  check('M11 caught: with the condition inverted the 2-of-3 line no longer says the co-signers can act without this phone',
    !m11.multisigExposureLine(CONFIG_2_OF_3, S0.address).includes('including the 2 co-signers without this phone') && multisigExposureLine(CONFIG_2_OF_3, S0.address).includes('including the 2 co-signers without this phone'));
  // M12 (finding 5) — the refresh no longer records the deployment.
  const m12 = await importMutant('src/wallet/multisig.ts', '    await markMultisigDeployed(record.id, {}, store).catch(() => undefined);\n', '');
  const s12 = memoryStore();
  const r12 = await m12.createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, s12);
  await m12.refreshMultisigDeployment(multisigNode({ deployed: new Set([r12.address]) }), r12, s12);
  check('M12 caught: without the write the stored record still says "not deployed" after the refresh', (await listMultisigRecords(SEPOLIA, s12))[0].deployed.deployed === false);
  // M13 (finding 6) — the engine refusal passed through without a period.
  const m13 = await importMutant('src/wallet/multisig.ts', '    throw new Error(asSentence(e instanceof Error ? e.message : String(e)));\n', '    throw e;\n');
  const opFresh = { ...op, status: 'collecting', approvals: [], approvalIds: [] };
  const s7sig = approveMultisigRequest(op.request, S7).signature;
  check('M13 caught: without the wrap the non-signer refusal has no period (the real one does)',
    throwsWith(() => m13.addMultisigApproval(record, opFresh, s7sig), `${S7.address} is not a signer of this multisig`) &&
      !throwsWith(() => m13.addMultisigApproval(record, opFresh, s7sig), `${S7.address} is not a signer of this multisig.`) &&
      throwsWith(() => addMultisigApproval(record, opFresh, s7sig), `${S7.address} is not a signer of this multisig.`));
  // M14 (finding 8) — the own-address label loses the shape.
  const m14 = await importMutant('src/wallet/multisig.ts', '    return records.map((r) => ({ address: r.address, label: multisigDisplayName(r) }));\n', '    return records.map((r) => ({ address: r.address, label: r.name }));\n');
  const s14 = memoryStore();
  await createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, s14);
  check('M14 caught: the mutant names the multisig "Multisig 1" instead of "Multisig 1 (2-of-3)"',
    (await m14.ownMultisigAddresses(SEPOLIA, s14))[0].label === 'Multisig 1' && (await ownMultisigAddresses(SEPOLIA, s14))[0].label === 'Multisig 1 (2-of-3)');
  // M15 (finding 8) — risk.ts no longer merges the multisigs into the own set.
  const realRisk = await import('../src/wallet/risk.ts');
  const m15 = await importMutant('src/wallet/risk.ts', '    ...multisigs.filter((m) => ADDRESS.test(m.address) && !findOwnAddress(m.address, listed)),\n', '');
  const codeless = async (method) => {
    if (method === 'eth_getCode') return '0x';
    throw new Error(`offline: ${method}`);
  };
  const riskOpts = { transport: codeless, url: NODE_URL, wallet: S0.address, to: record.address, chainCaip2: SEPOLIA, trackedTokens: [], loadOwnMultisigs: async () => [{ address: record.address, label: 'Multisig 1 (2-of-3)' }] };
  const realFacts = await realRisk.gatherRiskFacts(riskOpts);
  const m15Facts = await m15.gatherRiskFacts(riskOpts);
  check('M15 caught: without the merge a send to the own multisig is not "one of your own accounts" (the real one is)',
    realFacts.ownRecipient?.label === 'Multisig 1 (2-of-3)' && realFacts.firstInteractionApplicable === false && m15Facts.ownRecipient === undefined && m15Facts.firstInteractionApplicable === true);
}


// ===========================================================================
console.log('check-multisig: the multisig as an account in the switcher (phase 18 item 3)');
// ===========================================================================
{
  const M0 = multisigAccountId(0);
  const ids = await import('../src/wallet/account-ids.ts');
  const wo = await import('../src/wallet/watch-only.ts');
  const ms = await import('../src/wallet/multisig.ts');
  const acc = await import('../src/wallet/accounts.ts');
  const { createKeyVault } = await import('../src/wallet/storage.ts');
  const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');

  // --- The approval gate's target: NOTHING for a multisig (the phrase is never opened by a device check).
  check('approvalTargetFor: phrase → phrase, imported → its slot, watch-only / multisig / malformed → none',
    JSON.stringify(ids.approvalTargetFor(0)) === '{"kind":"phrase"}' && JSON.stringify(ids.approvalTargetFor(7)) === '{"kind":"phrase"}' &&
      JSON.stringify(ids.approvalTargetFor(IMPORTED_ACCOUNT_ID_BASE + 2)) === '{"kind":"imported","slot":2}' &&
      JSON.stringify(ids.approvalTargetFor(WATCH_ONLY_ACCOUNT_ID_BASE)) === '{"kind":"none"}' &&
      JSON.stringify(ids.approvalTargetFor(M0)) === '{"kind":"none"}' &&
      JSON.stringify(ids.approvalTargetFor(IMPORTED_ACCOUNT_ID_BASE + MAX_IMPORTED_SLOT + 1)) === '{"kind":"none"}' &&
      JSON.stringify(ids.approvalTargetFor(-1)) === '{"kind":"none"}');
  const countingBackend = () => {
    const items = new Map();
    const calls = { get: 0, set: 0, delete: 0 };
    const key = (k, o) => `${o?.keychainService ?? 'default'}|${k}`;
    return {
      calls,
      whenUnlockedThisDeviceOnly: 5,
      async getItemAsync(k, o) { calls.get += 1; return items.has(key(k, o)) ? items.get(key(k, o)) : null; },
      async setItemAsync(k, v, o) { calls.set += 1; items.set(key(k, o), v); },
      async deleteItemAsync(k, o) { calls.delete += 1; items.delete(key(k, o)); },
      canUseBiometricAuthentication: () => false,
    };
  };
  const gateReads = async (targetFor, id) => {
    const backend = countingBackend();
    const vault = createKeyVault(backend, { policy: 'off' });
    await vault.saveNewPhrase(TEST_MNEMONIC);
    vault.setApprovalTarget(targetFor(id));
    backend.calls.get = 0;
    const result = await vault.openPhraseForApproval('Unlock Shiba Wallet');
    return { result, reads: backend.calls.get };
  };
  const msGate = await gateReads(ids.approvalTargetFor, M0);
  const phraseGate = await gateReads(ids.approvalTargetFor, 0);
  check('a device check while a multisig is active: the ordinary prompt (fallback), ZERO secure-store reads',
    msGate.result.kind === 'fallback' && msGate.result.detail === null && msGate.reads === 0, JSON.stringify(msGate));
  check('…while a phrase account reads the secure store for the same check (the comparison is meaningful)', phraseGate.reads >= 1, JSON.stringify(phraseGate));
  const ctx = read('src/wallet/WalletContext.tsx');
  check('WalletContext.commitAccounts sets the target through approvalTargetFor(active)', ctx.includes('setApprovalTarget(approvalTargetFor(active));'));
  const mTarget = await importMutant('src/wallet/account-ids.ts', "  if (isPhraseAccountId(id)) return { kind: 'phrase' };\n  return { kind: 'none' };", "  return { kind: 'phrase' };");
  const mGate = await gateReads(mTarget.approvalTargetFor, M0);
  check('M16 caught: a target that treats a multisig like a phrase account opens the phrase (secure-store reads)', mGate.reads >= 1, JSON.stringify(mGate));

  // --- The multisig store feeds the account list: entries, the change listener, the name.
  const sL = memoryStore();
  let fired = 0;
  const off = ms.addMultisigStoreListener(() => {
    fired += 1;
  });
  const offThrowing = ms.addMultisigStoreListener(() => {
    throw new Error('listener failure');
  });
  const rec = await ms.createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, sL);
  check('a write of the multisig store notifies the listeners (a throwing listener never fails the write)', fired >= 1 && (await ms.listMultisigRecords(SEPOLIA, sL)).length === 1);
  const entries = await ms.multisigListEntries(sL);
  check('multisigListEntries: id, address, name, the shape label, the network and this wallet’s signer',
    entries.length === 1 && entries[0].id === rec.id && entries[0].address === rec.address && entries[0].name === 'Multisig 1' &&
      entries[0].label === 'Multisig 1 (2-of-3)' && entries[0].chain === SEPOLIA && entries[0].localSigner === S0.address, JSON.stringify(entries));
  const beforeRename = fired;
  await ms.renameMultisigRecord(rec.id, 'Treasury', sL);
  const renamed = await ms.multisigListEntries(sL);
  check('a rename notifies too and the label follows it', fired > beforeRename && renamed[0].label === 'Treasury (2-of-3)');
  const listed = acc.reconcileMultisigAccounts(acc.reconcileMultisigAccounts(acc.defaultAccountsState(), entries).state, renamed);
  check('reconcile takes the name from the record (the Multisig screen renames it)', listed.changed && listed.state.accounts.find((a) => a.index === rec.id)?.name === 'Treasury');
  const beforeWipe = fired;
  await ms.resetMultisigRecords(sL);
  check('the wipe (resetMultisigRecords) does not notify (the wipe resets the account list itself)', fired === beforeWipe);
  off();
  offThrowing();
  await ms.createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, memoryStore());
  check('an unsubscribed listener is not called', fired === beforeWipe);

  // --- WalletContext: multisigs are listed as accounts, never derived, never "accounts with a key".
  const derivedSrc = ctx.slice(ctx.indexOf('function derivedIndices('), ctx.indexOf('\n}\n', ctx.indexOf('function derivedIndices(')) + 2);
  const runDerived = async (text) => {
    mkdirSync(MUTANT_DIR, { recursive: true });
    mutants += 1;
    const file = join(MUTANT_DIR, `derived-${mutants}.ts`);
    writeFileSync(file, `type AccountsState = any;\nexport ${text}`);
    return (await import(pathToFileURL(file).href)).derivedIndices;
  };
  const listState = {
    accounts: [
      { index: 0, name: 'Account 1', hidden: false },
      { index: 1, name: 'Account 2', hidden: true },
      { index: IMPORTED_ACCOUNT_ID_BASE, name: 'Imported 1', hidden: false, imported: true },
      { index: WATCH_ONLY_ACCOUNT_ID_BASE, name: 'Watched 1', hidden: false, watchOnly: true, address: RECIPIENT },
      { index: M0, name: 'Multisig 1', hidden: false, multisig: true, address: rec.address },
    ],
    activeIndex: M0,
    nextIndex: 2,
  };
  const derivedIndices = await runDerived(derivedSrc);
  check('launch derives phrase indices only (the REAL derivedIndices from WalletContext.tsx): never a multisig id', JSON.stringify(derivedIndices(listState)) === '[0,1]');
  const mDerived = await runDerived(derivedSrc.replace(' && !a.multisig', ''));
  const mIdx = mDerived(listState);
  check('M17 caught: without the multisig filter the launch would derive the multisig id, which fails (MULTISIG_NO_DERIVATION) and would drop the wallet to onboarding',
    mIdx.includes(M0) && throwsWith(() => acc.deriveChainAccounts(seed, M0), MULTISIG_NO_DERIVATION));
  check('ensureDerived: a multisig row comes from the account store, never the phrase',
    ctx.includes('const all = multisigRowsFrom(await loadAccounts());') &&
      ctx.includes('!isImportedAccountId(i) && !isWatchOnlyAccountId(i) && !isMultisigAccountId(i) && derivedRef.current[i] === undefined'));
  check('launch and a new wallet reconcile the multisig store into the account list (public data, no prompt)',
    (ctx.match(/const \{ state, entries \} = await withStoredMultisigs\(withImported\);/g) ?? []).length === 2 &&
      ctx.includes('const next = reconcileMultisigAccounts(state, entries);') &&
      ctx.includes('if (next.changed) await reconcileStoredMultisigAccounts(entries).catch(() => undefined);'));
  check('…and every multisig store write reconciles again (listener), only while a wallet is open',
    ctx.includes('useEffect(() => addMultisigStoreListener(() => void refreshMultisigAccounts().catch(() => undefined)), [refreshMultisigAccounts]);') &&
      /const refreshMultisigAccounts = useCallback\(\s*\(\) =>\s*serialized\(async \(\) => \{\s*if \(statusRef\.current !== 'ready'\) return;/.test(ctx));
  check('accountList excludes multisigs; multisigAccounts carries the shape label; the active account can be a multisig',
    ctx.includes('.filter((a) => !a.watchOnly && !a.multisig).map((a) => ({') && ctx.includes('name: info?.label ?? a.name,') &&
      ctx.includes('multisigAccounts.find((a) => a.index === activeIndex) ??') && ctx.includes('multisig: true,\n            multisigInfo: info,'));
  check('the key import and the watch-only form treat a multisig as neither a phrase account nor a key',
    ctx.includes(".filter((a) => !a.imported && !a.watchOnly && !a.multisig)") && ctx.includes("kind: 'multisig' });"));
  check('watching a multisig address is refused with its own sentence',
    (() => {
      const r = wo.checkWatchAddress(rec.address, [{ name: 'Multisig 1 (2-of-3)', evmAddress: rec.address, kind: 'multisig' }]);
      return !r.ok && r.error === `This address is one of your multi-signature accounts: Multisig 1 (2-of-3) (${rec.address}). It is already listed in this wallet, so there is nothing to watch.`;
    })());

  // --- WalletConnect: loadAaBundle never builds a bundle for a multisig (the REAL callback body, run with fakes).
  const wc = read('src/wallet/WalletConnectContext.tsx');
  const start = wc.indexOf('const loadAaBundle = useCallback<AaBundleLoader>(');
  const bodyStart = wc.indexOf('async (accountIndex: number) => {', start);
  const bodyEnd = wc.indexOf('\n    [evmChain.caip2, evmChain.chainIdDecimal],', bodyStart);
  const loaderText = wc.slice(bodyStart, bodyEnd).replace(/,\s*$/, '');
  const runLoader = async (text) => {
    mkdirSync(MUTANT_DIR, { recursive: true });
    mutants += 1;
    const file = join(MUTANT_DIR, `loader-${mutants}.ts`);
    const idsUrl = pathToFileURL(join(HERE, '..', 'src', 'wallet', 'account-ids.ts')).href;
    writeFileSync(file, `import { isMultisigAccountId } from '${idsUrl}';\nexport function make(deps: any) {\n  const { getAaConfig, isAaConfigured, getEndpoint, createAaClientFromConfig, evmChain, EVM_CHAIN_ID } = deps;\n  return ${text};\n}\n`);
    const { make } = await import(pathToFileURL(file).href);
    const calls = { config: 0, endpoint: 0, build: 0 };
    const loader = make({
      getAaConfig: async () => { calls.config += 1; return { configured: true }; },
      isAaConfigured: () => true,
      getEndpoint: async () => { calls.endpoint += 1; return { url: NODE_URL }; },
      createAaClientFromConfig: () => { calls.build += 1; return { fake: true }; },
      evmChain: { caip2: SEPOLIA, chainIdDecimal: '11155111' },
      EVM_CHAIN_ID: 'eip155:1',
    });
    return { loader, calls };
  };
  {
    const { loader, calls } = await runLoader(loaderText);
    const forMultisig = await loader(M0);
    check('loadAaBundle (WalletConnect and the browser): null for a multisig id, before any configuration read', forMultisig === null && calls.config === 0 && calls.endpoint === 0 && calls.build === 0, JSON.stringify(calls));
    const forPhrase = await loader(0);
    check('…while a phrase account still gets its bundle', forPhrase?.bundle?.fake === true && calls.build === 1);
    const m = await runLoader(loaderText.replace('      if (isMultisigAccountId(accountIndex)) return null;\n', ''));
    await m.loader(M0);
    check('M18 caught: without the line a multisig id reaches the configuration and the bundle builder', m.calls.config === 1 && m.calls.build === 1);
  }

  // --- Routes: the gate, the Send refusal with its button, Apps refused.
  check('Send from a multisig: the exact refusal', multisigRouteRefusal('Send') === wo.MULTISIG_SEND_REFUSAL &&
    wo.MULTISIG_SEND_REFUSAL === 'Sends from a multi-signature account are signing requests for the co-signers; build one on the Multisig screen.');
  check('Apps (the in-app browser) refused by name',
    multisigRouteRefusal('Apps') === 'The in-app browser (Apps) is not available for a multi-signature account: no single key in this wallet can sign for it. Build its operations on the Multisig screen, where the co-signers approve them, or switch to one of your own accounts.');
  check('Swap refused by name', multisigRouteRefusal('Swap')?.startsWith('Swapping is not available for a multi-signature account'));
  const app = read('App.tsx');
  // The main stack (the onboarding routes exist only while there is no wallet).
  const routes = [...app.slice(app.indexOf('name="Home"')).matchAll(/name="([A-Za-z]+)"/g)].map((m) => m[1]);
  const unnamed = routes.filter((r) => multisigRouteRefusal(r)?.startsWith('This screen') === true);
  check('every refused route of the main stack names its feature in the multisig refusal', routes.length >= 20 && unnamed.length === 0, unnamed.join(', '));
  const gate = read('src/components/WatchOnlyGate.tsx');
  check('the route gate refuses through multisigRouteRefusal for a multisig, with the notice, the signer hint and a button to the Multisig screen',
    /: multisig\s*\? multisigRouteRefusal\(routeName\)/.test(gate) && gate.includes('{multisig ? <WarningBox>{MULTISIG_ACCOUNT_NOTICE}</WarningBox> : <WatchOnlyNotice />}') &&
      gate.includes('multisigSignerHint(info.label, accountForEvmAddress(info.localSigner)?.name ?? null, info.localSigner)') &&
      gate.includes('<Button title={MULTISIG_OPEN_SCREEN_BUTTON} onPress={onOpenMultisig} />') &&
      gate.includes("onOpenMultisig: () => navigation.navigate('Multisig')"));
  check('the signer hint and the button (exact)', wo.MULTISIG_OPEN_SCREEN_BUTTON === 'Open the Multisig screen' &&
    wo.multisigSignerHint('Multisig 2 (2-of-3)', 'Account 1', S0.address) ===
      `This wallet’s signer for Multisig 2 (2-of-3) is Account 1 (${S0.address}). While Multisig 2 (2-of-3) is the active account, the Multisig screen only shows it; to build, approve or submit its operations, switch to that account on Home first.`);
  check('…the hint no longer tells the user to switch and THEN open the screen the button beside it opens (finding 7d)',
    !/then open the Multisig screen/.test(wo.multisigSignerHint('M', null, S0.address)));
  {
    const screen = read('src/screens/MultisigScreen.tsx');
    const detail = screen.slice(screen.indexOf("if (phase === 'detail' && selected) {"), screen.indexOf('title="Remove from this wallet"'));
    const newOpOk = (src) =>
      /\{selected\.localSigner\.toLowerCase\(\) === \(phraseSigner \?\? ''\)\.toLowerCase\(\) \? \(\s*<Button\s*title="New operation \(send\)"/.test(src) &&
      /title="New operation \(send\)"[\s\S]{0,1400}disabled=\{readiness !== null\}\s*\/>\s*\) : null\}/.test(src);
    check('detail: "New operation (send)" is shown only while this wallet\'s signer is the active account (finding 7d)', newOpOk(detail));
    check('…the old always-shown, disabled button fails the check',
      !newOpOk(detail.replace(/\{selected\.localSigner\.toLowerCase\(\) === \(phraseSigner \?\? ''\)\.toLowerCase\(\) \? \(/, '{true ? (')));
    // Finding 3: tapping "New operation (send)" while an operation is still
    // collecting confirms before discarding it (it is abandoned when the new
    // request is built), with the exact wording.
    check('detail: "New operation (send)" confirms before discarding a collecting operation (finding 3)',
      /if \(selected\.operations\.some\(\(o\) => o\.status === 'collecting'\)\) \{\s*Alert\.alert\(\s*'Start a new operation\?',\s*'The one you are collecting approvals for will be discarded\.',/.test(detail) &&
        /\{ text: 'Cancel', style: 'cancel' \}/.test(detail) &&
        /\{ text: 'Discard and start', style: 'destructive', onPress: start \}/.test(detail) &&
        /\} else \{\s*start\(\);\s*\}/.test(detail));
    // Finding 2: the History list key is not the request id alone (a legacy
    // store, or an in-place status change, could otherwise collide).
    check('detail: the History list is keyed by index + request id + status, never the request id alone (finding 2)',
      /finished\.map\(\(o, i\) =>/.test(detail) && /key=\{`\$\{i\}:\$\{o\.requestId\}:\$\{o\.status\}`\}/.test(detail) &&
        !/key=\{o\.requestId\}/.test(detail));
    // Finding 7c: the NFT gallery's sentence for a multisig.
    check('NFTs: the gallery names a multisig\'s and a watched address as such; other accounts keep the old sentence (exact)',
      wo.nftsOwnerSentence({ watchOnly: false, multisig: true }, S0.address) === `Shows the NFTs held by this multi-signature account's address, ${S0.address}.` &&
        wo.nftsOwnerSentence({ watchOnly: true, multisig: false }, S0.address) === `Shows the NFTs held by the watched address, ${S0.address}.` &&
        wo.nftsOwnerSentence({ watchOnly: false, multisig: false }, S0.address) === `Shows the NFTs held by this account's regular address, ${S0.address}.`);
    const nfts = read('src/screens/NftsScreen.tsx');
    check('NFTs: the screen uses the sentence and reads no smart-account address for a multisig or watched address (source)',
      nfts.includes('{nftsOwnerSentence({ watchOnly, multisig }, owner)}') && !nfts.includes('regular address, {owner}') &&
        nfts.includes('owner && accountIndex !== null && !watchOnly && !multisig ?'));
  }
  const mApps = await importMutant('src/wallet/watch-only.ts', "  'Receive',\n  'Multisig',\n];", "  'Receive',\n  'Multisig',\n  'Apps',\n];");
  check('M19 caught: an allow list that offers Apps to a multisig is detected', mApps.multisigRouteRefusal('Apps') === null && multisigRouteRefusal('Apps') !== null);
  const mSend = await importMutant('src/wallet/watch-only.ts', "  'Receive',\n  'Multisig',\n];", "  'Receive',\n  'Multisig',\n  'Send',\n];");
  check('M20 caught: an allow list that lets a multisig open Send (no refusal) is detected', mSend.multisigRouteRefusal('Send') === null && multisigRouteRefusal('Send') === wo.MULTISIG_SEND_REFUSAL);

  // --- Item 3 emulator finding 7a: the switcher's backup sentence with a multisig (and watch-only) listed.
  {
    const ik = await import('../src/wallet/imported-keys.ts');
    check('switcher backup sentence: unchanged without keyless accounts (Settings → Accounts passes none)',
      ik.accountsBackupHint(false) === 'Every account comes from your one recovery phrase — backing up the phrase backs up all of them.' &&
        ik.accountsBackupHint(false, {}) === ik.accountsBackupHint(false) && ik.accountsBackupHint(true, { watchOnly: false, multisig: false }) === ik.accountsBackupHint(true));
    check('…with a multisig listed it names the exception (exact)',
      ik.accountsBackupHint(false, { multisig: true }) === 'Every account here except the multi-signature ones comes from your one recovery phrase — backing up the phrase backs up all of those.');
    check('…with watch-only, multisig and imported accounts listed (exact)',
      ik.accountsBackupHint(true, { watchOnly: true, multisig: true }) ===
        'Every account here except the imported, watch-only and multi-signature ones comes from your one recovery phrase. Imported accounts are NOT backed up by the phrase: keep their private keys yourself.' &&
      ik.accountsBackupHint(false, { watchOnly: true }) === 'Every account here except the watch-only ones comes from your one recovery phrase — backing up the phrase backs up all of those.');
    check('…never "Every account comes from your one recovery phrase" while a multisig or watch-only account is listed',
      [[false, { multisig: true }], [true, { multisig: true }], [false, { watchOnly: true }], [true, { watchOnly: true, multisig: true }]].every(([i, k]) => !ik.accountsBackupHint(i, k).startsWith('Every account comes from') && !ik.accountsBackupHint(i, k).startsWith('Every account except')));
    check('the multisig list sentence (exact)', wo.MULTISIG_LIST_HINT ===
      'Multi-signature accounts have no key of their own: this wallet holds one of their signers, a recovery-phrase account, and every operation also needs the co-signers. On another phone, add one again from its record on the Multisig screen.');
    const switcher = read('src/components/AccountSwitcher.tsx');
    const switcherOk = (src) => src.includes('{accountsBackupHint(anyImported, { watchOnly: anyWatched, multisig: anyMultisig })}') &&
      src.includes("{anyMultisig ? ` ${MULTISIG_LIST_HINT}` : ''}") && src.includes('const anyMultisig = multisigAccounts.length > 0;');
    check('the switcher passes the listed keyless kinds and adds the multisig sentence (source)', switcherOk(switcher));
    check('…the old call (imported only) fails the check', !switcherOk(switcher.replace('{accountsBackupHint(anyImported, { watchOnly: anyWatched, multisig: anyMultisig })}', '{accountsBackupHint(anyImported)}')));

    // Emulator re-check of 2026-10-11, finding 1: the longer intro squeezed
    // the list so a multisig row listed last was cut off with no scroll
    // hint. The list is now the one scrolling area between the title and
    // the buttons; the intro is a one-line "What is backed up?" expander in
    // the list's header (closed by default; opened, it scrolls with the
    // rows); a hint shows while rows are still below.
    check('switcher expander and scroll hint (exact)',
      wo.SWITCHER_INTRO_TOGGLE === 'What is backed up?' && wo.SWITCHER_SCROLL_HINT === 'More accounts below — scroll the list.');
    const ov = wo.switcherListOverflows;
    check('switcherListOverflows: content taller than the list and not at the end → true; at the end, shorter, or sizes unknown → false',
      ov({ listHeight: 400, contentHeight: 520, scrollY: 0 }) === true &&
        ov({ listHeight: 400, contentHeight: 520, scrollY: 119 }) === false &&
        ov({ listHeight: 400, contentHeight: 520, scrollY: 118 }) === true &&
        ov({ listHeight: 400, contentHeight: 380, scrollY: 0 }) === false &&
        ov({ listHeight: 0, contentHeight: 520, scrollY: 0 }) === false &&
        ov({ listHeight: 400, contentHeight: 0, scrollY: 0 }) === false &&
        ov({ listHeight: Number.NaN, contentHeight: 520, scrollY: 0 }) === false);
    const switcherLayoutProblems = (src) => {
      const p = [];
      const need = (what, ok) => { if (!ok) p.push(what); };
      const modal = src.slice(src.indexOf('<Modal visible={open}'), src.indexOf('</Modal>'));
      const titleAt = modal.indexOf('>Accounts</Text>');
      const listAt = modal.indexOf('<FlatList');
      const headerAt = modal.indexOf('ListHeaderComponent={');
      const hintAt = modal.indexOf('{accountsBackupHint(anyImported, { watchOnly: anyWatched, multisig: anyMultisig })}');
      const rowsAt = modal.indexOf('renderItem={');
      const listEnd = modal.indexOf('/>', rowsAt);
      const addAt = modal.indexOf('<Button title="Add account"');
      need('title, then the list', titleAt >= 0 && listAt > titleAt);
      need('nothing but a comment between the title and the list (no intro text squeezing it)',
        !/<Text/.test(modal.slice(titleAt + '>Accounts</Text>'.length, listAt)));
      need('the backup text sits in the list header, before the rows', headerAt > listAt && hintAt > headerAt && rowsAt > hintAt);
      need('the backup text renders only when the expander is open', /\{introOpen \? \(\s*<Text style=\{\[styles\.hint/.test(modal));
      need('the expander is one line with its label', modal.includes('numberOfLines={1}') && modal.includes('SWITCHER_INTRO_TOGGLE') &&
        modal.includes('accessibilityState={{ expanded: introOpen }}') && modal.includes('onPress={() => setIntroOpen((v) => !v)}'));
      need('the list grows and shrinks between the title and the buttons', modal.includes('style={styles.listArea}') &&
        /listArea: \{\s*flexGrow: 1,\s*flexShrink: 1,\s*\}/.test(src));
      need('a scrollbar that stays visible (a FlatList prop)', modal.indexOf('            persistentScrollbar\n') > listAt && modal.indexOf('            persistentScrollbar\n') < headerAt);
      need('the sizes for the scroll hint are measured', modal.includes('onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}') &&
        modal.includes('onContentSizeChange={(_w, h) => setContentHeight(h)}') && modal.includes('onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}'));
      need('the scroll hint sits between the list and the buttons',
        modal.indexOf('switcherListOverflows({ listHeight, contentHeight, scrollY })') > listEnd &&
          modal.indexOf('{SWITCHER_SCROLL_HINT}') > listEnd && modal.indexOf('{SWITCHER_SCROLL_HINT}') < addAt);
      need('the expander closes each time the list opens', /setIntroOpen\(false\);\s*setScrollY\(0\);\s*setOpen\(true\);/.test(src));
      return p;
    };
    const lp = switcherLayoutProblems(switcher);
    check('the switcher list is the scrolling area; the intro is a one-line expander in its header; a scroll hint (source)', lp.length === 0, lp.join('; '));
    for (const [name, from, to] of [
      ['M-switcher-1 intro back above the list',
        'ListHeaderComponent={\n              <View style={styles.introBlock}>',
        'ListHeaderComponent={\n              <View style={styles.introBlock}>'],
      ['M-switcher-2 no scroll hint', '{SWITCHER_SCROLL_HINT}', "{''}"],
      ['M-switcher-3 intro always open', '{introOpen ? (\n                  <Text style={[styles.hint', '{true ? (\n                  <Text style={[styles.hint'],
      ['M-switcher-4 scrollbar fades', '            persistentScrollbar\n', ''],
    ]) {
      check(`mutation anchor present (${name})`, switcher.includes(from));
      if (name.startsWith('M-switcher-1')) {
        // Moves the whole backup text back above the list (the old layout).
        const moved = switcher.replace(
          '          <FlatList\n',
          '          <Text style={[styles.hint, { color: theme.textMuted }]}>{accountsBackupHint(anyImported, { watchOnly: anyWatched, multisig: anyMultisig })}</Text>\n          <FlatList\n',
        );
        check(`${name}: caught`, switcherLayoutProblems(moved).length > 0);
      } else {
        check(`${name}: caught`, switcherLayoutProblems(switcher.replace(from, to)).length > 0);
      }
    }
  }

  // --- Receive for a multisig: the address with its label and the co-signer sentence; nothing that signs.
  const receive = read('src/screens/ReceiveScreen.tsx');
  const receiveProblems = (src) => {
    const p = [];
    const need = (what, ok) => { if (!ok) p.push(what); };
    need('multisig from the active account', src.includes('const multisig = activeAccount?.multisig === true;'));
    need('noKey covers multisig', src.includes('const noKey = watchOnly || multisig;'));
    need('the co-signer sentence', src.includes('{multisig ? <Text style={[styles.note, { color: theme.text }]}>{MULTISIG_RECEIVE_NOTE}</Text> : null}'));
    need('the label (the account name line)', src.includes('{activeAccount.name}\n          {delegationLabelSuffix(delegation.status)}'));
    need('the QR code of the address', src.includes('<QRCode value={account.address}'));
    need('no payment request', src.includes('account && !watchOnly && !multisig ? familyForSlot(account.chainId) : null'));
    need('no Send button', src.includes('{noKey ? null : (\n        <Button\n          title={`Send ${account.symbol}`}'));
    need('no proof of ownership', src.includes('account.chainId === EVM_CHAIN_ID && !noKey ? ('));
    need('no smart-account box or reads', src.includes('{smartInfo && !noKey ? (') && src.includes('const smartIndex = noKey ? null'));
    need('the other-network note', src.includes('multisigInfo && multisigInfo.chain !== evmChain.caip2 ? ('));
    return p;
  };
  const rp = receiveProblems(receive);
  check('Receive for a multisig: address, label, QR, co-signer sentence; no Send, request, proof or smart box', rp.length === 0, rp.join('; '));
  for (const [name, from, to] of [
    ['M21 Send offered on Receive (noKey without multisig)', 'const noKey = watchOnly || multisig;', 'const noKey = watchOnly;'],
    ['M22 request card for a multisig', 'account && !watchOnly && !multisig ? familyForSlot', 'account && !watchOnly ? familyForSlot'],
    ['M23 co-signer sentence dropped', '{multisig ? <Text style={[styles.note, { color: theme.text }]}>{MULTISIG_RECEIVE_NOTE}</Text> : null}', ''],
  ]) {
    check(`mutation anchor present (${name})`, receive.includes(from));
    check(`${name}: caught`, receiveProblems(receive.replace(from, to)).length > 0);
  }
  // Item 3 emulator finding 7b: Receive said "Ethereum" / "Only send ETH on the Ethereum network" on Sepolia.
  const receiveNetworkOk = (src) =>
    src.includes('const networkName = account ? (isEvmSlot ? evmChain.label : account.name) : \'\';') &&
    src.includes('const coinSymbol = account ? (isEvmSlot ? evmChain.displaySymbol : account.symbol) : \'\';') &&
    src.includes('<Text style={[styles.chainName, { color: theme.text }]}>{networkName}</Text>') &&
    /Only send \{coinSymbol\} on the \{networkName\} network to this/.test(src) &&
    !/Only send \{account\.symbol\} on the \{account\.name\} network/.test(src) &&
    src.includes("title: watchOnly ? WATCHED_ADDRESS_TITLE : account ? `Receive ${coinSymbol}` : 'Receive'");
  check('Receive names the active network and its coin (every account, multisig included)', receiveNetworkOk(receive));
  check('…the old "Only send {account.symbol} on the {account.name} network" fails the check',
    !receiveNetworkOk(receive.replace('Only send {coinSymbol} on the {networkName} network to this', 'Only send {account.symbol} on the {account.name} network to this')));

  // --- The switcher, the Multisig screen's signer, Approvals read-only.
  const sw = read('src/components/AccountSwitcher.tsx');
  check('the switcher lists multisigs last, with their shape label (the view name), a "Multisig" chip and the co-signer line',
    sw.includes('const visible = [...accountList.filter((a) => !a.hidden), ...watchOnlyAccounts, ...multisigAccounts];') &&
      sw.includes('>Multisig</Text>') && (sw.match(/\{MULTISIG_SWITCHER_LINE\}/g) ?? []).length === 2);
  const msScreen = read('src/screens/MultisigScreen.tsx');
  check('the Multisig screen never takes an active multisig as this wallet’s signer',
    msScreen.includes('activeAccount && !activeAccount.imported && !activeAccount.watchOnly && !activeAccount.multisig ? activeAddress : null'));
  const approvals = read('src/screens/ApprovalsScreen.tsx');
  check('Approvals is read-only for a multisig (no Revoke button; the handler refuses first)',
    approvals.includes('{withRevoke && !activeAccount?.watchOnly && !activeAccount?.multisig ? (') &&
      approvals.includes('if (activeAccount?.watchOnly || activeAccount?.multisig) return;'));
  check('Bitcoin, Dogecoin and Solana rows for a multisig (exact)', ids.MULTISIG_NO_CHAIN ===
    'Not available for a multi-signature account. A multisig is an Ethereum smart account; it has no address on this network.');
}

// ===========================================================================
console.log('check-multisig: Settings → Accounts lists multisigs read-only (phase 18 polish)');
// ===========================================================================
{
  const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');
  // 2026-10-11 re-check, finding 7: with a multisig listed, Settings still
  // said "One recovery phrase backs up ALL of your accounts", and the
  // Accounts intro passed no keyless kinds to accountsBackupHint.
  {
    const accSrc = read('src/components/AccountsSection.tsx');
    const settingsSrc = read('src/screens/SettingsScreen.tsx');
    const backupOk = (acc, settings) =>
      acc.includes('{accountsBackupHint(importedCount > 0, { watchOnly: watchOnlyAccounts.length > 0, multisig: multisigAccounts.length > 0 })}') &&
      settings.includes('const keylessListed = watchOnlyAccounts.length > 0 || multisigAccounts.length > 0;') &&
      settings.includes("{!keylessListed\n              ? 'One recovery phrase backs up ALL of your accounts") &&
      settings.includes('{multisigAccounts.length > 0 ? (\n          <Text style={[styles.hint, { color: theme.textMuted }]}>{MULTISIG_LIST_HINT}</Text>');
    check('Settings → Accounts passes the listed keyless kinds; the Backup text says "ALL" only without watch-only or multisig accounts and explains multisigs (source)',
      backupOk(accSrc, settingsSrc));
    check('…the old Accounts call (imported only) fails the check',
      !backupOk(accSrc.replace('{accountsBackupHint(importedCount > 0, { watchOnly: watchOnlyAccounts.length > 0, multisig: multisigAccounts.length > 0 })}', '{accountsBackupHint(importedCount > 0)}'), settingsSrc));
    check('…and the old Backup condition (watch-only only) fails it too',
      !backupOk(accSrc, settingsSrc.replace('const keylessListed = watchOnlyAccounts.length > 0 || multisigAccounts.length > 0;', 'const keylessListed = watchOnlyAccounts.length > 0;')));
    const ik = await import('../src/wallet/imported-keys.ts');
    check('…what Settings → Accounts now says with a multisig and no imported key (exact)',
      ik.accountsBackupHint(false, { watchOnly: false, multisig: true }) ===
        'Every account here except the multi-signature ones comes from your one recovery phrase — backing up the phrase backs up all of those.');
  }

  const ADDR = '0x944caA404e389b18b2fe251e969EdD7A220d0d38'; // the emulator's 2-of-3 of 2026-10-10
  check('heading and sentence (exact)', MULTISIG_ACCOUNTS_HEADING === 'Multi-signature accounts' &&
    MULTISIG_ACCOUNTS_LIST_HINT === 'Listed here for reference only. They are managed on the Multisig screen (Settings → Multi-signature accounts) and cannot be hidden here.');
  check('one line: shape label · short address · network',
    multisigAccountListLine({ name: 'ignored', evmAddress: ADDR, multisigInfo: { chain: 'eip155:11155111', label: 'Multisig 2 (2-of-3)' } }) ===
      'Multisig 2 (2-of-3) · 0x944c…0d38 · Ethereum Sepolia');
  check('…on Base Sepolia', multisigAccountListLine({ name: 'x', evmAddress: ADDR, multisigInfo: { chain: 'eip155:84532', label: 'Multisig 1 (3-of-3)' } }) ===
    'Multisig 1 (3-of-3) · 0x944c…0d38 · Base Sepolia');
  check('…a network no longer known shows its CAIP-2 id; no record facts fall back to the view name',
    multisigAccountListLine({ name: 'x', evmAddress: ADDR, multisigInfo: { chain: 'eip155:999999', label: 'Multisig 3 (2-of-2)' } }) === 'Multisig 3 (2-of-2) · 0x944c…0d38 · eip155:999999' &&
      multisigAccountListLine({ name: 'Multisig 4', evmAddress: null, multisigInfo: null }) === 'Multisig 4 · address not known yet · network unknown');
  const section = read('src/components/AccountsSection.tsx');
  const listOk = (src) => {
    const start = src.indexOf('{multisigAccounts.length > 0 ? (');
    if (start < 0) return false;
    const block = src.slice(start, src.indexOf(') : null}', start));
    return (
      src.includes('    multisigAccounts,\n  } = useWallet();') &&
      block.includes('{MULTISIG_ACCOUNTS_HEADING}</Text>') &&
      block.includes('{MULTISIG_ACCOUNTS_LIST_HINT}</Text>') &&
      block.includes('{multisigAccounts.map((account) => (') &&
      block.includes('{multisigAccountListLine(account)}') &&
      // Read-only: no buttons, links, switches or handlers in the list.
      !/Button|Pressable|onPress|Switch|renderRow/.test(block)
    );
  };
  check('Settings → Accounts renders the list only when there is a multisig, one read-only line each', listOk(section));
  check('…the multisigs never enter the phrase / imported rows (accountList holds no multisig)',
    !/accountList\.filter\(\(a\) => a\.multisig\)/.test(section) && !section.includes('multisigAccounts.map(renderRow)'));
  check('mutant caught: the list rendered with the editable row (hide / rename actions)',
    !listOk(section.replace('{multisigAccounts.map((account) => (', '{multisigAccounts.map(renderRow)}{[].map((account) => (')));
  check('mutant caught: the list removed', !listOk(section.replace('{multisigAccounts.length > 0 ? (', '{false ? (')));
  const demo = readFileSync(join(HERE, '..', '..', 'docs', 'DEMO.md'), 'utf8');
  check('DEMO.md step 27 no longer says the Settings list does not exist', !/Settings → Accounts does not list (the )?multisig/i.test(demo));
}

// ===========================================================================
console.log('check-multisig: phase 19 item 1 — QR codes in parts, scanning, files, other networks, approvals from another wallet');
// ===========================================================================
{
  const require = createRequire(import.meta.url);
  const QRVersion = require('qrcode/lib/core/version.js');
  const QRECL = require('qrcode/lib/core/error-correction-level.js');
  const QRMode = require('qrcode/lib/core/mode.js');
  const screen = readFileSync(join(HERE, '..', 'src', 'screens', 'MultisigScreen.tsx'), 'utf8');
  const views = readFileSync(join(HERE, '..', 'src', 'screens', 'MultisigViews.tsx'), 'utf8');
  const recoveryViews = readFileSync(join(HERE, '..', 'src', 'components', 'RecoveryViews.tsx'), 'utf8');
  /** Renders a QR text exactly as PayloadQr does (react-native-qrcode-svg → qrcode.create, ecl "L") and decodes it with jsqr. */
  const qrRoundTrip = (text) => {
    const code = QRCode.create(text, { errorCorrectionLevel: 'L' });
    const size = code.modules.size;
    const scale = 6;
    const quiet = 4;
    const px = (size + 2 * quiet) * scale;
    const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!code.modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const p = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4;
        rgba[p] = rgba[p + 1] = rgba[p + 2] = 0;
      }
    }
    return { version: code.version, decoded: jsQR(rgba, px, px)?.data ?? null };
  };
  const bytes = (t) => Buffer.byteLength(t, 'utf8');

  // --- Fixtures: a real 2-of-3 request (native transfer), a 10-signer token request, an approval, a record.
  const qs = memoryStore();
  const qRecord = await createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, qs);
  const qOp = await prepareMultisigRequest({ record: qRecord, calls: [{ to: RECIPIENT, value: 10n ** 14n, data: new Uint8Array(0) }], node: multisigNode(), nativeSymbol: 'test ETH' }, qs);
  const requestPayload = encodeMultisigRequestPayload(qRecord, qOp);
  const bigSigners = [S0, ...Array.from({ length: 9 }, (_, i) => evmKeyProvider.deriveAccount(seed, 0, 10 + i))].map((a) => ({ address: a.address, weight: 1 }));
  const bigConfig = { signers: bigSigners, threshold: 2, delaySeconds: 0 };
  const bigRecord = await createMultisigRecord({ chain: SEPOLIA, config: bigConfig, localSigner: S0.address }, qs);
  const USDC_SEPOLIA = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
  const tokenCall = { to: USDC_SEPOLIA, value: 0n, data: ethers.getBytes(new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [RECIPIENT, 1_500_000n])) };
  const bigOp = await prepareMultisigRequest({ record: bigRecord, calls: [tokenCall], node: multisigNode({ onChainSet: bigConfig }), nativeSymbol: 'test ETH' }, qs);
  const bigPayload = encodeMultisigRequestPayload(bigRecord, bigOp);
  const approval = approveMultisigRequest(qOp.request, S5);
  const approvalPayloadQ = encodeMultisigApprovalPayload(qOp.request, approval);
  const recordJson = exportMultisigAccount(bigRecord).json;

  // --- Capacity facts from the installed encoder.
  check('capacity: the qrcode encoder react-native-qrcode-svg uses holds 858 bytes at version 20 / level L (= MULTISIG_QR_PART_MAX_BYTES), 2,953 at version 40',
    QRVersion.getCapacity(20, QRECL.L, QRMode.BYTE) === 858 && MULTISIG_QR_PART_MAX_BYTES === 858 && QRVersion.getCapacity(40, QRECL.L, QRMode.BYTE) === 2953 &&
      /ecl="L"/.test(recoveryViews), String(QRVersion.getCapacity(20, QRECL.L, QRMode.BYTE)));
  const reqVersion = QRCode.create(requestPayload, { errorCorrectionLevel: 'L' }).version;
  const bigVersion = QRCode.create(bigPayload, { errorCorrectionLevel: 'L' }).version;
  check(`a real signing request is too large for one reliable code: 2-of-3 native ${bytes(requestPayload)} bytes (version ${reqVersion}), 10 signers + token ${bytes(bigPayload)} bytes (version ${bigVersion})`,
    bytes(requestPayload) > 858 && bytes(bigPayload) > 858 && reqVersion > 20 && bigVersion > 20);

  // --- Splitting.
  const reqParts = splitMultisigQrParts(requestPayload);
  const bigParts = splitMultisigQrParts(bigPayload);
  check('the 2-of-3 request becomes 2 parts, the 10-signer token request 3 parts; "SW-MS:<n>/<total>:" prefixes; chunks join to the payload exactly',
    reqParts.length === 2 && bigParts.length === 3 && reqParts.every((p, i) => p.startsWith(`SW-MS:${i + 1}/2:`)) && bigParts.every((p, i) => p.startsWith(`SW-MS:${i + 1}/3:`)) &&
      reqParts.map((p) => p.slice(p.indexOf(':', 6) + 1)).join('') === requestPayload && bigParts.map((p) => p.slice(p.indexOf(':', 6) + 1)).join('') === bigPayload);
  check('every part fits 858 bytes and encodes at version 20 or lower (level L)',
    [...reqParts, ...bigParts].every((p) => bytes(p) <= 858 && QRCode.create(p, { errorCorrectionLevel: 'L' }).version <= 20),
    [...reqParts, ...bigParts].map((p) => `${bytes(p)}B/v${QRCode.create(p, { errorCorrectionLevel: 'L' }).version}`).join(' '));
  const smallRecordJson = exportMultisigAccount(qRecord).json;
  check(`an approval (${bytes(approvalPayloadQ)} bytes) and a 2-of-3 record (${bytes(smallRecordJson)} bytes) stay ONE plain code (the payload itself, version ≤ 20); a 10-signer record (${bytes(recordJson)} bytes) gets 2 parts`,
    JSON.stringify(splitMultisigQrParts(approvalPayloadQ)) === JSON.stringify([approvalPayloadQ]) && JSON.stringify(splitMultisigQrParts(smallRecordJson)) === JSON.stringify([smallRecordJson]) &&
      QRCode.create(approvalPayloadQ, { errorCorrectionLevel: 'L' }).version <= 20 && QRCode.create(smallRecordJson, { errorCorrectionLevel: 'L' }).version <= 20 && splitMultisigQrParts(recordJson).length === 2);
  const wide = JSON.stringify({ type: MULTISIG_REQUEST_PAYLOAD, note: 'é😀'.repeat(400) });
  const wideParts = splitMultisigQrParts(wide);
  check('multi-byte text is cut between characters, never inside one, and every part still fits',
    wideParts !== null && wideParts.length > 1 && wideParts.every((p) => bytes(p) <= 858 && !/[\uD800-\uDBFF]$/.test(p) && !/^SW-MS:\d+\/\d+:[\uDC00-\uDFFF]/.test(p)) &&
      wideParts.map((p) => p.replace(/^SW-MS:\d+\/\d+:/, '')).join('') === wide);
  check('nothing to show, or more than 20 parts: no QR code (null)', splitMultisigQrParts('') === null && splitMultisigQrParts('x'.repeat(20 * 846 + 1)) === null && splitMultisigQrParts('x'.repeat(20 * 846)).length === 20);

  // --- Rendered and scanned: every part decodes (jsqr) and the joined text is what the pasted text gives.
  const decoded = bigParts.map((p) => qrRoundTrip(p));
  check('each rendered part decodes back to itself through the independent jsqr decoder', decoded.every((d, i) => d.decoded === bigParts[i]), decoded.map((d) => d.version).join(','));
  let scan = null;
  let result = null;
  for (const d of [decoded[2], decoded[0], decoded[0], decoded[1]]) {
    result = acceptMultisigQrScan(scan, d.decoded);
    if (result.kind === 'partial') scan = result.scan;
  }
  check('scanned in any order, with a part read twice: complete, and the joined text equals the payload', result.kind === 'complete' && result.text === bigPayload);
  const viaScan = parseMultisigRequestPayload(result.text);
  const viaPaste = parseMultisigRequestPayload(bigPayload);
  check('the scanned text goes through the SAME parser as pasted text (identical result)', JSON.stringify(viaScan, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : v)) ===
    JSON.stringify(viaPaste, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : v)));
  const p1 = acceptMultisigQrScan(null, bigParts[0]);
  check('progress after the first part: 1 of 3, exact line',
    p1.kind === 'partial' && p1.received === 1 && p1.total === 3 && !p1.repeated &&
      multisigQrProgressLine(1, 3) === '1 of 3 parts read. Show the next part on the other phone (Next part) and scan it; 2 parts are still missing.' &&
      multisigQrProgressLine(2, 3, true) === 'That part was already read. 2 of 3 parts read. Show the next part on the other phone (Next part) and scan it; 1 part is still missing.');
  const again = acceptMultisigQrScan(p1.scan, bigParts[0]);
  check('the same part twice: accepted as a repeat, nothing changes', again.kind === 'partial' && again.repeated && again.received === 1);
  check('a whole code scanned while parts are being read is refused (no silent switch)', throwsWith(() => acceptMultisigQrScan(p1.scan, approvalPayloadQ), '1 of 3 parts read so far'));
  check('a part of a code with another total is refused', throwsWith(() => acceptMultisigQrScan(p1.scan, reqParts[1]), 'code in 2 parts, but the code being read has 3'));
  const conflicting = `SW-MS:1/3:${bigParts[0].slice(10, -1)}x`;
  check('a part number already read with different contents is refused', throwsWith(() => acceptMultisigQrScan(p1.scan, conflicting), 'Part 1 was already read with different contents'));
  check('damaged parts are refused: part 0, part above the total, total 1, total 21, empty chunk',
    ['SW-MS:0/2:abc', 'SW-MS:3/2:abc', 'SW-MS:1/1:abc', 'SW-MS:1/21:abc', 'SW-MS:1/2:', 'SW-MS:1/2abc'].every((t) => throwsWith(() => acceptMultisigQrScan(null, t), 'damaged')));
  check('a whole code is complete at once (unchanged); an empty code is refused',
    acceptMultisigQrScan(null, ` ${approvalPayloadQ} `).text === approvalPayloadQ && throwsWith(() => acceptMultisigQrScan(null, '   '), 'empty'));
  // Parts of two different codes that share a total: the join is refused by the parser.
  const os = memoryStore();
  const oRecord = await createMultisigRecord({ chain: SEPOLIA, config: CONFIG_2_OF_3, localSigner: S0.address }, os);
  const otherOp = await prepareMultisigRequest({ record: oRecord, calls: [{ to: RECIPIENT, value: 2n * 10n ** 14n, data: new Uint8Array(0) }], node: multisigNode({ nonce: 1n }), nativeSymbol: 'test ETH' }, os);
  const otherParts = splitMultisigQrParts(encodeMultisigRequestPayload(oRecord, otherOp));
  const mixed = acceptMultisigQrScan(acceptMultisigQrScan(null, reqParts[0]).scan, otherParts[1]);
  check('parts of two requests joined (same total) are refused by the strict parser, never reviewed',
    otherParts.length === 2 && mixed.kind === 'complete' && mixed.text !== requestPayload && throwsWith(() => parseMultisigRequestPayload(mixed.text)));
  const tamperedPart = reqParts[0].replace(/"callData":"0x([0-9a-f])/, (_m, d) => `"callData":"0x${d === 'a' ? 'b' : 'a'}`);
  const tamperedJoin = acceptMultisigQrScan(acceptMultisigQrScan(null, tamperedPart).scan, reqParts[1]);
  check('a part with one changed hex digit joins into text the engine refuses (hash re-derivation)', tamperedPart !== reqParts[0] && throwsWith(() => parseMultisigRequestPayload(tamperedJoin.text), 'does not match'));
  const partSentence = 'This is part 1 of 2 of a multi-part QR code, not the whole text. Read every part with the scan button on this screen, or paste the whole text the other phone shared.';
  check('one part pasted (or read by another scanner) is refused with a plain sentence by the request, approval and record readers',
    throwsWith(() => parseMultisigRequestPayload(reqParts[0]), partSentence) && throwsWith(() => addMultisigApproval(qRecord, qOp, reqParts[0]), partSentence) &&
      throwsWith(() => parseMultisigAccountImport(` ${reqParts[0]}`), partSentence));
  check('copy: the paged note and the part caption (exact)',
    multisigQrPagedNote(2) === 'This is too much for one reliable QR code, so it is shown as 2 codes. The other phone scans them one at a time with its scan button; tap Next part after each one is read. The order does not matter.' &&
      multisigQrPartCaption('Multisig signing request', 1, 2) === 'Multisig signing request — part 2 of 2' && multisigQrPartCaption('Multisig approval', 0, 1) === 'Multisig approval' &&
      MULTISIG_QR_TOO_LARGE === 'Too large for QR codes — use Share, Copy or Save as file instead.');
  check('copy: the scan buttons and their sentences (exact)',
    MULTISIG_SCAN_REQUEST_TITLE === 'Scan a request' && MULTISIG_SCAN_APPROVAL_TITLE === 'Scan an approval' && MULTISIG_SCAN_RECORD_TITLE === 'Scan a record' &&
      MULTISIG_SCAN_NEXT_TITLE === 'Scan the next part' && MULTISIG_SCAN_START_OVER_TITLE === 'Start over' &&
      MULTISIG_SCAN_REQUEST_NOTE === 'A scanned request is checked exactly like pasted text: the wallet recomputes the account address, the call data and the request id from what it read, and you still see every call in full before anything is signed.' &&
      MULTISIG_SCAN_APPROVAL_NOTE === 'A scanned approval is checked exactly like pasted text: its signature must recover to a signer of this multisig for this exact request (these calls at this nonce), or it is refused.' &&
      MULTISIG_SCAN_RECORD_NOTE === 'A scanned record is checked exactly like pasted text: the account address must follow from its signer set, and one of your recovery-phrase accounts must be a signer.' &&
      MULTISIG_SCAN_REQUEST_RATIONALE === 'Point the camera at the signing request QR code on the submitter’s phone. A request in several parts is read one part at a time.' &&
      MULTISIG_SCAN_APPROVAL_RATIONALE === 'Point the camera at the approval QR code on the co-signer’s phone, or at a signature QR code from another wallet.' &&
      MULTISIG_SCAN_RECORD_RATIONALE === 'Point the camera at the multisig record QR code on the other signer’s phone. A record in several parts is read one part at a time.');

  // --- The screen wires scanning, paste and files to the same readers (source pins).
  const phaseOf = (name, next) => screen.slice(screen.indexOf(`if (phase === '${name}'`), screen.indexOf(next));
  const cosignInput = phaseOf('cosign-input', "if (phase === 'cosign-review'");
  const collect = phaseOf('collect', "if ((phase === 'confirm'");
  const importPhase = phaseOf('import', "if (phase === 'import-review'");
  const scanWired = (src, title, done) => new RegExp(`<MultisigScanButton\\s+title=\\{${title}\\}[\\s\\S]{0,200}onComplete=\\{${done.replace(/[()]/g, '\\$&')}\\}`).test(src);
  check('co-signer side: "Scan a request" hands the scanned text to onReviewCosign — the paste button\'s reader — and the file button to reviewCosign',
    scanWired(cosignInput, 'MULTISIG_SCAN_REQUEST_TITLE', 'onReviewCosign') && cosignInput.includes('onPress={() => onReviewCosign(cosignInput)}') && cosignInput.includes('onPress={() => void pickInto(reviewCosign)}') &&
      /const reviewCosign = \(text: string\) => \{\s*setError\(null\);\s*setCosignReview\(\s*reviewMultisigRequestAsCosigner\(text,/.test(screen));
  check('submitting side: "Scan an approval" hands the scanned text to onAddApproval — the paste button\'s reader — and the file button to addApproval',
    scanWired(collect, 'MULTISIG_SCAN_APPROVAL_TITLE', '(text) => void onAddApproval(text)') && collect.includes('onPress={() => void onAddApproval(approvalInput)}') &&
      /const onPickApprovalFile = \(\) => pickInto\(addApproval\);/.test(screen) && /const \{ op: next \} = addMultisigApproval\(selected, op, text\);/.test(screen));
  check('adding a multisig: "Scan a record" hands the text to onReviewImport, the paste reader; the file button to reviewImport',
    scanWired(importPhase, 'MULTISIG_SCAN_RECORD_TITLE', 'onReviewImport') && importPhase.includes('onPress={() => onReviewImport(importInput)}') && importPhase.includes('onPress={() => void pickInto(reviewImport)}'));
  check('the request, approval and record QR codes are shown through MultisigPayloadQr (parts when needed); no single oversized code is left',
    screen.includes('<MultisigPayloadQr payload={payload} caption="Multisig signing request" />') && screen.includes('<MultisigPayloadQr payload={cosignPayload} caption="Multisig approval" />') &&
      screen.includes('<MultisigPayloadQr payload={exported.json} caption="Multisig account record" />') && !/multisigQrValue\(/.test(screen) && !/exported\.qrValue/.test(screen));
  check('views: the scan button uses the existing QrScanner and passes the joined text on unchanged; the paged QR uses PayloadQr with Previous / Next part',
    views.includes("import { QrScanner } from '../components/QrScanner';") && /const result = acceptMultisigQrScan\(scan, data\);/.test(views) && /onComplete\(result\.text\);/.test(views) &&
      /const parts = splitMultisigQrParts\(payload\);/.test(views) && /<PayloadQr value=\{parts\[index\]!\} caption=\{multisigQrPartCaption\(caption, index, total\)\} \/>/.test(views) &&
      views.includes('title="Previous part"') && views.includes('title="Next part"') && /onError\(e instanceof Error \? e\.message : String\(e\)\)/.test(views));
  check('scan errors are shown as sentences in the phase\'s error box', /const scanError = \(message: string\) => setError\(asSentence\(message\)\);/.test(screen) && (screen.match(/onError=\{scanError\}/g) ?? []).length === 3);

  // --- Files: save writes the payload unchanged; open reads it back byte for byte; damage is refused plainly.
  const dir = join(MUTANT_DIR, 'files');
  mkdirSync(dir, { recursive: true });
  const roundTripFile = (kind, payload, account) => {
    const name = multisigExportFileName(kind, SEPOLIA, account, new Date('2026-10-11T08:00:00Z'));
    const path = join(dir, name);
    writeFileSync(path, multisigFileContents(payload), 'utf8');
    const raw = readFileSync(path);
    const text = raw.toString('utf8');
    return { name, raw, text, opened: multisigFileText(text, { name, size: raw.length, mimeType: MULTISIG_FILE_MIME_TYPE }) };
  };
  const reqFile = roundTripFile('request', requestPayload, qRecord.address);
  const apprFile = roundTripFile('approval', approvalPayloadQ, qRecord.address);
  const recFile = roundTripFile('account', recordJson, bigRecord.address);
  check('saved request / approval / record files round-trip through the open path byte for byte (real files on disk)',
    [[reqFile, requestPayload], [apprFile, approvalPayloadQ], [recFile, recordJson]].every(([f, p]) => Buffer.compare(f.raw, Buffer.from(p, 'utf8')) === 0 && f.opened === p) &&
      MULTISIG_FILE_NAME_PATTERN.test(reqFile.name) && reqFile.name === `shiba-multisig-request_sepolia_${qRecord.address.slice(0, 6)}-${qRecord.address.slice(-4)}_2026-10-11.json`);
  check('…and the opened texts give the same results as the pasted ones (request id, approval added, record facts)',
    parseMultisigRequestPayload(reqFile.opened).request.callDataAndNonceHash === qOp.requestId &&
      JSON.stringify(addMultisigApproval(qRecord, qOp, apprFile.opened).op) === JSON.stringify(addMultisigApproval(qRecord, qOp, approvalPayloadQ).op) &&
      parseMultisigAccountImport(recFile.opened).facts.account === bigRecord.address);
  check('only a multisig payload can be saved as a file (share text, other JSON refused)',
    throwsWith(() => multisigFileContents(multisigRequestShareText(qRecord, qOp)), 'Only a multisig record') && throwsWith(() => multisigFileContents('{"type":"other"}'), 'Only a multisig record') &&
      MULTISIG_FILE_MIME_TYPE === 'application/json' && MULTISIG_FILE_UTI === 'public.json');
  const refusalFor = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return multisigFileRefusal(e);
    }
  };
  const info = { name: reqFile.name, size: null, mimeType: MULTISIG_FILE_MIME_TYPE };
  const truncated = refusalFor(() => parseMultisigRequestPayload(multisigFileText(requestPayload.slice(0, -40), info)));
  const flipped = refusalFor(() => parseMultisigRequestPayload(multisigFileText(requestPayload.replace(/"callData":"0x([0-9a-f])/, (_m, d) => `"callData":"0x${d === 'a' ? 'b' : 'a'}`), info)));
  const garbage = refusalFor(() => parseMultisigRequestPayload(multisigFileText('\u0000\u0001PK\u0003\u0004 not json', info)));
  const wrongKind = refusalFor(() => addMultisigApproval(qRecord, qOp, multisigFileText(requestPayload, info)));
  const recordAsRequest = refusalFor(() => parseMultisigRequestPayload(multisigFileText(recordJson, info)));
  check('damaged files are refused with a plain sentence (exact): truncated, one hex digit changed, not JSON, a request where an approval goes, a record where a request goes',
    truncated === 'This file was not accepted. This file must contain exactly one JSON object and nothing else.' &&
      flipped === 'This file was not accepted. Request callDataAndNonceHash does not match its sender, callData and nonce.' &&
      garbage === 'This file was not accepted. This file must contain exactly one JSON object and nothing else.' &&
      wrongKind === 'This file was not accepted. This is a signing request, not an approval.' &&
      recordAsRequest === 'This file was not accepted. This is an account record, not a signing request.',
    [truncated, flipped, garbage, wrongKind, recordAsRequest].join(' | '));
  // Finding 1: a truncated file AND a wrong-kind file are refused with a PLAIN
  // sentence — never a raw native rejection (mirrors the recovery pin).
  const wrongNameRefusal = refusalFor(() => multisigFileText(requestPayload, { name: 'request.txt', mimeType: 'text/plain' }));
  check('multisig: the truncated and wrong-kind refusals are plain (no raw native rejection text)',
    /\.json file exported by Shiba Wallet\.$/.test(wrongNameRefusal ?? '') &&
      ![truncated, wrongKind, wrongNameRefusal].some((s) => /(rejected|Missing 'READ'|Call to function|FileSystemFile|permission for accessing)/.test(s ?? '')),
    wrongNameRefusal);
  check('screen + views: the save button writes through the shared shareTextFile with multisigFileContents; opening refuses through multisigFileRefusal',
    /shareTextFile\(\{\s*directory: MULTISIG_EXPORT_DIRECTORY,\s*fileName: \(\) => fileName,\s*contents: \(\) => multisigFileContents\(text\),/.test(views) && !/shareJsonFile|new File\(/.test(views) &&
      /await accept\(multisigFileText\(picked\.text, picked\)\);\s*\} catch \(e\) \{\s*setError\(multisigFileRefusal\(e\)\);/.test(screen));
  // Finding 1: a FILE-READ failure (not a wrong-contents one) is wrapped in a
  // plain sentence and routed through the refusal path, never shown raw.
  const readRefusal = multisigFileRefusal(new Error('It could not be read on this device. Some file pickers do not give the app permission to read the chosen file; use Share, Copy or the QR scan instead.'));
  check('a file-read failure becomes a plain refusal that points to Share/Copy/scan, with no raw native rejection text',
    readRefusal.startsWith('This file was not accepted. ') && /Share, Copy or the QR scan/.test(readRefusal) &&
      !/rejected|Missing 'READ'|Call to function|FileSystemFile/.test(readRefusal), readRefusal);
  // The shared helper is a .tsx with native imports, so it is pinned by source.
  const helper = readFileSync(join(HERE, '..', 'src', 'components', 'RecordFileActions.tsx'), 'utf8');
  check('shared helper: pickRecordFile reads the content uri on Android (copyToCacheDirectory false) and wraps any read failure in RecordFileReadError, deleting only a cache copy (finding 1)',
    /const copyToCacheDirectory = Platform\.OS !== 'android';/.test(helper) &&
      /getDocumentAsync\(\{\s*type: RECORD_FILE_MIME_TYPE,\s*copyToCacheDirectory,/.test(helper) &&
      /catch \(e\) \{\s*throw new RecordFileReadError\(e\);\s*\}/.test(helper) &&
      /if \(copyToCacheDirectory\) deleteQuietly\(file\);/.test(helper) &&
      !/new File\(asset\.uri\)[\s\S]{0,40}await file\.text\(\);\s*return \{/.test(helper));
  const readMsg = helper.match(/RECORD_FILE_READ_FAILED_MESSAGE =\s*\n?\s*'([^']*)';/);
  check('shared helper: the read-failure message points to Share, Copy and the QR scan, with no raw native rejection term (finding 1)',
    !!readMsg && /Share/.test(readMsg[1]) && /Copy/.test(readMsg[1]) && /scan/.test(readMsg[1]) &&
      !/(rejected|Missing 'READ'|Call to function|FileSystemFile)/.test(readMsg[1]), readMsg?.[1]);
  const mFile = await importMutant('src/wallet/multisig.ts', "  return payload;\n}\n\n/**\n * The sentence for a picked file", "  return JSON.stringify(JSON.parse(payload), null, 2);\n}\n\n/**\n * The sentence for a picked file");
  const mPath = join(dir, 'mutant.json');
  writeFileSync(mPath, mFile.multisigFileContents(requestPayload), 'utf8');
  check('M-file caught: a save that re-formats the JSON is not byte for byte', Buffer.compare(readFileSync(mPath), Buffer.from(requestPayload, 'utf8')) !== 0);

  // --- Mutants of the scan accumulator and the pasted-part refusal.
  const mTotal = await importMutant('src/wallet/multisig.ts', '  if (scan && received > 0 && scan.total !== total) {', '  if (false) {');
  check('M-total caught: without the total check a part of another code is not refused', !throwsWith(() => mTotal.acceptMultisigQrScan(p1.scan, reqParts[1]), 'code in 2 parts'));
  const mConflict = await importMutant('src/wallet/multisig.ts', '  if (previous !== null && previous !== undefined && previous !== chunk) {', '  if (false) {');
  check('M-conflict caught: without the contents check a contradicting part replaces the first silently', !throwsWith(() => mConflict.acceptMultisigQrScan(p1.scan, conflicting), 'already read'));
  const mPaste = await importMutant('src/wallet/multisig.ts', 'export function parseMultisigRequestPayload(text: string): ParsedMultisigRequest {\n  refusePastedQrPart(text);', 'export function parseMultisigRequestPayload(text: string): ParsedMultisigRequest {');
  check('M-paste caught: without the refusal a pasted part gets a confusing message', !throwsWith(() => mPaste.parseMultisigRequestPayload(reqParts[0]), partSentence));
  const mPrefix = await importMutant('src/wallet/multisig.ts', '  const budget = MULTISIG_QR_PART_MAX_BYTES - utf8Length(', '  const budget = MULTISIG_QR_PART_MAX_BYTES + 0 * utf8Length(');
  const tight = 'y'.repeat(858 * 3);
  check('M-prefix caught: a budget that ignores the "SW-MS:n/t:" prefix gives parts above 858 bytes (or none)',
    splitMultisigQrParts(tight).every((p) => bytes(p) <= 858) && !(mPrefix.splitMultisigQrParts(tight) ?? ['x'.repeat(900)]).every((p) => bytes(p) <= 858));

  // --- Other networks: the verified facts decide what is offered.
  const profile = (caip2) => EVM_PROFILES.find((p) => p.caip2 === caip2);
  const keys = Object.keys(MULTISIG_VERIFIED_NETWORKS).sort();
  const facts = Object.values(MULTISIG_VERIFIED_NETWORKS);
  check('verified networks: exactly Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia and OP Sepolia, read 2026-10-11, every hash 32 bytes',
    JSON.stringify(keys) === JSON.stringify(['eip155:11155111', 'eip155:11155420', 'eip155:421614', 'eip155:84532']) &&
      facts.every((f) => f.verifiedOn === '2026-10-11' && [f.weightedValidatorCodeHash, f.factoryCodeHash, f.metaFactoryCodeHash, f.implementationCodeHash].every((h) => /^0x[0-9a-f]{64}$/.test(h))));
  check('the factory and meta factory code is identical on all four; the validator and implementation differ per network (cached EIP-712 chain id)',
    new Set(facts.map((f) => f.factoryCodeHash)).size === 1 && new Set(facts.map((f) => f.metaFactoryCodeHash)).size === 1 &&
      new Set(facts.map((f) => f.weightedValidatorCodeHash)).size === 4 && new Set(facts.map((f) => f.implementationCodeHash)).size === 4 &&
      MULTISIG_VERIFIED_NETWORKS['eip155:11155111'].weightedValidatorCodeHash === '0x9aa45e0f0d7428e7476f943c50e4f1020a3e22f4851e97eb8b2865f9b4a44606');
  check('Create is offered at once on the four verified networks; not on mainnet or Hoodi (weighted module not verified there) until a check passes',
    ['eip155:11155111', 'eip155:84532', 'eip155:421614', 'eip155:11155420'].every((c) => multisigNetworkVerified(profile(c))) &&
      !multisigNetworkVerified(profile('eip155:1')) && !multisigNetworkVerified(profile('eip155:560048')));
  check('…a table entry alone is not enough without a verified Kernel profile', !multisigNetworkVerified({ caip2: 'eip155:84532', kernelV33Verified: false }));
  const mVerified = await importMutant('src/config/evm-chain.ts',
    "  const statically = profile.kernelV33Verified && Object.prototype.hasOwnProperty.call(MULTISIG_VERIFIED_NETWORKS, profile.caip2);",
    '  const statically = profile.kernelV33Verified;');
  check('M-networks caught: the old rule (any verified Kernel profile) offers mainnet without the weighted module verified', mVerified.multisigNetworkVerified(profile('eip155:1')) === true);
  check('screen: the unverified-network box and "Check this network" appear only where readiness allows a multisig',
    screen.includes('{!networkVerified && readiness === null ? (') && screen.includes('title="Check this network"'));
  check('file names know every network the multisig is verified on', ['eip155:84532', 'eip155:421614', 'eip155:11155420'].every((c) => /^shiba-multisig-request_(base-sepolia|arbitrum-sepolia|op-sepolia)_/.test(multisigExportFileName('request', c, qRecord.address))));

  // --- Approvals from another wallet: eth_signTypedData_v4 over the share text's typed data.
  const EXT = new ethers.Wallet(ethers.id('shiba-wallet check-multisig external co-signer (test key, never funded)'));
  const extConfig = { signers: [{ address: S0.address, weight: 1 }, { address: EXT.address, weight: 1 }, { address: S6.address, weight: 1 }], threshold: 2, delaySeconds: 0 };
  const xs = memoryStore();
  const xRecord = await createMultisigRecord({ chain: SEPOLIA, config: extConfig, localSigner: S0.address }, xs);
  const xOp = await prepareMultisigRequest({ record: xRecord, calls: [{ to: RECIPIENT, value: 10n ** 14n, data: new Uint8Array(0) }], node: multisigNode({ onChainSet: extConfig }), nativeSymbol: 'test ETH' }, xs);
  const share = multisigRequestShareText(xRecord, xOp);
  const marker = 'send back the signature:\n';
  const typed = JSON.parse(share.slice(share.indexOf(marker) + marker.length));
  check('the share text ends with exactly multisigApprovalTypedData(request) as JSON', share.endsWith(marker + JSON.stringify(multisigApprovalTypedData(xOp.request))));
  check('that typed data hashes (ethers TypedDataEncoder) to the request\'s approval digest',
    typed.primaryType === 'Approve' && ethers.TypedDataEncoder.hash(typed.domain, { Approve: typed.types.Approve }, typed.message) === xOp.request.approvalDigest);
  const extSig = await EXT.signTypedData(typed.domain, { Approve: typed.types.Approve }, typed.message);
  const extAccount = evmAccountFromPrivateKey(ethers.getBytes(EXT.privateKey), 'test');
  const engineApproval = approveMultisigRequest(xOp.request, extAccount);
  const viaBare = addMultisigApproval(xRecord, xOp, extSig);
  const viaEngine = addMultisigApproval(xRecord, xOp, JSON.stringify(engineApproval));
  check('a bare 65-byte signature from another wallet (ethers signTypedData, v 27/28) is accepted exactly as the engine\'s JSON is (same stored approval and id)',
    viaBare.added.address === EXT.address && JSON.stringify(viaBare.op) === JSON.stringify(viaEngine.op) && engineApproval.signature === extSig.toLowerCase() &&
      viaBare.op.approvals[0].signature === extSig.toLowerCase(), `${extSig} vs ${engineApproval.signature}`);
  const v = parseInt(extSig.slice(-2), 16);
  const recId = extSig.slice(0, -2) + (v - 27).toString(16).padStart(2, '0');
  check('…as 0/1 recovery id (some hardware signers), quoted, or in upper case: the same stored approval (v rewritten to 27/28)',
    [recId, `"${extSig}"`, '0x' + extSig.slice(2).toUpperCase(), `  "${recId}"  `].every((t) => JSON.stringify(addMultisigApproval(xRecord, xOp, t).op) === JSON.stringify(viaBare.op)) &&
      externalApprovalSignature(recId) === extSig.toLowerCase() && externalApprovalSignature('{"signer":"0x"}') === null);
  check('…a v of 29 is refused with a plain sentence', throwsWith(() => addMultisigApproval(xRecord, xOp, extSig.slice(0, -2) + '1d'), 'The signature’s last byte (v) is 29; an Ethereum signature ends in 27 or 28 (or 0 or 1). It cannot be used as an approval.'));
  const otherTyped = multisigApprovalTypedData(buildMultisigSigningRequest({ chainId: 11155111n, account: xRecord.address, calls: [{ to: RECIPIENT, value: 10n ** 14n, data: new Uint8Array(0) }], nonce: 5n }));
  const staleSig = await EXT.signTypedData(otherTyped.domain, { Approve: otherTyped.types.Approve }, otherTyped.message);
  const stranger = new ethers.Wallet(ethers.id('shiba-wallet check-multisig stranger (test key)'));
  const strangerSig = await stranger.signTypedData(typed.domain, { Approve: typed.types.Approve }, typed.message);
  check('…a signature over another request\'s typed data, or from a wallet outside the signer set, is refused',
    throwsWith(() => addMultisigApproval(xRecord, xOp, staleSig), 'is not a signer of this multisig.') &&
      throwsWith(() => addMultisigApproval(xRecord, xOp, strangerSig), `${stranger.address} is not a signer of this multisig.`));
  const mV = await importMutant('src/wallet/multisig.ts', '  if (v === 0 || v === 1) return hex.slice(0, 130) + (v + 27).toString(16);\n', '');
  check('M-v caught: without the v rewrite a 0/1 signature is refused', throwsWith(() => mV.addMultisigApproval(xRecord, xOp, recId)));
  // The external approval in the submitted operation, recovered by ethers.
  await saveMultisigOperation(xRecord.id, viaBare.op, xs);
  const bundler = fakeBundler();
  const node = multisigNode({ onChainSet: extConfig });
  const xr = (await listMultisigRecords(SEPOLIA, xs))[0];
  const { bundle, quote } = await prepareMultisigSubmission({ record: xr, op: viaBare.op, nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, transportFor: transportsFor(node, bundler) });
  await submitMultisigWithGate({ record: xr, op: viaBare.op, bundle, quote, requireAuth: authOk([]), signWith: signWithAs(S0, []), store: xs });
  const sent = bundler.lastOp;
  const cdnh = ethers.keccak256(abi.encode(['address', 'bytes', 'uint256'], [sent.sender, sent.callData, BigInt(sent.nonce)]));
  const digest = ethers.TypedDataEncoder.hash(typed.domain, { Approve: typed.types.Approve }, { callDataAndNonceHash: cdnh });
  check('submitted: the operation\'s first 65 bytes are the other wallet\'s signature (v 27/28), recovered by ethers over the FINAL op\'s Approve digest',
    sent.signature.slice(2, 132) === extSig.slice(2).toLowerCase() && ethers.recoverAddress(digest, '0x' + sent.signature.slice(2, 132)) === EXT.address &&
      ethers.verifyMessage(getUserOpHash(fromRpcOp(sent), ENTRYPOINT_V07, 11155111n), '0x' + sent.signature.slice(132)) === S0.address);
}

// ===========================================================================
console.log('check-multisig: wipe');
// ===========================================================================
{
  await resetMultisigRecords(store);
  check('resetMultisigRecords empties the list (nothing on-chain changes)', (await listMultisigRecords(undefined, store)).length === 0);
}

console.log(`\ncheck-multisig: ${passed} passed, ${failed} failed (${mutants} mutants)`);
if (failed > 0) process.exit(1);

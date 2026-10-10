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
//  - mutation checks: the threshold, the submitter rule and the readiness
//    gate, each removed in a scratch copy, must be caught.
//
// Every key is disposable: the public BIP-39 test mnemonic ("abandon ...
// about"). Nothing touches the network.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-multisig.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
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
import {
  MULTISIG_ACCOUNT_PAYLOAD,
  MULTISIG_APPROVAL_PAYLOAD,
  MULTISIG_DEPLOYMENT,
  MULTISIG_FEES_LINE,
  MULTISIG_FRESH_DEPLOY_NOTE,
  MULTISIG_REQUEST_PAYLOAD,
  MULTISIG_SINGLE_SIGNER_REFUSAL,
  MULTISIG_STORE_DAMAGED,
  MULTISIG_SUBMITTER_APPROVAL_REFUSAL,
  MULTISIG_UNAUDITED_NOTE,
  MultisigAuthCancelledError,
  addMultisigApproval,
  buildMultisigConfig,
  checkMultisigNetwork,
  chooseMultisigIndex,
  cosignWithGate,
  createMultisigRecord,
  describeMultisigCall,
  encodeMultisigApprovalPayload,
  encodeMultisigRequestPayload,
  exportMultisigAccount,
  importMultisigRecord,
  listMultisigRecords,
  multisigAddressFor,
  multisigConfigOf,
  multisigDisplayName,
  multisigExportFileName,
  multisigExposureLine,
  multisigFeatureRefusal,
  multisigFileText,
  multisigListEntries,
  multisigShapeLabel,
  multisigThresholdNotReached,
  multisigWeightProgress,
  parseMultisigAccountImport,
  parseMultisigRequestPayload,
  prepareMultisigRequest,
  prepareMultisigSubmission,
  readMultisigOnChain,
  recordMultisigOutcome,
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
  check('exposure line for a 2-of-3 (operations 2, messages 1), exact',
    multisigExposureLine(CONFIG_2_OF_3) ===
      'Any 2 co-signers together can send an operation; for messages the deployed validator needs only 1, so this account must never be used to sign logins, orders or token permits — the wallet refuses that.',
    multisigExposureLine(CONFIG_2_OF_3));
  const w = { signers: [{ address: S0.address, weight: 2 }, { address: S5.address, weight: 1 }, { address: S6.address, weight: 1 }], threshold: 3, delaySeconds: 0 };
  check('exposure line for a weighted set names the weight and the minimum', multisigExposureLine(w).startsWith('Co-signers whose weights add up to 3 (at least 2 of them) can send an operation; for messages the deployed validator needs only 1'));
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
  check('screen: every phase goes through shell(), which renders <MultisigHonesty> (source pin)', (screen.match(/return shell\(/g) ?? []).length >= 13 && /<MultisigHonesty config=\{config\} \/>/.test(screen) && !/return \(\s*<ScrollView/.test(screen));
  check('screen: the readiness card is in the shell and every starting button is disabled when gated', /readinessCard/.test(screen) && (screen.match(/disabled=\{readiness !== null/g) ?? []).length >= 8);
  check('views: the honesty block shows the exposure, fees, message refusal and audit lines', /multisigExposureLine\(config\)/.test(views) && /MULTISIG_FEES_LINE/.test(views) && /MULTISIG_ERC1271_REFUSAL/.test(views) && /MULTISIG_UNAUDITED_NOTE/.test(views));
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
      review.described[0] === `Send 0.0001 test ETH (100000000000000 wei) to ${RECIPIENT}.` && review.exposureLine === multisigExposureLine(CONFIG_2_OF_3) && review.warnings.some((w) => w.includes('not in this wallet')));
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

  // The submitting side adds approvals.
  const p0 = multisigWeightProgress(record, op);
  check('progress before approvals: weight 1 (this wallet’s signer) of 2, not ready', p0.weight === 1 && p0.threshold === 2 && p0.localWeight === 1 && !p0.ready);
  const { op: op2, added } = addMultisigApproval(record, op, approvalPayload);
  check('an approval payload is added: weight 2 of 2, ready, approval id = keccak256(signature)', added.address === S5.address && multisigWeightProgress(record, op2).ready && op2.approvalIds[0].approvalId === ethers.keccak256(appr.signature));
  const bare = approveMultisigRequest(op.request, S6);
  check('a bare 65-byte signature from another wallet is accepted (signer recovered)', addMultisigApproval(record, op, bare.signature).added.address === S6.address);
  check('the engine’s bare {signer, signature} JSON is accepted', addMultisigApproval(record, op, JSON.stringify(bare)).added.address === S6.address);
  check('refused: the same co-signer twice', throwsWith(() => addMultisigApproval(record, op2, approvalPayload), 'already added'));
  check('refused: an approval from a non-signer', throwsWith(() => addMultisigApproval(record, op, approveMultisigRequest(op.request, S7).signature), 'not a signer'));
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
  check('route allow list for an active multisig: Multisig and Receive allowed; Send, Swap, Connections, Apps, Sessions, Guardians, Inheritance, Passkey, UpgradeAccount refused',
    multisigRouteRefusal('Multisig') === null && multisigRouteRefusal('Receive') === null &&
      ['Send', 'Swap', 'Connections', 'Apps', 'Sessions', 'Guardians', 'Inheritance', 'Passkey', 'UpgradeAccount', 'OwnerRotation', 'ProveOwnership', 'SpendingLimits', 'SomeFutureRoute'].every((r) => multisigRouteRefusal(r) !== null) &&
      MULTISIG_ALLOWED_ROUTES.length === 10);
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
  const m1 = await importMutant('src/wallet/multisig.ts', 'ready: weight >= record.threshold }', 'ready: true }');
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

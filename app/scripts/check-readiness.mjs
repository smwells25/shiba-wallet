// Phase 9 item 6: the mainnet readiness switchboard, entirely OFFLINE.
// Checks the readiness table in src/config/readiness.ts against
// docs/THREAT_MODEL.md (every evidence id must exist there, and no feature
// may be 'mainnet-ok' while one of its checklist items is not Met), the
// helpers, and the gates the table drives in the exact app modules
// (src/wallet/aa.ts, delegation.ts, sessions.ts, passkeys.ts, recovery.ts)
// under Node's type stripping, with fake transports that count every
// request: on mainnet each gated entry point refuses with the table's
// reason before any request and persists nothing; on Sepolia the same
// configuration paths still work.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-readiness.mjs
//
// Nothing is signed against a live chain and nothing is broadcast.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { KERNEL_V3_3 } from '@shiba-wallet/chains-evm';
import {
  FEATURE_READINESS,
  FeatureNotAllowedError,
  READINESS_STATUS_LABEL,
  READINESS_TESTNET_HINT,
  TEST_NETWORK_CHAINS,
  assertFeatureAllowed,
  eip155Caip2,
  featureReadiness,
  isFeatureAllowed,
  isTestNetwork,
  readinessGate,
  readinessReason,
  readinessRefusal,
} from '../src/config/readiness.ts';
import { EVM_MAINNET, EVM_SEPOLIA } from '../src/config/evm-chain.ts';
import {
  KERNEL_PREFILL,
  aaReadinessBlock,
  aaTypeFeatures,
  createAaClient,
  getAaConfig,
  hasCompleteAaSettings,
  isAaConfigured,
  setAaBundlerUrl,
  setAaFactory,
  setAaKernelFactory,
  setAaPaymaster,
  setAccountEip7702,
} from '../src/wallet/aa.ts';
import { prepareSetCodeTx, sendSetCodeTx } from '../src/wallet/delegation.ts';
import { installSession, prepareSessionInstall, sendSessionCalls } from '../src/wallet/sessions.ts';
import { installPasskey, preparePasskeyCalls, preparePasskeyInstall, sendPasskeyCalls, signHashWithPasskey } from '../src/wallet/passkeys.ts';
import {
  prepareGuardianInstallQuote,
  prepareOwnerRotationQuote,
  prepareRecoveryStart,
  reviewRecoveryRequest,
  submitOwnerRotation,
} from '../src/wallet/recovery.ts';
import { KERNEL_ACCOUNT_0, OWNER_0, TEST_MNEMONIC, fakeBundler, fakeKernelNode, memoryStore } from './fakes-kernel.mjs';

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const MAINNET = EVM_MAINNET.caip2;
const SEPOLIA = EVM_SEPOLIA.caip2;
const isRefusal = (e) => e instanceof Error && e.name === 'FeatureNotAllowedError' && e.message.endsWith(READINESS_TESTNET_HINT);

// ---------------------------------------------------------------------------
console.log('check-readiness: table integrity');
// ---------------------------------------------------------------------------
const EXPECTED_IDS = [
  'eoa-send', 'tokens', 'nft', 'swap', 'walletconnect', 'dogecoin-send', 'simple-account',
  'kernel-smart-account', 'eip7702-upgrade', 'session-keys', 'passkeys', 'guardians',
  'owner-rotation', 'paymaster',
];
const ids = FEATURE_READINESS.map((f) => f.id);
check('every expected feature id is present exactly once', EXPECTED_IDS.every((id) => ids.filter((x) => x === id).length === 1) && ids.length === EXPECTED_IDS.length, ids.join());
for (const f of FEATURE_READINESS) {
  const sentences = f.reason.split(/(?<=\.)\s+/).filter(Boolean);
  check(
    `${f.id}: status, title, a one-to-three sentence reason, evidence`,
    ['mainnet-ok', 'testnet-only', 'blocked'].includes(f.status) &&
      typeof f.title === 'string' && f.title.length > 0 &&
      typeof f.reason === 'string' && f.reason.endsWith('.') && sentences.length >= 1 && sentences.length <= 3 &&
      Array.isArray(f.evidence) && f.evidence.length > 0 && typeof f.enforced === 'boolean',
    `${sentences.length} sentences`,
  );
}
check('no reason calls a setup "safe"', FEATURE_READINESS.every((f) => !/\bsafe\b/i.test(f.reason)));
check('every testnet-only feature is enforced', FEATURE_READINESS.filter((f) => f.status === 'testnet-only').every((f) => f.enforced));
check('status labels exist for all three statuses', Object.keys(READINESS_STATUS_LABEL).sort().join() === 'blocked,mainnet-ok,testnet-only');

// ---------------------------------------------------------------------------
console.log('check-readiness: statuses derived from docs/THREAT_MODEL.md section 5');
// ---------------------------------------------------------------------------
const doc = readFileSync(join(REPO, 'docs', 'THREAT_MODEL.md'), 'utf8');
// Every table row whose first cell is an id: | C1 | ... | Status | ... |
const docIds = new Map();
for (const line of doc.split('\n')) {
  const m = /^\|\s*((?:C|W)\d+|[FNT]-\d+)\s*\|(.*)$/.exec(line);
  if (!m) continue;
  const cells = m[2].split('|').map((c) => c.trim());
  docIds.set(m[1], { status: /^(?:C|W)\d+$/.test(m[1]) ? cells[1] ?? '' : null });
}
check('the threat model lists C1–C3 and W1–W20', ['C1', 'C2', 'C3'].every((i) => docIds.has(i)) && Array.from({ length: 20 }, (_, i) => `W${i + 1}`).every((i) => docIds.has(i)));
for (const f of FEATURE_READINESS) {
  const missing = f.evidence.filter((id) => !docIds.has(id));
  check(`${f.id}: every evidence id exists in docs/THREAT_MODEL.md`, missing.length === 0, missing.join());
}
const metStatus = (id) => /^\**Met\**$/.test(docIds.get(id)?.status ?? '');
for (const f of FEATURE_READINESS) {
  const checklist = f.evidence.filter((id) => /^(?:C|W)\d+$/.test(id));
  const unmet = checklist.filter((id) => !metStatus(id));
  if (f.status === 'mainnet-ok') {
    check(`${f.id}: 'mainnet-ok' only with every checklist item Met`, unmet.length === 0, unmet.join());
  } else {
    check(`${f.id}: '${f.status}' names at least one checklist item that is not Met`, unmet.length > 0, checklist.join());
  }
}
const cUnmet = ['C1', 'C2', 'C3'].filter((id) => !metStatus(id));
check('while any of C1–C3 is not Met, no feature citing them is mainnet-ok', cUnmet.length === 0 || FEATURE_READINESS.filter((f) => f.evidence.some((id) => /^C\d$/.test(id))).every((f) => f.status !== 'mainnet-ok'), cUnmet.join());
for (const id of ['kernel-smart-account', 'eip7702-upgrade', 'session-keys', 'passkeys', 'guardians', 'owner-rotation', 'paymaster', 'simple-account']) {
  check(`${id} is testnet-only (leadership summary conclusion 2)`, featureReadiness(id).status === 'testnet-only');
}
for (const id of ['eoa-send', 'tokens', 'nft', 'swap', 'walletconnect', 'dogecoin-send']) {
  check(`${id} is a mainnet candidate that is not yet cleared (conclusion 1)`, featureReadiness(id).status === 'blocked');
}
check('dogecoin-send names W6 (the one real broadcast)', featureReadiness('dogecoin-send').evidence.includes('W6'));
check('swap names W7 (a live 0x quote)', featureReadiness('swap').evidence.includes('W7'));
check('paymaster names W8 (live sponsorship)', featureReadiness('paymaster').evidence.includes('W8'));
check('walletconnect names W11 and W12 (permit decoding, dApp identity)', ['W11', 'W12'].every((i) => featureReadiness('walletconnect').evidence.includes(i)));
// Every enforced feature has a gate in the app modules (static check).
const gateSources = ['aa.ts', 'delegation.ts', 'sessions.ts', 'passkeys.ts', 'recovery.ts']
  .map((f) => readFileSync(join(HERE, '..', 'src', 'wallet', f), 'utf8'))
  .join('\n');
for (const f of FEATURE_READINESS.filter((x) => x.enforced)) {
  check(`${f.id}: a gate in the app modules names it`, gateSources.includes(`'${f.id}'`));
}

// ---------------------------------------------------------------------------
console.log('check-readiness: helpers');
// ---------------------------------------------------------------------------
check('only Sepolia is a test network', TEST_NETWORK_CHAINS.length === 1 && isTestNetwork(SEPOLIA) && !isTestNetwork(MAINNET));
check('unknown or malformed chain ids count as main networks (fail closed)', !isTestNetwork('eip155:8453') && !isTestNetwork('') && !isTestNetwork('bip122:1a91e3dace36e2be3bf030a65679fe82'));
check('isFeatureAllowed: testnet-only feature allowed on Sepolia, refused on mainnet', isFeatureAllowed('guardians', SEPOLIA) && !isFeatureAllowed('guardians', MAINNET));
check('isFeatureAllowed: blocked feature allowed on Sepolia, not cleared on mainnet', isFeatureAllowed('eoa-send', SEPOLIA) && !isFeatureAllowed('eoa-send', MAINNET));
check('isFeatureAllowed accepts a testnet flag', isFeatureAllowed('passkeys', true) && !isFeatureAllowed('passkeys', false));
check('readinessReason returns the table text', readinessReason('session-keys') === featureReadiness('session-keys').reason);
check('readinessRefusal = reason + the test-mode hint', readinessRefusal('passkeys') === `${featureReadiness('passkeys').reason} ${READINESS_TESTNET_HINT}`);
check('the hint points at Settings → Developer', /Sepolia test mode in Settings → Developer/.test(READINESS_TESTNET_HINT));
const thrown = await caught(() => assertFeatureAllowed('kernel-smart-account', MAINNET));
check('assertFeatureAllowed throws FeatureNotAllowedError with the feature id', thrown instanceof FeatureNotAllowedError && thrown.featureId === 'kernel-smart-account' && isRefusal(thrown));
check('assertFeatureAllowed is silent where allowed', (await caught(() => assertFeatureAllowed('kernel-smart-account', SEPOLIA))) === null);
check('readinessGate: null where allowed, entry + hint where not', readinessGate('guardians', SEPOLIA) === null && readinessGate('guardians', MAINNET)?.feature.id === 'guardians' && readinessGate('guardians', MAINNET)?.hint === READINESS_TESTNET_HINT);
check('eip155Caip2 formats bigints and numbers', eip155Caip2(11155111n) === SEPOLIA && eip155Caip2(1) === MAINNET);
check('featureReadiness rejects an unknown id', (await caught(() => featureReadiness('nope'))) instanceof Error);
check('no developer override exists in the module', !/override/i.test(Object.keys(await import('../src/config/readiness.ts')).join()));
check('aaTypeFeatures maps every smart-account type', aaTypeFeatures('simple').join() === 'simple-account' && aaTypeFeatures('kernel-v3.3').join() === 'kernel-smart-account' && aaTypeFeatures('kernel-7702').join() === 'kernel-smart-account,eip7702-upgrade');
check('aaReadinessBlock: mainnet blocked, Sepolia clear, null chain blocked', aaReadinessBlock(MAINNET, 'kernel-v3.3') === 'kernel-smart-account' && aaReadinessBlock(SEPOLIA, 'kernel-7702') === null && aaReadinessBlock(null, 'simple') === 'simple-account');

// ---------------------------------------------------------------------------
console.log('check-readiness: aa.ts configuration gate');
// ---------------------------------------------------------------------------
function countingTransports() {
  const counter = { n: 0 };
  return { counter, transportFor: () => async () => { counter.n += 1; throw new Error('no request expected'); } };
}
{
  const store = memoryStore();
  const { counter, transportFor } = countingTransports();
  const refusals = [
    await caught(() => setAaBundlerUrl(MAINNET, 'https://bundler.example', { store, transportFor })),
    await caught(() => setAaFactory(MAINNET, '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985', 'https://node.example', { store, transportFor })),
    await caught(() => setAaKernelFactory(MAINNET, KERNEL_PREFILL.factory, 'https://node.example', { store, transportFor })),
    await caught(() => setAaPaymaster(MAINNET, 'https://pm.example', '', { store, transportFor })),
    await caught(() => setAccountEip7702(MAINNET, OWNER_0, true, store)),
  ];
  check('mainnet bundler / SimpleAccount factory / Kernel factory / paymaster / 7702 record all refused with the readiness text', refusals.every(isRefusal), refusals.map((e) => e?.message).join(' | '));
  check('…the Kernel refusal carries the Kernel reason', refusals[2]?.message === readinessRefusal('kernel-smart-account'));
  check('…the paymaster refusal carries the paymaster reason', refusals[3]?.message === readinessRefusal('paymaster'));
  check('…zero requests and nothing persisted', counter.n === 0 && store._map.size === 0);

  // Sepolia still works through the same functions.
  const sep = memoryStore();
  await setAaBundlerUrl(SEPOLIA, 'https://bundler.example', { store: sep, transportFor: () => fakeBundler() });
  await setAaKernelFactory(SEPOLIA, KERNEL_PREFILL.factory, 'https://node.example', { store: sep, transportFor: () => fakeKernelNode({ chainIdHex: '0xaa36a7' }) });
  const cfg = await getAaConfig(SEPOLIA, sep);
  check('Sepolia: bundler + Kernel factory save and the smart account is available', cfg.chain === SEPOLIA && isAaConfigured(cfg) && cfg.accountType === 'kernel-v3.3');
  const upgraded = await setAccountEip7702(SEPOLIA, OWNER_0, true, sep);
  check('Sepolia: the 7702 upgrade record saves and the upgraded owner is available', isAaConfigured(upgraded, OWNER_0));

  // The same complete configuration under the mainnet key (as if stored
  // before this build) reads as unavailable, so the send / swap screens
  // hide their toggles and WalletConnect offers no smart-account connection.
  const raw = JSON.parse(await sep.getItem('shiba-wallet.aa-config.v1'));
  const legacy = memoryStore();
  await legacy.setItem('shiba-wallet.aa-config.v1', JSON.stringify({ [MAINNET]: raw[SEPOLIA] }));
  const legacyCfg = await getAaConfig(MAINNET, legacy);
  check('a complete mainnet configuration reads as unavailable (screens hide the smart-account options)', hasCompleteAaSettings(legacyCfg) && !isAaConfigured(legacyCfg) && !isAaConfigured(legacyCfg, OWNER_0));
  check('removing a mainnet 7702 record is never refused', (await setAccountEip7702(MAINNET, OWNER_0, false, legacy)).eip7702Owners.length === 0);
}

// ---------------------------------------------------------------------------
console.log('check-readiness: module gates refuse on mainnet with zero network calls');
// ---------------------------------------------------------------------------
{
  const seed = mnemonicToSeed(TEST_MNEMONIC);
  const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
  seed.fill(0);
  const node = fakeKernelNode({ chainIdHex: '0x1' });
  const nodeCalls = { n: 0 };
  const countedNode = async (method, params) => {
    nodeCalls.n += 1;
    return node(method, params);
  };
  const bundler = fakeBundler();
  const mainnetBundle = createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: KERNEL_V3_3.factory,
    chainId: 1n,
    accountIndex: 0,
    accountType: 'kernel-v3.3',
    transportFor: (url) => (url.includes('bundler') ? bundler : countedNode),
  });
  const store = memoryStore();
  let submitted = false;
  const submit = async () => {
    submitted = true;
    return { userOpHash: '0x' };
  };
  const vault = { loads: 0, save: async () => { throw new Error('no vault write expected'); }, load: async () => { vault.loads += 1; return null; }, remove: async () => {} };
  const quote = { kind: 'set-code', action: 'upgrade', from: OWNER_0, chainId: 1n, nonce: 0n, authorizationNonce: 1n, delegate: KERNEL_V3_3.implementation };
  const cases = [
    ['delegation.prepareSetCodeTx (upgrade)', 'eip7702-upgrade', () => prepareSetCodeTx({ url: 'https://node.example', from: OWNER_0, action: 'upgrade', expectedChainId: 1n, transportFor: () => countedNode })],
    ['delegation.sendSetCodeTx (upgrade)', 'eip7702-upgrade', () => sendSetCodeTx('https://node.example', owner, quote, null, { transportFor: () => countedNode })],
    ['sessions.prepareSessionInstall', 'session-keys', () => prepareSessionInstall(mainnetBundle, OWNER_0, KERNEL_ACCOUNT_0, {})],
    ['sessions.installSession', 'session-keys', () => installSession({ quote: { calls: [] }, install: { installCalls: [] }, grant: {}, chain: MAINNET, account: KERNEL_ACCOUNT_0, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3', label: 'x', source: 'manual', sessionPrivateKey: null, store, vault, submit })],
    ['sessions.sendSessionCalls', 'session-keys', () => sendSessionCalls({ bundle: mainnetBundle, record: { chain: MAINNET, grant: '{}', keyHeld: true, localStatus: 'installed' }, calls: [], vault })],
    ['passkeys.preparePasskeyInstall', 'passkeys', () => preparePasskeyInstall(mainnetBundle, OWNER_0, KERNEL_ACCOUNT_0, { publicKey: { x: 1n, y: 2n }, credentialId: new Uint8Array([1]) })],
    ['passkeys.installPasskey', 'passkeys', () => installPasskey({ plan: { quote: { calls: [] }, call: null, usePrecompiled: true }, registration: { publicKey: { x: 1n, y: 2n }, credentialId: new Uint8Array([1]), backupEligible: false }, chain: MAINNET, account: KERNEL_ACCOUNT_0, owner: OWNER_0, accountIndex: 0, rpId: 'example.com', store, submit })],
    ['passkeys.preparePasskeyCalls', 'passkeys', () => preparePasskeyCalls({ ...mainnetBundle, passkey: { record: { account: KERNEL_ACCOUNT_0 }, spec: {} } }, [])],
    ['passkeys.sendPasskeyCalls', 'passkeys', () => sendPasskeyCalls({ ...mainnetBundle, passkey: { record: { account: KERNEL_ACCOUNT_0 }, spec: {} } }, { passkey: true, sender: KERNEL_ACCOUNT_0, calls: [] })],
    ['passkeys.signHashWithPasskey', 'passkeys', () => signHashWithPasskey({ record: { account: KERNEL_ACCOUNT_0, chain: MAINNET }, assert: async () => { throw new Error('no prompt expected'); }, hash: new Uint8Array(32), chainId: 1n, expectedAccount: KERNEL_ACCOUNT_0 })],
    ['recovery.prepareGuardianInstallQuote', 'guardians', () => prepareGuardianInstallQuote(mainnetBundle, OWNER_0, KERNEL_ACCOUNT_0, {}, {})],
    ['recovery.prepareRecoveryStart', 'guardians', () => prepareRecoveryStart(countedNode, { chainId: 1n, account: KERNEL_ACCOUNT_0, newOwner: OWNER_0 })],
    ['recovery.reviewRecoveryRequest', 'guardians', () => reviewRecoveryRequest(countedNode, { text: '{}', activeChainId: 1n, guardianAddress: OWNER_0 })],
    ['recovery.prepareOwnerRotationQuote', 'owner-rotation', () => prepareOwnerRotationQuote(mainnetBundle, { ownerAddress: OWNER_0, ownerIndex: 0, ownerPath: null, newOwner: { address: OWNER_0, index: 1, path: null }, walletOwners: [], removeGuardians: false, chain: MAINNET, config: {}, store })],
    ['recovery.submitOwnerRotation', 'owner-rotation', () => submitOwnerRotation({ rotation: { calls: [], quote: { calls: [] } }, chain: MAINNET, store, submit })],
  ];
  for (const [name, feature, fn] of cases) {
    const e = await caught(fn);
    check(`${name}: refused on mainnet with the '${feature}' reason`, isRefusal(e) && e.featureId === feature && e.message === readinessRefusal(feature), e?.message);
  }
  check('none of them made a node or bundler request, read the vault, stored or submitted anything', nodeCalls.n === 0 && bundler.calls.length === 0 && vault.loads === 0 && store._map.size === 0 && !submitted, `${nodeCalls.n}/${bundler.calls.length}/${vault.loads}/${store._map.size}`);
  const revoke = await caught(() => prepareSetCodeTx({ url: 'https://node.example', from: OWNER_0, action: 'revoke', expectedChainId: 1n, transportFor: () => countedNode }));
  check('a mainnet 7702 REVOCATION quote is not refused by the gate (undo always available)', !isRefusal(revoke), revoke?.message);
}

console.log(`\ncheck-readiness: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

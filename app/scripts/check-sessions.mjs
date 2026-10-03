// Phase 8 item 2 (app half): session keys, entirely OFFLINE. Exercises the
// exact app modules (src/wallet/sessions.ts, walletconnect.ts,
// wc-controller.ts, aa.ts) under Node's type stripping against fakes:
//  - store discipline: session private keys only in the (fake) secure
//    vault, never in the AsyncStorage-shaped store; corrupt storage reads
//    as empty with a flag and refuses writes until reset;
//  - grant refusals surfaced verbatim from the engine's validateSessionKeyGrant;
//  - the explicit install: calldata equal to the engine's installCalls (and
//    to an independent ethers encoding), root-signed by the OWNER;
//  - a session-signed operation: permission nonce key, 0xff || EIP-191
//    signature recovered by ethers to the SESSION address, never the owner;
//  - an out-of-grant call refused locally with zero network calls and no
//    vault read;
//  - revocation calldata and key deletion; on-chain status mapping;
//  - ERC-7715: request → grant → install → response round trip, the
//    unsupported-type error, methods offered only on Kernel smart-account
//    sessions (and the controller's automatic answers).
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-sessions.mjs
//
// Nothing is signed against a live chain and nothing is broadcast.

import { readFileSync } from 'node:fs';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  ERC7715_CALLS_PERMISSION_TYPE,
  KERNEL_PERMISSION_MODULES,
  KERNEL_V3_3,
  encodePermissionInstall,
  getUserOpHash,
  grantToErc7715Request,
  permissionRevokeCall,
  permissionValidationId,
  selector,
  sessionNonceKey,
  toBytes,
  toHex,
  validateSessionKeyGrant,
} from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import { createAaClient, prepareAaCalls, sendAa } from '../src/wallet/aa.ts';
import {
  ERC7715_LIMITATION_NOTE,
  KERNEL_SESSION_RESPONSE_KEY,
  SESSIONS_KEY,
  SESSION_NOT_UPGRADED_REFUSAL,
  SESSION_SIMPLE_REFUSAL,
  SESSION_UNDEPLOYED_REFUSAL,
  buildErc7715Response,
  buildManualGrant,
  describeAllowedCall,
  finalizeSessionInstall,
  finalizeSessionRevoke,
  forgetAllSessions,
  forgetSession,
  installSession,
  loadSessions,
  narrowGrant,
  newSessionKey,
  parseSelectorInput,
  prepareSessionInstall,
  prepareSessionRevoke,
  readSessionStatus,
  resetSessions,
  resolveSessionAccount,
  revokeSession,
  saveSessionRecord,
  sendSessionCalls,
  sessionTestCall,
  sessionVaultId,
  validateGrantForAccount,
} from '../src/wallet/sessions.ts';
import {
  ERC7715_ERRORS,
  WC_7715_METHODS,
  WC_KERNEL_SMART_ACCOUNT_METHODS,
  WC_SMART_ACCOUNT_METHODS,
  WcRequestRejection,
  decideProposal,
  decideSupportedExecutionPermissions,
  parseWcRequest,
  smartAccountMethodsFor,
} from '../src/wallet/walletconnect.ts';
import { WcController } from '../src/wallet/wc-controller.ts';
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
const sel = (s) => toHex(selector(s));
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const pad32 = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';

const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);
// Session keys are 'testnet-only' in the mainnet readiness table
// (src/config/readiness.ts, phase 9 item 6), so every flow here runs on
// Sepolia; the mainnet refusals are checked at the end and in
// check-readiness.mjs.
const M = 'eip155:11155111';
const CHAIN_ID = 11155111n;
const ACCOUNT = KERNEL_ACCOUNT_0;
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const TX_HASH = '0x' + 'cd'.repeat(32);

/** Fake secure vault: a Map plus a read counter (stands in for expo-secure-store). */
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
 * Fake node: the Kernel fake from fakes-kernel.mjs plus an emulation of the
 * permission views the engine reads (Kernel v3.3 currentNonce /
 * validationConfig / permissionConfig / isAllowedSelector, the policies'
 * status, ECDSASigner.signer) and EntryPoint getNonce per key. State is
 * flipped by the test to emulate inclusion of an install or a revocation.
 */
function fakeSessionNode({ deployed = true, codeOverride = {}, chainIdHex = '0xaa36a7' } = {}) {
  const base = fakeKernelNode({ chainIdHex, deployedAccounts: deployed ? new Set([ACCOUNT]) : new Set(), codeAt: codeOverride });
  const state = { currentNonce: 1, permissions: new Map(), seen: new Set(), failReads: false };
  const calls = [];
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      if (state.failReads && same(to, ACCOUNT)) throw new Error('RPC error -32000: node unavailable');
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
        return abi.encode(
          ['tuple(bytes2,address,bytes22[])'],
          [[p ? '0x0002' : '0x0000', p ? KERNEL_PERMISSION_MODULES.ecdsaSigner : ZERO, p ? p.policies : []]],
        );
      }
      if (same(to, ACCOUNT) && data.startsWith(sel('isAllowedSelector(bytes21,bytes4)'))) {
        const [vId] = abi.decode(['bytes21', 'bytes4'], body);
        return word(state.permissions.has(vId.slice(4, 12).toLowerCase()) ? 1 : 0);
      }
      if (data.startsWith(sel('status(bytes32,address)'))) {
        const [id] = abi.decode(['bytes32', 'address'], body);
        return word(state.seen.has(id.slice(2, 10).toLowerCase()) ? 1 : 0);
      }
      if (same(to, KERNEL_PERMISSION_MODULES.ecdsaSigner) && data.startsWith(sel('signer(bytes32,address)'))) {
        const [id] = abi.decode(['bytes32', 'address'], body);
        const p = state.permissions.get(id.slice(2, 10).toLowerCase());
        return pad32(p ? p.signer : ZERO);
      }
      if (same(to, ENTRYPOINT_V07) && data.startsWith(sel('getNonce(address,uint192)'))) {
        const [, key] = abi.decode(['address', 'uint192'], body);
        return word((BigInt(key) << 64n) | 0n);
      }
    }
    return base(method, params);
  };
  transport.calls = calls;
  transport.state = state;
  /** Emulates the inclusion of an install of `pid` for `signer`. */
  transport.install = (pid, signer, policyCount) => {
    const key = pid.replace(/^0x/, '').toLowerCase();
    state.currentNonce += 1;
    state.permissions.set(key, {
      nonce: state.currentNonce,
      signer,
      policies: Array.from({ length: policyCount }, (_, i) => '0x0000' + [KERNEL_PERMISSION_MODULES.callPolicy, KERNEL_PERMISSION_MODULES.timestampPolicy, KERNEL_PERMISSION_MODULES.gasPolicy][i % 3].slice(2)),
    });
    state.seen.add(key);
  };
  transport.uninstall = (pid) => void state.permissions.delete(pid.replace(/^0x/, '').toLowerCase());
  return transport;
}

function kernelBundle(node, bundler, accountType = 'kernel-v3.3') {
  return createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: KERNEL_V3_3.factory,
    chainId: CHAIN_ID,
    accountIndex: 0,
    accountType,
    transportFor: (url) => (url.includes('bundler') ? bundler : node),
  });
}

// ---------------------------------------------------------------------------
console.log('check-sessions: which account a session can live in');
// ---------------------------------------------------------------------------
{
  const node = fakeSessionNode();
  const r = await resolveSessionAccount(kernelBundle(node, fakeBundler()), OWNER_0);
  check('deployed Kernel v3.3 account → eligible, the engine-predicted address', r.ok && r.account === ACCOUNT && r.kind === 'kernel-v3.3', JSON.stringify(r));
  const undeployed = await resolveSessionAccount(kernelBundle(fakeSessionNode({ deployed: false }), fakeBundler()), OWNER_0);
  check('undeployed Kernel account → plain refusal', !undeployed.ok && undeployed.reason === SESSION_UNDEPLOYED_REFUSAL);
  const simple = createAaClient({
    nodeUrl: 'n',
    bundlerUrl: 'bundler',
    factory: '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985',
    chainId: CHAIN_ID,
    transportFor: (u) => (u.includes('bundler') ? fakeBundler() : fakeSessionNode()),
  });
  const s = await resolveSessionAccount(simple, OWNER_0);
  check('SimpleAccount → plain refusal (no permission system)', !s.ok && s.reason === SESSION_SIMPLE_REFUSAL);
  const delegated = fakeSessionNode({ codeOverride: {} });
  const delegatedNode = async (method, params) =>
    method === 'eth_getCode' && same(params[0], OWNER_0) ? '0xef0100' + KERNEL_V3_3.implementation.slice(2).toLowerCase() : delegated(method, params);
  const up = await resolveSessionAccount(kernelBundle(delegatedNode, fakeBundler(), 'kernel-7702'), OWNER_0);
  check('EIP-7702 owner delegated to the wallet Kernel delegate → eligible at its own address', up.ok && same(up.account, OWNER_0) && up.kind === 'kernel-7702', JSON.stringify(up));
  const plainNode = async (method, params) => (method === 'eth_getCode' && same(params[0], OWNER_0) ? '0x' : delegated(method, params));
  const notUp = await resolveSessionAccount(kernelBundle(plainNode, fakeBundler(), 'kernel-7702'), OWNER_0);
  check('EIP-7702 owner not yet delegated on-chain → plain refusal', !notUp.ok && notUp.reason === SESSION_NOT_UPGRADED_REFUSAL);
  const wrongChain = await resolveSessionAccount(kernelBundle(fakeSessionNode({ chainIdHex: '0x1' }), fakeBundler()), OWNER_0);
  check('endpoint on another chain → refusal naming both chain ids', !wrongChain.ok && /\b1\b.*expected 11155111/.test(wrongChain.reason), wrongChain.reason);
}

// ---------------------------------------------------------------------------
console.log('check-sessions: manual grant form and engine refusals (verbatim)');
// ---------------------------------------------------------------------------
const NOW = Math.floor(Date.now() / 1000);
const engineMessage = (grant) => {
  try {
    validateSessionKeyGrant(grant, { account: ACCOUNT, now: NOW });
    return null;
  } catch (e) {
    return e.message;
  }
};
{
  const key = newSessionKey();
  check('newSessionKey: 32-byte key whose address ethers derives identically', key.privateKey.length === 32 && same(new ethers.Wallet(toHex(key.privateKey)).address, key.address));
  key.privateKey.fill(0);
  check('selector input: canonical signature → engine selector', parseSelectorInput('transfer(address, uint256)') === '0xa9059cbb');
  check('selector input: hex kept (lowercased); empty → null', parseSelectorInput('0xA9059CBB') === '0xa9059cbb' && parseSelectorInput('  ') === null);
  check('selector input: garbage refused with a plain message', /0x followed by 8 hex/.test((await caught(() => parseSelectorInput('send money')))?.message ?? ''));

  const base = { sessionKey: '0x' + '11'.repeat(20), expirySeconds: 3600, gasBudgetEth: '', now: NOW };
  const g = buildManualGrant({ ...base, drafts: [{ target: RECIPIENT.toLowerCase(), selector: '', valueCapEth: '0.001' }] });
  check('form → grant: checksummed target, null selector, exact wei cap, validUntil = now + 1 h, validAfter 0',
    g.calls[0].target === RECIPIENT && g.calls[0].selector === null && g.calls[0].valueLimit === 10n ** 15n && g.validUntil === NOW + 3600 && g.validAfter === 0 && g.gasBudgetWei === undefined);
  check('a valid grant passes the engine (validateGrantForAccount → null)', validateGrantForAccount(g, ACCOUNT, NOW) === null);
  const withGas = buildManualGrant({ ...base, gasBudgetEth: '0.01', drafts: [{ target: RECIPIENT, selector: 'transfer(address,uint256)', valueCapEth: '' }] });
  check('gas budget parsed exactly; empty value cap = 0', withGas.gasBudgetWei === 10n ** 16n && withGas.calls[0].valueLimit === 0n && withGas.calls[0].selector === '0xa9059cbb');
  check('form refuses a bad address with the send screen’s message', /Allowed call 1: An Ethereum address is 0x/.test((await caught(() => buildManualGrant({ ...base, drafts: [{ target: '0x123', selector: '', valueCapEth: '' }] })))?.message ?? ''));
  check('form refuses an expiry that is not a preset (the window is mandatory)', /how long/.test((await caught(() => buildManualGrant({ ...base, expirySeconds: 0, drafts: [{ target: RECIPIENT, selector: '', valueCapEth: '' }] })))?.message ?? ''));

  const selfCall = buildManualGrant({ ...base, drafts: [{ target: ACCOUNT, selector: 'installValidations(bytes21[],(uint32,address)[],bytes[],bytes[])', valueCapEth: '' }] });
  const selfMsg = validateGrantForAccount(selfCall, ACCOUNT, NOW);
  check('self-call with a selector refused with the engine’s exact text', selfMsg !== null && selfMsg === engineMessage(selfCall) && /may call the account itself only/.test(selfMsg), selfMsg);
  const wildcard = buildManualGrant({ ...base, drafts: [{ target: ZERO, selector: '', valueCapEth: '' }] });
  const wildMsg = validateGrantForAccount(wildcard, ACCOUNT, NOW);
  check('zero-address (wildcard) target refused with the engine’s exact text', wildMsg !== null && wildMsg === engineMessage(wildcard) && /wildcard/.test(wildMsg), wildMsg);
  const openEnded = { ...g, validUntil: 0 };
  const openMsg = validateGrantForAccount(openEnded, ACCOUNT, NOW);
  check('open-ended window refused with the engine’s exact text', openMsg !== null && openMsg === engineMessage(openEnded) && /non-zero/.test(openMsg), openMsg);
  const dup = buildManualGrant({ ...base, drafts: [{ target: RECIPIENT, selector: '', valueCapEth: '' }, { target: RECIPIENT, selector: '', valueCapEth: '1' }] });
  check('duplicate (target, selector) refused with the engine’s exact text', validateGrantForAccount(dup, ACCOUNT, NOW) === engineMessage(dup) && /duplicates/.test(engineMessage(dup)));

  // prepareSessionInstall refuses an invalid grant BEFORE any network request.
  const node = fakeSessionNode();
  const bundler = fakeBundler();
  const err = await caught(() => prepareSessionInstall(kernelBundle(node, bundler), OWNER_0, ACCOUNT, selfCall, { now: NOW }));
  check('prepareSessionInstall: refusal is the engine’s text and makes zero network calls',
    err?.message === selfMsg && node.calls.length === 0 && bundler.calls.length === 0, `${err?.message} / ${node.calls.length}`);

  const d = describeAllowedCall(g.calls[0], { symbol: 'ETH', account: ACCOUNT, nameFor: (a) => (same(a, RECIPIENT) ? 'Burn' : null) });
  check('plain language: plain transfer names the contact WITH the full address and the per-call cap', d.title === `Send up to 0.001 ETH per call to Burn (${RECIPIENT})` && d.details.some((l) => /per call, not a total/.test(l)));
  const approveDesc = describeAllowedCall({ target: RECIPIENT, selector: toHex(selector('approve(address,uint256)')), valueLimit: 0n }, { symbol: 'ETH', account: ACCOUNT });
  check('plain language: approve() is named and carries a lasting-power warning', /approve\(address,uint256\)/.test(approveDesc.title) && /ANY spender/.test(approveDesc.warning ?? ''));
}

// ---------------------------------------------------------------------------
console.log('check-sessions: install (explicit, root-signed) and store discipline');
// ---------------------------------------------------------------------------
const store = memoryStore();
const vault = fakeVault();
const node = fakeSessionNode();
const bundler = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
const bundle = kernelBundle(node, bundler);
const sessionKey = newSessionKey();
const sessionKeyHex = toHex(sessionKey.privateKey).toLowerCase();
const grant = buildManualGrant({
  sessionKey: sessionKey.address,
  drafts: [
    { target: RECIPIENT, selector: '', valueCapEth: '0.0001' },
    { target: OWNER_0, selector: 'transfer(address,uint256)', valueCapEth: '' },
  ],
  expirySeconds: 600,
  gasBudgetEth: '',
  now: NOW,
});
let installRecord;
{
  const { install, quote } = await prepareSessionInstall(bundle, OWNER_0, ACCOUNT, grant, { now: NOW });
  const independent = encodePermissionInstall(grant, { chainId: CHAIN_ID, account: ACCOUNT, currentNonce: 1, validationNonce: 0, now: NOW });
  check('install payload = engine encodePermissionInstall for the on-chain nonces (permission id, calls)',
    toHex(install.permissionId) === toHex(independent.permissionId) &&
      install.installCalls.length === 2 &&
      install.installCalls.every((c, i) => same(c.to, ACCOUNT) && c.value === 0n && toHex(c.data) === toHex(independent.installCalls[i].data)));
  const kernelIface = new ethers.Interface([
    'function installValidations(bytes21[] vIds, (uint32,address)[] configs, bytes[] validationData, bytes[] hookData)',
    'function grantAccess(bytes21 vId, bytes4 selector, bool allow)',
    'function uninstallValidation(bytes21 vId, bytes deinitData, bytes hookDeinitData)',
  ]);
  const vId = toHex(permissionValidationId(install.permissionId));
  // Kernel nonce rule (engine nextValidationNonce): currentNonce 1, stored 0 → 1.
  check('install call 1 = ethers installValidations([vId], [(nonce 1, 0x0)], [validatorData], [0x])',
    install.enable.nonce === 1 &&
      toHex(install.installCalls[0].data) === kernelIface.encodeFunctionData('installValidations', [[vId], [[1, ZERO]], [toHex(install.validatorData)], ['0x']]));
  check('install call 2 = ethers grantAccess(vId, execute selector, true)',
    toHex(install.installCalls[1].data) === kernelIface.encodeFunctionData('grantAccess', [vId, sel('execute(bytes32,bytes)'), true]));
  check('quote = the two install calls from the deployed Kernel account; no EIP-7702 tuple', quote.calls.length === 2 && quote.sender === ACCOUNT && quote.deployed && !quote.eip7702);

  let submitted = 0;
  const { record, userOpHash } = await installSession({
    quote, install, grant, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3',
    label: 'Manual', source: 'manual', sessionPrivateKey: sessionKey.privateKey, store, vault,
    submit: async (q) => {
      submitted += 1;
      // Before submission the key is already in the vault and the record saved.
      check('key in the vault and record saved BEFORE submission', vault.map.size === 1 && (await loadSessions(store)).records.length === 1);
      return sendAa(bundle, owner, q);
    },
  });
  installRecord = record;
  const op = fromRpcOp(bundler.lastOp);
  const decoded = decodeKernelExecute(op.callData);
  check('submitted op executes exactly the engine installCalls (decoded by ethers)',
    submitted === 1 && decoded.calls.length === 2 && decoded.calls.every((c, i) => same(c.to, ACCOUNT) && c.data === toHex(install.installCalls[i].data)));
  const hash = getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID);
  const recovered = ethers.recoverAddress(ethers.hashMessage(hash), toHex(op.signature));
  check('install op is ROOT-signed: signature recovers (ethers) to the owner EOA', same(recovered, OWNER_0) && op.nonce === 0n);
  check('record: installing, explicit, keyHeld, userOpHash recorded', record.localStatus === 'installing' && record.installMode === 'explicit' && record.keyHeld && record.installUserOpHash === userOpHash && record.permissionId === toHex(install.permissionId));

  const vaultId = sessionVaultId(M, ACCOUNT, record.permissionId);
  check('vault id is "<chain decimal>.<account>.<pid>" (expo-secure-store key alphabet)', vaultId === `11155111.${ACCOUNT.toLowerCase()}.${record.permissionId.slice(2)}` && /^[0-9A-Za-z._-]+$/.test(vaultId));
  check('the private key is in the vault under that id', vault.map.get(vaultId)?.toLowerCase() === sessionKeyHex);
  const raw = store._map.get(SESSIONS_KEY) ?? '';
  check('AsyncStorage-shaped store never contains the private key (with or without 0x)', raw.length > 0 && !raw.toLowerCase().includes(sessionKeyHex.slice(2)));
  check('stored record carries the session ADDRESS only', raw.includes(sessionKey.address) && JSON.parse(raw).records && !/privateKey|secret/i.test(raw));

  node.install(record.permissionId, sessionKey.address, install.policyCount);
  const fin = await finalizeSessionInstall(bundle, record, store, { timeoutMs: 1000, pollMs: 10 });
  installRecord = fin.record;
  check('finalize: receipt success + on-chain state → installed / active', fin.record.localStatus === 'installed' && fin.status.kind === 'active' && fin.receipt.txHash === TX_HASH);

  // Failure path: the bundler refuses → record kept as failed, key kept.
  const store2 = memoryStore();
  const vault2 = fakeVault();
  const k2 = newSessionKey();
  const g2 = { ...grant, sessionKey: k2.address };
  const p2 = await prepareSessionInstall(bundle, OWNER_0, ACCOUNT, g2, { now: NOW });
  const e2 = await caught(() =>
    installSession({ ...p2, grant: g2, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3', label: 'Manual', source: 'manual', sessionPrivateKey: k2.privateKey, store: store2, vault: vault2, submit: async () => { throw new Error('RPC error -32500: AA23 reverted'); } }),
  );
  const after = (await loadSessions(store2)).records[0];
  check('bundler refusal → error surfaced, record kept as failed (key kept until the chain says forgettable)', e2?.message.includes('AA23') && after?.localStatus === 'failed' && vault2.map.size === 1);
  check('failed install reads as not installed on-chain', (await readSessionStatus(node, after)).kind === 'not-installed');
  await forgetSession({ record: after, node, store: store2, vault: vault2 });
  check('forget (not active) removes the record and its key', (await loadSessions(store2)).records.length === 0 && vault2.map.size === 0);
  // A key that does not match the grant is refused before anything is stored.
  const e3 = await caught(() =>
    installSession({ ...p2, grant: g2, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3', label: 'Manual', source: 'manual', sessionPrivateKey: newSessionKey().privateKey, store: store2, vault: vault2, submit: async () => ({ userOpHash: '0x' }) }),
  );
  check('a session key that does not match the grant is refused; nothing stored', /does not match/.test(e3?.message ?? '') && vault2.map.size === 0);
}

// ---------------------------------------------------------------------------
console.log('check-sessions: corrupt storage');
// ---------------------------------------------------------------------------
{
  const s = memoryStore();
  await s.setItem(SESSIONS_KEY, '{not json');
  const load = await loadSessions(s);
  check('unparseable list → empty + unreadable flag', load.records.length === 0 && load.unreadable && load.corrupt);
  const e = await caught(() => saveSessionRecord(installRecord, s));
  check('writes refused while unreadable (nothing overwritten)', /could not be read/.test(e?.message ?? '') && (await s.getItem(SESSIONS_KEY)) === '{not json');
  await resetSessions(s);
  await saveSessionRecord(installRecord, s);
  check('explicit reset, then writes work again', (await loadSessions(s)).records.length === 1);
  const parsed = JSON.parse(await s.getItem(SESSIONS_KEY));
  parsed.records['eip155:1|0xbad|0x00000000'] = { chain: 'eip155:1', grant: { version: 9 } };
  await s.setItem(SESSIONS_KEY, JSON.stringify(parsed));
  const partial = await loadSessions(s);
  check('one malformed record → dropped and flagged, the valid one still listed', partial.records.length === 1 && partial.corrupt && !partial.unreadable);
  await s.setItem(SESSIONS_KEY, JSON.stringify({ version: 2, records: {} }));
  check('unknown format version → unreadable', (await loadSessions(s)).unreadable);
}

// ---------------------------------------------------------------------------
console.log('check-sessions: session-signed operation (owner never involved)');
// ---------------------------------------------------------------------------
{
  const allowed = sessionTestCall(grant.calls[0]);
  check('test call = target, 0 value, empty calldata for a plain-transfer entry', allowed.to === RECIPIENT && allowed.value === 0n && allowed.data.length === 0);
  const { userOpHash } = await sendSessionCalls({ bundle, record: installRecord, calls: [allowed], vault, now: NOW });
  const op = fromRpcOp(bundler.lastOp);
  const pidKey = sessionNonceKey(installRecord.permissionId);
  check('op nonce uses the permission nonce key (key << 64), default mode', op.nonce >> 64n === pidKey && op.nonce >> 64n !== 0n);
  check('op signature = 0xff || 65 bytes', op.signature.length === 66 && op.signature[0] === 0xff);
  const hash = getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID);
  const signer = ethers.recoverAddress(ethers.hashMessage(hash), toHex(op.signature.slice(1)));
  check('signature recovers (ethers) to the SESSION key address', same(signer, sessionKey.address), signer);
  check('…and NOT to the owner EOA', !same(signer, OWNER_0));
  check('sender is the Kernel account; calldata executes the allowed call (ethers decode)',
    same(op.sender, ACCOUNT) && decodeKernelExecute(op.callData).calls[0].to === RECIPIENT && !op.factory && typeof userOpHash === 'string');
  const estimated = bundler.lastEstimated;
  check('estimation stub also carries the 0xff session prefix', estimated && estimated.signature.startsWith('0xff'));

  const nodeBefore = node.calls.length;
  const bundlerBefore = bundler.calls.length;
  const loadsBefore = vault.loads;
  const outside = await caught(() =>
    sendSessionCalls({ bundle, record: installRecord, calls: [{ to: '0x1111111111111111111111111111111111111111', value: 0n, data: new Uint8Array(0) }], vault, now: NOW }),
  );
  check('out-of-grant target refused locally (engine assertCallsAllowed text)', /is not allowed by this session/.test(outside?.message ?? ''), outside?.message);
  const overCap = await caught(() =>
    sendSessionCalls({ bundle, record: installRecord, calls: [{ to: RECIPIENT, value: 10n ** 15n, data: new Uint8Array(0) }], vault, now: NOW }),
  );
  check('value above the per-call cap refused locally', /exceeds the session's cap/.test(overCap?.message ?? ''), overCap?.message);
  const expired = await caught(() => sendSessionCalls({ bundle, record: installRecord, calls: [allowed], vault, now: grant.validUntil + 1 }));
  check('expired window refused locally', /expired/.test(expired?.message ?? ''));
  check('refusals made ZERO node calls, ZERO bundler calls and read no key',
    node.calls.length === nodeBefore && bundler.calls.length === bundlerBefore && vault.loads === loadsBefore,
    `${node.calls.length - nodeBefore}/${bundler.calls.length - bundlerBefore}/${vault.loads - loadsBefore}`);

  const src = readFileSync(new URL('../src/wallet/sessions.ts', import.meta.url), 'utf8');
  check('sessions.ts has no path to the owner key (no signWith, mnemonic or storage.ts import)',
    !/signWith\(|loadMnemonic|mnemonicToSeed|from '\.\/storage/.test(src));
}

// ---------------------------------------------------------------------------
console.log('check-sessions: on-chain status');
// ---------------------------------------------------------------------------
{
  check('active and in the window → active, not expired', JSON.stringify(await readSessionStatus(node, installRecord, NOW)) === JSON.stringify({ kind: 'active', expired: false }));
  check('past validUntil → active but expired (revoke to clean up)', (await readSessionStatus(node, installRecord, grant.validUntil)).expired === true);
  const wrongSigner = { ...installRecord, grant: { ...installRecord.grant, sessionKey: '0x' + '22'.repeat(20) } };
  check('on-chain signer differs from the grant → unknown, never active', (await readSessionStatus(node, wrongSigner, NOW)).kind === 'unknown');
  node.state.failReads = true;
  const unk = await readSessionStatus(node, installRecord, NOW);
  node.state.failReads = false;
  check('read failure → unknown with the reason', unk.kind === 'unknown' && /node unavailable/.test(unk.reason));
  const e = await caught(() => forgetSession({ record: installRecord, node, store, vault }));
  check('forget refused while the session is active', /still active/.test(e?.message ?? '') && vault.map.size === 1);
}

// ---------------------------------------------------------------------------
console.log('check-sessions: revocation');
// ---------------------------------------------------------------------------
{
  const quote = await prepareSessionRevoke(bundle, OWNER_0, installRecord);
  const expected = permissionRevokeCall(ACCOUNT, installRecord.permissionId, installRecord.policyCount);
  const iface = new ethers.Interface(['function uninstallValidation(bytes21 vId, bytes deinitData, bytes hookDeinitData)']);
  const ethersData = iface.encodeFunctionData('uninstallValidation', [
    toHex(permissionValidationId(installRecord.permissionId)),
    abi.encode(['bytes[]'], [Array(installRecord.policyCount + 1).fill('0x')]),
    '0x',
  ]);
  check('revoke quote = one self-call, data = engine permissionRevokeCall = ethers uninstallValidation',
    quote.calls.length === 1 && same(quote.calls[0].to, ACCOUNT) && toHex(quote.calls[0].data) === toHex(expected.data) && toHex(expected.data) === ethersData);
  check('revoke refused for another owner', /Only the account that granted/.test((await caught(() => prepareSessionRevoke(bundle, '0x' + '33'.repeat(20), installRecord)))?.message ?? ''));
  const { record, userOpHash } = await revokeSession({ record: installRecord, quote, store, vault, submit: (q) => sendAa(bundle, owner, q) });
  const op = fromRpcOp(bundler.lastOp);
  check('submitted revoke op executes uninstallValidation, root-signed by the owner',
    decodeKernelExecute(op.callData).calls[0].data === ethersData &&
      same(ethers.recoverAddress(ethers.hashMessage(getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID)), toHex(op.signature)), OWNER_0));
  check('after the bundler accepted it: key deleted from the vault, record revoking', vault.map.size === 0 && record.localStatus === 'revoking' && !record.keyHeld && record.revokeUserOpHash === userOpHash);
  node.uninstall(record.permissionId);
  const fin = await finalizeSessionRevoke(bundle, record, store, { timeoutMs: 1000, pollMs: 10 });
  check('finalize: receipt + chain agree → revoked', fin.record.localStatus === 'revoked' && fin.status.kind === 'revoked');
  const reuse = await caught(() => sendSessionCalls({ bundle, record: fin.record, calls: [sessionTestCall(grant.calls[0])], vault, now: NOW }));
  check('a revoked session can no longer sign (key gone, refused locally)', /key is held by the dApp|revoked/.test(reuse?.message ?? ''), reuse?.message);
  await forgetSession({ record: fin.record, node, store, vault });
  check('forget after revocation empties the list', (await loadSessions(store)).records.length === 0);
}

// ---------------------------------------------------------------------------
console.log('check-sessions: wipe');
// ---------------------------------------------------------------------------
{
  const s = memoryStore();
  const v = fakeVault();
  const k = newSessionKey();
  const g = { ...grant, sessionKey: k.address };
  const p = await prepareSessionInstall(bundle, OWNER_0, ACCOUNT, g, { now: NOW });
  await installSession({ ...p, grant: g, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3', label: 'Manual', source: 'manual', sessionPrivateKey: k.privateKey, store: s, vault: v, submit: (q) => sendAa(bundle, owner, q) });
  const { keysRemoved } = await forgetAllSessions(s, v);
  check('forgetAllSessions (wipe) deletes every session key and the list', keysRemoved === 1 && v.map.size === 0 && (await loadSessions(s)).records.length === 0);
}

// ---------------------------------------------------------------------------
console.log('check-sessions: ERC-7715 over WalletConnect');
// ---------------------------------------------------------------------------
const kernelSmart = { smartAccount: { accountType: 'kernel-v3.3', signsMessages: true } };
const event = (id, method, params, chainId = M, topic = 'T1') => ({ id, topic, params: { chainId, request: { method, params } } });
{
  check('ERC-7715 methods: exactly the two implemented names', JSON.stringify(WC_7715_METHODS) === JSON.stringify(['wallet_getSupportedExecutionPermissions', 'wallet_requestExecutionPermissions']));
  check('Kernel smart-account connections offer them; SimpleAccount and EOA connections do not',
    WC_7715_METHODS.every((m) => smartAccountMethodsFor('kernel-v3.3').includes(m)) &&
      WC_7715_METHODS.every((m) => !smartAccountMethodsFor('simple').includes(m)) &&
      WC_SMART_ACCOUNT_METHODS.every((m) => WC_KERNEL_SMART_ACCOUNT_METHODS.includes(m)));
  const proposal = { requiredNamespaces: {}, optionalNamespaces: { eip155: { chains: [M], methods: ['eth_sendTransaction', ...WC_7715_METHODS], events: [] } } };
  const kp = decideProposal(proposal, ACCOUNT, M, smartAccountMethodsFor('kernel-v3.3'));
  const sp = decideProposal(proposal, ACCOUNT, M, smartAccountMethodsFor('simple'));
  check('a Kernel connection approves the 7715 methods the dApp asked for; a SimpleAccount one leaves them out',
    kp.ok && WC_7715_METHODS.every((m) => kp.namespaces.eip155.methods.includes(m)) && sp.ok && !sp.namespaces.eip155.methods.some((m) => WC_7715_METHODS.includes(m)));

  const supported = decideSupportedExecutionPermissions({ accountType: 'kernel-v3.3' }, 'eip155:11155111');
  check('wallet_getSupportedExecutionPermissions → only the wallet type, active chain, ruleTypes [expiry]',
    JSON.stringify(supported.result) === JSON.stringify({ [ERC7715_CALLS_PERMISSION_TYPE]: { chainIds: ['0xaa36a7'], ruleTypes: ['expiry'] } }));
  check('…refused (5101) outside Kernel smart-account sessions', decideSupportedExecutionPermissions(null, M).error?.code === 5101 && decideSupportedExecutionPermissions({ accountType: 'simple' }, M).error?.code === 5101);

  const dappKey = ethers.Wallet.createRandom();
  const dappGrant = {
    sessionKey: dappKey.address,
    calls: [{ target: RECIPIENT, selector: null, valueLimit: 10n ** 14n }, { target: OWNER_0, selector: '0xa9059cbb', valueLimit: 0n }],
    validAfter: 0,
    validUntil: NOW + 900,
  };
  const request = grantToErc7715Request(dappGrant, { chainId: CHAIN_ID, account: ACCOUNT, isAdjustmentAllowed: false });
  const parsed = parseWcRequest(event(1, 'wallet_requestExecutionPermissions', [request]), ACCOUNT, M, kernelSmart);
  check('request → parsed permissions with the engine-mapped grant (session key = the dApp’s `to`)',
    parsed.kind === 'permissions' && parsed.grant.sessionKey === dappKey.address && parsed.grant.calls.length === 2 &&
      parsed.grant.calls[0].valueLimit === 10n ** 14n && parsed.grant.validUntil === NOW + 900 && parsed.isAdjustmentAllowed === false);

  const rej = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof WcRequestRejection ? e : { code: 'not-a-rejection', message: e.message };
    }
  };
  const native = rej(() => parseWcRequest(event(2, 'wallet_requestExecutionPermissions', [{ ...request, permission: { type: 'native-token-allowance', isAdjustmentAllowed: false, data: { allowance: '0x1' } } }]), ACCOUNT, M, kernelSmart));
  check('native-token-allowance → ERC-1193 4200 with the engine’s reason', native?.code === ERC7715_ERRORS.unsupported && native.code === 4200 && /cumulative/.test(native.message));
  const unknownType = rej(() => parseWcRequest(event(3, 'wallet_requestExecutionPermissions', [{ ...request, permission: { ...request.permission, type: 'erc20-token-allowance' } }]), ACCOUNT, M, kernelSmart));
  check('unknown permission type → 4200', unknownType?.code === 4200 && /not supported/.test(unknownType.message));
  const noExpiry = rej(() => parseWcRequest(event(4, 'wallet_requestExecutionPermissions', [{ ...request, rules: [] }]), ACCOUNT, M, kernelSmart));
  check('missing expiry rule → 4200 (open-ended sessions refused)', noExpiry?.code === 4200 && /expiry rule is required/.test(noExpiry.message));
  const selfReq = grantToErc7715Request({ ...dappGrant, calls: [{ target: '0x' + '44'.repeat(20), selector: null, valueLimit: 0n }] }, { chainId: CHAIN_ID });
  selfReq.permission.data.calls[0].target = ACCOUNT;
  selfReq.permission.data.calls[0].selector = '0x12345678';
  const selfRej = rej(() => parseWcRequest(event(5, 'wallet_requestExecutionPermissions', [selfReq]), ACCOUNT, M, kernelSmart));
  check('self-call grant → -32602 with the engine’s exact text', selfRej?.code === -32602 && /may call the account itself only/.test(selfRej.message));
  const fromRej = rej(() => parseWcRequest(event(6, 'wallet_requestExecutionPermissions', [{ ...request, from: OWNER_0 }]), ACCOUNT, M, kernelSmart));
  check('`from` other than the bound smart account → 4100', fromRej?.code === 4100);
  const chainRej = rej(() => parseWcRequest(event(7, 'wallet_requestExecutionPermissions', [{ ...request, chainId: '0x1' }]), ACCOUNT, M, kernelSmart));
  check('request chainId other than the active chain → 4901', chainRej?.code === 4901);
  const twoRej = rej(() => parseWcRequest(event(8, 'wallet_requestExecutionPermissions', [request, request]), ACCOUNT, M, kernelSmart));
  check('more than one PermissionRequest → -32602 (one grant per request)', twoRej?.code === -32602);
  const eoaRej = rej(() => parseWcRequest(event(9, 'wallet_requestExecutionPermissions', [request]), OWNER_0, M));
  const simpleRej = rej(() => parseWcRequest(event(10, 'wallet_requestExecutionPermissions', [request]), ACCOUNT, M, { smartAccount: { accountType: 'simple', signsMessages: false } }));
  check('refused (5101) on EOA and SimpleAccount sessions', eoaRej?.code === 5101 && simpleRej?.code === 5101);

  // Narrowing (isAdjustmentAllowed true): only reductions.
  const narrowed = narrowGrant(parsed.grant, { keep: [true, false], validUntil: NOW + 600 });
  check('narrowGrant drops calls and shortens expiry', narrowed.calls.length === 1 && narrowed.validUntil === NOW + 600);
  check('narrowGrant refuses to widen the expiry or keep nothing',
    /only be shortened/.test((await caught(() => narrowGrant(parsed.grant, { keep: [true, true], validUntil: NOW + 99999 })))?.message ?? '') &&
      /at least one/.test((await caught(() => narrowGrant(parsed.grant, { keep: [false, false], validUntil: NOW + 600 })))?.message ?? ''));

  // Round trip: request → grant → install (same path as manual) → response.
  const s = memoryStore();
  const n = fakeSessionNode();
  const b = fakeBundler({ receipt: { success: true, receipt: { transactionHash: TX_HASH } } });
  const kb = kernelBundle(n, b);
  const { install, quote } = await prepareSessionInstall(kb, OWNER_0, ACCOUNT, parsed.grant);
  const { record } = await installSession({
    quote, install, grant: parsed.grant, chain: M, account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3',
    label: 'Uniswap', source: 'erc7715', dappUrl: 'https://app.uniswap.org', sessionPrivateKey: null, store: s, vault: null,
    submit: (q) => sendAa(kb, owner, q),
  });
  check('ERC-7715 install: same explicit root-signed install calls; no key stored by the wallet',
    decodeKernelExecute(fromRpcOp(b.lastOp).callData).calls.length === 2 && !record.keyHeld && record.source === 'erc7715' && !(s._map.get(SESSIONS_KEY) ?? '').includes('privateKey'));
  n.install(record.permissionId, dappKey.address, install.policyCount);
  const fin = await finalizeSessionInstall(kb, record, s, { timeoutMs: 1000, pollMs: 10 });
  const response = buildErc7715Response(fin.record, { isAdjustmentAllowed: false, installTransactionHash: fin.receipt.txHash });
  check('response echoes the granted request: chainId, from = Kernel account, to = dApp session key',
    response.chainId === '0xaa36a7' && response.from === ACCOUNT && response.to === dappKey.address);
  check('response permission = wallet type with the granted calls; expiry rule = validUntil',
    response.permission.type === ERC7715_CALLS_PERMISSION_TYPE && response.permission.isAdjustmentAllowed === false &&
      response.permission.data.calls.length === 2 && response.rules[0].type === 'expiry' && response.rules[0].data.timestamp === NOW + 900);
  check('context = the Kernel validation id; dependencies = [] (deployed account)',
    response.context === toHex(permissionValidationId(record.permissionId)) && Array.isArray(response.dependencies) && response.dependencies.length === 0);
  check('delegationManager deliberately ABSENT (no ERC-7710 manager exists for Kernel permissions)', !('delegationManager' in response) && /delegation manager/.test(ERC7715_LIMITATION_NOTE));
  const k = response[KERNEL_SESSION_RESPONSE_KEY];
  check('Kernel details: permission id, nonce key, signer module, install tx',
    k.permissionId === record.permissionId && BigInt(k.nonceKey) === sessionNonceKey(record.permissionId) &&
      k.signerModule === KERNEL_PERMISSION_MODULES.ecdsaSigner && k.installTransactionHash === TX_HASH && k.entryPoint === ENTRYPOINT_V07);
  const back = parseWcRequest(event(11, 'wallet_requestExecutionPermissions', [{ chainId: response.chainId, from: response.from, to: response.to, permission: response.permission, rules: response.rules }]), ACCOUNT, M, kernelSmart);
  check('response request part maps back to the same grant (engine round trip)',
    back.grant.sessionKey === dappKey.address && back.grant.calls.every((c, i) => c.target === parsed.grant.calls[i].target && c.valueLimit === parsed.grant.calls[i].valueLimit));
  check('a dApp-held session cannot be driven by the wallet (no key)', /held by the dApp/.test((await caught(() => sendSessionCalls({ bundle: kb, record: fin.record, calls: [sessionTestCall(parsed.grant.calls[0])], vault: fakeVault() })))?.message ?? ''));
}

// ---------------------------------------------------------------------------
console.log('check-sessions: controller routing');
// ---------------------------------------------------------------------------
{
  function fakeKit(sessions) {
    const handlers = new Map();
    const calls = { respond: [] };
    return {
      calls,
      respondSessionRequest: async (a) => void calls.respond.push(a),
      approveSession: async () => {},
      rejectSession: async () => {},
      getActiveSessions: () => sessions,
      on(ev, fn) {
        if (!handlers.has(ev)) handlers.set(ev, new Set());
        handlers.get(ev).add(fn);
      },
      off(ev, fn) {
        handlers.get(ev)?.delete(fn);
      },
      async fire(ev, payload) {
        for (const fn of handlers.get(ev) ?? []) await fn(payload);
      },
    };
  }
  const session = (topic, address) => ({
    [topic]: { topic, peer: { metadata: { name: 'Uniswap', url: 'https://app.uniswap.org' } }, namespaces: { eip155: { accounts: [`${M}:${address}`], methods: WC_KERNEL_SMART_ACCOUNT_METHODS } } },
  });
  const last = (kit) => kit.calls.respond[kit.calls.respond.length - 1]?.response;
  const request = grantToErc7715Request(
    { sessionKey: ethers.Wallet.createRandom().address, calls: [{ target: RECIPIENT, selector: null, valueLimit: 1n }], validAfter: 0, validUntil: NOW + 600 },
    { chainId: CHAIN_ID },
  );

  const kit = fakeKit(session('T1', ACCOUNT));
  const ctl = new WcController(kit, () => ({ address: OWNER_0, activeChain: M }), { bindingStore: memoryStore() });
  ctl.attach();
  await ctl.rememberSmartBinding({ chain: M, address: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountType: 'kernel-v3.3', factory: KERNEL_V3_3.factory });
  await kit.fire('session_request', event(1, 'wallet_getSupportedExecutionPermissions', []));
  check('controller answers wallet_getSupportedExecutionPermissions without UI on a Kernel session',
    last(kit)?.result?.[ERC7715_CALLS_PERMISSION_TYPE]?.ruleTypes?.[0] === 'expiry' && ctl.getSnapshot().queue.length === 0);
  await kit.fire('session_request', event(2, 'wallet_requestExecutionPermissions', [request]));
  const head = ctl.getSnapshot().queue[0];
  check('wallet_requestExecutionPermissions is QUEUED for approval (never auto-granted)', head?.parsed?.kind === 'permissions' && kit.calls.respond.length === 1);
  await ctl.decline(head.key, { code: ERC7715_ERRORS.userRejected, message: 'The user declined the permission request.' });
  check('user decline answers ERC-1193 4001', last(kit)?.error?.code === 4001);
  await kit.fire('session_request', event(3, 'wallet_requestExecutionPermissions', [{ ...request, permission: { ...request.permission, type: 'native-token-allowance' } }]));
  check('unsupported permission type auto-declined with 4200 (notice shown, not queued)', last(kit)?.error?.code === 4200 && ctl.getSnapshot().queue.length === 0);

  const kitS = fakeKit(session('T1', ACCOUNT));
  const ctlS = new WcController(kitS, () => ({ address: OWNER_0, activeChain: M }), { bindingStore: memoryStore() });
  ctlS.attach();
  await ctlS.rememberSmartBinding({ chain: M, address: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountType: 'simple', factory: '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985' });
  await kitS.fire('session_request', event(1, 'wallet_getSupportedExecutionPermissions', []));
  const a1 = last(kitS);
  await kitS.fire('session_request', event(2, 'wallet_requestExecutionPermissions', [request]));
  check('SimpleAccount smart session: both 7715 methods declined (5101)', a1?.error?.code === 5101 && last(kitS)?.error?.code === 5101);

  const kitE = fakeKit(session('T1', OWNER_0));
  const ctlE = new WcController(kitE, () => ({ address: OWNER_0, activeChain: M }), { bindingStore: memoryStore() });
  ctlE.attach();
  await kitE.fire('session_request', event(1, 'wallet_getSupportedExecutionPermissions', []));
  const e1 = last(kitE);
  await kitE.fire('session_request', event(2, 'wallet_requestExecutionPermissions', [request]));
  check('EOA session: both 7715 methods declined (5101)', e1?.error?.code === 5101 && last(kitE)?.error?.code === 5101);
}

// prepareAaCalls is imported to keep the quote path visible in this suite's
// dependency list (the install quote goes through it).
void prepareAaCalls;

// ---------------------------------------------------------------------------
console.log('check-sessions: mainnet readiness gate (phase 9 item 6)');
// ---------------------------------------------------------------------------
{
  const node = fakeSessionNode({ chainIdHex: '0x1' });
  const bundler = fakeBundler();
  const mainnetBundle = createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: KERNEL_V3_3.factory,
    chainId: 1n,
    accountIndex: 0,
    accountType: 'kernel-v3.3',
    transportFor: (url) => (url.includes('bundler') ? bundler : node),
  });
  const before = node.calls.length;
  const e1 = await caught(() => prepareSessionInstall(mainnetBundle, OWNER_0, ACCOUNT, { sessionKey: OWNER_0, calls: [], validAfter: 0, validUntil: 1 }));
  check('mainnet prepareSessionInstall refused with the readiness reason and zero network calls', /only on test networks/.test(e1?.message ?? '') && node.calls.length === before, e1?.message);
  const store = memoryStore();
  const vault = fakeVault();
  let submitted = false;
  const e2 = await caught(() => installSession({ quote: { calls: [] }, install: { installCalls: [] }, grant: {}, chain: 'eip155:1', account: ACCOUNT, owner: OWNER_0, accountIndex: 0, accountKind: 'kernel-v3.3', label: 'x', source: 'manual', sessionPrivateKey: newSessionKey().privateKey, store, vault, submit: async () => { submitted = true; return { userOpHash: '0x' }; } }));
  check('mainnet installSession refused before storing, vaulting or submitting', /only on test networks/.test(e2?.message ?? '') && !submitted && vault.map.size === 0 && (await store.getItem(SESSIONS_KEY)) === null);
  const e3 = await caught(() => sendSessionCalls({ bundle: mainnetBundle, record: { chain: 'eip155:1', grant: '{}', keyHeld: true, localStatus: 'installed' }, calls: [], vault }));
  check('mainnet sendSessionCalls refused before the vault is read or any request', /only on test networks/.test(e3?.message ?? '') && vault.loads === 0 && node.calls.length === before);
}

console.log(`\ncheck-sessions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

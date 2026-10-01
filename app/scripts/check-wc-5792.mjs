// Phase 7 items 2 and 3 (app half), WalletConnect side, entirely OFFLINE
// (fake WalletKit client, fake node/bundler, no relay, nothing broadcast):
//  - ERC-5792 wallet_sendCalls parsing and every refusal (fields and error
//    codes from EIP-5792, Final, ethereum/EIPs EIPS/eip-5792.md at commit
//    5b0c8dce4bc67d34082eff7950d44be928641207), wallet_getCapabilities and
//    wallet_getCallsStatus response shapes, batch-id records;
//  - namespaces for smart-account connections (5792 methods only there);
//  - WcController routing for smart-account-bound sessions: from checks
//    against the smart account, owner-account binding, SimpleAccount
//    signing refusal, automatic 5792 answers, duplicate ids, persistence;
//  - the provider's approval paths re-enacted with the exact app modules:
//    personal_sign / eth_signTypedData_v4 signed through the smart account
//    (ERC-1271 / ERC-6492) and validated by the engine's verifier against a
//    fake eth_simulateV1; wallet_sendCalls -> one UserOperation whose
//    callData (decoded by ethers) is exactly the dApp's calls.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-wc-5792.mjs

import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { KERNEL_V3_3, toBytes, toHex, verifyErc6492Signature } from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import {
  ERC5792_ERRORS,
  ERC5792_VERSION,
  MAX_BATCH_CALLS,
  SIMPLE_ACCOUNT_SIGNING_REFUSAL,
  WC_5792_METHODS,
  WC_SMART_ACCOUNT_METHODS,
  WC_SUPPORTED_METHODS,
  WcRequestRejection,
  approveProposal,
  callsStatusFromReceipt,
  decideGetCapabilities,
  decideProposal,
  findCallsRecord,
  generateCallsId,
  hexChainIdOf,
  loadSmartBindings,
  parseSendCalls,
  parseWcRequest,
  respondApproved,
  saveCallsRecord,
} from '../src/wallet/walletconnect.ts';
import { WcController } from '../src/wallet/wc-controller.ts';
import { createAaClientFromConfig, prepareAaCalls, sendAa, signHashAsSmartAccount } from '../src/wallet/aa.ts';
import {
  KERNEL_ACCOUNT_0,
  OWNER_0,
  TEST_MNEMONIC,
  USEROP_HASH,
  decodeKernelExecute,
  fakeBundler,
  fakeKernelNode,
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
function rejection(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof WcRequestRejection ? { code: e.code, message: e.message } : { code: 'other', message: String(e) };
  }
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

const M = 'eip155:1';
const S = 'eip155:11155111';
const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
const other = evmKeyProvider.deriveAccount(seed, 0, 1);
seed.fill(0);
const SMART = KERNEL_ACCOUNT_0;
const TARGET = '0x1111111111111111111111111111111111111111';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const sendCallsParams = (overrides = {}) => [
  {
    version: '2.0.0',
    from: SMART,
    chainId: '0x1',
    atomicRequired: true,
    calls: [
      { to: TARGET, value: '0x9184e72a', data: '0x' },
      { to: USDC, data: '0xa9059cbb' + '00'.repeat(64) },
    ],
    ...overrides,
  },
];

// ---------------------------------------------------------------------------
console.log('check-wc-5792: wallet_sendCalls parsing (ERC-5792 2.0.0)');
// ---------------------------------------------------------------------------
{
  check('implemented version is the ERC example version 2.0.0', ERC5792_VERSION === '2.0.0');
  const batch = parseSendCalls(sendCallsParams(), SMART, M);
  check('valid request parses: 2 calls in order, from + atomicRequired kept', batch.calls.length === 2 && batch.calls[0].valueWei === 0x9184e72an && batch.calls[1].data.length === 68 && batch.atomicRequired === true && batch.from === SMART && batch.id === null);
  check('missing value/data default to 0 / empty', batch.calls[1].valueWei === 0n && batch.calls[0].data.length === 0);
  check('atomicRequired false is also served (always atomic anyway)', parseSendCalls(sendCallsParams({ atomicRequired: false }), SMART, M).atomicRequired === false);
  check('from may be omitted', parseSendCalls(sendCallsParams({ from: undefined }), SMART, M).from === null);
  check('app id kept verbatim', parseSendCalls(sendCallsParams({ id: '0xabc' }), SMART, M).id === '0xabc');
  const opt = parseSendCalls(sendCallsParams({ capabilities: { paymasterService: { url: 'https://pm', optional: true } } }), SMART, M);
  check('optional unsupported capability is ignored and reported', opt.ignoredCapabilities.includes('paymasterService'));

  const cases = [
    ['version other than 2.0.0 → -32602', sendCallsParams({ version: '1.0' }), -32602],
    ['chainId with a leading zero ("0x01") → -32602', sendCallsParams({ chainId: '0x01' }), -32602],
    ['chainId without 0x → -32602', sendCallsParams({ chainId: '1' }), -32602],
    ['other chain → 5710', sendCallsParams({ chainId: '0xaa36a7' }), 5710],
    ['from is the owner EOA, not the bound smart account → 4100', sendCallsParams({ from: OWNER_0 }), 4100],
    ['atomicRequired missing → -32602', sendCallsParams({ atomicRequired: undefined }), -32602],
    ['non-optional top-level capability → 5700', sendCallsParams({ capabilities: { paymasterService: { url: 'https://pm' } } }), 5700],
    ['non-optional call-level capability → 5700', sendCallsParams({ calls: [{ to: TARGET, capabilities: { auxiliaryFunds: { optional: false } } }] }), 5700],
    [`more than ${MAX_BATCH_CALLS} calls → 5740`, sendCallsParams({ calls: Array.from({ length: MAX_BATCH_CALLS + 1 }, () => ({ to: TARGET })) }), 5740],
    ['call without to (contract creation) → -32602', sendCallsParams({ calls: [{ data: '0x6000' }] }), -32602],
    ['decimal value → -32602', sendCallsParams({ calls: [{ to: TARGET, value: 5 }] }), -32602],
    ['non-hex data → -32602', sendCallsParams({ calls: [{ to: TARGET, data: '0xzz' }] }), -32602],
    ['empty calls → -32602', sendCallsParams({ calls: [] }), -32602],
    ['id longer than 8194 characters → -32602', sendCallsParams({ id: '0x' + 'a'.repeat(8193) }), -32602],
    ['bad EIP-55 checksum in a call → -32602', sendCallsParams({ calls: [{ to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48' }] }), -32602],
  ];
  for (const [name, params, code] of cases) {
    const r = rejection(() => parseSendCalls(params, SMART, M));
    check(name, r?.code === code, JSON.stringify(r));
  }
  check('Sepolia mode accepts chainId 0xaa36a7', parseSendCalls(sendCallsParams({ chainId: '0xaa36a7' }), SMART, S).calls.length === 2);
  check('hexChainIdOf has no leading zeros', hexChainIdOf(M) === '0x1' && hexChainIdOf(S) === '0xaa36a7');

  const ev = (method, params, chainId = M) => ({ id: 1, topic: 'T', params: { chainId, request: { method, params } } });
  const smartKernel = { smartAccount: { accountType: 'kernel-v3.3', signsMessages: true } };
  const smartSimple = { smartAccount: { accountType: 'simple', signsMessages: false } };
  const parsed = parseWcRequest(ev('wallet_sendCalls', sendCallsParams()), SMART, M, smartKernel);
  check('parseWcRequest routes wallet_sendCalls on a smart session', parsed.kind === 'calls' && parsed.batch.calls.length === 2);
  check('wallet_sendCalls on an EOA session → 5101', rejection(() => parseWcRequest(ev('wallet_sendCalls', sendCallsParams({ from: OWNER_0 })), OWNER_0, M))?.code === 5101);
  const simpleSign = rejection(() => parseWcRequest(ev('personal_sign', ['0x68656c6c6f', SMART]), SMART, M, smartSimple));
  check('SimpleAccount session: personal_sign refused 5101 with the plain explanation', simpleSign?.code === 5101 && simpleSign.message === SIMPLE_ACCOUNT_SIGNING_REFUSAL);
  check('SimpleAccount session: typed data refused too', rejection(() => parseWcRequest(ev('eth_signTypedData_v4', [SMART, '{}']), SMART, M, smartSimple))?.code === 5101);
  const kSign = parseWcRequest(ev('personal_sign', ['0x68656c6c6f', SMART]), SMART, M, smartKernel);
  check('Kernel session: personal_sign naming the smart account parses', kSign.kind === 'personal_sign' && toHex(kSign.digest) === ethers.hashMessage('hello'));
  check('Kernel session: personal_sign naming the owner EOA is refused (-32602)', rejection(() => parseWcRequest(ev('personal_sign', ['0x68656c6c6f', OWNER_0]), SMART, M, smartKernel))?.code === -32602);
  const tx = parseWcRequest(ev('eth_sendTransaction', [{ from: SMART, to: TARGET, value: '0x1' }]), SMART, M, smartKernel);
  check('eth_sendTransaction from the smart account parses (sent as one call later)', tx.kind === 'transaction' && tx.tx.valueWei === 1n);
  check('eth_sendTransaction from the owner on a smart session is refused', rejection(() => parseWcRequest(ev('eth_sendTransaction', [{ from: OWNER_0, to: TARGET }]), SMART, M, smartKernel))?.code === -32602);
  check('wrong-chain envelope on a smart session → 5100', rejection(() => parseWcRequest(ev('wallet_sendCalls', sendCallsParams(), S), SMART, M, smartKernel))?.code === 5100);
}

// ---------------------------------------------------------------------------
console.log('check-wc-5792: wallet_getCapabilities and wallet_getCallsStatus shapes');
// ---------------------------------------------------------------------------
{
  const caps = decideGetCapabilities([SMART], SMART, M, true);
  check('smart session: { "0x1": { atomic: { status: "supported" } } }', JSON.stringify(caps) === JSON.stringify({ result: { '0x1': { atomic: { status: 'supported' } } } }), JSON.stringify(caps));
  check('only queried chains are included (other chain → {})', JSON.stringify(decideGetCapabilities([SMART, ['0xaa36a7']], SMART, M, true)) === '{"result":{}}');
  check('query including the active chain → included', 'result' in decideGetCapabilities([SMART, ['0x2105', '0x1']], SMART, M, true) && Object.keys(decideGetCapabilities([SMART, ['0x2105', '0x1']], SMART, M, true).result).join() === '0x1');
  check('Sepolia mode keys the answer 0xaa36a7', Object.keys(decideGetCapabilities([SMART], SMART, S, true).result).join() === '0xaa36a7');
  check('an address not in the session → 4100 Unauthorized', decideGetCapabilities([OWNER_0], SMART, M, true).error?.code === 4100);
  check('EOA session → honest {} (no atomic capability = no batching per the ERC)', JSON.stringify(decideGetCapabilities([OWNER_0], OWNER_0, M, false)) === '{"result":{}}');
  check('leading-zero chain id in the query → -32602', decideGetCapabilities([SMART, ['0x01']], SMART, M, true).error?.code === -32602);

  const record = { id: '0xabc', userOpHash: USEROP_HASH, chain: M, from: SMART, dappUrl: 'https://app.example', createdAt: Date.now() };
  check('no receipt yet → status 100, atomic true, version 2.0.0, chainId 0x1', JSON.stringify(callsStatusFromReceipt(record, null)) === JSON.stringify({ version: '2.0.0', id: '0xabc', chainId: '0x1', atomic: true, status: 100 }));
  const log = { address: USDC, data: '0x' + '00'.repeat(32), topics: ['0x' + 'dd'.repeat(32)] };
  const receipt = {
    userOpHash: USEROP_HASH,
    success: true,
    logs: [log],
    receipt: { blockHash: '0x' + 'bb'.repeat(32), blockNumber: '0x10', gasUsed: '0x5208', transactionHash: '0x' + 'cd'.repeat(32), logs: [log, { ...log, address: TARGET }] },
  };
  const ok = callsStatusFromReceipt(record, receipt);
  check('success → status 200 with one receipt', ok.status === 200 && ok.receipts.length === 1);
  check('receipt fields: status 0x1 + bundle tx blockHash/blockNumber/gasUsed/transactionHash', ok.receipts[0].status === '0x1' && ok.receipts[0].transactionHash === '0x' + 'cd'.repeat(32) && ok.receipts[0].gasUsed === '0x5208' && ok.receipts[0].blockNumber === '0x10');
  check('logs are the UserOperation logs only (not the whole bundle)', ok.receipts[0].logs.length === 1 && ok.receipts[0].logs[0].address === USDC);
  const reverted = callsStatusFromReceipt(record, { ...receipt, success: false });
  check('reverted → status 500 (atomic: only the gas charge applied), receipt status 0x0', reverted.status === 500 && reverted.receipts[0].status === '0x0');
  const malformed = callsStatusFromReceipt(record, { success: '0x1', receipt: { transactionHash: '0x12' }, logs: [] });
  check('malformed inner receipt → status kept, receipts omitted (never invented)', malformed.status === 200 && !('receipts' in malformed));
  let threw = false;
  try {
    callsStatusFromReceipt(record, { receipt: {} });
  } catch {
    threw = true;
  }
  check('receipt without a success flag → error, not a guessed status', threw);

  const id = generateCallsId(new Uint8Array(32).fill(7), USEROP_HASH);
  check('generated id = 64 bytes of 0x-hex (random part + userOpHash)', /^0x[0-9a-f]{128}$/.test(id) && id.endsWith(USEROP_HASH.slice(2)));
  const store = memoryStore();
  await saveCallsRecord(record, store);
  check('stored record found for the same sender + app', (await findCallsRecord('0xabc', SMART, 'https://app.example', store))?.userOpHash === USEROP_HASH);
  check('ids are scoped per app (another dApp cannot read it)', (await findCallsRecord('0xabc', SMART, 'https://evil.example', store)) === null);
  check('records expire (7-day retention)', (await findCallsRecord('0xabc', SMART, 'https://app.example', store, Date.now() + 8 * 24 * 3600 * 1000)) === null);
}

// ---------------------------------------------------------------------------
console.log('check-wc-5792: namespaces for smart-account connections');
// ---------------------------------------------------------------------------
{
  const proposal = (required, optional) => ({
    requiredNamespaces: required,
    optionalNamespaces: optional,
    proposer: { publicKey: 'x', metadata: { name: 'Uniswap', url: 'https://app.uniswap.org', description: '', icons: [] } },
    relays: [{ protocol: 'irn' }],
    id: 1,
    expiryTimestamp: 0,
    pairingTopic: 'p',
  });
  const p = proposal({}, { eip155: { chains: [M, S], methods: ['eth_sendTransaction', 'personal_sign', 'wallet_sendCalls', 'wallet_getCapabilities', 'wallet_getCallsStatus', 'wallet_showCallsStatus'], events: ['accountsChanged'] } });
  const eoa = decideProposal(p, OWNER_0, M);
  const smart = decideProposal(p, SMART, M, WC_SMART_ACCOUNT_METHODS);
  check('EOA connection never approves the 5792 methods', eoa.ok && !WC_5792_METHODS.some((m) => eoa.namespaces.eip155.methods.includes(m)));
  check('smart connection approves the 5792 trio the dApp asked for (not showCallsStatus)', smart.ok && WC_5792_METHODS.every((m) => smart.namespaces.eip155.methods.includes(m)) && !smart.namespaces.eip155.methods.includes('wallet_showCallsStatus'));
  check('smart connection exposes ONLY the smart-account address on the active chain', smart.ok && JSON.stringify(smart.namespaces.eip155.accounts) === JSON.stringify([`${M}:${SMART}`]));
  const required = proposal({ eip155: { chains: [M], methods: ['wallet_sendCalls'], events: [] } }, {});
  check('a dApp REQUIRING wallet_sendCalls is refused for the EOA (5101)…', decideProposal(required, OWNER_0, M).ok === false && decideProposal(required, OWNER_0, M).error.code === 5101);
  check('…and served for the smart account', decideProposal(required, SMART, M, WC_SMART_ACCOUNT_METHODS).ok === true);
  check('EOA supported methods unchanged', JSON.stringify(WC_SUPPORTED_METHODS) === JSON.stringify(['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_switchEthereumChain']));
  const calls = [];
  const client = { approveSession: async (a) => void calls.push(a), rejectSession: async () => {} };
  const outcome = await approveProposal(client, { id: 9, params: p }, SMART, M, WC_SMART_ACCOUNT_METHODS);
  check('approveProposal sends the smart namespaces to the SDK', outcome.approved && calls[0].namespaces.eip155.accounts[0] === `${M}:${SMART}`);
}

// ---------------------------------------------------------------------------
console.log('check-wc-5792: controller routing for smart-account sessions');
// ---------------------------------------------------------------------------
function fakeKit(sessions = {}) {
  const handlers = new Map();
  const calls = { approve: [], reject: [], respond: [], disconnect: [], pair: [] };
  return {
    calls,
    sessions,
    pair: async (a) => void calls.pair.push(a),
    approveSession: async (a) => void calls.approve.push(a),
    rejectSession: async (a) => void calls.reject.push(a),
    respondSessionRequest: async (a) => void calls.respond.push(a),
    disconnectSession: async (a) => void calls.disconnect.push(a),
    getActiveSessions() {
      return this.sessions;
    },
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
const session = (topic, chain, address, name = 'Uniswap') => ({
  [topic]: {
    topic,
    peer: { metadata: { name, url: 'https://app.uniswap.org' } },
    namespaces: { eip155: { accounts: [`${chain}:${address}`], methods: WC_SMART_ACCOUNT_METHODS } },
  },
});
const req = (id, method, params, chainId = M, topic = 'T1') => ({ id, topic, params: { chainId, request: { method, params } } });
const kernelBinding = { chain: M, address: SMART, owner: OWNER_0, accountIndex: 0, accountType: 'kernel-v3.3', factory: KERNEL_V3_3.factory };
const last = (kit) => kit.calls.respond[kit.calls.respond.length - 1]?.response;

{
  const store = memoryStore();
  const kit = fakeKit(session('T1', M, SMART));
  const known = new Set();
  const ctx = {
    address: OWNER_0,
    activeChain: M,
    labelFor: (a) => (same(a, OWNER_0) ? 'Account 1 (0x9858…Da94)' : null),
    lookupCallsStatus: async ({ id, from, dappUrl }) =>
      id === '0xknown' && same(from, SMART) && dappUrl === 'https://app.uniswap.org'
        ? { result: { version: '2.0.0', id, chainId: '0x1', status: 100, atomic: true } }
        : { error: { code: ERC5792_ERRORS.unknownBundle, message: 'This bundle id is unknown.' } },
    callsIdKnown: async ({ id }) => known.has(id),
  };
  const ctl = new WcController(kit, () => ctx, { bindingStore: store });
  ctl.attach();
  await ctl.rememberSmartBinding(kernelBinding);
  check('binding persisted before approval (reloadable)', (await loadSmartBindings(store)).some((b) => b.address === SMART && b.owner === OWNER_0));
  check('snapshot exposes the binding for session labels', ctl.getSnapshot().smartBindings.length === 1);

  await kit.fire('session_request', req(1, 'wallet_getCapabilities', [SMART, ['0x1']]));
  check('wallet_getCapabilities answered automatically with atomic supported', JSON.stringify(last(kit).result) === JSON.stringify({ '0x1': { atomic: { status: 'supported' } } }) && ctl.getSnapshot().queue.length === 0);
  await kit.fire('session_request', req(2, 'wallet_getCapabilities', [OWNER_0]));
  check('getCapabilities for the owner EOA on a smart session → 4100', last(kit).error?.code === 4100);
  await kit.fire('session_request', req(3, 'wallet_getCallsStatus', ['0xknown']));
  check('wallet_getCallsStatus answered from the lookup (status 100)', last(kit).result?.status === 100 && last(kit).id === 3);
  await kit.fire('session_request', req(4, 'wallet_getCallsStatus', ['0xnope']));
  check('unknown batch id → 5730', last(kit).error?.code === 5730);

  await kit.fire('session_request', req(5, 'wallet_sendCalls', sendCallsParams({ id: '0xapp-1' })));
  let snap = ctl.getSnapshot();
  check('wallet_sendCalls queued for approval with the smart binding', snap.queue.length === 1 && snap.queue[0].parsed.kind === 'calls' && snap.queue[0].smart?.address === SMART && snap.queue[0].address === SMART);
  known.add('0xdup');
  await kit.fire('session_request', req(6, 'wallet_sendCalls', sendCallsParams({ id: '0xdup' })));
  check('duplicate app-provided id → 5720, not queued', last(kit).error?.code === 5720 && ctl.getSnapshot().queue.length === 1);
  await kit.fire('session_request', req(7, 'personal_sign', [toHex(new TextEncoder().encode('login')), SMART]));
  check('personal_sign naming the smart account queued (Kernel signs via ERC-1271)', ctl.getSnapshot().queue.length === 2);
  await kit.fire('session_request', req(8, 'personal_sign', [toHex(new TextEncoder().encode('login')), OWNER_0]));
  check('personal_sign naming the owner EOA on a smart session → -32602', last(kit).error?.code === -32602);
  await kit.fire('session_request', req(9, 'wallet_sendCalls', sendCallsParams(), S));
  check('wrong-chain request on a smart session → 5100', last(kit).error?.code === 5100);

  // Account switch: requests on the smart session are declined.
  const item = ctl.begin('r:5');
  check('same owner at approval → no stale error', ctl.staleAccountError(item) === null && ctl.staleChainError(item) === null);
  ctx.address = other.address;
  const stale = ctl.staleAccountError(item);
  check('owner account switched while queued → stale 5103 naming the smart account', stale?.code === 5103 && stale.message.includes(SMART));
  ctl.release('r:5');
  await kit.fire('session_request', req(10, 'personal_sign', [toHex(new TextEncoder().encode('x')), SMART]));
  check('new request while another account is active → 5103 decline', last(kit).error?.code === 5103 && last(kit).error.message.includes('Account 1'));
  ctx.address = OWNER_0;

  // A new controller with the same store reloads the binding.
  const ctl2 = new WcController(kit, () => ctx, { bindingStore: store });
  ctl2.attach();
  await ctl2.bindingsReady;
  await kit.fire('session_request', req(11, 'wallet_getCapabilities', [SMART]));
  check('bindings survive a restart (reloaded from storage)', last(kit).result?.['0x1']?.atomic?.status === 'supported');
}

{
  // SimpleAccount binding: signing refused with the explanation.
  const kit = fakeKit(session('T1', M, SMART));
  const ctx = { address: OWNER_0, activeChain: M };
  const ctl = new WcController(kit, () => ctx, { bindingStore: memoryStore() });
  ctl.attach();
  await ctl.rememberSmartBinding({ ...kernelBinding, accountType: 'simple' });
  await kit.fire('session_request', req(20, 'personal_sign', [toHex(new TextEncoder().encode('login')), SMART]));
  check('SimpleAccount session: personal_sign declined 5101 with the plain explanation', last(kit).error?.code === 5101 && last(kit).error.message === SIMPLE_ACCOUNT_SIGNING_REFUSAL && ctl.getSnapshot().queue.length === 0);
  check('  … and the user gets a notice', (ctl.getSnapshot().notices[0]?.text ?? '').includes('SimpleAccount'));
  await kit.fire('session_request', req(21, 'wallet_sendCalls', sendCallsParams()));
  check('SimpleAccount session: batches still allowed (executeBatch is atomic)', ctl.getSnapshot().queue.length === 1);
}

{
  // Fail closed: a session whose address is neither the EOA nor a known smart account.
  const kit = fakeKit(session('T1', M, SMART));
  const ctl = new WcController(kit, () => ({ address: OWNER_0, activeChain: M }), { bindingStore: memoryStore() });
  ctl.attach();
  await kit.fire('session_request', req(30, 'wallet_sendCalls', sendCallsParams()));
  check('unknown smart-account session (no binding) → declined 5103, never served', last(kit).error?.code === 5103 && ctl.getSnapshot().queue.length === 0);
  // EOA sessions keep today's behavior, and get an honest {} for capabilities.
  kit.sessions = session('T2', M, OWNER_0);
  await kit.fire('session_request', req(31, 'wallet_getCapabilities', [OWNER_0], M, 'T2'));
  check('EOA session: getCapabilities → {}', JSON.stringify(last(kit).result) === '{}');
  await kit.fire('session_request', req(32, 'wallet_getCallsStatus', ['0x1'], M, 'T2'));
  check('EOA session: getCallsStatus → 5730 (no batches ever sent)', last(kit).error?.code === 5730);
  await kit.fire('session_request', req(33, 'personal_sign', [toHex(new TextEncoder().encode('hi')), OWNER_0], M, 'T2'));
  check('EOA session: personal_sign queued exactly as before', ctl.getSnapshot().queue.length === 1 && ctl.getSnapshot().queue[0].smart === null);
}

// ---------------------------------------------------------------------------
console.log('check-wc-5792: approval paths (provider logic with the exact app modules)');
// ---------------------------------------------------------------------------
const kernelConfig = {
  bundlerUrl: 'https://bundler.example',
  bundlerVerifiedAt: 'x',
  accountType: 'kernel-v3.3',
  factory: KERNEL_V3_3.factory,
  factoryImplementation: KERNEL_V3_3.implementation,
  kernelMetaFactory: KERNEL_V3_3.metaFactory,
  kernelValidator: KERNEL_V3_3.ecdsaValidator,
  kernelAccountId: KERNEL_V3_3.accountId,
  factoryVerifiedAt: 'x',
  paymasterUrl: null,
  paymasterContext: null,
  paymasterVerifiedAt: null,
};
{
  const node = fakeKernelNode();
  const bundler = fakeBundler();
  const bundle = createAaClientFromConfig(kernelConfig, {
    nodeUrl: 'https://node.example',
    chainId: 1n,
    accountIndex: 0,
    transportFor: (u) => (u === 'https://node.example' ? node : bundler),
  });
  const kit = fakeKit(session('T1', M, SMART));
  const ctl = new WcController(kit, () => ({ address: OWNER_0, activeChain: M }), { bindingStore: memoryStore() });
  ctl.attach();
  await ctl.rememberSmartBinding(kernelBinding);

  // personal_sign: sign through the smart account, answer the dApp, verify.
  const text = 'app.uniswap.org wants you to sign in with your Ethereum account';
  await kit.fire('session_request', req(40, 'personal_sign', [toHex(new TextEncoder().encode(text)), SMART]));
  let item = ctl.begin('r:40');
  const sig = await signHashAsSmartAccount(bundle, owner, item.parsed.digest, item.smart.address);
  await respondApproved(kit, item.event.topic, item.event.id, toHex(sig.signature));
  ctl.complete('r:40');
  const answered = toBytes(last(kit).result);
  const verdict = await verifyErc6492Signature(node, SMART, toBytes(ethers.hashMessage(text)), answered);
  check('personal_sign answer validates for the SMART ACCOUNT via ERC-6492 (engine verifier, fake simulateV1)', verdict.valid && verdict.path === 'erc6492-counterfactual', JSON.stringify(verdict));
  check(
    'the answer is not a plain owner-EOA signature (ERC-6492 envelope, longer than 65 bytes)',
    answered.length > 65 && toHex(answered.slice(-32)) === '0x' + '6492'.repeat(16),
  );

  // eth_signTypedData_v4 (Permit2-style shape) through the smart account.
  const typed = {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Permit: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    },
    primaryType: 'Permit',
    domain: { name: 'Permit2', chainId: 1, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
    message: { spender: TARGET, amount: '1000' },
  };
  await kit.fire('session_request', req(41, 'eth_signTypedData_v4', [SMART, JSON.stringify(typed)]));
  item = ctl.begin('r:41');
  const { EIP712Domain, ...types } = typed.types;
  check('typed-data digest equals ethers TypedDataEncoder', toHex(item.parsed.typedData.digest) === ethers.TypedDataEncoder.hash(typed.domain, types, typed.message));
  const tsig = await signHashAsSmartAccount(bundle, owner, item.parsed.typedData.digest, item.smart.address);
  await respondApproved(kit, item.event.topic, item.event.id, toHex(tsig.signature));
  ctl.complete('r:41');
  check('typed-data answer validates for the smart account', (await verifyErc6492Signature(node, SMART, item.parsed.typedData.digest, toBytes(last(kit).result))).valid);

  // wallet_sendCalls → ONE UserOperation with exactly the dApp's calls.
  await kit.fire('session_request', req(42, 'wallet_sendCalls', sendCallsParams()));
  item = ctl.begin('r:42');
  const quote = await prepareAaCalls(
    bundle,
    item.smart.owner,
    item.parsed.batch.calls.map((t) => ({ to: t.to, value: t.valueWei, data: t.data })),
  );
  check('batch quoted from the bound smart account', quote.sender === SMART && quote.calls.length === 2 && quote.amount === 0x9184e72an);
  const { userOpHash } = await sendAa(bundle, owner, quote);
  const decoded = decodeKernelExecute(bundler.lastOp.callData);
  check('submitted callData = Kernel batch of the dApp calls, in order (ethers decode)', decoded.callType === 1 && decoded.calls.length === 2 && same(decoded.calls[0].to, TARGET) && decoded.calls[0].value === 0x9184e72an && same(decoded.calls[1].to, USDC) && decoded.calls[1].data === '0xa9059cbb' + '00'.repeat(64));
  const store = memoryStore();
  const id = generateCallsId(new Uint8Array(32).fill(1), userOpHash);
  await saveCallsRecord({ id, userOpHash, chain: M, from: SMART, dappUrl: ctl.dappUrl('T1'), createdAt: Date.now() }, store);
  await respondApproved(kit, item.event.topic, item.event.id, { id });
  ctl.complete('r:42');
  check('wallet_sendCalls result is { id } per the ERC', JSON.stringify(last(kit).result) === JSON.stringify({ id }));
  const rec = await findCallsRecord(id, SMART, 'https://app.uniswap.org', store);
  check('batch record kept for wallet_getCallsStatus (scoped to the dApp URL)', rec?.userOpHash === USEROP_HASH);
  check('the owner signed the UserOperation (expectAddress = owner EOA)', bundler.lastOp.signature.length === 132);
}

console.log('');
console.log(`check-wc-5792: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

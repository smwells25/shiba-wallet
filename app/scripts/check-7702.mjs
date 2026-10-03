// Phase 8 item 1, app half: EIP-7702 "Upgrade this account", entirely
// OFFLINE. Exercises the exact app modules (src/wallet/delegation.ts,
// aa.ts's 'kernel-7702' path, walletconnect.ts's D6 refusals, risk.ts's
// own-account rule) under Node's type stripping, against a fake JSON-RPC
// node and the fake bundler from fakes-kernel.mjs. Every signed artifact
// is checked with ethers 6 (an independent implementation): set-code
// (type 0x04) transactions decoded by Transaction.from, tuple authorities
// recovered by verifyAuthorization, UserOperation signatures by
// verifyMessage.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-7702.mjs
//
// Nothing is signed against a live chain and nothing is broadcast.

import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  KERNEL_V3_3_7702_DELEGATE,
  ZERO_ADDRESS,
  getUserOpHash,
  setCodeIntrinsicGas,
} from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import {
  EIP7702_STUB_R,
  EIP7702_STUB_S,
  EIP7702_UNANNOUNCED_REFUSAL,
  createAaClientFromConfig,
  effectiveAaAccountType,
  getAaConfig,
  isAaConfigured,
  isEip7702Owner,
  prepareAaCalls,
  prepareAaSend,
  sendAa,
  setAaBundlerUrl,
  setAaKernelFactory,
  setAccountEip7702,
} from '../src/wallet/aa.ts';
import {
  FOREIGN_DELEGATE_WARNING,
  SET_CODE_EXECUTION_GAS,
  UPGRADE_EXPLANATION,
  WALLET_7702_DELEGATE,
  assertWalletDelegate,
  cachedAccountDelegation,
  delegationLabelSuffix,
  invalidateAccountDelegation,
  prepareSetCodeTx,
  readAccountDelegation,
  sendSetCodeTx,
  subscribeDelegation,
  waitForSetCode,
} from '../src/wallet/delegation.ts';
import {
  EIP7702_WC_REFUSAL,
  ERC5792_ERRORS,
  WC_ERRORS,
  WcRequestRejection,
  parseWcRequest,
  requestsEip7702Authorization,
} from '../src/wallet/walletconnect.ts';
import { computeRiskLines, gatherRiskFacts, isExpectedOwnDelegation } from '../src/wallet/risk.ts';
import { OWNER_0, TEST_MNEMONIC, decodeKernelExecute, fakeBundler, fakeKernelNode, fromRpcOp, memoryStore } from './fakes-kernel.mjs';

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
async function checkRejects(name, fn, messagePart) {
  try {
    const value = await fn();
    check(name, false, `expected an error, got ${JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, message.includes(messagePart), `error was: ${message}`);
  }
}
function rejectsSync(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
const owner1 = evmKeyProvider.deriveAccount(seed, 0, 1);
seed.fill(0);
const MAINNET = 'eip155:1';
const SEPOLIA = 'eip155:11155111';
const NODE_URL = 'https://node.example';
const BUNDLER_URL = 'https://bundler.example';
const PINNED = '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28';
const FOREIGN = '0x' + '63'.repeat(20);
const indicator = (delegate) => ('0xef0100' + delegate.slice(2)).toLowerCase();

/**
 * Fake node for the 7702 checks. `code` maps lowercase address → eth_getCode
 * result (default '0x'); mutable, so a test can flip an account's state
 * between quote and send. Records every call and every raw transaction.
 */
function fake7702Node({ chainIdHex = '0x1', code = {}, nonce = 5n, balance = 10n ** 18n, receipt = { status: '0x1' } } = {}) {
  const calls = [];
  const raws = [];
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return chainIdHex;
    if (method === 'eth_getCode') return code[params[0].toLowerCase()] ?? '0x';
    if (method === 'eth_getBalance') return '0x' + balance.toString(16);
    if (method === 'eth_getTransactionCount') return '0x' + nonce.toString(16);
    if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      if (same(to, ENTRYPOINT_V07) && data.startsWith(ethers.id('getNonce(address,uint192)').slice(0, 10))) return '0x' + '0'.repeat(63) + '3';
      throw new Error(`fake 7702 node: unexpected eth_call to ${to}`);
    }
    if (method === 'eth_sendRawTransaction') {
      raws.push(params[0]);
      return ethers.keccak256(params[0]);
    }
    if (method === 'eth_getTransactionReceipt') return receipt;
    throw new Error(`fake 7702 node: unexpected method ${method}`);
  };
  transport.calls = calls;
  transport.raws = raws;
  transport.code = code;
  return transport;
}

// ---------------------------------------------------------------------------
console.log('check-7702: pinned delegate, D6 delegate rule and wording');
// ---------------------------------------------------------------------------
check('WALLET_7702_DELEGATE is the engine KERNEL_V3_3_7702_DELEGATE = the Kernel v3.3 implementation 0xd6CE…5b28', WALLET_7702_DELEGATE === KERNEL_V3_3_7702_DELEGATE && WALLET_7702_DELEGATE === KERNEL_V3_3.implementation && WALLET_7702_DELEGATE === PINNED);
check('assertWalletDelegate accepts the pinned delegate and the zero address', rejectsSync(() => assertWalletDelegate(PINNED)) === null && rejectsSync(() => assertWalletDelegate(ZERO_ADDRESS)) === null);
check('assertWalletDelegate refuses any other address (D6)', /only delegates to/.test(rejectsSync(() => assertWalletDelegate(FOREIGN))?.message ?? ''));
check(
  'upgrade explanation carries the design note verbatim in spirit (same address, Kernel v3.3 0xd6CE…5b28, recovery phrase, undo)',
  UPGRADE_EXPLANATION.startsWith('Your address stays the same.') &&
    UPGRADE_EXPLANATION.includes('ZeroDev Kernel v3.3 code (contract 0xd6CE…5b28)') &&
    UPGRADE_EXPLANATION.includes('batching, sponsored gas and, later, session keys') &&
    UPGRADE_EXPLANATION.includes('Your recovery phrase still controls everything.') &&
    UPGRADE_EXPLANATION.includes('You can undo this at any time.'),
);
check('label suffix: upgraded → "Account 1 · upgraded (Kernel v3.3)"', `Account 1${delegationLabelSuffix({ kind: 'kernel-v3.3', delegate: PINNED })}` === 'Account 1 · upgraded (Kernel v3.3)');
check('label suffix: plain / unknown → nothing', delegationLabelSuffix({ kind: 'plain' }) === '' && delegationLabelSuffix(null) === '');
check('label suffix: foreign delegate is named and flagged', delegationLabelSuffix({ kind: 'other', delegate: FOREIGN }).includes("not the wallet's Kernel"));
check('foreign-delegate warning text', FOREIGN_DELEGATE_WARNING === "This is not the wallet's Kernel delegate. If you did not do this, revoke it now.");

// ---------------------------------------------------------------------------
console.log('check-7702: delegation status classification + session cache');
// ---------------------------------------------------------------------------
{
  const CONTRACT = '0x' + '44'.repeat(20);
  const STRANGER = '0x' + '45'.repeat(20);
  const node = fake7702Node({
    code: {
      [OWNER_0.toLowerCase()]: indicator(PINNED),
      [owner1.address.toLowerCase()]: indicator(FOREIGN),
      [CONTRACT]: '0x6080604052',
    },
  });
  const opts = { chainId: 1n, transportFor: () => node };
  const s0 = await readAccountDelegation(NODE_URL, OWNER_0, opts);
  check('delegated to the pinned Kernel → kernel-v3.3', s0.kind === 'kernel-v3.3' && same(s0.delegate, PINNED));
  const s1 = await readAccountDelegation(NODE_URL, owner1.address, opts);
  check('delegated to a foreign contract → other, delegate reported in full', s1.kind === 'other' && same(s1.delegate, FOREIGN));
  const s2 = await readAccountDelegation(NODE_URL, STRANGER, opts);
  check('no code → plain', s2.kind === 'plain');
  const s3 = await readAccountDelegation(NODE_URL, CONTRACT, opts);
  check('non-indicator code → contract (reported, not guessed)', s3.kind === 'contract');
  const before = node.calls.length;
  const again = await readAccountDelegation(NODE_URL, OWNER_0, opts);
  check('second read is served from the session cache (no RPC)', again.kind === 'kernel-v3.3' && node.calls.length === before);
  check('cachedAccountDelegation returns the cached entry', cachedAccountDelegation(NODE_URL, OWNER_0, 1n)?.kind === 'kernel-v3.3');
  let notified = 0;
  const unsubscribe = subscribeDelegation(() => (notified += 1));
  node.code[OWNER_0.toLowerCase()] = undefined; // revoked on-chain
  invalidateAccountDelegation(OWNER_0);
  check('invalidation notifies subscribers and drops only that account', notified === 1 && cachedAccountDelegation(NODE_URL, OWNER_0, 1n) === undefined && cachedAccountDelegation(NODE_URL, owner1.address, 1n)?.kind === 'other');
  unsubscribe();
  const fresh = await readAccountDelegation(NODE_URL, OWNER_0, opts);
  check('re-read after the change sees the new state (plain)', fresh.kind === 'plain');
  const forced = await readAccountDelegation(NODE_URL, owner1.address, { ...opts, force: true });
  check('force bypasses the cache', forced.kind === 'other' && node.calls.length > before + 2);
  await checkRejects('a wrong-chain endpoint is refused before reading code', () => readAccountDelegation(NODE_URL, STRANGER, { chainId: 11155111n, transportFor: () => node, force: true }), 'expected 11155111');
  invalidateAccountDelegation();
}

// ---------------------------------------------------------------------------
console.log('check-7702: config transitions (chain type → kernel-7702 → revoke restores it)');
// ---------------------------------------------------------------------------
{
  const store = memoryStore();
  await setAaBundlerUrl(SEPOLIA, BUNDLER_URL, { store, transportFor: () => fakeBundler() });
  await setAaKernelFactory(SEPOLIA, KERNEL_V3_3.factory, NODE_URL, { store, transportFor: () => fakeKernelNode({ chainIdHex: '0xaa36a7' }) });
  let cfg = await getAaConfig(SEPOLIA, store);
  check('start: Sepolia chain type kernel-v3.3, no upgraded owners', cfg.accountType === 'kernel-v3.3' && cfg.eip7702Owners.length === 0 && effectiveAaAccountType(cfg, OWNER_0) === 'kernel-v3.3');
  cfg = await setAccountEip7702(SEPOLIA, OWNER_0.toLowerCase(), true, store);
  check('upgrade with next send: owner recorded (EIP-55), its effective type is kernel-7702', isEip7702Owner(cfg, OWNER_0) && cfg.eip7702Owners[0] === OWNER_0 && effectiveAaAccountType(cfg, OWNER_0) === 'kernel-7702');
  check('another account of the same wallet keeps the chain type (no silent upgrade)', effectiveAaAccountType(cfg, owner1.address) === 'kernel-v3.3' && !isEip7702Owner(cfg, owner1.address));
  check('no owner given (WalletConnect) → the chain type', effectiveAaAccountType(cfg) === 'kernel-v3.3');
  check('factory fields untouched by the upgrade', cfg.factory === KERNEL_V3_3.factory && cfg.kernelValidator === KERNEL_V3_3.ecdsaValidator);
  check('mainnet config unaffected', (await getAaConfig(MAINNET, store)).eip7702Owners.length === 0);
  const again = await setAccountEip7702(SEPOLIA, OWNER_0, true, store);
  check('recording twice keeps one entry', again.eip7702Owners.length === 1);
  const bundle = createAaClientFromConfig(again, { nodeUrl: NODE_URL, chainId: 11155111n, accountIndex: 0, ownerAddress: OWNER_0, transportFor: () => fake7702Node({ chainIdHex: '0xaa36a7' }) });
  check('createAaClientFromConfig with the upgraded owner → kernel-7702 bundle, delegate = pinned, gate closed', bundle.accountType === 'kernel-7702' && same(bundle.eip7702?.delegate, PINNED) && bundle.eip7702?.gate.allowAuthorization === false && same(bundle.factory, PINNED));
  const other = createAaClientFromConfig(again, { nodeUrl: NODE_URL, chainId: 11155111n, accountIndex: 1, ownerAddress: owner1.address, transportFor: () => fakeKernelNode({ chainIdHex: '0xaa36a7' }) });
  check('createAaClientFromConfig for another owner → the chain type (kernel-v3.3), no 7702 gate', other.accountType === 'kernel-v3.3' && other.eip7702 === undefined);
  cfg = await setAccountEip7702(SEPOLIA, OWNER_0, false, store);
  check('revoke: owner removed, effective type back to the previous one (kernel-v3.3)', !isEip7702Owner(cfg, OWNER_0) && effectiveAaAccountType(cfg, OWNER_0) === 'kernel-v3.3' && cfg.factory === KERNEL_V3_3.factory);

  // Bundler only (no factory): an upgraded owner is configured, others are not.
  const bare = memoryStore();
  await setAaBundlerUrl(SEPOLIA, BUNDLER_URL, { store: bare, transportFor: () => fakeBundler() });
  let bareCfg = await getAaConfig(SEPOLIA, bare);
  check('bundler only, plain owner: not configured (needs a factory)', !isAaConfigured(bareCfg, OWNER_0) && effectiveAaAccountType(bareCfg, OWNER_0) === 'simple');
  bareCfg = await setAccountEip7702(SEPOLIA, OWNER_0, true, bare);
  check('bundler only, upgraded owner: configured (7702 needs no factory)', isAaConfigured(bareCfg, OWNER_0) && !isAaConfigured(bareCfg, owner1.address) && !isAaConfigured(bareCfg));
  bareCfg = await setAccountEip7702(SEPOLIA, OWNER_0, false, bare);
  check('revoke restores the previous state (simple, unconfigured)', !isAaConfigured(bareCfg, OWNER_0) && effectiveAaAccountType(bareCfg, OWNER_0) === 'simple');
  await checkRejects('setAccountEip7702 refuses a non-address', () => setAccountEip7702(SEPOLIA, 'not-an-address', true, bare), 'Not an EVM address');
  const corrupt = memoryStore();
  await corrupt.setItem('shiba-wallet.aa-config.v1', JSON.stringify({ [SEPOLIA]: { eip7702Owners: ['junk', 42, OWNER_0] } }));
  check('malformed stored owners are dropped on read', (await getAaConfig(SEPOLIA, corrupt)).eip7702Owners.join() === OWNER_0);
}

// ---------------------------------------------------------------------------
console.log('check-7702: first smart-account op carries the authorization (Sepolia)');
// ---------------------------------------------------------------------------
const kernel7702Config = {
  bundlerUrl: BUNDLER_URL,
  bundlerVerifiedAt: 'x',
  accountType: 'simple',
  factory: null,
  factoryImplementation: null,
  kernelMetaFactory: null,
  kernelValidator: null,
  kernelAccountId: null,
  factoryVerifiedAt: null,
  paymasterUrl: null,
  paymasterContext: null,
  paymasterVerifiedAt: null,
  eip7702Owners: [OWNER_0],
};
function bundle7702({ node, bundler = fakeBundler(), chainId = 11155111n } = {}) {
  const bundle = createAaClientFromConfig(kernel7702Config, {
    nodeUrl: NODE_URL,
    chainId,
    accountIndex: 0,
    ownerAddress: OWNER_0,
    transportFor: (url) => (url === NODE_URL ? node : bundler),
  });
  return { bundle, node, bundler };
}
const RECIPIENT = '0x' + 'aa'.repeat(20);
{
  const node = fake7702Node({ chainIdHex: '0xaa36a7', nonce: 9n });
  const { bundle, bundler } = bundle7702({ node });
  const quote = await prepareAaSend(bundle, OWNER_0, ethers.getAddress(RECIPIENT), 1000n);
  check('quote: sender IS the EOA (same address), type kernel-7702', quote.sender === OWNER_0 && quote.accountType === 'kernel-7702');
  check('quote announces the upgrade (plain account) with the pinned delegate', quote.eip7702?.upgrade === true && same(quote.eip7702.delegate, PINNED) && quote.deployed === false);
  const est = bundler.lastEstimated;
  check('estimate op: no factory, sender = EOA', est.factory === undefined && est.sender === OWNER_0);
  check(
    'estimate op carries a STUB tuple (viem dummy r/s, yParity 0x01): chain 11155111, pinned delegate, authority nonce',
    est.eip7702Auth && est.eip7702Auth.r === EIP7702_STUB_R && est.eip7702Auth.s === EIP7702_STUB_S && est.eip7702Auth.yParity === '0x01' && BigInt(est.eip7702Auth.chainId) === 11155111n && same(est.eip7702Auth.address, PINNED) && BigInt(est.eip7702Auth.nonce) === 9n,
    JSON.stringify(est.eip7702Auth),
  );
  check('no key was needed for the quote (stub only; gate still closed)', bundle.eip7702.gate.allowAuthorization === false);

  const { userOpHash } = await sendAa(bundle, owner, quote);
  check('sendAa returns the bundler userOpHash', typeof userOpHash === 'string');
  const op = bundler.lastOp;
  const a = op.eip7702Auth;
  check('FIRST op carries eip7702Auth', a !== undefined);
  check('tuple chain id = the ACTIVE chain (11155111), never 0', BigInt(a.chainId) === 11155111n);
  check('tuple delegate = the pinned Kernel v3.3 implementation', ethers.getAddress(a.address) === PINNED);
  check('tuple nonce = the authority account nonce (bundler-carried tuple)', BigInt(a.nonce) === 9n);
  const authority = ethers.verifyAuthorization(
    { chainId: BigInt(a.chainId), address: a.address, nonce: BigInt(a.nonce) },
    ethers.Signature.from({ r: a.r, s: a.s, yParity: Number(a.yParity) }),
  );
  check('ethers recovers the tuple authority = the account itself', authority === OWNER_0, authority);
  check('submitted op: sender = EOA, no factory', op.sender === OWNER_0 && op.factory === undefined);
  const hash = getUserOpHash(fromRpcOp(op), ENTRYPOINT_V07, 11155111n);
  check('op signature = EOA key over EIP-191(userOpHash) (ethers)', ethers.verifyMessage(hash, op.signature) === OWNER_0);
  const exec = decodeKernelExecute(op.callData);
  check('callData = Kernel execute(single, recipient, 1000 wei) (ethers)', exec.callType === 0 && same(exec.calls[0].to, RECIPIENT) && exec.calls[0].value === 1000n);
  check('gate closed again after the send', bundle.eip7702.gate.allowAuthorization === false);
  check('quoting signed nothing: the tuple appears only on eth_sendUserOperation', bundler.calls.filter((c) => c.method === 'eth_sendUserOperation').length === 1);
}

// ---------------------------------------------------------------------------
console.log('check-7702: later ops carry NO authorization');
// ---------------------------------------------------------------------------
{
  const node = fake7702Node({ chainIdHex: '0xaa36a7', code: { [OWNER_0.toLowerCase()]: indicator(PINNED) } });
  const { bundle, bundler } = bundle7702({ node });
  const quote = await prepareAaSend(bundle, OWNER_0, ethers.getAddress(RECIPIENT), 1n);
  check('quote: already upgraded → upgrade=false, "deployed"', quote.eip7702?.upgrade === false && quote.deployed === true);
  check('estimate op has no eip7702Auth', bundler.lastEstimated.eip7702Auth === undefined);
  await sendAa(bundle, owner, quote);
  check('submitted op has no eip7702Auth', bundler.lastOp.eip7702Auth === undefined && bundler.lastOp.sender === OWNER_0);
  const multi = await prepareAaCalls(bundle, OWNER_0, [
    { to: RECIPIENT, value: 1n, data: new Uint8Array(0) },
    { to: RECIPIENT, value: 2n, data: new Uint8Array(0) },
  ]);
  await sendAa(bundle, owner, multi);
  check('a batch from the upgraded account: ERC-7579 batch, still no tuple', decodeKernelExecute(bundler.lastOp.callData).callType === 1 && bundler.lastOp.eip7702Auth === undefined);
}

// ---------------------------------------------------------------------------
console.log('check-7702: D6 refusals on the smart-account path');
// ---------------------------------------------------------------------------
{
  // Quote while upgraded, then the account is revoked elsewhere: the send
  // would need a tuple the confirm screen never announced → refused.
  const node = fake7702Node({ chainIdHex: '0xaa36a7', code: { [OWNER_0.toLowerCase()]: indicator(PINNED) } });
  const { bundle, bundler } = bundle7702({ node });
  const quote = await prepareAaSend(bundle, OWNER_0, ethers.getAddress(RECIPIENT), 1n);
  node.code[OWNER_0.toLowerCase()] = undefined;
  await checkRejects('unannounced upgrade at send time is refused (nothing signed)', () => sendAa(bundle, owner, quote), EIP7702_UNANNOUNCED_REFUSAL);
  check('…and nothing reached eth_sendUserOperation', !bundler.calls.some((c) => c.method === 'eth_sendUserOperation'));
  check('…and the gate is closed', bundle.eip7702.gate.allowAuthorization === false);

  // Direct use of the client outside sendAa (e.g. a dApp path) cannot sign a tuple.
  await checkRejects('SmartAccountClient.sendCalls outside sendAa refuses to sign a tuple', () => bundle.client.sendCalls(owner, [{ to: RECIPIENT, value: 0n, data: new Uint8Array(0) }], { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), EIP7702_UNANNOUNCED_REFUSAL);

  const foreign = fake7702Node({ chainIdHex: '0xaa36a7', code: { [OWNER_0.toLowerCase()]: indicator(FOREIGN) } });
  const { bundle: fb } = bundle7702({ node: foreign });
  await checkRejects('an account delegated to a foreign contract is refused at quote time (revoke first)', () => prepareAaSend(fb, OWNER_0, ethers.getAddress(RECIPIENT), 1n), "not the wallet's Kernel delegate");

  const wrongChain = fake7702Node({ chainIdHex: '0x1' });
  const { bundle: wb } = bundle7702({ node: wrongChain });
  await checkRejects('an endpoint on another chain is refused before anything (active chain only)', () => prepareAaSend(wb, OWNER_0, ethers.getAddress(RECIPIENT), 1n), 'expected 11155111');

  const plain = fake7702Node({ chainIdHex: '0xaa36a7' });
  const { bundle: pb, bundler: pbb } = bundle7702({ node: plain });
  const q = await prepareAaSend(pb, OWNER_0, ethers.getAddress(RECIPIENT), 1n);
  await checkRejects('a signer that is not the EOA is refused before signing (expectAddress rule)', () => sendAa(pb, owner1, q), 'Nothing was signed');
  check('…nothing submitted', !pbb.calls.some((c) => c.method === 'eth_sendUserOperation'));
  const { eip7702: _drop, ...noAnnouncement } = q;
  await checkRejects('a quote without the 7702 announcement is refused on a kernel-7702 bundle', () => sendAa(pb, owner, noAnnouncement), 'another account type');
}

// ---------------------------------------------------------------------------
console.log('check-7702: "Upgrade now" — self-sponsored type-0x04 transaction');
// ---------------------------------------------------------------------------
const EXPLORER = 'https://sepolia.etherscan.io/tx/';
{
  const node = fake7702Node({ chainIdHex: '0xaa36a7', nonce: 7n });
  const transportFor = () => node;
  const quote = await prepareSetCodeTx({ url: NODE_URL, from: OWNER_0, action: 'upgrade', expectedChainId: 11155111n, transportFor });
  check('setCodeIntrinsicGas(1) = 21000 + 25000 (EIP-7702 PER_EMPTY_ACCOUNT_COST)', setCodeIntrinsicGas(1) === 46_000n);
  check('quote: gas = intrinsic + 40,000 execution buffer = 86,000', quote.gasLimit === 86_000n && SET_CODE_EXECUTION_GAS === 40_000n);
  check('quote: tuple nonce = tx nonce + 1 (7 → 8)', quote.nonce === 7n && quote.authorizationNonce === 8n);
  check('quote: delegate = pinned Kernel, chain = 11155111, status before = plain', same(quote.delegate, PINNED) && quote.chainId === 11155111n && quote.statusBefore.kind === 'plain');
  check('quote: worst-case fee = gas × maxFee', quote.fee === quote.gasLimit * quote.maxFeePerGas);
  const sent = await sendSetCodeTx(NODE_URL, owner, quote, EXPLORER, { transportFor });
  const raw = node.raws.at(-1);
  const tx = ethers.Transaction.from(raw);
  check('broadcast one raw transaction; txid = keccak(raw); explorer link from the active profile', node.raws.length === 1 && sent.txid === ethers.keccak256(raw) && sent.explorerUrl === EXPLORER + sent.txid);
  check('ethers: type 4 (EIP-7702 set-code)', tx.type === 4);
  check('ethers: from = to = the account, value 0, empty data', tx.from === OWNER_0 && tx.to === OWNER_0 && tx.value === 0n && tx.data === '0x');
  check('ethers: chainId 11155111, nonce 7, gasLimit 86,000', tx.chainId === 11155111n && tx.nonce === 7 && tx.gasLimit === 86_000n);
  const auth = tx.authorizationList?.[0];
  check('ethers: exactly one tuple → pinned delegate, chain 11155111, nonce 8 (= tx nonce + 1)', tx.authorizationList.length === 1 && auth.address === PINNED && auth.chainId === 11155111n && auth.nonce === 8n);
  check('ethers: tuple authority recovered = the account', ethers.verifyAuthorization(auth, auth.signature) === OWNER_0);

  const receiptNode = fake7702Node({ chainIdHex: '0xaa36a7', code: { [OWNER_0.toLowerCase()]: indicator(PINNED) } });
  const waited = await waitForSetCode(NODE_URL, sent.txid, OWNER_0, { chainId: 11155111n, transportFor: () => receiptNode, pollMs: 1 });
  check('waitForSetCode: receipt status 0x1, status re-read = kernel-v3.3 and cached', waited.success && waited.status.kind === 'kernel-v3.3' && cachedAccountDelegation(NODE_URL, OWNER_0, 11155111n)?.kind === 'kernel-v3.3');

  // Refusals (nothing broadcast).
  const n2 = fake7702Node({ chainIdHex: '0xaa36a7', nonce: 7n });
  const t2 = () => n2;
  await checkRejects('sendSetCodeTx refuses a signer that is not the quoted account', () => sendSetCodeTx(NODE_URL, owner1, quote, EXPLORER, { transportFor: t2 }), 'Nothing was signed');
  await checkRejects('sendSetCodeTx refuses a non-wallet delegate (D6)', () => sendSetCodeTx(NODE_URL, owner, { ...quote, delegate: FOREIGN }, EXPLORER, { transportFor: t2 }), 'only delegates to');
  await checkRejects('sendSetCodeTx refuses a tuple nonce other than tx nonce + 1', () => sendSetCodeTx(NODE_URL, owner, { ...quote, authorizationNonce: 7n }, EXPLORER, { transportFor: t2 }), 'nonce + 1');
  await checkRejects('sendSetCodeTx refuses when the endpoint moved to another chain', () => sendSetCodeTx(NODE_URL, owner, quote, EXPLORER, { transportFor: () => fake7702Node({ chainIdHex: '0x1' }) }), 'Nothing was signed');
  check('…none of the refusals broadcast anything', n2.raws.length === 0);

  await checkRejects('upgrade refused when already upgraded', () => prepareSetCodeTx({ url: NODE_URL, from: OWNER_0, action: 'upgrade', expectedChainId: 11155111n, transportFor: () => receiptNode }), 'already upgraded');
  const foreignNode = fake7702Node({ chainIdHex: '0xaa36a7', code: { [OWNER_0.toLowerCase()]: indicator(FOREIGN) } });
  await checkRejects('upgrade refused over a foreign delegation (revoke first)', () => prepareSetCodeTx({ url: NODE_URL, from: OWNER_0, action: 'upgrade', expectedChainId: 11155111n, transportFor: () => foreignNode }), 'Revoke that delegation first');
  await checkRejects('quote refused on the wrong chain', () => prepareSetCodeTx({ url: NODE_URL, from: OWNER_0, action: 'upgrade', expectedChainId: 11155111n, transportFor: () => fake7702Node({ chainIdHex: '0x1' }) }), 'expected 11155111');
  // Mainnet readiness (phase 9 item 6): the upgrade is 'testnet-only', so a
  // mainnet upgrade quote is refused before any request; a revocation is not.
  {
    let requests = 0;
    const counting = () => { requests += 1; return transportFor(); };
    await checkRejects('mainnet upgrade quote refused with the readiness reason', () => prepareSetCodeTx({ url: NODE_URL, from: OWNER_0, action: 'upgrade', expectedChainId: 1n, transportFor: counting }), 'only on test networks');
    check('…before any request', requests === 0);
    await checkRejects('mainnet upgrade send refused before signing', () => sendSetCodeTx(NODE_URL, owner, { ...quote, chainId: 1n }, EXPLORER, { transportFor: counting }), 'only on test networks');
    await checkRejects('a mainnet quote relabelled as a revocation but naming the Kernel delegate is still refused', () => sendSetCodeTx(NODE_URL, owner, { ...quote, chainId: 1n, action: 'revoke' }, EXPLORER, { transportFor: counting }), 'only on test networks');
    check('…and neither made a request', requests === 0);
    await checkRejects('setAccountEip7702 refuses to record a mainnet upgrade', () => setAccountEip7702(MAINNET, OWNER_0, true, memoryStore()), 'only on test networks');
    const mstore = memoryStore();
    check('…but removing a mainnet upgrade record always works', (await setAccountEip7702(MAINNET, OWNER_0, false, mstore)).eip7702Owners.length === 0);
  }
  await checkRejects('quote refused when ETH cannot cover the worst-case fee (not sponsorable)', () => prepareSetCodeTx({ url: NODE_URL, from: OWNER_0, action: 'upgrade', expectedChainId: 11155111n, transportFor: () => fake7702Node({ chainIdHex: '0xaa36a7', balance: 1000n }) }), 'Not enough ETH to pay the network fee');
}

// ---------------------------------------------------------------------------
console.log('check-7702: "Revoke upgrade" — zero-address tuple');
// ---------------------------------------------------------------------------
{
  for (const [label, delegate] of [['our Kernel delegate', PINNED], ['a foreign delegate', FOREIGN]]) {
    const node = fake7702Node({ chainIdHex: '0xaa36a7', nonce: 12n, code: { [OWNER_0.toLowerCase()]: indicator(delegate) } });
    const transportFor = () => node;
    const quote = await prepareSetCodeTx({ url: NODE_URL, from: OWNER_0, action: 'revoke', expectedChainId: 11155111n, transportFor });
    check(`revoke (${label}): delegate = zero address, tuple nonce 13 = tx nonce 12 + 1`, quote.delegate === ZERO_ADDRESS && quote.authorizationNonce === 13n);
    await sendSetCodeTx(NODE_URL, owner, quote, EXPLORER, { transportFor });
    const tx = ethers.Transaction.from(node.raws[0]);
    const auth = tx.authorizationList[0];
    check(`revoke (${label}) decoded by ethers: type 4, to self, tuple → 0x0…0, nonce rule, authority = account`, tx.type === 4 && tx.to === OWNER_0 && auth.address === ZERO_ADDRESS && auth.nonce === BigInt(tx.nonce) + 1n && auth.chainId === 11155111n && ethers.verifyAuthorization(auth, auth.signature) === OWNER_0);
  }
  await checkRejects('revoke refused for a plain account (nothing to undo)', () => prepareSetCodeTx({ url: NODE_URL, from: OWNER_0, action: 'revoke', expectedChainId: 11155111n, transportFor: () => fake7702Node({ chainIdHex: '0xaa36a7' }) }), 'nothing to undo');
}

// ---------------------------------------------------------------------------
console.log('check-7702: D6 — WalletConnect requests that carry an authorization are declined');
// ---------------------------------------------------------------------------
{
  const event = (method, params, chainId = MAINNET) => ({ id: 1, topic: 't', params: { request: { method, params }, chainId } });
  const reject = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof WcRequestRejection ? e : { code: 'not a WcRequestRejection', message: String(e) };
    }
  };
  const baseTx = { from: OWNER_0, to: '0x' + '22'.repeat(20), value: '0x0', data: '0x' };
  const tuple = { chainId: '0x1', address: FOREIGN, nonce: '0x0', yParity: '0x0', r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) };
  const shapes = [
    ['eth_sendTransaction with authorizationList [tuple] (execution-apis GenericTransaction)', { ...baseTx, authorizationList: [tuple] }],
    ['eth_sendTransaction with an EMPTY authorizationList', { ...baseTx, authorizationList: [] }],
    ['eth_sendTransaction with authorization_list (snake case)', { ...baseTx, authorization_list: [tuple] }],
    ['eth_sendTransaction with type "0x4"', { ...baseTx, type: '0x4' }],
    ['eth_sendTransaction with type "0x04"', { ...baseTx, type: '0x04' }],
    ['eth_sendTransaction with type 4 (number)', { ...baseTx, type: 4 }],
  ];
  for (const [name, tx] of shapes) {
    const e = reject(() => parseWcRequest(event('eth_sendTransaction', [tx]), OWNER_0, MAINNET));
    check(`declined: ${name} → USER_REJECTED with the D6 message`, e && e.code === WC_ERRORS.userRejected.code && e.message === EIP7702_WC_REFUSAL, e ? `${e.code} ${e.message}` : 'accepted');
  }
  const ok = parseWcRequest(event('eth_sendTransaction', [{ ...baseTx, type: '0x2' }]), OWNER_0, MAINNET);
  check('control: an ordinary type-0x2 eth_sendTransaction still parses', ok.kind === 'transaction');
  check('requestsEip7702Authorization is false for an ordinary transaction', !requestsEip7702Authorization(baseTx));

  const smart = { smartAccount: { accountType: 'kernel-v3.3', signsMessages: true } };
  const SMART = '0xB67b8b7cCA718EAC64d2b59ba568585A9FC69a42';
  const calls = (extra = {}, callExtra = {}) => [{ version: '2.0.0', chainId: '0x1', from: SMART, atomicRequired: true, calls: [{ to: '0x' + '22'.repeat(20), value: '0x0', ...callExtra }], ...extra }];
  const capShapes = [
    ['wallet_sendCalls with ERC-7902 eip7702Auth capability', calls({ capabilities: { eip7702Auth: { [SMART]: { account: SMART, delegation: FOREIGN } } } })],
    ['wallet_sendCalls with eip7702Auth marked optional', calls({ capabilities: { eip7702Auth: { optional: true, account: SMART, delegation: FOREIGN } } })],
    ['wallet_sendCalls with an optional capability holding an authorizationList field', calls({ capabilities: { vendorX: { optional: true, authorizationList: [tuple] } } })],
    ['wallet_sendCalls with a per-call delegation capability', calls({}, { capabilities: { setDelegation: { optional: true, delegate: FOREIGN } } })],
    ['wallet_sendCalls with a call carrying authorizationList', calls({}, { authorizationList: [tuple] })],
  ];
  for (const [name, params] of capShapes) {
    const e = reject(() => parseWcRequest(event('wallet_sendCalls', params), SMART, MAINNET, smart));
    check(`declined: ${name} → 5700 with the D6 message`, e && e.code === ERC5792_ERRORS.unsupportedCapability && e.message === EIP7702_WC_REFUSAL, e ? `${e.code} ${e.message}` : 'accepted');
  }
  const okCalls = parseWcRequest(event('wallet_sendCalls', calls({ capabilities: { paymasterService: { optional: true, url: 'https://pm.example/authorization-docs' } } })), SMART, MAINNET, smart);
  check('control: an unrelated optional capability (even with such a word in a URL VALUE) is still just ignored', okCalls.kind === 'calls' && okCalls.batch.ignoredCapabilities.includes('paymasterService'));
  const m = reject(() => parseWcRequest(event('wallet_signAuthorization', [tuple]), OWNER_0, MAINNET));
  check('declined: a method named for authorizations → UNSUPPORTED_METHODS with the D6 message', m && m.code === WC_ERRORS.unsupportedMethods.code && m.message === EIP7702_WC_REFUSAL);
}

// ---------------------------------------------------------------------------
console.log('check-7702: delegated-eoa risk signal');
// ---------------------------------------------------------------------------
{
  const ourClass = { kind: 'delegated-eoa', delegate: PINNED };
  const foreignClass = { kind: 'delegated-eoa', delegate: FOREIGN };
  const STRANGER = '0x' + '47'.repeat(20);
  check('isExpectedOwnDelegation: own account + pinned delegate → true', isExpectedOwnDelegation(OWNER_0, ourClass, [OWNER_0]));
  check('isExpectedOwnDelegation: own account + foreign delegate → false', !isExpectedOwnDelegation(OWNER_0, foreignClass, [OWNER_0]));
  check('isExpectedOwnDelegation: stranger + pinned delegate → false', !isExpectedOwnDelegation(STRANGER, ourClass, [OWNER_0]));
  const facts = (to, code, own = []) => gatherRiskFacts({
    url: null,
    wallet: OWNER_0,
    to,
    chainCaip2: SEPOLIA,
    trackedTokens: [],
    ownAddresses: own,
    transport: async (method, params) => {
      if (method === 'eth_getCode') return code[params[0].toLowerCase()] ?? '0x';
      throw new Error(`unexpected ${method}`);
    },
  });
  const has = (lines) => lines.some((l) => l.type === 'delegated-eoa');
  const self = computeRiskLines(await facts(OWNER_0, { [OWNER_0.toLowerCase()]: indicator(PINNED) }));
  check('self (the sending account) upgraded to the pinned Kernel → NO delegated-eoa warning', !has(self));
  const sibling = computeRiskLines(await facts(owner1.address, { [owner1.address.toLowerCase()]: indicator(PINNED) }, [owner1.address]));
  check("another of the wallet's own accounts upgraded to the pinned Kernel → no warning", !has(sibling));
  const selfForeign = computeRiskLines(await facts(OWNER_0, { [OWNER_0.toLowerCase()]: indicator(FOREIGN) }));
  check('own account delegated to a FOREIGN contract → warning stays', has(selfForeign));
  const stranger = computeRiskLines(await facts(STRANGER, { [STRANGER.toLowerCase()]: indicator(PINNED) }));
  check('a recipient that is not ours, even on the pinned Kernel → warning stays', has(stranger));
  const strangerForeign = computeRiskLines(await facts(STRANGER, { [STRANGER.toLowerCase()]: indicator(FOREIGN) }));
  check('a foreign-delegated recipient → warning stays', has(strangerForeign));
}

// Phase 11 item 2 (bug A): the 7702 quote shares prepareAaCalls, so an
// unfunded EOA gets the wallet's funding message before any bundler call.
{
  const node = fake7702Node({ chainIdHex: '0xaa36a7', balance: 0n });
  const { bundle, bundler } = bundle7702({ node });
  let err = null;
  try {
    await prepareAaSend(bundle, OWNER_0, ethers.getAddress(RECIPIENT), 1000n);
  } catch (e) {
    err = e;
  }
  check('7702: unfunded upgrade quote refused with the funding message naming the EOA', err?.name === 'AaFundingError' && err.sender === OWNER_0 && err.message.includes(`Fund the smart account address ${OWNER_0}`), String(err));
  check('7702: zero bundler calls before the refusal (no stub-tuple estimate)', bundler.calls.length === 0, JSON.stringify(bundler.calls.map((c) => c.method)));
}

console.log('');
console.log(`check-7702: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

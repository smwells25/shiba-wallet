// Phase 7 items 1-3 (app half), smart-account side, entirely OFFLINE:
// Kernel v3.3 as a selectable account type (verify-before-save, every
// refusal persisting nothing), the counterfactual sender for the standard
// test mnemonic, the full stub -> estimate -> sign -> send pipeline for
// Kernel, ERC-20 sends from the smart account, the atomic [approve, swap]
// batch, and smart-account message signing (ERC-1271 envelope / ERC-6492
// wrapper) validated by the engine's verifier against a fake eth_simulateV1
// whose Kernel isValidSignature emulation recovers the owner with ethers.
//
// Imports the actual TypeScript modules the app runs via Node's native
// type stripping. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-aa-kernel.mjs
//
// Nothing is signed against a live chain and nothing is broadcast.

import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  getUserOpHash,
  predictKernelAddress,
  toBytes,
  toHex,
  verifyErc6492Signature,
  isErc6492Signature,
} from '@shiba-wallet/chains-evm';
import { ethers } from 'ethers';
import {
  KERNEL_PREFILL,
  aaErc20TransferCalls,
  clearAaFactory,
  createAaClient,
  createAaClientFromConfig,
  describeAaError,
  getAaConfig,
  isAaConfigured,
  maxAaErc20Send,
  prepareAaCalls,
  prepareAaErc20Send,
  prepareAaSend,
  resolveAaSender,
  sendAa,
  setAaBundlerUrl,
  setAaFactory,
  setAaKernelFactory,
  signHashAsSmartAccount,
} from '../src/wallet/aa.ts';
import { aaSwapCalls, prepareAaSwap } from '../src/wallet/swap.ts';
import { EVM_BASE_SEPOLIA } from '../src/config/evm-chain.ts';
import { personalMessageDigest } from '../src/wallet/walletconnect.ts';
import {
  KERNEL_ACCOUNT_0,
  OWNER_0,
  TEST_MNEMONIC,
  USEROP_HASH,
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
async function checkRejects(name, fn, messagePart) {
  try {
    const value = await fn();
    check(name, false, `expected an error, got ${JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, message.includes(messagePart), `error was: ${message}`);
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
// Smart accounts are configurable only on test networks (phase 9 item 6),
// so the Kernel save path is exercised against a fake Sepolia node.
const sepNode = (opts = {}) => fakeKernelNode({ chainIdHex: '0xaa36a7', ...opts });
const BUNDLER_URL = 'https://bundler.example';

// ---------------------------------------------------------------------------
console.log('check-aa-kernel: pinned Kernel v3.3 prefill (engine constants)');
// ---------------------------------------------------------------------------
check('owner fixture is account 0 of the standard mnemonic', owner.address === OWNER_0, owner.address);
check(
  'prefill factory / meta factory / implementation / validator are the engine KERNEL_V3_3 values',
  KERNEL_PREFILL.factory === KERNEL_V3_3.factory &&
    KERNEL_PREFILL.metaFactory === KERNEL_V3_3.metaFactory &&
    KERNEL_PREFILL.implementation === KERNEL_V3_3.implementation &&
    KERNEL_PREFILL.ecdsaValidator === KERNEL_V3_3.ecdsaValidator &&
    KERNEL_PREFILL.accountId === 'kernel.advanced.v0.3.3',
);
check(
  'prefill pins the addresses documented for both mainnet and Sepolia (AGENTS.md phase 7)',
  KERNEL_PREFILL.factory === '0x2577507b78c2008Ff367261CB6285d44ba5eF2E9' &&
    KERNEL_PREFILL.metaFactory === '0xd703aaE79538628d27099B8c4f621bE4CCd142d5' &&
    KERNEL_PREFILL.implementation === '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28' &&
    KERNEL_PREFILL.ecdsaValidator === '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57',
);

// ---------------------------------------------------------------------------
console.log('check-aa-kernel: Kernel verify-before-save');
// ---------------------------------------------------------------------------
{
  const store = memoryStore();
  await setAaBundlerUrl(SEPOLIA, BUNDLER_URL, { store, transportFor: () => fakeBundler() });
  const result = await setAaKernelFactory(SEPOLIA, KERNEL_PREFILL.factory, NODE_URL, {
    store,
    transportFor: () => sepNode(),
  });
  const cfg = await getAaConfig(SEPOLIA, store);
  check('Kernel factory saves after every on-chain check passes', cfg.accountType === 'kernel-v3.3' && same(cfg.factory, KERNEL_V3_3.factory));
  check('implementation, meta factory, validator and accountId recorded', same(cfg.factoryImplementation, KERNEL_V3_3.implementation) && same(cfg.kernelMetaFactory, KERNEL_V3_3.metaFactory) && same(cfg.kernelValidator, KERNEL_V3_3.ecdsaValidator) && cfg.kernelAccountId === 'kernel.advanced.v0.3.3' && result.accountId === 'kernel.advanced.v0.3.3');
  check('Kernel config with a bundler counts as configured', isAaConfigured(cfg));
  check('verification timestamp recorded', typeof cfg.factoryVerifiedAt === 'string');

  // Switching type: a SimpleAccount factory replaces the Kernel setup.
  const SIMPLE_FACTORY = '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985';
  const SIMPLE_IMPL = '0x68641DE71cfEa5a5d0D29712449Ee254bb1400C2';
  const simpleNode = async (method, params) => {
    if (method === 'eth_getCode') return '0x6001';
    if (method === 'eth_call') {
      const { to, data } = params[0];
      if (same(to, SIMPLE_FACTORY) && data.startsWith(ethers.id('accountImplementation()').slice(0, 10))) {
        return '0x' + '0'.repeat(24) + SIMPLE_IMPL.slice(2).toLowerCase();
      }
      if (same(to, SIMPLE_IMPL)) return '0x' + '0'.repeat(24) + ENTRYPOINT_V07.slice(2).toLowerCase();
    }
    throw new Error(`unexpected ${method}`);
  };
  await setAaFactory(SEPOLIA, SIMPLE_FACTORY, NODE_URL, { store, transportFor: () => simpleNode });
  const switched = await getAaConfig(SEPOLIA, store);
  check('saving a SimpleAccountFactory switches the type and clears the Kernel fields', switched.accountType === 'simple' && switched.kernelMetaFactory === null && switched.kernelValidator === null && switched.kernelAccountId === null);
  await clearAaFactory(SEPOLIA, store);
  const cleared = await getAaConfig(SEPOLIA, store);
  check('clearing the factory clears the type too', cleared.factory === null && cleared.accountType === 'simple' && !isAaConfigured(cleared));

  // Legacy (pre-phase-7) stored entry without a type reads as SimpleAccount.
  const legacy = memoryStore();
  await legacy.setItem('shiba-wallet.aa-config.v1', JSON.stringify({ [SEPOLIA]: { bundlerUrl: BUNDLER_URL, factory: SIMPLE_FACTORY } }));
  const legacyCfg = await getAaConfig(SEPOLIA, legacy);
  check('a stored config without accountType reads as simple (backward compatible)', legacyCfg.accountType === 'simple' && isAaConfigured(legacyCfg));

  // Every refusal persists nothing.
  const rejectStore = memoryStore();
  const cases = [
    ['wrong chain id on the RPC endpoint', { chainIdHex: '0x1' }, 'expected 11155111'],
    ['KernelFactory without code', { codeAt: { [KERNEL_V3_3.factory.toLowerCase()]: false } }, 'KernelFactory'],
    ['implementation without code', { codeAt: { [KERNEL_V3_3.implementation.toLowerCase()]: false } }, 'Kernel implementation'],
    ['ECDSA validator without code', { codeAt: { [KERNEL_V3_3.ecdsaValidator.toLowerCase()]: false } }, 'ECDSA validator'],
    ['meta factory without code', { codeAt: { [KERNEL_V3_3.metaFactory.toLowerCase()]: false } }, 'Meta factory'],
    ['factory.implementation() mismatch', { implementation: '0x' + '42'.repeat(20) }, 'factory.implementation()'],
    ['entrypoint() is not v0.7', { entryPoint: '0x' + '43'.repeat(20) }, 'kernel.entrypoint()'],
    ['accountId() mismatch', { accountId: 'kernel.advanced.v0.3.1' }, 'accountId()'],
    ['meta factory has not approved the factory', { approved: false }, 'has not approved'],
    ['validator is not a validator module', { isValidator: false }, 'validator module'],
  ];
  for (const [name, opts, part] of cases) {
    await checkRejects(
      `refused: ${name}`,
      () => setAaKernelFactory(SEPOLIA, KERNEL_PREFILL.factory, NODE_URL, { store: rejectStore, transportFor: () => sepNode(opts) }),
      part,
    );
  }
  await checkRejects(
    'refused before any RPC: bad EIP-55 checksum',
    () => setAaKernelFactory(SEPOLIA, '0x2577507b78c2008Ff367261CB6285d44ba5eF2e9', NODE_URL, { store: rejectStore, transportFor: () => sepNode() }),
    'checksum',
  );
  const after = await getAaConfig(SEPOLIA, rejectStore);
  check('every refused Kernel save persisted nothing', after.factory === null && after.kernelValidator === null && (await rejectStore.getItem('shiba-wallet.aa-config.v1')) === null);

  // Mainnet: the Kernel account is 'testnet-only' in the readiness table
  // (src/config/readiness.ts), so the same save is refused before any RPC
  // and persists nothing, while Sepolia keeps working (above).
  let mainnetRequests = 0;
  const mainStore = memoryStore();
  await checkRejects(
    'mainnet Kernel factory save refused with the readiness reason',
    () => setAaKernelFactory(MAINNET, KERNEL_PREFILL.factory, NODE_URL, { store: mainStore, transportFor: () => { mainnetRequests += 1; return fakeKernelNode(); } }),
    'only on test networks',
  );
  check('the refused mainnet save made no request and persisted nothing', mainnetRequests === 0 && (await mainStore.getItem('shiba-wallet.aa-config.v1')) === null);
  check('the Sepolia Kernel config never appears under the mainnet key', (await getAaConfig(MAINNET, store)).factory === null);
}

// ---------------------------------------------------------------------------
console.log('check-aa-kernel: counterfactual sender (standard mnemonic)');
// ---------------------------------------------------------------------------
const kernelConfig = {
  bundlerUrl: BUNDLER_URL,
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
function kernelBundle({ node = fakeKernelNode(), bundler = fakeBundler(), accountIndex = 0, chainId = 1n } = {}) {
  const bundle = createAaClientFromConfig(kernelConfig, {
    nodeUrl: NODE_URL,
    chainId,
    accountIndex,
    transportFor: (url) => (url === NODE_URL ? node : bundler),
  });
  return { bundle, node, bundler };
}
{
  check('engine prediction for owner 0x9858…Da94, index 0 is 0xB67b…9a42', predictKernelAddress(OWNER_0, { index: 0n }) === KERNEL_ACCOUNT_0);
  const { bundle } = kernelBundle();
  check('bundle carries the Kernel type and factory', bundle.accountType === 'kernel-v3.3' && same(bundle.factory, KERNEL_V3_3.factory));
  const sender = await resolveAaSender(bundle, OWNER_0);
  check('resolved sender equals the engine prediction 0xB67b8b7cCA718EAC64d2b59ba568585A9FC69a42', sender === KERNEL_ACCOUNT_0, sender);
  const { bundle: b1 } = kernelBundle({ accountIndex: 1 });
  const s1 = await resolveAaSender(b1, owner1.address);
  check('account index 1 uses salt 1 and its own owner', s1 === predictKernelAddress(owner1.address, { index: 1n }) && s1 !== KERNEL_ACCOUNT_0);
  const { bundle: liar } = kernelBundle({ node: fakeKernelNode({ lieAboutAddress: true }) });
  await checkRejects('a factory answer that differs from the local CREATE2 prediction is refused', () => resolveAaSender(liar, OWNER_0), 'local CREATE2 prediction');
  const simple = createAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, factory: '0x' + '55'.repeat(20), transportFor: () => async () => '0x' });
  check('createAaClient without a type keeps the SimpleAccount default', simple.accountType === 'simple' && simple.spec.signErc1271 === undefined);
}

// ---------------------------------------------------------------------------
console.log('check-aa-kernel: Kernel stub -> estimate -> sign -> send');
// ---------------------------------------------------------------------------
{
  const { bundle, bundler } = kernelBundle();
  const RECIPIENT = '0x' + 'aa'.repeat(20);
  const quote = await prepareAaSend(bundle, OWNER_0, ethers.getAddress(RECIPIENT), 12345n);
  check('quote sender is the Kernel counterfactual account', quote.sender === KERNEL_ACCOUNT_0);
  check('undeployed → will deploy, type recorded on the quote', quote.deployed === false && quote.accountType === 'kernel-v3.3');
  const estimated = bundler.lastEstimated;
  check('estimation op carries the Kernel stub signature (recoverable dummy)', estimated.signature.endsWith('1c') && estimated.signature.length === 132);
  const { userOpHash } = await sendAa(bundle, owner, quote);
  check('sendAa returns the bundler userOpHash', userOpHash === USEROP_HASH);
  const op = bundler.lastOp;
  check('submitted sender = 0xB67b…9a42', op.sender === KERNEL_ACCOUNT_0);
  check('deployment goes through the staked meta factory', same(op.factory, KERNEL_V3_3.metaFactory));
  const deploy = new ethers.Interface(['function deployWithFactory(address factory, bytes createData, bytes32 salt)']).decodeFunctionData('deployWithFactory', op.factoryData);
  check('factoryData = deployWithFactory(KernelFactory, initialize(...owner...), salt 0) (ethers decode)', same(deploy[0], KERNEL_V3_3.factory) && BigInt(deploy[2]) === 0n && deploy[1].toLowerCase().includes(OWNER_0.slice(2).toLowerCase()));
  const exec = decodeKernelExecute(op.callData);
  check('callData = ERC-7579 execute, single-call mode, the native transfer (ethers decode)', exec.callType === 0 && exec.execType === 0 && exec.calls.length === 1 && same(exec.calls[0].to, RECIPIENT) && exec.calls[0].value === 12345n && exec.calls[0].data === '0x');
  const hash = getUserOpHash(fromRpcOp(op), ENTRYPOINT_V07, 1n);
  const recovered = ethers.verifyMessage(hash, op.signature);
  check('signature is the owner key over EIP-191(userOpHash), recovered by ethers', recovered === OWNER_0, recovered);

  // A signer whose smart account differs from the quote is refused before signing.
  await checkRejects('sendAa refuses a signer whose smart account is not the quoted sender', () => sendAa(bundle, owner1, quote), 'Nothing was signed');
}

// ---------------------------------------------------------------------------
console.log('check-aa-kernel: Base Sepolia (eip155:84532), the second test chain');
// ---------------------------------------------------------------------------
// Phase 10 item 3: the same Kernel v3.3 addresses were verified read-only on
// Base Sepolia (config/evm-chain.ts EVM_BASE_SEPOLIA); here the save path and
// the full pipeline run against a fake node answering Base Sepolia's chain
// id 0x14a34, and the two test chains refuse each other's endpoints.
{
  const BASE = EVM_BASE_SEPOLIA.caip2;
  const baseNode = (opts = {}) => fakeKernelNode({ chainIdHex: '0x14a34', ...opts });
  check('profile: Base Sepolia records Kernel v3.3 as verified and pre-fills no SimpleAccount factory', EVM_BASE_SEPOLIA.kernelV33Verified === true && EVM_BASE_SEPOLIA.aaPrefill === null);
  const store = memoryStore();
  await setAaBundlerUrl(SEPOLIA, BUNDLER_URL, { store, transportFor: () => fakeBundler() });
  await setAaKernelFactory(SEPOLIA, KERNEL_PREFILL.factory, NODE_URL, { store, transportFor: () => sepNode() });
  await setAaBundlerUrl(BASE, 'https://bundler-base.example', { store, transportFor: () => fakeBundler() });
  const result = await setAaKernelFactory(BASE, KERNEL_PREFILL.factory, NODE_URL, { store, transportFor: () => baseNode() });
  const cfg = await getAaConfig(BASE, store);
  check('Base Sepolia: the pinned Kernel factory saves after every on-chain check', cfg.chain === BASE && cfg.accountType === 'kernel-v3.3' && same(cfg.factory, KERNEL_V3_3.factory) && result.accountId === 'kernel.advanced.v0.3.3');
  check('Base Sepolia: implementation / meta factory / validator recorded', same(cfg.factoryImplementation, KERNEL_V3_3.implementation) && same(cfg.kernelMetaFactory, KERNEL_V3_3.metaFactory) && same(cfg.kernelValidator, KERNEL_V3_3.ecdsaValidator));
  check('Base Sepolia: configured with its own bundler', isAaConfigured(cfg) && cfg.bundlerUrl === 'https://bundler-base.example');
  const sep = await getAaConfig(SEPOLIA, store);
  check('Sepolia keeps its own bundler and Kernel config', sep.bundlerUrl === BUNDLER_URL && sep.accountType === 'kernel-v3.3' && isAaConfigured(sep));

  const rejectStore = memoryStore();
  await checkRejects('a Sepolia node is refused for the Base Sepolia key', () => setAaKernelFactory(BASE, KERNEL_PREFILL.factory, NODE_URL, { store: rejectStore, transportFor: () => sepNode() }), 'expected 84532');
  await checkRejects('a Base Sepolia node is refused for the Sepolia key', () => setAaKernelFactory(SEPOLIA, KERNEL_PREFILL.factory, NODE_URL, { store: rejectStore, transportFor: () => baseNode() }), 'expected 11155111');
  await checkRejects('a Base MAINNET node (0x2105) is refused for the Base Sepolia key', () => setAaKernelFactory(BASE, KERNEL_PREFILL.factory, NODE_URL, { store: rejectStore, transportFor: () => baseNode({ chainIdHex: '0x2105' }) }), 'expected 84532');
  await checkRejects('Base Sepolia: an unapproved factory is refused like on Sepolia', () => setAaKernelFactory(BASE, KERNEL_PREFILL.factory, NODE_URL, { store: rejectStore, transportFor: () => baseNode({ approved: false }) }), 'has not approved');
  check('the refused cross-chain saves persisted nothing', (await rejectStore.getItem('shiba-wallet.aa-config.v1')) === null);
  await checkRejects('Base MAINNET (eip155:8453) is not a test network: the save is refused before any request', () => setAaKernelFactory('eip155:8453', KERNEL_PREFILL.factory, NODE_URL, { store: rejectStore, transportFor: () => { throw new Error('no request expected'); } }), 'only on test networks');

  // Full pipeline with chain id 84532: the counterfactual address is the
  // same CREATE2 result as on every chain, and the owner signs the v0.7
  // userOpHash bound to 84532 (not to 1 or 11155111).
  const node = baseNode();
  const bundler = fakeBundler();
  const bundle = createAaClientFromConfig(kernelConfig, { nodeUrl: NODE_URL, chainId: 84532n, accountIndex: 0, transportFor: (url) => (url === NODE_URL ? node : bundler) });
  check('Base Sepolia: the counterfactual sender is 0xB67b…9a42 (CREATE2 is chain-independent)', (await resolveAaSender(bundle, OWNER_0)) === KERNEL_ACCOUNT_0);
  const RECIPIENT = ethers.getAddress('0x' + 'bb'.repeat(20));
  const quote = await prepareAaSend(bundle, OWNER_0, RECIPIENT, 777n);
  check('Base Sepolia: the quote is for the Kernel account and will deploy', quote.sender === KERNEL_ACCOUNT_0 && quote.deployed === false);
  await sendAa(bundle, owner, quote);
  const op = bundler.lastOp;
  const hash84532 = getUserOpHash(fromRpcOp(op), ENTRYPOINT_V07, 84532n);
  check('Base Sepolia: the owner signed the userOpHash for chain 84532 (ethers recovers the owner)', ethers.verifyMessage(hash84532, op.signature) === OWNER_0);
  check('…and NOT the Sepolia-bound hash (chain binding)', ethers.verifyMessage(getUserOpHash(fromRpcOp(op), ENTRYPOINT_V07, 11155111n), op.signature) !== OWNER_0);
  const wrongNodeBundle = createAaClientFromConfig(kernelConfig, { nodeUrl: NODE_URL, chainId: 84532n, accountIndex: 0, transportFor: (url) => (url === NODE_URL ? sepNode() : fakeBundler()) });
  await checkRejects('Base Sepolia: a quote through a Sepolia node is refused (chain-id guard)', () => prepareAaSend(wrongNodeBundle, OWNER_0, RECIPIENT, 777n), '84532');
}

// ---------------------------------------------------------------------------
console.log('check-aa-kernel: ERC-20 send FROM the smart account (one transfer call)');
// ---------------------------------------------------------------------------
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
{
  const tokenBalances = { [`${USDC.toLowerCase()}|${KERNEL_ACCOUNT_0.toLowerCase()}`]: 5_000_000n };
  const { bundle, bundler } = kernelBundle({ node: fakeKernelNode({ tokenBalances }) });
  const quote = await prepareAaErc20Send(bundle, OWNER_0, { contract: USDC, recipient: RECIPIENT, amount: 1_500_000n, symbol: 'USDC', decimals: 6 });
  check('token quote: one call, no native value, token balance read from the SMART ACCOUNT', quote.calls.length === 1 && quote.amount === 0n && quote.tokenSpend?.balance === 5_000_000n && quote.token?.amount === 1_500_000n);
  check('display recipient is the token recipient, not the contract', quote.to === RECIPIENT);
  await sendAa(bundle, owner, quote);
  const exec = decodeKernelExecute(bundler.lastOp.callData);
  const erc20 = new ethers.Interface(['function transfer(address to, uint256 amount)', 'function approve(address spender, uint256 amount)']);
  const decoded = erc20.decodeFunctionData('transfer', exec.calls[0].data);
  check('callData = execute(single, USDC, 0, transfer(recipient, 1.5 USDC)) — no approve (ethers decode)', exec.callType === 0 && same(exec.calls[0].to, USDC) && exec.calls[0].value === 0n && same(decoded[0], RECIPIENT) && decoded[1] === 1_500_000n);
  check('aaErc20TransferCalls builds exactly that call', toHex(aaErc20TransferCalls(USDC, RECIPIENT, 7n)[0].data) === erc20.encodeFunctionData('transfer', [RECIPIENT, 7n]));
  await checkRejects('amount above the smart account token balance is refused', () => prepareAaErc20Send(bundle, OWNER_0, { contract: USDC, recipient: RECIPIENT, amount: 5_000_001n, symbol: 'USDC', decimals: 6 }), 'held by the smart account');
  const { bundle: poor } = kernelBundle({ node: fakeKernelNode({ tokenBalances, balance: 1000n }) });
  await checkRejects('ETH for gas is checked against the smart account', () => prepareAaErc20Send(poor, OWNER_0, { contract: USDC, recipient: RECIPIENT, amount: 1n, symbol: 'USDC', decimals: 6 }), 'smart account pays its own gas');
  const max = await maxAaErc20Send(bundle, OWNER_0, { contract: USDC, recipient: RECIPIENT, symbol: 'USDC', decimals: 6 });
  check('token Max = the smart account full token balance', max === 5_000_000n);
}

// ---------------------------------------------------------------------------
console.log('check-aa-kernel: swap from the smart account as ONE atomic batch');
// ---------------------------------------------------------------------------
{
  const ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';
  const swapQuote = {
    sellAmount: 2_000_000n,
    buyAmount: 10n ** 15n,
    minBuyAmount: 9n * 10n ** 14n,
    transaction: { to: ALLOWANCE_HOLDER, data: '0xdeadbeef' + '00'.repeat(36), value: 0n, gas: 200000n },
  };
  const erc20 = new ethers.Interface(['function approve(address spender, uint256 amount)']);
  const calls = aaSwapCalls(USDC, swapQuote);
  check('ERC-20 sell → [approve, swap]', calls.length === 2);
  const approve = erc20.decodeFunctionData('approve', calls[0].data);
  check('call 1 = approve(spender = quote transaction.to, EXACTLY the sell amount) on the sell token', same(calls[0].to, USDC) && same(approve[0], ALLOWANCE_HOLDER) && approve[1] === 2_000_000n && calls[0].value === 0n);
  check('approve is never unlimited', approve[1] !== ethers.MaxUint256);
  check('call 2 = the quoted 0x call verbatim', same(calls[1].to, ALLOWANCE_HOLDER) && toHex(calls[1].data) === swapQuote.transaction.data && calls[1].value === 0n);
  const nativeCalls = aaSwapCalls(null, { ...swapQuote, transaction: { ...swapQuote.transaction, value: 10n ** 16n } });
  check('native sell → [swap] with the quoted value, no approve', nativeCalls.length === 1 && nativeCalls[0].value === 10n ** 16n);

  const tokenBalances = { [`${USDC.toLowerCase()}|${KERNEL_ACCOUNT_0.toLowerCase()}`]: 3_000_000n };
  const { bundle, bundler } = kernelBundle({ node: fakeKernelNode({ tokenBalances }) });
  const quote = await prepareAaSwap(bundle, OWNER_0, { token: USDC, symbol: 'USDC' }, swapQuote);
  check('swap quote checks the smart account sell-token balance', quote.tokenSpend?.balance === 3_000_000n && quote.calls.length === 2);
  await sendAa(bundle, owner, quote);
  const exec = decodeKernelExecute(bundler.lastOp.callData);
  check('submitted callData = ERC-7579 BATCH mode, revert-on-failure exec type (atomic)', exec.callType === 1 && exec.execType === 0 && exec.calls.length === 2);
  const a = erc20.decodeFunctionData('approve', exec.calls[0].data);
  check('decoded batch call 1 = approve(0x allowance holder, 2 USDC) (ethers)', same(exec.calls[0].to, USDC) && same(a[0], ALLOWANCE_HOLDER) && a[1] === 2_000_000n);
  check('decoded batch call 2 = the 0x calldata to the allowance holder (ethers)', same(exec.calls[1].to, ALLOWANCE_HOLDER) && exec.calls[1].data === swapQuote.transaction.data);
  await checkRejects('sell amount above the smart account balance is refused', () => prepareAaSwap(bundle, OWNER_0, { token: USDC, symbol: 'USDC' }, { ...swapQuote, sellAmount: 3_000_001n }), 'held by the smart account');
  const { bundle: failing } = kernelBundle({ bundler: fakeBundler({ estimateError: 'RPC error -32521: execution reverted: TRANSFER_FROM_FAILED (eth_estimateUserOperationGas)' }) });
  await checkRejects('a reverting batch fails at the bundler estimate (the AA pre-flight gate), message verbatim', () => prepareAaSwap(failing, OWNER_0, null, swapQuote), 'TRANSFER_FROM_FAILED');

  // SimpleAccount batches use executeBatch (also atomic).
  const SIMPLE = '0x' + '55'.repeat(20);
  const SENDER = '0x' + '77'.repeat(20);
  const simpleBundler = fakeBundler();
  const simpleNode = async (method, params) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x6001';
    if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
    if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
    if (method === 'eth_call') {
      const { to, data } = params[0];
      if (same(to, SIMPLE)) return '0x' + '0'.repeat(24) + SENDER.slice(2);
      if (data.startsWith(ethers.id('balanceOf(address)').slice(0, 10))) return '0x' + (10n ** 9n).toString(16).padStart(64, '0');
      return '0x' + '0'.repeat(64);
    }
    throw new Error(`unexpected ${method}`);
  };
  const simpleBundle = createAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, factory: SIMPLE, transportFor: (u) => (u === NODE_URL ? simpleNode : simpleBundler) });
  const sq = await prepareAaSwap(simpleBundle, OWNER_0, { token: USDC, symbol: 'USDC' }, swapQuote);
  await sendAa(simpleBundle, owner, sq);
  const batchIface = new ethers.Interface(['function executeBatch(address[] dest, uint256[] value, bytes[] func)']);
  const [dest, , func] = batchIface.decodeFunctionData('executeBatch', simpleBundler.lastOp.callData);
  check('SimpleAccount batch = executeBatch([token, allowance holder], …, [approve, swap]) (ethers)', dest.length === 2 && same(dest[0], USDC) && same(dest[1], ALLOWANCE_HOLDER) && func[1] === swapQuote.transaction.data);
}

// ---------------------------------------------------------------------------
console.log('check-aa-kernel: smart-account message signing (ERC-1271 / ERC-6492)');
// ---------------------------------------------------------------------------
{
  const message = new TextEncoder().encode('Sign in to example.org\nNonce: 42');
  const hash = personalMessageDigest(message);
  check('personal_sign hash equals ethers.hashMessage', toHex(hash) === ethers.hashMessage(message));

  // Undeployed: ERC-6492 envelope, verified through eth_simulateV1.
  const node = fakeKernelNode();
  const { bundle } = kernelBundle({ node });
  const sig = await signHashAsSmartAccount(bundle, owner, hash, KERNEL_ACCOUNT_0);
  check('undeployed account → ERC-6492-wrapped signature', sig.erc6492 === true && sig.deployed === false && isErc6492Signature(sig.signature) && sig.account === KERNEL_ACCOUNT_0);
  const verdict = await verifyErc6492Signature(node, KERNEL_ACCOUNT_0, hash, sig.signature);
  check('engine verifier: valid via the simulated deployment + Kernel isValidSignature', verdict.valid === true && verdict.path === 'erc6492-counterfactual', JSON.stringify(verdict));
  const wrongHash = personalMessageDigest(new TextEncoder().encode('a different message'));
  const bad = await verifyErc6492Signature(node, KERNEL_ACCOUNT_0, wrongHash, sig.signature);
  check('the same signature does not validate a different message', bad.valid === false);
  const flipped = sig.signature.slice();
  flipped[flipped.length - 100] ^= 0x01;
  const badFlip = await verifyErc6492Signature(node, KERNEL_ACCOUNT_0, hash, flipped);
  check('a flipped byte is rejected', badFlip.valid === false);

  // Typed data digest signed the same way.
  const typed = { domain: { name: 'Example', version: '1', chainId: 1 }, types: { Order: [{ name: 'amount', type: 'uint256' }] }, message: { amount: 7 } };
  const typedHash = toBytes(ethers.TypedDataEncoder.hash(typed.domain, typed.types, typed.message));
  const typedSig = await signHashAsSmartAccount(bundle, owner, typedHash, KERNEL_ACCOUNT_0);
  check('typed-data digest signature validates too', (await verifyErc6492Signature(node, KERNEL_ACCOUNT_0, typedHash, typedSig.signature)).valid === true);

  // Deployed: plain ERC-1271 envelope, verified with eth_call isValidSignature.
  const deployedNode = fakeKernelNode({ deployedAccounts: new Set([KERNEL_ACCOUNT_0]), owners: { [KERNEL_ACCOUNT_0.toLowerCase()]: OWNER_0 } });
  const { bundle: deployedBundle } = kernelBundle({ node: deployedNode });
  const dsig = await signHashAsSmartAccount(deployedBundle, owner, hash, KERNEL_ACCOUNT_0);
  check('deployed account → unwrapped 86-byte Kernel envelope (0x01 || validator || sig)', dsig.erc6492 === false && dsig.signature.length === 86 && dsig.signature[0] === 0x01 && same(toHex(dsig.signature.slice(1, 21)), KERNEL_V3_3.ecdsaValidator));
  const dverdict = await verifyErc6492Signature(deployedNode, KERNEL_ACCOUNT_0, hash, dsig.signature);
  check('engine verifier: valid via ERC-1271 on the deployed account', dverdict.valid === true && dverdict.path === 'erc1271', JSON.stringify(dverdict));

  // Chain binding: a mainnet signature does not validate on a Sepolia account emulation.
  const sepNode = fakeKernelNode({ chainIdHex: '0xaa36a7', deployedAccounts: new Set([KERNEL_ACCOUNT_0]), owners: { [KERNEL_ACCOUNT_0.toLowerCase()]: OWNER_0 } });
  check('Kernel wrapper binds the chain id (mainnet signature invalid on chain 11155111)', (await verifyErc6492Signature(sepNode, KERNEL_ACCOUNT_0, hash, dsig.signature)).valid === false);

  await checkRejects('refused when the owner smart account is not the bound address', () => signHashAsSmartAccount(bundle, owner, hash, '0x' + '12'.repeat(20)), 'Nothing was signed');
  const simple = createAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, factory: '0x' + '55'.repeat(20), transportFor: () => async () => '0x' });
  await checkRejects('SimpleAccount cannot sign messages (no ERC-1271)', () => signHashAsSmartAccount(simple, owner, hash, KERNEL_ACCOUNT_0), 'no ERC-1271 support');
}

// ---------------------------------------------------------------------------
console.log('check-aa-kernel: error wording and multi-call quotes');
// ---------------------------------------------------------------------------
{
  const rejection = new Error('RPC error -32502: account uses banned opcode: CREATE2 (eth_sendUserOperation)');
  const d = describeAaError(rejection, { accountType: 'kernel-v3.3', deployed: false });
  check('Kernel deployment rejection: specific title, bundler message verbatim, limitation note', d !== null && d.title.includes('refused to deploy') && d.detail.startsWith(rejection.message) && d.detail.includes('ERC-7562'));
  check('deployed Kernel accounts or SimpleAccount get no special wording', describeAaError(rejection, { accountType: 'kernel-v3.3', deployed: true }) === null && describeAaError(rejection, { accountType: 'simple', deployed: false }) === null);
  const { bundle, bundler } = kernelBundle();
  const calls = [
    { to: RECIPIENT, value: 1n, data: new Uint8Array(0) },
    { to: USDC, value: 0n, data: toBytes('0x12345678') },
    { to: RECIPIENT, value: 2n, data: new Uint8Array(0) },
  ];
  const q = await prepareAaCalls(bundle, OWNER_0, calls);
  check('multi-call quote sums the native value of every call', q.amount === 3n && q.total === 3n + q.fee);
  await sendAa(bundle, owner, q);
  const exec = decodeKernelExecute(bundler.lastOp.callData);
  check('three calls submitted in order as one batch', exec.callType === 1 && exec.calls.length === 3 && exec.calls[1].data === '0x12345678' && exec.calls[2].value === 2n);
  await checkRejects('an empty call list is refused', () => prepareAaCalls(bundle, OWNER_0, []), 'no calls');
}

console.log('');
console.log(`check-aa-kernel: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

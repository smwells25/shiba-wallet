// Exercises the app's ERC-4337 smart-account glue (src/wallet/aa.ts)
// end-to-end with FAKE transports only — no network access, nothing is
// signed against a live chain, nothing is broadcast. Mirrors the fake
// transport style of packages/chains-evm/test/smart-account.test.ts.
//
// Covered: config store round-trip (save/clear/corrupt fallback), factory
// verification accept + every reject case (the exact aa-smoke.mjs checks),
// bundler verification accept/reject, counterfactual address resolution
// through the spec's getAddress, the full stub -> estimate -> sign -> send
// pipeline producing a userOpHash, receipt polling, and the defensive
// receipt-shape summarizer.
//
// Like check-tokens.mjs, it imports the actual TypeScript modules the app
// runs via Node's native type stripping. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-aa.mjs
//
// The owner key derives from the standard BIP-39 test mnemonic
// ("abandon ... about"), whose addresses are public knowledge.

import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { ENTRYPOINT_V07, selector, toHex } from '@shiba-wallet/chains-evm';
import {
  clearAaBundlerUrl,
  clearAaFactory,
  createAaClient,
  getAaConfig,
  isAaConfigured,
  prepareAaSend,
  sendAa,
  setAaBundlerUrl,
  setAaFactory,
  summarizeAaReceipt,
  verifyAaFactory,
  waitForAaReceipt,
} from '../src/wallet/aa.ts';
import { EVM_CHAIN_ID } from '../src/wallet/send.ts';

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

async function checkRejects(name, promiseFn, messagePart) {
  try {
    const value = await promiseFn();
    check(name, false, `expected an error, got ${JSON.stringify(value)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, message.includes(messagePart), `error was: ${message}`);
  }
}

function memoryStore() {
  const mem = new Map();
  return {
    getItem: async (key) => (mem.has(key) ? mem.get(key) : null),
    setItem: async (key, value) => {
      mem.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures and fake transports (in-memory JSON-RPC, no network)
// ---------------------------------------------------------------------------

// All-lowercase inputs (no checksum) that aa.ts normalizes via EIP-55.
const FACTORY_INPUT = '0x' + '55'.repeat(20);
const IMPL = '0x' + '66'.repeat(20);
const SENDER = '0x' + '77'.repeat(20);
const RECIPIENT = '0x' + 'aa'.repeat(20);
const USEROP_HASH = '0x' + 'ab'.repeat(32);
const TX_HASH = '0x' + 'cd'.repeat(32);

const sel = (signature) => toHex(selector(signature));
const pad32 = (address) => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Fake node transport: serves eth_getCode / eth_call for the factory
 * verification and counterfactual resolution, plus the chain-id, balance
 * and fee methods prepareAaSend uses. Base fee 1 gwei, priority 1 gwei,
 * so suggestFees yields maxFeePerGas = 3 gwei.
 */
function fakeNode({
  factoryHasCode = true,
  implHasCode = true,
  entryPoint = ENTRYPOINT_V07,
  chainId = '0x1',
  senderDeployed = false,
  senderBalance = 10n ** 18n, // 1 ETH
  calls = [],
} = {}) {
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return chainId;
    if (method === 'eth_getBalance') {
      return '0x' + senderBalance.toString(16);
    }
    if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
    if (method === 'eth_getCode') {
      const [address] = params;
      if (same(address, FACTORY_INPUT)) return factoryHasCode ? '0x6001' : '0x';
      if (same(address, IMPL)) return implHasCode ? '0x6002' : '0x';
      if (same(address, SENDER)) return senderDeployed ? '0x6003' : '0x';
      return '0x';
    }
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      if (same(to, FACTORY_INPUT) && data.startsWith(sel('accountImplementation()'))) {
        return pad32(IMPL);
      }
      if (same(to, FACTORY_INPUT) && data.startsWith(sel('getAddress(address,uint256)'))) {
        return pad32(SENDER);
      }
      if (same(to, IMPL) && data.startsWith(sel('entryPoint()'))) {
        return pad32(entryPoint);
      }
      if (same(to, ENTRYPOINT_V07) && data.startsWith(sel('getNonce(address,uint192)'))) {
        return '0x07';
      }
      throw new Error(`fake node: unexpected eth_call to ${to} data ${data.slice(0, 10)}`);
    }
    throw new Error(`fake node: unexpected method ${method}`);
  };
  transport.calls = calls;
  return transport;
}

/** Fake bundler transport; records the submitted RpcUserOperation. */
function fakeBundler({
  supported = [ENTRYPOINT_V07],
  receipt = null,
  receiptAfterPolls = 0,
} = {}) {
  const calls = [];
  let polls = 0;
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_supportedEntryPoints') return supported;
    if (method === 'eth_estimateUserOperationGas') {
      return {
        callGasLimit: '0x111',
        verificationGasLimit: '0x222',
        preVerificationGas: '0x333',
      };
    }
    if (method === 'eth_sendUserOperation') {
      transport.lastOp = params[0];
      return USEROP_HASH;
    }
    if (method === 'eth_getUserOperationReceipt') {
      polls += 1;
      return polls > receiptAfterPolls ? receipt : null;
    }
    throw new Error(`fake bundler: unexpected method ${method}`);
  };
  transport.calls = calls;
  return transport;
}

function ownerAccount() {
  const seed = mnemonicToSeed(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  const account = evmKeyProvider.deriveAccount(seed, 0, 0);
  seed.fill(0);
  return account;
}

// ---------------------------------------------------------------------------
// 1. Config store round-trip with save-time verification
// ---------------------------------------------------------------------------

console.log('AA config store (in-memory KeyValueStore, exact app store code):');

const store = memoryStore();
const fresh = await getAaConfig(EVM_CHAIN_ID, store);
check(
  'fresh store: everything null, not configured',
  fresh.bundlerUrl === null &&
    fresh.factory === null &&
    fresh.factoryImplementation === null &&
    !isAaConfigured(fresh),
);

const goodBundler = fakeBundler();
const supported = await setAaBundlerUrl(EVM_CHAIN_ID, ' https://bundler.example/rpc/ ', {
  store,
  transportFor: () => goodBundler,
});
check(
  'bundler URL saves after eth_supportedEntryPoints includes v0.7',
  supported.length === 1 && supported[0] === ENTRYPOINT_V07,
);
let config = await getAaConfig(EVM_CHAIN_ID, store);
check(
  'saved bundler URL is trimmed of whitespace and trailing slashes',
  config.bundlerUrl === 'https://bundler.example/rpc',
  config.bundlerUrl,
);
check('bundler verification timestamp recorded', typeof config.bundlerVerifiedAt === 'string');

await checkRejects(
  'bundler without v0.7 support is refused',
  () =>
    setAaBundlerUrl(EVM_CHAIN_ID, 'https://bad.example', {
      store,
      transportFor: () => fakeBundler({ supported: ['0x' + '99'.repeat(20)] }),
    }),
  'does not support EntryPoint v0.7',
);
config = await getAaConfig(EVM_CHAIN_ID, store);
check(
  'failed bundler save persisted nothing (previous URL kept)',
  config.bundlerUrl === 'https://bundler.example/rpc',
);

await checkRejects(
  'non-http(s) bundler URL is refused before any RPC',
  () => setAaBundlerUrl(EVM_CHAIN_ID, 'ftp://x', { store }),
  'http(s)',
);

const verification = await setAaFactory(EVM_CHAIN_ID, FACTORY_INPUT, 'https://node.example', {
  store,
  transportFor: () => fakeNode(),
});
config = await getAaConfig(EVM_CHAIN_ID, store);
check(
  'factory saves after all three on-chain checks pass',
  config.factory !== null && isAaConfigured(config),
);
check(
  'stored factory matches the input (EIP-55 normalized form)',
  typeof config.factory === 'string' && same(config.factory, FACTORY_INPUT),
  config.factory,
);
check(
  'implementation address recorded for the status line',
  same(verification.implementation, IMPL) &&
    same(config.factoryImplementation, IMPL),
);

// Reject cases run against a separate store: each must persist nothing.
const rejectStore = memoryStore();
await checkRejects(
  'factory with no code is refused (check 1)',
  () =>
    setAaFactory(EVM_CHAIN_ID, FACTORY_INPUT, 'https://node.example', {
      store: rejectStore,
      transportFor: () => fakeNode({ factoryHasCode: false }),
    }),
  'has no code on this chain',
);
await checkRejects(
  'implementation with no code is refused (check 2)',
  () =>
    setAaFactory(EVM_CHAIN_ID, FACTORY_INPUT, 'https://node.example', {
      store: rejectStore,
      transportFor: () => fakeNode({ implHasCode: false }),
    }),
  'has no code',
);
await checkRejects(
  'implementation with the wrong entryPoint() is refused (check 3)',
  () =>
    setAaFactory(EVM_CHAIN_ID, FACTORY_INPUT, 'https://node.example', {
      store: rejectStore,
      transportFor: () => fakeNode({ entryPoint: '0x' + '88'.repeat(20) }),
    }),
  'expected v0.7',
);
await checkRejects(
  'factory address with a bad EIP-55 checksum is refused before any RPC',
  () =>
    setAaFactory(
      EVM_CHAIN_ID,
      // USDC's address with the last-but-one character's case flipped —
      // the same known-bad checksum fixture check-tokens.mjs uses.
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48',
      'https://node.example',
      { store: rejectStore, transportFor: () => fakeNode() },
    ),
  'checksum',
);
const rejected = await getAaConfig(EVM_CHAIN_ID, rejectStore);
check(
  'every refused factory save persisted nothing',
  rejected.factory === null && rejected.factoryImplementation === null,
);

// verifyAaFactory is also callable standalone (Settings uses it via setAaFactory).
const standalone = await verifyAaFactory(fakeNode(), FACTORY_INPUT);
check('standalone verifyAaFactory returns the implementation', same(standalone.implementation, IMPL));

await clearAaFactory(EVM_CHAIN_ID, store);
await clearAaBundlerUrl(EVM_CHAIN_ID, store);
config = await getAaConfig(EVM_CHAIN_ID, store);
check(
  'clear removes both fields and their verification records',
  config.bundlerUrl === null && config.factory === null && !isAaConfigured(config),
);

const corrupt = { getItem: async () => '{not json', setItem: async () => {} };
const fromCorrupt = await getAaConfig(EVM_CHAIN_ID, corrupt);
check('corrupt storage behaves as unconfigured', !isAaConfigured(fromCorrupt));

// ---------------------------------------------------------------------------
// 2. Counterfactual resolution + quote through the bundler estimate
// ---------------------------------------------------------------------------

console.log('\nQuote (counterfactual address, deployment state, bundler fee):');

const owner = ownerAccount();
const AMOUNT = 123_456_789n;

function makeBundle(nodeOptions = {}, bundlerOptions = {}) {
  const node = fakeNode(nodeOptions);
  const bundler = fakeBundler(bundlerOptions);
  const bundle = createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: FACTORY_INPUT,
    transportFor: (url) => (url === 'https://node.example' ? node : bundler),
  });
  return { bundle, node, bundler };
}

const { bundle, bundler } = makeBundle();
const quote = await prepareAaSend(bundle, owner.address, RECIPIENT, AMOUNT);
check(
  "sender resolved via the spec's getAddress (factory view call)",
  same(quote.sender, SENDER),
  quote.sender,
);
check('undeployed account reported as "will deploy"', quote.deployed === false);
check('smart-account balance read (1 ETH fake)', quote.senderBalance === 10n ** 18n);
const gasTotal = 0x111n + 0x222n + 0x333n;
check(
  'fee = (callGas + verificationGas + preVerificationGas) × maxFeePerGas',
  quote.fee === gasTotal * quote.maxFeePerGas && quote.maxFeePerGas === 3_000_000_000n,
  `fee=${quote.fee} maxFeePerGas=${quote.maxFeePerGas}`,
);
check('total = amount + fee', quote.total === AMOUNT + quote.fee);
check(
  'estimation went to the bundler transport (eth_estimateUserOperationGas)',
  bundler.calls.some((c) => c.method === 'eth_estimateUserOperationGas'),
);

await checkRejects(
  'quote refuses a node endpoint on the wrong chain',
  async () => {
    const { bundle: wrongChain } = makeBundle({ chainId: '0xaa36a7' });
    return prepareAaSend(wrongChain, owner.address, RECIPIENT, AMOUNT);
  },
  'Endpoint is chain id',
);

await checkRejects(
  'quote refuses when the SMART ACCOUNT balance cannot cover amount + fee',
  async () => {
    const { bundle: poor } = makeBundle({ senderBalance: 1000n });
    return prepareAaSend(poor, owner.address, RECIPIENT, AMOUNT);
  },
  'smart account pays its own gas',
);

// ---------------------------------------------------------------------------
// 3. Full pipeline: stub -> estimate -> sign -> send -> receipt
// ---------------------------------------------------------------------------

console.log('\nSend pipeline (SmartAccountClient.sendCalls with fakes, offline):');

const specReceipt = {
  userOpHash: USEROP_HASH,
  success: true,
  receipt: { transactionHash: TX_HASH, blockNumber: '0x1' },
};
const { bundle: sendBundle, bundler: sendBundlerT } = makeBundle(
  {},
  { receipt: specReceipt, receiptAfterPolls: 2 },
);
const sendQuote = await prepareAaSend(sendBundle, owner.address, RECIPIENT, AMOUNT);
const { userOpHash } = await sendAa(sendBundle, owner, sendQuote);
check('sendCalls returns the bundler-issued userOpHash', userOpHash === USEROP_HASH);

const op = sendBundlerT.lastOp;
check('submitted op sender is the counterfactual account', same(op.sender, SENDER));
check('undeployed send carries factory + factoryData', same(op.factory, FACTORY_INPUT) && typeof op.factoryData === 'string' && op.factoryData.length > 2);
check('nonce came from EntryPoint.getNonce (0x7)', op.nonce === '0x7');
check(
  'signature is 65 bytes and not the stub',
  typeof op.signature === 'string' &&
    op.signature.length === 132 &&
    op.signature !== '0x' + '01'.repeat(64) + '1b',
);
const bundlerOrder = sendBundlerT.calls.map((c) => c.method);
check(
  'bundler saw estimate before send (stub -> estimate -> sign -> send)',
  bundlerOrder.indexOf('eth_estimateUserOperationGas') <
    bundlerOrder.indexOf('eth_sendUserOperation'),
  JSON.stringify(bundlerOrder),
);

const { summary } = await waitForAaReceipt(sendBundle, userOpHash, {
  timeoutMs: 5000,
  pollMs: 1,
});
check('receipt poll waited through null polls and found the receipt', summary.txHash === TX_HASH);
check('receipt success flag surfaced', summary.success === true);

// ---------------------------------------------------------------------------
// 4. Defensive receipt summarizer (bundler-dependent shapes)
// ---------------------------------------------------------------------------

console.log('\nReceipt-shape handling (never fabricate):');

check(
  'spec shape: nested receipt.transactionHash + boolean success',
  (() => {
    const s = summarizeAaReceipt(specReceipt);
    return s.txHash === TX_HASH && s.success === true;
  })(),
);
check(
  'hex success "0x1"/"0x0" maps to true/false',
  summarizeAaReceipt({ success: '0x1' }).success === true &&
    summarizeAaReceipt({ success: '0x0' }).success === false,
);
check(
  'flattened top-level transactionHash is accepted',
  summarizeAaReceipt({ transactionHash: TX_HASH }).txHash === TX_HASH,
);
check(
  'malformed hash (too short) yields null, not a guess',
  summarizeAaReceipt({ receipt: { transactionHash: '0x1234' } }).txHash === null,
);
check(
  'unknown shapes yield all-null',
  (() => {
    const a = summarizeAaReceipt(null);
    const b = summarizeAaReceipt('0xnothing');
    const c = summarizeAaReceipt({ weird: true, success: 'yes' });
    return (
      a.txHash === null && a.success === null &&
      b.txHash === null && b.success === null &&
      c.txHash === null && c.success === null
    );
  })(),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

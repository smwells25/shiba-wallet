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
  applyPriorityFeeFloor,
  bundlerPriorityFeeFloor,
  maskUrlForDisplay,
  clearAaBundlerUrl,
  clearAaFactory,
  clearAaPaymaster,
  maxAaSend,
  setAaPaymaster,
  verifyAaPaymaster,
  paymasterProbeTransport,
  createAaClient,
  getAaConfig,
  isAaConfigured,
  hasCompleteAaSettings,
  prepareAaSend,
  sendAa,
  setAaBundlerUrl,
  setAaFactory,
  setAaKernelFactory,
  summarizeAaReceipt,
  verifyAaFactory,
  waitForAaReceipt,
} from '../src/wallet/aa.ts';
import { EVM_CHAIN_ID } from '../src/wallet/send.ts';
import { EVM_SEPOLIA } from '../src/config/evm-chain.ts';

// Smart accounts and paymasters are 'testnet-only' in the mainnet readiness
// table (src/config/readiness.ts, phase 9 item 6), so the configuration
// store is exercised under the Sepolia key, where they are allowed. The
// mainnet refusals are checked at the end of this file and in
// check-readiness.mjs.
const AA_CHAIN = EVM_SEPOLIA.caip2;

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
const fresh = await getAaConfig(AA_CHAIN, store);
check(
  'fresh store: everything null, not configured',
  fresh.bundlerUrl === null &&
    fresh.factory === null &&
    fresh.factoryImplementation === null &&
    !isAaConfigured(fresh),
);

const goodBundler = fakeBundler();
const supported = await setAaBundlerUrl(AA_CHAIN, ' https://bundler.example/rpc/ ', {
  store,
  transportFor: () => goodBundler,
});
check(
  'bundler URL saves after eth_supportedEntryPoints includes v0.7',
  supported.length === 1 && supported[0] === ENTRYPOINT_V07,
);
let config = await getAaConfig(AA_CHAIN, store);
check(
  'saved bundler URL is trimmed of whitespace and trailing slashes',
  config.bundlerUrl === 'https://bundler.example/rpc',
  config.bundlerUrl,
);
check('bundler verification timestamp recorded', typeof config.bundlerVerifiedAt === 'string');

await checkRejects(
  'bundler without v0.7 support is refused',
  () =>
    setAaBundlerUrl(AA_CHAIN, 'https://bad.example', {
      store,
      transportFor: () => fakeBundler({ supported: ['0x' + '99'.repeat(20)] }),
    }),
  'does not support EntryPoint v0.7',
);
config = await getAaConfig(AA_CHAIN, store);
check(
  'failed bundler save persisted nothing (previous URL kept)',
  config.bundlerUrl === 'https://bundler.example/rpc',
);

await checkRejects(
  'non-http(s) bundler URL is refused before any RPC',
  () => setAaBundlerUrl(AA_CHAIN, 'ftp://x', { store }),
  'Endpoints must use https://',
);

// Plain http:// endpoints (not loopback) are refused before any transport
// is built, so an API key in the URL never travels in clear text and the
// stored configuration is unchanged.
{
  const HTTPS_SENTENCE = 'Endpoints must use https:// (plain http:// is accepted only for localhost or 10.0.2.2 during development).';
  let transportsBuilt = 0;
  const counting = () => {
    transportsBuilt += 1;
    return fakeBundler();
  };
  await checkRejects(
    'plain http:// bundler URL is refused with the https sentence',
    () => setAaBundlerUrl(AA_CHAIN, 'http://bundler.example/rpc', { store, transportFor: counting }),
    HTTPS_SENTENCE,
  );
  await checkRejects(
    'plain http:// private-network bundler (192.168.x.x) is refused too',
    () => setAaBundlerUrl(AA_CHAIN, 'http://192.168.1.20:4337', { store, transportFor: counting }),
    HTTPS_SENTENCE,
  );
  await checkRejects(
    'plain http:// node URL for the SimpleAccount factory check is refused',
    () => setAaFactory(AA_CHAIN, FACTORY_INPUT, 'http://node.example', { store, transportFor: counting }),
    HTTPS_SENTENCE,
  );
  await checkRejects(
    'plain http:// node URL for the Kernel factory check is refused',
    () => setAaKernelFactory(AA_CHAIN, '0x2577507b78c2008Ff367261CB6285d44ba5eF2E9', 'http://node.example', { store, transportFor: counting }),
    HTTPS_SENTENCE,
  );
  check('http refusals built no transport (no request was possible)', transportsBuilt === 0);
  const unchanged = await getAaConfig(AA_CHAIN, store);
  check(
    'http refusals persisted nothing (previous bundler URL kept)',
    unchanged.bundlerUrl === 'https://bundler.example/rpc' && unchanged.factory === null,
  );

  // Loopback development exception: a local bundler over http:// on ::1.
  const loopStore = memoryStore();
  await setAaBundlerUrl(AA_CHAIN, 'http://[::1]:4337/', { store: loopStore, transportFor: () => fakeBundler() });
  check(
    'loopback http://[::1] bundler accepted after verification',
    (await getAaConfig(AA_CHAIN, loopStore)).bundlerUrl === 'http://[::1]:4337',
  );
}

const verification = await setAaFactory(AA_CHAIN, FACTORY_INPUT, 'https://node.example', {
  store,
  transportFor: () => fakeNode(),
});
config = await getAaConfig(AA_CHAIN, store);
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
    setAaFactory(AA_CHAIN, FACTORY_INPUT, 'https://node.example', {
      store: rejectStore,
      transportFor: () => fakeNode({ factoryHasCode: false }),
    }),
  'has no code on this chain',
);
await checkRejects(
  'implementation with no code is refused (check 2)',
  () =>
    setAaFactory(AA_CHAIN, FACTORY_INPUT, 'https://node.example', {
      store: rejectStore,
      transportFor: () => fakeNode({ implHasCode: false }),
    }),
  'has no code',
);
await checkRejects(
  'implementation with the wrong entryPoint() is refused (check 3)',
  () =>
    setAaFactory(AA_CHAIN, FACTORY_INPUT, 'https://node.example', {
      store: rejectStore,
      transportFor: () => fakeNode({ entryPoint: '0x' + '88'.repeat(20) }),
    }),
  'expected v0.7',
);
await checkRejects(
  'factory address with a bad EIP-55 checksum is refused before any RPC',
  () =>
    setAaFactory(
      AA_CHAIN,
      // USDC's address with the last-but-one character's case flipped —
      // the same known-bad checksum fixture check-tokens.mjs uses.
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48',
      'https://node.example',
      { store: rejectStore, transportFor: () => fakeNode() },
    ),
  'checksum',
);
const rejected = await getAaConfig(AA_CHAIN, rejectStore);
check(
  'every refused factory save persisted nothing',
  rejected.factory === null && rejected.factoryImplementation === null,
);

// verifyAaFactory is also callable standalone (Settings uses it via setAaFactory).
const standalone = await verifyAaFactory(fakeNode(), FACTORY_INPUT);
check('standalone verifyAaFactory returns the implementation', same(standalone.implementation, IMPL));

await clearAaFactory(AA_CHAIN, store);
await clearAaBundlerUrl(AA_CHAIN, store);
config = await getAaConfig(AA_CHAIN, store);
check(
  'clear removes both fields and their verification records',
  config.bundlerUrl === null && config.factory === null && !isAaConfigured(config),
);

const corrupt = { getItem: async () => '{not json', setItem: async () => {} };
const fromCorrupt = await getAaConfig(AA_CHAIN, corrupt);
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

// ---------------------------------------------------------------------------
// Phase 5, item 2: ERC-7677 paymaster config + sponsored quotes + AA Max
// ---------------------------------------------------------------------------
console.log('\ncheck-aa: paymaster configuration');
await (async () => {
  const pmStore = memoryStore();
  const okTransport = () => async (method) => {
    if (method === 'pm_getPaymasterStubData') {
      return { paymaster: '0x' + '66'.repeat(20), paymasterData: '0x00' };
    }
    throw new Error(`unexpected ${method}`);
  };
  await setAaPaymaster(AA_CHAIN, 'https://pm.example/rpc/', '{"policyId":"p1"}', {
    store: pmStore,
    transportFor: okTransport,
  });
  const cfg = await getAaConfig(AA_CHAIN, pmStore);
  check('paymaster url saved trimmed', cfg.paymasterUrl === 'https://pm.example/rpc');
  check('paymaster context persisted', cfg.paymasterContext === '{"policyId":"p1"}');
  check('paymaster verify timestamp set', typeof cfg.paymasterVerifiedAt === 'string');

  // A structured policy error still verifies (endpoint speaks 7677).
  const policyErrorTransport = () => async () => {
    throw new Error('RPC error -32521: policy rejected this operation (pm_getPaymasterStubData)');
  };
  await setAaPaymaster(AA_CHAIN, 'https://pm2.example', '', {
    store: pmStore,
    transportFor: policyErrorTransport,
  });
  check('policy-error endpoint accepted', (await getAaConfig(AA_CHAIN, pmStore)).paymasterUrl === 'https://pm2.example');

  // Rejections persist nothing.
  const before = await getAaConfig(AA_CHAIN, pmStore);
  await checkRejects(
    'method-not-found endpoint refused',
    () => setAaPaymaster(AA_CHAIN, 'https://not-pm.example', '', {
      store: pmStore,
      transportFor: () => async () => { throw new Error('RPC error -32601: method not found'); },
    }),
    'not an ERC-7677 paymaster',
  );
  await checkRejects(
    'unreachable endpoint refused',
    () => setAaPaymaster(AA_CHAIN, 'https://down.example', '', {
      store: pmStore,
      transportFor: () => async () => { throw new Error('fetch failed: ECONNREFUSED'); },
    }),
    'unreachable',
  );
  await checkRejects(
    'invalid context JSON refused',
    () => setAaPaymaster(AA_CHAIN, 'https://pm.example', 'not-json', {
      store: pmStore,
      transportFor: okTransport,
    }),
    'valid JSON',
  );
  await checkRejects(
    'non-http url refused',
    () => setAaPaymaster(AA_CHAIN, 'ftp://pm.example', '', { store: pmStore, transportFor: okTransport }),
    'Endpoints must use https://',
  );
  await checkRejects(
    'plain http:// paymaster refused with the https sentence',
    () => setAaPaymaster(AA_CHAIN, 'http://pm.example/rpc', '', { store: pmStore, transportFor: okTransport }),
    'Endpoints must use https:// (plain http:// is accepted only for localhost or 10.0.2.2 during development).',
  );
  const after = await getAaConfig(AA_CHAIN, pmStore);
  check('rejections persisted nothing', after.paymasterUrl === before.paymasterUrl
    && after.paymasterContext === before.paymasterContext);
  // Loopback development exception for a local paymaster.
  await setAaPaymaster(AA_CHAIN, 'http://127.0.0.1:3000', '', { store: pmStore, transportFor: okTransport });
  check(
    'loopback http://127.0.0.1 paymaster accepted after the probe',
    (await getAaConfig(AA_CHAIN, pmStore)).paymasterUrl === 'http://127.0.0.1:3000',
  );

  await clearAaPaymaster(AA_CHAIN, pmStore);
  check('clear removes paymaster config', (await getAaConfig(AA_CHAIN, pmStore)).paymasterUrl === null);

  // verifyAaPaymaster direct accept path.
  let accepted = true;
  try { await verifyAaPaymaster(async () => ({ ok: true }), 1n, null); } catch { accepted = false; }
  check('verify accepts a result response', accepted);
})();

// ---------------------------------------------------------------------------
// Phase 10, item 2: ZeroDev's paymaster refusal shapes (observed live on
// Sepolia 2026-10-02 with scripts/testnet/paymaster-probe.mjs). The project
// RPC answers HTTP 400 with a bare {"error":"<text>"} body, not a JSON-RPC
// error object, both for a policy refusal and for an unknown method. The
// engine's httpTransport hid that body, so a reachable ERC-7677 endpoint was
// reported as "unreachable or not JSON-RPC".
// ---------------------------------------------------------------------------
console.log('\ncheck-aa: paymaster probe transport (ZeroDev refusal shapes)');
await (async () => {
  const ZERODEV_POLICY_REFUSAL =
    'userOp did not match any gas sponsoring policies or (no ERC20 gas token data present)';
  const ZERODEV_UNSUPPORTED = 'Unsupported method: pm_getPaymasterStubData. See available methods at';
  const fakeFetch = (status, body) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (typeof body === 'string') throw new SyntaxError('Unexpected token');
      return body;
    },
  });
  const via = (status, body) => (url) => paymasterProbeTransport(url, fakeFetch(status, body));

  // The transport itself keeps the server's words.
  const policyMessage = await paymasterProbeTransport('https://pm.example', fakeFetch(400, { error: ZERODEV_POLICY_REFUSAL }))(
    'pm_getPaymasterStubData',
    [],
  ).then(() => 'resolved', (e) => e.message);
  check(
    'HTTP 400 bare-string error keeps the policy text verbatim',
    policyMessage === `RPC error (no code): ${ZERODEV_POLICY_REFUSAL} (pm_getPaymasterStubData)`,
    policyMessage,
  );
  const objectMessage = await paymasterProbeTransport(
    'https://pm.example',
    fakeFetch(400, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }),
  )('pm_getPaymasterStubData', []).then(() => 'resolved', (e) => e.message);
  check(
    'HTTP 400 JSON-RPC error object keeps code and message',
    objectMessage === 'RPC error -32601: Method not found (pm_getPaymasterStubData)',
    objectMessage,
  );
  const okResult = await paymasterProbeTransport(
    'https://pm.example',
    fakeFetch(200, { jsonrpc: '2.0', id: 1, result: { paymaster: '0x' + '66'.repeat(20), paymasterData: '0x' } }),
  )('pm_getPaymasterStubData', []);
  check('HTTP 200 result is returned', okResult?.paymaster === '0x' + '66'.repeat(20));

  // Save-time verification with those shapes.
  const store = memoryStore();
  await setAaPaymaster(AA_CHAIN, 'https://zd.example/api/v3/p/chain/11155111', '', {
    store,
    transportFor: via(400, { error: ZERODEV_POLICY_REFUSAL }),
  });
  check(
    'ZeroDev "no matching gas sponsoring policy" refusal is accepted as a structured policy error',
    (await getAaConfig(AA_CHAIN, store)).paymasterUrl === 'https://zd.example/api/v3/p/chain/11155111',
  );
  const before = await getAaConfig(AA_CHAIN, store);
  await checkRejects(
    'ZeroDev "Unsupported method" text (HTTP 400, no code) is refused as not a paymaster',
    () => setAaPaymaster(AA_CHAIN, 'https://zd-bundler-only.example', '', {
      store,
      transportFor: via(400, { error: ZERODEV_UNSUPPORTED }),
    }),
    'not an ERC-7677 paymaster',
  );
  await checkRejects(
    'HTTP 502 with a non-JSON body is still refused as unreachable',
    () => setAaPaymaster(AA_CHAIN, 'https://gateway-down.example', '', {
      store,
      transportFor: via(502, '<html>Bad gateway</html>'),
    }),
    'unreachable',
  );
  await checkRejects(
    'HTTP 200 without a result or error is refused',
    () => setAaPaymaster(AA_CHAIN, 'https://odd.example', '', {
      store,
      transportFor: via(200, { jsonrpc: '2.0', id: 1 }),
    }),
    'unreachable',
  );
  const after = await getAaConfig(AA_CHAIN, store);
  check('refused shapes persisted nothing', after.paymasterUrl === before.paymasterUrl);

  // The DEFAULT transport (no transportFor) is the body-preserving one: with
  // httpTransport this exact answer was refused as "unreachable".
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(400, { error: ZERODEV_POLICY_REFUSAL });
  try {
    const defaultStore = memoryStore();
    await setAaPaymaster(AA_CHAIN, 'https://zd-default.example', '', { store: defaultStore });
    check(
      'setAaPaymaster default transport accepts the ZeroDev policy refusal',
      (await getAaConfig(AA_CHAIN, defaultStore)).paymasterUrl === 'https://zd-default.example',
    );
  } catch (e) {
    check('setAaPaymaster default transport accepts the ZeroDev policy refusal', false, e.message);
  } finally {
    globalThis.fetch = realFetch;
  }
})();

console.log('\ncheck-aa: sponsored quote, pipeline, and AA Max');
await (async () => {
  const FACTORY = '0x' + '55'.repeat(20);
  const SENDER_WORD = '0x' + '00'.repeat(12) + 'ab'.repeat(20);
  const pmCalls = [];
  const transportFor = (url) => async (method, params) => {
    if (url.includes('pm.example')) {
      pmCalls.push(method);
      if (method === 'pm_getPaymasterStubData' || method === 'pm_getPaymasterData') {
        return { paymaster: '0x' + '66'.repeat(20), paymasterData: '0x01' };
      }
      throw new Error(`unexpected pm ${method}`);
    }
    if (url.includes('bundler')) {
      if (method === 'eth_supportedEntryPoints') return [ENTRYPOINT_V07];
      if (method === 'eth_estimateUserOperationGas') {
        return { callGasLimit: '0x100', verificationGasLimit: '0x200', preVerificationGas: '0x300' };
      }
      if (method === 'eth_sendUserOperation') return '0x' + 'ab'.repeat(32);
      throw new Error(`unexpected bundler ${method}`);
    }
    // node
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getCode') return '0x6001';
    if (method === 'eth_call') {
      const to = params[0].to;
      if (to === FACTORY) return SENDER_WORD;
      return '0x2'; // EntryPoint.getNonce
    }
    if (method === 'eth_getBalance') return '0xde0b6b3a7640000'; // 1 ETH
    if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x3b9aca00' };
    if (method === 'eth_maxPriorityFeePerGas') return '0x5f5e100';
    throw new Error(`unexpected node ${method}`);
  };

  const sponsored = createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: FACTORY,
    chainId: 1n,
    transportFor,
    paymaster: { url: 'https://pm.example', contextJson: '{"policyId":"p1"}' },
  });
  check('bundle reports sponsorship', sponsored.sponsored === true);

  const quote = await prepareAaSend(sponsored, '0x' + '11'.repeat(20), '0x' + '22'.repeat(20), 10n ** 17n);
  check('sponsored quote has zero user fee', quote.fee === 0n && quote.sponsored === true);
  check('sponsored total equals the amount', quote.total === 10n ** 17n);

  // Nearly the whole balance passes under sponsorship (fee not charged).
  const bigAmount = 10n ** 18n; // exactly the balance
  const bigQuote = await prepareAaSend(sponsored, '0x' + '11'.repeat(20), '0x' + '22'.repeat(20), bigAmount);
  check('sponsored balance check is amount-only', bigQuote.total === bigAmount);

  const maxSponsored = await maxAaSend(sponsored, '0x' + '11'.repeat(20), '0x' + '22'.repeat(20));
  check('sponsored max = full balance', maxSponsored === 10n ** 18n);

  const selfPaid = createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: FACTORY,
    chainId: 1n,
    transportFor,
  });
  const maxSelf = await maxAaSend(selfPaid, '0x' + '11'.repeat(20), '0x' + '22'.repeat(20));
  // This fake node answers every EntryPoint eth_call with 0x2, so the
  // EntryPoint deposit reads as 2 wei: the account must top up its deposit
  // during validation and the quote carries aa.ts's
  // AA_DEPOSIT_TOPUP_VERIFICATION_GAS (40,000) on the verification limit.
  const gasTotal = 0x100n + 0x200n + 40_000n + 0x300n;
  const worst = gasTotal * (2n * 1_000_000_000n + 100_000_000n);
  check('self-paid max = balance minus worst-case fee', maxSelf === 10n ** 18n - worst);

  // Sponsored pipeline: the engine's two-phase 7677 flow must hit the
  // paymaster transport before and after estimation.
  const seedOwner = (() => {
    const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    return evmKeyProvider.deriveAccount(seed, 0, 0);
  })();
  pmCalls.length = 0;
  await sendAa(sponsored, seedOwner, quote);
  check('pipeline called stub then final paymaster data',
    pmCalls[0] === 'pm_getPaymasterStubData' && pmCalls.includes('pm_getPaymasterData'));

  // Bundler priority-fee floor (found live on Sepolia 2026-10-01: the node
  // suggested 0.001 gwei, Alchemy's bundler required 0.1 gwei).
  console.log('\npriority-fee floor');
  const low = { maxFeePerGas: 2_001_000_000n, maxPriorityFeePerGas: 1_000_000n };
  check('no floor leaves fees unchanged', applyPriorityFeeFloor(low, null) === low);
  check('floor below suggestion leaves fees unchanged',
    applyPriorityFeeFloor(low, 500_000n) === low);
  const raised = applyPriorityFeeFloor(low, 100_000_000n);
  check('floor above suggestion raises the priority fee to the floor',
    raised.maxPriorityFeePerGas === 100_000_000n);
  check('raising the priority fee raises maxFeePerGas by the same amount (base allowance kept)',
    raised.maxFeePerGas === 2_001_000_000n + 99_000_000n);
  check('floor from a bundler that serves rundler_maxPriorityFeePerGas',
    (await bundlerPriorityFeeFloor(async (m) => (m === 'rundler_maxPriorityFeePerGas' ? '0x5f5e100' : null)))
      === 100_000_000n);
  check('no floor from a bundler that rejects the method',
    (await bundlerPriorityFeeFloor(async () => { throw new Error('method not found'); })) === null);
  check('no floor from a malformed answer',
    (await bundlerPriorityFeeFloor(async () => 'not-hex')) === null);
  check('floor from a Pimlico-compatible bundler (standard tier) when rundler is absent',
    (await bundlerPriorityFeeFloor(async (m) => {
      if (m === 'rundler_maxPriorityFeePerGas') throw new Error('-32601');
      if (m === 'pimlico_getUserOperationGasPrice') {
        return { slow: { maxPriorityFeePerGas: '0x1' }, standard: { maxPriorityFeePerGas: '0x119fb8' }, fast: { maxPriorityFeePerGas: '0x2' } };
      }
      return null;
    })) === 0x119fb8n);
  check('rundler answer wins when both are served',
    (await bundlerPriorityFeeFloor(async (m) =>
      m === 'rundler_maxPriorityFeePerGas' ? '0x5f5e100' : { standard: { maxPriorityFeePerGas: '0x1' } },
    )) === 100_000_000n);
  check('malformed Pimlico tier yields no floor',
    (await bundlerPriorityFeeFloor(async (m) =>
      m === 'rundler_maxPriorityFeePerGas' ? null : { standard: { maxPriorityFeePerGas: 12 } },
    )) === null);
  check('the existing fake bundler (no such method) leaves the quote on the node suggestion',
    quote.maxPriorityFeePerGas === 100_000_000n);

  // Stored endpoint URLs embed API keys; Settings must never render them.
  console.log('\nstored URL display masking');
  check('path key is elided', maskUrlForDisplay('https://eth-sepolia.g.alchemy.com/v2/SECRETKEY123')
    === 'https://eth-sepolia.g.alchemy.com/…');
  check('query key is elided', maskUrlForDisplay('https://rpc.example.com/?apikey=SECRET')
    === 'https://rpc.example.com/?…');
  check('bare host unchanged', maskUrlForDisplay('https://rpc.example.com') === 'https://rpc.example.com');
  check('port kept', maskUrlForDisplay('http://10.0.2.2:8545/key') === 'http://10.0.2.2:8545/…');
  check('non-URL values untouched', maskUrlForDisplay('0x2577507b78c2008Ff367261CB6285d44ba5eF2E9')
    === '0x2577507b78c2008Ff367261CB6285d44ba5eF2E9');
  check('malformed URL still never leaks past the host',
    maskUrlForDisplay('https://host.example/%%%SECRET') === 'https://host.example/…');
})();

// ---------------------------------------------------------------------------
// Phase 9 item 6: mainnet readiness refusals (persist nothing, no request)
// ---------------------------------------------------------------------------
console.log('\ncheck-aa: mainnet readiness gate');
await (async () => {
  const gateStore = memoryStore();
  let requests = 0;
  const counting = () => async () => {
    requests += 1;
    throw new Error('no request expected');
  };
  await checkRejects(
    'mainnet bundler save refused with the readiness reason',
    () => setAaBundlerUrl(EVM_CHAIN_ID, 'https://bundler.example/rpc', { store: gateStore, transportFor: counting }),
    'only on test networks',
  );
  await checkRejects(
    'mainnet SimpleAccount factory save refused',
    () => setAaFactory(EVM_CHAIN_ID, FACTORY_INPUT, 'https://node.example', { store: gateStore, transportFor: counting }),
    'only on test networks',
  );
  await checkRejects(
    'mainnet paymaster save refused',
    () => setAaPaymaster(EVM_CHAIN_ID, 'https://pm.example', '', { store: gateStore, transportFor: counting }),
    'Turn on Sepolia test mode',
  );
  const after = await getAaConfig(EVM_CHAIN_ID, gateStore);
  check(
    'mainnet refusals persisted nothing and made no request',
    after.bundlerUrl === null && after.factory === null && after.paymasterUrl === null && requests === 0,
  );
  // A complete Sepolia configuration copied under the mainnet key (as if
  // saved before the gate existed) still reads as NOT configured there.
  const sepCfg = await getAaConfig(AA_CHAIN, store);
  check('getAaConfig records the chain it was read for', sepCfg.chain === AA_CHAIN && after.chain === EVM_CHAIN_ID);
  const legacyMainnet = memoryStore();
  await legacyMainnet.setItem(
    'shiba-wallet.aa-config.v1',
    JSON.stringify({
      [EVM_CHAIN_ID]: {
        bundlerUrl: 'https://bundler.example/rpc',
        bundlerVerifiedAt: 'x',
        factory: FACTORY_INPUT,
        factoryImplementation: IMPL,
        factoryVerifiedAt: 'x',
      },
    }),
  );
  const legacy = await getAaConfig(EVM_CHAIN_ID, legacyMainnet);
  check(
    'a complete mainnet configuration stored before the gate reads as unavailable',
    legacy.bundlerUrl !== null && legacy.factory !== null && !isAaConfigured(legacy) && hasCompleteAaSettings(legacy),
  );
  check('a hand-built configuration without a chain counts as gated', !isAaConfigured({ ...legacy, chain: null }));
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

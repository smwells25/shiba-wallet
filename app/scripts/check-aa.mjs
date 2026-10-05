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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AA_FUNDING_TITLE,
  aaCanPaySelf,
  aaFeeFromBalance,
  aaMaxAdjustmentSentence,
  prepareAaCalls,
  AA_MAX_TRIM_ROUNDS,
  aaFundingMessage,
  AaFundingError,
  QUOTE_FAILED_TITLE,
  aaSendApprovalPrompt,
  addAaConfigChangedListener,
  bundlerVerifiedLine,
  subscribeAaStateChanges,
  describeAaError,
  retitleQuoteFailure,
  applyPriorityFeeFloor,
  bundlerPriorityFeeFloor,
  bundlerFeeFloor,
  quoteFeesOverFloor,
  withFeeFloorHeadroom,
  feeFloorShortfall,
  signedFeeGuard,
  isBundlerFeeFloorRefusal,
  AaFeeRoseError,
  AA_FEE_ROSE_TITLE,
  AA_GAS_GREW_TITLE,
  AA_REVIEW_AGAIN_TITLE,
  AA_DEPOSIT_NOTE,
  AA_SELF_PAID_FEE_SENTENCE,
  aaSelfPaidFeeSentence,
  checkAaQuoteBeforeApproval,
  AA_FEE_FLOOR_HEADROOM_PERCENT,
  AA_QUOTE_ALREADY_USED,
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
import { EVM_CHAIN_ID, describeSendError } from '../src/wallet/send.ts';
import {
  flushSpendingWrites,
  installSpendingRecorder,
  listSpendRecords,
  saveSpendingPolicy,
} from '../src/wallet/spending-policy.ts';
import { EVM_BASE_SEPOLIA, EVM_SEPOLIA } from '../src/config/evm-chain.ts';

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

// Mutation checks load a deliberately broken copy of an app module. The copy
// lives in a scratch directory next to this script; its relative imports are
// rewritten to absolute file URLs of the real modules, so only the mutated
// file differs. The directory is removed when the script exits.
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MUTANT_DIR = join(dirname(fileURLToPath(import.meta.url)), `.mutants-aa-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(relPath, source) {
  const originalDir = dirname(join(APP_ROOT, relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolve(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
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
  deposit = null, // EntryPoint deposit; null = the read fails (as before)
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
      if (deposit !== null && same(to, ENTRYPOINT_V07) && data.startsWith(sel('balanceOf(address)'))) {
        return '0x' + deposit.toString(16).padStart(64, '0');
      }
      throw new Error(`fake node: unexpected eth_call to ${to} data ${data.slice(0, 10)}`);
    }
    throw new Error(`fake node: unexpected method ${method}`);
  };
  transport.calls = calls;
  return transport;
}

/**
 * Fake bundler transport; records the submitted RpcUserOperation. Answers
 * eth_chainId (ERC-7769) with `chainIdHex` — Sepolia by default, the chain
 * AA_CHAIN saves under; `null` makes it refuse the method like a bundler
 * that does not serve it.
 */
function fakeBundler({
  supported = [ENTRYPOINT_V07],
  receipt = null,
  receiptAfterPolls = 0,
  chainIdHex = '0xaa36a7',
} = {}) {
  const calls = [];
  let polls = 0;
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') {
      if (chainIdHex === null) throw new Error('RPC error -32601: Method not found (eth_chainId)');
      return chainIdHex;
    }
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
check(
  'the saved bundler was asked eth_chainId before eth_supportedEntryPoints',
  goodBundler.calls[0]?.method === 'eth_chainId' && goodBundler.calls[1]?.method === 'eth_supportedEntryPoints',
  JSON.stringify(goodBundler.calls.map((c) => c.method)),
);

// Bundler chain check (ERC-7769 eth_chainId), both directions between the
// two test networks and against mainnet. Every refusal persists nothing.
{
  const BASE = EVM_BASE_SEPOLIA.caip2;
  const chainStore = memoryStore();
  await setAaBundlerUrl(BASE, 'https://bundler.example/base', {
    store: chainStore,
    transportFor: () => fakeBundler({ chainIdHex: '0x14a34' }),
  });
  check('Base Sepolia bundler (eth_chainId 0x14a34) saves under Base Sepolia', (await getAaConfig(BASE, chainStore)).bundlerUrl === 'https://bundler.example/base');
  await checkRejects(
    'Sepolia bundler saved under Base Sepolia is refused with a plain sentence',
    () => setAaBundlerUrl(BASE, 'https://bundler.example/sepolia', { store: chainStore, transportFor: () => fakeBundler({ chainIdHex: '0xaa36a7' }) }),
    'This bundler serves Ethereum Sepolia (chain id 11155111), but you are saving it for Base Sepolia (chain id 84532). Nothing was saved.',
  );
  check('… and Base Sepolia keeps its previous bundler', (await getAaConfig(BASE, chainStore)).bundlerUrl === 'https://bundler.example/base');
  const sepStore = memoryStore();
  await checkRejects(
    'Base Sepolia bundler saved under Ethereum Sepolia is refused',
    () => setAaBundlerUrl(AA_CHAIN, 'https://bundler.example/base', { store: sepStore, transportFor: () => fakeBundler({ chainIdHex: '0x14a34' }) }),
    'This bundler serves Base Sepolia (chain id 84532), but you are saving it for Ethereum Sepolia (chain id 11155111). Nothing was saved.',
  );
  await checkRejects(
    'a mainnet bundler saved under Ethereum Sepolia is refused',
    () => setAaBundlerUrl(AA_CHAIN, 'https://bundler.example/main', { store: sepStore, transportFor: () => fakeBundler({ chainIdHex: '0x1' }) }),
    'This bundler serves Ethereum (chain id 1), but you are saving it for Ethereum Sepolia',
  );
  await checkRejects(
    'a mainnet bundler saved under Base Sepolia is refused, naming the URL to paste',
    () => setAaBundlerUrl(BASE, 'https://bundler.example/main', { store: sepStore, transportFor: () => fakeBundler({ chainIdHex: '0x1' }) }),
    'Paste the bundler URL for Base Sepolia (bundler URLs are per network; for example a ZeroDev URL ends in /chain/84532).',
  );
  await checkRejects(
    'an unknown chain id is named by number',
    () => setAaBundlerUrl(AA_CHAIN, 'https://bundler.example/other', { store: sepStore, transportFor: () => fakeBundler({ chainIdHex: '0x2105' }) }),
    'This bundler serves chain id 8453, but',
  );
  await checkRejects(
    'a bundler that does not answer eth_chainId is refused',
    () => setAaBundlerUrl(AA_CHAIN, 'https://bundler.example/nochain', { store: sepStore, transportFor: () => fakeBundler({ chainIdHex: null }) }),
    'The bundler did not answer eth_chainId, so the wallet cannot confirm which network it serves. Nothing was saved.',
  );
  await checkRejects(
    'a malformed eth_chainId answer is refused',
    () => setAaBundlerUrl(AA_CHAIN, 'https://bundler.example/odd', { store: sepStore, transportFor: () => fakeBundler({ chainIdHex: 'sepolia' }) }),
    'is not a chain id',
  );
  const wrong = fakeBundler({ chainIdHex: '0x14a34' });
  await setAaBundlerUrl(AA_CHAIN, 'https://bundler.example/x', { store: sepStore, transportFor: () => wrong }).catch(() => {});
  check('a chain mismatch stops before eth_supportedEntryPoints', !wrong.calls.some((c) => c.method === 'eth_supportedEntryPoints'));
  const after = await getAaConfig(AA_CHAIN, sepStore);
  check('every chain refusal persisted nothing', after.bundlerUrl === null);
}

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
// Phase 12 item 3: the spending-limit recorder listens through
// addAaSentListener and records only operations the bundler accepted.
const spendMem = new Map();
const spendStore = { getItem: async (k) => spendMem.get(k) ?? null, setItem: async (k, v) => void spendMem.set(k, v) };
const spendScope = { chain: `eip155:${sendBundle.chainId}`, owner: owner.address };
await saveSpendingPolicy(
  spendScope,
  { token: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18, cap: 10n ** 18n, windowSeconds: 86400 },
  [],
  { store: spendStore },
);
const stopSpendRecorder = installSpendingRecorder(spendStore);
// Base Sepolia finding 2: Home's eligibility hooks re-check through
// subscribeAaStateChanges, which must fire on an ACCEPTED operation.
let aaStateChanges = 0;
const stopAaState = subscribeAaStateChanges(() => {
  aaStateChanges += 1;
});
const { userOpHash } = await sendAa(sendBundle, owner, sendQuote);
check('sendCalls returns the bundler-issued userOpHash', userOpHash === USEROP_HASH);
check('subscribeAaStateChanges fired once for the accepted operation', aaStateChanges === 1, String(aaStateChanges));
await new Promise((r) => setTimeout(r, 10));
await flushSpendingWrites();
{
  const records = (await listSpendRecords(spendScope, spendStore)).records;
  check(
    'spending limits: bundler-accepted op recorded (amount + worst-case fee, userOpHash ref)',
    records.some((r) => r.kind === 'transfer' && r.amount === AMOUNT && r.ref === USEROP_HASH) &&
      records.some((r) => r.kind === 'fee' && r.amount === sendQuote.fee),
    JSON.stringify(records, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
  const rejectNode = fakeNode({});
  const acceptingBundler = fakeBundler({});
  const rejectingBundler = async (method, params) => {
    if (method === 'eth_sendUserOperation') throw new Error("RPC error -32500: AA21 didn't pay prefund (eth_sendUserOperation)");
    return acceptingBundler(method, params);
  };
  const rejectBundle = createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: FACTORY_INPUT,
    transportFor: (url) => (url === 'https://node.example' ? rejectNode : rejectingBundler),
  });
  const rejectQuote = await prepareAaSend(rejectBundle, owner.address, RECIPIENT, AMOUNT);
  let refused = false;
  try {
    await sendAa(rejectBundle, owner, rejectQuote);
  } catch {
    refused = true;
  }
  await new Promise((r) => setTimeout(r, 10));
  await flushSpendingWrites();
  check(
    'spending limits: bundler-refused op not recorded',
    refused && (await listSpendRecords(spendScope, spendStore)).records.length === records.length,
  );
  check('subscribeAaStateChanges did not fire for the refused operation', aaStateChanges === 1, String(aaStateChanges));
}
stopSpendRecorder();
stopAaState();

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

  // Send-time fee floor (the 2026-10-04 emulator run: ZeroDev refused a
  // revoke AFTER the biometric prompt with "maxPriorityFeePerGas must be at
  // least 32305086 (current maxPriorityFeePerGas: 29835424)"). Quotes carry
  // AA_FEE_FLOOR_HEADROOM_PERCENT over the floor; sendAa never raises the
  // fees, re-reads the floor before signing and refuses when even the
  // headroom no longer meets it; a quote is submitted at most once.
  console.log('\nsend-time fee floor');
  {
    check('headroom is the stated 25 %', AA_FEE_FLOOR_HEADROOM_PERCENT === 25n);
    check('withFeeFloorHeadroom rounds up exactly (29835424 → 37294280; 3 → 4)',
      withFeeFloorHeadroom(29_835_424n) === 37_294_280n && withFeeFloorHeadroom(3n) === 4n && withFeeFloorHeadroom(100n) === 125n);
    const node = { maxFeePerGas: 2_001_000_000n, maxPriorityFeePerGas: 1_000_000n };
    check('no floor: fees returned unchanged (same object)', quoteFeesOverFloor(node, null) === node);
    const q1 = quoteFeesOverFloor(node, { maxPriorityFeePerGas: 29_835_424n, maxFeePerGas: null });
    check('priority floor + 25 %, base allowance kept on maxFeePerGas',
      q1.maxPriorityFeePerGas === 37_294_280n && q1.maxFeePerGas === 2_001_000_000n + (37_294_280n - 1_000_000n));
    const high = { maxFeePerGas: 9_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };
    check('a suggestion already above floor + 25 % is unchanged (same object)',
      quoteFeesOverFloor(high, { maxPriorityFeePerGas: 1_600_000_000n, maxFeePerGas: 7_200_000_000n }) === high);
    const q2 = quoteFeesOverFloor(node, { maxPriorityFeePerGas: 1n, maxFeePerGas: 4_000_000_000n });
    check('an Alto-style maxFeePerGas minimum is met with the same headroom', q2.maxFeePerGas === 5_000_000_000n && q2.maxPriorityFeePerGas === 1_000_000n);
    check('the observed refusal is a shortfall (floor 32305086 above the quoted 29835424)',
      /at least 32305086 wei .* above the 29835424 wei/.test(
        feeFloorShortfall({ maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 29_835_424n }, { maxPriorityFeePerGas: 32_305_086n, maxFeePerGas: null }) ?? ''));
    check('…and with the headroom quote it is not (8 % drift fits in 25 %)',
      feeFloorShortfall(quoteFeesOverFloor(node, { maxPriorityFeePerGas: 29_835_424n, maxFeePerGas: null }), { maxPriorityFeePerGas: 32_305_086n, maxFeePerGas: null }) === null);
    check('a floor exactly at the quoted fee passes; one wei above does not',
      feeFloorShortfall(q1, { maxPriorityFeePerGas: q1.maxPriorityFeePerGas, maxFeePerGas: q1.maxFeePerGas }) === null &&
        feeFloorShortfall(q1, { maxPriorityFeePerGas: q1.maxPriorityFeePerGas + 1n, maxFeePerGas: null }) !== null &&
        feeFloorShortfall(q1, { maxPriorityFeePerGas: 1n, maxFeePerGas: q1.maxFeePerGas + 1n }) !== null);
    check('unknown floor: no shortfall', feeFloorShortfall(q1, null) === null);
    const pim = await bundlerFeeFloor(async (m) => {
      if (m === 'rundler_maxPriorityFeePerGas') throw new Error('-32601');
      return { standard: { maxPriorityFeePerGas: '0x1ecf4a8', maxFeePerGas: '0x77359400' } };
    });
    check('bundlerFeeFloor reads both standard-tier fees (Pimlico style)', pim?.maxPriorityFeePerGas === 0x1ecf4a8n && pim?.maxFeePerGas === 2_000_000_000n);
    const pimNoMax = await bundlerFeeFloor(async (m) => (m === 'rundler_maxPriorityFeePerGas' ? null : { standard: { maxPriorityFeePerGas: '0x10', maxFeePerGas: 7 } }));
    check('a malformed maxFeePerGas leaves only that half unknown', pimNoMax?.maxPriorityFeePerGas === 16n && pimNoMax?.maxFeePerGas === null);
    const run = await bundlerFeeFloor(async (m) => (m === 'rundler_maxPriorityFeePerGas' ? '0x5f5e100' : null));
    check('Rundler: priority floor only', run?.maxPriorityFeePerGas === 100_000_000n && run?.maxFeePerGas === null);
    check('isBundlerFeeFloorRefusal: Alto priority + max-fee texts and Rundler text; not other errors',
      isBundlerFeeFloorRefusal('RPC error -32602: maxPriorityFeePerGas must be at least 32305086 (current maxPriorityFeePerGas: 29835424) - use pimlico_getUserOperationGasPrice to get the current gas price (eth_sendUserOperation)') &&
        isBundlerFeeFloorRefusal('maxFeePerGas must be at least 5 (current maxFeePerGas: 4)') &&
        isBundlerFeeFloorRefusal('precheck failed: maxPriorityFeePerGas is 1000000 but must be at least 100000000') &&
        !isBundlerFeeFloorRefusal("RPC error -32500: AA21 didn't pay prefund"));
    const raw = describeAaError(new Error('RPC error -32602: maxPriorityFeePerGas must be at least 32305086 (current maxPriorityFeePerGas: 29835424) - use pimlico_getUserOperationGasPrice to get the current gas price (eth_sendUserOperation)'), { accountType: 'kernel-v3.3', deployed: true });
    check('describeAaError: a bundler floor refusal gets the "review again" title and keeps the bundler text',
      raw?.title === AA_FEE_ROSE_TITLE && /must be at least 32305086/.test(raw.detail) && /Review it again/.test(raw.detail));

    // A bundler whose floor (Pimlico style) and estimate can move between
    // the quote and the send, around the module's fake bundler.
    function movingBundler() {
      const base = fakeBundler({});
      const state = { priority: 29_835_424n, maxFee: null, estimate: null };
      const t = async (method, params) => {
        if (method === 'rundler_maxPriorityFeePerGas') throw new Error('RPC error -32601: method not found');
        if (method === 'pimlico_getUserOperationGasPrice') {
          base.calls.push({ method, params });
          return { standard: { maxPriorityFeePerGas: '0x' + state.priority.toString(16), ...(state.maxFee !== null ? { maxFeePerGas: '0x' + state.maxFee.toString(16) } : {}) } };
        }
        if (method === 'eth_estimateUserOperationGas' && state.estimate) {
          base.calls.push({ method, params });
          return state.estimate;
        }
        return base(method, params);
      };
      t.state = state;
      t.base = base;
      return t;
    }
    function movingBundle(nodeOptions = {}) {
      const mb = movingBundler();
      const n = fakeNode(nodeOptions);
      const b = createAaClient({
        nodeUrl: 'https://node.example',
        bundlerUrl: 'https://bundler.example',
        factory: FACTORY_INPUT,
        transportFor: (url) => (url === 'https://node.example' ? n : mb),
      });
      return { b, mb };
    }
    const sent = (mb) => mb.base.calls.filter((c) => c.method === 'eth_sendUserOperation').length;

    // Within the headroom: signed with exactly the quoted fees.
    {
      const { b, mb } = movingBundle();
      const qq = await prepareAaSend(b, owner.address, RECIPIENT, AMOUNT);
      check('quote: priority = floor + 25 % (the node suggested 1 gwei, so the floor applies only when higher)',
        qq.maxPriorityFeePerGas === 1_000_000_000n && qq.maxFeePerGas === 3_000_000_000n);
      mb.state.priority = 1_000_000_001n; // the floor now sits above the quoted priority
      const estimatesBefore = mb.base.calls.filter((c) => c.method === 'eth_estimateUserOperationGas').length;
      const r = await sendAa(b, owner, qq).then(() => null, (e) => e);
      check('floor above the quoted priority at send time → AaFeeRoseError, nothing estimated or sent',
        r instanceof AaFeeRoseError && sent(mb) === 0 &&
          mb.base.calls.filter((c) => c.method === 'eth_estimateUserOperationGas').length === estimatesBefore);
      check('…describeAaError gives the fee-rose title', describeAaError(r, { accountType: 'simple', deployed: false })?.title === AA_FEE_ROSE_TITLE);
      mb.state.priority = 29_835_424n;
      const again = await sendAa(b, owner, qq).then(() => null, (e) => e);
      check('the same quote cannot be re-sent after the refusal (the screen must re-quote)', again?.message === AA_QUOTE_ALREADY_USED && sent(mb) === 0);
    }
    {
      const { b, mb } = movingBundle();
      mb.state.priority = 2_000_000_000n; // floor above the node's 1 gwei suggestion
      const qq = await prepareAaSend(b, owner.address, RECIPIENT, AMOUNT);
      check('quote with a floor above the suggestion: priority 2.5 gwei, maxFee 3 gwei + 1.5 gwei',
        qq.maxPriorityFeePerGas === 2_500_000_000n && qq.maxFeePerGas === 4_500_000_000n);
      check('the displayed worst case is priced at those fees', qq.fee === (0x111n + 0x222n + 0x333n) * 4_500_000_000n);
      mb.state.priority = 2_160_000_000n; // +8 %, as observed live
      await sendAa(b, owner, qq);
      const op = mb.base.lastOp;
      check('8 % floor drift: sent, signed with EXACTLY the quoted fees (never raised)',
        sent(mb) === 1 && BigInt(op.maxPriorityFeePerGas) === qq.maxPriorityFeePerGas && BigInt(op.maxFeePerGas) === qq.maxFeePerGas);
      check('the signed worst case equals the displayed one',
        (BigInt(op.callGasLimit) + BigInt(op.verificationGasLimit) + BigInt(op.preVerificationGas)) * BigInt(op.maxFeePerGas) === qq.fee);
    }
    {
      const { b, mb } = movingBundle();
      mb.state.priority = 2_000_000_000n;
      const qq = await prepareAaSend(b, owner.address, RECIPIENT, AMOUNT);
      mb.state.priority = 2_500_000_001n; // one wei above the quoted priority
      const r = await sendAa(b, owner, qq).then(() => null, (e) => e);
      check('one wei above the quoted priority → refused before signing', r instanceof AaFeeRoseError && sent(mb) === 0);
    }
    {
      const { b, mb } = movingBundle();
      mb.state.maxFee = 3_000_000_000n;
      const qq = await prepareAaSend(b, owner.address, RECIPIENT, AMOUNT);
      check('an Alto maxFeePerGas floor raises the quoted maxFeePerGas by 25 %', qq.maxFeePerGas === 3_750_000_000n);
      mb.state.maxFee = 3_750_000_001n;
      const r = await sendAa(b, owner, qq).then(() => null, (e) => e);
      check('a maxFeePerGas floor above the quoted one at send → refused, nothing sent', r instanceof AaFeeRoseError && /maximum fee/.test(r.message) && sent(mb) === 0);
    }
    {
      // The client re-estimates at send: a larger estimate must not be signed.
      const { b, mb } = movingBundle();
      const qq = await prepareAaSend(b, owner.address, RECIPIENT, AMOUNT);
      mb.state.estimate = { callGasLimit: '0x111', verificationGasLimit: '0x222', preVerificationGas: '0x334' };
      const r = await sendAa(b, owner, qq).then(() => null, (e) => e);
      check('re-estimate one gas higher than the quote → AaFeeRoseError before signing, nothing sent',
        r instanceof AaFeeRoseError && /fresh gas estimate/.test(r.message) && sent(mb) === 0);
      const { b: b2, mb: mb2 } = movingBundle();
      const q2b = await prepareAaSend(b2, owner.address, RECIPIENT, AMOUNT);
      mb2.state.estimate = { callGasLimit: '0x110', verificationGasLimit: '0x222', preVerificationGas: '0x333' };
      await sendAa(b2, owner, q2b);
      check('a lower re-estimate is signed (worst case below the displayed one)', sent(mb2) === 1);
    }
    check('signedFeeGuard ignores paymaster operations (sponsored / USDC fee are capped elsewhere)',
      (() => {
        try {
          signedFeeGuard({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, 0n)({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, callGasLimit: 10n, verificationGasLimit: 10n, preVerificationGas: 10n, paymaster: '0x' + '11'.repeat(20) });
          return true;
        } catch {
          return false;
        }
      })());
    check('signedFeeGuard refuses fees that differ from the quote',
      (() => {
        try {
          signedFeeGuard({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }, 10n ** 18n)({ maxFeePerGas: 3n, maxPriorityFeePerGas: 1n, callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n });
          return false;
        } catch (e) {
          return e instanceof AaFeeRoseError;
        }
      })());
  }

  // The 2026-10-04 private-key run (commit 44eef11): two smart-account sends
  // were refused AFTER the biometric prompt with "The network fee rose".
  // The refusal text compared the bundler's NEW standard-tier price with
  // the QUOTED fee, which already carried the 25 % headroom (the quoted
  // priority fees 108460172 and 67431797 are ceil(1.25 × 86768137) and
  // ceil(1.25 × 53945437)), so the standard tier had risen by 40.0 % and
  // 26.3 % since the quote — past the headroom, not +12 % and +1 % as the
  // two printed numbers suggested. Read-only probes of the same bundler the
  // same evening showed that tier jumping with almost every block (aa.ts
  // bundlerFeeFloor). The fixes checked here: the send-time comparison uses
  // the bundler's LOWEST advertised tier (slow), the check also runs BEFORE
  // the device check (checkAaQuoteBeforeApproval, which does not use up the
  // quote), and the refusal causes have distinct titles.
  console.log('\nfee floor: the 2026-10-04 refusals, the lowest tier and the pre-approval check');
  {
    // A Pimlico-style bundler around the module's fake bundler, whose slow
    // and standard tiers can move independently between quote and send.
    function tieredBundler() {
      const base = fakeBundler({});
      const state = { standard: 29_835_424n, slow: null, standardMax: null, slowMax: null, estimate: null };
      const tier = (p, m) => ({ maxPriorityFeePerGas: '0x' + p.toString(16), ...(m !== null ? { maxFeePerGas: '0x' + m.toString(16) } : {}) });
      const t = async (method, params) => {
        if (method === 'rundler_maxPriorityFeePerGas') throw new Error('RPC error -32601: method not found');
        if (method === 'pimlico_getUserOperationGasPrice') {
          base.calls.push({ method, params });
          return {
            ...(state.slow !== null ? { slow: tier(state.slow, state.slowMax) } : {}),
            standard: tier(state.standard, state.standardMax),
          };
        }
        if (method === 'eth_estimateUserOperationGas' && state.estimate) {
          base.calls.push({ method, params });
          return state.estimate;
        }
        return base(method, params);
      };
      t.state = state;
      t.base = base;
      return t;
    }
    function tieredBundle() {
      const tb = tieredBundler();
      const n = fakeNode({});
      const b = createAaClient({
        nodeUrl: 'https://node.example',
        bundlerUrl: 'https://bundler.example',
        factory: FACTORY_INPUT,
        transportFor: (url) => (url === 'https://node.example' ? n : tb),
      });
      return { b, tb };
    }
    const sends = (tb) => tb.base.calls.filter((c) => c.method === 'eth_sendUserOperation').length;
    const estimates = (tb) => tb.base.calls.filter((c) => c.method === 'eth_estimateUserOperationGas').length;
    // The node's own suggestion in the emulator run: Sepolia's publicnode
    // answers eth_maxPriorityFeePerGas with 0.001 gwei (probe of 2026-10-04).
    const sepoliaNode = { maxFeePerGas: 2n * 1_000_000_000n + 1_000_000n, maxPriorityFeePerGas: 1_000_000n };

    // The two live refusals, reconstructed exactly.
    const live = [
      { name: 'first refusal', quoteStandard: 86_768_137n, quoted: 108_460_172n, sendStandard: 121_510_234n },
      { name: 'second refusal', quoteStandard: 53_945_437n, quoted: 67_431_797n, sendStandard: 68_112_565n },
    ];
    for (const c of live) {
      const q = quoteFeesOverFloor(sepoliaNode, { maxPriorityFeePerGas: c.quoteStandard, maxFeePerGas: null });
      check(`${c.name}: the quoted priority fee ${c.quoted} is ceil(1.25 × ${c.quoteStandard}) (the headroom was applied)`,
        q.maxPriorityFeePerGas === c.quoted, String(q.maxPriorityFeePerGas));
      const risePermille = ((c.sendStandard - c.quoteStandard) * 1000n) / c.quoteStandard;
      check(`${c.name}: the standard tier had risen ${Number(risePermille) / 10} % since the quote (above the 25 % headroom)`,
        risePermille > 250n);
    }
    // ZeroDev's slow tier is the standard one / 1.05 (probes of 2026-10-04:
    // slow, standard and fast always in the ratio 1 : 1.05 : 1.10).
    const slowOf = (standard) => (standard * 100n) / 105n;
    const q2 = quoteFeesOverFloor(sepoliaNode, { maxPriorityFeePerGas: live[1].quoteStandard, maxFeePerGas: null });
    check('second refusal, standard tier only (what the old code read): still a shortfall — a bundler without a slow tier is compared as before',
      feeFloorShortfall(q2, { maxPriorityFeePerGas: live[1].sendStandard, maxFeePerGas: null }) !== null);
    check('second refusal, with the slow tier the bundler also returned (64869109): NOT a shortfall now (the old code refused it)',
      feeFloorShortfall(q2, { maxPriorityFeePerGas: live[1].sendStandard, maxFeePerGas: null, lowest: { maxPriorityFeePerGas: slowOf(live[1].sendStandard), maxFeePerGas: null } }) === null);
    const q1 = quoteFeesOverFloor(sepoliaNode, { maxPriorityFeePerGas: live[0].quoteStandard, maxFeePerGas: null });
    const s1 = feeFloorShortfall(q1, { maxPriorityFeePerGas: live[0].sendStandard, maxFeePerGas: null, lowest: { maxPriorityFeePerGas: slowOf(live[0].sendStandard), maxFeePerGas: null } });
    check('first refusal: still a shortfall (even the slow tier, 115724032, is above the quoted 108460172), worded as the bundler’s minimum',
      s1 !== null && s1.startsWith("The bundler's minimum fee rose: it now asks for a priority fee of at least 115724032 wei"), s1 ?? '');

    // The stated rule: any rise of the standard tier up to 25 % between the
    // quote and the send never refuses (exact bigint, rounding included),
    // with or without a slow tier; the first wei above does.
    let ruleHolds = true;
    let firstAboveRefused = true;
    for (const f of [1n, 3n, 999n, 29_835_424n, 53_945_437n, 86_768_137n, 108_460_172n, 1_000_000_001n, 117_170_432n]) {
      const q = quoteFeesOverFloor(sepoliaNode, { maxPriorityFeePerGas: f, maxFeePerGas: f * 15n });
      for (const pct of [0n, 1n, 12n, 24n, 25n]) {
        const risen = (f * (100n + pct)) / 100n;
        const floorNow = { maxPriorityFeePerGas: risen, maxFeePerGas: (f * 15n * (100n + pct)) / 100n };
        if (feeFloorShortfall(q, floorNow) !== null) ruleHolds = false;
        if (feeFloorShortfall(q, { ...floorNow, lowest: { maxPriorityFeePerGas: slowOf(risen), maxFeePerGas: slowOf(floorNow.maxFeePerGas) } }) !== null) ruleHolds = false;
      }
      if (feeFloorShortfall(q, { maxPriorityFeePerGas: q.maxPriorityFeePerGas + 1n, maxFeePerGas: null }) === null) firstAboveRefused = false;
    }
    check('the stated rule: a standard-tier rise of 0, 1, 12, 24 or 25 % between quote and send never refuses (nine floors, both fees)', ruleHolds);
    check('…and one wei above the quoted priority fee always does', firstAboveRefused);
    check('the CTO’s reading of the two runs (+12 % and +1 % over the quote-time floor) passes',
      feeFloorShortfall(quoteFeesOverFloor(sepoliaNode, { maxPriorityFeePerGas: 108_460_172n, maxFeePerGas: null }), { maxPriorityFeePerGas: 121_510_234n, maxFeePerGas: null }) === null &&
        feeFloorShortfall(quoteFeesOverFloor(sepoliaNode, { maxPriorityFeePerGas: 67_431_797n, maxFeePerGas: null }), { maxPriorityFeePerGas: 68_112_565n, maxFeePerGas: null }) === null);

    // bundlerFeeFloor reads the slow tier as `lowest` (and never trusts one above the standard tier).
    const read = (answer) => bundlerFeeFloor(async (m) => (m === 'rundler_maxPriorityFeePerGas' ? null : answer));
    const both = await read({ slow: { maxPriorityFeePerGas: '0x3dddcae', maxFeePerGas: '0x5a8d1c11' }, standard: { maxPriorityFeePerGas: '0x40f1c66', maxFeePerGas: '0x5f2f3f3e' } });
    check('bundlerFeeFloor: standard tier for quoting, slow tier as `lowest`',
      both?.maxPriorityFeePerGas === 0x40f1c66n && both?.maxFeePerGas === 0x5f2f3f3en && both?.lowest?.maxPriorityFeePerGas === 0x3dddcaen && both?.lowest?.maxFeePerGas === 0x5a8d1c11n);
    const inverted = await read({ slow: { maxPriorityFeePerGas: '0x50', maxFeePerGas: '0x10' }, standard: { maxPriorityFeePerGas: '0x40', maxFeePerGas: '0x20' } });
    check('a slow priority fee above the standard one is ignored (no `lowest`)', inverted !== null && inverted.lowest === undefined);
    const maxAbove = await read({ slow: { maxPriorityFeePerGas: '0x10', maxFeePerGas: '0x30' }, standard: { maxPriorityFeePerGas: '0x40', maxFeePerGas: '0x20' } });
    check('a slow maxFeePerGas above the standard one is not trusted (the standard value is kept)', maxAbove?.lowest?.maxPriorityFeePerGas === 0x10n && maxAbove?.lowest?.maxFeePerGas === 0x20n);
    const badSlow = await read({ slow: { maxPriorityFeePerGas: 7 }, standard: { maxPriorityFeePerGas: '0x40' } });
    check('a malformed slow tier is ignored', badSlow?.maxPriorityFeePerGas === 0x40n && badSlow.lowest === undefined);
    check('quotes are priced over the STANDARD tier, never the slow one',
      quoteFeesOverFloor(sepoliaNode, { ...both, lowest: { maxPriorityFeePerGas: 1n, maxFeePerGas: null } }).maxPriorityFeePerGas === withFeeFloorHeadroom(0x40f1c66n));

    // End to end through sendAa and the pre-approval check (scaled ×20 so the
    // floor sits above the fake node's 1 gwei suggestion).
    {
      const { b, tb } = tieredBundle();
      tb.state.standard = live[1].quoteStandard * 20n;
      const qq = await prepareAaSend(b, owner.address, RECIPIENT, AMOUNT);
      check('scaled second refusal: quoted at standard × 1.25', qq.maxPriorityFeePerGas === withFeeFloorHeadroom(live[1].quoteStandard * 20n));
      tb.state.standard = live[1].sendStandard * 20n;
      tb.state.slow = slowOf(live[1].sendStandard * 20n);
      const pre = await checkAaQuoteBeforeApproval(b.bundler, qq).then(() => null, (e) => e);
      check('pre-approval check passes (the slow tier is below the quote)', pre === null);
      await sendAa(b, owner, qq);
      check('…and sendAa signs and sends it with exactly the quoted fees', sends(tb) === 1 && BigInt(tb.base.lastOp.maxPriorityFeePerGas) === qq.maxPriorityFeePerGas);
    }
    {
      const { b, tb } = tieredBundle();
      tb.state.standard = live[0].quoteStandard * 20n;
      const qq = await prepareAaSend(b, owner.address, RECIPIENT, AMOUNT);
      const estimatesBefore = estimates(tb);
      tb.state.standard = live[0].sendStandard * 20n;
      tb.state.slow = slowOf(live[0].sendStandard * 20n);
      const pre = await checkAaQuoteBeforeApproval(b.bundler, qq).then(() => null, (e) => e);
      check('scaled first refusal: the PRE-APPROVAL check refuses (reason floor), before anything is estimated, signed or sent',
        pre instanceof AaFeeRoseError && pre.reason === 'floor' && estimates(tb) === estimatesBefore && sends(tb) === 0);
      const described = describeAaError(pre, { accountType: 'simple', deployed: false });
      check('…titled "The network fee rose. Please review again." with the bundler’s-minimum sentence and "Nothing was signed or sent"',
        described?.title === AA_FEE_ROSE_TITLE && /^The bundler's minimum fee rose: /.test(described.detail) && described.detail.includes('Nothing was signed or sent.'));
      tb.state.standard = live[0].quoteStandard * 20n;
      tb.state.slow = null;
      const again = await checkAaQuoteBeforeApproval(b.bundler, qq).then(() => null, (e) => e);
      check('the pre-approval check does not use the quote up: when the floor falls back, it passes', again === null);
      await sendAa(b, owner, qq);
      check('…and the same quote can still be sent once', sends(tb) === 1);
      const used = await checkAaQuoteBeforeApproval(b.bundler, qq).then(() => null, (e) => e);
      check('a quote already submitted is refused by the pre-approval check (reason used, its own title), no bundler request',
        used instanceof AaFeeRoseError && used.reason === 'used' && used.message === AA_QUOTE_ALREADY_USED &&
          describeAaError(used, { accountType: 'simple', deployed: false })?.title === AA_REVIEW_AGAIN_TITLE);
    }
    {
      // The send-time check stays the last line of defence (a floor that rises
      // while the prompt is up), and the gas-estimate refusal has its own title.
      const { b, tb } = tieredBundle();
      tb.state.standard = 2_000_000_000n;
      const qq = await prepareAaSend(b, owner.address, RECIPIENT, AMOUNT);
      await checkAaQuoteBeforeApproval(b.bundler, qq);
      tb.state.standard = 4_000_000_000n;
      tb.state.slow = 3_000_000_000n;
      const late = await sendAa(b, owner, qq).then(() => null, (e) => e);
      check('send time: a floor that rose after the pre-approval check is still refused before signing (reason floor)',
        late instanceof AaFeeRoseError && late.reason === 'floor' && sends(tb) === 0);
      const { b: b2, tb: tb2 } = tieredBundle();
      const q2b = await prepareAaSend(b2, owner.address, RECIPIENT, AMOUNT);
      tb2.state.estimate = { callGasLimit: '0x111', verificationGasLimit: '0x222', preVerificationGas: '0x334' };
      const grew = await sendAa(b2, owner, q2b).then(() => null, (e) => e);
      const g = describeAaError(grew, { accountType: 'simple', deployed: false });
      check('a grown gas estimate: reason gas, title "The gas estimate grew. Please review again.", detail names both worst cases',
        grew instanceof AaFeeRoseError && grew.reason === 'gas' && g?.title === AA_GAS_GREW_TITLE && AA_GAS_GREW_TITLE === 'The gas estimate grew. Please review again.' &&
          /^The gas estimate grew: the bundler's fresh gas estimate makes the worst-case fee \d+ wei, above the \d+ wei you reviewed\./.test(g.detail) && sends(tb2) === 0, g?.detail);
      check('the two causes never share a title', AA_FEE_ROSE_TITLE !== AA_GAS_GREW_TITLE && AA_GAS_GREW_TITLE !== AA_REVIEW_AGAIN_TITLE);
      check('a bundler’s own floor refusal (after signing) keeps the network-fee title and says the minimum fee rose',
        /minimum fee rose after you reviewed it/.test(describeAaError(new Error('RPC error -32602: maxPriorityFeePerGas must be at least 5 (current maxPriorityFeePerGas: 4)'), { accountType: 'simple', deployed: true })?.detail ?? ''));
    }

    // Who pays a self-paid fee (finding 7): the sentence follows the deposit.
    const fmt = (wei) => `${wei} wei`;
    check('no deposit: the plain sentence', aaSelfPaidFeeSentence({ fee: 100n, deposit: 0n }, fmt) === AA_SELF_PAID_FEE_SENTENCE &&
      aaSelfPaidFeeSentence({ fee: 100n }, fmt) === 'The smart account pays its own gas from its own balance.');
    check('deposit covers the worst case: nothing for gas from the balance',
      aaSelfPaidFeeSentence({ fee: 100n, deposit: 100n }, fmt) ===
        "The smart account's EntryPoint deposit (100 wei) covers this whole worst-case fee, so nothing for gas comes from its balance; the deposit is reduced by what the operation actually uses.");
    check('smaller deposit: it pays first, the balance tops it up, the unused part stays in the deposit',
      aaSelfPaidFeeSentence({ fee: 100n, deposit: 30n }, fmt) ===
        "The fee comes first from the smart account's EntryPoint deposit (30 wei); its balance tops the deposit up by the rest of the worst case, up to 70 wei. What the operation does not use stays in the deposit for later fees; it does not return to the balance.");
    check('the deposit note says it cannot be sent and is not withdrawable here', /cannot be sent as an amount \(Max leaves it out\)/.test(AA_DEPOSIT_NOTE) && /does not offer a way to withdraw it/.test(AA_DEPOSIT_NOTE));

    // Mutation checks: broken copies of aa.ts must fail the checks above.
    const aaSource = readFileSync(new URL('../src/wallet/aa.ts', import.meta.url), 'utf8');
    const loadAaMutant = async (from, to) => {
      if (!aaSource.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
      return importMutant('src/wallet/aa.ts', aaSource.replace(from, to));
    };
    {
      const m = await loadAaMutant('const min = floor.lowest ?? floor;', 'const min = floor;');
      check('M1 caught: comparing with the standard tier (the old code) refuses the second live case again',
        m.feeFloorShortfall(q2, { maxPriorityFeePerGas: live[1].sendStandard, maxFeePerGas: null, lowest: { maxPriorityFeePerGas: slowOf(live[1].sendStandard), maxFeePerGas: null } }) !== null);
    }
    {
      const m = await loadAaMutant('return (value * (100n + AA_FEE_FLOOR_HEADROOM_PERCENT) + 99n) / 100n;', 'return value;');
      const q = m.quoteFeesOverFloor(sepoliaNode, { maxPriorityFeePerGas: 53_945_437n, maxFeePerGas: null });
      check('M2 caught: without the headroom a 1 % rise refuses (the rule check above would fail)',
        m.feeFloorShortfall(q, { maxPriorityFeePerGas: (53_945_437n * 101n) / 100n, maxFeePerGas: null }) !== null);
    }
    {
      const m = await loadAaMutant(
        "  if (submittedQuotes.has(quote)) throw new AaFeeRoseError(AA_QUOTE_ALREADY_USED, 'used');\n  await assertQuoteFeesMeetBundlerFloor(bundler, {",
        "  claimQuoteForSubmission(quote);\n  await assertQuoteFeesMeetBundlerFloor(bundler, {",
      );
      const quote = { maxFeePerGas: 10n, maxPriorityFeePerGas: 10n };
      const okBundler = async () => ({ standard: { maxPriorityFeePerGas: '0x1' } });
      await m.checkAaQuoteBeforeApproval(okBundler, quote);
      const second = await m.checkAaQuoteBeforeApproval(okBundler, quote).then(() => null, (e) => e);
      check('M3 caught: a pre-approval check that claims the quote makes the real send impossible', second !== null);
      const real = { maxFeePerGas: 10n, maxPriorityFeePerGas: 10n };
      await checkAaQuoteBeforeApproval(okBundler, real);
      check('…while the real check leaves it usable', (await checkAaQuoteBeforeApproval(okBundler, real).then(() => null, (e) => e)) === null);
    }
    {
      const m = await loadAaMutant("    if (isHexQuantity(slowPriority) && BigInt(slowPriority) <= floor.maxPriorityFeePerGas) {", '    if (isHexQuantity(slowPriority)) {');
      const mm = await m.bundlerFeeFloor(async (x) => (x === 'rundler_maxPriorityFeePerGas' ? null : { slow: { maxPriorityFeePerGas: '0x50' }, standard: { maxPriorityFeePerGas: '0x40' } }));
      check('M4 caught: trusting a slow tier above the standard one yields a `lowest` the real code refuses to set', mm?.lowest !== undefined);
    }
    {
      const m = await loadAaMutant("  if (error.reason === 'gas') return AA_GAS_GREW_TITLE;\n", '');
      check('M5 caught: without the gas title a grown estimate reads as a fee rise',
        m.aaFeeRoseTitle(new m.AaFeeRoseError('x', 'gas')) !== AA_GAS_GREW_TITLE);
    }
  }

  // The floor is re-read BEFORE the device check on every screen that takes
  // the biometric gate itself (source order), so "The network fee rose"
  // arrives before the user approves anything; the in-sendAa check stays.
  console.log('\nfee floor checked before the device check on every smart-account screen (source)');
  {
    const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
    // `body` must contain the check, and the check must come before the gate.
    const before = (body, gate) => {
      const c = body.indexOf('checkAaQuoteBeforeApproval(');
      const g = body.indexOf(gate);
      return c >= 0 && g >= 0 && c < g;
    };
    const handler = (src, start, end) => {
      const i = src.indexOf(start);
      const j = src.indexOf(end, i + start.length);
      return i >= 0 && j > i ? src.slice(i, j) : '';
    };
    const send = read('../src/screens/SendScreen.tsx');
    const onSend = handler(send, 'const onSend = async () => {', '// ------------------------------------------------- ');
    check('Send: before the spending-limit gate, the passkey path and the biometric prompt; a refusal re-quotes at once',
      before(onSend, 'spendingGateForQuote(') && before(onSend, 'sendPasskeyCalls(') && before(onSend, 'requireLocalAuth(') &&
        /checkAaQuoteBeforeApproval\(preBundle\.bundler, quote\);[\s\S]{0,700}setPhase\('form'\);\s*void onReview\(\);\s*return;/.test(onSend));
    const swap = read('../src/screens/SwapScreen.tsx');
    check('Swap (smart account): before the spending-limit gate and the biometric prompt',
      before(handler(swap, 'const bundleUrl = aaBundleUrl.current;', 'setPhase(\'aa-sending\');'), 'requireLocalAuth(') &&
        before(handler(swap, 'const bundleUrl = aaBundleUrl.current;', 'setPhase(\'aa-sending\');'), 'spendingGateForQuote('));
    for (const [name, file, start, gate] of [
      ['Guardians', '../src/screens/GuardiansScreen.tsx', 'const onConfirm = async () => {', 'requireLocalAuth(what)'],
      ['Change owner', '../src/screens/OwnerRotationScreen.tsx', 'const onConfirm = async () => {', "requireLocalAuth('Approve changing the owner key')"],
      ['Passkey install', '../src/screens/PasskeyScreen.tsx', 'const onInstall = async () => {', "requireLocalAuth('Approve adding this passkey"],
      ['Passkey remove', '../src/screens/PasskeyScreen.tsx', 'const onRemove = async () => {', "requireLocalAuth('Approve removing the passkey"],
      ['Session grant', '../src/screens/SessionsScreen.tsx', 'const onInstall = async () => {', "requireLocalAuth('Approve granting this session')"],
      ['Session / subscription revoke', '../src/screens/SessionsScreen.tsx', 'const onRevoke = async () => {', 'requireLocalAuth(revokeApprovalPrompt('],
      ['Guardian submit (Approve a recovery)', '../src/screens/ApproveRecoveryScreen.tsx', 'const onSubmit = async () => {', "requireLocalAuth('Approve submitting this recovery"],
    ]) {
      const src = read(file);
      check(`${name}: before the biometric prompt`, src.includes(start) && before(src.slice(src.indexOf(start)), gate));
    }
    const wc = read('../src/wallet/WalletConnectContext.tsx');
    const wcApprove = handler(wc, "item.parsed.kind === 'permissions') &&\n        !txApprovalAllowed(txQuote, overrideSimulation)", 'if (!controller.begin(item.key)) return;');
    check('WalletConnect sheet (smart-account transactions, batches and grants): before the biometric prompt',
      /item\.smart && \(txQuote\?\.status === 'ready-aa' \|\| txQuote\?\.status === 'ready-permission'\)/.test(wcApprove) && before(wcApprove, 'requireLocalAuth(promptTitle)'));
    check('sendAa, the passkey submit and the guardian submit keep the send-time floor check (last line of defence)',
      /claimQuoteForSubmission\(quote\);\s*const fees = [^\n]*\n\s*await assertQuoteFeesMeetBundlerFloor\(bundle\.bundler, fees\);/.test(read('../src/wallet/aa.ts')) &&
        /await assertQuoteFeesMeetBundlerFloor\(bundle\.bundler, fees\);/.test(read('../src/wallet/passkeys.ts')) &&
        /await assertQuoteFeesMeetBundlerFloor\(args\.bundler, fees\);/.test(read('../src/wallet/recovery.ts')));
    // Mutation: the same predicate on a copy with the check moved after the gate must fail.
    const gateEnd = "if (!auth.ok) {\n      Alert.alert('Not sent', auth.message);\n      return;\n    }";
    const moved = onSend
      .replace('await checkAaQuoteBeforeApproval(preBundle.bundler, quote);', '')
      .replace(gateEnd, `${gateEnd}\n    await checkAaQuoteBeforeApproval(preBundle.bundler, quote);`);
    check('M6 anchor present (the mutation really moved the check)', onSend.includes(gateEnd) && moved !== onSend);
    check('M6 caught: a Send handler that checks the floor after the biometric prompt fails the order check', !before(moved, 'requireLocalAuth('));
    // The deposit row on every self-paid smart-account confirm (finding 7).
    for (const f of ['../src/screens/SendScreen.tsx', '../src/screens/SwapScreen.tsx', '../src/screens/GuardiansScreen.tsx', '../src/screens/OwnerRotationScreen.tsx', '../src/screens/PasskeyScreen.tsx', '../src/screens/SessionsScreen.tsx', '../src/components/WcApprovalSheet.tsx']) {
      check(`${f.split('/').pop()}: the confirm shows the EntryPoint deposit (AaDepositNote)`, /<AaDepositNote\b/.test(read(f)));
    }
    check('Send confirm: the plain "own balance" sentence only when there is no deposit',
      /quote\.deposit !== undefined && quote\.deposit > 0n \? '' : ` \$\{AA_SELF_PAID_FEE_SENTENCE\}`/.test(send) && !/The smart account pays ' \+\s*'its own gas from its own balance\.'/.test(send));
  }

  // After a failed smart-account submission no screen may keep a confirm
  // whose button re-sends the used-up quote (the 2026-10-04 run: re-tapping
  // re-sent the stale fees). Source checks; sendAa itself also refuses a
  // second submission of the same quote (checked above).
  console.log('\nretry re-quotes on every smart-account screen (source)');
  {
    const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
    const send = read('../src/screens/SendScreen.tsx');
    check('Send (owner and passkey paths): quote dropped, back to the form',
      (send.match(/setQuote\(null\);\s*setQuotedUrl\(null\);\s*setPhase\('form'\);/g) ?? []).length >= 3 &&
        /if \(quote\.kind === 'aa'\) \{[\s\S]{0,400}setQuote\(null\);\s*setQuotedUrl\(null\);\s*setPhase\('form'\);\s*return;\s*\}\s*setPhase\('confirm'\);/.test(send));
    check('Swap (smart account): quote dropped, back to the review',
      /describeSendError\(e, sellSymbol\);\s*Alert\.alert\(title, detail\);[\s\S]{0,300}setAaQuote\(null\);\s*setPhase\('review'\);/.test(read('../src/screens/SwapScreen.tsx')));
    check('Guardians: operation dropped, back to where it was prepared',
      /setOperation\(null\);\s*setPhase\(op\.kind === 'install' \|\| op\.kind === 'renew' \? 'form' : 'overview'\);/.test(read('../src/screens/GuardiansScreen.tsx')));
    check('Change owner: rotation dropped, back to the overview',
      /setRotation\(null\);\s*setPhase\('overview'\);/.test(read('../src/screens/OwnerRotationScreen.tsx')));
    const pk = read('../src/screens/PasskeyScreen.tsx');
    check('Passkey: install re-quoted from the same registration; test and remove back to main',
      /setPendingInstall\(null\);\s*setPhase\('quoting'\);[\s\S]{0,200}preparePasskeyInstall\(bundle, owner, account, p\.registration\)/.test(pk) &&
        /setPendingTest\(null\);\s*setPhase\('main'\);/.test(pk) && /setPendingRemove\(null\);\s*setPhase\('main'\);/.test(pk));
    check('Guardian submit (Approve a recovery): submission dropped, back to the review',
      /setSubmission\(null\);\s*setPhase\('review'\);/.test(read('../src/screens/ApproveRecoveryScreen.tsx')));
    const sheet = read('../src/components/WcApprovalSheet.tsx');
    check('WalletConnect sheet: an attempt that leaves the request on the sheet re-quotes a smart-account request',
      /await onApprove\(txQuote, overrideSimulation, undefined, messageSigner, identityAck\);\s*\/\/[^\n]*\n\s*if \(smartQuote && currentItemKey\.current === key\) setAaQuoteGeneration\(\(g\) => g \+ 1\);/.test(sheet) &&
        sheet.includes('quotedInputs.generation !== aaQuoteGeneration') &&
        read('../src/wallet/WalletConnectContext.tsx').includes('onApprove={(q, o, c, signer, ack) => onApprove(head, q, o, c, signer, ack)}'));
  }

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
    'Turn on a test network (Ethereum Sepolia or Base Sepolia)',
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

console.log('\ncheck-aa: funding check before the bundler, quote titles, approval prompt (phase 11 item 2)');
await (async () => {
  // A: the wallet's own funding check runs before any bundler call.
  const { bundle: empty, bundler: emptyBundler } = makeBundle({ senderBalance: 0n });
  let err = null;
  try {
    await prepareAaSend(empty, owner.address, RECIPIENT, AMOUNT);
  } catch (e) {
    err = e;
  }
  check('unfunded smart account: AaFundingError naming the smart-account address', err instanceof AaFundingError && same(err.sender, SENDER) && err.message.includes(err.sender), String(err));
  check('…and telling the user to fund that address, not the owner', /Fund the smart account address 0x[0-9a-fA-F]{40} \(not the owner address\)/.test(err?.message ?? ''));
  check('…with ZERO bundler calls (no estimate, no fee-floor probe)', emptyBundler.calls.length === 0, JSON.stringify(emptyBundler.calls.map((c) => c.method)));
  const { bundle: exact, bundler: exactBundler } = makeBundle({ senderBalance: AMOUNT });
  await checkRejects('self-paid: a balance equal to the amount cannot also pay gas (refused pre-estimate)', () => prepareAaSend(exact, owner.address, RECIPIENT, AMOUNT), 'Fund the smart account address');
  check('…still zero bundler calls', exactBundler.calls.length === 0);
  const { bundle: probeEmpty, bundler: probeBundler } = makeBundle({ senderBalance: 0n });
  await checkRejects('AA Max on an empty smart account: the funding message, no bundler call', () => maxAaSend(probeEmpty, owner.address, RECIPIENT), 'Fund the smart account address');
  check('…zero bundler calls for the Max probe', probeBundler.calls.length === 0);
  const { bundle: short } = makeBundle({ senderBalance: AMOUNT + 1n });
  let postErr = null;
  try {
    await prepareAaSend(short, owner.address, RECIPIENT, AMOUNT);
  } catch (e) {
    postErr = e;
  }
  check('amount + 1 wei passes the pre-check; the post-estimate check names the worst-case fee and the address', postErr instanceof AaFundingError && postErr.message.includes('a worst-case fee of') && postErr.message.includes(postErr.sender));
  check('describeAaError gives both the funding title', describeAaError(err, { accountType: 'simple', deployed: false })?.title === AA_FUNDING_TITLE && describeAaError(postErr, { accountType: 'simple', deployed: false })?.title === 'Your smart account needs funds first.');

  // Finding 8 of the phase 12 rehearsal: the deploy sentence only for an
  // account that is not deployed yet, and the EntryPoint deposit counted.
  const DEPLOY_SENTENCE = 'A smart account can receive funds before it is deployed; the first send deploys it.';
  check('undeployed account: the funding message keeps the deploy sentence', (err?.message ?? '').includes(DEPLOY_SENTENCE));
  const { bundle: deployedEmpty } = makeBundle({ senderBalance: 0n, senderDeployed: true });
  let deployedErr = null;
  try {
    await prepareAaSend(deployedEmpty, owner.address, RECIPIENT, AMOUNT);
  } catch (e) {
    deployedErr = e;
  }
  check('DEPLOYED account: refused with the funding message but WITHOUT the deploy sentence',
    deployedErr instanceof AaFundingError && /Fund the smart account address/.test(deployedErr.message) && !deployedErr.message.includes(DEPLOY_SENTENCE), String(deployedErr));
  const base = { sender: SENDER, amount: 5n, fee: 3n, balance: 4n, sponsored: false };
  check('aaFundingMessage: deployed true / null omit the deploy sentence, false keeps it',
    !aaFundingMessage({ ...base, deployed: true }).includes(DEPLOY_SENTENCE) && !aaFundingMessage({ ...base, deployed: null }).includes(DEPLOY_SENTENCE) && aaFundingMessage({ ...base, deployed: false }).includes(DEPLOY_SENTENCE));
  check('aaFundingMessage names a non-zero EntryPoint deposit and that it pays only the fee',
    aaFundingMessage({ ...base, deposit: 2n }).includes('plus its EntryPoint deposit of 2 wei (the deposit can pay only the fee, not the amount)') && !aaFundingMessage({ ...base, deposit: 0n }).includes('deposit'));
  check('aaCanPaySelf: the deposit pays the fee first, the balance the rest and the amount',
    aaCanPaySelf({ amount: 10n, fee: 5n, balance: 10n, deposit: 5n }) && !aaCanPaySelf({ amount: 10n, fee: 5n, balance: 10n, deposit: 4n }) &&
      aaCanPaySelf({ amount: 10n, fee: 5n, balance: 11n, deposit: 4n }) && !aaCanPaySelf({ amount: 11n, fee: 0n, balance: 10n, deposit: 100n }) &&
      !aaCanPaySelf({ amount: 10n, fee: 5n, balance: 10n, deposit: null }));
  // Balance exactly the amount: refused without a deposit (above), accepted
  // when the deposit covers the worst-case fee.
  const { bundle: withDeposit, bundler: depositBundler } = makeBundle({ senderBalance: AMOUNT, deposit: 10n ** 17n });
  const depQuote = await prepareAaSend(withDeposit, owner.address, RECIPIENT, AMOUNT);
  check('balance == amount + a deposit that covers the fee: quoted (the deposit is counted)', depQuote.amount === AMOUNT && depositBundler.calls.some((c) => c.method === 'eth_estimateUserOperationGas'));
  const { bundle: tinyDeposit } = makeBundle({ senderBalance: AMOUNT, deposit: 1n });
  let partialErr = null;
  try {
    await prepareAaSend(tinyDeposit, owner.address, RECIPIENT, AMOUNT);
  } catch (e) {
    partialErr = e;
  }
  check('a deposit smaller than the fee: refused after the estimate, naming the deposit',
    partialErr instanceof AaFundingError && partialErr.message.includes('a worst-case fee of') && partialErr.message.includes('EntryPoint deposit of 1 wei'), String(partialErr));
  const { bundle: overDeposit, bundler: overBundler } = makeBundle({ senderBalance: AMOUNT - 1n, deposit: 10n ** 17n });
  await checkRejects('the deposit never pays the amount: amount above the balance is refused before the bundler', () => prepareAaSend(overDeposit, owner.address, RECIPIENT, AMOUNT), 'Fund the smart account address');
  check('…with zero bundler calls', overBundler.calls.length === 0);

  // Sponsored: only the amount must be covered, and the pre-check runs
  // before both the bundler and the paymaster.
  const seen = [];
  const sponsoredBundle = createAaClient({
    nodeUrl: 'https://node.example',
    bundlerUrl: 'https://bundler.example',
    factory: FACTORY_INPUT,
    paymaster: { url: 'https://pm.example', contextJson: null },
    transportFor: (url) => {
      if (url === 'https://node.example') return fakeNode({ senderBalance: 10n });
      return async (method) => {
        seen.push(`${url} ${method}`);
        throw new Error(`unexpected ${method}`);
      };
    },
  });
  await checkRejects('sponsored: an amount above the balance is refused before bundler and paymaster', () => prepareAaSend(sponsoredBundle, owner.address, RECIPIENT, 11n), 'gas is sponsored, but the amount is not');
  check('…zero bundler/paymaster calls', seen.length === 0, seen.join(', '));

  // Estimation-failure title: nothing was sent while quoting.
  const generic = describeSendError(new Error('RPC error -32500: something odd (eth_estimateUserOperationGas)'), 'test ETH');
  check('describeSendError still says "could not be sent" (send-time wording unchanged)', generic.title === 'The transaction could not be sent.');
  const retitled = retitleQuoteFailure(generic);
  check('quote step: "The quote could not be prepared." with the detail unchanged', retitled.title === 'The quote could not be prepared.' && QUOTE_FAILED_TITLE === retitled.title && retitled.detail === generic.detail);
  const specific = describeSendError(new Error('Amount is below the dust limit'), 'test ETH');
  check('specific titles are kept on the quote step', retitleQuoteFailure(specific).title === specific.title);
  const sendSource = readFileSync(new URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8');
  check('SendScreen re-titles quote failures (review and Max) through retitleQuoteFailure', (sendSource.match(/retitleQuoteFailure\(/g) ?? []).length >= 2);

  // C: the smart-account biometric prompt names the amount and asset.
  check('prompt: "Approve sending 0.0001 test ETH from your smart account"', aaSendApprovalPrompt({}, '0.0001 test ETH') === 'Approve sending 0.0001 test ETH from your smart account');
  check('prompt for a token send from the smart account', aaSendApprovalPrompt({ eip7702: undefined, recovered: undefined }, '1.5 USDC') === 'Approve sending 1.5 USDC from your smart account');
  check('prompt for an EIP-7702 upgraded account', aaSendApprovalPrompt({ eip7702: { upgrade: false, delegate: '0x' + '11'.repeat(20) } }, '0.0001 test ETH') === 'Approve sending 0.0001 test ETH from your upgraded account');
  check('prompt for a recovered smart account', aaSendApprovalPrompt({ recovered: true }, '2 test ETH') === 'Approve sending 2 test ETH from your recovered smart account');
  check('SendScreen passes the smart-account quote through aaSendApprovalPrompt with the typed amount and symbol', sendSource.includes("quote.kind === 'aa'\n          ? aaSendApprovalPrompt(quote, `${amountText} ${symbol}`)"));
})();

// ---------------------------------------------------------------------------
// Base Sepolia findings 2 and 5: config-changed notifications, the bundler
// chain id recorded at save time, and the Settings wording.
// ---------------------------------------------------------------------------

console.log('AA config notifications and the bundler status line:');
await (async () => {
  const s2 = memoryStore();
  let writes = 0;
  const stop = addAaConfigChangedListener(() => {
    writes += 1;
  });
  let stateChanges = 0;
  const stopState = subscribeAaStateChanges(() => {
    stateChanges += 1;
  });
  await setAaBundlerUrl(EVM_BASE_SEPOLIA.caip2, 'https://bundler.example/base', {
    store: s2,
    transportFor: () => fakeBundler({ chainIdHex: '0x14a34' }),
  });
  check('a successful bundler save notifies config listeners once', writes === 1, String(writes));
  check('subscribeAaStateChanges also fires on a config write', stateChanges === 1, String(stateChanges));
  let c = await getAaConfig(EVM_BASE_SEPOLIA.caip2, s2);
  check('the bundler chain id reported at save time is recorded (84532)', c.bundlerChainIdVerified === '84532', String(c.bundlerChainIdVerified));
  check(
    'status line names the reported chain id and the network',
    bundlerVerifiedLine(c, 'Base Sepolia', '2026-10-03') ===
      'Verified ✓ — the bundler reported chain id 84532 (Base Sepolia) and eth_supportedEntryPoints includes EntryPoint v0.7 (checked 2026-10-03)',
    bundlerVerifiedLine(c, 'Base Sepolia', '2026-10-03'),
  );
  await setAaBundlerUrl(EVM_BASE_SEPOLIA.caip2, 'https://bundler.example/sepolia', {
    store: s2,
    transportFor: () => fakeBundler({ chainIdHex: '0xaa36a7' }),
  }).catch(() => undefined);
  check('a refused bundler save (wrong chain) notifies nobody', writes === 1, String(writes));
  await clearAaBundlerUrl(EVM_BASE_SEPOLIA.caip2, s2);
  check('clearing the bundler notifies config listeners', writes === 2, String(writes));
  c = await getAaConfig(EVM_BASE_SEPOLIA.caip2, s2);
  check('clearing the bundler also clears the recorded chain id', c.bundlerUrl === null && c.bundlerChainIdVerified === null);
  stop();
  stopState();
  await setAaBundlerUrl(EVM_BASE_SEPOLIA.caip2, 'https://bundler.example/base', {
    store: s2,
    transportFor: () => fakeBundler({ chainIdHex: '0x14a34' }),
  });
  check('unsubscribed listeners are not called', writes === 2 && stateChanges === 2, `${writes}/${stateChanges}`);

  // A bundler saved before the chain-id check existed carries no chain id.
  const legacy = memoryStore();
  await legacy.setItem(
    'shiba-wallet.aa-config.v1',
    JSON.stringify({ [AA_CHAIN]: { bundlerUrl: 'https://bundler.example/old', bundlerVerifiedAt: '2026-10-01T23:30:00.000Z' } }),
  );
  const old = await getAaConfig(AA_CHAIN, legacy);
  check('legacy bundler entry reads with no recorded chain id', old.bundlerUrl !== null && old.bundlerChainIdVerified === null);
  check(
    'legacy status line does not claim the chain-id check ran',
    bundlerVerifiedLine(old, 'Ethereum Sepolia', '2026-10-01') ===
      'Verified ✓ — eth_supportedEntryPoints includes EntryPoint v0.7 (checked 2026-10-01). Saved before the chain-id check existed: save it again to confirm which network it serves.',
  );
  await legacy.setItem(
    'shiba-wallet.aa-config.v1',
    JSON.stringify({ [AA_CHAIN]: { bundlerUrl: 'https://bundler.example/old', bundlerChainIdVerified: '0xaa36a7' } }),
  );
  check('a malformed stored chain id is ignored (decimal digits only)', (await getAaConfig(AA_CHAIN, legacy)).bundlerChainIdVerified === null);

  const settingsSource = readFileSync(new URL('../src/screens/SettingsScreen.tsx', import.meta.url), 'utf8');
  check(
    'Settings renders the bundler line through bundlerVerifiedLine with the local date',
    settingsSource.includes('bundlerVerifiedLine(config, network.label, shortDate(config.bundlerVerifiedAt))') &&
      settingsSource.includes('const shortDate = (iso: string | null) => localDateLabel(iso);') &&
      !settingsSource.includes('iso.slice(0, 10)'),
  );
})();

console.log('\ncheck-aa: smart-account Max slack (phase 13 item 4): a Max amount is lowered, never raised, when the fee rose');
await (async () => {
  // A bundler whose estimate can be changed between Max and Review, and
  // which records the value of every call it was asked to price.
  const MAXFEE = 3_000_000_000n; // fakeNode: base 1 gwei × 2 + priority 1 gwei
  const gasSet = { cgl: 100_000n, vgl: 200_000n, pvg: 50_000n };
  const estimates = [];
  const priced = (g) => (g.cgl + g.vgl + g.pvg) * MAXFEE;
  function tunableBundle(nodeOptions = {}, onEstimate = null) {
    const node = fakeNode(nodeOptions);
    const bundler = async (method, params) => {
      if (method === 'eth_estimateUserOperationGas') {
        estimates.push(params[0].callData);
        if (onEstimate) onEstimate();
        return { callGasLimit: '0x' + gasSet.cgl.toString(16), verificationGasLimit: '0x' + gasSet.vgl.toString(16), preVerificationGas: '0x' + gasSet.pvg.toString(16) };
      }
      throw new Error(`tunable bundler: unexpected ${method}`);
    };
    return createAaClient({
      nodeUrl: 'https://node.example',
      bundlerUrl: 'https://bundler.example',
      factory: FACTORY_INPUT,
      transportFor: (url) => (url === 'https://node.example' ? node : bundler),
    });
  }
  const BAL = 10n ** 16n; // 0.01 ETH
  const keysOf = (q) => JSON.stringify(q, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : v));

  // Steady fee: the fromMax quote equals the plain quote, key for key.
  gasSet.vgl = 200_000n;
  const steady = tunableBundle({ senderBalance: BAL });
  const steadyMax = await maxAaSend(steady, owner.address, RECIPIENT);
  check('Max = balance − the worst-case fee of a zero-value probe (deposit not counted)', steadyMax === BAL - priced(gasSet), String(steadyMax));
  const plain = await prepareAaSend(steady, owner.address, RECIPIENT, steadyMax);
  const marked = await prepareAaSend(steady, owner.address, RECIPIENT, steadyMax, { fromMax: true });
  check('fee steady: the fromMax quote is identical to the plain quote (no maxAdjustment)', keysOf(plain) === keysOf(marked) && !('maxAdjustment' in marked), keysOf(marked));

  // The fee rose between Max and Review (the Base finding, smart-account side).
  gasSet.vgl = 200_000n;
  const maxBefore = await maxAaSend(tunableBundle({ senderBalance: BAL }), owner.address, RECIPIENT);
  gasSet.vgl = 260_000n; // +60k gas at 3 gwei
  const rose = tunableBundle({ senderBalance: BAL });
  await checkRejects('fee rose, TYPED amount (no fromMax): refused as before, never lowered', () => prepareAaSend(rose, owner.address, RECIPIENT, maxBefore), 'Fund the smart account address');
  estimates.length = 0;
  const trimmed = await prepareAaSend(rose, owner.address, RECIPIENT, maxBefore, { fromMax: true });
  check('fee rose, fromMax: amount lowered to balance − the new worst-case fee', trimmed.amount === BAL - priced(gasSet) && trimmed.amount < maxBefore && trimmed.amount + trimmed.fee === BAL, `${trimmed.amount} ${trimmed.fee}`);
  check('…the signed call carries the lowered value and maxAdjustment records the Max figure', trimmed.calls.length === 1 && trimmed.calls[0].value === trimmed.amount && trimmed.maxAdjustment?.requested === maxBefore && trimmed.total === trimmed.amount + trimmed.fee);
  check('…re-estimated with the lowered amount (two estimates: Max figure, then the lowered one)', estimates.length === 2 && estimates[0] !== estimates[1]);
  const sentence = aaMaxAdjustmentSentence(trimmed, (v) => `${v} wei`);
  check('the confirm sentence names both amounts and the reason',
    sentence === `The amount was lowered from ${maxBefore} wei to ${trimmed.amount} wei because the network fee rose after you tapped Max. The amount plus the worst-case fee now fits the smart account's balance; its EntryPoint deposit, if any, is left as a reserve for the fee.`,
    sentence);
  check('no sentence without an adjustment', aaMaxAdjustmentSentence(plain, String) === null);

  // The fee fell: the Max amount is kept (never raised).
  gasSet.vgl = 200_000n;
  const maxHigh = await maxAaSend(tunableBundle({ senderBalance: BAL }), owner.address, RECIPIENT);
  gasSet.vgl = 150_000n;
  const fell = await prepareAaSend(tunableBundle({ senderBalance: BAL }), owner.address, RECIPIENT, maxHigh, { fromMax: true });
  check('fee fell: the Max amount is kept, no maxAdjustment', fell.amount === maxHigh && !('maxAdjustment' in fell) && fell.total < BAL);

  // DEPOSIT RULE: a Max amount must fit beside the FULL fee even when the
  // deposit could pay it; a typed amount may still use the deposit.
  gasSet.vgl = 200_000n;
  const maxDep = await maxAaSend(tunableBundle({ senderBalance: BAL, deposit: 10n ** 18n }), owner.address, RECIPIENT);
  check('Max ignores a large EntryPoint deposit (it stays as the fee reserve)', maxDep === BAL - priced(gasSet), String(maxDep));
  gasSet.vgl = 260_000n;
  const depTrim = await prepareAaSend(tunableBundle({ senderBalance: BAL, deposit: 10n ** 18n }), owner.address, RECIPIENT, maxDep, { fromMax: true });
  check('fee rose with a large deposit, fromMax: still lowered to balance − fee', depTrim.amount === BAL - priced(gasSet) && depTrim.maxAdjustment?.requested === maxDep);
  const depTyped = await prepareAaSend(tunableBundle({ senderBalance: BAL, deposit: 10n ** 18n }), owner.address, RECIPIENT, maxDep);
  check('…while the same amount TYPED is quoted unchanged (the deposit pays the fee, aaCanPaySelf)', depTyped.amount === maxDep && !('maxAdjustment' in depTyped) && depTyped.deposit === 10n ** 18n);

  // Contract calls are never lowered.
  gasSet.vgl = 260_000n;
  await checkRejects('fromMax on a call with calldata: refused, value unchanged',
    () => prepareAaCalls(tunableBundle({ senderBalance: BAL }), owner.address, [{ to: RECIPIENT, value: maxBefore, data: new Uint8Array([1, 2, 3, 4]) }], { fromMax: true }),
    'Fund the smart account address');

  // The balance fell to (or below) the Max figure: priced through a zero-value probe first.
  gasSet.vgl = 200_000n;
  estimates.length = 0;
  const fallen = await prepareAaSend(tunableBundle({ senderBalance: BAL / 2n }), owner.address, RECIPIENT, BAL, { fromMax: true });
  check('balance below the Max figure: lowered to the new balance − fee via a zero-value probe', fallen.amount === BAL / 2n - priced(gasSet) && fallen.maxAdjustment?.requested === BAL && estimates.length === 2);
  await checkRejects('…and refused with the funding message when the fee alone exceeds the balance',
    () => prepareAaSend(tunableBundle({ senderBalance: priced(gasSet) }), owner.address, RECIPIENT, BAL, { fromMax: true }), 'Fund the smart account address');

  // A bundler whose estimate keeps rising: bounded rounds, then refused.
  gasSet.vgl = 200_000n;
  const climbMax = await maxAaSend(tunableBundle({ senderBalance: BAL }), owner.address, RECIPIENT);
  gasSet.vgl = 260_000n;
  estimates.length = 0;
  const climbing = tunableBundle({ senderBalance: BAL }, () => { gasSet.vgl += 10_000n; });
  await checkRejects('estimate rising on every pricing: refused after the bounded rounds', () => prepareAaSend(climbing, owner.address, RECIPIENT, climbMax, { fromMax: true }), 'Fund the smart account address');
  check(`…at most 1 + ${AA_MAX_TRIM_ROUNDS} estimates`, AA_MAX_TRIM_ROUNDS === 3 && estimates.length === 4, String(estimates.length));

  check('aaFeeFromBalance: the deposit pays first; null counts as zero', aaFeeFromBalance(5n, 3n) === 2n && aaFeeFromBalance(5n, 9n) === 0n && aaFeeFromBalance(5n, null) === 5n);

  // SendScreen wiring (source checks): a separate last-Max record for the
  // smart-account path, fromMax passed only on the plain native AA quote,
  // the sentence on the confirm.
  const send = readFileSync(new URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8');
  check('SendScreen keeps a separate lastAaMax record, cleared on every Max tap',
    /const lastAaMax = useRef<LastMaxResult \| null>\(null\);/.test(send) && /lastEvmMax\.current = null;\s*\n\s*lastAaMax\.current = null;/.test(send));
  check('…set only after the smart-account native Max (not the passkey or token path)',
    /max = await maxAaSend\(bundle, account\.address, validation\.normalized\);[\s\S]{0,400}lastAaMax\.current = \{/.test(send));
  check('…and passed as fromMax only to prepareAaSend',
    /prepareAaSend\(bundle, account\.address, validation\.normalized, amount, \{\s*fromMax: amountIsLastMax\(lastAaMax\.current,/.test(send));
  check('the confirm shows aaMaxAdjustmentSentence for a lowered smart-account Max', /quote\.kind === 'aa' && quote\.maxAdjustment[\s\S]{0,200}aaMaxAdjustmentSentence\(quote,/.test(send));
})();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// Phase 4 items 5 + 6 checks, entirely OFFLINE: the auto-lock state
// machine (src/wallet/lock.ts), the preference store and privacy mask
// (src/config/prefs.ts), the active-EVM-chain profiles and their pinned
// Sepolia constants (src/config/evm-chain.ts, src/config/defaults.ts),
// active-chain switching through the real prepareEvmSend/sendEvm
// machinery against a fake JSON-RPC node behind global fetch (a Sepolia
// quote passes with chain id 11155111 and refuses 1, and vice versa in
// mainnet mode), explorer-link overrides, the WalletConnect namespace /
// request-routing parameterization, and the AA prefill verify-before-save
// under the Sepolia store key. No network request leaves the process,
// nothing is broadcast.
//
// Like check-aa.mjs, it imports the actual TypeScript modules the app
// runs via Node's native type stripping. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-devmode.mjs
//
// The signing key used by the sendEvm leg derives from the standard
// BIP-39 test mnemonic ("abandon ... about"), public knowledge.

import { evmKeyProvider, mnemonicToSeed, toChecksumAddress } from '@shiba-wallet/core';
import { ENTRYPOINT_V07, encodeFunctionCall, toBytes, toHex } from '@shiba-wallet/chains-evm';
import { INITIAL_LOCK_STATE, reduceLock } from '../src/wallet/lock.ts';
import {
  AUTO_LOCK_CHOICES,
  DEFAULT_PREFS,
  loadPrefs,
  maskAmount,
  savePrefs,
} from '../src/config/prefs.ts';
import { EVM_MAINNET, EVM_SEPOLIA, evmProfileFor } from '../src/config/evm-chain.ts';
import {
  DEFAULT_NETWORKS,
  SEPOLIA_NETWORK,
  resolveActiveNetworks,
} from '../src/config/defaults.ts';
import { EVM_CHAIN_ID, prepareEvmSend, sendEvm } from '../src/wallet/send.ts';
import { explorerTxUrl } from '../src/wallet/history.ts';
import {
  WcRequestRejection,
  WC_ERRORS,
  buildWalletNamespaces,
  describeProposal,
  parseTypedDataV4,
  parseWcRequest,
} from '../src/wallet/walletconnect.ts';
import { getAaConfig, setAaFactory } from '../src/wallet/aa.ts';
import {
  INSECURE_ENDPOINT_MESSAGE,
  LOOPBACK_HOSTS,
  assertSecureEndpointUrl,
} from '../src/config/endpoint-url.ts';
import { setEndpointOverride } from '../src/config/networks.ts';

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

async function checkRejects(name, promiseFn, messagePattern) {
  try {
    const value = await promiseFn();
    check(name, false, `expected a rejection, got ${JSON.stringify(value)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, messagePattern.test(message), `error was: ${message}`);
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
// 1. Lock state machine (src/wallet/lock.ts)
// ---------------------------------------------------------------------------

console.log('lock state machine:');

const MIN = 60_000;
const at = (type, status, now) => ({ type, status, now });

{
  // backgrounded -> threshold reached -> locked
  let s = INITIAL_LOCK_STATE;
  s = reduceLock(s, at('app-state', 'background', 1_000), MIN);
  check('background records the away-moment', s.backgroundedAt === 1_000 && !s.locked);
  s = reduceLock(s, at('app-state', 'active', 1_000 + MIN), MIN);
  check('active at exactly the threshold locks', s.locked === true);
  check('active clears the away-moment', s.backgroundedAt === null);
  s = reduceLock(s, { type: 'unlock' }, MIN);
  check('unlock clears the lock', s.locked === false && s.backgroundedAt === null);
}
{
  // under the threshold -> not locked
  let s = INITIAL_LOCK_STATE;
  s = reduceLock(s, at('app-state', 'background', 5_000), MIN);
  s = reduceLock(s, at('app-state', 'active', 5_000 + MIN - 1), MIN);
  check('active just under the threshold does not lock', s.locked === false);
  check('under-threshold return still clears the timer', s.backgroundedAt === null);
}
{
  // iOS 'inactive' counts as going away; flapping keeps the EARLIEST moment
  let s = INITIAL_LOCK_STATE;
  s = reduceLock(s, at('app-state', 'inactive', 10_000), MIN);
  check("'inactive' starts the away-timer", s.backgroundedAt === 10_000);
  s = reduceLock(s, at('app-state', 'background', 40_000), MIN);
  check('later background keeps the earliest away-moment', s.backgroundedAt === 10_000);
  s = reduceLock(s, at('app-state', 'active', 10_000 + MIN), MIN);
  check('lock measures from the earliest away-moment', s.locked === true);
}
{
  // threshold off -> never locks
  let s = INITIAL_LOCK_STATE;
  s = reduceLock(s, at('app-state', 'background', 0), null);
  s = reduceLock(s, at('app-state', 'active', 10 * MIN), null);
  check('auto-lock off never locks', s.locked === false && s.backgroundedAt === null);
}
{
  // locked stays locked across further app-state churn until unlock
  let s = { locked: true, backgroundedAt: null };
  s = reduceLock(s, at('app-state', 'background', 100), MIN);
  s = reduceLock(s, at('app-state', 'active', 200), MIN);
  check('a short round-trip while locked stays locked', s.locked === true);
}
{
  // backwards clock never locks
  let s = INITIAL_LOCK_STATE;
  s = reduceLock(s, at('app-state', 'background', 1_000_000), MIN);
  s = reduceLock(s, at('app-state', 'active', 0), MIN);
  check('a backwards clock does not lock', s.locked === false);
}

// ---------------------------------------------------------------------------
// 2. Preference store + privacy mask (src/config/prefs.ts)
// ---------------------------------------------------------------------------

console.log('preferences:');

{
  const store = memoryStore();
  const initial = await loadPrefs(store);
  check(
    'empty store yields the defaults',
    JSON.stringify(initial) === JSON.stringify(DEFAULT_PREFS),
  );
  const saved = await savePrefs({ sepolia: true, hideAmounts: true, autoLockMs: 60_000 }, store);
  check('savePrefs returns the merged state', saved.sepolia && saved.hideAmounts && saved.autoLockMs === 60_000);
  const reloaded = await loadPrefs(store);
  check('round-trip persists all three prefs', reloaded.sepolia && reloaded.hideAmounts && reloaded.autoLockMs === 60_000);
  const patched = await savePrefs({ sepolia: false }, store);
  check('partial patch keeps the other prefs', !patched.sepolia && patched.hideAmounts && patched.autoLockMs === 60_000);
}
{
  const store = memoryStore();
  await store.setItem('shiba-wallet.prefs.v1', '{not json');
  const prefs = await loadPrefs(store);
  check('corrupt JSON falls back to defaults', JSON.stringify(prefs) === JSON.stringify(DEFAULT_PREFS));
}
{
  const store = memoryStore();
  await store.setItem(
    'shiba-wallet.prefs.v1',
    JSON.stringify({ sepolia: 'yes', hideAmounts: 1, autoLockMs: 12_345 }),
  );
  const prefs = await loadPrefs(store);
  check('wrong-typed fields are sanitized to defaults', !prefs.sepolia && !prefs.hideAmounts);
  check('an autoLockMs outside the choices is rejected', prefs.autoLockMs === null);
}
check('auto-lock choices are off / 1 min / 5 min', JSON.stringify(AUTO_LOCK_CHOICES.map((c) => c.ms)) === JSON.stringify([null, 60_000, 300_000]));
check("maskAmount hides as ••••", maskAmount('1.2345', true) === '••••');
check('maskAmount passes through when visible', maskAmount('1.2345', false) === '1.2345');

// ---------------------------------------------------------------------------
// 3. Active-chain profiles and pinned Sepolia constants
// ---------------------------------------------------------------------------

console.log('evm chain profiles:');

check('evmProfileFor(false) is mainnet', evmProfileFor(false) === EVM_MAINNET);
check('evmProfileFor(true) is Sepolia', evmProfileFor(true) === EVM_SEPOLIA);
check('mainnet caip2 / chain id', EVM_MAINNET.caip2 === 'eip155:1' && EVM_MAINNET.chainIdDecimal === '1');
check('mainnet caip2 equals send.ts EVM_CHAIN_ID', EVM_MAINNET.caip2 === EVM_CHAIN_ID);
check(
  'sepolia caip2 / chain id 11155111',
  EVM_SEPOLIA.caip2 === 'eip155:11155111' && EVM_SEPOLIA.chainIdDecimal === '11155111',
);
check('sepolia is flagged testnet, mainnet is not', EVM_SEPOLIA.testnet && !EVM_MAINNET.testnet);
check("sepolia amounts are labeled 'test ETH'", EVM_SEPOLIA.displaySymbol === 'test ETH');
check(
  'sepolia RPC is the verified publicnode endpoint',
  EVM_SEPOLIA.defaultRpcUrl === 'https://ethereum-sepolia-rpc.publicnode.com',
);
check(
  'mainnet default RPC matches DEFAULT_NETWORKS (no drift)',
  EVM_MAINNET.defaultRpcUrl === DEFAULT_NETWORKS.find((n) => n.chainId === 'eip155:1').defaultUrl,
);
check(
  'mainnet default RPC candidate list matches DEFAULT_NETWORKS (no drift)',
  EVM_MAINNET.defaultRpcUrls === DEFAULT_NETWORKS.find((n) => n.chainId === 'eip155:1').defaultUrls,
);
check('mainnet explorer base', EVM_MAINNET.explorerTxBase === 'https://etherscan.io/tx/');
check('sepolia explorer base', EVM_SEPOLIA.explorerTxBase === 'https://sepolia.etherscan.io/tx/');

// AA prefill: pinned values, checksummed exactly as the engine computes.
const prefill = EVM_SEPOLIA.aaPrefill;
const checksum = (addr) => toChecksumAddress(toBytes(addr.toLowerCase()));
check('mainnet has no AA prefill', EVM_MAINNET.aaPrefill === null);
check(
  'sepolia AA prefill factory equals the pinned verified address',
  prefill.factory === '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985',
);
check('prefill factory is valid EIP-55', checksum(prefill.factory) === prefill.factory);
check(
  'sepolia AA prefill implementation equals the pinned verified address',
  prefill.implementation.toLowerCase() === '0x68641de71cfea5a5d0d29712449ee254bb1400c2',
);
check('prefill implementation is valid EIP-55', checksum(prefill.implementation) === prefill.implementation);
check("prefill entry point equals the engine's ENTRYPOINT_V07", prefill.entryPoint === ENTRYPOINT_V07);

// Slot resolution (the pure half of config/networks.ts).
{
  const mainnet = resolveActiveNetworks(false);
  const sepolia = resolveActiveNetworks(true);
  check('mainnet mode: EVM slot serves eip155:1', mainnet.find((e) => e.slot === 'eip155:1').network.chainId === 'eip155:1');
  const evmSlot = sepolia.find((e) => e.slot === 'eip155:1');
  check('sepolia mode: EVM slot serves eip155:11155111', evmSlot.network.chainId === 'eip155:11155111');
  check('sepolia slot id stays eip155:1 (accounts/routes unchanged)', evmSlot.slot === 'eip155:1');
  check('sepolia network default URL follows the profile', evmSlot.network.defaultUrl === EVM_SEPOLIA.defaultRpcUrl);
  check('sepolia network candidate list follows the profile', evmSlot.network.defaultUrls === EVM_SEPOLIA.defaultRpcUrls);
  check('SEPOLIA_NETWORK is derived from the profile', SEPOLIA_NETWORK.chainId === EVM_SEPOLIA.caip2 && SEPOLIA_NETWORK.symbol === EVM_SEPOLIA.displaySymbol);
  const untouched = ['bip122:000000000019d6689c085ae165831e93', 'bip122:1a91e3dace36e2be3bf030a65679fe82', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'];
  check(
    'non-EVM slots are identical in both modes',
    untouched.every(
      (id) =>
        mainnet.find((e) => e.slot === id).network === sepolia.find((e) => e.slot === id).network,
    ),
  );
}

// ---------------------------------------------------------------------------
// 4. Active-chain switching through the real send machinery (fake node)
// ---------------------------------------------------------------------------

console.log('send-flow chain switching (fake JSON-RPC node):');

const GWEI = 1000000000n;
const FROM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TO = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const URL = 'http://offline.fake/rpc';

let scenario = { chainId: '0x1' };
let lastRawTx = null;

function rpcResult(method, params) {
  switch (method) {
    case 'eth_chainId':
      return scenario.chainId;
    case 'eth_getBalance':
      return '0x' + (10n ** 18n).toString(16); // 1 ETH
    case 'eth_getTransactionCount':
      return '0x5';
    case 'eth_getBlockByNumber':
      return { baseFeePerGas: '0x' + GWEI.toString(16) };
    case 'eth_maxPriorityFeePerGas':
      return '0x' + GWEI.toString(16);
    case 'eth_estimateGas':
      return '0x5208'; // 21000
    case 'eth_call':
      return '0x';
    case 'eth_sendRawTransaction':
      lastRawTx = params[0];
      return '0x' + 'ab'.repeat(32);
    default:
      throw { code: -32601, message: `unexpected method ${method}` };
  }
}

globalThis.fetch = async (_url, init) => {
  const { method, params, id } = JSON.parse(init.body);
  let body;
  try {
    body = { jsonrpc: '2.0', id, result: rpcResult(method, params) };
  } catch (e) {
    body = { jsonrpc: '2.0', id, error: { code: e.code ?? -32000, message: e.message } };
  }
  return { ok: true, json: async () => body };
};

// Sepolia node (0xaa36a7 = 11155111)
scenario = { chainId: '0xaa36a7' };
const sepoliaQuote = await prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_SEPOLIA.caip2);
check('sepolia-mode quote accepts a Sepolia node', sepoliaQuote.chainId === 11155111n);
await checkRejects(
  'mainnet-mode (default) quote refuses a Sepolia node',
  () => prepareEvmSend(URL, FROM, TO, 1000n),
  /chain id 11155111, expected 1/,
);

// Mainnet node (0x1)
scenario = { chainId: '0x1' };
const mainnetQuote = await prepareEvmSend(URL, FROM, TO, 1000n);
check('mainnet-mode quote accepts a mainnet node', mainnetQuote.chainId === 1n);
await checkRejects(
  'sepolia-mode quote refuses a mainnet node',
  () => prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_SEPOLIA.caip2),
  /chain id 1, expected 11155111/,
);

// sendEvm explorer link follows the active profile.
const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const signer = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);

scenario = { chainId: '0xaa36a7' };
{
  const sent = await sendEvm(URL, signer, sepoliaQuote, EVM_SEPOLIA.explorerTxBase);
  check(
    'sendEvm links to sepolia.etherscan.io in test mode',
    sent.explorerUrl === `https://sepolia.etherscan.io/tx/${sent.txid}`,
  );
  check('sendEvm broadcast a raw transaction', typeof lastRawTx === 'string' && lastRawTx.startsWith('0x02'));
}
scenario = { chainId: '0x1' };
{
  const sent = await sendEvm(URL, signer, mainnetQuote);
  check(
    'sendEvm default keeps the etherscan.io link',
    sent.explorerUrl === `https://etherscan.io/tx/${sent.txid}`,
  );
}

// Explorer helper override (Activity screen path).
const TXID = '0x' + 'cd'.repeat(32);
check('explorerTxUrl default stays etherscan.io', explorerTxUrl('eip155:1', TXID) === `https://etherscan.io/tx/${TXID}`);
check(
  'explorerTxUrl override goes to sepolia.etherscan.io',
  explorerTxUrl('eip155:1', TXID, EVM_SEPOLIA.explorerTxBase) === `https://sepolia.etherscan.io/tx/${TXID}`,
);
check('explorerTxUrl null override yields no link', explorerTxUrl('eip155:1', TXID, null) === null);
check(
  'explorerTxUrl leaves Bitcoin untouched',
  explorerTxUrl('bip122:000000000019d6689c085ae165831e93', TXID, EVM_SEPOLIA.explorerTxBase) ===
    `https://blockstream.info/tx/${TXID}`,
);

// ---------------------------------------------------------------------------
// 5. WalletConnect parameterization (namespace + routing follow the mode)
// ---------------------------------------------------------------------------

console.log('walletconnect chain parameterization:');

const WALLET = signer.address;

function signEvent(chainId, message = '0x68656c6c6f') {
  return {
    id: 1,
    topic: 'topic',
    params: { chainId, request: { method: 'personal_sign', params: [message, WALLET] } },
  };
}

{
  const parsed = parseWcRequest(signEvent('eip155:11155111'), WALLET, EVM_SEPOLIA.caip2);
  check('sepolia-mode accepts an eip155:11155111 request', parsed.kind === 'personal_sign');
}
{
  let error = null;
  try {
    parseWcRequest(signEvent('eip155:11155111'), WALLET);
  } catch (e) {
    error = e;
  }
  check(
    'mainnet-mode declines an eip155:11155111 request with UNSUPPORTED_CHAINS',
    error instanceof WcRequestRejection && error.code === WC_ERRORS.unsupportedChains.code,
  );
}
{
  let error = null;
  try {
    parseWcRequest(signEvent('eip155:1'), WALLET, EVM_SEPOLIA.caip2);
  } catch (e) {
    error = e;
  }
  check(
    'sepolia-mode declines an eip155:1 request with UNSUPPORTED_CHAINS',
    error instanceof WcRequestRejection && error.code === WC_ERRORS.unsupportedChains.code,
  );
}

{
  // Namespace construction against the real @walletconnect/utils builder.
  const proposalParams = {
    id: 7,
    requiredNamespaces: {
      eip155: {
        chains: ['eip155:11155111'],
        methods: ['personal_sign', 'eth_sendTransaction'],
        events: ['accountsChanged', 'chainChanged'],
      },
    },
    optionalNamespaces: {},
  };
  const namespaces = buildWalletNamespaces(proposalParams, WALLET, [EVM_SEPOLIA.caip2]);
  const accounts = namespaces.eip155?.accounts ?? [];
  check(
    'approved namespace carries eip155:11155111 accounts',
    JSON.stringify(accounts) === JSON.stringify([`eip155:11155111:${WALLET}`]),
  );
  let mainnetBuildFailed = false;
  try {
    buildWalletNamespaces(proposalParams, WALLET); // mainnet-only wallet
  } catch {
    mainnetBuildFailed = true;
  }
  check('mainnet-mode cannot approve a sepolia-only proposal', mainnetBuildFailed);

  const summary = describeProposal({ id: 7, params: proposalParams }, [EVM_SEPOLIA.caip2]);
  check('describeProposal (sepolia mode) finds nothing unsupported', summary.unsupportedRequired.length === 0);
  const summaryMainnet = describeProposal({ id: 7, params: proposalParams });
  check(
    'describeProposal (mainnet mode) flags eip155:11155111 as unsupported',
    JSON.stringify(summaryMainnet.unsupportedRequired) === JSON.stringify(['eip155:11155111']),
  );
}

{
  // Typed-data domain chain policy follows the active chain.
  const typedData = JSON.stringify({
    types: { Mail: [{ name: 'contents', type: 'string' }] },
    primaryType: 'Mail',
    domain: { name: 'App', chainId: 11155111 },
    message: { contents: 'hi' },
  });
  const parsed = parseTypedDataV4(typedData, EVM_SEPOLIA.caip2);
  check('typed data for chain 11155111 signs in sepolia mode', parsed.digest.length === 32 && parsed.domain.chainId === 11155111n);
  let refused = false;
  try {
    parseTypedDataV4(typedData);
  } catch {
    refused = true;
  }
  check('typed data for chain 11155111 is refused in mainnet mode', refused);
}

// ---------------------------------------------------------------------------
// 6. AA prefill: verify-before-save under the Sepolia key, no mode mixing
// ---------------------------------------------------------------------------

console.log('aa prefill (sepolia key, verified before save):');

{
  const store = memoryStore();
  const impl = prefill.implementation;
  const sel = (signature) => toHex(encodeFunctionCall(signature, []));
  const pad32 = (address) => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();

  // Fake Sepolia node transport implementing exactly the verifyAaFactory
  // reads (eth_getCode + accountImplementation() + entryPoint()).
  const fakeNode = async (method, params) => {
    if (method === 'eth_getCode') {
      const [address] = params;
      if (same(address, prefill.factory)) return '0x6001';
      if (same(address, impl)) return '0x6002';
      return '0x';
    }
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      if (same(to, prefill.factory) && data === sel('accountImplementation()')) return pad32(impl);
      if (same(to, impl) && data === sel('entryPoint()')) return pad32(ENTRYPOINT_V07);
      throw new Error(`unexpected eth_call to ${to} data ${data}`);
    }
    throw new Error(`unexpected method ${method}`);
  };

  const verification = await setAaFactory(
    EVM_SEPOLIA.caip2,
    prefill.factory,
    'https://offline.fake/sepolia',
    { store, transportFor: () => fakeNode },
  );
  check(
    'saving the prefill re-runs verification and reports the pinned implementation',
    verification.implementation === impl,
  );
  const sepoliaConfig = await getAaConfig(EVM_SEPOLIA.caip2, store);
  check('factory persisted under the sepolia key', sepoliaConfig.factory === prefill.factory);
  check('implementation recorded from the chain, not asserted', sepoliaConfig.factoryImplementation === impl);
  const mainnetConfig = await getAaConfig('eip155:1', store);
  check('mainnet AA config stays untouched (no mode mixing)', mainnetConfig.factory === null && mainnetConfig.bundlerUrl === null);
}

// ---------------------------------------------------------------------------
// Endpoint URL rule (src/config/endpoint-url.ts): https:// only, plain
// http:// only for loopback development hosts; the RPC override setter
// applies it before storing anything.
// ---------------------------------------------------------------------------
console.log('\nendpoint URL rule (https only, loopback http for development):');
{
  check(
    'refusal sentence is the documented one',
    INSECURE_ENDPOINT_MESSAGE ===
      'Endpoints must use https:// (plain http:// is accepted only for localhost or 10.0.2.2 during development).',
  );
  check(
    'loopback list is exactly localhost, 127.0.0.1, ::1, 10.0.2.2',
    JSON.stringify(LOOPBACK_HOSTS) === JSON.stringify(['localhost', '127.0.0.1', '::1', '10.0.2.2']),
  );
  const accepted = [
    [' https://rpc.example/v2/KEY/ ', 'https://rpc.example/v2/KEY'],
    ['HTTPS://rpc.example', 'https://rpc.example'],
    ['https://rpc.example:8443/path?x=1', 'https://rpc.example:8443/path?x=1'],
    ['http://localhost:8545', 'http://localhost:8545'],
    ['http://LOCALHOST:8545/', 'http://LOCALHOST:8545'],
    ['http://127.0.0.1:8545', 'http://127.0.0.1:8545'],
    ['http://[::1]:8545', 'http://[::1]:8545'],
    ['http://10.0.2.2:8545', 'http://10.0.2.2:8545'],
    ['http://user:pass@localhost:8545', 'http://user:pass@localhost:8545'],
  ];
  for (const [input, expected] of accepted) {
    let got;
    try {
      got = assertSecureEndpointUrl(input);
    } catch (e) {
      got = `threw: ${e.message}`;
    }
    check(`accepted: ${JSON.stringify(input)}`, got === expected, String(got));
  }
  const refusedHttp = [
    'http://rpc.example',
    'http://192.168.1.20:8545',
    'http://10.0.2.3:8545',
    'http://127.0.0.2:8545',
    'http://localhost.example.com',
    'http://localhost@rpc.example',
    'http://[::2]:8545',
    'ftp://rpc.example',
    'ws://localhost:8545',
    'rpc.example',
    'not-a-url',
    '',
  ];
  for (const input of refusedHttp) {
    let message = null;
    try {
      assertSecureEndpointUrl(input);
    } catch (e) {
      message = e.message;
    }
    check(`refused with the https sentence: ${JSON.stringify(input)}`, message === INSECURE_ENDPOINT_MESSAGE, String(message));
  }
  const refusedMalformed = ['https://', 'https:///path', 'https://rpc.example:99999', 'https://rpc .example', 'https://[::1'];
  for (const input of refusedMalformed) {
    let message = null;
    try {
      assertSecureEndpointUrl(input);
    } catch (e) {
      message = e.message;
    }
    check(
      `malformed https URL refused with its own message: ${JSON.stringify(input)}`,
      message !== null && message !== INSECURE_ENDPOINT_MESSAGE,
      String(message),
    );
  }

  // setEndpointOverride (config/networks.ts) stores nothing for an http URL.
  const store = memoryStore();
  let message = null;
  try {
    await setEndpointOverride('eip155:1', 'http://rpc.example', { store });
  } catch (e) {
    message = e.message;
  }
  check('RPC override: plain http:// refused with the https sentence', message === INSECURE_ENDPOINT_MESSAGE, String(message));
  check('RPC override: nothing stored after the refusal', (await store.getItem('shiba-wallet.rpc-endpoints.v1')) === null);
  await setEndpointOverride('eip155:1', 'https://rpc.example/', { store });
  await setEndpointOverride('bip122:000000000019d6689c085ae165831e93', 'http://10.0.2.2:3002/api', { store });
  const stored = JSON.parse((await store.getItem('shiba-wallet.rpc-endpoints.v1')) ?? '{}');
  check(
    'RPC override: https saved normalized, loopback http (10.0.2.2) saved',
    stored['eip155:1'] === 'https://rpc.example' &&
      stored['bip122:000000000019d6689c085ae165831e93'] === 'http://10.0.2.2:3002/api',
    JSON.stringify(stored),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

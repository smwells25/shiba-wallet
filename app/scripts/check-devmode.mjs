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
import { contrastRatio, darkTheme, lightTheme, relativeLuminance } from '../src/theme-palette.ts';
import {
  AUTO_LOCK_CHOICES,
  DEFAULT_PREFS,
  loadPrefs,
  maskAmount,
  savePrefs,
} from '../src/config/prefs.ts';
import {
  EVM_ARBITRUM_SEPOLIA,
  EVM_BASE_SEPOLIA,
  EVM_MAINNET,
  l1CostInGasNote,
  EVM_PROFILES,
  EVM_SEPOLIA,
  EVM_TEST_PROFILES,
  evmProfileByCaip2,
  evmProfileFor,
  isTestProfileId,
} from '../src/config/evm-chain.ts';
import {
  BASE_SEPOLIA_NETWORK,
  DEFAULT_NETWORKS,
  TEST_EVM_NETWORKS,
  SEPOLIA_NETWORK,
  networkDefaultFor,
  resolveActiveNetworks,
} from '../src/config/defaults.ts';
import { EVM_CHAIN_ID, maxEvmSend, prepareEvmSend, sendEvm } from '../src/wallet/send.ts';
import { explorerTxUrl } from '../src/wallet/history.ts';
import {
  WcRequestRejection,
  WC_ERRORS,
  buildWalletNamespaces,
  describeChain,
  describeProposal,
  modeMismatchMessage,
  parseTypedDataV4,
  parseWcRequest,
} from '../src/wallet/walletconnect.ts';
import { getAaConfig, setAaFactory } from '../src/wallet/aa.ts';
import { getIndexerConfig, setIndexerUrl } from '../src/wallet/indexer.ts';
import { getNftIndexerConfig } from '../src/wallet/nfts.ts';
import { CONTACT_NETWORK_IDS, addContact, listContacts, validateContactAddress } from '../src/wallet/contacts.ts';
import {
  INSECURE_ENDPOINT_MESSAGE,
  LOOPBACK_HOSTS,
  assertSecureEndpointUrl,
} from '../src/config/endpoint-url.ts';
import {
  getAllEndpoints,
  getEndpoint,
  resetEndpoint,
  setEndpointOverride,
} from '../src/config/networks.ts';

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
let oracleCalls = 0;

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
      // The OP-stack GasPriceOracle predeploy (send.ts asks it on Base
      // Sepolia only): getL1Fee(bytes) 0x49948e0e → 1000 wei,
      // getOperatorFee(uint256) 0x275aedd2 → 0. scripts/check-base.mjs
      // covers the fee math in depth.
      if (params[0].to?.toLowerCase() === '0x420000000000000000000000000000000000000f') {
        oracleCalls += 1;
        return '0x' + (params[0].data.startsWith('0x49948e0e') ? 1000n : 0n).toString(16).padStart(64, '0');
      }
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

// ---------------------------------------------------------------------------
// Load-time https rule for RPC overrides (phase 10 item 5): an override
// stored before setEndpointOverride refused plain http:// is NOT used — the
// chain resolves to its verified defaults as if no override existed — the
// reason is reported on the endpoint for Settings, the stored value stays
// until "Reset to default", and nothing is ever requested from it.
// ---------------------------------------------------------------------------
console.log('\n== RPC override load-time https rule ==');
{
  const realFetch = globalThis.fetch;
  const seen = [];
  // Answers the default-candidate probe (eth_chainId 0x1, Esplora genesis,
  // Solana genesis) for any URL, recording every request.
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    const body = init?.body ? JSON.parse(init.body) : null;
    const result = body?.method === 'eth_chainId' ? '0x1' : body?.method === 'getGenesisHash' ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' : null;
    if (body) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }), text: async () => '' };
    return { ok: true, status: 200, json: async () => ({}), text: async () => '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f' };
  };
  try {
    const store = memoryStore();
    const legacy = JSON.stringify({ 'eip155:1': 'http://rpc.example' });
    await store.setItem('shiba-wallet.rpc-endpoints.v1', legacy);
    const mainnetDefaults = DEFAULT_NETWORKS.find((n) => n.chainId === 'eip155:1').defaultUrls;
    const ep = await getEndpoint('eip155:1', { store });
    check(
      'stored plain http:// override is not used: the chain resolves to a verified default',
      ep?.isOverride === false && mainnetDefaults.includes(ep?.url),
      JSON.stringify({ url: ep?.url, isOverride: ep?.isOverride }),
    );
    check('the refusal reason reaches the endpoint for Settings', ep?.ignoredReason === INSECURE_ENDPOINT_MESSAGE, String(ep?.ignoredReason));
    check('nothing was requested from the ignored URL', !seen.some((u) => u.startsWith('http://rpc.example')), seen.join(', '));
    check('the stored value is left in storage', (await store.getItem('shiba-wallet.rpc-endpoints.v1')) === legacy);
    const all = await getAllEndpoints({ store });
    check(
      'getAllEndpoints: only the affected chain carries the reason',
      all.filter((e) => e.ignoredReason !== undefined).map((e) => e.network.chainId).join(',') === 'eip155:1',
    );
    await resetEndpoint('eip155:1', { store });
    const reset = await getEndpoint('eip155:1', { store });
    check('Reset to default removes the ignored value and its reason', reset?.ignoredReason === undefined && JSON.parse((await store.getItem('shiba-wallet.rpc-endpoints.v1')) ?? '{}')['eip155:1'] === undefined);

    await store.setItem('shiba-wallet.rpc-endpoints.v1', JSON.stringify({ 'eip155:1': 'http://10.0.2.2:8545', 'bip122:000000000019d6689c085ae165831e93': 'https://esplora.example/api/' }));
    const loop = await getEndpoint('eip155:1', { store });
    check('stored loopback http://10.0.2.2 override is still used', loop?.isOverride === true && loop?.url === 'http://10.0.2.2:8545' && loop?.ignoredReason === undefined);
    const btc = await getEndpoint('bip122:000000000019d6689c085ae165831e93', { store });
    check('stored https override is used exactly as stored', btc?.isOverride === true && btc?.url === 'https://esplora.example/api/' && btc?.ignoredReason === undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// Phase 10 item 3: the second test profile (Base Sepolia, eip155:84532), the
// Developer test-network choice and its migration from the old boolean, and
// mode isolation between the two test networks across every per-chain store
// (endpoints, send chain-id checks, WalletConnect, AA, indexer, contacts).
// ---------------------------------------------------------------------------
console.log('\n== Base Sepolia profile and the test-network choice ==');
{
  const B = EVM_BASE_SEPOLIA;
  check('Base Sepolia: CAIP-2 eip155:84532, chain id 84532', B.caip2 === 'eip155:84532' && B.chainIdDecimal === '84532');
  check('Base Sepolia: label, testnet flag, test ETH', B.label === 'Base Sepolia' && B.testnet === true && B.displaySymbol === 'test ETH');
  check('Base Sepolia: explorer sepolia.basescan.org/tx/', B.explorerTxBase === 'https://sepolia.basescan.org/tx/');
  check(
    'Base Sepolia: the three verified keyless RPC candidates, publicnode first',
    JSON.stringify(B.defaultRpcUrls) === JSON.stringify([
      'https://base-sepolia-rpc.publicnode.com',
      'https://sepolia.base.org',
      'https://base-sepolia-testnet.api.pocket.network',
    ]) && B.defaultRpcUrl === B.defaultRpcUrls[0],
  );
  check('Base Sepolia: the transaction-submission-only sequencer URL is not a candidate', !B.defaultRpcUrls.some((u) => u.includes('sequencer')));
  check('Base Sepolia: no SimpleAccount pre-fill (not verified there); Kernel v3.3 verified', B.aaPrefill === null && B.kernelV33Verified === true);
  check('Base Sepolia: flagged as paying an L1 data fee (OP-stack); Ethereum profiles are not', B.l1DataFee === true && !EVM_SEPOLIA.l1DataFee && !EVM_MAINNET.l1DataFee);
  check('Base Sepolia: banner and mode wording name Base Sepolia', B.bannerText?.includes('Base Sepolia') && B.modeLabel === 'Base Sepolia test mode');
  check('mainnet has no banner; Sepolia keeps its wording', EVM_MAINNET.bannerText === null && EVM_SEPOLIA.modeLabel === 'Sepolia test mode');
  check('test profiles listed Sepolia, Base Sepolia, Arbitrum Sepolia', EVM_TEST_PROFILES.map((p) => p.caip2).join() === 'eip155:11155111,eip155:84532,eip155:421614');
  check('EVM_PROFILES = mainnet + test profiles', EVM_PROFILES.length === 1 + EVM_TEST_PROFILES.length && EVM_PROFILES[0] === EVM_MAINNET);
  check('evmProfileFor(Base Sepolia id) / (Sepolia id) / null', evmProfileFor('eip155:84532') === B && evmProfileFor('eip155:11155111') === EVM_SEPOLIA && evmProfileFor(null) === EVM_MAINNET);
  check('evmProfileFor: an unknown id stays on a test network (Sepolia), never mainnet', evmProfileFor('eip155:999') === EVM_SEPOLIA);
  check('evmProfileByCaip2 finds all three and nothing else', evmProfileByCaip2('eip155:84532') === B && evmProfileByCaip2('eip155:1') === EVM_MAINNET && evmProfileByCaip2('eip155:8453') === undefined);
  check('isTestProfileId', isTestProfileId('eip155:84532') && isTestProfileId('eip155:11155111') && !isTestProfileId('eip155:1') && !isTestProfileId(null));

  // Network entries.
  check('BASE_SEPOLIA_NETWORK is derived from the profile', BASE_SEPOLIA_NETWORK.chainId === B.caip2 && BASE_SEPOLIA_NETWORK.defaultUrls === B.defaultRpcUrls && BASE_SEPOLIA_NETWORK.symbol === B.displaySymbol && BASE_SEPOLIA_NETWORK.kind === 'evm-jsonrpc' && BASE_SEPOLIA_NETWORK.decimals === 18);
  check('networkDefaultFor knows both test networks', networkDefaultFor('eip155:84532') === BASE_SEPOLIA_NETWORK && networkDefaultFor('eip155:11155111') === SEPOLIA_NETWORK);
  const baseMode = resolveActiveNetworks('eip155:84532');
  const mainnetMode = resolveActiveNetworks(null);
  const evmSlot = baseMode.find((e) => e.slot === 'eip155:1');
  check('Base Sepolia mode: the EVM slot (id stays eip155:1) serves eip155:84532', evmSlot.network === BASE_SEPOLIA_NETWORK);
  check('Base Sepolia mode: Bitcoin, Dogecoin (Blockbook) and Solana are unchanged', baseMode.filter((e) => e.slot !== 'eip155:1').every((e) => e.network === mainnetMode.find((m) => m.slot === e.slot).network));
  check('resolveActiveNetworks(true) is still Sepolia (legacy callers)', resolveActiveNetworks(true).find((e) => e.slot === 'eip155:1').network === SEPOLIA_NETWORK);
}

console.log('\n== preference migration: the old boolean and the new choice ==');
{
  check('default: mainnet (testNetwork null, sepolia false)', DEFAULT_PREFS.testNetwork === null && DEFAULT_PREFS.sepolia === false);
  const legacy = async (raw) => {
    const store = memoryStore();
    await store.setItem('shiba-wallet.prefs.v1', JSON.stringify(raw));
    return loadPrefs(store);
  };
  let p = await legacy({ sepolia: true, hideAmounts: true, autoLockMs: null, showFiat: true });
  check('old install with sepolia:true and no testNetwork reads as Sepolia', p.testNetwork === 'eip155:11155111' && p.sepolia === true && p.hideAmounts === true);
  p = await legacy({ sepolia: false });
  check('old install with sepolia:false reads as mainnet', p.testNetwork === null && p.sepolia === false);
  p = await legacy({ testNetwork: 'eip155:84532', sepolia: true });
  check('stored Base Sepolia choice reads back', p.testNetwork === 'eip155:84532' && p.sepolia === true);
  p = await legacy({ testNetwork: 'eip155:84532', sepolia: false });
  check('the choice wins over a contradicting boolean (sepolia re-derived)', p.testNetwork === 'eip155:84532' && p.sepolia === true);
  p = await legacy({ testNetwork: null, sepolia: true });
  check('an explicit null choice means mainnet', p.testNetwork === null && p.sepolia === false);
  p = await legacy({ testNetwork: 'eip155:999', sepolia: true });
  check('an unknown stored id with sepolia:true stays in test mode (Sepolia)', p.testNetwork === 'eip155:11155111' && p.sepolia === true);
  p = await legacy({ testNetwork: 'eip155:1' });
  check('a stored mainnet id is not a test network: mainnet', p.testNetwork === null && p.sepolia === false);

  const store = memoryStore();
  let s = await savePrefs({ testNetwork: 'eip155:84532' }, store);
  check('choosing Base Sepolia sets the flag', s.testNetwork === 'eip155:84532' && s.sepolia === true);
  check('…and persists both fields', JSON.parse(await store.getItem('shiba-wallet.prefs.v1')).testNetwork === 'eip155:84532');
  s = await savePrefs({ sepolia: true }, store);
  check('the old setter (sepolia:true) keeps the chosen Base Sepolia', s.testNetwork === 'eip155:84532');
  s = await savePrefs({ sepolia: false }, store);
  check('the old setter (sepolia:false) returns to mainnet', s.testNetwork === null && s.sepolia === false);
  s = await savePrefs({ sepolia: true }, store);
  check('the old setter (sepolia:true) from mainnet picks Sepolia', s.testNetwork === 'eip155:11155111');
  s = await savePrefs({ testNetwork: 'eip155:84532', sepolia: false }, store);
  check('a patch with both fields: the choice wins', s.testNetwork === 'eip155:84532' && s.sepolia === true);
  s = await savePrefs({ testNetwork: null }, store);
  check('choosing Off returns to mainnet', s.testNetwork === null && s.sepolia === false);
  s = await savePrefs({ hideAmounts: false }, store);
  check('an unrelated patch keeps the choice', s.testNetwork === null);
}

console.log('\n== endpoints follow the choice; overrides never cross test networks ==');
{
  const prior = globalThis.fetch;
  const requested = [];
  // Every URL containing "base" answers as Base Sepolia, everything else as
  // Ethereum Sepolia; nothing leaves the process.
  globalThis.fetch = async (url, init) => {
    requested.push(String(url));
    const body = JSON.parse(init.body);
    const result = body.method === 'eth_chainId' ? (String(url).includes('base') ? '0x14a34' : '0xaa36a7') : null;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }), text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) };
  };
  try {
    const store = memoryStore();
    await savePrefs({ testNetwork: 'eip155:84532' }, store);
    const ep = await getEndpoint('eip155:1', { store });
    check('Base Sepolia mode: the Ethereum slot resolves to eip155:84532', ep?.forChainId === 'eip155:1' && ep?.network.chainId === 'eip155:84532');
    check('…through the first default candidate (chain id verified)', ep?.url === 'https://base-sepolia-rpc.publicnode.com' && ep?.isOverride === false && ep?.defaultChoice?.healthy === true);
    check('…and asking for eip155:84532 directly works too', (await getEndpoint('eip155:84532', { store }))?.network.chainId === 'eip155:84532');
    check('…while Ethereum Sepolia is NOT reachable in Base Sepolia mode', (await getEndpoint('eip155:11155111', { store })) === undefined);

    await setEndpointOverride('eip155:11155111', 'https://sepolia-override.example', { store });
    const noLeak = await getEndpoint('eip155:1', { store });
    check('a Sepolia override does not apply in Base Sepolia mode', noLeak?.isOverride === false && noLeak?.url === 'https://base-sepolia-rpc.publicnode.com');
    await setEndpointOverride('eip155:84532', 'https://base-override.example', { store });
    const own = await getEndpoint('eip155:1', { store });
    check('a Base Sepolia override applies in Base Sepolia mode', own?.isOverride === true && own?.url === 'https://base-override.example');
    await savePrefs({ testNetwork: 'eip155:11155111' }, store);
    const sep = await getEndpoint('eip155:1', { store });
    check('switching to Sepolia uses the Sepolia override, not the Base one', sep?.network.chainId === 'eip155:11155111' && sep?.url === 'https://sepolia-override.example');
    await savePrefs({ testNetwork: null }, store);
    const main = await getEndpoint('eip155:1', { store });
    check('Off: mainnet ignores both test overrides', main?.network.chainId === 'eip155:1' && main?.isOverride === false);
    const all = await getAllEndpoints({ store });
    check('getAllEndpoints in mainnet mode lists no test network', !all.some((e) => e.network.testnet || e.network.chainId === 'eip155:84532' || e.network.chainId === 'eip155:11155111'));
    check('no request reached an override URL while it was not active', !requested.some((u) => u.includes('override.example')));
  } finally {
    globalThis.fetch = prior;
  }
}

console.log('\n== send-flow chain-id checks between the two test networks ==');
{
  scenario = { chainId: '0x14a34' };
  oracleCalls = 0;
  const baseQuote = await prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_BASE_SEPOLIA.caip2);
  check('Base Sepolia-mode quote accepts a Base Sepolia node', baseQuote.chainId === 84532n);
  check(
    'Base Sepolia-mode quote asks the GasPriceOracle and adds the L1 data fee reserve (1000 + 50%)',
    oracleCalls === 2 && baseQuote.opStack?.l1DataFee === 1500n && baseQuote.fee === 21000n * 3n * GWEI + 1500n,
  );
  scenario = { chainId: '0xaa36a7' };
  oracleCalls = 0;
  const sepNoOracle = await prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_SEPOLIA.caip2);
  check('Sepolia-mode quote makes no oracle call and has no L1 data fee', oracleCalls === 0 && sepNoOracle.opStack === undefined && sepNoOracle.fee === 21000n * 3n * GWEI);
  scenario = { chainId: '0x14a34' };
  await checkRejects('Sepolia-mode quote refuses a Base Sepolia node', () => prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_SEPOLIA.caip2), /chain id 84532, expected 11155111/);
  await checkRejects('mainnet-mode quote refuses a Base Sepolia node', () => prepareEvmSend(URL, FROM, TO, 1000n), /chain id 84532, expected 1\b/);
  scenario = { chainId: '0xaa36a7' };
  await checkRejects('Base Sepolia-mode quote refuses a Sepolia node', () => prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_BASE_SEPOLIA.caip2), /chain id 11155111, expected 84532/);
  scenario = { chainId: '0x14a34' };
  const sent = await sendEvm(URL, signer, baseQuote, EVM_BASE_SEPOLIA.explorerTxBase);
  check('sendEvm on Base Sepolia links to sepolia.basescan.org', sent.explorerUrl === `https://sepolia.basescan.org/tx/${sent.txid}`);
  check('explorerTxUrl override goes to sepolia.basescan.org', explorerTxUrl('eip155:1', TXID, EVM_BASE_SEPOLIA.explorerTxBase) === `https://sepolia.basescan.org/tx/${TXID}`);
  scenario = { chainId: '0x1' };
}

console.log('\n== WalletConnect follows the Base Sepolia profile ==');
{
  const BASE = EVM_BASE_SEPOLIA.caip2;
  check('Base Sepolia mode accepts an eip155:84532 request', parseWcRequest(signEvent(BASE), WALLET, BASE).kind === 'personal_sign');
  const declined = (event, active) => {
    try {
      parseWcRequest(event, WALLET, active);
      return false;
    } catch (e) {
      return e instanceof WcRequestRejection && e.code === WC_ERRORS.unsupportedChains.code;
    }
  };
  check('Sepolia mode declines an eip155:84532 request (UNSUPPORTED_CHAINS)', declined(signEvent(BASE), EVM_SEPOLIA.caip2));
  check('Base Sepolia mode declines an eip155:11155111 request', declined(signEvent('eip155:11155111'), BASE));
  check('Base Sepolia mode declines an eip155:1 request', declined(signEvent('eip155:1'), BASE));
  const proposal = {
    id: 9,
    requiredNamespaces: {},
    optionalNamespaces: { eip155: { chains: ['eip155:1', 'eip155:11155111', BASE, 'eip155:8453'], methods: ['personal_sign'], events: ['chainChanged'] } },
  };
  const ns = buildWalletNamespaces(proposal, WALLET, [BASE]);
  check('approved namespace carries ONLY eip155:84532 accounts in Base Sepolia mode', JSON.stringify(ns.eip155?.accounts) === JSON.stringify([`${BASE}:${WALLET}`]) && JSON.stringify(ns.eip155?.chains) === JSON.stringify([BASE]));
  check('describeChain names Base Sepolia; Sepolia wording unchanged', describeChain(BASE) === 'Base Sepolia (test network)' && describeChain('eip155:11155111') === 'Ethereum Sepolia (test network)' && describeChain('eip155:8453') === 'eip155:8453');
  check(
    'mode-mismatch sentence for a Base Sepolia dApp in Sepolia mode',
    modeMismatchMessage(BASE, 'eip155:11155111', 'connect') ===
      'This dApp asked for Base Sepolia (test network); the wallet is in Sepolia test mode. Turn on Base Sepolia test mode in Settings → Developer to connect.',
  );
  check(
    'mode-mismatch sentence for a Sepolia dApp is unchanged',
    modeMismatchMessage('eip155:11155111', 'eip155:1', 'connect') ===
      'This dApp asked for Ethereum Sepolia (test network); the wallet is in mainnet mode. Turn on Sepolia test mode in Settings → Developer to connect.',
  );
  const typed = JSON.stringify({ types: { Mail: [{ name: 'contents', type: 'string' }] }, primaryType: 'Mail', domain: { name: 'App', chainId: 84532 }, message: { contents: 'hi' } });
  check('typed data for chain 84532 signs in Base Sepolia mode', parseTypedDataV4(typed, BASE).domain.chainId === 84532n);
  let refused = false;
  try {
    parseTypedDataV4(typed, EVM_SEPOLIA.caip2);
  } catch {
    refused = true;
  }
  check('typed data for chain 84532 is refused in Sepolia mode', refused);
}

console.log('\n== per-chain stores keyed by CAIP-2: AA, history indexer, contacts ==');
{
  const BASE = EVM_BASE_SEPOLIA.caip2;
  const store = memoryStore();
  // A SimpleAccount save under the Sepolia key leaves Base Sepolia empty.
  const sel = (signature) => toHex(encodeFunctionCall(signature, []));
  const pad32 = (address) => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const fakeSimpleNode = (chainIdHex) => async (method, params) => {
    if (method === 'eth_chainId') return chainIdHex;
    if (method === 'eth_getCode') return same(params[0], prefill.factory) || same(params[0], prefill.implementation) ? '0x6001' : '0x';
    if (method === 'eth_call') {
      const [{ to, data }] = params;
      if (same(to, prefill.factory) && data === sel('accountImplementation()')) return pad32(prefill.implementation);
      if (same(to, prefill.implementation) && data === sel('entryPoint()')) return pad32(ENTRYPOINT_V07);
    }
    throw new Error(`unexpected ${method}`);
  };
  await setAaFactory(EVM_SEPOLIA.caip2, prefill.factory, 'https://offline.fake/sepolia', { store, transportFor: () => fakeSimpleNode('0xaa36a7') });
  const baseAa = await getAaConfig(BASE, store);
  check('AA: a Sepolia save leaves the Base Sepolia config empty', baseAa.chain === BASE && baseAa.factory === null && baseAa.bundlerUrl === null && baseAa.factoryVerifiedAt === null);

  // History indexer: verify-before-save checks eth_chainId against the key.
  const indexerStore = memoryStore();
  await checkRejects(
    'indexer: a Sepolia endpoint is refused for the Base Sepolia key',
    () => setIndexerUrl(BASE, 'https://indexer.example', WALLET, { store: indexerStore, transportFor: () => async (m) => (m === 'eth_chainId' ? '0xaa36a7' : null) }),
    /chain id 11155111, expected 84532/,
  );
  await checkRejects(
    'indexer: a Base Sepolia endpoint is refused for the Sepolia key',
    () => setIndexerUrl(EVM_SEPOLIA.caip2, 'https://indexer.example', WALLET, { store: indexerStore, transportFor: () => async (m) => (m === 'eth_chainId' ? '0x14a34' : null) }),
    /chain id 84532, expected 11155111/,
  );
  check('indexer: nothing persisted by the refusals', (await getIndexerConfig(BASE, indexerStore)).url === null && (await getIndexerConfig(EVM_SEPOLIA.caip2, indexerStore)).url === null);
  check('NFT indexer: Base Sepolia starts unconfigured', (await getNftIndexerConfig(BASE, memoryStore())).url === null);

  // Contacts: Base Sepolia is a contact network of its own.
  const contactStore = memoryStore();
  check('contacts: eip155:84532 is a contact network', CONTACT_NETWORK_IDS.includes(BASE));
  check('contacts: EVM addresses validate on Base Sepolia (EIP-55 stored)', validateContactAddress(BASE, '0x000000000000000000000000000000000000dead').ok === true);
  await addContact(BASE, 'Burn', '0x000000000000000000000000000000000000dEaD', { store: contactStore });
  check('contacts: saved under Base Sepolia only', (await listContacts(BASE, contactStore)).length === 1 && (await listContacts(EVM_SEPOLIA.caip2, contactStore)).length === 0 && (await listContacts('eip155:1', contactStore)).length === 0);
  check('contacts: Base mainnet (8453) is still not a contact network', validateContactAddress('eip155:8453', '0x000000000000000000000000000000000000dead').ok === false);

  // Blockbook (Dogecoin) is not affected and still refuses plain overrides.
  await checkRejects('Blockbook chains still refuse a plain RPC override', () => setEndpointOverride('bip122:1a91e3dace36e2be3bf030a65679fe82', 'https://doge.example', { store: memoryStore() }), /Blockbook/);
}

// D1 (phase 11 item 6): text on filled controls meets WCAG 2.2 SC 1.4.3
// "Contrast (Minimum)", 4.5:1 for normal-size text (button labels are 16 px
// semibold, not large text), computed from the exact theme values.
console.log('theme contrast (D1):');
{
  check('luminance helper: white = 1, black = 0', relativeLuminance('#ffffff') === 1 && relativeLuminance('#000000') === 0);
  check('ratio helper: black on white = 21:1', Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-9);
  const before = contrastRatio('#ffffff', '#f0942f');
  check('the finding reproduced: white on the old dark-mode primary was about 2.3:1', before > 2.2 && before < 2.4, before.toFixed(2));
  const pairs = [
    ['dark primary button label (onAccent on accent)', darkTheme.onAccent, darkTheme.accent],
    ['dark selected chip / type button (same primary fill)', darkTheme.onAccent, darkTheme.accent],
    ['dark destructive button label (onDanger on danger)', darkTheme.onDanger, darkTheme.danger],
    ['dark "test networks only" chip and TESTNET badge', darkTheme.onTestnetFill, darkTheme.testnetFill],
    ['dark secondary button label (accent on background)', darkTheme.accent, darkTheme.background],
    ['dark secondary button label (accent on card)', darkTheme.accent, darkTheme.card],
  ];
  for (const [name, fg, bg] of pairs) {
    const ratio = contrastRatio(fg, bg);
    check(`${name} >= 4.5:1`, ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
  }
  check('dark accent kept (only the text on it changed)', darkTheme.accent === '#f0942f');
  check('dark palette kept as phase 11 left it (TESTNET fill and danger unchanged)',
    darkTheme.testnetFill === '#e07800' && darkTheme.danger === '#ef5350' && darkTheme.onTestnetFill === '#101216');
}

// Phase 12 item 4: light mode to WCAG 2.2 SC 1.4.3 as well. White text
// stays on the fills; the two oranges are darkened (hue kept, HSL lightness
// lowered) so that both white text ON them and orange text on the light
// background and cards reach 4.5:1.
console.log('theme contrast (light mode, phase 12 item 4):');
{
  const hue = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const oldAccent = contrastRatio('#ffffff', '#d97a1a');
  const oldTestnet = contrastRatio('#ffffff', '#e07800');
  check('the finding reproduced: white on the old light accent #d97a1a was about 3.1:1', oldAccent > 3.0 && oldAccent < 3.2, oldAccent.toFixed(2));
  check('the finding reproduced: white on the old TESTNET orange #e07800 was about 3.1:1', oldTestnet > 3.0 && oldTestnet < 3.1, oldTestnet.toFixed(2));
  const pairs = [
    ['light primary button / selected chip label (onAccent on accent)', lightTheme.onAccent, lightTheme.accent],
    ['light accent text on background (links, secondary buttons)', lightTheme.accent, lightTheme.background],
    ['light accent text on card (links inside cards)', lightTheme.accent, lightTheme.card],
    ['light TESTNET badge (onTestnetFill on testnetFill)', lightTheme.onTestnetFill, lightTheme.testnetFill],
    ['light TESTNET orange text on background (network lines)', lightTheme.testnetFill, lightTheme.background],
    ['light TESTNET orange text on card', lightTheme.testnetFill, lightTheme.card],
    ['light destructive button label (onDanger on danger)', lightTheme.onDanger, lightTheme.danger],
    ['light Mainnet badge (danger on dangerSurface)', lightTheme.danger, lightTheme.dangerSurface],
    ['light warning text on warningSurface', lightTheme.warningText, lightTheme.warningSurface],
    ['light muted text on background', lightTheme.textMuted, lightTheme.background],
    ['light success text on background', lightTheme.success, lightTheme.background],
  ];
  for (const [name, fg, bg] of pairs) {
    const ratio = contrastRatio(fg, bg);
    check(`${name} >= 4.5:1`, ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
  }
  check('light oranges keep their hue (accent ~30°, TESTNET ~32°, within 1°)',
    Math.abs(hue(lightTheme.accent) - hue('#d97a1a')) < 1 && Math.abs(hue(lightTheme.testnetFill) - hue('#e07800')) < 1,
    `${hue(lightTheme.accent).toFixed(1)}° / ${hue(lightTheme.testnetFill).toFixed(1)}°`);
  check('light oranges are darker than before (relative luminance lower)',
    relativeLuminance(lightTheme.accent) < relativeLuminance('#d97a1a') && relativeLuminance(lightTheme.testnetFill) < relativeLuminance('#e07800'));
  check('light fills still carry white text', lightTheme.onAccent === '#ffffff' && lightTheme.onTestnetFill === '#ffffff' && lightTheme.onDanger === '#ffffff');
}

// The TESTNET badges and network lines take their colours from the theme
// (no hard-coded orange or white) in the screens this check owns. Swap,
// Sessions and the WalletConnect sheet are tracked separately.
console.log('theme tokens in screens (phase 12 item 4):');
{
  const { readFileSync } = await import('node:fs');
  const files = [
    '../src/screens/PasskeyScreen.tsx',
    '../src/screens/UpgradeAccountScreen.tsx',
    '../src/components/RecoveryViews.tsx',
    '../src/screens/GuardiansScreen.tsx',
    '../src/screens/RecoverAccountScreen.tsx',
    '../src/screens/ApproveRecoveryScreen.tsx',
    '../src/screens/OwnerRotationScreen.tsx',
    '../src/screens/NftsScreen.tsx',
    '../src/screens/ActivityScreen.tsx',
    '../src/screens/ApprovalsScreen.tsx',
  ];
  for (const f of files) {
    const src = readFileSync(new globalThis.URL(f, import.meta.url), 'utf8');
    check(`${f.split('/').pop()}: no hard-coded TESTNET orange`, !/#e07800|#a85a00/i.test(src));
  }
  // Phase 12 rehearsal finding 6: the app-wide TESTNET banner in App.tsx was
  // still white on #e07800 (2.3:1 in dark mode).
  {
    const app = readFileSync(new globalThis.URL('../App.tsx', import.meta.url), 'utf8');
    const banner = app.slice(app.indexOf('function TestnetBanner'), app.indexOf('function Root'));
    check('App.tsx TESTNET banner: no hard-coded orange or white anywhere in the file',
      !/#e07800|#a85a00/i.test(app) && !/'#ffffff'|'#fff'|'white'/i.test(app));
    check('App.tsx TESTNET banner: background theme.testnetFill, text theme.onTestnetFill',
      /backgroundColor: theme\.testnetFill/.test(banner) && /color: theme\.onTestnetFill/.test(banner) && /const theme = useTheme\(\);/.test(banner));
  }
  for (const f of ['../src/screens/PasskeyScreen.tsx', '../src/screens/UpgradeAccountScreen.tsx', '../src/components/RecoveryViews.tsx']) {
    const src = readFileSync(new globalThis.URL(f, import.meta.url), 'utf8');
    check(`${f.split('/').pop()}: TESTNET badge uses testnetFill / onTestnetFill`,
      /backgroundColor: theme\.testnetFill, borderColor: theme\.testnetFill/.test(src) && /color: theme\.onTestnetFill/.test(src));
  }
}


// Phase 14 item 3: the third test profile, Arbitrum Sepolia (eip155:421614),
// an Arbitrum Nitro rollup whose layer-1 cost is folded into gas (not an
// OP-stack chain), and the rule that nothing assumes a number of test
// networks.
console.log('\n== Arbitrum Sepolia profile (third test network) ==');
{
  const A = EVM_ARBITRUM_SEPOLIA;
  check('Arbitrum Sepolia: CAIP-2 eip155:421614, chain id 421614', A.caip2 === 'eip155:421614' && A.chainIdDecimal === '421614');
  check('Arbitrum Sepolia: label, testnet flag, test ETH, Arbiscan', A.label === 'Arbitrum Sepolia' && A.testnet === true && A.displaySymbol === 'test ETH' && A.explorerTxBase === 'https://sepolia.arbiscan.io/tx/');
  check('Arbitrum Sepolia: the three verified keyless RPC candidates, publicnode first',
    A.defaultRpcUrls.join() === 'https://arbitrum-sepolia-rpc.publicnode.com,https://sepolia-rollup.arbitrum.io/rpc,https://arb-sepolia-testnet.api.pocket.network' &&
      A.defaultRpcUrl === A.defaultRpcUrls[0] && A.defaultRpcUrls.every((u) => u.startsWith('https://')));
  check('Arbitrum Sepolia: the send-only sequencer URL is not a candidate', !A.defaultRpcUrls.some((u) => u.includes('sequencer')));
  check('Arbitrum Sepolia: NOT an OP-stack chain (no L1-data-fee oracle path); L1 cost is in the gas', A.l1DataFee === false && A.l1CostInGas === true &&
    !EVM_BASE_SEPOLIA.l1CostInGas && !EVM_SEPOLIA.l1CostInGas && !EVM_MAINNET.l1CostInGas);
  check('Arbitrum Sepolia: Kernel v3.3 verified, no SimpleAccount pre-fill, no swaps', A.kernelV33Verified === true && A.aaPrefill === null && A.swapsOffered === false);
  check('Arbitrum Sepolia: banner and mode wording', A.bannerText === 'TESTNET — Arbitrum Sepolia test mode is on. Amounts are test ETH, not real funds.' && A.modeLabel === 'Arbitrum Sepolia test mode');
  check('Arbitrum Sepolia: listed third; evmProfileFor / evmProfileByCaip2 / isTestProfileId know it; Arbitrum One does not exist here',
    EVM_TEST_PROFILES[2] === A && evmProfileFor('eip155:421614') === A && evmProfileByCaip2('eip155:421614') === A && isTestProfileId('eip155:421614') &&
      evmProfileByCaip2('eip155:42161') === undefined && !isTestProfileId('eip155:42161'));
  const row = networkDefaultFor('eip155:421614');
  check('its network row is derived from the profile (no hand-written list to forget)', row?.chainId === A.caip2 && row.defaultUrls === A.defaultRpcUrls && row.symbol === 'test ETH' && row.kind === 'evm-jsonrpc' &&
    row.note === 'Arbitrum Sepolia test network — balances and sends here are test ETH, not real funds.');
  check('TEST_EVM_NETWORKS follows EVM_TEST_PROFILES one to one; the older rows are unchanged',
    TEST_EVM_NETWORKS.map((n) => n.chainId).join() === EVM_TEST_PROFILES.map((p) => p.caip2).join() && TEST_EVM_NETWORKS[0] === SEPOLIA_NETWORK && TEST_EVM_NETWORKS[1] === BASE_SEPOLIA_NETWORK);
  const arbMode = resolveActiveNetworks('eip155:421614');
  check('Arbitrum Sepolia mode: the EVM slot (eip155:1) serves eip155:421614; other chains unchanged',
    arbMode.find((e) => e.slot === 'eip155:1')?.network === row && arbMode.filter((e) => e.slot !== 'eip155:1').every((e) => e.network === resolveActiveNetworks(null).find((m) => m.slot === e.slot).network));
  const store = memoryStore();
  let p = await savePrefs({ testNetwork: 'eip155:421614' }, store);
  check('choosing Arbitrum Sepolia persists and sets the test flag', p.testNetwork === 'eip155:421614' && p.sepolia === true && JSON.parse(await store.getItem('shiba-wallet.prefs.v1')).testNetwork === 'eip155:421614');
  p = await loadPrefs(store);
  check('…and reads back', p.testNetwork === 'eip155:421614');
  check('the Settings note for Arbitrum says the L1 cost is inside the gas estimate and names the swap limit',
    l1CostInGasNote(A) === 'Arbitrum Sepolia is a layer-2 network that charges for publishing its data on Ethereum as extra gas, not as a separate fee: the network’s own gas estimate already includes it, so the max network fee on the confirm screen covers the whole cost, and Max leaves exactly that. The estimate can move with Ethereum’s fees; if it rises before the transaction is included, the network refuses it and nothing is charged. Swaps are not offered here (0x does not support Arbitrum Sepolia).');

  // The EOA quote and Max on Arbitrum: gas × max fee from eth_estimateGas (which includes the L1 part), no oracle call.
  scenario = { chainId: '0x66eee' };
  oracleCalls = 0;
  const q = await prepareEvmSend(URL, FROM, TO, 1000n, undefined, A.caip2);
  check('Arbitrum Sepolia-mode quote accepts an Arbitrum Sepolia node', q.chainId === 421614n);
  check('…makes NO GasPriceOracle call and adds no L1 data fee: fee = estimated gas × max fee', oracleCalls === 0 && q.opStack === undefined && q.fee === 21000n * 3n * GWEI);
  const max = await maxEvmSend(URL, FROM, TO);
  check('Max (chain from the node) = balance − estimated gas × max fee, no oracle call', max === 10n ** 18n - 21000n * 3n * GWEI && oracleCalls === 0, `${max}`);
  await checkRejects('Arbitrum Sepolia-mode quote refuses a Base Sepolia node', async () => {
    scenario = { chainId: '0x14a34' };
    return prepareEvmSend(URL, FROM, TO, 1000n, undefined, A.caip2);
  }, /chain id 84532, expected 421614/);
  scenario = { chainId: '0x66eee' };
  await checkRejects('Base Sepolia-mode quote refuses an Arbitrum Sepolia node', () => prepareEvmSend(URL, FROM, TO, 1000n, undefined, EVM_BASE_SEPOLIA.caip2), /chain id 421614, expected 84532/);
  const sent = await sendEvm(URL, signer, q, A.explorerTxBase);
  check('sendEvm on Arbitrum Sepolia links to sepolia.arbiscan.io', sent.explorerUrl === `https://sepolia.arbiscan.io/tx/${sent.txid}`);
  scenario = { chainId: '0x1' };

  // WalletConnect names it from the profile table.
  check('WalletConnect: describeChain names Arbitrum Sepolia; requests for it are accepted only in its mode',
    describeChain('eip155:421614') === 'Arbitrum Sepolia (test network)' &&
      parseWcRequest(signEvent('eip155:421614'), WALLET, 'eip155:421614').kind === 'personal_sign' &&
      (() => { try { parseWcRequest(signEvent('eip155:421614'), WALLET, EVM_BASE_SEPOLIA.caip2); return false; } catch (e) { return e instanceof WcRequestRejection; } })());
  check('WalletConnect: mode-mismatch sentence for an Arbitrum Sepolia dApp in mainnet mode',
    modeMismatchMessage('eip155:421614', 'eip155:1', 'connect') ===
      'This dApp asked for Arbitrum Sepolia (test network); the wallet is in mainnet mode. Turn on Arbitrum Sepolia test mode in Settings → Developer to connect.',
    modeMismatchMessage('eip155:421614', 'eip155:1', 'connect'));

  // No source in the owned files assumes how many test networks exist.
  const { readFileSync: readFs } = await import('node:fs');
  const read = (rel) => readFs(new globalThis.URL(rel, import.meta.url), 'utf8');
  const settings = read('../src/screens/SettingsScreen.tsx');
  check('Settings → Developer text is built from the profiles (no hand-written network list)',
    settings.includes('{DEVELOPER_TEST_NETWORK_HINT}') && !settings.includes('Sepolia (chain id 11155111) or Base Sepolia') && !settings.includes('between\n          the two test networks'));
  check('readiness hints are built from the profiles', !read('../src/config/readiness.ts').includes("'Turn on a test network (Ethereum Sepolia or Base Sepolia)"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

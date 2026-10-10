// Exercises custom EVM networks (feature 33, src/wallet/custom-networks.ts)
// fully offline: an in-memory store stands in for AsyncStorage and a fake
// fetch stands in for the user's RPC endpoint. Nothing touches the network.
//
// Covered: input validation and every refusal sentence (chain id format,
// built-in and custom collisions, the test-network allow-list, names,
// symbol, decimals, the https rule, the explorer form, the count), the
// verify-before-save reads (eth_chainId equal to the typed id, the head
// block's age, the measured block time, timeouts), the store's strict parse
// and read-only state with Reset, the single read path (loadPrefs hydrates
// the registry), the profile exposure (evmProfileFor / evmProfileByCaip2,
// the active networks, readiness as main or test network, no Kernel
// pre-fill, no swaps, no layer-2 fee model, tokens and contacts per chain,
// WalletConnect wording, the risk module's block-time threshold, no prices,
// no ENS), removal deleting exactly that chain's entries in every store it
// reaches, and mutation checks (a built-in collision allowed, the test tick
// honoured for an unlisted id, a store left behind by removal, a stale head
// accepted, a chain-id mismatch accepted).
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-custom-networks.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cn from '../src/wallet/custom-networks.ts';
import * as evm from '../src/config/evm-chain.ts';
import { FEATURE_READINESS, FeatureNotAllowedError, assertFeatureAllowed, isFeatureAllowed, isTestNetwork } from '../src/config/readiness.ts';
import { loadPrefs, savePrefs } from '../src/config/prefs.ts';
import { networkDefaultFor, resolveActiveNetworks, SEPOLIA_NETWORK } from '../src/config/defaults.ts';
import { INSECURE_ENDPOINT_MESSAGE } from '../src/config/endpoint-url.ts';
import { defaultTokensForChain, isTokenChain, listTokens, addToken, tokenStoreKey } from '../src/wallet/tokens.ts';
import { KERNEL_PREFILL, aaKernelPrefillFor, getAaConfig } from '../src/wallet/aa.ts';
import { addContact, listContacts, validateContactAddress } from '../src/wallet/contacts.ts';
import { describeChain } from '../src/wallet/walletconnect.ts';
import { newContractThresholdBlocks, secondsPerBlockFor, NEW_CONTRACT_THRESHOLD_BLOCKS } from '../src/wallet/risk.ts';
import { loadNotes, saveNote } from '../src/wallet/notes.ts';
import { NATIVE_TOKEN, listSpendingScopes, saveSpendingPolicy } from '../src/wallet/spending-policy.ts';
import { BROWSER_CONNECTIONS_KEY } from '../src/wallet/browser-sites.ts';
import { nativePriceAssetId } from '../src/wallet/prices.ts';
import { ensRegistryFor } from '../src/wallet/ens-names.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}

async function rejects(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function syncRejects(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function memoryStore(initial = {}, { withRemove = true, failReads = false } = {}) {
  const map = new Map(Object.entries(initial));
  const store = {
    map,
    writes: 0,
    reads: new Map(),
    failReads,
    async getItem(key) {
      store.reads.set(key, (store.reads.get(key) ?? 0) + 1);
      if (store.failReads) throw new Error('storage unavailable');
      return map.has(key) ? map.get(key) : null;
    },
    async setItem(key, value) {
      store.writes += 1;
      map.set(key, value);
    },
  };
  if (withRemove) {
    store.removeItem = async (key) => {
      map.delete(key);
    };
  }
  return store;
}

const NOW_MS = Date.parse('2026-10-10T12:00:00Z');
const NOW_S = NOW_MS / 1000;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

/**
 * A fake JSON-RPC endpoint. `chainId` (decimal) is what eth_chainId answers;
 * `head` the newest block; `blockTimeS` the seconds per block used for the
 * block 100 below the head. Overrides per method can throw or return.
 */
function fakeRpc({ chainId = '560048', headNumber = 1_000_000n, headAgeS = 6, blockTimeS = 12, methods = {} } = {}) {
  const calls = [];
  const headTs = NOW_S - headAgeS;
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params });
    const answer = (result) => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
    if (methods[body.method]) return methods[body.method](body.params, answer);
    if (body.method === 'eth_chainId') return answer(hex(chainId));
    if (body.method === 'eth_getBlockByNumber') {
      const tag = body.params[0];
      if (tag === 'latest') return answer({ number: hex(headNumber), timestamp: hex(headTs) });
      const n = BigInt(tag);
      return answer({ number: hex(n), timestamp: hex(headTs - Number(headNumber - n) * blockTimeS) });
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }) };
  };
  return { fetchFn, calls };
}

const HOODI = 'eip155:560048';
const POLYGON = 'eip155:137';
const SEPOLIA = 'eip155:11155111';
const HOODI_INPUT = {
  name: 'Hoodi',
  chainId: '560048',
  rpcUrl: 'https://ethereum-hoodi-rpc.publicnode.com',
  nativeSymbol: 'ETH',
  nativeDecimals: '18',
  explorerUrl: 'https://hoodi.etherscan.io/',
  testnet: true,
};
const POLYGON_INPUT = {
  name: 'Polygon PoS',
  chainId: '137',
  rpcUrl: 'https://polygon-rpc.example.org/key/abc',
  nativeSymbol: 'POL',
  nativeDecimals: '18',
  explorerUrl: '',
  testnet: false,
};
const opts = (rpc, store) => ({ store, fetchFn: rpc.fetchFn, now: () => NOW_MS, clock: () => new Date(NOW_MS) });

// ---------------------------------------------------------------------------
console.log('Validation and refusal sentences (no network)');
// ---------------------------------------------------------------------------
{
  const v = (patch, existing = []) => syncRejects(() => cn.validateCustomNetworkInput({ ...POLYGON_INPUT, ...patch }, existing));
  for (const bad of ['', '0', '01', '1.5', '-5', 'abc', ' 12 3', '9007199254740992', '99999999999999999']) {
    check(`chain id "${bad}" refused with the format sentence`, v({ chainId: bad }) === cn.CHAIN_ID_FORMAT_MESSAGE, v({ chainId: bad }));
  }
  check('the largest accepted chain id is 2^53 − 1', cn.parseCustomChainId('9007199254740991') === '9007199254740991' && cn.MAX_CUSTOM_CHAIN_ID === 2n ** 53n - 1n);
  check('format sentence (exact)', cn.CHAIN_ID_FORMAT_MESSAGE === 'Enter the chain id as a whole number from 1 to 9007199254740991 (digits only, no leading zeros).');
  check('collision with Ethereum mainnet refused: "already built in"',
    v({ chainId: '1' }) === 'Chain id 1 is already built in as Ethereum mainnet; choose it in the network list above instead. Nothing was saved.', v({ chainId: '1' }));
  for (const p of evm.EVM_TEST_PROFILES) {
    check(`collision with ${p.label} refused`, v({ chainId: p.chainIdDecimal }) === `Chain id ${p.chainIdDecimal} is already built in as ${p.label}; choose it in the network list above instead. Nothing was saved.`);
  }
  const existing = [{ chainId: '137', name: 'Polygon PoS', rpcUrl: 'https://a.example', nativeSymbol: 'POL', nativeDecimals: 18, explorerUrl: null, testnet: false, blockTimeMs: 2000, addedAt: '2026-10-10T00:00:00.000Z' }];
  check('collision with another custom network refused (names it)', v({ name: 'Other' }, existing) === 'Chain id 137 is already added as “Polygon PoS”. Nothing was saved.', v({ name: 'Other' }, existing));
  check('an unlisted id with the test tick is refused with a sentence',
    v({ testnet: true }) === cn.unlistedTestNetworkMessage('137') &&
      cn.unlistedTestNetworkMessage('137') ===
        'Chain id 137 is not on this wallet’s list of well-known public test networks (Holesky (17000), Hoodi (560048), ' +
          'OP Sepolia (11155420), Polygon Amoy (80002), Linea Sepolia (59141), Scroll Sepolia (534351)), so it cannot be ' +
          'added as a test network: the wallet would then treat its funds as worthless and allow features that are ' +
          'switched off where funds are real. Untick “This is a test network” to add it as a main network. Nothing was saved.',
    v({ testnet: true }));
  check('an allow-listed id with the tick is accepted', v({ chainId: '560048', name: 'Hoodi', testnet: true }) === null);
  check('an allow-listed id WITHOUT the tick is accepted as a main network (the safe direction)', v({ chainId: '17000', name: 'My chain' }) === null);
  check('http RPC URL refused with the shared https sentence', v({ rpcUrl: 'http://rpc.example.org' }) === INSECURE_ENDPOINT_MESSAGE);
  check('…and an http look-alike of localhost too', v({ rpcUrl: 'http://localhost@evil.example' }) === INSECURE_ENDPOINT_MESSAGE);
  check('the shared development exception (http on a loopback host) still applies', v({ rpcUrl: 'http://127.0.0.1:8545' }) === null);
  check('decimals other than 18 refused (exact)',
    v({ nativeDecimals: '6' }) === 'This wallet handles a network’s own coin with 18 decimals only (every amount, fee and Max on the Ethereum screens assumes 18), so a coin with 6 decimals cannot be added. Nothing was saved.', v({ nativeDecimals: '6' }));
  check('non-numeric decimals refused', v({ nativeDecimals: 'x' }) === cn.DECIMALS_FORMAT_MESSAGE);
  for (const bad of ['', 'E T H', 'ABCDEFGHIJK', 'ETH!', 'Ξ']) {
    check(`symbol "${bad}" refused`, v({ nativeSymbol: bad }) === cn.NATIVE_SYMBOL_MESSAGE);
  }
  check('empty name refused', v({ name: '  ' }) === 'Enter a name for this network.');
  check('long name refused', v({ name: 'x'.repeat(33) }) === 'Network names can be at most 32 characters (this one is 33).');
  check('a built-in network’s name refused', v({ name: 'ethereum sepolia' }) === cn.builtInNameMessage('ethereum sepolia') &&
    v({ name: 'Ethereum mainnet' }) === cn.builtInNameMessage('Ethereum mainnet'));
  check('another custom network’s name refused', v({ chainId: '10', name: 'polygon pos' }, existing) === 'You already have a network named “Polygon PoS”. Choose another name so the two can never be confused. Nothing was saved.');
  check('a main network named like a test network refused (exact)',
    v({ name: 'My Testnet' }) === 'A network the wallet treats as a main network cannot have a name that sounds like a test network (“test”), because its funds may be real. If it is one of the well-known public test networks, tick “This is a test network”. Nothing was saved.',
    v({ name: 'My Testnet' }));
  check('control and bidi characters are stripped from the name', cn.validateCustomNetworkInput({ ...POLYGON_INPUT, name: 'Poly‮gon' }, []).name === 'Polygon');
  for (const bad of ['http://scan.example', 'https://scan.example/?q=1', 'https://scan.example/#x', 'https://user@scan.example', 'ftp://scan.example', 'https://']) {
    check(`explorer "${bad}" refused`, v({ explorerUrl: bad }) === cn.EXPLORER_URL_MESSAGE, v({ explorerUrl: bad }));
  }
  check('explorer normalized (no trailing slash)', cn.validateCustomNetworkInput({ ...POLYGON_INPUT, explorerUrl: 'https://polygonscan.com/' }, []).explorerUrl === 'https://polygonscan.com');
  const ten = Array.from({ length: 10 }, (_, i) => ({ ...existing[0], chainId: String(1000 + i), name: `Net ${i}` }));
  check('the eleventh network refused (exact)', v({}, ten) === 'This phone already keeps 10 custom networks, the most the wallet stores. Remove one first. Nothing was saved.');
  check('the native-symbol note says the symbol is the user’s word',
    cn.NATIVE_SYMBOL_NOTE === 'The coin’s symbol is your word: EVM networks do not publish their coin’s symbol on-chain, so the wallet cannot check it and shows it exactly as you type it.');
}

// ---------------------------------------------------------------------------
console.log('Verify before save (fake RPC)');
// ---------------------------------------------------------------------------
{
  const store = memoryStore();
  const wrong = fakeRpc({ chainId: '1' });
  let e = await rejects(() => cn.addCustomNetwork(HOODI_INPUT, opts(wrong, store)));
  check('chain-id mismatch refused with both numbers (exact)',
    e === 'This RPC endpoint serves chain id 1, but you entered chain id 560048. Nothing was saved. Check the chain id or the RPC URL.', e);
  check('…nothing stored', !store.map.has(cn.CUSTOM_NETWORKS_KEY) && evm.evmProfileByCaip2(HOODI) === undefined);

  const stale = fakeRpc({ headAgeS: 3600 });
  e = await rejects(() => cn.addCustomNetwork(HOODI_INPUT, opts(stale, store)));
  check('stale head refused with its age (exact)',
    e === 'The newest block this endpoint reports (block 1000000) is 60 minutes old, more than the 10 minutes allowed, so the network looks stopped or the endpoint is behind. Nothing was saved. Try another RPC endpoint, or check this phone’s clock.', e);
  check('…nothing stored', !store.map.has(cn.CUSTOM_NETWORKS_KEY));
  const edge = fakeRpc({ headAgeS: 600 });
  check('a head exactly at the 600 s bound is fresh', (await cn.verifyCustomNetworkEndpoint(HOODI_INPUT.rpcUrl, '560048', { fetchFn: edge.fetchFn, now: () => NOW_MS })).headAgeSeconds === 600);

  const noHead = fakeRpc({ methods: { eth_getBlockByNumber: () => { throw new Error('socket hang up'); } } });
  e = await rejects(() => cn.addCustomNetwork(HOODI_INPUT, opts(noHead, store)));
  check('an unreadable head refuses the save',
    e === 'The RPC endpoint did not return its newest block, so the wallet cannot check that the network is running and up to date. Nothing was saved. (socket hang up)', e);
  const nullHead = fakeRpc({ methods: { eth_getBlockByNumber: (_p, answer) => answer(null) } });
  e = await rejects(() => cn.addCustomNetwork(HOODI_INPUT, opts(nullHead, store)));
  check('a null head refuses the save', e?.startsWith('The RPC endpoint did not return its newest block'), e);

  const noChain = fakeRpc({ methods: { eth_chainId: () => ({ ok: false, status: 503, text: async () => '' }) } });
  e = await rejects(() => cn.addCustomNetwork(HOODI_INPUT, opts(noChain, store)));
  check('no chain id refuses the save', e === 'The RPC endpoint did not answer eth_chainId with a chain id, so the wallet cannot confirm which network it serves. Nothing was saved. (HTTP 503)', e);

  const hang = { fetchFn: () => new Promise(() => {}) };
  e = await rejects(() => cn.addCustomNetwork(HOODI_INPUT, { ...opts(hang, store), timeoutMs: 30 }));
  check('a silent endpoint times out', e?.includes('(no answer within 30 ms)'), e);

  const http = fakeRpc();
  e = await rejects(() => cn.addCustomNetwork({ ...HOODI_INPUT, rpcUrl: 'http://rpc.example.org' }, opts(http, store)));
  check('an http URL is refused before any request', e === INSECURE_ENDPOINT_MESSAGE && http.calls.length === 0);
  const unlisted = fakeRpc({ chainId: '137' });
  e = await rejects(() => cn.addCustomNetwork({ ...POLYGON_INPUT, testnet: true }, opts(unlisted, store)));
  check('an unlisted test id is refused before any request', e === cn.unlistedTestNetworkMessage('137') && unlisted.calls.length === 0);
  check('no refusal wrote anything', store.writes === 0);

  const ok = fakeRpc();
  const { record, verification } = await cn.addCustomNetwork(HOODI_INPUT, opts(ok, store));
  check('reads in order: eth_chainId, latest block, the block 100 below',
    ok.calls.map((c) => `${c.method}:${c.params[0] ?? ''}`).join(',') === `eth_chainId:,eth_getBlockByNumber:latest,eth_getBlockByNumber:${hex(1_000_000n - 100n)}`,
    ok.calls);
  check('every read went to the typed RPC URL', ok.calls.every((c) => c.url === 'https://ethereum-hoodi-rpc.publicnode.com'));
  check('measured block time: 12 s over 100 blocks → 12000 ms', record.blockTimeMs === 12000 && verification.blockTimeMs === 12000);
  check('head facts reported', verification.headNumber === 1_000_000n && verification.headAgeSeconds === 6);
  const raw = JSON.parse(store.map.get(cn.CUSTOM_NETWORKS_KEY));
  check('stored as versioned JSON with exactly the record fields',
    raw.version === 1 && raw.networks.length === 1 &&
      JSON.stringify(Object.keys(raw.networks[0])) === JSON.stringify(['chainId', 'name', 'rpcUrl', 'nativeSymbol', 'nativeDecimals', 'explorerUrl', 'testnet', 'blockTimeMs', 'addedAt']), raw);
  check('stored values normalized', raw.networks[0].explorerUrl === 'https://hoodi.etherscan.io' && raw.networks[0].nativeDecimals === 18 &&
    raw.networks[0].testnet === true && raw.networks[0].addedAt === '2026-10-10T12:00:00.000Z');

  const young = fakeRpc({ chainId: '17000', headNumber: 50n });
  const y = await cn.addCustomNetwork({ ...HOODI_INPUT, chainId: '17000', name: 'Holesky' }, opts(young, store));
  check('fewer than 100 blocks: saved without a block time', y.record.blockTimeMs === null && y.verification.blockTimeUnavailable === 'the chain has fewer than 100 blocks');
  const flat = fakeRpc({ chainId: '80002', blockTimeS: 0 });
  const f = await cn.addCustomNetwork({ ...HOODI_INPUT, chainId: '80002', name: 'Amoy', nativeSymbol: 'POL' }, opts(flat, store));
  check('no time difference over 100 blocks: saved without a block time', f.record.blockTimeMs === null);
  const fast = fakeRpc({ chainId: '11155420', blockTimeS: 2 });
  const fa = await cn.addCustomNetwork({ ...HOODI_INPUT, chainId: '11155420', name: 'OP Sepolia' }, opts(fast, store));
  check('2-second blocks measured as 2000 ms', fa.record.blockTimeMs === 2000);
  e = await rejects(() => cn.addCustomNetwork(HOODI_INPUT, opts(fakeRpc(), store)));
  check('adding the same chain id again is refused', e === 'Chain id 560048 is already added as “Hoodi”. Nothing was saved.', e);
  check('block-time lines', cn.blockTimeLine(12000).startsWith('Block time: about 12 s per block, measured over 100 blocks') &&
    cn.blockTimeLine(null).startsWith('Block time: not measured, so the warning about recently created contracts is not shown'));
}

// ---------------------------------------------------------------------------
console.log('Profile exposure (the registry, prefs, readiness, consumers)');
// ---------------------------------------------------------------------------
const store = memoryStore();
{
  await loadPrefs(store); // hydrates from this (empty) store: the single read path
  check('a fresh store: no custom profiles', evm.customEvmProfiles().length === 0);
  await cn.addCustomNetwork(HOODI_INPUT, opts(fakeRpc(), store));
  await cn.addCustomNetwork(POLYGON_INPUT, opts(fakeRpc({ chainId: '137', blockTimeS: 2 }), store));
  const hoodi = evm.evmProfileByCaip2(HOODI);
  const polygon = evm.evmProfileByCaip2(POLYGON);
  check('evmProfileByCaip2 returns the custom profiles', hoodi?.label === 'Hoodi' && polygon?.label === 'Polygon PoS');
  check('Hoodi (allow-listed, ticked) is a test network: test symbol, banner',
    hoodi.testnet === true && hoodi.displaySymbol === 'test ETH' && hoodi.modeLabel === 'Hoodi test mode' &&
      hoodi.bannerText === 'TESTNET — Hoodi test mode is on (a network you added). Amounts are test ETH, not real funds.');
  check('Polygon (unticked) is a main network: no banner, its own symbol',
    polygon.testnet === false && polygon.bannerText === null && polygon.displaySymbol === 'POL' && polygon.modeLabel === 'Polygon PoS mode (a network you added)');
  check('no Kernel or SimpleAccount pre-fill, no swaps, no layer-2 fee model',
    [hoodi, polygon].every((p) => p.kernelV33Verified === false && p.aaPrefill === null && p.swapsOffered === false && p.l1DataFee === false && p.l1CostInGas === false));
  check('explorer: the Etherscan-family /tx/ path from the user’s base; none → no link',
    hoodi.explorerTxBase === 'https://hoodi.etherscan.io/tx/' && polygon.explorerTxBase === '' &&
      cn.customExplorerAddressUrl({ explorerUrl: 'https://hoodi.etherscan.io' }, '0xabc') === 'https://hoodi.etherscan.io/address/0xabc');
  check('the RPC URL is the profile’s only default candidate', JSON.stringify(polygon.defaultRpcUrls) === JSON.stringify(['https://polygon-rpc.example.org/key/abc']));
  check('built-in profiles unchanged and still first', evm.allEvmProfiles().slice(0, 4).map((p) => p.caip2).join() === evm.EVM_PROFILES.map((p) => p.caip2).join() && evm.EVM_PROFILES.length === 4);
  check('evmProfileFor(custom id) is the custom profile', evm.evmProfileFor(HOODI) === hoodi && evm.evmProfileFor(POLYGON) === polygon);
  check('evmProfileFor(an unregistered id) still resolves to Sepolia, never mainnet', evm.evmProfileFor('eip155:999') === evm.EVM_SEPOLIA);

  let prefs = await savePrefs({ testNetwork: POLYGON }, store);
  check('choosing a custom network persists its id', prefs.testNetwork === POLYGON && prefs.sepolia === true);
  prefs = await loadPrefs(store);
  check('…and reads back through loadPrefs', prefs.testNetwork === POLYGON && evm.evmProfileFor(prefs.testNetwork) === polygon);
  const slot = resolveActiveNetworks(POLYGON).find((n) => n.slot === 'eip155:1');
  check('the Ethereum slot resolves to the custom network’s entry',
    slot.network.chainId === POLYGON && slot.network.label === 'Polygon PoS' && slot.network.decimals === 18 && slot.network.symbol === 'POL' &&
      slot.network.defaultUrls[0] === 'https://polygon-rpc.example.org/key/abc');
  check('networkDefaultFor finds a custom network', networkDefaultFor(HOODI)?.symbol === 'test ETH');
  check('resolveActiveNetworks(an unregistered id) is still Sepolia', resolveActiveNetworks('eip155:999').find((n) => n.slot === 'eip155:1').network === SEPOLIA_NETWORK);

  check('readiness: Hoodi (ticked, allow-listed) is a test network', isTestNetwork(HOODI) && isFeatureAllowed('kernel-smart-account', HOODI) && isFeatureAllowed('session-keys', HOODI));
  check('readiness: Polygon is a MAIN network', !isTestNetwork(POLYGON));
  check('readiness: every feature is allowed on Polygon exactly as on Ethereum mainnet',
    FEATURE_READINESS.every((f) => isFeatureAllowed(f.id, POLYGON) === isFeatureAllowed(f.id, 'eip155:1')));
  const refusal = syncRejects(() => assertFeatureAllowed('kernel-smart-account', POLYGON));
  check('smart-account features stay refused on a custom main network', refusal !== null && (() => { try { assertFeatureAllowed('multisig', POLYGON); return false; } catch (err) { return err instanceof FeatureNotAllowedError; } })());
  // A profile claiming the tick on an unlisted id (never written by the store) is still a main network.
  const saved = evm.customEvmProfiles();
  evm.setCustomEvmProfiles([...saved, { ...polygon, caip2: 'eip155:8453', chainIdDecimal: '8453', label: 'Fake', testnet: true, custom: { ...polygon.custom, testnetRequested: true } }]);
  check('isTestNetwork re-checks the allow-list (a crafted "test" profile on Base mainnet is still main)', !isTestNetwork('eip155:8453'));
  evm.setCustomEvmProfiles(saved);
  check('the registry refuses a built-in chain id (and keeps what it had)',
    syncRejects(() => evm.setCustomEvmProfiles([{ ...polygon, caip2: SEPOLIA, chainIdDecimal: '11155111' }])) !== null &&
      evm.customEvmProfiles().map((p) => p.caip2).join() === saved.map((p) => p.caip2).join());
  check('the registry refuses a profile without custom facts', syncRejects(() => evm.setCustomEvmProfiles([{ ...polygon, custom: undefined }])) !== null);

  check('AA: no Kernel pre-fill on a custom network; built-ins keep it',
    aaKernelPrefillFor(HOODI) === null && aaKernelPrefillFor(POLYGON) === null &&
      aaKernelPrefillFor(SEPOLIA) === KERNEL_PREFILL.factory && aaKernelPrefillFor('eip155:1') === KERNEL_PREFILL.factory);
  check('tokens: custom chains hold tokens and start empty', isTokenChain(HOODI) && defaultTokensForChain(HOODI).length === 0 && (await listTokens(HOODI, store)).length === 0);
  await addToken({ kind: 'fungible', assetId: { chainId: HOODI, namespace: 'erc20', reference: '0x1111111111111111111111111111111111111111' }, symbol: 'TKN', name: 'Token', decimals: 6 }, store);
  check('tokens: a token added on Hoodi is listed on Hoodi only', (await listTokens(HOODI, store)).length === 1 && (await listTokens(POLYGON, store)).length === 0 && store.map.has(tokenStoreKey(HOODI)));
  check('contacts: a registered custom network accepts EVM addresses', validateContactAddress(HOODI, '0x000000000000000000000000000000000000dead').ok === true);
  check('contacts: an unregistered chain still does not', validateContactAddress('eip155:8453', '0x000000000000000000000000000000000000dead').ok === false);
  check('WalletConnect names a custom network as one the user added',
    describeChain(HOODI) === 'Hoodi (a test network you added, chain id 560048)' && describeChain(POLYGON) === 'Polygon PoS (a network you added, chain id 137)' &&
      describeChain(SEPOLIA) === 'Ethereum Sepolia (test network)');
  check('risk: new-contract window = 7 days at the measured block time (rounded up)',
    newContractThresholdBlocks(HOODI) === 50_400n && newContractThresholdBlocks(POLYGON) === 302_400n && secondsPerBlockFor(POLYGON) === 2);
  check('risk: built-in thresholds unchanged', newContractThresholdBlocks('eip155:1') === NEW_CONTRACT_THRESHOLD_BLOCKS['eip155:1'] && newContractThresholdBlocks('eip155:421614') === 2_419_200n);
  check('risk: an unknown chain still has no new-contract check', newContractThresholdBlocks('eip155:8453') === undefined && secondsPerBlockFor('eip155:8453') === 12);
  check('prices: a custom network’s coin is never priced', nativePriceAssetId('eip155:1', POLYGON) === null && nativePriceAssetId('eip155:1', HOODI) === null);
  check('ENS: names are not looked up on a custom network', ensRegistryFor(polygon).ok === false && ensRegistryFor(hoodi).ok === false);
  check('the Settings note names the unknowns', evm.customNetworkNote(polygon).includes('does not detect layer-2 fee models, so on a rollup quotes may be refused or underestimate the fee') &&
    evm.customNetworkNote(polygon).includes('No block explorer was given') && evm.customNetworkNote(hoodi).includes('assume the Etherscan-style paths https://hoodi.etherscan.io/tx/… and /address/…'));

  // The single read path: a store with a saved network and choice, read cold.
  const cold = memoryStore({ [cn.CUSTOM_NETWORKS_KEY]: store.map.get(cn.CUSTOM_NETWORKS_KEY), 'shiba-wallet.prefs.v1': store.map.get('shiba-wallet.prefs.v1') });
  const other = memoryStore();
  await loadPrefs(other);
  check('another store hydrates its own (empty) list', evm.customEvmProfiles().length === 0);
  const coldPrefs = await loadPrefs(cold);
  check('loadPrefs hydrates the registry BEFORE reading the choice (a stored custom choice is kept)',
    coldPrefs.testNetwork === POLYGON && evm.evmProfileFor(coldPrefs.testNetwork).label === 'Polygon PoS');
  await loadPrefs(cold);
  await cn.ensureCustomNetworksLoaded(cold);
  check('the list is read once per store, not on every loadPrefs', cold.reads.get(cn.CUSTOM_NETWORKS_KEY) === 1, cold.reads.get(cn.CUSTOM_NETWORKS_KEY));
  const orphan = memoryStore({ 'shiba-wallet.prefs.v1': JSON.stringify({ testNetwork: POLYGON, sepolia: true }) });
  const orphanPrefs = await loadPrefs(orphan);
  check('a stored custom choice whose network is gone reads as Sepolia (never mainnet funds)', orphanPrefs.testNetwork === SEPOLIA);
  await loadPrefs(store);
}

// ---------------------------------------------------------------------------
console.log('Store discipline (strict parse, read-only, Reset)');
// ---------------------------------------------------------------------------
{
  const good = JSON.parse(store.map.get(cn.CUSTOM_NETWORKS_KEY)).networks[0];
  const doc = (networks) => JSON.stringify({ version: 1, networks });
  const variants = {
    'damaged JSON': '{nope',
    'wrong version': JSON.stringify({ version: 2, networks: [good] }),
    'an extra field': doc([good, { ...good, chainId: '17000', name: 'Holesky', extra: 1 }]),
    'the test tick on an unlisted id': doc([good, { ...good, chainId: '137', name: 'Polygon PoS', testnet: true }]),
    'an http RPC URL': doc([good, { ...good, chainId: '17000', name: 'Holesky', rpcUrl: 'http://rpc.example.org' }]),
    'a name not in sanitized form': doc([good, { ...good, chainId: '17000', name: ' Holesky' }]),
    'a built-in chain id': doc([good, { ...good, chainId: '11155111', name: 'Mine' }]),
    'a duplicate chain id': doc([good, { ...good, name: 'Hoodi 2' }]),
    'decimals other than 18': doc([good, { ...good, chainId: '17000', name: 'Holesky', nativeDecimals: 6 }]),
    'a zero block time': doc([good, { ...good, chainId: '17000', name: 'Holesky', blockTimeMs: 0 }]),
    'eleven networks': doc(Array.from({ length: 11 }, (_, i) => ({ ...good, chainId: String(2000 + i), name: `Net ${i}`, testnet: false }))),
  };
  for (const [what, raw] of Object.entries(variants)) {
    const s = memoryStore({ [cn.CUSTOM_NETWORKS_KEY]: raw });
    const book = await cn.loadCustomNetworks(s);
    const e = await rejects(() => cn.addCustomNetwork(POLYGON_INPUT, opts(fakeRpc({ chainId: '137' }), s)));
    check(`${what}: read-only, writes refused`, book.readOnly === true && e === cn.CUSTOM_NETWORKS_READ_ONLY_MESSAGE && s.writes === 0, { book, e });
  }
  const mixed = memoryStore({ [cn.CUSTOM_NETWORKS_KEY]: variants['an extra field'] });
  await loadPrefs(mixed);
  check('a damaged store still exposes its readable networks', evm.customEvmProfiles().map((p) => p.caip2).join() === HOODI && cn.customNetworksReadOnly());
  check('removal refused on a read-only store', (await rejects(() => cn.removeCustomNetwork(HOODI, { store: mixed }))) === cn.CUSTOM_NETWORKS_READ_ONLY_MESSAGE);
  await savePrefs({ testNetwork: HOODI }, mixed);
  await cn.resetCustomNetworks(mixed);
  check('Reset: an empty, writable list', JSON.parse(mixed.map.get(cn.CUSTOM_NETWORKS_KEY)).networks.length === 0 && !(await cn.loadCustomNetworks(mixed)).readOnly && evm.customEvmProfiles().length === 0);
  check('Reset: an active custom network falls back to Ethereum mainnet', (await loadPrefs(mixed)).testNetwork === null);
  check('Reset sentence', cn.CUSTOM_NETWORKS_READ_ONLY_MESSAGE === 'The saved custom networks could not be read, so nothing was changed. Use “Reset custom networks” in Settings → Developer to start a fresh list.');

  const flaky = memoryStore({ [cn.CUSTOM_NETWORKS_KEY]: store.map.get(cn.CUSTOM_NETWORKS_KEY) }, { failReads: true });
  await cn.ensureCustomNetworksLoaded(flaky);
  check('a storage failure: no networks, read-only', evm.customEvmProfiles().length === 0 && cn.customNetworksReadOnly());
  flaky.failReads = false;
  await cn.ensureCustomNetworksLoaded(flaky);
  check('…and is not remembered: the next call reads again', evm.customEvmProfiles().length === 2);
  await loadPrefs(store);
}

// ---------------------------------------------------------------------------
console.log('Removal deletes exactly that chain’s data');
// ---------------------------------------------------------------------------
const OWNER = '0x000000000000000000000000000000000000dEaD';
const OTHER = '0x1111111111111111111111111111111111111111';
const TX = (b) => '0x' + b.repeat(32);

/** Fills `s` with data for HOODI, Sepolia and POLYGON in every per-chain store. */
async function seedAllStores(s) {
  await addToken({ kind: 'fungible', assetId: { chainId: SEPOLIA, namespace: 'erc20', reference: '0x2222222222222222222222222222222222222222' }, symbol: 'SEP', name: 'Sep', decimals: 6 }, s);
  await addToken({ kind: 'fungible', assetId: { chainId: HOODI, namespace: 'erc20', reference: '0x3333333333333333333333333333333333333333' }, symbol: 'HOO', name: 'Hoo', decimals: 6 }, s);
  await s.setItem('shiba-wallet.rpc-endpoints.v1', JSON.stringify({ [HOODI]: 'https://h.example', [SEPOLIA]: 'https://s.example', [POLYGON]: 'https://p.example' }));
  await s.setItem('shiba-wallet.aa-config.v1', JSON.stringify({ [HOODI]: { bundlerUrl: 'https://b.example/h' }, [SEPOLIA]: { bundlerUrl: 'https://b.example/s' } }));
  await s.setItem('shiba-wallet.evm-indexer.v1', JSON.stringify({ [HOODI]: { url: 'https://i.example/h', verifiedAt: '2026-10-10' }, [SEPOLIA]: { url: 'https://i.example/s', verifiedAt: '2026-10-10' } }));
  await s.setItem('shiba-wallet.nft-indexer.v1', JSON.stringify({ [HOODI]: { url: 'https://n.example/h' }, [SEPOLIA]: { url: 'https://n.example/s' } }));
  await addContact(HOODI, 'Alice', OWNER.toLowerCase(), { store: s });
  await addContact(SEPOLIA, 'Alice', OWNER.toLowerCase(), { store: s });
  await addContact(POLYGON, 'Bob', OTHER, { store: s });
  await saveNote(HOODI, { txid: TX('a1') }, 'hoodi note', { store: s });
  await saveNote(HOODI, { userOpHash: TX('b2') }, 'hoodi op note', { store: s });
  await saveNote(SEPOLIA, { txid: TX('c3') }, 'sepolia note', { store: s });
  const policy = { token: NATIVE_TOKEN, symbol: 'ETH', decimals: 18, cap: 100n, windowSeconds: 86400 };
  await saveSpendingPolicy({ chain: HOODI, owner: OWNER }, policy, [], { store: s, now: NOW_S });
  await saveSpendingPolicy({ chain: SEPOLIA, owner: OWNER }, policy, [], { store: s, now: NOW_S });
  const spend = { token: NATIVE_TOKEN, amount: '5', at: NOW_S, kind: 'transfer', ref: TX('f6') };
  await s.setItem('shiba-wallet.spending-history.v1', JSON.stringify({ version: 1, entries: {
    [`${HOODI}|${OWNER.toLowerCase()}`]: [spend],
    [`${SEPOLIA}|${OWNER.toLowerCase()}`]: [spend],
  } }));
  await s.setItem(BROWSER_CONNECTIONS_KEY, JSON.stringify([
    { origin: 'https://app.example', address: OWNER, owner: OWNER, chain: HOODI, namespaces: {}, approvedAt: 1 },
    { origin: 'https://app.example', address: OWNER, owner: OWNER, chain: SEPOLIA, namespaces: {}, approvedAt: 2 },
  ]));
  await s.setItem('shiba-wallet.wc-smart-bindings.v1', JSON.stringify({
    [`${HOODI}:${OWNER.toLowerCase()}`]: { chain: HOODI, address: OWNER, owner: OWNER, accountIndex: 0, accountType: 'kernel-v3.3', factory: OTHER },
    [`${SEPOLIA}:${OWNER.toLowerCase()}`]: { chain: SEPOLIA, address: OWNER, owner: OWNER, accountIndex: 0, accountType: 'kernel-v3.3', factory: OTHER },
  }));
  await s.setItem('shiba-wallet.wc-calls.v1', JSON.stringify({
    a: { id: 'a', userOpHash: TX('d4'), chain: HOODI, from: OWNER, dappUrl: 'https://x', createdAt: 1 },
    b: { id: 'b', userOpHash: TX('e5'), chain: SEPOLIA, from: OWNER, dappUrl: 'https://x', createdAt: 1 },
  }));
}

/** Every place HOODI data could remain; returns the names of stores that still hold some. */
async function leftovers(s, chain) {
  const left = [];
  const json = (k) => (s.map.has(k) ? JSON.parse(s.map.get(k)) : null);
  if (s.map.has(tokenStoreKey(chain))) left.push('tokens');
  if (chain in (json('shiba-wallet.rpc-endpoints.v1') ?? {})) left.push('endpoint');
  if (chain in (json('shiba-wallet.aa-config.v1') ?? {})) left.push('aa');
  if (chain in (json('shiba-wallet.evm-indexer.v1') ?? {})) left.push('history-indexer');
  if (chain in (json('shiba-wallet.nft-indexer.v1') ?? {})) left.push('nft-indexer');
  if (chain in (json('shiba-wallet.contacts.v1')?.networks ?? {})) left.push('contacts');
  if ((await loadNotes(s)).notes.some((n) => n.network === chain)) left.push('notes');
  if ((await listSpendingScopes(s)).scopes.some((x) => x.scope.chain === chain)) left.push('spending');
  if (Object.keys(json('shiba-wallet.spending-history.v1')?.entries ?? {}).some((k) => k.startsWith(`${chain}|`))) left.push('spending-history');
  if ((json(BROWSER_CONNECTIONS_KEY) ?? []).some((r) => r.chain === chain)) left.push('browser');
  if (Object.values(json('shiba-wallet.wc-smart-bindings.v1') ?? {}).some((r) => r.chain === chain)) left.push('wc-bindings');
  if (Object.values(json('shiba-wallet.wc-calls.v1') ?? {}).some((r) => r.chain === chain)) left.push('wc-calls');
  return left;
}

/** The other chains' share of each store, for a before/after comparison. */
async function othersSnapshot(s) {
  const json = (k) => (s.map.has(k) ? JSON.parse(s.map.get(k)) : null);
  const strip = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => k !== HOODI));
  return JSON.stringify({
    sepTokens: s.map.get(tokenStoreKey(SEPOLIA)),
    endpoints: strip(json('shiba-wallet.rpc-endpoints.v1')),
    aa: strip(json('shiba-wallet.aa-config.v1')),
    idx: strip(json('shiba-wallet.evm-indexer.v1')),
    nft: strip(json('shiba-wallet.nft-indexer.v1')),
    contacts: strip(json('shiba-wallet.contacts.v1')?.networks),
    notes: (await loadNotes(s)).notes.filter((n) => n.network !== HOODI),
    spending: (await listSpendingScopes(s)).scopes.filter((x) => x.scope.chain !== HOODI),
    history: Object.entries(json('shiba-wallet.spending-history.v1')?.entries ?? {}).filter(([k]) => !k.startsWith(`${HOODI}|`)),
    browser: (json(BROWSER_CONNECTIONS_KEY) ?? []).filter((r) => r.chain !== HOODI),
    wcb: Object.values(json('shiba-wallet.wc-smart-bindings.v1') ?? {}).filter((r) => r.chain !== HOODI),
    wcc: Object.values(json('shiba-wallet.wc-calls.v1') ?? {}).filter((r) => r.chain !== HOODI),
  });
}

{
  const s = memoryStore({ [cn.CUSTOM_NETWORKS_KEY]: store.map.get(cn.CUSTOM_NETWORKS_KEY) });
  await loadPrefs(s);
  await seedAllStores(s);
  await savePrefs({ testNetwork: HOODI }, s);
  check('seeded: Hoodi data in every store', (await leftovers(s, HOODI)).length === 12, await leftovers(s, HOODI));
  const othersBefore = await othersSnapshot(s);
  const mainnetTokensBefore = s.map.get('shiba-wallet.tokens.v1');
  const report = await cn.removeCustomNetwork(HOODI, { store: s });
  check('the network is removed and the choice is back on mainnet', report.networkRemoved && report.switchedToMainnet && (await loadPrefs(s)).testNetwork === null);
  check('no Hoodi entry remains in any store', (await leftovers(s, HOODI)).length === 0, await leftovers(s, HOODI));
  check('every other chain’s entries are exactly as before', (await othersSnapshot(s)) === othersBefore);
  check('the mainnet token key was not touched', s.map.get('shiba-wallet.tokens.v1') === mainnetTokensBefore);
  check('the report counts what was deleted',
    JSON.stringify(report.removed.map((r) => `${r.id}:${r.count}`)) ===
      JSON.stringify(['tokens:1', 'endpoint:1', 'aa:1', 'history-indexer:1', 'nft-indexer:1', 'contacts:1', 'notes:2', 'spending:1', 'browser:1', 'walletconnect:2']) &&
      report.failed.length === 0, report.removed);
  check('the registry no longer has Hoodi; Polygon stays', evm.evmProfileByCaip2(HOODI) === undefined && evm.evmProfileByCaip2(POLYGON)?.label === 'Polygon PoS');
  check('the stored list no longer has Hoodi', JSON.parse(s.map.get(cn.CUSTOM_NETWORKS_KEY)).networks.map((n) => n.chainId).join() === '137');
  check('contacts on the removed chain are refused again', validateContactAddress(HOODI, OWNER).ok === false);
  check('Polygon’s contacts kept', (await listContacts(POLYGON, s)).length === 1);
  check('the describeRemoval sentence', cn.describeRemoval('Hoodi', report).startsWith('“Hoodi” was removed. The wallet is back on Ethereum mainnet. Deleted for this chain: tracked tokens (1), endpoint override (1)'));
  check('the confirmation names the data removed and what is kept',
    cn.removalConfirmationText('Hoodi', '560048', true) ===
      'Remove “Hoodi” (chain id 560048) from this wallet? This also deletes, for this chain only: tracked tokens, endpoint override, ' +
        'smart-account settings, history indexer, NFT indexer, contacts, transaction notes, spending limits, in-app browser connections ' +
        'and WalletConnect smart-account records. The wallet switches back to Ethereum mainnet first. ' + cn.KEPT_ON_REMOVAL_SENTENCE);
  check('the AA settings of Sepolia are intact', (await getAaConfig(SEPOLIA, s)).bundlerUrl === 'https://b.example/s');

  // A remover that fails: the network stays listed, the failure is named.
  const s2 = memoryStore({ [cn.CUSTOM_NETWORKS_KEY]: s.map.get(cn.CUSTOM_NETWORKS_KEY) });
  await loadPrefs(s2);
  const failing = [cn.CHAIN_DATA_REMOVERS[0], { id: 'boom', label: 'test store', remove: async () => { throw new Error('disk full'); } }];
  const r2 = await cn.removeCustomNetwork(POLYGON, { store: s2, removers: failing });
  check('a failed deletion keeps the network listed and names the failure',
    !r2.networkRemoved && r2.failed[0]?.reason === 'disk full' && evm.evmProfileByCaip2(POLYGON) !== undefined &&
      cn.describeRemoval('Polygon PoS', r2).includes('was NOT removed') && cn.describeRemoval('Polygon PoS', r2).includes('Could not delete: test store (disk full). Try Remove again.'));
  check('removing an unknown network is refused', (await rejects(() => cn.removeCustomNetwork('eip155:4242', { store: s2 }))) === 'That network is not in your list of custom networks.');
  check('built-in per-chain data can never be deleted by these helpers',
    (await rejects(async () => (await import('../src/wallet/tokens.ts')).forgetTokensForChain('eip155:1', s2))) !== null &&
      (await rejects(async () => (await import('../src/wallet/aa.ts')).forgetAaConfigForChain(SEPOLIA, s2))) !== null &&
      (await rejects(async () => (await import('../src/wallet/contacts.ts')).forgetContactsForNetwork(SEPOLIA, s2))) !== null);
  await loadPrefs(store);
}

// ---------------------------------------------------------------------------
console.log('Settings source checks');
// ---------------------------------------------------------------------------
{
  const settings = readFileSync(join(HERE, '../src/screens/SettingsScreen.tsx'), 'utf8');
  check('the Kernel pre-fill follows the profile (none on a custom network)', settings.includes('prefill={aaKernelPrefillFor(network.chainId)}') && !settings.includes('prefill={KERNEL_PREFILL.factory}'));
  check('"Test mode is ON" is shown from evmChain.testnet, never the sepolia flag', settings.includes('{evmChain.testnet ? (\n          <Text style={[styles.hint, { color: theme.testnetFill }]}>\n            Test mode is ON') && !/\{sepolia \? \(/.test(settings));
  check('Developer shows the custom networks section with chips', settings.includes('<CustomNetworksSection customNetworks={customNetworks} choice={testNetwork} onChoose={setTestNetwork} />') && settings.includes('style={styles.choiceChip}'));
  check('removal asks for the device check when spending limits would be deleted', settings.includes("requireLocalAuth('Remove the network and its spending limits')"));
  // The TESTNET banner (App.tsx, not edited here) shows while the context's
  // `sepolia` is true and falls back to the Sepolia sentence when the
  // profile has no banner text: so `sepolia` must be the ACTIVE PROFILE's
  // test flag, never "a non-mainnet choice is stored".
  const prefsCtx = readFileSync(join(HERE, '../src/wallet/PrefsContext.tsx'), 'utf8');
  const app = readFileSync(join(HERE, '../App.tsx'), 'utf8');
  check('PrefsContext: sepolia is the active profile’s test flag', prefsCtx.includes('sepolia: evmProfileFor(prefs.testNetwork).testnet,') && !prefsCtx.includes('sepolia: prefs.sepolia'));
  check('…which is what the App.tsx TESTNET banner keys off', app.includes("{sepolia && status === 'ready' ? <TestnetBanner /> : null}"));
  check('…so a custom MAIN network never shows the banner', evm.evmProfileFor(POLYGON).testnet === false && evm.evmProfileFor(POLYGON).bannerText === null);
}

// ---------------------------------------------------------------------------
console.log('Mutation checks');
// ---------------------------------------------------------------------------
const MUTANT_DIR = join(HERE, `.mutants-custom-networks-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(relPath, from, to) {
  const original = readFileSync(join(HERE, '..', relPath), 'utf8');
  if (!original.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const source = original.replace(from, to);
  const originalDir = dirname(join(HERE, '..', relPath));
  const absolute = (spec) => pathToFileURL(resolvePath(originalDir, spec)).href;
  const rewritten = source
    .replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${absolute(spec)}'`)
    .replace(/import\('(\.{1,2}\/[^']+)'\)/g, (_m, spec) => `import('${absolute(spec)}')`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
{
  // 1. A built-in collision allowed.
  const m1 = await importMutant('src/wallet/custom-networks.ts', 'if (builtIn) throw new Error(builtInChainMessage(chainId, builtIn));', '');
  check('mutant (built-in collision allowed) is caught', syncRejects(() => m1.validateCustomNetworkInput({ ...POLYGON_INPUT, chainId: '11155111', name: 'Mine' }, [])) === null);

  // 2a. The test tick honoured for an unlisted id at save time.
  const m2 = await importMutant('src/wallet/custom-networks.ts', 'if (testnet && !isKnownPublicTestChainId(chainId)) throw new Error(unlistedTestNetworkMessage(chainId));', '');
  check('mutant (test tick honoured for an unlisted id, save) is caught', syncRejects(() => m2.validateCustomNetworkInput({ ...POLYGON_INPUT, testnet: true }, [])) === null);
  // 2b. …and on read, in the registry.
  const m2b = await importMutant('src/config/evm-chain.ts', "return p?.custom?.testnetRequested === true && isKnownPublicTestChainId(p.chainIdDecimal);", "return p?.custom?.testnetRequested === true;");
  const polygon = evm.evmProfileByCaip2(POLYGON);
  m2b.setCustomEvmProfiles([{ ...polygon, testnet: true, custom: { ...polygon.custom, testnetRequested: true } }]);
  check('mutant (allow-list not re-checked on read) is caught', m2b.isCustomTestNetwork(POLYGON) === true && !isTestNetwork(POLYGON));

  // 3. Removal leaving a store behind (the contacts remover dropped).
  const m3 = await importMutant('src/wallet/custom-networks.ts', 'return forgetContactsForNetwork(chain, store);', 'return 0;');
  const s3 = memoryStore({ [cn.CUSTOM_NETWORKS_KEY]: store.map.get(cn.CUSTOM_NETWORKS_KEY) });
  await loadPrefs(s3);
  await seedAllStores(s3);
  await m3.removeCustomNetwork(HOODI, { store: s3 });
  const left3 = await leftovers(s3, HOODI);
  check('mutant (removal leaving the contacts store) is caught', left3.join() === 'contacts', left3);
  await loadPrefs(store);

  // 4. A stale head accepted.
  const m4 = await importMutant('src/wallet/custom-networks.ts', 'if (stale) throw new Error(staleHeadMessage(head.number, ageSeconds, bound));', '');
  const s4 = memoryStore();
  const e4 = await rejects(() => m4.addCustomNetwork({ ...HOODI_INPUT, chainId: '534351', name: 'Scroll Sepolia' }, opts(fakeRpc({ chainId: '534351', headAgeS: 86_400 }), s4)));
  check('mutant (stale head accepted) is caught', e4 === null && s4.map.has(cn.CUSTOM_NETWORKS_KEY));

  // 5. A chain-id mismatch accepted.
  const m5 = await importMutant('src/wallet/custom-networks.ts', 'if (reported !== chainIdDecimal) throw new Error(chainIdMismatchMessage(reported, chainIdDecimal));', '');
  const s5 = memoryStore();
  const e5 = await rejects(() => m5.addCustomNetwork({ ...HOODI_INPUT, chainId: '59141', name: 'Linea Sepolia' }, opts(fakeRpc({ chainId: '1' }), s5)));
  check('mutant (chain-id mismatch accepted) is caught', e5 === null && s5.map.has(cn.CUSTOM_NETWORKS_KEY));
  await loadPrefs(store);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

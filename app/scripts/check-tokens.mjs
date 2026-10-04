// Exercises the app's ERC-20 token modules (src/wallet/erc20.ts,
// src/wallet/tokens.ts and src/wallet/token-discovery.ts) outside the app:
// the ABI string decoder edge cases offline, the PER-CHAIN token store
// (phase 13 item 1: mainnet, Ethereum Sepolia, Base Sepolia; the legacy
// mainnet key's migration rule; separation checks with controls) against
// an in-memory KeyValueStore, "Find my tokens" against fake indexer and RPC
// transports, and — only
// with --live — the metadata + balanceOf reads against the live default
// Ethereum RPC endpoint, selected exactly as the app selects it (first
// healthy candidate of the ordered default list; read-only eth_call queries
// only; nothing is signed or sent). Without --live the script makes no
// network request, so CI runs its offline checks (scripts/ci/suites.mjs
// classifies it flag-live).
//
// Like check-balances.mjs, it imports the actual TypeScript modules the app
// runs via Node's native type stripping. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-tokens.mjs           # offline checks only
//   node scripts/check-tokens.mjs --live    # plus the live eth_call reads
//
// The balance query uses the address derived from the standard BIP-39 test
// mnemonic ("abandon ... about"), whose addresses are public knowledge.

import { evmKeyProvider, formatAssetId, mnemonicToSeed } from '@shiba-wallet/core';
import { DEFAULT_NETWORKS, TEST_EVM_NETWORKS } from '../src/config/defaults.ts';
import { formatUnits } from '../src/wallet/balances.ts';
import { createDefaultEndpointResolver, describeDefaultChoice } from '../src/config/endpoint-probe.ts';
import {
  USDC_MAINNET,
  decodeAbiString,
  fetchErc20Balance,
  fetchErc20Metadata,
  validateErc20ContractAddress,
} from '../src/wallet/erc20.ts';
import {
  KNOWN_TEST_NETWORK_TOKENS,
  MAINNET_TOKENS_KEY,
  activeTokenChain,
  addToken,
  defaultTokensForChain,
  knownTokensForChain,
  listTokens,
  loadTokenRegistry,
  removeToken,
  tokenStoreKey,
} from '../src/wallet/tokens.ts';
import {
  DISCOVERY_UNSUPPORTED_NOTE,
  FIND_TOKENS_WARNING,
  MAX_DISCOVERY_METADATA,
  cleanTokenText,
  discoverUntrackedTokens,
  discoveryUnavailableNote,
  discoverySummary,
  trackDiscoveredPrompt,
} from '../src/wallet/token-discovery.ts';
import { sanitizeSymbol } from '../src/wallet/simulation.ts';
import { tokenPriceAssetId } from '../src/wallet/prices.ts';
import { savePrefs } from '../src/config/prefs.ts';
import { formatBalanceDisplay, signedDisplay, spokenAmount } from '../src/wallet/balances.ts';
import { readFileSync } from 'node:fs';
import { getAddress } from 'ethers';

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

function checkThrows(name, fn, messagePart) {
  try {
    const value = fn();
    check(name, false, `expected an error, got ${JSON.stringify(value)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, message.includes(messagePart), `error was: ${message}`);
  }
}

// Word helpers for building ABI return data in tests.
const word = (hexByte) => hexByte.padStart(64, '0');
const uintWord = (n) => n.toString(16).padStart(64, '0');
const dataWord = (bytesHex) => bytesHex.padEnd(64, '0');

console.log('ABI string decoder (offline):');

// The exact return data eth_call produced for USDC on 2026-09-27.
const usdcSymbolReturn =
  '0x0000000000000000000000000000000000000000000000000000000000000020' +
  '0000000000000000000000000000000000000000000000000000000000000004' +
  '5553444300000000000000000000000000000000000000000000000000000000';
check('USDC symbol() return decodes to "USDC"', decodeAbiString(usdcSymbolReturn) === 'USDC');

const usdcNameReturn =
  '0x0000000000000000000000000000000000000000000000000000000000000020' +
  '0000000000000000000000000000000000000000000000000000000000000008' +
  '55534420436f696e000000000000000000000000000000000000000000000000';
check('USDC name() return decodes to "USD Coin"', decodeAbiString(usdcNameReturn) === 'USD Coin');

// Legacy bytes32 metadata (MKR-style): one 32-byte word, "MKR" left-aligned.
checkThrows(
  'bytes32 legacy symbol raises the manual-entry error, never mis-decodes',
  () => decodeAbiString('0x' + dataWord('4d4b52')),
  'legacy bytes32',
);

checkThrows('empty return data ("0x") throws', () => decodeAbiString('0x'), 'Empty return data');

checkThrows(
  'sub-64-byte (non-32) return throws as malformed',
  () => decodeAbiString('0x' + uintWord(0x20) + '55534443'),
  'Malformed ABI string',
);

checkThrows(
  'offset pointing past the data throws',
  () => decodeAbiString('0x' + uintWord(0x200) + uintWord(4)),
  'offset points outside',
);

checkThrows(
  'length exceeding the data throws',
  () => decodeAbiString('0x' + uintWord(0x20) + uintWord(1000) + dataWord('55534443')),
  'length exceeds',
);

check(
  'non-standard offset (0x40, junk word between head and tail) still decodes',
  decodeAbiString('0x' + uintWord(0x40) + word('deadbeef') + uintWord(3) + dataWord('4d4b52')) ===
    'MKR',
);

check(
  'zero-length string decodes to ""',
  decodeAbiString('0x' + uintWord(0x20) + uintWord(0) + dataWord('')) === '',
);

// "Ξcoin": CE 9E is the two-byte UTF-8 sequence for U+039E.
check(
  'multi-byte UTF-8 decodes (Ξcoin)',
  decodeAbiString('0x' + uintWord(0x20) + uintWord(7) + dataWord('ce9e636f696e21')) === 'Ξcoin!',
);

checkThrows(
  'invalid UTF-8 lead byte (0xff) throws',
  () => decodeAbiString('0x' + uintWord(0x20) + uintWord(1) + dataWord('ff')),
  'Invalid UTF-8 lead byte',
);

checkThrows(
  'truncated UTF-8 sequence (lead byte, length cuts continuation) throws',
  () => decodeAbiString('0x' + uintWord(0x20) + uintWord(1) + dataWord('c3')),
  'Truncated UTF-8',
);

checkThrows(
  'UTF-16 surrogate encoded as UTF-8 (ED A0 80) throws',
  () => decodeAbiString('0x' + uintWord(0x20) + uintWord(3) + dataWord('eda080')),
  'surrogate',
);

checkThrows(
  'overlong encoding (C0 80 for NUL) throws',
  () => decodeAbiString('0x' + uintWord(0x20) + uintWord(2) + dataWord('c080')),
  'Overlong',
);

console.log('\nContract-address validation (engine EIP-55 path):');
const usdcAddress = USDC_MAINNET.assetId.reference;
const lower = validateErc20ContractAddress(usdcAddress.toLowerCase());
check(
  'all-lowercase input normalizes to the checksummed USDC address',
  lower.ok && lower.normalized === usdcAddress,
);
const badChecksum = validateErc20ContractAddress(
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48', // last-but-one char case flipped
);
check('bad EIP-55 checksum is rejected', !badChecksum.ok);

console.log('\nToken store (in-memory KeyValueStore, exact app store code):');
const MAINNET = 'eip155:1';
const SEPOLIA = 'eip155:11155111';
const BASE_SEPOLIA = 'eip155:84532';
const memStore = () => {
  const mem = new Map();
  return {
    mem,
    getItem: async (key) => (mem.has(key) ? mem.get(key) : null),
    setItem: async (key, value) => {
      mem.set(key, value);
    },
  };
};
const store = memStore();
const mem = store.mem;

const usdcId = formatAssetId(USDC_MAINNET.assetId);
const initial = await listTokens(MAINNET, store);
check(
  'fresh store defaults to exactly one token on mainnet: USDC',
  initial.length === 1 && formatAssetId(initial[0].assetId) === usdcId,
  JSON.stringify(initial),
);
check('mainnet keeps the original storage key byte for byte', tokenStoreKey(MAINNET) === 'shiba-wallet.tokens.v1' && MAINNET_TOKENS_KEY === 'shiba-wallet.tokens.v1');
check('test networks get their own keys', tokenStoreKey(SEPOLIA) === 'shiba-wallet.tokens.v1.eip155:11155111' && tokenStoreKey(BASE_SEPOLIA) === 'shiba-wallet.tokens.v1.eip155:84532');
check('listTokens() without a chain = the active profile (mainnet with default prefs)', (await activeTokenChain(store)) === MAINNET && (await listTokens(undefined, store)).length === 1);

let duplicateRejected = false;
try {
  await addToken(USDC_MAINNET, store);
} catch (e) {
  duplicateRejected = /already in your list/.test(e.message);
}
check('duplicate CAIP-19 id is rejected', duplicateRejected);

const fakeToken = {
  kind: 'fungible',
  assetId: { chainId: 'eip155:1', namespace: 'erc20', reference: '0x' + '11'.repeat(20) },
  symbol: 'FAKE',
  name: 'Fake Token',
  decimals: 18,
};
await addToken(fakeToken, store);
check('second token adds', (await listTokens(MAINNET, store)).length === 2);

check('USDC is removable (nothing is special)', await removeToken(usdcId, store));
const afterRemove = await listTokens(MAINNET, store);
check(
  'after removal only FAKE remains, and USDC is NOT resurrected on reload',
  afterRemove.length === 1 && afterRemove[0].symbol === 'FAKE',
);

await removeToken(formatAssetId(fakeToken.assetId), store);
check('emptied list stays empty (persisted [], not defaults)', (await listTokens(MAINNET, store)).length === 0);

const corrupt = {
  getItem: async () => '{not json',
  setItem: async () => {},
};
const fromCorrupt = await listTokens(MAINNET, corrupt);
check('corrupt storage falls back to the USDC default', fromCorrupt.length === 1 && fromCorrupt[0].symbol === 'USDC');
const sepCorrupt = await listTokens(SEPOLIA, corrupt);
check('corrupt storage on Sepolia falls back to that network\'s defaults', sepCorrupt.length === 2 && sepCorrupt.every((t) => t.assetId.chainId === SEPOLIA));

console.log('\nPer-chain defaults (phase 13 item 1):');
{
  const fresh = memStore();
  const sep = await listTokens(SEPOLIA, fresh);
  check(
    'fresh Sepolia list = Circle test USDC + EURC (the known tokens)',
    sep.map((t) => `${t.symbol}@${t.assetId.reference}`).join(',') ===
      'USDC@0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238,EURC@0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4',
    JSON.stringify(sep),
  );
  const base = await listTokens(BASE_SEPOLIA, fresh);
  check(
    'fresh Base Sepolia list = Circle test USDC + EURC (EURC listed by Circle as of 2026-10-04)',
    base.map((t) => `${t.symbol}@${t.assetId.reference}`).join(',') ===
      'USDC@0x036CbD53842c5426634e7929541eC2318f3dCF7e,EURC@0x808456652fdb597867f38412077A9182bf77359F',
    JSON.stringify(base),
  );
  check('every known test token has 6 decimals and its own CAIP-2 chain', Object.entries(KNOWN_TEST_NETWORK_TOKENS).every(([c, l]) => l.every((t) => t.decimals === 6 && t.assetId.chainId === c)));
  check('mainnet default is USDC only; unknown chains have none', defaultTokensForChain(MAINNET).length === 1 && defaultTokensForChain('eip155:137').length === 0);
  check('reading defaults writes nothing (missing key stays missing)', fresh.mem.size === 0);
  check('a chain the app has no profile for lists nothing', (await listTokens('eip155:137', fresh)).length === 0);
  let refused = false;
  try {
    await addToken({ ...fakeToken, assetId: { ...fakeToken.assetId, chainId: 'eip155:137' } }, fresh);
  } catch (e) {
    refused = /can only be tracked on/.test(e.message);
  }
  check('adding a token on a chain without a profile is refused', refused && fresh.mem.size === 0);
  let nftRefused = false;
  try {
    await addToken({ ...fakeToken, assetId: { ...fakeToken.assetId, namespace: 'erc721' } }, fresh);
  } catch (e) {
    nftRefused = /Only ERC-20/.test(e.message);
  }
  check('adding a non-ERC-20 asset is refused', nftRefused);
}

console.log('\nMigration: an existing mainnet list stays byte-identical:');
{
  // The exact bytes the pre-phase-13 store wrote: AssetRegistry.toJSON of
  // [USDC, FAKE] under shiba-wallet.tokens.v1.
  const legacy = memStore();
  const legacyBytes = JSON.stringify([USDC_MAINNET, fakeToken]);
  legacy.mem.set('shiba-wallet.tokens.v1', legacyBytes);
  const mainnetList = await listTokens(MAINNET, legacy);
  check('the legacy value reads as the mainnet list, in order', mainnetList.map((t) => t.symbol).join(',') === 'USDC,FAKE');
  const sepId = formatAssetId({ chainId: SEPOLIA, namespace: 'erc20', reference: '0x' + '22'.repeat(20) });
  await addToken({ ...fakeToken, assetId: { chainId: SEPOLIA, namespace: 'erc20', reference: '0x' + '22'.repeat(20) }, symbol: 'SEP' }, legacy);
  await removeToken(formatAssetId(KNOWN_TEST_NETWORK_TOKENS[SEPOLIA][1].assetId), legacy);
  check('adding/removing Sepolia tokens never touches the mainnet bytes', legacy.mem.get('shiba-wallet.tokens.v1') === legacyBytes);
  const sepList = await listTokens(SEPOLIA, legacy);
  check('the Sepolia list = defaults minus the removed EURC plus the added token', sepList.map((t) => t.symbol).join(',') === 'USDC,SEP', sepList.map((t) => t.symbol).join(','));
  check('removing by a Sepolia id never removes from mainnet', !(await removeToken(sepId.replace(SEPOLIA, MAINNET), legacy)) && legacy.mem.get('shiba-wallet.tokens.v1') === legacyBytes);
  await removeToken(formatAssetId(fakeToken.assetId), legacy);
  check('a mainnet edit writes the same JSON shape as before (registry.toJSON)', legacy.mem.get('shiba-wallet.tokens.v1') === JSON.stringify([USDC_MAINNET]));
  check('malformed ids are not removable (no throw)', (await removeToken('not-a-caip19', legacy)) === false);
}

console.log('\nSeparation: a token never appears on another network (with controls):');
{
  const mixed = memStore();
  const sepToken = { ...fakeToken, assetId: { chainId: SEPOLIA, namespace: 'erc20', reference: '0x' + '33'.repeat(20) }, symbol: 'SEPX' };
  // A foreign entry inside the mainnet key (never written by the app) and a
  // mainnet entry inside the Sepolia key.
  mixed.mem.set(tokenStoreKey(MAINNET), JSON.stringify([USDC_MAINNET, sepToken]));
  mixed.mem.set(tokenStoreKey(SEPOLIA), JSON.stringify([sepToken, fakeToken]));
  const main = await listTokens(MAINNET, mixed);
  const sep = await listTokens(SEPOLIA, mixed);
  check('mainnet mode never lists a Sepolia token', main.every((t) => t.assetId.chainId === MAINNET) && main.length === 1);
  check('Sepolia mode never lists a mainnet token', sep.every((t) => t.assetId.chainId === SEPOLIA) && sep.length === 1);
  const rawMain = (await loadTokenRegistry(MAINNET, mixed)).list();
  check('control: the raw mainnet registry DOES hold the foreign entry, so the chain filter is what hides it', rawMain.some((t) => t.assetId.chainId === SEPOLIA));
  await savePrefs({ testNetwork: SEPOLIA }, mixed);
  check('listTokens() follows the stored Developer choice (Sepolia)', (await activeTokenChain(mixed)) === SEPOLIA && (await listTokens(undefined, mixed)).every((t) => t.assetId.chainId === SEPOLIA));
  await savePrefs({ testNetwork: BASE_SEPOLIA }, mixed);
  const baseActive = await listTokens(undefined, mixed);
  check('… and Base Sepolia', baseActive.length === 2 && baseActive.every((t) => t.assetId.chainId === BASE_SEPOLIA));
  await savePrefs({ testNetwork: null }, mixed);
  check('… and mainnet again', (await listTokens(undefined, mixed)).every((t) => t.assetId.chainId === MAINNET));
  // Prices: test-network tokens are never priced, and a token is priced only
  // on its own chain (prices.ts tokenPriceAssetId, unchanged).
  const sepUsdc = knownTokensForChain(SEPOLIA)[0];
  const baseUsdc = knownTokensForChain(BASE_SEPOLIA)[0];
  check('a Sepolia token is never priced, in any mode', tokenPriceAssetId(sepUsdc, SEPOLIA) === null && tokenPriceAssetId(sepUsdc, MAINNET) === null);
  check('a Base Sepolia token is never priced, in any mode', tokenPriceAssetId(baseUsdc, BASE_SEPOLIA) === null && tokenPriceAssetId(baseUsdc, MAINNET) === null);
  check('a mainnet token is not priced in a test mode', tokenPriceAssetId(USDC_MAINNET, SEPOLIA) === null && tokenPriceAssetId(USDC_MAINNET, BASE_SEPOLIA) === null);
  check('control: the mainnet token IS priced in mainnet mode', tokenPriceAssetId(USDC_MAINNET, MAINNET) === usdcId);
  // Consumers read the ACTIVE chain's list.
  const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const consumers = [
    ['TokensScreen', '../src/screens/TokensScreen.tsx', 'listTokens(evmChain.caip2)'],
    ['SendScreen', '../src/screens/SendScreen.tsx', 'listTokens(evmChain.caip2)'],
    ['SwapScreen', '../src/screens/SwapScreen.tsx', 'listTokens(evmChain.caip2)'],
    ['ApprovalsScreen', '../src/screens/ApprovalsScreen.tsx', 'listTokens(evmChain.caip2)'],
    ['ActivityScreen decoder', '../src/screens/ActivityScreen.tsx', 'listTokens(chainCaip2)'],
    ['BalanceChangePreview', '../src/components/BalanceChangePreview.tsx', 'listTokens(evmChain.caip2)'],
    ['RiskWarnings', '../src/components/RiskWarnings.tsx', 'listTokens(evmChain.caip2)'],
    ['useTokenBalances', '../src/wallet/useTokenBalances.ts', 'listTokens(chainCaip2)'],
    ['useHistory logs fallback', '../src/wallet/useHistory.ts', 'listTokens(endpoint.network.chainId)'],
    ['SpendingLimitsScreen', '../src/screens/SpendingLimitsScreen.tsx', 'listTokens(scope.chain)'],
  ];
  for (const [name, rel, needle] of consumers) check(`${name} reads one chain's list (${needle})`, src(rel).includes(needle));
  check('useTokenBalances reads each balance only on the token\'s own chain', src('../src/wallet/useTokenBalances.ts').includes('expectedChain: token.assetId.chainId,'));
  check('SendScreen token mode quotes on the token\'s chain (EOA quote and Max)', (src('../src/screens/SendScreen.tsx').match(/token\.assetId\.chainId,?\n/g) ?? []).length >= 2 && src('../src/screens/SendScreen.tsx').includes('chainCaip2: token.assetId.chainId,'));
  check('no "tracked tokens are mainnet assets" copy is left in the app sources',
    ['../src/screens/TokensScreen.tsx', '../src/screens/HomeScreen.tsx', '../src/screens/SwapScreen.tsx', '../src/screens/SettingsScreen.tsx', '../src/wallet/approvals.ts', '../src/config/evm-chain.ts', '../src/screens/SendScreen.tsx'].every((rel) => !/mainnet assets|mainnet-only|mainnet feature/i.test(src(rel))));
}

console.log('\nAnti-spoofing text rule (cleanTokenText == the preview\'s sanitizeSymbol):');
{
  const nasty = ['US‮DC', 'U​S‍DC', 'USDC\n\nPay here', '⁦USDC⁩', 'ok', '  ', '\u0000\u001f', 'ÜSDC ✓'];
  check('same characters stripped as the balance-change preview', nasty.every((t) => cleanTokenText(t, 16) === sanitizeSymbol(t)), JSON.stringify(nasty.map((t) => [cleanTokenText(t, 16), sanitizeSymbol(t)])));
  check('capped without an ellipsis (stored text = shown text)', cleanTokenText('A'.repeat(40), 16) === 'A'.repeat(16) && cleanTokenText(null, 16) === null);
}

console.log('\nFind my tokens (fake indexer + fake chain reads):');
{
  const OWNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
  const IDX = 'https://indexer.example/v2/KEY';
  const RPC = 'https://rpc.example';
  const w = (v) => `0x${v.toString(16).padStart(64, '0')}`;
  const SEP_USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
  const FAKE_USDC = '0x' + 'ab'.repeat(20);
  const DUST = '0x' + 'cd'.repeat(20);
  const NO_SYMBOL = '0x' + 'ef'.repeat(20);
  const NOT_TOKEN = '0x' + '12'.repeat(20);
  const ZERO = '0x' + '34'.repeat(20);
  const BIG = (1n << 200n) + 7n;
  const indexerWith = (chainHex, balances, extra = {}) => (url) => async (method, params) => {
    if (url !== IDX) throw new Error(`unexpected url ${url}`);
    if (method === 'eth_chainId') return chainHex;
    if (method === 'alchemy_getTokenBalances') {
      extra.calls?.push(params);
      if (extra.unsupported) throw Object.assign(new Error('RPC error -32600: Unsupported method: alchemy_getTokenBalances (alchemy_getTokenBalances)'), { code: -32600 });
      return { address: OWNER.toLowerCase(), tokenBalances: balances };
    }
    throw new Error(`unexpected ${method}`);
  };
  const meta = {
    [FAKE_USDC]: { decimals: 6, symbol: 'US‮DC', name: 'USD Coin', note: null },
    [DUST]: { decimals: 18, symbol: 'DUST', name: 'Dust​ Token', note: null },
    [NO_SYMBOL]: { decimals: 0, symbol: null, name: null, note: 'symbol() reverted' },
  };
  const metaReads = [];
  const fetchMetadata = async (url, contract) => {
    metaReads.push([url, contract.toLowerCase()]);
    const m = meta[contract.toLowerCase()];
    if (!m) throw new Error('Could not read decimals() from this address — it does not answer like an ERC-20 token.');
    return m;
  };
  const cfgStore = () => {
    const st = memStore();
    st.mem.set('shiba-wallet.evm-indexer.v1', JSON.stringify({ [SEPOLIA]: { url: IDX, verifiedAt: '2026-10-04T00:00:00.000Z' } }));
    return st;
  };

  const none = await discoverUntrackedTokens({ chainCaip2: SEPOLIA, owner: OWNER, rpc: { url: RPC, chainId: SEPOLIA }, store: memStore(), fetchMetadata });
  check('no indexer → honest "unavailable" naming the network, no request', none.status === 'unavailable' && none.note === discoveryUnavailableNote('Ethereum Sepolia') && metaReads.length === 0, JSON.stringify(none));

  const calls = [];
  const st = cfgStore();
  const out = await discoverUntrackedTokens({
    chainCaip2: SEPOLIA,
    owner: OWNER,
    rpc: { url: RPC, chainId: SEPOLIA },
    store: st,
    fetchMetadata,
    transportFor: indexerWith('0xaa36a7', [
      { contractAddress: SEP_USDC, tokenBalance: w(36_000_000n) },
      { contractAddress: FAKE_USDC, tokenBalance: w(BIG) },
      { contractAddress: DUST, tokenBalance: w(5n) },
      { contractAddress: NO_SYMBOL, tokenBalance: w(1n) },
      { contractAddress: NOT_TOKEN, tokenBalance: w(9n) },
      { contractAddress: ZERO, tokenBalance: w(0n) },
    ], { calls }),
  });
  check('discovery asks for "erc20" with the documented page cap', calls.length === 1 && calls[0][1] === 'erc20' && calls[0][2].maxCount === 100);
  check('ok outcome', out.status === 'ok', JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  if (out.status === 'ok') {
    const contracts = out.tokens.map((t) => t.contract.toLowerCase());
    check('already-tracked Sepolia USDC (a default) is not offered again', !contracts.includes(SEP_USDC) && out.alreadyTracked === 1);
    check('zero balances are hidden and counted', !contracts.includes(ZERO) && out.zeroHidden === 1);
    check('a contract that is not an ERC-20 (decimals unreadable) is listed as unreadable, never offered', !contracts.includes(NOT_TOKEN) && out.unreadable.length === 1 && out.unreadable[0].contract.toLowerCase() === NOT_TOKEN);
    const fake = out.tokens.find((t) => t.contract.toLowerCase() === FAKE_USDC);
    check('balances stay exact bigints (> 2^200)', fake?.balance === BIG);
    check('symbol cleaned with the anti-spoofing rule (bidi override stripped)', fake?.symbol === 'USDC' && fake?.asset?.symbol === 'USDC');
    check('a look-alike of a tracked/known symbol on another contract is flagged', fake?.lookalikeOf === 'USDC');
    check('the full EIP-55 contract address is carried (equals ethers getAddress)', fake?.contract === getAddress(FAKE_USDC) && fake?.asset?.assetId.reference === getAddress(FAKE_USDC));
    const dust = out.tokens.find((t) => t.contract.toLowerCase() === DUST);
    check('dust balance displays as "< 0.000001", never "0"', dust?.display === '< 0.000001');
    check('name cleaned too (zero-width removed)', dust?.name === 'Dust Token');
    check('a token without a readable symbol is listed but not trackable from the list', out.tokens.some((t) => t.contract.toLowerCase() === NO_SYMBOL && t.asset === null && t.note === 'symbol() reverted'));
    check('every trackable result is built for the ACTIVE chain', out.tokens.every((t) => t.asset === null || t.asset.assetId.chainId === SEPOLIA));
    check('metadata came from the RPC endpoint (chain), not from the indexer', metaReads.every(([url]) => url === RPC));
    check('nothing was added automatically', (await listTokens(SEPOLIA, st)).length === 2 && st.mem.get(tokenStoreKey(SEPOLIA)) === undefined);
    check('summary sentence', discoverySummary(out) === '3 untracked tokens found · 1 already tracked · 1 with a zero balance hidden · 1 that do not answer like an ERC-20 token not shown.', discoverySummary(out));
    await addToken(fake.asset, st);
    check('picking one tracks exactly that token on Sepolia (mainnet untouched)', (await listTokens(SEPOLIA, st)).length === 3 && st.mem.get(tokenStoreKey(MAINNET)) === undefined);
  }

  let wrongChain = null;
  try {
    await discoverUntrackedTokens({ chainCaip2: SEPOLIA, owner: OWNER, rpc: { url: RPC, chainId: SEPOLIA }, store: cfgStore(), fetchMetadata, transportFor: indexerWith('0x1', []) });
  } catch (e) {
    wrongChain = e.message;
  }
  check('an indexer answering for another chain is refused, nothing listed', /chain id 1, not 11155111/.test(wrongChain ?? ''), wrongChain);
  let wrongRpc = null;
  try {
    await discoverUntrackedTokens({ chainCaip2: SEPOLIA, owner: OWNER, rpc: { url: RPC, chainId: MAINNET }, store: cfgStore(), fetchMetadata, transportFor: indexerWith('0xaa36a7', []) });
  } catch (e) {
    wrongRpc = e.message;
  }
  check('an RPC endpoint on another network is refused before any request', /serves eip155:1, not eip155:11155111/.test(wrongRpc ?? ''));
  const unsupported = await discoverUntrackedTokens({ chainCaip2: SEPOLIA, owner: OWNER, rpc: { url: RPC, chainId: SEPOLIA }, store: cfgStore(), fetchMetadata, transportFor: indexerWith('0xaa36a7', [], { unsupported: true }) });
  check('an indexer without the method gets the plain unsupported note', unsupported.status === 'unsupported' && unsupported.note === DISCOVERY_UNSUPPORTED_NOTE && /Unsupported method/.test(unsupported.technical));
  // Spam cap: only MAX_DISCOVERY_METADATA metadata reads per run.
  const many = Array.from({ length: MAX_DISCOVERY_METADATA + 7 }, (_, i) => ({ contractAddress: `0x${(i + 1).toString(16).padStart(40, '0')}`, tokenBalance: w(1n) }));
  let reads = 0;
  const capped = await discoverUntrackedTokens({ chainCaip2: SEPOLIA, owner: OWNER, rpc: { url: RPC, chainId: SEPOLIA }, store: cfgStore(), transportFor: indexerWith('0xaa36a7', many), fetchMetadata: async () => { reads += 1; return { decimals: 18, symbol: 'SPAM', name: 'Spam', note: null }; } });
  check(`metadata is read for at most ${MAX_DISCOVERY_METADATA} contracts; the rest are counted`, reads === MAX_DISCOVERY_METADATA && capped.status === 'ok' && capped.notChecked === 7);
  check('the warning says nothing is added until the user picks', /Nothing is added until you pick it/.test(FIND_TOKENS_WARNING));
  // Mainnet with the same indexer key absent → unavailable on mainnet even
  // though Sepolia has one (per-chain indexer config).
  const mainnetNone = await discoverUntrackedTokens({ chainCaip2: MAINNET, owner: OWNER, rpc: { url: RPC, chainId: MAINNET }, store: cfgStore(), fetchMetadata });
  check('the Sepolia indexer is never used for mainnet discovery', mainnetNone.status === 'unavailable' && /Ethereum/.test(mainnetNone.note));
}

console.log('\nDust display in Activity and Swap (phase 12 follow-up):');
{
  check('signed dust: "+<0.000001" and "−<0.000001"', signedDisplay('+', formatBalanceDisplay(5n, 18)) === '+<0.000001' && signedDisplay('−', formatBalanceDisplay(5n, 18)) === '−<0.000001');
  check('signed normal amounts unchanged', signedDisplay('+', formatBalanceDisplay(1500000n, 6)) === '+1.5' && signedDisplay('', '0') === '0');
  check('spoken dust reads "less than"', spokenAmount(formatBalanceDisplay(5n, 18)) === 'less than 0.000001');
  const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const activity = src('../src/screens/ActivityScreen.tsx');
  check('Activity rows use formatBalanceDisplay + signedDisplay (no bare formatUnits for amounts)', activity.includes('formatBalanceDisplay(entry.assetAmount, entry.assetDecimals)') && activity.includes('formatBalanceDisplay(entry.amount, decimals)') && activity.includes('signedDisplay(sign, display)') && !activity.includes('formatUnits(entry.amount, decimals)}`'));
  const swap = src('../src/screens/SwapScreen.tsx');
  check('Swap sell balance uses formatBalanceDisplay and a spoken label', swap.includes('`${formatBalanceDisplay(sellBalance, sellDecimals)} ${sellSymbol}`') && swap.includes('spokenAmount(formatBalanceDisplay(sellBalance, sellDecimals))') && !swap.includes('formatUnits(sellBalance, sellDecimals)'));
}

// Track from "Find my tokens": a one-tap confirm with the full contract
// (2026-10-04 emulator run: Track added the token at once).
{
  const CONTRACT = '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4';
  const plain = trackDiscoveredPrompt({ contract: CONTRACT, lookalikeOf: null, asset: { symbol: 'EURC' } }, 'Ethereum Sepolia');
  check('track prompt: title, the FULL contract and the network, confirm button names the token',
    plain.title === 'Track EURC?' && plain.message.startsWith(`Contract ${CONTRACT} on Ethereum Sepolia.`) && plain.confirm === 'Track EURC' && !/fake/.test(plain.message));
  const fake = trackDiscoveredPrompt({ contract: CONTRACT, lookalikeOf: 'USDC', asset: { symbol: 'USDC' } }, 'Ethereum Sepolia');
  check('…a look-alike repeats the warning in the prompt', /DIFFERENT/.test(fake.message) && /may be a fake/.test(fake.message));
  const screen = readFileSync(new URL('../src/screens/TokensScreen.tsx', import.meta.url), 'utf8');
  check('the Track button asks first (source): onPress opens the prompt, the prompt\'s confirm tracks',
    screen.includes('onPress={() => confirmTrackDiscovered(found)}') && /onPress: \(\) => void trackDiscovered\(found\)/.test(screen) &&
      !screen.includes('onPress={() => void trackDiscovered(found)}'));
  check('the header names the network (source)', screen.includes('navigation.setOptions({ title: `Tokens · ${evmChain.label}` });'));
}

if (process.argv.includes('--live')) {
  console.log('\nLive RPC (read-only eth_call against the default endpoint):');
  const evmNetwork = DEFAULT_NETWORKS.find((n) => n.chainId === 'eip155:1');
  // The same default selection the app makes (config/networks.ts): the first
  // candidate that answers eth_chainId with 0x1, probed in order.
  const choice = await createDefaultEndpointResolver().resolve(evmNetwork);
  if (choice.primaryUnreachable) console.log(`  primary default unreachable: ${choice.primaryFailure}`);
  check('a healthy mainnet default endpoint was found', choice.healthy === true && choice.url !== null);
  const url = choice.url;
  console.log(`  endpoint: ${url}  [${describeDefaultChoice(choice)}]`);
  console.log(`  USDC:     ${usdcAddress}`);

  const metadata = await fetchErc20Metadata(url, usdcAddress);
  console.log(`  symbol()=${metadata.symbol} name()=${metadata.name} decimals()=${metadata.decimals}`);
  check('on-chain symbol() is "USDC"', metadata.symbol === 'USDC');
  check('on-chain name() is "USD Coin"', metadata.name === 'USD Coin');
  check('on-chain decimals() is 6', metadata.decimals === 6);

  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = mnemonicToSeed(TEST_MNEMONIC);
  const account = evmKeyProvider.deriveAccount(seed, 0, 0);
  seed.fill(0);
  const balance = await fetchErc20Balance(url, usdcAddress, account.address);
  console.log(
    `  balanceOf(${account.address}) = ${balance} base units` +
      ` = ${formatUnits(balance, metadata.decimals, metadata.decimals)} USDC`,
  );
  check('balanceOf answers with a bigint', typeof balance === 'bigint');

  // The test-network defaults (tokens.ts KNOWN_TEST_NETWORK_TOKENS) read
  // live through each test network's own default endpoint.
  for (const network of TEST_EVM_NETWORKS) {
    const testChoice = await createDefaultEndpointResolver().resolve(network);
    check(`a healthy ${network.label} default endpoint was found`, testChoice.healthy === true && testChoice.url !== null);
    if (!testChoice.url) continue;
    for (const token of knownTokensForChain(network.chainId)) {
      const m = await fetchErc20Metadata(testChoice.url, token.assetId.reference);
      console.log(`  ${network.label} ${token.assetId.reference}: symbol()=${m.symbol} decimals()=${m.decimals}`);
      check(`${network.label} ${token.symbol}: on-chain symbol and decimals match the default list`, m.symbol === token.symbol && m.decimals === token.decimals);
    }
  }
} else {
  console.log('\nLive RPC section skipped (run with --live to read USDC from the default endpoint).');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

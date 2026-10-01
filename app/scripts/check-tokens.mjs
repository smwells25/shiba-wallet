// Exercises the app's ERC-20 token modules (src/wallet/erc20.ts and
// src/wallet/tokens.ts) outside the app: the ABI string decoder edge cases
// offline, the token store against an in-memory KeyValueStore, and the
// metadata + balanceOf reads against the live default Ethereum RPC
// endpoint, selected exactly as the app selects it (first healthy candidate
// of the ordered default list; read-only eth_call queries only; nothing is
// signed or sent).
//
// Like check-balances.mjs, it imports the actual TypeScript modules the app
// runs via Node's native type stripping. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-tokens.mjs
//
// The balance query uses the address derived from the standard BIP-39 test
// mnemonic ("abandon ... about"), whose addresses are public knowledge.

import { evmKeyProvider, formatAssetId, mnemonicToSeed } from '@shiba-wallet/core';
import { DEFAULT_NETWORKS } from '../src/config/defaults.ts';
import { formatUnits } from '../src/wallet/balances.ts';
import { createDefaultEndpointResolver, describeDefaultChoice } from '../src/config/endpoint-probe.ts';
import {
  USDC_MAINNET,
  decodeAbiString,
  fetchErc20Balance,
  fetchErc20Metadata,
  validateErc20ContractAddress,
} from '../src/wallet/erc20.ts';
import { addToken, listTokens, removeToken } from '../src/wallet/tokens.ts';

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
const mem = new Map();
const store = {
  getItem: async (key) => (mem.has(key) ? mem.get(key) : null),
  setItem: async (key, value) => {
    mem.set(key, value);
  },
};

const usdcId = formatAssetId(USDC_MAINNET.assetId);
const initial = await listTokens(store);
check(
  'fresh store defaults to exactly one token: USDC',
  initial.length === 1 && formatAssetId(initial[0].assetId) === usdcId,
  JSON.stringify(initial),
);

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
check('second token adds', (await listTokens(store)).length === 2);

check('USDC is removable (nothing is special)', await removeToken(usdcId, store));
const afterRemove = await listTokens(store);
check(
  'after removal only FAKE remains, and USDC is NOT resurrected on reload',
  afterRemove.length === 1 && afterRemove[0].symbol === 'FAKE',
);

await removeToken(formatAssetId(fakeToken.assetId), store);
check('emptied list stays empty (persisted [], not defaults)', (await listTokens(store)).length === 0);

const corrupt = {
  getItem: async () => '{not json',
  setItem: async () => {},
};
const fromCorrupt = await listTokens(corrupt);
check('corrupt storage falls back to the USDC default', fromCorrupt.length === 1 && fromCorrupt[0].symbol === 'USDC');

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

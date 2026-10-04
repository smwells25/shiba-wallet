// Exercises parseUnits/formatUnits (src/wallet/balances.ts) and the
// recipient validation helpers (src/wallet/send.ts) edge by edge, outside
// the app, via Node's native TypeScript type stripping — the same pattern
// as check-balances.mjs. Everything here is pure and offline: no network
// calls, no key material beyond publicly known test vectors.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/test-units.mjs

import { dogecoinKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { formatBalanceDisplay, formatUnits, parseUnits, spokenAmount } from '../src/wallet/balances.ts';
import {
  BITCOIN_CHAIN_ID,
  DOGECOIN_CHAIN_ID,
  EVM_CHAIN_ID,
  SOLANA_CHAIN_ID,
  validateRecipient,
} from '../src/wallet/send.ts';

// A syntactically valid Dogecoin address, derived through the engine from
// the standard BIP-39 test mnemonic (public knowledge) rather than typed by
// hand — hand-typing a base58check string invites checksum typos.
const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const DOGE_ADDRESS = dogecoinKeyProvider.deriveAccount(seed, 0, 0).address;
seed.fill(0);

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const okay = actual === expected;
  if (okay) passed++;
  else failed++;
  console.log(`${okay ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!okay) console.log(`      expected ${expected}\n      actual   ${actual}`);
}

function checkThrows(name, fn, messagePattern) {
  try {
    const value = fn();
    failed++;
    console.log(`FAIL  ${name} — expected a throw, got ${value}`);
  } catch (e) {
    if (messagePattern.test(e.message)) {
      passed++;
      console.log(`ok    ${name} — threw: ${e.message}`);
    } else {
      failed++;
      console.log(`FAIL  ${name} — wrong error: ${e.message}`);
    }
  }
}

console.log('--- parseUnits: exactness ---');
check('1.2345 @18', parseUnits('1.2345', 18), 1234500000000000000n);
check('18-decimal precision survives to the last wei',
  parseUnits('1.000000000000000001', 18), 1000000000000000001n);
check('whole number @8 (BTC)', parseUnits('21', 8), 2100000000n);
check('0.00000001 @8 = 1 sat', parseUnits('0.00000001', 8), 1n);
check('0.000000001 @9 = 1 lamport', parseUnits('0.000000001', 9), 1n);
check('leading dot ".5" @18', parseUnits('.5', 18), 500000000000000000n);
check('trailing dot "5." @18', parseUnits('5.', 18), 5000000000000000000n);
check('zero', parseUnits('0', 18), 0n);
check('trailing fraction zeros "1.500" @8', parseUnits('1.500', 8), 150000000n);
check('whitespace trimmed', parseUnits('  2.5  ', 8), 250000000n);
check('0 decimals', parseUnits('42', 0), 42n);
check('huge value beyond float53 stays exact',
  parseUnits('123456789.123456789012345678', 18), 123456789123456789012345678n);

console.log('--- parseUnits: rejections ---');
checkThrows('empty string', () => parseUnits('', 18), /Enter an amount/);
checkThrows('lone dot', () => parseUnits('.', 18), /Enter an amount/);
checkThrows('negative', () => parseUnits('-1', 18), /negative/);
checkThrows('two dots', () => parseUnits('1..2', 18), /plain decimal/);
checkThrows('comma', () => parseUnits('1,5', 18), /plain decimal/);
checkThrows('letters', () => parseUnits('abc', 18), /plain decimal/);
checkThrows('hex-ish', () => parseUnits('0x10', 18), /plain decimal/);
checkThrows('exponent', () => parseUnits('1e18', 18), /plain decimal/);
checkThrows('9 fraction digits @8 (would silently round)',
  () => parseUnits('0.000000001', 8), /at most 8, got 9/);
checkThrows('19 fraction digits @18',
  () => parseUnits('1.0000000000000000001', 18), /at most 18, got 19/);
checkThrows('internal space', () => parseUnits('1 000', 18), /plain decimal/);

console.log('--- parseUnits <-> formatUnits round trip ---');
for (const [text, decimals] of [
  ['1.2345', 18],
  ['0.00000001', 8],
  ['123456789.123456789012345678', 18],
  ['0.000000001', 9],
]) {
  const parsed = parseUnits(text, decimals);
  check(`round trip ${text} @${decimals}`, formatUnits(parsed, decimals, decimals), text);
}

console.log('--- validateRecipient: EVM (EIP-55) ---');
// EIP-55 reference vector, from the EIP text itself.
const eip55 = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
let v = validateRecipient(EVM_CHAIN_ID, eip55);
check('valid checksummed address accepted', v.ok && v.normalized, eip55);
v = validateRecipient(EVM_CHAIN_ID, eip55.toLowerCase());
check('all-lowercase accepted and normalized to checksum', v.ok && v.normalized, eip55);
check('...with a note that no checksum was present', v.ok && /no checksum/.test(v.note ?? ''), true);
v = validateRecipient(EVM_CHAIN_ID, '0x' + eip55.slice(2).toUpperCase());
check('all-uppercase accepted and normalized to checksum', v.ok && v.normalized, eip55);
// Flip the case of one letter: checksum breaks.
v = validateRecipient(EVM_CHAIN_ID, '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
check('bad mixed-case checksum rejected', !v.ok && /checksum/i.test(v.error), true);
v = validateRecipient(EVM_CHAIN_ID, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe');
check('39 hex chars rejected', !v.ok, true);
v = validateRecipient(EVM_CHAIN_ID, '5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
check('missing 0x rejected', !v.ok, true);

console.log('--- validateRecipient: Bitcoin (engine addressToScriptPubKey) ---');
// BIP-84 test-vector address (account 0, first receive address).
v = validateRecipient(BITCOIN_CHAIN_ID, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
check('bech32 P2WPKH accepted', v.ok, true);
// Genesis-block coinbase address (P2PKH).
v = validateRecipient(BITCOIN_CHAIN_ID, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
check('base58 P2PKH accepted', v.ok, true);
// BIP-350 test vector P2TR address.
v = validateRecipient(
  BITCOIN_CHAIN_ID,
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
);
check('taproot rejected with a clear message', !v.ok && /Taproot/.test(v.error), true);
v = validateRecipient(BITCOIN_CHAIN_ID, DOGE_ADDRESS);
check('Dogecoin address rejected on Bitcoin', !v.ok && /version byte/.test(v.error), true);
v = validateRecipient(BITCOIN_CHAIN_ID, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyx');
check('bech32 with corrupted checksum rejected', !v.ok, true);

console.log('--- validateRecipient: Dogecoin ---');
v = validateRecipient(DOGECOIN_CHAIN_ID, DOGE_ADDRESS);
check(`DOGE P2PKH (version 0x1e) accepted: ${DOGE_ADDRESS}`, v.ok, true);
v = validateRecipient(DOGECOIN_CHAIN_ID, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
check('Bitcoin address rejected on Dogecoin', !v.ok && /version byte/.test(v.error), true);

console.log('--- validateRecipient: Solana ---');
v = validateRecipient(SOLANA_CHAIN_ID, '11111111111111111111111111111111');
check('32-byte base58 accepted (system program id)', v.ok, true);
v = validateRecipient(SOLANA_CHAIN_ID, 'abc');
check('short base58 rejected', !v.ok && /32 bytes/.test(v.error), true);
v = validateRecipient(SOLANA_CHAIN_ID, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
check('non-base58 rejected', !v.ok, true);

console.log('--- empty input ---');
v = validateRecipient(EVM_CHAIN_ID, '   ');
check('blank recipient rejected', !v.ok, true);

console.log('--- balance rows: dust is never shown as 0 (Base Sepolia finding 3) ---');
// The live figure: 107,672,250,846 wei left on Account 1 after the Base Max send.
check('formatUnits alone truncates the live dust to "0" (the bug)', formatUnits(107_672_250_846n, 18), '0');
check('formatBalanceDisplay: 107,672,250,846 wei → "< 0.000001"', formatBalanceDisplay(107_672_250_846n, 18), '< 0.000001');
check('formatBalanceDisplay: 1 wei → "< 0.000001"', formatBalanceDisplay(1n, 18), '< 0.000001');
check('formatBalanceDisplay: zero stays "0"', formatBalanceDisplay(0n, 18), '0');
check('formatBalanceDisplay: exactly 0.000001 ETH is shown as such', formatBalanceDisplay(10n ** 12n, 18), '0.000001');
check('formatBalanceDisplay: just below 0.000001 ETH → "< 0.000001"', formatBalanceDisplay(10n ** 12n - 1n, 18), '< 0.000001');
check('formatBalanceDisplay: ordinary amounts unchanged (0.008 ETH)', formatBalanceDisplay(8_000_000_000_000_000n, 18), '0.008');
check('formatBalanceDisplay: truncation of larger amounts unchanged', formatBalanceDisplay(1_234_567_890_123_456_789n, 18), '1.234567');
check('formatBalanceDisplay: 1 satoshi (8 decimals) → "< 0.000001"', formatBalanceDisplay(1n, 8), '< 0.000001');
check('formatBalanceDisplay: USDC base unit (6 decimals) is exact', formatBalanceDisplay(1n, 6), '0.000001');
check('formatBalanceDisplay: 2-decimal token → its own smallest unit', formatBalanceDisplay(1n, 2), '0.01');
check('formatBalanceDisplay: other caps follow the cap', formatBalanceDisplay(5n, 18, 2), '< 0.01');
check('spokenAmount reads "<" as "less than"', spokenAmount('< 0.000001'), 'less than 0.000001');
check('spokenAmount leaves ordinary amounts alone', spokenAmount('0.008'), '0.008');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

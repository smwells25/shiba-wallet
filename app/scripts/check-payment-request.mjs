// Payment requests (phase 14 item 1, features 67 and 68), offline, no key
// material beyond the standard public BIP-39 test mnemonic. Covers:
//
//  - the specifications' own examples, verbatim: EIP-681 (ethereum/ERCs
//    ERCS/erc-681.md at 365b4c02), BIP-321 (bitcoin/bips bip-0321.mediawiki
//    at 927b6de9, incl. its "Invalid URIs" list), Solana Pay transfer and
//    transaction requests (solana-foundation/pay at e22d0af4, SPEC.md);
//  - round trips: every URI the Receive screen builds parses back to the
//    same recipient, amount, token, chain id, label and note, for all four
//    families, and its QR code (the exact encoder call react-native-qrcode-svg
//    makes) decodes back to the same text through the independent jsqr
//    decoder (the check-qr.mjs pattern);
//  - the refusal matrix: other networks (both named), untracked tokens,
//    negative / non-numeric / fractional / over-precise / overflowing
//    amounts, duplicate and unknown parameters, BIP-321 req- parameters,
//    Solana Pay reference / memo / spl-token / transaction requests;
//  - that scanning never widens validation: every accepted recipient still
//    has to pass the Send screen's validateRecipient, another family's URI
//    is not parsed at all, and scan.ts is unchanged in behaviour;
//  - source checks on the Send and Receive screens;
//  - mutation checks: deliberately broken copies of payment-request.ts must
//    fail the checks above.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-payment-request.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  bitcoinKeyProvider,
  dogecoinKeyProvider,
  evmKeyProvider,
  formatAssetId,
  mnemonicToSeed,
  solanaKeyProvider,
} from '@shiba-wallet/core';
import {
  EIP681_GAS_NOTE,
  MAX_PAYMENT_URI_LENGTH,
  OTHER_PAYMENT_METHODS_NOTE,
  buildPaymentRequestUri,
  cleanRequestText,
  describeBuiltRequest,
  describeParsedRequest,
  familyForSlot,
  formatEip681Amount,
  isPaymentUriFor,
  parseEip681Number,
  parsePaymentRequest,
} from '../src/wallet/payment-request.ts';
import { extractScannedAddress } from '../src/wallet/scan.ts';
import {
  BITCOIN_CHAIN_ID,
  DOGECOIN_CHAIN_ID,
  EVM_CHAIN_ID,
  SOLANA_CHAIN_ID,
  validateRecipient,
} from '../src/wallet/send.ts';
import { EVM_BASE_SEPOLIA, EVM_MAINNET, EVM_SEPOLIA } from '../src/config/evm-chain.ts';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok && detail !== undefined) console.log(`      ${detail}`);
}
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(HERE, '..', 'src', rel), 'utf8');

// Mutants: a broken copy of an app module, imports rewritten to the real files.
const MUTANT_DIR = join(HERE, `.mutants-payreq-${process.pid}`);
let mutants = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function importMutant(relPath, source) {
  const originalDir = dirname(join(HERE, '..', relPath));
  const rewritten = source.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutants += 1;
  const file = join(MUTANT_DIR, `m${mutants}-${relPath.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// Fixtures: engine-derived addresses and tracked tokens.
// ---------------------------------------------------------------------------
const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const ETH = evmKeyProvider.deriveAccount(seed, 0, 0).address;
const BTC = bitcoinKeyProvider.deriveAccount(seed, 0, 0).address;
const DOGE = dogecoinKeyProvider.deriveAccount(seed, 0, 0).address;
const SOL = solanaKeyProvider.deriveAccount(seed, 0, 0).address;
seed.fill(0);

const SEPOLIA_USDC = {
  kind: 'fungible',
  assetId: { chainId: 'eip155:11155111', namespace: 'erc20', reference: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
};
const MAINNET_USDC = {
  kind: 'fungible',
  assetId: { chainId: 'eip155:1', namespace: 'erc20', reference: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
};
// A tracked token at the EIP-681 example's contract (the "Unicorn" token),
// with 0 decimals as on mainnet; used to run the spec's own example.
const UNICORN = {
  kind: 'fungible',
  assetId: { chainId: 'eip155:1', namespace: 'erc20', reference: '0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7' },
  symbol: '🦄',
  name: 'Unicorns',
  decimals: 0,
};
const ctxMainnet = { slotChainId: EVM_CHAIN_ID, evmProfile: EVM_MAINNET, trackedTokens: [MAINNET_USDC, UNICORN] };
const ctxSepolia = { slotChainId: EVM_CHAIN_ID, evmProfile: EVM_SEPOLIA, trackedTokens: [SEPOLIA_USDC] };
const ctxBase = { slotChainId: EVM_CHAIN_ID, evmProfile: EVM_BASE_SEPOLIA, trackedTokens: [] };
const ctxBtc = { slotChainId: BITCOIN_CHAIN_ID };
const ctxDoge = { slotChainId: DOGECOIN_CHAIN_ID };
const ctxSol = { slotChainId: SOLANA_CHAIN_ID };

const refusedWith = (r, re) => r.kind === 'refused' && re.test(r.message);

// ---------------------------------------------------------------------------
// 1. EIP-681 numbers.
// ---------------------------------------------------------------------------
console.log('\n# EIP-681 numbers');
const num = (t) => parseEip681Number(t);
check('2.014e18 = 2014000000000000000 (the spec example)', num('2.014e18').ok && num('2.014e18').value === 2014000000000000000n);
check('1 = 1', num('1').ok && num('1').value === 1n);
check('1e18 = 10^18', num('1e18').ok && num('1e18').value === 10n ** 18n);
check('1E6 (upper-case E) = 10^6', num('1E6').ok && num('1E6').value === 1000000n);
check('+5 (the grammar allows "+") = 5', num('+5').ok && num('5').value === 5n);
check('.5e1 = 5 (mantissa without a whole part)', num('.5e1').ok && num('.5e1').value === 5n);
check('2.0140e18 (trailing zero) = 2014000000000000000', num('2.0140e18').ok && num('2.0140e18').value === 2014000000000000000n);
check('0 = 0', num('0').ok && num('0').value === 0n);
check('max uint256 written out is accepted', num(((1n << 256n) - 1n).toString()).ok);
for (const [text, re] of [
  ['-1', /negative/],
  ['-0', /negative/],
  ['1.5', /whole number/],
  ['2.014e2', /whole number/],
  ['1e', /exponent marker/],
  ['e18', /no digits/],
  ['', /no digits/],
  ['0x10', /not a number/],
  ['1,5', /not a number/],
  ['1e1000', /too large/],
  [(1n << 256n).toString(), /too large/],
  ['1.15792089237316195423570985008687907853269984665640564039457584007913129639936e77', /too large/],
  ['１', /not a number/], // full-width digit
]) {
  const r = num(text);
  check(`refused: "${text.slice(0, 24)}"`, !r.ok && re.test(r.error), json(r));
}
check('formatEip681Amount(2014000000000000000n, 18) = "2.014e18"', formatEip681Amount(2014000000000000000n, 18) === '2.014e18');
check('formatEip681Amount(1n, 18) keeps every digit', formatEip681Amount(1n, 18) === '0.000000000000000001e18');
check('formatEip681Amount(5n, 0) is a plain integer', formatEip681Amount(5n, 0) === '5');
for (const a of [1n, 7n, 10n ** 18n, 123456789012345678901234567890n, (1n << 256n) - 1n]) {
  for (const d of [0, 6, 18]) {
    const t = formatEip681Amount(a, d);
    check(`EIP-681 amount round trip ${a} @${d}`, num(t).ok && num(t).value === a, t);
  }
}

// ---------------------------------------------------------------------------
// 2. EIP-681 examples and parsing.
// ---------------------------------------------------------------------------
console.log('\n# EIP-681');
{
  const r = parsePaymentRequest('ethereum:0xfb6916095ca1df60bb79Ce92ce3ea74c37c5d359?value=2.014e18', ctxMainnet);
  check('spec example: 2.014 ETH, no chain id', r.kind === 'request' && r.amount === 2014000000000000000n && r.amountText === '2.014' && r.chainId === null && r.token === null && r.recipient === '0xfb6916095ca1df60bb79Ce92ce3ea74c37c5d359', json(r));
  // FINDING: the specification's own example address is mixed-case but its
  // capitalisation is NOT a valid EIP-55 checksum (ethers.getAddress refuses
  // it too), so the Send field's normal validation refuses it — the request
  // fills the field, the checksum rule still decides.
  check('…its mixed-case address fails EIP-55, so the normal validation refuses it (nothing widened)',
    /Bad EIP-55 checksum/.test(validateRecipient(EVM_CHAIN_ID, r.recipient).error ?? ''));
  check('…the same address in lower case passes validation (checksum applied)',
    validateRecipient(EVM_CHAIN_ID, r.recipient.toLowerCase()).ok === true);
  const lines = describeParsedRequest(r, { nativeSymbol: 'ETH', networkLabel: 'Ethereum' });
  check('…no chain id → the lines say which network it will be paid on', lines.some((l) => /does not name a network\. It will be paid on Ethereum/.test(l)), json(lines));
}
{
  const r = parsePaymentRequest(
    'ethereum:0x89205a3a3b2a69de6dbf7f01ed13b2108b2c43e7/transfer?address=0x8e23ee67d1332ad560396262c48ffbb01f93d052&uint256=1',
    ctxMainnet,
  );
  check('spec ERC-20 example with the token tracked: 1 unit to 0x8e23…', r.kind === 'request' && r.amount === 1n && r.amountText === '1' && r.token?.assetId === formatAssetId(UNICORN.assetId) && r.recipient === '0x8e23ee67d1332ad560396262c48ffbb01f93d052', json(r));
  const untracked = parsePaymentRequest(
    'ethereum:0x89205a3a3b2a69de6dbf7f01ed13b2108b2c43e7/transfer?address=0x8e23ee67d1332ad560396262c48ffbb01f93d052&uint256=1',
    { ...ctxMainnet, trackedTokens: [MAINNET_USDC] },
  );
  check('spec ERC-20 example with the token NOT tracked → "not tracked on this network", never auto-tracked',
    refusedWith(untracked, /is not tracked on this network \(Ethereum\)\. Add it under Manage tokens first if you trust it; the wallet never adds tokens from a payment request\./), json(untracked));
}
{
  const r = parsePaymentRequest(`ethereum:${ETH}@11155111?value=1e15`, ctxSepolia);
  check('Sepolia request on Sepolia: chain id carried, 0.001', r.kind === 'request' && r.chainId === 11155111n && r.amountText === '0.001');
  const mismatch = parsePaymentRequest(`ethereum:${ETH}@11155111?value=1e15`, ctxMainnet);
  check('Sepolia request in mainnet mode → refused naming BOTH networks, no switch',
    refusedWith(mismatch, /is for Ethereum Sepolia \(chain id 11155111\), but the wallet is on Ethereum \(chain id 1\)\. The wallet never switches networks for a request: to pay on Ethereum Sepolia, switch networks under Settings → Developer/), json(mismatch));
  const base = parsePaymentRequest(`ethereum:${ETH}@1?value=1`, ctxBase);
  check('mainnet request in Base Sepolia mode → refused naming both', refusedWith(base, /is for Ethereum \(chain id 1\), but the wallet is on Base Sepolia \(chain id 84532\)/), json(base));
  const unknown = parsePaymentRequest(`ethereum:${ETH}@137?value=1`, ctxMainnet);
  check('unknown network (chain id 137) → refused, "does not support that network"', refusedWith(unknown, /the network with chain id 137, but the wallet is on Ethereum \(chain id 1\)\. The wallet never switches networks for a request, and it does not support that network\./), json(unknown));
  const zeroPadded = parsePaymentRequest(`ethereum:${ETH}@01?value=1`, ctxMainnet);
  check('chain id "01" is numerically 1 → accepted on mainnet', zeroPadded.kind === 'request' && zeroPadded.chainId === 1n);
  const badChain = parsePaymentRequest(`ethereum:${ETH}@abc?value=1`, ctxMainnet);
  check('non-numeric chain id → refused', refusedWith(badChain, /chain id\) in this payment request is not a number/));
}
{
  const tokenReq = `ethereum:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238@11155111/transfer?address=${ETH}&uint256=1.5e6`;
  const r = parsePaymentRequest(tokenReq, ctxSepolia);
  check('Sepolia USDC request: 1.5 USDC (6 decimals), tokenId = tracked CAIP-19 id', r.kind === 'request' && r.amount === 1500000n && r.amountText === '1.5' && r.token?.assetId === 'eip155:11155111/erc20:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' && r.recipient === ETH, json(r));
  const mainnetUsdcOnSepolia = parsePaymentRequest(`ethereum:${MAINNET_USDC.assetId.reference}@11155111/transfer?address=${ETH}&uint256=1`, ctxSepolia);
  check('mainnet USDC contract on Sepolia → not tracked on this network', refusedWith(mainnetUsdcOnSepolia, /not tracked on this network \(Ethereum Sepolia\)/));
  const lowercaseContract = parsePaymentRequest(`ethereum:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238/transfer?address=${ETH}&uint256=1`, ctxSepolia);
  check('contract matched case-insensitively against the tracked list', lowercaseContract.kind === 'request' && lowercaseContract.token?.symbol === 'USDC');
  const fractional = parsePaymentRequest(`ethereum:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238/transfer?address=${ETH}&uint256=1.5`, ctxSepolia);
  check('token amount "1.5" (not a whole number of base units) → refused', refusedWith(fractional, /token amount in this payment request is not a whole number/));
  const noAmount = parsePaymentRequest(`ethereum:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238/transfer?address=${ETH}`, ctxSepolia);
  check('token request without uint256 → accepted, amount left to the payer', noAmount.kind === 'request' && noAmount.amount === null && noAmount.amountText === null);
  const lines = describeParsedRequest(noAmount, { nativeSymbol: 'test ETH', networkLabel: 'Ethereum Sepolia' });
  check('…its lines say "amount not set — enter one"', lines.some((l) => /amount not set — enter one/.test(l)), json(lines));
  const noBeneficiary = parsePaymentRequest('ethereum:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238/transfer?uint256=1', ctxSepolia);
  check('token request without address → refused', refusedWith(noBeneficiary, /does not say who should be paid/));
  const withValue = parsePaymentRequest(`ethereum:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238/transfer?address=${ETH}&uint256=1&value=1`, ctxSepolia);
  check('token request that also sends ETH (value) → refused', refusedWith(withValue, /also asks for ETH to be sent/));
  const approve = parsePaymentRequest(`ethereum:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238/approve?address=${ETH}&uint256=1`, ctxSepolia);
  check('any function other than transfer (approve) → refused', refusedWith(approve, /asks to call the contract function "approve"/));
  const nameContract = parsePaymentRequest(`ethereum:usdc.eth/transfer?address=${ETH}&uint256=1`, ctxSepolia);
  check('a token contract given as a name → refused', refusedWith(nameContract, /names the token contract by a name/));
}
{
  const r = parsePaymentRequest(`ethereum:pay-${ETH}@1?value=1&gas=21000&gasPrice=1e9`, ctxMainnet);
  check('pay- prefix and gas suggestions accepted; gas ignored with a note', r.kind === 'request' && r.amount === 1n && r.notes.includes(EIP681_GAS_NOTE), json(r));
  const upper = parsePaymentRequest(`ETHEREUM:PAY-${ETH}?value=1`, ctxMainnet);
  check('scheme and "pay-" are case-insensitive (ABNF literals)', upper.kind === 'request' && upper.recipient === ETH);
  const badGas = parsePaymentRequest(`ethereum:${ETH}?value=1&gas=-5`, ctxMainnet);
  check('a malformed gas suggestion → refused', refusedWith(badGas, /"gas" value in this payment request is negative/));
  const name = parsePaymentRequest('ethereum:nick.eth?value=1e18', ctxMainnet);
  check('an ENS name as recipient goes to the field as the NAME (resolved later on screen)', name.kind === 'request' && name.recipient === 'nick.eth' && name.amountText === '1');
  const unicodeName = parsePaymentRequest('ethereum:nıck.eth?value=1', ctxMainnet);
  check('a name outside the supported ASCII subset → refused', refusedWith(unicodeName, /neither an Ethereum address/));
  const shortHex = parsePaymentRequest('ethereum:0x1234?value=1', ctxMainnet);
  check('0x with the wrong length → refused', refusedWith(shortHex, /neither an Ethereum address/));
  const longHex = parsePaymentRequest(`ethereum:${ETH}00?value=1`, ctxMainnet);
  check('0x with 42 hex characters (ABNF "40*HEXDIG") → refused (an address is 20 bytes)', refusedWith(longHex, /neither an Ethereum address/));
  const dup = parsePaymentRequest(`ethereum:${ETH}?value=1&value=2`, ctxMainnet);
  check('duplicate value → refused as ambiguous', refusedWith(dup, /lists the parameter "value" more than once/));
  const unknownKey = parsePaymentRequest(`ethereum:${ETH}?value=1&label=Shop`, ctxMainnet);
  check('unknown key (label) on EIP-681 → refused, not half-read', refusedWith(unknownKey, /contains the parameter "label", which the format does not define/));
  const addrOnNative = parsePaymentRequest(`ethereum:${ETH}?address=${ETH}`, ctxMainnet);
  check('a TYPE key without a function → refused', refusedWith(addrOnNative, /parameter "address", which the format does not define for a plain payment/));
  const neg = parsePaymentRequest(`ethereum:${ETH}?value=-1`, ctxMainnet);
  check('negative value → refused', refusedWith(neg, /amount in this payment request is negative/));
  const overflow = parsePaymentRequest(`ethereum:${ETH}?value=1e100`, ctxMainnet);
  check('value above uint256 → refused', refusedWith(overflow, /too large/));
  const noEq = parsePaymentRequest(`ethereum:${ETH}?value`, ctxMainnet);
  check('a parameter without "=" → refused', refusedWith(noEq, /every parameter must be written as key=value/));
  const frag = parsePaymentRequest(`ethereum:${ETH}?value=1#x`, ctxMainnet);
  check('a "#" fragment → refused', refusedWith(frag, /fragment/));
  const space = parsePaymentRequest(`ethereum:${ETH} ?value=1`, ctxMainnet);
  check('inner whitespace → refused', refusedWith(space, /spaces/));
  const huge = parsePaymentRequest(`ethereum:${ETH}?value=${'1'.repeat(MAX_PAYMENT_URI_LENGTH)}`, ctxMainnet);
  check('a payload longer than 2048 characters → refused', refusedWith(huge, /too long/));
  const valueZero = parsePaymentRequest(`ethereum:${ETH}?value=0`, ctxMainnet);
  check('value=0 fills "0" (the Send form then refuses a zero amount as usual)', valueZero.kind === 'request' && valueZero.amountText === '0');
}

// ---------------------------------------------------------------------------
// 3. BIP-321 and Dogecoin.
// ---------------------------------------------------------------------------
console.log('\n# BIP-321 / Dogecoin');
{
  const A = '175tWpb8K1S7NmH4Zx6rewF9WQrcZv245W'; // the BIP's own (intentionally invalid) address
  const p = (u) => parsePaymentRequest(u, ctxBtc);
  const r1 = p(`bitcoin:${A}`);
  check('spec: just the address', r1.kind === 'request' && r1.recipient === A && r1.amount === null);
  const r2 = p(`bitcoin:${A}?label=Luke-Jr`);
  check('spec: address with label', r2.kind === 'request' && r2.label === 'Luke-Jr');
  const r3 = p(`bitcoin:${A}?amount=20.3&label=Luke-Jr`);
  check('spec: 20.30 BTC to Luke-Jr = 2,030,000,000 sat', r3.kind === 'request' && r3.amount === 2030000000n && r3.amountText === '20.3');
  const r4 = p(`bitcoin:${A}?amount=50&label=Luke-Jr&message=Donation%20for%20project%20xyz`);
  check('spec: 50 BTC with a percent-encoded message', r4.kind === 'request' && r4.amount === 5000000000n && r4.message === 'Donation for project xyz');
  const r5 = p(`bitcoin:${A}?lightning=lnbc420bogusinvoice`);
  check('spec: Lightning with on-chain fallback → pays on-chain, notes the other method', r5.kind === 'request' && r5.notes.includes(OTHER_PAYMENT_METHODS_NOTE));
  for (const u of ['bitcoin:?lightning=lnbc420bogusinvoice', 'bitcoin:?lno=lno1bogusoffer', 'bitcoin:?sp=sp1qsilentpayment', 'bitcoin:?tb=tb1qghfhmd4zh7ncpmxl3qzhmq566jk8ckq4gafnmq']) {
    check(`spec: no on-chain address (${u.slice(0, 28)}…) → refused`, refusedWith(p(u), /has no on-chain BTC address/));
  }
  const r6 = p(`bitcoin:${A}?req-somethingyoudontunderstand=50&req-somethingelseyoudontget=999`);
  check('spec: unknown req- parameters → whole URI refused (MUST)', refusedWith(r6, /requires a feature this wallet does not support \("req-somethingyoudontunderstand"\), so the whole request is refused/));
  const r7 = p(`bitcoin:${A}?somethingyoudontunderstand=50&somethingelseyoudontget=999`);
  check('spec: unknown non-req parameters → accepted, ignored', r7.kind === 'request' && r7.recipient === A);
  check('spec invalid: label twice', refusedWith(p(`bitcoin:${A}?label=Luke-Jr&label=Matt`), /"label" more than once/));
  check('spec invalid: amount twice', refusedWith(p(`bitcoin:${A}?amount=42&amount=10`), /"amount" more than once/));
  check('spec invalid: amount twice even if equal', refusedWith(p(`bitcoin:${A}?amount=42&amount=42`), /"amount" more than once/));
  check('spec invalid: pop and req-pop', refusedWith(p(`bitcoin:${A}?pop=callback%3a&req-pop=callback%3a`), /refused/));
  check('spec: req-pop to a web page → refused (wallet does not do proof of payment)', refusedWith(p(`bitcoin:${A}?req-pop=https%3aevilwebsite.com`), /req-pop/));
  const pop = p(`bitcoin:${A}?pop=https%3aiwantyouripaddress.com`);
  check('spec: plain pop → payment allowed, the callback is never opened (ignored)', pop.kind === 'request' && pop.notes.length === 0);
  const upper = p('BITCOIN:BC1QUFGY354J3KMVUCH987XE4S40836X3H0LG8F5NQ?BC=BC1P5SWKUGEZN97763TL0YTY6556856UUG0Q6JFLLJVEP9M4P7339X5QZYRH4Q');
  check('spec: all-uppercase QR URI (keys case-insensitive)', upper.kind === 'request' && upper.recipient === 'BC1QUFGY354J3KMVUCH987XE4S40836X3H0LG8F5NQ' && upper.notes.includes(OTHER_PAYMENT_METHODS_NOTE));
  check('…its address is one of the BIP\'s intentionally invalid examples, so validateRecipient refuses it', validateRecipient(BITCOIN_CHAIN_ID, upper.recipient).ok === false);
  const ownUpper = p(`BITCOIN:${BTC.toUpperCase()}?AMOUNT=0.5`);
  check('an all-uppercase URI with a real address (BIP-173 allows uppercase in QR codes) passes validateRecipient',
    ownUpper.kind === 'request' && ownUpper.amount === 50000000n && validateRecipient(BITCOIN_CHAIN_ID, ownUpper.recipient).ok === true);
  check('…the BIP\'s intentionally invalid example address FAILS validateRecipient (parsing never validates)', validateRecipient(BITCOIN_CHAIN_ID, A).ok === false);
  check('AMOUNT= key in upper case is the amount', (() => { const r = p(`bitcoin:${BTC}?AMOUNT=1`); return r.kind === 'request' && r.amount === 100000000n; })());
  for (const [amt, re] of [
    ['-1', /not a plain decimal/],
    ['1,5', /not a plain decimal/],
    ['1e3', /not a plain decimal/],
    ['0.000000001', /more than 8 decimal places/],
    ['.', /not a plain decimal/],
    ['92233720368.54775808', /too large/],
    ['abc', /not a plain decimal/],
  ]) {
    check(`BTC amount "${amt}" refused`, refusedWith(p(`bitcoin:${BTC}?amount=${amt}`), re));
  }
  const maxOk = p(`bitcoin:${BTC}?amount=92233720368.54775807`);
  check('BTC amount at the int64 limit accepted exactly', maxOk.kind === 'request' && maxOk.amount === (1n << 63n) - 1n);
  const empty = p(`bitcoin:${BTC}?amount=`);
  check('empty amount = none (Dogecoin Core treats it the same)', empty.kind === 'request' && empty.amount === null);
  check('".5" and "5." follow the BIP grammar (*digit ["." *digit])', (() => { const a = p(`bitcoin:${BTC}?amount=.5`); const b = p(`bitcoin:${BTC}?amount=5.`); return a.kind === 'request' && a.amount === 50000000n && b.kind === 'request' && b.amount === 500000000n; })());
  check('bad percent-encoding in a label → refused', refusedWith(p(`bitcoin:${BTC}?label=%E0%A4%A`), /not correctly encoded/));
  const bidi = p(`bitcoin:${BTC}?label=${encodeURIComponent('Shop‮gnp.exe')}`);
  check('bidi override in a label is removed before display', bidi.kind === 'request' && bidi.label === 'Shopgnp.exe', json(bidi));
  const long = p(`bitcoin:${BTC}?message=${'a'.repeat(300)}`);
  check('a long message is cut at 200 characters for display', long.kind === 'request' && Array.from(long.message).length === 201);
  const lines = describeParsedRequest(r4, { nativeSymbol: 'BTC', networkLabel: 'Bitcoin' });
  check('requester text is labelled "not verified"', lines.includes('Message from the requester (not verified): Donation for project xyz') && lines.includes('Label from the requester (not verified): Luke-Jr'), json(lines));
}
{
  const r = parsePaymentRequest(`dogecoin:${DOGE}?amount=12.5&label=Shibe&message=Thanks`, ctxDoge);
  check('Dogecoin request: 12.5 DOGE, label and message', r.kind === 'request' && r.amount === 1250000000n && r.label === 'Shibe' && r.message === 'Thanks' && r.recipient === DOGE);
  check('…recipient passes validateRecipient', validateRecipient(DOGECOIN_CHAIN_ID, r.recipient).ok === true);
  check('Dogecoin req- parameter → refused (Dogecoin Core parseBitcoinURI returns false too)', refusedWith(parsePaymentRequest(`dogecoin:${DOGE}?req-x=1`, ctxDoge), /req-x/));
  check('a bitcoin: URI on the Dogecoin slot is not parsed (normal validation decides)', parsePaymentRequest(`bitcoin:${BTC}?amount=1`, ctxDoge).kind === 'not-a-request');
}

// ---------------------------------------------------------------------------
// 4. Solana Pay.
// ---------------------------------------------------------------------------
console.log('\n# Solana Pay');
{
  const M = 'mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN';
  const p = (u) => parsePaymentRequest(u, ctxSol);
  check('spec example 1 (1 SOL with memo) → refused: the memo cannot be added',
    refusedWith(p(`solana:${M}?amount=1&label=Michael&message=Thanks%20for%20all%20the%20fish&memo=OrderId12345`), /on-chain memo/));
  check('spec example 1 without the memo → 1 SOL, label and message',
    (() => { const r = p(`solana:${M}?amount=1&label=Michael&message=Thanks%20for%20all%20the%20fish`); return r.kind === 'request' && r.amount === 1000000000n && r.label === 'Michael' && r.message === 'Thanks for all the fish' && r.recipient === M; })());
  check('…its recipient passes validateRecipient (base58, 32 bytes)', validateRecipient(SOLANA_CHAIN_ID, M).ok === true);
  check('spec example 2 (0.01 USDC, spl-token) → refused: SPL requests not supported yet',
    refusedWith(p(`solana:${M}?amount=0.01&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), /SPL token/));
  const ex3 = p(`solana:${M}&label=Michael`);
  check('spec example 3 (written with "&" and no "?") keeps "&label=…" in the recipient, which then FAILS validation',
    ex3.kind === 'request' && ex3.recipient === `${M}&label=Michael` && validateRecipient(SOLANA_CHAIN_ID, ex3.recipient).ok === false);
  check('spec transaction request (https link) → refused', refusedWith(p('solana:https://example.com/solana-pay'), /transaction request/));
  check('spec transaction request (encoded link) → refused', refusedWith(p('solana:https%3A%2F%2Fexample.com%2Fsolana-pay%3Forder%3D12345'), /transaction request/));
  check('reference → refused (cannot be attached)', refusedWith(p(`solana:${SOL}?amount=1&reference=${M}`), /reference keys/));
  for (const [amt, re] of [
    ['.5', /not a plain decimal/],
    ['5.', /not a plain decimal/],
    ['1e3', /not a plain decimal/],
    ['-1', /not a plain decimal/],
    ['0.0000000001', /more than 9 decimal places/],
    ['18446744073.709551616', /too large/],
    ['', /is empty/],
  ]) {
    check(`SOL amount "${amt}" refused`, refusedWith(p(`solana:${SOL}?amount=${amt}`), re));
  }
  check('SOL amount 0 is valid per the spec', (() => { const r = p(`solana:${SOL}?amount=0`); return r.kind === 'request' && r.amount === 0n; })());
  check('SOL amount at the u64 limit accepted exactly', (() => { const r = p(`solana:${SOL}?amount=18446744073.709551615`); return r.kind === 'request' && r.amount === (1n << 64n) - 1n; })());
  check('duplicate amount → refused', refusedWith(p(`solana:${SOL}?amount=1&amount=1`), /more than once/));
  check('unknown key → refused (the spec defines none to ignore)', refusedWith(p(`solana:${SOL}?amount=1&redirect=x`), /"redirect", which Solana Pay does not define/));
}

// ---------------------------------------------------------------------------
// 5. Scanning never widens validation.
// ---------------------------------------------------------------------------
console.log('\n# validation is never widened');
check('a bitcoin: URI on the EVM slot is not a request here (old path)', parsePaymentRequest(`bitcoin:${BTC}?amount=1`, ctxMainnet).kind === 'not-a-request');
check('…the old path leaves it untouched and validateRecipient rejects it',
  extractScannedAddress(EVM_CHAIN_ID, `bitcoin:${BTC}?amount=1`) === `bitcoin:${BTC}?amount=1` && validateRecipient(EVM_CHAIN_ID, `bitcoin:${BTC}?amount=1`).ok === false);
check('an ethereum: URI on the Bitcoin slot is not parsed', parsePaymentRequest(`ethereum:${ETH}?value=1`, ctxBtc).kind === 'not-a-request');
check('a solana: URI on the Dogecoin slot is not parsed', parsePaymentRequest(`solana:${SOL}`, ctxDoge).kind === 'not-a-request');
check('a plain address is not a request', parsePaymentRequest(ETH, ctxMainnet).kind === 'not-a-request');
check('a wc: pairing URI is not a request', parsePaymentRequest('wc:abc@2?x=y', ctxMainnet).kind === 'not-a-request');
check('a mistyped checksum inside an EIP-681 request is filled in, then refused by validateRecipient',
  (() => {
    const bad = ETH.slice(0, 2) + (ETH[2] === ETH[2].toUpperCase() ? ETH[2].toLowerCase() : ETH[2].toUpperCase()) + ETH.slice(3);
    const r = parsePaymentRequest(`ethereum:${bad}?value=1`, ctxMainnet);
    return /[a-f]/i.test(ETH[2]) ? r.kind === 'request' && validateRecipient(EVM_CHAIN_ID, r.recipient).ok === false : true;
  })());
check('a Bitcoin testnet address in a bitcoin: request is filled in, then refused by validateRecipient',
  (() => { const r = parsePaymentRequest('bitcoin:tb1qghfhmd4zh7ncpmxl3qzhmq566jk8ckq4gafnmq?amount=1', ctxBtc); return r.kind === 'request' && validateRecipient(BITCOIN_CHAIN_ID, r.recipient).ok === false; })());
check('familyForSlot maps the four slots', familyForSlot(EVM_CHAIN_ID) === 'evm' && familyForSlot(BITCOIN_CHAIN_ID) === 'bitcoin' && familyForSlot(DOGECOIN_CHAIN_ID) === 'dogecoin' && familyForSlot(SOLANA_CHAIN_ID) === 'solana' && familyForSlot('eip155:137') === null);
check('isPaymentUriFor is scheme- and slot-exact', isPaymentUriFor(EVM_CHAIN_ID, '  Ethereum:0x') && !isPaymentUriFor(EVM_CHAIN_ID, 'ethereumx:0x') && !isPaymentUriFor(BITCOIN_CHAIN_ID, 'ethereum:0x'));

// ---------------------------------------------------------------------------
// 6. Building, round trips and QR.
// ---------------------------------------------------------------------------
console.log('\n# build, round trip, QR');
function qrRoundTrip(payload) {
  // Exactly react-native-qrcode-svg's genMatrix call (ecl default 'M'), as in check-qr.mjs.
  const code = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const size = code.modules.size;
  const scale = 6;
  const quiet = 4;
  const px = (size + 2 * quiet) * scale;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!code.modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const p = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4;
          rgba[p] = rgba[p + 1] = rgba[p + 2] = 0;
        }
      }
    }
  }
  return jsQR(rgba, px, px)?.data ?? '<decode failed>';
}
const builds = [
  [{ family: 'evm', address: ETH, chainIdDecimal: '1', amount: 2014000000000000000n }, ctxMainnet, 'ETH'],
  [{ family: 'evm', address: ETH, chainIdDecimal: '1', amount: 1n }, ctxMainnet, 'ETH'],
  [{ family: 'evm', address: ETH, chainIdDecimal: '11155111', amount: 123456789n, token: { contract: SEPOLIA_USDC.assetId.reference, decimals: 6 } }, ctxSepolia, 'USDC'],
  [{ family: 'evm', address: ETH, chainIdDecimal: '84532', amount: 10n ** 17n }, ctxBase, 'test ETH'],
  [{ family: 'bitcoin', address: BTC, amount: 1n, label: 'Café Ünïcode', message: 'Order #42 & co=1' }, ctxBtc, 'BTC'],
  [{ family: 'bitcoin', address: BTC, amount: 2100000000000000n }, ctxBtc, 'BTC'],
  [{ family: 'dogecoin', address: DOGE, amount: 4200000000n, label: 'Shibe' }, ctxDoge, 'DOGE'],
  [{ family: 'solana', address: SOL, amount: 500000000n, message: 'Thanks' }, ctxSol, 'SOL'],
  [{ family: 'solana', address: SOL, amount: 1n }, ctxSol, 'SOL'],
];
for (const [input, ctx, symbol] of builds) {
  const uri = buildPaymentRequestUri(input);
  const back = parsePaymentRequest(uri, ctx);
  const tokenOk = input.family === 'evm' && input.token ? back.token?.contract === input.token.contract : back.token === null;
  const chainOk = input.family === 'evm' ? back.chainId === BigInt(input.chainIdDecimal) : back.chainId === null;
  const labelOk = input.family === 'evm' ? true : back.label === (input.label ?? null) && back.message === (input.message ?? null);
  check(`round trip ${input.family} ${symbol} ${input.amount}: ${uri.slice(0, 60)}…`,
    back.kind === 'request' && back.recipient === input.address && back.amount === input.amount && tokenOk && chainOk && labelOk, json(back));
  check(`  QR of it decodes to the same text (jsqr)`, qrRoundTrip(uri) === uri);
  const description = describeBuiltRequest(input, { symbol, networkLabel: 'Net' });
  check(`  description names the exact amount and the address`, description.includes(input.address) && description.includes(`exactly `));
}
check('EVM build always writes the active chain id', /@84532\?value=0\.1e18$/.test(buildPaymentRequestUri({ family: 'evm', address: ETH, chainIdDecimal: '84532', amount: 10n ** 17n })));
check('EVM token build follows the spec layout /transfer?address=…&uint256=…',
  buildPaymentRequestUri({ family: 'evm', address: ETH, chainIdDecimal: '11155111', amount: 1500000n, token: { contract: SEPOLIA_USDC.assetId.reference, decimals: 6 } }) ===
  `ethereum:${SEPOLIA_USDC.assetId.reference}@11155111/transfer?address=${ETH}&uint256=1.5e6`);
check('Bitcoin build: decimal BTC, percent-encoded UTF-8 label',
  buildPaymentRequestUri({ family: 'bitcoin', address: BTC, amount: 2030000000n, label: 'Luke Jr' }) === `bitcoin:${BTC}?amount=20.3&label=Luke%20Jr`);
check('Solana build: leading 0 kept for amounts below 1', buildPaymentRequestUri({ family: 'solana', address: SOL, amount: 500000000n }) === `solana:${SOL}?amount=0.5`);
for (const [bad, re] of [
  [{ family: 'evm', address: ETH, chainIdDecimal: '1', amount: 0n }, /greater than zero/],
  [{ family: 'bitcoin', address: BTC, amount: -1n }, /greater than zero/],
  [{ family: 'bitcoin', address: BTC, amount: 1n << 63n }, /too large/],
  [{ family: 'solana', address: SOL, amount: 1n << 64n }, /too large/],
  [{ family: 'evm', address: 'nick.eth', chainIdDecimal: '1', amount: 1n }, /not an Ethereum address/],
  [{ family: 'bitcoin', address: BTC, amount: 1n, label: 'a‮b' }, /hidden or control characters/],
  [{ family: 'bitcoin', address: BTC, amount: 1n, message: 'x'.repeat(101) }, /at most 100 characters/],
]) {
  let msg = '';
  try {
    buildPaymentRequestUri(bad);
  } catch (e) {
    msg = e.message;
  }
  check(`build refused: ${msg || '(not refused)'}`, re.test(msg));
}
check('cleanRequestText: blank label is omitted', (() => { const r = cleanRequestText('   ', 'label'); return r.ok && r.text === null; })());

// ---------------------------------------------------------------------------
// 7. Source checks on the screens.
// ---------------------------------------------------------------------------
console.log('\n# screens');
const send = src('screens/SendScreen.tsx');
const receive = src('screens/ReceiveScreen.tsx');
const views = src('components/PaymentRequestViews.tsx');
check('Send: scans try the payment-request parser first, then the old extractScannedAddress path',
  /void handlePaymentPayload\(data, true\)\.then\(\(handled\) => \{\s*if \(handled\) return;[\s\S]{0,400}extractScannedAddress\(route\.params\.chainId, data\)/.test(send));
check('Send: a pasted payment URI goes through the same parser (never into the field as text)',
  /if \(isPaymentUriFor\(route\.params\.chainId, t\)\) \{\s*void handlePaymentPayload\(t, false\);\s*return;\s*\}/.test(send));
check('Send: a refused request fills nothing in', /if \(parsed\.kind === 'refused'\) \{\s*setRequestLines\(null\);\s*setRequestError\(parsed\.message\);\s*return true;\s*\}/.test(send));
check('Send: the parser gets the ACTIVE profile and the ACTIVE network\'s tracked tokens',
  send.includes('const tracked = isEvm ? await listTokens(evmChain.caip2).catch(() => []) : [];') && send.includes('evmProfile: evmChain,'));
check('Send: never switches the network or adds a token', !/setTestNetwork|setSepolia|addToken\(/.test(send));
check('Send: a token request replaces the screen in token mode, carrying the editable values',
  /navigation\.replace\('Send', \{\s*chainId: route\.params\.chainId,\s*\.\.\.\(wantedToken \? \{ tokenId: wantedToken \} : \{\}\),\s*request: \{ recipient: parsed\.recipient, amountText: parsed\.amountText, lines \},/.test(send));
check('Send: pre-filled values seed the editable fields', send.includes("useState(route.params.request?.recipient ?? '')") && send.includes("useState(route.params.request?.amountText ?? '')"));
check('Send: the "Payment request" box renders above the recipient field', /\{requestLines \? <PaymentRequestNotice lines=\{requestLines\} \/> : null\}\s*<Text style=\{\[styles\.label, \{ color: theme\.textMuted \}\]\}>Recipient<\/Text>/.test(send));
check('Receive: the plain-address QR is still rendered from account.address', receive.includes('<QRCode value={account.address} size={qrSize}'));
check('Receive: the request card is keyed by account and ACTIVE network', receive.includes('key={`${account.chainId}|${account.address}|${evmChain.caip2}`}') && receive.includes('chainIdDecimal: evmChain.chainIdDecimal, evmCaip2: evmChain.caip2'));
check('Request card: offers only the ACTIVE network\'s ERC-20 tokens', views.includes("t.assetId.chainId === evmCaip2 && t.assetId.namespace === 'erc20'"));
check('Request card: the QR value is the built URI', views.includes('<QRCode value={built.uri} size={qrSize}'));
check('Request card: label and note only outside EVM (EIP-681 defines none)', /family !== 'evm' \? \(\s*<>\s*<Text[^>]*>\s*Label \(optional/.test(views));

// ---------------------------------------------------------------------------
// 8. Mutation checks.
// ---------------------------------------------------------------------------
console.log('\n# mutation checks');
const prSrc = src('wallet/payment-request.ts');
async function mutant(name, find, replace, stillCorrect) {
  if (!prSrc.includes(find)) {
    check(`${name}: mutation target present`, false, find);
    return;
  }
  const m = await importMutant('src/wallet/payment-request.ts', prSrc.replace(find, replace));
  check(`${name} caught`, !(await stillCorrect(m)));
}
await mutant('M1 (chain id check dropped)', 'if (chainId !== active) {', 'if (false) {',
  (m) => m.parsePaymentRequest(`ethereum:${ETH}@11155111?value=1`, ctxMainnet).kind === 'refused');
await mutant('M2 (untracked token accepted)', '  if (!tracked) {\n', '  if (false) {\n',
  async (m) => { try { return m.parsePaymentRequest(`ethereum:0x89205a3a3b2a69de6dbf7f01ed13b2108b2c43e7/transfer?address=${ETH}&uint256=1`, { ...ctxMainnet, trackedTokens: [] }).kind === 'refused'; } catch { return false; } });
await mutant('M3 (req- parameters ignored)', "if (key.startsWith('req-')) {", "if (key.startsWith('never-')) {",
  (m) => m.parsePaymentRequest(`bitcoin:${BTC}?req-x=1`, ctxBtc).kind === 'refused');
await mutant('M4 (fractional EIP-681 numbers truncated)', 'if (exponent < fraction.length) {', 'if (false) {',
  (m) => { try { return m.parseEip681Number('1.5').ok === false; } catch { return false; } });
await mutant('M5 (negative numbers accepted)', "if (sign === '-') return { ok: false, error: 'is negative' };", '',
  (m) => m.parseEip681Number('-1').ok === false);
await mutant('M6 (too many BTC decimals accepted)', "if (dot !== -1 && text.length - dot - 1 > decimals) {", 'if (false) {',
  (m) => { const r = m.parsePaymentRequest(`bitcoin:${BTC}?amount=0.000000001`, ctxBtc); return r.kind === 'refused' && /more than 8 decimal places/.test(r.message); });
await mutant('M7 (duplicate label allowed)', "if (seen.has(key)) return refuse(`This payment request lists \"${key}\" more than once, so it is invalid.`);", '',
  (m) => m.parsePaymentRequest(`bitcoin:${BTC}?label=a&label=b`, ctxBtc).kind === 'refused');
await mutant('M8 (Solana memo ignored)', "case 'memo':", "case 'memo-never':",
  (m) => { const r = m.parsePaymentRequest(`solana:${SOL}?amount=1&memo=x`, ctxSol); return r.kind === 'refused' && /on-chain memo/.test(r.message); });
await mutant('M9 (build drops the chain id)', '`ethereum:${input.address}@${input.chainIdDecimal}?value=', '`ethereum:${input.address}?value=',
  (m) => /@1\?/.test(m.buildPaymentRequestUri({ family: 'evm', address: ETH, chainIdDecimal: '1', amount: 1n })));
await mutant('M10 (uint256 overflow allowed)', "  if (value > MAX_UINT256) return { ok: false, error: 'is too large' };\n  return { ok: true, value };", '  return { ok: true, value };',
  (m) => m.parseEip681Number((1n << 256n).toString()).ok === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

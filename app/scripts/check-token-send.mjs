// Exercises the ERC-20 send flow glue (src/wallet/send-erc20.ts) entirely
// OFFLINE: a fake global fetch answers the JSON-RPC calls the real code
// makes (eth_chainId, eth_getBalance, eth_call, eth_estimateGas, fee
// queries, eth_sendRawTransaction), so the exact module the app runs is
// tested end to end — quote math, balance checks, the zero-word-return
// blocking rule, max, error translation, and sign+broadcast — without a
// network and without a live send. Nothing here touches a real endpoint.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-token-send.mjs
//
// The signing key derives from the standard BIP-39 test mnemonic
// ("abandon ... about"), which is public knowledge.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { encodeErc20Transfer, toHex } from '@shiba-wallet/chains-evm';
import {
  ERC20_TRANSFER_GAS_FALLBACK,
  erc20TransferReturnedFalse,
  maxErc20Send,
  prepareErc20Send,
  sendErc20,
} from '../src/wallet/send-erc20.ts';
import {
  ESTIMATE_REVERT_TITLE,
  GasEstimateRevertError,
  PLAIN_TRANSFER_REJECTED_SENTENCE,
  describeSendError,
  maxEvmSend,
  prepareEvmSend,
} from '../src/wallet/send.ts';
import { QUOTE_FAILED_TITLE, retitleQuoteFailure } from '../src/wallet/aa.ts';
import {
  flushSpendingWrites,
  installSpendingRecorder,
  listSpendRecords,
  saveSpendingPolicy,
} from '../src/wallet/spending-policy.ts';

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
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, messagePattern.test(message), `error was: ${message}`);
    return e;
  }
}

// ---------------------------------------------------------------------------
// Fixtures (EIP-55 test-vector addresses from the EIP text; USDC contract
// address as verified in src/wallet/erc20.ts)
// ---------------------------------------------------------------------------

const FROM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TO = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const CONTRACT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const SYMBOL = 'USDC';
const DECIMALS = 6;
const URL = 'http://offline.fake/rpc';

const GWEI = 1000000000n;
const TRUE_WORD = '0x' + '1'.padStart(64, '0');
const ZERO_WORD = '0x' + '0'.repeat(64);
const uintWord = (n) => '0x' + n.toString(16).padStart(64, '0');
const hex = (bytes) => toHex(bytes);

// ---------------------------------------------------------------------------
// Fake JSON-RPC node behind global fetch. `scenario` is reassigned per test.
// ---------------------------------------------------------------------------

const BALANCE_OF_SELECTOR = '0x70a08231';
const TRANSFER_SELECTOR = '0xa9059cbb';

let scenario = {};
let lastRawTx = null;

function defaultScenario() {
  return {
    chainId: '0x1',
    ethBalance: 10n ** 16n, // 0.01 ETH
    tokenBalance: 25000000n, // 25 USDC
    nonce: '0x5',
    baseFeePerGas: GWEI, // 1 gwei -> maxFeePerGas = 3 gwei
    priorityFee: GWEI, // 1 gwei
    estimateGas: 52000n,
    estimateGasError: null, // string -> eth_estimateGas rejects
    transferCallResult: TRUE_WORD, // eth_call for transfer calldata
    transferCallError: null, // string -> eth_call rejects (revert)
    txid: '0x' + 'ab'.repeat(32),
  };
}

function rpcResult(method, params) {
  const s = scenario;
  switch (method) {
    case 'eth_chainId':
      return s.chainId;
    case 'eth_getBalance':
      return '0x' + s.ethBalance.toString(16);
    case 'eth_getTransactionCount':
      return s.nonce;
    case 'eth_getBlockByNumber':
      return { baseFeePerGas: '0x' + s.baseFeePerGas.toString(16) };
    case 'eth_maxPriorityFeePerGas':
      return '0x' + s.priorityFee.toString(16);
    case 'eth_estimateGas':
      if (s.estimateGasFn) return s.estimateGasFn(params[0]);
      if (s.estimateGasError) throw { code: -32000, message: s.estimateGasError };
      return '0x' + s.estimateGas.toString(16);
    case 'eth_call': {
      const data = params[0].data ?? '';
      if (data.startsWith(BALANCE_OF_SELECTOR)) return uintWord(s.tokenBalance);
      if (data.startsWith(TRANSFER_SELECTOR)) {
        if (s.transferCallError) throw { code: 3, message: s.transferCallError };
        return s.transferCallResult;
      }
      throw { code: -32000, message: `unexpected eth_call data ${data.slice(0, 10)}` };
    }
    case 'eth_sendRawTransaction':
      if (s.sendRawError) throw { code: -32000, message: s.sendRawError };
      lastRawTx = params[0];
      return s.txid;
    default:
      throw { code: -32601, message: `unexpected method ${method}` };
  }
}

// Every JSON-RPC request the code under test makes, in order (method and
// params exactly as sent), for the request-sequence pins below.
let rpcLog = [];
globalThis.fetch = async (_url, init) => {
  const { method, params, id } = JSON.parse(init.body);
  rpcLog.push({ method, params });
  let body;
  try {
    body = { jsonrpc: '2.0', id, result: rpcResult(method, params) };
  } catch (e) {
    body = { jsonrpc: '2.0', id, error: { code: e.code ?? -32000, message: e.message } };
  }
  return { ok: true, json: async () => body };
};

// ---------------------------------------------------------------------------
// 1. Transfer calldata: quote uses exactly the engine encoding, and the
//    engine encoding matches an independently hand-assembled ABI layout.
// ---------------------------------------------------------------------------

console.log('transfer calldata:');

// Hand-built expected calldata: well-known transfer(address,uint256)
// selector a9059cbb + 32-byte left-padded address + 32-byte amount.
function handBuiltTransfer(to, amount) {
  return (
    TRANSFER_SELECTOR +
    to.toLowerCase().slice(2).padStart(64, '0') +
    amount.toString(16).padStart(64, '0')
  );
}

for (const [to, amount] of [
  [TO, 1000000n],
  [FROM, 0n],
  [CONTRACT, 123456789012345678901234567890n],
]) {
  check(
    `encodeErc20Transfer(${to.slice(0, 8)}…, ${amount}) matches hand-built ABI bytes`,
    hex(encodeErc20Transfer(to, amount)) === handBuiltTransfer(to, amount),
    `engine ${hex(encodeErc20Transfer(to, amount))} vs hand ${handBuiltTransfer(to, amount)}`,
  );
}

scenario = defaultScenario();
const quote = await prepareErc20Send({
  url: URL,
  from: FROM,
  to: TO,
  contract: CONTRACT,
  amount: 1000000n,
  symbol: SYMBOL,
  decimals: DECIMALS,
});
check(
  'quote.data is the engine transfer calldata for (recipient, amount)',
  hex(quote.data) === handBuiltTransfer(TO, 1000000n),
  hex(quote.data),
);

// ---------------------------------------------------------------------------
// 2. Token-mode quote math: fee in WEI, separate from the token amount.
// ---------------------------------------------------------------------------

console.log('quote math (fee in wei, token amount in token units):');

check('amount stays in token base units (1 USDC = 1000000)', quote.amount === 1000000n);
check('gasLimit from eth_estimateGas', quote.gasLimit === 52000n && !quote.gasIsFallback);
check(
  'maxFeePerGas = 2*baseFee + priority = 3 gwei',
  quote.maxFeePerGas === 3n * GWEI,
  String(quote.maxFeePerGas),
);
check(
  'fee = gasLimit * maxFeePerGas = 156000000000000 wei (never token units)',
  quote.fee === 52000n * 3n * GWEI && quote.fee === 156000000000000n,
  String(quote.fee),
);
check('token balance reported in token units', quote.tokenBalance === 25000000n);
check('ETH balance reported in wei', quote.ethBalance === 10n ** 16n);
check('nonce/chainId passed through', quote.nonce === 5n && quote.chainId === 1n);
check('simulation passed, no false-return flag', quote.simulation.ok && !quote.returnedFalse);
check('symbol/decimals carried for display', quote.symbol === 'USDC' && quote.decimals === 6);

scenario = defaultScenario();
scenario.chainId = '0xaa36a7'; // Sepolia
await checkRejects(
  'wrong endpoint chain id refused',
  () =>
    prepareErc20Send({
      url: URL,
      from: FROM,
      to: TO,
      contract: CONTRACT,
      amount: 1n,
      symbol: SYMBOL,
      decimals: DECIMALS,
    }),
  /chain id 11155111, expected 1/,
);

// Phase 13 item 1: tokens are per chain. The quote takes the token's CAIP-2
// chain and refuses an endpoint on any other network, in both directions.
console.log('per-chain token quotes (phase 13 item 1):');
const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
scenario = defaultScenario();
scenario.chainId = '0xaa36a7';
const sepQuote = await prepareErc20Send({
  url: URL, from: FROM, to: TO, contract: SEPOLIA_USDC, amount: 1000000n, symbol: 'USDC', decimals: 6,
  chainCaip2: 'eip155:11155111',
});
check('a Sepolia token quotes on a Sepolia endpoint', sepQuote.chainId === 11155111n && sepQuote.contract === SEPOLIA_USDC);
check('Sepolia token quote has no L1 data fee part (not an OP-stack chain)', !('opStack' in sepQuote));
scenario = defaultScenario(); // mainnet endpoint
await checkRejects(
  'a Sepolia token is refused on a mainnet endpoint (names Ethereum Sepolia)',
  () => prepareErc20Send({ url: URL, from: FROM, to: TO, contract: SEPOLIA_USDC, amount: 1n, symbol: 'USDC', decimals: 6, chainCaip2: 'eip155:11155111' }),
  /chain id 1, expected 11155111 \(Ethereum Sepolia\)/,
);
await checkRejects(
  'Max for a Sepolia token is refused on a mainnet endpoint too',
  () => maxErc20Send(URL, FROM, SEPOLIA_USDC, TO, 'eip155:11155111'),
  /chain id 1, expected 11155111/,
);
scenario = defaultScenario();
scenario.chainId = '0xaa36a7';
check('Max for a Sepolia token on a Sepolia endpoint = full token balance', (await maxErc20Send(URL, FROM, SEPOLIA_USDC, TO, 'eip155:11155111')) === 25000000n);
await checkRejects(
  'control: a mainnet token (default chain) is still refused on the Sepolia endpoint',
  () => maxErc20Send(URL, FROM, CONTRACT, TO),
  /chain id 11155111, expected 1 \(Ethereum mainnet\)/,
);

// ---------------------------------------------------------------------------
// 3. The false-return / empty-return rule.
// ---------------------------------------------------------------------------

console.log('zero-word-return blocking vs empty-return passing:');

check('unit: "0x" (USDT-style, no return value) passes', erc20TransferReturnedFalse('0x') === false);
check('unit: 32-byte zero word blocks', erc20TransferReturnedFalse(ZERO_WORD) === true);
check('unit: canonical true word passes', erc20TransferReturnedFalse(TRUE_WORD) === false);
check('unit: short all-zero data blocks', erc20TransferReturnedFalse('0x0000') === true);
check(
  'unit: longer data with a non-zero byte passes',
  erc20TransferReturnedFalse('0x' + '0'.repeat(64) + '01') === false,
);

scenario = defaultScenario();
scenario.transferCallResult = ZERO_WORD;
const falseQuote = await prepareErc20Send({
  url: URL,
  from: FROM,
  to: TO,
  contract: CONTRACT,
  amount: 1000000n,
  symbol: SYMBOL,
  decimals: DECIMALS,
});
check(
  'transfer() returning false: simulation "succeeds" but returnedFalse blocks',
  falseQuote.simulation.ok === true && falseQuote.returnedFalse === true,
);

scenario = defaultScenario();
scenario.transferCallResult = '0x';
const usdtStyleQuote = await prepareErc20Send({
  url: URL,
  from: FROM,
  to: TO,
  contract: CONTRACT,
  amount: 1000000n,
  symbol: SYMBOL,
  decimals: DECIMALS,
});
check(
  'USDT-style empty return is NOT treated as failure',
  usdtStyleQuote.simulation.ok === true && usdtStyleQuote.returnedFalse === false,
);

scenario = defaultScenario();
scenario.transferCallError = 'execution reverted: paused';
scenario.estimateGasError = 'execution reverted: paused';
const revertQuote = await prepareErc20Send({
  url: URL,
  from: FROM,
  to: TO,
  contract: CONTRACT,
  amount: 1000000n,
  symbol: SYMBOL,
  decimals: DECIMALS,
});
check('reverting transfer: simulation fails with the node reason', !revertQuote.simulation.ok);
check(
  'reverting transfer: estimation falls back to the documented gas limit',
  revertQuote.gasIsFallback && revertQuote.gasLimit === ERC20_TRANSFER_GAS_FALLBACK,
);

// ---------------------------------------------------------------------------
// 4. Balance checks and error translation.
// ---------------------------------------------------------------------------

console.log('balance checks:');

scenario = defaultScenario();
const tooMuch = await checkRejects(
  'amount above token balance refused',
  () =>
    prepareErc20Send({
      url: URL,
      from: FROM,
      to: TO,
      contract: CONTRACT,
      amount: 25000001n,
      symbol: SYMBOL,
      decimals: DECIMALS,
    }),
  /exceeds the token balance/,
);
check(
  'describeSendError titles token shortfall with the token symbol',
  describeSendError(tooMuch, 'USDC').title.includes('USDC'),
  describeSendError(tooMuch, 'USDC').title,
);

scenario = defaultScenario();
scenario.ethBalance = 1000n; // ~nothing: cannot cover the fee
const noEth = await checkRejects(
  'ETH balance below the worst-case fee refused, in plain language',
  () =>
    prepareErc20Send({
      url: URL,
      from: FROM,
      to: TO,
      contract: CONTRACT,
      amount: 1000000n,
      symbol: SYMBOL,
      decimals: DECIMALS,
    }),
  /Not enough ETH to pay the network fee/,
);
check(
  'describeSendError titles the ETH-fee shortfall as an ETH problem, not a token problem',
  describeSendError(noEth, 'USDC').title === 'Not enough ETH to pay the network fee.',
  describeSendError(noEth, 'USDC').title,
);
check(
  'mainnet: the shortfall detail names "ETH" (the mainnet profile’s coin)',
  /^Not enough ETH to pay the network fee: .* but the ETH balance is 1000 wei\. Token sends pay gas in ETH, not in USDC\.$/.test(noEth?.message ?? ''),
  noEth?.message,
);
// Phase 20 item 3: the fee coin comes from the network's profile, so on a
// test network every shortfall reads "test ETH" (detail and title).
scenario = defaultScenario();
scenario.chainId = '0xaa36a7';
scenario.ethBalance = 1000n;
const noTestEth = await checkRejects(
  'Sepolia: the token-send shortfall names the profile’s coin',
  () =>
    prepareErc20Send({ url: URL, from: FROM, to: TO, contract: CONTRACT, amount: 1000000n, symbol: SYMBOL, decimals: DECIMALS, chainCaip2: 'eip155:11155111' }),
  /^Not enough test ETH to pay the network fee: .* but the test ETH balance is 1000 wei\. Token sends pay gas in test ETH, not in USDC\.$/,
);
check(
  'Sepolia: describeSendError(…, "USDC", "test ETH") titles it "Not enough test ETH to pay the network fee."',
  describeSendError(noTestEth, 'USDC', 'test ETH').title === 'Not enough test ETH to pay the network fee.',
  describeSendError(noTestEth, 'USDC', 'test ETH').title,
);
await checkRejects(
  'Sepolia: the Max shortfall names the profile’s coin too',
  () => maxErc20Send(URL, FROM, CONTRACT, TO, 'eip155:11155111'),
  /^Not enough test ETH to pay the network fee: .* Token sends pay gas in test ETH\.$/,
);
check(
  'a custom coin name is matched too (the title never falls back to the generic one)',
  describeSendError(new Error('Not enough test HOO to pay the network fee: the worst-case fee is 5 wei but the test HOO balance is 1 wei.'), 'USDC', 'test HOO').title === 'Not enough test HOO to pay the network fee.',
);

// ---------------------------------------------------------------------------
// 5. Max = full token balance, refused when ETH cannot cover gas.
// ---------------------------------------------------------------------------

console.log('max:');

scenario = defaultScenario();
check(
  'max is the full token balance (gas is paid in ETH, not the token)',
  (await maxErc20Send(URL, FROM, CONTRACT, TO)) === 25000000n,
);
check(
  'max works without a recipient (self-transfer estimation)',
  (await maxErc20Send(URL, FROM, CONTRACT)) === 25000000n,
);

scenario = defaultScenario();
scenario.tokenBalance = 0n;
check('zero token balance yields max 0', (await maxErc20Send(URL, FROM, CONTRACT, TO)) === 0n);

scenario = defaultScenario();
scenario.ethBalance = 1000n;
await checkRejects(
  'max refused when ETH cannot cover the fee',
  () => maxErc20Send(URL, FROM, CONTRACT, TO),
  /Not enough ETH to pay the network fee/,
);

// ---------------------------------------------------------------------------
// 6. sendErc20: value-0 transaction to the token contract carrying the
//    transfer calldata, signed and "broadcast" against the fake node.
// ---------------------------------------------------------------------------

console.log('sign + broadcast (offline fake node):');

const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const signer = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);

scenario = defaultScenario();
lastRawTx = null;
const sent = await sendErc20(URL, signer, quote);
check('txid returned from eth_sendRawTransaction', sent.txid === scenario.txid);
check(
  'etherscan link built from the txid',
  sent.explorerUrl === `https://etherscan.io/tx/${sent.txid}`,
);
check('a raw transaction reached the node', typeof lastRawTx === 'string' && lastRawTx.startsWith('0x'));
check(
  'raw tx carries the transfer calldata verbatim',
  lastRawTx.includes(handBuiltTransfer(TO, 1000000n).slice(2)),
);
// The tx `to` field must be the token contract; the recipient only appears
// inside the calldata (as a 32-byte padded word), never as the tx target.
// The RLP `to` field is the bare 20-byte address, so the contract's hex
// appears verbatim while the recipient's appears only zero-padded.
check(
  'raw tx targets the token contract',
  lastRawTx.includes(CONTRACT.toLowerCase().slice(2)),
);
check(
  'recipient appears only as the padded calldata word',
  lastRawTx.includes(TO.toLowerCase().slice(2).padStart(64, '0')),
);
{
  // A Sepolia token send signs for chain 11155111 through the same sendEvm
  // path; decoded independently with ethers.
  const { Transaction } = await import('ethers');
  scenario = defaultScenario();
  scenario.chainId = '0xaa36a7';
  lastRawTx = null;
  await sendErc20(URL, signer, sepQuote);
  const tx = Transaction.from(lastRawTx);
  check('Sepolia token send: signed for chain 11155111, to the token contract, value 0, transfer calldata',
    tx.chainId === 11155111n && tx.to === SEPOLIA_USDC && tx.value === 0n && tx.data === handBuiltTransfer(TO, 1000000n) && tx.from === signer.address,
    `${tx.chainId} ${tx.to} ${tx.from}`);
}

// Phase 12 item 3: the app-enforced spending policy records an ACCEPTED token
// send (sendErc20 -> sendEvm -> addEvmSentListener) from its calldata, and
// nothing for a send the node refused.
{
  const mem = new Map();
  const store = { getItem: async (k) => mem.get(k) ?? null, setItem: async (k, v) => void mem.set(k, v) };
  const scope = { chain: 'eip155:1', owner: signer.address };
  await saveSpendingPolicy(
    scope,
    { token: CONTRACT, symbol: SYMBOL, decimals: DECIMALS, cap: 10n ** 12n, windowSeconds: 86400 },
    [CONTRACT],
    { store },
  );
  const off = installSpendingRecorder(store);
  scenario = defaultScenario();
  await sendErc20(URL, signer, quote);
  await new Promise((r) => setTimeout(r, 10));
  await flushSpendingWrites();
  let records = (await listSpendRecords(scope, store)).records;
  check(
    'spending limits: accepted token send recorded (1 USDC, txid ref)',
    records.length === 1 && records[0].amount === 1000000n && records[0].token === CONTRACT && records[0].ref === scenario.txid,
    JSON.stringify(records, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );
  scenario.sendRawError = 'replacement transaction underpriced';
  let refused = false;
  try {
    await sendErc20(URL, signer, quote);
  } catch {
    refused = true;
  }
  await new Promise((r) => setTimeout(r, 10));
  await flushSpendingWrites();
  records = (await listSpendRecords(scope, store)).records;
  check('spending limits: refused token send not recorded', refused && records.length === 1);
  off();
  scenario = defaultScenario();
}

// ---------------------------------------------------------------------------
// F3 (phase 11 item 6): a recipient contract that rejects plain ETH. Permit2
// has no payable receive, so eth_estimateGas reverts; the quote must say so
// in plain words under the quote-step title, never "could not be sent".
// ---------------------------------------------------------------------------

console.log('estimate revert (F3):');
{
  scenario = defaultScenario();
  scenario.estimateGasError = 'execution reverted';
  const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
  let thrown = null;
  try {
    await prepareEvmSend(URL, FROM, PERMIT2, 10n ** 14n);
  } catch (e) {
    thrown = e;
  }
  check('plain ETH quote to a rejecting contract throws GasEstimateRevertError', thrown instanceof GasEstimateRevertError, String(thrown));
  check('…flagged as a plain transfer, the node text kept as the message', thrown?.plainTransfer === true && /execution reverted/.test(thrown?.message ?? ''));
  const described = describeSendError(thrown, 'ETH');
  check('title is "The quote could not be prepared."', described.title === 'The quote could not be prepared.' && described.title === ESTIMATE_REVERT_TITLE, described.title);
  check('the title equals aa.ts QUOTE_FAILED_TITLE (one convention)', ESTIMATE_REVERT_TITLE === QUOTE_FAILED_TITLE);
  check(
    'detail is the plain sentence',
    described.detail ===
      'The recipient contract rejected a plain ETH transfer during estimation (execution reverted). Nothing was sent.' &&
      described.detail === PLAIN_TRANSFER_REJECTED_SENTENCE,
    described.detail,
  );
  check('no raw "RPC error" in what the user reads', !/RPC error/.test(described.title + described.detail));
  check('retitleQuoteFailure keeps it unchanged', retitleQuoteFailure(described).title === ESTIMATE_REVERT_TITLE);

  let maxThrown = null;
  try {
    await maxEvmSend(URL, FROM, PERMIT2);
  } catch (e) {
    maxThrown = e;
  }
  check('Max to a rejecting contract gets the same plain explanation', describeSendError(maxThrown, 'ETH').detail === PLAIN_TRANSFER_REJECTED_SENTENCE);

  scenario.estimateGasError = 'execution reverted: Not allowed';
  let withData = null;
  try {
    await prepareEvmSend(URL, FROM, PERMIT2, 0n, new Uint8Array([0x12, 0x34, 0x56, 0x78]));
  } catch (e) {
    withData = e;
  }
  check(
    'with calldata: the contract-call sentence carries the revert reason',
    describeSendError(withData, 'ETH').detail ===
      'The contract rejected this transaction during estimation (execution reverted: Not allowed). Nothing was sent.',
    describeSendError(withData, 'ETH').detail,
  );

  scenario.estimateGasError = 'insufficient funds for gas * price + value';
  let funds = null;
  try {
    await prepareEvmSend(URL, FROM, TO, 10n ** 14n);
  } catch (e) {
    funds = e;
  }
  check('a non-revert estimate failure keeps its own title', !(funds instanceof GasEstimateRevertError) && describeSendError(funds, 'ETH').title === 'Not enough ETH to pay the network fee.', String(funds));
}

// ---------------------------------------------------------------------------
// Phase 18 emulator finding 1: a payable call the account cannot afford
// (Lido's submit(), Rocket Pool's deposit()) showed the contract's revert
// ("execution reverted: ZERO_DEPOSIT") because a failed estimate was retried
// with value 0. Now: a payable call is compared with the balance at the
// smallest possible fee (21,000 gas × max fee) BEFORE any estimate, and a
// transaction with calldata is never re-estimated with value 0. Plain
// transfers keep their old behaviour (pinned request by request).
// ---------------------------------------------------------------------------

console.log('payable calls: the funds sentence, never a value-0 re-estimate:');
const SEND_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/wallet/send.ts'), 'utf8');
const SEND_MUTANT_DIR = join(dirname(fileURLToPath(import.meta.url)), `.mutants-token-send-${process.pid}`);
process.on('exit', () => rmSync(SEND_MUTANT_DIR, { recursive: true, force: true }));
let sendMutants = 0;
async function sendMutant(from, to) {
  if (!SEND_SOURCE.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const originalDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/wallet');
  const rewritten = SEND_SOURCE.replace(from, to).replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolve(originalDir, spec)).href}'`);
  mkdirSync(SEND_MUTANT_DIR, { recursive: true });
  sendMutants += 1;
  const file = join(SEND_MUTANT_DIR, `m${sendMutants}-send.ts`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
{
  const LIDO = '0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af'; // the payable target (any contract address works here)
  const SUBMIT = new Uint8Array([0xa1, 0x90, 0x3e, 0xab, ...new Uint8Array(32)]); // submit(address(0))
  const MAX_FEE = 3n * GWEI; // 2 × 1 gwei base + 1 gwei tip
  const MIN_FEE = 21_000n * MAX_FEE;
  const STAKE = 10n ** 15n;
  // A node that behaves like geth for this contract: an estimate whose value
  // exceeds the balance fails "insufficient funds"; with value 0 the
  // contract reverts ZERO_DEPOSIT (Lido's own revert string); otherwise
  // 120,000 gas. `feeChecked` also refuses when value + gas × max fee
  // exceeds the balance (a node that checks the fee, too).
  const payableNode = (balance, { feeChecked = false } = {}) => (tx) => {
    const value = BigInt(tx.value ?? '0x0');
    if (value > balance || (feeChecked && value + 120_000n * MAX_FEE > balance)) {
      throw { code: -32000, message: 'insufficient funds for gas * price + value' };
    }
    if (value === 0n && tx.data) throw { code: 3, message: 'execution reverted: ZERO_DEPOSIT' };
    return '0x' + (120_000).toString(16);
  };
  const estimates = () => rpcLog.filter((r) => r.method === 'eth_estimateGas').map((r) => r.params[0]);
  const attempt = async (mod, balance, opts) => {
    scenario = defaultScenario();
    scenario.ethBalance = balance;
    scenario.estimateGasFn = payableNode(balance, opts);
    rpcLog = [];
    try {
      await mod.prepareEvmSend(URL, FROM, LIDO, STAKE, SUBMIT);
      return { error: null, estimates: estimates() };
    } catch (e) {
      return { error: e, estimates: estimates() };
    }
  };
  const real = { prepareEvmSend };

  // A: the stake exceeds the balance outright.
  const a = await attempt(real, 10n ** 14n);
  const aWant = `Insufficient funds: sending ${STAKE} wei plus a worst-case fee of at least ${MIN_FEE} wei exceeds the balance of ${10n ** 14n} wei`;
  check('A: a stake above the balance → the insufficient-funds sentence (exact)', a.error?.message === aWant, a.error?.message);
  check('A: …refused BEFORE any estimate (zero eth_estimateGas requests)', a.estimates.length === 0, JSON.stringify(a.estimates));
  check('A: …titled "Not enough test ETH to cover this amount plus the network fee." (no contract revert)',
    !(a.error instanceof GasEstimateRevertError) && describeSendError(a.error, 'test ETH').title === 'Not enough test ETH to cover this amount plus the network fee.' &&
      !/ZERO_DEPOSIT|revert/i.test(describeSendError(a.error, 'test ETH').detail));
  // A2: the balance covers the value but not even the smallest fee on top.
  const a2 = await attempt(real, STAKE + MIN_FEE - 1n);
  check('A2: value ≤ balance < value + 21,000 × max fee → refused before estimating', a2.estimates.length === 0 && /^Insufficient funds: /.test(a2.error?.message ?? ''), a2.error?.message);
  // At exactly value + the smallest fee the pre-check lets it through (a lower bound never refuses an affordable send).
  const edge = await attempt(real, STAKE + MIN_FEE);
  check('the pre-check is a lower bound: at exactly value + 21,000 × max fee it estimates (then the real fee refuses it)',
    edge.estimates.length === 1 && /^Insufficient funds: sending \d+ wei plus a worst-case fee of 360000000000000 wei/.test(edge.error?.message ?? ''), edge.error?.message);

  // B: the pre-check passes, the node refuses the estimate for funds (it
  // checks the fee too). The answer is the node's funds error, never a
  // value-0 re-estimate and its ZERO_DEPOSIT revert.
  const b = await attempt(real, STAKE + MIN_FEE, { feeChecked: true });
  check('B: an estimate refused for funds is NOT retried with value 0 (one estimate, with the real value)',
    b.estimates.length === 1 && BigInt(b.estimates[0].value) === STAKE, JSON.stringify(b.estimates));
  check('B: …and reads "Not enough ETH to pay the network fee." (the node’s own text as detail, no revert)',
    !(b.error instanceof GasEstimateRevertError) && describeSendError(b.error, 'ETH').title === 'Not enough ETH to pay the network fee.' && !/ZERO_DEPOSIT/.test(String(b.error?.message)), String(b.error?.message));

  // An affordable stake quotes normally with one estimate.
  const ok = await attempt(real, 10n ** 18n);
  check('an affordable stake quotes with exactly one estimate at the real value', ok.error === null && ok.estimates.length === 1 && BigInt(ok.estimates[0].value) === STAKE, String(ok.error));

  // C: a plain transfer keeps today's behaviour byte for byte: the estimate
  // at the value fails, the value-0 retry gives 21,000, and the balance
  // check refuses with the old wording (no "at least").
  scenario = defaultScenario();
  scenario.ethBalance = 10n ** 14n;
  scenario.estimateGasFn = (tx) => {
    if (BigInt(tx.value ?? '0x0') > 10n ** 14n) throw { code: -32000, message: 'insufficient funds for transfer' };
    return '0x' + (21_000).toString(16);
  };
  rpcLog = [];
  const c = await rejection(() => prepareEvmSend(URL, FROM, TO, STAKE));
  check('C: plain transfer — the same two estimates as before: [value = amount, value = 0], no data field',
    JSON.stringify(estimates()) === JSON.stringify([
      { from: FROM, to: TO, value: '0x' + STAKE.toString(16) },
      { from: FROM, to: TO, value: '0x0' },
    ]), JSON.stringify(estimates()));
  check('C: …and the old sentence, byte for byte',
    c?.message === `Insufficient funds: sending ${STAKE} wei plus a worst-case fee of ${21_000n * MAX_FEE} wei exceeds the balance of ${10n ** 14n} wei`, c?.message);
  check('C: …request sequence: chain id, balance, nonce, fee reads, then the two estimates (nothing new before them)',
    rpcLog.slice(-2).every((r) => r.method === 'eth_estimateGas') && rpcLog.filter((r) => r.method === 'eth_estimateGas').length === 2);

  // D: a value-0 call (a token approval) whose estimate reverts: one
  // estimate, the contract-call sentence (the duplicate value-0 retry is gone).
  scenario = defaultScenario();
  scenario.estimateGasFn = () => { throw { code: 3, message: 'execution reverted: Not allowed' }; };
  rpcLog = [];
  const d = await rejection(() => prepareEvmSend(URL, FROM, CONTRACT, 0n, new Uint8Array([0x09, 0x5e, 0xa7, 0xb3])));
  check('D: a value-0 contract call that reverts: one estimate, the contract-call sentence',
    estimates().length === 1 && describeSendError(d, 'ETH').detail === 'The contract rejected this transaction during estimation (execution reverted: Not allowed). Nothing was sent.', describeSendError(d, 'ETH').detail);

  // Mutants (each must be caught).
  const keepsRetry = await sendMutant('  if (dataHex === undefined) {\n    try {\n      gasLimit = await node.estimateGas', '  if (true) {\n    try {\n      gasLimit = await node.estimateGas');
  const mb = await attempt(keepsRetry, STAKE + MIN_FEE, { feeChecked: true });
  check('mutant (the value-0 retry kept for calldata) is caught: it re-estimates with value 0 and shows ZERO_DEPOSIT',
    mb.estimates.length === 2 && BigInt(mb.estimates[1].value) === 0n && mb.error instanceof keepsRetry.GasEstimateRevertError && /ZERO_DEPOSIT/.test(mb.error.message),
    String(mb.error?.message));
  const noPrecheck = await sendMutant('  if (dataHex !== undefined && amount > 0n) {', '  if (false) {');
  const ma = await attempt(noPrecheck, 10n ** 14n);
  check('mutant (no balance pre-check) is caught: it estimates first and loses the exact sentence',
    ma.estimates.length > 0 && ma.error?.message !== aWant, `${ma.estimates.length} / ${ma.error?.message}`);
  scenario = defaultScenario();
}

async function rejection(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

// ---------------------------------------------------------------------------
// Phase 20 item 3: the fee-symbol rollout. Every describeSendError call in
// the app passes the fee coin (a third argument), so no screen falls back to
// the default "ETH" on a test network; describeNftSendError callers pass it
// too. Source scan with balanced parentheses.
// ---------------------------------------------------------------------------
console.log('fee coin passed by every caller (source):');
{
  const { readdirSync, statSync } = await import('node:fs');
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const full = join(d, f);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(f)) files.push(full);
    }
  };
  walk(SRC);
  const argsOf = (text, at) => {
    let depth = 0;
    let i = text.indexOf('(', at);
    const start = i + 1;
    const parts = [];
    let last = start;
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') {
        depth -= 1;
        if (depth === 0) break;
      } else if (c === ',' && depth === 1) {
        parts.push(text.slice(last, i).trim());
        last = i + 1;
      }
    }
    parts.push(text.slice(last, i).trim());
    return parts.filter((x) => x.length > 0);
  };
  const missing = (name, minArgs) => {
    const out = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const re = new RegExp(`\\b${name}\\(`, 'g');
      let m;
      while ((m = re.exec(text))) {
        const before = text.slice(Math.max(0, m.index - 16), m.index);
        if (/function\s+$/.test(before)) continue;
        if (argsOf(text, m.index).length < minArgs) out.push(`${f.slice(SRC.length + 1)}@${text.slice(0, m.index).split('\n').length}`);
      }
    }
    return out;
  };
  const sendMissing = missing('describeSendError', 3);
  check('every describeSendError call in app/src passes the fee coin', sendMissing.length === 0, sendMissing.join(', '));
  const nftMissing = missing('describeNftSendError', 2);
  check('every describeNftSendError call passes the fee coin', nftMissing.length === 0, nftMissing.join(', '));
  check('…the scan sees the calls (sanity)', files.some((f) => readFileSync(f, 'utf8').includes('describeSendError(e, sellSymbol, evmChain.displaySymbol)')));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

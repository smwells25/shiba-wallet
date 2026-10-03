// Exercises the swap flow glue (src/wallet/swap.ts) entirely OFFLINE:
// a fake global fetch answers both the 0x allowance-holder quote endpoint
// (per the request/response contract documented and verified in
// packages/chains-evm/src/swap.ts) and the JSON-RPC node calls the send
// machinery makes, so the exact modules the app runs are tested end to
// end — key-store verify-before-save discipline, quote fetching with the
// active chain id, exact-bigint amounts, slippage/rate/staleness helpers,
// allowance gating with the exact-amount approve, and execution of the
// 0x calldata through the existing prepareEvmSend/sendEvm path — without
// a network and without a live trade. Nothing here touches a real
// endpoint or a real key.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-swap.mjs
//
// The signing key derives from the standard BIP-39 test mnemonic
// ("abandon ... about"), which is public knowledge. Raw transactions are
// cross-checked field by field with ethers (an independent
// implementation), the check-wc.mjs discipline.

import { Transaction } from 'ethers';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { encodeErc20Approve, selector, toHex } from '@shiba-wallet/chains-evm';
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  NATIVE_TOKEN_ADDRESS,
  QUOTE_MAX_AGE_MS,
  assertSellBalance,
  checkAllowance,
  clearSwapApiKey,
  describeSwapFailure,
  estimateSwapFee,
  fetchErc20Allowance,
  fetchSwapQuote,
  getSwapConfig,
  impliedRate,
  isQuoteStale,
  prepareApproveSend,
  prepareSwapSend,
  setSwapApiKey,
  validateSlippageBps,
  waitForAllowance,
} from '../src/wallet/swap.ts';
import { sendEvm } from '../src/wallet/send.ts';
import { USDC_MAINNET } from '../src/wallet/erc20.ts';
import { assertSecureEndpointUrl } from '../src/config/endpoint-url.ts';

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

function memoryStore(initial = new Map()) {
  const mem = initial;
  return {
    getItem: async (key) => (mem.has(key) ? mem.get(key) : null),
    setItem: async (key, value) => {
      mem.set(key, value);
    },
    raw: mem,
  };
}

// ---------------------------------------------------------------------------
// Fixtures (EIP-55 test-vector addresses from the EIP text; USDC as
// verified in src/wallet/erc20.ts; a distinctive fake 0x router + calldata)
// ---------------------------------------------------------------------------

const TAKER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TOKEN = USDC_MAINNET.assetId.reference; // 0xA0b8…eB48
const ZEROX_TO = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const ZEROX_DATA = '0x1fff991f' + '0badc0de'.repeat(40); // 164 bytes, distinctive
const RPC_URL = 'http://offline.fake/rpc';
const API_KEY = 'test-0x-key-1234';

const GWEI = 1000000000n;
const uintWord = (n) => '0x' + n.toString(16).padStart(64, '0');
const pad32 = (address) => address.toLowerCase().slice(2).padStart(64, '0');

// Well-known 4-byte selectors, hand-checkable against any signature DB.
const ALLOWANCE_SELECTOR = '0xdd62ed3e';
const APPROVE_SELECTOR = '0x095ea7b3';
check(
  "engine selector('allowance(address,address)') is the well-known dd62ed3e",
  toHex(selector('allowance(address,address)')) === ALLOWANCE_SELECTOR,
);
check(
  "engine selector('approve(address,uint256)') is the well-known 095ea7b3",
  toHex(selector('approve(address,uint256)')) === APPROVE_SELECTOR,
);

// ---------------------------------------------------------------------------
// Fake 0x endpoint + fake JSON-RPC node, both behind global fetch (the
// app's default paths: zeroExSwapProvider hits https://api.0x.org/…, the
// engine's httpTransport POSTs JSON-RPC).
// ---------------------------------------------------------------------------

let zeroEx = {};
let zeroExCalls = [];

function defaultZeroEx() {
  return {
    status: 200,
    throwNetwork: false,
    liquidityAvailable: true,
    sellAmount: '1000000000000000000',
    buyAmount: '2500123456',
    minBuyAmount: '2487622839',
    to: ZEROX_TO,
    data: ZEROX_DATA,
    value: '0',
    gas: '250000',
    gasPrice: '3000000000',
  };
}

function zeroExResponse(url) {
  const parsed = new URL(url);
  if (zeroEx.throwNetwork) throw new TypeError('fetch failed (offline fake)');
  if (zeroEx.status !== 200) {
    return { ok: false, status: zeroEx.status, json: async () => ({}) };
  }
  if (!zeroEx.liquidityAvailable) {
    return { ok: true, status: 200, json: async () => ({ liquidityAvailable: false }) };
  }
  void parsed;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      liquidityAvailable: true,
      sellAmount: zeroEx.sellAmount,
      buyAmount: zeroEx.buyAmount,
      minBuyAmount: zeroEx.minBuyAmount,
      transaction: {
        to: zeroEx.to,
        data: zeroEx.data,
        value: zeroEx.value,
        gas: zeroEx.gas,
        gasPrice: zeroEx.gasPrice,
      },
    }),
  };
}

let rpc = {};
let rpcCalls = [];
let lastRawTx = null;

function defaultRpc() {
  return {
    chainId: '0x1',
    ethBalance: 2n * 10n ** 18n, // 2 ETH
    nonce: '0x7',
    baseFeePerGas: GWEI, // suggestFees -> maxFeePerGas = 3 gwei
    priorityFee: GWEI,
    estimateGas: 210000n,
    allowance: 0n,
    swapCallResult: '0x',
    txid: '0x' + 'cd'.repeat(32),
  };
}

function rpcResult(method, params) {
  const s = rpc;
  rpcCalls.push({ method, params });
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
      return '0x' + s.estimateGas.toString(16);
    case 'eth_call': {
      const data = params[0].data ?? '';
      if (data.startsWith(ALLOWANCE_SELECTOR)) return uintWord(s.allowance);
      if (data.startsWith(APPROVE_SELECTOR)) return uintWord(1n); // approve returns true
      if (data.startsWith('0x1fff991f')) return s.swapCallResult;
      throw { code: -32000, message: `unexpected eth_call data ${data.slice(0, 10)}` };
    }
    case 'eth_sendRawTransaction':
      lastRawTx = params[0];
      return s.txid;
    default:
      throw { code: -32601, message: `unexpected method ${method}` };
  }
}

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.includes('/swap/allowance-holder/quote')) {
    zeroExCalls.push({ url: new URL(target), headers: init?.headers ?? {} });
    return zeroExResponse(target);
  }
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
// 1. API-key store: verify-before-save, rejected keys persist nothing.
// ---------------------------------------------------------------------------

console.log('key store (verify-before-save):');

let store = memoryStore();
let config = await getSwapConfig(store);
check('empty store -> no key, no verification date', config.apiKey === null && config.verifiedAt === null);

zeroEx = defaultZeroEx();
zeroExCalls = [];
await setSwapApiKey(API_KEY, TAKER, { store });
config = await getSwapConfig(store);
check('successful verification persists the key', config.apiKey === API_KEY);
check(
  'verifiedAt is an ISO timestamp',
  typeof config.verifiedAt === 'string' && !Number.isNaN(Date.parse(config.verifiedAt)),
);
check('exactly one verification request was made', zeroExCalls.length === 1);
{
  const call = zeroExCalls[0];
  const p = call.url.searchParams;
  check('verification sends the key as the 0x-api-key header', call.headers['0x-api-key'] === API_KEY);
  check("verification sends the 0x-version: v2 header", call.headers['0x-version'] === 'v2');
  check('canonical pair: chainId 1', p.get('chainId') === '1');
  check('canonical pair: sellToken is the native sentinel', p.get('sellToken') === NATIVE_TOKEN_ADDRESS);
  check('canonical pair: buyToken is the verified USDC address', p.get('buyToken') === TOKEN);
  check('canonical pair: 0.001 ETH sell amount', p.get('sellAmount') === '1000000000000000');
  check('taker is the wallet address', p.get('taker') === TAKER);
  check('minimal params: no slippageBps on the verification request', p.get('slippageBps') === null);
  // Swap settings take only an API key, never a URL: the key is sent to
  // the engine's fixed 0x base, which must be https (the endpoint rule in
  // src/config/endpoint-url.ts) so the key never travels in clear text.
  check(
    'the key goes only to https://api.0x.org (fixed base, https)',
    call.url.protocol === 'https:' && call.url.host === 'api.0x.org',
    call.url.href,
  );
  check(
    'the 0x base passes the shared endpoint URL rule unchanged',
    assertSecureEndpointUrl(call.url.origin) === 'https://api.0x.org',
  );
}

for (const status of [401, 403]) {
  store = memoryStore();
  zeroEx = defaultZeroEx();
  zeroEx.status = status;
  await checkRejects(
    `HTTP ${status} refuses the key with a key message`,
    () => setSwapApiKey(API_KEY, TAKER, { store }),
    /rejected this API key/,
  );
  check(`HTTP ${status} persisted nothing`, (await getSwapConfig(store)).apiKey === null);
}

store = memoryStore();
zeroEx = defaultZeroEx();
zeroEx.status = 500;
await checkRejects(
  'HTTP 500 refuses with a retryable message (key may be fine)',
  () => setSwapApiKey(API_KEY, TAKER, { store }),
  /try again/,
);
check('HTTP 500 persisted nothing', (await getSwapConfig(store)).apiKey === null);

store = memoryStore();
zeroEx = defaultZeroEx();
zeroEx.throwNetwork = true;
await checkRejects(
  'network failure refuses with a retryable message',
  () => setSwapApiKey(API_KEY, TAKER, { store }),
  /Could not reach the swap service/,
);
check('network failure persisted nothing', (await getSwapConfig(store)).apiKey === null);

store = memoryStore();
zeroEx = defaultZeroEx();
zeroExCalls = [];
await checkRejects(
  'a key containing whitespace is refused before any network call',
  () => setSwapApiKey('bad key', TAKER, { store }),
  /no spaces/,
);
check('malformed key made no network request', zeroExCalls.length === 0);

store = memoryStore();
zeroEx = defaultZeroEx();
zeroEx.liquidityAvailable = false;
await setSwapApiKey(API_KEY, TAKER, { store });
check(
  'an honest no-liquidity answer still verifies the key (auth passed)',
  (await getSwapConfig(store)).apiKey === API_KEY,
);

store = memoryStore();
store.raw.set('shiba-wallet.swap-config.v1', '{not json');
config = await getSwapConfig(store);
check('corrupt storage reads as unconfigured (no throw)', config.apiKey === null);

store = memoryStore();
zeroEx = defaultZeroEx();
await setSwapApiKey(API_KEY, TAKER, { store });
await clearSwapApiKey(store);
check('clearSwapApiKey removes the key', (await getSwapConfig(store)).apiKey === null);

// ---------------------------------------------------------------------------
// 2. Quote flow through the engine seam: active chain id, exact bigints,
//    honest no-liquidity/error rendering.
// ---------------------------------------------------------------------------

console.log('quote flow:');

zeroEx = defaultZeroEx();
// Amounts far above 2^53 to prove nothing round-trips through floats.
zeroEx.sellAmount = '123456789012345678901234';
zeroEx.buyAmount = '987654321098765432109876543';
zeroEx.minBuyAmount = '982715949493571604949327210';
zeroEx.value = '123456789012345678901234';
zeroExCalls = [];
let view = await fetchSwapQuote({
  apiKey: API_KEY,
  chainIdDecimal: '11155111', // the ACTIVE chain id is passed through verbatim
  sellToken: NATIVE_TOKEN_ADDRESS,
  buyToken: TOKEN,
  sellAmount: 123456789012345678901234n,
  taker: TAKER,
  slippageBps: DEFAULT_SLIPPAGE_BPS,
});
{
  const p = zeroExCalls[0].url.searchParams;
  check('quote request carries the ACTIVE chain id (11155111)', p.get('chainId') === '11155111');
  check('quote request carries slippageBps', p.get('slippageBps') === String(DEFAULT_SLIPPAGE_BPS));
  check('quote request carries the exact sell amount', p.get('sellAmount') === '123456789012345678901234');
}
check('quote result is ok', view.result.ok === true);
{
  const q = view.result.quote;
  check('sellAmount is an exact bigint (> 2^53)', q.sellAmount === 123456789012345678901234n);
  check('buyAmount is an exact bigint (> 2^53)', q.buyAmount === 987654321098765432109876543n);
  check('minBuyAmount is an exact bigint (> 2^53)', q.minBuyAmount === 982715949493571604949327210n);
  check('transaction.to/data pass through verbatim', q.transaction.to === ZEROX_TO && q.transaction.data === ZEROX_DATA);
  check('transaction.value is an exact bigint', q.transaction.value === 123456789012345678901234n);
  check('transaction.gas parsed', q.transaction.gas === 250000n);
}
check('quotedAt is now-ish', Math.abs(Date.now() - view.quotedAt) < 5000);

zeroEx = defaultZeroEx();
zeroEx.liquidityAvailable = false;
view = await fetchSwapQuote({
  apiKey: API_KEY,
  chainIdDecimal: '1',
  sellToken: NATIVE_TOKEN_ADDRESS,
  buyToken: TOKEN,
  sellAmount: 10n ** 18n,
  taker: TAKER,
  slippageBps: 50,
});
check(
  'liquidityAvailable:false renders as the no-liquidity arm',
  view.result.ok === false && view.result.reason === 'no-liquidity',
);
check(
  'describeSwapFailure(no-liquidity) says so plainly',
  describeSwapFailure(view.result).includes('No liquidity'),
);

zeroEx = defaultZeroEx();
zeroEx.status = 500;
view = await fetchSwapQuote({
  apiKey: API_KEY,
  chainIdDecimal: '1',
  sellToken: NATIVE_TOKEN_ADDRESS,
  buyToken: TOKEN,
  sellAmount: 10n ** 18n,
  taker: TAKER,
  slippageBps: 50,
});
check(
  'an HTTP failure renders as the error arm with the status in the detail',
  view.result.ok === false && view.result.reason === 'error' && /HTTP 500/.test(view.result.detail ?? ''),
);
check(
  'describeSwapFailure(error) carries the detail',
  describeSwapFailure(view.result).includes('HTTP 500'),
);

// Our own fee estimate next to the 0x gas figure: gas × suggested max fee.
zeroEx = defaultZeroEx();
rpc = defaultRpc();
view = await fetchSwapQuote({
  apiKey: API_KEY,
  chainIdDecimal: '1',
  sellToken: NATIVE_TOKEN_ADDRESS,
  buyToken: TOKEN,
  sellAmount: 10n ** 18n,
  taker: TAKER,
  slippageBps: 50,
});
{
  const fee = await estimateSwapFee(RPC_URL, view.result.quote);
  check('estimateSwapFee: 0x gas passed through', fee.zeroExGas === 250000n);
  check('estimateSwapFee: worst case = gas × suggestFees maxFeePerGas (3 gwei)', fee.worstCaseFee === 250000n * 3n * GWEI);
}

// ---------------------------------------------------------------------------
// 3. Slippage bounds, implied rate, staleness.
// ---------------------------------------------------------------------------

console.log('slippage / rate / staleness:');

check('validateSlippageBps accepts 75', validateSlippageBps('75') === 75);
check('bounds are 1..1000 bps', MIN_SLIPPAGE_BPS === 1 && MAX_SLIPPAGE_BPS === 1000);
for (const [input, name] of [
  ['0', 'zero'],
  ['1001', 'above 10%'],
  ['', 'empty'],
  ['abc', 'non-numeric'],
  ['0.5', 'fractional bps'],
  ['-5', 'negative'],
]) {
  let threw = false;
  try {
    validateSlippageBps(input);
  } catch {
    threw = true;
  }
  check(`validateSlippageBps rejects ${name} ("${input}")`, threw);
}

check(
  'impliedRate: 2 ETH -> 5000.123456 USDC gives 2500.061728 per ETH (exact)',
  impliedRate(2n * 10n ** 18n, 5000123456n, 18, 6) === '2500.061728',
  impliedRate(2n * 10n ** 18n, 5000123456n, 18, 6),
);
check('impliedRate truncates toward zero (10/3 units)', impliedRate(3n, 10n, 0, 0) === '3');
check('impliedRate with zero sell amount yields an em-dash', impliedRate(0n, 10n, 0, 0) === '—');

const now = Date.now();
check('a 59 s old quote is fresh', isQuoteStale(now - 59_000, now) === false);
check('a 61 s old quote is stale', isQuoteStale(now - 61_000, now) === true);
check('the staleness horizon is 60 s', QUOTE_MAX_AGE_MS === 60_000);

// ---------------------------------------------------------------------------
// 4. Allowance gating: sufficient skips approve; insufficient approves the
//    EXACT sell amount first, through the existing send machinery.
// ---------------------------------------------------------------------------

console.log('allowance gating:');

const SELL_AMOUNT = 250000000n; // 250 USDC

rpc = defaultRpc();
rpc.allowance = 123456n;
rpcCalls = [];
const allowance = await fetchErc20Allowance(RPC_URL, TOKEN, TAKER, ZEROX_TO);
check('fetchErc20Allowance decodes the uint256', allowance === 123456n);
{
  const call = rpcCalls.find((c) => c.method === 'eth_call');
  check(
    'allowance calldata is selector + padded owner + padded spender (hand-built)',
    call.params[0].data === ALLOWANCE_SELECTOR + pad32(TAKER) + pad32(ZEROX_TO) &&
      call.params[0].to === TOKEN,
    call.params[0].data,
  );
}

rpc = defaultRpc();
rpc.allowance = SELL_AMOUNT; // exactly enough
let gate = await checkAllowance(RPC_URL, TOKEN, TAKER, ZEROX_TO, SELL_AMOUNT);
check('allowance == sellAmount is sufficient (no approve step)', gate.sufficient === true);

rpc = defaultRpc();
rpc.allowance = SELL_AMOUNT - 1n;
gate = await checkAllowance(RPC_URL, TOKEN, TAKER, ZEROX_TO, SELL_AMOUNT);
check('allowance one short is insufficient (approve step runs)', gate.sufficient === false);

rpc = defaultRpc();
rpc.allowance = 0n;
const approveQuote = await prepareApproveSend(RPC_URL, TAKER, TOKEN, ZEROX_TO, SELL_AMOUNT, 'eip155:1');
const handBuiltApprove = APPROVE_SELECTOR + pad32(ZEROX_TO) + SELL_AMOUNT.toString(16).padStart(64, '0');
check('approve tx targets the token contract with value 0', approveQuote.to === TOKEN && approveQuote.amount === 0n);
check(
  'approve calldata equals hand-built ABI bytes for the EXACT sell amount',
  toHex(approveQuote.data) === handBuiltApprove,
  toHex(approveQuote.data),
);
check(
  'approve calldata equals the engine encodeErc20Approve encoding',
  toHex(approveQuote.data) === toHex(encodeErc20Approve(ZEROX_TO, SELL_AMOUNT)),
);
check(
  'the approval is NOT unlimited (no max-uint word)',
  !toHex(approveQuote.data).includes('f'.repeat(64)),
);
check('approve pre-flight simulation passed', approveQuote.simulation.ok === true);

const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const signer = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);

rpc = defaultRpc();
lastRawTx = null;
const approveSent = await sendEvm(RPC_URL, signer, approveQuote);
check('approve broadcast returns the node txid', approveSent.txid === rpc.txid);
{
  const decoded = Transaction.from(lastRawTx);
  check('approve raw tx targets the token contract (ethers-decoded)', decoded.to === TOKEN);
  check(
    'approve raw tx carries the exact-amount approve calldata verbatim',
    decoded.data === handBuiltApprove,
    decoded.data,
  );
  check('approve raw tx has value 0', decoded.value === 0n);
  check('approve raw tx signed by the taker key', decoded.from === signer.address);
}

// waitForAllowance: flips after two polls; then a timeout case.
{
  rpc = defaultRpc();
  rpc.allowance = 0n;
  let polls = 0;
  const ok = await waitForAllowance(RPC_URL, TOKEN, TAKER, ZEROX_TO, SELL_AMOUNT, {
    timeoutMs: 10_000,
    pollMs: 1,
    sleepFn: async () => {
      polls += 1;
      if (polls === 2) rpc.allowance = SELL_AMOUNT; // the approve "mines"
    },
  });
  check('waitForAllowance returns true once the approve takes effect', ok === true && polls >= 2);

  rpc = defaultRpc();
  rpc.allowance = 0n;
  const timedOut = await waitForAllowance(RPC_URL, TOKEN, TAKER, ZEROX_TO, SELL_AMOUNT, {
    timeoutMs: 5,
    pollMs: 1,
    sleepFn: async () => {},
  });
  check('waitForAllowance returns false on timeout (never proceeds blind)', timedOut === false);
}

// ---------------------------------------------------------------------------
// 5. Execute: the 0x transaction through the EXISTING send path, calldata
//    verbatim; refusals for wrong chain and insufficient balance.
// ---------------------------------------------------------------------------

console.log('execute (0x calldata through prepareEvmSend/sendEvm):');

zeroEx = defaultZeroEx();
zeroEx.value = '1000000000000000000'; // native sell: 1 ETH
rpc = defaultRpc();
view = await fetchSwapQuote({
  apiKey: API_KEY,
  chainIdDecimal: '1',
  sellToken: NATIVE_TOKEN_ADDRESS,
  buyToken: TOKEN,
  sellAmount: 10n ** 18n,
  taker: TAKER,
  slippageBps: 50,
});
const swapQuote = view.result.quote;
const sendQuote = await prepareSwapSend(RPC_URL, TAKER, swapQuote, 'eip155:1');
check('send quote targets the 0x transaction.to', sendQuote.to === ZEROX_TO);
check('send quote carries the 0x value (native sell)', sendQuote.amount === 10n ** 18n);
check('send quote carries the 0x calldata', toHex(sendQuote.data) === ZEROX_DATA.toLowerCase());
check('send quote fee = gasLimit × maxFeePerGas', sendQuote.fee === 210000n * 3n * GWEI);
check('swap pre-flight simulation passed', sendQuote.simulation.ok === true);

rpc = defaultRpc(); // fake node reports chain 1
await checkRejects(
  'wrong-chain endpoint refused against the active profile (Sepolia expected)',
  () => prepareSwapSend(RPC_URL, TAKER, swapQuote, 'eip155:11155111'),
  /chain id 1, expected 11155111/,
);

rpc = defaultRpc();
rpc.ethBalance = 10n ** 18n; // exactly the value: cannot also cover the fee
await checkRejects(
  'native sell refused when balance cannot cover value + worst-case fee',
  () => prepareSwapSend(RPC_URL, TAKER, swapQuote, 'eip155:1'),
  /Insufficient funds/,
);

rpc = defaultRpc();
lastRawTx = null;
const swapSent = await sendEvm(RPC_URL, signer, sendQuote);
check('swap broadcast returns the node txid', swapSent.txid === rpc.txid);
{
  const decoded = Transaction.from(lastRawTx);
  check('swap raw tx targets the 0x contract (ethers-decoded)', decoded.to === ZEROX_TO);
  check('swap raw tx carries the 0x calldata VERBATIM', decoded.data === ZEROX_DATA.toLowerCase());
  check('swap raw tx carries the 0x value', decoded.value === 10n ** 18n);
  check('swap raw tx is EIP-1559 on chain 1', decoded.type === 2 && decoded.chainId === 1n);
  check('swap raw tx signed by the taker key', decoded.from === signer.address);
}

// Insufficient sell balance is refused before any quote is requested.
check(
  'assertSellBalance passes when amount <= balance',
  (() => {
    assertSellBalance(5n, 5n, 'USDC');
    return true;
  })(),
);
await checkRejects(
  'assertSellBalance refuses amount > balance with the symbol in the message',
  async () => assertSellBalance(6n, 5n, 'USDC'),
  /USDC exceeds the balance/,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

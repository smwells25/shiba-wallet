// Base Sepolia (OP-stack) fee handling in the EOA send flow — phase 11 item 5.
//
// OFFLINE by default: a fake JSON-RPC node behind global fetch emulates an
// OP-stack chain's GasPriceOracle predeploy (getL1Fee(bytes) and
// getOperatorFee(uint256) at 0x420000000000000000000000000000000000000F)
// next to the usual node methods, so the exact app modules are exercised:
// src/wallet/send.ts (prepareEvmSend, maxEvmSend, sendEvm and the OP-stack
// helpers), src/wallet/send-nft.ts (prepareNftSend) and
// src/wallet/send-erc20.ts (still pinned to mainnet). What is pinned:
//
//  - the unsigned transaction handed to getL1Fee equals ethers'
//    Transaction.unsignedSerialized (an independent implementation) and is
//    exactly the transaction sendEvm later signs;
//  - fee = gasLimit * maxFeePerGas + reserved L1 data fee + operator fee,
//    with the reserve = estimate + ceil(50% of it), and the balance check
//    and Max use the same figure (op-geth's buyGas balance check);
//  - Ethereum mainnet and Sepolia quotes make no oracle call and carry no
//    OP-stack fields (their quotes are unchanged);
//  - an oracle that fails or answers malformed data refuses the quote.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-base.mjs           # offline
//   node scripts/check-base.mjs --live    # plus a read-only Base Sepolia probe
//
// The --live pass quotes a sample transfer through the app glue against the
// Base Sepolia default RPC (read-only: eth_call, eth_estimateGas and fee
// reads; nothing is signed or sent) and prints the numbers.
//
// The signing key derives from the standard BIP-39 test mnemonic
// ("abandon ... about"), which is public knowledge.

import { ethers } from 'ethers';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { encodeFunctionCall, selector, toBytes, toHex } from '@shiba-wallet/chains-evm';
import {
  L1_DATA_FEE_HEADROOM_PERCENT,
  OP_STACK_GAS_PRICE_ORACLE,
  chainHasL1DataFee,
  maxEvmSend,
  opStackFeeTotal,
  prepareEvmSend,
  quoteOpStackFees,
  sendEvm,
  serializeUnsignedEip1559,
} from '../src/wallet/send.ts';
import { prepareNftSend, sendNft } from '../src/wallet/send-nft.ts';
import { prepareErc20Send } from '../src/wallet/send-erc20.ts';
import { EVM_BASE_SEPOLIA, EVM_MAINNET, EVM_SEPOLIA } from '../src/config/evm-chain.ts';
import { RECORD_FILE_NAME_PATTERN, rebuildRecoveryRecord, recordExportFileName } from '../src/wallet/recovery.ts';
import { KERNEL_ACCOUNT_0, OWNER_0 } from './fakes-kernel.mjs';

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
    check(name, false, `expected a rejection, got ${String(value)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, messagePattern.test(message), `error was: ${message}`);
  }
}

const GWEI = 1_000_000_000n;
const URL = 'https://offline.fake/rpc';
const FROM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'; // account 0 of the test mnemonic
const TO = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const NFT_CONTRACT = '0x' + '77'.repeat(20);
const uintWord = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const sel = (signature) => toHex(selector(signature));
const GET_L1_FEE = sel('getL1Fee(bytes)');
const GET_OPERATOR_FEE = sel('getOperatorFee(uint256)');
const OWNER_OF = sel('ownerOf(uint256)');
const abi = ethers.AbiCoder.defaultAbiCoder();

// ---------------------------------------------------------------------------
// Fake node. `scenario` is reassigned per test; every request is recorded.
// ---------------------------------------------------------------------------

let scenario = {};
let requests = [];
let lastRawTx = null;

function defaultScenario(chainIdHex) {
  return {
    chainId: chainIdHex,
    balance: 10n ** 15n, // 0.001 ETH
    nonce: '0x7',
    baseFeePerGas: 1_000_000n, // 0.001 gwei, Base-like
    priorityFee: 1_000_000n,
    estimateGas: 21000n,
    l1Fee: 5_895_253_350n, // the order of magnitude seen live on 2026-10-03
    operatorFee: 0n,
    oracleError: null,
    oracleResult: null, // raw override of the getL1Fee answer
    nftOwner: FROM,
    txid: '0x' + 'cd'.repeat(32),
  };
}

function rpcResult(method, params) {
  const s = scenario;
  requests.push({ method, params });
  switch (method) {
    case 'eth_chainId':
      return s.chainId;
    case 'eth_getBalance':
      return '0x' + s.balance.toString(16);
    case 'eth_getTransactionCount':
      return s.nonce;
    case 'eth_getBlockByNumber':
      return { baseFeePerGas: '0x' + s.baseFeePerGas.toString(16) };
    case 'eth_maxPriorityFeePerGas':
      return '0x' + s.priorityFee.toString(16);
    case 'eth_estimateGas':
      return '0x' + s.estimateGas.toString(16);
    case 'eth_call': {
      const { to, data = '0x' } = params[0];
      if (to.toLowerCase() === OP_STACK_GAS_PRICE_ORACLE.toLowerCase()) {
        if (s.oracleError) throw { code: -32000, message: s.oracleError };
        if (data.startsWith(GET_L1_FEE)) return s.oracleResult ?? uintWord(s.l1Fee);
        if (data.startsWith(GET_OPERATOR_FEE)) return uintWord(s.operatorFee);
        throw { code: -32000, message: `unexpected oracle call ${data.slice(0, 10)}` };
      }
      if (data.startsWith(sel('balanceOf(address)'))) return uintWord(10n ** 6n);
      if (data.startsWith(OWNER_OF)) return '0x' + '0'.repeat(24) + s.nftOwner.slice(2).toLowerCase();
      return '0x'; // the pre-flight simulation of a transfer
    }
    case 'eth_sendRawTransaction':
      lastRawTx = params[0];
      return s.txid;
    default:
      throw { code: -32601, message: `unexpected method ${method}` };
  }
}

const realFetch = globalThis.fetch;
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

function oracleCalls() {
  return requests.filter(
    (r) => r.method === 'eth_call' && r.params[0].to.toLowerCase() === OP_STACK_GAS_PRICE_ORACLE.toLowerCase(),
  );
}

/** The bytes argument of the recorded getL1Fee call, decoded with ethers. */
function pricedUnsignedTx() {
  const call = oracleCalls().find((r) => r.params[0].data.startsWith(GET_L1_FEE));
  if (!call) return null;
  const [bytes] = abi.decode(['bytes'], '0x' + call.params[0].data.slice(10));
  return bytes;
}

function signer() {
  const seed = mnemonicToSeed(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  const account = evmKeyProvider.deriveAccount(seed, 0, 0);
  seed.fill(0);
  return account;
}

const reserveOf = (estimate) =>
  estimate + (estimate * L1_DATA_FEE_HEADROOM_PERCENT + 99n) / 100n;

// ---------------------------------------------------------------------------
// 1. Profiles and the unsigned serialization
// ---------------------------------------------------------------------------

console.log('profiles and unsigned serialization:');

check('Base Sepolia profile has l1DataFee', EVM_BASE_SEPOLIA.l1DataFee === true);
check('chainHasL1DataFee(84532) is true', chainHasL1DataFee(84532n));
check(
  'chainHasL1DataFee is false for Ethereum mainnet, Sepolia and unknown chains',
  !chainHasL1DataFee(1n) && !chainHasL1DataFee(11155111n) && !chainHasL1DataFee(8453n) && !chainHasL1DataFee(10n),
);
check('mainnet and Sepolia profiles have no L1 data fee', !EVM_MAINNET.l1DataFee && !EVM_SEPOLIA.l1DataFee);
check(
  'oracle address is the OP-stack GasPriceOracle predeploy',
  OP_STACK_GAS_PRICE_ORACLE === '0x420000000000000000000000000000000000000F',
);
check('headroom is 50%', L1_DATA_FEE_HEADROOM_PERCENT === 50n);

const SERIAL_CASES = [
  { chainId: 84532n, nonce: 0n, maxPriorityFeePerGas: 1n, maxFeePerGas: 3n, gasLimit: 21000n, to: TO, value: 0n },
  { chainId: 84532n, nonce: 7n, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 3_000_000n, gasLimit: 21000n, to: TO, value: 10n ** 15n },
  {
    chainId: 84532n,
    nonce: 300n,
    maxPriorityFeePerGas: 2n * GWEI,
    maxFeePerGas: 50n * GWEI,
    gasLimit: 250000n,
    to: NFT_CONTRACT,
    value: 0n,
    data: toBytes('0x42842e0e' + '00'.repeat(96)),
  },
  { chainId: 11155111n, nonce: 1n, maxPriorityFeePerGas: GWEI, maxFeePerGas: 3n * GWEI, gasLimit: 21000n, to: TO, value: 123456789012345678901234567890n },
];
for (const [i, tx] of SERIAL_CASES.entries()) {
  const ours = toHex(serializeUnsignedEip1559(tx));
  const theirs = ethers.Transaction.from({
    type: 2,
    chainId: tx.chainId,
    nonce: Number(tx.nonce),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    maxFeePerGas: tx.maxFeePerGas,
    gasLimit: tx.gasLimit,
    to: tx.to,
    value: tx.value,
    data: tx.data ? toHex(tx.data) : '0x',
    accessList: [],
  }).unsignedSerialized;
  check(`unsigned serialization ${i + 1} equals ethers unsignedSerialized`, ours === theirs, `${ours} vs ${theirs}`);
}

// quoteOpStackFees over a plain transport: call shapes and the reserve.
{
  const seen = [];
  const transport = async (method, params) => {
    seen.push({ method, params });
    const data = params[0].data;
    if (data.startsWith(GET_L1_FEE)) return uintWord(1000n);
    if (data.startsWith(GET_OPERATOR_FEE)) return uintWord(7n);
    throw new Error('unexpected');
  };
  const tx = SERIAL_CASES[1];
  const fees = await quoteOpStackFees(transport, tx);
  check('quoteOpStackFees: estimate as returned by getL1Fee', fees.l1DataFeeEstimate === 1000n);
  check('quoteOpStackFees: reserve = estimate + 50% = 1500', fees.l1DataFee === 1500n);
  check('quoteOpStackFees: operator fee as returned', fees.operatorFee === 7n);
  check('opStackFeeTotal = reserve + operator fee', opStackFeeTotal(fees) === 1507n && opStackFeeTotal(undefined) === 0n);
  check(
    'quoteOpStackFees: unsignedTxBytes is the serialized length',
    fees.unsignedTxBytes === serializeUnsignedEip1559(tx).length,
  );
  check(
    'both calls are eth_call to the oracle at "latest"',
    seen.length === 2 && seen.every((r) => r.method === 'eth_call' && r.params[0].to === OP_STACK_GAS_PRICE_ORACLE && r.params[1] === 'latest'),
  );
  const l1Call = seen.find((r) => r.params[0].data.startsWith(GET_L1_FEE));
  check(
    'getL1Fee calldata = engine ABI encoding of the unsigned bytes (ethers agrees)',
    l1Call.params[0].data ===
      new ethers.Interface(['function getL1Fee(bytes)']).encodeFunctionData('getL1Fee', [serializeUnsignedEip1559(tx)]),
  );
  const opCall = seen.find((r) => r.params[0].data.startsWith(GET_OPERATOR_FEE));
  check(
    'getOperatorFee is asked for the transaction gas limit',
    opCall.params[0].data === toHex(encodeFunctionCall('getOperatorFee(uint256)', [{ kind: 'uint256', value: 21000n }])),
  );
  const odd = await quoteOpStackFees(async (_m, p) => (p[0].data.startsWith(GET_L1_FEE) ? uintWord(3n) : uintWord(0n)), tx);
  check('reserve rounds up (3 → 3 + ceil(1.5) = 5)', odd.l1DataFee === 5n);
}

// ---------------------------------------------------------------------------
// 2. Native send on Base Sepolia (fake OP-stack node)
// ---------------------------------------------------------------------------

console.log('native send on Base Sepolia:');

scenario = defaultScenario('0x14a34');
requests = [];
const AMOUNT = 10n ** 14n; // 0.0001 ETH
const baseQuote = await prepareEvmSend(URL, FROM, TO, AMOUNT, undefined, EVM_BASE_SEPOLIA.caip2);
const l2Fee = 21000n * (2n * 1_000_000n + 1_000_000n);
const reserve = reserveOf(scenario.l1Fee);
check('quote carries opStack fields', baseQuote.opStack !== undefined);
check('L1 estimate is the oracle answer', baseQuote.opStack.l1DataFeeEstimate === scenario.l1Fee);
check(`L1 reserve = estimate + 50% (${reserve})`, baseQuote.opStack.l1DataFee === reserve);
check('operator fee 0 as the oracle says', baseQuote.opStack.operatorFee === 0n);
check(
  'fee = gasLimit × maxFeePerGas + L1 reserve + operator fee',
  baseQuote.fee === l2Fee + reserve,
  `${baseQuote.fee} vs ${l2Fee + reserve}`,
);
check('total = amount + fee', baseQuote.total === AMOUNT + l2Fee + reserve);
const priced = pricedUnsignedTx();
const expectedUnsigned = ethers.Transaction.from({
  type: 2,
  chainId: 84532n,
  nonce: 7,
  maxPriorityFeePerGas: baseQuote.maxPriorityFeePerGas,
  maxFeePerGas: baseQuote.maxFeePerGas,
  gasLimit: baseQuote.gasLimit,
  to: TO,
  value: AMOUNT,
  data: '0x',
  accessList: [],
}).unsignedSerialized;
check('the oracle priced the exact unsigned transaction (ethers)', priced === expectedUnsigned, `${priced}`);

// The transaction sendEvm signs is the one that was priced.
await sendEvm(URL, signer(), baseQuote, EVM_BASE_SEPOLIA.explorerTxBase);
const signedTx = ethers.Transaction.from(lastRawTx);
check('sendEvm signs exactly the priced transaction', signedTx.unsignedSerialized === priced);
check('signed transaction recovers to the sender', signedTx.from === FROM);
check('signed transaction is for chain 84532', signedTx.chainId === 84532n);

// Balance that covers amount + L2 fee but not the L1 reserve: refused.
scenario = defaultScenario('0x14a34');
scenario.balance = AMOUNT + l2Fee + reserve - 1n;
await checkRejects(
  'balance short of the L1 reserve by 1 wei → insufficient funds',
  () => prepareEvmSend(URL, FROM, TO, AMOUNT, undefined, EVM_BASE_SEPOLIA.caip2),
  /Insufficient funds/,
);
scenario.balance = AMOUNT + l2Fee + reserve;
check(
  'balance exactly amount + L2 fee + reserve → quote succeeds',
  (await prepareEvmSend(URL, FROM, TO, AMOUNT, undefined, EVM_BASE_SEPOLIA.caip2)).total === scenario.balance,
);

// Operator fee, when the chain sets one, is part of the fee too.
scenario = defaultScenario('0x14a34');
scenario.operatorFee = 12345n;
const withOperator = await prepareEvmSend(URL, FROM, TO, AMOUNT, undefined, EVM_BASE_SEPOLIA.caip2);
check(
  'non-zero operator fee is added to the fee',
  withOperator.opStack.operatorFee === 12345n && withOperator.fee === l2Fee + reserve + 12345n,
);

// Calldata (a WalletConnect contract call) is priced with its data.
scenario = defaultScenario('0x14a34');
requests = [];
const callData = toBytes('0xa9059cbb' + '00'.repeat(64));
scenario.estimateGas = 52000n;
await prepareEvmSend(URL, FROM, TO, 0n, callData, EVM_BASE_SEPOLIA.caip2);
check(
  'calldata is part of the priced unsigned transaction',
  ethers.Transaction.from(pricedUnsignedTx()).data === toHex(callData),
);

// Oracle failures refuse the quote.
scenario = defaultScenario('0x14a34');
scenario.oracleError = 'execution reverted';
await checkRejects(
  'oracle error → quote refused with a plain sentence',
  () => prepareEvmSend(URL, FROM, TO, AMOUNT, undefined, EVM_BASE_SEPOLIA.caip2),
  /Could not read the layer 1 data fee from the network's GasPriceOracle.*Nothing was signed/,
);
scenario = defaultScenario('0x14a34');
scenario.oracleResult = '0x';
await checkRejects(
  'oracle empty answer (no contract) → quote refused',
  () => prepareEvmSend(URL, FROM, TO, AMOUNT, undefined, EVM_BASE_SEPOLIA.caip2),
  /32-byte uint256 word/,
);

// ---------------------------------------------------------------------------
// 3. Max on Base Sepolia
// ---------------------------------------------------------------------------

console.log('Max on Base Sepolia:');

scenario = defaultScenario('0x14a34');
requests = [];
const max = await maxEvmSend(URL, FROM, TO);
check(
  'Max = balance − gasLimit × maxFeePerGas − L1 reserve − operator fee',
  max === scenario.balance - l2Fee - reserve,
  `${max}`,
);
const maxPriced = ethers.Transaction.from(pricedUnsignedTx());
check('Max priced a transfer valued at the full balance (never undersized)', maxPriced.value === scenario.balance);
check('Max priced with the account nonce and chain', maxPriced.nonce === 7 && maxPriced.chainId === 84532n);
scenario.balance = 1000n; // smaller than the fees
check('Max is 0 when the fees exceed the balance', (await maxEvmSend(URL, FROM, TO)) === 0n);
// The Max amount then quotes cleanly (the reserve is the same figure).
scenario = defaultScenario('0x14a34');
const maxAmount = await maxEvmSend(URL, FROM, TO);
const maxQuote = await prepareEvmSend(URL, FROM, TO, maxAmount, undefined, EVM_BASE_SEPOLIA.caip2);
check(
  'quoting the Max amount passes the balance check (total ≤ balance)',
  maxQuote.total <= scenario.balance,
  `${maxQuote.total} vs ${scenario.balance}`,
);

// ---------------------------------------------------------------------------
// 4. Ethereum mainnet and Sepolia: unchanged, no oracle call
// ---------------------------------------------------------------------------

console.log('Ethereum mainnet and Sepolia unchanged:');

for (const [profile, hex] of [
  [EVM_MAINNET, '0x1'],
  [EVM_SEPOLIA, '0xaa36a7'],
]) {
  scenario = defaultScenario(hex);
  requests = [];
  const q = await prepareEvmSend(URL, FROM, TO, AMOUNT, undefined, profile.caip2);
  check(`${profile.label}: no oracle call`, oracleCalls().length === 0);
  check(`${profile.label}: no opStack field`, !('opStack' in q));
  check(`${profile.label}: fee = gasLimit × maxFeePerGas exactly`, q.fee === l2Fee && q.total === AMOUNT + l2Fee);
  check(
    `${profile.label}: quote keys unchanged`,
    JSON.stringify(Object.keys(q)) ===
      JSON.stringify(['kind', 'to', 'amount', 'balance', 'nonce', 'chainId', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'fee', 'total', 'simulation']),
    JSON.stringify(Object.keys(q)),
  );
  requests = [];
  const m = await maxEvmSend(URL, FROM, TO);
  check(`${profile.label}: Max = balance − gasLimit × maxFeePerGas`, m === scenario.balance - l2Fee);
  check(`${profile.label}: Max makes no oracle call and reads no nonce`, oracleCalls().length === 0 && !requests.some((r) => r.method === 'eth_getTransactionCount'));
}

// ---------------------------------------------------------------------------
// 5. NFT send on Base Sepolia; ERC-20 stays mainnet-only
// ---------------------------------------------------------------------------

console.log('NFT and ERC-20 sends:');

scenario = defaultScenario('0x14a34');
scenario.estimateGas = 90000n;
requests = [];
const nftQuote = await prepareNftSend({
  url: URL,
  from: FROM,
  to: TO,
  contract: NFT_CONTRACT,
  tokenId: 42n,
  standard: 'erc721',
  amount: 1n,
  expectedCaip2: EVM_BASE_SEPOLIA.caip2,
  nftCaip2: EVM_BASE_SEPOLIA.caip2,
});
const nftL2 = 90000n * 3_000_000n;
check('NFT quote carries opStack fields', nftQuote.opStack?.l1DataFee === reserve);
check('NFT fee = L2 fee + L1 reserve', nftQuote.fee === nftL2 + reserve, `${nftQuote.fee}`);
const nftPriced = ethers.Transaction.from(pricedUnsignedTx());
check(
  'NFT: the priced transaction targets the contract with the safeTransferFrom calldata, value 0',
  nftPriced.to === ethers.getAddress(NFT_CONTRACT) && nftPriced.data === toHex(nftQuote.data) && nftPriced.value === 0n,
);
await sendNft(URL, signer(), nftQuote, EVM_BASE_SEPOLIA.explorerTxBase);
check(
  'NFT: sendNft signs exactly the priced transaction',
  ethers.Transaction.from(lastRawTx).unsignedSerialized === pricedUnsignedTx(),
);
scenario = defaultScenario('0x14a34');
scenario.estimateGas = 90000n;
scenario.balance = nftL2 + reserve - 1n;
await checkRejects(
  'NFT: ETH short of the L1 reserve → "Not enough ETH to pay the network fee"',
  () =>
    prepareNftSend({
      url: URL, from: FROM, to: TO, contract: NFT_CONTRACT, tokenId: 42n, standard: 'erc721', amount: 1n,
      expectedCaip2: EVM_BASE_SEPOLIA.caip2, nftCaip2: EVM_BASE_SEPOLIA.caip2,
    }),
  /Not enough ETH to pay the network fee/,
);
scenario = defaultScenario('0xaa36a7');
scenario.estimateGas = 90000n;
requests = [];
const sepNft = await prepareNftSend({
  url: URL, from: FROM, to: TO, contract: NFT_CONTRACT, tokenId: 42n, standard: 'erc721', amount: 1n,
  expectedCaip2: EVM_SEPOLIA.caip2, nftCaip2: EVM_SEPOLIA.caip2,
});
check('NFT on Sepolia: no oracle call, no opStack, fee = L2 fee', oracleCalls().length === 0 && !('opStack' in sepNft) && sepNft.fee === nftL2);
await checkRejects(
  'NFT from the other network: the message names the Developer choice, not "Sepolia test mode"',
  () =>
    prepareNftSend({
      url: URL, from: FROM, to: TO, contract: NFT_CONTRACT, tokenId: 42n, standard: 'erc721', amount: 1n,
      expectedCaip2: EVM_BASE_SEPOLIA.caip2, nftCaip2: EVM_SEPOLIA.caip2,
    }),
  /Choose the matching test network \(or Off for mainnet\) in Settings → Developer/,
);

scenario = defaultScenario('0x14a34');
requests = [];
await checkRejects(
  'ERC-20 quotes stay pinned to mainnet (a Base endpoint is refused before any oracle call)',
  () => prepareErc20Send({ url: URL, from: FROM, to: TO, contract: NFT_CONTRACT, amount: 1n, symbol: 'T', decimals: 6 }),
  /expected 1 \(Ethereum mainnet\)/,
);
check('ERC-20 refusal made no oracle call', oracleCalls().length === 0);

scenario = defaultScenario('0x14a34');
await checkRejects(
  'wrong-chain endpoint message names Base Sepolia and the Developer choice',
  () => prepareEvmSend(URL, FROM, TO, AMOUNT, undefined, EVM_SEPOLIA.caip2),
  /expected 11155111 \(Sepolia\)\. Check the RPC endpoint \(and the test network choice under Settings → Developer\)/,
);
scenario = defaultScenario('0xaa36a7');
await checkRejects(
  'a Sepolia endpoint in Base Sepolia mode is refused, naming Base Sepolia',
  () => prepareEvmSend(URL, FROM, TO, AMOUNT, undefined, EVM_BASE_SEPOLIA.caip2),
  /expected 84532 \(Base Sepolia\)/,
);

// ---------------------------------------------------------------------------
// 6. Base Sepolia names elsewhere
// ---------------------------------------------------------------------------

console.log('Base Sepolia names:');
{
  const meta = rebuildRecoveryRecord({ chainId: 84532n, account: KERNEL_ACCOUNT_0, originalOwner: OWNER_0, index: 0, recordedAt: 1 });
  const name = recordExportFileName(meta, new Date(Date.UTC(2026, 9, 3)));
  check(
    'recovery record file name on Base Sepolia says "base-sepolia"',
    name === 'shiba-recovery-record_base-sepolia_0xB67b-9a42_2026-10-03.json' && RECORD_FILE_NAME_PATTERN.test(name),
    name,
  );
}

// ---------------------------------------------------------------------------
// 7. Optional live probe (read-only) on Base Sepolia
// ---------------------------------------------------------------------------

if (process.argv.includes('--live')) {
  console.log('\nlive Base Sepolia probe (read-only; nothing signed or sent):');
  // Restore the real fetch for the live pass.
  globalThis.fetch = realFetch;
  const url = EVM_BASE_SEPOLIA.defaultRpcUrls[0];
  // A sender that holds ETH on Base Sepolia, so the quote's balance check
  // passes: the L2ToL1MessagePasser predeploy (it holds withdrawn ETH).
  // eth_estimateGas and eth_call need no signature; nothing is sent.
  const sender = '0x4200000000000000000000000000000000000016';
  try {
    const q = await prepareEvmSend(url, sender, TO, 10n ** 12n, undefined, EVM_BASE_SEPOLIA.caip2);
    const l2 = q.gasLimit * q.maxFeePerGas;
    console.log(`  endpoint ${new globalThis.URL(url).host}`);
    console.log(`  gasLimit ${q.gasLimit}, maxFeePerGas ${q.maxFeePerGas} wei, maxPriorityFeePerGas ${q.maxPriorityFeePerGas} wei`);
    console.log(`  L2 execution worst case ${l2} wei`);
    console.log(`  unsigned tx ${q.opStack.unsignedTxBytes} bytes; getL1Fee estimate ${q.opStack.l1DataFeeEstimate} wei`);
    console.log(`  reserved L1 data fee (estimate + 50%) ${q.opStack.l1DataFee} wei; operator fee ${q.opStack.operatorFee} wei`);
    console.log(`  total fee ${q.fee} wei; L1 share of the estimate ${(Number(q.opStack.l1DataFeeEstimate) / Number(l2 + q.opStack.l1DataFeeEstimate) * 100).toFixed(1)}%`);
    const upper = BigInt(
      await (await realFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: OP_STACK_GAS_PRICE_ORACLE, data: toHex(encodeFunctionCall('getL1FeeUpperBound(uint256)', [{ kind: 'uint256', value: BigInt(q.opStack.unsignedTxBytes) }])) }, 'latest'],
        }),
      })).json().then((b) => b.result),
    );
    console.log(`  for comparison, getL1FeeUpperBound(${q.opStack.unsignedTxBytes}) = ${upper} wei`);
    check('live: getL1Fee estimate is positive', q.opStack.l1DataFeeEstimate > 0n);
    check('live: the upper bound is at least the estimate', upper >= q.opStack.l1DataFeeEstimate);
    check('live: fee includes the reserve', q.fee === l2 + q.opStack.l1DataFee + q.opStack.operatorFee);
    const m = await maxEvmSend(url, sender, TO);
    console.log(`  Max for the probe sender: ${m} wei of a ${q.balance} wei balance`);
    check('live: Max leaves at least the L2 worst case + reserve', q.balance - m >= l2);
  } catch (e) {
    check('live probe ran', false, e instanceof Error ? e.message : String(e));
  }
  try {
    const sepUrl = EVM_SEPOLIA.defaultRpcUrls[0];
    requests = [];
    const q = await prepareEvmSend(sepUrl, sender, TO, 0n, undefined, EVM_SEPOLIA.caip2).catch((e) => e);
    check('live Sepolia: a quote has no opStack part', q instanceof Error ? /Insufficient funds/.test(q.message) : !('opStack' in q), q instanceof Error ? q.message : '');
  } catch (e) {
    check('live Sepolia probe ran', false, e instanceof Error ? e.message : String(e));
  }
}

console.log(`\ncheck-base: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

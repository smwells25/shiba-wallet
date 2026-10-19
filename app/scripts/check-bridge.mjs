// Exercises the Bridge screen's glue (src/wallet/bridge.ts, phase 21 item 1,
// feature 35; docs/BRIDGE_PROVIDERS.md) entirely OFFLINE: fake nodes for
// Ethereum Sepolia, Arbitrum Sepolia, OP Sepolia and Base Sepolia that answer
// the Stargate pools' quoteOFT / quoteSend, the receipts and logs tracking
// reads, and LayerZero Scan's keyless API, plus the fake Kernel node and
// bundler of fakes-kernel.mjs and the REAL send paths (prepareEvmSend /
// sendEvm and prepareAaCalls / sendAa). Covered: the readiness gate (mainnet
// and a custom main network refused before any request), what is offered
// on which network, the provider list (every provider, CCTP listed but not
// offered), a quote equal to the engine's own figures, the wallet's own
// quote checks (exact approvals only, value = amount + messaging fee, the
// pinned words), the confirm strings, the prompt title, the smart-account
// recipient handling (the regular account receives; the EIP-7702 variant),
// tracking states and their sentences (incl. the retry call when Stargate
// cached the transfer), the endpoint failover for other networks, the
// in-memory records, source pins on the screen and the route gates, and
// mutation checks (an unlimited approval, a value other than amount + fee,
// the gate removed, the provider choice hidden, the recipient pin removed,
// CCTP offered).
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-bridge.mjs
//
// The signing keys derive from the standard BIP-39 test mnemonic
// ("abandon … about"), which is public knowledge.

import { ethers } from 'ethers';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  CCTP_V2_PROVIDER_ID,
  CCTP_V2_TRUST,
  KERNEL_V3_3,
  LAYERZERO_OFT_PROVIDER_ID,
  LAYERZERO_OFT_TRUST,
  LAYERZERO_V2_TESTNET,
  MAX_EXACT_APPROVAL,
  OFT_QUOTE_OFT_SELECTOR,
  OFT_QUOTE_SEND_SELECTOR,
  OFT_SEND_LAYOUT,
  OFT_SEND_SELECTOR,
  STARGATE_RETRY_RECEIVE_TOKEN_SELECTOR,
  STARGATE_V2_TESTNET_NATIVE_POOLS,
  createLayerZeroOftProvider,
  httpTransport,
  oftTimeEstimate,
  toHex,
} from '@shiba-wallet/chains-evm';
import {
  BRIDGE_AMOUNT_PLACEHOLDER,
  BRIDGE_CHOICE_NOTE,
  BRIDGE_FEATURE,
  BRIDGE_SINGLE_PROVIDER_NOTE,
  broadcastStamped,
  bridgeChoiceNote,
  bridgeFormInputsShown,
  bridgeProviderChoiceHint,
  chosenBridgeProvider,
  providerRowSpokenLabel,
  BRIDGE_INTRO,
  BRIDGE_LOG_TOO_OLD,
  BRIDGE_PROVIDER_STATUS,
  BRIDGE_RECORDS_NOTE,
  BRIDGE_RECORDS_READ_ONLY_MESSAGE,
  BRIDGE_TRANSFERS_KEY,
  MAX_BRIDGE_TRANSFERS,
  bridgeRecordFromStored,
  bridgeRecordToStored,
  bridgeTransfersReadOnly,
  bridgeTransfersWritten,
  loadBridgeTransfers,
  parseBridgeTransfers,
  BRIDGE_TIME_NOT_PROMISE,
  BRIDGE_TRACK_INTERVAL_MS,
  BRIDGE_TRUST,
  BRIDGE_USEROP_NOT_INCLUDED,
  BRIDGE_USEROP_RECEIPT_MALFORMED,
  BRIDGE_USEROP_REVERTED,
  BRIDGE_USEROP_WAITING,
  bridgeUserOpRevertedDetail,
  readBridgeUserOpReceipt,
  BridgeRefusal,
  CCTP_COMING_NOTE,
  LAYERZERO_APP_LABEL,
  LAYERZERO_SCAN_TESTNET_API,
  bridgeConfirmModel,
  bridgeOfferFor,
  bridgePromptTitle,
  bridgeProviderRows,
  bridgeRecipientNote,
  bridgeRetryBlocker,
  bridgeRetryCall,
  bridgeRetryPromptTitle,
  bridgeSourceFeeLines,
  bridgeStatusHeading,
  bridgeStatusSentence,
  bridgeTransferFinal,
  checkBridgeQuote,
  createAppBridgeRegistry,
  defaultChainTransport,
  destinationLogReader,
  layerZeroScanReader,
  listBridgeTransfers,
  measuredTimeLine,
  noRouteNote,
  noSourceRouteNote,
  prepareBridgeAa,
  prepareBridgeRetry,
  prepareBridgeSend,
  quoteBridge,
  recordBridgeTransfer,
  regularRecipientNote,
  resetBridgeTransfers,
  smartAccountRecipientNote,
  subscribeBridgeTransfers,
  trackBridgeTransfer,
  updateBridgeTransfer,
  upgradedAccountRecipientNote,
} from '../src/wallet/bridge.ts';
import { prepareEvmSend, sendEvm } from '../src/wallet/send.ts';
import { createAaClientFromConfig, sendAa } from '../src/wallet/aa.ts';
import { featureReadiness, isFeatureAllowed } from '../src/config/readiness.ts';
import { EVM_SEPOLIA, evmProfileByCaip2, setCustomEvmProfiles } from '../src/config/evm-chain.ts';
import { MULTISIG_ALLOWED_ROUTES, WATCH_ONLY_ALLOWED_ROUTES, multisigRouteRefusal, watchOnlyRouteRefusal } from '../src/wallet/watch-only.ts';
import { KERNEL_ACCOUNT_0, OWNER_0, TEST_MNEMONIC, decodeKernelExecute, fakeBundler, fakeKernelNode } from './fakes-kernel.mjs';

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
async function rejection(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const source = (rel) => readFileSync(join(APP_ROOT, rel), 'utf8');

// Mutation checks load a deliberately broken copy of src/wallet/bridge.ts
// from a scratch directory (relative imports rewritten to the real files,
// so the copy shares every other module with this script), the
// check-staking.mjs pattern. The directory is removed on exit.
const MUTANT_DIR = join(HERE, `.mutants-bridge-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
const BRIDGE_SOURCE = source('src/wallet/bridge.ts');
async function bridgeMutant(from, to, ...more) {
  let mutated = BRIDGE_SOURCE;
  const pairs = [[from, to]];
  for (let i = 0; i < more.length; i += 2) pairs.push([more[i], more[i + 1]]);
  for (const [a, b] of pairs) {
    if (!mutated.includes(a)) throw new Error(`mutation anchor not found: ${a}`);
    mutated = mutated.replace(a, b);
  }
  const originalDir = join(APP_ROOT, 'src/wallet');
  const rewritten = mutated.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolve(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-bridge.ts`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// Fake chains
// ---------------------------------------------------------------------------

const SEPOLIA = 11155111;
const ARB = 421614;
const OP = 11155420;
const BASE = 84532;
const HOODI = 560048;
const caip = (id) => `eip155:${id}`;
const pool = (chainId) => STARGATE_V2_TESTNET_NATIVE_POOLS.find((d) => d.chainId === chainId);
const E18 = 10n ** 18n;
const GWEI = 10n ** 9n;
const AMOUNT = 200_000_000_000_000n; // 0.0002, the live leg's amount
const NATIVE_FEE = 102_050_140_082_558n; // leg A's messaging fee (docs/BRIDGING.md 15.16)
const GUID = '0x4da5481014f25b3326f100cb8d0cdb20979a9e1d9d6708b96347ef993580395c';
const SOURCE_TX = '0xfb041691c102214d1da67f60b23b985a2e99a335fccf23423b8c722937986405';
const DELIVERY_TX = '0xf0760a9ec2ba0e8f1b3a53e46e6e118cd749b66fb2040e6d7d7a04da041827f3';
const CACHE_TX = '0x' + '77'.repeat(32);

const SP = 'tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd)';
const oftIface = new ethers.Interface([
  `function send(${SP} p, tuple(uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable`,
  `function quoteSend(${SP} p, bool payInLzToken) view returns (tuple(uint256,uint256))`,
  `function quoteOFT(${SP} p) view returns (tuple(uint256,uint256), tuple(int256,string)[], tuple(uint256,uint256))`,
  'function approve(address spender, uint256 amount)',
]);
const evIface = new ethers.Interface([
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
  'event OFTReceived(bytes32 indexed guid, uint32 srcEid, address indexed toAddress, uint256 amountReceivedLD)',
  'event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)',
  'event UnreceivedTokenCached(bytes32 guid, uint8 index, uint32 srcEid, address receiver, uint256 amountLD, bytes composeMsg)',
  'function retryReceiveToken(bytes32 _guid, uint8 _index, uint32 _srcEid, address _receiver, uint256 _amountLD, bytes _composeMsg)',
]);
const word = (v) => ethers.toBeHex(v, 32);

function chainState(chainId, over = {}) {
  return {
    chainId,
    chainIdHex: ethers.toQuantity(chainId),
    head: 1_000_000n,
    nativeFee: NATIVE_FEE,
    poolFee: 0n, // wei kept by the pool (quoteOFT's amountReceivedLD = sent − poolFee)
    code: new Set(),
    receipts: new Map(),
    logs: [],
    balance: E18,
    raw: [],
    calls: [],
    ...over,
  };
}
const chains = new Map();
function resetChains() {
  chains.clear();
  for (const id of [SEPOLIA, ARB, OP, BASE, HOODI]) chains.set(id, chainState(id));
}
resetChains();

function nodeFor(chainId) {
  return async (method, params) => {
    const s = chains.get(chainId);
    s.calls.push({ method, params });
    switch (method) {
      case 'eth_chainId':
        return s.chainIdHex;
      case 'eth_getBalance':
        return ethers.toQuantity(s.balance);
      case 'eth_getTransactionCount':
        return '0x5';
      case 'eth_getBlockByNumber':
        return { number: ethers.toQuantity(s.head), baseFeePerGas: ethers.toQuantity(GWEI), timestamp: '0x6a000000' };
      case 'eth_maxPriorityFeePerGas':
        return ethers.toQuantity(GWEI);
      case 'eth_estimateGas':
        return ethers.toQuantity(341_035n);
      case 'eth_blockNumber':
        return ethers.toQuantity(s.head);
      case 'eth_getCode':
        return s.code.has(String(params[0]).toLowerCase()) ? '0x6001' : '0x';
      case 'eth_sendRawTransaction':
        s.raw.push(params[0]);
        return ethers.keccak256(params[0]);
      case 'eth_getTransactionReceipt':
        return s.receipts.get(String(params[0]).toLowerCase()) ?? null;
      case 'eth_getLogs': {
        const f = params[0];
        const from = BigInt(f.fromBlock);
        const to = BigInt(f.toBlock);
        return s.logs.filter(
          (l) =>
            same(l.address, f.address) &&
            BigInt(l.blockNumber) >= from &&
            BigInt(l.blockNumber) <= to &&
            (f.topics ?? []).every((t, i) => t === null || same(l.topics[i], t)),
        );
      }
      case 'eth_call': {
        const { to, data = '0x' } = params[0];
        const p = pool(chainId);
        if (p && same(to, p.address) && data.startsWith(OFT_QUOTE_OFT_SELECTOR)) {
          const [sp] = oftIface.decodeFunctionData('quoteOFT', data);
          return oftIface.encodeFunctionResult('quoteOFT', [[1n, 10n ** 21n], [], [sp[2], sp[2] - s.poolFee]]);
        }
        if (p && same(to, p.address) && data.startsWith(OFT_QUOTE_SEND_SELECTOR)) {
          return ethers.AbiCoder.defaultAbiCoder().encode(['tuple(uint256,uint256)'], [[s.nativeFee, 0n]]);
        }
        if (p && same(to, p.address) && (data.startsWith(OFT_SEND_SELECTOR) || data.startsWith(STARGATE_RETRY_RECEIVE_TOKEN_SELECTOR))) return '0x';
        if (same(to, '0x420000000000000000000000000000000000000F')) {
          // GasPriceOracle (OP-stack): getL1Fee(bytes) → 268 wei; getOperatorFee(uint256) → 0.
          return data.startsWith(ethers.id('getL1Fee(bytes)').slice(0, 10)) ? word(268n) : word(0n);
        }
        throw new Error(`fake chain ${chainId}: unexpected eth_call to ${to} ${data.slice(0, 10)}`);
      }
      case 'eth_simulateV1':
        return [{ calls: params[0].blockStateCalls[0].calls.map(() => ({ status: '0x1', returnData: '0x', gasUsed: '0x1', logs: [] })) }];
      default:
        throw new Error(`fake chain ${chainId}: unexpected method ${method}`);
    }
  };
}

// URL routing for every fetch: the active endpoints, the profiles' built-in
// defaults (the other networks), and LayerZero Scan.
const ACTIVE_URL = (id) => `https://bridge-node.example/${id}`;
const urlChain = new Map();
for (const id of [SEPOLIA, ARB, OP, BASE, HOODI]) {
  urlChain.set(ACTIVE_URL(id), id);
  for (const u of evmProfileByCaip2(caip(id)).defaultRpcUrls) urlChain.set(u, id);
}
let fetchLog = [];
let urlOverride = new Map(); // url → 'down' | chain id answered instead
let scanAnswer = { status: 404 };
globalThis.fetch = async (url, init) => {
  fetchLog.push(String(url));
  if (String(url).startsWith(LAYERZERO_SCAN_TESTNET_API)) {
    const a = scanAnswer;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: () => null }, json: async () => a.body };
  }
  const override = urlOverride.get(String(url));
  if (override === 'down') throw new TypeError('fetch failed');
  const chainId = override ?? urlChain.get(String(url));
  if (chainId === undefined) throw new Error(`no fake node at ${url}`);
  const { method, params, id } = JSON.parse(init.body);
  let body;
  try {
    body = { jsonrpc: '2.0', id, result: await nodeFor(chainId)(method, params) };
  } catch (e) {
    body = { jsonrpc: '2.0', id, error: { code: 3, message: e.message } };
  }
  return { ok: true, status: 200, json: async () => body };
};

/** The screen's readers: the active endpoint for the active network, the built-in defaults elsewhere. */
function readersFor(activeChainId) {
  return {
    transportFor: (chainId) => (chainId === activeChainId ? httpTransport(ACTIVE_URL(activeChainId)) : defaultChainTransport(chainId)),
  };
}

const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);
const EOA = owner.address;
check('the test owner is the fakes-kernel owner', same(EOA, OWNER_0), EOA);

function quoteRequest(over = {}) {
  return {
    caip2: caip(SEPOLIA),
    destinationChainId: OP,
    providerId: LAYERZERO_OFT_PROVIDER_ID,
    amount: AMOUNT,
    sender: EOA,
    senderKind: 'regular',
    recipient: EOA,
    nativeSymbol: 'test ETH',
    readers: readersFor(SEPOLIA),
    ...over,
  };
}

// ---------------------------------------------------------------------------
console.log('check-bridge: readiness, and what is offered on which network');
// ---------------------------------------------------------------------------
{
  const row = featureReadiness('bridge');
  check('readiness row "bridge": test networks only, enforced', row.status === 'testnet-only' && row.enforced === true);
  check('BRIDGE_FEATURE is the row id', BRIDGE_FEATURE === 'bridge');
  check('bridging is refused on Ethereum mainnet and allowed on the four built-in bridge networks',
    !isFeatureAllowed('bridge', 'eip155:1') && [SEPOLIA, ARB, OP, BASE].every((id) => isFeatureAllowed('bridge', caip(id))));

  fetchLog = [];
  const e = await rejection(() => bridgeOfferFor('eip155:1'));
  check('mainnet: the offer is refused by the readiness gate (FeatureNotAllowedError), with zero requests',
    e?.name === 'FeatureNotAllowedError' && fetchLog.length === 0, `${e?.name}: ${e?.message}`);
  const q = await rejection(() => quoteBridge(quoteRequest({ caip2: 'eip155:1', readers: readersFor(1) })));
  check('mainnet: a quote is refused by the gate before any request', q?.name === 'FeatureNotAllowedError' && fetchLog.length === 0, `${q?.name}: ${q?.message}`);

  // A network the user added as a MAIN network: the gate refuses like on mainnet.
  const lineaMain = {
    ...EVM_SEPOLIA, caip2: 'eip155:59144', chainIdDecimal: '59144', label: 'Linea', testnet: false, kernelV33Verified: false,
    custom: { rpcUrl: 'https://rpc.linea.example', nativeSymbol: 'ETH', explorerBase: null, blockTimeMs: null, testnetRequested: false },
  };
  const lineaTest = {
    ...EVM_SEPOLIA, caip2: 'eip155:59141', chainIdDecimal: '59141', label: 'Linea Sepolia', testnet: true, kernelV33Verified: false,
    custom: { rpcUrl: 'https://rpc.linea-sepolia.example', nativeSymbol: 'ETH', explorerBase: null, blockTimeMs: null, testnetRequested: true },
  };
  setCustomEvmProfiles([lineaMain, lineaTest]);
  const custom = await rejection(() => bridgeOfferFor('eip155:59144'));
  check('a custom MAIN network: refused by the gate (FeatureNotAllowedError), zero requests',
    custom?.name === 'FeatureNotAllowedError' && !isFeatureAllowed('bridge', 'eip155:59144') && fetchLog.length === 0, `${custom?.name}`);
  if (isFeatureAllowed('bridge', 'eip155:59141')) {
    const o = bridgeOfferFor('eip155:59141');
    check('a custom TEST network: allowed by readiness, but nothing is offered (no pinned bridge contracts), in plain words',
      o.destinations.length === 0 &&
        o.unavailable === 'No bridge provider in this wallet serves Linea Sepolia: bridging is offered only between the built-in test networks.',
      o.unavailable);
  } else {
    check('a custom test network is not treated as a test network here (readiness decides)', true);
  }
  setCustomEvmProfiles([]);
}
{
  const dests = (id) => bridgeOfferFor(caip(id)).destinations.map((d) => `${d.chainId}:${d.sendable ? 'send' : 'list'}`).sort().join(',');
  check('Ethereum Sepolia → Arbitrum Sepolia and OP Sepolia sendable; Base Sepolia listed (CCTP only)', dests(SEPOLIA) === `${ARB}:send,${OP}:send,${BASE}:list`.split(',').sort().join(','), dests(SEPOLIA));
  check('Arbitrum Sepolia → Ethereum Sepolia and OP Sepolia sendable; Base Sepolia listed', dests(ARB) === [`${SEPOLIA}:send`, `${OP}:send`, `${BASE}:list`].sort().join(','), dests(ARB));
  check('OP Sepolia → Ethereum Sepolia and Arbitrum Sepolia sendable; Base Sepolia listed', dests(OP) === [`${SEPOLIA}:send`, `${ARB}:send`, `${BASE}:list`].sort().join(','), dests(OP));
  const base = bridgeOfferFor(caip(BASE));
  check('Base Sepolia: three destinations, none sendable (Stargate has no pool there)', base.destinations.length === 3 && base.destinations.every((d) => !d.sendable));
  check('Base Sepolia: the unavailable sentence (exact)',
    base.unavailable === 'No provider in this wallet can bridge test ETH from Base Sepolia: Stargate has no pool there. Circle CCTP is listed below for comparison but is not offered yet.', base.unavailable);
  const hoodi = bridgeOfferFor(caip(HOODI));
  check('Hoodi: no destination, "No bridge provider in this wallet serves Hoodi."', hoodi.destinations.length === 0 && hoodi.unavailable === 'No bridge provider in this wallet serves Hoodi.', hoodi.unavailable);
  const sep = bridgeOfferFor(caip(SEPOLIA));
  check('Sepolia: sendable destinations come first', sep.destinations[0].sendable && sep.destinations[1].sendable && !sep.destinations[2].sendable);
  check('Sepolia: nothing unavailable', sep.unavailable === null);
  check('the providers, in registration order: LayerZero (offered), then Circle CCTP (coming)',
    sep.providers.map((p) => `${p.id}:${p.status}`).join() === `${LAYERZERO_OFT_PROVIDER_ID}:offered,${CCTP_V2_PROVIDER_ID}:coming` &&
      sep.providers[0].label === LAYERZERO_APP_LABEL && LAYERZERO_APP_LABEL === 'LayerZero (Stargate)',
    sep.providers.map((p) => `${p.id}:${p.status}:${p.label}`).join());
  check('the trust statements are the engine’s, verbatim', sep.providers[0].trust === LAYERZERO_OFT_TRUST && sep.providers[1].trust === CCTP_V2_TRUST &&
    BRIDGE_TRUST[LAYERZERO_OFT_PROVIDER_ID] === LAYERZERO_OFT_TRUST && BRIDGE_TRUST[CCTP_V2_PROVIDER_ID] === CCTP_V2_TRUST);
  check('BRIDGE_PROVIDER_STATUS: only LayerZero is offered for sending', Object.entries(BRIDGE_PROVIDER_STATUS).map(([k, v]) => `${k}:${v}`).sort().join() === [`${CCTP_V2_PROVIDER_ID}:coming`, `${LAYERZERO_OFT_PROVIDER_ID}:offered`].sort().join());
  check('the offer makes no request (pure)', true);
}

// ---------------------------------------------------------------------------
console.log('check-bridge: the provider rows (the choice)');
// ---------------------------------------------------------------------------
{
  const offer = bridgeOfferFor(caip(SEPOLIA));
  const toOp = bridgeProviderRows(offer, OP);
  check('every registered provider is a row, LayerZero first', toOp.map((r) => r.id).join() === `${LAYERZERO_OFT_PROVIDER_ID},${CCTP_V2_PROVIDER_ID}`);
  const lz = toOp[0];
  const cctp = toOp[1];
  check('LayerZero row: selectable, moves test ETH, no note', lz.selectable && lz.asset === 'test ETH' && lz.note === null);
  const engineTime = oftTimeEstimate(pool(SEPOLIA), OP, pool(SEPOLIA).pathways[OP].confirmations);
  check('LayerZero row Sepolia → OP Sepolia: the measured line (exact)',
    lz.measured === 'Measured once on 2026-10-15: 90 s on this route, from the sending block to the delivery block.', lz.measured);
  check('…and the engine’s own time sentence, which ends "not a promise"', lz.timeSource === engineTime.source && /Not a promise/.test(lz.timeSource), lz.timeSource);
  check('CCTP row: listed, NOT selectable, moves USDC, with the coming note (exact)',
    !cctp.selectable && cctp.asset === 'USDC' && cctp.note === CCTP_COMING_NOTE &&
      CCTP_COMING_NOTE === 'Coming later, not offered yet. Circle CCTP moves USDC, not test ETH, and this wallet has not yet sent a CCTP transfer on the test networks, so it does not offer one. It is listed so you can compare who you would be trusting.',
    `${cctp.asset} ${cctp.note}`);
  const toArb = bridgeProviderRows(offer, ARB);
  check('Sepolia → Arbitrum Sepolia: never measured — no measured line; the engine says this route was not measured',
    toArb[0].measured === null && /This route was not measured\./.test(toArb[0].timeSource ?? ''), toArb[0].timeSource);
  const toBase = bridgeProviderRows(offer, BASE);
  check('Sepolia → Base Sepolia: LayerZero listed but not selectable, with the no-route sentence (exact)',
    !toBase[0].selectable && toBase[0].note === 'Does not serve Ethereum Sepolia → Base Sepolia in this wallet.' && toBase[0].note === noRouteNote('Ethereum Sepolia', 'Base Sepolia'), toBase[0].note);
  check('…and CCTP still listed with its coming note', !toBase[1].selectable && toBase[1].note === CCTP_COMING_NOTE);
  check('measuredTimeLine is null without a measurement', measuredTimeLine({ minSeconds: null, maxSeconds: null, source: 'x' }) === null);
  check('the screen copy: intro, choice note, records note (exact)',
    BRIDGE_INTRO === 'Bridging moves test ETH from this network to another test network. A bridge provider carries the transfer, and you trust the provider’s contracts and verifiers while it is on its way, so each provider below says who that is. These are test networks: the coins have no value.' &&
      BRIDGE_CHOICE_NOTE === 'You choose the provider. The wallet lists every provider it knows for this pair of networks and never picks one for you.' &&
      BRIDGE_RECORDS_NOTE === 'Transfers sent from this screen are kept on this phone (the newest 64) and followed here whenever this screen is open. The sending transaction also appears in Activity.');
}

// ---------------------------------------------------------------------------
console.log('check-bridge: the quote equals the engine’s own figures, and the wallet checks it');
// ---------------------------------------------------------------------------
let planA;
{
  resetChains();
  chains.get(OP).head = 50_115_500n;
  fetchLog = [];
  planA = await quoteBridge(quoteRequest());
  // The engine's provider over the same fake chain, read directly.
  const engineProvider = createLayerZeroOftProvider({
    deployments: STARGATE_V2_TESTNET_NATIVE_POOLS,
    label: LAYERZERO_APP_LABEL,
    readContract: async ({ chainId, to, data }) => nodeFor(chainId)('eth_call', [{ to, data }, 'latest']),
  });
  const route = engineProvider.supportedRoutes().find((r) => r.sourceChainId === SEPOLIA && r.destinationChainId === OP);
  const engineQuote = await engineProvider.quote({ route, amount: AMOUNT, sender: EOA, recipient: EOA, nativeSymbol: 'test ETH' });
  const bridgeCall = engineQuote.calls[engineQuote.calls.length - 1];
  check('the plan’s call is the engine’s call, byte for byte (to, value, data)',
    same(planA.call.to, bridgeCall.to) && planA.call.value === bridgeCall.value && toHex(planA.call.data) === toHex(bridgeCall.data));
  check('value = amount + messaging fee exactly, and the fee is the pool’s quoteSend answer',
    planA.call.value === AMOUNT + NATIVE_FEE && planA.messagingFee === NATIVE_FEE && engineQuote.fees[0].amount === NATIVE_FEE);
  check('expected / minimum to arrive and the fee lines equal the engine’s',
    planA.quote.expectedAmountOut === engineQuote.expectedAmountOut && planA.quote.minAmountOut === engineQuote.minAmountOut &&
      JSON.stringify(planA.quote.fees, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(engineQuote.fees, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  check('the call goes to the pinned Stargate pool on Ethereum Sepolia with the OFT send selector',
    same(planA.call.to, '0x9Cc7e185162Aa5D1425ee924D97a87A0a34A0706') && toHex(planA.call.data).startsWith(OFT_SEND_SELECTOR));
  const decoded = oftIface.decodeFunctionData('send', toHex(planA.call.data));
  check('decoded with ethers: endpoint id 40232 (OP Sepolia), recipient and refund = the regular account, amount, empty options',
    Number(decoded[0][0]) === 40232 && same(ethers.dataSlice(decoded[0][1], 12), EOA) && decoded[0][2] === AMOUNT &&
      decoded[0][4] === '0x' && decoded[0][5] === '0x' && decoded[1][0] === NATIVE_FEE && decoded[1][1] === 0n && same(decoded[2], EOA));
  check('no approval for a native pool', planA.quote.approvals.length === 0 && planA.quote.calls.length === 1);
  check('the plan records the receiving chain’s head (tracking starts there) and that the recipient has no code there',
    planA.destinationFromBlock === 50_115_500n && planA.recipientCode === 'none');
  check('the source quote reads went to the active endpoint; the receiving network through its built-in defaults',
    fetchLog.some((u) => u === ACTIVE_URL(SEPOLIA)) && fetchLog.some((u) => evmProfileByCaip2(caip(OP)).defaultRpcUrls.includes(u)));
  check('the regular account’s quote carries the engine’s gas estimate', planA.quote.gasEstimate === 341_035n);

  chains.get(OP).code.add(EOA.toLowerCase());
  const coded = await quoteBridge(quoteRequest());
  check('a recipient with code on the receiving network: recipientCode "code" and the warning in the confirm',
    coded.recipientCode === 'code' && bridgeConfirmModel(coded).recipientLines[1] ===
      'Your regular account has contract code on OP Sepolia (an account upgrade, for example). Stargate’s 2,300-gas delivery may not be accepted there; the ETH would then wait in Stargate’s pool, and the tracking below offers the transaction that delivers it.');
  chains.get(OP).code.clear();

  // A pool fee (Sepolia → Arbitrum Sepolia charges one unit at these sizes).
  chains.get(SEPOLIA).poolFee = 10n ** 12n;
  const toArb = await quoteBridge(quoteRequest({ destinationChainId: ARB }));
  check('a pool fee: expected = amount − fee, a second fee line, value still amount + messaging fee',
    toArb.quote.expectedAmountOut === AMOUNT - 10n ** 12n && toArb.quote.fees.length === 2 && toArb.call.value === AMOUNT + NATIVE_FEE);
  chains.get(SEPOLIA).poolFee = 0n;
}
{
  // Refusals, verbatim from the engine or this module, before anything is signed.
  fetchLog = [];
  const cctp = await rejection(() => quoteBridge(quoteRequest({ providerId: CCTP_V2_PROVIDER_ID, destinationChainId: BASE })));
  check('Circle CCTP: refused with the coming note, zero requests', cctp instanceof BridgeRefusal && cctp.message === CCTP_COMING_NOTE && fetchLog.length === 0, cctp?.message);
  const base = await rejection(() => quoteBridge(quoteRequest({ destinationChainId: BASE })));
  check('LayerZero to Base Sepolia: refused with the no-route sentence, zero requests',
    base instanceof BridgeRefusal && base.message === 'Does not serve Ethereum Sepolia → Base Sepolia in this wallet.' && fetchLog.length === 0, base?.message);
  const dust = await rejection(() => quoteBridge(quoteRequest({ amount: AMOUNT + 1n })));
  check('an amount that is not a whole step: the engine’s sentence, verbatim',
    dust instanceof BridgeRefusal && dust.message === 'This token moves in steps of 1000000000000 base units; the amount has a remainder the OFT would not send. Round it first.', dust?.message);
  const hoodiDest = await rejection(() => quoteBridge(quoteRequest({ destinationChainId: HOODI })));
  check('a destination that is not a bridge network (Hoodi): refused', hoodiDest instanceof BridgeRefusal, hoodiDest?.message);
}
{
  // The wallet's own checks on a tampered quote (checkBridgeQuote).
  const expect = { sourceChainId: SEPOLIA, destinationChainId: OP, amount: AMOUNT, recipient: EOA, sender: EOA };
  const clone = (q) => ({ ...q, calls: q.calls.map((c) => ({ ...c, data: new Uint8Array(c.data), pins: c.pins.map((p) => ({ ...p, rule: { ...p.rule, params: [...p.rule.params] } })) })), approvals: [...q.approvals], fees: [...q.fees] });
  const refused = (q) => {
    try {
      checkBridgeQuote(q, expect);
      return null;
    } catch (e) {
      return e;
    }
  };
  check('the untouched quote passes', refused(clone(planA.quote)) === null);
  const why = (e) => (e instanceof BridgeRefusal ? (/\((.*)\)\. Nothing was signed\.$/.exec(e.message)?.[1] ?? e.message) : String(e));

  const unlimited = clone(planA.quote);
  const token = '0x' + '11'.repeat(20);
  unlimited.calls.unshift({ purpose: 'approve', chainId: SEPOLIA, to: token, value: 0n, data: ethers.getBytes(oftIface.encodeFunctionData('approve', [planA.call.to, ethers.MaxUint256])), pins: [], unpinnable: [], valueLimit: 0n });
  unlimited.approvals.push({ chainId: SEPOLIA, token, spender: planA.call.to, amount: ethers.MaxUint256 });
  check('an UNLIMITED approval is refused as not exact', why(refused(unlimited)) === 'an approval that is not exact', why(refused(unlimited)));
  const above = clone(planA.quote);
  above.calls.unshift({ purpose: 'approve', chainId: SEPOLIA, to: token, value: 0n, data: ethers.getBytes(oftIface.encodeFunctionData('approve', [planA.call.to, AMOUNT + 1n])), pins: [], unpinnable: [], valueLimit: 0n });
  above.approvals.push({ chainId: SEPOLIA, token, spender: planA.call.to, amount: AMOUNT });
  check('an approval one wei above the amount is refused as not exact', why(refused(above)) === 'an approval that is not exact', why(refused(above)));
  check('MAX_EXACT_APPROVAL bounds every approval below "unlimited"', MAX_EXACT_APPROVAL < ethers.MaxUint256);
  const exact = clone(planA.quote);
  exact.calls.unshift({ purpose: 'approve', chainId: SEPOLIA, to: token, value: 0n, data: ethers.getBytes(oftIface.encodeFunctionData('approve', [planA.call.to, AMOUNT])), pins: [], unpinnable: [], valueLimit: 0n });
  exact.approvals.push({ chainId: SEPOLIA, token, spender: planA.call.to, amount: AMOUNT });
  check('even an exact approval is refused for a native pool (it takes the coin itself)', why(refused(exact)) === 'an approval for a pool that takes the coin itself', why(refused(exact)));

  const plusOne = clone(planA.quote);
  plusOne.calls[0].value += 1n;
  plusOne.calls[0].valueLimit += 1n;
  check('a value one wei above amount + messaging fee is refused', why(refused(plusOne)) === 'a value that is not the amount plus the messaging fee', why(refused(plusOne)));
  const limit = clone(planA.quote);
  limit.calls[0].valueLimit += 1n;
  check('a value limit that differs from the value is refused', why(refused(limit)) === 'a value limit that differs from the value', why(refused(limit)));
  const otherPool = clone(planA.quote);
  otherPool.calls[0].to = pool(OP).address;
  check('a call to another contract than the pinned pool is refused', why(refused(otherPool)) === 'a contract other than the pinned Stargate pool', why(refused(otherPool)));
  const otherRecipient = clone(planA.quote);
  otherRecipient.calls[0].data.set(ethers.getBytes(ethers.zeroPadValue(KERNEL_ACCOUNT_0, 32)), 4 + OFT_SEND_LAYOUT.to);
  check('another recipient word in the calldata is refused', why(refused(otherRecipient)) === `the word at byte ${OFT_SEND_LAYOUT.to} of the call`, why(refused(otherRecipient)));
  const otherRoute = clone(planA.quote);
  otherRoute.route = { ...otherRoute.route, destinationChainId: ARB };
  check('a quote for another route is refused', why(refused(otherRoute)) === 'another route');
  const twoBridge = clone(planA.quote);
  twoBridge.calls.push({ ...twoBridge.calls[0] });
  check('two bridge calls are refused', why(refused(twoBridge)) === 'not exactly one bridge call, last');
  const tooHighMin = clone(planA.quote);
  tooHighMin.minAmountOut = tooHighMin.expectedAmountOut + 1n;
  check('a minimum above what is expected to arrive is refused', why(refused(tooHighMin)) === 'a minimum above what is expected to arrive');
  const cctpQuote = clone(planA.quote);
  cctpQuote.providerId = CCTP_V2_PROVIDER_ID;
  check('a quote from another provider is refused', why(refused(cctpQuote)) === 'a provider this screen does not send through');
  check('every refusal ends "Nothing was signed."', /Nothing was signed\.$/.test(refused(plusOne).message));
}

// ---------------------------------------------------------------------------
console.log('check-bridge: the confirm, the prompt title, the regular-account send');
// ---------------------------------------------------------------------------
{
  const m = bridgeConfirmModel(planA);
  check('prompt title (exact): "Bridge 0.0002 test ETH to OP Sepolia through LayerZero (Stargate)"',
    bridgePromptTitle(planA) === 'Bridge 0.0002 test ETH to OP Sepolia through LayerZero (Stargate)' && m.title === bridgePromptTitle(planA), bridgePromptTitle(planA));
  check('you send / arrives / minimum (exact)',
    m.youSend === 'You send 0.0002 test ETH from Ethereum Sepolia' &&
      m.arrives === 'Expected to arrive on OP Sepolia: 0.0002 test ETH' &&
      m.minimum === 'Least that may arrive (written into the call): 0.0002 test ETH', `${m.youSend} | ${m.arrives} | ${m.minimum}`);
  check('the fee line in the network’s symbol, exact to the wei',
    m.feeLines.length === 1 && m.feeLines[0].label === 'LayerZero messaging fee (paid in test ETH)' && m.feeLines[0].value === '0.000102050140082558 test ETH' &&
      m.feeLines[0].note === 'LayerZero messaging fee (verifiers, executor and destination gas), paid in test ETH; any excess is refunded to your address.', JSON.stringify(m.feeLines));
  check('the total = amount + fee (exact)',
    m.total === '0.000302050140082558 test ETH (amount 0.0002 + messaging fee 0.000102050140082558), before this network’s own transaction fee', m.total);
  check('time lines: the measured line, then the engine’s sentence (which already says "Not a promise"), no duplicate',
    m.timeLines.length === 2 && m.timeLines[0] === 'Measured once on 2026-10-15: 90 s on this route, from the sending block to the delivery block.' &&
      /Not a promise: the verifiers wait for 2 source-block confirmations, then the executor delivers, and either can take longer\.$/.test(m.timeLines[1]), m.timeLines.join(' | '));
  const unmeasured = bridgeConfirmModel({ ...planA, quote: { ...planA.quote, time: { minSeconds: null, maxSeconds: null, source: 'A figure from somewhere.' } } });
  check('a time sentence without "not a promise" gets the wallet’s sentence (exact)',
    unmeasured.timeLines.join(' | ') === `A figure from somewhere. | ${BRIDGE_TIME_NOT_PROMISE}` &&
      BRIDGE_TIME_NOT_PROMISE === 'A time measured once is not a promise: delivery waits for the verifiers and the executor, and either can take longer.');
  check('the trust statement and the refund rule are the engine’s, verbatim', m.trust === LAYERZERO_OFT_TRUST && m.trust.refundRule === LAYERZERO_OFT_TRUST.refundRule);
  check('no approval line (exact)', m.approvalLine === 'No token approval: the pool takes the test ETH sent with the call itself.', m.approvalLine);
  check('the pinned fields in plain words (exact)',
    m.pinnedSummary.join('\n') === [
      'Receiving network: OP Sepolia (LayerZero endpoint id 40232).',
      `Recipient: ${EOA}.`,
      'Amount: 0.0002 test ETH; at least 0.0002 test ETH must arrive, or the transfer reverts on this network and nothing leaves.',
      `Messaging fee: 0.000102050140082558 test ETH, paid with this transaction; any part not used is refunded to ${EOA}.`,
      'No extra options and no compose message: the transfer cannot run code of its own on the receiving network.',
      'All of these are fixed words of the call (14 of them). Before showing this screen the wallet re-read the receiving network, the recipient, the amount, the fee and the refund address from the call itself, with the value sent; the other words are fixed by how it builds the call.',
    ].join('\n'), m.pinnedSummary.join('\n'));
  check('the pinned-pool line (exact)',
    m.pinnedPool === 'This transaction goes to Stargate’s native ETH pool on Ethereum Sepolia (0x9Cc7e185162Aa5D1425ee924D97a87A0a34A0706), pinned by this wallet from Stargate’s published test-network deployments and checked on-chain on 2026-10-15. The risk card below does not know Stargate’s pools by name.', m.pinnedPool);
  check('the recipient line for the regular account (exact)',
    m.recipientLines.length === 1 && m.recipientLines[0] === `The test ETH arrives at your regular account ${EOA} on OP Sepolia, the same address as on this network.` &&
      m.recipientLines[0] === regularRecipientNote(EOA, 'OP Sepolia'));
  check('the engine’s notes (verifiers, control, live notes, the 2,300-gas note) are carried', m.notes.some((n) => /required verifier/.test(n)) && m.notes.some((n) => /2,300-gas transfer/.test(n)));
  check('the destination step is the engine’s', m.destinationStep === planA.quote.destination.description);

  // The regular account's quote through the REAL prepareEvmSend.
  fetchLog = [];
  const q = await prepareBridgeSend(ACTIVE_URL(SEPOLIA), EOA, planA);
  check('prepareEvmSend: to = the pool, value = amount + messaging fee exactly, data = the plan’s call',
    same(q.to, planA.call.to) && q.amount === AMOUNT + NATIVE_FEE && toHex(q.data) === toHex(planA.call.data), `${q.amount}`);
  check('the pre-flight eth_call passed', q.simulation.ok === true);
  check('the quote total = value + worst-case fee', q.total === q.amount + q.fee);
  const fees = bridgeSourceFeeLines(q, 'test ETH');
  check('Sepolia: the worst-case sentence without a layer 1 line',
    fees.rows.length === 0 && fees.note === null && fees.worstCase === 'Worst case at 3 gwei max fee × 341035 gas; the actual fee is usually lower.', fees.worstCase);
  const wrongFrom = await rejection(() => prepareBridgeSend(ACTIVE_URL(SEPOLIA), KERNEL_ACCOUNT_0, planA));
  check('a quote prepared for another account is refused', wrongFrom instanceof BridgeRefusal && wrongFrom.message === 'This quote was prepared for another account. Nothing was quoted.');
  const aaPlanOnEoa = await rejection(() => prepareBridgeSend(ACTIVE_URL(SEPOLIA), EOA, { ...planA, senderKind: 'smart-account' }));
  check('a smart-account plan cannot go through the regular send path', aaPlanOnEoa instanceof BridgeRefusal);

  const sent = await sendEvm(ACTIVE_URL(SEPOLIA), owner, q, null);
  const raw = ethers.Transaction.from(chains.get(SEPOLIA).raw.at(-1));
  check('the signed transaction: to = the pool, value = amount + fee, data = the engine’s calldata, chain id Sepolia, from the account',
    same(raw.to, planA.call.to) && raw.value === AMOUNT + NATIVE_FEE && raw.data === toHex(planA.call.data) && raw.chainId === BigInt(SEPOLIA) && same(raw.from, EOA));
  check('sendEvm returned the hash the node took', same(sent.txid, ethers.keccak256(chains.get(SEPOLIA).raw.at(-1))));

  // OP Sepolia as the source: the layer 1 data fee lines (OP-stack).
  const planOp = await quoteBridge(quoteRequest({ caip2: caip(OP), destinationChainId: ARB, readers: readersFor(OP) }));
  const qOp = await prepareBridgeSend(ACTIVE_URL(OP), EOA, planOp);
  const opFees = bridgeSourceFeeLines(qOp, 'test ETH');
  check('OP Sepolia: the worst-case sentence names the layer 1 fee, and its row and note follow (reserve = estimate + 50%)',
    qOp.opStack && opFees.worstCase.endsWith('gas, plus the layer 1 data fee below; the actual fee is usually lower.') &&
      opFees.rows.length === 1 && opFees.rows[0].label === 'Layer 1 data fee (estimate)' && opFees.rows[0].value === '0.000000000000000402 test ETH' &&
      opFees.note === 'This is a layer-2 network: every transaction also pays for publishing its data on Ethereum. The network’s fee oracle estimates 0.000000000000000268 test ETH for this transaction; 50% more is reserved because this fee follows Ethereum’s fees and cannot be capped. It is included in the max network fee and the total.',
    `${opFees.worstCase} | ${JSON.stringify(opFees.rows)} | ${opFees.note}`);
  check('OP Sepolia → Arbitrum Sepolia: prompt title (exact)', bridgePromptTitle(planOp) === 'Bridge 0.0002 test ETH to Arbitrum Sepolia through LayerZero (Stargate)');
}

// ---------------------------------------------------------------------------
console.log('check-bridge: the smart account (the regular account receives)');
// ---------------------------------------------------------------------------
{
  const kernelConfig = {
    bundlerUrl: 'https://bundler.example',
    bundlerVerifiedAt: 'x',
    accountType: 'kernel-v3.3',
    factory: KERNEL_V3_3.factory,
    factoryImplementation: KERNEL_V3_3.implementation,
    kernelMetaFactory: KERNEL_V3_3.metaFactory,
    kernelValidator: KERNEL_V3_3.ecdsaValidator,
    kernelAccountId: KERNEL_V3_3.accountId,
    factoryVerifiedAt: 'x',
    paymasterUrl: null,
    paymasterContext: null,
    paymasterVerifiedAt: null,
    chain: caip(SEPOLIA),
    eip7702Owners: [],
    recoveredAccounts: [],
    bundlerUrlIgnoredReason: null,
    paymasterUrlIgnoredReason: null,
  };
  const kernel = fakeKernelNode({ chainIdHex: '0xaa36a7', balance: E18 });
  const sepNode = nodeFor(SEPOLIA);
  const node = async (method, params) =>
    method === 'eth_call' && same(params[0].to, pool(SEPOLIA).address) ? sepNode(method, params) : kernel(method, params);
  const bundler = fakeBundler();
  const bundle = createAaClientFromConfig(kernelConfig, {
    nodeUrl: 'https://node.example',
    chainId: 11155111n,
    accountIndex: 0,
    ownerAddress: OWNER_0,
    transportFor: (url) => (url === 'https://node.example' ? node : bundler),
  });
  const plan = await quoteBridge(quoteRequest({ sender: KERNEL_ACCOUNT_0, senderKind: 'smart-account', recipient: OWNER_0 }));
  const sendArgs = oftIface.decodeFunctionData('send', toHex(plan.call.data));
  check('smart account: the refund word is the smart account, the recipient word the regular account',
    same(sendArgs[2], KERNEL_ACCOUNT_0) && same(ethers.dataSlice(sendArgs[0][1], 12), OWNER_0));
  check('smart account: no gas estimate from the account address (a UserOperation is not a plain call)', plan.quote.gasEstimate === null);
  const q = await prepareBridgeAa(bundle, OWNER_0, plan);
  check('prepareAaCalls: ONE call, to the pool, value = amount + fee, sender = the Kernel account',
    q.calls.length === 1 && same(q.calls[0].to, plan.call.to) && q.calls[0].value === AMOUNT + NATIVE_FEE && same(q.sender, KERNEL_ACCOUNT_0) && q.amount === AMOUNT + NATIVE_FEE);
  await sendAa(bundle, owner, q, { kind: 'bridge' });
  const exec = decodeKernelExecute(bundler.lastOp.callData);
  check('the submitted UserOperation executes exactly the bridge call with its value',
    exec.calls.length === 1 && same(exec.calls[0].to, plan.call.to) && exec.calls[0].value === AMOUNT + NATIVE_FEE && exec.calls[0].data === toHex(plan.call.data));
  const regularOnAa = await rejection(() => prepareBridgeAa(bundle, OWNER_0, planA));
  check('a regular-account plan cannot go through the smart-account path', regularOnAa instanceof BridgeRefusal && regularOnAa.message === 'This quote was prepared for the regular account. Nothing was quoted.');
  const wrongSender = await rejection(() => prepareBridgeAa(bundle, OWNER_0, { ...plan, sender: OWNER_0 }));
  check('a plan read for another address than the smart account is refused', wrongSender instanceof BridgeRefusal && /another address than the smart account/.test(wrongSender.message));

  const m = bridgeConfirmModel(plan);
  check('smart account: prompt title ends "from your smart account"', bridgePromptTitle(plan) === 'Bridge 0.0002 test ETH to OP Sepolia through LayerZero (Stargate) from your smart account');
  check('smart account: the confirm says, before sending, that the REGULAR account receives and why (exact)',
    m.recipientLines[0] === smartAccountRecipientNote(OWNER_0, 'OP Sepolia') &&
      smartAccountRecipientNote(OWNER_0, 'OP Sepolia') ===
        `Sent from your smart account, the test ETH arrives at your regular account ${OWNER_0} on OP Sepolia, not at the smart account. Stargate hands ETH over with a 2,300-gas transfer, which a deployed smart account cannot accept, so the ETH would wait in Stargate’s pool until someone sent a second transaction there. This wallet therefore offers only your regular account as the recipient.`,
    m.recipientLines[0]);
  check('an EIP-7702 account (sender = recipient): the same-address sentence, not "not at the smart account" (exact)',
    bridgeRecipientNote('smart-account', OWNER_0, OWNER_0, 'OP Sepolia') === upgradedAccountRecipientNote(OWNER_0, 'OP Sepolia') &&
      upgradedAccountRecipientNote(OWNER_0, 'OP Sepolia') ===
        `Your smart account is this same address (upgraded with EIP-7702), so the test ETH arrives at ${OWNER_0} on OP Sepolia, the same address as on this network. An upgrade on this network does not carry over: whether the address has code there is read when you review.`);
  check('bridgeRecipientNote: regular → the regular sentence; Kernel → the smart-account sentence',
    bridgeRecipientNote('regular', OWNER_0, OWNER_0, 'OP Sepolia') === regularRecipientNote(OWNER_0, 'OP Sepolia') &&
      bridgeRecipientNote('smart-account', KERNEL_ACCOUNT_0, OWNER_0, 'OP Sepolia') === smartAccountRecipientNote(OWNER_0, 'OP Sepolia'));
}

// ---------------------------------------------------------------------------
console.log('check-bridge: tracking (the chains’ own events) and the retry call');
// ---------------------------------------------------------------------------
function logOf(address, encoded, extra = {}) {
  return { address, data: encoded.data, topics: [...encoded.topics], ...extra };
}
function oftSentLog(src, dst, guid = GUID, amount = AMOUNT, from = EOA) {
  return logOf(pool(src).address, evIface.encodeEventLog('OFTSent', [guid, LAYERZERO_V2_TESTNET[dst].eid, from, amount, amount]));
}
function packetSentLog(src, dst, guid = GUID) {
  const packet = ethers.solidityPacked(
    ['uint8', 'uint64', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes32', 'bytes'],
    [1, 196n, LAYERZERO_V2_TESTNET[src].eid, ethers.zeroPadValue(pool(src).messagingOApp, 32), LAYERZERO_V2_TESTNET[dst].eid, ethers.zeroPadValue(pool(dst).messagingOApp, 32), guid, '0x01'],
  );
  return logOf(LAYERZERO_V2_TESTNET[src].endpoint, evIface.encodeEventLog('PacketSent', [packet, '0x0003010011010000000000000000000000000000000249f0', LAYERZERO_V2_TESTNET[src].sendUln302]));
}
{
  resetChains();
  resetBridgeTransfers();
  chains.get(OP).head = 50_115_500n;
  const plan = await quoteBridge(quoteRequest());
  chains.get(OP).head = 50_115_600n; // the receiving chain moves on after the quote
  let notified = 0;
  const unsubscribe = subscribeBridgeTransfers(() => {
    notified += 1;
  });
  const rec = recordBridgeTransfer(plan, { sourceTxHash: SOURCE_TX, userOpHash: null, sentAt: 1_791_900_000_000 });
  check('a record is kept in memory, listed, and the listeners are told', listBridgeTransfers().length === 1 && listBridgeTransfers()[0].id === rec.id && notified === 1);

  check('the record carries the route, amount, recipient and the receiving head', rec.amountIn === AMOUNT && same(rec.recipient, EOA) && rec.destinationFromBlock === 50_115_500n);
  check('before any check: "Not checked yet" and its sentence (exact)',
    bridgeStatusHeading(null, 'OP Sepolia') === 'Not checked yet' && bridgeStatusSentence(rec) === 'The wallet has not asked where this transfer is yet.');

  const readers = readersFor(SEPOLIA);
  // 1. No receipt yet.
  let st = await trackBridgeTransfer(rec, readers);
  check('no receipt yet → unknown, "The sending transaction has no receipt yet; it may still be pending." + Scan has no record',
    st.state === 'unknown' && st.detail === 'The sending transaction has no receipt yet; it may still be pending. LayerZero Scan has no record of the message yet.', st.detail);
  check('heading for unknown: "Not known yet"', bridgeStatusHeading(st, 'OP Sepolia') === 'Not known yet');
  // 2. Reverted.
  chains.get(SEPOLIA).receipts.set(SOURCE_TX, { status: '0x0', logs: [] });
  st = await trackBridgeTransfer(rec, readers);
  check('a reverted source → failed, heading "Failed", final', st.state === 'failed' && bridgeStatusHeading(st, 'OP Sepolia') === 'Failed' && bridgeTransferFinal({ status: st }) &&
    /^The sending transaction reverted, so no message was sent and nothing was bridged; only its network fee was spent\./.test(st.detail), st.detail);
  // 3. Sent, in flight (Scan INFLIGHT).
  chains.get(SEPOLIA).receipts.set(SOURCE_TX, { status: '0x1', logs: [oftSentLog(SEPOLIA, OP), packetSentLog(SEPOLIA, OP)] });
  scanAnswer = { status: 200, body: { data: [{ status: { name: 'INFLIGHT' } }] } };
  fetchLog = [];
  st = await trackBridgeTransfer(rec, readers);
  check('sent, nothing on the receiving network → in-flight with the GUID; Scan agrees',
    st.state === 'in-flight' && st.onChain?.guid === GUID && st.detail === `The message was sent (GUID ${GUID}); the receiving network shows no delivery for it yet. LayerZero Scan agrees (INFLIGHT).`, st.detail);
  check('heading for in-flight: "On its way"; not final', bridgeStatusHeading(st, 'OP Sepolia') === 'On its way' && !bridgeTransferFinal({ status: st }));
  check('Scan was asked at the keyless testnet API by source hash', fetchLog.includes(`${LAYERZERO_SCAN_TESTNET_API}/messages/tx/${SOURCE_TX}`));
  const opGetLogs = chains.get(OP).calls.filter((c) => c.method === 'eth_getLogs');
  check('the receiving network was searched from the head recorded at quote time', opGetLogs.length >= 1 && BigInt(opGetLogs[0].params[0].fromBlock) === 50_115_500n);
  // 4. Delivered (OFTReceived for the GUID, to this recipient, for the amount).
  chains.get(OP).logs.push(logOf(pool(OP).address, evIface.encodeEventLog('OFTReceived', [GUID, LAYERZERO_V2_TESTNET[SEPOLIA].eid, EOA, AMOUNT]), { transactionHash: DELIVERY_TX, blockNumber: ethers.toQuantity(50_115_531n) }));
  scanAnswer = { status: 200, body: { data: [{ status: { name: 'DELIVERED' }, destination: { tx: { txHash: DELIVERY_TX } } }] } };
  st = await trackBridgeTransfer(rec, readers);
  check('delivered: state, destination hash, heading "Delivered on OP Sepolia", final',
    st.state === 'delivered' && st.destinationTxHash === DELIVERY_TX && bridgeStatusHeading(st, 'OP Sepolia') === 'Delivered on OP Sepolia' && bridgeTransferFinal({ status: st }));
  check('…the sentence names the GUID, the amount, the recipient and the transaction, and Scan agrees (exact)',
    st.detail === `Delivered: the receiving network shows OFTReceived for this transfer's message (GUID ${GUID}), ${AMOUNT} base units to ${EOA} in transaction ${DELIVERY_TX}. LayerZero Scan agrees (DELIVERED).`, st.detail);
  updateBridgeTransfer(rec.id, { status: st, checkedAt: 1 });
  check('updateBridgeTransfer stores the status; bridgeStatusSentence shows the adapter’s detail verbatim', bridgeStatusSentence(listBridgeTransfers()[0]) === st.detail);
  check('bridgeRetryCall: none for a delivered transfer', bridgeRetryCall({ status: st, route: rec.route }) === null);
  // 5. Cached (UnreceivedTokenCached): the retry call.
  chains.get(OP).logs = [];
  chains.get(OP).logs.push(logOf(pool(OP).address, evIface.encodeEventLog('UnreceivedTokenCached', [GUID, 0, LAYERZERO_V2_TESTNET[SEPOLIA].eid, EOA, AMOUNT, '0x']), { transactionHash: CACHE_TX, blockNumber: ethers.toQuantity(50_115_531n) }));
  scanAnswer = { status: 404 };
  st = await trackBridgeTransfer(rec, readers);
  check('cached by Stargate → awaiting-destination-action, heading "Waiting for a transaction on OP Sepolia"',
    st.state === 'awaiting-destination-action' && st.onChain?.status === 'cached-needs-retry' && bridgeStatusHeading(st, 'OP Sepolia') === 'Waiting for a transaction on OP Sepolia' && !bridgeTransferFinal({ status: st }));
  check('…the sentence says anyone can deliver with retryReceiveToken', /Anyone can deliver them by calling retryReceiveToken there, paying the gas on that network; the call below does that\. It fails while the pool is paused\./.test(st.detail), st.detail);
  const cachedRec = updateBridgeTransfer(rec.id, { status: st });
  const retry = bridgeRetryCall(cachedRec);
  const retryDecoded = retry ? evIface.decodeFunctionData('retryReceiveToken', toHex(retry.data)) : null;
  check('the retry call: to the RECEIVING network’s pinned pool, value 0, retryReceiveToken with the cached fields',
    retry && same(retry.to, pool(OP).address) && retry.value === 0n && toHex(retry.data).startsWith(STARGATE_RETRY_RECEIVE_TOKEN_SELECTOR) &&
      retryDecoded[0] === GUID && Number(retryDecoded[2]) === LAYERZERO_V2_TESTNET[SEPOLIA].eid && same(retryDecoded[3], EOA) && retryDecoded[4] === AMOUNT && retryDecoded[5] === '0x');
  const forged = { ...cachedRec, status: { ...st, destinationCalls: [{ ...st.destinationCalls[0], to: pool(SEPOLIA).address }] } };
  check('a retry call to any other contract is not offered', bridgeRetryCall(forged) === null);
  const valued = { ...cachedRec, status: { ...st, destinationCalls: [{ ...st.destinationCalls[0], value: 1n }] } };
  check('a retry call with a value is not offered', bridgeRetryCall(valued) === null);
  check('retry from another active network: the switch sentence (exact)',
    bridgeRetryBlocker(caip(SEPOLIA), cachedRec) === 'Anyone can send this delivery transaction on OP Sepolia, paying the gas there. To send it from this wallet, switch to OP Sepolia (Settings → Developer) and come back to this screen; this transfer stays listed here.' &&
      bridgeRetryBlocker(caip(OP), cachedRec) === null);
  check('the retry prompt title (exact)', bridgeRetryPromptTitle(cachedRec) === 'Deliver bridged test ETH waiting in Stargate’s pool on OP Sepolia');
  const rq = await prepareBridgeRetry(ACTIVE_URL(OP), EOA, cachedRec);
  check('the retry quote through prepareEvmSend on the receiving network: to the pool, value 0, the retry calldata',
    same(rq.to, pool(OP).address) && rq.amount === 0n && toHex(rq.data) === toHex(retry.data) && rq.simulation.ok);
  const noRetry = await rejection(() => prepareBridgeRetry(ACTIVE_URL(OP), EOA, { ...cachedRec, status: null }));
  check('no retry call → refused in plain words', noRetry instanceof BridgeRefusal && noRetry.message === 'There is no delivery transaction to send for this transfer.');

  // A smart-account transfer whose bundle transaction is not known yet: no request.
  const aaRec = recordBridgeTransfer(plan, { sourceTxHash: null, userOpHash: '0x' + 'ab'.repeat(32), sentAt: 1_791_900_100_000 });
  fetchLog = [];
  const aaSt = await trackBridgeTransfer(aaRec, readers);
  check('a smart-account transfer before its bundle transaction is known: the waiting sentence, zero requests',
    aaSt.state === 'unknown' && aaSt.detail === 'Waiting for the bundle transaction that carries the smart-account operation; tracking starts once it is known.' && fetchLog.length === 0);
  check('records are listed newest first', listBridgeTransfers()[0].id === aaRec.id);
  check('a check error without a status (exact)', bridgeStatusSentence({ status: null, checkError: 'boom', destinationLabel: 'OP Sepolia' }) === 'The transfer could not be checked just now: boom');
  check('the tracking interval is 15 seconds', BRIDGE_TRACK_INTERVAL_MS === 15_000);
  const mainnetTrack = await rejection(() => trackBridgeTransfer({ ...rec, sourceCaip2: 'eip155:1' }, readers));
  check('tracking is refused by the gate for a record whose source is not a test network', mainnetTrack?.name === 'FeatureNotAllowedError');
  unsubscribe();
  resetBridgeTransfers();
  check('resetBridgeTransfers empties the list', listBridgeTransfers().length === 0);
  const before = Date.now();
  const stamped = recordBridgeTransfer(plan, { sourceTxHash: null, userOpHash: null });
  check('sentAt defaults to the time of recording', stamped.sentAt >= before && stamped.sentAt <= Date.now());
  resetBridgeTransfers();
}
// ---------------------------------------------------------------------------
console.log('check-bridge: transfer records stored per wallet (phase 21)');
// ---------------------------------------------------------------------------
{
  const { PRIMARY_STORE_PROFILE, profileBoundStore, STORE_KEYS, storeKeyScope } = await import('../src/wallet/store-keys.ts');
  const memStore = (initial = {}) => {
    const map = new Map(Object.entries(initial));
    return {
      map,
      getItem: async (k) => (map.has(k) ? map.get(k) : null),
      setItem: async (k, v) => {
        map.set(k, v);
      },
      removeItem: async (k) => {
        map.delete(k);
      },
    };
  };
  check('the key is declared in the storage seam, per wallet', BRIDGE_TRANSFERS_KEY === 'shiba-wallet.bridge-transfers.v1' &&
    STORE_KEYS.bridgeTransfers.name === BRIDGE_TRANSFERS_KEY && storeKeyScope(BRIDGE_TRANSFERS_KEY) === 'wallet' && MAX_BRIDGE_TRANSFERS === 64);
  resetChains();
  await resetBridgeTransfers();
  const plan = await quoteBridge(quoteRequest());
  const store = memStore();
  check('a fresh phone: nothing stored, writable', (await loadBridgeTransfers(store)).readOnly === false && listBridgeTransfers().length === 0);
  const rec = recordBridgeTransfer(plan, { sourceTxHash: SOURCE_TX, userOpHash: null, sentAt: 1_791_900_000_000 });
  await bridgeTransfersWritten();
  const stored = JSON.parse(store.map.get(BRIDGE_TRANSFERS_KEY));
  check('a sent transfer is written at once: version 1, one record, bigints as decimal strings, no final status yet',
    stored.version === 1 && stored.records.length === 1 && stored.records[0].id === rec.id && stored.records[0].amountIn === AMOUNT.toString() &&
      stored.records[0].destinationFromBlock === rec.destinationFromBlock.toString() && stored.records[0].final === null);
  // A status that is not final is not stored; a final one is.
  updateBridgeTransfer(rec.id, { status: { state: 'in-flight', detail: 'x' }, checkedAt: 5 });
  await bridgeTransfersWritten();
  check('an in-flight status is not stored (the screen asks again after a restart)', JSON.parse(store.map.get(BRIDGE_TRANSFERS_KEY)).records[0].final === null);
  const delivered = { state: 'delivered', detail: 'Delivered: the receiving network shows OFTReceived.', destinationTxHash: DELIVERY_TX, onChain: { status: 'delivered' } };
  updateBridgeTransfer(rec.id, { status: delivered, checkedAt: 1_791_900_090_000 });
  await bridgeTransfersWritten();
  check('a delivered status is stored as the final state with its detail and destination transaction (nothing else of the status)',
    JSON.stringify(JSON.parse(store.map.get(BRIDGE_TRANSFERS_KEY)).records[0].final) ===
      JSON.stringify({ state: 'delivered', detail: delivered.detail, destinationTxHash: DELIVERY_TX, checkedAt: 1_791_900_090_000 }));
  // "Restart": memory forgotten, loaded again from the store.
  await resetBridgeTransfers();
  check('after a restart the list is empty until the screen loads it', listBridgeTransfers().length === 0);
  const loaded = await loadBridgeTransfers(store);
  const back = listBridgeTransfers()[0];
  check('…and the load brings the transfer back with its route, amount, hashes and final status (tracking survives a restart)',
    !loaded.readOnly && listBridgeTransfers().length === 1 && back.id === rec.id && back.amountIn === AMOUNT && back.sourceTxHash === SOURCE_TX &&
      back.route.destinationChainId === OP && back.destinationFromBlock === rec.destinationFromBlock && back.status?.state === 'delivered' &&
      back.status.destinationTxHash === DELIVERY_TX && bridgeTransferFinal(back) && back.checkedAt === 1_791_900_090_000);
  const roundTrip = bridgeRecordFromStored(bridgeRecordToStored(rec));
  check('a record round-trips through its stored form', roundTrip !== null && roundTrip.id === rec.id && roundTrip.amountIn === rec.amountIn && roundTrip.recipient === rec.recipient);
  // Strict parse: one bad record makes the list read-only; nothing is written then.
  const good = bridgeRecordToStored(rec);
  const bad = (patch) => JSON.stringify({ version: 1, records: [good, { ...good, id: 'bridge-1-2', ...patch }] });
  const variants = {
    'an extra key': { extra: 1 },
    'an amount that is not a decimal string': { amountIn: 12 },
    'a CAIP-2 id that disagrees with the route': { sourceCaip2: 'eip155:1' },
    'a regular send without its transaction': { sourceTxHash: null },
    'a final state that is not final': { final: { state: 'in-flight', detail: 'x', destinationTxHash: null, checkedAt: 1 } },
    'a malformed recipient': { recipient: '0x1234' },
  };
  const strict = Object.entries(variants).filter(([, patch]) => {
    const r = parseBridgeTransfers(bad(patch));
    return !(r.readOnly && r.records.length === 1);
  });
  check(`the parse is strict: ${Object.keys(variants).length} damaged records each make the list read-only, the valid one still shown`, strict.length === 0, strict.map(([k]) => k).join());
  check('…and corrupt JSON, a wrong version or an extra top-level key do too',
    parseBridgeTransfers('{').readOnly && parseBridgeTransfers(JSON.stringify({ version: 2, records: [] })).readOnly &&
      parseBridgeTransfers(JSON.stringify({ version: 1, records: [], x: 1 })).readOnly && !parseBridgeTransfers(null).readOnly);
  const damagedText = bad({ extra: 1 });
  const damaged = memStore({ [BRIDGE_TRANSFERS_KEY]: damagedText });
  await resetBridgeTransfers();
  check('a damaged store loads read-only, with the valid record listed', (await loadBridgeTransfers(damaged)).readOnly && bridgeTransfersReadOnly() && listBridgeTransfers().length === 1);
  recordBridgeTransfer(plan, { sourceTxHash: SOURCE_TX.replace(/.$/, '0'), userOpHash: null, sentAt: 1_791_900_200_000 });
  await bridgeTransfersWritten();
  check('…a transfer sent then is listed but the damaged document is NOT written over', listBridgeTransfers().length === 2 && damaged.map.get(BRIDGE_TRANSFERS_KEY) === damagedText);
  check('the read-only sentence (exact)', BRIDGE_RECORDS_READ_ONLY_MESSAGE ===
    'The list of bridge transfers on this phone could not be read in full, so it is not changed: transfers sent now are followed only until the app is closed. Reset the transfer list to start a new one; nothing on the network changes.');
  await resetBridgeTransfers(damaged);
  check('"Reset the transfer list" removes the stored list and makes it writable again',
    !damaged.map.has(BRIDGE_TRANSFERS_KEY) && listBridgeTransfers().length === 0 && (await loadBridgeTransfers(damaged)).readOnly === false);
  // The cap: the newest 64, the oldest finished ones first.
  const capStore = memStore();
  await resetBridgeTransfers();
  await loadBridgeTransfers(capStore);
  const capIds = [];
  for (let i = 0; i < MAX_BRIDGE_TRANSFERS + 3; i += 1) {
    const r = recordBridgeTransfer(plan, { sourceTxHash: SOURCE_TX, userOpHash: null, sentAt: 1_791_000_000_000 + i });
    capIds.push(r.id);
    if (i === 1) updateBridgeTransfer(r.id, { status: delivered, checkedAt: 1_791_000_000_100 });
  }
  await bridgeTransfersWritten();
  const capped = JSON.parse(capStore.map.get(BRIDGE_TRANSFERS_KEY)).records;
  check('the list is capped at 64: the finished one goes first, then the oldest',
    listBridgeTransfers().length === 64 && capped.length === 64 && !capped.some((r) => r.id === capIds[1]) && !capped.some((r) => r.id === capIds[0]) &&
      !capped.some((r) => r.id === capIds[2]) && capped.some((r) => r.id === capIds[3]) && capped[0].id === capIds[capIds.length - 1]);
  // Per wallet: the decoy (a second storage profile) never sees the real wallet's transfers.
  const shared = memStore();
  const decoy = profileBoundStore(shared, { id: 'second', keyPrefix: 'w2' });
  const real = profileBoundStore(shared, PRIMARY_STORE_PROFILE);
  await resetBridgeTransfers();
  await loadBridgeTransfers(real);
  recordBridgeTransfer(plan, { sourceTxHash: SOURCE_TX, userOpHash: null, sentAt: 1_791_900_300_000 });
  await bridgeTransfersWritten();
  await loadBridgeTransfers(decoy);
  check('a second wallet (the duress decoy) loads an empty list: the other wallet\'s records are dropped from memory, and its key is its own',
    listBridgeTransfers().length === 0 && shared.map.has(BRIDGE_TRANSFERS_KEY) && !shared.map.has('shiba-wallet.profile-w2.bridge-transfers.v1'));
  await resetBridgeTransfers();

  // MUTANT: the read-only guard removed from the writer → a damaged list is overwritten.
  const mr = await bridgeMutant('  if (!target || target.readOnly) return writeQueue;', '  if (!target) return writeQueue;');
  const damaged2 = memStore({ [BRIDGE_TRANSFERS_KEY]: damagedText });
  await mr.loadBridgeTransfers(damaged2);
  mr.recordBridgeTransfer(plan, { sourceTxHash: SOURCE_TX, userOpHash: null, sentAt: 1_791_900_400_000 });
  await mr.bridgeTransfersWritten();
  check('MUTANT (read-only guard removed) is caught: the damaged list was written over', damaged2.map.get(BRIDGE_TRANSFERS_KEY) !== damagedText);
  // MUTANT: the record parse no longer insists on its exact key set.
  const mk = await bridgeMutant('  if (!isObject(value) || !exactKeys(value, STORED_KEYS)) return null;', '  if (!isObject(value)) return null;');
  check('MUTANT (exact key set dropped) is caught: a record with an extra key is accepted', mk.parseBridgeTransfers(bad({ extra: 1 })).readOnly === false);
  await mk.resetBridgeTransfers();
  await mr.resetBridgeTransfers();
}
// ---------------------------------------------------------------------------
console.log('check-bridge: a smart-account transfer resolved from the bundler’s receipt (the app closed before it arrived)');
// ---------------------------------------------------------------------------
{
  const memStore = () => {
    const map = new Map();
    return {
      map,
      getItem: async (k) => (map.has(k) ? map.get(k) : null),
      setItem: async (k, v) => {
        map.set(k, v);
      },
      removeItem: async (k) => {
        map.delete(k);
      },
    };
  };
  resetChains();
  await resetBridgeTransfers();
  const aaPlan = await quoteBridge(quoteRequest({ sender: KERNEL_ACCOUNT_0, senderKind: 'smart-account', recipient: OWNER_0 }));
  const store = memStore();
  await loadBridgeTransfers(store);
  const USEROP = '0x' + 'cd'.repeat(32);
  const rec = recordBridgeTransfer(aaPlan, { sourceTxHash: null, userOpHash: USEROP, sentAt: 1_791_900_500_000 });
  await bridgeTransfersWritten();
  const storedBefore = store.map.get(BRIDGE_TRANSFERS_KEY);
  const parsedBefore = parseBridgeTransfers(storedBefore);
  check('the stored record of an unresolved smart-account transfer parses: version 1, the same exact key set, sourceTxHash null, the userOpHash kept (no new field, no version bump)',
    JSON.parse(storedBefore).version === 1 && !parsedBefore.readOnly && parsedBefore.records.length === 1 &&
      Object.keys(JSON.parse(storedBefore).records[0]).length === 18 && parsedBefore.records[0].sourceTxHash === null &&
      parsedBefore.records[0].userOpHash === USEROP && parsedBefore.records[0].senderKind === 'smart-account');
  check('the copy: the waiting, not-included, reverted and malformed sentences (exact)',
    BRIDGE_USEROP_WAITING === 'Waiting for the bundle transaction that carries the smart-account operation; tracking starts once it is known.' &&
      BRIDGE_USEROP_NOT_INCLUDED === 'The smart-account operation has not been included yet: the bundler has no receipt for it. Tracking starts once it is included in a bundle transaction.' &&
      BRIDGE_USEROP_REVERTED === 'The smart-account operation was included but reverted, so nothing was bridged; its network fee was still charged.' &&
      BRIDGE_USEROP_RECEIPT_MALFORMED === 'The bundler’s receipt for the smart-account operation was not in the expected shape, so the wallet did not use it and will ask again.');

  let asks = [];
  let answer = null;
  const readers = { ...readersFor(SEPOLIA), userOpReceipt: async (req) => {
    asks.push(req);
    return typeof answer === 'function' ? answer() : answer;
  } };
  const findRec = (id) => listBridgeTransfers().find((r) => r.id === id);
  const sepoliaCalls = () => chains.get(SEPOLIA).calls.length;

  // 1. Not included yet: the record stays as it is.
  fetchLog = [];
  let callsBefore = sepoliaCalls();
  const st0 = await trackBridgeTransfer(rec, readers);
  await bridgeTransfersWritten();
  check('a null receipt → "Not known yet" with the not-included sentence; the bundler was asked once for this operation on the sending network',
    st0.state === 'unknown' && st0.detail === BRIDGE_USEROP_NOT_INCLUDED && asks.length === 1 && asks[0].chainId === SEPOLIA && asks[0].userOpHash === USEROP, st0.detail);
  check('…the record is unchanged (no hash, stored document byte for byte the same) and nothing else was asked (no node request, no Scan request)',
    findRec(rec.id).sourceTxHash === null && store.map.get(BRIDGE_TRANSFERS_KEY) === storedBefore && sepoliaCalls() === callsBefore && fetchLog.length === 0);

  // 2. Included: the bundle hash is stored and tracking continues by it in the same pass.
  chains.get(SEPOLIA).receipts.set(SOURCE_TX, { status: '0x1', logs: [oftSentLog(SEPOLIA, OP, GUID, AMOUNT, KERNEL_ACCOUNT_0), packetSentLog(SEPOLIA, OP)] });
  scanAnswer = { status: 404 };
  answer = { userOpHash: USEROP, sender: KERNEL_ACCOUNT_0, success: true, receipt: { transactionHash: SOURCE_TX, status: '0x1' } };
  asks = [];
  callsBefore = sepoliaCalls();
  const st1 = await trackBridgeTransfer(rec, readers);
  const sourceReads = chains.get(SEPOLIA).calls.slice(callsBefore).filter((c) => c.method === 'eth_getTransactionReceipt');
  check('resolved on the first pass: the bundle transaction from the receipt is read on the sending network and the transfer is followed by it (in flight, with the GUID)',
    st1.state === 'in-flight' && st1.onChain?.guid === GUID && sourceReads.length >= 1 && sourceReads[0].params[0] === SOURCE_TX && asks.length === 1, `${st1.state} ${st1.detail}`);
  check('…the hash is stored on the record in memory', findRec(rec.id).sourceTxHash === SOURCE_TX && findRec(rec.id).userOpHash === USEROP);
  await bridgeTransfersWritten();
  const storedAfter = JSON.parse(store.map.get(BRIDGE_TRANSFERS_KEY));
  const parsedAfter = parseBridgeTransfers(store.map.get(BRIDGE_TRANSFERS_KEY));
  check('…and in the stored document, which still parses strictly: version 1, the same 18 keys, the hash, the operation, no final status yet',
    storedAfter.version === 1 && Object.keys(storedAfter.records[0]).length === 18 && storedAfter.records[0].sourceTxHash === SOURCE_TX &&
      storedAfter.records[0].userOpHash === USEROP && storedAfter.records[0].final === null && !parsedAfter.readOnly && parsedAfter.records[0].sourceTxHash === SOURCE_TX);
  await resetBridgeTransfers();
  await loadBridgeTransfers(store);
  asks = [];
  const back = findRec(rec.id);
  const stBack = await trackBridgeTransfer(back, readers);
  check('after a restart the resolved transfer is followed by its hash with no bundler request', back.sourceTxHash === SOURCE_TX && asks.length === 0 && stBack.state === 'in-flight');

  // 3. A failed operation: failed, with the receipt's reason; nothing else asked.
  const USEROP2 = '0x' + 'ce'.repeat(32);
  const BUNDLE2 = '0x' + '5a'.repeat(32);
  const REASON = '0x7b5812d4'; // CallViolatesValueRule(), a revert reason seen live (phase 19)
  const rec2 = recordBridgeTransfer(aaPlan, { sourceTxHash: null, userOpHash: USEROP2, sentAt: 1_791_900_600_000 });
  answer = { userOpHash: USEROP2, sender: KERNEL_ACCOUNT_0, success: false, reason: REASON, receipt: { transactionHash: BUNDLE2 } };
  callsBefore = sepoliaCalls();
  fetchLog = [];
  const st2 = await trackBridgeTransfer(rec2, readers);
  check('a reverted operation → failed, with the receipt’s reason quoted (exact), final',
    st2.state === 'failed' && bridgeTransferFinal({ status: st2 }) &&
      st2.detail === `The smart-account operation was included but reverted, so nothing was bridged; its network fee was still charged. The bundler reported this reason: ${REASON}.`, st2.detail);
  check('…the bundle hash is kept on the record and nothing else was asked (no source receipt, no Scan)',
    findRec(rec2.id).sourceTxHash === BUNDLE2 && sepoliaCalls() === callsBefore && fetchLog.length === 0);
  updateBridgeTransfer(rec2.id, { status: st2, checkedAt: 1_791_900_600_500 }); // as the screen does with the answer
  await bridgeTransfersWritten();
  const failedBack = parseBridgeTransfers(store.map.get(BRIDGE_TRANSFERS_KEY));
  const failedRec = failedBack.records.find((r) => r.id === rec2.id);
  check('…stored as the final failed state, and the document still parses strictly',
    !failedBack.readOnly && failedRec?.status?.state === 'failed' && failedRec.status.detail === st2.detail && failedRec.sourceTxHash === BUNDLE2);
  check('a reverted operation without a usable reason: the plain sentence (no reason given; unprintable text dropped; "0x" alone dropped)',
    bridgeUserOpRevertedDetail(null) === BRIDGE_USEROP_REVERTED &&
      readBridgeUserOpReceipt({ success: false, reason: 'bad\u0007text', receipt: { transactionHash: BUNDLE2 } }, rec2).reason === null &&
      readBridgeUserOpReceipt({ success: false, reason: '0x', receipt: { transactionHash: BUNDLE2 } }, rec2).reason === null &&
      readBridgeUserOpReceipt({ success: false, reason: 'AA23 reverted', receipt: { transactionHash: BUNDLE2 } }, rec2).reason === 'AA23 reverted');

  // 4. Malformed receipts are refused and change nothing.
  const USEROP3 = '0x' + 'cf'.repeat(32);
  const rec3 = recordBridgeTransfer(aaPlan, { sourceTxHash: null, userOpHash: USEROP3, sentAt: 1_791_900_700_000 });
  const malformed = {
    'a string': '0x1234',
    'a list': [SOURCE_TX],
    'no transaction hash': { userOpHash: USEROP3, success: true },
    'a hash that is not 32 bytes': { userOpHash: USEROP3, success: true, receipt: { transactionHash: '0x12' } },
    'no success flag': { userOpHash: USEROP3, receipt: { transactionHash: SOURCE_TX } },
    'a success flag of another kind': { userOpHash: USEROP3, success: 'yes', receipt: { transactionHash: SOURCE_TX } },
    'another operation': { userOpHash: USEROP, success: true, receipt: { transactionHash: SOURCE_TX } },
    'another sender': { userOpHash: USEROP3, sender: OWNER_0, success: true, receipt: { transactionHash: SOURCE_TX } },
  };
  const accepted = [];
  for (const [name, value] of Object.entries(malformed)) {
    answer = value;
    const e = await rejection(() => trackBridgeTransfer(rec3, readers));
    if (!(e instanceof BridgeRefusal) || e.message !== BRIDGE_USEROP_RECEIPT_MALFORMED || findRec(rec3.id).sourceTxHash !== null) accepted.push(name);
  }
  check(`a malformed receipt is refused with the plain sentence and leaves the record unresolved (${Object.keys(malformed).length} shapes)`, accepted.length === 0, accepted.join(', '));
  answer = () => {
    throw new Error('bundler down');
  };
  const down = await rejection(() => trackBridgeTransfer(rec3, readers));
  check('a bundler that does not answer: the error reaches the screen (shown as a check error) and the record is unchanged', down?.message === 'bundler down' && findRec(rec3.id).sourceTxHash === null);

  // MUTANTS.
  const mNo = await bridgeMutant(
    '    if (record.userOpHash === null || !readers.userOpReceipt) return { state: \'unknown\', detail: BRIDGE_USEROP_WAITING };',
    '    return { state: \'unknown\', detail: BRIDGE_USEROP_WAITING };',
  );
  answer = { userOpHash: USEROP, sender: KERNEL_ACCOUNT_0, success: true, receipt: { transactionHash: SOURCE_TX } };
  const mSt = await mNo.trackBridgeTransfer({ ...rec, sourceTxHash: null }, readers);
  check('MUTANT (no resolution from the bundler’s receipt) is caught', mSt.state !== 'in-flight', mSt.state);
  const mHash = await bridgeMutant(
    "  if (raw.userOpHash !== undefined && (typeof raw.userOpHash !== 'string' || raw.userOpHash.toLowerCase() !== (record.userOpHash ?? '').toLowerCase())) refuse();\n",
    '',
  );
  const mOut = await rejection(async () => mHash.readBridgeUserOpReceipt(malformed['another operation'], rec3));
  check('MUTANT (a receipt for another operation accepted) is caught', !(mOut instanceof Error));
  await mNo.resetBridgeTransfers();
  await mHash.resetBridgeTransfers();

  // The screen asks the configured bundler through aa.ts and tracks transfers that have only an operation hash (source).
  const screen = readFileSync(join(APP_ROOT, 'src/screens/BridgeScreen.tsx'), 'utf8');
  const wired = (src) =>
    src.includes('return fetchUserOpReceipt(config.bundlerUrl, userOpHash);') && src.includes('const config = await getAaConfig(`eip155:${chainId}`);') &&
    src.includes('return !bridgeTransferFinal(record) && (record.sourceTxHash !== null || record.userOpHash !== null);') &&
    src.includes('if (bridgeRecordTrackable(r)) void checkBridgeRecord(r, readers, inFlight, busy);') && src.includes('{bridgeRecordTrackable(r) ? (') &&
    !src.includes('r.sourceTxHash !== null ? (');
  check('the screen: the bundler reader is built from aa.ts fetchUserOpReceipt with the sending network’s configured bundler, and the timer and "Check now" include a transfer known only by its operation (source)', wired(screen));
  check('MUTANT (the timer skipping transfers without a source hash, as before) is caught',
    !wired(screen.replace('if (bridgeRecordTrackable(r)) void checkBridgeRecord', 'if (!bridgeTransferFinal(r) && r.sourceTxHash !== null) void checkBridgeRecord')));
  await resetBridgeTransfers();
  resetChains();
}
{
  // The readers on their own.
  const scan = layerZeroScanReader();
  scanAnswer = { status: 404 };
  check('Scan reader: 404 → not indexed (null)', (await scan({ sourceChainId: SEPOLIA, sourceTxHash: SOURCE_TX })) === null);
  scanAnswer = { status: 200, body: { data: [{ status: { name: 'bad name!' }, destination: { tx: { txHash: 'not a hash' } } }] } };
  const odd = await scan({ sourceChainId: SEPOLIA, sourceTxHash: SOURCE_TX });
  check('Scan reader: an unexpected status name → UNKNOWN, a malformed destination hash dropped', odd.status === 'UNKNOWN' && odd.destinationTxHash === undefined);
  scanAnswer = { status: 500 };
  check('Scan reader: HTTP 500 → an error', (await rejection(() => scan({ sourceChainId: SEPOLIA, sourceTxHash: SOURCE_TX })))?.message === 'LayerZero Scan answered HTTP 500');
  check('Scan reader: a malformed hash is refused before any request', /32 bytes of hex/.test((await rejection(() => scan({ sourceChainId: SEPOLIA, sourceTxHash: '0x12' })))?.message ?? ''));
  check('Scan reader: the fixed https host', LAYERZERO_SCAN_TESTNET_API === 'https://scan-testnet.layerzero-api.com/v1');

  resetChains();
  chains.get(OP).head = 1_020_000n;
  const reader = destinationLogReader(readersFor(SEPOLIA), 1_000_000n);
  chains.get(OP).calls = [];
  await reader({ chainId: OP, address: pool(OP).address, topics: [null] });
  const windows = chains.get(OP).calls.filter((c) => c.method === 'eth_getLogs').map((c) => `${BigInt(c.params[0].fromBlock)}-${BigInt(c.params[0].toBlock)}`);
  check('destination logs: searched in windows of 9,000 blocks from the recorded head to the current head',
    windows.join() === '1000000-1008999,1009000-1017999,1018000-1020000', windows.join());
  const tooOld = destinationLogReader(readersFor(SEPOLIA), 1n);
  const old = await rejection(() => tooOld({ chainId: OP, address: pool(OP).address, topics: [null] }));
  check('a search older than 12 windows is refused with the plain sentence', old instanceof BridgeRefusal && old.message === BRIDGE_LOG_TOO_OLD);

  // defaultChainTransport: the built-in defaults in order, chain id checked, failover on endpoint failures only.
  resetChains();
  const urls = evmProfileByCaip2(caip(OP)).defaultRpcUrls;
  urlOverride = new Map([[urls[0], 'down']]);
  fetchLog = [];
  const t = defaultChainTransport(OP);
  check('a dead first default endpoint → the next one answers', (await t('eth_blockNumber', [])) === ethers.toQuantity(chains.get(OP).head) && fetchLog.includes(urls[1]));
  urlOverride = new Map([[urls[0], SEPOLIA]]);
  fetchLog = [];
  const t2 = defaultChainTransport(OP);
  await t2('eth_blockNumber', []);
  check('a default endpoint answering for another chain is skipped', fetchLog.filter((u) => u === urls[0]).length === 1 && fetchLog.includes(urls[1]));
  urlOverride = new Map();
  const t3 = defaultChainTransport(OP);
  const reverted = await rejection(() => t3('eth_call', [{ to: '0x' + '22'.repeat(20), data: '0x12345678' }, 'latest']));
  check('an answer (an RPC error) is returned, not failed over', reverted && !/No endpoint answered/.test(reverted.message) && fetchLog.length >= 0);
  check('no built-in endpoints for a chain the wallet does not know', (await rejection(async () => defaultChainTransport(59144))) instanceof BridgeRefusal);
}

// ---------------------------------------------------------------------------
console.log('check-bridge: the screen, the route gates, Home and the navigator (source)');
// ---------------------------------------------------------------------------
{
  const screen = source('src/screens/BridgeScreen.tsx');
  const views = source('src/screens/BridgeViews.tsx');
  const app = source('App.tsx');
  const nav = source('src/navigation.ts');
  const home = source('src/screens/HomeScreen.tsx');
  check('the gate first: readinessGate("bridge", caip2) renders the test-networks-only card before anything else',
    /const gate = readinessGate\('bridge', caip2\);/.test(screen) && /if \(gate\) \{\s*return \(\s*<ScrollView[^]*?<TestNetworksOnlyCard feature=\{gate\.feature\} hint=\{gate\.hint\} \/>/.test(screen));
  check('watch-only and multisig accounts are refused by name on the screen too',
    screen.includes("activeAccount?.watchOnly === true ? watchOnlyRouteRefusal('Bridge') : activeAccount?.multisig === true ? multisigRouteRefusal('Bridge') : null"));
  check('the route gates name the feature (exact)',
    watchOnlyRouteRefusal('Bridge') === 'Bridging is not available for a watch-only account: the wallet holds no key for this address, so it cannot sign or send anything for it. Switch to one of your own accounts to use it.' &&
      multisigRouteRefusal('Bridge') === 'Bridging is not available for a multi-signature account: no single key in this wallet can sign for it. Build its operations on the Multisig screen, where the co-signers approve them, or switch to one of your own accounts.' &&
      !WATCH_ONLY_ALLOWED_ROUTES.includes('Bridge') && !MULTISIG_ALLOWED_ROUTES.includes('Bridge'));
  check('the provider choice: a radiogroup that renders EVERY row (none filtered out), each a radio with checked/disabled state',
    /<View accessibilityRole="radiogroup"[^>]*>\s*\{rows\.map\(\(row\) =>/.test(screen) && !/rows\.filter\(\(r\) => r\.selectable\)\.map\(\(row\) =>\s*\{\s*const q/.test(screen) &&
      views.includes('accessibilityRole="radio"') && views.includes('accessibilityState={{ checked: selected, disabled: !row.selectable }}'));
  check('each provider row shows its label, the trust statement’s three parts, the fee once quoted and the measured time',
    ['Who verifies: ', 'Who controls: ', 'If it does not arrive: ', 'Fee (quoted just now): ', '{row.measured}', '{row.timeSource}', '{row.note}'].every((s) => views.includes(s)));
  check('both send paths ask the device with the prompt title, after the spending limits',
    (screen.match(/const auth = await requireLocalAuth\(bridgePromptTitle\(plan\)\);/g) ?? []).length === 2 &&
      screen.indexOf('spendingGateForQuote({ chain: caip2, owner: account.address, from: preparedFrom.current') < screen.indexOf('requireLocalAuth(bridgePromptTitle(plan))'));
  check('the regular account sends through sendEvm with the quote from prepareBridgeSend; the smart account through sendAa with prepareBridgeAa',
    /sendEvm\(sendUrl, signer, eoaQuote, evmChain\.explorerTxBase\)/.test(screen) && /sendAa\(bundle, signer, aaQuote, \{ kind: 'bridge' \}\)/.test(screen) &&
      screen.includes('prepareBridgeSend(ep.url, account.address, p)') && screen.includes('prepareBridgeAa(bundle, account.address, p)'));
  check('the smart account is checked against the bundler’s fee floor before the device prompt', screen.indexOf('checkAaQuoteBeforeApproval(bundle.bundler, aaQuote)') < screen.indexOf("sendAa(bundle, signer, aaQuote, { kind: 'bridge' })"));
  check('the confirm: the preview (eth_simulateV1), the risk card, the spending notice and the pre-flight result',
    (screen.match(/<BalanceChangePreview /g) ?? []).length === 2 && (screen.match(/<RiskWarnings /g) ?? []).length === 2 && screen.includes('Pre-flight simulation passed (eth_call).'));
  check('the recipient is always the regular account (account.address), on both paths', (screen.match(/recipient: account\.address,/g) ?? []).length === 2);
  check('the smart-account sentence is shown on the form before Review (Kernel), the EIP-7702 one for an upgraded account',
    screen.includes("aaActive && aaType === 'kernel-v3.3' ? (\n              <WarningBox>{smartAccountRecipientNote(account.address, destinationLabel)}</WarningBox>") &&
      screen.includes('upgradedAccountRecipientNote(account.address, destinationLabel)'));
  check('a sent transfer is recorded and followed: the record, the note field, the 15-second tracking',
    screen.includes('recordBridgeTransfer(plan, { sourceTxHash: sent.txid, userOpHash: null, sentAt })') &&
      screen.includes('recordBridgeTransfer(plan, { sourceTxHash: null, userOpHash, sentAt })') &&
      screen.includes('}, [trackingOn, chainIdDecimal, url]);') &&
      screen.includes('<TransactionNoteField network={sentNetwork} txid={result.txid} userOpHash={null} />') &&
      screen.includes('setInterval(tick, BRIDGE_TRACK_INTERVAL_MS)'));
  check('the screen loads the stored transfers when it opens, and offers "Reset the transfer list" with the read-only sentence when the list is damaged',
    screen.includes('loadBridgeTransfers().then(') && screen.includes('<WarningBox>{BRIDGE_RECORDS_READ_ONLY_MESSAGE}</WarningBox>') &&
      screen.includes('<Button title="Reset the transfer list" variant="secondary" onPress={onResetTransfers} />') && screen.includes('resetBridgeTransfers(AsyncStorage)'));
  check('a smart-account operation that reverted is stored as failed (it carries the time it was learned)',
    /updateBridgeTransfer\(record\.id, \{\n\s+sourceTxHash: summary\.txHash,\n\s+checkedAt: Date\.now\(\),\n\s+status: \{ state: 'failed'/.test(screen));
  const walletCtx = source('src/wallet/WalletContext.tsx');
  check('the wipe forgets the stored transfers on both paths (with an app PIN: for each wallet), and opening the other wallet clears the list in memory',
    walletCtx.includes('await resetBridgeTransfers(store).catch(() => undefined);') && walletCtx.includes('await resetBridgeTransfers(AsyncStorage).catch(() => undefined);') &&
      /setActiveStoreProfile\(profile\);[\s\S]{0,400}void resetBridgeTransfers\(\);/.test(walletCtx));
  check('the retry panel sends retryReceiveToken through prepareBridgeRetry with its own prompt', screen.includes('prepareBridgeRetry(ep.url, fromAddress, record)') && screen.includes('requireLocalAuth(bridgeRetryPromptTitle(record))'));
  check('the OP-stack fee rows come from bridgeSourceFeeLines', screen.includes('bridgeSourceFeeLines(eoaQuote, symbol)'));
  check('App.tsx registers Bridge with the title "Bridge (test networks)"; navigation.ts lists it',
    app.includes("<Stack.Screen name=\"Bridge\" component={BridgeScreen} options={{ title: 'Bridge (test networks)' }} />") && /\n  Bridge: undefined;/.test(nav));
  check('Home: the Bridge link only where readiness allows and a provider serves the network',
    home.includes("isFeatureAllowed('bridge', evmChain.caip2) && bridgeOfferFor(evmChain.caip2).destinations.length > 0\n            ? cardLink('bridge', 'Bridge', () => navigation.navigate('Bridge'), 'Opens bridging between test networks')"));
}

// ---------------------------------------------------------------------------
console.log('check-bridge: the emulator pass p21b findings (provider choice, spoken rows, scroll, gas, inputs, sent time, placeholder)');
// ---------------------------------------------------------------------------
{
  resetChains();
  const screen = source('src/screens/BridgeScreen.tsx');
  const views = source('src/screens/BridgeViews.tsx');
  const sep = bridgeOfferFor(caip(SEPOLIA));
  const rows = bridgeProviderRows(sep, OP);
  const lz = rows.find((r) => r.id === LAYERZERO_OFT_PROVIDER_ID);
  const cctp = rows.find((r) => r.id === CCTP_V2_PROVIDER_ID);

  // (2) No provider is pre-selected, not even the only one that can be chosen.
  check('finding 2: nothing is chosen until the user taps a row (Sepolia → OP Sepolia, LayerZero the only selectable row)',
    rows.filter((r) => r.selectable).length === 1 && chosenBridgeProvider(rows, null) === null);
  check('…a tap on LayerZero chooses it; a tap on CCTP (not selectable) chooses nothing; a choice from another route is dropped',
    chosenBridgeProvider(rows, LAYERZERO_OFT_PROVIDER_ID) === LAYERZERO_OFT_PROVIDER_ID && chosenBridgeProvider(rows, CCTP_V2_PROVIDER_ID) === null &&
      chosenBridgeProvider(bridgeProviderRows(bridgeOfferFor(caip(BASE)), ARB), LAYERZERO_OFT_PROVIDER_ID) === null);
  check('…the single-provider sentence (exact) while nothing is chosen, none once chosen or when no row can be chosen',
    BRIDGE_SINGLE_PROVIDER_NOTE === 'One provider serves this route; choose it to continue.' &&
      bridgeProviderChoiceHint(rows, null) === BRIDGE_SINGLE_PROVIDER_NOTE && bridgeProviderChoiceHint(rows, LAYERZERO_OFT_PROVIDER_ID) === null &&
      bridgeProviderChoiceHint(bridgeProviderRows(bridgeOfferFor(caip(BASE)), ARB), null) === null);
  check('…the screen: chosenProvider comes from chosenBridgeProvider (no fallback to the first row), the hint is drawn, Get quotes and Review are disabled while nothing is chosen, each row is checked only when chosen',
    screen.includes('const chosenProvider = chosenBridgeProvider(rows, providerId);') && !/rows\.find\(\(r\) => r\.selectable\)\?\.id/.test(screen) &&
      screen.includes('{providerChoiceHint ? <Text style={[styles.hint, { color: theme.text }]}>{providerChoiceHint}</Text> : null}') &&
      (screen.match(/disabled=\{quoting \|\| chosenProvider === null\}/g) ?? []).length === 2 && screen.includes('selected={chosenProvider === row.id}'));
  const m2b = await bridgeMutant(
    'return picked !== null && rows.some((r) => r.id === picked && r.selectable) ? picked : null;',
    'return picked !== null && rows.some((r) => r.id === picked && r.selectable) ? picked : (rows.find((r) => r.selectable)?.id ?? null);',
  );
  check('MUTANT (the old default: the first selectable row pre-checked) is caught', m2b.chosenBridgeProvider(rows, null) !== null);

  // (3) The radio control speaks a short label; the trust lines are separate items.
  check('finding 3: the radio labels (exact), never ending in a period (the CCTP row read "..")',
    providerRowSpokenLabel(lz, null) === 'LayerZero (Stargate), moves test ETH' &&
      providerRowSpokenLabel(lz, { fee: '0.000102050140082558 test ETH' }) === 'LayerZero (Stargate), moves test ETH, fee 0.000102050140082558 test ETH' &&
      providerRowSpokenLabel(cctp, null) === 'Circle CCTP (USDC), moves USDC, not available' &&
      providerRowSpokenLabel({ label: 'X.', asset: null, selectable: false }, null) === 'X., not available' &&
      providerRowSpokenLabel({ label: 'Y', asset: null, selectable: true }, { fee: '1 test ETH.' }) === 'Y, fee 1 test ETH',
    `${providerRowSpokenLabel(lz, null)} | ${providerRowSpokenLabel(cctp, null)}`);
  const m3b = await bridgeMutant(
    "const tail = !row.selectable ? ', not available' : quote ? `, fee ${quote.fee}` : '';\n  return `${head}${tail}`.replace(/[.\\s]+$/, '');",
    "const tail = !row.selectable ? `, not available: ${row.note}` : quote ? `, fee ${quote.fee}` : '';\n  return `${head}${tail}`;",
  );
  check('MUTANT (the old spoken label with the reason and its final period) is caught', /\.$/.test(m3b.providerRowSpokenLabel(cctp, null)));
  // The body's opening tag, whatever its props, and its contents up to the
  // first closing tag of the same element type (it holds only Text).
  const BODY_RE = /<(View|Pressable)\b((?:[^>{]|\{[^}]*\})*?)\s*style=\{styles\.radioBody\}\s*>([^]*?)<\/\1>/;
  // Pass p21g finding B2b (RN 0.86.3): the delegate gives a view with no
  // text of its own a description joining its children's text whenever it
  // has an accessibilityState, a role, actions or a labelled-by
  // (ReactAccessibilityDelegate.kt :177–187), and a Pressable ALWAYS passes
  // an accessibilityState object (Pressable.js :227–236, :257). So the body
  // must be a plain View with none of those, its tap handled by the
  // JavaScript responder props, and none at all on a row that cannot be
  // chosen.
  const bodyOpenerOk = (props) =>
    !/\b(?:disabled|accessibilityState|accessibilityRole|accessibilityLabel|accessibilityLabelledBy|accessibilityActions|onAccessibilityAction|role|onPress|onLongPress|focusable)=|aria-|accessible(?!=\{false\})/.test(props) &&
    /\baccessible=\{false\}/.test(props) &&
    props.includes('onStartShouldSetResponder={row.selectable ? claimBodyTouch : undefined}') &&
    props.includes('onResponderRelease={row.selectable ? onSelect : undefined}') &&
    props.includes('onResponderTerminationRequest={allowBodyTouchTermination}');
  const rowStructureOk = (src) => {
    const radio = /<Pressable\s+accessibilityRole="radio"\s+accessibilityState=\{\{ checked: selected, disabled: !row\.selectable \}\}\s+accessibilityLabel=\{providerRowSpokenLabel\(row, quote\)\}[^]*?<\/Pressable>/.exec(src);
    const m = BODY_RE.exec(src);
    if (!radio || /Who verifies/.test(radio[0]) || !m || m[1] !== 'View') return false;
    const body = [m[0], m[2], m[3]];
    // Pass p21e finding B2b: no accessibility prop on the body that would
    // make RN join its children into one description (an accessibilityState
    // — which a non-null `disabled` creates — a role, a label, actions or a
    // labelled-by), and every top-level sentence an `accessible` Text.
    if (!bodyOpenerOk(body[1])) return false;
    const topTexts = body[2].match(/<Text\b[^>]*style=\{\[styles\.body[^>]*>/g) ?? [];
    return ['{row.note}', 'Who verifies: ', 'Who controls: ', 'If it does not arrive: ', 'Fee (quoted just now): ', '{BRIDGE_FEE_BEFORE_QUOTE}', '{row.measured}', '{row.timeSource}'].every((t) => body[2].includes(t)) &&
      topTexts.length === 8 && topTexts.every((t) => /^<Text accessible style=/.test(t));
  };
  check('…the row: the radio control holds only the head; the note, the three trust lines, the fee and the measured time sit in a body that is neither accessible nor focusable, so each Text is its own stop (source)',
    rowStructureOk(views));
  const BODY_OPEN = [
    '<View',
    '        accessible={false}',
    '        onStartShouldSetResponder={row.selectable ? claimBodyTouch : undefined}',
    '        onResponderTerminationRequest={allowBodyTouchTermination}',
    '        onResponderRelease={row.selectable ? onSelect : undefined}',
    '        style={styles.radioBody}',
    '      >',
  ].join('\n');
  const bodyClose = '{row.timeSource}</Text> : null}\n      </View>';
  check('…the body opener and its closing tag are exactly as pinned (source)', views.includes(BODY_OPEN) && views.includes(bodyClose));
  const swapBody = (opener, closeTag = '</View>') =>
    views.replace(BODY_OPEN, opener).replace(bodyClose, `{row.timeSource}</Text> : null}\n      ${closeTag}`);
  check('MUTANT (the body made one accessible node again) is caught',
    !rowStructureOk(views.replace(BODY_OPEN, BODY_OPEN.replace('        accessible={false}\n', ''))) &&
      !rowStructureOk(views.replace(BODY_OPEN, BODY_OPEN.replace('accessible={false}', 'accessible'))));
  check('MUTANT (p21g finding B2b: the body a Pressable again, as at 828cff1 — Pressable always passes an accessibilityState, so the delegate joins the sentences into one ", "-separated description) is caught',
    !rowStructureOk(swapBody('<Pressable accessible={false} focusable={false} onPress={row.selectable ? onSelect : undefined} style={styles.radioBody}>', '</Pressable>')));
  check('MUTANT (p21e finding B2b: an accessibilityState on the body — the old `disabled` — makes the delegate join every sentence and speak "disabled" after it) is caught',
    !rowStructureOk(views.replace(BODY_OPEN, BODY_OPEN.replace('        accessible={false}\n', '        accessible={false}\n        accessibilityState={{ disabled: !row.selectable }}\n'))));
  check('MUTANT (a role on the body — the delegate joins the sentences for a role too) is caught',
    !rowStructureOk(views.replace(BODY_OPEN, BODY_OPEN.replace('        accessible={false}\n', '        accessible={false}\n        accessibilityRole="button"\n'))));
  check('MUTANT (a row that cannot be chosen still claims the touch) is caught',
    !rowStructureOk(views.replace('onStartShouldSetResponder={row.selectable ? claimBodyTouch : undefined}', 'onStartShouldSetResponder={claimBodyTouch}')) &&
      !rowStructureOk(views.replace('onResponderRelease={row.selectable ? onSelect : undefined}', 'onResponderRelease={onSelect}')));
  check('MUTANT (p21e finding B2b: one sentence not its own accessible Text) is caught',
    !rowStructureOk(views.replace('<Text accessible style={[styles.body, { color: theme.text }]}>\n          <Text style={styles.strong}>Who controls: </Text>', '<Text style={[styles.body, { color: theme.text }]}>\n          <Text style={styles.strong}>Who controls: </Text>')));
  // The sentences each Text speaks, exactly, and none with a doubled period
  // (the CCTP row read "…at any time.. disabled").
  const cctpRow = rows.find((r) => r.id === CCTP_V2_PROVIDER_ID);
  const lzRow = rows.find((r) => r.id === LAYERZERO_OFT_PROVIDER_ID);
  const spoken = (r) => [r.note, `Who verifies: ${r.trust.verification}`, `Who controls: ${r.trust.control}`, `If it does not arrive: ${r.trust.refundRule}`, r.measured, r.timeSource].filter(Boolean);
  check('p21e finding B2b: the CCTP refund sentence is read exactly as written, ending in one period',
    `If it does not arrive: ${cctpRow.trust.refundRule}` ===
      'If it does not arrive: There is no refund: the USDC is burned on the sending network. Once Circle attests the burn, anyone with gas on the receiving network can complete the mint to your address, at any time.');
  check('p21e finding B2b: no provider-row sentence has a doubled period or ends without one',
    [...spoken(cctpRow), ...spoken(lzRow)].every((t) => !/\.\./.test(t) && /[.)]$/.test(t.trim())), [...spoken(cctpRow), ...spoken(lzRow)].filter((t) => /\.\./.test(t) || !/[.)]$/.test(t.trim())).join(' | '));

  // (4) Each phase opens at the top: one ScrollView key per view.
  const keys = [...screen.matchAll(/<ScrollView key="(bridge-[a-z-]+)"/g)].map((m) => m[1]);
  check('finding 4: the form, both confirms and the success view each have their own ScrollView key, so a new view never inherits the form’s scroll position (React reuses a native view only for the same key and type)',
    JSON.stringify(keys.sort()) === JSON.stringify(['bridge-aa-confirm', 'bridge-confirm', 'bridge-form', 'bridge-success']), keys.join());
  const keyless = screen.replace('<ScrollView key="bridge-confirm" ', '<ScrollView ');
  check('MUTANT (the confirm without its key) is caught', [...keyless.matchAll(/<ScrollView key="(bridge-[a-z-]+)"/g)].length !== 4);

  // (6) The gas limit follows Send's rule: prepareEvmSend uses the node's estimate as the limit, with no padding, for Send and the bridge alike.
  const planA = await quoteBridge(quoteRequest());
  const q = await prepareBridgeSend(ACTIVE_URL(SEPOLIA), EOA, planA);
  const plain = await prepareEvmSend(ACTIVE_URL(SEPOLIA), EOA, ethers.getAddress('0x' + '42'.repeat(20)), 1n, undefined, caip(SEPOLIA));
  check('finding 6: the bridge send’s gas limit is the estimate exactly as Send’s is (prepareEvmSend has no padding rule: 341,035 = the node’s answer on both), and the worst case is that limit × the max fee',
    q.gasLimit === 341_035n && plain.gasLimit === 341_035n && q.gasLimit === plain.gasLimit && q.fee === q.gasLimit * q.maxFeePerGas, `${q.gasLimit} / ${plain.gasLimit}`);
  const m6b = await bridgeMutant(
    '  const quote = await prepareEvmSend(url, from, plan.call.to, plan.call.value, plan.call.data, plan.sourceCaip2);',
    '  const raw = await prepareEvmSend(url, from, plan.call.to, plan.call.value, plan.call.data, plan.sourceCaip2);\n  const quote = { ...raw, gasLimit: (raw.gasLimit * 12n) / 10n };',
  );
  const qm = await m6b.prepareBridgeSend(ACTIVE_URL(SEPOLIA), EOA, planA);
  check('MUTANT (a bridge-only padding, diverging from Send) is caught', qm.gasLimit !== plain.gasLimit);

  // (7) No chips and no amount where no provider can send.
  check('finding 7: the destination chips and the amount field are shown on Ethereum Sepolia, hidden on Base Sepolia and Hoodi (nothing can be sent there)',
    bridgeFormInputsShown(sep) && !bridgeFormInputsShown(bridgeOfferFor(caip(BASE))) && !bridgeFormInputsShown(bridgeOfferFor(caip(HOODI))));
  const inputsGated = (src) =>
    src.includes('{inputsShown && offer.destinations.length > 0 ? (') && /\{inputsShown \? \(\s*<>\s*<Text \{\.\.\.amountField\.label\}/.test(src) &&
    src.includes('const inputsShown = offer !== null && bridgeFormInputsShown(offer);') && src.includes('{offer.unavailable ? <WarningBox>{offer.unavailable}</WarningBox> : null}');
  check('…the screen gates the chips and the amount on it; the explanatory sentence and the provider rows stay (source)', inputsGated(screen));
  check('MUTANT (the amount field shown regardless) is caught', !inputsGated(screen.replace('{inputsShown ? (\n        <>\n          <Text {...amountField.label}', '{true ? (\n        <>\n          <Text {...amountField.label}')));

  // (7, leftover) Where the chips are hidden, a provider row's reason names
  // only the source network: the form offers no destination to point at.
  const baseOffer = bridgeOfferFor(caip(BASE));
  const baseRowsAll = baseOffer.destinations.map((d) => bridgeProviderRows(baseOffer, d.chainId));
  const lzNotes = baseRowsAll.map((rows) => rows.find((r) => r.label === LAYERZERO_APP_LABEL)?.note);
  check('finding 7 leftover: on Base Sepolia (chips hidden) the LayerZero row says only "Does not serve Base Sepolia in this wallet." for every destination the screen could fall back to (exact)',
    baseOffer.destinations.length > 0 && lzNotes.every((n) => n === 'Does not serve Base Sepolia in this wallet.') && noSourceRouteNote('Base Sepolia') === 'Does not serve Base Sepolia in this wallet.' &&
      lzNotes.every((n) => !/→/.test(n ?? '')), lzNotes.join(' | '));
  check('…the CCTP row on Base Sepolia keeps its coming note', baseRowsAll.every((rows) => rows.some((r) => !r.selectable && r.note === CCTP_COMING_NOTE)));
  const sepToBase = bridgeProviderRows(bridgeOfferFor(caip(SEPOLIA)), BASE);
  check('…where the chips are shown (Ethereum Sepolia), the destination variant stays: "Does not serve Ethereum Sepolia → Base Sepolia in this wallet." (exact)',
    sepToBase[0].note === 'Does not serve Ethereum Sepolia → Base Sepolia in this wallet.', sepToBase[0].note);
  const m7b = await bridgeMutant(
    "const noRoute = bridgeFormInputsShown(offer) ? noRouteNote(offer.sourceLabel, destinationLabel) : noSourceRouteNote(offer.sourceLabel);",
    'const noRoute = noRouteNote(offer.sourceLabel, destinationLabel);',
  );
  const mBase = m7b.bridgeOfferFor(caip(BASE));
  const mNote = m7b.bridgeProviderRows(mBase, mBase.destinations[0].chainId)[0].note;
  check('MUTANT (the old destination sentence on a network with the chips hidden) is caught', mNote !== 'Does not serve Base Sepolia in this wallet.', mNote);

  // (7, the choice-note leftover; phase 22 polish) The note under "Choose a
  // provider" spoke of "this pair of networks" where no pair can be chosen.
  const BASE_CHOICE = 'The wallet lists every provider it knows, each with the reason it cannot send from Base Sepolia, and never picks one for you.';
  const baseRows = bridgeProviderRows(baseOffer, baseOffer.destinations[0].chainId);
  check('choice note: Ethereum Sepolia (chips shown) keeps "…for this pair of networks…" (exact)',
    bridgeChoiceNote(sep, bridgeProviderRows(sep, OP).length) === BRIDGE_CHOICE_NOTE);
  check('choice note: Base Sepolia (chips hidden) names only the source network and no pair (exact), and every row there does give its reason',
    bridgeChoiceNote(baseOffer, baseRows.length) === BASE_CHOICE && !/pair of networks/.test(BASE_CHOICE) &&
      baseRows.length > 0 && baseRows.every((r) => !r.selectable && typeof r.note === 'string' && r.note.length > 0), bridgeChoiceNote(baseOffer, baseRows.length));
  const hoodiOffer = bridgeOfferFor(caip(HOODI));
  check('choice note: none where no provider is listed (Hoodi: no destination, no rows; the warning above says why)',
    hoodiOffer.destinations.length === 0 && bridgeChoiceNote(hoodiOffer, 0) === null && hoodiOffer.unavailable === 'No bridge provider in this wallet serves Hoodi.');
  const choiceNoteWired = (src) =>
    src.includes('const choiceNote = offer !== null ? bridgeChoiceNote(offer, rows.length) : null;') &&
    /\{choiceNote \? \(\s*<>\s*<Text accessibilityRole="header" style=\{\[styles\.label, \{ color: theme\.textMuted \}\]\}>Choose a provider<\/Text>\s*<Text style=\{\[styles\.hint, \{ color: theme\.textMuted \}\]\}>\{choiceNote\}<\/Text>/.test(src) &&
    !src.includes('{BRIDGE_CHOICE_NOTE}');
  check('…the screen shows "Choose a provider" and that note only when there is one (source)', choiceNoteWired(screen));
  check('MUTANT (the screen showing the pair sentence everywhere) is caught',
    !choiceNoteWired(screen.replace('<Text style={[styles.hint, { color: theme.textMuted }]}>{choiceNote}</Text>', '<Text style={[styles.hint, { color: theme.textMuted }]}>{BRIDGE_CHOICE_NOTE}</Text>')));
  const m7c = await bridgeMutant('  if (bridgeFormInputsShown(offer)) return BRIDGE_CHOICE_NOTE;', '  return BRIDGE_CHOICE_NOTE;');
  const mBase7c = m7c.bridgeOfferFor(caip(BASE));
  check('MUTANT (the pair sentence on Base Sepolia, where no pair can be chosen) is caught',
    m7c.bridgeChoiceNote(mBase7c, m7c.bridgeProviderRows(mBase7c, mBase7c.destinations[0].chainId).length) !== BASE_CHOICE);

  // (8) The sent time is the broadcast's, whatever waits afterwards.
  let clock = 1_000;
  const stamped = await broadcastStamped(async () => {
    clock = 5_000; // the node took the transaction
    return { txid: SOURCE_TX };
  }, () => clock);
  clock = 45_000; // signWith's teardown, a receipt wait, a slow re-render
  const rec = recordBridgeTransfer(planA, { sourceTxHash: stamped.value.txid, userOpHash: null, sentAt: stamped.sentAt });
  check('finding 8: the record’s sent time is the moment the broadcast returned (5,000), not after the 40 s that follow it', rec.sentAt === 5_000 && stamped.sentAt === 5_000, `${rec.sentAt}`);
  clock = 2_000;
  const aaStamped = await broadcastStamped(async () => {
    clock = 7_000; // eth_sendUserOperation answered
    return { userOpHash: '0x' + 'ab'.repeat(32) };
  }, () => clock);
  const receiptWait = new Promise((r) => setTimeout(r, 30)).then(() => {
    clock = 120_000; // waitForAaReceipt resolves much later
  });
  const aaRec = recordBridgeTransfer(planA, { sourceTxHash: null, userOpHash: aaStamped.value.userOpHash, sentAt: aaStamped.sentAt });
  await receiptWait;
  check('…the smart account: stamped when the bundler took the operation (7,000), unchanged by the receipt wait that ends later', aaRec.sentAt === 7_000 && clock === 120_000);
  check('…the screen stamps inside the signing callback on both paths and records that time (source)',
    screen.includes('broadcastStamped(() => sendEvm(sendUrl, signer, eoaQuote, evmChain.explorerTxBase)),') &&
      screen.includes("broadcastStamped(() => sendAa(bundle, signer, aaQuote, { kind: 'bridge' }))") &&
      screen.includes('recordBridgeTransfer(plan, { sourceTxHash: sent.txid, userOpHash: null, sentAt })') &&
      screen.includes('recordBridgeTransfer(plan, { sourceTxHash: null, userOpHash, sentAt })'));
  const m8b = await bridgeMutant('  const value = await broadcast();\n  return { value, sentAt: now() };', '  const sentAt = now();\n  const value = await broadcast();\n  return { value, sentAt };');
  clock = 1_000;
  const early = await m8b.broadcastStamped(async () => {
    clock = 5_000;
    return 1;
  }, () => clock);
  check('MUTANT (stamped before the broadcast) is caught', early.sentAt !== 5_000);

  // (9) The placeholder cannot be mistaken for a value.
  check('finding 9: the amount placeholder is a worded example (exact), the step hint unchanged',
    BRIDGE_AMOUNT_PLACEHOLDER === 'Amount, for example 0.0002' && screen.includes('placeholder={BRIDGE_AMOUNT_PLACEHOLDER}') && !screen.includes('placeholder="0.0002"') &&
      screen.includes('Stargate moves {symbol} in steps of 0.000001; an amount with more decimal places is refused, not rounded.'));
}

// ---------------------------------------------------------------------------
console.log('check-bridge: mutation checks');
// ---------------------------------------------------------------------------
{
  resetChains();
  const expect = { sourceChainId: SEPOLIA, destinationChainId: OP, amount: AMOUNT, recipient: EOA, sender: EOA };
  const run = (mod, q) => {
    try {
      mod.checkBridgeQuote(q, expect);
      return null;
    } catch (e) {
      return e;
    }
  };
  const base = await quoteBridge(quoteRequest());
  const withApproval = (amount) => {
    const token = '0x' + '11'.repeat(20);
    return {
      ...base.quote,
      calls: [
        { purpose: 'approve', chainId: SEPOLIA, to: token, value: 0n, data: ethers.getBytes(oftIface.encodeFunctionData('approve', [base.call.to, amount])), pins: [], unpinnable: [], valueLimit: 0n },
        ...base.quote.calls,
      ],
      approvals: [{ chainId: SEPOLIA, token, spender: base.call.to, amount }],
    };
  };

  // 1. An unlimited approval accepted as exact (both exactness checks removed:
  // the listed approvals and the approve calldata).
  const m1 = await bridgeMutant(
    'if (a.amount <= 0n || a.amount > expect.amount || a.amount > MAX_EXACT_APPROVAL) fail(\'an approval that is not exact\');',
    '// mutant: approval amounts not checked',
    "if (!hex.startsWith('0x095ea7b3') || hex.length !== 2 + 8 + 128 || amountWord <= 0n || amountWord > expect.amount) {",
    "if (!hex.startsWith('0x095ea7b3') || hex.length !== 2 + 8 + 128) {",
  );
  const r1 = run(m1, withApproval(ethers.MaxUint256));
  check('MUTANT (approval exactness removed) is caught: the refusal no longer says "not exact"', !/an approval that is not exact/.test(r1?.message ?? ''), r1?.message);
  // 1b. Only the calldata check kept: still refused (two independent layers).
  const m1b = await bridgeMutant(
    'if (a.amount <= 0n || a.amount > expect.amount || a.amount > MAX_EXACT_APPROVAL) fail(\'an approval that is not exact\');',
    '// mutant: approval amounts not checked',
  );
  check('…and with only the listed-approval check removed, the calldata check still refuses an unlimited approval',
    /an approval that is not exact/.test(run(m1b, withApproval(ethers.MaxUint256))?.message ?? ''));
  check('…while the real module says it', /an approval that is not exact/.test(run({ checkBridgeQuote }, withApproval(ethers.MaxUint256))?.message ?? ''));

  // 2. A value other than amount + fee accepted.
  const m2 = await bridgeMutant(
    "if (call.value !== expect.amount + messagingFee) fail('a value that is not the amount plus the messaging fee');",
    '// mutant: value not checked',
  );
  const bumped = { ...base.quote, calls: [{ ...base.quote.calls[0], value: base.quote.calls[0].value + 1n, valueLimit: base.quote.calls[0].valueLimit + 1n }] };
  check('MUTANT (value = amount + fee check removed) is caught: it passes a value one wei higher', run(m2, bumped) === null);
  check('…while the real module refuses it', run({ checkBridgeQuote }, bumped) instanceof BridgeRefusal);

  // 3. The readiness gate removed from quoteBridge.
  const m3 = await bridgeMutant(
    `export async function quoteBridge(request: BridgeQuoteRequestApp): Promise<BridgePlan> {
  assertFeatureAllowed(BRIDGE_FEATURE, request.caip2);`,
    `export async function quoteBridge(request: BridgeQuoteRequestApp): Promise<BridgePlan> {`,
  );
  const r3 = await rejection(() => m3.quoteBridge(quoteRequest({ caip2: 'eip155:1', readers: readersFor(1) })));
  check('MUTANT (gate removed) is caught: a mainnet quote is no longer refused by readiness', r3?.name !== 'FeatureNotAllowedError', `${r3?.name}`);

  // 4. The provider choice hidden (only offered providers listed).
  const m4 = await bridgeMutant(
    `  const destinationLabel = labelOfChain(destinationChainId);
  return registry.list().map((p) => {`,
    `  const destinationLabel = labelOfChain(destinationChainId);
  return registry.list().filter((p) => BRIDGE_PROVIDER_STATUS[p.id] === 'offered').map((p) => {`,
  );
  const rows4 = m4.bridgeProviderRows(m4.bridgeOfferFor(caip(SEPOLIA)), OP);
  check('MUTANT (CCTP hidden from the choice) is caught: the rows no longer list every provider', rows4.length !== 2);

  // 5. The recipient word not checked.
  const m5 = await bridgeMutant('[OFT_SEND_LAYOUT.to, addressToBytes32(expect.recipient).toLowerCase()],', '');
  const redirected = { ...base.quote, calls: [{ ...base.quote.calls[0], data: new Uint8Array(base.quote.calls[0].data) }] };
  redirected.calls[0].data.set(ethers.getBytes(ethers.zeroPadValue(KERNEL_ACCOUNT_0, 32)), 4 + OFT_SEND_LAYOUT.to);
  check('MUTANT (recipient word not checked) is caught: a redirected recipient passes', run(m5, redirected) === null);
  check('…while the real module refuses it', run({ checkBridgeQuote }, redirected) instanceof BridgeRefusal);

  // 6. CCTP offered for sending.
  const m6 = await bridgeMutant(`[CCTP_V2_PROVIDER_ID]: 'coming',`, `[CCTP_V2_PROVIDER_ID]: 'offered',`);
  const r6 = await rejection(() => m6.quoteBridge(quoteRequest({ providerId: CCTP_V2_PROVIDER_ID, destinationChainId: BASE })));
  check('MUTANT (CCTP offered) is caught: the refusal is no longer the coming note', r6?.message !== CCTP_COMING_NOTE, r6?.message);
}

console.log(`\ncheck-bridge: ${passed} passed, ${failed} failed (${mutantCount} mutants)`);
process.exit(failed === 0 ? 0 : 1);

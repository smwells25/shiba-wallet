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
// the gate removed, the provider choice hidden, the recipient pin removed).
// Phase 23 item 4 (the app half): USDC through Circle CCTP V2 — the asset
// choice and the provider rows per asset, the CCTP quote re-checked word by
// word, the two-transaction regular path and the one-operation smart-account
// path through the real send paths, the confirm and prompts, Circle's
// sandbox attestation reader (the documented response shape), the tracking
// state machine from the chains' own events with fixtures synthesised from
// the live leg of 2026-10-25 (docs/BRIDGING.md section 17), the Mint
// button's conditions, the stored record (the attested message, version 1 kept)
// and its restart, and mutants for each.
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
  CCTP_DEPOSIT_FOR_BURN_SELECTOR,
  CCTP_RECEIVE_MESSAGE_SELECTOR,
  CCTP_V2_PROVIDER_ID,
  CCTP_V2_TESTNET,
  CCTP_V2_TESTNET_USDC,
  CCTP_V2_TRUST,
  KERNEL_V3_3,
  cctpTimeEstimate,
  createCctpV2Provider,
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
  BRIDGE_USDC_AMOUNT_PLACEHOLDER,
  CCTP_FIRST_MINT_PAYMASTER_NOTE,
  bridgeAmountPlaceholder,
  bridgeLinkShown,
  bridgeLiveStatusText,
  bridgeSwitchButtonTitle,
  bridgeSwitchSentence,
  bridgeSwitchTarget,
  cctpFirstMintPaymasterNote,
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
  BRIDGE_ASSETS,
  BRIDGE_LOG_TOO_OLD_CCTP,
  BRIDGE_NATIVE_SMART_RECIPIENT_REFUSAL,
  BRIDGE_PROVIDER_COMING_NOTE,
  CCTP_APP_LABEL,
  CCTP_BURN_WORD_OFFSETS,
  CIRCLE_IRIS_SANDBOX_API,
  bridgeAmountHint,
  bridgeApprovePromptTitle,
  bridgeAssetLabel,
  bridgeAssetSendableFrom,
  bridgeMintBlocker,
  bridgeMintCall,
  bridgeMintPromptTitle,
  bridgeNeedsApproval,
  cctpAttestedSentence,
  cctpBurnedSentence,
  cctpExpirySentence,
  cctpMintStepLine,
  cctpPinnedContractLine,
  cctpSmartAccountFeeNote,
  circleIrisReader,
  defaultBridgeAsset,
  exactAsset,
  prepareBridgeApprove,
  prepareBridgeMint,
  trackedPatch,
  usdcBalanceRefusal,
  usdcRecipientNote,
  usdcSmartRecipientUnavailable,
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
import { spokenShortAddress, withShortAddresses } from '../src/a11y.ts';

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
    usdc: new Map(), // holder (lower case) → USDC base units
    allowance: new Map(), // `${owner}|${spender}` (lower case) → base units
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
        // Circle's USDC and TokenMessengerV2 (phase 23 item 4): balanceOf, allowance, and the
        // pre-flight eth_call of an approve and a burn (the burn reverts while the allowance is short).
        const usdc = CCTP_V2_TESTNET_USDC[chainId];
        if (usdc && same(to, usdc) && data.startsWith('0x70a08231')) return word(s.usdc.get(('0x' + data.slice(34, 74)).toLowerCase()) ?? 0n);
        if (usdc && same(to, usdc) && data.startsWith('0xdd62ed3e')) {
          return word(s.allowance.get(`0x${data.slice(34, 74)}|0x${data.slice(98, 138)}`.toLowerCase()) ?? 0n);
        }
        if (usdc && same(to, usdc) && data.startsWith('0x095ea7b3')) return word(1n);
        if (same(to, CCTP_V2_TESTNET.tokenMessengerV2) && data.startsWith(CCTP_DEPOSIT_FOR_BURN_SELECTOR)) {
          const from = String(params[0].from ?? '').toLowerCase();
          const amount = BigInt('0x' + data.slice(10, 74));
          if ((s.allowance.get(`${from}|${CCTP_V2_TESTNET.tokenMessengerV2.toLowerCase()}`) ?? 0n) < amount) throw new Error('execution reverted: ERC20: transfer amount exceeds allowance');
          return '0x';
        }
        if (same(to, CCTP_V2_TESTNET.messageTransmitterV2) && data.startsWith(CCTP_RECEIVE_MESSAGE_SELECTOR)) return word(1n);
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
// Circle's sandbox attestation API (GET /v2/messages/{domain}?transactionHash=…), in the documented shape.
let irisAnswer = { status: 404 };
globalThis.fetch = async (url, init) => {
  fetchLog.push(String(url));
  if (String(url).startsWith(CIRCLE_IRIS_SANDBOX_API)) {
    const a = typeof irisAnswer === 'function' ? irisAnswer(String(url)) : irisAnswer;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: () => null }, json: async () => a.body };
  }
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
  const dests = (id, asset = 'native') => bridgeOfferFor(caip(id), asset).destinations.map((d) => `${d.chainId}:${d.sendable ? 'send' : 'list'}`).sort().join(',');
  check('test ETH: Ethereum Sepolia → Arbitrum Sepolia and OP Sepolia (no Base Sepolia: Stargate has no pool there)', dests(SEPOLIA) === [`${ARB}:send`, `${OP}:send`].sort().join(','), dests(SEPOLIA));
  check('test ETH: Arbitrum Sepolia → Ethereum Sepolia and OP Sepolia', dests(ARB) === [`${SEPOLIA}:send`, `${OP}:send`].sort().join(','), dests(ARB));
  check('test ETH: OP Sepolia → Ethereum Sepolia and Arbitrum Sepolia', dests(OP) === [`${SEPOLIA}:send`, `${ARB}:send`].sort().join(','), dests(OP));
  check('USDC: every CCTP network → the other three, all sendable (Circle CCTP, offered since phase 23)',
    [SEPOLIA, ARB, OP, BASE].every((id) => dests(id, 'usdc') === [SEPOLIA, ARB, OP, BASE].filter((x) => x !== id).map((x) => `${x}:send`).sort().join(',')),
    [SEPOLIA, ARB, OP, BASE].map((id) => dests(id, 'usdc')).join(' | '));
  const base = bridgeOfferFor(caip(BASE));
  check('Base Sepolia, test ETH: no destination; the sentence says why and points at USDC (exact)',
    base.destinations.length === 0 &&
      base.unavailable === 'No provider in this wallet can bridge test ETH from Base Sepolia: Stargate has no pool there. Choose USDC above to bridge USDC with Circle CCTP.', base.unavailable);
  check('Base Sepolia, USDC: nothing unavailable', bridgeOfferFor(caip(BASE), 'usdc').unavailable === null);
  const hoodi = bridgeOfferFor(caip(HOODI));
  check('Hoodi: no destination for either asset, "No bridge provider in this wallet serves Hoodi."',
    hoodi.destinations.length === 0 && hoodi.unavailable === 'No bridge provider in this wallet serves Hoodi.' &&
      bridgeOfferFor(caip(HOODI), 'usdc').unavailable === 'No bridge provider in this wallet serves Hoodi.', hoodi.unavailable);
  const sep = bridgeOfferFor(caip(SEPOLIA));
  check('Sepolia: nothing unavailable for either asset', sep.unavailable === null && bridgeOfferFor(caip(SEPOLIA), 'usdc').unavailable === null);
  check('the providers per asset: test ETH → LayerZero (offered); USDC → Circle CCTP (offered)',
    sep.providers.map((p) => `${p.id}:${p.status}`).join() === `${LAYERZERO_OFT_PROVIDER_ID}:offered` &&
      bridgeOfferFor(caip(SEPOLIA), 'usdc').providers.map((p) => `${p.id}:${p.status}`).join() === `${CCTP_V2_PROVIDER_ID}:offered` &&
      sep.providers[0].label === LAYERZERO_APP_LABEL && LAYERZERO_APP_LABEL === 'LayerZero (Stargate)' && CCTP_APP_LABEL === 'Circle CCTP (USDC)',
    sep.providers.map((p) => `${p.id}:${p.status}:${p.label}`).join());
  check('the trust statements are the engine’s, verbatim', sep.providers[0].trust === LAYERZERO_OFT_TRUST &&
    bridgeOfferFor(caip(SEPOLIA), 'usdc').providers[0].trust === CCTP_V2_TRUST &&
    BRIDGE_TRUST[LAYERZERO_OFT_PROVIDER_ID] === LAYERZERO_OFT_TRUST && BRIDGE_TRUST[CCTP_V2_PROVIDER_ID] === CCTP_V2_TRUST);
  check('BRIDGE_PROVIDER_STATUS: both providers offered for sending', Object.entries(BRIDGE_PROVIDER_STATUS).map(([k, v]) => `${k}:${v}`).sort().join() === [`${CCTP_V2_PROVIDER_ID}:offered`, `${LAYERZERO_OFT_PROVIDER_ID}:offered`].sort().join());
  check('the asset chips: test ETH then USDC; the labels (exact)', BRIDGE_ASSETS.join() === 'native,usdc' && bridgeAssetLabel('native', 'test ETH') === 'test ETH' && bridgeAssetLabel('usdc') === 'USDC');
  check('the form starts on test ETH where it can be sent, on USDC on Base Sepolia (the provider is still never chosen for the user)',
    defaultBridgeAsset(caip(SEPOLIA)) === 'native' && defaultBridgeAsset(caip(BASE)) === 'usdc' && defaultBridgeAsset(caip(HOODI)) === 'native' &&
      bridgeAssetSendableFrom(caip(BASE), 'usdc') && !bridgeAssetSendableFrom(caip(BASE), 'native') && !bridgeAssetSendableFrom(caip(HOODI), 'usdc'));
  check('CCTP’s trust statement (exact): 2 of 2 attesters, the roles held by addresses with no code, no refund, about 17 minutes',
    CCTP_V2_TRUST.verification === 'Circle verifies every transfer: both of Circle\'s two attesters must sign the burn (2 of 2, read on-chain) before USDC can be minted on the other network. Circle also issues USDC itself.' &&
      CCTP_V2_TRUST.control === 'Circle can pause transfers, refuse listed addresses (it checks the sending account and the transaction originator, which for a smart account is the bundler), and replace the contracts. On the test networks the roles that do this (the proxy admins, the owner, the denylister, the pauser and the attester manager) are held by addresses with no contract code.' &&
      CCTP_V2_TRUST.refundRule === 'There is no refund: the USDC is burned on the sending network. Circle attests the burn only after the sending network\'s hard finality (about 17 minutes in the measured runs); after that, anyone with gas on the receiving network can submit the mint to your address.');
  check('the offer makes no request (pure)', true);
}

// ---------------------------------------------------------------------------
console.log('check-bridge: the provider rows (the choice)');
// ---------------------------------------------------------------------------
{
  const offer = bridgeOfferFor(caip(SEPOLIA));
  const toOp = bridgeProviderRows(offer, OP);
  check('test ETH: only the provider that moves it is a row (LayerZero)', toOp.map((r) => r.id).join() === LAYERZERO_OFT_PROVIDER_ID);
  const lz = toOp[0];
  check('LayerZero row: selectable, moves test ETH, no note', lz.selectable && lz.asset === 'test ETH' && lz.note === null);
  const engineTime = oftTimeEstimate(pool(SEPOLIA), OP, pool(SEPOLIA).pathways[OP].confirmations);
  check('LayerZero row Sepolia → OP Sepolia: the measured line (exact)',
    lz.measured === 'Measured once on 2026-10-15: 90 s on this route, from the sending block to the delivery block.', lz.measured);
  check('…and the engine’s own time sentence, which ends "not a promise"', lz.timeSource === engineTime.source && /Not a promise/.test(lz.timeSource), lz.timeSource);
  const usdcOffer = bridgeOfferFor(caip(BASE), 'usdc');
  const toArbUsdc = bridgeProviderRows(usdcOffer, ARB);
  const cctp = toArbUsdc[0];
  check('USDC: only Circle CCTP is a row, selectable, moves USDC, no note', toArbUsdc.length === 1 && cctp.id === CCTP_V2_PROVIDER_ID && cctp.selectable && cctp.asset === 'USDC' && cctp.note === null);
  check('CCTP row Base Sepolia → Arbitrum Sepolia: the measured line (exact, 996 s) and the engine’s sentence',
    cctp.measured === 'Measured once on 2026-10-25: 996 s on this route, from the sending block to the delivery block.' && cctp.timeSource === cctpTimeEstimate(BASE, ARB).source &&
      /Not a promise/.test(cctp.timeSource), cctp.measured);
  check('CCTP row Ethereum Sepolia → Base Sepolia: 1,058 s; Arbitrum Sepolia → OP Sepolia: never measured',
    bridgeProviderRows(bridgeOfferFor(caip(SEPOLIA), 'usdc'), BASE)[0].measured === 'Measured once on 2026-10-25: 1058 s on this route, from the sending block to the delivery block.' &&
      bridgeProviderRows(bridgeOfferFor(caip(ARB), 'usdc'), OP)[0].measured === null && /This route was not measured\./.test(bridgeProviderRows(bridgeOfferFor(caip(ARB), 'usdc'), OP)[0].timeSource));
  const toArb = bridgeProviderRows(offer, ARB);
  check('Sepolia → Arbitrum Sepolia: never measured — no measured line; the engine says this route was not measured',
    toArb[0].measured === null && /This route was not measured\./.test(toArb[0].timeSource ?? ''), toArb[0].timeSource);
  check('a destination LayerZero does not serve (Sepolia → Base Sepolia, test ETH): listed, not selectable, the no-route sentence (exact)',
    !bridgeProviderRows(offer, BASE)[0].selectable && bridgeProviderRows(offer, BASE)[0].note === 'Does not serve Ethereum Sepolia → Base Sepolia in this wallet.' &&
      bridgeProviderRows(offer, BASE)[0].note === noRouteNote('Ethereum Sepolia', 'Base Sepolia'));
  check('measuredTimeLine is null without a measurement', measuredTimeLine({ minSeconds: null, maxSeconds: null, source: 'x' }) === null);
  check('a provider registered but not offered gets the comparison note (exact)', BRIDGE_PROVIDER_COMING_NOTE === 'Listed for comparison; not offered for sending in this version.');
  check('the screen copy: intro, choice note, records note, the USDC amount hint (exact)',
    BRIDGE_INTRO === 'Bridging moves test ETH or USDC from this network to another test network. A bridge provider carries the transfer, and you trust the provider’s contracts and verifiers while it is on its way, so each provider below says who that is. These are test networks: the coins have no value.' &&
      BRIDGE_CHOICE_NOTE === 'You choose the provider. The wallet lists every provider it knows for this asset and this pair of networks and never picks one for you.' &&
      BRIDGE_RECORDS_NOTE === 'Transfers sent from this screen are kept on this phone (the newest 64) and followed here whenever this screen is open. The sending transaction also appears in Activity.' &&
      bridgeAmountHint('usdc') === 'USDC has 6 decimal places; an amount with more is refused, not rounded.');
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
  const smartTo = await rejection(() => quoteBridge(quoteRequest({ recipient: KERNEL_ACCOUNT_0, recipientKind: 'smart-account' })));
  check('test ETH to the smart account: refused with the 2,300-gas sentence (exact), zero requests',
    smartTo instanceof BridgeRefusal && smartTo.message === BRIDGE_NATIVE_SMART_RECIPIENT_REFUSAL &&
      BRIDGE_NATIVE_SMART_RECIPIENT_REFUSAL === 'Test ETH is bridged only to your regular account: Stargate hands ETH over with a 2,300-gas transfer, which a deployed smart account cannot accept. Nothing was quoted.' &&
      fetchLog.length === 0, smartTo?.message);
  const unknownProvider = await rejection(() => quoteBridge(quoteRequest({ providerId: 'not-a-provider' })));
  check('a provider that is not offered: refused in plain words', unknownProvider instanceof BridgeRefusal && unknownProvider.message === 'This bridge provider is not offered in this wallet.');
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
  const otherProvider = clone(planA.quote);
  otherProvider.providerId = 'another-bridge';
  check('a quote from another provider is refused', why(refused(otherProvider)) === 'a provider this screen does not send through');
  const lzAsCctp = clone(planA.quote);
  lzAsCctp.providerId = CCTP_V2_PROVIDER_ID;
  check('a LayerZero quote presented as CCTP is refused by the CCTP checks (not this network’s USDC)', why(refused(lzAsCctp)) === 'an asset other than this network’s USDC', why(refused(lzAsCctp)));
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
    bridgeRetryBlocker(caip(SEPOLIA), cachedRec) === 'Anyone can send this delivery transaction on OP Sepolia, paying the gas there. To send it from this wallet, make OP Sepolia the active network with the button below (the same choice as Settings → Developer → Test network); this screen stays open and this transfer stays listed here.' &&
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
  check('a sent transfer is written at once: version 1, one record, bigints as decimal strings, no final status yet, no attested message',
    stored.version === 1 && stored.records[0].attested === null && stored.records.length === 1 && stored.records[0].id === rec.id && stored.records[0].amountIn === AMOUNT.toString() &&
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
  const mk = await bridgeMutant('  if (!isObject(value) || !(exactKeys(value, STORED_KEYS_WITH_ATTESTED) || exactKeys(value, STORED_KEYS))) return null;', '  if (!isObject(value)) return null;');
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
  check('the stored record of an unresolved smart-account transfer parses: version 1, the exact key set (19 keys, with the attested message), sourceTxHash null, the userOpHash kept',
    JSON.parse(storedBefore).version === 1 && !parsedBefore.readOnly && parsedBefore.records.length === 1 &&
      Object.keys(JSON.parse(storedBefore).records[0]).length === 19 && parsedBefore.records[0].sourceTxHash === null &&
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
  check('…and in the stored document, which still parses strictly: version 1, the same 19 keys, the hash, the operation, no final status yet',
    storedAfter.version === 1 && Object.keys(storedAfter.records[0]).length === 19 && storedAfter.records[0].sourceTxHash === SOURCE_TX &&
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
  check('the confirms (regular, the USDC approval step, smart account): the preview (eth_simulateV1; the smart account’s batch), the risk card, the spending notice and the pre-flight result',
    (screen.match(/<BalanceChangePreview\b/g) ?? []).length === 3 && (screen.match(/<RiskWarnings /g) ?? []).length === 3 && screen.includes('Pre-flight simulation passed (eth_call).') &&
      screen.includes('batch={aaQuote.calls.length > 1 ? aaQuote.calls.map((c) => ({ from: aaQuote.sender, to: c.to, value: c.value, data: c.data })) : undefined}'));
  check('the recipient: the regular account, or the smart account only when chosen for USDC on a verified network (both paths pass it with its kind)',
    screen.includes("const recipient = recipientKind === 'smart-account' && smartAddress !== null ? smartAddress : account.address;") &&
      (screen.match(/\n\s+recipient,\n\s+recipientKind,/g) ?? []).length === 2 &&
      screen.includes("const smartRecipientPossible = asset === 'usdc' && aaOffered && aaType === 'kernel-v3.3';") &&
      screen.includes('const smartRecipientOffered = smartRecipientPossible && destinationProfile?.kernelV33Verified === true;') &&
      screen.includes("const recipientKind: 'regular' | 'smart-account' = smartRecipientOffered && recipientPick === 'smart-account' ? 'smart-account' : 'regular';"));
  check('the USDC regular path: the allowance read, step 1 the exact approval with its own prompt, the burn quoted only once the allowance is in place',
    screen.includes('if (p.approval && (await bridgeNeedsApproval(evmHttpTransport(ep.url), p))) {') &&
      screen.includes('const auth = await requireLocalAuth(bridgeApprovePromptTitle(plan));') &&
      screen.indexOf('waitForAllowance(approveUrl, approval.token, account.address, approval.spender, approval.amount)') < screen.indexOf('const burn = await prepareBridgeSend(approveUrl, account.address, plan);') &&
      screen.indexOf('const burn = await prepareBridgeSend(approveUrl, account.address, plan);') > 0);
  check('the asset chips render every asset; changing the asset clears the destination, the provider and the recipient choice',
    screen.includes('{BRIDGE_ASSETS.map((a) => (') && /setAssetPick\(a\);\s*setDestination\(null\);\s*setProviderId\(null\);\s*setRecipientPick\('regular'\);/.test(screen));
  check('the Mint panel: shown for an attested CCTP transfer with no mint sent yet, its own prompt, prepareBridgeMint, and the blocker from bridgeMintBlocker',
    screen.includes('{bridgeMintCall(r) && !r.retryTxHash ? (') && screen.includes('requireLocalAuth(bridgeMintPromptTitle(record))') &&
      screen.includes('prepareBridgeMint(ep.url, fromAddress, record)') && screen.includes('const blocker = bridgeMintBlocker(activeCaip2, record, balance, symbol);') &&
      screen.includes('title={`Mint on ${record.destinationLabel}`}') && screen.includes('updateBridgeTransfer(record.id, { retryTxHash: sent.txid });'));
  check('tracking stores the status with trackedPatch (a CCTP transfer’s attested message kept for a restart)', screen.includes('updateBridgeTransfer(record.id, trackedPatch(record, status, Date.now()));'));
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
    home.includes("bridgeLinkShown(evmChain.caip2)\n            ? cardLink('bridge', 'Bridge', () => navigation.navigate('Bridge'), 'Opens bridging between test networks')") &&
      home.includes("import { bridgeLinkShown } from '../wallet/bridge';") && !home.includes('bridgeOfferFor('));
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
  // Phase 23 item 4: CCTP is offered and its row lists only for USDC; a
  // provider the wallet lists but does not offer is pinned with a synthetic
  // row (none is registered today).
  const cctp = { ...bridgeProviderRows(bridgeOfferFor(caip(BASE), 'usdc'), ARB)[0], selectable: false, note: BRIDGE_PROVIDER_COMING_NOTE };

  // (2) No provider is pre-selected, not even the only one that can be chosen.
  check('finding 2: nothing is chosen until the user taps a row (Sepolia → OP Sepolia, LayerZero the only selectable row)',
    rows.filter((r) => r.selectable).length === 1 && chosenBridgeProvider(rows, null) === null);
  check('…a tap on LayerZero chooses it; a provider that is not a row for this asset chooses nothing; a choice from another route is dropped',
    chosenBridgeProvider(rows, LAYERZERO_OFT_PROVIDER_ID) === LAYERZERO_OFT_PROVIDER_ID && chosenBridgeProvider(rows, CCTP_V2_PROVIDER_ID) === null &&
      chosenBridgeProvider(bridgeProviderRows(bridgeOfferFor(caip(SEPOLIA)), BASE), LAYERZERO_OFT_PROVIDER_ID) === null &&
      chosenBridgeProvider(bridgeProviderRows(bridgeOfferFor(caip(BASE), 'usdc'), ARB), CCTP_V2_PROVIDER_ID) === CCTP_V2_PROVIDER_ID &&
      chosenBridgeProvider(bridgeProviderRows(bridgeOfferFor(caip(BASE), 'usdc'), ARB), null) === null);
  check('…the single-provider sentence (exact) while nothing is chosen, none once chosen or when no row can be chosen',
    BRIDGE_SINGLE_PROVIDER_NOTE === 'One provider serves this route; choose it to continue.' &&
      bridgeProviderChoiceHint(rows, null) === BRIDGE_SINGLE_PROVIDER_NOTE && bridgeProviderChoiceHint(rows, LAYERZERO_OFT_PROVIDER_ID) === null &&
      bridgeProviderChoiceHint(bridgeProviderRows(bridgeOfferFor(caip(SEPOLIA)), BASE), null) === null &&
      bridgeProviderChoiceHint(bridgeProviderRows(bridgeOfferFor(caip(BASE), 'usdc'), ARB), null) === BRIDGE_SINGLE_PROVIDER_NOTE);
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
  const cctpRow = bridgeProviderRows(bridgeOfferFor(caip(BASE), 'usdc'), ARB)[0];
  const lzRow = rows.find((r) => r.id === LAYERZERO_OFT_PROVIDER_ID);
  const spoken = (r) => [r.note, `Who verifies: ${r.trust.verification}`, `Who controls: ${r.trust.control}`, `If it does not arrive: ${r.trust.refundRule}`, r.measured, r.timeSource].filter(Boolean);
  check('p21e finding B2b: the CCTP refund sentence is read exactly as written, ending in one period',
    `If it does not arrive: ${cctpRow.trust.refundRule}` ===
      'If it does not arrive: There is no refund: the USDC is burned on the sending network. Circle attests the burn only after the sending network\'s hard finality (about 17 minutes in the measured runs); after that, anyone with gas on the receiving network can submit the mint to your address.');
  check('p21e finding B2b: no provider-row sentence has a doubled period or ends without one',
    [...spoken(cctpRow), ...spoken(lzRow)].every((t) => !/\.\./.test(t) && /[.)]$/.test(t.trim())), [...spoken(cctpRow), ...spoken(lzRow)].filter((t) => /\.\./.test(t) || !/[.)]$/.test(t.trim())).join(' | '));

  // (4) Each phase opens at the top: one ScrollView key per view.
  const keys = [...screen.matchAll(/<ScrollView key="(bridge-[a-z-]+)"/g)].map((m) => m[1]);
  check('finding 4: the form, both confirms and the success view each have their own ScrollView key, so a new view never inherits the form’s scroll position (React reuses a native view only for the same key and type)',
    JSON.stringify(keys.sort()) === JSON.stringify(['bridge-aa-confirm', 'bridge-approve', 'bridge-confirm', 'bridge-form', 'bridge-success']), keys.join());
  const keyless = screen.replace('<ScrollView key="bridge-confirm" ', '<ScrollView ');
  check('MUTANT (the confirm without its key) is caught', [...keyless.matchAll(/<ScrollView key="(bridge-[a-z-]+)"/g)].length !== 5);

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

  // (7) No chips and no amount where no provider can send the chosen asset.
  check('finding 7: the destination chips and the amount field are shown on Ethereum Sepolia, hidden for test ETH on Base Sepolia and on Hoodi (nothing can be sent), shown for USDC on Base Sepolia',
    bridgeFormInputsShown(sep) && !bridgeFormInputsShown(bridgeOfferFor(caip(BASE))) && !bridgeFormInputsShown(bridgeOfferFor(caip(HOODI))) &&
      bridgeFormInputsShown(bridgeOfferFor(caip(BASE), 'usdc')));
  const inputsGated = (src) =>
    src.includes('{inputsShown && offer.destinations.length > 0 ? (') && /\{inputsShown \? \(\s*<>\s*<Text \{\.\.\.amountField\.label\}/.test(src) &&
    src.includes('const inputsShown = offer !== null && bridgeFormInputsShown(offer);') && src.includes('{offer.unavailable ? <WarningBox>{offer.unavailable}</WarningBox> : null}');
  check('…the screen gates the chips and the amount on it; the explanatory sentence stays (source)', inputsGated(screen));
  check('MUTANT (the amount field shown regardless) is caught', !inputsGated(screen.replace('{inputsShown ? (\n        <>\n          <Text {...amountField.label}', '{true ? (\n        <>\n          <Text {...amountField.label}')));

  // (7, leftover) Where a provider is listed but no destination can be sent
  // to from this network, a row's reason names only the source network. No
  // registered provider is in that state today (both are offered; a network
  // with no route lists no destination), so a synthetic offer pins it.
  const noSendOffer = { ...bridgeOfferFor(caip(SEPOLIA)), unavailable: 'No provider in this wallet can bridge test ETH from Ethereum Sepolia yet.' };
  const lzNotes = [OP, ARB, BASE].map((d) => bridgeProviderRows(noSendOffer, d)[0].note);
  check('finding 7 leftover: with the chips hidden, a row that cannot serve says only "Does not serve Ethereum Sepolia in this wallet." (exact)',
    lzNotes[2] === 'Does not serve Ethereum Sepolia in this wallet.' && noSourceRouteNote('Base Sepolia') === 'Does not serve Base Sepolia in this wallet.' &&
      lzNotes.every((n) => !/→/.test(n ?? '')), lzNotes.join(' | '));
  const sepToBase = bridgeProviderRows(bridgeOfferFor(caip(SEPOLIA)), BASE);
  check('…where the chips are shown (Ethereum Sepolia), the destination variant stays: "Does not serve Ethereum Sepolia → Base Sepolia in this wallet." (exact)',
    sepToBase[0].note === 'Does not serve Ethereum Sepolia → Base Sepolia in this wallet.', sepToBase[0].note);
  const m7b = await bridgeMutant(
    "const noRoute = bridgeFormInputsShown(offer) ? noRouteNote(offer.sourceLabel, destinationLabel) : noSourceRouteNote(offer.sourceLabel);",
    'const noRoute = noRouteNote(offer.sourceLabel, destinationLabel);',
  );
  const mNote = m7b.bridgeProviderRows({ ...m7b.bridgeOfferFor(caip(SEPOLIA)), unavailable: 'x' }, BASE)[0].note;
  check('MUTANT (the destination sentence where the chips are hidden) is caught', mNote !== 'Does not serve Ethereum Sepolia in this wallet.', mNote);

  // (7, the choice-note leftover; phase 22 polish) The note under "Choose a
  // provider" spoke of "this pair of networks" where no pair can be chosen.
  const SEP_NO_PAIR = 'The wallet lists every provider it knows, each with the reason it cannot send from Ethereum Sepolia, and never picks one for you.';
  check('choice note: Ethereum Sepolia (chips shown) keeps "…for this asset and this pair of networks…" (exact)',
    bridgeChoiceNote(sep, bridgeProviderRows(sep, OP).length) === BRIDGE_CHOICE_NOTE);
  check('choice note: with the chips hidden it names only the source network and no pair (exact)',
    bridgeChoiceNote(noSendOffer, 1) === SEP_NO_PAIR && !/pair of networks/.test(SEP_NO_PAIR), bridgeChoiceNote(noSendOffer, 1));
  const hoodiOffer = bridgeOfferFor(caip(HOODI));
  check('choice note: none where no provider row is listed (Hoodi; Base Sepolia for test ETH: no destination, no rows; the warning above says why)',
    hoodiOffer.destinations.length === 0 && bridgeChoiceNote(hoodiOffer, 0) === null && hoodiOffer.unavailable === 'No bridge provider in this wallet serves Hoodi.' &&
      bridgeChoiceNote(bridgeOfferFor(caip(BASE)), 0) === null);
  const choiceNoteWired = (src) =>
    src.includes('const choiceNote = offer !== null ? bridgeChoiceNote(offer, rows.length) : null;') &&
    /\{choiceNote \? \(\s*<>\s*<Text accessibilityRole="header" style=\{\[styles\.label, \{ color: theme\.textMuted \}\]\}>Choose a provider<\/Text>\s*<Text style=\{\[styles\.hint, \{ color: theme\.textMuted \}\]\}>\{choiceNote\}<\/Text>/.test(src) &
    !src.includes('{BRIDGE_CHOICE_NOTE}');
  check('…the screen shows "Choose a provider" and that note only when there is one (source)', choiceNoteWired(screen));
  check('MUTANT (the screen showing the pair sentence everywhere) is caught',
    !choiceNoteWired(screen.replace('<Text style={[styles.hint, { color: theme.textMuted }]}>{choiceNote}</Text>', '<Text style={[styles.hint, { color: theme.textMuted }]}>{BRIDGE_CHOICE_NOTE}</Text>')));
  const m7c = await bridgeMutant('  if (bridgeFormInputsShown(offer)) return BRIDGE_CHOICE_NOTE;', '  return BRIDGE_CHOICE_NOTE;');
  check('MUTANT (the pair sentence where no pair can be chosen) is caught', m7c.bridgeChoiceNote(noSendOffer, 1) !== SEP_NO_PAIR);

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
    BRIDGE_AMOUNT_PLACEHOLDER === 'Amount, for example 0.0002' && screen.includes('placeholder={bridgeAmountPlaceholder(asset)}') && !screen.includes('placeholder="0.0002"') &&
      screen.includes('Stargate moves {symbol} in steps of 0.000001; an amount with more decimal places is refused, not rounded.'));
}

// ---------------------------------------------------------------------------
console.log('check-bridge: USDC through Circle CCTP V2 — the quote, the wallet’s own checks, the confirm and the send paths (phase 23 item 4)');
// ---------------------------------------------------------------------------
// Fixtures from the live leg of 2026-10-25 (docs/BRIDGING.md section 17, leg
// 1: Base Sepolia → Arbitrum Sepolia, 1 USDC): the burn block, Circle's
// nonce, the mint transaction; the attestation is a stand-in of the live
// length (130 bytes: two 65-byte signatures), since MessageTransmitterV2,
// not the wallet, verifies the signatures. The burn transaction hash is the
// live one; the test owner (the public test mnemonic) stands in for the dev
// EOA, so every address-dependent byte differs from the live message.
const USDC_AMOUNT = 1_000_000n;
const CCTP_NONCE = '0x4ebf0adf94bbd5a7a92f1bbbd05cba6b5d7641f4c71cda1afe15f1aa24e3fc79';
const BURN_TX = '0x847e641f6f038bf78f22881ff2186e0b453f18f24eb543556e8fda1db84e67a7';
const MINT_TX = '0x425891cf15b9bb3df0bb52f1972bcc0b8cfc767db0a104ece758c20db9d96ddb';
const BURN_BLOCK = 50_079_573n;
const ATTESTATION = '0x' + '5a'.repeat(130);
const TM = CCTP_V2_TESTNET.tokenMessengerV2;
const MT = CCTP_V2_TESTNET.messageTransmitterV2;
const cctpIface = new ethers.Interface([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
  'function approve(address spender, uint256 amount)',
  'function receiveMessage(bytes message, bytes attestation)',
  'event MessageSent(bytes message)',
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
  'event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)',
]);
const u32 = (n) => ethers.toBeHex(n, 4);
const pad = (a) => ethers.zeroPadValue(a, 32);
/** MessageV2 ‖ BurnMessageV2 (Circle's technical guide, "Message body"). */
function cctpMessage(over = {}) {
  const o = { nonce: ethers.ZeroHash, finality: 0, recipient: EOA, amount: USDC_AMOUNT, feeExecuted: 0n, expiration: 0n, src: 6, dst: 3, token: CCTP_V2_TESTNET_USDC[BASE], ...over };
  return ethers
    .concat([
      u32(1), u32(o.src), u32(o.dst), o.nonce, pad(TM), pad(TM), ethers.ZeroHash, u32(2000), u32(o.finality),
      u32(1), pad(o.token), pad(o.recipient), word(o.amount), pad(EOA), word(0n), word(o.feeExecuted), word(o.expiration),
    ])
    .toLowerCase();
}
const SENT_MSG = cctpMessage();
const ATTESTED_MSG = cctpMessage({ nonce: CCTP_NONCE, finality: 2000 });
const cctpLog = (address, name, args, extra = {}) => logOfIface(cctpIface, address, name, args, extra);
function logOfIface(iface, address, name, args, extra) {
  const e = iface.encodeEventLog(name, args);
  return { address, data: e.data, topics: [...e.topics], ...extra };
}
const burnReceiptLogs = (recipient = EOA) => [
  cctpLog(MT, 'MessageSent', [cctpMessage({ recipient })], { blockNumber: ethers.toQuantity(BURN_BLOCK), transactionHash: BURN_TX }),
  cctpLog(TM, 'DepositForBurn', [CCTP_V2_TESTNET_USDC[BASE], USDC_AMOUNT, EOA, pad(recipient), 3, pad(TM), ethers.ZeroHash, 0n, 2000, '0x'], { blockNumber: ethers.toQuantity(BURN_BLOCK), transactionHash: BURN_TX }),
];
/** Circle's GET /v2/messages answer, in the documented MessagesV2Response shape (complete). */
const irisComplete = (message = ATTESTED_MSG, attestation = ATTESTATION) => ({
  status: 200,
  body: {
    messages: [
      {
        message,
        eventNonce: CCTP_NONCE,
        attestation,
        decodedMessage: { sourceDomain: '6', destinationDomain: '3', nonce: CCTP_NONCE, sender: TM, recipient: TM, destinationCaller: ethers.ZeroAddress, minFinalityThreshold: '2000', finalityThresholdExecuted: '2000' },
        cctpVersion: 2,
        status: 'complete',
        delayReason: null,
      },
    ],
    sourceTxHash: BURN_TX,
  },
});
/** …and while Circle waits for finality (as cctp-smoke.mjs saw it: message "0x", attestation "PENDING"). */
const irisPending = { status: 200, body: { messages: [{ message: '0x', eventNonce: CCTP_NONCE, attestation: 'PENDING', decodedMessage: null, cctpVersion: 2, status: 'pending_confirmations', delayReason: null }], sourceTxHash: BURN_TX } };
function cctpRequest(over = {}) {
  return {
    caip2: caip(BASE),
    destinationChainId: ARB,
    providerId: CCTP_V2_PROVIDER_ID,
    amount: USDC_AMOUNT,
    sender: EOA,
    senderKind: 'regular',
    recipient: EOA,
    nativeSymbol: 'test ETH',
    readers: readersFor(BASE),
    ...over,
  };
}
const fundUsdc = (chainId, holder, amount) => chains.get(chainId).usdc.set(holder.toLowerCase(), amount);
let planU;
{
  resetChains();
  fundUsdc(BASE, EOA, 5_000_000n);
  chains.get(ARB).head = 322_726_000n;
  fetchLog = [];
  planU = await quoteBridge(cctpRequest());
  const engine = createCctpV2Provider();
  const route = engine.supportedRoutes().find((r) => r.sourceChainId === BASE && r.destinationChainId === ARB);
  const eq = await engine.quote({ route, amount: USDC_AMOUNT, sender: EOA, recipient: EOA, nativeSymbol: 'test ETH' });
  check('the plan’s two calls are the engine’s, byte for byte (the exact approval, then the burn)',
    planU.calls.length === 2 && planU.calls.every((c, i) => same(c.to, eq.calls[i].to) && c.value === eq.calls[i].value && toHex(c.data) === toHex(eq.calls[i].data)) &&
      same(planU.call.to, eq.calls[1].to) && toHex(planU.call.data) === toHex(eq.calls[1].data));
  const approveArgs = cctpIface.decodeFunctionData('approve', toHex(planU.calls[0].data));
  check('decoded with ethers: approve(Circle’s TokenMessengerV2, exactly 1,000,000) on Base Sepolia USDC, value 0',
    same(planU.calls[0].to, CCTP_V2_TESTNET_USDC[BASE]) && same(approveArgs[0], TM) && approveArgs[1] === USDC_AMOUNT && planU.calls[0].value === 0n);
  const burnArgs = cctpIface.decodeFunctionData('depositForBurn', toHex(planU.call.data));
  check('decoded with ethers: depositForBurn(1,000,000, domain 3, the regular account, USDC, caller 0, maxFee 0, finality 2000) to TokenMessengerV2, value 0',
    same(planU.call.to, TM) && planU.call.value === 0n && burnArgs[0] === USDC_AMOUNT && Number(burnArgs[1]) === 3 && same(ethers.dataSlice(burnArgs[2], 12), EOA) &&
      same(burnArgs[3], CCTP_V2_TESTNET_USDC[BASE]) && burnArgs[4] === ethers.ZeroHash && burnArgs[5] === 0n && Number(burnArgs[6]) === 2000);
  check('the plan: asset USDC, the regular recipient, the exact approval, no messaging fee, the receiving head, the measured time (996 s)',
    planU.asset === 'usdc' && planU.recipientKind === 'regular' && planU.messagingFee === 0n && planU.destinationFromBlock === 322_726_000n &&
      planU.approval && same(planU.approval.token, CCTP_V2_TESTNET_USDC[BASE]) && same(planU.approval.spender, TM) && planU.approval.amount === USDC_AMOUNT &&
      planU.quote.time.measured?.seconds === 996);
  check('the sender’s USDC balance was read on the sending network before quoting (balanceOf on Base Sepolia USDC)',
    chains.get(BASE).calls.some((c) => c.method === 'eth_call' && same(c.params[0].to, CCTP_V2_TESTNET_USDC[BASE]) && c.params[0].data.startsWith('0x70a08231')));

  // The wallet's own checks, word by word.
  const expectU = { sourceChainId: BASE, destinationChainId: ARB, amount: USDC_AMOUNT, recipient: EOA, sender: EOA };
  const cloneU = (q) => ({ ...q, calls: q.calls.map((c) => ({ ...c, data: new Uint8Array(c.data), pins: c.pins.map((p) => ({ ...p, rule: { ...p.rule, params: [...p.rule.params] } })), unpinnable: [...c.unpinnable] })), approvals: q.approvals.map((a) => ({ ...a })), fees: q.fees.map((f) => ({ ...f })) });
  const refusedU = (q) => {
    try {
      checkBridgeQuote(q, expectU);
      return null;
    } catch (e) {
      return e;
    }
  };
  const whyU = (e) => (e instanceof BridgeRefusal ? (/\((.*)\)\. Nothing was signed\.$/.exec(e.message)?.[1] ?? e.message) : String(e));
  check('the untouched CCTP quote passes', refusedU(cloneU(planU.quote)) === null);
  check('the seven burn words are checked at their offsets (exact table)',
    JSON.stringify(CCTP_BURN_WORD_OFFSETS) === JSON.stringify({ amount: 0, destinationDomain: 32, mintRecipient: 64, burnToken: 96, destinationCaller: 128, maxFee: 160, minFinalityThreshold: 192 }));
  const wordTampered = Object.entries(CCTP_BURN_WORD_OFFSETS).filter(([, offset]) => {
    const q = cloneU(planU.quote);
    q.calls[1].data[4 + offset + 31] ^= 0x01;
    return whyU(refusedU(q)) !== `the word at byte ${offset} of the burn`;
  });
  check('each of the seven words, changed by one bit, is refused naming its byte', wordTampered.length === 0, wordTampered.map(([k]) => k).join());
  const pinTampered = Object.entries(CCTP_BURN_WORD_OFFSETS).filter(([, offset]) => {
    const q = cloneU(planU.quote);
    const pin = q.calls[1].pins.find((p) => p.rule.offset === offset);
    pin.rule.params[0] = '0x' + 'ff'.repeat(32);
    return whyU(refusedU(q)) !== `the pin at byte ${offset} of the burn`;
  });
  check('each of the seven pins, changed, is refused naming its byte', pinTampered.length === 0, pinTampered.map(([k]) => k).join());
  const redirectedBurn = cloneU(planU.quote);
  redirectedBurn.calls[1].data.set(ethers.getBytes(pad(KERNEL_ACCOUNT_0)), 4 + 64);
  check('another recipient in the burn is refused', whyU(refusedU(redirectedBurn)) === 'the word at byte 64 of the burn');
  const fast = cloneU(planU.quote);
  fast.calls[1].data.set(ethers.getBytes(word(1000n)), 4 + 192);
  check('finality 1000 (Fast) in the burn is refused', whyU(refusedU(fast)) === 'the word at byte 192 of the burn');
  const otherSpender = cloneU(planU.quote);
  otherSpender.calls[0].data = ethers.getBytes(cctpIface.encodeFunctionData('approve', [KERNEL_ACCOUNT_0, USDC_AMOUNT]));
  check('an approval for another spender is refused', whyU(refusedU(otherSpender)) === 'an approval for another spender than Circle’s TokenMessengerV2', whyU(refusedU(otherSpender)));
  const shortApproval = cloneU(planU.quote);
  shortApproval.calls[0].data = ethers.getBytes(cctpIface.encodeFunctionData('approve', [TM, USDC_AMOUNT - 1n]));
  shortApproval.approvals[0].amount = USDC_AMOUNT - 1n;
  check('an approval one unit short of the amount is refused', whyU(refusedU(shortApproval)) === 'an approval that is not exactly the amount', whyU(refusedU(shortApproval)));
  const otherToken = cloneU(planU.quote);
  otherToken.calls[0].to = CCTP_V2_TESTNET_USDC[ARB];
  otherToken.approvals[0].token = CCTP_V2_TESTNET_USDC[ARB];
  check('an approval on another token is refused', whyU(refusedU(otherToken)) === 'an approval on another token than USDC', whyU(refusedU(otherToken)));
  const unlimitedU = cloneU(planU.quote);
  unlimitedU.calls[0].data = ethers.getBytes(cctpIface.encodeFunctionData('approve', [TM, ethers.MaxUint256]));
  check('an unlimited approval is refused as not exact', whyU(refusedU(unlimitedU)) === 'an approval that is not exact');
  const valuedBurn = cloneU(planU.quote);
  valuedBurn.calls[1].value = 1n;
  check('a burn that carries a value is refused', whyU(refusedU(valuedBurn)) === 'a burn that carries a value');
  const otherContract = cloneU(planU.quote);
  otherContract.calls[1].to = MT;
  check('a burn to another contract than Circle’s pinned TokenMessengerV2 is refused', whyU(refusedU(otherContract)) === 'a contract other than Circle’s pinned TokenMessengerV2');
  const feeU = cloneU(planU.quote);
  feeU.fees[0].amount = 1n;
  check('a Circle fee that is not zero is refused', whyU(refusedU(feeU)) === 'a Circle fee that is not zero');
  const lessU = cloneU(planU.quote);
  lessU.minAmountOut = USDC_AMOUNT - 1n;
  check('an arrival other than the amount is refused', whyU(refusedU(lessU)) === 'an arrival other than the amount');
  const threeCalls = cloneU(planU.quote);
  threeCalls.calls.unshift({ ...threeCalls.calls[0] });
  check('a third call is refused', whyU(refusedU(threeCalls)) === 'not exactly the approval and the burn', whyU(refusedU(threeCalls)));
  const longBurn = cloneU(planU.quote);
  longBurn.calls[1].data = new Uint8Array([...longBurn.calls[1].data, 0]);
  check('a burn that is not exactly seven words is refused', whyU(refusedU(longBurn)) === 'a burn that is not exactly seven words');

  // Refusals before anything is signed.
  fetchLog = [];
  const over = await rejection(() => quoteBridge(cctpRequest({ amount: 6_000_000n })));
  check('more USDC than the sender holds: refused with both exact figures (exact), before any quote',
    over instanceof BridgeRefusal && over.message === 'You hold 5 USDC on Base Sepolia, and this transfer needs 6 USDC. Nothing was quoted.' &&
      over.message === usdcBalanceRefusal(5_000_000n, 6_000_000n, 'Base Sepolia'), over?.message);
  const zero = await rejection(() => quoteBridge(cctpRequest({ amount: 0n })));
  check('an amount of 0 (below one base unit): refused (exact)', zero instanceof BridgeRefusal && zero.message === 'Enter an amount greater than zero.', zero?.message);
  const toHoodi = await rejection(() => quoteBridge(cctpRequest({ destinationChainId: HOODI })));
  check('a route CCTP does not serve (Base Sepolia → Hoodi): the no-route sentence (exact)', toHoodi instanceof BridgeRefusal && toHoodi.message === 'Does not serve Base Sepolia → Hoodi in this wallet.', toHoodi?.message);
  const fromHoodi = await rejection(() => quoteBridge(cctpRequest({ caip2: caip(HOODI), readers: readersFor(HOODI) })));
  check('…and from Hoodi (exact)', fromHoodi instanceof BridgeRefusal && fromHoodi.message === 'Does not serve Hoodi → Arbitrum Sepolia in this wallet.', fromHoodi?.message);
  const mainnetU = await rejection(() => quoteBridge(cctpRequest({ caip2: 'eip155:1', readers: readersFor(1) })));
  check('USDC on mainnet: refused by the readiness gate first', mainnetU?.name === 'FeatureNotAllowedError');

  // The confirm, worded for CCTP.
  const m = bridgeConfirmModel(planU);
  check('CCTP prompt titles (exact): the bridge and the exact approval',
    bridgePromptTitle(planU) === 'Bridge 1 USDC to Arbitrum Sepolia through Circle CCTP (USDC)' && m.title === bridgePromptTitle(planU) &&
      bridgeApprovePromptTitle(planU) === 'Approve exactly 1 USDC for Circle’s TokenMessengerV2', `${bridgePromptTitle(planU)} | ${bridgeApprovePromptTitle(planU)}`);
  check('you send / arrives / minimum / fee / total (exact)',
    m.youSend === 'You send 1 USDC from Base Sepolia' && m.arrives === 'Expected to arrive on Arbitrum Sepolia: 1 USDC' &&
      m.minimum === 'Least that may arrive (written into the call as a maximum fee of 0): 1 USDC' &&
      m.feeLines.length === 1 && m.feeLines[0].label === 'Circle protocol fee (Standard Transfer)' && m.feeLines[0].value === '0 USDC' &&
      m.total === '1 USDC (amount 1 + Circle fee 0), before the network fees in test ETH', JSON.stringify(m, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 600));
  check('the two calls in plain words, and two prompts for the regular account (exact)',
    m.callLines.join('\n') === [
      `1. approve on USDC (${CCTP_V2_TESTNET_USDC[BASE]}): allows Circle’s TokenMessengerV2 ${TM} to take exactly 1 USDC.`,
      `2. depositForBurn on Circle’s TokenMessengerV2 (${TM}): burns 1 USDC on Base Sepolia for minting on Arbitrum Sepolia.`,
      'Two transactions, each with its own device prompt: first the approval, then, once it is confirmed, the burn.',
    ].join('\n'), m.callLines.join('\n'));
  check('the exact-approval line (exact)',
    m.approvalLine === `Exact approval only: this allows Circle’s TokenMessengerV2 (${TM}) to take exactly 1 USDC (1000000 base units) of USDC (${CCTP_V2_TESTNET_USDC[BASE]}), nothing more; the burn uses all of it, so nothing stays approved.`, m.approvalLine);
  check('the seven pinned words in plain words (exact)',
    m.pinnedSummary.join('\n') === [
      'Receiving network: Arbitrum Sepolia (CCTP domain 3).',
      `Recipient: ${EOA} (your regular account).`,
      'Amount: 1 USDC (1000000 base units), burned here and minted there.',
      `Burn token: USDC ${CCTP_V2_TESTNET_USDC[BASE]} on Base Sepolia.`,
      'Destination caller: none (zero), so anyone may send the mint; it still goes only to the recipient above.',
      'Maximum fee 0 and finality 2000: a Standard Transfer, which Circle attests after the sending network’s hard finality. This wallet never builds a Fast Transfer.',
      'All seven words of the call are fixed (7 pins), and before showing this screen the wallet re-read each of them from the call itself.',
    ].join('\n'), m.pinnedSummary.join('\n'));
  check('the pinned-contract line (exact)',
    m.pinnedPool === cctpPinnedContractLine(TM, 'Base Sepolia') &&
      m.pinnedPool === `The burn goes to Circle’s TokenMessengerV2 on Base Sepolia (${TM}), pinned by this wallet from Circle’s published test-network addresses and checked on-chain on 2026-10-25. The risk card below names it too.`);
  check('the recipient line, the mint step and the time lines (exact)',
    m.recipientLines.join() === usdcRecipientNote('regular', EOA, 'Arbitrum Sepolia') &&
      usdcRecipientNote('regular', EOA, 'Arbitrum Sepolia') === `The USDC is minted to your regular account ${EOA} on Arbitrum Sepolia, the same address as on this network.` &&
      m.destinationStep === `${planU.quote.destination.description} ${cctpMintStepLine('Arbitrum Sepolia')}` &&
      cctpMintStepLine('Arbitrum Sepolia') === 'After Circle’s attestation (about 17 minutes in the measured runs) the USDC is minted on Arbitrum Sepolia by a transaction there. This wallet can send it from your regular account when Arbitrum Sepolia is the active network and that account holds test ETH there for gas; anyone else with gas there may send it too, and the USDC still goes only to the recipient written into the burn.' &&
      m.timeLines.length === 2 && m.timeLines[0] === 'Measured once on 2026-10-25: 996 s on this route, from the sending block to the delivery block.' && m.timeLines[1] === cctpTimeEstimate(BASE, ARB).source,
    `${m.destinationStep} | ${m.timeLines.join(' | ')}`);
  check('the smart-account recipient sentences (exact): the address, the form’s variant, the 2,300-gas difference from LayerZero, the unverified network',
    usdcRecipientNote('smart-account', KERNEL_ACCOUNT_0, 'Arbitrum Sepolia') === `The USDC is minted to your smart account ${KERNEL_ACCOUNT_0} on Arbitrum Sepolia, the same address as on this network. It does not need to be deployed there: CCTP mints USDC with an ordinary token mint, which needs no code at the recipient, unlike Stargate’s 2,300-gas ETH transfer.` &&
      usdcRecipientNote('smart-account', null, 'Arbitrum Sepolia') === 'The USDC is minted to your smart account on Arbitrum Sepolia, the same address as on this network (shown when you review). It does not need to be deployed there: CCTP mints USDC with an ordinary token mint, which needs no code at the recipient, unlike Stargate’s 2,300-gas ETH transfer.' &&
      usdcSmartRecipientUnavailable('Hoodi') === 'Your smart account cannot be chosen as the recipient on Hoodi: the wallet has not verified the smart-account contracts there, so it cannot say the address is the same. Your regular account receives.');

  // The regular account: step 1 the exact approval, step 2 the burn once the allowance is in place.
  const base = httpTransport(ACTIVE_URL(BASE));
  check('the allowance is read: an approval is needed while it is below the amount', (await bridgeNeedsApproval(base, planU)) === true);
  const qa = await prepareBridgeApprove(ACTIVE_URL(BASE), EOA, planU);
  check('step 1 through prepareEvmSend: to USDC, value 0, data = the exact approve, pre-flight passed',
    same(qa.to, CCTP_V2_TESTNET_USDC[BASE]) && qa.amount === 0n && toHex(qa.data) === toHex(planU.calls[0].data) && qa.simulation.ok);
  const early = await prepareBridgeSend(ACTIVE_URL(BASE), EOA, planU);
  check('the burn before the approval is confirmed: its pre-flight fails (nothing is sent)', early.simulation.ok === false, JSON.stringify(early.simulation));
  const sentApprove = await sendEvm(ACTIVE_URL(BASE), owner, qa, null);
  const rawApprove = ethers.Transaction.from(chains.get(BASE).raw.at(-1));
  check('the signed approval: to USDC, value 0, the exact approve calldata, chain id Base Sepolia', same(rawApprove.to, CCTP_V2_TESTNET_USDC[BASE]) && rawApprove.value === 0n && rawApprove.data === toHex(planU.calls[0].data) && rawApprove.chainId === BigInt(BASE) && same(sentApprove.txid, ethers.keccak256(chains.get(BASE).raw.at(-1))));
  chains.get(BASE).allowance.set(`${EOA.toLowerCase()}|${TM.toLowerCase()}`, USDC_AMOUNT);
  check('once the allowance equals the amount, no approval is needed', (await bridgeNeedsApproval(base, planU)) === false);
  const qb = await prepareBridgeSend(ACTIVE_URL(BASE), EOA, planU);
  check('step 2: the burn through prepareEvmSend: to TokenMessengerV2, value 0, the burn calldata, pre-flight passed',
    same(qb.to, TM) && qb.amount === 0n && toHex(qb.data) === toHex(planU.call.data) && qb.simulation.ok);
  await sendEvm(ACTIVE_URL(BASE), owner, qb, null);
  const rawBurn = ethers.Transaction.from(chains.get(BASE).raw.at(-1));
  check('the signed burn: to TokenMessengerV2, value 0, the engine’s calldata, from the account', same(rawBurn.to, TM) && rawBurn.value === 0n && rawBurn.data === toHex(planU.call.data) && same(rawBurn.from, EOA));
  check('a LayerZero plan has no approval step', (await rejection(() => prepareBridgeApprove(ACTIVE_URL(SEPOLIA), EOA, planA)))?.message === 'This transfer needs no token approval.' && (await bridgeNeedsApproval(base, planA)) === false);

  // The smart account: ONE operation carrying both calls; USDC may go to the smart account.
  const kernelConfig = {
    bundlerUrl: 'https://bundler.example', bundlerVerifiedAt: 'x', accountType: 'kernel-v3.3', factory: KERNEL_V3_3.factory,
    factoryImplementation: KERNEL_V3_3.implementation, kernelMetaFactory: KERNEL_V3_3.metaFactory, kernelValidator: KERNEL_V3_3.ecdsaValidator,
    kernelAccountId: KERNEL_V3_3.accountId, factoryVerifiedAt: 'x', paymasterUrl: null, paymasterContext: null, paymasterVerifiedAt: null,
    chain: caip(BASE), eip7702Owners: [], recoveredAccounts: [], bundlerUrlIgnoredReason: null, paymasterUrlIgnoredReason: null,
  };
  const kernel = fakeKernelNode({ chainIdHex: ethers.toQuantity(BASE), balance: E18, tokenBalances: { [`${CCTP_V2_TESTNET_USDC[BASE].toLowerCase()}|${KERNEL_ACCOUNT_0.toLowerCase()}`]: 5_000_000n } });
  const bundler = fakeBundler();
  const bundle = createAaClientFromConfig(kernelConfig, {
    nodeUrl: 'https://node.example', chainId: BigInt(BASE), accountIndex: 0, ownerAddress: OWNER_0,
    transportFor: (u) => (u === 'https://node.example' ? kernel : bundler),
  });
  fundUsdc(BASE, KERNEL_ACCOUNT_0, 5_000_000n);
  const aaPlan = await quoteBridge(cctpRequest({ sender: KERNEL_ACCOUNT_0, senderKind: 'smart-account', recipient: KERNEL_ACCOUNT_0, recipientKind: 'smart-account' }));
  const aaBurn = cctpIface.decodeFunctionData('depositForBurn', toHex(aaPlan.call.data));
  check('USDC to the smart account: the burn’s recipient word is the smart account', same(ethers.dataSlice(aaBurn[2], 12), KERNEL_ACCOUNT_0) && aaPlan.recipientKind === 'smart-account');
  const aq = await prepareBridgeAa(bundle, OWNER_0, aaPlan);
  check('prepareAaCalls: TWO calls (the approval, then the burn), value 0, the smart account as sender, its USDC checked',
    aq.calls.length === 2 && same(aq.calls[0].to, CCTP_V2_TESTNET_USDC[BASE]) && same(aq.calls[1].to, TM) && aq.amount === 0n && same(aq.sender, KERNEL_ACCOUNT_0) && aq.tokenSpend?.amount === USDC_AMOUNT);
  await sendAa(bundle, owner, aq, { kind: 'bridge' });
  const execU = decodeKernelExecute(bundler.lastOp.callData);
  check('the submitted UserOperation executes exactly the approval and the burn, in order, as one batch',
    execU.calls.length === 2 && same(execU.calls[0].to, CCTP_V2_TESTNET_USDC[BASE]) && execU.calls[0].data === toHex(aaPlan.calls[0].data) &&
      same(execU.calls[1].to, TM) && execU.calls[1].data === toHex(aaPlan.call.data) && execU.calls.every((c) => c.value === 0n));
  const am = bridgeConfirmModel(aaPlan);
  check('the smart-account confirm: one prompt, the fee in test ETH and no USDC-fee paymaster (exact), the smart-account recipient sentence',
    bridgePromptTitle(aaPlan) === 'Bridge 1 USDC to Arbitrum Sepolia through Circle CCTP (USDC) from your smart account' &&
      am.callLines[2] === 'One smart-account operation carries both calls, all or nothing, so there is one device prompt.' &&
      am.notes.includes(cctpSmartAccountFeeNote('test ETH')) &&
      cctpSmartAccountFeeNote('test ETH') === 'The network fee is paid in test ETH from the smart account. Paying it in USDC through Circle’s paymaster is not offered for bridging in this version.' &&
      am.recipientLines[0] === usdcRecipientNote('smart-account', KERNEL_ACCOUNT_0, 'Arbitrum Sepolia'));
  const aaOver = await rejection(() => prepareBridgeAa(bundle, OWNER_0, { ...aaPlan, calls: [aaPlan.calls[1]] }));
  check('an operation that would not carry exactly the plan’s calls is refused', aaOver instanceof BridgeRefusal && aaOver.message === 'The operation would not carry the quoted calls and value. Nothing was signed.', aaOver?.message);
}

// ---------------------------------------------------------------------------
console.log('check-bridge: CCTP tracking — burned, attested, the Mint button, delivered, and a restart');
// ---------------------------------------------------------------------------
{
  const memStore = (initial = {}) => {
    const map = new Map(Object.entries(initial));
    return { map, getItem: async (k) => (map.has(k) ? map.get(k) : null), setItem: async (k, v) => void map.set(k, v), removeItem: async (k) => void map.delete(k) };
  };
  resetChains();
  await resetBridgeTransfers();
  fundUsdc(BASE, EOA, 5_000_000n);
  chains.get(ARB).head = 322_726_000n;
  const plan = await quoteBridge(cctpRequest());
  const store = memStore();
  await loadBridgeTransfers(store);
  let rec = recordBridgeTransfer(plan, { sourceTxHash: BURN_TX, userOpHash: null, sentAt: 1_792_000_000_000 });
  const readers = readersFor(BASE);
  const findRec = () => listBridgeTransfers().find((r) => r.id === rec.id);
  const step = async () => {
    const st = await trackBridgeTransfer(findRec(), readers);
    updateBridgeTransfer(rec.id, trackedPatch(findRec(), st, 1_792_000_100_000));
    await bridgeTransfersWritten();
    return st;
  };
  irisAnswer = { status: 404 };
  // 1. No receipt yet.
  let st = await step();
  check('no receipt yet → "Not known yet" with the engine’s sentence (exact)',
    st.state === 'unknown' && bridgeStatusHeading(st, 'Arbitrum Sepolia', CCTP_V2_PROVIDER_ID) === 'Not known yet' &&
      bridgeStatusSentence(findRec()) === 'The burn transaction has no receipt yet; it may still be pending.', bridgeStatusSentence(findRec()));
  // 2. Burned; Circle has nothing yet (404), then pending_confirmations.
  chains.get(BASE).receipts.set(BURN_TX, { status: '0x1', logs: burnReceiptLogs() });
  fetchLog = [];
  st = await step();
  check('burned, Iris 404 → "Waiting for Circle’s attestation" and the burned sentence with the block (exact)',
    st.state === 'in-flight' && st.onChain?.sourceBlock === BURN_BLOCK && bridgeStatusHeading(st, 'Arbitrum Sepolia', CCTP_V2_PROVIDER_ID) === 'Waiting for Circle’s attestation' &&
      bridgeStatusSentence(findRec()) === 'Burned on Base Sepolia (block 50079573). Waiting for Circle’s attestation: it comes after the source chain’s hard finality, about 17 minutes in the measured runs.' &&
      bridgeStatusSentence(findRec()) === cctpBurnedSentence('Base Sepolia', BURN_BLOCK), bridgeStatusSentence(findRec()));
  check('Circle was asked at the sandbox host, by source domain 6 and the burn hash', fetchLog.includes(`${CIRCLE_IRIS_SANDBOX_API}/v2/messages/6?transactionHash=${BURN_TX}`) && CIRCLE_IRIS_SANDBOX_API === 'https://iris-api-sandbox.circle.com');
  check('nothing is searched on the receiving network before the attestation', chains.get(ARB).calls.filter((c) => c.method === 'eth_getLogs').length === 0);
  irisAnswer = irisPending;
  st = await step();
  check('Iris "pending_confirmations" (message "0x", attestation "PENDING", as documented) → still waiting', st.state === 'in-flight' && bridgeMintCall(findRec()) === null);
  // 3. Attested: the mint call.
  irisAnswer = irisComplete();
  st = await step();
  check('attested → "Attested: waiting for the mint on Arbitrum Sepolia" and the attested sentence (exact)',
    st.state === 'awaiting-destination-action' && st.onChain?.status === 'attested' && st.onChain.guid === CCTP_NONCE &&
      bridgeStatusHeading(st, 'Arbitrum Sepolia', CCTP_V2_PROVIDER_ID) === 'Attested: waiting for the mint on Arbitrum Sepolia' &&
      bridgeStatusSentence(findRec()) === 'Attested. The USDC can now be minted on Arbitrum Sepolia.' && cctpAttestedSentence('Arbitrum Sepolia') === bridgeStatusSentence(findRec()),
    `${st.state} ${st.detail}`);
  const arbLogs = chains.get(ARB).calls.filter((c) => c.method === 'eth_getLogs');
  check('the receiving network was searched for MessageReceived by the nonce, from the head recorded at quote time',
    arbLogs.length >= 1 && same(arbLogs[0].params[0].address, MT) && arbLogs[0].params[0].topics[2] === CCTP_NONCE && BigInt(arbLogs[0].params[0].fromBlock) === 322_726_000n);
  check('the record keeps the checked attested message (trackedPatch)', findRec().attested?.nonce === CCTP_NONCE && findRec().attested.message === ATTESTED_MSG && findRec().attested.expirationBlock === 0n);
  const stored = JSON.parse(store.map.get(BRIDGE_TRANSFERS_KEY)).records[0];
  check('…and stores it (still version 1, one more key): message, attestation, nonce, expiration block as a decimal string; no final status',
    JSON.stringify(stored.attested) === JSON.stringify({ message: ATTESTED_MSG, attestation: ATTESTATION, nonce: CCTP_NONCE, expirationBlock: '0' }) && stored.final === null);
  const mint = bridgeMintCall(findRec());
  check('the Mint call: receiveMessage(attested message, attestation) to Circle’s MessageTransmitterV2, value 0 (ethers agrees)',
    mint && same(mint.to, MT) && mint.value === 0n && toHex(mint.data) === cctpIface.encodeFunctionData('receiveMessage', [ATTESTED_MSG, ATTESTATION]));
  check('…no Stargate retry is offered for it', bridgeRetryCall(findRec()) === null);
  // The Mint button's conditions.
  const expiry0 = cctpExpirySentence(findRec().attested, 'Arbitrum Sepolia');
  check('expiry, from Circle’s documents (exact): block 0 stays valid; a set block names it (on Arbitrum an Ethereum block); none read yet',
    expiry0 === 'The attested message carries no expiration block (0), so it stays valid until the mint is sent: Circle’s contract accepts such a message at any time, and only once.' &&
      cctpExpirySentence({ expirationBlock: 9_876_543n }, 'Arbitrum Sepolia') === 'The attested message expires after block 9876543 (on Arbitrum an Ethereum block number, as Circle’s guide notes). After that Circle’s contract refuses it until Circle re-attests it, which Circle’s technical guide says can be requested at any time; this wallet does not request it.' &&
      cctpExpirySentence({ expirationBlock: 9_876_543n }, 'Base Sepolia') === 'The attested message expires after block 9876543. After that Circle’s contract refuses it until Circle re-attests it, which Circle’s technical guide says can be requested at any time; this wallet does not request it.' &&
      cctpExpirySentence(null, 'Base Sepolia') === 'Circle’s attested message is valid until it is used, unless it carries an expiration block: Circle’s technical guide says an expired message must be re-attested by Circle (possible at any time) before it can be minted.');
  check('Mint from another active network: the switch sentence, that anyone can send it, and the expiry (exact)',
    bridgeMintBlocker(caip(BASE), findRec(), null) === `Anyone with test ETH on Arbitrum Sepolia can send this mint transaction, and the USDC still goes only to ${EOA}. ${expiry0} To send it from this wallet, make Arbitrum Sepolia the active network with the button below (the same choice as Settings → Developer → Test network); this screen stays open and this transfer stays listed here.`,
    bridgeMintBlocker(caip(BASE), findRec(), null));
  check('Mint on the receiving network with no coin there: the sentence (exact); with some coin, or not read yet: offered',
    bridgeMintBlocker(caip(ARB), findRec(), 0n) === `Your regular account holds no test ETH on Arbitrum Sepolia to pay for the mint transaction. Anyone with test ETH there can send it, and the USDC still goes only to ${EOA}. ${expiry0}` &&
      bridgeMintBlocker(caip(ARB), findRec(), 1n) === null && bridgeMintBlocker(caip(ARB), findRec(), null) === null);
  check('the Mint prompt (exact)', bridgeMintPromptTitle(findRec()) === 'Mint the bridged USDC on Arbitrum Sepolia');
  const mq = await prepareBridgeMint(ACTIVE_URL(ARB), EOA, findRec());
  check('the Mint quote through prepareEvmSend on the receiving network: to MessageTransmitterV2, value 0, the mint calldata, pre-flight passed',
    same(mq.to, MT) && mq.amount === 0n && toHex(mq.data) === toHex(mint.data) && mq.simulation.ok);
  const forgedMint = { ...findRec(), status: { ...findRec().status, destinationCalls: [{ ...mint, to: TM }] } };
  const otherData = { ...findRec(), status: { ...findRec().status, destinationCalls: [{ ...mint, data: ethers.getBytes(cctpIface.encodeFunctionData('receiveMessage', [ATTESTED_MSG, '0x' + '00'.repeat(130)])) }] } };
  check('a mint call to another contract, or not exactly the checked attested message, is not offered', bridgeMintCall(forgedMint) === null && bridgeMintCall(otherData) === null);
  check('no mint call for a LayerZero transfer, and none to send → refused in plain words',
    bridgeMintCall({ ...findRec(), providerId: LAYERZERO_OFT_PROVIDER_ID }) === null &&
      (await rejection(() => prepareBridgeMint(ACTIVE_URL(ARB), EOA, { ...findRec(), status: null })))?.message === 'There is no mint transaction to send for this transfer.');
  // Pass p23-cctp (TalkBack): an idle poll must not re-announce the status.
  // A simulated live region announces whenever the text it is given differs
  // from the last one (Android's live regions speak a content change).
  const liveSim = () => {
    let last = null;
    let announcements = 0;
    return {
      set(text) {
        if (last !== null && text !== last) announcements += 1;
        last = text;
      },
      get announcements() {
        return announcements;
      },
    };
  };
  const waiting = { ...findRec(), status: { state: 'in-flight', detail: 'x', onChain: { status: 'in-flight' } } };
  const snapshots = [waiting, { ...waiting, checkedAt: 1 }];
  for (let tick = 1; tick <= 3; tick += 1) {
    const stIdle = await trackBridgeTransfer(findRec(), readers);
    updateBridgeTransfer(rec.id, trackedPatch(findRec(), stIdle, 1_792_000_100_000 + tick * BRIDGE_TRACK_INTERVAL_MS));
    await bridgeTransfersWritten();
    snapshots.push(findRec());
  }
  const sim = liveSim();
  for (const r of snapshots) sim.set(bridgeLiveStatusText(r));
  check('pass p23-cctp (fake ticks): three idle polls after the attestation change the check time but not the live-region text; the one status change is announced once',
    new Set(snapshots.slice(2).map((r) => r.checkedAt)).size === 3 && sim.announcements === 1 &&
      bridgeLiveStatusText(waiting) === 'Waiting for Circle’s attestation' && bridgeLiveStatusText(findRec()) === 'Attested: waiting for the mint on Arbitrum Sepolia',
    `${sim.announcements} announcements`);
  const mLive = await bridgeMutant(
    '  return bridgeStatusHeading(record.status, record.destinationLabel, record.providerId);\n}',
    '  return `${bridgeStatusHeading(record.status, record.destinationLabel, record.providerId)} (checked ${(record as { checkedAt?: number }).checkedAt})`;\n}',
  );
  const simM = liveSim();
  for (const r of snapshots) simM.set(mLive.bridgeLiveStatusText(r));
  check('MUTANT (the live-region text changes on every poll) is caught: it would be announced on each idle tick', simM.announcements > 1, `${simM.announcements}`);

  // 4. A restart: the stored attested message is used without asking Circle.
  await resetBridgeTransfers();
  await loadBridgeTransfers(store);
  rec = listBridgeTransfers()[0];
  check('after a restart the record comes back with its attested message', rec.attested?.nonce === CCTP_NONCE && rec.status === null);
  let irisCalls = 0;
  irisAnswer = () => {
    irisCalls += 1;
    return { status: 500 };
  };
  st = await step();
  check('…tracking continues from it with no request to Circle: attested again, the Mint call rebuilt', irisCalls === 0 && st.state === 'awaiting-destination-action' && bridgeMintCall(findRec()) !== null);
  // A stored message that no longer matches the burn: Circle is asked instead.
  updateBridgeTransfer(rec.id, { attested: { ...findRec().attested, message: cctpMessage({ nonce: CCTP_NONCE, finality: 2000, recipient: KERNEL_ACCOUNT_0 }) } });
  irisAnswer = () => {
    irisCalls += 1;
    return irisComplete();
  };
  st = await step();
  check('a stored attested message that does not match the burn is dropped and Circle asked again (one request)', irisCalls === 1 && st.state === 'awaiting-destination-action' && findRec().attested.message === ATTESTED_MSG);
  // 5. Minted (by this wallet or anyone): delivered from the chain's own events.
  updateBridgeTransfer(rec.id, { retryTxHash: MINT_TX });
  chains.get(ARB).head = 322_727_000n;
  chains.get(ARB).logs.push(
    cctpLog(MT, 'MessageReceived', [EOA, 6, CCTP_NONCE, pad(TM), 2000, '0x'], { transactionHash: MINT_TX, blockNumber: ethers.toQuantity(322_726_898n) }),
    cctpLog(TM, 'MintAndWithdraw', [EOA, USDC_AMOUNT, CCTP_V2_TESTNET_USDC[ARB], 0n], { transactionHash: MINT_TX, blockNumber: ethers.toQuantity(322_726_898n) }),
  );
  st = await step();
  check('minted → "Delivered on Arbitrum Sepolia", the mint transaction, the engine’s sentence (exact), final',
    st.state === 'delivered' && st.destinationTxHash === MINT_TX && bridgeStatusHeading(st, 'Arbitrum Sepolia', CCTP_V2_PROVIDER_ID) === 'Delivered on Arbitrum Sepolia' &&
      bridgeStatusSentence(findRec()) === `Delivered: the receiving network shows MessageReceived for this transfer's message (nonce ${CCTP_NONCE}) and MintAndWithdraw of ${USDC_AMOUNT} base units of USDC to ${EOA} in transaction ${MINT_TX}.` &&
      bridgeTransferFinal(findRec()) && bridgeMintCall(findRec()) === null, bridgeStatusSentence(findRec()));
  const storedFinal = JSON.parse(store.map.get(BRIDGE_TRANSFERS_KEY)).records[0];
  check('the delivered status is stored with the mint transaction, and the mint sent from this screen is kept', storedFinal.final?.state === 'delivered' && storedFinal.final.destinationTxHash === MINT_TX && storedFinal.retryTxHash === MINT_TX);
  check('the CCTP log-age sentence (exact)', BRIDGE_LOG_TOO_OLD_CCTP === 'This transfer was sent too long ago for the wallet to search the receiving network for its mint; look up the recipient on that network in an explorer. If the USDC was never minted, anyone can still send the mint with Circle’s attested message.');

  // 6. The stored record: strict, the attested message one more key, and a record written before it still read.
  const v2 = bridgeRecordToStored(findRec());
  const back = bridgeRecordFromStored(v2);
  check('a CCTP record round-trips with its attested message', back && back.attested?.nonce === CCTP_NONCE && back.attested.expirationBlock === 0n && back.attested.message === ATTESTED_MSG && back.route.sourceAsset.kind === 'erc20');
  const strictU = {
    'an attested message on a LayerZero record': { providerId: LAYERZERO_OFT_PROVIDER_ID, route: { ...v2.route, providerId: LAYERZERO_OFT_PROVIDER_ID } },
    'a nonce that is not the message’s': { attested: { ...v2.attested, nonce: '0x' + '42'.repeat(32) } },
    'an attestation that is not whole 65-byte signatures': { attested: { ...v2.attested, attestation: '0x' + '5a'.repeat(129) } },
    'an expiration block that is not the message’s': { attested: { ...v2.attested, expirationBlock: '7' } },
    'an extra key in the attested message': { attested: { ...v2.attested, extra: 1 } },
    'upper-case hex in the message': { attested: { ...v2.attested, message: v2.attested.message.toUpperCase().replace('0X', '0x') } },
    'the attested key left undefined (neither key set)': { attested: undefined },
  };
  const loose = Object.entries(strictU).filter(([, patch]) => bridgeRecordFromStored({ ...v2, ...patch }) !== null);
  check(`the attested field is parsed strictly: ${Object.keys(strictU).length} damaged forms each refused`, loose.length === 0, loose.map(([k]) => k).join());
  const legacyRecord = { ...v2, final: null };
  delete legacyRecord.attested;
  const legacy = parseBridgeTransfers(JSON.stringify({ version: 1, records: [legacyRecord] }));
  check('a record written before the attested message (the 18 keys) still loads, writable, with no attested message', !legacy.readOnly && legacy.records.length === 1 && legacy.records[0].attested === null);
  check('…a document version other than 1 is read-only', parseBridgeTransfers(JSON.stringify({ version: 2, records: [legacyRecord] })).readOnly);
  const legacyStore = memStore({ [BRIDGE_TRANSFERS_KEY]: JSON.stringify({ version: 1, records: [{ ...legacyRecord, id: 'bridge-1-9' }] }) });
  await resetBridgeTransfers();
  await loadBridgeTransfers(legacyStore);
  recordBridgeTransfer(plan, { sourceTxHash: BURN_TX, userOpHash: null, sentAt: 1_792_000_200_000 });
  await bridgeTransfersWritten();
  const migrated = JSON.parse(legacyStore.map.get(BRIDGE_TRANSFERS_KEY));
  check('…and the next write keeps version 1 and writes every record with the attested key (the old one with null)', migrated.version === 1 && migrated.records.length === 2 && migrated.records.every((r) => 'attested' in r) && migrated.records.some((r) => r.id === 'bridge-1-9' && r.attested === null));
  await resetBridgeTransfers();

  // 7. The Iris reader on its own.
  const iris = circleIrisReader();
  irisAnswer = { status: 404 };
  check('Iris reader: 404 → pending', (await iris({ sourceDomain: 6, sourceTxHash: BURN_TX })).status === 'pending');
  irisAnswer = { status: 200, body: { messages: [], sourceTxHash: BURN_TX } };
  check('Iris reader: no message yet → pending', (await iris({ sourceDomain: 6, sourceTxHash: BURN_TX })).status === 'pending');
  irisAnswer = irisComplete();
  const done = await iris({ sourceDomain: 6, sourceTxHash: BURN_TX });
  check('Iris reader: complete → the message and attestation, verbatim', done.status === 'complete' && done.message === ATTESTED_MSG && done.attestation === ATTESTATION);
  irisAnswer = irisComplete(ATTESTED_MSG, 'PENDING');
  check('Iris reader: "complete" with the attestation still "PENDING" → pending', (await iris({ sourceDomain: 6, sourceTxHash: BURN_TX })).status === 'pending');
  irisAnswer = { status: 200, body: { messages: [irisComplete().body.messages[0], irisComplete().body.messages[0]], sourceTxHash: BURN_TX } };
  check('Iris reader: two messages for one burn → refused, the wallet does not pick one', /returned 2 messages for one burn; the wallet does not pick one\./.test((await rejection(() => iris({ sourceDomain: 6, sourceTxHash: BURN_TX })))?.message ?? ''));
  irisAnswer = { status: 200, body: { ...irisComplete().body, sourceTxHash: MINT_TX } };
  check('Iris reader: an answer for another transaction → refused', (await rejection(() => iris({ sourceDomain: 6, sourceTxHash: BURN_TX })))?.message === 'Circle’s attestation service answered for another transaction.');
  irisAnswer = { status: 500 };
  check('Iris reader: HTTP 500 → an error', (await rejection(() => iris({ sourceDomain: 6, sourceTxHash: BURN_TX })))?.message === 'Circle’s attestation service answered HTTP 500');
  fetchLog = [];
  check('Iris reader: a malformed hash is refused before any request', /32 bytes of hex/.test((await rejection(() => iris({ sourceDomain: 6, sourceTxHash: '0x12' })))?.message ?? '') && fetchLog.length === 0);
  irisAnswer = { status: 404 };
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

  // 4. The asset filter removed from the rows: a provider that does not move the asset would be listed.
  const m4 = await bridgeMutant(
    `  return registry
    .list()
    .filter((p) => providerMoves(p, offer.asset))
    .map((p) => {`,
    `  return registry
    .list()
    .map((p) => {`,
  );
  const rows4 = m4.bridgeProviderRows(m4.bridgeOfferFor(caip(BASE), 'usdc'), ARB);
  check('MUTANT (the asset filter removed) is caught: the USDC rows list LayerZero too', rows4.length !== 1, rows4.map((r) => r.id).join());

  // 5. The recipient word not checked.
  const m5 = await bridgeMutant('[OFT_SEND_LAYOUT.to, addressToBytes32(expect.recipient).toLowerCase()],', '');
  const redirected = { ...base.quote, calls: [{ ...base.quote.calls[0], data: new Uint8Array(base.quote.calls[0].data) }] };
  redirected.calls[0].data.set(ethers.getBytes(ethers.zeroPadValue(KERNEL_ACCOUNT_0, 32)), 4 + OFT_SEND_LAYOUT.to);
  check('MUTANT (recipient word not checked) is caught: a redirected recipient passes', run(m5, redirected) === null);
  check('…while the real module refuses it', run({ checkBridgeQuote }, redirected) instanceof BridgeRefusal);

  // 6. CCTP taken off the offer: a USDC quote is refused.
  const m6 = await bridgeMutant(`[CCTP_V2_PROVIDER_ID]: 'offered',`, `[CCTP_V2_PROVIDER_ID]: 'coming',`);
  resetChains();
  fundUsdc(BASE, EOA, 5_000_000n);
  const r6 = await rejection(() => m6.quoteBridge(cctpRequest()));
  check('MUTANT (CCTP not offered) is caught: a USDC quote is refused', r6 instanceof Error && r6.message === 'This bridge provider is not offered in this wallet.', r6?.message);
  const realU = await quoteBridge(cctpRequest());
  const runU = (mod, q) => {
    try {
      mod.checkBridgeQuote(q, { sourceChainId: BASE, destinationChainId: ARB, amount: USDC_AMOUNT, recipient: EOA, sender: EOA });
      return null;
    } catch (e) {
      return e;
    }
  };
  const burnWith = (offset, bytes) => {
    const calls = realU.quote.calls.map((c) => ({ ...c, data: new Uint8Array(c.data) }));
    calls[1].data.set(ethers.getBytes(bytes), 4 + offset);
    return { ...realU.quote, calls };
  };
  // 7–9. One burn word no longer re-read: the recipient, the maximum fee, the finality.
  for (const [name, entry, offset, bytes] of [
    ['mintRecipient', '[O.mintRecipient, addressToBytes32(expect.recipient).toLowerCase()],', 64, pad(KERNEL_ACCOUNT_0)],
    ['maxFee', '[O.maxFee, uintWord(0)],', 160, word(1n)],
    ['minFinalityThreshold', '[O.minFinalityThreshold, uintWord(CCTP_FINALITY_STANDARD)],', 192, word(1000n)],
  ]) {
    const mm = await bridgeMutant(entry, '');
    const tampered = burnWith(offset, bytes);
    check(`MUTANT (the burn’s ${name} word not re-read) is caught: the tampered burn passes`, runU(mm, tampered) === null);
    check(`…while the real module refuses it (${name})`, runU({ checkBridgeQuote }, tampered) instanceof BridgeRefusal);
  }
  // 10. The approval's spender not checked.
  const m10 = await bridgeMutant("  if (approveHex.slice(10, 74) !== addressToBytes32(tm).toLowerCase().slice(2)) fail('an approval for another spender than Circle’s TokenMessengerV2');", '');
  const spender = { ...realU.quote, calls: [{ ...realU.quote.calls[0], data: ethers.getBytes(cctpIface.encodeFunctionData('approve', [KERNEL_ACCOUNT_0, USDC_AMOUNT])) }, realU.quote.calls[1]] };
  check('MUTANT (the approval’s spender not checked) is caught: an approval for another spender passes', runU(m10, spender) === null && runU({ checkBridgeQuote }, spender) instanceof BridgeRefusal);
  // 11. A Circle fee accepted.
  const m11 = await bridgeMutant("fail('a Circle fee that is not zero');", '{}');
  const feeQ = { ...realU.quote, fees: [{ ...realU.quote.fees[0], amount: 1n }] };
  check('MUTANT (a non-zero Circle fee accepted) is caught', runU(m11, feeQ) === null && runU({ checkBridgeQuote }, feeQ) instanceof BridgeRefusal);
  // 12. The balance check removed.
  const m12 = await bridgeMutant('    if (request.amount > balance) throw new BridgeRefusal(usdcBalanceRefusal(balance, request.amount, labelOfChain(sourceChainId)));', '');
  const r12 = await rejection(() => m12.quoteBridge(cctpRequest({ amount: 6_000_000n })));
  check('MUTANT (the USDC balance check removed) is caught: a quote above the balance is not refused with the balance sentence', r12?.message !== usdcBalanceRefusal(5_000_000n, 6_000_000n, 'Base Sepolia'), r12?.message);
  // 13. trackedPatch forgetting the attested message.
  const m13 = await bridgeMutant('attested: status.attestation ?? record.attested', 'attested: record.attested');
  const fakeAtt = { message: ATTESTED_MSG, attestation: ATTESTATION, nonce: CCTP_NONCE, expirationBlock: 0n };
  check('MUTANT (the attested message not kept) is caught', m13.trackedPatch({ attested: null }, { state: 'awaiting-destination-action', detail: 'x', attestation: fakeAtt }, 1).attested === null &&
    trackedPatch({ attested: null }, { state: 'awaiting-destination-action', detail: 'x', attestation: fakeAtt }, 1).attested === fakeAtt);
  // 14. The mint call not matched to the checked attested message.
  const m14 = await bridgeMutant(
    '  if (!attested || toHex(call.data).toLowerCase() !== toHex(encodeReceiveMessage(attested.message, attested.attestation)).toLowerCase()) return null;',
    '',
  );
  const mintStatus = (data) => ({
    providerId: CCTP_V2_PROVIDER_ID,
    attested: fakeAtt,
    status: { state: 'awaiting-destination-action', detail: 'x', onChain: { status: 'attested' }, destinationCalls: [{ to: MT, value: 0n, data: ethers.getBytes(data) }] },
  });
  const forged = mintStatus(cctpIface.encodeFunctionData('receiveMessage', [ATTESTED_MSG, '0x' + '00'.repeat(130)]));
  check('MUTANT (the mint call not matched to the attested message) is caught', m14.bridgeMintCall(forged) !== null && bridgeMintCall(forged) === null);
  // 15. The Mint offered from another network.
  const m15 = await bridgeMutant('  if (activeCaip2 !== record.destinationCaip2) {\n    return (\n      `Anyone with', '  if (false) {\n    return (\n      `Anyone with');
  const recLike = { destinationCaip2: caip(ARB), destinationLabel: 'Arbitrum Sepolia', recipient: EOA, attested: fakeAtt };
  check('MUTANT (the Mint offered while another network is active) is caught', m15.bridgeMintBlocker(caip(BASE), recLike, 1n) === null && bridgeMintBlocker(caip(BASE), recLike, 1n) !== null);
  // 16. Records written before the attested message no longer read.
  const m16 = await bridgeMutant('!(exactKeys(value, STORED_KEYS_WITH_ATTESTED) || exactKeys(value, STORED_KEYS))', '!exactKeys(value, STORED_KEYS_WITH_ATTESTED)');
  const oldRec = bridgeRecordToStored(recordBridgeTransfer(realU, { sourceTxHash: BURN_TX, userOpHash: null, sentAt: 1_792_000_300_000 }));
  delete oldRec.attested;
  const oldDoc = JSON.stringify({ version: 1, records: [oldRec] });
  check('MUTANT (a record without the attested key refused) is caught: a list written before becomes read-only', m16.parseBridgeTransfers(oldDoc).readOnly === true && parseBridgeTransfers(oldDoc).readOnly === false);
  await resetBridgeTransfers();
  // 17. Test ETH to the smart account no longer refused.
  const m17 = await bridgeMutant("  if (asset === 'native' && recipientKind !== 'regular') throw new BridgeRefusal(BRIDGE_NATIVE_SMART_RECIPIENT_REFUSAL);", '');
  const r17 = await rejection(() => m17.quoteBridge(quoteRequest({ recipient: KERNEL_ACCOUNT_0, recipientKind: 'smart-account' })));
  check('MUTANT (test ETH to the smart account allowed) is caught', r17?.message !== BRIDGE_NATIVE_SMART_RECIPIENT_REFUSAL, r17?.message);
  for (const mod of [m6, m10, m11, m12, m13, m14, m15, m16, m17]) await mod.resetBridgeTransfers();
}

// ---------------------------------------------------------------------------
console.log('check-bridge: the emulator pass p23-cctp findings (the Home link, the network switch, the USDC placeholder, the paymaster sentence, the live region, short addresses)');
// ---------------------------------------------------------------------------
{
  resetChains();
  await resetBridgeTransfers();
  const screen = source('src/screens/BridgeScreen.tsx');
  const views = source('src/screens/BridgeViews.tsx');
  const appSrc = source('App.tsx');
  const settings = source('src/screens/SettingsScreen.tsx');

  // (1) The Home link: any asset with a destination, not test ETH alone.
  fetchLog = [];
  check('finding 1: the Bridge link shows on Ethereum, Arbitrum, OP and Base Sepolia',
    [SEPOLIA, ARB, OP, BASE].every((id) => bridgeLinkShown(caip(id))));
  check('…on Base Sepolia because USDC has destinations there although test ETH has none (no Stargate pool)',
    bridgeOfferFor(caip(BASE)).destinations.length === 0 && bridgeOfferFor(caip(BASE), 'usdc').destinations.length === 3);
  const lineaMain = {
    ...EVM_SEPOLIA, caip2: 'eip155:59144', chainIdDecimal: '59144', label: 'Linea', testnet: false, kernelV33Verified: false,
    custom: { rpcUrl: 'https://rpc.linea.example', nativeSymbol: 'ETH', explorerBase: null, blockTimeMs: null, testnetRequested: false },
  };
  const lineaTest = {
    ...EVM_SEPOLIA, caip2: 'eip155:59141', chainIdDecimal: '59141', label: 'Linea Sepolia', testnet: true, kernelV33Verified: false,
    custom: { rpcUrl: 'https://rpc.linea-sepolia.example', nativeSymbol: 'ETH', explorerBase: null, blockTimeMs: null, testnetRequested: true },
  };
  setCustomEvmProfiles([lineaMain, lineaTest]);
  check('…hidden, as before, on Hoodi, on mainnet, on a custom main network and on a custom test network, with no request',
    !bridgeLinkShown(caip(HOODI)) && !bridgeLinkShown('eip155:1') && !bridgeLinkShown('eip155:59144') && !bridgeLinkShown('eip155:59141') && fetchLog.length === 0);
  setCustomEvmProfiles([]);
  check('…and the Bridge screen opens on USDC on Base Sepolia (test ETH elsewhere)',
    defaultBridgeAsset(caip(BASE)) === 'usdc' && defaultBridgeAsset(caip(SEPOLIA)) === 'native' && defaultBridgeAsset(caip(ARB)) === 'native' && defaultBridgeAsset(caip(OP)) === 'native');
  const mLink = await bridgeMutant(
    '  return BRIDGE_ASSETS.some((asset) => bridgeOfferFor(caip2, asset).destinations.length > 0);',
    '  return bridgeOfferFor(caip2).destinations.length > 0;',
  );
  check('MUTANT (the link keyed on test ETH alone, as before) is caught: hidden on Base Sepolia', mLink.bridgeLinkShown(caip(BASE)) === false && bridgeLinkShown(caip(BASE)) === true);

  // (1, second part) The switch button on the mint and delivery panels.
  check('the switch target: the receiving network while another is active; none on it, and none for a network Settings does not offer',
    bridgeSwitchTarget(caip(ARB), { destinationCaip2: caip(BASE) }) === 'eip155:84532' &&
      bridgeSwitchTarget(caip(BASE), { destinationCaip2: caip(BASE) }) === null &&
      bridgeSwitchTarget(caip(ARB), { destinationCaip2: 'eip155:1' }) === null &&
      bridgeSwitchTarget(caip(ARB), { destinationCaip2: 'eip155:59141' }) === null);
  check('the switch sentence and the button title (exact)',
    bridgeSwitchSentence('Base Sepolia') === 'To send it from this wallet, make Base Sepolia the active network with the button below (the same choice as Settings → Developer → Test network); this screen stays open and this transfer stays listed here.' &&
      bridgeSwitchButtonTitle('Base Sepolia') === 'Switch to Base Sepolia');
  check('the screen switches through the same preference Settings → Developer writes (PrefsContext setTestNetwork)',
    screen.includes('const { evmChain, setTestNetwork } = usePrefs();') && screen.includes('setTestNetwork(target).catch(') &&
      settings.includes('onPress={() => void setTestNetwork(choice.value)}'));
  check('the button sits beside both the mint and the delivery sentence, only when a switch target exists',
    (screen.match(/<BlockerWithSwitch text=\{blocker\} activeCaip2=\{activeCaip2\} record=\{record\} onSwitchNetwork=\{onSwitchNetwork\} \/>/g) ?? []).length === 2 &&
      screen.includes('const target = bridgeSwitchTarget(activeCaip2, record);') && screen.includes('{target ? (') && screen.includes('onPress={() => onSwitchNetwork(target)}'));
  check('the screen stays mounted on a switch: the navigator is keyed on the active account only (App.tsx)',
    appSrc.includes('<NavigationContainer key={`account-${activeAccount?.index ?? 0}`} theme={navTheme}>') && (appSrc.match(/<NavigationContainer /g) ?? []).length === 1);
  check('after a switch the form starts over and the previous network’s endpoint is not used as the new one’s',
    /if \(formNetwork !== caip2\) \{\n\s+setFormNetwork\(caip2\);\n\s+setAssetPick\(null\);\n\s+setDestination\(null\);\n\s+setProviderId\(null\);/.test(screen) &&
      screen.includes('const url = endpoint && endpoint.network.chainId === caip2 ? endpoint.url : null;'));

  // (2) The USDC placeholder.
  check('finding 2: the amount placeholder follows the asset (exact)',
    bridgeAmountPlaceholder('usdc') === 'Amount, for example 1' && BRIDGE_USDC_AMOUNT_PLACEHOLDER === 'Amount, for example 1' &&
      bridgeAmountPlaceholder('native') === BRIDGE_AMOUNT_PLACEHOLDER);

  // (3) The paymaster sentence only where it applies.
  const engine = createCctpV2Provider();
  const route = engine.supportedRoutes().find((r) => r.sourceChainId === BASE && r.destinationChainId === ARB);
  const eq = await engine.quote({ route, amount: USDC_AMOUNT, sender: EOA, recipient: EOA, nativeSymbol: 'test ETH' });
  check('the wallet’s copy of the adapter’s paymaster note equals it word for word (so the filter cannot drift)', eq.notes.includes(CCTP_FIRST_MINT_PAYMASTER_NOTE));
  const paymasterNotes = (plan) => bridgeConfirmModel(plan).notes.filter((n) => n.startsWith("Circle's USDC fee paymaster"));
  fundUsdc(BASE, EOA, 5_000_000n);
  const arbBalanceReads = () => chains.get(ARB).calls.filter((c) => c.method === 'eth_call' && same(c.params[0].to, CCTP_V2_TESTNET_USDC[ARB]) && c.params[0].data === '0x70a08231' + '0'.repeat(24) + EOA.slice(2).toLowerCase());
  const planZero = await quoteBridge(cctpRequest());
  check('finding 3: the recipient’s USDC on the RECEIVING network is read once at the quote (balanceOf on Arbitrum Sepolia’s USDC)',
    planZero.recipientDestinationUsdc === 'zero' && arbBalanceReads().length === 1);
  check('…holding none: the sentence is shown once, as the adapter words it', paymasterNotes(planZero).length === 1 && paymasterNotes(planZero)[0] === CCTP_FIRST_MINT_PAYMASTER_NOTE);
  fundUsdc(ARB, EOA, 1n);
  const planHeld = await quoteBridge(cctpRequest());
  check('…holding some USDC there: no paymaster sentence', planHeld.recipientDestinationUsdc === 'held' && paymasterNotes(planHeld).length === 0, JSON.stringify(bridgeConfirmModel(planHeld).notes));
  const arbDefault = defaultChainTransport(ARB);
  const failingArb = (method, params) =>
    method === 'eth_call' && same(params[0].to, CCTP_V2_TESTNET_USDC[ARB]) ? Promise.reject(new Error('down')) : arbDefault(method, params);
  const planUnknown = await quoteBridge(cctpRequest({ readers: { transportFor: (id) => (id === ARB ? failingArb : readersFor(BASE).transportFor(id)) } }));
  check('…unreadable: the sentence with "could not be read" (exact)',
    planUnknown.recipientDestinationUsdc === 'unknown' &&
      paymasterNotes(planUnknown).join() === `${CCTP_FIRST_MINT_PAYMASTER_NOTE} Whether the recipient holds USDC on Arbitrum Sepolia could not be read just now.` &&
      cctpFirstMintPaymasterNote(undefined, 'Arbitrum Sepolia') === paymasterNotes(planUnknown)[0]);
  check('…test ETH: nothing read, no paymaster sentence', planA.recipientDestinationUsdc === null && paymasterNotes(planA).length === 0);
  const mPay = await bridgeMutant(
    '  const paymaster = cctpFirstMintPaymasterNote(plan.recipientDestinationUsdc, plan.destinationLabel);',
    '  const paymaster = CCTP_FIRST_MINT_PAYMASTER_NOTE;',
  );
  check('MUTANT (the sentence shown unconditionally, as before) is caught', mPay.bridgeConfirmModel(planHeld).notes.includes(CCTP_FIRST_MINT_PAYMASTER_NOTE));

  // (5) The live region and the short addresses.
  const liveRegionOk = (src) =>
    /<Text accessibilityLiveRegion="polite"[^>]*>\s*\{liveStatus\}\s*<\/Text>/.test(src) &&
    (src.match(/accessibilityLiveRegion=/g) ?? []).length === 1 &&
    src.includes('const liveStatus = bridgeLiveStatusText(record);') &&
    src.includes("{checking ? <Text style={[styles.body, { color: theme.textMuted }]}>(checking…)</Text> : null}");
  check('finding 5: the tracking card’s live region holds the status alone; "(checking…)" is a separate, non-live Text', liveRegionOk(views));
  const mutantViews = views.replace('          {liveStatus}\n', "          {liveStatus}\n          {checking ? ' (checking…)' : ''}\n");
  check('MUTANT (the checking mark back inside the live region) is caught by the source pin', mutantViews !== views && !liveRegionOk(mutantViews));
  const spokenNote = withShortAddresses(usdcRecipientNote('regular', EOA, 'Base Sepolia'));
  check('the recipient sentence is spoken with the short address (the visible text keeps the full one)',
    spokenNote.includes(spokenShortAddress(EOA)) && !spokenNote.includes(EOA) && usdcRecipientNote('regular', EOA, 'Base Sepolia').includes(EOA) &&
      screen.includes('accessibilityLabel={withShortAddresses(usdcRecipientNote(recipientKind, recipientKind === \'regular\' ? account.address : null, destinationLabel))}') &&
      screen.includes('accessibilityLabel={withShortAddresses(regularRecipientNote(account.address, destinationLabel))}') &&
      screen.includes('accessibilityLabel={withShortAddresses(upgradedAccountRecipientNote(account.address, destinationLabel))}') &&
      screen.includes('<Text accessibilityLabel={withShortAddresses(text)} style={[styles.hint, { color: theme.textMuted }]}>{text}</Text>'));
  check('the transfer record’s line is spoken with the short address', views.includes('<Text accessibilityLabel={withShortAddresses(through)} style={[styles.body, { color: theme.textMuted }]}>'));
  for (const mod of [mLink, mPay]) await mod.resetBridgeTransfers();
}

console.log(`\ncheck-bridge: ${passed} passed, ${failed} failed (${mutantCount} mutants)`);
process.exit(failed === 0 ? 0 : 1);

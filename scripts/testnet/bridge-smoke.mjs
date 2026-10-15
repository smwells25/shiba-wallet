/**
 * Bridge smoke test (phase 21 item 1, live leg): native test ETH through
 * Stargate V2 on the ENGINE's LayerZero OFT adapter
 * (packages/chains-evm/src/bridge/layerzero-oft.ts). Test networks only.
 * Research behind it: docs/BRIDGING.md section 15; the proposed live steps
 * are section 15.13.
 *
 * The point is to prove the engine's own calldata: every quote is the
 * adapter's quote() (quoteOFT then quoteSend through the injected chain
 * reader), every transaction sent is the adapter's built call, unchanged
 * (to, value and data are copied from quote.calls[0]; the script adds only
 * the nonce, the gas limit and the EIP-1559 fees, then signs with the
 * engine's signEip1559). ethers is used only to check the engine's work
 * independently (it re-encodes the call and decodes events); it never
 * builds what is sent.
 *
 * DRY RUN (default; nothing is signed or sent):
 *   - registers the LayerZero OFT adapter (and the CCTP V2 adapter, to show
 *     the registry serving two providers) in the engine's BridgeRegistry and
 *     prints the routes;
 *   - re-reads the security facts the adapter carries for each Stargate
 *     pathway (SendUln302.getUlnConfig / getExecutorConfig for Stargate's
 *     TokenMessaging contract, EndpointV2.getSendLibrary) and compares them;
 *   - for each of the six routes among Ethereum Sepolia, OP Sepolia and
 *     Arbitrum Sepolia: the adapter's quote for BRIDGE_AMOUNT to the dev EOA
 *     (fee lines, pins, unpinnable fields), an independent check of the
 *     built call (ethers re-encodes it byte for byte; every pin reads its
 *     own word; quoteSend re-read with ethers-built calldata gives the same
 *     fee), and eth_simulateV1 of the exact built call from the dev EOA;
 *   - refusals: an amount one wei below the OFT's minimum and an amount with
 *     dust (the engine refuses before any read), a minimum-to-receive one
 *     wei above the quote (engine), non-empty extraOptions (engine), a route
 *     to Base Sepolia (the engine has none; on-chain quoteSend to eid 40245
 *     reverts), value one wei short (simulated: Stargate_InvalidAmount) and
 *     minAmountLD one shared-decimal step above the arrival (simulated:
 *     Stargate_SlippageTooHigh).
 *
 * LIVE (BRIDGE_LIVE): from the dev EOA to the dev EOA's own address only.
 *   BRIDGE_LIVE=1          leg A (Ethereum Sepolia → OP Sepolia), then leg B
 *                          (OP Sepolia → Arbitrum Sepolia)
 *   BRIDGE_LIVE=sepolia-op leg A only
 *   BRIDGE_LIVE=op-arb     leg B only
 * HARD CAPS: at most 0.0005 ETH bridged per leg (BRIDGE_AMOUNT_WEI, default
 * 0.0002 ETH, must be a multiple of 10^12 wei); at most 0.002 ETH spent in
 * total across the recorded legs, counting the amount, the LayerZero fee and
 * the worst-case gas (and L1 data fee) of each leg before it is sent; a leg
 * is refused when it would leave less than 0.005 ETH on the source. For
 * each leg: a fresh quote, a fresh eth_simulateV1 of the exact call, the
 * send, the receipt re-read on two endpoints (status, gas, the sent
 * transaction's input equal to the engine's calldata, OFTSent and PacketSent
 * decoded, the GUID), the source balance delta reconciled to the wei,
 * destination tracking through the adapter's track() against LayerZero
 * Scan's keyless testnet API AND an independent eth_getLogs for OFTReceived
 * (or UnreceivedTokenCached) on the destination pool, the delivery time, the
 * destination balance delta reconciled to the wei on two endpoints. A leg
 * that is not DELIVERED within 20 minutes, that ends in UnreceivedTokenCached
 * or that reverts stops the run; nothing is retried.
 *
 * BRIDGE_VERIFY=1 (read-only, no dry run, nothing sent): re-reads every
 * recorded leg on three endpoints per chain — the source and destination
 * receipts and whether their blocks are still canonical, the sent input
 * against the engine's calldata, the split of the LayerZero fee in the send
 * library's ExecutorFeePaid / DVNFeePaid events, the balance deltas, and the
 * source chain's safe and finalized heads — and writes the totals.
 *
 * Every public fact is written to scripts/testnet/runs/bridge-run.json
 * (git-ignored) after each step. A leg recorded as done is not sent again
 * unless BRIDGE_REPEAT=1.
 *
 * Run from the repository root after building the engine
 * (`npm run build --workspace packages/chains-evm`):
 *   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
 *   node scripts/testnet/bridge-smoke.mjs
 *   BRIDGE_LIVE=1 node scripts/testnet/bridge-smoke.mjs
 *
 * Secrets: the dev mnemonic is read from the git-ignored .dev-wallet and
 * never printed. Every endpoint used is keyless; error texts are still
 * stripped of URLs before printing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { AbiCoder, Interface, getAddress, id as ethersId, zeroPadValue } from 'ethers';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import * as E from '../../packages/chains-evm/dist/index.js';
import { describeReceiptFees, operatorFeeAt, receiptFeePaid } from './l2-receipt.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SEPOLIA = 11155111;
const OP_SEPOLIA = 11155420;
const ARB_SEPOLIA = 421614;
const BASE_SEPOLIA = 84532;
/** The first two default endpoints of each app profile (app/src/config/evm-chain.ts; AGENTS.md phases 14, 18, 19). */
const CHAINS = {
  [SEPOLIA]: {
    name: 'Ethereum Sepolia',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    second: 'https://eth-sepolia-testnet.api.pocket.network',
    third: 'https://sepolia.drpc.org',
    explorer: 'https://sepolia.etherscan.io/tx/',
    opStack: false,
  },
  [OP_SEPOLIA]: {
    name: 'OP Sepolia',
    rpc: 'https://optimism-sepolia-rpc.publicnode.com',
    second: 'https://sepolia.optimism.io',
    third: 'https://op-sepolia-testnet.api.pocket.network',
    explorer: 'https://sepolia-optimism.etherscan.io/tx/',
    opStack: true,
  },
  [ARB_SEPOLIA]: {
    name: 'Arbitrum Sepolia',
    rpc: 'https://arbitrum-sepolia-rpc.publicnode.com',
    second: 'https://sepolia-rollup.arbitrum.io/rpc',
    third: 'https://arb-sepolia-testnet.api.pocket.network',
    explorer: 'https://sepolia.arbiscan.io/tx/',
    opStack: false,
  },
};
const BASE_RPC = 'https://base-sepolia-rpc.publicnode.com';
const SCAN_API = 'https://scan-testnet.layerzero-api.com/v1';

const E12 = 10n ** 12n;
const E15 = 10n ** 15n;
const AMOUNT_CAP = 5n * 10n ** 14n; // 0.0005 ETH bridged per leg at most
const TOTAL_SPEND_CAP = 2n * E15; // 0.002 ETH spent in total at most (amount + fee + gas)
const MIN_SOURCE_LEFT = 5n * E15; // refuse a leg that would leave less than 0.005 ETH on the source
const AMOUNT = BigInt(process.env.BRIDGE_AMOUNT_WEI ?? 2n * 10n ** 14n); // 0.0002 ETH
const DELIVERY_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_MS = 10_000;
const LEGS = {
  'sepolia-op': { key: 'sepolia-op', label: 'A: Ethereum Sepolia → OP Sepolia', source: SEPOLIA, destination: OP_SEPOLIA },
  'op-arb': { key: 'op-arb', label: 'B: OP Sepolia → Arbitrum Sepolia', source: OP_SEPOLIA, destination: ARB_SEPOLIA },
};
const LIVE = process.env.BRIDGE_LIVE ?? '';
const RUN_FILE = new URL('./runs/bridge-run.json', import.meta.url);

if (AMOUNT <= 0n || AMOUNT > AMOUNT_CAP || AMOUNT % E12 !== 0n) {
  console.error(`BRIDGE_AMOUNT_WEI must be a positive multiple of 10^12 wei and at most ${AMOUNT_CAP} wei (0.0005 ETH).`);
  process.exit(1);
}
if (LIVE && LIVE !== '1' && !LEGS[LIVE]) {
  console.error('BRIDGE_LIVE must be 1, sepolia-op or op-arb.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const host = (url) => new URL(url).host;
const lower = (a) => a.toLowerCase();
const hex = (n) => '0x' + BigInt(n).toString(16);
const fmt = (wei) => {
  const neg = wei < 0n;
  const s = (neg ? -wei : wei).toString().padStart(19, '0');
  const out = `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '') || '0';
  return neg ? `-${out}` : out;
};
/** Removes anything that looks like a URL from an error text (the endpoints are keyless, but the rule is general). */
const mask = (text) => String(text).replace(/https?:\/\/[^\s"')]+/g, '<url>');
const errText = (e) => mask(e?.message ?? e).slice(0, 400);
/** JSON with bigints as decimal strings. */
const toJson = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

let failures = 0;
const expect = (ok, text) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failures += 1;
  return ok;
};

const transports = {};
function nodeFor(chainId, which = 'rpc') {
  const key = `${chainId}:${which}`;
  if (!transports[key]) {
    const raw = E.httpTransport(CHAINS[chainId][which]);
    transports[key] = async (method, params) => {
      try {
        return await raw(method, params);
      } catch (e) {
        throw new Error(`${host(CHAINS[chainId][which])}: ${errText(e)}`);
      }
    };
  }
  return transports[key];
}

function loadRun() {
  if (!existsSync(RUN_FILE)) return null;
  return JSON.parse(readFileSync(RUN_FILE, 'utf8'));
}
function saveRun(run) {
  mkdirSync(new URL('./runs/', import.meta.url), { recursive: true });
  run.updatedAt = new Date().toISOString();
  writeFileSync(RUN_FILE, toJson(run) + '\n');
}

// ---------------------------------------------------------------------------
// Event and error identifiers, computed here from the signatures in the
// pinned sources (LayerZero-v2 9c741e7f: IOFT.sol lines 59-71,
// ILayerZeroEndpointV2.sol line 36; stargate-v2 9f4f5c0f: StargateBase.sol
// lines 82, 85, 95-102) and compared with the prefixes recorded in
// docs/BRIDGING.md section 15.1.
// ---------------------------------------------------------------------------

const TOPIC = {
  OFTSent: ethersId('OFTSent(bytes32,uint32,address,uint256,uint256)'),
  OFTReceived: ethersId('OFTReceived(bytes32,uint32,address,uint256)'),
  PacketSent: ethersId('PacketSent(bytes,bytes,address)'),
  UnreceivedTokenCached: ethersId('UnreceivedTokenCached(bytes32,uint8,uint32,address,uint256,bytes)'),
  PacketDelivered: ethersId('PacketDelivered((uint32,bytes32,uint64),address)'),
  Transfer: ethersId('Transfer(address,address,uint256)'),
};
const ERR = {
  Stargate_InvalidAmount: ethersId('Stargate_InvalidAmount()').slice(0, 10),
  Stargate_SlippageTooHigh: ethersId('Stargate_SlippageTooHigh()').slice(0, 10),
};
const RECORDED_PREFIX = { OFTSent: '0x85496b76', OFTReceived: '0xefed6d35', PacketSent: '0x1ab700d4', UnreceivedTokenCached: '0x007c1719' };
const SYSTEM_ADDRESS = '0xfffffffffffffffffffffffffffffffffffffffe'; // EIP-7708 protocol transfer logs (Ethereum Sepolia after Glamsterdam)

const coder = AbiCoder.defaultAbiCoder();
const SP = 'tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd)';
const oftIface = new Interface([
  `function send(${SP} p, tuple(uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable`,
  `function quoteSend(${SP} p, bool payInLzToken) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))`,
]);
const ulnIface = new Interface([
  'function getUlnConfig(address oapp, uint32 remoteEid) view returns (tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs))',
  'function getExecutorConfig(address oapp, uint32 remoteEid) view returns (tuple(uint32 maxMessageSize, address executor))',
]);
const endpointIface = new Interface(['function getSendLibrary(address sender, uint32 dstEid) view returns (address)']);

/** PacketV1Codec offsets (LayerZero-v2 9c741e7f, messagelib/libs/PacketV1Codec.sol lines 16-26). */
function decodePacket(payloadHex) {
  const b = payloadHex.slice(2);
  const at = (start, end) => '0x' + b.slice(start * 2, end * 2);
  return {
    version: Number(BigInt(at(0, 1))),
    nonce: BigInt(at(1, 9)),
    srcEid: Number(BigInt(at(9, 13))),
    sender: getAddress('0x' + b.slice(13 * 2 + 24, 45 * 2)),
    dstEid: Number(BigInt(at(45, 49))),
    receiver: getAddress('0x' + b.slice(49 * 2 + 24, 81 * 2)),
    guid: at(81, 113),
    messageBytes: (b.length - 113 * 2) / 2,
  };
}

/** Decodes the logs of a bridge transaction that this script knows how to read. */
function decodeBridgeLogs(logs) {
  const out = [];
  for (const l of logs) {
    const t0 = l.topics[0];
    if (t0 === TOPIC.OFTSent) {
      const [dstEid, amountSentLD, amountReceivedLD] = coder.decode(['uint32', 'uint256', 'uint256'], l.data);
      out.push({ event: 'OFTSent', address: getAddress(l.address), guid: l.topics[1], fromAddress: getAddress('0x' + l.topics[2].slice(26)), dstEid: Number(dstEid), amountSentLD, amountReceivedLD });
    } else if (t0 === TOPIC.PacketSent) {
      const [encodedPayload, options, sendLibrary] = coder.decode(['bytes', 'bytes', 'address'], l.data);
      out.push({ event: 'PacketSent', address: getAddress(l.address), options, sendLibrary, packet: decodePacket(encodedPayload) });
    } else if (t0 === TOPIC.OFTReceived) {
      const [srcEid, amountReceivedLD] = coder.decode(['uint32', 'uint256'], l.data);
      out.push({ event: 'OFTReceived', address: getAddress(l.address), guid: l.topics[1], toAddress: getAddress('0x' + l.topics[2].slice(26)), srcEid: Number(srcEid), amountReceivedLD });
    } else if (t0 === TOPIC.UnreceivedTokenCached) {
      const [guid, index, srcEid, receiver, amountLD] = coder.decode(['bytes32', 'uint8', 'uint32', 'address', 'uint256', 'bytes'], l.data);
      out.push({ event: 'UnreceivedTokenCached', address: getAddress(l.address), guid, index: Number(index), srcEid: Number(srcEid), receiver, amountLD });
    } else if (t0 === TOPIC.PacketDelivered) {
      out.push({ event: 'PacketDelivered', address: getAddress(l.address) });
    } else if (t0 === TOPIC.Transfer && lower(l.address) === SYSTEM_ADDRESS && l.topics.length === 3) {
      out.push({ event: 'EIP-7708 Transfer', from: getAddress('0x' + l.topics[1].slice(26)), to: getAddress('0x' + l.topics[2].slice(26)), amount: BigInt(l.data) });
    } else {
      out.push({ event: `other ${t0.slice(0, 10)}`, address: getAddress(l.address) });
    }
  }
  return out;
}

async function receiptOf(node, hash, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await node('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) return r;
    await sleep(4000);
  }
  throw new Error(`No receipt for ${hash} after ${(tries * 4) / 60} minutes`);
}

/** eth_simulateV1 of calls from `from` (no balance override); returns the per-call results. */
async function simulate(node, from, calls) {
  const payload = {
    blockStateCalls: [
      {
        calls: calls.map((c) => ({ from, to: c.to, ...(c.value ? { value: hex(c.value) } : {}), input: typeof c.data === 'string' ? c.data : E.toHex(c.data) })),
      },
    ],
    traceTransfers: true,
  };
  const [block] = await node('eth_simulateV1', [payload, 'latest']);
  return block.calls.map((c) => ({
    ok: c.status === '0x1',
    gasUsed: BigInt(c.gasUsed),
    revertData: c.status === '0x1' ? null : (c.error?.data ?? c.returnData ?? null),
    revertMessage: c.status === '0x1' ? null : (c.error?.message ?? null),
    logs: c.logs ?? [],
  }));
}

// ---------------------------------------------------------------------------
// The engine's adapter, wired as the app would wire it
// ---------------------------------------------------------------------------

/** The injected chain reader: one eth_call on the primary endpoint at the latest block. */
const readContract = async ({ chainId, to, data }) => nodeFor(chainId)('eth_call', [{ to, data }, 'latest']);

/** The last Scan answer per source transaction (printed and recorded beside the adapter's mapped state). */
const scanSeen = new Map();
/**
 * The injected LayerZero message reader: GET /messages/tx/{hash} on the
 * keyless Scan testnet API (OpenAPI `security: []`, docs/BRIDGING.md 15.9).
 * A 404 means "not indexed yet".
 */
async function fetchMessageStatus({ sourceChainId, sourceTxHash }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${SCAN_API}/messages/tx/${sourceTxHash}`, { signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`LayerZero Scan answered HTTP ${response.status}`);
    const body = await response.json();
    const messages = Array.isArray(body?.data) ? body.data : [];
    const m = messages[0];
    if (!m) return null;
    scanSeen.set(lower(sourceTxHash), { count: messages.length, message: m, sourceChainId });
    const answer = { status: m.status?.name ?? 'UNKNOWN' };
    if (m.destination?.tx?.txHash) answer.destinationTxHash = m.destination.tx.txHash;
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

const lzProvider = E.createLayerZeroOftProvider({
  deployments: E.STARGATE_V2_TESTNET_NATIVE_POOLS,
  readContract,
  fetchMessageStatus,
});
const bridgeRegistry = E.createBridgeRegistry([E.createCctpV2Provider(), lzProvider]);
const provider = bridgeRegistry.require(E.LAYERZERO_OFT_PROVIDER_ID);
const poolOn = (chainId) => E.STARGATE_V2_TESTNET_NATIVE_POOLS.find((d) => d.chainId === chainId);

function routeFor(source, destination) {
  const route = provider.supportedRoutes().find((r) => r.sourceChainId === source && r.destinationChainId === destination);
  if (!route) throw new Error(`The adapter lists no route ${source} → ${destination}.`);
  return route;
}

/** The trust statement and quote, as the Bridge screen would show them. */
function screenText(quote) {
  const lines = [];
  lines.push(`Provider: ${provider.label}`);
  lines.push(`Who verifies: ${provider.trust.verification}`);
  lines.push(`Who controls: ${provider.trust.control}`);
  lines.push(`If it does not arrive: ${quote.refundRule}`);
  for (const f of quote.fees) {
    lines.push(`Fee (${f.kind}): ${f.amount === null ? 'unknown before sending' : `${fmt(f.amount)} ${f.asset.symbol}`} — ${f.description}${f.deductedFromAmount ? ' (taken from the amount)' : ''}`);
  }
  lines.push(`You send ${fmt(quote.amountIn)} ETH; expected to arrive ${fmt(quote.expectedAmountOut)} ETH (at least ${fmt(quote.minAmountOut)}).`);
  lines.push(`Time: ${quote.time.source}`);
  lines.push(`On the receiving network: ${quote.destination.description}`);
  lines.push(`Tracking: ${quote.tracking.description}`);
  for (const n of quote.notes) lines.push(`Note: ${n}`);
  return lines;
}

/** Independent checks of the adapter's built bridge call (ethers re-encoding, pins, quoteSend re-read). */
async function checkBuiltCall(quote, sender, label) {
  const r = quote.route;
  const pool = poolOn(r.sourceChainId);
  const target = poolOn(r.destinationChainId);
  const calls = quote.calls;
  expect(calls.length === 1 && calls[0].purpose === 'bridge', `${label}: one call, the bridge send (no approval for a native pool)`);
  const call = calls[0];
  const fee = quote.fees.find((f) => f.kind === 'messaging').amount;
  const dataHex = E.toHex(call.data);
  expect(lower(call.to) === lower(pool.address), `${label}: call target is the pinned Stargate native pool ${pool.address}`);
  expect(call.value === quote.amountIn + fee, `${label}: value ${call.value} = amount ${quote.amountIn} + native fee ${fee} exactly`);
  expect(call.valueLimit === call.value, `${label}: valueLimit equals the value`);
  expect(dataHex.slice(0, 10) === E.OFT_SEND_SELECTOR && call.selector === E.OFT_SEND_SELECTOR, `${label}: selector ${E.OFT_SEND_SELECTOR}`);
  const sendParam = [E.layerZeroEidFor(r.destinationChainId), zeroPadValue(sender, 32), quote.amountIn, quote.minAmountOut, '0x', '0x', '0x'];
  const ethersData = oftIface.encodeFunctionData('send', [sendParam, [fee, 0n], sender]);
  expect(ethersData === dataHex, `${label}: ethers' independent encoding of send(SendParam, MessagingFee, refund) is byte-identical (${(dataHex.length - 2) / 2} bytes)`);
  const decoded = oftIface.decodeFunctionData('send', dataHex);
  expect(
    Number(decoded.p.dstEid) === E.layerZeroEidFor(r.destinationChainId) &&
      lower(decoded.p.to) === lower(zeroPadValue(sender, 32)) &&
      decoded.p.amountLD === quote.amountIn &&
      decoded.p.minAmountLD === quote.minAmountOut &&
      decoded.p.extraOptions === '0x' &&
      decoded.p.composeMsg === '0x' &&
      decoded.p.oftCmd === '0x' &&
      decoded.fee.nativeFee === fee &&
      decoded.fee.lzTokenFee === 0n &&
      lower(decoded.refundAddress) === lower(sender),
    `${label}: decoded fields — dstEid ${decoded.p.dstEid}, to = the dev EOA, amountLD ${decoded.p.amountLD}, minAmountLD ${decoded.p.minAmountLD}, empty options/compose/oftCmd (taxi), fee ${decoded.fee.nativeFee}/0, refund = the dev EOA`,
  );
  let pinsOk = true;
  for (const pin of call.pins) {
    const w = BigInt('0x' + dataHex.slice(10 + pin.rule.offset * 2, 10 + pin.rule.offset * 2 + 64));
    const p = BigInt(pin.rule.params[0]);
    if (pin.rule.condition !== 'equal' || w !== p) pinsOk = false;
  }
  expect(pinsOk && call.pins.length === 14, `${label}: all ${call.pins.length} pins are "equal" rules that read their own word of the calldata`);
  const ethersQuote = oftIface.encodeFunctionData('quoteSend', [sendParam, false]);
  const [indep] = oftIface.decodeFunctionResult('quoteSend', await nodeFor(r.sourceChainId)('eth_call', [{ to: pool.address, data: ethersQuote }, 'latest']));
  // The fee can move between two reads; report the difference rather than failing on it.
  console.log(`  info quoteSend re-read with ethers-built calldata: native fee ${indep.nativeFee} (adapter quoted ${fee}; difference ${indep.nativeFee - fee} wei), lzTokenFee ${indep.lzTokenFee}`);
  expect(target && lower(target.messagingOApp) !== lower(pool.messagingOApp), `${label}: destination pool ${target.address} with TokenMessaging ${target.messagingOApp}`);
  return { call, fee, dataHex, independentQuoteFee: indep.nativeFee };
}

/** Re-reads the pathway security facts the adapter carries (getUlnConfig / getExecutorConfig on SendUln302 for Stargate's TokenMessaging). */
async function checkPathwayFacts(source, destination) {
  const pool = poolOn(source);
  const lz = E.LAYERZERO_V2_TESTNET[source];
  const dstEid = E.layerZeroEidFor(destination);
  const node = nodeFor(source);
  const lib = endpointIface.decodeFunctionResult(
    'getSendLibrary',
    await node('eth_call', [{ to: lz.endpoint, data: endpointIface.encodeFunctionData('getSendLibrary', [pool.messagingOApp, dstEid]) }, 'latest']),
  )[0];
  const [uln] = ulnIface.decodeFunctionResult('getUlnConfig', await node('eth_call', [{ to: lz.sendUln302, data: ulnIface.encodeFunctionData('getUlnConfig', [pool.messagingOApp, dstEid]) }, 'latest']));
  const [exe] = ulnIface.decodeFunctionResult('getExecutorConfig', await node('eth_call', [{ to: lz.sendUln302, data: ulnIface.encodeFunctionData('getExecutorConfig', [pool.messagingOApp, dstEid]) }, 'latest']));
  const recorded = pool.pathways[destination];
  const live = {
    sendLibrary: lib,
    confirmations: Number(uln.confirmations),
    requiredDVNs: [...uln.requiredDVNs],
    optionalDVNs: [...uln.optionalDVNs],
    optionalThreshold: Number(uln.optionalDVNThreshold),
    executor: exe.executor,
    maxMessageSize: Number(exe.maxMessageSize),
  };
  const same =
    lower(lib) === lower(lz.sendUln302) &&
    live.confirmations === recorded.confirmations &&
    live.requiredDVNs.length === recorded.requiredDvns.length &&
    live.requiredDVNs.every((a, i) => lower(a) === lower(recorded.requiredDvns[i].address)) &&
    live.optionalDVNs.length === recorded.optionalDvns.length &&
    lower(live.executor) === lower(recorded.executor.address);
  expect(
    same,
    `${CHAINS[source].name} → ${CHAINS[destination].name}: live config matches the adapter's recorded facts — send library ${lib}, ${live.confirmations} confirmations, required DVNs [${live.requiredDVNs.join(', ')}], optional ${live.optionalDVNs.length} (threshold ${live.optionalThreshold}), executor ${live.executor}, max message ${live.maxMessageSize} bytes`,
  );
  return { same, live };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

async function dryRun(sender, run) {
  console.log('\n=== DRY RUN (nothing is signed or sent)');
  for (const [name, prefix] of Object.entries(RECORDED_PREFIX)) {
    expect(TOPIC[name].startsWith(prefix), `event ${name} topic ${TOPIC[name].slice(0, 18)}… matches the prefix recorded in BRIDGING.md 15.1 (${prefix})`);
  }
  expect(ERR.Stargate_InvalidAmount === '0x3442dd95', `Stargate_InvalidAmount() selector ${ERR.Stargate_InvalidAmount} matches BRIDGING.md 15.1`);
  console.log(`  info Stargate_SlippageTooHigh() selector ${ERR.Stargate_SlippageTooHigh}`);

  for (const chainId of [SEPOLIA, OP_SEPOLIA, ARB_SEPOLIA]) {
    for (const which of ['rpc', 'second']) {
      const got = Number(BigInt(await nodeFor(chainId, which)('eth_chainId', [])));
      expect(got === chainId, `${host(CHAINS[chainId][which])} answers chain id ${got}`);
    }
  }

  console.log('\n  -- registry');
  for (const p of bridgeRegistry.list()) console.log(`  provider ${p.id} ("${p.label}"): ${p.supportedRoutes().length} routes`);
  const lzRoutes = provider.supportedRoutes().map((r) => `${r.sourceChainId}→${r.destinationChainId}`);
  console.log(`  layerzero-oft routes: ${lzRoutes.join(', ')}`);
  const toBase = bridgeRegistry.routes({ destinationChainId: BASE_SEPOLIA });
  expect(
    toBase.every((r) => r.providerId !== E.LAYERZERO_OFT_PROVIDER_ID) && toBase.length > 0,
    `routes to Base Sepolia: ${toBase.length}, all from ${[...new Set(toBase.map((r) => r.providerId))].join(', ')} — none from layerzero-oft`,
  );

  console.log('\n  -- pathway security, re-read live and compared with the adapter');
  const pathways = {};
  for (const r of provider.supportedRoutes()) {
    pathways[`${r.sourceChainId}->${r.destinationChainId}`] = await checkPathwayFacts(r.sourceChainId, r.destinationChainId);
  }

  console.log('\n  -- balances of the dev EOA');
  const balances = {};
  for (const chainId of [SEPOLIA, OP_SEPOLIA, ARB_SEPOLIA]) {
    const [a, b] = await Promise.all(['rpc', 'second'].map((w) => nodeFor(chainId, w)('eth_getBalance', [sender, 'latest']).then(BigInt)));
    balances[chainId] = a;
    console.log(`  ${CHAINS[chainId].name}: ${fmt(a)} ETH (${host(CHAINS[chainId].rpc)}), ${fmt(b)} ETH (${host(CHAINS[chainId].second)})`);
  }

  console.log(`\n  -- quotes for ${fmt(AMOUNT)} ETH to the dev EOA, and eth_simulateV1 of the exact built call`);
  const quotes = {};
  for (const r of provider.supportedRoutes()) {
    const label = `${CHAINS[r.sourceChainId].name} → ${CHAINS[r.destinationChainId].name}`;
    console.log(`\n  ${label}`);
    const quote = await provider.quote({ route: r, amount: AMOUNT, sender, recipient: sender });
    const checked = await checkBuiltCall(quote, sender, label);
    const pool = poolOn(r.sourceChainId);
    const [sim] = await simulate(nodeFor(r.sourceChainId), sender, [checked.call]);
    const logs = decodeBridgeLogs(sim.logs);
    const oftSent = logs.find((l) => l.event === 'OFTSent');
    const packetSent = logs.find((l) => l.event === 'PacketSent');
    expect(
      sim.ok && oftSent && packetSent && oftSent.amountSentLD === AMOUNT && oftSent.amountReceivedLD === quote.expectedAmountOut,
      `${label}: simulated send ${sim.ok ? 'succeeded' : `REVERTED ${sim.revertData}`}, gas ${sim.gasUsed}; OFTSent sent ${oftSent?.amountSentLD} / received ${oftSent?.amountReceivedLD}; PacketSent ${packetSent ? `nonce ${packetSent.packet.nonce}, receiver ${packetSent.packet.receiver}` : 'missing'}`,
    );
    if (packetSent) {
      expect(
        lower(packetSent.packet.receiver) === lower(poolOn(r.destinationChainId).messagingOApp) && packetSent.packet.dstEid === E.layerZeroEidFor(r.destinationChainId) && packetSent.packet.guid === oftSent?.guid,
        `${label}: the packet goes to the destination TokenMessaging, eid ${packetSent.packet.dstEid}, same GUID as OFTSent`,
      );
    }
    const pool2 = pool;
    quotes[`${r.sourceChainId}->${r.destinationChainId}`] = {
      nativeFee: checked.fee,
      independentQuoteFee: checked.independentQuoteFee,
      expectedAmountOut: quote.expectedAmountOut,
      poolFee: quote.fees.find((f) => f.kind === 'pool')?.amount ?? 0n,
      simulatedGas: sim.gasUsed,
      simulatedOk: sim.ok,
      pool: pool2.address,
    };
    for (const line of quote.fees) console.log(`     fee line: ${line.kind} ${line.amount} — ${line.description}`);
    if (r.sourceChainId === SEPOLIA && r.destinationChainId === OP_SEPOLIA) {
      console.log('     pins (word offset after the selector → field):');
      for (const p of checked.call.pins) console.log(`       ${String(p.rule.offset).padStart(3)} ${p.rule.condition} ${p.field}`);
      for (const u of checked.call.unpinnable) console.log(`     unpinnable: ${u}`);
      console.log('\n  -- the screen text for this quote (provider trust statement, fee lines, notes):');
      for (const l of screenText(quote)) console.log(`     ${l}`);
    }
  }

  console.log('\n  -- refusals');
  const rA = routeFor(SEPOLIA, OP_SEPOLIA);
  const base = await provider.quote({ route: rA, amount: AMOUNT, sender, recipient: sender });
  const call = base.calls[0];
  const dataHex = E.toHex(call.data);
  const refusals = {};
  // Engine refusals, before or at quote time.
  const limitHex = await readContract({ chainId: SEPOLIA, to: poolOn(SEPOLIA).address, data: E.toHex(E.encodeOftQuoteOft({ dstEid: 40232, to: sender, amountLD: AMOUNT, minAmountLD: 0n, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' })) });
  const limits = E.decodeOftQuoteOftHead(limitHex);
  console.log(`  info quoteOFT limits on Sepolia → OP Sepolia: min ${limits.minAmountLD} wei, max ${limits.maxAmountLD} wei`);
  const tryQuote = async (label, request, expectText) => {
    try {
      await provider.quote(request);
      expect(false, `${label}: the engine QUOTED (expected a refusal)`);
      refusals[label] = 'quoted';
    } catch (e) {
      expect(String(e.message).includes(expectText), `${label}: refused — "${errText(e)}"`);
      refusals[label] = errText(e);
    }
  };
  await tryQuote('one wei below the minimum amount', { route: rA, amount: limits.minAmountLD > 0n ? limits.minAmountLD - 1n : 0n, sender, recipient: sender }, 'steps of');
  await tryQuote('an amount with dust (one wei more than 0.0002 ETH)', { route: rA, amount: AMOUNT + 1n, sender, recipient: sender }, 'steps of');
  await tryQuote('a minimum to receive one wei above the quote', { route: rA, amount: AMOUNT, sender, recipient: sender, minAmountOut: base.expectedAmountOut + 1n }, 'below the minimum');
  try {
    E.encodeOftSend(
      { dstEid: 40232, to: sender, amountLD: AMOUNT, minAmountLD: AMOUNT, extraOptions: '0x00030100110100000000000000000000000000030d40', composeMsg: '0x', oftCmd: '0x' },
      { nativeFee: 1n, lzTokenFee: 0n },
      sender,
    );
    expect(false, 'non-empty extraOptions: the engine ENCODED it (expected a refusal)');
  } catch (e) {
    expect(String(e.message).includes('extra options'), `non-empty extraOptions: refused by encodeOftSend — "${errText(e)}"`);
    refusals['non-empty extraOptions'] = errText(e);
  }
  const fakeBase = { ...rA, destinationChainId: BASE_SEPOLIA };
  await tryQuote('a route to Base Sepolia (no Stargate pool, no credit)', { route: fakeBase, amount: AMOUNT, sender, recipient: sender }, 'No configured OFT');
  // On-chain: the Sepolia pool asked to quote eid 40245 (Base Sepolia).
  try {
    const q = oftIface.encodeFunctionData('quoteSend', [[40245, zeroPadValue(sender, 32), AMOUNT, 0n, '0x', '0x', '0x'], false]);
    const res = await nodeFor(SEPOLIA)('eth_call', [{ to: poolOn(SEPOLIA).address, data: q }, 'latest']);
    expect(false, `on-chain quoteSend to Base Sepolia (eid 40245) answered ${res.slice(0, 66)} (expected a revert)`);
  } catch (e) {
    expect(/revert/i.test(String(e.message)), `on-chain quoteSend to Base Sepolia (eid 40245) reverts — "${errText(e)}"`);
    refusals['on-chain quoteSend to eid 40245'] = errText(e);
  }
  // Simulated refusals of the exact built call, altered in one place.
  const [short] = await simulate(nodeFor(SEPOLIA), sender, [{ ...call, value: call.value - 1n }]);
  expect(!short.ok && String(short.revertData).startsWith(ERR.Stargate_InvalidAmount), `value one wei short: simulated revert ${short.revertData} (Stargate_InvalidAmount)`);
  refusals['value one wei short (simulated)'] = short.revertData;
  const minWordAt = 10 + E.OFT_SEND_LAYOUT.minAmountLD * 2;
  const raised = base.expectedAmountOut + E12;
  const altered = dataHex.slice(0, minWordAt) + raised.toString(16).padStart(64, '0') + dataHex.slice(minWordAt + 64);
  const [slip] = await simulate(nodeFor(SEPOLIA), sender, [{ to: call.to, value: call.value, data: altered }]);
  expect(!slip.ok && String(slip.revertData).startsWith(ERR.Stargate_SlippageTooHigh), `minAmountLD one step (10^12 wei) above the arrival: simulated revert ${slip.revertData} (Stargate_SlippageTooHigh)`);
  refusals['minAmountLD one step above (simulated)'] = slip.revertData;

  run.dryRun = { at: new Date().toISOString(), amount: AMOUNT, balances, pathways, quotes, limitsSepoliaToOp: limits, refusals, failures };
  saveRun(run);
}

// ---------------------------------------------------------------------------
// Live leg
// ---------------------------------------------------------------------------

const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';

async function opStackL1Fee(node, rawHex) {
  // GasPriceOracle.getL1Fee over the SIGNED bytes: a slight overestimate of
  // the unsigned form the oracle expects, used only for the cap check.
  const data = E.toHex(E.encodeFunctionCall('getL1Fee(bytes)', [{ kind: 'bytes', value: E.toBytes(rawHex) }]));
  return E.decodeUint256(await node('eth_call', [{ to: GAS_PRICE_ORACLE, data }, 'latest']));
}

async function balanceAt(node, who, block) {
  return BigInt(await node('eth_getBalance', [who, hex(block)]));
}

function spentSoFar(run) {
  return Object.values(run.legs ?? {}).reduce((sum, leg) => sum + BigInt(leg.capCharge ?? 0), 0n);
}

async function liveLeg(leg, signer, run) {
  const sender = signer.address;
  const src = CHAINS[leg.source];
  const dst = CHAINS[leg.destination];
  const srcNode = nodeFor(leg.source);
  const srcNode2 = nodeFor(leg.source, 'second');
  const dstNode = nodeFor(leg.destination);
  const dstNode2 = nodeFor(leg.destination, 'second');
  console.log(`\n=== LIVE leg ${leg.label}: ${fmt(AMOUNT)} ETH from the dev EOA to the dev EOA`);
  run.legs ??= {};
  const previous = run.legs[leg.key];
  if (previous?.status && process.env.BRIDGE_REPEAT !== '1') {
    throw new Error(`The record already has leg ${leg.key} (${previous.status}). Set BRIDGE_REPEAT=1 to send another. Nothing was sent.`);
  }
  const record = { label: leg.label, source: leg.source, destination: leg.destination, amount: AMOUNT, startedAt: new Date().toISOString(), status: 'quoting' };
  run.legs[leg.key] = record;
  saveRun(run);

  const route = routeFor(leg.source, leg.destination);
  const quote = await provider.quote({ route, amount: AMOUNT, sender, recipient: sender });
  const checked = await checkBuiltCall(quote, sender, leg.label);
  if (failures > 0) throw new Error('A check of the built call failed. Nothing was sent.');
  const call = checked.call;
  const [sim] = await simulate(srcNode, sender, [call]);
  if (!sim.ok) throw new Error(`The pre-flight simulation reverted (${sim.revertData}). Nothing was sent.`);
  console.log(`  pre-flight eth_simulateV1 of the exact call: ok, gas ${sim.gasUsed}`);
  record.screen = screenText(quote);
  record.quote = {
    nativeFee: checked.fee,
    expectedAmountOut: quote.expectedAmountOut,
    minAmountOut: quote.minAmountOut,
    poolFee: quote.fees.find((f) => f.kind === 'pool')?.amount ?? 0n,
    value: call.value,
    to: call.to,
    data: checked.dataHex,
    pins: call.pins.map((p) => ({ field: p.field, offset: p.rule.offset, condition: p.rule.condition, param: p.rule.params[0] })),
    simulatedGas: sim.gasUsed,
  };
  for (const l of record.screen) console.log(`  screen: ${l}`);

  // Nonce, gas and fees: the only fields the script adds to the adapter's call.
  const latest = BigInt(await srcNode('eth_getTransactionCount', [sender, 'latest']));
  const pending = BigInt(await srcNode('eth_getTransactionCount', [sender, 'pending']));
  if (latest !== pending) throw new Error(`The dev EOA has ${pending - latest} pending transaction(s) on ${src.name}. Nothing was sent.`);
  const estimate = BigInt(await srcNode('eth_estimateGas', [{ from: sender, to: call.to, value: hex(call.value), data: checked.dataHex }]));
  const gasLimit = (estimate * 120n) / 100n;
  const fees = await new E.NodeClient(srcNode).suggestFees();
  const chainId = BigInt(await srcNode('eth_chainId', []));
  if (chainId !== BigInt(leg.source)) throw new Error('The source endpoint answered another chain. Nothing was sent.');
  const tx = { chainId, nonce: latest, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, gasLimit, to: call.to, value: call.value, data: call.data };
  const signed = E.signEip1559(tx, signer);
  const l1Estimate = src.opStack ? await opStackL1Fee(srcNode, signed.rawHex) : 0n;
  const l1Reserve = (l1Estimate * 3n) / 2n;
  const worstGas = gasLimit * fees.maxFeePerGas + l1Reserve;
  const capCharge = call.value + worstGas;
  const balance = BigInt(await srcNode('eth_getBalance', [sender, 'latest']));
  const already = spentSoFar(run);
  console.log(
    `  tx: nonce ${tx.nonce}, gas estimate ${estimate} → limit ${gasLimit}, maxFee ${fees.maxFeePerGas}, tip ${fees.maxPriorityFeePerGas}` +
      (src.opStack ? `, L1 data fee estimate ${l1Estimate} wei (reserved ${l1Reserve})` : '') +
      `; worst case value + fees = ${capCharge} wei (${fmt(capCharge)} ETH)`,
  );
  console.log(`  caps: amount ${AMOUNT} ≤ ${AMOUNT_CAP}; spent so far ${already} + this ${capCharge} = ${already + capCharge} ≤ ${TOTAL_SPEND_CAP}; source ${fmt(balance)} ETH − worst case leaves ${fmt(balance - capCharge)} ≥ 0.005`);
  if (AMOUNT > AMOUNT_CAP) throw new Error('Above the per-leg amount cap. Nothing was sent.');
  if (already + capCharge > TOTAL_SPEND_CAP) throw new Error('This leg would exceed the 0.002 ETH total cap. Nothing was sent.');
  if (balance - capCharge < MIN_SOURCE_LEFT) throw new Error('This leg would leave less than 0.005 ETH on the source. Nothing was sent.');
  if (lower(tx.to) !== lower(poolOn(leg.source).address)) throw new Error('The transaction target is not the pinned pool. Nothing was sent.');

  const dstStartBlock = BigInt(await dstNode('eth_blockNumber', []));
  const dstBefore = await Promise.all([dstNode, dstNode2].map((n) => n('eth_getBalance', [sender, 'latest']).then(BigInt)));
  record.capCharge = capCharge;
  record.tx = { nonce: tx.nonce, gasEstimate: estimate, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, l1FeeEstimate: l1Estimate };
  record.destinationStartBlock = dstStartBlock;
  record.status = 'sending';
  saveRun(run);

  const hash = await srcNode('eth_sendRawTransaction', [signed.rawHex]);
  const sentAt = Date.now();
  if (lower(hash) !== lower(signed.txHash)) throw new Error(`The node returned ${hash}, not the signed hash ${signed.txHash}.`);
  record.sourceTxHash = hash;
  record.sentAt = new Date(sentAt).toISOString();
  record.status = 'sent';
  saveRun(run);
  console.log(`  SENT ${hash} (${src.explorer}${hash})`);

  // Source receipt on two endpoints.
  let [r1, r2] = await Promise.all([receiptOf(srcNode, hash), receiptOf(srcNode2, hash)]);
  // A rollup's unsafe head can be replaced shortly after inclusion (seen on OP Sepolia on
  // 2026-10-15: the first read of leg B's receipt on sepolia.optimism.io carried a block hash
  // that no endpoint knew a minute later). On disagreement the receipts are read again.
  const firstReads = [];
  for (let i = 0; i < 6 && r1.blockHash !== r2.blockHash; i++) {
    firstReads.push({ attempt: i, hashes: [r1.blockHash, r2.blockHash] });
    console.log(`  info the two endpoints report different block hashes for the source receipt (${r1.blockHash} / ${r2.blockHash}); reading again in 20 s`);
    await sleep(20_000);
    [r1, r2] = await Promise.all([receiptOf(srcNode, hash), receiptOf(srcNode2, hash)]);
  }
  const [t1, t2] = await Promise.all([srcNode('eth_getTransactionByHash', [hash]), srcNode2('eth_getTransactionByHash', [hash])]);
  const [c1, c2] = await Promise.all([srcNode('web3_clientVersion', []).catch(() => 'unknown'), srcNode2('web3_clientVersion', []).catch(() => 'unknown')]);
  const sourceEndpoints = [
    [src.rpc, r1, t1, c1],
    [src.second, r2, t2, c2],
  ].map(([url, r, t, c]) => ({
    host: host(url),
    client: String(c).split('/').slice(0, 2).join('/'),
    status: r.status,
    block: BigInt(r.blockNumber),
    blockHash: r.blockHash,
    gasUsed: BigInt(r.gasUsed),
    effectiveGasPrice: BigInt(r.effectiveGasPrice),
    l1Fee: r.l1Fee ? BigInt(r.l1Fee) : null,
    logs: r.logs.length,
    inputMatches: lower(t.input) === lower(checked.dataHex),
    valueMatches: BigInt(t.value) === call.value,
    to: t.to,
    from: t.from,
  }));
  const [s1, s2] = sourceEndpoints;
  expect(
    s1.status === s2.status && s1.block === s2.block && s1.blockHash === s2.blockHash && s1.gasUsed === s2.gasUsed && s1.effectiveGasPrice === s2.effectiveGasPrice && s1.logs === s2.logs && s1.l1Fee === s2.l1Fee,
    `source receipt agrees on ${s1.host} (${s1.client}) and ${s2.host} (${s2.client}): status ${s1.status}, block ${s1.block}, gas used ${s1.gasUsed} of ${gasLimit}, effective price ${s1.effectiveGasPrice}${s1.l1Fee !== null ? `, l1Fee ${s1.l1Fee}` : ''}, ${s1.logs} logs`,
  );
  expect(s1.inputMatches && s2.inputMatches && s1.valueMatches && s2.valueMatches && lower(s1.to) === lower(call.to) && lower(s1.from) === lower(sender), 'the mined transaction carries exactly the engine-built calldata, value and target (both endpoints)');
  const operatorFee = src.opStack ? await operatorFeeAt(srcNode, r1) : null;
  console.log(`  source fees: ${describeReceiptFees(r1, operatorFee)}`);
  record.sourceTx = { endpoints: sourceEndpoints, blockHashDisagreements: firstReads, receiptFees: describeReceiptFees(r1, operatorFee), operatorFee };
  if (r1.status !== '0x1') {
    record.status = 'reverted';
    saveRun(run);
    throw new Error(`The source transaction reverted (status ${r1.status}). Stopped; nothing is retried.`);
  }
  const block = await srcNode('eth_getBlockByNumber', [r1.blockNumber, false]);
  const sourceTime = Number(BigInt(block.timestamp));
  const logs = decodeBridgeLogs(r1.logs);
  for (const l of logs) console.log(`  log ${toJson(l).replace(/\s+/g, ' ')}`);
  const oftSent = logs.find((l) => l.event === 'OFTSent');
  const packetSent = logs.find((l) => l.event === 'PacketSent');
  expect(
    oftSent && lower(oftSent.address) === lower(call.to) && lower(oftSent.fromAddress) === lower(sender) && oftSent.dstEid === E.layerZeroEidFor(leg.destination) && oftSent.amountSentLD === AMOUNT && oftSent.amountReceivedLD === quote.expectedAmountOut,
    `OFTSent: GUID ${oftSent?.guid}, dstEid ${oftSent?.dstEid}, sent ${oftSent?.amountSentLD}, to receive ${oftSent?.amountReceivedLD}`,
  );
  expect(
    packetSent && packetSent.packet.guid === oftSent?.guid && lower(packetSent.packet.receiver) === lower(poolOn(leg.destination).messagingOApp) && lower(packetSent.packet.sender) === lower(poolOn(leg.source).messagingOApp) && lower(packetSent.sendLibrary) === lower(E.LAYERZERO_V2_TESTNET[leg.source].sendUln302),
    `PacketSent: nonce ${packetSent?.packet.nonce}, ${packetSent?.packet.srcEid} → ${packetSent?.packet.dstEid}, sender ${packetSent?.packet.sender}, receiver ${packetSent?.packet.receiver}, send library ${packetSent?.sendLibrary}, options ${packetSent?.options}`,
  );
  const guid = oftSent?.guid;
  record.guid = guid;
  record.sourceTx.block = BigInt(r1.blockNumber);
  record.sourceTx.time = new Date(sourceTime * 1000).toISOString();
  record.sourceTx.logs = logs;

  // Source balance delta on both endpoints, block − 1 → block.
  const paid = receiptFeePaid(r1, operatorFee ?? 0n);
  const expectedSource = call.value + paid.total;
  const srcDeltas = [];
  for (const [n, url] of [[srcNode, src.rpc], [srcNode2, src.second]]) {
    try {
      const before = await balanceAt(n, sender, BigInt(r1.blockNumber) - 1n);
      const after = await balanceAt(n, sender, BigInt(r1.blockNumber));
      srcDeltas.push({ host: host(url), before, after, delta: before - after });
    } catch (e) {
      srcDeltas.push({ host: host(url), error: errText(e) });
    }
  }
  const refundLogs = logs.filter((l) => l.event === 'EIP-7708 Transfer' && lower(l.to) === lower(sender));
  for (const d of srcDeltas) {
    if (d.error) {
      console.log(`  source balance delta on ${d.host}: unavailable (${d.error})`);
      continue;
    }
    expect(
      d.delta === expectedSource,
      `source balance delta on ${d.host}: ${d.delta} wei = value ${call.value} (amount ${AMOUNT} + LayerZero fee ${checked.fee}) + gas ${paid.l2}${paid.l1 ? ` + L1 data fee ${paid.l1}` : ''}${operatorFee ? ` + operator fee ${operatorFee}` : ''} = ${expectedSource}${d.delta === expectedSource ? ' — EXACT, no refund' : ` — MISMATCH by ${expectedSource - d.delta} wei (a refund to the refund address would show here)`}`,
    );
  }
  if (refundLogs.length) console.log(`  info EIP-7708 transfers to the dev EOA in the source transaction: ${refundLogs.map((l) => `${l.amount} from ${l.from}`).join(', ')}`);
  record.sourceTx.balanceDeltas = srcDeltas;
  record.sourceTx.expectedDelta = expectedSource;
  record.sourceTx.feePaid = paid;
  record.spent = expectedSource;
  record.status = 'in-flight';
  saveRun(run);

  // Destination tracking: the adapter's track() against Scan, and an independent eth_getLogs.
  const transfer = { providerId: provider.id, route, sourceTxHash: hash, amountIn: AMOUNT, recipient: sender };
  const pool = poolOn(leg.destination);
  let fromBlock = dstStartBlock;
  let delivered = null;
  let cached = null;
  let scanDeliveredAt = null;
  const stateLog = [];
  const deadline = sentAt + DELIVERY_TIMEOUT_MS;
  let lastState = '';
  while (Date.now() < deadline && !(delivered && scanDeliveredAt) && !cached) {
    try {
      const status = await provider.track(transfer);
      const raw = scanSeen.get(lower(hash))?.message;
      const tag = `${status.state} / ${raw?.status?.name ?? 'not indexed'}`;
      if (tag !== lastState) {
        const elapsed = Math.round((Date.now() - sentAt) / 1000);
        stateLog.push({ atSecondsAfterSend: elapsed, adapterState: status.state, scanStatus: raw?.status?.name ?? null, scanMessage: raw?.status?.message ?? null, detail: status.detail });
        console.log(`  +${elapsed}s track(): ${status.state} — ${status.detail} [Scan: ${raw?.status?.name ?? 'not indexed'}${raw?.status?.message ? `, "${raw.status.message}"` : ''}]`);
        lastState = tag;
      }
      if (status.state === 'delivered' && !scanDeliveredAt) scanDeliveredAt = Date.now();
      if (status.state === 'failed' || status.state === 'awaiting-destination-action') {
        record.status = `scan-${status.state}`;
        break;
      }
    } catch (e) {
      console.log(`  track() error: ${errText(e)}`);
      stateLog.push({ atSecondsAfterSend: Math.round((Date.now() - sentAt) / 1000), error: errText(e) });
    }
    try {
      const head = BigInt(await dstNode('eth_blockNumber', []));
      if (head >= fromBlock) {
        const found = await dstNode('eth_getLogs', [{ address: pool.address, fromBlock: hex(fromBlock), toBlock: hex(head), topics: [[TOPIC.OFTReceived, TOPIC.UnreceivedTokenCached]] }]);
        for (const l of decodeBridgeLogs(found).map((d, i) => ({ ...d, raw: found[i] }))) {
          if (l.event === 'OFTReceived' && l.guid === guid) delivered = l;
          if (l.event === 'UnreceivedTokenCached' && l.guid === guid) cached = l;
        }
        fromBlock = head + 1n;
      }
    } catch (e) {
      console.log(`  destination eth_getLogs error: ${errText(e)}`);
    }
    if (!(delivered && scanDeliveredAt) && !cached) await sleep(POLL_MS);
  }
  record.tracking = stateLog;
  const scanFinal = scanSeen.get(lower(hash))?.message ?? null;
  if (scanFinal) {
    record.scan = {
      messagesForTx: scanSeen.get(lower(hash)).count,
      guid: scanFinal.guid,
      status: scanFinal.status,
      pathway: scanFinal.pathway?.id,
      destinationTx: scanFinal.destination?.tx?.txHash ?? null,
      dvns: scanFinal.verification?.dvn?.dvns ?? null,
      outboundConfig: scanFinal.config?.outboundConfig ?? null,
      created: scanFinal.created,
      updated: scanFinal.updated,
    };
    console.log(`  Scan: GUID ${scanFinal.guid} (${scanFinal.guid === guid ? 'equals' : 'DIFFERS FROM'} OFTSent's), required DVNs ${JSON.stringify(scanFinal.config?.outboundConfig?.requiredDVNNames ?? null)}, confirmations ${scanFinal.config?.outboundConfig?.confirmations ?? '?'}, destination tx ${scanFinal.destination?.tx?.txHash ?? 'none'}`);
  }
  if (cached) {
    record.status = 'unreceived-token-cached';
    record.delivery = { cached };
    saveRun(run);
    throw new Error(`UnreceivedTokenCached on ${dst.name} for GUID ${guid} (tx ${cached.raw.transactionHash}). Stopped; nothing is retried.`);
  }
  if (!delivered || !scanDeliveredAt) {
    if (!record.status.startsWith('scan-')) record.status = delivered ? 'delivered-on-chain-scan-not-delivered' : 'not-delivered-in-20-minutes';
    record.delivery = delivered ? { oftReceived: delivered } : null;
    saveRun(run);
    throw new Error(`Leg ${leg.key} did not reach DELIVERED within 20 minutes (or Scan reported a non-delivery state): ${record.status}. Stopped; nothing is retried.`);
  }

  // Destination receipt on two endpoints and the balance delta.
  const dstHash = delivered.raw.transactionHash;
  const dstBlock = BigInt(delivered.raw.blockNumber);
  const [d1, d2] = await Promise.all([receiptOf(dstNode, dstHash), receiptOf(dstNode2, dstHash)]);
  const dBlock = await dstNode('eth_getBlockByNumber', [hex(dstBlock), false]);
  const dstTime = Number(BigInt(dBlock.timestamp));
  const dLogs = decodeBridgeLogs(d1.logs);
  expect(
    d1.status === '0x1' && d2.status === '0x1' && d1.blockHash === d2.blockHash && d1.gasUsed === d2.gasUsed && d1.logs.length === d2.logs.length,
    `destination delivery tx ${dstHash}: status ${d1.status} on ${host(dst.rpc)} and ${d2.status} on ${host(dst.second)}, block ${dstBlock}, gas used ${BigInt(d1.gasUsed)}, ${d1.logs.length} logs, sent by ${d1.from}`,
  );
  expect(
    lower(delivered.toAddress) === lower(sender) && delivered.srcEid === E.layerZeroEidFor(leg.source) && delivered.amountReceivedLD === oftSent.amountReceivedLD,
    `OFTReceived: GUID ${delivered.guid}, from eid ${delivered.srcEid}, to the dev EOA, amount ${delivered.amountReceivedLD}`,
  );
  expect(!scanFinal?.destination?.tx?.txHash || lower(scanFinal.destination.tx.txHash) === lower(dstHash), `Scan's destination tx equals the on-chain OFTReceived transaction`);
  const dstDeltas = [];
  for (const [n, url] of [[dstNode, dst.rpc], [dstNode2, dst.second]]) {
    try {
      const before = await balanceAt(n, sender, dstBlock - 1n);
      const after = await balanceAt(n, sender, dstBlock);
      dstDeltas.push({ host: host(url), before, after, delta: after - before });
      expect(after - before === delivered.amountReceivedLD, `destination balance delta on ${host(url)}: +${after - before} wei (block ${dstBlock - 1n} → ${dstBlock}) = OFTReceived amount ${delivered.amountReceivedLD}${after - before === delivered.amountReceivedLD ? ' — EXACT' : ' — MISMATCH'}`);
    } catch (e) {
      dstDeltas.push({ host: host(url), error: errText(e) });
      console.log(`  destination balance delta on ${host(url)}: unavailable (${errText(e)})`);
    }
  }
  const dstAfterNow = await Promise.all([dstNode, dstNode2].map((n) => n('eth_getBalance', [sender, 'latest']).then(BigInt)));
  const stargateFee = AMOUNT - delivered.amountReceivedLD;
  console.log(`  Stargate pool fee on this route: ${stargateFee} wei (${stargateFee === 0n ? 'none charged' : `${(Number(stargateFee) * 100) / Number(AMOUNT)}% of the amount`})`);
  const deliverySeconds = dstTime - sourceTime;
  console.log(`  delivery: source block time ${new Date(sourceTime * 1000).toISOString()}, destination block time ${new Date(dstTime * 1000).toISOString()} → ${deliverySeconds} s; Scan reported DELIVERED ${Math.round((scanDeliveredAt - sentAt) / 1000)} s after the send`);
  record.delivery = {
    txHash: dstHash,
    block: dstBlock,
    time: new Date(dstTime * 1000).toISOString(),
    executorFrom: d1.from,
    gasUsed: BigInt(d1.gasUsed),
    endpoints: [
      { host: host(dst.rpc), status: d1.status, blockHash: d1.blockHash },
      { host: host(dst.second), status: d2.status, blockHash: d2.blockHash },
    ],
    logs: dLogs,
    oftReceived: { guid: delivered.guid, srcEid: delivered.srcEid, toAddress: delivered.toAddress, amountReceivedLD: delivered.amountReceivedLD, logIndex: delivered.raw.logIndex },
    balanceDeltas: dstDeltas,
    balanceBeforeSend: dstBefore,
    balanceNow: dstAfterNow,
  };
  record.stargateFee = stargateFee;
  record.deliverySeconds = deliverySeconds;
  record.scanDeliveredSecondsAfterSend = Math.round((scanDeliveredAt - sentAt) / 1000);
  record.status = 'delivered';
  record.finishedAt = new Date().toISOString();
  saveRun(run);
  return record;
}

// ---------------------------------------------------------------------------
// Read-only re-verification of the recorded legs (BRIDGE_VERIFY=1)
// ---------------------------------------------------------------------------

/** SendLibBase.sol line 45 and SendUlnBase.sol line 16 (LayerZero-v2 9c741e7f). */
const FEE_TOPIC = {
  ExecutorFeePaid: ethersId('ExecutorFeePaid(address,uint256)'),
  DVNFeePaid: ethersId('DVNFeePaid(address[],address[],uint256[])'),
};

function feeSplit(logs, nativeFee) {
  let executor = null;
  let dvn = null;
  for (const l of logs) {
    if (l.topics[0] === FEE_TOPIC.ExecutorFeePaid) {
      const [who, fee] = coder.decode(['address', 'uint256'], l.data);
      executor = { address: who, fee };
    } else if (l.topics[0] === FEE_TOPIC.DVNFeePaid) {
      const [required, optional, fees] = coder.decode(['address[]', 'address[]', 'uint256[]'], l.data);
      dvn = { required: [...required], optional: [...optional], fees: [...fees] };
    }
  }
  const dvnTotal = dvn ? dvn.fees.reduce((a, b) => a + b, 0n) : 0n;
  const executorFee = executor ? executor.fee : 0n;
  return { executor, dvn, dvnTotal, remainder: nativeFee - executorFee - dvnTotal };
}

async function readReceiptEverywhere(chainId, hash, expectedInput) {
  const out = [];
  for (const which of ['rpc', 'second', 'third']) {
    const n = nodeFor(chainId, which);
    try {
      const [r, t, c] = await Promise.all([n('eth_getTransactionReceipt', [hash]), n('eth_getTransactionByHash', [hash]), n('web3_clientVersion', []).catch(() => 'unknown')]);
      const canonical = r ? await n('eth_getBlockByNumber', [r.blockNumber, false]) : null;
      out.push({
        host: host(CHAINS[chainId][which]),
        client: String(c).split('/').slice(0, 2).join('/'),
        status: r?.status ?? null,
        block: r ? BigInt(r.blockNumber) : null,
        blockHash: r?.blockHash ?? null,
        canonicalHashAtThatHeight: canonical?.hash ?? null,
        gasUsed: r ? BigInt(r.gasUsed) : null,
        effectiveGasPrice: r ? BigInt(r.effectiveGasPrice) : null,
        l1Fee: r?.l1Fee ? BigInt(r.l1Fee) : null,
        logs: r ? r.logs.length : null,
        inputMatches: expectedInput ? lower(t?.input ?? '') === lower(expectedInput) : null,
        receipt: r,
      });
    } catch (e) {
      out.push({ host: host(CHAINS[chainId][which]), error: errText(e) });
    }
  }
  return out;
}

async function deltasEverywhere(chainId, who, block) {
  const out = [];
  for (const which of ['rpc', 'second', 'third']) {
    const n = nodeFor(chainId, which);
    try {
      const before = await balanceAt(n, who, block - 1n);
      const after = await balanceAt(n, who, block);
      out.push({ host: host(CHAINS[chainId][which]), before, after, change: after - before });
    } catch (e) {
      out.push({ host: host(CHAINS[chainId][which]), error: errText(e) });
    }
  }
  return out;
}

async function verifyRecorded(run) {
  console.log('\n=== READ-ONLY RE-VERIFICATION of the recorded legs (nothing is signed or sent)');
  const sender = run.devEoa;
  const summary = {};
  for (const [key, leg] of Object.entries(run.legs ?? {})) {
    if (!leg.sourceTxHash) continue;
    console.log(`\n  -- leg ${leg.label}`);
    const src = await readReceiptEverywhere(leg.source, leg.sourceTxHash, leg.quote.data);
    const ok = src.filter((e) => !e.error && e.status);
    for (const e of src) {
      console.log(
        e.error
          ? `  ${e.host}: unavailable (${e.error})`
          : `  source on ${e.host} (${e.client}): status ${e.status}, block ${e.block}, hash ${e.blockHash} (canonical at that height: ${e.canonicalHashAtThatHeight}), gas ${e.gasUsed}, price ${e.effectiveGasPrice}${e.l1Fee !== null ? `, l1Fee ${e.l1Fee}` : ''}, ${e.logs} logs, input = engine calldata: ${e.inputMatches}`,
      );
    }
    const h0 = ok[0];
    expect(
      ok.length >= 2 && ok.every((e) => e.status === '0x1' && e.blockHash === h0.blockHash && e.blockHash === e.canonicalHashAtThatHeight && e.gasUsed === h0.gasUsed && e.effectiveGasPrice === h0.effectiveGasPrice && e.l1Fee === h0.l1Fee && e.logs === h0.logs && e.inputMatches),
      `${key}: the source receipt agrees on ${ok.length} endpoints and its block is canonical on each`,
    );
    const split = feeSplit(h0.receipt.logs, BigInt(leg.quote.nativeFee));
    console.log(
      `  LayerZero fee ${leg.quote.nativeFee} wei split in the send library's events: executor ${split.executor?.address} ${split.executor?.fee ?? 'n/a'}; DVN fees ${split.dvn ? split.dvn.required.map((a, i) => `${a} ${split.dvn.fees[i]}`).join(', ') : 'n/a'}; remainder (treasury share, inferred) ${split.remainder}`,
    );
    const srcDeltas = await deltasEverywhere(leg.source, sender, h0.block);
    const opFee = leg.source === OP_SEPOLIA ? await operatorFeeAt(nodeFor(leg.source), h0.receipt) : null;
    const expectedSrc = BigInt(leg.quote.value) + receiptFeePaid(h0.receipt, opFee ?? 0n).total;
    for (const d of srcDeltas) {
      if (d.error) console.log(`  source balance on ${d.host}: unavailable (${d.error})`);
      else expect(-d.change === expectedSrc, `${key}: source balance on ${d.host} fell by ${-d.change} wei = value + gas${h0.l1Fee !== null ? ' + L1 data fee' : ''} ${expectedSrc}`);
    }
    const dst = await readReceiptEverywhere(leg.destination, leg.delivery?.txHash, null);
    const dok = dst.filter((e) => !e.error && e.status);
    for (const e of dst) {
      console.log(e.error ? `  ${e.host}: unavailable (${e.error})` : `  destination on ${e.host} (${e.client}): status ${e.status}, block ${e.block}, hash ${e.blockHash} (canonical: ${e.canonicalHashAtThatHeight}), gas ${e.gasUsed}, ${e.logs} logs`);
    }
    const received = dok[0] ? decodeBridgeLogs(dok[0].receipt.logs).find((l) => l.event === 'OFTReceived') : null;
    expect(
      dok.length >= 2 && dok.every((e) => e.status === '0x1' && e.blockHash === dok[0].blockHash && e.blockHash === e.canonicalHashAtThatHeight) && received && received.guid === leg.guid && lower(received.toAddress) === lower(sender),
      `${key}: the destination receipt agrees on ${dok.length} endpoints, is canonical, and carries OFTReceived for GUID ${leg.guid} to the dev EOA (${received?.amountReceivedLD} wei)`,
    );
    const dstDeltas = await deltasEverywhere(leg.destination, sender, dok[0].block);
    for (const d of dstDeltas) {
      if (d.error) console.log(`  destination balance on ${d.host}: unavailable (${d.error})`);
      else expect(d.change === received.amountReceivedLD, `${key}: destination balance on ${d.host} rose by ${d.change} wei = OFTReceived ${received.amountReceivedLD}`);
    }
    // Finality of the source block at verification time.
    const [safe, fin] = await Promise.all(['safe', 'finalized'].map((tag) => nodeFor(leg.source)('eth_getBlockByNumber', [tag, false]).catch(() => null)));
    const finality = { safeHead: safe ? BigInt(safe.number) : null, finalizedHead: fin ? BigInt(fin.number) : null, sourceBlock: h0.block };
    console.log(`  source block ${h0.block}: safe head now ${finality.safeHead}, finalized head now ${finality.finalizedHead} (${host(CHAINS[leg.source].rpc)})`);
    summary[key] = {
      source: src.map(({ receipt, ...rest }) => rest),
      feeSplit: split,
      sourceBalance: srcDeltas,
      expectedSourceChange: -expectedSrc,
      destination: dst.map(({ receipt, ...rest }) => rest),
      destinationBalance: dstDeltas,
      finalityAtVerify: finality,
    };
  }
  const done = Object.values(run.legs ?? {}).filter((l) => l.status === 'delivered');
  run.totals = {
    legsDelivered: done.length,
    spentFromSources: done.reduce((s, l) => s + BigInt(l.spent), 0n),
    receivedOnDestinations: done.reduce((s, l) => s + BigInt(l.delivery.oftReceived.amountReceivedLD), 0n),
  };
  run.totals.netCost = run.totals.spentFromSources - run.totals.receivedOnDestinations;
  run.verification = { at: new Date().toISOString(), failures, legs: summary };
  saveRun(run);
  console.log(`\nTotals: ${run.totals.legsDelivered} leg(s) delivered; left the sources ${fmt(run.totals.spentFromSources)} ETH (${run.totals.spentFromSources} wei); arrived ${fmt(run.totals.receivedOnDestinations)} ETH; net cost ${fmt(run.totals.netCost)} ETH (${run.totals.netCost} wei).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const registry = new ChainRegistry();
registry.register(evmKeyProvider);
const devPath = new URL('../../.dev-wallet/mnemonic.txt', import.meta.url);
if (!existsSync(devPath)) {
  console.error('No .dev-wallet/mnemonic.txt: the dev EOA is needed even for the dry run (it is the simulated sender).');
  process.exit(1);
}
const signer = HdKeyring.fromMnemonic(readFileSync(devPath, 'utf8').trim(), registry).getAccount('eip155:1');
const sender = getAddress(signer.address);
let commit = 'unknown';
try {
  commit = execSync('git rev-parse HEAD', { cwd: new URL('../../', import.meta.url) }).toString().trim();
} catch {}

const run = loadRun() ?? { createdAt: new Date().toISOString(), legs: {} };
run.devEoa = sender;
run.engineCommit = commit;
run.amountPerLeg = AMOUNT;
run.caps = { amountPerLeg: AMOUNT_CAP, totalSpend: TOTAL_SPEND_CAP, minSourceLeft: MIN_SOURCE_LEFT };
console.log(`Bridge smoke: dev EOA ${sender}; engine at ${commit.slice(0, 7)}; amount ${fmt(AMOUNT)} ETH per leg; mode ${process.env.BRIDGE_VERIFY === '1' ? 'read-only re-verification' : LIVE ? `LIVE ${LIVE}` : 'dry run'}`);

try {
  if (process.env.BRIDGE_VERIFY === '1') {
    await verifyRecorded(run);
    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }
  if (process.env.BRIDGE_SKIP_DRY !== '1') await dryRun(sender, run);
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed in the dry run. Nothing live was attempted.`);
    process.exit(1);
  }
  if (LIVE) {
    const legs = LIVE === '1' ? [LEGS['sepolia-op'], LEGS['op-arb']] : [LEGS[LIVE]];
    for (const leg of legs) {
      await liveLeg(leg, signer, run);
      if (failures > 0) throw new Error(`${failures} check(s) failed during leg ${leg.key}. Stopped before any further leg.`);
    }
    const legsDone = Object.values(run.legs).filter((l) => l.status === 'delivered');
    run.totals = {
      legsDelivered: legsDone.length,
      spentFromSources: legsDone.reduce((s, l) => s + BigInt(l.spent), 0n),
      receivedOnDestinations: legsDone.reduce((s, l) => s + BigInt(l.delivery.oftReceived.amountReceivedLD), 0n),
    };
    run.totals.netCost = run.totals.spentFromSources - run.totals.receivedOnDestinations;
    saveRun(run);
    console.log(`\nTotals: ${run.totals.legsDelivered} leg(s) delivered; left the sources ${fmt(run.totals.spentFromSources)} ETH; arrived ${fmt(run.totals.receivedOnDestinations)} ETH; net cost ${fmt(run.totals.netCost)} ETH (${run.totals.netCost} wei).`);
  }
} catch (e) {
  console.log(`\nSTOPPED: ${errText(e)}`);
  saveRun(run);
  process.exit(1);
}
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`}; record ${RUN_FILE.pathname.replace(/^.*\/scripts\//, 'scripts/')}`);
process.exit(failures === 0 ? 0 : 1);

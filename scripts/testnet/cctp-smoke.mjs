/**
 * CCTP V2 smoke test (phase 23 item 4, the script leg): Circle's USDC
 * through a Standard Transfer, quoted and built by the ENGINE's CCTP V2
 * adapter (packages/chains-evm/src/bridge/cctp-v2.ts). Test networks only.
 * The live proof it delivers is docs/BRIDGING.md section 11; the results
 * are recorded in section 17.
 *
 * As in bridge-smoke.mjs, the point is to prove the engine's own calldata:
 * every source transaction is one of the adapter's quote.calls (the exact
 * approve, then depositForBurn), and the destination mint is the call the
 * adapter's track() builds from Circle's attestation. The script copies
 * `to`, `value` and `data` from those calls unchanged and adds only the
 * nonce, the gas limit (eth_estimateGas + 20%) and the EIP-1559 fees, then
 * signs with the engine's signEip1559. ethers is used only to check the
 * engine's work (it re-encodes every call, decodes events and recovers the
 * attesters); it never builds what is sent, except the deliberately broken
 * calls of the simulated negatives, which are never broadcast.
 *
 * DRY RUN (default; nothing is signed or sent):
 *   - the engine's dist for the bridge modules equals its source (a
 *     TypeScript transpile of src/bridge/*.ts compared with dist/bridge/*.js);
 *   - Circle's documentation is fetched again and compared with the
 *     adapter: the testnet contract-address table (TokenMessengerV2,
 *     MessageTransmitterV2, TokenMinterV2 for domains 0, 2, 3, 6), the domain
 *     table, the GET /v2/messages/{sourceDomainId} reference with
 *     `security: []`, the fees page, and the sandbox fee endpoint for the
 *     routes used (Standard = finality 2000 must be 0);
 *   - on-chain, on two endpoints per network, for all four networks the
 *     adapter serves: chain id, code at the three addresses and its hash,
 *     MessageTransmitterV2.localDomain() and version(), TokenMessengerV2
 *     wiring (localMessageTransmitter, localMinter, messageBodyVersion,
 *     remoteTokenMessengers for the other three domains), TokenMinterV2
 *     getLocalToken for the other three USDCs and burnLimitsPerMessage,
 *     USDC.isMinter(TokenMinterV2), paused() on MessageTransmitterV2 and
 *     TokenMinterV2, signatureThreshold and the enabled-attester count,
 *     isDenylisted(dev EOA);
 *   - the adapter's quote for each leg: ethers re-encodes approve and
 *     depositForBurn byte for byte, every pin reads its own word, the fee
 *     line is zero, and eth_simulateV1 of [approve, depositForBurn] from the
 *     dev EOA succeeds with DepositForBurn and MessageSent decoded;
 *   - the engine's refusals (amount 0, a minimum above the amount, a route
 *     the adapter does not list, an unverified domain, a finality threshold
 *     other than 2000 / 1000, maxFee ≥ amount, a zero recipient, a bad
 *     checksum) and what it does NOT refuse (the encoder accepts finality
 *     1000; only the quote never produces it);
 *   - simulated negatives of hand-altered calls (never broadcast): maxFee =
 *     amount ("Max fee must be less than amount"), a destination domain
 *     with no remote messenger, an approval one base unit short.
 *
 * LIVE (CCTP_LIVE), from the dev EOA to the dev EOA's own address only:
 *   CCTP_LIVE=base-arb      1 USDC Base Sepolia → Arbitrum Sepolia
 *   CCTP_LIVE=sepolia-base  1 USDC Ethereum Sepolia → Base Sepolia
 *   CCTP_LIVE=1             both, in that order
 * For each leg: a fresh quote and simulation; the exact approve; the burn
 * (re-simulated after the approval is mined); both receipts on two
 * endpoints with the engine's calldata compared; DepositForBurn, MessageSent
 * and the Transfers decoded; the USDC balance and totalSupply deltas
 * (block − 1 → block) reconciled, other mints and burns in the same block
 * accounted for by their own Transfer logs; Circle's sandbox attestation
 * polled through the adapter's track() and the raw answers timed; the
 * attested message compared with the MessageSent message (only the nonce,
 * the executed finality, the executed fee and the expiration block may
 * differ) and its two signatures recovered and checked against the
 * destination's enabled attesters; eth_simulateV1 of [mint, mint] (the
 * second must revert "Nonce already used") and of a tampered message (must
 * revert); the mint from the dev EOA; MessageReceived, MintAndWithdraw and
 * the Transfer decoded; the destination deltas reconciled; usedNonces = 1;
 * track() then reporting "delivered"; and the replay as an eth_call only
 * (it must revert; nothing expected to revert is broadcast).
 *
 * HARD CAPS (inside the script): at most 1 USDC per leg and 3 USDC in total
 * across the recorded legs; at most 0.003 ETH of worst-case fees per network
 * across the recorded legs (gas limit × max fee, plus 1.5 × the L1 data fee
 * estimate on OP-stack chains), checked before every transaction. A leg
 * recorded as done is not sent again unless CCTP_REPEAT=1.
 *
 * CCTP_VERIFY=1 (read-only): re-reads every recorded hash on three
 * endpoints per network (status, block, block hash, gas used).
 *
 * Every public fact is written to scripts/testnet/runs/cctp-run.json
 * (git-ignored) after each step.
 *
 * Run from the repository root (the engine's dist must be built):
 *   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
 *   node scripts/testnet/cctp-smoke.mjs
 *   CCTP_LIVE=base-arb node scripts/testnet/cctp-smoke.mjs
 *
 * Secrets: the dev mnemonic is read from the git-ignored .dev-wallet and
 * never printed. Every endpoint used is keyless; error texts are still
 * stripped of URLs before printing.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { AbiCoder, Interface, getAddress, id as ethersId, keccak256, recoverAddress, zeroPadValue } from 'ethers';
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
/**
 * Endpoints: the app profiles' keyless defaults (app/src/config/evm-chain.ts)
 * as used by bridge-smoke.mjs. `history` lists the endpoints that serve
 * balances at a past block (PublicNode's Arbitrum Sepolia endpoint refuses
 * historical state, docs/BRIDGING.md 15.16).
 */
const CHAINS = {
  [SEPOLIA]: {
    name: 'Ethereum Sepolia',
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    second: 'https://eth-sepolia-testnet.api.pocket.network',
    third: 'https://sepolia.drpc.org',
    history: ['rpc', 'second'],
    explorer: 'https://sepolia.etherscan.io/tx/',
    opStack: false,
  },
  [OP_SEPOLIA]: {
    name: 'OP Sepolia',
    rpc: 'https://optimism-sepolia-rpc.publicnode.com',
    second: 'https://sepolia.optimism.io',
    third: 'https://op-sepolia-testnet.api.pocket.network',
    history: ['rpc', 'second'],
    explorer: 'https://sepolia-optimism.etherscan.io/tx/',
    opStack: true,
  },
  [ARB_SEPOLIA]: {
    name: 'Arbitrum Sepolia',
    rpc: 'https://arbitrum-sepolia-rpc.publicnode.com',
    second: 'https://sepolia-rollup.arbitrum.io/rpc',
    third: 'https://arb-sepolia-testnet.api.pocket.network',
    history: ['second', 'third'],
    explorer: 'https://sepolia.arbiscan.io/tx/',
    opStack: false,
  },
  [BASE_SEPOLIA]: {
    name: 'Base Sepolia',
    rpc: 'https://base-sepolia-rpc.publicnode.com',
    second: 'https://sepolia.base.org',
    third: null,
    history: ['rpc', 'second'],
    explorer: 'https://sepolia.basescan.org/tx/',
    opStack: true,
  },
};
const IRIS = 'https://iris-api-sandbox.circle.com';
const DOCS = {
  addresses: 'https://developers.circle.com/cctp/evm-smart-contracts.md',
  domains: 'https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md',
  messages: 'https://developers.circle.com/api-reference/cctp/all/get-messages-v2.md',
  fees: 'https://developers.circle.com/cctp/concepts/fees.md',
};
/** Circle's documented names for the four test networks in the address tables. */
const DOC_NAMES = { [SEPOLIA]: 'Ethereum Sepolia', [OP_SEPOLIA]: 'OP Sepolia', [ARB_SEPOLIA]: 'Arbitrum Sepolia', [BASE_SEPOLIA]: 'Base Sepolia' };
/** Circle's domain table names the main networks; each test network carries its main network's domain. */
const DOC_DOMAIN_NAMES = { [SEPOLIA]: 'Ethereum', [OP_SEPOLIA]: 'OP Mainnet', [ARB_SEPOLIA]: 'Arbitrum', [BASE_SEPOLIA]: 'Base' };

const USDC_UNIT = 1_000_000n;
const AMOUNT = BigInt(process.env.CCTP_AMOUNT ?? USDC_UNIT); // 1 USDC
const AMOUNT_CAP = USDC_UNIT; // at most 1 USDC per leg
const TOTAL_USDC_CAP = 3n * USDC_UNIT; // at most 3 USDC across the recorded legs
const FEE_CAP_PER_CHAIN = 3n * 10n ** 15n; // at most 0.003 ETH of worst-case fees per network
const ATTESTATION_TIMEOUT_MS = 60 * 60 * 1000;
const POLL_MS = 10_000;
const LEGS = {
  'base-arb': { key: 'base-arb', label: 'Base Sepolia → Arbitrum Sepolia', source: BASE_SEPOLIA, destination: ARB_SEPOLIA },
  'sepolia-base': { key: 'sepolia-base', label: 'Ethereum Sepolia → Base Sepolia', source: SEPOLIA, destination: BASE_SEPOLIA },
};
const LIVE = process.env.CCTP_LIVE ?? '';
const RUN_FILE = new URL('./runs/cctp-run.json', import.meta.url);

if (AMOUNT <= 0n || AMOUNT > AMOUNT_CAP) {
  console.error(`CCTP_AMOUNT must be a positive number of USDC base units, at most ${AMOUNT_CAP} (1 USDC).`);
  process.exit(1);
}
if (LIVE && LIVE !== '1' && !LEGS[LIVE]) {
  console.error('CCTP_LIVE must be 1, base-arb or sepolia-base.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const host = (url) => new URL(url).host;
const lower = (a) => String(a).toLowerCase();
const hex = (n) => '0x' + BigInt(n).toString(16);
const fmtEth = (wei) => {
  const neg = wei < 0n;
  const s = (neg ? -wei : wei).toString().padStart(19, '0');
  const out = `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '') || '0';
  return neg ? `-${out}` : out;
};
const fmtUsdc = (units) => {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(7, '0');
  const out = `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, '') || '0';
  return neg ? `-${out}` : out;
};
/** Removes anything that looks like a URL from an error text (the endpoints are keyless, but the rule is general). */
const mask = (text) => String(text).replace(/https?:\/\/[^\s"')]+/g, '<url>');
const errText = (e) => mask(e?.message ?? e).slice(0, 400);
const toJson = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

let failures = 0;
const expect = (ok, text) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failures += 1;
  return !!ok;
};

const transports = {};
function nodeFor(chainId, which = 'rpc') {
  const key = `${chainId}:${which}`;
  if (!transports[key]) {
    const url = CHAINS[chainId][which];
    if (!url) throw new Error(`No ${which} endpoint configured for ${CHAINS[chainId].name}.`);
    const raw = E.httpTransport(url);
    transports[key] = async (method, params) => {
      try {
        return await raw(method, params);
      } catch (e) {
        throw new Error(`${host(url)}: ${errText(e)}`);
      }
    };
  }
  return transports[key];
}
const endpointsOf = (chainId) => ['rpc', 'second', 'third'].filter((w) => CHAINS[chainId][w]);

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
// ABI fragments, from the Circle sources at evm-cctp-contracts commit
// 63ab1f0ac06ce0793c0bbfbb8d09816bc211386d (the commit Circle's technical
// guide links): TokenMessengerV2.sol lines 50-61 (DepositForBurn) and 307-309
// (the amount, recipient and maxFee checks); BaseTokenMessenger.sol lines
// 72-77 (MintAndWithdraw), 81-90 (public state); MessageTransmitterV2.sol
// lines 38 (MessageSent), 49-56 (MessageReceived), 206-262 (receiveMessage),
// 295-313 (validation: destination domain, caller, version, "Nonce already
// used"); BaseMessageTransmitter.sol lines 44-58 (NONCE_USED, localDomain,
// version, usedNonces); Attestable.sol lines 61, 117, 226-258 (threshold,
// enabled attesters, signatures over keccak256(message) in increasing signer
// order); TokenController.sol line 69 (burnLimitsPerMessage); TokenMinter.sol
// line 183 (getLocalToken); Pausable.sol line 35 (paused); Denylistable.sol
// line 137 (isDenylisted).
// ---------------------------------------------------------------------------

const coder = AbiCoder.defaultAbiCoder();
const tmIface = new Interface([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
  'function localMessageTransmitter() view returns (address)',
  'function localMinter() view returns (address)',
  'function messageBodyVersion() view returns (uint32)',
  'function remoteTokenMessengers(uint32) view returns (bytes32)',
  'function isDenylisted(address) view returns (bool)',
  'event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)',
  'event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)',
]);
const mtIface = new Interface([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
  'function localDomain() view returns (uint32)',
  'function version() view returns (uint32)',
  'function usedNonces(bytes32) view returns (uint256)',
  'function paused() view returns (bool)',
  'function signatureThreshold() view returns (uint256)',
  'function getNumEnabledAttesters() view returns (uint256)',
  'function isEnabledAttester(address) view returns (bool)',
  'event MessageSent(bytes message)',
  'event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)',
]);
const minterIface = new Interface([
  'function getLocalToken(uint32 remoteDomain, bytes32 remoteToken) view returns (address)',
  'function burnLimitsPerMessage(address) view returns (uint256)',
  'function paused() view returns (bool)',
]);
const usdcIface = new Interface([
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function isMinter(address) view returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);
const TOPIC = {
  DepositForBurn: tmIface.getEvent('DepositForBurn').topicHash,
  MintAndWithdraw: tmIface.getEvent('MintAndWithdraw').topicHash,
  MessageSent: mtIface.getEvent('MessageSent').topicHash,
  MessageReceived: mtIface.getEvent('MessageReceived').topicHash,
  Transfer: usdcIface.getEvent('Transfer').topicHash,
  Approval: usdcIface.getEvent('Approval').topicHash,
};
const ZERO32 = '0x' + '0'.repeat(64);
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const SYSTEM_ADDRESS = '0xfffffffffffffffffffffffffffffffffffffffe'; // EIP-7708 protocol transfer logs (Ethereum Sepolia)

/** MessageV2 layout (MessageV2.sol lines 52-61 at 63ab1f0a) and BurnMessageV2 (BurnMessage.sol 35-43, BurnMessageV2.sol 49-52). */
const MSG = { version: [0, 4], sourceDomain: [4, 8], destinationDomain: [8, 12], nonce: [12, 44], sender: [44, 76], recipient: [76, 108], destinationCaller: [108, 140], minFinalityThreshold: [140, 144], finalityThresholdExecuted: [144, 148], body: 148 };
const BODY = { version: [0, 4], burnToken: [4, 36], mintRecipient: [36, 68], amount: [68, 100], messageSender: [100, 132], maxFee: [132, 164], feeExecuted: [164, 196], expirationBlock: [196, 228], hookData: 228 };
function slice(hexStr, [a, b]) {
  return '0x' + hexStr.slice(2 + a * 2, 2 + b * 2);
}
function decodeMessage(messageHex) {
  const m = messageHex.toLowerCase();
  const body = '0x' + m.slice(2 + MSG.body * 2);
  const n = (r) => BigInt(slice(m, r));
  const b = (r) => BigInt(slice(body, r));
  const addr = (h, r) => getAddress('0x' + slice(h, r).slice(26));
  return {
    bytes: (m.length - 2) / 2,
    version: Number(n(MSG.version)),
    sourceDomain: Number(n(MSG.sourceDomain)),
    destinationDomain: Number(n(MSG.destinationDomain)),
    nonce: slice(m, MSG.nonce),
    sender: slice(m, MSG.sender),
    recipient: slice(m, MSG.recipient),
    destinationCaller: slice(m, MSG.destinationCaller),
    minFinalityThreshold: Number(n(MSG.minFinalityThreshold)),
    finalityThresholdExecuted: Number(n(MSG.finalityThresholdExecuted)),
    body,
    burn: {
      version: Number(b(BODY.version)),
      burnToken: addr(body, BODY.burnToken),
      mintRecipient: addr(body, BODY.mintRecipient),
      amount: b(BODY.amount),
      messageSender: addr(body, BODY.messageSender),
      maxFee: b(BODY.maxFee),
      feeExecuted: b(BODY.feeExecuted),
      expirationBlock: b(BODY.expirationBlock),
      hookData: '0x' + body.slice(2 + BODY.hookData * 2),
    },
  };
}
/** The byte ranges Circle fills in after the burn (nonce, executed finality; in the body, executed fee and expiration block). */
const FILLED_RANGES = [MSG.nonce, MSG.finalityThresholdExecuted, [MSG.body + BODY.feeExecuted[0], MSG.body + BODY.feeExecuted[1]], [MSG.body + BODY.expirationBlock[0], MSG.body + BODY.expirationBlock[1]]];
function maskFilled(messageHex) {
  let h = messageHex.toLowerCase().slice(2);
  for (const [a, b] of FILLED_RANGES) h = h.slice(0, a * 2) + '0'.repeat((b - a) * 2) + h.slice(b * 2);
  return h;
}

function decodeLogs(logs) {
  const out = [];
  for (const l of logs) {
    const t0 = l.topics[0];
    try {
      if (t0 === TOPIC.DepositForBurn) {
        const p = tmIface.parseLog(l);
        out.push({ event: 'DepositForBurn', address: getAddress(l.address), burnToken: p.args.burnToken, amount: p.args.amount, depositor: p.args.depositor, mintRecipient: p.args.mintRecipient, destinationDomain: Number(p.args.destinationDomain), destinationTokenMessenger: p.args.destinationTokenMessenger, destinationCaller: p.args.destinationCaller, maxFee: p.args.maxFee, minFinalityThreshold: Number(p.args.minFinalityThreshold), hookData: p.args.hookData });
      } else if (t0 === TOPIC.MessageSent) {
        const p = mtIface.parseLog(l);
        out.push({ event: 'MessageSent', address: getAddress(l.address), message: p.args.message });
      } else if (t0 === TOPIC.MessageReceived) {
        const p = mtIface.parseLog(l);
        out.push({ event: 'MessageReceived', address: getAddress(l.address), caller: p.args.caller, sourceDomain: Number(p.args.sourceDomain), nonce: p.args.nonce, sender: p.args.sender, finalityThresholdExecuted: Number(p.args.finalityThresholdExecuted), messageBody: p.args.messageBody });
      } else if (t0 === TOPIC.MintAndWithdraw) {
        const p = tmIface.parseLog(l);
        out.push({ event: 'MintAndWithdraw', address: getAddress(l.address), mintRecipient: p.args.mintRecipient, amount: p.args.amount, mintToken: p.args.mintToken, feeCollected: p.args.feeCollected });
      } else if (t0 === TOPIC.Transfer && lower(l.address) === SYSTEM_ADDRESS) {
        out.push({ event: 'EIP-7708 Transfer', from: getAddress('0x' + l.topics[1].slice(26)), to: getAddress('0x' + l.topics[2].slice(26)), amount: BigInt(l.data) });
      } else if (t0 === TOPIC.Transfer && l.topics.length === 3) {
        out.push({ event: 'Transfer', address: getAddress(l.address), from: getAddress('0x' + l.topics[1].slice(26)), to: getAddress('0x' + l.topics[2].slice(26)), value: BigInt(l.data) });
      } else if (t0 === TOPIC.Approval && l.topics.length === 3) {
        out.push({ event: 'Approval', address: getAddress(l.address), owner: getAddress('0x' + l.topics[1].slice(26)), spender: getAddress('0x' + l.topics[2].slice(26)), value: BigInt(l.data) });
      } else {
        out.push({ event: `other ${t0.slice(0, 10)}`, address: getAddress(l.address) });
      }
    } catch (e) {
      out.push({ event: `undecodable ${t0.slice(0, 10)}`, address: l.address, error: errText(e) });
    }
  }
  return out;
}

async function call(chainId, to, iface, fn, args = [], which = 'rpc', block = 'latest') {
  const data = iface.encodeFunctionData(fn, args);
  const res = await nodeFor(chainId, which)('eth_call', [{ to, data }, block]);
  const decoded = iface.decodeFunctionResult(fn, res);
  return decoded.length === 1 ? decoded[0] : decoded;
}

async function receiptOf(node, hash, tries = 90) {
  for (let i = 0; i < tries; i++) {
    const r = await node('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) return r;
    await sleep(4000);
  }
  throw new Error(`No receipt for ${hash} after ${(tries * 4) / 60} minutes`);
}

/** eth_simulateV1 of calls from `from` in one block; the per-call results. Tries the second endpoint when the first does not serve the method. */
async function simulate(chainId, from, calls) {
  const payload = {
    blockStateCalls: [{ calls: calls.map((c) => ({ from, to: c.to, ...(c.value ? { value: hex(c.value) } : {}), input: typeof c.data === 'string' ? c.data : E.toHex(c.data) })) }],
    traceTransfers: true,
  };
  let lastError;
  for (const which of ['rpc', 'second']) {
    try {
      const [block] = await nodeFor(chainId, which)('eth_simulateV1', [payload, 'latest']);
      return {
        endpoint: host(CHAINS[chainId][which]),
        results: block.calls.map((c) => ({
          ok: c.status === '0x1',
          gasUsed: BigInt(c.gasUsed),
          revertData: c.status === '0x1' ? null : (c.error?.data ?? c.returnData ?? null),
          revertMessage: c.status === '0x1' ? null : (c.error?.message ?? null),
          logs: c.logs ?? [],
        })),
      };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
/** The revert reason string of Error(string) data, or the raw data. */
function reason(r) {
  const d = r.revertData;
  if (typeof d === 'string' && d.startsWith('0x08c379a0')) {
    try {
      return coder.decode(['string'], '0x' + d.slice(10))[0];
    } catch {}
  }
  return `${r.revertMessage ?? ''} ${d ?? ''}`.trim();
}

// ---------------------------------------------------------------------------
// The engine's adapter, wired as the app would wire it
// ---------------------------------------------------------------------------

/** Every raw Iris answer, per source transaction, with its time. */
const irisSeen = new Map();
async function irisGet(sourceDomain, sourceTxHash) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${IRIS}/v2/messages/${sourceDomain}?transactionHash=${sourceTxHash}`, { signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { httpStatus: response.status, body, text: text.slice(0, 2000) };
  } finally {
    clearTimeout(timer);
  }
}
/** The injected attestation reader (BridgeProvider contract: pending or complete with message and attestation). */
async function fetchAttestation({ sourceDomain, sourceTxHash }) {
  const at = Date.now();
  const answer = await irisGet(sourceDomain, sourceTxHash);
  const list = irisSeen.get(lower(sourceTxHash)) ?? [];
  const m = answer.body?.messages?.[0];
  list.push({ at: new Date(at).toISOString(), ms: at, httpStatus: answer.httpStatus, count: answer.body?.messages?.length ?? 0, status: m?.status ?? null, delayReason: m?.delayReason ?? null, attestation: m?.attestation ? (m.attestation === 'PENDING' ? 'PENDING' : `${(m.attestation.length - 2) / 2} bytes`) : null, message: m?.message ? `${(m.message.length - 2) / 2} bytes` : null });
  irisSeen.set(lower(sourceTxHash), list);
  if (answer.httpStatus === 404) return { status: 'pending' };
  if (answer.httpStatus !== 200) throw new Error(`Circle's Iris sandbox answered HTTP ${answer.httpStatus}`);
  if (!m) return { status: 'pending' };
  if (answer.body.messages.length !== 1) throw new Error(`Iris returned ${answer.body.messages.length} messages for one burn; refusing to pick one.`);
  if (m.status === 'complete' && /^0x[0-9a-fA-F]+$/.test(m.message ?? '') && /^0x[0-9a-fA-F]+$/.test(m.attestation ?? '')) {
    return { status: 'complete', message: m.message, attestation: m.attestation };
  }
  return { status: 'pending' };
}
/** The injected mint checker: MessageTransmitterV2.usedNonces(nonce of the attested message) on the destination. */
async function isMinted({ destinationChainId, message }) {
  const nonce = decodeMessage(message).nonce;
  return (await call(destinationChainId, E.CCTP_V2_TESTNET.messageTransmitterV2, mtIface, 'usedNonces', [nonce])) === 1n;
}

const cctp = E.createCctpV2Provider({ fetchAttestation, isMinted });
const registry = E.createBridgeRegistry([cctp]);
const provider = registry.require(E.CCTP_V2_PROVIDER_ID);
const TM = E.CCTP_V2_TESTNET.tokenMessengerV2;
const MT = E.CCTP_V2_TESTNET.messageTransmitterV2;
const MINTER = E.CCTP_V2_TESTNET.tokenMinterV2;
const usdcOn = (chainId) => E.CCTP_V2_TESTNET_USDC[chainId];
const domainOf = (chainId) => E.CCTP_V2_TESTNET_DOMAINS[chainId];

function routeFor(source, destination) {
  const route = provider.supportedRoutes().find((r) => r.sourceChainId === source && r.destinationChainId === destination);
  if (!route) throw new Error(`The adapter lists no route ${source} → ${destination}.`);
  return route;
}

/** Independent checks of the adapter's two source calls. */
function checkBuiltCalls(quote, sender, label) {
  const r = quote.route;
  const usdc = usdcOn(r.sourceChainId);
  expect(quote.calls.length === 2 && quote.calls[0].purpose === 'approve' && quote.calls[1].purpose === 'bridge', `${label}: two calls, the exact approve then the bridge call`);
  const [approve, burn] = quote.calls;
  const approveHex = E.toHex(approve.data);
  const burnHex = E.toHex(burn.data);
  expect(lower(approve.to) === lower(usdc) && approve.value === 0n && approve.valueLimit === 0n, `${label}: approve targets the source USDC ${usdc}, value 0`);
  expect(approveHex === usdcIface.encodeFunctionData('approve', [TM, quote.amountIn]), `${label}: ethers' approve(TokenMessengerV2, ${quote.amountIn}) is byte-identical (${(approveHex.length - 2) / 2} bytes)`);
  expect(lower(burn.to) === lower(TM) && burn.value === 0n && burn.valueLimit === 0n, `${label}: depositForBurn targets TokenMessengerV2 ${TM}, value 0`);
  const ethersBurn = tmIface.encodeFunctionData('depositForBurn', [quote.amountIn, domainOf(r.destinationChainId), zeroPadValue(sender, 32), usdc, ZERO32, 0n, 2000]);
  expect(burnHex === ethersBurn && burn.selector === E.CCTP_DEPOSIT_FOR_BURN_SELECTOR && burnHex.startsWith(E.CCTP_DEPOSIT_FOR_BURN_SELECTOR), `${label}: ethers' depositForBurn(${quote.amountIn}, ${domainOf(r.destinationChainId)}, bytes32(dev EOA), USDC, 0, maxFee 0, 2000) is byte-identical (${(burnHex.length - 2) / 2} bytes, selector ${E.CCTP_DEPOSIT_FOR_BURN_SELECTOR})`);
  const readPins = (c, h) => c.pins.every((p) => p.rule.condition === 'equal' && BigInt('0x' + h.slice(10 + p.rule.offset * 2, 10 + p.rule.offset * 2 + 64)) === BigInt(p.rule.params[0]));
  expect(approve.pins.length === 2 && readPins(approve, approveHex), `${label}: the approve's 2 pins (spender, amount) are "equal" rules that read their own word`);
  expect(burn.pins.length === 7 && readPins(burn, burnHex) && burn.unpinnable.length === 0, `${label}: depositForBurn's 7 pins (${burn.pins.map((p) => `${p.field}@${p.rule.offset}`).join(', ')}) read their own words; nothing unpinnable`);
  expect(quote.approvals.length === 1 && quote.approvals[0].amount === quote.amountIn && lower(quote.approvals[0].spender) === lower(TM), `${label}: one exact approval of ${quote.amountIn} to TokenMessengerV2`);
  expect(quote.fees.length === 1 && quote.fees[0].amount === 0n && quote.expectedAmountOut === quote.amountIn && quote.minAmountOut === quote.amountIn, `${label}: one fee line, Circle's protocol fee 0; expected = minimum = the amount`);
  return { approve, burn, approveHex, burnHex };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/** The bridge modules in dist equal a fresh transpile of their source (no stale build). */
function checkDistEqualsSource() {
  const require = createRequire(import.meta.url);
  const ts = require('../../node_modules/typescript');
  const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
  const files = ['bridge/cctp-v2', 'bridge/util', 'bridge/registry', 'bridge/types', 'bridge/index', 'eoa-tx', 'abi', 'encoding', 'erc20'];
  const same = files.every((f) => {
    const src = readFileSync(new URL(`../../packages/chains-evm/src/${f}.ts`, import.meta.url), 'utf8');
    const out = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const dist = readFileSync(new URL(`../../packages/chains-evm/dist/${f}.js`, import.meta.url), 'utf8');
    return norm(out) === norm(dist);
  });
  expect(same, `the engine's dist equals a transpile of its source for ${files.join(', ')}`);
}

async function fetchDoc(url) {
  const response = await fetch(url);
  const text = await response.text();
  return { status: response.status, text, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') };
}

async function checkDocs(run) {
  console.log('\n  -- Circle documentation, fetched now');
  const docs = {};
  for (const [k, url] of Object.entries(DOCS)) {
    docs[k] = await fetchDoc(url);
    expect(docs[k].status === 200, `${url} → HTTP ${docs[k].status}, ${docs[k].bytes} bytes, sha256 ${docs[k].sha256.slice(0, 16)}…`);
  }
  const testnet = docs.addresses.text.split('## Testnet contract addresses')[1] ?? '';
  const table = (heading) => (testnet.split(`### ${heading}`)[1] ?? '').split('### ')[0];
  for (const [heading, expected] of [['TokenMessengerV2', TM], ['MessageTransmitterV2', MT], ['TokenMinterV2', MINTER]]) {
    const rows = table(heading);
    for (const chainId of [SEPOLIA, OP_SEPOLIA, ARB_SEPOLIA, BASE_SEPOLIA]) {
      const m = rows.match(new RegExp(`\\|\\s*\\*\\*${DOC_NAMES[chainId]}\\*\\*\\s*\\|\\s*(\\d+)\\s*\\|\\s*\\[?\`(0x[0-9a-fA-F]{40})\``));
      expect(m && Number(m[1]) === domainOf(chainId) && m[2] === expected, `Circle's testnet table, ${heading}, ${DOC_NAMES[chainId]}: domain ${m?.[1]}, ${m?.[2]} = the adapter's (${domainOf(chainId)}, ${expected})`);
    }
  }
  const domainTable = docs.domains.text.split('## Domain identifiers')[1] ?? '';
  for (const chainId of [SEPOLIA, OP_SEPOLIA, ARB_SEPOLIA, BASE_SEPOLIA]) {
    const m = domainTable.match(new RegExp(`\\|\\s*(\\d+)\\s*\\|\\s*${DOC_DOMAIN_NAMES[chainId]}\\s*\\|`));
    expect(m && Number(m[1]) === domainOf(chainId), `Circle's domain table: ${DOC_DOMAIN_NAMES[chainId]} = ${m?.[1]} = the adapter's domain for ${CHAINS[chainId].name}`);
  }
  expect(docs.messages.text.includes('/v2/messages/{sourceDomainId}:') && docs.messages.text.includes('security: []') && docs.messages.text.includes('- pending_confirmations'), 'the API reference documents GET /v2/messages/{sourceDomainId}?transactionHash=…, with "security: []" (no key) and the statuses complete / pending_confirmations');
  expect(docs.fees.text.includes('Standard Transfers are free.'), 'the fees page says "CCTP charges fees on Fast Transfers only. Standard Transfers are free."');
  run.docs = Object.fromEntries(Object.entries(docs).map(([k, d]) => [k, { url: DOCS[k], status: d.status, bytes: d.bytes, sha256: d.sha256, fetchedAt: new Date().toISOString() }]));
  run.irisFees = {};
  for (const leg of Object.values(LEGS)) {
    const s = domainOf(leg.source);
    const d = domainOf(leg.destination);
    const response = await fetch(`${IRIS}/v2/burn/USDC/fees/${s}/${d}`);
    const body = await response.json().catch(() => null);
    const standard = Array.isArray(body) ? body.find((x) => x.finalityThreshold === 2000) : null;
    const fast = Array.isArray(body) ? body.find((x) => x.finalityThreshold === 1000) : null;
    expect(response.status === 200 && standard && standard.minimumFee === 0, `Iris sandbox GET /v2/burn/USDC/fees/${s}/${d}: Standard (2000) minimumFee ${standard?.minimumFee} bps; Fast (1000) ${fast?.minimumFee} bps (no key sent)`);
    run.irisFees[`${s}->${d}`] = body;
  }
}

async function checkChain(chainId, sender, facts) {
  const name = CHAINS[chainId].name;
  const usdc = usdcOn(chainId);
  for (const which of endpointsOf(chainId).slice(0, 2)) {
    const got = Number(BigInt(await nodeFor(chainId, which)('eth_chainId', [])));
    expect(got === chainId, `${name}: ${host(CHAINS[chainId][which])} answers chain id ${got}`);
  }
  const codes = {};
  for (const [label, address] of [['TokenMessengerV2', TM], ['MessageTransmitterV2', MT], ['TokenMinterV2', MINTER], ['USDC', usdc]]) {
    const [a, b] = await Promise.all(['rpc', 'second'].map((w) => nodeFor(chainId, w)('eth_getCode', [address, 'latest'])));
    codes[label] = { bytes: (a.length - 2) / 2, keccak: keccak256(a) };
    expect(a.length > 2 && a === b, `${name}: ${label} ${address} has code (${codes[label].bytes} bytes, keccak ${codes[label].keccak.slice(0, 14)}…), identical on both endpoints`);
  }
  const otherChains = Object.keys(E.CCTP_V2_TESTNET_DOMAINS).map(Number).filter((c) => c !== chainId);
  const r = {};
  // EIP-1967 implementation slot (keccak256('eip1967.proxy.implementation') - 1) of the two proxies.
  const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  r.implementations = {};
  for (const [label, address] of [['TokenMessengerV2', TM], ['MessageTransmitterV2', MT]]) {
    const [a, b] = await Promise.all(['rpc', 'second'].map((w) => nodeFor(chainId, w)('eth_getStorageAt', [address, IMPL_SLOT, 'latest'])));
    const impl = getAddress('0x' + a.slice(26));
    r.implementations[label] = impl;
    expect(a === b, `${name}: ${label} implementation (EIP-1967 slot) ${impl}, same on both endpoints`);
  }
  r.localDomain = Number(await call(chainId, MT, mtIface, 'localDomain'));
  r.version = Number(await call(chainId, MT, mtIface, 'version'));
  r.localMessageTransmitter = await call(chainId, TM, tmIface, 'localMessageTransmitter');
  r.localMinter = await call(chainId, TM, tmIface, 'localMinter');
  r.messageBodyVersion = Number(await call(chainId, TM, tmIface, 'messageBodyVersion'));
  r.mtPaused = await call(chainId, MT, mtIface, 'paused');
  r.minterPaused = await call(chainId, MINTER, minterIface, 'paused');
  r.signatureThreshold = await call(chainId, MT, mtIface, 'signatureThreshold');
  r.enabledAttesters = await call(chainId, MT, mtIface, 'getNumEnabledAttesters');
  r.isMinter = await call(chainId, usdc, usdcIface, 'isMinter', [MINTER]);
  r.burnLimit = await call(chainId, MINTER, minterIface, 'burnLimitsPerMessage', [usdc]);
  r.devDenylisted = await call(chainId, TM, tmIface, 'isDenylisted', [sender]);
  r.remoteTokenMessengers = {};
  r.localTokenFor = {};
  for (const other of otherChains) {
    r.remoteTokenMessengers[domainOf(other)] = await call(chainId, TM, tmIface, 'remoteTokenMessengers', [domainOf(other)]);
    r.localTokenFor[domainOf(other)] = await call(chainId, MINTER, minterIface, 'getLocalToken', [domainOf(other), zeroPadValue(usdcOn(other), 32)]);
  }
  expect(r.localDomain === domainOf(chainId), `${name}: MessageTransmitterV2.localDomain() = ${r.localDomain} = the adapter's domain`);
  expect(r.version === 1 && r.messageBodyVersion === 1, `${name}: message version ${r.version}, burn message body version ${r.messageBodyVersion}`);
  expect(lower(r.localMessageTransmitter) === lower(MT) && lower(r.localMinter) === lower(MINTER), `${name}: TokenMessengerV2 wired to MessageTransmitterV2 and TokenMinterV2`);
  expect(otherChains.every((o) => lower(r.remoteTokenMessengers[domainOf(o)]) === lower(zeroPadValue(TM, 32))), `${name}: remoteTokenMessengers(${otherChains.map(domainOf).join(', ')}) all = bytes32(${TM})`);
  expect(otherChains.every((o) => lower(r.localTokenFor[domainOf(o)]) === lower(usdc)), `${name}: TokenMinterV2.getLocalToken(remote domain, remote USDC) = ${usdc} for every other network`);
  expect(r.isMinter === true && r.burnLimit >= AMOUNT, `${name}: USDC.isMinter(TokenMinterV2) ${r.isMinter}; burnLimitsPerMessage ${r.burnLimit}`);
  expect(r.mtPaused === false && r.minterPaused === false, `${name}: MessageTransmitterV2 paused ${r.mtPaused}; TokenMinterV2 paused ${r.minterPaused}`);
  expect(r.signatureThreshold === 2n && r.enabledAttesters === 2n, `${name}: signatureThreshold ${r.signatureThreshold}, enabled attesters ${r.enabledAttesters}`);
  expect(r.devDenylisted === false, `${name}: TokenMessengerV2.isDenylisted(dev EOA) ${r.devDenylisted}`);
  facts[chainId] = { codes, ...r };
}

async function balancesOf(chainId, who, block = 'latest') {
  const usdc = usdcOn(chainId);
  const out = [];
  for (const which of CHAINS[chainId].history) {
    const n = nodeFor(chainId, which);
    const tag = block === 'latest' ? 'latest' : hex(block);
    const [eth, usdcBal, supply] = await Promise.all([
      n('eth_getBalance', [who, tag]).then(BigInt),
      n('eth_call', [{ to: usdc, data: usdcIface.encodeFunctionData('balanceOf', [who]) }, tag]).then(BigInt),
      n('eth_call', [{ to: usdc, data: usdcIface.encodeFunctionData('totalSupply') }, tag]).then(BigInt),
    ]);
    out.push({ host: host(CHAINS[chainId][which]), eth, usdc: usdcBal, supply });
  }
  return out;
}

async function dryRun(sender, run) {
  console.log('\n=== DRY RUN (nothing is signed or sent)');
  checkDistEqualsSource();
  await checkDocs(run);

  console.log('\n  -- the adapter in the registry');
  expect(provider.label === 'Circle CCTP (USDC)' && provider.supportedRoutes().length === 12, `provider ${provider.id} ("${provider.label}"): ${provider.supportedRoutes().length} routes among domains ${Object.values(E.CCTP_V2_TESTNET_DOMAINS).join(', ')}`);
  expect(E.CCTP_DEPOSIT_FOR_BURN_SELECTOR === tmIface.getFunction('depositForBurn').selector && E.CCTP_RECEIVE_MESSAGE_SELECTOR === mtIface.getFunction('receiveMessage').selector, `selectors: depositForBurn ${E.CCTP_DEPOSIT_FOR_BURN_SELECTOR}, receiveMessage ${E.CCTP_RECEIVE_MESSAGE_SELECTOR} (recomputed by ethers)`);

  console.log('\n  -- on-chain, all four networks the adapter serves');
  const facts = {};
  for (const chainId of [SEPOLIA, OP_SEPOLIA, ARB_SEPOLIA, BASE_SEPOLIA]) await checkChain(chainId, sender, facts);
  const proxyHashes = new Set(Object.values(facts).map((f) => f.codes.TokenMessengerV2.keccak + f.codes.MessageTransmitterV2.keccak + f.codes.TokenMinterV2.keccak));
  expect(proxyHashes.size === 1, `TokenMessengerV2, MessageTransmitterV2 and TokenMinterV2 code hashes are identical on all four networks (${proxyHashes.size} distinct set)`);
  run.chainFacts = facts;

  console.log('\n  -- balances of the dev EOA');
  run.balancesAtDryRun = {};
  for (const chainId of [SEPOLIA, ARB_SEPOLIA, BASE_SEPOLIA]) {
    const b = await balancesOf(chainId, sender);
    run.balancesAtDryRun[chainId] = b;
    for (const x of b) console.log(`  ${CHAINS[chainId].name} (${x.host}): ${fmtEth(x.eth)} ETH, ${fmtUsdc(x.usdc)} USDC, USDC totalSupply ${x.supply}`);
  }

  run.dryQuotes = {};
  for (const leg of Object.values(LEGS)) {
    const label = leg.label;
    console.log(`\n  -- quote ${fmtUsdc(AMOUNT)} USDC ${label}, and eth_simulateV1 of [approve, depositForBurn]`);
    const quote = await provider.quote({ route: routeFor(leg.source, leg.destination), amount: AMOUNT, sender, recipient: sender });
    const built = checkBuiltCalls(quote, sender, label);
    for (const f of quote.fees) console.log(`     fee line: ${f.kind} ${f.amount} — ${f.description}`);
    console.log(`     time: ${quote.time.minSeconds}–${quote.time.maxSeconds} s — ${quote.time.source}`);
    console.log(`     destination: ${quote.destination.kind}, submitter ${quote.destination.submitter}`);
    const sim = await simulate(leg.source, sender, [built.approve, built.burn]);
    const [a, b] = sim.results;
    const logs = decodeLogs(b.logs);
    const dep = logs.find((l) => l.event === 'DepositForBurn');
    const sent = logs.find((l) => l.event === 'MessageSent');
    const decoded = sent ? decodeMessage(sent.message) : null;
    expect(a.ok && b.ok, `${label}: simulated on ${sim.endpoint} — approve ${a.ok ? 'ok' : `REVERTED ${reason(a)}`} (gas ${a.gasUsed}), depositForBurn ${b.ok ? 'ok' : `REVERTED ${reason(b)}`} (gas ${b.gasUsed})`);
    expect(dep && dep.amount === AMOUNT && lower(dep.depositor) === lower(sender) && lower(dep.mintRecipient) === lower(zeroPadValue(sender, 32)) && dep.destinationDomain === domainOf(leg.destination) && dep.maxFee === 0n && dep.minFinalityThreshold === 2000 && dep.hookData === '0x', `${label}: simulated DepositForBurn — amount ${dep?.amount}, destination domain ${dep?.destinationDomain}, maxFee ${dep?.maxFee}, finality ${dep?.minFinalityThreshold}, no hook data`);
    expect(decoded && decoded.sourceDomain === domainOf(leg.source) && decoded.destinationDomain === domainOf(leg.destination) && decoded.nonce === ZERO32 && decoded.burn.amount === AMOUNT && lower(decoded.burn.mintRecipient) === lower(sender) && decoded.burn.maxFee === 0n, `${label}: simulated MessageSent — ${decoded?.bytes} bytes, domains ${decoded?.sourceDomain} → ${decoded?.destinationDomain}, nonce left empty for Circle to assign, mint recipient = the dev EOA, amount ${decoded?.burn.amount}`);
    run.dryQuotes[leg.key] = { approveGas: a.gasUsed, burnGas: b.gasUsed, simulatedOn: sim.endpoint, messageBytes: decoded?.bytes, timeSource: quote.time.source };
  }

  console.log('\n  -- engine refusals');
  const route = routeFor(BASE_SEPOLIA, ARB_SEPOLIA);
  const refusals = {};
  const tryEngine = async (label, fn, expectText) => {
    try {
      await fn();
      expect(false, `${label}: the engine ACCEPTED it (expected a refusal)`);
      refusals[label] = 'accepted';
    } catch (e) {
      expect(String(e.message).includes(expectText), `${label}: refused — "${errText(e)}"`);
      refusals[label] = errText(e);
    }
  };
  await tryEngine('amount 0', () => provider.quote({ route, amount: 0n, sender, recipient: sender }), 'more than zero');
  await tryEngine('a minimum to receive one base unit above the amount', () => provider.quote({ route, amount: AMOUNT, sender, recipient: sender, minAmountOut: AMOUNT + 1n }), 'at most the amount');
  await tryEngine('a route to Ethereum mainnet (chain 1)', () => provider.quote({ route: { ...route, destinationChainId: 1 }, amount: AMOUNT, sender, recipient: sender }), 'does not serve this route');
  await tryEngine('a route to Hoodi (560048)', () => provider.quote({ route: { ...route, destinationChainId: 560048 }, amount: AMOUNT, sender, recipient: sender }), 'does not serve this route');
  await tryEngine('a route whose destination asset is not USDC (Base Sepolia EURC)', () => provider.quote({ route: { ...route, destinationAsset: { kind: 'erc20', address: '0x808456652fdb597867f38412077A9182bf77359F', symbol: 'EURC', decimals: 6 } }, amount: AMOUNT, sender, recipient: sender }), 'does not serve this route');
  await tryEngine('a zero recipient', () => provider.quote({ route, amount: AMOUNT, sender, recipient: ZERO_ADDR }), 'zero address');
  const badChecksum = sender.slice(0, -1) + (sender.slice(-1) === 'C' ? 'c' : 'C');
  await tryEngine('a recipient with a broken EIP-55 checksum', () => provider.quote({ route, amount: AMOUNT, sender, recipient: badChecksum }), 'checksum');
  const base = { amount: AMOUNT, destinationDomain: 3, mintRecipient: sender, burnToken: usdcOn(BASE_SEPOLIA), destinationCaller: ZERO_ADDR, maxFee: 0n, minFinalityThreshold: 2000 };
  await tryEngine('encodeDepositForBurn to domain 1 (Avalanche Fuji, not verified by this wallet)', () => E.encodeDepositForBurn({ ...base, destinationDomain: 1 }), 'not one this wallet has verified');
  await tryEngine('encodeDepositForBurn to domain 5 (Solana)', () => E.encodeDepositForBurn({ ...base, destinationDomain: 5 }), 'not one this wallet has verified');
  await tryEngine('encodeDepositForBurn with finality 1500', () => E.encodeDepositForBurn({ ...base, minFinalityThreshold: 1500 }), 'finality threshold');
  await tryEngine('encodeDepositForBurn with maxFee = amount', () => E.encodeDepositForBurn({ ...base, maxFee: AMOUNT }), 'less than the amount');
  // Fast Transfer: the quote request has no finality field; the quote always writes maxFee 0 and 2000.
  const q = await provider.quote({ route, amount: AMOUNT, sender, recipient: sender });
  const pins = Object.fromEntries(q.calls[1].pins.map((p) => [p.field, BigInt(p.rule.params[0])]));
  expect(pins.maxFee === 0n && pins.minFinalityThreshold === 2000n, 'Fast Transfer: the quote cannot ask for one (BridgeQuoteRequest has no finality field); the built call pins maxFee 0 and minFinalityThreshold 2000');
  let fastEncoded = false;
  try {
    E.encodeDepositForBurn({ ...base, minFinalityThreshold: E.CCTP_FINALITY_FAST, maxFee: 1n });
    fastEncoded = true;
  } catch {}
  console.log(`  info encodeDepositForBurn itself ${fastEncoded ? 'ACCEPTS' : 'refuses'} finality 1000 with a non-zero maxFee: the Fast refusal lives in quote(), not in the encoder`);
  refusals['Fast via the encoder'] = fastEncoded ? 'accepted by the encoder; quote() never produces it' : 'refused by the encoder';

  console.log('\n  -- simulated negatives (hand-altered calls; never broadcast)');
  const [approveCall] = q.calls;
  const negatives = {};
  const negSim = async (label, calls, expectReason) => {
    const sim = await simulate(BASE_SEPOLIA, sender, calls);
    const last = sim.results[sim.results.length - 1];
    const why = last.ok ? 'succeeded' : reason(last);
    expect(!last.ok && String(why).includes(expectReason), `${label}: simulated revert "${why}"`);
    negatives[label] = why;
  };
  const altered = (args) => ({ to: TM, value: 0n, data: tmIface.encodeFunctionData('depositForBurn', args) });
  const pad = zeroPadValue(sender, 32);
  await negSim('maxFee = amount', [approveCall, altered([AMOUNT, 3, pad, usdcOn(BASE_SEPOLIA), ZERO32, AMOUNT, 2000])], 'Max fee must be less than amount');
  await negSim('maxFee above the amount', [approveCall, altered([AMOUNT, 3, pad, usdcOn(BASE_SEPOLIA), ZERO32, AMOUNT + 1n, 2000])], 'Max fee must be less than amount');
  await negSim('destination domain 4 (no remote TokenMessenger registered)', [approveCall, altered([AMOUNT, 4, pad, usdcOn(BASE_SEPOLIA), ZERO32, 0n, 2000])], 'No TokenMessenger for domain');
  await negSim('a zero mint recipient', [approveCall, altered([AMOUNT, 3, ZERO32, usdcOn(BASE_SEPOLIA), ZERO32, 0n, 2000])], 'Mint recipient must be nonzero');
  await negSim('an approval one base unit short', [{ to: usdcOn(BASE_SEPOLIA), value: 0n, data: usdcIface.encodeFunctionData('approve', [TM, AMOUNT - 1n]) }, altered([AMOUNT, 3, pad, usdcOn(BASE_SEPOLIA), ZERO32, 0n, 2000])], 'allowance');
  run.dryRun = { at: new Date().toISOString(), amount: AMOUNT, refusals, negatives, failures };
  saveRun(run);
}

// ---------------------------------------------------------------------------
// Live leg
// ---------------------------------------------------------------------------

const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
async function opStackL1Fee(node, rawHex) {
  // GasPriceOracle.getL1Fee over the SIGNED bytes: a slight overestimate of the unsigned form, used only for the cap.
  const data = E.toHex(E.encodeFunctionCall('getL1Fee(bytes)', [{ kind: 'bytes', value: E.toBytes(rawHex) }]));
  return E.decodeUint256(await node('eth_call', [{ to: GAS_PRICE_ORACLE, data }, 'latest']));
}

function feeCapUsed(run, chainId) {
  let sum = 0n;
  for (const leg of Object.values(run.legs ?? {})) for (const tx of leg.txs ?? []) if (tx.chainId === chainId) sum += BigInt(tx.worstCaseFee ?? 0);
  return sum;
}
function usdcBridged(run) {
  return Object.values(run.legs ?? {}).reduce((s, l) => s + (l.burnSent ? BigInt(l.amount) : 0n), 0n);
}

/**
 * Signs and sends one engine-built call ({to, value, data}) on `chainId`
 * after a cap check; returns the receipt facts read on two endpoints.
 */
async function sendOne(chainId, signer, built, label, run, record) {
  const sender = signer.address;
  const ch = CHAINS[chainId];
  const node = nodeFor(chainId);
  const node2 = nodeFor(chainId, 'second');
  const dataHex = E.toHex(built.data);
  const latest = BigInt(await node('eth_getTransactionCount', [sender, 'latest']));
  const pending = BigInt(await node('eth_getTransactionCount', [sender, 'pending']));
  if (latest !== pending) throw new Error(`The dev EOA has ${pending - latest} pending transaction(s) on ${ch.name}. Nothing was sent.`);
  const chainIdRead = BigInt(await node('eth_chainId', []));
  if (chainIdRead !== BigInt(chainId)) throw new Error(`The ${ch.name} endpoint answered another chain. Nothing was sent.`);
  const estimate = BigInt(await node('eth_estimateGas', [{ from: sender, to: built.to, value: hex(built.value), data: dataHex }]));
  const gasLimit = (estimate * 120n) / 100n;
  const fees = await new E.NodeClient(node).suggestFees();
  const tx = { chainId: chainIdRead, nonce: latest, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, gasLimit, to: built.to, value: built.value, data: built.data };
  const signed = E.signEip1559(tx, signer);
  const l1Estimate = ch.opStack ? await opStackL1Fee(node, signed.rawHex) : 0n;
  const worstCaseFee = gasLimit * fees.maxFeePerGas + (l1Estimate * 3n) / 2n;
  const used = feeCapUsed(run, chainId);
  const ethBalance = BigInt(await node('eth_getBalance', [sender, 'latest']));
  console.log(`  ${label}: nonce ${tx.nonce}, gas estimate ${estimate} → limit ${gasLimit}, maxFee ${fees.maxFeePerGas}, tip ${fees.maxPriorityFeePerGas}${ch.opStack ? `, L1 data fee estimate ${l1Estimate}` : ''}; worst-case fee ${worstCaseFee} wei; fees so far on ${ch.name} ${used} + this = ${used + worstCaseFee} ≤ ${FEE_CAP_PER_CHAIN}`);
  if (used + worstCaseFee > FEE_CAP_PER_CHAIN) throw new Error(`${label} would take the worst-case fees on ${ch.name} above 0.003 ETH. Nothing was sent.`);
  if (ethBalance < worstCaseFee + built.value) throw new Error(`The dev EOA cannot pay ${label} on ${ch.name}. Nothing was sent.`);
  const entry = { label, chainId, nonce: tx.nonce, to: built.to, value: built.value, data: dataHex, gasEstimate: estimate, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, l1FeeEstimate: l1Estimate, worstCaseFee, status: 'sending' };
  record.txs.push(entry);
  saveRun(run);
  const hash = await node('eth_sendRawTransaction', [signed.rawHex]);
  const sentAt = Date.now();
  if (lower(hash) !== lower(signed.txHash)) throw new Error(`The node returned ${hash}, not the signed hash ${signed.txHash}.`);
  entry.hash = hash;
  entry.sentAt = new Date(sentAt).toISOString();
  entry.status = 'sent';
  saveRun(run);
  console.log(`  SENT ${label}: ${hash} (${ch.explorer}${hash})`);
  let [r1, r2] = await Promise.all([receiptOf(node, hash), receiptOf(node2, hash)]);
  for (let i = 0; i < 6 && r1.blockHash !== r2.blockHash; i++) {
    console.log(`  info the two endpoints report different block hashes (${r1.blockHash} / ${r2.blockHash}); reading again in 20 s`);
    await sleep(20_000);
    [r1, r2] = await Promise.all([receiptOf(node, hash), receiptOf(node2, hash)]);
  }
  const [t1, t2] = await Promise.all([node('eth_getTransactionByHash', [hash]), node2('eth_getTransactionByHash', [hash])]);
  const [c1, c2] = await Promise.all([node('web3_clientVersion', []).catch(() => 'unknown'), node2('web3_clientVersion', []).catch(() => 'unknown')]);
  const endpoints = [[ch.rpc, r1, t1, c1], [ch.second, r2, t2, c2]].map(([url, r, t, c]) => ({
    host: host(url),
    client: String(c).split('/').slice(0, 2).join('/'),
    status: r.status,
    block: BigInt(r.blockNumber),
    blockHash: r.blockHash,
    gasUsed: BigInt(r.gasUsed),
    effectiveGasPrice: BigInt(r.effectiveGasPrice),
    l1Fee: r.l1Fee ? BigInt(r.l1Fee) : null,
    logs: r.logs.length,
    inputMatches: lower(t.input) === lower(dataHex),
    to: t.to,
    from: t.from,
  }));
  const [s1, s2] = endpoints;
  expect(s1.status === s2.status && s1.block === s2.block && s1.blockHash === s2.blockHash && s1.gasUsed === s2.gasUsed && s1.logs === s2.logs && s1.l1Fee === s2.l1Fee, `${label}: receipt agrees on ${s1.host} (${s1.client}) and ${s2.host} (${s2.client}): status ${s1.status}, block ${s1.block}, gas used ${s1.gasUsed} of ${gasLimit}, effective price ${s1.effectiveGasPrice}${s1.l1Fee !== null ? `, l1Fee ${s1.l1Fee}` : ''}, ${s1.logs} logs`);
  expect(s1.inputMatches && s2.inputMatches && lower(s1.to) === lower(built.to) && lower(s1.from) === lower(sender), `${label}: the mined transaction carries exactly the engine-built calldata and target (both endpoints)`);
  const operatorFee = ch.opStack ? await operatorFeeAt(node, r1) : null;
  const paid = receiptFeePaid(r1, operatorFee ?? 0n);
  console.log(`  ${label} fees: ${describeReceiptFees(r1, operatorFee)}`);
  const block = await node('eth_getBlockByNumber', [r1.blockNumber, false]);
  Object.assign(entry, { status: r1.status === '0x1' ? 'mined' : 'reverted', receipt: { endpoints, fees: describeReceiptFees(r1, operatorFee), feePaid: paid.total, l2Fee: paid.l2, l1Fee: paid.l1, operatorFee }, block: BigInt(r1.blockNumber), blockTime: Number(BigInt(block.timestamp)), sentToMinedMs: Date.now() - sentAt });
  saveRun(run);
  if (r1.status !== '0x1') throw new Error(`${label} reverted (status ${r1.status}). Stopped; nothing is retried.`);
  return { receipt: r1, entry, block: BigInt(r1.blockNumber), blockTime: Number(BigInt(block.timestamp)), feePaid: paid.total };
}

/**
 * USDC balance and totalSupply deltas over one block (block − 1 → block) on
 * the history endpoints, with the block's other mints and burns of USDC
 * accounted for from their own Transfer logs.
 */
async function usdcDeltas(chainId, who, block, expectedBalanceDelta, expectedOwnSupplyDelta, ethSpent, label) {
  const usdc = usdcOn(chainId);
  const before = await balancesOf(chainId, who, block - 1n);
  const after = await balancesOf(chainId, who, block);
  const logs = await nodeFor(chainId, CHAINS[chainId].history[0])('eth_getLogs', [{ address: usdc, fromBlock: hex(block), toBlock: hex(block), topics: [TOPIC.Transfer] }]);
  let mints = 0n;
  let burns = 0n;
  const zeroTopic = lower(zeroPadValue(ZERO_ADDR, 32));
  for (const l of logs) {
    if (lower(l.topics[1]) === zeroTopic) mints += BigInt(l.data);
    if (lower(l.topics[2]) === zeroTopic) burns += BigInt(l.data);
  }
  const rows = before.map((b, i) => ({ host: b.host, usdcDelta: after[i].usdc - b.usdc, supplyDelta: after[i].supply - b.supply, ethDelta: after[i].eth - b.eth }));
  for (const r of rows) {
    expect(r.usdcDelta === expectedBalanceDelta, `${label} (${r.host}): the dev EOA's USDC changed by ${r.usdcDelta} base units, block ${block - 1n} → ${block} (expected ${expectedBalanceDelta})`);
    expect(r.supplyDelta === mints - burns, `${label} (${r.host}): USDC totalSupply changed by ${r.supplyDelta} = the block's Transfer logs: mints ${mints} − burns ${burns}`);
    if (ethSpent !== null) expect(r.ethDelta === -ethSpent, `${label} (${r.host}): the dev EOA's ETH changed by ${r.ethDelta} wei = −(fee paid ${ethSpent})`);
  }
  const own = expectedOwnSupplyDelta;
  const otherMintsBurns = mints - burns - own;
  expect(own > 0n ? mints >= own : burns >= -own, `${label}: the block's USDC ${own > 0n ? 'mints' : 'burns'} include this leg's ${own > 0n ? own : -own}; other mints − burns in the same block: ${otherMintsBurns}`);
  return { rows, blockMints: mints, blockBurns: burns, ownSupplyDelta: own, otherMintsMinusBurns: otherMintsBurns };
}

async function liveLeg(leg, signer, run) {
  const sender = signer.address;
  const src = CHAINS[leg.source];
  const dst = CHAINS[leg.destination];
  console.log(`\n=== LIVE leg ${leg.label}: ${fmtUsdc(AMOUNT)} USDC from the dev EOA to the dev EOA`);
  run.legs ??= {};
  const previous = run.legs[leg.key];
  if (previous?.status && process.env.CCTP_REPEAT !== '1') {
    throw new Error(`The record already has leg ${leg.key} (${previous.status}). Set CCTP_REPEAT=1 to send another. Nothing was sent.`);
  }
  if (AMOUNT > AMOUNT_CAP) throw new Error('Above the per-leg cap. Nothing was sent.');
  if (usdcBridged(run) + AMOUNT > TOTAL_USDC_CAP) throw new Error('This leg would take the bridged USDC above 3 USDC. Nothing was sent.');
  const record = { label: leg.label, source: leg.source, destination: leg.destination, amount: AMOUNT, startedAt: new Date().toISOString(), status: 'quoting', txs: [] };
  run.legs[leg.key] = record;
  saveRun(run);

  // 1. Quote, independent checks, simulation.
  const route = routeFor(leg.source, leg.destination);
  const quote = await provider.quote({ route, amount: AMOUNT, sender, recipient: sender });
  const built = checkBuiltCalls(quote, sender, leg.label);
  if (failures > 0) throw new Error('A check of the built calls failed. Nothing was sent.');
  const sim = await simulate(leg.source, sender, [built.approve, built.burn]);
  if (!sim.results.every((r) => r.ok)) throw new Error(`The pre-flight simulation reverted (${sim.results.map(reason).join(' / ')}). Nothing was sent.`);
  const usdcBefore = BigInt(await call(leg.source, usdcOn(leg.source), usdcIface, 'balanceOf', [sender]));
  const allowanceBefore = BigInt(await call(leg.source, usdcOn(leg.source), usdcIface, 'allowance', [sender, TM]));
  if (usdcBefore < AMOUNT) throw new Error(`The dev EOA holds ${usdcBefore} USDC base units on ${src.name}. Nothing was sent.`);
  console.log(`  pre-flight eth_simulateV1 of [approve, depositForBurn] on ${sim.endpoint}: ok (gas ${sim.results[0].gasUsed} + ${sim.results[1].gasUsed}); USDC ${fmtUsdc(usdcBefore)}, allowance to TokenMessengerV2 before ${allowanceBefore}`);
  record.quote = { approveData: built.approveHex, burnData: built.burnHex, pins: built.burn.pins.map((p) => ({ field: p.field, offset: p.rule.offset, param: p.rule.params[0] })), fees: quote.fees.map((f) => ({ kind: f.kind, amount: f.amount })), timeSource: quote.time.source, allowanceBefore };
  const dstStartBlock = BigInt(await nodeFor(leg.destination, dst.history[0])('eth_blockNumber', []));
  record.destinationStartBlock = dstStartBlock;

  // 2. The exact approval.
  const approve = await sendOne(leg.source, signer, built.approve, 'approve', run, record);
  const approveLogs = decodeLogs(approve.receipt.logs);
  const approval = approveLogs.find((l) => l.event === 'Approval');
  expect(approval && lower(approval.owner) === lower(sender) && lower(approval.spender) === lower(TM) && approval.value === AMOUNT, `Approval(owner dev EOA, spender TokenMessengerV2, value ${approval?.value}) — exactly the amount`);
  const allowanceAfterApprove = BigInt(await call(leg.source, usdcOn(leg.source), usdcIface, 'allowance', [sender, TM], 'rpc', hex(approve.block)));
  expect(allowanceAfterApprove === AMOUNT, `allowance after the approval: ${allowanceAfterApprove}`);

  // 3. The burn, re-simulated with the approval mined.
  const [burnSim] = (await simulate(leg.source, sender, [built.burn])).results;
  if (!burnSim.ok) throw new Error(`The burn's simulation after the approval reverted (${reason(burnSim)}). Nothing more was sent; the approval of exactly ${AMOUNT} stands.`);
  record.burnSent = true;
  const burn = await sendOne(leg.source, signer, built.burn, 'depositForBurn', run, record);
  const burnLogs = decodeLogs(burn.receipt.logs);
  for (const l of burnLogs) console.log(`  log ${toJson(l).replace(/\s+/g, ' ').slice(0, 400)}`);
  const dep = burnLogs.find((l) => l.event === 'DepositForBurn');
  const sent = burnLogs.find((l) => l.event === 'MessageSent');
  expect(dep && lower(dep.address) === lower(TM) && lower(dep.burnToken) === lower(usdcOn(leg.source)) && dep.amount === AMOUNT && lower(dep.depositor) === lower(sender) && lower(dep.mintRecipient) === lower(zeroPadValue(sender, 32)) && dep.destinationDomain === domainOf(leg.destination) && lower(dep.destinationTokenMessenger) === lower(zeroPadValue(TM, 32)) && dep.destinationCaller === ZERO32 && dep.maxFee === 0n && dep.minFinalityThreshold === 2000 && dep.hookData === '0x', `DepositForBurn: burnToken ${dep?.burnToken}, amount ${dep?.amount}, depositor ${dep?.depositor}, recipient bytes32(dev EOA), domain ${dep?.destinationDomain}, destination messenger bytes32(TokenMessengerV2), caller 0, maxFee ${dep?.maxFee}, finality ${dep?.minFinalityThreshold}, hook data empty`);
  const sentMsg = sent ? decodeMessage(sent.message) : null;
  expect(sent && lower(sent.address) === lower(MT) && sentMsg.version === 1 && sentMsg.sourceDomain === domainOf(leg.source) && sentMsg.destinationDomain === domainOf(leg.destination) && sentMsg.nonce === ZERO32 && lower(sentMsg.sender) === lower(zeroPadValue(TM, 32)) && lower(sentMsg.recipient) === lower(zeroPadValue(TM, 32)) && sentMsg.destinationCaller === ZERO32 && sentMsg.minFinalityThreshold === 2000 && sentMsg.finalityThresholdExecuted === 0 && sentMsg.burn.amount === AMOUNT && lower(sentMsg.burn.mintRecipient) === lower(sender) && lower(sentMsg.burn.messageSender) === lower(sender) && lower(sentMsg.burn.burnToken) === lower(usdcOn(leg.source)) && sentMsg.burn.maxFee === 0n && sentMsg.burn.feeExecuted === 0n && sentMsg.burn.expirationBlock === 0n && sentMsg.burn.hookData === '0x', `MessageSent from MessageTransmitterV2: ${sentMsg?.bytes} bytes, version ${sentMsg?.version}, ${sentMsg?.sourceDomain} → ${sentMsg?.destinationDomain}, nonce empty, sender and recipient = bytes32(TokenMessengerV2), caller 0, min finality ${sentMsg?.minFinalityThreshold}, body: USDC ${sentMsg?.burn.amount} to the dev EOA, maxFee 0, fee executed 0, expiration 0`);
  const transfers = burnLogs.filter((l) => l.event === 'Transfer' && lower(l.address) === lower(usdcOn(leg.source)));
  console.log(`  USDC transfers in the burn: ${transfers.map((t) => `${t.from} → ${t.to} ${t.value}`).join('; ')}`);
  const allowanceAfterBurn = BigInt(await call(leg.source, usdcOn(leg.source), usdcIface, 'allowance', [sender, TM], 'rpc', hex(burn.block)));
  expect(allowanceAfterBurn === allowanceBefore, `allowance after the burn: ${allowanceAfterBurn} (back to the ${allowanceBefore} it was before the leg; nothing stays approved)`);
  record.burn = { hash: burn.entry.hash, block: burn.block, blockTime: burn.blockTime, logs: burnLogs, message: sent?.message, decodedMessageSent: sentMsg };
  record.sourceDeltas = {
    approve: await usdcDeltas(leg.source, sender, approve.block, 0n, 0n, approve.feePaid, `${src.name} approve block`),
    burn: await usdcDeltas(leg.source, sender, burn.block, -AMOUNT, -AMOUNT, burn.feePaid, `${src.name} burn block`),
  };
  record.status = 'burned';
  saveRun(run);

  // 4. The attestation, polled through the adapter's track().
  console.log(`\n  -- waiting for Circle's sandbox attestation (GET ${IRIS}/v2/messages/${domainOf(leg.source)}?transactionHash=…), polling every ${POLL_MS / 1000} s`);
  const transfer = { providerId: E.CCTP_V2_PROVIDER_ID, route, sourceTxHash: burn.entry.hash, amountIn: AMOUNT, recipient: sender };
  const started = Date.now();
  let status;
  let lastPrinted = '';
  while (true) {
    try {
      status = await provider.track(transfer);
    } catch (e) {
      console.log(`  info track() failed this round: ${errText(e)}`);
      status = null;
    }
    const seen = irisSeen.get(lower(burn.entry.hash)) ?? [];
    const last = seen[seen.length - 1];
    const line = last ? `HTTP ${last.httpStatus}, status ${last.status}, attestation ${last.attestation}, delayReason ${last.delayReason}` : 'no answer';
    if (line !== lastPrinted) {
      console.log(`  ${new Date().toISOString()} (+${Math.round((Date.now() - burn.blockTime * 1000) / 1000)} s after the burn block): ${line}; adapter state ${status?.state ?? 'error'}`);
      lastPrinted = line;
    }
    if (status?.state === 'awaiting-destination-action' || status?.state === 'delivered') break;
    if (Date.now() - started > ATTESTATION_TIMEOUT_MS) {
      record.status = 'attestation-timeout';
      record.irisAnswers = seen;
      saveRun(run);
      throw new Error(`No attestation within ${ATTESTATION_TIMEOUT_MS / 60000} minutes. The burn ${burn.entry.hash} stands; the mint can be completed later by anyone with the attestation.`);
    }
    await sleep(POLL_MS);
  }
  const seen = irisSeen.get(lower(burn.entry.hash)) ?? [];
  const firstAny = seen.find((s) => s.httpStatus === 200);
  const firstComplete = seen.find((s) => s.status === 'complete');
  record.irisAnswers = seen;
  record.attestationTiming = {
    burnBlockTime: new Date(burn.blockTime * 1000).toISOString(),
    firstIndexedAt: firstAny?.at ?? null,
    firstCompleteAt: firstComplete?.at ?? null,
    secondsBurnBlockToComplete: firstComplete ? Math.round(firstComplete.ms / 1000 - burn.blockTime) : null,
    polls: seen.length,
    pollIntervalSeconds: POLL_MS / 1000,
  };
  console.log(`  attestation complete: ${record.attestationTiming.secondsBurnBlockToComplete} s after the burn block (first indexed ${record.attestationTiming.firstIndexedAt}; first complete ${record.attestationTiming.firstCompleteAt}; ${seen.length} polls)`);
  expect(status.state === 'awaiting-destination-action' && status.destinationCalls?.length === 1, `track(): ${status.state} — "${status.detail}"`);

  // 5. Independent checks of the attested message and the mint call.
  const raw = await irisGet(domainOf(leg.source), burn.entry.hash);
  const irisMsg = raw.body.messages[0];
  const message = irisMsg.message;
  const attestation = irisMsg.attestation;
  const att = decodeMessage(message);
  expect(maskFilled(message) === maskFilled(sent.message), `the attested message (${att.bytes} bytes) equals the MessageSent message except the fields Circle fills in (nonce, executed finality, executed fee, expiration block)`);
  expect(att.nonce !== ZERO32 && att.finalityThresholdExecuted === 2000 && att.burn.feeExecuted === 0n, `Circle filled in: nonce ${att.nonce}, executed finality ${att.finalityThresholdExecuted} (finalized), executed fee ${att.burn.feeExecuted}, expiration block ${att.burn.expirationBlock}`);
  expect(irisMsg.decodedMessage && Number(irisMsg.decodedMessage.sourceDomain) === att.sourceDomain && Number(irisMsg.decodedMessage.destinationDomain) === att.destinationDomain && BigInt(irisMsg.decodedMessage.decodedMessageBody?.amount ?? -1) === AMOUNT && lower(irisMsg.decodedMessage.decodedMessageBody?.mintRecipient ?? '') === lower(sender), `Iris's decodedMessage agrees (domains ${irisMsg.decodedMessage?.sourceDomain} → ${irisMsg.decodedMessage?.destinationDomain}, nonce ${irisMsg.decodedMessage?.nonce}, amount ${irisMsg.decodedMessage?.decodedMessageBody?.amount}); cctpVersion ${irisMsg.cctpVersion}`);
  const digest = keccak256(message);
  const sigs = (attestation.length - 2) / 2 / 65;
  const signers = [];
  for (let i = 0; i < sigs; i++) signers.push(recoverAddress(digest, '0x' + attestation.slice(2 + i * 130, 2 + (i + 1) * 130)));
  const enabled = [];
  for (const s of signers) enabled.push(await call(leg.destination, MT, mtIface, 'isEnabledAttester', [s]));
  expect(sigs === 2 && BigInt(signers[0]) < BigInt(signers[1]) && enabled.every(Boolean), `the attestation is ${sigs} signatures over keccak256(message), recovered to ${signers.join(' and ')} (increasing order), both enabled attesters on ${dst.name}`);
  const [mintCall] = status.destinationCalls;
  const mintHex = E.toHex(mintCall.data);
  expect(lower(mintCall.to) === lower(MT) && mintCall.value === 0n && mintHex === mtIface.encodeFunctionData('receiveMessage', [message, attestation]) && mintHex.startsWith(E.CCTP_RECEIVE_MESSAGE_SELECTOR), `the adapter's mint call: receiveMessage(message, attestation) to MessageTransmitterV2 ${MT}, value 0, byte-identical to ethers (${(mintHex.length - 2) / 2} bytes)`);
  const usedBefore = await call(leg.destination, MT, mtIface, 'usedNonces', [att.nonce]);
  expect(usedBefore === 0n, `usedNonces(${att.nonce}) on ${dst.name} before the mint: ${usedBefore}`);
  record.attested = { message, attestation, decoded: att, signers, cctpVersion: irisMsg.cctpVersion, nonce: att.nonce };

  // 6. Simulated: [mint, mint] (the second must revert) and a tampered message.
  const mintBuilt = { to: mintCall.to, value: 0n, data: mintCall.data };
  const dsim = await simulate(leg.destination, sender, [mintBuilt, mintBuilt]);
  const [m1, m2] = dsim.results;
  const m1Logs = decodeLogs(m1.logs);
  expect(m1.ok && m1Logs.some((l) => l.event === 'MintAndWithdraw') && m1Logs.some((l) => l.event === 'MessageReceived'), `simulated on ${dsim.endpoint}: the mint succeeds (gas ${m1.gasUsed}) with MessageReceived and MintAndWithdraw`);
  expect(!m2.ok && reason(m2).includes('Nonce already used'), `simulated: the same mint again in the next call reverts "${reason(m2)}"`);
  const tamperedMessage = message.slice(0, 2 + (MSG.body + BODY.mintRecipient[1] - 1) * 2) + (message.slice(2 + (MSG.body + BODY.mintRecipient[1] - 1) * 2, 4 + (MSG.body + BODY.mintRecipient[1] - 1) * 2) === 'ff' ? '00' : 'ff') + message.slice(4 + (MSG.body + BODY.mintRecipient[1] - 1) * 2);
  const [tampered] = (await simulate(leg.destination, sender, [{ to: MT, value: 0n, data: mtIface.encodeFunctionData('receiveMessage', [tamperedMessage, attestation]) }])).results;
  expect(!tampered.ok, `simulated: the message with the mint recipient's last byte changed reverts "${tampered.ok ? 'succeeded' : reason(tampered)}"`);
  record.destinationSimulation = { mintGas: m1.gasUsed, replayReason: reason(m2), tamperedReason: tampered.ok ? null : reason(tampered) };
  saveRun(run);

  // 7. The mint, sent by the dev EOA.
  const mint = await sendOne(leg.destination, signer, mintBuilt, 'receiveMessage', run, record);
  const mintLogs = decodeLogs(mint.receipt.logs);
  for (const l of mintLogs) console.log(`  log ${toJson(l).replace(/\s+/g, ' ').slice(0, 400)}`);
  const received = mintLogs.find((l) => l.event === 'MessageReceived');
  const minted = mintLogs.find((l) => l.event === 'MintAndWithdraw');
  const mintTransfer = mintLogs.find((l) => l.event === 'Transfer' && lower(l.address) === lower(usdcOn(leg.destination)) && lower(l.from) === lower(ZERO_ADDR));
  expect(received && lower(received.address) === lower(MT) && lower(received.caller) === lower(sender) && received.sourceDomain === domainOf(leg.source) && received.nonce === att.nonce && lower(received.sender) === lower(zeroPadValue(TM, 32)) && received.finalityThresholdExecuted === 2000 && lower(received.messageBody) === lower(att.body), `MessageReceived: caller dev EOA, source domain ${received?.sourceDomain}, nonce ${received?.nonce}, sender bytes32(TokenMessengerV2), finality ${received?.finalityThresholdExecuted}, body = the attested body`);
  expect(minted && lower(minted.address) === lower(TM) && lower(minted.mintRecipient) === lower(sender) && minted.amount === AMOUNT && lower(minted.mintToken) === lower(usdcOn(leg.destination)) && minted.feeCollected === 0n, `MintAndWithdraw: ${minted?.amount} of ${minted?.mintToken} to the dev EOA, fee collected ${minted?.feeCollected}`);
  expect(mintTransfer && lower(mintTransfer.to) === lower(sender) && mintTransfer.value === AMOUNT, `USDC Transfer(0x0 → dev EOA, ${mintTransfer?.value})`);
  const usedAfter = await call(leg.destination, MT, mtIface, 'usedNonces', [att.nonce]);
  expect(usedAfter === 1n, `usedNonces(${att.nonce}) after the mint: ${usedAfter}`);
  record.mint = { hash: mint.entry.hash, block: mint.block, blockTime: mint.blockTime, logs: mintLogs };
  record.destinationDeltas = await usdcDeltas(leg.destination, sender, mint.block, AMOUNT, AMOUNT, mint.feePaid, `${dst.name} mint block`);

  // 8. The adapter now reports delivered; the replay is an eth_call that must revert.
  const after = await provider.track(transfer);
  expect(after.state === 'delivered', `track() after the mint: ${after.state} — "${after.detail}"`);
  let replay;
  try {
    const res = await nodeFor(leg.destination)('eth_call', [{ from: sender, to: MT, data: mintHex }, 'latest']);
    replay = `answered ${res}`;
    expect(false, `the replayed receiveMessage as an eth_call ${replay} (expected a revert)`);
  } catch (e) {
    replay = errText(e);
    expect(/Nonce already used/.test(replay), `the replayed receiveMessage as an eth_call reverts: "${replay}" (not broadcast)`);
  }
  record.replayEthCall = replay;
  record.timing = {
    burnBlockTime: new Date(burn.blockTime * 1000).toISOString(),
    mintBlockTime: new Date(mint.blockTime * 1000).toISOString(),
    secondsBurnBlockToComplete: record.attestationTiming.secondsBurnBlockToComplete,
    secondsBurnBlockToMintBlock: mint.blockTime - burn.blockTime,
  };
  record.fees = { approve: approve.feePaid, burn: burn.feePaid, mint: mint.feePaid, sourceTotal: approve.feePaid + burn.feePaid };
  record.status = 'delivered';
  record.finishedAt = new Date().toISOString();
  saveRun(run);
  console.log(`\n  leg ${leg.label} DELIVERED: ${fmtUsdc(AMOUNT)} USDC; attestation ${record.timing.secondsBurnBlockToComplete} s, burn block → mint block ${record.timing.secondsBurnBlockToMintBlock} s; fees ${fmtEth(record.fees.sourceTotal)} ETH on ${src.name}, ${fmtEth(record.fees.mint)} ETH on ${dst.name}`);
}

// ---------------------------------------------------------------------------
// Read-only re-verification
// ---------------------------------------------------------------------------

async function verifyRecorded(run) {
  console.log('\n=== CCTP_VERIFY: re-reading every recorded transaction on three endpoints per network');
  for (const [key, leg] of Object.entries(run.legs ?? {})) {
    for (const tx of leg.txs ?? []) {
      if (!tx.hash) continue;
      const rows = [];
      for (const which of endpointsOf(tx.chainId)) {
        try {
          const r = await nodeFor(tx.chainId, which)('eth_getTransactionReceipt', [tx.hash]);
          const canonical = r ? (await nodeFor(tx.chainId, which)('eth_getBlockByNumber', [r.blockNumber, false]))?.hash === r.blockHash : false;
          rows.push(r ? `${host(CHAINS[tx.chainId][which])}: status ${r.status}, block ${BigInt(r.blockNumber)}, gas ${BigInt(r.gasUsed)}, canonical ${canonical}` : `${host(CHAINS[tx.chainId][which])}: no receipt`);
          if (r) expect(r.status === '0x1' && canonical, `${key} ${tx.label} ${tx.hash.slice(0, 12)}… on ${host(CHAINS[tx.chainId][which])}: status ${r.status}, block ${BigInt(r.blockNumber)}, canonical ${canonical}`);
        } catch (e) {
          rows.push(`${host(CHAINS[tx.chainId][which])}: ${errText(e)}`);
          console.log(`  info ${key} ${tx.label} on ${host(CHAINS[tx.chainId][which])}: ${errText(e)}`);
        }
      }
      tx.verified = { at: new Date().toISOString(), rows };
    }
  }
  saveRun(run);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const chainRegistry = new ChainRegistry();
chainRegistry.register(evmKeyProvider);
const devPath = new URL('../../.dev-wallet/mnemonic.txt', import.meta.url);
if (!existsSync(devPath)) {
  console.error('No .dev-wallet/mnemonic.txt: the dev EOA is needed even for the dry run (it is the simulated sender).');
  process.exit(1);
}
const signer = HdKeyring.fromMnemonic(readFileSync(devPath, 'utf8').trim(), chainRegistry).getAccount('eip155:1');
const sender = getAddress(signer.address);
let commit = 'unknown';
try {
  commit = execSync('git rev-parse HEAD', { cwd: new URL('../../', import.meta.url) }).toString().trim();
} catch {}

const run = loadRun() ?? { createdAt: new Date().toISOString(), legs: {} };
run.devEoa = sender;
run.engineCommit = commit;
run.amountPerLeg = AMOUNT;
run.caps = { amountPerLeg: AMOUNT_CAP, totalUsdc: TOTAL_USDC_CAP, feesPerNetwork: FEE_CAP_PER_CHAIN };
console.log(`CCTP smoke: dev EOA ${sender}; engine at ${commit.slice(0, 7)}; ${fmtUsdc(AMOUNT)} USDC per leg; mode ${process.env.CCTP_VERIFY === '1' ? 'read-only re-verification' : LIVE ? `LIVE ${LIVE}` : 'dry run'}`);

try {
  if (process.env.CCTP_VERIFY === '1') {
    await verifyRecorded(run);
    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }
  await dryRun(sender, run);
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed in the dry run. Nothing live was attempted.`);
    process.exit(1);
  }
  if (LIVE) {
    const legs = LIVE === '1' ? [LEGS['base-arb'], LEGS['sepolia-base']] : [LEGS[LIVE]];
    for (const leg of legs) {
      await liveLeg(leg, signer, run);
      if (failures > 0) throw new Error(`${failures} check(s) failed during leg ${leg.key}. Stopped before any further leg.`);
    }
  }
} catch (e) {
  console.log(`\nSTOPPED: ${errText(e)}`);
  saveRun(run);
  process.exit(1);
}
saveRun(run);
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`}; record ${RUN_FILE.pathname.replace(/^.*\/scripts\//, 'scripts/')}`);
process.exit(failures === 0 ? 0 : 1);

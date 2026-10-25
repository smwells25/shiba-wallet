import { utf8ToBytes } from '@noble/hashes/utils.js';
import { encodeFunctionCall } from '../abi.js';
import { keccak, toBytes, toHex } from '../encoding.js';
import type { Call } from '../smart-account.js';
import type {
  BridgeAsset,
  BridgeAttestation,
  BridgeCall,
  BridgeEventLogReader,
  BridgeLog,
  BridgeOnChainDelivery,
  BridgeProvider,
  BridgeQuote,
  BridgeQuoteRequest,
  BridgeReceiptLogReader,
  BridgeRoute,
  BridgeTimeEstimate,
  BridgeTransfer,
  BridgeTransferStatus,
  BridgeTrustStatement,
} from './types.js';
import { addressToBytes32, assertUint, checksumAddress, equalPin, exactApprovalCall, isZeroAddress, sameAsset } from './util.js';

/**
 * Circle CCTP V2 as a BridgeProvider (SKELETON; phase 21 item 1).
 *
 * Every constant below comes from docs/BRIDGING.md section 4, which read
 * it on 2026-10-12 UTC from Circle's documentation and from the chain:
 *  - addresses: Circle's contract-address page
 *    (https://developers.circle.com/cctp/evm-smart-contracts), the same on
 *    all four test networks; code byte-identical there; implementations
 *    Sourcify exact matches (BRIDGING.md section 4.5 table);
 *  - domains: /cctp/concepts/supported-chains-and-domains.md (Ethereum 0,
 *    OP 2, Arbitrum 3, Base 6), confirmed by localDomain() on each chain
 *    (BRIDGING.md section 4.5);
 *  - depositForBurn(uint256 amount, uint32 destinationDomain, bytes32
 *    mintRecipient, address burnToken, bytes32 destinationCaller, uint256
 *    maxFee, uint32 minFinalityThreshold), selector 0x8e0250ee, seven
 *    fixed-size arguments (BRIDGING.md section 4.4);
 *  - finality thresholds 2000 (Standard) and 1000 (Fast) (section 4.4);
 *  - USDC addresses: Circle's USDC contract-address page as recorded in
 *    app/src/wallet/tokens.ts (fetched 2026-10-04, OP Sepolia 2026-10-11),
 *    and isMinter(TokenMinterV2) = true on all four (BRIDGING.md 4.5).
 *
 * What the skeleton does NOT do, by design:
 *  - Fast Transfers are refused, by the quote AND by the encoder
 *    (assertDepositForBurnParams accepts only finality 2000, phase 23 item
 *    4): their fee must be read from Circle's Iris API before signing and is
 *    deducted at mint, so a quote without that read would guess.
 *  - Fetching the attestation is the app's job: track() calls the
 *    injected `fetchAttestation`. Circle's documented endpoint for it is
 *    GET https://iris-api-sandbox.circle.com/v2/messages/{sourceDomain}
 *    ?transactionHash={hash} (keyless on 2026-10-12, BRIDGING.md 4.3).
 *  - Nothing here signs, sends or reads the chain: track() reads through
 *    the functions the app injects (the attestation reader, and the two log
 *    readers that make tracking follow the chains' own events).
 */

export const CCTP_V2_TESTNET = {
  tokenMessengerV2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  tokenMinterV2: '0xb43db544E2c27092c107639Ad201b3dEfAbcF192',
} as const;

/** EIP-155 chain id -> CCTP domain, for the four test networks the wallet runs on. */
export const CCTP_V2_TESTNET_DOMAINS: Readonly<Record<number, number>> = Object.freeze({
  11155111: 0, // Ethereum Sepolia
  11155420: 2, // OP Sepolia
  421614: 3, // Arbitrum Sepolia
  84532: 6, // Base Sepolia
});

/** Circle's native USDC on each of those networks (6 decimals). */
export const CCTP_V2_TESTNET_USDC: Readonly<Record<number, string>> = Object.freeze({
  11155111: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  11155420: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
  421614: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
});

export const CCTP_FINALITY_STANDARD = 2000;
export const CCTP_FINALITY_FAST = 1000;

export const CCTP_DEPOSIT_FOR_BURN_SIGNATURE =
  'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)';
/** keccak256(signature)[0:4]; recomputed in the tests. */
export const CCTP_DEPOSIT_FOR_BURN_SELECTOR = '0x8e0250ee';
export const CCTP_RECEIVE_MESSAGE_SIGNATURE = 'receiveMessage(bytes,bytes)';
export const CCTP_RECEIVE_MESSAGE_SELECTOR = '0x57ecfd28';

export interface CctpDepositForBurnParams {
  amount: bigint;
  destinationDomain: number;
  /** The address that receives the minted USDC on the destination. */
  mintRecipient: string;
  burnToken: string;
  /** Zero address (anyone may submit the mint) or a specific submitter. */
  destinationCaller: string;
  maxFee: bigint;
  minFinalityThreshold: number;
}

const KNOWN_DOMAINS = new Set(Object.values(CCTP_V2_TESTNET_DOMAINS));

/** Refuses parameters the wallet will not sign. Returns nothing when they are acceptable. */
export function assertDepositForBurnParams(p: CctpDepositForBurnParams): void {
  assertUint(p.amount, 256, 'amount');
  if (p.amount === 0n) throw new Error('The amount to bridge must be more than zero.');
  if (!Number.isInteger(p.destinationDomain) || !KNOWN_DOMAINS.has(p.destinationDomain)) {
    throw new Error(`CCTP domain ${p.destinationDomain} is not one this wallet has verified.`);
  }
  if (isZeroAddress(checksumAddress(p.mintRecipient, 'mint recipient'))) {
    throw new Error('The mint recipient must not be the zero address.');
  }
  checksumAddress(p.burnToken, 'burn token');
  checksumAddress(p.destinationCaller, 'destination caller');
  assertUint(p.maxFee, 256, 'maximum fee');
  if (p.maxFee >= p.amount) {
    // TokenMessengerV2 reverts with "Max fee must be less than amount" (BRIDGING.md section 11 step 5).
    throw new Error('The maximum fee must be less than the amount.');
  }
  // Standard Transfers only, at the encoder too (phase 23 item 4; the live
  // run of 2026-10-25 recorded that the encoder alone still accepted 1000).
  // Circle's thresholds are 1000 (Fast) and 2000 (Standard); anything else,
  // and Fast itself, is refused here so no caller can build a Fast burn.
  if (p.minFinalityThreshold !== CCTP_FINALITY_STANDARD) {
    throw new Error(
      p.minFinalityThreshold === CCTP_FINALITY_FAST
        ? 'The finality threshold must be 2000 (a Standard Transfer): this wallet never builds a Fast Transfer (finality 1000).'
        : 'The finality threshold must be 2000 (a Standard Transfer).',
    );
  }
}

/** Calldata for TokenMessengerV2.depositForBurn, exactly as BRIDGING.md section 4.4 specifies. */
export function encodeDepositForBurn(p: CctpDepositForBurnParams): Uint8Array {
  assertDepositForBurnParams(p);
  return encodeFunctionCall(CCTP_DEPOSIT_FOR_BURN_SIGNATURE, [
    { kind: 'uint256', value: p.amount },
    { kind: 'uint256', value: BigInt(p.destinationDomain) },
    { kind: 'fixedBytes', value: toBytes(addressToBytes32(p.mintRecipient)) },
    { kind: 'address', value: checksumAddress(p.burnToken) },
    { kind: 'fixedBytes', value: toBytes(addressToBytes32(p.destinationCaller)) },
    { kind: 'uint256', value: p.maxFee },
    { kind: 'uint256', value: BigInt(p.minFinalityThreshold) },
  ]);
}

/**
 * The seven words of depositForBurn, all fixed-size, each pinned to the
 * quoted value. A standing session rule would loosen only `amount` to an
 * upper bound (lessThanOrEqual); every other word stays equal.
 */
export function depositForBurnPins(p: CctpDepositForBurnParams) {
  assertDepositForBurnParams(p);
  return [
    equalPin('amount', 0, p.amount),
    equalPin('destinationDomain', 32, BigInt(p.destinationDomain)),
    equalPin('mintRecipient', 64, p.mintRecipient),
    equalPin('burnToken', 96, p.burnToken),
    equalPin('destinationCaller', 128, p.destinationCaller),
    equalPin('maxFee', 160, p.maxFee),
    equalPin('minFinalityThreshold', 192, BigInt(p.minFinalityThreshold)),
  ];
}

/** Calldata for MessageTransmitterV2.receiveMessage(message, attestation) on the destination. */
export function encodeReceiveMessage(message: string, attestation: string): Uint8Array {
  const m = toBytes(message);
  const a = toBytes(attestation);
  if (m.length === 0 || a.length === 0) throw new Error('A CCTP mint needs both the message and its attestation.');
  return encodeFunctionCall(CCTP_RECEIVE_MESSAGE_SIGNATURE, [
    { kind: 'bytes', value: m },
    { kind: 'bytes', value: a },
  ]);
}

// ---------------------------------------------------------------------------
// Measured delivery (phase 23 item 4, the live leg of 2026-10-25)
// ---------------------------------------------------------------------------

/**
 * Burn block to mint block, measured once per route in the live run of
 * 2026-10-25 (docs/BRIDGING.md section 17; scripts/testnet/cctp-smoke.mjs):
 * 996 s Base Sepolia -> Arbitrum Sepolia and 1,058 s Ethereum Sepolia ->
 * Base Sepolia, one 1 USDC Standard Transfer each, the mint sent as soon as
 * the attestation appeared. One measurement is not a range, so the quote's
 * minSeconds / maxSeconds stay Circle's documented "~15-19 minutes".
 */
export const CCTP_V2_TESTNET_MEASURED = Object.freeze({
  date: '2026-10-25',
  summary:
    'Measured once on the test networks on 2026-10-25: 996 s Base Sepolia → Arbitrum Sepolia and 1,058 s Ethereum Sepolia → Base Sepolia (from the burn block to the mint block, one 1 USDC Standard Transfer each, the mint sent as soon as the attestation appeared).',
  /** Seconds keyed "source chain id->destination chain id". */
  seconds: Object.freeze({ '84532->421614': 996, '11155111->84532': 1058 } as Record<string, number>),
});

const CCTP_DOCUMENTED_TIME =
  'Circle documents "~15-19 minutes" for a Standard Transfer from Ethereum, Arbitrum, Base and OP mainnets: it attests a burn only after the sending network\'s hard finality.';

/** The quote's time estimate for a route: Circle's documented range, and the live measurement where one exists. Never a promise. */
export function cctpTimeEstimate(sourceChainId: number, destinationChainId: number): BridgeTimeEstimate {
  const m = CCTP_V2_TESTNET_MEASURED;
  const seconds = m.seconds[`${sourceChainId}->${destinationChainId}`];
  const estimate: BridgeTimeEstimate = {
    minSeconds: 15 * 60,
    maxSeconds: 19 * 60,
    source:
      `${CCTP_DOCUMENTED_TIME} ${m.summary} ${seconds === undefined ? 'This route was not measured.' : `This route took ${seconds} s that once.`} ` +
      'Not a promise: the attestation waits for the sending network\'s hard finality, and the mint on the receiving network is a transaction of its own that someone has to send.',
  };
  if (seconds !== undefined) {
    estimate.measured = { seconds, date: m.date, description: `Measured once on ${m.date}, from the burn block to the mint block.` };
  }
  return estimate;
}

// ---------------------------------------------------------------------------
// Events and the message layout (tracking from the chains' own events)
// ---------------------------------------------------------------------------

/**
 * Event signatures from Circle's evm-cctp-contracts at commit
 * 63ab1f0ac06ce0793c0bbfbb8d09816bc211386d (the commit the technical guide
 * links; docs/BRIDGING.md section 17): MessageTransmitterV2.sol line 38
 * (MessageSent(bytes message), nothing indexed) and lines 49-56
 * (MessageReceived: caller, nonce and finalityThresholdExecuted indexed);
 * TokenMessengerV2.sol lines 50-61 (DepositForBurn: burnToken, depositor
 * and minFinalityThreshold indexed); BaseTokenMessenger.sol lines 72-77
 * (MintAndWithdraw: mintRecipient and mintToken indexed). Topics are
 * keccak256 of the signature, pinned against ethers in the tests.
 */
export const CCTP_MESSAGE_SENT_EVENT_SIGNATURE = 'MessageSent(bytes)';
export const CCTP_MESSAGE_RECEIVED_EVENT_SIGNATURE = 'MessageReceived(address,uint32,bytes32,bytes32,uint32,bytes)';
export const CCTP_DEPOSIT_FOR_BURN_EVENT_SIGNATURE =
  'DepositForBurn(address,uint256,address,bytes32,uint32,bytes32,bytes32,uint256,uint32,bytes)';
export const CCTP_MINT_AND_WITHDRAW_EVENT_SIGNATURE = 'MintAndWithdraw(address,uint256,address,uint256)';

function eventTopic(signature: string): string {
  return toHex(keccak(utf8ToBytes(signature)));
}

export const CCTP_MESSAGE_SENT_TOPIC = eventTopic(CCTP_MESSAGE_SENT_EVENT_SIGNATURE);
export const CCTP_MESSAGE_RECEIVED_TOPIC = eventTopic(CCTP_MESSAGE_RECEIVED_EVENT_SIGNATURE);
export const CCTP_DEPOSIT_FOR_BURN_TOPIC = eventTopic(CCTP_DEPOSIT_FOR_BURN_EVENT_SIGNATURE);
export const CCTP_MINT_AND_WITHDRAW_TOPIC = eventTopic(CCTP_MINT_AND_WITHDRAW_EVENT_SIGNATURE);

/**
 * MessageV2 (MessageV2.sol lines 52-61) and BurnMessageV2 (BurnMessage.sol
 * 35-43, BurnMessageV2.sol 49-52) byte ranges, as Circle's technical guide
 * also tabulates them ("Message body"); the same layout the live smoke
 * script decoded.
 */
export const CCTP_MESSAGE_LAYOUT = Object.freeze({
  version: [0, 4],
  sourceDomain: [4, 8],
  destinationDomain: [8, 12],
  nonce: [12, 44],
  sender: [44, 76],
  recipient: [76, 108],
  destinationCaller: [108, 140],
  minFinalityThreshold: [140, 144],
  finalityThresholdExecuted: [144, 148],
  body: 148,
} as const);
export const CCTP_BURN_BODY_LAYOUT = Object.freeze({
  version: [0, 4],
  burnToken: [4, 36],
  mintRecipient: [36, 68],
  amount: [68, 100],
  messageSender: [100, 132],
  maxFee: [132, 164],
  feeExecuted: [164, 196],
  expirationBlock: [196, 228],
  hookData: 228,
} as const);

/** A CCTP V2 burn message, decoded. Byte fields are lower-case hex. */
export interface CctpBurnMessage {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: string;
  sender: string;
  recipient: string;
  destinationCaller: string;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: {
    version: number;
    burnToken: string;
    mintRecipient: string;
    amount: bigint;
    messageSender: string;
    maxFee: bigint;
    feeExecuted: bigint;
    expirationBlock: bigint;
    hookData: string;
  };
}

/** The shortest burn message: the 148-byte header and the 228-byte body without hook data. */
export const CCTP_BURN_MESSAGE_MIN_BYTES = 148 + 228;
/** The longest message this wallet accepts (judgement: its own burns carry no hook data, 376 bytes). */
export const CCTP_BURN_MESSAGE_MAX_BYTES = 4096;

function hexBody(value: string, what: string): string {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new Error(`The ${what} must be whole bytes of hex.`);
  return value.slice(2).toLowerCase();
}

/** Decodes a CCTP V2 burn message; refuses anything shorter than the fixed layout or longer than the wallet accepts. */
export function decodeCctpBurnMessage(messageHex: string): CctpBurnMessage {
  const h = hexBody(messageHex, 'CCTP message');
  const bytes = h.length / 2;
  if (bytes < CCTP_BURN_MESSAGE_MIN_BYTES || bytes > CCTP_BURN_MESSAGE_MAX_BYTES) {
    throw new Error(`A CCTP burn message is ${CCTP_BURN_MESSAGE_MIN_BYTES} to ${CCTP_BURN_MESSAGE_MAX_BYTES} bytes; this one is ${bytes}.`);
  }
  const at = (base: number, [a, b]: readonly [number, number]) => '0x' + h.slice((base + a) * 2, (base + b) * 2);
  const num = (base: number, r: readonly [number, number]) => BigInt(at(base, r));
  const M = CCTP_MESSAGE_LAYOUT;
  const B = CCTP_BURN_BODY_LAYOUT;
  const o = M.body;
  return {
    version: Number(num(0, M.version)),
    sourceDomain: Number(num(0, M.sourceDomain)),
    destinationDomain: Number(num(0, M.destinationDomain)),
    nonce: at(0, M.nonce),
    sender: at(0, M.sender),
    recipient: at(0, M.recipient),
    destinationCaller: at(0, M.destinationCaller),
    minFinalityThreshold: Number(num(0, M.minFinalityThreshold)),
    finalityThresholdExecuted: Number(num(0, M.finalityThresholdExecuted)),
    body: {
      version: Number(num(o, B.version)),
      burnToken: at(o, B.burnToken),
      mintRecipient: at(o, B.mintRecipient),
      amount: num(o, B.amount),
      messageSender: at(o, B.messageSender),
      maxFee: num(o, B.maxFee),
      feeExecuted: num(o, B.feeExecuted),
      expirationBlock: num(o, B.expirationBlock),
      hookData: '0x' + h.slice((o + B.hookData) * 2),
    },
  };
}

/**
 * The byte ranges Circle fills in after the burn: the header's nonce and
 * executed finality, and the body's executed fee and expiration block. Every
 * other byte of the attested message must equal the MessageSent message (the
 * live run of 2026-10-25 checked exactly this).
 */
const CCTP_FILLED_RANGES: readonly (readonly [number, number])[] = [
  CCTP_MESSAGE_LAYOUT.nonce,
  CCTP_MESSAGE_LAYOUT.finalityThresholdExecuted,
  [CCTP_MESSAGE_LAYOUT.body + CCTP_BURN_BODY_LAYOUT.feeExecuted[0], CCTP_MESSAGE_LAYOUT.body + CCTP_BURN_BODY_LAYOUT.feeExecuted[1]],
  [CCTP_MESSAGE_LAYOUT.body + CCTP_BURN_BODY_LAYOUT.expirationBlock[0], CCTP_MESSAGE_LAYOUT.body + CCTP_BURN_BODY_LAYOUT.expirationBlock[1]],
];

function maskFilled(messageHex: string): string {
  let h = hexBody(messageHex, 'CCTP message');
  for (const [a, b] of CCTP_FILLED_RANGES) h = h.slice(0, a * 2) + '0'.repeat((b - a) * 2) + h.slice(b * 2);
  return h;
}

/** True when the attested message is the sent one with only Circle's fields filled in. */
export function cctpAttestedMatchesSent(sentHex: string, attestedHex: string): boolean {
  try {
    const sent = hexBody(sentHex, 'sent message');
    const attested = hexBody(attestedHex, 'attested message');
    return sent.length === attested.length && maskFilled(sentHex) === maskFilled(attestedHex);
  } catch {
    return false;
  }
}

function wordsOf(dataHex: string, what: string): string[] {
  const h = hexBody(dataHex, what);
  if (h.length % 64 !== 0) throw new Error(`The ${what} is not a whole number of 32-byte words.`);
  const out: string[] = [];
  for (let i = 0; i < h.length; i += 64) out.push('0x' + h.slice(i, i + 64));
  return out;
}

/** The single dynamic `bytes` value of ABI-encoded data whose head word at `headIndex` is its offset. */
function abiBytesAt(dataHex: string, headIndex: number, what: string): string {
  const h = hexBody(dataHex, what);
  const words = wordsOf(dataHex, what);
  const offset = BigInt(words[headIndex] ?? '0x');
  if (offset % 32n !== 0n || offset / 32n >= BigInt(words.length)) throw new Error(`The ${what} has a malformed bytes offset.`);
  const lenIndex = Number(offset / 32n);
  const len = BigInt(words[lenIndex]!);
  const start = (lenIndex + 1) * 64;
  if (len > BigInt(CCTP_BURN_MESSAGE_MAX_BYTES) || start + Number(len) * 2 > h.length) throw new Error(`The ${what} has a malformed bytes length.`);
  return '0x' + h.slice(start, start + Number(len) * 2);
}

function topicIs(log: BridgeLog, topic: string): boolean {
  return typeof log.topics[0] === 'string' && log.topics[0].toLowerCase() === topic;
}

function sameAddress(a: string, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** The message carried by a MessageSent log. */
export function decodeCctpMessageSentLog(log: BridgeLog): string {
  if (!topicIs(log, CCTP_MESSAGE_SENT_TOPIC) || log.topics.length !== 1) throw new Error('This log is not a MessageSent event.');
  return abiBytesAt(log.data, 0, 'MessageSent data');
}

export interface CctpMessageReceivedEvent {
  emitter: string;
  caller: string;
  sourceDomain: number;
  nonce: string;
  sender: string;
  finalityThresholdExecuted: number;
}

/** MessageReceived (caller, nonce, finality indexed; sourceDomain, sender and the body in data). */
export function decodeCctpMessageReceivedLog(log: BridgeLog): CctpMessageReceivedEvent {
  if (!topicIs(log, CCTP_MESSAGE_RECEIVED_TOPIC) || log.topics.length !== 4) throw new Error('This log is not a MessageReceived event.');
  const words = wordsOf(log.data, 'MessageReceived data');
  if (words.length < 4) throw new Error('MessageReceived data is too short.');
  const domain = BigInt(words[0]!);
  const finality = BigInt(log.topics[3]!);
  if (domain >= 1n << 32n || finality >= 1n << 32n) throw new Error('MessageReceived carries a domain or finality that is not a uint32.');
  const caller = BigInt(log.topics[1]!);
  if (caller >= 1n << 160n) throw new Error('MessageReceived carries a caller that is not an address.');
  return {
    emitter: checksumAddress(log.address, 'MessageReceived emitter'),
    caller: checksumAddress('0x' + caller.toString(16).padStart(40, '0'), 'MessageReceived caller'),
    sourceDomain: Number(domain),
    nonce: log.topics[2]!.toLowerCase(),
    sender: words[1]!.toLowerCase(),
    finalityThresholdExecuted: Number(finality),
  };
}

export interface CctpMintAndWithdrawEvent {
  emitter: string;
  mintRecipient: string;
  amount: bigint;
  mintToken: string;
  feeCollected: bigint;
}

/** MintAndWithdraw (mintRecipient and mintToken indexed; amount and feeCollected in data). */
export function decodeCctpMintAndWithdrawLog(log: BridgeLog): CctpMintAndWithdrawEvent {
  if (!topicIs(log, CCTP_MINT_AND_WITHDRAW_TOPIC) || log.topics.length !== 3) throw new Error('This log is not a MintAndWithdraw event.');
  const words = wordsOf(log.data, 'MintAndWithdraw data');
  if (words.length !== 2) throw new Error('MintAndWithdraw data must be exactly two words.');
  const addr = (t: string, what: string) => {
    const w = BigInt(t);
    if (w >= 1n << 160n) throw new Error(`The ${what} is not an address.`);
    return checksumAddress('0x' + w.toString(16).padStart(40, '0'), what);
  };
  return {
    emitter: checksumAddress(log.address, 'MintAndWithdraw emitter'),
    mintRecipient: addr(log.topics[1]!, 'MintAndWithdraw recipient'),
    amount: BigInt(words[0]!),
    mintToken: addr(log.topics[2]!, 'MintAndWithdraw token'),
    feeCollected: BigInt(words[1]!),
  };
}

/** What the wallet's own Standard Transfer burn for one transfer looks like in the source receipt. */
export interface CctpBurnInReceipt {
  message: string;
  decoded: CctpBurnMessage;
  /** The block of the MessageSent log, when the receipt's logs carry it. */
  block: bigint | null;
}

/**
 * Finds the burn for `transfer` in a source receipt: exactly one MessageSent
 * from MessageTransmitterV2 and exactly one DepositForBurn from
 * TokenMessengerV2, the message being a version-1 Standard Transfer from the
 * route's source domain to its destination domain, sent by and to
 * TokenMessengerV2, with any destination caller allowed (zero), the route's
 * USDC as the burn token, this transfer's recipient and amount, maxFee 0 and
 * no hook data. Null when the receipt holds no such burn (or more than one).
 */
export function findCctpBurn(
  logs: readonly BridgeLog[],
  expect: { sourceChainId: number; destinationChainId: number; amount: bigint; recipient: string },
): CctpBurnInReceipt | null {
  const sent = logs.filter((l) => sameAddress(l.address, CCTP_V2_TESTNET.messageTransmitterV2) && topicIs(l, CCTP_MESSAGE_SENT_TOPIC));
  const deposits = logs.filter((l) => sameAddress(l.address, CCTP_V2_TESTNET.tokenMessengerV2) && topicIs(l, CCTP_DEPOSIT_FOR_BURN_TOPIC));
  if (sent.length !== 1 || deposits.length !== 1) return null;
  let message: string;
  let d: CctpBurnMessage;
  try {
    message = decodeCctpMessageSentLog(sent[0]!);
    d = decodeCctpBurnMessage(message);
  } catch {
    return null;
  }
  const tm = addressToBytes32(CCTP_V2_TESTNET.tokenMessengerV2).toLowerCase();
  const usdc = CCTP_V2_TESTNET_USDC[expect.sourceChainId];
  if (!usdc) return null;
  const ok =
    d.version === 1 &&
    d.sourceDomain === CCTP_V2_TESTNET_DOMAINS[expect.sourceChainId] &&
    d.destinationDomain === CCTP_V2_TESTNET_DOMAINS[expect.destinationChainId] &&
    d.sender === tm &&
    d.recipient === tm &&
    BigInt(d.destinationCaller) === 0n &&
    d.minFinalityThreshold === CCTP_FINALITY_STANDARD &&
    d.body.version === 1 &&
    d.body.burnToken === addressToBytes32(usdc).toLowerCase() &&
    d.body.mintRecipient === addressToBytes32(expect.recipient).toLowerCase() &&
    d.body.amount === expect.amount &&
    d.body.maxFee === 0n &&
    d.body.hookData === '0x';
  if (!ok) return null;
  // The DepositForBurn log must agree on the token, the amount and the recipient.
  const dep = deposits[0]!;
  try {
    const w = wordsOf(dep.data, 'DepositForBurn data');
    if (dep.topics.length !== 4 || BigInt(dep.topics[1]!) !== BigInt(usdc) || BigInt(w[0]!) !== expect.amount) return null;
    if (w[1]!.toLowerCase() !== d.body.mintRecipient || BigInt(w[2]!) !== BigInt(d.destinationDomain)) return null;
  } catch {
    return null;
  }
  const bn = sent[0]!.blockNumber;
  const block = typeof bn === 'string' && /^0x[0-9a-fA-F]+$/.test(bn) ? BigInt(bn) : null;
  return { message, decoded: d, block };
}

/** What the app's attestation reader returns. */
export type CctpAttestationResult =
  | { status: 'pending' }
  | { status: 'complete'; message: string; attestation: string };

/**
 * Supplied by the app: reads Circle's attestation for a burn. The
 * documented call is GET https://iris-api-sandbox.circle.com/v2/messages/
 * {sourceDomain}?transactionHash={sourceTxHash} (mainnet host
 * iris-api.circle.com); the attestation is verified on-chain by
 * MessageTransmitterV2, so the API can withhold one but cannot forge one.
 */
export type CctpAttestationFetcher = (request: { sourceDomain: number; sourceTxHash: string }) => Promise<CctpAttestationResult>;

/** Optional, supplied by the app: whether the mint for this transfer already happened on the destination. */
export type CctpMintChecker = (request: { destinationChainId: number; message: string }) => Promise<boolean>;

export interface CctpV2ProviderOptions {
  /** Restrict to these chain ids (default: all four test networks). */
  chainIds?: number[];
  fetchAttestation?: CctpAttestationFetcher;
  /** Without the log readers only: whether the mint happened (the live smoke script reads usedNonces). */
  isMinted?: CctpMintChecker;
  /**
   * The source transaction's receipt, to find the burn and its message.
   * Give both log readers or neither; with them, track() decides from the
   * chains' own events, and Circle's API is only the source of the
   * attestation (the input to the mint), never of the delivery.
   */
  readSourceReceipt?: BridgeReceiptLogReader;
  /** eth_getLogs on the receiving chain, to find MessageReceived and MintAndWithdraw for the message's nonce. */
  readDestinationLogs?: BridgeEventLogReader;
}

export const CCTP_V2_TRUST: BridgeTrustStatement = {
  verification:
    'Circle verifies every transfer: both of Circle\'s two attesters must sign the burn (2 of 2, read on-chain) before USDC can be minted on the other network. Circle also issues USDC itself.',
  control:
    'Circle can pause transfers, refuse listed addresses (it checks the sending account and the transaction originator, which for a smart account is the bundler), and replace the contracts. On the test networks the roles that do this (the proxy admins, the owner, the denylister, the pauser and the attester manager) are held by addresses with no contract code.',
  refundRule:
    'There is no refund: the USDC is burned on the sending network. Circle attests the burn only after the sending network\'s hard finality (about 17 minutes in the measured runs); after that, anyone with gas on the receiving network can submit the mint to your address.',
};

function usdcAsset(chainId: number): BridgeAsset {
  const address = CCTP_V2_TESTNET_USDC[chainId];
  if (!address) throw new Error(`Chain ${chainId} has no verified CCTP USDC.`);
  return { kind: 'erc20', address, symbol: 'USDC', decimals: 6 };
}

export const CCTP_V2_PROVIDER_ID = 'cctp-v2';

export function createCctpV2Provider(options: CctpV2ProviderOptions = {}): BridgeProvider {
  if ((options.readSourceReceipt === undefined) !== (options.readDestinationLogs === undefined)) {
    throw new Error('Give the CCTP provider both log readers (source receipt and destination logs) or neither.');
  }
  const chains = (options.chainIds ?? Object.keys(CCTP_V2_TESTNET_DOMAINS).map(Number)).map((id) => {
    if (CCTP_V2_TESTNET_DOMAINS[id] === undefined) throw new Error(`Chain ${id} is not a verified CCTP V2 test network.`);
    return id;
  });
  const routes: BridgeRoute[] = [];
  for (const source of chains) {
    for (const destination of chains) {
      if (source === destination) continue;
      routes.push({
        providerId: CCTP_V2_PROVIDER_ID,
        sourceChainId: source,
        destinationChainId: destination,
        sourceAsset: usdcAsset(source),
        destinationAsset: usdcAsset(destination),
      });
    }
  }
  Object.freeze(routes);

  function findRoute(route: BridgeRoute): BridgeRoute {
    const found = routes.find(
      (r) =>
        r.sourceChainId === route.sourceChainId &&
        r.destinationChainId === route.destinationChainId &&
        sameAsset(r.sourceAsset, route.sourceAsset) &&
        sameAsset(r.destinationAsset, route.destinationAsset),
    );
    if (!found) throw new Error('CCTP V2 does not serve this route in this wallet.');
    return found;
  }

  async function quote(request: BridgeQuoteRequest): Promise<BridgeQuote> {
    const route = findRoute(request.route);
    const sender = checksumAddress(request.sender, 'sender');
    const recipient = checksumAddress(request.recipient, 'recipient');
    if (isZeroAddress(sender)) throw new Error('The sender must not be the zero address.');
    // Standard Transfer only: maxFee 0, finality 2000 (see the module comment).
    const params: CctpDepositForBurnParams = {
      amount: request.amount,
      destinationDomain: CCTP_V2_TESTNET_DOMAINS[route.destinationChainId]!,
      mintRecipient: recipient,
      burnToken: CCTP_V2_TESTNET_USDC[route.sourceChainId]!,
      destinationCaller: '0x0000000000000000000000000000000000000000',
      maxFee: 0n,
      minFinalityThreshold: CCTP_FINALITY_STANDARD,
    };
    assertDepositForBurnParams(params);
    if (request.minAmountOut !== undefined && request.minAmountOut > request.amount) {
      throw new Error('A Standard Transfer delivers at most the amount sent; the minimum asked for is higher.');
    }
    const approve = exactApprovalCall(
      route.sourceChainId,
      params.burnToken,
      CCTP_V2_TESTNET.tokenMessengerV2,
      request.amount,
      'Allow Circle\'s TokenMessengerV2 to burn exactly this amount of USDC',
    );
    const burn: BridgeCall = {
      purpose: 'bridge',
      chainId: route.sourceChainId,
      to: CCTP_V2_TESTNET.tokenMessengerV2,
      value: 0n,
      data: encodeDepositForBurn(params),
      label: 'Burn the USDC with Circle CCTP for minting on the other network',
      selector: CCTP_DEPOSIT_FOR_BURN_SELECTOR,
      pins: depositForBurnPins(params),
      unpinnable: [],
      valueLimit: 0n,
    };
    return {
      providerId: CCTP_V2_PROVIDER_ID,
      route,
      amountIn: request.amount,
      expectedAmountOut: request.amount,
      minAmountOut: request.amount,
      fees: [
        {
          kind: 'protocol',
          description:
            'Circle protocol fee for a Standard Transfer: zero (maxFee is signed as 0, so the burn cannot be charged more).',
          amount: 0n,
          asset: route.sourceAsset,
          deductedFromAmount: true,
          chainId: route.sourceChainId,
        },
      ],
      time: cctpTimeEstimate(route.sourceChainId, route.destinationChainId),
      approvals: [
        { chainId: route.sourceChainId, token: params.burnToken, spender: CCTP_V2_TESTNET.tokenMessengerV2, amount: request.amount },
      ],
      calls: [approve, burn],
      destination: {
        kind: 'mint-after-attestation',
        submitter: 'anyone',
        description:
          'After Circle attests the burn, a receiveMessage transaction on the receiving network mints the USDC to your address. Anyone with gas there may send it; the recipient is fixed by the attested message.',
      },
      refundRule: CCTP_V2_TRUST.refundRule,
      tracking: {
        description: "Circle's Iris API returns the message and attestation for the burn transaction; the mint is then visible on the receiving network.",
        needsHttpApi: true,
        needsApiKey: false,
      },
      notes: [
        "Circle's USDC fee paymaster cannot pay for the first mint on a network where this account holds no USDC: it takes its fee before the mint runs.",
      ],
    };
  }

  async function track(transfer: BridgeTransfer): Promise<BridgeTransferStatus> {
    if (options.readSourceReceipt && options.readDestinationLogs) {
      return trackOnChain(transfer, options.readSourceReceipt, options.readDestinationLogs);
    }
    return trackByApi(transfer);
  }

  /**
   * Tracking from the chains' own events (phase 23 item 4). The source
   * receipt must hold this transfer's burn (findCctpBurn). Circle's API
   * (or an attestation the app stored earlier) supplies the attested
   * message, which must equal the burned message except the four fields
   * Circle fills in, and must carry a nonce, the Standard finality and no
   * fee. Then the receiving chain decides: a MessageReceived for that nonce
   * from the source domain and TokenMessengerV2, in the same transaction as
   * a MintAndWithdraw to this recipient of the amount less the executed
   * fee, means delivered; otherwise the mint call is built for anyone with
   * gas there to send.
   */
  async function trackOnChain(
    transfer: BridgeTransfer,
    readSourceReceipt: BridgeReceiptLogReader,
    readDestinationLogs: BridgeEventLogReader,
  ): Promise<BridgeTransferStatus> {
    const r = findRoute(transfer.route);
    if (!/^0x[0-9a-fA-F]{64}$/.test(transfer.sourceTxHash)) throw new Error('The source transaction hash must be 32 bytes of hex.');
    const recipient = checksumAddress(transfer.recipient, 'recipient');
    const none = { guid: null, destinationTx: null, amountReceived: null, apiStatus: null };
    const result = (
      state: BridgeTransferStatus['state'],
      onChain: BridgeOnChainDelivery,
      detail: string,
      extra: Partial<BridgeTransferStatus> = {},
    ): BridgeTransferStatus => {
      const status: BridgeTransferStatus = { state, detail, onChain, ...extra };
      if (onChain.destinationTx) status.destinationTxHash = onChain.destinationTx;
      return status;
    };
    const receipt = await readSourceReceipt({ chainId: r.sourceChainId, txHash: transfer.sourceTxHash.toLowerCase() });
    if (!receipt) return result('unknown', { status: 'unknown', ...none }, 'The burn transaction has no receipt yet; it may still be pending.');
    if (receipt.status === 'reverted') {
      return result(
        'failed',
        { status: 'source-reverted', ...none },
        'The burn transaction reverted, so no USDC was burned and nothing was bridged; only its network fee was spent.',
      );
    }
    const burn = findCctpBurn(receipt.logs, {
      sourceChainId: r.sourceChainId,
      destinationChainId: r.destinationChainId,
      amount: transfer.amountIn,
      recipient,
    });
    if (!burn) {
      return result(
        'unknown',
        { status: 'unknown', ...none },
        'The sending transaction does not carry exactly one CCTP burn matching this transfer (route, recipient, amount, a Standard Transfer with no fee), so it is not followed as this transfer.',
      );
    }
    const sourceBlock = burn.block;
    const blockText = sourceBlock === null ? '' : ` (block ${sourceBlock})`;
    let attested: { message: string; attestation: string } | null = null;
    let fromStore = false;
    if (transfer.attested) {
      attested = transfer.attested;
      fromStore = true;
    } else if (options.fetchAttestation) {
      const answer = await options.fetchAttestation({ sourceDomain: CCTP_V2_TESTNET_DOMAINS[r.sourceChainId]!, sourceTxHash: transfer.sourceTxHash });
      if (answer.status === 'complete') attested = { message: answer.message, attestation: answer.attestation };
    } else {
      return result(
        'in-flight',
        { status: 'in-flight', ...none, sourceBlock },
        `The USDC was burned on the sending network${blockText}. This build has no reader for Circle's attestation, so the wallet cannot tell when the mint can be sent.`,
      );
    }
    if (!attested) {
      return result(
        'in-flight',
        { status: 'in-flight', ...none, sourceBlock },
        `The USDC was burned on the sending network${blockText}. Waiting for Circle's attestation, which comes after the sending network's hard finality.`,
      );
    }
    let decoded: CctpBurnMessage | null = null;
    try {
      decoded = decodeCctpBurnMessage(attested.message);
      hexBody(attested.attestation, 'attestation');
    } catch {
      decoded = null;
    }
    const sigBytes = typeof attested.attestation === 'string' ? (attested.attestation.length - 2) / 2 : 0;
    const a = decoded;
    const attestationOk =
      a !== null &&
      cctpAttestedMatchesSent(burn.message, attested.message) &&
      BigInt(a.nonce) !== 0n &&
      a.finalityThresholdExecuted >= CCTP_FINALITY_STANDARD &&
      a.body.feeExecuted === 0n &&
      sigBytes > 0 &&
      sigBytes % 65 === 0 &&
      /^0x([0-9a-fA-F]{2})+$/.test(attested.attestation);
    if (!attestationOk || a === null) {
      return result(
        'unknown',
        { status: 'unknown', ...none, sourceBlock },
        `${fromStore ? 'The attestation stored on this phone' : "The attestation Circle's API returned"} does not match the burn in the sending transaction (or is not a Standard Transfer's with no fee), so the wallet did not build a mint from it.`,
      );
    }
    const nonce = a.nonce;
    const attestation: BridgeAttestation = {
      message: '0x' + hexBody(attested.message, 'attested message'),
      attestation: '0x' + hexBody(attested.attestation, 'attestation'),
      nonce,
      expirationBlock: a.body.expirationBlock,
    };
    const mt = CCTP_V2_TESTNET.messageTransmitterV2;
    const tm = CCTP_V2_TESTNET.tokenMessengerV2;
    const tmWord = addressToBytes32(tm).toLowerCase();
    const sourceDomain = CCTP_V2_TESTNET_DOMAINS[r.sourceChainId]!;
    const received = await readDestinationLogs({ chainId: r.destinationChainId, address: mt, topics: [CCTP_MESSAGE_RECEIVED_TOPIC, null, nonce] });
    const receivedTxs: string[] = [];
    let mismatched = false;
    for (const log of received) {
      if (!sameAddress(log.address, mt) || !topicIs(log, CCTP_MESSAGE_RECEIVED_TOPIC)) continue;
      let ev: CctpMessageReceivedEvent;
      try {
        ev = decodeCctpMessageReceivedLog(log);
      } catch {
        continue;
      }
      if (ev.nonce !== nonce) continue;
      if (ev.sourceDomain !== sourceDomain || ev.sender !== tmWord || typeof log.transactionHash !== 'string') {
        mismatched = true;
        continue;
      }
      receivedTxs.push(log.transactionHash.toLowerCase());
    }
    if (receivedTxs.length > 0) {
      const usdcDest = CCTP_V2_TESTNET_USDC[r.destinationChainId]!;
      const mints = await readDestinationLogs({
        chainId: r.destinationChainId,
        address: tm,
        topics: [CCTP_MINT_AND_WITHDRAW_TOPIC, addressToBytes32(recipient).toLowerCase(), addressToBytes32(usdcDest).toLowerCase()],
      });
      const want = transfer.amountIn - a.body.feeExecuted;
      for (const log of mints) {
        if (!sameAddress(log.address, tm) || !topicIs(log, CCTP_MINT_AND_WITHDRAW_TOPIC)) continue;
        if (typeof log.transactionHash !== 'string' || !receivedTxs.includes(log.transactionHash.toLowerCase())) continue;
        let m: CctpMintAndWithdrawEvent;
        try {
          m = decodeCctpMintAndWithdrawLog(log);
        } catch {
          continue;
        }
        if (sameAddress(m.mintRecipient, recipient) && sameAddress(m.mintToken, usdcDest) && m.amount === want && m.feeCollected === a.body.feeExecuted) {
          const destinationTx = log.transactionHash;
          return result(
            'delivered',
            { status: 'delivered', guid: nonce, destinationTx, amountReceived: m.amount, apiStatus: null, sourceBlock },
            `Delivered: the receiving network shows MessageReceived for this transfer's message (nonce ${nonce}) and MintAndWithdraw of ${m.amount} base units of USDC to ${recipient} in transaction ${destinationTx}.`,
            { attestation },
          );
        }
      }
      mismatched = true;
    }
    if (mismatched) {
      return result(
        'unknown',
        { status: 'unknown', guid: nonce, destinationTx: null, amountReceived: null, apiStatus: null, sourceBlock },
        `The receiving network shows events for nonce ${nonce} that do not match this transfer (source, recipient, token or amount), so the wallet does not call it delivered and builds no mint.`,
      );
    }
    const mint: Call = { to: mt, value: 0n, data: encodeReceiveMessage(attestation.message, attestation.attestation) };
    return result(
      'awaiting-destination-action',
      { status: 'attested', guid: nonce, destinationTx: null, amountReceived: null, apiStatus: null, sourceBlock },
      `Circle attested the burn (nonce ${nonce}). The USDC is minted on the receiving network by a receiveMessage transaction there, which anyone with gas on that network may send; the recipient and amount are fixed by the attested message.`,
      { destinationCalls: [mint], attestation },
    );
  }

  async function trackByApi(transfer: BridgeTransfer): Promise<BridgeTransferStatus> {
    const route = findRoute(transfer.route);
    if (!/^0x[0-9a-fA-F]{64}$/.test(transfer.sourceTxHash)) throw new Error('The source transaction hash must be 32 bytes of hex.');
    if (!options.fetchAttestation) {
      return { state: 'unknown', detail: 'This build has no attestation reader, so the transfer cannot be followed here.' };
    }
    const result = await options.fetchAttestation({
      sourceDomain: CCTP_V2_TESTNET_DOMAINS[route.sourceChainId]!,
      sourceTxHash: transfer.sourceTxHash,
    });
    if (result.status === 'pending') {
      return { state: 'in-flight', detail: 'Waiting for Circle to attest the burn.' };
    }
    if (options.isMinted && (await options.isMinted({ destinationChainId: route.destinationChainId, message: result.message }))) {
      return { state: 'delivered', detail: 'The USDC was minted on the receiving network.' };
    }
    const mint: Call = {
      to: CCTP_V2_TESTNET.messageTransmitterV2,
      value: 0n,
      data: encodeReceiveMessage(result.message, result.attestation),
    };
    return {
      state: 'awaiting-destination-action',
      detail: 'Circle attested the burn. Send the mint transaction on the receiving network to complete the transfer.',
      destinationCalls: [mint],
    };
  }

  return {
    id: CCTP_V2_PROVIDER_ID,
    label: 'Circle CCTP (USDC)',
    trust: CCTP_V2_TRUST,
    supportedRoutes: () => routes,
    quote,
    track,
  };
}


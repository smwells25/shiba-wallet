import { utf8ToBytes } from '@noble/hashes/utils.js';
import { encodeFunctionCall, type AbiValue } from '../abi.js';
import { keccak, toBytes, toHex } from '../encoding.js';
import type { Call } from '../smart-account.js';
import type {
  BridgeAsset,
  BridgeBlockReader,
  BridgeDestinationSearch,
  BridgeCall,
  BridgeEventLogReader,
  BridgeFeeLine,
  BridgeLog,
  BridgeOnChainDelivery,
  BridgePin,
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
import { planDestinationSearch, searchPlannedLogs, searchRangeText, searchSpanText, type BridgeSearchCache } from './search.js';
import { addressToBytes32, assertUint, capPin, checksumAddress, equalPin, exactApprovalCall, isZeroAddress, sameAsset } from './util.js';

/**
 * LayerZero V2 Omnichain Fungible Tokens (OFT) as a BridgeProvider
 * (SKELETON; phase 21 item 1). Research: docs/BRIDGING.md section 15.
 *
 * SOURCES:
 *  - [S] LayerZero-Labs/LayerZero-v2 commit
 *    9c741e7f9790639537b1710a203bcdfd73b0b9ac (main on 2026-10-15):
 *    packages/layerzero-v2/evm/oapp/contracts/oft/interfaces/IOFT.sol
 *    (SendParam lines 10-18, quoteOFT 113-115, quoteSend 127, send
 *    144-148), oft/OFTCore.sol (send 173-197, _debitView dust removal and
 *    SlippageExceeded 349-363, _buildMsgAndOptions 206-227),
 *    oapp/OAppSender.sol (_payNative: msg.value must equal the native fee,
 *    line 105), oapp/libs/OAppOptionsType3.sol (combineOptions 63-85);
 *    licence MIT for these files.
 *  - [SG] stargate-protocol/stargate-v2 commit
 *    9f4f5c0fc3e1df570415e441523c82fd94173588: packages/stg-evm-v2/src/
 *    StargateBase.sol (sendToken 248-282, _isTaxiMode 644-646: empty
 *    oftCmd = taxi, otherwise bus; approvalRequired always true 513-515;
 *    receiveTokenTaxi 345-375 caches an undelivered transfer;
 *    retryReceiveToken 295-313 lets anyone deliver it later),
 *    StargatePoolNative.sol (msg.value must be at least the native fee
 *    plus the amount, 57-66; delivery with a 2,300-gas stipend, 37-39);
 *    licence BUSL-1.1.
 *  - [D] LayerZero's deployment metadata
 *    https://metadata.layerzero-api.com/v1/metadata/deployments (fetched
 *    2026-10-15 UTC; the data behind docs.layerzero.network/v2/
 *    deployments/chains/*) and Stargate's
 *    https://testnet.stargate-api.com/v1/metadata?version=v2 (same day).
 *  - [C] Every address and configuration value below was then read
 *    on-chain on 2026-10-15 UTC through the keyless PublicNode endpoints
 *    (Ethereum Sepolia block 11,917,458; Base Sepolia 48,131,585; Arbitrum
 *    Sepolia 319,280,105; OP Sepolia 50,114,465): EndpointV2.eid(),
 *    defaultSendLibrary / defaultReceiveLibrary, SendUln302.getUlnConfig
 *    and getExecutorConfig, and for the Stargate pools token(),
 *    sharedDecimals(), paths(eid) credit, quoteOFT and quoteSend.
 *
 * What the skeleton refuses rather than guesses:
 *  - any OFT not described by an OftDeployment carrying on-chain-read
 *    security facts for the pathway (no default DVN set is assumed);
 *  - non-empty extraOptions or composeMsg (they make the calldata layout
 *    caller-dependent, so a CallPolicy could not pin it, and composeMsg
 *    triggers destination code), and any oftCmd other than empty (taxi) or
 *    the single byte 0x00 (Stargate bus);
 *  - an amount with "dust" below the shared-decimals precision (the OFT
 *    would silently send less);
 *  - paying the fee in the LayerZero token (lzTokenFee must be 0);
 *  - a fee or amount the injected chain reader did not return.
 */

/** LayerZero V2 on the four test networks [D][C]. The endpoint has the same address on all four. */
export const LAYERZERO_V2_TESTNET: Readonly<
  Record<number, { eid: number; endpoint: string; sendUln302: string; receiveUln302: string; executor: string; labsDvn: string }>
> = Object.freeze({
  11155111: {
    eid: 40161,
    endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    sendUln302: '0xcc1ae8Cf5D3904Cef3360A9532B477529b177cCE',
    receiveUln302: '0xdAf00F5eE2158dD58E0d3857851c432E34A3A851',
    executor: '0x718B92b5CB0a5552039B593faF724D182A881eDA',
    labsDvn: '0x8eebf8b423B73bFCa51a1Db4B7354AA0bFCA9193',
  },
  84532: {
    eid: 40245,
    endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    sendUln302: '0xC1868e054425D378095A003EcbA3823a5D0135C9',
    receiveUln302: '0x12523de19dc41c91F7d2093E0CFbB76b17012C8d',
    executor: '0x8A3D588D9f6AC041476b094f97FF94ec30169d3D',
    labsDvn: '0xe1a12515F9AB2764b887bF60B923Ca494EBbB2d6',
  },
  421614: {
    eid: 40231,
    endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    sendUln302: '0x4f7cd4DA19ABB31b0eC98b9066B9e857B1bf9C0E',
    receiveUln302: '0x75Db67CDab2824970131D5aa9CECfC9F69c69636',
    executor: '0x5Df3a1cEbBD9c8BA7F8dF51Fd632A9aef8308897',
    labsDvn: '0x53f488E93b4f1b60E8E83aa374dBe1780A1EE8a8',
  },
  11155420: {
    eid: 40232,
    endpoint: '0x6EDCE65403992e310A62460808c4b910D972f10f',
    sendUln302: '0xB31D2cb502E25B30C651842C7C3293c51Fe6d16f',
    receiveUln302: '0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca',
    executor: '0xDc0D68899405673b932F0DB7f8A49191491A5bcB',
    labsDvn: '0xd680ec569f269aa7015F7979b4f1239b5aa4582C',
  },
});

export function layerZeroEidFor(chainId: number): number {
  const entry = LAYERZERO_V2_TESTNET[chainId];
  if (!entry) throw new Error(`Chain ${chainId} has no verified LayerZero V2 endpoint in this wallet.`);
  return entry.eid;
}

export function chainIdForLayerZeroEid(eid: number): number | undefined {
  for (const [chainId, entry] of Object.entries(LAYERZERO_V2_TESTNET)) if (entry.eid === eid) return Number(chainId);
  return undefined;
}

export const OFT_SEND_SIGNATURE =
  'send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)';
export const OFT_QUOTE_SEND_SIGNATURE = 'quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool)';
export const OFT_QUOTE_OFT_SIGNATURE = 'quoteOFT((uint32,bytes32,uint256,uint256,bytes,bytes,bytes))';
/** keccak256(signature)[0:4]; recomputed against ethers in the tests. */
export const OFT_SEND_SELECTOR = '0xc7c7f5b3';
export const OFT_QUOTE_SEND_SELECTOR = '0x3b6f743b';
export const OFT_QUOTE_OFT_SELECTOR = '0x0d35b415';

/**
 * Event signatures, as declared in the pinned sources: OFTSent and
 * OFTReceived in [S] IOFT.sol lines 59-71 (guid and the address indexed;
 * the rest in data), PacketSent in [S] ILayerZeroEndpointV2.sol line 36
 * (nothing indexed), and
 * UnreceivedTokenCached in [SG] StargateBase.sol lines 95-102 (nothing
 * indexed). Topics are keccak256 of the signature, computed here and
 * pinned against ethers and the prefixes in docs/BRIDGING.md section 15.1
 * in the tests.
 */
export const OFT_SENT_EVENT_SIGNATURE = 'OFTSent(bytes32,uint32,address,uint256,uint256)';
export const OFT_RECEIVED_EVENT_SIGNATURE = 'OFTReceived(bytes32,uint32,address,uint256)';
export const PACKET_SENT_EVENT_SIGNATURE = 'PacketSent(bytes,bytes,address)';
export const UNRECEIVED_TOKEN_CACHED_EVENT_SIGNATURE = 'UnreceivedTokenCached(bytes32,uint8,uint32,address,uint256,bytes)';

function eventTopic(signature: string): string {
  return toHex(keccak(utf8ToBytes(signature)));
}

export const OFT_SENT_TOPIC = eventTopic(OFT_SENT_EVENT_SIGNATURE);
export const OFT_RECEIVED_TOPIC = eventTopic(OFT_RECEIVED_EVENT_SIGNATURE);
export const PACKET_SENT_TOPIC = eventTopic(PACKET_SENT_EVENT_SIGNATURE);
export const UNRECEIVED_TOKEN_CACHED_TOPIC = eventTopic(UNRECEIVED_TOKEN_CACHED_EVENT_SIGNATURE);

/**
 * Stargate's permissionless delivery of a cached transfer, [SG]
 * StargateBase.sol lines 295-313: retryReceiveToken(bytes32 _guid, uint8
 * _index, uint32 _srcEid, address _receiver, uint256 _amountLD, bytes
 * _composeMsg), external and nonReentrantAndNotPaused (no caller
 * restriction). It recomputes keccak256(abi.encodePacked(_srcEid,
 * _receiver, _amountLD, _composeMsg)), refuses with
 * Stargate_UnreceivedTokenNotFound unless that equals the hash stored by
 * receiveTokenTaxi / receiveTokenBus for (_guid, _index), deletes it, and
 * sends the amount with unlimited gas (_safeOutflow, StargatePoolNative.sol
 * lines 47-50). Selector recorded in docs/BRIDGING.md section 15.1.
 */
export const STARGATE_RETRY_RECEIVE_TOKEN_SIGNATURE = 'retryReceiveToken(bytes32,uint8,uint32,address,uint256,bytes)';
export const STARGATE_RETRY_RECEIVE_TOKEN_SELECTOR = '0xa88835d7';

/** The SendParam struct of IOFT.sol [S], restricted to what the wallet builds. */
export interface OftSendParam {
  dstEid: number;
  /** Recipient on the destination (an EVM address; carried as bytes32). */
  to: string;
  amountLD: bigint;
  minAmountLD: bigint;
  /** Always empty in this wallet (enforced options or the OApp's defaults apply). */
  extraOptions: '0x';
  /** Always empty in this wallet: a compose message runs code on the destination. */
  composeMsg: '0x';
  /** Empty = taxi (every OFT). '0x00' = Stargate bus mode (Stargate pools only). */
  oftCmd: '0x' | '0x00';
}

export interface OftMessagingFee {
  nativeFee: bigint;
  lzTokenFee: bigint;
}

const KNOWN_EIDS = new Set(Object.values(LAYERZERO_V2_TESTNET).map((e) => e.eid));

export function assertOftSendParam(p: OftSendParam): void {
  if (!Number.isInteger(p.dstEid) || !KNOWN_EIDS.has(p.dstEid)) {
    throw new Error(`LayerZero endpoint id ${p.dstEid} is not one this wallet has verified.`);
  }
  if (isZeroAddress(checksumAddress(p.to, 'recipient'))) throw new Error('The recipient must not be the zero address.');
  assertUint(p.amountLD, 256, 'amount');
  assertUint(p.minAmountLD, 256, 'minimum amount');
  if (p.amountLD === 0n) throw new Error('The amount to bridge must be more than zero.');
  if (p.minAmountLD > p.amountLD) throw new Error('The minimum to receive cannot be more than the amount sent.');
  if (p.extraOptions !== '0x') throw new Error('The wallet does not build OFT sends with extra options: they cannot be pinned.');
  if (p.composeMsg !== '0x') throw new Error('The wallet does not build OFT sends with a compose message: it runs code on the destination.');
  if (p.oftCmd !== '0x' && p.oftCmd !== '0x00') {
    throw new Error('The only OFT commands the wallet builds are empty (taxi) and 0x00 (Stargate bus).');
  }
}

function sendParamValue(p: OftSendParam): AbiValue {
  return {
    kind: 'tuple',
    items: [
      { kind: 'uint256', value: BigInt(p.dstEid) },
      { kind: 'fixedBytes', value: toBytes(addressToBytes32(p.to)) },
      { kind: 'uint256', value: p.amountLD },
      { kind: 'uint256', value: p.minAmountLD },
      { kind: 'bytes', value: toBytes(p.extraOptions) },
      { kind: 'bytes', value: toBytes(p.composeMsg) },
      { kind: 'bytes', value: toBytes(p.oftCmd) },
    ],
  };
}

/** Calldata for IOFT.send(SendParam, MessagingFee, refundAddress). */
export function encodeOftSend(p: OftSendParam, fee: OftMessagingFee, refundAddress: string): Uint8Array {
  assertOftSendParam(p);
  assertUint(fee.nativeFee, 256, 'native fee');
  if (fee.lzTokenFee !== 0n) throw new Error('The wallet pays LayerZero fees in the native coin only; lzTokenFee must be 0.');
  const refund = checksumAddress(refundAddress, 'refund address');
  if (isZeroAddress(refund)) throw new Error('The refund address must not be the zero address.');
  return encodeFunctionCall(OFT_SEND_SIGNATURE, [
    sendParamValue(p),
    { kind: 'tuple', items: [{ kind: 'uint256', value: fee.nativeFee }, { kind: 'uint256', value: 0n }] },
    { kind: 'address', value: refund },
  ]);
}

/** Calldata for IOFT.quoteSend(SendParam, payInLzToken = false). */
export function encodeOftQuoteSend(p: OftSendParam): Uint8Array {
  assertOftSendParam(p);
  return encodeFunctionCall(OFT_QUOTE_SEND_SIGNATURE, [sendParamValue(p), { kind: 'uint256', value: 0n }]);
}

/** Calldata for IOFT.quoteOFT(SendParam). */
export function encodeOftQuoteOft(p: OftSendParam): Uint8Array {
  assertOftSendParam(p);
  return encodeFunctionCall(OFT_QUOTE_OFT_SIGNATURE, [sendParamValue(p)]);
}

function hexWords(result: string, what: string): bigint[] {
  if (typeof result !== 'string' || !/^0x([0-9a-fA-F]{64})*$/.test(result)) {
    throw new Error(`The ${what} answer is not a whole number of 32-byte words.`);
  }
  const words: bigint[] = [];
  for (let i = 2; i < result.length; i += 64) words.push(BigInt('0x' + result.slice(i, i + 64)));
  return words;
}

/** Decodes quoteSend's MessagingFee {nativeFee, lzTokenFee}; refuses any answer that is not exactly two words. */
export function decodeOftMessagingFee(result: string): OftMessagingFee {
  const words = hexWords(result, 'quoteSend');
  if (words.length !== 2) throw new Error('The quoteSend answer must be exactly two words.');
  return { nativeFee: words[0]!, lzTokenFee: words[1]! };
}

export interface OftQuoteOftHead {
  minAmountLD: bigint;
  maxAmountLD: bigint;
  amountSentLD: bigint;
  amountReceivedLD: bigint;
}

/**
 * Decodes the static parts of quoteOFT's answer (OFTLimit, then an offset to
 * the OFTFeeDetail[] array, then OFTReceipt). The fee-detail strings are
 * not decoded; the array's offset is checked to point past the head.
 */
export function decodeOftQuoteOftHead(result: string): OftQuoteOftHead {
  const words = hexWords(result, 'quoteOFT');
  if (words.length < 6) throw new Error('The quoteOFT answer is too short.');
  const offset = words[2]!;
  if (offset < 160n || offset % 32n !== 0n || offset / 32n >= BigInt(words.length)) {
    throw new Error('The quoteOFT answer has a malformed fee-detail offset.');
  }
  return { minAmountLD: words[0]!, maxAmountLD: words[1]!, amountSentLD: words[3]!, amountReceivedLD: words[4]! };
}

/** A 32-byte hex value, lower-cased; refuses anything else. */
function bytes32Hex(value: string, what: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`The ${what} must be 32 bytes of hex.`);
  return value.toLowerCase();
}

/** An address carried in a 32-byte word (a topic or an ABI word); refuses non-zero high bytes. */
function wordAddress(word: bigint, what: string): string {
  if (word >= 1n << 160n) throw new Error(`The ${what} is not an address: its high 12 bytes are not zero.`);
  return checksumAddress('0x' + word.toString(16).padStart(40, '0'), what);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function topicIs(log: BridgeLog, topic: string): boolean {
  return typeof log.topics[0] === 'string' && log.topics[0].toLowerCase() === topic;
}

/** OFTSent as decoded from one log [S]. */
export interface OftSentEvent {
  emitter: string;
  guid: string;
  dstEid: number;
  fromAddress: string;
  amountSentLD: bigint;
  amountReceivedLD: bigint;
}

export function decodeOftSentLog(log: BridgeLog): OftSentEvent {
  if (!topicIs(log, OFT_SENT_TOPIC) || log.topics.length !== 3) throw new Error('This log is not an OFTSent event.');
  const words = hexWords(log.data, 'OFTSent data');
  if (words.length !== 3) throw new Error('OFTSent data must be exactly three words.');
  if (words[0]! >= 1n << 32n) throw new Error('OFTSent carries a destination endpoint id that is not a uint32.');
  return {
    emitter: checksumAddress(log.address, 'OFTSent emitter'),
    guid: bytes32Hex(log.topics[1]!, 'OFTSent GUID'),
    dstEid: Number(words[0]!),
    fromAddress: wordAddress(BigInt(bytes32Hex(log.topics[2]!, 'OFTSent sender')), 'OFTSent sender'),
    amountSentLD: words[1]!,
    amountReceivedLD: words[2]!,
  };
}

/** OFTReceived as decoded from one log [S]. */
export interface OftReceivedEvent {
  emitter: string;
  guid: string;
  srcEid: number;
  toAddress: string;
  amountReceivedLD: bigint;
}

export function decodeOftReceivedLog(log: BridgeLog): OftReceivedEvent {
  if (!topicIs(log, OFT_RECEIVED_TOPIC) || log.topics.length !== 3) throw new Error('This log is not an OFTReceived event.');
  const words = hexWords(log.data, 'OFTReceived data');
  if (words.length !== 2) throw new Error('OFTReceived data must be exactly two words.');
  if (words[0]! >= 1n << 32n) throw new Error('OFTReceived carries a source endpoint id that is not a uint32.');
  return {
    emitter: checksumAddress(log.address, 'OFTReceived emitter'),
    guid: bytes32Hex(log.topics[1]!, 'OFTReceived GUID'),
    srcEid: Number(words[0]!),
    toAddress: wordAddress(BigInt(bytes32Hex(log.topics[2]!, 'OFTReceived recipient')), 'OFTReceived recipient'),
    amountReceivedLD: words[1]!,
  };
}

/** Stargate's UnreceivedTokenCached as decoded from one log [SG]. Every field is in data. */
export interface UnreceivedTokenCachedEvent {
  emitter: string;
  guid: string;
  index: number;
  srcEid: number;
  receiver: string;
  amountLD: bigint;
  /** 0x-hex; empty ('0x') for every transfer this wallet sends. */
  composeMsg: string;
}

export function decodeUnreceivedTokenCachedLog(log: BridgeLog): UnreceivedTokenCachedEvent {
  if (!topicIs(log, UNRECEIVED_TOKEN_CACHED_TOPIC) || log.topics.length !== 1) {
    throw new Error('This log is not an UnreceivedTokenCached event.');
  }
  const words = hexWords(log.data, 'UnreceivedTokenCached data');
  if (words.length < 7) throw new Error('UnreceivedTokenCached data is too short.');
  if (words[1]! >= 256n) throw new Error('UnreceivedTokenCached carries an index that is not a uint8.');
  if (words[2]! >= 1n << 32n) throw new Error('UnreceivedTokenCached carries a source endpoint id that is not a uint32.');
  if (words[5]! !== 192n) throw new Error('UnreceivedTokenCached has a compose-message offset other than the canonical 0xc0.');
  const length = words[6]!;
  if (length > 1n << 20n || words.length !== 7 + Math.ceil(Number(length) / 32)) {
    throw new Error('UnreceivedTokenCached has a compose message whose length does not match its data.');
  }
  const body = log.data.slice(2 + 7 * 64);
  return {
    emitter: checksumAddress(log.address, 'UnreceivedTokenCached emitter'),
    guid: '0x' + log.data.slice(2, 66).toLowerCase(),
    index: Number(words[1]!),
    srcEid: Number(words[2]!),
    receiver: wordAddress(words[3]!, 'UnreceivedTokenCached receiver'),
    amountLD: words[4]!,
    composeMsg: '0x' + body.slice(0, Number(length) * 2).toLowerCase(),
  };
}

/** PacketSent as decoded from one endpoint log, with the packet header read per PacketV1Codec [S]. */
export interface PacketSentEvent {
  emitter: string;
  nonce: bigint;
  srcEid: number;
  /** The sending OApp (bytes32 in the packet, read as an address). */
  sender: string;
  dstEid: number;
  /** The receiving OApp (bytes32 in the packet, read as an address). */
  receiver: string;
  guid: string;
  /** The executor and DVN options the packet carried, 0x-hex. */
  options: string;
  sendLibrary: string;
}

function abiBytesAt(data: string, words: bigint[], offset: bigint, what: string): string {
  if (offset % 32n !== 0n || offset / 32n >= BigInt(words.length)) throw new Error(`PacketSent has a malformed ${what} offset.`);
  const length = words[Number(offset / 32n)]!;
  const start = 2 + Number(offset) * 2 + 64;
  if (length > 1n << 20n || start + Number(length) * 2 > data.length) throw new Error(`PacketSent has a ${what} longer than its data.`);
  return '0x' + data.slice(start, start + Number(length) * 2).toLowerCase();
}

/**
 * Decodes PacketSent(bytes encodedPayload, bytes options, address
 * sendLibrary). The encoded packet is read with PacketV1Codec's offsets
 * ([S] messagelib/libs/PacketV1Codec.sol lines 16-26):
 * version (1 byte, must be 1), nonce (8), srcEid (4), sender (32), dstEid
 * (4), receiver (32), then the GUID (32) at byte 81 and the message.
 */
export function decodePacketSentLog(log: BridgeLog): PacketSentEvent {
  if (!topicIs(log, PACKET_SENT_TOPIC) || log.topics.length !== 1) throw new Error('This log is not a PacketSent event.');
  const words = hexWords(log.data, 'PacketSent data');
  if (words.length < 5) throw new Error('PacketSent data is too short.');
  const packet = abiBytesAt(log.data, words, words[0]!, 'packet');
  const options = abiBytesAt(log.data, words, words[1]!, 'options');
  const sendLibrary = wordAddress(words[2]!, 'PacketSent send library');
  const p = packet.slice(2);
  if (p.length < 113 * 2) throw new Error('The LayerZero packet is shorter than its 113-byte header.');
  if (p.slice(0, 2) !== '01') throw new Error('The LayerZero packet is not version 1.');
  const hexAt = (start: number, end: number) => '0x' + p.slice(start * 2, end * 2);
  return {
    emitter: checksumAddress(log.address, 'PacketSent emitter'),
    nonce: BigInt(hexAt(1, 9)),
    srcEid: Number(BigInt(hexAt(9, 13))),
    sender: wordAddress(BigInt(hexAt(13, 45)), 'packet sender'),
    dstEid: Number(BigInt(hexAt(45, 49))),
    receiver: wordAddress(BigInt(hexAt(49, 81)), 'packet receiver'),
    guid: hexAt(81, 113),
    options,
    sendLibrary,
  };
}

/** The one LayerZero send a source transaction carried for a route. */
export interface LayerZeroSendInReceipt {
  guid: string;
  fromAddress: string;
  amountSentLD: bigint;
  amountReceivedLD: bigint;
  /** The options the packet carried (for Stargate's pools, its own executor option). */
  options: string;
  nonce: bigint;
}

/**
 * Finds the OFT send of one route in a source receipt's logs: an OFTSent
 * from `oft` towards `dstEid`, and a PacketSent from `endpoint` whose packet
 * goes from `sourceOApp` (srcEid) to `destinationOApp` (dstEid) with the
 * same GUID. Logs from other contracts, and malformed logs, are ignored.
 * Returns null unless exactly one such pair exists (a transaction with two
 * matching sends is ambiguous, and the wallet does not guess which).
 */
export function findLayerZeroSend(
  logs: readonly BridgeLog[],
  expect: { oft: string; endpoint: string; srcEid: number; dstEid: number; sourceOApp: string; destinationOApp: string },
): LayerZeroSendInReceipt | null {
  const sent: OftSentEvent[] = [];
  const packets: PacketSentEvent[] = [];
  for (const log of logs) {
    try {
      if (topicIs(log, OFT_SENT_TOPIC) && sameAddress(log.address, expect.oft)) {
        const e = decodeOftSentLog(log);
        if (e.dstEid === expect.dstEid) sent.push(e);
      } else if (topicIs(log, PACKET_SENT_TOPIC) && sameAddress(log.address, expect.endpoint)) {
        const e = decodePacketSentLog(log);
        if (
          e.srcEid === expect.srcEid &&
          e.dstEid === expect.dstEid &&
          sameAddress(e.sender, expect.sourceOApp) &&
          sameAddress(e.receiver, expect.destinationOApp)
        ) {
          packets.push(e);
        }
      }
    } catch {
      // A log that does not decode is not the send being looked for.
    }
  }
  const pairs = sent.flatMap((e) => packets.filter((p) => p.guid === e.guid).map((p) => ({ e, p })));
  if (pairs.length !== 1) return null;
  const { e, p } = pairs[0]!;
  return {
    guid: e.guid,
    fromAddress: e.fromAddress,
    amountSentLD: e.amountSentLD,
    amountReceivedLD: e.amountReceivedLD,
    options: p.options,
    nonce: p.nonce,
  };
}

/**
 * Calldata for Stargate's retryReceiveToken, built from a decoded
 * UnreceivedTokenCached event. Refuses an event with a compose message: the
 * wallet never sends one, and a retry would hand it to the endpoint to run
 * code on the receiving network.
 */
export function encodeStargateRetryReceiveToken(cached: UnreceivedTokenCachedEvent): Uint8Array {
  if (cached.composeMsg !== '0x') {
    throw new Error('This cached transfer carries a compose message; the wallet does not build a retry that would run it.');
  }
  const receiver = checksumAddress(cached.receiver, 'receiver');
  if (isZeroAddress(receiver)) throw new Error('The cached transfer has no receiver.');
  if (!Number.isInteger(cached.index) || cached.index < 0 || cached.index > 255) throw new Error('The cached index must be a uint8.');
  if (!Number.isInteger(cached.srcEid) || cached.srcEid < 0 || cached.srcEid >= 2 ** 32) throw new Error('The source endpoint id must be a uint32.');
  assertUint(cached.amountLD, 256, 'cached amount');
  return encodeFunctionCall(STARGATE_RETRY_RECEIVE_TOKEN_SIGNATURE, [
    { kind: 'fixedBytes', value: toBytes(bytes32Hex(cached.guid, 'GUID')) },
    { kind: 'uint256', value: BigInt(cached.index) },
    { kind: 'uint256', value: BigInt(cached.srcEid) },
    { kind: 'address', value: receiver },
    { kind: 'uint256', value: cached.amountLD },
    { kind: 'bytes', value: new Uint8Array() },
  ]);
}

/**
 * Byte offsets (after the selector) of every word of an OFT send in the
 * canonical encoding this module produces (verified against ethers in the
 * tests). The SendParam tuple is dynamic, so the head holds a pointer to it
 * (always 0x80 here) and each of its three bytes fields is located by an
 * offset relative to the tuple start. A CallPolicy can pin all of them
 * only because the wallet always writes those bytes fields empty (or, for
 * the Stargate bus, exactly one zero byte): then every pointer and length
 * has one possible value and the policy can require it.
 */
export const OFT_SEND_LAYOUT = Object.freeze({
  sendParamPointer: 0,
  nativeFee: 32,
  lzTokenFee: 64,
  refundAddress: 96,
  dstEid: 128,
  to: 160,
  amountLD: 192,
  minAmountLD: 224,
  extraOptionsPointer: 256,
  composeMsgPointer: 288,
  oftCmdPointer: 320,
  extraOptionsLength: 352,
  composeMsgLength: 384,
  oftCmdLength: 416,
  /** Present only for the bus command (one byte, left-aligned in a word). */
  oftCmdData: 448,
});

/**
 * The CallPolicy pins for one OFT send, every word equal to the quoted
 * value. For a standing session rule, `nativeFee` and the call's
 * valueLimit can only be capped (the fee changes with every quote), and
 * `amountLD` may be loosened to a cap; everything else stays equal.
 */
export function oftSendPins(p: OftSendParam, fee: OftMessagingFee, refundAddress: string): BridgePin[] {
  encodeOftSend(p, fee, refundAddress); // validates
  const L = OFT_SEND_LAYOUT;
  const pins: BridgePin[] = [
    equalPin('pointer to SendParam (canonical 0x80)', L.sendParamPointer, 0x80n),
    equalPin('MessagingFee.nativeFee', L.nativeFee, fee.nativeFee),
    equalPin('MessagingFee.lzTokenFee (always 0)', L.lzTokenFee, 0n),
    equalPin('refundAddress', L.refundAddress, refundAddress),
    equalPin('SendParam.dstEid', L.dstEid, BigInt(p.dstEid)),
    equalPin('SendParam.to', L.to, p.to),
    equalPin('SendParam.amountLD', L.amountLD, p.amountLD),
    equalPin('SendParam.minAmountLD', L.minAmountLD, p.minAmountLD),
    equalPin('SendParam.extraOptions offset (0xe0)', L.extraOptionsPointer, 0xe0n),
    equalPin('SendParam.composeMsg offset (0x100)', L.composeMsgPointer, 0x100n),
    equalPin('SendParam.oftCmd offset (0x120)', L.oftCmdPointer, 0x120n),
    equalPin('SendParam.extraOptions length (0)', L.extraOptionsLength, 0n),
    equalPin('SendParam.composeMsg length (0)', L.composeMsgLength, 0n),
    equalPin('SendParam.oftCmd length', L.oftCmdLength, p.oftCmd === '0x00' ? 1n : 0n),
  ];
  if (p.oftCmd === '0x00') pins.push(equalPin('SendParam.oftCmd data (0x00, bus)', L.oftCmdData, 0n));
  return pins;
}

/** A session-rule variant: the fee capped instead of fixed (see oftSendPins). */
export function oftSendStandingPins(p: OftSendParam, maxNativeFee: bigint, refundAddress: string): BridgePin[] {
  return oftSendPins(p, { nativeFee: maxNativeFee, lzTokenFee: 0n }, refundAddress).map((pin) =>
    pin.rule.offset === OFT_SEND_LAYOUT.nativeFee ? capPin('MessagingFee.nativeFee (at most)', OFT_SEND_LAYOUT.nativeFee, maxNativeFee) : pin,
  );
}

/** On-chain-read security facts for one send pathway of one OFT. */
export interface OftPathwaySecurity {
  /** Required DVNs as configured on the source send library for this pathway. */
  requiredDvns: { address: string; operator: string }[];
  optionalDvns: { address: string; operator: string }[];
  optionalThreshold: number;
  /** Source block confirmations the DVNs wait for. */
  confirmations: number;
  executor: { address: string; operator: string };
  /** True when the OApp has set nothing itself and the endpoint owner's defaults apply. */
  usesDefaults: boolean;
  /** Where and when this was read, e.g. "ethereum-sepolia-rpc.publicnode.com block 11917458, 2026-10-15". */
  readAt: string;
}

export interface OftDeployment {
  chainId: number;
  /** The contract the user calls (an OFT, an OFTAdapter or a Stargate pool). */
  address: string;
  kind: 'oft' | 'oft-adapter' | 'stargate-pool' | 'stargate-pool-native';
  /** Deployments with the same assetGroup form a mesh; routes exist only inside a group. */
  assetGroup: string;
  /** What leaves the user's account (native for 'stargate-pool-native'). */
  asset: BridgeAsset;
  sharedDecimals: number;
  /** The OApp registered with the endpoint (the OFT itself, or Stargate's TokenMessaging). */
  messagingOApp: string;
  /** Who can change the deployment, as read on-chain; shown in the quote notes. */
  controlNote: string;
  /** Security of each outbound pathway, keyed by destination chain id. A destination without an entry has no route. */
  pathways: Readonly<Record<number, OftPathwaySecurity>>;
  /**
   * Delivery times measured live from this deployment, if any: one summary
   * sentence for the whole asset group, and the seconds per destination
   * chain id that were measured. Shown with the quote's time estimate.
   */
  measuredDelivery?: { date: string; summary: string; seconds: Readonly<Record<number, number>> };
  /** Facts observed in live runs, added to every quote from this deployment as notes. */
  liveNotes?: readonly string[];
}

const READ_AT: Record<number, string> = {
  11155111: 'ethereum-sepolia-rpc.publicnode.com block 11917458, 2026-10-15 UTC',
  421614: 'arbitrum-sepolia-rpc.publicnode.com block 319280105, 2026-10-15 UTC',
  11155420: 'optimism-sepolia-rpc.publicnode.com block 50114465, 2026-10-15 UTC',
};

function labsPathway(source: number, confirmations: number): OftPathwaySecurity {
  const lz = LAYERZERO_V2_TESTNET[source]!;
  return {
    requiredDvns: [{ address: lz.labsDvn, operator: 'LayerZero Labs' }],
    optionalDvns: [],
    optionalThreshold: 0,
    confirmations,
    executor: { address: lz.executor, operator: 'LayerZero Labs' },
    usesDefaults: true,
    readAt: READ_AT[source]!,
  };
}

const STARGATE_TESTNET_CONTROL =
  "Stargate's test pools are owned by an address with no contract code (0x5e6e4f234c7Ad525700fcF5B7862589950589ed5), and their 'planner' role, which can pause transfers, is 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, the first account of Hardhat's published development mnemonic, whose private key is public.";

/**
 * From the live run of 2026-10-15 (docs/BRIDGING.md section 15.16): one
 * 0.0002 ETH taxi transfer per route, timed from the sending block to the
 * delivery block. One measurement each; not a promise.
 */
const STARGATE_TESTNET_MEASURED_SUMMARY =
  'Measured once on the test networks on 2026-10-15: 90 s Sepolia → OP Sepolia, 30 s OP Sepolia → Arbitrum Sepolia (from the sending block to the delivery block, one 0.0002 ETH transfer each).';

function stargateTestnetMeasured(seconds: Record<number, number>) {
  return Object.freeze({ date: '2026-10-15', summary: STARGATE_TESTNET_MEASURED_SUMMARY, seconds: Object.freeze(seconds) });
}

/**
 * Observed on the native test pools (docs/BRIDGING.md section 15.16). The
 * packets of both live transfers carried the options 0x0003 01 0011 01
 * …0249f0: type 3, executor lzReceive gas 150,000, no value (LayerZero-v2
 * 9c741e7f OptionsBuilder.sol line 22, ExecutorOptions.sol lines 10-12 and
 * 85-86), although the wallet's extraOptions were empty, so the option is
 * Stargate's own. The pool fee was read from quoteOFT at 0.0001 ETH
 * (section 15.6) and 0.0002 ETH (section 15.16); Stargate's fee library was
 * not read.
 */
export const STARGATE_TESTNET_NATIVE_LIVE_NOTES: readonly string[] = Object.freeze([
  "Stargate attaches its own executor option to every message from these pools: an lzReceive gas limit of 150,000 (option type 3), seen in the packets of both live transfers on 2026-10-15. The wallet's own extraOptions stay empty.",
  "Stargate's pool fee, as the pools quoted it on 2026-10-15: exactly 10^12 wei (0.000001 ETH, one shared-decimal unit) at both 0.0001 and 0.0002 ETH on the routes that charge one, and none on Sepolia → OP Sepolia or OP Sepolia → Arbitrum Sepolia. That looks like a flat one-unit fee at these sizes, but Stargate's fee library was not read, so it is an observation, not a promise; the fee lines above are what the pool quoted just now.",
]);

/**
 * Stargate V2's native-ETH pools on the test networks [D][C][SG]. Base
 * Sepolia has no Stargate deployment (not in Stargate's testnet metadata;
 * the pools report zero credit towards eid 40245 and quoteSend reverts).
 * Each pathway uses LayerZero's default configuration (nothing set by the
 * OApp): one required DVN, LayerZero Labs, and LayerZero Labs' executor.
 */
export const STARGATE_V2_TESTNET_NATIVE_POOLS: readonly OftDeployment[] = Object.freeze([
  {
    chainId: 11155111,
    address: '0x9Cc7e185162Aa5D1425ee924D97a87A0a34A0706',
    kind: 'stargate-pool-native',
    assetGroup: 'stargate-v2-testnet-eth',
    asset: { kind: 'native', symbol: 'ETH', decimals: 18 },
    sharedDecimals: 6,
    messagingOApp: '0xfB112f7FC5725de9F630abB23E4916d6fd7526d3',
    controlNote: STARGATE_TESTNET_CONTROL,
    pathways: Object.freeze({ 421614: labsPathway(11155111, 2), 11155420: labsPathway(11155111, 2) }),
    measuredDelivery: stargateTestnetMeasured({ 11155420: 90 }),
    liveNotes: STARGATE_TESTNET_NATIVE_LIVE_NOTES,
  },
  {
    chainId: 421614,
    address: '0x6fddB6270F6c71f31B62AE0260cfa8E2e2d186E0',
    kind: 'stargate-pool-native',
    assetGroup: 'stargate-v2-testnet-eth',
    asset: { kind: 'native', symbol: 'ETH', decimals: 18 },
    sharedDecimals: 6,
    messagingOApp: '0x657C13E8668B4eD33e524E3F8BD8559667E3Eb9b',
    controlNote: STARGATE_TESTNET_CONTROL,
    pathways: Object.freeze({ 11155111: labsPathway(421614, 5), 11155420: labsPathway(421614, 5) }),
    measuredDelivery: stargateTestnetMeasured({}),
    liveNotes: STARGATE_TESTNET_NATIVE_LIVE_NOTES,
  },
  {
    chainId: 11155420,
    address: '0xa31dCc5C71E25146b598bADA33E303627D7fC97e',
    kind: 'stargate-pool-native',
    assetGroup: 'stargate-v2-testnet-eth',
    asset: { kind: 'native', symbol: 'ETH', decimals: 18 },
    sharedDecimals: 6,
    messagingOApp: '0xea461D9B1a3d1d45E2Aa3a358c3b8cB9bF2c7063',
    controlNote: STARGATE_TESTNET_CONTROL,
    pathways: Object.freeze({ 11155111: labsPathway(11155420, 1), 421614: labsPathway(11155420, 1) }),
    measuredDelivery: stargateTestnetMeasured({ 421614: 30 }),
    liveNotes: STARGATE_TESTNET_NATIVE_LIVE_NOTES,
  },
]);

export const LAYERZERO_OFT_TRUST: BridgeTrustStatement = {
  verification:
    "LayerZero carries the transfer, and it is verified only by the verifier networks (DVNs) that the token's owner configured for this route. If those verifiers sign a false message, tokens can be released on the other network without having been sent.",
  control:
    "The token's owner can change the verifiers, the executor and the peer contracts at any time, and its delegate can skip or destroy a message in flight. LayerZero's endpoint contract itself cannot be upgraded, but the endpoint owner sets the default verifiers that every token without its own configuration uses.",
  refundRule:
    'There is no automatic refund. Once verified, a message can be delivered on the receiving network by anyone, at any time. If the verifiers never confirm it, the tokens stay locked or burned on the sending network until the token owner acts.',
};

/** Reads one eth_call on a chain; supplied by the app (failover and freshness are the app's job). */
export type OftChainReader = (request: { chainId: number; to: string; data: string }) => Promise<string>;

/** Optional, supplied by the app: the status of the LayerZero message sent in a transaction. */
export type LayerZeroMessageStatusReader = (request: {
  sourceChainId: number;
  sourceTxHash: string;
}) => Promise<{ status: string; destinationTxHash?: string } | null>;

/**
 * Maps a LayerZero Scan message status (the enum in the keyless
 * https://scan-testnet.layerzero-api.com/v1 OpenAPI, fetched 2026-10-15) to
 * the wallet's transfer states. Unknown names map to 'unknown'.
 */
export function layerZeroScanState(status: string): BridgeTransferStatus['state'] {
  switch (status) {
    case 'INFLIGHT':
    case 'CONFIRMING':
      return 'in-flight';
    case 'DELIVERED':
      return 'delivered';
    case 'FAILED':
    case 'BLOCKED':
    case 'PAYLOAD_STORED':
      return 'awaiting-destination-action';
    case 'APPLICATION_BURNED':
    case 'APPLICATION_SKIPPED':
    case 'UNRESOLVABLE_COMMAND':
    case 'MALFORMED_COMMAND':
      return 'failed';
    default:
      return 'unknown';
  }
}

/** Optional, supplied by the app: eth_estimateGas for one call. */
export type OftGasEstimator = (request: { chainId: number; from: string; to: string; value: bigint; data: string }) => Promise<bigint>;

export interface LayerZeroOftProviderOptions {
  /** Every deployment the provider may route through; each must carry on-chain-read pathway facts. */
  deployments: readonly OftDeployment[];
  readContract: OftChainReader;
  /** LayerZero Scan (or another off-chain status). With the log readers below it is supporting evidence only. */
  fetchMessageStatus?: LayerZeroMessageStatusReader;
  /**
   * The source transaction's receipt, to read the GUID from OFTSent and
   * PacketSent. Give both log readers or neither; with them, track() decides
   * from the chains' own events.
   */
  readSourceReceipt?: BridgeReceiptLogReader;
  /** eth_getLogs on the receiving chain, to find OFTReceived or UnreceivedTokenCached for the GUID. */
  readDestinationLogs?: BridgeEventLogReader;
  /**
   * eth_getBlockByNumber (bridge/search.ts, pass p23-cctp-recheck). With it,
   * the receiving chain is searched from the block at the sending
   * transaction's time, to the head or a week later; a transfer whose
   * delivery is not found within that bound is reported as not found in the
   * span searched, never refused as too old. Without it the log reader
   * chooses the range, as before.
   */
  readBlock?: BridgeBlockReader;
  /** The receiving blocks found for a time, kept by the app between tracking passes so a later pass reads only the head. */
  searchCache?: BridgeSearchCache;
  /**
   * eth_estimateGas for the bridge call. When given, quotes carry
   * gasEstimate. In the live run of 2026-10-15 the estimate was 341,035 for
   * 313,407 gas used (Sepolia) and 266,841 for 257,755 (OP Sepolia), so it
   * is not a limit: the app adds its usual margin.
   */
  estimateGas?: OftGasEstimator;
  /** Use Stargate's bus (batched, cheaper, slower) instead of taxi. Stargate pools only. */
  stargateBus?: boolean;
  id?: string;
  label?: string;
}

export const LAYERZERO_OFT_PROVIDER_ID = 'layerzero-oft';

function assertDeployment(d: OftDeployment): void {
  if (!LAYERZERO_V2_TESTNET[d.chainId]) throw new Error(`Chain ${d.chainId} has no verified LayerZero V2 endpoint.`);
  checksumAddress(d.address, 'OFT address');
  checksumAddress(d.messagingOApp, 'messaging OApp');
  if (d.kind === 'stargate-pool-native' && d.asset.kind !== 'native') throw new Error('A native Stargate pool must move the native coin.');
  if (d.kind !== 'stargate-pool-native' && d.asset.kind !== 'erc20') throw new Error('An OFT that is not a native pool must move an ERC-20 token.');
  if (!Number.isInteger(d.sharedDecimals) || d.sharedDecimals < 0 || d.sharedDecimals > d.asset.decimals) {
    throw new Error(`The OFT at ${d.address} has shared decimals that do not fit its token.`);
  }
  for (const [dest, sec] of Object.entries(d.pathways)) {
    if (!LAYERZERO_V2_TESTNET[Number(dest)]) throw new Error(`The OFT at ${d.address} lists an unverified destination ${dest}.`);
    if (sec.requiredDvns.length === 0 && sec.optionalDvns.length === 0) {
      throw new Error(`The OFT at ${d.address} has no verifier recorded for chain ${dest}; the wallet will not assume one.`);
    }
    if (!sec.readAt) throw new Error(`The OFT at ${d.address} does not say where its pathway facts were read.`);
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The quote's time estimate: the live measurement where there is one, never presented as a promise. */
export function oftTimeEstimate(source: OftDeployment, destinationChainId: number, confirmations: number): BridgeTimeEstimate {
  const wait = `the verifiers wait for ${plural(confirmations, 'source-block confirmation', 'source-block confirmations')}, then the executor delivers`;
  const m = source.measuredDelivery;
  if (!m) {
    return { minSeconds: null, maxSeconds: null, source: `Not measured on the test networks. Not a promise: ${wait}.` };
  }
  const seconds = m.seconds[destinationChainId];
  const estimate: BridgeTimeEstimate = {
    minSeconds: null,
    maxSeconds: null,
    source: `${m.summary} ${seconds === undefined ? 'This route was not measured.' : `This route took ${seconds} s that once.`} Not a promise: ${wait}, and either can take longer.`,
  };
  if (seconds !== undefined) {
    estimate.measured = { seconds, date: m.date, description: `Measured once on ${m.date}, from the sending block to the delivery block.` };
  }
  return estimate;
}

/** The native coin's name for fee lines, as the caller's network profile gives it (default "ETH"). */
function nativeSymbolFor(symbol: string | undefined): string {
  if (symbol === undefined) return 'ETH';
  if (typeof symbol !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 .-]{0,19}$/.test(symbol)) {
    throw new Error('The native coin symbol must be 1 to 20 letters, digits, spaces, dots or hyphens.');
  }
  return symbol;
}

function describeVerifiers(sec: OftPathwaySecurity): string {
  const req = sec.requiredDvns.map((v) => v.operator).join(', ');
  const opt = sec.optionalDvns.length > 0 ? `; plus ${sec.optionalThreshold} of ${sec.optionalDvns.length} optional (${sec.optionalDvns.map((v) => v.operator).join(', ')})` : '';
  return `Verified by ${sec.requiredDvns.length} required verifier${sec.requiredDvns.length === 1 ? '' : 's'} (${req})${opt}, after ${sec.confirmations} block confirmation${sec.confirmations === 1 ? '' : 's'}; delivered by ${sec.executor.operator}'s executor${sec.usesDefaults ? '. These are LayerZero\'s defaults: the token owner has set none of its own' : ''} (read ${sec.readAt}).`;
}

export function createLayerZeroOftProvider(options: LayerZeroOftProviderOptions): BridgeProvider {
  if ((options.readSourceReceipt === undefined) !== (options.readDestinationLogs === undefined)) {
    throw new Error('Give the LayerZero provider both log readers (source receipt and destination logs) or neither.');
  }
  const deployments = options.deployments.map((d) => {
    assertDeployment(d);
    return d;
  });
  const id = options.id ?? LAYERZERO_OFT_PROVIDER_ID;
  const routes: (BridgeRoute & { source: OftDeployment; target: OftDeployment })[] = [];
  for (const source of deployments) {
    for (const destId of Object.keys(source.pathways).map(Number)) {
      const target = deployments.find((d) => d.chainId === destId && d.assetGroup === source.assetGroup);
      if (!target) continue;
      routes.push({
        providerId: id,
        sourceChainId: source.chainId,
        destinationChainId: destId,
        sourceAsset: source.asset,
        destinationAsset: target.asset,
        source,
        target,
      });
    }
  }
  const publicRoutes: BridgeRoute[] = Object.freeze(
    routes.map(({ providerId, sourceChainId, destinationChainId, sourceAsset, destinationAsset }) => ({
      providerId,
      sourceChainId,
      destinationChainId,
      sourceAsset,
      destinationAsset,
    })),
  ) as BridgeRoute[];

  function findRoute(route: BridgeRoute) {
    const found = routes.find(
      (r) =>
        r.sourceChainId === route.sourceChainId &&
        r.destinationChainId === route.destinationChainId &&
        sameAsset(r.sourceAsset, route.sourceAsset) &&
        sameAsset(r.destinationAsset, route.destinationAsset),
    );
    if (!found) throw new Error('No configured OFT serves this route in this wallet.');
    return found;
  }

  async function quote(request: BridgeQuoteRequest): Promise<BridgeQuote> {
    const r = findRoute(request.route);
    const sender = checksumAddress(request.sender, 'sender');
    const recipient = checksumAddress(request.recipient, 'recipient');
    if (isZeroAddress(sender)) throw new Error('The sender must not be the zero address.');
    const bus = options.stargateBus === true;
    if (bus && r.source.kind !== 'stargate-pool' && r.source.kind !== 'stargate-pool-native') {
      throw new Error('Bus mode exists only on Stargate pools.');
    }
    const rate = 10n ** BigInt(r.source.asset.decimals - r.source.sharedDecimals);
    if (request.amount % rate !== 0n) {
      throw new Error(
        `This token moves in steps of ${rate} base units; the amount has a remainder the OFT would not send. Round it first.`,
      );
    }
    const base: OftSendParam = {
      dstEid: layerZeroEidFor(r.destinationChainId),
      to: recipient,
      amountLD: request.amount,
      minAmountLD: 0n,
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: bus ? '0x00' : '0x',
    };
    assertOftSendParam(base);
    const head = decodeOftQuoteOftHead(
      await options.readContract({ chainId: r.sourceChainId, to: r.source.address, data: toHex(encodeOftQuoteOft(base)) }),
    );
    if (head.amountSentLD !== request.amount) {
      throw new Error('The OFT would take a different amount from the one entered; nothing was quoted.');
    }
    if (request.amount > head.maxAmountLD || request.amount < head.minAmountLD) {
      throw new Error(`The OFT accepts between ${head.minAmountLD} and ${head.maxAmountLD} base units on this route right now.`);
    }
    if (head.amountReceivedLD === 0n) throw new Error('Nothing would arrive on the receiving network; nothing was quoted.');
    const minOut = request.minAmountOut ?? head.amountReceivedLD;
    if (minOut > head.amountReceivedLD) {
      throw new Error('The amount that would arrive is below the minimum you asked for; nothing was quoted.');
    }
    const sendParam: OftSendParam = { ...base, minAmountLD: minOut };
    const fee = decodeOftMessagingFee(
      await options.readContract({ chainId: r.sourceChainId, to: r.source.address, data: toHex(encodeOftQuoteSend(sendParam)) }),
    );
    if (fee.lzTokenFee !== 0n) throw new Error('The OFT asked for a fee in the LayerZero token; the wallet pays in the native coin only.');
    if (fee.nativeFee === 0n) throw new Error('The OFT quoted no messaging fee, which no configured pathway should do; nothing was quoted.');
    const nativeSymbol = nativeSymbolFor(request.nativeSymbol);
    const native: BridgeAsset = { kind: 'native', symbol: nativeSymbol, decimals: 18 };
    const value = r.source.kind === 'stargate-pool-native' ? request.amount + fee.nativeFee : fee.nativeFee;
    const calls: BridgeCall[] = [];
    if (r.source.asset.kind === 'erc20' && r.source.kind !== 'oft') {
      // OFTAdapter and Stargate pools pull the token with transferFrom (approvalRequired() true);
      // a plain OFT burns from the sender and needs no approval [S].
      calls.push(
        exactApprovalCall(r.sourceChainId, r.source.asset.address, r.source.address, request.amount, 'Allow the bridge contract to take exactly this amount'),
      );
    }
    calls.push({
      purpose: 'bridge',
      chainId: r.sourceChainId,
      to: checksumAddress(r.source.address),
      value,
      data: encodeOftSend(sendParam, fee, sender),
      label: `Send through LayerZero (${r.source.kind.startsWith('stargate') ? 'Stargate' : 'OFT'})`,
      selector: OFT_SEND_SELECTOR,
      pins: oftSendPins(sendParam, fee, sender),
      unpinnable: [
        'The messaging fee changes with every quote, so a standing session rule can only cap it, not fix it.',
      ],
      valueLimit: value,
    });
    const fees: BridgeFeeLine[] = [
      {
        kind: 'messaging',
        description: `LayerZero messaging fee (verifiers, executor and destination gas), paid in ${nativeSymbol}; any excess is refunded to your address.`,
        amount: fee.nativeFee,
        asset: native,
        deductedFromAmount: false,
        chainId: r.sourceChainId,
      },
    ];
    if (head.amountReceivedLD < request.amount) {
      fees.push({
        kind: 'pool',
        description: 'Fee the token contract takes from the amount (Stargate calls it a protocol fee).',
        amount: request.amount - head.amountReceivedLD,
        asset: r.source.asset.kind === 'native' ? native : r.source.asset,
        deductedFromAmount: true,
        chainId: r.sourceChainId,
      });
    }
    const pathway = r.source.pathways[r.destinationChainId]!;
    const notes = [describeVerifiers(pathway), r.source.controlNote, ...(r.source.liveNotes ?? [])];
    if (head.amountReceivedLD > request.amount) {
      notes.push(`The pool adds a reward: ${head.amountReceivedLD - request.amount} base units more than sent should arrive.`);
    }
    if (r.target.kind === 'stargate-pool-native') {
      notes.push(
        "Stargate delivers ETH with a 2,300-gas transfer. A deployed smart account cannot accept that, so for one the ETH stays in Stargate's pool until someone calls retryReceiveToken on the receiving network (anyone may, paying gas there).",
      );
    }
    let gasEstimate: bigint | null = null;
    if (options.estimateGas) {
      const bridgeCall = calls[calls.length - 1]!;
      if (calls.length > 1) {
        notes.push('Gas for the send is not estimated here: the approval must be mined first, or the estimate fails.');
      } else {
        let estimated: unknown;
        try {
          estimated = await options.estimateGas({
            chainId: r.sourceChainId,
            from: sender,
            to: bridgeCall.to,
            value: bridgeCall.value,
            data: toHex(bridgeCall.data),
          });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          notes.push(`The network could not estimate the gas for this send (${reason.slice(0, 200)}); it may fail if sent as quoted.`);
        }
        if (estimated !== undefined) {
          if (typeof estimated !== 'bigint' || estimated <= 0n) throw new Error('The gas estimator returned something other than a positive amount of gas.');
          gasEstimate = estimated;
        }
      }
    }
    return {
      providerId: id,
      route: request.route,
      amountIn: request.amount,
      expectedAmountOut: head.amountReceivedLD,
      minAmountOut: minOut,
      fees,
      time: oftTimeEstimate(r.source, r.destinationChainId, pathway.confirmations),
      approvals: calls
        .filter((c) => c.purpose === 'approve')
        .map((c) => ({ chainId: r.sourceChainId, token: c.to, spender: r.source.address, amount: request.amount })),
      calls,
      destination: {
        kind: 'executor-delivers',
        description:
          "The executor delivers the message once the verifiers confirm it. Delivery is permissionless: if the executor does not, anyone can execute the verified message on the receiving network.",
      },
      refundRule: LAYERZERO_OFT_TRUST.refundRule,
      tracking: {
        description: "LayerZero Scan's keyless testnet API reports the message by source transaction; the destination's OFTReceived event confirms arrival.",
        needsHttpApi: true,
        needsApiKey: false,
      },
      notes,
      gasEstimate,
    };
  }

  async function track(transfer: BridgeTransfer): Promise<BridgeTransferStatus> {
    if (options.readSourceReceipt && options.readDestinationLogs) {
      return trackOnChain(transfer, options.readSourceReceipt, options.readDestinationLogs);
    }
    return trackByScan(transfer);
  }

  async function trackByScan(transfer: BridgeTransfer): Promise<BridgeTransferStatus> {
    findRoute(transfer.route);
    if (!/^0x[0-9a-fA-F]{64}$/.test(transfer.sourceTxHash)) throw new Error('The source transaction hash must be 32 bytes of hex.');
    if (!options.fetchMessageStatus) {
      return { state: 'unknown', detail: 'This build has no LayerZero message reader, so the transfer cannot be followed here.' };
    }
    const answer = await options.fetchMessageStatus({ sourceChainId: transfer.route.sourceChainId, sourceTxHash: transfer.sourceTxHash });
    if (!answer) return { state: 'unknown', detail: 'No LayerZero message was found for this transaction yet.' };
    const state = layerZeroScanState(answer.status);
    const detail =
      state === 'delivered'
        ? 'The message was delivered. For a Stargate ETH transfer to a smart account, check that the ETH arrived: it may be waiting for retryReceiveToken.'
        : state === 'awaiting-destination-action'
          ? `The message needs action on the receiving network (${answer.status}).`
          : state === 'failed'
            ? `The message will not be delivered (${answer.status}).`
            : state === 'in-flight'
              ? 'The message is on its way.'
              : `Unrecognised LayerZero status ${answer.status}.`;
    const status: BridgeTransferStatus = { state, detail };
    if (answer.destinationTxHash) status.destinationTxHash = answer.destinationTxHash;
    return status;
  }

  /**
   * Tracking from the chains' own events. The source receipt gives the
   * GUID (OFTSent and PacketSent must agree on it, on the route's endpoint
   * ids and OApps); the receiving chain's logs then decide: OFTReceived for
   * that GUID, to this recipient, from the source endpoint id and for the
   * amount OFTSent promised, means delivered; Stargate's
   * UnreceivedTokenCached for it means the funds wait in the pool for
   * retryReceiveToken. Scan's status is reported beside the result and
   * never overrides an event the chain shows.
   */
  async function trackOnChain(
    transfer: BridgeTransfer,
    readSourceReceipt: BridgeReceiptLogReader,
    readDestinationLogs: BridgeEventLogReader,
  ): Promise<BridgeTransferStatus> {
    const r = findRoute(transfer.route);
    const txHash = bytes32Hex(transfer.sourceTxHash, 'source transaction hash');
    const recipient = checksumAddress(transfer.recipient, 'recipient');
    let apiStatus: string | null = null;
    let apiNote = '';
    if (options.fetchMessageStatus) {
      try {
        const answer = await options.fetchMessageStatus({ sourceChainId: r.sourceChainId, sourceTxHash: transfer.sourceTxHash });
        apiStatus = answer?.status ?? null;
        apiNote = apiStatus === null ? ' LayerZero Scan has no record of the message yet.' : '';
      } catch {
        apiNote = ' LayerZero Scan could not be asked.';
      }
    }
    const result = (
      state: BridgeTransferStatus['state'],
      onChain: Omit<BridgeOnChainDelivery, 'apiStatus'>,
      detail: string,
      extra: Partial<BridgeTransferStatus> = {},
    ): BridgeTransferStatus => {
      let scanSentence = apiNote;
      if (apiStatus !== null) {
        const agrees =
          (onChain.status === 'delivered' && apiStatus === 'DELIVERED') ||
          (onChain.status === 'in-flight' && layerZeroScanState(apiStatus) === 'in-flight');
        scanSentence = agrees
          ? ` LayerZero Scan agrees (${apiStatus}).`
          : ` LayerZero Scan reports ${apiStatus}; the wallet goes by the chains' own events.`;
      }
      const status: BridgeTransferStatus = { state, detail: detail + scanSentence, onChain: { ...onChain, apiStatus }, ...extra };
      if (onChain.destinationTx) status.destinationTxHash = onChain.destinationTx;
      return status;
    };
    const none = { guid: null, destinationTx: null, amountReceived: null };

    if (options.stargateBus === true) {
      return result(
        'unknown',
        { status: 'unknown', ...none },
        "On-chain tracking follows taxi transfers only: a bus passenger travels inside the bus's later message, whose GUID this wallet does not read.",
      );
    }
    const receipt = await readSourceReceipt({ chainId: r.sourceChainId, txHash });
    if (!receipt) {
      return result('unknown', { status: 'unknown', ...none }, 'The sending transaction has no receipt yet; it may still be pending.');
    }
    if (receipt.status === 'reverted') {
      return result(
        'failed',
        { status: 'source-reverted', ...none },
        'The sending transaction reverted, so no message was sent and nothing was bridged; only its network fee was spent.',
      );
    }
    const source = LAYERZERO_V2_TESTNET[r.sourceChainId]!;
    const srcEid = source.eid;
    const dstEid = layerZeroEidFor(r.destinationChainId);
    const send = findLayerZeroSend(receipt.logs, {
      oft: r.source.address,
      endpoint: source.endpoint,
      srcEid,
      dstEid,
      sourceOApp: r.source.messagingOApp,
      destinationOApp: r.target.messagingOApp,
    });
    if (!send) {
      return result(
        'unknown',
        { status: 'unknown', ...none },
        'The sending transaction does not carry exactly one LayerZero send for this route (an OFTSent and a PacketSent with the same GUID), so it cannot be followed.',
      );
    }
    const guid = send.guid;
    if (send.amountSentLD !== transfer.amountIn) {
      return result(
        'unknown',
        { status: 'unknown', ...none, guid },
        `The LayerZero send in this transaction moved ${send.amountSentLD} base units, not the ${transfer.amountIn} this transfer records, so it is not followed as this transfer.`,
      );
    }
    const target = checksumAddress(r.target.address);
    // Where to search: from the receiving block at the sending
    // transaction's time, when a block reader was given and the sending
    // block is known (the receipt's, else a log's).
    let plan: (BridgeDestinationSearch & { reads: number }) | null = null;
    if (options.readBlock) {
      const fromLog = receipt.logs.map((l) => l.blockNumber).find((b): b is string => typeof b === 'string' && /^0x[0-9a-fA-F]+$/.test(b));
      const sourceBlock = typeof receipt.blockNumber === 'bigint' ? receipt.blockNumber : fromLog !== undefined ? BigInt(fromLog) : null;
      if (sourceBlock !== null) {
        const sent = await options.readBlock({ chainId: r.sourceChainId, block: sourceBlock });
        if (!sent || sent.number !== sourceBlock || typeof sent.timestamp !== 'bigint') throw new Error(`The node did not return the sending block ${sourceBlock}.`);
        plan = await planDestinationSearch(options.readBlock, { chainId: r.destinationChainId, sinceTimestamp: sent.timestamp, cache: options.searchCache });
      }
    }
    const search: BridgeDestinationSearch | undefined = plan
      ? { fromBlock: plan.fromBlock, toBlock: plan.toBlock, fromTimestamp: plan.fromTimestamp, toTimestamp: plan.toTimestamp, bounded: plan.bounded, boundSeconds: plan.boundSeconds, ...(plan.prunedBelow !== undefined ? { prunedBelow: plan.prunedBelow } : {}) }
      : undefined;
    const withSearch = search ? { search } : {};
    const receivedQuery = { chainId: r.destinationChainId, address: target, topics: [OFT_RECEIVED_TOPIC, guid] };
    const receivedLogs = plan
      ? await searchPlannedLogs(readDestinationLogs, plan, receivedQuery, (logs) => logs.some((l) => topicIs(l, OFT_RECEIVED_TOPIC)))
      : await readDestinationLogs(receivedQuery);
    let mismatched = false;
    for (const log of receivedLogs) {
      if (!sameAddress(log.address, target) || !topicIs(log, OFT_RECEIVED_TOPIC)) continue;
      let event: OftReceivedEvent;
      try {
        event = decodeOftReceivedLog(log);
      } catch {
        continue;
      }
      if (event.guid !== guid) continue;
      if (event.srcEid === srcEid && sameAddress(event.toAddress, recipient) && event.amountReceivedLD === send.amountReceivedLD) {
        const destinationTx = typeof log.transactionHash === 'string' ? log.transactionHash : null;
        return result(
          'delivered',
          { status: 'delivered', guid, destinationTx, amountReceived: event.amountReceivedLD, ...withSearch },
          `Delivered: the receiving network shows OFTReceived for this transfer's message (GUID ${guid}), ${event.amountReceivedLD} base units to ${recipient}${destinationTx ? ` in transaction ${destinationTx}` : ''}.`,
        );
      }
      mismatched = true;
    }
    if (mismatched) {
      return result(
        'unknown',
        { status: 'unknown', ...none, guid, ...withSearch },
        `The receiving network shows an OFTReceived event for GUID ${guid} that does not match this transfer (sender's endpoint, recipient or amount), so the wallet does not call it delivered.`,
      );
    }
    if (r.target.kind === 'stargate-pool' || r.target.kind === 'stargate-pool-native') {
      const cachedQuery = { chainId: r.destinationChainId, address: target, topics: [UNRECEIVED_TOKEN_CACHED_TOPIC] };
      const cachedForGuid = (logs: readonly BridgeLog[]): boolean =>
        logs.some((l) => {
          if (!topicIs(l, UNRECEIVED_TOKEN_CACHED_TOPIC)) return false;
          try {
            return decodeUnreceivedTokenCachedLog(l).guid === guid;
          } catch {
            return false;
          }
        });
      const cachedLogs = plan ? await searchPlannedLogs(readDestinationLogs, plan, cachedQuery, cachedForGuid) : await readDestinationLogs(cachedQuery);
      for (const log of cachedLogs) {
        if (!sameAddress(log.address, target) || !topicIs(log, UNRECEIVED_TOKEN_CACHED_TOPIC)) continue;
        let cached: UnreceivedTokenCachedEvent;
        try {
          cached = decodeUnreceivedTokenCachedLog(log);
        } catch {
          continue;
        }
        if (cached.guid !== guid) continue;
        const destinationTx = typeof log.transactionHash === 'string' ? log.transactionHash : null;
        const onChain = { status: 'cached-needs-retry' as const, guid, destinationTx, amountReceived: null, ...withSearch };
        if (cached.srcEid !== srcEid || !sameAddress(cached.receiver, recipient) || cached.amountLD !== send.amountReceivedLD) {
          return result(
            'unknown',
            { ...onChain, status: 'unknown' },
            `The receiving pool cached a transfer for GUID ${guid} that does not match this transfer (sender's endpoint, recipient or amount), so no retry call was built.`,
          );
        }
        const why =
          r.target.kind === 'stargate-pool-native'
            ? "Stargate could not hand over the ETH with its 2,300-gas transfer (a deployed smart account cannot accept one)"
            : 'Stargate could not hand over the tokens';
        const where = `the receiving network's pool ${target}`;
        if (cached.composeMsg !== '0x') {
          return result(
            'awaiting-destination-action',
            onChain,
            `The message arrived, but ${why}, so the funds wait in ${where} (UnreceivedTokenCached). The cached transfer carries a compose message, which this wallet never sends and will not replay, so no retry call was built.`,
          );
        }
        const retry: Call = { to: target, value: 0n, data: encodeStargateRetryReceiveToken(cached) };
        return result(
          'awaiting-destination-action',
          onChain,
          `The message arrived, but ${why}, so the funds wait in ${where} (UnreceivedTokenCached${destinationTx ? `, transaction ${destinationTx}` : ''}). Anyone can deliver them by calling retryReceiveToken there, paying the gas on that network; the call below does that. It fails while the pool is paused.`,
          { destinationCalls: [retry] },
        );
      }
    }
    if (search && search.bounded) {
      // The search reached its time bound before the head: say how far it
      // looked, and let Scan's status stand beside it as supporting
      // evidence only (pass p23-cctp-recheck).
      return result(
        'unknown',
        { status: 'unknown', ...none, guid, search },
        `The message was sent (GUID ${guid}), but no delivery for it was found in the ${searchSpanText(search.toTimestamp - search.fromTimestamp)} this wallet searched on the receiving network (${searchRangeText(search)}), which is as far as it searches after the sending transaction, so the wallet cannot tell whether it arrived later.`,
      );
    }
    if (apiStatus !== null && apiStatus !== 'DELIVERED' && layerZeroScanState(apiStatus) !== 'in-flight') {
      return result(
        'unknown',
        { status: 'in-flight', ...none, guid, ...withSearch },
        `The message was sent (GUID ${guid}) and the receiving network shows no delivery for it yet; with LayerZero Scan reporting that it is not on its way, the wallet cannot tell whether it will arrive.`,
      );
    }
    return result('in-flight', { status: 'in-flight', ...none, guid, ...withSearch }, `The message was sent (GUID ${guid}); the receiving network shows no delivery for it yet.`);
  }

  return {
    id,
    label: options.label ?? 'LayerZero OFT',
    trust: LAYERZERO_OFT_TRUST,
    supportedRoutes: () => publicRoutes,
    quote,
    track,
  };
}

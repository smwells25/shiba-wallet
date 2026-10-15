import { encodeFunctionCall, type AbiValue } from '../abi.js';
import { toBytes, toHex } from '../encoding.js';
import type {
  BridgeAsset,
  BridgeCall,
  BridgeFeeLine,
  BridgePin,
  BridgeProvider,
  BridgeQuote,
  BridgeQuoteRequest,
  BridgeRoute,
  BridgeTransfer,
  BridgeTransferStatus,
  BridgeTrustStatement,
} from './types.js';
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

export interface LayerZeroOftProviderOptions {
  /** Every deployment the provider may route through; each must carry on-chain-read pathway facts. */
  deployments: readonly OftDeployment[];
  readContract: OftChainReader;
  fetchMessageStatus?: LayerZeroMessageStatusReader;
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

function describeVerifiers(sec: OftPathwaySecurity): string {
  const req = sec.requiredDvns.map((v) => v.operator).join(', ');
  const opt = sec.optionalDvns.length > 0 ? `; plus ${sec.optionalThreshold} of ${sec.optionalDvns.length} optional (${sec.optionalDvns.map((v) => v.operator).join(', ')})` : '';
  return `Verified by ${sec.requiredDvns.length} required verifier${sec.requiredDvns.length === 1 ? '' : 's'} (${req})${opt}, after ${sec.confirmations} block confirmation${sec.confirmations === 1 ? '' : 's'}; delivered by ${sec.executor.operator}'s executor${sec.usesDefaults ? '. These are LayerZero\'s defaults: the token owner has set none of its own' : ''} (read ${sec.readAt}).`;
}

export function createLayerZeroOftProvider(options: LayerZeroOftProviderOptions): BridgeProvider {
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
    const native: BridgeAsset = { kind: 'native', symbol: 'ETH', decimals: 18 };
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
        description: 'LayerZero messaging fee (verifiers, executor and destination gas), paid in the native coin; any excess is refunded to your address.',
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
        asset: r.source.asset,
        deductedFromAmount: true,
        chainId: r.sourceChainId,
      });
    }
    const pathway = r.source.pathways[r.destinationChainId]!;
    const notes = [describeVerifiers(pathway), r.source.controlNote];
    if (head.amountReceivedLD > request.amount) {
      notes.push(`The pool adds a reward: ${head.amountReceivedLD - request.amount} base units more than sent should arrive.`);
    }
    if (r.target.kind === 'stargate-pool-native') {
      notes.push(
        "Stargate delivers ETH with a 2,300-gas transfer. A deployed smart account cannot accept that, so for one the ETH stays in Stargate's pool until someone calls retryReceiveToken on the receiving network (anyone may, paying gas there).",
      );
    }
    return {
      providerId: id,
      route: request.route,
      amountIn: request.amount,
      expectedAmountOut: head.amountReceivedLD,
      minAmountOut: minOut,
      fees,
      time: {
        minSeconds: null,
        maxSeconds: null,
        source: `Not measured on the test networks. The verifiers wait for ${pathway.confirmations} source-block confirmations, then the executor delivers.`,
      },
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
    };
  }

  async function track(transfer: BridgeTransfer): Promise<BridgeTransferStatus> {
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

  return {
    id,
    label: options.label ?? 'LayerZero OFT',
    trust: LAYERZERO_OFT_TRUST,
    supportedRoutes: () => publicRoutes,
    quote,
    track,
  };
}

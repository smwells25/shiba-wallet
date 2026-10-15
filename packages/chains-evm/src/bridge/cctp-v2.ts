import { encodeFunctionCall } from '../abi.js';
import { toBytes } from '../encoding.js';
import type { Call } from '../smart-account.js';
import type {
  BridgeAsset,
  BridgeCall,
  BridgeProvider,
  BridgeQuote,
  BridgeQuoteRequest,
  BridgeRoute,
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
 *  - Fast Transfers are refused: their fee must be read from Circle's Iris
 *    API before signing and is deducted at mint, so a quote without that
 *    read would guess. A later slice adds an injected fee reader.
 *  - Fetching the attestation is the app's job: track() calls the
 *    injected `fetchAttestation`. Circle's documented endpoint for it is
 *    GET https://iris-api-sandbox.circle.com/v2/messages/{sourceDomain}
 *    ?transactionHash={hash} (keyless on 2026-10-12, BRIDGING.md 4.3).
 *  - Nothing here signs, sends or reads the chain.
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
  if (p.minFinalityThreshold !== CCTP_FINALITY_STANDARD && p.minFinalityThreshold !== CCTP_FINALITY_FAST) {
    throw new Error('The finality threshold must be 2000 (Standard) or 1000 (Fast).');
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
  isMinted?: CctpMintChecker;
}

export const CCTP_V2_TRUST: BridgeTrustStatement = {
  verification:
    "Circle verifies every transfer: two Circle attesters must sign the burn before USDC can be minted on the other network. Circle also issues USDC itself.",
  control:
    'Circle can pause transfers, refuse listed addresses (it checks the sending account and the transaction originator, which for a smart account is the bundler), and replace the contracts. On the test networks these roles are held by addresses with no contract code.',
  refundRule:
    'There is no refund: the USDC is burned on the sending network. Once Circle attests the burn, anyone with gas on the receiving network can complete the mint to your address, at any time.',
};

function usdcAsset(chainId: number): BridgeAsset {
  const address = CCTP_V2_TESTNET_USDC[chainId];
  if (!address) throw new Error(`Chain ${chainId} has no verified CCTP USDC.`);
  return { kind: 'erc20', address, symbol: 'USDC', decimals: 6 };
}

export const CCTP_V2_PROVIDER_ID = 'cctp-v2';

export function createCctpV2Provider(options: CctpV2ProviderOptions = {}): BridgeProvider {
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
      time: {
        minSeconds: 15 * 60,
        maxSeconds: 19 * 60,
        source:
          'Circle documents "~15-19 minutes" for a Standard Transfer from Ethereum, Arbitrum, Base and OP mainnets; not measured on the test networks.',
      },
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


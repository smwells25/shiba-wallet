import type { SessionParamRule } from '../kernel-permissions.js';
import type { Call } from '../smart-account.js';

/**
 * The BridgeProvider adapter interface (phase 21 item 1; requirement 4 in
 * AGENTS.md: "no architectural lock-in"). Design and rationale:
 * docs/BRIDGE_PROVIDERS.md. Research behind the two first adapters:
 * docs/BRIDGING.md (CCTP V2 in section 4, LayerZero V2 and Stargate V2 in
 * section 15).
 *
 * A provider is a plain object registered under a stable id, in the same
 * spirit as the chain adapters of ADR D3 (docs/ARCHITECTURE.md section 7):
 * the app picks a provider by id, asks it for routes and quotes, shows the
 * user the provider's own trust statement, fee lines, timing and refund
 * rule, and then sends the source-chain calls through its existing send
 * paths. Nothing in this module signs or sends, and the registry itself
 * makes no network request. A provider that needs the network receives
 * read functions from the app (dependency injection), so the engine stays
 * pure and testable (ADR D2).
 *
 * Amounts are exact bigints in base units of the asset they describe.
 * Addresses are EIP-55 checksummed strings.
 */

/** A provider id: lower-case letters, digits and hyphens, 2 to 40 characters. */
export type BridgeProviderId = string;

/** An asset as it exists on one chain. */
export type BridgeAsset =
  | { kind: 'native'; symbol: string; decimals: number }
  | { kind: 'erc20'; address: string; symbol: string; decimals: number };

/** One direction a provider can move one asset in. */
export interface BridgeRoute {
  providerId: BridgeProviderId;
  /** EIP-155 chain id of the network the user sends from. */
  sourceChainId: number;
  /** EIP-155 chain id of the network the funds arrive on. */
  destinationChainId: number;
  /** What leaves the user's account on the source chain. */
  sourceAsset: BridgeAsset;
  /** What arrives on the destination chain. */
  destinationAsset: BridgeAsset;
}

/**
 * One fixed 32-byte word of calldata that a Kernel CallPolicy can check,
 * in the wallet's existing SessionParamRule shape (kernel-permissions.ts),
 * so that a session key or spending rule can be built from it directly.
 */
export interface BridgePin {
  /** Human-readable name of the field the word holds, for the review screen and tests. */
  field: string;
  rule: SessionParamRule;
}

/** A call the user signs on the source chain, with what a CallPolicy could hold fixed. */
export interface BridgeCall extends Call {
  purpose: 'approve' | 'bridge';
  /** Chain the call must be sent on. */
  chainId: number;
  /** Short plain-English description for the confirm screen. */
  label: string;
  /** 4-byte selector as 0x-hex. */
  selector: string;
  /**
   * Words a CallPolicy can pin. For a call whose arguments include dynamic
   * types this list is complete only for the canonical encoding this module
   * produces; see `unpinnable`.
   */
  pins: BridgePin[];
  /** Arguments a CallPolicy cannot check, with the reason. Empty when every argument is pinned. */
  unpinnable: string[];
  /** The largest msg.value the call needs (a CallPolicy valueLimit). */
  valueLimit: bigint;
}

/** An exact ERC-20 approval the bridge needs. The wallet never approves more than `amount`. */
export interface BridgeApproval {
  chainId: number;
  token: string;
  spender: string;
  amount: bigint;
}

/** One line of the fee breakdown shown before the user confirms. */
export interface BridgeFeeLine {
  kind: 'protocol' | 'messaging' | 'pool' | 'forwarding';
  description: string;
  /** Exact amount, or null when the provider cannot state it before sending. */
  amount: bigint | null;
  /** The asset the fee is paid in. */
  asset: BridgeAsset;
  /** True when the fee is taken out of the amount sent (so the recipient gets less). */
  deductedFromAmount: boolean;
  /** Chain on which the fee is paid. */
  chainId: number;
}

/** Expected time from source inclusion to funds usable on the destination. */
export interface BridgeTimeEstimate {
  /** Lower and upper bound in seconds, or null when not known. */
  minSeconds: number | null;
  maxSeconds: number | null;
  /** Where the figure comes from (document and date, or "not measured on test networks"). */
  source: string;
}

/** What has to happen on the destination chain after the source transaction. */
export type BridgeDestinationStep =
  | {
      /** CCTP: an attestation must be fetched and the mint submitted by someone with gas there. */
      kind: 'mint-after-attestation';
      submitter: 'anyone' | 'recipient-only';
      description: string;
    }
  | {
      /** LayerZero: an executor normally delivers; anyone may execute a verified message. */
      kind: 'executor-delivers';
      description: string;
    };

/** How the app can follow a transfer to completion. */
export interface BridgeTrackingMethod {
  /** Plain description of the method, e.g. "Circle's keyless Iris API, then the destination receipt". */
  description: string;
  /** True when tracking needs an off-chain HTTP API. */
  needsHttpApi: boolean;
  /** True when that API needs a key (false for every provider registered so far). */
  needsApiKey: boolean;
}

/** The provider's honest statement of what the user trusts, shown verbatim on the Bridge screen. */
export interface BridgeTrustStatement {
  /** One or two sentences: who verifies the transfer. */
  verification: string;
  /** Who can pause, censor or upgrade, as read on-chain. */
  control: string;
  /** What the user can do if the transfer does not complete. */
  refundRule: string;
}

/** What the app asks a provider for. */
export interface BridgeQuoteRequest {
  route: BridgeRoute;
  /** Amount to send, in base units of `route.sourceAsset`. */
  amount: bigint;
  /** The account that signs the source calls (EOA or smart account). */
  sender: string;
  /** The account that receives on the destination. */
  recipient: string;
  /**
   * The least the user accepts on the destination, in base units of
   * `route.destinationAsset`. Providers refuse to quote below it.
   */
  minAmountOut?: bigint;
}

/** A complete, reviewable quote. */
export interface BridgeQuote {
  providerId: BridgeProviderId;
  route: BridgeRoute;
  amountIn: bigint;
  /** What the recipient should receive if nothing changes before inclusion. */
  expectedAmountOut: bigint;
  /** The least the source call allows the recipient to receive (written into the call when the protocol supports it). */
  minAmountOut: bigint;
  fees: BridgeFeeLine[];
  time: BridgeTimeEstimate;
  approvals: BridgeApproval[];
  /** The calls to sign on the source chain, in order (an exact approval first when one is needed). */
  calls: BridgeCall[];
  destination: BridgeDestinationStep;
  refundRule: string;
  tracking: BridgeTrackingMethod;
  /** Extra plain-English warnings for the confirm screen. */
  notes: string[];
}

/** A transfer the app has sent and wants to follow. */
export interface BridgeTransfer {
  providerId: BridgeProviderId;
  route: BridgeRoute;
  sourceTxHash: string;
  amountIn: bigint;
  recipient: string;
}

export type BridgeTransferState =
  | 'unknown'
  | 'in-flight'
  | 'awaiting-destination-action'
  | 'delivered'
  | 'failed';

export interface BridgeTransferStatus {
  state: BridgeTransferState;
  detail: string;
  /** Calls the destination needs (CCTP mint, Stargate retry), when the provider can build them. */
  destinationCalls?: Call[];
  destinationTxHash?: string;
}

/** The adapter every bridge provider implements. */
export interface BridgeProvider {
  readonly id: BridgeProviderId;
  /** Name shown to the user. */
  readonly label: string;
  readonly trust: BridgeTrustStatement;
  /** Every route this provider serves. Pure: no network request. */
  supportedRoutes(): readonly BridgeRoute[];
  /** Builds a quote. May read the chain through functions the app injected at construction. */
  quote(request: BridgeQuoteRequest): Promise<BridgeQuote>;
  /** Reports where a sent transfer is. */
  track(transfer: BridgeTransfer): Promise<BridgeTransferStatus>;
}

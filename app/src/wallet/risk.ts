import { toChecksumAddress } from '@shiba-wallet/core';
import {
  MAX_UINT256,
  SET_APPROVAL_FOR_ALL_SELECTOR,
  classifyRecipient,
  encodeErc20Approve,
  findCodeDeploymentBlock,
  isFirstInteraction,
  riskSignals,
  toBytes,
  toHex,
  type AssetChange,
  type DeploymentSearchResult,
  type FirstInteractionResult,
  type JsonRpcTransport,
  type RecipientClass,
  type RiskSignalType,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extension: this module is imported by
// scripts/check-approvals.mjs under Node's type stripping, which resolves
// relative specifiers literally.
import { groupThousands, simulationTransport } from './simulation.ts';
import { WALLET_7702_DELEGATE } from './delegation.ts';

/**
 * Risk warnings for EVM confirm screens (phase 7, item 5, app half). The
 * facts come from the engine's contract-risk.ts over plain JSON-RPC against
 * the ACTIVE chain's endpoint; the engine's riskSignals aggregator turns them
 * into typed signals, and computeRiskLines (pure) orders them for display.
 * There are no scores, reputation lists or vendors involved.
 *
 * What is checked, and the honesty rules for each:
 *  - Recipient class (classifyRecipient on the transaction's `to`): ordinary
 *    account, contract, or EIP-7702 delegated account. A failed lookup
 *    produces no signal.
 *  - Approvals: taken from the balance-change preview's asset changes when
 *    the caller has them; otherwise decoded from the calldata of a DIRECT
 *    approve(address,uint256) or setApprovalForAll(address,bool) call (see
 *    approvalChangesFromCalldata for the exact rule and its limits).
 *  - Recipient class: always shown as a line when known (or a line saying
 *    it could not be checked), so a confirm screen with an endpoint never
 *    shows an empty risk card.
 *  - First interaction: token transfers are searched with
 *    isFirstInteraction over the tracked tokens plus the known test-network
 *    tokens (the free public endpoints refuse log filters without a
 *    contract address), and plain ETH transfers through the history indexer
 *    when one is configured (searchNativeInteraction). The notice always
 *    names what was searched; when nothing could be searched it says so
 *    ("could not be checked") instead of staying silent — the wallet never
 *    claims "first time" without having looked.
 *  - New contract (findCodeDeploymentBlock): needs historical eth_getCode,
 *    which free endpoints refuse beyond about 64 blocks (engine live probe,
 *    2026-10-01). The search is bounded to the per-chain threshold window
 *    below; when the endpoint refuses that depth, a shallower probe finds
 *    the depth it does serve and searches inside it (contractAgeFacts). A
 *    contract whose age still cannot be compared with the threshold gets
 *    the neutral CONTRACT_AGE_UNKNOWN_LINE, never a "new contract" warning.
 *
 * The look-alike-contact warning is NOT produced here; it stays in
 * ./contacts.ts and the send screens' RecipientContactNotice.
 *
 * Free of React Native imports so scripts/check-approvals.mjs exercises
 * this exact code with a fake JSON-RPC node.
 */

// ---------------------------------------------------------------------------
// Thresholds and lookbacks (documented choices, not standards)
// ---------------------------------------------------------------------------

/**
 * Ethereum proof-of-stake produces at most one block per 12-second slot
 * (ethereum.org, "Blocks": "In every slot (spaced twelve seconds apart) a
 * validator is randomly selected to be the block proposer", and slots "can
 * sometimes go empty"). Measured 2026-10-01 over the latest 10,000 blocks
 * via the app's default publicnode endpoints: 12.05 s/block on mainnet and
 * 12.07 s/block on Sepolia. Used only to phrase block counts as approximate
 * durations for the user; nothing is decided from it.
 */
export const SECONDS_PER_BLOCK_ESTIMATE = 12;

/**
 * Per-chain block time for the same phrasing. Base Sepolia produces a block
 * every 2 seconds (sources under NEW_CONTRACT_THRESHOLD_BLOCKS below);
 * chains not listed use SECONDS_PER_BLOCK_ESTIMATE. Since the known
 * test-network tokens (tokens.ts) made the first-interaction search and the
 * approvals scan run on Base Sepolia, their range sentences need it.
 */
export const SECONDS_PER_BLOCK_BY_CHAIN: Readonly<Record<string, number>> = {
  'eip155:84532': 2,
};

/**
 * "New contract" threshold, per CAIP-2 chain, in blocks. The engine has no
 * built-in threshold (contract-risk.ts leaves it to the app on purpose).
 *
 * CHOICE: 50,400 blocks = 7 days x 7,200 blocks/day at 12-second slots, on
 * both Ethereum mainnet and Sepolia (same slot time, measured above). The
 * reasoning is a product judgement, not an industry standard or a measured
 * fraud statistic: a contract younger than one week has had little public
 * use or review, and a week is long enough that ordinary dApp contracts a
 * user meets have usually been live longer, so the warning stays rare. It
 * should be revisited with real-world data. Chains not listed get no
 * new-contract check at all.
 *
 * Base Sepolia (phase 11 item 5): the same 7 days, at Base's 2-second
 * blocks: 7 x 86,400 s / 2 s = 302,400 blocks. Sources (read 2026-10-03):
 * docs.base.org "Transaction Ordering"
 * (https://docs.base.org/specifications/transactions/transaction-ordering:
 * Flashblocks "reduce effective block times from 2 seconds to 200
 * milliseconds through preconfirmations" — the 200 ms preconfirmations do
 * not change the block number, which still advances every 2 seconds) and
 * "Network Fees" (https://docs.base.org/specifications/transactions/network-fees:
 * "18 blocks × 2 seconds = 36 seconds"); measured live the same day over
 * the latest 10,000 Base Sepolia blocks via the app's default endpoint:
 * exactly 2.0 s/block. Free endpoints usually refuse historical
 * eth_getCode this far back, which gives "unknown" and no signal, exactly
 * as on Ethereum.
 *
 * The search runs from (head - threshold) to head: if code already exists
 * at the start, the contract is older than the threshold and no signal is
 * raised (the engine reports atOrBefore). On free endpoints the very first
 * historical eth_getCode is refused, which this module turns into "unknown".
 */
export const NEW_CONTRACT_THRESHOLD_BLOCKS: Readonly<Record<string, bigint>> = {
  'eip155:1': 50_400n,
  'eip155:11155111': 50_400n,
  'eip155:84532': 302_400n,
};

/** eth_getLogs window size (token-history.ts's 9,000-block window). */
export const RISK_LOG_WINDOW_BLOCKS = 9_000n;

/**
 * First-interaction lookback: first try the token-history bounded lookback
 * (8 windows of 9,000 = 72,000 blocks, about 10 days). Live probe
 * 2026-10-01: https://ethereum.publicnode.com (the app's working mainnet
 * default) refuses eth_getLogs whose fromBlock is more than about 10,000
 * blocks behind the head (-32602 "Archive requests require a personal
 * token"), so on refusal the search is retried over a single 9,000-block
 * window, which that endpoint serves. The notice names the range actually
 * searched.
 */
export const FIRST_INTERACTION_LOOKBACK_BLOCKS = 72_000n;
export const FIRST_INTERACTION_FALLBACK_BLOCKS = 9_000n;

/**
 * Shallower contract-age probes, used when the endpoint refuses historical
 * state at the full threshold depth (phase 11 item 6 finding F2: on
 * Sepolia, publicnode answered "state at block … is pruned" 50,400 blocks
 * back, so a 150-block-old contract got no warning). Deepest first; the
 * first depth at which eth_getCode answers is the depth this endpoint
 * serves, and the deployment search then runs inside it — the same idea as
 * token-history.ts, which keeps what the endpoint actually answered.
 * Depths at or beyond the chain's threshold are skipped (the full search
 * already covered them). The engine's 2026-10-01 probe of
 * ethereum.publicnode.com answered at latest-64 and refused at latest-127.
 */
export const CONTRACT_AGE_PROBE_DEPTHS: readonly bigint[] = [16_384n, 4_096n, 1_024n, 256n, 128n, 64n, 32n];

/** The neutral line when a contract's age cannot be established. */
export const CONTRACT_AGE_UNKNOWN_LINE = 'Contract age could not be checked on this endpoint.';

/**
 * alchemy_getAssetTransfers page size for the native-ETH first-interaction
 * search through the history indexer: the documented default,
 * 0x3e8 = 1,000 (www.alchemy.com/docs/reference/alchemy-getassettransfers,
 * "maxCount" default "0x3e8", re-read 2026-10-03).
 */
export const NATIVE_INTERACTION_MAX_COUNT = 1_000;

// ---------------------------------------------------------------------------
// Calldata-derived approvals
// ---------------------------------------------------------------------------

/** approve(address,uint256) selector, taken from the engine's encoder (no hardcoded hex). */
export const ERC20_APPROVE_SELECTOR_HEX = toHex(
  encodeErc20Approve('0x0000000000000000000000000000000000000000', 0n).slice(0, 4),
);
export const SET_APPROVAL_FOR_ALL_SELECTOR_HEX = toHex(SET_APPROVAL_FOR_ALL_SELECTOR);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function checksum(address: string): string {
  return toChecksumAddress(toBytes(address.toLowerCase()));
}

function dataToHex(data: Uint8Array | string | undefined): string {
  if (data === undefined) return '0x';
  const hex = typeof data === 'string' ? data : toHex(data);
  return hex.toLowerCase();
}

/** Address from an ABI word whose top 12 bytes are zero, else null. */
function wordToAddress(word: string): string | null {
  if (word.length !== 64 || !/^0{24}/.test(word)) return null;
  return checksum('0x' + word.slice(24));
}

/**
 * The approval a DIRECT call grants, decoded from its calldata, as engine
 * AssetChange entries (callIndex 0, owner = the wallet, token = `to`):
 *  - approve(address,uint256): an 'erc20-approval' (unlimited exactly at
 *    type(uint256).max, the engine's definition);
 *  - setApprovalForAll(address,bool): an 'approval-for-all'.
 * Only exactly-sized calldata (selector + two words) with a clean address
 * word (and a 0/1 bool word) is decoded; anything else yields nothing.
 *
 * LIMITS: this is the fallback for when no simulation result is available.
 * It sees only the top-level call, not approvals made indirectly by a
 * contract. ERC-721's per-token approve(address,uint256 tokenId) has the
 * same selector as the ERC-20 approve, so an ERC-721 approve whose token id
 * happens to be type(uint256).max would be read as an unlimited approval —
 * an over-warning, never a missed one. The simulation's event-based
 * changes, when passed in, take precedence and do not have this ambiguity.
 */
export function approvalChangesFromCalldata(
  to: string,
  wallet: string,
  data: Uint8Array | string | undefined,
): AssetChange[] {
  if (!ADDRESS.test(to) || !ADDRESS.test(wallet)) return [];
  const hex = dataToHex(data);
  if (!/^0x[0-9a-f]*$/.test(hex) || hex.length !== 2 + 8 + 128) return [];
  const selector = hex.slice(0, 10);
  const word1 = hex.slice(10, 74);
  const word2 = hex.slice(74, 138);
  const first = wordToAddress(word1);
  if (!first) return [];
  if (selector === ERC20_APPROVE_SELECTOR_HEX) {
    const amount = BigInt('0x' + word2);
    return [
      {
        type: 'erc20-approval',
        callIndex: 0,
        token: checksum(to),
        owner: checksum(wallet),
        spender: first,
        amount,
        unlimited: amount === MAX_UINT256,
      },
    ];
  }
  if (selector === SET_APPROVAL_FOR_ALL_SELECTOR_HEX) {
    const flag = BigInt('0x' + word2);
    if (flag !== 0n && flag !== 1n) return [];
    return [
      {
        type: 'approval-for-all',
        callIndex: 0,
        token: checksum(to),
        owner: checksum(wallet),
        operator: first,
        approved: flag === 1n,
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Facts -> lines (pure)
// ---------------------------------------------------------------------------

/**
 * Result of the native-ETH first-interaction search through the history
 * indexer (alchemy_getAssetTransfers, fromAddress = the wallet, categories
 * external + internal). These entries describe value the wallet's own
 * transactions (or its smart account's calls) moved, so a match is
 * evidence, unlike a Transfer log anyone can emit.
 */
export interface NativeInteractionResult {
  /** True when a transfer from the wallet to the counterparty was listed. */
  known: boolean;
  /** How many sent transfers the indexer returned (newest first). */
  checkedTransfers: number;
  /** True when the indexer said there are no more (no pageKey): the whole sent history was searched. */
  complete: boolean;
}

export interface RiskFacts {
  /** The transaction's `to` (what classification and age describe). */
  to: string;
  /** classifyRecipient result for `to`; absent when the lookup failed or was skipped. */
  recipientClass?: RecipientClass;
  /** True when an endpoint was available, so classification was attempted. */
  classifyAttempted?: boolean;
  /** Whether the transaction carries non-empty calldata. */
  hasCalldata: boolean;
  /** Approval/transfer changes (preview or calldata-derived). */
  assetChanges?: AssetChange[];
  /** isFirstInteraction result for the counterparty; absent when not searched or failed. */
  firstInteraction?: FirstInteractionResult;
  /** Symbols of the tokens the first-interaction search covered (tracked + known). */
  firstInteractionTokens?: string[];
  /**
   * Whether a first-interaction line applies at all: false for a send to the
   * wallet itself and when no endpoint was available (calldata-only checks).
   */
  firstInteractionApplicable?: boolean;
  /** Why the token-log search did not produce a result. */
  tokenSearch?: 'searched' | 'no-tokens' | 'failed';
  /** The native-ETH search through the history indexer. */
  nativeInteraction?: NativeInteractionResult;
  /** Why the native search did not produce a result. */
  nativeSearch?: 'searched' | 'no-indexer' | 'failed';
  /** The chain the facts were gathered on (durations use its block time). */
  chainCaip2?: string;
  /**
   * Deployment search result with the chain threshold, when the age could
   * be established: from the full threshold-deep search, or from a shallow
   * probe that found the deployment inside the depth the endpoint serves.
   */
  contractAge?: { result: DeploymentSearchResult; thresholdBlocks: bigint };
  /**
   * Set when the recipient is a contract but its age could not be
   * established against the threshold. `atLeastBlocks`: the contract
   * already had code at the deepest block the endpoint served.
   */
  contractAgeUnknown?: { atLeastBlocks?: bigint };
  /**
   * True when `to` is one of the wallet's OWN accounts delegated (EIP-7702)
   * to the wallet's pinned Kernel v3.3 delegate — the expected result of
   * "Upgrade this account", so the delegated-eoa signal is not raised. It
   * stays for every other address and for a foreign delegate on an own
   * account (see isExpectedOwnDelegation).
   */
  expectedOwnDelegation?: boolean;
}

/**
 * True only when `to` is the sending wallet or another of the wallet's own
 * EVM addresses AND its delegation indicator names exactly the pinned
 * Kernel v3.3 delegate (./delegation.ts WALLET_7702_DELEGATE).
 */
export function isExpectedOwnDelegation(
  to: string,
  recipientClass: RecipientClass | undefined,
  ownAddresses: readonly string[],
): boolean {
  if (recipientClass?.kind !== 'delegated-eoa') return false;
  if (recipientClass.delegate.toLowerCase() !== WALLET_7702_DELEGATE.toLowerCase()) return false;
  const lower = to.toLowerCase();
  return ownAddresses.some((a) => a.toLowerCase() === lower);
}

export type RiskTone = 'warning' | 'notice';

/**
 * Line types: the engine's signal types plus the app's own lines —
 * 'recipient-class' (what `to` is), 'contract-age-unknown' (age could not
 * be established) and 'first-interaction-unchecked' (no search could run).
 */
export type RiskLineType =
  | RiskSignalType
  | 'recipient-class'
  | 'contract-age-unknown'
  | 'first-interaction-unchecked';

export interface RiskLine {
  type: RiskLineType;
  tone: RiskTone;
  text: string;
  /** Address the line is about, when the engine named one. */
  subject?: string;
}

/**
 * "about 10 days" / "about 33 hours" / "about 13 minutes" for a block count
 * (approximate by design), at the chain's block time.
 */
export function approxDuration(blocks: bigint, chainCaip2?: string): string {
  const perBlock =
    (chainCaip2 !== undefined ? SECONDS_PER_BLOCK_BY_CHAIN[chainCaip2] : undefined) ?? SECONDS_PER_BLOCK_ESTIMATE;
  const seconds = Number(blocks) * perBlock;
  const hours = seconds / 3600;
  if (hours < 1) {
    const m = Math.max(1, Math.round(seconds / 60));
    return `about ${m} minute${m === 1 ? '' : 's'}`;
  }
  if (hours < 48) {
    const h = Math.max(1, Math.round(hours));
    return `about ${h} hour${h === 1 ? '' : 's'}`;
  }
  return `about ${Math.round(hours / 24)} days`;
}

/** The searched-range sentence appended to the first-interaction notice. */
export function firstInteractionScope(
  result: FirstInteractionResult,
  symbols: string[],
  chainCaip2?: string,
): string {
  const blocks = result.scannedToBlock - result.scannedFromBlock + 1n;
  const what = symbols.length > 0 ? `${symbols.join(', ')} transfers` : 'token transfers';
  return (
    `Searched: ${what} in blocks ${result.scannedFromBlock}–${result.scannedToBlock} ` +
    `(the last ${groupThousands(blocks.toString())} blocks, ${approxDuration(blocks, chainCaip2)}).`
  );
}

/** The searched-range sentence for the native-ETH search through the history indexer. */
export function nativeInteractionScope(result: NativeInteractionResult): string {
  return result.complete
    ? 'Searched: every ETH transfer you sent, through your history indexer.'
    : `Searched: your latest ${groupThousands(String(result.checkedTransfers))} ETH transfers sent, ` +
        'through your history indexer (older ones were not searched).';
}

/** The first-interaction notice when a search ran and found nothing. */
export const FIRST_INTERACTION_NONE_FOUND =
  'No earlier transfers from you to this address were found. This may be your first time sending ' +
  'to it, so double-check every character of the address.';

/** The recipient-class sentence (always shown when the class is known). */
export function recipientClassText(to: string, recipientClass: RecipientClass, ownUpgraded: boolean): string {
  if (recipientClass.kind === 'contract') return `This transaction goes to a contract (${to}).`;
  if (recipientClass.kind === 'eoa') {
    return `This transaction goes to a regular account with no contract code on this network (${to}).`;
  }
  return ownUpgraded
    ? `This transaction goes to one of your own accounts, upgraded to this wallet's Kernel v3.3 delegate (${to}).`
    : `This transaction goes to a regular account that runs delegated contract code (${to}).`;
}

function firstInteractionLine(facts: RiskFacts): RiskLine | null {
  if (!facts.firstInteractionApplicable) return null;
  if (facts.firstInteraction?.known || facts.nativeInteraction?.known) return null;
  const tokensSearched = facts.firstInteraction !== undefined;
  const nativeSearched = facts.nativeInteraction !== undefined;
  if (!tokensSearched && !nativeSearched) {
    const why: string[] = [];
    if (facts.tokenSearch === 'no-tokens') why.push('there are no tracked or known tokens on this network to search');
    if (facts.tokenSearch === 'failed') why.push('the endpoint refused the token-transfer search');
    if (facts.nativeSearch === 'no-indexer') {
      why.push('plain ETH transfers need a history indexer (Settings → Ethereum history indexer)');
    }
    if (facts.nativeSearch === 'failed') why.push('the history indexer did not answer');
    return {
      type: 'first-interaction-unchecked',
      tone: 'notice',
      text:
        'Whether you have sent to this address before could not be checked' +
        (why.length > 0 ? `: ${why.join('; ')}` : '') +
        '. Double-check every character of the address.',
    };
  }
  const parts = [FIRST_INTERACTION_NONE_FOUND];
  if (facts.firstInteraction) {
    parts.push(firstInteractionScope(facts.firstInteraction, facts.firstInteractionTokens ?? [], facts.chainCaip2));
  } else if (facts.tokenSearch === 'failed') {
    parts.push('Token transfers could not be searched: the endpoint refused the search.');
  }
  if (facts.nativeInteraction) {
    parts.push(nativeInteractionScope(facts.nativeInteraction));
  } else if (facts.nativeSearch === 'failed') {
    parts.push('ETH transfers could not be searched: the history indexer did not answer.');
  } else {
    parts.push('(Plain ETH transfers cannot be checked without a history indexer.)');
  }
  return { type: 'first-interaction-unknown', tone: 'notice', text: parts.join(' ') };
}

/**
 * Pure: runs the engine's riskSignals over the gathered facts and returns
 * display lines, warnings first (engine order kept within each tone). The
 * engine's own plain-language messages are used verbatim, except the
 * first-interaction notice, which the app writes itself because it also
 * covers the native-ETH search and the could-not-check case. App lines:
 * the recipient class (whenever it is known, unless the no-code-with-
 * calldata warning or the delegated-account notice already says it), the
 * neutral contract-age line, and the could-not-check first-interaction
 * line. Returns [] only when no endpoint was available and no approval
 * was decoded.
 */
export function computeRiskLines(facts: RiskFacts): RiskLine[] {
  const signals = riskSignals({
    ...(facts.recipientClass ? { recipient: { address: facts.to, class: facts.recipientClass } } : {}),
    hasCalldata: facts.hasCalldata,
    ...(facts.assetChanges ? { assetChanges: facts.assetChanges } : {}),
    // Age only means something for ordinary contracts; riskSignals also
    // ignores it for other classes, this keeps the input honest.
    ...(facts.contractAge && facts.recipientClass?.kind === 'contract'
      ? { contractAge: facts.contractAge }
      : {}),
  });
  const kept = facts.expectedOwnDelegation
    ? signals.filter((s) => s.type !== 'delegated-eoa')
    : signals;
  const lines: RiskLine[] = kept.map((s) => ({
    type: s.type,
    tone: s.severity,
    text: s.message,
    ...(s.subject ? { subject: s.subject } : {}),
  }));

  if (facts.recipientClass) {
    const saidByEngine = lines.some(
      (l) => l.type === 'no-code-recipient-with-calldata' || l.type === 'delegated-eoa',
    );
    if (!saidByEngine) {
      lines.push({
        type: 'recipient-class',
        tone: 'notice',
        text: recipientClassText(facts.to, facts.recipientClass, facts.expectedOwnDelegation === true),
        subject: facts.to,
      });
    }
  } else if (facts.classifyAttempted) {
    lines.push({
      type: 'recipient-class',
      tone: 'notice',
      text: `Whether ${facts.to} is a contract or a regular account could not be checked on this endpoint.`,
      subject: facts.to,
    });
  }

  if (facts.recipientClass?.kind === 'contract' && facts.contractAgeUnknown) {
    const atLeast = facts.contractAgeUnknown.atLeastBlocks;
    lines.push({
      type: 'contract-age-unknown',
      tone: 'notice',
      text:
        atLeast !== undefined
          ? `${CONTRACT_AGE_UNKNOWN_LINE} It has had code for at least the last ` +
            `${groupThousands(atLeast.toString())} blocks (${approxDuration(atLeast, facts.chainCaip2)}), ` +
            'the oldest state this endpoint serves.'
          : CONTRACT_AGE_UNKNOWN_LINE,
      subject: facts.to,
    });
  }

  const first = firstInteractionLine(facts);
  if (first) lines.push(first);

  return [
    ...lines.filter((l) => l.tone === 'warning'),
    ...lines.filter((l) => l.tone === 'notice'),
  ];
}

// ---------------------------------------------------------------------------
// Gathering facts over the network (never throws)
// ---------------------------------------------------------------------------

export interface RiskTokenRef {
  /** ERC-20 contract on the ACTIVE chain. */
  address: string;
  symbol: string;
}

export interface GatherRiskOptions {
  /** The active chain's RPC endpoint; null = no network checks (calldata-only). */
  url: string | null;
  /** The sending address (EOA, or the smart account on the AA path). */
  wallet: string;
  /** The transaction's `to`. */
  to: string;
  /**
   * The party the user is paying, when it differs from `to` (for example the
   * recipient inside an ERC-20 transfer, where `to` is the token contract).
   * Used for the first-interaction search. Defaults to `to`.
   */
  counterparty?: string;
  data?: Uint8Array | string;
  /**
   * Changes from the balance-change preview. undefined or null: decode
   * direct approvals from the calldata instead.
   */
  assetChanges?: AssetChange[] | null;
  /** The ACTIVE chain's CAIP-2 id (thresholds are per chain). */
  chainCaip2: string;
  /**
   * ERC-20 tokens on the ACTIVE chain to search for earlier transfers: the
   * tracked tokens plus the known test-network tokens (approvals.ts
   * approvalTokensForChain).
   */
  trackedTokens: RiskTokenRef[];
  /** Injectable for scripts; defaults to simulationTransport(url). */
  transport?: JsonRpcTransport;
  /**
   * The active chain's history indexer URL (indexer.ts; serves
   * alchemy_getAssetTransfers), or null/undefined when none is configured.
   * Used only for the native-ETH first-interaction search.
   */
  indexerUrl?: string | null;
  /** Injectable for scripts; defaults to simulationTransport(indexerUrl). */
  indexerTransport?: JsonRpcTransport;
  /**
   * The wallet's other own EVM addresses (the sending `wallet` always
   * counts). A recipient among them that is delegated to the wallet's
   * pinned Kernel delegate raises no delegated-eoa signal.
   */
  ownAddresses?: readonly string[];
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

const QUANTITY_HEX = /^0x[0-9a-fA-F]+$/;

/**
 * Contract age, honest about endpoint depth. First the full search from
 * (head − threshold) to head. When the endpoint refuses that (historical
 * state pruned), the deepest depth in CONTRACT_AGE_PROBE_DEPTHS at which
 * eth_getCode answers is found and the search runs inside it:
 *  - deployment found inside that depth → a real age (younger than the
 *    threshold, so the engine raises "new contract");
 *  - code already present at that depth → "at least N blocks old", which
 *    cannot be compared with the threshold → neutral line;
 *  - nothing answered, or the search failed half-way (load-balanced
 *    endpoints whose backends keep different history) → neutral line.
 * Never a guessed age.
 */
async function contractAgeFacts(
  transport: JsonRpcTransport,
  address: string,
  threshold: bigint,
): Promise<Pick<RiskFacts, 'contractAge' | 'contractAgeUnknown'>> {
  const headRaw = await attempt(() => transport('eth_blockNumber', []));
  if (typeof headRaw !== 'string' || !QUANTITY_HEX.test(headRaw)) return { contractAgeUnknown: {} };
  const head = BigInt(headRaw);
  const full = await attempt(() =>
    findCodeDeploymentBlock(transport, address, { fromBlock: head > threshold ? head - threshold : 0n, toBlock: head }),
  );
  if (full) return { contractAge: { result: full, thresholdBlocks: threshold } };
  if (full === null) return { contractAgeUnknown: {} }; // no code at head after all: say nothing definite
  for (const depth of CONTRACT_AGE_PROBE_DEPTHS) {
    if (depth >= threshold || depth > head) continue;
    const from = head - depth;
    const served = await attempt(() => transport('eth_getCode', [address, '0x' + from.toString(16)]));
    if (typeof served !== 'string') continue;
    const shallow = await attempt(() => findCodeDeploymentBlock(transport, address, { fromBlock: from, toBlock: head }));
    if (!shallow) return { contractAgeUnknown: {} };
    if (shallow.atOrBefore) return { contractAgeUnknown: { atLeastBlocks: shallow.ageBlocks } };
    return { contractAge: { result: shallow, thresholdBlocks: threshold } };
  }
  return { contractAgeUnknown: {} };
}

/**
 * Native-ETH first-interaction search through the history indexer: one
 * alchemy_getAssetTransfers query for transfers SENT by the wallet
 * (fromAddress; the same documented parameters as the engine's
 * indexer-history.ts provider), newest first, up to
 * NATIVE_INTERACTION_MAX_COUNT entries, matched against the counterparty
 * on the client. The documentation does not say whether fromAddress and
 * toAddress may be combined in one query (re-read 2026-10-03), so the
 * wallet does not rely on it. Throws on a malformed answer.
 */
export async function searchNativeInteraction(
  transport: JsonRpcTransport,
  wallet: string,
  counterparty: string,
): Promise<NativeInteractionResult> {
  const result = (await transport('alchemy_getAssetTransfers', [
    {
      fromBlock: '0x0',
      toBlock: 'latest',
      fromAddress: wallet,
      category: ['external', 'internal'],
      excludeZeroValue: false,
      maxCount: '0x' + NATIVE_INTERACTION_MAX_COUNT.toString(16),
      order: 'desc',
    },
  ])) as { transfers?: unknown; pageKey?: unknown } | null;
  if (!result || !Array.isArray(result.transfers)) {
    throw new Error('The history indexer returned no transfers array');
  }
  const me = wallet.toLowerCase();
  const target = counterparty.toLowerCase();
  const known = result.transfers.some((t) => {
    const transfer = t as { from?: unknown; to?: unknown };
    return (
      typeof transfer.from === 'string' &&
      transfer.from.toLowerCase() === me &&
      typeof transfer.to === 'string' &&
      transfer.to.toLowerCase() === target
    );
  });
  return {
    known,
    checkedTransfers: result.transfers.length,
    complete: !(typeof result.pageKey === 'string' && result.pageKey !== ''),
  };
}

/**
 * Collects every fact it can and returns them; each network check is
 * independent. A failed check is never turned into a warning: it is
 * recorded so the screen can say plainly what could not be checked
 * (recipient class, contract age, first interaction), never a guessed value.
 */
export async function gatherRiskFacts(options: GatherRiskOptions): Promise<RiskFacts> {
  const hasCalldata = dataToHex(options.data).length > 2;
  const assetChanges =
    options.assetChanges ?? approvalChangesFromCalldata(options.to, options.wallet, options.data);
  const facts: RiskFacts = { to: options.to, hasCalldata, assetChanges, chainCaip2: options.chainCaip2 };
  if (!ADDRESS.test(options.to) || !ADDRESS.test(options.wallet)) return facts;
  const transport =
    options.transport ?? (options.url ? simulationTransport(options.url) : null);
  if (!transport) return facts;
  facts.classifyAttempted = true;

  const counterparty =
    options.counterparty && ADDRESS.test(options.counterparty) ? options.counterparty : options.to;
  const tokens = options.trackedTokens.filter((t) => ADDRESS.test(t.address));
  const threshold = NEW_CONTRACT_THRESHOLD_BLOCKS[options.chainCaip2];
  const indexerTransport =
    options.indexerTransport ?? (options.indexerUrl ? simulationTransport(options.indexerUrl) : null);

  const classifyTask = async () => {
    const recipientClass = await attempt(() => classifyRecipient(transport, options.to));
    if (!recipientClass) return;
    facts.recipientClass = recipientClass;
    if (
      isExpectedOwnDelegation(options.to, recipientClass, [options.wallet, ...(options.ownAddresses ?? [])])
    ) {
      facts.expectedOwnDelegation = true;
    }
    if (recipientClass.kind !== 'contract' || threshold === undefined) return;
    Object.assign(facts, await contractAgeFacts(transport, options.to, threshold));
  };

  const tokenSearchTask = async () => {
    // Without tokens there is nothing the free endpoints will search
    // (they refuse log filters without a contract address).
    if (tokens.length === 0) {
      facts.tokenSearch = 'no-tokens';
      return;
    }
    const run = (lookbackBlocks: bigint) =>
      isFirstInteraction(transport, options.wallet, counterparty, {
        lookbackBlocks,
        windowBlocks: RISK_LOG_WINDOW_BLOCKS,
        tokens: tokens.map((t) => t.address),
      });
    const result =
      (await attempt(() => run(FIRST_INTERACTION_LOOKBACK_BLOCKS))) ??
      (await attempt(() => run(FIRST_INTERACTION_FALLBACK_BLOCKS)));
    if (result) {
      facts.firstInteraction = result;
      facts.firstInteractionTokens = tokens.map((t) => t.symbol);
      facts.tokenSearch = 'searched';
    } else {
      facts.tokenSearch = 'failed';
    }
  };

  const nativeSearchTask = async () => {
    if (!indexerTransport) {
      facts.nativeSearch = 'no-indexer';
      return;
    }
    const result = await attempt(() => searchNativeInteraction(indexerTransport, options.wallet, counterparty));
    if (result) {
      facts.nativeInteraction = result;
      facts.nativeSearch = 'searched';
    } else {
      facts.nativeSearch = 'failed';
    }
  };

  const selfSend = counterparty.toLowerCase() === options.wallet.toLowerCase();
  facts.firstInteractionApplicable = !selfSend;
  await Promise.all([
    classifyTask(),
    ...(selfSend ? [] : [tokenSearchTask(), nativeSearchTask()]),
  ]);
  return facts;
}

// ---------------------------------------------------------------------------
// Address tags (approvals manager)
// ---------------------------------------------------------------------------

export type AddressTag = 'contract' | 'EOA' | 'delegated EOA';

/** Display tag for a classifyRecipient result. */
export function recipientTag(recipientClass: RecipientClass): AddressTag {
  if (recipientClass.kind === 'contract') return 'contract';
  if (recipientClass.kind === 'delegated-eoa') return 'delegated EOA';
  return 'EOA';
}

/**
 * Classifies several addresses (sequentially, to stay inside public-endpoint
 * rate limits). Keyed by lowercase address; null when the lookup failed —
 * the UI then shows no tag rather than a guessed one.
 */
export async function classifyAddresses(
  transport: JsonRpcTransport,
  addresses: string[],
): Promise<Record<string, AddressTag | null>> {
  const out: Record<string, AddressTag | null> = {};
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (key in out) continue;
    const recipientClass = await attempt(() => classifyRecipient(transport, address));
    out[key] = recipientClass ? recipientTag(recipientClass) : null;
  }
  return out;
}

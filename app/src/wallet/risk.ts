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
 *  - First interaction (isFirstInteraction): only searched when the user
 *    tracks tokens on this chain, because the free public endpoints refuse
 *    log filters without a contract address. The notice therefore always
 *    names what was searched. A failed search produces no signal — the
 *    wallet never claims "first time" without having looked.
 *  - New contract (findCodeDeploymentBlock): needs historical eth_getCode,
 *    which free endpoints refuse beyond about 64 blocks (engine live probe,
 *    2026-10-01). The search is bounded to the per-chain threshold window
 *    below, and ANY failure means "age unknown": no signal is raised, so a
 *    non-archive endpoint can never produce a false "new contract" warning.
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
 * days for the user; nothing is decided from it.
 */
export const SECONDS_PER_BLOCK_ESTIMATE = 12;

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
 * The search runs from (head - threshold) to head: if code already exists
 * at the start, the contract is older than the threshold and no signal is
 * raised (the engine reports atOrBefore). On free endpoints the very first
 * historical eth_getCode is refused, which this module turns into "unknown".
 */
export const NEW_CONTRACT_THRESHOLD_BLOCKS: Readonly<Record<string, bigint>> = {
  'eip155:1': 50_400n,
  'eip155:11155111': 50_400n,
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

export interface RiskFacts {
  /** The transaction's `to` (what classification and age describe). */
  to: string;
  /** classifyRecipient result for `to`; absent when the lookup failed or was skipped. */
  recipientClass?: RecipientClass;
  /** Whether the transaction carries non-empty calldata. */
  hasCalldata: boolean;
  /** Approval/transfer changes (preview or calldata-derived). */
  assetChanges?: AssetChange[];
  /** isFirstInteraction result for the counterparty; absent when not searched or failed. */
  firstInteraction?: FirstInteractionResult;
  /** Symbols of the tracked tokens the first-interaction search covered. */
  firstInteractionTokens?: string[];
  /** findCodeDeploymentBlock result with the chain threshold; absent when unknown. */
  contractAge?: { result: DeploymentSearchResult; thresholdBlocks: bigint };
}

export type RiskTone = 'warning' | 'notice';

export interface RiskLine {
  type: RiskSignalType;
  tone: RiskTone;
  text: string;
  /** Address the line is about, when the engine named one. */
  subject?: string;
}

/** "about 10 days" / "about 33 hours" for a block count (approximate by design). */
export function approxDuration(blocks: bigint): string {
  const seconds = Number(blocks) * SECONDS_PER_BLOCK_ESTIMATE;
  const hours = seconds / 3600;
  if (hours < 48) {
    const h = Math.max(1, Math.round(hours));
    return `about ${h} hour${h === 1 ? '' : 's'}`;
  }
  return `about ${Math.round(hours / 24)} days`;
}

/** The searched-range sentence appended to the first-interaction notice. */
export function firstInteractionScope(result: FirstInteractionResult, symbols: string[]): string {
  const blocks = result.scannedToBlock - result.scannedFromBlock + 1n;
  const what = symbols.length > 0 ? `${symbols.join(', ')} transfers` : 'token transfers';
  return (
    `Searched: ${what} in blocks ${result.scannedFromBlock}–${result.scannedToBlock} ` +
    `(the last ${groupThousands(blocks.toString())} blocks, ${approxDuration(blocks)}).`
  );
}

/**
 * Pure: runs the engine's riskSignals over the gathered facts and returns
 * display lines, warnings first (engine order kept within each tone). The
 * engine's own plain-language messages are used verbatim; the only addition
 * is the searched-range sentence on the first-interaction notice. Returns
 * [] when nothing applies — the UI then renders nothing.
 */
export function computeRiskLines(facts: RiskFacts): RiskLine[] {
  const signals = riskSignals({
    ...(facts.recipientClass ? { recipient: { address: facts.to, class: facts.recipientClass } } : {}),
    hasCalldata: facts.hasCalldata,
    ...(facts.assetChanges ? { assetChanges: facts.assetChanges } : {}),
    ...(facts.firstInteraction ? { firstInteraction: facts.firstInteraction } : {}),
    // Age only means something for ordinary contracts; riskSignals also
    // ignores it for other classes, this keeps the input honest.
    ...(facts.contractAge && facts.recipientClass?.kind === 'contract'
      ? { contractAge: facts.contractAge }
      : {}),
  });
  const lines: RiskLine[] = signals.map((s) => {
    let text = s.message;
    if (s.type === 'first-interaction-unknown' && facts.firstInteraction) {
      text = `${text} ${firstInteractionScope(facts.firstInteraction, facts.firstInteractionTokens ?? [])}`;
    }
    return { type: s.type, tone: s.severity, text, ...(s.subject ? { subject: s.subject } : {}) };
  });
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
  /** Tracked ERC-20 tokens on the ACTIVE chain (first-interaction filter). */
  trackedTokens: RiskTokenRef[];
  /** Injectable for scripts; defaults to simulationTransport(url). */
  transport?: JsonRpcTransport;
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/**
 * Collects every fact it can and returns them; each network check is
 * independent and a failed one is simply absent (no signal), never an
 * error shown to the user and never a guessed value.
 */
export async function gatherRiskFacts(options: GatherRiskOptions): Promise<RiskFacts> {
  const hasCalldata = dataToHex(options.data).length > 2;
  const assetChanges =
    options.assetChanges ?? approvalChangesFromCalldata(options.to, options.wallet, options.data);
  const facts: RiskFacts = { to: options.to, hasCalldata, assetChanges };
  if (!ADDRESS.test(options.to) || !ADDRESS.test(options.wallet)) return facts;
  const transport =
    options.transport ?? (options.url ? simulationTransport(options.url) : null);
  if (!transport) return facts;

  const counterparty =
    options.counterparty && ADDRESS.test(options.counterparty) ? options.counterparty : options.to;
  const tokens = options.trackedTokens.filter((t) => ADDRESS.test(t.address));
  const threshold = NEW_CONTRACT_THRESHOLD_BLOCKS[options.chainCaip2];

  const classifyTask = async () => {
    const recipientClass = await attempt(() => classifyRecipient(transport, options.to));
    if (!recipientClass) return;
    facts.recipientClass = recipientClass;
    if (recipientClass.kind !== 'contract' || threshold === undefined) return;
    const contractAge = await attempt(async () => {
      const head = BigInt((await transport('eth_blockNumber', [])) as string);
      const fromBlock = head > threshold ? head - threshold : 0n;
      return findCodeDeploymentBlock(transport, options.to, { fromBlock, toBlock: head });
    });
    if (contractAge) facts.contractAge = { result: contractAge, thresholdBlocks: threshold };
  };

  const firstInteractionTask = async () => {
    // Without tracked tokens there is nothing the free endpoints will
    // search, and a notice built on no search at all would be a guess.
    if (tokens.length === 0) return;
    if (counterparty.toLowerCase() === options.wallet.toLowerCase()) return;
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
    }
  };

  await Promise.all([classifyTask(), firstInteractionTask()]);
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

import type { DerivedAccount, FungibleAsset } from '@shiba-wallet/core';
import {
  MAX_UINT256,
  encodeErc20Revoke,
  encodeSetApprovalForAll,
  getErc20Approvals,
  getOperatorApprovals,
  isApprovedForAll,
  withCurrentAllowances,
  type AssetChange,
  type Erc20ApprovalRecord,
  type JsonRpcTransport,
  type OperatorApprovalRecord,
  type OwnedNft,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by
// scripts/check-approvals.mjs under Node's type stripping, which resolves
// relative specifiers literally.
import { formatUnits, groupThousands } from './balances.ts';
import { prepareEvmSend, sendEvm, type EvmSendQuote, type SendResult } from './send.ts';
import { erc20TransferReturnedFalse } from './send-erc20.ts';
import { groupNftsByCollection } from './nfts.ts';
import { simulationTransport } from './simulation.ts';
import { approxDuration, type AddressTag } from './risk.ts';
import { findExactContact, type Contact } from './contacts.ts';
import { maskAmount } from '../config/prefs.ts';

/**
 * Token-approvals manager (phase 7, item 5, app half): lists the approvals
 * the ACTIVE account has granted on the ACTIVE EVM chain and prepares
 * revoke transactions. Built on the engine's approvals.ts over plain
 * JSON-RPC against the chain's configured endpoint.
 *
 * DISCOVERY (logs). For every TRACKED ERC-20 token on the active chain the
 * engine reads Approval(owner, spender, value) logs; for every NFT
 * collection in the NFT gallery's list (nfts.ts, loaded through the same
 * per-account cache) it reads ApprovalForAll(owner, operator, approved)
 * logs. Windows are 9,000 blocks (token-history.ts's size; the engine probe
 * found 10,000 accepted), scanned NEWEST FIRST, one engine call per window
 * so a refused older window never discards the newer ones. A step covers
 * up to 8 windows (72,000 blocks, about 10 days); "search older blocks"
 * extends by another step.
 *
 * ENDPOINT DEPTH (live probe 2026-10-01): https://ethereum.publicnode.com,
 * the app's working mainnet default, refuses eth_getLogs whose fromBlock is
 * more than about 10,000 blocks behind the head, with -32602 "Archive
 * requests require a personal token" (head-10,000 answered, head-10,100 was
 * refused). The Sepolia default served logs 50,000 blocks back. So on the
 * mainnet default only roughly the last 33 hours are searchable: the scan
 * stops at the first refused window, keeps what it found, and the screen
 * says plainly that older approvals are not shown and that an
 * archive-capable endpoint (Settings → Network endpoints) is needed for
 * them. Nothing is guessed about blocks that were not searched.
 *
 * STATE (always live). Logs are history, not state: OpenZeppelin v5 and
 * Tether spend allowances down without an Approval event (engine caveat).
 * Every discovered (token, spender) pair is therefore re-read with
 * allowance() through the engine's withCurrentAllowances, and every
 * (collection, operator) pair with isApprovedForAll, BEFORE anything is
 * shown as active. The live value is what the screen shows; a failed read
 * is shown as "could not confirm", never replaced by the logged value.
 *
 * NOT VISIBLE HERE: approvals on tokens the user does not track, on
 * collections the NFT indexer did not list, older than the searched range,
 * or held inside an intermediary allowance contract (Permit2-style
 * allowances do not emit the token's Approval event — engine design note).
 *
 * REVOKE. approve(spender, 0) (engine encodeErc20Revoke) or
 * setApprovalForAll(operator, false) (engine encodeSetApprovalForAll), sent
 * to the token/collection contract with value 0 and quoted through the
 * EXISTING prepareEvmSend (endpoint chain-id check against the active
 * chain, fee, nonce, eth_estimateGas, eth_call pre-flight) and signed and
 * broadcast through the EXISTING sendEvm: there is no second signing path.
 *
 * Free of React Native imports so scripts/check-approvals.mjs exercises
 * this exact code with a fake JSON-RPC node.
 */

// ---------------------------------------------------------------------------
// Constants and user-facing strings (asserted by scripts/check-approvals.mjs)
// ---------------------------------------------------------------------------

export const APPROVAL_WINDOW_BLOCKS = 9_000n;
export const APPROVAL_STEP_WINDOWS = 8;
/** Contracts scanned in parallel within one window (public-endpoint politeness). */
export const APPROVAL_SCAN_CONCURRENCY = 4;

/**
 * Tether USD on Ethereum mainnet, whose approve() refuses to change a
 * non-zero allowance to another non-zero value (verified Etherscan source,
 * quoted in packages/chains-evm/src/approvals.ts encodeErc20Revoke).
 */
export const USDT_MAINNET = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

export const APPROVALS_EXPLAINER =
  'An approval lets a contract (or another address) move your tokens without asking you again — ' +
  'every later transfer it makes happens without a confirmation from you. Revoking an approval ' +
  'is an ordinary transaction and costs a normal network fee.';
export const APPROVALS_SCOPE_NOTE =
  'Only tokens you track (Manage tokens) and NFT collections in your NFT gallery are checked. ' +
  'Approvals held inside other contracts (for example Permit2-style allowance managers) do not ' +
  'appear here.';
export const NO_ENDPOINT_NOTE =
  'Approvals cannot be checked: no RPC endpoint is configured for this network.';
export const TESTNET_TOKENS_NOTE =
  'Sepolia test mode: your tracked tokens are mainnet assets and are hidden here, so only NFT ' +
  'collections in your Sepolia NFT gallery are checked.';
export const NFT_UNCONFIGURED_NOTE =
  'NFT collections are not checked: configure an NFT indexer in Settings → NFT indexer to include ' +
  'collection-wide (operator) approvals.';
export const NOTHING_TO_CHECK_NOTE =
  'There is nothing to check yet: add tokens in Manage tokens, or configure an NFT indexer, and ' +
  'the approvals you granted on them will be listed here.';
export const ZERO_FIRST_NOTE =
  'Tether USD only lets an allowance change from one non-zero amount to another after it has ' +
  'been set to zero. Revoking sets it to zero, so it always works; to approve a different ' +
  'amount later, revoke first.';
export const REVOKE_ERC20_NOTE =
  'Revoking sets this allowance to zero with approve(spender, 0). That works even on tokens that ' +
  'require an allowance to be zeroed before it can be changed.';
export const REVOKE_OPERATOR_NOTE =
  'Revoking calls setApprovalForAll(operator, false): the operator can no longer move any item ' +
  'in this collection.';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ApprovalTokenRef {
  /** ERC-20 contract, EIP-55. */
  address: string;
  symbol: string;
  decimals: number;
}

export interface ApprovalCollectionRef {
  /** ERC-721 / ERC-1155 contract, EIP-55. */
  address: string;
  title: string;
}

/** The tracked ERC-20 tokens that live on `chainCaip2` (exact CAIP-2 match). */
export function tokensForChain(tokens: FungibleAsset[], chainCaip2: string): ApprovalTokenRef[] {
  return tokens
    .filter((t) => t.assetId.chainId === chainCaip2 && t.assetId.namespace === 'erc20')
    .map((t) => ({ address: t.assetId.reference, symbol: t.symbol, decimals: t.decimals }));
}

/**
 * Distinct collections from the NFT gallery's list. Collections the
 * indexer flags as spam are left out (and counted): they are not what a
 * user approves on purpose, and scanning them would multiply RPC calls.
 */
export function collectionsFromNfts(nfts: OwnedNft[]): {
  collections: ApprovalCollectionRef[];
  spamSkipped: number;
} {
  const groups = groupNftsByCollection(nfts);
  return {
    collections: groups.filter((g) => !g.spam).map((g) => ({ address: g.contract, title: g.title })),
    spamSkipped: groups.filter((g) => g.spam).length,
  };
}

// ---------------------------------------------------------------------------
// Log scan (newest-first windows, merged)
// ---------------------------------------------------------------------------

export interface ApprovalScan {
  chainCaip2: string;
  owner: string;
  /** Head block when the scan started (upper end, inclusive). */
  headBlock: bigint;
  /**
   * Lowest block of the fully scanned range (inclusive). Equals
   * headBlock + 1 when not even the newest window could be scanned.
   */
  scannedFromBlock: bigint;
  tokens: ApprovalTokenRef[];
  collections: ApprovalCollectionRef[];
  /** Latest logged record per (token, spender), newest first. */
  erc20: Erc20ApprovalRecord[];
  /** Latest logged record per (collection, operator), newest first. */
  operators: OperatorApprovalRecord[];
  logsScanned: number;
  /** Logs of unexpected shape (engine skippedLogs), summed. */
  skippedLogs: number;
  /** The endpoint refused this window; older blocks are out of reach with it. */
  refused: { fromBlock: bigint; toBlock: bigint; message: string } | null;
  /** True when the scan reached block 0. */
  exhausted: boolean;
}

interface Positioned {
  blockNumber: bigint;
  logIndex: number;
}

function isLater(a: Positioned, b: Positioned): boolean {
  return a.blockNumber === b.blockNumber ? a.logIndex > b.logIndex : a.blockNumber > b.blockNumber;
}

function mergeLatest<T extends Positioned>(
  existing: T[],
  incoming: T[],
  keyOf: (record: T) => string,
): T[] {
  const map = new Map<string, T>();
  for (const record of [...existing, ...incoming]) {
    const key = keyOf(record);
    const previous = map.get(key);
    if (!previous || isLater(record, previous)) map.set(key, record);
  }
  return [...map.values()].sort((a, b) => (isLater(a, b) ? -1 : isLater(b, a) ? 1 : 0));
}

const erc20Key = (r: Erc20ApprovalRecord) => `${r.token.toLowerCase()}|${r.spender.toLowerCase()}`;
const operatorKey = (r: OperatorApprovalRecord) =>
  `${r.collection.toLowerCase()}|${r.operator.toLowerCase()}`;

async function runLimited<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ApprovalScanOptions {
  transport: JsonRpcTransport;
  windowBlocks?: bigint;
  windows?: number;
}

/**
 * Scans one step (up to `windows` windows) below scan.scannedFromBlock,
 * newest window first. A window counts as scanned only when every contract
 * query in it succeeded; the first refusal stops the step and is recorded
 * (records from the contracts that did answer are still merged — they are
 * real logs). Returns a new scan object.
 */
async function scanStep(scan: ApprovalScan, options: ApprovalScanOptions): Promise<ApprovalScan> {
  const windowBlocks = options.windowBlocks ?? APPROVAL_WINDOW_BLOCKS;
  const windows = options.windows ?? APPROVAL_STEP_WINDOWS;
  let next: ApprovalScan = { ...scan, refused: null };
  for (let i = 0; i < windows && next.scannedFromBlock > 0n; i++) {
    const toBlock = next.scannedFromBlock - 1n;
    const fromBlock = toBlock + 1n > windowBlocks ? toBlock + 1n - windowBlocks : 0n;
    const tasks: Array<() => Promise<{ error?: string }>> = [
      ...next.tokens.map((token) => async () => {
        try {
          const result = await getErc20Approvals(options.transport, {
            owner: next.owner,
            token: token.address,
            fromBlock,
            toBlock,
          });
          next = {
            ...next,
            erc20: mergeLatest(next.erc20, result.approvals, erc20Key),
            logsScanned: next.logsScanned + result.logsScanned,
            skippedLogs: next.skippedLogs + result.skippedLogs,
          };
          return {};
        } catch (error) {
          return { error: errorMessage(error) };
        }
      }),
      ...next.collections.map((collection) => async () => {
        try {
          const result = await getOperatorApprovals(options.transport, {
            owner: next.owner,
            collection: collection.address,
            fromBlock,
            toBlock,
          });
          next = {
            ...next,
            operators: mergeLatest(next.operators, result.approvals, operatorKey),
            logsScanned: next.logsScanned + result.logsScanned,
            skippedLogs: next.skippedLogs + result.skippedLogs,
          };
          return {};
        } catch (error) {
          return { error: errorMessage(error) };
        }
      }),
    ];
    const outcomes = await runLimited(tasks, APPROVAL_SCAN_CONCURRENCY);
    const failure = outcomes.find((o) => o.error !== undefined);
    if (failure) {
      next = { ...next, refused: { fromBlock, toBlock, message: failure.error! } };
      break;
    }
    next = { ...next, scannedFromBlock: fromBlock, exhausted: fromBlock === 0n };
  }
  return next;
}

/**
 * First step of a scan from the current head. Throws only when the head
 * block itself cannot be read (the endpoint is unusable); window refusals
 * are recorded in the result instead.
 */
export async function startApprovalScan(
  options: ApprovalScanOptions & {
    owner: string;
    chainCaip2: string;
    tokens: ApprovalTokenRef[];
    collections: ApprovalCollectionRef[];
  },
): Promise<ApprovalScan> {
  const head = await options.transport('eth_blockNumber', []);
  if (typeof head !== 'string' || !/^0x[0-9a-fA-F]+$/.test(head)) {
    throw new Error('eth_blockNumber returned a malformed result');
  }
  const headBlock = BigInt(head);
  return scanStep(
    {
      chainCaip2: options.chainCaip2,
      owner: options.owner,
      headBlock,
      scannedFromBlock: headBlock + 1n,
      tokens: options.tokens,
      collections: options.collections,
      erc20: [],
      operators: [],
      logsScanned: 0,
      skippedLogs: 0,
      refused: null,
      exhausted: false,
    },
    options,
  );
}

/** One more step, below the range already scanned. */
export function extendApprovalScan(scan: ApprovalScan, options: ApprovalScanOptions): Promise<ApprovalScan> {
  return scanStep(scan, options);
}

/** Blocks fully scanned so far. */
export function scannedBlockCount(scan: ApprovalScan): bigint {
  return scan.headBlock + 1n - scan.scannedFromBlock;
}

/** "Searched blocks A–B (the last N blocks, about D days)." or the nothing-scanned sentence. */
export function scannedRangeNote(scan: ApprovalScan): string {
  const count = scannedBlockCount(scan);
  if (count <= 0n) return 'No blocks could be searched yet.';
  return (
    `Searched approval events in blocks ${scan.scannedFromBlock}–${scan.headBlock} ` +
    `(the last ${groupThousands(count.toString())} blocks, ${approxDuration(count)}).` +
    (scan.exhausted ? ' That is the whole history of this network.' : '')
  );
}

/** The plain-language explanation of a refused window. */
export function refusedNote(scan: ApprovalScan): string | null {
  if (!scan.refused) return null;
  return (
    `This RPC endpoint refused to search older blocks (${scan.refused.fromBlock}–` +
    `${scan.refused.toBlock}): ${scan.refused.message}. Approvals granted before the searched ` +
    'range are NOT shown. Free public endpoints keep only recent logs; an archive-capable ' +
    'endpoint (Settings → Network endpoints) can search further back.'
  );
}

// ---------------------------------------------------------------------------
// Live state (allowance() / isApprovedForAll re-read)
// ---------------------------------------------------------------------------

export type LiveState<T> = { status: 'ok'; value: T } | { status: 'error'; message: string };

interface ItemBase {
  /** Stable list key: "<contract>|<spender or operator>", lowercase. */
  key: string;
  chainCaip2: string;
  owner: string;
  /** Token or collection contract (EIP-55) — the revoke transaction's `to`. */
  contract: string;
  /** Block and transaction of the latest logged approval event. */
  loggedBlock: bigint;
  loggedTxHash: string;
}

export interface Erc20ApprovalItem extends ItemBase {
  kind: 'erc20';
  symbol: string;
  decimals: number;
  spender: string;
  /** Value set by the latest Approval log (history, not state). */
  loggedValue: bigint;
  /** allowance(owner, spender) right now. */
  live: LiveState<bigint>;
}

export interface OperatorApprovalItem extends ItemBase {
  kind: 'operator';
  title: string;
  operator: string;
  loggedApproved: boolean;
  /** isApprovedForAll(owner, operator) right now. */
  live: LiveState<boolean>;
}

export type ApprovalItem = Erc20ApprovalItem | OperatorApprovalItem;

/** The address that holds the approval (spender or operator). */
export function approvedAddress(item: ApprovalItem): string {
  return item.kind === 'erc20' ? item.spender : item.operator;
}

/**
 * Re-reads the current on-chain state of every discovered approval (the
 * engine's withCurrentAllowances for ERC-20, isApprovedForAll for operator
 * approvals), sequentially. A failed read is reported on that item only.
 */
export async function readLiveApprovals(
  transport: JsonRpcTransport,
  scan: ApprovalScan,
): Promise<ApprovalItem[]> {
  const tokenFor = (address: string) =>
    scan.tokens.find((t) => t.address.toLowerCase() === address.toLowerCase());
  const collectionFor = (address: string) =>
    scan.collections.find((c) => c.address.toLowerCase() === address.toLowerCase());

  const items: ApprovalItem[] = [];
  const current = await withCurrentAllowances(transport, scan.erc20);
  for (const record of current) {
    const token = tokenFor(record.token);
    if (!token) continue; // cannot happen: records only come from scanned tokens
    items.push({
      kind: 'erc20',
      key: erc20Key(record),
      chainCaip2: scan.chainCaip2,
      owner: record.owner,
      contract: record.token,
      symbol: token.symbol,
      decimals: token.decimals,
      spender: record.spender,
      loggedValue: record.value,
      loggedBlock: record.blockNumber,
      loggedTxHash: record.txHash,
      live: record.current.ok
        ? { status: 'ok', value: record.current.allowance }
        : { status: 'error', message: record.current.error },
    });
  }
  for (const record of scan.operators) {
    const collection = collectionFor(record.collection);
    if (!collection) continue;
    let live: LiveState<boolean>;
    try {
      live = {
        status: 'ok',
        value: await isApprovedForAll(transport, record.collection, record.owner, record.operator),
      };
    } catch (error) {
      live = { status: 'error', message: errorMessage(error) };
    }
    items.push({
      kind: 'operator',
      key: operatorKey(record),
      chainCaip2: scan.chainCaip2,
      owner: record.owner,
      contract: record.collection,
      title: collection.title,
      operator: record.operator,
      loggedApproved: record.approved,
      loggedBlock: record.blockNumber,
      loggedTxHash: record.txHash,
      live,
    });
  }
  return items;
}

/** True when the live state says the approval is in force right now. */
export function isActive(item: ApprovalItem): boolean {
  if (item.live.status !== 'ok') return false;
  return item.kind === 'erc20' ? (item.live.value as bigint) > 0n : item.live.value === true;
}

/** True when the LIVE allowance is exactly type(uint256).max. */
export function isUnlimitedNow(item: ApprovalItem): boolean {
  return item.kind === 'erc20' && item.live.status === 'ok' && item.live.value === MAX_UINT256;
}

export interface ApprovalPartition {
  /** Live state confirms the approval is in force. */
  active: ApprovalItem[];
  /** The live read failed: shown separately, never as active or revoked. */
  unconfirmed: ApprovalItem[];
  /** Live state is zero / false (revoked, or an allowance used up). */
  revoked: ApprovalItem[];
}

/**
 * Splits items by LIVE state only (the logged value never decides). Within
 * each group: by token/collection name, then contract, then spender.
 */
export function partitionApprovals(items: ApprovalItem[]): ApprovalPartition {
  const name = (i: ApprovalItem) => (i.kind === 'erc20' ? i.symbol : i.title);
  const sorted = [...items].sort(
    (a, b) =>
      name(a).localeCompare(name(b)) ||
      (a.contract.toLowerCase() < b.contract.toLowerCase() ? -1 : a.contract.toLowerCase() > b.contract.toLowerCase() ? 1 : 0) ||
      (approvedAddress(a).toLowerCase() < approvedAddress(b).toLowerCase() ? -1 : 1),
  );
  return {
    active: sorted.filter((i) => isActive(i)),
    unconfirmed: sorted.filter((i) => i.live.status === 'error'),
    revoked: sorted.filter((i) => i.live.status === 'ok' && !isActive(i)),
  };
}

/**
 * The allowance as shown: "Unlimited" exactly at type(uint256).max (the
 * engine's definition — no "effectively unlimited" threshold is applied
 * here), otherwise the exact amount in the token's decimals, never rounded.
 * With Hide amounts on, finite amounts are masked; "Unlimited" stays
 * visible because it is a risk marker, not a balance.
 */
export function formatAllowance(value: bigint, decimals: number, symbol: string, hidden: boolean): string {
  if (value === MAX_UINT256) return `Unlimited ${symbol}`;
  return `${maskAmount(groupThousands(formatUnits(value, decimals, decimals)), hidden)} ${symbol}`;
}

/** The amount/permission line of one item, from LIVE state. */
export function describeApprovalAmount(item: ApprovalItem, hidden: boolean): string {
  if (item.kind === 'operator') {
    if (item.live.status !== 'ok') return 'Current status could not be read';
    return item.live.value ? 'Can transfer ALL your items in this collection' : 'No longer approved';
  }
  if (item.live.status !== 'ok') {
    return (
      `Current allowance could not be read (last logged: ` +
      `${formatAllowance(item.loggedValue, item.decimals, item.symbol, hidden)})`
    );
  }
  return formatAllowance(item.live.value, item.decimals, item.symbol, hidden);
}

/** Why an item sits in the revoked section. */
export function revokedReason(item: ApprovalItem): string {
  if (item.kind === 'operator') return 'Revoked';
  return item.loggedValue === 0n
    ? 'Revoked'
    : 'Allowance used up or reduced to zero (tokens can lower an allowance without a new event)';
}

/** The Tether zero-first note, for Tether USD on mainnet only (the verified case). */
export function zeroFirstNoteFor(item: ApprovalItem): string | null {
  return item.kind === 'erc20' &&
    item.chainCaip2 === 'eip155:1' &&
    item.contract.toLowerCase() === USDT_MAINNET.toLowerCase()
    ? ZERO_FIRST_NOTE
    : null;
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/** approve(spender, 0) or setApprovalForAll(operator, false) calldata (engine encoders). */
export function revokeCalldata(item: ApprovalItem): Uint8Array {
  return item.kind === 'erc20'
    ? encodeErc20Revoke(item.spender)
    : encodeSetApprovalForAll(item.operator, false);
}

/** The change a successful revoke makes, in the preview's AssetChange shape. */
export function revokeAssetChange(item: ApprovalItem): AssetChange {
  return item.kind === 'erc20'
    ? {
        type: 'erc20-approval',
        callIndex: 0,
        token: item.contract,
        owner: item.owner,
        spender: item.spender,
        amount: 0n,
        unlimited: false,
      }
    : {
        type: 'approval-for-all',
        callIndex: 0,
        token: item.contract,
        owner: item.owner,
        operator: item.operator,
        approved: false,
      };
}

export interface RevokeQuote {
  item: ApprovalItem;
  /** Ordinary EVM quote: to = contract, amount 0, data = revoke calldata. */
  quote: EvmSendQuote;
  /**
   * ERC-20 only: the eth_call pre-flight returned a zero word, i.e. approve()
   * returned false without reverting (send-erc20.ts erc20TransferReturnedFalse
   * rule; empty return data, as Tether's approve gives, passes). Blocks like
   * a revert, behind the same override switch.
   */
  returnedFalse: boolean;
}

/**
 * Quotes a revoke through the existing prepareEvmSend. `expectedCaip2` is
 * the ACTIVE chain; the item must belong to it and `from` must be the
 * account that granted the approval, else nothing is quoted.
 */
export async function prepareRevoke(request: {
  url: string;
  from: string;
  item: ApprovalItem;
  expectedCaip2: string;
}): Promise<RevokeQuote> {
  const { url, from, item, expectedCaip2 } = request;
  if (item.chainCaip2 !== expectedCaip2) {
    throw new Error(
      `This approval is on ${item.chainCaip2}, but the wallet is on ${expectedCaip2}. Reload the list.`,
    );
  }
  if (item.owner.toLowerCase() !== from.toLowerCase()) {
    throw new Error('This approval belongs to a different account. Reload the list.');
  }
  const data = revokeCalldata(item);
  const quote = await prepareEvmSend(url, from, item.contract, 0n, data, expectedCaip2);
  const returnedFalse =
    item.kind === 'erc20' && quote.simulation.ok && erc20TransferReturnedFalse(quote.simulation.returnData);
  return { item, quote, returnedFalse };
}

/** Signs and broadcasts through the existing sendEvm (the only EVM signing path). */
export function sendRevoke(
  url: string,
  signer: DerivedAccount,
  revoke: RevokeQuote,
  explorerTxBase: string | null,
): Promise<SendResult> {
  return sendEvm(url, signer, revoke.quote, explorerTxBase);
}

// ---------------------------------------------------------------------------
// Spender display (contacts: exact match only)
// ---------------------------------------------------------------------------

export interface SpenderDisplay {
  /** Contact name when the address EXACTLY matches a saved contact, else null. */
  name: string | null;
  /** Always the full address (never shortened, never replaced by the name). */
  address: string;
  /** Code-based tag, shown only when there is no contact match (null = unknown). */
  tag: AddressTag | null;
}

/**
 * How a spender/operator is shown: a saved contact's name TOGETHER with the
 * full address on an exact match (contacts.ts findExactContact — full
 * 20-byte comparison, no prefix/suffix matching), otherwise the full
 * address with its classifyRecipient tag. No look-alike logic here; that
 * warning belongs to the send flow.
 */
export function spenderDisplay(
  networkId: string,
  address: string,
  contacts: readonly Contact[],
  tags: Readonly<Record<string, AddressTag | null>>,
): SpenderDisplay {
  const contact = findExactContact(networkId, address, contacts);
  if (contact) return { name: contact.name, address, tag: null };
  return { name: null, address, tag: tags[address.toLowerCase()] ?? null };
}

/** Convenience for the screen: the JSON-RPC transport the scan and live reads use. */
export function approvalsTransport(url: string): JsonRpcTransport {
  // simulationTransport keeps the JSON-RPC error message even on non-2xx
  // HTTP answers, so an endpoint's refusal reason reaches the user verbatim.
  return simulationTransport(url);
}

import { toChecksumAddress } from '@shiba-wallet/core';
import { encodeFunctionCall, selector } from './abi.js';
import { APPROVAL_EVENT_TOPIC, APPROVAL_FOR_ALL_EVENT_TOPIC, MAX_UINT256 } from './asset-diff.js';
import { bigintToHex, toBytes, toHex } from './encoding.js';
import { decodeUint256, encodeErc20Approve } from './erc20.js';
import { addressTopic } from './erc20-logs.js';
import type { JsonRpcTransport } from './rpc.js';

/**
 * Approvals-manager groundwork (phase 7, item 5): reconstructs which
 * spenders and operators an owner has approved, from plain eth_getLogs, and
 * builds the revoke calldata. Vendor-neutral: everything runs over the
 * injected JsonRpcTransport.
 *
 * Sources (fetched 2026-10-01):
 *  - ERC-20 (github.com/ethereum/ERCs, ERCS/erc-20.md):
 *      function approve(address _spender, uint256 _value) public returns (bool success)
 *      function allowance(address _owner, address _spender) public view returns (uint256 remaining)
 *      event Approval(address indexed _owner, address indexed _spender, uint256 _value)
 *    "MUST trigger on any successful call to approve(address _spender,
 *    uint256 _value)." The text requires the event for approve() only.
 *  - ERC-721 (ERCS/erc-721.md) and ERC-1155 (ERCS/erc-1155.md) declare the
 *    same operator interface:
 *      event ApprovalForAll(address indexed _owner, address indexed _operator, bool _approved);
 *      function setApprovalForAll(address _operator, bool _approved) external;
 *      function isApprovedForAll(address _owner, address _operator) external view returns (bool);
 *  - Solidity ABI specification (docs/abi-spec.rst): "bool: as in the uint8
 *    case, where 1 is used for true and 0 for false", and bool is the type
 *    name used when computing a function selector.
 *  - ethereum.org JSON-RPC documentation (eth_getLogs log objects):
 *    "logIndex: integer of the log index position in the block" and
 *    "removed: true when the log was removed, due to a chain
 *    reorganization". Because logIndex is block-wide, (blockNumber,
 *    logIndex) totally orders logs, which is what "latest approval wins"
 *    relies on.
 *
 * DESIGN CAVEAT — logs are history, not state. An Approval log records the
 * value set at that moment; the allowance can change afterwards WITHOUT a
 * new Approval event:
 *  - OpenZeppelin Contracts v5.4.0 ERC20.sol, transferFrom: "Skips emitting
 *    an {Approval} event indicating an allowance update. This is not
 *    required by the ERC." (_spendAllowance: "Does not emit an {Approval}
 *    event.") So every OpenZeppelin-v5 token spends allowances down silently.
 *  - Tether USD (0xdAC17F958D2ee523a2206206994597C13D831ec7, verified
 *    source on Etherscan, TetherToken, solc v0.4.18): transferFrom does
 *    `allowed[_from][msg.sender] = _allowance.sub(_value)` with no Approval
 *    event (and leaves MAX_UINT allowances untouched).
 * Therefore a UI must re-read allowance() (getErc20Allowance /
 * withCurrentAllowances) before presenting any approval as "active", and
 * should show the on-chain value, not the logged one. Approvals granted
 * through other mechanisms that do not emit the token's Approval event
 * (for example allowances held inside an intermediary contract such as a
 * Permit2-style allowance manager) are not visible here at all — design
 * note, not exhaustively verified per contract.
 *
 * UNLIMITED: `unlimited` is true exactly when the value is type(uint256).max
 * (MAX_UINT256, imported from asset-diff.ts so the definition is shared).
 * The engine does not define any "effectively unlimited" threshold for
 * large-but-finite values, and none is invented here.
 */

/** Matches the windowing used by getErc20Transfers callers: inclusive block ranges. */
export interface LogRangeQuery {
  fromBlock: bigint;
  toBlock: bigint;
  /**
   * Split [fromBlock, toBlock] into sequential inclusive windows of this
   * many blocks (public endpoints cap eth_getLogs ranges; ~10,000 blocks was
   * accepted by the free tier probed in erc20-logs.ts). Omit for one query.
   */
  windowBlocks?: bigint;
}

export interface Erc20ApprovalQuery extends LogRangeQuery {
  owner: string;
  token: string;
}

export interface OperatorApprovalQuery extends LogRangeQuery {
  owner: string;
  /** The ERC-721 or ERC-1155 collection contract. */
  collection: string;
}

interface LogPosition {
  txHash: string;
  blockNumber: bigint;
  /** Position of the log within its block (block-wide index). */
  logIndex: number;
}

export interface Erc20ApprovalRecord extends LogPosition {
  /** Token contract, EIP-55 checksummed. */
  token: string;
  owner: string;
  spender: string;
  /** Allowance set by the latest Approval log, in token base units. 0 = revoked. */
  value: bigint;
  /** True exactly when value is type(uint256).max. */
  unlimited: boolean;
}

export interface OperatorApprovalRecord extends LogPosition {
  /** Collection contract, EIP-55 checksummed. */
  collection: string;
  owner: string;
  operator: string;
  /** Latest logged state: true grants control of the whole collection, false revokes. */
  approved: boolean;
}

export interface ApprovalScanResult<T> {
  /**
   * The latest record per spender/operator in the scanned range, newest
   * first. Includes revocations (value 0 / approved false), so callers can
   * tell "revoked" from "never seen".
   */
  approvals: T[];
  /** Logs returned by the node across all windows. */
  logsScanned: number;
  /**
   * Logs that did not have the expected shape (malformed fields, wrong
   * topic count or data length, a different emitter or owner than
   * requested, or flagged `removed` by a reorg). Never guessed at; a
   * non-zero count means the picture may be incomplete. Note: a collection
   * queried with getErc20Approvals counts its ERC-721 per-token Approval
   * logs (four topics) here, since they share the ERC-20 topic0.
   */
  skippedLogs: number;
}

// ---------------------------------------------------------------------------
// Log plumbing
// ---------------------------------------------------------------------------

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;

function assertAddress(value: string, label: string): string {
  if (!ADDRESS.test(value)) throw new Error(`${label} is not a 20-byte hex address: ${value}`);
  return value.toLowerCase();
}

/**
 * Splits an inclusive block range into inclusive windows. Throws on an
 * empty or negative range or a non-positive window.
 */
export function blockWindows(
  fromBlock: bigint,
  toBlock: bigint,
  windowBlocks?: bigint,
): Array<[bigint, bigint]> {
  if (fromBlock < 0n || toBlock < fromBlock) {
    throw new Error(`Invalid block range ${fromBlock}..${toBlock}`);
  }
  if (windowBlocks === undefined) return [[fromBlock, toBlock]];
  if (windowBlocks <= 0n) throw new Error('windowBlocks must be positive');
  const windows: Array<[bigint, bigint]> = [];
  for (let start = fromBlock; start <= toBlock; start += windowBlocks) {
    const end = start + windowBlocks - 1n;
    windows.push([start, end < toBlock ? end : toBlock]);
  }
  return windows;
}

/**
 * Runs eth_getLogs over each window sequentially (not in parallel, to stay
 * inside public-endpoint rate limits) and concatenates the raw results.
 */
export async function getLogsWindowed(
  transport: JsonRpcTransport,
  filter: { address?: string | string[]; topics: (string | null)[] },
  range: LogRangeQuery,
): Promise<unknown[]> {
  const logs: unknown[] = [];
  for (const [from, to] of blockWindows(range.fromBlock, range.toBlock, range.windowBlocks)) {
    const result = await transport('eth_getLogs', [
      { ...filter, fromBlock: bigintToHex(from), toBlock: bigintToHex(to) },
    ]);
    if (!Array.isArray(result)) throw new Error('eth_getLogs returned a non-array result');
    logs.push(...result);
  }
  return logs;
}

/** The fields every log needs, validated; null when anything is off. */
export interface ValidLog extends LogPosition {
  /** Emitter, lowercase. */
  address: string;
  /** Lowercase 32-byte words. */
  topics: string[];
  /** Lowercase hex. */
  data: string;
}

/** Validates the envelope of one eth_getLogs entry. Reorged-out logs return null. */
export function validateLog(raw: unknown): ValidLog | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const log = raw as Record<string, unknown>;
  if (log.removed === true) return null;
  const { transactionHash, blockNumber, logIndex, address, topics, data } = log;
  if (typeof transactionHash !== 'string' || !WORD.test(transactionHash)) return null;
  if (typeof blockNumber !== 'string' || !QUANTITY.test(blockNumber)) return null;
  if (typeof logIndex !== 'string' || !QUANTITY.test(logIndex)) return null;
  if (typeof address !== 'string' || !ADDRESS.test(address)) return null;
  if (!Array.isArray(topics) || !topics.every((t) => typeof t === 'string' && WORD.test(t))) {
    return null;
  }
  if (typeof data !== 'string' || !HEX.test(data) || data.length % 2 !== 0) return null;
  const index = Number(BigInt(logIndex));
  if (!Number.isSafeInteger(index)) return null;
  return {
    txHash: transactionHash.toLowerCase(),
    blockNumber: BigInt(blockNumber),
    logIndex: index,
    address: address.toLowerCase(),
    topics: (topics as string[]).map((t) => t.toLowerCase()),
    data: data.toLowerCase(),
  };
}

/** Lowercase address from an address topic (top 12 bytes zero), else null. */
export function topicToLowerAddress(topic: string): string | null {
  const hex = topic.slice(2).toLowerCase();
  if (hex.length !== 64 || !/^0{24}/.test(hex)) return null;
  return '0x' + hex.slice(24);
}

function checksum(lowerAddress: string): string {
  return toChecksumAddress(toBytes(lowerAddress));
}

/** True when a is later on chain than b. */
function isLater(a: LogPosition, b: LogPosition): boolean {
  return a.blockNumber === b.blockNumber ? a.logIndex > b.logIndex : a.blockNumber > b.blockNumber;
}

function newestFirst<T extends LogPosition>(records: Iterable<T>): T[] {
  return [...records].sort((a, b) => (isLater(a, b) ? -1 : isLater(b, a) ? 1 : 0));
}

// ---------------------------------------------------------------------------
// ERC-20 approvals
// ---------------------------------------------------------------------------

/**
 * Approval(owner, spender, value) logs emitted by `token` for `owner` in the
 * range, reduced to the latest record per spender (later block wins; within
 * a block, higher logIndex wins). See the module caveat: the result is the
 * last LOGGED value, and must be confirmed with getErc20Allowance.
 */
export async function getErc20Approvals(
  transport: JsonRpcTransport,
  query: Erc20ApprovalQuery,
): Promise<ApprovalScanResult<Erc20ApprovalRecord>> {
  const owner = assertAddress(query.owner, 'owner');
  const token = assertAddress(query.token, 'token');
  const raw = await getLogsWindowed(
    transport,
    { address: token, topics: [APPROVAL_EVENT_TOPIC, addressTopic(owner)] },
    query,
  );

  const latest = new Map<string, Erc20ApprovalRecord>();
  let skippedLogs = 0;
  for (const entry of raw) {
    const log = validateLog(entry);
    const ownerOf = log && log.topics[1] ? topicToLowerAddress(log.topics[1]) : null;
    const spender = log && log.topics[2] ? topicToLowerAddress(log.topics[2]) : null;
    if (
      !log ||
      log.topics.length !== 3 ||
      log.topics[0] !== APPROVAL_EVENT_TOPIC ||
      log.address !== token ||
      ownerOf !== owner ||
      !spender ||
      log.data.length !== 66 // exactly one 32-byte word
    ) {
      skippedLogs += 1;
      continue;
    }
    const value = BigInt(log.data);
    const record: Erc20ApprovalRecord = {
      txHash: log.txHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      token: checksum(token),
      owner: checksum(owner),
      spender: checksum(spender),
      value,
      unlimited: value === MAX_UINT256,
    };
    const previous = latest.get(spender);
    if (!previous || isLater(record, previous)) latest.set(spender, record);
  }
  return { approvals: newestFirst(latest.values()), logsScanned: raw.length, skippedLogs };
}

/** allowance(address,address) — signature from the ERC-20 text. */
export const ERC20_ALLOWANCE_SIGNATURE = 'allowance(address,address)';

/** allowance(owner, spender) eth_call payload. */
export function encodeErc20Allowance(owner: string, spender: string): Uint8Array {
  return encodeFunctionCall(ERC20_ALLOWANCE_SIGNATURE, [
    { kind: 'address', value: owner },
    { kind: 'address', value: spender },
  ]);
}

/**
 * The on-chain allowance via eth_call — the value a UI must show, since
 * transferFrom can reduce it without emitting Approval (module caveat).
 * Throws when the call does not return exactly one 32-byte word (for
 * example an address with no code returns "0x").
 */
export async function getErc20Allowance(
  transport: JsonRpcTransport,
  token: string,
  owner: string,
  spender: string,
  blockTag = 'latest',
): Promise<bigint> {
  assertAddress(token, 'token');
  const result = await transport('eth_call', [
    { to: token, data: toHex(encodeErc20Allowance(owner, spender)) },
    blockTag,
  ]);
  if (typeof result !== 'string') throw new Error('eth_call returned a non-string result');
  try {
    return decodeUint256(result);
  } catch {
    throw new Error(
      `allowance() on ${token} returned ${(result.length - 2) / 2} bytes, not one uint256 word; ` +
        'the address may not be an ERC-20 token',
    );
  }
}

export type CurrentAllowance =
  | { ok: true; allowance: bigint; unlimited: boolean }
  | { ok: false; error: string };

/**
 * Re-reads allowance() for each logged record, sequentially. A failed read
 * is reported per record rather than failing the whole list, and never
 * replaced by the logged value.
 */
export async function withCurrentAllowances(
  transport: JsonRpcTransport,
  records: Erc20ApprovalRecord[],
  blockTag = 'latest',
): Promise<Array<Erc20ApprovalRecord & { current: CurrentAllowance }>> {
  const out: Array<Erc20ApprovalRecord & { current: CurrentAllowance }> = [];
  for (const record of records) {
    let current: CurrentAllowance;
    try {
      const allowance = await getErc20Allowance(
        transport,
        record.token,
        record.owner,
        record.spender,
        blockTag,
      );
      current = { ok: true, allowance, unlimited: allowance === MAX_UINT256 };
    } catch (error) {
      current = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    out.push({ ...record, current });
  }
  return out;
}

/**
 * Revoke calldata: approve(spender, 0), built by encodeErc20Approve.
 *
 * Tokens that refuse to change a non-zero allowance to another non-zero
 * value accept this call: Tether USD's approve (verified Etherscan source)
 * reads "To change the approve amount you first have to reduce the
 * addresses` allowance to zero by calling `approve(_spender, 0)` if it is
 * not already 0" and enforces
 * `require(!((_value != 0) && (allowed[msg.sender][_spender] != 0)))`.
 * The ERC-20 text recommends the same zero-first pattern to user
 * interfaces, while saying the contract itself should not enforce it. So a
 * revoke always succeeds against that rule, and a later non-zero re-approve
 * on such a token must be preceded by this call. Note also that Tether's
 * approve declares no return value (unlike the ERC-20 `returns (bool)`), so
 * callers must accept empty return data from it.
 */
export function encodeErc20Revoke(spender: string): Uint8Array {
  return encodeErc20Approve(spender, 0n);
}

// ---------------------------------------------------------------------------
// ERC-721 / ERC-1155 operator approvals
// ---------------------------------------------------------------------------

export const SET_APPROVAL_FOR_ALL_SIGNATURE = 'setApprovalForAll(address,bool)';
/** keccak256("setApprovalForAll(address,bool)")[0:4], computed; pinned against ethers in tests. */
export const SET_APPROVAL_FOR_ALL_SELECTOR: Uint8Array = selector(SET_APPROVAL_FOR_ALL_SIGNATURE);

export const IS_APPROVED_FOR_ALL_SIGNATURE = 'isApprovedForAll(address,address)';
/** keccak256("isApprovedForAll(address,address)")[0:4], computed; pinned against ethers in tests. */
export const IS_APPROVED_FOR_ALL_SELECTOR: Uint8Array = selector(IS_APPROVED_FOR_ALL_SIGNATURE);

/**
 * setApprovalForAll(operator, approved) calldata. A bool is ABI-encoded as
 * a uint256 word holding 0 or 1. Revoking is `approved = false`.
 */
export function encodeSetApprovalForAll(operator: string, approved: boolean): Uint8Array {
  return encodeFunctionCall(SET_APPROVAL_FOR_ALL_SIGNATURE, [
    { kind: 'address', value: operator },
    { kind: 'uint256', value: approved ? 1n : 0n },
  ]);
}

/** isApprovedForAll(owner, operator) eth_call payload. */
export function encodeIsApprovedForAll(owner: string, operator: string): Uint8Array {
  return encodeFunctionCall(IS_APPROVED_FOR_ALL_SIGNATURE, [
    { kind: 'address', value: owner },
    { kind: 'address', value: operator },
  ]);
}

/**
 * The on-chain operator status via eth_call. Throws unless the result is a
 * single word holding exactly 0 or 1.
 */
export async function isApprovedForAll(
  transport: JsonRpcTransport,
  collection: string,
  owner: string,
  operator: string,
  blockTag = 'latest',
): Promise<boolean> {
  assertAddress(collection, 'collection');
  const result = await transport('eth_call', [
    { to: collection, data: toHex(encodeIsApprovedForAll(owner, operator)) },
    blockTag,
  ]);
  if (typeof result !== 'string' || !WORD.test(result)) {
    throw new Error(`isApprovedForAll() on ${collection} did not return one 32-byte word`);
  }
  const flag = BigInt(result);
  if (flag !== 0n && flag !== 1n) {
    throw new Error(`isApprovedForAll() on ${collection} returned a non-boolean word`);
  }
  return flag === 1n;
}

/**
 * ApprovalForAll(owner, operator, approved) logs emitted by `collection`
 * for `owner`, reduced to the latest record per operator. The topic is the
 * one asset-diff.ts computes (APPROVAL_FOR_ALL_EVENT_TOPIC). Confirm with
 * isApprovedForAll before presenting an operator as active.
 */
export async function getOperatorApprovals(
  transport: JsonRpcTransport,
  query: OperatorApprovalQuery,
): Promise<ApprovalScanResult<OperatorApprovalRecord>> {
  const owner = assertAddress(query.owner, 'owner');
  const collection = assertAddress(query.collection, 'collection');
  const raw = await getLogsWindowed(
    transport,
    { address: collection, topics: [APPROVAL_FOR_ALL_EVENT_TOPIC, addressTopic(owner)] },
    query,
  );

  const latest = new Map<string, OperatorApprovalRecord>();
  let skippedLogs = 0;
  for (const entry of raw) {
    const log = validateLog(entry);
    const ownerOf = log && log.topics[1] ? topicToLowerAddress(log.topics[1]) : null;
    const operator = log && log.topics[2] ? topicToLowerAddress(log.topics[2]) : null;
    const flag = log && log.data.length === 66 ? BigInt(log.data) : null;
    if (
      !log ||
      log.topics.length !== 3 ||
      log.topics[0] !== APPROVAL_FOR_ALL_EVENT_TOPIC ||
      log.address !== collection ||
      ownerOf !== owner ||
      !operator ||
      (flag !== 0n && flag !== 1n) // not an ABI bool
    ) {
      skippedLogs += 1;
      continue;
    }
    const record: OperatorApprovalRecord = {
      txHash: log.txHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      collection: checksum(collection),
      owner: checksum(owner),
      operator: checksum(operator),
      approved: flag === 1n,
    };
    const previous = latest.get(operator);
    if (!previous || isLater(record, previous)) latest.set(operator, record);
  }
  return { approvals: newestFirst(latest.values()), logsScanned: raw.length, skippedLogs };
}

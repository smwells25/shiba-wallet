import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { bigintToHex, toHex } from './encoding.js';
import type { JsonRpcTransport } from './rpc.js';
import { decodeRevertReason } from './simulate.js';

/**
 * Asset-diff simulation (completes phase-2 task 6): predicts which balances
 * a prospective transaction changes for the wallet, by simulating it with
 * the standard `eth_simulateV1` JSON-RPC method and decoding the token
 * standard events it emits.
 *
 * Why the standard method and not a vendor API: the originally planned
 * vendor method (alchemy_simulateAssetChanges) carries a deprecation notice
 * for 2026-09-30 on its own reference page, whereas eth_simulateV1 is part
 * of the Ethereum execution-apis specification and is served by ordinary
 * node endpoints (live-probed 2026-09-28 on ethereum-rpc.publicnode.com,
 * ethereum-sepolia-rpc.publicnode.com and Alchemy mainnet/Sepolia).
 *
 * Specification sources (ethereum/execution-apis, main branch, read
 * 2026-09-28):
 *  - src/eth/execute.yaml, method `eth_simulateV1`: params are
 *    [EthSimulatePayload, block tag (optional, default 'latest')]; the
 *    result is an array of simulated blocks.
 *  - src/schemas/execute.yaml:
 *    * EthSimulatePayload { blockStateCalls (required), traceTransfers,
 *      validation, returnFullTransactions }.
 *    * traceTransfers: "Adds ETH transfers as ERC20 transfer events to the
 *      logs. These transfers have emitter contract parameter set as
 *      address(0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)."
 *    * validation (default false): "When false, eth_simulateV1 behaves like
 *      eth_call." This module deliberately leaves it at the default, so
 *      fees are not charged (maxFeePerGas defaults to 0) and the preview
 *      shows value movements only; the network fee is displayed separately
 *      by the confirm screens.
 *    * GenericCallTransaction: from, to, value, input (calldata is named
 *      `input` in the schema), gas, fee fields — all optional.
 *    * EthSimulateBlockResultSingleSuccess: a Block plus `calls`, an array
 *      of CallResultSuccess { status "0x1", returnData, gasUsed, logs[] } or
 *      CallResultFailure { status "0x0", returnData, gasUsed, error
 *      { code 3 "execution reverted…" | -32015 "vm execution error…" } }.
 *      Observed live on geth-based nodes: a reverted call reports
 *      returnData "0x" and carries the revert payload in error.data, so
 *      both places are checked.
 *
 * PREVIEW, NOT A GUARANTEE: the simulation runs against the state of the
 * requested block ('latest'). Anything that changes before the real
 * transaction is included (prices, balances, allowances, contract state)
 * can change the outcome. Callers must present the result as a preview,
 * and the eth_call revert gate (./simulate.ts) stays the blocking check.
 *
 * TRUST MODEL: token events are emitted by the contracts themselves, so a
 * malicious contract can emit events that do not correspond to real
 * balance movements (e.g. a fake "Transfer" claiming the wallet receives
 * tokens). Every change therefore carries the emitting contract address,
 * and UIs must identify tokens by that address, not by a self-reported
 * symbol. The native-ETH pseudo-events cannot be forged this way: they are
 * synthesized by the node at the 0xeeee… address, which no deployed
 * contract occupies.
 */

// ---------------------------------------------------------------------------
// Event topics — computed with keccak256 over the canonical signatures.
// ---------------------------------------------------------------------------

function eventTopic(signature: string): string {
  return toHex(keccak_256(utf8ToBytes(signature)));
}

/**
 * ERC-20 `Transfer(address indexed _from, address indexed _to, uint256
 * _value)` (EIP-20) and ERC-721 `Transfer(address indexed _from, address
 * indexed _to, uint256 indexed _tokenId)` (EIP-721) share this topic0; they
 * are told apart by topic count (3 vs 4) and data length (32 vs 0 bytes).
 */
export const TRANSFER_EVENT_TOPIC = eventTopic('Transfer(address,address,uint256)');

/**
 * ERC-20 `Approval(address indexed _owner, address indexed _spender,
 * uint256 _value)` (EIP-20) and ERC-721 `Approval(address indexed _owner,
 * address indexed _approved, uint256 indexed _tokenId)` (EIP-721) share
 * this topic0; same topic-count/data-length distinction as Transfer.
 */
export const APPROVAL_EVENT_TOPIC = eventTopic('Approval(address,address,uint256)');

/**
 * `ApprovalForAll(address indexed _owner, address indexed _operator, bool
 * _approved)` — identical declaration in EIP-721 and EIP-1155.
 */
export const APPROVAL_FOR_ALL_EVENT_TOPIC = eventTopic('ApprovalForAll(address,address,bool)');

/**
 * ERC-1155 `TransferSingle(address indexed _operator, address indexed
 * _from, address indexed _to, uint256 _id, uint256 _value)` (EIP-1155).
 */
export const TRANSFER_SINGLE_EVENT_TOPIC = eventTopic(
  'TransferSingle(address,address,address,uint256,uint256)',
);

/**
 * ERC-1155 `TransferBatch(address indexed _operator, address indexed
 * _from, address indexed _to, uint256[] _ids, uint256[] _values)`
 * (EIP-1155).
 */
export const TRANSFER_BATCH_EVENT_TOPIC = eventTopic(
  'TransferBatch(address,address,address,uint256[],uint256[])',
);

/** Emitter address of the traceTransfers ETH pseudo-events (schemas/execute.yaml). */
export const NATIVE_TRANSFER_PSEUDO_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** type(uint256).max — the conventional "unlimited" ERC-20 allowance. */
export const MAX_UINT256 = (1n << 256n) - 1n;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Direction relative to the wallet: out = wallet sends, in = wallet receives. */
export type AssetChangeDirection = 'out' | 'in' | 'self';

interface ChangeBase {
  /** Index of the simulated call that produced the change. */
  callIndex: number;
}

/**
 * One wallet-relevant balance or permission change. Addresses are EIP-55
 * checksummed; amounts and ids are exact bigints read from the event
 * words (never from floats, never rounded).
 */
export type AssetChange =
  | (ChangeBase & {
      type: 'native';
      direction: AssetChangeDirection;
      from: string;
      to: string;
      /** Wei. */
      amount: bigint;
    })
  | (ChangeBase & {
      type: 'erc20';
      direction: AssetChangeDirection;
      /** Emitting token contract. */
      token: string;
      from: string;
      to: string;
      /** Token base units (decimals are not part of the event). */
      amount: bigint;
    })
  | (ChangeBase & {
      type: 'erc721';
      direction: AssetChangeDirection;
      token: string;
      from: string;
      to: string;
      tokenId: bigint;
    })
  | (ChangeBase & {
      type: 'erc1155';
      direction: AssetChangeDirection;
      token: string;
      operator: string;
      from: string;
      to: string;
      tokenId: bigint;
      amount: bigint;
    })
  | (ChangeBase & {
      type: 'erc20-approval';
      token: string;
      owner: string;
      spender: string;
      /** New allowance in token base units (0 = revoked). */
      amount: bigint;
      /** True exactly when amount is type(uint256).max. */
      unlimited: boolean;
    })
  | (ChangeBase & {
      type: 'erc721-approval';
      token: string;
      owner: string;
      /** Newly approved address; the zero address clears the approval. */
      approved: string;
      tokenId: bigint;
    })
  | (ChangeBase & {
      type: 'approval-for-all';
      /** Collection (ERC-721 or ERC-1155 contract). */
      token: string;
      owner: string;
      operator: string;
      /** True grants control of every token in the collection; false revokes. */
      approved: boolean;
    });

/** One call to simulate, as the wallet would send it. */
export interface AssetDiffCall {
  from: string;
  to: string;
  value?: bigint;
  data?: Uint8Array;
}

export interface SimulatedCallOutcome {
  ok: boolean;
  gasUsed?: bigint;
  /** Human-readable revert reason for a failed call. */
  revertReason?: string;
}

export interface AssetDiffResult {
  /** True when every simulated call succeeded. */
  ok: boolean;
  /** Per-call outcomes, in request order. */
  calls: SimulatedCallOutcome[];
  /**
   * Wallet-relevant changes from SUCCESSFUL calls only (a reverted call's
   * state changes and logs are discarded, exactly as on-chain).
   */
  changes: AssetChange[];
  /**
   * Logs that were structurally malformed, or that used a known token-event
   * topic with a non-standard shape (e.g. pre-ERC-721 NFTs that emit an
   * unindexed Transfer). They are never guessed at; a non-zero count means
   * the preview may be incomplete and UIs should say so.
   */
  skippedLogs: number;
}

/**
 * The endpoint does not serve eth_simulateV1 (method not found), or its
 * response does not have the specified shape. UIs show an "unavailable"
 * note rather than an error.
 */
export class SimulationUnsupportedError extends Error {
  readonly reason: 'method-not-found' | 'malformed-response';
  constructor(reason: 'method-not-found' | 'malformed-response', detail: string) {
    super(detail);
    this.name = 'SimulationUnsupportedError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 "Method not found" error code. */
const METHOD_NOT_FOUND = -32601;

/**
 * Recognizes "this endpoint does not implement the method" across the
 * shapes seen in practice:
 *  - a structured error with code -32601 (JSON-RPC 2.0 spec; observed live
 *    from publicnode: {"code":-32601,"message":"Method not found"});
 *  - httpTransport's thrown message "RPC error -32601: …";
 *  - vendor wording such as Alchemy's "Unsupported method: <name> on
 *    <network>" (observed live, delivered with code -32600 and HTTP 400) or
 *    "the method <name> does not exist/is not available".
 */
export function isMethodNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === METHOD_NOT_FOUND) return true;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  if (/RPC error -32601\b/.test(message)) return true;
  return /method not found|unsupported method|method .{0,80}(does not exist|is not available|not supported)/i.test(
    message,
  );
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const HEX = /^0x[0-9a-fA-F]*$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

interface RawLog {
  address: string;
  topics: string[];
  data: string;
}

function isRawLog(value: unknown): value is RawLog {
  if (typeof value !== 'object' || value === null) return false;
  const log = value as { address?: unknown; topics?: unknown; data?: unknown };
  return (
    typeof log.address === 'string' &&
    ADDRESS.test(log.address) &&
    Array.isArray(log.topics) &&
    log.topics.every((t) => typeof t === 'string' && WORD.test(t)) &&
    typeof log.data === 'string' &&
    HEX.test(log.data) &&
    log.data.length % 2 === 0
  );
}

/** An address topic: 32 bytes whose top 12 bytes are zero. Null otherwise. */
function topicAddress(topic: string): string | null {
  const hex = topic.slice(2).toLowerCase();
  if (!/^0{24}/.test(hex)) return null;
  return '0x' + hex.slice(24);
}

function checksum(lowerAddress: string): string {
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = parseInt(lowerAddress.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return toChecksumAddress(bytes);
}

/** Splits event data into 32-byte words, or null when not word-aligned. */
function dataWords(data: string): bigint[] | null {
  const hex = data.slice(2);
  if (hex.length % 64 !== 0) return null;
  const words: bigint[] = [];
  for (let i = 0; i < hex.length; i += 64) words.push(BigInt('0x' + hex.slice(i, i + 64)));
  return words;
}

function direction(from: string, to: string, me: string): AssetChangeDirection | null {
  if (from === me && to === me) return 'self';
  if (from === me) return 'out';
  if (to === me) return 'in';
  return null;
}

/**
 * Decodes an ABI-encoded (uint256[], uint256[]) pair — TransferBatch's
 * unindexed data — with strict bounds checks. Null on any inconsistency.
 */
function decodeTwoUintArrays(words: bigint[]): [bigint[], bigint[]] | null {
  if (words.length < 2) return null;
  const readArray = (offsetBytes: bigint): bigint[] | null => {
    if (offsetBytes % 32n !== 0n) return null;
    const start = offsetBytes / 32n;
    if (start >= BigInt(words.length)) return null;
    const length = words[Number(start)]!;
    if (start + 1n + length > BigInt(words.length)) return null;
    const first = Number(start) + 1;
    return words.slice(first, first + Number(length));
  };
  const ids = readArray(words[0]!);
  const values = readArray(words[1]!);
  if (!ids || !values || ids.length !== values.length) return null;
  return [ids, values];
}

type Decoded = { kind: 'changes'; changes: AssetChange[] } | { kind: 'ignored' } | { kind: 'skipped' };

const IGNORED: Decoded = { kind: 'ignored' };
const SKIPPED: Decoded = { kind: 'skipped' };

/**
 * Decodes one log into wallet-relevant changes. Unknown events are
 * `ignored` (swaps, syncs … are normal); known token-event topics with a
 * non-standard shape are `skipped` and counted, never guessed at.
 */
function decodeLog(log: RawLog, me: string, callIndex: number): Decoded {
  const topic0 = log.topics[0]?.toLowerCase();
  if (topic0 === undefined) return IGNORED;
  const emitter = log.address.toLowerCase();
  const n = log.topics.length;
  const dataBytes = (log.data.length - 2) / 2;

  if (topic0 === TRANSFER_EVENT_TOPIC) {
    const from = log.topics[1] ? topicAddress(log.topics[1]) : null;
    const to = log.topics[2] ? topicAddress(log.topics[2]) : null;
    if (n === 3 && dataBytes === 32 && from && to) {
      const dir = direction(from, to, me);
      if (!dir) return IGNORED;
      const amount = BigInt(log.data);
      if (emitter === NATIVE_TRANSFER_PSEUDO_ADDRESS) {
        return {
          kind: 'changes',
          changes: [
            { type: 'native', callIndex, direction: dir, from: checksum(from), to: checksum(to), amount },
          ],
        };
      }
      return {
        kind: 'changes',
        changes: [
          {
            type: 'erc20',
            callIndex,
            direction: dir,
            token: checksum(emitter),
            from: checksum(from),
            to: checksum(to),
            amount,
          },
        ],
      };
    }
    if (n === 4 && dataBytes === 0 && from && to && emitter !== NATIVE_TRANSFER_PSEUDO_ADDRESS) {
      const dir = direction(from, to, me);
      if (!dir) return IGNORED;
      return {
        kind: 'changes',
        changes: [
          {
            type: 'erc721',
            callIndex,
            direction: dir,
            token: checksum(emitter),
            from: checksum(from),
            to: checksum(to),
            tokenId: BigInt(log.topics[3]!),
          },
        ],
      };
    }
    return SKIPPED;
  }

  if (topic0 === APPROVAL_EVENT_TOPIC) {
    const owner = log.topics[1] ? topicAddress(log.topics[1]) : null;
    const spender = log.topics[2] ? topicAddress(log.topics[2]) : null;
    if (n === 3 && dataBytes === 32 && owner && spender) {
      if (owner !== me) return IGNORED;
      const amount = BigInt(log.data);
      return {
        kind: 'changes',
        changes: [
          {
            type: 'erc20-approval',
            callIndex,
            token: checksum(emitter),
            owner: checksum(owner),
            spender: checksum(spender),
            amount,
            unlimited: amount === MAX_UINT256,
          },
        ],
      };
    }
    if (n === 4 && dataBytes === 0 && owner && spender) {
      if (owner !== me) return IGNORED;
      return {
        kind: 'changes',
        changes: [
          {
            type: 'erc721-approval',
            callIndex,
            token: checksum(emitter),
            owner: checksum(owner),
            approved: checksum(spender),
            tokenId: BigInt(log.topics[3]!),
          },
        ],
      };
    }
    return SKIPPED;
  }

  if (topic0 === APPROVAL_FOR_ALL_EVENT_TOPIC) {
    const owner = log.topics[1] ? topicAddress(log.topics[1]) : null;
    const operator = log.topics[2] ? topicAddress(log.topics[2]) : null;
    const words = dataWords(log.data);
    if (n !== 3 || !owner || !operator || !words || words.length !== 1) return SKIPPED;
    const flag = words[0]!;
    if (flag !== 0n && flag !== 1n) return SKIPPED; // not an ABI bool
    if (owner !== me) return IGNORED;
    return {
      kind: 'changes',
      changes: [
        {
          type: 'approval-for-all',
          callIndex,
          token: checksum(emitter),
          owner: checksum(owner),
          operator: checksum(operator),
          approved: flag === 1n,
        },
      ],
    };
  }

  if (topic0 === TRANSFER_SINGLE_EVENT_TOPIC || topic0 === TRANSFER_BATCH_EVENT_TOPIC) {
    const operator = log.topics[1] ? topicAddress(log.topics[1]) : null;
    const from = log.topics[2] ? topicAddress(log.topics[2]) : null;
    const to = log.topics[3] ? topicAddress(log.topics[3]) : null;
    const words = dataWords(log.data);
    if (n !== 4 || !operator || !from || !to || !words) return SKIPPED;
    let pairs: [bigint, bigint][];
    if (topic0 === TRANSFER_SINGLE_EVENT_TOPIC) {
      if (words.length !== 2) return SKIPPED;
      pairs = [[words[0]!, words[1]!]];
    } else {
      const arrays = decodeTwoUintArrays(words);
      if (!arrays) return SKIPPED;
      pairs = arrays[0].map((id, i) => [id, arrays[1][i]!]);
    }
    const dir = direction(from, to, me);
    if (!dir) return IGNORED;
    return {
      kind: 'changes',
      changes: pairs.map(([tokenId, amount]) => ({
        type: 'erc1155' as const,
        callIndex,
        direction: dir,
        token: checksum(emitter),
        operator: checksum(operator),
        from: checksum(from),
        to: checksum(to),
        tokenId,
        amount,
      })),
    };
  }

  return IGNORED;
}

function revertReasonOf(call: Record<string, unknown>): string {
  const error = call.error as { data?: unknown; message?: unknown } | undefined;
  const errorData = error?.data;
  if (typeof errorData === 'string' && HEX.test(errorData) && errorData.length > 2) {
    return decodeRevertReason(errorData);
  }
  const returnData = call.returnData;
  if (typeof returnData === 'string' && HEX.test(returnData) && returnData.length > 2) {
    return decodeRevertReason(returnData);
  }
  if (typeof error?.message === 'string' && error.message !== '') return error.message;
  return 'reverted without a reason';
}

function parseQuantity(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return undefined;
  return BigInt(value);
}

/**
 * Parses an eth_simulateV1 result for `expectedCalls` calls in a single
 * simulated block. Throws SimulationUnsupportedError('malformed-response')
 * when the top-level shape is not the specified one; individual malformed
 * logs are skipped and counted instead.
 */
export function parseSimulationResult(
  result: unknown,
  expectedCalls: number,
  wallet: string,
): AssetDiffResult {
  function malformed(detail: string): never {
    throw new SimulationUnsupportedError(
      'malformed-response',
      `eth_simulateV1 returned an unrecognized response (${detail}).`,
    );
  }
  if (!Array.isArray(result) || result.length < 1) malformed('expected a non-empty array of blocks');
  const block = (result as unknown[])[0];
  if (typeof block !== 'object' || block === null) malformed('block is not an object');
  const rawCalls = (block as { calls?: unknown }).calls;
  if (!Array.isArray(rawCalls)) malformed('block has no calls array');
  if ((rawCalls as unknown[]).length !== expectedCalls) {
    malformed(`expected ${expectedCalls} call results, got ${(rawCalls as unknown[]).length}`);
  }

  const me = wallet.toLowerCase();
  const calls: SimulatedCallOutcome[] = [];
  const changes: AssetChange[] = [];
  let skippedLogs = 0;

  (rawCalls as unknown[]).forEach((raw, callIndex) => {
    if (typeof raw !== 'object' || raw === null) malformed(`call ${callIndex} is not an object`);
    const call = raw as Record<string, unknown>;
    const status = parseQuantity(call.status);
    if (status !== 0n && status !== 1n) malformed(`call ${callIndex} has no valid status`);
    const gasUsed = parseQuantity(call.gasUsed);
    if (status === 0n) {
      // Reverted: state changes and logs are discarded, as on-chain.
      calls.push({
        ok: false,
        revertReason: revertReasonOf(call),
        ...(gasUsed !== undefined ? { gasUsed } : {}),
      });
      return;
    }
    calls.push({ ok: true, ...(gasUsed !== undefined ? { gasUsed } : {}) });
    const logs = call.logs;
    if (!Array.isArray(logs)) malformed(`call ${callIndex} succeeded without a logs array`);
    for (const log of logs as unknown[]) {
      if (!isRawLog(log)) {
        skippedLogs += 1;
        continue;
      }
      const decoded = decodeLog(log, me, callIndex);
      if (decoded.kind === 'changes') changes.push(...decoded.changes);
      else if (decoded.kind === 'skipped') skippedLogs += 1;
    }
  });

  return { ok: calls.every((c) => c.ok), calls, changes, skippedLogs };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function toCallObject(call: AssetDiffCall): Record<string, string> {
  const object: Record<string, string> = { from: call.from, to: call.to };
  if (call.value !== undefined) object.value = bigintToHex(call.value);
  // The schema names calldata `input` (GenericCallTransaction); geth-based
  // nodes also accept `data`, but the specified field is used.
  if (call.data !== undefined && call.data.length > 0) object.input = toHex(call.data);
  return object;
}

export interface AssetDiffOptions {
  /** Block to simulate on top of; default 'latest'. */
  blockTag?: string;
}

/**
 * Simulates `calls` in order (each builds on the previous one's state, per
 * the spec) in one block on top of `blockTag`, and returns the changes
 * relevant to `wallet`: transfers where it is sender or recipient, and
 * approvals where it is the owner.
 *
 * Throws SimulationUnsupportedError when the endpoint lacks the method or
 * answers with an unrecognized shape. Any other transport error (network
 * failure, rate limit, a top-level simulation error such as -38014
 * "insufficient funds … value") propagates unchanged so the caller can show
 * its message.
 */
export async function simulateAssetChanges(
  transport: JsonRpcTransport,
  calls: AssetDiffCall[],
  wallet: string,
  options: AssetDiffOptions = {},
): Promise<AssetDiffResult> {
  if (calls.length === 0) throw new Error('Nothing to simulate: no calls given');
  if (!ADDRESS.test(wallet)) throw new Error(`Not an address: ${wallet}`);
  const payload = {
    blockStateCalls: [{ calls: calls.map(toCallObject) }],
    traceTransfers: true,
  };
  let result: unknown;
  try {
    result = await transport('eth_simulateV1', [payload, options.blockTag ?? 'latest']);
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      throw new SimulationUnsupportedError(
        'method-not-found',
        'This RPC endpoint does not support eth_simulateV1.',
      );
    }
    throw error;
  }
  return parseSimulationResult(result, calls.length, wallet);
}

/**
 * Capability check (e.g. for a settings screen): one trivial zero-value
 * simulation from and to the zero address. Method-not-found or a malformed
 * response means unsupported; any other failure (network error, rate
 * limit…) is thrown unchanged, because it says nothing either way.
 */
export async function verifySimulationSupport(
  transport: JsonRpcTransport,
): Promise<{ supported: true } | { supported: false; reason: string }> {
  const zero = '0x0000000000000000000000000000000000000000';
  try {
    await simulateAssetChanges(transport, [{ from: zero, to: zero, value: 0n }], zero);
    return { supported: true };
  } catch (error) {
    if (error instanceof SimulationUnsupportedError) {
      return { supported: false, reason: error.message };
    }
    throw error;
  }
}

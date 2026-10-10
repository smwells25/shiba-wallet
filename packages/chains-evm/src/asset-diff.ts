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
 * contract occupies. The same holds for the protocol's own ETH-transfer
 * logs (EIP-7708, below): they are issued by the execution layer itself at
 * the system address 0xff…fe, which holds no code (eth_getCode answered
 * "0x" on Ethereum mainnet, Sepolia, Base Sepolia and Arbitrum Sepolia on
 * 2026-10-09), so no contract can emit a log from that address.
 *
 * EIP-7708 (ETH TRANSFERS EMIT A LOG). Since the Glamsterdam upgrade
 * activated on Sepolia at timestamp 1791294816 (2026-10-06 13:53:36 UTC;
 * EIP-7773 "Hardfork Meta - Glamsterdam", ethereum/EIPs commit
 * 644b84799ba6873edcb13c0e21fdd319b4efbc08, whose Sepolia row reads
 * "353024 | 1791294816"; blog.ethereum.org/2026/09/17/glamsterdam-testnet-
 * announcement; go-ethereum v1.17.6 release notes "The Amsterdam hardfork
 * is scheduled on the Sepolia testnet at timestamp 1791294816"), every
 * transaction receipt and every eth_simulateV1 call result carries a real
 * log for each ETH movement. EIP-7708 (ethereum/EIPs EIPS/eip-7708.md at
 * af3a7802c8ea516f717c6013e27d0f529046f007, status Last Call, listed in
 * EIP-7773's "EIPs Scheduled for Inclusion") specifies: "A log, identical
 * to a LOG3, is issued for: Any nonzero-value-transferring transaction to a
 * different account …; Any nonzero-value-transferring CALL to a different
 * account …; Any nonzero-value-transferring SELFDESTRUCT to a different
 * account …; Any nonzero-value-transferring CREATE or CREATE2 to the
 * created account", with address 0xfffffffffffffffffffffffffffffffffffffffe
 * (SYSTEM_ADDRESS), topics[0] keccak256('Transfer(address,address,uint256)'),
 * topics[1] / topics[2] the from / to addresses "zero prefixed to fill
 * uint256", and data the "amount in Wei (big endian uint256)" — "This
 * matches the ERC-20 Transfer event definition." Zero-value transfers,
 * transfers to self, fee payments and reverted frames emit nothing. The
 * execution-specs reference (ethereum/execution-specs
 * 64cbead5981236d0fd6f5d172c1ac5dbfb5998f3, src/ethereum/forks/amsterdam/
 * vm/__init__.py emit_transfer_log) agrees. Observed on Sepolia: the
 * funding transaction 0x0293867adea984c67d62dfff3e9d8f704ed789071e220fc67c441a51a2a83b1d
 * (block 11880421) carries exactly such a log (captured verbatim in
 * test/fixtures/eip7708-sepolia/). Such a log is therefore a NATIVE ETH
 * movement, never a token: decoding it as an ERC-20 Transfer of "token
 * 0xff…fe" was the bogus preview row of the 2026-10-09 rehearsal.
 *
 * traceTransfers AFTER EIP-7708: nodes disagree, so both kinds are read and
 * one movement counts once. Read-only probes of eth_simulateV1 with
 * traceTransfers on ethereum-sepolia-rpc.publicnode.com on 2026-10-09,
 * which load-balances between two clients (web3_clientVersion
 * "reth/v2.7.0-3d592ec" and "Geth/v1.17.7-stable-3d858f85"): for a plain
 * transfer, reth returned ONLY the 0xff…fe log; geth returned the 0xeeee…
 * pseudo-log immediately followed by the 0xff…fe log for the same
 * movement (two identical calls in one block: two such pairs); for a
 * transfer to self, which EIP-7708 does not log, geth returned only a
 * 0xeeee… pseudo-log and reth returned no log at all (the captured answers
 * are in test/fixtures/eip7708-sepolia/simulate-trace-transfers.json). The open execution-apis issue #868 reports the same
 * split per client (geth, reth, erigon both; nethermind protocol log only;
 * besu synthetic log only), and go-ethereum PR #35617 (merged 2026-10-07,
 * in v1.17.8) stops geth adding the pseudo-log once EIP-7708 is active.
 * RULE (mergeNativeTransferLogs): within one call, every 0xff…fe log
 * cancels ONE not-yet-cancelled 0xeeee… pseudo-log with the same from, to
 * and amount; everything else counts. Per movement this gives the larger
 * of the two counts, which is right for every behaviour above: both kinds
 * (geth), protocol log only (reth, nethermind), pseudo-log only (besu, and
 * every node before the fork or on networks without EIP-7708).
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

/**
 * Emitter address of the protocol's own ETH-transfer logs: EIP-7708's
 * SYSTEM_ADDRESS (ethereum/EIPs EIPS/eip-7708.md at af3a7802, "address:
 * 0xfffffffffffffffffffffffffffffffffffffffe"). Active on Sepolia since the
 * Glamsterdam upgrade (see the module comment); a Transfer-shaped log from
 * this address is a native ETH movement, never a token.
 */
export const EIP7708_TRANSFER_LOG_ADDRESS = '0xfffffffffffffffffffffffffffffffffffffffe';

/**
 * True when `address` (any case) is EIP7708_TRANSFER_LOG_ADDRESS. Log
 * consumers that look for TOKEN Transfer events (erc20-logs.ts,
 * contract-risk.ts) use it to leave the protocol's ETH-transfer logs out.
 */
export function isEip7708TransferLogAddress(address: string): boolean {
  return address.toLowerCase() === EIP7708_TRANSFER_LOG_ADDRESS;
}

/** type(uint256).max — the conventional "unlimited" ERC-20 allowance. */
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Wrapped-ether events. WETH9 (the canonical Wrapped Ether contract,
 * gnosis/canonical-weth contracts/WETH9.sol at commit
 * 0dd1ea3e295eef916d0c6223ec63141137d22d67, read 2026-10-04) declares
 * `event Deposit(address indexed dst, uint wad)` and
 * `event Withdrawal(address indexed src, uint wad)` (`uint` is uint256 in
 * the canonical signature). deposit() credits msg.sender with msg.value and
 * emits Deposit only; withdraw(wad) debits msg.sender, sends the ether back
 * with transfer() and emits Withdrawal only. Neither emits Transfer, so
 * without these events a wrap shows only the ether leaving (finding F5 of
 * the phase 11 emulator pass).
 */
export const DEPOSIT_EVENT_TOPIC = eventTopic('Deposit(address,uint256)');
export const WITHDRAWAL_EVENT_TOPIC = eventTopic('Withdrawal(address,uint256)');

/**
 * Wrapped-ether contracts whose Deposit / Withdrawal events are decoded
 * (lowercase). Pinned because the same event shape is used with other
 * meanings — the old Gnosis MultiSigWallet, for example, emits
 * `Deposit(address indexed sender, uint value)` when it RECEIVES ether, and
 * many vaults emit a Deposit(address,uint256) for an underlying token —
 * so decoding the event from any contract would report tokens the wallet
 * never receives. Each entry was checked on 2026-10-04: listed by the cited
 * source, and its runtime code (eth_getCode on the publicnode endpoints)
 * contains both topics above and its symbol() answers "WETH".
 *  - 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2: Ethereum mainnet WETH9
 *    (gnosis/canonical-weth README; Uniswap v3 Ethereum deployments page).
 *  - 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14: Ethereum Sepolia WETH
 *    (Uniswap v3 Ethereum deployments page, "Sepolia 11155111 WETH").
 *  - 0x4200000000000000000000000000000000000006: the OP-stack WETH9
 *    predeploy (docs.base.org Base contracts page, Base Sepolia L2
 *    contracts, "WETH9").
 * The list is address-only (the parser does not know the chain); a caller
 * may pass its own list through AssetDiffOptions.wrappedNativeTokens.
 */
export const WRAPPED_NATIVE_TOKENS: readonly string[] = [
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
  '0x4200000000000000000000000000000000000006',
];

const ZERO_ADDRESS_LOWER = '0x0000000000000000000000000000000000000000';

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
      /**
       * Present when the change was decoded from a wrapped-ether Deposit
       * ('deposit': `from` is the zero address, the wallet is credited) or
       * Withdrawal ('withdrawal': `to` is the zero address, the wallet is
       * debited) instead of a Transfer event. See WRAPPED_NATIVE_TOKENS.
       */
      wrap?: 'deposit' | 'withdrawal';
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

/**
 * A wrapped-ether Deposit or Withdrawal naming the wallet. It becomes a
 * balance change only after parseSimulationResult has matched it with the
 * ether movement it implies (see resolveWraps).
 */
interface WrapCandidate {
  kind: 'wrap';
  wrap: 'deposit' | 'withdrawal';
  /** Lowercase emitter (the wrapped-ether contract). */
  token: string;
  amount: bigint;
}

type Decoded =
  | { kind: 'changes'; changes: AssetChange[] }
  | WrapCandidate
  | { kind: 'ignored' }
  | { kind: 'skipped' };

const IGNORED: Decoded = { kind: 'ignored' };
const SKIPPED: Decoded = { kind: 'skipped' };

/**
 * Decodes one log into wallet-relevant changes. Unknown events are
 * `ignored` (swaps, syncs … are normal); known token-event topics with a
 * non-standard shape are `skipped` and counted, never guessed at.
 */
function decodeLog(
  log: RawLog,
  me: string,
  callIndex: number,
  wrappers: ReadonlySet<string>,
  nativeSources: Map<AssetChange, NativeSource>,
): Decoded {
  const topic0 = log.topics[0]?.toLowerCase();
  if (topic0 === undefined) return IGNORED;
  const emitter = log.address.toLowerCase();
  const n = log.topics.length;
  const dataBytes = (log.data.length - 2) / 2;

  if ((topic0 === DEPOSIT_EVENT_TOPIC || topic0 === WITHDRAWAL_EVENT_TOPIC) && wrappers.has(emitter)) {
    // WETH9 shape: one indexed address (dst / src) and one uint256 word.
    const account = log.topics[1] ? topicAddress(log.topics[1]) : null;
    if (n !== 2 || dataBytes !== 32 || !account) return SKIPPED;
    if (account !== me) return IGNORED;
    return {
      kind: 'wrap',
      wrap: topic0 === DEPOSIT_EVENT_TOPIC ? 'deposit' : 'withdrawal',
      token: emitter,
      amount: BigInt(log.data),
    };
  }

  if (topic0 === TRANSFER_EVENT_TOPIC) {
    const from = log.topics[1] ? topicAddress(log.topics[1]) : null;
    const to = log.topics[2] ? topicAddress(log.topics[2]) : null;
    if (n === 3 && dataBytes === 32 && from && to) {
      const dir = direction(from, to, me);
      if (!dir) return IGNORED;
      const amount = BigInt(log.data);
      if (emitter === NATIVE_TRANSFER_PSEUDO_ADDRESS || emitter === EIP7708_TRANSFER_LOG_ADDRESS) {
        const change: AssetChange = {
          type: 'native',
          callIndex,
          direction: dir,
          from: checksum(from),
          to: checksum(to),
          amount,
        };
        nativeSources.set(change, emitter === EIP7708_TRANSFER_LOG_ADDRESS ? 'eip7708' : 'trace');
        return { kind: 'changes', changes: [change] };
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
    if (
      n === 4 &&
      dataBytes === 0 &&
      from &&
      to &&
      emitter !== NATIVE_TRANSFER_PSEUDO_ADDRESS &&
      emitter !== EIP7708_TRANSFER_LOG_ADDRESS
    ) {
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

/** Where a native change was read from: the traceTransfers pseudo-log, or the EIP-7708 protocol log. */
type NativeSource = 'trace' | 'eip7708';

/**
 * Counts each ETH movement of one call once (the RULE in the module
 * comment): every native change read from an EIP-7708 log removes the
 * earliest not-yet-removed traceTransfers pseudo-log change with the same
 * from, to and amount. The protocol log is kept (it is the protocol's own
 * record); order is otherwise preserved. Non-native entries pass through.
 */
function mergeNativeTransferLogs(
  entries: (AssetChange | WrapCandidate)[],
  nativeSources: ReadonlyMap<AssetChange, NativeSource>,
): (AssetChange | WrapCandidate)[] {
  const dropped = new Set<AssetChange>();
  for (const entry of entries) {
    if (isWrapCandidate(entry) || entry.type !== 'native' || nativeSources.get(entry) !== 'eip7708') continue;
    const twin = entries.find(
      (e): e is AssetChange =>
        !isWrapCandidate(e) &&
        e.type === 'native' &&
        nativeSources.get(e) === 'trace' &&
        !dropped.has(e) &&
        e.amount === entry.amount &&
        e.from === entry.from &&
        e.to === entry.to,
    );
    if (twin) dropped.add(twin);
  }
  return dropped.size === 0 ? entries : entries.filter((e) => isWrapCandidate(e) || !dropped.has(e));
}

/**
 * Turns one call's wrapped-ether candidates into balance changes, in log
 * order. A candidate counts only when the call also moved the matching
 * ether, as the node reports it (traceTransfers pseudo-events from 0xeeee…
 * or EIP-7708 protocol logs from 0xff…fe, neither of which a contract can
 * emit; already merged by mergeNativeTransferLogs): for a Deposit, exactly
 * `amount` wei from the wallet to the wrapper; for a Withdrawal, exactly
 * `amount` wei from the wrapper to the wallet. Each ether movement backs at
 * most one candidate. Without it the candidate is dropped, never guessed
 * at. A receipt from before EIP-7708 has no ETH-movement logs at all; for
 * receipts after it, activity-decode.ts turns this decoding off
 * (wrappedNativeTokens: []) so that Activity is unchanged by the fork.
 *
 * A wrapper that ALSO emits a mint or burn Transfer for the same deposit or
 * withdrawal (Solmate's WETH, for example, calls _mint and then emits
 * Deposit) is already shown by that Transfer; the candidate is then dropped
 * so the amount is not counted twice. Matching is one-to-one on token,
 * wallet and exact amount within the same call.
 *
 * Trust: like Transfer events, these are emitted by the contract itself;
 * the pinned list (WRAPPED_NATIVE_TOKENS) and the ether-movement match
 * limit which contracts are believed, and the change carries the emitter
 * address so UIs label the token by address.
 */
function resolveWraps(entries: (AssetChange | WrapCandidate)[], me: string, callIndex: number): AssetChange[] {
  const changes = entries.filter((e): e is AssetChange => !isWrapCandidate(e));
  const usedNative = new Set<AssetChange>();
  const usedTransfer = new Set<AssetChange>();
  const out: AssetChange[] = [];
  for (const entry of entries) {
    if (!isWrapCandidate(entry)) {
      out.push(entry);
      continue;
    }
    const deposit = entry.wrap === 'deposit';
    const backing = changes.find(
      (c) =>
        c.type === 'native' &&
        !usedNative.has(c) &&
        c.amount === entry.amount &&
        c.from.toLowerCase() === (deposit ? me : entry.token) &&
        c.to.toLowerCase() === (deposit ? entry.token : me),
    );
    if (!backing) continue;
    usedNative.add(backing);
    const duplicate = changes.find(
      (c) =>
        c.type === 'erc20' &&
        c.wrap === undefined &&
        !usedTransfer.has(c) &&
        c.token.toLowerCase() === entry.token &&
        c.amount === entry.amount &&
        c.from.toLowerCase() === (deposit ? ZERO_ADDRESS_LOWER : me) &&
        c.to.toLowerCase() === (deposit ? me : ZERO_ADDRESS_LOWER),
    );
    if (duplicate) {
      usedTransfer.add(duplicate);
      continue;
    }
    out.push({
      type: 'erc20',
      callIndex,
      direction: deposit ? 'in' : 'out',
      token: checksum(entry.token),
      from: deposit ? checksum(ZERO_ADDRESS_LOWER) : checksum(me),
      to: deposit ? checksum(me) : checksum(ZERO_ADDRESS_LOWER),
      amount: entry.amount,
      wrap: entry.wrap,
    });
  }
  return out;
}

function isWrapCandidate(entry: AssetChange | WrapCandidate): entry is WrapCandidate {
  return (entry as { kind?: unknown }).kind === 'wrap';
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
  options: Pick<AssetDiffOptions, 'wrappedNativeTokens'> = {},
): AssetDiffResult {
  const wrappers = new Set((options.wrappedNativeTokens ?? WRAPPED_NATIVE_TOKENS).map((a) => a.toLowerCase()));
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
    const entries: (AssetChange | WrapCandidate)[] = [];
    const nativeSources = new Map<AssetChange, NativeSource>();
    for (const log of logs as unknown[]) {
      if (!isRawLog(log)) {
        skippedLogs += 1;
        continue;
      }
      const decoded = decodeLog(log, me, callIndex, wrappers, nativeSources);
      if (decoded.kind === 'changes') entries.push(...decoded.changes);
      else if (decoded.kind === 'wrap') entries.push(decoded);
      else if (decoded.kind === 'skipped') skippedLogs += 1;
    }
    changes.push(...resolveWraps(mergeNativeTransferLogs(entries, nativeSources), me, callIndex));
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
  /**
   * Wrapped-ether contracts whose Deposit / Withdrawal events count as
   * balance changes; default WRAPPED_NATIVE_TOKENS. An empty list turns the
   * decoding off.
   */
  wrappedNativeTokens?: readonly string[];
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
  return parseSimulationResult(result, calls.length, wallet, options);
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

import { toChecksumAddress } from '@shiba-wallet/core';
import type { AssetChange } from './asset-diff.js';
import { bigintToHex, toBytes } from './encoding.js';
import { isEip7708TransferLogAddress } from './asset-diff.js';
import { TRANSFER_TOPIC, addressTopic } from './erc20-logs.js';
import { getLogsWindowed, topicToLowerAddress, validateLog } from './approvals.js';
import type { JsonRpcTransport } from './rpc.js';

/**
 * Contract risk signals (phase 7, item 5), computed from plain JSON-RPC so
 * no vendor, reputation list or scoring service is involved. The app turns
 * the typed signals into confirm-screen warnings; nothing here produces a
 * numeric score.
 *
 * Sources (fetched 2026-10-01):
 *  - EIP-7702 "Set Code for EOAs" (status Final, ethereum/EIPs
 *    EIPS/eip-7702.md): processing an authorization sets "the code of
 *    `authority` to be `0xef0100 || address`. This is a delegation
 *    indicator." When executing a delegated account "EXTCODESIZE returns
 *    `23` (the size of `0xef0100 || address`)". A zero `address` clears the
 *    code instead of writing an indicator. So eth_getCode of a delegated EOA
 *    returns exactly 23 bytes: the three bytes 0xef 0x01 0x00 followed by
 *    the 20-byte delegate address. Observed live 2026-10-01 (read-only,
 *    https://ethereum.publicnode.com): eth_getCode of the standard test
 *    mnemonic's first address 0x9858EfFD232B4033E47d90003D41EC34EcaEda94
 *    (its key is public, so third parties have delegated it) returned
 *    0xef01008a67b5020ee254ef48e3b6a04927f39baf7e408a, which
 *    classifyRecipient reports as delegated-eoa with delegate
 *    0x8A67B5020eE254eF48e3B6a04927F39bAf7e408A. That delegation is
 *    third-party state and may change at any time.
 *  - execution-apis src/eth/state.yaml: eth_getCode(Address, Block) returns
 *    the code at that address and block (default 'latest').
 *  - EIP-6780 "SELFDESTRUCT only in same transaction" (Final): SELFDESTRUCT
 *    no longer deletes an account's code except in the transaction that
 *    created it. This is what makes code presence (nearly) monotonic over
 *    blocks and the deployment binary search sound; see
 *    findCodeDeploymentBlock for the remaining exceptions.
 *  - ERC-20 text (ERCS/erc-20.md): "Transfers of 0 values MUST be treated
 *    as normal transfers and fire the Transfer event." Combined with any
 *    contract being able to emit any event, a Transfer log naming the wallet
 *    as sender is NOT proof the wallet sent anything (see
 *    isFirstInteraction).
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;

function assertAddress(value: string, label: string): string {
  if (!ADDRESS.test(value)) throw new Error(`${label} is not a 20-byte hex address: ${value}`);
  return value.toLowerCase();
}

async function getCode(transport: JsonRpcTransport, address: string, block: string): Promise<string> {
  const code = await transport('eth_getCode', [address, block]);
  if (typeof code !== 'string' || !HEX.test(code) || code.length % 2 !== 0) {
    throw new Error(`eth_getCode returned a malformed result for ${address}`);
  }
  return code.toLowerCase();
}

async function blockNumber(transport: JsonRpcTransport): Promise<bigint> {
  const result = await transport('eth_blockNumber', []);
  if (typeof result !== 'string' || !QUANTITY.test(result)) {
    throw new Error('eth_blockNumber returned a malformed result');
  }
  return BigInt(result);
}

// ---------------------------------------------------------------------------
// Recipient classification (EOA / contract / EIP-7702 delegated EOA)
// ---------------------------------------------------------------------------

/** EIP-7702 delegation indicator prefix: 0xef, 0x01, 0x00. */
export const EIP7702_DELEGATION_PREFIX = '0xef0100';
/** Byte length of a delegation indicator: 3-byte prefix + 20-byte address. */
export const EIP7702_DELEGATION_LENGTH = 23;

/**
 * Returns the checksummed delegate address when `code` is exactly an
 * EIP-7702 delegation indicator (23 bytes starting 0xef0100), else null.
 */
export function parseDelegationIndicator(code: string): string | null {
  const hex = code.toLowerCase();
  if (!HEX.test(hex) || hex.length !== 2 + EIP7702_DELEGATION_LENGTH * 2) return null;
  if (!hex.startsWith(EIP7702_DELEGATION_PREFIX)) return null;
  return toChecksumAddress(toBytes('0x' + hex.slice(EIP7702_DELEGATION_PREFIX.length)));
}

export type RecipientClass =
  /** No code: an externally owned account (or an undeployed address). */
  | { kind: 'eoa' }
  /** Ordinary contract code. */
  | { kind: 'contract'; codeSize: number }
  /**
   * An EOA carrying an EIP-7702 delegation indicator: calls to it execute
   * the delegate's code in the EOA's context, so it behaves like a contract
   * while its key holder can still sign as an EOA.
   */
  | { kind: 'delegated-eoa'; delegate: string };

/**
 * Classifies `address` from eth_getCode at `blockTag`. An address with no
 * code may also be a contract that is not (yet) deployed on THIS chain,
 * for example a token address copied from another network; the caller
 * cannot tell the two apart from code alone.
 */
export async function classifyRecipient(
  transport: JsonRpcTransport,
  address: string,
  blockTag = 'latest',
): Promise<RecipientClass> {
  assertAddress(address, 'address');
  const code = await getCode(transport, address, blockTag);
  if (code === '0x') return { kind: 'eoa' };
  const delegate = parseDelegationIndicator(code);
  if (delegate) return { kind: 'delegated-eoa', delegate };
  return { kind: 'contract', codeSize: (code.length - 2) / 2 };
}

// ---------------------------------------------------------------------------
// First interaction (log-based evidence only)
// ---------------------------------------------------------------------------

export interface FirstInteractionOptions {
  /** How many blocks back from `toBlock` to search (inclusive range). */
  lookbackBlocks: bigint;
  /** Newest block to search; defaults to eth_blockNumber. */
  toBlock?: bigint;
  /** eth_getLogs window size; ~10,000 suits the probed free-tier limit. Omit for one query. */
  windowBlocks?: bigint;
  /**
   * Token contracts to search (eth_getLogs accepts an address array per the
   * execution-apis Filter schema). Some public endpoints refuse filters
   * without a contract address (erc20-logs.ts records -32701 from one), so
   * pass the wallet's tracked tokens there. Omit for a wallet-wide query on
   * endpoints that allow it.
   */
  tokens?: string[];
  /**
   * Cap on eth_getTransactionByHash lookups used to confirm candidates
   * (default 5), so a flood of spoofed logs cannot cause unbounded calls.
   */
  maxTxLookups?: number;
}

export interface FirstInteractionResult {
  /**
   * True only when a confirmed earlier transfer from `me` to the address
   * was found. False means "no evidence found in the scanned range", NEVER
   * "has never interacted".
   */
  known: boolean;
  evidence: 'erc20-transfer' | 'none';
  /** The confirmed transfer, when known. */
  match?: { txHash: string; blockNumber: bigint; token: string; value: bigint };
  scannedFromBlock: bigint;
  scannedToBlock: bigint;
  /**
   * Transfer logs naming `me` as sender that were NOT accepted as evidence:
   * zero-value transfers, logs from transactions `me` did not send, or
   * candidates beyond maxTxLookups.
   */
  rejectedCandidates: number;
}

/**
 * Looks for evidence that `me` has sent ERC-20 tokens to `address`.
 *
 * LIMITS, stated honestly: plain ETH transfers are not searched here
 * (before EIP-7708 they emitted no logs; after it they emit protocol logs
 * from 0xff…fe, which this ERC-20 search deliberately leaves out), so
 * without an indexer they are invisible here; so are interactions older than the
 * lookback window and interactions that emitted no Transfer from `me` to
 * `address`. A result of known: false therefore means "unknown", and the
 * risk signal built from it says so.
 *
 * SPOOFING: anyone can make a Transfer log that names `me` as sender — any
 * contract can emit arbitrary events, and a standard token emits
 * Transfer(me, x, 0) for a zero-value transferFrom that needs no allowance
 * (the ERC-20 text requires zero-value transfers to fire Transfer). This is
 * the mechanism behind address-poisoning spam. A candidate log is accepted
 * only when its value is non-zero AND eth_getTransactionByHash shows the
 * transaction's `from` is `me`. Consequence: for a smart-account `me`, whose
 * transactions are submitted by a bundler, nothing is confirmed and the
 * result stays known: false — an over-warning, never false comfort.
 */
export async function isFirstInteraction(
  transport: JsonRpcTransport,
  me: string,
  address: string,
  options: FirstInteractionOptions,
): Promise<FirstInteractionResult> {
  const meLower = assertAddress(me, 'me');
  const target = assertAddress(address, 'address');
  if (options.lookbackBlocks <= 0n) throw new Error('lookbackBlocks must be positive');
  const tokens = options.tokens?.map((t) => assertAddress(t, 'token'));
  if (tokens && tokens.length === 0) throw new Error('tokens, when given, must not be empty');
  const maxTxLookups = options.maxTxLookups ?? 5;

  const toBlock = options.toBlock ?? (await blockNumber(transport));
  const start = toBlock - options.lookbackBlocks + 1n;
  const fromBlock = start > 0n ? start : 0n;

  const filter = {
    ...(tokens ? { address: tokens.length === 1 ? tokens[0]! : tokens } : {}),
    topics: [TRANSFER_TOPIC, addressTopic(meLower), addressTopic(target)],
  };

  // Walk windows newest-first so the common "sent recently" case is cheap.
  const windowSize = options.windowBlocks ?? toBlock - fromBlock + 1n;
  if (windowSize <= 0n) throw new Error('windowBlocks must be positive');
  let rejectedCandidates = 0;
  let lookups = 0;
  const checked = new Set<string>();
  for (let end = toBlock; end >= fromBlock; end -= windowSize) {
    const windowStart = end - windowSize + 1n > fromBlock ? end - windowSize + 1n : fromBlock;
    const raw = await getLogsWindowed(transport, filter, { fromBlock: windowStart, toBlock: end });
    const candidates = raw
      .map(validateLog)
      .filter((log): log is NonNullable<typeof log> => log !== null)
      .filter(
        (log) =>
          log.topics.length === 3 &&
          log.topics[0] === TRANSFER_TOPIC &&
          topicToLowerAddress(log.topics[1]!) === meLower &&
          topicToLowerAddress(log.topics[2]!) === target &&
          log.data.length === 66 &&
          // EIP-7708's protocol ETH-transfer logs (system address 0xff…fe,
          // same topic and shape; see asset-diff.ts) are ETH, not an ERC-20
          // transfer: this function reports token evidence only, so they
          // are not candidates (they can only appear in a query without a
          // token filter).
          !isEip7708TransferLogAddress(log.address) &&
          (!tokens || tokens.includes(log.address)),
      )
      .sort((a, b) =>
        a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1,
      );
    for (const log of candidates) {
      const value = BigInt(log.data);
      if (value === 0n) {
        rejectedCandidates += 1;
        continue;
      }
      if (checked.has(log.txHash)) continue;
      if (lookups >= maxTxLookups) {
        rejectedCandidates += 1;
        continue;
      }
      checked.add(log.txHash);
      lookups += 1;
      const tx = await transport('eth_getTransactionByHash', [log.txHash]);
      const from = (tx as { from?: unknown } | null)?.from;
      if (typeof from === 'string' && from.toLowerCase() === meLower) {
        return {
          known: true,
          evidence: 'erc20-transfer',
          match: {
            txHash: log.txHash,
            blockNumber: log.blockNumber,
            token: toChecksumAddress(toBytes(log.address)),
            value,
          },
          scannedFromBlock: fromBlock,
          scannedToBlock: toBlock,
          rejectedCandidates,
        };
      }
      rejectedCandidates += 1;
    }
    if (windowStart === fromBlock) break;
  }
  return {
    known: false,
    evidence: 'none',
    scannedFromBlock: fromBlock,
    scannedToBlock: toBlock,
    rejectedCandidates,
  };
}

// ---------------------------------------------------------------------------
// Contract age (binary search over historical eth_getCode)
// ---------------------------------------------------------------------------

export interface DeploymentSearchOptions {
  /** Lowest block to consider (default 0). */
  fromBlock?: bigint;
  /** Highest block to consider; defaults to eth_blockNumber. */
  toBlock?: bigint;
}

export interface DeploymentSearchResult {
  /**
   * First block in [fromBlock, toBlock] at which the address has code. When
   * `atOrBefore` is true the code already existed at fromBlock, so the real
   * deployment may be earlier.
   */
  firstBlockWithCode: bigint;
  atOrBefore: boolean;
  /** toBlock − firstBlockWithCode. */
  ageBlocks: bigint;
  /** JSON-RPC calls made (eth_blockNumber + eth_getCode). */
  rpcCalls: number;
}

/**
 * Finds the first block at which `address` has code by binary search over
 * eth_getCode(address, block). Returns null when there is no code at
 * toBlock.
 *
 * COST: 1 eth_blockNumber (unless toBlock is given) + 2 eth_getCode probes
 * of the range ends + ceil(log2(range)) probes. For a mainnet-sized range
 * of ~24 million blocks that is about 2 + 25 calls. Each eth_getCode returns
 * the full bytecode (up to 24 KB per contract), so bandwidth, not call
 * count, can dominate on large contracts.
 *
 * REQUIREMENTS AND CAVEATS:
 *  - Historical state: eth_getCode at old blocks needs an archive node.
 *    Pruned nodes keep only recent state and answer older queries with an
 *    error, which propagates unchanged (the exact retention window and error
 *    text depend on the client and its configuration). Live-probed
 *    2026-10-01 on the free https://ethereum.publicnode.com endpoint:
 *    eth_getCode answered at latest and latest-64, but latest-127 and older
 *    were refused with HTTP 403 and JSON-RPC error -32602 "Archive requests
 *    require a personal tok[en]…" (httpTransport surfaces this as
 *    "RPC HTTP error 403 for eth_getCode"). So on free public endpoints this
 *    search fails for anything but brand-new contracts; callers should treat
 *    a failure as "age unknown" and raise no signal, and offer it only when
 *    an archive-capable endpoint is configured.
 *  - Monotonicity: binary search assumes code, once present, stays present.
 *    Since EIP-6780 that holds for SELFDESTRUCT except in the creation
 *    transaction itself; contracts destroyed before that rule took effect
 *    and later redeployed at the same address (CREATE2) can violate it, in
 *    which case the result is some block with code, not necessarily the
 *    first. EIP-7702 delegations can also be set and cleared repeatedly, so
 *    this function is meaningless for delegated EOAs; riskSignals ignores
 *    age for them.
 */
export async function findCodeDeploymentBlock(
  transport: JsonRpcTransport,
  address: string,
  options: DeploymentSearchOptions = {},
): Promise<DeploymentSearchResult | null> {
  assertAddress(address, 'address');
  let rpcCalls = 0;
  let toBlock = options.toBlock;
  if (toBlock === undefined) {
    toBlock = await blockNumber(transport);
    rpcCalls += 1;
  }
  const fromBlock = options.fromBlock ?? 0n;
  if (fromBlock < 0n || toBlock < fromBlock) {
    throw new Error(`Invalid block range ${fromBlock}..${toBlock}`);
  }
  const hasCode = async (block: bigint): Promise<boolean> => {
    rpcCalls += 1;
    return (await getCode(transport, address, bigintToHex(block))) !== '0x';
  };

  if (!(await hasCode(toBlock))) return null;
  if (await hasCode(fromBlock)) {
    return { firstBlockWithCode: fromBlock, atOrBefore: true, ageBlocks: toBlock - fromBlock, rpcCalls };
  }
  // Invariant: no code at lo, code at hi.
  let lo = fromBlock;
  let hi = toBlock;
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (await hasCode(mid)) hi = mid;
    else lo = mid;
  }
  return { firstBlockWithCode: hi, atOrBefore: false, ageBlocks: toBlock - hi, rpcCalls };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export type RiskSignalType =
  | 'unlimited-approval'
  | 'operator-approval'
  | 'first-interaction-unknown'
  | 'new-contract'
  | 'delegated-eoa'
  | 'no-code-recipient-with-calldata';

export interface RiskSignal {
  type: RiskSignalType;
  /** 'warning' deserves attention before signing; 'notice' is context. */
  severity: 'warning' | 'notice';
  /** One plain-language sentence or two the app can render as-is. */
  message: string;
  /** The address the signal is about (spender, operator, recipient…), checksummed when known. */
  subject?: string;
}

export interface RiskInputs {
  /** The transaction's `to`, classified with classifyRecipient. */
  recipient?: { address: string; class: RecipientClass };
  /** Whether the transaction carries non-empty calldata. */
  hasCalldata?: boolean;
  /** Changes from simulateAssetChanges (approvals are read from these). */
  assetChanges?: AssetChange[];
  /** From isFirstInteraction for the recipient (or counterparty). */
  firstInteraction?: FirstInteractionResult;
  /**
   * From findCodeDeploymentBlock for a 'contract' recipient, with the
   * caller's threshold: a contract younger than thresholdBlocks raises
   * 'new-contract'. No default threshold is built in; block times differ by
   * chain, so the app chooses one per chain.
   */
  contractAge?: { result: DeploymentSearchResult; thresholdBlocks: bigint };
}

/**
 * Pure aggregator: turns gathered facts into a small typed list of signals
 * with plain-language text. No scores, no vendor lists; an absent input
 * simply produces no signal for that aspect.
 */
export function riskSignals(inputs: RiskInputs): RiskSignal[] {
  const signals: RiskSignal[] = [];
  const recipient = inputs.recipient;

  for (const change of inputs.assetChanges ?? []) {
    if (change.type === 'erc20-approval' && change.unlimited) {
      signals.push({
        type: 'unlimited-approval',
        severity: 'warning',
        subject: change.spender,
        message:
          `This gives ${change.spender} permission to spend ALL of this token (${change.token}) ` +
          'from your wallet, now and in the future, until you revoke it.',
      });
    }
    if (change.type === 'approval-for-all' && change.approved) {
      signals.push({
        type: 'operator-approval',
        severity: 'warning',
        subject: change.operator,
        message:
          `This gives ${change.operator} control of EVERY item you hold in the collection ` +
          `${change.token}, including ones you receive later, until you revoke it.`,
      });
    }
  }

  if (recipient?.class.kind === 'delegated-eoa') {
    signals.push({
      type: 'delegated-eoa',
      severity: 'notice',
      subject: recipient.address,
      message:
        'This address is a regular account that has delegated its behavior to contract code ' +
        `at ${recipient.class.delegate} (EIP-7702). Sending to it runs that code.`,
    });
  }

  if (recipient?.class.kind === 'eoa' && inputs.hasCalldata) {
    signals.push({
      type: 'no-code-recipient-with-calldata',
      severity: 'warning',
      subject: recipient.address,
      message:
        'This transaction sends contract instructions to an address that has no contract code ' +
        'on this network. Nothing will execute; if you expected a contract (for example a ' +
        'token), it may be the wrong address or the wrong network.',
    });
  }

  if (inputs.contractAge && recipient?.class.kind === 'contract') {
    const { result, thresholdBlocks } = inputs.contractAge;
    if (!result.atOrBefore && result.ageBlocks < thresholdBlocks) {
      signals.push({
        type: 'new-contract',
        severity: 'warning',
        subject: recipient.address,
        message:
          `This contract was deployed only ${result.ageBlocks} blocks ago. New contracts have ` +
          'little track record; make sure you trust it.',
      });
    }
  }

  if (inputs.firstInteraction && !inputs.firstInteraction.known) {
    signals.push({
      type: 'first-interaction-unknown',
      severity: 'notice',
      ...(recipient ? { subject: recipient.address } : {}),
      message:
        'No earlier token transfers from you to this address were found in recent history. ' +
        'This may be your first time sending to it, so double-check every character of the ' +
        'address. (Plain ETH transfers cannot be checked without an indexer.)',
    });
  }

  return signals;
}

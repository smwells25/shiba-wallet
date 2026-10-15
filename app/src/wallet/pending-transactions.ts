import { AsyncStorage, readStoreItem, writeStoreItem, removeStoreItem, STORE_KEYS } from './store-keys.ts';
// Explicit .ts extensions: scripts/check-pending.mjs and the live scratch
// script load this module under Node's type stripping, which resolves
// relative specifiers literally. Type-only imports are erased, so this module
// has no runtime dependency on send.ts (send.ts imports THIS module, and the
// graph must stay a DAG).
import type { KeyValueStore } from './tokens.ts';
import type { EvmSendQuote } from './send.ts';
import type { AaOperationKind, AaOperationSentEvent, AaSendQuote } from './aa.ts';
import { formatUnits } from './balances.ts';

/**
 * Stuck and failed transactions (feature 95, the transaction half): the
 * registry of transactions this wallet broadcast from a regular account that
 * are not yet known to be included, the replacement fee rule, and the
 * resolution of a nonce once something is included.
 *
 * WHY A REGISTRY. Activity is built from a history indexer
 * (alchemy_getAssetTransfers) or from token logs, and both list only
 * transactions that are already in a block; a transaction waiting in the
 * node's pool appears nowhere. The wallet therefore remembers, on this phone
 * only, what it broadcast: the fields needed to rebuild the same
 * transaction with higher fees (chain, hash, nonce, from, to, value, data,
 * gas limit, fees, the time it was sent). Nothing secret is stored — these
 * are the fields of a transaction that is already public in the mempool —
 * and the signing key is never involved.
 *
 * THE REPLACEMENT RULE (read from the clients' sources; see the two
 * functions below). A transaction with the same sender and nonce replaces
 * the pooled one only when BOTH its max fee per gas and its max priority fee
 * per gas clear a 10% bump:
 *  - go-ethereum, core/txpool/legacypool/list.go at commit 3a6c2e3b
 *    (master, 2026-10-10), lines 303–325 (list.Add): rejected when
 *    `old.GasFeeCapCmp(tx) >= 0 || old.GasTipCapCmp(tx) >= 0` (each must be
 *    STRICTLY higher) or when either is below
 *    `old * (100 + priceBump) / 100` (integer division, i.e. rounded down);
 *    legacypool.go lines 147 and 163 set PriceBump to 10 by default, and
 *    line 767 returns txpool.ErrReplaceUnderpriced ("replacement
 *    transaction underpriced", errors.go line 43).
 *  - reth, crates/transaction-pool/src/config.rs at commit 1a4dbbe1 (main,
 *    2026-10-11), lines 24 and 227–255: DEFAULT_PRICE_BUMP = 10 and the
 *    required fee is `existing * (100 + bump)` divided by 100 ROUNDED UP
 *    (div_ceil), for the max fee and (when both are non-zero) the priority
 *    fee.
 * The wallet's Sepolia default endpoint balances reth and geth backends
 * (phase 18), so the minimum used here satisfies both:
 * max(old + 1, ceil(old × 110 / 100)).
 *
 * The "cancel" idiom is the same rule applied to a different transaction:
 * a transfer of 0 to the account's own address with the same nonce and
 * bumped fees. Whichever of the two a block includes first uses the nonce;
 * the other can then never be included.
 *
 * SMART ACCOUNTS. A UserOperation is not replaceable by this wallet: see
 * SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE and checkUserOperation below.
 *
 * STORE DISCIPLINE (as the notes and contacts stores): one versioned JSON
 * document under PENDING_TX_KEY, strictly re-validated on every read. A
 * document that cannot be parsed, has an unknown version, or holds any
 * record that fails validation is READ-ONLY: the valid records are still
 * shown, every write is refused (recording after a broadcast is skipped,
 * never thrown), and "Reset the pending list" clears it. Writes go through
 * one queue per store.
 *
 * Free of React Native imports apart from AsyncStorage (the default store),
 * so the check scripts run it under plain Node with an in-memory store.
 */

/** AsyncStorage key of the registry. */
export const PENDING_TX_KEY = STORE_KEYS.pendingTx.name;
const STORE_VERSION = 1;

/**
 * At most this many records are kept (judgement). go-ethereum guarantees an
 * account 16 executable pool slots by default (legacypool.go AccountSlots),
 * so 64 covers several accounts on several networks with room for their
 * replacements. Over the cap, the oldest RESOLVED notices go first, then the
 * oldest pending records; dropping a pending record only removes the
 * wallet's ability to speed it up from Activity, it changes nothing on-chain.
 */
export const MAX_PENDING_RECORDS = 64;

/** A resolved notice ("Replaced by …", "Cancelled") stays this long (judgement: one day). */
export const RESOLVED_KEEP_MS = 24 * 60 * 60 * 1000;

/** The pools' replacement bump (go-ethereum and reth default; see the file comment). */
export const PRICE_BUMP_PERCENT = 10n;

/**
 * A smart-account operation whose bundler has neither a receipt nor the
 * operation itself for this long is offered "Send again" (judgement: ten
 * minutes — about fifty Ethereum blocks; a bundler normally includes or
 * refuses an operation within a few blocks).
 */
export const USEROP_UNKNOWN_AFTER_MS = 10 * 60 * 1000;

/** How often the open Activity screen re-reads pending transactions (judgement). */
export const PENDING_POLL_MS = 15_000;

export type ReplacementAction = 'speed-up' | 'cancel';

/** One transaction this wallet broadcast from a regular (EOA) account. */
export interface PendingTxRecord {
  kind: 'tx';
  /** CAIP-2 id, e.g. 'eip155:11155111'. */
  chain: string;
  /** Lower-case 0x + 64 hex transaction hash. */
  hash: string;
  /** Decimal nonce. */
  nonce: string;
  /** Lower-case 0x + 40 hex sender. */
  from: string;
  /** Lower-case 0x + 40 hex recipient (the account itself for a cancellation). */
  to: string;
  /** Decimal wei. */
  value: string;
  /** Lower-case 0x calldata ('0x' when none). */
  data: string;
  /** Decimal wei per gas. */
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  /** Decimal gas. */
  gasLimit: string;
  /** Unix milliseconds when the node accepted it. */
  sentAt: number;
  /** 'send' for the wallet's ordinary transaction, else the replacement's action. */
  action: 'send' | ReplacementAction;
  /** The hash this one replaced (null for an ordinary send). */
  replaces: string | null;
}

/**
 * A smart-account operation the bundler accepted from this wallet: from the
 * Send screen (since phase 19) and, since phase 20 item 3, from every other
 * submission path (aa.ts AaOperationSentEvent).
 */
export interface PendingUserOpRecord {
  kind: 'userop';
  chain: string;
  /** Lower-case 0x + 64 hex. */
  userOpHash: string;
  /** Lower-case smart-account address. */
  sender: string;
  /** Lower-case owner EOA (the account the Activity list belongs to). */
  owner: string;
  sentAt: number;
  /**
   * What "Send again" pre-fills (a plain native or token send from the
   * Send screen); null when the operation cannot be refilled.
   */
  resend: {
    recipient: string;
    /** Decimal base units. */
    amount: string;
    decimals: number;
    symbol: string;
    /** CAIP-19 id of a tracked token; null for the network's coin. */
    tokenId: string | null;
  } | null;
  /**
   * Where it was submitted from (aa.ts AaOperationKind). Absent in records
   * stored before phase 20, which only the Send screen wrote: read as 'send'
   * (userOpOrigin).
   */
  origin?: AaOperationKind;
}

/** Every submission path a stored record may name (the strict parse accepts only these). */
export const USEROP_ORIGINS: readonly AaOperationKind[] = [
  'send',
  'swap',
  'staking',
  'session-setup',
  'session-op',
  'recurring-payment',
  'dca-swap',
  'walletconnect',
  'browser',
  'multisig',
  'other',
];

/** Where a stored operation came from; records written before phase 20 came from Send. */
export function userOpOrigin(record: Pick<PendingUserOpRecord, 'origin'>): AaOperationKind {
  return record.origin ?? 'send';
}

/** What happened to a nonce that had a replacement, kept briefly for display. */
export type ResolvedOutcome = 'replaced' | 'cancelled' | 'original-first';

export interface ResolvedRecord {
  kind: 'resolved';
  chain: string;
  from: string;
  nonce: string;
  outcome: ResolvedOutcome;
  /** The hash a block included. */
  minedHash: string;
  /** Decimal block number. */
  block: string;
  /** False when the included transaction reverted; null when no receipt was returned. */
  success: boolean | null;
  /** The wallet's original transaction for this nonce. */
  original: string;
  /** Every hash broadcast for this nonce, oldest first. */
  hashes: string[];
  /** Unix milliseconds. */
  resolvedAt: number;
}

export type PendingRecord = PendingTxRecord | PendingUserOpRecord | ResolvedRecord;

export interface PendingRegistry {
  records: PendingRecord[];
  /** True when the stored document could not be fully read; writes are refused. */
  readOnly: boolean;
}

/** The store: AsyncStorage satisfies it; removeItem is used by the reset when present. */
export type PendingStore = KeyValueStore & { removeItem?: (key: string) => Promise<void> };

/** Refusal for a write to a damaged registry. */
export const PENDING_READ_ONLY_MESSAGE =
  'The list of pending transactions on this phone could not be read, so it was not changed. ' +
  'Reset the pending list on the Activity screen to start a new one; nothing on the network changes.';

// ---------------------------------------------------------------------------
// The replacement fee rule
// ---------------------------------------------------------------------------

/**
 * The smallest fee a replacement may carry for one fee field: strictly above
 * the pooled one (go-ethereum) and at least 10% above it, rounded UP (reth;
 * go-ethereum's rounded-down threshold is then met too). Exact bigint.
 */
export function bumpedMinimum(old: bigint): bigint {
  if (old < 0n) throw new Error('A fee cannot be negative.');
  const ceilBump = (old * (100n + PRICE_BUMP_PERCENT) + 99n) / 100n;
  const plusOne = old + 1n;
  return ceilBump > plusOne ? ceilBump : plusOne;
}

/**
 * True when (maxFee, maxPriority) would replace (oldMaxFee, oldPriority)
 * under BOTH clients' rules (the check the pools make, mirrored exactly).
 */
export function meetsReplacementRule(
  old: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  next: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): boolean {
  return (
    next.maxFeePerGas >= bumpedMinimum(old.maxFeePerGas) &&
    next.maxPriorityFeePerGas >= bumpedMinimum(old.maxPriorityFeePerGas)
  );
}

export interface ReplacementFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The bumped minimums over the pooled transaction. */
  minimum: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** The node's current suggestion that was compared with them. */
  suggested: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
}

/**
 * Fees for a replacement: per field, the larger of the bumped minimum over
 * the transaction now in the pool (`pooled`: the highest fees broadcast for
 * this nonce so far) and the node's current suggestion. A transaction's
 * priority fee may not exceed its max fee (EIP-1559: "maxPriorityFeePerGas
 * <= maxFeePerGas"), so the max fee is raised to the priority fee when the
 * suggestion's priority is the larger figure.
 */
export function replacementFees(
  pooled: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  suggested: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): ReplacementFees {
  const minimum = {
    maxFeePerGas: bumpedMinimum(pooled.maxFeePerGas),
    maxPriorityFeePerGas: bumpedMinimum(pooled.maxPriorityFeePerGas),
  };
  const maxPriorityFeePerGas =
    suggested.maxPriorityFeePerGas > minimum.maxPriorityFeePerGas
      ? suggested.maxPriorityFeePerGas
      : minimum.maxPriorityFeePerGas;
  let maxFeePerGas = suggested.maxFeePerGas > minimum.maxFeePerGas ? suggested.maxFeePerGas : minimum.maxFeePerGas;
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
  return {
    maxFeePerGas,
    maxPriorityFeePerGas,
    minimum,
    suggested: { maxFeePerGas: suggested.maxFeePerGas, maxPriorityFeePerGas: suggested.maxPriorityFeePerGas },
  };
}

/** The highest fees broadcast for one nonce (what the pool holds if it holds any of them). */
export function pooledFees(group: readonly PendingTxRecord[]): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  let maxFeePerGas = 0n;
  let maxPriorityFeePerGas = 0n;
  for (const r of group) {
    const fee = BigInt(r.maxFeePerGas);
    const tip = BigInt(r.maxPriorityFeePerGas);
    if (fee > maxFeePerGas) maxFeePerGas = fee;
    if (tip > maxPriorityFeePerGas) maxPriorityFeePerGas = tip;
  }
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * What a replacement counts against the app's spending limits: its network
 * fee, never its value. A speed-up re-sends a value that was already counted
 * when the original was accepted (only one of the two can ever be included),
 * and a cancellation sends 0. The fee is counted in full, as for any send
 * (it matters only for a limit on the network's coin with "count network
 * fees" on); this is conservative, because at most one of the fees for a
 * nonce is ever paid.
 */
export function replacementSpendingInput(quote: Pick<EvmSendQuote, 'fee'> & { from: string }): {
  spender: string;
  calls: { to: string; value: bigint }[];
  fee: bigint;
} {
  return { spender: quote.from, calls: [], fee: quote.fee };
}

/** The biometric prompt for each action. */
export function replacementPromptTitle(action: ReplacementAction): string {
  return action === 'speed-up' ? 'Approve speeding up the transaction' : 'Approve cancelling the transaction';
}

// ---------------------------------------------------------------------------
// User-facing sentences
// ---------------------------------------------------------------------------

export function alreadyIncludedSentence(block: bigint | string): string {
  return `This transaction is already included in block ${block.toString()}.`;
}

export function nonceUsedSentence(nonce: bigint | string): string {
  return (
    `This transaction is no longer pending: the network already counts a transaction with nonce ${nonce.toString()} ` +
    'from this account, but did not return a receipt for any transaction this wallet sent with that nonce. ' +
    'It may have been replaced outside this wallet. Nothing was signed.'
  );
}

export const ORIGINAL_MINED_FIRST_SENTENCE =
  'The original transaction was included before the replacement; the replacement will be rejected by the network.';

export const REPLACEMENT_UNDERPRICED_SENTENCE =
  'The network refused the replacement because its fees were not high enough to replace the pending ' +
  'transaction (each fee must be at least 10% higher). Nothing else was sent. Review again to price it afresh.';

export const REPLACEMENT_QUOTE_USED =
  'This replacement was already submitted once with these fees. Nothing was signed; review it again so it is ' +
  'priced afresh.';

export const REPLACEMENT_FEES_STALE =
  'Another transaction for this nonce was sent since this replacement was priced, so its fees are no longer ' +
  'high enough to replace it. Nothing was signed; review it again.';

export const CANCEL_EXPLAINER =
  'Cancelling sends 0 to your own address with the same nonce and a higher fee. If a block includes the ' +
  'cancellation first, the original transaction can never be included. You pay the network fee of whichever ' +
  'one is included. It can fail: if the original is included first, the cancellation is rejected.';

export const SPEED_UP_EXPLAINER =
  'Speeding up signs the same transaction again — same nonce, recipient, amount, data and gas limit — with ' +
  'higher fees. Only one of the two can be included; you pay the network fee of that one.';

export function cancelRiskLine(address: string): string {
  return `This cancellation sends 0 to yourself (${address}), the account it comes from. Only the network fee is paid.`;
}

export const REPLACEMENT_SPENDING_NOTE =
  "Spending limits: the amount is not counted again (it was counted when the original was sent); this " +
  "replacement's network fee is counted like any send.";

export const SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE =
  'A smart-account operation cannot be sped up or cancelled from this wallet. Once the bundler accepted it, ' +
  'the bundler holds it and the account’s EntryPoint nonce decides what runs; replacing it would mean asking ' +
  'the same bundler to accept a new operation with the same nonce and fees at least 10% higher, which this ' +
  'wallet does not attempt.';

/**
 * Whether the card still shows SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE: only
 * while the operation may still be pending. Once the status reads
 * "Included …" there is nothing left to speed up or cancel (pass p20b
 * finding 10).
 */
export function userOpShowsNoReplacementSentence(status: Pick<UserOpStatus, 'state'> | null | undefined): boolean {
  return status?.state !== 'included';
}

export const USEROP_RESEND_OFFER =
  'The bundler has had no record of this operation for more than 10 minutes, so it was most likely dropped. ' +
  'You can send it again: the Send screen opens filled in and quotes it afresh; nothing is sent until you ' +
  'confirm. Turn on the smart account there to send it from the smart account again.';

export const USEROP_RESEND_LINE =
  'Filled in again from a smart-account operation the bundler no longer knows. Review it; nothing is sent until you confirm.';

// ---------------------------------------------------------------------------
// Validation and the store
// ---------------------------------------------------------------------------

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DATA = /^0x(?:[0-9a-f]{2})*$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const CHAIN = /^eip155:[1-9][0-9]*$/;
const MAX_DATA_HEX = 2 + 2 * 131072; // 128 KiB of calldata (go-ethereum's txMaxSize)

function isTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function validTx(r: Record<string, unknown>): PendingTxRecord | null {
  const keys = [
    'kind', 'chain', 'hash', 'nonce', 'from', 'to', 'value', 'data',
    'maxFeePerGas', 'maxPriorityFeePerGas', 'gasLimit', 'sentAt', 'action', 'replaces',
  ];
  if (Object.keys(r).length !== keys.length || !keys.every((k) => k in r)) return null;
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const chain = s('chain');
  const hash = s('hash');
  const from = s('from');
  const to = s('to');
  const data = s('data');
  if (!chain || !CHAIN.test(chain) || !hash || !HASH.test(hash) || !from || !ADDRESS.test(from)) return null;
  if (!to || !ADDRESS.test(to) || !data || !DATA.test(data) || data.length > MAX_DATA_HEX) return null;
  for (const k of ['nonce', 'value', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasLimit']) {
    const v = s(k);
    if (!v || !DECIMAL.test(v)) return null;
  }
  if (BigInt(r.maxPriorityFeePerGas as string) > BigInt(r.maxFeePerGas as string)) return null;
  if (!isTime(r.sentAt)) return null;
  if (r.action !== 'send' && r.action !== 'speed-up' && r.action !== 'cancel') return null;
  const replaces = r.replaces;
  if (r.action === 'send' ? replaces !== null : typeof replaces !== 'string' || !HASH.test(replaces)) return null;
  if (r.action === 'cancel' && (to !== from || r.value !== '0' || data !== '0x')) return null;
  return r as unknown as PendingTxRecord;
}

function validUserOp(r: Record<string, unknown>): PendingUserOpRecord | null {
  // Records stored before phase 20 have no `origin`; newer ones have exactly
  // one more key, which must name a known submission path.
  const keys = ['kind', 'chain', 'userOpHash', 'sender', 'owner', 'sentAt', 'resend'];
  if ('origin' in r) {
    if (typeof r.origin !== 'string' || !(USEROP_ORIGINS as readonly string[]).includes(r.origin)) return null;
    keys.push('origin');
  }
  if (Object.keys(r).length !== keys.length || !keys.every((k) => k in r)) return null;
  if (typeof r.chain !== 'string' || !CHAIN.test(r.chain)) return null;
  if (typeof r.userOpHash !== 'string' || !HASH.test(r.userOpHash)) return null;
  if (typeof r.sender !== 'string' || !ADDRESS.test(r.sender)) return null;
  if (typeof r.owner !== 'string' || !ADDRESS.test(r.owner)) return null;
  if (!isTime(r.sentAt)) return null;
  const resend = r.resend;
  if (resend !== null) {
    if (typeof resend !== 'object' || Array.isArray(resend)) return null;
    const x = resend as Record<string, unknown>;
    const rk = ['recipient', 'amount', 'decimals', 'symbol', 'tokenId'];
    if (Object.keys(x).length !== rk.length || !rk.every((k) => k in x)) return null;
    if (typeof x.recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(x.recipient)) return null;
    if (typeof x.amount !== 'string' || !DECIMAL.test(x.amount)) return null;
    if (typeof x.decimals !== 'number' || !Number.isInteger(x.decimals) || x.decimals < 0 || x.decimals > 36) return null;
    if (typeof x.symbol !== 'string' || x.symbol.length === 0 || x.symbol.length > 32) return null;
    if (x.tokenId !== null && (typeof x.tokenId !== 'string' || x.tokenId.length > 200)) return null;
  }
  return r as unknown as PendingUserOpRecord;
}

function validResolved(r: Record<string, unknown>): ResolvedRecord | null {
  const keys = ['kind', 'chain', 'from', 'nonce', 'outcome', 'minedHash', 'block', 'success', 'original', 'hashes', 'resolvedAt'];
  if (Object.keys(r).length !== keys.length || !keys.every((k) => k in r)) return null;
  if (typeof r.chain !== 'string' || !CHAIN.test(r.chain)) return null;
  if (typeof r.from !== 'string' || !ADDRESS.test(r.from)) return null;
  if (typeof r.nonce !== 'string' || !DECIMAL.test(r.nonce)) return null;
  if (r.outcome !== 'replaced' && r.outcome !== 'cancelled' && r.outcome !== 'original-first') return null;
  if (typeof r.minedHash !== 'string' || !HASH.test(r.minedHash)) return null;
  if (typeof r.block !== 'string' || !DECIMAL.test(r.block)) return null;
  if (typeof r.success !== 'boolean' && r.success !== null) return null;
  if (typeof r.original !== 'string' || !HASH.test(r.original)) return null;
  if (!Array.isArray(r.hashes) || r.hashes.length < 2 || r.hashes.length > MAX_PENDING_RECORDS) return null;
  if (!r.hashes.every((h) => typeof h === 'string' && HASH.test(h))) return null;
  if (!r.hashes.includes(r.minedHash) || !r.hashes.includes(r.original)) return null;
  if (!isTime(r.resolvedAt)) return null;
  return r as unknown as ResolvedRecord;
}

/** Strict validation of one stored record; null when anything is off. */
export function validateRecord(value: unknown): PendingRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.kind === 'tx') return validTx(r);
  if (r.kind === 'userop') return validUserOp(r);
  if (r.kind === 'resolved') return validResolved(r);
  return null;
}

/** Parses the stored document: the valid records and whether anything was unreadable. */
export function parseRegistry(raw: string | null): PendingRegistry {
  if (raw === null) return { records: [], readOnly: false };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { records: [], readOnly: true };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { records: [], readOnly: true };
  const d = doc as Record<string, unknown>;
  if (d.version !== STORE_VERSION || !Array.isArray(d.records) || Object.keys(d).length !== 2) {
    return { records: [], readOnly: true };
  }
  const records: PendingRecord[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const item of d.records) {
    const record = validateRecord(item);
    const id = record ? recordId(record) : null;
    if (!record || id === null || seen.has(id)) {
      dropped += 1;
      continue;
    }
    seen.add(id);
    records.push(record);
  }
  if (records.length > MAX_PENDING_RECORDS) return { records: records.slice(0, MAX_PENDING_RECORDS), readOnly: true };
  return { records, readOnly: dropped > 0 };
}

function recordId(r: PendingRecord): string {
  if (r.kind === 'tx') return `tx:${r.chain}:${r.hash}`;
  if (r.kind === 'userop') return `op:${r.chain}:${r.userOpHash}`;
  return `resolved:${r.chain}:${r.from}:${r.nonce}`;
}

const queues = new WeakMap<object, Promise<unknown>>();

/**
 * Reads the registry after every write queued so far has finished, so a
 * screen opened right after a broadcast sees the record the broadcast wrote.
 */
export async function loadPendingRegistry(store: PendingStore = AsyncStorage): Promise<PendingRegistry> {
  await (queues.get(store) ?? Promise.resolve());
  return readRegistry(store);
}

/** The read itself, without waiting for the queue (used INSIDE queued writes, which must not wait for themselves). */
async function readRegistry(store: PendingStore): Promise<PendingRegistry> {
  return parseRegistry(await readStoreItem(store, PENDING_TX_KEY));
}

function serialized<T>(store: object, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(store) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    store,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Drops expired notices, then enforces the cap (resolved first, then oldest pending). */
export function pruneRecords(records: readonly PendingRecord[], nowMs: number): PendingRecord[] {
  let kept = records.filter((r) => r.kind !== 'resolved' || nowMs - r.resolvedAt <= RESOLVED_KEEP_MS);
  if (kept.length <= MAX_PENDING_RECORDS) return kept;
  const timeOf = (r: PendingRecord) => (r.kind === 'resolved' ? r.resolvedAt : r.sentAt);
  const resolvedOldestFirst = kept.filter((r) => r.kind === 'resolved').sort((a, b) => timeOf(a) - timeOf(b));
  const drop = new Set<PendingRecord>();
  for (const r of resolvedOldestFirst) {
    if (kept.length - drop.size <= MAX_PENDING_RECORDS) break;
    drop.add(r);
  }
  kept = kept.filter((r) => !drop.has(r));
  if (kept.length <= MAX_PENDING_RECORDS) return kept;
  const oldestFirst = [...kept].sort((a, b) => timeOf(a) - timeOf(b));
  const excess = new Set(oldestFirst.slice(0, kept.length - MAX_PENDING_RECORDS));
  return kept.filter((r) => !excess.has(r));
}

/**
 * Read-modify-write under the store's queue. Refuses (throws
 * PENDING_READ_ONLY_MESSAGE) when the stored document is damaged.
 */
async function update(
  store: PendingStore,
  change: (records: PendingRecord[]) => PendingRecord[],
  nowMs: number,
): Promise<PendingRecord[]> {
  return serialized(store, async () => {
    const current = await readRegistry(store);
    if (current.readOnly) throw new Error(PENDING_READ_ONLY_MESSAGE);
    const next = pruneRecords(change(current.records), nowMs);
    await writeStoreItem(store, PENDING_TX_KEY, JSON.stringify({ version: STORE_VERSION, records: next }));
    return next;
  });
}

function lower(value: string): string {
  return value.toLowerCase();
}

function hexData(data: Uint8Array | undefined): string {
  if (!data || data.length === 0) return '0x';
  let out = '0x';
  for (const b of data) out += b.toString(16).padStart(2, '0');
  return out;
}

/** The record for a transaction the node just accepted (sendEvm or a replacement). */
export function txRecordFromQuote(
  from: string,
  quote: Pick<
    EvmSendQuote,
    'chainId' | 'nonce' | 'to' | 'amount' | 'data' | 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasLimit'
  >,
  hash: string,
  sentAt: number,
  replacement: { action: ReplacementAction; replaces: string } | null = null,
): PendingTxRecord {
  const record = {
    kind: 'tx' as const,
    chain: `eip155:${quote.chainId.toString()}`,
    hash: lower(hash),
    nonce: quote.nonce.toString(),
    from: lower(from),
    to: lower(quote.to),
    value: quote.amount.toString(),
    data: hexData(quote.data),
    maxFeePerGas: quote.maxFeePerGas.toString(),
    maxPriorityFeePerGas: quote.maxPriorityFeePerGas.toString(),
    gasLimit: quote.gasLimit.toString(),
    sentAt,
    action: replacement ? replacement.action : ('send' as const),
    replaces: replacement ? lower(replacement.replaces) : null,
  };
  if (!validateRecord(record)) throw new Error('The pending transaction could not be recorded (malformed fields).');
  return record;
}

/**
 * Records a broadcast transaction. Best effort: a damaged registry or a
 * storage failure is swallowed (the transaction is already on its way; the
 * Activity screen states that the pending list is damaged).
 */
export async function recordPendingTransaction(
  record: PendingTxRecord,
  store: PendingStore = AsyncStorage,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    await update(
      store,
      (records) => [...records.filter((r) => !(r.kind === 'tx' && r.chain === record.chain && r.hash === record.hash)), record],
      nowMs,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Records a smart-account operation the bundler accepted (best effort, as
 * above). `origin` defaults to 'send' (the Send screen's own passkey path
 * calls this directly). A second record of the same operation replaces the
 * first but never loses what the first knew: a non-null "Send again"
 * pre-fill and a specific origin are kept over null / 'other'.
 */
export async function recordPendingUserOperation(
  record: Omit<PendingUserOpRecord, 'kind' | 'sentAt' | 'origin'> & { sentAt?: number; origin?: AaOperationKind },
  store: PendingStore = AsyncStorage,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const full: PendingUserOpRecord = {
    kind: 'userop',
    chain: record.chain,
    userOpHash: lower(record.userOpHash),
    sender: lower(record.sender),
    owner: lower(record.owner),
    sentAt: record.sentAt ?? nowMs,
    resend: record.resend,
    origin: record.origin ?? 'send',
  };
  if (!validateRecord(full)) return false;
  try {
    await update(
      store,
      (records) => {
        const same = (r: PendingRecord): r is PendingUserOpRecord =>
          r.kind === 'userop' && r.chain === full.chain && r.userOpHash === full.userOpHash;
        const earlier = records.find(same);
        const merged: PendingUserOpRecord = earlier
          ? {
              ...full,
              resend: full.resend ?? earlier.resend,
              origin: full.origin === 'other' ? userOpOrigin(earlier) : full.origin,
            }
          : full;
        return [...records.filter((r) => !same(r)), merged];
      },
      nowMs,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The listener WalletContext registers once with aa.ts
 * addAaOperationSentListener: every smart-account operation the bundler
 * accepted, from any screen, is recorded under the account it belongs to
 * (the event's owner), so Activity's "Pending on this phone" shows its
 * status. Secret-free: the bundler transport in the event is not stored
 * (its URL may carry a project id); "Check status" asks the network's
 * configured bundler. The registry's cap (MAX_PENDING_RECORDS) applies.
 */
export function pendingUserOpRecorder(
  store: PendingStore = AsyncStorage,
): (event: AaOperationSentEvent) => Promise<boolean> {
  return (event) =>
    recordPendingUserOperation(
      {
        chain: event.chain,
        userOpHash: event.userOpHash,
        sender: event.sender,
        owner: event.owner,
        sentAt: event.sentAt,
        resend: event.kind === 'send' ? event.resend : null,
        origin: event.kind,
      },
      store,
      event.sentAt,
    );
}

/** Removes every record of one nonce and, when given, stores its resolved notice. */
export async function settleNonce(
  key: { chain: string; from: string; nonce: string },
  resolved: ResolvedRecord | null,
  store: PendingStore = AsyncStorage,
  nowMs: number = Date.now(),
): Promise<void> {
  const from = lower(key.from);
  await update(
    store,
    (records) => [
      ...records.filter(
        (r) => !((r.kind === 'tx' || r.kind === 'resolved') && r.chain === key.chain && r.from === from && r.nonce === key.nonce),
      ),
      ...(resolved ? [resolved] : []),
    ],
    nowMs,
  );
}

/** Removes one smart-account operation record. */
export async function forgetUserOperation(
  key: { chain: string; userOpHash: string },
  store: PendingStore = AsyncStorage,
  nowMs: number = Date.now(),
): Promise<void> {
  const hash = lower(key.userOpHash);
  await update(store, (records) => records.filter((r) => !(r.kind === 'userop' && r.chain === key.chain && r.userOpHash === hash)), nowMs);
}

/** Clears the whole registry (the "Reset the pending list" action and the wallet wipe). */
export async function resetPendingRegistry(store: PendingStore = AsyncStorage): Promise<void> {
  await serialized(store, async () => {
    if (store.removeItem) await removeStoreItem(store, PENDING_TX_KEY);
    else await writeStoreItem(store, PENDING_TX_KEY, JSON.stringify({ version: STORE_VERSION, records: [] }));
  });
}

// ---------------------------------------------------------------------------
// Groups and resolution
// ---------------------------------------------------------------------------

/** All transactions broadcast for one (chain, sender, nonce), oldest first. */
export interface NonceGroup {
  chain: string;
  from: string;
  nonce: string;
  /** The wallet's original transaction (the oldest 'send'; else the oldest record). */
  original: PendingTxRecord;
  /** Every broadcast, oldest first (original included). */
  txs: PendingTxRecord[];
  /** The newest broadcast (what a further replacement must outbid, with pooledFees). */
  latest: PendingTxRecord;
}

/** The account's pending groups on one chain, lowest nonce first. */
export function nonceGroups(records: readonly PendingRecord[], chain: string, from: string): NonceGroup[] {
  const owner = lower(from);
  const byNonce = new Map<string, PendingTxRecord[]>();
  for (const r of records) {
    if (r.kind !== 'tx' || r.chain !== chain || r.from !== owner) continue;
    const list = byNonce.get(r.nonce) ?? [];
    list.push(r);
    byNonce.set(r.nonce, list);
  }
  const groups: NonceGroup[] = [];
  for (const [nonce, list] of byNonce) {
    const txs = [...list].sort((a, b) => a.sentAt - b.sentAt);
    const original = txs.find((t) => t.action === 'send') ?? txs[0]!;
    groups.push({ chain, from: owner, nonce, original, txs, latest: txs[txs.length - 1]! });
  }
  return groups.sort((a, b) => (BigInt(a.nonce) < BigInt(b.nonce) ? -1 : BigInt(a.nonce) > BigInt(b.nonce) ? 1 : 0));
}

/** The group a hash belongs to (any of its broadcasts). */
export function groupForHash(groups: readonly NonceGroup[], hash: string): NonceGroup | null {
  const h = lower(hash);
  return groups.find((g) => g.txs.some((t) => t.hash === h)) ?? null;
}

/** Read-only chain access the resolution needs (a JSON-RPC transport satisfies it through nodeReader). */
export interface ChainReader {
  /** eth_getTransactionReceipt: null while not included. */
  receipt(hash: string): Promise<{ blockNumber: bigint; success: boolean } | null>;
  /** eth_getTransactionByHash: null when the endpoint does not know it; blockNumber null while pending. */
  transaction(hash: string): Promise<{ blockNumber: bigint | null } | null>;
  /** eth_getTransactionCount(address, tag). */
  nonce(address: string, tag: 'latest' | 'pending'): Promise<bigint>;
}

/** A ChainReader over a JSON-RPC transport. Malformed answers throw. */
export function nodeReader(transport: (method: string, params: unknown[]) => Promise<unknown>): ChainReader {
  const quantity = (v: unknown, what: string): bigint => {
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`Malformed ${what} from the endpoint.`);
    return BigInt(v);
  };
  return {
    async receipt(hash) {
      const r = (await transport('eth_getTransactionReceipt', [hash])) as Record<string, unknown> | null;
      if (r === null || r === undefined) return null;
      if (typeof r !== 'object') throw new Error('Malformed receipt from the endpoint.');
      if (r.blockNumber === null || r.blockNumber === undefined) return null;
      return { blockNumber: quantity(r.blockNumber, 'receipt block number'), success: r.status === '0x1' };
    },
    async transaction(hash) {
      const t = (await transport('eth_getTransactionByHash', [hash])) as Record<string, unknown> | null;
      if (t === null || t === undefined) return null;
      if (typeof t !== 'object') throw new Error('Malformed transaction from the endpoint.');
      return { blockNumber: t.blockNumber === null || t.blockNumber === undefined ? null : quantity(t.blockNumber, 'block number') };
    },
    async nonce(address, tag) {
      return quantity(await transport('eth_getTransactionCount', [address, tag]), 'nonce');
    },
  };
}

export type GroupStatus =
  | {
      state: 'pending';
      /** Hashes the endpoint lists as waiting in its pool. */
      inPool: string[];
      /** eth_getTransactionCount(from, 'latest'): the next nonce a block will use. */
      latestNonce: bigint;
      /** eth_getTransactionCount(from, 'pending'): includes what the endpoint's pool holds. */
      pendingNonce: bigint;
    }
  | {
      state: 'mined';
      hash: string;
      block: bigint;
      /** Null when the endpoint listed the transaction in a block but returned no receipt. */
      success: boolean | null;
      /** Which broadcast a block included, and what that means for the others. */
      outcome: 'mined' | ResolvedOutcome;
      action: PendingTxRecord['action'];
    }
  | { state: 'nonce-used'; latestNonce: bigint };

/**
 * Where one nonce stands: a receipt for any of its broadcasts decides it
 * ('mined', with the outcome — 'original-first' when the original was
 * included although a replacement was sent); without one, a 'latest' nonce
 * above it means the nonce was used by something this wallet has no receipt
 * for ('nonce-used'); otherwise it is 'pending'.
 */
export async function groupStatus(reader: ChainReader, group: NonceGroup): Promise<GroupStatus> {
  for (const tx of [...group.txs].reverse()) {
    // A receipt decides it. Some endpoints answer a null receipt for a
    // transaction they list as included (the phase 18 finding: one backend
    // of the Sepolia default endpoint does), so a transaction with a block
    // number counts as included too, its success then unknown.
    let receipt: { blockNumber: bigint; success: boolean | null } | null = await reader.receipt(tx.hash);
    if (!receipt) {
      const listed = await reader.transaction(tx.hash);
      if (listed && listed.blockNumber !== null) receipt = { blockNumber: listed.blockNumber, success: null };
    }
    if (receipt) {
      const replaced = group.txs.length > 1;
      const outcome: 'mined' | ResolvedOutcome = !replaced
        ? 'mined'
        : tx.action === 'speed-up'
          ? 'replaced'
          : tx.action === 'cancel'
            ? 'cancelled'
            : 'original-first';
      return { state: 'mined', hash: tx.hash, block: receipt.blockNumber, success: receipt.success, outcome, action: tx.action };
    }
  }
  const latestNonce = await reader.nonce(group.from, 'latest');
  if (latestNonce > BigInt(group.nonce)) return { state: 'nonce-used', latestNonce };
  const pendingNonce = await reader.nonce(group.from, 'pending');
  const inPool: string[] = [];
  for (const tx of group.txs) {
    const t = await reader.transaction(tx.hash);
    if (t && t.blockNumber === null) inPool.push(tx.hash);
  }
  return { state: 'pending', inPool, latestNonce, pendingNonce };
}

/** The notice kept after a nonce with a replacement was decided (null when nothing needs saying). */
export function resolvedRecordFor(
  group: NonceGroup,
  status: Extract<GroupStatus, { state: 'mined' }>,
  nowMs: number,
): ResolvedRecord | null {
  if (status.outcome === 'mined') return null;
  return {
    kind: 'resolved',
    chain: group.chain,
    from: group.from,
    nonce: group.nonce,
    outcome: status.outcome,
    minedHash: lower(status.hash),
    block: status.block.toString(),
    success: status.success,
    original: group.original.hash,
    hashes: group.txs.map((t) => t.hash),
    resolvedAt: nowMs,
  };
}

/**
 * Re-reads every pending nonce of one account on one chain, settles the
 * decided ones in the store (removing their records; keeping a notice when
 * a replacement was involved) and returns the statuses. A read failure for
 * one group leaves it untouched (status 'error').
 */
export async function refreshAccountPending(options: {
  reader: ChainReader;
  chain: string;
  from: string;
  store?: PendingStore;
  nowMs?: number;
}): Promise<{ group: NonceGroup; status: GroupStatus | { state: 'error'; message: string } }[]> {
  const store = options.store ?? AsyncStorage;
  const nowMs = options.nowMs ?? Date.now();
  const registry = await loadPendingRegistry(store);
  const groups = nonceGroups(registry.records, options.chain, options.from);
  const out: { group: NonceGroup; status: GroupStatus | { state: 'error'; message: string } }[] = [];
  for (const group of groups) {
    let status: GroupStatus;
    try {
      status = await groupStatus(options.reader, group);
    } catch (e) {
      out.push({ group, status: { state: 'error', message: e instanceof Error ? e.message : String(e) } });
      continue;
    }
    if (status.state === 'mined' && !registry.readOnly) {
      try {
        await settleNonce(group, resolvedRecordFor(group, status, nowMs), store, nowMs);
      } catch {
        // The notice is display only; the next refresh tries again.
      }
    }
    out.push({ group, status });
  }
  return out;
}

/** The resolved notices for one account on one chain, newest first. */
export function resolvedNotices(records: readonly PendingRecord[], chain: string, from: string): ResolvedRecord[] {
  const owner = lower(from);
  return records
    .filter((r): r is ResolvedRecord => r.kind === 'resolved' && r.chain === chain && r.from === owner)
    .sort((a, b) => b.resolvedAt - a.resolvedAt);
}

/** Short form of a hash for sentences ("0x1234…abcd"). */
export function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

/** The sentence of a resolved notice. */
export function resolvedSentence(r: ResolvedRecord): string {
  const reverted = r.success === false ? ' It reverted, so it changed nothing except the fee it paid.' : '';
  if (r.outcome === 'replaced') {
    return (
      `Sped up: transaction ${shortHash(r.original)} (nonce ${r.nonce}) was replaced by ${shortHash(r.minedHash)}, ` +
      `included in block ${r.block}.${reverted}`
    );
  }
  if (r.outcome === 'cancelled') {
    return (
      `Cancelled: the cancellation ${shortHash(r.minedHash)} was included in block ${r.block}, so transaction ` +
      `${shortHash(r.original)} (nonce ${r.nonce}) will never be included.${reverted}`
    );
  }
  return (
    `${ORIGINAL_MINED_FIRST_SENTENCE} Transaction ${shortHash(r.original)} (nonce ${r.nonce}) was included in ` +
    `block ${r.block}.${reverted}`
  );
}

/**
 * The extra line an Activity row of an included replacement carries
 * ("Replaced by …" is said on the original's notice; the row itself, which
 * the history lists, says what it was). Null for any other row.
 */
export function replacementRowLine(records: readonly PendingRecord[], chain: string, id: string): string | null {
  const h = lower(id);
  for (const r of records) {
    if (r.kind !== 'resolved' || r.chain !== chain || r.minedHash !== h) continue;
    if (r.outcome === 'replaced') return `Speed-up of transaction ${shortHash(r.original)} (nonce ${r.nonce}).`;
    if (r.outcome === 'cancelled') return `Cancellation of transaction ${shortHash(r.original)} (nonce ${r.nonce}).`;
    return `Included before its replacement (nonce ${r.nonce}); the replacement was rejected.`;
  }
  return null;
}

/** "Pending: …" line for a group, from the original transaction (amounts exact). */
export function pendingGroupSentence(
  group: NonceGroup,
  options: { nativeSymbol: string; nowMs: number },
): string {
  const tx = group.original;
  const minutes = Math.max(0, Math.floor((options.nowMs - tx.sentAt) / 60_000));
  const age = minutes === 0 ? 'less than a minute ago' : minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const what =
    tx.data === '0x'
      ? `sends ${formatUnits(BigInt(tx.value), 18, 18)} ${options.nativeSymbol} to ${tx.to}`
      : BigInt(tx.value) > 0n
        ? `calls ${tx.to} with ${formatUnits(BigInt(tx.value), 18, 18)} ${options.nativeSymbol}`
        : `calls ${tx.to}`;
  const extra = group.txs.length > 1 ? ` ${group.txs.length - 1} replacement${group.txs.length > 2 ? 's' : ''} sent since.` : '';
  return `Waiting to be included: transaction ${shortHash(tx.hash)} (nonce ${group.nonce}) ${what}, sent ${age}.${extra}`;
}

/** The pool line under a pending group. */
export function poolSentence(status: Extract<GroupStatus, { state: 'pending' }>, group: NonceGroup): string {
  const latest = group.latest.hash;
  if (status.inPool.includes(latest)) return 'The network endpoint lists it as waiting in its pool.';
  if (status.inPool.length > 0) return 'The network endpoint lists an earlier version of it as waiting in its pool.';
  return (
    'The network endpoint does not list it right now. It may still be waiting elsewhere in the network, or it ' +
    'may have been dropped; a speed-up sends it again with higher fees.'
  );
}

/** Fee line ("Max fee 0.000000001 gwei per gas, priority 0.000000001 gwei") for a record. */
export function feeLine(maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): string {
  return `max fee ${formatUnits(maxFeePerGas, 9, 9)} gwei per gas, priority fee ${formatUnits(maxPriorityFeePerGas, 9, 9)} gwei`;
}

// ---------------------------------------------------------------------------
// Smart-account operations
// ---------------------------------------------------------------------------

export type UserOpStatus =
  | { state: 'included'; success: boolean | null; txHash: string | null }
  | { state: 'in-bundler' }
  | { state: 'unknown'; resendOffered: boolean };

/**
 * One status read for a smart-account operation through its bundler:
 * eth_getUserOperationReceipt (null "in case the UserOperation is not yet
 * included in a block"), then eth_getUserOperationByHash, which per
 * ERC-7769 (ethereum/ERCs 0578f46b, ERCS/erc-7769.md lines 218–235) returns
 * the operation with a null blockNumber while it is pending in the bundler's
 * mempool — or MAY return null then — and null otherwise. So a null answer
 * cannot prove the operation was dropped; only after
 * USEROP_UNKNOWN_AFTER_MS of no record at all is "Send again" offered.
 */
export async function checkUserOperation(
  bundler: (method: string, params: unknown[]) => Promise<unknown>,
  record: Pick<PendingUserOpRecord, 'userOpHash' | 'sentAt'>,
  nowMs: number,
): Promise<UserOpStatus> {
  const receipt = (await bundler('eth_getUserOperationReceipt', [record.userOpHash])) as Record<string, unknown> | null;
  if (receipt && typeof receipt === 'object') {
    const success = typeof receipt.success === 'boolean' ? receipt.success : receipt.success === '0x1' ? true : receipt.success === '0x0' ? false : null;
    const inner = receipt.receipt as Record<string, unknown> | undefined;
    const txHash =
      inner && typeof inner.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(inner.transactionHash)
        ? inner.transactionHash
        : null;
    return { state: 'included', success, txHash };
  }
  let op: unknown = null;
  try {
    op = await bundler('eth_getUserOperationByHash', [record.userOpHash]);
  } catch {
    // Some bundlers do not serve the lookup; treat as "no record".
    op = null;
  }
  if (op && typeof op === 'object') return { state: 'in-bundler' };
  return { state: 'unknown', resendOffered: nowMs - record.sentAt >= USEROP_UNKNOWN_AFTER_MS };
}

/**
 * The status line for a smart-account operation. For a dropped one, "Send
 * again" is offered only for an operation from the Send screen with a
 * pre-fill (userOpCanBeSentAgain); every other operation's line says where
 * to try again instead (USEROP_RETRY_SENTENCES). Without `record` the old
 * Send-screen wording is kept.
 */
export function userOpStatusSentence(
  status: UserOpStatus,
  record?: Pick<PendingUserOpRecord, 'origin' | 'resend'>,
): string {
  if (status.state === 'included') {
    return status.success === false
      ? 'Included, but the operation reverted.'
      : `Included${status.txHash ? ` in transaction ${shortHash(status.txHash)}` : ''}.`;
  }
  if (status.state === 'in-bundler') return 'The bundler still holds it and has not included it yet.';
  if (!status.resendOffered) {
    return 'The bundler has no record of it right now. That can mean it is still waiting or that it was dropped; check again in a few minutes.';
  }
  if (!record || userOpCanBeSentAgain(record)) return USEROP_RESEND_OFFER;
  return `${USEROP_DROPPED_SENTENCE} ${USEROP_RETRY_SENTENCES[userOpOrigin(record)]}`;
}

/** True only where a re-quote path exists: an operation from the Send screen that it can fill in again. */
export function userOpCanBeSentAgain(record: Pick<PendingUserOpRecord, 'origin' | 'resend'>): boolean {
  return userOpOrigin(record) === 'send' && record.resend !== null;
}

export const USEROP_DROPPED_SENTENCE =
  'The bundler has had no record of this operation for more than 10 minutes, so it was most likely dropped.';

/** Where to try again, per submission path (shown after USEROP_DROPPED_SENTENCE). */
export const USEROP_RETRY_SENTENCES: Readonly<Record<AaOperationKind, string>> = {
  send: 'To try again, open Send and enter it again; this operation cannot be filled in again automatically.',
  swap: 'To try again, open Swap and get a new quote; nothing is resent from here.',
  staking: 'To try again, open Staking and review it again; nothing is resent from here.',
  'session-setup':
    'To try again, open Sessions and check the key there before setting it up or revoking it again; nothing is resent from here.',
  'session-op': 'To try again, open Sessions and send it again from the session; nothing is resent from here.',
  'recurring-payment':
    'Open Sessions: it reads from the chain whether the payment counted and offers it again while it is due. Nothing is resent from here.',
  'dca-swap':
    'Open Sessions: it reads from the chain whether the swap counted and offers it again while it is due. Nothing is resent from here.',
  walletconnect: 'To try again, ask the app to send the request again; this wallet cannot resend an app’s request from here.',
  browser: 'To try again, open the app in the in-app browser (Apps) and send it again from there; nothing is resent from here.',
  multisig:
    'To try again, open Multisig and build the operation again; the co-signers approve the new request. Nothing is resent from here.',
  other: 'To try again, go back to the screen you sent it from and review it again; nothing is resent from here.',
};

/** How the card names where an operation came from (none for 'other'). */
export const USEROP_ORIGIN_PHRASES: Readonly<Record<AaOperationKind, string>> = {
  send: 'from Send',
  swap: 'from Swap',
  staking: 'from Staking',
  'session-setup': 'from Sessions (setting up or revoking a key)',
  'session-op': 'signed by a session key from Sessions',
  'recurring-payment': 'a recurring payment signed by its payment key',
  'dca-swap': 'a recurring swap signed by its swap key',
  walletconnect: 'requested by an app connected through WalletConnect',
  browser: 'requested by an app in the in-app browser',
  multisig: 'submitted for a multisig account',
  other: '',
};

/**
 * The card's first line. An operation from Send with a pre-fill keeps the
 * phase 19 wording ("…: 0.5 USDC to 0x…"); every other one names where it
 * came from, e.g. "Smart-account operation 0x1234…abcd from Swap."
 */
export function userOpCardTitle(record: Pick<PendingUserOpRecord, 'userOpHash' | 'origin' | 'resend'>): string {
  const head = `Smart-account operation ${shortHash(record.userOpHash)}`;
  if (record.resend) {
    return `${head}: ${formatUnits(BigInt(record.resend.amount), record.resend.decimals, record.resend.decimals)} ${record.resend.symbol} to ${record.resend.recipient}.`;
  }
  const phrase = USEROP_ORIGIN_PHRASES[userOpOrigin(record)];
  return phrase ? `${head} ${phrase}.` : `${head}.`;
}

/**
 * What "Send again" can pre-fill for a smart-account operation from the Send
 * screen: a token transfer (its recipient and amount) or a plain native
 * transfer (one call, no calldata). Null for anything else (an NFT, a
 * batch), which then offers no "Send again".
 */
export function userOpResendFor(
  quote: Pick<AaSendQuote, 'to' | 'amount' | 'calls' | 'token'>,
  options: { nativeSymbol: string; nativeDecimals: number; tokenId: string | null; nft: boolean },
): PendingUserOpRecord['resend'] {
  if (options.nft) return null;
  if (quote.token) {
    if (!options.tokenId) return null;
    return {
      recipient: quote.token.recipient,
      amount: quote.token.amount.toString(),
      decimals: quote.token.decimals,
      symbol: quote.token.symbol,
      tokenId: options.tokenId,
    };
  }
  const userCalls = quote.calls.filter((c) => !(c.data && c.data.length > 0));
  if (userCalls.length !== 1 || quote.calls.length !== 1 || quote.amount <= 0n) return null;
  return {
    recipient: quote.to,
    amount: quote.amount.toString(),
    decimals: options.nativeDecimals,
    symbol: options.nativeSymbol,
    tokenId: null,
  };
}

/** Smart-account records of one owner on one chain, newest first. */
export function userOpsFor(records: readonly PendingRecord[], chain: string, owner: string): PendingUserOpRecord[] {
  const o = lower(owner);
  return records
    .filter((r): r is PendingUserOpRecord => r.kind === 'userop' && r.chain === chain && r.owner === o)
    .sort((a, b) => b.sentAt - a.sentAt);
}

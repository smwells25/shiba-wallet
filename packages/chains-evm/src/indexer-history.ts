import type { HistoryEntry, HistoryPage, HistoryProvider } from '@shiba-wallet/core';
import { isEip7708TransferLogAddress } from './asset-diff.js';
import type { JsonRpcTransport } from './rpc.js';

/**
 * EVM transaction history through an indexer endpoint that serves the
 * `alchemy_getAssetTransfers` method (Alchemy's Transfers API; the method
 * name is vendor-coined, but any endpoint implementing it works — the
 * provider takes an injected transport and hardcodes no vendor URL).
 *
 * Request/response shapes verified 2026-09-27 against the official
 * reference, plus one live read-only probe against a real endpoint:
 *   https://www.alchemy.com/docs/reference/alchemy-getassettransfers
 *   (canonical page: https://www.alchemy.com/docs/data/transfers-api/
 *    transfers-endpoints/alchemy-get-asset-transfers)
 *   https://www.alchemy.com/docs/reference/transfers-api-quickstart
 *
 * Documented facts this module relies on:
 *  - Params object: fromBlock/toBlock (hex or "latest"), fromAddress OR
 *    toAddress filters, category (array of "external" | "internal" |
 *    "erc20" | "erc721" | "erc1155" | "specialnft"), maxCount (hex string,
 *    default 0x3e8 = 1000), order ("asc"/"desc" by block number), pageKey
 *    (cursor from the previous response; the quickstart documents a 10
 *    minute TTL), withMetadata (must be true to get
 *    metadata.blockTimestamp, an ISO-8601 string).
 *  - Response: { transfers: [...], pageKey? } where pageKey is omitted or
 *    empty when the query is exhausted (live probe returned a UUID string
 *    when more results existed).
 *  - Each transfer: hash, blockNum (hex), from, to (nullable), value
 *    (decimal JSON number or null), asset (symbol string or null),
 *    category, uniqueId ("<hash>:external", "<hash>:log:<logIndex>",
 *    "<hash>:internal:<traceAddress>" — observed live), rawContract
 *    { value: hex string or null, address, decimal }.
 *
 * PRECISION: the API's `value` field is a decimal JSON number — the live
 * probe returned literals like `4e-18`, and a double cannot represent wei
 * amounts above 2^53 exactly. This module therefore NEVER derives amounts
 * from `value`. Native (external/internal) amounts come exclusively from
 * rawContract.value, which is the exact hex base-unit amount (live probe:
 * value 1.0 ETH came with rawContract.value 0xde0b6b3a7640000 = 10^18
 * wei exactly). When rawContract.value is absent, the entry carries no
 * amount rather than an approximation.
 *
 * LIMITS this pass, stated honestly:
 *  - Token transfers (erc20/erc721/erc1155) map to entries WITHOUT a
 *    native amount; they keep the correct id, uid, timestamp, direction,
 *    the API-reported asset symbol for display, the exact erc20 amount in
 *    its own decimals (assetAmount / assetDecimals) when rawContract gives
 *    both, and the token's contract (HistoryEntry.contract, lowercased from
 *    rawContract.address) when it is a 20-byte hex address. The symbol is
 *    whatever the token contract calls itself; the contract is what tells a
 *    look-alike apart. "specialnft" is not queried by default and gets no
 *    contract here.
 *  - Failed-transaction detection is NOT available: the Transfers API
 *    reports value movements, not receipts. A reverted transaction moves
 *    nothing, but the API can still list its top-level ETH transfer as an
 *    "external" transfer: on 2026-10-11 it listed Sepolia transaction
 *    0x8b7463c4…8871e (receipt status 0x0, read on two endpoints) as a
 *    received 0.003 ETH. Entries are never marked `failed` here and fees
 *    are not reported; a caller that decodes the receipt (the app's
 *    Activity list) must apply the receipt's status itself.
 *  - EIP-7708 protocol logs (Glamsterdam; active on Sepolia since
 *    2026-10-06, see asset-diff.ts): the protocol logs every nonzero ETH
 *    transfer as a Transfer event from the system address 0xff…fe, and the
 *    API reports each such log as an "erc20" transfer whose
 *    rawContract.address is that system address. A raw answer read on
 *    2026-10-11 (test/fixtures/indexer-history/) showed, for one
 *    smart-account bundle, every ETH movement twice: once as "internal"
 *    (uniqueId "<hash>:internal:<trace>", asset "ETH", rawContract.value =
 *    the exact wei, decimal "0x12") and once as "erc20" (uniqueId
 *    "<hash>:log:<n>", value null, asset "", rawContract.value = the same
 *    wei — equal to the log's data word — and decimal null). Such a log is
 *    NOT a token transfer, so this provider reconciles them per query
 *    (reconcileProtocolLogs): a log matching a native transfer of the same
 *    transaction (same hash, same from and to, same amount) is dropped; an
 *    unmatched log with a readable rawContract.value becomes a NATIVE
 *    entry (so an ETH movement the native categories missed is not lost);
 *    an unmatched log without a readable amount is dropped and counted in
 *    the page's `omitted` diagnostics. Matching continues across a page
 *    boundary through the cursor (see CursorState.co / .ci).
 *  - The two direction streams (sent/received) paginate independently, so
 *    across a page boundary an older received entry can arrive after a
 *    newer sent entry already shown. Each page itself is sorted
 *    newest-first, but one page can already mix time ranges (the sent
 *    side may reach older blocks than the received side). A caller that
 *    needs the whole list in time order uses the one-sided providers
 *    (options.direction), each one stream in block order, and merges them
 *    itself (the app's Activity list does, since 2026-10-11).
 */

export type TransferCategory =
  | 'external'
  | 'internal'
  | 'erc20'
  | 'erc721'
  | 'erc1155'
  | 'specialnft';

/** The default query set: every category the wallet can render today. */
export const DEFAULT_TRANSFER_CATEGORIES: TransferCategory[] = [
  'external',
  'internal',
  'erc20',
  'erc721',
  'erc1155',
];

/** The documented subset of one transfer object this provider reads. */
interface RawTransfer {
  hash: string;
  blockNum: string;
  from: string;
  to: string | null;
  category: string;
  uniqueId?: string;
  asset?: string | null;
  rawContract?: { value?: string | null; address?: string | null; decimal?: string | null };
  metadata?: { blockTimestamp?: string };
}

interface RawResult {
  transfers: RawTransfer[];
  pageKey?: string;
}

export interface IndexerHistoryOptions {
  /** maxCount per direction query (the merged page can hold up to 2×). */
  pageSize?: number;
  categories?: TransferCategory[];
  /**
   * Which side of the address to list: 'both' (the default, unchanged —
   * the fromAddress and toAddress queries merged per page), 'sent' (only
   * the fromAddress query) or 'received' (only the toAddress query). A
   * one-sided provider is ONE stream ordered by block, newest first (the
   * API's order "desc"), so a caller that merges several of them by time
   * can tell exactly how far each has been read; the two-sided provider
   * cannot, because its two queries page independently (see LIMITS
   * above). A self-transfer is listed by both one-sided providers with the
   * same uid. The cursor format is the same; a one-sided provider never
   * queries the other side, whatever its cursor holds.
   */
  direction?: 'both' | 'sent' | 'received';
}

/**
 * One ETH movement still waiting for its counterpart across a page
 * boundary (reconcileProtocolLogs): the transaction hash, from, to
 * (lowercase), the exact amount in wei as a decimal string (null when the
 * API gave none), the block number, and whether it was a native transfer
 * ('n') or an EIP-7708 log already turned into a native entry ('l').
 */
interface CarryItem {
  h: string;
  f: string;
  t: string;
  a: string | null;
  b: string;
  k: 'n' | 'l';
}

/** At most this many carried movements per direction (judgement: a page boundary splits one block). */
const MAX_CARRY_ITEMS = 64;

/**
 * Opaque cursor: the pair of per-direction pageKeys, JSON-encoded. A
 * direction absent from the cursor is exhausted and is not queried again.
 * `co` / `ci` (sent / received side) carry the unmatched ETH movements of
 * the page's oldest block, present only when that side's page held EIP-7708
 * protocol logs (or received a carry itself), so a cursor of a chain or
 * history without them is exactly what it was before they existed.
 */
interface CursorState {
  v: 1;
  out?: string;
  in?: string;
  co?: CarryItem[];
  ci?: CarryItem[];
}

function encodeCursor(state: {
  out?: string;
  in?: string;
  co?: CarryItem[];
  ci?: CarryItem[];
}): string | undefined {
  if (state.out === undefined && state.in === undefined) return undefined;
  return JSON.stringify({
    v: 1,
    ...(state.out !== undefined ? { out: state.out } : {}),
    ...(state.in !== undefined ? { in: state.in } : {}),
    // A carry is kept only for a side that has a next page.
    ...(state.out !== undefined && state.co?.length ? { co: state.co } : {}),
    ...(state.in !== undefined && state.ci?.length ? { ci: state.ci } : {}),
  });
}

function isCarryItem(value: unknown): value is CarryItem {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.h === 'string' &&
    typeof c.f === 'string' &&
    typeof c.t === 'string' &&
    (c.a === null || (typeof c.a === 'string' && /^[0-9]+$/.test(c.a))) &&
    typeof c.b === 'string' &&
    (c.k === 'n' || c.k === 'l')
  );
}

function decodeCarry(value: unknown): CarryItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CARRY_ITEMS || !value.every(isCarryItem)) {
    throw new Error('Unrecognized history cursor');
  }
  return value;
}

function decodeCursor(cursor: string): CursorState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new Error('Unrecognized history cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { v?: unknown }).v !== 1
  ) {
    throw new Error('Unrecognized history cursor');
  }
  const p = parsed as { v: 1; out?: unknown; in?: unknown; co?: unknown; ci?: unknown };
  const co = decodeCarry(p.co);
  const ci = decodeCarry(p.ci);
  return {
    v: 1,
    ...(typeof p.out === 'string' ? { out: p.out } : {}),
    ...(typeof p.in === 'string' ? { in: p.in } : {}),
    ...(co ? { co } : {}),
    ...(ci ? { ci } : {}),
  };
}

const NATIVE_CATEGORIES = new Set(['external', 'internal']);
/** Categories whose rawContract.address names the token contract (HistoryEntry.contract). */
const TOKEN_CATEGORIES = new Set(['erc20', 'erc721', 'erc1155']);
const HEX_VALUE = /^0x[0-9a-fA-F]+$/;

/** True for an "erc20" transfer that is really an EIP-7708 protocol log of an ETH movement. */
function isProtocolLog(transfer: RawTransfer): boolean {
  const contract = transfer.rawContract?.address;
  return transfer.category === 'erc20' && typeof contract === 'string' && isEip7708TransferLogAddress(contract);
}

/** The exact amount in rawContract.value, or null when absent or not hex. */
function rawAmount(transfer: RawTransfer): bigint | null {
  const raw = transfer.rawContract?.value;
  return raw && HEX_VALUE.test(raw) ? BigInt(raw) : null;
}

/** How many entries a page left out, by reason (HistoryPage.omitted). */
type OmittedCounts = Record<'eip7708-duplicate' | 'eip7708-unreadable', number>;

interface Reconciled {
  /** The transfers to map, in the API's order; `native` marks a converted protocol log. */
  kept: { transfer: RawTransfer; native: boolean }[];
  omitted: OmittedCounts;
  /** What the next page of this side must still match (see CarryItem). */
  carry: CarryItem[];
}

/**
 * Reconciles one query's answer with EIP-7708 protocol logs (see LIMITS in
 * the module comment). Every transfer that is not a protocol log is kept
 * as it was, in the same order, so an answer without protocol logs maps to
 * exactly the entries it always did. One-to-one matching: each native
 * transfer (or carried movement) absorbs at most one protocol log with the
 * same transaction hash, from and to, and the same amount (a native
 * transfer whose amount the API did not give matches any amount). A native
 * transfer arriving after a protocol log of the previous page was already
 * turned into a native entry is dropped as that entry's duplicate.
 */
function reconcileProtocolLogs(transfers: RawTransfer[], incoming: CarryItem[]): Reconciled {
  const omitted: OmittedCounts = { 'eip7708-duplicate': 0, 'eip7708-unreadable': 0 };
  const hasProtocolLog = transfers.some(isProtocolLog);
  if (!hasProtocolLog && incoming.length === 0) {
    return { kept: transfers.map((transfer) => ({ transfer, native: false })), omitted, carry: [] };
  }
  const lower = (a: string | null | undefined) => (typeof a === 'string' ? a.toLowerCase() : '');
  const keyOf = (h: string, f: string, t: string) => `${h.toLowerCase()}|${f}|${t}`;
  const blockOf = (t: RawTransfer) => {
    try {
      return BigInt(t.blockNum).toString();
    } catch {
      return '';
    }
  };

  // Natives able to absorb a protocol log: carried ones first, then this page's.
  type Pool = { amount: bigint | null; carried: CarryItem | null; transfer: RawTransfer | null; used: boolean };
  const pools = new Map<string, Pool[]>();
  const addPool = (key: string, pool: Pool) => {
    const list = pools.get(key) ?? [];
    list.push(pool);
    pools.set(key, list);
  };
  // Converted logs of the previous page, waiting for a native duplicate.
  const convertedCarry = new Map<string, CarryItem[]>();
  const carriedNatives: Pool[] = [];
  for (const item of incoming) {
    const key = keyOf(item.h, item.f, item.t);
    if (item.k === 'l') {
      convertedCarry.set(key, [...(convertedCarry.get(key) ?? []), item]);
    } else {
      const pool: Pool = { amount: item.a === null ? null : BigInt(item.a), carried: item, transfer: null, used: false };
      carriedNatives.push(pool);
      addPool(key, pool);
    }
  }

  const dropped = new Set<RawTransfer>();
  const nativePools: Pool[] = [];
  for (const t of transfers) {
    if (!NATIVE_CATEGORIES.has(t.category)) continue;
    const key = keyOf(t.hash, lower(t.from), lower(t.to));
    const amount = rawAmount(t);
    const waiting = convertedCarry.get(key);
    const twin = waiting?.findIndex((c) => c.a === null || amount === null || BigInt(c.a) === amount) ?? -1;
    if (waiting && twin >= 0) {
      // The previous page already listed this movement from its protocol log.
      waiting.splice(twin, 1);
      dropped.add(t);
      omitted['eip7708-duplicate'] += 1;
      continue;
    }
    const pool: Pool = { amount, carried: null, transfer: t, used: false };
    nativePools.push(pool);
    addPool(key, pool);
  }

  const converted = new Set<RawTransfer>();
  for (const t of transfers) {
    if (!isProtocolLog(t)) continue;
    const key = keyOf(t.hash, lower(t.from), lower(t.to));
    const amount = rawAmount(t);
    const candidates = (pools.get(key) ?? []).filter((p) => !p.used);
    const match =
      candidates.find((p) => amount !== null && p.amount === amount) ??
      candidates.find((p) => p.amount === null || amount === null);
    dropped.add(t);
    if (match) {
      match.used = true;
      omitted['eip7708-duplicate'] += 1;
    } else if (amount !== null) {
      dropped.delete(t);
      converted.add(t);
    } else {
      omitted['eip7708-unreadable'] += 1;
    }
  }

  // Carry what is still unmatched in the page's oldest block (the next page
  // of this side may continue that block).
  let oldest: bigint | null = null;
  for (const t of transfers) {
    try {
      const b = BigInt(t.blockNum);
      if (oldest === null || b < oldest) oldest = b;
    } catch {
      // An unreadable block number is never carried.
    }
  }
  const carry: CarryItem[] = [];
  if (oldest !== null) {
    const ob = oldest.toString();
    for (const pool of carriedNatives) {
      if (!pool.used && pool.carried && pool.carried.b === ob) carry.push(pool.carried);
    }
    for (const list of convertedCarry.values()) for (const item of list) if (item.b === ob) carry.push(item);
    for (const pool of nativePools) {
      const t = pool.transfer!;
      if (pool.used || blockOf(t) !== ob) continue;
      if (pool.amount === 0n || lower(t.from) === lower(t.to)) continue; // EIP-7708 logs neither
      carry.push({ h: t.hash.toLowerCase(), f: lower(t.from), t: lower(t.to), a: pool.amount === null ? null : pool.amount.toString(), b: ob, k: 'n' });
    }
    for (const t of converted) {
      if (blockOf(t) !== ob) continue;
      const amount = rawAmount(t);
      carry.push({ h: t.hash.toLowerCase(), f: lower(t.from), t: lower(t.to), a: amount === null ? null : amount.toString(), b: ob, k: 'l' });
    }
  }

  return {
    kept: transfers.filter((t) => !dropped.has(t)).map((transfer) => ({ transfer, native: converted.has(transfer) })),
    omitted,
    carry: carry.slice(0, MAX_CARRY_ITEMS),
  };
}

function mapTransfer(transfer: RawTransfer, me: string, asNative = false): HistoryEntry {
  const from = transfer.from?.toLowerCase();
  const to = transfer.to?.toLowerCase() ?? null;
  const direction: HistoryEntry['direction'] =
    from === me && to === me ? 'self' : from === me ? 'out' : 'in';

  // metadata.blockTimestamp is ISO-8601 (withMetadata: true). Anything
  // unparseable renders as timestamp-less rather than a wrong date.
  let timestamp: number | null = null;
  const iso = transfer.metadata?.blockTimestamp;
  if (iso) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) timestamp = Math.floor(ms / 1000);
  }

  let blockHeight: number | undefined;
  try {
    blockHeight = Number(BigInt(transfer.blockNum));
  } catch {
    blockHeight = undefined;
  }

  // Exact base-unit amount from rawContract.value only (see the precision
  // note above). Native categories fill `amount`; erc20 transfers fill
  // assetAmount/assetDecimals instead (their own base units, decimals
  // from rawContract.decimal), so renderers can show exact token values.
  let amount: bigint | undefined;
  let assetAmount: bigint | undefined;
  let assetDecimals: number | undefined;
  // A converted EIP-7708 protocol log (asNative) is an ETH movement.
  const native = asNative || NATIVE_CATEGORIES.has(transfer.category);
  const rawValue = transfer.rawContract?.value;
  if (rawValue && HEX_VALUE.test(rawValue)) {
    if (native) {
      amount = BigInt(rawValue);
    } else if (transfer.category === 'erc20') {
      const rawDecimals = transfer.rawContract?.decimal;
      if (rawDecimals && HEX_VALUE.test(rawDecimals)) {
        const parsed = Number(BigInt(rawDecimals));
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 77) {
          assetAmount = BigInt(rawValue);
          assetDecimals = parsed;
        }
      }
    }
  }

  // The other side of the movement, as the indexer reports it (lowercase,
  // as the API returns addresses). Absent when the API gave none (a
  // contract creation has no `to`).
  const counterparty = direction === 'in' ? from : direction === 'out' ? to : from;

  const assetSymbol =
    !native && typeof transfer.asset === 'string'
      ? transfer.asset
      : undefined;

  // The token's contract (rawContract.address) for a token category only:
  // native transfers carry null there, and a converted EIP-7708 protocol log
  // (asNative) names the system address 0xff…fe, which is not a token.
  // Lowercased like counterparty (the API answered lowercase addresses in
  // the recorded fixture); anything that is not exactly a 20-byte hex
  // address is left out rather than guessed.
  const rawContractAddress = transfer.rawContract?.address;
  const contract =
    !native && TOKEN_CATEGORIES.has(transfer.category) && typeof rawContractAddress === 'string'
      ? rawContractAddress.toLowerCase()
      : undefined;

  return {
    id: transfer.hash,
    uid: transfer.uniqueId ?? dedupeKey(transfer),
    timestamp,
    // The Transfers API only indexes mined transfers; nothing pending
    // appears, and receipts (and so `failed`) are not available from it.
    confirmed: true,
    ...(blockHeight !== undefined ? { blockHeight } : {}),
    direction,
    ...(amount !== undefined ? { amount } : {}),
    ...(assetSymbol !== undefined ? { assetSymbol } : {}),
    ...(assetAmount !== undefined && assetDecimals !== undefined
      ? { assetAmount, assetDecimals }
      : {}),
    ...(typeof counterparty === 'string' && /^0x[0-9a-f]{40}$/.test(counterparty) ? { counterparty } : {}),
    ...(contract !== undefined && /^0x[0-9a-f]{40}$/.test(contract) ? { contract } : {}),
  };
}

/**
 * Deduplication key for a transfer. A self-transfer is returned by BOTH
 * the fromAddress and toAddress queries; uniqueId (hash + category/log
 * position) identifies the same transfer across the two result sets. The
 * hash and category are prepended defensively for endpoints that omit
 * uniqueId.
 */
function dedupeKey(transfer: RawTransfer): string {
  return `${transfer.hash}:${transfer.category}:${transfer.uniqueId ?? ''}`;
}

/**
 * HistoryProvider over an alchemy_getAssetTransfers-speaking endpoint.
 * Each page issues two queries — transfers sent by the address
 * (fromAddress) and received by it (toAddress) — because the API filters
 * on one side per query; results are merged newest-first with
 * self-transfers deduplicated.
 */
export function indexerHistoryProvider(
  transport: JsonRpcTransport,
  options: IndexerHistoryOptions = {},
): HistoryProvider {
  const pageSize = options.pageSize ?? 25;
  const categories = options.categories ?? DEFAULT_TRANSFER_CATEGORIES;
  const direction = options.direction ?? 'both';
  const listSent = direction !== 'received';
  const listReceived = direction !== 'sent';

  async function query(
    side: 'fromAddress' | 'toAddress',
    address: string,
    pageKey: string | undefined,
  ): Promise<RawResult> {
    const params = {
      fromBlock: '0x0',
      toBlock: 'latest',
      [side]: address,
      category: categories,
      // Timestamps require withMetadata (documented; mainnet-class chains).
      withMetadata: true,
      // Zero-value transfers are real history (e.g. 0-ETH self-sends used
      // as nonce bumps); hiding them silently would be dishonest. The API
      // defaults to excluding them, so opt out explicitly.
      excludeZeroValue: false,
      maxCount: '0x' + pageSize.toString(16),
      order: 'desc',
      ...(pageKey ? { pageKey } : {}),
    };
    const result = (await transport('alchemy_getAssetTransfers', [params])) as RawResult;
    if (!result || !Array.isArray(result.transfers)) {
      throw new Error('Indexer returned no transfers array from alchemy_getAssetTransfers');
    }
    return result;
  }

  return {
    async getHistory(address: string, cursor?: string): Promise<HistoryPage> {
      const state: CursorState = cursor ? decodeCursor(cursor) : { v: 1 };
      // First page: both directions start fresh. Later pages: a direction
      // missing from the cursor is exhausted and must not restart.
      // A one-sided provider (options.direction) never queries the other side.
      const queryOut = listSent && (!cursor || state.out !== undefined);
      const queryIn = listReceived && (!cursor || state.in !== undefined);

      const [outResult, inResult] = await Promise.all([
        queryOut ? query('fromAddress', address, state.out) : Promise.resolve(null),
        queryIn ? query('toAddress', address, state.in) : Promise.resolve(null),
      ]);

      const me = address.toLowerCase();
      // EIP-7708 protocol logs are reconciled per query (each side pages
      // alone and carries its own unmatched movements).
      const outSide = reconcileProtocolLogs(outResult?.transfers ?? [], state.co ?? []);
      const inSide = reconcileProtocolLogs(inResult?.transfers ?? [], state.ci ?? []);
      const seen = new Set<string>();
      const entries: HistoryEntry[] = [];
      for (const { transfer, native } of [...outSide.kept, ...inSide.kept]) {
        const key = dedupeKey(transfer);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(mapTransfer(transfer, me, native));
      }
      const omitted: Record<string, number> = {};
      for (const side of [outSide, inSide]) {
        for (const [reason, n] of Object.entries(side.omitted)) {
          if (n > 0) omitted[reason] = (omitted[reason] ?? 0) + n;
        }
      }
      // Newest first across the merged set; stable within a block by uid.
      entries.sort((a, b) => {
        const ah = a.blockHeight ?? 0;
        const bh = b.blockHeight ?? 0;
        if (ah !== bh) return bh - ah;
        return (b.uid ?? b.id) < (a.uid ?? a.id) ? -1 : 1;
      });

      // pageKey is omitted (or empty) when a direction is exhausted.
      const nextCursor = encodeCursor({
        ...(outResult?.pageKey ? { out: outResult.pageKey } : {}),
        ...(inResult?.pageKey ? { in: inResult.pageKey } : {}),
        co: outSide.carry,
        ci: inSide.carry,
      });
      return {
        entries,
        ...(nextCursor ? { nextCursor } : {}),
        ...(Object.keys(omitted).length ? { omitted } : {}),
      };
    },
  };
}

/**
 * Cheap save-time verification for Settings: one alchemy_getAssetTransfers
 * call with maxCount 0x1 must come back with a well-formed transfers
 * array. Throws with a plain message otherwise, so the app can refuse to
 * persist an endpoint that does not actually serve the method (the aa.ts
 * verify-before-save pattern). Returns how many transfers the probe saw
 * (0 or 1) for display.
 */
export async function verifyTransfersEndpoint(
  transport: JsonRpcTransport,
  address: string,
): Promise<{ sampleCount: number }> {
  const result = (await transport('alchemy_getAssetTransfers', [
    {
      fromBlock: '0x0',
      toBlock: 'latest',
      toAddress: address,
      category: ['external'],
      maxCount: '0x1',
      order: 'desc',
    },
  ])) as RawResult;
  if (!result || !Array.isArray(result.transfers)) {
    throw new Error(
      'Endpoint did not return a transfers array from alchemy_getAssetTransfers; ' +
        'it does not appear to serve the Transfers API.',
    );
  }
  for (const transfer of result.transfers) {
    if (typeof transfer?.hash !== 'string' || typeof transfer?.category !== 'string') {
      throw new Error('Endpoint returned a malformed transfer (missing hash/category).');
    }
  }
  return { sampleCount: result.transfers.length };
}

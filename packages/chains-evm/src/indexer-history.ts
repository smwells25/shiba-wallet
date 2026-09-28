import type { HistoryEntry, HistoryPage, HistoryProvider } from '@shiba-wallet/core';
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
 *  - Token transfers (erc20/erc721/erc1155) map to entries WITHOUT an
 *    amount (token decimals/ids need per-asset rendering, a later slice);
 *    they keep the correct id, uid, timestamp, direction and the
 *    API-reported asset symbol for display.
 *  - Failed-transaction detection is NOT available: the Transfers API
 *    reports value movements, not receipts, and a reverted transaction
 *    moves nothing, so it simply never appears. Entries are never marked
 *    `failed`, and fees are not reported either.
 *  - The two direction streams (sent/received) paginate independently, so
 *    across a page boundary an older received entry can arrive after a
 *    newer sent entry already shown. Each page itself is sorted
 *    newest-first; the app's per-page append tolerates the boundary skew.
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
  rawContract?: { value?: string | null; decimal?: string | null };
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
}

/**
 * Opaque cursor: the pair of per-direction pageKeys, JSON-encoded. A
 * direction absent from the cursor is exhausted and is not queried again.
 */
interface CursorState {
  v: 1;
  out?: string;
  in?: string;
}

function encodeCursor(state: { out?: string; in?: string }): string | undefined {
  if (state.out === undefined && state.in === undefined) return undefined;
  return JSON.stringify({ v: 1, ...state });
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
  const p = parsed as { v: 1; out?: unknown; in?: unknown };
  return {
    v: 1,
    ...(typeof p.out === 'string' ? { out: p.out } : {}),
    ...(typeof p.in === 'string' ? { in: p.in } : {}),
  };
}

const NATIVE_CATEGORIES = new Set(['external', 'internal']);
const HEX_VALUE = /^0x[0-9a-fA-F]+$/;

function mapTransfer(transfer: RawTransfer, me: string): HistoryEntry {
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
  const rawValue = transfer.rawContract?.value;
  if (rawValue && HEX_VALUE.test(rawValue)) {
    if (NATIVE_CATEGORIES.has(transfer.category)) {
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

  const assetSymbol =
    !NATIVE_CATEGORIES.has(transfer.category) && typeof transfer.asset === 'string'
      ? transfer.asset
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
      const queryOut = !cursor || state.out !== undefined;
      const queryIn = !cursor || state.in !== undefined;

      const [outResult, inResult] = await Promise.all([
        queryOut ? query('fromAddress', address, state.out) : Promise.resolve(null),
        queryIn ? query('toAddress', address, state.in) : Promise.resolve(null),
      ]);

      const me = address.toLowerCase();
      const seen = new Set<string>();
      const entries: HistoryEntry[] = [];
      for (const transfer of [
        ...(outResult?.transfers ?? []),
        ...(inResult?.transfers ?? []),
      ]) {
        const key = dedupeKey(transfer);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(mapTransfer(transfer, me));
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
      });
      return { entries, ...(nextCursor ? { nextCursor } : {}) };
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

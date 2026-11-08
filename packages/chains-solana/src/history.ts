import { base58 } from '@scure/base';
import type { HistoryEntry, HistoryPage, HistoryProvider } from '@shiba-wallet/core';
import type { JsonRpcTransport } from './rpc.js';

/**
 * Transaction history via the standard RPC methods, verified against
 * solana.com/docs/rpc:
 *  - getSignaturesForAddress(address, {limit, before}): newest-to-oldest
 *    [{signature, slot, err, memo, blockTime, confirmationStatus}]; the
 *    `before` config field pages backwards from a signature.
 *  - getTransaction(signature, {encoding: 'json', commitment,
 *    maxSupportedTransactionVersion}): meta.fee in lamports and
 *    meta.preBalances/postBalances indexed to
 *    transaction.message.accountKeys (base58 strings under json encoding).
 *
 * Amount enrichment costs one getTransaction call per entry, so it is
 * bounded by `enrichLimit` (default 10 per page); entries past the bound
 * carry no amount, and the app may re-request details lazily.
 *
 * Token transfers (pass p24-unblock finding 2). The same getTransaction
 * answer carries meta.preTokenBalances and meta.postTokenBalances, each an
 * array (or null) of token-balance objects with the fields
 *   accountIndex   index into transaction.message.accountKeys of the token
 *                  account whose balance is reported,
 *   mint           the token's mint, base-58,
 *   owner          the token account's owner, base-58 — "when the validator
 *                  recorded it. This field may be omitted.",
 *   uiTokenAmount  { amount: raw base-10 integer string, decimals: u8, … }
 * (solana.com/docs/rpc/http/gettransaction, read on 2026-11-08 from its
 * source solana-foundation/solana-com at 31f66e08,
 * apps/docs/content/docs/en/rpc/http/gettransaction.mdx lines 312–317 and
 * 351–366, because solana.com answered HTTP 429; the json-encoding example
 * there carries both arrays too). The provider pairs the two arrays by
 * accountIndex and sums, per mint, the change of every token account whose
 * owner is the queried address; a balance with no owner is never
 * attributed. A transaction that changed no such balance yields exactly the
 * entry it yielded before this was added (key for key). One that did yields
 * one token entry per mint whose balance changed (direction, assetAmount,
 * assetDecimals, contract = the mint, counterparty = the one other owner
 * whose balance of that mint moved the opposite way, when there is exactly
 * one), followed by the native entry only when lamports other than the fee
 * moved too (rent for a new token account, for example); the fee goes on
 * the native entry, or on the first token entry when no lamports moved, so
 * a token transfer never reads as a "self" entry of 0. The provider does not
 * know symbols: the app labels a mint from its own tracked and known lists.
 */

interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
  confirmationStatus: string | null;
}

interface TokenBalanceDetail {
  accountIndex?: unknown;
  mint?: unknown;
  owner?: unknown;
  uiTokenAmount?: { amount?: unknown; decimals?: unknown } | null;
}

interface TransactionDetail {
  meta: {
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalanceDetail[] | null;
    postTokenBalances?: TokenBalanceDetail[] | null;
  } | null;
  transaction: { message: { accountKeys: string[] } };
}

export interface SolanaHistoryOptions {
  pageSize?: number;
  /** How many entries per page get amount/fee details fetched. */
  enrichLimit?: number;
}

export function solanaHistoryProvider(
  transport: JsonRpcTransport,
  options: SolanaHistoryOptions = {},
): HistoryProvider {
  const pageSize = options.pageSize ?? 25;
  const enrichLimit = options.enrichLimit ?? 10;

  return {
    async getHistory(address: string, cursor?: string): Promise<HistoryPage> {
      const config: Record<string, unknown> = { limit: pageSize, commitment: 'confirmed' };
      if (cursor) config.before = cursor;
      const infos = (await transport('getSignaturesForAddress', [
        address,
        config,
      ])) as SignatureInfo[];

      const entries: HistoryEntry[] = [];
      for (let i = 0; i < infos.length; i++) {
        const info = infos[i]!;
        const base: HistoryEntry = {
          id: info.signature,
          timestamp: info.blockTime,
          confirmed:
            info.confirmationStatus === 'confirmed' ||
            info.confirmationStatus === 'finalized',
          direction: 'self',
          ...(info.err !== null && info.err !== undefined ? { failed: true } : {}),
        };
        if (i < enrichLimit) entries.push(...(await enrich(transport, base, address)));
        else entries.push(base);
      }

      const last = infos[infos.length - 1];
      return {
        entries,
        ...(infos.length === pageSize && last ? { nextCursor: last.signature } : {}),
      };
    },
  };
}

async function enrich(
  transport: JsonRpcTransport,
  entry: HistoryEntry,
  address: string,
): Promise<HistoryEntry[]> {
  try {
    const detail = (await transport('getTransaction', [
      entry.id,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ])) as TransactionDetail | null;
    if (!detail?.meta) return [entry];

    const keys = detail.transaction.message.accountKeys;
    const index = keys.indexOf(address);
    if (index === -1) return [entry];

    const pre = BigInt(detail.meta.preBalances[index] ?? 0);
    const post = BigInt(detail.meta.postBalances[index] ?? 0);
    const fee = BigInt(detail.meta.fee);
    // The fee payer is account 0; only then did this address pay the fee.
    const paidFee = index === 0;
    let net = post - pre;
    if (paidFee) net += fee; // separate the fee from the value movement

    const direction = net > 0n ? 'in' : net < 0n ? 'out' : 'self';
    const native: HistoryEntry = {
      ...entry,
      direction,
      amount: net < 0n ? -net : net,
      ...(paidFee ? { fee } : {}),
    };
    const moves = solanaTokenMoves(detail.meta.preTokenBalances, detail.meta.postTokenBalances, address);
    // No token balance of this address changed: exactly the entry this
    // provider has always returned.
    if (moves.length === 0) return [native];

    const tokens: HistoryEntry[] = moves.map((move) => ({
      ...entry,
      direction: move.change > 0n ? 'in' : 'out',
      uid: `${entry.id}:token:${move.mint}`,
      assetAmount: move.change < 0n ? -move.change : move.change,
      assetDecimals: move.decimals,
      contract: move.mint,
      ...(move.counterparty !== null ? { counterparty: move.counterparty } : {}),
    }));
    if (net === 0n) {
      // No lamports moved besides the fee: the fee rides on the first token
      // entry, and no native entry of 0 is listed.
      if (paidFee) tokens[0] = { ...tokens[0]!, fee };
      return tokens;
    }
    return [...tokens, { ...native, uid: `${entry.id}:native` }];
  } catch {
    // Detail lookups are best-effort; the signature listing already gave
    // us a valid (amount-less) entry.
    return [entry];
  }
}

/** One mint whose balance, summed over the token accounts the address owns, changed in a transaction. */
export interface SolanaTokenMove {
  /** The mint, base-58, exactly as the node reported it. */
  mint: string;
  /** Signed change in the token's base units: positive received, negative sent. */
  change: bigint;
  decimals: number;
  /** The one other owner whose balance of this mint moved the opposite way, else null. */
  counterparty: string | null;
}

const DIGITS = /^[0-9]+$/;

interface ParsedBalance {
  accountIndex: number;
  mint: string;
  owner: string | null;
  amount: bigint;
  decimals: number;
}

function parseTokenBalances(list: TokenBalanceDetail[] | null | undefined): ParsedBalance[] | null {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const out: ParsedBalance[] = [];
  for (const b of list) {
    const amount = b?.uiTokenAmount?.amount;
    const decimals = b?.uiTokenAmount?.decimals;
    if (
      typeof b?.accountIndex !== 'number' || !Number.isInteger(b.accountIndex) || b.accountIndex < 0 ||
      typeof b.mint !== 'string' || !isValidSolanaAddress(b.mint) ||
      (b.owner !== undefined && (typeof b.owner !== 'string' || !isValidSolanaAddress(b.owner))) ||
      typeof amount !== 'string' || !DIGITS.test(amount) ||
      typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255
    ) {
      return null;
    }
    out.push({ accountIndex: b.accountIndex, mint: b.mint, owner: typeof b.owner === 'string' ? b.owner : null, amount: BigInt(amount), decimals });
  }
  return out;
}

/**
 * The token movements of `address` in one transaction, from
 * meta.preTokenBalances and meta.postTokenBalances (see the module comment
 * for the documented fields). Balances are paired by accountIndex (a token
 * account missing on one side counts as 0 there: created or closed in the
 * transaction). Only accounts whose recorded owner is `address` count as
 * its own; an account whose pre and post entries name different mints or
 * owners, or a mint reported with two different decimals, is not
 * interpreted. Any malformed element makes the whole answer uninterpreted
 * (an empty list), so nothing is guessed. Mints are listed in the order they
 * first appear (post, then pre).
 */
export function solanaTokenMoves(
  preList: TokenBalanceDetail[] | null | undefined,
  postList: TokenBalanceDetail[] | null | undefined,
  address: string,
): SolanaTokenMove[] {
  const pre = parseTokenBalances(preList);
  const post = parseTokenBalances(postList);
  if (pre === null || post === null) return [];
  const byIndex = new Map<number, { pre: ParsedBalance | null; post: ParsedBalance | null }>();
  const seen = (side: 'pre' | 'post', b: ParsedBalance): boolean => {
    const slot = byIndex.get(b.accountIndex) ?? { pre: null, post: null };
    if (slot[side] !== null) return false; // the same account twice on one side
    slot[side] = b;
    byIndex.set(b.accountIndex, slot);
    return true;
  };
  for (const b of post) if (!seen('post', b)) return [];
  for (const b of pre) if (!seen('pre', b)) return [];
  const order: string[] = [];
  const perMint = new Map<string, { decimals: number; mine: bigint; others: Map<string, bigint>; broken: boolean }>();
  for (const b of [...post, ...pre]) if (!order.includes(b.mint)) order.push(b.mint);
  for (const { pre: before, post: after } of byIndex.values()) {
    const ref = (after ?? before)!;
    const record = perMint.get(ref.mint) ?? { decimals: ref.decimals, mine: 0n, others: new Map(), broken: false };
    perMint.set(ref.mint, record);
    if (
      (before !== null && after !== null && (before.mint !== after.mint || before.owner !== after.owner || before.decimals !== after.decimals)) ||
      record.decimals !== ref.decimals
    ) {
      record.broken = true;
      continue;
    }
    if (ref.owner === null) continue;
    const change = (after?.amount ?? 0n) - (before?.amount ?? 0n);
    if (ref.owner === address) record.mine += change;
    else record.others.set(ref.owner, (record.others.get(ref.owner) ?? 0n) + change);
  }
  const moves: SolanaTokenMove[] = [];
  for (const mint of order) {
    const record = perMint.get(mint);
    if (!record || record.broken || record.mine === 0n) continue;
    const opposite = [...record.others.entries()].filter(([, change]) => (record.mine > 0n ? change < 0n : change > 0n));
    moves.push({
      mint,
      change: record.mine,
      decimals: record.decimals,
      counterparty: opposite.length === 1 ? opposite[0]![0] : null,
    });
  }
  return moves;
}

/** Quick validity check the app can use before querying. */
export function isValidSolanaAddress(address: string): boolean {
  try {
    return base58.decode(address).length === 32;
  } catch {
    return false;
  }
}

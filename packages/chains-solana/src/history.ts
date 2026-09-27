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
 */

interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
  confirmationStatus: string | null;
}

interface TransactionDetail {
  meta: { fee: number; preBalances: number[]; postBalances: number[] } | null;
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
        entries.push(i < enrichLimit ? await enrich(transport, base, address) : base);
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
): Promise<HistoryEntry> {
  try {
    const detail = (await transport('getTransaction', [
      entry.id,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ])) as TransactionDetail | null;
    if (!detail?.meta) return entry;

    const keys = detail.transaction.message.accountKeys;
    const index = keys.indexOf(address);
    if (index === -1) return entry;

    const pre = BigInt(detail.meta.preBalances[index] ?? 0);
    const post = BigInt(detail.meta.postBalances[index] ?? 0);
    const fee = BigInt(detail.meta.fee);
    // The fee payer is account 0; only then did this address pay the fee.
    const paidFee = index === 0;
    let net = post - pre;
    if (paidFee) net += fee; // separate the fee from the value movement

    const direction = net > 0n ? 'in' : net < 0n ? 'out' : 'self';
    return {
      ...entry,
      direction,
      amount: net < 0n ? -net : net,
      ...(paidFee ? { fee } : {}),
    };
  } catch {
    // Detail lookups are best-effort; the signature listing already gave
    // us a valid (amount-less) entry.
    return entry;
  }
}

/** Quick validity check the app can use before querying. */
export function isValidSolanaAddress(address: string): boolean {
  try {
    return base58.decode(address).length === 32;
  } catch {
    return false;
  }
}

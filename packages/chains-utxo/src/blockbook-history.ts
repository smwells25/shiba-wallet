import type { HistoryEntry, HistoryPage, HistoryProvider } from '@shiba-wallet/core';

/**
 * Transaction history from a Blockbook backend, giving Dogecoin (and any
 * Blockbook-served UTXO chain) parity with the Esplora history provider.
 * Endpoint shape per the Blockbook API reference (trezor/blockbook
 * docs/api.md at v0.4.0): GET /api/v2/address/{address} with
 * details=txs&page=N&pageSize=M returns { page, totalPages,
 * transactions: [...] } where each transaction carries vin[]/vout[] with
 * addresses (string array), value (string, lowest denomination) and
 * isAddress, plus fees (string), blockTime, blockHeight, and
 * confirmations (numbers). Pagination starts at page 1.
 */

interface BlockbookIo {
  addresses?: string[];
  isAddress?: boolean;
  value?: string;
}

interface BlockbookTx {
  txid: string;
  vin: BlockbookIo[];
  vout: BlockbookIo[];
  fees?: string;
  blockTime?: number;
  blockHeight?: number;
  confirmations?: number;
}

interface BlockbookAddressResponse {
  page?: number;
  totalPages?: number;
  transactions?: BlockbookTx[];
}

export function blockbookHistoryProvider(
  baseUrl: string,
  options: { headers?: Record<string, string>; fetchFn?: typeof fetch; pageSize?: number } = {},
): HistoryProvider {
  const base = baseUrl.replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  const headers = options.headers ?? {};
  const pageSize = options.pageSize ?? 25;

  return {
    async getHistory(address: string, cursor?: string): Promise<HistoryPage> {
      const page = cursor ? Number(cursor) : 1;
      if (!Number.isInteger(page) || page < 1) {
        throw new Error(`Invalid Blockbook history cursor: ${cursor}`);
      }
      const url = `${base}/api/v2/address/${address}?details=txs&page=${page}&pageSize=${pageSize}`;
      const response = await fetchFn(url, { headers });
      if (!response.ok) {
        throw new Error(`Blockbook history fetch failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as BlockbookAddressResponse;
      const entries = (body.transactions ?? []).map((tx) => toEntry(tx, address));
      const totalPages = body.totalPages ?? 1;
      return {
        entries,
        ...(page < totalPages ? { nextCursor: String(page + 1) } : {}),
      };
    },
  };
}

function sumFor(ios: BlockbookIo[], address: string): bigint {
  return ios
    .filter((io) => io.isAddress !== false && (io.addresses ?? []).includes(address))
    .reduce((sum, io) => sum + BigInt(io.value ?? '0'), 0n);
}

function toEntry(tx: BlockbookTx, address: string): HistoryEntry {
  const received = sumFor(tx.vout, address);
  const spent = sumFor(tx.vin, address);
  const fee = BigInt(tx.fees ?? '0');
  const net = received - spent;

  // Same classification rules as the Esplora provider: net gain is
  // incoming; spending that returns everything minus the fee is a
  // self-send; otherwise outgoing with the fee reported separately.
  let direction: HistoryEntry['direction'];
  let amount: bigint;
  if (net > 0n || spent === 0n) {
    direction = 'in';
    amount = net;
  } else if (net + fee === 0n) {
    direction = 'self';
    amount = 0n;
  } else {
    direction = 'out';
    amount = -(net + fee);
  }

  return {
    id: tx.txid,
    timestamp: tx.blockTime ?? null,
    confirmed: (tx.confirmations ?? 0) > 0,
    ...(tx.blockHeight !== undefined && tx.blockHeight > 0
      ? { blockHeight: tx.blockHeight }
      : {}),
    direction,
    amount,
    ...(spent > 0n ? { fee } : {}),
  };
}

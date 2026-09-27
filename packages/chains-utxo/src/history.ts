import type { HistoryEntry, HistoryPage, HistoryProvider } from '@shiba-wallet/core';

/**
 * Transaction history from an Esplora backend. Endpoint shapes per the
 * Esplora HTTP API (github.com/Blockstream/esplora/blob/master/API.md):
 *  - GET /address/:address/txs — up to 50 mempool transactions plus the
 *    first 25 confirmed, newest first.
 *  - GET /address/:address/txs/chain[/:last_seen_txid] — confirmed only,
 *    25 per page, paginated by the last txid of the previous page.
 * Transaction objects carry vin[].prevout (same shape as vout), vout[]
 * with scriptpubkey_address and value, a top-level fee, and a status
 * object with confirmed/block_height/block_time.
 */

interface EsploraVout {
  scriptpubkey_address?: string;
  value: number;
}

interface EsploraTx {
  txid: string;
  fee: number;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
  vin: Array<{ prevout: EsploraVout | null }>;
  vout: EsploraVout[];
}

export function esploraHistoryProvider(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): HistoryProvider {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async getHistory(address: string, cursor?: string): Promise<HistoryPage> {
      // First page mixes mempool and recent confirmed; older pages walk
      // the confirmed-only chain endpoint by last-seen txid.
      const url = cursor
        ? `${base}/address/${address}/txs/chain/${cursor}`
        : `${base}/address/${address}/txs`;
      const response = await fetchFn(url);
      if (!response.ok) {
        throw new Error(`History fetch failed: HTTP ${response.status} for ${address}`);
      }
      const txs = (await response.json()) as EsploraTx[];
      const entries = txs.map((tx) => toEntry(tx, address));
      const lastConfirmed = [...txs].reverse().find((tx) => tx.status.confirmed);
      return {
        entries,
        // 25 confirmed per page means a full page may have more behind it.
        ...(lastConfirmed && txs.length >= 25 ? { nextCursor: lastConfirmed.txid } : {}),
      };
    },
  };
}

function toEntry(tx: EsploraTx, address: string): HistoryEntry {
  const received = tx.vout
    .filter((out) => out.scriptpubkey_address === address)
    .reduce((sum, out) => sum + BigInt(out.value), 0n);
  const spent = tx.vin
    .filter((input) => input.prevout?.scriptpubkey_address === address)
    .reduce((sum, input) => sum + BigInt(input.prevout!.value), 0n);
  const fee = BigInt(tx.fee);
  const net = received - spent;

  let direction: HistoryEntry['direction'];
  let amount: bigint;
  if (net > 0n || spent === 0n) {
    // Net gain (including odd consolidations where we also spent inputs).
    direction = 'in';
    amount = net;
  } else if (net + fee === 0n) {
    // Everything the address spent came back to it minus the fee.
    direction = 'self';
    amount = 0n;
  } else {
    direction = 'out';
    // Outgoing amount excludes the fee, which is reported separately.
    amount = -(net + fee);
  }

  return {
    id: tx.txid,
    timestamp: tx.status.block_time ?? null,
    confirmed: tx.status.confirmed,
    ...(tx.status.block_height !== undefined ? { blockHeight: tx.status.block_height } : {}),
    direction,
    amount,
    ...(spent > 0n ? { fee } : {}),
  };
}

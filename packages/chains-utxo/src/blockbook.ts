import type { Utxo } from './coinselect.js';
import type { UtxoTransport } from './transport.js';

/**
 * Blockbook-backed UtxoTransport. Blockbook (Trezor's indexer) is the
 * de-facto public API for Dogecoin, where no Esplora instances exist;
 * hosted instances (NOWNodes, QuickNode, self-hosted) typically require
 * an API key, passed here as extra headers. Shapes verified against the
 * Blockbook API reference (trezor/blockbook docs/api.md at v0.4.0):
 *  - GET /api/v2/utxo/{address}: [{ txid: string, vout: number,
 *    value: string (base units), confirmations: number, ... }]
 *  - POST /api/v2/sendtx/ with the raw hex as the request body:
 *    { result: "<txid>" } on success, { error: { message } } on failure.
 */
export function blockbookTransport(
  baseUrl: string,
  options: { headers?: Record<string, string>; fetchFn?: typeof fetch } = {},
): UtxoTransport {
  const base = baseUrl.replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  const headers = options.headers ?? {};

  return {
    async getUtxos(address: string): Promise<Utxo[]> {
      const response = await fetchFn(`${base}/api/v2/utxo/${address}`, { headers });
      if (!response.ok) {
        throw new Error(`Blockbook UTXO fetch failed: HTTP ${response.status}`);
      }
      const list = (await response.json()) as Array<{
        txid: string;
        vout: number;
        value: string;
      }>;
      // Blockbook serializes values as strings because Dogecoin amounts
      // overflow double-precision floats routinely.
      return list.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value) }));
    },

    async broadcastTx(rawTxHex: string): Promise<string> {
      const response = await fetchFn(`${base}/api/v2/sendtx/`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', ...headers },
        body: rawTxHex,
      });
      const body = (await response.json()) as {
        result?: string;
        error?: { message?: string };
      };
      if (!response.ok || body.error || !body.result) {
        throw new Error(
          `Blockbook broadcast rejected: ${body.error?.message ?? `HTTP ${response.status}`}`,
        );
      }
      return body.result;
    },
  };
}

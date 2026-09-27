import type { Utxo } from './coinselect.js';

/**
 * Vendor-neutral backend plumbing, mirroring chains-evm's injected
 * JsonRpcTransport pattern. UTXO chains are usually served over REST
 * (Esplora / Blockstream-API style) rather than JSON-RPC, so the injected
 * surface is the two calls the wallet actually needs. Vendors are
 * configuration, not code (ADR D5): nothing here hardcodes a provider.
 */
export interface UtxoTransport {
  /** Unspent outputs currently funding the address. */
  getUtxos(address: string): Promise<Utxo[]>;
  /** Submits a raw transaction (hex); resolves to the txid on acceptance. */
  broadcastTx(rawTxHex: string): Promise<string>;
}

/** Shape of one entry in Esplora's address UTXO listing. */
interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
}

/**
 * Transport for any Esplora-compatible backend (Blockstream's esplora,
 * mempool.space, self-hosted instances). Endpoints per the Esplora HTTP API
 * documentation (github.com/Blockstream/esplora, API.md):
 *   GET  /address/:address/utxo  -> [{ txid, vout, value, status }]
 *   POST /tx  (raw tx hex body)  -> txid as plain text
 * Kept tiny so tests can inject fakes, exactly like chains-evm's
 * httpTransport.
 */
export function esploraTransport(baseUrl: string, fetchFn: typeof fetch = fetch): UtxoTransport {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async getUtxos(address: string): Promise<Utxo[]> {
      const response = await fetchFn(`${base}/address/${address}/utxo`);
      if (!response.ok) {
        throw new Error(`UTXO fetch failed: HTTP ${response.status} for ${address}`);
      }
      const list = (await response.json()) as EsploraUtxo[];
      return list.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value) }));
    },

    async broadcastTx(rawTxHex: string): Promise<string> {
      const response = await fetchFn(`${base}/tx`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: rawTxHex,
      });
      const body = await response.text();
      if (!response.ok) {
        // Esplora returns the node's rejection reason in the body; surface
        // it verbatim because it names the exact consensus/policy failure.
        throw new Error(`Broadcast failed: HTTP ${response.status}: ${body}`);
      }
      return body.trim();
    },
  };
}

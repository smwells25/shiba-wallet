/**
 * Chain-agnostic transaction history model. Providers live in the chain
 * adapter packages (they need each chain's indexing infrastructure); core
 * defines only the shape the app renders, so the history screen never
 * contains chain-specific logic.
 */

export interface HistoryEntry {
  /** Chain-native transaction id (txid, hash, or signature). */
  id: string;
  /** Unix seconds; null while unconfirmed or when the backend omits it. */
  timestamp: number | null;
  confirmed: boolean;
  blockHeight?: number;
  /**
   * Direction relative to the queried address. "self" means every output
   * or effect returns to the address (only the fee left the wallet).
   */
  direction: 'in' | 'out' | 'self';
  /**
   * Absolute net value change for the address in the chain's base unit,
   * excluding the fee. Undefined when the backend cannot supply amounts
   * without extra lookups the provider chose not to make.
   */
  amount?: bigint;
  /** Network fee in base units, when known. Paid only on outgoing/self. */
  fee?: bigint;
  /** True when the chain reports the transaction itself failed on-chain. */
  failed?: boolean;
  /**
   * Provider-unique id for this entry, for list keys and cross-page
   * deduplication. Needed when one transaction produces several entries
   * (an indexer can report a token transfer and a native movement from the
   * same transaction). When absent, `id` is unique per entry.
   */
  uid?: string;
  /**
   * Symbol of the asset this entry moved, when it is not the chain's
   * native unit (for example an ERC-20 symbol reported by an indexer).
   * Display-only and backend-reported; absent for native-unit entries.
   */
  assetSymbol?: string;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Opaque cursor for the next (older) page; absent when exhausted. */
  nextCursor?: string;
}

export interface HistoryProvider {
  getHistory(address: string, cursor?: string): Promise<HistoryPage>;
}

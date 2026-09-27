import type { HistoryEntry, HistoryProvider } from '@shiba-wallet/core';
import { esploraHistoryProvider } from '@shiba-wallet/chains-utxo';
import {
  httpTransport as solanaHttpTransport,
  solanaHistoryProvider,
} from '@shiba-wallet/chains-solana';
import type { NetworkKind } from '../config/defaults';

/**
 * Transaction-history engine glue: resolves the right HistoryProvider for a
 * chain from its configured endpoint, and provides the small pure helpers
 * the Activity screen renders with (explorer links, direction labels,
 * timestamp formatting).
 *
 * Deliberately free of React Native imports so scripts/check-history.mjs can
 * exercise the exact code the app runs under plain Node, the same way
 * balances.ts and send.ts are exercised. All network state (endpoint URLs)
 * is passed in by the caller; nothing here reads configuration.
 */

/**
 * CAIP-2 ids of the chains with verified explorers, matching the constants
 * in ./send.ts and the entries in ../config/defaults.ts. Kept as local
 * literals (not imported from send.ts) so this module has no runtime
 * imports without file extensions, which lets scripts/check-history.mjs
 * load it directly under Node's type stripping — the same constraint
 * balances.ts satisfies by using type-only cross-file imports.
 */
const EVM_CHAIN_ID = 'eip155:1';
const BITCOIN_CHAIN_ID = 'bip122:000000000019d6689c085ae165831e93';
const SOLANA_CHAIN_ID = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/**
 * How many entries per Solana page get amount/fee enrichment. Each enriched
 * entry costs one extra getTransaction call against the (rate-limited)
 * public RPC, so this is kept modest; entries past the bound still render,
 * just without an amount.
 */
const SOLANA_ENRICH_LIMIT = 8;

/** Whether history can be fetched for a chain right now, and how. */
export type HistorySource =
  | { status: 'available'; provider: HistoryProvider }
  | { status: 'unavailable'; note: string };

/**
 * Ethereum has no history provider yet: a plain JSON-RPC node has no method
 * that lists transactions by address, so history needs an indexer or
 * explorer API. An ERC-20 log-based provider is planned; until it lands the
 * screen states the limitation honestly instead of showing fake data.
 */
export const EVM_HISTORY_NOTE =
  'Ethereum transaction history is not available yet. A standard JSON-RPC ' +
  'endpoint cannot list transactions by address; history needs an indexer ' +
  'or explorer API, which a later release will add.';

const NO_ENDPOINT_NOTE =
  'No endpoint is configured for this chain, so its history cannot be ' +
  'fetched. Configure one in Settings.';

/**
 * Resolves the history source for one chain from its protocol family and
 * effective endpoint URL (override or default, as resolved by
 * src/config/networks.ts). Keyed on NetworkKind so the EVM branch can start
 * returning a provider the moment an indexer-backed one exists, without the
 * screen changing.
 */
export function historySourceFor(kind: NetworkKind, url: string | null): HistorySource {
  switch (kind) {
    case 'evm-jsonrpc':
      // Deliberately unavailable even though an RPC URL exists; see note.
      return { status: 'unavailable', note: EVM_HISTORY_NOTE };
    case 'esplora':
      // Bitcoin by default; Dogecoin once the user configures an endpoint
      // (its default URL is null because no public Esplora-compatible
      // Dogecoin API has been verified — see src/config/defaults.ts).
      if (!url) return { status: 'unavailable', note: NO_ENDPOINT_NOTE };
      return { status: 'available', provider: esploraHistoryProvider(url) };
    case 'solana-jsonrpc':
      if (!url) return { status: 'unavailable', note: NO_ENDPOINT_NOTE };
      return {
        status: 'available',
        provider: solanaHistoryProvider(solanaHttpTransport(url), {
          enrichLimit: SOLANA_ENRICH_LIMIT,
        }),
      };
  }
}

/**
 * Block-explorer link for a transaction, or null when no explorer has been
 * verified for the chain (Dogecoin). Same explorers the send flow's success
 * screen links to: etherscan.io, blockstream.info, solscan.io.
 */
export function explorerTxUrl(chainId: string, txid: string): string | null {
  if (chainId === EVM_CHAIN_ID) return `https://etherscan.io/tx/${txid}`;
  if (chainId === BITCOIN_CHAIN_ID) return `https://blockstream.info/tx/${txid}`;
  if (chainId === SOLANA_CHAIN_ID) return `https://solscan.io/tx/${txid}`;
  return null;
}

/** Human label for an entry's direction. */
export function directionLabel(direction: HistoryEntry['direction']): string {
  switch (direction) {
    case 'in':
      return 'Received';
    case 'out':
      return 'Sent';
    case 'self':
      return 'Self';
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Renders a unix-seconds timestamp for the activity list: relative within
 * the last 24 hours ("5 min ago"), an absolute date beyond that, "pending"
 * when the chain has not timestamped the transaction yet. Built from plain
 * Date getters rather than toLocaleDateString so the output does not depend
 * on the runtime's Intl support (Hermes vs Node) and stays testable.
 */
export function formatTimestamp(timestamp: number | null, nowMs: number = Date.now()): string {
  if (timestamp === null) return 'pending';
  const seconds = Math.floor(nowMs / 1000) - timestamp;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const date = new Date(timestamp * 1000);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

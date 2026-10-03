import type { HistoryEntry, HistoryPage, HistoryProvider } from '@shiba-wallet/core';
import {
  httpTransport as evmHttpTransport,
  indexerHistoryProvider,
} from '@shiba-wallet/chains-evm';
import { blockbookHistoryProvider, esploraHistoryProvider } from '@shiba-wallet/chains-utxo';
import {
  httpTransport as solanaHttpTransport,
  solanaHistoryProvider,
} from '@shiba-wallet/chains-solana';
import type { NetworkKind } from '../config/defaults';
import { tokenLogsCoverageOf, tokenLogsHistoryProvider } from './token-history.ts';
import type { TokenLogsCoverage, TrackedTokenRef } from './token-history.ts';
import { sanitizeEndpointMessage } from '../config/endpoint-probe.ts';

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
  | { status: 'available'; provider: HistoryProvider; note?: string }
  | { status: 'unavailable'; note: string };

/**
 * A plain JSON-RPC node has no method that lists transactions by address,
 * so Ethereum history needs an indexer endpoint (one serving Alchemy's
 * Transfers API — alchemy_getAssetTransfers; see
 * packages/chains-evm/src/indexer-history.ts for the verified shapes and
 * limits). Until the user configures one in Settings, the screen states
 * the limitation honestly instead of showing fake data.
 */
export const EVM_HISTORY_NOTE =
  'Ethereum transaction history needs an indexer endpoint. A standard ' +
  'JSON-RPC endpoint cannot list transactions by address. Paste an ' +
  'endpoint that serves the Transfers API (alchemy_getAssetTransfers) ' +
  'under Settings → Ethereum history indexer.';

/** Shown above the list when the tracked-token logs fallback is active. */
export const TOKEN_LOGS_NOTE =
  'Showing tracked-token transfers from recent blocks (no indexer is ' +
  'configured). Native ETH history needs an indexer endpoint — see ' +
  'Settings → Ethereum history indexer.';

/** Where the coverage notes send the user for full history. */
const INDEXER_POINTER =
  'A history indexer (Settings → Ethereum history indexer) gives full ' +
  'history, including native ETH.';

/**
 * The partial-history note for the tracked-token logs fallback, written
 * from what the endpoint actually answered (token-history.ts coverage),
 * plus the endpoint's own refusal (JSON-RPC code and first sentence, links
 * and advertising removed) as a separate detail line when paging stopped
 * on a refused window. Block numbers are printed
 * raw so they can be compared with the "block N" labels on the rows.
 */
export function tokenLogsCoverageNote(coverage: TokenLogsCoverage): {
  note: string;
  detail: string | null;
} {
  const head = coverage.headBlock.toString();
  // The endpoint's own words, reduced to its JSON-RPC code and first
  // sentence with links and provider advertising removed
  // (endpoint-probe.ts sanitizeEndpointMessage); publicnode's refusal ends
  // with "Get one at: https://www.allnodes.com/publicnode".
  const cleaned = coverage.refusal
    ? sanitizeEndpointMessage(coverage.refusal.message, coverage.refusal.code)
    : '';
  const detail = coverage.refusal
    ? `The endpoint's response: ${cleaned === '' ? 'no readable reason.' : cleaned}`
    : null;
  if (coverage.stop === 'refused') {
    if (coverage.answeredFromBlock === null) {
      const window = `${coverage.refusal?.fromBlock ?? '?'}–${coverage.refusal?.toBlock ?? head}`;
      return {
        note:
          'No token history is available from the current endpoint: it did not ' +
          `answer the search of the most recent blocks (${window}). ` +
          INDEXER_POINTER +
          ' Pull down to try again.',
        detail,
      };
    }
    const from = coverage.answeredFromBlock.toString();
    return {
      note:
        `Showing tracked-token transfers from block ${from} to ${head} (no indexer ` +
        `is configured). History older than block ${from} is not available from ` +
        'the current endpoint, which refused to search further back. ' +
        INDEXER_POINTER,
      detail,
    };
  }
  if (coverage.stop === 'lookback-limit' && coverage.answeredFromBlock !== null) {
    const from = coverage.answeredFromBlock.toString();
    return {
      note:
        `Showing tracked-token transfers from block ${from} to ${head} (no indexer ` +
        `is configured). Without an indexer the wallet searches only the most ` +
        `recent ${coverage.lookbackBlocks.toString()} blocks, so older history is ` +
        'not shown. ' +
        INDEXER_POINTER,
      detail,
    };
  }
  // Still paging, or block 0 reached: the general note stands.
  return { note: TOKEN_LOGS_NOTE, detail };
}

/** The source-level note fields the Activity list shows above its rows. */
export interface HistoryNotes {
  note?: string;
  /** Verbatim endpoint text, shown under the note. */
  noteDetail?: string;
  /** Present when the page came from the tracked-token logs fallback. */
  coverage?: TokenLogsCoverage;
}

/**
 * Note fields after a page arrives: a page from the logs fallback replaces
 * the note with its coverage-aware wording; any other page keeps the
 * previous note (the source's static caveat, if any). Pure, so
 * scripts/check-token-history.mjs exercises the exact transition
 * useHistory applies on reload and on load-more.
 */
export function historyNotesAfterPage(previous: HistoryNotes, page: HistoryPage): HistoryNotes {
  const coverage = tokenLogsCoverageOf(page);
  if (!coverage) return previous;
  const { note, detail } = tokenLogsCoverageNote(coverage);
  return { note, ...(detail !== null ? { noteDetail: detail } : {}), coverage };
}

const NO_ENDPOINT_NOTE =
  'No endpoint is configured for this chain, so its history cannot be ' +
  'fetched. Configure one in Settings.';

const NO_BLOCKBOOK_NOTE =
  'No Blockbook endpoint is configured for this chain, so its history ' +
  'cannot be fetched. Configure the base URL (plus an API key if your ' +
  'provider requires one) under Settings → Network endpoints.';

/**
 * Resolves the history source for one chain from its protocol family and
 * effective endpoint URL (override or default, as resolved by
 * src/config/networks.ts). The EVM branch additionally takes the
 * configured history-indexer URL (from ./indexer.ts — a URL there passed
 * save-time verification by construction); without one, EVM history stays
 * honestly unavailable, because the regular RPC endpoint cannot serve it.
 * `headers` is only meaningful for 'blockbook' endpoints: the configured
 * API key as the api-key header, resolved by config/networks.ts.
 */
export function historySourceFor(
  kind: NetworkKind,
  url: string | null,
  evmIndexerUrl: string | null = null,
  headers?: Record<string, string>,
  evmTokenLogs?: { walletAddress: string; tokens: TrackedTokenRef[] },
): HistorySource {
  switch (kind) {
    case 'evm-jsonrpc':
      // Preferred: the dedicated indexer endpoint (full history). Without
      // one, fall back to tracked-token Transfer logs over the regular
      // RPC when the user tracks tokens (phase 5, item 4) — clearly
      // labeled partial history — else stay honestly unavailable.
      if (evmIndexerUrl) {
        return {
          status: 'available',
          provider: indexerHistoryProvider(evmHttpTransport(evmIndexerUrl)),
        };
      }
      if (url && evmTokenLogs && evmTokenLogs.tokens.length > 0) {
        return {
          status: 'available',
          provider: tokenLogsHistoryProvider({
            rpcUrl: url,
            walletAddress: evmTokenLogs.walletAddress,
            tokens: evmTokenLogs.tokens,
          }),
          note: TOKEN_LOGS_NOTE,
        };
      }
      return { status: 'unavailable', note: EVM_HISTORY_NOTE };
    case 'esplora':
      // Bitcoin (Blockstream's public Esplora by default).
      if (!url) return { status: 'unavailable', note: NO_ENDPOINT_NOTE };
      return { status: 'available', provider: esploraHistoryProvider(url) };
    case 'blockbook':
      // Dogecoin, once the user configures a Blockbook endpoint in
      // Settings (default URL is null — see src/config/defaults.ts). The
      // engine's provider paginates with numeric Blockbook pages.
      if (!url) return { status: 'unavailable', note: NO_BLOCKBOOK_NOTE };
      return {
        status: 'available',
        provider: blockbookHistoryProvider(url, headers ? { headers } : {}),
      };
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
 *
 * `evmExplorerTxBase` (phase 4, item 6) lets the caller substitute the
 * active EVM chain profile's explorer (config/evm-chain.ts —
 * sepolia.etherscan.io in Sepolia test mode) without this module reading
 * configuration; when omitted, the historical mainnet link stands.
 */
export function explorerTxUrl(
  chainId: string,
  txid: string,
  evmExplorerTxBase?: string | null,
): string | null {
  if (chainId === EVM_CHAIN_ID) {
    const base = evmExplorerTxBase === undefined ? 'https://etherscan.io/tx/' : evmExplorerTxBase;
    return base ? `${base}${txid}` : null;
  }
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
/**
 * Renderer label for an entry's time: confirmed entries whose provider
 * has no timestamps (log-based token history) show their block instead
 * of a misleading "pending".
 */
export function timestampLabel(
  entry: { timestamp: number | null; confirmed: boolean; blockHeight?: number },
  nowMs: number = Date.now(),
): string {
  if (entry.timestamp === null && entry.confirmed && entry.blockHeight !== undefined) {
    return `block ${entry.blockHeight}`;
  }
  return formatTimestamp(entry.timestamp, nowMs);
}

export function formatTimestamp(timestamp: number | null, nowMs: number = Date.now()): string {
  if (timestamp === null) return 'pending';
  const seconds = Math.floor(nowMs / 1000) - timestamp;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const date = new Date(timestamp * 1000);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

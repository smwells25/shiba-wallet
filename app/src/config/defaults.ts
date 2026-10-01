// Explicit .ts extension: this module is loaded directly by Node scripts
// under type stripping, which resolves relative specifiers literally.
import { EVM_MAINNET, EVM_SEPOLIA } from './evm-chain.ts';

/**
 * Default network endpoints, as pure data.
 *
 * This file deliberately has no React Native imports (its only import is
 * ./evm-chain.ts, which is pure data itself) so it can be loaded directly
 * by Node scripts (see scripts/check-balances.mjs, which runs it under
 * Node's native TypeScript type-stripping). Everything that touches
 * AsyncStorage lives in ./networks.ts.
 *
 * Every default URL below was verified to answer real queries (see the
 * per-entry comments). Endpoints are configuration, not code (ADR D5): the
 * user can override any of them in Settings, and the engine packages accept
 * any injected transport URL.
 *
 * ORDERED FALLBACK LISTS (2026-10-01): each chain ships an ordered list of
 * keyless public candidates (defaultUrls) instead of a single URL, because
 * one dead default hostname used to blank that chain's balances (AGENTS.md
 * INFRA FINDING 2026-10-01). ./networks.ts probes the candidates in order
 * through ./endpoint-probe.ts (short timeout, chain identity verified) and
 * uses the first healthy one; a user override always wins and is never
 * probed around. Only add a candidate after verifying it live with a
 * chain-identifying request and citing the provider's own documentation.
 */

/**
 * Which engine client speaks to the endpoint. 'blockbook' is a UTXO chain
 * served by a Trezor Blockbook instance (chains-utxo blockbookTransport /
 * blockbookHistoryProvider) instead of an Esplora one; its endpoint is
 * configured in src/wallet/blockbook.ts (base URL + optional API key)
 * rather than the plain URL-override map in ./networks.ts, because hosted
 * Blockbook providers (NOWNodes) authenticate with an api-key header.
 */
export type NetworkKind = 'evm-jsonrpc' | 'esplora' | 'solana-jsonrpc' | 'blockbook';

export interface NetworkDefault {
  /** CAIP-2 chain id, matching the core ChainKeyProvider's chainId. */
  chainId: string;
  /** Human name for the Settings screen. */
  label: string;
  /** Protocol family, selects the balance-fetch path in wallet/balances.ts. */
  kind: NetworkKind;
  /**
   * Ordered keyless public default endpoints, primary first. Empty when no
   * suitable keyless public endpoint exists (the UI then shows the chain's
   * balance as unavailable until the user configures one). Never fetch
   * from these directly in app code: config/networks.ts picks the first
   * healthy candidate.
   */
  defaultUrls: readonly string[];
  /**
   * The primary candidate (defaultUrls[0]), or null when the list is
   * empty. Kept for display and for scripts; it is NOT necessarily the
   * endpoint in use (see defaultUrls).
   */
  defaultUrl: string | null;
  /** Native-unit decimals (wei->ETH 18, sat->BTC 8, and so on). */
  decimals: number;
  /** Ticker used when rendering the balance. */
  symbol: string;
  /** Shown in Settings when defaultUrl is null. */
  note?: string;
}

/**
 * Bitcoin mainnet Esplora candidates, in order. Both were verified live on
 * 2026-10-01: GET /blocks/tip/height answered (969493 on both), GET
 * /block-height/0 returned the mainnet genesis hash 000000000019d6689c08...
 * (the chain-identity probe), and GET /address/:addr/utxo, GET
 * /address/:addr/txs and GET /fee-estimates answered with the Esplora
 * shapes the app parses.
 *
 *  1. Blockstream's public Esplora instance (the default since 2026-09-27).
 *     Documented base URL https://blockstream.info/api/ in
 *     https://github.com/Blockstream/esplora/blob/master/API.md.
 *  2. mempool.space, an Esplora-compatible REST API. Documented at
 *     https://mempool.space/docs/api/rest (source of that page:
 *     github.com/mempool/mempool frontend/src/app/docs/api-docs/
 *     api-docs-data.ts, which lists /api/blocks/tip/height,
 *     /api/block-height/:height, /api/address/:address/utxo,
 *     /api/address/:address/txs[/chain] and POST /api/tx). Caveat: its
 *     docs do not list the Esplora GET /api/fee-estimates route the send
 *     flow uses (they document /api/v1/fees/recommended instead); the
 *     route answered live with the Esplora shape (HTTP 203) but is
 *     undocumented there.
 */
const BITCOIN_ESPLORA_DEFAULTS: readonly string[] = [
  'https://blockstream.info/api',
  'https://mempool.space/api',
];

/**
 * Solana mainnet RPC candidates, in order. All three were verified live on
 * 2026-10-01: getHealth returned "ok", getVersion answered (solana-core
 * 4.3.0), and getGenesisHash returned 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp...
 * (the chain-identity probe; the CAIP-2 reference is its first 32
 * characters). getBalance, getLatestBlockhash and getSignaturesForAddress
 * also answered on each. All are rate-limited public endpoints, fine for a
 * wallet polling a handful of addresses; users can configure any provider.
 *
 *  1. https://api.mainnet.solana.com — the Mainnet endpoint documented in
 *     https://solana.com/docs/references/clusters (checked 2026-10-01; that
 *     page now names this hostname rather than mainnet-beta).
 *  2. https://api.mainnet-beta.solana.com — the previous default (verified
 *     2026-09-27), still listed under "Mainnet-beta" at
 *     https://solana.com/rpc.
 *  3. https://solana.publicnode.com — PublicNode (Allnodes). Caveat: this
 *     hostname is PublicNode's documented Solana PAGE (linked from the
 *     https://www.publicnode.com directory); the RPC hostname that page
 *     documents, https://solana-rpc.publicnode.com, failed its TLS
 *     handshake on 2026-10-01 (the same fault as ethereum-rpc) and was
 *     therefore NOT added. That the page hostname also serves JSON-RPC
 *     POSTs is observed behavior, not documented.
 */
const SOLANA_RPC_DEFAULTS: readonly string[] = [
  'https://api.mainnet.solana.com',
  'https://api.mainnet-beta.solana.com',
  'https://solana.publicnode.com',
];

export const DEFAULT_NETWORKS: NetworkDefault[] = [
  {
    chainId: 'eip155:1',
    label: 'Ethereum',
    kind: 'evm-jsonrpc',
    // Single source: EVM_MAINNET.defaultRpcUrls in ./evm-chain.ts (sources
    // and live checks are documented there).
    defaultUrls: EVM_MAINNET.defaultRpcUrls,
    defaultUrl: EVM_MAINNET.defaultRpcUrls[0],
    decimals: 18,
    symbol: 'ETH',
  },
  {
    chainId: 'bip122:000000000019d6689c085ae165831e93',
    label: 'Bitcoin',
    kind: 'esplora',
    defaultUrls: BITCOIN_ESPLORA_DEFAULTS,
    defaultUrl: BITCOIN_ESPLORA_DEFAULTS[0],
    decimals: 8,
    symbol: 'BTC',
  },
  {
    chainId: 'bip122:1a91e3dace36e2be3bf030a65679fe82',
    label: 'Dogecoin',
    kind: 'blockbook',
    // No public keyless Dogecoin API could be verified (2026-09-27:
    // dogechain.info and BlockCypher expose custom non-standard APIs, and
    // Trezor's public doge Blockbook sits behind a browser check), so the
    // default list stays empty and the UI shows a clean "unavailable" state.
    // Dogecoin's de-facto indexer API is Trezor's Blockbook (the engine's
    // blockbookTransport was verified live against NOWNodes' hosted
    // instances on 2026-09-27); the user configures a Blockbook base URL
    // plus an optional API key in Settings (src/wallet/blockbook.ts) —
    // hosted providers hand out per-user keys, which are runtime
    // configuration, never shipped defaults.
    defaultUrls: [],
    defaultUrl: null,
    decimals: 8,
    symbol: 'DOGE',
    note:
      'No public keyless Dogecoin API is known. Configure a Blockbook ' +
      'endpoint (base URL plus an API key if your provider requires one, ' +
      'e.g. a NOWNodes Dogecoin Blockbook) in Settings to use DOGE.',
  },
  {
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    label: 'Solana',
    kind: 'solana-jsonrpc',
    defaultUrls: SOLANA_RPC_DEFAULTS,
    defaultUrl: SOLANA_RPC_DEFAULTS[0],
    decimals: 9,
    symbol: 'SOL',
  },
];

/**
 * The Sepolia network entry used in place of the Ethereum row while the
 * Settings "Sepolia test mode" toggle is on (phase 4, item 6). Derived
 * from the EVM_SEPOLIA profile in ./evm-chain.ts — the single source for
 * every Sepolia value — never duplicated by hand here. The distinct
 * chainId keys a separate endpoint-override slot in ./networks.ts, so a
 * custom Sepolia RPC never leaks into mainnet mode or vice versa.
 */
export const SEPOLIA_NETWORK: NetworkDefault = {
  chainId: EVM_SEPOLIA.caip2,
  label: EVM_SEPOLIA.label,
  kind: 'evm-jsonrpc',
  // Single source: EVM_SEPOLIA.defaultRpcUrls in ./evm-chain.ts; probed
  // with eth_chainId before use and re-verified at send time.
  defaultUrls: EVM_SEPOLIA.defaultRpcUrls,
  defaultUrl: EVM_SEPOLIA.defaultRpcUrls[0],
  decimals: 18,
  symbol: EVM_SEPOLIA.displaySymbol,
  note: 'Sepolia test network — balances and sends here are test ETH, not real funds.',
};

export function networkDefaultFor(chainId: string): NetworkDefault | undefined {
  if (chainId === SEPOLIA_NETWORK.chainId) return SEPOLIA_NETWORK;
  return DEFAULT_NETWORKS.find((n) => n.chainId === chainId);
}

/**
 * One chain "slot" of the app (the four launch chains, keyed by the
 * mainnet CAIP-2 ids the accounts and routes carry) resolved to the
 * network that is ACTIVE for it right now. Only the EVM slot ever swaps:
 * with Sepolia test mode on, its network becomes SEPOLIA_NETWORK while
 * `slot` stays 'eip155:1' so accounts, navigation params and per-slot UI
 * keep matching. Pure so scripts/check-devmode.mjs can pin the mapping.
 */
export interface ActiveNetwork {
  /** The stable slot id (always the mainnet CAIP-2 id from DEFAULT_NETWORKS). */
  slot: string;
  /** The network serving that slot under the current mode. */
  network: NetworkDefault;
}

export function resolveActiveNetworks(sepolia: boolean): ActiveNetwork[] {
  return DEFAULT_NETWORKS.map((n) => ({
    slot: n.chainId,
    network: n.kind === 'evm-jsonrpc' && sepolia ? SEPOLIA_NETWORK : n,
  }));
}

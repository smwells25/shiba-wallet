// Explicit .ts extension: this module is loaded directly by Node scripts
// under type stripping, which resolves relative specifiers literally.
import {
  EVM_BASE_SEPOLIA,
  EVM_MAINNET,
  EVM_SEPOLIA,
  EVM_TEST_PROFILES,
  customEvmProfiles,
  type EvmChainProfile,
} from './evm-chain.ts';

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
 * The Sepolia network entry used in place of the Ethereum row while
 * Sepolia is the chosen test network in Settings → Developer (phase 4,
 * item 6). Derived
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

/**
 * The Base Sepolia network entry used in place of the Ethereum row while
 * Base Sepolia is the chosen test network (phase 10, item 3). Derived from
 * the EVM_BASE_SEPOLIA profile in ./evm-chain.ts exactly like
 * SEPOLIA_NETWORK; its distinct chainId keys its own endpoint-override slot.
 */
export const BASE_SEPOLIA_NETWORK: NetworkDefault = {
  chainId: EVM_BASE_SEPOLIA.caip2,
  label: EVM_BASE_SEPOLIA.label,
  kind: 'evm-jsonrpc',
  defaultUrls: EVM_BASE_SEPOLIA.defaultRpcUrls,
  defaultUrl: EVM_BASE_SEPOLIA.defaultRpcUrls[0],
  decimals: 18,
  symbol: EVM_BASE_SEPOLIA.displaySymbol,
  note: 'Base Sepolia test network — balances and sends here are test ETH, not real funds.',
};

/**
 * The network entry of a test profile that has no hand-written entry
 * above: derived from the profile alone, so a new profile in
 * ./evm-chain.ts gets its row without another list to edit here.
 */
function testNetworkDefault(p: EvmChainProfile): NetworkDefault {
  return {
    chainId: p.caip2,
    label: p.label,
    kind: 'evm-jsonrpc',
    defaultUrls: p.defaultRpcUrls,
    defaultUrl: p.defaultRpcUrls[0],
    decimals: 18,
    symbol: p.displaySymbol,
    note: `${p.label} test network — balances and sends here are test ETH, not real funds.`,
  };
}

/**
 * The network entries of the test-network profiles, in EVM_TEST_PROFILES
 * order: the hand-written entries above where they exist (their wording
 * predates the generic one and stays byte-identical), else derived.
 */
export const TEST_EVM_NETWORKS: readonly NetworkDefault[] = EVM_TEST_PROFILES.map(
  (p) => [SEPOLIA_NETWORK, BASE_SEPOLIA_NETWORK].find((n) => n.chainId === p.caip2) ?? testNetworkDefault(p),
);

/**
 * The network entry of a network the user added (feature 33,
 * wallet/custom-networks.ts), derived from its runtime profile in
 * ./evm-chain.ts. Its only default candidate is the RPC URL the user saved
 * (verified with eth_chainId and the head block's age before it was saved,
 * and probed again with the same checks before each session's first use);
 * an endpoint override in Settings is stored under the network's own CAIP-2
 * id like every other chain's. Decimals are 18: the wallet refuses to add a
 * network whose coin has any other number (every EVM amount, fee and Max in
 * the app assumes 18).
 */
function customNetworkDefault(p: EvmChainProfile): NetworkDefault {
  return {
    chainId: p.caip2,
    label: p.label,
    kind: 'evm-jsonrpc',
    defaultUrls: p.defaultRpcUrls,
    defaultUrl: p.defaultRpcUrls[0] ?? null,
    decimals: 18,
    symbol: p.displaySymbol,
    note: p.testnet
      ? `${p.label} (a test network you added, chain id ${p.chainIdDecimal}) — balances and sends here are test funds, not real funds.`
      : `${p.label} (a network you added, chain id ${p.chainIdDecimal}) — treated as a main network: its funds may be real.`,
  };
}

/** The network entries of the networks the user added, in the order they were added. */
export function customEvmNetworks(): NetworkDefault[] {
  return customEvmProfiles().map(customNetworkDefault);
}

export function networkDefaultFor(chainId: string): NetworkDefault | undefined {
  const test = TEST_EVM_NETWORKS.find((n) => n.chainId === chainId);
  if (test) return test;
  const builtIn = DEFAULT_NETWORKS.find((n) => n.chainId === chainId);
  if (builtIn) return builtIn;
  const custom = customEvmProfiles().find((p) => p.caip2 === chainId);
  return custom ? customNetworkDefault(custom) : undefined;
}

/**
 * One chain "slot" of the app (the four launch chains, keyed by the
 * mainnet CAIP-2 ids the accounts and routes carry) resolved to the
 * network that is ACTIVE for it right now. Only the EVM slot ever swaps:
 * with a test network chosen, its network becomes that test network's
 * entry (SEPOLIA_NETWORK or BASE_SEPOLIA_NETWORK) while `slot` stays
 * 'eip155:1' so accounts, navigation params and per-slot UI keep matching.
 * Pure so scripts/check-devmode.mjs can pin the mapping.
 */
export interface ActiveNetwork {
  /** The stable slot id (always the mainnet CAIP-2 id from DEFAULT_NETWORKS). */
  slot: string;
  /** The network serving that slot under the current mode. */
  network: NetworkDefault;
}

/**
 * The EVM network entry for a Developer choice: null / false for mainnet,
 * a test profile's CAIP-2 id for that test network, a custom network's
 * CAIP-2 id for that network (feature 33), and true (the value older
 * callers pass, from before the second test network) for Sepolia. An
 * unrecognised string resolves to Sepolia, matching evmProfileFor.
 */
function evmNetworkFor(selection: boolean | string | null): NetworkDefault | null {
  if (selection === false || selection === null) return null;
  if (selection === true) return SEPOLIA_NETWORK;
  const test = TEST_EVM_NETWORKS.find((n) => n.chainId === selection);
  if (test) return test;
  const custom = customEvmProfiles().find((p) => p.caip2 === selection);
  return custom ? customNetworkDefault(custom) : SEPOLIA_NETWORK;
}

export function resolveActiveNetworks(selection: boolean | string | null): ActiveNetwork[] {
  const testNetwork = evmNetworkFor(selection);
  return DEFAULT_NETWORKS.map((n) => ({
    slot: n.chainId,
    network: n.kind === 'evm-jsonrpc' && testNetwork ? testNetwork : n,
  }));
}

/**
 * Default network endpoints, as pure data.
 *
 * This file deliberately has NO imports (React Native or otherwise) so it
 * can also be loaded directly by Node scripts (see scripts/check-balances.mjs,
 * which runs it under Node's native TypeScript type-stripping). Everything
 * that touches AsyncStorage lives in ./networks.ts.
 *
 * Every default URL below was verified to answer real queries on 2026-09-27
 * (see the per-entry comments). Endpoints are configuration, not code
 * (ADR D5): the user can override any of them in Settings, and the engine
 * packages accept any injected transport URL.
 */

/** Which engine client speaks to the endpoint. */
export type NetworkKind = 'evm-jsonrpc' | 'esplora' | 'solana-jsonrpc';

export interface NetworkDefault {
  /** CAIP-2 chain id, matching the core ChainKeyProvider's chainId. */
  chainId: string;
  /** Human name for the Settings screen. */
  label: string;
  /** Protocol family, selects the balance-fetch path in wallet/balances.ts. */
  kind: NetworkKind;
  /**
   * Default public endpoint, or null when no suitable keyless public
   * endpoint exists (the UI then shows the chain's balance as unavailable
   * until the user configures one).
   */
  defaultUrl: string | null;
  /** Native-unit decimals (wei->ETH 18, sat->BTC 8, and so on). */
  decimals: number;
  /** Ticker used when rendering the balance. */
  symbol: string;
  /** Shown in Settings when defaultUrl is null. */
  note?: string;
}

export const DEFAULT_NETWORKS: NetworkDefault[] = [
  {
    chainId: 'eip155:1',
    label: 'Ethereum',
    kind: 'evm-jsonrpc',
    // PublicNode (by Allnodes) free, keyless JSON-RPC. Endpoint directory:
    // https://www.publicnode.com — verified 2026-09-27: eth_chainId returns
    // 0x1 and eth_getBalance answers for arbitrary addresses.
    // (https://eth.llamarpc.com failed DNS resolution and
    // https://cloudflare-eth.com returned -32603 on eth_getBalance when
    // checked the same day, so they were rejected as defaults.)
    defaultUrl: 'https://ethereum-rpc.publicnode.com',
    decimals: 18,
    symbol: 'ETH',
  },
  {
    chainId: 'bip122:000000000019d6689c085ae165831e93',
    label: 'Bitcoin',
    kind: 'esplora',
    // Blockstream's public Esplora instance. API reference:
    // https://github.com/Blockstream/esplora/blob/master/API.md — verified
    // 2026-09-27: GET /address/:addr and GET /address/:addr/utxo both
    // answer with the documented shapes. https://mempool.space/api is a
    // compatible alternative the user can switch to in Settings.
    defaultUrl: 'https://blockstream.info/api',
    decimals: 8,
    symbol: 'BTC',
  },
  {
    chainId: 'bip122:1a91e3dace36e2be3bf030a65679fe82',
    label: 'Dogecoin',
    kind: 'esplora',
    // No public Esplora-compatible Dogecoin API could be verified on
    // 2026-09-27: dogechain.info and BlockCypher expose their own custom
    // (non-Esplora) APIs, and Trezor's doge Blockbook instances speak the
    // Blockbook API and sit behind a browser check. Rather than invent an
    // adapter for an unverified API, the default is null and the Home
    // screen shows a clean "unavailable" state. A self-hosted Esplora
    // instance (github.com/Blockstream/esplora) pointed at a Dogecoin node,
    // or any Esplora-compatible service, can be configured in Settings.
    defaultUrl: null,
    decimals: 8,
    symbol: 'DOGE',
    note:
      'No public Esplora-compatible Dogecoin API is known. Configure a ' +
      'self-hosted or third-party Esplora-compatible endpoint to see your ' +
      'DOGE balance.',
  },
  {
    chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    label: 'Solana',
    kind: 'solana-jsonrpc',
    // Solana Foundation public mainnet-beta RPC. Documented (with its rate
    // limits) at https://solana.com/docs/references/clusters — verified
    // 2026-09-27: getBalance answers with { context, value }. Rate-limited
    // and not for production traffic at scale, which is fine for a wallet
    // polling a handful of addresses; users can configure any provider.
    defaultUrl: 'https://api.mainnet-beta.solana.com',
    decimals: 9,
    symbol: 'SOL',
  },
];

export function networkDefaultFor(chainId: string): NetworkDefault | undefined {
  return DEFAULT_NETWORKS.find((n) => n.chainId === chainId);
}

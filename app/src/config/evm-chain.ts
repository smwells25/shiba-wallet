/**
 * The active-EVM-chain profiles: Ethereum mainnet (the default) and the
 * Sepolia test network behind the Settings "Developer" toggle (phase 4,
 * item 6). This file is pure data with NO imports, like ./defaults.ts, so
 * Node scripts (scripts/check-devmode.mjs) can load it directly under
 * type stripping and pin every value.
 *
 * ONE CONFIG SOURCE: everything in the app that depends on "which EVM
 * chain are we on" — the numeric chain id that send.ts verifies endpoints
 * against, the default RPC URL, explorer links, the WalletConnect
 * namespace chain, the mainnet/testnet badge, and the pinned ERC-4337
 * defaults — reads one of these two profiles, resolved through
 * evmProfileFor(sepolia) (storage-backed via config/prefs.ts +
 * wallet/PrefsContext). Screens must never hardcode a second copy of any
 * of these values.
 *
 * The two modes never mix by construction: every per-chain store in the
 * app (endpoint overrides, AA bundler/factory config, history-indexer
 * URLs) is keyed by the ACTIVE profile's CAIP-2 id, so Sepolia
 * configuration lives under "eip155:11155111" and mainnet configuration
 * under "eip155:1"; flipping the toggle switches which keys are read, and
 * the endpoint chain-id verification in send.ts / indexer.ts / aa.ts
 * refuses any endpoint whose eth_chainId does not match the active
 * profile.
 *
 * Sepolia values and their sources (all public on-chain facts, fine to
 * commit; bundler URLs are NOT here because they embed API keys and stay
 * user-pasted runtime configuration):
 *
 *  - chain id 11155111 (0xaa36a7): verified live against the RPC below in
 *    scripts/testnet/config.mjs (2026-09-27), which also pinned the RPC
 *    URL https://ethereum-sepolia-rpc.publicnode.com.
 *  - EntryPoint v0.7 0x0000000071727De22E5E9d8BAf0edAc6f37da032: pinned in
 *    docs/AA_STACK.md and as ENTRYPOINT_V07 in @shiba-wallet/chains-evm
 *    (scripts/check-devmode.mjs asserts the copy here equals the engine's).
 *  - SimpleAccountFactory 0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985 with
 *    accountImplementation() 0x68641DE71cfEa5a5d0D29712449Ee254bb1400C2:
 *    passed the docs/AA_STACK.md on-chain verification during the live
 *    ERC-4337 smoke on 2026-09-27 (AGENTS.md task-8 entry): factory has
 *    code, the implementation has code, and its entryPoint() equals the
 *    v0.7 EntryPoint. Saving the prefill in Settings re-runs that exact
 *    verification against the live chain before anything persists.
 *
 * Addresses are stored in their EIP-55 checksummed form (computed through
 * core's toChecksumAddress and re-asserted by scripts/check-devmode.mjs),
 * because the AA Settings fields validate mixed-case input against the
 * checksum.
 */

export interface EvmAaPrefill {
  /** SimpleAccountFactory address, EIP-55 checksummed. */
  factory: string;
  /** accountImplementation() behind that factory (display/verification). */
  implementation: string;
  /** EntryPoint v0.7 (equals the engine's ENTRYPOINT_V07). */
  entryPoint: string;
}

export interface EvmChainProfile {
  /**
   * CAIP-2 id of the chain. Also the key every per-chain store uses while
   * this profile is active (endpoint override, AA config, indexer config).
   */
  caip2: string;
  /** Numeric chain id as a decimal string (BigInt(chainIdDecimal) where needed). */
  chainIdDecimal: string;
  /** Human name for Settings rows and the send screen's network line. */
  label: string;
  /** True for Sepolia: test funds, orange banner, testnet badge. */
  testnet: boolean;
  /** What amounts/fees are labeled as ("ETH" / "test ETH"). */
  displaySymbol: string;
  /**
   * Ordered keyless public default RPC endpoints, primary first
   * (user-overridable in Settings). config/networks.ts uses the first one
   * that passes an eth_chainId probe matching this profile.
   */
  defaultRpcUrls: readonly string[];
  /** The primary candidate (defaultRpcUrls[0]); not necessarily the one in use. */
  defaultRpcUrl: string;
  /** Verified block-explorer transaction-URL prefix. */
  explorerTxBase: string;
  /** Pinned, verified ERC-4337 defaults, or null (mainnet: none pinned). */
  aaPrefill: EvmAaPrefill | null;
}

const MAINNET_RPC_DEFAULTS: readonly string[] = [
  'https://ethereum-rpc.publicnode.com',
  'https://ethereum.publicnode.com',
];

/**
 * A single candidate on purpose. Checked 2026-10-01 and NOT added:
 * https://ethereum-sepolia.publicnode.com answers eth_chainId 0xaa36a7 but
 * is not referenced by the https://www.publicnode.com directory or by
 * PublicNode's Ethereum page (so it is undocumented); https://sepolia.drpc.org
 * answered "chain is not available on free plan"; https://rpc.sepolia.org
 * returned HTTP 404; https://rpc.ankr.com/eth_sepolia requires an API key.
 */
const SEPOLIA_RPC_DEFAULTS: readonly string[] = ['https://ethereum-sepolia-rpc.publicnode.com'];

export const EVM_MAINNET: EvmChainProfile = {
  caip2: 'eip155:1',
  chainIdDecimal: '1',
  label: 'Ethereum',
  testnet: false,
  displaySymbol: 'ETH',
  // Ordered fallback list (single source; config/defaults.ts derives the
  // Ethereum row from it and check-devmode.mjs asserts no drift). Both are
  // PublicNode (Allnodes), keyless:
  //  1. https://ethereum-rpc.publicnode.com — the RPC endpoint documented on
  //     PublicNode's Ethereum page https://ethereum.publicnode.com (linked
  //     from the https://www.publicnode.com directory). Verified 2026-09-27
  //     (eth_chainId 0x1, eth_getBalance answered). On 2026-10-01 it failed
  //     its TLS handshake (AGENTS.md INFRA FINDING); it stays FIRST as the
  //     documented canonical hostname so the app returns to it on its own
  //     once it recovers (each app launch probes from the top).
  //  2. https://ethereum.publicnode.com — verified live 2026-10-01:
  //     eth_chainId 0x1, eth_getBalance, eth_blockNumber and
  //     eth_maxPriorityFeePerGas answered. Caveat: PublicNode documents this
  //     hostname as its Ethereum PAGE, not as an RPC URL; that it serves
  //     JSON-RPC POSTs is observed behavior, not documented.
  // (Earlier rejections, 2026-09-27: https://eth.llamarpc.com failed DNS and
  // https://cloudflare-eth.com returned -32603 on eth_getBalance.)
  defaultRpcUrls: MAINNET_RPC_DEFAULTS,
  defaultRpcUrl: MAINNET_RPC_DEFAULTS[0],
  explorerTxBase: 'https://etherscan.io/tx/',
  aaPrefill: null,
};

export const EVM_SEPOLIA: EvmChainProfile = {
  caip2: 'eip155:11155111',
  chainIdDecimal: '11155111',
  label: 'Ethereum Sepolia',
  testnet: true,
  displaySymbol: 'test ETH',
  // https://ethereum-sepolia-rpc.publicnode.com is the Sepolia RPC endpoint
  // documented on https://ethereum.publicnode.com; re-verified live
  // 2026-10-01 (eth_chainId 0xaa36a7, eth_getBalance answered). It is the
  // only candidate: no second keyless Sepolia endpoint documented by its
  // provider was verified (see the note on SEPOLIA_RPC_DEFAULTS).
  defaultRpcUrls: SEPOLIA_RPC_DEFAULTS,
  defaultRpcUrl: SEPOLIA_RPC_DEFAULTS[0],
  explorerTxBase: 'https://sepolia.etherscan.io/tx/',
  aaPrefill: {
    factory: '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985',
    implementation: '0x68641DE71cfEa5a5d0D29712449Ee254bb1400C2',
    entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  },
};

/** The active EVM chain for the given developer-mode flag. */
export function evmProfileFor(sepolia: boolean): EvmChainProfile {
  return sepolia ? EVM_SEPOLIA : EVM_MAINNET;
}

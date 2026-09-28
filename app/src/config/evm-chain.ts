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
  /** Default public RPC endpoint (user-overridable in Settings). */
  defaultRpcUrl: string;
  /** Verified block-explorer transaction-URL prefix. */
  explorerTxBase: string;
  /** Pinned, verified ERC-4337 defaults, or null (mainnet: none pinned). */
  aaPrefill: EvmAaPrefill | null;
}

export const EVM_MAINNET: EvmChainProfile = {
  caip2: 'eip155:1',
  chainIdDecimal: '1',
  label: 'Ethereum',
  testnet: false,
  displaySymbol: 'ETH',
  // Same verified default as config/defaults.ts (single source for the
  // Home/Settings default remains DEFAULT_NETWORKS; check-devmode.mjs
  // asserts the two never drift apart).
  defaultRpcUrl: 'https://ethereum-rpc.publicnode.com',
  explorerTxBase: 'https://etherscan.io/tx/',
  aaPrefill: null,
};

export const EVM_SEPOLIA: EvmChainProfile = {
  caip2: 'eip155:11155111',
  chainIdDecimal: '11155111',
  label: 'Ethereum Sepolia',
  testnet: true,
  displaySymbol: 'test ETH',
  defaultRpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
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

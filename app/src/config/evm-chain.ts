/**
 * The active-EVM-chain profiles: Ethereum mainnet (the default) and the
 * test networks chosen under Settings → Developer: Ethereum Sepolia (phase
 * 4, item 6), Base Sepolia (phase 10, item 3) and Arbitrum Sepolia (phase
 * 14 item 3). Base Sepolia, the second test profile, proved that a new EVM
 * chain — smart accounts included — is a data entry here rather than a code
 * change. This file is pure data with NO
 * imports, like ./defaults.ts, so
 * Node scripts (scripts/check-devmode.mjs) can load it directly under
 * type stripping and pin every value.
 *
 * ONE CONFIG SOURCE: everything in the app that depends on "which EVM
 * chain are we on" — the numeric chain id that send.ts verifies endpoints
 * against, the default RPC URL, explorer links, the WalletConnect
 * namespace chain, the mainnet/testnet badge, and the pinned ERC-4337
 * defaults — reads one of these profiles, resolved through
 * evmProfileFor(prefs.testNetwork) (storage-backed via config/prefs.ts +
 * wallet/PrefsContext). Screens must never hardcode a second copy of any
 * of these values.
 *
 * The two modes never mix by construction: every per-chain store in the
 * app (endpoint overrides, AA bundler/factory config, history-indexer
 * URLs) is keyed by the ACTIVE profile's CAIP-2 id, so Sepolia
 * configuration lives under "eip155:11155111", Base Sepolia configuration
 * under "eip155:84532" and mainnet configuration under "eip155:1";
 * changing the Developer choice switches which keys are read, and
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
  /** True for the test networks: test funds, orange banner, testnet badge. */
  testnet: boolean;
  /**
   * The wording for this profile's mode in plain-language messages
   * ("mainnet mode", "Sepolia test mode", "Base Sepolia test mode").
   */
  modeLabel: string;
  /** The text of the orange TESTNET banner, or null on a main network. */
  bannerText: string | null;
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
  /**
   * True when the pinned Kernel v3.3 addresses (the engine's KERNEL_V3_3)
   * were checked on this chain with the same on-chain checks
   * verifyKernelDeployment runs. Saving the Kernel factory in Settings
   * still re-runs those checks live; this flag only records that the
   * pre-fill is known to be right here.
   */
  kernelV33Verified: boolean;
  /**
   * True for OP-stack L2s (Base): every transaction also pays an L1 data
   * fee on top of gas × price, charged from the sender's balance
   * (https://docs.base.org/specifications/transactions/network-fees: "Every
   * Base transaction consists of two costs: an L2 (execution) fee and an L1
   * (security) fee"). When true, the EOA send quotes in wallet/send.ts ask
   * the GasPriceOracle predeploy for it (getL1Fee on the exact unsigned
   * transaction, plus getOperatorFee) and include it in the fee, the total
   * and Max; see the OP-stack section of send.ts for the sources.
   */
  l1DataFee: boolean;
  /**
   * True when the Home screen offers the Swap screen on this profile. The
   * swap flow quotes through 0x (wallet/swap.ts). Base Sepolia is false:
   * 0x's supported-chain list (https://docs.0x.org/docs/introduction/supported-chains,
   * checked 2026-10-03) names Base 8453 but not Base Sepolia, and Settings
   * already tells the user that swaps are not offered there. Ethereum
   * Sepolia stays true as it was since phase 5: 0x does not list Sepolia
   * either, but the Swap screen was deliberately kept there so it can show
   * whatever 0x answers (phase 5 item 1 record in AGENTS.md).
   */
  swapsOffered: boolean;
  /**
   * True for Arbitrum chains, whose parent-chain (layer 1) data cost is NOT
   * a separate fee: it is charged as extra layer-2 gas inside the gas used,
   * and eth_estimateGas already includes it (see EVM_ARBITRUM_SEPOLIA for
   * the sources). The app's OP-stack code (l1DataFee) must never run there;
   * this flag only selects the plain-language note Settings shows.
   */
  l1CostInGas: boolean;
  /**
   * Present only on a network the USER added (feature 33,
   * wallet/custom-networks.ts); absent on every built-in profile. Facts the
   * wallet measured or was told when the network was verified and saved.
   */
  custom?: CustomNetworkFacts;
}

/**
 * What the wallet knows about a user-added network beyond the profile
 * fields. Everything here was either typed by the user (name, symbol, the
 * explorer address, the test-network tick) or measured once through the
 * user's RPC endpoint when the network was verified (the block time).
 */
export interface CustomNetworkFacts {
  /** The RPC URL the user saved (https; verified with eth_chainId and the head block's age). */
  rpcUrl: string;
  /** The native coin's symbol exactly as typed (no on-chain source exists for it). */
  nativeSymbol: string;
  /**
   * The explorer's base URL (https, no trailing slash), or null. Only the
   * Etherscan-family paths are ever built from it (`<base>/tx/<hash>`,
   * `<base>/address/<address>`); that convention is assumed, not verified.
   */
  explorerBase: string | null;
  /**
   * Seconds between blocks in milliseconds, measured at save from the head
   * block and the block 100 below it, or null when it could not be measured.
   */
  blockTimeMs: number | null;
  /** True when the user ticked "This is a test network" (it counts only for allow-listed ids). */
  testnetRequested: boolean;
}

const MAINNET_RPC_DEFAULTS: readonly string[] = [
  'https://ethereum-rpc.publicnode.com',
  'https://ethereum.publicnode.com',
];

/**
 * Sepolia default RPC candidates, in order (config/networks.ts uses the
 * first one whose eth_chainId probe answers 0xaa36a7). Fallbacks 2-4 were
 * added on 2026-10-02. Each one is listed by its own provider as a public,
 * keyless endpoint (the documentation page and the exact line are quoted
 * below), and each was probed live on 2026-10-02 from the development
 * machine: eth_chainId returned 0xaa36a7, eth_blockNumber was within one
 * block of the primary's answer at the same moment, and eth_simulateV1
 * (the balance-change preview's method, see wallet/simulation.ts) was
 * called with traceTransfers. A candidate that does not support
 * eth_simulateV1 would only make the preview show its "does not support
 * eth_simulateV1" note; the send flow's eth_call gate does not depend on
 * it. All of these are shared public services that can rate-limit; users
 * can always set their own endpoint in Settings.
 *
 *  1. https://ethereum-sepolia-rpc.publicnode.com — PublicNode (Allnodes);
 *     the Sepolia RPC endpoint documented on https://ethereum.publicnode.com
 *     and in the https://www.publicnode.com directory. Verified 2026-09-27
 *     and 2026-10-01; on 2026-10-02 eth_simulateV1 is SUPPORTED (the result
 *     carried the traceTransfers ETH log from 0xeeee...eeee).
 *  2. https://eth-sepolia-testnet.api.pocket.network — Pocket Network
 *     Foundation. Source: https://api.pocket.network/ ("Free Public RPC
 *     Endpoints / No API key required. Just copy and start building."),
 *     which lists "Ethereum Sepolia Testnet HTTPS Endpoint:
 *     https://eth-sepolia-testnet.api.pocket.network". Terms as stated on
 *     https://docs.pocket.network/foundation/api-portal/: "No API key, no
 *     account, no rate limit negotiation — just endpoints", and on
 *     https://pocket.network/support-public-rpc/: "rate limits are
 *     generous" (no number is published). Requests are routed to
 *     independent node operators ("Suppliers") on Pocket's network.
 *     eth_simulateV1: SUPPORTED (traceTransfers ETH log present).
 *  3. https://0xrpc.io/sep — 0xRPC, a donation-funded community service.
 *     Source: https://0xrpc.io (served from https://0xrpc.github.io/),
 *     which lists "Ethereum Sepolia Testnet (Full, 128 state with all
 *     blocks) https://0xrpc.io/sep" and states "Our endpoints are rate
 *     limited with less than 10 ~ 20 calls allowed per second". Its update
 *     log on the same page records past outages and disabled chains, which
 *     is why it is not ranked higher. eth_simulateV1: SUPPORTED
 *     (traceTransfers ETH log present).
 *  4. https://public.1rpc.io/sepolia — Automata 1RPC. Source:
 *     https://docs.1rpc.io/using-the-web3-api/networks ("Public endpoints
 *     use https://public.1rpc.io/<network>"; its public-endpoints table
 *     lists "Ethereum Sepolia https://public.1rpc.io/sepolia EVM JSON-RPC
 *     11155111"). Ranked last because it rate-limited quickly in the live
 *     probe (HTTP 429, -32005 "rate limit exceeded", once worded "Rate
 *     limit exceeded on Nodies public endpoints", which suggests it relays
 *     to Nodies at least some of the time), and because
 *     https://docs.1rpc.io/using-the-web3-api/errors states "Default daily
 *     usage quota per user: 200" without saying whether that applies to
 *     the keyless public endpoints. eth_simulateV1: INTERMITTENT. Over
 *     eight calls on 2026-10-02 it returned the traceTransfers ETH log
 *     twice, HTTP 429 three times, a non-JSON body once, Nodies' "Method
 *     not available on this plan: eth_simulateV1" once, and no answer
 *     within 8 s once, so the balance-change preview will often be
 *     unavailable while this candidate is in use.
 *
 * Checked and NOT added (2026-10-01 unless dated 2026-10-02):
 *  - https://ethereum-sepolia.publicnode.com answers eth_chainId 0xaa36a7
 *    (again on 2026-10-02) but is not referenced by the
 *    https://www.publicnode.com directory or by PublicNode's Ethereum page,
 *    so it is undocumented, and the documented primary is already first.
 *  - https://sepolia.drpc.org answered "chain is not available on free
 *    plan, please upgrade to paid plan" (unchanged on 2026-10-02).
 *  - https://rpc.sepolia.org returned HTTP 404 (unchanged on 2026-10-02);
 *    https://rpc2.sepolia.org did not answer within 8 s (2026-10-02).
 *  - https://rpc.ankr.com/eth_sepolia requires an API key (unchanged on
 *    2026-10-02: "Unauthorized: You must authenticate your request with an
 *    API key").
 *  - 2026-10-02: https://sepolia.gateway.tenderly.co is documented on
 *    https://docs.tenderly.co/node-rpc/rpc-reference ("Ethereum Sepolia
 *    11155111 https://sepolia.gateway.tenderly.co"; without an access key
 *    "requests go to the public Tenderly RPC endpoint, which carries public
 *    endpoint limits"), but every TLS handshake to it (and to
 *    mainnet.gateway.tenderly.co) failed from the development machine, so
 *    it could not be verified. Retry before adding it.
 *  - 2026-10-02: https://ethereum-sepolia-public.nodies.app (Nodies) passed
 *    the chain and block checks, but eth_simulateV1 is UNSUPPORTED ("Method
 *    not available on this plan"), and the URL appears only in the data
 *    behind the https://nodies.app home page, which
 *    https://docs.nodies.app/rpc-services/public-endpoints points to
 *    ("Visit https://nodies.app to grab one of our public endpoints"), not
 *    as visible text. Candidate 4 appears to relay to it anyway.
 *  - 2026-10-02: https://1rpc.io/sepolia answers, but the documented public
 *    form is https://public.1rpc.io/sepolia (candidate 4).
 *  - 2026-10-02: https://ethereum-sepolia.gateway.tatum.io answers keyless,
 *    but Tatum's reference docs (https://docs.tatum.io/docs/plans-limits)
 *    describe only API-key plans, and keyless use is described only in a
 *    blog post (https://tatum.io/blog/tatum-in-postman: "you'll just be
 *    limited to 5 requests per minute"), far too low for a wallet.
 *  - 2026-10-02: https://api.zan.top/eth-sepolia answers keyless, but ZAN's
 *    documented Sepolia URL is https://api.zan.top/node/v1/eth/sepolia/{apiKey}
 *    (https://docs.zan.top/docs/adding-rpc-nodes-to-metamask).
 *  - 2026-10-02: https://sepolia.rpc.thirdweb.com and
 *    https://rpc.sepolia.ethpandaops.io answer (ethpandaops did not finish
 *    eth_simulateV1 within 8 s) but no provider page documenting them as
 *    public keyless endpoints was found. https://sepolia.rpc.sentio.xyz
 *    answers, but Sentio documents only account-created, billed RPC nodes
 *    (https://www.sentio.xyz/docs/rpc-nodes).
 *  - 2026-10-02: the "Open RPC Endpoints" listed in the eth-clients/sepolia
 *    README (https://github.com/eth-clients/sepolia) are all unusable:
 *    rpc.sepolia.online and www.sepoliarpc.space fail DNS,
 *    rpc.bordel.wtf/sepolia returns HTTP 404, and rpc.sepolia.org and
 *    rpc-sepolia.rockx.com are covered in this list.
 *  - 2026-10-02, not reachable or no longer offered:
 *    https://eth-sepolia.public.blastapi.io (HTTP 403, "Blast API is no
 *    longer available"), https://eth-sepolia.api.onfinality.io/public
 *    (HTTP 429 asking for an API key), https://lb.routeme.sh/rpc/evm/11155111
 *    (HTTP 429 asking to sign up), https://endpoints.omniatech.io/v1/eth/sepolia/public
 *    (HTTP 521), https://eth-sepolia.blockpi.network/v1/rpc/public ("unknown
 *    host"); DNS failures for ethereum-sepolia.therpc.io,
 *    eth-sepolia-public.unifra.io, public.stackup.sh,
 *    ethereum-sepolia.rpc.subquery.network and rpc-sepolia.rockx.com; a
 *    connection reset from rpc.notadegen.com.
 */
const SEPOLIA_RPC_DEFAULTS: readonly string[] = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://eth-sepolia-testnet.api.pocket.network',
  'https://0xrpc.io/sep',
  'https://public.1rpc.io/sepolia',
];

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
  modeLabel: 'mainnet mode',
  bannerText: null,
  // The KERNEL_V3_3 constants were confirmed read-only on mainnet in phase 7
  // item 1 (AGENTS.md); mainnet use stays gated by config/readiness.ts.
  kernelV33Verified: true,
  l1DataFee: false,
  swapsOffered: true,
  l1CostInGas: false,
};

export const EVM_SEPOLIA: EvmChainProfile = {
  caip2: 'eip155:11155111',
  chainIdDecimal: '11155111',
  label: 'Ethereum Sepolia',
  testnet: true,
  displaySymbol: 'test ETH',
  // Ordered fallback list (single source; config/defaults.ts derives
  // SEPOLIA_NETWORK from it). The primary is the PublicNode endpoint
  // documented on https://ethereum.publicnode.com; three keyless fallbacks,
  // each documented by its own provider, were added on 2026-10-02. Sources,
  // live probe results and the rejected candidates are in the note on
  // SEPOLIA_RPC_DEFAULTS above.
  defaultRpcUrls: SEPOLIA_RPC_DEFAULTS,
  defaultRpcUrl: SEPOLIA_RPC_DEFAULTS[0],
  explorerTxBase: 'https://sepolia.etherscan.io/tx/',
  aaPrefill: {
    factory: '0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985',
    implementation: '0x68641DE71cfEa5a5d0D29712449Ee254bb1400C2',
    entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  },
  modeLabel: 'Sepolia test mode',
  bannerText: 'TESTNET — Sepolia test mode is on. Amounts are test ETH, not real funds.',
  // Confirmed read-only on Sepolia in phase 7 item 1 and live-proven since.
  kernelV33Verified: true,
  l1DataFee: false,
  swapsOffered: true,
  l1CostInGas: false,
};

/**
 * Base Sepolia default RPC candidates, in order (config/networks.ts uses the
 * first one whose eth_chainId probe answers 0x14a34 = 84532). All three were
 * probed live on 2026-10-03 from the development machine: eth_chainId
 * 0x14a34, the same eth_blockNumber at the same moment, eth_getBalance,
 * eth_estimateGas, eth_maxPriorityFeePerGas and eth_getBlockByNumber
 * answered, eth_sendRawTransaction is served (a deliberately malformed
 * one-byte payload was refused with -32602 "failed to decode signed
 * transaction", so nothing could be broadcast), and eth_simulateV1 with
 * traceTransfers returned the ETH pseudo-Transfer log from
 * 0xeeee...eeee, so the balance-change preview works on all three.
 *
 *  1. https://base-sepolia-rpc.publicnode.com — PublicNode (Allnodes). Its
 *     Base page https://base.publicnode.com lists it as the "Testnet" /
 *     "Sepolia" RPC endpoint (page data: "platform":"base-sepolia-rpc",
 *     "endpoint":"https://base-sepolia-rpc.publicnode.com"). Caveat: that
 *     record (and the Base mainnet one) also carries
 *     "showDeprecatedMessage":true with "deprecatedOn" 2024-02-19, which the
 *     page does not explain (that date matches the Base Goerli shutdown, not
 *     this endpoint); the endpoint answered every probe and the page showed
 *     live traffic for it. Ranked FIRST because it serves eth_getLogs over
 *     the app's 9,000-block windows (token-history.ts, approvals.ts,
 *     risk.ts and the recovery owner scan all use them).
 *  2. https://sepolia.base.org — the chain operator's own endpoint,
 *     documented on https://docs.base.org/base-chain/quickstart/connecting-to-base
 *     ("| RPC endpoint | `https://mainnet.base.org` | `https://sepolia.base.org` |",
 *     "| Chain ID | `8453` | `84532` |", "| Currency | ETH | ETH |"). Ranked
 *     second only because it refuses eth_getLogs over more than 1,000
 *     blocks (-32614 "eth_getLogs is limited to a 1,000 range", observed
 *     2026-10-03), which would break the 9,000-block log windows above;
 *     every other method the app uses answered. The same page names a
 *     separate "Transaction submission" endpoint,
 *     https://sepolia-sequencer.base.org, with the note "Use the
 *     transaction submission endpoint only to send transactions. Use the RPC
 *     endpoint for all other requests." It is NOT a candidate here: it
 *     answers eth_chainId with HTTP 403 / -32601 "rpc method is not allowed",
 *     so it cannot pass the chain-identity probe, and the app sends and reads
 *     through one endpoint. Sending through the RPC endpoints above is
 *     served (see the malformed-payload probe) but no real transaction has
 *     been broadcast on Base Sepolia by this wallet yet.
 *  3. https://base-sepolia-testnet.api.pocket.network — Pocket Network
 *     Foundation. https://api.pocket.network/ lists "Base Sepolia Testnet
 *     RPC" — "Public Base Sepolia testnet JSON-RPC endpoint by Pocket
 *     Network. No API key required; fair-use limits apply." —
 *     "endpointURL": "https://base-sepolia-testnet.api.pocket.network".
 *     Served the 9,000-block eth_getLogs window.
 *
 * Checked and NOT added (2026-10-03):
 *  - https://public.1rpc.io/base-sepolia: HTTP 400 "unknown network" (the
 *    1RPC networks page https://docs.1rpc.io/using-the-web3-api/networks
 *    lists only https://public.1rpc.io/base for Base).
 *  - https://base-sepolia.drpc.org answered eth_chainId 0x14a34 and
 *    eth_simulateV1, but no dRPC page documenting it as a keyless public
 *    endpoint was checked, and dRPC's free plan refused Ethereum Sepolia
 *    earlier (see SEPOLIA_RPC_DEFAULTS), so it was left out.
 */
const BASE_SEPOLIA_RPC_DEFAULTS: readonly string[] = [
  'https://base-sepolia-rpc.publicnode.com',
  'https://sepolia.base.org',
  'https://base-sepolia-testnet.api.pocket.network',
];

/**
 * Base Sepolia (phase 10, item 3), Base's test network: an OP-stack L2 that
 * settles to Ethereum Sepolia. Facts and sources:
 *
 *  - chain id 84532 (0x14a34), native currency ETH, explorer
 *    https://sepolia.basescan.org: the network table on
 *    https://docs.base.org/base-chain/quickstart/connecting-to-base (quoted
 *    on BASE_SEPOLIA_RPC_DEFAULTS above), fetched 2026-10-03; viem's chain
 *    definition (wevm/viem src/chains/definitions/baseSepolia.ts) agrees
 *    (id 84532, symbol ETH, explorer https://sepolia.basescan.org). The
 *    transaction-page path /tx/<hash> follows the Etherscan-family
 *    convention the other profiles use; the explorer answered automated
 *    requests with a Cloudflare challenge (HTTP 403), so that path itself
 *    could not be fetched headlessly.
 *  - ERC-4337 / Kernel, checked read-only on 2026-10-03 against this
 *    chain's RPC (https://sepolia.base.org and publicnode): EntryPoint v0.7
 *    0x0000000071727De22E5E9d8BAf0edAc6f37da032 has code byte-identical to
 *    Ethereum Sepolia's; the engine's verifyKernelDeployment passed for the
 *    pinned KERNEL_V3_3 addresses (code at the KernelFactory, the Kernel
 *    v3.3 implementation, the ECDSA validator and the meta factory;
 *    factory.implementation() is the pinned implementation; entrypoint() is
 *    v0.7; accountId() is "kernel.advanced.v0.3.3"; the meta factory
 *    approves the factory; the validator reports isModuleType(1)), and
 *    EntryPoint.getDepositInfo(meta factory) shows it staked with 0.1 ETH
 *    and an 86,400 s unstake delay, the same as on Ethereum Sepolia. The
 *    factory, meta factory and ECDSA validator runtime code is
 *    byte-identical to Ethereum Sepolia's; the Kernel implementation (and
 *    the guardian WeightedECDSAValidator) differ in exactly two places, the
 *    cached EIP-712 chain id (0x014a34 vs 0xaa36a7) and the cached domain
 *    separator, which were recomputed for each chain and match — i.e. the
 *    same code compiled with solady's chain-id immutables. The session-key
 *    signer and policies, RecoveryAction, WebAuthnValidator v0.0.3 and
 *    Daimo's P256Verifier are byte-identical too, and the secp256r1
 *    precompile at 0x100 answers (the engine's detectP256Precompile returned
 *    true; Base documents P256VERIFY "introduced Fjord", 6,900 gas since the
 *    Azul upgrade, at https://docs.base.org/specifications/base-protocol/execution/precompiles).
 *  - SimpleAccount: the Ethereum Sepolia SimpleAccountFactory
 *    0x91E6…8985 and its implementation also have byte-identical code here,
 *    but the full AA_STACK verification (entryPoint() of the implementation)
 *    was not run on this chain, so it is NOT pre-filled: aaPrefill is null
 *    and the Settings factory field starts empty for SimpleAccount. Kernel
 *    v3.3 is the smart-account type to use here (its pre-fill comes from
 *    the engine constants, verified above).
 *  - Bundlers: the ZeroDev project URL for chain 84532 answered eth_chainId
 *    0x14a34 and eth_supportedEntryPoints including v0.7, and served
 *    pimlico_getUserOperationGasPrice (rundler_maxPriorityFeePerGas: not
 *    served), probed 2026-10-03. Bundler URLs embed keys, so none is
 *    shipped; each test network keeps its own saved bundler.
 *  - Not available here: 0x swap quotes (0x's supported-chain list,
 *    https://docs.0x.org/docs/introduction/supported-chains, lists Base
 *    8453 but no Base Sepolia, checked 2026-10-03); fiat prices (test
 *    assets are never priced). Tracked ERC-20 tokens are per chain since
 *    phase 13 item 1 (wallet/tokens.ts): Base Sepolia starts with Circle's
 *    test USDC and EURC. Base Sepolia entries exist for NFT explorer links
 *    (wallet/nfts.ts), the risk module's new-contract threshold (302,400
 *    two-second blocks, wallet/risk.ts) and recovery-record file names
 *    ("base-sepolia", wallet/recovery.ts) since phase 11 item 5.
 *  - L1 data fee: see l1DataFee. A live GasPriceOracle getL1Fee probe
 *    (2026-10-03) put it at 5,895,253,350 wei (about 5.9 gwei)
 *    for a 112-byte transaction, about 5% of a 21,000-gas transfer's L2
 *    fee at the time. op-geth's buyGas balance check adds the L1 cost to
 *    gas limit × max fee + value (ethereum-optimism/op-geth, branch
 *    optimism, core/state_transition.go, "balanceCheck.Add(balanceCheck,
 *    l1Cost)"), so a Max send that left exactly gas × max fee would be
 *    refused for insufficient funds; since phase 11 item 5 the quotes and
 *    Max in wallet/send.ts include it (a second live probe on 2026-10-03:
 *    6,222,960,213 wei for a 47-byte unsigned transfer, 2.6% of the fee).
 */
export const EVM_BASE_SEPOLIA: EvmChainProfile = {
  caip2: 'eip155:84532',
  chainIdDecimal: '84532',
  label: 'Base Sepolia',
  testnet: true,
  displaySymbol: 'test ETH',
  defaultRpcUrls: BASE_SEPOLIA_RPC_DEFAULTS,
  defaultRpcUrl: BASE_SEPOLIA_RPC_DEFAULTS[0],
  explorerTxBase: 'https://sepolia.basescan.org/tx/',
  aaPrefill: null,
  modeLabel: 'Base Sepolia test mode',
  bannerText: 'TESTNET — Base Sepolia test mode is on. Amounts are test ETH, not real funds.',
  kernelV33Verified: true,
  l1DataFee: true,
  swapsOffered: false,
  l1CostInGas: false,
};

/**
 * Arbitrum Sepolia default RPC candidates, in order (config/networks.ts uses
 * the first one whose eth_chainId probe answers 0x66eee = 421614). Each was
 * probed live on 2026-10-04: eth_chainId 0x66eee, eth_blockNumber,
 * eth_getBalance, eth_gasPrice, eth_feeHistory, eth_maxPriorityFeePerGas
 * (0x0 on all three), eth_estimateGas, and eth_simulateV1 with
 * traceTransfers (the ETH pseudo-Transfer log from 0xeeee…eeee was
 * returned, so the balance-change preview works on all three).
 *
 *  1. https://arbitrum-sepolia-rpc.publicnode.com — PublicNode (Allnodes).
 *     Its Arbitrum page https://arbitrum.publicnode.com lists it (page data:
 *     "platform":"arbitrum-sepolia-rpc", "network":"Testnet",
 *     "endpoint":"https://arbitrum-sepolia-rpc.publicnode.com"), and
 *     Arbitrum's own third-party provider table
 *     (https://docs.arbitrum.io/arbitrum-essentials/reference/node-providers)
 *     ticks PublicNode for Arbitrum Sepolia. The page data carries the same
 *     unexplained "showDeprecatedMessage" flag (2024-02-19) seen on Base;
 *     every probe answered. Ranked FIRST because eth_getLogs was consistent:
 *     ranges up to 50,000 blocks accepted (-32701 "exceed maximum block
 *     range: 50000" above), and windows ten million blocks deep were served,
 *     so the app's 9,000-block log windows work.
 *  2. https://sepolia-rollup.arbitrum.io/rpc — Arbitrum's own public RPC,
 *     https://docs.arbitrum.io/arbitrum-essentials/reference/node-providers:
 *     "| Arbitrum Sepolia (Testnet) | <https://sepolia-rollup.arbitrum.io/rpc>
 *     | 421614 | [Arbiscan](https://sepolia.arbiscan.io/), [Blockscout](…) |
 *     Sepolia | Nitro (Rollup) | …". The same page warns of "No uptime,
 *     latency, or rate-limit guarantees", and it answered HTTP 429 "Too Many
 *     Requests" after about 25 rapid requests, hence second.
 *  3. https://arb-sepolia-testnet.api.pocket.network — Pocket Network
 *     Foundation; https://api.pocket.network lists "Arbitrum Sepolia Testnet
 *     RPC" — "Public Arbitrum Sepolia testnet JSON-RPC endpoint by Pocket
 *     Network. No API key required; fair-use limits apply." Ranked last:
 *     reads worked, but eth_getLogs with toBlock = the head block number was
 *     refused ("invalid block range params") and some deeper windows
 *     answered "historical state is not available" on one run, i.e. its
 *     load-balanced backends differ.
 *
 * Not added: https://sepolia-rollup-sequencer.arbitrum.io/rpc (the same
 * Arbitrum page: "the Sequencer endpoints only support
 * eth_sendRawTransaction and eth_sendRawTransactionConditional calls"), and
 * dRPC (its page shows no keyless URL to cite). Arbitrum's blocks are about
 * 0.25 s apart (measured 2026-10-04: 2,500 s over 10,000 blocks), so a
 * 9,000-block window covers only about 37 minutes of history here.
 */
const ARBITRUM_SEPOLIA_RPC_DEFAULTS: readonly string[] = [
  'https://arbitrum-sepolia-rpc.publicnode.com',
  'https://sepolia-rollup.arbitrum.io/rpc',
  'https://arb-sepolia-testnet.api.pocket.network',
];

/**
 * Arbitrum Sepolia (phase 14 item 3), Arbitrum's test network: an Arbitrum
 * Nitro rollup that settles to Ethereum Sepolia. It is NOT an OP-stack
 * chain. Facts and sources (fetched and read on-chain 2026-10-04):
 *
 *  - chain id 421614 (0x66eee), currency ETH, explorer Arbiscan
 *    https://sepolia.arbiscan.io: the provider table quoted on
 *    ARBITRUM_SEPOLIA_RPC_DEFAULTS, and
 *    https://docs.arbitrum.io/build-decentralized-apps/quickstart-solidity-remix
 *    ("Chain ID: `421614`", "Currency Symbol: **ETH**"). Arbitrum's pages
 *    link Arbiscan in the /address/<addr> form; the /tx/<hash> path is the
 *    Etherscan-family convention, observed answering HTTP 200 for a real
 *    transaction (titled "… | Arbitrum Sepolia"), not documented.
 *  - FEE MODEL. https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas:
 *    "users will see a single fee—the L2 cost with the L1 fee "baked-in."
 *    This differs from other Rollups"; "Call an Arbitrum node's
 *    `eth_estimateGas` RPC, which returns a gas limit sufficient to cover
 *    the entire transaction fee at the current child chain gas price";
 *    "Note that for a given operation, the `eth_estimateGas` value may vary
 *    over time as the parent chain calldata price fluctuates". And
 *    https://docs.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees:
 *    "The total fee charged to a transaction is the child chain basefee
 *    multiplied by the sum of the child chain gas used and the parent chain
 *    calldata charge." So the worst case is gas limit × max fee per gas,
 *    exactly what send.ts computes for Ethereum, and Max (balance − that
 *    worst case) stays correct; the OP-stack L1-fee code (l1DataFee) must
 *    NOT run here: there is no GasPriceOracle (eth_getCode at
 *    0x420000000000000000000000000000000000000F returned 0x on Arbitrum
 *    Sepolia, while it holds code on Base Sepolia). Measured: for a 1-wei
 *    transfer NodeInterface.gasEstimateComponents gave gasEstimate 21,770
 *    of which gasEstimateForL1 601, and eth_estimateGas returned the same
 *    21,770, i.e. the estimate already includes the parent-chain part.
 *    eth_maxPriorityFeePerGas answers 0x0, so the app's priority fee is 0;
 *    ArbOwnerPublic.getCollectTips() read true, so a non-zero tip WOULD be
 *    paid. Gas price floor: ArbGasInfo.getMinimumGasPrice() = 0.02 gwei
 *    on-chain (the chain-params page's 0.2 gwei for Arbitrum Sepolia
 *    disagrees with the chain; the chain is what charges).
 *  - ERC-4337 / Kernel: the engine's verifyKernelDeployment PASSED against
 *    this chain (implementation 0xd6CE…5b28, entryPoint() v0.7, accountId
 *    "kernel.advanced.v0.3.3", meta factory approved); the meta factory is
 *    staked (0.1 ETH, 86,400 s). EntryPoint v0.7, the KernelFactory, meta
 *    factory, ECDSA validator, the session-key signer and policies,
 *    RecoveryAction, WebAuthnValidator v0.0.3 (its pinned code hash) and
 *    Daimo's P256Verifier are byte-identical to Ethereum Sepolia; the Kernel
 *    implementation and the WeightedECDSAValidator differ in exactly 35
 *    bytes, the cached EIP-712 chain id (0x066eee) and domain separator,
 *    recomputed and matching — the same pattern as Base Sepolia. The dev
 *    owner's index-0 counterfactual is 0xc995…C5AC here too (CREATE2,
 *    factory getAddress agreed), not deployed. The secp256r1 precompile at
 *    0x100 answers (detectP256Precompile true; Arbitrum documents EIP-7951
 *    in ArbOS 51, https://docs.arbitrum.io/run-arbitrum-node/arbos-releases/arbos51,
 *    and the chain reports ArbOS 61).
 *  - SimpleAccount is not pre-filled (the AA_STACK check was not run here).
 *  - Bundlers: the ZeroDev project URL for 421614 answered eth_chainId
 *    0x66eee and eth_supportedEntryPoints including v0.7, serves
 *    pimlico_getUserOperationGasPrice, not rundler_maxPriorityFeePerGas.
 *  - Token paymaster: Circle's v0.7 paymaster 0x31BE…0b58 is documented for
 *    Arbitrum Sepolia (developers.circle.com/paymaster/addresses-and-events)
 *    and passed readCirclePaymasterState + circlePaymasterProblems (token()
 *    = Circle's USDC 0x75fa…AA4d, feeSpread 0, a fixed test oracle at
 *    3,000 USDC per ETH, staked 0.25 ETH, deposit about 1.05 ETH); see
 *    packages/chains-evm/src/token-paymaster.ts.
 *  - Not available here: 0x swap quotes (https://docs.0x.org/docs/introduction/supported-chains
 *    lists Arbitrum One 42161 only, checked 2026-10-04).
 */
export const EVM_ARBITRUM_SEPOLIA: EvmChainProfile = {
  caip2: 'eip155:421614',
  chainIdDecimal: '421614',
  label: 'Arbitrum Sepolia',
  testnet: true,
  displaySymbol: 'test ETH',
  defaultRpcUrls: ARBITRUM_SEPOLIA_RPC_DEFAULTS,
  defaultRpcUrl: ARBITRUM_SEPOLIA_RPC_DEFAULTS[0],
  explorerTxBase: 'https://sepolia.arbiscan.io/tx/',
  aaPrefill: null,
  modeLabel: 'Arbitrum Sepolia test mode',
  bannerText: 'TESTNET — Arbitrum Sepolia test mode is on. Amounts are test ETH, not real funds.',
  kernelV33Verified: true,
  l1DataFee: false,
  swapsOffered: false,
  l1CostInGas: true,
};

/**
 * Settings → Developer note for a profile with l1CostInGas (Arbitrum): what
 * the fee covers there, in plain words (sources on EVM_ARBITRUM_SEPOLIA).
 */
export function l1CostInGasNote(profile: Pick<EvmChainProfile, 'label' | 'swapsOffered'>): string {
  return (
    `${profile.label} is a layer-2 network that charges for publishing its data on Ethereum as extra gas, not ` +
    'as a separate fee: the network’s own gas estimate already includes it, so the max network fee on the ' +
    'confirm screen covers the whole cost, and Max leaves exactly that. The estimate can move with Ethereum’s ' +
    'fees; if it rises before the transaction is included, the network refuses it and nothing is charged.' +
    (profile.swapsOffered ? '' : ` Swaps are not offered here (0x does not support ${profile.label}).`)
  );
}

/** The test-network profiles, in the order Settings → Developer lists them. */
export const EVM_TEST_PROFILES: readonly EvmChainProfile[] = [EVM_SEPOLIA, EVM_BASE_SEPOLIA, EVM_ARBITRUM_SEPOLIA];

/** Every EVM profile the app knows (mainnet first). */
export const EVM_PROFILES: readonly EvmChainProfile[] = [EVM_MAINNET, ...EVM_TEST_PROFILES];

/** The CAIP-2 id of a test-network profile (the stored Developer choice). */
export type TestNetworkId = 'eip155:11155111' | 'eip155:84532' | 'eip155:421614';

/**
 * The profile with this CAIP-2 id — a built-in one first, then a network
 * the user added (see "Custom networks" below) — or undefined for a chain
 * the app has no profile for.
 */
export function evmProfileByCaip2(caip2: string): EvmChainProfile | undefined {
  return EVM_PROFILES.find((p) => p.caip2 === caip2) ?? customProfiles.find((p) => p.caip2 === caip2);
}

/** True when `caip2` names one of the test-network profiles above. */
export function isTestProfileId(caip2: unknown): caip2 is TestNetworkId {
  return typeof caip2 === 'string' && EVM_TEST_PROFILES.some((p) => p.caip2 === caip2);
}

/**
 * The active EVM chain. `selection` is the stored Developer choice
 * (prefs.testNetwork): null for mainnet, or a test profile's CAIP-2 id. A
 * boolean is still accepted for callers written before the second test
 * network existed: false is mainnet and true is Sepolia (the only test
 * network then). An unrecognised string — which config/prefs.ts never
 * stores — resolves to Sepolia rather than mainnet, so a damaged value can
 * never move a test-mode user onto real funds.
 */
export function evmProfileFor(selection: boolean | string | null): EvmChainProfile {
  if (selection === false || selection === null) return EVM_MAINNET;
  if (selection === true) return EVM_SEPOLIA;
  return (
    EVM_TEST_PROFILES.find((p) => p.caip2 === selection) ??
    customProfiles.find((p) => p.caip2 === selection) ??
    EVM_SEPOLIA
  );
}

// ---------------------------------------------------------------------------
// Custom networks (feature 33, phase 17 item 3)
// ---------------------------------------------------------------------------
//
// A network the user adds in Settings → Developer becomes an EvmChainProfile
// at runtime, so every consumer of this file — evmProfileFor,
// evmProfileByCaip2, the readiness switchboard, the endpoint resolver, the
// token, contact, WalletConnect and risk modules — serves it without change.
//
// THE SINGLE READ PATH. The profiles live in the module-level registry
// below. Only wallet/custom-networks.ts writes it: (1) when it HYDRATES the
// registry from storage (ensureCustomNetworksLoaded, which
// config/prefs.ts loadPrefs awaits before it returns, so every code path
// that resolves the active network through the stored preferences — React
// (PrefsContext) and non-React (config/networks.ts, wallet/tokens.ts) — sees
// the custom profiles first); and (2) after each successful add, removal or
// reset, AFTER the storage write. Listeners (PrefsContext) re-render on every
// change. This file stays free of imports so the Node check scripts load it
// directly.
//
// SAFETY RULES held here, whatever the store says:
//  - a custom profile can never take a built-in chain id (setCustomEvmProfiles
//    refuses it), so a user-added network can never shadow Ethereum mainnet
//    or a built-in test network;
//  - a custom network counts as a TEST network only when the user ticked
//    "This is a test network" AND its chain id is in
//    KNOWN_PUBLIC_TEST_CHAIN_IDS (isCustomTestNetwork re-checks the list every
//    time); anything else is a main network with real funds.

/**
 * Well-known PUBLIC test networks a user may add as a test network. Every
 * entry was read from the ethereum-lists chain registry
 * (github.com/ethereum-lists/chains, master at commit
 * ec732e43f8b821853bb9ad2aea592751cc943bfd, fetched 2026-10-10), file
 * _data/chains/eip155-<id>.json; each file names a testnet in its "title" or
 * "name" and carries "slip44": 1 (SLIP-0044 coin type 1, "Testnet (all
 * coins)"):
 *  - 17000    Holesky — "title": "Ethereum Testnet Holesky"
 *  - 560048   Hoodi — "title": "Ethereum Testnet Hoodi"
 *  - 11155420 OP Sepolia — "name": "OP Sepolia Testnet"
 *  - 80002    Polygon Amoy — "title": "Polygon Amoy Testnet"
 *  - 59141    Linea Sepolia — "title": "Linea Sepolia Testnet"
 *  - 534351   Scroll Sepolia — "name": "Scroll Sepolia Testnet"
 * The built-in test networks (Ethereum Sepolia, Base Sepolia, Arbitrum
 * Sepolia) are not listed: their chain ids cannot be added at all. An id not
 * listed here can still be added, but only as a MAIN network, so a user can
 * never mark mainnet funds as "test" by mistake. Adding an id here is a
 * deliberate code change with its source cited.
 */
export const KNOWN_PUBLIC_TEST_CHAIN_IDS: readonly { readonly chainId: string; readonly name: string }[] = [
  { chainId: '17000', name: 'Holesky' },
  { chainId: '560048', name: 'Hoodi' },
  { chainId: '11155420', name: 'OP Sepolia' },
  { chainId: '80002', name: 'Polygon Amoy' },
  { chainId: '59141', name: 'Linea Sepolia' },
  { chainId: '534351', name: 'Scroll Sepolia' },
];

/** The CAIP-2 id of a user-added network ("eip155:<decimal chain id>"). */
export type CustomNetworkId = `eip155:${string}`;

/** What the stored network choice (prefs.testNetwork) may hold: a test profile or a custom network. */
export type EvmNetworkChoice = TestNetworkId | CustomNetworkId;

let customProfiles: readonly EvmChainProfile[] = [];
const customListeners = new Set<() => void>();

/** True when `caip2` is the chain id of a built-in profile (mainnet or a test network). */
export function isBuiltInEvmChain(caip2: string): boolean {
  return EVM_PROFILES.some((p) => p.caip2 === caip2);
}

/**
 * Replaces the custom profiles. Called ONLY by wallet/custom-networks.ts
 * (hydration and after a successful write). Throws, changing nothing, when
 * a profile lacks its custom facts, takes a built-in chain id, or repeats a
 * chain id — the store's own parser refuses those first; this is the last
 * line of defence.
 */
export function setCustomEvmProfiles(profiles: readonly EvmChainProfile[]): void {
  const seen = new Set<string>();
  for (const p of profiles) {
    if (!p.custom) throw new Error(`Not a custom network profile: ${p.caip2}`);
    if (isBuiltInEvmChain(p.caip2)) throw new Error(`A custom network cannot take a built-in chain id: ${p.caip2}`);
    if (seen.has(p.caip2)) throw new Error(`Duplicate custom network: ${p.caip2}`);
    seen.add(p.caip2);
  }
  customProfiles = [...profiles];
  for (const listener of [...customListeners]) {
    try {
      listener();
    } catch {
      // A listener only refreshes a display; the registry is already updated.
    }
  }
}

/** The networks the user added, in the order they were added. */
export function customEvmProfiles(): readonly EvmChainProfile[] {
  return customProfiles;
}

/** Every EVM profile: the built-in ones (mainnet first), then the user's. */
export function allEvmProfiles(): readonly EvmChainProfile[] {
  return [...EVM_PROFILES, ...customProfiles];
}

/** True when `caip2` names a network the user added (and that is currently registered). */
export function isCustomNetworkId(caip2: unknown): caip2 is CustomNetworkId {
  return typeof caip2 === 'string' && customProfiles.some((p) => p.caip2 === caip2);
}

/** True when `chainIdDecimal` is on the allow-list of public test networks. */
export function isKnownPublicTestChainId(chainIdDecimal: string): boolean {
  return KNOWN_PUBLIC_TEST_CHAIN_IDS.some((t) => t.chainId === chainIdDecimal);
}

/**
 * True only for a registered custom network that the user marked as a test
 * network AND whose chain id is on KNOWN_PUBLIC_TEST_CHAIN_IDS (re-checked
 * here, never trusted from storage).
 */
export function isCustomTestNetwork(caip2: string): boolean {
  const p = customProfiles.find((c) => c.caip2 === caip2);
  return p?.custom?.testnetRequested === true && isKnownPublicTestChainId(p.chainIdDecimal);
}

/** Subscribes to changes of the custom profiles. Returns the unsubscribe function. */
export function subscribeCustomEvmProfiles(listener: () => void): () => void {
  customListeners.add(listener);
  return () => {
    customListeners.delete(listener);
  };
}

/**
 * Settings → Developer note for a custom network: what the wallet does NOT
 * know about it. Layer-2 fee models are not detected (a built-in profile
 * says when a network charges a separate layer 1 data fee or folds it into
 * gas; a custom one is treated like Ethereum), smart-account deployments
 * are not pre-filled, swaps are not offered, and the explorer path is
 * assumed.
 */
export function customNetworkNote(profile: Pick<EvmChainProfile, 'label' | 'custom'>): string {
  const explorer = profile.custom?.explorerBase
    ? ` Explorer links assume the Etherscan-style paths ${profile.custom.explorerBase}/tx/… and /address/…; ` +
      'the wallet did not check that the explorer uses them.'
    : ' No block explorer was given, so the wallet shows no explorer links here.';
  return (
    `${profile.label} is a network you added. The wallet treats its fees like Ethereum’s: it does not detect ` +
    'layer-2 fee models, so on a rollup quotes may be refused or underestimate the fee. No smart-account ' +
    'deployment is pre-filled (paste a factory under Account Abstraction and the wallet checks it on-chain ' +
    'before saving), swaps are not offered, and tokens start with an empty list.' +
    explorer
  );
}

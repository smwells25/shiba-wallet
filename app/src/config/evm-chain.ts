/**
 * The active-EVM-chain profiles: Ethereum mainnet (the default) and two
 * test networks chosen under Settings → Developer: Ethereum Sepolia (phase
 * 4, item 6) and Base Sepolia (phase 10, item 3, the second test profile,
 * which proves that a new EVM chain — smart accounts included — is a data
 * entry here rather than a code change). This file is pure data with NO
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
 *    8453 but no Base Sepolia, checked 2026-10-03); tracked ERC-20 tokens
 *    (mainnet assets, hidden in every test mode); fiat prices (test assets
 *    are never priced). Base Sepolia entries exist for NFT explorer links
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
};

/** The test-network profiles, in the order Settings → Developer lists them. */
export const EVM_TEST_PROFILES: readonly EvmChainProfile[] = [EVM_SEPOLIA, EVM_BASE_SEPOLIA];

/** Every EVM profile the app knows (mainnet first). */
export const EVM_PROFILES: readonly EvmChainProfile[] = [EVM_MAINNET, ...EVM_TEST_PROFILES];

/** The CAIP-2 id of a test-network profile (the stored Developer choice). */
export type TestNetworkId = 'eip155:11155111' | 'eip155:84532';

/** The profile with this CAIP-2 id, or undefined for a chain the app has no profile for. */
export function evmProfileByCaip2(caip2: string): EvmChainProfile | undefined {
  return EVM_PROFILES.find((p) => p.caip2 === caip2);
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
  return EVM_TEST_PROFILES.find((p) => p.caip2 === selection) ?? EVM_SEPOLIA;
}

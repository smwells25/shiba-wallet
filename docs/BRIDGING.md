# Cross-chain bridging providers (features 35 and 36)

**Status:** Research only, written on 2026-10-11 (US Eastern; the on-chain reads ran between 03:20 and 03:40 UTC on 2026-10-12) against repository HEAD `551ec95`, for phase 20 item 4 (`AGENTS.md`, "Phase 20 plan"). Nothing here is built, no transaction was sent and no funds moved. Every on-chain fact is a read-only `eth_getCode`, `eth_getStorageAt`, `eth_call` or `eth_getLogs` made through the keyless endpoints the wallet already uses (`app/src/config/evm-chain.ts`): `ethereum-sepolia-rpc.publicnode.com` (fallback `eth-sepolia-testnet.api.pocket.network`), `base-sepolia-rpc.publicnode.com`, `arbitrum-sepolia-rpc.publicnode.com`, `optimism-sepolia-rpc.publicnode.com` and, for the mainnet comparisons, `ethereum-rpc.publicnode.com`. The newest blocks at the time were Ethereum Sepolia 11,896,211, Base Sepolia 48,003,776, Arbitrum Sepolia 318,286,397, OP Sepolia 49,986,650 and Ethereum mainnet 26,173,708. Vendor documents and APIs were fetched the same day from the URL cited beside each claim; API calls were read-only quote and metadata requests with a placeholder address (`0x…dEaD`), never with a wallet address. Section 14 lists what could not be verified.

Sections 15 and 16 were added on 2026-10-14 (US Eastern; the reads ran between 02:25 and 02:50 UTC on 2026-10-15) for phase 21 item 1: LayerZero V2 and Stargate V2 on the same four networks, and the updated recommendation. The adapter design that lets the user choose a provider is in `docs/BRIDGE_PROVIDERS.md`.

This file is plain technical prose for leadership and for the engineers who would build a slice. The persona and compression rules do not apply to it.

## 1. Summary

1. **Circle's Cross-Chain Transfer Protocol (CCTP), version 2, is the best first slice for USDC, and the working hypothesis survives with two corrections.** The same contract addresses hold byte-identical code on all four test networks the wallet runs on (Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia); every implementation checked is a Sourcify exact match; each network's TokenMessengerV2 is registered for the other three; Circle's attestation API answered every request without a key; the burn call has only fixed-size arguments, so a CallPolicy can pin all of them; and a Standard Transfer has no protocol fee. The corrections: (a) it pairs with the Circle paymaster on only two of the four networks (Base Sepolia and Arbitrum Sepolia), and (b) the paymaster cannot pay for the transaction that *brings* the first USDC to a network, because it takes its fee during validation, before the mint runs. CCTP is not trust-minimised: Circle's two attesters, Circle-held pause, denylist and upgrade keys, and the fact that Circle issues USDC itself are the trust model.
2. **Across Protocol is a reasonable second provider for ETH, but its ERC-7683 (intents) contract cannot be demonstrated on any of the four test networks.** Across's SpokePools exist and are Sourcify-verified on all four, its testnet API is keyless and quoted every route between them, and its deposit call can be mostly pinned. However, the testnet relayers accept at most about 8 USDC or 0.003 ETH per deposit; the Sepolia settlement contract runs with a 601-second challenge window, a 1-wei bond and an externally owned account as owner (a demonstration of the mechanics, not of the security); the API returns an unlimited token approval that the wallet must replace; and the `AcrossOriginSettler` that implements ERC-7683 is documented only on Base and Arbitrum mainnets and has no code on any of the four test networks. ERC-7683 itself is still a Draft and its current text replaces the interface Across documents.
3. **The native rollup bridges are trust-minimised for ETH between Ethereum Sepolia and each rollup, but they are not a practical baseline for this wallet's USDC.** They move tokens only between a rollup and its parent chain (never rollup to rollup), and they cannot deliver Circle's native USDC: on Base Sepolia and OP Sepolia the native USDC contract does not implement the interface the OP Standard Bridge requires, and Arbitrum's gateway router maps Sepolia USDC to a different, bridged token. Withdrawals on OP Sepolia wait at least 7 days (read on-chain, which contradicts the OP documentation's "shorter on test networks"). Two smart-account traps were found: the OP bridge's plain `depositETH` refuses contract callers, and an Arbitrum `depositEth` from a contract or an EIP-7702 account credits an *aliased* address.
4. **The aggregators (LI.FI, Socket/Bungee, Relay) should come later, if at all.** Their transactions are built by an API and cannot be pinned by a CallPolicy, which is the same finding `docs/SCHEDULED_PAYMENTS.md` section 4.2 made for 0x and the Universal Router. LI.FI unexpectedly serves all four test networks keylessly (75 quotes per two hours) and routed a testnet USDC transfer through Across with a 0.25 % LI.FI fee on top. Socket lists no test network at all. Relay serves only Ethereum Sepolia and Base Sepolia, and its on-chain deposit carries only an order identifier, so the amount the user will receive is a promise held off-chain.
5. **LayerZero/Stargate and Wormhole do not fit a first slice.** Their security rests on an application-configured verifier set (LayerZero) or a 13-of-19 guardian multisignature (Wormhole), and Stargate's testnet USDC pools hold their own test tokens, not Circle's USDC.
6. **Update, 2026-10-15 (phase 21): the Chairperson chose provider optionality, and LayerZero was researched to the same depth as CCTP (section 15).** The finding above about Stargate's USDC pools still holds (they hold a publicly mintable mock token, not Circle's USDC), but Stargate V2 also runs native-ETH pools on Ethereum Sepolia, Arbitrum Sepolia and OP Sepolia that the dev EOA can use with the test ETH it holds, so a live LayerZero leg is possible on three of the four networks (none on Base Sepolia). On every one of those pathways a single verifier operated by LayerZero Labs confirms each message. Section 16 replaces the recommendation in section 10 with a two-provider design.

## 2. Sources

| Source | Pinned at / fetched | Used for |
|---|---|---|
| Circle CCTP documentation (Markdown export) | fetched 2026-10-11: `https://developers.circle.com/cctp.md`, `/cctp/references/contract-addresses` (HTML of `https://developers.circle.com/cctp/evm-smart-contracts`), `/cctp/references/contract-interfaces.md`, `/cctp/references/technical-guide.md`, `/cctp/concepts/fees.md`, `/cctp/concepts/finality-and-block-confirmations.md`, `/cctp/concepts/fast-transfer-allowance.md`, `/cctp/concepts/supported-chains-and-domains.md`, `/cctp/concepts/forwarding-service.md`, `/cctp/concepts/upfront-fees.md`, `/cctp/concepts/upfront-fee-quotes.md`, `/cctp/howtos/get-transfer-fee.md`, `/cctp/quickstarts/transfer-usdc-ethereum-to-arc.md` | Addresses, interfaces, fees, timing, API hosts, rate limit, audits |
| `circlefin/evm-cctp-contracts` | commit `63ab1f0ac06ce0793c0bbfbb8d09816bc211386d` (the commit the technical guide links) | `src/v2/TokenMessengerV2.sol`, `src/v2/BaseTokenMessenger.sol`, `src/roles/v2/Denylistable.sol`, `src/roles/Attestable.sol`, `src/proxy/AdminUpgradableProxy.sol` |
| Circle Iris sandbox API | `https://iris-api-sandbox.circle.com`, called 2026-10-12 UTC | Fees, Fast Transfer allowance, public keys, an upfront-fee quote, all without a key |
| Across documentation | `https://docs.across.to/llms.txt` and `https://docs.across.to/llms-full.txt`, fetched 2026-10-11 | API keys, testnet host, fees, security model, refunds, audits, bug bounty, ERC-7683 |
| `across-protocol/contracts` | commit `950e9154f3d61e59590eb7d4403fae5d3cae84f8` | `broadcast/deployed-addresses.json`, `deployments/README.md`, `contracts/spoke-pools/SpokePool.sol`, `contracts/interfaces/V3SpokePoolInterface.sol` |
| Across testnet API | `https://testnet.across.to/api`, called 2026-10-12 UTC | `available-routes`, `suggested-fees`, `swap/approval` |
| ERC-7683 | `https://eips.ethereum.org/EIPS/eip-7683`, fetched 2026-10-11 | Status and current interface |
| OP Stack | `ethereum-optimism/superchain-registry` commit `cf854b99989ff3e78f01c44f2296791d7b400356` (`superchain/configs/sepolia/op.toml`, `superchain.toml`); `ethereum-optimism/optimism` commit `0e82422cd48d4610bf2ce67f8d376621f3c2602a` (`packages/contracts-bedrock/src/L1/L1StandardBridge.sol`, `src/universal/StandardBridge.sol`); `https://docs.optimism.io/app-developers/guides/bridging/standard-bridge.md` and `/messaging.md` | OP Sepolia addresses, bridge rules, delays |
| Base documentation | `https://docs.base.org/specifications/reference/base-contracts.md` and `/specifications/base-protocol/bridging/withdrawals.md`, fetched 2026-10-11 | Base Sepolia L1 addresses, admin roles, withdrawal window |
| Arbitrum documentation | `https://docs.arbitrum.io/arbitrum-essentials/reference/contract-addresses.md`, `/arbitrum-bridge/withdrawal-monitoring.md`, `/arbitrum-essentials/bridging/withdraw/tokens.md`, `/arbitrum-essentials/bridging/deposit/eth-and-messages.md`, `/arbitrum-bridge/usdc-arbitrum-one.md`, `/audit-reports`, fetched 2026-10-11 | Addresses, challenge period, aliasing, USDC types |
| LI.FI | `https://docs.li.fi/api-reference/rate-limits.md`, `/introduction/learn-more/security-and-audits.md`, `/introduction/lifi-architecture/smart-contract-addresses.md`, `/faqs/fees-monetization.md`; API `https://li.quest/v1/chains` and `/v1/quote` | Keys, limits, fees, audits, testnet coverage |
| Socket (formerly Bungee) | `https://docs.socket.tech/integrate/get-api-access.md`, `/about/chain-support.md`, `/about/fees-monetization.md`, `https://github.com/SocketDotTech/audits`; API `https://public-backend.socket.tech/v3/swap/supported-chains` | Keys, chains, fees, audits |
| Relay | `https://docs.relay.link/references/api/api-keys.md`, `/security/contract-audits.md`, `/security/compliance.md`, `/references/api/api_guides/testnet.md`; API `https://api.testnets.relay.link/chains` and `/quote` | Keys, trust model, audits, screening, testnet coverage |
| Stargate, LayerZero, Wormhole | `https://stargateprotocol.gitbook.io/stargate/v2-developer-docs` and `/technical-reference/testnet-contracts.md`; `https://docs.layerzero.network/v2/concepts/modular-security/security-stack-dvns.md`; `https://wormhole.com/docs/ai/pages/protocol-infrastructure-guardians.md` | Trust models, testnet pools |
| Sourcify | `https://sourcify.dev/server/v2/contract/<chainId>/<address>`, read 2026-10-12 UTC | Verification status |

Function selectors were computed as `keccak256(signature)[0:4]` with ethers 6.17.0 (the version installed in this repository): `depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)` = `0x8e0250ee`, `depositForBurnWithHook(…,bytes)` = `0x779b432d`, `receiveMessage(bytes,bytes)` = `0x57ecfd28`, Across `deposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)` = `0xad5425c6`, `depositV3(address,…)` = `0x7b939232`, ERC-7683 `open(uint256,bytes32,bytes)` = `0xbde8585f`, OP `depositETHTo(address,uint32,bytes)` = `0x9a2ac6d5`, `bridgeERC20To(address,address,address,uint256,uint32,bytes)` = `0x540abf73`, Arbitrum `depositEth()` = `0x439370b1`, `createRetryableTicket(…)` = `0x679b6ded`, Relay `depositNative(address,bytes32)` = `0x49290c1c`.

## 3. What the wallet needs from a bridge

The criteria below come from the project's standing requirements and earlier findings, not from the vendors.

- **Non-custodial (requirement 1 in `AGENTS.md`).** The user's EOA or Kernel smart account must be the only signer of anything that moves the user's funds. A provider may hold funds in a contract for the duration of a transfer, but no key held by the provider may be able to move them to someone else, and the wallet must not hand an API a signature it cannot read.
- **Pinnable calls.** Kernel's CallPolicy checks fixed 32-byte words of calldata at fixed offsets. A call can be constrained for a session key or a spending rule only when every argument that matters is fixed-size; a dynamic argument (`bytes`, arrays, structs containing them) is located through an offset the caller writes and cannot be checked reliably (`docs/SCHEDULED_PAYMENTS.md` sections 4.1 and 4.2). The live ERC-20 parameter rule proven in phase 13 (`AGENTS.md`, "EMULATOR RUN at 1fab9a6", the `CallViolatesParamRule()` refusal) is the mechanism such pins would use.
- **Exact approvals.** The wallet already refuses unlimited approvals on its own paths (the Circle paymaster approve and the staking wrap approve, `AGENTS.md` phases 13 and 18). Any provider whose API returns an unlimited approval must have it replaced.
- **Coverage of the four networks** the dev EOA holds USDC on (Ethereum Sepolia 11155111, Base Sepolia 84532, Arbitrum Sepolia 421614, OP Sepolia 11155420), with code present today and a source that can be checked.
- **Vendor evaluation as in phase 13** (`AGENTS.md`, "Item 2, research and engine half"): permissionless contracts versus a keyed service, Sourcify matches, who can upgrade, pause or censor, published audits, and gaps between documentation and chain.

## 4. Circle CCTP, version 2

### 4.1 What it is and the trust model

CCTP is described by Circle as "a permissionless onchain utility for crosschain digital asset transfers" that "natively transfers USDC across blockchains using burn-and-mint" (`https://developers.circle.com/cctp.md`). A transfer has three steps (`/cctp/references/technical-guide.md`, "Message passing"): the depositor calls `TokenMessengerV2.depositForBurn`, which burns the USDC through `TokenMinterV2` and emits a message through `MessageTransmitterV2.sendMessage`; Circle's off-chain attestation service, Iris, signs the message after the required finality; anyone then submits the message and the attestation to `MessageTransmitterV2.receiveMessage` on the destination, which mints USDC to the `mintRecipient` written into the burn message. Because the recipient is part of the signed message, whoever submits the mint cannot change who receives it (the message format is in the same guide, "Message body").

The trust model is Circle's:

- **Attestation.** `MessageTransmitterV2` accepts an attestation only when it carries `signatureThreshold` signatures from enabled attesters (`src/roles/Attestable.sol`, lines 215–242 at the pinned commit). On-chain today, `signatureThreshold()` = 2 and `getNumEnabledAttesters()` = 2 on all four test networks and on Ethereum mainnet: every mint depends on two Circle signatures, and an attester set that signed a false message could mint USDC. Since Circle also issues USDC, this is close to the trust a USDC holder already extends, but it adds Circle's attestation *liveness*: without an attestation, burned USDC cannot be minted. The technical guide notes that an expired Fast Transfer attestation can be re-attested "at any time" through `POST /v2/reattest/{nonce}`.
- **Finality.** Standard Transfers are attested "after hard finality"; Fast Transfers "after the transaction is confirmed and included in a block", backed by a global "Fast Transfer allowance" that Circle maintains to cover reorganisation risk (`/cctp/concepts/finality-and-block-confirmations.md`, `/cctp/concepts/fast-transfer-allowance.md`).
- **The 24-hour expiry.** A Fast Transfer message carries an `expirationBlock` "24 hours in the future"; after it, the mint reverts until the message is re-attested (technical guide, "Message body").

### 4.2 Who can pause, upgrade or censor

Read on-chain today, at the same addresses on all four test networks (role addresses were identical on all four; the "kind" column was checked on Ethereum Sepolia):

| Role | Contract and getter | Ethereum Sepolia value | Kind | Effect (from the pinned source) |
|---|---|---|---|---|
| Proxy admin of TokenMessengerV2 | EIP-1967 admin slot `0xb531…6103` | `0xDc2C2406aD086ca69Bd52ccE5B74434858D3B042` | no code (EOA) | Can replace the implementation (`AdminUpgradableProxy.sol`, `upgradeTo`) |
| Proxy admin of MessageTransmitterV2 | same slot | `0x5abd1d39301FD4484b829CD1F0D4F17A6AF9569f` | no code (EOA) | Same |
| TokenMessengerV2 owner | `owner()` | `0xb941616ac6ab1d5851644cef696A5284F79CfBB9` | no code | Adds and removes remote messengers and the local minter, sets the fee recipient (`BaseTokenMessenger.sol` lines 142–190) |
| Denylister | `denylister()` | `0x87Ef255bAe5184171da2E887428Fe44aF294e938` | no code | Adds addresses to a denylist; `depositForBurn` and `depositForBurnWithHook` carry `notDenylistedCallers`, which checks `msg.sender` **and `tx.origin`** (`Denylistable.sol` lines 87–93) |
| MessageTransmitterV2 pauser | `pauser()` | `0xec1c6e9f8f5EB84a3407DdA956E7aa9D2e272a88` | no code | `sendMessage` and `receiveMessage` are `whenNotPaused` (`MessageTransmitterV2.sol` lines 149 and 209) |
| Attester manager | `attesterManager()` | `0xD879986C25EfF0f924c199Ec438B246BEF86Da01` | no code | Enables and disables attesters, sets the threshold (`Attestable.sol` lines 100–171) |
| TokenMinterV2 pauser | `pauser()` | `0x149c357a4324Ed57577b7682E702fd4E7147b0Bd` | not checked | Pauses minting and burning |

On Ethereum mainnet the corresponding holders are different addresses, and every one checked (both proxy admins, the TokenMessengerV2 owner, the denylister, the MessageTransmitterV2 pauser and the attester manager) also has **no contract code**: they are externally owned accounts, or keys Circle manages off-chain in a way the chain does not show. How Circle secures them could not be verified. Nothing is paused today: `paused()` is `false` on MessageTransmitterV2 and TokenMinterV2 on all four test networks and on mainnet.

One consequence for account abstraction, reasoned from the denylist source and not tested: a burn sent as an ERC-4337 UserOperation has the bundler's EOA as `tx.origin`, so a denylisted bundler would make every burn it carries revert.

### 4.3 Permissionless contracts versus a keyed API

The contracts are permissionless: `depositForBurn` has no caller allow-list beyond the denylist, and `receiveMessage` may be called by anyone when `destinationCaller` is zero (contract-interfaces page). The API is keyless in practice: on 2026-10-12 the sandbox host `https://iris-api-sandbox.circle.com` answered `GET /v2/burn/USDC/fees/{src}/{dst}` for nine routes between the four domains, `GET /v2/fastBurn/USDC/allowance` and `GET /v2/publicKeys` with HTTP 200 and no credentials, and `POST /v2/quote/burn/usdc/6/3` returned a signed upfront-fee quote without a key. The documentation's code samples call these endpoints without an `Authorization` header (`/cctp/concepts/fees.md`, `/cctp/howtos/get-transfer-fee.md`). Circle's documentation index carries a generic "API key required" banner for its products, but none of the CCTP endpoints used here asked for one. The documented limit is "40 requests per second", after which "the service blocks all API requests for the next five minutes" (technical guide, "API service hosts"). The mainnet host is `https://iris-api.circle.com`.

The API is needed only to fetch the attestation (`GET /v2/messages/{sourceDomain}?transactionHash=…`, quickstart lines 354 and 489) and, optionally, the current fee. Nothing the API returns is signed by the user, and the attestation is verified on-chain against the enabled attesters, so a dishonest API can withhold an attestation but cannot redirect funds.

### 4.4 What the wallet can pin

`depositForBurn` takes seven fixed-size arguments, so every one sits at a fixed offset after the selector `0x8e0250ee`:

| Offset | Argument | Pin |
|---|---|---|
| 0 | `amount` | At most the per-transfer cap |
| 32 | `destinationDomain` | One of 0, 2, 3, 6 (Ethereum, OP, Arbitrum, Base; `/cctp/concepts/supported-chains-and-domains.md`) |
| 64 | `mintRecipient` | The account's own address, left-padded; a Kernel account has the same address on every network (the emulator's Kernel account `0xD31c…D8FA` holds USDC on Sepolia and Base Sepolia at the same address, `AGENTS.md` phase 13) |
| 96 | `burnToken` | The network's USDC |
| 128 | `destinationCaller` | Zero (anyone may complete the mint) or the account itself (only the account may) |
| 160 | `maxFee` | Zero for a Standard Transfer, or a cap |
| 192 | `minFinalityThreshold` | 2000 (Standard) or 1000 (Fast) |

The approval that precedes it is `approve(TokenMessengerV2, amount)` on USDC, which the existing ERC-20 rule can pin to the exact amount. `depositForBurnWithHook` adds a dynamic `hookData` argument; its first seven words stay at the same offsets, but the hook itself cannot be pinned. `receiveMessage(bytes,bytes)` is entirely dynamic but needs no pin: the recipient and amount come from the attested message. `TokenMessengerWithFees.depositForBurnWithFees`, the upfront-fee path, takes a signed quote struct and cannot be pinned beyond its first five words.

This is the only provider evaluated whose user-facing call can be pinned completely.

### 4.5 Test-network coverage

Addresses are from Circle's contract-address page (fetched as `https://developers.circle.com/cctp/evm-smart-contracts`); the same addresses are listed for all four test networks.

| Contract | Address | Code today (all four) | Sourcify |
|---|---|---|---|
| TokenMessengerV2 (proxy) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | 2,175 bytes, identical hash `0xd2c8d480…` | exact match (Sepolia) |
| TokenMessengerV2 implementation (EIP-1967 slot) | `0xf80e9E448F9d8cBFc42703419D78fE36FC350b76` on all four | — | exact match on all four |
| MessageTransmitterV2 (proxy) | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | 2,175 bytes, same proxy code | exact match (Sepolia) |
| MessageTransmitterV2 implementation | Sepolia `0x0Bf2A7Bc…8223`, Base Sepolia `0xb1Ab861E…DF5F`, Arbitrum Sepolia `0x81066282…420C`, OP Sepolia `0x31f70ecE…9Da9` | — | exact match on all four |
| TokenMinterV2 | `0xb43db544E2c27092c107639Ad201b3dEfAbcF192` | 9,295 bytes, identical hash `0xfc330d52…` | exact match on Sepolia, Arbitrum Sepolia and OP Sepolia; not on Sourcify for Base Sepolia, but its code hash equals the verified copies |
| MessageV2 (helper library) | `0xbaC0179bB358A8936169a63408C8481D582390C4` | 281 bytes, identical hash `0x14271770…` | exact match on the three rollups; not on Sourcify for Sepolia (same code hash) |
| TokenMessengerWithFees (UUPS-style proxy, no admin slot) | `0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A`, implementation `0x9DC13cC5Ea23c2E3640F8071Acda8bf90cCb8f6F` | 130 bytes | implementation exact match (Sepolia) |

Wiring, read on-chain: on each network `localMinter()` is the TokenMinterV2 address and `localMessageTransmitter()` the MessageTransmitterV2 address; `remoteTokenMessengers(d)` returns `0x8FE6…2DAA` for each of the *other three* domains and zero for its own; `localDomain()` is 0, 6, 3 and 2 respectively; USDC's `isMinter(TokenMinterV2)` is `true` on all four; `burnLimitsPerMessage(USDC)` is 10,000,000,000,000 base units (10 million USDC), matching the documented "$10 million limit". `getMinFeeAmount(1e6)` reverts on all four and on mainnet, which is what the fees page predicts for a TokenMessengerV2 "without fee switch support". The mainnet TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` has the same proxy code; its implementation `0x555E2725…3ec8` and the MessageTransmitterV2 implementation `0xa30C4186…1186` are Sourcify exact matches on chain 1.

All twelve directed routes between the four test networks are therefore deployed, registered and unpaused today.

### 4.6 Assets

USDC only for this path. Circle's index also lists EURC and "registered third-party assets" through a different entry contract, `CrossChainTokenService`, with a fee "paid in native gas on the source blockchain" (`/cctp.md`, comparison table); that path was not evaluated. ETH cannot move through CCTP.

### 4.7 Speed and fees

| | Standard Transfer | Fast Transfer |
|---|---|---|
| Documented time (mainnet tables) | Ethereum, Arbitrum, Base, OP Mainnet: about 65 Ethereum blocks, "~15-19 minutes" | Ethereum about 20 seconds; Arbitrum, Base, OP Mainnet about 8 seconds |
| Documented protocol fee | 0 bps on every listed chain | Ethereum 1 bp, Arbitrum 1.4 bps, Base 1.3 bps, OP Mainnet 1.3 bps; "subject to change"; deducted at mint unless paid upfront |
| Testnet fee (Iris sandbox today) | 0 on all nine routes queried | 1 bp from Sepolia; 1.3 bps from Base Sepolia, Arbitrum Sepolia and OP Sepolia (so Arbitrum's testnet figure differs from its mainnet 1.4) |

Sources: `/cctp/concepts/finality-and-block-confirmations.md`, `/cctp/concepts/fees.md`, the sandbox `fees` endpoint. If `maxFee` is below the current Fast fee, "Fast Transfers may be degraded to Standard Transfers"; if the actual fee exceeds `maxFee` the burn reverts. The sandbox's Fast Transfer allowance read 99,999,999,766.70 USDC. Attestation times on the test networks were not measured (section 14). Gas on both sides is extra; the destination mint needs a funded submitter (section 4.10).

Circle also offers an optional **Forwarding Service** that submits the destination mint for the user, for a fee covering destination gas plus a service fee of "$0.05" on ordinary routes, requested through hook data (`/cctp/concepts/forwarding-service.md`); the supported-chains page says Arbitrum, Base, Ethereum and OP Mainnet support it, and "If a mainnet is listed, its official testnet is also supported".

### 4.8 Audits

The technical guide ("Security audit") links three reports, all of which downloaded as PDF today: ChainSecurity, CCTP V2 (`https://6778953.fs1.hubspotusercontent-na1.net/hubfs/6778953/PDFs/ChainSecurity_Circle_CCTP_V2_audit%20(1).pdf`); OtterSec (`…/PDFs/public_evm_cctp_audit_final%20(2).pdf`); and ChainSecurity, "CCTP (with Standard Transfer fee switch)", July 2025 (`…/CCTP/ChainSecurity_Circle_CCTP_audit_2025-07.pdf`). Which commit each report covers, and whether it matches the deployed implementations, was not checked (section 14).

### 4.9 SDK, keys and rate limits

No key was needed for anything used here (section 4.3). Circle recommends "Bridge Kit" (`@circle-fin/bridge-kit` on npm) for front ends; the wallet would not need it, since the calls are three ABI-encoded functions and one HTTP GET, all of which the engine's existing `NodeClient` and fetch code can make.

### 4.10 Relation to the Circle paymaster the wallet already uses

Circle's v0.7 token paymaster `0x31BE08D380A21fc740883c0BC434FcFc88740b58` has code today on Base Sepolia and Arbitrum Sepolia (144 bytes, identical), has code on Ethereum Sepolia (141 bytes) where phase 13 found it unusable ("entryPoint() reverts and its v0.7 deposit is 0"), and has **no code on OP Sepolia** (consistent with phase 18's record). So:

- **Source side, Base Sepolia or Arbitrum Sepolia.** A Kernel account can batch `approve(TokenMessengerV2, amount)` and `depositForBurn(…)` in one UserOperation and pay the network fee in USDC through the paymaster. Phase 13 established that the paymaster pulls its USDC with a permit during validation, independently of the operation's own approvals, so the two do not interfere (reasoned from that record; not run).
- **Destination side, the first arrival.** If the account holds no USDC on the destination network, the paymaster cannot pay for the `receiveMessage` operation that mints it: phase 13 recorded that "the paymaster pulls the prefund DURING VALIDATION, so an approve batched into the same op is too late", and the mint is likewise an execution-phase effect. The mint must therefore be submitted by someone with gas on the destination: the user's EOA there, any third party (the mint still goes to the pinned recipient when `destinationCaller` is zero), a sponsoring paymaster (input W8, still unmet), or Circle's Forwarding Service for a fee. Once some USDC has arrived, later operations on that network can use the USDC fee.
- **Ethereum Sepolia and OP Sepolia** have no usable Circle paymaster, so there the burn or mint is paid in test ETH (or through Pimlico's ERC-20 paymaster on Ethereum Sepolia, proven live in phase 14).

The pairing in the working hypothesis therefore holds for two networks and only after the first USDC has landed.

### 4.11 Non-custodial fit

Good. The user's EOA or Kernel account is the only signer of the burn; no signature is given to Circle's API; the mint is bound to the recipient in the attested message; and anyone can complete it. What the user trusts is Circle as issuer and attester, plus Circle's ability to pause, denylist and upgrade (section 4.2) — the same issuer whose USDC the wallet already shows and whose paymaster it already uses on test networks.

### 4.12 Readiness switchboard

A new row, for example `bridging-cctp`, would be `testnet-only` and enforced, like `token-gas` and `staking` (`app/src/config/readiness.ts`). Its reason should name the Circle trust in plain words: two Circle attesters must sign every transfer, and Circle can pause transfers, refuse callers and replace the contracts. Mainnet would need the mainnet addresses verified on each chain (only Ethereum mainnet was read here), the audit coverage confirmed against the deployed implementations, and the general mainnet conditions C1–C3 in `docs/THREAT_MODEL.md` section 7 for the smart-account path.

## 5. Across Protocol and ERC-7683

### 5.1 What it is and the trust model

Across is "a crosschain interoperability protocol" with "three settlement mechanisms: Intents (relayer network), CCTP (USDC), and OFT (USDT)" (`https://docs.across.to/llms.txt`). In the intent path (docs, "Intent Lifecycle in Across"), the user deposits into the origin chain's SpokePool, where "the user's input tokens are pulled into the SpokePool and escrowed"; a relayer pays the recipient on the destination from its own funds; a "dataworker" later proposes a "root bundle" of relayer repayments to the HubPool on Ethereum with a bond, and the bundle is accepted unless disputed within a challenge period, disputes being resolved by UMA token holders' vote (docs, "Security Model and Verification"). Across calls this a "1-of-N" assumption: "a single honest actor" suffices to dispute an invalid proposal. If no relayer fills before `fillDeadline`, the deposit is refunded through the next bundle, which "can take several hours" (docs, "Refunds"). The documentation also records a governance change: "The Bridge Across" proposal to move Across "from a token-based DAO to a private U.S. C-corporation" passed its Snapshot vote (docs, "The Bridge Across").

The user's exposure is therefore: escrow in an upgradeable SpokePool until a relayer fills or the refund executes; the relayer's quote (the output amount is fixed by the user at deposit, so a relayer either delivers it or does not fill); and, for refunds, the bundle process and UMA's oracle.

### 5.2 Who can pause, upgrade or censor

From `contracts/spoke-pools/SpokePool.sol` at the pinned commit: `_authorizeUpgrade`, `pauseDeposits`, `pauseFills` and `setCrossDomainAdmin` are `onlyAdmin` (lines 325–354), and `deposit` is `unpausedDeposits` (line 546). On-chain today:

| | Ethereum Sepolia | Base Sepolia | Arbitrum Sepolia | OP Sepolia | Ethereum mainnet |
|---|---|---|---|---|---|
| SpokePool `crossDomainAdmin()` | HubPool `0x14224e63…7d9e` | same | same | same | HubPool `0xc186fA91…bEda` |
| `pausedDeposits()` / `pausedFills()` | false / false | false / false | false / false | false / false | false / false |
| HubPool `owner()` | `0x9A8f92a8…b04D`, no code (EOA) | — | — | — | `0xB5247353…3715`, a Safe with threshold 3 of 5 owners |
| HubPool `liveness()` (challenge window, seconds) | 601 | — | — | — | 1,800 |
| HubPool `bondAmount()` | 1 wei of bond token `0x0246FBF4…22C7` | — | — | — | 0.45 of `0xee1DC6BC…02ea` (the BondToken in `deployed-addresses.json`) |

On the test networks the settlement layer is a demonstration: a ten-minute challenge window, a 1-wei bond and a single-key owner. Whether the testnet dataworker actually proposes bundles (and so whether testnet refunds ever execute) could not be verified (section 14); the SpokePools are in use (`numberOfDeposits()` read 1,011,088 on Sepolia and 1,003,302 on Base Sepolia).

### 5.3 Permissionless contracts versus a keyed API

The SpokePool's `deposit` is permissionless. Production use of the API "requires two credentials", an API key in the `Authorization` header and a 2-byte integrator ID; "Testnet does not require an API key or integrator ID", served from `https://testnet.across.to/api` (docs, "API Keys & Integrator ID"). Without a key, production requests "are subject to strict rate limits" (no figure given). Today the testnet API answered `available-routes`, `suggested-fees` and `swap/approval` with no credentials.

The wallet can build the deposit itself from the SpokePool ABI, but it needs the API (or its own relayer-fee model) to choose an `outputAmount` a relayer will accept. The quote is advisory: the user signs the amounts, and a relayer either fills them or the deposit is refunded.

### 5.4 What the wallet can pin

`deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)` (selector `0xad5425c6`; SpokePool.sol lines 533–546) has eleven fixed-size arguments at offsets 0 to 320 and one dynamic `message`. A CallPolicy can pin:

- `depositor` (offset 0) to the account itself. **This pin is essential.** The contract pulls tokens from `msg.sender` but takes `depositor` as a free argument: the source checks only that it is a valid address (`_depositV3`, around line 1385), and the interface documents `depositor` as "the account credited with the deposit who can request to 'speed up' this deposit by modifying the output amount, recipient, and message", while refunds default to the depositor (docs, "Refunds"). An unpinned key could name another depositor.
- `recipient` (32) to the account itself; `inputToken` (64) and `outputToken` (96) to the network's USDC or WETH; `inputAmount` (128) to at most a cap; `destinationChainId` (192) to the four test networks.
- `outputAmount` (160) only to a **static floor**, with the same weakness as the DCA floor in `docs/SCHEDULED_PAYMENTS.md` section 4.1: the floor cannot follow the market.
- `quoteTimestamp` and `fillDeadline` are bounded by the contract itself (`depositQuoteTimeBuffer()` = 3,600 s and `fillDeadlineBuffer()` = 21,600 s on all four test networks today).

`message` cannot be pinned. The source comment states that "If the message is not empty, the recipient contract must implement handleV3AcrossMessage() or the fill will revert" (SpokePool.sol, the `deposit` natspec), so with `recipient` pinned to a Kernel account a non-empty message should only cause a failed fill and a refund; whether Kernel v3.3 implements that function was not checked (section 14). Integrator IDs are appended after the ABI encoding ("Appending Integrator ID to Calldata"), which a CallPolicy ignores; the testnet quote today ended with three extra bytes `73c0de` whose meaning is not documented.

The API's own transaction is not acceptable as returned: `swap/approval` for 5 USDC from Sepolia to Base Sepolia returned `approvalTxns[0].data` = `approve(SpokePool, 2^256 − 1)`, an **unlimited** approval. The wallet must issue an exact approval instead.

### 5.5 Test-network coverage

Addresses are from `broadcast/deployed-addresses.json` at the pinned commit, described by `deployments/README.md` as "the current source of truth for deployed contract addresses". The documentation's "Chains & Contracts" page renders its table from a component that the Markdown export does not contain, so it could not be compared.

| Network | SpokePool (proxy, 680 bytes, identical hash on all five chains) | Implementation (EIP-1967 slot) | Sourcify (implementation) |
|---|---|---|---|
| Ethereum Sepolia | `0x5ef6C01E11889d86803e0B23e3cB3F9E9d97B662` (proxy exact match) | `0x89930B37066b94a8eC8a795B273BF303F1F146Db` | match (partial, not exact) |
| Base Sepolia | `0x82B564983aE7274c86695917BBf8C99ECb6F0F8F` | `0x6B42367dcf51493cf3DD2e5afAfBCfAbc31903ab` | exact match |
| Arbitrum Sepolia | `0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75` | `0x197f4A9577dB8DC0BDE33E57Ef02A5C85dB6f6f1` | exact match |
| OP Sepolia | `0x4e8E101924eDE233C13e2D8622DC8aED2872d505` | `0x9C7caD4F858dd09CF38226699835565F353D50BD` | exact match |
| Ethereum mainnet (comparison) | `0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5` | `0x456Ac26E5ec083EE9889eBa0d1a0A582502B8e84` | exact match |

The Sepolia HubPool `0x14224e63716afAcE30C9a417E0542281869f7d9e` (17,628 bytes) is a Sourcify match; `SpokePoolPeriphery` `0x10D8b8DaA26d307489803e10477De69C0492B610` and `MulticallHandler` `0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E` have code on all four. The testnet `available-routes` response listed, among these four networks, every directed pair for USDC (Circle's USDC at both ends), ETH and WETH, plus a few USDbC/USDT routes.

**ERC-7683.** The documentation lists the `AcrossOriginSettler` only on Base (`0x4afb570AC68BfFc26Bb02FdA3D801728B0f93C9E`) and Arbitrum (`0xB0B07055F214Ce59ccB968663d3435B9f3294998`) mainnets ("ERC-7683 in Production"). Neither address has code on any of the four test networks or on Ethereum mainnet today, and no settler entry exists for any chain in `deployed-addresses.json`. Base and Arbitrum mainnet could not be read through the wallet's configured endpoints (section 14).

### 5.6 Assets

On the test networks: USDC, ETH and WETH among the four (above). The testnet relayers' limits are small: `suggested-fees` returned `maxDeposit` 8,002,312 base units (about 8.0 USDC) for Sepolia→Base Sepolia USDC and 3,147,413,023,208,236 wei (about 0.0031 ETH) for WETH on the same route; `minDeposit` was 9,059 base units and about 0.0000038 ETH. A live proof must stay under those figures.

### 5.7 Speed and fees

All fees are "derived from the spread between the inputAmount … and the outputAmount", split into an LP fee (utilisation-based) and a relayer fee (destination gas, capital cost, risk) (docs, "Fees in the System"); integrators may add an optional app fee. On mainnet the docs say relayers fill "most deposits in ~2 seconds" (docs, "Refunds"). Today's testnet quotes:

| Route (testnet) | Amount | Total relay fee | Components | Estimated fill |
|---|---|---|---|---|
| Sepolia → Base Sepolia, USDC | 5 USDC | 4,762 base units (0.095 %) | relayer capital 500, destination gas 2,264, LP 1,998 | 10 s |
| Sepolia → Base Sepolia, WETH/ETH | 0.001 ETH | 0.0000024 ETH (0.24 %) | relayer capital 0.0000001, destination gas 0.00000096, LP 0.0000013 | 10 s |

The `swap/approval` response for the USDC route reported a total of 4,801 base units, including a 39-unit "swapImpact".

### 5.8 Audits

The documentation's "Audits" section links OpenZeppelin reports for Across V3 (incremental, and with Oval), Across V2, the Across token and distributor, and four UMA reports; the three Across links fetched today returned HTTP 200 (`https://blog.openzeppelin.com/across-v3-and-oval-incremental-audit`, `https://blog.openzeppelin.com/across-v3-incremental-audit`, `https://blog.openzeppelin.com/uma-across-v2-audit/`). Whether any report covers the deployed implementation (which now takes `bytes32` addresses and includes CCTP and OFT paths) was not checked. A bug bounty offers "up to $1,000,000" for critical findings (docs, "Bug Bounty").

### 5.9 SDK, keys and rate limits

No key on the testnet host; a key and integrator ID for production (section 5.3). No SDK is needed to call the SpokePool.

### 5.10 Non-custodial fit

Acceptable with the pins in section 5.4. The user signs one deposit; no signature goes to the API; funds sit in an upgradeable SpokePool controlled, through the HubPool, by a 3-of-5 Safe on mainnet (an EOA on Sepolia). The gasless variant (`/swap/gasless`, an ERC-3009 or Permit2 signature broadcast by Across) is a different trust shape — the user hands a token-moving signature to a submitter — and should not be used in a first slice.

### 5.11 ERC-7683 itself

The EIP page shows ERC-7683 as **Draft**. Its current text explains that "Although the earlier draft defined standard data types for orders, these types were parameterized by implementation-specific fields", and introduces "programmable solvers" with named assumptions that "A solver MUST validate". Across's documented `open(uint256 fillDeadline, bytes32 orderDataType, bytes orderData)` is the earlier draft's shape. Whether Across will follow the rewrite is not stated in what was read. For the wallet this means feature 36 cannot be demonstrated against a standard-conforming contract on any of its test networks today, and `orderData` is dynamic, so an intent opened by a session key cannot be pinned.

### 5.12 Readiness switchboard

A `bridging-across` row, `testnet-only` and enforced, whose reason says that funds wait in Across's contract until a relayer pays out, that refunds take hours and depend on Across's settlement process, and that Across's operators can pause or upgrade those contracts.

## 6. The native rollup bridges

### 6.1 What they are and the trust model

The OP Standard Bridge (Base Sepolia and OP Sepolia) and Arbitrum's bridge are part of each rollup's own contracts. A deposit from Ethereum Sepolia is a message the rollup must include; a withdrawal is proven against the rollup's state on Ethereum and finalised after a challenge period, so no third party's signature is needed. They are the trust-minimised baseline, with two limits that matter here: they connect **a rollup and its parent chain only** (Base Sepolia ↔ Ethereum Sepolia, OP Sepolia ↔ Ethereum Sepolia, Arbitrum Sepolia ↔ Ethereum Sepolia), so Base Sepolia → Arbitrum Sepolia would be a withdrawal followed by a deposit; and the rollup operators can pause and upgrade them (below).

### 6.2 Addresses and code (Ethereum Sepolia side unless stated)

| | Base Sepolia (docs.base.org base-contracts) | OP Sepolia (superchain-registry `op.toml`) | Arbitrum Sepolia (docs.arbitrum.io contract-addresses) |
|---|---|---|---|
| Bridge entry | L1StandardBridge `0xfd0Bf71F60660E2f608ed56e1659C450eB113120` (2,472 bytes; Sourcify match; `version()` 2.8.0) | L1StandardBridgeProxy `0xFBb0621E0B23b5478B630BD55a5f21f67730B0F1` (2,472 bytes, same hash; Sourcify match; 2.8.2) | Delayed Inbox `0xaAe29B0366299461418F5324a79Afc425BE5ae21` (Sourcify match); L1 Gateway Router `0xcE18836b233C83325Cc8848CA4487e94C6288264` |
| Withdrawal contract | OptimismPortal `0x49f53e41452C74589E85cA1677426Ba426459e85` (`version()` 6.0.0) | OptimismPortalProxy `0x16Fc5058F25648194471939df75CF27A2fdC48BC` (5.8.0) | Outbox `0x65f07C7D521164a4d5DaC6eB8Fac8DA067A3B78F`; Bridge `0x38f918D0E9F1b721EDaA41302E399fa1B79333a9` |
| Rollup side | L2StandardBridge `0x4200…0010` (code on Base Sepolia) | L2StandardBridge `0x4200…0010` (code on OP Sepolia) | L2 Gateway Router `0x9fDD1C4E4AA24EEc1d913FABea925594a20d43C7` (code on Arbitrum Sepolia) |
| Paused today | bridge and portal `false` | bridge and portal `false` | Inbox `false` |

**A documentation gap on Arbitrum.** The documentation lists the Arbitrum Sepolia Rollup as `0xd80810638dbDF9081b72C1B33c65375e807281C8`. That contract reads `paused()` = `true` on two endpoints, and both the Bridge and the Outbox report `rollup()` = `0x042B2E6C5E99d4c521bd49beeD5E99651D9B0Cf4` (5,171 bytes; Sourcify exact match), which is not paused, has `confirmPeriodBlocks()` = 20, `baseStake()` = 36 ETH, `validatorWhitelistDisabled()` = false (only allow-listed validators), and emitted its latest `AssertionConfirmed` in Sepolia block 11,896,103 at 03:08:48 UTC on 2026-10-12, about 22 minutes before the read. The documented address appears to be a pre-upgrade rollup; tooling should read `Bridge.rollup()` rather than the table.

### 6.3 Who can pause or upgrade

- **Base Sepolia:** the L1StandardBridge and OptimismPortal share proxy admin `0x0389E59A…b1F3` (the "ProxyAdmin" in Base's table), whose `owner()` is `0x0fe88454…0BA9`, a Safe with threshold 2 of 2 owners, which is also the portal's `guardian()`. Base's mainnet roles are listed in its documentation as Safes ("Base Security Council", "CB Multisig", "Proxy Admin Owner (L1)") and Coinbase-managed EOAs (batch sender, output proposer, challenger).
- **OP Sepolia:** proxy admin `0x189aBAAa…85Bc`, owned by `0x1Eb2fFc9…56E2` (a Safe, threshold 2 of 2; the registry's `ProxyAdminOwner`); the portal's `guardian()` is `0x7a50f00e…Cf7E`, a Safe with threshold 1 of 1.
- **Arbitrum Sepolia:** the Inbox and Rollup sit behind proxy admin contracts (`0xdd63bCAA…78B8`, `0x5FEe78FE…D315`) whose owners could not be read with `owner()` (section 14).

### 6.4 Withdrawal delay: documentation versus chain

| | Documentation | On-chain today |
|---|---|---|
| OP Mainnet / OP Sepolia | "Transfers from OP Mainnet to Ethereum are completed in 7 days"; "7 days on mainnet, shorter on test networks" (`messaging.md` line 126); deposits "usually completed within 1-3 minutes" | OP Sepolia OptimismPortal `proofMaturityDelaySeconds()` = **604,800 s (7 days)**; `disputeGameFinalityDelaySeconds()` = 302,400 s (3.5 days) on the portal and its AnchorStateRegistry `0xa1Cec548…e64b`; respected game type 9. The test network is not shorter. |
| Base / Base Sepolia | Base mainnet: a finalization window of "5 days for a single-proof dispute game and 1 day on the dual-proof fast path", plus "about 20 to 60 minutes" for the state to be proposed (`withdrawals.md`) | Base Sepolia OptimismPortal `proofMaturityDelaySeconds()` = 0 and AnchorStateRegistry `0x2fF5cC82…5355` `disputeGameFinalityDelaySeconds()` = 0; respected game type 621. The window that applies lives in the game contract, which was not read (section 14). |
| Arbitrum One / Arbitrum Sepolia | Arbitrum One "45818 blocks ≈ 6.4 days", typical "~7 days"; Arbitrum Sepolia "20 blocks ≈ 4.0 minutes", typical "Minutes" (`withdrawal-monitoring.md`) | Active rollup `confirmPeriodBlocks()` = 20 (Ethereum Sepolia blocks); last confirmation 22 minutes before the read. Consistent with the documentation. |

On both stacks finalising a withdrawal is a separate transaction on Ethereum Sepolia that anyone may send: the OP portal's prove and finalize steps are submitted by "a relayer [who] is not necessarily the same entity which initiated the withdrawal" (`withdrawals.md`), and Arbitrum's `Outbox.executeTransaction` is "manual" and can be executed by "the user … or your infrastructure" (`withdrawal-monitoring.md`).

### 6.5 Assets: ETH yes, Circle's USDC no

- **OP Stack.** The Standard Bridge moves a token into "a bridged representation" that must implement `IOptimismMintableERC20` and "recognize the original native token as its `remoteToken()`" (`standard-bridge.md` lines 39–117). On Base Sepolia (`0x036C…CF7e`) and OP Sepolia (`0x5fd8…30D7`), Circle's native USDC reverts on `remoteToken()`, `l1Token()` and `bridge()`, so it is not such a token: bridging Sepolia USDC through the Standard Bridge would produce some other token, not the USDC the wallet tracks.
- **Arbitrum.** The L1 Gateway Router sends Sepolia USDC to the standard ERC-20 gateway `0x902b3E5f…3aFF`, and `calculateL2TokenAddress(Sepolia USDC)` returns `0x119f0E6303BEc7021B295EcaB27A4a1A5b37ECf0`, not Circle's Arbitrum Sepolia USDC `0x75fa…AA4d`. Arbitrum's own page on USDC distinguishes "Native USDC" from "Bridged USDC (USDC.e)" and points to CCTP for the native kind (`usdc-arbitrum-one.md`).
- **ETH** moves natively on both.

### 6.6 What the wallet can pin, and two smart-account traps

`depositETHTo(address _to, uint32 _minGasLimit, bytes _extraData)` (`0x9a2ac6d5`) has `_to` at offset 0, which can be pinned to the account. Two traps were found in the sources:

1. **OP Stack refuses contract callers on the short form.** `depositETH` and `depositERC20` and the bridge's `receive()` carry `onlyEOA` (`L1StandardBridge.sol` lines 133–180 at the pinned commit; the modifier requires `EOA.isSenderEOA()`, `StandardBridge.sol` line 105). A Kernel account must call `depositETHTo` / `bridgeETHTo` with an explicit `_to`. How `isSenderEOA` treats an EIP-7702-delegated EOA was not checked.
2. **Arbitrum aliases contract depositors.** For `depositEth`, "Contract caller: The ETH goes to the contract's aliased address on the child chain" and "7702-enabled account: Similar to contracts, uses the aliased address", the alias being the address plus `0x1111000000000000000000000000000000001111` (`eth-and-messages.md` lines 41–53). A Kernel account, or one of this wallet's EIP-7702-upgraded owners, that called `depositEth` would credit an address it does not normally control on Arbitrum. A smart-account deposit must use `createRetryableTicket` with an explicit `to` and refund addresses, and even then "If auto-redeem fails, excess deposit goes to the alias of the L1 sender" (same page, line 176).

### 6.7 Speed, fees, audits, keys

Speed: section 6.4. Fees: none of the pages read describes a bridge fee beyond gas on each side; whether one exists was not checked further. Audits: Arbitrum publishes a list (`https://docs.arbitrum.io/audit-reports`, HTTP 200); the OP monorepo keeps `docs/security-reviews` (HTTP 200); a Base-specific list was not located. No API or key is involved.

### 6.8 Non-custodial fit and readiness

The best trust model of the five, for ETH between Ethereum Sepolia and one rollup at a time. It does not solve the wallet's USDC case, rollup-to-rollup moves, or a short exit. A `bridging-native` row could be `testnet-only` and advisory rather than enforced on the trust argument alone, but the smart-account traps in section 6.6 argue for keeping it enforced until a slice has exercised them.

## 7. Aggregators: LI.FI, Socket (Bungee), Relay

An aggregator answers a quote request with a ready transaction to its own router or escrow, choosing among underlying bridges. For this wallet the decisive property is the one `docs/SCHEDULED_PAYMENTS.md` section 4.2 found for 0x: **the target and the calldata come from the API on every quote, so a CallPolicy cannot pin them**, and the user's protection reduces to what the wallet can decode and simulate before signing.

### 7.1 LI.FI

- **Coverage.** `GET https://li.quest/v1/chains` (unauthenticated) lists 70 EVM chains including all four test networks, each with a "diamond" router: Ethereum Sepolia `0xeCeC3970Ca674278DA8D9B1c484ACaF6B20181F5`, Base Sepolia and Arbitrum Sepolia `0x816Fc6EeE47e3157A666827a0C06205294C81770`, OP Sepolia `0x2eC99F867e78445148974c36588805653F119787`. All four have code today (254, 254, 254 and 5,176 bytes); Sourcify reports exact matches on Sepolia, Base Sepolia and OP Sepolia, and the Arbitrum Sepolia copy is not on Sourcify but has the same code hash as Base Sepolia's. `owner()` on all four returns `0xb05E63458A51731Aad26BdcD6E12246330E6095F`, which has no code (an EOA). Mainnet uses `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` "on most supported networks" (`smart-contract-addresses.md`).
- **What a quote returns.** A testnet quote for 5 USDC Sepolia → Base Sepolia returned `tool` "across" (AcrossV4) with `approvalAddress` and `to` both the diamond, 1,444 bytes of calldata under selector `0x1794958f`, an estimated output of 4,982,744 base units and these fees: "LIFI Fixed Fee" 12,500 (0.25 %), relayer 498, relayer gas 2,265, LP 1,993. The docs say "LI.FI charges a 0.25% service fee on each transaction" (`fees-monetization.md`).
- **Keys and limits.** Unauthenticated: `/quote` and `/advanced/routes` 75 requests per two hours, other endpoints 100 per minute; with a key from the Partner Portal, 100 requests per minute on a two-hour window (`rate-limits.md`). The quote's response headers confirmed `ratelimit-limit: 75`.
- **Audits.** "All audit reports are publicly available" at `https://github.com/lifinance/contracts/tree/main/audit/reports` (HTTP 200); a Cantina bug bounty "up to $1,000,000" (`security-and-audits.md`). The docs also describe "emergency pause mechanisms". Which facets the deployed diamonds use, and who can change them, was not checked.
- **Fit.** Usable for a read-only price comparison on the test networks; not acceptable as a signing path without decoding every facet the wallet would allow, and it adds a fee on top of the bridge it routes to.

### 7.2 Socket (formerly Bungee)

The documentation index is titled "Socket Docs" and its terms page "Terms of Use for Bungee". Three endpoints: `public-backend.socket.tech` with no authentication and a "Shared" limit for "Testing and prototyping"; `backend.socket.tech` with a domain allow-list; `dedicated-backend.socket.tech` with an API key at "20 rps (100 rps enterprise)" (`get-api-access.md`). "Socket does not charge any additional fees" (`fees-monetization.md`). Audits are collected at `https://github.com/SocketDotTech/audits` (folders `Bungee` and `Socket`). **No test network**: `GET /v3/swap/supported-chains` listed 40 chains and none of the four, and the documented mainnet Allowance Holder `0x50c4E75a…5909` and Open Router `0x50cFe7c1…5c4a` have no code on any of the four test networks. Socket cannot be evaluated on the wallet's networks.

### 7.3 Relay

- **Trust model.** Users deposit into a per-chain "Depository" and solvers "fill orders using their own capital"; the Depository is "Non-upgradable", has "No admin withdrawal", and releases funds only when the "Allocator" authorises it; "If the Allocator is compromised, it could authorize unauthorized withdrawals"; the Allocator uses "MPC signatures" and is governed by a Security Council multisig where "any single member can suspend an approved withdrawer"; an "Oracle" attests deposits and fills and "is the main trust-bearing component" (`contract-audits.md`). Relay also screens addresses with "HackBounty and Chainalysis" data and an internal blocklist, and "A fill-time screening failure does not trigger an automatic refund" (`compliance.md`).
- **Coverage.** `https://api.testnets.relay.link/chains` lists only Ethereum Sepolia and Base Sepolia. The Depository `0x5feab8db4534f9f7e2669bb260c57a01ad1c12e3` has 8,628 bytes of code on those two (Sourcify exact match on both) and none on Arbitrum Sepolia or OP Sepolia. On Sepolia its `owner()` (`0x28c50F93…d6B3`) and `allocator()` (`0x7A19Eba3…390A`) have no code.
- **What a quote returns.** A testnet `POST /quote` for 0.001 ETH Sepolia → Base Sepolia, sent without a key, returned HTTP 200 with one step: a 68-byte call `depositNative(address depositor, bytes32 id)` (`0x49290c1c`) to the Depository carrying only the depositor and an order id, with the expected output (0.000991969710067031 ETH), a minimum 3 % lower, and a "solver" address held off-chain in the order. The on-chain call is pinnable, but it does not commit to what the user receives.
- **Keys and limits.** Self-serve keys; default `/quote` 50 requests per minute per key; "Starting October 2, 2026, every `quote/v2` request will require a valid API key" (`api-keys.md`). The `/quote` endpoint used above did not require one on the testnet host.
- **Audits.** Spearbit (February 2025, Depository), Certora (June 2025, Depository), Zellic (November 2025, settlement protocol; April 2026, oracle). The Spearbit link returned HTTP 200; the Zellic settlement-protocol link (`github.com/relayprotocol/relay-settlement/…/Relay-Settlement-Protocol-Zellic-Audit.pdf`) returned **HTTP 404** today.

### 7.4 Readiness for aggregators

None should be offered on a signing path before a decoder exists for every contract and facet it could route through. If one is used for price comparison only, it needs no readiness row, but a keyed production API is a Chairperson decision (section 12).

## 8. Messaging layers: Stargate/LayerZero and Wormhole (trust model only)

- **LayerZero / Stargate.** Stargate V2 is "built on top of LayerZero V2", with "Hydra" wrapped assets "built on the OFT Standard" and an "AI Planning Module" off-chain (`stargateprotocol.gitbook.io/stargate/v2-developer-docs`). LayerZero lets "every application … configure a unique security threshold for each source and destination, known as X-of-Y-of-N", where required and optional "Decentralized Verifier Networks" must confirm a payload hash before an executor delivers it (`security-stack-dvns.md`). The security of a transfer is therefore whatever DVN set the application (here Stargate) configured. Stargate lists testnet contracts on Sepolia, Arbitrum Sepolia and Optimism Sepolia (not Base Sepolia), but its testnet USDC pools hold **their own test tokens**: `token()` reads `0x2F6F07CD…7590` on Sepolia, `0x3253a335…9773` on Arbitrum Sepolia and `0x48832723…4268` on OP Sepolia, none of which is Circle's USDC. Not a fit.
- **Wormhole.** "19 distributed nodes called Guardians"; every message becomes a "standard 13-of-19 multisignature attestation" (`protocol-infrastructure-guardians.md`). A committee bridge with no on-chain proof of the source chain's state. Not a fit for a first slice.

## 9. Comparison

| | CCTP V2 | Across | Native bridges | LI.FI | Socket | Relay |
|---|---|---|---|---|---|---|
| Four test networks covered today | All four, all routes registered | All four (relayer limits ~8 USDC / ~0.003 ETH) | Each rollup ↔ Ethereum Sepolia only | All four (routes through Across) | None | Sepolia and Base Sepolia |
| Circle's USDC | Yes (burn and mint) | Yes (relayer pays native USDC) | **No** (bridged token) | Yes, via Across | — | Not checked |
| ETH | No | Yes | Yes | Yes | — | Yes |
| Key needed (testnet / production) | No / not found | No / yes | None | No (75 quotes / 2 h) / optional | No / domain or key | No / yes for `quote/v2` |
| User call pinnable | Fully | Mostly (`message` not; `depositor` must be) | Mostly (`_to`) | No | No | Call yes, outcome no |
| Who must be trusted | Circle (2 attesters, pause, denylist, upgrade) | Relayers for speed; HubPool owner (3-of-5 Safe mainnet; EOA testnet); UMA for refunds | Rollup operators (Safes; upgrade, pause) | LI.FI router plus the routed bridge | — | Allocator (MPC), oracle, Security Council |
| Protocol fee | 0 Standard; 1–1.4 bps Fast | ~0.1 % on the testnet USDC quote | Gas only (as far as read) | 0.25 % plus the bridge's | "no additional fees" | relayer fee in the quote |
| Time | ~15–19 min Standard; ~8–20 s Fast (mainnet docs) | ~10 s testnet estimate; refunds hours | Deposits minutes; OP Sepolia withdrawals ≥ 7 days; Arbitrum Sepolia minutes | Routed bridge | — | ~4 s testnet estimate |
| ERC-7683 | No | Mainnet Base and Arbitrum only; Draft standard | No | No | No | No |

## 10. Recommendation

The working hypothesis was: CCTP for USDC first, Across second for ETH and the intents standard, the native bridges as the trust-minimised baseline, aggregators later. Against what was verified:

1. **CCTP V2 for USDC — confirmed as the first slice, with corrected claims.** Confirmed: permissionless contracts, identical and Sourcify-verified code on all four networks, every route registered and unpaused, a keyless API whose output is checked on-chain, a burn call the wallet can pin completely, no protocol fee on Standard Transfers, and a mint that cannot be redirected by whoever submits it. Corrected: the paymaster pairing covers Base Sepolia and Arbitrum Sepolia only, and it cannot pay for the first mint on a network where the account holds no USDC; and CCTP's trust model is Circle's (two attesters, EOA-held admin roles, a denylist that also checks `tx.origin`), which the screen must say. Scope for a first slice: Standard Transfers only (no fee, no allowance dependency), `destinationCaller` zero so that the user's EOA or any funded account can complete the mint, the recipient pinned to the sending account's own address, exact approvals, and the mint submitted by the user from the destination network.
2. **Across for ETH — second, but not for the intents standard.** It works on all four networks and its deposit is mostly pinnable, provided `depositor` and `recipient` are pinned to the account and the API's unlimited approval is replaced. The ERC-7683 half of the hypothesis is refuted for now: no `AcrossOriginSettler` exists on any of the wallet's networks, and the standard is a Draft whose current text differs from what Across implements. Feature 36 should stay "Not started" until a settler for the current draft exists on a test network.
3. **Native bridges — keep as the trust-minimised option for ETH between Ethereum Sepolia and a single rollup, not as the baseline for this wallet.** They cannot move Circle's USDC, cannot go rollup to rollup, take at least 7 days to leave OP Sepolia, and have two traps for smart accounts. A small slice ("deposit test ETH from Ethereum Sepolia to Base Sepolia / OP Sepolia / Arbitrum Sepolia") is cheap and honest if a trust-minimised path is wanted on screen.
4. **Aggregators — later, and only for comparison until a decoder exists.** Unpinnable calldata, keyed production APIs, extra fees, and (Socket) no test networks or (Relay) two of four with off-chain terms.
5. **LayerZero/Stargate and Wormhole — not recommended.** (Superseded for LayerZero by section 16 after the Chairperson's decision of 2026-10-14; Wormhole was not re-examined.)

## 11. What a live testnet proof of CCTP would need

Funds: the dev EOA holds about 20 USDC on each of the four networks (`AGENTS.md`, "INPUTS RECEIVED (2026-10-11)") and test ETH on Ethereum Sepolia; it needs test ETH on whichever destination network submits the mint (it had none on OP Sepolia on 2026-10-11, the same record notes). One or two USDC per leg is enough.

Steps, following the project's practice of a dry run first (`eth_simulateV1`, as in `scripts/testnet/token-gas-smoke.mjs`):

1. **EOA leg, Base Sepolia → Arbitrum Sepolia, Standard.** `approve(0x8FE6…2DAA, 1000000)` on Base Sepolia USDC; `depositForBurn(1000000, 3, bytes32(ownAddress), 0x036C…CF7e, bytes32(0), 0, 2000)` on TokenMessengerV2. Verify: the `DepositForBurn` event fields, a `MessageSent` event from `0xE737…E275`, and the USDC balance and total supply falling by exactly 1,000,000.
2. **Attestation.** Poll `GET https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=<burn hash>` until it returns a message and attestation; record the time from the burn's block to the first complete answer (testnet attestation time is unknown, section 14).
3. **Mint.** `receiveMessage(message, attestation)` on Arbitrum Sepolia's `0xE737…E275`, sent by the dev EOA. Verify: `MessageReceived`, a mint of exactly 1,000,000 to the recipient, and that a second submission of the same message reverts (nonce used).
4. **Smart-account leg.** A Kernel operation on Base Sepolia batching the exact approval and the burn, fee paid in USDC through the Circle paymaster; verify as in step 1 plus the paymaster's `UserOperationSponsored` charge. Mint on Arbitrum Sepolia to the same Kernel address (undeployed is fine for receiving), submitted by the dev EOA, then spend some of it in a later Kernel operation there paying the fee in USDC, demonstrating the destination pairing after first arrival.
5. **Negative checks.** A burn with `maxFee` ≥ amount reverts ("Max fee must be less than amount", `TokenMessengerV2.sol` line 309); a second mint of the same message reverts; a session key whose CallPolicy pins `mintRecipient` refuses a burn to another recipient (the phase-13 `CallViolatesParamRule()` path).
6. **Optional Fast Transfer** with `minFinalityThreshold` 1000 and `maxFee` covering 1.3 bps plus a margin, recording the attestation time and the fee actually executed.

An Across proof would mirror it: an exact approval and a `deposit` of at most 5 USDC (or 0.001 ETH) with the quoted `outputAmount`, then the destination `FilledRelay` event and balance. A refund test cannot be scheduled reliably because testnet bundle processing is unverified.

## 12. Decisions only the Chairperson can make

1. **The provider for the first slice.** The recommendation is CCTP V2, Standard Transfers, USDC only.
2. **Whether Circle's trust model is acceptable for a bridge**, in addition to the paymaster: two Circle attesters, Circle-held pause, denylist and upgrade roles whose holders have no on-chain multisig, and Circle as the issuer.
3. **Whether a keyed API is acceptable for mainnet.** CCTP needed no key here; Across, Relay and Socket require keys or allow-listing in production, and LI.FI rate-limits unauthenticated use to 75 quotes per two hours.
4. **Whether to pay for convenience.** Fast Transfer (1–1.4 bps), Circle's Forwarding Service (destination gas plus $0.05) or Across's relayer fees, versus Standard Transfers that are free and slow.
5. **Mainnet addresses.** Only Ethereum mainnet was read here (CCTP and Across); Base, Arbitrum and OP mainnet addresses would need on-chain verification through endpoints the wallet does not yet configure, alongside the existing mainnet conditions (C1–C3, `docs/THREAT_MODEL.md`; `docs/MAINNET_READINESS.md`).
6. **Whether feature 36 (ERC-7683) waits** for a settler implementing the current draft on a test network.

## 13. Documentation-versus-chain gaps found

1. **OP Sepolia's withdrawal delay is not shorter than mainnet's.** OP's documentation says the challenge period is "7 days on mainnet, shorter on test networks"; OP Sepolia's portal reads `proofMaturityDelaySeconds()` = 604,800.
2. **Arbitrum's contract table lists a paused rollup.** The documented Arbitrum Sepolia Rollup `0xd808…81C8` is paused; the Bridge and Outbox point to `0x042B…0Cf4`.
3. **Circle's testnet Fast fee for Arbitrum differs from its mainnet table** (1.3 bps from the sandbox versus 1.4 bps documented for Arbitrum).
4. **Across's testnet `swap/approval` response returns an unlimited approval** (`approve(SpokePool, 2^256 − 1)`); the wallet must replace it with an exact one. This is a design choice of the API rather than a contradiction of a documented statement, but it is listed here because it conflicts with the wallet's exact-approval rule.
5. **Relay's settlement-protocol audit link returns HTTP 404.**

## 14. Could not verify

- How Circle secures the EOA-held CCTP roles (proxy admins, owners, denylister, pausers, attester manager), and which commits the three CCTP audit reports cover.
- CCTP attestation times on the test networks; whether the Forwarding Service and upfront fees work on each of the four test networks in practice (the documentation says testnets follow their mainnets).
- Whether a denylisted bundler (`tx.origin`) would in practice block UserOperation burns, and whether Kernel v3.3 implements `handleV3AcrossMessage` (both reasoned from source, not tested).
- Whether Across's testnet dataworker proposes bundles, and therefore whether testnet refunds execute; which audit covers the deployed SpokePool implementations; the meaning of the trailing bytes `73c0de` on the testnet calldata; Across's production rate limits without a key.
- The `AcrossOriginSettler` on Base and Arbitrum mainnets (not readable through the wallet's configured endpoints) and whether Across will implement the current ERC-7683 draft.
- Base Sepolia's actual withdrawal window (it lives in the game-type-621 contract, which was not read); OP Sepolia's dispute-game clock beyond the two delays read; the owners behind Arbitrum Sepolia's proxy admin contracts; how OP's `isSenderEOA` treats an EIP-7702-delegated EOA; whether the native bridges charge anything beyond gas; a Base-specific audit list.
- Which facets LI.FI's diamonds route through and who can change them; what selector `0x1794958f` decodes to.
- Socket's behaviour on any test network (none is served); Relay's handling of a quote with a real wallet address, and its testnet fill times.
- Stargate's mainnet DVN configuration; any Wormhole testnet deployment (not looked for).
- The Stargate documentation home `https://docs.stargate.finance/` could not be fetched (connection reset); the GitBook copy was used instead.

## 15. LayerZero V2 and Stargate V2 on the four test networks (phase 21)

Written on 2026-10-14 (US Eastern) for phase 21 item 1 (`AGENTS.md`, "Phase 21 plan"), after the Chairperson's decision of 2026-10-14 to offer LayerZero alongside CCTP and let the user choose. As in sections 4 to 9, nothing was sent: every chain fact is a read-only `eth_getCode`, `eth_call` or `eth_simulateV1` through the keyless endpoints `ethereum-sepolia-rpc.publicnode.com`, `base-sepolia-rpc.publicnode.com`, `arbitrum-sepolia-rpc.publicnode.com` and `optimism-sepolia-rpc.publicnode.com` (Pocket fallbacks were configured but not needed), between 02:25 and 02:50 UTC on 2026-10-15. The first set of reads used Ethereum Sepolia block 11,917,458, Base Sepolia 48,131,585, Arbitrum Sepolia 319,280,105 and OP Sepolia 50,114,465; later reads in the same half hour used newer blocks, named where they matter. The engine interface built on these facts is described in `docs/BRIDGE_PROVIDERS.md`.

### 15.1 Sources

| Source | Pinned at / fetched | Used for |
|---|---|---|
| LayerZero documentation (Markdown export, index `https://docs.layerzero.network/llms.txt`) | fetched 2026-10-15 UTC: `/v2/deployments/chains/sepolia.md`, `base-sepolia.md`, `arbitrum-sepolia.md`, `optimism-sepolia.md`; `/v2/concepts/modular-security/security-stack-dvns.md`; `/v2/concepts/permissionless-execution/executors.md`; `/v2/concepts/protocol/layerzero-endpoint.md`; `/v2/concepts/protocol/transaction-pricing.md`; `/v2/concepts/message-options.md`; `/v2/concepts/technical-reference/oft-reference.md`; `/v2/developers/evm/technical-reference/transfer-ownership.md`; `/v2/developers/evm/stargate/overview.md`; `/v2/concepts/applications/stargate-finance.md`; `/v2/deployments/oft-ecosystem-stargate-assets.md`; `/v2/tools/layerzeroscan/testnet/messages/get-messagestx.md` | Endpoint ids, trust model, roles, fees, Stargate send modes, the Scan API |
| LayerZero deployment metadata | `https://metadata.layerzero-api.com/v1/metadata/deployments` and `/v1/metadata/experiment/ofts/list`, fetched 2026-10-15 UTC (the chain pages render their tables from these) | Endpoint, library, executor and DVN addresses; the ecosystem OFT list |
| `LayerZero-Labs/LayerZero-v2` | commit `9c741e7f9790639537b1710a203bcdfd73b0b9ac` (main on 2026-10-15) | `protocol/contracts/EndpointV2.sol`, `MessageLibManager.sol`; `messagelib/contracts/uln/UlnBase.sol`, `SendLibBase.sol`, `uln302/SendUln302.sol`, `ReceiveUln302.sol`; `oapp/contracts/oft/interfaces/IOFT.sol`, `OFTCore.sol`, `OFT.sol`, `OFTAdapter.sol`, `libs/OFTMsgCodec.sol`; `oapp/OAppCore.sol`, `OAppSender.sol`, `libs/OAppOptionsType3.sol` (all paths under `packages/layerzero-v2/evm/`) |
| `stargate-protocol/stargate-v2` | commit `9f4f5c0fc3e1df570415e441523c82fd94173588` | `packages/stg-evm-v2/src/StargateBase.sol`, `StargatePoolNative.sol`, `StargatePool.sol`, `usdc/StargateOFTUSDC.sol`, `interfaces/IBridgedUSDCMinter.sol`, `libs/Transfer.sol`; `deployments/{sepolia,arbsep,optsep}-testnet/*.json`; `LICENSE`; the `audits/` folder |
| Stargate testnet metadata | `https://testnet.stargate-api.com/v1/metadata?version=v2`, fetched 2026-10-15 UTC | Testnet pools and the tokens they hold |
| `LayerZero-Labs/Audits` | commit `880c6e206f25870321303df0a428790ecb19572d` (the docs' "Audits" link redirects to its `audits/` folder) | Audit report list |
| LayerZero Scan testnet API | `https://scan-testnet.layerzero-api.com/v1`, called 2026-10-15 UTC | Keyless message tracking |
| Circle's Bridged USDC Standard | `circlefin/stablecoin-evm` `doc/bridged_USDC_standard.md` at commit `fc85788bc7c23cefe3df1a757133048bfddadeaa` | What "bridged USDC" means |
| Sourcify | `https://sourcify.dev/server/v2/contract/<chainId>/<address>`, read 2026-10-15 UTC | Verification status, the mock token's source |
| Hardhat network reference | `https://hardhat.org/hardhat-network/docs/reference`, fetched 2026-10-15 UTC | The default development mnemonic (not reproduced here) |

Selectors and event topics were computed with ethers 6.17.0: `send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)` = `0xc7c7f5b3`, `quoteSend(…,bool)` = `0x3b6f743b`, `quoteOFT(…)` = `0x0d35b415`, `retryReceiveToken(bytes32,uint8,uint32,address,uint256,bytes)` = `0xa88835d7`, `Stargate_InvalidAmount()` = `0x3442dd95`; events `OFTSent` `0x85496b76…`, `OFTReceived` `0xefed6d35…`, `UnreceivedTokenCached` `0x007c1719…`, `PacketSent` `0x1ab700d4…`.

### 15.2 What it is and the trust model

LayerZero describes its endpoint as "the immutable, permissionless protocol entrypoint for sending and receiving omnichain messages" (`layerzero-endpoint.md`). An application ("OApp"), such as an Omnichain Fungible Token (OFT), sends a message through the endpoint and a send library; on the destination, the message can be delivered only after the application's configured Decentralized Verifier Networks (DVNs) have confirmed its payload hash: "Once the required DVNs and optionally a sufficient number of optional DVNs have confirmed the `payloadHash`, any authorized caller (for example, an Executor) can commit the message nonce" (`security-stack-dvns.md`). An executor then calls `lzReceive`, but "Both methods are **permissionless** on the endpoint contract, meaning anyone can call them once the message has been marked as verified" (`executors.md`); the source agrees (`EndpointV2.sol` lines 172–183: `lzReceive` has no caller restriction).

For a token, the OFT standard debits the sender on the source chain ("burns or locks") and the paired OFT "credits the recipient by minting new tokens or unlocking previously-held tokens" (`oft-reference.md`).

What a user trusts, stated plainly:

- **The verifiers the token's owner configured.** If the required DVNs (and the optional threshold) sign a false payload hash, the destination OFT mints or unlocks tokens that were never sent. There is no on-chain proof of the source chain's state in the default path.
- **The token's owner and its delegate.** LayerZero's ownership page says the Owner controls "`setPeer()`, `setEnforcedOptions()`, `setDelegate()`" and the Delegate controls "`setConfig()` (DVNs, Executor, confirmations), `setSendLibrary()`, `setReceiveLibrary()`, plus message recovery `skip()` / `nilify()` / `burn()` / `clear()`" (`transfer-ownership.md`). Either can change the security of a route at any time, and the delegate can destroy a message in flight.
- **The endpoint owner's defaults.** A pathway the OApp has not configured uses LayerZero's default configuration ("If you provide no configuration settings, the protocol will fallback to the default configuration", `security-stack-dvns.md`); the default send and receive libraries are set by the endpoint owner (`MessageLibManager.sol` `setDefaultSendLibrary` line 157 and `setDefaultReceiveLibrary` line 171, both `onlyOwner`) and the default DVN set by each library's owner (`UlnBase.sol` `setDefaultUlnConfigs`, `onlyOwner`).
- **The executor for liveness.** "Today, every default Executor across every pathway in every preset network configuration is operated by LayerZero Labs" (`executors.md`), and LayerZero's own warning reads: "A single operator controls both verification and execution on every pathway whose default has a working DVN" (`security-stack-dvns.md`).

### 15.3 The endpoint and libraries on the four networks

The deployment metadata lists, and the chain confirms:

| | Ethereum Sepolia | Base Sepolia | Arbitrum Sepolia | OP Sepolia |
|---|---|---|---|---|
| Endpoint id (`eid()` on-chain) | 40161 | 40245 | 40231 | 40232 |
| EndpointV2 | `0x6EDCE65403992e310A62460808c4b910D972f10f` on all four; 24,005 bytes on each (the code hashes differ, consistent with the immutable endpoint id); Sourcify "match" (not exact) on all four, solc 0.8.22 | | | |
| SendUln302 (`version()` 3.0.2 on all four) | `0xcc1ae8Cf5D3904Cef3360A9532B477529b177cCE` (Sourcify match) | `0xC1868e054425D378095A003EcbA3823a5D0135C9` (exact match) | `0x4f7cd4DA19ABB31b0eC98b9066B9e857B1bf9C0E` (match) | `0xB31D2cb502E25B30C651842C7C3293c51Fe6d16f` (not on Sourcify) |
| ReceiveUln302 | `0xdAf00F5eE2158dD58E0d3857851c432E34A3A851` (match) | `0x12523de19dc41c91F7d2093E0CFbB76b17012C8d` | `0x75Db67CDab2824970131D5aa9CECfC9F69c69636` | `0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca` (not on Sourcify) |
| Default executor | `0x718B92b5CB0a5552039B593faF724D182A881eDA` (an `OptimizedTransparentUpgradeableProxy`, Sourcify exact) | `0x8A3D588D9f6AC041476b094f97FF94ec30169d3D` | `0x5Df3a1cEbBD9c8BA7F8dF51Fd632A9aef8308897` | `0xDc0D68899405673b932F0DB7f8A49191491A5bcB` |
| Endpoint `owner()` | `0xc753bb48…63a5`: 7,197 bytes, `threshold()` 1, `getSigners()` 4 addresses, `VERSION()` "0.0.1" | `0x3c2E7425…195E`: a Safe 1.3.0 proxy, threshold 1 of 2 owners | `0x9f7cf878…0c62`: same shape as Sepolia's (1 of the same 4 signers) | `0x8F9e451e…09F4`: same shape (1 of the same 4 signers) |
| `lzToken()` / `nativeToken()` | zero / zero (fees in ETH only) on all four | | | |

The 7,197-byte owner contracts are not on Sourcify; their interface (`threshold()`, `getSigners()`, `VERSION()`) matches what LayerZero calls OneSig (the Audits repository has a "OneSig" folder), but the identification is an inference. The endpoint itself has no upgrade path (it is not a proxy), but its owner chooses the default libraries, and the libraries' owners (the same addresses, read with `owner()` on SendUln302) choose the default DVNs and executor.

### 15.4 The default security on these test networks

Read with `SendUln302.getUlnConfig(address(0), remoteEid)` and `getExecutorConfig`, and with `ReceiveUln302.getUlnConfig`, for every directed pathway among the four networks:

| From | Required DVNs | Optional DVNs | Source confirmations | Executor | Max message size |
|---|---|---|---|---|---|
| Ethereum Sepolia | 1: `0x8eebf8b4…9193` | none | 2 | `0x718B…1eDA` | 10,000 bytes |
| Base Sepolia | 1: `0xe1a12515…b2d6` | none | 2 | `0x8A3D…9d3D` | 10,000 |
| Arbitrum Sepolia | 1: `0x53f488E9…E8a8` | none | 5 | `0x5Df3…8897` | 10,000 |
| OP Sepolia | 1: `0xd680ec56…582C` | none | 1 | `0xDc0D…5bcB` | 10,000 |

The deployment metadata names each of those four DVNs "LayerZero Labs", and the Sepolia one is a Sourcify-verified contract named `DVN`. The receive side mirrors the send side (for example, Ethereum Sepolia's receive library expects 5 confirmations from Arbitrum Sepolia and 1 from OP Sepolia), with the receiving chain's LayerZero Labs DVN required. **So every default pathway among the four test networks is verified by one verifier and executed by one executor, both operated by LayerZero Labs.** LayerZero's documentation lists four default presets, A to D, each with two required DVNs or a "Dead DVN" (`security-stack-dvns.md`, "Default Configuration"); the single-LayerZero-Labs-DVN default read here is not among them. It may be a test-network practice; the documentation does not say.

### 15.5 OFTs and Stargate pools on the four networks

**Ecosystem OFTs.** The OFT list the deployment pages read (`/v1/metadata/experiment/ofts/list`) contains 75 chain keys, none of them a test network, so it names no OFT on any of the four. No independent OFT was searched for beyond that list and Stargate's metadata.

**Stargate V2.** Stargate's testnet metadata lists pools on Ethereum Sepolia, Arbitrum Sepolia and OP Sepolia, and **none on Base Sepolia**; the addresses agree with the `deployments/*-testnet/*.json` files at the pinned commit. Read on-chain:

| Pool | Address | Token held (`token()`) | Shared decimals | Sourcify |
|---|---|---|---|---|
| ETH, Ethereum Sepolia | `0x9Cc7e185162Aa5D1425ee924D97a87A0a34A0706` | native (`address(0)`) | 6 | `StargatePoolNative`, match |
| ETH, Arbitrum Sepolia | `0x6fddB6270F6c71f31B62AE0260cfa8E2e2d186E0` | native | 6 | match |
| ETH, OP Sepolia | `0xa31dCc5C71E25146b598bADA33E303627D7fC97e` | native | 6 | match |
| "USDC", Ethereum Sepolia | `0x4985b8fcEA3659FD801a5b857dA1D00e985863F0` | `0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590` ("USDC", 6 decimals) | 6 | `StargatePoolUSDC`, match |
| "USDC", Arbitrum Sepolia | `0x543BdA7c6cA4384FE90B1F5929bb851F52888983` | `0x3253a335E7bFfB4790Aa4C25C4250d206E9b9773` | 6 | not read |
| "USDC", OP Sepolia | `0x314B753272a3C79646b92A87dbFDEE643237033a` | `0x488327236B65C61A6c083e8d811a4E0D3d1D4268` | 6 | not read |

The three "USDC" tokens are **not Circle's USDC**: each is Sourcify-verified (solc 0.7.6; contract name `MockStableCoin` on Sepolia and `USDC` on the two rollups, all three built from `contracts/mocks/MockStableCoin.sol`), and that source says "remember this is a MOCK token - public mint is useful!" above `function mint(address _to, uint256 _qty) public`. An `eth_call` of `mint(0x…bEEF, 1000000)` from an arbitrary address succeeded on all three. Their total supplies are astronomically large (for example 1.0 × 10^54 base units on Sepolia), as expected of a token anyone can mint.

The Stargate TokenMessaging contracts (the OApps registered with the endpoint; the pools are not) are `0xfB112f7F…26d3` (Sepolia), `0x657C13E8…Eb9b` (Arbitrum Sepolia) and `0xea461D9B…7063` (OP Sepolia). For every pathway among the three, `getAppUlnConfig` returns zeros (nothing set by the OApp) and `getSendLibrary` / `getReceiveLibrary` report the default libraries: **Stargate's testnet transfers use the single LayerZero Labs DVN above.**

Who controls the testnet pools, read on-chain: `owner()` of all six pools and of the three TokenMessaging contracts is `0x5e6e4f234c7Ad525700fcF5B7862589950589ed5`, which has no code; the TokenMessaging delegates are `0x8563b504…5E6` on Sepolia (no code) and 7,197-byte contracts on Arbitrum Sepolia (`0x55A2D5A7…7A18`) and OP Sepolia (`0x93c6E990…5247`). The pools' `getAddressConfig()` names the **planner** as `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` on all three networks. That is the first account of Hardhat's documented default development mnemonic (derived locally with ethers from the mnemonic in Hardhat's network reference; the phrase is not reproduced here), whose private key is public. `setPause` is `onlyCaller(planner)` (`StargateBase.sol` lines 209–213), so anyone could pause Stargate's test pools. This was not attempted, and it concerns the test deployment only; Stargate's mainnet planner was not read.

Path credit (how much each pool may send to each destination, `paths(eid)`, in shared-decimal units) for the ETH pools: Sepolia→Arbitrum 0.171884 ETH, Sepolia→OP 0.271030, Arbitrum→Sepolia 20.303051, Arbitrum→OP 0.286006, OP→Sepolia 18.895462, OP→Arbitrum 0.177014; every pool's credit towards Base Sepolia (eid 40245) is 0 and `quoteSend` to it reverts.

### 15.6 The OFT interface, amounts and fees

`IOFT.sol` (lines 10–18) defines

```
struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD;
                   bytes extraOptions; bytes composeMsg; bytes oftCmd; }
```

and `send(SendParam, MessagingFee {nativeFee, lzTokenFee}, address refundAddress)`, `quoteSend(SendParam, bool payInLzToken)` and `quoteOFT(SendParam)` (lines 113–148). The rules that matter for a wallet, from the pinned sources:

- **Dust.** `OFTCore._debitView` floors the amount to a multiple of `10^(localDecimals − sharedDecimals)` and reverts with `SlippageExceeded` if the result is below `minAmountLD` (lines 349–363). With 18-decimal ETH and 6 shared decimals, an ETH amount moves in steps of 10^12 wei.
- **Fee payment.** A standard OFT requires `msg.value` to equal the native fee exactly (`OAppSender._payNative`, line 105). A Stargate native pool requires `msg.value` of at least the fee plus the amount, treats any excess as fee, and the endpoint refunds the unused fee to `refundAddress` (`StargatePoolNative.sol` lines 57–66; `OAppSender.sol` line 81).
- **Options.** If the OFT owner set enforced options for the pathway, an empty `extraOptions` uses them; with none set, the caller's options are passed through (`OAppOptionsType3.sol` lines 63–85). On Stargate's test pools `quoteSend` answered with empty `extraOptions`, so empty options work there.
- **Stargate's modes.** "`oftCmd: ""`" is taxi (immediate) and "`oftCmd: new bytes(1)`" is bus (batched) (`stargate/overview.md`; `StargateBase._isTaxiMode`, lines 644–646). The documentation says `approvalRequired()` returns "`false` for mint/burn or native assets", but `StargateBase` returns `true` unconditionally (lines 513–515) and the native pools answer `true`: a documentation-versus-code gap; for a native pool no approval is actually used.
- **Fees.** LayerZero's fee has four parts: source gas, "Security Stack Fees", "Executor Fees" and "Destination Gas Purchase" (`transaction-pricing.md`); `quoteSend` returns the last three as one `nativeFee`. Stargate pools may also take a protocol fee from the amount, reported by `quoteOFT` as a fee detail named "protocol fee".

Quotes read on 2026-10-15 for 0.0001 ETH to the dev EOA (taxi / bus native fee; amount received per `quoteOFT`):

| Route (ETH pools) | Native fee, taxi | Native fee, bus | Received for 0.0001 ETH |
|---|---|---|---|
| Sepolia → Arbitrum Sepolia | 0.000130249623732558 ETH | 0.000048162694911994 | 0.000099 (1 % protocol fee) |
| Sepolia → OP Sepolia | 0.000102050140082558 | 0.000035742021545494 | 0.0001 (no fee) |
| Arbitrum Sepolia → Sepolia | 0.000098985461402671 | 0.000020900268602753 | 0.000099 |
| Arbitrum Sepolia → OP Sepolia | 0.000099319475196967 | 0.000034786288835538 | 0.000099 |
| OP Sepolia → Sepolia | 0.000101716126288262 | 0.000021460581447106 | 0.000099 |
| OP Sepolia → Arbitrum Sepolia | 0.000130249623732558 | 0.000048162694911994 | 0.0001 |

For the mock-USDC pools the same fees applied per route, and 1 mock USDC arrived as 0.999399 on the fee-charging routes. On test networks the messaging fee is the same size as the amount; the protocol fee depends on path credit and changes over time.

**Later correction (section 15.16).** The "1 % protocol fee" in the table is not a percentage: at both 0.0001 and 0.0002 ETH the fee-charging routes kept exactly 10^12 wei (one shared-decimal unit), so it looked like a percentage only at 0.0001 ETH. Stargate's fee library was not read, so this is an observation. The adapter carries it as a live note on every quote from these pools (`STARGATE_TESTNET_NATIVE_LIVE_NOTES` in `packages/chains-evm/src/bridge/layerzero-oft.ts`), and the fee lines always show what the pool quoted at that moment.

### 15.7 What a CallPolicy can pin in an OFT send

Unlike `depositForBurn` (section 4.4), `send` takes a struct with three `bytes` fields, so the struct is dynamic: the head holds a pointer to it, and each `bytes` field is located through an offset the caller writes. A CallPolicy checks fixed words at fixed offsets and cannot follow pointers, so the call can be pinned **only if the wallet makes the layout unique** — which it can, by always writing `extraOptions` and `composeMsg` empty and `oftCmd` either empty (taxi) or exactly one zero byte (Stargate bus). Then every pointer and length has one possible value, and pinning those words forces the decoder to read the pinned fields. The byte offsets after the selector, verified against ethers' encoding in `packages/chains-evm/test/bridge.test.ts`:

| Offset | Word | Pin |
|---|---|---|
| 0 | pointer to `SendParam` | equal `0x80` (static; makes the struct start at 128) |
| 32 | `MessagingFee.nativeFee` | equal the quote; a standing rule can only cap it (it changes with every quote) |
| 64 | `MessagingFee.lzTokenFee` | equal 0 |
| 96 | `refundAddress` | equal the account |
| 128 | `dstEid` | equal (one of 40161, 40245, 40231, 40232) |
| 160 | `to` (bytes32) | equal the account, left-padded. The OFT converts it with `address(uint160(uint256(_b)))`, ignoring the high 12 bytes, so the whole word must be pinned, not just the low 20 bytes |
| 192 | `amountLD` | equal, or a cap |
| 224 | `minAmountLD` | equal the quoted arrival, or a floor (a static floor has the weakness of the DCA floor in `docs/SCHEDULED_PAYMENTS.md` section 4.1) |
| 256, 288, 320 | offsets of `extraOptions`, `composeMsg`, `oftCmd` inside the struct | equal `0xe0`, `0x100`, `0x120` |
| 352, 384, 416 | their lengths | equal 0, 0, and 0 (taxi) or 1 (bus) |
| 448 | bus command byte (bus only) | equal 0 |

The call's value (a CallPolicy `valueLimit`) is the native fee for an OFT, or the amount plus the fee for a Stargate native pool, so it too can only be capped by a standing rule. What cannot be pinned: a non-empty `extraOptions` whose content varies (for example a gas amount), any `composeMsg` (it runs code on the destination through `lzCompose`), and the security configuration itself, which is state on the endpoint and libraries, not calldata. With these pins, a session key cannot redirect the tokens, change the destination, add a compose call or pay the fee in another token; it can still spend up to the caps.

The ERC-20 pools (and any `OFTAdapter`) pull tokens with `transferFrom`, so an exact `approve(pool, amount)` precedes the send; a plain OFT burns from the sender and needs none (`OFT.sol` line 68, `OFTAdapter.sol` line 82).

### 15.8 Receiving on the destination, and smart accounts

An OFT mints to (`OFT._credit`, line 85) or transfers to (`OFTAdapter._credit`, line 102) the recipient address; neither needs code there, so a counterfactual (not yet deployed) Kernel account receives tokens like an EOA, and an ERC-20 transfer to a deployed Kernel account runs no account code. A `to` of zero is redirected to `0xdead` (`OFT.sol` line 83).

**Stargate's native-ETH pools are different.** `StargatePoolNative._outflow` sends ETH with a 2,300-gas stipend (`StargatePoolNative.sol` lines 37–39; `Transfer.sol` line 15, `transferGasLimit = 2300`). When that fails, `receiveTokenTaxi` does not revert: it stores the transfer and emits `UnreceivedTokenCached` (`StargateBase.sol` lines 345–375), and anyone can later call `retryReceiveToken`, which sends with unlimited gas (lines 295–313; it is `nonReentrantAndNotPaused` only). A read-only `eth_simulateV1` on OP Sepolia (block 50,114,598) called the pool's `receiveTokenTaxi` as its TokenMessaging contract for 100 shared units:

| Recipient | Code | Result |
|---|---|---|
| The dev Kernel v3.3 account `0xc995E49acA5C888F4FF1E50E8467E9fFc31CC5AC` (deployed there in phase 19) | 61 bytes | `UnreceivedTokenCached`: the ETH stays in the pool |
| The dev EOA `0x16DA…C5C` | none | `OFTReceived`: delivered |
| An unused address `0x…c0ffee01` | none | `OFTReceived` |

This is the same 2,300-gas pattern as the rETH burn (`docs/THREAT_MODEL.md` F-73). So: a deployed smart account can receive Stargate ETH only with a second, permissionless transaction on the destination; an EIP-7702-delegated EOA was not tested (F-73's trace suggests it depends on the delegate's receive path). Mock-USDC and other ERC-20 pools are not affected.

### 15.9 Keys and tracking

No key is needed for anything above: the endpoint and OFT calls are ordinary RPC, and the LayerZero Scan testnet API declares `security: []` in its OpenAPI document (`get-messagestx.md`) and answered `GET /v1/messages/latest?limit=2` with HTTP 200 and no credentials. Its message status values are `INFLIGHT`, `CONFIRMING`, `FAILED`, `DELIVERED`, `BLOCKED`, `PAYLOAD_STORED`, `APPLICATION_BURNED`, `APPLICATION_SKIPPED`, `UNRESOLVABLE_COMMAND` and `MALFORMED_COMMAND`. No rate-limit header was returned and none is documented on the page read. Tracking can also stay on-chain: the destination OFT emits `OFTReceived` (or Stargate's `UnreceivedTokenCached`) with the message GUID that `OFTSent` carried on the source. A delivered message does not by itself mean a Stargate ETH transfer reached a smart account (section 15.8). LayerZero also documents a "Value Transfer API" with quotes and status endpoints; it was not evaluated.

**What was built (phase 21, after the live run).** The adapter's `track()` now decides from the chains' own events when the app supplies a source-receipt reader and a destination-log reader: the GUID from the one `OFTSent` / `PacketSent` pair in the source receipt, then `OFTReceived` (delivered, matched on GUID, source endpoint id, recipient and amount) or Stargate's `UnreceivedTokenCached` (the funds wait in the pool, with the `retryReceiveToken` call built) on the receiving chain. Scan is supporting evidence only: its status is reported beside the result and never overrides an event (`docs/BRIDGE_PROVIDERS.md` section 4.2). The app's Bridge screen supplies both readers and Scan, and follows a transfer every 15 seconds while it is open (`docs/BRIDGE_PROVIDERS.md` section 6).

### 15.10 Audits and licences

The `LayerZero-Labs/Audits` repository (commit above) holds, for "Endpoint V2 - EVM / EndpointV2", reports by Blockian, C. Michel, Certora, OtterSec, Paladin (initial December 2023 and a diff of 11 June 2026), Windhustler and Zellic, plus Paladin reports on the message library and an OtterSec price-feed report; for OApp/OFT, Zellic (June 2024 and September 2025), ChainSecurity (January 2024) and Hexens (upgradeable variants, November 2024); and DVN reports. The Stargate V2 repository carries Zellic and OtterSec reports in `audits/`. Which commit each report covers, and whether it matches the deployed bytecode, was not checked. Licences: `EndpointV2.sol`, `MessageLibManager.sol` and the ULN libraries are `LZBL-1.2` (the repository's `LICENSE-LZBL-1.2`); the OApp and OFT contracts are `MIT`; Stargate V2 is `BUSL-1.1` (Business Source License). Whether a wallet that only calls these contracts is affected by either licence is a question for counsel, as with Circle's GPL paymaster (F-58).

### 15.11 Circle's USDC through LayerZero

No OFT on any of the four test networks carries Circle's USDC (section 15.5). The "Bridged USDC via LayerZero" that exists on some main networks is Stargate's `StargateOFTUSDC`, whose source says it is "designed for bridged USDC migration per https://github.com/circlefin/stablecoin-evm/blob/master/doc/bridged_USDC_standard.md" (`usdc/StargateOFTUSDC.sol` lines 8–9). Circle's document describes that standard as "a specification and process for deploying a bridged form of USDC on EVM blockchains with optionality for Circle to seamlessly upgrade to native issuance in the future". Until such an upgrade, that token is a bridged representation backed by Stargate's pools, not USDC issued by Circle; Circle's own path for native USDC is CCTP (section 4). No main-network deployment was read.

### 15.12 The source leg, simulated

Two read-only `eth_simulateV1` runs from the dev EOA (`0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C`), with the calldata built as in section 15.7:

1. **ETH, Ethereum Sepolia → OP Sepolia, taxi** (block 11,917,488): `quoteSend` returned 102,050,140,082,558 wei; `send` with `amountLD` 0.0001 ETH, `minAmountLD` 0.000099 ETH and `value` = amount + fee succeeded using 313,407 gas and emitted `PacketSent` from the endpoint and `OFTSent` from the pool (plus the Glamsterdam ETH transfer logs). The same call with one wei less value reverted with `Stargate_InvalidAmount()` (`0x3442dd95`).
2. **Mock USDC, Arbitrum Sepolia → Ethereum Sepolia** (block 319,281,525): the public `mint` of 1 mock USDC to the dev EOA, an exact `approve(pool, 1000000)` and `send` with the quoted fee all succeeded (276,810 gas for the send; `PacketSent` and `OFTSent`).

The destination legs cannot be simulated: they need the DVN's verification.

### 15.13 Go / no-go for a live testnet leg

**Go, on three of the four networks, with ETH.** Stargate V2's native-ETH pools are live on Ethereum Sepolia, Arbitrum Sepolia and OP Sepolia, have credit in every direction among them, accept empty options, and quote fees the dev EOA can pay: it held 0.043755 ETH on Ethereum Sepolia, 0.021884 on Arbitrum Sepolia and 0.094900 on OP Sepolia at the reads above. A live leg of 0.0001 ETH costs about 0.0001 ETH in LayerZero fees plus about 313,000 gas on the source (section 15.12) and nothing on the destination (the executor pays), and it exercises the real endpoint, the LayerZero Labs DVN and executor, and Stargate's production-shaped contracts. A second leg with the mock USDC is possible too (anyone can mint it), and it would exercise the exact-approval path, but the token has no value and must never be shown as USDC.

What a live leg would and would not prove: it proves the wallet's encoding, pins, quote and tracking against deployed contracts; it does **not** prove a Circle-USDC route (none exists on these networks), does not reach Base Sepolia (no Stargate pool and no OFT there), and says little about production security, because these test pathways run with one LayerZero Labs verifier and pools whose pause key is public.

**The wallet's own test OFT pair is not needed for the first leg.** It would become useful to show a non-default security configuration (for example two required DVNs) or an ERC-20 OFT on Base Sepolia. It needs an OFT contract compiled from LayerZero's MIT-licensed OFT library, one deployment per network, and `setPeer` (and, if wanted, `setConfig` and `setEnforcedOptions`) on each side; its gas cost was not measured, and the repository has no Solidity toolchain today, so it is a separate, larger slice.

Proposed live steps, mirroring section 11:

1. Dry run with `eth_simulateV1` (as in 15.12), then from the dev EOA: ETH, Ethereum Sepolia → OP Sepolia, taxi, 0.0001 ETH to the dev EOA, `minAmountLD` and `value` from fresh `quoteOFT` / `quoteSend` reads. Verify `OFTSent` (amount sent and received), `PacketSent`, the source balance delta (amount + fee + gas, minus any refund to `refundAddress`), then `OFTReceived` on OP Sepolia with the same GUID and the exact destination balance delta; record the time.
2. The reverse direction, OP Sepolia → Ethereum Sepolia, in bus mode, recording the bus wait.
3. Negative checks: `value` one wei short (expect `0x3442dd95`), `minAmountLD` one step above the quoted arrival (expect a slippage revert), and a pinned session rule refusing a different `to` (the `CallViolatesParamRule` path).
4. Optional: a send to a deployed Kernel account to see `UnreceivedTokenCached`, then `retryReceiveToken` from the dev EOA on the destination.

### 15.14 Readiness switchboard

A `bridging-layerzero` row, `testnet-only` and enforced like `bridging-cctp` (section 4.12). Its reason should say: who verifies (the verifiers the token's owner chose; on these test networks one verifier operated by LayerZero Labs), that the token's owner can change that at any time, that there is no automatic refund, and, for Stargate ETH, that a deployed smart account needs a second transaction to receive.

### 15.15 Could not verify

- Who holds the four signer keys of the 1-of-4 contracts that own the endpoints on Ethereum, Arbitrum and OP Sepolia, and whether those contracts are LayerZero's OneSig (inferred from the interface, not from verified source).
- Why the test-network default is a single LayerZero Labs DVN when the documentation's presets all have two required DVNs or a Dead DVN; whether main-network defaults differ (not read).
- Which commits the LayerZero and Stargate audit reports cover; whether the deployed EndpointV2 and libraries match the pinned source exactly (Sourcify reports "match", not "exact match", for most; OP Sepolia's libraries are not on Sourcify).
- The Sourcify status of the Arbitrum Sepolia and OP Sepolia "USDC" pools and of the three TokenMessaging contracts other than Sepolia's was not read.
- Real delivery times, executor behaviour, bus wait times, and the Scan API's rate limits on the test networks (nothing was sent). *Partly answered by section 15.16: one taxi delivery each was timed at 90 s (Sepolia → OP Sepolia) and 30 s (OP Sepolia → Arbitrum Sepolia), and the adapter now quotes these as measured once, not as a promise; the other four routes, bus waits and Scan's rate limits remain unmeasured.*
- How an EIP-7702-delegated EOA fares as a Stargate ETH recipient; whether Kernel accepts `lzCompose` (not needed: the wallet never sends a compose message). *Still open. The Bridge screen sends to the regular account only and warns when that address has code on the receiving network; the retry call for a cached transfer is built and checked offline but has not run live.*
- Stargate's main-network planner, owner and DVN configuration; Circle's Bridged USDC deployments on main networks.
- LayerZero's Value Transfer API (keys, terms) and the gas cost of deploying the wallet's own OFT pair.

### 15.16 Live run: the first two legs (2026-10-15)

On 2026-10-15 between 03:04 and 03:11 UTC, `scripts/testnet/bridge-smoke.mjs` sent the wallet's first live bridge transfers: native test ETH through Stargate V2's native pools, quoted and built by the engine's LayerZero OFT adapter (`packages/chains-evm/src/bridge/layerzero-oft.ts` at commit `110c5c8`). The sender and the recipient on every network were the dev EOA `0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C`. The public facts are in the git-ignored run record `scripts/testnet/runs/bridge-run.json`.

**Method.** The script registers the adapter (and the CCTP V2 adapter) in the engine's `BridgeRegistry`. It takes each quote from `provider.quote()`, which calls `quoteOFT` and then `quoteSend` through an injected `eth_call` reader. It sends `quote.calls[0]` unchanged: the target, value and data come from the adapter, and the script adds only the nonce, the gas limit (`eth_estimateGas` + 20%) and the EIP-1559 fees before signing with the engine's `signEip1559`. ethers 6.17.0 is used only to check the engine's work: it re-encodes the call, decodes events, and re-reads `quoteSend` with its own calldata. Hard caps: at most 0.0005 ETH bridged per leg, at most 0.002 ETH spent in total (amount + LayerZero fee + worst-case gas), and at least 0.005 ETH left on the source. Each leg was 0.0002 ETH, taxi mode.

**Dry run (read-only, every check passed).** Run immediately before the live legs:
- Stargate's live pathway configuration matched the adapter's recorded facts on all six routes: `EndpointV2.getSendLibrary`, then `SendUln302.getUlnConfig` and `getExecutorConfig` for Stargate's TokenMessaging contracts. Each route had one required DVN (LayerZero Labs) and the recorded executor, with 2 confirmations from Ethereum Sepolia, 5 from Arbitrum Sepolia and 1 from OP Sepolia.
- For all six routes, the adapter's call checked out three ways:
  - ethers' encoding was byte-identical (452 bytes).
  - All 14 pins read their own calldata word.
  - The value was exactly amount + native fee, and the independently built `quoteSend` gave the same fee to the wei.
- `eth_simulateV1` of the exact built call succeeded on each source chain. Simulated gas: Sepolia→Arbitrum 324,166; Sepolia→OP 313,407; Arbitrum→either 261,966; OP→Arbitrum 257,755; OP→Sepolia 261,314. In every simulation, `PacketSent` addressed the destination's TokenMessaging with the same GUID as `OFTSent`.
- Refusals:
  - An amount one wei below the pool's `quoteOFT` minimum (10^12 wei) and an amount with one wei of dust were both refused by the engine ("moves in steps of 1000000000000 base units").
  - A minimum-to-receive one wei above the quote was refused by the engine.
  - Non-empty `extraOptions` was refused by `encodeOftSend`.
  - A route to Base Sepolia was refused by the engine ("No configured OFT serves this route"), and an on-chain `quoteSend` to eid 40245 reverts.
  - In simulation, `value` one wei short reverted with `0x3442dd95` (`Stargate_InvalidAmount`), and `minAmountLD` raised by one shared-decimal step reverted with `0xa1e86545` (`Stargate_SlippageTooHigh()`, `StargateBase.sol` line 82 at `9f4f5c0f`).
- **Correction to the table in 15.6.** The "protocol fee" on the fee-charging routes is not 1 %: at 0.0002 ETH it was again exactly 10^12 wei (0.000199 arrives), the same absolute amount seen at 0.0001 ETH. Two amounts suggest a flat one-shared-unit fee at these sizes, but Stargate's fee library was not read.

**Leg A — Ethereum Sepolia → OP Sepolia** (no pool fee on this route):

| | |
|---|---|
| Quote | native fee 102,050,140,082,558 wei; value 302,050,140,082,558 = 0.0002 ETH + fee; expected and minimum arrival 0.0002 ETH |
| Source tx | `0xfb041691c102214d1da67f60b23b985a2e99a335fccf23423b8c722937986405`, block 11,917,629 (03:05:12 UTC), nonce 42, status 0x1 on `ethereum-sepolia-rpc.publicnode.com`, `eth-sepolia-testnet.api.pocket.network` and `sepolia.drpc.org` (same block hash), input equal to the engine's calldata on all three |
| Gas | estimate 341,035 (limit 409,242); used 313,407 (= the simulation); effective price 1,000,013 wei |
| Logs | `OFTSent` GUID `0x4da5481014f25b3326f100cb8d0cdb20979a9e1d9d6708b96347ef993580395c`, sent and to-receive both 2 × 10^14; `PacketSent` nonce 196, 40161 → 40232, TokenMessaging `0xfB11…26d3` → `0xea46…7063`; `ExecutorFeePaid` 97,108,235,109,199 to `0x718B…1eDA`; `DVNFeePaid` 4,941,904,973,359 to `0x8eeb…9193`; nothing left for a treasury share; four EIP-7708 transfer logs (the ETH path dev EOA → pool → TokenMessaging → endpoint → send library) |
| Source delta | −302,363,551,156,849 wei on all three endpoints = value + gas, exact: no refund |
| Tracking | Scan via the adapter's `track()`: not indexed at +8 s, `INFLIGHT` ("Ready for DVNs to verify") at +62 s, `DELIVERED` at +125 s (10-second polling); the DVN's verification on OP Sepolia was in block 50,115,514 (03:06:08 UTC) |
| Delivery | tx `0xf0760a9ec2ba0e8f1b3a53e46e6e118cd749b66fb2040e6d7d7a04da041827f3`, OP Sepolia block 50,115,531 (03:06:42 UTC), from the executor EOA `0xf5e8…007a`, gas 90,155; `OFTReceived` with the same GUID, srcEid 40161, 2 × 10^14 wei to the dev EOA; Scan's destination tx equals it |
| Destination delta | +200,000,000,000,000 wei on all three OP Sepolia endpoints, exact |
| Time | 90 s from source block to destination block; at the re-verification about five minutes later, the source block was still above Sepolia's safe head (11,917,606) |

**Leg B — OP Sepolia → Arbitrum Sepolia** (no pool fee on this route):

| | |
|---|---|
| Quote | native fee 130,249,623,732,558 wei; value 330,249,623,732,558 |
| Source tx | `0xfa79787a5ff824e6cc5e1aa61e06a97feb5987627f29010cee67dd57ad9fdf02`, block 50,115,550 (03:07:20 UTC), nonce 3, status 0x1, input equal to the engine's calldata |
| Gas | estimate 266,841 (limit 320,209); used 257,755 (= the simulation); effective price 1,000,250 wei; L1 data fee 404 wei (estimated 563 over the signed bytes); operator fee 0 |
| Logs | `OFTSent` GUID `0xe3d00cd678da00796ae04e89cd75c3e7a3cb62bd025e5bda502737af2150801c`; `PacketSent` nonce 588, 40232 → 40231; `ExecutorFeePaid` 117,010,613,659,199; `DVNFeePaid` 13,239,010,073,359 to `0xd680…582C` |
| Source delta | −330,507,443,171,712 wei on three endpoints = value + gas + L1 data fee, exact |
| Tracking | not indexed at +7 s, `INFLIGHT` at +17 s, `CONFIRMING` ("Executor waiting for finality") at +61 s, `DELIVERED` at +72 s; DVN verification on Arbitrum Sepolia block 319,288,608 |
| Delivery | tx `0x27fa3f2e339e7e737daab8314fbb7787e640eec6d6b894dd134a27a287b632d8`, Arbitrum Sepolia block 319,288,653 (03:07:50 UTC), same executor EOA, gas 90,145, `OFTReceived` 2 × 10^14 wei to the dev EOA |
| Destination delta | +200,000,000,000,000 wei on `sepolia-rollup.arbitrum.io` and `arb-sepolia-testnet.api.pocket.network`, exact (`arbitrum-sepolia-rpc.publicnode.com` refused the historical balance read: "historical state … is not available") |
| Time | 30 s from source block to destination block |

**Totals.**
- 0.000632870994328561 ETH left the dev EOA's sources: 0.0004 ETH bridged, 0.000232299763815116 in LayerZero fees and 0.000000571230513445 in gas and L1 data fee.
- 0.0004 arrived. The net cost of the two legs was **0.000232870994328561 test ETH**.
- Stargate's native pools charged no fee on either route.
- Balances afterwards: Sepolia 0.043452807449020349, OP Sepolia 0.094769429541077557, Arbitrum Sepolia 0.022084475390030001.

**Observed during the run.**
1. The first receipt read for leg B disagreed between endpoints. `sepolia.optimism.io` reported block 50,115,550 with hash `0x1f572c37…a8653`, a block that, minutes later, no endpoint knew by hash. All three OP Sepolia endpoints then reported `0xfab31ffe…1bda4` with an identical receipt. The OP Sepolia sequencer's unsafe head was evidently replaced, with the transaction re-included at the same height and index. The script stopped on this check, as designed. It now re-reads on disagreement, and the read-only re-verification (`BRIDGE_VERIFY=1`) passed on three endpoints per chain.
2. The packets carried the options `0x0003 01 0011 01 …0249f0`: type 3, executor `lzReceive` gas 150,000, no value (`OptionsBuilder.sol` line 22 and `ExecutorOptions.sol` lines 10–12 and 85–86 at `9c741e7f`). The wallet's own `extraOptions` was empty, so this is Stargate's own option.
3. The DVN fee went to the source chain's LayerZero Labs DVN contract. The verification on the destination was done by that chain's LayerZero Labs DVN, matching 15.4.
4. Both legs were delivered well before the source block was safe: 2 confirmations on Sepolia, 1 on OP Sepolia, exactly as configured. On these test pathways, a source reorganisation after delivery is covered by nothing but the single verifier.
5. `sepolia.optimism.io` answered `safe` and `finalized` with blocks from 2026-09-30, while PublicNode answered current ones. This was read once and not investigated.

**What the run proves, and what it does not.** It proves several things against the deployed contracts:
- the engine's encoding and pins for a Stargate native-pool send;
- its quote (fee to the wei, arrival to the wei);
- its route table, including the absence of Base Sepolia;
- the mapping of Scan statuses to transfer states;
- that an EOA recipient receives the exact amount with no destination action.

It does not prove a smart-account sender or recipient (`UnreceivedTokenCached`, 15.8), bus mode, an ERC-20 OFT, or anything about main-network security. Steps 2–4 of 15.13 (the reverse direction in bus mode, a pinned session-rule refusal, the Kernel recipient and `retryReceiveToken`) remain to be run.

**Follow-ups from this run, since built.** The adapter follow-ups (engine, offline, 40 tests): tracking by GUID from the chains' own events with the retry call (section 15.9 above), the measured times in quotes, the singular / plural confirmation count, the fee lines in the network profile's coin name (`nativeSymbol`), an optional gas estimate in the quote, and Stargate's own executor option and the observed pool fee as quote notes. The in-app slice (offline, not yet on a device): the Bridge screen with the provider choice, the wallet's own quote checks, the regular-account and smart-account send paths, and the tracking panel (`docs/BRIDGE_PROVIDERS.md` section 6). The decoders were tested on ethers-encoded logs built from this run's values, not on the raw receipts.

## 16. Updated recommendation (2026-10-15): two providers, the user chooses

The Chairperson's decision of 2026-10-14 ("LayerZero instead of CCTP, or better, optionality: let the user choose the provider") replaces the single-provider recommendation of section 10. With both providers researched to the same depth:

1. **Build the provider interface and registry first** (done in the engine for phase 21, `packages/chains-evm/src/bridge/`, design in `docs/BRIDGE_PROVIDERS.md`), so a provider is a registered adapter and adding or removing one changes no screen.
2. **Register two adapters.** CCTP V2 for USDC on all twelve routes among the four networks (the only provider that moves Circle's USDC here; Circle verifies), and LayerZero OFT for ETH through Stargate V2 on the six routes among Ethereum Sepolia, Arbitrum Sepolia and OP Sepolia (LayerZero's verifiers; on these networks one LayerZero Labs verifier). Where both serve a pair of networks they move different assets, so the Bridge screen offers a choice of asset and, for each, the providers that carry it, each with its own trust statement.
3. **Prove both live by script before any screen**, LayerZero first on the Chairperson's preference (section 15.13: Ethereum Sepolia → OP Sepolia, 0.0001 ETH, no attestation wait), then CCTP (section 11: Base Sepolia → Arbitrum Sepolia, 1 USDC).
4. **Keep the earlier limits.** Exact approvals only; Standard Transfers only for CCTP; empty options and no compose messages for LayerZero; recipients pinned to the sending account; test networks only behind enforced readiness rows; and, on the screen, the plain statement of who verifies each transfer, read from the chain for the route being quoted, not assumed.
5. **Across stays a candidate third adapter for ETH** (section 5), now that adding one is an adapter rather than a redesign; the aggregators and Wormhole stay out for the reasons in sections 7 and 8.

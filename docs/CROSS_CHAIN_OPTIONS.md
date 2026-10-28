# Cross-chain options for Shiba Wallet: a comparison

**Status:** Written on 2026-10-25 for phase 23 item 4 (`AGENTS.md`, "Phase 23 plan", the deliverable the Chairperson added on 2026-10-25), against repository HEAD `f4b9339`. Documentation only: no transaction was sent and no code was changed for this document. Every fact below comes from one of four places, and each is tagged where it lands (section 4 explains the tags): a live leg recorded in `AGENTS.md` (the commit or emulator pass and the transaction hash are quoted), a read-only on-chain or API fact already in the record (`docs/BRIDGING.md`, `docs/BRIDGE_PROVIDERS.md`, `docs/THREAT_MODEL.md`, `docs/AUDIT_SCOPE.md`), a document cited in the record with its fetch date, or the pinned source code in `packages/chains-evm/src/bridge/`. One new fact was fetched for this document: the licence headers of the Circle CCTP, Across and OP Standard Bridge sources at the commits the record pins (section 8, fetched 2026-10-25 15:01 UTC). Where the record has no fact, this document says "not measured" or "not read" and does not fill the gap from general knowledge.

This file is plain technical prose for the Chairperson and the board. The persona and compression rules do not apply to it.

## 1. Summary

**The question.** Which ways of moving value between networks should Shiba Wallet offer, and in what order? The Chairperson asked for LayerZero to be judged as a full alternative to Circle's Cross-Chain Transfer Protocol (CCTP), not only as the first adapter the wallet happened to build.

**What the wallet has actually done.** Two providers have moved real test funds with calls built by the wallet's own engine:

- **LayerZero V2 through Stargate V2's native-ETH pools** moved test ETH three times: two legs by script on 2026-10-15 (commit `fec6c32`; Ethereum Sepolia to OP Sepolia in 90 seconds, OP Sepolia to Arbitrum Sepolia in 30 seconds) and once through the app's own Bridge screen on the same day (emulator pass p21b; Ethereum Sepolia to OP Sepolia in 86 seconds). Each arrival was exact to the wei. The messaging fee was about 0.0001 to 0.00013 test ETH per leg. Every route was verified by **one** verifier operated by LayerZero Labs.
- **Circle CCTP V2, Standard Transfer** moved test USDC twice by script on 2026-10-25 (commit `5466f91`; Base Sepolia to Arbitrum Sepolia in 996 seconds, Ethereum Sepolia to Base Sepolia in 1,058 seconds). Circle charged no fee; each mint was exact to the base unit; a replayed mint and a tampered message were refused. Every mint needed two Circle signatures and a second transaction on the receiving network. CCTP has not been sent through the app; the Bridge screen lists it as "coming".

**The finding that decides the recommendation.** On every route this wallet can use today, LayerZero and CCTP do not compete: they carry different assets. CCTP moves only Circle's USDC and cannot move ETH (`docs/BRIDGING.md` section 4.6). No LayerZero token on the four test networks carries Circle's USDC: Stargate's test "USDC" pools hold a mock token anyone can mint (section 15.5), and on main networks LayerZero's "Bridged USDC" is a representation backed by Stargate's pools, not USDC issued by Circle (section 15.11; not read on-chain). Judged as a full alternative (the CTO's reading of the record), LayerZero is the choice for the native coin where it has pools and is **not** an alternative for native USDC; CCTP is the only provider studied that moves native USDC (section 6.3).

**Recommendation (section 6).**

1. **On the test networks now: two providers, chosen by asset, the user choosing.** Keep LayerZero (Stargate) for test ETH among Ethereum Sepolia, Arbitrum Sepolia and OP Sepolia. Make CCTP V2 Standard Transfers sendable for Circle's USDC on all four networks, with the wallet submitting the destination mint itself when the receiving account has gas there and saying plainly what is waiting when it does not. The screen asks for the asset first and then lists every provider with its trust statement; it never preselects one.
2. **Next candidate: Across**, for test ETH on Base Sepolia (where LayerZero has no pool) and as a second ETH option elsewhere, only after a live leg proves the deposit pins and an exact approval. Research only today.
3. **Optional: the native rollup bridges** as a slow, trust-minimised deposit of test ETH from Ethereum Sepolia to one rollup, regular account only. Not a general option: no USDC, no rollup-to-rollup, withdrawals from OP Sepolia take at least 7 days.
4. **Not offered:** the aggregators (their calldata cannot be pinned), Stargate's token pools and Wormhole.
5. **Main networks: nothing yet.** No bridge address is pinned or verified for any main network. Section 6.2 lists the conditions, of which the single-verifier question for LayerZero and whether Circle's main-network attestation service needs a key are the ones only the Chairperson and a read on the main networks can settle.

## 2. What "cross-chain" means for this wallet

### 2.1 Its chains

The wallet runs on Ethereum mainnet (most features held to test networks by the readiness switchboard) and on five built-in Ethereum test networks: Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia and Hoodi (`AGENTS.md`, phases 14, 18 and 19). It also holds Bitcoin, Dogecoin and Solana keys from the same recovery phrase. Every provider in this document was evaluated only between Ethereum-compatible networks; none was evaluated for Bitcoin, Dogecoin or Solana. Hoodi is served by none: Stargate has no pool there and the CCTP adapter refuses it (`docs/BRIDGING.md` section 17, "Engine refusals"). The CCTP adapter also refuses Circle's Solana and Avalanche domains (5 and 1) as "not one this wallet has verified".

### 2.2 Its assets

Two assets matter for bridging today:

- **The native coin** (test ETH on the four Sepolia networks).
- **Circle's USDC** on the four Sepolia networks (Ethereum Sepolia `0x1c7D…7238`, Base Sepolia `0x036C…CF7e`, Arbitrum Sepolia `0x75fa…AA4d`, OP Sepolia `0x5fd8…30D7`). The dev account holds test USDC on all four (`AGENTS.md`, "INPUTS RECEIVED (2026-10-11)" and the CCTP entry of phase 23).

EURC (on Ethereum and Base Sepolia) and the staking tokens were not evaluated for bridging; Circle moves EURC through a different contract that the record did not evaluate (`docs/BRIDGING.md` section 4.6).

### 2.3 Its account types

| Account | Can it bridge in the app today? | What the record says |
|---|---|---|
| Regular account (from the recovery phrase, or an imported key) | Yes, through LayerZero; the one in-app bridge was sent from it (pass p21b) | Imported accounts see the imported-key notice on the Bridge screen (`BridgeScreen.tsx`) |
| Smart account (Kernel v3.3, the same address on every network) | The send path exists (`prepareAaCalls` / `sendAa`, one operation) but the recipient is always the regular account, and no smart-account bridge has been sent live | `docs/BRIDGE_PROVIDERS.md` section 6; `THREAT_MODEL.md` T-84 |
| Multi-signature account | No: the Bridge route is refused for a multisig (`MULTISIG_ALLOWED_ROUTES` in `app/src/wallet/watch-only.ts` does not list it) | — |
| Watch-only account | No: the Bridge route is refused (`WATCH_ONLY_ALLOWED_ROUTES`); its one signing path, cold signing, covers plain sends only | `AGENTS.md` phase 22 item 3 |

### 2.4 What the user actually wants

Four jobs, which the rest of the document uses as its yardstick:

1. **Move the native coin** from one network to another.
2. **Move USDC** from one network to another, ending with the same issuer's USDC that the wallet tracks.
3. **Pay from a smart account**, including, where it exists, paying the network fee in USDC through Circle's paymaster (Base Sepolia and Arbitrum Sepolia only; `docs/BRIDGING.md` section 4.10).
4. **Receive into a smart account**, which has the same address on every network.

### 2.5 The rules that decide fit

From `docs/BRIDGING.md` section 3: non-custodial (only the user's own account signs anything that moves its funds; no signature is handed to a provider's API); pinnable calls (a Kernel CallPolicy can hold fixed words of calldata at fixed offsets, so a session key or a spending rule can be bound to a bridge call only if every argument that matters is fixed-size or forced to one layout); exact approvals only; keyless access where possible; a plain trust statement for every provider; and test networks only until the main-network conditions are met.

## 3. The options

Each subsection uses the same headings: what moves; who verifies, and who can halt or redirect funds; what the wallet can pin; access and keys; fees and time as measured; smart-account sender and recipient; main-network status; licences and audits; what the wallet has built and proven.

### 3.1 LayerZero V2 with Stargate V2 (OFT)

**What moves.** On the test networks: native test ETH through Stargate V2's native pools on Ethereum Sepolia (`0x9Cc7…0706`), Arbitrum Sepolia (`0x6fdd…86E0`) and OP Sepolia (`0xa31d…c97e`), six directed routes. **None on Base Sepolia**: Stargate has no pool there and every pool's credit towards it is zero (`docs/BRIDGING.md` section 15.5). Stargate's three test "USDC" pools hold a mock token built from `MockStableCoin.sol`, whose source says "public mint is useful!", so they cannot carry Circle's USDC. LayerZero's own list of token deployments names no token on any test network (section 15.5). The pools' send credit is small: for example 0.171884 ETH from Ethereum Sepolia to Arbitrum Sepolia and 0.271030 ETH to OP Sepolia when read on 2026-10-15 (read-only).

**Who verifies.** A message is delivered only after the verifiers ("DVNs") that the token's owner configured confirm it; with no configuration, LayerZero's defaults apply (`docs/BRIDGING.md` section 15.2). On every route among the four test networks, and for Stargate's pools in particular, the default is **one required verifier, operated by LayerZero Labs**, with one executor, also LayerZero Labs, and 2 source-block confirmations from Ethereum Sepolia, 5 from Arbitrum Sepolia and 1 from OP Sepolia (read-only on 2026-10-15 and re-read by the live script's dry run, sections 15.4 and 15.16). LayerZero's documentation lists four default presets, each with two required verifiers or a "Dead DVN"; the single-verifier default read on these test networks is not among them, and the documentation does not say why (section 15.4). In both live script legs the transfer was delivered before the source block was "safe"; on these routes a source reorganisation after delivery is covered by nothing but that one verifier (section 15.16, observation 4).

**Who can halt or redirect.** The token's owner can change the verifiers, the executor and the peer contracts at any time, and its delegate can skip or destroy a message in flight (`LAYERZERO_OFT_TRUST` in `layerzero-oft.ts`, from LayerZero's ownership page). The endpoint contract cannot be upgraded, but its owner sets the defaults every unconfigured token uses; on Ethereum, Arbitrum and OP Sepolia the endpoint owner is a 1-of-4 contract (inferred to be LayerZero's "OneSig" from its interface, not from verified source) and on Base Sepolia a 1-of-2 Safe (read-only, section 15.3). The Stargate test pools' owner has no contract code, and the pools' **planner**, which can pause them, is the first account of Hardhat's published development mnemonic, whose private key is public (read-only, section 15.5). On 2026-10-25 the audit-pack script found that this planner address now carries an EIP-7702 delegation on Sepolia (`AGENTS.md`, phase 23 item 1). Nobody has tried to pause the pools. There is no automatic refund: a message the verifiers never confirm leaves the funds locked or burned until the token's owner acts (`LAYERZERO_OFT_TRUST`). The message is verified on-chain at the destination, so a dishonest API or whoever delivers it can delay or withhold a transfer but not redirect it (`docs/BRIDGE_PROVIDERS.md` section 5).

**What the wallet can pin.** The OFT `send` call takes a structure with three variable-length fields, so in general it cannot be pinned. The wallet makes it pinnable by always writing two of those fields empty and the third empty (or one zero byte for Stargate's bus mode); then 14 words of calldata (15 in bus mode) have exactly one possible value each: the structure pointer, the native fee, a zero LayerZero-token fee, the refund address, the destination endpoint id, the recipient (the whole 32-byte word), the amount, the minimum to receive, and the three field offsets and lengths (`docs/BRIDGING.md` section 15.7). The messaging fee and the call's value change with every quote, so a standing rule can only cap them, never fix them. All 14 pins were re-checked against the live calldata on six routes (section 15.16, read-only dry run). No session key with a bridge CallPolicy has been built (`THREAT_MODEL.md` T-83), so a pin refusing a bridge call on-chain has **not** been seen.

**Access and keys.** Sending needs no off-chain service: the quote is two `eth_call`s (`quoteOFT`, `quoteSend`) and the send is one transaction. LayerZero Scan's test-network API, used only as supporting evidence for tracking, is keyless (`security: []` in its OpenAPI document; answered without credentials on 2026-10-15). Scan's rate limits were not measured; Scan's main-network terms were not read. LayerZero's "Value Transfer API" was not evaluated.

**Fees and time as measured.**

| Leg (all 0.0002 test ETH, taxi mode, dev account to itself) | Messaging fee (paid on top) | Pool fee | Source gas | Source block to delivery block | Evidence |
|---|---|---|---|---|---|
| Ethereum Sepolia → OP Sepolia, script, 2026-10-15 | 102,050,140,082,558 wei (executor 97,108,235,109,199 + verifier 4,941,904,973,359) | none on this route | 313,407 | 90 s | `fec6c32`; tx `0xfb041691c102214d1da67f60b23b985a2e99a335fccf23423b8c722937986405`, delivery `0xf0760a9ec2ba0e8f1b3a53e46e6e118cd749b66fb2040e6d7d7a04da041827f3` |
| OP Sepolia → Arbitrum Sepolia, script, 2026-10-15 | 130,249,623,732,558 wei | none on this route | 257,755 (+ a 404-wei layer 1 data fee) | 30 s | `fec6c32`; tx `0xfa79787a5ff824e6cc5e1aa61e06a97feb5987627f29010cee67dd57ad9fdf02`, delivery `0x27fa3f2e339e7e737daab8314fbb7787e640eec6d6b894dd134a27a287b632d8` |
| Ethereum Sepolia → OP Sepolia, **through the app**, 2026-10-15 | 102,050,140,082,558 wei | none | 313,407 | 86 s | pass p21b; tx `0x1e9f4593c04918a963dae8ab82370785eb4150d753d97a05d421af935d37cee7`, delivery `0xd1df943d45b2e5bf82b8c9171bb2fd57cfefdfbf46779ad55d36beaccb0e08e9` |

The executor paid the delivery gas (about 90,000 gas per delivery); the user paid nothing on the receiving network. The two script legs together cost 0.000232870994328561 test ETH net (section 15.16, "Totals"). On the other four routes the pools quoted a fee of exactly 10^12 wei taken from the amount at both 0.0001 and 0.0002 ETH; Stargate's fee library was not read, so that is an observation, not a rule (section 15.6 and its correction in 15.16). Delivery time on the other four routes, bus-mode waits and any second sample of the two timed routes beyond the in-app leg were **not measured**. How the messaging fee varies with amount, or on main networks, was not measured.

**Smart-account sender and recipient.** Sender: the app can send a bridge from the smart account as one operation, paying the fee in the usual smart-account ways, but no smart-account bridge has been sent live (`THREAT_MODEL.md` T-84). Recipient: Stargate's native pools hand ETH over with a 2,300-gas transfer. A read-only simulation on OP Sepolia showed that a deployed Kernel account cannot accept it: the pool keeps the ETH and emits `UnreceivedTokenCached`, and anyone can later call `retryReceiveToken` with unlimited gas to deliver it (section 15.8). An EOA and an unused address received normally. The app therefore always sends to the user's **regular** address, also from the smart account, and says why before Review. The retry call is built and checked offline; it has **not** run live. An ERC-20 LayerZero token (not Stargate's native pool) mints or transfers to any address and would not have this problem (from source, section 15.8; not tested). An EIP-7702-upgraded address as recipient was not tested.

**Main-network status.** Nothing is pinned or read. The main-network default verifier configuration, Stargate's main-network owner and planner, and any main-network pool were not read (`docs/MAINNET_READINESS.md` section 2; `docs/BRIDGING.md` section 15.15).

**Licences and audits.** LayerZero's endpoint and message libraries are licensed `LZBL-1.2`; the OApp and OFT contracts `MIT`; Stargate V2 `BUSL-1.1` (section 15.10, from the pinned sources); whether a wallet that only calls them is affected is a question for counsel. Audit reports are listed in LayerZero's and Stargate's audit repositories; which commit each covers was not checked. The audit-pack script found the LayerZero executors, verifiers and message libraries on several test networks "present but unverified" on Sourcify (`docs/AUDIT_SCOPE.md` section 5.7).

**Built and proven.** Engine adapter `layerzero-oft.ts` with a verified route table, quotes, 14-word pins, refusals, tracking from the chains' own events by message id with Scan only as supporting evidence, the retry call, measured times and live notes (commits `72a56a8`, `bbc21d7`; 40 engine tests). App Bridge screen (`fe34deb`), stored transfer records (`2a1d2dc`), the user's choice with no preselected provider (`8da86a6`), receipt resolution for a smart-account bridge (`71c5d50`, offline only). **Proven live:** two legs by script and one through the app, tracked to "Delivered" from `OFTReceived` while Scan still said in flight (pass p21b; `THREAT_MODEL.md` T-86). Activity now reads "Bridged 0.0002 test ETH to OP Sepolia through LayerZero …" for that transfer (pass p21e).

### 3.2 Circle CCTP V2

**What moves.** Circle's USDC only, by burning it on the sending network and minting it on the receiving one. All twelve directed routes among the four Sepolia networks are deployed, registered and unpaused at the same addresses (TokenMessengerV2 `0x8FE6…2DAA`, MessageTransmitterV2 `0xE737…E275`, TokenMinterV2 `0xb43d…F192`; read-only on 2026-10-12 and again on 2026-10-25, `docs/BRIDGING.md` sections 4.5 and 17). At most 10 million USDC per message (`burnLimitsPerMessage`, read-only). ETH cannot move through CCTP.

**Who verifies.** Two Circle attesters must sign every message before it can be minted: `signatureThreshold()` 2 with 2 enabled attesters on all four test networks and on Ethereum mainnet (read-only, section 4.1). In both live legs the attestation carried two signatures recovering to `0x49fD…8b28` and `0x8867…5287`, both enabled on the receiving network (live, section 17). A Standard Transfer is attested after the source chain's hard finality; from Ethereum Sepolia the attestation appeared at most about 21 seconds after the finalized head passed the burn block (one sample, section 17). Circle also issues USDC itself, so this is close to the trust a USDC holder already extends, plus Circle's liveness: without an attestation, burned USDC cannot be minted.

**Who can halt or redirect.** Circle can pause sending and receiving, refuse listed addresses, and replace the contracts (`CCTP_V2_TRUST` in `cctp-v2.ts`). On the test networks and on Ethereum mainnet every one of these roles (both proxy admins, the owner, the denylister, the pausers, the attester manager) is held by an address with no contract code; how Circle secures those keys could not be verified (read-only, section 4.2). The denylist checks the sending account **and the transaction originator**; for a smart-account operation the originator is the bundler, so a denylisted bundler would make every burn it carries revert (reasoned from source, not tested). Funds cannot be redirected in flight: the recipient and amount are inside the attested message, and a message with one changed byte was refused "Invalid signature: not attester" (simulated before the live mint, section 17). There is no refund: the burn is final, and the mint can be completed by anyone, at any time. A Standard Transfer's attestation carried expiration block 0, so it does not lapse (live, section 17, observation 2).

**What the wallet can pin.** Everything. `depositForBurn` takes seven fixed-size arguments (amount, destination domain, recipient, token, destination caller, maximum fee, finality), and the exact approval before it two more; all nine words were checked against the live calldata and against an independent encoding (live, section 17). It is the only provider in this document whose user-facing call can be pinned completely without the wallet having to force a layout. As for LayerZero, no CallPolicy refusing a burn to another recipient has been run.

**Access and keys.** No key was needed for anything: Circle's sandbox attestation service (`iris-api-sandbox.circle.com`) declares `security: []` for `GET /v2/messages/…` and answered every request without credentials, and the sandbox fee endpoint did too (read-only, sections 4.3 and 17). Circle's documentation carries a generic "API key required" banner on every page; whether the **main-network** host `iris-api.circle.com` needs a key was **not verified**. The documented limit is 40 requests per second, after which requests are blocked for five minutes (documented, fetched 2026-10-11). Circle's API can withhold an attestation but cannot redirect funds, because the attestation is checked on-chain.

**Fees and time as measured.**

| Leg (1 USDC, Standard Transfer, dev account to itself) | Circle fee | Gas, sending network | Gas, receiving network (the mint) | Burn block to mint block | Evidence |
|---|---|---|---|---|---|
| Base Sepolia → Arbitrum Sepolia, 2026-10-25 | 0 (fee executed 0, `feeCollected` 0) | approve 55,437 + burn 109,091 | 154,152 | 996 s (attestation 986–996 s) | `5466f91`; burn `0x847e641f6f038bf78f22881ff2186e0b453f18f24eb543556e8fda1db84e67a7`, mint `0x425891cf15b9bb3df0bb52f1972bcc0b8cfc767db0a104ece758c20db9d96ddb` |
| Ethereum Sepolia → Base Sepolia, 2026-10-25 | 0 | approve 137,757 + burn 120,675 | 154,099 | 1,058 s (attestation 1,047–1,057 s) | `5466f91`; burn `0xd412d22a2a9e09e958b52b855e73cba5011ad373829c316ca6f8af4e97a8556f`, mint `0xfc463033a481aaac66d06e76328aca5bbe4ab511846b78aee0cf1cf6c68c63c7` |

All the test ETH spent on both legs, on three networks, was 0.000005039124558446 ETH in network fees (section 17, "Totals"). The times sit inside Circle's documented "~15-19 minutes" for main networks. One sample per route; routes from or to OP Sepolia, any second sample, and attestation-time variation were **not measured**. **Fast Transfer** (documented at about 8–20 seconds on main networks, a sandbox fee of 1 to 1.3 basis points) and Circle's **Forwarding Service** (documented as destination gas plus a "$0.05" service fee, submitting the mint for the user) were **not measured**; the adapter refuses Fast Transfers by construction (it always signs a zero maximum fee and finality 2000), though the lower-level encoder alone would accept finality 1000 (section 17, dry run).

**Smart-account sender and recipient.** Sender: a Kernel account could batch the exact approval and the burn in one operation and, on Base Sepolia or Arbitrum Sepolia, pay the network fee in USDC through Circle's paymaster (reasoned from the phase 13 record, **not run**; section 4.10). Recipient: the mint is an ordinary ERC-20 mint, with no gas-limited transfer, so a smart-account address should receive it like any other (reasoned from source, **not run**). But someone must submit the mint on the receiving network with gas there, and Circle's paymaster cannot pay for the **first** mint to an account that holds no USDC on that network yet, because the paymaster takes its fee during validation, before the mint runs (section 4.10, from the phase 13 record). Ethereum Sepolia and OP Sepolia have no usable Circle paymaster at all. The smart-account leg (section 11 step 4) has not run.

**Main-network status.** No address is pinned. On Ethereum mainnet only, TokenMessengerV2 `0x28b5…cf5d` was read: the same proxy code, Sourcify-exact implementations, a 2-of-2 attester threshold, EOA-held roles, nothing paused (read-only, sections 4.2 and 4.5). Base, Arbitrum and OP main networks were not read.

**Licences and audits.** `Apache-2.0` (`TokenMessengerV2.sol` and `MessageTransmitterV2.sol` headers and the repository's `LICENSE` at commit `63ab1f0a`, fetched 2026-10-25 for this document). Circle links three audit reports (ChainSecurity on CCTP V2, OtterSec, ChainSecurity "with Standard Transfer fee switch", July 2025); which commit each covers was not checked (section 4.8).

**Built and proven.** Engine adapter `cctp-v2.ts` (routes, pure quote, nine pins, refusals, `track()` building the mint from the attestation). **Proven live by script** (`5466f91`): both legs carried to "delivered" with the adapter's calls unchanged; replay refused "Nonce already used"; the tampered message refused. **Not in the app:** the Bridge screen lists CCTP as "coming" and never quotes it (`CCTP_COMING_NOTE` in `app/src/wallet/bridge.ts`).

### 3.3 Across (research only)

**What moves.** An intent system: the user deposits into the sending network's SpokePool, a relayer pays the recipient on the receiving network from its own funds, and the relayer is repaid later through a "root bundle" on Ethereum that can be disputed within a challenge window, disputes settled by UMA's oracle (documented, `docs/BRIDGING.md` section 5.1). The keyless test API listed USDC (Circle's at both ends), ETH and WETH routes among all four Sepolia networks, **including Base Sepolia**; test relayers accepted at most about 8.0 USDC or 0.0031 ETH per deposit (read-only, 2026-10-12, sections 5.5 and 5.6).

**Who verifies, who can halt or redirect.** The user fixes the output amount at deposit: a relayer delivers it or does not fill, and an unfilled deposit is refunded through a later bundle, which "can take several hours" (documented). Funds wait in an upgradeable SpokePool. The controlling HubPool's owner has no contract code on Ethereum Sepolia (challenge window 601 s, bond 1 wei) and is a 3-of-5 Safe on Ethereum mainnet (1,800 s, a 0.45-token bond) (read-only, section 5.2). The `depositor` argument carries refund and speed-up rights and is free, so it must be pinned to the user's account (from source, section 5.4). Whether test-network settlement runs, and so whether test refunds execute, could not be verified. A proposal to move Across from a DAO to a private U.S. company passed its vote (documented).

**Pinning, access, fees.** Eleven fixed words of `deposit` can be pinned; the output amount only to a static floor; the variable-length `message` not at all. The test API returned an **unlimited** approval the wallet would have to replace (read-only, section 5.4). Keyless on the test host; production needs an API key and an integrator id (documented, section 5.3). Quotes only: 0.095 % for 5 USDC and 0.24 % for 0.001 ETH, Sepolia → Base Sepolia, with an estimated 10-second fill (read-only, section 5.7); actual fees and times **not measured**.

**Smart accounts.** A non-empty `message` requires the recipient contract to implement `handleV3AcrossMessage`; whether Kernel v3.3 does was not checked. How a relayer pays native ETH to a contract recipient was **not read**.

**ERC-7683, main networks, licence, audits.** The ERC-7683 settler has no code on any of the four test networks and the standard is still a Draft that differs from Across's interface, so feature 36 stays "Not started" (sections 5.5 and 5.11). Ethereum mainnet's SpokePool implementation is a Sourcify exact match; other main networks were not read. Licence `BUSL-1.1` (`SpokePool.sol` header and `LICENSE` at commit `950e9154`, fetched 2026-10-25). OpenZeppelin reports are linked, coverage of the deployed code not checked; a bug bounty "up to $1,000,000" (documented, section 5.8). **Nothing built, nothing sent.**

### 3.4 The native rollup bridges (research only)

**What moves.** ETH, between Ethereum Sepolia and one rollup at a time: Base Sepolia and OP Sepolia through the OP Standard Bridge, Arbitrum Sepolia through Arbitrum's bridge (`docs/BRIDGING.md` section 6). Never rollup to rollup (Base Sepolia to Arbitrum Sepolia would be a withdrawal then a deposit). **Not Circle's USDC:** on Base and OP Sepolia Circle's USDC lacks the interface the Standard Bridge requires, and Arbitrum's router maps Sepolia USDC to a different, bridged token (read-only, section 6.5).

**Who verifies, who can halt.** No third party signs: a deposit is a message the rollup must include and a withdrawal is proven against the rollup's state on Ethereum after a challenge period. The trust-minimised option of the five. The rollup operators can pause and upgrade: Base Sepolia's bridge and portal sit behind a 2-of-2 Safe; OP Sepolia's proxy admin is owned by a 2-of-2 Safe and its portal guardian is a 1-of-1 Safe; Arbitrum Sepolia's proxy-admin owners could not be read (read-only, section 6.3).

**Time.** Deposits "usually completed within 1-3 minutes" on OP (documented). Withdrawals from OP Sepolia wait **at least 7 days** plus a 3.5-day dispute finality delay (read on-chain, which contradicts OP's documentation that test networks are shorter); Arbitrum Sepolia confirms in 20 blocks, about 4 minutes (documented and read); Base Sepolia's real window lives in a contract that was not read (section 6.4). Nothing was sent, so no time was measured.

**Pinning and smart-account traps.** `depositETHTo` has the recipient at a fixed offset and can be pinned. Two traps (from source and documentation, section 6.6): OP's short `depositETH` refuses contract callers, so a Kernel account must use `depositETHTo`; and an Arbitrum `depositEth` from a contract or an EIP-7702 account credits an **aliased** address the account does not normally control. How OP treats an EIP-7702 account as caller was not checked.

**Access, fees, licences, audits.** No API, no key. No fee beyond gas was found in what was read. The OP `L1StandardBridge.sol` source is `MIT` at commit `0e82422c` (fetched 2026-10-25 for this document); Arbitrum's licence was not read. Arbitrum and OP publish audit lists; a Base-specific list was not located (section 6.7).

**Built and proven.** Nothing built, nothing sent.

### 3.5 The aggregators: LI.FI, Socket (Bungee), Relay (research only)

An aggregator answers a quote request with a ready-made transaction to its own router, choosing among underlying bridges. The target and calldata come from the API on every quote, so **a CallPolicy cannot pin them**, the same finding the record made for 0x and Uniswap's Universal Router (`docs/BRIDGING.md` section 7).

- **LI.FI** serves all four test networks keylessly (75 quotes per two hours; read-only API, section 7.1). A test quote for 5 USDC routed through Across in 1,444 bytes of opaque calldata and added a 0.25 % LI.FI fee. The routers' owner on all four test networks has no contract code. Which facets the routers use, and who can change them, was not checked.
- **Socket** lists no test network and has no code on any of the four (read-only, section 7.2). It cannot be evaluated here.
- **Relay** serves only Ethereum Sepolia and Base Sepolia. Its on-chain deposit carries only an order id, so what the user receives is a promise held off-chain; its trust rests on an "Allocator" using MPC signatures and an "Oracle" (documented); a key is required for `quote/v2` from 2 October 2026 (documented); one audit link returned HTTP 404 (section 7.3).

Nothing built or sent; fees and times beyond the quotes above not measured.

### 3.6 Not a fit: Stargate/LayerZero for tokens, and Wormhole

- **Stargate's token pools on the test networks** hold a publicly mintable mock "USDC", not Circle's USDC. A simulated mock-USDC send succeeded, but the token has no value and must never be shown as USDC (`docs/BRIDGING.md` sections 15.5 and 15.13). On main networks, LayerZero's "Bridged USDC" is Stargate's `StargateOFTUSDC`, built to Circle's Bridged USDC Standard: a bridged representation backed by Stargate's pools, with "optionality for Circle to seamlessly upgrade to native issuance in the future", not USDC issued by Circle (from source and Circle's document, section 15.11). No main-network deployment was read.
- **Wormhole** rests on a 13-of-19 guardian multi-signature with no on-chain proof of the source chain's state (documented, section 8). It was not re-examined after phase 20, and no Wormhole test deployment was looked for.

## 4. Side by side

**Evidence tags.** **LIVE**: seen in a transaction this wallet sent (commit or pass named in section 3). **READ**: a read-only on-chain or API answer in the record. **DOC**: the provider's documentation or its pinned source code, as cited in the record. **NM**: not measured or not read. A cell may carry two tags.

| Axis | LayerZero V2 + Stargate V2 | Circle CCTP V2 (Standard) | Across | Native rollup bridges | Aggregators (LI.FI, Socket, Relay) | Stargate token pools; Wormhole |
|---|---|---|---|---|---|---|
| Moves here | Native test ETH, 6 routes among Eth / Arb / OP Sepolia; none on Base Sepolia [READ, LIVE] | Circle USDC, 12 routes among all four [READ, LIVE on 2] | USDC, ETH, WETH among all four, small caps [READ] | ETH between Eth Sepolia and one rollup; no Circle USDC [READ] | LI.FI all four; Socket none; Relay two [READ] | Mock "USDC" only (Stargate); Wormhole [NM] |
| Who verifies | 1 LayerZero Labs verifier on every test route [READ, LIVE] | 2-of-2 Circle attesters [READ, LIVE] | Relayer fills; disputes via UMA [DOC] | The rollup's own proofs [DOC] | The routed bridge plus the router [DOC] | LayerZero config; 13-of-19 guardians [DOC] |
| Who can halt | Token owner and delegate; endpoint owner for defaults; test-pool planner key is public [READ] | Circle pausers, denylister (checks tx origin), upgraders, all EOAs [READ] | SpokePool admin via HubPool: EOA on Sepolia, 3-of-5 Safe on mainnet [READ] | Rollup Safes (Base 2-of-2, OP 2-of-2 / 1-of-1 guardian); Arbitrum [NM] | LI.FI router owner an EOA [READ]; Relay security council [DOC] | [NM] |
| Redirect in flight | No; the message is verified on-chain [DOC]; the delegate can skip or destroy a message [DOC] | No; a tampered message was refused [READ, simulated before the live mint] | `depositor` must be pinned or refund rights move [DOC] | No [DOC] | Calldata opaque [READ] | [NM] |
| Pinning | 14 words, only because the wallet fixes the layout; fee only capped [READ, LIVE dry run] | 7 + 2 words, complete [LIVE] | 11 words; `message` no; output only a static floor [DOC] | Recipient pinnable; traps for contracts [DOC] | No [READ] | [NM] |
| Approvals | None for native pools [LIVE] | Exact approve then burn; allowance back to 0 [LIVE] | API returns unlimited; must be replaced [READ] | None for ETH [DOC] | Router approval [READ] | — |
| Off-chain API and key (test / production) | None to send; Scan keyless for tracking / main-network terms [NM] | Iris sandbox keyless [LIVE] / main-network key [NM] | Keyless / key and integrator id [DOC] | None | LI.FI keyless 75 per 2 h; Relay key from 2026-10-02 [DOC] | [NM] |
| Fee as measured | ~0.000102–0.000130 test ETH messaging fee per leg; pool fee 0 on the two live routes, 10^12 wei quoted on four others [LIVE, READ] | 0 protocol fee [LIVE]; Fast and Forwarding [NM] | 0.095 % USDC, 0.24 % ETH quoted [READ]; actual [NM] | Gas only as far as read [DOC] | LI.FI +0.25 % quoted [READ] | [NM] |
| Time as measured | 90 s, 30 s (script), 86 s (app); other routes [NM] | 996 s, 1,058 s; OP Sepolia routes [NM] | ~10 s estimated [READ]; actual [NM] | OP withdrawal ≥ 7 days [READ]; deposits [NM] | [NM] | [NM] |
| Destination step for the user | None; the executor delivers [LIVE] | A mint transaction with gas on the receiving network; anyone may send it [LIVE] | None; the relayer pays [DOC] | Withdrawals need a finalising transaction [DOC] | Depends on route [NM] | [NM] |
| Smart-account sender | Built in the app, not sent live [NM] | Batch with USDC fee on Base / Arb Sepolia reasoned [NM]; bundler as tx origin under the denylist [DOC] | [NM] | OP short form refuses contracts; Arbitrum aliases contracts and 7702 accounts [DOC] | [NM] | [NM] |
| Smart-account recipient | Deployed Kernel cannot take Stargate ETH: cached, retry needed [READ simulated]; retry live [NM] | ERC-20 mint, should work [DOC]; live [NM]; paymaster cannot pay the first mint [DOC] | Kernel `handleV3AcrossMessage` [NM] | [NM] | [NM] | [NM] |
| Refund | None automatic [DOC] | None; burn final, mint any time [DOC]; Standard attestation no expiry [LIVE] | Refund via bundle, hours [DOC]; on testnet [NM] | Not applicable | Relay: no automatic refund on a screening failure [DOC] | [NM] |
| Main network | Nothing read or pinned [NM] | Ethereum mainnet contracts read; others [NM]; nothing pinned | Ethereum mainnet read; others [NM] | Documented only [DOC] | Documented only [DOC] | [NM] |
| Licence | LZBL-1.2 endpoint, MIT OFT, BUSL-1.1 Stargate [DOC] | Apache-2.0 [DOC, fetched 2026-10-25] | BUSL-1.1 [DOC, fetched 2026-10-25] | OP bridge MIT [DOC, fetched 2026-10-25]; Arbitrum [NM] | [NM] | [NM] |
| Audit coverage of deployed code | Reports listed; commit coverage [NM] | Three reports; commit coverage [NM] | Reports listed; coverage [NM] | Lists exist; coverage [NM] | LI.FI, Relay reports listed; coverage [NM] | [NM] |
| Built in the wallet | Engine + app Bridge screen + stored records | Engine; app lists it as "coming" | No | No | No | No |
| Proven live | Yes: 2 script legs, 1 in-app leg | Yes: 2 script legs | No | No | No | No |

### 4.1 Everything marked "not measured" or "not read"

- **LayerZero:** delivery times on four of the six routes; bus-mode waits; a smart-account sender; a deployed-Kernel recipient and the retry, live; an ERC-20 OFT; an EIP-7702 recipient; a CallPolicy refusing a bridge call; Scan's rate limits; the Value Transfer API; Stargate's fee library; who holds the endpoint owners' keys; why the test default is one verifier; every main-network fact; audit commit coverage.
- **CCTP:** routes from or to OP Sepolia; a second time sample per route; Fast Transfer; the Forwarding Service; the smart-account sender and a mint to a smart-account address; a third-party mint; a CallPolicy refusing a burn; whether the main-network attestation host needs a key; Base, Arbitrum and OP main-network contracts; how Circle secures its EOA-held roles; audit commit coverage.
- **Across, native bridges, aggregators:** every actual transfer, fee and time; Across's test refunds; Kernel and `handleV3AcrossMessage`; relayer ETH delivery to a contract; Base Sepolia's withdrawal window; Arbitrum's proxy-admin owners and licence; OP and an EIP-7702 caller; LI.FI's facets; Relay's fill times.
- **Wormhole:** everything beyond its documented guardian model.

## 5. The in-app model

### 5.1 Today

The Bridge screen (`app/src/screens/BridgeScreen.tsx`, `app/src/wallet/bridge.ts`; commits `fe34deb`, `2a1d2dc`, `8da86a6`, `71c5d50`) works like this:

- **The user chooses the provider; the wallet never picks one.** The screen lists every registered provider for the chosen pair of networks as a radio row with its label, what it moves, its three trust sentences verbatim, the fee once quoted and the measured time with the provider's own "not a promise" sentence; nothing is checked until the user taps a row ("You choose the provider. The wallet lists every provider it knows for this pair of networks and never picks one for you."). A provider that cannot be chosen is still listed, dimmed, with its reason.
- **One provider is offered**: LayerZero (Stargate) for the network's own coin. CCTP is listed as "Coming later, not offered yet", for comparison of who the user would be trusting. On Base Sepolia the screen says nothing can be bridged from there.
- **The wallet re-checks every quote itself** before showing it (`checkBridgeQuote`: the route and amount, exact or no approvals, one call to the pinned pool with the send selector, value exactly amount plus fee, and the destination, recipient, amount, fee and refund words read back), then sends through the existing regular-account or smart-account path with the preview, the risk card, the spending limits and one device prompt.
- **The recipient is always the regular account**, also from the smart account, because of Stargate's 2,300-gas delivery.
- **Tracking** every 15 seconds while the screen is open, from the chains' own events; transfers stored per wallet (newest 64); the sending transaction also appears on the pending card, so Speed up and Cancel cover a stuck bridge send.
- **Test networks only**, enforced by the readiness row `bridge`; multisig and watch-only accounts are refused.

### 5.2 What changes if CCTP becomes sendable

This is the app half of phase 23 item 4; none of it is built yet.

1. **An asset choice.** With CCTP the screen must offer USDC beside the network's own coin, so it should ask for the asset first and then list the providers (as `docs/BRIDGING.md` section 16 proposed). On every route today exactly one provider carries each asset; the other should stay listed, dimmed, with its reason, so the comparison of trust stays visible.
2. **Two source calls.** The exact `approve(TokenMessengerV2, amount)` then `depositForBurn`, batched in one operation from the smart account; `checkBridgeQuote` needs a CCTP branch (two calls, exact approval, nine pinned words).
3. **The destination mint.** After about 17 minutes a `receiveMessage` transaction is needed on the receiving network. When the regular account holds test ETH there, the wallet can build and submit it itself, as it submits the Stargate retry today (once that network is active). Otherwise the screen should say what is waiting: the USDC is burned, a Standard attestation does not expire, and anyone with gas there can complete the mint to the user's address at any time. Circle's Forwarding Service could submit it for a fee, but it is unmeasured.
4. **Waiting time and tracking.** The panel already re-reads every 15 seconds and stores transfers; a CCTP transfer needs states for "waiting for Circle's attestation" and "mint needed", and the quote should carry the measured 996 s and 1,058 s (an engine follow-up the CCTP record names).
5. **Smart accounts.** A CCTP mint is an ERC-20 mint, so USDC might go to the smart account, unlike Stargate's ETH; this must be seen live first. The USDC network fee through Circle's paymaster exists on Base and Arbitrum Sepolia only, and never for the first mint to an account with no USDC on that network.
6. **Wording now out of date:** the `bridge` readiness reason ("…and this wallet has not yet sent one") and `CCTP_COMING_NOTE` ("…has not yet sent a CCTP transfer…"); "never sent" in `docs/MAINNET_READINESS.md` section 2 and `docs/AUDIT_SCOPE.md` sections 4 and 5.6; "not yet seen on a device" in `docs/BRIDGE_PROVIDERS.md` section 6 and the items still listed as "next" in its section 10. Commit `5466f91` and pass p21b have since happened. **Corrected since:** the readiness reason and the app's note in commit `0a5bc7f` (which removed `CCTP_COMING_NOTE`); after it, the sentences named above in `docs/MAINNET_READINESS.md`, `docs/AUDIT_SCOPE.md` and `docs/BRIDGE_PROVIDERS.md`, which now say that CCTP V2 Standard Transfers were proven live by script on two routes and are offered in the app since `0a5bc7f` but not yet sent through it, and that the LayerZero half of the screen was seen on the emulator in pass p21b. **Corrected again (2026-10-28):** one CCTP transfer has since been sent through the app, from the regular account, Arbitrum Sepolia to Base Sepolia — the burn on 2026-10-26 UTC and the mint on 2026-10-27 UTC, after the fixes of commits `b06c074` and `954aca4` (`AGENTS.md` phase 23, passes p23-cctp and p23-mint) — and `docs/MAINNET_READINESS.md`, `docs/AUDIT_SCOPE.md` and `docs/BRIDGE_PROVIDERS.md` say so. The rest of this document describes the state at `f4b9339`.

## 6. Recommendation

### 6.1 On the test networks, now

In order:

1. **LayerZero (Stargate) for test ETH**, among Ethereum Sepolia, Arbitrum Sepolia and OP Sepolia: keep it as offered. It is the only built provider for the native coin, it is the fastest measured (30–90 seconds), it needs no action on the receiving network, and it is proven through the app. State its single verifier and the public pause key, as the screen already does.
2. **Circle CCTP V2, Standard Transfers only, for Circle's USDC**, on all four networks: make it sendable next. It is the only provider studied that moves native USDC, its call can be pinned completely without forcing a layout, its protocol fee was zero in both live legs, and each message needs two Circle signatures where each LayerZero test route needs one verifier's. The cost is time (about 17 minutes) and a second transaction on the receiving network. Before it is offered: a smart-account leg and an OP Sepolia route by script, the CCTP branch of `checkBridgeQuote`, the mint submitted by the wallet or clearly shown as waiting, and the out-of-date sentences in section 5.2 item 6 corrected.
3. **Across**, as the third adapter: worth a live leg by script, for two reasons the record supports. It is the only option studied that serves test ETH on Base Sepolia, and it would give the user a second ETH option with a different trust model (relayers and an optimistic settlement rather than one verifier). Conditions: `depositor` and `recipient` pinned to the account, the API's unlimited approval replaced by an exact one, amounts under the test relayers' caps, and the plain statement that refunds take hours and that Across's test settlement may not run. Not offered until that leg exists.
4. **Native rollup bridges**, optional: a "slow but trust-minimised" deposit of test ETH from Ethereum Sepolia to one rollup, regular account only (because of the contract-caller traps), if the Chairperson wants a path with no third-party verifier on screen. Withdrawals stay out (at least 7 days from OP Sepolia).
5. **Not offered:** aggregators on any signing path (unpinnable calldata; at most a read-only price comparison later), Stargate's mock-token pools, and Wormhole.

### 6.2 On main networks, later

No bridge should be offered on a main network until all of these hold. Each is a condition from the record, not a new one.

1. **Addresses pinned and verified on each main network**, as the audit-pack script does for the test networks (`scripts/audit/verify-pins.mjs`). Today no main-network bridge address is pinned; for CCTP only Ethereum mainnet was read, for LayerZero nothing.
2. **LayerZero: the verifier question.** Read the main-network pathway configuration of the specific pool or token the wallet would use, and decide what is acceptable. `docs/BRIDGE_PROVIDERS.md` section 8 already recommends tokens whose owners require more than one independent verifier on main networks; whether the main-network defaults or Stargate's own configuration meet that was not read. Also read Stargate's main-network owner and planner, and settle the licence question (`BUSL-1.1`, `LZBL-1.2`) with counsel.
3. **CCTP: a main-network check of Circle's attestation service** (whether `iris-api.circle.com` needs a key, and its rate limit in practice), the Base, Arbitrum and OP main-network contracts and roles read, and decisions on Fast Transfer and the Forwarding Service (both unmeasured).
4. **Audit coverage.** For each provider, which audit covers the deployed bytecode (not checked for any provider). The wallet's own bridge code (`bridge.ts`, the adapters) is in scope of the planned audit (`docs/AUDIT_SCOPE.md`).
5. **C1–C3 for the smart-account path.** The conditions C1 (audit coverage), C2 (bug bounty) and C3 (support horizon) concern the Kernel v3.3 smart account (`docs/AA_FRAMEWORKS.md` section 17.2, as corrected in `docs/AUDIT_SCOPE.md`): they block a smart-account bridge on main networks as they block every smart-account feature, but not a regular-account bridge, which instead depends on items 1–4.
6. **The test-network gaps closed first:** a smart-account bridge and a stranded-transfer retry seen live (`docs/MAINNET_READINESS.md`, Stage 2), and the pathway configuration re-read at quote time rather than taken from a table dated 2026-10-15 (`THREAT_MODEL.md` T-81).

On main networks the recommended order by asset would be the same in principle: CCTP for USDC, because it is the issuer's own burn and mint (the LayerZero alternative there is a bridged representation, section 3.6); and, for the native coin, LayerZero or Across depending on what the main-network verifier configuration and an Across live leg show. Neither has been read on a main network, so this document does not rank them there.

### 6.3 LayerZero judged as a full alternative to CCTP

| User job (section 2.4) | LayerZero (Stargate) | CCTP V2 | Verdict on the record |
|---|---|---|---|
| Move the native coin | Yes, on three networks, 30–90 s, ~0.0001 ETH fee | No | LayerZero; CCTP is not an option |
| Move Circle's USDC | No: no LayerZero token carries it on the test networks; on main networks only a bridged representation | Yes, all four networks, ~17 min, no fee | CCTP; LayerZero is not an alternative for native USDC |
| Pay from a smart account | Send path built, not sent live; no USDC fee path relevant (native coin) | Batch with USDC fee on Base / Arbitrum Sepolia reasoned, not run | Neither proven; CCTP has the better-documented fee story |
| Receive into a smart account | Not for Stargate ETH without a retry (simulated) | An ERC-20 mint should work (reasoned), but the first mint needs gas from someone | CCTP likely, not proven; LayerZero needs the retry or the regular address |
| Trust on the test networks | 1 verifier, public pause key | 2 Circle attesters, Circle EOA-held roles | CCTP needs two signatures, LayerZero's test routes one; each set belongs to one company. Which is stronger depends on how the keys are held, which was not verified for either |
| Pinning | Complete only with the wallet's fixed layout; fee capped | Complete by construction | CCTP |
| Speed and user effort | Faster; no destination transaction | Slower; a destination transaction | LayerZero |

So, on the CTO's reading of the record, LayerZero is the choice where it applies (the native coin) and CCTP where it applies (USDC): complements, not substitutes, on this wallet's routes. The one network where no built provider moves the native coin is Base Sepolia, which is the reason Across is the next candidate.

## 7. Open questions for the Chairperson

1. **The asset-first screen.** Should the Bridge screen ask for the asset first (test ETH or USDC) and then list the providers, with the provider that does not carry that asset still listed and dimmed for comparison? This document recommends it.
2. **The CCTP destination mint.** Is it acceptable that the wallet submits the mint from the regular account only when it holds gas on the receiving network (and that the user may need to switch to that network, as the Stargate retry requires today), and otherwise shows the transfer as waiting? Or should the wallet also offer Circle's Forwarding Service, which is unmeasured and adds a fee?
3. **Fast Transfer.** Should CCTP Fast Transfers (documented at seconds rather than minutes, for 1 to 1.3 basis points on the test networks) stay out, as now?
4. **USDC to a smart account.** Once a CCTP mint to a Kernel address is seen live, may USDC go to the smart account while test ETH keeps going to the regular account?
5. **Across.** Approve a live Across leg by script, to cover test ETH on Base Sepolia and give a second ETH option?
6. **Native bridges.** Is a deposit-only, regular-account, trust-minimised path wanted on screen?
7. **The single verifier.** Is showing LayerZero's single test verifier acceptable for the test networks, and what verifier requirement should a main-network LayerZero route meet (for example at least two independent required verifiers)?
8. **Keyed APIs on main networks.** If Circle's main-network attestation service or Across's production API needs a key, is a keyed dependency acceptable?
9. **Licences.** Should counsel review `BUSL-1.1` (Stargate, Across) and `LZBL-1.2` (LayerZero's endpoint) before any main-network use, as for Circle's GPL paymaster?
10. **Bridged USDC.** Should a bridged USDC (such as Stargate's on main networks) ever be offered, and if so labelled distinctly from Circle's USDC? This document recommends not offering it beside CCTP.
11. **Re-reading the pathway at quote time.** Should the app re-read the LayerZero pathway configuration at each quote (`THREAT_MODEL.md` T-81) before more in-app legs, rather than rely on the table read on 2026-10-15?

## 8. Sources

The record:

- `AGENTS.md`: phase 20 item 4 (commit `deb7f8a`, the bridging research); phase 21 item 1 (the LayerZero research `72a56a8`, the live leg `fec6c32`, the adapter follow-ups `bbc21d7`, the Bridge screen `fe34deb`, the stored transfers `2a1d2dc`, pass p21b with the in-app bridge, the p21b fixes `8da86a6`, the follow-ups `71c5d50`, pass p21e); phase 23 item 1 (the audit-pack script, commit `f5d739a`) and item 4's script leg (commit `5466f91`).
- `docs/BRIDGING.md` sections 1–17 (research on 2026-10-11/12 and 2026-10-15 UTC; the live runs in sections 15.16 and 17, with every source, commit and fetch date listed in sections 2, 15.1 and 17).
- `docs/BRIDGE_PROVIDERS.md` sections 4.3 and 4.4 (the measured comparison), 6, 7 and 8.
- `docs/THREAT_MODEL.md` T-80 to T-87 and F-80; `docs/MAINNET_READINESS.md` section 2; `docs/AUDIT_SCOPE.md` sections 4, 5.6 and 5.7; `docs/AA_FRAMEWORKS.md` section 17.2.
- The code: `packages/chains-evm/src/bridge/cctp-v2.ts` (`CCTP_V2_TRUST`, the refusals), `layerzero-oft.ts` (`LAYERZERO_OFT_TRUST`, the route table), `types.ts`, `registry.ts`, `util.ts`; `app/src/wallet/bridge.ts` (`BRIDGE_CHOICE_NOTE`, `CCTP_COMING_NOTE`, `checkBridgeQuote`), `app/src/wallet/watch-only.ts` (the route allow-lists), `app/src/config/readiness.ts` (row `bridge`).

Fetched for this document on 2026-10-25 at about 15:01 UTC (licence headers only):

- `circlefin/evm-cctp-contracts` at commit `63ab1f0ac06ce0793c0bbfbb8d09816bc211386d` (raw files from `https://raw.githubusercontent.com/circlefin/evm-cctp-contracts/<commit>/…`): the `TokenMessengerV2.sol` and `MessageTransmitterV2.sol` sources in its `src` folder, version-2 subfolder, carry `SPDX-License-Identifier: Apache-2.0`, and its `LICENSE` is the Apache License 2.0.
- `https://raw.githubusercontent.com/across-protocol/contracts/950e9154f3d61e59590eb7d4403fae5d3cae84f8/contracts/spoke-pools/SpokePool.sol` and `…/LICENSE`: `SPDX-License-Identifier: BUSL-1.1`; Business Source License 1.1.
- `https://raw.githubusercontent.com/ethereum-optimism/optimism/0e82422cd48d4610bf2ce67f8d376621f3c2602a/packages/contracts-bedrock/src/L1/L1StandardBridge.sol`: `SPDX-License-Identifier: MIT`.

The commits are the ones `docs/BRIDGING.md` section 2 pins. A licence header describes the source; whether deployed bytecode matches it is a separate question (section 3).

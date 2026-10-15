# Bridge providers: the adapter design

**Status:** Design, plus the engine interface, registry and two adapter skeletons, written on 2026-10-14 (US Eastern) for phase 21 item 1 (`AGENTS.md`, "Phase 21 plan"). The engine code is in `packages/chains-evm/src/bridge/` with tests in `packages/chains-evm/test/bridge.test.ts`. No app screen, readiness row or live transaction exists yet. The research behind every provider fact is in `docs/BRIDGING.md`: Circle CCTP V2 in section 4 and the live plan in section 11; LayerZero V2 and Stargate V2 in section 15; the updated recommendation in section 16.

This file is plain technical prose for leadership and for the engineers who build the next slices. The persona and compression rules do not apply to it.

## 1. Why an adapter

On 2026-10-14 the Chairperson decided: "LayerZero instead of CCTP, or better, OPTIONALITY: let the user choose the provider" (`AGENTS.md`, "DECIDED by the Chairperson (2026-10-14)"). Requirement 4 of the project ("Maximum flexibility. No architectural lock-in; every feature must be addable later without rewrites") points the same way. The wallet already solved the same problem for chains: ADR D3 (`docs/ARCHITECTURE.md` section 7) puts every chain behind a `ChainAdapter` interface and a registry keyed by chain id, so a new chain is a registration, not a rewrite. Bridges get the same treatment: every provider implements one `BridgeProvider` interface and registers under a provider id; the Bridge screen lists every registered provider that serves the route the user wants and shows each one's own trust statement, fee, time and refund rule. Adding Across later, or removing a provider whose terms change, is one registration.

The adapter boundary also keeps two of the project's rules in one place: the engine is pure TypeScript with no network access of its own (ADR D2), and the wallet signs only calls it built and can explain (the exact-approval rule and the CallPolicy pins of `docs/BRIDGING.md` section 3).

## 2. The interface

Defined in `packages/chains-evm/src/bridge/types.ts`. All amounts are exact `bigint`s in base units; addresses are EIP-55 checksummed.

```ts
interface BridgeProvider {
  readonly id: string;                 // e.g. 'cctp-v2', 'layerzero-oft'
  readonly label: string;              // shown to the user
  readonly trust: BridgeTrustStatement; // who verifies, who controls, the refund rule
  supportedRoutes(): readonly BridgeRoute[];        // pure, no network
  quote(request: BridgeQuoteRequest): Promise<BridgeQuote>;
  track(transfer: BridgeTransfer): Promise<BridgeTransferStatus>;
}
```

- **`BridgeRoute`**: provider id, source and destination chain ids (EIP-155), and the asset on each side (`native` or `erc20` with address, symbol and decimals).
- **`BridgeQuoteRequest`**: the route, the amount, the sender, the recipient and an optional minimum to receive.
- **`BridgeQuote`**, everything the confirm screen needs, and nothing it has to guess:
  - `expectedAmountOut` and `minAmountOut` (the latter written into the call when the protocol supports it);
  - `fees`: a list of `BridgeFeeLine`s, each with its kind (`protocol`, `messaging`, `pool`, `forwarding`), a plain description, the exact amount (or `null` when the provider cannot state it before sending), the asset it is paid in, whether it is taken out of the amount, and the chain it is paid on;
  - `time`: lower and upper bounds in seconds or `null`, always with the source of the figure ("not measured on the test networks" where that is the truth);
  - `approvals`: exact ERC-20 approvals only (`exactApprovalCall` refuses zero and anything at or above 2^255);
  - `calls`: the source-chain calls in order, each a `BridgeCall` — the usual `{to, value, data}` plus its purpose, chain, label, selector, the `pins` a Kernel CallPolicy can hold fixed (in the wallet's existing `SessionParamRule` shape, so a session-key grant can be built from them directly), the arguments it cannot pin with the reason (`unpinnable`), and its `valueLimit`;
  - `destination`: what must happen on the receiving network (`mint-after-attestation` with who may submit it, or `executor-delivers`);
  - `refundRule`, `tracking` (whether an HTTP API is needed and whether it needs a key) and `notes` (plain warnings for the screen).
- **`BridgeTransferStatus`**: `unknown`, `in-flight`, `awaiting-destination-action`, `delivered` or `failed`, a plain detail sentence, and, when the provider can build them, the destination calls still needed (the CCTP mint).

A provider that needs the network receives read functions from the app when it is constructed (section 5). It never signs or sends.

## 3. The registry

`packages/chains-evm/src/bridge/registry.ts`: a `BridgeRegistry` keyed by provider id, with `register`, `has`, `get`, `require`, `list` and `routes({sourceChainId?, destinationChainId?})`. It makes no network request. It refuses, before storing anything: a malformed id (2 to 40 lower-case letters, digits or hyphens), a duplicate id, a provider without a label or without all three parts of its trust statement, and any route that names another provider, a chain id that is not a positive integer, the same chain at both ends, impossible decimals or a mis-checksummed token address.

The registry never picks a provider. `routes()` returns every match from every provider in registration order, and the screen shows them all; ordering by price or speed, if ever wanted, is a screen decision that must not hide a provider's trust statement.

## 4. How the two first providers map onto it

### 4.1 Circle CCTP V2 (`cctp-v2.ts`, id `cctp-v2`)

- **Routes:** the twelve directed pairs among Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia and OP Sepolia, Circle's USDC on both sides (`docs/BRIDGING.md` section 4.5). Domains 0, 6, 3 and 2.
- **Quote:** pure; no network. Standard Transfer only: `maxFee` 0 and `minFinalityThreshold` 2000. Calls: `approve(TokenMessengerV2, amount)` on the source USDC, then `depositForBurn(amount, destinationDomain, mintRecipient, USDC, destinationCaller = 0, 0, 2000)` (selector `0x8e0250ee`). All seven arguments are fixed-size, so the call is pinned completely (offsets 0 to 192). Fee line: Circle's protocol fee, zero, because `maxFee` is signed as zero. Time: Circle's documented "~15-19 minutes" for Standard Transfers from the four main networks, marked as not measured on the test networks.
- **Refused rather than guessed:** Fast Transfers (their fee comes from Circle's API and is deducted at mint), a minimum above the amount, an unknown domain, a zero recipient, a mis-checksummed address, `maxFee ≥ amount` (TokenMessengerV2 reverts on it).
- **Destination:** `mint-after-attestation`, submitter `anyone`: the recipient is fixed by the attested message, so any funded account may send `receiveMessage(message, attestation)` (selector `0x57ecfd28`) to MessageTransmitterV2 on the receiving network.
- **Track:** the app supplies `fetchAttestation({sourceDomain, sourceTxHash})`, which wraps Circle's keyless Iris call `GET https://iris-api-sandbox.circle.com/v2/messages/{sourceDomain}?transactionHash=…`; when it returns the message and attestation, `track()` reports `awaiting-destination-action` with the mint call built. An optional `isMinted` reader turns that into `delivered`.

### 4.2 LayerZero OFT (`layerzero-oft.ts`, id `layerzero-oft`)

- **Routes:** derived from a list of `OftDeployment` records the app passes in. Each record names the contract the user calls, its kind (`oft`, `oft-adapter`, `stargate-pool`, `stargate-pool-native`), its asset, its shared decimals, the OApp registered with the endpoint, a plain control note, and, for each outbound destination, the **security facts read from the chain** (required and optional DVNs with their operators, the optional threshold, the source confirmations, the executor, whether LayerZero's defaults apply, and where and when it was read). A destination without such facts has no route; a record without at least one verifier, or without a "read at", is refused. The engine ships one verified table, `STARGATE_V2_TESTNET_NATIVE_POOLS`: Stargate V2's native-ETH pools on Ethereum Sepolia, Arbitrum Sepolia and OP Sepolia (six routes; none to Base Sepolia, where Stargate has no pool), each pathway using LayerZero's default of one LayerZero Labs DVN and executor (`docs/BRIDGING.md` sections 15.4 and 15.5).
- **Quote:** reads the chain through the injected `readContract`: `quoteOFT` (the amount that would arrive and the pool's limits) and then `quoteSend` (the native messaging fee) with the minimum set to that arrival. Builds `send(SendParam, {nativeFee, 0}, refundAddress = sender)` (selector `0xc7c7f5b3`) with `extraOptions` and `composeMsg` empty and `oftCmd` empty (taxi) or `0x00` (Stargate bus, opt-in). Value: the fee, plus the amount for a native pool. An exact approval precedes it for an OFT adapter or an ERC-20 Stargate pool; a plain OFT burns from the sender and needs none. Pins: fourteen words (fifteen in bus mode), including the struct pointer, the three bytes-field offsets and their lengths, which only the wallet's fixed layout makes pinnable (`docs/BRIDGING.md` section 15.7). Fee lines: the LayerZero messaging fee (native coin, not deducted, excess refunded) and, when present, the pool's fee taken from the amount. Notes: the verifier sentence built from the record ("Verified by 1 required verifier (LayerZero Labs), after 2 block confirmations; delivered by LayerZero Labs's executor. These are LayerZero's defaults…"), the control note, and, for Stargate ETH, the smart-account delivery caveat.
- **Refused rather than guessed:** an amount with dust below the shared-decimals step, an arrival below the user's minimum, an amount outside the pool's limits, a fee asked in the LayerZero token, a zero messaging fee, bus mode on anything but a Stargate pool, an endpoint id or chain not in the verified table, non-empty options or compose messages, any `oftCmd` other than empty or `0x00`, a zero recipient or refund address, and any `quoteSend` answer that is not exactly two words.
- **Destination:** `executor-delivers`: the executor delivers once the verifiers confirm, and delivery is permissionless if it does not.
- **Track:** the app supplies `fetchMessageStatus({sourceChainId, sourceTxHash})`, for example over LayerZero Scan's keyless testnet API (`https://scan-testnet.layerzero-api.com/v1/messages/tx/{hash}`); `layerZeroScanState` maps its ten status names to the wallet's five states.

### 4.3 The differences the user must see

| | CCTP V2 | LayerZero OFT (Stargate on the test networks) |
|---|---|---|
| Who verifies | Circle: two Circle attesters must sign; Circle also issues USDC | The DVNs the token owner configured; on these test networks one LayerZero Labs DVN |
| Who can change that | Circle (attester manager, owner, pausers, denylister; EOAs on the test networks) | The token owner and its delegate at any time; the endpoint owner for every token that uses the defaults |
| Destination step | Someone with gas on the receiving network submits the mint after the attestation | LayerZero's executor delivers; anyone may if it does not |
| Smart account as recipient | Fine (an ERC-20 mint) | Fine for ERC-20 OFTs; Stargate ETH to a deployed smart account waits for a `retryReceiveToken` on the receiving network |
| Assets here | Circle's USDC, all four networks | ETH among Sepolia, Arbitrum Sepolia and OP Sepolia; no route to Base Sepolia |
| Fee | Standard: zero protocol fee, gas on both sides | Messaging fee in ETH about the size of a 0.0001 ETH transfer on test networks, sometimes a 1 % pool fee, source gas only |
| Time | ~15–19 min documented for Standard (main networks) | Not measured; 1 to 5 source confirmations, then delivery |
| Refund | None: the burn is final; the attested mint can be completed by anyone at any time | None automatic; a verified message can be executed by anyone; an unverified one stays until the token owner acts |
| Pinning | Complete (seven fixed words) | Complete only because the wallet fixes the layout; the fee can only be capped by a standing rule |
| Off-chain API | Iris (attestation), keyless | None needed for sending; Scan for tracking, keyless |

## 5. What the app supplies

The engine stays pure. The app passes, at construction:

- for CCTP: `fetchAttestation` (one HTTPS GET to Iris, with the app's own timeout and failure wording) and optionally `isMinted` (a destination read);
- for LayerZero: `readContract({chainId, to, data})` for `quoteOFT` and `quoteSend` (through the app's endpoint failover, which the engine does not know about) and optionally `fetchMessageStatus`.

Each reader's answer is checked by the engine (for example `decodeOftMessagingFee` refuses anything but two words; `decodeOftQuoteOftHead` checks the fee-detail offset), and the attestation and the LayerZero message are in any case verified on-chain at the destination, so a dishonest API can delay or withhold but not redirect funds.

## 6. What the Bridge screen shows (next slice)

For the route and asset the user picks, one card per provider that serves it, each with:

1. the provider label and its **trust statement verbatim** (who verifies, who controls, the refund rule), plus the route-specific verifier sentence from the quote notes (for LayerZero, read from the chain for that pathway, not assumed);
2. every fee line with its asset and whether it comes out of the amount, the amount expected to arrive and the minimum written into the call;
3. the time estimate with its source, including "not measured on test networks";
4. "Exact approval only: this allows <spender> to take exactly <amount> <token>, nothing more" when an approval is needed;
5. the destination step in plain words (CCTP: "after Circle attests, a second transaction on <network> completes the transfer; you or anyone can send it"; LayerZero: "delivered automatically by LayerZero Labs' executor");
6. the notes (the paymaster first-arrival limit for CCTP; the Stargate smart-account caveat; the public test pause key).

The confirm screen then reuses the existing send paths: the regular account through `prepareEvmSend`, the smart account through `prepareAaCalls` (a batch of approve + bridge), with the existing preview, risk card and pre-flight. The risk card should name the pinned bridge contracts the way it names Lido's (phase 18), and the Activity sentence should read "Bridged … to <network> with <provider>".

## 7. Readiness

Two rows, both `testnet-only` and enforced in the provider construction path and in the screen (as for `staking` and `dca`):

- `bridging-cctp`, reason as in `docs/BRIDGING.md` section 4.12;
- `bridging-layerzero`, reason as in section 15.14.

Main networks need: every main-network address read on-chain on each chain; for LayerZero, each OFT's own DVN configuration read and shown (main-network defaults were not read); the audit coverage checked against deployed bytecode; and the general conditions C1–C3 (`docs/THREAT_MODEL.md` section 7, `docs/MAINNET_READINESS.md`).

## 8. Threat-model rows to add when the screen lands

Proposed for `docs/THREAT_MODEL.md` (numbers to be assigned then):

1. **Verifier compromise.** CCTP: Circle's two attesters sign a false burn. LayerZero: the configured DVNs (one LayerZero Labs DVN on the test pathways) sign a false payload. Mitigation: state who verifies on every quote; test networks only; prefer tokens whose owners configure more than one independent required DVN on main networks.
2. **Configuration changed after the quote.** The token owner, its delegate or the endpoint owner (for default pathways) can change verifiers or libraries between quote and inclusion. Mitigation: the quote records where its facts were read; a re-read at confirm time for LayerZero pathways is a follow-up.
3. **Approval misuse.** An unlimited approval left to a bridge contract. Mitigation: exact approvals only, enforced by `exactApprovalCall`; batch approve + bridge in one smart-account operation where possible.
4. **Recipient redirection by a session key or a tampered quote.** Mitigation: the recipient, destination and token words are pinned; for LayerZero also the struct pointer and every bytes offset and length; a compose message is never built.
5. **Funds stranded at the destination.** CCTP: nobody submits the mint (the user needs gas there, or the Forwarding Service). Stargate ETH to a deployed smart account: `UnreceivedTokenCached` until someone calls `retryReceiveToken`. Mitigation: say so before confirming; `track()` returns the needed destination calls.
6. **Censorship and liveness.** Circle's denylist checks `tx.origin` (the bundler for a smart account); Circle can pause; Stargate's test pools can be paused by anyone holding a public development key; the executor is a single operator. Mitigation: plain statements; no claim of guaranteed delivery.
7. **API withholding or lying.** Iris or Scan withholds or misreports. Mitigation: destination state is read on-chain before reporting `delivered` where a reader exists; the attestation and message are verified on-chain.
8. **Stale fees.** The LayerZero fee changes; Stargate's pool fee depends on path credit. Mitigation: `minAmountLD` is written from the quote, so a worse pool fee reverts the send instead of delivering less; the messaging fee is re-quoted at confirm time, and any excess is refunded.

## 9. Adding a third provider

A new adapter must: implement `BridgeProvider`; take every network read through injected functions; state its trust in the three sentences; list routes only for contracts read on-chain (address, code, source verification, who controls them) and recorded with where and when; build exact approvals with `exactApprovalCall`; give every call its pins and its unpinnable arguments; refuse any value it cannot verify instead of defaulting it; and come with tests that pin its encoders byte for byte against ethers and run its pins through `assertCallsAllowed`. Across (`docs/BRIDGING.md` section 5) is the obvious candidate; its `deposit` has eleven fixed words and one dynamic `message`, and its API's unlimited approval must be replaced.

## 10. What is built and what is next

Built (engine, offline): the types, the registry, `exactApprovalCall`, the CCTP V2 encoder, pins and provider (Standard Transfers), the LayerZero OFT encoders (`send`, `quoteSend`, `quoteOFT`), decoders, layout, pins and provider, the verified tables (`CCTP_V2_TESTNET*`, `LAYERZERO_V2_TESTNET`, `STARGATE_V2_TESTNET_NATIVE_POOLS`), and 27 tests in `packages/chains-evm/test/bridge.test.ts` (registry, byte-identical encoders against ethers, pins checked against the calldata and against the wallet's CallPolicy mirror, refusals, tracking).

Next, in order: the live LayerZero leg by script (`docs/BRIDGING.md` section 15.13), the live CCTP leg (section 11), the app's readers (Iris, `eth_call` through failover, Scan), the readiness rows, the Bridge screen, the risk-card and Activity wording, and the threat-model rows above.

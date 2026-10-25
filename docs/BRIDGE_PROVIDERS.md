# Bridge providers: the adapter design

**Status:** Design, plus the engine interface, registry and two adapter skeletons, written on 2026-10-14 (US Eastern) for phase 21 item 1 (`AGENTS.md`, "Phase 21 plan"). The engine code is in `packages/chains-evm/src/bridge/` with tests in `packages/chains-evm/test/bridge.test.ts`. No app screen, readiness row or live transaction existed when this file was first written; the later status is in sections 6 and 10. The research behind every provider fact is in `docs/BRIDGING.md`: Circle CCTP V2 in section 4, the live plan in section 11 and the live run in section 17 (2026-10-25); LayerZero V2 and Stargate V2 in section 15, with the live run in section 15.16; the updated recommendation in section 16.

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
- **`BridgeQuoteRequest`**: the route, the amount, the sender, the recipient, an optional minimum to receive, and an optional `nativeSymbol` (the network profile's name for its coin, for example "test ETH"; 1 to 20 letters, digits, spaces, dots or hyphens; default "ETH"), which the fee lines use while the route's assets keep "ETH". CCTP ignores it.
- **`BridgeQuote`**, everything the confirm screen needs, and nothing it has to guess:
  - `expectedAmountOut` and `minAmountOut` (the latter written into the call when the protocol supports it);
  - `fees`: a list of `BridgeFeeLine`s, each with its kind (`protocol`, `messaging`, `pool`, `forwarding`), a plain description, the exact amount (or `null` when the provider cannot state it before sending), the asset it is paid in, whether it is taken out of the amount, and the chain it is paid on;
  - `time`: lower and upper bounds in seconds or `null`, always with the source of the figure ("not measured on the test networks" where that is the truth), and, when this exact route was timed in a live run, `measured` (`{seconds, date, description}`); one measurement is not a range, so the bounds stay `null`;
  - `approvals`: exact ERC-20 approvals only (`exactApprovalCall` refuses zero and anything at or above 2^255);
  - `calls`: the source-chain calls in order, each a `BridgeCall` — the usual `{to, value, data}` plus its purpose, chain, label, selector, the `pins` a Kernel CallPolicy can hold fixed (in the wallet's existing `SessionParamRule` shape, so a session-key grant can be built from them directly), the arguments it cannot pin with the reason (`unpinnable`), and its `valueLimit`;
  - `destination`: what must happen on the receiving network (`mint-after-attestation` with who may submit it, or `executor-delivers`);
  - `refundRule`, `tracking` (whether an HTTP API is needed and whether it needs a key) and `notes` (plain warnings for the screen);
  - `gasEstimate`: the source network's `eth_estimateGas` for the bridge call when the app supplied an estimator, else `null` (also `null` when an approval must be mined first, and when the estimator failed, each with a note). It is not a gas limit; the app adds its usual margin.
- **`BridgeTransferStatus`**: `unknown`, `in-flight`, `awaiting-destination-action`, `delivered` or `failed`, a plain detail sentence, the destination transaction when known, and, when the provider can build them, the destination calls still needed (the CCTP mint; Stargate's `retryReceiveToken`). With the on-chain readers (section 5), `onChain` adds what the chains' own events showed: `{status: delivered | cached-needs-retry | in-flight | source-reverted | unknown, guid, destinationTx, amountReceived, apiStatus}`, where `apiStatus` is the off-chain API's status reported beside it.

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
- **Proven live by script (2026-10-25, `docs/BRIDGING.md` section 17):** two Standard Transfers of 1 USDC (Base Sepolia → Arbitrum Sepolia, Ethereum Sepolia → Base Sepolia) sent with the adapter's calls unchanged and carried to `delivered` by its `track()`, with `fetchAttestation` as the Iris GET above and `isMinted` as `MessageTransmitterV2.usedNonces(nonce)` on the receiving network. No adapter change was needed. Two engine follow-ups the run exposed, not made: the quote's time still says "not measured on the test networks" (it could carry `measured` like the LayerZero deployments: 996 s and 1,058 s burn block to mint block), and the Fast-Transfer refusal lives only in `quote()` (`encodeDepositForBurn` itself accepts finality 1000 with a non-zero `maxFee`).

### 4.2 LayerZero OFT (`layerzero-oft.ts`, id `layerzero-oft`)

- **Routes:** derived from a list of `OftDeployment` records the app passes in. Each record names the contract the user calls, its kind (`oft`, `oft-adapter`, `stargate-pool`, `stargate-pool-native`), its asset, its shared decimals, the OApp registered with the endpoint, a plain control note, and, for each outbound destination, the **security facts read from the chain** (required and optional DVNs with their operators, the optional threshold, the source confirmations, the executor, whether LayerZero's defaults apply, and where and when it was read). A destination without such facts has no route; a record without at least one verifier, or without a "read at", is refused. The engine ships one verified table, `STARGATE_V2_TESTNET_NATIVE_POOLS`: Stargate V2's native-ETH pools on Ethereum Sepolia, Arbitrum Sepolia and OP Sepolia (six routes; none to Base Sepolia, where Stargate has no pool), each pathway using LayerZero's default of one LayerZero Labs DVN and executor (`docs/BRIDGING.md` sections 15.4 and 15.5).
- **Quote:** reads the chain through the injected `readContract`: `quoteOFT` (the amount that would arrive and the pool's limits) and then `quoteSend` (the native messaging fee) with the minimum set to that arrival. Builds `send(SendParam, {nativeFee, 0}, refundAddress = sender)` (selector `0xc7c7f5b3`) with `extraOptions` and `composeMsg` empty and `oftCmd` empty (taxi) or `0x00` (Stargate bus, opt-in). Value: the fee, plus the amount for a native pool. An exact approval precedes it for an OFT adapter or an ERC-20 Stargate pool; a plain OFT burns from the sender and needs none. Pins: fourteen words (fifteen in bus mode), including the struct pointer, the three bytes-field offsets and their lengths, which only the wallet's fixed layout makes pinnable (`docs/BRIDGING.md` section 15.7). Fee lines: the LayerZero messaging fee (native coin, not deducted, excess refunded) and, when present, the pool's fee taken from the amount. Notes: the verifier sentence built from the record ("Verified by 1 required verifier (LayerZero Labs), after 2 block confirmations; delivered by LayerZero Labs's executor. These are LayerZero's defaults…"), the control note, and, for Stargate ETH, the smart-account delivery caveat.
- **Refused rather than guessed:** an amount with dust below the shared-decimals step, an arrival below the user's minimum, an amount outside the pool's limits, a fee asked in the LayerZero token, a zero messaging fee, bus mode on anything but a Stargate pool, an endpoint id or chain not in the verified table, non-empty options or compose messages, any `oftCmd` other than empty or `0x00`, a zero recipient or refund address, and any `quoteSend` answer that is not exactly two words.
- **Destination:** `executor-delivers`: the executor delivers once the verifiers confirm, and delivery is permissionless if it does not.
- **Track, from the chains' own events** (since the adapter follow-ups of 2026-10-15): when the app supplies both log readers (`readSourceReceipt` and `readDestinationLogs`; the constructor refuses one without the other), `track()` reads the source receipt and needs exactly one `OFTSent` from the source pool towards the route's endpoint id paired with one `PacketSent` from the endpoint with the same GUID, the route's endpoint ids and both OApps; otherwise the transfer "cannot be followed". It then asks the receiving chain for `OFTReceived` with that GUID on the target pool: "delivered" needs the same GUID, source endpoint id, recipient and `amountReceivedLD` (a mismatch reports `unknown`, never "delivered"). On Stargate targets it then looks for `UnreceivedTokenCached` with the GUID in its data: the funds wait in the pool, the state is `awaiting-destination-action`, and the status carries the permissionless `retryReceiveToken(guid, index, srcEid, receiver, amountLD, composeMsg)` call (selector `0xa88835d7`, value 0, to the receiving pool; refused for a cached transfer with a compose message). `OFTReceived` wins over a cache. Bus mode is reported as `unknown` (a passenger's delivery GUID is not read).
- **Track, supporting evidence:** the app may also supply `fetchMessageStatus({sourceChainId, sourceTxHash})`, for example over LayerZero Scan's keyless testnet API (`https://scan-testnet.layerzero-api.com/v1/messages/tx/{hash}`); `layerZeroScanState` maps its ten status names to the wallet's five states. With the log readers, Scan never decides: a Scan "DELIVERED" without the event stays in flight, a Scan status that is neither on its way nor delivered with nothing on-chain gives `unknown`, and a Scan error is ignored. Without the log readers, `track()` falls back to Scan alone.
- **Time, notes and gas:** each deployment may carry `measuredDelivery` (the live run of 2026-10-15: 90 s Sepolia → OP Sepolia, 30 s OP Sepolia → Arbitrum Sepolia, from the sending block to the delivery block) and `liveNotes` (Stargate's own executor option on every message — type 3, `lzReceive` gas 150,000 — while the wallet's `extraOptions` stay empty; and the pool fee observed at 0.0001 and 0.0002 ETH, "an observation, not a promise"). The confirmation count reads "1 source-block confirmation" or "2 source-block confirmations". An optional `estimateGas` fills `gasEstimate`.

### 4.3 The differences the user must see

| | CCTP V2 | LayerZero OFT (Stargate on the test networks) |
|---|---|---|
| Who verifies | Circle: two Circle attesters must sign; Circle also issues USDC | The DVNs the token owner configured; on these test networks one LayerZero Labs DVN |
| Who can change that | Circle (attester manager, owner, pausers, denylister; EOAs on the test networks) | The token owner and its delegate at any time; the endpoint owner for every token that uses the defaults |
| Destination step | Someone with gas on the receiving network submits the mint after the attestation | LayerZero's executor delivers; anyone may if it does not |
| Smart account as recipient | Fine (an ERC-20 mint) | Fine for ERC-20 OFTs; Stargate ETH to a deployed smart account waits for a `retryReceiveToken` on the receiving network |
| Assets here | Circle's USDC, all four networks | ETH among Sepolia, Arbitrum Sepolia and OP Sepolia; no route to Base Sepolia |
| Fee | Standard: zero protocol fee, measured live on 2026-10-25 (fee executed 0 in the attested message, `feeCollected` 0, balances and supply exactly ±1,000,000 on both sides); gas on both sides, measured at 0.000000987168000202 ETH (approve + burn, Base Sepolia), 0.000000039697997952 ETH (approve + burn, Ethereum Sepolia), 0.00000308766456 ETH (mint, Arbitrum Sepolia), 0.000000924594000292 ETH (mint, Base Sepolia) | Messaging fee in ETH, measured live at 102,050,140,082,558 wei (Sepolia → OP Sepolia) and 130,249,623,732,558 wei (OP Sepolia → Arbitrum Sepolia) on 2026-10-15; a pool fee of exactly 10^12 wei on the routes that charge one at 0.0001 and 0.0002 ETH (observed, Stargate's fee library not read), none on those two routes; source gas only |
| Time | ~15–19 min documented for Standard (main networks); measured once per route on 2026-10-25: attestation 986–996 s and mint block 996 s after the burn block (Base Sepolia → Arbitrum Sepolia); 1,047–1,057 s and 1,058 s (Ethereum Sepolia → Base Sepolia), the latter within about 21 s of Sepolia's finalized head passing the burn block | Measured once: 90 s Sepolia → OP Sepolia, 30 s OP Sepolia → Arbitrum Sepolia (2026-10-15, sending block to delivery block); other routes not measured; 1 to 5 source confirmations, then delivery |
| Tracking | Iris attestation (statuses `pending_confirmations` then `complete`), then the mint on the receiving network; delivery read on-chain as `usedNonces(nonce)` = 1 | The chains' own events by GUID (`OFTSent` / `PacketSent` on the source, `OFTReceived` or `UnreceivedTokenCached` on the receiving network); Scan only as supporting evidence |
| Refund | None: the burn is final; the attested mint can be completed by anyone at any time | None automatic; a verified message can be executed by anyone; an unverified one stays until the token owner acts |
| Pinning | Complete (seven fixed words) | Complete only because the wallet fixes the layout; the fee can only be capped by a standing rule |
| Off-chain API | Iris (attestation), keyless | None needed for sending; Scan for tracking, keyless |

### 4.4 LayerZero (Stargate) versus CCTP V2 as measured in this wallet

Facts only, each from a live leg run by this wallet's scripts with the engine's own calls (`docs/BRIDGING.md` sections 15.16 and 17) or a read made for it; no recommendation. The two providers moved different assets (native test ETH and Circle's USDC), so the fee and time columns are not a like-for-like price comparison.

| | LayerZero OFT through Stargate V2 (2026-10-15) | Circle CCTP V2, Standard Transfer (2026-10-25) |
|---|---|---|
| Legs run | Ethereum Sepolia → OP Sepolia, OP Sepolia → Arbitrum Sepolia; 0.0002 ETH each; dev EOA to itself | Base Sepolia → Arbitrum Sepolia, Ethereum Sepolia → Base Sepolia; 1 USDC each; dev EOA to itself |
| Asset | Native test ETH; no pool on Base Sepolia | Circle's USDC on all four test networks (twelve routes listed) |
| Source calls | One: `send(SendParam, MessagingFee, refund)`, 452 bytes, value = amount + messaging fee | Two: the exact `approve(TokenMessengerV2, amount)` (68 bytes), then `depositForBurn` (228 bytes), value 0 |
| Pins re-checked live | 14 "equal" words, complete only because the wallet fixes the layout (empty options, compose and command) | 2 + 7 "equal" words; every argument is fixed-size; nothing unpinnable |
| Byte-identical to an independent ethers encoding | Yes, all six routes | Yes, both legs, and the destination mint call (676 bytes) |
| Protocol / messaging fee | 102,050,140,082,558 wei and 130,249,623,732,558 wei of test ETH (executor + DVN fee), paid on top of the amount; no pool fee on those two routes | 0: Standard Transfers are free (Circle's fees page; sandbox fee endpoint; fee executed 0 and `feeCollected` 0 on-chain) |
| Network fees paid by the user | Source only: 313,407 and 257,755 gas | Source approve + burn (Base Sepolia 55,437 + 109,091 gas; Ethereum Sepolia 137,757 + 120,675 gas) **and** the destination mint (154,152 gas on Arbitrum Sepolia, 154,099 on Base Sepolia) |
| Destination step | None: LayerZero Labs' executor delivered (90,155 and 90,145 gas, paid by the executor) | A `receiveMessage` transaction on the receiving network by someone with gas there; this run sent it from the dev EOA. Anyone may send it (destination caller 0); the recipient and amount are fixed by the attested message |
| Time, source block → destination block | 90 s and 30 s | 996 s and 1,058 s (attestation available 986–996 s and 1,047–1,057 s after the burn block) |
| What the time waits for | 2 (Sepolia) or 1 (OP Sepolia) source-block confirmations, then the DVN and the executor; delivered before the source block was safe | Hard finality of the burn block: from Ethereum Sepolia the attestation followed the finalized head within about 21 s |
| Who verifies | One required DVN (LayerZero Labs), read live per route | Two Circle attesters (threshold 2, two enabled), recovered from the attestation and checked against `isEnabledAttester` on the receiving network |
| Replay / tampering | Not tested live | A second `receiveMessage` reverts "Nonce already used" (simulated before, `eth_call` after the mint); a message with one changed byte reverts "Invalid signature: not attester" |
| Off-chain API needed | None to send; LayerZero Scan (keyless) only as supporting evidence for tracking | Circle's Iris sandbox (keyless; `security: []`) to fetch the attestation; without it nothing can be minted |
| Tracking in the adapter | The chains' own events by GUID (`OFTSent`/`PacketSent` → `OFTReceived`) | Iris `complete` → mint call built; delivery read as `usedNonces(nonce)` = 1 on the receiving network |
| Smart-account recipient | Stargate's 2,300-gas native transfer cannot reach a deployed Kernel account (`UnreceivedTokenCached`, a retry needed; seen in simulation in phase 21, not yet live) | An ERC-20 mint; no gas-limited transfer (reasoned from the source; not yet live) |
| Fee asset | Test ETH on the source | Test ETH on both networks (no protocol fee); Circle's USDC paymaster cannot pay for a first mint where the account holds no USDC (`docs/BRIDGING.md` section 4.10) |
| Not covered by the live legs | Bus mode, ERC-20 OFTs, a smart-account sender or recipient, the retry | A smart-account sender or recipient, a session key's CallPolicy, Fast Transfers, the Forwarding Service, OP Sepolia routes |

## 5. What the app supplies

The engine stays pure. The app passes, at construction:

- for CCTP: `fetchAttestation` (one HTTPS GET to Iris, with the app's own timeout and failure wording) and optionally `isMinted` (a destination read);
- for LayerZero: `readContract({chainId, to, data})` for `quoteOFT` and `quoteSend` (through the app's endpoint failover, which the engine does not know about); optionally `fetchMessageStatus` (Scan); optionally, and together, `readSourceReceipt({chainId, txHash})` (the source receipt's status and logs) and `readDestinationLogs({chainId, address, topics})` (`eth_getLogs` semantics on the receiving chain); optionally `estimateGas({chainId, from, to, value, data})`; and, per quote, `nativeSymbol`.

In the app (`app/src/wallet/bridge.ts`, phase 21): `readContract` is `eth_call` on the transport the screen gives for the chain (the user's endpoint for the active network, the screen's endpoint failover around the whole quote); the other networks use `defaultChainTransport`, which walks the profile's built-in default endpoints in order, checks each one's `eth_chainId` once and moves on only for an endpoint failure (`isEndpointFailure`), returning answers such as reverts unchanged; `readSourceReceipt` is `eth_getTransactionReceipt`; `readDestinationLogs` is `eth_getLogs` from the receiving chain's head read at quote time to its current head, in windows of 9,000 blocks and at most 12 windows (older transfers are left to an explorer, with a plain sentence); Scan is a fixed-host HTTPS GET with a 15-second timeout, a 404 read as "not indexed yet", and its status name and destination hash validated; `estimateGas` is supplied for the regular account only (a plain estimate from a smart account's address does not reflect a UserOperation); `nativeSymbol` is the profile's `displaySymbol`.

Each reader's answer is checked by the engine (for example `decodeOftMessagingFee` refuses anything but two words; `decodeOftQuoteOftHead` checks the fee-detail offset), and the attestation and the LayerZero message are in any case verified on-chain at the destination, so a dishonest API can delay or withhold but not redirect funds.

## 6. What the Bridge screen shows

Built in phase 21 (item 1, the in-app slice; `app/src/screens/BridgeScreen.tsx`, `BridgeViews.tsx`, `app/src/wallet/bridge.ts`, pinned by `app/scripts/check-bridge.mjs`). Not yet seen on a device. What it does, and the decisions taken:

- **Every provider, the user chooses.** The form lists the destinations the providers serve from the active test network and, for the chosen destination, every registered provider as a radio row with its label, what it moves, its trust statement verbatim, the fee once quoted ("Get quotes" or Review) and the measured time with the provider's own "not a promise" sentence. A provider that cannot be chosen is still listed, dimmed, with the reason. The wallet never picks one.
- **Circle CCTP is listed but not offered ("coming").** Its live leg (`docs/BRIDGING.md` section 11) has not run in this wallet; it moves USDC while this screen moves the network's own coin; and completing it needs a second transaction on the receiving network after the attestation, which this slice does not build. No CCTP quote is made. On Base Sepolia, where Stargate has no pool, the screen says that nothing can be bridged from there and lists CCTP for comparison.
- **The wallet checks every quote itself** before showing it (`checkBridgeQuote`): the route and amount asked for; every approval exact (above zero, at most the amount, below the unlimited bound, and its calldata saying exactly that), and none at all for a native pool; exactly one bridge call, last, to the pinned Stargate pool of the sending chain, with the OFT send selector; its value exactly the amount plus the quoted messaging fee and equal to its value limit; and the destination endpoint id, recipient, amount, messaging fee and refund address read back from the calldata and from the pins.
- **The existing send paths.** The regular account through `prepareEvmSend` / `sendEvm` (the eth_call pre-flight, the balance check, the OP-stack layer 1 fee lines) and the smart account through `prepareAaCalls` / `sendAa` (one call as one operation, the bundler's fee-floor check before the prompt), both with the balance-change preview, the risk card and the spending limits, and one device prompt titled "Bridge <amount> test ETH to <network> through <provider>" (with "from your smart account" on that path). The confirm adds the fee lines in the network's symbol, the total leaving the account, the measured time, the trust card, the destination step, the approval line, the pinned fields in plain words, and a line naming the pinned Stargate pool (the risk card does not know the pools by name; teaching `risk.ts` them is a follow-up).
- **The recipient is always the regular account**, also when the smart account sends: Stargate hands ETH over with a 2,300-gas transfer, which a deployed Kernel account cannot accept (`UnreceivedTokenCached`), so the screen says before Review that the ETH arrives at the regular address and why. For an account upgraded with EIP-7702 the two are one address, and the screen says so instead. When the regular address has code on the receiving network, the confirm warns.
- **Tracking while the screen is open:** every 15 seconds through `track()` with the on-chain readers, the adapter's sentence shown verbatim under a heading per state. When Stargate cached the transfer, the panel offers the `retryReceiveToken` call (checked: one call, to the receiving network's pinned pool, value 0, the retry selector), sent from the regular account through `prepareEvmSend` once the receiving network is the active one.
- **Records are stored on the phone, per wallet** (since the phase 21 storage-seam follow-up): `shiba-wallet.bridge-transfers.v1`, a per-wallet key of the storage seam (`app/src/wallet/store-keys.ts`), keeps the newest 64 transfers with what was sent and, once known, the final status (delivered or failed); a status that is not final is not stored and the screen asks again. The document is parsed strictly: a damaged one is read-only (the valid records are listed, nothing is written, "Reset the transfer list" clears it), as for the pending-transaction registry. The sending transaction itself is recorded by the existing pending-transactions registry (a smart-account bridge operation as kind `bridge`), so Speed up and Cancel cover a stuck bridge send.

The section's original plan, kept for the parts not yet built (the CCTP card in full, the Activity sentence, the risk-card names). For the route and asset the user picks, one card per provider that serves it, each with:

1. the provider label and its **trust statement verbatim** (who verifies, who controls, the refund rule), plus the route-specific verifier sentence from the quote notes (for LayerZero, read from the chain for that pathway, not assumed);
2. every fee line with its asset and whether it comes out of the amount, the amount expected to arrive and the minimum written into the call;
3. the time estimate with its source, including "not measured on test networks";
4. "Exact approval only: this allows <spender> to take exactly <amount> <token>, nothing more" when an approval is needed;
5. the destination step in plain words (CCTP: "after Circle attests, a second transaction on <network> completes the transfer; you or anyone can send it"; LayerZero: "delivered automatically by LayerZero Labs' executor");
6. the notes (the paymaster first-arrival limit for CCTP; the Stargate smart-account caveat; the public test pause key).

The confirm screen then reuses the existing send paths: the regular account through `prepareEvmSend`, the smart account through `prepareAaCalls` (a batch of approve + bridge), with the existing preview, risk card and pre-flight. The risk card should name the pinned bridge contracts the way it names Lido's (phase 18), and the Activity sentence should read "Bridged … to <network> with <provider>".

## 7. Readiness

Built as ONE row, `bridge` (`testnet-only`, enforced in `app/src/wallet/bridge.ts` before any request and by the screen's gate), rather than the two proposed below, because only one provider can be chosen for sending today; its reason names the single LayerZero Labs verifier, the public pause key of Stargate's test pools and Circle's two attesters, and says the wallet has not yet sent a CCTP transfer. The original proposal, for when CCTP is offered:

- `bridging-cctp`, reason as in `docs/BRIDGING.md` section 4.12;
- `bridging-layerzero`, reason as in section 15.14.

Main networks need: every main-network address read on-chain on each chain; for LayerZero, each OFT's own DVN configuration read and shown (main-network defaults were not read); the audit coverage checked against deployed bytecode; and the general conditions C1–C3 (`docs/THREAT_MODEL.md` section 7, `docs/MAINNET_READINESS.md`).

## 8. Threat-model rows to add when the screen lands

Proposed for `docs/THREAT_MODEL.md`; added there as T-80 to T-87 (in this order) with the open items in F-80 (phase 21):

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

Built (engine, offline): the types, the registry, `exactApprovalCall`, the CCTP V2 encoder, pins and provider (Standard Transfers), the LayerZero OFT encoders (`send`, `quoteSend`, `quoteOFT`), decoders, layout, pins and provider, the verified tables (`CCTP_V2_TESTNET*`, `LAYERZERO_V2_TESTNET`, `STARGATE_V2_TESTNET_NATIVE_POOLS`), and, after the adapter follow-ups, 40 tests in `packages/chains-evm/test/bridge.test.ts` (registry, byte-identical encoders against ethers, pins checked against the calldata and against the wallet's CallPolicy mirror, refusals, tracking from Scan and from the chains' events, the retry call, measured times, the native symbol, the gas estimate).

Proven live by script: two native-ETH legs through Stargate on the LayerZero adapter (`docs/BRIDGING.md` section 15.16), and two 1-USDC Standard Transfers on the CCTP V2 adapter, Base Sepolia → Arbitrum Sepolia and Ethereum Sepolia → Base Sepolia (`scripts/testnet/cctp-smoke.mjs`, `docs/BRIDGING.md` section 17).

Built in the app (offline, phase 21): the readers, the readiness row `bridge`, the Bridge screen with the provider choice and the tracking panel (section 6), pinned by `app/scripts/check-bridge.mjs`.

Next, in order: the Bridge screen on the emulator; the persistent transfer records; a CCTP send path in the app with its mint (the script leg of section 11 is done); a smart-account recipient and the retry live; the risk-card and Activity wording; and the threat-model rows above.

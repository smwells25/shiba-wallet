# Mainnet readiness: a decision memo for the Chairperson

**Status:** First edition, dated 2026-10-11, written for the phase 19 leadership refresh. It draws only on what is already recorded in `AGENTS.md`, `docs/THREAT_MODEL.md` (section 5, the mainnet-readiness checklist), `docs/FEATURE_UNIVERSE.md` (section 15, implementation status) and `docs/AA_FRAMEWORKS.md` (section 17.2, the smart-account conditions). It restates no exploit detail and is safe for the public repository. **Updated 2026-10-18** for the phase 21 refresh (bridging, the app PIN and duress PIN, stuck transactions) and **2026-10-20** for the phase 22 refresh (the native scrypt for the PIN, the records backup, cold signing, deep links, the inbox, the audit scoping document); the conclusions are unchanged.

**Audience:** leadership deciding whether, and in what form, the wallet may hold real funds on an Ethereum mainnet (or mainnet layer 2) profile. Today the wallet offers no mainnet profile for sending: every write path is on a test network, and the readiness switchboard (`app/src/config/readiness.ts`) enforces that for every smart-account feature.

## The recommendation, in one line

**Do not offer any mainnet profile for smart-account features until the three smart-account conditions (C1 audit, C2 bug bounty, C3 support horizon) are met, every mainnet contract address the wallet would use has been verified on-chain, and the one high-severity disclosure finding has been closed out.** The plain-account features (sending ETH and tokens, NFTs, swaps through a connected dApp, Dogecoin) are closer, but they still wait on real-phone checks and their own inputs and are not cleared today either. A staged path is set out at the end.

## 1. What already works on mainnet, safely, today

Reading mainnet is fine and is already done: Ethereum mainnet balances, token balances and fiat prices are read-only, and the app shows them. Nothing about reads needs the conditions below. The gap is entirely on the **write** side — signing and broadcasting transactions, and installing or operating smart accounts — where real value is at stake.

## 2. Which contract addresses are pinned for mainnet, and which are testnet-only

This is the most concrete gap. Everything the wallet's write paths depend on has been verified on-chain **on test networks only**. Before a mainnet profile, each address a mainnet path would touch must be verified on-chain the same way it was on the test networks, and most are not even pinned yet.

- **The Kernel v3.3 smart-account stack** (the account factory, the meta-factory, the implementation, the ECDSA validator, the permission/session/guardian modules, the recovery action and the WebAuthn validator the wallet pins): verified on-chain on Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia and OP Sepolia, where the code is byte-identical apart from a cached chain-id word. The **mainnet** deployment was read on-chain on 2026-10-01 (`docs/AA_STACK.md`) and again on 2026-10-25 by `scripts/audit/verify-pins.mjs` (`docs/AUDIT_SCOPE.md` section 5.7: `verifyKernelDeployment` passes on mainnet, the meta factory is staked, and every module is byte-identical to the test networks apart from the implementation's and the weighted validator's cached chain-id bytes); the smart-account conditions C1–C3 remain unmet, so all of it is testnet-only.
- **The weighted validator used for multi-signature accounts** (`0xeD89…eEEE`): verified on the four test networks. Mainnet is not verified, and the account's known message-signing limitation (see section 7) would have to be an accepted leadership decision before mainnet.
- **Circle's ERC-20 "pay gas in USDC" paymaster:** its **testnet** addresses are verified on-chain (Base Sepolia, Arbitrum Sepolia). Its **mainnet** addresses are taken from Circle's documentation and have **not** been verified on-chain. The paymaster has no published audit, is GPL-3.0 code behind an upgradeable proxy that Circle controls, and on test networks uses a fixed-price oracle with no staleness check; its documented surcharge read as zero on-chain on the test networks. These are reasons for caution on mainnet, not just missing verification.
- **Pimlico's ERC-20 paymaster** (the second gas-in-token source): its singleton is source-verified on several chains including Ethereum mainnet, but it is a **permissioned** service that requires an API key on mainnet, was unstaked on at least one test network, and the singleton itself has no audit the record could find.
- **Uniswap v3, used for dollar-cost averaging (DCA):** only the **Sepolia** router, factory, quoter and pool are pinned; the pinned pool is not even source-verified and is re-checked against Uniswap's factory on every read. Mainnet would need different, verified addresses, and DCA is deliberately Ethereum Sepolia only today.
- **Lido and Rocket Pool staking:** only **test-network** addresses are pinned (Lido on Sepolia and Hoodi, Rocket Pool on Hoodi). No mainnet staking addresses are pinned, and the Sepolia Lido deployment is deprecated and pays nothing.
- **LayerZero and Stargate V2, used for bridging (phase 21):** only **test-network** addresses are pinned: LayerZero's EndpointV2 and Stargate's native ETH pools on Ethereum Sepolia, OP Sepolia and Arbitrum Sepolia (Stargate has no pool on Base Sepolia). Their facts were read on-chain on 2026-10-15 and are test-network facts: every test pathway relies on one required verifier operated by LayerZero Labs, and the test pools can be paused by a key whose private part is public. No mainnet bridge address is pinned or verified, and the mainnet verifier configuration has not been read. **Circle CCTP V2**: Standard Transfers were proven live by script on two test-network routes on 2026-10-25 (Base Sepolia → Arbitrum Sepolia and Ethereum Sepolia → Base Sepolia, `docs/BRIDGING.md` section 17), and since commit `0a5bc7f` the app's Bridge screen offers USDC through it, though no CCTP transfer has yet been sent through the app (an emulator pass is pending). Only test-network addresses are pinned; its test-network contracts were read on-chain, and of mainnet only the Ethereum mainnet contracts were read, for their admin roles.
- **ENS wallet handles (phase 23 item 6):** only the **Sepolia** ENSv2 contracts are pinned (`packages/chains-evm/src/ens-register.ts`, from ENS's contracts-v2 at 07e55a05; re-read by `scripts/audit/verify-pins.mjs`), and ENSv2 has not launched on Ethereum mainnet; no ENSv1 registration path was built, so the wallet can register a name on Sepolia only. The Universal Resolver read that shows a primary name on Home and Receive runs on mainnet too, read-only.
- **Known token addresses (USDC, EURC):** the pinned "known token" addresses are the **test-network** contracts; mainnet USDC is used for display only.

## 3. The smart-account conditions C1–C3 (none met)

From `docs/AA_FRAMEWORKS.md` section 17.2 and `docs/THREAT_MODEL.md` section 5.1:

- **C1 — Audit.** An independent audit covering the exact Kernel v3.3 shipped, its EIP-7702 changes, and **every** module the wallet installs: the permission policies and ECDSA signer, the weighted validator and recovery action, and the WebAuthn validator. **Unmet.** The next step is written: `docs/AUDIT_SCOPE.md` (phase 22 item 1) is the scope to hand an outside firm, with a bug-bounty proposal. It notes that C1 and C2 concern the vendor's contracts, so an audit of the wallet's own code alone would not meet C1; its section 9.2 gives the options (extend the engagement to the Kernel changes and the modules, obtain the vendor's reports, or defer). The firm, the budget, the C1 scope option and the tagged commit the auditor receives are the Chairperson's inputs; nothing has been engaged.
- **C2 — Bug bounty.** A written answer on bug-bounty coverage for Kernel from the vendor (ZeroDev or Offchain Labs). **Unmet.**
- **C3 — Support horizon.** A stated support horizon for v3 and a v3-to-v4 migration statement. **Unmet.**

No item in 5.1 is met, so the switchboard keeps every smart-account feature (smart-account sends, counterfactual deployment, batching, EIP-7702 upgrades, session keys, guardians, passkeys, paymasters and the gas-in-token flow, multi-signature accounts, inheritance, recurring payments, DCA and staking) test-networks-only, enforced in the app with no override. Bridging (phase 21) is also test-networks-only and enforced, although it can run from the regular account, because its providers' test-network trust (above) says nothing about mainnet.

## 4. The wallet's own conditions (the real-phone checks are the binding ones)

The plain-account features do not depend on C1–C3, but they are blocked today by the wallet's own conditions (`docs/THREAT_MODEL.md` section 5.2). The binding ones that only a real phone can clear:

- **W2 — a development build on a real iPhone and a real Android phone**, with the biometric prompts on seed reveal, send and unlock. Unmet; the work has been done only on the Android emulator and in a local development build on that emulator.
- **W3 — Secure Enclave / StrongBox behaviour of the secure store confirmed on a device.** Unverified (the emulator's keystore is software-only).
- **W4 — a store build confirmed free of the development menu, LogBox and Metro, with screenshot blocking working in a release build.** Unverified.

Other open conditions that matter for specific features: W5 (app identifiers, store listing and privacy disclosures — needs an Expo account and the bundle/package ids), W7 (a live 0x quote before swaps ship — needs a 0x key), W8 (live paymaster sponsorship — needs an endpoint), W13 (a decision on a second-provider cross-check or an explicit acceptance of single-provider simulation), W16 (counsel's answer on the (L)GPL/AGPL contract licences), and W17–W20 (the lock overlay over native modals, the Android backup policy on a real device, screenshot behaviour on iOS, and Expo SDK dependency sync). Several conditions have been met (W6 the one real Dogecoin broadcast, W9 the enforced switchboard, W10 CI, W15 the in-app owner change) and three are partly met (W1 opt-in protected storage, W11 permit decoding, W12 the dApp identity signal), but none of the gating set for plain-account features reads "Met", so the switchboard correctly lists every plain-account feature as blocked (advisory). One row is the exception, by design: the **app PIN and duress PIN** (`duress-pin`, phase 21) is marked allowed on every network, advisory, because it moves no funds and cites no checklist item. That does not make it ready. Its hashing cost is settled for the emulator: on the Chairperson's decision of 2026-10-19 the PIN is hashed with a native scrypt (`react-native-quick-crypto`, N kept at 2^16), and on the Android emulator one unlock took about 2.5 seconds in both the debug and the release development builds, against about 100 seconds in the release build with the JavaScript scrypt (`docs/THREAT_MODEL.md` F-81; `AGENTS.md` phase 22, "EMULATOR PASS p22a"). Expo Go keeps the slow JavaScript scrypt, so the PIN is usable only in the wallet's own builds. It has not run on a real phone, and the lock passphrase that can replace the PIN (phase 22) is verified offline only.

Four phase 22 features have no readiness row of their own, each for a stated reason; their limits matter for any mainnet profile:

- **Cold signing (sending from a watched address through an off-line signer)** is an ordinary regular-account transaction, offered wherever Send is, like Speed up. It was proven on Ethereum Sepolia through the app (2026-10-20 UTC) with the project's own signing script standing in for the off-line device. It covers regular accounts only (native and ERC-20 sends; smart accounts are not offered), and its QR format is the wallet's own rather than EIP-4527, so no hardware wallet can sign it yet; a mainnet profile would need a real off-line signer that decodes the request itself.
- **The records backup** moves no funds: one file of the wallet's records (contacts, notes, networks, tracked tokens, recovery and multisig records, bridge transfers, alerts, limits), encrypted under a key derived from the recovery phrase, never holding a key. It was exercised in Expo Go on the emulator; a saved file and a restore onto a second phone have not been seen.
- **Deep links** open only an allow list of the wallet's screens or a Send screen pre-filled from a payment request for review; they never sign or switch networks. They were exercised only in Expo Go's own link form: `app/app.json` declares no URL scheme yet, so whether to add `shibawallet://` (which any Android app could also claim, unless verified App Links on a domain are set up) is a decision for the Chairperson before any build ships.
- **The inbox** keeps on the phone the notices the wallet already showed; it was exercised in Expo Go.

**iOS has never been built.** Every observation in this memo is from Android (the emulator, Expo Go and local Android builds). Xcode 26.5 is installed on the development Mac, with no iOS runtime or CocoaPods yet; the first iOS Simulator build is proposed as phase 23 item 3 and would be the first evidence for the iOS half of every condition above.

## 5. The third-party disclosure findings

An independent, CVE-style (NIST NVD) security review of the third-party contracts the wallet relies on has been carried out. Its full classification lives in the **git-ignored `docs/private/`** directory and is deliberately kept out of the public repository; a public, non-exploitable summary of the same findings is in `docs/DISCLOSURE_FINDINGS.md`.

For this memo it is enough to record that:

- A private classification exists, and the Chairperson has reviewed it and decided to proceed with the prototype on test networks.
- Of the classified findings, exactly **one** is scored high severity, and the **Chairperson is handling that item personally**; the rest were assessed as low enough to revisit later, with their determinations recorded in the private review.
- The one high-severity item concerns an **older version of a third-party component that the wallet does not install**: the wallet's own code pins the **patched** version, so the wallet's own users are not exposed to it.
- **No disclosure has been sent** to any vendor, and none will be without a further explicit decision by the Chairperson.

Before any mainnet profile, this item must be closed out: either the Chairperson's investigation concludes it does not bear on the wallet's mainnet posture, or a mitigation and (if decided) a vendor disclosure are in place. The lower-severity findings should be re-confirmed against the deployed mainnet contracts at the same time, because the live checks recorded so far were made against test-network state.

## 6. Fee economics are different on mainnet (and not yet measured there)

Every fee observation in the record is from test networks, where the economics are misleading:

- On Sepolia the base fee is about 14 wei, so the price actually paid equals the quoted priority fee, and the wallet's 100% headroom over the bundler's fee floor is paid in full. On mainnet the base fee dominates the price, so the headroom's real cost is different and must be re-measured, and a gas-margin policy decided, before mainnet.
- Smart-account operations are far dearer than plain sends: on Sepolia the bundler's price was roughly two thousand times the network base fee, so a smart-account action can cost many times the amount it moves at tiny test amounts.
- The Glamsterdam fork on Sepolia raised the cost of installing a Kernel permission (sessions, subscriptions, recurring payments, DCA, guardians) by three to four times. The DCA set-up now costs on the order of 0.016 test ETH, and the bundler needs still more balance just to estimate it. How these costs land on mainnet is unverified.

## 7. Known module limitations that would need conscious acceptance

These are disclosed honestly on every relevant screen on the test networks today. On mainnet each would be a leadership decision to accept, not a silent default:

- **Multi-signature accounts cannot sign messages, logins or token permits** — the deployed validator's message check is weaker than its transaction check — so the wallet refuses message signing for them entirely.
- **Inheritance, on today's contracts, is a demonstration only:** an heir can sign as the account (and so move tokens through permits) from the moment it is added, not after the delay, and there is no reliable check-in. The feature as a user would expect it is not achievable with these modules.
- **Guardians can sign as the account immediately**, and a single guardian can satisfy a 2-of-2 in message signing; recovery is on-chain but the modules are unaudited.
- **The gas-in-token paymasters** are a trust decision: Circle's is unaudited, upgradeable and Circle-controlled; Pimlico's is permissioned and keyed on mainnet.
- **Bridging trusts the provider while the coins are in flight:** on the test networks that is one LayerZero Labs verifier and pools pausable with a public key; a mainnet bridge would need its own verifier configuration read and accepted.
- **The duress wallet protects only against someone looking at the screen:** anyone who copies the app's files can tell that two wallets exist and can guess a 6-digit PIN offline, and funding the second wallet from the first links them on-chain.
- **DCA's minimum does not follow the market**, there is no deadline, and the deployed policy cannot enforce a fair price; the pinned pool is re-checked on every read but is not source-verified.

## 8. What must happen before any mainnet profile, and a staged path

**For any mainnet smart-account feature, all of:**

1. **C1** — an independent audit of the deployed Kernel v3.3 and every module the wallet installs.
2. **C2** — a written bug-bounty answer from the vendor.
3. **C3** — a support-horizon and migration statement.
4. **On-chain verification** of every mainnet address a mainnet smart-account path would use (the Kernel stack, the weighted validator, any paymaster, any swap router), to the same standard applied on the test networks — most are not yet pinned.
5. **The high-severity disclosure item closed out** (section 5), and the lower-severity findings re-confirmed against mainnet contracts.
6. **Mainnet fee economics measured** and a gas-margin policy set (section 6).
7. **Each honest limitation in section 7 explicitly accepted** by leadership for the features that would ship.

**For any mainnet plain-account feature, all of:** W2–W4 (the real-phone build and the on-device biometric, secure-store and release-build checks), plus the feature's own inputs (for example a 0x key for swaps, W7) and the remaining gating conditions in section 4.

**A sensible staged path:**

- **Stage 0 (today):** mainnet reads only; every write on test networks; the switchboard enforcing it. This is where the prototype is, and it is the right place until the checks below are done.
- **Stage 1:** after a real-phone development build clears W2–W4 and the per-feature inputs, consider clearing the **plain-account** features (ETH and token sends, NFTs, Dogecoin, and swaps once a 0x key exists) on mainnet, one at a time, each still advisory in the switchboard until its conditions read "Met". Speeding up and cancelling a stuck send (proven through the app on Ethereum Sepolia on 2026-10-18) goes with Send: a replacement is an ordinary regular-account transaction and has no readiness row of its own, but its fee rules have been seen only on test-network nodes.
- **The app PIN and duress PIN** can join Stage 1 only after the native PIN hashing (decided and measured on the emulator, F-81) is measured on real phones, the PIN screens pass the W2 checks and iOS has been built; until then it should stay off by default, as it is.
- **Cold signing, the records backup, deep links and the inbox** go with Stage 1 as plain-account features: cold signing with Send, once a real off-line signer (not the project's script) has been used; deep links only after the URL-scheme decision; the records backup once a saved file has been restored on a second phone.
- **Bridging** belongs with Stage 2 in practice: before any mainnet route, pin and verify the provider's mainnet addresses, read and accept its verifier configuration, and send a smart-account bridge and a stranded-transfer retry on a test network (neither has been seen live).
- **Stage 2:** hold **all** smart-account and account-abstraction features off mainnet until C1–C3, the on-chain address verification and the disclosure close-out are complete. Only then enable them on mainnet, feature by feature, with the section 7 limitations accepted in writing.

The engineering for these features is proven on test networks; what stands between here and mainnet is not more code but the audit (scoped in `docs/AUDIT_SCOPE.md`, waiting on the Chairperson's choice of firm, budget and C1 scope), the real-phone verification, the first iOS build, the address checks, the one security item the Chairperson is handling, and the fee, limitation and URL-scheme decisions above.

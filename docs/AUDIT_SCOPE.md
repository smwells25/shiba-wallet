# Security audit scope: the Shiba Wallet prototype

**Status:** First edition, dated 2026-10-19, written for phase 22 item 1 at repository commit `64d2a51` on the `main` branch of `https://github.com/smwells25/shiba-wallet`. Updated 2026-10-25 for phase 23 item 1: the address tables of section 5 are now checked by a script (section 5.7), with the corrections that check produced, and the bug-bounty proposal (section 8) has its full structure with named placeholders. Every fact in this document is taken from the repository's own code or documents and cites its path. Where the repository does not record something, this document says "not recorded" instead of guessing.

**Audience:** independent security auditors engaged (or being considered) by the project's Chairperson, and the Chairperson when deciding on the engagement. The reader is assumed to know Ethereum, ERC-4337 and mobile key storage, but not to have followed the project.

**What this document is not:** it is not a security assessment. It describes what exists, what we want reviewed, what we already know is weak, and what we have not been able to check.

---

## Summary for the auditors' first reading

**The product.** Shiba Wallet (working title) is a non-custodial mobile cryptocurrency wallet: keys are created and used only on the user's phone, and no server ever sees key material. One BIP-39 recovery phrase derives every key the wallet uses, on Ethereum-compatible (EVM) networks, Bitcoin, Dogecoin and Solana. Its defining feature is account abstraction on EVM networks (ERC-4337 smart accounts on ZeroDev's Kernel v3.3, EIP-7702 upgrades of ordinary addresses, session keys, guardians, passkeys, multi-signature accounts, paymasters), and today every one of those account-abstraction features is restricted, in code, to test networks.

**Why an audit now.** The mainnet-readiness checklist (`docs/THREAT_MODEL.md` section 5.1) requires audit coverage (C1) and bug-bounty coverage (C2), among others, before any smart-account feature may touch real funds; none is met. This document scopes an audit of the wallet's own code, optionally extended to the smart-account contracts it relies on, and proposes the wallet's own bounty programme.

**What you receive.** The repository at a tagged commit, the design and evidence documents, an offline test runner (about 1,046 engine tests and 59 application suites with about 9,300 checks, network access blocked), test-network smoke scripts for your own funded test wallet, and an emulator procedure (section 2). You receive none of the project's keys, API keys, project identifiers or development wallet.

**In scope.** The five TypeScript engine packages under `packages/` (derivation, signing, transaction and UserOperation construction, smart accounts, session-key policies, guardians, passkeys, multisig, paymasters, bridges, staking, simulation) and the security-relevant parts of the Expo / React Native app under `app/src` (key vault, storage seam, app PIN and duress profile, lock, approval gates, send and replacement paths, spending limits, risk checks, the in-app browser bridge, WalletConnect handling). Section 3 lists the files.

**Out of scope by default.** The third-party contracts the wallet pins (Kernel v3.3 and its modules, the EntryPoint, Circle's and Pimlico's paymasters, Uniswap, Lido, Rocket Pool, LayerZero and Stargate), the bundler and RPC providers, and the Expo / React Native platform. The wallet's *statements* about those contracts (what it tells the user about their trust and limits) are in scope. Section 4 explains, and section 9 lists the option of extending the scope to the Kernel modules.

**Where to start.** Section 6 lists the open findings and honest limits we already know of; section 7 lists the ten questions we most want answered, in priority order. The single most important property to challenge is that no code path can sign without the user's approval of exactly what is shown, and that nothing a network service returns can change what is signed.

**Constraints you should know.** Nothing has run on a physical phone; all device validation is on the Android emulator (Expo Go and locally built development and release builds). iOS has run only in the Simulator, once, in a debug development build on a throwaway wallet (phase 23 item 3). The repository is public.

---

## 1. Purpose and the two conditions it serves

### 1.1 The conditions

`docs/THREAT_MODEL.md` section 5.1 (carried over from `docs/AA_FRAMEWORKS.md` section 17.2) states three conditions on the smart-account stack. All three read "Unmet" at the time of writing.

| Id | Condition, as the checklist words it | What this document does about it |
|---|---|---|
| C1 | "Audit coverage for the exact Kernel version shipped (v3.3), its EIP-7702 changes, and every module the wallet installs: permission policies and ECDSASigner, WeightedECDSAValidator v3 port and RecoveryAction, WebAuthnValidator v0.0.3" | Scopes an audit of the wallet's own code (sections 3 and 7). C1 as written concerns the third-party contracts, which this scope leaves out by default; section 9.2 sets out the options for covering them (an extension of this engagement, a review of the v3.1-to-v3.3 difference that `docs/AA_FRAMEWORKS.md` section 17.2 already suggests, or reports obtained from the vendor). An audit of the wallet's code alone does not meet C1 as worded. |
| C2 | "Written answer on bug-bounty coverage for Kernel (ZeroDev or Offchain Labs)" | C2 asks for the vendor's bounty, which the project cannot create. Section 8 proposes the wallet's own programme, which covers the wallet's code and complements, but does not replace, a vendor answer. |
| C3 | "Support horizon for v3 and a v3-to-v4 migration statement" | Not addressed here; it needs a vendor statement. |

The wallet's own conditions (W1 to W20, `docs/THREAT_MODEL.md` section 5.2) are separate. Several of them (W2 to W4: real-phone builds, hardware-backed storage, release-build behaviour) cannot be cleared by an audit and are listed in section 6.4 so that the auditor knows which properties have never been observed.

### 1.2 The product in three sentences

The wallet is non-custodial: keys are generated, stored and used only on the user's phone, in the platform's secure storage, and no service ever receives key material (`AGENTS.md`, "Project objective"). A single BIP-39 recovery phrase derives every key on every chain, including the owner key of every smart account, so one written backup restores everything except the documented exceptions (imported private keys, session keys) (`docs/ARCHITECTURE.md` section 7, decisions D1 and D9). The wallet's distinguishing feature is account abstraction on EVM networks, built on ZeroDev's Kernel v3.3 with EntryPoint v0.7 and EIP-7702, and proven so far only on public test networks (Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia and Hoodi).

---

## 2. What the auditor receives

### 2.1 The repository at a tagged commit

The repository is public at `https://github.com/smwells25/shiba-wallet`. It has no tags yet. Before the engagement starts, the Chairperson (or the project's lead engineer on the Chairperson's instruction) creates an annotated tag on the commit to be audited and gives the auditor the tag name **and** the full 40-character commit hash, for example:

```sh
git tag -a audit-1 <full-commit-hash> -m "Commit handed to the auditors"
git push origin audit-1
```

The auditor checks out the hash, confirms `git rev-parse HEAD`, and cites paths and line numbers at that commit. Phase 22 is still changing code (for example the PIN hashing, `AGENTS.md` "Phase 22 plan" item 2), so the commit chosen decides which version is reviewed.

### 2.2 Documents to read first

All are in `docs/` unless stated. They are written in plain English for readers who were not present.

| Document | What it gives the auditor |
|---|---|
| `docs/THREAT_MODEL.md` | The threat model: assets, trust boundaries, every threat (T-rows) and finding (F- and N-rows) with its evidence, the mainnet-readiness checklist (C1–C3, W1–W20), and reproduction guidance (section 7). The primary reference for this engagement. |
| `docs/MAINNET_READINESS.md` | The decision memo on what stands between the prototype and real funds; which contract addresses are pinned for mainnet and which are test-network only. |
| `docs/ARCHITECTURE.md` | The system design; section 7 holds the architecture decision records D1 to D9 (one phrase roots everything, the pure-TypeScript engine, chain adapters, counterfactual accounts, vendor-neutral bundlers, ERC-7579 modules, cryptography and key storage, account indices, imported keys). |
| `docs/AA_STACK.md` | The EntryPoint and Kernel v3.3 addresses, the release commit pinned, and the on-chain verification procedure. |
| `docs/AA_FRAMEWORKS.md` | Why Kernel was chosen, the audit and bounty landscape for smart-account frameworks, conditions C1–C3 (section 17.2). |
| `docs/DISCLOSURE_FINDINGS.md` | The public evidence record of seven findings about third-party contracts (items A to G) and related observations, each with how it was established and what would refute it. |
| `docs/SESSION_KEYS.md`, `docs/SCHEDULED_PAYMENTS.md` | Session-key design and the limits of the deployed policies; recurring payments and dollar-cost averaging. |
| `docs/MULTISIG.md` | Multi-signature accounts on the deployed weighted validator, including the proof that it cannot give an honest threshold for message signatures. |
| `docs/DURESS_WALLET.md` | The app PIN, the duress PIN and the decoy wallet, the storage seam, and what can honestly be claimed for them. |
| `docs/BRIDGING.md`, `docs/BRIDGE_PROVIDERS.md` | Bridge provider research (Circle CCTP V2, LayerZero / Stargate V2 and others) and the provider adapter design. |
| `docs/STAKING.md` | Lido and Rocket Pool on test networks. |
| `docs/DAPP_BROWSER.md` | The in-app browser design and the unsafe library defaults it works around. |
| `docs/DEVICE_BUILDS.md`, `docs/RELEASE.md`, `docs/PRIVACY.md` | Device and release builds, the merged Android manifest, the privacy facts. |
| `docs/CONTRIBUTING.md` | How to install, run the tests and use the secret scan. |
| `docs/DEMO.md` | A step-by-step walkthrough of the features on the Android emulator. |
| `docs/FEATURE_UNIVERSE.md` section 15 | The implementation status of all 99 features (proven live, built, designed, not started). |
| `AGENTS.md` and `docs/HISTORY.md` | The project's running record. Every live transaction, emulator pass and fix is recorded there with hashes; use it to trace a claim, not as an introduction. |

`docs/private/` is git-ignored and is not part of the repository. A private classification of the third-party findings exists and is shared at the Chairperson's discretion (section 9).

### 2.3 The test suites, run offline

From `docs/CONTRIBUTING.md` and `scripts/ci/run.mjs`. Use Node.js 24 (the team uses 24.21.0):

```sh
npm ci
(cd app && npm ci)
npm test              # everything, offline
npm run secret-scan   # the secret scan over the committed tree
```

`npm test` builds the engine and runs, in order: the engine's vitest suites across the five packages; every offline application suite under `app/scripts/`; `expo lint` with zero warnings allowed; the app's `tsc --noEmit`; and an Android bundle export as a smoke test. Partial runs: `npm run test:engine`, `test:app`, `lint`, `typecheck`, `bundle`. The most recent counts recorded at the time of writing are 1,046 engine tests and 59 application suites with 9,297 checks (`docs/THREAT_MODEL.md` section 7.4, a run at commit `fbbdea9`); the auditor should take the counts printed at the audited commit as authoritative.

Three properties of the runner matter to an auditor:

- **The offline guard.** `scripts/ci/offline-guard.mjs` is preloaded into every child process. It refuses every network connection except loopback and makes the git-ignored `.dev-wallet/` directory look absent. A step that attempts any network connection fails even if the suite tolerated the refusal, so "green offline" means "made no network request".
- **No unclassified suite.** Every script in `app/scripts/` must be classified in `scripts/ci/suites.mjs` (offline, flag-live, env-live, live or helper); the runner refuses to start otherwise, so a suite cannot silently miss CI.
- **The check scripts are executable specifications.** Each `app/scripts/check-*.mjs` file runs the app's real modules under Node against fakes (RPC nodes, secure storage, bundlers) and pins exact behaviour, often including user-facing sentences, the order of operations and mutation tests (a deliberately broken copy the suite must fail).

`npm run test:live` adds read-only requests to public endpoints and is for developer machines only.

**The secret scan.** `scripts/githooks/secret-scan.mjs` runs as a pre-commit hook (enabled per clone with `npm run hooks:install`) and in CI over the whole tree; its rules and allow-list are documented in `docs/CONTRIBUTING.md`. Run it on named files with `--files <path>...`.

### 2.4 The smoke scripts under `scripts/testnet`

These scripts exercise the engine against real test networks and real bundlers (`docs/THREAT_MODEL.md` section 7.5 describes the earlier ones; later ones include `multisig-smoke.mjs`, `dca-smoke.mjs`, `staking-smoke.mjs` and `bridge-smoke.mjs`). Most have a dry-run mode that simulates read-only with the published BIP-39 test mnemonic and needs no funds.

For live runs the auditor needs:

- **Their own development wallet.** `node scripts/testnet/setup.mjs` creates a new phrase in `.dev-wallet/mnemonic.txt` (git-ignored) in the auditor's own clone and prints the addresses to fund. The project will never hand over its own `.dev-wallet/`.
- **Test funds** on the networks they want to exercise (Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia or Hoodi test ETH; Circle test USDC for the token-fee and bridge scripts). Whether the project funds the auditors from its development account is a decision for the Chairperson (section 9).
- **Their own service endpoints** where a script needs one: an ERC-4337 bundler URL (the project tested with ZeroDev, which needs a project identifier the auditor obtains themselves), and optionally an RPC node URL. The scripts read these from environment variables such as `BUNDLER_URL`, `NODE_URL` and `ZERODEV_PROJECT_ID`, or from the auditor's own `.dev-wallet/env`.

`scripts/testnet/doge-mainnet-demo.mjs` is the one script that can spend real (mainnet) Dogecoin. It runs as a dry run by default and needs an explicit environment variable plus typing the transaction id to broadcast (`docs/THREAT_MODEL.md` section 7.5). Auditors should not need it.

### 2.5 The emulator route

The app is validated on the Android emulator in Expo Go and in a locally built development build (no Expo account is needed for a local build). `docs/DEVICE_BUILDS.md` describes the builds and what each can and cannot show; `docs/DEMO.md` is a walkthrough of every feature with the expected screens. The project's own emulator image is not shared: its wallet's phrase is written nowhere. An auditor should create a fresh emulator and a fresh wallet. Some properties (hardware-backed key storage, Face ID, iOS behaviour) cannot be observed on an emulator at all (section 6.4).

---

## 3. Scope

The scope is the wallet's own code at the tagged commit: everything under `packages/*/src` and the security-relevant files under `app/src`. Within that, sections 3.1 to 3.3 name the files that matter most and say why. Test files and check scripts are in scope as specifications (section 3.4), not as production code.

### 3.1 Engine packages (`packages/`)

The engine is pure TypeScript with no React or native dependencies (decision D2) and uses only the `@scure` and `@noble` libraries for cryptography (decision D7). Hand-rolled primitives are prohibited; the libraries themselves are trusted, not re-audited (`docs/THREAT_MODEL.md` section 1.2).

**`packages/core`** (`@shiba-wallet/core`): the root of all key material.

- `src/keyring/mnemonic.ts`, `src/keyring/keyring.ts`: BIP-39 phrase creation and validation, seed computation, BIP-32 / BIP-44 hardened derivation. Why it matters: every key on every chain comes from here (D1).
- `src/keyring/slip10.ts`: SLIP-0010 derivation for ed25519 (Solana).
- `src/bip85.ts`: BIP-85 child-phrase derivation, used for the duress (decoy) wallet; validated against the official BIP-85 vectors.
- `src/chains/evm.ts`, `src/chains/utxo.ts`, `src/chains/solana.ts`, `src/chains/types.ts`: per-family key providers and the signer interface (adapters receive a signing callback, never a raw key). Also imported-key validation (`isValidEvmPrivateKey`, decision D9).
- `src/registry/registry.ts`, `src/assets/caip19.ts`, `src/assets/assets.ts`: the chain-adapter registry keyed by CAIP-2 and SLIP-44 (D3) and CAIP-19 asset identifiers.

**`packages/chains-evm`**: everything EVM. The largest and most security-relevant package.

- Signing and transactions: `eoa-tx.ts` (EIP-1559 transactions), `rlp.ts`, `encoding.ts`, `abi.ts`, `eip712.ts`, `rpc.ts` (the node and bundler clients, including the gas-estimate sanity rules in `gasLimitProblems`).
- EIP-7702: `eip7702.ts` (authorization tuples, set-code transactions, the post-Glamsterdam gas schedule). The wallet signs authorizations only for its own upgrade, never at a dApp's request (decision D6).
- ERC-4337: `userop.ts` (UserOperation packing and hashing for EntryPoint v0.7), `smart-account.ts` (the client that estimates, signs and submits, with its `beforeSign` hook), `simple-account.ts`.
- Kernel v3.3: `kernel-account.ts` (the account spec, local CREATE2 address prediction that refuses a disagreeing factory answer, `verifyKernelDeployment`), `account-signatures.ts`, `erc1271.ts`, `erc6492.ts`, `erc7739.ts` (the signature envelopes for contract-account message signing).
- Session keys and policies: `kernel-permissions.ts` (grant validation, including the rule that refuses self-calls), `kernel-subscription.ts`, `kernel-dca.ts` (recurring swaps pinned by CallPolicy), `kernel-spending.ts`.
- Guardians, recovery and inheritance: `kernel-recovery.ts`.
- Passkeys: `kernel-webauthn.ts` (strict assertion decoding, the pinned validator code hash, the self-call refusal).
- Multisig: `kernel-multisig.ts` (transaction-only; message signing refused).
- Paymasters: `token-paymaster.ts` (Circle), `erc7677-token-paymaster.ts` (Pimlico through ERC-7677).
- Bridges: `bridge/types.ts`, `bridge/registry.ts`, `bridge/layerzero-oft.ts`, `bridge/cctp-v2.ts`, `bridge/util.ts` (the provider registry, calldata construction with pinned fields, exact approvals, and tracking by on-chain events).
- Staking: `staking.ts` (Lido and Rocket Pool calls, the Lido claim-hint flow).
- What the user is shown: `simulate.ts` and `asset-diff.ts` (balance-change previews from `eth_simulateV1`, including the EIP-7708 protocol transfer logs), `contract-risk.ts`, `approvals.ts`, `activity-decode.ts`, `erc20.ts`, `erc20-logs.ts`, `erc721.ts`, `erc1155.ts`, `ens.ts`, `swap.ts`, `token-discovery.ts`, `indexer-history.ts`, `nft-indexer.ts`.

**`packages/chains-utxo`**: Bitcoin and Dogecoin (`tx.ts` signing, `coinselect.ts`, `dust.ts`, `address.ts`, `transfer.ts`, `blockbook.ts`). Why it matters: coin selection and change handling decide what leaves the wallet.

**`packages/chains-solana`**: Solana (`transaction.ts`, `message.ts`, `systemProgram.ts`, `splToken.ts`, `pda.ts`, `rpc.ts`).

**`packages/prices`**: the CoinGecko price adapter. Lower priority: prices are display-only and never used in signing (`docs/THREAT_MODEL.md` section 3.5).

### 3.2 The app's key handling, gates and storage (`app/src/wallet`, `app/src/config`, `app/src/components`)

- **The key vault.** `app/src/wallet/storage.ts`: the only module that touches key material in `expo-secure-store`; the standard and biometric-protected storage classes, the migration state machine, the single-use 30-second hold of an opened phrase, imported keys and session keys. `app/src/wallet/imported-keys.ts`.
- **The storage seam.** `app/src/wallet/store-keys.ts`: every persisted `shiba-wallet.*` key is declared here with its scope (wallet, device or secret); `scopedStoreKey` prefixes wallet and secret keys for the decoy profile. `app/scripts/check-storage-seam.mjs` fails on any storage access outside the seam.
- **Signing and the approval gate.** `app/src/wallet/WalletContext.tsx` (`signWith`: load the secret, derive, refuse unless the key controls exactly the quoted address, sign, zero the seed) and `app/src/wallet/biometric.ts` (`requireLocalAuth`). The gate is enforced by convention at each call site (`docs/THREAT_MODEL.md` section 3.3).
- **Account identities.** `app/src/wallet/account-ids.ts` and `app/src/wallet/accounts.ts` (`derivationArgsFor`, the one mapping from account index to derivation path, decision D8; imported, watch-only and multisig accounts use reserved id ranges that every derivation helper refuses), `app/src/wallet/watch-only.ts` (`assertAccountCanSign`).
- **The app PIN, the duress PIN and the lock.** `app/src/wallet/pin.ts` (the fixed-shape PIN record, `pinScrypt`, `equalBytesConstantTime`, the wait schedule), `app/src/wallet/duress.ts` (the BIP-85 decoy profile), `app/src/wallet/lock.ts` (`launchLockDecision`), `app/src/components/LockGate.tsx`.
- **The readiness switchboard.** `app/src/config/readiness.ts` (`assertFeatureAllowed`): 23 rows, of which 15 are enforced test-networks-only, 7 are advisory "blocked" on mainnet and 1 (`duress-pin`) is allowed everywhere. Every refusal must happen before a network request or a key read.
- **Send paths and replacements.** `app/src/wallet/send.ts` (`prepareEvmSend`, the quote-pinning check, `prepareEvmReplacement` for speed-up and cancel), `send-erc20.ts`, `send-nft.ts`, `pending-transactions.ts`, `fee-read.ts`, `delegation.ts` (the EIP-7702 upgrade and revoke).
- **Smart-account operations.** `app/src/wallet/aa.ts` (quotes, the bundler fee-floor check `assertQuoteFeesMeetBundlerFloor`, `checkAaQuoteBeforeApproval`, the signed-fee guard `signedFeeGuard`, `claimQuoteForSubmission` so a quote is submitted at most once, `assertTokenGasPermit`), `token-gas.ts`, `sessions.ts`, `subscriptions.ts`, `recurring.ts`, `dca.ts`, `recovery.ts`, `inheritance.ts`, `passkeys.ts`, `multisig.ts`, `bridge.ts` (`checkBridgeQuote`), `staking.ts`.
- **Limits and what the user is shown.** `spending-policy.ts` (`evaluateBeforeSigning`, app-enforced spending limits), `simulation.ts`, `risk.ts` (`tokenTransferTarget` and the risk card), `typed-data-summary.ts` (Permit and Permit2 summaries), `contacts.ts` (look-alike warnings), `approvals.ts`, `siwe.ts`, `proof.ts`.
- **dApp connections.** `app/src/wallet/walletconnect.ts` (request parsing, the EIP-7702 refusals, identity display), `wc-controller.ts`, `WalletConnectContext.tsx`, `wc-sent.ts`; the in-app browser in `browser-sites.ts` (`siteForUrl`, `decideNavigation`: the origin parser and allow-list), `browser-bridge.ts` (the method table, the frame rule, the read proxy), `browser-provider-script.ts`, and `app/src/screens/BrowserScreen.tsx`.
- **Endpoints.** `app/src/config/endpoint-probe.ts` (chain identity and freshness checks, failover), `endpoint-url.ts` (https only), `networks.ts`, `evm-chain.ts` (the network profiles and pinned facts), `custom-networks.ts`.
- **Screen protection and notifications.** `screen-protection.ts`, `notifications.ts` (local only; no push service is loaded).

Screens under `app/src/screens/` are in scope where they decide the order of operations (where `requireLocalAuth` runs relative to the quote checks and `signWith`), not for layout.

### 3.3 Scripts that guard the repository

`scripts/githooks/secret-scan.mjs`, `scripts/ci/run.mjs`, `scripts/ci/offline-guard.mjs` and `scripts/ci/suites.mjs` are in scope as controls: a public repository must not leak keys, and the test runner's claims must be trustworthy.

### 3.4 The check scripts as executable specifications

The offline suites under `app/scripts/` and the engine's `packages/*/test/` files are in scope as specifications: "the suite claims X, but its fake does not model Y" is a welcome finding. The most security-relevant suites are `check-storage.mjs`, `check-storage-seam.mjs`, `check-duress.mjs`, `check-settings-protection.mjs`, `check-key-import.mjs`, `check-wc.mjs`, `check-wc-5792.mjs`, `check-typed-data.mjs`, `check-7702.mjs`, `check-sessions.mjs`, `check-dca.mjs`, `check-recurring.mjs`, `check-subscriptions.mjs`, `check-recovery.mjs`, `check-passkeys.mjs`, `check-multisig.mjs`, `check-aa.mjs`, `check-token-gas.mjs`, `check-bridge.mjs`, `check-browser.mjs`, `check-pending.mjs`, `check-readiness.mjs`, `check-failover.mjs` and `check-contacts.mjs`.

---

## 4. Explicitly out of scope, and why

### 4.1 Third-party contracts the wallet pins

The wallet calls, installs or relies on contracts it did not write. Reviewing their Solidity is a separate engagement with a different skill set, and several already have (or lack) published audits that this project cannot change. They are out of scope by default. **The wallet's trust statements about them are in scope**: every screen, refusal and document sentence that tells the user what a contract can or cannot do should be checked for accuracy against the contract. The audit status below is as the repository records it; "no audit found" means the project searched and found none, not that none exists.

| Contract or system | Role in the wallet | Audit status as recorded |
|---|---|---|
| EntryPoint v0.7 (eth-infinitism) | Executes every ERC-4337 operation | Assumed correct (`docs/THREAT_MODEL.md` section 1.2); the canonical release, not reviewed by the project |
| Kernel v3.3 core (factory, meta factory, implementation, ECDSA validator) | Every smart account | Published audits cover Kernel v3.0 and a v3.1 increment; nothing found for v3.2, v3.3 or the EIP-7702 changes (T-30, F-25, `docs/AA_FRAMEWORKS.md` section 17.2) |
| Kernel permission modules (ECDSASigner, CallPolicy v0.0.4, TimestampPolicy, GasPolicy, RateLimitPolicy, SudoPolicy) | Session keys, subscriptions, recurring payments, DCA | No published report names them; treated as unaudited (F-14, header of `packages/chains-evm/src/kernel-permissions.ts`) |
| WeightedECDSAValidator (v3 port) and RecoveryAction | Guardians, inheritance, multisig | Kalos audited the Kernel v2 versions only; the deployed v3 forms are in no published report (F-21, `kernel-recovery.ts` header) |
| WebAuthnValidator v0.0.3 | Passkeys | The v3.1 incremental audit covered the unpatched code; no audit of the patched v0.0.3 found (F-18, `kernel-webauthn.ts` header) |
| ZeroDev SpendingLimit hook | Pinned for reference only; not installed (it reverts on Kernel v3.1 to v3.3, `docs/DISCLOSURE_FINDINGS.md` item E) | Its v3.1 audit named a commit that differs from the deployed source by one line (`kernel-spending.ts`) |
| Circle token paymaster (EntryPoint v0.7) | Paying the network fee in USDC (Base and Arbitrum Sepolia) | No published audit found; GPL-3.0-or-later behind an upgradeable proxy Circle controls (F-58, `docs/DISCLOSURE_FINDINGS.md` section 8.3) |
| Pimlico ERC-20 paymaster singleton | Paying the fee in USDC on Ethereum Sepolia | No audit of the singleton found (`erc7677-token-paymaster.ts` header) |
| Uniswap v3 (SwapRouter02, factory, QuoterV2, pools) on Sepolia | Recurring swaps (DCA) | Not recorded; the router, factory and quoter are Sourcify matches, the pools are not source-verified and are re-checked against the factory on every read (`docs/MAINNET_READINESS.md` section 2) |
| Lido (stETH, wstETH, withdrawal queue) and Rocket Pool (RocketStorage, rETH, deposit pool) | Staking on Sepolia and Hoodi | Not recorded beyond the readiness reason's statement that the protocols have their own audits; which audit covers the deployed test-network code was not checked (`app/src/config/readiness.ts` row `staking`, `docs/STAKING.md`) |
| LayerZero V2 EndpointV2, message libraries, executor and DVN; Stargate V2 pools | Bridging native test ETH | Reports are listed in LayerZero's and Stargate's audit repositories; which commit each covers was not checked (`docs/BRIDGING.md` section 15.10) |
| Circle CCTP V2 | Bridging USDC (Standard Transfers only). Proven live by script on two test-network routes on 2026-10-25 (`docs/BRIDGING.md` section 17); offered in the app's Bridge screen since commit `0a5bc7f`; one transfer sent through the app, from the regular account, Arbitrum Sepolia → Base Sepolia (the burn on 2026-10-26 UTC, the mint on 2026-10-27 UTC; `AGENTS.md` phase 23, passes p23-cctp and p23-mint) | Three reports linked by Circle; commit coverage not checked (`docs/BRIDGING.md` section 4.8) |
| ENSv2 on Ethereum Sepolia (ETHRegistrar, the .eth and root registries, StandardRentPriceOracle, VerifiableFactory and the PermissionedResolver / UserRegistry implementations, the Universal Resolver's proxy chain) and the ENSv1 ReverseRegistrar | Wallet handles: registering a `.eth` name, its records and the primary name (Ethereum Sepolia only) | The `ensdomains/contracts-v2` repository has branches named for audit results; their contents and the commits any audit covered were not read (`docs/WALLET_HANDLES.md` section 3.4) |

### 4.2 Bundlers, paymaster services and RPC providers

Every network service is untrusted (`docs/THREAT_MODEL.md` section 1.2): the wallet may rely on one for availability, never for the safety of a signature. The services themselves (ZeroDev's bundler, Pimlico's paymaster service, Alchemy's indexers, the public RPC nodes, LayerZero Scan, Circle's attestation API, CoinGecko, the WalletConnect relay) are out of scope. **What the wallet does with their answers is in scope**: can a malicious node, bundler or indexer make the wallet sign something other than what the user approved, or show a misleading preview? Known limits here are recorded as T-21 and N-10 (one provider decides what the user sees).

### 4.3 The Expo and React Native platform

Expo SDK 57, React Native, Hermes, `expo-secure-store`, `expo-local-authentication`, `expo-screen-capture`, `expo-notifications`, `react-native-webview`, the WalletConnect (Reown) SDK and the operating systems are out of scope as code. How the wallet *uses* them (wrong options, wrong assumptions, a missing check) is in scope; `docs/DAPP_BROWSER.md` is an example of where library defaults turned out to be unsafe.

### 4.4 Also out of scope

The blockchains' own consensus and fee markets; physical attacks on secure hardware; app-store distribution; a legal review of contract licences (an open item for counsel, F-39); features that do not exist (push notifications from a server, fiat on-ramp, hardware wallets).

---

## 5. The deployed addresses the wallet pins

Every address below is copied from the cited source file. "Test networks" means the address is used there today. For mainnet, three different states occur and are kept apart: **used** (the wallet acts on it today), **read once** (a source comment records that the same address and code were read on Ethereum mainnet, but no mainnet path uses it), and **documented, not verified** (taken from a vendor's documentation only).

A note on the record: the engine's source comments say the Kernel v3.3 core, the permission modules, the weighted validator, RecoveryAction and the WebAuthn validator have identical code at the same address on Ethereum mainnet and Sepolia (read 2026-10-01, `packages/chains-evm/src/kernel-account.ts`, `kernel-permissions.ts`, `kernel-recovery.ts`, `kernel-webauthn.ts`; `docs/AA_STACK.md`), while `docs/MAINNET_READINESS.md` section 2 says the mainnet deployment "has not been verified on-chain by the wallet". The two are consistent only if "verified" means the full test-network standard (a deployment exercised through the wallet, modules installed and used). This document records the mainnet state as "read once" and the full verification as not done. Since 2026-10-25 the read itself is repeatable: section 5.7 describes the script that re-reads every address below on its own network, including the Ethereum mainnet addresses, and gives the result. A repeatable read-only check is still not the full test-network standard (no mainnet deployment has been exercised through the wallet), so "read once" in the tables now means "read on-chain by the script, not exercised".

Networks: Ethereum Sepolia (chain id 11155111), Base Sepolia (84532), Arbitrum Sepolia (421614), OP Sepolia (11155420), Hoodi (560048).

### 5.1 ERC-4337 and the Kernel v3.3 stack

| Contract | Address | Test networks | Mainnet | Source |
|---|---|---|---|---|
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | Sepolia, Base, Arbitrum and OP Sepolia (smart accounts are not offered on Hoodi) | Canonical address; no mainnet smart-account path | `packages/chains-evm/src/userop.ts`, `docs/AA_STACK.md` |
| Kernel meta factory (FactoryStaker) | `0xd703aaE79538628d27099B8c4f621bE4CCd142d5` | Sepolia, Base, Arbitrum, OP Sepolia (none on Hoodi) | Read once | `kernel-account.ts`, `docs/AA_STACK.md` |
| KernelFactory | `0x2577507b78c2008Ff367261CB6285d44ba5eF2E9` | Same four (no code on Hoodi) | Read once | same |
| Kernel v3.3 implementation (also the EIP-7702 delegate) | `0xd6CEDDe84be40893d153Be9d467CD6aD37875b28` | Same four (no code on Hoodi) | Read once | same |
| ECDSA validator | `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57` | Same four | Read once | same |
| ECDSASigner | `0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF` | Sepolia, Base, Arbitrum and OP Sepolia: byte-identical code on all four (section 5.7; previously recorded for OP Sepolia only, `docs/THREAT_MODEL.md` section 1.1) | Read once; byte-identical to the test networks | `kernel-permissions.ts` |
| CallPolicy v0.0.4 | `0x9a52283276A0ec8740DF50bF01B28A80D880eaf2` | as above | Read once | same |
| TimestampPolicy | `0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F` | as above | Read once | same |
| GasPolicy | `0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23` | as above | Read once | same |
| RateLimitPolicy | `0xf63d4139B25c836334edD76641356c6b74C86873` | as above | Read once | same |
| SudoPolicy (never used by the wallet's grants) | `0x67b436caD8a6D025DF6C82C5BB43fbF11fC5B9B7` | as above | Read once | same |
| WeightedECDSAValidator (guardians, heirs, multisig root) | `0xeD89244160CfE273800B58b1B534031699dFeEEE` | Sepolia, Base, Arbitrum, OP Sepolia (code hashes pinned per network) | Read once. **Corrected 2026-10-25:** this table said "Sourcify full match on chain 1" (as the comment in `kernel-recovery.ts` does); Sourcify's API answered `"match"` for creation and runtime on chain 1 (its name for what was formerly called a partial match), not `"exact_match"` | `kernel-recovery.ts`, `kernel-multisig.ts`, `app/src/config/evm-chain.ts` (`MULTISIG_VERIFIED_NETWORKS`) |
| RecoveryAction | `0xe884C2868CC82c16177eC73a93f7D9E6F3A5DC6E` | Sepolia, Base, Arbitrum and OP Sepolia, byte-identical on all four (section 5.7); not on Sourcify on any of them | Read once; byte-identical | `kernel-recovery.ts` |
| WebAuthnValidator v0.0.3 | `0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69` | Sepolia (bound by runtime code hash); OP Sepolia byte-identical | Read once (no Sourcify record on mainnet) | `kernel-webauthn.ts` |
| Daimo P256Verifier (fallback when no P-256 precompile) | `0xc2b78104907F722DABAc4C69f826a522B2754De4` | Used by the validator | Not recorded separately | `kernel-webauthn.ts` |
| ZeroDev SpendingLimit hook (pinned, not installed) | `0xb6D6B30C9E1A28E8044F4cCB48A63A423Ee3D70E` | Read for the finding only | Read once | `kernel-spending.ts` |
| SimpleAccountFactory v0.7 (pre-fill) | `0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985` | Sepolia | None | `app/src/config/evm-chain.ts` |
| SimpleAccount implementation | `0x68641DE71cfEa5a5d0D29712449Ee254bb1400C2` | Sepolia | None | same |

For Base Sepolia and Arbitrum Sepolia the record states that `verifyKernelDeployment` passed and that the weighted validator, factory, meta factory and implementation were compared on-chain (`evm-chain.ts`). The module-by-module comparison that this paragraph first said was not recorded was made on 2026-10-25 by the script in section 5.7: the six permission modules, RecoveryAction, the WebAuthn validator v0.0.3, the ECDSA validator and Daimo's verifier have byte-identical code on Ethereum mainnet and all four test networks; the WebAuthn validator matches its pinned code hash on all five.

### 5.2 Paymasters

| Contract | Address | Test networks | Mainnet | Source |
|---|---|---|---|---|
| Circle token paymaster v0.7 (proxy) | `0x31BE08D380A21fc740883c0BC434FcFc88740b58` | Base Sepolia, Arbitrum Sepolia (no code on OP Sepolia; unusable on Ethereum Sepolia) | — | `packages/chains-evm/src/token-paymaster.ts` |
| Circle paymaster implementation, Base Sepolia | `0x1E42055dECF050828AfE8bA0A374bC5F44CbFC8d` | Base Sepolia | — | same (comment) |
| Circle paymaster implementation, Arbitrum Sepolia | `0xD9d18FD662B5B2F567545C13fd1e902008beD755` | Arbitrum Sepolia | — | same |
| Circle paymaster, documented mainnet address | `0x6C973eBe80dCD8660841D4356bf15c32460271C9` | — | **Documented, not used.** Read-only on 2026-10-25 (section 5.7) on Base (8453) and Arbitrum One (42161), the two networks the source names: a 144-byte proxy with code on both, `entryPoint()` = EntryPoint v0.7, staked 0.25 ETH with an 86,400 s delay, Sourcify `exact_match` for the proxy and for each network's implementation. Not on Ethereum mainnet's list in the source; not exercised | same |
| Pimlico ERC-20 paymaster singleton | `0x777777777777AeC03fd955926DbF81597e66834C` | Used on Ethereum Sepolia; code hash read on Sepolia, Base and Arbitrum Sepolia | Not used. On 2026-10-25 its code on Ethereum mainnet equalled the pinned code hash and Sourcify answered `exact_match` (section 5.7) | `erc7677-token-paymaster.ts` |

### 5.3 Tokens and other fixed addresses

| Contract | Address | Network | Source |
|---|---|---|---|
| Circle USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | Ethereum Sepolia | `app/src/wallet/tokens.ts`, `bridge/cctp-v2.ts` |
| Circle USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Base Sepolia | same |
| Circle USDC | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | Arbitrum Sepolia | same |
| Circle USDC | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` | OP Sepolia | same |
| Circle EURC | `0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4` | Ethereum Sepolia | `tokens.ts` |
| Circle EURC | `0x808456652fdb597867f38412077A9182bf77359F` | Base Sepolia | `tokens.ts` |
| USDC (display and default tracked token only) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | Ethereum mainnet | `app/src/wallet/erc20.ts` |
| Uniswap Permit2 (recognised in typed-data summaries) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Mainnet, Sepolia, Base Sepolia | `app/src/wallet/typed-data-summary.ts` |
| ENS Universal Resolver | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | Mainnet and Sepolia | `packages/chains-evm/src/ens.ts` |
| WETH9 (decoded for wrap / unwrap events) | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` (mainnet), `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` (Sepolia), `0x4200000000000000000000000000000000000006` (OP-stack predeploy) | as listed | `asset-diff.ts` |
| EIP-7708 protocol log emitter (decoded as native transfers) | `0xfffffffffffffffffffffffffffffffffffffffe` | Sepolia after the Glamsterdam fork | `asset-diff.ts` |

**ENS wallet handles: ENSv2 on Ethereum Sepolia only (phase 23 item 6).** From `packages/chains-evm/src/ens-register.ts` (`ENS_V2_SEPOLIA`, `ENS_V2_SEPOLIA_USDC`), which pins the deployment ENS's documentation names for Sepolia (`ensdomains/contracts-v2` at `07e55a05`, the redeploy of 2026-10-01; `docs/WALLET_HANDLES.md` section 3). Two addresses on the Universal Resolver's proxy chain are pinned only in `scripts/testnet/ens-register-smoke.mjs` (`MANAGED_URP`, `UR_V2`); the engine comment gives them abbreviated. Nothing is pinned for a main network: the module refuses every chain but Ethereum Sepolia, and a mainnet handle waits for ENS's ENSv2 mainnet launch (`docs/WALLET_HANDLES.md` section 2, "Mainnet"; the decision is recorded in `AGENTS.md`, phase 23 item 6, engine half). Sizes and Sourcify answers are from the script of section 5.7 (2026-10-26 03:20 UTC); every size equals `docs/WALLET_HANDLES.md` section 3.2.

| Contract | Address | Code | Sourcify | Source |
|---|---|---|---|---|
| ETHRegistrar (commit-reveal, ERC-20 payment) | `0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3` | 8,037 B | `match` | `ens-register.ts` |
| ETHRegistry (the `.eth` PermissionedRegistry) | `0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4` | 16,000 B | `exact_match` | same |
| RootRegistry | `0xB458D6a3a77919449d03e7A6903C26827c1eC43f` | 16,000 B (byte-identical to the ETHRegistry) | `exact_match` | same |
| StandardRentPriceOracle | `0x8196665D4ca7488B6474a9EC8E7d2719FB42263A` | 8,355 B | `match` | same |
| VerifiableFactory | `0xDa70306C98E97eCe36F997a21368e53298572991` | 1,524 B | `exact_match` | same |
| VerifiableFactory `proxyLogic()` | `0xC41576B4B809B99CF0fF2e5B41b4F147cd9b6BDd` | 1,357 B | none | same |
| PermissionedResolver implementation | `0x115eb53F0c60696633855F90b138178Fb40b2b2C` | 15,608 B | `match` | same |
| UserRegistry implementation | `0x9BD8a88719068D09ecee662f36C0E3856708366a` | 18,982 B | `exact_match` | same |
| ENSv1 ReverseRegistrar (primary names) | `0xA0a1AbcDAe1a2a4A2EF8e9113Ff0e02DD81DC0C6` | 3,382 B | `exact_match` | same |
| ENSv1 PublicResolver (the ReverseRegistrar's default resolver) | `0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5` | 14,512 B | `exact_match` | same |
| ENSV1Resolver (the root's resolver for `reverse`, mirroring v1 reverse records) | `0x322B7581cA210a69c6D0e0D7c88a7688D2789Cb0` | 11,102 B | `match` | same |
| ENS Universal Resolver (proxy; the row above, on Sepolia) | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | 2,491 B | `exact_match` | `packages/chains-evm/src/ens.ts` |
| ManagedUniversalResolverProxy (the proxy's ERC-1967 implementation) | `0x6d80F2172CFdEc5730fE683860C33d26fC42e6F1` | 2,612 B | `exact_match` | `scripts/testnet/ens-register-smoke.mjs` |
| UniversalResolverV2 (the managed proxy's implementation) | `0x24E1D8e068620B647CA097f961A61055f4f42D72` | 18,792 B | `match` | same |
| Circle USDC (the only registration payment token offered) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | 1,798 B | `exact_match` | `ens-register.ts`, and the token table above |

Who controls these on Sepolia, as read by the script: the registrar's `owner()` and `BENEFICIARY()` are `0x84D3a426D4E12E955d1DF95db0B24fe26afE39D3`, and the Universal Resolver proxy's and the managed proxy's `admin()` are `0x69420f05A11f617B4B74fFe2E04B2D300dFA556F` and `0xffFffFFfFF52D316B7Bd028358089bc8066b8f80`; none of the three holds code (single keys). The registrar's owner can replace the price oracle and either admin can upgrade what every Sepolia name resolves to (`docs/WALLET_HANDLES.md` section 3.4). The first live handle, `shibawalletdemo.eth` with its resolver `0x599AE46486BC988C5bA9b98CdB1f7cF167dD6059`, is a record of one registration, not a pin, and is not listed by the script.

### 5.4 Uniswap v3 (recurring swaps), Ethereum Sepolia only

From `packages/chains-evm/src/kernel-dca.ts` (`UNISWAP_V3_SEPOLIA`, `DCA_PINNED_POOLS`, `DCA_REFUSED_ROUTERS`). Nothing is pinned for a main network.

| Contract | Address |
|---|---|
| UniswapV3Factory | `0x0227628f3F023bb0B980b67D528571c95c6DaC1c` |
| SwapRouter02 | `0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E` |
| QuoterV2 | `0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3` |
| WETH9 | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |
| USDC/WETH pools (0.01%, 0.05%, 0.3%, 1%) | `0xFeEd501c2B21D315F04946F85fC6416B640240b5`, `0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1`, `0x6Ce0896eAE6D4BD668fDe41BB784548fb8F59b50`, `0x6418EEC70f50913ff0d756B48d32Ce7C02b47C47` |
| Routers refused by name | SwapRouter v1 `0xE592427A0AEce92De3Edee1F18E0157C05861564` (deadline field), Universal Router `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` (Sepolia) and `0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af` (mainnet) (calldata cannot be pinned) |

### 5.5 Staking, test networks only

From `packages/chains-evm/src/staking.ts` (`LIDO_DEPLOYMENTS`, `ROCKET_POOL_DEPLOYMENTS`). Mainnet is deliberately absent.

| Contract | Ethereum Sepolia | Hoodi |
|---|---|---|
| Lido stETH | `0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af` (deprecated deployment; earns nothing) | `0x3508A952176b3c15387C97BE809eaffB1982176a` |
| Lido wstETH | `0xB82381A3fBD3FaFA77B3a7bE693342618240067b` | `0x7E99eE3C66636DE415D2d7C880938F2f40f94De4` |
| Lido withdrawal queue | `0x1583C7b3f4C3B008720E6BcE5726336b0aB25fdd` (paused) | `0xfe56573178f1bcdf53F01A6E9977670dcBBD9186` |
| Rocket Pool RocketStorage | — | `0x594Fb75D3dc2DFa0150Ad03F99F97817747dd4E1` |
| Rocket Pool rETH | — | `0x7322c24752f79c05FFD1E2a6FCB97020C1C264F1` (must equal RocketStorage's entry) |
| Rocket Pool deposit pool | — | Resolved from RocketStorage at every quote, not pinned; last recorded `0x425E6f83e27f1676AD78BC39dA79C2C7b33d3Fd8` (`docs/STAKING.md`) |

### 5.6 Bridges, test networks only

From `packages/chains-evm/src/bridge/layerzero-oft.ts` (`LAYERZERO_V2_TESTNET`, `STARGATE_V2_TESTNET_NATIVE_POOLS`) and `bridge/cctp-v2.ts` (`CCTP_V2_TESTNET`). No mainnet bridge address is pinned (`docs/MAINNET_READINESS.md` section 2).

| Network (LayerZero endpoint id) | LayerZero EndpointV2 | Send library (ULN 302) | Receive library | Executor | LayerZero Labs DVN | Stargate native ETH pool |
|---|---|---|---|---|---|---|
| Ethereum Sepolia (40161) | `0x6EDCE65403992e310A62460808c4b910D972f10f` | `0xcc1ae8Cf5D3904Cef3360A9532B477529b177cCE` | `0xdAf00F5eE2158dD58E0d3857851c432E34A3A851` | `0x718B92b5CB0a5552039B593faF724D182A881eDA` | `0x8eebf8b423B73bFCa51a1Db4B7354AA0bFCA9193` | `0x9Cc7e185162Aa5D1425ee924D97a87A0a34A0706` |
| Base Sepolia (40245) | same endpoint | `0xC1868e054425D378095A003EcbA3823a5D0135C9` | `0x12523de19dc41c91F7d2093E0CFbB76b17012C8d` | `0x8A3D588D9f6AC041476b094f97FF94ec30169d3D` | `0xe1a12515F9AB2764b887bF60B923Ca494EBbB2d6` | none (no Stargate pool) |
| Arbitrum Sepolia (40231) | same endpoint | `0x4f7cd4DA19ABB31b0eC98b9066B9e857B1bf9C0E` | `0x75Db67CDab2824970131D5aa9CECfC9F69c69636` | `0x5Df3a1cEbBD9c8BA7F8dF51Fd632A9aef8308897` | `0x53f488E93b4f1b60E8E83aa374dBe1780A1EE8a8` | `0x6fddB6270F6c71f31B62AE0260cfa8E2e2d186E0` |
| OP Sepolia (40232) | same endpoint | `0xB31D2cb502E25B30C651842C7C3293c51Fe6d16f` | `0x9284fd59B95b9143AF0b9795CAC16eb3C723C9Ca` | `0xDc0D68899405673b932F0DB7f8A49191491A5bcB` | `0xd680ec569f269aa7015F7979b4f1239b5aa4582C` | `0xa31dCc5C71E25146b598bADA33E303627D7fC97e` |

Circle CCTP V2 (same addresses on all four networks; Standard Transfers proven live by script on 2026-10-25, Base Sepolia → Arbitrum Sepolia and Ethereum Sepolia → Base Sepolia, `docs/BRIDGING.md` section 17; offered in the app's Bridge screen since commit `0a5bc7f`, and sent through it once, Arbitrum Sepolia → Base Sepolia, burned on 2026-10-26 and minted on 2026-10-27 UTC): TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, MessageTransmitterV2 `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`, TokenMinterV2 `0xb43db544E2c27092c107639Ad201b3dEfAbcF192`.

### 5.7 The tables are machine-checked: `scripts/audit/verify-pins.mjs`

Until phase 23 the tables above were copied from the source files. They are now checked by a read-only script that takes the addresses from the code itself and reads each one on its own network:

```sh
npm run build                                   # the script imports the engine's built modules
node scripts/audit/verify-pins.mjs              # every network, live, read-only
node scripts/audit/verify-pins.mjs --network 1  # one network (a chain id or a name such as sepolia)
node scripts/audit/verify-pins.mjs --offline    # list the pins and their sources; no request
node scripts/audit/verify-pins.mjs --json <file>  # also write every result as JSON
```

**What it collects.** It imports the tables that pin addresses (the engine's `KERNEL_V3_3`, `KERNEL_PERMISSION_MODULES`, `KERNEL_RECOVERY_MODULES`, `KERNEL_WEBAUTHN_VALIDATOR`, the SpendingLimit hook, `CIRCLE_TOKEN_PAYMASTER_V07`, `PIMLICO_ERC20_PAYMASTER_V07`, `UNISWAP_V3_SEPOLIA`, `DCA_PINNED_POOLS`, `DCA_REFUSED_ROUTERS`, `LIDO_DEPLOYMENTS`, `ROCKET_POOL_DEPLOYMENTS`, `LAYERZERO_V2_TESTNET`, `STARGATE_V2_TESTNET_NATIVE_POOLS`, `CCTP_V2_TESTNET`, `ENS_UNIVERSAL_RESOLVER`, `ENS_V2_SEPOLIA` and `ENS_V2_SEPOLIA_USDC`, `WRAPPED_NATIVE_TOKENS`, the activity labels' literal addresses; the app's `EVM_SEPOLIA.aaPrefill`, `MULTISIG_VERIFIED_NETWORKS`, `KNOWN_TEST_NETWORK_TOKENS`, `KNOWN_STAKING_TOKENS`, `USDC_MAINNET`, `PERMIT2_ADDRESS` and `OP_STACK_GAS_PRICE_ORACLE`; and the two Universal Resolver proxy-chain addresses that only `scripts/testnet/ens-register-smoke.mjs` pins, parsed from that file's source because importing it would run it) and cites, for every address, the file and line where it is written. It also lists the accounts the source describes as holding no contract (the Stargate test pools' owner and "planner", the EIP-7708 log emitter), which it expects to find empty. 190 (network, address) pairs come from 109 pins (177 from 94 before the ENSv2 Sepolia pins were added; the 13 new pairs are all on Ethereum Sepolia).

**What it reads, per address.** `eth_getCode` (byte length and keccak-256), compared with a code hash only where the CODE pins one (`MULTISIG_VERIFIED_NETWORKS`, the WebAuthn validator's `runtimeCodeHash`, the SpendingLimit hook's and Pimlico's `runtimeCodeKeccak`); the ERC-1967 implementation slot; the fixed facts the source documents (for example `entrypoint()`, `accountId()`, `eip712Domain()`, `isModuleType(1)`, `approved(factory)`, `token()`, `localDomain()`, `eid()` with the default send and receive libraries, `isMinter(TokenMinterV2)`, `symbol()` and `decimals()`, the pool's factory, tokens and fee, and the engine's own `verifyKernelDeployment`, `verifyWebAuthnValidatorDeployment`, `verifyLidoDeployment`, `resolveRocketPool`, `readCirclePaymasterState`, `readPimlicoPaymasterState` and `readEnsPrimaryName`); for ENSv2 on Sepolia, the registrar's `rentPriceOracle()`, `ETH_REGISTRY()` and four limits against `ENS_V2_SEPOLIA_REGISTRAR_LIMITS`, the oracle's acceptance of Circle's USDC and its first priced label length against `ENS_V2_MIN_LABEL_LENGTH`, the registrar's `REGISTRAR | RENEW` roles on the `.eth` registry, the root's `getSubregistry("eth")` and `getResolver("reverse")`, the factory's `proxyLogic()` and its `predictProxyAddress` against the engine's own CREATE2 prediction, the v1 ReverseRegistrar's `defaultResolver()`, and the Universal Resolver's two ERC-1967 hops to `UniversalResolverV2` and its `ROOT_REGISTRY()` (the engine's own `quoteEnsRegistration`, `readEnsRegistrarConfig`, `readEnsPricing` and `readEnsOwnedResolver` first read the latest block with `eth_getBlockByNumber`, a method the script does not send, so it reads the same facts with `eth_call` and compares them with the same constants); the registrar's `owner()` and `BENEFICIARY()` and both proxies' `admin()` are printed with whether the address holds code, for information only; and Sourcify's public verification status (`GET https://sourcify.dev/server/v2/contract/{chain}/{address}`), printed in Sourcify's own words: `exact_match` (formerly "perfect"), `match` (formerly "partial") or none. Endpoints are the app's own keyless defaults (`app/src/config/evm-chain.ts`), each checked for its chain id; an endpoint more than 300 blocks behind the others is not used. A failed read is reported as "could not read", never as a pass. The script exits with status 1 on any missing code, hash mismatch or failed fact.

**Statuses.** *verified*: code present, bound to source by a pinned hash or a Sourcify match (and, for an ERC-1967 proxy, its implementation bound too), every fact as stated; *verified-by-identity*: byte-identical to the same address on another network where it is verified; *present-unverified*: code present but nothing binds it to source; *missing*, *unreadable*, *hash-mismatch*, *fact-failed*: failures.

**Result of 2026-10-25 (14:20 UTC, repository `16f5e72`), every network read live:**

| Network | Verified | Verified by identity | Present, unverified | Missing | Unreadable | Stated non-contracts confirmed |
|---|---|---|---|---|---|---|
| Ethereum mainnet | 21 | 2 | 1 | 0 | 0 | 1 |
| Ethereum Sepolia | 36 | 5 | 8 | 0 | 0 | 3 (one an EOA carrying an EIP-7702 delegation) |
| Base Sepolia | 23 | 3 | 4 | 0 | 0 | 1 |
| Arbitrum Sepolia | 21 | 3 | 4 | 0 | 0 | 3 |
| OP Sepolia | 19 | 3 | 6 | 0 | 0 | 3 |
| Hoodi | 3 | 0 | 2 | 0 | 0 | 0 |
| Base and Arbitrum One (Circle's documented mainnet paymaster only) | 2 | 0 | 0 | 0 | 0 | 0 |
| **All** | **125** | **16** | **25** | **0** | **0** | **11** |

No address the wallet pins lacks code on its network, no pinned code hash differs from the chain, and no documented fact read differently. Every address in the tables above matched the code (none needed correcting); two claims did not match the chain and are corrected in place: the weighted validator's Sourcify status on chain 1 (section 5.1) and the module-by-module comparison that had not been recorded (paragraph after section 5.1). The Kernel v3.3 core on Ethereum mainnet: the meta factory, factory, ECDSA validator, permission modules, RecoveryAction, WebAuthn validator and Daimo's verifier are byte-identical to the test networks; the implementation and the weighted validator differ from Ethereum Sepolia's in 35 and 34 bytes respectively, all within about 100 bytes around the 32-byte word that holds the cached chain id (a separate read-only byte comparison on 2026-10-25; consistent with the cached chain id and EIP-712 domain separator recorded for the test networks, though the separator was not recomputed this time), and `verifyKernelDeployment` passed on mainnet (factory → implementation, `entrypoint()` = EntryPoint v0.7, `accountId()` = `kernel.advanced.v0.3.3`, the meta factory approving the factory and staked 0.1 ETH with an 86,400 s delay, the validator a module of type 1), which agrees with the 2026-10-01 read recorded in `docs/AA_STACK.md`.

The 25 *present, unverified* rows are what an auditor still has to bind to source by other means: RecoveryAction on all five networks (no Sourcify record anywhere; the source comment records a byte-for-byte recompilation instead); on Ethereum Sepolia the SimpleAccount implementation, three of the four Uniswap pools (0.05%, 0.3%, 1%), Uniswap's v4 PoolManager (an activity label) and Circle's EURC, plus LayerZero Labs' executor (its ERC-1967 implementation has no Sourcify record); on Base Sepolia EURC, the executor and the OP-stack GasPriceOracle (implementation not on Sourcify); on Arbitrum Sepolia the receive library, the executor and the DVN; on OP Sepolia the send and receive libraries, the executor, the DVN and the GasPriceOracle; on Hoodi RocketStorage and the Lido withdrawal queue (implementation `0xD0a60e52…eCD5`, not on Sourcify, as `staking.ts` already states). Running the script prints every keccak, fact and Sourcify answer behind these counts.

**Re-run for Ethereum Sepolia after the ENSv2 pins were added (2026-10-26 03:20 UTC, repository `2bbf769`, `--network sepolia`):** verified 48, present and unverified 14, stated non-contracts confirmed 3 (one the Stargate planner, an EOA carrying an EIP-7702 delegation); no missing code, no hash mismatch and no failed fact. A run for one network cannot find a byte-identical twin on another, so the five Sepolia rows that the all-network run above counts as *verified by identity* appear here as *present, unverified*; the 52 pairs read before match the earlier figures (36 verified, 5 by identity, 8 unverified). Of the 13 new pairs, 12 are *verified* and every fact read as the code states (the registrar's oracle, registry and limits 60 s / 86,400 s / 2,419,200 s / 2,419,200 s; the registrar holding `REGISTRAR | RENEW`; the root naming the pinned `.eth` registry and reverse resolver; USDC accepted at the ratio (1, 1,000,000) the engine comment records; base rates [0, 0, 20,294,267, 5,073,567, 253,679] per second, first priced length 3; the factory's prediction equal to the engine's; the Universal Resolver → `0x6d80…e6F1` → `0x24E1…2D72` → the pinned root; `readEnsPrimaryName` answering "none" for an address without a name), and one is *present, unverified*: the VerifiableFactory's `proxyLogic()` contract, which has no Sourcify record. The same night a `--network mainnet` run passed too (verified 21, present and unverified 3, one stated non-contract; `readEnsPrimaryName` through the mainnet Universal Resolver answered "none").

**What the check does not do.** It does not prove that verified source is safe, that a proxy's owner will not upgrade it tomorrow, or that the wallet's calls are correct; it does not detect proxies other than ERC-1967 (Lido's stETH is an Aragon proxy); Sourcify's `match` means the bytecode matches but the metadata hash does not; and "verified by identity" relies on the other network's verification. It reads `latest` state through public endpoints, so it trusts those endpoints for the answer it prints (on 2026-10-25 at least two endpoints answered with the right chain id on each of Ethereum mainnet and the five test networks, and one each on Base and Arbitrum One; Pocket's OP Sepolia endpoint was about 128,000 blocks behind the others and was not used).

---

## 6. Known findings and open residuals: where to start

Row identifiers refer to `docs/THREAT_MODEL.md`: **T-nn** is a threat (section 4), **F-nn** and **N-nn** are findings (section 6), **C1–C3** and **W1–W20** are checklist items (section 5). Severity uses the threat model's scale (Low, Medium, High, and Critical for loss of funds for many users without any user mistake). The threat model records no open Critical finding.

### 6.1 Open findings in the wallet or its use of the stack

- **Key storage default (N-01, W1, T-01).** The biometric-protected storage class is opt-in (a decision by the Chairperson, recorded in `docs/THREAT_MODEL.md` section 3.2.3). Until a user opts in, the phrase is readable without a prompt by any code in the app process while the phone is unlocked. The approval gate is enforced by convention at each `signWith` call site (section 3.3 of the threat model). Partly mitigated.
- **Memory hygiene (N-03).** The phrase is a JavaScript string and derived private keys live in signing closures; neither can be zeroed. Only the seed buffer is zeroed. Accepted in decision D7.
- **The app PIN's cost (F-81, High for usability).** The PIN is hashed with scrypt at N = 2^16, r = 8, p = 1 (`app/src/wallet/pin.ts`). Under Hermes on the Android emulator one hash took 49–53 seconds in a release build and an unlock about 100 seconds (about 4 minutes in a debug build). The Chairperson decided on 2026-10-19 to move to a native scrypt implementation behind the same function, keeping N at 2^16 (`AGENTS.md`, phase 22 item 2). Against someone who copies the phone's files, a 6-digit PIN can be searched offline (about half a day for the whole space on a laptop at OWASP's setting, T-78).
- **Duress wallet limits (F-77, T-78).** The decoy protects only against someone looking at the screen: secure-store key names are visible on Android, so a file copy shows that two wallets exist, and funding the decoy from the real wallet links them on-chain. Exercised once on the emulator; not usable until F-81 is resolved.
- **Single provider decides what the user sees (N-10, T-21, W13).** Simulation, pre-flight, balances and risk facts come from one RPC endpoint at a time; failover is availability, not a cross-check.
- **WalletConnect sessions survive a wipe (F-28); native alerts can draw above the lock overlay (F-27).** Both open.
- **Passkey self-call caveat (F-19).** Only the wallet stops a passkey from replacing the account's owner; on-chain, Kernel would accept a passkey-signed self-call.
- **Dependencies (T-40, N-11, F-53).** Every npm dependency runs in the same JavaScript realm as the signing code; versions use caret ranges with committed lockfiles.
- **API keys in unencrypted app storage (N-08).** Endpoint URLs that embed keys are stored in AsyncStorage; https is enforced.
- **A builder-reported race (F-46)** whose details are not in the repository.

### 6.2 Honest limits of the deployed modules (stated on screen, test networks only)

- **Multisig message signing (F-62, T-70, `docs/MULTISIG.md`).** The deployed weighted validator checks the threshold before the signer order in its ERC-1271 path, so fewer signers than the threshold can produce a valid message signature; the wallet therefore refuses all message signing for multisig accounts. Co-signers approve the calls and the nonce, not the fee or paymaster, which the submitter alone sets.
- **Guardians and inheritance (F-20, F-60, T-31, T-68).** Guardians and heirs can sign messages as the account from the moment they are added (which can move tokens through permits); in message signing a repeated signer satisfies the threshold. Inheritance is a demonstration only. A very large guardian delay wraps around in the contract; the engine refuses delays above 2^32 − 1 seconds.
- **Session keys and batching (T-35, T-69, F-63, F-74, `docs/DISCLOSURE_FINDINGS.md` item G).** CallPolicy cannot stop a session key from batching several in-rule calls into one operation; a recurring swap's minimum output is static and has no deadline.
- **Token-fee paymasters (F-58).** Circle's paymaster is unaudited, upgradeable and uses a fixed test-network price oracle with no staleness check; Pimlico's is permissioned and leaves the unused part of an approval in place.
- **Bridges (F-80, T-80 to T-87).** Every LayerZero test pathway relies on one required verifier operated by LayerZero Labs; Stargate's test pools can be paused by a key whose private part is public; Stargate delivers ETH with a 2,300-gas transfer a deployed smart account cannot accept, so the wallet always bridges to the regular address; a bridge configuration change after the quote is not re-read at confirm time (T-81).
- **rETH burn stipend (F-73).** Rocket Pool's burn pays with a 2,300-gas stipend; a holder whose receive path costs more cannot redeem.

### 6.3 Inconsistencies in the record an auditor should not trip over

- **N-09, T-27, F-70 and section 3.6 of the threat model** were stale when this document was first written (the bundler save had refused a wrong-chain bundler since phase 11, F-70 was fixed in `9290864`, and local development and release builds had been built and run on the emulator since phase 16); the phase 22 refresh of 2026-10-20 corrected all four rows in `docs/THREAT_MODEL.md`, so an auditor reading the current threat model sees the corrected text. The point stands as a caution: the threat model's rows can lag the record in `AGENTS.md`, which is the authoritative history.
- **Mainnet verification of the Kernel stack:** see the note at the start of section 5. Since 2026-10-25 the mainnet read is repeatable and was repeated (section 5.7); the source comments in `kernel-permissions.ts` and `kernel-recovery.ts` that call the chain-1 Sourcify records of ECDSASigner, CallPolicy, GasPolicy, RateLimitPolicy, SudoPolicy and the weighted validator "full match" disagree with Sourcify's current answer (`match`, the former "partial"); those comments are engine files and are left for a separate correction.

### 6.4 Never observed on a real device

Nothing has run on a physical phone, and iOS has run only in the Simulator (W2; the Simulator does not enforce the Keychain's biometric-protected class and has no VoiceOver). Specifically unverified: whether `expo-secure-store` items are StrongBox-, TEE- or Secure-Enclave-backed (W3, section 3.2.5 of the threat model); the protected storage class's invalidation on a biometric change; release-build absence of developer tooling on a phone (W4; a release APK has run on the emulator); screenshot blocking on iOS and over native alerts (W19); Android backup on a real vendor transport (W18); passkeys (no relying-party domain exists); the app PIN's cost on real hardware (F-81); TalkBack beyond the emulator and VoiceOver entirely; whether WalletConnect's Verify service returns its verdicts over the live relay inside React Native (N-06, W12).

---

## 7. The questions we most want answered

In priority order. Each names the files to start from.

1. **Can anything sign without the user's approval of exactly what is shown?** Check every `signWith` call site in `app/src/screens/*` and `app/src/wallet/WalletConnectContext.tsx` for a preceding `requireLocalAuth`, the expected-address refusal in `WalletContext.tsx`, and the passkey exception. Check that `storage.ts` is the only reader of the phrase and that the single-use 30-second hold cannot be reused for another target.
2. **The key vault and protected storage on real hardware.** Review `app/src/wallet/storage.ts` (the migration state machine, the read-back-and-compare discipline, the fallbacks when a protected copy is unreadable, imported keys and session keys) against `expo-secure-store` 57's documented behaviour, and, if the engagement includes devices, confirm hardware backing on one Android and one iOS phone.
3. **The order of the approval gates.** For each operation type (EOA send, token send, smart-account operation, session-key operation, multisig submit, bridge, replacement), confirm the order: network and readiness checks, then quote re-checks (`checkAaQuoteBeforeApproval`, `checkBridgeQuote`, the replacement checks in `send.ts`), then the device prompt, then signing; and that no refusal happens after a key is read when it could have happened before.
4. **The signed-fee guards.** In `app/src/wallet/aa.ts` and `packages/chains-evm/src/smart-account.ts`: can the bundler's re-estimate at signing time, a paymaster's data, or a padded gas limit lead to signing a worst-case fee above the one displayed (`signedFeeGuard`, `assertQuoteFeesMeetBundlerFloor`, `gasLimitProblems`, `claimQuoteForSubmission`)? Can a token-fee permit exceed the displayed amount (`assertTokenGasPermit`)?
5. **CallPolicy pinning for session keys, DCA and bridges.** Do `kernel-permissions.ts`, `kernel-subscription.ts` and `kernel-dca.ts` pin every calldata word they claim to, at the right offsets, with the right comparison, and is the self-call refusal complete? Does `bridge/layerzero-oft.ts` really fix the 14 words it lists, and does `app/src/wallet/bridge.ts` re-check the words it says it re-checks (T-83 notes that it re-checks only some of them)?
6. **The ERC-1271 envelope and contract-account signatures.** `account-signatures.ts`, `erc1271.ts`, `erc6492.ts`, `erc7739.ts`: can a signature made for one account, chain or purpose be replayed for another? Is message signing refused everywhere it should be (multisig, SimpleAccount sessions)?
7. **The storage seam and the duress profile's isolation.** `app/src/wallet/store-keys.ts`, `duress.ts`, `WalletContext.tsx`, `WalletConnectContext.tsx`: can anything of the real wallet be read, shown or reconnected while the decoy is open (shared device settings, the shared smart-account endpoint fields, WalletConnect's per-profile storage prefix, notification identifiers)? Does "Remove wallet" remove both profiles and the PIN record?
8. **The PIN record.** `app/src/wallet/pin.ts`: are both slots hashed on every attempt with no early exit, is `equalBytesConstantTime` constant-time as used, is the attempt counter written before hashing, can the wait schedule be bypassed by killing the app mid-attempt, and does the fixed-shape record leak which slots are set? Review the native scrypt change (phase 22 item 2) if it is in the audited commit.
9. **The in-app browser's origin rules.** `browser-sites.ts` (`siteForUrl`, `decideNavigation`) and `browser-bridge.ts`: can a look-alike origin, a user-info URL, an iframe or a cross-origin navigation reach the provider, given the WebView limits in `docs/DAPP_BROWSER.md` (Android's fallback bridge reports the top URL for every frame; a 250 ms allow-by-default on Android navigation)?
10. **The risk card's resistance to spoofing, and the secret scan's coverage.** In `risk.ts`, `contract-risk.ts`, `simulation.ts` and `contacts.ts`: can a malicious token, a crafted counterparty or a dishonest RPC suppress a warning or produce a reassuring line (for example the "one of your own accounts" or "pinned staking contract" sentences)? Separately, does `scripts/githooks/secret-scan.mjs` miss any secret shape this repository has used (bundler URLs, project identifiers, keys in query strings), and is relying on an opt-in hook plus a CI rescan adequate for a public repository (T-56)?

---

## 8. Bug-bounty proposal (alongside C2)

This is a proposal for the Chairperson; nothing is published yet, and no disclosure channel for the wallet exists today. Every value the project has not decided is a named placeholder in square brackets; none is filled in here. The text below is written so that, once the placeholders are filled, sections 8.1 to 8.10 can be published as the programme page (for example a `SECURITY.md` at the root of the repository).

### 8.1 Scope

- The wallet's own code at the current `main` branch of `https://github.com/smwells25/shiba-wallet`: the engine packages under `packages/` and the app under `app/` (the files listed in section 3).
- The app as built from that code (Expo Go on Android, and the wallet's own Android development and release builds made as in `docs/RELEASE.md`, "Reproducible builds").
- The accuracy of the wallet's statements about third-party contracts: a screen, refusal or document sentence that tells the user something false about what a contract can or cannot do is in scope even though the contract itself is not.
- The repository's guard scripts (`scripts/githooks/secret-scan.mjs`, `scripts/ci/offline-guard.mjs`, `scripts/audit/verify-pins.mjs`) where a weakness would let a secret or an unchecked address through.

### 8.2 Out of scope

- The deployed third-party contracts themselves (section 4.1) and the services in section 4.2. Reports about them go to their vendors; the programme page should link each vendor's channel where one exists (`[VENDOR CHANNELS — to be listed when published]`; the record found none for Kernel, `docs/DISCLOSURE_FINDINGS.md` section 8.6).
- The test networks' own faucets, explorers and RPC providers; denial of service against public infrastructure; social engineering of the project's people; physical attacks.
- Findings that need a rooted or jailbroken phone, a compromised operating system, or physical access to an unlocked phone with the app open (`docs/THREAT_MODEL.md` section 1.3).
- The project's development wallet and keys, and any mainnet funds of anyone.
- Findings already listed in `docs/THREAT_MODEL.md` as open or accepted, unless the report shows a materially worse impact than recorded (section 6 lists the main ones).

### 8.3 Severity and rewards

Severity follows the threat model's ratings (`docs/THREAT_MODEL.md`, "How to read this document"). The project decides the final severity after reproducing the report.

| Severity | Meaning (examples) | Reward |
|---|---|---|
| Critical | Loss of funds for many users without any user mistake: signing without approval, a key leaving the device, a derivation error that sends funds to an address the phrase does not control | `[REWARD — CRITICAL — Chairperson]` |
| High | Loss of all funds controlled by an affected key or account, or a way around a stated on-screen protection (an approval gate, a readiness refusal, the duress isolation) | `[REWARD — HIGH — Chairperson]` |
| Medium | Loss of some funds, exposure of linkable private data, or a stuck account | `[REWARD — MEDIUM — Chairperson]` |
| Low | Inconvenience, privacy loss of public data, a refused operation, or misleading but non-exploitable text | `[REWARD — LOW — Chairperson]` |

`[REWARD CURRENCY AND PAYMENT METHOD — Chairperson]` · `[IDENTITY OR TAX CHECKS BEFORE PAYMENT, IF ANY — counsel]` · `[MAXIMUM TOTAL BUDGET PER PERIOD — Chairperson]`.

### 8.4 What a report must contain

- The commit hash the finding applies to, and the build (Expo Go, development build or release build, and its SHA-256 if it is one of the builds listed in `docs/RELEASE.md`).
- The network (a test network only) and, for an on-chain effect, the transaction or UserOperation hashes.
- Step-by-step reproduction from a fresh wallet the researcher created, with the exact screens, inputs and expected versus observed results; a script where the engine is involved.
- The impact the researcher believes it has, mapped to section 8.3.
- No real person's key, phrase or data; no secret of the project's.

### 8.5 Rules of engagement

- Test networks only (Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia, Hoodi) until a mainnet profile exists; researchers use their own test wallets and test funds (`docs/AUDIT_SCOPE.md` section 2.4 describes the setup).
- Never touch anyone's mainnet funds, never attack the project's development wallet, and stop and report as soon as a finding is demonstrated.
- Do not run load against public endpoints, bundlers or relays.
- Keep the finding confidential until the disclosure date agreed under section 8.7.

### 8.6 Safe harbour

`[SAFE-HARBOUR TEXT — counsel]`: the project's commitment not to pursue researchers who follow these rules in good faith. It must be written or approved by counsel; this document proposes none.

### 8.7 Response and disclosure

- Acknowledgement of a report within `[ACKNOWLEDGEMENT TIME — Chairperson]`.
- A first assessment (reproduced or not, provisional severity) within `[ASSESSMENT TIME — Chairperson]`.
- A fix or a mitigation plan within `[FIX TARGET PER SEVERITY — Chairperson]`.
- Coordinated disclosure: public details after the fix ships or after `[DISCLOSURE WINDOW — Chairperson]`, whichever comes first, unless both sides agree otherwise. A finding that turns out to concern a third-party contract is passed to its vendor only with the reporter's consent and the Chairperson's decision (the project's standing rule on vendor disclosure, `AGENTS.md`).

### 8.8 Duplicates and eligibility

- The first complete report of a finding is eligible; later reports of the same root cause are duplicates.
- Findings already public in this repository (the threat model, `docs/DISCLOSURE_FINDINGS.md`, `AGENTS.md`) are not new.
- `[ELIGIBILITY EXCLUSIONS, FOR EXAMPLE PROJECT MEMBERS, CONTRACTORS AND AUDITORS UNDER CONTRACT — Chairperson]`.

### 8.9 Disclosure channel (to be set up)

- A dedicated address `[SECURITY CONTACT EMAIL — to be filled by the Chairperson]`, with `[PGP KEY OR OTHER ENCRYPTION — Chairperson]` if encrypted reports are wanted.
- A policy page `[POLICY PAGE URL — to be filled by the Chairperson]`, for example a `SECURITY.md` in the repository, and optionally GitHub's private vulnerability reporting on the repository `[ENABLE: YES / NO — Chairperson]`.
- `[THIRD-PARTY BOUNTY PLATFORM, IF ANY — Chairperson]`.

### 8.10 Relation to C2

The programme covers the wallet's own code. It does not answer condition C2, which asks for the Kernel vendor's bounty coverage (section 1.1); that still needs the vendor's written answer.

## 9. Decisions for the Chairperson

1. **Budget.** The total, and whether it covers the wallet's code only or also the Kernel modules (decision 2).
2. **Scope of C1.** Whether to (a) audit the wallet's code only and seek the vendor's reports for Kernel v3.3 and its modules separately; (b) extend this engagement to a review of the Kernel v3.1-to-v3.3 difference and the modules the wallet installs (permission policies and ECDSASigner, the weighted validator and RecoveryAction, WebAuthnValidator v0.0.3), as `docs/AA_FRAMEWORKS.md` section 17.2 suggests; or (c) defer. Only (b), or vendor reports that name those exact versions, would meet C1 as worded.
3. **Which firms.** This document recommends no firm. Selection criteria: published experience with ERC-4337, ERC-7579 modular accounts and EIP-7702; mobile key-storage experience on React Native (Android Keystore and iOS Keychain, biometric binding); published reports the project can read; ability to test on real Android and iOS devices; and, if decision 2(b) is chosen, Solidity review experience with Kernel or comparable account frameworks.
4. **Timing against the remaining phases.** Phase 22 changes security-relevant code (a native scrypt for the PIN, a passphrase lock, a BIP-39 passphrase hidden wallet, cold signing, an encrypted records backup; `AGENTS.md`, "Phase 22 plan"). Starting now reviews a moving target; starting after phase 22 reviews more. One option is to tag after phase 22 item 2 and audit questions 1 to 6 first.
5. **Whether the private classification is shared.** A private, CVE-style classification of the third-party findings exists and is shared at the Chairperson's discretion. Sharing it would save the auditors repeating that work for the out-of-scope contracts.
6. **Test funds.** Whether the auditors receive test-network funds from the project's development account, or fund their own wallets from faucets. In either case they receive no key of the project's.
7. **Devices.** Whether the engagement includes real-phone testing (W2, W3), which needs the Expo account and bundle identifiers that are still inputs (`docs/THREAT_MODEL.md` W5).
8. **The bounty.** Whether to publish the programme in section 8, when, and the values of its named placeholders (rewards, payment terms, response times, the disclosure window, the contact and the policy page); the safe-harbour text needs counsel.

---

## 10. What this document could not establish

- Which audit, if any, covers the deployed test-network code of Lido, Rocket Pool and Uniswap v3: not recorded.
- Which commits the LayerZero, Stargate and Circle CCTP audit reports cover: not recorded (`docs/BRIDGING.md` sections 14 and 15).
- Module-by-module code comparison of the permission modules, RecoveryAction and the WebAuthn validator on Base Sepolia and Arbitrum Sepolia: first listed here as not recorded; made on 2026-10-25 (section 5.7): byte-identical.
- Whether the Kernel stack's mainnet code read should count as "verified": the record disagreed with itself (section 5). The read is now repeatable (section 5.7) and agrees with the 2026-10-01 record; no mainnet deployment has been exercised, so the full test-network standard is still not met.
- Why the source comments call several chain-1 Sourcify records "full match" while Sourcify answers `match` today (section 6.3): whether the records changed or the comments misread them is not known.
- The exact suite counts at the commit to be tagged: they change with each slice; the runner prints them.
- The details of finding F-46: not in the repository.

---

## Glossary

- **Account abstraction:** letting a smart contract act as a user's account, so that rules (spending limits, recovery, multiple signers) live in the account itself.
- **BIP-32 / BIP-39 / BIP-44:** the standards for hierarchical key derivation, recovery phrases, and per-coin derivation paths. **BIP-85:** deriving child recovery phrases from a parent seed (used for the decoy wallet).
- **Bundler:** a service that collects ERC-4337 UserOperations and submits them to the EntryPoint.
- **CallPolicy:** a Kernel permission module that limits which contract, function and argument values a session key may call.
- **CAIP-2 / CAIP-19:** chain and asset identifiers (for example `eip155:11155111`).
- **Counterfactual address:** the address a smart account will have once deployed, computable in advance with CREATE2.
- **DVN (decentralized verifier network):** in LayerZero, a party that attests that a cross-chain message was sent.
- **Duress PIN / decoy wallet:** a second PIN that opens a different wallet, derived from the same phrase by BIP-85, for use under coercion.
- **EntryPoint:** the singleton ERC-4337 contract that validates and executes UserOperations; the wallet uses v0.7.
- **EOA (externally owned account):** an ordinary address controlled by one private key.
- **EIP-1559:** the transaction format with a base fee and a priority fee. **EIP-7702:** lets an EOA point its code at a contract (a "delegate"), here the Kernel implementation. **EIP-7708:** protocol-emitted logs for ETH transfers, active on Sepolia since the Glamsterdam fork.
- **ERC-1271 / ERC-6492 / ERC-7739:** how contracts validate signatures, how that works before deployment, and a defensive wrapper for typed-data signatures.
- **ERC-4337:** account abstraction through UserOperations, bundlers and the EntryPoint. **ERC-7579:** the modular-account standard Kernel implements. **ERC-7677:** the paymaster web-service interface. **ERC-5792 / ERC-7715:** the wallet call API for batches, and a draft standard for dApps to request session permissions.
- **Expo Go / development build:** Expo's general-purpose client app versus a build of the wallet itself; some native features exist only in the latter.
- **Guardian:** another key holder who can approve replacing a Kernel account's owner.
- **Kernel v3.3:** ZeroDev's ERC-7579 modular smart account, the wallet's smart-account implementation.
- **Paymaster:** a contract (and usually a service) that pays the network fee for a UserOperation, here in exchange for USDC.
- **Readiness switchboard:** `app/src/config/readiness.ts`, which allows or refuses each feature per network and cites the checklist items behind each decision.
- **Secure store:** `expo-secure-store`, the wrapper over the Android Keystore and iOS Keychain that holds the phrase and other secrets.
- **Session key:** a separate key allowed to act for a smart account within on-chain limits.
- **SLIP-0010 / SLIP-44:** ed25519 hierarchical derivation, and the registry of coin types used in derivation paths.
- **Storage seam:** `app/src/wallet/store-keys.ts`, the single module through which every persisted key name passes.
- **UserOperation:** an ERC-4337 operation, signed by (or for) a smart account and submitted by a bundler.
- **Weighted validator:** ZeroDev's WeightedECDSAValidator, used for guardians, heirs and multisig accounts.

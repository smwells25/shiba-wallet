# Smart-Account Framework Comparison (Phase 7)

This document compares the smart-account (Account Abstraction) frameworks the wallet could adopt for production. It was written for the Chairperson and engineering leadership. It was requested on 2026-10-01 so that phase 7 item 1, the ERC-7579 smart-account implementation, rests on evidence before the wallet commits to ZeroDev Kernel. It builds on, and in places corrects, `docs/AA_STACK.md` and `docs/SESSION_KEYS.md` (see section 18). It uses the vocabulary of `docs/ARCHITECTURE.md` sections 3 and 7, in particular ADRs D1 (one seed recovers everything), D4 (counterfactual CREATE2 accounts), D5 (vendor-neutral bundler and paymaster interfaces) and D6 (ERC-7579 modular accounts as the production target, EIP-7702 as the on-ramp for plain EOAs).

**How the evidence was gathered.** Every factual claim below comes from a source fetched between 2026-09-30 and 2026-10-01: official documentation, GitHub repositories and their source code, audit reports, bug-bounty pages, ERC/EIP texts, and two public dashboards. Citations are bracketed numbers such as [23], resolved in the References section at the end. Where no source could be found the text says "not found" or "unverified". Where sources conflict, both are given. Adoption and value figures are estimates by nature; each is labeled with its source, its methodology where stated, and its date. Some statements are conclusions drawn from reading contract source code rather than from a vendor statement. These are marked "(code reading)". Code reading is not an audit and can be wrong.

**Snapshot warning.** This market moves monthly. During this research alone we found one acquisition, two repository moves, a product rebrand, a deprecated SDK, and an unreleased major version on a default branch. Re-verify any fact here before acting on it, especially versions, addresses and bounty terms.

---

## 1. Executive summary

- **Recommendation: keep Kernel (ZeroDev) as the first ERC-7579 implementation, specifically the Kernel v3 line on EntryPoint v0.7, with three conditions attached.** Sepolia development under phase 7 item 1 can start now. Mainnet use waits on the conditions in section 17.
- **Why Kernel still wins on fit:**
  - It runs on the EntryPoint v0.7 the wallet already pins.
  - Its contracts and its permission (session-key) plugins are MIT-licensed.
  - Among native ERC-7579 accounts it has the largest adoption signal in independent dashboard data (section 8.2).
  - Kernel v3.3 is documented as an EIP-7702 delegation target on EntryPoint v0.7 today.
  - Its contracts are supported by the vendor-neutral permissionless.js library, so we can byte-test our own implementation against an independent one, as we did for SimpleAccount.
- **The evidence also shows weaknesses that the earlier documents did not record:**
  - No public bug bounty for Kernel was found.
  - No audit report was found for Kernel v3.2 or v3.3. Published audits cover v3.0, the factory, and a v3.1 increment.
  - The repository's default branch is an unreleased, unaudited "Kernel v4" targeting EntryPoint v0.9, which implies a future migration.
  - ZeroDev was acquired by Offchain Labs in August 2025.
- **The conditions on Kernel:**
  1. Obtain audit coverage for the exact version we ship.
  2. Get a written answer on bug-bounty coverage.
  3. Get a support horizon for v3 and a v3-to-v4 migration statement.
- **Second source: Biconomy Nexus.**
  - It has stronger security-process signals: five audit engagements, a $50,000 self-managed bounty, and a confirmed independent wallet adopter (Gemini Wallet).
  - Biconomy has, however, moved Nexus development into a new repository built around its own hosted execution network ("MEE"). It says it will not add new chains to its plain ERC-4337 infrastructure.
  - It disclosed and fixed an account-takeover issue for undeployed accounts in July 2026.
  - Its session-key module (Smart Sessions, co-authored with Rhinestone) is AGPL-3.0-licensed and marked beta.
- **High-value option: Safe.** Safe's core contract has by far the strongest record: the oldest codebase, formal verification, a $1,000,000 bounty, and the only published value-secured figure. However:
  - Its ERC-7579 route, the Rhinestone Safe7579 adapter, is outside Safe's bounty scope.
  - We found no audit of the adapter's current v2.0.0 release.
  - Safe's released contracts cannot be EIP-7702 delegation targets.
  - It suits a later high-value or multi-signature product, not the default consumer account.
- **Not recommended as the production default:**
  - Alchemy Modular Account v2 implements ERC-6900, not ERC-7579, which conflicts with ADR D6's module-portability rationale.
  - Coinbase Smart Wallet is pinned to EntryPoint v0.6 and is not modular.
  - Etherspot's modular account has thin audit coverage, no bounty was found, and Etherspot's own EIP-7702 path delegates to Kernel.
  - eth-infinitism SimpleAccount remains the testnet baseline only. It has no ERC-1271 signature validation, no session keys and no recovery.

---

## 2. Frameworks in scope

| Framework | What it is | Versions evaluated | Main sources |
|---|---|---|---|
| eth-infinitism SimpleAccount | The reference sample account that ships with the ERC-4337 EntryPoint. Our current Sepolia account. | SimpleAccount v0.7.0 (live in our app); v0.8/v0.9 SimpleAccount and Simple7702Account | [23]–[29] |
| Safe | Safe Smart Account (formerly Gnosis Safe) multisig contract, plus Safe4337Module for ERC-4337, the Safe passkey signer, the Candide social-recovery module, and Rhinestone's Safe7579 adapter | Safe v1.4.1 and v1.5.0; Safe4337Module v0.3.0; passkey module v0.2.1; recovery module v0.1.0; Safe7579 v2.0.0 | [30]–[56] |
| ZeroDev Kernel | ERC-7579 modular account | Kernel v3.0–v3.3 (released); "Kernel v4" on the default branch (unreleased) | [57]–[70] |
| Biconomy Nexus | ERC-7579 modular account (successor to Biconomy Smart Account v2) | Nexus v1.0.x–v1.2.x (bcnmy/nexus); Nexus 1.3.3 in "MEE contract suite" 2.2.3 (bcnmy/stx-contracts) | [71]–[83] |
| Alchemy Modular Account v2 | ERC-6900 modular account; Alchemy's LightAccount noted for context | MAv2 v2.0.0–v2.0.2 | [84]–[94] |
| Coinbase Smart Wallet | Multi-owner account with passkey owners; the account behind Coinbase's "Smart Wallet", later "Base Account" | v1.0.0 and v1.1.0 | [95]–[107] |
| Etherspot Modular Account | ERC-7579 modular account | v1.0.0 | [108]–[112] |

Candide and Thirdweb were considered under the brief's "only if sourced" rule. Candide matters here as the author of Safe's social-recovery module and of a vendor-neutral TypeScript SDK (AbstractionKit, MIT, depends only on the noble libraries we already use) [37][113]. It is covered within the Safe sections and section 10. Thirdweb's account contracts are Apache-2.0 and target EntryPoint v0.7 [114]. We found no audited Thirdweb EIP-7702 delegate and no published Thirdweb adoption data, so Thirdweb was not evaluated as a contender.

---

## 3. The standards, and how each framework relates to them

Statuses are as listed in the official ERC and EIP repositories on 2026-10-01 [1]–[13].

| Standard | What it does | Status | Relevance to us |
|---|---|---|---|
| ERC-4337 | Account abstraction without consensus changes: UserOperations, bundlers, the EntryPoint contract, paymasters. Its current text lists EIP-7702 among its requirements. | Final (created 2021-09-29) [1] | Built and live-proven (SimpleAccount v0.7). |
| ERC-7579 | "Minimally required interfaces and behavior for modular smart accounts and modules to ensure interoperability across implementations." It defines module types 1 validator, 2 executor, 3 fallback, 4 hook. | **Draft** (created 2023-12-14) [2] | ADR D6 production target. See section 18 for a correction to SESSION_KEYS.md. |
| ERC-6900 | A competing modular-account standard with validation functions, execution functions and hooks. Author list includes Alchemy staff and an EntryPoint author. | Draft (created 2023-04-18) [3] | Used by Alchemy MAv2 only. Modules are not interchangeable with ERC-7579 modules. |
| ERC-7484 | A module-registry extension for ERC-7579, so accounts can check module attestations before installing. | Draft [13] | Relevant to our module allowlist (ARCHITECTURE 3.5). |
| EIP-7702 | A new transaction type that lets an EOA set code; the delegation indicator is `0xef0100 || address`. | Final [4]; activated on Ethereum mainnet with Pectra at timestamp 1746612311, which is 2025-05-07 10:05:11 UTC [5] | Phase 8 headline. |
| ERC-1271 | `isValidSignature(hash, signature)`: how a contract account signs messages. | Final [6] | Phase 7 item 3. Needed for dApp logins and off-chain orders. |
| ERC-6492 | Signature validation for counterfactual (not yet deployed) accounts; extends ERC-1271. | Final [7] | Phase 7 item 3. Our accounts are counterfactual until first use (D4). |
| ERC-7739 | A defensive rehashing scheme for ERC-1271 using nested EIP-712 structures. It prevents a signature from being replayed across several accounts owned by one key, while keeping typed data readable. | Draft [8] | Phase 7 item 3. Decides how readable sign-in prompts are. |
| ERC-7715 | `wallet_requestExecutionPermissions`: a dApp asks the wallet to grant scoped permissions. Requires ERC-7710. | Draft [9] | The standard request path for session keys. |
| ERC-7710 | A standard way for contracts to delegate capabilities through a `DelegationManager`. Requires ERC-7579. | Draft [10] | Pairs with ERC-7715. |
| EIP-5792 | `wallet_sendCalls`, `wallet_getCapabilities`, `wallet_getCallsStatus`: batched calls from dApps. | Final (Interface, created 2022-10-17) [11] | Phase 7 item 2. Uniswap already requests it. |
| ERC-7677 | A paymaster web-service capability and API (`pm_getPaymasterStubData`, `pm_getPaymasterData`). | Review [12] | Built (phase 5 item 2). |

**How each framework relates.** Details and citations are in the dimension sections. "Own" means an account-specific scheme rather than the standard.

| | SimpleAccount | Safe (+4337 module, +Safe7579) | Kernel v3 | Nexus | Alchemy MAv2 | Coinbase SW | Etherspot |
|---|---|---|---|---|---|---|---|
| ERC-4337 EntryPoint (released code) | v0.7 (our account); v0.8/v0.9 variants exist | v0.6 (module v0.2.0), v0.7 (module v0.3.0); Safe7579 hardcodes v0.7 | v0.6 (Kernel v2), v0.7 (v3.x) | v0.7 | v0.7 (v0.9 on unreleased branch) | **v0.6 only** | v0.7 |
| Module standard | none | native Safe modules; ERC-7579 via adapter | ERC-7579 | ERC-7579 | **ERC-6900** | none | ERC-7579 |
| ERC-1271 | **No** in SimpleAccount v0.7/v0.9 (code reading [25]); yes in Simple7702Account | yes (contract signatures; passkey signers are ERC-1271 contracts) | yes, wrapped in its own EIP-712 "Kernel" domain | yes | yes, own "ReplaySafeHash" wrapper | yes, own `replaySafeHash` | yes |
| ERC-7739 | not found | not found in source | not in v3.3 (own wrapper); listed for unreleased v4 [60] | **yes**, audited add-on [71] | not found (own wrapper; raw mode for 7702) | not found (own wrapper) | not found |
| ERC-7715 / 7710 | no | via Rhinestone Smart Sessions ("optimized for ERC-7715") | 7715 not found; an SDK-only ERC-7710 decorator exists | via Smart Sessions and MetaMask delegation toolkit in the SDK | not found | 7715 announced in 2024; current support not found | not found |
| EIP-7702 delegate (released) | Simple7702Account (EP v0.8/v0.9) | no (experimental, unaudited) | yes, v3.3 on EP v0.7 | yes, v1.2.0+ on EP v0.7 | yes, SemiModularAccount7702 on EP v0.7 | only through Coinbase's audited EIP7702Proxy | own account: not found; delegates to Kernel v3.3 |

ERC-6492 is a verifier-side standard. Any account deployed through a CREATE2 factory can be wrapped in an ERC-6492 envelope by the signing wallet, so it is not an account-specific feature and is not scored per framework.

---

## 4. Summary matrix

Cells are deliberately short; the detail and citations are in sections 5 to 16. "NF" means not found.

| Dimension | SimpleAccount | Safe (+Safe7579) | Kernel v3 | Nexus | Alchemy MAv2 | Coinbase SW | Etherspot |
|---|---|---|---|---|---|---|---|
| Signers | 1 ECDSA | n-of-m owners; passkeys (RIP-7212 + fallback) | ECDSA, passkeys (RIP-7212 + fallback), weighted multisig | ECDSA; passkeys/multisig via Rhinestone modules | ECDSA, passkeys; multisig only on MAv1 | 1-of-N ECDSA + passkey owners | multiple independent ECDSA owners |
| Session keys / policies | none | allowance module; Smart Sessions via Safe7579 | yes, MIT plugins (call, gas, rate, time, signature) | Smart Sessions (AGPL, beta) | on-chain hook modules | spend permissions only (ETH/ERC-20) | ERC-20 session keys |
| On-chain recovery | none | Candide module (14-day default delay); RecoveryHub (28-day) | guardian executor; weighted validator with delay | Rhinestone SocialRecovery (AGPL) | NF | extra owner keys; no delay | guardians, 60% quorum; no activation delay found |
| First release | EP v0.6: Apr 2023 (conflict: Mar 2023) | Gnosis Safe 2018 | Kernel v1: Jul 2023; v3.0: Apr 2024 | Oct 2024 | Feb or Mar 2025 (conflict) | Jun 2024 | Feb 2025 |
| Adoption signal | ~146k factory + ~3.0M 7702 activations | ~6.6M 4337 activations; 63.4M Safes total | ~1.03M factory + ~1.04M 7702 activations | ~159k + ~40k (all Biconomy) | ~286k MAv2 factory + ~407k 7702 (Alchemy) | ~3.9M factory activations | NF |
| Value secured (est.) | NF | $27.24B (Safe Foundation, Q2 2026) | NF | NF ("$500M+ processed") | NF | NF | NF |
| Audits | OZ ×3, Spearbit, Cantina (EntryPoint scope) | many (Ackee, Certora, Nethermind, OZ, G0); Safe7579: ChainLight, Ackee | ChainLight, Kalos, unnamed v3.1 auditor; none for v3.2/v3.3 | Cyfrin, Spearbit, Cantina, Zenith, Pashov | ChainLight, Quantstamp, Octane | Cantina ×2, Certora, Code4rena | KALOS, Shieldify |
| Formal verification | NF | yes (Runtime Verification, Certora) | internal only, unreleased v4 | no (DeFiSafety) | NF | yes (Certora, partial) | NF |
| Bug bounty max | $250k (EF; EntryPoint only, accounts out of scope) | $1,000,000 (Safe core; not Safe7579) | NF | $50,000 (self-run) | $100,000 (Cantina) | $500,000 tier-1 critical (Cantina) | NF |
| Disclosed vulns | EntryPoint fixes (v0.8, v0.9) | small bounties; Bybit was UI/infra, not contract | ERC-1271 replay (2023) | GHSA-q47q (2026, fixed) | CVE-2025-46834 (low) | audit-stage only | NF |
| Contract license | MIT (v0.8+); GPL-3.0 (v0.7); EntryPoint GPL-3.0 | LGPL-3.0; recovery GPL-3.0; Safe7579 GPL-3.0/mixed | MIT (4337 interfaces GPL) | MIT; Smart Sessions AGPL | GPL-3.0-or-later | MIT | MIT (+6 AGPL files) |
| Upgrade path | UUPS, owner only | migration by owner-approved delegatecall | ERC-1967, account only | UUPS, account only | ERC-1967, account only; 7702 variant immutable | UUPS, any owner, cross-chain replayable | NF in code; factory owner sets implementation for new accounts |
| Vendor admin over accounts | none found | none found | none found (vendor owns factory staker) | none found | none found | none found | none found |
| Third-party bundler/paymaster | yes | yes | yes (documented) | contracts yes; vendor drifting to MEE | yes (documented) | yes (EP v0.6 bundlers) | custom bundler URL supported |
| EIP-7702 target | Simple7702Account (EP v0.8/0.9) | no (experimental) | yes (EP v0.7) | yes (EP v0.7) | yes (EP v0.7) | via proxy only | via Kernel |
| Fit with our constraints | testnet baseline | high-value option later | **primary, with conditions** | second source | conflicts with D6 | conflicts with EP pin and D6 | no |

---

## 5. Dimension 1: Authentication

**SimpleAccount.**
- A single secp256k1 ECDSA owner [25].
- The signed payload changed between versions. In v0.7 the owner signs an EIP-191 message over the userOpHash, which is what our engine does today. In v0.9 the owner signs the raw userOpHash, because v0.8 made the hash EIP-712-compatible [23][25].
- There is no owner-rotation function. Changing the owner needs a UUPS upgrade to different code (code reading).
- Simple7702Account accepts signatures from the EOA's own key [28].

**Safe.**
- Safe is an n-of-m owner multisig: "a configurable threshold of owners must approve a transaction". Owners "can be: EOAs; other smart accounts; passkeys" [32].
- Owners are added, removed and replaced through `OwnerManager` [32].
- Passkeys are deployed as ERC-1271 signer contracts that become Safe owners. They are compatible with Safe ≥1.3.0 [35][36].
- The P-256 verification tries a precompile address first and falls back to a Solidity verifier [35].
- The current main-branch changelog removes the bundled FreshCryptoLib verifier because it "has some known bugs (nothing security critical ATM)" [35].
- Privacy note: the passkey's authenticator identifier (AAGUID) "is published on-chain and can be used to determine the kind of authenticator" [35].
- MPC: not a native feature (not found).

**Kernel v3.**
- Signers include secp256k1 ECDSA, WebAuthn passkeys, and a `WeightedValidator` / `WeightedECDSAValidator` that combines several weighted signers (ECDSA and passkeys) with a threshold [63].
- The passkey validator is "progressive". It uses the RIP-7212 precompile (or EIP-7951 on Ethereum) where available and otherwise a Solidity verifier (Daimo or FreshCryptoLib). ZeroDev quotes about 3,450 gas versus 300,000–400,000 gas for the two paths [63][70].
- **Vendor-service coupling.** ZeroDev's passkey flow uses a "passkey server". The docs say it can be self-hosted, and warn: "If the passkey server is lost, only users who have not yet deployed their accounts ... will be unable to recover their accounts" [63].
- The root signer is rotated with `changeRootValidator`, callable only by the EntryPoint, the account itself, or the root validator [58].
- MPC is handled by third-party signer integrations, not a Kernel module [63].

**Nexus.**
- The default validator, K1Validator, stores one ECDSA owner per account. It has `transferOwnership` and, from v1.0.1, ERC-7739 support [71][72].
- In the newer MEE suites the default validator restricts owners to EOAs, including EIP-7702-delegated EOAs [75].
- Passkeys:
  - Biconomy's own `@biconomy/passkey` package is at version 0.0.2, last modified May 2025. It enables the RIP-7212 precompile only for chain ids 80001 and 137 [80].
  - Pimlico describes Nexus passkeys as "supported via Rhinestone's Passkeys Validator" [15].
- Multisig is provided through Rhinestone's OwnableValidator, which Biconomy's SDK re-exports [80].
- MPC: not a Nexus module (not found).

**Alchemy MAv2.**
- Built-in modules are `SingleSignerValidationModule` (EOA or contract signer) and `WebAuthnValidationModule` [84].
- WebAuthn uses Base's webauthn-sol library: RIP-7212 first, then FreshCryptoLib, which relies on a precompile that "is not supported on some chains" [115].
- Alchemy's k-of-n multisig plugin exists only for MAv1 (ERC-6900 v0.7) [84].
- Owner-rotation documentation now redirects to a deprecation page, so the mechanism was not confirmed from a fetched page.

**Coinbase Smart Wallet.**
- Supports "a practically unlimited number of concurrent owners", either Ethereum addresses or P-256 passkey public keys. "Each owner can transact independently, without sign off from any other owner" [95]. This is 1-of-N; there is no threshold.
- Passkeys use RIP-7212 with a FreshCryptoLib fallback [115].
- Owners are added and removed by any existing owner. Owner changes can be replayed across chains through `executeWithoutChainIdValidation` [95].

**Etherspot.**
- Multiple independent ECDSA owners and guardians (`addOwner`, `addGuardian`) [108].
- No passkey validator, threshold multisig or MPC was found [108].

**Signer swap summary.** Every framework except SimpleAccount can rotate its root signer through an on-chain call authorized by the current signer set. See section 16 for why owner rotation interacts with ADR D1.

---

## 6. Dimension 2: Authorization (session keys, policies, revocation)

**SimpleAccount.** None. Only the owner or the EntryPoint may execute [25].

**Safe.**
- The native Allowance Module grants per-token spending allowances to delegates. Allowances are revoked by an owner transaction (`deleteAllowance` or `removeDelegate`) [34].
- Modules "can bypass standard authorization logic" and are "security-critical"; installing one requires the owner threshold [32].
- Safe states that through the Safe7579 adapter, audited modules "developed by Rhinestone will be available" to Safe accounts [50].
- General session keys come through Safe7579 plus Rhinestone's Smart Sessions module. Smart Sessions is "optimized for ERC-7715 flow for requesting permissions" [55].
- Smart Sessions is licensed AGPL-3.0-only and its README says: "This software is in beta and should be used at your own risk" [55].

**Kernel v3.**
- ZeroDev's permission model is "Permission = 1 signer + N policies + 1 action". The signers are ECDSA, WebAuthn and multisig. The policies are sudo, call (contract, function and parameter constraints), gas, signature, rate limit and timestamp [63].
- A spending-limit hook was in scope of the v3.1 incremental audit [59].
- Revocation is on-chain: uninstall the permission plugin with a UserOperation [63]. Kernel also exposes `invalidateNonce` (code reading [58]).
- ERC-7715: not found in ZeroDev's documentation or SDK source [63].
- An ERC-7710 decorator exists in an SDK plugin package, but with no documentation page, so its maturity is unverified [63].
- The permission plugins are MIT-licensed [70].
- **Unverified:** whether Kernel's permission plugins install on non-Kernel ERC-7579 accounts. ERC-7579 promises portability for standard module types, but Kernel's permission system uses Kernel's own validation-type encoding (code reading [58]).

**Nexus.**
- Session keys come through Smart Sessions (AGPL, beta, co-authored by Rhinestone and Biconomy) [55].
- Biconomy's SDK exposes sudo, universal (parameter rules), timeframe, spending-limit and usage-limit policies [76].
- Revocation is on-chain via `removeSession` and related disable functions, called by the account [55].
- Biconomy states that MEE "can request execution through an ERC-7715 delegation and claim it on an ERC-7710 compliant contract", using MetaMask's delegation toolkit [82].
- Nexus can force-remove a malicious hook after a one-day emergency timelock [71].

**Alchemy MAv2.**
- On-chain hook modules: allowlists with ERC-20 spend limits, native-token limits, a paymaster guard, and time ranges. Alchemy states "these permissions are validated onchain" [84][89].
- Session keys are removed by uninstalling the validation through a UserOperation [89].
- Alchemy also offers a hosted session API (`wallet_createSession`) that requires an Alchemy API key [89].
- ERC-7715/7710: not found.

**Coinbase Smart Wallet.**
- "Spend Permissions" live in a separate singleton that is added as an owner of the wallet. It is limited to native and ERC-20 tokens on a recurring period, and "does not enable apps to make arbitrary external calls" [100]. Users revoke with `SpendPermissionManager.revoke` [100].
- A Coinbase engineer's August 2024 post announced ERC-7715 session keys as "coming soon to mainnet". Current support was not found.

**Etherspot.**
- An ERC-20 session-key validator with spending limits, validity periods, pause and rotation, audited by Shieldify [108].
- A general SessionKeyValidator exists, but no audit report for it was found [108].

---

## 7. Dimension 3: Recovery

All recovery mechanisms below are on-chain unless stated otherwise.

**SimpleAccount.** None; recovery equals the owner key [25].

**Safe.**
- The Candide Social Recovery Module, re-published by Safe as `modules/recovery` v0.1.0, lets guardians propose a new owner. The current owners can cancel until a delay expires; "by default this module uses a recovery period of 14 days" [37].
- It is GPL-3.0 and was audited by Ackee, Nethermind and Certora. The Certora engagement recorded 15 findings (1 medium), all acknowledged rather than fixed [34][37].
- On Safe 1.5+ the module "assumes that the module guard of the Safe, if any, is not malicious" [37].
- Safe{RecoveryHub}, a Safe{Wallet} product launched December 2023, uses the Zodiac Delay Modifier with "a default delay of 28 days" [38].
- Its launch announcement named optional custodial recoverers (Sygnum, CoinCover). Whether those are still offered was not found [38].

**Kernel v3.**
- Guardian recovery works through a recovery executor (`doRecovery`) on the ECDSA validator, and multiple guardians use the weighted multisig validator, which has a `delay` field [63][58].
- ZeroDev hosts a recovery portal but states that "even if the portal goes down or ceases to exist, a guardian can always interact with the smart account directly" [63].
- The recovery contracts' audits (Kalos, December 2023 and February 2024) predate Kernel v3 [59].

**Nexus.**
- Biconomy's documentation advertises guardian-based social recovery but names no Nexus-specific module.
- The usable option found is Rhinestone's SocialRecovery module (AGPL-3.0-only) [56][77].
- Its time-delay behavior was not checked.

**Alchemy MAv2.**
- No recovery module was found in the v2.0.2 module list [84].
- Alchemy's vendor-mediated signer product (Account Kit) is deprecated in favor of third-party signer providers [92].

**Coinbase Smart Wallet.**
- "A recovery key is a standard Ethereum private key ... registered onchain as an owner". It has "equivalent permissions to passkey owners", with no guardians or delay [104].
- The user-facing recovery flow is Coinbase-hosted; its help page could not be fetched.

**Etherspot.**
- Guardians co-sign a new-owner proposal. "Must meet minimum threshold of 60% of total guardians" [108].
- From code reading, the new owner is added immediately once the quorum is reached, and the proposal timelock only gates discarding a proposal. Etherspot should confirm this before anyone relies on it.

---

## 8. Dimension 4: Security and maturity

### 8.1 Age and versions

| Framework | First release or deployment | Current release |
|---|---|---|
| SimpleAccount / EntryPoint | EntryPoint v0.6.0 GitHub release April 2023 [23]. A secondary source claims v0.6 was on mainnet on 1 March 2023; this conflicts with the release date and was not confirmed from a primary source. | v0.9.0, November 2025 [23] |
| Safe | "Gnosis Safe was born in 2018" [30]; exact first mainnet date not found | v1.5.0, July 2025; v1.4.1, June 2023 [31] |
| Kernel | Earliest GitHub release v1.0.1, July 2023; v3.0, April 2024 [57] | v3.3, April 2025 [57]. Default branch "Kernel v4" is unreleased: its release manifest has empty deployments [62] |
| Nexus | Mainnet launch 24 October 2024, derived from a Biconomy post title and the v1.0.1 tag date; the post itself could not be fetched [72] | Nexus 1.3.3 in MEE suite 2.2.3, which Biconomy says to use "for all new accounts" [73]. bcnmy/nexus last released v1.2.0 in April 2025 [72] |
| Alchemy MAv2 | GitHub v2.0.0 release dated 2025-03-18 [85]; ethereum.org says "released in feb 2025" [116]; its bounty began 2025-02-05 [87] (sources conflict) | v2.0.2, August 2026 [85] |
| Coinbase Smart Wallet | Launch reported for 5 June 2024 [106]; v1.0.0 release 2024-06-10 [96] | v1.1.0, July 2025 [96] |
| Etherspot | v1.0.0, February 2025 [108] | v1.0.0 (only release) |

### 8.2 Adoption and value secured

All figures are estimates. They count different things and must not be compared as if they were the same metric.

**BundleBear ERC-4337 account activations, weekly new accounts by provider.**
- Coverage: the chart covers BundleBear's tracked chains (Base, Polygon, Worldchain, Arbitrum, Linea, Optimism, Arbitrum Nova, Celo, Avalanche, BSC, Ethereum, Gnosis) [16].
- Methodology: we summed the chart's embedded weekly data for the 56 weeks from 2025-09-01 to 2026-09-28. This is our own aggregation of BundleBear's labels. Each week shows the leading providers plus an "Other" bucket, so smaller providers are undercounted.
- Results:
  - Safe4337Module: 6,568,029
  - Coinbase smart wallet factory: 3,864,598
  - EIP-7702 "Simple 7702Account": 3,005,982
  - EIP-7702 "Zerodev": 1,039,065
  - Kernel factory ("zerodev_kernel"): 1,026,883
  - EIP-7702 "Alchemy": 407,215
  - Factory `0x0000…17c61b…fecd`: 285,897. This address is Alchemy's MAv2 AccountFactory v2.0.0 per Alchemy's address list [84].
  - Biconomy factory: 159,026
  - SimpleAccount factory: 146,460
  - Alchemy (factory label): 72,743
  - EIP-7702 "Biconomy": 40,247
  - Kernel v3.3 factory `0x2577…75e9` alone: 15,353
- Etherspot did not appear.

**BundleBear EIP-7702 "Live Smart Accounts by Authorized Contract"** (data through 2026-09-30) [17]:
- "Simple 7702Account" 2,396,659
- "Crime" 2,337,224
- "Coinbase Wallet" 2,056,632
- "Metamask Delegator" 1,268,231

That a dashboard labels over two million delegations "Crime" is a material risk signal for EIP-7702 generally (see section 15).

**Pimlico's account comparison** gives "accounts created (6 months)":
- Kernel: 133k (v3) and 771k (v2)
- Nexus: 78
- Biconomy v2 (deprecated): 224k
- Safe: 34k
- SimpleAccount: 1.5M
- LightAccount: 7.3M

No as-of date is stated, and the counts appear to come from Pimlico's own statistics service, so they likely reflect Pimlico's traffic rather than the whole market [15].

**Vendor-published figures** (no methodology stated unless noted):
- **Safe:** "Total Safe accounts reached 63.4M" and Safe accounts "held $27.24B in self-custodied assets at quarter-end" (Q2 2026 report, published 29 July 2026) [39].
  - Safe's homepage shows "$60B+ Total value secured" and "57M+ Wallets deployed" with no date [41]. The two Safe sources conflict, and the dated report is the more credible.
  - This is the only value-secured figure found for any framework.
- **ZeroDev:** "6M+ smart accounts" (docs) and "more than 5 million smart accounts" (August 2025) [63][67].
- **Biconomy:** "2M+ smart accounts, $500M+ value processed" [77]. That is value processed, not value secured, and appears to include the deprecated v2 account.
- **Coinbase:** a press report citing Dune data put Smart Wallet creations at 1,074,277 in August 2025 [107].
- **Value secured for Kernel, Nexus, MAv2, Coinbase, Etherspot:** not found. DefiLlama does not track smart-account balances; its hacks dataset was checked for incidents only.

### 8.3 Audits

| Framework | Audits found (firm, date, scope) |
|---|---|
| SimpleAccount / EntryPoint | OpenZeppelin 2022 (reference implementation incl. samples) [26]. OpenZeppelin Feb 2023 incremental, scope included `samples/SimpleAccount.sol` (27 issues, 1 high, resolved) [27]. OpenZeppelin Feb 2024, v0.7 (24 issues resolved) [27]. Spearbit Mar 2025, v0.8; scope "the core network", accounts out of scope [27]. Cantina Nov 2025, v0.9; findings cite the Simple account files [27]. |
| Safe | Safe v1.5.0: Certora and Ackee. v1.4.0/1.4.1: Ackee. v1.3.0: G0 Group, Certora, Nethermind [30]. Safe4337Module v0.3.0: Ackee, Certora, Nethermind [34]. Passkey v0.2.1: Hats Finance competition, Certora, Nethermind [35]. Recovery v0.1.0: Ackee, Nethermind, Certora [37]. **Safe7579:** ChainLight (v1.1) and Ackee (June–July 2024, 28 findings, the most severe allowing "front-run the Safe deployment using the Launchpad and take over control"; the public summary does not state fix status) [48][49]. **No audit of Safe7579 v2.0.0 was found** [48]. |
| Kernel | ChainLight, Kernel v3 (ERC-7579), 11 March–5 April 2024: 12 findings, 2 high, patched. Kalos, v3 factory, April 2024: no findings. "v3.1 incremental audit", 27 May–9 June 2024, auditor Felix Kim, no firm named: WebAuthn, multi-chain WebAuthn, weighted validator, spending-limit hook. Kalos WebAuthn plugin, February 2024. Kalos recovery (v2-era), December 2023 and February 2024 [59]. **No audit of v3.2, v3.3 or the 7702 change set was found; no third-party audit of v4.** ZeroDev's docs link to an audits folder on the v4 branch that returns 404 [63]. |
| Nexus | CodeHawks/Cyfrin competition, July 2024 (report 16 Sep 2024; README says 17 Sep): 4 high, 4 medium. Spearbit/Cantina (report 4 Mar 2025): 61 findings, 15 acknowledged, incl. an open note that ERC-7484 registry checks are still missing for validators. Cantina ERC-7739 add-on, Nov 2024. Zenith, Mar 2025 (diff only). Pashov, Mar 2025 [71]. A Pashov review of Nexus 1.3.3 in July 2026 is claimed in SECURITY.md; the report was not found [71]. **Smart Sessions:** Cantina core (Oct 2024, 7 high) and policies (1 critical); Renascence (Nov and Dec 2024); ChainLight (Jul 2025, no high) [55]. |
| Alchemy MAv2 | ChainLight, Oct–Nov 2024: 10 findings, 2 high, patched. Quantstamp, Oct–Nov 2024: 23 findings, 2 high, fixed; its coverage table shows 0% for `SemiModularAccount7702.sol`. Octane, Aug 2026, a narrow review of the 7702 bare-EOA signature change [86]. MAv1: Spearbit and Quantstamp, early 2024 [86]. |
| Coinbase SW | Cantina Dec 2023 (5 low). Certora Feb 2024 (formal verification plus one medium, addressed). Code4rena Mar 2024 (1 high: owner-removal replay; 2 medium). Cantina Apr 2024 (no risk findings) [97][98]. No v1.1-specific audit listed [97]. EIP7702Proxy: Cantina Feb and Mar 2025, public competition Apr 2025 [101]. |
| Etherspot | KALOS, March 2024 (2 high, 1 low, patched; audited in the predecessor repository). Shieldify, May 2024, ERC-20 session-key validator only [108]. No audit found for other validators or hooks. |

### 8.4 Formal verification

- **Safe:** Runtime Verification verified Safe v1.0.0 and its critical findings were fixed. The repository carries Certora specifications for execution, guards, modules, owners, signatures and setup. Safe's own properties file states "Verification doesn't hold for the `DELEGATECALL` operation" [44].
- **Coinbase:** Certora's February 2024 report proved properties such as "initialize() can't be called twice" and access control on owner functions. Loops were unrolled to two iterations and "upgrade functionality was omitted" [97].
- **Candide recovery module:** Certora configurations exist; results were not read [37].
- **Kernel:** the unreleased v4 branch contains Certora and Halmos harnesses. Its notes record internal findings fixed during formal verification and one invariant accepted as "unprovable under the current CVL summary set" (21 May 2026) [61]. There is no published third-party formal-verification report.
- **Nexus:** DeFiSafety's October 2024 review answers "Has the protocol undergone Formal Verification? No" [81].
- **SimpleAccount/EntryPoint, Alchemy MAv2, Etherspot:** not found.

### 8.5 Bug bounties

| Framework | Program | Maximum |
|---|---|---|
| EntryPoint (not accounts) | Ethereum Foundation on HackenProof since September 2024. Scope is "core and utils" directories; "Attacks on any specific bundler, account or paymaster" are out of scope. docs.erc4337.io says only v0.6–v0.8 are eligible; HackenProof also lists v0.9 (sources conflict) [21][22]. | $250,000 critical |
| Safe | Self-run by email; paid in USDC. Covers Safe v1.1.1–v1.5.0, Safe4337Module v0.3.0, passkey v0.2.1, recovery v0.1.0. **Safe7579 is not listed** [42]. | $1,000,000 |
| Kernel | **Not found.** GitHub shows "No security policy detected"; no Immunefi or Cantina program was found [69]. | not found |
| Nexus | Self-managed, per SECURITY.md [71]. | $50,000 critical |
| Alchemy MAv2 | Cantina, from February 2025, KYC required, scope v2.0.x [87]. | $100,000 critical |
| Coinbase | Cantina, "5 million-dollar" headline [95]; the $5M tier covers Base, cbBTC and cbETH. Smart Wallet contracts sit in Tier 1 [99]. | $500,000 (Tier 1 critical) |
| Etherspot | Not found; security contact email only [108]. | not found |

### 8.6 Incidents and disclosed vulnerabilities

- **Cross-account ERC-1271 replay (October 2023).** Alchemy disclosed a class of signature replay that affected LightAccount, Kernel, Biconomy and others. Alchemy reported that "no funds are at risk" and that all affected accounts "have either acknowledged the risk or shipped a fix". Its blog also stated that "Gnosis Safe was not vulnerable" [19]. This is the problem ERC-7739 standardizes a defense against.
- **EntryPoint:**
  - v0.8 fixed bounty-reported issues, including an initCode front-run [23].
  - In February 2026 the Ethereum Foundation paid $50,000 for "a censorship and griefing vector, not a fund-theft vector" in ERC-4337; DL News named Biconomy among the heaviest users of the affected transaction type [20].
  - Which EntryPoint release fixed it was not confirmed from a primary source.
- **Safe:**
  - Past contract bounties were small, at most $30,000 for an Allowance Module replay [43].
  - The February 2025 Bybit loss was not a contract bug. Investigators found that "JavaScript resources ... serving Safe{Wallet}'s web interface were modified", and Bybit's signers then approved a malicious delegatecall [45]. Safe stated its contracts were unaffected [46].
  - The lesson for us: what the user is shown before signing is the attack surface, which is why our wallet decodes and simulates before signing.
- **Nexus:** advisory GHSA-q47q-h6x2-f5qg (fix committed 24 July 2026).
  - A stale transient-storage flag let an attacker re-initialize a classic Nexus account (v1.2.0+) "only while they hold a balance and have not yet been deployed".
  - Fixed in Nexus 1.3.3; EIP-7702 accounts were unaffected [71].
  - This is directly relevant to our D4 design, where users routinely receive funds at undeployed counterfactual addresses.
- **Alchemy MAv2:** CVE-2025-46834 (severity Low, May 2025). The allowlist module could be bypassed via `executeUserOp`, "effectively allowing any session key to bypass any access control restrictions" [88]. The advisory lists v2.1.x as patched, but no v2.1.x release exists; a GitHub comparison indicates the fix is in v2.0.1 [88].
- **Kernel, Coinbase, Etherspot:** no post-launch incident found, beyond the 2023 replay class for Kernel.

---

## 9. Dimension 5: Development activity

| Framework | Repository | Latest release | Cadence | Organizations |
|---|---|---|---|---|
| SimpleAccount | github.com/eth-infinitism/account-abstraction | v0.9.0, Nov 2025 [23] | about yearly | Ethereum Foundation-funded [26] |
| Safe | github.com/safe-fndn/safe-smart-account; safe-fndn/safe-modules (both moved from the safe-global org; old URLs redirect) | v1.5.0 Jul 2025; modules through Feb 2026; SDK Sep 2026 [31][51] | slow core, active SDK | Safe Ecosystem Foundation, with Candide (recovery) and Rhinestone (Safe7579) |
| Kernel | github.com/zerodevapp/kernel | v3.3, Apr 2025; v4 work on `dev` (last commit July 2026) [57][60] | three v3 releases in 2024, one in 2025, none since | single vendor (ZeroDev, now part of Offchain Labs) [66] |
| Nexus | github.com/bcnmy/nexus (1.2.x lineage); github.com/bcnmy/stx-contracts (current 1.3.x) | v1.2.0 Apr 2025 on GitHub; MEE suite 2.2.3 per docs [72][73] | irregular; lineage split | Biconomy, with Rhinestone co-authorship |
| Alchemy MAv2 | github.com/alchemyplatform/modular-account | v2.0.2, Aug 2026 [85] | 1–2 per year | single vendor |
| Coinbase SW | github.com/coinbase/smart-wallet | v1.1.0, Jul 2025 [96] | two releases total | single vendor (Coinbase / Base) |
| Etherspot | github.com/etherspot/etherspot-modular-accounts | v1.0.0, Feb 2025; last commit Oct 2025 [108] | one release | single vendor |

---

## 10. Dimension 6: Adoption by other wallets and products

- **Safe:**
  - The Safe Foundation states that the World app relaunched "with user wallets powered by Safe smart accounts" (vendor claim) [39].
  - It lists infrastructure partners including Candide, Pimlico and Rhinestone [40].
- **Kernel:**
  - Offchain Labs' acquisition announcement names APECHAIN, Conduit, Crossmint, DeFi.app, DIMO, Infinex and Rodeo (vendor claims) [66].
  - Independently, Etherspot's transaction kit uses Kernel v3.3 as its EIP-7702 delegate [109].
  - Pimlico's permissionless.js implements Kernel accounts for Kernel versions 0.2.x–0.3.3 [18].
- **Nexus:**
  - Gemini Wallet, confirmed by Gemini itself: "We chose the Biconomy Nexus implementation of ERC-7579 because it exposes a lean upgrade surface, aligns closely with the canonical ERC-4337 EntryPoint, and arrives already gas-optimised and audited" [78]. Biconomy's own announcement describes Gemini Wallet as "using Biconomy Nexus Account under the hood" [79].
  - permissionless.js supports Nexus, but Pimlico documents that "only version 1.0.0 is currently supported" [83].
- **Alchemy MAv2:** the default account of Alchemy's own Wallet APIs and its default EIP-7702 delegate [89][90]. No third-party wallet adopter was found.
- **Coinbase Smart Wallet:** Coinbase's own wallet, branded Smart Wallet, then Base Account, then "Base Account is now Coinbase Wallet" (September 2026) [105]. viem supports the account natively [103].
- **Etherspot:** Pillar's PillarX (an affiliated product) [112].
- **SimpleAccount:** Pimlico calls it a reference implementation "not a production-ready smart account" on one page and "widely used in production" on another [15][29].

---

## 11. Dimension 7: Vendor lock-in

**Contract level.** Every framework's contracts work with the canonical EntryPoint and therefore with any compliant bundler.
- ZeroDev: "bundlers are perfectly interoperable between different providers", and an ERC-7677 paymaster URL can be passed directly [63].
- Alchemy: "You can use any ERC-4337 bundler with the v5 stack ... point it wherever you like", and supports any ERC-7677 paymaster [91].
- Gemini runs Nexus on Gelato's bundler: "swapping bundler providers ... is a configuration file, not a redeploy" [78].
- Safe's 4337 module takes its EntryPoint from its constructor [34].
- This matches ADR D5: vendors stay configuration entries.

**Where lock-in actually appears:**
- **Kernel:**
  - The passkey server (self-hostable) and the optional recovery portal [63].
  - ZeroDev owns the "meta factory" staking contract that gates which factories can deploy through it; it has no power over deployed accounts (code reading [58]).
  - Lock-in is low.
- **Nexus:**
  - Biconomy's SDK defaults to Biconomy's bundler with a hard-coded public key [80].
  - Its paymaster functionality is now delivered "through the MEE (Modular Execution Environment) stack" [76].
  - Its 4337 infrastructure is "not supporting new chains" [76].
  - The MEE Node Paymaster is deliberately "incompatible with public ERC-4337 mempools" [75].
  - The contracts are portable, but the vendor's roadmap is moving away from the open ERC-4337 path we chose in D5.
- **Alchemy:** contracts and the v5 SDK are portable; the hosted session-key API and the Wallet APIs need an Alchemy key [89].
- **Coinbase:** spend permissions and sub-accounts rely on Coinbase singletons and SDK flows. The vendor SDK is a dApp-side connector to Coinbase's own wallet, not an embeddable account SDK for a third-party wallet [100][95].
- **Safe:**
  - The Relay Kit SDK defaults to Pimlico-specific gas methods but includes a generic estimator and ERC-7677 support.
  - Safe's hosted Transaction Service needs an API key but can be self-hosted [51].
  - Safe's trademark is not licensed with the code [53].

**Module portability.** ERC-7579 accounts (Kernel, Nexus, Safe via Safe7579, Etherspot) can in principle share modules; the erc7579.com directory, maintained by Rhinestone, lists shared modules such as Smart Sessions, WebAuthn and social recovery [14]. Two caveats:
- Kernel's permission system and Smart Sessions are two different session-key designs.
- Whether either installs cleanly on the other vendor's account was not verified.
- Alchemy MAv2 modules (ERC-6900) are not interchangeable with ERC-7579 modules.

**Migration between frameworks:**
- Accounts behind ERC-1967/UUPS proxies (SimpleAccount, Kernel, Nexus, MAv2, Coinbase) can in principle be upgraded to another implementation. Storage-layout compatibility is the risk, not the mechanism.
- Biconomy documents a v2-to-Nexus migration path [74].
- ZeroDev provides a migration helper only for ECDSA accounts and advises "We do NOT recommend upgrading Kernel accounts unless you NEED TO" [63].
- Alchemy's README claims MAv2 can "be upgradeable to or from most other smart contract account implementations" [84].
- Any upgrade keeps the account address. A changed factory or implementation changes the counterfactual address of not-yet-deployed accounts. Biconomy warns of exactly this [74], and our ADR D4 version bookkeeping already handles it.

---

## 12. Dimension 8: Upgradability risk

| Framework | Proxy pattern | Who can upgrade | Vendor admin power over accounts | If the vendor disappears |
|---|---|---|---|---|
| SimpleAccount | ERC-1967 proxy, UUPS since v0.4.0 [23] | owner or the account itself [25] | none (code reading) | unaffected; reference code is EF-maintained |
| Safe | custom proxy with the singleton in storage slot 0; `changeMasterCopy` removed in v1.3.0 [30] | only the Safe itself, via an owner-approved delegatecall to a migration contract. Safe warns "A malicious or incompatible implementation can take control of the SafeProxy" [33] | none (code reading) | accounts keep working; deterministic deployments [30] |
| Kernel v3 | ERC-1967 minimal proxy; `upgradeTo` restricted to EntryPoint, self, or root validator [58] | the account | none; vendor owns factory staking only (code reading) | accounts keep working; hosted passkey server loss affects only undeployed passkey accounts [63] |
| Nexus | UUPS behind ERC-1967; `_authorizeUpgrade` restricted to EntryPoint or self; 7702 accounts cannot upgrade this way [71] | the account | none; factory owner manages EntryPoint stake only (code reading) | deployed accounts "keep working on the version that created them" [74]; MEE-specific flows depend on Biconomy's nodes |
| Alchemy MAv2 | ERC-1967 proxy, ERC-7201 namespaced storage [84] | the account; `SemiModularAccount7702` reverts on upgrade (re-delegation instead) [84] | none found; factory owner manages stake and withdrawals (code reading) | accounts keep working |
| Coinbase SW | UUPS behind ERC-1967 [95] | **any single owner**; upgrades are replayable across chains by design [95] | none in contract; Coinbase influence only through owners it holds, such as the spend-permission manager (code reading) | accounts keep working on EntryPoint v0.6 infrastructure |
| Etherspot | ERC-1967 proxy via factory; the factory owner can change the implementation for **new** accounts [108] | no upgrade function found in the account; a delegatecall execution path could in principle rewrite the proxy slot (unverified, code reading) | factory owner (Etherspot) controls the implementation for new deployments | deployed accounts keep working |

Every upgradeable account can be pointed at malicious code by whoever controls its root signer. Our ADR D6 rule, that module installs and 7702 authorizations are wallet-internal and allowlisted, applies equally to implementation upgrades.

---

## 13. Dimension 9: Licensing and commercial constraints

| Framework | Contract license (LICENSE file and SPDX headers) | SDK license | Fees | Notes |
|---|---|---|---|---|
| SimpleAccount | v0.7.0 SimpleAccount: GPL-3.0. v0.8+ accounts and interfaces: MIT; EntryPoint remains GPL-3.0; root LICENSE GPL-3.0 [23][24] | no first-party SDK; viem and permissionless.js are MIT [18][28] | none in contracts | our current testnet account is the GPL-3.0 v0.7 file |
| Safe | core and modules LGPL-3.0-only; recovery module GPL-3.0; Safe7579 has no LICENSE file, declares GPL-3.0 in package.json, with mixed GPL-3.0 and MIT SPDX headers [30][34][37][48] | Safe Core SDK MIT [51] | none in contracts (refunds only go to signer-chosen receivers); app-level Safe{Wallet} swap fees flow to SafeDAO under a trademark licence model [54] | "the copyright licence does not include ... right ... to use the Safe Trademarks" [53] |
| Kernel | v3.x: MIT (LICENSE.txt); vendored ERC-4337 interface files GPL-3.0; the v4 branch has no LICENSE file but its README says MIT [58][60] | MIT (@zerodev/*) [63] | none in contracts (grep); hosted plans $0 / $69 / $399 per month, 8% gas-sponsorship premium [68] | permission plugins MIT [70] |
| Nexus | MIT (LICENSE file and SPDX); stx-contracts has no LICENSE file, MIT in package.json and SPDX [71][75] | AbstractJS MIT [80] | none in account contracts; MEE Node Paymaster charges percentage or fixed premiums [75] | **Smart Sessions AGPL-3.0-only**; Rhinestone SocialRecovery and WebAuthnValidator AGPL-3.0-only [55][56] |
| Alchemy MAv2 | GPL-3.0-or-later (LICENSE-GPL; SPDX) [84] | MIT [93] | none found | MAv1 mixed MIT/CC0/GPL |
| Coinbase SW | MIT [95] | npm declares Apache-2.0 for @coinbase/wallet-sdk and @base-org/account while the SDK LICENSE text is MIT-style (sources conflict) [105] | none in contracts | |
| Etherspot | MIT; six AGPL-3.0-only files (hook multiplexer, ERC-7484 adapter, trusted forwarder) [108] | MIT [110] | Etherspot bundler metered in credits [111] | |

**Can we fork?** Yes, for every framework, subject to the license terms.
- MIT: Kernel, Nexus, Coinbase, Etherspot core, SimpleAccount v0.8+.
- (L)GPL: Safe, MAv2, SimpleAccount v0.7, EntryPoint.
- AGPL: Smart Sessions and Rhinestone modules.

**Open legal question for counsel:** whether merely interacting with, or deploying unmodified copies of, (L)GPL or AGPL contracts creates obligations for a closed-source mobile app. This document does not answer that question.

---

## 14. Dimension 10: Mobile fit

ADRs D2, D5 and D7 already decide most of this dimension. Vendor SDKs are not imported into the engine; each account is a `SmartAccountSpec` that our own code implements and byte-tests against an independent implementation. Mobile fit is therefore mainly two questions: whether an independent, permissively licensed TypeScript reference exists to test against, and whether any feature depends on a vendor service.

| Framework | Independent TypeScript reference | Vendor SDK and React Native | Vendor-service dependencies |
|---|---|---|---|
| SimpleAccount | viem `toSimple7702SmartAccount`; permissionless `toSimpleSmartAccount` (MIT) [18][28] | none needed | none |
| Safe | permissionless `toSafeSmartAccount` [18] | Safe Core SDK (MIT) with an official Expo passkeys tutorial [52] | hosted Transaction Service optional |
| Kernel | permissionless `toKernelSmartAccount` (Kernel 0.3.0-beta–0.3.3) and `to7702KernelSmartAccount` [18] | @zerodev/* MIT, viem-only peer dependency; "ZeroDev works great in React Native" (community templates); a React Native passkeys helper package [63] | passkey server (self-hostable) |
| Nexus | permissionless `toNexusSmartAccount`, **v1.0.0 only** [83] | AbstractJS MIT; heavy peer dependencies (Rhinestone module SDK, Safe types, MetaMask delegation toolkit); no React Native statement found [80] | MEE for newer flows |
| Alchemy MAv2 | `@alchemy/smart-accounts` (MIT, viem-based) [93] | Account Kit, including its React Native package, deprecated [92]; no React Native statement for the v5 packages | Wallet APIs need a key |
| Coinbase SW | viem `toCoinbaseSmartAccount` (EntryPoint v0.6) [103] | vendor SDK is dApp-side only | none for the contracts |
| Etherspot | permissionless `toEtherspotSmartAccount` [18] | modular SDK MIT; transaction kit lists React Native [109] | Etherspot bundler optional |

Bundle-size figures were not found for any SDK. This matters little to us because we do not ship vendor SDKs.

---

## 15. Dimension 11: EIP-7702 readiness

| Framework | 7702 delegation target today | EntryPoint | Notes |
|---|---|---|---|
| SimpleAccount | Simple7702Account, introduced in v0.8 as "a fully audited minimalist smart contract wallet that can be safely authorized by any Externally Owned Account" [23] | v0.8 and v0.9 | not upgradeable; changing it means a new delegation [28] |
| Safe | **No** for released contracts: "Existing Safe contracts cannot be used with EIP-7702", citing setup front-running and the singleton's inability to own itself. Proposed alternatives (SafeEIP7702Proxy, SafeEIP7702, SafeLite) "are experimental and the contracts are not yet audited" [47] | n/a | Safe's main branch contains unreleased 7702-related code absent from v1.5.0 [30] |
| Kernel | **Yes, v3.3** ("7702 implemented"; SDK delegation address equals the v3.3 implementation `0xd6CE…5b28`) [57][64] | v0.7 (official example uses `getEntryPoint("0.7")` with `KERNEL_V3_3`) [65] | v4's `Kernel7702` targets EntryPoint v0.9 and is unreleased [60] |
| Nexus | **Yes, v1.2.0+** ("Built for EIP-7702 + ERC-4337 v0.7") [72] | v0.7 | gasless 7702 delegation via a relayer from MEE suite 2.2.1 [74] |
| Alchemy MAv2 | **Yes**, `SemiModularAccount7702`; Wallet APIs delegate to "Modular Account v2 v1.1.0 at `0x77021100bD87b7008E5E1989d0eB38555d0d0000` by default" [90] | v0.7 (released) | the README warns that delegating to any other MAv2 variant lets "an attacker ... take over the account" [84]; 7702 file had 0% coverage in the Quantstamp audit [86] |
| Coinbase SW | Only through Coinbase's audited EIP7702Proxy: "Do not directly delegate to a Coinbase Smart Wallet implementation" [95][101] | v0.6 (inferred from the implementation's hard-coded EntryPoint) | whether bundlers accept v0.6 operations with a 7702 authorization is unverified |
| Etherspot | own account: not found; its 7702 mode delegates to Kernel v3.3 [109] | v0.7 | |

**Implications:**
1. **EIP-7702 may not strictly require our EntryPoint v0.8 upgrade.** AGENTS.md (phase 7 plan) and AA_STACK.md assume it does. Kernel v3.3, Nexus 1.2+ and MAv2 all document 7702 delegation on EntryPoint v0.7. EntryPoint v0.8 adds "native support for EIP-7702 authorizations in the EntryPoint" and includes the delegation address in the UserOperation hash [23]. How the authorization reaches the chain under v0.7 (a separate type-4 transaction, or a bundler that includes it) was not verified. It must be settled on Sepolia before phase 8 is scoped.
2. **The front-running warning recurs everywhere.** Safe, Alchemy and Coinbase/Base all warn that delegating to an account whose initializer is unprotected lets an attacker seize the EOA [47][84][102]. Our D6 allowlist must name exact delegate implementations, never "a Kernel" or "a Safe".
3. **The ecosystem risk is real.** BundleBear labels 2,337,224 live delegated accounts as delegating to "Crime" contracts, comparable to the largest legitimate delegates [17]. This supports D6's rule that the wallet never signs a 7702 authorization requested by a dApp.

---

## 16. Dimension 12: Fit against this project's constraints

| Constraint | SimpleAccount | Safe (+Safe7579) | Kernel v3 | Nexus | Alchemy MAv2 | Coinbase SW | Etherspot |
|---|---|---|---|---|---|---|---|
| Non-custodial, no vendor admin over accounts | yes | yes | yes | yes | yes | yes | yes, but factory owner controls the implementation for new accounts |
| Seed-root recovery (D1) | yes | yes at threshold 1; a threshold above 1 needs keys outside the seed | yes | yes | yes | weakened: any owner, including a passkey, can remove the seed-derived owner | yes |
| No lock-in (D5) | yes | yes | yes | contracts yes, vendor roadmap no | contracts yes | contracts yes | yes |
| ERC-7579 target (D6) | no | yes via adapter | yes | yes | **no (ERC-6900)** | **no** | yes |
| EntryPoint v0.7 pin | yes | yes | yes | yes | yes | **no (v0.6)** | yes |
| Session keys enforced on-chain | no | yes (Smart Sessions, beta/AGPL) | yes (MIT) | yes (Smart Sessions, beta/AGPL) | yes | spend permissions only | ERC-20 only |
| ERC-1271 for dApp logins (phase 7 item 3) | **no** | yes | yes (own wrapper) | yes (ERC-7739) | yes (own wrapper) | yes (own wrapper) | yes |
| 7702 delegate on our EntryPoint | no (v0.8+) | no | yes | yes | yes | no | via Kernel |

Two findings matter for ADR D1 regardless of framework:
- **Owner rotation breaks address recomputation.** ZeroDev's documentation states: "After you update the account owner, the account address can no longer be computed from the new owner" [63]. This applies to every CREATE2 account (code reading).
  - Once social recovery or a signer swap replaces the seed-derived owner, a fresh install from the seed can no longer find the account by recomputing its address.
  - The wallet must then record the account address (public data) as recovery metadata, or rediscover it from chain events.
  - ARCHITECTURE section 3.1 already requires persisting `(factory, implementation, salt)`. It should also persist the account address and any owner change.
- **Undeployed accounts holding funds are a recurring attack surface.** Nexus's 2026 advisory [71], Certora's Coinbase finding about stealable empty-owner accounts [97], and the 7702 initializer warnings all concern the window before an account is deployed or initialized. Our D4 design deliberately lets users receive funds before deployment. We should:
  - Prefer factories that bind the initialization data into the CREATE2 address, so an undeployed address cannot be deployed with someone else's setup. SimpleAccount does this through the init-code hash, which contains the owner. Kernel v3.3 does it by hashing the initialization data into the salt (code reading [25][58]).
  - Encourage early deployment for funded accounts.

---

## 17. Recommendation, conditions and revisit triggers

### 17.1 Recommendation

1. **Primary: Kernel v3 on EntryPoint v0.7.**
   - Build the Kernel `SmartAccountSpec` on Sepolia now (phase 7 item 1).
   - Byte-test it against permissionless.js's independent Kernel implementation, as we did for SimpleAccount against ethers.
   - Choose the exact version under condition C1 below.
   - Kernel fits every project constraint in section 16. It is the only candidate that combines all of the following: MIT contracts, MIT session-key plugins, our pinned EntryPoint, a released 7702 delegate on that EntryPoint, documented third-party infrastructure support, and the strongest independent ERC-7579 adoption signal.
2. **Second source: Nexus**, kept as the portability check, not built now. Its security process (five audit engagements, a bounty, a published advisory with a clear fix) is better documented than Kernel's. Its vendor direction (MEE, the stx-contracts lineage, AGPL beta session keys) is the reason it is second rather than first.
3. **High-value option later: Safe**, for a multi-signature or treasury product (Feature Universe item 24). Safe's core is the most proven contract in this space. Its ERC-7579 adapter and its EIP-7702 path are the weak links, so Safe enters only when those are audited and covered by a bounty.
4. **Not recommended as the default:** Alchemy MAv2 (ERC-6900 conflicts with D6), Coinbase Smart Wallet (EntryPoint v0.6, not modular), Etherspot (thin audits, no bounty). SimpleAccount stays as the testnet proof rig.

### 17.2 Conditions on Kernel before any mainnet funds

- **C1, audit coverage for the shipped version.**
  - ZeroDev's create-account documentation recommends "Kernel version 3.1 with EntryPoint 0.7" for new projects, while its 7702 quickstart uses v3.3 [63].
  - Published audits cover v3.0 and a v3.1 increment whose firm is not named. Nothing was found for v3.2 or v3.3.
  - Ask ZeroDev for v3.3 audit reports.
  - If they exist, ship v3.3 for both smart accounts and later 7702, giving one implementation and one allowlist entry.
  - If not, ship v3.1 for ERC-4337 accounts and either commission a review of the v3.1-to-v3.3 diff before phase 8 or treat 7702 separately.
  - Either choice must be recorded per D4 because it fixes counterfactual addresses.
- **C2, bug bounty.** Ask ZeroDev and Offchain Labs whether Kernel is covered by any bounty (for example an Arbitrum or Offchain Labs program). This could not be confirmed from public sources. Record the answer. If there is none, weigh it explicitly against Nexus's $50,000 and Safe's $1,000,000.
- **C3, version horizon.** Obtain a statement on how long v3 will be supported and how v3 accounts migrate to v4 (EntryPoint v0.9). The v4 branch is a redesign, and ZeroDev itself advises against upgrades unless needed.

### 17.3 Revisit this recommendation when any of the following happens

- Kernel v4 is released with a third-party audit, or ZeroDev announces end of support for v3.
- ZeroDev or Offchain Labs changes Kernel's license, or stops publishing Kernel source.
- A Kernel vulnerability is disclosed, or C1/C2 come back negative.
- Safe7579 v2 receives a published audit and enters Safe's bounty, or Safe releases an audited 7702 delegate.
- Biconomy publishes Nexus 1.3.x on GitHub with its July 2026 Pashov report, and permissionless.js adds support beyond Nexus 1.0.0.
- ERC-7579 moves out of Draft with interface changes, or an ERC-7715/7710 implementation becomes the de facto session-key standard. Kernel would then need to support it, or the second source becomes primary.
- We adopt EntryPoint v0.8 or v0.9 (phase 8), which changes the candidate set for 7702.
- Counsel's answer on (L)GPL/AGPL obligations changes the license ranking.

---

## 18. Corrections to earlier project documents

These earlier statements are contradicted or refined by sources fetched for this document. Per the task's scope, the earlier files were not edited.

1. **SESSION_KEYS.md says ERC-7579 "reached final status on the EIP track in 2024".** The official ERCs repository lists ERC-7579 as **Draft** on 2026-10-01 [2].
2. **SESSION_KEYS.md attributes "not a production-ready smart account" to OpenZeppelin.** The phrase is on Pimlico's comparison page [15]. OpenZeppelin's audits describe the samples as examples "used as a baseline" [26], and another Pimlico page says SimpleAccount is "widely used in production" [29].
3. **SESSION_KEYS.md lists Nexus adoption as "not listed".** Pimlico's page now shows 78 Nexus accounts and 224k deprecated Biconomy v2 accounts over six months, with no as-of date [15].
4. **SESSION_KEYS.md credits Kernel with "two named audits (ChainLight, Kalos)".** Correct, but those cover v3.0 and the factory. No audit of v3.2 or v3.3 was found (section 8.3).
5. **AGENTS.md (phase 7 plan) says EIP-7702 "needs the EntryPoint v0.8 upgrade".** Three vendors document 7702 on EntryPoint v0.7 (section 15). The mechanism is to be verified.
6. **AA_STACK.md's selection criteria are now evaluated here.** Audit history, bounty, module ecosystem, ERC-7579 compliance and license are covered in sections 8, 11 and 13. Deployment coverage on our launch chains remains to be verified on-chain per the AA_STACK procedure.

---

## 19. Dimensions added beyond the brief

The brief invited extra dimensions. The following were added because leadership is likely to want them:
- **Standards relationship and signature support** (section 3): ERC-1271 and ERC-7739 support determines whether a smart-account user can log in to dApps, which is phase 7 item 3. Notably, our current SimpleAccount has no ERC-1271 at all.
- **EntryPoint compatibility with our pinned v0.7 and current signing scheme** (section 3 and section 16): SimpleAccount v0.9 changes the signed payload, and Coinbase is v0.6-only.
- **Corporate and vendor continuity**, in the section 1 summary and sections 9 and 11:
  - ZeroDev's acquisition by Offchain Labs (13 August 2025) [66][67].
  - Safe's repositories moving to the safe-fndn organization.
  - Biconomy's lineage split and MEE pivot.
  - Alchemy's Account Kit deprecation.
  - Coinbase's two rebrands.
- **Gas cost.** Pimlico republishes ZeroDev's aa-benchmark figures dated 24 February 2024, measuring account creation plus a native transfer plus an ERC-20 transfer [15]. The totals in gas, lower being better:

  | Account | Total gas |
  |---|---|
  | Kernel v2.1 | 467,713 |
  | ERC-7579 reference | 486,462 |
  | SimpleAccount | 575,444 |
  | Safe 4337 | 622,406 |
  | Alchemy ModularAccount (v1) | 1,030,791 |

  Kernel v3, Nexus and MAv2 were not measured, so this data is too old to rank current candidates. A fresh benchmark on Sepolia is cheap and should accompany phase 7 item 1.

---

## 20. Where the evidence was thin

- **Value secured:** only Safe publishes a figure, and Safe's two figures conflict.
- **First mainnet deployment dates:** mostly not found. Release dates were used instead, with conflicts noted for EntryPoint v0.6 and MAv2.
- **Adoption:** vendor claims plus dashboards whose methodology is partly undocumented. The BundleBear totals are our own aggregation of its chart data.
- **Kernel:** no bug bounty found; no audit for v3.2 or v3.3.
- **Safe7579:** no v2.0.0 audit found; fix status of the 2024 Ackee takeover finding not publicly stated.
- **Nexus:** the July 2026 Pashov review is claimed but the report was not found.
- **Etherspot:** no bounty or formal verification found.
- **Formal verification:** absent or internal for most frameworks.
- **React Native support statements:** absent for the Biconomy and Alchemy v5 SDKs.
- **EIP-7702 on EntryPoint v0.7:** how the authorization is submitted is not verified.
- **ERC-7715 support:** absent or announced-only everywhere except Smart Sessions and Biconomy's MEE.
- **Module portability between Kernel's permission system and Smart Sessions:** not verified.

---

## References

All URLs were fetched on 2026-09-30 or 2026-10-01. "Code" means source files read at the stated tag or branch; "raw" means raw.githubusercontent.com.

**Standards**
1. ERC-4337 text: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-4337.md (also https://eips.ethereum.org/EIPS/eip-4337)
2. ERC-7579 text: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-7579.md
3. ERC-6900 text: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-6900.md
4. EIP-7702 text: https://raw.githubusercontent.com/ethereum/EIPs/master/EIPS/eip-7702.md
5. EIP-7600 (Pectra meta, activation table): https://raw.githubusercontent.com/ethereum/EIPs/master/EIPS/eip-7600.md
6. ERC-1271: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-1271.md
7. ERC-6492: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-6492.md
8. ERC-7739: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-7739.md
9. ERC-7715: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-7715.md
10. ERC-7710: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-7710.md
11. EIP-5792: https://raw.githubusercontent.com/ethereum/EIPs/master/EIPS/eip-5792.md
12. ERC-7677: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-7677.md
13. ERC-7484: https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-7484.md
14. ERC-7579 directory (maintained by Rhinestone): https://erc7579.com/

**Cross-cutting**

15. Pimlico smart account comparison: https://docs.pimlico.io/guides/how-to/accounts/comparison
16. BundleBear ERC-4337 account activation: https://www.bundlebear.com/erc4337-account-activation/all
17. BundleBear EIP-7702 authorized contracts: https://www.bundlebear.com/eip7702-authorized-contracts/all
18. permissionless.js 0.4.1 (npm metadata and package source): https://registry.npmjs.org/permissionless/latest
19. Alchemy, ERC-1271 signature replay vulnerability: https://www.alchemy.com/blog/erc-1271-signature-replay-vulnerability
20. DL News, EF bug bounty for ERC-4337 attack vector (5 Feb 2026): https://www.dlnews.com/articles/defi/ethereum-foundation-awards-bug-bounty-to-researchers-who-identified-erc4337-attack-vector/
21. ERC-4337 bug bounty: https://docs.erc4337.io/community/bug-bounty.html
22. HackenProof account-abstraction program: https://hackenproof.com/programs/account-abstraction-bugs

**eth-infinitism SimpleAccount / EntryPoint**

23. Releases (v0.6.0–v0.9.0 notes): https://github.com/eth-infinitism/account-abstraction/releases
24. Repository, develop branch (LICENSE, SPDX headers, tags): https://github.com/eth-infinitism/account-abstraction
25. SimpleAccount source: https://raw.githubusercontent.com/eth-infinitism/account-abstraction/v0.7.0/contracts/samples/SimpleAccount.sol and https://raw.githubusercontent.com/eth-infinitism/account-abstraction/v0.9.0/contracts/accounts/SimpleAccount.sol
26. OpenZeppelin, account abstraction audit (2022): https://www.openzeppelin.com/news/eth-foundation-account-abstraction-audit
27. Audit reports folder (OZ 2023, OZ 2024, Spearbit 2025, Cantina 2025): https://github.com/eth-infinitism/account-abstraction/tree/develop/audits
28. Simple7702Account source and viem implementation: https://raw.githubusercontent.com/eth-infinitism/account-abstraction/v0.9.0/contracts/accounts/Simple7702Account.sol ; https://raw.githubusercontent.com/wevm/viem/main/src/account-abstraction/accounts/implementations/toSimple7702SmartAccount.ts
29. Pimlico, use SimpleAccount: https://raw.githubusercontent.com/pimlicolabs/docs/main/docs/pages/guides/how-to/accounts/use-simple-account.mdx

**Safe**

30. Safe Smart Account README, CHANGELOG, audit docs and code: https://github.com/safe-fndn/safe-smart-account (raw main README.md, CHANGELOG.md, docs/audit_*.md, docs/rv_1_0_0.md)
31. Safe Smart Account releases: https://github.com/safe-fndn/safe-smart-account/releases
32. Safe smart account overview: https://docs.safefoundation.org/smart-account/overview.md
33. Safe migration: https://docs.safefoundation.org/smart-account/migration.md
34. Safe modules (4337, allowances; READMEs, CHANGELOGs, audit docs): https://github.com/safe-fndn/safe-modules
35. Safe passkey module README and CHANGELOG: https://raw.githubusercontent.com/safe-global/safe-modules/main/modules/passkey/README.md
36. Passkeys with Safe: https://docs.safefoundation.org/features/passkeys/passkeys-safe.md
37. Recovery module README and audit doc; Candide contracts README: https://raw.githubusercontent.com/safe-global/safe-modules/main/modules/recovery/README.md ; https://raw.githubusercontent.com/candidelabs/candide-contracts/main/README.md
38. Safe{RecoveryHub}: https://help.safe.global/en/articles/110656-account-recovery-with-safe-recoveryhub ; launch release https://www.prnewswire.com/news-releases/safe-launches-saferecoveryhub-joining-forces-with-sygnum-bank-and-coincover-to-set-new-standard-for-crypto-recovery-302009047.html
39. Safe Foundation Q2 2026 report: https://safefoundation.org/blog/safe-q2-2026-quarterly-report and https://safefoundation.org/reports/q2-2026
40. Safe Foundation smart contracts page: https://safefoundation.org/smart-contracts
41. Safe homepage statistics: https://safe.global/
42. Safe bug bounty: https://docs.safefoundation.org/security/bug-bounty
43. Safe past bounties: https://docs.safefoundation.org/security/past-bounties.md
44. Certora specifications and properties: https://github.com/safe-fndn/safe-smart-account/tree/main/certora/specs ; https://raw.githubusercontent.com/safe-global/safe-smart-account/main/certora/specs/properties.md
45. Sygnia, Bybit investigation: https://www.sygnia.co/blog/sygnia-investigation-bybit-hack/
46. CoinDesk, Bybit and Safe statements: https://www.coindesk.com/business/2025/02/26/bybit-and-safe-custody-blame-each-other-over-usd1-5b-hack
47. Safe and EIP-7702: https://docs.safefoundation.org/features/eip-7702/7702-safe.md
48. Safe7579 repository (README, releases, audits, code): https://github.com/rhinestonewtf/safe7579
49. Ackee, Safe7579 audit summary: https://ackee.xyz/blog/rhinestone-erc-7579-safe-adapter-audit-summary/
50. Safe and ERC-7579: https://docs.safefoundation.org/features/erc-7579/7579-safe.md
51. Safe Core SDK (packages, licenses, relay-kit source): https://github.com/safe-global/safe-core-sdk
52. Safe React Native passkeys tutorial: https://docs.safe.global/advanced/passkeys/tutorials/react-native
53. Safe trademark policy: https://safefoundation.org/trademark
54. SafeDAO SEP 44: https://forum.safefoundation.org/t/sep-44-creating-safedao-s-first-revenue-stream-through-community-aligned-fees/5716
55. Smart Sessions (README, code, audits): https://github.com/erc7579/smartsessions
56. Rhinestone core modules: https://github.com/rhinestonewtf/core-modules

**ZeroDev Kernel**

57. Kernel releases: https://github.com/zerodevapp/kernel/releases
58. Kernel v3.3 source, README and LICENSE.txt: https://github.com/zerodevapp/kernel/tree/v3.3
59. Kernel v3.3 audits folder: https://github.com/zerodevapp/kernel/tree/v3.3/audits
60. Kernel v4 README (default `dev` branch): https://raw.githubusercontent.com/zerodevapp/kernel/dev/README.md
61. Kernel v4 Certora notes: https://raw.githubusercontent.com/zerodevapp/kernel/dev/certora/README.md
62. Kernel v4 release manifest: https://raw.githubusercontent.com/zerodevapp/kernel/dev/releases/v0.4.0.json
63. ZeroDev documentation (full text): https://docs.zerodev.app/llms-full.txt
64. ZeroDev SDK constants: https://raw.githubusercontent.com/zerodevapp/sdk/main/packages/core/constants.ts
65. ZeroDev 7702 example: https://raw.githubusercontent.com/zerodevapp/zerodev-examples/main/7702/7702.ts
66. Offchain Labs acquires ZeroDev (13 Aug 2025): https://www.prnewswire.com/news-releases/offchain-labs-makes-strategic-acquisition-of-zerodev-to-advance-efficient-development-and-use-of-onchain-consumer-applications-302528571.html
67. ZeroDev blog, acquisition: https://www.zerodev.app/blogs/blog-zerodev-acquired
68. ZeroDev pricing: https://zerodev.app/pricing
69. Kernel security page: https://github.com/zerodevapp/kernel/security
70. Kernel ERC-7579 plugins: https://github.com/zerodevapp/kernel-7579-plugins

**Biconomy Nexus**

71. Nexus repository (README, SECURITY.md, audits, code): https://github.com/bcnmy/nexus
72. Nexus releases and tags: https://github.com/bcnmy/nexus/releases
73. Biconomy contracts and audits: https://docs.biconomy.io/contracts-and-audits.md
74. Biconomy upgrade and migrate: https://docs.biconomy.io/upgrade-migrate.md ; https://docs.biconomy.io/upgrade-migrate/mee-versions.md
75. stx-contracts README and code: https://github.com/bcnmy/stx-contracts
76. Biconomy documentation (full text, supported chains, paymaster FAQ): https://docs.biconomy.io/llms-full.txt
77. Biconomy Nexus overview: https://docs.biconomy.io/new/learn-about-biconomy/nexus.md
78. Gemini, why Gemini Wallet looks the way it does: https://www.gemini.com/blog/why-gemini-wallet-looks-the-way-it-does
79. Biconomy blog, Gemini on Nexus: https://blog.biconomy.io/gemini-builds-on-the-biconomy-nexus-stack-to-power-its-self-custodial-wallet/
80. AbstractJS and passkey packages (npm metadata and tarballs): https://registry.npmjs.org/@biconomy/abstractjs ; https://registry.npmjs.org/@biconomy/passkey
81. DeFiSafety process quality review (in the Nexus audits folder): https://github.com/bcnmy/nexus/tree/main/audits
82. Biconomy, MEE versus ERC-4337: https://docs.biconomy.io/new/learn-about-biconomy/mee-vs-4337.md
83. Pimlico, toNexusSmartAccount: https://docs.pimlico.io/references/permissionless/reference/accounts/toNexusSmartAccount

**Alchemy Modular Account v2**

84. Modular Account v2.0.2 README and code: https://github.com/alchemyplatform/modular-account/tree/v2.0.2
85. Modular Account releases: https://github.com/alchemyplatform/modular-account/releases.atom
86. Modular Account audits folder: https://github.com/alchemyplatform/modular-account/tree/v2.0.2/audits
87. Alchemy Cantina bounty: https://cantina.xyz/bounties/246de4d3-e138-4340-bdfc-fc4c95951491
88. Advisory GHSA-jhp7-7cq9-m4pv (CVE-2025-46834): https://github.com/alchemyplatform/modular-account/security/advisories/GHSA-jhp7-7cq9-m4pv
89. Alchemy MAv2 documentation (overview, session keys): https://www.alchemy.com/docs/wallets/smart-contracts/modular-account-v2/overview.md
90. Alchemy, using EIP-7702: https://www.alchemy.com/docs/wallets/transactions/using-eip-7702.md
91. Alchemy third-party bundlers and paymasters: https://www.alchemy.com/docs/wallets/low-level-infra/third-party-infrastructure/bundlers.md ; https://www.alchemy.com/docs/wallets/low-level-infra/third-party-infrastructure/paymasters.md
92. Account Kit deprecation: https://www.alchemy.com/docs/wallets/account-kit-deprecated.md
93. aa-sdk LICENSE and @alchemy/smart-accounts: https://raw.githubusercontent.com/alchemyplatform/aa-sdk/main/LICENSE ; https://registry.npmjs.org/@alchemy/smart-accounts
94. LightAccount: https://github.com/alchemyplatform/light-account

**Coinbase Smart Wallet**

95. Smart Wallet repository (README, LICENSE.md, SECURITY.md, code): https://github.com/coinbase/smart-wallet
96. Smart Wallet releases: https://github.com/coinbase/smart-wallet/releases
97. Smart Wallet audits folder: https://github.com/coinbase/smart-wallet/tree/main/audits
98. Code4rena report: https://code4rena.com/reports/2024-03-coinbase
99. Coinbase Cantina bounty: https://cantina.xyz/bounties/55316f42-3c5e-4746-9bd0-0f18dcbc344b
100. Spend permissions: https://raw.githubusercontent.com/coinbase/spend-permissions/main/README.md
101. EIP7702Proxy: https://raw.githubusercontent.com/base/eip-7702-proxy/main/README.md
102. Base, securing EIP-7702 upgrades: https://blog.base.dev/securing-eip-7702-upgrades
103. viem toCoinbaseSmartAccount: https://raw.githubusercontent.com/wevm/viem/main/src/account-abstraction/accounts/implementations/toCoinbaseSmartAccount.ts
104. Base documentation history, recovery keys: https://github.com/base/docs (docs/smart-wallet/concepts/features/built-in/recovery-keys.mdx, commit 7befd471)
105. Coinbase wallet SDK PR #1911 and npm metadata: https://github.com/coinbase/coinbase-wallet-sdk/pull/1911 ; https://registry.npmjs.org/@base-org/account
106. CoinDesk, Smart Wallet launch: https://www.coindesk.com/tech/2024/06/04/protocol-village
107. Smart Wallet creations (Dune-based press report, Aug 2025): https://cryptonews.net/news/security/31450742/

**Etherspot, Candide, Thirdweb, other**

108. Etherspot modular accounts (README, LICENSE, SECURITY.md, audits, code): https://github.com/etherspot/etherspot-modular-accounts
109. Etherspot transaction kit: https://raw.githubusercontent.com/etherspot/transaction-kit/master/README.md
110. Etherspot modular SDK: https://raw.githubusercontent.com/etherspot/etherspot-modular-sdk/master/README.md
111. Etherspot documentation (audits, SDK instantiation, credit pricing): https://etherspot.fyi/llms.txt
112. Pillar, PillarX: https://pillar.fi/blog/why-pillarx-is-the-future-of-pillar-wallet-a-game-changing-upgrade/
113. Candide AbstractionKit: https://raw.githubusercontent.com/candidelabs/abstractionkit/main/README.md ; https://registry.npmjs.org/abstractionkit
114. Thirdweb contracts license: https://raw.githubusercontent.com/thirdweb-dev/contracts/main/LICENSE.md
115. Base webauthn-sol: https://raw.githubusercontent.com/base/webauthn-sol/main/README.md
116. ethereum.org, Modular Account: https://ethereum.org/developers/tools/modular-account

The conditions C1–C3 above are merged with the wallet's own mainnet conditions in docs/THREAT_MODEL.md section 5.

# Project State — Mobile AA Wallet ("Shiba Wallet", working title)

This file is the persistent state for all agents working on this project.
Read it fully before doing any work, then the rule file your task needs
(see Standing rules). Update it after every completed task.
The full record of phases 1 to 12 lives in docs/HISTORY.md and of phases
13 to 27 in docs/HISTORY-phases-13-27.md; this file keeps the rules, the
decisions, a short index of what each past phase delivered, the last
phase's status and the current phase in full.

## Project objective

A non-custodial mobile cryptocurrency wallet whose defining feature is
**Account Abstraction (ERC-4337 / EIP-7702)** on EVM chains, with first-class
support for Bitcoin, Solana, Dogecoin, and an extensible adapter system
capable of supporting thousands of other assets.

Non-negotiable requirements (from the Lead Chairperson):

1. **Non-custodial.** Keys are generated, stored, and used only on the user's
   device. No server ever sees key material. Fundamental; never compromise.
2. **Recovery and backup are required.** Implemented as a hierarchical
   deterministic (HD) wallet: a single BIP-39 seed phrase derives a BIP-32
   master key; each asset uses hardened derivation paths (BIP-44 / SLIP-44).
3. **Account Abstraction is the key differentiator.** Smart accounts,
   gas sponsorship (paymasters), batched transactions, session keys, social
   recovery on-chain, passkey signers.
4. **Maximum flexibility.** No architectural lock-in; every feature must be
   addable later without rewrites. Chain support is pluggable (adapter
   pattern). Features like staking are valuable where it intersects AA.
5. Deliverable for the Chairperson: a complete feature-universe analysis so
   leadership can choose where to invest.
6. **Token and NFT support is required** (added by the Chairperson
   2026-09-27): ERC-20 fungible tokens (e.g. USDC) and NFTs (ERC-721,
   ERC-1155), designed so ANY fungible or non-fungible asset class can be
   supported later (SPL tokens, Token-2022, Ordinals/Runes, ...). Assets are
   identified by CAIP-19 ids in core so token support is chain-agnostic.


## Toolchain

- Node.js: v24.21.0 via nvm (Chairperson's directive: keep Node current).
  Shell default may still resolve to v14, so always prefix PATH:
  `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`
- Language: TypeScript. Monorepo with npm workspaces for the engine
  packages; the app is a separate npm tree that consumes the packages
  through file: dependencies (see app/README.md).
- Crypto primitives: `@scure/bip32`, `@scure/bip39`, `@noble/curves`,
  `@noble/hashes` (audited, dependency-free). Never hand-roll primitives.
- Tests: vitest for the engine (validated against official BIP-32/39/44
  test vectors and independent implementations), plain-Node check
  scripts for the app (app/scripts/check-*.mjs, every one registered in
  scripts/ci/suites.mjs). `npm test` at the root runs everything offline
  (scripts/ci/run.mjs); `npm run test:live` adds the live suites.
- Mobile shell: Expo SDK 57 / React Native (app/), run in Expo Go on the
  Android emulator for validation; development builds need an Expo
  account (docs/DEVICE_BUILDS.md, docs/RELEASE.md).
- Secrets: the git-ignored .dev-wallet/ (mnemonic.txt, env with the API
  keys and the ZeroDev project id) is the only place for keys; the
  pre-commit secret scan (scripts/githooks/secret-scan.mjs, enabled with
  `npm run hooks:install`) refuses commits that contain them.

## Repository layout

```
docs/                      Plain-English documents for leadership & engineers
  FEATURE_UNIVERSE.md      Feature landscape and the implementation status
                           of all 99 features (section 15)
  ARCHITECTURE.md          System architecture; ADRs D1–D9 in section 7
  AA_STACK.md              Smart-account stack selection and verification
  AA_FRAMEWORKS.md         Smart-account framework comparison
  SESSION_KEYS.md          Session-key evaluation
  SCHEDULED_PAYMENTS.md    Scheduled and recurring payments design
  THREAT_MODEL.md          Threat model and the mainnet-readiness checklist
  AUDIT_SCOPE.md           The scope handed to outside security auditors (C1, C2)
  DEMO.md                  Presenter's walkthrough on the emulator
  RELEASE.md / STORE_LISTING.md / PRIVACY.md / DEVICE_BUILDS.md /
  CONTRIBUTING.md / HISTORY.md (phases 1–12 in full)
packages/
  core/                    @shiba-wallet/core — keyring, HD derivation,
                           chain-adapter interfaces, asset registry
  chains-evm/              EVM: ERC-4337 / Kernel v3.3 / EIP-7702, session
                           keys, guardians, passkeys, paymasters, ENS,
                           history, simulation, swaps
  chains-utxo/             Bitcoin + Dogecoin (shared UTXO base)
  chains-solana/           Solana adapter
  prices/                  Price provider (CoinGecko adapter)
app/                       Expo / React Native app (screens, wallet glue,
                           check scripts under app/scripts)
scripts/
  ci/                      The test runner, the suite registry, the offline guard
  githooks/                The pre-commit secret scan
  testnet/                 Smoke and live scripts (testnets only; one bounded
                           Dogecoin mainnet demonstration)
examples/demo.mjs          Offline end-to-end engine demo
```

## Key decisions (ADRs D1–D9 live in docs/ARCHITECTURE.md section 7)

- D1: Single BIP-39 mnemonic is the root of all assets, including the ERC-4337
  smart-account owner key. Smart accounts are counterfactual contracts whose
  owner EOA key derives from the seed, so one seed phrase recovers everything.
- D2: Core library is pure TypeScript, no React/native deps, so the same code
  serves mobile, extension, or CLI later (flexibility requirement).
- D3: Chain support via a `ChainAdapter` interface + registry keyed by
  SLIP-44 coin type / CAIP-2 chain id, so thousands of chains can register
  without touching core.

- D4–D9: see docs/ARCHITECTURE.md section 7 (salt = account index, D6 the
  wallet never signs dApp-requested EIP-7702 authorizations, D7 key
  storage, D8 the account-index mapping, D9 imported private keys).

## Standing rules

These apply to every task:

- The repository is public: never commit API keys, endpoints that embed
  keys, project ids or the dev mnemonic; mask them in every output; the
  secret scan runs before every commit and in CI. Agents never read
  .dev-wallet/.
- Testnets only, with two bounded exceptions recorded in
  docs/THREAT_MODEL.md section 7.5 (the Dogecoin mainnet demonstration
  script; mainnet ETH that may arrive at the dev EOA is never spent).
- Subagents run on Opus (the Chairperson's credit directive); one agent
  drives the emulator at a time.
- Do not contact ZeroDev / Offchain Labs: the responsible-disclosure
  decision (the findings are collected, with their evidence and
  status, in the git-ignored docs/private/DISCLOSURE_FINDINGS.md) is the
  Chairperson's.
- Never, whatever the task: wipe the AVD "shiba", add or remove its
  fingerprint, set an app PIN on its real wallet, or run Gradle while
  the AVD is being driven.
- Record keeping: a completed slice or pass gets at most five lines here
  (what, commit, counts, what is unverified). Its full record goes in
  docs/phases/phase-NN.md. When a phase closes, its plan and progress move
  to the history file and one index bullet stays.

Read the matching file BEFORE the task, and only then:

| If the task will…                                   | Read first                            |
|-----------------------------------------------------|---------------------------------------|
| launch, drive or screenshot the emulator; build or  | docs/agent-rules/EMULATOR.md          |
| install a development or release build              |                                       |
| verify a slice, commit, push, or create a worktree  | docs/agent-rules/VERIFY_AND_COMMIT.md |
| or scratchpad files that must survive               |                                       |
| look up a past phase, pass, commit or finding       | grep docs/HISTORY-phases-13-27.md     |
|                                                     | (never read it whole)                 |

A subagent brief names the rule files its task needs; the subagent reads
those and nothing else from this list.

## Known blockers

- None currently.

## Phase history (full record in docs/HISTORY.md and docs/HISTORY-phases-13-27.md)

- Phase 1 (2026-09-27): engine packages with official test vectors,
  FEATURE_UNIVERSE.md and ARCHITECTURE.md, the Expo app shell.
- Phase 2: send flows on all four chains, EIP-1559, SPL transfers,
  eth_call pre-flight, biometric gating; testnet smoke runs on Sepolia,
  Bitcoin testnet3 and Solana devnet; the first ERC-4337 account through
  a bundler.
- Phase 3: ERC-20 balances and token management, Activity, the
  smart-account send path, WalletConnect v2 (proven live with Uniswap).
- Phase 4: transaction history via an indexer, token sends, QR
  rendering and scanning, app lock, Sepolia developer mode, swap
  groundwork; the full emulator validation incl. the biometric cycle.
- Phase 5: the Swap screen on 0x, ERC-7677 sponsorship, Dogecoin via
  Blockbook, token history, the session-keys evaluation, EAS readiness.
- Phase 6: eth_simulateV1 balance previews, fiat prices, multi-account,
  contacts with anti-poisoning rules, the global WalletConnect sheet.
- Phase 7: Kernel v3.3 (ERC-7579) accounts, ERC-5792 batching,
  ERC-1271/6492/7739 signatures, the NFT gallery and send, risk warnings
  and the approvals manager, docs/AA_FRAMEWORKS.md, RPC fallbacks.
- Phase 8: EIP-7702 upgrade and revoke, session keys, passkeys (engine
  + app, device test pending), guardians and social recovery, bundler
  vendor selection (ZeroDev accepts Kernel deployments); the burn-down.
- Phase 9: the owner-change fix, docs/THREAT_MODEL.md, CI with the
  offline runner and the secret scan, endpoint failover, the readiness
  switchboard, biometric-protected storage (opt-in), https-only
  endpoints, EAS profiles and store documents, the Dogecoin mainnet
  demonstration broadcast.
- Phase 10: session keys and guardians proven live in-app, the Base
  Sepolia profile, the leadership status matrix and DEMO.md, hardening.
- Phase 11: the spending-limit engine (and the finding that no deployed
  hook can enforce limits on Kernel v3.3), in-app counterfactual
  deployment, SIWE and proof of ownership, activity sentences, Base
  follow-ups, the emulator pass with its fixes.
- Phase 12: the Kernel deployment and the in-app leg on Base Sepolia,
  subscriptions on session keys (proven live), app-enforced spending
  limits, contrast and accessibility, the leadership refresh.

- Phase 13 (2026-10-04): tokens on every EVM profile with discovery, gas
  paid in USDC (Circle's paymaster), single private-key import.
- Phase 14: payment requests, ENS names in Send, the second USDC-fee
  paymaster (Pimlico), the Arbitrum Sepolia profile, watch-only accounts,
  the inheritance demonstration, the scheduled-payments design.
- Phase 15: Arbitrum Sepolia live, recurring payments sent by the phone,
  the multisig engine, the zero-estimate guard, the Glamsterdam fork
  decoding, endpoint freshness, the dApp browser design.
- Phase 16: the in-app browser (allowlisted sites), the private findings
  document, the first local development build on the emulator.
- Phase 17: app-wide screen protection, multisig in the app, local
  reminders, custom EVM networks, transaction notes and the CSV export,
  the staking research.
- Phase 18: Hoodi and OP Sepolia profiles, staking (Lido, Rocket Pool),
  the multisig in the switcher, the smart account's history in Activity.
- Phase 19: OP Sepolia and Hoodi staking live, multisig by QR and files
  on Base Sepolia, DCA on a session key, stuck transactions by script.
- Phase 20: the portfolio layer, profit and loss, price alerts, the lock
  on launch, the duress-wallet and bridging designs, the TalkBack and
  dark-mode slice.
- Phase 21: bridging through LayerZero (Stargate), the storage seam, the
  app PIN and duress PIN with BIP-85, Speed up and Cancel in-app.
- Phase 22: the audit scope, the native scrypt, cold signing, the
  encrypted records backup, the inbox and deep links, localisation
  groundwork, the lock passphrase, the fiat off-ramp research.
- Phase 23: the audit pack (verify-pins.mjs), the release-candidate
  configuration, the first iOS Simulator build, CCTP V2 live, cold
  signing for smart accounts, the wallet handle (ENS), the bounded
  broadcast, five localisation passes, Tropic Square Stage 1, the history
  rewrite of 2026-11-03.
- Phase 24: Solana tokens on devnet (SPL Token and Token-2022), the Max
  estimate fixes, the iOS second pass, Tropic Square Stage 2.
- Phase 25: NFTs live, the risk overview, the gains report, the Solana
  send finished, the lending, address-screening and token-bound-account
  research.
- Phase 26: ENS renewal, lending on Aave v3 (Arbitrum Sepolia), the
  Token-2022 fee mint, the Solana spending-limit scope, the Bitcoin
  assets research.
- Phase 27: the Activity follow-ups, the pre-prompt guard on every
  smart-account confirm, the Bitcoin inscriptions warning, the Aave pins
  in verify-pins.mjs. Its status section is kept below.

The full plan, progress and status text of phases 13 to 27 is in
docs/HISTORY-phases-13-27.md. Do not read that file whole (about 1.5 MB):
grep it for the phase, pass name, commit or finding you need.

## Phase 27 status (2026-11-16)

Items 1 to 5 are landed and pushed, with two emulator passes (p27-emu1
before the plan, p27-emu2 after the slices) and one fix slice; no feature
changed status and the shareable page stays at version 29 (63 proven live,
18 built, 6 designed, 12 not started). SEEN LIVE this phase, through the
app's own screens on the emulator: the phase 26 fix slices 9d0bb65 and
e728e4e (pass p27-emu1); the busy line under a disabled Approve on the
smart-account Send, Staking, Multisig, Wallet-handle and Lend confirms with
a second tap doing nothing; the Kernel's ENS renewal named in Activity on
five of five loads; the withheld transfer fee on the recipient's Activity
row; the Bitcoin inscriptions and Runes warning on the mainnet Bitcoin send
form; the spoken button names; two more Aave supply-and-withdraw rounds
from the smart account on Arbitrum Sepolia (pass p27-emu2). Built and
verified offline: the Aave pins in verify-pins.mjs (eb2683f; its live
network run was the agent's), the pre-prompt guard on thirteen more
smart-account confirms (0ea0e27), and the fix slice f146133 — the
pre-prompt estimate standing in when the send-time estimate is impossible,
one busy-line announcement, the handle's "Not sent" alert. Engine: 1,441
tests. App: 68 offline suites, 12,203 checks at f146133.

Findings for the Chairperson this phase: ZeroDev's zero-estimate bursts on
Arbitrum Sepolia were heavy (5 of 7 Reviews refused in one stretch), and
one refusal still came after the device prompt before f146133 — nothing was
signed either way; Activity read a receipt twice and publicnode's reth
backend answered null on the second read, which is why the Kernel renewal
row lost its name (fixed); the wallet's mainnet Bitcoin send can spend
outputs holding inscriptions or Runes and the warning sentence is its only
mitigation (T-97, Medium / Medium); the withheld-fee row does not appear
when the same transaction also creates the recipient's token account (the
conservative rule); the cause of TalkBack's double announcement was not
established from code.

Decisions and inputs still open: unchanged from the phase 26 status (the
Bitcoin protect-only slice's three inputs; Tropic Square section 12.1 and
Stage 3; the release signing key, audit firm, budget, C1 scope and git
tag; address screening section 9; DURESS_WALLET section 8.5; whether Lend
accepts an EIP-7702 owner; stash@{0}; Homebrew's rust and ruby; a glance at
the emulator window). On hold by the Chairperson: a native Spanish
reviewer, the fiat off-ramp provider, the disclosure decision.

Follow-ups (no inputs): an emulator re-check of f146133 (the stand-in
during a real burst, the single announcement, the "Not sent" alert); a
truthful busy line for cold signing (one new string id); the subscription,
recurring and DCA Start handlers and the passkey, USDC-fee and
guardian-recovery quotes outside the pre-prompt estimate; the Spanish gaps
on the confirm's preview and risk sections; the Ethereum test banner on the
Bitcoin mainnet Send form; T-97's "proposed" wording; both ENS names expire
on 2026-12-22 and cost 0.613701 test USDC each to renew.

## Phase 28 plan (approved 2026-11-16 "everything else approved for phase 28"): the loose ends closed, a Bitcoin test-network switch, the bridging gaps, built rows proven

Proposed by the CTO and approved by the Chairperson with one item struck:
the Across live leg is SKIPPED ("BUSL license seems high risk, skip for
now") — no Across code, script or transfer in this phase. Every item needs
no outside input; the holds and the input-gated items stay as they are.

0. An emulator re-check of f146133 (the estimate stand-in during a real
   ZeroDev burst on Arbitrum Sepolia, the busy line spoken once, the
   handle's "Not sent" alert).
1. The pre-prompt estimate coverage finished: the passkey, USDC-fee and
   guardian-recovery quotes and the subscription, recurring and DCA Start
   handlers checked before the device prompt where an honest check exists;
   a truthful busy line for cold signing (one new string id).
2. A Bitcoin test-network switch (signet) under Settings → Developer,
   modelled on "Use Solana devnet": the whole Bitcoin slot (balance, send,
   history, receive) moves; endpoints verified from the providers' own
   pages and live; the inscriptions warning stays mainnet-only; the
   Ethereum test banner no longer shown on the Bitcoin mainnet Send form.
   The prerequisite for the protect-only slice of docs/BITCOIN_ASSETS.md;
   the index and the test coins stay the Chairperson's inputs.
3. Bridging gaps, in-app: a CCTP burn from the smart account and a mint
   to the smart account, one OP Sepolia CCTP route; the Stargate
   stranded-transfer retry live only if it can be done without an agent
   reading the dev wallet (else recorded as still open).
4. Built rows proven: an EVM spending limit refusing a real send before
   any prompt and allowing a smaller one (row 19).
5. The Spanish gaps of passes p27-emu1 and p27-emu2 (drafts; the reviewer
   stays on hold).
6. An iOS Simulator third pass (the worktree rebuilt first): the import
   screen's name-field tag, the Bitcoin warning, the busy line.
7. Leadership refresh at the end; the shareable page only if a status
   changes.

Waves: 1 — (A) item 1, (B) item 2, in parallel worktrees (the CTO rebases
the string-table tails), and one emulator driver for items 0, 3 and 4; 2 —
item 5, the fixes from the pass, item 6; 7 last. Subagents on Opus.

## Phase 28 progress

Full records: docs/phases/phase-28.md (grep it for the item or pass).

- [x] Item 1 — the pre-prompt estimate on the remaining smart-account
      paths, and a truthful busy line for cold signing (commit 2af4bc5;
      engine 1,447, app 12,256 across 68 suites). No honest pre-prompt
      check exists for Circle's USDC-fee path. Unverified: every layout
      and spoken line, any live run.
- [x] Item 2 — a Bitcoin signet switch under Settings → Developer, and the
      Bitcoin mainnet Send form naming its network (commit d3a79be; engine
      1,452, app 12,338 across 69 suites). Signet uses its own derivation
      path; never valued. Unverified: everything on a device, any signet
      transaction (input: signet coins at Account 1's signet address).
- [x] Emulator pass p28-emu1 (2026-11-16, Metro at 924cdfb, before items 1
      and 2): the first CCTP burn from and mint to a smart account, the
      first OP Sepolia CCTP route, an EVM spending limit refusing a real
      send before any prompt (row 19), the f146133 busy line heard once.
      The estimate stand-in was not shown to have been exercised.
- [x] Item 5 and the p28-emu1 findings — the Spanish gaps (132 ids), the
      CCTP confirm lines, the over-limit alert's "Nothing was signed."
      (commit 8ea90f5; engine 1,452, app 12,375 across 69 suites).
      Unverified: everything on a device; the Spanish drafts.

Still open in the phase 28 plan: item 0's stand-in during a real burst,
items 1, 2 and 5 on the emulator, item 3's Stargate retry, item 4 beyond
p28-emu1 (done there), item 6 (the iOS third pass), item 7 (the refresh).

# Project State — Mobile AA Wallet ("Shiba Wallet", working title)

This file is the persistent state for all agents working on this project.
Read it fully before doing any work, then the rule file your task needs
(see Standing rules). "The CTO" in these files is the main session, the
one that talks to the Chairperson (the user) and dispatches subagents.
The CTO updates this file after each verified slice or pass (see Record
keeping); a subagent edits it only when its brief says so.
The full record of phases 1 to 12 lives in docs/HISTORY.md and of phases
13 to 27 in docs/HISTORY-phases-13-27.md, with a one-bullet index in
docs/HISTORY-INDEX.md; this file keeps the rules, the decisions, the open
decisions and holds, and the current phase.

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
  Android emulator for validation; local development and release builds
  for the emulator need no Expo account, EAS builds do
  (docs/DEVICE_BUILDS.md, docs/RELEASE.md).
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
  CONTRIBUTING.md
  HISTORY-INDEX.md         One bullet per closed phase
  HISTORY.md / HISTORY-phases-13-27.md
                           Full records of phases 1–12 and 13–27 (grep the
                           second; it is about 1.5 MB)
  phases/phase-NN.md       Full records of the current phase
  agent-rules/             Rules read only for their task: EMULATOR.md,
                           VERIFY_AND_COMMIT.md,
                           SECRETS_AND_LIVE_SCRIPTS.md
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
  secret scan runs before every commit and in CI.
- No agent opens, prints, copies or lists anything under .dev-wallet/,
  except in the ways docs/agent-rules/SECRETS_AND_LIVE_SCRIPTS.md allows.
  Read that file before running a scripts/testnet script or the live
  suites. In the main checkout run app check suites only through the
  offline runner (`npm test` or `npm run test:app`), which hides
  .dev-wallet/: run directly there,
  check-doge.mjs and check-indexer.mjs read .dev-wallet/env themselves
  and make keyed live requests. In a worktree any suite can be run
  directly.
- Testnets only, with two bounded exceptions: the Dogecoin mainnet
  demonstration script (docs/THREAT_MODEL.md section 7.5), and mainnet
  ETH that may arrive at the dev EOA, which is never spent.
- Commit with plain `git commit`; never override the hooks path (the
  pre-commit secret scan must run).
- Never link .dev-wallet/ into a worktree (a symlink is not git-ignored);
  edit a secrets file by key name, never by the shape of a value.
- Before running any script under scripts/testnet, read its header for
  the live / dry-run switch: some send live by default (kernel-smoke.mjs
  with BUNDLER_URL set did, 2026-11-07).
- Subagents run on Opus (the Chairperson's credit directive); one agent
  drives the emulator at a time.
- Do not contact ZeroDev / Offchain Labs: the responsible-disclosure
  decision (the findings are collected, with their evidence and
  status, in the git-ignored docs/private/DISCLOSURE_FINDINGS.md) is the
  Chairperson's.
- Never, whatever the task: wipe the AVD "shiba", add or remove its
  fingerprint, set an app PIN on its real wallet, run Gradle while the
  AVD is being driven, or send keyguard-clearing input without first
  reading `adb shell dumpsys window | grep isKeyguardShowing`
  (adb is at ~/Library/Android/sdk/platform-tools/adb).
- Record keeping: a completed slice or pass gets at most five lines here
  (what, commit, counts, what is unverified). Its full record goes in
  docs/phases/phase-NN.md. When a phase closes, its plan and status move
  out of this file and it gets one bullet in docs/HISTORY-INDEX.md.

Read the matching file BEFORE the task, and only then:

| If the task will… | Read first |
|---|---|
| launch, drive or screenshot the Android emulator or the iOS Simulator; build or install a development or release build | docs/agent-rules/EMULATOR.md |
| verify a slice, commit, push, check CI, create a worktree, or keep scratchpad files that must survive | docs/agent-rules/VERIFY_AND_COMMIT.md |
| run any script under scripts/testnet, or anything else that needs a key | docs/agent-rules/SECRETS_AND_LIVE_SCRIPTS.md |
| look up the current phase's slices and passes | docs/phases/phase-NN.md |
| look up what a closed phase delivered | docs/HISTORY-INDEX.md |
| look up a past pass, commit or finding | grep docs/HISTORY-phases-13-27.md (13 to 27; never read it whole) or docs/HISTORY.md (1 to 12) |

Many commit hashes recorded before 2026-11-03 are pre-rewrite and are
not on main, and some later records repeat them. Look EVERY recorded hash
up in the git-ignored .local/history-rewrite-2026-11-03-commit-map.tsv:
if a line's first column starts with it, use that line's second column;
if no line matches, use the hash as it is. An old hash may still resolve
in this checkout but is not part of the rewritten history, so never check
one out without this lookup. Check a commit out only in a worktree
(`.local/helpers/mkwt.sh <name> <hash>`, see
docs/agent-rules/VERIFY_AND_COMMIT.md), never in the main checkout.

app/AGENTS.md (Expo's own guidance, loaded for work under app/) gives
general advice; where it differs from this file or a rule file, for
example on where Metro runs or how builds are made, these win.

A subagent brief names the rule files its task needs. When a brief names
none, the subagent picks from the table by its task. Nobody reads a rule
file its task does not need.

## Known blockers

- None currently.

## Phase history

Phases 1 to 27 are closed. One bullet per phase: docs/HISTORY-INDEX.md.
Full records: docs/HISTORY.md (1 to 12), docs/HISTORY-phases-13-27.md
(13 to 27; grep it, never read it whole).

## Open decisions and holds (carried from the phase 26 to 28 records)

Waiting on the Chairperson: the Bitcoin protect-only slice's two
remaining inputs, the index and the test coins (docs/BITCOIN_ASSETS.md;
the third, a test-network switch, was built in phase 28 item 2); Tropic
Square section 12.1 and Stage 3 (docs/TROPIC_SQUARE.md, whose section
10.1 lists the forbidden chip operations); the release signing key, audit firm, budget, C1 scope and
git tag; address screening section 9 (docs/ADDRESS_SCREENING.md);
docs/DURESS_WALLET.md section 8.5; whether Lend accepts an EIP-7702 owner;
stash@{0}; Homebrew's rust and ruby; a glance at the emulator window;
signet coins at Account 1's signet address (phase 28 item 2); whether
Home should say that a Solana token send needs test SOL when an account
holds none; explicit "Copy" accessibility actions for the mint and the
Activity header address (both carried from the phase 26 status).
On hold by the Chairperson: a native Spanish reviewer, the fiat off-ramp
provider, the disclosure decision.
Both ENS names expire on 2026-12-22 (0.613701 test USDC each to renew).
The full phase 27 status is the last section of
docs/HISTORY-phases-13-27.md.

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

Still open in the phase 28 plan: item 0 (the estimate stand-in was not
shown to run during a real burst); items 1, 2 and 5 are built but not
yet seen on the emulator; item 3's Stargate retry; item 6 (the iOS third
pass); item 7 (the refresh). Item 4 was done in pass p28-emu1.

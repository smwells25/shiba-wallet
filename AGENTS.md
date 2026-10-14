# Project State — Mobile AA Wallet ("Shiba Wallet", working title)

This file is the persistent state for all agents working on this project.
Read it fully before doing any work. Update it after every completed task.
The full record of phases 1 to 12 lives in docs/HISTORY.md; this file keeps
the rules, the decisions, the standing emulator rules, a short index of
what each past phase delivered, and the current phases in full.

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

## Standing rules (collected from the phases)

- The repository is public: never commit API keys, endpoints that embed
  keys, project ids or the dev mnemonic; mask them in every output; the
  secret scan runs before every commit and in CI.
- Testnets only, with two bounded exceptions recorded in
  docs/THREAT_MODEL.md section 7.5 (the Dogecoin mainnet demonstration
  script; mainnet ETH that may arrive at the dev EOA is never spent).
- Emulator AVD "shiba": never wipe it and never add or remove its
  fingerprint (its wallet's phrase is in biometric-protected storage and
  written nowhere); never run an engine build in the checkout Metro
  serves from (Metro runs from an isolated git worktree with real dist
  copies); never press BACK in loops; scroll Settings only with slow
  swipes at the screen edge and never fling near the Danger zone; type
  secrets only through the ADBKeyboard IME and redact every UI dump;
  never run a Gradle build while driving the AVD (2026-10-10: the
  watchdog killed system_server) — build first, close Gradle, then drive.
  Since phase 17 item 0 the app blocks screenshots everywhere by default.
  ON THE EMULATOR IT STAYS OFF (the Chairperson's request, 2026-10-11:
  the secure flag blanks the emulator window for a human watching it
  live): turn Settings → Privacy → "Hide in the app switcher and block
  screenshots" OFF if a pass finds it on, and leave it OFF at the end;
  a pass that needs to prove the protection itself turns it on for that
  step only and off again afterwards. Since the lock-on-launch fix
  (phase 20, 2026-10-12) a COLD RELAUNCH SHOWS "Shiba Wallet is locked"
  whenever auto-lock is on (this AVD: 1 min) — after a force-stop, a
  swipe-away plus `am kill`, or a Metro reload that restarts the JS; a
  pass taps Unlock and answers with `adb emu finger touch 1` (the AVD's
  enrolled fingerprint) before driving, or sets Auto-lock Off first and
  restores it at the end.
- Every slice is verified by the CTO in an isolated worktree with the
  offline runner before it is pushed, then recorded here, then CI is
  checked. When several agents work in the main checkout at once, a
  slice's commit must stage shared registries (scripts/ci/suites.mjs,
  readiness ids, check-readiness expectations) from a FILTERED copy that
  holds only the lines whose files are in that commit; the verify run
  and the commit must use the same snapshot of the diff (2026-10-10: a
  registration added by another agent between the verify run and the
  commit broke CI with "lists scripts that do not exist").
  When a record is appended from a shell heredoc, quote the delimiter
  (<<'EOF') and substitute the commit hash afterwards: an unquoted
  heredoc executed a backticked example command and blanked a sentence
  (2026-10-11). The verify worktree must resolve @shiba-wallet/* to ITS OWN
  packages: its app/node_modules is a real directory of symlinks into
  the main checkout's app/node_modules except @shiba-wallet, whose
  entries point at the worktree's packages (lesson of 2026-10-09: with
  a plain symlinked app/node_modules the app checks ran against the
  main checkout's dist, i.e. whatever another agent was building).
- Subagents run on Opus (the Chairperson's credit directive); one agent
  drives the emulator at a time.
- Do not contact ZeroDev / Offchain Labs: the responsible-disclosure
  decision (the findings are collected, with their evidence and
  status, in docs/DISCLOSURE_FINDINGS.md) is the
  Chairperson's.

## Known blockers

- None currently.

## Phase history (full record in docs/HISTORY.md)

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

## Phase 13 plan (started 2026-10-04 on the Chairperson's "let's begin"): tokens everywhere and gas in any token

The Chairperson said to begin without naming a scope, so this plan is
the CTO's proposal, recorded before any code. It can be redirected at
any time; nothing in wave 1 is hard to undo. Selection rule: the Tier 1
features still unbuilt that need no outside account (16, 37, 12), the
one structural gap that has blocked several live tests (tracked tokens
are mainnet-only), and the recorded follow-ups. Tier 1 features left
out because they need inputs: fiat on-ramp (65, a vendor account and
compliance decisions), push notifications (93, a development build),
audits and bounty (56, a budget decision).

1. Tokens on every EVM profile (prerequisite for 2 and for token
   features on test networks; also feature 37): the tracked-token store,
   Home rows, token sends, Activity, the preview's labels and the
   subscriptions token list become per-chain (mainnet, Ethereum Sepolia,
   Base Sepolia) instead of mainnet-only, with the known test-network
   tokens (Circle's USDC / EURC) offered as defaults there; token
   discovery through the configured indexer where one exists (verify the
   API from documentation first), always behind the existing spam and
   anti-spoofing rules.
2. Pay gas in any token (feature 16, Tier 1, "only with AA"): verify
   from documentation and on Sepolia which ERC-20 paymaster works with
   EntryPoint v0.7 and Kernel v3.3 without a vendor lock (candidates to
   check, none assumed: Circle's USDC paymaster, the bundler vendors'
   ERC-20 paymasters through ERC-7677); engine support (the approval or
   permit the paymaster needs, the exchange-rate quote, the fee shown in
   the token), a live Sepolia run paying a UserOperation's gas in a test
   token, then the app's Send confirm with a "pay the network fee in"
   choice. Readiness: test networks only.
3. Single private-key import (feature 12, Tier 1): an imported EVM key
   as an additional account, stored like the phrase, labelled everywhere
   as NOT covered by the recovery phrase; ADR for how it relates to D1.
4. Follow-ups from phase 12: subscription form (custom period, a fee
   budget that keeps back the install fee, no hand-over on an expired
   card, legacy titles, the stale "Copied" mark), the smart-account Max
   slack, dust formatting in Activity and Swap, WETH Deposit / Withdrawal
   events in the preview (F5), the layer 1 fee line on the WalletConnect
   sheet and in the EIP-7702 set-code quote on Base, the two unreasoned
   eslint disables in WcApprovalSheet.
5. An ERC-20 subscription pull, live (needs a test token on a dev or
   emulator account; item 1 makes it reachable in-app).
6. Leadership refresh at the end: feature rows, the shareable page,
   DEMO.md.

Waves: 1 (agent, app), 2's research and engine half (agent, engine and
scripts only) and 4 (agent; files disjoint from item 1) in parallel;
then 2's app half, 3 and 5; 6 last. Subagents on Opus.

## Phase 13 progress
- [x] Item 2, research and engine half — GAS PAID IN USDC, PROVEN LIVE
      ON BASE SEPOLIA (commit acdf04f; 26 new tests, engine 748 in the
      CTO's isolated worktree, offline runner ALL GREEN; no app files;
      the CTO re-read the bundle receipt independently on
      base-sepolia-rpc.publicnode.com: block 47682905, status 0x1, sender
      0xc995…C5AC, paymaster 0x31be…0b58, success 1, actualGasCost
      1,650,524,700,000 wei). RESEARCH (all fetched 2026-10-04):
      * Circle Paymaster v0.7 — RECOMMENDED. developers.circle.com/
        paymaster.md: "permissionless", "You don't need to sign up… or
        generate any API keys", "no dependency on offchain APIs"; v0.7 is
        listed for "Arbitrum and Base" only (Ethereum only for v0.8).
        Testnet 0x31BE08D380A21fc740883c0BC434FcFc88740b58 (Arbitrum
        Sepolia, Base Sepolia); mainnet 0x6C973eBe80dCD8660841D4356bf15c32460271C9
        (Arbitrum, Base — NOT verified on-chain). Base Sepolia, read live:
        entryPoint() = v0.7, token() = USDC 0x036CbD53…CF7e, EntryPoint
        deposit ~1.0077 ETH, staked 0.25 ETH / 86,400 s; an ERC-1967 UUPS
        proxy whose implementation 0x1E42055dECF050828AfE8bA0A374bC5F44CbFC8d
        is a Sourcify exact match (solc 0.8.28), licence GPL-3.0-or-later.
        On ETHEREUM SEPOLIA the same proxy address has code but
        entryPoint() reverts and its v0.7 deposit is 0 — unusable there
        (Circle's v0.8 address reports EntryPoint v0.8). Rate: an on-chain
        oracle read during validation; on Base Sepolia the oracle returns
        a FIXED 3000.00000000 (roundId 1) and fetchPrice ignores updatedAt
        (no staleness check). Markup: the docs say a 10% surcharge on
        Arbitrum and Base "and their testnets", but on-chain feeSpread()
        is 0 on Base Sepolia (mainnet unverified); additionalGasCharge
        35,000 gas per op. Grant: an EIP-2612 permit inside paymasterData
        (uint8 0 ‖ token ‖ uint256 amount ‖ signature, deadline
        type(uint256).max) or a prior approve; USDC's permit accepts
        ERC-1271 signatures; the paymaster pulls the prefund DURING
        VALIDATION, so an approve batched into the same op is too late.
        Audit: Circle says third-party audits exist; no published report
        found → treat as unaudited. Circle can upgrade, pause, change the
        oracle, the spread and the extra gas charge; one token (USDC).
      * Pimlico ERC-20 paymaster — SECOND SOURCE. v0.7
        0x777777777777AeC03fd955926DbF81597e66834C (docs.pimlico.io),
        Sourcify exact match on chains 1 / 11155111 / 84532, MIT; Sepolia
        deposit ~140 ETH but NOT staked (EREP-050 risk with strict
        bundlers), Base Sepolia staked 5 ETH; PERMISSIONED — every op
        carries Pimlico's signature and the rate comes from Pimlico's API
        with its markup; token pulled in postOp (an approve can ride in
        the same op); the keyless public endpoint serves paymaster methods
        on testnets only — mainnet needs an API key; no audit of the
        singleton found. The only EntryPoint v0.7 option on Ethereum
        Sepolia.
      * ZeroDev ERC-20 gas: with context {token: USDC} the project RPC
        returned Pimlico's 0x7777… stub data on both testnets with no gas
        policy (the earlier "no ERC20 gas token data present" error only
        meant the token field was missing); docs add "a 5% premium" and
        list USDC on mainnets only — a proxy of the Pimlico source, not an
        independent one. Alchemy: needs an ERC-20 policy in its dashboard.
      ENGINE packages/chains-evm/src/token-paymaster.ts (smart-account.ts
      unchanged; plugs into the ERC-7677 paymaster seam):
      CIRCLE_TOKEN_PAYMASTER_V07, encodeCirclePaymasterData /
      parseCirclePaymasterData, exact-bigint mirrors of FeeLib and the
      v0.7 prefund (entryPointRequiredPrefund, circleTokenCost,
      circleUserCharge, quoteCircleTokenCharge → maxTokenCharge = the
      prefund pulled in validation, the true worst case; circlePostOpCharge),
      readCirclePaymasterState / circlePaymasterProblems (wrong EntryPoint,
      other token, paused, no stake, thin deposit), buildTokenPermit (max
      deadline), readTokenPermitInfo (refuses a DOMAIN_SEPARATOR
      mismatch), readTokenBalanceAndAllowance, circlePaymasterApproveCall
      (exact amount; refuses 0 or unlimited), TokenGasInsufficientBalance /
      Allowance / ChargeAboveLimit errors, createCirclePaymasterTransport
      (answers pm_getPaymasterStubData / pm_getPaymasterData locally; the
      stub carries a REAL permit sized for a 1.5M-gas ceiling because the
      bundler simulates the permit and transfer; the final data permits
      EXACTLY the worst case and leaves allowance 0 — both permits share
      one nonce so at most one takes effect; refuses another EntryPoint,
      chain, sender or method), decodeCircleSponsoredEvents. paymasterData
      byte-identical to ethers solidityPacked and viem 2.57.2 encodePacked;
      the permit digest matches ethers and viem; the tests reproduce the
      LIVE transaction's paymasterData byte for byte and recover the owner
      from the Kernel ERC-1271 envelope. PROOF scripts/testnet/
      token-gas-smoke.mjs: dry run (eth_simulateV1, USDC balance by a
      slot-9 override proven by read-back) passes for the public mnemonic
      (deploy + ERC-1271 permit + prefund + refund in one op with ZERO ETH
      in the account) and the dev owner; refusals AA33 "transfer amount
      exceeds balance" / "exceeds allowance" / permit one unit low, and
      the engine's own pre-check. LIVE (TOKEN_GAS_LIVE=1, Base Sepolia,
      ZeroDev bundler): the dev EOA sent 1 USDC to the dev Kernel account
      0xc995E49acA5C888F4FF1E50E8467E9fFc31CC5AC (tx 0x65fb119d…3a3968,
      block 47682895; the dev EOA already held 20 USDC on Base Sepolia
      from an earlier unknown source, now 19 — no swap needed); userOp
      0x49f93a1111f3fc4af130f091f417b66f648dfd86d67bc5e0c76b1a1bcf77b7f6,
      bundle tx 0x83f56b31aafd23b92d5c05624c054273267d266331e3cb593b165c1b0d12b4cb,
      block 47682905; verified on sepolia.base.org: paymaster = Circle's,
      permit nonce 0 → 1, USDC 15,291 to the paymaster (= the quote) and
      9,899 refunded, UserOperationSponsored actualTokenNeeded 5,392 at
      price 3,000,000,000, account USDC 1,000,000 → 994,608, account ETH
      and EntryPoint deposit UNCHANGED, allowance 0 before and after, the
      paymaster's deposit down by exactly actualGasCost. FINDINGS FOR THE
      CHAIRPERSON: docs-vs-chain on the surcharge (10% documented, 0 on
      Base Sepolia); a static test oracle and no staleness check; GPL-3.0
      code behind a Circle-controlled upgradeable proxy (adds to the
      counsel question); no published audits for Circle's or Pimlico's
      paymaster; Pimlico is permissioned and keyed on mainnet; ZeroDev
      resells Pimlico. UNVERIFIED: Circle's mainnet addresses, oracle and
      spread; other bundlers; deployment + permit through a real bundler
      (simulation only); the postOp formula against a trace; 7702 and
      passkey accounts; a live Pimlico run. Session keys cannot use the
      permit path (ERC-1271 is off for them). APP DESIGN NOTE: the stub
      needs an owner signature, so run estimation and signing after the
      biometric gate; show "Network fee paid in USDC: up to X (unused part
      refunded in the same transaction), no ETH needed", the rate and its
      source, the spread, the paymaster address, and "a one-time permit
      letting Circle's paymaster take at most X USDC; nothing stays
      approved"; pass maxTokenCharge = the displayed amount; show the
      actual charge from UserOperationSponsored on success; offer it only
      on the Base Sepolia profile for Kernel accounts (readiness: test
      networks only), hidden on Ethereum Sepolia.
- [x] Item 1 — TOKENS ON EVERY EVM PROFILE + TOKEN DISCOVERY (feature
      37) and Item 4 — FOLLOW-UPS (one commit, f1ac39d, because the slices
      share files; offline runner ALL GREEN in the CTO's isolated
      worktree: engine 773, app 4,209 across 37 suites, lint 0/0, tsc
      clean; nothing on a device).
      ITEM 1. One tracked list per profile (eip155:1 / 11155111 / 84532).
      NO MIGRATION by construction: mainnet keeps the key
      shiba-wallet.tokens.v1 byte for byte; other chains use
      shiba-wallet.tokens.v1.<CAIP-2>; each key is filtered to its own
      chain on read (foreign entries stay stored, never shown); a missing
      key = that chain's defaults (mainnet USDC; test networks Circle's
      USDC and EURC), a present key (even []) = the user's list verbatim.
      listTokens(chain?, store?) with no chain reads the active profile
      from prefs (keeps WcApprovalSheet correct unedited). Never on the
      wrong chain: loadTokenBalance(…, { expectedChain }) reads only when
      the endpoint serves the token's chain; the ERC-20 quote and Max
      require eth_chainId == the token's CAIP-2 chain; SendScreen refuses
      a token from another chain; maxErc20Send now also includes the
      OP-stack L1 fee (it had neither check before). Prices: the
      tokenPriceAssetId guard is unchanged (test tokens unpriced); the
      preview's contract-AND-chain label rule is unchanged. Consumers
      moved: Home rows (all profiles; the test-mode note is gone), Tokens
      screen, token sends, Activity decoder, Swap pickers (a selection
      from another chain resets on a mode flip), the logs-fallback
      history (any chain), approvals notes, preview, risk card, spending
      limits. NEW FACT: Base Sepolia EURC
      0x808456652fdb597867f38412077A9182bf77359F (Circle's EURC
      contract-addresses page, fetched 2026-10-04; symbol/decimals read
      live); all four test tokens and mainnet USDC re-read live.
      DISCOVERY: packages/chains-evm/src/token-discovery.ts
      (indexerTokenBalanceProvider over alchemy_getTokenBalances; params
      [address, "erc20", {pageKey, maxCount ≤ 100}], result
      {address, tokenBalances:[{contractAddress, tokenBalance | error}]}
      per www.alchemy.com/docs/data/token-api/…/alchemy-get-token-balances,
      fetched 2026-10-04; exact bigints, >64-hex values rejected per
      entry, an answer for another address discarded, a repeated cursor
      stops the walk; 13 tests). Docs gaps observed live: pageKey is not
      in the documented result (present only while more exist); the error
      field's shape is unspecified; zero balances are returned;
      alchemy_getTokenMetadata answered a plain address with empty fields
      instead of an error, so metadata is read from the chain, never the
      indexer; Base Sepolia answered 403 "BASE_SEPOLIA is not enabled for
      this app" for our key (a dashboard setting — INPUT if discovery on
      Base is wanted). App token-discovery.ts + the Tokens screen's "Find
      my tokens": re-checks the indexer's chain id, lists untracked tokens
      with an UNTRACKED tag, the full contract address, sanitised on-chain
      metadata, zero balances hidden and counted, a look-alike warning
      when the symbol equals a tracked/known token's but the contract
      differs, at most 5 pages and 25 metadata reads per run, and NOTHING
      auto-added. Live probes: Sepolia, emulator Account 1 → "0 untracked
      tokens found · 2 already tracked · 1 with a zero balance hidden" (it
      holds about 36 USDC and 41 EURC); mainnet standard test address → 3
      untracked airdrop-style tokens, 24 zero balances hidden. Dust in
      Activity ("+<0.000001", spoken "less than") and Swap's sell balance.
      Suites: check-tokens 95 offline / 106 live (was 23/28),
      check-token-send 56, check-base 101, check-approvals 159,
      check-failover 130, check-prices 112, check-home 60; two manual
      mutations (chain filter removed; mainnet defaults on test chains)
      failed 4 and 11 checks. Left for the aa.ts / subscriptions owners
      (wave 2): an optional chainCaip2 guard in prepareAaErc20Send /
      maxAaErc20Send; the user's tracked tokens in the subscription token
      list; WcApprovalSheet passing evmChain.caip2 explicitly. Pre-existing
      gap noted: Swap's sell balance is not masked by Hide amounts.
      ITEM 4 (check-aa 178, check-subscriptions 134, check-7702 131,
      check-wc 271, asset-diff tests 42). (1) Custom subscription period
      (whole minutes/hours/days; minimum 60 s on test networks — the
      engine's SUBSCRIPTION_MIN_PERIOD_SECONDS — else 1 hour; maximum 365
      days; the last two are judgement); "2 minutes (testing)" only on
      test networks; subscriptionShortWindowWarning when period × payments
      < 600 s (the default 2 min × 3 now shows it). (2) aa.ts
      aaFeeFromBalance is the single deposit rule; AaSendQuote.deposit is
      set when the read succeeded; Review quotes the install first, keeps
      its fee back from an untyped budget (lowering and re-quoting with a
      WarningBox; a typed budget is never changed), blocks Start with a
      warning when balance + deposit cannot cover the install, notes when
      the deposit is what makes it payable, and warns (without blocking)
      when the remainder is below payments + budget. (3)
      subscriptionHandoverOffer: an expired, never-handed-over
      subscription offers only Revoke then Forget, and
      buildSubscriptionKeyExport refuses it. (4) subscriptionDisplayTitle
      fixes legacy "Subscription: Subscription" titles at render time. (5)
      "Copied ✓" follows the clipboard helper's pending state. (6)
      SMART-ACCOUNT MAX: prepareAaCalls option fromMax — only a self-paid
      plain native transfer whose amount came from Max is lowered (each
      candidate priced through the bundler estimate, at most 3 rounds,
      never raised; typed amounts, contract calls and sponsored ops never
      trimmed; maxAdjustment only when changed, unadjusted quotes key-for-
      key identical); DECISION: Max must fit beside the FULL worst-case
      fee without the EntryPoint deposit, because sendCalls re-estimates
      at signing and the account pays fee − deposit in validation before
      the transfer runs — the unused deposit absorbs a rise (typed amounts
      may still use the deposit for the fee). (7) F5: WETH9
      Deposit(address indexed dst, uint wad) / Withdrawal(address indexed
      src, uint wad) (gnosis/canonical-weth WETH9.sol at 0dd1ea3e; topics
      keccak-computed, pinned against ethers) decoded ONLY for
      WRAPPED_NATIVE_TOKENS — mainnet 0xC02a…6Cc2, Sepolia 0xfFf9…6B14
      (Uniswap's deployments page), the OP-stack predeploy 0x4200…0006
      (each checked on-chain: both topics in code, symbol() "WETH") — and
      only when traceTransfers shows exactly that ETH moving between the
      wallet and the wrapper in the matching direction in the same call
      (one movement backs one event; dropped when the wrapper also emitted
      an equal mint/burn Transfer); pinned because other contracts (e.g.
      the old Gnosis MultiSigWallet) emit the same Deposit shape; the
      constants are not exported from the package (nothing needs them).
      (8) Base L1 fee: wcOpStackFeeLines adds "Layer 1 data fee
      (estimate)" (and an operator-fee row when non-zero) to the
      WalletConnect sheet; delegation.ts serializeUnsignedSetCode (pinned
      byte for byte against ethers 6.17 unsignedSerialized) +
      quoteSetCodeOpStackFees — op-geth (b355734b) RollupCostData charges
      every non-deposit type from MarshalBinary, and GasPriceOracle.getL1Fee
      (optimism 773798a6) is type-agnostic; the authorization's signature
      can only be made after the biometric gate (D6), so the quote prices
      stand-in r/s (keccak digests, incompressible like a real signature)
      and the 50% reserve covers the difference; an oracle failure refuses
      the quote; Sepolia quotes unchanged. (9) both unreasoned eslint
      disables in WcApprovalSheet removed by complete dependency lists
      (behaviour change: narrowing an ERC-7715 grant re-quotes on any
      grant change). Unverified: everything on a device; a real bundler
      accepting a trimmed Max op; the real compressed size of the 7702
      authorization signature.
- [x] Item 2, app half — "Pay the network fee in USDC" (commit adb3a6b;
      new check-token-gas 125, check-readiness 161; offline runner ALL
      GREEN in the CTO's isolated worktree: engine 773, app 4,339 across
      38 suites, lint 0/0, tsc clean; NOT run on a device or a live
      network). app/src/wallet/token-gas.ts + aa.ts + SendScreen. The
      switch sits on the Send FORM under the smart-account toggle (off by
      default; Max depends on the fee mode), shown only after
      readCirclePaymasterState / circlePaymasterProblems pass on the
      active endpoint (cached 60 s; a failed read is not cached). OFFERED
      (tokenGasOffer): Base Sepolia only (CIRCLE_TOKEN_PAYMASTER_V07.tokens
      lists only 84532), readiness row token-gas (testnet-only, enforced;
      C1, C2, C3, W8, W9), a Kernel v3.3 account at its own address —
      factory or recovered. REFUSED with a plain sentence: SimpleAccount
      (no ERC-1271), EIP-7702-upgraded owners and the passkey signer (both
      unverified in the engine; the 7702 envelope differs), and when an
      ERC-7677 sponsorship paymaster is configured; session keys never
      reach it. QUOTE loads no key and makes no bundler estimate: the
      worst case is the engine stub's figure (the 1,500,000-gas ceiling +
      200,000 paymaster verification + postOp, at the quote's fees after
      the bundler priority-fee floor, through quoteCircleTokenCharge); it
      also checks the paymaster deposit and the permit domain
      (readTokenPermitInfo refuses a DOMAIN_SEPARATOR mismatch); the
      quote's ETH fee is 0n. SEND: after the biometric gate, inside ONE
      signWith (one system prompt), a SmartAccountClient with
      createCirclePaymasterTransport in permit mode, maxTokenCharge = the
      displayed amount, padding {verification 110, call 130,
      preVerification 105} (the live-proven values); every permit incl.
      the estimation stub passes assertTokenGasPermit (value ≤ displayed,
      owner, spender, token, chain, deadline); a
      TokenGasChargeAboveLimitError returns to the form ("The network fee
      in USDC would now be up to R USDC, above the L USDC you approved.
      Nothing was sent…"). MAX: native = the full ETH balance; USDC =
      balance − worst case; another token = its full balance if USDC
      covers the fee. SPENDING LIMITS: the USDC fee is NOT counted
      (countFees exists only on native limits and the quote's ETH fee is
      0n); the USDC amount of a USDC send still counts. SUCCESS: the
      actual charge from UserOperationSponsored (matched on userOpHash,
      paymaster, token, sender), never guessed. Copy: fee "Network fee
      paid in USDC: up to X USDC; the unused part is refunded in the same
      transaction; no ETH is needed for the fee."; rate "1 test ETH = 3000
      USDC, from the paymaster's on-chain oracle." + the fixed-test-price
      note; spread "0% (0 basis points), read from the paymaster" + the
      documented-10% note; the paymaster address in full. CTO CHANGE
      before commit: the grant sentence said "nothing stays approved",
      which the builder's own analysis shows can be false — the estimation
      permit reaches the bundler first and shares the USDC permit nonce
      with the final one, so a third party submitting it to USDC first
      would make the final permit fail and leave the paymaster an
      allowance of up to the displayed amount minus the charge (usable
      only inside this account's own signed operations); the sentence now
      reads "A one-time permit letting Circle's paymaster take at most X
      USDC. The permit is used up by this operation, so normally nothing
      stays approved." with the reason in a code comment. TO RECORD in
      docs/THREAT_MODEL.md at the leadership refresh (proposed F-58):
      Circle's paymaster — no published audit, GPL-3.0 behind a UUPS proxy
      Circle controls, a static test oracle with no staleness check, the
      surcharge docs-vs-chain gap, and the stub-permit residual above.
      Follow-ups applied: aa.ts prepareAaErc20Send / maxAaErc20Send refuse
      a token from another chain (assertAaTokenChain; quotes key-for-key
      unchanged); the subscription token list appends the user's tracked
      tokens on that chain; WcApprovalSheet passes evmChain.caip2.
      UNVERIFIED: ZeroDev's estimate accepting the stub for a
      counterfactual account, whether it returns
      paymasterVerificationGasLimit, the layout and dark mode, the
      recovered-account case. Emulator checklist (12 steps, Base Sepolia,
      needs ~1 test USDC on 0xD31c…D8FA there — the dev EOA holds ~19) in
      the builder's report.
- [x] EMULATOR RUN at 1fab9a6 — items 1 and 4 verified live, and Item 5:
      THE FIRST LIVE ERC-20 SUBSCRIPTION PULL (2026-10-04; Metro worktree
      at 1fab9a6, engine built inside it, 2,296 modules; no repo files
      edited; every hash verified on a public RPC). (A) TOKENS PER
      NETWORK: Sepolia Home shows USDC 36 and EURC 40.991829 (matching
      the chain), no fiat, no mainnet token; "Tracked tokens on Ethereum
      Sepolia"; Remove EURC → "Find my tokens" without an indexer shows
      the needs-an-indexer sentence; after saving the Sepolia history
      indexer (typed via ADBKeyboard; now saved on the device): "1
      untracked token found · 1 already tracked · 1 with a zero balance
      hidden.", "UNTRACKED TOKEN / EURC / Balance: 40.991829 / Contract
      0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4 / Track EURC" (Track adds
      at once, no confirm); mainnet mode shows only USDC 0. (B) USDC SEND,
      EOA → own Kernel account, 1 prompt "Approve sending 2 USDC": fee
      "paid in test ETH", preview "You send 2 USDC", the own-account risk
      line, eth_call passed; tx 0x7602b6c2…e6e9d5, block 11843700, Transfer
      of exactly 2,000,000 base units; Home updated without a pull. (C)
      SMART-ACCOUNT USDC SEND 0.5 back, 1 prompt: userOp 0xa6d8c4ae…5cdb66,
      bundle tx 0xdcc8bb49…5eb781, block 11843716, Transfer 500,000,
      UserOperationEvent success. (D) Subscription form: custom period
      with its hint, the testing preset, the short-terms warning, the
      EntryPoint deposit row and the fee-budget lowering note all render.
      (E) ERC-20 SUBSCRIPTION (0.1 USDC every 15 min × 2, merchant
      0x69F0…7E8a): review order warning box → sentence naming USDC →
      start note → bullets; install userOp 0x0dd169fc…1205b0, tx
      0xc8091a4d…a4b2fe, block 11843831 (permission 0x321c1cd3, session
      key 0x6d6Fab3c…72Bd; 3 prompts only because the driver answered the
      first one after the 30 s hold); final terms from the tap time;
      hand-over 2 prompts (Copy → .dev-wallet at 0600 → cleared and
      deleted afterwards); keeper import + PULL 1: userOp 0x9f95b31e…dcb020,
      tx 0x9fe98beb5a43ecec989b2454f94ccb7048cb8451a1cd327b842081579af8b56b,
      block 11843849, status 0x1, USDC Transfer of EXACTLY 100,000 base
      units from the Kernel account to the merchant, UserOperationEvent
      success; a second pull before the period was REFUSED at submission
      "-32500 … AA22 expired or not due"; an over-cap pull (100,001) was
      REFUSED at estimation "AA23 reverted 0x59d52e40" =
      CallViolatesParamRule() (selector recomputed with keccak) — the
      first live proof of the ERC-20 parameter rule; card "1 of 2 payments
      taken." with the fee budget equal to the keeper's figure; revoke
      userOp 0x5e6dad4e…4b2c9c, tx 0x9bacae1b…a1939, block 11843880; pull
      after revoke refused. (F) EXPIRED CARD: a 2 min × 2 native
      subscription left to expire shows the expired box and only Revoke
      (install tx 0xb89141fc…3eff7 block 11843912; revoke tx
      0x921eb932…7325 block 11843943). (G) SMART-ACCOUNT MAX TRIM SEEN
      LIVE (not sent): after ~105 s Review showed "The amount was lowered
      from 0.002515568514493859 test ETH to 0.002513727360327474 test ETH
      because the network fee rose after you tapped Max. The amount plus
      the worst-case fee now fits the smart account's balance; its
      EntryPoint deposit, if any, is left as a reserve for the fee." with
      total = balance. (H) BASE: USDC/EURC rows (0, confirmed on-chain);
      the Upgrade confirm shows "Layer 1 data fee (estimate)
      0.000000011477591219 test ETH" with the stand-in-signature note;
      nothing sent. Funds: one top-up dev EOA → Kernel 0.004 Sepolia ETH
      (tx 0xc011df21…28ea, block 11843737; dev EOA 0.037996 left); Kernel
      account 0.002854 ETH + 0.000696 deposit + 1.4 USDC; Account 1 EOA
      0.002013 ETH, 34.5 USDC, 40.99 EURC; merchant 0.1 USDC. BUGS (fix
      slice dispatched): (1) the smart-account token send's risk card is
      wrong — SendScreen passes to = calls[0].to with no counterparty, so
      it describes the USDC contract ("first time sending to it") and
      omits the own-account line; (2) the subscription fee budget is built
      on a balance read once when the form opens (stale after funding;
      for a USDC subscription it then said "cannot spare anything for fees
      after the payments themselves"); (3) A REVOKE WAS REFUSED BY THE
      BUNDLER AFTER THE BIOMETRIC PROMPT: "-32602: maxPriorityFeePerGas
      must be at least 32305086 (current … 29835424) - use
      pimlico_getUserOperationGasPrice…" — the floor drifted ~8% between
      quote and send, there is no margin and no re-fetch at send time, and
      re-tapping re-sends the stale quote (likely every smart-account
      confirm on ZeroDev); (4) a raw "fetch failed:
      java.net.UnknownHostException … 0xrpc.io" in the subscription
      re-quote alert (unsanitised, and that path does not fail over;
      transient DNS); (5) the expired card still shows "Key still on this
      device: hand it to the merchant (shown once)." above the expired
      box; (6) user copy cites an internal file ("engine notes,
      kernel-permissions.ts"); (7) subscription revokes say "session";
      (8) the card's "Next payment" line goes stale after a failed
      revoke; (9) keeper: pull without --unchecked submits an early pull
      instead of refusing locally, prints "100000 token units" for USDC,
      and merchantDeltaWei reports ETH only for ERC-20 pulls; (10) dev
      only — the LogBox toast "Cannot connect to Expo CLI…" ends with
      "Error: undefined", the likely source of the intermittent warning
      recorded in phase 9. Minor: the Tokens screen header reads "Tokens"
      (the network is in the section heading); Track adds without a
      confirm. End state: Ethereum Sepolia, Account 1, light mode, Google
      IME, no policy, every subscription revoked; Metro still at 1fab9a6.
- [x] Emulator-run findings FIXED (commit 7c29fc7; engine 774 (+1:
      beforeSign); check-aa 215 (was 178), check-aa-kernel 149,
      check-token-gas 130, check-passkeys 131, check-recovery 257,
      check-sessions 137, check-subscriptions 154, check-tokens 99; 16
      mutation breaks each caught; offline runner ALL GREEN in the CTO's
      isolated worktree: app 4,427 across 38 suites, lint 0/0, tsc clean;
      NOT run live). BUNDLER FEE FLOOR: the refusal text matches
      pimlicolabs/alto (main at 96529592, src/rpc/rpcHandler.ts 255–274),
      which refuses when EITHER maxFeePerGas or maxPriorityFeePerGas is
      below the lowest recently observed price (which bundler software
      ZeroDev runs is undocumented). (a) Every smart-account quote prices
      at the bundler's floor + 25% (AA_FEE_FLOOR_HEADROOM_PERCENT, rounded
      up, exact bigint; priority raised to floor × 1.25 with maxFee rising
      by the same amount; a stated maxFee minimum × 1.25; unchanged when
      already above) — the confirm's worst case includes it; the cost is
      at most 25% of the priority floor per gas. (b) NO FEE IS RAISED AT
      SEND TIME: sendAa signs exactly the quoted fees; before signing it
      re-reads the floor (assertQuoteFeesMeetBundlerFloor) and throws
      AaFeeRoseError "The network fee rose. Please review again." when the
      floor exceeds the quoted fees (the 8% live drift passes; > 25% is
      refused; an unreadable floor passes, best effort). (c) The engine's
      SmartAccountClient.sendCalls gained an additive { beforeSign } hook;
      the app's signedFeeGuard refuses when the signed worst case
      (requiredPrefund) exceeds the displayed fee or the fees differ from
      the quote — the client re-estimates gas at send time and a larger
      estimate was previously signed silently (paymaster ops skipped:
      sponsored costs nothing, the USDC fee is capped by maxTokenCharge).
      (d) A quote can be submitted ONCE (claimQuoteForSubmission, a
      WeakSet; purely local refusals leave it usable), and every screen
      returns to the step that quotes again after a failure (Send, Swap,
      Guardians, owner change, Passkey, Approve a recovery, Sessions, the
      WalletConnect sheet). (e) Applied on every path: sendAa callers,
      passkey ops (checks before the passkey prompt), the guardian
      recovery submit (its quote now mirrors the deposit top-up headroom —
      its displayed fee could be below what was signed before), session-key
      ops, and the USDC-fee path (priced and signed at the headroom fees).
      (f) The subscription Start re-quote tolerated +20% above the
      reviewed fee, which broke "never sign more than shown": the review
      now DISPLAYS the reviewed fee + 20% as "Max network fee" with an
      explanation, and the funding lines and keep-back use that figure.
      KNOWN TRADE-OFF: on Base, where preVerificationGas follows the L1
      fee, a re-estimate that grows even slightly is now refused ("review
      again") rather than signed at a higher cost; if frequent, add a gas
      margin inside the displayed fee. OTHER FIXES: aaRiskWarningTarget
      gives the risk card the token's recipient as counterparty on
      smart-account token sends (incl. the USDC-fee path); the
      subscription form re-reads balance, deposit and fee on open, focus
      and Review ("holds X plus an EntryPoint deposit of Y (read just
      now)") and words a token-subscription shortfall as the install fee
      versus balance + deposit; describeSessionError gives a plain
      sentence + cleaned technical detail (bundler texts verbatim) and
      session / subscription quotes fail over once on NODE failures only,
      sending through the bundle they were quoted on; the expired card's
      key line reads "Key still on this device. It can no longer be used
      for payments; it is deleted from this device when you revoke.";
      internal file names removed from user copy (subscription/session
      audit notes, two passkey strings, the Settings readiness note) and
      check-sessions now scans every string literal and JSX text in 111
      app/src files for file paths and doc references; "Revoke
      subscription" wording on the title, button, prompt and progress; the
      card re-reads after a failed action; keeper: pull without
      --unchecked refuses an early pull locally from the on-chain next
      slot, prints "0.1 USDC (100000 base units)", and reports
      merchantDeltaBaseUnits for ERC-20 pulls; the Tokens header reads
      "Tokens · <network>"; Track asks first with the full contract and
      the look-alike warning. Incident (repaired by the agent): a mutation
      test's `git checkout -- recovery.ts` reverted its edits; restored
      from its own copy; the green runs are on the restored file.
      UNVERIFIED: whether ZeroDev's bundler checks the maxFeePerGas floor
      as Alto does; Rundler states a priority floor only; fee facts are
      not re-read on return from the background; the WalletConnect
      ERC-7715 path keeps its own error wording.
- [x] GAS PAID IN USDC, PROVEN LIVE IN-APP ON BASE SEPOLIA (2026-10-04;
      emulator, Metro worktree at 0e00f34, 2,297 modules; no repo files
      edited; every figure verified on-chain). Funding by a scratch
      script mirroring token-gas-smoke.mjs (eth_call first; capped at 2
      USDC): dev EOA → Kernel 0xD31c…D8FA 2 USDC (tx 0x26de97a2…ad6f76,
      block 47687709) and → Account 1's EOA 1 USDC (tx 0x8b18cf6a…b48c3,
      block 47687710); dev EOA USDC 19 → 16. Readiness row "Paying the
      network fee in USDC — Test networks only" with its reason. (B) 0.5
      USDC to Account 1's EOA with the USDC fee: the switch appears under
      the smart-account toggle; confirm "NETWORK FEE (PAID IN USDC) up to
      0.06007 USDC" (1,770,000 gas × 0.0113125 gwei × 3000 — arithmetic
      checked), the rate + fixed-test-price note, "0% (0 basis points),
      read from the paymaster", the paymaster address in full, the grant
      sentence with "normally nothing stays approved", TOTAL USDC (WORST
      CASE) 0.56007; ONE prompt; userOp 0x85904440…904df5, tx
      0xae6a7d67aceb3805709fe5559a0cb11f1c0d8680fdaa35f33fd0f3dd9b3cf320,
      block 47688510; success line "Network fee charged: 0.005776 USDC (up
      to 0.06007 USDC was permitted; the rest was refunded in the same
      transaction)."; on-chain: paymaster = Circle's, UserOperationSponsored
      actualTokenNeeded 5776 (= the line shown), prefund 23,541 pulled and
      17,765 refunded, Kernel ETH 2,894,423,407,550,000 wei and deposit
      IDENTICAL at block−1 and block, allowance 0 both, USDC 2,000,000 →
      1,494,224 (= 0.5 + 0.005776). (C) 0.0001 test ETH to Account 2 with
      the USDC fee: Max = the full ETH balance; ONE prompt; userOp
      0xd932eb17…cb0db9, tx 0x6987a7d5f84ae766092735bef8ab5efa7d4b88bf8c88eebc0245b294e6776603,
      block 47688684; charge 0.005424 USDC (= actualTokenNeeded 5424);
      Kernel ETH down by exactly 0.0001, deposit unchanged, allowance 0.
      (D) USDC Max = balance − worst case (1.42873 of 1.4888), total =
      balance; not sent. (E) Negatives: the Ethereum Sepolia form shows
      the offered-only-on-Base-Sepolia sentence incl. "its entryPoint()
      call reverts and it holds no deposit there"; an over-balance send is
      refused before any prompt with both USDC figures. (F) FEE-FLOOR FIX
      HELD: a Sepolia smart-account send of 0.1 USDC tapped after a
      3-minute wait on the confirm went through with one prompt and no
      bundler refusal (userOp 0xb5e35cf2…15c5a9, tx 0x7e0a7b5e…d1fcf4,
      block 11844241; the fee came out of the EntryPoint deposit). (G)
      "Tokens · Base Sepolia" / "Tokens · Ethereum Sepolia"; Track asks
      first with the full contract. Observation: the final permit equalled
      the prefund the estimate needed (23,541), well under the displayed
      ceiling. FINDINGS (fix slice running): (1) the risk card on token
      sends still opens with "This transaction goes to a contract (<token
      contract>)" (+ a contract-age line on Sepolia) — both paths; (2)
      "Find my tokens" counted a token whose metadata read failed as "do
      not answer like an ERC-20 token"; (3) the preview footnote still
      talks about gas paid through the EntryPoint in USDC-fee mode; (4)
      Tokens / Settings copy still says the token-send fee is paid in ETH;
      (5) "Your smart account needs funds first." titles an
      amount-plus-fee shortfall on a funded account; (6) the WalletConnect
      readiness row still says identity checks and permit decoding do not
      exist. STANDING EMULATOR RULE ADDED: scroll Settings only with slow
      swipes at the screen edge and never fling near the Danger zone — a
      fling that started on "Wipe wallet from this device" opened its
      first dialog (cancelled at once; the wallet is intact). End state:
      Ethereum Sepolia, Account 1, light mode, Google IME; Base Kernel
      account 0.002794 ETH + 1.4888 USDC; Metro at 0e00f34.
- [x] Item 6 — leadership refresh (commit below). FEATURE_UNIVERSE
      section 15: row 16 Not started → Proven live (in-app, Base Sepolia,
      with the USDC-only / Base-only / unaudited limits), row 37 Not
      started → Proven live (per-network tokens and discovery, in-app),
      row 69 extended with the in-app runs and the ERC-20 pull; tally
      Proven live 34 (T1 27, T2 7), Built 16, Designed 2, Not started 47
      (T1 3: private-key import, fiat on-ramp, push notifications). The
      shareable page was rebuilt (counts 34/16/2/47 asserted) and
      published as VERSION 9 of https://claude.ai/artifact/JEfyMuPcMJ8YW5x3ZKitsw.
      DEMO.md: steps 12 (tokens on every network and "Find my tokens")
      and 13 (pay the network fee in USDC on Base Sepolia, with the slow-
      swipe warning), warning 2 updated. THREAT_MODEL.md: F-58 (the token
      paymaster's trust and the stub-permit residual; open) and F-59 (the
      bundler fee-floor drift; fixed in 7c29fc7); check-readiness 161
      still passes.

## Phase 13 status (2026-10-04)

Items 1, 2, 4, 5 and 6 are landed and pushed. Proven live this phase:
gas paid in USDC (engine by script, then twice through the app's Send
screen on Base Sepolia), per-network tokens with discovery, USDC sends
from the regular and the smart account, the first ERC-20 subscription
pull with its on-chain refusals, the smart-account Max trim, and the
bundler fee-floor fix. Engine: 774 tests. App: 38 offline suites, 4,427
checks at 7c29fc7. The shareable page is at version 9 (34 proven live,
16 built).

NOT STARTED, waiting on the Chairperson: item 3, single private-key
import (feature 12) — an imported key is not covered by the recovery
phrase, which bends requirement 2; the CTO asked for a decision twice
and holds the item until one arrives.

Findings for the Chairperson this phase: Circle's token paymaster has no
published audit, is GPL-3.0 behind a proxy Circle controls, uses a fixed
test price with no staleness check, and its documented 10% surcharge
reads 0 on Base Sepolia (F-58; adds to the counsel question); the only
EntryPoint v0.7 option on Ethereum Sepolia is Pimlico's permissioned
paymaster, which ZeroDev resells and which needs a key on mainnet.

Inputs that would unlock more: the private-key decision; enabling Base
Sepolia for the Alchemy key (token discovery there); the ZeroDev gas
policy; a phone and Expo account; the disclosure decision (four
findings); a Pimlico key for the second paymaster source.

Follow-ups (no inputs): the six findings of the last emulator run (fix
slice running); a gas margin inside the displayed fee if Base refuses
re-estimates often; the WalletConnect ERC-7715 error wording; fee facts
on return from the background.
- [x] Gas-in-USDC run findings FIXED (commit e1e3178; check-approvals
      180, check-tokens 109, check-aa-kernel 155, check-token-gas 142,
      check-readiness 162; nine mutation breaks each caught; offline
      runner ALL GREEN in the CTO's isolated worktree: engine 774, app
      4,477 across 38 suites, lint 0/0, tsc clean; not seen on a device).
      (1) RISK CARD ON TOKEN SENDS (both paths were identical and both
      wrong): risk.ts tokenTransferTarget returns a token only when `to`
      is a tracked/known token on the active chain THAT HOLDS CODE, a
      counterparty is given and differs from `to`, and the calldata is
      exactly transfer(counterparty, x); then the class, delegation and
      contract-age checks run on the RECIPIENT and the card opens with one
      line — "This sends USDC through its token contract 0x… to a regular
      account with no contract code on this network (0x…)." / "… to a
      contract (0x…)." / "… to one of your own accounts in this wallet:
      <label> (0x…)." (and the upgraded-own-account, foreign-delegated and
      could-not-be-checked variants); untracked tokens, tracked addresses
      on another chain, calldata paying anyone else, approve and other
      calls, NFTs and a code-less "token" keep the existing warnings, so a
      spoofed counterparty cannot suppress one; the recipient's
      new-contract, delegated and first-interaction lines are still
      raised; a check pins the full card equal for the same send from the
      regular and the smart account. (2) erc20.ts splits
      Erc20NotATokenError (only on a revert / execution failure, malformed
      return data or decimals > 255; old message byte-identical) from
      Erc20ReadUnavailableError (transport, HTTP, non-execution JSON-RPC
      errors, null result); discovery counts the latter as "N could not be
      read right now — search again"; isExecutionErrorMessage's phrase
      list is a judgement from common node wordings. (3) aaPreviewNote:
      in USDC-fee mode the preview says "…The network fee is paid in USDC
      through Circle's paymaster and is shown above; it is not part of
      this list." (4) tokenSendFeeSentence / settingsTokensFeeSentence:
      "…normally paid in test ETH, not in the token. On Base Sepolia, a
      smart-account send can pay it in USDC instead when the Send screen
      offers that choice." (5) AaFundingError carries a title:
      aaAmountShortfallTitle → "Not enough <SYMBOL> for this amount plus
      the network fee." (or without the fee clause for sponsored and
      USDC-fee native sends) only when the account could pay for some
      send; the empty/under-funded cases keep "Your smart account needs
      funds first." (6) the WalletConnect readiness reason now says
      identity verification and Permit/Permit2 summaries are built and
      tested offline but not yet exercised with a live app over the relay.
      Left alone: Settings → Developer still says test networks are "each
      paid in test ETH". Phase 13's code is complete at this commit apart
      from item 3 (private-key import), which waits on the Chairperson.

DECIDED by the Chairperson (2026-10-04): (a) single private-key import
(feature 12) is wanted — build it, with the account labelled everywhere
as not covered by the recovery phrase; (b) Circle's token paymaster is
acceptable on test networks ("no risk there"); the test-networks-only
readiness gate and finding F-58 stand for mainnet.
- [x] Item 3 — SINGLE PRIVATE-KEY IMPORT (feature 12; commit 053d1b7;
      new check-key-import 212, check-readiness 167,
      check-settings-protection 51; core tests 25 → 29; offline runner ALL
      GREEN in the CTO's isolated worktree: engine 778, app 4,695 across
      39 suites, lint 0/0, tsc clean; the CTO spot-checked that the key
      files log nothing and never touch AsyncStorage and read the signWith
      branch; NOT run on a device). DESIGN: (1) account ids — an imported
      account's id is 2^31 + its vault slot (account-ids.ts); every
      derivation helper already refuses ids ≥ 2^31 (isValidIndex), so
      deriving an imported account from the phrase FAILS instead of using
      phrase key N; slots are never reused (high-water mark). (2) Core:
      isValidEvmPrivateKey (noble's secp256k1.utils.isValidSecretKey —
      rejects 0, n, n+1, wrong lengths, probed on noble 2.4.0) and
      evmAccountFromPrivateKey; imported and derived keys sign through one
      shared evmSigner closure, derived signing byte-identical (pinned);
      addresses and r/s/v cross-checked against ethers. (3) Storage
      (storage.ts): shiba-wallet.imported-key.v1.K (standard),
      .imported-key.v2.K (protected, service shiba-wallet.protected), and
      the public record shiba-wallet.imported-keys.v1 (slot, address,
      location, nextSlot — never key material); a save recomputes the
      address and refuses a mismatch with the one shown, reserves the slot
      first and follows the phrase's protection state (protected: write,
      read back, compare; a cancel aborts the import; a platform refusal
      or mismatch falls back to standard and says so); migration of
      standard keys runs ONLY on the explicit Settings "Protect with
      biometrics" (never during the automatic phrase move, to avoid
      surprise prompts) in the phrase's order (write, read back, record,
      delete), stopping at the first cancel or failure, and Settings
      states how many keys are still standard; the approval gate is
      target-aware (one prompt per operation for a protected imported
      key; the held secret is single-use and never handed to another
      target); a damaged record refuses every write and deletes nothing;
      wipe sweeps slots even with a damaged record and deletes imported
      keys FIRST. (4) signWith: imported branch refuses non-EVM chains
      ("This account comes from an imported Ethereum private key, so it
      can only sign on Ethereum networks. Nothing was signed."), reads
      through the vault, enforces expectAddress, zeroes the key bytes in a
      finally (the hex string cannot be zeroed — N-03). (5) Account store:
      entries carry imported: true; nextIndex and MAX_ACCOUNTS count
      phrase accounts only; imported accounts cannot be hidden, only
      removed (key deleted first, after two dialogs); phrase entries
      serialize byte-identically. (6) Smart accounts: salt 0 for an
      imported owner (the owner makes the address unique; recomputable
      from the key, the factory and index 0; NOT recoverable from the
      phrase). AUDIT: WalletConnect (EOA and smart sessions), Kernel /
      SimpleAccount sends, swap, 5792, the 7702 upgrade, session keys,
      passkeys, spending limits, proof of ownership, contacts' and the
      risk card's own-address lists all WORK; GUARDIANS and recovery
      records are REFUSED for an imported owner ("Guardians are not
      offered for a smart account owned by an imported private key: the
      recovery phrase does not back up that key, and the recovery record
      cannot say so yet…"), as are guardian recovery onto an imported key,
      attaching to one, and owner changes from or to one — the engine's
      record format has no field for "this owner is an imported key", so
      refusing beats half-support. HONESTY: the shared notice "This
      account comes from an imported private key. Your recovery phrase
      does NOT back it up: if this phone is lost or the wallet is removed,
      the account and its funds are lost unless you kept the private key
      yourself." on Home, Receive, every From/Owner row, the WalletConnect
      sheet, the import screen and the reveal; the name always ends
      " (imported key)"; BTC/DOGE/SOL rows say "Not available for an
      imported key…". Show private key reuses the phrase reveal's
      confirmation, gate and screenshot block, plus a Copy (a 64-character
      key is impractical to write by hand) overwritten after 60 s and on
      close. Readiness row imported-key (blocked, advisory; T-67, W1, W2,
      W3, W19); ADR D9 in ARCHITECTURE.md; T-67 and two secure-store rows
      in THREAT_MODEL.md (its section 7.4 suite-count table is stale).
      FEATURE row 12 → Built (tally Proven live 34, Built 17, Designed 2,
      Not started 46). KNOWN GAP: a key equal to a phrase account that is
      not yet listed is not detected as a duplicate. UNVERIFIED on a
      device: secureTextEntry / paste / keyboard suggestions, FLAG_SECURE
      on the import and reveal screens, protected-key prompts, the
      clipboard overwrite, TalkBack. Emulator checklist (11 steps,
      throwaway key only) in the builder's report.
- [x] PRIVATE-KEY IMPORT, PROVEN LIVE IN-APP (2026-10-04; emulator, Metro
      worktree at 44eef11 with the engine built inside it, 2,301 modules;
      no repo files edited; every hash status 0x1; a THROWAWAY key written
      to a 0600 scratch file, entered only through the ADBKeyboard
      broadcast, never printed, deleted afterwards; no 64-hex strings in
      logcat). After the reload Home showed Account 1 · 0x772e…F44F with
      NO prompt at launch (the storage code changed). (A) IMPORT: garbage
      refused ("A private key contains only the characters 0–9 and a–f…");
      the field is masked; preview "This key controls the Ethereum address
      0xe34F1a4a31B8c5730b74F9eC9B29770308E42D1B" = the address computed
      on the host; screencap 0 bytes while the field holds text; "Import
      this key? … NOT backed up by your recovery phrase…"; IMPORT raised 2
      prompts (protected write + read-back); row "Imported 1 (imported
      key)" with the "Imported" chip and "…imported private key, Ethereum
      only — NOT backed up by your recovery phrase"; Settings: "Your 1
      imported private key is protected by biometrics too…". (B) Home
      notice under the switcher; BTC/DOGE/SOL "Not available for an
      imported key…"; Receive "Imported private key — no derivation path,
      not part of your recovery phrase" and the Kernel counterfactual
      0x5426907b17EBF28A54A5821CDcac02f2c22104DE = the engine's
      predictKernelAddress(owner, 0) (salt 0 confirmed). (C) Funded from
      Account 1 (risk card: one of your own accounts; tx 0x80f33696…65a1f5,
      block 11845160); send back signed BY THE IMPORTED KEY, 1 prompt, tx
      0x9efc915c…634e4d, block 11845175, sender 0xe34f…2d1b. (D) SMART
      ACCOUNT OWNED BY THE IMPORTED KEY: funded (tx 0xb0a18aa4…38649b),
      then a smart-account send deployed it through ZeroDev, 1 prompt:
      userOp 0xc2ffdb40…653127, bundle tx 0x49d67558…8a0be7, block
      11845193; AccountDeployed, OwnerRegistered, UserOperationEvent
      success; readKernelOwner → the imported address. (E) Guardians
      refused with the recorded sentence; Change owner from Account 1
      lists only phrase accounts. (F) Show private key: dialog, 1 prompt
      "Reveal the imported private key", screencap 0 bytes (the key screen
      was never dumped); the Mac pasteboard held 66 bytes after Copy and 0
      about 60 s later. (G) Relaunch: 0 prompts, the imported account
      still listed. (H) Sweeps (smart-account tx 0xac8cfe68…eedc3a block
      11845270; EOA Max, block 11845280), then Remove with two dialogs
      ("Remove this imported account? … Your recovery phrase cannot bring
      it back…" / "Delete the private key? …"), 0 prompts; the row is gone.
      (I) Last fix slice eyeballed: the USDC confirm's risk card is the
      single line "This sends USDC through its token contract 0x1c7D…7238
      to one of your own accounts in this wallet: Account 2 (0xb699…81fE)."
      with no contract-age line; "Tokens · Ethereum Sepolia" and the new
      fee sentence; the WalletConnect readiness reason; the "Imported
      private keys" row. Funds: dev EOA → Account 1 0.004 Sepolia ETH (tx
      0x8075fab3…5f97, block 11845137; dev EOA 0.0340 left); about
      0.000517 test ETH stranded with the deleted throwaway key (mostly a
      0.000495 EntryPoint deposit). FINDINGS (fix slice running): (1) THE
      FEE-FLOOR GUARD REFUSED TWO SENDS IN A ROW AFTER THE PROMPT ("The
      network fee rose. Please review again.") on floor moves of +12% and
      +1% within ~20 s — contradicting the 25% headroom recorded for
      7c29fc7; the quote seems to carry the floor with no margin in some
      case; (2) the Settings → Accounts intro still opens "Every account
      comes from your one recovery phrase…"; (3) "Change owner…" is
      offered then refused for an imported-owner Kernel account; (4)
      removing an imported key needs no device check; (5) the removal
      dialog does not mention the key's smart account or its EntryPoint
      deposit, and the app cannot withdraw a deposit; (6) Home copy for an
      imported account (token fee "in ETH"; the guardians-recovery link);
      (7) "The smart account pays its own gas from its own balance." when
      the deposit pays; (8) two wording nits. FEATURE row 12 → Proven live
      (tally Proven live 35 — T1 28 — Built 16, Designed 2, Not started
      46); the shareable page is VERSION 10. End state: Ethereum Sepolia,
      Account 1, light mode, Google IME, no imported account; Metro at
      44eef11.
- [x] Fee-floor guard and imported-key findings FIXED (commit e851481;
      check-aa 273 (was 215), check-key-import 241, check-readiness 169;
      offline runner ALL GREEN in the CTO's isolated worktree: engine 778,
      app 4,784 across 39 suites, lint 0/0, tsc clean; not run on a
      device). FEE FLOOR — ROOT CAUSE (measured, not a headroom defect):
      the two refusal figures were the bundler's new price versus the
      REVIEWED price, which already included the 25% (108,460,172 =
      ceil(1.25 × 86,768,137); 67,431,797 = ceil(1.25 × 53,945,437)), so
      the standard tier had really risen +40.0% and +26.3% within ~20 s.
      From pimlicolabs/alto (96529592): pimlico_getUserOperationGasPrice
      returns the bundler's LATEST observed price × slow/standard/fast
      multipliers, while its refusal compares against the MINIMUM over
      the last gas-price-expiry seconds (default 20 s) — the standard tier
      is a noisy point estimate above what is accepted. Read-only probes
      of ZeroDev's Sepolia endpoint (2026-10-04, id never printed): tiers
      always exactly 1 : 1.05 : 1.10; the standard priority fee moved
      0.0014–0.117 gwei over minutes and +90.7% within 10 s; the node's
      eth_maxPriorityFeePerGas was a constant 0.001 gwei; the maxFee tier
      moved ≤ 17.7% in 60 s; under the old rule 15–16% of quote/send pairs
      ~20 s apart would refuse (17–45% at ~60 s). CHANGES: the send-time
      comparison uses the SLOW tier (BundlerFeeFloor.lowest; quotes still
      priced at standard × 1.25) — under Alto's semantics an op at or above
      the slow tier is above the minimum (assumes ZeroDev's slow
      multiplier is 100, inferred from the ratio, unpublished);
      checkAaQuoteBeforeApproval runs the floor check BEFORE the device
      check on Send, Swap, Guardians, owner change, Passkey install and
      remove, Sessions grant and revoke, Approve a recovery and the
      WalletConnect sheet (the in-send checks stay as the last line of
      defence; Upgrade has no bundler floor; subscription Start already
      re-quotes before the prompt); AaFeeRoseError carries a reason —
      "The bundler's minimum fee rose: …" / title "The gas estimate grew.
      Please review again." / "Please review the operation again.";
      AaDepositNote shows "EntryPoint deposit (pays fees first)" with the
      deposit sentences on every smart-account confirm, and "pays its own
      gas from its own balance" only when there is no deposit. RESIDUAL
      (measured over ~10 minutes of samples): with 25% headroom and the
      slow-tier check about 13% of quotes 20 s old and 17–31% of quotes
      60 s old still bounce (now before the prompt, with a fresh quote),
      and ~4–9% of 5-second gaps can still trip the send-time check;
      measured alternatives: 50% headroom → 8–12% refusals; 100% → 0–5%
      at roughly +5–10% actual cost on Sepolia (the priority fee is 5–10%
      of the effective price). CTO DECISION: raise the headroom to 100% in
      the next slice (the tests pin the 25% figures from the live cases,
      so it is its own change); nothing above the displayed worst case is
      signed either way. DEPOSIT ANALYSIS: EntryPoint v0.7 asks the
      account for requiredPrefund − deposit, takes the whole prefund and
      credits prefund − actualGasCost back to the DEPOSIT, not the balance
      (phase 11's deployment: 1,127,572,960,505,705 − 458,756,313,552,258
      = the recorded 0.000669 ETH); the 40,000-gas top-up headroom is only
      ~14% of it — the bulk is maxFee = 2 × base + tip versus the
      effective price and gas limits versus gas used; the deposit is
      bounded by about one worst-case fee and is spent first by later
      ops, so the headroom stays. IMPORTED KEYS: removal asks
      requireLocalAuth("Approve deleting the imported private key") after
      both dialogs (cancel → "Nothing was deleted."); the removal dialog
      appends what would be stranded ("This key also controls the smart
      account 0x… on <network>, which holds A and an EntryPoint deposit of
      B. Only this key can move them… Other networks were not checked.");
      no "Change owner…" on an imported owner's Guardians screen; the
      Accounts intro, Home (no guardians-recovery link for an imported
      account; the corrected token-fee sentence for every account), the
      single-key protection note and the two-sentence readiness reason
      are corrected; adding a phrase account whose address equals an
      imported key's is FLAGGED ("This key was already imported"; an index
      is never reused, so it cannot be refused), with the note that the
      phrase account's smart account has a different address (salt N, not
      0). UNVERIFIED: ZeroDev's bundler software and settings; that its
      slow tier is at or above its acceptance minimum; everything on a
      device.

## Phase 14 plan (approved 2026-10-04): payments people can use

Approved by the Chairperson as proposed. The account-abstraction
machinery is proven; this phase builds the everyday layer on top of it,
with no new inputs.

0. Carry-over: widen the bundler fee-floor headroom from 25% to 100%
   (CTO decision recorded under the phase 13 fixes), and an emulator
   check of the last fix slice (e851481).
1. Payment requests, links and QR invoices (features 67, 68): Receive
   gains "request an amount", producing a standard payment URI and QR
   per chain (EIP-681 for EVM incl. ERC-20 transfers, BIP-21 for Bitcoin
   and Dogecoin, Solana Pay — each verified from its specification);
   scanning or pasting one pre-fills Send (recipient, amount, token,
   chain id), always through the existing validation, never widening it.
2. Name resolution (feature 74): ENS names in the Send recipient field,
   resolved through the engine with the method verified from ENS's
   current documentation, shown as the full address before anything is
   quoted, with the existing contact and look-alike rules applied to
   the resolved address.
3. Gas in tokens on more networks (feature 16): the second paymaster
   source on Ethereum Sepolia through ERC-7677 on the bundler already in
   use (research found it answers on test networks without a key; live
   send unverified), and an Arbitrum Sepolia test profile where Circle's
   paymaster is also deployed (verify every address on-chain first).
4. Inheritance switch (feature 48, "only with AA"): an heir who can take
   over a smart account only after a long delay the owner can veto,
   built on the guardian engine; the known weakness (guardians can sign
   messages as the account immediately) stays stated on every screen.
5. Scheduled and recurring payments (features 25, 63): a design document
   first — what can honestly be scheduled from the user's own side with
   session keys and a keeper, what a recurring swap would need — then
   the smallest buildable slice if the design supports one.
6. Watch-only accounts (feature 10): follow any EVM address with no key;
   every signing path refuses plainly.
7. Leadership refresh at the end: feature rows, the shareable page,
   DEMO.md, the threat model.

Waves: 1 — four agents on disjoint files: (A) items 0 and 3, (B) items
1 and 2, (C) item 6, (D) items 4 and 5; then one emulator pass; fixes;
7 last. Subagents on Opus.

## Phase 14 progress
- [x] WAVE 1 (commit f364451; four slices verified as one tree in the
      CTO's isolated worktree: engine 814, app 5,366 across 43 suites,
      lint 0/0, tsc clean; nothing on a device). The pre-commit scan
      flagged 12 consecutive BIP-39 words in PaymentRequestViews.tsx —
      ordinary identifiers (amount, asset, token, family, address, label,
      message, note are all wordlist words); the code was restructured,
      the scanner left strict.
      ITEM 0 — headroom: AA_FEE_FLOOR_HEADROOM_PERCENT = 100n; the two
      recorded live rises (+40.0%, +26.3%) now pass and +101% refuses;
      check-aa 287.
      ITEM 3a — PIMLICO ERC-20 PAYMASTER OVER ERC-7677 ON ETHEREUM
      SEPOLIA, PROVEN LIVE BY SCRIPT. SingletonPaymasterV7
      0x777777777777AeC03fd955926DbF81597e66834C (Sourcify exact match on
      1 / 11155111 / 84532 / 421614, solc 0.8.26, MIT, not a proxy; code
      keccak 0x337b6e1b…d98fbc identical on the three test networks). From
      source: paymaster data = mode (ERC-20 = 1), flags (constantFee /
      recipient / preFund), validity, token, postOpGas, exchangeRate,
      paymasterValidationGasLimit, treasury, Pimlico's signature; the
      token is pulled in postOp (costInToken = ((actualGasCost + penalty +
      postOpGas·fee)·rate)/1e18 + constantFee, sender → treasury), and
      EntryPoint v0.7 reverts postOp if the cost exceeds the prefund, so
      the wallet computes an EXACT maximum from the signed fields
      (erc7677MaxTokenCharge) and the op's first call is approve(paymaster,
      exactly that maximum); data with a preFund or a recipient is
      REFUSED. ZeroDev's Sepolia RPC returns Pimlico's stub with context
      {token: USDC} and no gas policy (rate ≈ 3,000 USDC/ETH, postOpGas
      18,990; it does not serve pimlico_getTokenQuotes); the paymaster is
      NOT staked on Ethereum Sepolia but ZeroDev accepted it; the markup
      cannot be measured on a testnet (Pimlico: baked into the rate;
      ZeroDev documents a 5% premium); no audit of the singleton found.
      Engine packages/chains-evm/src/erc7677-token-paymaster.ts (14 tests;
      a 2,000-case random check that the bound never falls below what
      postOp can take). LIVE: the dev EOA swapped 0.001 test ETH for
      46.98 USDC on Uniswap v3 Sepolia (SwapRouter02 0x3bFA…e48E from
      docs.uniswap.org, simulated first; tx 0xccbf0705…2193a2, block
      11845779) to the dev index-2 account; USDC-fee op userOp
      0xe064aef0…a0d514, bundle tx 0xfbf3e5cddba6a066c2ed066891e875c6f13770ed6b30197a1a7db981de2ef481,
      block 11845782: Approval = 3,817,963 (exactly the displayed
      maximum), charged 760,363 base units (0.760363 USDC) to the
      treasury, Pimlico named in UserOperationEvent, the account's ETH and
      deposit unchanged, allowance afterwards 3,057,600 (= approval −
      charge; it STAYS APPROVED until a later op through this paymaster
      replaces it — stated on screen). App: token-gas.ts dispatches by
      source (Circle where it exists, else ERC-7677 when the caller
      accepts it); the ERC-7677 quote runs the stub AND a bundler estimate
      before the gate (no key needed) and shows bound + 25%
      (ERC7677_TOKEN_GAS_HEADROOM_PERCENT, judgement); every sentence is
      true for this source (rate "set by Pimlico's service and signed into
      the operation", markup "Included in the rate", "a permissioned
      service… can decline", the unstaked note). NOT YET WIRED: SendScreen
      needs eight mechanical edits (scratchpad sendscreen-patch.md) before
      the Sepolia choice appears; check-token-gas 205.
      ITEM 3b — ARBITRUM SEPOLIA PROFILE (eip155:421614): RPC order
      arbitrum-sepolia-rpc.publicnode.com, sepolia-rollup.arbitrum.io/rpc,
      arb-sepolia-testnet.api.pocket.network (all serve eth_simulateV1);
      0.25 s blocks; verifyKernelDeployment passed; ZeroDev bundler
      answers; P-256 precompile present; Circle's paymaster there reads
      token() = USDC 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d, spread 0,
      fixed test oracle, staked; FEE MODEL: not OP-stack (no code at
      0x4200…000F) — Arbitrum docs "a single fee—the L2 cost with the L1
      fee 'baked-in'", eth_estimateGas covers it (measured 21,770 of which
      601 is the L1 part), so gas × max fee and Max are correct and the
      OP-stack path never runs (profile flag l1CostInGas); Circle's USDC
      fee is offered there; nothing hard-codes two test networks any more.
      INPUT NEEDED for a live run: Arbitrum Sepolia test ETH (and USDC) at
      the dev EOA 0x16DA…C5C. Still to add in other files: the USDC known
      token, risk block time (0.25 s), NFT explorer, recovery file label,
      one WalletConnect string.
      ITEM 1 — PAYMENT REQUESTS (check-payment-request 210): EIP-681
      (ethereum/ERCs 365b4c02; value in wei with the integer-exponent
      rule; no chain id = the current network, stated on screen), BIP-321
      (which supersedes BIP-21; req- parameters refuse the whole URI;
      duplicate keys refused) applied to Dogecoin too per Dogecoin Core
      v1.14.9 guiutil.cpp, Solana Pay (single amount, no scientific
      notation; requests with spl-token, reference or memo and transaction
      requests are REFUSED because the standard requires including them
      and the wallet cannot yet). Receive: "Request an amount" card with
      the URI, QR and a plain description; the plain-address QR stays the
      default. Send: a scanned or pasted request pre-fills editable fields
      and NEVER switches network (a different chain id is refused naming
      both networks) or tracks a token (untracked contracts refused);
      unknown parameters refused for EIP-681 and Solana Pay, ignored for
      BIP-321 as it allows; EIP-681 gas suggestions are ignored with a
      note; scan.ts unchanged. Findings: EIP-681's own example address
      fails EIP-55; BIP-321's examples are intentionally invalid.
      ITEM 2 — ENS NAMES (engine ens.ts, 17 tests; check-names 45 / 51
      live): the Universal Resolver 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe
      (ENS docs: "the canonical entrypoint"; same code on mainnet and
      Sepolia, none on Base Sepolia), resolve(bytes name, bytes data) with
      addr(bytes32); normalisation is a conservative ASCII subset (a–z,
      0–9, hyphen, dots; ENSIP-15's "--" rule) proven equal to ethers'
      ensNormalize on every accepted input (3,000 generated cases) — no
      new dependency; CCIP-Read (ERC-3668) is NOT followed, so offchain
      names incl. every *.base.eth are refused; mainnet uses mainnet ENS,
      Sepolia uses Sepolia's ("test-network names, separate from mainnet
      names"), Base Sepolia refuses before any request. The full address
      is shown before Review, re-resolved at Review (a change stops and
      shows the new address), and only the address is validated, matched,
      risk-checked, quoted and stored. Live probes: nick.eth and
      vitalik.eth on mainnet, nick.eth on Sepolia, jesse.base.eth refused
      as offchain. INCIDENT (repaired): the agent overwrote the existing
      app/src/wallet/names.ts and restored it from HEAD at once (the CTO
      confirmed it is unchanged); the ENS glue lives in ens-names.ts.
      ITEM 6 — WATCH-ONLY ACCOUNTS (check-watch-only 160): ids 0xC0000000 +
      slot, refused by every derivation, vault and salt helper;
      assertAccountCanSign also refuses any malformed id before the phrase
      is read; accountList means "accounts this wallet holds a key for",
      so a watched address is never "one of your own accounts"; signWith
      refuses first with zero secure-store reads ("This is a watch-only
      account: the wallet holds no key for it, so it cannot sign or send.
      Nothing was signed."); WatchOnlyGate is an ALLOW list (Home,
      Activity, Nfts, NftDetail, Tokens, Approvals, Settings, Contacts,
      ImportKey) wired by the CTO as the navigator's screenLayout, so any
      other or future route renders a refusal instead of mounting; the CTO
      also added the WalletConnect guard (the watched address is never
      offered; a proposal is refused before any device check), the
      read-only Approvals form (no Revoke) and the two recovery.ts guards
      (evmAccountPath only for phrase ids; draftRecoveryProgress refuses a
      watch-only owner). Receive is refused for a watch-only account for
      now.
      ITEM 4 — INHERITANCE IS A DEMONSTRATION ONLY (check-inheritance 62;
      kernel-recovery tests 60). From Kernel v3.3 sources (cd697c7e) and
      eight eth_simulateV1 scenarios: (a) the delay is per ACCOUNT and is
      copied into a proposal's validAfter when its approvals reach the
      threshold; the validator emits NO approval events and proposals are
      keyed by (account, callData, full nonce) with the heir choosing the
      new owner and the nonce lane, so the owner CANNOT enumerate unknown
      takeovers — detection is only a shared request or a scan of full
      blocks for top-level approve / approveWithSig calldata
      (scanGuardianApprovals; internal calls are invisible); NO PROOF OF
      LIFE EXISTS: renew keeps approvals, remove + re-install of the same
      heir REVIVES an old approval, a veto while the heirs are removed
      does stick, bumping one lane's nonce voids only that lane, and
      Kernel invalidateNonce would break the wallet's own ERC-1271
      envelope; (b) THE HEIR CAN SIGN AS THE ACCOUNT FROM DAY ONE AND
      THAT MOVES TOKENS — in simulation the heir signed a USDC permit
      through ERC-1271 and pulled 1,000 USDC; live, the heir's ERC-1271
      probe returned 0x1626ba7e and a heir-signed USDC permit passed
      eth_call (never sent); Permit2 verifies contract signers the same
      way (source only); (c) one set per account — guardians OR heirs.
      NEW CONTRACT FINDING: validAfter = uint48(block.timestamp + delay)
      truncates silently, so a delay ≥ 2^48 − now makes a takeover valid
      IMMEDIATELY (proven in simulation with delay 2^48 − 1); the engine's
      validateGuardianSet still accepts such delays (the app only offers
      presets; inheritance caps at 365 days) — refusing them in the engine
      is in the next slice; a sixth item for the disclosure decision.
      Built: "Inheritance (demonstration)", test networks only, the risk
      statement first ("Read this first: your heir can sign messages AS
      THIS ACCOUNT from the moment you add them — not after the delay.
      Those signatures can move your tokens…"), an acknowledgement before
      Review, role "heirs" in the recovery record (additive), a
      takeover-attempt check on focus, veto, and Remove that also vetoes
      every known pending takeover; NO "I am still here" button. LIVE ON
      SEPOLIA (dev index-2 account, heir = dev index 5, 600 s delay):
      install (tx 0x573fd4e4…0ac5, block 11845766), approval found by the
      scan, veto, a second approval, the early takeover refused with AA22,
      the takeover after the delay (tx 0x051a4925…9e04, block 11845819),
      rotation back and removal (tx 0x4925475f…cc7c); end state owner
      0x16DA…C5C, no modules, no pending approvals. The CTO added the Home
      (test networks only) and Settings links.
      ITEM 5 — docs/SCHEDULED_PAYMENTS.md: "pay X every month to Y" is the
      existing subscription grant with the key held by the user's own
      phone (fixed seconds, not calendar months; missed slots catch up);
      DCA must not be built on aggregator or Universal Router calldata
      (cannot be pinned by a CallPolicy; SwapRouter02 exactInputSingle can
      be pinned but only with a STATIC minimum-out floor and no deadline);
      recommended next slice: a user-pushed recurring payment for ETH and
      USDC with no engine change.
      Funds: dev EOA about 0.031 Sepolia ETH; the dev index-2 account
      holds 46.22 USDC (3.0576 approved to Pimlico's paymaster).
- [x] INTEGRATION SLICE (commit 9c3c7d6; offline runner ALL GREEN in the
      CTO's isolated worktree: engine 815, app 5,426 across 43 suites,
      lint 0/0, tsc clean; nothing on a device). (1) SendScreen wiring for
      the ERC-7677 (Pimlico) USDC fee on Ethereum Sepolia: the offer,
      check, Max and quote calls pass acceptsErc7677; the paymaster-check
      key includes the saved bundler; every confirm row and note comes
      from tokenGasConfirmLines, the success line from tokenGasChargedLine;
      the ERC-7677 confirm shows "Bundler gas estimate passed with
      Pimlico's paymaster terms." (that quote IS estimated before the
      device check); for Circle all 18 rendered strings are pinned
      byte-identical to the old screen; seven source mutants each caught;
      copy that said the choice exists only on Base Sepolia now names
      Ethereum Sepolia, Base Sepolia and Arbitrum Sepolia; check-token-gas
      228. (2) Arbitrum Sepolia entries: USDC 0x75fa…AA4d as a known test
      token (Circle's USDC page, fetched 2026-10-04; live symbol "USDC",
      name "USD Coin", decimals 6; Circle lists no Arbitrum Sepolia EURC);
      block time MEASURED 0.2501 s over 1,000,000 blocks (Arbitrum
      documents no fixed block time) → new-contract threshold 2,419,200
      blocks; explorer https://sepolia.arbiscan.io/nft/ (Etherscan-family
      convention, flagged); recovery-file label; the WalletConnect
      wrong-network sentence built from the profile table. No gas pad was
      added for Arbitrum (no documentary basis). Noted: the inheritance
      takeover check reads 60 blocks per tap, about 15 s on Arbitrum. (3)
      ENGINE: validateGuardianSet refuses a delay above
      MAX_GUARDIAN_DELAY_SECONDS = 2^32 − 1 (about 136 years; at this
      bound uint48(block.timestamp + delay) cannot wrap for about 8.9
      million years); the guardian and inheritance paths surface the
      sentence with zero network calls; the smoke script's wrap scenario
      still demonstrates the contract behaviour. (4) Watch-only Receive:
      "Watched address" with the notice, "This is the address being
      watched. Anyone can send to it, but this wallet holds no key for it,
      so it cannot move anything that arrives there.", the QR and Copy
      only; 'Receive' joins the allow list; the Home address is pressable
      again. (5) Approval target {kind:'none'} for a watch-only account:
      a device check while one is active uses the ordinary system prompt
      and NEVER opens the recovery phrase (zero secure-store reads,
      pinned; a mutant without the early return is caught). (6) Readiness
      row "Inheritance (demonstration)" (testnet-only, enforced); T-68 and
      F-60 in THREAT_MODEL.md.
- [x] EMULATOR PASS OVER WAVE 1 at 4620435 (2026-10-05; Metro worktree
      at 4620435 with the engine built inside it, 2,311 modules; no repo
      files edited; every hash verified on a public RPC; no dev-EOA
      top-ups). Launch: Account 1 · 0x772e…F44F, no prompt. (A) PAYMENT
      REQUESTS: every QR decoded from the screenshot and matched its URI —
      ethereum:0x772e…F44F@11155111?value=0.001e18; the USDC form
      ethereum:0x1c7D…7238@11155111/transfer?address=…&uint256=1.5e6;
      bitcoin:…?amount=0.0001&label=Shiba%20test&message=Invoice%207;
      dogecoin:…?amount=12.5&label=…; solana:…?amount=0.25&label=…;
      pasting a USDC request for Account 2 switched Send to "Send USDC"
      with the fields filled and the "Filled in from a payment request
      (EIP-681)…" box (Review only); an @1 request in Sepolia mode was
      refused naming both networks; an untracked token contract was
      refused. (B) ENS: nick.eth on Sepolia → 0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5
      (equal to ethers' resolveName), with the registry and privacy lines
      and the name line on the confirm; unsupported characters refused;
      mainnet vitalik.eth → 0xd8dA…6045; jesse.base.eth refused as
      offchain; Base Sepolia refuses names; a plain address triggers no
      lookup. (C) WATCH-ONLY: own-account and duplicate refusals; "Watched
      1 (watch-only)" added with 0 prompts; Home notice and live balances
      (61.06 test ETH, 1,344.23 USDC, 10.6 EURC for 0xd8dA…6045, matching
      the chain), no signing links, BTC/DOGE/SOL not-available text; the
      "Watched address" screen; gate refusals on Sessions, Guardians,
      WalletConnect, Prove ownership, Spending limits and Passkey with 0
      prompts; after the 1-minute auto-lock, Unlock raised the ORDINARY
      prompt "Unlock Shiba Wallet" with "Use PIN" (not the protected-phrase
      prompt); a send to the watched address is never called one of your
      own accounts; removal with one dialog. (D) SECOND USDC-FEE SOURCE,
      PROVEN LIVE IN-APP ON ETHEREUM SEPOLIA: the Pimlico checking
      sentence and hint; the first Review refused for funds (the bound was
      4.6 USDC against 1.3 held), so 4 USDC were sent in-app from Account
      1's EOA (tx 0x74aea3c4…a9b596, block 11846560); confirm "up to
      4.466678 USDC" with every row as designed (rate "1 test ETH =
      2977.08222 USDC, set by Pimlico's service and signed into the
      operation…", "Included in the rate; not shown as a separate figure",
      the grant box, the permissioned and unstaked notes, the preview
      "Approval: 0x7777…834C may spend up to 4.466678 USDC", "Bundler gas
      estimate passed with Pimlico's paymaster terms."); ONE prompt;
      success "Network fee charged: 0.856453 USDC. The approval allowed up
      to 4.466678 USDC; what was not charged stays approved…"; tx
      0x2bad539409517ca52e0ee60df1d19c973309478541d11c4200cb419c2fa616bb,
      block 11846591, userOp 0x7dc68e31…9f2f68: paymaster 0x7777…834C,
      Approval = 4,466,678 (the displayed maximum), 856,453 to the
      treasury (the success line), Kernel ETH down by exactly 0.0001,
      deposit unchanged, allowance afterwards 3,610,225. (E) HEADROOM: an
      ETH-fee smart-account send tapped after ~3 minutes on the confirm
      went through with one prompt and no "fee rose" (tx 0xcb943f7f…206218,
      block 11846626). (F) INHERITANCE: the risk statement first, Review
      disabled until the acknowledgement, the review screen for a dev
      heir (nothing installed), the mainnet refusal, the readiness row.
      (G) ARBITRUM SEPOLIA: banner, the layer-2 note, USDC "USD Coin" row,
      the Kernel factory pre-fill verified and saved (no bundler), a send
      refused for funds before any confirm. FINDINGS (fix slice running):
      (1) a bitcoin: URI in the ETH recipient goes down the ENS name path
      (the unsupported-name sentence twice + the privacy line); (2) on the
      Pimlico confirm the risk card describes the wallet-built approve on
      the USDC contract instead of the user's call; (3) one transient "RPC
      HTTP error 400 for eth_getBlockByNumber" on a Review, shown raw; (4)
      the Inheritance form says "Guardian 1: Enter a recipient address."
      and enables Review with zero heirs once acknowledged; (5) the
      watch-only gate does not name Inheritance; (6) while "Shiba Wallet
      is locked" is shown, the screens underneath stay in the
      accessibility tree (a screen reader could read balances); (7) copy:
      the ENS placeholder on Base/Arbitrum, the Home row titled
      "Ethereum" on other profiles, the Settings WalletConnect blurb, the
      Backup sentence below the watch-only list; (8) dev only — a
      WalletConnect core log "No internet connection detected…" at launch
      although the network works (probably the earlier empty "Console
      Error"). Emulator note: `adb input swipe` drops gestures and once
      registered as a tap; `input motionevent DOWN/MOVE/UP` scrolling is
      reliable (helper mscroll in the scratchpad p14a/env.sh). Funds
      after: Account 1 EOA 0.00482 ETH, 30.6 USDC; Kernel 0.002654 ETH,
      4.44 USDC, 3.61 USDC approved to Pimlico's paymaster; Account 2
      0.001 ETH. End state: Ethereum Sepolia, Account 1, light mode,
      Google IME, no watch-only account.
- [x] Item 7 — leadership refresh (commit below). FEATURE_UNIVERSE
      section 15: rows 10, 67, 68 and 74 → Proven live (in-app, with their
      limits stated), row 48 → Built as a demonstration (the feature as
      described is not achievable with the deployed modules), rows 16, 25
      and 29 extended (the second paymaster in-app; the scheduled-payments
      design; the Arbitrum profile); tally Proven live 39 (T1 28, T2 11),
      Built 17 (9/8), Designed 2, Not started 41 (2/24/15). The shareable
      page is VERSION 11 (counts 39/17/2/41 asserted). DEMO.md gained
      steps 14 (request a payment, pay to a name), 15 (watch an address),
      16 (the fee in USDC through the second paymaster) and 17 (the
      inheritance demonstration, screens only).

## Phase 14 status (2026-10-05)

Items 0 to 7 are landed and pushed; one small fix slice for the
emulator findings is in flight. Proven live this phase: the second
token-fee source (by script, then through the app's Send screen on
Ethereum Sepolia), payment requests and their refusals, ENS names on
mainnet and Sepolia, watch-only accounts, the 100% fee headroom, and
the inheritance flow by script. Delivered without a live run: the
Arbitrum Sepolia profile (no test ETH there), the in-app inheritance
demonstration beyond its review screen (deliberately not installed on
the emulator's account), and the scheduled-payments design. Engine: 815
tests. App: 43 offline suites, 5,426 checks at 9c3c7d6.

Findings for the Chairperson this phase: the deployed guardian module
cannot support an honest inheritance switch (an heir can sign as the
account, including token permits, from the day it is added; no reliable
takeover detection; no on-chain check-in) and its delay arithmetic wraps
for very large delays — two more items for the ZeroDev disclosure
decision, now six; Pimlico's paymaster is a permissioned service that
leaves the unused part of each approval in place; every *.base.eth name
is refused because offchain resolution is not followed.

Inputs that would unlock more: Arbitrum Sepolia test ETH and USDC at the
dev EOA; the disclosure decision; the ZeroDev gas policy; a phone and
Expo account; a 0x key; enabling Base Sepolia for the Alchemy key.

Recommended next (not started): the user-pushed recurring payment from
docs/SCHEDULED_PAYMENTS.md; multi-signature accounts (24) or an in-app
dApp browser (79) as the next large items; a live check that other
wallets accept the payment links.
- [x] Phase 14 emulator findings FIXED (commit 83feb84; offline runner
      ALL GREEN in the CTO's isolated worktree: engine 815, app 5,503
      across 43 suites, lint 0/0, tsc clean; not seen on a device). (1)
      looksLikeName refuses any text with a colon; foreignPaymentFamily
      recognises another family's payment scheme on paste and scan and
      shows one sentence ("This is a payment request for Bitcoin, a
      different network family, so nothing was filled in; open Send for
      Bitcoin from the Home screen to pay it."); a name refusal decided
      locally shows at once with no request and no privacy line, and is
      never rendered twice. (2) aa.ts aaUserCalls drops calls[0] ONLY for
      an 'erc7677' token-gas quote whose first call is byte-identical to
      erc7677TokenApproveCall(token, paymaster, maxTokenCharge) with at
      least one call after it; the risk card then equals the ETH-fee
      path's card; an approve differing by one base unit, a user approve
      and non-ERC-7677 quotes are never skipped. (3) The transient "RPC
      HTTP error 400 for eth_getBlockByNumber" comes from
      NodeClient.suggestFees; new fee-read.ts suggestFeesRetryingOnce
      retries ONCE on the same endpoint, only for HTTP 400 on
      eth_getBlockByNumber / eth_maxPriorityFeePerGas (read-only,
      wallet-fixed parameters, cannot revert), used at all 13 call sites
      (a check forbids direct .suggestFees() calls); the global rule that
      HTTP 400 is not an endpoint failure is unchanged; a remaining error
      reads "The network endpoint answered a request for network data
      with an error (HTTP 400) instead of the data. This is usually brief;
      try again in a moment." with a technical line (broadcast methods
      keep their own wording). (4) "Heir N: Enter the heir's address."
      and Review needs at least one heir address (canReviewHeirs). (5) The
      watch-only gate names "Inheritance (demonstration)"; a check asserts
      every refused main-stack route names its feature. (6) LockGate wraps
      the screens in an always-rendered View with
      importantForAccessibility 'no-hide-descendants' and
      accessibilityElementsHidden while locked (React Native accessibility
      docs, fetched 2026-10-05, and the installed 0.86.3 typings); screens
      are not unmounted; three mutants caught. (7) Copy: the recipient
      placeholder offers ENS only where ensRegistryFor allows; the Home
      EVM row shows the active profile's label; the Settings WalletConnect
      blurb lists the test networks from the profile table; the Backup
      text is true with watch-only addresses present. Unverified: the
      provider behind the transient 400; TalkBack / VoiceOver on a device.
      Phase 14's code is complete at this commit.

## Housekeeping (2026-10-09, commit f8e1224)

Done before phase 15 at the Chairperson's request, as one commit verified
by the offline runner in an isolated worktree (engine 815, app 5,503
across 43 suites) plus the bundle export: phases 1–12 moved verbatim to
docs/HISTORY.md and this file rewritten to the rules, decisions, standing
rules, a phase index and the current phases; stale references fixed
(chains-bitcoin → chains-utxo, the never-created docs/DECISIONS.md, the
threat model's suite counts); Expo patch updates (expo 57.0.27,
expo-camera 57.0.6, expo-screen-capture 57.0.4; `expo install --check`
clean); dangling worktrees pruned. Left as they were by decision: two
legacy fee-floor helpers and a session routeNode pass-through (small
refactor, low value), five reasoned eslint-disable comments, the
git-ignored keeper files in .dev-wallet.

ARBITRUM SEPOLIA, READ-ONLY PASS (2026-10-09; the Chairperson funded the
dev EOA 0x16DA…C5C with 0.03 test ETH and 20 USDC): chain id 421614 on
all three profile RPCs; verifyKernelDeployment passed; Circle's paymaster
0x31BE…0b58 reads EntryPoint v0.7, USDC 0x75fa…AA4d, price 3000 (fixed),
spread 0, deposit ~1.0528 ETH, staked 0.25 ETH, no problems; its
implementation there is 0xD9d18FD662B5B2F567545C13fd1e902008beD755
(Sourcify exact match; 180 bytes of immutables differ from Base's, same
logic); ZeroDev serves chain 421614 (v0.7 supported;
pimlico_getUserOperationGasPrice standard 73,704,960 / 368,524 wei;
rundler_maxPriorityFeePerGas not served); the node's
eth_maxPriorityFeePerGas is 0 (quotes carry a 0 tip, which Arbitrum
ignores); the L1 component was ZERO at the time (ArbGasInfo
getL1BaseFeeEstimate 0; eth_estimateGas for a transfer exactly 21,000;
NodeInterface.gasEstimateL1Component 0 for a handleOps too — the 601 L1
gas measured in phase 14 was at a non-zero L1 price); ZeroDev's
estimate accepted the Kernel deployment op with the same gas figures as
Base (pVG 51,428 / vGL 358,217 / cGL 17,955). The token-gas dry run
passed for both owners (worst case ~0.719 USDC simulated). NOTHING LIVE
RAN: kernel-smoke.mjs refuses "CHAIN_ID must be one of 84532, 11155111",
token-gas-smoke.mjs refuses 421614 for live and its live() refuses an
undeployed account, fund.mjs allows only 11155111 and 84532; the agent
was told not to edit scripts, so the live run is phase 15 item 0.

## Phase 15 plan (approved 2026-10-09 "immediately after" the housekeeping): recurring payments, Arbitrum live, the next account types

The Chairperson approved starting phase 15 without naming a scope; this
is the CTO's proposal, recorded before code, following the phase 14
status's "recommended next".

0. Arbitrum Sepolia live: extend kernel-smoke.mjs (CHAINS map; estimate
   the funding transfer's gas instead of 21,000), token-gas-smoke.mjs
   (drop the 421614 live refusal; allow the deploy-in-the-same-op path)
   and fund.mjs (allow 421614) — then the Kernel deployment through
   ZeroDev, a USDC-fee operation through Circle's paymaster, and an EOA
   send, all verified independently; then the in-app Arbitrum pass on
   the emulator (Metro worktree recreated at HEAD; the emulator's
   Account 1 funded from the dev EOA).
1. Recurring payments pushed by the user's own phone (the slice
   docs/SCHEDULED_PAYMENTS.md recommends): a "pay X every N days to Y"
   subscription whose session key stays on the device and whose pulls
   the app submits itself while open (and offers to run when due), for
   ETH and USDC, with the same batching caveat and fee budget rules; no
   engine change expected.
2. Multi-signature accounts (feature 24): research from the Kernel v3.3
   sources whether the deployed WeightedECDSAValidator can serve as a
   ROOT validator for a k-of-n account (threshold semantics incl. the
   repeated-signer finding, ERC-1271 behaviour, recovery interplay) and
   what an honest multi-signer smart account would need; build the
   engine spec and a test-network demonstration only if the analysis
   supports it; otherwise deliver the analysis and the candidate
   modules.
3. In-app dApp browser (feature 79): a design document first (WebView
   provider injection, the EIP-1193 surface, origin binding versus the
   WalletConnect identity model, what the threat model requires), then
   the smallest safe slice if the design supports one.
4. Leadership refresh at the end: feature rows, the shareable page,
   DEMO.md (an Arbitrum step), the threat model.

Waves: 0 (agent: scripts + live, then the emulator), 1 (agent, app) and
2's research (agent, engine) in parallel; 3's design alongside; 4 last.
Subagents on Opus.

## Phase 15 progress
- [x] Item 0, script half — ARBITRUM SEPOLIA PROVEN LIVE BY SCRIPT
      (commit d01a397; scripts/testnet only; every hash re-read on a
      second RPC; dev EOA spent 0.0081 test ETH and exactly 3 USDC; the
      offline runner stayed ALL GREEN in the isolated worktree). (a)
      Kernel deployment through ZeroDev: funding tx 0x6238aeb1…05281
      (21,000 gas used, 0 for L1); op 1 (deployment + batch) userOp
      0xef0a7c39…50ab28, bundle tx 0xde60e28ab50330db81d4f32951aa161017ed0c245efc1ad5befcf409d2246d8e,
      block 317488796, AccountDeployed via the meta factory, OwnerRegistered,
      success, actualGasUsed 334,973; op 2 on the deployed path userOp
      0xb52aa53d…9de2257, tx 0x62f1950b…eaa853, block 317488824. Versus
      Base: the same verification/call gas limits, preVerificationGas
      56,041 vs 61,454 (Base's includes its L1 cost), bundle gasUsed
      326,911 vs 326,887, effective price 208 vs 155 Mwei (Arbitrum's base
      fee ~0.058 gwei; the 0.15 gwei tip was really paid — Arbitrum
      collects tips); op 1 cost 0.0000697 vs 0.0000528 ETH. THE L1
      COMPONENT WAS ZERO for the whole run (ArbGasInfo.getL1BaseFeeEstimate
      0, NodeInterface.gasEstimateL1Component 0, receipts' gasUsedForL1
      0). (b) USDC fee through Circle's paymaster: funding 1 USDC (tx
      0x8458a2f3…f59e335); refusals at estimation AA33 "exceeds
      allowance" / "exceeds balance"; the op userOp 0xb696e392…3b35f1,
      bundle tx 0x75ec840e1c122a0afc0ed6be31471145fd267ee503a2c44f50accbffc1046771,
      block 317489146, paymaster 0x31be…0b58, success, actualTokenNeeded
      50,728 (0.050728 USDC — about 9.4× Base's 0.005392 at ~10× the
      effective price; gas used similar), Approval = prefund 149,428 = the
      displayed worst case, refund 98,700, ETH and EntryPoint deposit
      unchanged, allowance 0 before and after, the paymaster's deposit
      down by exactly actualGasCost. (c) EOA send with fund.mjs: tx
      0xc3c2a2d8…08cc85, estimate 27,484 (limit 32,980), used 27,139, fee
      41% of the worst case, tip 0 — the "L1 cost inside the gas
      estimate" model held at a zero L1 price (non-zero L1 still
      unverified). (d) Emulator wallet funded for the in-app pass: Account
      1 EOA 0.004 ETH (tx 0xcebb25c2…36bf3) + 2 USDC (tx 0x4859eab6…a10d85),
      its Kernel account 0.002 ETH (tx 0xd0fe1188…ea6c90; undeployed on
      Arbitrum). SCRIPTS: kernel-smoke.mjs (421614 in CHAINS, explorer
      links for all three chains, the funding transfer's gas estimated +
      20% instead of 21,000, signed gas fields logged, URL masked in
      errors), token-gas-smoke.mjs (live refusal removed; live() deploys
      an undeployed account in the same op — proven by the dry run, not
      live, since (a) had deployed it; chain-named text), fund.mjs
      (421614 allowed; estimate/limit/fees/worst case and the receipt's
      gas figures printed); dry runs on all three chains pass. NEW
      FINDING — ZEROD​EV'S ARBITRUM ESTIMATES ARE OFTEN IMPOSSIBLE: on
      421614 eth_estimateUserOperationGas answered verificationGasLimit
      0x0 and paymasterVerificationGasLimit 0x0 with a constant
      callGasLimit 0xcb36 in about 27 of 35 samples (bursts of tens of
      seconds; the Pimlico and Ultra Relay routes 4/4 zero, the Alchemy
      route 4/4 real, Gelato TLS failure); the first live attempt signed
      such an estimate and the script's EntryPoint preflight stopped it
      ("RPC error 3: execution reverted (eth_call)", revert data 0x)
      before anything reached the bundler; both smoke scripts now refuse
      an impossible estimate and ask again (every 5 s, up to 24 times).
      RISK FOR THE APP: SmartAccountClient has no such guard and the
      Circle transport keeps the estimate's paymasterVerificationGasLimit,
      so an in-app smart-account send on Arbitrum could sign a zero-gas
      op and fail after the biometric prompt — a guard slice is
      dispatched before the emulator pass. Unverified: a non-zero L1
      component; the live deploy-in-the-same-op USDC-fee path; how the
      bundler treats a zero-gas op; which upstream each ZeroDev answer
      came from.
- [x] Item 3 — docs/DAPP_BROWSER.md, the in-app dApp browser design
      (commit below; about 4,900 words; sources read 2026-10-09 and
      cited). CONCLUSIONS: feasible with ONE approval path — Expo SDK 57
      pins react-native-webview 13.16.1 and Expo Go bundles it; a browser
      bridge client can present each site as a synthetic session keyed
      browser:<origin> through the existing wc-controller queue, so the
      proposal/request sheet, gates, preview, risk card and D6 serve it
      unchanged; three changes to existing code (a composite client so
      the controller exists without WalletKit, a browser identity source
      because describeVerifyContext would otherwise say "Verified by
      WalletConnect" plus the matching siweOriginFor branch, and a
      WalletConnect → EIP-1193 error-code translation); first-hand origin
      replaces the self-reported dApp name and makes the SIWE domain check
      exact but proves nothing about a site's honesty. THE LIBRARY'S
      DEFAULTS ARE UNSAFE FOR A WALLET (read from the 13.16.1 source, B1
      confirmed by running its code): B1 originWhitelist is a prefix match
      (https://app.uniswap.org also admits
      https://app.uniswap.org.attacker.example and …@evil.example); B2 the
      Android bridge is exposed to every frame of every origin and the
      main-frame flag is dropped; B3 Android's fallback bridge reports the
      top page's URL for every frame; B4 Android page-start injection is
      documented as "not 100% reliable"; B5 Android grants a page's camera
      request with no prompt when the app already holds the permission
      (which this wallet does for QR scanning); B6 allowlist-rejected
      navigations are handed to the OS; B7 Android downloads carry the
      site's cookies; B8 setSupportMultipleWindows must stay true
      (CVE-2020-6506). B3, B5, B7 and the stronger fixes for B2/B4 are
      native changes a development build must carry. RECOMMENDATION: keep
      WalletConnect primary; at most an allowlisted-sites slice on test
      networks behind an enforced readiness row dapp-browser; mainnet
      waits on a development build with the native fixes and a device
      test. Store policy (primary text quoted): Apple 2.5.6 met (WebKit);
      whether 4.7 "mini apps" applies is unclear and B5 runs against
      4.7.3; 3.1.1 argues against NFT marketplaces on the allowlist;
      Google Play's Device and Network Abuse policy bans a WebView
      JavaScript interface that loads untrusted http content or URLs from
      intents; neither store has dApp-browser-specific text. Could not
      verify: WEB_MESSAGE_LISTENER support on the emulator/phones, iframe
      access to the iOS handler, B5 in practice, clipboard reads, user
      agents, Safe Browsing's data flow, Apple's application of 4.7.
      DECISION FOR THE CHAIRPERSON: whether to build the allowlisted slice
      at all for this prototype.
- [x] Item 1 — RECURRING PAYMENTS SENT BY THE PHONE ITSELF (commit
      eb952a2; new check-recurring 114; check-subscriptions 154 and
      check-sessions 137 unchanged; offline runner ALL GREEN in the CTO's
      isolated worktree: engine 815, app 5,617 across 44 suites, lint
      0/0, tsc clean; 25 mutations each caught; NOT run on a device or a
      live network). DESIGN: recurringGrantFor delegates to
      subscriptionGrantFor, so the template cannot drift (same CallPolicy,
      TimestampPolicy, GasPolicy, RateLimitPolicy {period, payments,
      startAt = the Start tap}, SKIP_SIGNATURE); the subscription form
      gained subMode 'subscription' | 'recurring' and keeps the Start
      re-quote, the fee-budget keep-back, the funding block and the 20%
      re-quote ceiling. SessionSource gains 'recurring';
      sessionCarriesTerms() for both. THE KEY NEVER LEAVES THE DEVICE:
      buildSubscriptionKeyExport / markSubscriptionKeyExported refuse with
      RECURRING_KEY_NEVER_EXPORTED without reading the vault;
      releaseSessionKey refuses; subscriptionHandoverOffer is 'none';
      sessionCanBeTested is false (a test op would use a payment slot); a
      recurring install without the key on the device, or a stored record
      with a hand-over time, is refused / dropped on load. NOTHING RUNS IN
      THE BACKGROUND: app/src/components/RecurringDueBanner.tsx (mounted in
      App.tsx inside the NavigationContainer) checks on start and on every
      AppState 'active' through findDueRecurringPayments (public list +
      read-only eth_calls on RateLimitPolicy / GasPolicy; no request with
      no recurring record; nothing on mainnet — isFeatureAllowed
      'session-keys'); it has no vault and no bundler and offers "Review"
      (opens Sessions) or "Not now"; the Sessions screen re-reads on
      focus and offers "Send the payment now" per due card. CONFIRM
      BEFORE SUBMIT: runRecurringPayment({plan, confirm, pay}) —
      planRecurringPayment re-reads the chain, refuses anything not due,
      builds one full-amount transfer checked by assertSubscriptionPull
      with no key read and no bundler call; the dialog "Send this payment
      now?" (Cancel / Send payment; back and outside resolve false); pay
      runs only on exactly true, through sendSessionCalls — the recovery
      phrase and the owner key are never read (no requireLocalAuth, no
      signWith on this path; a test against the real createKeyVault with a
      fake secure store proves zero phrase reads). Catch-up: openSlotCount
      follows RateLimitPolicy (slot k opens at nextSlotAt + k × interval,
      capped by validUntil and the remaining count); each payment needs
      its own confirmation. SPENDING LIMITS: evaluateBeforeSigning on the
      transfer (no simulation, fee 0; the fee is capped on-chain by the
      budget) before each payment; over a limit → refused with no "send
      anyway" (that would need a device check, which would open the
      phrase); unreadable limits fail closed; recordAcceptedSpend only
      after the bundler accepts. REFUSALS mapped to sentences: AA22,
      CallViolatesValueRule 0x7b5812d4, CallViolatesParamRule 0x59d52e40,
      PolicyFailed(i) 0x3e4983f6, "AA23 reverted 0x" (revoked); the card
      keeps "Last payment attempt refused: …". Completed plans show
      "Revoke and forget" (forget only after finalizeSessionRevoke reads
      back revoked). NOT ADDED (said on the form): expo-background-task /
      expo-task-manager / notifications — a development build, OS-timed,
      and a product decision on sending without the user present. PROMPTS:
      Start = requireLocalAuth('Approve this recurring payment') (+ the
      Android "Protect the new session key" write when the phrase is
      protected: 2 on this AVD); a payment = the in-app dialog + ONE
      "Use the session key" prompt when the key is protected, else none;
      revoke 1; due check and banner 0. Copy (exact): form intro "Pays one
      recipient up to a fixed amount once per period from your smart
      account, until the payments run out or you revoke. A new payment key
      is created on this phone and never leaves it; your account enforces
      the limits on-chain."; the while-open box "Payments are sent only
      while this wallet is open… Nothing is sent in the background or
      while the wallet is closed. A payment missed while the wallet was
      closed is not lost…"; the review opens with the batching box ("ONE
      PAYMENT OPERATION CAN HOLD SEVERAL TRANSFERS…"), then "Pays <payee>
      up to X every N until <date>: at most one payment per period, each
      sent by this wallet after you confirm it."; banner "1 recurring
      payment is due. Each is sent only after you confirm it on the
      Sessions screen." UNVERIFIED: Android Alert onDismiss/cancelable;
      the banner's layout below the native stack; AppState 'active' in
      Expo Go; whether expo-secure-store prompts when reading a MISSING
      protected key (the vault reads the protected name first — would
      affect every standard-key session the same way); the in-app
      sendSessionCalls path for a subscription-template grant has never
      gone through ZeroDev live (the keeper pulled the same grant live in
      phases 12–13). Emulator checklist (11 steps, Sepolia, Account 1,
      payee 0x69F0…7E8a) in the builder's report; a Home "Recurring
      payments" link is optional (Sessions already reaches it).
- [x] Item 2 — MULTI-SIGNATURE ACCOUNTS, ANALYSIS AND ENGINE GROUNDWORK
      (commit ad0d68d; docs/MULTISIG.md; packages/chains-evm/src/
      kernel-multisig.ts with 33 tests; scripts/testnet/multisig-smoke.mjs;
      offline runner ALL GREEN in the CTO's isolated worktree: engine 848,
      app 5,617 across 44 suites; about 0.004 Sepolia ETH spent). FIVE
      DETERMINATIONS from kernel tag v3.3 (cd697c7e) and runs against the
      deployed Sepolia contracts: (a) the deployed WeightedECDSAValidator
      0xeD89…eEEE CAN be a Kernel v3.3 ROOT validator and gives a correct
      k-of-n for OPERATIONS — validateUserOp (lines 203–245)
      de-duplicates signers by vote status, so the repeated-signer trick
      fails there (a 2-of-3 by two distinct signers accepted; one signer,
      and the same signer as approver and submitter, refused with AA24);
      (b) ERC-1271 MESSAGE SIGNING IS BROKEN AND NO WEIGHTS FIX IT:
      isValidSignatureWithSender (292–303) checks the threshold before the
      signer order, so a coalition C satisfies a message when weight(C) +
      max(C) ≥ threshold — MULTISIG.md §4 proves that for every threshold
      k ≥ 2 no weight assignment makes the message check as strong as the
      operation check (equal-weight k-of-n is (k−1)-of-n for messages; a
      signer with weight ≥ ⌈T/2⌉ signs alone); SIMULATED (eth_simulateV1
      against the real deployed validator in the smoke script's dry run,
      on a different account; the live 2-of-3 was operated for
      transactions only and no ERC-1271 call was made against it — this
      entry said "PROVEN LIVE" until the findings review of 2026-10-10):
      one signer with its signature duplicated → 0x1626ba7e, single →
      rejected; co-signers sign only Approve(keccak(sender,
      callData, nonce)) — never gas, fees, paymaster or validity, which
      the submitter alone sets; (c) a weighted-root account CANNOT also
      use the wallet's guardian recovery (same contract, same validation
      id 0x01‖validator — the phase 8 finding-4 collision made concrete);
      session keys and passkeys should coexist (reasoned, not run); (d) a
      timelocked multisig is possible but the veto itself needs the
      k-of-n, and the uint48 wrap applies (the engine's delay cap holds);
      (e) alternatives: Safe + Safe4337Module v0.3.0 (LGPL-3.0, EP v0.7,
      SafeOp covers every userOp field, rejects duplicate owners and bad
      thresholds, audited commit == release; not ERC-7579, no released
      7702) is the strongest correct multisig; Rhinestone OwnableValidator
      (ERC-7579, installable on Kernel, signers sign the full userOpHash,
      dedups; AGPL-3.0 header vs GPL-3.0 package.json, deployed bytecode
      post-audit); ZeroDev WeightedValidator v0.0.2 (MIT, fixes the 1271
      duplicate count by ordering first, but co-signers still sign only
      call + nonce, and its audited source "91f8fcb" exists in no ZeroDev
      repo); Coinbase Smart Wallet is 1-of-N on EP v0.6. BUILT: a
      transaction-only multisig on the verified module —
      validateMultisigConfig, multisigExposure (reuses
      guardianSignatureExposure), install data / initialize /
      predictKernelMultisigAddress / factory args,
      multisigChangeRootValidatorCall (with a backdoor warning), the
      off-device request/approval flow (build / parse / approve / verify,
      tamper-checked), createKernelMultisigSpec (re-verifies approvals
      against the final op; refuses sub-threshold weight, the submitter
      among the approvals, a wrong submitter; NO signErc1271 —
      MULTISIG_ERC1271_REFUSAL). Tests pin the install data to the ZeroDev
      SDK getEnableData vector and assert the impossibility result for
      every equal-weight k-of-n with 2 ≤ k ≤ n ≤ 10. LIVE ON SEPOLIA (dev
      indices 0/1/2, weights 1, threshold 2, salt index 77): account
      0xd927ac18Cd58D4E6DdfD8D97D0B3e78c64f28c57, rootValidator() =
      0x01‖eD89…eEEE on-chain; deploy + one op SELF-BUNDLED (ZeroDev
      declined the deployment for a prefund/fee reason, not ERC-7562): tx
      0xb28a55de36be77d7d43c3220c43580523715ebbcea46d4f0078c6ced0a01b6c4,
      block 11879418; a second op THROUGH ZeroDev's bundler: userOp
      0x4b881c4e…65cf1a, tx 0x716bb33a2b1c8fa76a1cf55228fad6a5fd22e8079e164324ffd5244b5a37e508,
      block 11879423, success — which settles that a bundler accepts a
      weighted-ROOT operation although the validator is UNSTAKED and
      writes account-keyed storage. About 0.0017 test ETH stays in the
      2-of-3 for demos. FINDINGS FOR THE CHAIRPERSON (disclosure list,
      now seven items): the ERC-1271 threshold-before-order check restated
      with a SIMULATED multisig counterexample and the impossibility proof (corrected 2026-10-10: not live); no
      ZeroDev weighted validator refuses threshold 0 at install (the
      engine does); the incremental audit's "WeightedValidator @ 91f8fcb"
      cannot be found in any ZeroDev repo. UNVERIFIED: session keys /
      passkeys on a weighted root; a bundler-accepted DEPLOYMENT of a
      weighted-root account (only post-deployment ops confirmed); the
      delayed path live; none of the alternatives integrated. APP DESIGN
      NOTE (MULTISIG.md §11, later slice): deploy fresh rather than
      convert (converting leaves the single-key validator as a backdoor
      unless uninstalled in the same batch); collect co-signer approvals
      off-device as request/approval JSON (QR/file, like guardian
      recovery); show the exposure; state that a multisig CANNOT sign
      messages, logins or permits; state that co-signers approve calls +
      nonce but not fees; test networks only until C1–C3; no guardian
      recovery on a weighted root.
- [x] ZERO-ESTIMATE GUARD (commit below; offline runner ALL GREEN in the
      CTO's isolated worktree: engine 866 — chains-evm +18 — app 5,643
      across 44 suites, check-aa 304, check-token-gas 247, lint 0/0, tsc
      clean; five hand-applied engine mutants (rule removed, unchecked
      estimate, each transport check, the final-op check) failed 1–11
      checks each; five permanent in-suite mutants caught; nothing live).
      RULES (account-abstraction v0.7.0 EntryPoint.sol and ERC-4337 at
      ethereum/ERCs f4df3d05, read 2026-10-09, cited in the doc comment on
      gasLimitProblems): verificationGasLimit > 0
      (_validateAccountPrepayment and _createSenderIfNeeded call with
      exactly that gas); callGasLimit > 0 even for empty callData
      (innerHandleOp skips the call for empty data, but the ERC's bundler
      sanity checks require at least a CALL's cost, and the client never
      builds empty callData); preVerificationGas > 0 (the ERC's minimum;
      the EntryPoint enforces none); paymasterVerificationGasLimit > 0
      when the op names a paymaster (undefined packs as 0);
      paymasterPostOpGasLimit unchecked (postOp runs only with a
      context). ENGINE: rpc.ts gasLimitProblems / gasEstimateProblems,
      ImpossibleGasEstimateError {problems, fields, attempts, source:
      estimate | paymaster | operation}, EstimateRetryPolicy,
      DEFAULT_ESTIMATE_RETRIES = 4 × 2 s (about 6 s of waiting while a
      user waits on Review — the 2026-10-09 bursts lasted tens of seconds,
      so the refusal is the real protection and the retry covers short
      bursts; the scripts keep 5 s × 24), BundlerClient
      .estimateUserOperationGasChecked (retries only impossible answers;
      bundler errors throw at once); SmartAccountClient config
      estimateRetries, the checked estimate before padding, and a final
      check on the op to be signed after the paymaster data and before
      beforeSign (catches padding that rounds to 0 and final paymaster
      data with a zero limit); the Circle transport refuses an effective
      paymasterVerificationGasLimit of 0 in either phase before any
      permit; the ERC-7677 transport refuses zero or omitted final limits.
      The raw estimateUserOperationGas is unchanged; the CTO added the
      new symbols to index.ts. APP: aa.ts AA_ESTIMATE_RETRIES,
      AA_IMPOSSIBLE_ESTIMATE_TITLE "The bundler's gas estimate was
      impossible." + sentence, isImpossibleGasEstimateError (by name),
      describeAaError mapping right after AaFeeRoseError with the engine
      text as technical detail; prepareAaCalls, the ERC-7677 quote
      (token-gas.ts passes the error through) and the guardian quote
      (recovery.ts) use the checked estimate so a zero never reaches a
      confirm screen; both USDC-fee clients, the guardian and passkey
      clients carry the retries; sessions.ts gets the engine default.
      Two fixtures fed zero limits by accident and were corrected (the
      live-run token-paymaster fixture's preVerificationGas 0 split into
      350,000 + 50,000 with the permit assertion unchanged; check-aa's
      sponsored fake paymaster now answers 0x400). TIMING: the Circle
      USDC-fee path has no quote-time estimate by design, so a zero there
      is caught at send time after the biometric prompt but before the
      final permit and the operation are signed (the sentence says "The
      operation was not signed or sent."). UNVERIFIED: whether 6 s ever
      outlasts a real burst; how a bundler treats a submitted zero-gas
      op; the sessions / subscription wording path (describeSessionError
      → describeAaError) has no check in its suites.
- [x] Item 0, in-app half — ARBITRUM SEPOLIA PROVEN LIVE THROUGH THE
      APP (2026-10-09; emulator, Expo Go, Metro worktree at 3b0a507 with
      the engine built inside it and a worktree-only metro.config.js
      resolveRequest pinning @shiba-wallet/* to the worktree's dist, 2,315
      modules; no repo files edited; every hash re-read on
      arbitrum-sepolia-rpc.publicnode.com and sepolia-rollup.arbitrum.io;
      the project id never left .dev-wallet/env). (A) Developer → Arbitrum
      Sepolia: banner, the layer-2 note (the L1 cost is inside the gas
      estimate; no swaps), endpoint "default (1 of 3:
      arbitrum-sepolia-rpc.p…", Home 0.004 test ETH + "USD Coin · ERC-20 ·
      2 USDC"; the Sessions / Guardians / Inheritance / Passkey links
      appeared only after the Kernel account was deployed (by design).
      (B) AA row: NEGATIVE CHECK PASSED — the chain-11155111 ZeroDev URL
      refused with "This bundler serves Ethereum Sepolia (chain id
      11155111), but you are saving it for Arbitrum Sepolia (chain id
      421614). Nothing was saved…"; the chain-421614 URL → "Verified ✓ —
      the bundler reported chain id 421614 (Arbitrum Sepolia) and
      eth_supportedEntryPoints includes EntryPoint v0.7 (checked
      2026-10-09)", row "ready · Kernel v3.3 (ERC-7579)". (C)
      SMART-ACCOUNT SEND THAT DEPLOYED THE ACCOUNT (0.0001 test ETH to
      Account 2): form "Not deployed yet — the first send deploys it.";
      the first Review was accepted (0 zero-estimate refusals seen);
      confirm DEPLOYMENT "Will deploy with this send", max fee
      0.0000711385387776 test ETH (0.1423044 gwei × 499,904 gas), preview,
      the own-account risk line, one prompt "Approve sending 0.0001 test
      ETH from your smart account"; userOpHash
      0xd5d576307687fcb96745df03f754c454568f78ca58bb95c51e8035a0146ab88a,
      bundle tx 0x0527bd9f6655f537480cf1455d166c287e218cbd9445e8a327dd7cc08a6b36b9,
      block 317505893, status 0x1, gasUsed 346,851, gasUsedForL1 0;
      AccountDeployed via the meta factory, OwnerRegistered(0x772e…F44F),
      Deposited 71,138,538,777,600 wei (= the displayed max fee),
      UserOperationEvent success, actualGasCost 19,977,423,921,572 wei;
      the signed op carried verificationGasLimit 398,217 (non-zero),
      callGasLimit 50,180, preVerificationGas 51,507; afterwards code 61
      B, Kernel ETH 1,828,861,461,222,400 wei, EntryPoint deposit
      51,161,114,856,028 wei. (D1) 1 USDC EOA → Kernel account, one
      prompt, risk line "…to one of your own accounts in this wallet:
      Account 1's smart account…", no Layer 1 line: tx
      0xc0d20e974a07bd92b9e24bdda2dafe4c96b30b1b912146658c8d36c063e5496e,
      block 317506860, gasUsed 62,159 of 62,989, tip 0. (D2) GAS PAID IN
      USDC IN-APP ON ARBITRUM: 0.3 USDC was correctly refused before any
      prompt ("…holds 1 USDC, but this send needs 0.3 USDC plus a network
      fee of up to 0.749749 USDC…"), so 0.2 USDC was sent: confirm "up to
      0.749508 USDC" (1,770,000 gas × 0.14115024 gwei × 3000, arithmetic
      checked), the fixed-test-oracle note, "0% (0 basis points)" with the
      10%-documented note, the paymaster address, the permit sentence,
      TOTAL USDC (WORST CASE) 0.949508, the USDC-fee preview footnote, one
      prompt "Approve sending 0.2 USDC from your smart account" (about 48 s
      to the success screen — whether the engine retried a zero estimate
      is not visible); success "Network fee charged: 0.054559 USDC (up to
      0.749508 USDC was permitted; the rest was refunded in the same
      transaction)."; userOpHash
      0x55e9959604f394d7977c3f626c242c47f067aa215c7ee82bf2922e4213d8ed2f,
      bundle tx 0xa2c62f6e494d6794e846bdaa0daa05027bd42dbf11d8c47a641ee0e5d87f9aa0,
      block 317507769, status 0x1, paymaster 0x31be…0b58,
      UserOperationSponsored actualTokenNeeded 54,559 (= the line shown),
      permit and prefund pull 333,188 / refund 278,629, Transfer 200,000
      to Account 2, signed paymasterVerificationGasLimit 473,173
      (non-zero); Kernel ETH, EntryPoint deposit and allowance identical
      at block−1 and block, Kernel USDC 1,000,000 → 745,441. (E) EOA MAX
      (fee in ETH): the Max trim box appeared live ("The amount was
      lowered from 0.00399415320266 test ETH to 0.00399414135866 test ETH
      because the network fee rose after you tapped Max…"), TOTAL =
      BALANCE 0.00399650293466, NO Layer 1 line; tx
      0x88f48f773973d89d084c97b3150a68bdaa432a1a2a312b5f8376059e2c36f5df,
      block 317508661, value = the lowered amount, gasUsed 21,000 = limit,
      actual fee 49.8% of the worst case, gasUsedForL1 0. (F) back to
      Ethereum Sepolia: Home 0.00482 test ETH, USDC 30.6, EURC 40.991829,
      every account-tool link. The L1 component was 0 for the whole pass
      (non-zero L1 still unverified). FINDINGS (fix slice dispatched): (1)
      BUG — when Max is trimmed at Review, the biometric prompt reads the
      PRE-TRIM typed amount ("Approve sending 0.00399415320266 test ETH")
      while the confirm and the signed transaction use the lowered amount
      (SendScreen builds the title from the form text, ~line 1524; the
      smart-account aaSendApprovalPrompt takes the typed amount too) — the
      value sent was correct, only the prompt text is wrong; (2) copy —
      with the smart account and the USDC fee both on, the Send USDC info
      box still says "The network fee is paid in test ETH, not in USDC.";
      (3) layout — the Developer test-network buttons break words
      mid-word ("Ethe/reum/Sepo/lia", "Off/(mai/nnet)"); (4) the Network
      endpoints status truncates the Arbitrum host; (5) observation —
      Circle's worst case on Arbitrum is about 0.75 USDC (14× the actual
      charge), so a 1-USDC balance cannot send 0.3 USDC with the USDC
      fee; (6) dev only — the LogBox toast "Cannot connect to Expo CLI…
      Error: undefined" appeared once while Metro was serving. Emulator
      notes: the keyguard sleeps 10 s after a cold boot, so wake, finger
      touch and PIN taps must run in one burst; uiautomator dumps take
      ~24 s while spinners run. Funds after (Arbitrum): EOA
      1,186,122,000,000 wei + 1 USDC, Kernel 0.001829 ETH + 0.745441 USDC
      + 0.0000512 deposit, Account 2 0.004094 ETH + 0.2 USDC. End state:
      Ethereum Sepolia, Account 1, light mode, Google IME, the Arbitrum
      bundler saved on the device; Metro still serving wt-app at 3b0a507.
- [x] Arbitrum-pass findings FIXED (commit above; check-aa 338 (was 304);
      offline runner ALL GREEN in the CTO's isolated worktree — now with
      its own engine resolution: engine 866, app 5,677 across 44 suites,
      lint 0/0, tsc clean; not seen on a device). (1) aa.ts
      sendApprovalPromptTitle(quote, symbol, decimals) + exactAmountText:
      the biometric prompt is built from the QUOTE's amount with the
      confirm screen's own formatting (SendScreen's exact() calls the same
      helper) on every path — regular, ERC-20 (own symbol/decimals), NFT
      (text unchanged), smart-account (through the unchanged
      aaSendApprovalPrompt) and the USDC-fee path (quote.token); live trim
      case before/after: "Approve sending 0.00399415320266 test ETH" →
      "Approve sending 0.00399414135866 test ETH"; untrimmed canonical
      amounts byte-identical; one deliberate change: "1.50" now reads
      "1.5" like the confirm. Mutants caught: a title from
      maxAdjustment.requested (in-suite) and the old form-text title (by
      hand, 2 checks failed). (2) sendFormTokenFeeSentence /
      tokenGasThroughPhrase: with the USDC fee on, the Send form's box
      reads "The network fee is paid in USDC through Circle's paymaster,
      not in test ETH; Review shows the most it can cost." (Pimlico named
      on Ethereum Sepolia); the ETH wording unchanged. (3) Developer →
      Test network uses choiceChips/choiceChip (row, wrap, gap 10,
      flexGrow 1, flexBasis 40%, minWidth 140) so two chips sit per row
      and words no longer break mid-word (reasoned from the styles; the
      Smart-account type and Auto-lock rows keep the old flex-1 style and
      may wrap the same way — not observed). (4) the endpoint status tag
      lost numberOfLines={1} and wraps a long host.
- [ ] RECURRING-PAYMENTS REHEARSAL, BLOCKED AT STEP 2 (2026-10-09;
      emulator, Metro at 3b0a507; nothing installed, no repo files
      edited). The form rendered exactly as recorded (intro, while-open
      box, later-slice note, spending note, "Pay to (receives the
      payments)", periods incl. "2 minutes (testing)" and Custom, "Number
      of payments (1–120; sets the expiry)", the fee-budget hint, the
      balance line); the mainnet negative (no Sessions link, no banner,
      "Session keys: test networks only") held. Review was REFUSED twice
      at eth_estimateUserOperationGas with AA21 "didn't pay prefund",
      before and after a 0.002 top-up from Account 1's EOA (tx
      0x93e9b8433a3e2ec892094830722cb2c4eec8f7c9d720b2a2301b9248d1554e70,
      block 11880316). ROOT CAUSE (read-only probes, scratchpad p15c):
      the subscription-template install now estimates callGasLimit
      3,031,138 / verificationGasLimit 310,546 / preVerificationGas
      60,711 on Sepolia — eth_estimateGas for the installValidations
      self-call alone is 2,661,683, about THREE TIMES the 2026-10-04
      install (tx 0xc8091a4d…a4b2fe used 976,899 gas for the whole op) —
      while ZeroDev's standard priority fee sat at a constant 1.155 gwei
      (40 samples / 10 min), so the app's floor + 100% quote (2.31 gwei)
      needs about 0.0079 ETH of balance plus deposit against the 0.005
      held; the same op passes at 1.2 gwei. publicnode's eth_config
      reports a fork activated at 1791294816 (2026-10-06 13:53:36 UTC)
      with builder deposit/exit system contracts, and since then plain
      ETH transfers emit a Transfer log from
      0xfffffffffffffffffffffffffffffffffffffffe (seen in the funding
      receipt) — the fork's name and EIP list are NOT yet verified from
      documentation. FINDINGS (fix slice dispatched): (1) BUG — the
      fee-budget pre-fill (suggestedFeeBudget → payments × 500,000 ×
      node maxFeePerGas × 2, about 0.000003 ETH for 3 payments) is priced
      at the NODE's fee while the payments are signed at the bundler floor
      + 100% (about 2.31 gwei) and GasPolicy charges (pVG + vGL + cGL) ×
      maxFeePerGas per op (the phase-13 pull cost 0.000909 ETH), so the
      first payment would exceed the default budget and be refused by
      GasPolicy — predicted from code and on-chain arithmetic, not run;
      (2) COPY — an AA21 from the ESTIMATE of a set-up reads "sending 0
      wei plus its network fee exceeds the balance…" and names no amount
      to fund; (3) NEW CHAIN BEHAVIOUR — the 0xff…fe Transfer log makes
      the Send preview show a second bogus row "You send 2000000000000000
      raw units of token 0xffff…FFfE (decimals unreadable)" under "You
      send 0.002 test ETH" (Activity decoding probably affected, not
      checked); (4) COST — every Kernel permission install (sessions,
      subscriptions, recurring, guardians) is likely about 3× dearer on
      Sepolia now (not measured for the others); (5) a revoked
      subscription card still shows the batching warning; (6) the
      emulator hit load 76 and a "Process system isn't responding" dialog
      during the first Review. Funding for the re-run: the CTO sent 0.01
      Sepolia ETH from the dev EOA to the Kernel account 0xD31c…D8FA (tx
      0x0293867adea984c67d62dfff3e9d8f704ed789071e220fc67c441a51a2a83b1d,
      block 11880421; gasUsed 27,539), so it holds about 0.01465 ETH +
      0.000347 deposit. Funds otherwise: Account 1 EOA 0.00282, payee
      8,000 wei unchanged. End state: Home, Ethereum Sepolia, Account 1,
      light mode, Google IME; emulator and Metro (wt-app 3b0a507) still up.
- [x] SEPOLIA FORK FINDINGS RESOLVED (commit 8351c09; offline runner ALL
      GREEN in the CTO's isolated worktree: engine 877 — chains-evm 615 —
      app 5,729 across 44 suites, check-aa 350, check-activity 58,
      check-simulation 62, check-subscriptions 176, lint 0/0, tsc clean;
      every mutant caught; nothing sent; copy not seen on a device). THE
      FORK, from primary sources: GLAMSTERDAM (Amsterdam on the execution
      layer) — EIP-7773 "Hardfork Meta - Glamsterdam" (ethereum/EIPs
      af3a7802) lists Sepolia at "353024 | 1791294816 (2026-10-06
      13:53:36 UTC)" (set by commit 644b8479); blog.ethereum.org
      2026-09-17 testnet announcement; go-ethereum v1.17.6 notes; the
      forkId 0x6c1d9423 from publicnode's eth_config matches geth's
      "First Amsterdam block" test entry; the builder deposit/exit
      contract addresses match EIP-8282. EIP-7708 (Last Call, scheduled
      in 7773): every nonzero ETH transfer to a different account (the
      transaction itself, CALL, SELFDESTRUCT, CREATE/CREATE2) emits a
      LOG3 from SYSTEM_ADDRESS 0xfffffffffffffffffffffffffffffffffffffffe
      with keccak('Transfer(address,address,uint256)'), from/to as topics
      and the wei amount as uint256 data; nothing for zero value,
      self-transfers, fees or reverted frames (execution-specs 64cbead5
      emit_transfer_log agrees; eth_getCode at 0xff…fe is 0x on all four
      networks, so no contract can emit from it). EIP-8037 (state
      creation, CPSB 1530: a new slot about 110,020 gas instead of about
      22,100) and EIP-8038 (STORAGE_WRITE 2,800 → 10,000, cold account
      2,600 → 3,000) explain the install cost; EIP-2780 is in the fork
      too (a transfer to a never-used address about 204,600 gas; a
      zero-value transfer 15,000; a self-transfer 12,000). MEASURED same
      calldata pre-fork (0xrpc.io/sep, geth 1.17.7, STUCK at block
      11856335 = 24 s before activation, eth_syncing false — the app's
      third Sepolia fallback is serving a stale pre-fork chain; cause
      unverified, follow-up) vs post-fork (publicnode): subscription
      installValidations 611,578 → 2,661,683 (eth_estimateGas), 599,723 →
      2,617,795 (eth_simulateV1); WETH deposit 45,038 → 133,058;
      guardian install 155,417 + 77,721 → 521,869 + 249,590 (×3.3);
      passkey install 136,570 → 488,144 (×3.6); session grant 511,682 +
      51,597 → 2,203,598 + 132,829 (×4.1); subscription (native, 3
      payments) 611,578 + 51,597 → 2,661,683 + 132,829 (×4.2); a native
      PULL did not rise (handleOps simulation 429,439 post vs 445,795
      pre). Practical consequence: a subscription or recurring set-up
      needs about 0.008 ETH of headroom at 2.31 gwei. DECODING RULE
      (asset-diff.ts mergeNativeTransferLogs): eth_simulateV1 with
      traceTransfers on publicnode (which load-balances reth 2.7.0 and
      geth 1.17.7; each probe batched with web3_clientVersion) returns
      for a plain transfer ONLY the 0xff…fe log on reth but the 0xeeee
      pseudo-log FOLLOWED BY the 0xff…fe log on geth (execution-apis
      issue #868; geth PR #35617 merged 2026-10-07, in v1.17.8,
      suppresses the pseudo-log) — the rehearsal's double row came from
      geth; a Transfer log from 0xff…fe (3 topics, 32-byte data) is now a
      NATIVE change, and within one call each protocol log cancels one
      uncancelled pseudo-log with the same from/to/amount (per movement
      the larger count wins — correct for geth, reth, nethermind, besu
      and pre-fork nodes); a protocol log can back a WETH
      Deposit/Withdrawal; a 4-topic 0xff…fe log is skipped and counted.
      New exports EIP7708_TRANSFER_LOG_ADDRESS /
      isEip7708TransferLogAddress. Fixtures: the live funding receipt
      (block 11880421) and both clients' simulate answers for four cases.
      Consumers audited: activity-decode.ts WAS affected (the log became
      token 0xff…fe; now native and skipped — ETH is read from the tx
      value, so Activity reads as before; wrap decoding off for receipts);
      erc20-logs.ts getErc20Transfers and contract-risk.ts
      isFirstInteraction now exclude the system address (the app always
      passes tokens, so not affected in practice); the spending policy
      consumed the doubled preview (fixed by the merge); token-gas-smoke
      now checks both emitters; approvals, recovery, the paymaster event
      decoders and the keeper are unaffected. FEE BUDGET:
      readSubscriptionFeeFacts(node, account, {bundler}) prices with
      quoteFeesOverFloor(node suggestion, bundlerFeeFloor) — exactly what
      sendSessionCalls signs — with feeSource 'node' as the labelled
      fallback; the ×2 margin and SUBSCRIPTION_PULL_GAS_ALLOWANCE 500,000
      stay, justified from the recorded pulls (367,706 / 302,094 /
      302,094; 438,168); feeBudgetSuggestionHint and a review
      feeBudgetPricingNote say what it is priced at and how many payments
      it covers; the default budget is pinned to cover 438,168 gas at the
      signed fee. SET-UP FUNDING: aaEstimateFundingMessage for an AA21 at
      the estimate when every call has value 0 (refused to estimate;
      balance and deposit in exact wei; exact fee unknown; fund and
      review again; bundler text verbatim); aaFundingMessage never says
      "sending 0 wei". CARDS: cardShowsBatchingWarning hides the warning
      for revoked / not installed / failed / expired / finished grants
      (kept while the status is loading). UNVERIFIED: which client
      ZeroDev simulates with; nethermind / besu behaviour; the
      opcode-level breakdown; ERC-20 pull gas post-fork; why 0xrpc.io is
      stuck.
- [x] F-66 FIXED — default endpoints behind the chain are skipped
      (commit 3a4901d; check-rpc-fallback 166 offline / 194 live (was 109),
      check-failover 150 unchanged; offline runner ALL GREEN in the CTO's
      isolated worktree: engine 877, app 5,786 across 44 suites, lint
      0/0, tsc clean; eight mutants caught; not seen on a device).
      probeEndpoint reads the newest block's timestamp AFTER identity
      passes, within the same 4 s deadline (sequential, so a down or
      wrong-chain candidate still gets exactly one request): eip155
      eth_getBlockByNumber("latest") timestamp (execution-apis 34151926),
      bound 600 s (50 Ethereum slots; the slowest profile sets it);
      Esplora GET /blocks (ten newest; the newest timestamp, because
      Bitcoin timestamps are not monotonic; Blockstream API.md cfcb22c4),
      bound 10,800 s; Solana getSlot(finalized) + getBlockTime (null =
      unknown; getHealth deliberately not used — a self-report is what
      failed in F-66), bound 300 s. Rules: exactly at the bound is
      fresh; a head ahead of the device clock is fresh; a failed,
      unsupported, null or timed-out freshness read is 'unknown' and
      ACCEPTED; a stale candidate is skipped like a wrong-chain one (new
      ProbeResult kind 'stale' with headTimestamp); LAST RESORT (CTO
      accepted): when no candidate is healthy the resolver returns the
      stale candidate with the newest head, flagged healthy:false,
      stale:true (a wrong device clock or a halted chain would otherwise
      blank the chain), then the first unreachable one as before, never a
      wrong-chain one; findAlternateDefaultUrl skips stale alternates;
      overrides never probed. Settings: "default (2 of 4: host, behind
      the chain)", a primary-stale note, and an all-stale note naming the
      phone's date and time. New exports FRESHNESS_BOUND_SECONDS,
      assessHeadFreshness, ProbeOptions {now, checkFreshness,
      freshnessBoundSeconds}; DefaultChoice gains primaryFailureKind /
      stale. LIVE (keyless lists, 2026-10-09): only https://0xrpc.io/sep
      is skipped as stale (block 11856335, timestamp 1791294792, about
      84 h old, eth_syncing false); the other defaults' heads were 0–16 s
      old (Bitcoin 425–771 s); public.1rpc.io/sepolia once answered no
      head within 4 s and was accepted as unknown. NOTED: the live pass's
      expected-status table for eth_simulateV1 is out of date since the
      fork (Pocket and 1RPC report "answered without the traceTransfers
      log" because the log now comes from 0xff…fe) — a printed note only;
      follow-up. Why 0xrpc.io froze is unknown.
- [x] Item 1 — RECURRING PAYMENTS PROVEN LIVE IN-APP (2026-10-09 US
      Eastern / 2026-10-10 UTC; emulator, Metro worktree moved to d6fd300
      with the engine built inside it, 2,306 modules — Expo Go needed an
      `am force-stop host.exp.exponent` to drop the old bundle; no repo
      files edited; every hash verified on publicnode). Form: the new
      hint "Suggested from the fee each payment is signed at today (the
      bundler's current fee plus 100% headroom)…", pre-fill
      0.006930000012 test ETH for 3 payments (2.31 gwei), the balance line
      with the 0.01465 + 0.000347 deposit. Review (no AA21 this time):
      batching box first, the sentence "Pays 0x69F0… up to
      0.000000000000001 test ETH every 5 minutes until 2026-10-10 02:03
      UTC…", the start note, the three recurring notes, the bullets, the
      session-key line; max network fee 0.009543 test ETH (bundler
      estimate 0.007953 + 20%); the budget auto-lowered to 0.0054575 to
      keep the install fee back, with the pricing note "Fee budget priced
      at 2.310000004 gwei per gas … 500,000 gas per payment … doubled
      because fees move; it covers the fees of all 3 payments at that
      fee." Start: 3 prompts ("Approve this recurring payment", "Protect
      the new session key with biometrics", "Approve signing with your
      recovery phrase" — the third only because the driver's 45 s dumps
      let the 30 s phrase hold lapse; 2 when answered promptly), "Final
      terms: the first payment is due from 2026-10-10 01:50 UTC, then one
      more every 5 minutes (3 in total); nothing after 02:05 UTC";
      install userOp 0x8df52475f67214c2f2ff46be90b904f4c765892d63b884d0cff1f0f028879d79,
      tx 0xd4e0d06b47b5b9d74e01e80ea2f215234845279cdda81e0c7f6fce78b03def74,
      block 11881366, gasUsed 2,945,937 (post-fork cost), actualGasCost
      0.0069 ETH, permission 0x5eec2ec3. Card: "Payment due now (since
      01:50 UTC).", "0 of 3 payments sent.", the budget left, "Payment key
      on this phone only (never shown or exported)…", the headline box.
      PAYMENT 1: Cancel left the permission-key nonce at 0; "Send payment"
      raised exactly ONE prompt "Use the session key" and NO phrase
      prompt; userOp 0x2d5dc6a1ccc7fd6c921fc4ac6f63d5e412746cbca30c8669da4924835885427d,
      tx 0xcdaaf98827694747448c227b56aed093aab6e904ef261eed3ecc457c8ac53a47,
      block 11881383, sender 0xD31c…, nonce key 0x25eec2ec3… seq 0,
      success, the EIP-7708 log showing 1,000 wei to the payee. The
      second slot had already opened, so the "Next payment: not before…"
      state was never shown. Background (3.7 min, under the 5-min period
      because the grant ended at 02:05): nonce unchanged; after the
      auto-lock unlock (1 ordinary prompt) the banner sheet "1 recurring
      payment is due…" with Review / Not now. Catch-up: "2 payments due
      now (the first since 01:55 UTC). 1 was missed; your account allows
      them to be sent now, one at a time."; PAYMENT 2 (1 prompt): userOp
      0x09496a0b60a1543202a93771484e0baed7352cf5652f65dbfc1449a12129ffd3,
      tx 0x51cb6ff0b60817376972108fbfb38189039dc3e8a69acad7761582dee9a9bc14,
      block 11881417, seq 1, success. PAYMENT 3 FAILED after the prompt
      with a transient emulator DNS error ("Unable to resolve host
      ethereum-sepolia-rpc.publicnode.com") and the grant expired at
      02:05 before a retry; card "Active on-chain, but expired…" /
      "Completed: ended 02:05 UTC; 2 of 3 payments were sent." REVOKE AND
      FORGET (1 prompt; no batching warning on the expired card): userOp
      0x75f4475f9a874746a6528f3553193f077d4266e719ad88fd10707bb5b0d63f07,
      tx 0xb70cf960c889cb3877bf8b3587fd733918af7454cfd294b4f1725edb5c6de31f,
      block 11881439, success; readKernelPermissionState: installed
      false, no policies; "None on this device."; every phase-13 revoked
      subscription card shows no batching warning; mainnet mode shows no
      Sessions link and no banner; the Developer chips sit two per row
      with no mid-word breaks (the Arbitrum-pass fix seen live). Step 9
      (spending limit below 1,000 wei) skipped. FINDINGS (fix slice
      dispatched): (1) BUG — the recurring send path shows the raw
      UnknownHostException in the alert, twice in the card status and as
      "Last payment attempt refused: fetch failed…" (wrong word for a
      network failure), despite describeRecurringPaymentError's comment;
      neither the send nor the status read failed over to the other
      Sepolia endpoints; (2) BUG/UX — the card's due state is computed at
      render only and reloads on focus, so after the unlock it still
      said "due now (since 01:55)" until Refresh; (3) DESIGN — validUntil
      = start + payments × period gives the LAST payment a single period,
      so a late payment plus a transient error loses it for good,
      contradicting "missed payments are not lost" near the end; (4) the
      auto-lowered fee budget still trips the keep-back warning by
      38,808,000,067 wei because the lowering is computed from the first
      quote and the re-quote came back higher; (5) copy — "Merchant:" on
      the payee error, "Pulls" in the funding box, "the session key is
      deleted" on the revoke screen, the dialog says twice that the
      payment key signs, "Completed: ended …; 2 of 3 payments were sent."
      for an expired grant with a payment unsent. Funds: Kernel
      0.014654 → 0.004747 ETH + deposit 0.000347 → 0.000450 (spent
      0.0098035 = the four actualGasCosts + 2,000 wei, reconciled);
      payee 8,000 → 10,000 wei. End state: Home, Ethereum Sepolia,
      Account 1, light mode, Google IME, nothing installed; Metro at
      d6fd300.
- [x] Recurring-rehearsal findings FIXED + an APP-WIDE ROOT CAUSE (commit
      d3cf3cc; check-recurring 169 (was 114), check-subscriptions 183,
      check-sessions 139, check-failover 153; offline runner ALL GREEN in
      the CTO's isolated worktree: engine 877, app 5,853 across 44 suites,
      lint 0/0, tsc clean; 34 mutants caught; not seen on a device). ROOT
      CAUSE of the raw exception (from the installed source): Expo SDK 57
      replaces the global fetch (expo/src/winter/runtime.native.ts; opt-out
      EXPO_PUBLIC_USE_RN_FETCH not set) and a failed request throws
      FetchError extends Error — NOT a TypeError — with the message
      "fetch failed: <platform text>" (expo/src/winter/fetch/FetchErrors.ts);
      endpoint-probe's isEndpointFailure accepted "fetch failed" only on a
      TypeError, so on the device a DNS failure was never an endpoint
      failure anywhere in the app (no failover, raw Java text) — the phase
      13 "bug 4" fix had been tested with a TypeError. CTO FIX, app-wide:
      isEndpointFailure also accepts name === 'FetchError' or an Error
      whose message STARTS with "fetch failed:" (the engine's "UTXO fetch
      failed: HTTP 400" does not and keeps its status rule); pinned in
      check-failover with the live message; the agent's sessions.ts
      isTransportFailure clause stays as a harmless second line.
      RECURRING FIXES: (1) describeRecurringPaymentError returns an
      outcome — "not sent" (node failure, unanswered status read, or a
      bundler failure before submission; every node request and every
      bundler request except eth_sendUserOperation precedes the
      submission, since SmartAccountClient.sendCalls submits last): title
      "Could not reach the network endpoint. Check your connection and try
      again.", a detail saying the payment was not handed to the bundler
      and no allowed payment was used up, then "Technical detail: …";
      "outcome unknown" (failure during eth_sendUserOperation): "Payment
      status unknown" with the nonce-decides explanation and "Tap Refresh
      status and wait for the count before sending again"; AA22 / policy
      refusals keep "refused"; the card's status line is shown once;
      the chain id is read BEFORE the vault so a dead node is found before
      the "Use the session key" prompt; node errors marked by
      markNodeErrors, bundler errors by method; the status read
      (readStatusWithFailover, screen and banner), the plan
      (activeEvmNodeRunner) and the payment (quoteOnNode) fail over once
      on node failures only, never the bundler (caveat: a node dying after
      the key was read costs one more prompt on the retry). (2)
      RecurringDueBanner.tsx hosts useOnAppActive (the single AppState
      listener) and useClockTick(30 s, focused); the list computes
      recurringDueState(record, status, nowTick) locally and re-reads on a
      return to the foreground. (3) GRACE PERIOD: subscriptionGrantFor(sub,
      key, {graceSeconds}) moves only the GRANT's validUntil after the
      engine built it (re-validated by validateSessionKeyGrant);
      recurringGrantFor passes one period; the RateLimitPolicy count still
      equals the number of payments (kernel-permissions.ts 547 / 553–557;
      kernel-subscription.ts 44–56, 66–69 — relied on the engine's notes,
      Solidity not re-read), so no extra payment is possible;
      termsMatchGrant accepts an end exactly one period later (older
      records still load; a subscription record with a grace is dropped as
      corrupt); the local call check uses the INSTALLED grant; review
      "until <grant end>", "Nothing after <end>. The last payment falls due
      <date> and can be sent until then.", the catch-up caveat explains the
      grace; merchant subscriptions deliberately unchanged (the keeper
      checks the handed-over terms). (4) fitFeeBudgetToInstall re-fits the
      keep-back against each new quote for up to
      SUBSCRIPTION_FEE_BUDGET_REFIT_ROUNDS = 2, never raising; the test
      reproduces the old single-round trip. (5) Copy: "Payee: …";
      "Payments the account cannot pay for will fail…"; "…the payment key
      is deleted from this phone." / "…any copy of it stops working.";
      the dialog says once that the payment key signs; "Ended <date>: 2 of
      3 payments were sent; 1 was not sent before the end date."
      UNVERIFIED: on a device (TalkBack, the timer under background
      throttling, the second key prompt after a mid-send failover); that
      the device error object is exactly Expo's FetchError (message format
      matches byte for byte; not reproduced).

## Phase 15 status (2026-10-09, end of the autonomous run)

Items 0 to 4 are landed and pushed. Proven live this phase: Arbitrum
Sepolia by script and then through the app (the Kernel deployment
through ZeroDev, gas paid in USDC through Circle's paymaster, an EOA
Max send with Arbitrum's fee model), recurring payments through the
app's own screens (set-up, two payments signed by the recurring key
alone with one prompt each, the banner, catch-up, revoke and forget),
and a 2-of-3 multisig account by script. Built and verified offline:
the multisig engine spec (transaction-only, with the proof that the
deployed validator cannot give an honest k-of-n for messages), the
zero-estimate guard, the Glamsterdam fork decoding, the endpoint
freshness check, the app-wide Expo fetch-failure recognition, and the
fixes from the two emulator passes. Designed: the in-app dApp browser.
Engine: 877 tests. App: 44 offline suites, 5,853 checks. The shareable
page is at version 13 (40 proven live, 18 built, 2 designed, 39 not
started).

Findings for the Chairperson this phase: ZeroDev's Arbitrum bundler
often answers impossible (zero) gas estimates (guarded); the deployed
weighted validator cannot give an honest multi-signature for messages
(an item for the disclosure decision; its message-signature
counterexample is simulated, not live — corrected 2026-10-10); Glamsterdam on Sepolia
made every Kernel permission install three to four times dearer and
added protocol transfer logs that two clients report differently; a
default fallback endpoint (0xrpc.io) has been frozen since the fork;
react-native-webview's defaults are unsafe for a wallet (the dApp
browser is a decision).

Waiting on the Chairperson: the dApp browser decision; the ZeroDev
disclosure decision (seven findings); a phone and Expo account; the
items listed under the phase 9 status.

Follow-ups (no inputs): a multisig app slice if wanted
(docs/MULTISIG.md §11); the merchant-subscription grace period and the
keeper; the check-rpc-fallback live table's eth_simulateV1 expectations
after the fork; the "Error: undefined" LogBox toast (dev only); the
Smart-account type and Auto-lock chip rows in Settings (same wrap style
as the fixed Developer row); an ERC-20 pull post-fork gas measurement.

DECIDED by the Chairperson (2026-10-09): (1) build the dApp browser's
allowlisted-sites slice (docs/DAPP_BROWSER.md section 5; test networks
only, enforced), because it exercises capabilities WalletConnect cannot;
(2) the disclosure findings must be collected in one document so the
Chairperson can confirm each one against its evidence before any
disclosure decision; (3) hold everything that needs a physical phone —
emulate as much as possible, including a local development build on the
emulator where Expo Go cannot carry a feature.

## Phase 16 plan (started 2026-10-09): the dApp browser and the findings record

1. docs/DISCLOSURE_FINDINGS.md: every finding about third-party
   contracts gathered so far (the seven disclosure items plus the
   Circle, Pimlico, Glamsterdam and bundler observations), each with its
   claim, the exact evidence (sources at pinned commits, transactions,
   simulations, scripts to reproduce), its status (proven live /
   simulated / reasoned from source), and what would refute it.
2. The dApp browser allowlisted-sites slice per docs/DAPP_BROWSER.md
   section 5, then an emulator pass against a real test-network dApp.
3. Emulator-only substitutes for the phone track: a local development
   build on the AVD (passkeys through Credential Manager, screen-capture
   behaviour in a non-Expo-Go build, the WebView native checks).
4. Leadership refresh at the end.

## Phase 16 progress
- [x] Item 1 — docs/DISCLOSURE_FINDINGS.md (commit below; 8,601 words;
      secret scan clean; nothing sent anywhere): front matter (purpose,
      status definitions — proven live / simulated / reasoned from
      source, never upgraded — the shared reproduction setup, pinned
      sources, a summary table), sections A–G for the seven disclosure
      items with the same seven fields each (claim; artefact with
      addresses, repository commit and lines; how established; steps a
      reviewer can check; impact; what would refute it; the wallet's
      mitigation), section 8 for the related observations (Circle's
      surcharge docs 10% vs chain 0 and its static oracle; no published
      audit of Circle's or Pimlico's paymaster; Pimlico unstaked on
      Ethereum Sepolia; ZeroDev's zero estimates on Arbitrum; the
      audit-coverage gaps), section 9 where the record is thin or
      contradicts itself, section 10 a log of what was re-confirmed
      read-only on 2026-10-10 (every dry-run smoke passed; Sourcify
      sources of the weighted validator and CallPolicy byte-identical to
      the pins; the old WebAuthn sources contain the dummy-signature
      branch; both ECDSA validators carry the AlreadyInitialized check;
      code hashes of WebAuthn v0.0.3 and SpendingLimit match, and both
      SpendingLimit deployments carry only the three-argument postCheck
      selector; the multisig account's root is 0x01‖0xeD89…; every
      checked receipt status 0x1; Circle's paymasters on Base and
      Arbitrum Sepolia spread 0, fixed oracle, staked 0.25 ETH; Pimlico
      unstaked on Sepolia / 5 ETH on Base Sepolia; publicnode returned
      null for three old receipts, 1rpc served them). THE REVIEW FOUND
      TWO ITEMS OVERSTATED IN THE RECORD, now corrected in AGENTS.md,
      THREAT_MODEL.md F-62, MULTISIG.md and FEATURE_UNIVERSE row 24: (1)
      the multisig ERC-1271 counterexample (item a, multisig half) was
      SIMULATED in the smoke script's dry run on a different account —
      the live 2-of-3's leg makes no ERC-1271 call — although three
      documents said "proven live"; (2) item (d), "following ZeroDev's
      single-guardian docs example would overwrite the owner", is
      CONTRADICTED by the deployed contracts: both ECDSA validators the
      SDK uses (0x845A…cE57 and 0x8104…1c43) revert AlreadyInitialized on
      re-install per their Sourcify-verified source (phase 11 had already
      noted it), and a Sepolia eth_call of onInstall from 0x1D72…4106
      reverted with 0x93360fbf today — on the deployed code the recipe
      FAILS rather than taking over; the document recommends withdrawing
      or rewording (d). Also recorded: item (a) was worded too broadly in
      phase 8 and T-31 (it applies to MESSAGE signatures only — operations
      de-duplicate signers, so a lone guardian cannot recover an account);
      the disclosure count was inconsistent across phases (three, four,
      six, seven) with no single list until now; the phase 8 and phase 14
      live ERC-1271 results were eth_calls against state that no longer
      exists, so a vendor can only reproduce them through the
      simulations; item (c) was never run against v0.0.1 / v0.0.2 (only
      the v0.0.3 contrast; the SDK labels the old versions "UNPATCHED", so
      ZeroDev likely knows); the Arbitrum zero-estimate sampling script is
      not in the repo; the "no advisory / no audit / 91f8fcb nowhere"
      searches have no recorded scope; the "threshold 0" note does not
      apply to 0xeD89… (a zero threshold fails closed); a difference
      between WebAuthn v0.0.1 (passes its sender argument) and v0.0.2
      (msg.sender) in the ERC-1271 path was noticed but not analysed.
      DECISION FOR THE CHAIRPERSON: confirm the document, decide whether
      item (d) is withdrawn, and whether the list goes to ZeroDev /
      Offchain Labs (nothing has been sent).
- [x] Item 2 — THE IN-APP BROWSER, ALLOWLISTED-SITES SLICE (commit cb6eef3;
      new check-browser 260, check-readiness 177; offline runner ALL
      GREEN in the CTO's isolated worktree: engine 877, app 6,117 across
      45 suites, lint 0/0, tsc clean; ten mutants caught; expo export
      bundles 2,197 modules / 8.8 MB with RNCWebView and the new strings;
      NOT yet opened on the emulator). Dependency: react-native-webview
      13.16.1 via expo install (the version expo/bundledNativeModules.json
      pins and Expo Go's sdk-57 package.json lists; lockfile adds only
      it). FILES: new app/src/wallet/browser-sites.ts (origin parser,
      allowlist, navigation decisions, per-origin records under
      shiba-wallet.browser-connections.v1), browser-provider-script.ts
      (the EIP-1193 + EIP-6963 shim as a string; no secrets),
      browser-bridge.ts (method table, error translation, message
      validation, the frame rule, the read proxy with validation /
      eth_getLogs bounds / rate limiter, BrowserBridgeClient = a WcClient
      for browser:<origin> sessions, CompositeWcClient),
      screens/BrowserScreen.tsx (the "Apps" screen), scripts/
      check-browser.mjs; changed: walletconnect.ts
      (describeBrowserIdentity, identity status 'browser', siweOriginFor
      browser branch, methodMentionsEip7702 exported), siwe.ts,
      wc-controller.ts (uses a browser event's identity only for negative
      ids or browser: topics; browser_requests_withdrawn),
      WalletConnectContext.tsx (the controller exists from mount on the
      composite client; WalletKit attaches lazily via setWalletClient;
      approvals/disconnects answer through the composite; the launch
      marker counts WalletConnect sessions only; the bridge exposed as
      `browser`), WcApprovalSheet (browser identity in plain text),
      ConnectionsScreen ("In-app browser connections", shown even with
      WalletConnect off), readiness.ts (row dapp-browser, testnet-only,
      enforced in the screen AND the bridge), watch-only.ts (route
      refused: "The in-app browser (Apps)"), navigation.ts / App.tsx
      (route Apps), Home / Settings links, WalletContext (wipe forgets the
      browser records). ALLOWLIST: https://app.uniswap.org (every
      WalletConnect live test; Sepolia) and https://app.ens.dev (ENS's
      deployments page says Sepolia resolves through it; its headers send
      permissions-policy: camera=(); not yet opened); no Aave testnet page
      found. B1–B8: originWhitelist ['*'] so every decision is the
      wallet's — decideNavigation / siteForUrl compare scheme, host and
      port exactly with the wallet's parser (refuses backslashes, control
      characters, spaces, percent signs, non-ASCII and IPv6 hosts, leading
      dots, empty labels, ports > 65535; lower-cases; drops default ports;
      user-info flagged with the real host after "@"; 5,376 generated URLs
      agree with WHATWG URL.origin; the library's matcher rebuilt from
      source admits the prefix attacks, the wallet refuses them); B6
      unreachable, non-https refused without Linking, off-list https
      offered outside only after a confirmation showing the full URL (the
      single Linking.openURL), the first URL checked before render; B2/B3
      a message is acted on only when its reported origin equals the
      current top origin AND is allowlisted, else dropped unanswered
      before parsing (Android's fallback bridge reports the top URL for
      every frame — unfixable in JS; a page-reported heuristic is shown on
      Android, informational only); B4 the shim is injected before
      content and on every load end (idempotent: re-announces via
      EIP-6963, sets window.ethereum only if unset; each document says
      "hello", which withdraws the previous document's waiting requests);
      B5/B7/file upload are RESIDUALS stated in BROWSER_RESIDUALS on
      screen (no Android prop exists; iOS mediaCapturePermissionGrantType
      "deny", no onFileDownload); B8 setSupportMultipleWindows true,
      onOpenWindow loads an allowlisted page in the same view else refuses
      or asks. NEW FROM SOURCE: Android shouldOverrideUrlLoading waits at
      most 250 ms for the JS answer then ALLOWS ("defaulting to allow
      loading") — the second line detaches the bridge, stopLoading and a
      refusal panel at load start/end for an off-list top page; Android
      events carry no isTopFrame; Android incognito leaves DOM storage on;
      RNCWebViewManagerImpl enables WebView debugging under
      ReactBuildConfig.DEBUG (whether Expo Go sets it is unverified).
      Props set: incognito, cacheEnabled false, third-party and shared
      cookies off, mixedContentMode never, file access off, geolocation
      off, saveFormDataDisabled, allowsLinkPreview false,
      fraudulentWebsiteWarningEnabled, webviewDebuggingEnabled false,
      paymentRequestEnabled false. METHOD TABLE: local eth_chainId /
      net_version / eth_accounts ([] unless connected for the active
      owner + chain) / eth_requestAccounts (a session_proposal on the
      shared queue; repeats join; an already-served origin answered
      without a prompt; watch-only → 4100); queued only if connected
      (else 4100) and in the approved namespaces (else 4200):
      personal_sign, eth_signTypedData_v4, eth_sendTransaction,
      wallet_switchEthereumChain, wallet_sendCalls /
      wallet_getCapabilities / wallet_getCallsStatus (smart accounts;
      ERC-7715 never offered); requests carry the connection's chain so a
      mode change declines them (5100 → 4901); at most 5 waiting per
      origin (-32005); proxied reads eth_blockNumber, eth_call,
      eth_estimateGas, eth_getBalance, eth_getTransactionCount,
      eth_getCode, eth_getTransactionByHash / Receipt,
      eth_getBlockByNumber / ByHash, eth_feeHistory, eth_gasPrice,
      eth_maxPriorityFeePerGas, eth_getLogs (no state overrides; an
      authorization list refused with the D6 sentence; getLogs: a block
      hash, an explicit range ≤ 1,000 blocks or latest only, ≤ 20
      addresses, 4 topic positions; rate limit per origin 10/s, 120/min,
      4 in flight — judgements; withEndpoint failover; each endpoint's
      eth_chainId checked once; the page sees only code / ≤ 500-char
      message / hex data, transport failures as a generic sentence);
      refused 4200 with a reason: wallet_addEthereumChain, eth_sign,
      eth_signTypedData / v1 / v3, eth_signTransaction,
      eth_sendRawTransaction, wallet_requestPermissions / getPermissions /
      revokePermissions, wallet_connect, the four ERC-7715 methods,
      wallet_showCallsStatus, wallet_watchAsset, eth_subscribe /
      unsubscribe, anything unknown. D6: method names matching
      authorization / 7702 / delegat → EIP7702_WC_REFUSAL (5101 → 4200);
      authorizationList / authorization_list / type 0x4 transactions →
      5000 → 4001 with the same sentence. Error translation 5000→4001,
      5100→4901, 5101→4200, 5103→4100 (design); 5102→4200, 5104→4200,
      6000→4100 (judgements); 57xx / 4xxx / -326xx pass through; on a
      non-test network every message gets 4900 with the readiness
      refusal. IDENTITY: the sheet shows "Opened in this wallet's browser:
      the request came from <origin>, as reported by the web view…"; a
      mismatched SIWE domain stays behind the existing risk switch (not
      refused outright — the Chairperson's call). THREAT MODEL: T-71 and
      F-67 added by the CTO. UNVERIFIED: whether Uniswap / app.ens.dev
      detect the provider and complete a connection, SIWE or swap, and
      whether their pages run with third-party cookies and cache off; the
      Android order of onLoadStart vs the shim's first messages after a
      cross-origin navigation between the two sites (early messages would
      be dropped); which bridge path the emulator's WebView uses; B5 in
      practice; the rate limits against real traffic; iOS entirely.
      Emulator checklist (10 steps, Expo Go, Sepolia, Account 1, Uniswap)
      in the builder's report — runs once the dev-build probe releases
      the AVD.
- [x] Item 3 — LOCAL DEVELOPMENT BUILD ON THE EMULATOR, FEASIBLE (2026-10-10;
      no Expo account, no EAS, no phone; nothing committed; the Expo Go
      wallet untouched). TOOLCHAIN (verified): there was NO JDK on the
      machine (/usr/bin/java is the macOS stub) — portable Temurin
      17.0.20.1 installed into the scratchpad (sha256 checked against
      api.adoptium.net; 17 because @react-native/gradle-plugin 0.86.3
      declares jvmToolchain(17)); requirements from react-native's
      libs.versions.toml: compileSdk/targetSdk 36, build-tools 36.0.0,
      NDK 27.1.12297006, AGP 8.12.0, Gradle 9.3.1; added with sdkmanager:
      build-tools;36.0.0 (188 MB), platforms;android-36 (134 MB),
      cmake;3.22.1 (94 MB), ndk;27.1.12297006 (2.4 GB; expo-modules-core
      and react-native-screens compile C++) — SDK 5.8 → 8.8 GB. ROUTE:
      a separate worktree (scratchpad/wt-build at 40602dc) with APFS
      CLONES of both node_modules (cp -cR, ~13 s; Gradle writes
      node_modules/*/android/build, which symlinks would have put into the
      main checkout — the main checkout's node_modules has no build
      folders afterwards), @shiba-wallet pointing at the worktree's
      packages, `npm run build` inside it, `CI=1 npx expo prebuild
      --platform android --no-install` (4 s; it sets android.package and
      a permissions list in the worktree's app.json / package.json), then
      Gradle directly (`./gradlew assembleDebug -PreactNativeArchitectures=x86_64
      -PreactNativeDevServerPort=8082`, 10 min 22 s, 83 MB APK;
      assembleRelease 6 min 31 s, 51 MB) — not `expo run:android`, to keep
      Metro off 8081; Gradle files 5.5 GB, worktree 3.2 GB. Repeatable via
      scratchpad p16c/build-devclient.sh <commit> [debug|release] +
      env.sh (the JDK and Gradle caches live in the session scratchpad —
      keep them somewhere persistent or re-download ~180 MB + ~5.5 GB).
      MANIFEST FACTS (answering RELEASE.md's "a real build's merged
      manifest" unknowns): applicationId com.anonymous.shibawallet (no
      Expo login → com.anonymous.<slug>; cannot collide with
      host.exp.exponent); android:allowBackup="false" with
      fullBackupContent=@xml/secure_store_backup_rules and
      dataExtractionRules=@xml/secure_store_data_extraction_rules
      (sharedpref included except SecureStore); RECORD_AUDIO,
      READ_MEDIA_IMAGES, READ/WRITE_EXTERNAL_STORAGE reported REJECTED by
      the merge; release permissions CAMERA, INTERNET, SYSTEM_ALERT_WINDOW
      (Expo's template, kept), USE_BIOMETRIC, USE_FINGERPRINT, VIBRATE,
      ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE, DETECT_SCREEN_CAPTURE,
      DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION and — NOT in RELEASE.md —
      com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE
      (installreferrer 2.2 via expo-application); debug-only
      CHANGE_WIFI_MULTICAST_STATE and usesCleartextTraffic; ML Kit barcode
      + Google datatransport (CCT) components and
      androidx.credentials.playservices present (data flow unverified;
      PRIVACY.md follow-up); leftover expo.modules.updates.* meta-data; no
      Android usage strings (iOS only); FLAG_SECURE is runtime, not
      manifest. RUNNING THE DEBUG BUILD: the Expo dev launcher, connected
      by deep link to Metro on 8082 (1,834 modules); dev menu present,
      LogBox not seen; ReactNativePasskeysModule compiled in (classes2.dex).
      (a) SCREEN CAPTURE OUTSIDE EXPO GO — PROVEN: on a fresh throwaway
      wallet's Backup screen `adb exec-out screencap` returned 0 bytes,
      the window flags show SECURE, a system screenshot saved an all-black
      PNG (deleted), and the flag covered the recents view and the Confirm
      screen while Backup was mounted; Home captured normally again (the
      Settings reveal not tested — forbidden tap). (b) ANDROID BACKUP
      (W18, developer.android.com/identity/data/testingbackup): cloud
      backup with LocalTransport → "Backup is not allowed"; D2D transfer
      in test mode → Success, ~7.7 KB — the app's preferences,
      WebViewChromiumPrefs, expo PersistentDataManager and two dev-only
      files; SecureStore.xml (mnemonic.v1, vault-meta.v1,
      public-account.v1.0) and AsyncStorage's RKStorage were NOT
      included; transports and settings restored afterwards. (c)
      PASSKEYS: the gate takes the rp-id-unset branch; COPY FINDING —
      PASSKEY_GATE_NOTE says "Expo Go does not contain the native passkey
      module", which is wrong inside a development build; Credential
      Manager exists on this image (credential_service = GMS
      PasswordAndPasskeyService, GMS 23.18.18) but the device has 0
      accounts, so a create would most likely fail (not attempted). (d)
      WEBVIEW: com.google.android.webview 113.0.5672.136 (May 2023) —
      very old for the dApp browser pass; record what Uniswap does with
      it. (e) RELEASE APK, files only: Hermes bytecode magic c61f bc03,
      no DevLauncher / DevMenu / DevSettings entries, not debuggable, no
      cleartext; signed with the template debug keystore; not run.
      INCIDENT: at 00:53 the AVD's system_server was killed by the
      watchdog ("Blocked in monitor … InputManagerService … for 66s")
      while the release Gradle build ran beside scripted input, then
      crash-looped (composer HAL at 100% CPU); `adb emu kill` and a cold
      boot with -no-snapshot-load recovered it — user storage unlocked,
      fingerprint still enrolled, Expo Go intact, nothing wiped. STANDING
      RULE ADDED: never run Gradle while driving the AVD. End state: dev
      build uninstalled, Metro 8082 stopped, 8081 untouched, the emulator
      cold-booted and sitting at the keyguard (PIN 1234 needed; Expo Go
      not open).
- [x] Item 2 — THE IN-APP BROWSER, PROVEN LIVE (2026-10-10; emulator,
      Expo Go, Metro worktree at 6f85488 with the engine built inside it
      and react-native-webview linked, 2,325 modules; WebView
      113.0.5672.136 / Chrome 113 of May 2023 renders Uniswap fully; no
      repo files edited; the page's console read through the WebView's
      debug socket, read-only). Apps screen: "Apps (test networks)",
      "Apps on Ethereum Sepolia (test network)", the two cards with
      "Why it is listed", the residuals box ("What this test build cannot
      yet prevent. On Android, a page opened here can use the camera
      without asking… Fixing these needs a native build of the wallet."),
      no URL field. UNISWAP: bar "https://app.uniswap.org", "Not connected
      · Ethereum Sepolia (test network)", the bridge heuristic line
      ("…uses the newer message channel…"); the page logged "Detected
      injected providers: Array(1)" — the provider was present before its
      scripts ran (B4 held); its picker listed "Shiba Wallet — Detected"
      (EIP-6963); the sheet "Connection request" with the identity line
      "Opened in this wallet's browser: the request came from
      https://app.uniswap.org, as reported by the web view (not a name the
      site gives itself). This confirms which site asked, not that the
      site is safe." and nowhere "Verified by WalletConnect"; one prompt
      "Connect to app.uniswap.org"; bar "Connected as 0x772e…F44F ·
      Ethereum Sepolia (test network)"; record "eip155:11155111 · 4
      methods"; the first connect took ~2 min end to end, mostly
      Uniswap's own backend (401s from its gateway, a 40.6 s
      "hasMismatch" delegation check across ~23 mainnet chains); a
      reopened page reconnected silently with 0 prompts. SWAP 0.0001 test
      ETH → USDC (Uniswap's testnet mode; its own low-balance warning
      passed): sheet "Transaction request" with the TESTNET badge, "FROM
      DAPP app.uniswap.org", "SENDING ACCOUNT Account 1", TO
      0x7E4f…043f3 (the Universal Router), 1306-byte calldata, max fee
      0.000000147798616134, preview "You send 0.0001 test ETH" / "You
      receive 5.286847 USDC", risk card "goes to a contract", "Pre-flight
      simulation passed (eth_call)"; one prompt "Approve transaction for
      app.uniswap.org"; the hash went back to the page ("Transaction
      sent"); tx
      0xddb89eb9fc5d162bce7ca85a1a067642958d9660b228fce2df07c2df122725cd,
      block 11882561, status 0x1, value 1e14 wei, USDC Transfer 5,286,847
      base units to Account 1 = the preview to the unit, gas 144,323.
      SIWE on app.ens.dev ("Verify your wallet" → "Sign in with Wallet"):
      sheet "Sign in to app.ens.dev", card "Sign-In with Ethereum
      (EIP-4361)", SITE "app.ens.dev (https assumed — no scheme given)",
      the account, "Ethereum Sepolia (test network) (chain ID 11155111)",
      URI https://app.ens.dev, version 1, "No expiry set", "MESSAGE
      (EXACTLY WHAT IS SIGNED)", NO mismatch gate; one prompt "Sign for
      app.ens.dev"; the ENS modal closed (the FIRST live SIWE login
      through the wallet; Uniswap offers none). app.ens.dev's connection
      sheet listed the 7 requested methods and "CONNECT AS Regular
      account (EOA) / Smart account (Kernel v3.3)". DISCONNECT from
      Connections ("Disconnect? End the connection with
      app.uniswap.org?"; 0 prompts; notice "Connected apps —
      app.uniswap.org disconnected."); a reopened page showed Connect.
      LOCK HOLD: with a second swap's sheet pending, 78 s in the
      background → only "Shiba Wallet is locked…" visible (the compressed
      accessibility dump listed only the lock texts); Unlock (1 prompt) →
      the sheet reappeared re-quoted; Reject → nonce unchanged at 15.
      EXTERNAL LINK (Uniswap → Developers): "Open outside the wallet?
      uniswap.org is not on this wallet's list of apps… Open it in the
      phone's own browser instead? The wallet is not connected there."
      with the full URL; Cancel stayed on the page. MODE CHANGE: Base
      Sepolia → "Apps on Base Sepolia (test network)", Uniswap "Not
      connected", the Sepolia connection not served, no prompt; mainnet →
      Home hides Apps, Settings shows only the test-networks-only card.
      5 prompts in total, each titled as above. Funds: Account 1 EOA
      0.00282 → 0.00272 ETH, 30.6 → 35.886847 USDC, nonce 14 → 15;
      nothing from the dev EOA. FINDINGS (fix slice dispatched): (1) no
      route keeps a page open while reaching Settings or Connections (the
      page is the Apps screen's local state; "Manage connections" exists
      only on the list view), so the in-page chainChanged /
      accountsChanged([]) paths (notifyContextChanged) cannot be
      exercised from the UI — steps 6 and 9 checked only what a reopened
      page sees; (2) the "Connected apps — … disconnected." notice covers
      the browser bar's Back / Reload / Close until dismissed; (3) the
      screen listing "In-app browser connections" is titled
      "WalletConnect" and the Settings blurb says "Open connections"; (4)
      while locked, a FULL uiautomator dump still contained the bar text
      and the WebView's virtual nodes ("Connected as 0x772e…", "Sell
      0.0001 ETH…") although the compressed dump showed only the lock
      screen — the WebView's accessibility subtree may not honour the
      lock overlay's no-hide-descendants; TalkBack itself untested; (5)
      dev only: the "Cannot connect to Expo CLI… Error: undefined" toast
      once more; (6) the AVD slowed late in the run (~215 MB RAM free).
      UNVERIFIED: live chainChanged / accountsChanged on an open page;
      the Permit2 card (an ETH-input swap needs none); B5; cross-origin
      iframe drops; the native bridge path; TalkBack under the lock; iOS.
      End state: Home, Ethereum Sepolia, Account 1, light mode, Google
      IME, no browser connections; Metro at 6f85488; the emulator's
      screen_off_timeout was left at 1800000 (previous value not
      recorded).
- [x] Browser-pass findings FIXED (commit 9d1e0b3; check-browser 299 (was
      260), check-devmode 261; offline runner ALL GREEN in the CTO's
      isolated worktree: engine 877, app 6,159 across 45 suites, lint
      0/0, tsc clean; mutants caught; not seen on a device). (1) The
      bar's new "Connection" button opens an IN-SCREEN panel (served /
      stored-elsewhere / none wording; "Disconnect <host>" with the same
      confirmation as the connections screen, through the context's
      disconnect(browserTopicFor(origin)) → the bridge's disconnectSession
      → notifyContextChanged, so the OPEN page receives accountsChanged([]);
      a network note; "Open Settings" and "All connected apps" push those
      screens ON TOP of the page, which stays loaded — React Navigation
      7's StackRouter pushes a new route and native-stack 7.19.2 documents
      freezeOnBlur false, so the existing effect on evmChain.caip2 sends
      chainChanged + accountsChanged([]) while Settings shows, and a
      focus effect repeats notifyContextChanged on return sending only
      differences); mainnet still replaces the page with the readiness
      card; an account switch still closes it (the navigator is rebuilt);
      a second Apps page opened from Settings no longer silences the
      first (re-attached and reloaded on focus); browserBarConnection()
      helper. (2) WalletConnectContext exposes visibleNotice /
      dismissVisibleNotice / claimInlineNotices and ConnectedAppsNotice
      {floating | inline}; the focused Apps page claims the notice and
      draws it below the bar; elsewhere the floating notice is unchanged.
      (3) Screen title "Connected apps" (the screen sets it; the CTO
      aligned App.tsx's registered title and the watch-only refusal
      label), headings "Connect a dApp with WalletConnect" /
      "WalletConnect connections", empty line "No dApps are connected
      through WalletConnect.", the browser section hint and the Settings
      blurb name the real buttons. (4) ACCESSIBILITY UNDER THE LOCK —
      facts: RN's no-hide-descendants makes services "ignore the
      component and all of its children" (reactnative.dev/docs/
      accessibility) but Android's FLAG_INCLUDE_NOT_IMPORTANT_VIEWS still
      reports such views to a full dump, so the dump alone does not show
      what TalkBack would read; react-native-webview 13.16.1 has no
      accessibility prop or code on Android and whether Chromium's
      virtual nodes honour an ancestor's importance is undocumented; RN
      0.86.3 maps display:'none' to View.INVISIBLE on Android
      (SurfaceMountingManager.kt) / hidden on iOS, and AOSP
      ViewGroup.addChildrenForAccessibility adds only VISIBLE children —
      so LockGate's always-rendered wrapper is now also display:'none'
      while locked (nothing remounts) and BrowserScreen (useAppLock)
      hides its whole page with the web view marked no-hide-descendants +
      accessibilityElementsHidden; the web view stays MOUNTED so the
      bridge and the lock hold survive. While locked, a queued signing
      request gets no answer (declined 4001 after unlock as before);
      READS and local methods are still answered while locked (no
      approval needed; left as is — CTO's call to hold them too).
      UNVERIFIED (device): whether Android delivers injectJavaScript to a
      web view under Settings at once or on return; that the full dump
      drops the nodes under the lock; TalkBack / VoiceOver; nothing
      visible on unlock; the wrapping four-button bar, the panel and the
      inline notice on a narrow screen; Uniswap's reaction to a hidden
      web view and to the re-attach reload. An emulator re-check of the
      disconnect, the network change and the locked dump is dispatched.
- [x] Browser fixes RE-CHECKED ON THE EMULATOR (2026-10-10; Metro at
      53e2258, 2,323 modules; provider events watched through diagnostic
      console listeners on the page; no transactions; 3 prompts in total:
      "Connect to app.uniswap.org" twice, "Unlock Shiba Wallet" once).
      PASSED: (2) disconnect from the bar's Connection panel → the page's
      accountsChanged([]) within ~2 s, Uniswap dropped to its Connect
      button with no reload (performance.timeOrigin unchanged), the
      inline notice below the panel covered no bar control; (3) a network
      switch made with Settings pushed over the page → the page received
      chainChanged "0x14a34" and accountsChanged([]) WHILE Settings was
      up, nothing duplicated on return, Uniswap showed Connect; switching
      back → chainChanged "0xaa36a7" and accountsChanged([address]) 34 ms
      later, a silent reconnect with 0 prompts; (4) the FULL uncompressed
      dump under the lock held 25 nodes and only the lock texts (0 hits
      for "Connected as", "app.uniswap", "Sell", "Reload", 0x772e,
      webview); unlock → the page identical, still connected, no new
      events, nothing visibly changed anywhere; (5) "Connected apps"
      title, the browser section with its hint, the WalletConnect
      headings, a disconnect there reached the open page in ~1.4 s. BUG
      FOUND AND FIXED (commit 483ac9a; check-browser 301; offline runner ALL
      GREEN in the CTO's isolated worktree: app 6,161 across 45 suites):
      after a network switch the bar read "Connected as … · Base Sepolia"
      and the panel kept the served wording although the page had
      eth_accounts [] on 0x14a34 (and the reverse on switching back) until
      any re-render — notifyContextChanged delivered the events but never
      bumped the bridge version; it now bumps it whenever an event is
      delivered (a repeat with nothing new bumps nothing, pinned), and the
      bar shows "Connected as Account 1 (0x772e…F44F)" like the panel.
      OTHER FINDINGS: the four-button bar wraps Close onto a second row at
      1080 px and the panel shrinks the web view to ~40% (layout,
      follow-up); PRIVACY — the Android recents thumbnail taken at HOME
      shows the full page, the bar's address and Uniswap's balance, and
      the lock screen does not cover the app-switcher snapshot (the seed
      screens' FLAG_SECURE does blank it; an app-wide "hide in the app
      switcher" option would set the flag on every screen — a product
      decision, related to N-05 for iOS); the WebView debug socket is
      reachable in Expo Go despite webviewDebuggingEnabled false (the
      library enables it under DEBUG — dev builds only); the Settings
      button "Open connections" opens the screen titled "Connected apps"
      (consistent with the blurb, label ≠ title). UNVERIFIED: TalkBack /
      VoiceOver under the lock; the mainnet switch closing an open page;
      the second-Apps-page re-attach path; app.ens.dev this pass; iOS.
      End state: disconnected, Home, Ethereum Sepolia, Account 1, light
      mode, Google IME; Metro at 53e2258.

## Phase 16 status (2026-10-10)

Items 1 to 3 are landed and pushed; item 4's documents are current
(FEATURE_UNIVERSE row 79 proven live, DEMO step 21, THREAT_MODEL T-71 /
F-67, the shareable page at version 14: 41 proven live, 18 built, 1
designed, 39 not started). Proven live this phase: the in-app browser
against Uniswap (EIP-6963 detection, a connection and a swap through the
shared approval sheet with the preview matching the chain) and a
Sign-In with Ethereum on the ENS app, plus the re-check of the open
page's disconnect, network change and locked state; a local development
build on the emulator with no Expo account (screen-capture blocking
outside Expo Go, cloud backup refused, device-to-device transfer without
key material, the real merged manifest). Delivered: docs/
DISCLOSURE_FINDINGS.md with two overstated items corrected across the
record. Engine: 877 tests. App: 45 offline suites, 6,161 checks.

Waiting on the Chairperson: confirmation of the findings document and
whether item (d) is withdrawn; whether the list goes to ZeroDev /
Offchain Labs; whether an app-wide "hide in the app switcher" option is
wanted.

Follow-ups (no inputs): the browser bar layout at phone width; TalkBack
on the emulator (enable it through settings and read the lock screen);
a passkey create attempt in a dev build with a Google account signed in
on a disposable AVD, once an rpId domain exists; PRIVACY.md entries for
ML Kit / datatransport once their data flow is read from source; the
"Open connections" label.

DECIDED by the Chairperson (2026-10-10): an app-wide "hide in the app
switcher" protection is wanted, erring on caution because the wallet is
meant for real value; the CTO's caveat stands — on Android the secure
flag also blocks screenshots and recording of every screen, so it ships
ON by default with a Settings toggle that says what it blocks, and
emulator passes turn it off first. The Chairperson is reviewing
docs/DISCLOSURE_FINDINGS.md.

## Phase 17 plan (started 2026-10-10 on "start working on next phase"): the account types people share, and the wallet that tells you when

Selection rule as before: features not started or built-only that need
no outside input and can be shown on the emulator (Expo Go, or the local
development build proven in phase 16), with the AA differentiator first.

0. App-wide screen protection (the decision above): expo-screen-capture
   applied at launch (Android secure flag; iOS screenshot block and the
   app-switcher cover), default on, Settings → Privacy toggle with plain
   copy about screenshots and recording, the seed screens unchanged;
   verified from the installed module's source, then on the emulator
   (recents thumbnail blank, screencap empty everywhere while on).
1. Multi-signature accounts in the app (feature 24, the engine from
   phase 15): a new account type created by DEPLOYING FRESH (never
   converting), co-signer approvals collected off-device as request /
   approval JSON by QR or file like guardian recovery, the exposure and
   the "cannot sign messages, logins or permits" statement on every
   screen, co-signers approve calls + nonce but not fees, test networks
   only (readiness row), guardian recovery refused on a weighted root;
   proven on the emulator with the dev seed's signers through a script
   as in phase 10.
2. Local notifications for things that fall due (features 93 partial,
   83 groundwork): expo-notifications LOCAL notifications only (no push
   service, no account) — a recurring payment due, a subscription slot
   open, a guardian or heir takeover attempt detected, an auto-lock
   reminder off by default; scheduled from the data the app already
   reads, tap opens the right screen; verified in Expo Go where it
   supports them and in the local development build otherwise.
3. Custom EVM network addition (feature 33; requirement 4's
   flexibility): add a network by chain id + RPC + explorer with the
   same verify-before-save discipline as every endpoint (eth_chainId,
   freshness), a user-added chain treated as MAINNET by the readiness
   switchboard unless its id is a known test network, tokens / AA / the
   browser scoped per chain as today, removal with its data.
4. Transaction notes and receipts (feature 87): a private note per
   transaction stored on-device, shown in Activity and on the success
   screens, exported with the Activity list as a plain file.
5. Research only: native and liquid staking on a test network
   (features 57/58) — which protocols run on Sepolia / Hoodi, what a
   smart-account staking flow would need; a document, no code.
6. Leadership refresh at the end.

Waves: 1 — item 0 (Settings/prefs/App.tsx owner), item 1 (new screens +
aa.ts), item 4 (activity files) in parallel; 2 — item 3 (Settings/prefs
after item 0) and item 2 (App.tsx after item 0) with item 5's research
alongside; emulator passes after each wave. Subagents on Opus.

## Phase 17 progress
- [x] Item 0 — APP-WIDE SCREEN PROTECTION, ON BY DEFAULT (commit 6e1106f;
      new check-screen-protection 87; offline runner ALL GREEN in the
      CTO's isolated worktree with only this slice: engine 877, app 6,248
      across 46 suites, lint 0/0, tsc clean; six mutants caught; not yet
      on the emulator). FACTS from expo-screen-capture 57.0.4 (file:line
      in the code comments): src/ScreenCapture.ts keeps a module-level
      SET of active keys — preventScreenCaptureAsync(key) calls native
      only for a key not yet held, allowScreenCaptureAsync(key) calls
      native allow only when the set is then EMPTY (keys are recorded,
      not counted); usePreventScreenCapture = prevent on mount / allow on
      unmount with key 'default' (BackupScreen); Android: FLAG_SECURE on
      the activity window (ScreenCaptureModule.kt:87–93; MissingActivity
      without one; the flag also blanks the recents preview, and RN
      0.86.3 copies FLAG_SECURE onto a Modal's dialog when it is created,
      ReactModalHostView.kt:334–341 — which CORRECTS the earlier
      DEVICE_BUILDS claim that Modals do not inherit it); iOS: prevent
      moves the key window's layer into a secure-entry text field's canvas
      (screenshots blank), a black view covers recording/mirroring,
      enableAppSwitcherProtectionAsync (iOS-only; Android throws
      UnavailabilityError) adds a light blur on willResignActive —
      passed at intensity 1.0; web: prevent throws; iOS Expo Go
      unverified. DESIGN: app/src/wallet/screen-protection.ts (Node-
      loadable state machine with the native calls injected; dynamic
      imports only) holds the distinct key 'app-wide' (the seed keys are
      'default', 'seed-reveal', 'subscription-key', 'import-private-key',
      'imported-key-reveal'; the check script scans app/src so nothing
      else uses 'app-wide'), so a seed screen's release cannot drop it and
      turning off cannot unprotect an open seed screen; PROTECT FIRST —
      the first update, before the preference loads, counts as on and a
      stored "off" then releases (a brief protected moment beats every
      default user unprotected while loading); native calls serialized,
      the latest setting wins; a failure → a red status line in Settings,
      retried on every foreground and whenever Settings shows (a failed
      module load not cached). PrefsContext screenProtection (default
      true; a non-boolean stored value reads as on); App.tsx mounts a
      6-line ScreenProtection component first inside PrefsProvider;
      Settings "Privacy" section with the switch "Hide in the app
      switcher and block screenshots", the note "On Android this also
      blocks screenshots and screen recording of every screen in this
      wallet, including your Receive QR; copy the address instead. On iOS,
      screenshots come out blank and the app switcher shows a cover." and
      "The screens that show or take in your recovery phrase or a private
      key are always protected, whatever this setting." (the agent's
      review found that the Import screen and the backup quiz had NO
      capture key — the CTO gave them 'import-phrase' and 'backup-quiz'
      in this commit so the sentence is true), status lines "Screen
      protection is on/off", the two failure sentences with technical
      detail. DEMO.md and DEVICE_BUILDS.md note that the toggle must be
      OFF before screenshots or recordings. UNVERIFIED (emulator pass
      next): the recents thumbnail blank, screencap empty on Home while on
      and not while off, the seed screens blank while off, modals blank
      while on; activity recreation (a new window would not get the flag
      again — the library ignores a repeat prevent with a held key);
      native alerts and system dialogs not covered; iOS. STALE TEXT to
      fix with the next owners' slices: readiness.ts W19 wording (~line
      233) and DEVICE_BUILDS item 8 / N-05 say there is no app-switcher
      cover. STANDING EMULATOR RULE ADDED: turn Settings → Privacy off at
      the start of a pass that needs screenshots, and back on at the end.
- [x] Item 5 — docs/STAKING.md, staking on test networks (commit below;
      about 5,700 words; secret scan clean; every on-chain figure a
      read-only call on 2026-10-10 through keyless PublicNode endpoints).
      DEPLOYMENTS: Lido on ETHEREUM SEPOLIA (lidofinance/docs 140c583d)
      — stETH 0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af (symbol
      "stETH", implementation Sourcify exact), wstETH
      0xB82381A3fBD3FaFA77B3a7bE693342618240067b (exact), withdrawal
      queue 0x1583C7b3…5fdd ("unstETH", isPaused() true, never a
      request) — Lido calls it "fully deprecated", the oracle's last
      report was 2025-07-02 so test stETH earns NOTHING, but staking is
      OPEN (limit 150,000 ETH; a simulated 0.01 ETH submit minted
      9,999,999,999,999,999 stETH; a real Submitted event on 2026-10-09);
      Lido on HOODI fully working (stETH 0x3508A952…176a, wstETH
      0x7E99eE3C…4De4 exact, queue 0xfe565731…9186; oracle report today;
      all 5,320 withdrawals finalised); Rocket Pool on HOODI
      (rocket-pool/smartnode 8c1dad70: RocketStorage 0x594Fb75D…d4E1,
      rETH 0x7322c247…64F1, deposit pool 0x425E6f83…3Fd8; min 0.01 ETH,
      fee 0.05%, a simulated deposit succeeded; rETH locked 5,760 blocks
      after a deposit); NOTHING on Base Sepolia or Arbitrum Sepolia;
      StakeWise documents Hoodi only (not read on-chain). NATIVE STAKING:
      Sepolia's validator set is permissioned (its deposit contract is
      the "BEPOLIA" token); the L2 testnets have no beacon chain and no
      Pectra predeploys; EIP-7002 / EIP-7251 predeploys are live on
      Sepolia and Hoodi (fee 1 wei); a smart account as withdrawal
      address is reasoned from the EIPs, not exercised, with the caution
      that Kernel v3.3's factory, implementation and CallPolicy have NO
      code on Hoodi. RECOMMENDED SLICE: "Stake test ETH with Lido on
      Ethereum Sepolia", stake-only — one call submit(address(0))
      (0xa1903eab) with the ETH as value, through prepareEvmSend for the
      regular account and prepareAaCalls for the smart account (no engine
      change), the preview showing the stETH minted, Lido's risk
      statement quoted, plain "deprecated, no rewards" lines, unstaking
      refused after a live isPaused() read, test networks only behind a
      readiness row; a Hoodi profile is a separate larger decision (the
      only place to show rewards, withdrawals and Rocket Pool; regular
      account only at first). AA FINDINGS: staking calls are unusually
      safe for a session key — submit, the wstETH ETH shortcut, Rocket
      Pool deposit(), claimWithdrawal and rETH burn pay only msg.sender,
      so a CallPolicy-pinned key can at worst turn the account's ETH into
      its own stETH within the caps (batching and the fee budget still
      apply); a one-element requestWithdrawals looks pinnable (reasoned);
      sponsored staking (59) needs the ZeroDev gas policy input; GAS FROM
      YIELD (60) has nothing to stand on — Circle takes USDC only,
      Pimlico documents stETH/wstETH on main networks only (keyless
      pimlico_getSupportedTokens: USDC, PIM, EURe, USD₮ on Sepolia; empty
      on Hoodi), and no deployed policy can limit a keeper to yield rather
      than principal; stETH rebasing: simulated transfers delivered 1 wei
      less than the Transfer event reported, so the preview can overstate
      by up to 2 wei (Home reads balanceOf). UNVERIFIED (section 9): the
      Hoodi implementations' bytecode-to-source, Rocket Pool head vs
      deployed, any live transaction, the pinning rules, withdrawal
      times, ZeroDev on Hoodi, why submit used 208k gas on Sepolia vs 94k
      on Hoodi. DECISION FOR THE CHAIRPERSON: build the stake-only
      Sepolia slice (cheap, honest, no rewards to show) and/or add a
      Hoodi profile (rewards and Rocket Pool, but no Kernel there).
- [x] Item 4 — TRANSACTION NOTES AND AN ACTIVITY EXPORT (commit cba1d0c; new
      check-notes 174; offline runner ALL GREEN in the CTO's isolated
      worktree with only this slice: engine 877, app 6,422 across 47
      suites, lint 0/0, tsc clean; mutants caught — sanitiser removed 19
      checks, formula defusal removed 11, unloaded notes exported 3; not
      seen on a device). KEY RULE (app/src/wallet/notes.ts): CAIP-2 +
      transaction id (hex lowercased; Solana signatures exact; eip155 /
      bip122 / solana only), not tied to an account; a smart-account note
      saved before the receipt lives under op:<userOpHash> and moves to
      tx:<hash> via linkUserOperation (keeping the userOpHash) when the
      bundle hash arrives; findNote tries the transaction id then the
      row's decoded userOps, so a note whose receipt timed out still
      shows once the row decodes; an existing tx-id note is kept, never
      merged. STORE shiba-wallet.tx-notes.v1 (strict parse: any bad
      record makes the whole store read-only with the readable notes
      shown and writes refused with NOTES_READ_ONLY_MESSAGE; "Reset
      notes" on Activity; one write queue; MAX_NOTES 2,000 — a
      judgement); sanitiser: line breaks and tabs → spaces, then the
      shared sanitizeDisplayName, then 280 code points; an empty result
      removes the note; the CTO added the wipe line in WalletContext
      (wipeTransactionNotes after forgetBrowserConnections). UI: "Note
      (private, this phone only)" on both Send success views and per
      Activity row ("Add note" / "Edit note", editor with "N / 280",
      "Save note" / "Remove note" / "Cancel"), the privacy line "Notes
      are kept only on this phone. They are not sent anywhere, not backed
      up by your recovery phrase and are deleted when the wallet is
      wiped. Hide amounts does not hide them." EXPORT: "Export activity
      (.csv)" — RFC 4180 (every field quoted, quotes doubled, CRLF),
      OWASP CSV-injection defusal (a leading apostrophe on any cell
      starting with = + - @ tab CR LF — every cell, so indexer-supplied
      symbols too), columns network / date (UTC; "pending" / "block N")
      / direction ("Sent (failed)") / amount / asset / fee / FEE ASSET
      (an 11th column so a fee is never read in the token's units) /
      counterparty (from decodes in memory; no network requests) /
      transaction id / explorer URL / note; exact strings via formatUnits;
      MIME text/csv, UTI public.comma-separated-values-text (checked in
      the macOS SDK); file shiba-activity_<caip2>_<short>_<date>.csv with
      the 60 s delete-after-share rule in its own directory; the note
      says it exports the loaded entries only and contains addresses,
      amounts and notes in clear even under Hide amounts.
      RecordFileActions gained a generic shareTextFile (lazy name and
      contents; the recovery-record path byte-identical). FOLLOW-UPS: a
      TransactionNoteField component for the Swap, WalletConnect and
      Sessions success views; no UTF-8 BOM (Excel may misread non-ASCII
      notes); spreadsheets may round 18-decimal amounts on import.
      UNVERIFIED (emulator): the editor modal (layout, keyboard, dark
      mode), Done-with-keyboard-open saving, the AA note → link → Activity
      path, the focus reload after Send, the Android share sheet with
      text/csv, TalkBack on the note bar.
- [x] Item 0 PROVEN ON THE EMULATOR (2026-10-10; Metro at 072e744, 2,315
      modules; 1 prompt — Unlock; nothing sent). With protection ON
      (default, on a wallet that had never seen the preference) every
      screencap was 0 bytes — Home, Settings, the account-switcher modal
      (its dialog window carries SECURE too, confirming the RN
      FLAG_SECURE copy), the lock screen and Home after unlock; the
      window flag line read "…FORCE_NOT_FULLSCREEN SECURE…"; the recents
      thumbnail was a blank card. OFF: screencaps worked (Settings
      255,132 bytes, Home 215,652), SECURE gone, and the recents
      thumbnail showed the whole Home with balances — the control that
      proves the blank card comes from the flag. The Import-a-private-key
      screen is protected only while its field holds text (by design;
      ImportKeyScreen.tsx 59–65). A stored "off" survived a force-stop
      relaunch: the splash (no data) ~60 s, ONE sample with SECURE at
      t+101 s (the protect-first moment, under ~5 s), then Home captured
      normally. Settings → Privacy copy exactly as pinned; "Screen
      protection is on/off" statuses. FINDINGS: (1) dev-only but it gets
      in the way — all 5 LogBox warnings at launch (PushNotificationIOS,
      InteractionManager, Clipboard, SafeAreaView, ProgressBarAndroid)
      come from screen-protection.ts's `void import('react-native')` (a
      namespace import reads every deprecated getter); the toast covers
      the bottom of every screen — fix: import only AppState / Platform;
      (2) copy — "always protected" is slightly too broad for the
      import-key screen (protected once the field has text); (3) copy —
      neighbouring sections "Privacy & security" and "Privacy"; the
      switch's label leads with the app switcher while on Android its main
      effect is blocking screenshots. UNVERIFIED: screenrecord, activity
      recreation, native alerts and system dialogs, the biometric prompt
      window, the seed screens with protection off, iOS; the 2,315 vs
      2,323 module difference.
- [x] Items 1 and 2 — MULTI-SIGNATURE ACCOUNTS IN THE APP and LOCAL
      REMINDERS (one commit, b1010bc, because the two slices share
      App.tsx, SettingsScreen and recovery.ts; verified as one snapshot in
      the CTO's isolated worktree: engine 877, app 6,687 across 49
      suites — check-multisig 155 and check-notifications 98 new —
      lint 0/0, tsc clean; 17 mutants caught; not yet on the emulator).
      ITEM 1 (feature 24, readiness row `multisig` testnet-only enforced;
      evidence C1 C2 C3 W9 F-21 F-62 T-70): a multisig is a NEW account
      type DEPLOYED FRESH — no conversion path ("…Kernel keeps the old
      single-key validator installed when the root signer changes, so a
      converted account would still obey one key, a backdoor around the
      co-signers."); signer set = the active phrase account's EOA + 1–9
      co-signers (weights 1–100; app policy: every operation needs at
      least two signers, so threshold 1 or a lone-sufficient weight is
      refused; another account of this wallet allowed with a warning;
      imported / watch-only cannot be the wallet's signer); CREATE2 index
      0 unless this phone already holds a multisig with the same set and
      threshold on that network (chooseMultisigIndex), so anyone knowing
      the set can recompute the address, order-independent, same on every
      chain; ids 0xD0000000 + slot, never reused, refused by
      derivationArgsFor / smartAccountSaltFor / assertAccountCanSign / the
      imported and watch-only helpers / createAaClient /
      createAaClientFromConfig (MULTISIG_CONFIG_BUNDLE_REFUSAL, zero
      requests); bundle type 'kernel-multisig' built only by
      createMultisigAaClient (engine createKernelMultisigSpec, the local
      signer as submitter; self-paid only: no paymaster, no token fee),
      the first operation carries the deployment through the ordinary
      prepareAaCalls / checkAaQuoteBeforeApproval / sendAa path (a bundler
      refusal shown verbatim + MULTISIG_FUND_AND_RETRY); records in
      shiba-wallet.multisig.v1 (secret-free; chain, address, signers,
      threshold, index, pinned deployment addresses, local signer,
      deployed facts, operations with request id / approval ids =
      keccak of each signature / userOpHash / tx; address recomputed on
      load, mismatched or non-pinned records dropped; damaged list
      refuses writes); export/import as typed JSON (import needs one of
      this wallet's phrase accounts as a signer); request payload = the
      engine request + account facts + calls (the co-signer side
      re-derives every hash and re-encodes the calls to exactly the
      callData); approvals accepted as the app payload, the engine's bare
      JSON or a bare 65-byte signature, the share text carrying EIP-712
      typed data for other wallets; gate order on both paths: network
      checks → requireLocalAuth → signWith (tested with injected fakes).
      HONESTY STRINGS on every phase: exposure ("Any 2 co-signers together
      can send an operation; for messages the deployed validator needs
      only 1, so this account must never be used to sign logins, orders or
      token permits — the wallet refuses that."; weighted variant), fees
      ("Co-signers approve the calls and the nonce, not the network fee or
      paymaster, which the submitter sets."), the no-audit note, the
      engine's MULTISIG_ERC1271_REFUSAL, the fresh-deploy sentence, the
      readiness reason. REFUSED: WalletConnect and the browser never offer
      a multisig (createAaClientFromConfig refuses; signHashAsSmartAccount
      throws MULTISIG_ERC1271_REFUSAL first; aaAccountTypeSignsMessages
      false; walletConnectAddressFor null) — no WalletConnect file edited;
      guardians and inheritance (validation-id collision); passkeys and
      session keys (not offered); 7702 and owner change (not applicable).
      CTO edits: route Multisig (navigation.ts, App.tsx), the Home link
      (test networks), the Settings section with MULTISIG_SETTINGS_BLURB,
      resetMultisigRecords in the wipe, and the defence-in-depth
      'kernel-multisig' refusal in resolveGuardianAccount /
      resolveSessionAccount / resolvePasskeyAccount. FOLLOW-UP (optional):
      showing a multisig in the account switcher (AccountView.multisig,
      reconcileStoredMultisigAccounts at launch, EVM-only rows, approval
      target none, WatchOnlyGate multisigRouteRefusal, loadAaBundle null)
      — today it lives on the Multisig screen (Receive with QR, balance,
      Send-as-request). Scratch co-signer helper
      <scratchpad>/multisig-cosigner.mjs (address / approve / request /
      submit with the dev seed). UNVERIFIED: everything on a device;
      whether ZeroDev accepts a weighted-root deployment (phase 15 saw a
      prefund/fee decline); the on-chain reads ran against fakes; whether
      the weighted validator exists on Base / Arbitrum Sepolia. THREAT
      MODEL T-70 / F-62 still say "Nothing is in the app" — update at the
      refresh. ITEM 2 (feature 93 partial, 83 groundwork): FACTS —
      expo-notifications 57.0.22; the docs say local notifications remain
      available in Expo Go, but the package INDEX imports
      DevicePushTokenAutoRegistration.fx, whose addPushTokenListener calls
      warnOfExpoGoPushUsage which THROWS on Android in Expo Go (CHANGELOG
      #39459; Expo Go registers ScopedServerRegistrationModule), and a
      module throwing on load is fatal in Metro's require — so
      notifications.ts never imports the index: it dynamically imports
      ten individual build files after requireOptionalNativeModule
      confirms their native parts (the check script computes the
      transitive closure and proves it never reaches the .fx module,
      TokenEmitter, warnOfExpoGoPushUsage, the push-token functions or
      index.js; the export bundle holds none of the throw text); channels
      "payments-due" (default) and "security-alerts" (high) created before
      the permission request (Android 13 POST_NOTIFICATIONS); only the
      DATE trigger and an immediate trigger; the library re-arms on
      BOOT_COMPLETED / REBOOT / MY_PACKAGE_REPLACED (NotificationsService.kt
      33–39, 643–645) but nothing re-arms after a force stop (stated in
      the copy); exact alarms only with the exact-alarm permission, which
      is not requested (a reminder can be late); the same identifier
      replaces (FLAG_UPDATE_CURRENT); no config plugin added (the library's
      manifest declares POST_NOTIFICATIONS and RECEIVE_BOOT_COMPLETED);
      privacy: only getExpoPushTokenAsync and the auto-registration
      contact exp.host and neither is loaded; the Android library links
      firebase-messaging 25.0.1 with no google-services.json (should not
      initialise — unverified; PRIVACY.md 2.8 says so); the phase-16 local
      dev build must be REBUILT to include the native module. BEHAVIOUR:
      Settings → Privacy → Notifications, switch "Remind me when
      something is due" (default off; enable = channels → permission
      (asked once) → saved on only on success), three notes (what is
      reminded; "No notification service is used and nothing about them
      leaves the device. They say only what kind of event happened, never
      an amount, an address or a name…"; force-stop / not-included
      lines), statuses off / on / blocked / unavailable / failed; (a)
      "Recurring payment due" — "A recurring payment is due. Open the
      wallet to review it; nothing is sent until you confirm it." at the
      next slot after the open ones (never for payments already due — the
      banner's job), synced on start, foreground and leaving Sessions,
      with a network-free pass cancelling reminders for revoked / failed /
      forgotten records on every screen change and on background; (b)
      merchant subscriptions deliberately NOT reminded (the merchant
      pulls); (c) "Account recovery started" — "Someone started a recovery
      of one of your accounts. Open the wallet to review it, and veto it
      if you did not expect it." immediately, once per (network, account,
      proposal hash) with seen hashes in shiba-wallet.notifications.v1;
      FINDING — the existing takeover check runs only while the
      Inheritance screen is focused, so the alert fires for results the
      user did not see (polled while in front, re-read 20 s and 60 s after
      leaving, on background / foreground / screen change; enabling marks
      everything found as seen); (d) no auto-lock reminder (stated);
      tapping opens Sessions or Inheritance through the navigation ref
      (waits for ready on a cold start); foreground banner without sound
      or badge; wipe → preference off and every "shiba-wallet." identifier
      cancelled; identifiers are sha256-derived (no addresses or ids).
      PRE-EXISTING GAP noted: wipeRecoveryData does not clear the takeover
      scan state (shiba-wallet.inheritance.v1). UNVERIFIED (emulator, in
      Expo Go): the deep imports loading, the permission prompt and
      channels, delivery in background / closed, lateness, re-arm after
      reboot, force stop, tap navigation warm and cold incl. under the
      lock, the foreground banner, the lock screen, revoke cancelling, the
      takeover alert after leaving mid-check, TalkBack; a dev build making
      no FCM traffic.
- [x] Item 3 — CUSTOM EVM NETWORKS (commit 22b06e9; new check-custom-networks
      152; offline runner ALL GREEN in the CTO's isolated worktree: engine
      877, app 6,839 across 50 suites, lint 0/0, tsc clean; six mutants
      caught; the export bundles 2,223 modules; not seen on a device).
      READ PATH: evm-chain.ts (still import-free) holds a module-level
      registry (setCustomEvmProfiles refuses built-in ids, duplicates and
      profiles without custom facts; customEvmProfiles / allEvmProfiles /
      isCustomNetworkId / isCustomTestNetwork / subscribeCustomEvmProfiles);
      evmProfileByCaip2 / evmProfileFor check built-ins first, then the
      registry (an unregistered id still resolves to Sepolia); EVM_PROFILES
      lists only the four built-ins (pins unchanged); loadPrefs(store)
      first awaits ensureCustomNetworksLoaded(store) (read once per store
      object; a storage failure not cached; afterwards only
      custom-networks.ts's own writes update the registry and notify), so
      PrefsContext, networks.ts getEndpoint and tokens.ts
      activeTokenChain see custom profiles before resolving;
      prefs.testNetwork is now EvmNetworkChoice (a test profile id or a
      custom id, kept only while registered; sepolia:true still reads as
      Sepolia); PrefsContext exposes customNetworks and re-reads on every
      registry change; SAFETY FIX — the context's `sepolia` is now
      evmProfileFor(testNetwork).testnet, so a custom MAIN network never
      shows the TESTNET banner (pinned). FORM: name; chain id 1..2^53−1;
      one https RPC (assertSecureEndpointUrl); symbol 1–10 ASCII letters
      or digits ("The coin's symbol is your word: EVM networks do not
      publish their coin's symbol on-chain…"); decimals — ONLY 18 accepted
      (judgement: every EVM screen assumes 18, stated in the refusal);
      optional https explorer (host + path); the test-network switch.
      REFUSALS (exact strings pinned): chain-id format; built-in ("Chain
      id 11155111 is already built in as Ethereum Sepolia; choose it in
      the network list above instead. Nothing was saved."); duplicate; an
      unlisted id with the tick ("…is not on this wallet's list of
      well-known public test networks (Holesky (17000), Hoodi (560048),
      OP Sepolia (11155420), Polygon Amoy (80002), Linea Sepolia (59141),
      Scroll Sepolia (534351)), so it cannot be added as a test network:
      the wallet would then treat its funds as worthless and allow
      features that are switched off where funds are real…"); http URL;
      max 10 (judgement); a built-in or duplicate name; a main network
      with a test-like name (test / sepolia / holesky / hoodi / goerli /
      devnet / amoy). VERIFY: eth_chainId mismatch ("This RPC endpoint
      serves chain id 1, but you entered chain id 560048…"); stale or
      unreadable head (FRESHNESS_BOUND_SECONDS 600 via assessHeadFreshness:
      "The newest block this endpoint reports (block N) is M minutes old,
      more than the 10 minutes allowed…"); block time measured from head
      and head−100. ALLOW-LIST source: ethereum-lists/chains ec732e43,
      _data/chains/eip155-<id>.json, each a named testnet with slip44 1;
      readiness.ts isTestNetwork accepts TEST_NETWORK_CHAINS or a
      registered custom network with the tick AND on the list, re-checked
      on every call; every feature's allowed/refused result on a custom
      main network equals Ethereum mainnet's (asserted per feature).
      PROFILE: kernelV33Verified false / aaPrefill null (aaKernelPrefillFor
      drives the Settings pre-fill with a note), swapsOffered false,
      l1DataFee / l1CostInGas false with the note "…does not detect
      layer-2 fee models, so on a rollup quotes may be refused or
      underestimate the fee" and that explorer paths are assumed;
      explorerTxBase <base>/tx/ or '' (the CTO gated the explorer buttons
      on eight smart-account result screens — Guardians, Passkey,
      ApproveRecovery, OwnerRotation, Inheritance, Swap, Send, Sessions —
      on a non-empty base); a test network's symbol shows "test <SYM>"
      with the banner "TESTNET — Hoodi test mode is on (a network you
      added). Amounts are test ETH, not real funds."; a main network has no
      banner and a Settings WarningBox saying it is treated as a MAIN
      network; WalletConnect describeChain "Hoodi (a test network you
      added, chain id 560048)"; risk thresholds from the measured block
      time (7 days), none without a measurement; tokens and contacts per
      chain; prices and ENS never offered. STORE
      shiba-wallet.custom-networks.v1 (strict; damaged = read-only; "Reset
      custom networks" returns an active custom choice to mainnet).
      SETTINGS → Developer: "Networks you added" chips (item 0's style),
      per-network rows (facts, masked RPC, block-time line, Remove), the
      Add form with "Verify and save". REMOVAL: an active network switches
      to mainnet first; the confirmation names everything deleted and
      kept; a device check when spending limits for the chain would go;
      deleted only for that chain: tracked tokens, endpoint override
      (resetEndpoint returns a boolean), AA config (forgetAaConfigForChain),
      history and NFT indexer settings, contacts (forgetContactsForNetwork),
      notes, spending limits + history, browser connections, WalletConnect
      smart bindings and ERC-5792 records (forgetWalletConnectChainData);
      a failed step leaves the network listed and names the failure; NOT
      reachable: WalletConnect sessions (SDK storage; paused, disconnect
      under Connections); DELIBERATELY KEPT (stated): session keys and
      subscriptions, recovery records, inheritance state, passkey details,
      multisig records, notification seen-hashes — they describe on-chain
      state and are needed to revoke or recover; they return if the chain
      id is re-added. LIVE read-only probes: rpc.hoodi.ethpandaops.io
      with 560048 accepted (head 22 s old, 13.68 s per block);
      sepolia.optimism.io with 11155420 accepted but the head−100 read
      answered HTTP 503 (saved with no block time); Hoodi's RPC typed as
      17000 refused with the mismatch sentence. WORDING LEFT: 
      payment-request.ts names only built-in networks in its switch hint;
      walletconnect.ts unsupportedChainMessage says "…or on the chosen
      test network". UNVERIFIED: the form, keyboard, dark mode, chips,
      alerts and the dynamic imports under Hermes on a device; a dApp over
      WalletConnect on a custom chain; rollup fee behaviour on OP Sepolia.
      Emulator checklist (11 steps, Hoodi via rpc.hoodi.ethpandaops.io; a
      main-network case; OP Sepolia optional) in the builder's report.
- [x] Item 1 — MULTI-SIGNATURE ACCOUNTS PROVEN LIVE IN-APP (2026-10-10;
      emulator, Expo Go, Metro at 3eb00f1, 2,340 modules; 7 prompts, each
      expected; Privacy toggle off during the pass and back on after; the
      dev EOA untouched during the pass; every hash verified on publicnode).
      THE OPEN QUESTION IS SETTLED: ZeroDev's bundler ACCEPTED the
      weighted-root DEPLOYMENT from the app. Flow: Multisig screen (the
      fresh-deploy sentence, the "Not available for a multi-signature
      account" card with 8 bullets, the fees sentence, the ERC-1271
      refusal, the no-audit note; no readiness card on Sepolia) → Create
      with dev-seed 5 (0x69F0…7E8a) and 6 (0xCCB4…b107), weights 1,
      threshold 2 → "Multisig 1 (2-of-3)", CREATE2 index 0, address
      0x944caA404e389b18b2fe251e969EdD7A220d0d38 (= KernelFactory
      getAddress(initData, 0) on-chain; the QR decodes to the plain
      address); refusals exactly as designed (threshold 1 → "…one signer
      alone could send operations…"; own address → "Co-signer 2 is this
      wallet's own signer…"; bad checksum). Funded 0.002 from Account 1
      (tx 0x58226ca94754521cd07e10e8092c08f72231162da6f9773ea7a3517caa57dcde,
      block 11885161 — NOTE: a plain transfer to a never-used address now
      costs 204,600 gas on Sepolia after Glamsterdam (EIP-2780 / 8037);
      the app's estimate was 207,391, correct; a later transfer to the same
      address used 21,000). OPERATION 1 (0.0001 test ETH to Account 2,
      nonce 0, carries the deployment): request
      0xa8bf3dc1…f9d7a2 (the QR decodes to the request JSON; the copy
      text carries EIP-712 typed data for other wallets); the weight bar
      reads "Approvals: weight 1 of the threshold 2" with "✓ This wallet's
      signer … (weight 1, signs last when you submit)" BEFORE any approval
      and 2 of 2 after dev5's (the wallet's own weight is counted before
      it signs — a design point to decide); duplicate → "An approval from
      0x69F0… was already added."; dev7 → "0xFDF5… is not a signer of
      this multisig" (the engine's own refusal; the helper refuses first).
      The first Review hit AA21 with the smart-account funding text: a
      weighted-root deployment estimates verificationGasLimit 2,707,397
      / 2,788,290 gas in total, so at the 2.31 gwei quote (ZeroDev's
      standard 1.155 gwei × 2) the worst case was 0.0066 ETH against
      0.002; two submits quoted during momentary 1 Mwei readings were
      refused BEFORE the prompt by the fee-floor check ("The network fee
      rose. Please review again…" with the fund-and-retry hint wrongly
      appended); the driver topped up from Account 1's EOA (0.0006, tx
      0xbe7b7d31…8273) and from Account 1's own Kernel account (0.0012,
      userOp 0x94890ac7…b74bb, tx 0xd4cbddcf…4ed91) — a judgement within
      the wallet's own funds — then submitted in the 578–655 Mwei regime:
      confirm "Network fee (worst case, set by you as the submitter)",
      "Total (worst case) 0.00369334246196974 test ETH", "This operation
      also deploys the multisig account (its first operation).",
      "Approvals: weight 2 of the threshold 2…"; ONE prompt "Approve
      submitting this multisig operation (2 of weight 2)"; userOp
      0x351601656cd2f10a7bc36b7a8943b5e45e4c678aff6df7c46bf2dc81b36af32d,
      bundle tx 0x384a35202db5e51b01e52100ba962cd875bed1a11b31ce1647d2adc8b1b61fe3,
      block 11885650, AccountDeployed (meta factory, no paymaster),
      UserOperationEvent nonce 0 success, actualGasUsed 1,607,278, cost
      0.002042 ETH, three weighted-validator signer events (dev5, dev6,
      Account 1) and the root-validator event, rootValidator() (selector
      0xf1f7f0f9) = 0x01‖eD89244160cfe273800b58b1b534031699dfeeee, Account
      2 +0.0001 exactly. OPERATION 2 (nonce 1, approved by dev6; the
      deposit of 0.00155 "pays first"; fee 0.001306547839675704): userOp
      0xe8e3d4d4c21ba92fe0605a94b53a4ac26c063fcef27fdd5be3fd7fe31a8ea335,
      tx 0xfd6441172064018e2ecf30ccfe71b25d466d09395ba2a086913802c895575141,
      block 11885722, success, gasUsed 586,444. MIRROR (this wallet as a
      co-signer): dev5's request 0x2c7bc047…b08d (nonce 2) → "Review
      before you approve" (account, "Multisig 1 (2-of-3)", "Ethereum
      Sepolia (chain id 11155111)", nonce 2, "You approve as 0x772e…F44F
      weight 1 of the threshold 2", the full call) → ONE prompt "Approve
      this multisig operation as a co-signer" → "Approval ready — give it
      to the submitter" (QR = the approval JSON); the independently
      recomputed EIP-712 digest (WeightedECDSAValidator / 0.0.3 / 11155111
      / 0xeD89…) equals request.approvalDigest and the signature recovers
      to Account 1; the script's submit (after a second 0.0006 top-up
      from the Kernel account, userOp 0x90742cce…e452): userOp
      0x14abc237e07ca3fa2ae5658b9aab145dfc2b9ab34a6096f451590136112a8b72,
      tx 0x19a41c1f74a7c1b6a6756ee4746f37278b4f97787d4d7ee0b807d5c6f5f87b23,
      block 11885853, success, Account 2 +0.0001. REFUSALS (0 prompts):
      on Base Sepolia "This request is for Ethereum Sepolia, but the
      active network is Base Sepolia. Switch networks first (Settings →
      Developer)."; as Account 2 "The active account is not a signer of
      this multisig, but Account 1 (0x772e…) is. Switch to it on Home
      first."; mainnet → the Home link hidden, the readiness card with its
      reason, Create / Add / Approve disabled, the Settings readiness row.
      REMOVE AND RE-IMPORT: the dialog names what is removed and that
      nothing on-chain changes; re-import "Add this multisig (2-of-3)?" →
      "Multisig 2 (2-of-3)" at the SAME address, "Deployed; its signer set
      and threshold on-chain match this record." Funds after: Account 1
      EOA 0.00012 ETH, Kernel 0.00188, multisig 0.000507 + 0.000697
      deposit, Account 2 +0.0003; then the CTO topped up from the dev EOA
      for the next passes: Kernel +0.012 (tx 0x4f33acfc…4e1a, block
      11885882), Account 1 EOA +0.004 (tx 0x5b5f2e8c…6101, block
      11885883); the dev EOA holds about 0.018 Sepolia ETH. FINDINGS (fix
      slice dispatched): (1) ECONOMICS — on Sepolia the base fee is ~14
      wei, so the effective price equals the quoted priority fee and the
      100% headroom is paid in full (every op paid 2× ZeroDev's standard;
      op 2 1.305 gwei vs 652 Mwei) — accepted on a test network, worth
      revisiting for mainnet where the base fee dominates; (2) the weight
      bar counts the wallet's own signer before it has signed (labelled
      "signs last when you submit") — decide and state; (3)
      MULTISIG_FUND_AND_RETRY is appended to fee-rose errors (wrong advice)
      and an AA21 names no amount while the shortfall was 3× the balance;
      (4) the multisig funding error uses the smart-account text ("Your
      smart account needs funds first", "(not the owner address)"); (5)
      "Back to the multisig" after a deploying op still shows "Not
      deployed yet" until reopened; (6) the duplicate / non-signer errors
      render below Back, off-screen, and the non-signer text lacks a
      period; (7) the detail and list show the balance but not the
      EntryPoint deposit; (8) the risk card on a send to the wallet's own
      counterfactual multisig says "regular account with no contract code"
      / "first time sending"; (9) "Any 2 co-signers together can send"
      counts this wallet's signer as a co-signer (ambiguous); (10) a
      re-import takes a new name and loses the history (as the dialog
      says); (11) dev-only: Expo Go hung at "Bundling 99%" once; (12) the
      account switcher does not list the multisig (known optional
      follow-up). EMULATOR NOTES: host-to-emulator paste did not deliver
      host text — payloads were typed with an ADBKeyboard base64
      broadcast; the co-signer helper had to run against the Metro
      worktree because the main checkout was mid-edit. UNVERIFIED: QR
      scanning of requests/approvals, the file save/open paths, approvals
      from another wallet via typed data, Base / Arbitrum Sepolia,
      TalkBack, dark mode, iOS. End state: Home, Ethereum Sepolia, Account
      1, light mode, Google IME, protection ON, one multisig record
      ("Multisig 2"); Metro at 3eb00f1.
- [x] Multisig-pass findings FIXED (commit ed184cc; check-multisig 211 (was
      155, 15 mutants), check-aa 362, check-approvals 191; offline runner
      ALL GREEN in the CTO's isolated worktree: engine 877, app 6,909
      across 50 suites, lint 0/0, tsc clean; not seen on a device). (2)
      multisigWeightProgress keeps counting this wallet's weight (CTO
      decision) but the bar reads "Co-signer approvals: weight 0 of 1
      needed (1 still needed)" / "… — ready" with "This wallet signs the
      remaining weight 1 when you submit." and the confirm "Co-signer
      approvals: weight 1 (1 needed). This wallet signs the remaining
      weight 1 when you submit, for weight 2 of the threshold 2…"; (3)
      multisigSubmitErrorText appends MULTISIG_FUND_AND_RETRY only to
      AaFundingError / AA21 (never AaFeeRoseError); the note now says the
      approvals stay valid while funding as long as no other operation
      uses the nonce; multisigFundingFigure gives amount + max(0, fee −
      deposit) from the session's last quote when one exists, else "The
      exact amount is unknown because the estimate itself was refused."
      plus, on Ethereum Sepolia only, the RECORDED range labelled as a
      record not a quote (deploying: "about 0.0036 to 0.0066 test ETH …
      actually cost about 0.0020"; later: "about 0.0013 to 0.0023 … actually
      cost about 0.0008" — the CTO set the later figures from the pass
      record: op 2 estimated 1,001,071 gas, worst case ~0.0023 at 2.31 gwei
      and 0.0013065 at the 652 Mwei it was sent at, cost
      0.000765397384254224); (4) AA_MULTISIG_FUNDING_TITLE "This multisig
      account needs funds first." and multisig-specific funding sentences
      ("the multisig pays its own network fee from its balance and
      EntryPoint deposit…", "Fund the multisig address 0x…"), the
      smart-account text byte-identical (pinned); (5)
      refreshMultisigDeployment after the receipt + multisigChainNote
      ("Deployed by its first operation (the bundler's receipt confirmed
      it), but the network endpoint does not show the account's code
      yet…") and "Back to the multisig" reloads; (6) errors render above
      each phase's actions; addMultisigApproval wraps engine refusals with
      asSentence (period added; engine string unchanged); (7)
      readMultisigFunds → "EntryPoint deposit (pays fees first)" row with
      an adapted AA_DEPOSIT_NOTE and the list line "… · EntryPoint deposit
      (pays fees first): … · deployed"; (8) ownMultisigAddresses(chain)
      ("Multisig 1 (2-of-3)") merged into gatherRiskFacts by default
      (loadOwnMultisigs) and into ownWalletAddresses(accounts, aa, extra)
      via useOwnEvmAddresses, so the risk card says "one of your own
      accounts in this wallet: Multisig 1 (2-of-3) (0x…)" with no searches
      and the success screen offers no "Save as contact"; (9)
      multisigExposureLine(config, localSigner) counts SIGNERS and says
      whether the co-signers can act without this phone ("Any 2 of the 3
      signers together can send an operation — including the 2 co-signers
      without this phone; …"; 3-of-3 "Every operation needs all 3 signers,
      so this phone's signer is always one of them…"; weighted variants).
      Left for other owners: RiskWarnings' ownAddresses (cosmetic);
      activity-sentences' walletAddressesFor ignores multisig addresses.
- [x] Item 3 PROVEN LIVE and Item 2 BLOCKED IN EXPO GO (2026-10-10;
      emulator, Metro at b2530cd, 2,351 modules; no LogBox toast at
      launch — the 783032a fix held; 0 prompts, nothing sent, funds
      unchanged; Privacy off during the pass, on after). CUSTOM NETWORKS:
      Hoodi (560048, https://rpc.hoodi.ethpandaops.io, ticked) → "Network
      added": "Hoodi (chain id 560048) answered as that chain, and its
      newest block (block 3790553) was 8 s old. Block time: about 14.04 s
      per block, measured over 100 blocks…" (block and timestamp checked
      independently); the row ("Treated as a TEST network (ETH here has no
      value).", coin, RPC, "Explorer: none", verified date, block time,
      Remove); the five refusals byte-exact (chain id 1 "already built in
      as Ethereum mainnet"; 137 with the tick → the allow-list sentence;
      http → INSECURE_ENDPOINT_MESSAGE; 17000 with the Hoodi RPC → "This
      RPC endpoint serves chain id 560048, but you entered chain id
      17000…"; "Hoodi2" on 137 unticked → the test-like-name sentence;
      also the duplicate-chain and duplicate-name sentences); selecting
      "✓ Hoodi (test)": the banner "TESTNET — Hoodi test mode is on (a
      network you added)…", the test-mode line, the custom-network note,
      Home "Hoodi" 0 test ETH with no Swap link, no fiat, no tokens; a
      0.001 send refused for funds at Review; the AA row "Hoodi —
      incomplete" with the no-pre-fill note; endpoints "Hoodi — default (1
      of 1: rpc.hoodi.ethpandaops.io)"; REMOVE: the dialog names what is
      deleted and kept, "…back on Ethereum mainnet. No other data was
      stored for this chain."; "My chain" (560048 unticked): "Treated as a
      MAIN network: its funds may be real…", no banner, Home "My chain" 0
      ETH, the Multisig link hidden, AA "test networks only"; removed.
      REMINDERS BLOCKED: the Notifications subsection and its three notes
      exactly as pinned; turning the switch on gave NO system prompt and
      the red line "Reminders are not available in this build of the app
      (its notification module is missing), so nothing was scheduled.
      Technical detail: Call to function
      'ExpoNotificationChannelManager.setNotificationChannelAsync' has
      been rejected." — deterministic; POST_NOTIFICATIONS stays denied;
      no EXPO_CHANNEL channel exists (only Expo Go's own 'expo-experience'
      channel and an empty "Shiba Wallet" group); root cause unconfirmed
      — describeNotificationError keeps only the first line, dropping
      Expo's "Caused by" detail, and Expo Go's
      ScopedNotificationsChannelsProvider carries "TODO vonovak refactor
      this for expo go" (hypothesis: channels are not wired in Expo Go);
      steps 2–5 not run (nothing new to learn without reminders).
      CONSEQUENCE: features 93/83 cannot be shown in Expo Go as built —
      the proof needs the local development build (phase 16's route,
      rebuilt with expo-notifications). FINDINGS (fix slice dispatched):
      (1) keep the full error text (incl. "Caused by") in the reminders
      status so the cause can be read; (2) the status says "its
      notification module is missing" although the module is present and
      its call was rejected; (3) REGRESSION of the namespace-import
      LogBox toasts the moment reminders are toggled —
      loadNotificationsNative's `await import('react-native')`
      (notifications.ts:650), the same root cause 783032a fixed; (4)
      SAFETY — on a custom test network the EIP-7702 "Upgrade now with a
      transaction" button is offered although the Kernel v3.3 delegate
      has NO code there (eth_getCode on Hoodi = 0x); prepareSetCodeTx
      checks readiness, the chain id and the current delegation but not
      the delegate's code; the screen also claims "batching, sponsored
      gas"; not exercised (no Hoodi ETH); (5) the Multisig link and
      "Create a multisig" are offered on Hoodi (checkMultisigNetwork
      would refuse at creation — UX only); (6) a custom MAIN network
      still shows the "paste a factory…" pre-fill note while AA cannot be
      saved there; (7) the http refusal lacks "Nothing was saved." and its
      localhost allowance applies to custom RPCs; (8) the chain-id-1
      refusal says "choose it in the network list above" where the chip is
      "Off (mainnet)"; (9) the Developer intro and the readiness hints do
      not mention custom test networks; (10) duplicate-name is checked
      before test-like-name (correct order; noted); (11) block time
      measured 14.04 s then 12.84 s over 100 blocks (plausible with missed
      slots); (12) emulator: `adb shell input text` truncated a
      42-character address to 30 — use the ADBKeyboard base64 broadcast.
      End state: Home, Ethereum Sepolia, Account 1, light mode, Google IME,
      protection ON, no custom network, reminders off; Metro at b2530cd.
- [x] Reminders-blocker, 7702-safety and custom-network copy findings
      FIXED (commit faad88a; check-notifications 117 (was 98), check-7702 156
      (131), check-custom-networks 162 (152), check-home 69 (60),
      check-readiness 185; offline runner ALL GREEN in the CTO's isolated
      worktree: engine 877, app 6,973 across 50 suites, lint 0/0, tsc
      clean; not seen on a device). (1)(2) describeNotificationError keeps
      the whole message incl. expo-modules-core's "→ Caused by:" line
      (CodedException.kt 155–171 in 57.0.21), URLs replaced, 800-char cap,
      no stack; the unavailable state carries a cause with its own
      sentence — missing (requireOptionalNativeModule null), EXPO GO
      ("Reminders are not available inside Expo Go on this device: Expo Go
      refused to create the reminder channels that Android needs before it
      shows any notification, so nothing was scheduled. Reminders need the
      wallet's own development build."; detected by
      requireOptionalNativeModule('ExpoGo') != null, the same test as
      expo's isRunningInExpoGo), refused, load-failed; a storage failure
      is 'failed'. ROOT CAUSE CONFIRMED FROM SOURCE (expo/expo sdk-57 at
      4200838a; main 4039ca12 matches): Expo Go's ExperiencePackagePicker
      registers NotificationChannelManagerModule, which looks up
      appContext.registry.getModule("NotificationsChannelsProvider")
      (NotificationChannelManagerModule.kt 17–19,
      NotificationsChannelProviderAccessor.kt 6–8 — byte-identical in the
      installed 57.0.22), but Expo Go never registers a module under that
      name in that registry (its modules map omits
      AndroidXNotificationsChannelsProvider;
      ExpoModuleRegistryAdapter.kt 42–47 registers
      ScopedNotificationsChannelsProvider only as a legacy internal module;
      ScopedNotificationsChannelsProvider.kt 27 "TODO vonovak refactor this
      for expo go"); ModuleRegistry.kt 57 getModule returns null for an
      unknown name and the non-null cast throws — so EVERY channel call is
      rejected in Expo Go on Android; the exact "Caused by" text on the
      device and that the emulator's Expo Go is an sdk-57 build remain
      unconfirmed. (3) loadNotificationsNative uses the lazy reactNative()
      require (the 783032a rule); pins forbid any dynamic import of
      react-native in notifications.ts / NotificationScheduler.tsx. (4)
      delegation.ts prepareSetCodeTx (upgrade only) reads
      eth_getCode(0xd6CE…5b28) on the quote's endpoint right after the
      chain-id check — "0x"/"0x0"/"0x00" → "The Kernel v3.3 code this
      upgrade points to is not deployed on <network>, so delegating to it
      would leave your address pointing at nothing. Nothing was signed.";
      unreadable → "Could not read whether…"; revoke never gated;
      readAccountDelegation records the delegate fact once per chain per
      session (readWalletDelegateDeployed / walletDelegateDeployed /
      upgradeActionsOffered / upgradeLinkShown — before a read a network
      the user added is never offered on an assumption); UpgradeAccountScreen
      shows "Not available on this network: …" and hides both upgrade
      actions, "Use this upgraded account" and the batching/sponsored-gas
      claim, with Revoke unchanged and a pending upgrade shown with a
      Cancel warning; Home hides the Upgrade link only when the delegate
      is known to have no code and the status is plain; the aa.ts
      kernel-7702 quote path (REACHABLE: an owner recorded before the fix
      would carry the tuple on its next smart-account send) refuses in the
      bundle.eip7702 branch when the status is 'none' and the delegate has
      no code — the CTO applied the agent's patch and pinned it (a Hoodi
      kernel-7702 bundle on a fake node without delegate code is refused
      before any bundler request; the control with code announces the
      upgrade). (5) evm-chain.ts MULTISIG_UNVERIFIED_NETWORK_NOTE,
      recordMultisigNetworkCheck (a pass remembered per session; custom
      registry changes forget custom passes), multisigNetworkVerified
      (kernelV33Verified or a recorded pass); the Home link needs it; the
      CTO applied the agent's MultisigScreen patch (the note in a
      WarningBox, Create disabled until verified, a "Check this network"
      button running checkMultisigNetwork, the pass recorded after create
      and import). (6)–(9) customNetworkNote on a MAIN network replaces the
      paste-a-factory clause with "Smart-account features cannot be set up
      on it, because the wallet treats it as a main network: <readiness
      refusal>"; CUSTOM_RPC_INSECURE_MESSAGE = INSECURE_ENDPOINT_MESSAGE +
      " Nothing was saved." at both custom-network call sites; "…choose Off
      (mainnet) in the network list above instead."; READINESS_TESTNET_HINT
      "…or a test network you added…", READINESS_INTRO and the Developer
      intro mention networks you added. UNVERIFIED (device / dev build):
      the Expo Go sentence with the real "Caused by" text, no toasts on
      toggle, reminders working in a development build, the Hoodi Upgrade
      screen and hidden links, the Multisig "Check this network" flow.
- [x] Item 2 — LOCAL REMINDERS PROVEN LIVE IN THE WALLET'S OWN
      DEVELOPMENT BUILD (2026-10-10 US Eastern / 2026-10-11 UTC; debug
      dev-client APK built from ccead60 in 4 min 5 s — 695 tasks, 84.8 MB
      — with `./gradlew --stop` before any emulator input; Metro 8082;
      installed as com.anonymous.shibawallet beside Expo Go; a THROWAWAY
      wallet, deleted with the app; all 14 userOps success=1, each re-read
      from EntryPoint logs). DEVIATIONS: Base Sepolia instead of Ethereum
      Sepolia — the dev EOA holds only 0.0025 Sepolia ETH (INPUT NEEDED:
      Sepolia test ETH at 0x16DA…C5C), too little for a 2.9M-gas install
      at ZeroDev's ~0.58 gwei; the five permission modules have identical
      code sizes on 84532; only the throwaway's Kernel was funded (0.003
      from the dev EOA, tx 0x72aeb9ac…1a860, block 47954352; net cost to
      the dev EOA 0.0000492 ETH after the sweep); five short grants
      instead of one; `am kill` added after a swipe-away because this
      image keeps the process cached. MANIFEST (merged, debug): the
      POST_NOTIFICATIONS and RECEIVE_BOOT_COMPLETED permissions, the
      NotificationsService receiver (NOTIFICATION_EVENT, BOOT_COMPLETED,
      REBOOT, QUICKBOOT_POWERON ×2, MY_PACKAGE_REPLACED),
      NotificationForwarderActivity, ExpoFirebaseMessagingService; NEW,
      NOT IN RELEASE.md: WAKE_LOCK and c2dm.RECEIVE permissions, an
      EXPORTED FirebaseInstanceIdReceiver (c2dm.SEND), the
      FirebaseMessagingService, the registrar components and
      FirebaseInitProvider — at every start logcat says "Default
      FirebaseApp failed to initialize because no default options were
      found", so Firebase does not initialise (data flow otherwise
      unverified; RELEASE.md / PRIVACY.md follow-up). PROVEN: status
      "Reminders are off. Nothing is scheduled." → the system prompt
      "Allow Shiba Wallet to send you notifications?" (Allow) →
      "Reminders are on."; channels payments-due "Payments due"
      (importance 3) and security-alerts "Security alerts" (importance 4);
      no LogBox toast at any point (the faad88a fix held). Grant 1 (2 min
      × 3; install userOp 0x4d2540b3…b8e71, tx 0xe73c87de…35fd0, block
      47955213; "Final terms: the first payment is due from 2026-10-11
      00:31 UTC… nothing after 00:39 UTC"): the reminder for slot 2
      (00:35:32) POSTED 00:35:59 (+27.7 s, inside Android's inexact
      window) with the shade text "Recurring payment due / A recurring
      payment is due. Open the wallet to review it; nothing is sent until
      you confirm it." (visibility PRIVATE, auto-cancel); a tap opened the
      app on Sessions; one payment (0 prompts — the throwaway's key was
      unprotected; userOp 0x15c32d96…a828a, tx 0xd66015bc…eb3f9), "2
      payments due now… 1 was missed…", revoke (1 prompt), Forget. Grant 2
      (install userOp 0x6e0ac5de…41cac): a reminder armed on leaving
      Sessions posted +45.1 s; a WARM tap from Settings opened Sessions and
      re-armed slot 2 (posted +40.5 s); after a swipe-away and `am kill` a
      COLD tap started the app on Sessions (logcat "unmarshalled
      notification response. Skipping." — navigation still worked);
      "Revoke and forget" after expiry. Grant 3 (install userOp
      0xec50e228…a23a8): with the task swiped away and the process killed,
      Android STARTED THE PROCESS "for broadcast NotificationsService" and
      posted +40.4 s; a tap with no activity opened Sessions; a payment (0
      prompts) and revoke-and-forget. Grant 4: a reminder that fired while
      the app was in front posted silently (group silent, no heads-up);
      revoked on Sessions — the pending alarm STILL FIRED 20 s after the
      revoke was included (bug). Grant 5 (5 min × 3): reminders Off →
      "Reminders are off. Nothing is scheduled." with the alarm and the
      library store gone; On again → no system prompt, re-armed; revoke →
      the alarm stayed pending on Sessions and was cancelled the moment
      the screen was left; nothing arrived afterwards; final `dumpsys
      alarm` shows no RTC alarm for the package. Sweep: Kernel Max to the
      dev EOA (userOp 0x46c02a97…2d2a1b, tx 0xf0c628de…721a3; Max
      auto-lowered with the fee-rose note); about 0.0000072 ETH stranded
      (fee keep-back plus a deposit the app cannot withdraw); the app
      uninstalled, Metro 8082 stopped, Expo Go untouched. FINDINGS (fix
      slice dispatched): (1) NO reminder is armed for a grant just started
      if the user leaves the app from Sessions — the full sync runs only
      on start, foreground, a toggle change or LEAVING Sessions, and the
      background pass never schedules (fix: sync after an install and
      schedule from stored states in the background pass); (2) lateness
      +27 to +45 s at 2-minute periods and a +3 min 14 s window at 5
      minutes — a 30-day period could be minutes to hours late (matches
      the stated design); (3) a revoke on Sessions does not cancel the
      pending reminder until the screen is left or the app backgrounds,
      and delivered reminders are never dismissed by revoke / Forget /
      Off (disable cancels scheduled ones only) — one stale reminder
      stayed in the shade; (4) foreground delivery was silent — the
      intended foreground banner is unverified; (5) stale copy: the
      Sessions header "Nothing runs in the background.", the form's
      "Sending while the wallet is closed would need a background task or
      notifications, which need a development build…", the terms "These
      terms last only 8 minutes in total (3 payments of 2 minutes)" and
      "The end date is one period after the last payment falls due" while
      showing last due 00:33 and end 00:37 (two periods, or the copy is
      wrong — check the grace arithmetic); (6) the review shows one
      permission id (0xfc1d56ae) and Start installs another (0xc0f4859d)
      — consistent with "the clock restarts" but the reviewed key differs;
      (7) the notification icon is a placeholder ring (no app icon); (8)
      the exported Firebase receiver and c2dm / WAKE_LOCK permissions
      (privacy follow-up); (9) emulator: recents swipes are flaky; the
      dev-launcher "Tools" bubble swallows taps near the gear and Max.
      HYGIENE NOTE: one early UI dump printed six quiz-option words of the
      throwaway phrase (two answers, four decoys) into the agent's local
      log before masking was fixed; the wallet was throwaway and is
      deleted; nothing of the emulator's real wallet was exposed.
      UNVERIFIED: re-arming after a reboot; delivery after a real force
      stop (expected none); the lock-screen presentation; TalkBack; exact
      alarms; anything on Ethereum Sepolia.
- [x] Reminders dev-build findings FIXED (commit 8931447; check-notifications
      165 (was 117), check-recurring 174, check-subscriptions 188; offline
      runner ALL GREEN in the CTO's isolated worktree: engine 877, app
      7,031 across 50 suites, lint 0/0, tsc clean; six in-suite and six
      manual mutants caught; not re-run in the development build). (1)
      recurringTermsReminderAt(record, now) computes the next slot from
      the INSTALLED GRANT alone (startAt + k × interval, k < count, no
      later than the grant's end — RateLimitPolicy moves its start forward
      per payment, so such a reminder can never announce a payment that is
      not due; a revoke elsewhere is corrected by the next read);
      planRecurringSync takes a scope and schedules an eligible record
      with nothing scheduled and no read state from its grant (a failed
      read with a reminder keeps it); the background pass passes the
      scope, so leaving from Sessions arms the reminder; requestReminderSync
      ('local' | 'full') is called in SessionsScreen's settle callbacks
      (install settled, resumed install/revoke settled, payment receipt,
      revoke settled → full; bundler accepted a revoke, revoke-and-forget,
      Forget, list reset → local). (3) From ExpoPresentationDelegate.kt
      (105–113, 127–129, 143–155, 69–84, 185–200): a posted notification
      carries the request identifier as its tag with id 0, so
      dismissNotificationAsync(identifier) hits exactly it, and an
      unreadable one is listed as expo-notifications://foreign_notifications?tag=…
      (walletIdentifierOf reads the tag); dismissAllNotificationsAsync
      deliberately NOT used (cancelAll); the native layer gained
      presentedIdentifiers(); Off, wipe and cleanup dismiss only shown
      identifiers starting "shiba-wallet."; planRecurringSync returns
      dismiss for no-longer-eligible, completed/inactive, and "later"
      states whose next slot is after now (a past "later" is kept to avoid
      a race); best effort, never blocks scheduling. (4) From
      ExpoNotificationBuilder.applySoundsAndVibrations (setSilent(true)
      when neither sound nor vibration) and the SDK 57 docs ("setting
      shouldPlaySound: false will result in the drop-down notification
      alert not showing"): FOREGROUND_BEHAVIOR = banner + list + SOUND, no
      badge (iOS content sets no sound); DECISION — payments-due stays
      DEFAULT importance (no heads-up: a slot stays open a whole period
      and a pop-up every 2 minutes in testing would be intrusive; a
      channel's importance cannot change after creation, so a heads-up
      would need a new channel id); security-alerts stays HIGH and now
      pops in the foreground too. (5) RECURRING_CARD_NOTE "…no payment is
      ever sent in the background. With reminders on (Settings → Privacy →
      Notifications), this phone can remind you when a payment falls due,
      even while the wallet is closed; the payment still waits for you.";
      RECURRING_LATER_SLICE_NOTE now describes reminders (need the
      wallet's own build; never send); GRACE ARITHMETIC CORRECTED — the
      CTO's brief said "one period after the last due"; in code the terms
      end at start + payments × period and the grace adds one period, so
      the grant ends at start + (payments + 1) × period, TWO periods after
      the last slot (00:31/00:33/00:35, end 00:39 — matching the live
      "nothing after 00:39"); the caveat now says "two periods after the
      last payment falls due (one period more than the terms alone would
      allow, as a grace period)…" and the warning "These terms last only 8
      minutes in total: 3 payments, one every 2 minutes, and the last one
      can still be sent for 4 minutes after it falls due."; pinned with a
      fixed start (08:00 → last due 08:04, end 08:08, rateLimit {3, 120,
      start}). (6) The review shows "Kernel permission id: assigned when
      you tap Start subscription…" instead of an id that changes at Start
      (the session key does NOT change — only the permission id; the
      finding's wording corrected); the success screen shows "Kernel
      permission id (installed)". (7) No native config added: the small
      icon falls back to the launcher icon
      (expo.modules.notifications.default_notification_icon else
      applicationInfo.icon); RELEASE.md records the plugin entry
      ["expo-notifications", {"icon", "color"}] in the placeholders and
      the DECISION that adding it always adds the iOS aps-environment push
      entitlement (withNotificationsIOS.ts) although the wallet uses no
      push; check-notifications pins the plugin's absence. (8) RELEASE.md
      §3 and PRIVACY.md 2.8 record the firebase-messaging 25.0.1 manifest
      entries and the "Default FirebaseApp failed to initialize" line; open:
      that only Google Play services holds c2dm.SEND (adb command given)
      and whether unconfigured Firebase makes any network call. KNOWN GAP:
      if Sessions is closed before an install settles, the resumed settle
      runs when Sessions next loads; the next start/foreground sync arms
      the reminder. UNVERIFIED (dev build): the background pass firing on
      leave, dismissal in the real shade incl. foreign listings, the
      foreground presentation with sound, the review/success rows.

## Phase 17 status (2026-10-11)

Items 0 to 6 are landed and pushed. Proven live this phase: app-wide
screen protection (default on; the recents card blank, every screencap
empty, the control with the switch off), multi-signature accounts in the
app (a 2-of-3 created, deployed through ZeroDev's bundler by its first
operation, operated twice, this wallet co-signing a third request), a
custom network added, used and removed with every refusal exact, and
local reminders in the wallet's own development build on Base Sepolia
(the permission prompt, both channels, delivery after a slot with the
process killed, taps into Sessions warm and cold, Off clearing all).
Built and verified offline: transaction notes with the CSV export; the
fixes from each pass. Designed: staking on test networks (docs/
STAKING.md). Engine: 877 tests. App: 50 offline suites, 7,031 checks.
The shareable page is at version 18 (45 proven live, 17 built, 3
designed, 34 not started).

Findings for the Chairperson this phase: Expo Go cannot create
notification channels (confirmed in its source), so reminders exist only
in the wallet's own build; the notifications dependency brings Firebase
messaging components into the Android manifest although the wallet uses
no push service (recorded in RELEASE.md / PRIVACY.md); on Sepolia the
100% fee headroom is paid in full because the base fee is ~14 wei (a
test-network cost; revisit for mainnet); an EIP-7702 upgrade must never
be offered where the Kernel delegate has no code (now enforced); the
disclosure findings document still awaits your review.

Inputs that would unlock more: Sepolia test ETH at the dev EOA
0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C (about 0.0025 left); a
decision on the stake-only Lido slice and/or a Hoodi profile
(docs/STAKING.md); the notification icon (and whether to accept the
plugin's iOS push entitlement); the ZeroDev disclosure decision; the
phone and Expo account remain held by your decision.

Follow-ups (no inputs): the multisig in the account switcher; a
TransactionNoteField on the Swap, WalletConnect and Sessions success
views; a UTF-8 BOM option for the CSV export; Activity sentences
recognising the wallet's multisig; the Firebase questions above; the
"Open connections" label; TalkBack on the emulator; re-running the
reminders fixes in the development build.

INPUTS RECEIVED (2026-10-11, verified read-only the same day): the dev
EOA 0x16DA…C5C now holds 0.1025 Sepolia ETH, and 20 USDC on each of
Ethereum Sepolia (0x1c7D…7238), Base Sepolia (0x036C…CF7e, 36 total),
Arbitrum Sepolia (0x75fa…AA4d, 37 total) and OP Sepolia
(0x5fd84259d66Cd46123540766Be93DFE6D43130D7, chain 11155420; it holds NO
ETH there, so nothing can be sent on OP Sepolia until some arrives).
DECIDED by the Chairperson (2026-10-11): (a) staking — build BOTH the
stake-only Lido slice on Sepolia and a Hoodi profile, Hoodi first ("it
is designed for staking testing whereas Sepolia is for dApp testing and
everything else"); (b) add the notification icon through the
expo-notifications plugin; the iOS push entitlement it adds is
acceptable for now; Firebase (FCM) is noted as the likely longer-term
push option (feature 93 in full); (c) the findings document review is
pending. The emulator's "black screen" was the AVD asleep; a wake and
fingerprint unlock restored it (nothing wrong with the app).

## Phase 18 plan (started 2026-10-11): staking on test networks, more test networks, the polish list

0. Notification icon: the expo-notifications plugin entry with a
   wallet-drawn monochrome icon and colour (assets/notification-icon.png,
   generated and checked into the repo with its source), the
   check-notifications pin updated, RELEASE.md / DEVICE_BUILDS.md
   updated, the iOS aps-environment entitlement recorded as accepted.
1. Built-in test profiles for Hoodi (560048) and OP Sepolia (11155420):
   RPC candidates from ethereum-lists/chains and the providers' own
   pages, verified live (chain id, freshness, eth_simulateV1 where
   served); Hoodi has NO Kernel contracts (AA features refused honestly;
   EOA sends, tokens, ENS if deployed, staking); OP Sepolia is OP-stack
   (l1DataFee like Base), Kernel presence verified on-chain, Circle's
   USDC paymaster NOT there (Circle lists Arbitrum and Base only), OP
   Sepolia USDC as a known token; both reachable from Developer; the
   custom-network allow-list keeps them so an older custom entry still
   loads; readiness treats both as test networks.
2. Staking (features 57/58, per docs/STAKING.md): engine lido.ts /
   rocket-pool.ts (stake = submit(address(0)) / wstETH shortcut /
   RocketPool deposit(); unstake = requestWithdrawals + claimWithdrawal
   on Hoodi; rETH burn after the lock; selectors from verified source;
   exact bigint; balances through balanceOf; the rebasing caveat for
   the preview), a Staking screen behind a readiness row (test networks
   only): on Sepolia stake-only with Lido's own risk statement and the
   "deprecated, no rewards" lines, unstaking refused after a live
   isPaused(); on Hoodi stake, the stETH/wstETH/rETH balances, request
   and claim withdrawals with the queue state; sends through the
   existing confirm (preview showing the stETH or rETH received); the
   AA angle recorded, not built (Kernel absent on Hoodi). INPUT: Hoodi
   test ETH at the dev EOA for the live run (faucets need a social
   login — the Chairperson's call).
3. Polish: the multisig in the account switcher; TransactionNoteField on
   the Swap, WalletConnect and Sessions success views; Activity
   sentences aware of the multisig; the Firebase questions answered from
   source; the "Open connections" label; a TalkBack pass on the
   emulator; the reminders fixes re-run in the development build.
4. Leadership refresh at the end.

Waves: 1 — items 0, 1 and 2's engine + Sepolia half in parallel
(disjoint files); 2 — item 2's Hoodi half on the new profile, then the
emulator passes; 3 — item 3; 4 last. Subagents on Opus.

## Phase 18 progress
- [x] Item 0 — NOTIFICATION ICON (commit 19f5040; check-notifications 179
      (was 165); offline runner ALL GREEN in the CTO's isolated worktree
      with only this slice: engine 877, app 7,045 across 50 suites, lint
      0/0, tsc clean; expo-doctor 21/21; five manual mutants caught; the
      icon in the shade needs a rebuilt development build). app.json:
      ["expo-notifications", { "icon": "./assets/notification-icon.png",
      "color": "#a65d13" }] (the light accent, theme-palette.ts:82);
      app/assets/notification-icon.png 96×96 (933 bytes) drawn by
      app/scripts/make-notification-icon.mjs (a front-facing Shiba head
      as one white silhouette — upright ears with a V notch, cheek ruffs,
      transparent eye and nose cut-outs — 8-px clear border, 4×4
      supersampled, every pixel 255,255,255 with alpha only, byte-
      identical on regeneration; a Node-only PNG encoder, no new
      dependency; registered in suites.mjs as a helper because the runner
      refuses unlisted scripts). PLUGIN FACTS (57.0.22 plugin/src): icon =
      a 96×96 all-white transparent PNG resized to res/drawable-*/
      notification_icon.png at 24/36/48/72/96 px with meta-data
      expo.modules.notifications.default_notification_icon and
      com.google.firebase.messaging.default_notification_icon; color →
      colors.xml notification_icon_color + the two default_notification_color
      meta-data entries; the builder uses the meta-data else
      applicationInfo.icon (ExpoNotificationBuilder.kt 342–396); left
      unset on purpose: defaultChannel (FCM only), sounds, mode,
      enableBackgroundRemoteNotifications (push only). NEW FINDING: the
      iOS aps-environment entitlement was ALREADY present before this
      change — @expo/prebuild-config 57.0.17 applies expo-notifications'
      own plugin automatically whenever the package is installed
      (withDefaultPlugins.js:171, getPrebuildConfig.js:56), so the phase
      17 note that adding the plugin would add the entitlement was
      inaccurate; `expo config --type introspect` at HEAD already showed
      "aps-environment": "development"; the explicit entry adds only the
      Android icon and colour; the Chairperson accepted the entitlement
      for now (recorded in RELEASE.md and PRIVACY.md); the plugin's own
      resizer kept all five sizes pure white. DEVICE_BUILDS.md gained
      "Rebuild after native configuration changes" (`expo prebuild
      --platform android --clean` then run:android, since run:android
      generates android/ only when missing).
- [x] Items 1 and 2 (engine + Sepolia half) — HOODI AND OP SEPOLIA
      PROFILES; STAKING WITH LIDO AND ROCKET POOL (one commit, 3c9ecc8,
      verified as one snapshot in the CTO's isolated worktree: engine 906
      — chains-evm 644, +29 — app 7,212 across 51 suites, lint 0/0, tsc
      clean; suites: check-staking 82 new, check-devmode 297,
      check-readiness 190, check-rpc-fallback 178 (221 live), check-base
      118, check-custom-networks 183, check-tokens 114; not seen on a
      device). HOODI (eip155:560048; reads 2026-10-11 agreeing on two
      RPCs): chains data eip155-560048.json (ETH, 18 decimals, rpc
      rpc.hoodi.ethpandaops.io; NO EIP-3091 explorer — only "dora");
      explorer https://hoodi.etherscan.io (the network homepage's
      blockExplorerUrls and the eth-clients/hoodi README ef899890; the
      /tx/ path assumed, Cloudflare 403); RPC order
      ethereum-hoodi-rpc.publicnode.com (simulateV1 with tracing),
      rpc.hoodi.ethpandaops.io (simulateV1 refused -32601 "method ignored
      by upstream configuration"), 0xrpc.io/hoodi (simulateV1 works) —
      all pass chain id, freshness, head−100/−1000, a 9,000-block
      eth_getLogs and a refused malformed sendRawTransaction; rejected
      public.1rpc.io/hoodi (timeouts / HTTP 522). NO KERNEL: the factory
      0x2577…F2E9 and implementation 0xd6CE…5b28 have no code
      (verifyKernelDeployment: "KernelFactory … has no code on this
      chain"); the meta factory and ECDSA validator have Sepolia-identical
      code but the meta factory is unstaked; no permission modules,
      RecoveryAction or WebAuthnValidator; the weighted validator present
      (only chain id / domain separator differ); P-256 precompile true;
      ZeroDev /chain/560048 → HTTP 400 "No API provider supports the
      requested chainId."; no ENS, no Circle paymaster, no GasPriceOracle;
      block time 13.37–13.52 s measured (12 s slots with misses);
      profile: kernelV33Verified false, aaPrefill null, l1DataFee false,
      l1CostInGas false, swapsOffered false, "test ETH", "Hoodi test
      mode", risk window 50,400 blocks, NFT path hoodi.etherscan.io/nft/
      (assumed), recovery label "hoodi", no known tokens (Circle's "Morph
      Hoodi" is a different chain). OP SEPOLIA (eip155:11155420): chains
      data eip155-11155420.json; explorer sepolia-optimism.etherscan.io
      (a real /tx/ page answered 200); RPC order
      optimism-sepolia-rpc.publicnode.com (PublicNode's page and
      Optimism's RPC directory), sepolia.optimism.io (Optimism's directory;
      "rate-limited"; today all head−100 / head−9000 / head−302,400 reads
      answered), op-sepolia-testnet.api.pocket.network ("No API key
      required"); rejected optimism-sepolia.drpc.org (free plan refuses
      the log window) and blockreq (last 1,024 blocks only); OP-stack:
      GasPriceOracle 0x4200…000F (2,055 bytes, version 1.6.0, Ecotone /
      Fjord / Isthmus active; getL1Fee 268 wei for a 47-byte probe;
      getOperatorFee 0) → l1DataFee true; KERNEL PRESENT:
      verifyKernelDeployment PASSED on two RPCs (implementation 0xd6CE…5b28,
      EntryPoint v0.7, kernel.advanced.v0.3.3, the meta factory approves
      the factory and is staked 0.1 ETH / 86,400 s); the factory, meta
      factory, ECDSA validator, all six permission modules, RecoveryAction,
      WebAuthnValidator (pinned hash) and Daimo's verifier byte-identical
      to Sepolia's (the implementation and weighted validator differ in the
      34 cached chain-id / domain bytes, recomputed); P-256 true; ZeroDev
      /chain/11155420: eth_chainId 0xaa37dc, v0.7 supported (also v0.6,
      v0.8 and an unidentified 0x433709…), pimlico_getUserOperationGasPrice
      served, rundler_maxPriorityFeePerGas not; NO Circle v0.7 paymaster
      (Circle's page lists Arbitrum and Base Sepolia only; 0x31BE…0b58 has
      no code there; Circle's v0.8 paymaster 0x3BA9…8966 is listed but
      reports EntryPoint v0.8, unused) → the USDC fee is not offered; USDC
      0x5fd84259d66Cd46123540766Be93DFE6D43130D7 (Circle's USDC page;
      symbol "USDC", name "USDC", 6 decimals live on two RPCs; no EURC);
      block time exactly 2.000 s; profile: kernelV33Verified true,
      aaPrefill null (SimpleAccount not checked), l1DataFee true,
      l1CostInGas false, swapsOffered false, ENS refused, risk window
      302,400, recovery label "op-sepolia". BOTH: in TEST_NETWORK_CHAINS /
      isTestNetwork; readiness rows read "Test networks only" everywhere
      (funds are test funds; on Hoodi the smart-account features are
      stopped by the DEPLOYMENT checks, not by readiness — no pre-fill,
      the factory refused on save, the 7702 upgrade not offered, the
      Multisig link hidden); the profile table drives the readiness intro
      and hint, the Developer hint and the WalletConnect "test network
      (…)" sentence, now naming five networks; describeChain "Hoodi (test
      network)" / "OP Sepolia (test network)"; the custom allow-list keeps
      both ids but adding either refuses "Chain id 560048 is already built
      in as Hoodi; choose it in the network list above instead…" and the
      tick note lists only Holesky, Polygon Amoy, Linea Sepolia and Scroll
      Sepolia; a custom record stored earlier for either id is SUPERSEDED
      (CHAIN_IDS_BUILT_IN_SINCE_CUSTOM_NETWORKS): dropped on load without
      marking damage, the list rewritten once, every per-chain datum kept
      and now belonging to the built-in profile, a stored choice of
      "eip155:560048" selecting built-in Hoodi, a one-time note
      (supersededCustomNetworkNote — the CTO rendered it in Settings)
      saying the typed RPC and explorer are no longer used and how to keep
      the RPC as the endpoint override, with a sentence for a record saved
      as a main network; older built-in ids still count as damage; a
      stored record for another chain NAMED "Hoodi" / "OP Sepolia" now
      collides with a built-in name (known edge). The CTO also: rendered
      the superseded notes, made the Account Abstraction note
      profile-aware ("…the wallet checked this network and found the
      Kernel v3.3 factory and implementation have no code there…" on a
      built-in network without Kernel, the custom wording otherwise),
      added 'hoodi' / 'op-sepolia' to the multisig file labels, applied
      the agent's patch to the cross-slice pins (check-aa, check-wc,
      check-prices, check-7702 now using the built-in Hoodi, check-home's
      custom fixture moved to Holesky), and left the readiness hint
      table-driven (it names Hoodi among the test networks although Kernel
      features are refused there by the deployment checks — acceptable:
      the hint is about readiness, not deployment). Scripts: kernel-smoke
      / fund / token-gas-smoke know both chains (OP Sepolia Kernel dry run
      PASSED through the real EntryPoint; Hoodi and the token-gas dry run
      on both refused before any request, pinned). Emulator checklist (9
      steps) in the builder's report. STAKING (features 57/58; readiness
      row `staking` testnet-only enforced: "Staking hands your ETH to
      Lido's or Rocket Pool's contracts, whose own audits cover the
      protocols but not how this wallet builds, previews and sends these
      calls…", evidence W1 W2 W9 W13): packages/chains-evm/src/staking.ts
      (exported, append-only in index.ts) with the Lido addresses from
      lidofinance/docs 140c583d — Sepolia stETH
      0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af (impl Sourcify exact),
      wstETH 0xB82381A3fBD3FaFA77B3a7bE693342618240067b (exact), queue
      0x1583C7b3f4C3B008720E6BcE5726336b0aB25fdd (impl exact; the locator
      agrees); Hoodi stETH 0x3508A952176b3c15387C97BE809eaffB1982176a,
      wstETH 0x7E99eE3C66636DE415D2d7C880938F2f40f94De4 (exact), queue
      0xfe56573178f1bcdf53F01A6E9977670dcBBD9186 (locator agrees; its impl
      0xD0a60e52…eCD5 is not on Sourcify but byte-identical to the verified
      Sepolia impl except nine 20-byte address slots) — and Rocket Pool
      on Hoodi from smartnode 8c1dad70: RocketStorage
      0x594Fb75D3dc2DFa0150Ad03F99F97817747dd4E1 (getDeployedStatus true),
      rETH 0x7322c24752f79c05FFD1E2a6FCB97020C1C264F1 (the registry's
      entry must equal it or the wallet refuses), the deposit pool
      resolved from storage at every quote (keccak("contract.address" +
      name), RocketBase.sol 106 at fef41a4f; today 0x425E6f83…3Fd8);
      selectors pinned against ethers: submit 0xa1903eab, wrap 0xea598cb0,
      unwrap 0xde0e9a3e, requestWithdrawals 0xd6681042,
      requestWithdrawalsWstETH 0x19aa6257, claimWithdrawals 0xe3afe0a3,
      claimWithdrawal 0xf8444436, deposit 0xd0e30db0, burn 0x42966c68;
      CLAIM FLOW from WithdrawalQueue.sol at lidofinance/core 2da0f48f
      (v4.0.1, 223–311, Base 418–452): getWithdrawalRequests(owner) →
      getWithdrawalStatus → keep finalized, unclaimed, owned, ascending →
      findCheckpointHints(ids, 1, getLastCheckpointIndex()) → hints
      checked (none 0, none past the last, non-decreasing) →
      getClaimableEther → claimWithdrawals(ids, hints) paying msg.sender —
      tested against a read-only Hoodi capture (8 finalized requests,
      hints 542…1030, last checkpoint 1033; the claim succeeds as an
      eth_call from the owner and reverts from anyone else). APP
      staking.ts + StakingScreen/Views (route Staking, the Home link when
      a protocol is set up; watch-only refused by the gate): availability
      per chain (Sepolia: Lido's queue isPaused() true → unstake refused
      live with ResumedExpected() 0x14378398, oracle last report 2 July
      2025 → "Lido calls its deployment on this network deprecated. Test
      stETH here does not earn rewards…"), Lido's four risk sentences
      quoted with source and date, Rocket Pool's two FAQ sentences (it has
      no risk page — stated), stake → stETH (submit) / → wstETH (a plain
      transfer), wrap (exact approve then wrap) / unwrap, unstake request
      (approve + requestWithdrawals, Hoodi), claim, Rocket Pool deposit
      (min 0.01, fee 0.05%) and rETH burn, all through prepareEvmSend or
      prepareAaCalls (the smart account refused on Hoodi with
      HOODI_NO_SMART_ACCOUNT) with the preview ("You receive ≈ 0.001
      stETH", the simulated 0.000999999999999999 and the rebasing note),
      the risk card and the eth_call gate. LIVE ON SEPOLIA through the
      app's own code (dev EOA): tx
      0xb69f49ec8e3ab8a49ca92d7593d7828720fd37ed3fcf8a09fdfa8e0b266b019b,
      block 11888829, input 0xa1903eab‖zero word, value 0.001 ETH,
      Submitted 1e15, stETH minted 999,999,999,999,999 wei (1 wei short,
      as the math says), shares 963,653,100,270,615, gas 208,421 (exactly
      the simulated figure); the Hoodi leg skipped (0 Hoodi ETH).
      FINDINGS: (1) the rETH deposit lock NEVER STARTS in the deployed
      code — nothing at rocketpool fef41a4f or in the Hoodi deposit pool
      writes "user.deposit.block"; a simulated deposit then burn in the
      next block succeeded (corrects STAKING.md 4.6; the wallet still
      reads the stored block); (2) rETH burn() pays out with transfer()
      (2,300-gas stipend) — it reverted in simulation for the
      7702-delegated 0x9858… and succeeded for a plain EOA (inferred; the
      eth_call gate blocks it); (3) Rocket Pool's docs have no risk page.
      Mutants caught: the live pause check, the readiness asserts, the
      Hoodi sentence/refusal, an unlimited approval. FOLLOW-UPS: risk.ts
      should describe the pinned staking contracts; tokens.ts could list
      stETH / wstETH / rETH with a rebasing flag; a threat-model row for
      staking; the Hoodi pass needs Hoodi ETH (INPUT) and covers Lido
      stake, unstake request, claim after finalisation, a Rocket Pool
      deposit ≥ 0.01 and burn, and the smart-account refusal.
- [x] Item 3 — THE POLISH LIST (one commit, cd120b1, two slices verified as
      one snapshot in the CTO's isolated worktree: engine 906, app 7,369
      across 51 suites, lint 0/0, tsc clean; every mutant caught; not
      seen on a device). MULTISIG IN THE SWITCHER: AccountView gains
      multisig + multisigInfo {chain, localSigner, label}; the name is the
      shape label ("Multisig 2 (2-of-3)"); WalletContext.multisigAccounts;
      the "accounts with a key" filters gain !a.multisig; a multisig gets
      an EVM-only row and ensureDerived never sends its id to the phrase;
      withStoredMultisigs reconciles at launch, on a new wallet and on
      every multisig store write (addMultisigStoreListener), persisting
      only on change; approvalTargetFor(id) → phrase / imported / none
      (watch-only, multisig, malformed) and commitAccounts sets it;
      loadAaBundle returns null for isMultisigAccountId before any read;
      the route allow list for an active multisig (MULTISIG_ALLOWED_ROUTES,
      11 routes: Home, Activity, Nfts, NftDetail, Tokens, Approvals
      (read-only — no Revoke, the handler refuses first), Settings,
      Contacts, ImportKey, Receive, Multisig) with every other route
      refused by name; SEND REFUSED PLAINLY (the smaller option: the
      Multisig route takes no parameters) with "Sends from a
      multi-signature account are signing requests for the co-signers;
      build one on the Multisig screen.", the signer hint naming the
      wallet's signer account and an "Open the Multisig screen" button;
      Home: the switcher lists multisigs last with a "Multisig" chip and
      the line "Multisig — operations need co-signers; Ethereum networks
      only", the EVM card shows the balance and an EntryPoint deposit row
      (masked by Hide amounts), links Activity / Receive (the address) /
      Multisig / Manage tokens / NFTs / Approvals, Send / Swap / Upgrade /
      the tools row / the recovery link hidden via noKey = watchOnly ||
      multisig, the notice "Multi-signature account: no single key in this
      wallet can send from it…", BTC/DOGE/SOL rows "Not available for a
      multi-signature account…", an other-network note; Receive: address,
      QR, label, the co-signer sentence, no Send / request / proof /
      smart-account box; watching a multisig address refused ("…already
      listed in this wallet…"); Apps refused with its own sentence;
      Activity's walletAddressesFor(eoa, index, aa, multisigs) includes
      every stored multisig on the network (sentences read "yourself" —
      a label needs an engine change in activity-decode party(), follow-
      up); the MultisigScreen never takes an active multisig as "this
      wallet's signer"; if the active multisig's record is removed the
      wallet hands over to Account 1. Mutants: a multisig that can sign
      (the real signWith refuses with MULTISIG_SIGN_REFUSAL, zero
      secure-store reads), a device check opening the phrase (zero reads
      vs ≥ 1 for a phrase account), Apps offered, Send not refused (gate,
      Home, Receive), Activity not recognising it, derivedIndices without
      the filter, loadAaBundle without its line, and the card / sentence /
      link / deposit / notice pins. NOTES: app/src/components/
      TransactionNoteField.tsx (SendScreen's SuccessNoteField moved,
      behaviour identical); rendered above Done on both Swap success
      views (the network captured at sending so a mode switch cannot
      misfile the note) and on every Sessions progress view (Progress
      gained network; five creators set it); a WcSentView + WcSentResult
      exist in WcApprovalSheet but are NOT wired — WalletConnectContext
      still completes with Alerts ("Transaction sent", "Batch sent to the
      bundler", "…dApp not notified"); wiring it is a follow-up (lines
      701 / 753 / 978). RISK: pinnedStakingContracts() from the engine's
      LIDO_DEPLOYMENTS / ROCKET_POOL_DEPLOYMENTS (seven: stETH, wstETH and
      the queue on Sepolia and Hoodi; rETH on Hoodi — not RocketStorage,
      never a send target, nor the deposit pool, resolved per quote);
      stakingContractAt matches all 40 hex digits on the exact chain;
      the card's one line "This transaction goes to Lido's stETH contract
      on Ethereum Sepolia (0x…), pinned by this wallet from Lido's
      published list of deployed contracts." replaces the generic contract
      / contract-age lines and skips the first-interaction search when
      the contract itself is paid; approvals kept; withStakingTokens adds
      the chain's staking tokens to the risk card's token list (so a
      stETH transfer is described by its recipient); a look-alike (last
      digit changed) keeps every warning (pinned + mutants). TOKENS:
      KNOWN_STAKING_TOKENS (Sepolia stETH + wstETH; Hoodi stETH, wstETH,
      rETH; metadata read live on two endpoints: "Liquid staked Ether
      2.0", "Wrapped liquid staked Ether 2.0", "Rocket Pool ETH", 18
      decimals), KnownToken gains rebasing?: true (stETH only),
      knownStakingTokensForChain / isRebasingToken (table-only, so a
      stored entry cannot switch the note on) / rebasingTokenNote with
      REBASING_TOKEN_NOTE "Rebasing token: the balance changes by itself;
      the preview can be off by a wei or two."; DELIBERATELY NOT in
      knownTokensForChain nor the default lists (that list also feeds
      subscriptions and spending limits — a rebasing subscription asset
      is their owners' decision; pinned: stETH not default on Sepolia);
      the CTO added the Home note under a rebasing token row and
      trackReceivedStakingToken on the Staking screen's success paths
      (asset fields only, duplicates ignored). THREAT MODEL: T-76
      (staking: Lido's contracts and accounting oracle; RocketStorage, the
      deposit pool and rETH; what the wallet verifies — pinned addresses,
      verifyLidoDeployment, the rETH registry check, exact approvals,
      claim hints; the live pause checks; the rebasing caveat; test
      networks only; residuals: no mainnet addresses pinned, only the
      Sepolia stake run live) with 'T-76' in the staking row's evidence;
      a note under the chain table (Hoodi no Kernel stack; OP Sepolia the
      stack byte-identical to Sepolia's; no Circle v0.7 paymaster there);
      section 1.3 no longer lists staking or the browser as absent.
      FIREBASE (from the Gradle cache jars of the dev builds via javap and
      expo-notifications 57.0.22): FirebaseInstanceIdReceiver is an
      exported receiver for com.google.android.c2dm.intent.RECEIVE guarded
      by android:permission c2dm.permission.SEND, passing push messages
      from Google Play services to the messaging service; the permission
      is declared by com.google.android.gsf, "held by Google Play
      services" per Google's GCM reference (read through a mirror; the
      protection level, expected signature, is unverified — the command `adb shell pm list permissions -f | grep -A5 c2dm.permission.SEND` would show it);
      NO NETWORK CALL on the app's paths: FirebaseInitProvider.onCreate →
      FirebaseApp.initializeApp(Context) → FirebaseOptions.fromResource
      returns null without google_app_id → logs "Default FirebaseApp
      failed to initialize…" and returns null, so no FirebaseApp, no
      component runtime, no messaging / installations / data transport;
      expo-notifications touches Firebase only in the push-token and topic
      functions, never called; a network capture of a fresh install is
      still not done; recorded in RELEASE.md §3 / §10 and PRIVACY.md 2.8.
      LABEL: the Settings button is "Connected apps" (= the screen title)
      and the Apps blurb quotes it. FOLLOW-UPS: wire WcSentView; the
      preview's REBASING_TOKEN_NOTE (BalanceChangePreview / simulation.ts
      — its suite pins exact lines); Settings → Accounts does not list
      multisigs (say so or list read-only); RecurringDueBanner /
      NotificationScheduler could add !activeAccount.multisig; a
      multisig-specific WalletConnect proposal alert; the engine's party()
      label for multisigs; whether subscriptions / spending limits /
      approvals list the staking tokens. Emulator checklist (9 steps) in
      the switcher builder's report.
- [x] Items 1 and 2 PROVEN LIVE IN-APP (2026-10-11; emulator, Expo Go,
      Metro at a004ba0, 2,356 modules; one prompt per operation; no
      dev-EOA funding; every hash checked on publicnode). PROFILES: the
      Developer chips "Off (mainnet) / Ethereum Sepolia / Base Sepolia /
      Arbitrum Sepolia / Hoodi / OP Sepolia", the hint naming five
      networks with chain ids and explorers, the pre-fill sentence
      excluding Hoodi; HOODI: banner, "Test mode is ON (Hoodi)…", no
      layer-2 note, endpoints "Hoodi — default (1 of 3:
      ethereum-hoodi-rpc.publicnode.com)", Home "Hoodi" 0 test ETH with
      links Send / Activity / NFTs / Approvals / Apps / Staking (no Swap,
      Upgrade, Multisig, Sessions, Guardians, Passkey, no token rows); the
      Staking screen on Hoodi (Lido's four quotes with source and date,
      Rocket Pool's two FAQ quotes with the "no risk page" sentence, the
      no-smart-account note, 0 balances, "Minimum deposit 0.01 test ETH;
      deposit fee 0.05% (both read just now)", the below-minimum and
      more-than-held refusals, "Nothing to claim…"); a 0.001 send refused
      for funds; the AA row "incomplete" with the NEW checked-and-found-
      none sentence and the pasted factory refused "has no code on this
      chain"; the readiness intro naming five networks; OP SEPOLIA: banner
      + the L1 note "(0x does not support OP Sepolia)", Home with the
      USDC row and Upgrade / Multisig links (no Staking), "Tokens · OP
      Sepolia" USDC 0x5fd8…30D7, the Kernel pre-fill VERIFIED ✓ and SAVED
      on the device, a send refused for funds; the custom form refuses
      560048 as "already built in as Hoodi" and the tick note lists the
      four remaining networks. STAKING ON SEPOLIA (Account 1): the
      deprecation sentence and Lido's quotes; STAKE → stETH 0.001:
      confirm "You send 0.001 test ETH / You receive ≈ 0.001 stETH /
      Simulated: 0.000999999999999999 stETH…", the rebasing note, fee
      0.00100003 gwei × 219,081 gas, the preview (stETH labelled
      "untracked token"), the generic risk lines, "Pre-flight simulation
      passed"; prompt "Stake 0.001 test ETH with Lido for stETH"; tx
      0x757548c10fbd15b66fda0fcad88fbfeaaf9e4484e940a73ca87f5517d4cb8bc9,
      block 11889090, input 0xa1903eab, value 1e15, gas 208,421, Submitted
      (sender Account 1, referral 0), minted 999,999,999,999,999 stETH /
      963,653,100,270,615 shares; the screen balance updated. STAKE →
      wstETH 0.0005 ("LIDO WSTETH CONTRACT (STAKE AND WRAP IN ONE
      STEP)", "You receive ≈ 0.000481826550135307 wstETH"): tx
      0x81e32fd5da0c5a4aec5a9312fd06877ff45f2acbe612f47eb853eea40df82d26,
      block 11889104, empty input (a plain transfer), 481,826,550,135,307
      wstETH minted = the simulated figure. WRAP 0.0005 stETH: step 1
      "approves exactly 0.0005 stETH, never more…" (prompt "Approve
      exactly 0.0005 stETH for Lido wstETH contract (wrap)"; tx
      0xdca94e499c145bebfa33c5bb4337fa24b059122900567e38e326dd07c22cae72,
      block 11889114, Approval 5e14), step 2 re-quoted after the approval
      with "Approval revoked" in the preview (prompt "Wrap 0.0005 stETH
      into wstETH"; tx
      0x9538b9f207ecaaf8e9fef59ecc3a84b49ccaf5a8c99cb86ecc79bd49e2a228f2,
      block 11889119, input 0xea598cb0, 481,826,550,135,307 wstETH;
      allowance 0 afterwards). UNWRAP 0.0004 wstETH: tx
      0x963909e560daa5b580852b51c6e2ddb26ad213bf62097b99c2898f6d4f0b1a74,
      block 11889130, input 0xde0e9a3e, event 415,087,130,304,122 stETH,
      the balance 1 wei less (the rebasing note's case). UNSTAKE: "…paused
      on Sepolia: its withdrawal queue reports that it is paused (read
      just now) and has never accepted a request…", Review disabled.
      CLAIM: "Nothing to claim…". SMART-ACCOUNT STAKE 0.0005 from
      0xD31c…D8FA: confirm with the bundler estimate 0.001454470713777846
      and the deposit row with its top-up, "Bundler gas estimate passed";
      prompt "Stake 0.0005 test ETH with Lido for stETH from your smart
      account"; userOpHash
      0x3a09d92df9b4a92d767a57cd7ac6db04f11a7572e069d4200bd1e65ed285cc5b,
      bundle tx 0x594a9399e71325cd63d023cc2560cfe683df9c9f615131263b7e88df4a7311f0
      (found via the EntryPoint logs), block 11889151, success, nonce 31,
      actualGasCost 0.0010078 ETH (the bundler's 2.04 gwei vs 0.001 gwei
      for the EOA sends — the headroom economics again), the deposit
      topped up to exactly the displayed figure, the Kernel received
      499,999,999,999,999 stETH. Amount 0 → "Enter an amount greater than
      zero."; on Base / Arbitrum / mainnet there is no Staking link, so
      the "No staking protocol…" sentence and the mainnet card are not
      reachable (by design). Funds after: Account 1 0.002619 ETH +
      0.000915 stETH + 0.000564 wstETH; Kernel 0.0123 ETH + 0.000447
      deposit + 0.0005 stETH. FINDINGS (fix slice dispatched): (1) BUG —
      a stake the account cannot afford shows the contract's revert
      ("execution reverted: ZERO_DEPOSIT"; for rETH "The deposited amount
      is less than the minimum deposit size") instead of "not enough
      ETH": prepareEvmSend (send.ts 538–546) retries estimateGas with
      value 0 when the first estimate fails, valid for plain transfers
      but wrong for payable calls; (2) the success copy says "The stETH
      balance on Home and here is read from the token itself…" while Home
      has no stETH row (the tracking step landed in item 3 after this
      pass; re-check); (3) the risk card on staking calls was generic
      (fixed in item 3 after this pass; re-check); (4) the smart-account
      success screen shows only the userOpHash, no bundle tx; (5) Hoodi's
      Home footer still offers "Recover an account with guardians"
      although Hoodi has no Kernel or RecoveryAction; (6) the custom
      form's placeholders "For example Hoodi" / "For example 560048" are
      now refused as built in; (7) copy — OP Sepolia's Tokens text
      mentions EURC (none there), the Developer hint says each test
      network's "smart-account path" runs (not Hoodi), the staking
      balances block does not say which account it shows when the toggle
      is on; (8) economics — the smart-account stake cost 0.0010078 ETH
      in fees for 0.0005 staked (bundler price ~2,000× the base fee).
      Emulator note: Expo Go's floating Tools button overlaps the Privacy
      switch at the bottom — scroll it up before tapping. End state:
      Home, Ethereum Sepolia, Account 1, light mode, Google IME,
      protection ON; the OP Sepolia Kernel factory saved on the device;
      Metro at a004ba0. UNVERIFIED: a live Hoodi transaction or Rocket
      Pool deposit (0 Hoodi ETH); the OP Sepolia smart-account path (no
      bundler saved there); whether the Hoodi Upgrade link flickers
      before the delegate read; TalkBack, dark mode.
- [x] Phase 18 pass findings FIXED (commit 9290864; check-token-send 70
      (was 56), check-staking 97 (82), check-home 88 (84), check-devmode
      305 (299), check-custom-networks 188 (183), check-tokens 136 (128);
      offline runner ALL GREEN in the CTO's isolated worktree on HEAD plus
      the slice: engine 906, app 7,421 across 51 suites, lint 0/0, tsc
      clean; five in-suite and five manual mutants caught; not seen on a
      device). (1) send.ts prepareEvmSend: a transaction WITH calldata is
      never re-estimated with value 0 (a payable call's behaviour depends
      on its value — the retry had turned "not enough ETH" into
      ZERO_DEPOSIT / the rETH minimum-deposit revert); plain transfers keep
      the retry request for request (pinned [value=amount, value=0] with
      the old sentence byte for byte); before any estimate a calldata
      transaction with a non-zero value is checked against amount +
      MIN_TRANSACTION_GAS (21,000) × maxFeePerGas — the intrinsic gas, a
      lower bound that never refuses something payable — with the refusal
      "Insufficient funds: sending X wei plus a worst-case fee of at least
      Y wei exceeds the balance of Z wei" under the existing title; an
      estimate the node refuses for funds gets one estimate and the fee
      title. (2) stakingSuccessBalanceNote has three pinned variants
      (regular account with stETH tracked → "on this screen and on Home";
      not tracked → "Home shows it once stETH is on this network's tracked
      tokens (Manage tokens)"; smart account → Home's rows show the regular
      account's balances); the screen checks the tracked list after the
      tracking step. (3) The smart-account staking success view mirrors
      SendScreen's block (waitForAaReceipt, "Bundling…", the timeout text,
      "Included on-chain — succeeded." / the revert box, the bundle hash as
      selectable text, the explorer button gated on explorerTxBase; eight
      strings pinned equal in both screens) — why the pass saw only the
      userOpHash is not known from the code (a receipt timeout is
      possible). (4) Home's guardian-recovery footer is gated on
      evmChain.kernelV33Verified (hidden on Hoodi AND on every network the
      user added, custom test networks included — CTO accepted: the
      recovery flow needs the Kernel guardian modules and RecoveryAction,
      which are not known to exist there). (5) The custom form's example
      is CUSTOM_NETWORK_EXAMPLE = Polygon Amoy / 80002 (the CTO's choice
      over the agent's Holesky / 17000: Holesky HAS STOPPED — on 2026-10-11
      holesky.drpc.org served block 5,765,077 about 130 days old and
      publicnode answered HTTP 404, so the form's freshness rule would
      refuse its own example; Polygon Amoy's public RPC served a head 1 s
      old, chain id 0x13882 re-read by the CTO; Linea Sepolia 59141 was
      the other live candidate); pinned: on the allow-list, not built in,
      passes the form's checks, the old Hoodi / 560048 pair refused.
      Holesky stays on the allow-list (a stale chain is refused by
      freshness, not by the list) — follow-up: drop it if the sunset is
      confirmed from an Ethereum Foundation source. (6) Copy from the
      profile table: tokens.ts testNetworkTokenValueSentence (USDC and
      EURC on Ethereum / Base Sepolia, USDC on Arbitrum / OP Sepolia,
      none on Hoodi or a custom network; every symbol named is a known
      token on that chain) — the CTO wired it into TokensScreen (outside
      the agent's allow-list); the Developer hint names the networks where
      the smart-account path runs, Hoodi excluded (check-devmode evaluates
      the clause from the screen's source against the real profiles);
      stakingBalancesHolderLine "Balances of your smart account 0x…" /
      "…regular account 0x…" from the address the balances were read for.
      Finding (8) (the smart-account stake's fee economics) is the known
      headroom cost, no change. Agent note: HEAD moved under it (795ddae,
      9482223, docs only) and it used git stash / pop once to measure
      baselines — the CTO confirmed 9482223 holds the intended STAKING.md
      text. UNVERIFIED (emulator): the success view's receipt within the
      120 s poll, the note variants after a real stake, the holder line,
      the hidden Hoodi footer, the placeholders, the unaffordable-stake
      refusal on a live node (the stake-limit reads run first).
- [x] Item 3 PROVEN ON THE EMULATOR (2026-10-11; Expo Go, Metro worktree
      moved to 4f9c946 with the engine built inside it, 2,333 modules; no
      repo files edited; 2 prompts in total — one unlock, one stake; the
      Privacy switch off for the pass and on again after; notes and
      screenshots in the scratchpad p18c). MULTISIG IN THE SWITCHER:
      "Multisig 2 (2-of-3)" listed last with the "Multisig" chip and
      "Multisig — operations need co-signers; Ethereum networks only"
      (content description "…, multi-signature account, 0x944c…0d38");
      chosen with 0 prompts: the notice ("…It cannot sign messages or
      connect to apps."), the EVM card 0.000506 test ETH with links
      Activity / NFTs / Approvals / Multisig only, "EntryPoint deposit
      (pays fees first): 0.000697 test ETH" masked to "•••• test ETH" by
      Hide amounts (a11y "…: hidden"), BTC/DOGE/SOL "Not available for a
      multi-signature account…", the footer sentence; Base Sepolia → "…is
      recorded on Ethereum Sepolia, and the Multisig screen builds its
      operations only there…"; Receive: the label, the sentence, a QR
      decoding (jsQR) to 0x944caA404e389b18b2fe251e969EdD7A220d0d38 and
      only "Copy address" (no Send, request, proof or smart-account box);
      Activity "Ethereum Sepolia · TESTNET · Multisig 2 (2-of-3)", 16
      rows, the deploying op read as "Smart-account operation (first
      operation; deployed the account): sent 0.0001 test ETH to
      0xb699…81fE" −0.003593 — the multisig is the sender, no row says
      "yourself"; refusals: Apps ("The in-app browser (Apps) is not
      available for a multi-signature account…" + the signer hint naming
      Account 1 in full + "Open the Multisig screen", which opened the
      list), Connected apps, Tokens → Send USDC ("Sends from a
      multi-signature account are signing requests for the co-signers;
      build one on the Multisig screen."); Approvals read-only ("No active
      approvals found in the searched range." — no Revoke to observe);
      the detail "Deployed; its signer set and threshold on-chain match
      this record."; after 70 s in the background the lock, Unlock = the
      ORDINARY prompt with "Use PIN"; back to Account 1 with 0 prompts.
      POLISH: Settings button "Connected apps" and the Apps blurb quoting
      it; "Find my tokens" listed stETH ("Liquid staked Ether 2.0",
      0.000915, 0x3e3F…40Af) and wstETH (0xB823…067b = the pinned Sepolia
      address), each tracked after "Track stETH?" / "Track wstETH?" (a
      fake "USDC" 0x240b…14aa got the look-alike warning; an untracked DAI
      left alone); Home shows "Rebasing token: the balance changes by
      itself; the preview can be off by a wei or two." under stETH and
      nothing under wstETH. STAKE 0.0002 → stETH (Account 1): the risk
      card is the single pinned line "This transaction goes to Lido's
      stETH contract on Ethereum Sepolia (0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af),
      pinned by this wallet from Lido's published list of deployed
      contracts." (no generic contract or contract-age line), preview "You
      receive 0.000199999999999999 stETH", prompt "Stake 0.0002 test ETH
      with Lido for stETH"; tx
      0xb6e51daa7520c386d7dafb230389421ea3845a4bddcc87f0ac2657f093820c9d,
      block 11889379, status 0x1, input 0xa1903eab, value 2e14, gasUsed
      110,501, Submitted / mint 199,999,999,999,999 / TransferShares
      192,730,620,054,123 and the EIP-7708 log; Account 1 stETH +2e14
      (1 wei more than the mint event — the rebasing case). A note added
      through Activity ("staking test") shows on all three rows of the
      transaction. Swap (no 0x key) and Sessions (nothing installed) had
      no success view to check. FINDINGS (fix slice dispatched): (1) the
      Staking success screen has NO private-note field (TransactionNoteField
      was wired into Send, Swap, Sessions and the WalletConnect sheet
      only); (2) the Tokens screen keeps Send buttons while a multisig is
      active (the gate refuses, so safe, but Home hides Send); (3) the
      Multisig list said "· not deployed yet" for the deployed multisig
      until its detail was opened (only openDetail refreshes); (4) the
      Activity sentence for a stake reads "Called 0x3e3F…40Af with 0.0002
      test ETH: received … stETH" without the pinned Lido label; (5)
      existing stETH / wstETH holdings are not tracked automatically and
      "Find my tokens" shows them as plain UNTRACKED tokens with no sign
      the wallet pins them; (6) the Home staking rows are titled by token
      NAME ("Liquid staked Ether 2.0", cut off) where USDC / EURC rows
      show the symbol, and the badges truncate to "stET" / "wstE"; (7)
      copy — (a) the switcher intro "Every account comes from your one
      recovery phrase…" with a multisig listed, (b) multisig Receive says
      "Ethereum" / "Only send ETH on the Ethereum network" on Sepolia, (c)
      NFTs says "this account's regular address" for a multisig, (d) the
      gate hint says "Switch to that account on Home, then open the
      Multisig screen" while offering "Open the Multisig screen" with the
      multisig still active, and the detail shows "New operation (send)"
      beside "Switch to that account on Home…", (e) Activity shows Account
      1 as "0x772e…F44F" rather than its label (the party() follow-up),
      (f) the Activity title "Ethereum activity" on Sepolia (pre-existing).
      NOT VERIFIED: the NFT-detail Send refusal (no NFTs), Revoke on
      Approvals (none in range), note fields on Swap and Sessions, the
      automatic tracking after a stake (both tokens were tracked before
      step 11). Funds: Account 1 ETH 0.002619 → 0.002419, stETH 0.000915
      → 0.001115, wstETH 0.000564; multisig unchanged. End state: Home,
      Ethereum Sepolia, Account 1, light mode, Google IME, protection ON,
      auto-lock 1 min; stETH and wstETH tracked on Sepolia; Metro at
      4f9c946.
- [x] Item 3 pass findings FIXED (commit 1b6b322; engine 913 — chains-evm
      651, +7 — check-activity 95 (was 73), check-staking 104 (97),
      check-tokens 150 (136), check-multisig 273 (252), check-home 94
      (88); offline runner ALL GREEN in the CTO's isolated worktree on
      HEAD plus the slice: app 7,491 across 51 suites, lint 0/0, tsc
      clean; every changed file's HEAD version fails its suite (restored
      from scratch copies, confirmed with cmp); not seen on a device). (1)
      Both Staking success views render TransactionNoteField above Done
      with the network captured at sending (sentNetwork set when sendEvm /
      sendAa resolve); the AA note moves from op:<userOpHash> to the
      bundle hash through the component's linkUserOperation, as on Send
      and Swap. (2) watch-only.ts tokensSendNote(account): the Tokens
      screen hides Send for a multisig ("Token sends from a
      multi-signature account are signing requests for its co-signers;
      build one on the Multisig screen.") and for a watch-only account
      ("This is a watch-only address: the wallet holds no key for it, so
      it cannot send these tokens." — watch-only had Send buttons too);
      the gate is unchanged. (3) multisig.ts refreshMultisigListDeployments
      (one eth_getCode per record STILL STORED UNDEPLOYED — deployed
      records are never re-read since nothing marks one undeployed; a
      failed read keeps the facts), run by the list's focus effect, then a
      reload if anything changed. (4) ENGINE (additive):
      ActivitySentenceContext.describeCall?(call {to, selector, value},
      {native, nativeSymbol}) consulted only for plain transfers and
      undecoded calls, the logs' sent/received text appended after a
      colon, a phrase accepted only when it starts with a verb in the
      exported ACTIVITY_CALL_VERBS (staked, wrapped, unwrapped, requested,
      claimed, burned added so a failure reads "tried to stake …"); seven
      tests incl. byte-identical fixture output with no hook, a null hook
      or an unknown verb. APP: activity-sentences.ts stakingCallPhrase /
      stakingContractLabel match the engine's STAKING_SELECTORS on the
      exact pinned contract (a stake needs a value, the others none),
      with the pinned contract passed in from ActivityScreen through
      SentenceRenderOptions.stakingContractAt (risk.ts already imports
      activity-sentences, so a value import back would be a require
      cycle); wordings "Staked X with Lido (stETH contract 0x3e3F…40Af)",
      "Staked X with Lido and wrapped it into wstETH (wstETH contract …)",
      "Wrapped stETH into wstETH with Lido (…)", "Unwrapped wstETH into
      stETH with Lido (…)", "Requested a withdrawal from Lido (withdrawal
      queue contract …)", "Claimed withdrawn test ETH from Lido (…)",
      "Burned rETH for test ETH with Rocket Pool (rETH contract …)";
      pinned contracts are named wherever a sentence mentions them
      ("Approved stETH for Lido wstETH contract 0xB823…067b (up to 0.0005
      stETH)"); the Rocket Pool deposit keeps the generic sentence (the
      pool is resolved per quote, not pinned). (5) token-discovery
      DiscoveredToken.knownStaking from tokens.ts knownStakingTokenAt
      (exact contract on that chain; Rocket Pool for rETH, Lido
      otherwise): tag "KNOWN STAKING TOKEN", sentence "This is the stETH
      contract this wallet pins from Lido's published list of deployed
      contracts. It is tracked only if you choose Track stETH."; the Track
      prompt unchanged, nothing auto-tracked; the pinned staking tokens
      join the look-alike reference set (a fake "stETH" elsewhere is
      flagged). (6) CAUSE: TokenRow titled every row by token.name and
      cut the badge with symbol.slice(0, 4) — storage was fine (discovery
      and the known-token table store the same symbol and name; Sepolia /
      Base USDC and EURC only looked right because name = symbol; Arbitrum
      USDC was already "USD Coin"); now the title is the symbol, the
      second line tokenRowSubtitle ("Liquid staked Ether 2.0 · ERC-20", or
      "ERC-20" when the name equals the symbol), the badge the whole
      symbol with numberOfLines 1 in a pill (minWidth 36, maxWidth 72,
      height 36, paddingHorizontal 5; adjustsFontSizeToFit avoided because
      RN 0.86.3's TextProps labels it iOS-only while ReactTextView.java
      implements it — contradictory; whether "wstETH" fits at 10 px bold
      is an estimate). (7a) accountsBackupHint(anyImported, keyless)
      gained an optional second argument (Settings → Accounts unchanged):
      the switcher reads "Every account here except the multi-signature
      ones comes from your one recovery phrase — backing up the phrase
      backs up all of those." (with imported accounts: "…except the
      imported, watch-only and multi-signature ones… Imported accounts
      are NOT backed up by the phrase: keep their private keys
      yourself.") plus MULTISIG_LIST_HINT ("Multi-signature accounts have
      no key of their own: this wallet holds one of their signers, a
      recovery-phrase account, and every operation also needs the
      co-signers. On another phone, add one again from its record on the
      Multisig screen."). (7b) Receive had the same bug for EVERY account
      (account.name / account.symbol): the EVM slot now uses
      evmChain.label and displaySymbol for the chain line, the title
      ("Receive test ETH"), the QR labels and "Only send test ETH on the
      Ethereum Sepolia network to this address."; its Send button keeps
      "Send ETH" (two suites pin the literal). (7c) watch-only.ts
      nftsOwnerSentence: "Shows the NFTs held by this multi-signature
      account's address, 0x…." / "…by the watched address, 0x…."; the
      other sentence byte-identical; no smart-account address lookup for
      either. (7d) multisigSignerHint: "This wallet's signer for {label}
      is {who}. While {label} is the active account, the Multisig screen
      only shows it; to build, approve or submit its operations, switch to
      that account on Home first."; "New operation (send)" only while this
      wallet's signer is the active account. (7e) NO engine change needed:
      the engine labels through nameFor; activityAccountLabels(accountList,
      multisigs) covers phrase and imported accounts plus the network's
      multisig records (watch-only excluded), order contact → account
      label → pinned staking label; the decoded account stays "yourself".
      (7f) The Activity title is "<network label> activity" ("Ethereum
      Sepolia activity"). THREAT_MODEL 7.4's current-state counts updated.
      UNVERIFIED (emulator): the note field on both staking views and the
      note moving after the receipt; the Tokens sentence and layout for a
      multisig / watch-only account; the list flipping to "deployed" on
      focus; the live stake tx 0xb6e51daa… reading "Staked 0.0002 test
      ETH with Lido (…)"; the KNOWN STAKING TOKEN rows; the badge fit; the
      switcher, Receive, NFTs, gate and detail copy; "Account 1" in the
      multisig's Activity; TalkBack and dark mode.

## Phase 18 status (2026-10-11)

Items 0 to 4 are landed and pushed. Proven live this phase: the Hoodi and
OP Sepolia built-in profiles through the app (Hoodi with every
smart-account feature stopped by the deployment checks; OP Sepolia with
its Kernel pre-fill verified and saved), staking with Lido on Ethereum
Sepolia from the regular account (stake to stETH and to wstETH, wrap,
unwrap, the paused-queue refusal) and from the smart account through
ZeroDev, the multisig in the account switcher with every refusal and the
ordinary unlock prompt, the pinned-contract risk line on a stake and the
rebasing note on Home. Built and verified offline: the notification icon
through the expo-notifications plugin, the staking engine with the Hoodi
claim flow and Rocket Pool, the polish list (notes on Swap and Sessions
success views, the Firebase questions answered from source), and the
fixes from both passes. After the status was first written, five more
slices landed and were each re-checked on the emulator (entries below
this section): the WalletConnect sent view with its note field (proven
live through the in-app browser), the read-only multisig list under
Settings → Accounts, Holesky retired from the custom allow-list, the
smart account's own history in Activity through a time-ordered merge of
four one-sided indexer streams, a React-free history controller, the
EIP-7708 protocol logs reconciled in the indexer path, reverted incoming
transfers shown as failed, and null receipts retried on an alternate
endpoint. Engine: 936 tests. App: 51 offline suites, 7,739 checks at
5bc71e5. The shareable page is at version 19 (46 proven live,
18 built, 1 designed, 34 not started); DEMO.md has steps 25 to 27;
THREAT_MODEL.md has T-77 and F-70 to F-73.

Findings for the Chairperson this phase: the rETH deposit lock documented
by Rocket Pool never starts in the deployed Hoodi code (F-72), and the
rETH burn pays out with a 2,300-gas stipend that likely fails for an
address running code (F-73, inferred); a stake from the smart account on
Sepolia cost about twice the staked amount in fees because ZeroDev's
price is far above the base fee there (F-71, the headroom economics; a
test-network cost); Holesky has stopped (its public RPCs serve a head
about 130 days old), so the custom-network form's example is now Polygon
Amoy; the iOS push entitlement was already present through
prebuild-config before the icon plugin entry was added.

Inputs that would unlock more: Hoodi test ETH at the dev EOA
0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C (the Hoodi staking leg: a
Lido stake, a withdrawal request and claim, a Rocket Pool deposit and
burn); a little OP Sepolia ETH there (the OP Sepolia smart-account path
with a bundler saved); the review of docs/DISCLOSURE_FINDINGS.md and the
disclosure decision; a decision on Firebase Cloud Messaging as the
longer-term push option (feature 93 in full).

Follow-ups (no inputs): a diagnostic line for rows whose receipt is
unavailable on every endpoint (the first-load retry did not recover the
five oldest rows; a refresh did); the "−0 test ETH" line on zero-value
approve rows; "Not enough ETH to pay the network fee." still hard-codes
ETH (a symbol argument across about 30 callers); the doubled rebasing
sentence on a stETH stake confirm; the Multisig list's deployment
refresh on focus (never observed: the emulator's record is already
deployed); a TalkBack pass; the reminders fixes re-run in the
development build with the new icon; the Polygon Amoy walk-through of
DEMO step 24; reading the exported CSV in a development build.
- [x] Phase 18 follow-ups, no inputs (commit c7400ee; check-wc 298 (was
      272), check-simulation 75 (62), check-multisig 282 (273),
      check-recurring 185 (174), check-custom-networks 199 (188); offline
      runner ALL GREEN in the CTO's isolated worktree on HEAD plus the
      slice: engine 913, app 7,561 across 51 suites, lint 0/0, tsc clean;
      every old file fails its suite from a scratch copy; not seen on a
      device). (1) WcSentView WIRED: new app/src/wallet/wc-sent.ts
      (WcSentResult with receiptState / success, wcSentResult,
      withSentReceipt, answerDappThenShow); on the regular-account
      transaction, smart-account transaction and wallet_sendCalls paths —
      and so the in-app browser's — the dApp is answered FIRST exactly as
      before, then the queue item completes, then the view shows (fakes
      prove nothing shows or completes while the answer is in flight; a
      failed reply still completes and shows); a batch shows the
      userOpHash and a 120 s background receipt wait adds the bundle hash
      to the same view (matched by item key) so the note moves; the view
      stays mounted under the lock and is drawn before the next request's
      sheet; Done clears it; the three Alerts are gone. BEYOND THE BRIEF
      (CTO accepted): the "Submitted, not yet included" alert is a view
      too (the dApp still rejected first, the note kept under the
      userOpHash), and a smart-account transaction whose receipt reports
      failure shows the revert warning (the old alert ignored the flag).
      Titles "Transaction sent" / "Transaction sent, dApp not notified" /
      "Batch sent to the bundler" / "Batch sent, dApp not notified" /
      "Submitted, not yet included"; the not-notified details end "…check
      the transaction in a block explorer before retrying anything." (the
      hash is on the view, not inline); the not-included detail names the
      two-minute wait and an ERC-4337 explorer; receipt lines "Waiting for
      the UserOperation receipt. The bundle transaction appears here once
      the operation is included.", Send's timeout and revert sentences,
      "Included on-chain — succeeded.". (2) simulation.ts
      describeAssetChanges(…, chainCaip2?) sets note: REBASING_TOKEN_NOTE
      on a token row that passes rebasingTokenNote on that chain (row text
      unchanged, pins untouched); BalanceChangePreview passes
      evmChain.caip2 and draws the muted line (the live stake case, the
      outgoing row, Hide amounts; no note for wstETH, another chain, a
      look-alike address, an approval, no chain). NOTED: the staking
      confirm already shows its own STETH_REBASING_NOTE, so a stETH stake
      may show two rebasing sentences — follow-up (drop one). (3)
      AccountsSection lists multisigs READ-ONLY under "Multi-signature
      accounts" — "Listed here for reference only. They are managed on
      the Multisig screen (Settings → Multi-signature accounts) and cannot
      be hidden here." — one line each ("Multisig 2 (2-of-3) · 0x944c…0d38
      · Ethereum Sepolia"; an unknown network shows its CAIP-2 id); nothing
      when there are none; the block holds no Button / Pressable / onPress
      / Switch (pinned); DEMO step 27's fallback line updated. (4)
      recurring.ts recurringChecksApplyTo (ready, address present, not
      watch-only, not multisig) used by RecurringDueBanner's eligible and
      NotificationScheduler's canPay — for a multisig only the local
      network-free pass runs (0 status reads and 0 fetches with a due
      payment stored for that owner; a phrase account makes 1 as the
      control). (5) DEMO step 24 rewritten for POLYGON AMOY (80002,
      polygon-amoy-bor-rpc.publicnode.com — agent probe 2026-10-11 05:27
      UTC: eth_chainId 0x13882, head 49,873,916 1 s old, ~1 s blocks;
      coin POL per ethereum-lists eip155-80002.json), the refusals and
      removal kept, stating the 2026-10-10 rehearsal used Hoodi before it
      became built in and that the Polygon Amoy walk-through is not
      rehearsed; warning 2's step-24 sentence updated. (6) HOLESKY
      RETIRED: the Ethereum Foundation's "Holešky Testnet Shutdown
      Announcement" (blog.ethereum.org/2025/09/01/holesky-shutdown-announcement,
      EF Protocol Support; the CTO re-fetched it: "As previously
      announced, the Holešky testnet has reached its planned end-of-life
      date and will be sunset shortly." / "…After this, Holešky will no
      longer be supported by client, testing or infrastructure teams.") —
      17000 removed from KNOWN_PUBLIC_TEST_CHAIN_IDS (order of the rest
      unchanged; the "never shrinks" comment corrected), new
      RETIRED_PUBLIC_TEST_CHAIN_IDS / retiredPublicTestChain /
      isStoredTestChainIdAccepted; the listing sentences are generated
      from the list; new refusal "Chain id 17000 is Holesky, a public test
      network that has reached its end of life and is no longer supported
      by Ethereum's client, testing and infrastructure teams, so it can no
      longer be added as a test network. Nothing was saved."; DESIGN (CTO
      accepted): a stored record for 17000 saved earlier as a test
      network is re-validated with { stored: true } and keeps loading as
      a test network — otherwise the strict parse would turn the whole
      custom list read-only; only new additions are refused; THREAT_MODEL
      T-72's network list and the DEMO text updated; the check fixtures
      moved to Linea Sepolia (59141) and main-network 59144. UNVERIFIED
      (emulator): the sent view's layout, back button, dark mode and the
      receipt line updating while open (WalletConnect and the browser);
      a new request's sheet waiting behind the view; the preview note
      under a stETH row; the Accounts list layout; the silent banner with
      a multisig active; the Polygon Amoy walk-through; the Holesky
      refusal on screen.
- [x] Fix slices RE-CHECKED ON THE EMULATOR (2026-10-11; Expo Go, Metro
      worktree at 5eb9dd1 with the engine built inside it — the app
      reported 2,232 modules against 2,333 at 4f9c946 while a non-lazy
      export of the same entry gave 2,411 and held the new strings; cause
      unknown; no repo files edited; 2 prompts in total, one per stake;
      no dev-EOA spending; every hash read on publicnode; notes in the
      scratchpad p18d). PASSED: (A) Home token rows titled USDC / EURC /
      stETH / wstETH with "ERC-20" or "<name> · ERC-20" under them, the
      whole symbol in the badge ("wstETH" fits; the pill is a wider oval),
      the rebasing note under stETH only; (B) the switcher intro exactly
      as pinned plus "To watch an address, use Manage accounts."; (C) with
      Multisig 2 active: Receive "Receive test ETH" / "Only send test ETH
      on the Ethereum Sepolia network to this address…", NFTs "…this
      multi-signature account's address, 0x944c…", Tokens with no Send and
      the multisig sentence, the Apps refusal with the new signer hint and
      the button opening the list, the list reading "… · deployed" at
      once, the detail without "New operation (send)", Activity titled
      "Ethereum Sepolia activity" with "Received 0.0006 test ETH from
      Account 1" / "…sent 0.0001 test ETH to Account 2"; 0 prompts each
      way; (D) a watch-only account: Tokens with no Send and the watch-only
      sentence; (E a) regular stake 0.0001 → stETH: the pinned Lido line
      only, prompt "Stake 0.0001 test ETH with Lido for stETH", success
      with the "on this screen and on Home" note and the note field; tx
      0x80c0327f210313eba9cdfb5440d6e6dde31182888ab9219e3a1ecafa6325acc8,
      block 11889750, status 0x1, minted 99,999,999,999,999; Activity
      "Staked 0.0001 test ETH with Lido (stETH contract 0x3e3F…40Af):
      received 0.000099999999999999 stETH" with "Note: p18d regular stake
      note" on all three rows; the older stake, wrap, unwrap, approve and
      stake-to-wstETH rows carry their pinned Lido labels; (E b)
      smart-account stake 0.0001: holder line "Balances of your smart
      account 0xD31c…D8FA" / "…regular account 0x772e…F44F" with the
      toggle each way, prompt "…from your smart account", "Bundling…
      waiting for the UserOperation receipt." then "Included on-chain —
      succeeded." about 35 s later, the bundle hash as text, the explorer
      button, the smart-account note and the note field; userOp
      0xf73d109cb563190df3d441f807771871ca04b6724ffe655b2795e0deeed8341f,
      bundle tx 0x65d23913c0c8af86e779f529f335d9b833d223fbfe7461a876beabe92ddf7204,
      block 11889779, success, nonce 32, actualGasCost 0.000778 ETH,
      Deposited 747,174,110,161,719 (= the displayed top-up), stETH
      +99,999,999,999,999; (E c) an unaffordable stake: "Insufficient
      funds: sending 1000000000000000000 wei plus a worst-case fee of at
      least 21000672000 wei exceeds the balance of 2318893341920775 wei."
      and no ZERO_DEPOSIT; (F) no guardian-recovery footer on Hoodi, back
      on Ethereum Sepolia; (G) "For example Polygon Amoy" / "For example
      80002"; (H) wstETH removed and found again as "KNOWN STAKING TOKEN"
      with the pinned-contract sentence, re-tracked; (I) the three Tokens
      sentences (Ethereum Sepolia USDC and EURC; OP Sepolia USDC; Hoodi
      none); (J) the Developer hint without Hoodi. Funds reconciled:
      Account 1 ETH 0.002419 → 0.002319, stETH 0.001215; Kernel ETH
      0.012300 → 0.011452, deposit 0.000447 → 0.000416, stETH 0.0006.
      FINDINGS (fix slice dispatched): (1) the longer switcher intro
      squeezes the list so the multisig row is cut off until the list is
      scrolled, with no scroll hint; (2) from Account 1's side, its sends
      to the multisig read "Sent 0.0006 test ETH to yourself" — the
      multisig address counts as the wallet's own, so it should be
      labelled "Multisig 2 (2-of-3)", not "yourself"; (3) in the
      multisig's Activity, top-ups from Account 1's smart account read
      "Smart-account bundle with 1 operation from other accounts" with no
      label for the wallet's own smart account; (4) GAP — the smart
      account's bundle transactions are not listed in Activity at all
      (the route takes a chain id and lists the active account's own
      address), so a smart-account note and its move to the bundle hash
      cannot be seen in the UI; (5) the unaffordable-stake title reads
      "Not enough ETH…" on a test network ("test ETH" elsewhere); (6) the
      "Track wstETH?" dialog does not say it is the pinned Lido contract
      (the row does); (7) copy with a multisig or watch-only account
      active: the Tokens intro still says "a smart-account send can pay
      it in USDC instead…", and Settings → Accounts' backup text still
      says "One recovery phrase backs up ALL of your accounts" while a
      multisig exists; (8) cosmetic: the wstETH subtitle is ellipsised on
      Home; wrap / unwrap / approve rows show "−0 test ETH" and each
      transaction appears as two or three rows (one "no amount") —
      pre-existing; (9) NOT RE-TESTED: the list flipping to "deployed" on
      focus (the record was already stored deployed); (10) the
      smart-account stake of 0.0001 cost 0.000778 ETH in fees (the
      headroom economics); (11) the module count; (12) dev only: the
      "Cannot connect to Expo CLI… Error: undefined" toast once. End
      state: Home, Ethereum Sepolia, Account 1, light mode, Google IME,
      protection ON, no watch-only account, the Staking amount field
      still holding "1"; Metro at 5eb9dd1.
- [x] Re-check findings FIXED, incl. SMART-ACCOUNT HISTORY IN ACTIVITY
      (commit 5eda245; engine 916 — chains-evm 654, +3 — check-activity
      138 (was 95), check-multisig 297 (282), check-tokens 158 (150),
      check-staking 108 (104), check-failover 156 (153), check-home 95
      (94); offline runner ALL GREEN in the CTO's isolated worktree on
      HEAD plus the slice: app 7,635 across 51 suites, lint 0/0, tsc
      clean; every old file fails its suite from a scratch copy; not seen
      on a device). (1) AccountSwitcher: the intro is a one-line "What is
      backed up?" expander (▸ / ▾) inside the FlatList's header, closed by
      default, so it scrolls with the rows; the list is the only scrolling
      area (grow / shrink explicit), persistentScrollbar (Android, in the
      installed ScrollView.d.ts), and "More accounts below — scroll the
      list." while rows sit below the fold (switcherListOverflows);
      reachability at 1080×2400 REASONED from the styles (about 470 dp for
      the list; three phrase rows plus a multisig row about 440 dp), not
      measured; four mutants caught. (2) ACTIVITY LABELS: engine
      ActivitySentenceContext.selfAddresses (optional; without it every
      sentence unchanged; 3 tests); app activityAddressSets — "yourself"
      only for the active account's own address and, for a regular
      account, its own smart account; every other account's smart account
      and every stored multisig are DECODED with amounts and NAMED; other
      accounts' own addresses are not added (a transfer from Account 2
      still reads "from Account 2"); new shapes "Smart-account operation
      by <name>: …" and "<name> received / sent …"; the label "Account 1's
      smart account" uses the typographic apostrophe like risk.ts; pinned
      from the two live transfers rebuilt synthetically: Account 1's side
      "Sent 0.0006 test ETH to Multisig 2 (2-of-3)", the multisig's side
      "Received 0.0006 test ETH from Account 1", the top-up "Smart-account
      operation by Account 1's smart account: sent 0.0006 test ETH to
      yourself" (was "Smart-account bundle with 1 operation from other
      accounts"), Account 1's side "Smart-account operation: sent 0.0006
      test ETH to Multisig 2 (2-of-3)". (3) SMART-ACCOUNT HISTORY: the
      engine's indexerHistoryProvider().getHistory(address, cursor) takes
      any address with a cursor holding only that query's pageKeys and
      two alchemy_getAssetTransfers requests (from / to) per call
      (indexer-history.ts ~263–299), so new app/src/wallet/
      smart-account-history.ts (withSmartAccountHistory,
      mergeSmartAccountEntries, freshHistoryEntries, isSmartAccountEntry)
      wraps the INDEXER provider only: ONE extra getHistory per page (two
      requests, pinned), the account's own rows the same objects in the
      same order, a smart-account row whose hash is already listed
      dropped within and across pages, a failed smart-account query
      leaves the own rows and stops that stream until pull-to-refresh;
      useHistory({ smartAccount, ready }) / loadHistoryPage(…,
      smartAccount); historySmartAccountFor = the recovered account else
      the Kernel counterfactual, none for a 7702 owner, SimpleAccount,
      multisig or watch-only; ActivityScreen waits for the AA config so
      the list is fetched once and shows a "smart account" chip; strings
      'Your smart account (0x…) is listed too. Its rows are marked "smart
      account", and their direction and amount are what the smart account
      sent or received.', "Your smart account's transactions (…) could not
      be loaded right now, so only this account's own address is listed.
      Pull down to try again.", "…are not listed: without a history
      indexer the wallet searches only this account's own address. A
      history indexer (Settings → Ethereum history indexer) lists both."
      (the logs fallback scans windows per address and is skipped);
      the CSV direction cell reads "Sent (smart account)"; a note under
      op:<userOpHash> resolves on the bundle row (pinned). CAVEAT: an
      operation that moves no value (a revoke, a session install) produces
      no asset transfer and will not appear; the live Alchemy answers for
      a Kernel account, Base and Arbitrum are unverified. (4)
      describeStakingError(e, evmChain.displaySymbol) → "Not enough test
      ETH to cover this amount plus the network fee."; the same hard-coded
      'ETH' fixed in WcApprovalSheet (two calls) and WalletConnectContext
      (two, via evmProfileByCaip2(item.chain)?.displaySymbol); LEFT: "Not
      enough ETH to pay the network fee." (send.ts ~1307; pinned in
      check-nfts and check-staking; needs a symbol argument across ~30
      callers — follow-up). (5) trackDiscoveredPrompt appends
      knownStakingPinnedSentence for a pinned token ("Contract 0xB823…067b
      on Ethereum Sepolia. This is the wstETH contract this wallet pins
      from Lido's published list of deployed contracts. Anyone can create
      a token with any name and symbol; track it only if this is the
      contract you expect."); a look-alike never gets it. (6)
      token-gas.ts tokenSendFeeSentence(chain, { keyless }) drops the
      USDC clause for a watch-only or multisig account ("The network fee
      for a token send is normally paid in test ETH, not in the token.");
      AccountsSection passes the keyless kinds to accountsBackupHint;
      Settings → Backup says "ALL" only with no watch-only or multisig
      account listed and adds MULTISIG_LIST_HINT when a multisig exists.
      (7) Home token subtitles numberOfLines 2; history.ts
      transactionsWithTokenAmounts / hidesZeroNativeAmount hide the
      "−0 test ETH" line of a zero-value native row whose token row is
      loaded (a screen reader hears "no amount"); approve rows keep "−0"
      (the indexer reports no token transfer); the duplicate rows per
      transaction unchanged. UNVERIFIED (device): every layout change,
      font scaling, TalkBack, dark mode, the real indexer answers for the
      smart account and the chip.
- [x] Smart-account history and the sent view PROVEN ON THE EMULATOR
      (2026-10-11; Expo Go, Metro worktree at b80b19d with the engine
      built inside it, 2,359 modules; no repo files edited; 2 prompts in
      total, both for the Uniswap swap; no dev-EOA spending; notes in the
      scratchpad p18e). (A) ACTIVITY AS ACCOUNT 1 on the saved Sepolia
      indexer: the "listed too" note exactly as pinned; 88 entries of
      which 38 carry the "smart account" chip; the staking bundle
      0x65d23913… (block 11889779, status 0x1) shows as five
      smart-account rows reading "Smart-account operation: staked 0.0001
      test ETH with Lido (stETH contract 0x3e3F…40Af): received
      0.000099999999999999 stETH" (+0.000099 stETH, two "no amount",
      −0.0001 test ETH, −0.000747 test ETH the EntryPoint top-up), EVERY
      ONE with "Note: p18d kernel stake note" — THE NOTE SAVED UNDER THE
      USEROPHASH RESOLVES ON THE BUNDLE TRANSACTION; Kernel top-ups
      "Smart-account operation: sent 0.0006 / 0.0012 test ETH to Multisig
      2 (2-of-3)"; Account 1's own sends "Sent 0.0006 / 0.002 test ETH to
      Multisig 2 (2-of-3)" (no "yourself"); pull to refresh: still 88, no
      duplicates; as Multisig 2 (0 prompts each way, 16 entries, "End of
      history."): "Smart-account operation by Account 1's smart account:
      sent 0.0006 test ETH to yourself", "Received 0.0006 test ETH from
      Account 1", "Smart-account operation (first operation; deployed the
      account): sent 0.0001 test ETH to Account 2". (B) WITHOUT THE
      INDEXER (cleared through its dialog and re-entered from a 0600 file
      through the ADBKeyboard broadcast; the stored value matched
      ALCHEMY_SEPOLIA without being printed): "Showing tracked-token
      transfers from recent blocks (no indexer is configured)…" and
      "Your smart account's transactions (0xD31c…D8FA) are not listed:
      without a history indexer…", 9 entries; restored → "Verified ✓",
      88 entries with the note again. HYGIENE: the driver printed the
      indexer field ONCE into its local tool output before its dump helper
      masked keys; the key went nowhere else (no file, no log kept); the
      helper now masks it. (C) SWITCHER: "What is backed up? ▸" collapsed
      by default, the Multisig 2 row fully visible (list ends at y 1405
      of 2400); expanded ▾ shows the full pinned text and the hint "More
      accounts below — scroll the list." (D) wstETH removed and found
      again under KNOWN STAKING TOKEN; "Track wstETH?" reads "Contract
      0xB82381A3fBD3FaFA77B3a7bE693342618240067b on Ethereum Sepolia. This
      is the wstETH contract this wallet pins from Lido's published list
      of deployed contracts. Anyone can create a token with any name and
      symbol; track it only if this is the contract you expect."; tracked
      again. (E) MULTISIG 2 ACTIVE: the Tokens intro without the USDC
      clause plus the multisig sentence; Settings → Accounts
      "Multi-signature accounts" / "Listed here for reference only…" /
      "Multisig 2 (2-of-3) · 0x944c…0d38 · Ethereum Sepolia"; Backup "One
      recovery phrase backs up every account in the list above that this
      wallet holds a key for, including hidden ones, on every chain." +
      MULTISIG_LIST_HINT. (F) Staking with amount 1: "Not enough test ETH
      to cover this amount plus the network fee." + the exact insufficient-
      funds sentence; nothing sent (the field had reset to 0.001 on
      relaunch, expected after the force-stop). (G) Home: the wstETH
      subtitle wraps to two lines; Activity wrap rows "−0.0005 stETH" /
      "+0.000481 wstETH" / "no amount", unwrap "+0.000415 stETH" /
      "−0.0004 wstETH" / "no amount" (no "−0 test ETH"); the approve row
      keeps "−0 test ETH" as designed. (H) THE SENT VIEW, LIVE THROUGH
      THE IN-APP BROWSER: Uniswap connect (1 prompt), a 0.0001 test ETH →
      USDC swap ("You receive 5.202756 USDC", "Pre-flight simulation
      passed", 1 prompt) → the NEW "Transaction sent" view with "Sent for
      app.uniswap.org.", the hash and "Note (private, this phone only)";
      no alert; tx
      0x105905d48c3a5eb21a4845c3adaa9df329d8f2f47abf82f75e90f75dd751c5bb,
      block 11890525, status 0x1, gasUsed 144,120, USDC Transfer
      5,202,756 to Account 1 (= the preview); the note "p18e uniswap swap
      note" shows on all three Activity rows; disconnected from the bar's
      panel. Funds: Account 1 ETH 0.002319 → 0.002219, USDC +5.202756,
      nonce 24 → 25; Kernel and the multisig unchanged. FINDINGS (fix
      slice dispatched): (F1) LOAD MORE DUPLICATES ACROSS PAGES — tx
      0x341db91c (Account 1 → Kernel, 0.0015) appears on page 1 as the
      smart-account row "Sent 0.0015 test ETH to yourself · +0.0015 ·
      smart account" and on page 2 as Account 1's own "−0.0015":
      freshHistoryEntries drops a smart row whose hash is already listed
      but never removes an earlier smart row when the own row arrives
      later, and the two streams page independently (25 per direction);
      (F2) AFTER LOAD MORE THE LIST IS OUT OF TIME ORDER — page 2 is
      appended below page 1 (88 → 138 entries: 28 Sep rows, then 9 Oct, 5
      Oct, 4 Oct … 27 Sep, then 3 Oct to 1 Oct smart-account rows); even
      page 1 mixes ranges (the smart account's incoming transfers reach 1
      Oct while its outgoing stop about 3 Oct); (F3) the Load more footer
      once showed only a spinner for over 10 minutes ("VirtualizedList:
      … slow to update", dt 9,506 ms); after reopening, page 2 loaded
      normally; lead, unverified: loadMore reads the cursor inside a
      setState updater (a phase 3 pattern); (F4) EntryPoint prefund and
      top-up transfers (Kernel → EntryPoint, internal) show as plain "Sent
      transaction, −0.000923 test ETH, smart account" rows with no
      sentence, and the staking bundle's "−0.000747" row could be read as
      an amount staked; (F5) rows render before their sentence (about a
      page behind while scrolling; a screen reader hears the shorter
      label first); (F6) Done on the sent view with the keyboard open
      saves the note ("Note saved.") but needs a second tap to close;
      (F7) observations: the Uniswap risk card adds "Contract age could
      not be checked on this endpoint. It has had code for at least the
      last 1,024 blocks (about 3 hours), the oldest state this endpoint
      serves."; the floating "Connected apps — … disconnected." notice
      followed onto Activity until dismissed; (F9) the module count
      (2,359 vs 2,232 / 2,411) is still unexplained. End state: Home,
      Ethereum Sepolia, Account 1, light mode, Google IME, protection ON,
      indexer restored and verified, no browser connection, wstETH
      tracked; Metro at b80b19d.
- [x] Merged-history findings FIXED (commit 22d625c; engine 920 — chains-evm
      658, +4 — check-activity 188 (was 138), check-notes 204 (191);
      offline runner ALL GREEN in the CTO's isolated worktree on HEAD plus
      the slice: app 7,698 across 51 suites, lint 0/0, tsc clean; 25 of 26
      hand mutants caught — the 26th, "dispose publishes", is equivalent
      to the original because dispose already bumps the generation; every
      old file fails its suite from a scratch copy; not seen on a device).
      (F1 + F2) THE MERGE RULE: engine indexerHistoryProvider gains
      direction 'both' | 'sent' | 'received' (default 'both' unchanged)
      and HistoryEntry an optional counterparty (declared in
      core/history/types.ts); the app's history.ts indexerHistoryStreams
      opens FOUR one-sided streams (own sent / received, smart sent /
      received — the two-sided provider pages its two queries
      independently, which is why one page already mixed time ranges),
      each in block order with a buffer, a cursor and a FRONTIER (the
      block of the oldest entry fetched; +∞ before the first fetch); the
      bound is the HIGHEST frontier among streams that still have pages;
      an entry is listed only when its block is STRICTLY ABOVE the bound
      (a page boundary can split a block and one transaction yields
      several entries — the agent's deviation from the CTO's "at or
      after", accepted); while fewer than 50 entries are listable the
      stream(s) at the bound are fetched, at most 8 rounds per page (both
      judgements); once no stream has more, everything left is listed;
      newest block first, within a block the account's own rows first.
      SAME TRANSACTION IN BOTH STREAMS: the account's own entries are the
      provider's objects, recorded in a WeakSet involvesSmartAccount when
      the smart account has an entry with that hash (chip "with smart
      account", spoken "with your smart account"); the smart account's
      mirror entries are dropped; its other entries are marked copies
      (smartAccount: true, uid prefix smart-account:); a self-transfer is
      listed once. FAILURES: an own-stream failure fails the page (rounds
      already done are kept; the retry neither repeats nor skips); a
      smart-stream failure drops both smart streams and their buffers,
      reports 'failed', and stops until a reload. LIVE CASE 0x341db91c:
      listed once as Account 1's own −0.0015 row with the chip, sentence
      "Sent 0.0015 test ETH to your smart account" (selfNames names the
      active account's own smart account; was "to yourself"); the smart
      account's own operations still read "Smart-account operation: …".
      createMergedHistoryFeed replaces withSmartAccountHistory /
      freshHistoryEntries / mergeSmartAccountEntries; useHistory
      openHistorySession; the cursor path and its failover serve only
      the non-indexer sources; request volume 4 on the first page, up to
      8 per skewed page. Pinned with fakes: own pages ending earlier and
      the reverse, one stream ending first, an empty stream, a smart
      stream failing mid-way, an own failure then retry, the live case
      with the smart page a page earlier, within-block order, request
      counts through the real engine provider, the CSV in list order with
      no duplicate hash + direction + amount rows. (F3) THE RACE, from
      the installed ReactFabric-dev.js 6966–6971 (React 19.2.3 / RN
      0.86.3): a setState updater runs eagerly only with no other update
      pending; Activity updates constantly while scrolling, so the old
      loadMore's cursor read inside an updater was deferred, the load
      returned early with no cursor, and the deferred updater then set
      loadingMore true with nothing to clear it (reasoned, not
      reproduced). New React-free app/src/wallet/history-controller.ts
      (useHistory a thin wrapper): the cursor and buffers live in the
      session, an in-flight flag allows one load-more at a time, a
      generation counter drops answers from an old session after a
      reload, each page races a 60 s timeout, a timed-out load keeps
      running and the retry joins it or takes its result; footer states
      spinner → "Could not load more — tap to retry" (tappable, with the
      technical line; HISTORY_PAGE_TIMEOUT_MESSAGE "The history endpoint
      did not answer within 60 seconds.") / "Load more" / "End of
      history."; a first page that times out shows the existing error
      screen with Retry. NOT addressed: the "VirtualizedList … slow to
      update" warning (a performance signal). (F4)
      entryPointRowSentence for native rows of a smart account's history
      (smart-account rows, and every row while a multisig is active)
      whose counterparty is EntryPoint v0.7: out "EntryPoint deposit:
      <exact amount> test ETH set aside for this smart account's network
      fees", in "EntryPoint payout: <amount> test ETH paid to this smart
      account by the EntryPoint" (WORDING DECISION, accepted: from
      v0.7.0 StakeManager.sol / EntryPoint.sol, ETH sent to the
      EntryPoint is credited to the deposit, unused prefund returns to
      the deposit and is not sent, and ETH leaves only through
      withdrawTo, withdrawStake or the beneficiary payment, so an
      incoming transfer cannot be named more precisely without guessing);
      the row sentence wins over the transaction sentence, so the staking
      bundle's −0.000747 row no longer reads "staked …"; pinned with
      747,174,110,161,719 wei and the rounded 0.000923 (its exact wei is
      not on record). (F5) a row whose sentence may still arrive gets the
      label "Transaction, details loading. " + the short label
      (decoder.mayDecode; stops once a decode is cached or failed); the
      EntryPoint sentence is computed synchronously; the last decoder
      setup is memoised (8 kept) so a return to the screen shows earlier
      sentences at once. (F6) CAUSE: no note view set
      keyboardShouldPersistTaps, so RN's default 'never' swallowed the
      first tap to dismiss the keyboard — on EVERY note view;
      TransactionNoteField exports NOTE_VIEW_SCROLL_PROPS ('handled') and
      dismissKeyboardThenClose (notes.ts closeNoteView: dismiss, then
      close), applied to Send ×2, Swap ×2, Staking, the Sessions progress
      view and WcSentView. THREAT_MODEL 7.4 counts updated. UNVERIFIED
      (device): the chip, footer, labels and TalkBack; the dismiss-then-
      close order incl. whether the keyboard stays open after popToTop;
      the real Alchemy answers for one-sided queries on a Kernel account;
      "Load more" after an empty 8-round page.
- [x] Merged history PROVEN ON THE EMULATOR (2026-10-11; Expo Go, Metro
      worktree at 5d5aeaf with the engine built inside it, 2,360 modules;
      no repo files edited; 1 prompt in total, the stake; no dev-EOA
      spending; notes and the full masked row lists in the scratchpad
      p18f). (A) First page 59 entries (26 "smart account", 0 "with smart
      account"), dates non-increasing; the staking bundle's −0.000747 row
      reads exactly "EntryPoint deposit: 0.000747174110161719 test ETH set
      aside for this smart account's network fees" and its other four
      rows keep the staked sentence and "Note: p18d kernel stake note";
      the −0.000923 row reads "EntryPoint deposit: 0.000923697750716462
      test ETH …" (now on record: 923,697,750,716,462 wei, tx
      0xb62e5573…fb47d, 2026-10-03); all 20 Kernel → EntryPoint rows read
      as deposits; no row anywhere says "to yourself" for the smart
      account. (B) LOAD MORE to the end: 59 → 107 → 139 with "End of
      history."; NO TIME-ORDER VIOLATION over all 139 rows (18 h → 10 Oct
      → 9 Oct → 5 → 4 → 3 → 2 → 1 Oct → 28 → 27 Sep, incl. across page
      boundaries; rows 75–115 matched minute by minute against both
      addresses' indexer timestamps); tx 0x341db91c appears exactly ONCE
      (row 102, Account 1's own −0.0015 with "with smart account" and
      "Sent 0.0015 test ETH to your smart account"); the 7 hashes both
      streams share appear only as Account 1 rows with that chip (10 rows);
      66 "smart account" rows; the footer never showed "Load more", a
      spinner or the retry text because onEndReached (threshold 0.4)
      prefetched every page within one ~12 s scroll step — the F3 retry
      and timeout path is unobservable without a slow or failing indexer.
      (C) Pull to refresh after the full load: back to 59, the first 62
      rows identical incl. sentences and notes. (D) Multisig 2 (0 prompts
      each way): 16 entries, "Smart-account operation by Account 1's smart
      account: sent 0.0006 test ETH to yourself", "Received 0.0006 test
      ETH from Account 1", the deploying op, "EntryPoint deposit:
      0.00359334246196974 test ETH …". (E) ONE-TAP DONE: stake 0.0001 →
      stETH, confirm as before (max fee 0.00000003 gwei × 121,752 gas),
      prompt "Stake 0.0001 test ETH with Lido for stETH", the note "p18f
      one-tap" typed with the keyboard open and ONE tap on Done closed
      keyboard and view together; Activity shows the note on all three new
      rows with the staked sentence; tx
      0x1fd6109a1d263ce35447a93b9dfdab48e66540ea723b98f22ba8b03cc61e4812,
      block 11891250, status 0x1, gasUsed 110,501 at 16 wei, Submitted
      1e14, mint 99,999,999,999,999; Account 1 stETH exactly +1e14 (the
      rebasing case again). (F) The "Transaction, details loading." label
      was caught on rows while scrolling and gone on later reads; the
      first ~6 s cannot be observed with uiautomator. (G) The export
      opened the chooser with shiba-activity_eip155-11155111_0x772e-F44F_2026-10-11.csv;
      the file is unreadable in Expo Go (run-as: not debuggable), so its
      order was not checked. Funds: Account 1 ETH 0.002219 → 0.002119,
      stETH 0.001315; Kernel and multisig unchanged. FINDINGS (fix slice
      dispatched): (1) EVERY POST-GLAMSTERDAM ETH MOVEMENT IS LISTED
      TWICE — the indexer reports each EIP-7708 protocol log as an ERC-20
      transfer (category "erc20", rawContract 0xff…fe, value null;
      confirmed in the raw alchemy_getAssetTransfers answer for the
      staking bundle), which Activity shows as extra "no amount" rows (34
      of 139; 8 of the multisig's 16) and exports to the CSV; asset-diff /
      erc20-logs / activity-decode already treat 0xff…fe as native, the
      indexer history path does not; (2) A REVERTED INCOMING TRANSFER
      SHOWS AS RECEIVED — row "Failed: tried to send 0.003 test ETH to
      your smart account. Received transaction, +0.003 test ETH, 1 Oct
      2026, smart account" for tx 0x8b7463c4…8871e (status 0x0 on 1rpc
      and drpc; publicnode returns null), sent by the dev EOA, not the
      wallet, so the sentence also names the wrong actor (age unknown);
      (3) 35 of 139 rows have no sentence, all 9 Oct or older, some of
      which had sentences in p18e — lead: publicnode returned null for
      every 1–4 Oct receipt asked (1rpc served them) and a failed decode
      stays failed for the session; (4) the new merge pages 59 / +48 /
      +32 against 88 + 50 before; (5) the module count 2,360. End state:
      Home, Ethereum Sepolia, Account 1, light mode, Google IME,
      protection ON; Metro at 5d5aeaf.
- [x] Merged-history pass findings FIXED (commit 5bc71e5; engine 936 —
      chains-evm 674, +16 — check-activity 225 (was 188), check-notes 206
      (204), check-token-history 51 (49); offline runner ALL GREEN in the
      CTO's isolated worktree on HEAD plus the slice: app 7,739 across 51
      suites, lint 0/0, tsc clean; 35 hand mutants caught; every old file
      fails its suite from a scratch copy; the two new fixtures hold no
      key-like strings (CTO grep); not seen on a device). (1) RAW ANSWER
      (one read-only alchemy_getAssetTransfers for the staking bundle,
      the key only inside the script's process, nothing but the JSON
      printed; now the fixture
      test/fixtures/indexer-history/sepolia-staking-bundle-sent.json):
      each ETH movement appears TWICE — an "internal" record (asset
      "ETH", rawContract.address null, rawContract.value the exact wei:
      0x02a78d076beb37 = 747,174,110,161,719 to the EntryPoint,
      0x5af3107a4000 = 1e14 to stETH) and an "erc20" record (uniqueId
      <hash>:log:18 / :log:21, rawContract.address 0xff…fe, value null,
      asset "", decimal null, rawContract.value the same wei, equal to
      the receipt's log data). ENGINE indexer-history.ts
      reconcileProtocolLogs (per query): an "erc20" record at the
      EIP-7708 system address (isEip7708TransferLogAddress) is never a
      token — dropped when a native record of the same hash, from, to
      and amount exists; converted to a native entry (its log uid, no
      symbol) when rawContract.value is readable; otherwise dropped;
      counts in the new optional HistoryPage.omitted
      ('eip7708-duplicate' / 'eip7708-unreadable'; core/history/types.ts).
      BEYOND THE BRIEF (accepted): the indexer lists a transaction's
      natives before its logs, so a page boundary can split them — the
      cursor gains optional co / ci fields carrying the unmatched
      movements of the page's oldest block (at most 64; written only when
      that side's page held protocol logs or received a carry; a
      malformed carry is refused "Unrecognized history cursor"). Answers
      without protocol logs yield byte-identical entries and cursors
      (2,000 random answers old vs new). The app's logs fallback
      (token-history.ts) needed no change: it queries one tracked
      contract at a time and the engine's getErc20Transfers already drops
      0xff…fe — now pinned incl. an endpoint ignoring the address filter
      and a stored "token" at 0xff…fe. (2) tx 0x8b7463c4…8871e (dev EOA
      → the Kernel account, 0.003 ETH, gas limit 21,000, status 0x0, no
      logs; fixture from publicnode + 1rpc): activity-sentences.ts
      entryWithReceiptStatus marks every row of a decoded status-0
      transaction failed — an incoming row is titled "Failed — nothing
      was received" with no amount (spoken "…, no amount, …"), the CSV
      direction "Received (failed)" / "Received (smart account) (failed)"
      with an empty amount cell and the asset named; a failed sent row
      keeps "Sent (failed)" with its attempted amount; an EntryPoint row
      of a reverted transaction no longer claims a deposit; the engine's
      activity-decode.ts gains the optional recipientSideFailures setting
      (the app passes it): when the viewing account did not send —
      "Failed: an incoming transaction from 0x16DA…aC5C to your smart
      account (0.003 test ETH) was reverted, so nothing was received"
      (the own address reads "this account"; the amount omitted at 0) /
      "Failed: a transaction from <sender> to <recipient> was reverted,
      so nothing in it happened"; unchanged without the setting and for
      the account's own failures. (3) ROOT CAUSE READ TODAY: publicnode's
      Sepolia endpoint balances two backends — in eight batched
      eth_getTransactionReceipt reads paired with web3_clientVersion, the
      four answered by reth/v2.7.0 returned a NULL receipt (while still
      returning the transaction) and the four by Geth/v1.17.7 returned
      status 0x0; 1rpc served the receipt (one eth_getTransactionByHash
      there answered HTTP 502). FIX: for a row the history listed as
      mined, a null transaction or receipt is asked ONCE more on the next
      healthy built-in default endpoint (findAlternateDefaultUrl — never
      around a user override; found once per decoder); still null → the
      row is "unavailable" (unavailableIds()), not failed, cleared by a
      pull-to-refresh; reverted, malformed and pending answers are never
      retried; pinned with two fake endpoints (null then served; both
      null → unavailable then retried after refresh; reverted never
      retried; malformed, pending, a dead alternate, no alternate, a
      failing finder, a row not listed; the finder called once; one test
      through the real config/networks.ts with a probe). THREAT_MODEL 7.4
      counts updated. UNVERIFIED: the row title, label and export on a
      device; whether the indexer lists every value transfer as
      "internal" (if it misses one, the matching log becomes a native
      row — reasoned); a live page boundary splitting a transaction; how
      many of the 35 sentence-less rows the retry recovers.
- [x] History fixes PROVEN ON THE EMULATOR (2026-10-11; Expo Go, Metro
      worktree at ace3451 with the engine built inside it, 2,360 modules;
      0 prompts; nothing sent; no repo files edited; masked row lists in
      the scratchpad p18h). (1) EIP-7708 DUPLICATES GONE: Activity as
      Account 1 lists 83 + 32 = 115 entries (was 59 / 107 / 139) and the
      "no amount" rows fell from 34 of 139 to 9 of 115 — diffed against
      the previous list, every protocol-log duplicate is gone (stakes,
      the swap, multisig fundings, the 0.004 / 0.012 receipts, the
      recurring payments, the 9 Oct ops now reading only as their
      EntryPoint deposit rows); plain sends and receives carry no extra
      row; the nine left are the zero-ETH legs of pre-fork token
      transactions ("Unwrapped wstETH …", "Wrapped stETH …", "Sent 4 USDC
      to your smart account", "Swapped 1 USDC for …", the Permit2 one) and
      the reverted transfer. (2) THE REVERTED INCOMING TRANSFER (row 100):
      title "Failed — nothing was received", no amount, sentence "Failed:
      an incoming transaction from 0x16DA…aC5C to your smart account
      (0.003 test ETH) was reverted, so nothing was received", chips
      "smart account" and "failed"; label "…. Failed — nothing was
      received, no amount, 1 Oct 2026, smart account, failed"; the
      separate successful 0.003 receipt unchanged. (3) SENTENCES: 5 rows
      without one after the first full load (the 27–28 Sep swap legs and
      a Permit2 approve), the same 5 after 30 s and a scroll back, and 0
      after a pull-to-refresh and a second full load ("Swapped 1 USDC for
      test ETH on Uniswap.", "Approved USDC for Permit2 (unlimited).",
      "Received 0.001 test ETH from 0xdB56…7898.") — the refresh path
      works; time order non-increasing in every pass; tx 0x341db91c once
      (row 78, "with smart account", matched by amount, date and
      direction against the indexer). The footer: onEndReached prefetched
      during slow scrolls; a fast fling stopped at "Load more", one tap
      → 115 and "End of history.". MULTISIG 2 (0 prompts each way): 8
      entries (was 16), 0 "no amount" (was 8), the deposit row and the
      two "by Account 1's smart account" rows intact. Export chooser
      shows shiba-activity_eip155-11155111_0x772e-F44F_2026-10-11.csv.
      Endpoints: Sepolia "default (1 of 4:
      ethereum-sepolia-rpc.publicnode.com)" — the balanced reth backend
      that answers null receipts is still the primary. FINDINGS
      (follow-ups, no slice): (1) the five oldest rows were recovered
      only by the refresh, not by the one-time alternate-endpoint retry
      on first load — whether they went "unavailable" or the alternate
      answered null too is not visible in the UI (a diagnostic line
      would tell); (2) a zero-value approve with no token movement shows
      "−0 test ETH" (rows 21 and 112) while wrap / unwrap / swap zero legs
      show "no amount"; (3) a fling into the top of the list triggers a
      pull-to-refresh (expected RN behaviour, easy to set off); (4)
      emulator: Expo Go's LauncherActivity hit an ANR on the first launch
      ("Input dispatching timed out … FocusEvent", process at 0% CPU;
      cleared by Close app + relaunch); Expo Go's Tools bubble covers the
      Privacy switch and opened the dev menu once; uiautomator dumps take
      14–17 s. End state: Home, Ethereum Sepolia, Account 1, light mode,
      Google IME, protection ON; Metro at ace3451.

INPUTS RECEIVED (2026-10-11): 0.1 OP Sepolia test ETH at the dev EOA
0x16DA…C5C (read live on optimism-sepolia-rpc.publicnode.com); Hoodi
test ETH is being mined and should arrive within the hour (0 at the
time of writing; a watcher polls the balance). The Chairperson is still
reviewing docs/DISCLOSURE_FINDINGS.md ("a few appear safe to ignore";
the final determination follows), is not concerned about the Alchemy
Sepolia key (test funds; rotate before mainnet), and APPROVED PHASE 19.

## Phase 19 plan (approved 2026-10-11): the networks go live, multisig for everyday use, DCA on a session key, stuck transactions

Selection rule as before: features not started that need no outside
input beyond the funds just received, each showable on the emulator,
with the account-abstraction angle first; plus the live legs the new
funds unlock and the recorded follow-ups.

0. The funded networks live: (a) OP Sepolia — the Kernel deployment
   through ZeroDev on 11155420 with the OP-stack L1 data fee, an EOA
   send and the fee model checked against the receipt, by script
   (kernel-smoke / fund) and then through the app (the smart-account
   send, Upgrade's L1 line, the multisig if the weighted validator is
   verified there); (b) Hoodi, when the ETH arrives — the staking leg
   by script (staking-smoke: a Lido stake, a withdrawal request, the
   claim after finalisation, a Rocket Pool deposit of at least 0.01 and
   a burn) and then in-app, with the emulator's Account 1 funded from
   the dev EOA.
1. Multisig for everyday use (feature 24): QR scanning of requests and
   approvals (never rehearsed), the file save / open paths, approvals
   from another wallet through the EIP-712 typed data (the co-signer
   helper standing in), the multisig on Base, Arbitrum and OP Sepolia
   with the weighted validator verified on-chain first, a Base or OP
   Sepolia multisig proven live; the "Check this network" flow.
2. Dollar-cost averaging on a session key (feature 63, "only with AA"):
   per docs/SCHEDULED_PAYMENTS.md, a CallPolicy-pinned Uniswap v3
   SwapRouter02 exactInputSingle (recipient = the account, a STATIC
   minimum-out floor, fixed token pair and amount) held by the user's
   own phone like the recurring payment, with the honest caveats on
   every screen (the floor does not follow the price; no deadline; the
   key can only buy the chosen token for the account); engine spec and
   tests, proven live on Sepolia Uniswap v3 by script, then the app's
   recurring form variant "swap X test ETH for USDC every N" and a live
   in-app run.
3. Stuck and failed transactions (feature 95, the transaction half):
   speed up / cancel a pending regular-account transaction by a
   replacement with the same nonce and a higher fee (EIP-1559 rules
   verified from the spec; the Activity "pending" row offers it); for a
   smart account, say plainly why the wallet cannot replace a submitted
   UserOperation and offer a re-quote once the bundler has dropped it;
   proven live on Sepolia with a deliberately under-priced send.
4. The phase 18 follow-ups (no inputs): the unavailable-receipt
   diagnostic line, the "−0 test ETH" approve rows, "Not enough ETH to
   pay the network fee." with the profile's symbol, the doubled rebasing
   sentence, the Multisig list refresh observed with a fresh record, the
   CSV read in a development build; a TalkBack and dark-mode pass over
   the phase 17–18 screens.
5. Leadership refresh at the end: feature rows, the shareable page,
   DEMO.md (OP Sepolia, Hoodi staking, QR multisig, DCA, speed-up), the
   threat model, and a mainnet-readiness decision memo for the
   Chairperson (what C1–C3 and the audits still need, which addresses
   are pinned for mainnet and which are not).

Waves: 1 — (A) item 0a by script (scripts/testnet only), (B) item 1
(the multisig files), (C) item 2's engine + script (engine and
scripts/testnet), (D) item 3 (send / activity files) in parallel on
disjoint files; the Hoodi watcher starts item 0b when the balance is
non-zero; then the emulator passes one at a time (0a, 1, 2's app half,
3); 4 alongside; 5 last. Subagents on Opus.

INPUTS RECEIVED (2026-10-11, later): 33.0 Hoodi test ETH at the dev EOA
(read live on ethereum-hoodi-rpc.publicnode.com; item 0b dispatched).
The Chairperson asked for (a) the emulator's screen protection to stay
OFF so the emulator window can be watched live (standing rule above
amended), and (b) an independent security-researcher review of every
item in docs/DISCLOSURE_FINDINGS.md in a CVE-style (NIST NVD) format
that weighs real-world assumptions before anything is reported — e.g.
that a threshold's worth of multisig keys is not given to one entity
without accepting that risk, and that nobody sets a guardian delay
near 2^48 seconds and funds the account (item F); the review is in
progress (docs/SECURITY_ADVISORIES.md). The disclosure findings review
by the Chairperson is still pending ("a few appear safe to ignore").

## Phase 19 progress
- [x] Item 0a — OP SEPOLIA PROVEN LIVE BY SCRIPT (commit 42099d5;
      scripts/testnet only — fund.mjs, kernel-smoke.mjs, new
      l2-receipt.mjs; the offline runner ALL GREEN in the CTO's isolated
      worktree with only these files on HEAD (engine 936, app 7,739,
      check-devmode 305) and the read-only dry runs passing there on
      11155111 / 84532 / 421614 / 11155420; every hash re-read on
      sepolia.optimism.io (op-reth 2.4.4) and the Pocket endpoint (op-reth
      2.4.2); no secret printed, the three files secret-scan clean; the
      dev EOA spent 0.0051 ETH in transfers and about 0.0000703 in fees
      on OP Sepolia, nothing elsewhere). SCRIPTS: fund.mjs prices the
      exact unsigned transaction on OP-stack chains with the app's own
      quoteOpStackFees (CORRECTION to the brief: the engine has no
      OP-stack fee function; the only implementation is
      app/src/wallet/send.ts, imported through Node type stripping as
      check-base already does — so fund.mjs now depends on send.ts
      loading cleanly, and Node prints a MODULE_TYPELESS_PACKAGE_JSON
      warning), prints gas worst case + L1 estimate (and the 50% reserve)
      + operator fee, refuses to send when the balance cannot cover value
      + worst case, offers FUND_DRY_RUN=1, and after inclusion prints the
      receipt's layer 2 fields, the fee paid as a share of the worst case
      and an exact balance-delta check; the transaction built is
      unchanged on every chain (Base live not re-run — dry run only).
      kernel-smoke.mjs re-reads each bundle receipt (status, block, the
      bundler EOA, fees with the layer 2 fields, every log whose topic
      equals keccak of a known signature: AccountDeployed, Deposited,
      OwnerRegistered, BeforeExecution, UserOperationEvent decoded), the
      signed-gas line prints the worst-case prefund, the operator fee is
      read only for OP_STACK_CHAINS {84532, 11155420} (a separate set
      because check-devmode pins the CHAINS literal — that refactor came
      after the live run; equivalent condition, re-checked by dry run).
      LIVE (every status 0x1): (a) 0.003 ETH to the dev Kernel
      0xc995E49acA5C888F4FF1E50E8467E9fFc31CC5AC — tx
      0xe4f16359c7dcdb0af263d668b302dc91544d766977df1a2e85453ad8ac047407,
      block 49967408, estimate 21,000 / limit 25,200, maxFee 1,000,500 /
      tip 1,000,000, L1 estimate 244 wei on the 49-byte unsigned tx,
      worst case 25,212,600,366; receipt gasUsed 21,000, effectiveGasPrice
      1,000,250 (base fee 250), l1Fee 244 (= the quote to the wei),
      operator fee 0; fee paid 21,005,250,244 = 83.31% of the worst case;
      balance delta exactly value + gasUsed × price + l1Fee; receipt
      fields present: l1Fee, l1GasUsed 1,600, l1GasPrice 13,
      l1BaseFeeScalar 7,600, l1BlobBaseFee 1, l1BlobBaseFeeScalar
      862,000, daFootprintGasScalar 400, blobGasUsed 40,000 (absent:
      l1FeeScalar, operatorFeeScalar, operatorFeeConstant). (b) KERNEL
      DEPLOYMENT THROUGH ZERODEV on 11155420 (EntryPoints v0.6, v0.7 and
      two others served): op 1 (deployment + batch) userOp
      0xd9a0d7c2f10df02c8dc7888f01aac9be525793f8376717454ecbcaa3485deda9,
      bundle tx 0xddfba4a6d99d745776d9c924a4284bcc35dcf6b2e72651584c4b80c5484dbd28,
      block 49967417, signed pVG / vGL / cGL 56,041 / 394,038 / 39,016,
      fees 150,000,500 / 150,000,000, worst-case prefund
      73,364,494,547,500, actualGasUsed 334,973, actualGasCost
      50,246,033,743,250 (68.5%), effective user-op price 150,000,250,
      bundle gasUsed 326,899, bundler effectiveGasPrice 129,790,855,
      bundle l1Fee 1,013 wei (l1GasUsed 6,639), AccountDeployed (meta
      factory 0xd703…42d5, no paymaster), OwnerRegistered, Deposited
      73,364,494,547,500, UserOperationEvent nonce 0 success;
      rootValidator() = 0x01‖845a…cE57, owner = the dev EOA; Kernel
      balance −73,364,494,547,501, deposit 0 → 23,118,460,804,250 (=
      prefund − actualGasCost); op 2 (deployed path) userOp
      0xf92a8ca28c54553eee3ace79584738c60474b61c583a8a25a4b3d0fa2f446838,
      tx 0x8b3abc215c634ea2082a77c0c06759b371961017ee6985f2c20ecd740c6e8331,
      block 49967420, signed 50,492 / 100,373 / 26,932, prefund
      26,669,638,898,500, actualGasUsed 133,009, cost 19,951,383,252,250
      (74.8%), bundle gasUsed 125,860, l1Fee 647, nonce 1 success,
      deposit → 6,718,255,646,250; three Kernel event topics
      unrecognised (0x6789ec0c…, 0xd21d0b28…, 0x88a5966d…). (c) Emulator
      funding: Account 1 EOA 0.0001 (tx
      0x97329ead971b60eb0a17dbf62aad4f38c3516fdf27434e2c40051d2248f53e2a,
      block 49967430) and the emulator Kernel 0xD31c…D8FA (=
      predictKernelAddress(0x772e…F44F, 0), undeployed) 0.002 (tx
      0x0bd37f012ebf35b509d4fa3957d39a172860daf6e93edbf2e9cac4aabe7b912b,
      block 49967433), same fee figures. VERSUS BASE / ARBITRUM: op 1
      signed pVG 56,041 = Arbitrum's (Base 61,454 carried its L1 cost),
      actualGasUsed 334,973 = Arbitrum's, bundle gasUsed 326,899 vs
      326,911 / 326,887; effective price 150.00025 Mwei vs 208 / 155 (all
      mostly the script's 0.15 gwei priority floor); op 1 cost 0.0000502
      vs 0.0000697 / 0.0000528 ETH; the sampled deployment estimate vGL
      358,217 / cGL 17,955 = Arbitrum's. NEW FACTS: ZeroDev's OP Sepolia
      estimates were NEVER impossible (both live estimates usable at
      once; 30 raw samples 3 s apart: 0 zero limits, constant answers —
      unlike Arbitrum, over a few minutes only); the L1 data fee is
      negligible today (244 wei per transfer, ~1.2e-8 of the fee; L1
      inputs l1BaseFee 13 wei, blobBaseFee 1) and the quote matched the
      charge to the wei — the "L1 fee on top of gas × price" model held
      exactly by balance delta, only at a near-zero L1 price; operator
      fee 0 (L1Block scalars 0); GasPriceOracle 1.6.0 with Ecotone, Fjord
      and Isthmus true, baseFeeScalar 7,600, blobBaseFeeScalar 862,000;
      the receipt fields daFootprintGasScalar and blobGasUsed are new —
      in all five receipts blobGasUsed = floor(l1GasUsed / 16) × 400
      (empirical; probably the Jovian DA-footprint accounting, not
      checked against the specs) and NOT charged to the sender; ZeroDev's
      tiers constant at 1,000,300 / 1,050,315 / 1,100,330 wei maxFee (tip
      1.0 / 1.05 / 1.1 Mwei), the node's eth_maxPriorityFeePerGas
      1,000,000, base fee 250 wei — the smoke's 0.15 gwei floor is ~143×
      ZeroDev's standard tier (the app's floor + 100% would be ~2.1
      Mwei); a plain transfer to a never-used address costs 21,000 gas
      (no EIP-2780 / 8037 there). FUNDS (OP Sepolia): dev EOA 0.1 →
      0.094900 ETH (USDC 20 unchanged, nonce 0 → 3); dev Kernel 0.002923
      + deposit 0.0000067, deployed; Account 1 EOA 0.0001; emulator
      Kernel 0.002. UNVERIFIED: a non-zero L1 price or operator fee;
      longer-window estimate behaviour; the three Kernel topics; fund.mjs's
      new printing on Base live; the DA-footprint formula; the bundle
      beneficiary. The in-app OP Sepolia pass is the next emulator slot.
- [x] Item 1 — MULTISIG FOR EVERYDAY USE (commit 0f7975d; check-multisig 350
      (was 297), 30 in-suite mutants (was 23); offline runner ALL GREEN in
      the CTO's isolated worktree with only the five files on HEAD
      cc831d9: engine 936, app 7,792 across 51 suites, lint 0/0, tsc
      clean; seven new mutants caught; the old screens fail 8 source
      pins and the old multisig.ts / evm-chain.ts stop the suite at
      import; nothing sent, not seen on a device; docs/MULTISIG.md
      section 12 added by the CTO). QR: react-native-qrcode-svg 6.3.26
      draws through qrcode 1.5.4 at level L (PayloadQr); byte capacities
      from qrcode/lib/core/version.js — v20 858 B, v25 1,273, v30 1,732,
      v40 2,953; measured payloads: a 2-of-3 native request 1,447 B
      (v26), a 10-signer USDC request 2,173 (v32), an approval 411 (v13),
      a 2-of-3 record 628 (v17), a 10-signer record 1,104 (v24);
      MULTISIG_QR_PART_MAX_BYTES = 858 (v20, ~3.1 pt per module at the
      300-pt code; a judgement); larger payloads become "SW-MS:<n>/<total>:
      <chunk>" parts (2–20, cut evenly between characters, each ≤ 858 B
      with its prefix; a 2-of-3 request → 2 parts, a 10-signer request →
      3, a 10-signer record → 2); acceptMultisigQrScan collects parts in
      any order, tolerates repeats, refuses a part of a code with another
      total, a part number re-read with different contents, a damaged
      part, and a whole code while parts are being collected; the joined
      text goes through the SAME parser as pasted text; a single part
      pasted or read elsewhere is refused by all three readers.
      MultisigPayloadQr (Previous part / Next part) and MultisigScanButton
      (reusing QrScanner) wired on the co-signer side ("Scan a request"),
      the submitting side ("Scan an approval") and add-a-multisig ("Scan
      a record"); scan.ts unchanged. FILES: "Save as file" through the
      shared shareTextFile (the duplicate in MultisigViews removed),
      contents = the payload unchanged; opening through pickInto →
      multisigFileText → the kind's parser; "This file was not accepted.
      <reason>."; pinned: real files round-trip byte for byte and parse
      equal to pasted text; refusals for a truncated file, one changed
      hex digit, non-JSON, a request where an approval goes and a record
      where a request goes. NETWORKS (read-only probe 2026-10-11, two
      RPCs each, copies identical; blocks 11,893,001 / 47,984,448 /
      318,135,121 / 49,967,324): weighted validator 0xeD89…eEEE 9,678 B
      (keccak 0x9aa45e0f… Sepolia / 0x7361fa86… Base / 0xb67e1b70…
      Arbitrum / 0xe62253da… OP), implementation 0xd6CE…5b28 24,469 B
      (0x1cacd781… / 0x0b7b78a4… / 0xbf56eb9a… / 0xe1b3d0de…), factory
      0x2577…F2E9 950 B and meta factory 0xd703…42d5 1,871 B identical on
      all four; the validator and implementation differ from Sepolia's
      by 35 bytes (Base, Arbitrum) / 34 (OP) = the cached chain-id word
      and the recomputed EIP-712 domain separator (swapping them gives
      the target code exactly; Solady EIP712 confirmed in Kernel.sol and
      the validator); eip712Domain() = ("WeightedECDSAValidator",
      "0.0.3", chain id, own address) on all four; the app's own
      checkMultisigNetwork passed on all four; ZeroDev answers each chain
      with EntryPoint v0.7 → MULTISIG_VERIFIED_NETWORKS in evm-chain.ts
      (sources and date in the comment); BEHAVIOUR CHANGE:
      multisigNetworkVerified needs kernelV33Verified AND a table entry,
      or a live pass in the session — Create offered at once on the four
      networks, mainnet and Hoodi now read as unverified (mainnet was
      "verified" before; readiness blocks it either way), the box and
      "Check this network" shown only where readiness allows a multisig,
      the live check still runs on create and import; runtime does not
      compare code hashes against the table (possible later). EXTERNAL
      APPROVALS: multisigApprovalTypedData(request) feeds the share text
      (byte-identical to HEAD's on 3 chains); externalApprovalSignature
      accepts a bare 65-byte signature in any case, optionally quoted,
      rewriting v 0 / 1 → 27 / 28 (the validator recovers with Solady
      ECDSA.recover, which passes v straight to the ecrecover precompile:
      kernel cd697c7e WeightedECDSAValidator.sol 215–220, Solady 3f2f5345
      ECDSA.sol 50–77), refusing any other v ("The signature's last byte
      (v) is V; an Ethereum signature ends in 27 or 28 (or 0 or 1)…");
      pinned with a fixed test key: the typed data hashes to
      approvalDigest, ethers signTypedData gives the same stored approval
      and id as the engine's JSON, 0/1 / quoted / upper-case forms equal,
      v 29 / a stale request / a stranger refused, the submitted
      operation's first 65 bytes recover to the outside wallet over the
      final digest. STRINGS: "Scan a request" / "Scan an approval" / "Scan
      a record" / "Scan the next part" / "Start over" / "Previous part" /
      "Next part"; the three under-button sentences ("A scanned request
      is checked exactly like pasted text: …"); camera rationales; the
      paged-code sentence ("This is too much for one reliable QR code, so
      it is shown as N codes…"), "<caption> — part i of N"; progress "1
      of 3 parts read. Show the next part on the other phone (Next part)
      and scan it; 2 parts are still missing."; "Too large for QR codes —
      use Share, Copy or Save as file instead."; the four scan refusals
      and "The QR code was empty."; the pasted-part sentence; the file
      sentences. The scratch co-signer helper gained typed-sign and
      qr-png (rehearsed offline and against Base Sepolia's nonce read
      with the public mnemonic). Emulator checklist (9 steps, Base
      Sepolia) in the builder's report — needs the emulator after the OP
      Sepolia pass. UNVERIFIED: QR legibility at v20 on a phone; camera
      scanning of multi-part codes (the emulator's virtual-scene camera
      as a source); the paged layout; the file picker's MIME labelling;
      TalkBack; dark mode; any multisig deployed or operated off
      Ethereum Sepolia; hardware wallets returning v 0/1.
- [x] Item 2, engine + script — DCA ON A SESSION KEY, PROVEN LIVE ON
      SEPOLIA (commit e9c2b56; packages/chains-evm/src/kernel-dca.ts with 45
      tests, index.ts additively, scripts/testnet/dca-smoke.mjs; offline
      runner ALL GREEN in the CTO's isolated worktree with only these
      files on HEAD ca934a2: engine 981 — chains-evm 719 — app 7,792; the
      dry run passed there; every tx re-read on sepolia.drpc.org; the
      dev EOA spent 0.008 ETH in top-ups (above the 0.005 named, within
      the 0.01 budget) + 2 × 27,539 gas; 0.94 USDC-equivalent bought;
      the DCA key file deleted after the revoke). SOURCE FACTS (fetched
      2026-10-11): Uniswap v3 Sepolia from docs.uniswap.org — SwapRouter02
      0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E, factory
      0x0227628f3F023bb0B980b67D528571c95c6DaC1c, QuoterV2
      0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3, WETH9 0xfff9…6b14 — the
      router, factory and QuoterV2 Sourcify full matches (solc 0.7.6, all
      deployed by 0x3344…432A; the router's deployment tx 0x472b2240…ff02,
      block 3,518,296), router factory() / WETH9() and QuoterV2 factory()
      read back; the v1 SwapRouter and old Quoter are not on Sepolia.
      exactInputSingle(ExactInputSingleParams{tokenIn, tokenOut, uint24
      fee, recipient, amountIn, amountOutMinimum, uint160
      sqrtPriceLimitX96}) selector 0x04e45aaf (in the router's code;
      SwapRouter02 keeps its deadline only in multicall(uint256, bytes[]),
      which cannot be pinned; the v1 struct with a deadline is
      0x414bf389, refused); every field static at offsets 0…192; router
      special values: amountIn 0 = "use the router's balance", recipient
      address(1)/(2) substituted, "Too little received" below the
      minimum; PeripheryPayments.pay wraps exactly the amount owed from
      msg.value when token == WETH9 and the router holds the balance →
      DECISION: sell ETH by sending amountIn as value with tokenIn =
      WETH9, no separate wrap (RESIDUAL: a partial fill leaves ETH in the
      router for the next refundETH caller; the floor still bounds what
      the account receives). CallPolicy v0.0.4: ParamCondition {EQUAL, GT,
      LT, GTE, LTE, NOT_EQUAL, ONE_OF}, raw word at data[4+offset …],
      CallViolatesValueRule / CallViolatesParamRule. POOLS (factory
      getPool, USDC token0): 0.01% 0xFeEd…40b5 liquidity 7.9e14; 0.05%
      0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1 1.3157e16 (101 WETH) —
      CHOSEN, quote within 0.9% of the best; 0.3% 0x6Ce0…9b50 8.8e15; 1%
      0x6418…7C47 1.07e17; pools are not on Sourcify — readDcaPool
      re-checks getPool, the pool's factory, tokens, fee and liquidity on
      every read. ENGINE: DcaTerms {chainId, account, router, tokenIn
      (DCA_NATIVE or an ERC-20), tokenOut, fee, amountIn, minimumOut (the
      static floor), periodSeconds, count, startAt, graceSeconds?,
      feeBudgetWei, label, recipient?}; dcaGrantFor on the subscription
      template (CallPolicy, TimestampPolicy, GasPolicy, RateLimitPolicy
      {period, count, startAt}, signer SKIP_SIGNATURE) — rules tokenIn,
      tokenOut, fee, recipient (= the account) and amountIn EQUAL (0 is
      the router's own-balance flag; a smaller amountIn than the value
      sent strands ETH; a plan buys a fixed amount), amountOutMinimum GTE
      the floor, sqrtPriceLimitX96 EQUAL 0 (a limit forces a partial
      fill), value cap = amountIn for ETH else 0, plus approve(router,
      amountIn) EQUAL/EQUAL when selling an ERC-20; validUntil = startAt +
      count × period + grace; buildDcaSwapCall(s), dcaMinimumOutFor
      (max(floor, quote − slippage)), dcaFloorFromQuote (refuses 0),
      assertDcaSwap (exact shape, no batches, every field, minimum ≥
      floor, value exactly amountIn or 0, calldata exactly 228 bytes,
      then assertCallsAllowed; kernelDcaSpec runs it before signing),
      encode/decodeDcaSwapData (dirty high bits rejected), readDcaPool,
      quoteDcaSwap (QuoterV2), readDcaState, decodeDcaOutcome (the pinned
      pool's Swap events paying the account, the tokenOut Transfers,
      batched, atOrAboveFloor, the UserOperationEvent success / revert
      reason), validateDcaTerms (floor 0, another recipient, the deadline
      router, the Universal Router, unknown router / pool, non-Sepolia,
      same token in and out, native out, a non-tier fee, amountIn 0, no
      fee budget, bad period / count / label, expired), DCA_* refusal
      constants, UNISWAP_V3_SEPOLIA / DCA_PINNED_POOLS /
      DCA_REFUSED_ROUTERS, serialize/parseDcaTerms, dcaTermsMatchGrant,
      describeDca (caveats opening "THE MINIMUM DOES NOT FOLLOW THE
      PRICE", then no deadline, batching, a reverted swap uses up its
      period, ETH left in the router, catch-up). TESTS: the timestamp,
      gas and rate-limit policy data and the signer entry byte-identical
      to a subscription's; the CallPolicy data equal to an independent
      ethers AbiCoder encoding (native hash pinned literally); the swap
      calldata equal to ethers Interface output; every refusal, each
      checked against the CallPolicy mirror — which ACCEPTS a batch of
      in-rule swaps (the documented residual); fake-node pool / quoter /
      outcome tests. DRY RUN (eth_simulateV1, the public test mnemonic,
      against the real EntryPoint, Kernel, policies and pool): deploy +
      install; before the first slot → AA22; swap 1 accepted (468,502
      USDC ≥ floor); a second in the slot → AA22; lower floor / another
      recipient / another tokenOut / a price limit → CallViolatesParamRule;
      larger amountIn with matching value → CallViolatesValueRule, with
      the value unchanged → CallViolatesParamRule; two in-rule swaps in
      one op ACCEPTED (residual); asking 100× the quote → validation
      passed, execution reverted "Too little received", no ETH left the
      account, the slot used up; the next slot accepted; one more →
      PolicyFailed(3); after revoke → AA23; selling USDC (state-override
      balance): approve + swap accepted twice, an approval one base unit
      high refused. LIVE (dev index-2 Kernel
      0x1D723b78e1D0D84Fd0531e2686285fb1B6414106; every status 0x1):
      top-ups 0x75bbc3abbc76d6533db6c8eb2519a0994c8b0aabc6b90bf990f862541c12f439
      (block 11893079, 0.005) and 0x050942d1fa6feab9cd0383fbcb3a8b2e00fd8ee0fd21f659fd6d31065ef8a159
      (11893088, 0.003); INSTALL userOp
      0xaf6c5cd830648661c3e856285280d08f3f04e467fa6fcb85ea37408e96512e4c,
      tx 0x9f970b8380b79438338f0653ee24222fb1e32cb9d2b10179ab2700b11e77fca7,
      block 11893100, permission 0x5ad60861 (4 policies, signer = the
      session key), actualGasUsed 7,015,028, cost 0.0081024 ETH; SWAP 1
      (signed by the session signer, submitted through ZeroDev) userOp
      0x1a268aebd7d08dc4442bb6a62f1f273b737fcdd33a8168c0c395475fb5b684d2,
      tx 0xb7a50c1cdd84c64c408abbf9f4fbf14d2f24b4338b7a61fa6a33ee466f7a60f1,
      block 11893108, Swap amount0 −468,502 / amount1 +1e13, USDC
      +468,502, gas 698,196, cost 0.0008064; SWAP 2 userOp
      0x2ebbf9c20134b7731240e88c18d46ad459a3437fe616195a8f81f89f02858909,
      tx 0x93c17899a6be1a8c79b4230b74d0ac6da378483385faaa603ce9bdf6bb9da7d7,
      block 11893119, +468,502 USDC, gas 611,324; REVOKE userOp
      0x4172306cc1314a1ed5111057cb102860fb7682919db645063609f9f456d0fcd7,
      tx 0x99a771b050c82050d10ed13d83a3ba11e3b50ae3ac10964d1b8186da3aff12fd,
      block 11893120, installed false; floor 445,076 (95% of the
      QuoterV2 quote 468,502), each swap asked ≥ 463,816 (fresh quote −
      1%) and received exactly 468,502 (46,850.2 USDC per test ETH, no
      measurable slippage at 0.00001 ETH); negatives blocked from
      submission by a wrapper then checked by a decoded handleOps
      eth_call: over-amount refused at ZeroDev's estimate "AA23 reverted
      0x7b5812d4" (CallViolatesValueRule); the EARLY SECOND SWAP PASSED
      THE ESTIMATE (ZeroDev does not check time at estimation) and
      reverted in handleOps with FailedOp("AA22 expired or not due");
      after revocation "AA23 reverted 0x"; signed limits install vGL
      372,655 / cGL 8,226,245 / pVG 72,204, swaps vGL 987,890 (772,557) /
      cGL 379,444; GasPolicy charged ~1.4–1.64e15 per swap of the 6.93e15
      budget; Kernel 0.002287 + 0.000693 deposit → 0.000420 + 0.000341
      (spent 0.0102185 = the four costs + 2e13 swapped, reconciled), USDC
      46.220977 → 47.157981. FINDINGS: (1) THE INSTALL IS VERY EXPENSIVE
      AFTER GLAMSTERDAM — 7,015,028 gas (cGL estimated 7,478,405), ~2.4×
      a subscription install, because seven CallPolicy rules are written
      to fresh storage: ~0.0081 ETH at ZeroDev's price; (2) ZEROD​EV NEEDS
      MORE BALANCE JUST TO ESTIMATE — AA21 unless balance + deposit
      covers ~7.3–8M gas × maxFee (0.00798 ETH failed at 1.1 gwei, passed
      at 1.0); with 130% call padding the signed prefund (~10.2M gas,
      ~0.0117 ETH) was refused at submission with AA21; the run used
      DCA_INSTALL_CALL_PADDING=110; two earlier attempts stopped before
      any submission (their key files deleted) — the app needs about
      0.011–0.012 ETH available to set up a plan on Sepolia today; (3)
      ZeroDev does not refuse a not-yet-due op at estimation (as in phase
      13); (4) fees dominate — each swap's fee (~0.0007–0.0008 ETH) was
      ~75× the 0.00001 ETH swapped at 1.1–1.155 gwei against a 14-wei
      base fee; (5) a reverted swap uses up its slot (simulation). APP
      DESIGN NOTE (next slice): form — amount of test ETH, period, count,
      fee budget; Sepolia only, smart account only, readiness
      test-networks-only; show the pool (0.05% USDC/WETH, full address),
      the router, a live QuoterV2 quote and the floor from it with a
      visible percentage (default 95%) in exact USDC; refuse what
      validateDcaTerms refuses with the DCA_* sentences verbatim; review
      in order — the batching box, "THE MINIMUM DOES NOT FOLLOW THE
      PRICE", no deadline, a reverting swap uses up its period, ETH left
      in the router on a partial fill, the key can only buy USDC for this
      account, catch-up; funding — state the ~7M-gas / ~0.008 ETH install
      and the ~0.012 ETH needed to be estimated, keep the install fee
      back, size the budget from ~1M declared gas per swap × 2; each
      period — confirm, ask dcaMinimumOutFor(fresh quote, 1%) never below
      the floor, show decodeDcaOutcome (USDC received vs quote; a
      reverted swap used its slot); the key never leaves the device.
      UNVERIFIED: the pool contracts against source; a partial fill or
      router residual live; selling an ERC-20 live; a floor revert live;
      ZeroDev's estimate reservation over time; other networks; whether
      the bundler's mempool exposes pending ops (sandwich exposure).
- [x] Item 3 — STUCK AND FAILED TRANSACTIONS (commit 516c023; new
      check-pending 121 registered in suites.mjs; offline runner ALL GREEN
      in the CTO's isolated worktree on e9c2b56 plus the slice: engine 981,
      app 7,913 across 52 suites, lint 0/0, tsc clean; 20 hand mutants
      caught; the CTO added the wipe line in WalletContext
      (resetPendingRegistry) and its pin; proven live by script, not
      seen on a device). SPEC FACTS: go-ethereum master 3a6c2e3b
      core/txpool/legacypool/list.go 303–325 — a replacement is refused
      unless BOTH the fee cap and the tip are strictly higher, each at
      least old × (100 + PriceBump) / 100 rounded DOWN (PriceBump 10,
      legacypool.go 147 / 163; ErrReplaceUnderpriced "replacement
      transaction underpriced", errors.go 43); reth main 1a4dbbe1
      config.rs 24 DEFAULT_PRICE_BUMP 10, 227–255 div_ceil → the wallet's
      rule max(old + 1, ceil(old × 110 / 100)) per field satisfies both
      (the Sepolia default endpoint balances both); cancel = a 0-value
      transfer to self at the same nonce; ERC-4337 (ethereum/ERCs
      0578f46b, erc-4337.md 405) says a replacement needs "a higher
      maxPriorityFeePerGas and an equally increased maxFeePerGas" — NO
      10% in the spec text; Alto ed03b9cb mempool.ts 366–387 enforces
      110% on both else "AA25 invalid account nonce: User operation
      already present in mempool"; ERC-7769 218–247:
      eth_getUserOperationReceipt null until included,
      eth_getUserOperationByHash MAY be null while pending (a null cannot
      prove a drop); no ZeroDev page on replacement found (two searches;
      their docs not crawled), Alchemy documents drop-and-replace at
      10%; the engine's NodeClient exposes only eth_getTransactionCount
      'pending' (rpc.ts 323–384) — the app reads the node directly; FACT:
      before this slice there was NO pending row for an EVM send in
      Activity (both history providers mark every entry confirmed; the
      "pending" chip applied only to provider-unconfirmed entries) and
      sendEvm's listeners served only the spending recorder. BUILT:
      app/src/wallet/pending-transactions.ts — the registry
      shiba-wallet.pending-tx.v1 (secret-free; strict parse, any bad
      record → read-only; cap 64 — resolved notices evicted first, then
      the oldest pending; resolved notices kept 24 h; "Send again"
      offered after 10 min with no record of the op; a 15 s poll — all
      judgements), the bump and fee rules, nonce resolution, the
      smart-account status check and the copy; send.ts
      prepareEvmReplacement / checkReplacementBeforeApproval /
      sendEvmReplacement / ReplacementRefusedError / replacementQuoteUsed
      / setPendingRecordStore, every sendEvm broadcast recorded by a
      listener registered at load, a replacement broadcast NOT fanned out
      to the sent listeners (its value never counted again; the screen
      records the fee); app/src/components/PendingTransactions.tsx — the
      "Pending on this phone" section with its inline confirm, in
      Activity's list header (and its unavailable / error states) and on
      the Send success view; both smart-account submit paths record the
      op. APPROVE ORDER: endpoint pinning → still pending and the fees
      still clear the bump → spending limits (calls [], the fee counted,
      no simulation) → device check → sign → record the fee; a quote
      submitted once; a failed pre-flight disables Approve for a
      speed-up; a speed-up of a cancellation stays a cancellation; the
      cancel confirm shows "This cancellation sends 0 to yourself (0x…),
      the account it comes from. Only the network fee is paid." instead of
      the risk card. STRINGS: prompts "Approve speeding up the
      transaction" / "Approve cancelling the transaction"; "This
      transaction is already included in block N."; "This transaction is
      no longer pending: the network already counts a transaction with
      nonce N from this account, but did not return a receipt for any
      transaction this wallet sent with that nonce. It may have been
      replaced outside this wallet. Nothing was signed."; "The original
      transaction was included before the replacement; the replacement
      will be rejected by the network."; the underpriced, already-
      submitted and stale-fee sentences; notices "Sped up: transaction
      0x… (nonce N) was replaced by 0x…, included in block N." /
      "Cancelled: the cancellation 0x… was included in block N, so
      transaction 0x… (nonce N) will never be included."; row lines
      "Speed-up of transaction 0x… (nonce N)." / "Cancellation of …";
      the smart-account sentence ("A smart-account operation cannot be
      sped up or cancelled from this wallet. Once the bundler accepted
      it, the bundler holds it and the account's EntryPoint nonce decides
      what runs; replacing it would mean asking the same bundler to
      accept a new operation with the same nonce and fees at least 10%
      higher, which this wallet does not attempt."); buttons Speed up /
      Speed up the cancellation / Cancel / Approve speed-up / Approve
      cancellation / Check status / Send again / Dismiss / Remove from
      this list / Reset the pending list. BUG CAUGHT BY THE LIVE RUN: a
      queued registry write waited for the queue it was in (deadlock —
      nothing recorded, later reads hung; would have hit the app); fixed
      in readRegistry, pinned with a check and the mutant. LIVE (Sepolia,
      publicnode, a scratch script driving the app's own send.ts and
      pending-transactions.ts; dev account 2 0xA4da…2378 funded 0.0015 by
      0xc6478c3dfd61f3616dbfec1ca6fe6dc8fa962d3f78e4d776c676fab888b2d96f,
      block 11893076, gasUsed 204,600 — EIP-2780 first transfer): SPEED
      UP — original nonce 0, 0.0001 ETH, maxFee 1 wei / tip 1 (base fee
      14), 0x79848f959e73020d842fd563554736236bc91c6467290b89540eda837321381d,
      pending ≥ 2 min 20 s; replacement
      0xfd0d6370d29084b32c6e28d3074a27c29979a401797f45375d279f5d1e693c96,
      block 11893089, status 0x1 (minimum 2/2, the node's suggestion
      1,000,034 / 1,000,004 chosen, effective 1,000,019); CANCEL —
      original nonce 1, maxFee 7 / tip 1,
      0x8a0b5a59284edcdbc7e372f1a9477c4c2edccd4ea72ca7281a780081d98fbc79,
      pending 74 s; cancellation 0 to self
      0xc9abe51ddb970983d2e0f790cb60528a3a142f480c560e38279e2c7f9a1ede89,
      block 11893098, status 0x1, gasUsed 12,000 (EIP-2780 self-transfer);
      both originals null for transaction and receipt afterwards
      (dropped); the registry marked 'replaced' and 'cancelled'; a second
      submission of the same quote refused; a replacement of the included
      nonce refused "already included in block 11893098"; pool
      observations: the stuck tx alternated between null and blockNumber
      null read to read (publicnode's two backends) and the 'pending'
      nonce flickered 1 ↔ 2; node fee acceptance varied by backend (1/1
      accepted on the first run; later "transaction underpriced" and
      "gas tip cap 0, minimum needed 1", 7/1 accepted); fees spent
      ~0.000033 ETH; account 2 ends 0.0013999670 ETH. DECISIONS (CTO):
      the wipe line added; NO readiness gate (a replacement is an
      ordinary regular-account transaction, offered wherever Send is);
      a replacement's full worst-case fee counts toward spending limits
      (conservative); FOLLOW-UPS: smart-account ops from Swap, Staking and
      WalletConnect are not recorded (an addAaSentListener in
      WalletContext would cover them); the 7702 set-code and guardian
      transactions are not recorded; the small "Send again" race (an old
      op included between the final status check and the new quote).
      Emulator checklist (9 steps) in the builder's report. UNVERIFIED: a
      device; "original included first" live; a bundler-dropped op and
      "Send again" live; a non-publicnode node's treatment of a fee cap
      below the base fee; the "nonce too low" wording from a real node;
      whether ZeroDev accepts a user-operation replacement.
- [x] Item 4 — the no-input follow-ups, first half (commit 88fa5af;
      check-activity 261 (was 225), check-staking 115 (108),
      check-simulation 81 (75); offline runner ALL GREEN in the CTO's
      isolated worktree with only the eleven files on HEAD 8bd03c1:
      engine 981, app 7,962 across 52 suites, lint 0/0, tsc clean; 16
      hand mutants caught; every old file fails its suite; the CTO
      applied the SendScreen call-site line (877) the agent could not
      touch; not seen on a device). (1) UNAVAILABLE RECEIPTS: the row line
      "Details could not be loaded from the network endpoints; pull down
      to try again." (also at the end of the label), the footer "N rows
      without details — pull down to retry" and its technical line ("No
      other endpoint to ask: a; other endpoints answered without it: b;
      other endpoints did not answer: c; other failed decodes: d."); the
      decoder gained isUnavailable, diagnostics() (reasons no-alternate /
      alternate-missing / alternate-failed) and revision(), and the
      screen re-renders when a row becomes unavailable (a batch finishing
      after the visible rows changed was never re-rendered before —
      fixed, pinned). WHY THE RETRY DID NOT RECOVER THE OLDEST ROWS: not
      the hypothesised per-page limit (a row 20 pages old decodes on the
      old code too; no retry budget); a read-only probe today on the four
      Sepolia defaults with the Permit2-approve and swap-leg fixtures
      (believed to be the pass's oldest rows, not confirmed against the
      emulator's hashes): publicnode's reth backend null; THE ALTERNATE
      THE WALLET PICKS, POCKET, IS ITSELF LOAD-BALANCED and its
      reth/erigon backends answered null receipts in 5 of 8 reads while
      returning the transaction; 0xrpc.io/sep (geth) served 8 of 8 (head
      freshness not re-checked; recorded frozen in F-66), 1rpc 6 of 7.
      FIXED AND PINNED: up to MAX_ALTERNATE_ASKS = 3 asks moving to the
      next healthy default each time (a new exclude argument to the
      finder) else re-asking one that answered (R2, R2b); a "no other
      endpoint" answer re-probed after ALTERNATE_REFIND_AFTER_MS = 60,000
      instead of cached for the decoder's life (R3); cost: a null row can
      take up to 8 reads instead of 4; which mechanism hit the emulator
      is unverified — the footer's technical line will show it. (2)
      hidesZeroNativeAmount(entry, tokenTxIds, decoded?) also hides the
      amount when the decoded transaction has value 0 and is not a plain
      native transfer (pinned with "Approved stETH for Lido wstETH
      contract 0xB823…067b (up to 0.0005 stETH)" and "Approved USDC for
      Permit2 (unlimited)"); amountSign(entry) gives an exact zero no
      sign (behaviour change: a zero-value transfer or an approve row
      before its decode reads "0 test ETH"). (3) describeSendError(error,
      symbol, feeSymbol = 'ETH') builds "Not enough <feeSymbol> to pay
      the network fee."; the five StakingScreen calls and SendScreen's
      line 877 pass evmChain.displaySymbol ("Not enough test ETH to pay
      the network fee." pinned on Sepolia; check-nfts / check-token-send
      unchanged); STILL HARD-CODED: send-nft.ts 337 and the detail texts
      in send-erc20, send-nft and delegation, plus ~25 other screen
      callers — follow-up. (4) BalanceChangePreview rowNotes (default
      true) / describeAssetChanges rowNotes: both Staking confirm previews
      pass rowNotes={!plan.rebasing}, so the stETH confirm shows the
      rebasing caveat once; a check asserts no other screen passes
      rowNotes. REMAINING from the phase 18 list: the Multisig list
      refresh on focus with a fresh record; the TalkBack and dark-mode
      pass; the reminders re-run in the development build; the Polygon
      Amoy walk-through; the CSV read in a development build; the
      describeSendError rollout. UNVERIFIED (emulator): the row line and
      footer; whether the oldest rows now recover on first load (depends
      on the live backends); approve rows switching from "0 test ETH" to
      no amount once decoded; the single rebasing note; the staking fee
      title (hard to trigger live).
- [x] Item 2, app half — RECURRING SWAPS (DCA) IN THE APP (commit 530a688;
      new check-dca 124 registered in suites.mjs, check-readiness 194
      (was 190); offline runner ALL GREEN in the CTO's isolated worktree
      on HEAD a86eead plus the slice: engine 981, app 8,090 across 53
      suites, lint 0/0, tsc clean; 15 mutants caught; every old file
      fails check-dca; no engine change; not seen on a device). FILES:
      new app/src/wallet/dca.ts (terms, review, funding, market lines,
      plan / confirm / swap, outcome, refusals) and
      app/src/screens/DcaViews.tsx; sessions.ts — source 'dca'
      (DCA_SOURCE, SessionDcaMeta, DcaLastSwap, sessionIsScheduled), the
      stored record parsed strictly (the terms through the engine's
      parseDcaTerms, must match the grant via dcaTermsMatchGrant and be
      for the record's own account; a hand-over time, a malformed last
      swap or DCA terms on another source → dropped as corrupt),
      installSession requires the key on the device, sendSessionCalls
      checks assertFeatureAllowed('dca') and the engine's assertDcaSwap
      before any request or key read then signs through kernelDcaSpec,
      releaseSessionKey refuses, no test op, DCA revoke wording;
      subscriptions.ts — DCA_KEY_NEVER_EXPORTED (export and hand-over
      refused), readSubscriptionStatus accepts DCA records, an optional
      gasAllowance on the fee-budget helpers; recurring.ts — dcaDueState
      / scheduledDueState on one dueFromChainState core, the banner
      check and the reminders' status read include DCA records
      (read-only); notifications.ts — a DCA record is eligible with its
      period from the grant's interval, swap entries carry swap: true
      with recurringSwapDueContent() ("Recurring swap due" / "A
      recurring swap is due. Open the wallet to review it; nothing is
      swapped until you confirm it."); RecurringDueBanner counts swaps
      ("1 recurring swap is due. Each is sent only after you confirm it
      on the Sessions screen."); readiness row dca (testnet-only,
      enforced; evidence C1 C2 C3 W9 F-14 T-64 T-69; a DCA threat-model
      row is still to add at the refresh); SessionsScreen subMode 'dca'
      (form, review, Start, "Swap now", revoke-and-forget, a "Recurring
      swaps" section; DCA records out of the plain sessions list); pins
      changed: check-readiness EXPECTED_IDS + 'dca', check-subscriptions'
      revoke-kind regex. COPY: intro "Swaps a fixed amount of test ETH
      from your smart account for USDC once per period, always through
      the same Uniswap pool, until the swaps run out or you revoke. A new
      swap key is created on this phone and never leaves it; your account
      enforces the limits on-chain."; market lines with the FULL pool
      (0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1, "checked against
      Uniswap's factory … on every read"), router and quoter addresses,
      "Quote just now (…): 0.00001 test ETH → 0.468502 USDC. A quote is a
      reading at one block, not a promise.", "Minimum to receive per swap:
      95% of that quote = 0.445076 USDC, fixed at set-up."; REVIEW ORDER
      as designed (the batching box, "THE MINIMUM DOES NOT FOLLOW THE
      PRICE…", no deadline, a reverting swap uses up its period, ETH left
      in the router, "The swap key can only buy USDC for this account: it
      may call only Uniswap's SwapRouter02 to sell exactly the plan's
      amount in the pinned pool, with this smart account (0x…) as the
      only recipient. It cannot send your ETH or tokens anywhere else,
      approve a spender, or sign messages, logins or permits.", catch-up
      with the two-period grace, revoke, where the key lives); the
      set-up cost note quoting the live run (7,015,028 gas, ~0.0081 ETH
      at ~1.155 gwei, the bundler refusing to estimate below ~0.012 ETH)
      plus today's equivalents at the signed fee and a funding warning
      under 8,000,000 gas × that fee; fee budget 1,000,000 gas per swap ×
      the signed fee × 2 (the two live swaps charged ~1.3–1.5M gas), the
      set-up fee kept back as the subscription form does; refusals: the
      engine's DCA_* sentences verbatim, DCA_FLOOR_PERCENT_REFUSAL, "This
      wallet offers at most 120 swaps per plan."; the dialog "Swap now?"
      (Cancel / Swap now) with the quote, the fresh-quote-less-1% ask
      never below the plan's minimum, the revert consequence and the fee
      budget left; card lines "Swap due now (since …).", "Next swap: not
      before …", "Last swap (…): received X USDC for …; the quote just
      before sending was Y USDC, and the swap asked for at least Z USDC
      (the plan's minimum is F USDC).", the reverted-swap line, a batched
      operation flagged "If you did not send it, revoke this plan now.";
      buttons "New recurring swap" / "Get a live quote" / "Start
      recurring swap" / "Swap now" / "Revoke (stop the recurring swap)" /
      "Revoke and forget"; prompts "Approve this recurring swap" /
      "Approve revoking this recurring swap". NOT POSSIBLE WITHOUT aa.ts:
      the 110% install call-gas padding — prepareAaCalls takes no padding
      option and sendAa re-estimates at signing, so the set-up is signed
      at the bundler's own estimate and the screen says so
      (DCA_INSTALL_PADDING_NOTE); follow-up: a per-operation padding
      option on prepareAaCalls and the signed-fee guard. FUNDING FOR THE
      IN-APP RUN (the agent's arithmetic at ZeroDev's standard 1.155 gwei
      signed at 2.31: set-up ~0.016 ETH, the estimate needing ~0.0185
      available, Start needing ~0.022 incl. the +20% ceiling, ~0.003 per
      swap; half of that in the 0.58–0.65 gwei regime): THE CTO SENT 0.03
      SEPOLIA ETH from the dev EOA to the emulator's Kernel account
      0xD31c…D8FA through fund.mjs on 2026-10-11 (balance 0.0114 → 0.0415,
      the dev EOA → 0.0621; the console output was lost to a bad filter
      regex, the delta verified on publicnode). Emulator checklist (9
      steps) in the builder's report — runs after the OP Sepolia pass.
      UNVERIFIED: anything on a device; that ZeroDev estimates and
      accepts the app-built set-up and swap (only the script proved it);
      live fee-budget fitting; ZeroDev's wording for a "Too little
      received" estimate failure; whether receipt.logs is always the
      whole transaction's logs (the code falls back to the op's own
      logs); swap reminders in the development build; a reverted swap or
      router residual in-app.
- [x] Item 0a, in-app half — OP SEPOLIA PROVEN LIVE THROUGH THE APP
      (2026-10-11; emulator, Expo Go, Metro worktree at cc831d9 with the
      engine built inside it, 2,360 modules; no repo files edited; 2
      prompts, one per send; nothing from the dev EOA; every hash status
      0x1 on both optimism-sepolia-rpc.publicnode.com and
      sepolia.optimism.io; the bundler URL typed through a 0600 file and
      the ADBKeyboard broadcast, never printed; notes in the scratchpad
      p19a). (A) The profile: chip "✓ OP Sepolia", the banner, the
      test-mode line, the layer-2 note (the L1 data fee on EOA confirms,
      "Smart-account sends pay it through the bundler's gas estimate
      instead. Swaps are not offered here (0x does not support OP
      Sepolia)."), endpoints "default (1 of 3:
      optimism-sepolia-rpc.publicnode.com)", Home "OP Sepolia" 0.0001 test
      ETH + "0 USDC", links Send / Activity / NFTs / Upgrade / Approvals /
      Apps / Multisig (Sessions, Guardians, Inheritance and Passkey
      appeared after the deployment, as on Arbitrum). (B) The bundler:
      the chain-11155111 URL refused "This bundler serves Ethereum Sepolia
      (chain id 11155111), but you are saving it for OP Sepolia (chain id
      11155420). Nothing was saved…"; the chain-11155420 URL "Verified ✓ —
      the bundler reported chain id 11155420 (OP Sepolia) and
      eth_supportedEntryPoints includes EntryPoint v0.7 (checked
      2026-10-11)", row "ready · Kernel v3.3 (ERC-7579)"; the factory
      still saved from 2026-10-10. (C) THE SMART-ACCOUNT SEND THAT
      DEPLOYED THE ACCOUNT (0.0001 test ETH to Account 2): "Not deployed
      yet — the first send deploys it." and the USDC-fee note naming the
      networks that offer it ("It is not available on OP Sepolia."); the
      confirm DEPLOYMENT "Will deploy with this send", max fee
      0.00000105011333952 (0.00210063 gwei × 499,904 gas), total
      0.00010105011333952, NO Layer 1 line (as the profile note says), no
      deposit row (deposit 0), the own-account risk line, "Bundler gas
      estimate passed"; ONE prompt; userOpHash
      0xa452fea2981fa35bccf4b1e0b4b091a25b7b219d88c3a08ac93102712d34194d,
      bundle tx 0x466c078873f8129299077b7c397b4693aff6d0dc1ac5cc5a16e9144cb9274efe,
      block 49968873, gasUsed 346,851 of 524,777, effectiveGasPrice
      1,796,860, l1Fee 1,169 wei (l1GasUsed 6,385, l1GasPrice 17), no
      operator-fee fields; logs RootValidatorUpdated (0x01‖845a…cE57),
      OwnerRegistered, ModuleInstalled(1, 845a…), AccountDeployed (meta
      factory, no paymaster), Deposited 1,050,113,339,520 (= the displayed
      max fee), BeforeExecution, UserOperationEvent nonce 0 success,
      actualGasCost 737,242,356,500 (70.2%), actualGasUsed 351,026; the
      three Kernel topics left unidentified in item 0a are now named by
      keccak: 0x6789ec0c RootValidatorUpdated(bytes21), 0xd21d0b28
      ModuleInstalled(uint256,address), 0x88a5966d
      Received(address,uint256); the signed op cGL 50,180 / vGL 398,217 /
      pVG 51,507, maxFee 2,100,630 / tip 2,100,000 (ZeroDev's standard
      ~1.05 Mwei × 2 — the 100% headroom), effective 2,100,250; Kernel
      0.002 → 1,898,949,886,660,480 wei (= 0.002 − 0.0001 − Deposited),
      deposit 312,870,983,020 (= Deposited − actualGasCost), code 61 B;
      no zero estimate — the first Review accepted. (D) EOA SEND 0.00005
      to Account 2 with the OP-stack fee: max fee 0.00000002101050042
      (0.0010005 gwei × 21,000 "plus the layer 1 data fee below"), "LAYER
      1 DATA FEE (ESTIMATE) 0.00000000000000042" ("The network's fee
      oracle estimates 0.00000000000000028 test ETH for this transaction;
      50% more is reserved…"), total 0.00005002101050042, no operator row;
      ONE prompt; tx
      0xeb56efaddd7ce41058b55a59b079276863d3307be818c2ce6ba9425771ef8343,
      block 49969452, gasUsed 21,000 = limit, effectiveGasPrice 1,000,250,
      l1Fee 280 = the oracle estimate TO THE WEI (l1GasUsed 1,600,
      l1GasPrice 16); balance delta = value + 21,005,250,280 exactly; fee
      paid 99.975% of the worst case. (E) The EIP-7702 upgrade quote:
      "EIP-7702 set-code (type 0x04) to yourself, 0 test ETH",
      "Transaction nonce 1; authorization nonce 2 …; chain id 11155420",
      max fee 0.000000086043000567 (86,000 gas incl. 25,000 for the
      authorization), "Layer 1 data fee (estimate) 0.000000000000000567"
      with the stand-in-signature note; nothing signed. (F) Multisig: the
      Home link, "No multi-signature account on OP Sepolia yet.", Create /
      Add / Approve, every honesty bullet; NO "Check this network" (the
      profile is kernelV33Verified and now in the verified table); the
      weighted validator has 9,678 B of code on both RPCs; not created.
      (G) Apps: "Apps on OP Sepolia (test network)" with the two cards
      (both say "on Ethereum Sepolia" — copy only). (H) Back on Ethereum
      Sepolia: Home identical to the start. Funds (OP Sepolia): Account 1
      EOA 0.0001 → 0.00004998, Kernel 0.002 → 0.00189895 + deposit
      0.00000031 (deployed), Account 2 0 → 0.00015. EMULATOR INCIDENT (no
      wallet data affected): about 40 min in, qemu's CPU0 thread hung
      ("detected a hanging thread 'QEMU2 CPU0 thread'. No response for
      25093 ms"; qemu at macOS darwin-background priority PRI 4 / nice 5
      and nearly idle; adb shell, screencap and uiautomator hung) on the
      (D) confirm before Send; `adb emu kill` + a cold boot recovered it
      (fingerprint enrolled, wallet unchanged, no prompt); the new qemu
      was demoted again ~20 min later and slowed (dumps ~11 s) without
      hanging; `taskpolicy -B` did not help — likely cause: qemu launched
      from the agent shell (nice 5) and/or throttled as a background
      process. STANDING NOTE: launch the AVD from a foreground terminal
      for long passes. OTHER FINDINGS: the EOA transfer is quoted with
      gas limit = estimate = 21,000, no padding (correct, 0.025% margin);
      the first tap on "Verify & save" with the keyboard open did nothing
      (the keyboardShouldPersistTaps default again — the F6 fix covered
      the note views, not Settings' fields; follow-up); Activity on OP
      Sepolia lists neither send without an indexer (by design, stated).
      END STATE: Home, Ethereum Sepolia, Account 1, light mode, screen
      protection OFF (left off per the new rule; the window flag could
      not be re-read after the reboot — that command was denied to the
      driver), the OP Sepolia bundler saved on the device, Metro at
      cc831d9; THE IME IS STILL ADBKeyboard — the driver's `ime set` back
      to Google's keyboard was denied by its permission classifier and
      the CTO did not run it in the driver's place (surfaced to the
      Chairperson; typing on the emulator by hand needs the Google IME
      selected from the device's keyboard settings).
- [x] Item 0b — HOODI STAKING PROVEN LIVE BY SCRIPT (commit recorded
      below; scripts/testnet/staking-smoke.mjs only, +749/−34; the CTO
      verified in the isolated worktree on HEAD 33683b5: node --check
      clean, offline runner ALL GREEN (engine 981, app 8,090 across 53
      suites — staking-smoke is a testnet script, not in the suites) and
      independently re-read two hashes on publicnode (the Lido stake
      0x4d95…d58c block 3797182 status 0x1 gasUsed 94,167 / 3 logs, the
      Rocket Pool burn 0x6772…60b6 block 3797198 status 0x1 gasUsed
      137,152 / 2 logs) and the dev EOA state after (nonce 0 → 9, 33.0 →
      32.8196 Hoodi ETH, stETH 0.060327 — all matching the report); the
      script diff carries no secret (scan clean); the agent's classifier
      review had TIMED OUT, hence the independent re-read. The run is
      driven through the app's own staking.ts / send.ts; STAKING_LIVE now
      takes modes sepolia / hoodi / hoodi-claim / hoodi-f73 / 1, with a
      1.5-ETH value cap and a 0.01-ETH per-tx fee cap, every Hoodi
      receipt re-read on three RPCs (publicnode geth 1.17.7, ethpandaops
      erigon 3.7.1, 0xrpc.io geth 1.17.7) and checked to agree, deltas
      reconciled to the wei, a public-facts record at
      scripts/testnet/runs/hoodi-staking-run.json (git-ignored); the
      Sepolia leg is unchanged and both dry runs still pass. LIVE (every
      status 0x1): Lido stake 0.1 → stETH (tx 0x4d95…d58c, block 3797182,
      94,167 gas, minted 99,999,999,999,999,999 — 1 wei short, shares =
      getSharesByPooledEth); 0.05 → wstETH by a plain transfer (tx
      0x252c…f194, block 3797184, 118,075, minted = getWstETHByStETH);
      wrap 0.02 — exact approve (tx 0x7f40…6a39, block 3797186) then wrap
      (tx 0x5b29…ece6, block 3797188, 92,583, allowance 0 after); unwrap
      0.01 (tx 0xac60…f728, block 3797190, stETH = getStETHByWstETH);
      withdrawal request 0.03 — exact approve (tx 0x25f6…080e, block
      3797192) then requestWithdrawals (tx 0x0b4d…0b63, block 3797194,
      233,047 gas, WithdrawalRequested id 5328, NFT #5328, allowance 0
      after); Rocket Pool deposit 0.05 → rETH (tx 0xa982…6560, block
      3797196, 177,986, minted = getRethValue(net 0.049975), fee 0.000025,
      rate 1.036810042248181492; the deposit pool resolved from
      RocketStorage = 0x425E6f83e27f1676AD78BC39dA79C2C7b33d3Fd8, SAME as
      phase 18); Rocket Pool burn 0.02 rETH (tx 0x6772…60b6, block
      3797198, 137,152, SUCCEEDED 2 blocks after the deposit, TokensBurned
      0.02 → 0.020736 ETH = getEthValue). CLAIM LEFT PENDING (not a
      failure): request 5328 stayed isFinalized false across 10 polls over
      90 min; Lido's Hoodi oracle reports daily (last reference slot
      2026-10-11 12:03:24 UTC, next est. 2026-10-12 12:03:24 UTC), so
      planLidoClaim correctly returned nothing; hoodi-claim mode re-reads
      the request and claims through findCheckpointHints →
      getClaimableEther → claimWithdrawals after the next report — THE
      CLAIM HALF IS NOT YET EXERCISED LIVE. F-72 CONFIRMED LIVE: the
      stored user.deposit.block for the dev EOA was 0 before and after the
      deposit and the burn succeeded inside the 5,760-block delay. F-73
      CONFIRMED BY TRACE (read-only eth_call with code overrides +
      callTracer; nothing sent, the engine refuses a contract burn): the
      rETH burn pays with a 2,300-gas stipend — a plain EOA, code 0x00 and
      a bare PUSH0/LOG0/STOP (~379 gas) succeed; a storage write
      ("not enough gas for reentrancy sentry"), a 7702 designator to a
      forwarding delegate, and a full Kernel ERC-1967 proxy account all
      REVERT out of gas; a 7702 designator to the bare Kernel
      implementation (cheap receive()) succeeds using 1,387 gas — so a
      code-carrying holder can redeem only when its receive path fits the
      stipend; the wallet's eth_call pre-flight blocks the reverting
      cases. FINDING FOR THE DOC REFRESH: the STAKING.md §4.3 Hoodi-vs-
      Sepolia submit-gas gap ("not investigated") is resolved — NOT a
      first-vs-later shares-slot matter (the Hoodi stake here was a first
      stake and used 94,167 vs Sepolia's first-stake 208,421); Hoodi is
      PRE-GLAMSTERDAM (forkId 0x23aa1351, activated 2025-11-12, only the
      Pectra system contracts) while Sepolia is on Glamsterdam, whose
      EIP-8037 raised a fresh storage slot to ~110,020 gas — the ~114k
      difference matches one new-slot creation (a strong inference from
      the two first-stake figures and the fork configs, not an opcode
      trace; the Hoodi endpoints do not serve a struct/opcode tracer).
      Holdings after the leg: stETH 0.060327, wstETH 0.057782, rETH
      0.028201. UNVERIFIED: the live claim (pending the oracle; hoodi-claim
      ready); the F-73 code-holder cases are eth_call/trace only; the
      STAKING.md gas explanation is an inference, not a per-opcode trace.
      The in-app Hoodi pass is a later emulator slot.
- [x] Item 1 — MULTISIG FOR EVERYDAY USE, PROVEN LIVE IN-APP ON BASE
      SEPOLIA (2026-10-11; Expo Go, Metro worktree at a847c2c, 2,365
      modules; no repo files edited; 4 prompts, each expected; no dev-EOA
      spending; every hash status 0x1 on base-sepolia-rpc.publicnode.com
      and sepolia.base.org; the Base bundler URL built inside the submit
      wrapper's process, never printed; notes in the scratchpad p19b).
      THE FIRST LIVE MULTISIG OFF ETHEREUM SEPOLIA. (1) Networks: Base,
      Arbitrum and OP Sepolia offer Create with no "not verified" box;
      Hoodi hides the Home link and "Check this network" gives "The Kernel
      v3.3 deployment did not verify on this network: KernelFactory
      0x2577…F2E9 has no code on this chain" (no final period — finding);
      mainnet shows only the readiness card, Create/Add/Approve disabled.
      (2) Create 2-of-3 with dev 5 (0x69F0…7E8a) and dev 6 (0xCCB4…b107),
      weights 1, threshold 2 → "Multisig 3 (2-of-3)", CREATE2 index 0,
      address 0x944caA404e389b18b2fe251e969EdD7A220d0d38 — THE SAME
      ADDRESS AS THE SEPOLIA MULTISIG (KernelFactory.getAddress(initData,
      0) returns it on both Base RPCs and Sepolia: the same set gives the
      same address on every chain); funded 0.0005 from Account 1's EOA
      (risk card "…one of your own accounts in this wallet: Multisig 3
      (2-of-3)", fee 21,000 gas + l1Fee 92 wei = the oracle estimate; tx
      0x863aa6d16c28744a4bfd091d9a601f857516b4f4f93221baa6a9cd9a09e75897,
      block 47988769). (3) Request: "…shown as 2 codes", "Multisig
      signing request — part 1 of 2", Previous/Next disabled at the ends;
      both QR codes decoded "SW-MS:1/2:" / "SW-MS:2/2:" and joined equal
      the share text (share text 2,622 B, request JSON 1,441 B, parts 731
      / 730 B). (4) Another wallet signs: the bare signature from the
      co-signer helper (v 0x1c) → "✓ 0x69F0… (weight 1)", "Co-signer
      approvals: weight 1 of 1 needed — ready"; a --v01 signature (ending
      01) accepted the same. (5) SCAN AN APPROVAL — PASS: dev 6's approval
      PNG read by the emulator camera → "✓ 0xCCB4… (weight 1)" (the AVD's
      default virtual-scene poster is a bc1 QR that the scanner reads at
      the origin — gave "No approval found in the text."; the driver set
      the camera pose with adb emu virtualscene-image + an automation
      macro, p19b/pose.sh; the SDK poster custom.png was swapped and
      RESTORED, md5 matches; it only reloads on emulator restart — scene
      images and pose reset). (6) MIRROR multi-part: part 2 first → "1 of
      2 parts read… 1 part is still missing.", re-read → "That part was
      already read.", request A's part 2 → "Part 2 was already read with
      different contents, so this is another code…", the bc1 poster
      mid-collection → "This QR code is not part of the code being read…";
      part 1 then opened the review (Multisig 3, "Base Sepolia (chain id
      84532)", nonce 1, "You approve as 0x772e…F44F weight 1 of the
      threshold 2", the full call); the approval QR = the 408 B Copy JSON.
      (7) Pasted part → "This is part 1 of 2 of a multi-part QR code, not
      the whole text…" on both fields. (8) FILES — SAVE partial / OPEN
      FAILS: save names shiba-multisig-request_base-sepolia_0x944c-0d38_2026-10-11.json
      but the chooser offers only Nearby Share / Drive / Gmail with no
      accounts (cannot store on this AVD); OPEN ("Add an approval from a
      file" / "Open a request file") FAILS FOR EVERY FILE with the raw
      text "Call to function 'FileSystemFile.text' has been rejected. →
      Caused by: Missing 'READ' permission for accessing the file." —
      multisigFileRefusal never shows; pickRecordFile (getDocumentAsync
      copyToCacheDirectory:true then new File(uri).text()) is the shared
      helper, so GUARDIAN RECOVERY-FILE IMPORT IS LIKELY AFFECTED TOO
      (untested; may work in a dev build). (9) SUBMIT THROUGH ZERODEV —
      PASS: op 1 (deployment, nonce 0, dev 5's approval, one prompt
      "Approve submitting this multisig operation (2 of weight 2)"):
      confirm "Network fee (worst case, set by you as the submitter)
      0.0000102675237", "Total (worst case) 0.0001102675237", "This
      operation also deploys the multisig account (its first operation).";
      userOp 0x6c5cc54aa3ee81c203e2f5d0421a64a3f0abd9bae4e301ba80a6198b9407fd1e,
      bundle tx 0xc42698d3a2a10ed6caacc336623a0ebe6284447e2fe92bf3b154ff5179ccc84f,
      block 47989600; logs RootValidatorUpdated(0x01‖eD89…eEEE), three
      weighted-validator events (dev 6, Account 1, dev 5), ModuleInstalled(1,
      eD89…), AccountDeployed (meta factory 0xd703…42d5), Deposited
      10,267,523,700,000 (= the displayed fee), UserOperationEvent success
      actualGasCost 3,488,656,000,000 actualGasUsed 491,360; rootValidator()
      = 0x01‖eD89…eEEE; Account 2 +0.0001; code 61 B; signed vGL 625,634 /
      cGL 17,955 / pVG 54,882, maxFee 14.7 Mwei / tip 2.1 Mwei (100%
      headroom); after: "Deployed; its signer set and threshold on-chain
      match this record." op 2 (helper submitter, this wallet co-signer,
      nonce 1; prompts "Unlock" after an auto-lock + "Approve this
      multisig operation as a co-signer"): userOp
      0x20587ab06eb3c6e3b669318fcd11a25b7e13b4c047346db6e3e41c26652f6670,
      tx 0x342d52857f4d06b96dac10651a156995d51d50013609d7d358cac45caa41eb67,
      block 47989869, success, actualGasCost 1,530,248,800,000, paid
      entirely from the EntryPoint deposit (multisig balance −0.0001),
      Account 2 +0.0001. Funds (Base Sepolia): Account 1 EOA 0.0081 →
      0.00760, Kernel 0xD31c unchanged (0.002794 + deposit + 1.4888 USDC),
      Account 2 +0.0002, Multisig 3 0 → 0.000290 + deposit 0.0000052;
      deployment cost 0.0000035 ETH (far below the 0.00005 assumed from
      phase 13 prices). FINDINGS (fix slice dispatched): (1) BUG — file
      OPEN fails in Expo Go for every file with the raw rejection above
      (pickRecordFile: getDocumentAsync copyToCacheDirectory:true then new
      File(uri).text() → "Missing READ permission"), shown through fail(e)
      not multisigFileRefusal; the guardian recovery import uses the same
      helper and is likely affected; may work in a dev build; (2) BUG
      (dev warning) — duplicate React key MultisigScreen.tsx:819 (History
      keyed by requestId): rebuilding an identical request leaves two
      records with one id, History then shows the same request id as both
      "succeeded" and "abandoned"; (3) starting "New operation (send)"
      while one is collecting silently abandons it and its approvals with
      no warning; (4) COPY over-approval — when co-signers alone reach the
      threshold the bar reads "Co-signer approvals: weight 2 of 1 needed —
      ready" and still "This wallet signs the remaining weight 1 when you
      submit."; (5) the Hoodi "Check this network" sentence lacks a final
      period; (6) observations: the multisig confirm has no balance-change
      preview or risk card; approving as a co-signer is not in this
      phone's History; errors render below "Add an approval from a file",
      off-screen with the keyboard open; add-approval needs two taps with
      the keyboard open (the keyboardShouldPersistTaps default again).
      EMULATOR NOTE: QR scanning works via adb emu virtualscene-image +
      an automation macro (p19b/pose.sh, scan.sh); the open scanner reads
      the bc1 poster at the origin, so set the pose before opening it; the
      driver opened the system camera once and unchecked its location
      tagging. END STATE: Home, Ethereum Sepolia, Account 1, light mode,
      screen protection OFF, IME still ADBKeyboard, Multisig 3 left in the
      wallet (deployed on Base Sepolia), Metro at a847c2c, pushed test
      files deleted from /sdcard/Download. UNVERIFIED: file open in a dev
      build; whether guardian recovery import is actually broken; dark
      mode; TalkBack; iOS.
- [x] Multisig pass findings FIXED, incl. the file-open bug that also hit
      guardian recovery import (commit 1ed6b1c; check-multisig 364 (was 350,
      31 mutants), check-recovery 264 (261); offline runner ALL GREEN in
      the CTO's isolated worktree on HEAD 1310f3e: engine 981, app 8,107
      across 53 suites, lint 0/0, tsc clean; every old file fails its
      suite from a scratch copy; not seen on a device). (1) THE FILE-OPEN
      BUG — installed-source finding (expo-document-picker 57.0.3,
      expo-file-system 57.0.7): getDocumentAsync({copyToCacheDirectory:
      true}) on Android copies the picked file into the HOST app's cache
      and returns a file:// uri; in Expo Go that cache copy is OUTSIDE the
      scoped paths the file-permission service grants, so new
      File(copy).text() throws InvalidPermissionException "Missing 'READ'
      permission" (the raw error the pass saw); a content:// SAF uri, by
      contrast, reads through contentResolver.openInputStream with the
      open-document grant and checkPermission returns true. FIX in the
      shared RecordFileActions.tsx pickRecordFile: on Android pick with
      copyToCacheDirectory FALSE and read the original content:// uri
      (works in Expo Go and dev builds); on iOS keep the cache copy (the
      security-scoped original is not reliably readable) and delete it
      after reading; a content uri (the user's own file) is never
      deleted; ANY read failure is wrapped in RecordFileReadError whose
      message is the plain sentence RECORD_FILE_READ_FAILED_MESSAGE ("It
      could not be read on this device. Some file pickers do not give the
      app permission to read the chosen file; use Share, Copy or the QR
      scan instead."), shown as "This file was not accepted. It could not
      be read…" (multisig) / "The file was not imported: It could not be
      read…" (recovery), never raw. GUARDIAN RECOVERY-FILE IMPORT WAS
      BROKEN BY THE SAME HELPER (RecoverAccountScreen.onImportFile) and is
      fixed at once (check-recovery pins it; the old helper fails a
      recovery pin). VERIFIED against the installed native source, NOT
      executed on a device — reading the content:// SAF uri in Expo Go on
      real Android, and iOS entirely, remain to confirm. (2) History no
      longer shows one request id as two rows: prepareMultisigRequest
      filters any existing operation with the new request id before
      unshifting (a request id whose nonce was consumed on-chain can never
      recur, so no completed op is lost), and the list is keyed by
      index:requestId:status, not the request id alone. (3) "New operation
      (send)" while one is collecting now asks first ("Start a new
      operation?" / "The one you are collecting approvals for will be
      discarded." / Cancel / "Discard and start"). (4) The weight bar
      reads "Co-signer approvals: weight 2 (threshold 2 met by co-signers
      alone) — ready" and drops the "This wallet signs the remaining
      weight" line when the co-signers alone meet the threshold
      (under-threshold wording unchanged). (5) The "Check this network"
      failure sentence ends with a period (asSentence; the engine's
      verifyKernelDeployment message carries none). (6a) the collect-phase
      error renders ABOVE the scan/paste/file inputs. (6b) the shell
      ScrollView already uses keyboardShouldPersistTaps "handled" (= the
      note views), so nothing changed for the double-tap; a regression pin
      keeps it "handled" — if the double-tap is still seen on a device the
      next step is "always", a deviation from the note views, so it was
      left matching them. FOLLOW-UPS (non-trivial, left): the multisig
      confirm has no balance-change preview (needs eth_simulateV1 plumbed
      into that screen); approving as a co-signer is not recorded in this
      phone's History (a data-model addition). UNVERIFIED: the content://
      read in Expo Go on a device; iOS; the single-tap add-approval; the
      live look of the confirm dialog, the deduped History and the new
      bar wording.
- [x] Item 2, app half — RECURRING SWAPS (DCA) PROVEN LIVE IN-APP ON
      ETHEREUM SEPOLIA (2026-10-11; Expo Go, Metro worktree at 1310f3e,
      2,365 modules; no repo files edited; every hash status 0x1 on
      publicnode and sepolia.drpc.org; no dev-EOA spending; screen
      protection OFF throughout; notes in the scratchpad p19c). The flow
      works end to end: install → a swap verified on-chain → revoke, the
      swap signed by the session key with the phrase never opened. (1)
      "New recurring swap" present on Ethereum Sepolia; INERT on Base
      Sepolia with the engine sentence "Recurring swaps are offered only
      on Ethereum Sepolia in this version: no swap router or pool is
      pinned for this network."; on mainnet the Sessions link is hidden
      entirely (session keys test-networks-only) so DCA is unreachable;
      Arbitrum / OP / Hoodi share Base's code path (offline-tested, not
      individually switched — see finding 5). (2) Form + live quote: pool
      0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1 (checked vs factory
      0x0227…DaC1c), router 0x3bFA…e48E, quoter 0xEd1f…2FB3 all in full;
      "0.00001 test ETH → 0.468907 USDC", "Minimum … 95% = 0.445461
      USDC", the set-up cost note (7,015,028 gas / ~0.0081 ETH at 1.155
      gwei, bundler refuses below ~0.012, today ~0.0162 at 2.31,
      reservation ~0.01848); the balance line matched the chain. (3)
      Refusals: amount 0, floor "abc", 121 swaps each exact; empty fee
      budget not exercised live (the ADBKeyboard field would not fully
      clear a controlled value — offline-tested). (4) Review order exactly
      as designed (batching box → "THE MINIMUM DOES NOT FOLLOW THE PRICE"
      → no deadline → reverting swap uses its period → router residual →
      swap-key scope → catch-up with the two-period grace → revoke → key
      location → fresh quote + 95% → short-plan warning → on-chain bullets
      → audit note → technical details, selector 0x04e45aaf, CallPolicy
      offsets 0/32/64/96/128 EQUAL, 160 GTE the floor, 192 EQUAL → Max
      network fee = estimate + ≤20% → padding note → fee budget kept back
      → balance/deposit rows → "Bundler gas estimate passed"). (5) START
      plan 1 (2 prompts: "Approve this recurring swap" + "Protect the new
      session key"): permission id 0x50943d6a, install userOp
      0xb07c45c9e48e74156932a99d8a6d4b3369f322fde7e07810ec257b1c4f1635c7,
      tx 0x26a342c31e41d205bbf6fd4f10fd9ca9bfedfffda4c2fa1abb02bec583f13fd1,
      block 11894109, actualGasUsed 6,936,806 (~7M), cost 0.016024 ETH.
      (6) FIRST SWAP: "Swap due now (since 20:27 UTC). 0 of 3 swaps sent.";
      the "Swap now?" dialog (read from a screenshot — Android Alert
      bodies are not in the a11y tree) with the quote, the fresh-quote-
      less-1% ask never below the plan minimum, the revert consequence,
      the budget left, and "The swap key signs it, not your account key";
      CANCEL left 0 of 3; SWAP NOW → ONE "Use the session key" prompt, NO
      phrase prompt; progress "Received 0.468907 USDC for 0.00001 test
      ETH (the quote just before sending was 0.468907 USDC; the swap asked
      for at least 0.464217 USDC)."; swap userOp
      0xc5047b0e0a609c15c6200ba3350b67a6050497234a42be4ddf8be46ba3b65557,
      tx 0x1f43c9aaff381aff88ee20aa222082fc317e8ddfb89584eebec1935ac1116ba9,
      block 11894126, gas 697,977, cost 0.001612 ETH; on-chain (both RPCs)
      Pool Swap amount0 −468,907 / amount1 +1e13 (EXACTLY 0.00001 ETH in),
      USDC Transfer 468,907 pool → Kernel. (7) Background → return →
      auto-lock → Unlock: the catch-up line persisted ("2 swaps due now …
      1 was missed; your account allows them … one at a time."), count
      stayed 1 of 3, the app-wide banner shown inline and as a sheet; the
      "Not due yet" state and a second SUCCESSFUL swap were NOT captured —
      the 2-minute testing period's inter-slot window (~2 s) and ~8-min
      lifetime are shorter than the driving overhead, so plan 1 expired
      after one swap; swap 2 was correctly REFUSED ON-CHAIN (AA23 "AA22
      expired or not due", no tx) — proof the account enforces the end
      date; card "Ended … 1 of 3 swaps were sent; 2 were not sent before
      the end date." (8) REVOKE demonstrated twice: plan 1 "Revoke and
      forget" (ended) userOp 0xec094cae…9ca0, tx 0x9429bc3d…3800, block
      11894178, "Revoked and forgotten"; plan 2 "Revoke (stop …)" (active)
      userOp 0xb25213f8…0e66, tx 0xcd36fa87…24ef, block 11894217,
      "Revoked". (9) Mainnet: no banner, the Sessions/Multisig/Staking
      links hidden. ECONOMICS: install ~7M gas ~0.016 ETH; the one swap
      697,977 gas (0.001612) to move 0.00001 test ETH — ~160× the swapped
      amount on Sepolia (fees dominate at tiny test amounts). Funds
      (Kernel 0xD31c): 0.041452 ETH + deposit 0.000416 + 4.443547 USDC →
      0.004837 + deposit 0.001105 + 4.912454 USDC (spent 0.035926,
      reconciled: install1 + swap1 + revoke1 + install2 + revoke2 +
      0.00001 swapped; USDC +0.468907 = one swap); Account 1 EOA
      untouched. FINDINGS (fix slice dispatched): (1) LIKELY BUG — the
      fee-budget keep-back can install an UNUSABLE plan: on plan 2 (the
      account at ~0.023 ETH after plan 1) the form auto-fit the GasPolicy
      fee budget to (balance + deposit − the install MAX fee at estimate
      +20%) = 0.001158677365341602 ETH, below a single swap's worst-case
      fee, so the first swap was refused on-chain AA23 PolicyFailed(2)
      "the fee budget is used up", 0 swaps sent, after ~0.0171 ETH was
      spent on install + revoke; Review still said "Bundler gas estimate
      passed" with no warning. FIX WANTED: at Review, when the kept-back
      budget cannot cover at least one swap's worst-case fee, warn or
      refuse; or keep back the install's ACTUAL (not +20% max) fee; or
      price the budget independently of balance. (A typed budget is not
      lowered, so typing one works around it today, but that is not
      obvious.) (2) the 2-minute testing period is too short to rehearse
      multi-swap/catch-up in-app (inter-slot ~2 s, lifetime ~8 min vs the
      driving overhead); a longer custom period is needed (the engine half
      already proved 2 swaps + revoke by script). (3) minor UI staleness:
      after plan 1 expired the card said "Ended …" while the banner sheet
      still said "1 recurring swap is due". (4) Android Alert bodies (the
      Swap-now confirm, the error alerts) are not in the a11y tree — only
      title and buttons; relevant for TalkBack. (5) driving friction (not
      an app bug): the Settings test-network chip row sits below the long
      mainnet-readiness list and scripted scroll overshoots it. (6) IME
      still ADBKeyboard (the `ime set` back to Google is denied to the
      driver). NOT EXERCISED LIVE: the empty-budget refusal (field clear
      unreliable; offline-tested), the "not due yet" state, a second
      successful swap (short period + the plan-2 budget bug + no
      affordable third install), the Arbitrum/OP/Hoodi inert button
      individually. END STATE: Home, Ethereum Sepolia, Account 1, light
      mode, screen protection OFF, no active DCA records (both revoked
      on-chain; plan 2 forgotten), Metro at 1310f3e, IME ADBKeyboard.
- [x] DCA pass findings FIXED, shared fee-budget bug across DCA /
      recurring / subscriptions (commit 462989f; check-dca 135 (was 124),
      check-recurring 192 (185), check-subscriptions 195 (188); offline
      runner ALL GREEN in the CTO's isolated worktree on HEAD 3132ba6:
      engine 981, app 8,132 across 53 suites, lint 0/0, tsc clean; mutants
      caught by restoring scratch copies; not seen on a device). (1) THE
      BUG lived entirely in the shared subscriptions.ts fitFeeBudgetToInstall
      that DCA, recurring payments and merchant subscriptions all call
      (dca.ts / recurring.ts only pass their own gasAllowance), so ALL
      THREE carried it: the fit lowered the auto-suggested budget to
      whatever the account could spare after the install and only refused
      (cannot-fit) when NOTHING could be spared; a positive but tiny spare
      below one period's worst-case fee returned fitted/fits:true, so
      Review said "Bundler gas estimate passed" and installed a plan whose
      first op the account refused on-chain (AA23 PolicyFailed, GasPolicy)
      after the set-up fee was spent. FIX: minimumViableFeeBudgetWei(maxFee,
      gasAllowance = SUBSCRIPTION_PULL_GAS_ALLOWANCE) = one op's worst-case
      fee (500,000 gas for payments/pulls, DCA_SWAP_GAS_ALLOWANCE 1,000,000
      for swaps; null when the fee is unknown → nothing blocked);
      fitFeeBudgetToInstall now checks the settled keep-back against it and
      returns cannot-fit with reason 'no-spare' | 'too-small' (+ minViable,
      fittedBudget), and both review handlers route cannot-fit back to the
      form so Start is withheld and NOTHING is installed; the auto-fit
      too-small block (feeBudgetTooSmallBlock, word-parametrised
      swap/payment/pull) reads e.g. "This plan cannot run: after the
      one-time set-up fee, only 0.001 test ETH could be kept back for the
      swaps, but one swap can cost up to 0.002310000004 test ETH at
      today's fee. Add about 0.001310000004 test ETH to the smart account,
      or set a larger fee budget. Nothing was signed."; a TYPED budget is
      never lowered but, when below one period's fee, shows
      feeBudgetTooSmallWarning (a WarningBox, Start still offered) — CTO
      ACCEPTED the agent's deviation from the brief: warn whenever typed <
      one-period fee regardless of affordability, because such a budget
      fails on-chain no matter how funded the account is (the brief's
      "AND cannot be afforded" conjunction would hide a genuinely broken
      plan's warning); a well-funded plan is UNCHANGED (pinned). (2) The
      DCA custom-period control was ALREADY wired in HEAD (3132ba6: the
      preset row incl. "2 minutes (testing)" on test networks and 1 hour /
      1 day / 7 / 30 days, plus the same Custom minutes/hours/days as the
      recurring form; onDcaReview resolves it to periodSeconds); this slice
      adds regression pins (custom "1" hours → 3600; a 1-hour plan →
      terms.periodSeconds 3600 and grant.rateLimit.intervalSeconds 3600,
      validUntil = now + 4×3600 with the one-period grace). (3) STALE
      BANNER: the due functions were correct (an expired grant → 'ended' →
      completed; a revoked record filtered out); the staleness was in
      RecurringDueBanner, which re-checked only on a background→foreground
      cycle, so a plan expiring or revoked while foregrounded kept showing
      "1 recurring swap is due"; it now re-checks on a 60 s tick
      (useClockTick) ONLY while a banner is up (eligible && result !== null
      — an idle wallet polls nothing) and clears when the fresh read finds
      nothing due, without touching checkKey (a dismissed banner is not
      reopened); BANNER_RECHECK_INTERVAL_MS = 60,000. (4) The Android Alert
      a11y-tree limit, the chip-row scroll and the IME are platform issues,
      left alone. EMULATOR RE-CHECK (queued): an under-funded plan showing
      the block, a typed tiny budget showing the warning with Start still
      offered, a 1-hour DCA plan, and a banner clearing on its own within
      ~60 s; repeat the under-funded and banner cases for a recurring
      payment (shared path). UNVERIFIED (device): the 60 s cadence under
      Android throttling; that the live under-funded AA23 is now never
      reached before install.

DECIDED by the Chairperson (2026-10-11, on the security review): proceed
with phase 19. Of the classified findings, only the one scored CVSS 9.1
concerns the Chairperson, who will investigate it personally; all the
others are low enough to revisit later. THAT 9.1 IS FINDING C —
WebAuthn validator v0.0.1 and v0.0.2 accept a replayed assertion
(SW-ADV-2026-004 in the second review / 003 in the first;
docs/private/SECURITY_ADVISORIES*.md). IMPORTANT: the wallet's own
passkey code pins the PATCHED WebAuthn validator v0.0.3
(0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69, kernel-webauthn.ts), so
this wallet's own users are NOT exposed to the replay; the finding
concerns the older v0.0.1/v0.0.2 that the wallet never installs. No
disclosure has been or will be sent without a further explicit
decision; both review files stay in the git-ignored docs/private/. The
other findings (A, B, D, E, F, G and the section-8 observations) are
deferred by the Chairperson, with their determinations and corrections
recorded in the two review files.
- [x] Item 5 — LEADERSHIP REFRESH (docs commit 94950ae; offline runner
      ALL GREEN in the CTO's isolated worktree on HEAD 48f60c9: engine
      981, app 8,132 across 53 suites, check-readiness 194, lint 0/0, tsc
      clean; docs only). FEATURE_UNIVERSE section 15: feature 63
      (dollar-cost averaging) and feature 95 (in-app support, the
      transaction half) → Proven live; feature 57 (native staking) Built
      → Proven live (Rocket Pool on Hoodi by script); features 24, 58, 29
      and 33 extended with the phase 19 live runs; the tally is now
      PROVEN LIVE 49 (T1 29, T2 20), BUILT 17 (9/8), DESIGNED 1, NOT
      STARTED 32 (T1 1, T2 16, T3 15), and every count sentence agrees.
      Limits stated, not inflated: DCA's second in-app swap and catch-up
      were proven by script not in-app; the Hoodi withdrawal claim is
      pending the oracle; the stuck-transactions and Hoodi in-app passes
      are pending. DEMO.md gained steps 28–32 (OP Sepolia, Hoodi staking
      by script, multisig by QR on Base, a recurring swap, speed up /
      cancel) each with its true rehearsal status, and the drift warning
      updated. THREAT_MODEL.md: F-74 (DCA readiness and limits + the
      shared fee-budget fix), F-75 (the stuck-transaction replacement
      rules), F-76 (the record-file open bug that also broke guardian
      recovery import, fixed); F-72 and F-73 marked confirmed live / by
      trace; the current-state suite counts updated. NEW docs/
      MAINNET_READINESS.md: a decision memo for the Chairperson —
      pinned-for-mainnet vs testnet-only addresses, the unmet C1–C3, the
      real-phone checks, a public-safe reference to the private security
      classification (no exploit detail; the one high-severity item is
      the Chairperson's and the wallet pins the patched component), the
      test-network fee economics, the honest module limits, and a staged
      path holding every AA feature off mainnet. THE SHAREABLE PAGE
      REBUILT (counts 49/17/1/32 asserted in the tiles and header) and
      PUBLISHED as the live version of
      https://claude.ai/artifact/JEfyMuPcMJ8YW5x3ZKitsw (the CTO scanned
      the built HTML before publishing: one Google-Fonts stylesheet, one
      benign client-side filter script, no secrets; the built file copied
      to scratchpad/fu/feature-universe.html as the new base for the next
      build). An emulator re-check of the DCA and multisig fix slices is
      in flight; the stuck-transactions and Hoodi in-app passes and the
      Hoodi claim remain.
- [x] FIX SLICES RE-CHECKED ON THE EMULATOR (2026-10-11; Expo Go, Metro
      worktree moved to HEAD 48f60c9, 2,365 modules; 0 prompts, nothing
      signed or submitted, no funds touched, every balance on two RPCs;
      screen protection OFF, IME ADBKeyboard; notes in the scratchpad
      p19d). PART B — MULTISIG FIXES, ALL PASS LIVE on Base Sepolia
      (Multisig 3 0x944c…0d38): (5) FILE OPEN — the key fix — a valid
      request file opened through "Open a request file" and READ in Expo
      Go (the content:// SAF read now works), showing the co-signer
      review; a truncated request → "This file was not accepted. This
      file must contain exactly one JSON object and nothing else." (the
      clean parse refusal, NOT the old raw "Call to function
      'FileSystemFile.text' has been rejected"); (6) GUARDIAN RECOVERY
      IMPORT — a truncated recovery file → "The file was not imported:
      This file is not a recovery record: it must contain exactly one
      JSON record and nothing else." (plain, through the same fixed
      shared helper); (7) HISTORY — no "two children with the same key"
      LogBox warning (checked metro.log, logcat and screen); the
      index:requestId:status keying holds (an OLD pre-fix record still
      shows request 0xa8bf3dc1… as both "succeeded" and "abandoned" — the
      fix prevents NEW duplicates and keys old ones distinctly without a
      crash, it does not retroactively clean old data; cosmetic); (8)
      NEW-OPERATION CONFIRM — "Start a new operation?" / "The one you are
      collecting approvals for will be discarded." / Cancel / Discard and
      start; (9) WEIGHT BAR — dev5 alone "weight 1 of 1 needed — ready" +
      "This wallet signs the remaining weight 1 when you submit."; after
      dev6 (co-signers alone = threshold) "Co-signer approvals: weight 2
      (threshold 2 met by co-signers alone) — ready" with the
      remaining-weight line DROPPED; the detail shows the "EntryPoint
      deposit (pays fees first)" row. Nothing submitted; Multisig 3
      balance unchanged (a harmless local 'collecting' operation left on
      it, no on-chain effect). PART A — DCA FIXES, NOT EXERCISABLE LIVE
      at the emulator's funds: the Kernel 0xD31c holds ~0.0059 ETH total,
      below the ~0.012 the bundler needs just to ESTIMATE a ~7M-gas DCA
      set-up, and every Review-time string renders only after a
      successful estimate, so Review cannot open; at these funds the
      wallet blocks at Review with the AA21 reservation message ("Your
      smart account needs funds first… A recurring swap's set-up is
      unusually large…") and installs NOTHING (Kernel balance unchanged,
      both RPCs) — so a user cannot install an unusable DCA plan here
      regardless. The fix code and the exact strings are confirmed
      PRESENT at HEAD (SessionsScreen feeBudgetTooSmallBlock ×3, DcaViews
      feeBudgetTooSmallWarning ×2, matching the designed text;
      RecurringDueBanner BANNER_RECHECK_INTERVAL_MS 60000 with the
      guarded useClockTick) and pinned by the green offline suites
      (check-dca 135, check-recurring 192, check-subscriptions 195); the
      too-small BLOCK, the typed-tiny WARNING, the 1-hour cadence and the
      60 s banner were NOT seen on screen. Exercising them live needs the
      Kernel funded into a narrow band (enough to estimate, not enough to
      keep back one swap's fee), from the dev EOA — a follow-up, judged
      not worth the spend given the offline pins and the sibling AA21
      guard. END STATE: Home, Ethereum Sepolia, Account 1, light mode,
      screen protection OFF, Metro at 48f60c9, dev EOA untouched.

## Phase 19 status (2026-10-11)

Items 0 to 5 are landed and pushed. PROVEN LIVE this phase: OP Sepolia
by script and through the app (Kernel deployment, the OP-stack L1 fee,
an EOA send, a USDC-fee op); Hoodi staking by script (Lido and Rocket
Pool — stake, wrap, unwrap, a withdrawal request, a deposit and a burn,
F-72 confirmed live and F-73 by trace; the withdrawal CLAIM pends Lido's
daily oracle); multi-signature accounts for everyday use through the app
on Base Sepolia (the FIRST off Ethereum Sepolia, same CREATE2 address,
QR and files, an external wallet's signature), with the weighted
validator verified on four test networks; dollar-cost averaging on a
session key (engine + script on Sepolia Uniswap v3, then in-app — one
swap verified to the base unit, revoke); stuck transactions (speed up /
cancel) by script. Built and verified offline: the stuck-transaction
registry and UI; the fixes from every pass. Two latent bugs were caught
and fixed: the record-file open path (which also broke guardian
recovery-file import in Expo Go), fixed and PROVEN LIVE; and the
fee-budget keep-back that could install an unusable plan, shared across
DCA, recurring payments and subscriptions. Engine: 981 tests. App: 53
offline suites, 8,132 checks. The shareable page shows 49 proven live,
17 built, 1 designed, 32 not started; docs/MAINNET_READINESS.md is the
new decision memo.

Security: the Chairperson's determination (proceed; the one CVSS-9.1
finding — WebAuthn v0.0.1/v0.0.2 replay — is theirs to investigate; the
wallet pins the patched v0.0.3 so its own users are unaffected; the rest
deferred) is recorded; both review files stay in the git-ignored
docs/private/; nothing has been or will be sent to the vendor without a
further decision.

Pending (no new code): the Hoodi withdrawal claim after the oracle
reports (~12:03 UTC 2026-10-12; run STAKING_LIVE=hoodi-claim); the
in-app passes of stuck transactions and Hoodi staking (both script-
proven); the DCA Review-time strings live (offline-pinned; needs a
narrow Kernel funding band); the stuck-transaction smart-account
operations from Swap/Staking/WalletConnect (an addAaSentListener); the
multisig confirm's balance-change preview and co-signer History record.

Inputs that would unlock more: a mainnet audit, a bug bounty and a
support horizon (C1–C3) plus on-chain verification of every mainnet
address, before any mainnet profile; a real phone and an Expo account
for the device-only checks (passkeys, hardware-backed storage, Face ID,
screen readers); the ZeroDev disclosure decision.

## Phase 20 plan (approved 2026-10-11 "sounds good, let's do it"): the everyday portfolio layer, a duress wallet, the carry-over live legs

Approved by the Chairperson as proposed: item 0 first, lead with the
portfolio layer, the duress wallet as the security slice. Fiat on-ramp
(65) is ON HOLD by the Chairperson's decision. The Chairperson asked for
bridging-provider options; item 4 is the verified answer (research only).

0. Carry-over live legs (funds in hand, no new inputs): the Hoodi
   withdrawal claim after Lido's oracle reports (STAKING_LIVE=hoodi-claim,
   ~12:03 UTC 2026-10-12); Hoodi staking through the app (the emulator's
   Account 1 funded on Hoodi from the dev EOA); the DCA review-time
   strings live (the emulator's Kernel funded into the narrow band);
   the OP Sepolia smart-account and multisig paths in-app; the
   stuck-transaction screens in-app as far as the emulator allows (its
   wallet's phrase is unknown to any script, so an under-priced send
   cannot be forged for it — the pending card after a normal send and
   the smart-account status sentence are what can be checked).
1. The everyday portfolio layer (features 96, 97, 98; no outside input):
   a unified portfolio dashboard (aggregate net worth across the chains
   and accounts this wallet holds, from the balances and prices it
   already fetches, with per-chain and per-account breakdowns and the
   honesty rules of the existing price provider — unpriced test assets
   shown as such); performance and profit/loss (cost basis and realised /
   unrealised figures computed from the on-device activity history and
   the price provider, with every assumption stated and nothing invented
   where history or prices are missing); price alerts and watchlists
   (local, polled while the app is open and through the phase-17
   reminder infrastructure where a development build runs; no service).
2. Duress and decoy wallet (feature 53): a design document first (the
   app lock uses the device's own biometric / PIN prompt, so a duress
   credential needs an app-level secondary secret; what a decoy must and
   must not reveal; the threat model's T-row; what is honest to claim),
   then the smallest safe slice if the design supports one.
3. The polish backlog (no inputs): stuck-transaction coverage for smart-
   account operations from Swap, Staking and WalletConnect (an
   addAaSentListener in WalletContext); the multisig confirm's
   balance-change preview and a co-signer History record; the fee-symbol
   rollout to the remaining send callers; a TalkBack and dark-mode pass
   over the phase 17–19 screens on the emulator.
4. Bridging providers, research only (feature 35; a document, no code):
   evaluate from documentation and read-only on-chain checks on the four
   test networks the wallet already holds USDC on — Circle CCTP (v2),
   Across (and its ERC-7683 intents, feature 36), the native rollup
   bridges (OP Standard Bridge, Arbitrum), and the aggregators (LI.FI,
   Socket/Bungee, Relay) — for non-custodial fit, testnet coverage,
   permissionless vs keyed access, audits, trust assumptions, fees and
   what the wallet could pin versus must take from an API; a
   recommendation for the Chairperson's provider decision.
5. Leadership refresh at the end.

Waves: 1 — (A) item 1 (new Portfolio / Alerts screens, wallet modules
for net worth, P&L and alerts, HomeScreen entry), (B) item 2's design +
slice (lock / auth / storage files), (C) item 4 (docs only), (D) item 3's
code half (WalletContext, Multisig*, the send-path screens) in parallel
on disjoint files; the item-0 emulator passes one at a time alongside;
item 3's TalkBack pass after; 5 last. Subagents on Opus.

## Phase 20 progress
- [x] Item 2 — DURESS AND DECOY WALLET: DESIGN ONLY (commit 7e0316f;
      docs/DURESS_WALLET.md ~5,100 words + THREAT_MODEL T-78 and F-77;
      check-readiness 194 and the offline runner ALL GREEN in an isolated
      worktree on HEAD a104227 + the two files; no code; the agent chose
      (b) design only with reasons the CTO accepts). WHY NO SLICE: (1)
      the app CANNOT tell which credential unlocked it —
      expo-local-authentication 57.0.3 returns only {success}
      (LocalAuthenticationModule.kt 155–161 drops the AuthenticationResult;
      the Android SDK 36 class exposes only getAuthenticationType /
      getCryptoObject; the Swift module returns success / error /
      warning), so a duress credential must be an APP-LEVEL PIN, which
      reverses the recorded no-app-PIN decision (lock.ts, T-09) — the
      Chairperson's call; (2) a decoy that reads as a normal wallet needs
      every per-wallet record behind ONE storage seam and there is none:
      40 shiba-wallet.* keys are read/written directly by 30 files, the
      WalletConnect SDK keeps its own storage, reminders live with the
      OS, and the public-account / imported-key records hold real
      addresses — a decoy scoping only the phrase would show the real
      wallet's contacts, notes, connections, records, pending
      transactions and reminders (a deception that gets caught is worse
      than none); (3) secure-store key names are VISIBLE on Android
      (expo-secure-store 57.0.4 keeps everything in SharedPreferences
      "SecureStore" under plain "<service>-<key>" names with the
      AES-GCM ciphertext as JSON — plaintext length and the
      requireAuthentication flag visible), so two wallets are detectable
      by anyone who copies the app's files; (4) PIN cost measured with
      @noble/hashes 2.4.0 on Node (i7-9750H): scrypt N=2^15 128–141 ms,
      N=2^17 (OWASP) 454–562 ms, PBKDF2-SHA256 600k 806 ms — the full
      6-digit space at the OWASP setting is ~500,000 CPU-seconds (~half
      a day on 12 threads), so no option makes two wallets
      indistinguishable to a file copier; (5) other leaks: funding the
      decoy from the real wallet links them on-chain; real-wallet
      reminders fire under the decoy; WalletConnect sessions reconnect;
      the "on-chain limits" defence in the feature text does not exist
      with the deployed modules (phase 11). THE CURRENT LOCK SCREEN OPENS
      THE PROTECTED REAL PHRASE (requireLocalAuth → openPhraseForApproval)
      — any future decoy must change the lock screen's approval target.
      HONEST CLAIM (§4.3): never "undetectable"; at most "someone looking
      at the screen sees an ordinary wallet", with the file-copy and
      on-chain-link caveats stated. STAGED PATH (§5.2): Stage 0 lock on
      launch (small, independent — dispatched now, see below); Stage 1
      one storage seam with a check that fails on any shiba-wallet. key
      used outside it; Stage 2 the duress PIN per §6 (scrypt N fixed after
      a device measurement; one fixed-shape record holding both PIN
      hashes; both hashes computed on every attempt with a constant-time
      compare; a wait from 5 wrong PINs at 30 s doubling to 1 h, no
      auto-wipe; invariants / mutants listed; draft copy; an advisory
      readiness row); Stage 3 an emulator pass on a THROWAWAY wallet only
      (never the real AVD wallet, whose phrase is written nowhere).
      SOURCES (read 2026-10-11): Coldcard Trick PINs, BlueWallet plausible
      deniability, Ledger's passphrase on a second PIN, BIP-85 at bitcoin/
      bips 927b6de9, OWASP's password-storage cheat sheet (Trezor's pages
      404/403, not relied on). DECISIONS FOR THE CHAIRPERSON (§5.3): (1)
      whether to reverse the no-app-PIN decision; (2) a freshly generated
      decoy phrase or a BIP-85 child of the real seed; (3) whether
      reminders and a duress PIN are mutually exclusive; (4) what "Remove
      wallet" does under the decoy; (5) a passphrase as well as a PIN.
      THE MOST ACTIONABLE RESULT — F-77(b), THE COLD-START LOCK GAP:
      INITIAL_LOCK_STATE is unlocked, WalletContext reaches ready at
      launch with no prompt, LockGate locks only on a return from the
      background, so a swiped-away or killed app reopens UNLOCKED
      whatever auto-lock is set to; affects every user with auto-lock on
      (T-08 does not mention it). CONFIRMED BY THE RECORD, not just the
      code: this AVD has auto-lock at 1 min and every force-stop relaunch
      in phases 18–20 came up on Home with no prompt. A lock-on-launch fix
      is dispatched (Stage 0). UNVERIFIED (device): scrypt cost under
      Hermes; whether a Keystore-bound record resists a file copy on real
      hardware; TalkBack / VoiceOver on a PIN pad; the iOS app-switcher
      cover.
- [x] Item 4 — BRIDGING PROVIDERS, RESEARCH ONLY (commit deb7f8a;
      docs/BRIDGING.md ~9,200 words; secret scan clean; nothing sent; facts
      from documents fetched 2026-10-12 and read-only eth_getCode /
      eth_getStorageAt / eth_call / eth_getLogs through the PublicNode and
      Pocket endpoints between 03:20 and 03:40 UTC, vendor APIs queried
      read-only with a placeholder address). RANKED RECOMMENDATION — the
      CTO's hypothesis checked, confirmed with corrections: (1) CIRCLE
      CCTP V2 FOR USDC, FIRST SLICE: permissionless contracts at the same
      addresses on all four networks (Ethereum Sepolia TokenMessengerV2
      0x8FE6…2DAA, MessageTransmitterV2 0xE737…E275, TokenMinterV2
      0xb43d…F192; code byte-identical across the four, every checked
      implementation a Sourcify exact match), all 12 routes registered and
      unpaused, the Iris sandbox API keyless (fees, allowance, public keys,
      an upfront-fee quote; documented 40 req/s), depositForBurn has 7
      FIXED-SIZE ARGUMENTS so a CallPolicy can pin all of them — the only
      provider where that is true; standard transfers no protocol fee,
      fast transfers 1 bp from Sepolia / 1.3 bps from the rollups; the
      recipient is in the attested message so the mint submitter cannot
      redirect it; CORRECTION (a) the Circle-paymaster pairing holds only
      on Base and Arbitrum Sepolia (no code on OP Sepolia; unusable on
      Ethereum Sepolia per phase 13); CORRECTION (b) the paymaster cannot
      pay for the FIRST mint on a destination — it takes its fee during
      validation, before the mint runs — so someone with gas there, or
      Circle's Forwarding Service, must submit it; TRUST: every mint needs
      both of Circle's 2 attesters (2-of-2); on Sepolia and Ethereum
      mainnet the proxy admins, owner, denylister, pausers and attester
      manager hold no code (EOAs / off-chain keys); the denylist checks
      tx.origin, which for a UserOperation is the bundler. (2) ACROSS FOR
      ETH, SECOND: SpokePools on all four (Sourcify exact on the three
      rollups, partial on Sepolia), a keyless testnet API returning routes
      for USDC / ETH / WETH (a 5 USDC quote ~0.095%, ~10 s fill); CAVEATS:
      testnet relayers cap ~8.0 USDC / 0.0031 ETH; Sepolia settlement is
      a demonstration (HubPool 601 s challenge window, 1-wei bond, EOA
      owner; mainnet a 3-of-5 Safe); the API returns an UNLIMITED approval
      the wallet must replace with an exact one; `depositor` is a free
      argument carrying refund and speed-up rights, so a CallPolicy must
      pin depositor AND recipient to the account, and `message` cannot be
      pinned; THE ERC-7683 HALF IS REFUTED FOR NOW — AcrossOriginSettler
      has no code on any of the four testnets, is documented only on Base
      and Arbitrum mainnet, and ERC-7683 is still Draft with a text that
      replaces the interface Across implements → feature 36 stays Not
      started. (3) NATIVE ROLLUP BRIDGES: trust-minimised for ETH between
      Ethereum Sepolia and ONE rollup only (never rollup to rollup);
      cannot carry Circle's USDC (the native USDC on Base / OP Sepolia
      reverts on remoteToken() / l1Token(); Arbitrum's router maps Sepolia
      USDC to a different bridged token 0x119f0E63…); OP Sepolia
      withdrawals ≥ 7 days (proofMaturityDelaySeconds 604,800 —
      contradicting OP's docs "shorter on test networks") plus a 3.5-day
      finality delay; smart-account traps: OP's depositETH is onlyEOA (use
      depositETHTo), Arbitrum's depositEth from a contract or a 7702
      account credits an ALIASED address. (4) AGGREGATORS, LATER (price
      comparison only until a decoder exists; calldata unpinnable, as
      SCHEDULED_PAYMENTS §4.2 found for 0x): LI.FI serves all four
      testnets keyless (75 quotes / 2 h; routed the test transfer through
      Across inside 1,444 bytes of opaque calldata, +0.25% fee); Socket
      lists no testnets and has no code on the four; Relay covers only
      Sepolia and Base Sepolia, its deposit carries only an order id (the
      receive is promised off-chain), screens addresses, no automatic
      refund on a blocked fill. (5) STARGATE/LAYERZERO AND WORMHOLE: not a
      fit (Stargate's security = its configured LayerZero verifier set and
      its testnet pools hold their own test tokens, not Circle's USDC;
      Wormhole a 13-of-19 guardian multisig). DOC GAP: Arbitrum's docs
      list the Arbitrum Sepolia rollup as 0xd808…81C8, which reads PAUSED;
      the Bridge and Outbox point to 0x042B…0Cf4 (confirms every 20
      blocks). OTHER FACTS: Base Sepolia's portal and AnchorStateRegistry
      delays read 0 with the real window in game type 621 (not read);
      TokenMinterV2 burn limit 10M USDC, USDC isMinter true. LIVE PROOF
      NEEDED (§11): 1–2 USDC per leg from the dev EOA's ~20 on each
      network plus test ETH on the destination for the mint (none on OP
      Sepolia at the time — now 0.0949 after item 0a); burn = exact
      approve + depositForBurn(1e6, 3, self, USDC, 0, 0, 2000) on Base
      Sepolia; attestation GET iris-api-sandbox …/v2/messages/6?
      transactionHash=…; mint = receiveMessage on Arbitrum Sepolia; a
      smart-account leg with the fee in USDC; negatives (a replayed mint
      and a burn with maxFee ≥ amount must revert); verify events, exact
      balance and supply deltas, attestation time. DECISIONS FOR THE
      CHAIRPERSON: the provider; whether Circle's trust is acceptable for
      bridging as for the paymaster; whether a keyed API is acceptable on
      mainnet (CCTP needed none; Across, Relay, Socket need keys or
      allow-listing in production); Fast Transfer / Forwarding Service vs
      free slow Standard Transfers; verifying the mainnet addresses (only
      Ethereum mainnet read); whether feature 36 waits for a settler on
      the current draft. COULD NOT VERIFY (§14): how Circle secures its
      EOA-held roles and which commits the CCTP audits cover; testnet
      attestation times; whether the Across testnet dataworker runs
      bundles (so whether testnet refunds execute); whether Kernel
      implements handleV3AcrossMessage; the settler on Base / Arbitrum
      mainnet; Base Sepolia's real withdrawal window; Arbitrum Sepolia's
      proxy-admin owners; OP's isSenderEOA with a 7702 account; LI.FI's
      facets and who can change them; Relay's Zellic audit (404);
      docs.stargate.finance (connection reset; GitBook copy used).
- [x] F-77(b) FIXED — LOCK ON LAUNCH (commit e0ef6c2; check-devmode 351 (was
      305); verified with the polish slice below as one snapshot in the
      CTO's isolated worktree on HEAD 24d04cc: engine 981, app 8,256
      across 53 suites, lint 0/0, tsc clean; 14 mutants caught; not seen
      on a device). RULE (lock.ts launchLockDecision, decided once per
      launch WHILE RENDERING via React's adjust-state-on-prop-change
      pattern, so the first committed frame that knows both inputs is the
      lock screen): wallet still loading → wait; no wallet (onboarding) →
      unlocked; wallet ready but preferences unread → wait under a
      neutral COVER (background + spinner, no wallet data, no Unlock
      button — WalletContext and PrefsContext load separately);
      auto-lock ON (1 or 5 min) → start LOCKED; OFF → unlocked; a wallet
      created later in the session is not locked at once. The biometrics
      availability is null until the device answers and the gate stays
      armed meanwhile, so the lock shows without waiting; anything that
      covers the screens counts as locked (view !== 'screens'), keeping
      the accessibility hiding, the WalletConnect hold and the browser
      hold unchanged. UNLOCK UNCHANGED: one device prompt "Unlock Shiba
      Wallet" with no approval-target argument, so the vault uses the
      target commitAccounts set (the phrase / an imported key / nothing
      for watch-only or multisig — pinned with the real createKeyVault:
      zero secure-store reads for those two); NO app PIN (the lock.ts
      decision restated); App.tsx untouched (protect-first ordering
      kept); a failed preference read falls back to auto-lock off →
      starts unlocked (as before). COPY: the Settings hint "…While
      auto-lock is on, the wallet also starts locked every time it is
      opened afresh (after it was closed, swiped away or stopped by the
      system). Screen state is kept — locking never discards what you
      were doing."; the launch lock screen "Auto-lock is on, so the wallet
      starts locked. Your keys never left the device's secure storage.";
      the background sentence unchanged; the Settings LABEL "Auto-lock
      after returning from background" is now narrower than the behaviour
      (follow-up: retitle). THREAT_MODEL F-77 status: (a) and (c) open,
      (b) fixed here. STANDING EMULATOR RULE amended above (a cold
      relaunch now needs `adb emu finger touch 1`). UNVERIFIED (emulator):
      no frame of Home before the lock on a cold start (force-stop and
      swipe-away + kill); the cover then the lock; one prompt (plus the
      phrase prompt when protected); no phrase prompt for watch-only /
      multisig; a reminder tap cold-starting under the lock; a
      WalletConnect request at launch held; TalkBack under the launch
      lock. DURESS_WALLET.md §2.3 still describes the gap as open
      (follow-up: a one-line note).
- [x] Item 3, code half — THE POLISH BACKLOG (commit 21b9476; check-pending
      147 (was 121), check-multisig 388 (364), check-aa 369 (362),
      check-nfts 137 (133), check-token-send 78 (70), check-swap 95 (93),
      check-wc 300 (298), check-sessions 144 (139), check-staking /
      check-7702 / check-base pins updated to "test ETH"; verified in the
      CTO's isolated worktree as one snapshot with the lock fix: engine
      981, app 8,256 across 53 suites, lint 0/0, tsc clean; 25 of 25
      mutants caught and ten old files each fail their new suite;
      check-multisig.mjs STAGED FROM THE FILTERED VERIFIED COPY (the
      portfolio agent's route-list hunk excluded — it lands with that
      slice), per the standing rule; not seen on a device). (1) EVERY
      SMART-ACCOUNT OPERATION RECORDED: aa.ts AaOperationKind (send |
      swap | staking | session-setup | session-op | recurring-payment |
      dca-swap | walletconnect | browser | multisig | other),
      AaOperationSentEvent {chain, userOpHash, sender, owner, bundler —
      never stored, sentAt, kind, resend}, addAaOperationSentListener /
      notifyAaOperationSent; sendAa(bundle, owner, quote, meta) fires it
      EXACTLY ONCE right after eth_sendUserOperation returns a hash
      (deliberately separate from AaSentEvent, which carries the quote
      for the spending recorder — firing that from the session path would
      count payments twice); sendSessionCalls fires it with
      sessionOperationKind(source) (dca → dca-swap; recurring /
      subscription → recurring-payment; else session-op); WalletContext
      registers pendingUserOpRecorder once; records gain an optional
      origin (older records read as 'send'; strict parse: 7 or 8 keys,
      origin ∈ USEROP_ORIGINS, else read-only; the "Send again" pre-fill
      kept only for 'send'; a second record of the same hash never loses
      a pre-fill or a specific origin; cap 64); call sites: SendScreen
      {kind:'send', resend} (its passkey path records directly, since
      sendPasskeyCalls bypasses sendAa), Swap 'swap', Staking 'staking',
      Sessions' four owner-signed submits 'session-setup',
      WalletConnectContext's three sendAa calls via aaSentMetaFor(topic)
      ('browser' for browser: topics else 'walletconnect'),
      submitMultisigWithGate 'multisig'; Guardians / OwnerRotation /
      Passkey / Inheritance pass no kind → 'other'. Activity's pending
      card: "Check status" for every recorded operation, the title from
      userOpCardTitle ("Smart-account operation 0x… from Send / from Swap
      / from Staking / from Sessions (setting up or revoking a key) /
      signed by a session key from Sessions / a recurring payment signed
      by its payment key / a recurring swap signed by its swap key /
      requested by an app connected through WalletConnect / requested by
      an app in the in-app browser / submitted for a multisig account"),
      the status from userOpStatusSentence, "Send again" only when
      userOpCanBeSentAgain (origin send with a pre-fill); after
      USEROP_DROPPED_SENTENCE ("…no record of this operation for more than
      10 minutes, so it was most likely dropped.") a per-kind retry
      sentence (e.g. recurring-payment / dca-swap: "Open Sessions: it
      reads from the chain whether the payment/swap counted and offers it
      again while it is due. Nothing is resent from here."). (2) MULTISIG
      CONFIRM: BalanceChangePreview (every call simulated from the
      multisig's address) + RiskWarnings (multisigRiskTarget: the first
      call; the recipient as counterparty only for an exact value-0
      ERC-20 transfer) above "Approve and submit"; DEVIATION, CTO
      ACCEPTED: an UNDEPLOYED multisig still previews (as Send does for
      counterfactual accounts) with the note "The multisig is not deployed
      yet: this operation deploys it first, which the simulation leaves
      out (deploying it moves no funds apart from the network fee)." —
      the brief's "unavailable until deployment" sentence did not exist
      anywhere; CO-SIGNER HISTORY: the store gains cosigned[] of exactly
      {kind:'approved-as-cosigner', chain, account, requestId, nonce,
      summary, signer, approvedAt} (no signature, no on-chain claim;
      strict revive, a malformed entry dropped, a non-array marks damage;
      older stores load), MAX_MULTISIG_COSIGNED_HISTORY 50 newest first,
      re-approving the same request replaces the entry, cosignWithGate
      records only after signWith returned the approval (nothing on a
      cancelled check or a refused signer; a store failure never withholds
      the approval → recorded:false); shown in the record's History
      ("Approved as co-signer: <summary> (request 0x…)" / "Nonce N ·
      approved by 0x… on … UTC. Whether it was submitted is up to the
      submitter; this phone does not track it.") and on the list for
      accounts not in this wallet ("Approved as a co-signer (accounts not
      in this wallet)"). (3) FEE SYMBOLS: send.ts feeSymbolForChain(chainId
      | caip2) → the profile's displaySymbol else 'ETH';
      describeSendError matches "Not enough <any coin> to pay the network
      fee" (FEE_SHORTFALL regex); send-erc20 (quote and Max), send-nft
      (quote) and delegation (7702 quote) build their shortfall text from
      the profile; describeNftSendError(error, feeSymbol = 'ETH'); EVERY
      describeSendError call in app/src passes the fee coin (Send incl.
      the NFT error, all 8 Swap calls, Approvals, Upgrade, WcApprovalSheet,
      WalletConnectContext via feeSymbolForChain(item.chain), OwnerRotation,
      Guardians, Inheritance, Passkey, ApproveRecovery, RecoverAccount,
      PendingTransactions); check-token-send's balanced-parentheses scan
      fails if any call drops it; test networks read "Not enough test ETH
      to pay the network fee: … but the test ETH balance is … wei. Token
      sends pay gas in test ETH, not in USDC." REMAINING: recovery.ts
      2357 "Not enough ETH for the network fee: …" (one literal); comments
      only elsewhere. FOLLOW-UPS: sendPasskeyCalls outside Send (the
      Passkey test op) and recovery.ts submitGuardianRecovery submit
      through client.sendCalls directly and are not recorded (one
      notifyAaOperationSent each); "Check status" asks the network's
      currently configured bundler (the URL is not stored — it can carry
      a project id). UNVERIFIED (device): a dropped bundler op and the
      10-minute retry line live; the preview from a real undeployed
      multisig; the new cards' layout and TalkBack. Emulator checklist
      (10 steps) in the builder's report.
- [x] Item 1 — THE EVERYDAY PORTFOLIO LAYER: dashboard, profit and loss,
      price alerts (commit a73ef6f; new check-portfolio 63, check-pnl 56,
      check-price-alerts 70 registered in suites.mjs; engine 990 —
      packages/prices +9 (history.test.ts); check-watch-only 179 and
      check-multisig's allow-list pins updated (the route-list hunk the
      polish commit filtered out lands here); offline runner ALL GREEN in
      the CTO's isolated worktree on HEAD 9255bb5 plus the slice: app
      8,447 across 56 suites, lint 0/0, tsc clean; 15 mutants caught; the
      CTO added the wipe line (resetPriceAlerts in WalletContext) and its
      pin; THE FIRST COMMIT WAS REFUSED by the pre-commit secret scan —
      price-alerts.ts held 14 consecutive BIP-39 wordlist words
      (push/alert/step/asset/price/quote… as ordinary identifiers); the
      block was restructured (outcome / watched / firing) with the
      scanner left strict, per the phase 14 rule; re-scanned clean,
      check-price-alerts 70 and tsc re-run clean; not seen on a device).
      FILES: new packages/prices/src/history.ts; app/src/wallet/
      portfolio.ts, pnl.ts, price-alerts.ts; screens PortfolioScreen /
      PortfolioViews (the P&L panel) / PriceAlertsScreen; components/
      PriceAlertMonitor (the app-wide checker + banner, mounted after the
      navigator in App.tsx because check-recurring pins the due banner's
      position); additive: prices.ts (historyCoinIdFor, fetchPriceHistory,
      PRICE_HISTORY_MAX_DAYS, a 5-min history cache), notifications.ts
      (CHANNEL_PRICE_ALERTS, priceAlertContent, presentPriceAlert, the
      'PriceAlerts' tap route), navigation / App / both watch-only allow
      lists, a Home link row ("Portfolio", "Price alerts") atop the list
      footer. COINGECKO FACTS (read 2026-10-12, keyless probes):
      /coins/{id}/market_chart/range is on the Demo / keyless API;
      granularity automatic (1 day → 5-min, 2–90 days → hourly, > 90
      days → daily 00:00 UTC; cache 5 min); "Historical data via the
      Demo API is restricted to the past 365 days" (a 400-day range →
      HTTP 401 error 10012); Demo 100 calls/min, keyless per-IP and
      shared, every request counts incl. 4xx/5xx; /coins/{id}/history is
      one 00:00 UTC snapshot per date (not used). (96) PORTFOLIO: every
      recovery-phrase account (hidden ones labelled), imported accounts,
      each account's smart account (found as Activity does, no request),
      multisigs on their record's network, watched addresses in their own
      section and NEVER in net worth; on the active EVM network each
      address read for the native coin and every tracked token;
      BTC/DOGE/SOL only for phrase accounts whose addresses are already
      in the public account cache (read without a prompt; a missing
      account listed, not guessed); MORE THAN HOME READS, so bounded:
      PORTFOLIO_MAX_READS 60 per refresh, 4 at a time, own funds first,
      only on open or pull-to-refresh, through Home's loadNativeBalance /
      loadTokenBalance with Home's failover rule; prices via usePrices
      and the shared cache; amounts bigint, values exact fractions
      (Money), net worth = the sums by asset / network / account
      exactly, cents only for display (stated); test assets "test, no
      value" guarded twice (null price id AND the testnet status
      overriding any quote); a read answered by another network not used;
      Hide amounts masks every amount, value and spoken label; copy "Net
      worth (US dollars)", "Not complete: see what is not counted
      below.", portfolioCountedNote, PORTFOLIO_NOT_COUNTED_NOTE (watched
      addresses, test assets, untracked tokens, NFTs, EntryPoint deposits,
      other networks, unpriced assets, unread balances),
      PORTFOLIO_READS_NOTE, "Watched addresses (not your funds)", the
      price-source line with the oldest price's age ("Indicative market
      prices, not what a sale would fetch."), gap lines for bounded /
      unread / unpriced. (97) P&L: a main network's native coin for the
      active account, loaded after a chip tap, from useHistory (the
      merged feed incl. the smart account) + one history request; AVERAGE
      COST — a confirmed transfer IN from a non-wallet address is a
      purchase, OUT to one a sale, valued at CoinGecko's price nearest
      the transaction's time (within 3 h hourly / 36 h daily / 15 min
      5-minute); NOT counted (each counted and reported): own-address
      transfers, self-transfers, failed, pending; FEES (the indexer lists
      none): if more coins were received than are held, the difference
      is ASSUMED fees, removed at average cost, on its own line, out of
      realised, assumption stated; TOKENS REFUSED (HistoryEntry has no
      contract field — a look-alike could not be told apart; an engine
      change needed); every gap a separate sentence with no figure
      (incomplete history; "N transactions before <date> are older than
      the 365 days…"; no counterparty — every BTC/DOGE/SOL provider
      today, so P&L there always shows that gap; no amount / time / price
      point; price read failed; fiat off; balance unread or larger than
      the history explains; more sent than received; the smart account's
      history failed; no price today); labels "Held now", "Value at
      today's price", "Cost of what is held", "Average cost",
      "Unrealised / Realised profit or loss", "Assumed network fees (not
      in realised)", "Counted"; "These figures are estimates for your
      information, not tax or accounting records." (98) ALERTS: assets
      ETH, BTC, DOGE, SOL, mainnet USDC; store strict with exact key
      sets, ≤ 20 alerts and 4 per asset, canonical thresholds, a damaged
      store read-only and resettable; "above" strictly above / "below"
      strictly below; one crossing fires once; re-arm only after a ≥ 1%
      retrace; an alert created when the condition already holds starts
      tripped and says why; only fresh quotes (not stale, ≤ 10 min);
      PriceAlertMonitor checks on start, each foreground and every 5 min
      in front, ONLY when ≥ 1 alert is stored, the wallet is ready and
      Show fiat is on (else no timer, no request), asking only the
      alerted assets; CHANNEL DECISION (CTO accepted): a NEW
      "price-alerts" channel at DEFAULT importance (separately mutable;
      neither a payment nor a security event; importance cannot change
      after creation), created only when the first alert is presented;
      NOTIFICATION TEXT DECISION (CTO accepted): generic — "Price alert"
      / "One of your price alerts was reached. Open the wallet to see
      which one. Alerts are advisory: nothing is bought, sold or sent." —
      to keep NOTIFICATIONS_PRIVACY_NOTE's "never an amount…" promise;
      the in-app banner names the alert ("Price alert: ETH above $3,000.
      CoinGecko's price was $3,100.00, less than a minute ago…"); posted
      only when reminders are on; a tap opens Price alerts; market prices
      and thresholds NOT masked by Hide amounts (they reveal nothing
      about holdings — CTO accepted); PRICE_ALERTS_EXPO_GO_NOTE states
      Expo Go cannot post them. No readiness rows (informational,
      read-only — CTO accepted). FOLLOW-UP: NOTIFICATIONS_WHAT_NOTE in
      Settings does not yet mention price alerts. UNVERIFIED (device /
      dev build): the notification and the channel in system settings; a
      tap opening the screen warm and cold; the Expo Go behaviour;
      TalkBack, dark-mode contrast, phone-width layout; the history
      request under Hermes; the bounded reads against real endpoints and
      keyless rate limiting under the poll. Emulator checklist (6 steps;
      the wallet holds mainnet dust only, so P&L can show only its gap
      sentences) in the builder's report.
- [x] Item 0 — THE CARRY-OVER LIVE LEGS: DCA REVIEW-TIME STRINGS AND
      HOODI STAKING THROUGH THE APP (2026-10-12 03:20–04:20 UTC; Expo Go,
      Metro worktree at a104227, 2,365 modules; no repo files edited; 5
      prompts, each expected; no dev-EOA spending beyond the CTO's two
      fundings; every hash status 0x1 on two RPCs per chain; screen
      protection OFF; notes in the scratchpad p20a). PART A — DCA on
      Account 1's Kernel (Sepolia; 0 prompts, nothing installed, funds
      unchanged at block 11896455): (1) UNDER-FUNDED BLOCK seen live —
      auto budget 0.013860000036, quote 0.00001 → 0.436024 USDC, minimum
      0.414222; Review returned to the form BLOCKED with exactly "This
      plan cannot run: after the one-time set-up fee, only
      0.002019496197358671 test ETH could be kept back for the swaps, but
      one swap can cost up to 0.002310000006 test ETH at today's fee. Add
      about 0.000290503808641329 test ETH to the smart account, or set a
      larger fee budget. Nothing was signed." (kept back + shortfall = one
      swap's fee); a second Review blocked the same way. (2) TYPED-TINY
      WARNING seen live — budget 0.000001: Review OPENED with the WarningBox
      "The fee budget you entered (0.000001 test ETH) is below one swap's
      worst-case network fee (0.002310000004 test ETH) at today's fee, so
      your account will probably refuse the first swap and the plan will
      not run. Set a larger fee budget unless you are sure the fee will be
      lower." and "Start recurring swap" still offered (not tapped); max
      fee 0.021892399489908917 (estimate + 20%), "covers about 0 of the 3
      swaps", "Bundler gas estimate passed". (3) 1-HOUR CADENCE — Custom →
      1 → hours ("One swap at most every 1 hour."): the review reads
      "Swaps 0.00001 test ETH for USDC every 1 hour, 3 times, until
      2026-10-12 07:37 UTC…", "…the first from 03:37 UTC, then one more
      every 1 hour.", "Rate limit: … one more becoming valid every 3600
      s…", "The last swap falls due 05:37 UTC and can be sent until 07:37
      UTC" (the two-period grace); the 8-minute warning gone; not started.
      PART B — HOODI STAKING IN-APP (Account 1, regular account; Home
      "Hoodi" 0.3 test ETH, no guardians footer): the Staking screen
      (Lido's four quotes dated 2026-10-11, Rocket Pool's no-risk-page
      sentence and two FAQ quotes, the no-smart-account note, "Minimum
      deposit 0.01 test ETH; deposit fee 0.05% (both read just now)").
      (4) LIDO STAKE 0.01 → stETH (1 prompt "Stake 0.01 test ETH with Lido
      for stETH"): "You receive ≈ 0.01 stETH", "Simulated:
      0.009999999999999999 stETH arrive", the rebasing note ONCE, max fee
      0.000200308546682096 (1.923786968 gwei × 104,122), the pinned line
      "This transaction goes to Lido's stETH contract on Hoodi
      (0x3508A952176b3c15387C97BE809eaffB1982176a), pinned by this wallet
      from Lido's published list of deployed contracts.", success with the
      balance note and the note field (note "p20a hoodi stake"); tx
      0x86a62634e324f7fc21d8428d28628421343129fd7e3a9be5512d1dde64d9810c,
      block 3799786, input 0xa1903eab, value 1e16, gasUsed 94,167 (= the
      script run), Submitted, minted 9,999,999,999,999,999 (1 wei short),
      TransferShares 9,683,105,263,274,833. (5) ROCKET POOL DEPOSIT 0.01 →
      rETH (1 prompt): the deposit pool "RESOLVED FROM ROCKETSTORAGE JUST
      NOW" = 0x425E6f83e27f1676AD78BC39dA79C2C7b33d3Fd8, "You receive ≈
      0.009640047229956784 rETH", fee line 0.000005, max fee
      0.000346241647561316; tx
      0x5cfb9386b42d05e02969a6a41e419a5362f866fb901598ef2a90e960fb588635,
      block 3799804, input 0xd0e30db0, gas 177,986, DepositReceived 1e16,
      TokensMinted 9,640,047,229,956,784 for net 9,995,000,000,000,000 =
      getRethValue at block−1 on both RPCs = the preview to the wei
      (rate 1.036820646369883687). (6) rETH BURN of half
      (0.004820023614978392) TWENTY BLOCKS AFTER THE DEPOSIT — SUCCEEDED,
      F-72 HOLDS LIVE AGAIN (1 prompt "Redeem … rETH with Rocket Pool";
      the pinned rETH risk line; preview "≈ 0.004997499999999999 test
      ETH"); tx
      0x364285f8e8f1e2601e7effe21bd5eb2940221075976ebb717776d9f77688c3ed,
      block 3799824, input 0x42966c68, gas 137,176, Transfer A1 → 0x0,
      TokensBurned ETH 4,997,499,999,999,999 = getEthValue at block−1.
      (7) UNSTAKE REQUEST 0.005 stETH (2 prompts: "Approve exactly 0.005
      stETH for Lido withdrawal queue (request)" then "Request to unstake
      0.005 stETH with Lido"; step 2 "Approval confirmed… quoted again…",
      preview "You receive NFT #5329", "Approval revoked", the no-cancel
      sentence, the pinned queue line): approve tx 0xd06911b1…690b (block
      3799845, Approval 5e15); request tx
      0x3077a85c7ef6bd2da0c9137c467ecfd3b29d67c273d262440ead7713e836d314,
      block 3799852, input 0xd6681042, gas 215,959, WithdrawalRequested
      REQUEST ID 5329 (owner A1, 5e15 stETH, 4,841,552,631,637,416
      shares), NFT #5329 minted, allowance back to 0; the card "Lido
      withdrawal requests / REQUEST 5329 / 0.005 stETH / Waiting in Lido's
      queue." (8) CLAIM: "Nothing to claim yet: your request is still
      waiting in Lido's queue." — read-only at 04:12 UTC on both RPCs
      lastFinalizedRequestId 5327; 5328 (the dev EOA's) and 5329 (A1's)
      both unfinalised; nothing claimed; the oracle's next report ~12:03
      UTC (a one-shot wake-up at 12:23 UTC runs hoodi-claim for 5328; A1's
      5329 is claimed in-app at the next pass). (9) ACTIVITY on Hoodi
      (logs fallback): "Staked 0.01 test ETH with Lido (stETH contract
      0x3508…176a): received 0.009999999999999999 stETH" with the note;
      "Called 0x425E…3Fd8 with 0.01 test ETH: received 0.009640047229956784
      rETH" (generic — finding 4); "Burned rETH for test ETH with Rocket
      Pool (rETH contract 0x7322…64F1): sent 0.004820023614978392 rETH";
      "Requested a withdrawal from Lido (withdrawal queue contract
      0xfe56…9186): sent 0.005 stETH, received NFT #5329…"; the approval
      not listed (no token movement); Home on Hoodi shows stETH 0.005
      (rebasing note) and rETH 0.00482. FUNDS: Sepolia unchanged; Hoodi A1
      0.3 → 0.284253499485668980 ETH (nonce 5), stETH 0.005, rETH
      0.004820023614978392 — reconciled to the wei (−0.01 −0.01 +
      0.0049975 − fees 0.000744000514331019 over five txs). FINDINGS (fix
      slice dispatched): (1) after the auto-fit block the fee-budget
      field is overwritten with the fitted keep-back while the hint still
      says it follows the suggestion; clearing it refills the fitted
      value (cosmetic / confusing, not unsafe); (2) THE DCA THRESHOLD MAY
      BE TOO LOW — the block and warning use 1,000,000 gas per swap while
      the same review says the two live swaps were charged ~1.3–1.5M, so
      a budget between 1.0M and 1.5M × fee passes the check and can still
      be refused on-chain at the first swap; (3) "…was fixed when the plan
      was set up" is past tense on a review before set-up; (4) the Rocket
      Pool deposit is not recognised — the pool is RESOLVED (not pinned),
      so the risk card is generic ("goes to a contract (0x425E…)",
      contract age "128 blocks", "first time sending… double-check every
      character") and Activity reads "Called 0x425E…" — both could say the
      address came from the pinned RocketStorage; (5) the Rocket Pool lock
      copy is STALE ("can refuse moving or redeeming rETH for 5760 blocks
      after a deposit") given F-72; (6) previews OMIT the outgoing staking
      token (the burn lists only the ETH received, the request only the
      NFT and "Approval revoked") though both receipts carry the Transfer;
      (7) the stake preview calls stETH "untracked token 0x3508…176a"
      although it is a pinned staking token; (8) EACH DCA REVIEW SHOWS A
      NEW SESSION KEY ADDRESS (0x4780…F30A, then 0x6Bb3…E834) — whether
      keys from reviews that were never started stay in secure storage is
      unverified (a leak of unused keys if so); (9) driving notes: the
      first tap after dismissing the keyboard often misses; uiautomator
      reports a placeholder as a field's text; ADB_CLEAR_TEXT does not
      clear a controlled field (DEL keyevents do). NOT EXERCISED: the
      claim (oracle), the 60-second banner clear, the recurring-payment
      variant of the block. END STATE: Home, Ethereum Sepolia, Account 1,
      light mode, protection OFF, IME ADBKeyboard; Metro at a104227 (the
      next pass moves to HEAD, which carries the lock-on-launch fix).
- [x] Item 0 — THE HOODI WITHDRAWAL CLAIM, PROVEN LIVE BY SCRIPT
      (2026-10-13; the scheduled 12:23 UTC wake-up of 2026-10-12 never
      fired — the session was cut by the weekly Opus limit that night —
      so the CTO ran it by hand after the limit reset: Lido's Hoodi
      oracle had reported at 2026-10-13 12:03:24 UTC, lastFinalizedRequestId
      5333, requests 5328 (the dev EOA's) and 5329 (Account 1's) both
      finalised and unclaimed; STAKING_LIVE=hoodi-claim; the dry runs on
      Sepolia and Hoodi passed first). claimWithdrawals (0xe3afe0a3) tx
      0x4ee1e57b452f69d8f9b2186e0b8539411a2f2724041baf44a7e8abee80d891be, Hoodi block 3811689, status 0x1 on publicnode (Geth 1.17.7) AND
      rpc.hoodi.ethpandaops.io (ethrex 29.0.1 — the pass's third client);
      nonce 10, gasLimit 90,388, gasUsed 74,510, effectiveGasPrice
      963,469,628, fee 71,788,121,982,280 wei (the quoted worst case
      189,918,786,784,212); findCheckpointHints → hint 1035 against
      lastCheckpointIndex 1036; getClaimableEther 30,000,000,000,000,000 =
      WithdrawalClaimed's amount = paid; the request NFT burned
      (Transfer); the dev EOA's ETH 32.519532161412709615 →
      32.549460373290727335 (delta 29,928,211,878,017,720 = 0.03 − the
      fee, exact); stETH, shares, wstETH, rETH and both allowances
      unchanged (the request's stETH was taken at request time). THE
      WHOLE HOODI LIDO CYCLE IS NOW PROVEN LIVE: stake, wrap, unwrap,
      request, finalisation by the oracle, claim. Account 1's request 5329
      is claimed in-app in the running emulator pass. Dry-run note: the
      Sepolia dev-owner stake simulates at 110,501 gas today (the public
      test account at 208,421 — the first-stake shares slot), consistent
      with the STAKING.md §4.3 resolution.
- [x] Item-0 pass findings FIXED, incl. the gas allowances behind every
      scheduled plan (commit 4ed6978; check-dca 155 (was 135),
      check-recurring 197 (192), check-staking 122 (115), check-activity
      270 (261), check-simulation 88 (81), check-approvals 228 (220);
      offline runner ALL GREEN in the CTO's isolated worktree with only
      the sixteen files on HEAD b4fd034: engine 990, app 8,503 across 56
      suites, lint 0/0, tsc clean; 13 mutants caught; this slice was
      rebuilt after its first agent was cut by the weekly Opus limit; not
      seen on a device). (2, SAFETY) GAS ALLOWANCES: GasPolicy charges the
      SIGNED limits (vGL + cGL + pVG) × the signed maxFee, not the gas
      used — read back from each bundle's handleOps input (Sepolia,
      2026-10-13): DCA script swap 1 987,890 + 379,444 + 52,779 =
      1,420,113 (× 1.155 gwei = the recorded 1.64e15 wei), swap 2
      1,204,793, the in-app swap 1,205,388; recurring payment 1 670,981 +
      26,011 + 48,181 = 745,173, payment 2 565,743; the phase-13 ERC-20
      pull 438,168 (matches) — so BOTH allowances were below live charges
      after Glamsterdam: DCA_SWAP_GAS_ALLOWANCE 1,000,000 → 1,800,000
      (27% above 1,420,113; DCA_SWAP_LARGEST_RECORDED_CHARGE_GAS) and
      SUBSCRIPTION_PULL_GAS_ALLOWANCE 500,000 → 1,000,000 (34% above
      745,173; SUBSCRIPTION_LARGEST_RECORDED_CHARGE_GAS — shared by
      recurring payments AND merchant subscriptions, whose default budget
      therefore doubles); pinned: the minimum-viable budget exceeds the
      largest live charge × the fee, and a keep-back equal to one live
      charge is now blocked as too small (it was "fitted" before); the
      pricing note cites the figures. (8) SESSION KEYS: NO LEAK — a review
      creates its key in memory only (a new address per review by design);
      the only vault write is inside installSession after Start's device
      check; discardPending zeroes all three pending keys at the start of
      every review and on unmount; pinned with the real createKeyVault
      over a fake secure store (two DCA reviews, and a recurring plus a
      subscription review, leave ZERO entries; Start leaves exactly one
      under its record's vault id; a source pin forbids any vault or
      install call in the three review handlers); residual by design: a
      record that failed after Start keeps its key until Forget (the wipe
      removes it). (6) the gap was in the staking OUTCOME card, not the
      Balance-changes card: "Simulated: 0.004820023614978392 rETH leave
      (token contract 0x…)." / "Simulated: 0.005 stETH leave …" before
      the arrive lines; a stake shows "Simulated: 0.01 test ETH leave."
      (7) the preview labels an untracked pinned staking token "stETH
      (pinned staking token)" from the token table (no eth_call). (5) the
      Rocket Pool confirm: "…can refuse moving or redeeming rETH for up to
      5,760 blocks after a deposit if a deposit lock is recorded for the
      address; in the deployed Hoodi code no lock was recorded in two live
      runs (a burn succeeded 20 blocks after the deposit), but the wallet
      still checks the stored lock before a burn." (4) risk card: "This
      transaction goes to Rocket Pool's deposit pool (0x…), resolved just
      now from Rocket Pool's pinned RocketStorage contract on Hoodi."
      (RocketStorage re-read at every check; a different resolved address,
      a failed read, or a registry whose rETH is not the pinned one keeps
      the generic lines); Activity "Staked 0.01 test ETH with Rocket Pool
      (deposit pool 0x425E…3Fd8, resolved from RocketStorage): received …
      rETH" — "Staked", not "Deposited", because the engine's verb list
      (activity-decode.ts, not this slice's file) has no "deposited"
      (follow-up: add it). (1) the form hint after a cap: "The field shows
      this lowered figure; clearing a figure you typed brings it back, not
      the usual budget." (3) before set-up "X USDC per swap will be fixed
      when the plan is set up."; the card keeps the past tense. NOT DONE:
      docs that still quote 500,000 / 1,000,000 per operation need the
      refresh; Activity still reads an untracked pinned staking token as
      "(untracked token …)" (the engine's label function would need the
      preview's rule). UNVERIFIED (device): the new copy; a plan funded
      under the higher thresholds running its first operation; the
      deposit-pool risk line and sentence against live RocketStorage; the
      outcome card's new lines on a real burn or request.
- [x] EIP-7702 AFTER GLAMSTERDAM ON SEPOLIA — checked at the Chairperson's
      question, nothing broken (commit 44d0148; engine 994 — chains-evm 723,
      +4 — check-7702 179 (was 157); offline runner ALL GREEN in the CTO's
      isolated worktree on top of 4ed6978: app 8,525 across 56 suites, lint
      0/0, tsc clean; the eip7702-smoke dry run passed there; the CTO
      wired setCodeWorstCaseGasText into UpgradeAccountScreen (the one line
      outside the agent's files) and pinned it; the dev EOA spent ~0.00034
      Sepolia ETH). FACTS (fetched 2026-10-13): EIP-7702 shipped with
      Pectra — Sepolia epoch 222464 = 2025-03-05 07:29:36 UTC (EIP-7600 at
      ethereum/EIPs 9be3a7ec; the Pectra testnet blog post agrees); its
      text unchanged since bbc3f958 (2025-10-07); GLAMSTERDAM (EIP-7773)
      activated on Sepolia 2026-10-06 13:53:36 UTC (epoch 353024), Hoodi
      and mainnet undated; of its 18 EIPs only 2780, 8037 and 8038 change
      7702 costs (7928 mentions it for access-list bookkeeping; 7997 and
      8282 in passing). EIP-2780 "replace[s] … EIP-7702's flat
      PER_EMPTY_ACCOUNT_COST × authorization_list_length intrinsic
      charge": each authorization 7,816 (EXECUTION_PER_AUTH_BASE_COST) at
      the intrinsic stage, then once per authority before any code runs
      120 × CPSB = 183,600 state gas if the authority does not exist,
      ACCOUNT_WRITE 9,000 unless the authority is the sender, 23 × CPSB =
      35,190 for a new delegation indicator, 3,000 to load a delegate's
      code (EIP-8038's cold access 2,600 → 3,000); the 12,500 refund is
      gone; NEW FAILURE MODE: "If the transaction goes out-of-gas in this
      pre-execution phase, the sender pays for all gas consumed, and all
      pre-execution state changes are reverted, including any EIP-7702
      delegations." go-ethereum v1.17.8 params/protocol_params.go carries
      ExecutionPerAuthBaseCost 7816, TxBaseCost2780 12000,
      ColdAccountAccessAmsterdam 3000, AccountWriteAmsterdam 9000,
      AuthorizationCreationSize 23, CostPerStateByte 1530 (applied in
      IntrinsicGas / applyAuthorization / chargeCallRecipientEIP2780);
      EIP-8037 still says "The values are not yet final". THE WALLET'S
      OWN TRANSACTION (one authorization, to itself, value 0, no data):
      intrinsic 46,000 → 19,816 (12,000 + 7,816); an upgrade 46,000 →
      58,006 before Kernel's code runs; a revocation 36,800 (after the old
      refund) → 19,816; re-delegating an already delegated account →
      22,816. THE QUOTE: delegation.ts's fixed limit 46,000 + 40,000 =
      86,000 is NOT understated — eth_estimateGas on the exact shape
      (geth 1.17.7, reth 2.7.0, erigon 3.7.1 agreeing; a throwaway key,
      balance override, nothing sent): upgrade 60,212, revocation 19,980,
      re-upgrade 24,542; someone else's transaction carrying the tuple
      (the bundler shape) 72,259 if the account exists, 258,184 if empty;
      Hoodi (old rules, forkId 0x23aa1351) 47,725 / 46,382. KEPT at 86,000
      (CTO agrees): the ~26,600 headroom now matters because running
      short reverts the delegation but charges the fee; the authorization
      is signed only after the biometric gate (D6) so it cannot be
      estimated at quote time; a stand-in authorization recovers to an
      unrelated account the new rules price very differently. FINDING: for
      node methods geth 1.17 and erigon 3.7 REJECT the engine's
      toRpcEip7702Auth format ("0x00"/"0x01" yParity, zero-padded r/s);
      reth accepts it; the app never sends an authorization to a node and
      ZeroDev accepts the format for bundled ops, so it stays —
      toRpcEip7702AuthQuantities added for node methods. LIVE on Sepolia
      (dev index 7 0xFDF5…2F14; every status 0x1 on publicnode and Pocket):
      funding 0x8217b859…5599 (block 11909821); a BUNDLER-CARRIED UPGRADE
      through ZeroDev — userOp 0xfcc11fd4…796f, bundle tx
      0xdec3d0afe469f7adfce3057e43777532c69ddb9f603a9c1bb5cea6175935b411,
      block 11909822, type 0x4 carrying the authorization, code →
      0xef0100d6ce…5b28, bundle gas 170,592 of 216,850, the op's pVG
      81,367 vs 52,492 without an authorization, 3 EIP-7708 logs from the
      op's own ETH moves; while delegated entrypoint() = v0.7,
      isValidSignature 0x1626ba7e, a third-party initialize() reverted;
      REVOCATION 1 0xa1de173a…1114 (block 11909823) gas used EXACTLY 19,816
      of 86,000, no logs, code 0x; THE WALLET'S OWN SELF-PAID UPGRADE —
      the first self-paid delegation (not only a revocation) sent live —
      0xb0be116c48d7a43b93f2b304283b0e0a7945dce74ac53d389a1a6bebdbfd10f8,
      block 11909825, estimate 60,212, gas used 59,393 = 58,006 + 1,387
      for Kernel's empty call, code = the designator, one Received log, no
      7708 log (value 0), fee 59,393 × 1,000,002 wei; operations from the
      delegated account with no authorization (bundle txs 0xe5f091c1…271f
      block 11909826 and 0xcfb8016f…f459 block 11909829); REVOCATION 2
      0x1b9f8b6c…e079 (block 11909830) 19,816 gas, code 0x; sweep back
      0xf731db2a…eb70 (block 11909832); the dev EOA 0.044095 → 0.043755.
      CHANGES: packages/chains-evm/src/eip7702.ts gains the Glamsterdam
      constants (each sourced), selfSponsoredSetCodeCharges,
      relayedAuthorizationGas and toRpcEip7702AuthQuantities (additions
      only; 4 tests); delegation.ts keeps the limit, documents both
      schedules with the live figures, SET_CODE_AMSTERDAM_ACTIVATION from
      EIP-7773, setCodeGasRulesFor (mainnet and Hoodi old rules; Sepolia
      new after activation; layer-2 and custom networks 'unknown'),
      setCodeWorstCaseGasText (byte-identical to the old text under the
      old rules); the Upgrade screen now renders it instead of "incl.
      25,000 for the authorization" (pinned); eip7702-smoke.mjs estimates
      every set-code tx against the limit and refuses one above it, reports
      each set-code receipt on two RPCs against the predicted charges,
      re-reads each bundle receipt on both, and estimates the funding
      transfer's gas (a fixed 21,000 fails for a never-used address after
      the fork); THREAT_MODEL T-36 updated, F-78 added. OTHER RECENT
      SEPOLIA CHANGES (geth 1.17.6–1.17.8, reth 2.6–2.7 notes, EIP-7773,
      the blog): none changes delegated-account behaviour — geth 1.17.6
      rejects setcode call arguments without `to` (the wallet always sets
      it) and dropped a per-authorization guard in eth_createAccessList
      (unused); geth 1.17.8's eth_call no longer applies the tx gas limit
      after the fork; reth returns null for 7702-caused nonce gaps in MEV
      bundle methods only. INFERENCE, not documented: ZeroDev's pVG rose
      ~28,900 for an op carrying an authorization (≈ the old 25,000) while
      the authorization now costs the bundle ~52,000 — the bundler's cost
      today, which ZeroDev could reprice or refuse later. SIDE OBSERVATION:
      0xrpc.io/sep (frozen in F-66) now serves the head (geth 1.17.8).
      UNVERIFIED: mainnet's and Hoodi's eventual Glamsterdam values; the
      layer-2 gas schedules; ZeroDev's pVG formula; an empty account's
      authorization carried by a bundler (estimated 258,184, never sent);
      nethermind and besu; the in-app upgrade and revoke after the fork
      (script only; the screen text change not yet seen on a device).
- [x] Follow-up — ACTIVITY LABELS A PINNED STAKING TOKEN LIKE THE PREVIEW
      (commit 781a146; engine 995 — chains-evm 724, +1 — check-activity 277
      (was 270); offline runner ALL GREEN in the CTO's isolated worktree
      on HEAD 979f7a5 plus the slice: app 8,532 across 56 suites, lint
      0/0, tsc clean; two hand mutants caught; not seen on a device). The
      app side needed NO change: simulation.ts resolveTokenMeta has set
      pinned: true for an untracked token at a knownStakingTokensForChain
      address on its own network since 4ed6978, and Activity passes that
      metadata into the engine, which ignored it. ENGINE (additive):
      ActivityTokenMeta.pinned?; token() checks it after the tracked
      symbol and before the known-contract / untracked / raw-address
      branches → "stETH (pinned staking token)"; every label without the
      flag byte-identical. Pinned: pinned+untracked, pinned+tracked (plain
      "stETH"), no flag and pinned:false (the old "(untracked token
      0x3e3F…40Af)"), pinned with no symbol ("token 0x…"); through the
      real decoder and resolver an untracked stake reads "…received
      0.000199999999999999 stETH (pinned staking token)", an ordinary
      unknown token keeps "(untracked token …)", a look-alike one digit
      off the pinned address is not pinned, Sepolia's stETH is not pinned
      with the decoder on Hoodi. Docs were checked for the old 500,000 /
      1,000,000 gas allowances: none quote them. UNVERIFIED: the label on
      a device (the Sepolia emulator wallet tracks stETH and wstETH, so it
      shows only for an untracked pinned token).
- [x] EMULATOR PASS p20b — LOCK ON LAUNCH, THE HOODI CLAIM IN-APP, THE
      PORTFOLIO LAYER AND THE POLISH CARDS (2026-10-14 00:50–03:05 UTC;
      Expo Go, Metro worktree at 8402891 with the engine built inside it,
      2,373 modules; no repo files edited; 9 prompts, each expected; no
      dev-EOA spending; every hash status 0x1 on two RPCs per chain and
      the three key receipts re-read by the CTO on publicnode; screen
      protection OFF; notes, frames and dumps in the scratchpad p20b).
      (A) LOCK ON LAUNCH — PASS, by an on-device screencap loop (~0.33 s
      per frame, ~87 frames per launch, each changed frame viewed):
      force-stop + relaunch → splash → the neutral cover (background +
      spinner, no data, no button, ~1.2 s) → the lock, ZERO Home frames;
      unlock = exactly ONE prompt (logcat handleAuthenticate 1) "Unlock
      Shiba Wallet" with only Cancel; recents swipe + `am kill` (process
      gone) → the same sequence, eight uiautomator dumps from launch hold
      only the splash then the lock texts ("Auto-lock is on, so the wallet
      starts locked. Your keys never left the device's secure storage."),
      no wallet text in any dump; auto-lock OFF → splash, a blank frame,
      the cover (~1 s), Home, 0 prompts (then set back to 1 min);
      WATCH-ONLY active ("Watched 3", 0xd8dA…6045) → the lock, unlock =
      ONE ORDINARY prompt with "Use PIN", THE PHRASE PROMPT NEVER
      APPEARED; removed afterwards. The Settings hint reads exactly as
      pinned. (B) THE HOODI CLAIM OF REQUEST 5329 — PASS, IN-APP (Account
      1): before, on both RPCs lastFinalized 5333, 5329 finalised and
      unclaimed, getClaimableEther([5329], hint 1035) = 5e15; the card
      "REQUEST 5329 / 0.005 stETH / Finalized: ready to claim."; confirm
      "You receive 0.005 test ETH", "Simulated: 0.005 test ETH arrive.",
      the queue address in full, max fee 0.00017672762226262 (1.955211115
      gwei × 90,388), "Claims request 5329; the ETH is paid to this
      account.", preview "You send NFT #5329" / "You receive 0.005 test
      ETH", the pinned queue risk line, "Pre-flight simulation passed";
      ONE prompt "Claim finished Lido withdrawals"; tx
      0xf7baf501cf09b0a30604215e8a8546aea5f23d38032ca041c1ff8b9ccf1e2f78,
      block 3811831, input 0xe3afe0a3, gas 74,510, WithdrawalClaimed
      (request 5329, owner and receiver Account 1, 5e15 wei), NFT 5329
      burned; balance 284,253,499,485,668,980 → 289,179,697,600,991,260 =
      +0.005 − fee 73,801,884,677,720, exact; the requests section gone
      afterwards; 5328 untouched. THE WHOLE LIDO CYCLE IS NOW PROVEN
      THROUGH THE APP ON HOODI (stake, request, finalisation, claim; wrap
      / unwrap on Sepolia). (C) PORTFOLIO — PASS for the screens; THE
      WALLET HOLDS NO MAINNET DUST (0 ETH on mainnet for every account on
      two RPCs, 0 BTC, 0 SOL, no Dogecoin endpoint): Sepolia "Net worth
      (US dollars) ≈ $0.00", "Not complete: see what is not counted
      below.", "3 balances could not be read because no endpoint is
      configured for their network (for example Dogecoin…)", "test ETH,
      USDC, EURC, stETH and wstETH are test-network assets: test, no
      value.", "Multisig 3 (2-of-3) is recorded for another network and
      was not read.", by asset / network ("Ethereum Sepolia ≈ $0.00 (11
      not valued)") / account (Account 1, its smart account, Account 2,
      Account 3's smart account, Multisig 2); Hide amounts "••••"
      everywhere with spoken "Net worth: hidden, not complete"; a11y
      "Account 1, USDC on Ethereum Sepolia: 41.089603 USDC, test asset,
      no value"; mainnet "By asset: No balances found yet."; with the
      watched address: the price-source line ("…the oldest price used is
      from less than a minute ago. Indicative market prices…") and
      "Watched total (not counted in your net worth): ≈ $14,501.52" (ETH
      5.769653 ≈ $14,464.34, USDC 37.192124) with net worth still $0.00.
      P&L ETH: "0 entries of history loaded; older ones exist." then
      after one load "…which is all of it.", every figure $0.00, "Average
      cost: nothing held", "Counted: 0 purchases, 0 sales", the method,
      nearest-price and estimate notes; BTC the same (the no-counterparty
      gap does not appear with an EMPTY history — the record's "always
      shows that gap" was too strong). (D) PRICE ALERTS — PASS: "Follow
      Ethereum (ETH)" $2,504.97; "Above $2,500" created tripped with the
      sentence; "Below $2,510" ALSO created tripped BY DESIGN ("ETH is
      already below $2,510 ($2,502.66 now), so this alert fires the next
      time it crosses $2,510 after first moving back 1% to the other
      side."); an untripped "above $2,503.5" ("Waiting to fire.") fired at
      the next 5-minute check: the banner "Price alert: ETH above
      $2,503.5. CoinGecko's price was $2,505.97, 1 min ago. Alerts are
      advisory: nothing is bought, sold or sent." with "Open price alerts"
      / "Dismiss", then the card "Fired 1 min ago at $2,505.97"; no
      notification (Expo Go note shown, reminders off); NO COINGECKO
      TRAFFIC for 2 min 19 s after every alert was deleted and ETH
      unfollowed (nettop on the host's netsimd flow; the positive control
      opened a flow to api.coingecko.com). (E) POLISH: E1 a smart-account
      stake of 0.0001 → stETH (ONE prompt) userOp
      0xbffb221c6e4317326e07e1f8f2beb43a954e08a5f14631b0254d7ab5f5355e0e,
      bundle tx
      0xff30070c0f82c2d38cdf30c45c46bbe39e26864cff91ffa3287cf71c16ee09ca,
      block 11910307, minted 99,999,999,999,999, actualGasCost
      726,899,083,068,328 from the deposit; Activity "Pending on this
      phone / Smart-account operation 0xbffb…5e0e from Staking." with
      "Check status" → "Included in transaction 0xff30…09ca." (EVERY
      SMART-ACCOUNT OPERATION IS RECORDED, seen live). E2 the multisig
      confirm: dev 5's approval accepted (request 0x786b567e…, nonce 3);
      the first Review refused with the multisig AA21 text (balance
      506,657,538,030,260 + deposit 697,166,493,513,196 wei); funded
      0.002 from Account 1's Kernel (ONE prompt; userOp 0xc56f70f2…1dda7,
      tx 0x8934a91e43dbd89458c9c1af9222e8b9b62b7123309a655fd155363aa5c3cb99,
      block 11910363); "Continue the operation being approved" →
      "Review and submit" shows the call, "Balance changes (preview)" /
      "You send 0.0001 test ETH" / "Simulated as direct calls from the
      multisig account…", "Risk checks" / "…one of your own accounts in
      this wallet: Account 2 (0xb699…81fE).", fee 0.00095898897580392,
      deposit-first, total, the weight sentence, "Approve and submit" —
      NOT submitted; mirror: dev 5's request pasted → the co-signer
      review → ONE prompt → "Approval ready"; History "Approved as
      co-signer: Send 0.0001 test ETH (100000000000000 wei) to
      0xb699…81fE. (request 0x786b567e…)" / "Nonce 3 · approved by
      0x772e…F44F on 2026-10-14 02:56 UTC. Whether it was submitted is up
      to the submitter; this phone does not track it." E3 the fee symbol
      on the regular path: 0.01 USDC sent to Account 3's EOA (0 ETH; tx
      0x37912b612b194d14ed01971083ad397d6210d6978497b5421af7dc1b9524fb71,
      block 11910439), then as Account 3 a 0.005 USDC send → "Not enough
      test ETH to pay the network fee." / "…the worst-case fee is
      54645092880 wei but the test ETH balance is 0 wei. Token sends pay
      gas in test ETH, not in USDC." (the smart-account variant not
      exercised). FUNDS: Hoodi Account 1 0.289179697600991260 ETH (nonce
      6); Sepolia Kernel 0.022837 → 0.020321 ETH, deposit 0.001105 →
      0.000219, +0.0001 stETH; Account 1 EOA USDC 41.089603 → 41.079603;
      Multisig 2 0.000507 → 0.002507 (+ deposit 0.000697); Account 3 EOA
      0.01 USDC (stranded without test ETH). FINDINGS (fix slice
      dispatched): (1) COPY — the Auto-lock hint promises "your device
      passcode as the system fallback" but Account 1's unlock prompt (the
      protected-phrase target) offers only Cancel; only the watch-only
      prompt offers "Use PIN"; (2) the portfolio brief's "mainnet dust"
      does not exist (no finding against the app); (3) P&L COPY with zero
      history: "0 entries of history loaded; older ones exist." and
      "cannot be worked out … older transactions are not loaded yet"
      before the first load, then "which is all of it"; the BTC
      no-counterparty gap needs at least one entry; (4) ALERTS COPY — "it
      can fire once ETH falls back below the price by 1%" reads as if the
      fall itself fires it (the rule is retrace then a fresh crossing);
      (5) ALERTS STALE DISPLAY — the watchlist card kept $2,502.66 after
      the monitor fired at $2,505.97, even after a foreground return; the
      "Alert set: ETH above $2,503.5." notice outlived every alert's
      removal; Remove deletes with no confirmation; (6) a "below" alert
      set above the price starts tripped by design (no change); (7)
      MULTISIG CONFIRM COPY — the preview says the fee "is shown
      separately above" while the fee rows sit BELOW it; (8) Multisig 2
      needed ~0.002 of top-up for one operation at 2.31 gwei (the headroom
      economics; no change); (9) ACCOUNT SWITCHER — "Multisig 2 (2-of-3)"
      and "Multisig 3 (2-of-3)" show the same address 0x944c…0d38 with no
      network (Sepolia vs Base Sepolia; the same CREATE2 address) and look
      like duplicates; (10) the pending card keeps the "cannot be sped up
      or cancelled…" paragraph after "Included in transaction …"; (11)
      Hide amounts turns test assets' spoken labels into "amount hidden,
      value hidden" although they have no value. DRIVING NOTES: launch
      the AVD through osascript into a Terminal tab (the tab must first
      answer zsh's compinit prompt); recents swipes do not remove the task
      (`am kill` does); "Manage accounts" lands near "Show recovery
      phrase"; the network chips are ~56 slow swipes down Settings; BACK
      from Home leaves the app and can trip auto-lock; emulator traffic is
      visible on the host through netsimd (nettop). END STATE: Home,
      Ethereum Sepolia, Account 1, light mode, protection OFF, auto-lock 1
      min, no watched account, IME ADBKeyboard, Metro at 8402891; Multisig
      2 holds an unsubmitted in-app operation at nonce 3 (with dev 5's
      approval) and this wallet's unsubmitted co-signer approval of dev
      5's nonce-3 request.
- [x] Item 5 — LEADERSHIP REFRESH, document half (docs commit 17cd874;
      check-readiness 194; docs only; the secret scan clean).
      FEATURE_UNIVERSE section 15: rows 96 (portfolio dashboard) and 98
      (price alerts and watchlists) → Proven live (partial, limits stated:
      the wallet's own net worth was ≈ $0.00 and the priced total was
      seen only on a watched mainnet address; the alert banner fired at
      the 5-minute check, the system notification needs the development
      build); row 97 (profit and loss) → Built, verified offline (the
      panel was seen live only with an EMPTY history); rows 53 (duress
      wallet) and 35 (bridging) → Designed; row 36 (ERC-7683) keeps Not
      started with the refutation; rows 23, 24, 52, 57, 58, 63 and 95
      extended with the phase 20 live runs (the full Lido cycle incl. the
      claim in-app on Hoodi; Rocket Pool deposit and burn in-app; the
      multisig confirm's preview and the co-signer History; the lock on
      launch; the DCA review-time protections and the raised gas
      allowances; every smart-account operation recorded; the
      post-Glamsterdam 7702 check). TALLY: Proven live 49 → 51 (T1 29, T2
      22), Built 17 → 18 (9/9), Designed 1 → 3 (1/2), Not started 32 → 27
      (1/11/15); every count sentence agrees with the table (the CTO
      re-counted the status column: 51/18/3/27). DEMO.md: steps 33 (the
      launch lock), 34 (portfolio and price alerts), 35 (claiming a Lido
      withdrawal on Hoodi), 36 (the multisig confirm's preview and the
      co-signer History); a fourth warning (screen protection stays OFF on
      the emulator; the launch lock needs Unlock + `adb emu finger touch
      1`); the rehearsal status of the existing steps. THREAT_MODEL.md:
      T-79 (the portfolio layer), F-79 (the gas policy charges the signed
      limits; the allowances raised above the live charges), F-77(b)
      proven on the emulator, F-78 corrected (the Upgrade screen already
      renders the schedule-aware sentence); section 7.4's counts are
      updated with the pending fix slice. THE SHAREABLE PAGE was rebuilt
      with the phase-15 builder (scratchpad/fu/build-fu.py; counts
      51/18/3/27 asserted in the tiles, the table and the header; one
      Google-Fonts stylesheet and the one benign filter script, no
      secrets — the CTO scanned the output) and PUBLISHED as VERSION 21 of
      https://claude.ai/artifact/JEfyMuPcMJ8YW5x3ZKitsw; the built file is
      the new base at scratchpad/fu/feature-universe.html. Not
      established from the record: who funded Account 1's 0.3 Hoodi ETH
      (the CTO, from the dev EOA, before pass p20a — the funding
      transaction was not recorded); DEMO step 34 paraphrases the P&L
      empty-history and alert re-arm sentences because the running fix
      slice changes both.
- [x] Pass p20b findings FIXED, and the DEMO.md pin the docs refresh broke
      restored (commit 9aa1ffe; check-devmode 354 (was 351), check-pnl 64
      (56), check-portfolio 68 (63), check-price-alerts 95 (70),
      check-multisig 396 (388), check-pending 151 (147),
      check-screen-protection 87; offline runner ALL GREEN in the CTO's
      isolated worktree on HEAD 3375d1a plus the slice: engine 995, app
      8,585 across 56 suites, lint 0/0, tsc clean; one hand mutant per
      fix caught; not seen on a device). CI NOTE: the docs refresh
      17cd874 reworded the DEMO.md sentence check-screen-protection pins
      ("turn it **off** before" screenshots or recordings), so CI on
      17cd874 and the record commit 3375d1a fails that one check (caught
      by the fix agent's suite run, not by the CTO's docs-only verify —
      check-readiness alone is not enough for a DEMO.md edit; lesson: run
      check-screen-protection and check-devmode on any docs change too);
      this commit restores the sentence for a real phone beside the
      emulator's stays-off rule. (1) AUTO-LOCK HINT, from biometric.ts:
      requireLocalAuth first opens the protected secret through its own
      system prompt (storage.ts requireAuthentication), which has no
      passcode fallback on either platform; the ordinary prompt
      (disableDeviceFallback false) runs only for standard storage,
      watch-only and multisig, or after a protected read fails for a
      reason other than a cancel — the hint now reads "…it locks behind
      the same biometric prompt as sending. While your recovery phrase (or
      the active account's imported key) is protected by biometrics, that
      prompt accepts only biometrics; otherwise your device passcode is
      offered as a fallback. While auto-lock is on, the wallet also starts
      locked…". (3) P&L: hasMore means "older entries can still be
      searched", not that any exist; pnlHistoryLoadedLine → "No
      transactions were found in the history searched so far; older
      history has not been searched yet." / "No transactions were found:
      the history is empty."; the matching gap reason; the
      no-counterparty gap pinned with one confirmed BTC entry ("1
      transaction does not name the other address…"); wording with ≥ 1
      entry byte-identical. (4) alertStateText: "The price was already
      past this alert when you set it; it fires the next time ETH crosses
      $2,500 after first moving back 1% to the other side." / "Fired 1 min
      ago at $2,505.97; it fires again the next time ETH crosses $2,500
      after first moving back 1% to the other side." (5a) each monitor
      check records its quotes (recordMonitorQuotes, cleared by
      resetPriceAlerts); the screen shows the newer of its own quote and
      the monitor's per coin (newestQuote by updatedAtMs else
      fetchedAtMs), feeds the same quote to the already-past check, and
      re-reads on a return to the foreground (useOnAppActive); (5b)
      Remove and Stop following clear the notice; (5c) confirmRemoveAlert
      "Remove this alert?" / "The alert ETH above $2,503.5 is deleted from
      this phone and no longer checked." / Cancel / Remove (destructive;
      nothing removed on show or Cancel). (7) the multisig confirm orders
      fee, total, preview, risk card like Send's smart-account confirm
      (the note byte-identical; a pin keeps Send's fee row above its
      preview so the two cannot drift). (9) each multisig switcher row
      gains "On Ethereum Sepolia" (an unknown network shows its CAIP-2 id)
      and the label "Multisig 2 (2-of-3), multi-signature account on
      Ethereum Sepolia, 0x944c…"; pinned with two multisigs at the same
      address on two chains. (10) userOpShowsNoReplacementSentence: the
      paragraph shows only while the status is not "included". (11)
      holdingSpokenLabel under Hide amounts: a test asset "…, amount
      hidden, test asset, no value", an unpriced asset "…, amount hidden,
      no price", a priced asset unchanged. UNVERIFIED (device): the new
      layouts (the network line, the fee rows above the preview, the hint
      length), the foreground re-read and the monitor-fed quote in Expo
      Go, the Remove dialog, TalkBack on the new labels; which history
      source served mainnet in pass p20b's P&L step.

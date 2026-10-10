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
  Since phase 17 item 0 the app blocks screenshots everywhere by default:
  turn Settings → Privacy → "Hide in the app switcher and block
  screenshots" OFF at the start of a pass that needs screencap, and ON
  again at the end.
- Every slice is verified by the CTO in an isolated worktree with the
  offline runner before it is pushed, then recorded here, then CI is
  checked. When several agents work in the main checkout at once, a
  slice's commit must stage shared registries (scripts/ci/suites.mjs,
  readiness ids, check-readiness expectations) from a FILTERED copy that
  holds only the lines whose files are in that commit; the verify run
  and the commit must use the same snapshot of the diff (2026-10-10: a
  registration added by another agent between the verify run and the
  commit broke CI with "lists scripts that do not exist"). The verify worktree must resolve @shiba-wallet/* to ITS OWN
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

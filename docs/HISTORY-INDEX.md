# Phase index — what each closed phase delivered

One bullet per phase, moved verbatim from AGENTS.md on 2026-11-20. Full
records: docs/HISTORY.md (phases 1 to 12) and docs/HISTORY-phases-13-27.md
(phases 13 to 27; grep it, never read it whole). Many commit hashes
recorded there are pre-rewrite: look every hash up in the git-ignored
.local/history-rewrite-2026-11-03-commit-map.tsv before checking
anything out (the rule is in AGENTS.md, under the read-first table).

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
  in verify-pins.mjs. Its status section is the last section of
  docs/HISTORY-phases-13-27.md.

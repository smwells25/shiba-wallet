// Classification of the app's script suites (app/scripts/*.mjs) for the CI
// runner. Every script in app/scripts must appear here exactly once; the
// runner refuses to start when a script is missing, so a new suite can never
// silently escape CI.
//
// Kinds:
//   offline       Fakes only. Runs in both modes.
//   flag-live     Offline by default; `--live` adds read-only live probes.
//                 Offline mode runs it without the flag; live mode adds it.
//   env-live      Offline checks, plus a live section that runs only when
//                 the git-ignored .dev-wallet/env provides a key. Offline mode
//                 hides .dev-wallet (see offline-guard.mjs), so the live
//                 section is skipped deterministically; live mode leaves it
//                 visible.
//   live          Talks to public endpoints unconditionally. Live mode only.
//   helper        A module imported by other scripts, not a suite.
//
// `summary: 'counts'` means the script prints "N passed, M failed" at the end
// (some prefix it with their own name); the runner requires that line.
// `summary: 'exit'` means the script prints no counts and only its exit code
// is meaningful.

export const APP_SCRIPTS = {
  'test-units.mjs': { kind: 'offline', summary: 'counts' },
  'check-7702.mjs': { kind: 'offline', summary: 'counts' },
  'check-activity.mjs': { kind: 'offline', summary: 'counts' },
  'check-aa.mjs': { kind: 'offline', summary: 'counts' },
  'check-aa-kernel.mjs': { kind: 'offline', summary: 'counts' },
  'check-aa-urls.mjs': { kind: 'offline', summary: 'counts' },
  'check-accounts.mjs': { kind: 'offline', summary: 'counts' },
  'check-approvals.mjs': { kind: 'offline', summary: 'counts' },
  'check-contacts.mjs': { kind: 'offline', summary: 'counts' },
  'check-devmode.mjs': { kind: 'offline', summary: 'counts' },
  'check-failover.mjs': { kind: 'offline', summary: 'counts' },
  // Phase 12 Base Sepolia findings: Home reload after a send, eligibility
  // re-checks, dust display, profile copy and local dates (fakes only).
  'check-home.mjs': { kind: 'offline', summary: 'counts' },
  'check-nfts.mjs': { kind: 'offline', summary: 'counts' },
  'check-passkeys.mjs': { kind: 'offline', summary: 'counts' },
  'check-proof.mjs': { kind: 'offline', summary: 'counts' },
  'check-qr.mjs': { kind: 'offline', summary: 'counts' },
  'check-readiness.mjs': { kind: 'offline', summary: 'counts' },
  'check-recovery.mjs': { kind: 'offline', summary: 'counts' },
  'check-sessions.mjs': { kind: 'offline', summary: 'counts' },
  'check-settings-protection.mjs': { kind: 'offline', summary: 'counts' },
  'check-siwe.mjs': { kind: 'offline', summary: 'counts' },
  'check-spending-policy.mjs': { kind: 'offline', summary: 'counts' },
  'check-simulation.mjs': { kind: 'offline', summary: 'counts' },
  'check-storage.mjs': { kind: 'offline', summary: 'counts' },
  // Phase 12 item 2: subscription grants on Kernel session keys (fakes only).
  'check-subscriptions.mjs': { kind: 'offline', summary: 'counts' },
  'check-swap.mjs': { kind: 'offline', summary: 'counts' },
  'check-token-send.mjs': { kind: 'offline', summary: 'counts' },
  // Phase 13 item 2: paying the network fee in USDC through Circle's paymaster (fakes only).
  'check-token-gas.mjs': { kind: 'offline', summary: 'counts' },
  'check-typed-data.mjs': { kind: 'offline', summary: 'counts' },
  'check-wc.mjs': { kind: 'offline', summary: 'counts' },
  'check-wc-5792.mjs': { kind: 'offline', summary: 'counts' },

  // Offline: OP-stack L1 data fee in the EOA send quotes (fake GasPriceOracle);
  // --live adds a read-only getL1Fee quote on Base Sepolia.
  'check-base.mjs': { kind: 'flag-live', summary: 'counts' },
  'check-prices.mjs': { kind: 'flag-live', summary: 'counts' },
  'check-rpc-fallback.mjs': { kind: 'flag-live', summary: 'counts' },
  'check-token-history.mjs': { kind: 'flag-live', summary: 'counts' },
  // Offline: ABI decoder and token store; --live adds the eth_call reads of
  // USDC against the default mainnet RPC.
  'check-tokens.mjs': { kind: 'flag-live', summary: 'counts' },

  'check-doge.mjs': { kind: 'env-live', summary: 'counts' },
  'check-indexer.mjs': { kind: 'env-live', summary: 'counts' },

  'check-balances.mjs': { kind: 'live', summary: 'exit' },
  'check-history.mjs': { kind: 'live', summary: 'exit' },

  'fakes-kernel.mjs': { kind: 'helper' },
};

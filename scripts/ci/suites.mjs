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
  'check-aa.mjs': { kind: 'offline', summary: 'counts' },
  'check-aa-kernel.mjs': { kind: 'offline', summary: 'counts' },
  'check-accounts.mjs': { kind: 'offline', summary: 'counts' },
  'check-approvals.mjs': { kind: 'offline', summary: 'counts' },
  'check-contacts.mjs': { kind: 'offline', summary: 'counts' },
  'check-devmode.mjs': { kind: 'offline', summary: 'counts' },
  'check-nfts.mjs': { kind: 'offline', summary: 'counts' },
  'check-passkeys.mjs': { kind: 'offline', summary: 'counts' },
  'check-qr.mjs': { kind: 'offline', summary: 'counts' },
  'check-recovery.mjs': { kind: 'offline', summary: 'counts' },
  'check-sessions.mjs': { kind: 'offline', summary: 'counts' },
  'check-simulation.mjs': { kind: 'offline', summary: 'counts' },
  'check-swap.mjs': { kind: 'offline', summary: 'counts' },
  'check-token-send.mjs': { kind: 'offline', summary: 'counts' },
  'check-wc.mjs': { kind: 'offline', summary: 'counts' },
  'check-wc-5792.mjs': { kind: 'offline', summary: 'counts' },

  'check-prices.mjs': { kind: 'flag-live', summary: 'counts' },
  'check-rpc-fallback.mjs': { kind: 'flag-live', summary: 'counts' },
  'check-token-history.mjs': { kind: 'flag-live', summary: 'counts' },

  'check-doge.mjs': { kind: 'env-live', summary: 'counts' },
  'check-indexer.mjs': { kind: 'env-live', summary: 'counts' },

  // check-tokens has an offline section (ABI decoder, token store) followed
  // by an UNCONDITIONAL live section (eth_call against the default mainnet
  // RPC), so it cannot run offline without editing the script. It runs in
  // live mode only until its live section is gated behind --live.
  'check-tokens.mjs': { kind: 'live', summary: 'counts' },
  'check-balances.mjs': { kind: 'live', summary: 'exit' },
  'check-history.mjs': { kind: 'live', summary: 'exit' },

  'fakes-kernel.mjs': { kind: 'helper' },
};

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
  // Phase 16 item 2: the in-app browser's allowlisted-sites slice (origin
  // rules, frame rule, method table, read proxy, the bridge through the real
  // WcController with the real provider script in a fake page; fakes only).
  'check-browser.mjs': { kind: 'offline', summary: 'counts' },
  'check-accounts.mjs': { kind: 'offline', summary: 'counts' },
  'check-approvals.mjs': { kind: 'offline', summary: 'counts' },
  'check-contacts.mjs': { kind: 'offline', summary: 'counts' },
  'check-devmode.mjs': { kind: 'offline', summary: 'counts' },
  'check-failover.mjs': { kind: 'offline', summary: 'counts' },
  // Phase 12 Base Sepolia findings: Home reload after a send, eligibility
  // re-checks, dust display, profile copy and local dates (fakes only).
  'check-home.mjs': { kind: 'offline', summary: 'counts' },
  // Phase 14 item 4: the inheritance switch (test-network demonstration on the
  // guardian modules): rules, record role, takeover scan, removal + vetoes (fakes only).
  'check-inheritance.mjs': { kind: 'offline', summary: 'counts' },
  // Phase 13 item 3: single private-key import (feature 12, ADR D9): engine
  // validation, the imported-key vault, signing selection and refusals,
  // a full EOA send and a smart-account operation (fakes only).
  'check-key-import.mjs': { kind: 'offline', summary: 'counts' },
  'check-nfts.mjs': { kind: 'offline', summary: 'counts' },
  // Phase 14 item 1: payment requests (EIP-681, BIP-321, the Dogecoin
  // format, Solana Pay): spec examples, refusals, round trips and QR codes.
  'check-payment-request.mjs': { kind: 'offline', summary: 'counts' },
  'check-passkeys.mjs': { kind: 'offline', summary: 'counts' },
  'check-proof.mjs': { kind: 'offline', summary: 'counts' },
  'check-qr.mjs': { kind: 'offline', summary: 'counts' },
  'check-readiness.mjs': { kind: 'offline', summary: 'counts' },
  'check-recovery.mjs': { kind: 'offline', summary: 'counts' },
  // Phase 15 item 1: recurring payments pushed by this phone (subscription grant, key kept on the device, confirm before each payment; fakes only).
  'check-recurring.mjs': { kind: 'offline', summary: 'counts' },
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
  // Phase 14 item 6: watch-only accounts (feature 10): the id range, the
  // account store, signWith's refusal with zero secure-store reads, the
  // route allow list and the audit list (fakes only).
  'check-watch-only.mjs': { kind: 'offline', summary: 'counts' },

  // Offline: OP-stack L1 data fee in the EOA send quotes (fake GasPriceOracle);
  // --live adds a read-only getL1Fee quote on Base Sepolia.
  'check-base.mjs': { kind: 'flag-live', summary: 'counts' },
  // Phase 14 item 2: ENS names in the Send recipient field (fake resolver
  // answers); --live adds read-only Universal Resolver lookups on Ethereum
  // mainnet and Sepolia through the keyless default RPCs.
  'check-names.mjs': { kind: 'flag-live', summary: 'counts' },
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

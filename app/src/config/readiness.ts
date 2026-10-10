import { EVM_TEST_PROFILES } from './evm-chain.ts';

/**
 * Chairperson decision (2026-10-02): the plain-feature rows ('blocked' but
 * not enforced) stay ADVISORY on purpose. This wallet is a prototype whose
 * point is to show that these features work inside an account-abstraction
 * wallet, so plain sends, tokens, NFTs, swaps, WalletConnect and Dogecoin
 * keep working on mainnet while Settings states what has not been cleared.
 * Smart-account features remain enforced testnet-only until C1–C3 clear.
 *
 * Mainnet readiness switchboard (phase 9 item 6; docs/THREAT_MODEL.md
 * checklist item W9).
 *
 * One table says, for every user-facing feature, whether this build may use
 * it with real funds on a main network. It is pure data plus small helpers
 * with a single import of pure data (./evm-chain.ts), so Node scripts
 * (scripts/check-readiness.mjs and the other app suites) load this exact
 * file under type stripping.
 *
 * WHERE THE STATUSES COME FROM. docs/THREAT_MODEL.md section 5 (the
 * mainnet-readiness checklist) and its leadership summary, as committed at
 * the time of writing:
 *  - No condition in section 5.1 (C1 audit coverage, C2 bug-bounty
 *    coverage, C3 support horizon for Kernel v3) is met, so every feature
 *    that runs on the Kernel v3.3 smart account or a module installed on it
 *    is 'testnet-only'. SimpleAccount is 'testnet-only' too: this wallet has
 *    exercised it only on Sepolia, it cannot sign messages for apps (F-11),
 *    and Alchemy's bundler refuses its deployment (F-10). Paymaster
 *    sponsorship is used only by smart accounts and has never run live (W8).
 *  - The plain-account features (regular sends, tokens, NFTs, swaps,
 *    WalletConnect, Dogecoin sends) are the document's mainnet candidates,
 *    but section 5.2 still lists unmet conditions that gate them ("For
 *    plain-account features, W1 to W6, W10 to W13 and W17 to W20 are the
 *    gating set"), so each is 'blocked' with its unmet items named.
 *  - Nothing is 'mainnet-ok' today, because every feature has at least one
 *    unmet blocking condition. A status may become 'mainnet-ok' only when
 *    the threat model's checklist shows no unmet blocking item for it.
 *
 * WHAT THE STATUSES MEAN IN THIS BUILD.
 *  - 'testnet-only' features are ENFORCED: the wallet refuses to configure
 *    or start them on any network that is not a test network, before any
 *    network request (app/src/wallet/aa.ts, delegation.ts, sessions.ts,
 *    passkeys.ts and recovery.ts call assertFeatureAllowed). Undo paths
 *    (revoking an upgrade or a session key, removing a passkey or the
 *    guardians, vetoing a recovery, finishing an owner change already sent)
 *    are deliberately NOT gated, so anything set up earlier can always be
 *    taken down.
 *  - 'blocked' features are ADVISORY in this build: the screens that run
 *    them are not changed by this switchboard, so they still work on
 *    mainnet; Settings → Mainnet readiness tells the user that they are not
 *    yet cleared for real funds and why. Enforcing one of them is a
 *    one-line assertFeatureAllowed call at its entry point.
 *
 * There is deliberately NO developer override: nothing a user can toggle
 * changes a status. Sepolia test mode (Settings → Developer) is where the
 * gated features run.
 *
 * Every evidence id must exist in docs/THREAT_MODEL.md; scripts/
 * check-readiness.mjs parses the document and fails otherwise.
 */

export type ReadinessStatus = 'mainnet-ok' | 'testnet-only' | 'blocked';

export type FeatureId =
  | 'eoa-send'
  | 'tokens'
  | 'nft'
  | 'swap'
  | 'walletconnect'
  | 'dogecoin-send'
  | 'simple-account'
  | 'kernel-smart-account'
  | 'eip7702-upgrade'
  | 'session-keys'
  | 'passkeys'
  | 'guardians'
  | 'owner-rotation'
  | 'paymaster'
  | 'token-gas'
  | 'imported-key'
  | 'inheritance'
  | 'dapp-browser';

export interface FeatureReadiness {
  id: FeatureId;
  /** Short plain name for the Settings list. */
  title: string;
  status: ReadinessStatus;
  /** One or two plain sentences a user can read. */
  reason: string;
  /** docs/THREAT_MODEL.md ids (C1–C3, W1–W20, F-nn, N-nn) that support the status. */
  evidence: readonly string[];
  /**
   * True when this build refuses the feature where it is not allowed;
   * false when the status is shown in Settings only (see the file comment).
   */
  enforced: boolean;
}

/**
 * The test networks' names as one phrase, from the profiles (never a
 * hard-coded list): "A or B", "A, B or C".
 */
function testNetworkNames(conjunction: 'or' | 'and'): string {
  const names = EVM_TEST_PROFILES.map((p) => p.label);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}` : names.join('');
}

/** The sentence every refusal and every gated screen ends with. */
export const READINESS_TESTNET_HINT =
  `Turn on a test network (${testNetworkNames('or')}) in Settings → Developer to use this ` +
  'feature.';

/** Shown in Settings above the list, so the advisory entries are not misread. */
export const READINESS_INTRO =
  'What this build allows with real funds on a main network, and why. Features marked “Test ' +
  `networks only” are switched off outside the test networks (${testNetworkNames('and')}) and cannot be ` +
  'switched on. Features ' +
  'marked “Not yet cleared” still work on mainnet in this build, but the open items listed for ' +
  'them have not been closed, so use them with amounts you can afford to lose. Undoing something ' +
  'set up earlier (revoking, removing, vetoing) always stays available.';

/** Plain labels for the status chips in Settings. */
export const READINESS_STATUS_LABEL: Readonly<Record<ReadinessStatus, string>> = {
  'mainnet-ok': 'Cleared for mainnet',
  'testnet-only': 'Test networks only',
  blocked: 'Not yet cleared',
};

/**
 * The shared clause of the plain-feature reasons. The table text uses the
 * neutral wording, true for every install (biometric protection of the
 * phrase is opt-in, docs/THREAT_MODEL.md W1 "Partially met (opt-in)"); the
 * Settings section substitutes the wording that matches THIS phone's
 * storageProtection() result through readinessDisplayReason below, so a
 * user who protected the phrase is never told it is unprotected. Kept as a
 * constant so the substitution is exact.
 */
export const PLAIN_BLOCKERS =
  'biometric protection of the recovery phrase is opt-in rather than the default, and the wallet ' +
  'has not yet been tested as a real build on real phones';

/** The clause when this phone's phrase IS protected by biometrics. */
export const PLAIN_BLOCKERS_PROTECTED =
  'your recovery phrase is protected by biometrics on this phone, but that protection and the ' +
  'wallet itself have not yet been tested as a real build on real phones';

/** The clause when this phone's phrase is NOT protected by biometrics. */
export const PLAIN_BLOCKERS_UNPROTECTED =
  'your recovery phrase on this phone is not protected by biometrics (Settings → Recovery phrase ' +
  'protection can turn that on where the phone supports it), and the wallet has not yet been ' +
  'tested as a real build on real phones';

/** What Settings knows about this phone's phrase storage. */
export type PhraseProtectionState = 'protected' | 'unprotected' | 'unknown';

/** The readiness table, in the order Settings lists it. */
export const FEATURE_READINESS: readonly FeatureReadiness[] = [
  {
    id: 'eoa-send',
    title: 'Sending from your regular account',
    status: 'blocked',
    reason:
      `Sending works on mainnet in this build, but it is not yet cleared for real funds: ${PLAIN_BLOCKERS}.`,
    evidence: ['W1', 'W2', 'W3', 'W4', 'W13', 'W17', 'W18', 'W19', 'W20', 'N-01'],
    enforced: false,
  },
  {
    id: 'tokens',
    title: 'Tokens (ERC-20)',
    status: 'blocked',
    reason:
      'Token balances and sends work on mainnet in this build, but they are not yet cleared for ' +
      `real funds for the same reasons as regular sends: ${PLAIN_BLOCKERS}. The balance-change ` +
      'preview also comes from a single RPC provider with no second source to check it against.',
    evidence: ['W1', 'W2', 'W13', 'N-10'],
    enforced: false,
  },
  {
    id: 'nft',
    title: 'NFTs',
    status: 'blocked',
    reason:
      'The NFT gallery and NFT sends work on mainnet in this build, but they are not yet cleared ' +
      `for real funds for the same reasons as regular sends: ${PLAIN_BLOCKERS}.`,
    evidence: ['W1', 'W2', 'W13', 'F-47'],
    enforced: false,
  },
  {
    id: 'swap',
    title: 'Swaps',
    status: 'blocked',
    reason:
      'Swaps have never been run against a live 0x quote, and they share the regular-send items: ' +
      `${PLAIN_BLOCKERS}. Until a live quote and swap succeed, swaps are not cleared for real funds.`,
    evidence: ['W7', 'W1', 'W2', 'W13'],
    enforced: false,
  },
  {
    id: 'walletconnect',
    title: 'Connecting to apps (WalletConnect)',
    status: 'blocked',
    reason:
      'The wallet now shows whether WalletConnect’s verification service confirms which website a ' +
      'connected app really is, and it summarizes token-permit signatures (Permit and Permit2) as a ' +
      'plain spender, amount and expiry. Both are built and tested offline but have not yet been ' +
      'exercised with a live app over the WalletConnect relay, so connecting to apps is not yet ' +
      'cleared for real funds.',
    evidence: ['W12', 'W11', 'N-06', 'N-07', 'W1', 'W2'],
    enforced: false,
  },
  {
    id: 'dogecoin-send',
    title: 'Sending Dogecoin',
    status: 'blocked',
    reason:
      'The engine-built Dogecoin send path was proven with one real mainnet self-send on ' +
      '2026-10-03 (txid 2f05331b…a6fd, block 6399309). Dogecoin sending still shares the ' +
      `conditions every regular-account feature waits on: ${PLAIN_BLOCKERS}.`,
    evidence: ['W6', 'F-41', 'W1', 'W2'],
    enforced: false,
  },
  {
    id: 'imported-key',
    title: 'Imported private keys',
    status: 'blocked',
    reason:
      'Importing an Ethereum private key works on mainnet in this build, but it is not yet cleared for ' +
      `real funds: ${PLAIN_BLOCKERS}. The recovery phrase does not back up an imported key, so this ` +
      'phone’s secure storage holds its only copy unless you kept the key yourself.',
    // T-67: the key outside the HD tree (backup gap, storage, clipboard);
    // W1–W3: the storage class and its device verification it shares with
    // the phrase; W19: screen-capture and app-switcher privacy, which the
    // import screen depends on.
    evidence: ['T-67', 'W1', 'W2', 'W3', 'W19'],
    enforced: false,
  },
  {
    id: 'simple-account',
    title: 'SimpleAccount smart account',
    status: 'testnet-only',
    reason:
      'SimpleAccount is the ERC-4337 sample account. This wallet has only used it on test ' +
      'networks, it cannot sign messages for apps, and Alchemy’s bundler refused to deploy it in ' +
      'testing, so this wallet uses it only on test networks.',
    // The threat model has no checklist item of its own for SimpleAccount
    // (C1–C3 are about Kernel); W1 and W2 gate every mainnet use, and F-10 /
    // F-11 are the SimpleAccount-specific findings.
    evidence: ['F-10', 'F-11', 'W1', 'W2'],
    enforced: true,
  },
  {
    id: 'kernel-smart-account',
    title: 'Kernel smart account',
    status: 'testnet-only',
    reason:
      'The Kernel v3.3 smart account has no published audit for the deployed version, no confirmed ' +
      'bug bounty and no stated support horizon. Until those exist, this wallet uses Kernel ' +
      'accounts only on test networks.',
    evidence: ['C1', 'C2', 'C3', 'W9', 'F-40'],
    enforced: true,
  },
  {
    id: 'eip7702-upgrade',
    title: 'Upgrade this account (EIP-7702)',
    status: 'testnet-only',
    reason:
      'The upgrade hands your address to Kernel v3.3, whose EIP-7702 changes have no published ' +
      'audit, no confirmed bug bounty and no stated support horizon. Until those exist, this ' +
      'wallet offers the upgrade only on test networks.',
    evidence: ['C1', 'C2', 'C3', 'W9', 'F-25'],
    enforced: true,
  },
  {
    id: 'session-keys',
    title: 'Session keys',
    status: 'testnet-only',
    reason:
      'Session keys rely on Kernel’s permission policies and session signer, which have no ' +
      'published audit. Until an audit covers them, this wallet grants session keys only on test ' +
      'networks.',
    evidence: ['C1', 'C2', 'C3', 'W9', 'F-14'],
    enforced: true,
  },
  {
    id: 'passkeys',
    title: 'Passkey signer',
    status: 'testnet-only',
    reason:
      'The passkey validator this wallet installs (WebAuthnValidator v0.0.3) has no published ' +
      'audit, and only the app, not the contract, stops a passkey from replacing the account’s ' +
      'owner. Until both are addressed, passkeys work only on test networks.',
    evidence: ['C1', 'W9', 'F-18', 'F-19'],
    enforced: true,
  },
  {
    id: 'guardians',
    title: 'Guardians and guardian recovery',
    status: 'testnet-only',
    reason:
      'The guardian modules have no published audit, and testing found that one guardian can ' +
      'satisfy a two-of-two threshold by repeating its signature and that guardians can sign as ' +
      'the account immediately. Until this is resolved, guardians and guardian recovery work only ' +
      'on test networks.',
    evidence: ['C1', 'W9', 'W14', 'F-20', 'F-21'],
    enforced: true,
  },
  {
    id: 'owner-rotation',
    title: 'Changing a smart account’s owner',
    status: 'testnet-only',
    reason:
      'Owner changes run on the Kernel v3.3 account, which has no published audit for the ' +
      'deployed version, and afterwards the account can no longer be found from a recovery phrase ' +
      'alone. This wallet offers owner changes only on test networks.',
    evidence: ['C1', 'C2', 'C3', 'W9', 'F-37'],
    enforced: true,
  },
  {
    id: 'paymaster',
    title: 'Gas sponsorship (paymaster)',
    status: 'testnet-only',
    reason:
      'Sponsorship is used only by smart accounts, which are limited to test networks, and no ' +
      'live paymaster has been tested yet. This wallet accepts a paymaster only on test networks.',
    evidence: ['W8', 'C1'],
    enforced: true,
  },
  {
    id: 'token-gas',
    title: 'Paying the network fee in USDC',
    status: 'testnet-only',
    reason:
      'Paying the network fee in USDC runs on the Kernel v3.3 smart account and a token paymaster ' +
      '(Circle’s, or Pimlico’s where Circle has none), and none of them has a published audit for the ' +
      'deployed version. Circle can upgrade or pause its paymaster and change its price source, and ' +
      'Pimlico sets its rate and can decline any operation, so this wallet offers it only on test networks.',
    // C1–C3: the Kernel account it runs on; W8: no live paymaster cleared
    // for real funds; W9: the switchboard itself; F-58: the token
    // paymaster's trust (recorded in docs/THREAT_MODEL.md at the phase 13
    // leadership refresh; it covers Circle's paymaster, and Pimlico's
    // second source has the same no-audit and operator-control shape).
    evidence: ['C1', 'C2', 'C3', 'W8', 'W9', 'F-58'],
    enforced: true,
  },
  {
    id: 'inheritance',
    title: 'Inheritance (demonstration)',
    status: 'testnet-only',
    reason:
      'An heir can sign messages as the account, and so move its tokens through permits, from the moment ' +
      'they are added, not only after the delay, and the owner has no reliable way to notice a takeover ' +
      'attempt in time. It runs on the same unaudited guardian modules, so this wallet offers inheritance ' +
      'only on test networks, as a demonstration.',
    // C1: the unaudited Kernel and guardian modules it runs on; W9: the
    // switchboard; W14: the guardian findings; F-20 / F-21: the guardian
    // validator's behaviour and audit gap; T-68 / F-60: the inheritance
    // risks (phase 14 item 4), including the uint48 delay wrap.
    evidence: ['C1', 'W9', 'W14', 'F-20', 'F-21', 'T-68', 'F-60'],
    enforced: true,
  },
  {
    id: 'dapp-browser',
    title: 'In-app browser (Apps)',
    status: 'testnet-only',
    reason:
      'The in-app browser runs on a web-view library whose defaults the wallet has to work around, and some ' +
      'gaps (telling which frame of a page sent a request on some Android phones, a page using the camera ' +
      'without asking, downloads that carry the site’s cookies) can be closed only in a real build tested on ' +
      'real phones. Until then it opens only a short fixed list of apps, and only on test networks.',
    // W2: the development build on real phones that the native fixes need
    // (docs/DAPP_BROWSER.md section 5.5); W11 / W12: the WalletConnect
    // sheet's permit summaries and identity signal, which the browser
    // reuses; T-11 (impersonation), T-14 (EIP-7702 requests) and T-17
    // (wrong account or network): the threats the shared approval path
    // already answers. The browser's own threat entry is the CTO's to add.
    evidence: ['W2', 'W11', 'W12', 'T-11', 'T-14', 'T-17'],
    enforced: true,
  },
];

/**
 * The CAIP-2 ids this wallet treats as test networks: exactly the
 * test-network profiles in config/evm-chain.ts (EVM_TEST_PROFILES —
 * Ethereum Sepolia eip155:11155111 and, since phase 10 item 3, Base Sepolia
 * eip155:84532). A profile is listed there only with `testnet: true`
 * (scripts/check-readiness.mjs asserts both). Any other id, including an
 * unknown or malformed one and Base MAINNET eip155:8453, counts as a main
 * network, so a new chain is gated until it is added deliberately.
 */
export const TEST_NETWORK_CHAINS: readonly string[] = EVM_TEST_PROFILES.map((p) => p.caip2);

/** True only for a CAIP-2 id in TEST_NETWORK_CHAINS. */
export function isTestNetwork(caip2: string): boolean {
  return TEST_NETWORK_CHAINS.includes(caip2);
}

/** The table entry for one feature; throws for an unknown id (a programming error). */
export function featureReadiness(featureId: FeatureId): FeatureReadiness {
  const entry = FEATURE_READINESS.find((f) => f.id === featureId);
  if (!entry) throw new Error(`Unknown feature id: ${String(featureId)}`);
  return entry;
}

/**
 * True when `featureId` may be used on the given network: always on a test
 * network, and on any other network only when its status is 'mainnet-ok'.
 * `network` is a CAIP-2 id, or a boolean that is true for a test network.
 */
export function isFeatureAllowed(featureId: FeatureId, network: string | boolean): boolean {
  const entry = featureReadiness(featureId);
  const testnet = typeof network === 'boolean' ? network : isTestNetwork(network);
  return testnet || entry.status === 'mainnet-ok';
}

/**
 * The reason as Settings shows it on THIS phone (pure: the caller passes
 * what storageProtection() reported). Only the shared phrase clause
 * changes; every other word is the table's.
 */
export function readinessDisplayReason(feature: FeatureReadiness, phrase: PhraseProtectionState): string {
  if (phrase === 'unknown') return feature.reason;
  return feature.reason
    .split(PLAIN_BLOCKERS)
    .join(phrase === 'protected' ? PLAIN_BLOCKERS_PROTECTED : PLAIN_BLOCKERS_UNPROTECTED);
}

/** The reviewer-facing line with the checklist ids (collapsed by default in Settings). */
export function readinessEvidenceLine(feature: FeatureReadiness): string {
  return `Checklist and findings: ${feature.evidence.join(', ')}.`;
}

/** The plain-English reason for a feature's status. */
export function readinessReason(featureId: FeatureId): string {
  return featureReadiness(featureId).reason;
}

/** The full refusal text: the reason followed by the test-mode hint. */
export function readinessRefusal(featureId: FeatureId): string {
  return `${readinessReason(featureId)} ${READINESS_TESTNET_HINT}`;
}

/** Error thrown by assertFeatureAllowed, so callers and tests can recognise it. */
export class FeatureNotAllowedError extends Error {
  readonly featureId: FeatureId;
  constructor(featureId: FeatureId) {
    super(readinessRefusal(featureId));
    this.name = 'FeatureNotAllowedError';
    this.featureId = featureId;
  }
}

/** Throws FeatureNotAllowedError when the feature is not allowed on `network`. */
export function assertFeatureAllowed(featureId: FeatureId, network: string | boolean): void {
  if (!isFeatureAllowed(featureId, network)) throw new FeatureNotAllowedError(featureId);
}

/**
 * For screens: null when the feature is allowed on `network`, otherwise the
 * entry (title and reason) and the hint to show in the explanatory card.
 */
export function readinessGate(
  featureId: FeatureId,
  network: string | boolean,
): { feature: FeatureReadiness; hint: string } | null {
  if (isFeatureAllowed(featureId, network)) return null;
  return { feature: featureReadiness(featureId), hint: READINESS_TESTNET_HINT };
}

/** CAIP-2 id of an EIP-155 numeric chain id (for gates that hold a bigint). */
export function eip155Caip2(chainId: bigint | number): string {
  return `eip155:${BigInt(chainId).toString()}`;
}

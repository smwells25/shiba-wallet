/**
 * Auto-lock state machine (phase 4, item 5.1), pure and free of React
 * Native imports so scripts/check-devmode.mjs can exercise every
 * transition under plain Node. The App-side LockGate component feeds it
 * AppState changes and renders an overlay while `locked` is true — an
 * overlay, not a navigation reset, so all screen state survives a lock.
 *
 * THE PIN DECISION, REVISED (phase 21, docs/DURESS_WALLET.md section 7.1).
 * By default there is no in-app PIN pad: unlocking goes through
 * requireLocalAuth (wallet/biometric.ts), whose disableDeviceFallback:false
 * means the OS itself falls back to the device passcode after failed
 * biometric attempts, and on devices without biometric hardware or
 * enrollment the auto-lock setting is hidden (the OS device lock remains the
 * protection there, exactly as in the requireLocalAuth behavior matrix).
 * The original reasoning still holds — an app PIN is weaker than the
 * platform keyguard, with its own storage, rate limiting and lockout in JS —
 * so the app PIN is OPT-IN (Settings → Privacy → "Use a PIN to unlock";
 * wallet/pin.ts) and exists because a duress PIN needs a secret the app can
 * check itself: the device prompt cannot tell the app which credential
 * passed. While an app PIN is set, the lock screen takes the PIN (the
 * device prompt is not a fallback for it), auto-lock is forced on, the
 * gate works on devices without biometrics, and signing still asks for the
 * device prompt. Users who never turn it on see no change.
 *
 * Semantics:
 *  - 'inactive' and 'background' both start the away-timer (iOS reports
 *    'inactive' for the app switcher and system overlays). The FIRST such
 *    moment is kept — flapping between inactive and background must not
 *    keep resetting the clock.
 *  - On 'active', the app locks iff the away time reached the threshold.
 *    The timer is cleared either way.
 *  - A null threshold means auto-lock is off: the machine never initiates
 *    a lock and clears any pending timer.
 *  - 'unlock' (successful requireLocalAuth) clears everything.
 *  - A backwards clock (now earlier than the recorded away-moment) never
 *    locks: elapsed time is clamped at zero rather than trusted negative.
 */

export interface LockState {
  /** True while the lock overlay must cover the app. */
  locked: boolean;
  /** When the app went away (ms epoch), or null while in the foreground. */
  backgroundedAt: number | null;
}

export const INITIAL_LOCK_STATE: LockState = { locked: false, backgroundedAt: null };

/** The AppState statuses React Native reports (plus a catch-all). */
export type AppStateStatusLike =
  | 'active'
  | 'background'
  | 'inactive'
  | 'unknown'
  | 'extension';

export type LockEvent =
  | { type: 'app-state'; status: AppStateStatusLike; now: number }
  | { type: 'unlock' };

export function reduceLock(
  state: LockState,
  event: LockEvent,
  autoLockMs: number | null,
): LockState {
  if (event.type === 'unlock') {
    return { locked: false, backgroundedAt: null };
  }
  if (autoLockMs === null) {
    // Auto-lock off: never initiate a lock; drop any pending timer.
    return state.backgroundedAt === null ? state : { ...state, backgroundedAt: null };
  }
  if (event.status === 'background' || event.status === 'inactive') {
    // Keep the earliest away-moment.
    if (state.backgroundedAt !== null) return state;
    return { ...state, backgroundedAt: event.now };
  }
  if (event.status === 'active') {
    if (state.backgroundedAt === null) return state;
    const elapsed = Math.max(0, event.now - state.backgroundedAt);
    return {
      locked: state.locked || elapsed >= autoLockMs,
      backgroundedAt: null,
    };
  }
  return state;
}

/*
 * LOCK ON LAUNCH (phase 20, finding F-77(b); docs/DURESS_WALLET.md section
 * 5.2, Stage 0). The reducer above only locks on a return from the
 * background, and the lock state starts unlocked, so an app that was swiped
 * away, force-stopped or reclaimed by the system used to open again on Home
 * with no prompt whatever the auto-lock setting. The rule now is:
 *
 *   auto-lock on (any duration) → the wallet STARTS locked;
 *   auto-lock off               → it starts unlocked, exactly as before.
 *
 * The decision is taken ONCE, at the first moment the wallet's own status
 * and the stored preferences are both known. Until then a wallet that is
 * already loaded is covered by a neutral cover (no wallet data, no text
 * about the wallet), so no frame of Home is ever drawn before the decision:
 * WalletContext can reach 'ready' before or after PrefsContext has read the
 * stored auto-lock choice (two independent asynchronous reads), and showing
 * the screens while the choice is unknown would be exactly the flash this
 * rule exists to prevent. A wallet that does not exist yet ('no-wallet',
 * i.e. onboarding) has nothing to protect and is never locked at launch; a
 * wallet created later in the same session is not locked either (the user
 * is present and just made it).
 *
 * Whether the device can show the prompt (localAuthAvailable) is NOT part
 * of the launch decision: while that answer is unknown the gate fails
 * closed (it stays armed), and once the device answers "no biometrics" the
 * gate disarms and the lock lifts, as it always did — the auto-lock setting
 * is hidden on such devices and requireLocalAuth would proceed without a
 * prompt anyway (the documented matrix in wallet/biometric.ts). Showing the
 * lock screen while the answer is pending also means the Unlock button is
 * always a way out: requireLocalAuth asks the device itself.
 *
 * The unlock is unchanged: the device prompt through requireLocalAuth (the
 * no-PIN decision above), with the approval target WalletContext set for
 * the active account before it reported 'ready' (the recovery phrase, an
 * imported key, or nothing at all for a watch-only or multi-signature
 * account), never an override from here.
 */

/** Wallet status as WalletContext reports it. */
export type WalletStatusLike = 'loading' | 'no-wallet' | 'ready';

export interface LockGateInputs {
  walletStatus: WalletStatusLike;
  /** PrefsContext `ready`: the stored preferences have been read (or failed to read). */
  prefsReady: boolean;
  /** The auto-lock threshold; null = auto-lock off. Meaningful once prefsReady. */
  autoLockMs: number | null;
  /** localAuthAvailable()'s answer; null until the device has answered. */
  available: boolean | null;
}

export type LaunchLockDecision = 'pending' | 'locked' | 'unlocked';

/** The once-per-launch decision (see the rule above). */
export function launchLockDecision(inputs: LockGateInputs): LaunchLockDecision {
  if (inputs.walletStatus === 'loading') return 'pending';
  if (inputs.walletStatus !== 'ready') return 'unlocked';
  if (!inputs.prefsReady) return 'pending';
  return inputs.autoLockMs !== null ? 'locked' : 'unlocked';
}

/**
 * Whether the gate is armed: a wallet exists, auto-lock is on, and the
 * device has not said it cannot prompt (an unknown answer counts as able,
 * so the gate fails closed while the check is in flight).
 */
export function lockGateArmed(inputs: LockGateInputs): boolean {
  return inputs.walletStatus === 'ready' && inputs.autoLockMs !== null && inputs.available !== false;
}

export interface LockGateState {
  /** True once the launch decision has been taken (it is taken once). */
  launched: boolean;
  lock: LockState;
  /** True while the current lock is the launch lock (selects the lock screen's sentence). */
  startedLocked: boolean;
}

export const INITIAL_LOCK_GATE_STATE: LockGateState = {
  launched: false,
  lock: INITIAL_LOCK_STATE,
  startedLocked: false,
};

/** The state a launch with auto-lock on starts in. */
export const LAUNCH_LOCKED_STATE: LockState = { locked: true, backgroundedAt: null };

/**
 * Brings the gate state up to date with its inputs: takes the launch
 * decision the first time it is known, and drops any lock or pending timer
 * while the gate is disarmed (auto-lock turned off, the wallet wiped, or
 * the device unable to prompt). Returns the SAME object when nothing
 * changes, so LockGate can call it while rendering.
 */
export function reconcileLockGate(state: LockGateState, inputs: LockGateInputs): LockGateState {
  let next = state;
  if (!next.launched) {
    const decision = launchLockDecision(inputs);
    if (decision === 'locked') {
      next = { launched: true, lock: LAUNCH_LOCKED_STATE, startedLocked: true };
    } else if (decision === 'unlocked') {
      next = { ...next, launched: true };
    }
  }
  if (!lockGateArmed(inputs) && (next.lock.locked || next.lock.backgroundedAt !== null || next.startedLocked)) {
    next = { ...next, lock: INITIAL_LOCK_STATE, startedLocked: false };
  }
  return next;
}

/** Feeds an AppState change or a successful unlock to the gate. */
export function applyLockGateEvent(
  state: LockGateState,
  event: LockEvent,
  autoLockMs: number | null,
): LockGateState {
  const lock = reduceLock(state.lock, event, autoLockMs);
  if (event.type === 'unlock') {
    return { launched: true, lock, startedLocked: false };
  }
  return lock === state.lock ? state : { ...state, lock };
}

/**
 * What LockGate draws over the (always mounted) screens:
 *  - 'screens': nothing; the screens are visible;
 *  - 'cover':   a neutral cover while the launch decision is pending for a
 *               wallet that is already loaded (no wallet data, no Unlock);
 *  - 'lock':    the lock screen with Unlock.
 * Anything but 'screens' also hides the screens from accessibility and
 * holds WalletConnect and in-app browser approvals (useAppLock).
 */
export type LockGateView = 'screens' | 'cover' | 'lock';

export function lockGateView(state: LockGateState, inputs: LockGateInputs): LockGateView {
  if (!state.launched) return inputs.walletStatus === 'ready' ? 'cover' : 'screens';
  return lockGateArmed(inputs) && state.lock.locked ? 'lock' : 'screens';
}

/** The lock screen's sentence: why it is locked. */
export function lockScreenHint(startedLocked: boolean): string {
  return startedLocked
    ? "Auto-lock is on, so the wallet starts locked. Your keys never left the device's secure storage."
    : "The app locked itself after being in the background. Your keys never left the device's secure storage.";
}

/**
 * The wallet status LockGate feeds the functions above (its `inputs`).
 * With an app PIN set, a wallet that is still loading counts as 'ready':
 * at launch nothing is loaded until the PIN pad has decided which wallet
 * opens, and after a PIN opened the other wallet the reload happens behind
 * the lock — so the launch decision locks (auto-lock is forced on with a
 * PIN) and the lock stays up until the PIN was accepted and the wallet is
 * loaded. Without an app PIN the status is passed through unchanged.
 */
export function lockGateWalletStatus(walletStatus: WalletStatusLike, appPinOn: boolean): WalletStatusLike {
  return appPinOn && walletStatus === 'loading' ? 'ready' : walletStatus;
}

/**
 * Whether the device can show its prompt, as LockGate feeds it: with an
 * app PIN set the gate never depends on biometrics (the PIN pad works on a
 * phone without them), so the answer counts as yes.
 */
export function lockGateAvailable(deviceAnswer: boolean | null, appPinOn: boolean): boolean | null {
  return appPinOn ? true : deviceAnswer;
}

/**
 * Settings → Privacy → Auto-lock, the hint while the app PIN is on (pass
 * p21f finding 5): the lock is then the app's own PIN pad, and the device
 * prompt does not unlock the wallet (LockGate.tsx shows the PinPad instead
 * of the Unlock button); signing still asks for the device prompt. Without
 * a PIN, SettingsScreen keeps its own sentence ("…locks behind the same
 * biometric prompt as sending…"), pinned word for word in check-devmode.
 */
export const AUTO_LOCK_HINT_WITH_PIN =
  'When the app has been in the background at least this long, it locks behind the app PIN pad: it opens again only ' +
  "after you type your 6-digit PIN; the device's own fingerprint, face or passcode prompt does not unlock it while the PIN " +
  'is on (sending and signing still ask for that prompt). The wallet also starts locked every time it is opened afresh (after it was ' +
  'closed, swiped away or stopped by the system). Screen state is kept — locking never discards what you were doing.';

/** The device prompt's title for the lock screen (unchanged since phase 4). */
export const UNLOCK_PROMPT = 'Unlock Shiba Wallet';

/** The shape of wallet/biometric.ts requireLocalAuth's answer (kept structural so this file stays React-Native-free). */
export type UnlockAuthOutcome = { ok: true; gated: boolean } | { ok: false; message: string };

/**
 * The lock screen's unlock: exactly ONE call to the device check, with the
 * prompt title only — no approval-target argument, so the target is the
 * one WalletContext set for the active account (a watch-only or multisig
 * account opens nothing; see account-ids.ts approvalTargetFor). LockGate
 * passes wallet/biometric.ts requireLocalAuth; the checks pass fakes.
 */
export async function attemptUnlock(
  auth: (promptMessage: string) => Promise<UnlockAuthOutcome>,
): Promise<{ unlocked: true } | { unlocked: false; message: string }> {
  const outcome = await auth(UNLOCK_PROMPT);
  return outcome.ok ? { unlocked: true } : { unlocked: false, message: outcome.message };
}

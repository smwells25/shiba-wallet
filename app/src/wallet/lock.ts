/**
 * Auto-lock state machine (phase 4, item 5.1), pure and free of React
 * Native imports so scripts/check-devmode.mjs can exercise every
 * transition under plain Node. The App-side LockGate component feeds it
 * AppState changes and renders an overlay while `locked` is true — an
 * overlay, not a navigation reset, so all screen state survives a lock.
 *
 * DELIBERATE NO-PIN DECISION: there is no custom in-app PIN pad. Unlocking
 * goes through requireLocalAuth (wallet/biometric.ts), whose
 * disableDeviceFallback:false means the OS itself falls back to the device
 * passcode after failed biometric attempts. A homemade PIN pad would be
 * strictly weaker than that OS credential path: it would need its own
 * secret storage, its own rate limiting, and its own lockout policy, all
 * re-implemented in JS and all easier to bypass than the platform
 * keyguard. On devices without biometric hardware or enrollment the
 * auto-lock setting is hidden entirely (with an explanatory note in
 * Settings) instead of being backed by a weaker homemade gate — the OS
 * device lock remains the protection there, exactly as in the
 * requireLocalAuth behavior matrix.
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

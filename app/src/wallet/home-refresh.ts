/**
 * Home's "reload after a send" bookkeeping (phase 12, Base Sepolia finding
 * 7: Home kept showing the pre-send balance until a pull-to-refresh).
 *
 * Home stays mounted under the stack while Send, Swap, WalletConnect and
 * the other screens run, so it subscribes to the accepted-send signals
 * (send.ts addSendAcceptedListener for EOA transactions on every chain,
 * aa.ts addAaSentListener for smart-account operations) and only marks its
 * balances stale. The reload itself happens when Home regains focus, so
 * no balance request is made while the user is still on another screen.
 *
 * A node accepts a transaction before it is included, and eth_getBalance
 * at "latest" moves only at inclusion, so a reload right after focus can
 * still show the old figure. One follow-up reload is therefore scheduled
 * FOLLOW_UP_RELOAD_MS later (a judgement call: about one Ethereum slot plus
 * a margin; Base blocks are 2 seconds). Both reloads go through the
 * per-row fetch, so each row keeps its own loading / error / retry state.
 *
 * React-free so scripts/check-home.mjs exercises it with fakes.
 */

export const FOLLOW_UP_RELOAD_MS = 15_000;

export type Subscribe = (listener: () => void) => () => void;

export interface SendRefreshTracker {
  /** Subscribes to every source; returns the function that unsubscribes. */
  start(): () => void;
  /**
   * Called when Home gains focus. Returns true (and clears the mark) when a
   * send was accepted since the last time it returned true.
   */
  takeStale(): boolean;
}

export function createSendRefreshTracker(sources: Subscribe[]): SendRefreshTracker {
  let stale = false;
  const mark = () => {
    stale = true;
  };
  return {
    start() {
      const offs = sources.map((subscribe) => subscribe(mark));
      return () => {
        for (const off of offs) off();
      };
    },
    takeStale() {
      const was = stale;
      stale = false;
      return was;
    },
  };
}

/**
 * Runs `now` at once and `later` once after `delayMs` (by default the same
 * function), through the injected timer functions. Returns a cancel
 * function that clears the follow-up (Home calls it when it loses focus or
 * unmounts, so no request is made for a screen the user has left).
 */
export function reloadNowAndLater(
  now: () => void,
  later: () => void = now,
  delayMs: number = FOLLOW_UP_RELOAD_MS,
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): () => void {
  now();
  const handle = timers.set(later, delayMs);
  return () => timers.clear(handle);
}

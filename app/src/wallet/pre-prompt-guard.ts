/**
 * The busy state of a smart-account confirm while the checks that run
 * BEFORE the device prompt are under way (phase 27 item 2; pass p27-emu1
 * finding 3).
 *
 * Since e728e4e, aa.ts checkAaQuoteBeforeApproval runs a bundler estimate
 * of the operation before the device prompt (prePromptEstimates, line
 * 4696 onward), retried on an impossible answer up to aaEstimateRetriesFor
 * (8 attempts 3 s apart on Arbitrum Sepolia). Live it took 19–26 s (pass
 * p27-emu1, the Kernel's supply and withdrawal on the Lend screen), and in
 * that time the confirm showed nothing and its Approve button stayed
 * tappable: a second tap would have started a second check and, after it,
 * a second device prompt for the same quote.
 *
 * This module is React-free (loaded by the check scripts under Node): one
 * guard per screen, held for the whole approval handler (from the tap
 * until the handler returns), so two taps in one frame cannot both start
 * it — `begin` is synchronous and the second call returns false before any
 * await. While the guard is held the screen disables its Approve button;
 * while the stage is 'bundler' or 'final' it also shows the plain line and
 * announces it (components/PrePromptCheckNote.tsx).
 *
 * Stages:
 * - 'idle'    nothing is running; the button is enabled;
 * - 'bundler' the bundler's gas estimate (checkAaQuoteBeforeApproval);
 * - 'final'   the checks after it and before the device prompt (a
 *             renewal's or a registration's pre-flight, the spending
 *             limits); the device prompt then covers the screen.
 * A refusal (an Alert) is shown by the handler, which then returns, and the
 * guard goes back to 'idle' in its `finally`.
 */

import { t } from '../i18n/index.ts';

export type PrePromptStage = 'idle' | 'bundler' | 'final';

/** The `step` an approval handler receives from PrePromptGuard.run. */
export type PrePromptStep = (stage: Exclude<PrePromptStage, 'idle'>) => void;

export interface PrePromptGuard {
  /** The current stage ('idle' when no approval is running). */
  stage(): PrePromptStage;
  /** True while an approval handler holds the guard. */
  held(): boolean;
  /**
   * Runs one approval handler while holding the guard. Returns false, and
   * runs nothing, when another one is already running (a second tap).
   * The stage starts at 'bundler'; `step` moves it; it goes back to 'idle'
   * when the task settles, whether it resolved or threw (a throw is passed
   * on).
   */
  run(task: (step: (stage: Exclude<PrePromptStage, 'idle'>) => void) => Promise<void>): Promise<boolean>;
  /** For useSyncExternalStore. */
  subscribe(listener: () => void): () => void;
}

export function createPrePromptGuard(): PrePromptGuard {
  let current: PrePromptStage = 'idle';
  let holding = false;
  const listeners = new Set<() => void>();
  const set = (next: PrePromptStage) => {
    if (next === current) return;
    current = next;
    for (const l of [...listeners]) l();
  };
  return {
    stage: () => current,
    held: () => holding,
    async run(task) {
      // Synchronous test-and-set: a second tap in the same frame sees
      // `holding` already true and returns before any await.
      if (holding) return false;
      holding = true;
      set('bundler');
      try {
        await task((stage) => {
          if (holding) set(stage);
        });
      } finally {
        holding = false;
        set('idle');
      }
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The plain line shown (and announced) beside a disabled Approve button
 * while a stage runs; null when idle. The bundler check is retried on an
 * impossible answer up to 8 times 3 s apart on Arbitrum Sepolia
 * (aa.ts aaEstimateRetriesFor) and took 19–26 s live (pass p27-emu1), so
 * the line says "about half a minute" rather than a figure the live run
 * exceeded.
 */
export function prePromptStageText(stage: PrePromptStage): string | null {
  if (stage === 'bundler') return t('aa.prePrompt.bundler');
  if (stage === 'final') return t('aa.prePrompt.final');
  return null;
}

/**
 * The busy line of the off-line signing screen for a smart account (phase
 * 28 item 1), for the two places that run under its pre-prompt guard
 * (screens/ColdSignScreen.tsx). No device prompt follows on that screen, so
 * the confirm's line ("…before asking you to approve…") would be untrue
 * there; each of these says what the code there does instead:
 * - 'show' (onAaShow): the spending limits, then wallet/cold-aa.ts
 *   prepareColdAaRequest — checkAaQuoteBeforeApproval (the bundler's fee
 *   floor and its gas estimate) and the engine's
 *   prepareUserOperationForExternalSigner (the operation built and
 *   estimated again, no signature) — before the request is shown; the phone
 *   signs nothing and sends nothing there.
 * - 'submit' (onAaSubmit): wallet/cold-aa.ts submitColdAa — the signature
 *   checked against the stored request, the account's nonce and deployment
 *   read (the engine's submitPreparedUserOperation), the bundler's fee floor
 *   (beforeSign), then eth_sendUserOperation; the phone signs nothing there
 *   (the signature came from the off-line signer). The line stays while the
 *   operation is handed over, so it never says "nothing has been sent".
 * Null while idle. The two estimates of 'show' each follow the retry policy
 * (up to 8 asks 3 s apart on Arbitrum Sepolia, aa.ts aaEstimateRetriesFor),
 * hence "about a minute" rather than the confirm's half minute.
 */
export function coldSignCheckText(stage: PrePromptStage, kind: 'show' | 'submit'): string | null {
  if (stage === 'idle') return null;
  return kind === 'show' ? t('coldSign.prePrompt.show') : t('coldSign.prePrompt.submit');
}

/**
 * The one spoken path for the busy line (pass p27-emu2 finding 2: TalkBack
 * announced the "Checking the bundler's gas estimate…" line twice per
 * check). Returns a function the note calls with the line it currently
 * shows (prePromptStageText; null while idle): it calls `announce` once per
 * distinct sentence, never again for the same sentence while it stays on
 * screen (a re-render, a language re-render with the same text), and
 * forgets the sentence when the line goes away, so the next check is
 * announced again. A stage change to another sentence ('bundler' →
 * 'final') is a distinct sentence and is announced once.
 *
 * Why an explicit announcement and no live region on Android: until this
 * fix the line sat in an Android polite live region
 * (accessibilityLiveRegion, RN 0.86.3 BaseViewManager.java 532–540 maps it to
 * ViewCompat.setAccessibilityLiveRegion and nothing else), and whatever
 * content-change events the framework sent for that region's subtree — the
 * row inserted with its label, the wrapper leaving its zero-size idle style,
 * the ActivityIndicator's ProgressBar (RN's ProgressBarContainerView adds it
 * as a child view) — were each TalkBack's to speak. How many events Android
 * sends there, and how TalkBack merges them, is framework and TalkBack code
 * not on this machine, so the exact second event is NOT established. An
 * announcement is one TYPE_ANNOUNCEMENT event per call by construction (RN
 * 0.86.3 AccessibilityInfo.js 474–480 → AccessibilityInfoModule.kt 282–292
 * builds and sends exactly one event, only while a service is on), so the
 * count is decided here, in code the checks can run.
 */
export function createPrePromptAnnouncer(announce: (sentence: string) => void): (shown: string | null) => void {
  let last: string | null = null;
  return (shown) => {
    if (shown === null) {
      last = null;
      return;
    }
    if (shown === last) return;
    last = shown;
    announce(shown);
  };
}

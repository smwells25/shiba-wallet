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

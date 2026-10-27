import { t } from '../i18n/index.ts';

/**
 * A period in words for the sentences the WALLET builds through the string
 * table ("2 minutes", "1 day"; in Spanish "2 minutos", "1 día"), phase 23
 * item 8, the hygiene slice.
 *
 * The engine's describePeriod (packages/chains-evm/src/kernel-subscription.ts
 * lines 514–520) stays English by rule: describeSubscription and describeDca
 * use it, and so do the one-line summaries the wallet keeps with its records
 * (recurringSummary, dcaSummary, subscriptionSummary), which check-i18n
 * requires to be built without the accessor. Before this slice the review,
 * short-window and final-terms sentences passed the engine's English period
 * into a Spanish sentence ("cada 2 minutes"); they now use this function.
 *
 * The rule is the engine's, word for word: a whole number of days, else of
 * hours, else of minutes, else seconds; the singular only for exactly 1. In
 * English the result equals describePeriod for every input (check-i18n pins
 * it over every period the forms offer and more).
 */
export function periodText(seconds: number): string {
  if (seconds % 86400 === 0) {
    const count = seconds / 86400;
    return count === 1 ? t('period.day', { count }) : t('period.days', { count });
  }
  if (seconds % 3600 === 0) {
    const count = seconds / 3600;
    return count === 1 ? t('period.hour', { count }) : t('period.hours', { count });
  }
  if (seconds % 60 === 0) {
    const count = seconds / 60;
    return count === 1 ? t('period.minute', { count }) : t('period.minutes', { count });
  }
  return seconds === 1 ? t('period.second', { count: seconds }) : t('period.seconds', { count: seconds });
}

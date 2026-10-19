/**
 * Locale-aware DISPLAY formatting (phase 22 item 6). The exact-amount rules
 * are untouched: no amount, wei figure, base-unit string or fee is ever
 * passed through Intl, rounded or re-grouped here.
 *
 * What follows the language:
 *  - the Activity row's time ("5 min ago", "3 h ago", "1 Oct 2026",
 *    "pending", "block N"): in English EXACTLY wallet/history.ts
 *    timestampLabel (this function calls it); in Spanish the same rule with
 *    the Spanish words, and the calendar date from Intl.DateTimeFormat
 *    ('es', day numeric, month short, year numeric) when the engine has
 *    Intl, else a fixed Spanish month table.
 *
 * What does NOT (a decision, stated in Settings → Language): the decimal
 * separator of amounts. Every amount keeps "." in every language, because
 * the wallet's amount fields, payment requests and pasted amounts accept
 * only "." (parseUnits), and a comma display beside a point-only input is a
 * classic source of 1,000× misreadings. decimalSeparatorsFor() below reads
 * the locale's separators (Intl.NumberFormat formatToParts), so a later
 * slice can apply them together with a parser that accepts them.
 *
 * HERMES INTL (react-native 0.86.3, read from the installed sources and the
 * prebuilt library): Hermes is built with Intl on Android
 * (ReactAndroid/hermes-engine/build.gradle.kts:356–358) and Apple
 * (sdks/hermes-engine/utils/build-apple-framework.sh:103); the prebuilt
 * hermes-android 250829098.0.17 AAR carries com/facebook/hermes/intl/
 * Collator, DateTimeFormat, NumberFormat (with ICU- and Android-backed
 * formatters), and libhermesvm.so names formatToParts, resolvedOptions,
 * supportedLocalesOf and getCanonicalLocales but not PluralRules,
 * RelativeTimeFormat, ListFormat, DisplayNames or Segmenter, so none of
 * those is used. The exact strings a phone's ICU produces for Spanish
 * (for example "1 oct 2026" vs "1 oct. 2026") depend on its ICU / CLDR
 * data and were not checked on a device; Node 24 (ICU 78.3) gives
 * "1 oct 2026". Every Intl call is guarded: a missing or throwing Intl
 * falls back to the fixed table.
 */
import { timestampLabel } from '../wallet/history.ts';
import { activeLanguage, localeTagFor, translateIn, type Language } from './index.ts';

const ES_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

function intlDate(date: Date, language: Language): string | null {
  try {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return null;
    const text = new Intl.DateTimeFormat(localeTagFor(language), { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
    return typeof text === 'string' && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** The Activity row's time in the active language (English: history.ts timestampLabel, unchanged). */
export function localTimestampLabel(
  entry: { timestamp: number | null; confirmed: boolean; blockHeight?: number },
  nowMs: number = Date.now(),
  language: Language = activeLanguage(),
  useIntl = true,
): string {
  if (language === 'en') return timestampLabel(entry, nowMs);
  if (entry.timestamp === null && entry.confirmed && entry.blockHeight !== undefined) {
    return translateIn(language, 'activity.time.block', { block: entry.blockHeight });
  }
  if (entry.timestamp === null) return translateIn(language, 'activity.chip.pending');
  const seconds = Math.floor(nowMs / 1000) - entry.timestamp;
  if (seconds < 60) return translateIn(language, 'activity.time.justNow');
  if (seconds < 3600) return translateIn(language, 'activity.time.minAgo', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return translateIn(language, 'activity.time.hoursAgo', { count: Math.floor(seconds / 3600) });
  const date = new Date(entry.timestamp * 1000);
  return (useIntl ? intlDate(date, language) : null) ?? `${date.getDate()} ${ES_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** The locale's decimal and grouping separators (for a later slice; amounts do not use them yet). */
export function decimalSeparatorsFor(language: Language): { decimal: string; group: string } {
  const fallback = language === 'es' ? { decimal: ',', group: '.' } : { decimal: '.', group: ',' };
  try {
    if (typeof Intl === 'undefined' || typeof Intl.NumberFormat !== 'function') return fallback;
    const parts = new Intl.NumberFormat(localeTagFor(language)).formatToParts(12345.6);
    const decimal = parts.find((p) => p.type === 'decimal')?.value;
    const group = parts.find((p) => p.type === 'group')?.value;
    return decimal && group ? { decimal, group } : fallback;
  } catch {
    return fallback;
  }
}

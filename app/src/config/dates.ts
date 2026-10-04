/**
 * Display dates (phase 12 Base Sepolia finding 6). Timestamps are stored as
 * UTC ISO strings (for example "2026-10-04T01:12:00.000Z") or milliseconds,
 * and stay that way; only what the user reads changes. The "checked …",
 * "protected … (since …)" and "Backed up …" lines used to print the UTC day
 * (the first ten characters of the ISO string), so a check made in the
 * evening in the Americas read as the next day. They now print the
 * device's local calendar day, in the same YYYY-MM-DD form.
 *
 * The local getters of Date are used rather than Intl or toLocaleDateString,
 * whose support on Hermes is limited (the same reason balances.ts formats
 * numbers by hand).
 */

/** The local calendar day of `value` as YYYY-MM-DD, or "unknown date". */
export function localDateLabel(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'unknown date';
  const date = new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return 'unknown date';
  const year = date.getFullYear().toString().padStart(4, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Display-name sanitization shared by every user-chosen label in the app
 * (contact names in ./contacts.ts, account names in ./accounts.ts). Pure
 * TypeScript with no imports, so the check scripts load it under Node's
 * type stripping.
 *
 * Characters removed:
 *  - C0/C1 control characters (U+0000–U+001F, U+007F–U+009F);
 *  - bidirectional formatting characters that can reorder or disguise the
 *    surrounding text: LRM/RLM (U+200E, U+200F), ALM (U+061C), the
 *    embeddings/overrides U+202A–U+202E, and the isolates U+2066–U+2069;
 *  - invisible characters that make two names look identical while being
 *    different strings: zero-width space U+200B, word joiner U+2060, and
 *    the byte-order mark U+FEFF. Zero-width (non-)joiners U+200C/U+200D
 *    are kept because emoji sequences and several scripts require them.
 */
export const STRIPPED_NAME_CHARS =
  /[\u0000-\u001F\u007F-\u009F؜​‎‏‪-‮⁠⁦-⁩﻿]/g;

export type NameValidation = { ok: true; name: string } | { ok: false; error: string };

/**
 * Sanitizes a display name: NFC-normalizes, strips the characters above,
 * collapses every whitespace run (including line/paragraph separators and
 * no-break spaces) to one space, trims, and enforces 1..maxLength Unicode
 * code points. `noun` names the thing being labeled in the error messages
 * ("contact", "account").
 */
export function sanitizeDisplayName(raw: string, maxLength: number, noun: string): NameValidation {
  const cleaned = raw
    .normalize('NFC')
    .replace(STRIPPED_NAME_CHARS, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const length = Array.from(cleaned).length;
  if (length === 0) return { ok: false, error: `Enter a name for this ${noun}.` };
  if (length > maxLength) {
    const label = noun.charAt(0).toUpperCase() + noun.slice(1);
    return {
      ok: false,
      error: `${label} names can be at most ${maxLength} characters (this one is ${length}).`,
    };
  }
  return { ok: true, name: cleaned };
}

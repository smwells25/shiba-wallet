/**
 * The user's language choice (Settings → Language), stored DEVICE-WIDE
 * through the storage seam (../wallet/store-keys.ts STORE_KEYS.language,
 * scope 'device'): one choice for the phone, shared by every wallet profile.
 * That matters for the duress wallet: a second wallet that opened in another
 * language than the first would give itself away (docs/DURESS_WALLET.md
 * section 6.5 "the same words whichever wallet the PIN would open").
 *
 * Format: {"v":1,"language":"system"|"en"|"es"}. A missing record means
 * 'system'; anything else that does not parse exactly also reads as
 * 'system' (a language preference is not worth a read-only state: the
 * worst case is the device's language, which is what a fresh install shows).
 *
 * Pure apart from the injected store, so scripts/check-i18n.mjs drives it
 * over an in-memory store.
 */
import { readStoreItem, STORE_KEYS, writeStoreItem, type KeyValueStore } from '../wallet/store-keys.ts';
import { LANGUAGE_CHOICES, type LanguageChoice } from './index.ts';

export const LANGUAGE_STORE_KEY = STORE_KEYS.language.name;

export function parseLanguageChoice(raw: string | null): LanguageChoice {
  if (raw === null) return 'system';
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'system';
    const keys = Object.keys(value).sort().join(',');
    const record = value as { v?: unknown; language?: unknown };
    if (keys !== 'language,v' || record.v !== 1) return 'system';
    return LANGUAGE_CHOICES.includes(record.language as LanguageChoice) ? (record.language as LanguageChoice) : 'system';
  } catch {
    return 'system';
  }
}

export function serializeLanguageChoice(choice: LanguageChoice): string {
  if (!LANGUAGE_CHOICES.includes(choice)) throw new Error(`Unknown language choice: ${String(choice)}`);
  return JSON.stringify({ v: 1, language: choice });
}

/** The stored choice ('system' when none is stored or the store cannot be read). */
export async function loadLanguageChoice(store: KeyValueStore): Promise<LanguageChoice> {
  try {
    return parseLanguageChoice(await readStoreItem(store, LANGUAGE_STORE_KEY));
  } catch {
    return 'system';
  }
}

/** Persists the choice; the write's own error is passed on (the caller keeps the old choice). */
export function saveLanguageChoice(store: KeyValueStore, choice: LanguageChoice): Promise<void> {
  return writeStoreItem(store, LANGUAGE_STORE_KEY, serializeLanguageChoice(choice));
}

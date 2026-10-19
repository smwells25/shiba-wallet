/**
 * Localisation groundwork (phase 22 item 6, feature 91): the app's ONE
 * string accessor.
 *
 * The tables:
 *  - ./en.ts is the source of truth: every migrated user-facing string,
 *    keyed by a stable id, holding EXACTLY the English text the screens
 *    showed before (scripts/check-i18n.mjs proves the byte identity).
 *  - ./es.ts is the second language (Spanish), a first draft for the same
 *    ids. A missing id falls back to English, never to the id.
 *
 * The accessor:
 *  - t(id, params) — typed ids, plain `{name}` placeholders (no ICU, no
 *    plural engine, no dependency). A placeholder with no value is left as
 *    written, so a missing parameter is visible instead of silently empty.
 *  - tx(text) — the same lookup reached from the English text itself, for
 *    the call sites whose literal the check scripts pin (JSX text, a
 *    constant exported by a wallet module). Its parameter is typed as the
 *    union of the placeholder-free English entries, so TypeScript refuses
 *    any literal that is not byte-identical to a table entry.
 *  - localize(text) — the untyped form of tx for the shared components that
 *    receive their text from callers (Button titles, WarningBox sentences,
 *    the readiness card): a string equal to an English entry is translated,
 *    any other string (an amount, an address, a name the user typed, a
 *    sentence not migrated yet) is returned unchanged.
 *
 * The active language is module state: 'en' until the app applies the
 * user's choice (Settings → Language, stored device-wide through the
 * storage seam, ./language-store.ts) or the device's language (./device-locale.ts).
 * Node's check scripts never set it, so every wallet module that builds a
 * sentence through t() still returns its English text there. Components
 * subscribe through ./useI18n.ts, so a change re-renders them.
 *
 * Pure: no React, no react-native import, so it loads under Node's type
 * stripping like the wallet modules.
 */
import { en } from './en.ts';
import { es } from './es.ts';

export type Language = 'en' | 'es';
/** What the user chose in Settings → Language ('system' follows the device). */
export type LanguageChoice = 'system' | Language;

export const LANGUAGES: readonly Language[] = ['en', 'es'];
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = ['system', 'en', 'es'];

export type StringId = keyof typeof en;
type EnglishOf<K extends StringId> = (typeof en)[K];
/** Entries without a `{placeholder}`: the only ones tx() can be called with. */
export type EnglishText = {
  [K in StringId]: EnglishOf<K> extends `${string}{${string}}${string}` ? never : EnglishOf<K>;
}[StringId];

export type Params = Readonly<Record<string, string | number>>;

export type Tables = Readonly<Record<Language, Readonly<Partial<Record<StringId, string>>>>>;

const TABLES: Tables = { en, es };

/** The `{name}` placeholders of a template, in order of first appearance. */
export function placeholdersOf(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Fills `{name}` placeholders; an unknown or missing name is left as written. */
export function fill(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/** The text of `id` in `language` from `tables`, falling back to the English table for a missing entry. */
export function translateFrom(tables: Tables, language: Language, id: StringId, params?: Params): string {
  const own = tables[language][id];
  return fill(typeof own === 'string' ? own : (tables.en[id] ?? en[id]), params);
}

/** The text of `id` in `language`, falling back to English for a missing entry. */
export function translateIn(language: Language, id: StringId, params?: Params): string {
  return translateFrom(TABLES, language, id, params);
}

// English text → id, for tx() and localize(). Built from the placeholder-free
// entries only; check-i18n requires these to be unique, so the map is exact.
const BY_ENGLISH: ReadonlyMap<string, StringId> = new Map(
  (Object.keys(en) as StringId[])
    .filter((id) => placeholdersOf(en[id]).length === 0)
    .map((id) => [en[id] as string, id] as const),
);

/** The id whose English text is exactly `text`, or null. */
export function idOfEnglish(text: string): StringId | null {
  return BY_ENGLISH.get(text) ?? null;
}

// A link or chip label's decoration: a leading "✓ " (a chosen chip) or a
// trailing " ↗" / " ✓" (a link that opens a screen, a done state). The text
// between is looked up; the decoration is kept as it was.
const DECORATED = /^(✓\s+)?(.*?)(\s+[↗✓])?$/s;

/**
 * `text` translated into `language` when it is exactly an English entry, or
 * a decorated label ("✓ 1 min", "Send ↗", "Passkey ✓") whose undecorated
 * text is one; otherwise `text` unchanged.
 */
export function localizeIn(language: Language, text: string): string {
  if (language === 'en') return text;
  const id = BY_ENGLISH.get(text);
  if (id !== undefined) return translateIn(language, id);
  const m = DECORATED.exec(text);
  if (!m || (!m[1] && !m[3])) return text;
  const core = BY_ENGLISH.get(m[2]);
  return core === undefined ? text : `${m[1] ?? ''}${translateIn(language, core)}${m[3] ?? ''}`;
}

// ---------------------------------------------------------------------------
// The active language (module state)
// ---------------------------------------------------------------------------

let active: Language = 'en';
const listeners = new Set<() => void>();

export function activeLanguage(): Language {
  return active;
}

/** Sets the language every t() / tx() / localize() call uses; notifies subscribers on a change. */
export function setActiveLanguage(language: Language): void {
  if (!LANGUAGES.includes(language) || language === active) return;
  active = language;
  for (const listener of [...listeners]) listener();
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The ONE accessor: the text of `id` in the active language. */
export function t(id: StringId, params?: Params): string {
  return translateIn(active, id, params);
}

/** t() reached from a pinned English literal (typed: only an exact table entry compiles). */
export function tx(text: EnglishText): string {
  return localizeIn(active, text);
}

/** For shared components that receive caller text: translated when it is an English entry, else unchanged. */
export function localize(text: string): string {
  return localizeIn(active, text);
}

// ---------------------------------------------------------------------------
// The language a choice resolves to
// ---------------------------------------------------------------------------

/**
 * The app language for a device locale tag ("es_ES" on Android's
 * I18nManager, "es-419" from Intl, "es"): Spanish for any Spanish tag,
 * English for everything else (the only two languages so far).
 */
export function languageForLocaleTag(tag: string | null | undefined): Language {
  if (typeof tag !== 'string') return 'en';
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return primary === 'es' ? 'es' : 'en';
}

export function resolveLanguage(choice: LanguageChoice, deviceTag: string | null | undefined): Language {
  return choice === 'system' ? languageForLocaleTag(deviceTag) : choice;
}

/** The BCP 47 tag a language formats dates with (Intl). */
export function localeTagFor(language: Language): string {
  return language === 'es' ? 'es' : 'en';
}

/**
 * React side of the accessor (./index.ts): a component that renders
 * translated text calls useI18n(), which subscribes it to the active
 * language (useSyncExternalStore), so a change in Settings → Language
 * re-renders it at once. The returned functions are the module's own;
 * `language` changes with every switch, so a useMemo / useCallback that
 * builds text can list it as a dependency.
 *
 * The React Compiler is NOT enabled for this app (app.json has no
 * experiments.reactCompiler; @expo/cli 57 ManifestMiddleware.js:146 and
 * metroOptions.js:120 turn it on only from that flag), so a re-render
 * re-evaluates every t() call in the component; were it enabled, the
 * `language` value would be the reactive input that invalidates memoised
 * text.
 */
import { useSyncExternalStore } from 'react';
import { activeLanguage, localize, subscribeLanguage, t, tx, type Language } from './index.ts';

export function useI18n(): { language: Language; t: typeof t; tx: typeof tx; localize: typeof localize } {
  const language = useSyncExternalStore(subscribeLanguage, activeLanguage, activeLanguage);
  return { language, t, tx, localize };
}

/**
 * The app's language controller: applies the stored choice (Settings →
 * Language) or, for 'system' and before the choice is read, the device's
 * language. Testable with an injected store and device tag
 * (createLanguageController); the app uses one instance (appLanguage()).
 *
 * Order at launch: the device's language is applied synchronously the first
 * time the controller is started (before the first screen renders), then the
 * stored choice is read; a stored English or Spanish replaces it within the
 * same launch (an AsyncStorage read — no network).
 */
import { lazyAppStore, type KeyValueStore } from '../wallet/store-keys.ts';
import { resolveLanguage, setActiveLanguage, type Language, type LanguageChoice } from './index.ts';
import { deviceLocaleTag } from './device-locale.ts';
import { loadLanguageChoice, saveLanguageChoice } from './language-store.ts';

export interface LanguageController {
  /** Applies the device language at once, then the stored choice. */
  start(): Promise<void>;
  /** The current choice ('system' until the stored one is read). */
  choice(): LanguageChoice;
  /** The language in use. */
  language(): Language;
  /** Saves the choice first, then applies it; a failed write changes nothing and throws. */
  choose(choice: LanguageChoice): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function createLanguageController(deps: {
  store: KeyValueStore;
  deviceTag: () => string | null;
  apply?: (language: Language) => void;
}): LanguageController {
  const apply = deps.apply ?? setActiveLanguage;
  let current: LanguageChoice = 'system';
  let inUse: Language = resolveLanguage('system', null);
  let started: Promise<void> | null = null;
  // A choice made before the stored one was read wins over the late read.
  let chosenThisLaunch = false;
  const listeners = new Set<() => void>();
  const set = (choice: LanguageChoice) => {
    current = choice;
    inUse = resolveLanguage(choice, deps.deviceTag());
    apply(inUse);
    for (const listener of [...listeners]) listener();
  };
  return {
    start() {
      if (!started) {
        set('system');
        started = loadLanguageChoice(deps.store).then((stored) => {
          if (!chosenThisLaunch) set(stored);
        });
      }
      return started;
    },
    choice: () => current,
    language: () => inUse,
    async choose(choice) {
      await saveLanguageChoice(deps.store, choice);
      chosenThisLaunch = true;
      set(choice);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let appInstance: LanguageController | null = null;

/** The app's controller (the AsyncStorage store, the device tag from ./device-locale.ts). */
export function appLanguage(): LanguageController {
  if (!appInstance) {
    appInstance = createLanguageController({
      store: lazyAppStore(),
      deviceTag: deviceLocaleTag,
    });
  }
  return appInstance;
}

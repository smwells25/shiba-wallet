/**
 * The device's language, read without any new dependency (expo-localization
 * is not installed: `npm ls expo-localization` in app/ is empty).
 *
 *  1. React Native's I18nManager constants. On Android, react-native 0.86.3
 *     ReactAndroid/src/main/java/com/facebook/react/modules/i18nmanager/
 *     I18nManagerModule.kt:20–29 exports "localeIdentifier" =
 *     ConfigurationCompat.getLocales(configuration)[0].toString() (for
 *     example "es_ES"). On iOS, React/CoreModules/RCTI18nManager.mm:49–55
 *     exports only isRTL and doLeftAndRightSwapInRTL, so the value is absent
 *     there. Libraries/ReactNative/I18nManager.js reads the constants ONCE,
 *     when the module loads, so a language changed in the phone's settings
 *     while the app runs is seen at the next launch.
 *  2. iOS only: the first entry of "AppleLanguages" in the app's user
 *     defaults, read through React Native's Settings module. Phase 24 item 4
 *     (finding 1): with the iOS Simulator set to Spanish the app read
 *     English under "System". The cause, from the sources:
 *       - Hermes's Intl default locale on Apple is
 *         [[NSLocale currentLocale] localeIdentifier] (facebook/hermes tag
 *         hermes-v250829098.0.17 — the version in react-native 0.86.3
 *         sdks/hermes-engine/version.properties, HERMES_V1_VERSION_NAME —
 *         lib/Platform/Intl/PlatformIntlApple.mm 58–64; the prebuilt
 *         simulator framework the Podfile installs carries the selectors
 *         currentLocale and localeIdentifier and not preferredLanguages);
 *       - Apple documents NSLocale.current (read 2026-11-07) as based on
 *         "the availability of the preferred locale in the app. For example,
 *         if the person using an app has set their device to use a
 *         Spanish-language locale, but the app only supports English, this
 *         value returns an English locale." The wallet's bundle declares only
 *         English (CFBundleDevelopmentRegion en, no .lproj, no
 *         CFBundleLocalizations — the phase 24 iOS pass), so Intl reports
 *         English whatever the phone's language.
 *     React Native's Settings module on iOS (Libraries/Settings/
 *     Settings.ios.js 21–28; RCTSettingsManager.mm 35–38 and 58–62) exports
 *     [[NSUserDefaults standardUserDefaults] dictionaryRepresentation], which
 *     Apple documents as "a dictionary with the union of all key-value pairs
 *     found from all domains", and the global domain "contains the current
 *     language settings for the device" (UserDefaults.globalDomain, read
 *     2026-11-07). The key name "AppleLanguages" is not named on those
 *     pages: it is the key the phase 24 iOS pass wrote to make the
 *     Simulator Spanish (and the key `defaults read -g AppleLanguages` shows
 *     on this Mac). On Android, Settings is SettingsFallback.js, whose get()
 *     only warns and returns null, so it is never asked there.
 *  3. Otherwise the JavaScript engine's own default locale,
 *     Intl.DateTimeFormat().resolvedOptions().locale. Hermes is built with
 *     Intl on both platforms (react-native 0.86.3
 *     ReactAndroid/hermes-engine/build.gradle.kts:356–358
 *     "-DHERMES_ENABLE_INTL=True"; sdks/hermes-engine/utils/
 *     build-apple-framework.sh:103 "-DHERMES_ENABLE_INTL:BOOLEAN=true").
 *  4. Otherwise null (the app then shows English).
 *
 * react-native is required lazily (never a namespace import: reading every
 * deprecated getter of the package raises LogBox warnings, the rule of
 * commit 783032a), so this file is only ever evaluated by the app; the
 * choice itself is pickDeviceLocaleTag, loaded by scripts/check-i18n.mjs.
 */

/** What the device reports, each value as read (anything may be missing or malformed). */
export interface DeviceLocaleSources {
  /** Platform.OS. */
  platform: string;
  /** I18nManager.getConstants().localeIdentifier (Android). */
  nativeLocaleIdentifier: unknown;
  /** Settings.get('AppleLanguages') (iOS): the preferred languages, first first. */
  appleLanguages: unknown;
  /** Intl.DateTimeFormat().resolvedOptions().locale. */
  intlLocale: unknown;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** The device's language tag from what it reports, in the order above; null when none is usable. */
export function pickDeviceLocaleTag(sources: DeviceLocaleSources): string | null {
  if (nonEmpty(sources.nativeLocaleIdentifier)) return sources.nativeLocaleIdentifier;
  if (sources.platform === 'ios' && Array.isArray(sources.appleLanguages) && nonEmpty(sources.appleLanguages[0])) {
    return sources.appleLanguages[0];
  }
  if (nonEmpty(sources.intlLocale)) return sources.intlLocale;
  return null;
}

export function deviceLocaleTag(): string | null {
  const sources: DeviceLocaleSources = { platform: '', nativeLocaleIdentifier: null, appleLanguages: null, intlLocale: null };
  let rn: typeof import('react-native') | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, see above
    rn = require('react-native') as typeof import('react-native');
  } catch {
    rn = null;
  }
  try {
    if (rn) sources.platform = rn.Platform.OS;
  } catch {
    // unknown platform: the iOS source is not asked
  }
  try {
    if (rn) sources.nativeLocaleIdentifier = rn.I18nManager.getConstants().localeIdentifier;
  } catch {
    // fall through
  }
  try {
    // Only on iOS: on Android the Settings getter loads SettingsFallback, which warns.
    if (rn && sources.platform === 'ios') sources.appleLanguages = rn.Settings.get('AppleLanguages');
  } catch {
    // fall through to Intl
  }
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
      sources.intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    }
  } catch {
    // no Intl
  }
  return pickDeviceLocaleTag(sources);
}

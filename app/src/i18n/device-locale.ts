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
 *  2. Otherwise the JavaScript engine's own default locale,
 *     Intl.DateTimeFormat().resolvedOptions().locale. Hermes is built with
 *     Intl on both platforms (react-native 0.86.3
 *     ReactAndroid/hermes-engine/build.gradle.kts:356–358
 *     "-DHERMES_ENABLE_INTL=True"; sdks/hermes-engine/utils/
 *     build-apple-framework.sh:103 "-DHERMES_ENABLE_INTL:BOOLEAN=true"), and
 *     the prebuilt Android library (hermes-android 250829098.0.17) carries
 *     com/facebook/hermes/intl/DateTimeFormat, NumberFormat, Collator and
 *     resolvedOptions. Which locale iOS Hermes reports was not checked on a
 *     device.
 *  3. Otherwise null (the app then shows English).
 *
 * react-native is required lazily (never a namespace import: reading every
 * deprecated getter of the package raises LogBox warnings, the rule of
 * commit 783032a), so this file is only ever evaluated by the app.
 */
export function deviceLocaleTag(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, see above
    const { I18nManager } = require('react-native') as typeof import('react-native');
    const fromNative = I18nManager.getConstants().localeIdentifier;
    if (typeof fromNative === 'string' && fromNative.length > 0) return fromNative;
  } catch {
    // fall through to Intl
  }
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
      const tag = Intl.DateTimeFormat().resolvedOptions().locale;
      if (typeof tag === 'string' && tag.length > 0) return tag;
    }
  } catch {
    // no Intl
  }
  return null;
}

/**
 * The Android navigation bar's button style, kept in step with the app's
 * colour scheme (phase 23 item 2; pass p20c finding 15, the white strip
 * under the TESTNET banner in dark mode).
 *
 * WHY IT IS NEEDED. React Native makes the app edge to edge and sets the
 * navigation bar's appearance once, when the window is created, from the
 * colour scheme at that moment: the bar itself is transparent and, with
 * `enforceNavigationBarContrast` on (its default), the light or dark
 * appearance is chosen from dark mode (react-native 0.86.3
 * ReactAndroid/src/main/java/com/facebook/react/views/view/WindowUtil.kt,
 * enableEdgeToEdge, lines 164-190: navigationBarColor = TRANSPARENT, then
 * isAppearanceLightNavigationBars = !isDarkMode). A scheme change while the
 * app runs does not repeat that, so something must set it again.
 *
 * WHY expo-navigation-bar 57.0.3 ALONE DOES NOT DO IT (the cause, established
 * in pass p23-navbar from bytecode, framework source and the device).
 *  1. Its setStyle (android/src/main/java/expo/modules/navigationbar/
 *     NavigationBarModule.kt lines 126-133) calls
 *     `WindowInsetsControllerCompat(this, decorView)` with a Window (lines
 *     50-52). The build resolves only androidx.core 1.18.0, whose
 *     constructor picks Impl30 on API 30-34, and Impl30.setAppearanceLight
 *     writes ONLY the deprecated View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
 *     flag whenever its window field is set (javap of the AAR's classes.jar,
 *     bytecode offsets 0-24; it reaches WindowInsetsController
 *     .setSystemBarsAppearance, offsets 27-56, only without a window).
 *  2. React Native's StatusBar sets the status-bar appearance through the
 *     platform WindowInsetsController.setSystemBarsAppearance on API 31 and
 *     up (WindowUtil.kt setStatusBarStyle, lines 99-113, `SDK_INT > R`).
 *  3. The Android 14 framework sets PRIVATE_FLAG_APPEARANCE_CONTROLLED on a
 *     window when setSystemBarsAppearance is called
 *     (ViewRootInsetsControllerHost.java line 176) and derives the window's
 *     appearance from the deprecated view flags only while that flag is NOT
 *     set (ViewRootImpl.java lines 2609-2619, adjustLayoutParamsForCompatibility;
 *     read from the android14-release branch head, not the exact build of
 *     the emulator image).
 *  On the emulator (API 34), `dumpsys window windows` showed setStyle change
 *  the deprecated flag (vsysui) after every scheme switch while the
 *  appearance the system uses (apr) kept its window-creation navigation-bar
 *  bit, with APPEARANCE_CONTROLLED set from the first StatusBar call on.
 *  Nothing overwrites the flag: it is ignored.
 *
 * THE FIX: the wallet's own local Expo module "ShibaNavigationBar"
 * (app/modules/shiba-navigation-bar, linked by Expo autolinking from the
 * app's modules folder) exposes setNavigationBarAppearance(light). On API 31
 * and up it calls `window.insetsController.setSystemBarsAppearance(light ?
 * APPEARANCE_LIGHT_NAVIGATION_BARS : 0, APPEARANCE_LIGHT_NAVIGATION_BARS)`
 * on the main thread, the same mechanism React Native's status bar uses
 * there; on API 26-30 it writes the deprecated flag, as React Native's
 * status bar also does there, so the window never mixes the two mechanisms
 * (the switch point is React Native's `SDK_INT > R`, not API 30, for that
 * reason); API 24-25 have no light navigation-bar appearance. It resolves to
 * the path that ran, which is recorded below.
 *
 * THE FALLBACK. Expo Go cannot carry an app's local module, so where the
 * module is absent this file still calls expo-navigation-bar's setStyle
 * ("dark" = dark buttons on a light bar, NavigationBarModule.kt line 127).
 * expo-navigation-bar therefore STAYS a dependency, as the Expo Go fallback;
 * removing it is a separate decision. In Expo Go the buttons keep following
 * only the scheme the app started in on Android 12 to 14 (API 31-34: the
 * cause above; that Expo Go carries the same androidx.core path is an
 * inference, and on API 35 and up androidx.core's Impl35 calls
 * setSystemBarsAppearance itself, untested here). The
 * package has NO background-colour function (setBackgroundColorAsync and
 * setButtonStyleAsync were removed in 56.0.0, CHANGELOG.md lines 49-51), so
 * the bar stays transparent. Its JavaScript wrapper calls the native
 * function without handling the returned promise (src/NavigationBar.android.ts
 * line 80) and its module file throws at import when the native module is
 * absent (src/ExpoNavigationBar.android.ts, requireNativeModule), so both
 * native modules are looked up with requireOptionalNativeModule and called
 * directly, and every failure is caught.
 *
 * Every attempt's outcome is recorded with the path that ran
 * (navigationBarStyleOutcome, shown in Settings → Developer); in a
 * development bundle a missing module writes one log line too.
 */

import { t } from '../i18n/index.ts';

/** The value expo-navigation-bar's setStyle takes: "light" = light buttons on a dark bar; "dark" = dark buttons on a light bar. */
export type NavigationBarButtonStyle = 'light' | 'dark';

/** The JavaScript name of the wallet's own local module (app/modules/shiba-navigation-bar). */
export const LOCAL_NAVIGATION_BAR_MODULE = 'ShibaNavigationBar';

/** The JavaScript name of expo-navigation-bar's native module (the Expo Go fallback). */
export const EXPO_NAVIGATION_BAR_MODULE = 'ExpoNavigationBar';

/**
 * The native functions this file uses; a native layer has one of them. The
 * local module's setNavigationBarAppearance (light = true asks for a light
 * bar with dark buttons) resolves to the path that ran; expo-navigation-bar's
 * setStyle resolves to nothing.
 */
export interface NavigationBarNative {
  setNavigationBarAppearance?(light: boolean): Promise<string>;
  setStyle?(style: NavigationBarButtonStyle): Promise<void>;
}

/**
 * Which path set the style: 'platform-api' = the local module through
 * WindowInsetsController.setSystemBarsAppearance (API 31 and up);
 * 'compat-flag' = the local module through the deprecated
 * SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR (API 26-30); 'expo-navigation-bar' =
 * the fallback, expo-navigation-bar's setStyle.
 */
export type NavigationBarPath = 'platform-api' | 'compat-flag' | 'expo-navigation-bar';

/**
 * The outcome of one attempt, for the checks, the log line and Settings →
 * Developer: 'not-android' = iOS or web, where neither module exists and
 * nothing is attempted; 'unavailable' = Android, but neither native module
 * was found; 'unsupported' = the local module ran on API 24-25, which have
 * no light navigation-bar appearance; 'failed' = loading or setting threw,
 * or the local module answered something unknown.
 */
export type NavigationBarApplyResult = 'applied' | 'unavailable' | 'unsupported' | 'failed' | 'not-android';

/** What loadNavigationBarNative returns off Android (kept apart from "not found"). */
export const NAVIGATION_BAR_NOT_ANDROID = 'not-android' as const;

/** The one log line of an 'unavailable' attempt in a development bundle. */
export const NAVIGATION_BAR_UNAVAILABLE_LOG =
  'Navigation bar style not applied: neither the native module ShibaNavigationBar nor ExpoNavigationBar was found in this build.';

/** The last attempt of this session (pass p23-build finding 3). */
export interface NavigationBarStyleOutcome {
  readonly result: NavigationBarApplyResult;
  /** The style that attempt asked for. */
  readonly style: NavigationBarButtonStyle;
  /** Which path set it, for 'applied'; otherwise null. */
  readonly path: NavigationBarPath | null;
  /** The failure's first line, for 'failed'; otherwise null. */
  readonly detail: string | null;
  /** Attempts so far in this session, of any outcome (a scheme change adds one). */
  readonly attempts: number;
}

let lastOutcome: NavigationBarStyleOutcome | null = null;
const outcomeListeners = new Set<() => void>();

/** The last attempt's outcome in this session, or null before the first. */
export function navigationBarStyleOutcome(): NavigationBarStyleOutcome | null {
  return lastOutcome;
}

/** Calls `listener` after every attempt (for useSyncExternalStore). Returns the unsubscribe function. */
export function subscribeNavigationBarStyleOutcome(listener: () => void): () => void {
  outcomeListeners.add(listener);
  return () => {
    outcomeListeners.delete(listener);
  };
}

/** Forgets the recorded outcome (the check script; a new session starts empty). */
export function resetNavigationBarStyleOutcome(): void {
  lastOutcome = null;
}

function recordOutcome(
  result: NavigationBarApplyResult,
  style: NavigationBarButtonStyle,
  path: NavigationBarPath | null,
  detail: string | null,
): void {
  lastOutcome = Object.freeze({ result, style, path, detail, attempts: (lastOutcome?.attempts ?? 0) + 1 });
  for (const listener of outcomeListeners) listener();
}

/**
 * The Settings → Developer line for an outcome, in the style of the "PIN
 * hashing path:" line, naming the path that ran, or null for 'not-android'
 * (nothing to show there).
 */
export function navigationBarOutcomeLine(outcome: NavigationBarStyleOutcome | null): string | null {
  if (outcome === null) return t('settings.navBar.notYet');
  switch (outcome.result) {
    case 'applied':
      if (outcome.path === 'platform-api') return t('settings.navBar.appliedPlatform', { style: outcome.style, attempts: outcome.attempts });
      if (outcome.path === 'compat-flag') return t('settings.navBar.appliedCompat', { style: outcome.style, attempts: outcome.attempts });
      return t('settings.navBar.applied', { style: outcome.style, attempts: outcome.attempts });
    case 'unavailable':
      return t('settings.navBar.unavailable', { attempts: outcome.attempts });
    case 'unsupported':
      return t('settings.navBar.unsupported', { attempts: outcome.attempts });
    case 'failed':
      return t('settings.navBar.failed', { detail: outcome.detail ?? '', attempts: outcome.attempts });
    default:
      return null;
  }
}

/** The button style that matches the app's colour scheme: light buttons in dark mode, dark buttons in light mode. */
export function navigationBarStyleFor(dark: boolean): NavigationBarButtonStyle {
  return dark ? 'light' : 'dark';
}

/** The local module's argument for a style: dark buttons ("dark") sit on a light bar. */
export function lightBarFor(style: NavigationBarButtonStyle): boolean {
  return style === 'dark';
}

/**
 * Applies the style for the given scheme and records the outcome. Never
 * throws. The local module is used when the native layer has it, else
 * expo-navigation-bar's setStyle. Off Android it is 'not-android' (nothing
 * logged). On Android a missing module is 'unavailable', written as ONE log
 * line in a development bundle (`options.dev`, App.tsx passes __DEV__) and
 * silent otherwise; any failure, while loading or while setting, is ONE log
 * line and 'failed'.
 */
export async function applyNavigationBarStyle(
  load: () => Promise<NavigationBarNative | null | typeof NAVIGATION_BAR_NOT_ANDROID>,
  dark: boolean,
  log: (line: string) => void = (line) => console.log(line),
  options: { dev?: boolean } = {},
): Promise<NavigationBarApplyResult> {
  const style = navigationBarStyleFor(dark);
  let result: NavigationBarApplyResult;
  let path: NavigationBarPath | null = null;
  let detail: string | null = null;
  try {
    const native = await load();
    if (native === NAVIGATION_BAR_NOT_ANDROID) {
      result = 'not-android';
    } else if (native && typeof native.setNavigationBarAppearance === 'function') {
      const answer = await native.setNavigationBarAppearance(lightBarFor(style));
      if (answer === 'platform-api' || answer === 'compat-flag') {
        result = 'applied';
        path = answer;
      } else if (answer === 'unsupported') {
        result = 'unsupported';
      } else {
        throw new Error(`the ShibaNavigationBar module answered ${JSON.stringify(answer)}`);
      }
    } else if (native && typeof native.setStyle === 'function') {
      await native.setStyle(style);
      result = 'applied';
      path = 'expo-navigation-bar';
    } else {
      result = 'unavailable';
      if (options.dev === true) log(NAVIGATION_BAR_UNAVAILABLE_LOG);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    detail = message.split(/\r?\n/)[0];
    log(`Navigation bar style not applied: ${detail}`);
    result = 'failed';
  }
  recordOutcome(result, style, path, detail);
  return result;
}

/**
 * Chooses the native layer from a module lookup (requireOptionalNativeModule
 * in the app, a fake in the check script): the wallet's own module when the
 * build carries it, else expo-navigation-bar's (all that Expo Go has), else
 * null.
 */
export function pickNavigationBarNative(lookup: (name: string) => unknown): NavigationBarNative | null {
  const local = lookup(LOCAL_NAVIGATION_BAR_MODULE) as { setNavigationBarAppearance?: (light: boolean) => Promise<string> } | null;
  if (local && typeof local.setNavigationBarAppearance === 'function') {
    const setAppearance = local.setNavigationBarAppearance.bind(local);
    return { setNavigationBarAppearance: (light) => setAppearance(light) };
  }
  const nav = lookup(EXPO_NAVIGATION_BAR_MODULE) as { setStyle?: (style: string) => Promise<void> } | null;
  if (nav && typeof nav.setStyle === 'function') {
    const setStyle = nav.setStyle.bind(nav);
    return { setStyle: (style) => setStyle(style) };
  }
  return null;
}

/**
 * react-native, loaded lazily so this module stays loadable under Node (the
 * check script injects the native layer). A CommonJS require, as in
 * screen-protection.ts and notifications.ts, so Metro's interop does not read
 * react-native's deprecated getters.
 */
function reactNative(): typeof import('react-native') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, see above
  return require('react-native') as typeof import('react-native');
}

/**
 * Finds the native layer on Android only. Returns NAVIGATION_BAR_NOT_ANDROID
 * on any other platform, and null when the build carries neither module
 * (requireOptionalNativeModule, re-exported by expo, returns null instead of
 * throwing: expo-modules-core 57.0.21 src/requireNativeModule.ts lines
 * 25-49).
 */
export async function loadNavigationBarNative(): Promise<NavigationBarNative | null | typeof NAVIGATION_BAR_NOT_ANDROID> {
  const { Platform } = reactNative();
  if (Platform.OS !== 'android') return NAVIGATION_BAR_NOT_ANDROID;
  const { requireOptionalNativeModule } = await import('expo');
  return pickNavigationBarNative((name) => requireOptionalNativeModule(name));
}

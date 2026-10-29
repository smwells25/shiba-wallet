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
 * app runs does not repeat that, so the bar keeps the appearance of the
 * scheme the app started in.
 *
 * WHAT expo-navigation-bar 57.0.3 CAN DO. Its native module "ExpoNavigationBar"
 * has an AsyncFunction "setStyle" taking "light" or "dark"
 * (android/src/main/java/expo/modules/navigationbar/NavigationBarModule.kt,
 * lines 126-133): "dark" means dark buttons on a light bar
 * (`hasLightBackground = style == "dark"`, line 127), and it sets
 * isAppearanceLightNavigationBars on the activity window and on every extra
 * window (dialogs), keeping the theme's contrast setting (lines 32-53). The
 * package has NO background-colour function: setBackgroundColorAsync and
 * setButtonStyleAsync were removed in 56.0.0 (CHANGELOG.md lines 49-51), so
 * the bar's background cannot be set to the theme's background colour; it
 * stays transparent, showing the app beneath it or the system's contrast
 * scrim. Its JavaScript wrapper calls the native function without handling
 * the returned promise (src/NavigationBar.android.ts line 80) and its module
 * file throws at import when the native module is absent
 * (src/ExpoNavigationBar.android.ts, requireNativeModule), so this module
 * talks to the native module directly, found with requireOptionalNativeModule
 * first, and catches every failure.
 *
 * PASS p23-build (finding 3, a development build on the emulator): the bar
 * was transparent, but MainActivity's isAppearanceLightNavigationBars flag
 * kept its window-creation value after a runtime scheme change while the
 * status-bar flag followed. Read from source, without a device: the effect
 * below IS keyed on theme.dark, and theme.dark comes from useColorScheme
 * (src/theme.ts line 14), the same hook expo-status-bar's StatusBar uses
 * (node_modules/expo-status-bar/src/NativeStatusBarWrapper.tsx lines 23-24),
 * so the effect does run again on a scheme change; no native code found that
 * sets the flag back after a configuration change (react-native 0.86.3:
 * ReactActivityDelegate.java line 141 calls updateEdgeToEdgeFeatureFlag only
 * in onCreate, AppearanceModule.kt lines 106-112 only emits the JS event;
 * expo-navigation-bar's NavigationBarReactActivityLifecycleListener.kt lines
 * 37-56 acts only in onCreate; RN's status-bar style call passes the
 * APPEARANCE_LIGHT_STATUS_BARS mask only, WindowUtil.kt lines 101-113). The
 * module lookup returning null ('unavailable', which logged nothing) is NOT
 * excluded. So every attempt's outcome is now recorded
 * (navigationBarStyleOutcome, shown in Settings → Developer) and, in a
 * development bundle, 'unavailable' writes one log line too.
 *
 * WHAT IS NOT VERIFIED without a device: that the system's contrast scrim
 * follows the appearance set here (so the white strip turns dark in dark
 * mode), and that the button colour changes while contrast is enforced (the
 * library's own documentation says setStyle has a visible effect only on a
 * button navigation bar and with its `enforceContrast` plugin option set to
 * false, src/NavigationBar.types.ts lines 34-42).
 *
 * OPEN QUESTION (pass p23-bridge-recheck, 2026-10-28; cause NOT established).
 * The same symptom was seen in Expo Go: setStyle("light") resolved, the
 * Settings line counted the attempt, and 9 s later the activity window still
 * reported apr=LIGHT_NAVIGATION_BARS while the status-bar flag had followed
 * the theme. Read from the installed sources only:
 *  - setStyle writes the flag on appContext.throwingActivity's window through
 *    WindowInsetsControllerCompat(window, decorView) (NavigationBarModule.kt
 *    lines 50-52 and 126-130), the same kind of controller React Native used
 *    to set it at window creation (WindowUtil.kt lines 167 and 189).
 *  - Nothing found in the installed JavaScript or Kotlin/Java sources writes
 *    the navigation-bar appearance again after that: React Native sets it
 *    only in enableEdgeToEdge, called from updateEdgeToEdgeFeatureFlag in
 *    ReactActivityDelegate.onCreate (WindowUtil.kt line 67,
 *    ReactActivityDelegate.java line 141) and, for Modal dialog windows
 *    only, ReactModalHostView.kt line 395; its configuration-change path
 *    (ReactDelegate.kt lines 237-247, ReactHostImpl.kt line 736,
 *    AppearanceModule.kt lines 106-112) does not touch the window;
 *    react-native-screens only hides or shows the bar
 *    (ScreenWindowTraits.kt lines 123-146); expo's
 *    ReactActivityDelegateWrapper.kt lines 358-363 only forwards the change;
 *    expo-dev-launcher sets it only for its own launcher and error
 *    activities (DevLauncherEdgeToEdgeHelper.kt lines 14-17).
 *  - What remains is compiled code that is not on this machine as source:
 *    androidx.core's WindowInsetsControllerCompat, AppCompat's DayNight
 *    handling of the uiMode change (MainActivity declares
 *    configChanges="…uiMode…" and its theme's parent is
 *    Theme.AppCompat.DayNight.NoActionBar in the development build's
 *    prebuild), and the framework's own computation of the window's
 *    appearance. The library's documentation also says setStyle "may have
 *    no effect" on the Android 15 emulator (NavigationBar.types.ts line 42);
 *    this AVD runs an android-34 image (~/.android/avd/shiba.avd/config.ini),
 *    so that note does not apply as written.
 * Tests that would establish it: read `adb shell dumpsys window` for the
 * activity's apr= at once after setStyle resolves and again over several
 * seconds (does the flag flip and flip back, or never change?); call
 * setStyle a second time a few seconds after the scheme change; in a
 * development build, read WindowCompat.getInsetsController(window,
 * decorView).isAppearanceLightNavigationBars and the legacy
 * decorView.systemUiVisibility SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR bit right
 * after the call (a temporary native probe), to see whether the two
 * disagree; and repeat on a non-AppCompat test activity or another system
 * image. No change is made here until one of these shows the cause.
 */

import { t } from '../i18n/index.ts';

/** The value the native setStyle takes: "light" = light buttons on a dark bar; "dark" = dark buttons on a light bar. */
export type NavigationBarButtonStyle = 'light' | 'dark';

/** The native function this module uses (NavigationBarModule.kt, AsyncFunction "setStyle"). */
export interface NavigationBarNative {
  setStyle(style: NavigationBarButtonStyle): Promise<void>;
}

/**
 * The outcome of one attempt, for the checks, the log line and Settings →
 * Developer: 'not-android' = iOS or web, where the module does not exist and
 * nothing is attempted; 'unavailable' = Android, but the native module was
 * not found; 'failed' = loading or setStyle threw.
 */
export type NavigationBarApplyResult = 'applied' | 'unavailable' | 'failed' | 'not-android';

/** What loadNavigationBarNative returns off Android (kept apart from "not found"). */
export const NAVIGATION_BAR_NOT_ANDROID = 'not-android' as const;

/** The one log line of an 'unavailable' attempt in a development bundle. */
export const NAVIGATION_BAR_UNAVAILABLE_LOG =
  'Navigation bar style not applied: the native module ExpoNavigationBar was not found in this build.';

/** The last attempt of this session (pass p23-build finding 3). */
export interface NavigationBarStyleOutcome {
  readonly result: NavigationBarApplyResult;
  /** The style that attempt asked for. */
  readonly style: NavigationBarButtonStyle;
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

function recordOutcome(result: NavigationBarApplyResult, style: NavigationBarButtonStyle, detail: string | null): void {
  lastOutcome = Object.freeze({ result, style, detail, attempts: (lastOutcome?.attempts ?? 0) + 1 });
  for (const listener of outcomeListeners) listener();
}

/**
 * The Settings → Developer line for an outcome, in the style of the "PIN
 * hashing path:" line, or null for 'not-android' (nothing to show there).
 */
export function navigationBarOutcomeLine(outcome: NavigationBarStyleOutcome | null): string | null {
  if (outcome === null) return t('settings.navBar.notYet');
  switch (outcome.result) {
    case 'applied':
      return t('settings.navBar.applied', { style: outcome.style, attempts: outcome.attempts });
    case 'unavailable':
      return t('settings.navBar.unavailable', { attempts: outcome.attempts });
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

/**
 * Applies the style for the given scheme and records the outcome. Never
 * throws. Off Android it is 'not-android' (nothing logged). On Android a
 * missing module is 'unavailable', written as ONE log line in a development
 * bundle (`options.dev`, App.tsx passes __DEV__) and silent otherwise; any
 * failure, while loading or while setting, is ONE log line and 'failed'.
 */
export async function applyNavigationBarStyle(
  load: () => Promise<NavigationBarNative | null | typeof NAVIGATION_BAR_NOT_ANDROID>,
  dark: boolean,
  log: (line: string) => void = (line) => console.log(line),
  options: { dev?: boolean } = {},
): Promise<NavigationBarApplyResult> {
  const style = navigationBarStyleFor(dark);
  let result: NavigationBarApplyResult;
  let detail: string | null = null;
  try {
    const native = await load();
    if (native === NAVIGATION_BAR_NOT_ANDROID) {
      result = 'not-android';
    } else if (!native) {
      result = 'unavailable';
      if (options.dev === true) log(NAVIGATION_BAR_UNAVAILABLE_LOG);
    } else {
      await native.setStyle(style);
      result = 'applied';
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    detail = message.split(/\r?\n/)[0];
    log(`Navigation bar style not applied: ${detail}`);
    result = 'failed';
  }
  recordOutcome(result, style, detail);
  return result;
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
 * Finds the native module on Android only. Returns NAVIGATION_BAR_NOT_ANDROID
 * on any other platform, and null when the build does not carry the module
 * (requireOptionalNativeModule, re-exported by expo, returns null instead of
 * throwing: expo-modules-core 57.0.21 src/requireNativeModule.ts lines
 * 25-49).
 */
export async function loadNavigationBarNative(): Promise<NavigationBarNative | null | typeof NAVIGATION_BAR_NOT_ANDROID> {
  const { Platform } = reactNative();
  if (Platform.OS !== 'android') return NAVIGATION_BAR_NOT_ANDROID;
  const { requireOptionalNativeModule } = await import('expo');
  const nav = requireOptionalNativeModule<{ setStyle?: (style: string) => Promise<void> }>('ExpoNavigationBar');
  if (!nav || typeof nav.setStyle !== 'function') return null;
  const setStyle = nav.setStyle.bind(nav);
  return { setStyle: (style) => setStyle(style) };
}

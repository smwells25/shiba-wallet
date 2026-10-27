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
 * WHAT IS NOT VERIFIED without a device: that the system's contrast scrim
 * follows the appearance set here (so the white strip turns dark in dark
 * mode), and that the button colour changes while contrast is enforced (the
 * library's own documentation says setStyle has a visible effect only on a
 * button navigation bar and with its `enforceContrast` plugin option set to
 * false, src/NavigationBar.types.ts lines 34-42).
 */

/** The value the native setStyle takes: "light" = light buttons on a dark bar; "dark" = dark buttons on a light bar. */
export type NavigationBarButtonStyle = 'light' | 'dark';

/** The native function this module uses (NavigationBarModule.kt, AsyncFunction "setStyle"). */
export interface NavigationBarNative {
  setStyle(style: NavigationBarButtonStyle): Promise<void>;
}

/** The outcome of one attempt, for the checks and the log line. */
export type NavigationBarApplyResult = 'applied' | 'unavailable' | 'failed';

/** The button style that matches the app's colour scheme: light buttons in dark mode, dark buttons in light mode. */
export function navigationBarStyleFor(dark: boolean): NavigationBarButtonStyle {
  return dark ? 'light' : 'dark';
}

/**
 * Applies the style for the given scheme. Never throws: a missing module is
 * 'unavailable' (nothing logged; iOS, web and a build without the module),
 * and any failure, while loading or while setting, is written as ONE log
 * line and reported as 'failed'.
 */
export async function applyNavigationBarStyle(
  load: () => Promise<NavigationBarNative | null>,
  dark: boolean,
  log: (line: string) => void = (line) => console.log(line),
): Promise<NavigationBarApplyResult> {
  try {
    const native = await load();
    if (!native) return 'unavailable';
    await native.setStyle(navigationBarStyleFor(dark));
    return 'applied';
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log(`Navigation bar style not applied: ${detail.split(/\r?\n/)[0]}`);
    return 'failed';
  }
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
 * Finds the native module on Android only. Returns null on any other
 * platform and when the build does not carry the module
 * (requireOptionalNativeModule, re-exported by expo, returns null instead of
 * throwing: expo-modules-core 57.0.21 src/requireNativeModule.ts lines
 * 25-49).
 */
export async function loadNavigationBarNative(): Promise<NavigationBarNative | null> {
  const { Platform } = reactNative();
  if (Platform.OS !== 'android') return null;
  const { requireOptionalNativeModule } = await import('expo');
  const nav = requireOptionalNativeModule<{ setStyle?: (style: string) => Promise<void> }>('ExpoNavigationBar');
  if (!nav || typeof nav.setStyle !== 'function') return null;
  const setStyle = nav.setStyle.bind(nav);
  return { setStyle: (style) => setStyle(style) };
}

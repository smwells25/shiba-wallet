/**
 * App-wide screen protection (phase 17 item 0; the Chairperson's decision of
 * 2026-10-10): while the "screenProtection" preference is on (the default),
 * the whole app is protected from screenshots, screen recording and the
 * app-switcher preview; turning it off in Settings → Privacy releases only
 * this app-wide protection. The screens that hold secrets keep their own,
 * separately keyed protection either way.
 *
 * This module is Node-loadable on purpose: it imports neither React nor
 * React Native nor expo-screen-capture at the top level, so
 * scripts/check-screen-protection.mjs drives the real state machine with
 * injected fakes. The native module is reached only through
 * loadScreenCaptureNative(), a dynamic import called by the app at runtime.
 *
 * Platform facts, read from the installed expo-screen-capture 57.0.4
 * (app/node_modules/expo-screen-capture):
 *
 *  - Keys. src/ScreenCapture.ts keeps a module-level `activeTags` Set (line
 *    7). preventScreenCaptureAsync(key) adds the key and calls the native
 *    prevent only when the key was not already in the Set (lines 42-50; on a
 *    native failure the key is removed again, line 47).
 *    allowScreenCaptureAsync(key) removes the key and calls the native allow
 *    ONLY when the Set is then empty (lines 68-71). Protection therefore
 *    stays on while ANY key is held: the seed screens' own keys
 *    ('default' from usePreventScreenCapture() in BackupScreen, 'seed-reveal'
 *    in SettingsScreen, 'subscription-key' in SessionsScreen and the two
 *    private-key screens' CAPTURE_KEY) cannot release the app-wide key, and
 *    releasing the app-wide key cannot release theirs. The mechanism this
 *    module relies on is a distinct key that no other code uses
 *    (APP_WIDE_CAPTURE_KEY); the check script pins that no other prevent or
 *    allow call in app/src uses it, and pins the library lines above.
 *    The Set is keyed, not counted: a second prevent with the same key is a
 *    no-op and one allow with that key releases it. So this module calls
 *    prevent with its key at most once per successful application and never
 *    shares the key.
 *  - Android. The native prevent adds WindowManager.LayoutParams.FLAG_SECURE
 *    to the current activity's window and the native allow clears it
 *    (android/src/main/java/expo/modules/screencapture/ScreenCaptureModule.kt
 *    lines 87-93). FLAG_SECURE blocks screenshots and screen recording of
 *    that window and blanks its recent-apps thumbnail (the library's own
 *    note, src/ScreenCapture.ts lines 106-107). With no current activity the
 *    native call throws Exceptions.MissingActivity (ScreenCaptureModule.kt
 *    line 31), which is caught here and retried on the next foreground.
 *    React Native 0.86.3 copies FLAG_SECURE from the activity onto a Modal's
 *    dialog window when the dialog is created
 *    (node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/
 *    views/modal/ReactModalHostView.kt lines 334-341), so the app's Modals
 *    are covered as well.
 *  - iOS. The native prevent re-parents the key window's layer into the
 *    canvas layer of a secure-entry UITextField so screenshots omit it
 *    (ios/SecureWindowCanvas.swift lines 5-39; ScreenCaptureModule.swift
 *    lines 127-144) and covers the window with a black view while
 *    UIScreen.isCaptured is true (recording or mirroring; lines 93-105). It
 *    throws NoKeyWindowException before the app has a key window and
 *    SecureCanvasAttachmentException when the canvas cannot attach (lines
 *    132-140, 240-250); both are caught here and retried. The app-switcher
 *    preview is NOT handled by prevent on iOS: enableAppSwitcherProtectionAsync
 *    (src/ScreenCapture.ts lines 114-120, "@platform ios") adds a blur view
 *    over the root view on willResignActive and removes it on
 *    didBecomeActive (ScreenCaptureModule.swift lines 151-237). The blur is
 *    a UIBlurEffect(.light) whose strength is the given intensity
 *    (ios/AnimatedBlurEffectView.swift lines 8-31); this module passes the
 *    maximum, 1.0. On Android the app-switcher functions are not part of the
 *    native module and the JS wrapper throws UnavailabilityError (lines
 *    115-117), so they are injected only on iOS.
 *  - Web. src/ExpoScreenCapture.web.ts exports an empty object, so prevent
 *    throws UnavailabilityError; it is caught like any native failure.
 *
 * Start-up order (a decision): the preference is read from AsyncStorage
 * asynchronously, so the first frames are drawn before the stored value is
 * known. This module protects FIRST and releases afterwards if the stored
 * value says off. The alternative would leave the default (on) user
 * unprotected for that moment; a brief protected moment for a user who
 * turned it off costs nothing, a brief unprotected moment for everyone
 * else could expose a balance or an address in a capture or the
 * app-switcher snapshot. Erring on protected is the wallet's rule.
 */

/** The app-wide key. No other prevent or allow call in app/src may use it. */
export const APP_WIDE_CAPTURE_KEY = 'app-wide';

/**
 * Strength of the iOS app-switcher blur, 0.0 to 1.0
 * (ios/AnimatedBlurEffectView.swift line 30 sets the blur animator's
 * fractionComplete to it). The maximum is used.
 */
export const IOS_APP_SWITCHER_BLUR = 1.0;

/** The native calls, injected so the state machine runs under Node. */
export interface ScreenCaptureNative {
  /** expo-screen-capture preventScreenCaptureAsync(key). */
  prevent(key: string): Promise<void>;
  /** expo-screen-capture allowScreenCaptureAsync(key). */
  allow(key: string): Promise<void>;
  /** iOS only: enableAppSwitcherProtectionAsync(IOS_APP_SWITCHER_BLUR). */
  enableAppSwitcherCover?: () => Promise<void>;
  /** iOS only: disableAppSwitcherProtectionAsync(). */
  disableAppSwitcherCover?: () => Promise<void>;
}

export type ScreenProtectionStatus =
  /** Nothing has been asked yet. */
  | { state: 'idle' }
  /** Turning on (or confirming on at launch). */
  | { state: 'applying' }
  | { state: 'on' }
  /** Turning off. */
  | { state: 'releasing' }
  | { state: 'off' }
  /** The last attempt failed; `wanted` says which direction was attempted. */
  | { state: 'failed'; wanted: 'on' | 'off'; detail: string };

export interface ScreenProtectionController {
  /**
   * Tells the controller what the preference says. `prefsLoaded` false means
   * the stored value is not known yet, which counts as ON (see the start-up
   * order above).
   */
  update(input: { prefsLoaded: boolean; enabled: boolean }): Promise<void>;
  /** Tries again after a failure (the app calls it on every return to the foreground). */
  retryIfFailed(): Promise<void>;
  status(): ScreenProtectionStatus;
  /** Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Shortens a native error to one plain line for the Settings status. */
export function describeNativeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return 'no reason was given';
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

/**
 * Builds the state machine. Native calls are serialised: while one runs,
 * later updates only change the wanted state, and the loop applies the
 * latest wanted state when the running call finishes. A failure stops the
 * loop for that direction until retryIfFailed() or a new update asks for a
 * different direction.
 */
export function createScreenProtection(
  getNative: () => Promise<ScreenCaptureNative>,
): ScreenProtectionController {
  // null until the first update; then what the preference wants. Before the
  // preference is loaded the wanted state is ON.
  let wanted: boolean | null = null;
  // What was last applied successfully; null = no native call made yet (the
  // window starts without the app-wide protection).
  let applied: boolean | null = null;
  let current: ScreenProtectionStatus = { state: 'idle' };
  let failedFor: boolean | null = null;
  let running: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function setStatus(next: ScreenProtectionStatus): void {
    current = next;
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // A listener's failure must not stop protection.
      }
    }
  }

  async function applyOn(native: ScreenCaptureNative): Promise<void> {
    await native.prevent(APP_WIDE_CAPTURE_KEY);
    if (native.enableAppSwitcherCover) await native.enableAppSwitcherCover();
  }

  async function applyOff(native: ScreenCaptureNative): Promise<void> {
    // allow() with the app-wide key only: the library releases the native
    // flag only when no other key is held (src/ScreenCapture.ts lines 68-71),
    // so a secret screen that is open keeps its protection.
    await native.allow(APP_WIDE_CAPTURE_KEY);
    if (native.disableAppSwitcherCover) await native.disableAppSwitcherCover();
  }

  async function loop(): Promise<void> {
    for (;;) {
      if (wanted === null) return;
      const target = wanted;
      if (failedFor === target) return;
      if (applied === target) {
        setStatus({ state: target ? 'on' : 'off' });
        return;
      }
      if (!target && applied === null) {
        // Nothing was ever applied, so there is nothing to release. Not
        // reached in the app (the first update always arrives before the
        // preference is loaded and so asks for ON), kept for completeness.
        applied = false;
        setStatus({ state: 'off' });
        return;
      }
      setStatus({ state: target ? 'applying' : 'releasing' });
      try {
        const native = await getNative();
        if (target) await applyOn(native);
        else await applyOff(native);
        applied = target;
        failedFor = null;
      } catch (error) {
        failedFor = target;
        // A failed ON may have left part of the protection in place (on iOS
        // the screenshot block can succeed while the app-switcher cover
        // fails); a failed OFF may have released part of it. Either way the
        // next attempt runs both steps again: prevent() with a key already
        // held and allow() with a key not held are no-ops in the library.
        applied = null;
        setStatus({ state: 'failed', wanted: target ? 'on' : 'off', detail: describeNativeError(error) });
      }
    }
  }

  function kick(): Promise<void> {
    if (running) return running;
    running = loop().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    async update({ prefsLoaded, enabled }) {
      const next = prefsLoaded ? enabled : true;
      if (next !== wanted) {
        wanted = next;
        // A new direction deserves a fresh attempt.
        if (failedFor !== null && failedFor !== next) failedFor = null;
      }
      // If a call is in flight, the loop picks the new wanted state up when
      // it finishes; wait for that too.
      await kick();
      if (wanted !== null && applied !== wanted && failedFor !== wanted) await kick();
    },
    async retryIfFailed() {
      if (failedFor === null) return;
      failedFor = null;
      await kick();
    },
    status: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---- Settings copy (pinned by scripts/check-screen-protection.mjs) ----

export const SCREEN_PROTECTION_TITLE = 'Privacy';
export const SCREEN_PROTECTION_SWITCH_LABEL = 'Hide in the app switcher and block screenshots';
export const SCREEN_PROTECTION_PLATFORM_NOTE =
  'On Android this also blocks screenshots and screen recording of every screen in this wallet, ' +
  'including your Receive QR; copy the address instead. On iOS, screenshots come out blank and the ' +
  'app switcher shows a cover.';
/**
 * Which screens keep their own protection whatever this setting: BackupScreen
 * (usePreventScreenCapture), Settings → Show recovery phrase ('seed-reveal'),
 * the private-key import and reveal screens and the subscription key
 * hand-over. The phrase IMPORT screen (ImportScreen.tsx) and the backup quiz
 * (ConfirmBackupScreen.tsx) make no capture call of their own, so the
 * sentence names the screens that do rather than "every recovery phrase
 * screen".
 */
export const SCREEN_PROTECTION_ALWAYS_NOTE =
  'The screens that show or take in your recovery phrase or a private key are always protected, whatever this setting.';

/** The status line under the switch. */
export function describeScreenProtectionStatus(status: ScreenProtectionStatus): string {
  switch (status.state) {
    case 'idle':
    case 'applying':
      return 'Turning screen protection on…';
    case 'on':
      return 'Screen protection is on.';
    case 'releasing':
      return 'Turning screen protection off…';
    case 'off':
      return 'Screen protection is off.';
    case 'failed':
      return status.wanted === 'on'
        ? `Screen protection could not be turned on on this device, so screenshots, recordings or the app switcher may show this wallet's screens. It is tried again each time the app returns to the foreground. Technical detail: ${status.detail}`
        : `Screen protection could not be turned off on this device; screens may stay protected. It is tried again each time the app returns to the foreground. Technical detail: ${status.detail}`;
  }
}

/**
 * react-native, loaded lazily so this module stays loadable under Node (the
 * check script injects the native calls). A CommonJS require is used rather
 * than a dynamic `import('react-native')`: Metro's ES-module interop copies
 * every export of the namespace, which reads react-native's deprecated
 * getters (PushNotificationIOS, Clipboard, SafeAreaView, …) and raised five
 * LogBox warnings at every launch (seen on the emulator, 2026-10-10); a
 * require reads only the two properties used.
 */
function reactNative(): typeof import('react-native') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, see above
  return require('react-native') as typeof import('react-native');
}

// ---- The app's instance (runtime only) ----

/**
 * Loads the native layer. Called only by the app at runtime, never by the
 * check script: the dynamic imports keep expo-screen-capture and
 * react-native out of this module's static imports.
 */
export async function loadScreenCaptureNative(): Promise<ScreenCaptureNative> {
  const capture = await import('expo-screen-capture');
  const { Platform } = reactNative();
  const native: ScreenCaptureNative = {
    prevent: (key) => capture.preventScreenCaptureAsync(key),
    allow: (key) => capture.allowScreenCaptureAsync(key),
  };
  if (Platform.OS === 'ios') {
    native.enableAppSwitcherCover = () => capture.enableAppSwitcherProtectionAsync(IOS_APP_SWITCHER_BLUR);
    native.disableAppSwitcherCover = () => capture.disableAppSwitcherProtectionAsync();
  }
  return native;
}

let appInstance: ScreenProtectionController | null = null;

/** The single app-wide controller (created on first use). */
export function appScreenProtection(): ScreenProtectionController {
  if (!appInstance) {
    let nativePromise: Promise<ScreenCaptureNative> | null = null;
    appInstance = createScreenProtection(() => {
      if (!nativePromise) {
        nativePromise = loadScreenCaptureNative();
        // A failed load (for example a build without the module) is retried
        // on the next attempt instead of being cached.
        nativePromise.catch(() => {
          nativePromise = null;
        });
      }
      return nativePromise;
    });
    const instance = appInstance;
    // A failed attempt (for example iOS before the key window exists, or
    // Android without a current activity) is tried again on every return to
    // the foreground. react-native is imported dynamically for the same
    // reason as above; the listener lives as long as the app.
    try {
      reactNative().AppState.addEventListener('change', (next) => {
        if (next === 'active') void instance.retryIfFailed();
      });
    } catch {
      // Without react-native (the Node check script) there is no foreground event.
    }
  }
  return appInstance;
}

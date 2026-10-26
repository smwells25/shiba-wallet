import React, { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { Button, useFieldLabels } from '../components';
import { T } from '../i18n/T';
import { useI18n } from '../i18n/useI18n';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { useWallet } from '../wallet/WalletContext';
import { localAuthAvailable, requireLocalAuth } from '../wallet/biometric';
import {
  INITIAL_LOCK_GATE_STATE,
  applyLockGateEvent,
  attemptUnlock,
  lockGateArmed,
  lockGateAvailable,
  lockGateWalletStatus,
  lockGateView,
  lockScreenHint,
  reconcileLockGate,
  type LockGateInputs,
  type LockGateState,
} from '../wallet/lock';
import { PIN_LENGTH, pinCountdownText, type PinCountdown } from '../wallet/pin';
import { PIN_PAD_TITLE, appLockKind, lockCopy } from '../wallet/duress';

/**
 * Whether the lock overlay is currently up. Consumers that can surface
 * sensitive, actionable UI on their own — the app-level WalletConnect
 * approval sheet — read this and render nothing while it is true, so no
 * approval can be seen or acted on behind (or, for native windows such as
 * RN Modal, above) the lock screen. Defaults to false outside the gate.
 */
const LockStateContext = createContext<{ locked: boolean }>({ locked: false });

export function useAppLock(): { locked: boolean } {
  return useContext(LockStateContext);
}

/**
 * Auto-lock gate (phase 4, item 5.1): renders its children always — plus a
 * full-screen overlay on top while the app is locked. An OVERLAY, not a
 * navigation reset: every screen keeps its state (a half-typed recipient
 * survives a lock), nothing sensitive is reachable because the overlay
 * covers the entire window and unlocking requires requireLocalAuth (the
 * OS biometric prompt with the OS passcode as fallback — see the
 * deliberate no-custom-PIN decision documented in ../wallet/lock.ts).
 *
 * The gate only arms when ALL of these hold:
 *  - a wallet exists (status 'ready' — onboarding has nothing to protect),
 *  - the user chose a threshold in Settings (autoLockMs != null),
 *  - the device has not said it cannot prompt (localAuthAvailable —
 *    otherwise the setting is hidden in Settings and this gate stays
 *    inert; while the answer is still pending the gate counts as armed, so
 *    it fails closed).
 *
 * LOCK ON LAUNCH (F-77(b)): with auto-lock on the wallet STARTS locked, so
 * a swiped-away or killed app no longer reopens unlocked. The decision is
 * taken once, while rendering, the first time the wallet status and the
 * stored preferences are both known; until then a loaded wallet sits under
 * a neutral cover, so no frame of a wallet screen is drawn first. See the
 * rule and its reasons in ../wallet/lock.ts.
 *
 * Every decision is a pure function in ../wallet/lock.ts (reduceLock,
 * reconcileLockGate, lockGateView, attemptUnlock), exercised in
 * scripts/check-devmode.mjs; this component only feeds them AppState
 * events and its inputs.
 *
 * APP PIN (opt-in; docs/DURESS_WALLET.md section 7.1). While an app PIN is
 * set, the lock screen takes the PIN on the PinPad below instead of the
 * device prompt (which is not a fallback for it), at launch and after
 * auto-lock alike (the same lock view). The wallet status and the device
 * answer this component feeds the pure functions are adjusted by
 * ../wallet/lock.ts lockGateWalletStatus / lockGateAvailable: a wallet that
 * loads behind the PIN counts as ready (so the launch locks and the lock
 * stays up until the PIN was accepted and the opened wallet is loaded), and
 * the gate never depends on biometrics. WalletContext.unlockWithPin decides
 * which wallet the PIN opens; when it opens a different one, `profileKey`
 * changes and the whole tree below is remounted, so no screen keeps state
 * of the other wallet. When the app lock is a PASSPHRASE
 * (docs/DURESS_WALLET.md section 8.2) the lock view shows the
 * PassphraseField below instead of the pad, chosen from the lock's kind
 * that WalletContext read with the PIN record at launch, before any wallet.
 *
 * NOTE: the OS biometric prompt itself fires 'inactive'/'background'
 * AppState events on some platforms. That is harmless here: the away
 * timer those events start is cleared on the next 'active', and a lock
 * only triggers when the away time actually reached the threshold.
 */
export function LockGate({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const { status: walletStatus, awaitingPin, unlockWithPin, profileKey } = useWallet();
  const { autoLockMs, ready: prefsReady } = usePrefs();
  const { appPinOn } = usePrefs();
  // The app lock's kind (a PIN or a passphrase), known from the PIN record
  // read at launch before any wallet loads (../wallet/duress.ts appLockKind).
  const lockKind = useSyncExternalStore(appLockKind.subscribe, appLockKind.get);
  // null until the device has answered: the gate fails closed meanwhile.
  const [deviceAvailable, setAvailable] = useState<boolean | null>(null);
  // With an app PIN: a wallet loading behind the PIN counts as ready, and
  // the gate does not depend on biometrics (../wallet/lock.ts).
  const status = lockGateWalletStatus(walletStatus, appPinOn);
  const available = lockGateAvailable(deviceAvailable, appPinOn);
  const [gate, setGate] = useState<LockGateState>(INITIAL_LOCK_GATE_STATE);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const unlockBusy = useRef(false);

  // Availability is re-checked whenever the auto-lock setting changes,
  // not only at mount: biometric enrollment can happen while this JS
  // session is alive (device Settings in another task), and a
  // mount-time-only check left the gate permanently inert until an app
  // restart (emulator-validation finding #4).
  useEffect(() => {
    let cancelled = false;
    localAuthAvailable().then(
      (ok) => {
        if (!cancelled) setAvailable(ok);
      },
      () => {
        if (!cancelled) setAvailable(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [autoLockMs]);

  const inputs: LockGateInputs = { walletStatus: status, prefsReady, autoLockMs, available };
  const armed = lockGateArmed(inputs);

  // Takes the launch decision (once) and, while disarmed (threshold set to
  // off, wallet wiped, no biometrics), clears any lock and pending timer so
  // a later re-arm starts fresh. It runs WHILE RENDERING (React's "adjust
  // state when a prop changes" pattern): React re-renders with the new state
  // before committing, so the render that first sees a loaded wallet with
  // auto-lock on commits the lock screen, never the screens. The function
  // returns the same object when nothing changes, so this cannot loop. The
  // effect below only manages the AppState subscription.
  const reconciled = reconcileLockGate(gate, inputs);
  if (reconciled !== gate) setGate(reconciled);

  useEffect(() => {
    if (!armed) return;
    const subscription = AppState.addEventListener('change', (nextStatus) => {
      setGate((prev) =>
        applyLockGateEvent(prev, { type: 'app-state', status: nextStatus, now: Date.now() }, autoLockMs),
      );
    });
    return () => subscription.remove();
  }, [armed, autoLockMs]);

  const unlock = async () => {
    if (unlockBusy.current) return;
    unlockBusy.current = true;
    setUnlockError(null);
    try {
      // One device prompt, with no approval-target override: the target is
      // the one WalletContext set for the active account (never the phrase
      // for a watch-only or multisig account).
      const outcome = await attemptUnlock(requireLocalAuth);
      if (outcome.unlocked) {
        // A pass without a prompt (biometrics/enrollment vanished while
        // locked) also lifts the overlay: requireLocalAuth's documented
        // matrix proceeds ungated there (the OS device lock remains the real
        // protection), rather than bricking the wallet.
        setGate((prev) => applyLockGateEvent(prev, { type: 'unlock' }, autoLockMs));
      } else {
        setUnlockError(outcome.message);
      }
    } finally {
      unlockBusy.current = false;
    }
  };

  // The app PIN's unlock (the lock view with a PinPad): WalletContext checks
  // the PIN, opens (and loads) the wallet it belongs to, and only then the
  // lock is lifted. Returns the sentence to show — or, when a wait runs, the
  // wait for the pad to count down — or null on success; the PinPad has
  // already dropped the typed digits.
  const unlockWithAppPin = async (pin: string): Promise<PinPadAnswer> => {
    if (unlockBusy.current) return null;
    unlockBusy.current = true;
    try {
      const outcome = await unlockWithPin(pin);
      if (!outcome.ok) return outcome.countdown ? { countdown: outcome.countdown } : outcome.message;
      setGate((prev) => applyLockGateEvent(prev, { type: 'unlock' }, autoLockMs));
      return null;
    } finally {
      unlockBusy.current = false;
    }
  };

  const view = lockGateView(reconciled, inputs);
  // `locked` = anything covers the screens (the lock screen, or the neutral
  // cover before the launch decision): the screens are hidden from view and
  // from accessibility, and useAppLock holds approvals, in both cases.
  const locked = view !== 'screens';
  const lockValue = React.useMemo(() => ({ locked }), [locked]);

  return (
    <LockStateContext.Provider value={lockValue}>
      <View key={`profile-${profileKey}`} style={styles.fill}>
        {/*
          The screens stay MOUNTED under the lock (their state survives), but
          while locked they are removed from the accessibility tree, so a
          screen reader cannot read balances or addresses behind the lock
          screen. Documented props (reactnative.dev/docs/accessibility, and
          the installed react-native 0.86.3 types in
          Libraries/Components/View/ViewAccessibility.d.ts):
          importantForAccessibility="no-hide-descendants" makes Android's
          accessibility services ignore the view and all of its children;
          accessibilityElementsHidden makes VoiceOver on iOS ignore the view
          and every element it contains. This wrapper is always rendered
          (locked or not), so locking never changes the element tree above
          the screens and never remounts them.

          While locked the wrapper is ALSO display: 'none'. The two props above
          only mark the screens "not important for accessibility"; Android
          still reports such views to a client that asks for them
          (AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS, "views
          that are marked as not important for accessibility via …
          IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS … are reported while
          querying the window content", developer.android.com), which is what
          a full uiautomator dump showed under the lock: the in-app browser's
          bar text and the web view's own nodes. In the installed react-native
          0.86.3, display: 'none' makes Fabric set the native view to
          View.INVISIBLE on Android (SurfaceMountingManager.kt updateLayout)
          and hidden = YES on iOS (UIView+ComponentViewProtocol.mm); Android's
          ViewGroup lists only VISIBLE children for accessibility
          (ViewGroup.java addChildrenForAccessibility, AOSP main), so nothing
          under the lock is reported at all. The views stay mounted — React
          state, native views and the in-app browser's page are kept, and
          only hidden.
        */}
        <View
          style={locked ? styles.hiddenWhileLocked : styles.fill}
          importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}
          accessibilityElementsHidden={locked}
        >
          {children}
        </View>
        {locked ? (
          view === 'lock' ? (
            <View style={[styles.overlay, { backgroundColor: theme.background }]}>
              <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}><T>Shiba Wallet is locked</T></Text>
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                <T>{lockScreenHint(reconciled.startedLocked)}</T>
              </Text>
              {appPinOn && lockKind === 'phr' ? (
                // A passphrase lock (docs/DURESS_WALLET.md section 8.2.8): one
                // text field instead of the pad, the same words whichever
                // wallet the passphrase would open.
                <PassphraseField
                  key={awaitingPin ? 'launch' : 'return'}
                  prompt={lockCopy('phr').lockScreenPrompt}
                  submitLabel="Unlock"
                  onComplete={unlockWithAppPin}
                />
              ) : appPinOn ? (
                // The same words and the same pad whichever wallet the PIN
                // would open (docs/DURESS_WALLET.md section 6.5).
                <PinPad key={awaitingPin ? 'launch' : 'return'} prompt={PIN_PAD_TITLE} onComplete={unlockWithAppPin} />
              ) : (
                <>
                  <Button title="Unlock" onPress={() => void unlock()} style={styles.button} />
                  {unlockError ? (
                    <Text style={[styles.error, { color: theme.danger }]}>{unlockError}</Text>
                  ) : null}
                </>
              )}
            </View>
          ) : (
            // The launch decision is pending (the stored auto-lock choice is
            // not read yet): a neutral cover like the app's own loading view.
            <View style={[styles.overlay, { backgroundColor: theme.background }]}>
              <ActivityIndicator size="large" color={theme.accent} />
            </View>
          )
        ) : null}
      </View>
    </LockStateContext.Provider>
  );
}

/**
 * The app PIN pad (duress wallet Stage 2): ten digit keys and a delete key
 * drawn by the app — never the system keyboard, which third-party keyboards
 * may learn from (docs/DURESS_WALLET.md section 2.3 item 6). Used by the
 * lock screen and by Settings → Privacy (set, change and remove a PIN).
 *
 *  - The typed digits are held only while they are being typed: when the
 *    sixth digit is entered they are copied into the call and the state is
 *    cleared BEFORE `onComplete` runs; nothing else keeps or logs them.
 *  - Screen capture is blocked while a pad is shown, whatever the app-wide
 *    Privacy switch says (expo-screen-capture 57.0.4
 *    usePreventScreenCapture, which takes an optional key string,
 *    build/ScreenCapture.d.ts:43,
 *    with its own key 'pin-pad', so the app-wide key and the seed screens'
 *    keys are not affected).
 *  - Screen readers: every key is a button named "Digit N" / "Delete the
 *    last digit" (Pressable accessibilityRole / accessibilityLabel /
 *    accessibilityState, react-native 0.86.3
 *    Libraries/Components/View/ViewAccessibility.d.ts:33, :44, :48); the
 *    progress line is spoken as "N of 6 digits entered" (never the digits),
 *    and the message line is a polite live region on Android
 *    (accessibilityLiveRegion, ViewAccessibility.d.ts:245). Nothing it
 *    says depends on which wallet a PIN would open.
 *  - A wait after too many wrong PINs (../wallet/pin.ts) is counted down on
 *    the message line, once a second, from the time stamped in the PIN
 *    record when the failed attempt ended ("Wrong PIN. Try again in 30
 *    seconds." … "Too many wrong PINs. Try again in 12 seconds."), until it
 *    has run out. The keys stay usable: a PIN typed during the wait is
 *    refused at once, with no hash computed and nothing counted.
 */
export type PinPadAnswer = string | { countdown: PinCountdown } | null;

export function PinPad({
  prompt,
  onComplete,
}: {
  prompt: string;
  /** Called with the 6 digits; returns the sentence to show, or a wait to count down (null = accepted). */
  onComplete: (pin: string) => Promise<PinPadAnswer>;
}) {
  usePreventScreenCapture('pin-pad');
  const theme = useTheme();
  // Localisation (phase 22 item 6): the same words in both wallets, in the
  // device-wide language (i18n/language-store.ts).
  const { t, tx, localize } = useI18n();
  const [digits, setDigits] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<PinCountdown | null>(null);
  // The clock the countdown is read against: set when an answer arrives and
  // then once a second while the wait runs (never read during rendering).
  const [clock, setClock] = useState(0);
  const [countdownFrom, setCountdownFrom] = useState(0);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!countdown) return undefined;
    const timer = setInterval(() => {
      const t = Date.now();
      setClock(t);
      if (t >= countdown.until) clearInterval(timer);
    }, PIN_COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [countdown]);

  const press = (key: string) => {
    if (busy) return;
    if (key === 'delete') {
      setDigits((d) => d.slice(0, -1));
      return;
    }
    const next = (digits + key).slice(0, PIN_LENGTH);
    if (next.length < PIN_LENGTH) {
      setDigits(next);
      return;
    }
    // Sixth digit: the state forgets the PIN before the check runs.
    setDigits('');
    setBusy(true);
    setMessage(null);
    setCountdown(null);
    onComplete(next).then(
      (result) => {
        if (!mounted.current) return;
        setBusy(false);
        if (result !== null && typeof result === 'object') {
          const t = Date.now();
          setClock(t);
          setCountdownFrom(t);
          setCountdown(result.countdown);
          setMessage(null);
        } else {
          setMessage(result);
        }
      },
      () => {
        if (!mounted.current) return;
        setBusy(false);
        setMessage(tx('The PIN could not be checked. Try again.'));
      },
    );
  };
  const line = countdown ? pinCountdownText(countdown, clock) : message;
  // A screen reader hears the wait once when it starts and once when it has
  // run out, not every second: the live region is off between the two.
  const ticking = countdown !== null && clock !== countdownFrom && clock < countdown.until;

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'delete'];
  const dots = Array.from({ length: PIN_LENGTH }, (_, i) => (i < digits.length ? '●' : '○')).join(' ');
  return (
    <View style={styles.pad}>
      <Text style={[styles.padPrompt, { color: theme.text }]}>{localize(prompt)}</Text>
      <Text
        accessibilityLabel={t('lock.digitsEntered', { count: digits.length, total: PIN_LENGTH })}
        style={[styles.padDots, { color: theme.text }]}
      >
        {dots}
      </Text>
      <View style={styles.padGrid}>
        {keys.map((k, i) =>
          k === '' ? (
            <View key={`blank-${i}`} style={styles.padKey} importantForAccessibility="no" accessibilityElementsHidden />
          ) : (
            <Pressable
              key={k}
              accessibilityRole="button"
              accessibilityLabel={k === 'delete' ? tx('Delete the last digit') : t('lock.digit', { digit: k })}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => press(k)}
              style={({ pressed }) => [
                styles.padKey,
                { borderColor: theme.controlBorder, backgroundColor: pressed ? theme.border : theme.card },
              ]}
            >
              <Text style={[styles.padKeyText, { color: theme.text }]}>{k === 'delete' ? '⌫' : k}</Text>
            </Pressable>
          ),
        )}
      </View>
      {busy ? <ActivityIndicator color={theme.accent} accessibilityLabel={tx('Checking the PIN')} /> : null}
      <Text accessibilityLiveRegion={ticking ? 'none' : 'polite'} style={[styles.error, { color: theme.danger }]}>
        {line === null ? '' : localize(line)}
      </Text>
    </View>
  );
}

/** How often the PinPad re-reads a running wait. */
export const PIN_COUNTDOWN_TICK_MS = 1000;

/**
 * The passphrase field (docs/DURESS_WALLET.md section 8.2.8): the lock
 * screen's input when the app lock is a passphrase, and the Settings flows'
 * input for a passphrase. The same contract as the PinPad: `onComplete`
 * gets the typed text and returns the sentence to show, a wait to count
 * down, or null (accepted).
 *
 *  - The text is held only while it is typed: on submit it is copied into
 *    the call and the state is cleared BEFORE `onComplete` runs; nothing
 *    else keeps or logs it.
 *  - Screen capture is blocked with the PinPad's own key 'pin-pad',
 *    whatever the app-wide switch says (expo-screen-capture 57.0.4
 *    build/ScreenCapture.d.ts:43).
 *  - Input hygiene — the same props as the private-key import
 *    (screens/ImportKeyScreen.tsx), each in the installed react-native
 *    0.86.3 Libraries/Components/TextInput/TextInput.d.ts:
 *    secureTextEntry (:951; on Android the input type
 *    TYPE_TEXT_VARIATION_PASSWORD, ReactAndroid … textinput/
 *    ReactTextInputManager.kt:687–699), autoCorrect={false} (:744),
 *    spellCheck={false} (:211), autoComplete="off" (:668, the value
 *    'off' at :737), importantForAutofill="no" (:391), textContentType=
 *    "none" (:269), autoCapitalize="none" (:588), contextMenuHidden (:794,
 *    no paste menu; a keyboard's own clipboard strip may still insert text
 *    — unverified), maxLength (:827) only as a typing guard set generously
 *    (256), because whether React Native counts it in UTF-16 units or code
 *    points on Android was not checked; the 128-code-point rule is enforced
 *    in ../wallet/pin.ts. React Native 0.86.3 has NO prop for Android's
 *    "no personalised learning" keyboard flag (IME_FLAG_NO_PERSONALIZED_LEARNING
 *    appears nowhere in its Android text-input sources), so none is set:
 *    whether a keyboard learns from a password field is the keyboard's
 *    choice.
 *  - No "Show" toggle: section 8.2.8 lists shoulder-surfing as a cost and
 *    designs no way to show the text, and a shown field is no longer a
 *    password field for the keyboard.
 *  - The field is named by its visible prompt (useFieldLabels); the
 *    countdown and the message line are the PinPad's.
 */
export function PassphraseField({
  prompt,
  submitLabel,
  onComplete,
}: {
  prompt: string;
  submitLabel: string;
  onComplete: (passphrase: string) => Promise<PinPadAnswer>;
}) {
  usePreventScreenCapture('pin-pad');
  const theme = useTheme();
  const { tx, localize } = useI18n();
  const fieldLabel = useFieldLabels();
  const field = fieldLabel('lock-passphrase', prompt);
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<PinCountdown | null>(null);
  const [clock, setClock] = useState(0);
  const [countdownFrom, setCountdownFrom] = useState(0);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!countdown) return undefined;
    const timer = setInterval(() => {
      const t = Date.now();
      setClock(t);
      if (t >= countdown.until) clearInterval(timer);
    }, PIN_COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [countdown]);

  const submit = () => {
    if (busy || text.length === 0) return;
    const value = text;
    // The state forgets the passphrase before the check runs.
    setText('');
    setBusy(true);
    setMessage(null);
    setCountdown(null);
    onComplete(value).then(
      (result) => {
        if (!mounted.current) return;
        setBusy(false);
        if (result !== null && typeof result === 'object') {
          const t = Date.now();
          setClock(t);
          setCountdownFrom(t);
          setCountdown(result.countdown);
          setMessage(null);
        } else {
          setMessage(result);
        }
      },
      () => {
        if (!mounted.current) return;
        setBusy(false);
        setMessage(tx('The passphrase could not be checked. Try again.'));
      },
    );
  };
  const line = countdown ? pinCountdownText(countdown, clock) : message;
  const ticking = countdown !== null && clock !== countdownFrom && clock < countdown.until;

  return (
    <View style={styles.pad}>
      <Text {...field.label} style={[styles.padPrompt, { color: theme.text }]}>{field.text}</Text>
      <TextInput
        {...field.input}
        value={text}
        onChangeText={setText}
        onSubmitEditing={submit}
        returnKeyType="done"
        editable={!busy}
        secureTextEntry
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        autoCapitalize="none"
        contextMenuHidden
        maxLength={256}
        style={[styles.passphraseInput, { color: theme.text, backgroundColor: theme.card, borderColor: theme.controlBorder }]}
      />
      <Button title={submitLabel} onPress={submit} disabled={busy || text.length === 0} style={styles.button} />
      {busy ? <ActivityIndicator color={theme.accent} accessibilityLabel={localize(lockCopy('phr').checking)} /> : null}
      <Text accessibilityLiveRegion={ticking ? 'none' : 'polite'} style={[styles.error, { color: theme.danger }]}>
        {line === null ? '' : localize(line)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  hiddenWhileLocked: {
    flex: 1,
    display: 'none',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  hint: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  button: {
    alignSelf: 'stretch',
    marginTop: 8,
  },
  error: {
    fontSize: 13,
    textAlign: 'center',
  },
  pad: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 12,
  },
  padPrompt: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  padDots: {
    fontSize: 22,
    letterSpacing: 4,
  },
  padGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    width: 264,
    gap: 12,
  },
  padKey: {
    width: 72,
    height: 56,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  padKeyText: {
    fontSize: 22,
    fontWeight: '600',
  },
  passphraseInput: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
});

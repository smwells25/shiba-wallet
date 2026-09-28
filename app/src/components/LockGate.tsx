import React, { useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { useWallet } from '../wallet/WalletContext';
import { localAuthAvailable, requireLocalAuth } from '../wallet/biometric';
import { INITIAL_LOCK_STATE, reduceLock, type LockState } from '../wallet/lock';

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
 *  - the device can actually prompt (localAuthAvailable — otherwise the
 *    setting is hidden in Settings and this gate stays inert).
 *
 * The lock decision itself is the pure reducer in ../wallet/lock.ts,
 * exercised transition-by-transition in scripts/check-devmode.mjs; this
 * component only feeds it AppState events.
 *
 * NOTE: the OS biometric prompt itself fires 'inactive'/'background'
 * AppState events on some platforms. That is harmless here: the away
 * timer those events start is cleared on the next 'active', and a lock
 * only triggers when the away time actually reached the threshold.
 */
export function LockGate({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const { status } = useWallet();
  const { autoLockMs } = usePrefs();
  const [available, setAvailable] = useState(false);
  const [lock, setLock] = useState<LockState>(INITIAL_LOCK_STATE);
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

  const armed = status === 'ready' && available && autoLockMs !== null;

  useEffect(() => {
    if (!armed) {
      // Disarming (threshold set to off, wallet wiped) also clears any
      // pending timer so a later re-arm starts fresh.
      setLock(INITIAL_LOCK_STATE);
      return;
    }
    const subscription = AppState.addEventListener('change', (nextStatus) => {
      setLock((prev) =>
        reduceLock(prev, { type: 'app-state', status: nextStatus, now: Date.now() }, autoLockMs),
      );
    });
    return () => subscription.remove();
  }, [armed, autoLockMs]);

  const unlock = async () => {
    if (unlockBusy.current) return;
    unlockBusy.current = true;
    setUnlockError(null);
    try {
      const outcome = await requireLocalAuth('Unlock Shiba Wallet');
      if (outcome.ok) {
        // gated:false means biometrics/enrollment vanished while locked;
        // requireLocalAuth's documented matrix proceeds ungated there (the
        // OS device lock remains the real protection), so the overlay
        // lifts rather than bricking the wallet.
        setLock((prev) => reduceLock(prev, { type: 'unlock' }, autoLockMs));
      } else {
        setUnlockError(outcome.message);
      }
    } finally {
      unlockBusy.current = false;
    }
  };

  return (
    <View style={styles.fill}>
      {children}
      {armed && lock.locked ? (
        <View style={[styles.overlay, { backgroundColor: theme.background }]}>
          <Text style={[styles.title, { color: theme.text }]}>Shiba Wallet is locked</Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            The app locked itself after being in the background. Your keys
            never left the device's secure storage.
          </Text>
          <Button title="Unlock" onPress={() => void unlock()} style={styles.button} />
          {unlockError ? (
            <Text style={[styles.error, { color: theme.danger }]}>{unlockError}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
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
});

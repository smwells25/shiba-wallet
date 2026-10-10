import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Switch, Text, View } from 'react-native';
import { NavigationContainerRefContext, useFocusEffect, type NavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from '../navigation';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { EVM_CHAIN_ID } from '../wallet/send';
import { loadSessions } from '../wallet/sessions';
import { readRecurringDueStates } from '../wallet/recurring';
import { listFoundTakeoverApprovals } from '../wallet/inheritance';
import {
  NOTIFICATIONS_LIMITS_NOTE,
  NOTIFICATIONS_PRIVACY_NOTE,
  NOTIFICATIONS_SECTION_TITLE,
  NOTIFICATIONS_SWITCH_LABEL,
  NOTIFICATIONS_WHAT_NOTE,
  appNotifications,
  describeNotificationError,
  describeNotificationsStatus,
  screenFromNotificationData,
  type NotificationScreen,
  type NotificationsStatus,
} from '../wallet/notifications';
import { readStatusNow, useOnAppActive } from './RecurringDueBanner';

/** How often the found-takeover list is re-read while the Inheritance screen is in front (marks results seen). */
const LOOKING_POLL_MS = 3_000;
/** Re-reads after leaving the Inheritance screen, for a check that finishes after the user left. */
const AFTER_LEAVE_REREADS_MS = [20_000, 60_000] as const;

/**
 * Local reminders (phase 17 item 2; ../wallet/notifications.ts). Mounted
 * once inside the navigation container (App.tsx), next to the recurring
 * banner. Renders nothing. With the preference off it does nothing at all
 * (the notification module is not even loaded), except cancelling what an
 * earlier "on" may have left scheduled.
 *
 * With it on:
 *  - on start, on every return to the foreground and after leaving the
 *    Sessions screen it reads the recurring payments' on-chain status the
 *    way the banner does (read-only; no key, no bundler) and (re)schedules
 *    one reminder per payment at the moment its next payment falls due;
 *  - when the app goes to the background and on every screen change it
 *    cancels reminders of payments that were revoked or forgotten (local
 *    data only) and announces takeover attempts found by the Inheritance
 *    screen's check that the user has not seen;
 *  - a tapped notification opens Sessions or Inheritance.
 * When the wallet is wiped (status 'no-wallet') every reminder is cancelled.
 */
export function NotificationScheduler() {
  const nav = useContext(NavigationContainerRefContext) as NavigationContainerRef<RootStackParamList> | undefined;
  const { status, accounts, activeAccount } = useWallet();
  const { ready, notifications, evmChain, setNotifications } = usePrefs();
  const owner = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const canPay = status === 'ready' && owner !== null && activeAccount !== null && !activeAccount.watchOnly;
  const on = ready && notifications && status === 'ready';
  const chain = evmChain.caip2;

  const routeRef = useRef<string | undefined>(undefined);
  const lookingNow = useCallback(
    () => AppState.currentState === 'active' && routeRef.current === 'Inheritance',
    [],
  );

  // Wipe (or no wallet yet): reminders go off, so a new wallet starts with
  // them off like a fresh install, and the cleanup below cancels everything
  // this wallet scheduled.
  useEffect(() => {
    if (ready && status === 'no-wallet' && notifications) void setNotifications(false).catch(() => undefined);
  }, [ready, status, notifications, setNotifications]);

  // Off: cancel what an earlier "on" may have left scheduled and forget the
  // bookkeeping. The native module is loaded only if something may be scheduled.
  useEffect(() => {
    if (ready && (!notifications || status === 'no-wallet')) void appNotifications().cleanupIfOff().catch(() => undefined);
  }, [ready, notifications, status]);

  const observeTakeovers = useCallback(
    async (looking: boolean) => {
      if (!on) return;
      const found = await listFoundTakeoverApprovals();
      await appNotifications().observeTakeovers({ enabled: true, found, looking });
    },
    [on],
  );

  /** No network: cancels reminders whose payment was revoked or forgotten. */
  const localRecurringPass = useCallback(async () => {
    if (!on) return;
    const { records } = await loadSessions();
    await appNotifications().syncRecurring({ enabled: true, records, states: [] });
  }, [on]);

  /** Reads the on-chain status (read-only, as the banner does) and schedules. */
  const fullSync = useCallback(async () => {
    if (!on) return;
    await observeTakeovers(lookingNow());
    if (canPay && owner !== null) {
      const { records, states } = await readRecurringDueStates({ chain, owner, readStatus: readStatusNow });
      await appNotifications().syncRecurring({ enabled: true, records, states });
    } else {
      await localRecurringPass();
    }
  }, [on, canPay, owner, chain, observeTakeovers, lookingNow, localRecurringPass]);

  useEffect(() => {
    void fullSync().catch(() => undefined);
  }, [fullSync]);
  useOnAppActive(useCallback(() => void fullSync().catch(() => undefined), [fullSync]), on);

  // Going to the background: local passes only (the network may be cut).
  useEffect(() => {
    if (!on) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        void observeTakeovers(false).catch(() => undefined);
        void localRecurringPass().catch(() => undefined);
      }
    });
    return () => sub.remove();
  }, [on, observeTakeovers, localRecurringPass]);

  // Screen changes.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    if (!on || !nav) return undefined;
    routeRef.current = nav.isReady() ? nav.getCurrentRoute()?.name : undefined;
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPoll = () => {
      if (poll === null) poll = setInterval(() => void observeTakeovers(lookingNow()).catch(() => undefined), LOOKING_POLL_MS);
    };
    const stopPoll = () => {
      if (poll !== null) clearInterval(poll);
      poll = null;
    };
    if (routeRef.current === 'Inheritance') startPoll();
    const unsubscribe = nav.addListener('state', () => {
      const previous = routeRef.current;
      const next = nav.getCurrentRoute()?.name;
      if (previous === next) return;
      if (previous === 'Inheritance') {
        // What the screen showed while it was in front counts as seen.
        void observeTakeovers(AppState.currentState === 'active').catch(() => undefined);
      }
      routeRef.current = next;
      if (next === 'Inheritance') {
        startPoll();
      } else {
        stopPoll();
        if (previous === 'Inheritance') {
          for (const ms of AFTER_LEAVE_REREADS_MS) {
            timers.current.push(setTimeout(() => void observeTakeovers(lookingNow()).catch(() => undefined), ms));
          }
        }
      }
      if (previous === 'Sessions') void fullSync().catch(() => undefined);
      else void localRecurringPass().catch(() => undefined);
    });
    const pending = timers.current;
    return () => {
      unsubscribe();
      stopPoll();
      for (const t of pending) clearTimeout(t);
      pending.length = 0;
    };
  }, [on, nav, observeTakeovers, lookingNow, fullSync, localRecurringPass]);

  // A tapped notification opens its screen (also when it launched the app).
  useEffect(() => {
    if (!on || !nav) return undefined;
    let cancelled = false;
    let subscription: { remove(): void } | null = null;
    const open = (screen: NotificationScreen) => {
      const go = () => {
        if (!cancelled) nav.navigate(screen);
      };
      if (nav.isReady()) go();
      else {
        const off = nav.addListener('ready', () => {
          off();
          go();
        });
      }
    };
    appNotifications()
      .native()
      .then(
        (native) => {
          if (cancelled) return;
          const handle = (data: unknown) => {
            const screen = screenFromNotificationData(data);
            try {
              native.clearLastResponse();
            } catch {
              // Clearing is best effort; the screen is still opened once.
            }
            if (screen) open(screen);
          };
          const last = native.lastResponseData();
          if (last !== null && last !== undefined) handle(last);
          subscription = native.onResponse(handle);
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [on, nav]);

  return null;
}

/**
 * Settings → Privacy → Notifications (the switch, what is scheduled, and
 * that nothing leaves the device). Turning it on asks for the system
 * permission the first time; a refusal keeps it off and says how to allow it.
 */
export function NotificationSettingsSection() {
  const theme = useTheme();
  const { notifications, setNotifications } = usePrefs();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<NotificationsStatus | null>(() => appNotifications().status());
  useEffect(() => appNotifications().subscribe(() => setStatus(appNotifications().status())), []);

  // Whenever Settings shows while reminders are on: is the permission still granted?
  useFocusEffect(
    useCallback(() => {
      if (!notifications) return;
      let cancelled = false;
      appNotifications()
        .permission()
        .then((p) => {
          if (!cancelled && p && !p.granted) setStatus({ state: 'blocked' });
        }, () => undefined);
      return () => {
        cancelled = true;
      };
    }, [notifications]),
  );

  const onToggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (next) {
        const outcome = await appNotifications().enable({ found: await listFoundTakeoverApprovals() });
        if (outcome.ok) await setNotifications(true);
      } else {
        await setNotifications(false);
        await appNotifications().disable();
      }
    } catch (e) {
      setStatus({ state: 'failed', detail: describeNotificationError(e) });
    } finally {
      setBusy(false);
    }
  };

  const shown: NotificationsStatus = notifications
    ? status && status.state !== 'off'
      ? status
      : { state: 'on' }
    : status && (status.state === 'blocked' || status.state === 'unavailable' || status.state === 'failed')
      ? status
      : { state: 'off' };
  const bad = shown.state === 'blocked' || shown.state === 'unavailable' || shown.state === 'failed';

  return (
    <View style={styles.block}>
      <Text accessibilityRole="header" style={[styles.subTitle, { color: theme.text }]}>
        {NOTIFICATIONS_SECTION_TITLE}
      </Text>
      <View style={styles.toggleRow}>
        <Text style={[styles.toggleLabel, { color: theme.text }]}>{NOTIFICATIONS_SWITCH_LABEL}</Text>
        <Switch
          accessibilityLabel={NOTIFICATIONS_SWITCH_LABEL}
          accessibilityRole="switch"
          accessibilityState={{ checked: notifications, busy }}
          value={notifications}
          disabled={busy}
          onValueChange={(v) => void onToggle(v)}
        />
      </View>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{NOTIFICATIONS_WHAT_NOTE}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{NOTIFICATIONS_PRIVACY_NOTE}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{NOTIFICATIONS_LIMITS_NOTE}</Text>
      <Text style={[styles.hint, { color: bad ? theme.danger : theme.textMuted }]}>{describeNotificationsStatus(shown)}</Text>
    </View>
  );
}

// Matches SettingsScreen's section, toggle and hint styles.
const styles = StyleSheet.create({
  block: { gap: 12, marginTop: 8 },
  subTitle: { fontSize: 16, fontWeight: '700' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggleLabel: { fontSize: 15, fontWeight: '600', flexShrink: 1, marginRight: 12 },
  hint: { fontSize: 13, lineHeight: 19 },
});

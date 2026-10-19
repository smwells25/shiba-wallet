import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import type { RootStackParamList } from '../navigation';
import { Button } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { fetchPrices } from '../wallet/prices';
import { appNotifications } from '../wallet/notifications';
import { appInbox } from '../wallet/inbox';
import {
  PRICE_ALERT_POLL_MS,
  createPriceAlertMonitor,
  firedAlertText,
  loadPriceAlerts,
  shouldCheckPriceAlerts,
  subscribePriceAlerts,
  updatePriceAlerts,
  type FiredAlert,
} from '../wallet/price-alerts';
import { useOnAppActive } from './RecurringDueBanner';

/**
 * Price alerts (phase 20 item 1, feature 98; ../wallet/price-alerts.ts).
 * Mounted once inside the navigation container (App.tsx), below the screens,
 * next to the recurring-payments banner. It checks the stored alerts:
 *  - when the wallet starts (once the preferences and the wallet are ready),
 *  - every time the wallet returns to the foreground,
 *  - every PRICE_ALERT_POLL_MS while it stays in front,
 * and ONLY while at least one alert is stored and "Show fiat values" is on:
 * with no alert there is no timer and no price request at all. A check asks
 * the shared cached CoinGecko provider for the alerted assets only.
 *
 * When an alert fires it shows a banner here (the alert, the price and its
 * age, "advisory") and, when reminders are on, puts a notification in the
 * phone's list through the reminders' controller (a generic text; see
 * notifications.ts PRICE_ALERT_BODY). It never buys, sells or sends: nothing
 * here can reach a transaction. Shown for every kind of account (alerts are
 * about prices, not about an account), and covered by the lock overlay like
 * every screen.
 */
export function PriceAlertMonitor() {
  const theme = useTheme();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { status } = useWallet();
  const { ready, showFiat, notifications } = usePrefs();
  const [hasAlerts, setHasAlerts] = useState(false);
  const [fired, setFired] = useState<FiredAlert[]>([]);
  // When the banner's alerts were found (the price ages are worded from it).
  const [firedAt, setFiredAt] = useState(0);
  const [active, setActive] = useState(AppState.currentState === 'active');

  // Whether any alert is stored; re-read after every write (the screen's edits and the monitor's own).
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      loadPriceAlerts().then(
        (book) => {
          if (!cancelled) setHasAlerts(shouldCheckPriceAlerts(book));
        },
        () => {
          if (!cancelled) setHasAlerts(false);
        },
      );
    };
    read();
    const off = subscribePriceAlerts(read);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setActive(next === 'active'));
    return () => sub.remove();
  }, []);

  const enabled = ready && showFiat && status === 'ready' && hasAlerts;

  const monitor = useMemo(
    () =>
      createPriceAlertMonitor({
        load: () => loadPriceAlerts(),
        update: (change) => updatePriceAlerts(change),
        fetchQuotes: (ids) => fetchPrices(ids, { enabled: true }),
      }),
    [],
  );

  const check = useCallback(() => {
    if (!enabled) return;
    monitor.check().then(
      ({ fired: list }) => {
        if (list.length === 0) return;
        const at = Date.now();
        setFiredAt(at);
        // One inbox entry per firing (wallet/inbox.ts): the banner below and
        // the phone notification are the same event, recorded here once.
        for (const f of list) {
          void appInbox().record({
            key: `price-alert|${f.alert.id}|${f.alert.firedAt ?? at}`,
            kind: 'price-alert',
            via: 'in-app',
            at,
            title: 'Price alert',
            text: firedAlertText(f, at),
          });
        }
        setFired((prev) => [...list, ...prev.filter((p) => !list.some((l) => l.alert.id === p.alert.id))].slice(0, 3));
        for (const f of list) {
          void appNotifications()
            .presentPriceAlert({ enabled: notifications, alertKey: f.alert.id })
            .catch(() => undefined);
        }
      },
      () => undefined,
    );
  }, [enabled, monitor, notifications]);

  // At start (and whenever checking becomes possible), and on every return to the foreground.
  useEffect(() => {
    check();
  }, [check]);
  useOnAppActive(check, enabled);

  // The bounded poll: only while enabled (an alert exists) and the wallet is in front.
  useEffect(() => {
    if (!enabled || !active) return undefined;
    const id = setInterval(() => {
      if (AppState.currentState === 'active') check();
    }, PRICE_ALERT_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, active, check]);

  if (fired.length === 0 || status !== 'ready') return null;
  const now = firedAt;
  return (
    <View style={[styles.banner, { backgroundColor: theme.card, borderColor: theme.accent }]}>
      {fired.map((f) => (
        <Text key={f.alert.id} accessibilityLiveRegion="polite" style={[styles.text, { color: theme.text }]}>
          {firedAlertText(f, now)}
        </Text>
      ))}
      <View style={styles.buttons}>
        <Button
          title="Open price alerts"
          accessibilityHint="Opens the watchlist and price alerts"
          onPress={() => {
            setFired([]);
            navigation.navigate('PriceAlerts');
          }}
          style={styles.button}
        />
        <Button title="Dismiss" variant="secondary" onPress={() => setFired([])} style={styles.button} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { borderTopWidth: 2, paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  text: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  buttons: { flexDirection: 'row', gap: 8 },
  button: { flex: 1 },
});

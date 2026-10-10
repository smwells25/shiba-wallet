import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { httpTransport } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { EVM_CHAIN_ID } from '../wallet/send';
import { withEndpoint } from '../config/networks';
import { readSubscriptionStatus } from '../wallet/subscriptions';
import {
  findDueRecurringPayments,
  readStatusWithFailover,
  recurringDueHeadline,
  type NodeFailoverRunner,
} from '../wallet/recurring';
import { markNodeErrors, type SessionRecord } from '../wallet/sessions';

/**
 * Runs a node operation on the active EVM endpoint under the shared failover
 * rule (networks.ts withEndpoint → runWithEndpointFailover): when a DEFAULT
 * endpoint fails with an error `isFailure` accepts, the operation is repeated
 * once on the next healthy default. The node transport marks its errors
 * (sessions.ts markNodeErrors) so a payment's node failures can be told from
 * the bundler's. Used for recurring payments by this banner and the Sessions
 * screen; the bundler is never failed over.
 */
export const activeEvmNodeRunner: NodeFailoverRunner = (operation, options) =>
  withEndpoint(EVM_CHAIN_ID, (endpoint) => operation(markNodeErrors(httpTransport(endpoint.url))), options).then(
    (outcome) => outcome.value,
  );

/**
 * Read-only status read on the active EVM endpoint; a read the endpoint did
 * not answer is repeated once on the next healthy default (recurring.ts
 * readStatusWithFailover). Before, readSubscriptionStatus turned the failure
 * into an 'unknown' answer, so withEndpoint never saw an error to fail over on.
 * Exported for the local reminders (NotificationScheduler.tsx), which read
 * the same status the same way.
 */
export function readStatusNow(record: SessionRecord) {
  return readStatusWithFailover(activeEvmNodeRunner, (node) => readSubscriptionStatus(node, record));
}

/**
 * Calls `callback` every time the app returns to the foreground (AppState
 * 'active'), while `enabled`. The latest callback is used without
 * re-subscribing. Shared by this banner and the Sessions screen.
 */
export function useOnAppActive(callback: () => void, enabled = true): void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);
  useEffect(() => {
    if (!enabled) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') latest.current();
    });
    return () => sub.remove();
  }, [enabled]);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The current time in unix seconds, refreshed every `intervalMs` while
 * `enabled`, right after it becomes enabled, and whenever the app returns to
 * the foreground (timers do not run while the app is in the background).
 * Lets a screen re-evaluate time-dependent state (a payment that became due)
 * from facts it already read, without a network request (finding 2 of the
 * 2026-10-09 recurring-payments rehearsal).
 */
export function useClockTick(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(nowSeconds);
  const update = useCallback(() => setNow(nowSeconds()), []);
  useOnAppActive(update, enabled);
  useEffect(() => {
    if (!enabled) return undefined;
    const first = setTimeout(update, 0);
    const id = setInterval(update, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [enabled, intervalMs, update]);
  return now;
}

/**
 * The foreground check for recurring payments (phase 15 item 1). Mounted once
 * inside the navigation container (App.tsx), below the screens. When the
 * wallet starts, and every time it returns to the foreground, it asks
 * ../wallet/recurring findDueRecurringPayments which recurring payments of
 * the active account on the active EVM network are due, and if any are,
 * shows a short banner whose button opens the Sessions screen, where each due
 * payment is sent only after the user confirms it.
 *
 * It NEVER sends anything: findDueRecurringPayments has no key vault and no
 * bundler, and this component has no path to a payment (a check script pins
 * that). With no recurring payment on this device it makes no network
 * request. Hidden for a watch-only account (nothing can be signed) and while
 * no wallet exists; the lock overlay covers it like every screen.
 */
export function RecurringDueBanner() {
  const theme = useTheme();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { status, accounts, activeAccount } = useWallet();
  const { evmChain } = usePrefs();
  const owner = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const eligible = status === 'ready' && owner !== null && activeAccount !== null && !activeAccount.watchOnly;
  // Each return to the foreground starts a new check (and shows a dismissed banner again).
  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<{ key: string; count: number } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const checkKey = `${evmChain.caip2}|${owner ?? ''}|${generation}`;

  useOnAppActive(useCallback(() => setGeneration((g) => g + 1), []));

  useEffect(() => {
    if (!eligible || owner === null) return undefined;
    let cancelled = false;
    findDueRecurringPayments({ chain: evmChain.caip2, owner, readStatus: readStatusNow }).then(
      ({ due }) => {
        if (!cancelled) setResult({ key: checkKey, count: due.length });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [eligible, owner, evmChain.caip2, checkKey]);

  const headline = eligible && result && result.key === checkKey ? recurringDueHeadline(result.count) : null;
  if (!headline || dismissed === checkKey) return null;
  return (
    <View style={[styles.banner, { backgroundColor: theme.card, borderColor: theme.accent }]}>
      <Text accessibilityLiveRegion="polite" style={[styles.text, { color: theme.text }]}>
        {headline}
      </Text>
      <View style={styles.buttons}>
        <Button
          title="Review"
          accessibilityHint="Opens the Sessions screen, where each due payment is sent only after you confirm it."
          onPress={() => {
            setDismissed(checkKey);
            navigation.navigate('Sessions');
          }}
          style={styles.button}
        />
        <Button title="Not now" variant="secondary" onPress={() => setDismissed(checkKey)} style={styles.button} />
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

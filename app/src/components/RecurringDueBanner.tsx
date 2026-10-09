import React, { useEffect, useState } from 'react';
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
import { findDueRecurringPayments, recurringDueHeadline } from '../wallet/recurring';
import type { SessionRecord } from '../wallet/sessions';

/** Read-only status read on the active EVM endpoint (failover rule of networks.ts withEndpoint). */
async function readStatusNow(record: SessionRecord) {
  const { value } = await withEndpoint(EVM_CHAIN_ID, (endpoint) => readSubscriptionStatus(httpTransport(endpoint.url), record));
  return value;
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

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') setGeneration((g) => g + 1);
    });
    return () => sub.remove();
  }, []);

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

import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, WatchOnlyNotice, screenStyle } from '../components';
import { useI18n } from '../i18n/useI18n';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { useWallet } from '../wallet/WalletContext';
import { appLockKind, appPinPresence } from '../wallet/duress';
import { storageProtection } from '../wallet/storage';
import { loadPendingRegistry } from '../wallet/pending-transactions';
import { listSpendingScopes } from '../wallet/spending-policy';
import { loadPriceAlerts } from '../wallet/price-alerts';
import { activeStoreProfile } from '../wallet/store-keys';
import { multisigRouteRefusal, watchOnlyRouteRefusal } from '../wallet/watch-only';
import { peekEndpointHealth } from '../config/networks';
import { EVM_CHAIN_ID } from '../wallet/send';
import {
  buildInsightSections,
  latestApprovalsSnapshot,
  latestPortfolioSnapshot,
  portfolioSnapshotKey,
  readInsights,
  type InsightLink,
  type InsightReads,
  type InsightSection,
} from '../wallet/insights';

type Props = NativeStackScreenProps<RootStackParamList, 'Insights'>;

/** The route each "see <screen>" link opens. */
const LINK_ROUTES: Record<InsightLink, keyof RootStackParamList> = {
  Portfolio: 'Portfolio',
  Approvals: 'Approvals',
  Activity: 'Activity',
  Endpoints: 'Settings',
  SpendingLimits: 'SpendingLimits',
  PriceAlerts: 'PriceAlerts',
};

/**
 * Portfolio insights and risk overview (phase 25 item 2, feature 99). Read
 * only, and it makes no network request: every line comes from
 * ../wallet/insights.ts out of what the wallet already read or stored (the
 * Portfolio and Approvals screens' last readings in this session, the stored
 * pending list, limits and alerts, the endpoint check this session already
 * made, the account list and the preferences). Nothing here can sign or send.
 */
export function InsightsScreen({ navigation }: Props) {
  const theme = useTheme();
  // Subscribing re-renders the screen when the language changes; the
  // sections are built in render, so every t() runs again.
  const { t } = useI18n();
  const { hideAmounts, evmChain, solanaDevnet, autoLockMs } = usePrefs();
  const { accounts, activeAccount, accountList, watchOnlyAccounts, multisigAccounts } = useWallet();
  const lockOn = useSyncExternalStore(appPinPresence.subscribe, appPinPresence.get);
  const lockKind = useSyncExternalStore(appLockKind.subscribe, appLockKind.get);

  const [reads, setReads] = useState<InsightReads | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    () =>
      readInsights({
        protection: storageProtection,
        pending: () => loadPendingRegistry(),
        spendingScopes: () => listSpendingScopes(),
        priceAlerts: () => loadPriceAlerts(),
        endpoints: () => peekEndpointHealth(),
      }).then((next) => {
        setReads(next);
        setNow(Date.now());
      }),
    [],
  );
  // Read again on every visit: a Portfolio or Approvals reading made in
  // between, or a pending entry settled by Activity, shows at once. The
  // readers never reject (readInsights settles each one).
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const onRefresh = () => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  };

  const owner = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const profile = activeStoreProfile().id;
  const portfolioKey = portfolioSnapshotKey([...accountList, ...watchOnlyAccounts, ...multisigAccounts], evmChain.caip2);

  const sections: InsightSection[] | null = reads
    ? buildInsightSections({
        reads,
        portfolio: latestPortfolioSnapshot(profile, portfolioKey),
        approvals: owner ? latestApprovalsSnapshot(profile, evmChain.caip2, owner) : null,
        ctx: {
          hidden: hideAmounts,
          nowMs: now,
          profile,
          portfolioKey,
          evm: { caip2: evmChain.caip2, label: evmChain.label, testnet: evmChain.testnet },
          solanaDevnet,
          account: activeAccount ? { name: activeAccount.name, evmAddress: owner } : null,
          counts: {
            watched: watchOnlyAccounts.length,
            imported: accountList.filter((a) => a.imported).length,
            multisig: multisigAccounts.length,
            hidden: accountList.filter((a) => a.hidden).length,
          },
          appLock: { on: lockOn, kind: lockKind },
          autoLockMs,
        },
      })
    : null;

  // A link is offered only where the active account may open that screen
  // (the route gate would refuse it otherwise).
  const linkAllowed = (route: string): boolean =>
    activeAccount?.watchOnly
      ? watchOnlyRouteRefusal(route) === null
      : activeAccount?.multisig
        ? multisigRouteRefusal(route) === null
        : true;
  const linkTitle: Record<InsightLink, string> = {
    Portfolio: t('insights.link.portfolio'),
    Approvals: t('insights.link.approvals'),
    Activity: t('insights.link.activity'),
    Endpoints: t('insights.link.endpoints'),
    SpendingLimits: t('insights.link.limits'),
    PriceAlerts: t('insights.link.alerts'),
  };
  const open = (link: InsightLink) => {
    if (link === 'Endpoints') navigation.navigate('Settings', { section: 'network-endpoints' });
    else if (link === 'Activity') navigation.navigate('Activity', { chainId: EVM_CHAIN_ID });
    else if (link === 'Portfolio') navigation.navigate('Portfolio');
    else if (link === 'Approvals') navigation.navigate('Approvals');
    else if (link === 'SpendingLimits') navigation.navigate('SpendingLimits');
    else navigation.navigate('PriceAlerts');
  };

  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.textMuted} colors={[theme.accent]} />}
    >
      {activeAccount?.watchOnly ? <WatchOnlyNotice /> : null}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{t('insights.intro')}</Text>
      {sections === null ? <ActivityIndicator color={theme.textMuted} /> : null}
      {(sections ?? []).map((section) => (
        <View key={section.id} style={styles.section}>
          <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>
            {section.title}
          </Text>
          {section.lines.map((l) => (
            <Text
              key={l.id}
              style={[styles.line, { color: theme.text }]}
              {...(l.spoken !== l.text ? { accessibilityLabel: l.spoken } : {})}
            >
              {l.text}
            </Text>
          ))}
          <Text style={[styles.hint, { color: theme.textMuted }]}>{section.source}</Text>
          {section.link && linkAllowed(LINK_ROUTES[section.link]) ? (
            <Button title={linkTitle[section.link]} variant="secondary" onPress={() => open(section.link!)} />
          ) : null}
          {section.id === 'limits' && linkAllowed('PriceAlerts') ? (
            <Button title={linkTitle.PriceAlerts} variant="secondary" onPress={() => open('PriceAlerts')} />
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 24 },
  section: { gap: 10 },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  line: { fontSize: 15, lineHeight: 21 },
  hint: { fontSize: 13, lineHeight: 19 },
});

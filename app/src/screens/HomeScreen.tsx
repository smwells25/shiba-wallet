import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { screenStyle } from '../components';
import { useTheme } from '../theme';
import { ChainAccount, useWallet } from '../wallet/WalletContext';
import { BalanceState, useBalances } from '../wallet/useBalances';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}

/**
 * Right-hand side of a chain row: the native balance in coin units, a
 * spinner while loading, a subtle tap-to-retry error state, or a muted
 * "unavailable" marker for chains with no configured endpoint. Each chain's
 * state is independent — one endpoint failing never blanks the others.
 */
function BalanceCell({
  state,
  onRetry,
}: {
  state: BalanceState | undefined;
  onRetry: () => void;
}) {
  const theme = useTheme();

  if (!state || state.status === 'loading') {
    return <ActivityIndicator size="small" color={theme.textMuted} />;
  }
  if (state.status === 'ok') {
    return (
      <View style={styles.balanceCell}>
        <Text style={[styles.balance, { color: theme.text }]} numberOfLines={1}>
          {state.display}
        </Text>
        <Text style={[styles.balanceSymbol, { color: theme.textMuted }]}>{state.symbol}</Text>
      </View>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <View style={styles.balanceCell}>
        <Text style={[styles.balance, { color: theme.textMuted }]}>—</Text>
        <Text style={[styles.balanceSymbol, { color: theme.textMuted }]}>no endpoint</Text>
      </View>
    );
  }
  // status === 'error': subtle, retryable. The full message would not fit a
  // row; the row communicates "couldn't load" and offers a retry.
  return (
    <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={8}>
      <View style={styles.balanceCell}>
        <Text style={[styles.balance, { color: theme.textMuted }]}>—</Text>
        <Text style={[styles.balanceSymbol, { color: theme.danger }]}>retry</Text>
      </View>
    </Pressable>
  );
}

/** The four launch chains: address, live native balance, tap to receive. */
export function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts } = useWallet();
  const { balances, refreshing, refreshAll, refreshOne } = useBalances(accounts);

  const renderItem = ({ item }: { item: ChainAccount }) => (
    <Pressable
      accessibilityRole="button"
      onPress={() => navigation.navigate('Receive', { chainId: item.chainId })}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: theme.card,
          borderColor: theme.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <View style={[styles.badge, { backgroundColor: item.accent }]}>
        <Text style={styles.badgeText}>{item.symbol}</Text>
      </View>
      <View style={styles.cardBody}>
        <Text style={[styles.chainName, { color: theme.text }]}>{item.name}</Text>
        <Text style={[styles.address, { color: theme.textMuted }]}>
          {shortAddress(item.address)}
        </Text>
        {/* Nested Pressable: taps here are consumed by the inner handler,
            so the card's own tap (Receive) does not fire. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Send ${item.symbol}`}
          onPress={() => navigation.navigate('Send', { chainId: item.chainId })}
          hitSlop={8}
        >
          <Text style={[styles.sendLink, { color: theme.accent }]}>Send ↗</Text>
        </Pressable>
      </View>
      <BalanceCell
        state={balances[item.chainId]}
        onRetry={() => void refreshOne(item.chainId)}
      />
    </Pressable>
  );

  return (
    <View style={screenStyle(theme)}>
      <FlatList
        data={accounts}
        keyExtractor={(item) => item.chainId}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refreshAll()}
            tintColor={theme.textMuted}
            colors={[theme.accent]}
          />
        }
        ListFooterComponent={
          <Text style={[styles.footer, { color: theme.textMuted }]}>
            Account 0 addresses, derived on this device from your recovery
            phrase. Balances come from the RPC endpoints in Settings; pull
            down to refresh. Tap a chain to receive, or use its Send link.
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    padding: 16,
    gap: 12,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    gap: 14,
  },
  badge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  cardBody: {
    flex: 1,
    gap: 4,
  },
  chainName: {
    fontSize: 17,
    fontWeight: '600',
  },
  address: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  sendLink: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 2,
  },
  balanceCell: {
    alignItems: 'flex-end',
    gap: 2,
    maxWidth: 140,
  },
  balance: {
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  balanceSymbol: {
    fontSize: 12,
  },
  footer: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 16,
  },
});

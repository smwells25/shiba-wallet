import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { screenStyle } from '../components';
import { useTheme } from '../theme';
import { ChainAccount, useWallet } from '../wallet/WalletContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}

/** The four launch chains with their account-0 addresses. Tap to receive. */
export function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts } = useWallet();

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
      </View>
      <Text style={[styles.chevron, { color: theme.textMuted }]}>›</Text>
    </Pressable>
  );

  return (
    <View style={screenStyle(theme)}>
      <FlatList
        data={accounts}
        keyExtractor={(item) => item.chainId}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListFooterComponent={
          <Text style={[styles.footer, { color: theme.textMuted }]}>
            Account 0 addresses, derived on this device from your recovery
            phrase. Tap a chain to receive.
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
  chevron: {
    fontSize: 26,
    fontWeight: '300',
  },
  footer: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 16,
  },
});

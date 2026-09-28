import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { formatAssetId } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { screenStyle } from '../components';
import { useTheme } from '../theme';
import { EVM_CHAIN_ID } from '../wallet/send';
import { ChainAccount, useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { maskAmount } from '../config/prefs';
import { BalanceState, useBalances } from '../wallet/useBalances';
import { useTokenBalances } from '../wallet/useTokenBalances';

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
  hidden = false,
}: {
  state: BalanceState | undefined;
  onRetry: () => void;
  /** Balance privacy (phase 4 item 5.2): mask the amount as ••••. */
  hidden?: boolean;
}) {
  const theme = useTheme();

  if (!state || state.status === 'loading') {
    return <ActivityIndicator size="small" color={theme.textMuted} />;
  }
  if (state.status === 'ok') {
    return (
      <View style={styles.balanceCell}>
        <Text style={[styles.balance, { color: theme.text }]} numberOfLines={1}>
          {maskAmount(state.display, hidden)}
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

/**
 * One tracked ERC-20 token under the Ethereum row: symbol, name, its
 * balance with the exact per-row loading/error/retry discipline of the
 * native rows (BalanceCell is shared), and a Send link into the send
 * screen's token mode (phase 4 item 3).
 */
function TokenRow({
  token,
  state,
  onRetry,
  onSend,
  hidden,
}: {
  token: FungibleAsset;
  state: BalanceState | undefined;
  onRetry: () => void;
  onSend: () => void;
  hidden: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.tokenRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={[styles.tokenBadge, { borderColor: theme.border }]}>
        <Text style={[styles.tokenBadgeText, { color: theme.textMuted }]}>
          {token.symbol.slice(0, 4)}
        </Text>
      </View>
      <View style={styles.cardBody}>
        <Text style={[styles.tokenName, { color: theme.text }]} numberOfLines={1}>
          {token.name}
        </Text>
        <Text style={[styles.tokenKind, { color: theme.textMuted }]}>ERC-20</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Send ${token.symbol}`}
          onPress={onSend}
          hitSlop={8}
        >
          <Text style={[styles.sendLink, { color: theme.accent }]}>Send ↗</Text>
        </Pressable>
      </View>
      <BalanceCell state={state} onRetry={onRetry} hidden={hidden} />
    </View>
  );
}

/** The four launch chains: address, live native balance, tap to receive. */
export function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts } = useWallet();
  const { hideAmounts, setHideAmounts, evmChain } = usePrefs();
  const { balances, refreshing, refreshAll, refreshOne } = useBalances(accounts);
  const evmAccount = accounts.find((a) => a.chainId === EVM_CHAIN_ID);
  // Tracked tokens are Ethereum-mainnet assets; in Sepolia test mode the
  // token section is hidden entirely (fetching a mainnet contract's
  // balanceOf against a Sepolia endpoint would be wrong-chain noise).
  const showTokens = !evmChain.testnet;
  const { tokens, tokenBalances, reloadTokens, refreshToken } = useTokenBalances(
    showTokens ? evmAccount?.address : undefined,
  );

  // Re-read the token list whenever Home regains focus, so tokens added or
  // removed on the Tokens screen appear without an app restart. Balances
  // also re-resolve their endpoints per refresh, so flipping the Sepolia
  // toggle in Settings takes effect on the next focus/refresh.
  useFocusEffect(
    useCallback(() => {
      if (showTokens) void reloadTokens();
    }, [reloadTokens, showTokens]),
  );

  // Re-fetch the EVM balance whenever the active EVM chain flips
  // (mainnet <-> Sepolia), so the row never shows the other mode's number.
  React.useEffect(() => {
    void refreshOne(EVM_CHAIN_ID);
    // refreshOne is stable per accounts; keying on the active chain id is
    // the point of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evmChain.caip2]);

  const renderChainCard = ({ item }: { item: ChainAccount }) => (
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
        {/* Nested Pressables: taps here are consumed by the inner handler,
            so the card's own tap (Receive) does not fire. */}
        <View style={styles.linkRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Send ${item.symbol}`}
            onPress={() => navigation.navigate('Send', { chainId: item.chainId })}
            hitSlop={8}
          >
            <Text style={[styles.sendLink, { color: theme.accent }]}>Send ↗</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name} activity`}
            onPress={() => navigation.navigate('Activity', { chainId: item.chainId })}
            hitSlop={8}
          >
            <Text style={[styles.sendLink, { color: theme.accent }]}>Activity</Text>
          </Pressable>
        </View>
      </View>
      <BalanceCell
        state={balances[item.chainId]}
        onRetry={() => void refreshOne(item.chainId)}
        hidden={hideAmounts}
      />
    </Pressable>
  );

  // The Ethereum row carries its tracked ERC-20 tokens beneath it, plus the
  // entry point to the token management screen.
  const renderItem = ({ item }: { item: ChainAccount }) => {
    const card = renderChainCard({ item });
    if (item.chainId !== EVM_CHAIN_ID) return card;
    if (!showTokens) {
      return (
        <View style={styles.evmGroup}>
          {card}
          <Text style={[styles.testnetNote, { color: theme.textMuted }]}>
            Sepolia test mode — tracked tokens are mainnet assets and are
            hidden until test mode is turned off in Settings.
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.evmGroup}>
        {card}
        <View style={styles.tokenSection}>
          {tokens.map((token) => {
            const id = formatAssetId(token.assetId);
            return (
              <TokenRow
                key={id}
                token={token}
                state={tokenBalances[id]}
                onRetry={() => void refreshToken(id)}
                onSend={() =>
                  navigation.navigate('Send', { chainId: EVM_CHAIN_ID, tokenId: id })
                }
                hidden={hideAmounts}
              />
            );
          })}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Manage tokens"
            onPress={() => navigation.navigate('Tokens')}
            hitSlop={8}
          >
            <Text style={[styles.manageTokens, { color: theme.accent }]}>Manage tokens</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <View style={screenStyle(theme)}>
      <FlatList
        data={accounts}
        keyExtractor={(item) => item.chainId}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          // Quick balance-privacy toggle (the same setting lives in
          // Settings -> Privacy & security); the eye glyph masks every
          // amount on this screen and on Activity as ••••.
          <View style={styles.privacyRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={hideAmounts ? 'Show amounts' : 'Hide amounts'}
              onPress={() => void setHideAmounts(!hideAmounts)}
              hitSlop={8}
            >
              <Text style={[styles.privacyToggle, { color: theme.accent }]}>
                {hideAmounts ? '👁 Show amounts' : '👁 Hide amounts'}
              </Text>
            </Pressable>
          </View>
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void refreshAll();
              void reloadTokens();
            }}
            tintColor={theme.textMuted}
            colors={[theme.accent]}
          />
        }
        ListFooterComponent={
          <Text style={[styles.footer, { color: theme.textMuted }]}>
            Account 0 addresses, derived on this device from your recovery
            phrase. Balances come from the RPC endpoints in Settings; pull
            down to refresh. Tap a chain to receive, or use its Send link —
            tokens have their own Send link and pay their network fee in ETH.
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
  linkRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 2,
  },
  sendLink: {
    fontSize: 14,
    fontWeight: '600',
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
  evmGroup: {
    gap: 8,
  },
  tokenSection: {
    marginLeft: 20,
    gap: 8,
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 12,
  },
  tokenBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tokenBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  tokenName: {
    fontSize: 15,
    fontWeight: '600',
  },
  tokenKind: {
    fontSize: 12,
  },
  manageTokens: {
    fontSize: 14,
    fontWeight: '600',
    paddingVertical: 2,
  },
  testnetNote: {
    fontSize: 12,
    lineHeight: 17,
    marginLeft: 20,
  },
  privacyRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingBottom: 4,
  },
  privacyToggle: {
    fontSize: 13,
    fontWeight: '600',
  },
  footer: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 16,
  },
});

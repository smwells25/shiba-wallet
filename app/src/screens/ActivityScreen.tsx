import React, { useEffect } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { HistoryEntry } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { Button, screenStyle } from '../components';
import { Theme, useTheme } from '../theme';
import { networkDefaultFor } from '../config/defaults';
import { maskAmount } from '../config/prefs';
import { formatUnits } from '../wallet/balances';
import { directionLabel, explorerTxUrl, timestampLabel } from '../wallet/history';
import { EVM_CHAIN_ID } from '../wallet/send';
import { useHistory } from '../wallet/useHistory';
import { usePrefs } from '../wallet/PrefsContext';
import { useWallet } from '../wallet/WalletContext';
import { OfflineNotice } from '../wallet/connectivity';

type Props = NativeStackScreenProps<RootStackParamList, 'Activity'>;

/**
 * Small round badge carrying the direction glyph: down-arrow for received
 * (success color), up-arrow for sent, loop for self-transfers (muted).
 */
function DirectionBadge({ entry, theme }: { entry: HistoryEntry; theme: Theme }) {
  const glyph = entry.direction === 'in' ? '↓' : entry.direction === 'out' ? '↑' : '↺';
  const color =
    entry.direction === 'in' ? theme.success : entry.direction === 'out' ? theme.text : theme.textMuted;
  return (
    <View style={[styles.dirBadge, { borderColor: theme.border }]}>
      <Text style={[styles.dirGlyph, { color }]}>{glyph}</Text>
    </View>
  );
}

function StatusChip({ label, color, theme }: { label: string; color: string; theme: Theme }) {
  return (
    <View style={[styles.chip, { borderColor: color, backgroundColor: theme.card }]}>
      <Text style={[styles.chipText, { color }]}>{label}</Text>
    </View>
  );
}

/**
 * One transaction row: direction badge, label + time + optional fee on the
 * left, signed amount (em-dash when the provider supplied none) and status
 * chips on the right. Tapping opens the chain's verified block explorer;
 * rows stay inert when no explorer is verified (Dogecoin).
 */
function EntryRow({
  entry,
  chainId,
  decimals,
  symbol,
  hidden,
  evmExplorerTxBase,
}: {
  entry: HistoryEntry;
  chainId: string;
  decimals: number;
  symbol: string;
  /** Balance privacy (phase 4 item 5.2): mask amounts and fees as ••••. */
  hidden: boolean;
  /** Active EVM chain's explorer (sepolia.etherscan.io in test mode). */
  evmExplorerTxBase: string;
}) {
  const theme = useTheme();
  const url = explorerTxUrl(chainId, entry.id, evmExplorerTxBase);

  // Token entries carry the asset symbol; when the provider also knows
  // the exact token amount and decimals (log data, indexer raw values),
  // render it in the TOKEN's units — the chain's native decimals never
  // touch non-native amounts. Otherwise fall back to the native amount
  // or an em-dash.
  const rowSymbol = entry.assetSymbol ?? symbol;
  const sign = entry.direction === 'in' ? '+' : entry.direction === 'out' ? '−' : '';
  const amountText =
    entry.assetAmount !== undefined && entry.assetDecimals !== undefined
      ? maskAmount(`${sign}${formatUnits(entry.assetAmount, entry.assetDecimals)}`, hidden)
      : entry.amount === undefined
        ? '—'
        : maskAmount(`${sign}${formatUnits(entry.amount, decimals)}`, hidden);
  const hasAmount = entry.assetAmount !== undefined || entry.amount !== undefined;
  const amountColor =
    entry.failed || !hasAmount
      ? theme.textMuted
      : entry.direction === 'in'
        ? theme.success
        : theme.text;

  // Screen readers get the whole row as one sentence (the label replaces
  // the children's text), so it must carry the amount, time and status.
  const spokenAmount = !hasAmount ? 'no amount' : hidden ? 'amount hidden' : `${amountText} ${rowSymbol}`;
  const spokenStatus = [entry.failed ? 'failed' : null, !entry.confirmed ? 'pending' : null]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      accessibilityRole={url ? 'button' : undefined}
      accessibilityLabel={
        `${directionLabel(entry.direction)} transaction, ${spokenAmount}, ${timestampLabel(entry)}` +
        (spokenStatus ? `, ${spokenStatus}` : '')
      }
      accessibilityHint={url ? 'Opens the transaction in the block explorer' : undefined}
      disabled={!url}
      onPress={() => {
        if (url) void Linking.openURL(url);
      }}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: theme.card,
          borderColor: theme.border,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <DirectionBadge entry={entry} theme={theme} />
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: theme.text }]}>
          {directionLabel(entry.direction)}
        </Text>
        <Text style={[styles.rowTime, { color: theme.textMuted }]}>
          {timestampLabel(entry)}
        </Text>
        {entry.fee !== undefined ? (
          <Text style={[styles.rowFee, { color: theme.textMuted }]}>
            fee {maskAmount(formatUnits(entry.fee, decimals, decimals), hidden)} {symbol}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.amount, { color: amountColor }]} numberOfLines={1}>
          {amountText}
        </Text>
        <Text style={[styles.amountSymbol, { color: theme.textMuted }]}>{rowSymbol}</Text>
        <View style={styles.chips}>
          {entry.failed ? <StatusChip label="failed" color={theme.danger} theme={theme} /> : null}
          {!entry.confirmed ? (
            <StatusChip label="pending" color={theme.warningText} theme={theme} />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** Newest-first transaction list for one chain, entered from a Home row. */
export function ActivityScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const { chainId } = route.params;
  const { accounts, activeAccount } = useWallet();
  const { hideAmounts, evmChain } = usePrefs();
  const account = accounts.find((a) => a.chainId === chainId);
  const network = networkDefaultFor(chainId);
  const { state, refreshing, reload, loadMore } = useHistory(chainId, account?.address ?? '');
  // The EVM slot's symbol/explorer follow the active chain profile
  // (test ETH + sepolia.etherscan.io in Sepolia test mode). useHistory
  // already resolves the endpoint and indexer config through the same
  // active-chain translation in config/networks.ts.
  const isEvmSlot = chainId === EVM_CHAIN_ID;
  const symbol = isEvmSlot ? evmChain.displaySymbol : network?.symbol ?? '';

  useEffect(() => {
    navigation.setOptions({ title: account ? `${account.name} activity` : 'Activity' });
  }, [navigation, account]);

  if (!account || !network) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={[styles.note, { color: theme.textMuted }]}>Unknown chain.</Text>
      </View>
    );
  }

  if (state.status === 'loading') {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={[styles.unavailableMark, { color: theme.textMuted }]}>—</Text>
        <Text style={[styles.note, { color: theme.textMuted }]}>{state.note}</Text>
      </View>
    );
  }

  if (state.status === 'error') {
    // A calm sentence first; the endpoint's own message stays available as
    // muted detail for anyone diagnosing it.
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <OfflineNotice />
        <Text style={[styles.note, { color: theme.text }]}>
          The history could not be loaded right now. Check your connection
          and try again.
        </Text>
        <Text selectable style={[styles.noteDetail, { color: theme.textMuted }]}>
          {state.message}
        </Text>
        <Button title="Retry" onPress={() => void reload()} style={styles.retry} />
      </View>
    );
  }

  // status === 'ok'
  // The tracked-token logs fallback reports how far back it searched; when
  // paging stopped short of block 0 (endpoint refusal or the wallet's own
  // lookback bound), the end of the list is the end of the SEARCHED range,
  // not the end of history.
  const coverage = state.coverage;
  const rangeLimited =
    coverage !== undefined && (coverage.stop === 'refused' || coverage.stop === 'lookback-limit');
  const nothingAnswered = coverage !== undefined && coverage.answeredFromBlock === null;
  const footer = (
    <View style={styles.footer}>
      {state.loadMoreError ? (
        <>
          <Text style={[styles.note, { color: theme.text }]}>
            Older entries could not be loaded. The entries above are unchanged.
          </Text>
          <Text selectable style={[styles.noteDetail, { color: theme.textMuted }]}>
            {state.loadMoreError}
          </Text>
        </>
      ) : null}
      {state.loadingMore ? (
        <ActivityIndicator size="small" color={theme.textMuted} />
      ) : state.nextCursor ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Loads older transactions"
          onPress={() => void loadMore()}
          hitSlop={8}
        >
          <Text style={[styles.loadMore, { color: theme.accent }]}>
            {state.loadMoreError ? 'Try again' : 'Load more'}
          </Text>
        </Pressable>
      ) : state.entries.length > 0 ? (
        <Text style={[styles.note, { color: theme.textMuted }]}>
          {rangeLimited ? 'End of the searched blocks (see the note above).' : 'End of history.'}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={screenStyle(theme)}>
      <OfflineNotice style={styles.notice} />
      {state.note ? (
        <Text style={[styles.note, { color: theme.textMuted }]}>{state.note}</Text>
      ) : null}
      {state.noteDetail ? (
        <Text selectable style={[styles.noteDetail, { color: theme.textMuted }]}>
          {state.noteDetail}
        </Text>
      ) : null}
      <FlatList
        data={state.entries}
        // uid distinguishes several entries born from one EVM transaction
        // (e.g. a token transfer plus an internal native movement).
        keyExtractor={(entry) => entry.uid ?? entry.id}
        renderItem={({ item }) => (
          <EntryRow
            entry={item}
            chainId={chainId}
            decimals={network.decimals}
            symbol={symbol}
            hidden={hideAmounts}
            evmExplorerTxBase={evmChain.explorerTxBase}
          />
        )}
        contentContainerStyle={styles.list}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void reload()}
            tintColor={theme.textMuted}
            colors={[theme.accent]}
          />
        }
        ListHeaderComponent={
          activeAccount ? (
            <Text style={[styles.note, { color: theme.textMuted }]}>
              {activeAccount.name} · {account.address}
            </Text>
          ) : null
        }
        ListEmptyComponent={
          <Text style={[styles.note, { color: theme.textMuted }]}>
            {nothingAnswered
              ? 'No blocks could be searched with the current endpoint.'
              : coverage
                ? 'No tracked-token transfers found in the searched blocks.'
                : 'No transactions found for this address.'}
          </Text>
        }
        ListFooterComponent={footer}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  list: {
    padding: 16,
    gap: 10,
    flexGrow: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  dirBadge: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dirGlyph: {
    fontSize: 18,
    fontWeight: '700',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowTime: {
    fontSize: 12,
  },
  rowFee: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: 2,
    maxWidth: 150,
  },
  amount: {
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  amountSymbol: {
    fontSize: 12,
  },
  chips: {
    flexDirection: 'row',
    gap: 4,
  },
  chip: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  chipText: {
    fontSize: 10,
    fontWeight: '600',
  },
  note: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  noteDetail: {
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    fontStyle: 'italic',
    paddingTop: 4,
  },
  notice: {
    marginHorizontal: 16,
    marginTop: 8,
  },
  unavailableMark: {
    fontSize: 32,
  },
  retry: {
    minWidth: 140,
  },
  footer: {
    alignItems: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  loadMore: {
    fontSize: 14,
    fontWeight: '600',
    paddingVertical: 4,
  },
});

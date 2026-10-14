import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import type { AccountView, ChainAccount } from '../wallet/WalletContext';
import { useHistory } from '../wallet/useHistory';
import { usePrices } from '../wallet/usePrices';
import { useOwnEvmAddresses } from '../wallet/useOwnAddresses';
import { useClockTick } from '../components/RecurringDueBanner';
import { loadNativeBalance } from '../wallet/useBalances';
import { getAaConfig } from '../wallet/aa';
import { historySmartAccountFor } from '../wallet/activity-sentences';
import { fetchPriceHistory, nativePriceAssetId, type PriceHistoryResult } from '../wallet/prices';
import { EVM_CHAIN_ID } from '../wallet/send';
import { computeNativePnl, pnlFigureLines, pnlHistoryLoadedLine, pnlPriceRange, type PnlPriceHistory } from '../wallet/pnl';
import type { PortfolioSlot } from '../wallet/portfolio';

/** The intro of the profit-and-loss section. */
export const PNL_INTRO =
  'Profit and loss for the active account, worked out on this phone from its loaded transaction history and ' +
  'CoinGecko’s prices. It is offered only for the native coin of a main network: test-network coins have no price, ' +
  'and tokens are not offered (see the notes). Nothing is guessed: where the history or a price is missing, the ' +
  'wallet says what is missing instead of showing a figure. Working it out loads the account’s history and one ' +
  'price history from CoinGecko.';

export const PNL_NO_SLOTS =
  'Profit and loss is worked out only for main-network coins with a price. On a test network the coins have no ' +
  'value, so there is nothing to work out there.';

export const PNL_WATCHED_NOTE = 'These figures are for a watched address: it is not your funds.';

/**
 * The profit-and-loss section (feature 97) under the portfolio: one button
 * per priced network slot the active account has an address on; the panel
 * loads only after the button is pressed.
 */
export function PnlSection({
  slots,
  accounts,
  activeAccount,
  evmCaip2,
}: {
  slots: PortfolioSlot[];
  accounts: ChainAccount[];
  activeAccount: AccountView | null;
  evmCaip2: string;
}) {
  const theme = useTheme();
  const [chosen, setChosen] = useState<string | null>(null);
  const usable = slots.filter((s) => accounts.some((a) => a.chainId === s.slot));
  const slot = usable.find((s) => s.slot === chosen) ?? null;
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>
        Profit and loss
      </Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{PNL_INTRO}</Text>
      {usable.length === 0 ? <Text style={[styles.hint, { color: theme.textMuted }]}>{PNL_NO_SLOTS}</Text> : null}
      <View style={styles.chips}>
        {usable.map((s) => (
          <Button
            key={s.slot}
            title={`${chosen === s.slot ? '✓ ' : ''}${s.symbol} on ${s.label}`}
            variant="secondary"
            selected={chosen === s.slot}
            accessibilityHint={`Works out profit and loss for ${s.symbol}; loads the history and a price history`}
            onPress={() => setChosen(s.slot)}
            style={styles.chip}
          />
        ))}
      </View>
      {slot && activeAccount ? (
        <PnlPanel
          key={`${slot.slot}|${activeAccount.index}|${evmCaip2}`}
          slot={slot}
          address={accounts.find((a) => a.chainId === slot.slot)!.address}
          activeAccount={activeAccount}
          evmCaip2={evmCaip2}
        />
      ) : null}
    </View>
  );
}

function PnlPanel({
  slot,
  address,
  activeAccount,
  evmCaip2,
}: {
  slot: PortfolioSlot;
  address: string;
  activeAccount: AccountView;
  evmCaip2: string;
}) {
  const theme = useTheme();
  const { hideAmounts, showFiat } = usePrefs();
  const priceId = nativePriceAssetId(slot.slot, slot.networkChainId)!;
  const isEvm = slot.slot === EVM_CHAIN_ID;
  const smartCandidate = isEvm && !activeAccount.watchOnly && !activeAccount.multisig;

  // The smart account whose history Activity merges in (same rule as the Activity screen).
  const [smart, setSmart] = useState<{ address: string | null } | null>(smartCandidate ? null : { address: null });
  useEffect(() => {
    if (!smartCandidate) return undefined;
    let cancelled = false;
    getAaConfig(evmCaip2)
      .catch(() => null)
      .then((aa) => {
        let found: string | null = null;
        try {
          found = historySmartAccountFor(address, activeAccount.index, aa);
        } catch {
          found = null;
        }
        if (!cancelled) setSmart({ address: found });
      });
    return () => {
      cancelled = true;
    };
  }, [smartCandidate, evmCaip2, address, activeAccount.index]);
  const smartAddress = smart?.address ?? null;

  const { state, loadMore } = useHistory(slot.slot, address, { smartAccount: smartAddress, ready: smart !== null });

  // The balance of the addresses whose history is loaded: the account plus its smart account.
  const [balance, setBalance] = useState<{ value: bigint | null } | null>(null);
  useEffect(() => {
    if (smart === null) return undefined;
    let cancelled = false;
    const holders = [address, ...(smartAddress ? [smartAddress] : [])];
    Promise.all(
      holders.map(async (h) => {
        const load = await loadNativeBalance(slot.slot, h);
        if (load.status !== 'ok' || load.endpoint.network.chainId !== slot.networkChainId) return null;
        return load.amount;
      }),
    ).then(
      (amounts) => {
        if (!cancelled) setBalance({ value: amounts.some((a) => a === null) ? null : amounts.reduce<bigint>((s, a) => s + a!, 0n) });
      },
      () => {
        if (!cancelled) setBalance({ value: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [smart, smartAddress, address, slot.slot, slot.networkChainId]);

  const own = useOwnEvmAddresses();
  const ownAddresses = useMemo(
    () => [...own.map((o) => o.address), address, ...(smartAddress ? [smartAddress] : [])],
    [own, address, smartAddress],
  );
  const { quotes } = usePrices([priceId]);
  // The clock, refreshed every minute while the panel shows (the price ages and the 365-day window).
  const tick = useClockTick(60_000, true);
  const quote = quotes.get(priceId) ?? null;

  const entries = state.status === 'ok' ? state.entries : [];
  const hasMore = state.status === 'ok' ? state.hasMore : false;
  const nowMs = tick * 1000;
  const range = state.status === 'ok' && !hasMore ? pnlPriceRange({ entries, ownAddresses, nowMs }) : null;
  const rangeKey = range ? `${range.fromSec}|${range.toSec}` : null;
  const [history, setHistory] = useState<{ key: string; result: PriceHistoryResult } | null>(null);
  useEffect(() => {
    if (!range || !rangeKey) return undefined;
    let cancelled = false;
    void fetchPriceHistory(priceId, range.fromSec, range.toSec, { enabled: showFiat }).then((result) => {
      if (!cancelled) setHistory({ key: rangeKey, result });
    });
    return () => {
      cancelled = true;
    };
    // range is derived from rangeKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rangeKey covers range
  }, [rangeKey, priceId, showFiat]);

  if (state.status === 'loading' || smart === null) {
    return <ActivityIndicator color={theme.textMuted} accessibilityLabel="Loading the history" />;
  }
  if (state.status === 'unavailable') {
    return <Text style={[styles.hint, { color: theme.warningText }]}>Profit and loss needs the transaction history, which is not available: {state.note}</Text>;
  }
  if (state.status === 'error') {
    return <Text style={[styles.hint, { color: theme.danger }]}>The history could not be loaded: {state.message} Pull down or choose the coin again to retry.</Text>;
  }

  const prices: PnlPriceHistory =
    range === null
      ? { status: 'not-requested' }
      : history && history.key === rangeKey
        ? history.result.status === 'ok'
          ? { status: 'ok', points: history.result.points, granularity: history.result.granularity }
          : history.result
        : { status: 'not-requested' };
  const waitingForPrices = range !== null && (!history || history.key !== rangeKey);
  const result =
    balance === null || waitingForPrices
      ? null
      : computeNativePnl({
          asset: { priceId, symbol: slot.symbol, decimals: slot.decimals },
          entries,
          hasMore,
          smartAccount: smartAddress ? { address: smartAddress, status: state.smartAccount } : null,
          ownAddresses,
          balance: balance.value,
          prices,
          currentQuote: quote,
          nowMs,
        });

  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      {activeAccount.watchOnly ? <Text style={[styles.hint, { color: theme.warningText }]}>{PNL_WATCHED_NOTE}</Text> : null}
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        {pnlHistoryLoadedLine(entries.length, hasMore)}
      </Text>
      {result === null ? <ActivityIndicator color={theme.textMuted} accessibilityLabel="Working out profit and loss" /> : null}
      {result?.kind === 'gap'
        ? result.reasons.map((r) => (
            <Text key={r} accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.warningText }]}>
              {r}
            </Text>
          ))
        : null}
      {result?.kind === 'ok'
        ? pnlFigureLines(result, { symbol: slot.symbol, decimals: slot.decimals }, hideAmounts).map((line) => (
            <View key={line.label} style={styles.figure} accessible accessibilityLabel={`${line.label}: ${hideAmounts && line.label !== 'Counted' ? 'hidden' : line.text}`}>
              <Text style={[styles.figureLabel, { color: theme.textMuted }]}>{line.label}</Text>
              <Text style={[styles.figureText, { color: theme.text }]}>{line.text}</Text>
            </View>
          ))
        : null}
      {hasMore ? (
        <Button
          title={state.status === 'ok' && state.loadingMore ? 'Loading older history…' : 'Load older history'}
          variant="secondary"
          disabled={state.status === 'ok' && state.loadingMore}
          onPress={() => void loadMore()}
        />
      ) : null}
      {state.status === 'ok' && state.loadMoreError ? (
        <Text style={[styles.hint, { color: theme.danger }]}>{state.loadMoreError}</Text>
      ) : null}
      {result
        ? result.notes.map((n) => (
            <Text key={n} style={[styles.hint, { color: theme.textMuted }]}>
              {n}
            </Text>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  hint: { fontSize: 13, lineHeight: 19 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { flexGrow: 1, flexBasis: '40%', minWidth: 140, paddingVertical: 10 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  figure: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  figureLabel: { fontSize: 14 },
  figureText: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
});

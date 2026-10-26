import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import type { FungibleAsset } from '@shiba-wallet/core';
import type { AccountView, ChainAccount } from '../wallet/WalletContext';
import { useHistory } from '../wallet/useHistory';
import { usePrices } from '../wallet/usePrices';
import { useOwnEvmAddresses } from '../wallet/useOwnAddresses';
import { useClockTick } from '../components/RecurringDueBanner';
import { loadNativeBalance } from '../wallet/useBalances';
import { loadTokenBalance } from '../wallet/useTokenBalances';
import { listTokens } from '../wallet/tokens';
import { getAaConfig } from '../wallet/aa';
import { historySmartAccountFor } from '../wallet/activity-sentences';
import { fetchPriceHistory, nativePriceAssetId, type PriceHistoryResult } from '../wallet/prices';
import { EVM_CHAIN_ID } from '../wallet/send';
import {
  computeNativePnl,
  computeTokenPnl,
  pnlFigureLines,
  pnlHistoryLoadedLine,
  pnlPriceRange,
  pnlTokenChipTitle,
  pnlTokenChoices,
  type PnlPriceHistory,
  type PnlTokenAsset,
} from '../wallet/pnl';
import type { PortfolioSlot } from '../wallet/portfolio';

/** The intro of the profit-and-loss section. */
export const PNL_INTRO =
  'Profit and loss for the active account, worked out on this phone from its loaded transaction history and ' +
  'CoinGecko’s prices. It is offered for the native coin of a main network and for each ERC-20 token tracked on ' +
  'the active main network that CoinGecko prices, a token counted only by its own contract: test-network coins and ' +
  'tokens have no price, so they are not offered. Nothing is guessed: where the history or a price is missing, the ' +
  'wallet says what is missing instead of showing a figure. Working it out loads the account’s history and one ' +
  'price history from CoinGecko.';

export const PNL_NO_SLOTS =
  'Profit and loss is worked out only for main-network coins with a price. On a test network the coins have no ' +
  'value, so there is nothing to work out there.';

export const PNL_WATCHED_NOTE = 'These figures are for a watched address: it is not your funds.';

/** What one profit-and-loss button works out: a network's own coin, or a tracked token on the EVM slot. */
type PnlSubject = { kind: 'native'; slot: PortfolioSlot } | { kind: 'token'; slot: PortfolioSlot; asset: PnlTokenAsset };

function subjectKey(subject: PnlSubject): string {
  return subject.kind === 'native' ? `native:${subject.slot.slot}` : `token:${subject.asset.contract}`;
}

/**
 * The profit-and-loss section (feature 97) under the portfolio: one button
 * per priced network slot the active account has an address on, then one
 * per tracked token pnlTokenChoices offers on the active EVM network (only
 * a main network: a test network's slot is never in `slots` and its tokens
 * have no price id); the panel loads only after a button is pressed.
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
  // The EVM slot, only when it is priced now (a main network) and the account has an address on it.
  const evmSlot = usable.find((s) => s.evm && s.networkChainId === evmCaip2) ?? null;
  const hasEvmSlot = evmSlot !== null;
  const [tracked, setTracked] = useState<{ chain: string; tokens: FungibleAsset[] } | null>(null);
  useEffect(() => {
    if (!hasEvmSlot) return undefined;
    let cancelled = false;
    listTokens(evmCaip2)
      .catch(() => [] as FungibleAsset[])
      .then((tokens) => {
        if (!cancelled) setTracked({ chain: evmCaip2, tokens });
      });
    return () => {
      cancelled = true;
    };
  }, [hasEvmSlot, evmCaip2]);
  const tokenChoices = evmSlot && tracked && tracked.chain === evmCaip2 ? pnlTokenChoices(tracked.tokens, evmCaip2) : [];
  const subjects: PnlSubject[] = [
    ...usable.map((s) => ({ kind: 'native' as const, slot: s })),
    ...(evmSlot ? tokenChoices.map((asset) => ({ kind: 'token' as const, slot: evmSlot, asset })) : []),
  ];
  const subject = subjects.find((x) => subjectKey(x) === chosen) ?? null;
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>
        Profit and loss
      </Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{PNL_INTRO}</Text>
      {usable.length === 0 ? <Text style={[styles.hint, { color: theme.textMuted }]}>{PNL_NO_SLOTS}</Text> : null}
      <View style={styles.chips}>
        {subjects.map((x) => {
          const key = subjectKey(x);
          const title =
            x.kind === 'native'
              ? `${x.slot.symbol} on ${x.slot.label}`
              : pnlTokenChipTitle(x.asset, tokenChoices, x.slot.label, x.slot.symbol);
          return (
            <Button
              key={key}
              title={`${chosen === key ? '✓ ' : ''}${title}`}
              variant="secondary"
              selected={chosen === key}
              accessibilityHint={
                x.kind === 'native'
                  ? `Works out profit and loss for ${x.slot.symbol}; loads the history and a price history`
                  : `Works out profit and loss for the tracked ${x.asset.symbol} token, contract ${x.asset.contract}; loads the history and a price history`
              }
              onPress={() => setChosen(key)}
              style={styles.chip}
            />
          );
        })}
      </View>
      {subject && activeAccount ? (
        <PnlPanel
          key={`${subjectKey(subject)}|${activeAccount.index}|${evmCaip2}`}
          subject={subject}
          address={accounts.find((a) => a.chainId === subject.slot.slot)!.address}
          activeAccount={activeAccount}
          evmCaip2={evmCaip2}
        />
      ) : null}
    </View>
  );
}

function PnlPanel({
  subject,
  address,
  activeAccount,
  evmCaip2,
}: {
  subject: PnlSubject;
  address: string;
  activeAccount: AccountView;
  evmCaip2: string;
}) {
  const theme = useTheme();
  const { hideAmounts, showFiat } = usePrefs();
  const slot = subject.slot;
  const token = subject.kind === 'token' ? subject.asset : null;
  const priceId = token ? token.priceId : nativePriceAssetId(slot.slot, slot.networkChainId)!;
  const symbol = token ? token.symbol : slot.symbol;
  const decimals = token ? token.decimals : slot.decimals;
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
    const contract = token?.contract ?? null;
    Promise.all(
      holders.map(async (h) => {
        if (contract !== null) {
          // A token's balance, read only on the network it is tracked on.
          const load = await loadTokenBalance(contract, h, { expectedChain: evmCaip2 });
          if (load.status !== 'ok' || load.endpoint.network.chainId !== evmCaip2) return null;
          return load.amount;
        }
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
  }, [smart, smartAddress, address, slot.slot, slot.networkChainId, token?.contract, evmCaip2]);

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
  const range = state.status === 'ok' && !hasMore ? pnlPriceRange({ entries, ownAddresses, nowMs, ...(token ? { asset: token } : {}) }) : null;
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
    return <Text style={[styles.hint, { color: theme.danger }]}>The history could not be loaded: {state.message} Pull down or choose it again to retry.</Text>;
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
  const common = {
    entries,
    hasMore,
    smartAccount: smartAddress ? { address: smartAddress, status: state.smartAccount } : null,
    ownAddresses,
    balance: balance?.value ?? null,
    prices,
    currentQuote: quote,
    nowMs,
  };
  const result =
    balance === null || waitingForPrices
      ? null
      : token
        ? computeTokenPnl({ ...common, asset: token })
        : computeNativePnl({ ...common, asset: { priceId, symbol, decimals } });

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
        ? pnlFigureLines(result, { symbol, decimals }, hideAmounts).map((line) => (
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { FungibleAsset } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { WarningBox, WatchOnlyNotice, screenStyle } from '../components';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { useWallet, type AccountView } from '../wallet/WalletContext';
import { usePrices } from '../wallet/usePrices';
import { loadNativeBalance } from '../wallet/useBalances';
import { loadTokenBalance } from '../wallet/useTokenBalances';
import { listTokens } from '../wallet/tokens';
import { getAaConfig } from '../wallet/aa';
import { historySmartAccountFor } from '../wallet/activity-sentences';
import { loadPublicAccount } from '../wallet/storage';
import { DEFAULT_NETWORKS } from '../config/defaults';
import { EVM_CHAIN_ID } from '../wallet/send';
import { nativePriceAssetId } from '../wallet/prices';
import {
  PORTFOLIO_FIAT_OFF_NOTE,
  PORTFOLIO_NOT_COUNTED_NOTE,
  PORTFOLIO_READS_NOTE,
  PORTFOLIO_ROUNDING_NOTE,
  PORTFOLIO_WATCHED_HEADING,
  PORTFOLIO_WATCHED_NOTE,
  amountText,
  computePortfolio,
  formatMoney,
  holdingSpokenLabel,
  planPortfolio,
  portfolioCountedNote,
  portfolioGapLines,
  portfolioPriceIds,
  portfolioPriceSourceLine,
  runPortfolioReads,
  spokenMoney,
  valueText,
  type GroupTotal,
  type PortfolioAccountInput,
  type PortfolioPlan,
  type PortfolioReadResult,
  type PortfolioReadTask,
  type PortfolioSlot,
} from '../wallet/portfolio';
import { PnlSection } from './PortfolioViews';

type Props = NativeStackScreenProps<RootStackParamList, 'Portfolio'>;

/** The account inputs for the plan (public data only: addresses from the wallet and the public cache). */
async function accountInputs(args: {
  accountList: AccountView[];
  watchOnlyAccounts: AccountView[];
  multisigAccounts: AccountView[];
  activeIndex: number | null;
  activeOthers: Record<string, string>;
  evmCaip2: string;
}): Promise<PortfolioAccountInput[]> {
  const aa = await getAaConfig(args.evmCaip2).catch(() => null);
  const out: PortfolioAccountInput[] = [];
  for (const a of args.accountList) {
    const kind = a.imported ? 'imported' : 'phrase';
    let otherAddresses: Record<string, string> | null = null;
    if (kind === 'phrase') {
      if (a.index === args.activeIndex) otherAddresses = args.activeOthers;
      else {
        const cached = await loadPublicAccount(a.index).catch(() => null);
        otherAddresses = cached
          ? Object.fromEntries(cached.filter((c) => c.chainId !== EVM_CHAIN_ID).map((c) => [c.chainId, c.address]))
          : null;
      }
    }
    let smartAccount: string | null = null;
    if (a.evmAddress) {
      try {
        smartAccount = historySmartAccountFor(a.evmAddress, a.index, aa);
      } catch {
        smartAccount = null;
      }
    }
    out.push({
      key: `${kind}:${a.index}`,
      name: a.hidden ? `${a.name} (hidden)` : a.name,
      kind,
      hidden: a.hidden,
      evmAddress: a.evmAddress,
      otherAddresses,
      smartAccount,
    });
  }
  for (const a of args.multisigAccounts) {
    out.push({
      key: `multisig:${a.index}`,
      name: a.name,
      kind: 'multisig',
      hidden: false,
      evmAddress: a.evmAddress,
      otherAddresses: null,
      smartAccount: null,
      ...(a.multisigInfo ? { multisigChain: a.multisigInfo.chain } : {}),
    });
  }
  for (const a of args.watchOnlyAccounts) {
    out.push({
      key: `watch:${a.index}`,
      name: a.name,
      kind: 'watch',
      hidden: false,
      evmAddress: a.evmAddress,
      otherAddresses: null,
      smartAccount: null,
    });
  }
  return out;
}

/** One balance read through the same loaders (and failover rule) as the Home screen. */
async function readTask(task: PortfolioReadTask): Promise<PortfolioReadResult> {
  if (task.asset.kind === 'native') {
    const load = await loadNativeBalance(task.asset.slot, task.holder.address);
    if (load.status === 'unavailable') return { status: 'unavailable', ...(load.note ? { note: load.note } : {}) };
    return {
      status: 'ok',
      amount: load.amount,
      decimals: load.endpoint.network.decimals,
      networkChainId: load.endpoint.network.chainId,
    };
  }
  const token = task.asset.token!;
  const load = await loadTokenBalance(token.assetId.reference, task.holder.address, { expectedChain: token.assetId.chainId });
  if (load.status === 'unavailable') return { status: 'unavailable', ...(load.note ? { note: load.note } : {}) };
  return { status: 'ok', amount: load.amount, decimals: token.decimals, networkChainId: load.endpoint.network.chainId };
}

/**
 * The portfolio (feature 96) and, below it, profit and loss (feature 97).
 * Read-only for every kind of account: nothing here can sign or send.
 */
export function PortfolioScreen(_props: Props) {
  const theme = useTheme();
  const { hideAmounts, showFiat, evmChain } = usePrefs();
  const { accounts, activeAccount, accountList, watchOnlyAccounts, multisigAccounts } = useWallet();

  const slots: PortfolioSlot[] = useMemo(
    () =>
      DEFAULT_NETWORKS.map((n) =>
        n.kind === 'evm-jsonrpc'
          ? {
              slot: n.chainId,
              networkChainId: evmChain.caip2,
              label: evmChain.label,
              symbol: evmChain.displaySymbol,
              decimals: 18,
              testnet: evmChain.testnet,
              evm: true,
            }
          : { slot: n.chainId, networkChainId: n.chainId, label: n.label, symbol: n.symbol, decimals: n.decimals, testnet: false, evm: false },
      ),
    [evmChain.caip2, evmChain.label, evmChain.displaySymbol, evmChain.testnet],
  );

  const [plan, setPlan] = useState<PortfolioPlan | null>(null);
  const [results, setResults] = useState<Map<string, PortfolioReadResult>>(new Map());
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);

  const activeOthers = useMemo(
    () => Object.fromEntries(accounts.filter((a) => a.chainId !== EVM_CHAIN_ID).map((a) => [a.chainId, a.address])),
    [accounts],
  );
  const accountsKey = [...accountList, ...watchOnlyAccounts, ...multisigAccounts]
    .map((a) => `${a.index}:${a.evmAddress ?? ''}:${a.hidden ? 1 : 0}`)
    .join(',');

  const load = useCallback(async () => {
    const gen = ++generation.current;
    // No state is set before the first await (an effect starts this load).
    const inputsPromise = accountInputs({
      accountList,
      watchOnlyAccounts,
      multisigAccounts,
      activeIndex: activeAccount && !activeAccount.watchOnly && !activeAccount.multisig ? activeAccount.index : null,
      activeOthers,
      evmCaip2: evmChain.caip2,
    });
    try {
      const inputs = await inputsPromise;
      if (gen !== generation.current) return;
      setLoading(true);
      setNow(Date.now());
      const tokens: FungibleAsset[] = await listTokens(evmChain.caip2).catch(() => []);
      const next = planPortfolio({ accounts: inputs, slots, tokens });
      if (gen !== generation.current) return;
      setPlan(next);
      setResults(new Map());
      await runPortfolioReads(next.tasks, readTask, undefined, (key, result) => {
        if (gen === generation.current) setResults((prev) => new Map(prev).set(key, result));
      });
    } finally {
      if (gen === generation.current) setLoading(false);
    }
    // accountsKey covers every account's index, address and hidden flag; the arrays are new on every context render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [accountsKey, activeAccount?.index, activeAccount?.watchOnly, activeAccount?.multisig, activeOthers, evmChain.caip2, slots]);

  useEffect(() => {
    void load().catch(() => undefined);
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const { quotes, refresh: refreshPrices } = usePrices(plan ? portfolioPriceIds(plan) : []);
  const summary = useMemo(() => (plan ? computePortfolio({ plan, results, quotes }) : null), [plan, results, quotes]);
  const pending = plan ? plan.tasks.length - results.size : 0;

  const money = (m: Parameters<typeof formatMoney>[0]) => formatMoney(m, { hidden: hideAmounts });
  const sourceLine = summary ? portfolioPriceSourceLine(summary, now) : null;

  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={loading}
          onRefresh={() => {
            void load().catch(() => undefined);
            void refreshPrices();
          }}
          tintColor={theme.textMuted}
          colors={[theme.accent]}
        />
      }
    >
      {activeAccount?.watchOnly ? <WatchOnlyNotice /> : null}
      {!showFiat ? <WarningBox>{PORTFOLIO_FIAT_OFF_NOTE}</WarningBox> : null}

      <View
        style={[styles.totalCard, { backgroundColor: theme.card, borderColor: theme.border }]}
        accessible
        accessibilityLabel={
          summary
            ? `Net worth: ${spokenMoney(summary.netWorth, { hidden: hideAmounts })}${summary.complete && pending === 0 ? '' : ', not complete'}`
            : 'Net worth: loading'
        }
      >
        <Text style={[styles.totalLabel, { color: theme.textMuted }]}>Net worth (US dollars)</Text>
        {summary ? (
          <Text style={[styles.total, { color: theme.text }]}>{showFiat ? `≈ ${money(summary.netWorth)}` : '—'}</Text>
        ) : (
          <ActivityIndicator color={theme.textMuted} />
        )}
        {pending > 0 ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Reading {pending} more {pending === 1 ? 'balance' : 'balances'}…
          </Text>
        ) : summary && !summary.complete ? (
          <Text style={[styles.hint, { color: theme.warningText }]}>Not complete: see what is not counted below.</Text>
        ) : null}
        {sourceLine ? <Text style={[styles.hint, { color: theme.textMuted }]}>{sourceLine}</Text> : null}
      </View>

      {summary && plan ? (
        <>
          {portfolioGapLines(summary, plan).length > 0 && pending === 0 ? (
            <View style={styles.section}>
              {portfolioGapLines(summary, plan).map((line) => (
                <Text key={line} style={[styles.hint, { color: theme.warningText }]}>
                  {line}
                </Text>
              ))}
            </View>
          ) : null}

          <Section title="By asset">
            {summary.byAsset.length === 0 ? <Empty text="No balances found yet." /> : null}
            {summary.byAsset.map((a) => (
              <Row
                key={a.asset.id}
                label={`${a.asset.symbol} on ${a.asset.networkLabel}`}
                amount={amountText(a.amount, a.asset.decimals, a.asset.symbol, hideAmounts)}
                value={valueText(a.status, a.value, hideAmounts)}
                spoken={holdingSpokenLabel({
                  label: `${a.asset.symbol} on ${a.asset.networkLabel}`,
                  amount: a.amount,
                  decimals: a.asset.decimals,
                  symbol: a.asset.symbol,
                  status: a.status,
                  value: a.value,
                  quote: a.quote,
                  hidden: hideAmounts,
                  nowMs: now,
                })}
              />
            ))}
          </Section>

          <Section title="By network">
            {summary.byNetwork.map((g) => (
              <GroupRow key={g.key} group={g} hidden={hideAmounts} />
            ))}
          </Section>

          <Section title="By account">
            {summary.byAccount.map((g) => (
              <AccountGroup key={g.key} group={g} hidden={hideAmounts} now={now} />
            ))}
          </Section>

          {summary.watchedByAccount.length > 0 || watchOnlyAccounts.length > 0 ? (
            <Section title={PORTFOLIO_WATCHED_HEADING}>
              <Text style={[styles.hint, { color: theme.textMuted }]}>{PORTFOLIO_WATCHED_NOTE}</Text>
              <View
                accessible
                accessibilityLabel={`Watched total, not your funds: ${spokenMoney(summary.watchedTotal, { hidden: hideAmounts })}`}
              >
                <Text style={[styles.rowLabel, { color: theme.text }]}>
                  Watched total (not counted in your net worth): {showFiat ? `≈ ${money(summary.watchedTotal)}` : '—'}
                </Text>
              </View>
              {summary.watchedByAccount.map((g) => (
                <AccountGroup key={g.key} group={g} hidden={hideAmounts} now={now} />
              ))}
            </Section>
          ) : null}
        </>
      ) : null}

      <Section title="What is counted">
        <Text style={[styles.hint, { color: theme.textMuted }]}>{portfolioCountedNote(evmChain.label)}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{PORTFOLIO_NOT_COUNTED_NOTE}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{PORTFOLIO_ROUNDING_NOTE}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{PORTFOLIO_READS_NOTE}</Text>
      </Section>

      <PnlSection
        slots={slots.filter((s) => nativePriceAssetId(s.slot, s.networkChainId) !== null)}
        accounts={accounts}
        activeAccount={activeAccount}
        evmCaip2={evmChain.caip2}
      />
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Empty({ text }: { text: string }) {
  const theme = useTheme();
  return <Text style={[styles.hint, { color: theme.textMuted }]}>{text}</Text>;
}

function Row({ label, amount, value, spoken }: { label: string; amount: string; value: string; spoken: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: theme.card, borderColor: theme.border }]} accessible accessibilityLabel={spoken}>
      <Text style={[styles.rowLabel, { color: theme.text }]} numberOfLines={2}>
        {label}
      </Text>
      <View style={styles.rowFigures}>
        <Text style={[styles.rowAmount, { color: theme.text }]}>{amount}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{value}</Text>
      </View>
    </View>
  );
}

function GroupRow({ group, hidden }: { group: GroupTotal; hidden: boolean }) {
  const theme = useTheme();
  const extra = group.unvalued > 0 ? ` (${group.unvalued} not valued)` : '';
  return (
    <View
      style={[styles.row, { backgroundColor: theme.card, borderColor: theme.border }]}
      accessible
      accessibilityLabel={`${group.label}: ${spokenMoney(group.value, { hidden })}${extra}`}
    >
      <Text style={[styles.rowLabel, { color: theme.text }]}>{group.label}</Text>
      <Text style={[styles.rowAmount, { color: theme.text }]}>
        ≈ {formatMoney(group.value, { hidden })}
        {extra}
      </Text>
    </View>
  );
}

function AccountGroup({ group, hidden, now }: { group: GroupTotal; hidden: boolean; now: number }) {
  const theme = useTheme();
  return (
    <View style={[styles.groupCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View accessible accessibilityLabel={`${group.label}: ${spokenMoney(group.value, { hidden })}`}>
        <Text style={[styles.rowLabel, { color: theme.text }]}>{group.label}</Text>
        <Text style={[styles.rowAmount, { color: theme.text }]}>≈ {formatMoney(group.value, { hidden })}</Text>
      </View>
      {group.holdings.map((h) => {
        const where = h.task.holder.role === 'smart' ? 'smart account' : h.task.asset.networkLabel;
        const label = `${h.task.asset.symbol} · ${where}`;
        return (
          <View
            key={h.task.key}
            style={styles.holding}
            accessible
            accessibilityLabel={holdingSpokenLabel({
              label: `${h.task.holder.label}, ${h.task.asset.symbol} on ${h.task.asset.networkLabel}`,
              amount: h.amount,
              decimals: h.decimals,
              symbol: h.task.asset.symbol,
              status: h.status,
              value: h.value,
              quote: h.quote,
              hidden,
              nowMs: now,
            })}
          >
            <Text style={[styles.hint, { color: theme.textMuted }]}>{label}</Text>
            <Text style={[styles.hint, { color: theme.text }]}>
              {amountText(h.amount, h.decimals, h.task.asset.symbol, hidden)} · {valueText(h.status, h.value, hidden)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 24 },
  section: { gap: 10 },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  hint: { fontSize: 13, lineHeight: 19 },
  totalCard: { borderRadius: 14, borderWidth: 1, padding: 16, gap: 6 },
  totalLabel: { fontSize: 13, fontWeight: '600' },
  total: { fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'] },
  row: { borderRadius: 12, borderWidth: 1, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowLabel: { fontSize: 15, fontWeight: '600', flexShrink: 1, flexGrow: 1 },
  rowFigures: { alignItems: 'flex-end', flexShrink: 1 },
  rowAmount: { fontSize: 15, fontVariant: ['tabular-nums'] },
  groupCard: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 8 },
  holding: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
});


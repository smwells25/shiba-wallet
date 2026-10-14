import React, { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { httpTransport as evmHttpTransport, type StakeOutcomePreview } from '@shiba-wallet/chains-evm';
import type { Theme } from '../theme';
import { WarningBox } from '../components';
import { formatUnits } from '../wallet/balances';
import {
  STETH_REBASING_NOTE,
  previewStakingPlan,
  stakeOutcomeSimulatedLines,
  stakingSummaryLines,
  type QuotedStatement,
  type StakingBalances,
  type StakingPlan,
} from '../wallet/staking';

/**
 * Presentational pieces of the Staking screen (phase 18 item 2): the
 * confirm rows and badge in the send screens' style, a protocol's own risk
 * statement quoted verbatim with its source and date, the balances card,
 * and the staking outcome card ("You send … / You receive ≈ …" from the
 * plan, checked against the asset-diff simulation of the same calls).
 */

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Full-precision display of an 18-decimal amount (never truncates). */
export function exact18(amount: bigint): string {
  return formatUnits(amount, 18, 18);
}

/** The confirm-screen badge of the send and swap flows (TESTNET / mainnet). */
export function NetworkBadge({ label, testnet, theme }: { label: string; testnet: boolean; theme: Theme }) {
  if (testnet) {
    return (
      <View style={[styles.badge, { backgroundColor: theme.testnetFill, borderColor: theme.testnetFill }]}>
        <Text style={[styles.badgeText, { color: theme.onTestnetFill }]}>{label} TESTNET — test funds only</Text>
      </View>
    );
  }
  return (
    <View style={[styles.badge, { backgroundColor: theme.dangerSurface, borderColor: theme.danger }]}>
      <Text style={[styles.badgeText, { color: theme.danger }]}>{label} Mainnet — real funds</Text>
    </View>
  );
}

export function Row({
  label,
  value,
  sub = null,
  mono: monoFont,
  theme,
}: {
  label: string;
  value: string;
  sub?: string | null;
  mono?: boolean;
  theme: Theme;
}) {
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text selectable style={[styles.rowValue, { color: theme.text }, monoFont ? { fontFamily: mono, fontSize: 13 } : null]}>
        {value}
      </Text>
      {sub ? <Text style={[styles.rowSub, { color: theme.textMuted }]}>{sub}</Text> : null}
    </View>
  );
}

/** A protocol's own statement, quoted verbatim, with the source and the date it was read. */
export function QuotedStatementCard({ statement, theme }: { statement: QuotedStatement; theme: Theme }) {
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.cardTitle, { color: theme.text }]}>{statement.intro}</Text>
      {statement.sentences.map((s) => (
        <Text key={s} style={[styles.quote, { color: theme.text, borderColor: theme.border }]}>
          “{s}”
        </Text>
      ))}
      <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(statement.url)}>
        <Text style={[styles.hint, { color: theme.accent }]}>
          Source: {statement.source}, read {statement.read}. {statement.url}
        </Text>
      </Pressable>
    </View>
  );
}

/** The holder's staking balances (exact figures; Hide amounts masks them). */
export function StakingBalancesCard({
  balances,
  hidden,
  nativeSymbol,
  holderLine,
  theme,
}: {
  balances: StakingBalances;
  hidden: boolean;
  nativeSymbol: string;
  /** Whose balances these are (staking.ts stakingBalancesHolderLine). */
  holderLine: string;
  theme: Theme;
}) {
  const show = (amount: bigint, symbol: string) => (hidden ? `•••• ${symbol}` : `${exact18(amount)} ${symbol}`);
  const lines: { label: string; value: string; sub?: string | null }[] = [];
  if (balances.lido) {
    lines.push({ label: 'stETH', value: show(balances.lido.stETH, 'stETH'), sub: 'Rebasing: the balance changes when Lido’s oracle reports.' });
    lines.push({
      label: 'wstETH',
      value: show(balances.lido.wstETH, 'wstETH'),
      sub: balances.lido.wstETH > 0n && !hidden ? `Worth ${exact18(balances.lido.wstETHInStETH)} stETH at Lido’s rate now.` : null,
    });
  }
  if (balances.rETH !== null) {
    lines.push({
      label: 'rETH',
      value: show(balances.rETH, 'rETH'),
      sub:
        balances.rETH > 0n && balances.rethEthValue !== null && !hidden
          ? `Worth ${exact18(balances.rethEthValue)} ${nativeSymbol} at Rocket Pool’s rate now.`
          : null,
    });
  }
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.cardTitle, { color: theme.text }]}>Your staking balances</Text>
      <Text selectable style={[styles.hint, { color: theme.textMuted }]}>
        {holderLine}
      </Text>
      {lines.map((l) => (
        <Row key={l.label} label={l.label} value={l.value} sub={l.sub ?? null} theme={theme} />
      ))}
      {balances.rethLock?.locked ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Rocket Pool blocks moving or redeeming this account’s rETH until block {String(balances.rethLock.unlockBlock)}.
        </Text>
      ) : null}
      {balances.requests.length > 0 ? (
        <>
          <Text style={[styles.cardTitle, { color: theme.text }]}>Lido withdrawal requests</Text>
          {balances.requests.map((r) => (
            <Row
              key={String(r.requestId)}
              label={`Request ${String(r.requestId)}`}
              value={hidden ? '•••• stETH' : `${exact18(r.amountOfStETH)} stETH`}
              sub={r.isClaimed ? 'Claimed.' : r.isFinalized ? 'Finalized: ready to claim.' : 'Waiting in Lido’s queue.'}
              theme={theme}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}

/**
 * "You send … / You receive ≈ …" for a plan, plus what the asset-diff
 * simulation of the same calls says arrives (the token's own events, by
 * pinned contract address), and the rebasing note when stETH is involved.
 * Informational: the eth_call (or bundler) gate stays the only gate.
 */
export function StakeOutcomeCard({ url, plan, theme, nativeSymbol }: { url: string | null; plan: StakingPlan; theme: Theme; nativeSymbol: string }) {
  const [preview, setPreview] = useState<StakeOutcomePreview | 'unavailable' | null>(null);
  const key = `${url ?? ''}|${plan.holder}|${plan.calls.map((c) => `${c.to}:${c.value}:${c.data.length}`).join(',')}`;
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setPreview(null);
  }
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    previewStakingPlan(evmHttpTransport(url), plan).then(
      (p) => {
        if (!cancelled) setPreview(p);
      },
      () => {
        if (!cancelled) setPreview('unavailable');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url, plan]);
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      {stakingSummaryLines(plan).map((line) => (
        <Text key={line} style={[styles.summary, { color: theme.text }]}>
          {line}
        </Text>
      ))}
      {preview === null && url ? <Text style={[styles.hint, { color: theme.textMuted }]}>Simulating the outcome…</Text> : null}
      {preview === 'unavailable' || !url ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>The outcome simulation is not available from this endpoint right now.</Text>
      ) : null}
      {preview && preview !== 'unavailable' ? (
        preview.ok ? (
          <>
            {stakeOutcomeSimulatedLines(preview, nativeSymbol).map((line) => (
              <Text key={line} style={[styles.hint, { color: theme.textMuted }]}>
                {line}
              </Text>
            ))}
            {preview.skippedLogs > 0 ? (
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                {preview.skippedLogs} event{preview.skippedLogs === 1 ? '' : 's'} could not be read, so this may be incomplete.
              </Text>
            ) : null}
          </>
        ) : (
          <WarningBox>The simulation of these calls failed{preview.revertReason ? `: ${preview.revertReason}` : ''}.</WarningBox>
        )
      ) : null}
      {plan.rebasing ? <Text style={[styles.hint, { color: theme.textMuted }]}>{STETH_REBASING_NOTE}</Text> : null}
    </View>
  );
}

export const stakingStyles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 48 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 10, padding: 12 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 4 },
  input: { borderRadius: 10, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, fontSize: 15 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  choiceButton: { paddingHorizontal: 16 },
  fieldError: { fontSize: 13, lineHeight: 18 },
  notice: { fontSize: 13, lineHeight: 19, fontWeight: '600' },
  hint: { fontSize: 13, lineHeight: 19 },
  stepTitle: { fontSize: 17, fontWeight: '700' },
  simulationOk: { fontSize: 14, fontWeight: '600' },
  successTitle: { fontSize: 26, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  box: { borderRadius: 12, borderWidth: 1, padding: 14 },
  monoText: { fontFamily: mono, fontSize: 13, lineHeight: 19 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toggleLabel: { fontSize: 14, flex: 1 },
});

const styles = StyleSheet.create({
  badge: { borderRadius: 12, borderWidth: 1.5, padding: 12, alignItems: 'center' },
  badgeText: { fontSize: 15, fontWeight: '700' },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 10, gap: 4 },
  rowLabel: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  rowValue: { fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  rowSub: { fontSize: 13, fontVariant: ['tabular-nums'] },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  quote: { fontSize: 14, lineHeight: 20, fontStyle: 'italic', borderLeftWidth: 3, paddingLeft: 10 },
  hint: { fontSize: 13, lineHeight: 19 },
  summary: { fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
});

import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { BridgeTrustStatement } from '@shiba-wallet/chains-evm';
import type { Theme } from '../theme';
import { WarningBox } from '../components';
import {
  BRIDGE_FEE_BEFORE_QUOTE,
  bridgeStatusHeading,
  bridgeStatusSentence,
  exactNative,
  type BridgeProviderRow,
  type BridgeTransferRecord,
} from '../wallet/bridge';

/**
 * Presentational pieces of the Bridge screen (feature 35, phase 21 item 1):
 * a provider as one radio row (label, what it moves, its trust statement
 * verbatim, the fee once quoted, the measured time with the provider's own
 * "not a promise" sentence, and why it cannot be chosen when it cannot),
 * the trust card for the confirm, and the tracking card of one transfer.
 */

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** The live figures of a provider row, once "Get quotes" or Review read them. */
export interface ProviderRowQuote {
  fee: string;
  arrives: string;
}

/** The three parts of a trust statement, labelled, verbatim. */
export function TrustStatementCard({ trust, theme, title }: { trust: BridgeTrustStatement; theme: Theme; title: string }) {
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.body, { color: theme.text }]}>
        <Text style={styles.strong}>Who verifies: </Text>
        {trust.verification}
      </Text>
      <Text style={[styles.body, { color: theme.text }]}>
        <Text style={styles.strong}>Who controls: </Text>
        {trust.control}
      </Text>
      <Text style={[styles.body, { color: theme.text }]}>
        <Text style={styles.strong}>If it does not arrive: </Text>
        {trust.refundRule}
      </Text>
    </View>
  );
}

/**
 * One provider as a radio row. A provider that cannot be chosen is shown
 * all the same (dimmed, with the reason), so the user sees every provider
 * the wallet knows and who each would trust.
 */
export function ProviderRadioRow({
  row,
  selected,
  quote,
  onSelect,
  theme,
}: {
  row: BridgeProviderRow;
  selected: boolean;
  quote: ProviderRowQuote | null;
  onSelect: () => void;
  theme: Theme;
}) {
  const spoken =
    `${row.label}${row.asset ? `, moves ${row.asset}` : ''}` +
    (row.selectable ? (quote ? `, fee ${quote.fee}` : '') : `, not available: ${row.note ?? ''}`);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: !row.selectable }}
      accessibilityLabel={spoken}
      disabled={!row.selectable}
      onPress={onSelect}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: theme.card,
          borderColor: selected ? theme.accent : theme.border,
          borderWidth: selected ? 2 : 1,
          opacity: row.selectable ? (pressed ? 0.8 : 1) : 0.6,
        },
      ]}
    >
      <View style={styles.radioHead}>
        <View style={[styles.radioOuter, { borderColor: row.selectable ? theme.accent : theme.textMuted }]}>
          {selected ? <View style={[styles.radioInner, { backgroundColor: theme.accent }]} /> : null}
        </View>
        <Text style={[styles.providerLabel, { color: theme.text }]}>
          {row.label}
          {row.asset ? ` · moves ${row.asset}` : ''}
        </Text>
      </View>
      {row.note ? <Text style={[styles.body, { color: theme.textMuted }]}>{row.note}</Text> : null}
      <Text style={[styles.body, { color: theme.text }]}>
        <Text style={styles.strong}>Who verifies: </Text>
        {row.trust.verification}
      </Text>
      <Text style={[styles.body, { color: theme.text }]}>
        <Text style={styles.strong}>Who controls: </Text>
        {row.trust.control}
      </Text>
      <Text style={[styles.body, { color: theme.text }]}>
        <Text style={styles.strong}>If it does not arrive: </Text>
        {row.trust.refundRule}
      </Text>
      {row.selectable ? (
        quote ? (
          <Text style={[styles.body, { color: theme.text }]}>
            <Text style={styles.strong}>Fee (quoted just now): </Text>
            {quote.fee}. {quote.arrives}
          </Text>
        ) : (
          <Text style={[styles.body, { color: theme.textMuted }]}>{BRIDGE_FEE_BEFORE_QUOTE}</Text>
        )
      ) : null}
      {row.measured ? <Text style={[styles.body, { color: theme.text }]}>{row.measured}</Text> : null}
      {row.timeSource ? <Text style={[styles.body, { color: theme.textMuted }]}>{row.timeSource}</Text> : null}
    </Pressable>
  );
}

/** One transfer of this session: where it is, from the chains' own events. */
export function TransferStatusCard({
  record,
  symbol,
  checking,
  theme,
  children,
}: {
  record: BridgeTransferRecord;
  symbol: string;
  checking: boolean;
  theme: Theme;
  children?: React.ReactNode;
}) {
  const heading = bridgeStatusHeading(record.status, record.destinationLabel);
  const failed = record.status?.state === 'failed';
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
        {exactNative(record.amountIn)} {symbol} · {record.sourceLabel} → {record.destinationLabel}
      </Text>
      <Text style={[styles.body, { color: theme.textMuted }]}>
        Through {record.providerLabel}, to {record.recipient}, sent {new Date(record.sentAt).toISOString().slice(11, 19)} UTC
        {record.senderKind === 'smart-account' ? ' from your smart account' : ''}.
      </Text>
      <Text accessibilityLiveRegion="polite" style={[styles.status, { color: failed ? theme.danger : theme.text }]}>
        {heading}
        {checking ? ' (checking…)' : ''}
      </Text>
      <Text style={[styles.body, { color: theme.text }]}>{bridgeStatusSentence(record)}</Text>
      {record.status && record.checkError ? (
        <Text style={[styles.body, { color: theme.textMuted }]}>The last check failed: {record.checkError}</Text>
      ) : null}
      <Text style={[styles.label, { color: theme.textMuted }]}>Sending transaction</Text>
      <Text selectable style={[styles.monoText, { color: theme.text }]}>
        {record.sourceTxHash ?? (record.userOpHash ? `not known yet (UserOperation ${record.userOpHash})` : 'not known yet')}
      </Text>
      {record.status?.destinationTxHash ? (
        <>
          <Text style={[styles.label, { color: theme.textMuted }]}>Receiving transaction</Text>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {record.status.destinationTxHash}
          </Text>
        </>
      ) : null}
      {record.retryTxHash ? (
        <>
          <Text style={[styles.label, { color: theme.textMuted }]}>Delivery transaction sent from this wallet</Text>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {record.retryTxHash}
          </Text>
        </>
      ) : null}
      {children}
    </View>
  );
}

/** A refusal or an error, shown in the shared warning panel. */
export function BridgeWarning({ text, announce = false }: { text: string; announce?: boolean }) {
  return <WarningBox announce={announce}>{text}</WarningBox>;
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  providerLabel: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  radioHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  radioOuter: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 10, height: 10, borderRadius: 5 },
  body: { fontSize: 13, lineHeight: 19 },
  strong: { fontWeight: '700' },
  status: { fontSize: 15, fontWeight: '700' },
  label: { fontSize: 13, fontWeight: '600', marginTop: 4 },
  monoText: { fontFamily: mono, fontSize: 13, lineHeight: 19 },
});

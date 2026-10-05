import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { formatUnits } from '../wallet/balances';
import { AA_DEPOSIT_NOTE, AA_DEPOSIT_ROW_LABEL, aaSelfPaidFeeSentence } from '../wallet/aa';

/**
 * The smart account's EntryPoint deposit on a self-paid smart-account
 * confirm: a row with the amount, the sentence saying who pays the fee
 * (aa.ts aaSelfPaidFeeSentence) and what the deposit is (AA_DEPOSIT_NOTE).
 * Renders nothing for a sponsored or token-fee operation, or when the
 * quote carries no deposit (none, or it could not be read); screens that
 * show the plain "pays its own gas from its own balance" sentence keep
 * showing it then.
 */
export function AaDepositNote({
  fee,
  deposit,
  sponsored,
  tokenGas = false,
  symbol,
}: {
  fee: bigint;
  deposit: bigint | undefined;
  sponsored: boolean;
  tokenGas?: boolean;
  symbol: string;
}) {
  const theme = useTheme();
  if (sponsored || tokenGas || deposit === undefined || deposit <= 0n) return null;
  const format = (wei: bigint) => `${formatUnits(wei, 18, 18)} ${symbol}`;
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Text style={[styles.label, { color: theme.textMuted }]}>{AA_DEPOSIT_ROW_LABEL}</Text>
      <Text selectable style={[styles.value, { color: theme.text }]}>
        {format(deposit)}
      </Text>
      <Text style={[styles.sub, { color: theme.textMuted }]}>
        {`${aaSelfPaidFeeSentence({ fee, deposit }, format)} ${AA_DEPOSIT_NOTE}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 10,
    gap: 4,
  },
  label: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  value: {
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  sub: {
    fontSize: 13,
    lineHeight: 19,
  },
});

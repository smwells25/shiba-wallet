import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { WarningBox } from '../components';
import { useTheme } from '../theme';
import { SET_CODE_WARNING, UPGRADE_RECEIVE_NOTE } from '../wallet/delegation';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/**
 * The EIP-7702 lines of a smart-account confirm screen (phase 8 item 1),
 * for a quote built on the 'kernel-7702' account type. When the operation
 * carries the authorization (the account is still a plain EOA), the user
 * is told plainly that this send also upgrades the account, with the
 * delegate in full; otherwise a one-line note says the account is already
 * upgraded and nothing is delegated by this operation. Renders nothing for
 * other account types.
 */
export function Eip7702QuoteNotice({
  eip7702,
  noun = 'send',
}: {
  eip7702: { upgrade: boolean; delegate: string } | undefined;
  /** "send", "swap" or "operation", for the headline. */
  noun?: string;
}) {
  const theme = useTheme();
  if (!eip7702) return null;
  if (!eip7702.upgrade) {
    return (
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Your account is already upgraded (Kernel v3.3 at your own address, EIP-7702). This{' '}
        {noun} carries no new delegation.
      </Text>
    );
  }
  return (
    <View style={styles.block}>
      <WarningBox>
        This {noun} also upgrades your account (EIP-7702 delegation to Kernel v3.3). {SET_CODE_WARNING}
      </WarningBox>
      <Text style={[styles.label, { color: theme.textMuted }]}>Delegate (Kernel v3.3 implementation)</Text>
      <Text selectable style={[styles.mono, { color: theme.text }]}>
        {eip7702.delegate}
      </Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Your address stays the same and your recovery phrase still controls it. You can undo the
        upgrade at any time from Upgrade this account. {UPGRADE_RECEIVE_NOTE}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
  },
  mono: {
    fontFamily: mono,
    fontSize: 13,
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
});

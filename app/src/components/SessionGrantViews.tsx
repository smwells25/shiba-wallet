import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { SessionKeyGrant } from '@shiba-wallet/chains-evm';
import { WarningBox } from '../components';
import { useTheme } from '../theme';
import { describeAllowedCall, describeGrantLimits } from '../wallet/sessions';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/**
 * The plain-language review of a session grant (phase 8 item 2), shared by
 * the Sessions screen and the WalletConnect ERC-7715 approval sheet so both
 * show exactly the same thing before the biometric gate: every allowed call
 * (target in full, function, per-call value cap, the "per call, not a
 * total" caveat, a warning for functions that grant lasting power), the
 * expiry, the gas budget, and the session key's address.
 */
export function GrantReview({
  grant,
  account,
  symbol,
  nameFor,
  sessionKeyHolder,
  permissionId,
}: {
  grant: SessionKeyGrant;
  /** The Kernel account the grant is installed into. */
  account: string;
  /** Native symbol of the active chain ("ETH", "test ETH"). */
  symbol: string;
  /** Exact-match contact name for an address, or null. */
  nameFor?: (address: string) => string | null;
  /** Who holds the session key, e.g. "this device" or the dApp's name. */
  sessionKeyHolder: string;
  permissionId?: string | null;
}) {
  const theme = useTheme();
  return (
    <View style={styles.block}>
      <Text style={[styles.label, { color: theme.textMuted }]}>
        The session may ONLY do the following ({grant.calls.length} allowed call
        {grant.calls.length === 1 ? '' : 's'}):
      </Text>
      {grant.calls.map((call, i) => {
        const d = describeAllowedCall(call, { symbol, account, ...(nameFor ? { nameFor } : {}) });
        return (
          <View
            key={`${call.target}-${call.selector ?? 'none'}-${i}`}
            style={[styles.call, { backgroundColor: theme.card, borderColor: theme.border }]}
          >
            <Text style={[styles.callTitle, { color: theme.text }]}>
              {i + 1}. {d.title}
            </Text>
            {d.details.map((line) => (
              <Text key={line} style={[styles.detail, { color: theme.textMuted }]}>
                {line}
              </Text>
            ))}
            {d.warning ? <WarningBox>{d.warning}</WarningBox> : null}
          </View>
        );
      })}
      {describeGrantLimits(grant, symbol).map((line) => (
        <Text key={line} style={[styles.limit, { color: theme.text }]}>
          {line}
        </Text>
      ))}
      <Text style={[styles.label, { color: theme.textMuted }]}>Session key (held by {sessionKeyHolder})</Text>
      <Text selectable style={[styles.mono, { color: theme.text }]}>
        {grant.sessionKey}
      </Text>
      {permissionId ? (
        <Text selectable style={[styles.detail, { color: theme.textMuted }]}>
          Kernel permission id {permissionId}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  label: { fontSize: 13, fontWeight: '600' },
  call: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 4 },
  callTitle: { fontSize: 15, fontWeight: '600' },
  detail: { fontSize: 13, lineHeight: 18 },
  limit: { fontSize: 14, lineHeight: 20 },
  mono: { fontFamily: mono, fontSize: 13 },
});

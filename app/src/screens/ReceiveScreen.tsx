import React, { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import * as Clipboard from 'expo-clipboard';
// react-native-qrcode-svg 6.3.26: pure JS (encoder = the `qrcode` npm
// package 1.5.4), rendered through react-native-svg. react-native-svg is
// pinned at 15.15.4 — the exact version bundled in the Expo Go SDK 57
// client (verified in the expo/expo repo, apps/expo-go/package.json on the
// sdk-57 branch, 2026-09-27), so the QR renders in Expo Go with no dev
// build. The encoder is round-tripped through an independent decoder in
// scripts/check-qr.mjs.
import QRCode from 'react-native-qrcode-svg';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, screenStyle } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { EVM_CHAIN_ID } from '../wallet/send';
import { useAccountDelegation } from '../wallet/useDelegation';
import { delegationLabelSuffix } from '../wallet/delegation';
import { useRecoveryInfo } from '../wallet/useRecoveryInfo';
import { RECOVERED_NOT_DERIVABLE_NOTE } from '../wallet/recovery';

type Props = NativeStackScreenProps<RootStackParamList, 'Receive'>;

/** Scannable QR + full-size address for one chain, with a copy button. */
export function ReceiveScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const { accounts, activeAccount } = useWallet();
  const account = accounts.find((a) => a.chainId === route.params.chainId);
  const [copied, setCopied] = useState(false);
  // EIP-7702 status (phase 8 item 1): "Account 1 · upgraded (Kernel v3.3)"
  // on the EVM slot, so the user knows which code runs at this address.
  const delegation = useAccountDelegation(
    route.params.chainId === EVM_CHAIN_ID ? (account?.address ?? null) : null,
  );
  // A recovered Kernel account (phase 8 item 4) attached to this account:
  // named here so the user knows its address is not this EOA's.
  const recovery = useRecoveryInfo(
    route.params.chainId === EVM_CHAIN_ID ? (account?.address ?? null) : null,
    activeAccount?.index ?? null,
  );
  // Sized for phone screens: fill the width minus the padding, capped so
  // tablets don't render a poster. The 16px white padding around the code
  // is the QR quiet zone, kept white in dark mode too so scanners lock on.
  const qrSize = Math.min(Math.round(width - 48 * 2), 260);

  useEffect(() => {
    navigation.setOptions({ title: account ? `Receive ${account.symbol}` : 'Receive' });
  }, [navigation, account]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  if (!account) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted }}>Unknown chain.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <View
        style={[styles.badge, { backgroundColor: account.accent }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={styles.badgeText}>{account.symbol}</Text>
      </View>
      <Text style={[styles.chainName, { color: theme.text }]}>{account.name}</Text>
      {activeAccount ? (
        <Text style={[styles.accountName, { color: theme.textMuted }]}>
          {activeAccount.name}
          {delegationLabelSuffix(delegation.status)}
        </Text>
      ) : null}
      {/*
        The QR payload is the plain address, nothing else. This screen has
        never built per-chain payment URIs (no amounts, no labels), and a
        bare address is what every major wallet's scanner accepts for all
        four chains — inventing a URI here would only narrow compatibility.
      */}
      <View
        style={styles.qrBox}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`QR code of your ${account.name} address`}
      >
        <QRCode value={account.address} size={qrSize} backgroundColor="#ffffff" color="#000000" />
      </View>
      <View
        style={[styles.addressBox, { backgroundColor: theme.card, borderColor: theme.border }]}
      >
        <Text selectable style={[styles.address, { color: theme.text }]}>
          {account.address}
        </Text>
      </View>
      <Text style={[styles.path, { color: theme.textMuted }]}>{account.path}</Text>
      {recovery.recoveredAccount ? (
        <View style={[styles.addressBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.note, { color: theme.text }]}>
            This account also controls a recovered smart account. The QR code above is this account’s own
            address, not the recovered one:
          </Text>
          <Text selectable style={[styles.address, { color: theme.text }]}>
            {recovery.recoveredAccount}
          </Text>
          <Text style={[styles.note, { color: theme.textMuted }]}>{RECOVERED_NOT_DERIVABLE_NOTE}</Text>
        </View>
      ) : null}
      {/*
        CLIPBOARD HYGIENE (phase 4, item 5.3): expo-clipboard is already
        the copy mechanism here. Its API offers no sensitive-content flag,
        no clipboard-history exclusion and no auto-expiry — verified
        against docs.expo.dev/versions/v57.0.0/sdk/clipboard and the
        installed 57.0.2 type definitions (SetStringOptions carries only
        inputFormat), so none of those are pretended. What CAN be done
        honestly: an address is public data (low sensitivity), and the
        note below tells the user the clipboard is readable by other apps.
        The seed phrase is never copyable anywhere in the app — see the
        deliberate display-only note in SettingsScreen.
      */}
      <Button
        title={copied ? 'Copied ✓' : 'Copy address'}
        onPress={async () => {
          await Clipboard.setStringAsync(account.address);
          setCopied(true);
        }}
      />
      {copied ? (
        <Text accessibilityLiveRegion="polite" style={[styles.note, { color: theme.textMuted }]}>
          Copied — note that the clipboard can be read by other apps.
        </Text>
      ) : null}
      <Button
        title={`Send ${account.symbol}`}
        variant="secondary"
        onPress={() => navigation.navigate('Send', { chainId: account.chainId })}
      />
      <Text style={[styles.note, { color: theme.textMuted }]}>
        Only send {account.symbol} on the {account.name} network to this
        address. Assets sent on other networks may be lost.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  accountName: {
    fontSize: 15,
    fontWeight: '600',
    marginTop: -8,
  },
  content: {
    padding: 24,
    alignItems: 'center',
    gap: 16,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  badgeText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  chainName: {
    fontSize: 22,
    fontWeight: '700',
  },
  qrBox: {
    backgroundColor: '#ffffff',
    padding: 16,
    borderRadius: 16,
  },
  addressBox: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 18,
    alignSelf: 'stretch',
  },
  address: {
    fontSize: 20,
    lineHeight: 30,
    textAlign: 'center',
    // 'monospace' only exists on Android; iOS ships Menlo.
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontVariant: ['tabular-nums'],
  },
  path: {
    fontSize: 13,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  note: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
});

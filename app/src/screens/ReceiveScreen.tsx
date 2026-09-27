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

type Props = NativeStackScreenProps<RootStackParamList, 'Receive'>;

/** Scannable QR + full-size address for one chain, with a copy button. */
export function ReceiveScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const { accounts } = useWallet();
  const account = accounts.find((a) => a.chainId === route.params.chainId);
  const [copied, setCopied] = useState(false);
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
      <View style={[styles.badge, { backgroundColor: account.accent }]}>
        <Text style={styles.badgeText}>{account.symbol}</Text>
      </View>
      <Text style={[styles.chainName, { color: theme.text }]}>{account.name}</Text>
      {/*
        The QR payload is the plain address, nothing else. This screen has
        never built per-chain payment URIs (no amounts, no labels), and a
        bare address is what every major wallet's scanner accepts for all
        four chains — inventing a URI here would only narrow compatibility.
      */}
      <View style={styles.qrBox}>
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
      <Button
        title={copied ? 'Copied ✓' : 'Copy address'}
        onPress={async () => {
          await Clipboard.setStringAsync(account.address);
          setCopied(true);
        }}
      />
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

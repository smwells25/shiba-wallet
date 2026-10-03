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
import { usePrefs } from '../wallet/PrefsContext';
import { getEndpoint } from '../config/networks';
import {
  getAaConfig,
  loadSmartAccountAddress,
  showsSmartAccountOnReceive,
  smartAccountAddressLabel,
  smartAccountDeploymentNote,
  type SmartAccountAddressInfo,
} from '../wallet/aa';

type Props = NativeStackScreenProps<RootStackParamList, 'Receive'>;

/** Scannable QR + full-size address for one chain, with a copy button. */
export function ReceiveScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const { accounts, activeAccount } = useWallet();
  const account = accounts.find((a) => a.chainId === route.params.chainId);
  const [copied, setCopied] = useState(false);
  const [smartCopied, setSmartCopied] = useState(false);
  const { evmChain } = usePrefs();
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

  // The active account's Kernel v3.3 smart account (phase 11 item 2): a
  // separate address, counterfactual until its first send deploys it, shown
  // as a second row with its own QR only when the active EVM chain's
  // smart-account settings are complete and the type is Kernel
  // (../wallet/aa.ts showsSmartAccountOnReceive). Read-only and node-only
  // (loadSmartAccountAddress, cached per account + chain); if it cannot be
  // read, the row is simply not shown. The state carries the key it was
  // read for, so a switched account or network never shows a stale address.
  const smartOwner = route.params.chainId === EVM_CHAIN_ID ? (account?.address ?? null) : null;
  const smartIndex = activeAccount?.index ?? null;
  const smartKey =
    smartOwner && smartIndex !== null ? `${evmChain.chainIdDecimal}|${smartIndex}|${smartOwner}` : null;
  const [smart, setSmart] = useState<{ key: string; info: SmartAccountAddressInfo } | null>(null);
  useEffect(() => {
    if (!smartKey || !smartOwner || smartIndex === null) return;
    let cancelled = false;
    (async () => {
      const endpoint = await getEndpoint(EVM_CHAIN_ID);
      if (!endpoint?.url || endpoint.network.kind !== 'evm-jsonrpc') return;
      // AA settings are keyed by the ACTIVE network's CAIP-2 id.
      const config = await getAaConfig(endpoint.network.chainId);
      if (!showsSmartAccountOnReceive(config, smartOwner)) return;
      const info = await loadSmartAccountAddress(config, {
        nodeUrl: endpoint.url,
        chainId: BigInt(evmChain.chainIdDecimal),
        accountIndex: smartIndex,
        ownerAddress: smartOwner,
      });
      if (!cancelled && info) setSmart({ key: smartKey, info });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [smartKey, smartOwner, smartIndex, evmChain.chainIdDecimal]);
  const smartInfo = smart && smart.key === smartKey ? smart.info : null;

  useEffect(() => {
    navigation.setOptions({ title: account ? `Receive ${account.symbol}` : 'Receive' });
  }, [navigation, account]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    if (!smartCopied) return;
    const t = setTimeout(() => setSmartCopied(false), 2000);
    return () => clearTimeout(t);
  }, [smartCopied]);

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
      {smartInfo ? (
        <View
          style={[
            styles.addressBox,
            styles.smartBox,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <Text style={[styles.smartTitle, { color: theme.text }]}>
            {smartAccountAddressLabel(smartInfo)}
          </Text>
          <Text style={[styles.note, { color: theme.textMuted }]}>
            A separate address controlled by this account{'\u2019'}s key. Funds sent here are
            spent with {'\u201c'}Send from smart account{'\u201d'}, and the smart account pays
            its own gas from them.
          </Text>
          <View
            style={styles.qrBox}
            accessible
            accessibilityRole="image"
            accessibilityLabel="QR code of your smart-account address"
          >
            <QRCode
              value={smartInfo.address}
              size={Math.min(qrSize, 200)}
              backgroundColor="#ffffff"
              color="#000000"
            />
          </View>
          <Text selectable style={[styles.address, { color: theme.text }]}>
            {smartInfo.address}
          </Text>
          <Text style={[styles.note, { color: theme.textMuted }]}>
            {smartAccountDeploymentNote(smartInfo.deployed)}
          </Text>
          <Button
            title={smartCopied ? 'Copied ✓' : 'Copy smart-account address'}
            variant="secondary"
            style={styles.stretch}
            onPress={async () => {
              await Clipboard.setStringAsync(smartInfo.address);
              setSmartCopied(true);
            }}
          />
          {smartCopied ? (
            <Text accessibilityLiveRegion="polite" style={[styles.note, { color: theme.textMuted }]}>
              Copied — note that the clipboard can be read by other apps.
            </Text>
          ) : null}
        </View>
      ) : null}
      <Button
        title={`Send ${account.symbol}`}
        variant="secondary"
        onPress={() => navigation.navigate('Send', { chainId: account.chainId })}
      />
      {account.chainId === EVM_CHAIN_ID ? (
        <Button
          title="Prove you own this address"
          variant="secondary"
          onPress={() => navigation.navigate('ProveOwnership')}
        />
      ) : null}
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
  smartBox: {
    alignItems: 'center',
    gap: 12,
  },
  stretch: {
    alignSelf: 'stretch',
  },
  smartTitle: {
    fontSize: 16,
    fontWeight: '700',
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

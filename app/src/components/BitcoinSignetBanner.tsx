import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { useI18n } from '../i18n/useI18n';
import { usePrefs } from '../wallet/PrefsContext';
import { bitcoinSignetBannerShown, bitcoinSignetText } from '../wallet/bitcoin-signet';

/**
 * The Bitcoin signet banner (phase 28 item 2), in the pattern of
 * SolanaDevnetBanner: the app-wide TESTNET banner (App.tsx) follows the
 * Ethereum network choice only, so it says nothing about the Bitcoin slot.
 * This one is drawn at the top of the Bitcoin screens (Receive, the Send form,
 * its confirm and success views, Activity) whenever "Use Bitcoin signet" is
 * on, whatever the Ethereum choice. Colours from the theme tokens of every
 * TESTNET badge (theme.testnetFill / onTestnetFill). Renders nothing
 * otherwise, and never on another slot (Dogecoin included).
 */
export function BitcoinSignetBanner({ chainId }: { chainId: string | undefined }) {
  const theme = useTheme();
  useI18n();
  const { bitcoinSignet } = usePrefs();
  if (!bitcoinSignetBannerShown(chainId, bitcoinSignet)) return null;
  return (
    <View style={[styles.banner, { backgroundColor: theme.testnetFill }]}>
      <Text style={[styles.text, { color: theme.onTestnetFill }]}>{bitcoinSignetText.banner()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  text: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});

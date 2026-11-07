import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { useI18n } from '../i18n/useI18n';
import { solanaDevnetBannerText } from '../i18n/banner';
import { usePrefs } from '../wallet/PrefsContext';
import { solanaDevnetBannerShown } from '../wallet/spl-tokens';

/**
 * The Solana devnet banner (pass p24-solana finding 2): the app-wide TESTNET
 * banner (App.tsx) follows the Ethereum network choice only, so on the
 * Solana screens it could name an Ethereum test network, or be absent while
 * Ethereum is on mainnet, while the Solana slot runs on devnet. This one is
 * drawn at the top of the Solana screens (Manage Solana tokens, the Solana
 * token send, Solana Activity, Receive SOL and the SOL send) whenever the
 * "Use Solana devnet" switch is on, whatever the Ethereum choice. Colours
 * from the theme tokens of every TESTNET badge (theme.testnetFill /
 * onTestnetFill). Renders nothing otherwise.
 */
export function SolanaDevnetBanner({ chainId }: { chainId: string | undefined }) {
  const theme = useTheme();
  useI18n();
  const { solanaDevnet } = usePrefs();
  if (!solanaDevnetBannerShown(chainId, solanaDevnet)) return null;
  return (
    <View style={[styles.banner, { backgroundColor: theme.testnetFill }]}>
      <Text style={[styles.text, { color: theme.onTestnetFill }]}>{solanaDevnetBannerText()}</Text>
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

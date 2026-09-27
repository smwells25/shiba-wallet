import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, screenStyle } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Welcome'>;

export function WelcomeScreen({ navigation }: Props) {
  const theme = useTheme();
  const { beginCreate } = useWallet();

  return (
    <View style={[screenStyle(theme), styles.container]}>
      <View style={styles.hero}>
        <Text style={styles.logo}>🐕</Text>
        <Text style={[styles.title, { color: theme.text }]}>Shiba Wallet</Text>
        <Text style={[styles.subtitle, { color: theme.textMuted }]}>
          A non-custodial multi-chain wallet. One seed phrase, generated and
          stored only on this device, controls Ethereum, Bitcoin, Dogecoin and
          Solana accounts.
        </Text>
      </View>
      <View style={styles.actions}>
        <Button
          title="Create a new wallet"
          onPress={() => {
            beginCreate();
            navigation.navigate('Backup');
          }}
        />
        <Button
          title="Import an existing wallet"
          variant="secondary"
          onPress={() => navigation.navigate('Import')}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 24,
    justifyContent: 'space-between',
  },
  hero: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  logo: {
    fontSize: 56,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 320,
  },
  actions: {
    gap: 12,
    paddingBottom: 24,
  },
});

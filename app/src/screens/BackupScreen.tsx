import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { usePreventScreenCapture } from 'expo-screen-capture';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, WordGrid, screenStyle } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Backup'>;

/**
 * Shows the freshly generated mnemonic (held only in memory until the user
 * passes the confirmation quiz) with the backup warning.
 */
export function BackupScreen({ navigation }: Props) {
  // The recovery phrase is on screen: block screenshots and screen
  // recording while this screen is mounted (Android FLAG_SECURE; iOS
  // best-effort per expo-screen-capture). Emulator-validation finding #3.
  usePreventScreenCapture();
  const theme = useTheme();
  const { pendingMnemonic } = useWallet();

  // Navigating here without an in-progress creation flow shows nothing
  // sensitive; the button back out is the only action.
  const words = pendingMnemonic ? pendingMnemonic.split(' ') : [];

  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.heading, { color: theme.text }]}>
        Your recovery phrase
      </Text>
      <WarningBox>
        These 12 words are the only backup of your wallet. Anyone who sees
        them can steal everything, and no one — including us — can recover
        them for you if they are lost. Write them down on paper, in order, and
        keep the paper offline. Do not screenshot them, do not store them in
        notes or cloud storage, and never type them into a website. The same
        words also back up every additional account you create later.
      </WarningBox>
      {/* Feature 12 (ADR D9): the one kind of account these words do not cover. */}
      <Text style={[styles.note, { color: theme.textMuted }]}>
        They do not back up private keys you import later (Settings → Accounts →
        Import a private key): an imported account is lost with this phone
        unless you keep its private key yourself.
      </Text>
      <WordGrid words={words} />
      <Button
        title="I wrote the words down"
        disabled={words.length === 0}
        onPress={() => navigation.navigate('ConfirmBackup')}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 20,
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
  },
  note: {
    fontSize: 13,
    lineHeight: 19,
  },
});

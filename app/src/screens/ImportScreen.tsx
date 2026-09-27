import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { isValidMnemonic } from '@shiba-wallet/core';
import { Button, WarningBox, screenStyle } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';

const VALID_WORD_COUNTS = [12, 15, 18, 21, 24];

/** Import an existing wallet from a BIP-39 mnemonic, with validation. */
export function ImportScreen() {
  const theme = useTheme();
  const { importExisting } = useWallet();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const normalized = input.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const onImport = async () => {
    setError(null);
    if (!VALID_WORD_COUNTS.includes(normalized.length)) {
      setError(
        `A recovery phrase has 12, 15, 18, 21 or 24 words — you entered ${normalized.length}.`,
      );
      return;
    }
    const mnemonic = normalized.join(' ');
    if (!isValidMnemonic(mnemonic)) {
      setError(
        'That is not a valid BIP-39 phrase. Check for a mistyped word — the last word also acts as a checksum over the others.',
      );
      return;
    }
    setBusy(true);
    try {
      // Saves to secure storage and derives addresses; the app switches to
      // the main screens automatically.
      await importExisting(mnemonic);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <KeyboardAvoidingView
      style={screenStyle(theme)}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.heading, { color: theme.text }]}>Import a wallet</Text>
        <WarningBox>
          Only enter a recovery phrase on a device you trust. Shiba Wallet
          stores it in the device keychain and never sends it anywhere.
        </WarningBox>
        <TextInput
          style={[
            styles.input,
            { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
          ]}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          placeholder="Enter your 12–24 word recovery phrase, separated by spaces"
          placeholderTextColor={theme.textMuted}
          value={input}
          onChangeText={(text) => {
            setInput(text);
            setError(null);
          }}
        />
        <Text style={[styles.count, { color: theme.textMuted }]}>
          {normalized.length} word{normalized.length === 1 ? '' : 's'}
        </Text>
        {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
        <Button
          title={busy ? 'Importing…' : 'Import wallet'}
          disabled={busy || normalized.length === 0}
          onPress={onImport}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 16,
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
  },
  input: {
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 120,
    padding: 14,
    fontSize: 16,
    textAlignVertical: 'top',
  },
  count: {
    fontSize: 13,
  },
  error: {
    fontSize: 14,
    lineHeight: 20,
  },
});

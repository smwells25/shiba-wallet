import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import type { RootStackParamList } from '../navigation';
import { Button, ImportedKeyNotice, WarningBox, screenStyle } from '../components';
import { QrScanner } from '../components/QrScanner';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { MAX_ACCOUNT_NAME_LENGTH } from '../wallet/accounts';
import {
  IMPORT_KEY_CLIPBOARD_WARNING,
  IMPORT_KEY_INTRO,
  IMPORT_KEY_SAVED_TITLE,
  IMPORT_KEY_TRUST_WARNING,
  importKeySavedMessage,
  parsePrivateKeyInput,
} from '../wallet/imported-keys';

type Props = NativeStackScreenProps<RootStackParamList, 'ImportKey'>;

/** Screen-capture guard key, distinct from the other screens' guards. */
const CAPTURE_KEY = 'import-private-key';

/**
 * Import a single Ethereum private key as an additional account (Tier 1
 * feature 12; ADR D9 in docs/ARCHITECTURE.md).
 *
 * Input hygiene: the field is a password field (secureTextEntry) with
 * autocorrect, autocomplete, autofill and spell-check off, so keyboards do
 * not learn or suggest the key; screenshots are blocked while the field
 * holds anything (expo-screen-capture, the same mechanism as the phrase
 * screens); the key leaves this screen's state as soon as it is saved, and
 * the user is told the clipboard may still hold it, with a button that
 * empties it. A QR code is read only through the shared scanner and goes
 * through exactly the same validation as typed or pasted text. Keys are
 * never accepted from WalletConnect or any other app.
 */
export function ImportKeyScreen({ navigation }: Props) {
  const theme = useTheme();
  const { importPrivateKey } = useWallet();
  const [input, setInput] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasText = input.length > 0;
  useEffect(() => {
    if (!hasText) return undefined;
    preventScreenCaptureAsync(CAPTURE_KEY).catch(() => {});
    return () => {
      allowScreenCaptureAsync(CAPTURE_KEY).catch(() => {});
    };
  }, [hasText]);

  // Engine-backed validation on every change: the full address is shown
  // before anything is saved.
  const parsed = useMemo(() => (hasText ? parsePrivateKeyInput(input) : null), [hasText, input]);

  const clearClipboard = () => {
    Clipboard.setStringAsync('').then(
      () => Alert.alert('Clipboard emptied', 'The wallet overwrote the clipboard with nothing.'),
      () => Alert.alert('Clipboard not emptied', 'The clipboard could not be overwritten. Copy something else to replace it.'),
    );
  };

  const onPaste = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      setInput(text.trim());
      setError(null);
    } catch {
      setError('The clipboard could not be read.');
    }
  };

  const doImport = async () => {
    if (!parsed?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const result = await importPrivateKey(input, name.trim() === '' ? null : name);
      // The key leaves this screen's state at once.
      setInput('');
      setName('');
      Alert.alert(
        IMPORT_KEY_SAVED_TITLE,
        importKeySavedMessage(result.account.name, result.account.evmAddress ?? '', result.protectionDetail),
        [
          { text: 'Clear clipboard', onPress: clearClipboard },
          { text: 'Done', onPress: () => navigation.goBack() },
        ],
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onImport = () => {
    if (!parsed?.ok) return;
    Alert.alert(
      'Import this key?',
      `It controls ${parsed.address}. The new account is NOT backed up by your recovery phrase: keep the ` +
        'private key safe yourself, or the account is lost with this phone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Import', onPress: () => void doImport() },
      ],
    );
  };

  return (
    <KeyboardAvoidingView style={screenStyle(theme)} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.heading, { color: theme.text }]}>Import a private key</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{IMPORT_KEY_INTRO}</Text>
        <ImportedKeyNotice />
        <WarningBox>{IMPORT_KEY_TRUST_WARNING}</WarningBox>

        <Text style={[styles.label, { color: theme.text }]}>Account name (optional)</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          maxLength={MAX_ACCOUNT_NAME_LENGTH * 2}
          placeholder="Imported N"
          placeholderTextColor={theme.textMuted}
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.card }]}
        />

        <Text style={[styles.label, { color: theme.text }]}>Ethereum private key</Text>
        <TextInput
          value={input}
          onChangeText={(text) => {
            setInput(text);
            setError(null);
          }}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
          spellCheck={false}
          textContentType="none"
          placeholder="64 hexadecimal characters, with or without 0x"
          placeholderTextColor={theme.textMuted}
          accessibilityLabel="Ethereum private key"
          accessibilityHint="Hidden while typing. Paste or scan the key; the address it controls appears below."
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.card }]}
        />
        <View style={styles.row}>
          <Button title="Paste" variant="secondary" onPress={() => void onPaste()} style={styles.flex} />
          <Button title="Scan QR code" variant="secondary" onPress={() => setScanning(true)} style={styles.flex} />
          <Button
            title="Clear"
            variant="secondary"
            disabled={!hasText}
            onPress={() => {
              setInput('');
              setError(null);
            }}
            style={styles.flex}
          />
        </View>

        {parsed?.ok ? (
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.label, { color: theme.text }]}>This key controls the Ethereum address</Text>
            <Text selectable style={[styles.address, { color: theme.text }]}>
              {parsed.address}
            </Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Check that this is the address you expect before importing.
            </Text>
          </View>
        ) : parsed && !parsed.ok ? (
          <Text style={[styles.error, { color: theme.danger }]}>{parsed.error}</Text>
        ) : null}
        {error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}

        <Button title={busy ? 'Importing…' : 'Import key'} disabled={busy || !parsed?.ok} onPress={onImport} />
        <Text style={[styles.hint, { color: theme.textMuted }]}>{IMPORT_KEY_CLIPBOARD_WARNING}</Text>
        <Button title="Clear clipboard" variant="secondary" onPress={clearClipboard} />
      </ScrollView>
      <QrScanner
        visible={scanning}
        rationale="Point the camera at a QR code of an Ethereum private key. The camera is only used to read the code, and the key is checked exactly like a pasted one."
        onScanned={(data) => {
          setScanning(false);
          setInput(data.trim());
          setError(null);
        }}
        onClose={() => setScanning(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 14,
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  flex: {
    flex: 1,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 6,
  },
  address: {
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  error: {
    fontSize: 14,
    lineHeight: 20,
  },
});

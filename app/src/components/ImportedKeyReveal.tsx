import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { Button, ImportedKeyNotice, WarningBox } from '../components';
import { useTheme } from '../theme';
import { createClipboardAutoClear } from '../wallet/subscriptions';
import { REVEAL_IMPORTED_COPY_NOTE } from '../wallet/imported-keys';

/** Screen-capture guard key, distinct from the phrase reveal's ('seed-reveal'). */
const CAPTURE_KEY = 'imported-key-reveal';

/**
 * One clipboard helper for the session (module level), so a copied key is
 * still overwritten after the view that copied it has closed. Same helper
 * and 60-second rule as the subscription-key hand-over.
 */
const keyClipboard = createClipboardAutoClear({ setString: (text) => Clipboard.setStringAsync(text) });

/**
 * "Show private key" for an imported account (feature 12). The caller has
 * already shown the confirmation and passed the same biometric gate as the
 * recovery-phrase reveal; this view blocks screenshots while it is open
 * (FLAG_SECURE on Android, as on the phrase reveal). Unlike the phrase, a
 * private key is 64 characters that are hard to copy by hand, so a Copy
 * button is offered, with the clipboard emptied 60 seconds later and when
 * the view closes; keeping a copy of the key is the only backup this
 * account has.
 */
export function ImportedKeyReveal({
  accountName,
  address,
  privateKey,
  onClose,
}: {
  accountName: string;
  address: string;
  privateKey: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  const copied = useSyncExternalStore(keyClipboard.subscribe, keyClipboard.pending, keyClipboard.pending);
  const closing = useRef(false);

  useEffect(() => {
    preventScreenCaptureAsync(CAPTURE_KEY).catch(() => {});
    return () => {
      allowScreenCaptureAsync(CAPTURE_KEY).catch(() => {});
      // Leaving the view empties a copy that is still pending.
      void keyClipboard.clearNow().catch(() => undefined);
    };
  }, []);

  const [copyError, setCopyError] = useState<string | null>(null);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    onClose();
  };

  return (
    <Modal visible animationType="slide" onRequestClose={close}>
      <ScrollView contentContainerStyle={[styles.content, { backgroundColor: theme.background }]}>
        <Text style={[styles.title, { color: theme.text }]}>{accountName}</Text>
        <Text style={[styles.address, { color: theme.textMuted }]}>{address}</Text>
        <ImportedKeyNotice />
        <WarningBox>
          Never share this key. Anyone who has it controls this account. Shiba Wallet support will never
          ask for it. Hide it again as soon as you are done.
        </WarningBox>
        <View style={[styles.keyBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.key, { color: theme.text }]} accessibilityLabel="Private key">
            {privateKey}
          </Text>
        </View>
        <Button
          title={copied ? 'Copied ✓ (emptied after 60 seconds)' : 'Copy private key'}
          variant="secondary"
          onPress={() => {
            setCopyError(null);
            keyClipboard.copy(privateKey).catch(() => setCopyError('The key could not be copied.'));
          }}
        />
        {copyError ? <Text style={[styles.note, { color: theme.danger }]}>{copyError}</Text> : null}
        <Text style={[styles.note, { color: theme.textMuted }]}>{REVEAL_IMPORTED_COPY_NOTE}</Text>
        <Button title="Hide private key" onPress={close} />
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    padding: 24,
    paddingTop: 48,
    gap: 14,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
  },
  address: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  keyBox: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
  },
  key: {
    fontSize: 15,
    fontVariant: ['tabular-nums'],
    lineHeight: 22,
  },
  note: {
    fontSize: 13,
    lineHeight: 19,
  },
});

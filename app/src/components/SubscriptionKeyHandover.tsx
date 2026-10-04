import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
// The same file-sharing mechanism as components/RecordFileActions.tsx:
// expo-file-system 57.0.7 (File, Directory, Paths) and expo-sharing 57.0.22
// (isAvailableAsync, shareAsync with mimeType / UTI / dialogTitle; the
// promise resolves when the share sheet closes). See that file's header for
// the API sources.
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Button } from '../components';
import { useTheme } from '../theme';
import {
  SUBSCRIPTION_KEY_CLIPBOARD_WARNING,
  SUBSCRIPTION_KEY_FILE_DIRECTORY,
  SUBSCRIPTION_KEY_FILE_MIME_TYPE,
  SUBSCRIPTION_KEY_FILE_UTI,
  createClipboardAutoClear,
  shareSubscriptionKeyFile,
  type SecretFileShareDeps,
} from '../wallet/subscriptions';

function deleteQuietly(item: { delete: () => void }): void {
  try {
    item.delete();
  } catch {
    // Already gone or locked: the next sweep removes it.
  }
}

/** Deletes every leftover hand-over file in the cache directory. */
export function sweepSubscriptionKeyFiles(): void {
  try {
    const dir = new Directory(Paths.cache, SUBSCRIPTION_KEY_FILE_DIRECTORY);
    if (dir.exists) {
      for (const item of dir.list()) deleteQuietly(item);
    }
  } catch {
    // Nothing to sweep.
  }
}

const fileDeps: SecretFileShareDeps = {
  available: () => Sharing.isAvailableAsync(),
  sweep: sweepSubscriptionKeyFiles,
  write: (name, text) => {
    const dir = new Directory(Paths.cache, SUBSCRIPTION_KEY_FILE_DIRECTORY);
    dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, name);
    file.create({ overwrite: true });
    file.write(text);
    return { uri: file.uri, remove: () => deleteQuietly(file) };
  },
  share: (uri) =>
    Sharing.shareAsync(uri, {
      mimeType: SUBSCRIPTION_KEY_FILE_MIME_TYPE,
      UTI: SUBSCRIPTION_KEY_FILE_UTI,
      dialogTitle: 'Send the subscription key to the merchant',
    }),
  schedule: (fn, ms) => {
    setTimeout(fn, ms);
  },
};

/**
 * One clipboard helper for the whole app session (module level), so a copied
 * key is still overwritten after the screen that copied it has closed.
 */
const keyClipboard = createClipboardAutoClear({ setString: (text) => Clipboard.setStringAsync(text) });

/**
 * The hand-over actions on the subscription key screen: share the payload as
 * a .json FILE (never as plain shared text) and copy it with an automatic
 * overwrite. Leaving the screen overwrites a still-pending copy and deletes
 * any leftover file. The screen itself blocks screenshots (SessionsScreen).
 */
export function SubscriptionKeyHandoverActions({ text, fileName }: { text: string; fileName: string }) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  // "Copied ✓" follows the helper's pending state, so the mark clears as soon
  // as the wallet empties the clipboard (after 60 s, on return to the
  // foreground after that, or when the screen closes).
  const copied = useSyncExternalStore(keyClipboard.subscribe, keyClipboard.pending);

  useEffect(
    () => () => {
      void keyClipboard.clearNow().catch(() => undefined);
      sweepSubscriptionKeyFiles();
    },
    [],
  );

  return (
    <View style={styles.stack}>
      <Button
        title={busy ? 'Preparing the file…' : 'Share as a file (.json)'}
        variant="secondary"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          shareSubscriptionKeyFile(text, fileName, fileDeps).then(
            () => setBusy(false),
            (e: unknown) => {
              setBusy(false);
              Alert.alert('File not shared', e instanceof Error ? e.message : String(e));
            },
          );
        }}
      />
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Sends the key as a .json file through the share sheet. Choose a channel you trust; the temporary copy on
        this phone is deleted a few seconds after the share sheet closes.
      </Text>
      <Button
        title={copied ? 'Copied ✓' : 'Copy'}
        variant="secondary"
        onPress={() => {
          keyClipboard.copy(text).catch((e: unknown) =>
            Alert.alert('Not copied', e instanceof Error ? e.message : String(e)),
          );
        }}
      />
      <Text style={[styles.hint, { color: theme.warningText }]}>{SUBSCRIPTION_KEY_CLIPBOARD_WARNING}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8 },
  hint: { fontSize: 13, lineHeight: 19 },
});

import React, { useMemo, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, View } from 'react-native';
// expo-document-picker 57.0.3: getDocumentAsync({ type, copyToCacheDirectory,
// multiple }) → { canceled, assets: [{ uri, name }] } (build/types.d.ts:
// `type` accepts MIME types and wildcards; '*/*' allows any document).
import * as DocumentPicker from 'expo-document-picker';
// expo-file-system 57.0.7 object API: new File(uri).text() / delete().
import { File } from 'expo-file-system';
import { Button, WarningBox } from '../components';
import { RecordFileReadError, shareTextFile } from '../components/RecordFileActions';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { RECORDS_BACKUP_PHRASE_ACCOUNT_ONLY } from '../wallet/storage';
import type { OwnAccount } from '../wallet/multisig';
import {
  RECORDS_BACKUP_CONFIRM_TITLE,
  RECORDS_BACKUP_DIALOG_TITLE,
  RECORDS_BACKUP_DIRECTORY,
  RECORDS_BACKUP_EXPORT_BUTTON,
  RECORDS_BACKUP_FILE_NOTE,
  RECORDS_BACKUP_IMPORT_BUTTON,
  RECORDS_BACKUP_KEY_NOTE,
  RECORDS_BACKUP_MERGE_NOTE,
  RECORDS_BACKUP_MIME_TYPE,
  RECORDS_BACKUP_NOT_INCLUDED_NOTE,
  RECORDS_BACKUP_SECTION_TITLE,
  RECORDS_BACKUP_SHARE_UNAVAILABLE,
  RECORDS_BACKUP_UTI,
  RECORDS_BACKUP_WHAT_NOTE,
  describeRecordsExport,
  describeRecordsImport,
  exportRecordsBackup,
  importRecordsBackup,
  parseRecordsBackupFile,
} from '../wallet/records-backup';
import { T } from '../i18n/T';
import { useI18n } from '../i18n/useI18n';

/** "The file was not restored: <sentence>" — every refusal is a plain sentence. */
export const RECORDS_BACKUP_IMPORT_REFUSED_PREFIX = 'The file was not restored:';

/**
 * Opens the system picker for one file and returns its text, or null when
 * cancelled. The same read rules as RecordFileActions.tsx pickRecordFile
 * (Android: read the original content:// uri, never a cache copy, which Expo
 * Go may not be allowed to read; iOS: read the cache copy and delete it),
 * but for any document type: the backup is a .txt file of base64, and its
 * contents are checked (and authenticated) anyway.
 */
async function pickBackupFile(): Promise<string | null> {
  const copyToCacheDirectory = Platform.OS !== 'android';
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory, multiple: false });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  const file = new File(asset.uri);
  try {
    return await file.text();
  } catch (e) {
    throw new RecordFileReadError(e);
  } finally {
    if (copyToCacheDirectory) {
      try {
        file.delete();
      } catch {
        // Already gone: the system clears the cache in time.
      }
    }
  }
}

/** Settings → Records backup (feature 47): export and restore of the wallet's records. */
export function RecordsBackupSection() {
  const theme = useTheme();
  // The section's notes through the string table (phase 23 item 8); the
  // status lines (counts per kind of record) stay as written.
  const { localize, tx } = useI18n();
  const { activeAccount, accountList, deriveRecordsBackupKey } = useWallet();
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [status, setStatus] = useState<{ lines: string[]; warning: boolean } | null>(null);

  // The backup belongs to the recovery phrase: refused while an imported,
  // watched or multi-signature account is active (nothing is read).
  const phraseAccountActive = !!activeAccount && !activeAccount.imported && !activeAccount.watchOnly && !activeAccount.multisig;

  const ownAccounts = useMemo<OwnAccount[]>(
    () =>
      accountList
        .filter((a) => a.evmAddress)
        .map((a) => ({ name: a.name, address: a.evmAddress!, kind: a.imported ? ('imported' as const) : ('phrase' as const) })),
    [accountList],
  );

  const onExport = async () => {
    if (!phraseAccountActive) {
      setStatus({ lines: [RECORDS_BACKUP_PHRASE_ACCOUNT_ONLY], warning: true });
      return;
    }
    setBusy('export');
    setStatus(null);
    try {
      const made = await exportRecordsBackup({ deriveKey: (salt) => deriveRecordsBackupKey(salt, 'export') });
      await shareTextFile({
        directory: RECORDS_BACKUP_DIRECTORY,
        fileName: () => made.fileName,
        contents: () => made.text,
        mimeType: RECORDS_BACKUP_MIME_TYPE,
        UTI: RECORDS_BACKUP_UTI,
        dialogTitle: RECORDS_BACKUP_DIALOG_TITLE,
        unavailableMessage: RECORDS_BACKUP_SHARE_UNAVAILABLE,
      });
      setStatus({ lines: [describeRecordsExport(made)], warning: false });
    } catch (e) {
      setStatus({ lines: [e instanceof Error ? e.message : String(e)], warning: true });
    } finally {
      setBusy(null);
    }
  };

  const restore = async (text: string) => {
    setBusy('import');
    try {
      const report = await importRecordsBackup({
        text,
        deriveKey: (salt) => deriveRecordsBackupKey(salt, 'import'),
        context: { ownAccounts },
      });
      setStatus({ lines: describeRecordsImport(report), warning: report.stoppedAt !== null });
    } catch (e) {
      setStatus({ lines: [`${RECORDS_BACKUP_IMPORT_REFUSED_PREFIX} ${e instanceof Error ? e.message : String(e)}`], warning: true });
    } finally {
      setBusy(null);
    }
  };

  const onImport = async () => {
    if (!phraseAccountActive) {
      setStatus({ lines: [RECORDS_BACKUP_PHRASE_ACCOUNT_ONLY], warning: true });
      return;
    }
    setStatus(null);
    let text: string | null;
    try {
      text = await pickBackupFile();
    } catch (e) {
      setStatus({ lines: [`${RECORDS_BACKUP_IMPORT_REFUSED_PREFIX} ${e instanceof Error ? e.message : String(e)}`], warning: true });
      return;
    }
    if (text === null) return;
    // A file that is not a backup is refused here, before any prompt.
    try {
      parseRecordsBackupFile(text);
    } catch (e) {
      setStatus({ lines: [`${RECORDS_BACKUP_IMPORT_REFUSED_PREFIX} ${e instanceof Error ? e.message : String(e)}`], warning: true });
      return;
    }
    const chosen = text;
    Alert.alert(localize(RECORDS_BACKUP_CONFIRM_TITLE), localize(RECORDS_BACKUP_MERGE_NOTE), [
      { text: tx('Cancel'), style: 'cancel' },
      { text: tx('Restore'), onPress: () => void restore(chosen) },
    ]);
  };

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}><T>{RECORDS_BACKUP_SECTION_TITLE}</T></Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{localize(RECORDS_BACKUP_WHAT_NOTE)}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{localize(RECORDS_BACKUP_KEY_NOTE)}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{localize(RECORDS_BACKUP_NOT_INCLUDED_NOTE)}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{localize(RECORDS_BACKUP_MERGE_NOTE)}</Text>
      <Button
        title={busy === 'export' ? 'Preparing the backup…' : RECORDS_BACKUP_EXPORT_BUTTON}
        variant="secondary"
        disabled={busy !== null}
        onPress={() => void onExport()}
      />
      <Text style={[styles.hint, { color: theme.textMuted }]}>{localize(RECORDS_BACKUP_FILE_NOTE)}</Text>
      <Button
        title={busy === 'import' ? 'Restoring…' : RECORDS_BACKUP_IMPORT_BUTTON}
        variant="secondary"
        disabled={busy !== null}
        onPress={() => void onImport()}
      />
      {status ? (
        status.warning ? (
          <WarningBox announce>{status.lines.join('\n')}</WarningBox>
        ) : (
          <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.text }]}>
            {status.lines.join('\n')}
          </Text>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
});

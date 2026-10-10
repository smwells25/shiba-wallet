import React, { useState } from 'react';
import { Alert, Text } from 'react-native';
// expo-file-system 57.0.7 (the object API: File, Directory, Paths). Verified
// against https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/ ("Included
// in Expo Go") and the installed typings (build/File.d.ts,
// build/internal/NativeFileSystem.types.d.ts, build/Paths.d.ts): `new
// File(Paths.cache, dir, name)`, `create({ overwrite })`, `write(string)`,
// `text()`, `delete()`, `exists`; `new Directory(...)`, `create({
// intermediates, idempotent })`, `list()`. The legacy function API
// (expo-file-system/legacy) is not used.
import { Directory, File, Paths } from 'expo-file-system';
// expo-sharing 57.0.22: isAvailableAsync() and shareAsync(fileUrl, { mimeType,
// UTI, dialogTitle }) per https://docs.expo.dev/versions/v57.0.0/sdk/sharing/
// and build/Sharing.d.ts / Sharing.types.d.ts. The promise resolves when the
// share sheet closes (Android: the chooser's activity result; iOS:
// UIActivityViewController's completion handler — SharingModule.kt /
// SharingModule.swift in the installed package).
import * as Sharing from 'expo-sharing';
// expo-document-picker 57.0.3: getDocumentAsync({ type, copyToCacheDirectory,
// multiple }) → { canceled, assets: [{ uri, name, size, mimeType }] } per
// https://docs.expo.dev/versions/v57.0.0/sdk/document-picker/ and
// build/types.d.ts. copyToCacheDirectory (default true) is what lets
// expo-file-system read the picked file.
import * as DocumentPicker from 'expo-document-picker';
import type { KernelRecoveryMetadata } from '@shiba-wallet/chains-evm';
import { Button } from '../components';
import { useTheme } from '../theme';
import {
  RECORD_EXPORT_DIRECTORY,
  RECORD_FILE_MIME_TYPE,
  RECORD_FILE_UTI,
  recordExportFileName,
  recordFileContents,
} from '../wallet/recovery';
import { recoveryLayout as styles } from './RecoveryViews';

/**
 * How long the exported file stays after the share sheet closes. On Android
 * the share promise resolves when the chosen app's activity returns
 * (startActivityForResult on the chooser), and some apps (for example a
 * cloud-drive upload) keep reading the shared content URI from a background
 * service after that, so deleting at once could leave the user with an empty
 * backup. A short grace period keeps the backup intact; the next export also
 * sweeps the directory, and the system may clear the cache at any time. The
 * record contains no secrets, so the brief extra lifetime costs nothing.
 */
export const RECORD_EXPORT_DELETE_DELAY_MS = 60_000;

function deleteQuietly(item: { delete: () => void }): void {
  try {
    item.delete();
  } catch {
    // Already gone or locked: the next export sweeps the directory.
  }
}

/**
 * Writes `contents` to `fileName` in its own directory under the app's cache
 * directory and opens the OS share sheet. Leftovers from earlier exports in
 * that directory are removed first; this export's file is deleted
 * RECORD_EXPORT_DELETE_DELAY_MS after the share sheet closes (at once if
 * sharing fails). Shared by the recovery record and the Activity export
 * (wallet/notes.ts), so both follow the same delete-after-share discipline.
 * The name and the contents are produced lazily, at the same points as
 * before this helper existed, so the record export's order of steps (and
 * what is left behind if producing either one throws) is unchanged.
 */
export async function shareTextFile(options: {
  directory: string;
  fileName: () => string;
  contents: () => string;
  mimeType: string;
  UTI: string;
  dialogTitle: string;
  unavailableMessage: string;
}): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error(options.unavailableMessage);
  }
  const dir = new Directory(Paths.cache, options.directory);
  if (dir.exists) {
    for (const item of dir.list()) deleteQuietly(item);
  }
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, options.fileName());
  file.create({ overwrite: true });
  file.write(options.contents());
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: options.mimeType,
      UTI: options.UTI,
      dialogTitle: options.dialogTitle,
    });
  } catch (e) {
    deleteQuietly(file);
    throw e;
  }
  setTimeout(() => deleteQuietly(file), RECORD_EXPORT_DELETE_DELAY_MS);
}

/**
 * Writes the record (the engine's canonical JSON, unchanged) to a .json file
 * in the app's cache directory and opens the OS share sheet, so the user can
 * save it to cloud storage or a files app. Leftovers from earlier exports are
 * removed first; this export's file is deleted RECORD_EXPORT_DELETE_DELAY_MS
 * after the share sheet closes (at once if sharing fails). The record contains
 * no secrets.
 */
export async function shareRecordFile(meta: KernelRecoveryMetadata): Promise<void> {
  await shareTextFile({
    directory: RECORD_EXPORT_DIRECTORY,
    fileName: () => recordExportFileName(meta),
    contents: () => recordFileContents(meta),
    mimeType: RECORD_FILE_MIME_TYPE,
    UTI: RECORD_FILE_UTI,
    dialogTitle: 'Save the recovery record',
    unavailableMessage: 'Sharing files is not available on this device. Use Share… or Copy instead.',
  });
}

/**
 * Opens the system document picker for one JSON file and returns its text
 * and what the picker reported about it, or null when the user cancelled.
 * The picker's cache copy is deleted after reading. The caller passes the
 * result to recovery.ts parseRecordFile, then into the existing import path.
 */
export async function pickRecordFile(): Promise<{
  text: string;
  name: string;
  size: number | null;
  mimeType: string | null;
} | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: RECORD_FILE_MIME_TYPE,
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  const file = new File(asset.uri);
  try {
    const text = await file.text();
    return { text, name: asset.name, size: asset.size ?? null, mimeType: asset.mimeType ?? null };
  } finally {
    // The picker's private copy in the cache directory is no longer needed.
    deleteQuietly(file);
  }
}

/** "Export as file" button with a one-line note; errors are shown plainly. */
export function RecordFileExportButton({ metadata }: { metadata: KernelRecoveryMetadata }) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        title={busy ? 'Preparing the file…' : 'Export as file (.json)'}
        variant="secondary"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          shareRecordFile(metadata).then(
            () => setBusy(false),
            (e: unknown) => {
              setBusy(false);
              Alert.alert('File not shared', e instanceof Error ? e.message : String(e));
            },
          );
        }}
      />
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Saves the record as a .json file through the share sheet (for example to your cloud drive). The temporary
        copy on this phone is deleted a minute after the share sheet closes.
      </Text>
    </>
  );
}

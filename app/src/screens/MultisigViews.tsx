import React, { useState } from 'react';
import { Alert, Text, View } from 'react-native';
// expo-file-system 57 object API and expo-sharing 57, exactly as
// components/RecordFileActions.tsx uses them (its comments carry the
// documentation and typings checks); only the file name and contents differ.
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { toHex, type Call, type MultisigConfig } from '@shiba-wallet/chains-evm';
import { Button, WarningBox } from '../components';
import { useTheme } from '../theme';
import { formatUnits } from '../wallet/balances';
import { recoveryLayout as styles } from '../components/RecoveryViews';
import { RECORD_EXPORT_DELETE_DELAY_MS } from '../components/RecordFileActions';
import {
  MULTISIG_ERC1271_REFUSAL,
  MULTISIG_EXPORT_DIRECTORY,
  MULTISIG_FEES_LINE,
  MULTISIG_UNAUDITED_NOTE,
  multisigExposureLine,
  multisigFeatureRefusal,
} from '../wallet/multisig';

/**
 * The honesty lines every multisig screen shows (docs/MULTISIG.md section
 * 11): the exposure (operations versus messages) when a signer set is
 * known, what co-signers approve and what they do not, that the account
 * never signs messages, and the audit status. Never collapsed.
 */
export function MultisigHonesty({ config }: { config: MultisigConfig | null }) {
  const theme = useTheme();
  let exposure: string | null = null;
  if (config) {
    try {
      exposure = multisigExposureLine(config);
    } catch {
      exposure = null;
    }
  }
  return (
    <View style={styles.card}>
      {exposure ? <WarningBox>{exposure}</WarningBox> : null}
      <Text style={[styles.hint, { color: theme.text }]}>{MULTISIG_FEES_LINE}</Text>
      <Text style={[styles.hint, { color: theme.text }]}>{MULTISIG_ERC1271_REFUSAL}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{MULTISIG_UNAUDITED_NOTE}</Text>
    </View>
  );
}

/** What is refused for a multisig, and why (collision versus not offered versus not applicable). */
export function MultisigRefusedFeatures() {
  const theme = useTheme();
  return (
    <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.card }]}>
      <Text style={[styles.cardTitle, { color: theme.text }]}>Not available for a multi-signature account</Text>
      {(['walletconnect', 'browser', 'guardians', 'inheritance', 'passkeys', 'session-keys', 'eip7702', 'owner-rotation'] as const).map(
        (f) => (
          <Text key={f} style={[styles.hint, { color: theme.textMuted }]}>
            • {multisigFeatureRefusal(f)}
          </Text>
        ),
      )}
    </View>
  );
}

/** Every call in full: target, value (formatted and in wei), and the complete call data. */
export function MultisigCallsView({
  calls,
  described,
  nativeSymbol,
}: {
  calls: readonly Call[];
  described: readonly string[];
  nativeSymbol: string;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.card }]}>
      <Text style={[styles.cardTitle, { color: theme.text }]}>
        {calls.length === 1 ? 'The call' : `The ${calls.length} calls (one atomic operation)`}
      </Text>
      {calls.map((c, i) => (
        <View key={`${c.to}-${i}`} style={styles.card}>
          <Text style={[styles.hint, { color: theme.text }]}>
            {i + 1}. {described[i] ?? ''}
          </Text>
          <Text selectable style={[styles.mono, { color: theme.textMuted }]}>
            to {c.to}
          </Text>
          <Text selectable style={[styles.mono, { color: theme.textMuted }]}>
            value {formatUnits(c.value, 18, 18)} {nativeSymbol} ({c.value.toString()} wei)
          </Text>
          <Text selectable style={[styles.mono, { color: theme.textMuted }]}>
            data {toHex(c.data)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function deleteQuietly(item: { delete: () => void }): void {
  try {
    item.delete();
  } catch {
    // Already gone or locked: the next export sweeps the directory.
  }
}

/**
 * Writes `text` (one JSON object, no secrets) to a .json file in the app's
 * cache directory and opens the share sheet, the same way
 * components/RecordFileActions.tsx shareRecordFile does for recovery records
 * (earlier exports swept first; this file deleted
 * RECORD_EXPORT_DELETE_DELAY_MS after the sheet closes, at once on failure).
 */
async function shareJsonFile(text: string, fileName: string, dialogTitle: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing files is not available on this device. Use Share… or Copy instead.');
  }
  const dir = new Directory(Paths.cache, MULTISIG_EXPORT_DIRECTORY);
  if (dir.exists) {
    for (const item of dir.list()) deleteQuietly(item);
  }
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, fileName);
  file.create({ overwrite: true });
  file.write(text);
  try {
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle });
  } catch (e) {
    deleteQuietly(file);
    throw e;
  }
  setTimeout(() => deleteQuietly(file), RECORD_EXPORT_DELETE_DELAY_MS);
}

/** "Save as file (.json)" for a multisig payload; errors are shown plainly. */
export function MultisigFileExportButton({ text, fileName, dialogTitle }: { text: string; fileName: string; dialogTitle: string }) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        title={busy ? 'Preparing the file…' : 'Save as file (.json)'}
        variant="secondary"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          shareJsonFile(text, fileName, dialogTitle).then(
            () => setBusy(false),
            (e: unknown) => {
              setBusy(false);
              Alert.alert('File not shared', e instanceof Error ? e.message : String(e));
            },
          );
        }}
      />
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Shares the text as a .json file (for example to a messaging app or your cloud drive). It contains no secrets;
        the temporary copy on this phone is deleted a minute after the share sheet closes.
      </Text>
    </>
  );
}

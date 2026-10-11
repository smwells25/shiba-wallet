import React, { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { toHex, type Call, type MultisigConfig } from '@shiba-wallet/chains-evm';
import { Button, WarningBox } from '../components';
import { useTheme } from '../theme';
import { formatUnits } from '../wallet/balances';
import { PayloadQr, recoveryLayout as styles } from '../components/RecoveryViews';
import { shareTextFile } from '../components/RecordFileActions';
import { QrScanner } from '../components/QrScanner';
import {
  MULTISIG_ERC1271_REFUSAL,
  MULTISIG_EXPORT_DIRECTORY,
  MULTISIG_FEES_LINE,
  MULTISIG_FILE_MIME_TYPE,
  MULTISIG_FILE_UTI,
  MULTISIG_QR_TOO_LARGE,
  MULTISIG_SCAN_NEXT_TITLE,
  MULTISIG_SCAN_START_OVER_TITLE,
  MULTISIG_UNAUDITED_NOTE,
  acceptMultisigQrScan,
  multisigCosignerBarLabel,
  multisigExposureLine,
  multisigFeatureRefusal,
  multisigFileContents,
  multisigLocalSignsLine,
  multisigQrPagedNote,
  multisigQrPartCaption,
  multisigQrProgressLine,
  splitMultisigQrParts,
  type MultisigQrScan,
  type MultisigWeightProgress,
} from '../wallet/multisig';

/**
 * The honesty lines every multisig screen shows (docs/MULTISIG.md section
 * 11): the exposure (operations versus messages) when a signer set is
 * known, what co-signers approve and what they do not, that the account
 * never signs messages, and the audit status. Never collapsed.
 */
export function MultisigHonesty({ config, localSigner = null }: { config: MultisigConfig | null; localSigner?: string | null }) {
  const theme = useTheme();
  let exposure: string | null = null;
  if (config) {
    try {
      exposure = multisigExposureLine(config, localSigner);
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

/**
 * The approvals bar: the CO-SIGNER weight collected versus the co-signer
 * weight still needed (the threshold minus this wallet's weight), then a
 * separate line saying this wallet signs its weight only when you submit
 * (multisig.ts multisigWeightProgress explains the decision).
 */
export function MultisigWeightBar({ progress }: { progress: MultisigWeightProgress }) {
  const theme = useTheme();
  const need = progress.cosignerNeeded;
  const pct = need > 0 ? Math.max(0, Math.min(1, progress.cosignerWeight / need)) : 1;
  return (
    <View style={styles.card}>
      <Text style={[styles.hint, { color: theme.text }]}>{multisigCosignerBarLabel(progress)}</Text>
      <View style={[barStyles.track, { backgroundColor: theme.border }]}>
        <View style={[barStyles.fill, { width: `${Math.round(pct * 100)}%`, backgroundColor: theme.accent }]} />
      </View>
      <Text style={[styles.hint, { color: theme.text }]}>{multisigLocalSignsLine(progress)}</Text>
    </View>
  );
}

const barStyles = StyleSheet.create({
  stack: { gap: 8 },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 },
});

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
          // The shared delete-after-share helper of the recovery record and
          // the Activity export (components/RecordFileActions.tsx): earlier
          // exports swept first, this file deleted a minute after the sheet
          // closes (at once on failure). The text is written unchanged
          // (multisigFileContents), so the open path reads it back byte for byte.
          shareTextFile({
            directory: MULTISIG_EXPORT_DIRECTORY,
            fileName: () => fileName,
            contents: () => multisigFileContents(text),
            mimeType: MULTISIG_FILE_MIME_TYPE,
            UTI: MULTISIG_FILE_UTI,
            dialogTitle,
            unavailableMessage: 'Sharing files is not available on this device. Use Share… or Copy instead.',
          }).then(
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

/**
 * A multisig payload as QR codes: one code when it fits
 * MULTISIG_QR_PART_MAX_BYTES, otherwise numbered parts
 * ("SW-MS:<n>/<total>:…", wallet/multisig.ts splitMultisigQrParts) shown one
 * at a time with Previous part / Next part. The other phone joins them with
 * MultisigScanButton.
 */
export function MultisigPayloadQr({ payload, caption }: { payload: string; caption: string }) {
  const theme = useTheme();
  const parts = splitMultisigQrParts(payload);
  const [page, setPage] = useState(0);
  if (!parts) {
    return <Text style={[styles.hint, { color: theme.textMuted }]}>{MULTISIG_QR_TOO_LARGE}</Text>;
  }
  const total = parts.length;
  const index = Math.min(page, total - 1);
  return (
    <View style={barStyles.stack}>
      {total > 1 ? <Text style={[styles.hint, { color: theme.text }]}>{multisigQrPagedNote(total)}</Text> : null}
      <PayloadQr value={parts[index]!} caption={multisigQrPartCaption(caption, index, total)} />
      {total > 1 ? (
        <View style={styles.toggleRow}>
          <Button title="Previous part" variant="secondary" disabled={index === 0} onPress={() => setPage(index - 1)} />
          <Button title="Next part" variant="secondary" disabled={index === total - 1} onPress={() => setPage(index + 1)} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * A scan button for a multisig payload (a request, an approval or a
 * record). A whole code goes straight to `onComplete`; the parts of a
 * multi-part code are collected across scans (acceptMultisigQrScan) with a
 * progress line, "Scan the next part" and "Start over", and the joined text
 * goes to `onComplete` once every part is in. The caller hands that text to
 * the SAME parser as pasted text; nothing here checks or trusts the content.
 * A malformed part, or a part of another code, is reported through `onError`.
 */
export function MultisigScanButton({
  title,
  rationale,
  note,
  onComplete,
  onError,
}: {
  title: string;
  rationale: string;
  note: string;
  onComplete: (text: string) => void;
  onError: (message: string) => void;
}) {
  const theme = useTheme();
  const [visible, setVisible] = useState(false);
  const [scan, setScan] = useState<MultisigQrScan | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const startOver = () => {
    setScan(null);
    setProgress(null);
  };
  return (
    <View style={barStyles.stack}>
      <Button
        title={scan ? MULTISIG_SCAN_NEXT_TITLE : title}
        accessibilityLabel={scan ? `${MULTISIG_SCAN_NEXT_TITLE}: ${title}` : title}
        variant="secondary"
        onPress={() => setVisible(true)}
      />
      {progress ? <Text style={[styles.hint, { color: theme.text }]}>{progress}</Text> : null}
      {scan ? <Button title={MULTISIG_SCAN_START_OVER_TITLE} variant="secondary" onPress={startOver} /> : null}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{note}</Text>
      <QrScanner
        visible={visible}
        rationale={rationale}
        onScanned={(data) => {
          setVisible(false);
          try {
            const result = acceptMultisigQrScan(scan, data);
            if (result.kind === 'complete') {
              startOver();
              onComplete(result.text);
            } else {
              setScan(result.scan);
              setProgress(multisigQrProgressLine(result.received, result.total, result.repeated));
            }
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
          }
        }}
        onClose={() => setVisible(false)}
      />
    </View>
  );
}

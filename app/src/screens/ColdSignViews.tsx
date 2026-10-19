import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../components';
import { PayloadQr } from '../components/RecoveryViews';
import { QrScanner } from '../components/QrScanner';
import { useTheme } from '../theme';
import {
  COLD_SIGN_QR_TOO_LARGE,
  acceptColdSignQrScan,
  coldSignQrPagedNote,
  coldSignQrPartCaption,
  coldSignQrProgressLine,
  splitColdSignQrParts,
  type ColdSignQrScan,
} from '../wallet/cold-signing';

/**
 * A cold-signing request as QR codes: one code when it fits, otherwise
 * numbered parts ("SW-CS:<n>/<total>:…", wallet/cold-signing.ts
 * splitColdSignQrParts) shown one at a time with Previous part / Next part,
 * as the multisig screens show theirs.
 */
export function ColdSignPayloadQr({ payload, caption }: { payload: string; caption: string }) {
  const theme = useTheme();
  const parts = splitColdSignQrParts(payload);
  const [page, setPage] = useState(0);
  if (!parts) {
    return <Text style={[styles.hint, { color: theme.textMuted }]}>{COLD_SIGN_QR_TOO_LARGE}</Text>;
  }
  const total = parts.length;
  const index = Math.min(page, total - 1);
  return (
    <View style={styles.stack}>
      {total > 1 ? <Text style={[styles.hint, { color: theme.text }]}>{coldSignQrPagedNote(total)}</Text> : null}
      <PayloadQr value={parts[index]!} caption={coldSignQrPartCaption(caption, index, total)} />
      {total > 1 ? (
        <View style={styles.row}>
          <Button title="Previous part" variant="secondary" disabled={index === 0} onPress={() => setPage(index - 1)} />
          <Button title="Next part" variant="secondary" disabled={index === total - 1} onPress={() => setPage(index + 1)} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The scan button for the signer's answer. A whole code goes straight to
 * `onComplete`; the parts of a multi-part code are collected across scans
 * (acceptColdSignQrScan). The caller hands the text to
 * verifyColdSignSignature with the STORED request; nothing here trusts it.
 */
export function ColdSignScanButton({
  title,
  rationale,
  onComplete,
  onError,
}: {
  title: string;
  rationale: string;
  onComplete: (text: string) => void;
  onError: (message: string) => void;
}) {
  const theme = useTheme();
  const [visible, setVisible] = useState(false);
  const [scan, setScan] = useState<ColdSignQrScan | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const startOver = () => {
    setScan(null);
    setProgress(null);
  };
  return (
    <View style={styles.stack}>
      <Button
        title={scan ? 'Scan the next part' : title}
        accessibilityLabel={scan ? `Scan the next part: ${title}` : title}
        variant="secondary"
        onPress={() => setVisible(true)}
      />
      {progress ? <Text style={[styles.hint, { color: theme.text }]}>{progress}</Text> : null}
      {scan ? <Button title="Start over" variant="secondary" onPress={startOver} /> : null}
      <QrScanner
        visible={visible}
        rationale={rationale}
        onScanned={(data) => {
          setVisible(false);
          try {
            const result = acceptColdSignQrScan(scan, data);
            if (result.kind === 'complete') {
              startOver();
              onComplete(result.text);
            } else {
              setScan(result.scan);
              setProgress(coldSignQrProgressLine(result.received, result.total, result.repeated));
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

const styles = StyleSheet.create({
  stack: {
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
});

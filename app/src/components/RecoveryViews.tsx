import React, { useState } from 'react';
import { Platform, Share, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import * as Clipboard from 'expo-clipboard';
// react-native-qrcode-svg 6.3.26 (see ReceiveScreen for the Expo Go
// verification). Recovery payloads are long, so they are rendered at
// error-correction level L ("ecl" prop, typed in the package's index.d.ts)
// and capped at recovery.ts QR_MAX_BYTES, which scripts/check-recovery.mjs
// round-trips through an independent decoder.
import QRCode from 'react-native-qrcode-svg';
import type { KernelGuardianSet } from '@shiba-wallet/chains-evm';
import { Button, WarningBox } from '../components';
import { useTheme } from '../theme';
import { QrScanner } from './QrScanner';
import {
  GUARDIANS_TRADE_OFF,
  GUARDIANS_TRUST_LINES,
  describeGuardianExposure,
  formatDuration,
} from '../wallet/recovery';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** The network badge used on every recovery confirm screen. */
export function RecoveryNetworkBadge({ label, testnet }: { label: string; testnet: boolean }) {
  const theme = useTheme();
  if (testnet) {
    return (
      <View style={[styles.badge, { backgroundColor: theme.testnetFill, borderColor: theme.testnetFill }]}>
        <Text style={[styles.badgeText, { color: theme.onTestnetFill }]}>{label} TESTNET — test funds only</Text>
      </View>
    );
  }
  return (
    <View style={[styles.badge, { backgroundColor: theme.dangerSurface, borderColor: theme.danger }]}>
      <Text style={[styles.badgeText, { color: theme.danger }]}>{label} Mainnet — real funds</Text>
    </View>
  );
}

/** Label / value row; values are selectable and shown in full. */
export function InfoRow({
  label,
  value,
  sub = null,
  monoValue = false,
}: {
  label: string;
  value: string;
  sub?: string | null;
  monoValue?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text selectable style={[styles.rowValue, { color: theme.text }, monoValue ? styles.mono : null]}>
        {value}
      </Text>
      {sub ? (
        <Text selectable style={[styles.rowSub, { color: theme.textMuted }]}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The MANDATORY guardian exposure warning (engine finding 3, computed by
 * recovery.ts describeGuardianExposure) plus findings 1 and 2 and the
 * trade-off sentence. Shown on the setup form, the confirm screen and the
 * status screen; never collapsed, never phrased as "safe".
 */
export function GuardianExposureWarning({
  set,
  labelFor,
}: {
  set: KernelGuardianSet;
  labelFor?: (address: string) => string | null;
}) {
  const theme = useTheme();
  let text: ReturnType<typeof describeGuardianExposure> | null = null;
  try {
    text = describeGuardianExposure(set, labelFor);
  } catch {
    text = null;
  }
  return (
    <View style={styles.stack}>
      {text ? (
        <WarningBox>
          {text.signing}
          {text.weaker ? `\n\n${text.weaker}` : ''}
        </WarningBox>
      ) : null}
      {text ? <Text style={[styles.hint, { color: theme.text }]}>{text.recovery}</Text> : null}
      {GUARDIANS_TRUST_LINES.map((line) => (
        <Text key={line} style={[styles.hint, { color: theme.textMuted }]}>
          • {line}
        </Text>
      ))}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{GUARDIANS_TRADE_OFF}</Text>
    </View>
  );
}

/** A guardian set as a list: label (record or exact contact match), full address, weight. */
export function GuardianSetView({
  set,
  labelFor,
  title = 'Guardians',
  memberNoun = 'Guardian',
}: {
  set: KernelGuardianSet;
  labelFor?: (address: string) => string | null;
  title?: string;
  /** What an unlabelled member is called ('Heir' on the Inheritance screen). */
  memberNoun?: string;
}) {
  const theme = useTheme();
  const total = set.guardians.reduce((s, g) => s + g.weight, 0);
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.cardTitle, { color: theme.text }]}>{title}</Text>
      {set.guardians.map((g) => {
        const label = labelFor?.(g.address) ?? null;
        return (
          <View key={g.address} style={styles.guardianRow}>
            <Text style={[styles.guardianName, { color: theme.text }]}>
              {label ?? memberNoun} · weight {g.weight}
            </Text>
            <Text selectable style={[styles.mono, { color: theme.textMuted }]}>
              {g.address}
            </Text>
          </View>
        );
      })}
      <Text style={[styles.hint, { color: theme.text }]}>
        Threshold {set.threshold} of total weight {total} ·{' '}
        {set.delaySeconds > 0 ? `delay ${formatDuration(set.delaySeconds)} (you can veto)` : 'no delay (no veto)'}
      </Text>
    </View>
  );
}

/**
 * A payload as a QR code (white quiet zone kept white in dark mode), or a
 * note when it is too large for one code (the share text still works).
 */
export function PayloadQr({ value, caption }: { value: string | null; caption: string }) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [failed, setFailed] = useState(false);
  const size = Math.min(Math.round(width - 48 * 2), 300);
  if (!value || failed) {
    return (
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Too large for a single QR code — use Share or Copy below instead.
      </Text>
    );
  }
  return (
    <View style={styles.stack}>
      <View style={styles.qrBox}>
        <QRCode
          value={value}
          size={size}
          ecl="L"
          backgroundColor="#ffffff"
          color="#000000"
          onError={() => setFailed(true)}
        />
      </View>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{caption}</Text>
    </View>
  );
}

/** Share sheet + copy for a payload text. The clipboard note mirrors ReceiveScreen's. */
export function ShareActions({ text, shareTitle, onShared }: { text: string; shareTitle: string; onShared?: () => void }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  return (
    <View style={styles.stack}>
      <Button
        title="Share…"
        variant="secondary"
        onPress={() => {
          // React Native's built-in Share (text): save it to a notes app or
          // cloud drive, or send it on a channel you trust.
          Share.share({ message: text, title: shareTitle }).then(
            () => onShared?.(),
            () => undefined,
          );
        }}
      />
      <Button
        title={copied ? 'Copied ✓' : 'Copy'}
        variant="secondary"
        onPress={() => {
          void Clipboard.setStringAsync(text).then(() => {
            setCopied(true);
            onShared?.();
          });
        }}
      />
      {copied ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Copied — note that the clipboard can be read by other apps. This text contains no secrets.
        </Text>
      ) : null}
    </View>
  );
}

/** Multi-line paste box with a Scan button (the shared QR scanner modal). */
export function PasteOrScan({
  value,
  onChange,
  placeholder,
  rationale,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  rationale: string;
}) {
  const theme = useTheme();
  const [scanning, setScanning] = useState(false);
  return (
    <View style={styles.stack}>
      <TextInput
        value={value}
        onChangeText={onChange}
        accessibilityLabel={placeholder}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.card }]}
      />
      <Button
        title="Scan QR code"
        accessibilityLabel={`Scan QR code: ${placeholder}`}
        variant="secondary"
        onPress={() => setScanning(true)}
      />
      <QrScanner
        visible={scanning}
        rationale={rationale}
        onScanned={(data) => {
          setScanning(false);
          onChange(data);
        }}
        onClose={() => setScanning(false)}
      />
    </View>
  );
}

/** Weight progress: "weight 1 of 2" with a bar. */
export function WeightProgress({ weight, threshold }: { weight: number; threshold: number }) {
  const theme = useTheme();
  const pct = Math.max(0, Math.min(1, threshold > 0 ? weight / threshold : 0));
  return (
    <View style={styles.stack}>
      <Text style={[styles.hint, { color: theme.text }]}>
        Approvals: weight {weight} of the threshold {threshold}
      </Text>
      <View style={[styles.barTrack, { backgroundColor: theme.border }]}>
        <View style={[styles.barFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: theme.accent }]} />
      </View>
    </View>
  );
}

export const recoveryLayout = StyleSheet.create({
  content: { padding: 24, gap: 14 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 10, padding: 12 },
  title: { fontSize: 18, fontWeight: '700' },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginTop: 8 },
  hint: { fontSize: 13, lineHeight: 19 },
  ok: { fontSize: 15, fontWeight: '600' },
  error: { fontSize: 14, lineHeight: 20 },
  mono: { fontFamily: mono, fontSize: 13 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  toggleLabel: { flex: 1, fontSize: 14, lineHeight: 20 },
});

const styles = StyleSheet.create({
  stack: { gap: 8 },
  badge: { borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  badgeText: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8, gap: 2 },
  rowLabel: { fontSize: 12, fontWeight: '600' },
  rowValue: { fontSize: 15 },
  rowSub: { fontSize: 12, lineHeight: 17 },
  mono: { fontFamily: mono, fontSize: 13 },
  hint: { fontSize: 13, lineHeight: 19 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  guardianRow: { gap: 2 },
  guardianName: { fontSize: 14, fontWeight: '600' },
  qrBox: { alignSelf: 'center', backgroundColor: '#ffffff', padding: 16, borderRadius: 12 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, minHeight: 90, textAlignVertical: 'top' },
  barTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8 },
});

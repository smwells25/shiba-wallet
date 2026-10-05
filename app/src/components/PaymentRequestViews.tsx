import React, { useEffect, useState } from 'react';
import { Platform, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { formatAssetId } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
import { Button } from '../components';
import { useTheme } from '../theme';
import { parseUnits } from '../wallet/balances';
import {
  MAX_REQUEST_TEXT_LENGTH,
  STANDARD_BY_FAMILY,
  buildPaymentRequestUri,
  describeBuiltRequest,
  type BuildRequestInput,
  type PaymentFamily,
} from '../wallet/payment-request';
import { listTokens } from '../wallet/tokens';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/**
 * The Send form's "filled in from a payment request" box: one plain line
 * per fact the request carried (../wallet/payment-request.ts
 * describeParsedRequest). Purely informational — every value it names is
 * in an editable field below it.
 */
export function PaymentRequestNotice({ lines }: { lines: readonly string[] }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={lines.join(' ')}
      style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}
    >
      <Text style={[styles.title, { color: theme.text }]}>Payment request</Text>
      {lines.map((line, i) => (
        <Text key={i} selectable style={[styles.line, { color: i === 0 ? theme.textMuted : theme.text }]}>
          {line}
        </Text>
      ))}
    </View>
  );
}

/** What the Send screen knows about a name typed into the recipient field. */
export type EnsNameView =
  | { status: 'resolving'; name: string }
  | { status: 'resolved'; name: string; address: string; registryLabel: string }
  | { status: 'refused'; name: string; message: string };

/**
 * The name panel under the recipient field: "looking up…", the full
 * resolved address (which must be visible before Review), or the refusal
 * sentence; plus the privacy sentence whenever a lookup goes out.
 */
export function EnsNameStatus({ view, privacyNote }: { view: EnsNameView; privacyNote: string | null }) {
  const theme = useTheme();
  return (
    <View style={styles.nameBlock} accessibilityLiveRegion="polite">
      {view.status === 'resolving' ? (
        <Text style={[styles.line, { color: theme.textMuted }]}>Looking up {view.name}…</Text>
      ) : view.status === 'resolved' ? (
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.title, { color: theme.text }]}>{view.name} {'→'}</Text>
          <Text selectable style={[styles.address, { color: theme.text }]}>
            {view.address}
          </Text>
          <Text style={[styles.line, { color: theme.textMuted }]}>
            Resolved by {view.registryLabel}. The address above, not the name, is what will be
            checked and used; the name is looked up again when you tap Review.
          </Text>
        </View>
      ) : (
        <Text style={[styles.line, { color: theme.danger }]}>{view.message}</Text>
      )}
      {privacyNote ? <Text style={[styles.line, { color: theme.textMuted }]}>{privacyNote}</Text> : null}
    </View>
  );
}

/** One asset the Receive request can ask for. */
interface RequestAsset {
  key: string;
  symbol: string;
  /** Present for an ERC-20 token. */
  token?: { contract: string; decimals: number };
}

/**
 * Receive's "Request an amount" section (phase 14 item 1): amount, the
 * asset (EVM: the native coin or a tracked token of the ACTIVE network;
 * the active chain id is always written into the request), an optional
 * label and note where the format defines them (BIP-321, the Dogecoin
 * format and Solana Pay — EIP-681 has none), and the result as a QR code
 * and as text with Copy and Share. The plain-address QR above it stays the
 * default; this section is closed until opened.
 */
export function RequestAmountCard({
  family,
  address,
  networkLabel,
  nativeSymbol,
  chainIdDecimal,
  evmCaip2,
  qrSize,
}: {
  family: PaymentFamily;
  address: string;
  networkLabel: string;
  nativeSymbol: string;
  /** EVM only: the active profile's chain id. */
  chainIdDecimal?: string;
  /** EVM only: the active profile's CAIP-2 id (whose tracked tokens are offered). */
  evmCaip2?: string;
  qrSize: number;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [assetKey, setAssetKey] = useState('native');
  const [tokenState, setTokenState] = useState<{ chain: string; list: FungibleAsset[] } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || family !== 'evm' || !evmCaip2) return;
    let cancelled = false;
    listTokens(evmCaip2).then(
      (list) => {
        if (!cancelled) setTokenState({ chain: evmCaip2, list });
      },
      () => {
        if (!cancelled) setTokenState({ chain: evmCaip2, list: [] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, family, evmCaip2]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  // Tokens of the ACTIVE network only; a list read for another network is ignored.
  const tokens = tokenState && tokenState.chain === evmCaip2 ? tokenState.list : [];
  const assets: RequestAsset[] = [
    { key: 'native', symbol: nativeSymbol },
    ...(family === 'evm'
      ? tokens
          .filter((t) => t.assetId.chainId === evmCaip2 && t.assetId.namespace === 'erc20')
          .map((t) => ({
            key: formatAssetId(t.assetId),
            symbol: t.symbol,
            token: { contract: t.assetId.reference, decimals: t.decimals },
          }))
      : []),
  ];
  const asset = assets.find((a) => a.key === assetKey) ?? assets[0]!;
  const decimals = asset.token ? asset.token.decimals : family === 'solana' ? 9 : family === 'evm' ? 18 : 8;

  let built: { uri: string; description: string } | null = null;
  let error: string | null = null;
  if (amountText.trim() !== '') {
    try {
      const amount = parseUnits(amountText, decimals);
      // The optional token entry of an EVM request, built on its own line.
      const tokenField = asset.token ? { token: asset.token } : {};
      const input: BuildRequestInput =
        family === 'evm'
          ? {
              family,
              address,
              chainIdDecimal: chainIdDecimal ?? '',
              amount,
              ...tokenField,
            }
          : { family, address, amount, label, message: note };
      built = {
        uri: buildPaymentRequestUri(input),
        description: describeBuiltRequest(input, { symbol: asset.symbol, networkLabel }),
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const inputStyle = [styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.card }];

  if (!open) {
    return (
      <Button
        title="Request an amount"
        variant="secondary"
        style={styles.stretch}
        accessibilityHint="Builds a payment request with an amount, shown as a QR code and as a link"
        onPress={() => setOpen(true)}
      />
    );
  }

  return (
    <View style={[styles.box, styles.stretch, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.title, { color: theme.text }]}>Request an amount</Text>
      <Text style={[styles.line, { color: theme.textMuted }]}>
        Builds a standard payment request ({STANDARD_BY_FAMILY[family]}) that other wallets can
        scan. The plain address code above stays available.
      </Text>
      {assets.length > 1 ? (
        <View style={styles.chips}>
          {assets.map((a) => (
            <Button
              key={a.key}
              title={a.symbol}
              variant={a.key === asset.key ? 'primary' : 'secondary'}
              selected={a.key === asset.key}
              onPress={() => setAssetKey(a.key)}
            />
          ))}
        </View>
      ) : null}
      <Text style={[styles.label, { color: theme.textMuted }]}>Amount ({asset.symbol})</Text>
      <TextInput
        value={amountText}
        onChangeText={setAmountText}
        accessibilityLabel={`Requested amount in ${asset.symbol}`}
        placeholder="0.0"
        placeholderTextColor={theme.textMuted}
        keyboardType="decimal-pad"
        style={inputStyle}
      />
      {family !== 'evm' ? (
        <>
          <Text style={[styles.label, { color: theme.textMuted }]}>
            Label (optional, for example your name)
          </Text>
          <TextInput
            value={label}
            onChangeText={setLabel}
            accessibilityLabel="Label, optional"
            maxLength={MAX_REQUEST_TEXT_LENGTH}
            placeholderTextColor={theme.textMuted}
            style={inputStyle}
          />
          <Text style={[styles.label, { color: theme.textMuted }]}>Note (optional)</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            accessibilityLabel="Note, optional"
            maxLength={MAX_REQUEST_TEXT_LENGTH}
            placeholderTextColor={theme.textMuted}
            style={inputStyle}
          />
        </>
      ) : (
        <Text style={[styles.line, { color: theme.textMuted }]}>
          Ethereum payment requests have no label or note. The request always names the network the
          wallet is on ({networkLabel}).
        </Text>
      )}
      {error ? <Text style={[styles.line, { color: theme.danger }]}>{error}</Text> : null}
      {built ? (
        <>
          <Text style={[styles.line, { color: theme.text }]}>{built.description}</Text>
          <View
            style={styles.qrBox}
            accessible
            accessibilityRole="image"
            accessibilityLabel="QR code of this payment request"
          >
            <QRCode value={built.uri} size={qrSize} backgroundColor="#ffffff" color="#000000" />
          </View>
          <Text selectable style={[styles.uri, { color: theme.text }]}>
            {built.uri}
          </Text>
          <Button
            title={copied ? 'Copied ✓' : 'Copy request link'}
            variant="secondary"
            onPress={async () => {
              await Clipboard.setStringAsync(built!.uri);
              setCopied(true);
            }}
          />
          {copied ? (
            <Text accessibilityLiveRegion="polite" style={[styles.line, { color: theme.textMuted }]}>
              Copied {'—'} note that the clipboard can be read by other apps.
            </Text>
          ) : null}
          <Button
            title="Share request link"
            variant="secondary"
            onPress={() => {
              void Share.share({ message: built!.uri }).catch(() => undefined);
            }}
          />
        </>
      ) : null}
      <Button
        title="Close"
        variant="secondary"
        onPress={() => {
          setOpen(false);
          setAmountText('');
          setLabel('');
          setNote('');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  stretch: {
    alignSelf: 'stretch',
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
  },
  line: {
    fontSize: 13,
    lineHeight: 19,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
  },
  nameBlock: {
    gap: 6,
  },
  address: {
    fontFamily: mono,
    fontSize: 14,
    lineHeight: 20,
  },
  uri: {
    fontFamily: mono,
    fontSize: 12,
    lineHeight: 18,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  qrBox: {
    alignSelf: 'center',
    backgroundColor: '#ffffff',
    padding: 16,
    borderRadius: 16,
  },
});

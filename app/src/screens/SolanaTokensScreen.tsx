import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { formatAssetId } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle, useFieldLabels } from '../components';
import { NoEndpointError, getEndpoint, withEndpoint } from '../config/networks';
import { OfflineNotice, TechnicalDetail, describeNetworkError } from '../wallet/connectivity';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { SolanaDevnetBanner } from '../components/SolanaDevnetBanner';
import { addSolanaToken, listSolanaTokens, removeSolanaToken } from '../wallet/tokens';
import { cleanTokenText, TOKEN_NAME_MAX, TOKEN_SYMBOL_MAX } from '../wallet/token-discovery';
import {
  SOLANA_SLOT_CHAIN_ID,
  previewMint,
  solanaClient,
  solanaNetworkLabel,
  splSendGate,
  tokenProgramLabel,
  splTransferFeeLine,
  trackPrompt,
  trackedAssetFor,
  type MintPreview,
} from '../wallet/spl-tokens';

type Props = NativeStackScreenProps<RootStackParamList, 'SolanaTokens'>;

/**
 * Solana tokens (phase 24 item 1, feature 43): the tracked list of the
 * network serving the Solana slot (Solana mainnet, or Solana devnet while
 * Settings → Developer → "Use Solana devnet" is on) and adding a token by
 * its MINT address. The mint is read and classified by the engine
 * (wallet/spl-tokens.ts previewMint → readMintProfile): its decimals always
 * come from the mint, its symbol and name from the mint's own metadata or
 * its Metaplex record (else from the engine's known-token table for that
 * exact mint, else typed by the user), and a mint whose class the engine
 * refuses to send can still be tracked — the confirmation and the Home row
 * say it cannot be sent, in the engine's own words. Nothing is tracked
 * without the Track confirmation naming the full mint.
 */
export function SolanaTokensScreen({ navigation }: Props) {
  const theme = useTheme();
  const fieldLabel = useFieldLabels();
  const { solanaDevnet } = usePrefs();
  const [network, setNetwork] = useState<string | null>(null);
  const [tokens, setTokens] = useState<FungibleAsset[]>([]);
  const [mintText, setMintText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; technical: string | null } | null>(null);
  const [preview, setPreview] = useState<MintPreview | null>(null);
  const [manualSymbol, setManualSymbol] = useState('');
  const [manualName, setManualName] = useState('');

  // The list belongs to the network the Solana endpoint serves right now. It
  // is read again after a change (version) and when Solana devnet is
  // switched in Settings (solanaDevnet).
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const endpoint = await getEndpoint(SOLANA_SLOT_CHAIN_ID);
      const chain = endpoint?.network.chainId ?? null;
      const list = chain ? await listSolanaTokens(chain) : [];
      if (!cancelled) {
        setNetwork(chain);
        setTokens(list);
      }
    })().catch(() => {
      if (!cancelled) setTokens([]);
    });
    return () => {
      cancelled = true;
    };
  }, [version, solanaDevnet]);

  const label = network ? solanaNetworkLabel(network) : 'Solana';
  useEffect(() => {
    navigation.setOptions({ title: `Solana tokens · ${label}` });
  }, [navigation, label]);

  const resetForm = () => {
    setMintText('');
    setPreview(null);
    setError(null);
    setManualSymbol('');
    setManualName('');
  };

  const lookUp = async () => {
    setError(null);
    setPreview(null);
    setBusy(true);
    try {
      const { value, endpoint } = await withEndpoint(SOLANA_SLOT_CHAIN_ID, async (ep) =>
        previewMint(solanaClient(ep.url), ep.network.chainId, mintText, tokens),
      );
      if (endpoint.network.chainId !== network) {
        setError({ message: 'The Solana network changed while the mint was read. Read it again.', technical: null });
        return;
      }
      setPreview(value);
    } catch (e) {
      if (e instanceof NoEndpointError) {
        setError({ message: 'No Solana endpoint is configured. Set one in Settings first.', technical: null });
      } else if (e instanceof Error && e.name === 'SplTokenRefusal') {
        setError({ message: e.message, technical: null });
      } else {
        const { title, detail, technical } = describeNetworkError(e, 'the mint');
        setError({ message: `${title}\n${detail}`, technical });
      }
    } finally {
      setBusy(false);
    }
  };

  const symbol = preview?.symbol ?? cleanTokenText(manualSymbol, TOKEN_SYMBOL_MAX) ?? '';
  const name = preview?.name ?? cleanTokenText(manualName, TOKEN_NAME_MAX) ?? '';

  const confirmTrack = () => {
    if (!preview || symbol === '' || preview.caip2 !== network) return;
    const prompt = trackPrompt(preview, symbol);
    Alert.alert(prompt.title, prompt.message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: prompt.confirm,
        onPress: () => {
          void (async () => {
            try {
              await addSolanaToken(trackedAssetFor(preview, symbol, name));
              resetForm();
              reload();
            } catch (e) {
              Alert.alert('Not added', e instanceof Error ? e.message : 'Could not add this token.');
            }
          })();
        },
      },
    ]);
  };

  const onRemove = (token: FungibleAsset) => {
    Alert.alert(
      `Remove ${token.symbol}?`,
      'This only stops tracking the token in this app. Your balance on the blockchain is not affected, and you can track the token again any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void removeSolanaToken(formatAssetId(token.assetId)).then(reload);
          },
        },
      ],
    );
  };

  const sendRefusal = network ? splSendGate(network) : null;

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <SolanaDevnetBanner chainId={SOLANA_SLOT_CHAIN_ID} />
      <View style={styles.section}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>
          Tracked tokens on {label}
        </Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          SPL Token and Token-2022 balances shown on Home under the Solana row. Solana mainnet and Solana devnet
          keep separate lists. The balance shown is the one in your associated token account, the account a send
          uses. Network fees for a token send are paid in SOL.
          {solanaDevnet ? ' This is Solana devnet: its tokens have no value.' : ''}
        </Text>
        {sendRefusal ? <WarningBox>{sendRefusal}</WarningBox> : null}
        {tokens.length === 0 ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>No tokens tracked. Add one below.</Text>
        ) : (
          tokens.map((token) => (
            <View key={formatAssetId(token.assetId)} style={[styles.tokenRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <View style={styles.tokenInfo}>
                <Text style={[styles.tokenSymbol, { color: theme.text }]}>{token.symbol}</Text>
                <Text style={[styles.tokenName, { color: theme.textMuted }]} numberOfLines={1}>
                  {token.name} · {token.decimals} decimals
                </Text>
                <Text selectable style={[styles.tokenAddress, { color: theme.textMuted }]}>
                  Mint {token.assetId.reference}
                </Text>
              </View>
              <View style={styles.rowButtons}>
                {sendRefusal === null ? (
                  <Button
                    title="Send"
                    accessibilityLabel={`Send ${token.symbol}`}
                    onPress={() => navigation.navigate('SolanaTokenSend', { assetId: formatAssetId(token.assetId) })}
                    style={styles.rowButton}
                  />
                ) : null}
                <Button
                  title="Remove"
                  accessibilityLabel={`Remove ${token.symbol} from tracked tokens`}
                  variant="destructive"
                  onPress={() => onRemove(token)}
                  style={styles.rowButton}
                />
              </View>
            </View>
          ))
        )}
      </View>

      <View style={styles.section}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>Add a token</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Paste the token&apos;s mint address on {label}. The wallet reads the mint itself: its decimals, which token
          program it belongs to, its Token-2022 extensions and its on-chain name and symbol. Anyone can create a token
          with any name; verify the mint address from a source you trust.
        </Text>
        <OfflineNotice />
        <Text {...fieldLabel('spl-mint', 'Mint address').label} style={[styles.hint, { color: theme.textMuted }]}>
          {fieldLabel('spl-mint', 'Mint address').text}
        </Text>
        <TextInput
          {...fieldLabel('spl-mint', 'Mint address').input}
          value={mintText}
          onChangeText={(text) => {
            setMintText(text);
            setPreview(null);
            setError(null);
          }}
          placeholder="Base58 text"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.card }]}
        />
        {error ? (
          <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.danger }]}>
            {error.message}
          </Text>
        ) : null}
        {error ? <TechnicalDetail text={error.technical} /> : null}
        {busy ? (
          <ActivityIndicator size="small" color={theme.textMuted} />
        ) : preview === null ? (
          <Button title="Read the mint" onPress={() => void lookUp()} disabled={mintText.trim() === '' || network === null} />
        ) : null}

        {preview && preview.caip2 === network ? (
          <View style={[styles.previewCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text accessibilityRole="header" style={[styles.previewTitle, { color: theme.text }]}>
              {preview.symbol ?? 'Symbol unavailable'}
              {preview.name && preview.name !== preview.symbol ? ` — ${preview.name}` : ''}
            </Text>
            <Text selectable style={[styles.tokenAddress, { color: theme.textMuted }]}>Mint {preview.mint}</Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              {tokenProgramLabel(preview.profile.program)} · {preview.decimals} decimals (from the mint)
            </Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              {preview.symbolSource === 'metadata'
                ? 'Name and symbol: from the mint’s on-chain metadata.'
                : preview.symbolSource === 'known'
                  ? 'Name and symbol: from this wallet’s list of issuer-documented tokens (no on-chain record names this mint).'
                  : (preview.profile.metadataNote ?? 'No on-chain name or symbol was found for this mint.')}
            </Text>
            {preview.transferFee ? (
              <Text style={[styles.hint, { color: theme.text }]}>
                {splTransferFeeLine(preview.transferFee, preview.decimals, preview.symbol)}
              </Text>
            ) : null}
            {preview.lookAlike ? <WarningBox>{`Warning: ${preview.lookAlike}`}</WarningBox> : null}
            {preview.sendRefusal ? (
              <WarningBox>{`This token can be tracked and shown, but this wallet will not send it: ${preview.sendRefusal}`}</WarningBox>
            ) : null}
            {preview.profile.classification.notes.map((note) => (
              <Text key={note} style={[styles.hint, { color: theme.text }]}>
                {note}
              </Text>
            ))}
            {preview.symbol === null ? (
              <View style={styles.manualBlock}>
                <Text {...fieldLabel('spl-symbol', 'Token symbol').label} style={[styles.hint, { color: theme.textMuted }]}>
                  {fieldLabel('spl-symbol', 'Token symbol').text}
                </Text>
                <TextInput
                  {...fieldLabel('spl-symbol', 'Token symbol').input}
                  value={manualSymbol}
                  onChangeText={setManualSymbol}
                  placeholder="For example ABC"
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={TOKEN_SYMBOL_MAX}
                  style={[styles.input, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.background }]}
                />
                <Text {...fieldLabel('spl-name', 'Token name (optional)').label} style={[styles.hint, { color: theme.textMuted }]}>
                  {fieldLabel('spl-name', 'Token name (optional)').text}
                </Text>
                <TextInput
                  {...fieldLabel('spl-name', 'Token name (optional)').input}
                  value={manualName}
                  onChangeText={setManualName}
                  placeholder="For example Example Coin"
                  placeholderTextColor={theme.textMuted}
                  autoCorrect={false}
                  maxLength={TOKEN_NAME_MAX}
                  style={[styles.input, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.background }]}
                />
              </View>
            ) : null}
            <View style={styles.previewButtons}>
              <Button title="Track" onPress={confirmTrack} disabled={symbol === ''} style={styles.previewButton} />
              <Button title="Cancel" variant="secondary" onPress={resetForm} style={styles.previewButton} />
            </View>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 28 },
  section: { gap: 12 },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  hint: { fontSize: 13, lineHeight: 19 },
  tokenRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, padding: 14, gap: 12 },
  tokenInfo: { flex: 1, gap: 3 },
  tokenSymbol: { fontSize: 16, fontWeight: '700' },
  tokenName: { fontSize: 13 },
  tokenAddress: { fontSize: 12, fontVariant: ['tabular-nums'] },
  rowButtons: { gap: 6 },
  rowButton: { paddingVertical: 8, paddingHorizontal: 12 },
  input: { borderRadius: 10, borderWidth: 1, paddingVertical: 10, paddingHorizontal: 12, fontSize: 14 },
  previewCard: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  previewTitle: { fontSize: 16, fontWeight: '700' },
  manualBlock: { gap: 10 },
  previewButtons: { flexDirection: 'row', gap: 10 },
  previewButton: { flex: 1 },
});

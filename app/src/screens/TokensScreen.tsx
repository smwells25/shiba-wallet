import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { formatAssetId } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { Button, screenStyle } from '../components';
import { NoEndpointError, withEndpoint } from '../config/networks';
import { OfflineNotice, describeNetworkError } from '../wallet/connectivity';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { EVM_CHAIN_ID } from '../wallet/send';
import {
  fetchErc20Metadata,
  validateErc20ContractAddress,
  type Erc20Metadata,
} from '../wallet/erc20';
import { addToken, listTokens, removeToken } from '../wallet/tokens';

type Props = NativeStackScreenProps<RootStackParamList, 'Tokens'>;

/**
 * Fetched metadata strings are attacker-controlled contract output; cap
 * them so a hostile token cannot flood the UI. Same caps apply to manual
 * entry for consistency.
 */
const MAX_SYMBOL_LENGTH = 16;
const MAX_NAME_LENGTH = 48;

function shortAddress(address: string): string {
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}

/** The looked-up contract, pending the user's confirmation. */
interface Preview {
  /** EIP-55 checksummed contract address (the CAIP-19 reference). */
  address: string;
  metadata: Erc20Metadata;
}

/**
 * Token management: the tracked ERC-20 list (removable, USDC included —
 * nothing is special) and the add-token flow: paste a contract address
 * (EIP-55-validated through the same engine code as the send screen),
 * auto-fill symbol/name/decimals via eth_call, confirm, done. Legacy
 * bytes32-metadata tokens fall back to manual symbol/name entry; decimals
 * always come from the chain because honest balance display depends on
 * them. Each tracked token row links into the send screen's token mode
 * (phase 4 item 3).
 */
export function TokensScreen({ navigation }: Props) {
  const theme = useTheme();
  const { evmChain } = usePrefs();
  const [tokens, setTokens] = useState<FungibleAsset[]>([]);
  const [address, setAddress] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [manualSymbol, setManualSymbol] = useState('');
  const [manualName, setManualName] = useState('');

  const reload = useCallback(() => {
    listTokens().then(setTokens, () => setTokens([]));
  }, []);

  useEffect(reload, [reload]);

  const resetForm = () => {
    setAddress('');
    setPreview(null);
    setLookupError(null);
    setManualSymbol('');
    setManualName('');
  };

  const lookUp = async () => {
    setLookupError(null);
    setPreview(null);
    const validation = validateErc20ContractAddress(address);
    if (!validation.ok) {
      setLookupError(validation.error);
      return;
    }
    setLookingUp(true);
    try {
      // Resolved now, with the shared failover rule (config/networks.ts).
      const { value: metadata } = await withEndpoint(EVM_CHAIN_ID, (ep) =>
        fetchErc20Metadata(ep.url, validation.normalized),
      );
      setPreview({ address: validation.normalized, metadata });
      setManualSymbol('');
      setManualName('');
    } catch (e) {
      if (e instanceof NoEndpointError) {
        setLookupError('No Ethereum RPC endpoint configured. Set one in Settings first.');
      } else {
        const { title, detail } = describeNetworkError(e, 'the token details');
        setLookupError(`${title}\n${detail}`);
      }
    } finally {
      setLookingUp(false);
    }
  };

  // An empty decoded string counts as missing too: a token symbol of ""
  // would be indistinguishable from a bug in every list it appears in.
  const fetchedSymbol = preview?.metadata.symbol?.trim() ?? '';
  const fetchedName = preview?.metadata.name?.trim() ?? '';
  const effectiveSymbol = (fetchedSymbol !== '' ? fetchedSymbol : manualSymbol.trim()).slice(
    0,
    MAX_SYMBOL_LENGTH,
  );
  const effectiveName = (fetchedName !== '' ? fetchedName : manualName.trim()).slice(
    0,
    MAX_NAME_LENGTH,
  );

  const confirmAdd = async () => {
    if (!preview || effectiveSymbol === '') return;
    const asset: FungibleAsset = {
      kind: 'fungible',
      assetId: {
        chainId: EVM_CHAIN_ID,
        namespace: 'erc20',
        reference: preview.address,
      },
      symbol: effectiveSymbol,
      // A missing name is the symbol; better than an empty string in lists.
      name: effectiveName === '' ? effectiveSymbol : effectiveName,
      decimals: preview.metadata.decimals,
    };
    try {
      await addToken(asset);
      resetForm();
      reload();
    } catch (e) {
      Alert.alert('Not added', e instanceof Error ? e.message : 'Could not add this token.');
    }
  };

  const onRemove = (token: FungibleAsset) => {
    const id = formatAssetId(token.assetId);
    Alert.alert(
      `Remove ${token.symbol}?`,
      'This only stops tracking the token in this app. Your balance on the ' +
        'blockchain is not affected, and you can re-add the token any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await removeToken(id);
            reload();
          },
        },
      ],
    );
  };

  const needsManualEntry = preview !== null && fetchedSymbol === '';

  // Token management is a mainnet feature: the tracked list holds
  // Ethereum-mainnet ERC-20s, and metadata/balance lookups would hit the
  // Sepolia endpoint in test mode (wrong chain). State it plainly rather
  // than half-working.
  if (evmChain.testnet) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Tokens are mainnet-only</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Sepolia test mode is on, and your tracked ERC-20 tokens are
          Ethereum mainnet assets. Turn off test mode in Settings →
          Developer to see and manage them again — the list itself is kept
          and unchanged.
        </Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Tracked tokens</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          ERC-20 balances shown on Home under Ethereum. Tokens arrive at
          your Ethereum address, and Send starts a token transfer — the
          network fee for a token send is paid in ETH.
        </Text>
        {tokens.length === 0 ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            No tokens tracked. Add one below.
          </Text>
        ) : (
          tokens.map((token) => (
            <View
              key={formatAssetId(token.assetId)}
              style={[styles.tokenRow, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <View style={styles.tokenInfo}>
                <Text style={[styles.tokenSymbol, { color: theme.text }]}>{token.symbol}</Text>
                <Text style={[styles.tokenName, { color: theme.textMuted }]} numberOfLines={1}>
                  {token.name} · {token.decimals} decimals
                </Text>
                <Text style={[styles.tokenAddress, { color: theme.textMuted }]}>
                  {shortAddress(token.assetId.reference)}
                </Text>
              </View>
              <View style={styles.rowButtons}>
                <Button
                  title="Send"
                  onPress={() =>
                    navigation.navigate('Send', {
                      chainId: EVM_CHAIN_ID,
                      tokenId: formatAssetId(token.assetId),
                    })
                  }
                  style={styles.removeButton}
                />
                <Button
                  title="Remove"
                  variant="destructive"
                  onPress={() => onRemove(token)}
                  style={styles.removeButton}
                />
              </View>
            </View>
          ))
        )}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Add a token</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Paste the token&apos;s Ethereum contract address. Its symbol, name
          and decimals are read from the contract itself; confirm before it
          is added. Anyone can deploy a token with any name — verify the
          contract address from a source you trust.
        </Text>
        <OfflineNotice />
        <TextInput
          value={address}
          onChangeText={(text) => {
            setAddress(text);
            setPreview(null);
            setLookupError(null);
          }}
          accessibilityLabel="Token contract address"
          placeholder="0x…"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            styles.input,
            { color: theme.text, borderColor: theme.border, backgroundColor: theme.card },
          ]}
        />
        {lookupError ? (
          <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.danger }]}>
            {lookupError}
          </Text>
        ) : null}
        {lookingUp ? (
          <ActivityIndicator size="small" color={theme.textMuted} />
        ) : preview === null ? (
          <Button title="Look up token" onPress={() => void lookUp()} disabled={address.trim() === ''} />
        ) : null}

        {preview ? (
          <View style={[styles.previewCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.previewTitle, { color: theme.text }]}>
              {fetchedSymbol !== '' ? fetchedSymbol : 'Symbol unavailable'}
              {fetchedName !== '' ? ` — ${fetchedName}` : ''}
            </Text>
            <Text style={[styles.tokenAddress, { color: theme.textMuted }]}>{preview.address}</Text>
            <Text style={[styles.previewMeta, { color: theme.textMuted }]}>
              Decimals (from the contract): {preview.metadata.decimals}
            </Text>
            {needsManualEntry ? (
              <View style={styles.manualBlock}>
                <Text style={[styles.hint, { color: theme.textMuted }]}>
                  {preview.metadata.note ??
                    'The contract did not return readable text metadata.'}
                </Text>
                <TextInput
                  value={manualSymbol}
                  onChangeText={setManualSymbol}
                  accessibilityLabel="Token symbol"
                  placeholder="Symbol (e.g. MKR)"
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={MAX_SYMBOL_LENGTH}
                  style={[
                    styles.input,
                    { color: theme.text, borderColor: theme.border, backgroundColor: theme.background },
                  ]}
                />
                <TextInput
                  value={manualName}
                  onChangeText={setManualName}
                  accessibilityLabel="Token name (optional)"
                  placeholder="Name (optional)"
                  placeholderTextColor={theme.textMuted}
                  autoCorrect={false}
                  maxLength={MAX_NAME_LENGTH}
                  style={[
                    styles.input,
                    { color: theme.text, borderColor: theme.border, backgroundColor: theme.background },
                  ]}
                />
              </View>
            ) : null}
            <View style={styles.previewButtons}>
              <Button
                title="Add token"
                onPress={() => void confirmAdd()}
                disabled={effectiveSymbol === ''}
                style={styles.previewButton}
              />
              <Button
                title="Cancel"
                variant="secondary"
                onPress={resetForm}
                style={styles.previewButton}
              />
            </View>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 28,
  },
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
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  tokenInfo: {
    flex: 1,
    gap: 3,
  },
  tokenSymbol: {
    fontSize: 16,
    fontWeight: '700',
  },
  tokenName: {
    fontSize: 13,
  },
  tokenAddress: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  rowButtons: {
    gap: 6,
  },
  removeButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  error: {
    fontSize: 13,
    lineHeight: 19,
  },
  previewCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  previewTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  previewMeta: {
    fontSize: 13,
  },
  manualBlock: {
    gap: 10,
  },
  previewButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  previewButton: {
    flex: 1,
  },
});

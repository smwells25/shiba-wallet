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
import { Button, WarningBox, screenStyle } from '../components';
import { NoEndpointError, withEndpoint } from '../config/networks';
import { OfflineNotice, TechnicalDetail, describeNetworkError } from '../wallet/connectivity';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { useWallet } from '../wallet/WalletContext';
import { EVM_CHAIN_ID } from '../wallet/send';
import { maskAmount } from '../config/prefs';
import { spokenAmount } from '../wallet/balances';
import {
  fetchErc20Metadata,
  validateErc20ContractAddress,
  type Erc20Metadata,
} from '../wallet/erc20';
import { addToken, listTokens, removeToken } from '../wallet/tokens';
import {
  FIND_TOKENS_WARNING,
  TOKEN_NAME_MAX,
  TOKEN_SYMBOL_MAX,
  cleanTokenText,
  discoverUntrackedTokens,
  discoverySummary,
  type DiscoveredToken,
  type DiscoveryOutcome,
} from '../wallet/token-discovery';

type Props = NativeStackScreenProps<RootStackParamList, 'Tokens'>;

/**
 * Fetched metadata strings are attacker-controlled contract output; cap
 * them so a hostile token cannot flood the UI, and strip control,
 * bidirectional and zero-width characters (token-discovery.ts
 * cleanTokenText, the balance-change preview's rule). Same caps apply to
 * manual entry for consistency.
 */
const MAX_SYMBOL_LENGTH = TOKEN_SYMBOL_MAX;
const MAX_NAME_LENGTH = TOKEN_NAME_MAX;

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
 *
 * Per chain (phase 13 item 1): the screen manages the ACTIVE EVM profile's
 * own list (mainnet, Ethereum Sepolia or Base Sepolia); lookups run against
 * that network's endpoint and a token is always stored under the chain the
 * endpoint that read it serves. "Find my tokens" lists untracked holdings
 * through the configured history indexer (wallet/token-discovery.ts) and
 * adds nothing until the user picks a token.
 */
export function TokensScreen({ navigation }: Props) {
  const theme = useTheme();
  const { evmChain, hideAmounts } = usePrefs();
  const { accounts } = useWallet();
  const owner = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const [tokens, setTokens] = useState<FungibleAsset[]>([]);
  const [address, setAddress] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  /** describeNetworkError's cleaned technical text for a failed lookup. */
  const [lookupTechnical, setLookupTechnical] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [manualSymbol, setManualSymbol] = useState('');
  const [manualName, setManualName] = useState('');
  /** The chain the preview was read from (the endpoint's own network). */
  const [previewChain, setPreviewChain] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<{ chain: string; outcome: DiscoveryOutcome } | null>(null);
  const [discoveryError, setDiscoveryError] = useState<{ message: string; technical: string | null } | null>(null);

  const reload = useCallback(() => {
    listTokens(evmChain.caip2).then(setTokens, () => setTokens([]));
  }, [evmChain.caip2]);

  useEffect(reload, [reload]);

  const resetForm = () => {
    setAddress('');
    setPreview(null);
    setLookupError(null);
    setLookupTechnical(null);
    setManualSymbol('');
    setManualName('');
    setPreviewChain(null);
  };

  const lookUp = async () => {
    setLookupError(null);
    setLookupTechnical(null);
    setPreview(null);
    const validation = validateErc20ContractAddress(address);
    if (!validation.ok) {
      setLookupError(validation.error);
      return;
    }
    setLookingUp(true);
    try {
      // Resolved now, with the shared failover rule (config/networks.ts).
      const { value: metadata, endpoint: used } = await withEndpoint(EVM_CHAIN_ID, (ep) =>
        fetchErc20Metadata(ep.url, validation.normalized),
      );
      // The token is stored under the chain that answered, and only when
      // that is the network on screen (a mode flip mid-lookup is refused).
      if (used.network.chainId !== evmChain.caip2) {
        setLookupError('The network changed while the token was looked up. Look it up again.');
        return;
      }
      setPreviewChain(used.network.chainId);
      setPreview({ address: validation.normalized, metadata });
      setManualSymbol('');
      setManualName('');
    } catch (e) {
      if (e instanceof NoEndpointError) {
        setLookupError('No Ethereum RPC endpoint configured. Set one in Settings first.');
      } else {
        const { title, detail, technical } = describeNetworkError(e, 'the token details');
        setLookupError(`${title}\n${detail}`);
        setLookupTechnical(technical);
      }
    } finally {
      setLookingUp(false);
    }
  };

  // An empty decoded string counts as missing too: a token symbol of ""
  // would be indistinguishable from a bug in every list it appears in.
  const fetchedSymbol = cleanTokenText(preview?.metadata.symbol, MAX_SYMBOL_LENGTH) ?? '';
  const fetchedName = cleanTokenText(preview?.metadata.name, MAX_NAME_LENGTH) ?? '';
  const effectiveSymbol =
    fetchedSymbol !== '' ? fetchedSymbol : (cleanTokenText(manualSymbol, MAX_SYMBOL_LENGTH) ?? '');
  const effectiveName =
    fetchedName !== '' ? fetchedName : (cleanTokenText(manualName, MAX_NAME_LENGTH) ?? '');

  const confirmAdd = async () => {
    if (!preview || effectiveSymbol === '' || previewChain !== evmChain.caip2) return;
    const asset: FungibleAsset = {
      kind: 'fungible',
      assetId: {
        chainId: previewChain,
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

  const findTokens = async () => {
    if (!owner) return;
    const chain = evmChain.caip2;
    setDiscovering(true);
    setDiscovery(null);
    setDiscoveryError(null);
    try {
      const { value: outcome } = await withEndpoint(EVM_CHAIN_ID, (ep) =>
        discoverUntrackedTokens({
          chainCaip2: chain,
          owner,
          rpc: { url: ep.url, chainId: ep.network.chainId },
        }),
      );
      setDiscovery({ chain, outcome });
    } catch (e) {
      if (e instanceof NoEndpointError) {
        setDiscoveryError({ message: `No RPC endpoint is configured for ${evmChain.label}.`, technical: null });
      } else {
        const { title, detail, technical } = describeNetworkError(e, 'your token list');
        setDiscoveryError({ message: `${title}\n${detail}`, technical });
      }
    } finally {
      setDiscovering(false);
    }
  };

  /** Tracks one discovered token (the user's explicit pick). */
  const trackDiscovered = async (found: DiscoveredToken) => {
    if (!found.asset || found.asset.assetId.chainId !== evmChain.caip2) return;
    try {
      await addToken(found.asset);
      setDiscovery((prev) =>
        prev && prev.outcome.status === 'ok'
          ? {
              ...prev,
              outcome: {
                ...prev.outcome,
                tokens: prev.outcome.tokens.filter((t) => t.contract !== found.contract),
                alreadyTracked: prev.outcome.alreadyTracked + 1,
              },
            }
          : prev,
      );
      reload();
    } catch (e) {
      Alert.alert('Not added', e instanceof Error ? e.message : 'Could not add this token.');
    }
  };

  // Results belong to the chain they were found on; after a mode flip they
  // are not shown (and cannot be tracked) on the other network.
  const shownDiscovery = discovery && discovery.chain === evmChain.caip2 ? discovery.outcome : null;

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

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Tracked tokens on {evmChain.label}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          ERC-20 balances shown on Home under {evmChain.label}. Each network
          keeps its own list. Tokens arrive at your address, and Send starts
          a token transfer — the network fee for a token send is paid in{' '}
          {evmChain.displaySymbol}.
          {evmChain.testnet
            ? ' This is a test network: its tokens (such as Circle\'s test USDC and EURC) have no value.'
            : ''}
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
                  accessibilityLabel={`Send ${token.symbol}`}
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
                  accessibilityLabel={`Remove ${token.symbol} from tracked tokens`}
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
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Find my tokens</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Lists tokens your address holds on {evmChain.label} that you do not
          track yet, using the history indexer in Settings. Their details are
          read from each token contract.
        </Text>
        <WarningBox>{FIND_TOKENS_WARNING}</WarningBox>
        {discovering ? (
          <ActivityIndicator size="small" color={theme.textMuted} />
        ) : (
          <Button
            title={shownDiscovery ? 'Search again' : 'Find my tokens'}
            variant="secondary"
            onPress={() => void findTokens()}
            disabled={!owner}
          />
        )}
        {discoveryError ? (
          <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.danger }]}>
            {discoveryError.message}
          </Text>
        ) : null}
        {discoveryError ? <TechnicalDetail text={discoveryError.technical} /> : null}
        {shownDiscovery && shownDiscovery.status !== 'ok' ? (
          <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.textMuted }]}>
            {shownDiscovery.note}
          </Text>
        ) : null}
        {shownDiscovery && shownDiscovery.status === 'unsupported' ? (
          <TechnicalDetail text={shownDiscovery.technical} />
        ) : null}
        {shownDiscovery && shownDiscovery.status === 'ok' ? (
          <>
            <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.textMuted }]}>
              {discoverySummary(shownDiscovery)}
            </Text>
            {shownDiscovery.tokens.map((found) => (
              <View
                key={found.contract}
                style={[styles.previewCard, { backgroundColor: theme.card, borderColor: theme.border }]}
              >
                <Text style={[styles.untrackedTag, { color: theme.textMuted }]}>UNTRACKED TOKEN</Text>
                <Text style={[styles.previewTitle, { color: theme.text }]}>
                  {found.symbol ?? 'Symbol unavailable'}
                  {found.name && found.name !== found.symbol ? ` — ${found.name}` : ''}
                </Text>
                <Text
                  accessibilityLabel={`Balance ${hideAmounts ? 'hidden' : spokenAmount(found.display)}`}
                  style={[styles.previewMeta, { color: theme.text }]}
                >
                  Balance: {maskAmount(found.display, hideAmounts)}
                </Text>
                <Text style={[styles.tokenAddress, { color: theme.textMuted }]}>
                  Contract {found.contract}
                </Text>
                {found.lookalikeOf ? (
                  <Text style={[styles.error, { color: theme.danger }]}>
                    Warning: this token uses the symbol {found.lookalikeOf} but its contract is
                    DIFFERENT from the {found.lookalikeOf} you track or the wallet knows on{' '}
                    {evmChain.label}. It may be a fake.
                  </Text>
                ) : null}
                {found.asset ? (
                  <Button
                    title={`Track ${found.asset.symbol}`}
                    accessibilityLabel={`Track ${found.asset.symbol}, contract ${found.contract}`}
                    variant="secondary"
                    onPress={() => void trackDiscovered(found)}
                  />
                ) : (
                  <>
                    <Text style={[styles.hint, { color: theme.textMuted }]}>
                      {found.note ?? 'The contract did not return a readable symbol.'} Add it
                      through the address form below to enter a symbol yourself.
                    </Text>
                    <Button
                      title="Use this address below"
                      variant="secondary"
                      onPress={() => {
                        resetForm();
                        setAddress(found.contract);
                      }}
                    />
                  </>
                )}
              </View>
            ))}
          </>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Add a token</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Paste the token&apos;s contract address on {evmChain.label}. Its symbol, name
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
            setLookupTechnical(null);
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
        {lookupError ? <TechnicalDetail text={lookupTechnical} /> : null}
        {lookingUp ? (
          <ActivityIndicator size="small" color={theme.textMuted} />
        ) : preview === null ? (
          <Button title="Look up token" onPress={() => void lookUp()} disabled={address.trim() === ''} />
        ) : null}

        {preview && previewChain === evmChain.caip2 ? (
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
  untrackedTag: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
});

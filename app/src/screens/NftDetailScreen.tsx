import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { parseAssetId } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { EVM_CHAIN_ID } from '../wallet/send';
import { NftImage } from '../components/NftImage';
import {
  fetchNftMetadata,
  formatTokenId,
  getCachedNft,
  nftCollectionTitle,
  nftDisplayName,
  nftExplorerUrl,
  sanitizeNftText,
  standardLabel,
  type MetadataLoad,
} from '../wallet/nfts';
import type { NftSendParams } from '../wallet/send-nft';

type Props = NativeStackScreenProps<RootStackParamList, 'NftDetail'>;

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/**
 * One NFT: image, name, collection, full token id, contract, standard,
 * ERC-1155 balance, explorer link, and the Send entry point. The NFT is
 * looked up in the gallery's in-memory list for the ACTIVE account and
 * chain (wallet/nfts.ts getCachedNft), so the screen can never show an
 * NFT that belongs to another account or network mode. When the indexer
 * had no metadata, the token's own tokenURI is read (same URI rules as
 * images); an unreachable or invalid document gives an honest note.
 */
export function NftDetailScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount } = useWallet();
  const { evmChain, hideAmounts } = usePrefs();
  const owner = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const { assetId } = route.params;
  const assetChain = useMemo(() => {
    try {
      return parseAssetId(assetId).chainId;
    } catch {
      return null;
    }
  }, [assetId]);
  const nft =
    owner && activeAccount && assetChain === evmChain.caip2
      ? getCachedNft(activeAccount.index, evmChain.caip2, owner, assetId)
      : null;
  const [metadata, setMetadata] = useState<MetadataLoad | null>(null);
  // Bumped by "Try again" after a failed metadata read.
  const [metadataTry, setMetadataTry] = useState(0);

  useEffect(() => {
    navigation.setOptions({ title: nft ? nftDisplayName(nft) : 'NFT' });
  }, [navigation, nft]);

  useEffect(() => {
    if (!nft || !nft.metadataMissing || !nft.tokenUri) return;
    let cancelled = false;
    fetchNftMetadata(nft).then(
      (m) => {
        if (!cancelled) setMetadata(m);
      },
      (e) => {
        if (!cancelled) setMetadata({ ok: false, detail: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
    // `nft` is the gallery cache's own object for this asset id (the same
    // reference on every render until the gallery reloads), so this runs
    // once per NFT, again after a gallery reload, and on "Try again".
  }, [nft, metadataTry]);

  if (!nft) {
    return (
      <View style={[screenStyle(theme), styles.padded]}>
        <Text style={[styles.body, { color: theme.textMuted }]}>
          {assetChain !== null && assetChain !== evmChain.caip2
            ? 'This NFT belongs to the other network mode. Switch Sepolia test mode in Settings → Developer to view it.'
            : 'This NFT is no longer in the loaded list. Go back and pull to refresh.'}
        </Text>
      </View>
    );
  }

  const fetched = metadata?.ok ? metadata.fields : null;
  const name = fetched?.name ?? sanitizeNftText(nft.name) ?? nftDisplayName(nft);
  const description = fetched?.description ?? sanitizeNftText(nft.description, 600);
  const explorer = nftExplorerUrl(evmChain.caip2, nft);
  const sendParams: NftSendParams = {
    assetId,
    standard: nft.standard,
    name: nftDisplayName(nft),
    collection: nftCollectionTitle(nft),
    balance: nft.balance.toString(),
  };

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <NftImage
        chainId={evmChain.caip2}
        nft={nft}
        variant="full"
        style={styles.hero}
        extraCandidates={fetched?.image ? [fetched.image] : []}
      />
      <Text style={[styles.name, { color: theme.text }]}>{name}</Text>
      {nft.spam === true ? (
        <WarningBox>
          The indexer flags this collection as spam. Spam NFTs are sent
          unsolicited and often advertise scam websites; do not visit links
          or addresses mentioned in them.
        </WarningBox>
      ) : null}

      <Row label="Collection" value={nftCollectionTitle(nft)} theme={theme} />
      <Row label="Token ID" value={formatTokenId(nft.tokenId)} mono theme={theme} />
      <Row label="Contract" value={nft.contract} mono theme={theme} />
      <Row label="Standard" value={standardLabel(nft.standard)} theme={theme} />
      {nft.standard === 'erc1155' ? (
        <Row
          label="You hold"
          value={hideAmounts ? '••••' : nft.balance.toString()}
          theme={theme}
        />
      ) : null}
      <Row label="Network" value={`${evmChain.label}${evmChain.testnet ? ' (TESTNET)' : ''}`} theme={theme} />
      {description ? (
        <View style={[styles.row, { borderColor: theme.border }]}>
          <Text style={[styles.rowLabel, { color: theme.textMuted }]}>Description</Text>
          <Text style={[styles.description, { color: theme.text }]}>{description}</Text>
        </View>
      ) : null}
      {nft.metadataMissing && nft.tokenUri && metadata === null ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>Reading the token&apos;s metadata…</Text>
      ) : null}
      {metadata && !metadata.ok ? (
        <>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Metadata unavailable — {metadata.detail}
          </Text>
          <Button
            title="Try again"
            variant="secondary"
            onPress={() => {
              setMetadata(null);
              setMetadataTry((n) => n + 1);
            }}
          />
        </>
      ) : null}
      {nft.metadataMissing && !nft.tokenUri ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The indexer has no metadata for this token and it lists no metadata URI.
        </Text>
      ) : null}

      <Button
        title="Send"
        onPress={() => navigation.navigate('Send', { chainId: EVM_CHAIN_ID, nft: sendParams })}
      />
      {explorer ? (
        <Button
          title="View on block explorer"
          variant="secondary"
          onPress={() => void Linking.openURL(explorer)}
        />
      ) : null}
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Names, descriptions and images are set by the NFT&apos;s creator and
        are shown as plain text; nothing in them is opened or run.
      </Text>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  mono: monoFont,
  theme,
}: {
  label: string;
  value: string;
  mono?: boolean;
  theme: ReturnType<typeof useTheme>;
}) {
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text
        selectable
        style={[styles.rowValue, { color: theme.text }, monoFont ? { fontFamily: mono, fontSize: 13 } : null]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  padded: { padding: 24 },
  content: { padding: 24, gap: 14 },
  hero: { width: '100%', aspectRatio: 1, borderRadius: 14 },
  name: { fontSize: 22, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  hint: { fontSize: 13, lineHeight: 19 },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 10, gap: 4 },
  rowLabel: { fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  rowValue: { fontSize: 16, fontWeight: '600' },
  description: { fontSize: 14, lineHeight: 20 },
});

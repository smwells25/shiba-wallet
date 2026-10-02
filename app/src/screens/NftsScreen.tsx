import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { OwnedNft } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { EVM_CHAIN_ID } from '../wallet/send';
import { NftImage } from '../components/NftImage';
import {
  groupNftsByCollection,
  loadMoreNfts,
  loadNfts,
  nftAssetIdString,
  nftDisplayName,
  shortContract,
  standardLabel,
  type NftCollectionGroup,
} from '../wallet/nfts';

type Props = NativeStackScreenProps<RootStackParamList, 'Nfts'>;

type LoadState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'error'; message: string }
  | { status: 'ok'; nfts: OwnedNft[]; nextCursor?: string; skipped: number };

type Row =
  | { type: 'header'; key: string; group: NftCollectionGroup }
  | { type: 'tiles'; key: string; items: OwnedNft[] };

const COLUMNS = 3;

/**
 * NFT gallery (phase 7 item 4) for the ACTIVE account on the ACTIVE EVM
 * chain (mainnet, or Sepolia in test mode). Ownership comes from the NFT
 * indexer configured in Settings; without one the screen says so and
 * points there. NFTs are grouped by collection; collections the indexer
 * flags as spam are hidden behind an explicit toggle (spam NFTs commonly
 * carry phishing text). Tapping a tile opens the detail screen.
 */
export function NftsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount } = useWallet();
  const { evmChain, hideAmounts } = usePrefs();
  const owner = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const accountIndex = activeAccount?.index ?? null;
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showSpam, setShowSpam] = useState(false);
  // Generation counter: a response from a superseded load (account or mode
  // switch, refresh) never overwrites a newer one.
  const generation = useRef(0);

  const load = useCallback(
    async (refresh: boolean) => {
      if (!owner || accountIndex === null) return;
      const gen = ++generation.current;
      if (refresh) setRefreshing(true);
      try {
        const result = await loadNfts({
          chainId: evmChain.caip2,
          accountIndex,
          owner,
          refresh,
        });
        if (gen !== generation.current) return;
        setState(
          result.status === 'unconfigured'
            ? { status: 'unconfigured' }
            : {
                status: 'ok',
                nfts: result.nfts,
                skipped: result.skipped,
                ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
              },
        );
      } catch (e) {
        if (gen === generation.current) {
          setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
        }
      } finally {
        if (gen === generation.current) setRefreshing(false);
      }
    },
    [owner, accountIndex, evmChain.caip2],
  );

  // A mode flip (mainnet <-> Sepolia) while this screen sits under
  // Settings must never show the other network's list, even briefly. The
  // list goes back to loading while rendering (React's "adjust state when a
  // prop changes" pattern), and the effect drops any response still in
  // flight for the previous network.
  const [listChain, setListChain] = useState(evmChain.caip2);
  if (listChain !== evmChain.caip2) {
    setListChain(evmChain.caip2);
    setState({ status: 'loading' });
  }
  useEffect(() => {
    generation.current += 1;
  }, [evmChain.caip2]);

  useFocusEffect(
    useCallback(() => {
      void load(false);
    }, [load]),
  );

  const onLoadMore = async () => {
    if (!owner || accountIndex === null || loadingMore) return;
    setLoadingMore(true);
    const gen = generation.current;
    try {
      const result = await loadMoreNfts({ chainId: evmChain.caip2, accountIndex, owner });
      if (gen !== generation.current || result.status !== 'ok') return;
      setState({
        status: 'ok',
        nfts: result.nfts,
        skipped: result.skipped,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      });
    } catch (e) {
      if (gen === generation.current) {
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const groups = useMemo(
    () => (state.status === 'ok' ? groupNftsByCollection(state.nfts) : []),
    [state],
  );
  const spamGroups = groups.filter((g) => g.spam);
  const spamItems = spamGroups.reduce((n, g) => n + g.items.length, 0);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const group of groups) {
      if (group.spam && !showSpam) continue;
      out.push({ type: 'header', key: `h:${group.key}`, group });
      for (let i = 0; i < group.items.length; i += COLUMNS) {
        const items = group.items.slice(i, i + COLUMNS);
        out.push({ type: 'tiles', key: `t:${group.key}:${i}`, items });
      }
    }
    return out;
  }, [groups, showSpam]);

  const header = (
    <View style={styles.headerBlock}>
      <Text style={[styles.networkLine, { color: evmChain.testnet ? '#e07800' : theme.textMuted }]}>
        {evmChain.label} · {evmChain.testnet ? 'TESTNET' : 'Mainnet'}
        {activeAccount ? ` · ${activeAccount.name}` : ''}
      </Text>
      {state.status === 'ok' && state.skipped > 0 ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {state.skipped} item{state.skipped === 1 ? '' : 's'} from the indexer{' '}
          {state.skipped === 1 ? 'was' : 'were'} left out because the data was inconsistent or
          unsupported (for example an ERC-721 token reported with a balance above one, which
          spam contracts produce, or a token standard the wallet cannot send).
        </Text>
      ) : null}
      {state.status === 'ok' && spamItems > 0 ? (
        <View style={styles.spamToggle}>
          <Switch value={showSpam} onValueChange={setShowSpam} />
          <Text style={[styles.spamLabel, { color: theme.text }]}>
            Show {spamItems} item{spamItems === 1 ? '' : 's'} flagged as spam
          </Text>
        </View>
      ) : null}
    </View>
  );

  if (state.status === 'loading') {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  if (state.status === 'unconfigured') {
    return (
      <View style={[screenStyle(theme), styles.padded]}>
        {header}
        <Text style={[styles.body, { color: theme.text }]}>
          NFTs need an indexer: a standard RPC node cannot list the NFTs an
          address owns. Add an NFT indexer URL for {evmChain.label} in
          Settings → NFT indexer to see your collection here.
        </Text>
        <Button title="Open Settings" onPress={() => navigation.navigate('Settings')} />
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={[screenStyle(theme), styles.padded]}>
        {header}
        <WarningBox>Could not load NFTs: {state.message}</WarningBox>
        <Button title="Retry" variant="secondary" onPress={() => void load(true)} />
      </View>
    );
  }

  const renderRow = ({ item }: { item: Row }) => {
    if (item.type === 'header') {
      const g = item.group;
      return (
        <View style={styles.groupHeader}>
          <Text style={[styles.groupTitle, { color: theme.text }]} numberOfLines={2}>
            {g.title}
          </Text>
          <Text style={[styles.groupMeta, { color: theme.textMuted }]}>
            {standardLabel(g.items[0]!.standard)} · {shortContract(g.contract)} · {g.items.length}{' '}
            item{g.items.length === 1 ? '' : 's'}
          </Text>
          {g.spam ? (
            <Text style={[styles.spamNote, { color: theme.danger }]}>
              Flagged as spam by the indexer. Spam NFTs often advertise
              scam websites in their names — do not visit them.
            </Text>
          ) : null}
        </View>
      );
    }
    return (
      <View style={styles.tileRow}>
        {item.items.map((nft) => {
          const assetId = nftAssetIdString(evmChain.caip2, nft);
          return (
            <Pressable
              key={assetId}
              accessibilityRole="button"
              accessibilityLabel={nftDisplayName(nft)}
              onPress={() => navigation.navigate('NftDetail', { assetId })}
              style={({ pressed }) => [styles.tile, { opacity: pressed ? 0.75 : 1 }]}
            >
              <NftImage chainId={evmChain.caip2} nft={nft} variant="thumb" style={styles.tileImage} />
              <Text style={[styles.tileName, { color: theme.text }]} numberOfLines={1}>
                {nftDisplayName(nft)}
              </Text>
              {nft.standard === 'erc1155' ? (
                <Text style={[styles.tileMeta, { color: theme.textMuted }]}>
                  × {hideAmounts ? '••••' : nft.balance.toString()}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
        {Array.from({ length: COLUMNS - item.items.length }, (_, i) => (
          <View key={`pad${i}`} style={styles.tile} />
        ))}
      </View>
    );
  };

  return (
    <FlatList
      style={screenStyle(theme)}
      contentContainerStyle={styles.list}
      data={rows}
      keyExtractor={(row) => row.key}
      renderItem={renderRow}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <Text style={[styles.body, { color: theme.textMuted }]}>
          {groups.length > 0
            ? 'Only spam-flagged items were found; use the switch above to show them.'
            : `No NFTs found for this account on ${evmChain.label}.`}
        </Text>
      }
      ListFooterComponent={
        <View style={styles.footer}>
          {state.nextCursor ? (
            loadingMore ? (
              <ActivityIndicator color={theme.accent} />
            ) : (
              <Button title="Load more" variant="secondary" onPress={() => void onLoadMore()} />
            )
          ) : null}
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Ownership comes from your NFT indexer and can lag the chain by a
            few blocks; sends re-check ownership on-chain. Images load from
            the indexer&apos;s image cache when possible, otherwise from the
            NFT&apos;s own host or an IPFS gateway, which can see your IP
            address. SVG images are never rendered.
          </Text>
        </View>
      }
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} />
      }
    />
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  padded: { padding: 24, gap: 14 },
  list: { padding: 16, gap: 8 },
  headerBlock: { gap: 8, marginBottom: 4 },
  networkLine: { fontSize: 13 },
  body: { fontSize: 15, lineHeight: 22 },
  hint: { fontSize: 13, lineHeight: 19 },
  spamToggle: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  spamLabel: { fontSize: 14, flex: 1 },
  groupHeader: { marginTop: 12, gap: 2 },
  groupTitle: { fontSize: 17, fontWeight: '700' },
  groupMeta: { fontSize: 12 },
  spamNote: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  tileRow: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, gap: 4 },
  tileImage: { width: '100%', aspectRatio: 1, borderRadius: 10 },
  tileName: { fontSize: 13, fontWeight: '600' },
  tileMeta: { fontSize: 12 },
  footer: { gap: 12, marginTop: 16 },
});

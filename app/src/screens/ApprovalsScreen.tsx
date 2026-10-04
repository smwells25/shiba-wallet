import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, ImportedKeyNotice, WarningBox, screenStyle } from '../components';
import { callWithFailover, getEndpoint, withEndpoint, type NetworkEndpoint } from '../config/networks';
import { endpointHost, findAlternateDefaultUrl, otherDefaultCandidates } from '../config/endpoint-probe';
import { OfflineNotice, TechnicalDetail, describeNetworkError } from '../wallet/connectivity';
import { useTheme, type Theme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits } from '../wallet/balances';
import {
  EVM_CHAIN_ID,
  QUOTE_ENDPOINT_CHANGED_TITLE,
  describeSendError,
  quoteEndpointChange,
  type SendResult,
} from '../wallet/send';
import { listTokens } from '../wallet/tokens';
import { loadNfts } from '../wallet/nfts';
import { listContacts, type Contact } from '../wallet/contacts';
import { classifyAddresses, type AddressTag } from '../wallet/risk';
import { BalanceChangePreview } from '../components/BalanceChangePreview';
import {
  APPROVALS_EXPLAINER,
  NFT_UNCONFIGURED_NOTE,
  NO_ENDPOINT_NOTE,
  REVOKE_ERC20_NOTE,
  REVOKE_OPERATOR_NOTE,
  SEARCH_OLDER_ELSEWHERE_TITLE,
  alternateSearchNote,
  approvalTokensForChain,
  approvalsScopeNote,
  approvalsTransport,
  knownTokenRefsForChain,
  nothingToCheckNote,
  testnetTokensNote,
  approvedAddress,
  collectionsFromNfts,
  describeApprovalAmount,
  extendApprovalScan,
  isUnlimitedNow,
  partitionApprovals,
  prepareRevoke,
  readLiveApprovals,
  refusedNote,
  revokedReason,
  scannedRangeNote,
  sendRevoke,
  spenderDisplay,
  startApprovalScan,
  zeroFirstNoteFor,
  type ApprovalItem,
  type ApprovalScan,
  type RevokeQuote,
} from '../wallet/approvals';

type Props = NativeStackScreenProps<RootStackParamList, 'Approvals'>;

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

type ListState =
  | { status: 'loading' }
  | { status: 'no-endpoint' }
  | { status: 'nothing'; notes: string[]; nftIndexerConfigured: boolean }
  /**
   * `title`: the calm sentence; `message`: a plain detail sentence;
   * `technical`: the cleaned endpoint text for the muted detail line.
   */
  | { status: 'error'; message: string; title: string; technical: string | null }
  | {
      status: 'ok';
      scan: ApprovalScan;
      items: ApprovalItem[];
      notes: string[];
      /** The endpoint the scan ran on (decides whether another default exists). */
      endpoint: NetworkEndpoint;
      /**
       * Set once the older search moved to another built-in default
       * endpoint: later "Search older blocks" taps keep using it.
       */
      logsUrl?: string;
      /** The result note of the last alternate-endpoint search. */
      alternateNote?: string;
      /** The other endpoint refused too (or none answered): stop offering it. */
      alternateRefused?: boolean;
    };

type Phase = 'list' | 'quoting' | 'confirm' | 'sending' | 'success';

/**
 * Token approvals manager (phase 7, item 5) for the ACTIVE account on the
 * ACTIVE EVM chain. Discovery, live re-reads and revoke quoting live in
 * ../wallet/approvals.ts; this screen only renders them. Everything shown
 * as active was confirmed with a live allowance() / isApprovedForAll read.
 * A revoke goes through the same confirm idioms as Send: network badge,
 * balance-change preview, eth_call gate with the explicit override switch,
 * biometric gate, success with the transaction id.
 */
export function ApprovalsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount, signWith } = useWallet();
  const { evmChain, hideAmounts } = usePrefs();
  const owner = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const accountIndex = activeAccount?.index ?? null;

  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [extending, setExtending] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tags, setTags] = useState<Record<string, AddressTag | null>>({});

  const [phase, setPhase] = useState<Phase>('list');
  const [revoke, setRevoke] = useState<RevokeQuote | null>(null);
  const [quotedFrom, setQuotedFrom] = useState<string | null>(null);
  // The endpoint URL the revoke quote came from; the revoke is sent only
  // through it, and only while the wallet would still use it.
  const [quotedUrl, setQuotedUrl] = useState<string | null>(null);
  const [overrideSimulation, setOverrideSimulation] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);

  // A response from a superseded load (mode flip, refresh) never wins.
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!owner) return;
    const gen = ++generation.current;
    try {
      const endpoint = await getEndpoint(EVM_CHAIN_ID);
      const rpcUrl = endpoint?.url ?? null;
      if (gen !== generation.current) return;
      setUrl(rpcUrl);
      void listContacts(evmChain.caip2).then(
        (list) => gen === generation.current && setContacts(list),
        () => undefined,
      );
      if (!endpoint || !rpcUrl) {
        setState({ status: 'no-endpoint' });
        return;
      }
      const notes: string[] = [];
      let trackedTokens: Awaited<ReturnType<typeof listTokens>> = [];
      try {
        trackedTokens = await listTokens(evmChain.caip2);
      } catch {
        trackedTokens = [];
      }
      // Tracked tokens plus the test-network tokens the wallet knows
      // (tokens.ts KNOWN_TEST_NETWORK_TOKENS), so the Sepolia USDC →
      // Permit2 allowance a swap leaves behind is listed.
      const tokens = approvalTokensForChain(trackedTokens, evmChain.caip2);
      if (evmChain.testnet) notes.push(testnetTokensNote(evmChain.label, knownTokenRefsForChain(evmChain.caip2)));
      let nftIndexerConfigured = true;

      let collections: ReturnType<typeof collectionsFromNfts>['collections'] = [];
      if (accountIndex !== null) {
        try {
          const nfts = await loadNfts({
            chainId: evmChain.caip2,
            accountIndex,
            owner,
          });
          if (nfts.status === 'unconfigured') {
            nftIndexerConfigured = false;
            notes.push(NFT_UNCONFIGURED_NOTE);
          } else {
            const fromNfts = collectionsFromNfts(nfts.nfts);
            collections = fromNfts.collections;
            if (fromNfts.spamSkipped > 0) {
              notes.push(
                `${fromNfts.spamSkipped} collection${fromNfts.spamSkipped === 1 ? '' : 's'} flagged as spam ` +
                  'by the NFT indexer were not checked.',
              );
            }
            if (nfts.nextCursor) {
              notes.push(
                'Only the NFT collections on the first loaded page of your gallery are checked; ' +
                  'load more in the NFT gallery to include the rest.',
              );
            }
          }
        } catch (e) {
          const why = describeNetworkError(e, 'the NFT list');
          notes.push(`NFT collections are not checked: the NFT list could not be loaded (${why.detail.replace(/\.$/, '')}).`);
        }
      }
      if (gen !== generation.current) return;
      if (tokens.length === 0 && collections.length === 0) {
        setState({ status: 'nothing', notes, nftIndexerConfigured });
        return;
      }

      // Shared failover rule (config/networks.ts): when the default
      // endpoint does not answer at all (the scan's first eth_blockNumber
      // throws), the whole scan runs again on the next healthy candidate.
      // Window refusals are answers, recorded by the scan as before.
      const {
        value: { scan, items },
        endpoint: used,
      } = await callWithFailover({ ...endpoint, url: rpcUrl }, async (ep) => {
        const scanTransport = approvalsTransport(ep.url);
        const started = await startApprovalScan({
          transport: scanTransport,
          owner,
          chainCaip2: evmChain.caip2,
          tokens,
          collections,
        });
        return { scan: started, items: await readLiveApprovals(scanTransport, started) };
      });
      if (gen !== generation.current) return;
      setUrl(used.url);
      setState({ status: 'ok', scan, items, notes, endpoint: used });
      const transport = approvalsTransport(used.url);

      // Address tags load after the list is visible (one eth_getCode each).
      const addresses = [...new Set(items.map((i) => approvedAddress(i)))];
      const nextTags = await classifyAddresses(transport, addresses);
      if (gen === generation.current) setTags(nextTags);
    } catch (e) {
      if (gen === generation.current) {
        const { title, detail, technical } = describeNetworkError(e, 'your approvals');
        setState({ status: 'error', message: detail, title, technical });
      }
    }
  }, [owner, accountIndex, evmChain.caip2, evmChain.testnet, evmChain.label]);

  // When the account or the active chain changes, the screen starts over:
  // the list goes back to loading, address tags are dropped and any open
  // revoke flow returns to the list. That reset happens while rendering
  // (React's "adjust state when a prop changes" pattern), keyed on exactly
  // the inputs that give `load` a new identity; the effect only starts the
  // asynchronous load.
  const [loadInputs, setLoadInputs] = useState({
    owner,
    accountIndex,
    caip2: evmChain.caip2,
    testnet: evmChain.testnet,
  });
  if (
    loadInputs.owner !== owner ||
    loadInputs.accountIndex !== accountIndex ||
    loadInputs.caip2 !== evmChain.caip2 ||
    loadInputs.testnet !== evmChain.testnet
  ) {
    setLoadInputs({ owner, accountIndex, caip2: evmChain.caip2, testnet: evmChain.testnet });
    setState({ status: 'loading' });
    setTags({});
    setPhase('list');
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after its first await (the endpoint lookup), never synchronously, and this rule does not treat await as an asynchronous boundary.
    void load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const onSearchOlder = async () => {
    if (state.status !== 'ok' || !url || extending) return;
    const gen = generation.current;
    setExtending(true);
    try {
      let scan: ApprovalScan;
      let items: ApprovalItem[];
      let transport: ReturnType<typeof approvalsTransport>;
      if (state.logsUrl) {
        // The older search already moved to another built-in default
        // (Search older with another endpoint): logs keep coming from it,
        // current allowances are still read through the wallet's endpoint.
        scan = await extendApprovalScan(state.scan, { transport: approvalsTransport(state.logsUrl) });
        transport = approvalsTransport(url);
        items = await readLiveApprovals(transport, scan);
      } else {
        // Resolved now, with the shared failover rule. Block ranges are chain
        // data, so continuing on another candidate of the same chain is sound.
        const { value, endpoint: used } = await withEndpoint(EVM_CHAIN_ID, async (ep) => {
          const extendTransport = approvalsTransport(ep.url);
          const extended = await extendApprovalScan(state.scan, { transport: extendTransport });
          return { scan: extended, items: await readLiveApprovals(extendTransport, extended) };
        });
        ({ scan, items } = value);
        transport = approvalsTransport(used.url);
        if (gen !== generation.current) return;
        setUrl(used.url);
      }
      if (gen !== generation.current) return;
      setState({ ...state, scan, items });
      const missing = [...new Set(items.map((i) => approvedAddress(i)))].filter(
        (a) => !(a.toLowerCase() in tags),
      );
      if (missing.length > 0) {
        const more = await classifyAddresses(transport, missing);
        if (gen === generation.current) setTags((prev) => ({ ...prev, ...more }));
      }
    } catch (e) {
      const { title, detail } = describeNetworkError(e, 'older approvals');
      Alert.alert('Search failed', `${title}\n\n${detail}`);
    } finally {
      setExtending(false);
    }
  };

  /**
   * After an archive-depth refusal: re-runs the refused window (and the
   * rest of that step) through another of the network's built-in default
   * endpoints, verified to be the same chain first (endpoint-probe.ts
   * findAlternateDefaultUrl). Read-only: revoke quotes and sends keep using
   * the wallet's own endpoint. Never offered around a user override.
   */
  const onSearchOlderElsewhere = async () => {
    if (state.status !== 'ok' || !url || extending) return;
    const gen = generation.current;
    setExtending(true);
    try {
      const network = state.endpoint.network;
      const alternate = await findAlternateDefaultUrl(network, state.logsUrl ?? url, state.endpoint.isOverride);
      if (gen !== generation.current) return;
      if (!alternate) {
        setState({
          ...state,
          alternateNote: 'No other built-in endpoint answered for this network right now.',
          alternateRefused: true,
        });
        return;
      }
      const scan = await extendApprovalScan(state.scan, { transport: approvalsTransport(alternate) });
      const transport = approvalsTransport(url);
      const items = await readLiveApprovals(transport, scan);
      if (gen !== generation.current) return;
      const refusedAgain = scan.refused !== null && scan.scannedFromBlock === state.scan.scannedFromBlock;
      setState({
        ...state,
        scan,
        items,
        ...(refusedAgain ? {} : { logsUrl: alternate }),
        alternateNote: alternateSearchNote(endpointHost(alternate), refusedAgain),
        alternateRefused: refusedAgain,
      });
      const missing = [...new Set(items.map((i) => approvedAddress(i)))].filter(
        (a) => !(a.toLowerCase() in tags),
      );
      if (missing.length > 0) {
        const more = await classifyAddresses(transport, missing);
        if (gen === generation.current) setTags((prev) => ({ ...prev, ...more }));
      }
    } catch (e) {
      const { title, detail } = describeNetworkError(e, 'older approvals');
      Alert.alert('Search failed', `${title}\n\n${detail}`);
    } finally {
      setExtending(false);
    }
  };

  const onRevokePress = async (item: ApprovalItem) => {
    if (!url || !owner) return;
    setPhase('quoting');
    try {
      // Quoted through the endpoint the wallet would use NOW, with the
      // shared failover rule; the quote is pinned to the URL that answered.
      const { value: next, endpoint: used } = await withEndpoint(EVM_CHAIN_ID, (ep) =>
        prepareRevoke({ url: ep.url, from: owner, item, expectedCaip2: evmChain.caip2 }),
      );
      setUrl(used.url);
      setQuotedUrl(used.url);
      setRevoke(next);
      setQuotedFrom(owner);
      setOverrideSimulation(false);
      setPhase('confirm');
    } catch (e) {
      const { title, detail } = describeSendError(e, evmChain.displaySymbol);
      Alert.alert(title, detail);
      setPhase('list');
    }
  };

  const onConfirmRevoke = async () => {
    if (!quotedUrl || !revoke || !quotedFrom) return;
    const revokeUrl = quotedUrl;
    let currentUrl: string | null = null;
    try {
      currentUrl = (await getEndpoint(EVM_CHAIN_ID))?.url ?? null;
    } catch {
      currentUrl = null;
    }
    const changed = quoteEndpointChange(revokeUrl, currentUrl);
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      setRevoke(null);
      setPhase('list');
      return;
    }
    const what =
      revoke.item.kind === 'erc20'
        ? `${revoke.item.symbol} allowance`
        : `operator approval on ${revoke.item.title}`;
    const auth = await requireLocalAuth(`Approve revoking the ${what}`);
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const sent = await signWith(EVM_CHAIN_ID, quotedFrom, (signer) =>
        sendRevoke(revokeUrl, signer, revoke, evmChain.explorerTxBase),
      );
      setResult(sent);
      setPhase('success');
    } catch (e) {
      const { title, detail } = describeSendError(e, evmChain.displaySymbol);
      Alert.alert(title, detail);
      setPhase('confirm');
    }
  };

  const display = (address: string) => spenderDisplay(evmChain.caip2, address, contacts, tags);

  // ------------------------------------------------------------- success
  if (phase === 'success' && result) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.successTitle, { color: theme.success }]}>Revoke sent ✓</Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>Transaction id</Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {result.txid}
          </Text>
        </View>
        {result.explorerUrl ? (
          <Button
            title="View on block explorer"
            variant="secondary"
            onPress={() => void Linking.openURL(result.explorerUrl!)}
          />
        ) : null}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The approval disappears from the active list once the transaction is
          included in a block. Pull down on the list to re-check.
        </Text>
        <Button
          title="Done"
          onPress={() => {
            setResult(null);
            setRevoke(null);
            setPhase('list');
            void load();
          }}
        />
      </ScrollView>
    );
  }

  // ------------------------------------------------------------- confirm
  if ((phase === 'confirm' || phase === 'sending') && revoke && quotedFrom) {
    const { item, quote } = revoke;
    const simulationFailed = !quote.simulation.ok;
    const blocked = (simulationFailed || revoke.returnedFalse) && !overrideSimulation;
    const who = display(approvedAddress(item));
    const zeroFirst = zeroFirstNoteFor(item);
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Row label="From account" value={activeAccount?.name ?? '—'} sub={quotedFrom} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        <Row
          label="Action"
          value={item.kind === 'erc20' ? `Revoke ${item.symbol} allowance` : 'Revoke collection-wide approval'}
          theme={theme}
        />
        <Row
          label={item.kind === 'erc20' ? 'Token contract' : 'Collection'}
          value={item.kind === 'erc20' ? item.contract : `${item.title}\n${item.contract}`}
          mono={item.kind === 'erc20'}
          theme={theme}
        />
        <SpenderRow
          label={item.kind === 'erc20' ? 'Spender' : 'Operator'}
          name={who.name}
          address={who.address}
          tag={who.tag}
          theme={theme}
        />
        <Row label="Current approval" value={describeApprovalAmount(item, hideAmounts)} theme={theme} />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {item.kind === 'erc20' ? REVOKE_ERC20_NOTE : REVOKE_OPERATOR_NOTE}
        </Text>
        {zeroFirst ? <Text style={[styles.hint, { color: theme.textMuted }]}>{zeroFirst}</Text> : null}
        <Row
          label={`Max network fee (paid in ${evmChain.displaySymbol})`}
          value={`${formatUnits(quote.fee, 18, 18)} ${evmChain.displaySymbol}`}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Worst case at {formatUnits(quote.maxFeePerGas, 9, 9)} gwei max fee ×{' '}
          {quote.gasLimit.toString()} gas; the actual fee is usually lower. Revoking
          is a normal transaction and costs this fee even though no tokens move.
        </Text>
        <Row
          label={`${evmChain.displaySymbol} balance`}
          value={`${formatUnits(quote.balance, 18, 18)} ${evmChain.displaySymbol}`}
          theme={theme}
        />

        <BalanceChangePreview
          url={quotedUrl}
          request={{ from: quotedFrom, to: item.contract, value: 0n, data: quote.data }}
        />

        {!simulationFailed && !revoke.returnedFalse ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}>
            Pre-flight simulation passed (eth_call).
          </Text>
        ) : (
          <View style={styles.simulationBlock}>
            <WarningBox>
              {simulationFailed
                ? `Pre-flight simulation failed: ${
                    quote.simulation.ok ? '' : quote.simulation.reason
                  }. This transaction would very likely fail on-chain and still cost the fee.`
                : 'The token contract reports the revoke would not go through: approve() ' +
                  'returned false instead of reverting. Sending anyway would cost the fee ' +
                  'and leave the allowance unchanged.'}
            </WarningBox>
            <View style={styles.overrideRow}>
              <Switch
                accessibilityLabel="Send anyway, although the pre-flight simulation failed"
                value={overrideSimulation}
                onValueChange={setOverrideSimulation}
              />
              <Text style={[styles.overrideLabel, { color: theme.text }]}>
                Send anyway (I understand it will probably fail)
              </Text>
            </View>
          </View>
        )}

        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Signing and broadcasting…</Text>
          </View>
        ) : (
          <>
            <Button title="Revoke" onPress={() => void onConfirmRevoke()} disabled={blocked} />
            <Button title="Back" variant="secondary" onPress={() => setPhase('list')} />
          </>
        )}
      </ScrollView>
    );
  }

  // ---------------------------------------------------------------- list
  const header = (
    <View style={styles.headerBlock}>
      <Text style={[styles.networkLine, { color: evmChain.testnet ? theme.testnetFill : theme.textMuted }]}>
        {evmChain.label} · {evmChain.testnet ? 'TESTNET' : 'Mainnet'}
        {activeAccount ? ` · ${activeAccount.name}` : ''}
      </Text>
      <OfflineNotice />
      <Text style={[styles.body, { color: theme.text }]}>{APPROVALS_EXPLAINER}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{approvalsScopeNote(evmChain.testnet)}</Text>
    </View>
  );

  if (state.status === 'loading' || phase === 'quoting') {
    return (
      <View style={[screenStyle(theme), styles.centerFill]}>
        <ActivityIndicator size="large" color={theme.accent} />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {phase === 'quoting' ? 'Preparing the revoke…' : 'Searching approval events…'}
        </Text>
      </View>
    );
  }

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => void onRefresh()}
      tintColor={theme.accent}
      colors={[theme.accent]}
    />
  );

  if (state.status !== 'ok') {
    return (
      <ScrollView
        style={screenStyle(theme)}
        contentContainerStyle={styles.content}
        refreshControl={refreshControl}
      >
        {header}
        {state.status === 'no-endpoint' ? (
          <>
            <Text style={[styles.body, { color: theme.text }]}>{NO_ENDPOINT_NOTE}</Text>
            <Button
              title="Open network endpoint settings"
              onPress={() => navigation.navigate('Settings', { section: 'network-endpoints' })}
            />
          </>
        ) : null}
        {state.status === 'nothing' ? (
          <>
            {state.notes.map((n) => (
              <Text key={n} style={[styles.hint, { color: theme.textMuted }]}>
                {n}
              </Text>
            ))}
            <Text style={[styles.body, { color: theme.text }]}>
              {nothingToCheckNote({ testnet: evmChain.testnet, nftIndexerConfigured: state.nftIndexerConfigured })}
            </Text>
            <Button title="Manage tokens" variant="secondary" onPress={() => navigation.navigate('Tokens')} />
          </>
        ) : null}
        {state.status === 'error' ? (
          <>
            <Text style={[styles.body, { color: theme.text }]}>
              {state.title}
            </Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{state.message}</Text>
            <TechnicalDetail text={state.technical} />
            <Button title="Try again" onPress={() => void onRefresh()} />
          </>
        ) : null}
      </ScrollView>
    );
  }

  const { active, unconfirmed, revoked } = partitionApprovals(state.items);
  // Another built-in default endpoint exists (never around an override):
  // after a refusal the screen offers to search older blocks through it.
  const alternateAvailable =
    !state.alternateRefused &&
    otherDefaultCandidates(state.endpoint.network.defaultUrls, state.logsUrl ?? url ?? null, state.endpoint.isOverride)
      .length > 0;
  const refused = refusedNote(state.scan, { alternateAvailable });

  const renderItem = (item: ApprovalItem, withRevoke: boolean) => {
    const who = display(approvedAddress(item));
    const zeroFirst = zeroFirstNoteFor(item);
    const unlimited = isUnlimitedNow(item);
    return (
      <View key={item.key} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.cardTitle, { color: theme.text }]}>
          {item.kind === 'erc20' ? item.symbol : item.title}
          <Text style={[styles.kind, { color: theme.textMuted }]}>
            {item.kind === 'erc20' ? '  ERC-20 allowance' : '  NFT operator (whole collection)'}
          </Text>
        </Text>
        <Text selectable style={[styles.monoSmall, { color: theme.textMuted }]}>
          {item.contract}
        </Text>
        <SpenderRow
          label={item.kind === 'erc20' ? 'Spender' : 'Operator'}
          name={who.name}
          address={who.address}
          tag={who.tag}
          theme={theme}
        />
        <Text
          style={[
            styles.amount,
            { color: unlimited || (item.kind === 'operator' && withRevoke) ? theme.warningText : theme.text },
          ]}
        >
          {describeApprovalAmount(item, hideAmounts)}
        </Text>
        {!withRevoke && item.live.status === 'ok' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{revokedReason(item)}</Text>
        ) : null}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Last approval event in block {item.loggedBlock.toString()}
        </Text>
        {zeroFirst && withRevoke ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{zeroFirst}</Text>
        ) : null}
        {withRevoke ? (
          <Button title="Revoke" variant="secondary" onPress={() => void onRevokePress(item)} />
        ) : null}
      </View>
    );
  };

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} refreshControl={refreshControl}>
      {header}
      {state.notes.map((n) => (
        <Text key={n} style={[styles.hint, { color: theme.textMuted }]}>
          {n}
        </Text>
      ))}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{scannedRangeNote(state.scan)}</Text>
      {refused ? <WarningBox>{refused}</WarningBox> : null}
      {state.alternateNote ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>{state.alternateNote}</Text>
      ) : null}
      {refused && alternateAvailable && !state.scan.exhausted ? (
        <Button
          title={extending ? 'Searching…' : SEARCH_OLDER_ELSEWHERE_TITLE}
          variant="secondary"
          disabled={extending}
          accessibilityHint="Searches the refused older blocks through another built-in endpoint for this network"
          onPress={() => void onSearchOlderElsewhere()}
        />
      ) : null}
      {state.scan.skippedLogs > 0 ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {state.scan.skippedLogs} approval event{state.scan.skippedLogs === 1 ? '' : 's'} had a
          non-standard format and {state.scan.skippedLogs === 1 ? 'was' : 'were'} not used, so this
          list may be incomplete.
        </Text>
      ) : null}

      <Text style={[styles.sectionTitle, { color: theme.text }]}>Active approvals</Text>
      {active.length === 0 ? (
        <Text style={[styles.body, { color: theme.textMuted }]}>
          No active approvals found in the searched range.
        </Text>
      ) : (
        active.map((item) => renderItem(item, true))
      )}

      {unconfirmed.length > 0 ? (
        <>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Could not confirm</Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            The current state of these approvals could not be read, so they are shown neither as
            active nor as revoked. You can still revoke them.
          </Text>
          {unconfirmed.map((item) => renderItem(item, true))}
        </>
      ) : null}

      {!state.scan.exhausted && !refused ? (
        <Button
          title={extending ? 'Searching…' : 'Search older blocks'}
          variant="secondary"
          disabled={extending}
          onPress={() => void onSearchOlder()}
        />
      ) : null}

      {revoked.length > 0 ? (
        <View style={styles.revokedToggle}>
          <Switch
            accessibilityLabel="Show revoked or used-up approvals"
            value={showRevoked}
            onValueChange={setShowRevoked}
          />
          <Text style={[styles.overrideLabel, { color: theme.text }]}>
            Show {revoked.length} revoked or used-up approval{revoked.length === 1 ? '' : 's'}
          </Text>
        </View>
      ) : null}
      {showRevoked ? revoked.map((item) => renderItem(item, false)) : null}
    </ScrollView>
  );
}

function NetworkBadge({ label, testnet, theme }: { label: string; testnet: boolean; theme: Theme }) {
  return testnet ? (
    <View style={[styles.badge, { backgroundColor: theme.testnetFill, borderColor: theme.testnetFill }]}>
      <Text style={[styles.badgeText, { color: theme.onTestnetFill }]}>{label} TESTNET — test funds only</Text>
    </View>
  ) : (
    <View style={[styles.badge, { backgroundColor: theme.dangerSurface, borderColor: theme.danger }]}>
      <Text style={[styles.badgeText, { color: theme.danger }]}>{label} Mainnet — real funds</Text>
    </View>
  );
}

function Row({
  label,
  value,
  sub = null,
  mono: monoFont,
  theme,
}: {
  label: string;
  value: string;
  sub?: string | null;
  mono?: boolean;
  theme: Theme;
}) {
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text
        selectable
        // "—" is a visual placeholder; screen readers hear "not available".
        {...(value === '—' ? { accessibilityLabel: 'not available' } : {})}
        style={[styles.rowValue, { color: theme.text }, monoFont ? { fontFamily: mono, fontSize: 13 } : null]}
      >
        {value}
      </Text>
      {sub ? <Text style={[styles.rowSub, { color: theme.textMuted }]}>{sub}</Text> : null}
    </View>
  );
}

/**
 * A spender/operator: the contact name WITH the full address on an exact
 * contact match, otherwise the full address with its code tag.
 */
function SpenderRow({
  label,
  name,
  address,
  tag,
  theme,
}: {
  label: string;
  name: string | null;
  address: string;
  tag: AddressTag | null;
  theme: Theme;
}) {
  return (
    <View style={styles.spender}>
      <Text style={[styles.rowLabel, { color: theme.textMuted }]}>
        {label}
        {name ? ' · saved contact' : tag ? ` · ${tag}` : ''}
      </Text>
      {name ? <Text style={[styles.contactName, { color: theme.text }]}>{name}</Text> : null}
      <Text selectable style={[styles.monoText, { color: theme.text }]}>
        {address}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 48,
  },
  centerFill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  center: {
    alignItems: 'center',
    gap: 8,
  },
  headerBlock: {
    gap: 8,
  },
  networkLine: {
    fontSize: 13,
    fontWeight: '600',
  },
  body: {
    fontSize: 15,
    lineHeight: 21,
  },
  hint: {
    fontSize: 13,
    lineHeight: 18,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginTop: 8,
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  kind: {
    fontSize: 13,
    fontWeight: '400',
  },
  amount: {
    fontSize: 15,
    fontWeight: '600',
  },
  spender: {
    gap: 2,
  },
  contactName: {
    fontSize: 15,
    fontWeight: '600',
  },
  monoText: {
    fontFamily: mono,
    fontSize: 13,
  },
  monoSmall: {
    fontFamily: mono,
    fontSize: 12,
  },
  label: {
    fontSize: 13,
  },
  box: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  successTitle: {
    fontSize: 22,
    fontWeight: '700',
  },
  badge: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  badgeText: {
    fontSize: 14,
    fontWeight: '700',
  },
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 8,
    gap: 2,
  },
  rowLabel: {
    fontSize: 13,
  },
  rowValue: {
    fontSize: 15,
  },
  rowSub: {
    fontSize: 12,
  },
  simulationOk: {
    fontSize: 14,
    fontWeight: '600',
  },
  simulationBlock: {
    gap: 8,
  },
  overrideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  overrideLabel: {
    flex: 1,
    fontSize: 14,
  },
  revokedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
});

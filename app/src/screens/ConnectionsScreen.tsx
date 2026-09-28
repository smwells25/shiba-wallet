import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { QrScanner } from '../components/QrScanner';
import { getEndpoint } from '../config/networks';
import { useTheme, type Theme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import type { EvmChainProfile } from '../config/evm-chain';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits } from '../wallet/balances';
import {
  EVM_CHAIN_ID,
  describeSendError,
  prepareEvmSend,
  sendEvm,
  type EvmSendQuote,
} from '../wallet/send';
import {
  approveProposal,
  describeProposal,
  disconnectWcSession,
  getWcProjectId,
  initWalletConnect,
  parseWcRequest,
  rejectProposal,
  respondApproved,
  respondRejected,
  signDigest,
  summarizeSessions,
  validatePairingUri,
  WcRequestRejection,
  type ParsedWcRequest,
  type WcClient,
  type WcProposalSummary,
  type WcRequestEvent,
  type WcSessionSummary,
} from '../wallet/walletconnect';

type Props = NativeStackScreenProps<RootStackParamList, 'Connections'>;

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** One user decision waiting in the approval queue (shown one at a time). */
type PendingItem =
  | { type: 'proposal'; event: { id: number; params: unknown }; summary: WcProposalSummary }
  | { type: 'request'; event: WcRequestEvent; parsed: ParsedWcRequest };

type TxQuoteState =
  | { status: 'loading' }
  | { status: 'ready'; quote: EvmSendQuote; url: string }
  | { status: 'error'; message: string };

/**
 * WalletConnect connections: QR-scan or paste-URI pairing, the active
 * session list, and the approval modal for session proposals and
 * sign/transaction requests. Scanning (phase 4 item 4) goes through the
 * shared QrScanner (expo-camera, bundled in Expo Go SDK 57 — see
 * ../components/QrScanner.tsx for the verification notes) and feeds the
 * exact same pairing path as pasting: validatePairingUri, then
 * walletKit.pair. Pasting remains fully supported — scanning is only a
 * convenience and a denied camera permission blocks nothing.
 *
 * Requests are handled while this screen is open (the SDK queues undelivered
 * requests, and pending ones are re-emitted on the next init); a global
 * request listener that surfaces approvals from any screen is a later,
 * additive step.
 */
export function ConnectionsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, signWith } = useWallet();
  // Active EVM chain (config/evm-chain.ts): the WalletConnect namespace,
  // request routing, chain-id verification, badge and explorer all follow
  // it — eip155:11155111 while Sepolia test mode is on. Requests for the
  // inactive chain are declined with UNSUPPORTED_CHAINS by parseWcRequest,
  // so sessions from one mode are never served in the other.
  const { evmChain } = usePrefs();
  const evmChainRef = useRef<EvmChainProfile>(evmChain);
  evmChainRef.current = evmChain;
  const ethAccount = accounts.find((a) => a.chainId === EVM_CHAIN_ID);
  const ethAddress = ethAccount?.address ?? null;
  const addressRef = useRef(ethAddress);
  addressRef.current = ethAddress;

  const [projectId, setProjectId] = useState<string | null | undefined>(undefined);
  const [kit, setKit] = useState<WcClient | null>(null);
  const [initBusy, setInitBusy] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [uri, setUri] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [sessions, setSessions] = useState<WcSessionSummary[]>([]);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [txQuote, setTxQuote] = useState<TxQuoteState | null>(null);
  const [overrideSimulation, setOverrideSimulation] = useState(false);

  const refreshSessions = useCallback((client: WcClient) => {
    try {
      setSessions(summarizeSessions(client.getActiveSessions()));
    } catch {
      setSessions([]);
    }
  }, []);

  const addNotice = useCallback((line: string) => {
    setNotices((prev) => [line, ...prev].slice(0, 3));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getWcProjectId().then(
      (id) => {
        if (!cancelled) setProjectId(id);
      },
      () => {
        if (!cancelled) setProjectId(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Initialize the SDK once a project id exists, and wire the event
  // listeners. Every decision the listeners make is delegated to the pure
  // functions in wallet/walletconnect.ts.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let client: WcClient | null = null;

    const onProposal = (event: { id: number; params: unknown }) => {
      setPending((prev) => [
        ...prev,
        {
          type: 'proposal',
          event,
          summary: describeProposal(event, [evmChainRef.current.caip2]),
        },
      ]);
    };
    const onRequest = (event: WcRequestEvent) => {
      const address = addressRef.current;
      if (!client) return;
      if (!address) {
        void respondRejected(client, event.topic, event.id, {
          code: -32603,
          message: 'Wallet account unavailable.',
        });
        return;
      }
      try {
        const parsed = parseWcRequest(event, address, evmChainRef.current.caip2);
        setPending((prev) => [...prev, { type: 'request', event, parsed }]);
      } catch (e) {
        // Unsupported / malformed: answer with a proper error response
        // immediately — the dApp gets a decline, never a timeout.
        const rejection =
          e instanceof WcRequestRejection
            ? e
            : new WcRequestRejection(-32603, 'The request could not be processed.');
        void respondRejected(client, event.topic, event.id, rejection);
        addNotice(
          `Declined ${event.params?.request?.method ?? 'request'}: ${rejection.message}`,
        );
      }
    };
    const onSessionsChanged = () => {
      if (client) refreshSessions(client);
    };

    setInitBusy(true);
    setInitError(null);
    initWalletConnect(projectId).then(
      (c) => {
        if (cancelled) return;
        client = c;
        c.on('session_proposal', onProposal as never);
        c.on('session_request', onRequest as never);
        c.on('session_delete', onSessionsChanged as never);
        setKit(c);
        setInitBusy(false);
        refreshSessions(c);
      },
      (e) => {
        if (cancelled) return;
        setInitBusy(false);
        setInitError(
          e instanceof Error ? e.message : 'WalletConnect could not be initialized.',
        );
      },
    );
    return () => {
      cancelled = true;
      if (client) {
        client.off('session_proposal', onProposal as never);
        client.off('session_request', onRequest as never);
        client.off('session_delete', onSessionsChanged as never);
      }
    };
  }, [projectId, refreshSessions, addNotice]);

  const head = pending[0] ?? null;

  // Transaction requests need a fee quote (the same machinery as the Send
  // screen: chain-id verification, estimateGas with the dApp's calldata,
  // eth_call simulation) before the user can see what they would approve.
  useEffect(() => {
    if (!head || head.type !== 'request' || head.parsed.kind !== 'transaction') {
      setTxQuote(null);
      setOverrideSimulation(false);
      return;
    }
    const address = addressRef.current;
    if (!address) {
      setTxQuote({ status: 'error', message: 'Wallet account unavailable.' });
      return;
    }
    let cancelled = false;
    setTxQuote({ status: 'loading' });
    setOverrideSimulation(false);
    const { tx } = head.parsed;
    (async () => {
      // getEndpoint translates the EVM slot to the active network
      // (Sepolia in test mode); the quote then verifies the endpoint's
      // eth_chainId against the same active profile.
      const endpoint = await getEndpoint(EVM_CHAIN_ID);
      if (!endpoint?.url) throw new Error('No Ethereum RPC endpoint is configured.');
      const quote = await prepareEvmSend(
        endpoint.url,
        address,
        tx.to,
        tx.valueWei,
        tx.data.length > 0 ? tx.data : undefined,
        evmChainRef.current.caip2,
      );
      return { quote, url: endpoint.url };
    })().then(
      (r) => {
        if (!cancelled) setTxQuote({ status: 'ready', quote: r.quote, url: r.url });
      },
      (e) => {
        if (!cancelled) {
          const { title, detail } = describeSendError(e, 'ETH');
          setTxQuote({ status: 'error', message: `${title}\n${detail}` });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [head]);

  const shift = useCallback(() => {
    setPending((prev) => prev.slice(1));
    setActionBusy(false);
  }, []);

  // One pairing path for both entry points: the paste field's Connect
  // button and the QR scanner both come through here, so validation
  // (validatePairingUri) and the SDK call are identical either way.
  const pairWith = async (candidate: string) => {
    if (!kit) return;
    const checked = validatePairingUri(candidate);
    if (!checked.ok) {
      Alert.alert('Invalid pairing URI', checked.error);
      return;
    }
    setPairBusy(true);
    try {
      await kit.pair({ uri: checked.uri });
      setUri('');
      // The session_proposal event opens the approval modal from here.
    } catch (e) {
      Alert.alert(
        'Pairing failed',
        e instanceof Error ? e.message : 'The pairing URI was not accepted.',
      );
    } finally {
      setPairBusy(false);
    }
  };

  const onPair = () => pairWith(uri);

  const onApproveProposal = async (item: Extract<PendingItem, { type: 'proposal' }>) => {
    if (!kit || !ethAddress) return;
    const auth = await requireLocalAuth(`Connect to ${item.summary.name}`);
    if (!auth.ok) {
      Alert.alert('Not connected', auth.message);
      return;
    }
    setActionBusy(true);
    try {
      const outcome = await approveProposal(kit, item.event, ethAddress, [evmChain.caip2]);
      if (!outcome.approved) {
        Alert.alert('Connection rejected', outcome.reason);
      }
      refreshSessions(kit);
    } catch (e) {
      Alert.alert('Connection failed', e instanceof Error ? e.message : 'Approval failed.');
    } finally {
      shift();
    }
  };

  const onRejectProposal = async (item: Extract<PendingItem, { type: 'proposal' }>) => {
    if (!kit) return;
    setActionBusy(true);
    try {
      await rejectProposal(kit, item.event.id);
    } catch {
      // The dApp side may have already expired the proposal; nothing to do.
    } finally {
      shift();
    }
  };

  const onApproveRequest = async (item: Extract<PendingItem, { type: 'request' }>) => {
    if (!kit) return;
    const dapp = sessions.find((s) => s.topic === item.event.topic)?.name ?? 'the dApp';
    const promptTitle =
      item.parsed.kind === 'transaction' ? `Approve transaction for ${dapp}` : `Sign for ${dapp}`;
    const auth = await requireLocalAuth(promptTitle);
    if (!auth.ok) {
      Alert.alert('Not approved', auth.message);
      return;
    }
    setActionBusy(true);
    try {
      if (item.parsed.kind === 'personal_sign' || item.parsed.kind === 'typed_data') {
        const digest =
          item.parsed.kind === 'personal_sign'
            ? item.parsed.digest
            : item.parsed.typedData.digest;
        const signature = await signWith(EVM_CHAIN_ID, async (signer) =>
          signDigest(signer, digest),
        );
        await respondApproved(kit, item.event.topic, item.event.id, signature);
        shift();
        return;
      }
      // Transaction: sign + broadcast through the existing EOA machinery,
      // then hand the transaction hash back to the dApp.
      if (txQuote?.status !== 'ready') return;
      const { quote, url } = txQuote;
      const sent = await signWith(EVM_CHAIN_ID, (signer) =>
        sendEvm(url, signer, quote, evmChain.explorerTxBase),
      );
      await respondApproved(kit, item.event.topic, item.event.id, sent.txid);
      shift();
      Alert.alert('Transaction sent', sent.txid);
    } catch (e) {
      setActionBusy(false);
      const { title, detail } = describeSendError(e, 'ETH');
      Alert.alert(title, detail);
    }
  };

  const onRejectRequest = async (item: Extract<PendingItem, { type: 'request' }>) => {
    if (!kit) return;
    setActionBusy(true);
    try {
      await respondRejected(kit, item.event.topic, item.event.id);
    } catch {
      // Session may already be gone; the queue moves on regardless.
    } finally {
      shift();
    }
  };

  const onDisconnect = (session: WcSessionSummary) => {
    if (!kit) return;
    Alert.alert('Disconnect?', `End the connection with ${session.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          try {
            await disconnectWcSession(kit, session.topic);
          } catch {
            // Relay hiccups must not leave a ghost row; refresh regardless.
          }
          refreshSessions(kit);
        },
      },
    ]);
  };

  // ------------------------------------------------------------- gates
  if (projectId === undefined) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  if (projectId === null) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>WalletConnect is off</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Connecting to dApps uses the WalletConnect relay network, which
          requires a project id. Create one for free at dashboard.reown.com
          (no personal data from this wallet is involved — the id only
          identifies the app to the relay), then save it in Settings under
          "WalletConnect".
        </Text>
        <Button title="Open Settings" onPress={() => navigation.navigate('Settings')} />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {initBusy ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Connecting to the WalletConnect relay…
          </Text>
        </View>
      ) : null}

      {initError ? (
        <WarningBox>
          WalletConnect could not start: {initError} Check the project id in
          Settings and the network connection, then reopen this screen.
        </WarningBox>
      ) : null}

      {kit ? (
        <>
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Connect a dApp</Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              In the dApp, choose WalletConnect, then scan its QR code — or
              copy the pairing link (wc:…) and paste it here.
            </Text>
            <Button
              title="Scan QR code"
              variant="secondary"
              onPress={() => setScannerOpen(true)}
              disabled={pairBusy}
            />
            <TextInput
              value={uri}
              onChangeText={setUri}
              placeholder="wc:…"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.input,
                { color: theme.text, borderColor: theme.border, backgroundColor: theme.card },
              ]}
            />
            <Button
              title={pairBusy ? 'Connecting…' : 'Connect'}
              onPress={() => void onPair()}
              disabled={pairBusy || uri.trim() === ''}
            />
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Active connections</Text>
            {sessions.length === 0 ? (
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                No dApps are connected.
              </Text>
            ) : (
              sessions.map((session) => (
                <View
                  key={session.topic}
                  style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
                >
                  <Text style={[styles.cardTitle, { color: theme.text }]}>{session.name}</Text>
                  {session.url ? (
                    <Text style={[styles.cardLine, { color: theme.textMuted }]} numberOfLines={1}>
                      {session.url}
                    </Text>
                  ) : null}
                  <Text style={[styles.cardLine, { color: theme.textMuted }]}>
                    {session.chains.join(', ') || 'no chains'} ·{' '}
                    {session.methods.length} method{session.methods.length === 1 ? '' : 's'}
                  </Text>
                  <Button
                    title="Disconnect"
                    variant="secondary"
                    onPress={() => onDisconnect(session)}
                  />
                </View>
              ))
            )}
          </View>

          {notices.length > 0 ? (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Recent declines</Text>
              {notices.map((n, i) => (
                <Text key={i} style={[styles.hint, { color: theme.textMuted }]}>
                  {n}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      <QrScanner
        visible={scannerOpen}
        rationale="Point the camera at the dApp's WalletConnect QR code. The camera is only used to read the code."
        onScanned={(data) => {
          setScannerOpen(false);
          // Show what was scanned in the field, then run the same
          // validate-and-pair path as the Connect button.
          setUri(data);
          void pairWith(data);
        }}
        onClose={() => setScannerOpen(false)}
      />

      <Modal visible={head !== null} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <View
            style={[styles.modalCard, { backgroundColor: theme.background, borderColor: theme.border }]}
          >
            <ScrollView contentContainerStyle={styles.modalContent}>
              {head?.type === 'proposal' ? (
                <ProposalBody
                  summary={head.summary}
                  theme={theme}
                  busy={actionBusy}
                  activeChain={evmChain.caip2}
                  onApprove={() => void onApproveProposal(head)}
                  onReject={() => void onRejectProposal(head)}
                />
              ) : null}
              {head?.type === 'request' ? (
                <RequestBody
                  item={head}
                  dappName={sessions.find((s) => s.topic === head.event.topic)?.name ?? 'Unknown dApp'}
                  theme={theme}
                  busy={actionBusy}
                  evmChain={evmChain}
                  txQuote={txQuote}
                  overrideSimulation={overrideSimulation}
                  setOverrideSimulation={setOverrideSimulation}
                  onApprove={() => void onApproveRequest(head)}
                  onReject={() => void onRejectRequest(head)}
                />
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function ProposalBody({
  summary,
  theme,
  busy,
  activeChain,
  onApprove,
  onReject,
}: {
  summary: WcProposalSummary;
  theme: Theme;
  busy: boolean;
  /** CAIP-2 id of the active EVM chain (mainnet or Sepolia test mode). */
  activeChain: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  const blocked = summary.unsupportedRequired.length > 0;
  return (
    <>
      <Text style={[styles.modalTitle, { color: theme.text }]}>Connection request</Text>
      <Field label="dApp" value={summary.name} theme={theme} />
      {summary.url ? <Field label="URL" value={summary.url} theme={theme} /> : null}
      {summary.description ? (
        <Field label="Description" value={summary.description} theme={theme} />
      ) : null}
      <Field
        label="Requested chains"
        value={
          [...summary.requiredChains, ...summary.optionalChains].join(', ') || 'none specified'
        }
        theme={theme}
      />
      <Field
        label="Requested methods"
        value={summary.methods.join(', ') || 'none specified'}
        theme={theme}
      />
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Approving shares your Ethereum address with this dApp and lets it
        send signature and transaction requests. Every request still needs
        your explicit approval here — nothing is ever signed automatically.
      </Text>
      {blocked ? (
        <WarningBox>
          The dApp requires {summary.unsupportedRequired.join(', ')}, which this
          wallet does not support over WalletConnect right now (only {activeChain}).
          Approving will fail and the connection will be rejected properly.
        </WarningBox>
      ) : null}
      {busy ? (
        <ActivityIndicator color={theme.accent} />
      ) : (
        <>
          <Button title="Approve connection" onPress={onApprove} />
          <Button title="Reject" variant="secondary" onPress={onReject} />
        </>
      )}
    </>
  );
}

function RequestBody({
  item,
  dappName,
  theme,
  busy,
  evmChain,
  txQuote,
  overrideSimulation,
  setOverrideSimulation,
  onApprove,
  onReject,
}: {
  item: { event: WcRequestEvent; parsed: ParsedWcRequest };
  dappName: string;
  theme: Theme;
  busy: boolean;
  /** Active EVM chain profile (badge, amount labels, testnet state). */
  evmChain: EvmChainProfile;
  txQuote: TxQuoteState | null;
  overrideSimulation: boolean;
  setOverrideSimulation: (v: boolean) => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { parsed } = item;

  if (parsed.kind === 'personal_sign') {
    return (
      <>
        <Text style={[styles.modalTitle, { color: theme.text }]}>Sign message</Text>
        <Field label="From dApp" value={dappName} theme={theme} />
        <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>
          {parsed.messageText !== null ? 'Message' : 'Message (hex — not printable text)'}
        </Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {parsed.messageText ?? parsed.messageHex}
          </Text>
        </View>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Signing proves account ownership to the dApp (EIP-191). It costs
          nothing and moves no funds, but only sign messages from dApps you
          trust.
        </Text>
        {busy ? (
          <ActivityIndicator color={theme.accent} />
        ) : (
          <>
            <Button title="Sign" onPress={onApprove} />
            <Button title="Reject" variant="secondary" onPress={onReject} />
          </>
        )}
      </>
    );
  }

  if (parsed.kind === 'typed_data') {
    const { typedData } = parsed;
    return (
      <>
        <Text style={[styles.modalTitle, { color: theme.text }]}>Sign typed data</Text>
        <Field label="From dApp" value={dappName} theme={theme} />
        {typedData.domain.name ? (
          <Field label="Signing domain" value={typedData.domain.name} theme={theme} />
        ) : null}
        {typedData.domain.verifyingContract ? (
          <Field
            label="Verifying contract"
            value={typedData.domain.verifyingContract}
            monoValue
            theme={theme}
          />
        ) : null}
        <Field label="Type" value={typedData.primaryType} theme={theme} />
        <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>Message</Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {JSON.stringify(typedData.message, null, 2)}
          </Text>
        </View>
        <WarningBox>
          Typed-data signatures can authorize on-chain actions later (token
          permits, orders). Only approve if you understand what this dApp
          does with it.
        </WarningBox>
        {busy ? (
          <ActivityIndicator color={theme.accent} />
        ) : (
          <>
            <Button title="Sign" onPress={onApprove} />
            <Button title="Reject" variant="secondary" onPress={onReject} />
          </>
        )}
      </>
    );
  }

  // Transaction request — the same confirm presentation as the Send screen.
  const quoteReady = txQuote?.status === 'ready';
  const simulationFailed = quoteReady && !txQuote.quote.simulation.ok;
  const approveBlocked = !quoteReady || (simulationFailed && !overrideSimulation);
  return (
    <>
      <Text style={[styles.modalTitle, { color: theme.text }]}>Transaction request</Text>
      {evmChain.testnet ? (
        <View style={[styles.mainnetBadge, { backgroundColor: '#e07800', borderColor: '#e07800' }]}>
          <Text style={[styles.mainnetBadgeText, { color: '#ffffff' }]}>
            {evmChain.label} TESTNET — test funds only
          </Text>
        </View>
      ) : (
        <View
          style={[
            styles.mainnetBadge,
            { backgroundColor: theme.dangerSurface, borderColor: theme.danger },
          ]}
        >
          <Text style={[styles.mainnetBadgeText, { color: theme.danger }]}>
            Ethereum Mainnet — real funds
          </Text>
        </View>
      )}
      <Field label="From dApp" value={dappName} theme={theme} />
      <Field label="To" value={parsed.tx.to} monoValue theme={theme} />
      <Field
        label="Amount"
        value={`${formatUnits(parsed.tx.valueWei, 18, 18)} ${evmChain.displaySymbol}`}
        theme={theme}
      />
      {parsed.tx.data.length > 0 ? (
        <Field
          label={`Calldata (${parsed.tx.data.length} bytes)`}
          value={truncateHex(parsed.tx.data)}
          monoValue
          theme={theme}
        />
      ) : null}
      {txQuote?.status === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Fetching fee quote and simulating…
          </Text>
        </View>
      ) : null}
      {txQuote?.status === 'error' ? <WarningBox>{txQuote.message}</WarningBox> : null}
      {quoteReady ? (
        <>
          <Field
            label="Max network fee"
            value={`${formatUnits(txQuote.quote.fee, 18, 18)} ${evmChain.displaySymbol}`}
            theme={theme}
          />
          <Field
            label="Total (worst case)"
            value={`${formatUnits(txQuote.quote.total, 18, 18)} ${evmChain.displaySymbol}`}
            theme={theme}
          />
          {txQuote.quote.simulation.ok ? (
            <Text style={[styles.simulationOk, { color: theme.success }]}>
              Pre-flight simulation passed (eth_call).
            </Text>
          ) : (
            <>
              <WarningBox>
                Pre-flight simulation failed:{' '}
                {txQuote.quote.simulation.ok === false ? txQuote.quote.simulation.reason : ''}.
                This transaction would very likely fail on-chain and still
                cost the fee.
              </WarningBox>
              <View style={styles.overrideRow}>
                <Switch value={overrideSimulation} onValueChange={setOverrideSimulation} />
                <Text style={[styles.overrideLabel, { color: theme.text }]}>
                  Send anyway (I understand it will probably fail)
                </Text>
              </View>
            </>
          )}
        </>
      ) : null}
      {busy ? (
        <ActivityIndicator color={theme.accent} />
      ) : (
        <>
          <Button title="Approve & send" onPress={onApprove} disabled={approveBlocked} />
          <Button title="Reject" variant="secondary" onPress={onReject} />
        </>
      )}
    </>
  );
}

function truncateHex(data: Uint8Array): string {
  const hex = '0x' + [...data.slice(0, 64)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return data.length > 64 ? `${hex}… (+${data.length - 64} bytes)` : hex;
}

function Field({
  label,
  value,
  monoValue,
  theme,
}: {
  label: string;
  value: string;
  monoValue?: boolean;
  theme: Theme;
}) {
  return (
    <View style={[styles.fieldRow, { borderColor: theme.border }]}>
      <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text
        selectable
        style={[
          styles.fieldValue,
          { color: theme.text },
          monoValue ? { fontFamily: mono, fontSize: 13 } : null,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 20,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 12,
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
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 14,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  cardLine: {
    fontSize: 13,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  modalCard: {
    maxHeight: '88%',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
  },
  modalContent: {
    padding: 24,
    gap: 14,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  fieldRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 8,
    gap: 3,
  },
  fieldLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldValue: {
    fontSize: 15,
    fontWeight: '600',
  },
  box: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
  },
  monoText: {
    fontFamily: mono,
    fontSize: 13,
    lineHeight: 19,
  },
  mainnetBadge: {
    borderRadius: 12,
    borderWidth: 1.5,
    padding: 12,
    alignItems: 'center',
  },
  mainnetBadgeText: {
    fontSize: 15,
    fontWeight: '700',
  },
  simulationOk: {
    fontSize: 14,
    fontWeight: '600',
  },
  overrideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  overrideLabel: {
    fontSize: 14,
    flex: 1,
  },
});

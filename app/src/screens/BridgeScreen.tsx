import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { httpTransport as evmHttpTransport } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { spokenShortAddress } from '../a11y';
import { Button, ImportedKeyNotice, TestNetworksOnlyCard, WarningBox, screenStyle, switchColors, useFieldLabels } from '../components';
import { callWithFailover, getEndpoint, type NetworkEndpoint, type UsableEndpoint } from '../config/networks';
import { readinessGate } from '../config/readiness';
import { sanitizeEndpointMessage } from '../config/endpoint-probe';
import { useTheme } from '../theme';
import { BalanceChangePreview } from '../components/BalanceChangePreview';
import { RiskWarnings } from '../components/RiskWarnings';
import { SpendingPolicyNotice, spendingGateForQuote } from '../components/SpendingPolicyViews';
import { AaDepositNote } from '../components/AaDepositNote';
import { NOTE_VIEW_SCROLL_PROPS, TransactionNoteField, dismissKeyboardThenClose } from '../components/TransactionNoteField';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { AsyncStorage } from '../wallet/store-keys';
import { parseUnits } from '../wallet/balances';
import { multisigRouteRefusal, watchOnlyRouteRefusal } from '../wallet/watch-only';
import {
  EVM_CHAIN_ID,
  QUOTE_ENDPOINT_CHANGED_TITLE,
  describeSendError,
  quoteEndpointChange,
  sendEvm,
  type EvmSendQuote,
  type SendResult,
} from '../wallet/send';
import {
  KERNEL_BUNDLER_NOTE,
  aaAccountTypeLabel,
  aaSenderLabel,
  checkAaQuoteBeforeApproval,
  createAaClientFromConfig,
  describeAaError,
  effectiveAaAccountType,
  getAaConfig,
  isAaConfigured,
  resolveAaSender,
  sendAa,
  waitForAaReceipt,
  type AaChainConfig,
  type AaClientBundle,
  type AaSendQuote,
} from '../wallet/aa';
import { PREVIEW_AA_NOTE } from '../wallet/simulation';
import {
  BRIDGE_CHOICE_NOTE,
  BRIDGE_INTRO,
  BRIDGE_RECORDS_NOTE,
  BRIDGE_RECORDS_READ_ONLY_MESSAGE,
  BRIDGE_TRACK_INTERVAL_MS,
  BridgeRefusal,
  bridgeConfirmModel,
  bridgeOfferFor,
  bridgePromptTitle,
  bridgeProviderRows,
  bridgeRetryBlocker,
  bridgeRetryCall,
  bridgeRetryPromptTitle,
  bridgeSourceFeeLines,
  bridgeTransferFinal,
  defaultChainTransport,
  listBridgeTransfers,
  loadBridgeTransfers,
  prepareBridgeAa,
  prepareBridgeRetry,
  prepareBridgeSend,
  quoteBridge,
  recordBridgeTransfer,
  resetBridgeTransfers,
  regularRecipientNote,
  smartAccountRecipientNote,
  subscribeBridgeTransfers,
  upgradedAccountRecipientNote,
  trackBridgeTransfer,
  updateBridgeTransfer,
  type BridgeOffer,
  type BridgePlan,
  type BridgeReaders,
  type BridgeTransferRecord,
} from '../wallet/bridge';
import { NetworkBadge, Row, exact18, stakingStyles as styles } from './StakingViews';
import { BridgeWarning, ProviderRadioRow, TransferStatusCard, TrustStatementCard, type ProviderRowQuote } from './BridgeViews';

type Props = NativeStackScreenProps<RootStackParamList, 'Bridge'>;

/**
 * The readers the adapters need: the active network's endpoint for the
 * active network, the built-in default endpoints (with failover) for every
 * other network.
 */
function bridgeReadersFor(activeChainIdDecimal: string, sourceUrl: string | null): BridgeReaders {
  return {
    transportFor: (chainId: number) =>
      sourceUrl !== null && String(chainId) === activeChainIdDecimal ? evmHttpTransport(sourceUrl) : defaultChainTransport(chainId),
  };
}

/**
 * Asks where one recorded transfer is and stores the answer (or the error,
 * as plain text) on the record. A transfer already being checked is
 * skipped, so the 15-second timer and "Check now" never overlap.
 */
async function checkBridgeRecord(
  record: BridgeTransferRecord,
  readers: BridgeReaders,
  inFlight: Set<string>,
  busy: (id: string, on: boolean) => void,
): Promise<void> {
  if (inFlight.has(record.id)) return;
  inFlight.add(record.id);
  busy(record.id, true);
  try {
    const status = await trackBridgeTransfer(record, readers);
    updateBridgeTransfer(record.id, { status, checkedAt: Date.now(), checkError: null });
  } catch (e) {
    const text = sanitizeEndpointMessage(errorText(e));
    updateBridgeTransfer(record.id, { checkedAt: Date.now(), checkError: text === '' ? 'No details were given.' : text });
  } finally {
    inFlight.delete(record.id);
    busy(record.id, false);
  }
}

/**
 * The smart-account bundle, built from the node URL it is pinned to (its
 * quotes come from it, so the send is pinned to it like the regular path),
 * rebuilt only when one of its inputs changes.
 */
function useBridgeAaBundle(
  active: boolean,
  url: string | null,
  aaConfig: AaChainConfig | null,
  accountIndex: number | null,
  ownerAddress: string | null,
  chainIdDecimal: string,
): { bundle: AaClientBundle | null; url: string | null; error: string | null } {
  return useMemo(() => {
    if (!active || !url || !aaConfig || accountIndex === null || ownerAddress === null) return { bundle: null, url: null, error: null };
    try {
      const bundle = createAaClientFromConfig(aaConfig, { nodeUrl: url, chainId: BigInt(chainIdDecimal), accountIndex, ownerAddress });
      return { bundle, url, error: null };
    } catch (e) {
      return { bundle: null, url: null, error: `The smart account could not be set up: ${errorText(e)}` };
    }
  }, [active, url, aaConfig, accountIndex, ownerAddress, chainIdDecimal]);
}

/** What the screen offers on `caip2`, or the sentence why not (pure; no request). */
function offerOrError(caip2: string, refused: boolean): { offer: BridgeOffer | null; error: string | null } {
  if (refused) return { offer: null, error: null };
  try {
    return { offer: bridgeOfferFor(caip2), error: null };
  } catch (e) {
    return { offer: null, error: errorText(e) };
  }
}

type Phase = 'form' | 'preparing' | 'confirm' | 'sending' | 'aa-confirm' | 'aa-sending' | 'success';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A refusal (this wallet's or the provider's own, shown verbatim) is its
 * own sentence; anything else in the send screens' wording with the
 * network's coin name.
 */
function describeBridgeError(e: unknown, symbol: string): string {
  const name = (e as { name?: unknown } | null)?.name;
  if (e instanceof BridgeRefusal || name === 'BridgeRefusal' || name === 'FeatureNotAllowedError') return errorText(e);
  const { title, detail } = describeSendError(e, symbol, symbol);
  const clean = sanitizeEndpointMessage(detail);
  return clean === '' ? title : `${title}\n${clean}`;
}

/**
 * Bridging (feature 35, phase 21 item 1; docs/BRIDGE_PROVIDERS.md): test
 * ETH from the active test network to another one, through a provider the
 * USER chooses from every provider the wallet knows, each shown with its
 * own trust statement, fee and measured time. TEST NETWORKS ONLY (readiness
 * row 'bridge', enforced here before any request and again in
 * wallet/bridge.ts). Watch-only and multi-signature accounts are refused by
 * name (the route gate, and again here).
 *
 * The quote comes from the provider adapter in the engine, is checked by
 * wallet/bridge.ts on its own (pinned pool, value = amount + messaging fee,
 * recipient and destination words, no approval for a native pool), and is
 * then sent through the EXISTING confirm idioms: prepareEvmSend / sendEvm
 * for the regular account, prepareAaCalls / sendAa for the smart account,
 * with the balance-change preview, the risk card, the spending limits and
 * the pre-flight (eth_call or the bundler's estimate) before the device
 * check. The recipient is always the regular account (see wallet/bridge.ts
 * for why). Transfers are followed every 15 seconds while this screen is
 * open, from the chains' own events.
 */
export function BridgeScreen({ navigation }: Props) {
  const theme = useTheme();
  const fieldLabel = useFieldLabels();
  const { accounts, signWith, activeAccount } = useWallet();
  const { evmChain } = usePrefs();
  const account = accounts.find((a) => a.chainId === EVM_CHAIN_ID);
  const caip2 = evmChain.caip2;
  const symbol = evmChain.displaySymbol;
  const gate = readinessGate('bridge', caip2);
  const keyless = activeAccount?.watchOnly === true ? watchOnlyRouteRefusal('Bridge') : activeAccount?.multisig === true ? multisigRouteRefusal('Bridge') : null;

  const [endpoint, setEndpoint] = useState<NetworkEndpoint | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('form');
  const [destination, setDestination] = useState<number | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [amountText, setAmountText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [rowQuotes, setRowQuotes] = useState<{ key: string; byProvider: Record<string, ProviderRowQuote | string> } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [plan, setPlan] = useState<BridgePlan | null>(null);
  const [eoaQuote, setEoaQuote] = useState<EvmSendQuote | null>(null);
  const [aaQuote, setAaQuote] = useState<AaSendQuote | null>(null);
  const [quotedUrl, setQuotedUrl] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const [aaResult, setAaResult] = useState<{ userOpHash: string; receiptState: 'pending' | 'found' | 'timeout'; success: boolean | null; txHash: string | null } | null>(null);
  const [sentNetwork, setSentNetwork] = useState<string | null>(null);
  const [sentRecordId, setSentRecordId] = useState<string | null>(null);
  const preparedFrom = useRef<string | null>(null);

  const [aaConfig, setAaConfig] = useState<AaChainConfig | null>(null);
  const [aaEnabled, setAaEnabled] = useState(false);

  // Transfers sent from this screen (stored per wallet; wallet/bridge.ts), and which are being checked.
  const [records, setRecords] = useState<BridgeTransferRecord[]>(() => listBridgeTransfers());
  const [recordsReadOnly, setRecordsReadOnly] = useState(false);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  useEffect(() => subscribeBridgeTransfers(() => setRecords(listBridgeTransfers())), []);
  useEffect(() => {
    let cancelled = false;
    loadBridgeTransfers().then(
      (r) => !cancelled && setRecordsReadOnly(r.readOnly),
      () => !cancelled && setRecordsReadOnly(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const onResetTransfers = () => {
    Alert.alert('Reset the transfer list?', 'This forgets every bridge transfer listed on this phone. Nothing on the network changes.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () => {
          void resetBridgeTransfers(AsyncStorage)
            .then(() => loadBridgeTransfers())
            .then(
              (r) => setRecordsReadOnly(r.readOnly),
              () => setRecordsReadOnly(true),
            );
        },
      },
    ]);
  };

  useEffect(() => {
    navigation.setOptions({ title: 'Bridge (test networks)' });
  }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    getEndpoint(EVM_CHAIN_ID).then(
      (e) => !cancelled && setEndpoint(e ?? null),
      () => !cancelled && setEndpoint(null),
    );
    return () => {
      cancelled = true;
    };
  }, [caip2]);

  useEffect(() => {
    let cancelled = false;
    getAaConfig(caip2).then(
      (c) => !cancelled && setAaConfig(c),
      () => !cancelled && setAaConfig(null),
    );
    return () => {
      cancelled = true;
    };
  }, [caip2]);

  // The offer is pure (no request): the readiness gate and the pinned tables.
  const { offer, error: offerError } = offerOrError(caip2, gate !== null || keyless !== null);
  const sendableDestinations = offer ? offer.destinations.filter((d) => d.sendable) : [];
  const chosenDestination = destination ?? sendableDestinations[0]?.chainId ?? offer?.destinations[0]?.chainId ?? null;
  const rows = offer && chosenDestination !== null ? bridgeProviderRows(offer, chosenDestination) : [];
  const chosenProvider = providerId !== null && rows.some((r) => r.id === providerId && r.selectable) ? providerId : (rows.find((r) => r.selectable)?.id ?? null);
  const destinationLabel = offer?.destinations.find((d) => d.chainId === chosenDestination)?.label ?? '';

  const url = endpoint?.url ?? null;
  const aaType = aaConfig ? effectiveAaAccountType(aaConfig, account?.address) : null;
  const aaOffered =
    offer !== null &&
    offer.unavailable === null &&
    aaConfig !== null &&
    isAaConfigured(aaConfig, account?.address) &&
    (aaType === 'kernel-v3.3' || aaType === 'kernel-7702') &&
    url !== null;
  const aaActive = aaOffered && aaEnabled;
  // Primitive inputs only (the account objects are rebuilt on every render).
  const ownerAddress = account?.address ?? null;
  const accountIndex = activeAccount?.index ?? null;
  const aa = useBridgeAaBundle(aaActive, url, aaConfig, accountIndex, ownerAddress, evmChain.chainIdDecimal);

  /** The readers for the adapters: the given endpoint for the active network, the built-in defaults elsewhere. */
  const readersFor = (sourceUrl: string | null): BridgeReaders => bridgeReadersFor(evmChain.chainIdDecimal, sourceUrl);

  // Tracking: every 15 s while this screen is open, each transfer that is
  // not delivered or failed is asked again (one check per transfer at a
  // time, never overlapping). The effect depends on primitives only, so a
  // re-render does not restart the timer.
  const checkingRef = useRef<Set<string>>(new Set());
  const trackingOn = gate === null && keyless === null;
  const chainIdDecimal = evmChain.chainIdDecimal;
  const markChecking = (id: string, busy: boolean) => setChecking((c) => ({ ...c, [id]: busy }));
  const checkTransfer = (record: BridgeTransferRecord) =>
    checkBridgeRecord(record, bridgeReadersFor(chainIdDecimal, url), checkingRef.current, markChecking);
  useEffect(() => {
    if (!trackingOn) return;
    const inFlight = checkingRef.current;
    const busy = (id: string, on: boolean) => setChecking((c) => ({ ...c, [id]: on }));
    const tick = () => {
      const readers = bridgeReadersFor(chainIdDecimal, url);
      for (const r of listBridgeTransfers()) {
        if (!bridgeTransferFinal(r) && r.sourceTxHash !== null) void checkBridgeRecord(r, readers, inFlight, busy);
      }
    };
    tick();
    const timer = setInterval(tick, BRIDGE_TRACK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [trackingOn, chainIdDecimal, url]);

  // ------------------------------------------------------------ guards
  if (gate) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <TestNetworksOnlyCard feature={gate.feature} hint={gate.hint} />
      </ScrollView>
    );
  }
  if (keyless) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <WarningBox>{keyless}</WarningBox>
      </ScrollView>
    );
  }
  if (!account) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted }}>No Ethereum account.</Text>
      </View>
    );
  }
  if (endpoint === undefined || offer === null) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        {offerError ? <WarningBox>{offerError}</WarningBox> : <ActivityIndicator size="large" color={theme.accent} />}
      </ScrollView>
    );
  }

  // ------------------------------------------------------------ helpers
  const currentEndpoint = async (): Promise<UsableEndpoint> => {
    const fresh = await getEndpoint(EVM_CHAIN_ID);
    if (!fresh || fresh.url === null) {
      setEndpoint(fresh ?? null);
      throw new Error('No Ethereum endpoint is configured. Set one in Settings → Network endpoints.');
    }
    if (fresh.network.chainId !== caip2) throw new Error('The network changed while this screen was open. Start again.');
    if (fresh.url !== url) setEndpoint(fresh);
    return { ...fresh, url: fresh.url };
  };

  const pinnedEndpointProblem = async (pinned: string): Promise<string | null> => {
    let current: string | null = null;
    try {
      current = (await getEndpoint(EVM_CHAIN_ID))?.url ?? null;
    } catch {
      current = null;
    }
    return quoteEndpointChange(pinned, current);
  };

  const backToForm = (message: string) => {
    setFormError(message === '' ? null : message);
    setPlan(null);
    setEoaQuote(null);
    setAaQuote(null);
    setPhase('form');
  };

  const parseAmount = (): bigint | null => {
    try {
      const amount = parseUnits(amountText, 18);
      if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
      return amount;
    } catch (e) {
      setFormError(errorText(e));
      return null;
    }
  };

  /** Quotes one provider for the form's choices (no send path involved). */
  const quotePlan = async (amount: bigint, provider: string, sourceUrl: string): Promise<BridgePlan> => {
    if (chosenDestination === null) throw new BridgeRefusal('Choose the network to send to.');
    const bundle = aa.bundle;
    if (aaActive && bundle) {
      const sender = await resolveAaSender(bundle, account.address);
      return quoteBridge({
        caip2,
        destinationChainId: chosenDestination,
        providerId: provider,
        amount,
        sender,
        senderKind: 'smart-account',
        recipient: account.address,
        nativeSymbol: symbol,
        readers: readersFor(sourceUrl),
      });
    }
    return quoteBridge({
      caip2,
      destinationChainId: chosenDestination,
      providerId: provider,
      amount,
      sender: account.address,
      senderKind: 'regular',
      recipient: account.address,
      nativeSymbol: symbol,
      readers: readersFor(sourceUrl),
    });
  };

  const rowQuoteKey = `${chosenDestination ?? ''}|${amountText.trim()}|${aaActive ? 'aa' : 'eoa'}|${caip2}`;
  const onGetQuotes = async () => {
    setFormError(null);
    const amount = parseAmount();
    if (amount === null) return;
    setQuoting(true);
    const byProvider: Record<string, ProviderRowQuote | string> = {};
    try {
      const start = await currentEndpoint();
      for (const row of rows.filter((r) => r.selectable)) {
        try {
          const { value } = await callWithFailover(start, (ep) => quotePlan(amount, row.id, ep.url));
          const model = bridgeConfirmModel(value);
          byProvider[row.id] = { fee: model.feeLines.map((f) => `${f.value}`).join(' + '), arrives: `${model.arrives}.` };
        } catch (e) {
          byProvider[row.id] = describeBridgeError(e, symbol);
        }
      }
      setRowQuotes({ key: rowQuoteKey, byProvider });
    } catch (e) {
      setFormError(describeBridgeError(e, symbol));
    } finally {
      setQuoting(false);
    }
  };

  const onReview = async () => {
    setFormError(null);
    if (!chosenProvider) {
      setFormError('No provider can be chosen for this pair of networks.');
      return;
    }
    const amount = parseAmount();
    if (amount === null) return;
    setPhase('preparing');
    if (aaActive) {
      try {
        const bundle = aa.bundle;
        if (!bundle || !aa.url) throw new Error('The smart-account session expired; go back and try again.');
        const p = await quotePlan(amount, chosenProvider, aa.url);
        preparedFrom.current = account.address;
        const q = await prepareBridgeAa(bundle, account.address, p);
        setPlan(p);
        setAaQuote(q);
        setQuotedUrl(aa.url);
        setPhase('aa-confirm');
      } catch (e) {
        const described = e instanceof BridgeRefusal || !aaType ? null : describeAaError(e, { accountType: aaType, deployed: null });
        backToForm(described ? `${described.title}\n${described.detail}` : describeBridgeError(e, symbol));
      }
      return;
    }
    try {
      const start = await currentEndpoint();
      const outcome = await callWithFailover(start, async (ep) => {
        const p = await quotePlan(amount, chosenProvider, ep.url);
        const q = await prepareBridgeSend(ep.url, account.address, p);
        return { p, q };
      });
      if (outcome.switched) setEndpoint(outcome.endpoint);
      preparedFrom.current = account.address;
      setQuotedUrl(outcome.endpoint.url);
      setPlan(outcome.value.p);
      setEoaQuote(outcome.value.q);
      setPhase('confirm');
    } catch (e) {
      backToForm(describeBridgeError(e, symbol));
    }
  };

  /** The regular account: one transaction, value = amount + messaging fee. */
  const onSend = async () => {
    if (!quotedUrl || !eoaQuote || !plan) return;
    const sendUrl = quotedUrl;
    const changed = await pinnedEndpointProblem(sendUrl);
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      backToForm('Please review again.');
      return;
    }
    if (!eoaQuote.simulation.ok) {
      Alert.alert('Not sent', `The pre-flight simulation failed: ${eoaQuote.simulation.reason}. Nothing was sent.`);
      return;
    }
    const withinLimits = await spendingGateForQuote({ chain: caip2, owner: account.address, from: preparedFrom.current ?? account.address, quote: eoaQuote, url: sendUrl });
    if (!withinLimits) return;
    const auth = await requireLocalAuth(bridgePromptTitle(plan));
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const sent = await signWith(EVM_CHAIN_ID, preparedFrom.current ?? '', (signer) => sendEvm(sendUrl, signer, eoaQuote, evmChain.explorerTxBase));
      const record = recordBridgeTransfer(plan, { sourceTxHash: sent.txid, userOpHash: null });
      setSentRecordId(record.id);
      setSentNetwork(caip2);
      setResult(sent);
      setPhase('success');
    } catch (e) {
      const { title, detail } = describeSendError(e, symbol, symbol);
      Alert.alert(title, detail);
      setPhase('confirm');
    }
  };

  /** The smart account: the same call as one operation. */
  const onAaSend = async () => {
    const bundle = aa.bundle;
    if (!aaQuote || !plan || !bundle) return;
    const bundleUrl = aa.url;
    const changed = bundleUrl ? await pinnedEndpointProblem(bundleUrl) : null;
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      backToForm('Please review again.');
      return;
    }
    try {
      await checkAaQuoteBeforeApproval(bundle.bundler, aaQuote);
    } catch (e) {
      const d = describeAaError(e, { accountType: aaQuote.accountType, deployed: aaQuote.deployed }) ?? describeSendError(e, symbol, symbol);
      Alert.alert(d.title, d.detail);
      backToForm('Please review again.');
      return;
    }
    const withinLimits = await spendingGateForQuote({ chain: caip2, owner: account.address, from: account.address, quote: aaQuote, url: bundleUrl ?? url });
    if (!withinLimits) return;
    const auth = await requireLocalAuth(bridgePromptTitle(plan));
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('aa-sending');
    try {
      const { userOpHash } = await signWith(EVM_CHAIN_ID, preparedFrom.current ?? '', (signer) => sendAa(bundle, signer, aaQuote, { kind: 'bridge' }));
      const record = recordBridgeTransfer(plan, { sourceTxHash: null, userOpHash });
      setSentRecordId(record.id);
      setSentNetwork(caip2);
      setAaResult({ userOpHash, receiptState: 'pending', success: null, txHash: null });
      setPhase('success');
      void waitForAaReceipt(bundle, userOpHash, { timeoutMs: 120_000, pollMs: 3_000 }).then(
        ({ summary }) => {
          setAaResult((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, receiptState: 'found', success: summary.success, txHash: summary.txHash } : prev));
          if (summary.success === false) {
            updateBridgeTransfer(record.id, {
              sourceTxHash: summary.txHash,
              checkedAt: Date.now(),
              status: { state: 'failed', detail: 'The smart-account operation was included but reverted, so nothing was bridged; its network fee was still charged.' },
            });
          } else if (summary.txHash) {
            updateBridgeTransfer(record.id, { sourceTxHash: summary.txHash });
          }
        },
        () => setAaResult((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, receiptState: 'timeout' } : prev)),
      );
    } catch (e) {
      const d = describeAaError(e, { accountType: aaQuote.accountType, deployed: aaQuote.deployed }) ?? describeSendError(e, symbol, symbol);
      Alert.alert(d.title, d.detail);
      backToForm('Please review again.');
    }
  };

  const sendingView = (text: string) => (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={theme.accent} />
      <Text style={[styles.hint, { color: theme.textMuted }]}>{text}</Text>
    </View>
  );

  const transferCards = (only: string | null) =>
    records
      .filter((r) => only === null || r.id === only)
      .map((r) => (
        <TransferStatusCard key={r.id} record={r} symbol={symbol} checking={checking[r.id] === true} theme={theme}>
          {!bridgeTransferFinal(r) && r.sourceTxHash !== null ? (
            <Button title="Check now" variant="secondary" onPress={() => void checkTransfer(r)} disabled={checking[r.id] === true} />
          ) : null}
          {bridgeRetryCall(r) ? (
            <RetryPanel
              record={r}
              activeCaip2={caip2}
              fromAddress={account.address}
              symbol={symbol}
              explorerTxBase={evmChain.explorerTxBase}
              signWith={signWith}
              currentEndpoint={currentEndpoint}
            />
          ) : null}
        </TransferStatusCard>
      ));

  // ------------------------------------------------------------ success
  if (phase === 'success' && plan && (result || aaResult)) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} {...NOTE_VIEW_SCROLL_PROPS}>
        <Text accessibilityRole="header" style={[styles.successTitle, { color: theme.success }]}>{aaResult ? 'Sent to the bundler ✓' : 'Sent ✓'}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{bridgePromptTitle(plan)}.</Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>{aaResult ? 'UserOperation hash' : 'Transaction id (on this network)'}</Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {aaResult ? aaResult.userOpHash : result!.txid}
          </Text>
        </View>
        {result?.explorerUrl ? <Button title="View on block explorer" variant="secondary" onPress={() => void Linking.openURL(result.explorerUrl!)} /> : null}
        {aaResult?.receiptState === 'pending' ? sendingView('Bundling… waiting for the UserOperation receipt.') : null}
        {aaResult?.receiptState === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            No receipt yet. The operation may still be included — keep the UserOperation hash above to look it up later. The
            transfer below can be followed once the bundle transaction is known.
          </Text>
        ) : null}
        {aaResult?.receiptState === 'found' ? (
          aaResult.success === false ? (
            <WarningBox>
              The bundler reports the operation was included but reverted on-chain. The gas was still charged to the smart
              account. Nothing was bridged.
            </WarningBox>
          ) : (
            <Text style={[styles.simulationOk, { color: theme.success }]}>Included on-chain{aaResult.success === true ? ' — succeeded.' : '.'}</Text>
          )
        ) : null}
        <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}>Where the transfer is</Text>
        {transferCards(sentRecordId)}
        <Text style={[styles.hint, { color: theme.textMuted }]}>{BRIDGE_RECORDS_NOTE}</Text>
        {recordsReadOnly ? <WarningBox>{BRIDGE_RECORDS_READ_ONLY_MESSAGE}</WarningBox> : null}
        {sentNetwork && aaResult ? <TransactionNoteField network={sentNetwork} txid={aaResult.txHash} userOpHash={aaResult.userOpHash} /> : null}
        {sentNetwork && !aaResult && result ? <TransactionNoteField network={sentNetwork} txid={result.txid} userOpHash={null} /> : null}
        <Button
          title="Done"
          onPress={() =>
            dismissKeyboardThenClose(() => {
              setResult(null);
              setAaResult(null);
              setSentNetwork(null);
              setSentRecordId(null);
              setPlan(null);
              setEoaQuote(null);
              setAaQuote(null);
              setAmountText('');
              setRowQuotes(null);
              setPhase('form');
            })
          }
        />
      </ScrollView>
    );
  }

  // ----------------------------------------------- confirm (both accounts)
  const confirmBody = (p: BridgePlan) => {
    const model = bridgeConfirmModel(p);
    return (
      <>
        <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}>
          {p.sourceLabel} → {p.destinationLabel} through {p.providerLabel}
        </Text>
        <Text style={[styles.notice, { color: theme.text }]}>{model.youSend}</Text>
        <Text style={[styles.notice, { color: theme.text }]}>{model.arrives}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{model.minimum}</Text>
        {model.recipientLines.map((line, i) => (i === 0 ? <Text key={line} style={[styles.hint, { color: theme.text }]}>{line}</Text> : <WarningBox key={line}>{line}</WarningBox>))}
        {model.feeLines.map((f) => (
          <View key={f.label}>
            <Row label={f.label} value={f.value} theme={theme} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>{f.note}</Text>
          </View>
        ))}
        <Row label="Leaving your account for the bridge (amount + fee)" value={model.total} theme={theme} />
        {model.timeLines.map((line) => (
          <Text key={line} style={[styles.hint, { color: theme.textMuted }]}>{line}</Text>
        ))}
        <TrustStatementCard trust={model.trust} theme={theme} title={`Who you trust with ${p.providerLabel}`} />
        <Text style={[styles.hint, { color: theme.text }]}>{model.destinationStep}</Text>
        <Text style={[styles.hint, { color: theme.text }]}>{model.approvalLine}</Text>
        <Text accessibilityRole="header" style={[styles.label, { color: theme.textMuted }]}>Written into the call and checked by this wallet</Text>
        {model.pinnedSummary.map((line) => (
          <Text key={line} style={[styles.hint, { color: theme.text }]}>• {line}</Text>
        ))}
        <Text style={[styles.hint, { color: theme.text }]}>{model.pinnedPool}</Text>
        {model.notes.map((n) => (
          <Text key={n} style={[styles.hint, { color: theme.textMuted }]}>{n}</Text>
        ))}
      </>
    );
  };

  if ((phase === 'confirm' || phase === 'sending') && plan && eoaQuote) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Row label="From account" value={activeAccount?.name ?? '—'} sub={account.address} spoken={`From account: ${activeAccount?.name ?? 'unknown'}, ${spokenShortAddress(account.address)}`} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        {confirmBody(plan)}
        <Row label={`Max network fee on ${plan.sourceLabel} (paid in ${symbol})`} value={`${exact18(eoaQuote.fee)} ${symbol}`} theme={theme} />
        {(() => {
          const sourceFees = bridgeSourceFeeLines(eoaQuote, symbol);
          return (
            <>
              <Text style={[styles.hint, { color: theme.textMuted }]}>{sourceFees.worstCase}</Text>
              {sourceFees.rows.map((r) => (
                <Row key={r.label} label={r.label} value={r.value} theme={theme} />
              ))}
              {sourceFees.note ? <Text style={[styles.hint, { color: theme.textMuted }]}>{sourceFees.note}</Text> : null}
            </>
          );
        })()}
        <Row label="Total (worst case)" value={`${exact18(eoaQuote.total)} ${symbol}`} theme={theme} />
        <BalanceChangePreview url={quotedUrl} request={{ from: account.address, to: eoaQuote.to, value: eoaQuote.amount, ...(eoaQuote.data ? { data: eoaQuote.data } : {}) }} />
        <RiskWarnings url={quotedUrl} wallet={account.address} to={eoaQuote.to} data={eoaQuote.data} />
        <SpendingPolicyNotice owner={account.address} quote={eoaQuote} from={account.address} />
        {eoaQuote.simulation.ok ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}>Pre-flight simulation passed (eth_call).</Text>
        ) : (
          <WarningBox>Pre-flight simulation failed: {eoaQuote.simulation.reason}. Nothing will be sent.</WarningBox>
        )}
        {phase === 'sending' ? (
          sendingView('Signing and broadcasting…')
        ) : (
          <>
            <Button title={bridgePromptTitle(plan)} onPress={() => void onSend()} disabled={!eoaQuote.simulation.ok} />
            <Button title="Back" variant="secondary" onPress={() => backToForm('')} />
          </>
        )}
      </ScrollView>
    );
  }

  if ((phase === 'aa-confirm' || phase === 'aa-sending') && plan && aaQuote) {
    const first = aaQuote.calls[0]!;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}>Smart account · {aaAccountTypeLabel(aaQuote.accountType)}</Text>
        <Row label="Owner account (signs)" value={activeAccount?.name ?? '—'} sub={account.address} spoken={`Owner account (signs): ${activeAccount?.name ?? 'unknown'}, ${spokenShortAddress(account.address)}`} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        <Row label={aaSenderLabel(aaQuote)} value={aaQuote.sender} mono theme={theme} />
        {confirmBody(plan)}
        <Row label={`Smart account ${symbol} balance`} value={`${exact18(aaQuote.senderBalance)} ${symbol}`} theme={theme} />
        <Row label="Deployment" value={aaQuote.deployed ? 'Already deployed' : 'Will deploy with this operation'} theme={theme} />
        {!aaQuote.deployed && aaQuote.accountType === 'kernel-v3.3' ? <Text style={[styles.hint, { color: theme.textMuted }]}>{KERNEL_BUNDLER_NOTE}</Text> : null}
        <Row
          label={aaQuote.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={aaQuote.sponsored ? 'Sponsored — you pay 0' : `${exact18(aaQuote.fee)} ${symbol}`}
          theme={theme}
        />
        <AaDepositNote fee={aaQuote.fee} deposit={aaQuote.deposit} sponsored={aaQuote.sponsored} symbol={symbol} />
        <BalanceChangePreview url={url} request={{ from: aaQuote.sender, to: first.to, value: first.value, data: first.data }} note={PREVIEW_AA_NOTE} />
        <RiskWarnings url={url} wallet={aaQuote.sender} to={plan.call.to} data={plan.call.data} />
        <SpendingPolicyNotice owner={account.address} quote={aaQuote} from={account.address} />
        <Text style={[styles.simulationOk, { color: theme.success }]}>Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).</Text>
        {phase === 'aa-sending' ? (
          sendingView('Signing and submitting to the bundler…')
        ) : (
          <>
            <Button title={bridgePromptTitle(plan)} onPress={() => void onAaSend()} />
            <Button title="Back" variant="secondary" onPress={() => backToForm('')} />
          </>
        )}
      </ScrollView>
    );
  }

  // --------------------------------------------------------------- form
  const currentRowQuotes = rowQuotes && rowQuotes.key === rowQuoteKey ? rowQuotes.byProvider : {};
  const amountField = fieldLabel('amount', `Amount (${symbol})`);
  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
      <Text style={[styles.hint, { color: theme.text }]}>{BRIDGE_INTRO}</Text>
      {offer.unavailable ? <WarningBox>{offer.unavailable}</WarningBox> : null}
      <ImportedKeyNotice show={activeAccount?.imported === true} />

      {aaOffered ? (
        <View style={styles.toggleRow}>
          <Switch {...switchColors(theme)} accessibilityLabel="Send from the smart account" value={aaEnabled} onValueChange={setAaEnabled} />
          <Text importantForAccessibility="no" accessibilityElementsHidden style={[styles.toggleLabel, { color: theme.text }]}>
            Send from the smart account
          </Text>
        </View>
      ) : null}
      {aa.error ? <WarningBox>{aa.error}</WarningBox> : null}

      {offer.destinations.length > 0 ? (
        <>
          <Text accessibilityRole="header" style={[styles.label, { color: theme.textMuted }]}>Send to network</Text>
          <View style={styles.choiceRow}>
            {offer.destinations.map((d) => (
              <Button
                key={d.chainId}
                title={chosenDestination === d.chainId ? `✓ ${d.label}` : d.label}
                variant={chosenDestination === d.chainId ? 'primary' : 'secondary'}
                selected={chosenDestination === d.chainId}
                style={styles.choiceButton}
                onPress={() => {
                  setDestination(d.chainId);
                  setProviderId(null);
                  setFormError(null);
                }}
              />
            ))}
          </View>
          {destinationLabel ? (
            aaActive && aaType === 'kernel-v3.3' ? (
              <WarningBox>{smartAccountRecipientNote(account.address, destinationLabel)}</WarningBox>
            ) : aaActive ? (
              <Text style={[styles.hint, { color: theme.text }]}>{upgradedAccountRecipientNote(account.address, destinationLabel)}</Text>
            ) : (
              <Text style={[styles.hint, { color: theme.text }]}>{regularRecipientNote(account.address, destinationLabel)}</Text>
            )
          ) : null}
        </>
      ) : null}

      <Text {...amountField.label} style={[styles.label, { color: theme.textMuted }]}>{amountField.text}</Text>
      <TextInput
        {...amountField.input}
        style={[styles.input, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.card }]}
        value={amountText}
        onChangeText={(t) => {
          setAmountText(t);
          setFormError(null);
        }}
        keyboardType="decimal-pad"
        placeholder="0.0002"
        placeholderTextColor={theme.textMuted}
      />
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Stargate moves {symbol} in steps of 0.000001; an amount with more decimal places is refused, not rounded.
      </Text>

      <Text accessibilityRole="header" style={[styles.label, { color: theme.textMuted }]}>Choose a provider</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{BRIDGE_CHOICE_NOTE}</Text>
      <View accessibilityRole="radiogroup" style={styles.content}>
        {rows.map((row) => {
          const q = currentRowQuotes[row.id];
          return (
            <View key={row.id}>
              <ProviderRadioRow
                row={row}
                selected={chosenProvider === row.id}
                quote={typeof q === 'object' ? q : null}
                onSelect={() => setProviderId(row.id)}
                theme={theme}
              />
              {typeof q === 'string' ? <BridgeWarning text={q} /> : null}
            </View>
          );
        })}
      </View>

      {formError ? <BridgeWarning text={formError} announce /> : null}
      {phase === 'preparing' ? (
        sendingView('Reading the provider’s contracts and preparing the quote…')
      ) : (
        <>
          <Button title={quoting ? 'Getting quotes…' : 'Get quotes'} variant="secondary" onPress={() => void onGetQuotes()} disabled={quoting || chosenProvider === null} />
          <Button title="Review" onPress={() => void onReview()} disabled={quoting || chosenProvider === null} />
        </>
      )}

      {records.length > 0 || recordsReadOnly ? (
        <>
          <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}>Transfers sent from this screen</Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>{BRIDGE_RECORDS_NOTE}</Text>
          {recordsReadOnly ? (
            <>
              <WarningBox>{BRIDGE_RECORDS_READ_ONLY_MESSAGE}</WarningBox>
              <Button title="Reset the transfer list" variant="secondary" onPress={onResetTransfers} />
            </>
          ) : null}
          {transferCards(null)}
        </>
      ) : null}
    </ScrollView>
  );
}

/**
 * The delivery transaction for a transfer whose ETH waits in Stargate's
 * pool (UnreceivedTokenCached): retryReceiveToken on the RECEIVING network,
 * value 0, sent from the regular account while that network is the active
 * one; quoted through prepareEvmSend (with its pre-flight) and confirmed
 * with the device check like every other send.
 */
function RetryPanel({
  record,
  activeCaip2,
  fromAddress,
  symbol,
  explorerTxBase,
  signWith,
  currentEndpoint,
}: {
  record: BridgeTransferRecord;
  activeCaip2: string;
  fromAddress: string;
  symbol: string;
  explorerTxBase: string;
  signWith: ReturnType<typeof useWallet>['signWith'];
  currentEndpoint: () => Promise<UsableEndpoint>;
}) {
  const theme = useTheme();
  const [quote, setQuote] = useState<{ q: EvmSendQuote; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocker = bridgeRetryBlocker(activeCaip2, record);
  if (record.retryTxHash) return null;
  if (blocker) return <Text style={[styles.hint, { color: theme.textMuted }]}>{blocker}</Text>;
  const prepare = async () => {
    setError(null);
    setBusy(true);
    try {
      const ep = await currentEndpoint();
      const q = await prepareBridgeRetry(ep.url, fromAddress, record);
      setQuote({ q, url: ep.url });
    } catch (e) {
      setError(describeBridgeError(e, symbol));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!quote) return;
    if (!quote.q.simulation.ok) {
      setError(`The pre-flight simulation failed: ${quote.q.simulation.reason}. Nothing was sent.`);
      return;
    }
    const auth = await requireLocalAuth(bridgeRetryPromptTitle(record));
    if (!auth.ok) {
      setError(auth.message);
      return;
    }
    setBusy(true);
    try {
      const sent = await signWith(EVM_CHAIN_ID, fromAddress, (signer) => sendEvm(quote.url, signer, quote.q, explorerTxBase || null));
      updateBridgeTransfer(record.id, { retryTxHash: sent.txid });
    } catch (e) {
      const { title, detail } = describeSendError(e, symbol, symbol);
      setError(`${title} ${detail}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.content}>
      {quote ? (
        <>
          <Row label={`Max network fee for the delivery (paid in ${symbol})`} value={`${exact18(quote.q.fee)} ${symbol}`} theme={theme} />
          {quote.q.simulation.ok ? (
            <Text style={[styles.simulationOk, { color: theme.success }]}>Pre-flight simulation passed (eth_call).</Text>
          ) : (
            <WarningBox>Pre-flight simulation failed: {quote.q.simulation.reason}. Nothing will be sent.</WarningBox>
          )}
          <Button title="Send the delivery transaction" onPress={() => void send()} disabled={busy || !quote.q.simulation.ok} />
        </>
      ) : (
        <Button title="Prepare the delivery transaction" variant="secondary" onPress={() => void prepare()} disabled={busy} />
      )}
      {error ? <WarningBox>{error}</WarningBox> : null}
    </View>
  );
}

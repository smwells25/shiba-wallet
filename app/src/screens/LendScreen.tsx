import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { httpTransport as evmHttpTransport, readLendingPosition, type JsonRpcTransport, type LendingPosition, type ReserveState } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { spokenShortAddress } from '../a11y';
import { Button, ImportedKeyNotice, TestNetworksOnlyCard, WarningBox, screenStyle, switchColors, useFieldLabels } from '../components';
import { callWithFailover, getEndpoint, reportEndpointFailure, withEndpoint, type NetworkEndpoint, type UsableEndpoint } from '../config/networks';
import { readinessGate } from '../config/readiness';
import { sanitizeEndpointMessage } from '../config/endpoint-probe';
import { useTheme } from '../theme';
import { T } from '../i18n/T';
import { useI18n } from '../i18n/useI18n';
import { translateIn } from '../i18n/index';
import { BalanceChangePreview } from '../components/BalanceChangePreview';
import { RiskWarnings } from '../components/RiskWarnings';
import { SpendingPolicyNotice, spendingGateForQuote } from '../components/SpendingPolicyViews';
import { AaDepositNote } from '../components/AaDepositNote';
import { NOTE_VIEW_SCROLL_PROPS, TransactionNoteField, dismissKeyboardThenClose } from '../components/TransactionNoteField';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits, parseUnits } from '../wallet/balances';
import { EVM_CHAIN_ID, QUOTE_ENDPOINT_CHANGED_TITLE, quoteEndpointChange, sendEvm, type EvmSendQuote, type SendResult } from '../wallet/send';
import { waitForAllowance } from '../wallet/swap';
import {
  PREVIEW_AA_BATCH_NOTE,
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
  LendingRefusal,
  describeLendingError,
  formatLending,
  lendingAccountRefusal,
  lendingActionLabel,
  lendingActionTitle,
  lendingCallLines,
  lendingOfferFor,
  lendingOutcomeLines,
  lendingSimulationText,
  lendingSmartAccountRefusal,
  planLending,
  prepareLendingAa,
  prepareLendingSend,
  readLendingView,
  receiptLogsOf,
  waitForTransactionReceipt,
  type LendingAction,
  type LendingPlan,
} from '../wallet/lending';
import { LendIntro, LendPositionCard, LendReserveCard } from './LendViews';
import { NetworkBadge, Row, stakingStyles as styles } from './StakingViews';

/**
 * The route is registered in navigation.ts (`Lend: undefined`) and App.tsx;
 * the intersection keeps this screen type-correct either way.
 */
type Props = NativeStackScreenProps<RootStackParamList & { Lend: undefined }, 'Lend'>;

type Phase = 'form' | 'preparing' | 'approve' | 'approving' | 'confirm' | 'sending' | 'aa-confirm' | 'aa-sending' | 'success';
type Choice = 'supply' | 'withdraw';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The smart-account bundle for the Lend screen, built from the node URL it is
 * pinned to (its quotes come from it, so the send is pinned to it like the
 * regular-account path). Null inputs = no smart account. A module-level hook
 * with plain inputs, as the Bridge screen's (the React Compiler cannot keep a
 * component-level memo whose inputs are derived from objects).
 */
function useLendSmartAccount(
  config: AaChainConfig | null,
  url: string | null,
  accountIndex: number | null,
  ownerAddress: string | null,
  chainIdDecimal: string,
): { bundle: AaClientBundle | null; url: string | null; error: string | null } {
  return useMemo(() => {
    if (!config || !url || accountIndex === null || !ownerAddress) return { bundle: null, url: null, error: null };
    try {
      const bundle = createAaClientFromConfig(config, { nodeUrl: url, chainId: BigInt(chainIdDecimal), accountIndex, ownerAddress });
      return { bundle, url, error: null };
    } catch (e) {
      return { bundle: null, url: null, error: errorText(e) };
    }
  }, [config, url, accountIndex, ownerAddress, chainIdDecimal]);
}

/**
 * Lend (feature 61, phase 26 item 2; docs/LENDING_VAULTS.md sections 7 and
 * 10): supply Circle's test USDC to Aave v3's Arbitrum Sepolia test market
 * and withdraw it, modelled on the Staking screen. TEST NETWORKS ONLY
 * (readiness row 'lending', enforced here before any request and again in
 * wallet/lending.ts), and only where the engine pins a market (Arbitrum
 * Sepolia). No borrowing.
 *
 * Every action goes through the EXISTING confirm idioms: the regular account
 * through prepareEvmSend / sendEvm (the exact USDC approval first when the
 * allowance is short, then the supply, quoted again after the approval has
 * taken effect — the Staking wrap's two steps), the smart account through
 * prepareAaCalls / sendAa as one all-or-nothing operation; a withdrawal is
 * one call either way. The plan's calls come from the engine's quote and
 * pass the engine's checkLendingCalls before anything is shown (and again
 * before each quote). Each confirm shows the network badge, the calls in
 * words, the reserve as read, the fee, the balance-change preview, the risk
 * card (Aave v3's pinned Pool named), the spending limits, the eth_call (or
 * bundler) gate, then the device check.
 */
export function LendScreen({ navigation }: Props) {
  const theme = useTheme();
  const { t, tx, localize } = useI18n();
  const fieldLabel = useFieldLabels();
  const { accounts, signWith, activeAccount } = useWallet();
  const { evmChain, hideAmounts } = usePrefs();
  const account = accounts.find((a) => a.chainId === EVM_CHAIN_ID);
  const caip2 = evmChain.caip2;
  const symbol = evmChain.displaySymbol;
  const gate = readinessGate('lending', caip2);
  const offer = lendingOfferFor(caip2);
  const accountRefusal = lendingAccountRefusal(activeAccount ? { watchOnly: activeAccount.watchOnly, multisig: activeAccount.multisig } : null);

  const [endpoint, setEndpoint] = useState<NetworkEndpoint | null | undefined>(undefined);
  const [reloadTick, setReloadTick] = useState(0);
  const [phase, setPhase] = useState<Phase>('form');
  const [choice, setChoice] = useState<Choice>('supply');
  const [amountText, setAmountText] = useState('');
  const [withdrawAll, setWithdrawAll] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [plan, setPlan] = useState<LendingPlan | null>(null);
  const [eoaQuote, setEoaQuote] = useState<EvmSendQuote | null>(null);
  const [quotedUrl, setQuotedUrl] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const [sentNetwork, setSentNetwork] = useState<string | null>(null);
  const [approveTxid, setApproveTxid] = useState<string | null>(null);
  // What the receipt says happened (lendingOutcomeLines), once it is read.
  const [outcome, setOutcome] = useState<{ state: 'waiting' | 'done' | 'timeout'; lines: string[] }>({ state: 'waiting', lines: [] });
  const preparedFrom = useRef<string | null>(null);

  const [aaConfig, setAaConfig] = useState<AaChainConfig | null>(null);
  const [aaEnabled, setAaEnabled] = useState(false);
  const [aaQuote, setAaQuote] = useState<AaSendQuote | null>(null);
  const [aaResult, setAaResult] = useState<{
    userOpHash: string;
    receiptState: 'pending' | 'found' | 'timeout';
    success: boolean | null;
    txHash: string | null;
  } | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: t('lend.screenTitle') });
  }, [navigation, t]);

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

  const url = endpoint && endpoint.network.chainId === caip2 ? endpoint.url : null;
  const ownerAddress = account?.address ?? null;
  // The smart account: only a Kernel v3.3 account set up for this network
  // (wallet/lending.ts lendingSmartAccountRefusal).
  const aaType = aaConfig ? effectiveAaAccountType(aaConfig, ownerAddress) : null;
  const aaConfigured = aaConfig !== null && isAaConfigured(aaConfig, ownerAddress);
  const smartRefusal = lendingSmartAccountRefusal(caip2, aaType, aaConfigured);
  const aaOffered = offer.ok && accountRefusal === null && smartRefusal === null && url !== null;
  const aaActive = aaOffered && aaEnabled;

  const aa = useLendSmartAccount(aaActive ? aaConfig : null, aaActive ? url : null, activeAccount?.index ?? null, ownerAddress, evmChain.chainIdDecimal);

  // The reserve and the position, through the shared failover rule. The
  // holder is the smart account on the smart-account path; the shown data
  // carries the key it was read for, so a stale reading is never shown as
  // current.
  const loadKey = `${caip2}|${ownerAddress ?? ''}|${aa.bundle ? 'aa' : 'eoa'}|${url ?? ''}|${reloadTick}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    state: ReserveState | null;
    position: LendingPosition | null;
    holder: { address: string; smartAccount: boolean } | null;
    error: string | null;
  } | null>(null);
  const canRead = !gate && offer.ok && accountRefusal === null && ownerAddress !== null;
  useEffect(() => {
    if (!canRead || !ownerAddress) return;
    let cancelled = false;
    const bundle = aa.bundle;
    void (async () => {
      try {
        const holder = bundle ? await resolveAaSender(bundle, ownerAddress) : ownerAddress;
        const { value } = await withEndpoint(EVM_CHAIN_ID, async (ep) => readLendingView(evmHttpTransport(ep.url), caip2, holder));
        if (!cancelled) setLoaded({ key: loadKey, state: value.state, position: value.position, holder: { address: holder, smartAccount: bundle !== null }, error: null });
      } catch (e) {
        if (cancelled) return;
        const text = e instanceof LendingRefusal ? e.message : sanitizeEndpointMessage(errorText(e));
        setLoaded({ key: loadKey, state: null, position: null, holder: null, error: text === '' ? t('lend.reserve.noDetails') : text });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canRead, ownerAddress, aa.bundle, caip2, loadKey, t]);
  const current = loaded && loaded.key === loadKey ? loaded : null;
  const loading = canRead && current === null;

  // ------------------------------------------------------------ guards
  if (gate) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <TestNetworksOnlyCard feature={gate.feature} hint={gate.hint} />
      </ScrollView>
    );
  }
  if (!offer.ok || accountRefusal || !account) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.hint, { color: theme.text }]}>{!offer.ok ? offer.text : accountRefusal ?? t('lend.refusal.noAccount')}</Text>
      </ScrollView>
    );
  }
  const deployment = offer.deployment;
  const asset = deployment.asset;
  if (endpoint === undefined) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  // ------------------------------------------------------------ helpers
  const currentEndpoint = async (): Promise<UsableEndpoint> => {
    const fresh = await getEndpoint(EVM_CHAIN_ID);
    if (!fresh || fresh.url === null) {
      setEndpoint(fresh ?? null);
      throw new Error(t('lend.refusal.noEndpoint'));
    }
    if (fresh.network.chainId !== caip2) throw new Error(t('lend.refusal.networkChanged'));
    if (fresh.url !== url) setEndpoint(fresh);
    return { ...fresh, url: fresh.url };
  };

  const pinnedEndpointProblem = async (pinned: string): Promise<string | null> => {
    let now: string | null = null;
    try {
      now = (await getEndpoint(EVM_CHAIN_ID))?.url ?? null;
    } catch {
      now = null;
    }
    return quoteEndpointChange(pinned, now);
  };

  const allowancePollUrl = async (): Promise<string> => {
    const ep = await getEndpoint(EVM_CHAIN_ID);
    if (!ep || ep.url === null || ep.network.chainId !== caip2) throw new Error(t('lend.refusal.noEndpoint'));
    return ep.url;
  };

  const showError = (e: unknown) => {
    const { title, detail } = describeLendingError(e, symbol);
    Alert.alert(title, detail);
  };

  const backToForm = (message: string) => {
    setFormError(message);
    setPlan(null);
    setEoaQuote(null);
    setAaQuote(null);
    setPhase('form');
  };

  const errorLine = (e: unknown) => {
    const { title, detail } = describeLendingError(e, symbol);
    const clean = sanitizeEndpointMessage(detail) || detail;
    return title === t('lend.error.notQuoted') ? detail : `${title}\n${clean}`;
  };

  /** Plans and quotes the next regular-account step (the exact approve, or the main call). */
  const quoteEoa = async (action: LendingAction): Promise<'approve' | 'main'> => {
    const start = await currentEndpoint();
    const outcome = await callWithFailover(start, async (ep) => {
      const p = await planLending(evmHttpTransport(ep.url), caip2, account.address, action);
      const q = await prepareLendingSend(ep.url, account.address, p);
      return { p, q };
    });
    if (outcome.switched) setEndpoint(outcome.endpoint);
    preparedFrom.current = account.address;
    setQuotedUrl(outcome.endpoint.url);
    setPlan(outcome.value.p);
    setEoaQuote(outcome.value.q.quote);
    return outcome.value.q.step;
  };

  const onMax = () => {
    const position = current?.position;
    if (!position) return;
    setFormError(null);
    setAmountText(formatLending(position.walletBalance, deployment));
  };

  const onReview = async () => {
    setFormError(null);
    setNotice(null);
    let action: LendingAction;
    if (choice === 'withdraw' && withdrawAll) {
      action = { kind: 'withdraw', amount: 'all' };
    } else {
      let amount = 0n;
      try {
        amount = parseUnits(amountText, asset.decimals);
      } catch (e) {
        setFormError(errorText(e));
        return;
      }
      action = choice === 'supply' ? { kind: 'supply', amount } : { kind: 'withdraw', amount };
    }
    setPhase('preparing');
    if (aaActive) {
      try {
        const bundle = aa.bundle;
        if (!bundle) throw new LendingRefusal(t('lend.smart.expired'));
        const sender = await resolveAaSender(bundle, account.address);
        const p = await planLending(bundle.node, caip2, sender, action);
        preparedFrom.current = account.address;
        const q = await prepareLendingAa(bundle, account.address, p, aaType, aaConfigured);
        setPlan(p);
        setAaQuote(q);
        setPhase('aa-confirm');
      } catch (e) {
        const described = e instanceof LendingRefusal || !aaType ? null : describeAaError(e, { accountType: aaType, deployed: null });
        backToForm(described ? `${described.title}\n${described.detail}` : errorLine(e));
      }
      return;
    }
    try {
      const step = await quoteEoa(action);
      setPhase(step === 'approve' ? 'approve' : 'confirm');
    } catch (e) {
      backToForm(errorLine(e));
    }
  };

  /** Reads what the receipt recorded and the position after it (the success view's lines). */
  const readOutcome = async (p: LendingPlan, readLogs: () => Promise<unknown>, positionNode: () => JsonRpcTransport) => {
    setOutcome({ state: 'waiting', lines: [] });
    const receipt = await readLogs();
    if (receipt === null) {
      setOutcome({ state: 'timeout', lines: [] });
      return;
    }
    let after: bigint | null = null;
    try {
      after = (await readLendingPosition(positionNode(), p.deployment, p.holder)).supplied;
    } catch {
      after = null;
    }
    setOutcome({ state: 'done', lines: lendingOutcomeLines(receiptLogsOf(receipt), p, after) });
  };

  /** Step 1 of 2 on the regular account: the exact approval. */
  const onApprove = async () => {
    if (!quotedUrl || !eoaQuote || !plan?.approval) return;
    const approval = plan.approval;
    const approveUrl = quotedUrl;
    const changed = await pinnedEndpointProblem(approveUrl);
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      backToForm(t('lend.reviewAgain'));
      return;
    }
    if (!eoaQuote.simulation.ok) {
      Alert.alert(tx('Not sent'), t('staking.preflightFailed', { reason: lendingSimulationText(eoaQuote.simulation.reason) }));
      return;
    }
    const auth = await requireLocalAuth(
      translateIn('en', 'lend.prompt.approve', { amount: formatLending(approval.amount, deployment), symbol: approval.symbol }),
    );
    if (!auth.ok) {
      Alert.alert(tx('Not approved'), auth.message);
      return;
    }
    setPhase('approving');
    try {
      const sent = await signWith(EVM_CHAIN_ID, preparedFrom.current ?? '', (signer) => sendEvm(approveUrl, signer, eoaQuote, evmChain.explorerTxBase));
      setApproveTxid(sent.txid);
      const confirmed = await waitForAllowance(allowancePollUrl, approval.token, account.address, approval.spender, approval.amount, {
        onPollError: (_error, pollUrl) => {
          if (pollUrl) reportEndpointFailure(caip2, pollUrl);
        },
      });
      if (!confirmed) {
        backToForm(t('lend.approve.notTaken', { hash: sent.txid }));
        return;
      }
      const step = await quoteEoa(plan.action);
      if (step !== 'main') throw new LendingRefusal(t('lend.approve.notInPlace'));
      setNotice(t('lend.approve.notice'));
      setPhase('confirm');
    } catch (e) {
      showError(e);
      setPhase('approve');
    }
  };

  /** The main call (supply or withdraw) on the regular account. */
  const onSend = async () => {
    if (!quotedUrl || !eoaQuote || !plan) return;
    const sendUrl = quotedUrl;
    const changed = await pinnedEndpointProblem(sendUrl);
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      backToForm(t('lend.reviewAgain'));
      return;
    }
    if (!eoaQuote.simulation.ok) {
      Alert.alert(tx('Not sent'), t('staking.preflightFailed', { reason: lendingSimulationText(eoaQuote.simulation.reason) }));
      return;
    }
    const withinLimits = await spendingGateForQuote({
      chain: caip2,
      owner: account.address,
      from: preparedFrom.current ?? account.address,
      quote: eoaQuote,
      url: sendUrl,
      ...(plan.tokenOutflow ? { quoteOutflows: [plan.tokenOutflow] } : {}),
    });
    if (!withinLimits) return;
    const auth = await requireLocalAuth(lendingActionTitle(plan));
    if (!auth.ok) {
      Alert.alert(tx('Not sent'), auth.message);
      return;
    }
    setPhase('sending');
    try {
      const sent = await signWith(EVM_CHAIN_ID, preparedFrom.current ?? '', (signer) => sendEvm(sendUrl, signer, eoaQuote, evmChain.explorerTxBase));
      setSentNetwork(caip2);
      setResult(sent);
      setPhase('success');
      const node = evmHttpTransport(sendUrl);
      void readOutcome(plan, () => waitForTransactionReceipt(node, sent.txid), () => node);
    } catch (e) {
      showError(e);
      setPhase('confirm');
    }
  };

  /** The whole plan as one smart-account operation. */
  const onAaSend = async () => {
    const bundle = aa.bundle;
    if (!aaQuote || !plan || !bundle) return;
    const bundleUrl = aa.url;
    const changed = bundleUrl ? await pinnedEndpointProblem(bundleUrl) : null;
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      backToForm(t('lend.reviewAgain'));
      return;
    }
    try {
      await checkAaQuoteBeforeApproval(bundle.bundler, aaQuote);
    } catch (e) {
      const d = describeAaError(e, { accountType: aaQuote.accountType, deployed: aaQuote.deployed }) ?? describeLendingError(e, symbol);
      Alert.alert(d.title, d.detail);
      backToForm(t('lend.reviewAgain'));
      return;
    }
    const withinLimits = await spendingGateForQuote({
      chain: caip2,
      owner: account.address,
      from: account.address,
      quote: aaQuote,
      url: bundleUrl ?? url,
      ...(plan.tokenOutflow ? { quoteOutflows: [plan.tokenOutflow] } : {}),
    });
    if (!withinLimits) return;
    const auth = await requireLocalAuth(`${lendingActionTitle(plan)} from your smart account`);
    if (!auth.ok) {
      Alert.alert(tx('Not sent'), auth.message);
      return;
    }
    setPhase('aa-sending');
    try {
      const { userOpHash } = await signWith(EVM_CHAIN_ID, preparedFrom.current ?? '', (signer) => sendAa(bundle, signer, aaQuote, { kind: 'lending' }));
      setSentNetwork(caip2);
      setAaResult({ userOpHash, receiptState: 'pending', success: null, txHash: null });
      setPhase('success');
      void readOutcome(
        plan,
        async () => {
          try {
            const { raw, summary } = await waitForAaReceipt(bundle, userOpHash, { timeoutMs: 120_000, pollMs: 3_000 });
            setAaResult((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, receiptState: 'found', success: summary.success, txHash: summary.txHash } : prev));
            return raw;
          } catch {
            setAaResult((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, receiptState: 'timeout' } : prev));
            return null;
          }
        },
        () => bundle.node,
      );
    } catch (e) {
      const d = describeAaError(e, { accountType: aaQuote.accountType, deployed: aaQuote.deployed }) ?? describeLendingError(e, symbol);
      Alert.alert(d.title, d.detail);
      // A smart-account quote is used once (aa.ts claimQuoteForSubmission).
      backToForm(t('lend.reviewAgain'));
    }
  };

  const inputStyle = [styles.input, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.card }];
  const sendingView = (text: string) => (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={theme.accent} />
      <Text style={[styles.hint, { color: theme.textMuted }]}>{text}</Text>
    </View>
  );
  const fmt = (u: bigint) => formatLending(u, deployment);
  const callLines = plan
    ? lendingCallLines(plan).map((line) => (
        <Text key={line} style={[styles.hint, { color: theme.text }]}>
          {line}
        </Text>
      ))
    : null;
  const amountRow = plan ? (
    <Row
      label={plan.action.kind === 'supply' ? t('lend.confirm.supplying') : t('lend.confirm.withdrawing')}
      value={plan.quote.all ? t('lend.confirm.all', { amount: fmt(plan.quote.amount), symbol: asset.symbol }) : `${fmt(plan.quote.amount)} ${asset.symbol}`}
      theme={theme}
    />
  ) : null;
  const reserveCard = plan ? <LendReserveCard deployment={deployment} state={plan.state} theme={theme} /> : null;

  // ------------------------------------------------------------ success
  if (phase === 'success' && (result || aaResult) && plan) {
    return (
      <ScrollView key="lend-success" style={screenStyle(theme)} contentContainerStyle={styles.content} {...NOTE_VIEW_SCROLL_PROPS}>
        <Text accessibilityRole="header" style={[styles.successTitle, { color: theme.success }]}>{aaResult ? tx('Sent to the bundler ✓') : tx('Sent ✓')}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{lendingActionLabel(plan)}.</Text>
        {approveTxid ? <Text style={[styles.hint, { color: theme.textMuted }]}>{t('staking.success.approvalTx', { hash: approveTxid })}</Text> : null}
        <Text style={[styles.label, { color: theme.textMuted }]}>{aaResult ? tx('UserOperation hash') : tx('Transaction id')}</Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {aaResult ? aaResult.userOpHash : result!.txid}
          </Text>
        </View>
        {result?.explorerUrl && evmChain.explorerTxBase ? (
          <Button title="View on block explorer" variant="secondary" onPress={() => void Linking.openURL(result.explorerUrl!)} />
        ) : null}
        {aaResult?.receiptState === 'pending' ? sendingView(tx('Bundling… waiting for the UserOperation receipt.')) : null}
        {aaResult?.receiptState === 'found' && aaResult.success === false ? (
          <WarningBox>{t('staking.success.reverted')}</WarningBox>
        ) : null}
        {aaResult?.receiptState === 'found' && aaResult.txHash ? (
          <>
            <Text style={[styles.label, { color: theme.textMuted }]}><T>Transaction</T></Text>
            <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text selectable style={[styles.monoText, { color: theme.text }]}>
                {aaResult.txHash}
              </Text>
            </View>
            {evmChain.explorerTxBase ? (
              <Button title="View on block explorer" variant="secondary" onPress={() => void Linking.openURL(`${evmChain.explorerTxBase}${aaResult.txHash}`)} />
            ) : null}
          </>
        ) : null}
        {outcome.state === 'waiting' && !aaResult ? sendingView(t('lend.success.waiting')) : null}
        {outcome.state === 'timeout' ? <Text style={[styles.hint, { color: theme.textMuted }]}>{t('lend.outcome.timeout')}</Text> : null}
        {outcome.lines.map((line) => (
          <Text key={line} accessibilityLiveRegion="polite" style={[styles.simulationOk, { color: theme.text }]}>
            {line}
          </Text>
        ))}
        {sentNetwork && aaResult ? <TransactionNoteField network={sentNetwork} txid={aaResult.txHash} userOpHash={aaResult.userOpHash} /> : null}
        {sentNetwork && !aaResult && result ? <TransactionNoteField network={sentNetwork} txid={result.txid} userOpHash={null} /> : null}
        <Button
          title="Done"
          onPress={() =>
            dismissKeyboardThenClose(() => {
              setResult(null);
              setAaResult(null);
              setSentNetwork(null);
              setApproveTxid(null);
              setPlan(null);
              setAmountText('');
              setWithdrawAll(false);
              setOutcome({ state: 'waiting', lines: [] });
              setPhase('form');
              setReloadTick((n) => n + 1);
            })
          }
        />
      </ScrollView>
    );
  }

  // ------------------------------------------------- approve (EOA, step 1)
  if ((phase === 'approve' || phase === 'approving') && plan?.approval && eoaQuote) {
    return (
      <ScrollView key="lend-approve" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}><T>Step 1 of 2 — Approve</T></Text>
        <Row label="From account" value={activeAccount?.name ?? '—'} sub={account.address} spoken={`From account: ${activeAccount?.name ?? 'unknown'}, ${spokenShortAddress(account.address)}`} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        <Text style={[styles.hint, { color: theme.text }]}>
          {t('lend.approve.intro', { amount: fmt(plan.approval.amount), symbol: plan.approval.symbol })}
        </Text>
        <Row label="Token" value={plan.approval.token} mono theme={theme} />
        <Row label="Spender" value={plan.approval.spender} mono theme={theme} />
        <Row label={t('send.row.maxFeePaidIn', { symbol })} value={`${formatUnits(eoaQuote.fee, 18, 18)} ${symbol}`} theme={theme} />
        <RiskWarnings url={quotedUrl} wallet={account.address} to={eoaQuote.to} data={eoaQuote.data} />
        {eoaQuote.simulation.ok ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}><T>Pre-flight simulation passed (eth_call).</T></Text>
        ) : (
          <WarningBox>{t('staking.simulation.failed', { reason: lendingSimulationText(eoaQuote.simulation.reason) })}</WarningBox>
        )}
        {phase === 'approving' ? (
          sendingView(tx('Approving, then waiting for the approval to take effect…'))
        ) : (
          <>
            <Button title={t('lend.approve.button', { amount: fmt(plan.approval.amount), symbol: plan.approval.symbol })} onPress={() => void onApprove()} disabled={!eoaQuote.simulation.ok} />
            <Button title="Back" variant="secondary" onPress={() => backToForm('')} />
          </>
        )}
      </ScrollView>
    );
  }

  // ------------------------------------------------------- confirm (EOA)
  if ((phase === 'confirm' || phase === 'sending') && plan && eoaQuote) {
    return (
      <ScrollView key="lend-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        {plan.approval ? <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}><T>Step 2 of 2</T></Text> : null}
        {notice ? <Text style={[styles.notice, { color: theme.accent }]}>{notice}</Text> : null}
        <Row label="From account" value={activeAccount?.name ?? '—'} sub={account.address} spoken={`From account: ${activeAccount?.name ?? 'unknown'}, ${spokenShortAddress(account.address)}`} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        {amountRow}
        <Text accessibilityRole="header" style={[styles.label, { color: theme.textMuted }]}>{t('lend.calls.title')}</Text>
        {lendingCallLines({ ...plan, calls: [plan.main] }).map((line) => (
          <Text key={line} style={[styles.hint, { color: theme.text }]}>
            {line}
          </Text>
        ))}
        <Row label={t('lend.reserve.pool')} value={eoaQuote.to} mono theme={theme} />
        <Row label={t('send.row.maxFeePaidIn', { symbol })} value={`${formatUnits(eoaQuote.fee, 18, 18)} ${symbol}`} theme={theme} />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {t('staking.worstCase', { gwei: formatUnits(eoaQuote.maxFeePerGas, 9, 9), gas: eoaQuote.gasLimit.toString() })}
        </Text>
        {reserveCard}
        <BalanceChangePreview
          url={quotedUrl}
          request={{ from: account.address, to: eoaQuote.to, value: eoaQuote.amount, ...(eoaQuote.data ? { data: eoaQuote.data } : {}) }}
        />
        <RiskWarnings url={quotedUrl} wallet={account.address} to={eoaQuote.to} data={eoaQuote.data} />
        <SpendingPolicyNotice owner={account.address} quote={eoaQuote} from={account.address} {...(plan.tokenOutflow ? { quoteOutflows: [plan.tokenOutflow] } : {})} />
        {eoaQuote.simulation.ok ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}><T>Pre-flight simulation passed (eth_call).</T></Text>
        ) : (
          <WarningBox>{t('staking.simulation.failed', { reason: lendingSimulationText(eoaQuote.simulation.reason) })}</WarningBox>
        )}
        {phase === 'sending' ? (
          sendingView(tx('Signing and broadcasting…'))
        ) : (
          <>
            <Button title={lendingActionLabel(plan)} onPress={() => void onSend()} disabled={!eoaQuote.simulation.ok} />
            <Button title="Back" variant="secondary" onPress={() => backToForm('')} />
          </>
        )}
      </ScrollView>
    );
  }

  // ----------------------------------------------- confirm (smart account)
  if ((phase === 'aa-confirm' || phase === 'aa-sending') && plan && aaQuote) {
    const batch = aaQuote.calls.length > 1;
    return (
      <ScrollView key="lend-aa-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}>{t('staking.aa.title', { type: localize(aaAccountTypeLabel(aaQuote.accountType)) })}</Text>
        <Row label="Owner account (signs)" value={activeAccount?.name ?? '—'} sub={account.address} spoken={`Owner account (signs): ${activeAccount?.name ?? 'unknown'}, ${spokenShortAddress(account.address)}`} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        <Row label={aaSenderLabel(aaQuote)} value={aaQuote.sender} mono theme={theme} />
        {amountRow}
        <Text accessibilityRole="header" style={[styles.label, { color: theme.textMuted }]}>{t('lend.calls.title')}</Text>
        {batch && plan.approval ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{t('lend.aa.batch', { amount: fmt(plan.approval.amount), symbol: plan.approval.symbol })}</Text>
        ) : null}
        {callLines}
        {aaQuote.calls.map((c, i) => (
          <Row
            key={`${i}-${c.to}`}
            label={t('staking.aa.call', { n: i + 1, count: aaQuote.calls.length })}
            value={c.to}
            sub={t('swap.aa.calldata', { bytes: c.data.length })}
            mono
            theme={theme}
          />
        ))}
        <Row label={`Smart account ${symbol} balance`} value={`${formatUnits(aaQuote.senderBalance, 18, 18)} ${symbol}`} theme={theme} />
        <Row label="Deployment" value={aaQuote.deployed ? 'Already deployed' : 'Will deploy with this operation'} theme={theme} />
        <Row
          label={aaQuote.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={aaQuote.sponsored ? 'Sponsored — you pay 0' : `${formatUnits(aaQuote.fee, 18, 18)} ${symbol}`}
          theme={theme}
        />
        <AaDepositNote fee={aaQuote.fee} deposit={aaQuote.deposit} sponsored={aaQuote.sponsored} symbol={symbol} />
        {reserveCard}
        <BalanceChangePreview
          url={url}
          request={{ from: aaQuote.sender, to: aaQuote.calls[0]!.to, value: aaQuote.calls[0]!.value, data: aaQuote.calls[0]!.data }}
          batch={aaQuote.calls.map((c) => ({ from: aaQuote.sender, to: c.to, value: c.value, data: c.data }))}
          note={batch ? PREVIEW_AA_BATCH_NOTE : PREVIEW_AA_NOTE}
        />
        <RiskWarnings url={url} wallet={aaQuote.sender} to={plan.main.to} data={plan.main.data} />
        <SpendingPolicyNotice owner={account.address} quote={aaQuote} from={account.address} {...(plan.tokenOutflow ? { quoteOutflows: [plan.tokenOutflow] } : {})} />
        <Text style={[styles.simulationOk, { color: theme.success }]}>
          <T>Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).</T>
        </Text>
        {phase === 'aa-sending' ? (
          sendingView(tx('Signing and submitting to the bundler…'))
        ) : (
          <>
            <Button title={t('staking.aa.button', { action: lendingActionLabel(plan) })} onPress={() => void onAaSend()} />
            <Button title="Back" variant="secondary" onPress={() => backToForm('')} />
          </>
        )}
      </ScrollView>
    );
  }

  // --------------------------------------------------------------- form
  const position = current?.position ?? null;
  const reserve = current?.state ?? null;
  const loadError = current?.error ?? null;
  const amountLabel = t('send.field.amount', { symbol: asset.symbol });
  return (
    <ScrollView key="lend-form" style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
      <LendIntro deployment={deployment} theme={theme} />

      {aaOffered ? (
        <View style={styles.toggleRow}>
          <Switch {...switchColors(theme)} accessibilityLabel={tx('Use the smart account')} value={aaEnabled} onValueChange={setAaEnabled} />
          <Text importantForAccessibility="no" accessibilityElementsHidden style={[styles.toggleLabel, { color: theme.text }]}>
            <T>Use the smart account</T>
          </Text>
        </View>
      ) : (
        <Text style={[styles.hint, { color: theme.textMuted }]}>{smartRefusal}</Text>
      )}

      {loading ? <ActivityIndicator color={theme.accent} accessibilityLabel={t('lend.reserve.loading')} /> : null}
      {aa.error ? <WarningBox>{t('lend.smart.setupFailed', { detail: aa.error })}</WarningBox> : null}
      {loadError ? (
        <>
          <WarningBox>{t('lend.reserve.error', { detail: loadError })}</WarningBox>
          <Button title="Try again" variant="secondary" onPress={() => setReloadTick((n) => n + 1)} />
        </>
      ) : null}
      {reserve ? <LendReserveCard deployment={deployment} state={reserve} theme={theme} /> : null}
      {position && current?.holder ? (
        <LendPositionCard deployment={deployment} position={position} holder={current.holder} hidden={hideAmounts} theme={theme} />
      ) : null}

      <View style={styles.choiceRow}>
        {(['supply', 'withdraw'] as Choice[]).map((c) => {
          const label = c === 'supply' ? t('lend.choice.supply') : t('lend.choice.withdraw');
          return (
            <Button
              key={c}
              title={choice === c ? `✓ ${label}` : label}
              variant={choice === c ? 'primary' : 'secondary'}
              selected={choice === c}
              style={styles.choiceButton}
              onPress={() => {
                setChoice(c);
                setWithdrawAll(false);
                setFormError(null);
              }}
            />
          );
        })}
      </View>
      {choice === 'withdraw' ? (
        <View style={styles.toggleRow}>
          <Switch {...switchColors(theme)} accessibilityLabel={t('lend.withdrawAll')} value={withdrawAll} onValueChange={setWithdrawAll} />
          <Text importantForAccessibility="no" accessibilityElementsHidden style={[styles.toggleLabel, { color: theme.text }]}>
            {t('lend.withdrawAll')}
          </Text>
        </View>
      ) : null}
      {choice === 'withdraw' && withdrawAll ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>{t('lend.withdrawAll.note')}</Text>
      ) : (
        <>
          <Text {...fieldLabel('amount', amountLabel).label} style={[styles.label, { color: theme.textMuted }]}>{amountLabel}</Text>
          <TextInput
            {...fieldLabel('amount', amountLabel).input}
            style={inputStyle}
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="decimal-pad"
            placeholder="0.1"
            placeholderTextColor={theme.textMuted}
          />
          {choice === 'supply' ? (
            <Button title="Max" variant="secondary" disabled={position === null} accessibilityHint={t('lend.max.hint')} onPress={onMax} />
          ) : null}
        </>
      )}
      {formError ? (
        <Text accessibilityLiveRegion="polite" style={[styles.fieldError, { color: theme.danger }]}>
          {formError}
        </Text>
      ) : null}
      {phase === 'preparing' ? sendingView(t('lend.preparing')) : <Button title="Review" onPress={() => void onReview()} disabled={loading} />}
    </ScrollView>
  );
}

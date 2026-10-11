import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { addToken, knownStakingTokensForChain, listTokens } from '../wallet/tokens';
import { formatAssetId } from '@shiba-wallet/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { httpTransport as evmHttpTransport } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, ImportedKeyNotice, TestNetworksOnlyCard, WarningBox, screenStyle } from '../components';
import { callWithFailover, getEndpoint, reportEndpointFailure, withEndpoint, type NetworkEndpoint, type UsableEndpoint } from '../config/networks';
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
import { formatUnits, parseUnits } from '../wallet/balances';
import {
  EVM_CHAIN_ID,
  QUOTE_ENDPOINT_CHANGED_TITLE,
  describeSendError,
  quoteEndpointChange,
  sendEvm,
  type EvmSendQuote,
  type SendResult,
} from '../wallet/send';
import { waitForAllowance } from '../wallet/swap';
import {
  KERNEL_BUNDLER_NOTE,
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
  LIDO_RISK_STATEMENT,
  ROCKET_POOL_RISK_STATEMENT,
  StakingRefusal,
  planStakingAction,
  prepareStakingAa,
  prepareStakingSend,
  readLidoAvailability,
  readRocketPoolAvailability,
  readStakingBalances,
  stakingActionTitle,
  stakingBalancesHolderLine,
  stakingOfferFor,
  stakingSuccessBalanceNote,
  type LidoAvailability,
  type RocketPoolAvailability,
  type StakingAction,
  type StakingBalances,
  type StakingOffer,
  type StakingPlan,
} from '../wallet/staking';
import {
  NetworkBadge,
  QuotedStatementCard,
  Row,
  StakeOutcomeCard,
  StakingBalancesCard,
  exact18,
  stakingStyles as styles,
} from './StakingViews';

/**
 * The route is registered by the CTO (navigation.ts `Staking: undefined`,
 * App.tsx); the intersection keeps this screen type-correct before and
 * after that line lands.
 */
type Props = NativeStackScreenProps<RootStackParamList & { Staking: undefined }, 'Staking'>;

type Phase = 'form' | 'preparing' | 'approve' | 'approving' | 'confirm' | 'sending' | 'aa-confirm' | 'aa-sending' | 'success';

/** The form's choices; each maps to one StakingAction. */
type Choice = 'lido-steth' | 'lido-wsteth' | 'rocket' | 'wrap' | 'unwrap' | 'unstake' | 'claim' | 'burn';

const CHOICE_LABEL: Record<Choice, string> = {
  'lido-steth': 'Stake → stETH',
  'lido-wsteth': 'Stake → wstETH',
  rocket: 'Stake → rETH',
  wrap: 'Wrap stETH',
  unwrap: 'Unwrap wstETH',
  unstake: 'Unstake (request)',
  claim: 'Claim',
  burn: 'Redeem rETH',
};

/** Which unit the amount field is in, per choice ('none' for Claim). */
function amountUnit(choice: Choice, nativeSymbol: string): string {
  switch (choice) {
    case 'lido-steth':
    case 'lido-wsteth':
    case 'rocket':
      return nativeSymbol;
    case 'wrap':
    case 'unstake':
      return 'stETH';
    case 'unwrap':
      return 'wstETH';
    case 'burn':
      return 'rETH';
    case 'claim':
      return 'none';
  }
}

function actionFor(choice: Choice, amount: bigint): StakingAction {
  switch (choice) {
    case 'lido-steth':
      return { kind: 'stake', protocol: 'lido', receive: 'stETH', amount };
    case 'lido-wsteth':
      return { kind: 'stake', protocol: 'lido', receive: 'wstETH', amount };
    case 'rocket':
      return { kind: 'stake', protocol: 'rocket-pool', amount };
    case 'wrap':
      return { kind: 'wrap', amount };
    case 'unwrap':
      return { kind: 'unwrap', amount };
    case 'unstake':
      return { kind: 'unstake', amount };
    case 'claim':
      return { kind: 'claim' };
    case 'burn':
      return { kind: 'burn', amount };
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A refusal is shown as its own sentence; anything else in the send screens'
 * wording, with the network's own coin name (`symbol`: evmChain.displaySymbol,
 * "test ETH" on a test network — the 2026-10-11 re-check found "Not enough
 * ETH to cover this amount plus the network fee." on Sepolia).
 */
function describeStakingError(e: unknown, symbol: string): string {
  if (e instanceof StakingRefusal || (e as { name?: unknown } | null)?.name === 'FeatureNotAllowedError') return errorText(e);
  const { title, detail } = describeSendError(e, symbol);
  const clean = sanitizeEndpointMessage(detail);
  return clean === '' ? title : `${title}\n${clean}`;
}

/**
 * Staking (features 57 and 58, phase 18 item 2; docs/STAKING.md): Lido
 * and, on Hoodi, Rocket Pool, on TEST NETWORKS ONLY (readiness row
 * 'staking', enforced here before any request and again in
 * wallet/staking.ts). A protocol card per available protocol quotes the
 * protocol's own risk statement with its source and date; on Sepolia the
 * "deprecated, no rewards" line comes from Lido's own status and a live
 * oracle read, and Unstake is refused after a live isPaused() read.
 *
 * Every action goes through the EXISTING confirm idioms: the regular
 * account through prepareEvmSend / sendEvm (an exact token approval first
 * when one is needed, as in the swap flow), the smart account (where the
 * Kernel contracts exist; never on Hoodi) through prepareAaCalls / sendAa
 * as one all-or-nothing operation. Each confirm shows the network badge,
 * the fee, the staking outcome ("You send … / You receive ≈ …" with the
 * rebasing note), the balance-change preview, the risk card, the spending
 * limits, the eth_call (or bundler) gate, then the device check.
 */
/**
 * After a successful stake, wrap or unwrap, make sure the token the user now
 * holds is on the tracked list for this chain, so Home shows it. Known
 * staking tokens are deliberately not default-tracked (tokens.ts); tracking
 * one here is the cheap path the notes slice suggested. Duplicates and any
 * store error are ignored: the stake itself has already succeeded.
 */
async function trackReceivedStakingToken(chainCaip2: string, action: StakingAction): Promise<void> {
  const symbol =
    action.kind === 'stake' && action.protocol === 'lido' ? action.receive
    : action.kind === 'stake' && action.protocol === 'rocket-pool' ? 'rETH'
    : action.kind === 'wrap' ? 'wstETH'
    : action.kind === 'unwrap' ? 'stETH'
    : null;
  if (!symbol) return;
  const known = knownStakingTokensForChain(chainCaip2).find((t) => t.symbol === symbol);
  if (!known) return;
  try {
    // Only the asset fields: the stored list has a strict parser.
    await addToken({ kind: 'fungible', assetId: known.assetId, symbol: known.symbol, name: known.name, decimals: known.decimals });
  } catch {
    // already tracked, or the store refused: nothing to do
  }
}

/**
 * Whether stETH is on this chain's tracked token list now (Home lists only
 * tracked tokens), for the success note; null when the list cannot be read.
 */
async function isStethTracked(chainCaip2: string): Promise<boolean | null> {
  const steth = knownStakingTokensForChain(chainCaip2).find((t) => t.symbol === 'stETH');
  if (!steth) return false;
  try {
    const id = formatAssetId(steth.assetId).toLowerCase();
    return (await listTokens(chainCaip2)).some((t) => formatAssetId(t.assetId).toLowerCase() === id);
  } catch {
    return null;
  }
}

export function StakingScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, signWith, activeAccount } = useWallet();
  const { evmChain, hideAmounts } = usePrefs();
  const account = accounts.find((a) => a.chainId === EVM_CHAIN_ID);
  const caip2 = evmChain.caip2;
  const symbol = evmChain.displaySymbol;
  const gate = readinessGate('staking', caip2);

  const [endpoint, setEndpoint] = useState<NetworkEndpoint | null | undefined>(undefined);
  const [reloadTick, setReloadTick] = useState(0);

  const [phase, setPhase] = useState<Phase>('form');
  const [choice, setChoice] = useState<Choice>('lido-steth');
  const [amountText, setAmountText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [plan, setPlan] = useState<StakingPlan | null>(null);
  const [eoaQuote, setEoaQuote] = useState<EvmSendQuote | null>(null);
  const [quotedUrl, setQuotedUrl] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  // The network the transaction went out on, captured when it was sent, so
  // the private note is filed under that network even if the mode changes
  // while the success view is open (as on the Send and Swap screens).
  const [sentNetwork, setSentNetwork] = useState<string | null>(null);
  const [approveTxid, setApproveTxid] = useState<string | null>(null);
  // After a send whose plan involves stETH: is stETH tracked now (so Home
  // lists it)? null until known or when the list could not be read.
  const [stethTracked, setStethTracked] = useState<boolean | null>(null);
  // The EOA the quote was prepared for; signWith signs only for exactly it.
  const preparedFrom = useRef<string | null>(null);

  // Smart account (Sepolia only, where the Kernel contracts exist).
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
    navigation.setOptions({ title: 'Staking' });
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
  let offer: StakingOffer | null = null;
  let offerError: string | null = null;
  if (!gate) {
    try {
      offer = stakingOfferFor(caip2);
    } catch (e) {
      offerError = errorText(e);
    }
  }

  const url = endpoint?.url ?? null;
  const aaType = aaConfig ? effectiveAaAccountType(aaConfig, account?.address) : null;
  const aaOffered =
    offer !== null &&
    offer.smartAccountRefusal === null &&
    aaConfig !== null &&
    isAaConfigured(aaConfig, account?.address) &&
    (aaType === 'kernel-v3.3' || aaType === 'kernel-7702') &&
    url !== null;
  const aaActive = aaOffered && aaEnabled;

  // The smart-account bundle, built from the node URL it is pinned to (its
  // quotes come from it, so the send is pinned to it like the EOA path).
  const aa = useMemo((): { bundle: AaClientBundle | null; url: string | null; error: string | null } => {
    if (!aaActive || !url || !aaConfig || !activeAccount || !account) return { bundle: null, url: null, error: null };
    try {
      const bundle = createAaClientFromConfig(aaConfig, {
        nodeUrl: url,
        chainId: BigInt(evmChain.chainIdDecimal),
        accountIndex: activeAccount.index,
        ownerAddress: account.address,
      });
      return { bundle, url, error: null };
    } catch (e) {
      return { bundle: null, url: null, error: `The smart account could not be set up: ${errorText(e)}` };
    }
  }, [aaActive, url, aaConfig, activeAccount, account, evmChain.chainIdDecimal]);

  // Live availability and balances, through the shared failover rule. The
  // holder is the smart account on the smart-account path. The shown data
  // carries the key it was read for, so a stale result is never shown as
  // current (loading = the key differs).
  const offered = offer !== null && (offer.lido !== null || offer.rocketPool !== null);
  const ownerAddress = account?.address ?? null;
  const loadKey = `${caip2}|${ownerAddress ?? ''}|${aa.bundle ? 'aa' : 'eoa'}|${url ?? ''}|${reloadTick}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    lido: LidoAvailability | null;
    rocket: RocketPoolAvailability | null;
    balances: StakingBalances | null;
    /** The address the balances were read for, and whether it is the smart account. */
    holder: { address: string; smartAccount: boolean } | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (gate || !offered || !ownerAddress) return;
    let cancelled = false;
    const bundle = aa.bundle;
    void (async () => {
      try {
        const holder = bundle ? await resolveAaSender(bundle, ownerAddress) : ownerAddress;
        const { value } = await withEndpoint(EVM_CHAIN_ID, async (ep) => {
          const node = evmHttpTransport(ep.url);
          const [l, r] = await Promise.all([readLidoAvailability(node, caip2), readRocketPoolAvailability(node, caip2)]);
          const b = await readStakingBalances(node, caip2, holder, r);
          return { l, r, b };
        });
        if (!cancelled) {
          setLoaded({
            key: loadKey,
            lido: value.l,
            rocket: value.r,
            balances: value.b,
            holder: { address: holder, smartAccount: bundle !== null },
            error: null,
          });
        }
      } catch (e) {
        if (cancelled) return;
        const text = sanitizeEndpointMessage(errorText(e));
        setLoaded({ key: loadKey, lido: null, rocket: null, balances: null, holder: null, error: text === '' ? 'No details were given.' : text });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, offered, ownerAddress, aa.bundle, caip2, loadKey]);
  const current = loaded && loaded.key === loadKey ? loaded : null;
  const loading = offered && current === null;
  const lido = current?.lido ?? null;
  const rocket = current?.rocket ?? null;
  const balances = current?.balances ?? null;
  const balancesHolder = current?.holder ?? null;
  const loadError = current?.error ?? null;

  // ------------------------------------------------------------ guards
  if (gate) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <TestNetworksOnlyCard feature={gate.feature} hint={gate.hint} />
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
  if (offer.unavailable) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.hint, { color: theme.text }]}>{offer.unavailable}</Text>
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

  const allowancePollUrl = async (): Promise<string> => {
    const ep = await getEndpoint(EVM_CHAIN_ID);
    if (!ep || ep.url === null || ep.network.chainId !== caip2) throw new Error('No usable endpoint for this network right now.');
    return ep.url;
  };

  const backToForm = (message: string) => {
    setFormError(message);
    setPlan(null);
    setEoaQuote(null);
    setAaQuote(null);
    setPhase('form');
  };

  /** Plans and quotes the main call (or its approval) on the regular account. */
  const quoteEoa = async (action: StakingAction): Promise<'approve' | 'main'> => {
    const start = await currentEndpoint();
    const outcome = await callWithFailover(start, async (ep) => {
      const p = await planStakingAction(evmHttpTransport(ep.url), caip2, account.address, action, symbol);
      const q = await prepareStakingSend(ep.url, account.address, p);
      return { p, q };
    });
    if (outcome.switched) setEndpoint(outcome.endpoint);
    preparedFrom.current = account.address;
    setQuotedUrl(outcome.endpoint.url);
    setPlan(outcome.value.p);
    setEoaQuote(outcome.value.q.quote);
    return outcome.value.q.step;
  };

  const onReview = async () => {
    setFormError(null);
    setNotice(null);
    let amount = 0n;
    if (choice !== 'claim') {
      try {
        amount = parseUnits(amountText, 18);
        if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
      } catch (e) {
        setFormError(errorText(e));
        return;
      }
    }
    const action = actionFor(choice, amount);
    setPhase('preparing');
    if (aaActive) {
      try {
        const bundle = aa.bundle;
        if (!bundle) throw new Error('The smart-account session expired; go back and try again.');
        const sender = await resolveAaSender(bundle, account.address);
        const p = await planStakingAction(bundle.node, caip2, sender, action, symbol);
        preparedFrom.current = account.address;
        const q = await prepareStakingAa(bundle, account.address, p);
        setPlan(p);
        setAaQuote(q);
        setPhase('aa-confirm');
      } catch (e) {
        const described = e instanceof StakingRefusal || !aaType ? null : describeAaError(e, { accountType: aaType, deployed: null });
        backToForm(described ? `${described.title}\n${described.detail}` : describeStakingError(e, symbol));
      }
      return;
    }
    try {
      const step = await quoteEoa(action);
      setPhase(step === 'approve' ? 'approve' : 'confirm');
    } catch (e) {
      backToForm(describeStakingError(e, symbol));
    }
  };

  /** Step 1 of 2 on the regular account: the exact approval. */
  const onApprove = async () => {
    if (!quotedUrl || !eoaQuote || !plan?.approval) return;
    const approval = plan.approval;
    const approveUrl = quotedUrl;
    const changed = await pinnedEndpointProblem(approveUrl);
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      backToForm('Please review again.');
      return;
    }
    if (!eoaQuote.simulation.ok) {
      Alert.alert('Not sent', `The pre-flight simulation failed: ${eoaQuote.simulation.reason}. Nothing was sent.`);
      return;
    }
    const auth = await requireLocalAuth(`Approve exactly ${exact18(approval.amount)} ${approval.symbol} for ${plan.contractLabel}`);
    if (!auth.ok) {
      Alert.alert('Not approved', auth.message);
      return;
    }
    setPhase('approving');
    try {
      const sent = await signWith(EVM_CHAIN_ID, preparedFrom.current ?? '', (signer) =>
        sendEvm(approveUrl, signer, eoaQuote, evmChain.explorerTxBase),
      );
      setApproveTxid(sent.txid);
      const confirmed = await waitForAllowance(allowancePollUrl, approval.token, account.address, approval.spender, approval.amount, {
        onPollError: (_error, pollUrl) => {
          if (pollUrl) reportEndpointFailure(caip2, pollUrl);
        },
      });
      if (!confirmed) {
        backToForm(
          `The approval was broadcast (transaction ${sent.txid}) but has not taken effect yet. Nothing further was sent. ` +
            'Wait for it to confirm, then start again: the approval will already be in place.',
        );
        return;
      }
      const step = await quoteEoa(plan.action);
      if (step !== 'main') throw new Error('The approval is not in place yet. Nothing further was sent.');
      setNotice('Approval confirmed. The action was quoted again after the approval; these are the final numbers.');
      setPhase('confirm');
    } catch (e) {
      const { title, detail } = describeSendError(e, symbol);
      Alert.alert(title, detail);
      setPhase('approve');
    }
  };

  /** The main call on the regular account. */
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
    const withinLimits = await spendingGateForQuote({
      chain: caip2,
      owner: account.address,
      from: preparedFrom.current ?? account.address,
      quote: eoaQuote,
      url: sendUrl,
      ...(plan.tokenOutflow ? { quoteOutflows: [plan.tokenOutflow] } : {}),
    });
    if (!withinLimits) return;
    const auth = await requireLocalAuth(stakingActionTitle(plan.action, symbol));
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const sent = await signWith(EVM_CHAIN_ID, preparedFrom.current ?? '', (signer) =>
        sendEvm(sendUrl, signer, eoaQuote, evmChain.explorerTxBase),
      );
      setSentNetwork(caip2);
      setResult(sent);
      setStethTracked(null);
      setPhase('success');
      const chainAtSend = evmChain.caip2;
      void trackReceivedStakingToken(chainAtSend, plan.action)
        .then(() => (plan.rebasing ? isStethTracked(chainAtSend) : null))
        .then(setStethTracked);
    } catch (e) {
      const { title, detail } = describeSendError(e, symbol);
      Alert.alert(title, detail);
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
      backToForm('Please review again.');
      return;
    }
    try {
      await checkAaQuoteBeforeApproval(bundle.bundler, aaQuote);
    } catch (e) {
      const d = describeAaError(e, { accountType: aaQuote.accountType, deployed: aaQuote.deployed }) ?? describeSendError(e, symbol);
      Alert.alert(d.title, d.detail);
      backToForm('Please review again.');
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
    const auth = await requireLocalAuth(`${stakingActionTitle(plan.action, symbol)} from your smart account`);
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('aa-sending');
    try {
      const { userOpHash } = await signWith(EVM_CHAIN_ID, preparedFrom.current ?? '', (signer) => sendAa(bundle, signer, aaQuote));
      setSentNetwork(caip2);
      setAaResult({ userOpHash, receiptState: 'pending', success: null, txHash: null });
      setStethTracked(null);
      setPhase('success');
      void trackReceivedStakingToken(evmChain.caip2, plan.action);
      void waitForAaReceipt(bundle, userOpHash, { timeoutMs: 120_000, pollMs: 3_000 }).then(
        ({ summary }) =>
          setAaResult((prev) =>
            prev && prev.userOpHash === userOpHash ? { ...prev, receiptState: 'found', success: summary.success, txHash: summary.txHash } : prev,
          ),
        () => setAaResult((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, receiptState: 'timeout' } : prev)),
      );
    } catch (e) {
      const d = describeAaError(e, { accountType: aaQuote.accountType, deployed: aaQuote.deployed }) ?? describeSendError(e, symbol);
      Alert.alert(d.title, d.detail);
      // A smart-account quote is used once (aa.ts claimQuoteForSubmission).
      backToForm('Please review again.');
    }
  };

  const inputStyle = [styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.card }];
  const sendingView = (text: string) => (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={theme.accent} />
      <Text style={[styles.hint, { color: theme.textMuted }]}>{text}</Text>
    </View>
  );
  const planNotes = plan
    ? plan.notes.map((n) => (
        <Text key={n} style={[styles.hint, { color: theme.textMuted }]}>
          {n}
        </Text>
      ))
    : null;

  // ------------------------------------------------------------ success
  if (phase === 'success' && (result || aaResult) && plan) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content} {...NOTE_VIEW_SCROLL_PROPS}>
        <Text style={[styles.successTitle, { color: theme.success }]}>{aaResult ? 'Sent to the bundler ✓' : 'Sent ✓'}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{stakingActionTitle(plan.action, symbol)}.</Text>
        {approveTxid ? <Text style={[styles.hint, { color: theme.textMuted }]}>Approval transaction: {approveTxid}</Text> : null}
        <Text style={[styles.label, { color: theme.textMuted }]}>{aaResult ? 'UserOperation hash' : 'Transaction id'}</Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {aaResult ? aaResult.userOpHash : result!.txid}
          </Text>
        </View>
        {result?.explorerUrl ? (
          <Button title="View on block explorer" variant="secondary" onPress={() => void Linking.openURL(result.explorerUrl!)} />
        ) : null}
        {/* Smart account: the receipt poll, the bundle transaction and its
            explorer link, mirroring SendScreen's smart-account success view
            (waitForAaReceipt / summarizeAaReceipt in wallet/aa.ts). */}
        {aaResult?.receiptState === 'pending' ? sendingView('Bundling… waiting for the UserOperation receipt.') : null}
        {aaResult?.receiptState === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            No receipt yet. The operation may still be included — keep the UserOperation hash above to look it up later.
          </Text>
        ) : null}
        {aaResult?.receiptState === 'found' ? (
          <>
            {aaResult.success === false ? (
              <WarningBox>
                The bundler reports the operation was included but reverted on-chain. The gas was still charged to the
                smart account. None of the operation’s calls took effect.
              </WarningBox>
            ) : (
              <Text style={[styles.simulationOk, { color: theme.success }]}>
                Included on-chain{aaResult.success === true ? ' — succeeded.' : '.'}
              </Text>
            )}
            {aaResult.txHash ? (
              <>
                <Text style={[styles.label, { color: theme.textMuted }]}>Transaction</Text>
                <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
                  <Text selectable style={[styles.monoText, { color: theme.text }]}>
                    {aaResult.txHash}
                  </Text>
                </View>
                {evmChain.explorerTxBase ? (
                  <Button
                    title="View on block explorer"
                    variant="secondary"
                    onPress={() => void Linking.openURL(`${evmChain.explorerTxBase}${aaResult.txHash}`)}
                  />
                ) : null}
              </>
            ) : (
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                The bundler&apos;s receipt did not include a recognizable transaction hash; look the UserOperation hash
                up in an ERC-4337 explorer you trust.
              </Text>
            )}
          </>
        ) : null}
        {plan.rebasing ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {stakingSuccessBalanceNote({ smartAccount: aaResult !== null, stethTracked })}
          </Text>
        ) : null}
        {/* The private note (feature 87), as on the Send and Swap success
            views: a smart-account note is kept under the UserOperation hash
            and moved to the bundle transaction when its hash arrives
            (TransactionNoteField calls linkUserOperation). */}
        {sentNetwork && aaResult ? (
          <TransactionNoteField network={sentNetwork} txid={aaResult.txHash} userOpHash={aaResult.userOpHash} />
        ) : null}
        {sentNetwork && !aaResult && result ? (
          <TransactionNoteField network={sentNetwork} txid={result.txid} userOpHash={null} />
        ) : null}
        <Button
          title="Done"
          onPress={() =>
            dismissKeyboardThenClose(() => {
              setResult(null);
              setAaResult(null);
              setSentNetwork(null);
              setStethTracked(null);
              setApproveTxid(null);
              setPlan(null);
              setAmountText('');
              setPhase('form');
              setReloadTick((t) => t + 1);
            })
          }
        />
      </ScrollView>
    );
  }

  // ------------------------------------------------- approve (EOA, step 1)
  if ((phase === 'approve' || phase === 'approving') && plan?.approval && eoaQuote) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.stepTitle, { color: theme.text }]}>Step 1 of 2 — Approve</Text>
        <Row label="From account" value={activeAccount?.name ?? '—'} sub={account.address} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        <Text style={[styles.hint, { color: theme.text }]}>
          {plan.contractLabel} pulls the {plan.approval.symbol} with a token approval. This approves exactly{' '}
          {exact18(plan.approval.amount)} {plan.approval.symbol}, never more, and the next step uses all of it.
        </Text>
        <Row label="Token" value={plan.approval.token} mono theme={theme} />
        <Row label="Spender" value={plan.approval.spender} mono theme={theme} />
        <Row label={`Max network fee (paid in ${symbol})`} value={`${exact18(eoaQuote.fee)} ${symbol}`} theme={theme} />
        <RiskWarnings url={quotedUrl} wallet={account.address} to={eoaQuote.to} data={eoaQuote.data} />
        {eoaQuote.simulation.ok ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}>Pre-flight simulation passed (eth_call).</Text>
        ) : (
          <WarningBox>Pre-flight simulation failed: {eoaQuote.simulation.reason}. Nothing will be sent.</WarningBox>
        )}
        {phase === 'approving' ? (
          sendingView('Approving, then waiting for the approval to take effect…')
        ) : (
          <>
            <Button title={`Approve ${plan.approval.symbol}`} onPress={() => void onApprove()} disabled={!eoaQuote.simulation.ok} />
            <Button title="Back" variant="secondary" onPress={() => backToForm('')} />
          </>
        )}
      </ScrollView>
    );
  }

  // ------------------------------------------------------- confirm (EOA)
  if ((phase === 'confirm' || phase === 'sending') && plan && eoaQuote) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        {plan.approval ? <Text style={[styles.stepTitle, { color: theme.text }]}>Step 2 of 2</Text> : null}
        {notice ? <Text style={[styles.notice, { color: theme.accent }]}>{notice}</Text> : null}
        <Row label="From account" value={activeAccount?.name ?? '—'} sub={account.address} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        <StakeOutcomeCard url={quotedUrl} plan={plan} theme={theme} nativeSymbol={symbol} />
        <Row label={plan.contractLabel} value={eoaQuote.to} mono theme={theme} />
        <Row label={`Max network fee (paid in ${symbol})`} value={`${exact18(eoaQuote.fee)} ${symbol}`} theme={theme} />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Worst case at {formatUnits(eoaQuote.maxFeePerGas, 9, 9)} gwei max fee × {eoaQuote.gasLimit.toString()} gas;
          the actual fee is usually lower.
        </Text>
        {eoaQuote.amount > 0n ? <Row label="Total (worst case)" value={`${exact18(eoaQuote.total)} ${symbol}`} theme={theme} /> : null}
        {planNotes}
        <BalanceChangePreview
          url={quotedUrl}
          request={{ from: account.address, to: eoaQuote.to, value: eoaQuote.amount, ...(eoaQuote.data ? { data: eoaQuote.data } : {}) }}
        />
        <RiskWarnings url={quotedUrl} wallet={account.address} to={eoaQuote.to} data={eoaQuote.data} />
        <SpendingPolicyNotice
          owner={account.address}
          quote={eoaQuote}
          from={account.address}
          {...(plan.tokenOutflow ? { quoteOutflows: [plan.tokenOutflow] } : {})}
        />
        {eoaQuote.simulation.ok ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}>Pre-flight simulation passed (eth_call).</Text>
        ) : (
          <WarningBox>Pre-flight simulation failed: {eoaQuote.simulation.reason}. Nothing will be sent.</WarningBox>
        )}
        {phase === 'sending' ? (
          sendingView('Signing and broadcasting…')
        ) : (
          <>
            <Button title={stakingActionTitle(plan.action, symbol)} onPress={() => void onSend()} disabled={!eoaQuote.simulation.ok} />
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
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.stepTitle, { color: theme.text }]}>Smart account · {aaAccountTypeLabel(aaQuote.accountType)}</Text>
        <Row label="Owner account (signs)" value={activeAccount?.name ?? '—'} sub={account.address} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        <Row label={aaSenderLabel(aaQuote)} value={aaQuote.sender} mono theme={theme} />
        <StakeOutcomeCard url={url} plan={plan} theme={theme} nativeSymbol={symbol} />
        {batch && plan.approval ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            One operation, all-or-nothing: (1) approve exactly {exact18(plan.approval.amount)} {plan.approval.symbol} for{' '}
            {plan.contractLabel}, (2) the action itself. If the action would fail, the approval is undone with it.
          </Text>
        ) : null}
        {aaQuote.calls.map((c, i) => (
          <Row
            key={`${i}-${c.to}`}
            label={`Call ${i + 1} of ${aaQuote.calls.length}`}
            value={c.to}
            sub={`${c.data.length} bytes of calldata${c.value > 0n ? `, value ${exact18(c.value)} ${symbol}` : ''}`}
            mono
            theme={theme}
          />
        ))}
        <Row label={`Smart account ${symbol} balance`} value={`${exact18(aaQuote.senderBalance)} ${symbol}`} theme={theme} />
        <Row label="Deployment" value={aaQuote.deployed ? 'Already deployed' : 'Will deploy with this operation'} theme={theme} />
        {!aaQuote.deployed && aaQuote.accountType === 'kernel-v3.3' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{KERNEL_BUNDLER_NOTE}</Text>
        ) : null}
        <Row
          label={aaQuote.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={aaQuote.sponsored ? 'Sponsored — you pay 0' : `${exact18(aaQuote.fee)} ${symbol}`}
          theme={theme}
        />
        <AaDepositNote fee={aaQuote.fee} deposit={aaQuote.deposit} sponsored={aaQuote.sponsored} symbol={symbol} />
        {planNotes}
        <BalanceChangePreview
          url={url}
          request={{ from: aaQuote.sender, to: aaQuote.calls[0]!.to, value: aaQuote.calls[0]!.value, data: aaQuote.calls[0]!.data }}
          batch={aaQuote.calls.map((c) => ({ from: aaQuote.sender, to: c.to, value: c.value, data: c.data }))}
          note={batch ? PREVIEW_AA_BATCH_NOTE : PREVIEW_AA_NOTE}
        />
        <RiskWarnings url={url} wallet={aaQuote.sender} to={plan.main.to} data={plan.main.data} />
        <SpendingPolicyNotice
          owner={account.address}
          quote={aaQuote}
          from={account.address}
          {...(plan.tokenOutflow ? { quoteOutflows: [plan.tokenOutflow] } : {})}
        />
        <Text style={[styles.simulationOk, { color: theme.success }]}>
          Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).
        </Text>
        {phase === 'aa-sending' ? (
          sendingView('Signing and submitting to the bundler…')
        ) : (
          <>
            <Button title={`${stakingActionTitle(plan.action, symbol)} from smart account`} onPress={() => void onAaSend()} />
            <Button title="Back" variant="secondary" onPress={() => backToForm('')} />
          </>
        )}
      </ScrollView>
    );
  }

  // --------------------------------------------------------------- form
  const lidoOffered = offer.lido !== null;
  const rocketOffered = offer.rocketPool !== null;
  const choices: Choice[] = [
    ...(lidoOffered ? (['lido-steth', 'lido-wsteth'] as Choice[]) : []),
    ...(rocketOffered ? (['rocket'] as Choice[]) : []),
    ...(lidoOffered ? (['wrap', 'unwrap', 'unstake', 'claim'] as Choice[]) : []),
    ...(rocketOffered ? (['burn'] as Choice[]) : []),
  ];
  const unit = amountUnit(choice, symbol);
  const lidoRefusal = choice === 'unstake' ? lido?.unstakeRefusal ?? null : ['lido-steth', 'lido-wsteth'].includes(choice) ? lido?.stakeRefusal ?? null : null;
  const rocketRefusal = choice === 'rocket' ? rocket?.depositRefusal ?? null : null;

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
      <Text style={[styles.hint, { color: theme.text }]}>
        Staking puts test ETH into a liquid-staking protocol and gives you a token for it. These are test networks: the
        tokens have no value.
      </Text>

      {lidoOffered ? (
        <>
          <Text style={[styles.stepTitle, { color: theme.text }]}>Lido</Text>
          {lido?.honestyLine ? <WarningBox>{lido.honestyLine}</WarningBox> : null}
          {lido && lido.problems.length > 0 ? <WarningBox>{lido.stakeRefusal}</WarningBox> : null}
          <QuotedStatementCard statement={LIDO_RISK_STATEMENT} theme={theme} />
        </>
      ) : null}
      {rocketOffered ? (
        <>
          <Text style={[styles.stepTitle, { color: theme.text }]}>Rocket Pool</Text>
          <QuotedStatementCard statement={ROCKET_POOL_RISK_STATEMENT} theme={theme} />
        </>
      ) : null}

      {offer.smartAccountRefusal && caip2 === 'eip155:560048' ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>{offer.smartAccountRefusal}</Text>
      ) : null}
      {aaOffered ? (
        <View style={styles.toggleRow}>
          <Switch
            accessibilityLabel="Stake from the smart account"
            value={aaEnabled}
            onValueChange={setAaEnabled}
          />
          <Text style={[styles.toggleLabel, { color: theme.text }]}>Use the smart account</Text>
        </View>
      ) : null}

      {loading ? <ActivityIndicator color={theme.accent} /> : null}
      {aa.error ? <WarningBox>{aa.error}</WarningBox> : null}
      {loadError ? (
        <>
          <WarningBox>The staking contracts could not be read right now. {loadError}</WarningBox>
          <Button title="Try again" variant="secondary" onPress={() => setReloadTick((t) => t + 1)} />
        </>
      ) : null}
      {balances && balancesHolder ? (
        <StakingBalancesCard
          balances={balances}
          hidden={hideAmounts}
          nativeSymbol={symbol}
          holderLine={stakingBalancesHolderLine(balancesHolder.smartAccount, balancesHolder.address)}
          theme={theme}
        />
      ) : null}

      <Text style={[styles.label, { color: theme.textMuted }]}>What to do</Text>
      <View style={styles.choiceRow}>
        {choices.map((c) => (
          <Button
            key={c}
            title={choice === c ? `✓ ${CHOICE_LABEL[c]}` : CHOICE_LABEL[c]}
            variant={choice === c ? 'primary' : 'secondary'}
            selected={choice === c}
            style={styles.choiceButton}
            onPress={() => {
              setChoice(c);
              setFormError(null);
            }}
          />
        ))}
      </View>
      {lidoRefusal ? <WarningBox>{lidoRefusal}</WarningBox> : null}
      {rocketRefusal ? <WarningBox>{rocketRefusal}</WarningBox> : null}
      {choice === 'rocket' && rocket ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Minimum deposit {exact18(rocket.state.minimumDeposit)} {symbol}; deposit fee{' '}
          {formatUnits(rocket.state.depositFee, 16, 16)}% (both read just now).
        </Text>
      ) : null}
      {unit !== 'none' ? (
        <>
          <Text style={[styles.label, { color: theme.textMuted }]}>Amount ({unit})</Text>
          <TextInput
            accessibilityLabel={`Amount in ${unit}`}
            style={inputStyle}
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="decimal-pad"
            placeholder="0.001"
            placeholderTextColor={theme.textMuted}
          />
        </>
      ) : (
        <Text style={[styles.hint, { color: theme.textMuted }]}>Claims every finalized Lido withdrawal request of this account.</Text>
      )}
      {formError ? (
        <Text accessibilityLiveRegion="polite" style={[styles.fieldError, { color: theme.danger }]}>
          {formError}
        </Text>
      ) : null}
      {phase === 'preparing' ? (
        sendingView('Reading the protocol and preparing the quote…')
      ) : (
        <Button title="Review" onPress={() => void onReview()} disabled={lidoRefusal !== null || rocketRefusal !== null} />
      )}
    </ScrollView>
  );
}

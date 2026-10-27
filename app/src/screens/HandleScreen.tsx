import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, ScrollView, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ENS_V2_SEPOLIA, type Call, type EnsSubnamePlan } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, ImportedKeyNotice, TestNetworksOnlyCard, WarningBox, screenStyle, useFieldLabels } from '../components';
import { getEndpoint, type NetworkEndpoint, type UsableEndpoint } from '../config/networks';
import { readinessGate } from '../config/readiness';
import { sanitizeEndpointMessage } from '../config/endpoint-probe';
import { useTheme } from '../theme';
import { useI18n } from '../i18n/useI18n';
import { spokenShortAddress } from '../a11y';
import { BalanceChangePreview } from '../components/BalanceChangePreview';
import { RiskWarnings } from '../components/RiskWarnings';
import { SpendingPolicyNotice, spendingGateForQuote } from '../components/SpendingPolicyViews';
import { AaDepositNote } from '../components/AaDepositNote';
import { NOTE_VIEW_SCROLL_PROPS, TransactionNoteField, dismissKeyboardThenClose } from '../components/TransactionNoteField';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { AsyncStorage } from '../wallet/store-keys';
import { simulationTransport } from '../wallet/simulation';
import {
  EVM_CHAIN_ID,
  QUOTE_ENDPOINT_CHANGED_TITLE,
  describeSendError,
  prepareEvmSend,
  quoteEndpointChange,
  sendEvm,
  type EvmSendQuote,
} from '../wallet/send';
import {
  checkAaQuoteBeforeApproval,
  createAaClientFromConfig,
  describeAaError,
  effectiveAaAccountType,
  getAaConfig,
  isAaConfigured,
  prepareAaCalls,
  resolveAaSender,
  sendAa,
  waitForAaReceipt,
  type AaChainConfig,
  type AaClientBundle,
  type AaSendQuote,
} from '../wallet/aa';
import {
  HANDLE_DURATION_DAYS,
  HANDLE_GRACE_DAYS,
  HANDLE_READY_MARGIN_SECONDS,
  HANDLE_SUB_LABEL_DEFAULT,
  HANDLE_USDC,
  HANDLE_WAIT_POLL_MS,
  checkHandleLabel,
  checkHandleSubLabel,
  describeHandleError,
  forgetPendingHandle,
  formatUsdc,
  gateRegister,
  handleAccountRefusal,
  handleCallLines,
  handleCardLiveText,
  handleOfferFor,
  handlePromptTitle,
  loadPendingHandles,
  newHandlePlan,
  pendingFor,
  planFromPending,
  planHandleSubname,
  preflightRegister,
  quoteHandle,
  readHandleProgress,
  readProgressUntil,
  readRegistrarAllowance,
  readSubnameState,
  refreshPrimaryNameUntil,
  resetPendingHandles,
  revokeRegistrarApprovalCall,
  savePendingHandle,
  smartOwnerRefusal,
  spokenTxId,
  spokenWithShortAddresses,
  waitForTx,
  waitingSentence,
  type HandleOwnerKind,
  type HandleProgress,
  type HandleQuote,
  type PendingHandle,
  type PendingHandles,
  type SubnameState,
} from '../wallet/handle';
import { CallLines, Note, handleStyles, primaryNames, usePrimaryName } from './HandleViews';
import { NetworkBadge, Row, exact18, stakingStyles as styles } from './StakingViews';

type Props = NativeStackScreenProps<RootStackParamList, 'Handle'>;

type Phase = 'main' | 'checking' | 'review' | 'quoting' | 'tx-confirm' | 'tx-sending' | 'aa-confirm' | 'aa-sending' | 'success';

/** One thing to send: a single transaction (regular account) or one operation (smart account). */
interface Job {
  kind: 'prepare' | 'register' | 'reverse' | 'subname' | 'targetReverse' | 'revoke';
  path: 'eoa' | 'aa';
  calls: Call[];
  /** The confirm screen's lines for these calls. */
  lines: string[];
  /** "Transaction i of n" for a regular account's step (null for a single operation). */
  position: { index: number; count: number } | null;
  /** The prompt title. */
  title: string;
  /** For prepare / register / reverse: the record the calls were built from. */
  record: PendingHandle | null;
  /** For a prepare call sent from a regular account: which call (0 record, 1 approval, 2 commit). */
  prepareIndex: number | null;
  /** The name the success view names (the handle, or the sub-name). */
  name: string;
  /** For 'revoke': whose approval is set to 0 (the regular or the smart account). */
  revokeOwner?: string;
  /**
   * For 'register': true when the register pre-flight (an eth_call of
   * register() from the owner — the smart account's own address for a
   * smart owner) passed just before this job was opened (pass p23-handle
   * finding 7: the smart-account review now says so too).
   */
  preflightOk?: boolean;
}

/** Where the main view scrolls to when it is next laid out (pass p23-handle finding 2). */
type ScrollAnchor = 'notice' | 'card' | 'answer' | 'sub';

/** How long after its first scroll an anchor keeps following layout changes (a judgement). */
const ANCHOR_SETTLE_MS = 3_000;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The smart account that may own a handle (a Kernel v3.3 account set up on
 * this network; `config` is null otherwise): its client, built from the node
 * URL every read uses, and its address.
 */
function useHandleSmartAccount(
  config: AaChainConfig | null,
  url: string | null,
  accountIndex: number | null,
  owner: string | null,
  chainIdDecimal: string,
): { bundle: AaClientBundle | null; smartAddress: string | null } {
  const bundle = useMemo((): AaClientBundle | null => {
    if (!config || !url || accountIndex === null || !owner) return null;
    try {
      return createAaClientFromConfig(config, { nodeUrl: url, chainId: BigInt(chainIdDecimal), accountIndex, ownerAddress: owner });
    } catch {
      return null;
    }
  }, [config, url, accountIndex, owner, chainIdDecimal]);
  const [resolved, setResolved] = useState<{ bundle: AaClientBundle; address: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!bundle || !owner) return undefined;
    resolveAaSender(bundle, owner).then(
      (a) => !cancelled && setResolved({ bundle, address: a }),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [bundle, owner]);
  return { bundle, smartAddress: bundle && resolved && resolved.bundle === bundle ? resolved.address : null };
}

/**
 * A wallet handle (phase 23 item 6, feature 75; docs/WALLET_HANDLES.md): an
 * ENS .eth name registered on Ethereum Sepolia's ENSv2 contracts, in two
 * steps with the registrar's wait between them. Every call goes through the
 * existing confirm idioms: a regular account through prepareEvmSend /
 * sendEvm, one transaction per call, each with its own confirm and device
 * check (the next one is quoted only once the previous one is included); a
 * smart account through prepareAaCalls / sendAa, one operation per step.
 * Register is pre-flighted (eth_call from the owner against the latest
 * block) before the device prompt, and the wait is read from the latest
 * block's time on the sending endpoint (wallet/handle.ts gateRegister,
 * readHandleProgress). The commitment's secret lives only in the
 * wallet-scoped record; this screen never renders it.
 */
export function HandleScreen({ navigation }: Props) {
  const theme = useTheme();
  const { t } = useI18n();
  const fieldLabel = useFieldLabels();
  const { accounts, activeAccount, signWith } = useWallet();
  const { evmChain } = usePrefs();
  const caip2 = evmChain.caip2;
  const symbol = evmChain.displaySymbol;
  const account = accounts.find((a) => a.chainId === EVM_CHAIN_ID);
  const offer = handleOfferFor(caip2);
  const gate = readinessGate('wallet-handle', caip2);
  const accountRefusal = handleAccountRefusal(activeAccount ?? null);

  const [endpoint, setEndpoint] = useState<NetworkEndpoint | null | undefined>(undefined);
  const [aaConfig, setAaConfig] = useState<AaChainConfig | null>(null);
  const [pending, setPending] = useState<PendingHandles | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [phase, setPhase] = useState<Phase>('main');
  const [labelText, setLabelText] = useState('');
  const [ownerKind, setOwnerKind] = useState<HandleOwnerKind>('regular');
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quoted, setQuoted] = useState<HandleQuote | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [eoaQuote, setEoaQuote] = useState<EvmSendQuote | null>(null);
  const [aaQuote, setAaQuote] = useState<AaSendQuote | null>(null);
  const [quotedUrl, setQuotedUrl] = useState<string | null>(null);
  const [result, setResult] = useState<{ txid: string; explorerUrl: string | null; title: string; body: string; anchor?: ScrollAnchor } | null>(null);
  const [subLabel, setSubLabel] = useState(HANDLE_SUB_LABEL_DEFAULT);
  const [subError, setSubError] = useState<string | null>(null);

  // Pass p23-handle finding 2: every other phase replaces the main view, so
  // coming back to it (after Check, a confirm screen or an included step)
  // mounted a fresh ScrollView at the top, five intro paragraphs above the
  // answer or the registration card. The main view now scrolls to what it
  // was opened for: each anchor reports its offset when laid out, and while
  // an anchor is pending every layout pass of it scrolls there again
  // (content above it can still change height as reads finish), for
  // ANCHOR_SETTLE_MS after the first scroll; the user's first drag ends the
  // pending state earlier (the Settings section-anchor pattern,
  // SettingsScreen.tsx scrollToSection). The time limit keeps a later
  // layout change (the countdown's text every block) from pulling a
  // screen-reader user, who moves without dragging, back to the anchor.
  const mainScroll = useRef<ScrollView>(null);
  const pendingAnchor = useRef<{ anchor: ScrollAnchor; until: number | null } | null>(null);
  const onAnchorLayout = (anchor: ScrollAnchor, y: number) => {
    const pending = pendingAnchor.current;
    if (!pending || pending.anchor !== anchor) return;
    const now = Date.now();
    if (pending.until === null) pending.until = now + ANCHOR_SETTLE_MS;
    else if (now > pending.until) {
      pendingAnchor.current = null;
      return;
    }
    mainScroll.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
  };

  useEffect(() => {
    navigation.setOptions({ title: t('handle.title') });
  }, [navigation, t]);

  useEffect(() => {
    let cancelled = false;
    getEndpoint(EVM_CHAIN_ID).then(
      (e) => !cancelled && setEndpoint(e ?? null),
      () => !cancelled && setEndpoint(null),
    );
    getAaConfig(caip2).then(
      (c) => !cancelled && setAaConfig(c),
      () => !cancelled && setAaConfig(null),
    );
    return () => {
      cancelled = true;
    };
  }, [caip2]);

  const url = endpoint && endpoint.network.chainId === caip2 ? endpoint.url : null;
  const address = account?.address ?? null;

  // The smart account (first slice: a Kernel v3.3 account set up on this
  // network; see wallet/handle.ts smartOwnerRefusal).
  const aaType = aaConfig ? effectiveAaAccountType(aaConfig, address) : null;
  const smartRefusal = smartOwnerRefusal(aaType, aaConfig !== null && isAaConfigured(aaConfig, address));
  const { bundle, smartAddress: shownSmartAddress } = useHandleSmartAccount(
    smartRefusal === null ? aaConfig : null,
    url,
    activeAccount?.index ?? null,
    address,
    evmChain.chainIdDecimal,
  );

  // The prepared registrations of this wallet (wallet-scoped, through the seam), re-read on focus.
  const [focusTick, setFocusTick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      setFocusTick((n) => n + 1);
    }, []),
  );
  useEffect(() => {
    let cancelled = false;
    loadPendingHandles(AsyncStorage).then(
      (p) => !cancelled && setPending(p),
      () => !cancelled && setPending({ records: [], damaged: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [reloadTick, focusTick]);
  const record = pending && address ? pendingFor(pending, address) : null;

  // Where the prepared registration stands, from the chain (the latest block
  // of the endpoint it is sent through); re-read every half slot while waiting.
  const progressKey = `${record?.commitment ?? ''}|${url ?? ''}|${reloadTick}`;
  const [progress, setProgress] = useState<{ key: string; value: HandleProgress | null; error: string | null } | null>(null);
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    if (!record || !url) return undefined;
    let cancelled = false;
    readHandleProgress(simulationTransport(url), record).then(
      (value) => !cancelled && setProgress({ key: progressKey, value, error: null }),
      (e) => !cancelled && setProgress({ key: progressKey, value: null, error: sanitizeEndpointMessage(errorText(e)) || errorText(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [record, url, progressKey, pollTick]);
  const current = progress && progress.key === progressKey ? progress : null;
  useEffect(() => {
    if (phase !== 'main' || current?.value?.kind !== 'wait') return undefined;
    const handle = setTimeout(() => setPollTick((n) => n + 1), HANDLE_WAIT_POLL_MS);
    return () => clearTimeout(handle);
  }, [phase, current]);

  // What the ENS registrar may still take (shown with Forget and when no
  // registration is in progress, with the exact-zero revoke).
  const [allowances, setAllowances] = useState<{ key: string; list: { owner: string; kind: HandleOwnerKind; amount: bigint }[] } | null>(null);
  const allowanceKey = `${address ?? ''}|${shownSmartAddress ?? ''}|${url ?? ''}|${reloadTick}`;
  useEffect(() => {
    if (!url || !address || !offer.ok) return undefined;
    let cancelled = false;
    void (async () => {
      const node = simulationTransport(url);
      const owners: { owner: string; kind: HandleOwnerKind }[] = [{ owner: address, kind: 'regular' }];
      if (shownSmartAddress) owners.push({ owner: shownSmartAddress, kind: 'smart' });
      const list = [];
      for (const o of owners) {
        try {
          list.push({ ...o, amount: await readRegistrarAllowance(node, o.owner) });
        } catch {
          // Shown only when read.
        }
      }
      if (!cancelled) setAllowances({ key: allowanceKey, list });
    })();
    return () => {
      cancelled = true;
    };
  }, [url, address, shownSmartAddress, offer.ok, allowanceKey]);
  const openAllowances = allowances && allowances.key === allowanceKey ? allowances.list.filter((a) => a.amount > 0n) : [];

  // The regular account's primary name: the parent of the smart account's sub-name.
  const primary = usePrimaryName(address, caip2);
  const parentName =
    primary?.status === 'ok' && /^[a-z0-9-]+\.eth$/.test(primary.name) ? primary.name : null;
  const smartPrimary = usePrimaryName(shownSmartAddress, caip2);

  // Where the sub-name points now (pass p23-handle finding 10): read forward
  // through the Universal Resolver, after a short pause so a name being
  // typed is not read on every keystroke (600 ms, a judgement), and again on
  // Check now and after each step. A failed read keeps "Add the sub-name".
  const subCheck = checkHandleSubLabel(subLabel);
  const subName = parentName && subCheck.ok ? `${subCheck.label}.${parentName}` : null;
  const subKey = `${subName ?? ''}|${shownSmartAddress ?? ''}|${url ?? ''}|${reloadTick}`;
  const [subState, setSubState] = useState<{ key: string; value: SubnameState } | null>(null);
  useEffect(() => {
    if (!subName || !shownSmartAddress || !url) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      readSubnameState(simulationTransport(url), subName, shownSmartAddress).then(
        (value) => !cancelled && setSubState({ key: subKey, value }),
        () => undefined,
      );
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [subName, shownSmartAddress, url, subKey]);
  const subPoints = subState && subState.key === subKey ? subState.value : null;

  // ------------------------------------------------------------- guards
  if (gate) {
    return (
      <ScrollView key="handle-gate" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <TestNetworksOnlyCard feature={gate.feature} hint={gate.hint} />
      </ScrollView>
    );
  }
  if (!offer.ok || accountRefusal || !account || !address) {
    return (
      <ScrollView key="handle-refused" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <WarningBox>{!offer.ok ? offer.text : (accountRefusal ?? t('handle.refusal.noAccount'))}</WarningBox>
      </ScrollView>
    );
  }
  if (endpoint === undefined || pending === null) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  // ------------------------------------------------------------ helpers
  const currentEndpoint = async (): Promise<UsableEndpoint> => {
    const fresh = await getEndpoint(EVM_CHAIN_ID);
    if (!fresh || fresh.url === null) throw new Error(t('handle.refusal.noBlock'));
    if (fresh.network.chainId !== caip2) throw new Error(t('handle.refusal.network', { network: fresh.network.label }));
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
  const reload = () => setReloadTick((n) => n + 1);
  const backToMain = (message: string | null, anchor: ScrollAnchor = message ? 'notice' : 'card') => {
    pendingAnchor.current = { anchor, until: null };
    setNotice(message);
    setJob(null);
    setEoaQuote(null);
    setAaQuote(null);
    setPhase('main');
    reload();
  };
  const ownerLabelOf = (owner: string, kind: HandleOwnerKind) =>
    kind === 'smart' ? `${t('receive.smart.label')} ${owner}` : `${activeAccount?.name ?? ''} ${owner}`.trim();

  /** Quotes one job and opens its confirm screen. */
  const openJob = async (next: Job) => {
    setPhase('quoting');
    setNotice(null);
    try {
      if (next.path === 'aa') {
        if (!bundle) throw new Error(t('handle.owner.smartUnavailable'));
        const q = await prepareAaCalls(bundle, address, next.calls, {
          displayTo: next.calls[0]!.to,
          ...(next.kind === 'register' && next.record
            ? { tokenSpend: { contract: HANDLE_USDC.address, amount: BigInt(next.record.total), symbol: HANDLE_USDC.symbol } }
            : {}),
        });
        setAaQuote(q);
        setJob(next);
        setPhase('aa-confirm');
        return;
      }
      const start = await currentEndpoint();
      const call = next.calls[0]!;
      const q = await prepareEvmSend(start.url, address, call.to, call.value, call.data, caip2);
      setQuotedUrl(start.url);
      setEoaQuote(q);
      setJob(next);
      setPhase('tx-confirm');
    } catch (e) {
      const d = next.path === 'aa' && aaType ? describeAaError(e, { accountType: aaType, deployed: null }) : null;
      backToMain(d ? `${d.title}\n${d.detail}` : describeSendErrorText(e));
    }
  };
  const describeSendErrorText = (e: unknown) => {
    const { title, detail } = describeSendError(e, symbol, symbol);
    const clean = sanitizeEndpointMessage(detail);
    return clean === '' ? title : `${title}\n${clean}`;
  };

  /** The next job for a prepared registration, from its progress. */
  const jobFor = (rec: PendingHandle, p: HandleProgress): Job | null => {
    const plan = planFromPending(rec);
    const smart = rec.ownerKind === 'smart';
    const path = smart ? 'aa' : 'eoa';
    if (p.kind === 'prepare') {
      const lines = handleCallLines(rec, 'prepare');
      if (smart) {
        return { kind: 'prepare', path, calls: plan.prepare.calls, lines, position: null, title: handlePromptTitle('prepare', { name: rec.name, smart }), record: rec, prepareIndex: null, name: rec.name };
      }
      return {
        kind: 'prepare', path, calls: [plan.prepare.calls[p.next]!], lines: [lines[p.next]!], position: { index: p.next + 1, count: 3 },
        title: handlePromptTitle('prepare', { name: rec.name, index: p.next + 1, count: 3 }), record: rec, prepareIndex: p.next, name: rec.name,
      };
    }
    if (p.kind === 'ready') {
      const lines = handleCallLines(rec, 'register');
      if (smart) {
        return { kind: 'register', path, calls: plan.register.calls, lines, position: null, title: handlePromptTitle('register', { name: rec.name, smart }), record: rec, prepareIndex: null, name: rec.name };
      }
      return {
        kind: 'register', path, calls: [plan.register.calls[0]!], lines: [lines[0]!], position: { index: 1, count: plan.register.calls.length },
        title: handlePromptTitle('register', { name: rec.name }), record: rec, prepareIndex: null, name: rec.name,
      };
    }
    if (p.kind === 'reverse') {
      const lines = handleCallLines(rec, 'register');
      const call = plan.register.calls[1];
      if (!call) return null;
      return {
        kind: 'reverse', path, calls: [call], lines: [lines[1]!], position: smart ? null : { index: 2, count: 2 },
        title: handlePromptTitle('reverse', { name: rec.name }), record: rec, prepareIndex: null, name: rec.name,
      };
    }
    return null;
  };

  /** After an included step: read the chain again and open what comes next. */
  const afterStep = async (done: Job, sent: { txid: string; explorerUrl: string | null }) => {
    if (done.kind === 'subname' || done.kind === 'targetReverse' || done.kind === 'revoke') {
      // The smart account's own name was just set: read it again now (finding 1).
      if (done.kind === 'targetReverse' && shownSmartAddress) void refreshPrimaryNameUntil(primaryNames, caip2, shownSmartAddress, done.name);
      setResult({
        ...sent,
        title: t('handle.sent.title'),
        anchor: done.kind === 'revoke' ? 'card' : 'sub',
        body:
          done.kind === 'subname' ? t('handle.sub.done', { sub: done.name, target: shownSmartAddress ?? '' })
          : done.kind === 'targetReverse' ? t('handle.sub.reverseDone', { sub: done.name, target: shownSmartAddress ?? '' })
          // Pass p23-handle finding 9: the result, not the instruction.
          : t('handle.revoke.done', { who: done.revokeOwner ?? address }),
      });
      setPhase('success');
      return;
    }
    const rec = done.record;
    if (!rec || !url) {
      backToMain(null);
      return;
    }
    // A load-balanced endpoint can answer from a backend that has not seen
    // the block just mined yet: while the chain still shows the step that was
    // just included as not done, read again — every HANDLE_STEP_POLL_MS for
    // up to HANDLE_STEP_POLL_MAX_MS (handle.ts readProgressUntil; pass
    // p23-handle finding 3: it used to give up after 4 reads 4 s apart and
    // leave the card behind until Check now was tapped).
    const stale = (q: HandleProgress) =>
      (done.kind === 'prepare' && q.kind === 'prepare' && (done.prepareIndex === null || q.next <= done.prepareIndex)) ||
      (done.kind === 'register' && (q.kind === 'ready' || q.kind === 'wait')) ||
      (done.kind === 'reverse' && q.kind === 'reverse');
    const node = simulationTransport(url);
    let p: HandleProgress;
    try {
      const read = await readProgressUntil(() => readHandleProgress(node, rec), stale);
      if (read.stale) {
        backToMain(t('handle.tx.notSeen', { hash: sent.txid }));
        return;
      }
      p = read.progress;
    } catch (e) {
      backToMain(describeHandleError(e, rec.name));
      return;
    }
    if (p.kind === 'done') {
      // Registered and shown for the owner: the secret has no use any more.
      await forgetPendingHandle(AsyncStorage, rec.signer).catch(() => undefined);
      setResult({ ...sent, title: t('handle.success.title'), body: t('handle.success.body', { name: rec.name, owner: rec.owner }), anchor: 'sub' });
      setPhase('success');
      reload();
      // Pass p23-handle finding 1: read the owner's primary name again now
      // (it used to be cleared here and read only on the next focus), so the
      // sub-name section appears without leaving the screen.
      void refreshPrimaryNameUntil(primaryNames, caip2, rec.owner, rec.name);
      return;
    }
    const next = p.kind === 'prepare' || p.kind === 'reverse' ? jobFor(rec, p) : null;
    if (next) {
      await openJob(next);
      return;
    }
    backToMain(null);
  };

  /** The device check (and, for register, the progress and pre-flight before it). */
  const authorizeJob = async (j: Job, quote: EvmSendQuote | AaSendQuote, sendUrl: string): Promise<boolean> => {
    const spendingAndPrompt = async () => {
      const withinLimits = await spendingGateForQuote({
        chain: caip2,
        owner: address,
        from: address,
        quote,
        url: sendUrl,
        ...(j.kind === 'register' && j.record ? { quoteOutflows: [{ token: HANDLE_USDC.address, amount: BigInt(j.record.total) }] } : {}),
      });
      if (!withinLimits) return false;
      const auth = await requireLocalAuth(j.title);
      if (!auth.ok) Alert.alert(t('send.back'), auth.message);
      return auth.ok;
    };
    if (j.kind !== 'register' || !j.record) return spendingAndPrompt();
    const rec = j.record;
    const node = simulationTransport(sendUrl);
    const outcome = await gateRegister({
      name: rec.name,
      progress: () => readHandleProgress(node, rec),
      preflight: () => preflightRegister(node, rec),
      authorize: spendingAndPrompt,
    });
    if (outcome.kind === 'authorized') return true;
    if (outcome.kind === 'wait') backToMain(t('handle.card.recheck'));
    else if (outcome.kind === 'stopped') backToMain(outcome.text);
    return false;
  };

  const onEoaApprove = async () => {
    if (!job || !eoaQuote || !quotedUrl) return;
    const sendUrl = quotedUrl;
    const changed = await pinnedEndpointProblem(sendUrl);
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      backToMain(null);
      return;
    }
    if (!eoaQuote.simulation.ok) {
      Alert.alert(t('send.back'), t('send.simulation.failed', { reason: eoaQuote.simulation.reason }));
      return;
    }
    if (!(await authorizeJob(job, eoaQuote, sendUrl))) return;
    setPhase('tx-sending');
    try {
      const sent = await signWith(EVM_CHAIN_ID, address, (signer) => sendEvm(sendUrl, signer, eoaQuote, evmChain.explorerTxBase));
      // A setAddress on an existing resolver leaves no other trace a resume
      // could read, so its hash is kept with the record at once.
      let doneJob = job;
      if (job.kind === 'prepare' && job.prepareIndex === 0 && job.record && !job.record.deploysResolver) {
        const updated: PendingHandle = { ...job.record, recordTx: sent.txid };
        await savePendingHandle(AsyncStorage, updated).catch(() => undefined);
        doneJob = { ...job, record: updated };
      }
      const status = await waitForTx(simulationTransport(sendUrl), sent.txid);
      if (status === 'success') await afterStep(doneJob, sent);
      else backToMain(status === 'reverted' ? t('handle.tx.reverted', { hash: sent.txid }) : t('handle.tx.timeout', { hash: sent.txid }));
    } catch (e) {
      const d = describeSendError(e, symbol, symbol);
      Alert.alert(d.title, d.detail);
      backToMain(null);
    }
  };

  const onAaApprove = async () => {
    if (!job || !aaQuote || !bundle || !url) return;
    try {
      await checkAaQuoteBeforeApproval(bundle.bundler, aaQuote);
    } catch (e) {
      const d = describeAaError(e, { accountType: aaQuote.accountType, deployed: aaQuote.deployed }) ?? describeSendError(e, symbol, symbol);
      Alert.alert(d.title, d.detail);
      backToMain(null);
      return;
    }
    if (!(await authorizeJob(job, aaQuote, url))) return;
    setPhase('aa-sending');
    try {
      const { userOpHash } = await signWith(EVM_CHAIN_ID, address, (signer) => sendAa(bundle, signer, aaQuote, { kind: 'handle' }));
      const { summary } = await waitForAaReceipt(bundle, userOpHash, { timeoutMs: 120_000, pollMs: 3_000 });
      if (summary.success === true && summary.txHash) {
        await afterStep(job, { txid: summary.txHash, explorerUrl: evmChain.explorerTxBase ? `${evmChain.explorerTxBase}${summary.txHash}` : null });
      } else {
        backToMain(t('handle.tx.reverted', { hash: summary.txHash ?? userOpHash }));
      }
    } catch (e) {
      const d = describeAaError(e, { accountType: aaQuote.accountType, deployed: aaQuote.deployed }) ?? describeSendError(e, symbol, symbol);
      Alert.alert(d.title, d.detail);
      // A smart-account quote is used once (aa.ts claimQuoteForSubmission).
      backToMain(null);
    }
  };

  const onCheck = async () => {
    setFormError(null);
    const check = checkHandleLabel(labelText);
    if (!check.ok) {
      setFormError(check.text);
      return;
    }
    const owner = ownerKind === 'smart' ? shownSmartAddress : address;
    if (!owner) {
      setFormError(t('handle.owner.smartUnavailable'));
      return;
    }
    // While the registrar is read the main view is replaced by a spinner (so
    // nothing else on it can be tapped meanwhile); a refusal brings the main
    // view back scrolled to the answer (finding 2), and the review opens as
    // its own screen at its top.
    setPhase('checking');
    try {
      const start = await currentEndpoint();
      const q = await quoteHandle(simulationTransport(start.url), { label: check.label, owner, ownerLabel: ownerLabelOf(owner, ownerKind) });
      setQuoted(q);
      setPhase('review');
    } catch (e) {
      pendingAnchor.current = { anchor: 'answer', until: null };
      setFormError(describeHandleError(e, check.name));
      setPhase('main');
    }
  };

  const onPrepare = async () => {
    if (!quoted) return;
    try {
      const { record: rec } = newHandlePlan({ quoted, signer: address, ownerKind });
      // The record (with the secret) is stored BEFORE anything is sent.
      await savePendingHandle(AsyncStorage, rec);
      setQuoted(null);
      setLabelText('');
      reload();
      const next = jobFor(rec, { kind: 'prepare', next: 0, done: 0 });
      if (next) await openJob(next);
    } catch (e) {
      backToMain(describeHandleError(e, quoted.quote.name));
    }
  };

  const onRegisterOrContinue = async () => {
    if (!record || !url) return;
    setNotice(null);
    try {
      const node = simulationTransport(url);
      const p = await readHandleProgress(node, record);
      if (p.kind === 'ready') {
        // Pre-flight before anything is quoted, too: a "too new" answer is a wait.
        const pre = await preflightRegister(node, record);
        if (pre.kind === 'too-new') {
          backToMain(t('handle.card.recheck'));
          return;
        }
        if (pre.kind !== 'ok') {
          backToMain(pre.kind === 'failed' ? t('handle.preflight.failed', { reason: pre.reason }) : pre.kind === 'taken' ? t('handle.card.taken', { name: record.name }) : t('handle.card.expired', { name: record.name }));
          return;
        }
      }
      const next = jobFor(record, p);
      // The pre-flight above passed for a register job (both owners: it is an
      // eth_call of register() from record.owner, the smart account's own
      // address for a smart owner); the review says so (finding 7).
      if (next) await openJob(next.kind === 'register' ? { ...next, preflightOk: true } : next);
      else backToMain(null);
    } catch (e) {
      backToMain(describeHandleError(e, record.name));
    }
  };

  const onForget = () => {
    if (!record) return;
    Alert.alert(t('handle.forget.title'), t('handle.forget.body', { name: record.name, amount: formatUsdc(BigInt(record.total)) }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('handle.forget.confirm'),
        style: 'destructive',
        onPress: () => {
          void forgetPendingHandle(AsyncStorage, record.signer).then(
            () => backToMain(null),
            (e) => backToMain(describeHandleError(e)),
          );
        },
      },
    ]);
  };

  const onReset = () => {
    Alert.alert(t('handle.button.reset'), t('handle.store.reset.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.reset'), style: 'destructive', onPress: () => void resetPendingHandles(AsyncStorage).then(() => backToMain(null), () => backToMain(null)) },
    ]);
  };

  const onRevoke = (owner: string, kind: HandleOwnerKind) => {
    void openJob({
      kind: 'revoke', path: kind === 'smart' ? 'aa' : 'eoa', calls: [revokeRegistrarApprovalCall()],
      lines: [t('handle.revoke.note', { who: owner })], position: null, title: handlePromptTitle('revoke', { name: '' }),
      record: null, prepareIndex: null, name: '', revokeOwner: owner,
    });
  };

  const subPlan = async (): Promise<EnsSubnamePlan | null> => {
    setSubError(null);
    const sub = checkHandleSubLabel(subLabel);
    if (!sub.ok) {
      setSubError(sub.text);
      return null;
    }
    if (!parentName || !shownSmartAddress || !url) {
      setSubError(t('handle.sub.unavailable'));
      return null;
    }
    try {
      return await planHandleSubname(simulationTransport(url), {
        parentLabel: parentName.slice(0, -'.eth'.length),
        subLabel: sub.label,
        owner: address,
        target: shownSmartAddress,
      });
    } catch (e) {
      setSubError(describeHandleError(e, parentName));
      return null;
    }
  };
  const onAddSubname = async () => {
    const plan = await subPlan();
    if (!plan || !shownSmartAddress) return;
    await openJob({
      kind: 'subname', path: 'eoa', calls: plan.step.calls,
      lines: [t('handle.sub.callLine', { sub: plan.name, target: shownSmartAddress, resolver: plan.step.calls[0]!.to })],
      position: null, title: handlePromptTitle('subname', { name: plan.name }), record: null, prepareIndex: null, name: plan.name,
    });
  };
  const onTargetReverse = async () => {
    const plan = await subPlan();
    if (!plan || !plan.targetReverseCall || !shownSmartAddress) return;
    await openJob({
      kind: 'targetReverse', path: 'aa', calls: [plan.targetReverseCall],
      lines: [t('handle.call.setName', { name: plan.name, owner: shownSmartAddress, reverse: ENS_V2_SEPOLIA.v1ReverseRegistrar })],
      position: null, title: handlePromptTitle('targetReverse', { name: plan.name }), record: null, prepareIndex: null, name: plan.name,
    });
  };

  const inputStyle = [styles.input, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.card }];
  const busy = (text: string) => (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={theme.accent} />
      <Text style={[styles.hint, { color: theme.textMuted }]}>{text}</Text>
    </View>
  );
  /** The ENS resolver a job's call lines may name in full (the owner's own resolver, a contract). */
  const jobResolver = (j: Job): string | null => (j.kind === 'subname' ? j.calls[0]!.to : (j.record?.resolver ?? null));
  /** The owner of the name a job is for, so the risk card can name that owner's resolver (finding 5). */
  const jobNameOwner = (j: Job): string | null => (j.record ? j.record.owner : j.kind === 'subname' ? address : null);
  const stepTitle = (j: Job) => (j.kind === 'prepare' ? t('handle.prepare.title') : j.kind === 'register' || j.kind === 'reverse' ? t('handle.register.title') : t('handle.title'));

  // ------------------------------------------------------------- success
  if (phase === 'success' && result) {
    return (
      <ScrollView key="handle-success" style={screenStyle(theme)} contentContainerStyle={styles.content} {...NOTE_VIEW_SCROLL_PROPS}>
        <Text accessibilityRole="header" style={[styles.successTitle, { color: theme.success }]}>{result.title}</Text>
        <Text accessibilityLabel={spokenWithShortAddresses(result.body)} style={[styles.hint, { color: theme.text }]}>{result.body}</Text>
        {/* Spoken as one stop, "Transaction id 0x1234…abcd" (finding 12); the full id stays visible and selectable. */}
        <View accessible accessibilityLabel={spokenTxId(result.txid)}>
          <Text importantForAccessibility="no" accessibilityElementsHidden style={[styles.label, { color: theme.textMuted }]}>{t('send.txId')}</Text>
          <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text selectable importantForAccessibility="no" accessibilityElementsHidden style={[styles.monoText, { color: theme.text }]}>{result.txid}</Text>
          </View>
        </View>
        {result.explorerUrl ? <Button title={t('send.explorer')} variant="secondary" onPress={() => void Linking.openURL(result.explorerUrl!)} /> : null}
        <TransactionNoteField network={caip2} txid={result.txid} userOpHash={null} />
        <Button
          title={t('send.done')}
          onPress={() =>
            dismissKeyboardThenClose(() => {
              const anchor = result.anchor ?? 'card';
              setResult(null);
              backToMain(null, anchor);
            })
          }
        />
      </ScrollView>
    );
  }

  // ------------------------------------------- confirm (regular account)
  if ((phase === 'tx-confirm' || phase === 'tx-sending') && job && eoaQuote) {
    return (
      <ScrollView key="handle-tx-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}>{stepTitle(job)}</Text>
        {job.position ? (
          <Text accessibilityRole="header" style={[styles.label, { color: theme.textMuted }]}>
            {t('handle.tx.heading', { index: job.position.index, count: job.position.count })}
          </Text>
        ) : null}
        <Row label={t('handle.row.owner')} value={activeAccount?.name ?? '—'} sub={address} spoken={`${t('handle.row.owner')}: ${activeAccount?.name ?? ''}, ${spokenShortAddress(address)}`} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        {job.kind === 'prepare' ? <Note text={t('handle.prepare.regularNote', { count: 3 })} theme={theme} /> : null}
        <CallLines lines={job.lines} theme={theme} resolver={jobResolver(job)} />
        {job.kind === 'prepare' && job.prepareIndex === 2 ? <Note text={t('handle.secretNote')} theme={theme} /> : null}
        <Row label={t('send.row.maxFeePaidIn', { symbol })} value={`${exact18(eoaQuote.fee)} ${symbol}`} theme={theme} />
        <BalanceChangePreview
          url={quotedUrl}
          request={{ from: address, to: eoaQuote.to, value: eoaQuote.amount, ...(eoaQuote.data ? { data: eoaQuote.data } : {}) }}
        />
        <RiskWarnings url={quotedUrl} wallet={address} to={eoaQuote.to} data={eoaQuote.data} ensResolverOwner={jobNameOwner(job)} />
        <SpendingPolicyNotice
          owner={address}
          quote={eoaQuote}
          from={address}
          {...(job.kind === 'register' && job.record ? { quoteOutflows: [{ token: HANDLE_USDC.address, amount: BigInt(job.record.total) }] } : {})}
        />
        {eoaQuote.simulation.ok ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}>
            {job.kind === 'register' ? t('handle.preflight.ok') : t('send.simulation.passed')}
          </Text>
        ) : (
          <WarningBox>{t('send.simulation.failed', { reason: eoaQuote.simulation.reason })}</WarningBox>
        )}
        {phase === 'tx-sending' ? (
          busy(t('handle.tx.waiting'))
        ) : (
          <>
            <Button title={t('handle.tx.send')} onPress={() => void onEoaApprove()} disabled={!eoaQuote.simulation.ok} />
            <Button title={t('send.back')} variant="secondary" onPress={() => backToMain(null)} />
          </>
        )}
      </ScrollView>
    );
  }

  // --------------------------------------------- confirm (smart account)
  if ((phase === 'aa-confirm' || phase === 'aa-sending') && job && aaQuote) {
    return (
      <ScrollView key="handle-aa-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}>{stepTitle(job)}</Text>
        <Row label={t('handle.row.owner')} value={aaQuote.sender} mono spoken={`${t('handle.row.owner')}: ${spokenShortAddress(aaQuote.sender)}`} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        {job.kind === 'prepare' ? <Note text={t('handle.prepare.smartNote', { count: job.calls.length })} theme={theme} /> : null}
        <CallLines lines={job.lines} theme={theme} resolver={jobResolver(job)} />
        {job.kind === 'prepare' ? <Note text={t('handle.secretNote')} theme={theme} /> : null}
        <Row label={t('handle.row.feeSmart')} value={aaQuote.sponsored ? '0' : `${exact18(aaQuote.fee)} ${symbol}`} theme={theme} />
        <AaDepositNote fee={aaQuote.fee} deposit={aaQuote.deposit} sponsored={aaQuote.sponsored} symbol={symbol} />
        <BalanceChangePreview
          url={url}
          request={{ from: aaQuote.sender, to: aaQuote.calls[0]!.to, value: aaQuote.calls[0]!.value, data: aaQuote.calls[0]!.data }}
          batch={aaQuote.calls.map((c) => ({ from: aaQuote.sender, to: c.to, value: c.value, data: c.data }))}
        />
        <RiskWarnings url={url} wallet={aaQuote.sender} to={job.calls[0]!.to} data={job.calls[0]!.data} ensResolverOwner={jobNameOwner(job)} />
        <SpendingPolicyNotice
          owner={address}
          quote={aaQuote}
          from={address}
          {...(job.kind === 'register' && job.record ? { quoteOutflows: [{ token: HANDLE_USDC.address, amount: BigInt(job.record.total) }] } : {})}
        />
        {/* The register pre-flight ran from the smart account's address before this review opened (finding 7). */}
        {job.kind === 'register' && job.preflightOk ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}>{t('handle.preflight.ok')}</Text>
        ) : null}
        {phase === 'aa-sending' ? (
          busy(t('handle.tx.waiting'))
        ) : (
          <>
            <Button title={t('handle.tx.send')} onPress={() => void onAaApprove()} />
            <Button title={t('send.back')} variant="secondary" onPress={() => backToMain(null)} />
          </>
        )}
      </ScrollView>
    );
  }

  if (phase === 'quoting' || phase === 'checking') {
    return <View style={[screenStyle(theme), styles.center]}>{busy(t('handle.checking'))}</View>;
  }

  // -------------------------------------------------------------- review
  if (phase === 'review' && quoted) {
    const q = quoted.quote;
    return (
      <ScrollView key="handle-review" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text accessibilityRole="header" style={[styles.stepTitle, { color: theme.text }]}>{t('handle.prepare.title')}</Text>
        <Text style={[styles.notice, { color: theme.text }]}>{t('handle.quote.available', { name: q.name })}</Text>
        <Text style={[styles.hint, { color: theme.text }]}>{t('handle.quote.fee', { amount: formatUsdc(q.total), days: HANDLE_DURATION_DAYS })}</Text>
        <Note
          text={t('handle.quote.balance', { who: ownerLabelOf(q.owner, ownerKind), amount: formatUsdc(quoted.usdcBalance) })}
          spoken={spokenWithShortAddresses(t('handle.quote.balance', { who: ownerLabelOf(q.owner, ownerKind), amount: formatUsdc(quoted.usdcBalance) }))}
          theme={theme}
        />
        <Row label={t('handle.row.owner')} value={q.owner} mono spoken={`${t('handle.row.owner')}: ${spokenShortAddress(q.owner)}`} theme={theme} />
        <Row label={t('handle.row.registrar')} value={ENS_V2_SEPOLIA.ethRegistrar} mono theme={theme} />
        <Row label={t('handle.row.usdc')} value={HANDLE_USDC.address} mono theme={theme} />
        <Note
          text={quoted.resolver.deployed ? t('handle.quote.resolverExists', { resolver: quoted.resolver.address }) : t('handle.quote.resolverNew', { resolver: quoted.resolver.address })}
          theme={theme}
        />
        <Note text={ownerKind === 'smart' ? t('handle.prepare.smartNote', { count: 3 }) : t('handle.prepare.regularNote', { count: 3 })} theme={theme} />
        <Note text={t('handle.secretNote')} theme={theme} />
        <WarningBox>{t('handle.intro.redeploy')}</WarningBox>
        <Button title={t('handle.prepare.button')} onPress={() => void onPrepare()} />
        <Button
          title={t('send.back')}
          variant="secondary"
          onPress={() => {
            setQuoted(null);
            setPhase('main');
          }}
        />
      </ScrollView>
    );
  }

  // ---------------------------------------------------------------- main
  const p = current?.value ?? null;
  const allowanceRows = openAllowances.map((a) => (
    <View key={a.owner} style={styles.choiceRow}>
      <Note
        text={t('handle.allowance', { amount: formatUsdc(a.amount), who: ownerLabelOf(a.owner, a.kind) })}
        spoken={spokenWithShortAddresses(t('handle.allowance', { amount: formatUsdc(a.amount), who: ownerLabelOf(a.owner, a.kind) }))}
        theme={theme}
      />
      <Button title={t('handle.button.revoke')} variant="secondary" onPress={() => onRevoke(a.owner, a.kind)} />
    </View>
  ));
  const labelField = fieldLabel('handle-label', t('handle.label.caption'));
  const subField = fieldLabel('handle-sub', t('handle.sub.caption'));
  const showForm = !record && !pending.damaged;
  const liveText = record ? handleCardLiveText(p, record.name) : null;

  return (
    <ScrollView
      key="handle-main"
      ref={mainScroll}
      onScrollBeginDrag={() => {
        pendingAnchor.current = null;
      }}
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
      <ImportedKeyNotice show={activeAccount?.imported === true} />
      <Text style={[styles.hint, { color: theme.text }]}>{t('handle.intro')}</Text>
      <Note text={t('handle.intro.public')} theme={theme} />
      <Note text={t('handle.intro.term', { days: HANDLE_DURATION_DAYS, grace: HANDLE_GRACE_DAYS })} theme={theme} />
      <Note text={t('handle.intro.fee', { symbol })} theme={theme} />
      <Note text={t('handle.intro.steps')} theme={theme} />
      <WarningBox>{t('handle.intro.redeploy')}</WarningBox>
      {notice ? (
        <Text accessibilityLiveRegion="polite" onLayout={(e) => onAnchorLayout('notice', e.nativeEvent.layout.y)} style={[styles.notice, { color: theme.accent }]}>
          {notice}
        </Text>
      ) : null}

      {pending.damaged ? (
        <>
          <WarningBox>{t('handle.store.damaged')}</WarningBox>
          <Button title={t('handle.button.reset')} variant="destructive" onPress={onReset} />
        </>
      ) : null}

      {record ? (
        <View onLayout={(e) => onAnchorLayout('card', e.nativeEvent.layout.y)} style={[handleStyles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text accessibilityRole="header" style={[handleStyles.cardTitle, { color: theme.text }]}>{t('handle.card.title')}</Text>
          <Row label={t('handle.row.owner')} value={record.owner} mono spoken={`${t('handle.row.owner')}: ${spokenShortAddress(record.owner)}`} theme={theme} />
          {!url ? <WarningBox>{t('handle.refusal.noBlock')}</WarningBox> : null}
          {current?.error ? <WarningBox>{t('handle.refusal.other', { detail: current.error })}</WarningBox> : null}
          {url && !current ? <ActivityIndicator color={theme.accent} /> : null}
          {p?.kind === 'prepare' ? (
            <>
              <Text style={[styles.hint, { color: theme.text }]}>{t('handle.card.preparing', { name: record.name, done: p.done })}</Text>
              <Button title={t('handle.button.continue')} onPress={() => void onRegisterOrContinue()} />
            </>
          ) : null}
          {/* The card's one polite live region (finding 11): the same sentence
              for the whole wait, changing once to "… can be registered now";
              the countdown below it is a plain Text, so it is not
              re-announced on every 12-second block step. */}
          {liveText !== null ? (
            <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.text }]}>
              {liveText}
            </Text>
          ) : null}
          {p?.kind === 'wait' ? (
            <>
              <Text style={[styles.hint, { color: theme.text }]}>{waitingSentence(record.name, p.readiness)}</Text>
              <Note text={t('handle.card.waitingNote', { margin: HANDLE_READY_MARGIN_SECONDS.toString() })} theme={theme} />
            </>
          ) : null}
          {p?.kind === 'ready' ? <Button title={t('handle.button.register')} onPress={() => void onRegisterOrContinue()} /> : null}
          {p?.kind === 'reverse' ? (
            <>
              <Text
                accessibilityLabel={spokenWithShortAddresses(t('handle.card.reverse', { name: record.name, owner: record.owner }))}
                style={[styles.hint, { color: theme.text }]}
              >
                {t('handle.card.reverse', { name: record.name, owner: record.owner })}
              </Text>
              <Button title={t('handle.button.reverse')} onPress={() => void onRegisterOrContinue()} />
            </>
          ) : null}
          {p?.kind === 'done' ? (
            <Text
              accessibilityLabel={spokenWithShortAddresses(t('handle.card.done', { name: record.name, owner: record.owner }))}
              style={[styles.hint, { color: theme.text }]}
            >
              {t('handle.card.done', { name: record.name, owner: record.owner })}
            </Text>
          ) : null}
          {p?.kind === 'expired' ? <WarningBox>{t('handle.card.expired', { name: record.name })}</WarningBox> : null}
          {p?.kind === 'taken' ? <WarningBox>{t('handle.card.taken', { name: record.name })}</WarningBox> : null}
          <Button title={t('handle.button.check')} variant="secondary" onPress={reload} />
          {p?.kind === 'done' ? (
            <Button
              title={t('send.done')}
              onPress={() => {
                void refreshPrimaryNameUntil(primaryNames, caip2, record.owner, record.name);
                void forgetPendingHandle(AsyncStorage, record.signer).then(() => backToMain(null, 'sub'), () => backToMain(null, 'sub'));
              }}
            />
          ) : (
            <Button title={t('handle.button.forget')} variant="destructive" onPress={onForget} />
          )}
        </View>
      ) : null}

      {!record || p?.kind === 'expired' || p?.kind === 'taken' ? allowanceRows : null}

      {showForm ? (
        <>
          {bundle && shownSmartAddress ? (
            <>
              <Text accessibilityRole="header" style={[styles.label, { color: theme.textMuted }]}>{t('handle.owner.heading')}</Text>
              <View style={styles.choiceRow}>
                {(['regular', 'smart'] as const).map((k) => (
                  <Button
                    key={k}
                    title={`${ownerKind === k ? '✓ ' : ''}${k === 'regular' ? t('handle.owner.regular') : t('receive.smart.label')}`}
                    variant={ownerKind === k ? 'primary' : 'secondary'}
                    selected={ownerKind === k}
                    style={styles.choiceButton}
                    onPress={() => setOwnerKind(k)}
                  />
                ))}
              </View>
              {ownerKind === 'smart' ? <Note text={t('handle.owner.smartNote')} theme={theme} /> : null}
            </>
          ) : smartRefusal && aaConfig ? (
            <Note text={smartRefusal} theme={theme} />
          ) : null}
          <Text {...labelField.label} style={[styles.label, { color: theme.textMuted }]}>{labelField.text}</Text>
          <TextInput
            {...labelField.input}
            style={inputStyle}
            value={labelText}
            onChangeText={setLabelText}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('handle.label.placeholder')}
            placeholderTextColor={theme.textMuted}
          />
          {formError ? (
            <View onLayout={(e) => onAnchorLayout('answer', e.nativeEvent.layout.y)}>
              <WarningBox announce>{formError}</WarningBox>
            </View>
          ) : null}
          <Button title={t('handle.check')} onPress={() => void onCheck()} disabled={!url} />
        </>
      ) : null}

      {/* The smart account's record-only sub-name, under a name the regular account holds. */}
      {parentName && (!record || p?.kind === 'done') ? (
        <View onLayout={(e) => onAnchorLayout('sub', e.nativeEvent.layout.y)} style={[handleStyles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text accessibilityRole="header" style={[handleStyles.cardTitle, { color: theme.text }]}>{t('handle.sub.heading')}</Text>
          {bundle && shownSmartAddress ? (
            <>
              <Note
                text={t('handle.sub.intro', { sub: `${subLabel.trim() || HANDLE_SUB_LABEL_DEFAULT}.${parentName}`, target: shownSmartAddress, name: parentName })}
                spoken={spokenWithShortAddresses(t('handle.sub.intro', { sub: `${subLabel.trim() || HANDLE_SUB_LABEL_DEFAULT}.${parentName}`, target: shownSmartAddress, name: parentName }))}
                theme={theme}
              />
              {smartPrimary?.status === 'ok' ? <Note text={t('handle.primary.ok', { name: smartPrimary.name })} theme={theme} /> : null}
              <Text {...subField.label} style={[styles.label, { color: theme.textMuted }]}>{subField.text}</Text>
              <TextInput
                {...subField.input}
                style={inputStyle}
                value={subLabel}
                onChangeText={setSubLabel}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t('handle.sub.placeholder')}
                placeholderTextColor={theme.textMuted}
              />
              {subError ? <WarningBox announce>{subError}</WarningBox> : null}
              {subName && subPoints?.kind === 'points' ? (
                // Finding 10: nothing to add when the record already points here.
                <Note text={t('handle.sub.already', { sub: subName })} theme={theme} />
              ) : (
                <>
                  {subName && subPoints?.kind === 'elsewhere' ? (
                    <Note
                      text={t('handle.sub.elsewhere', { sub: subName, address: subPoints.address })}
                      spoken={spokenWithShortAddresses(t('handle.sub.elsewhere', { sub: subName, address: subPoints.address }))}
                      theme={theme}
                    />
                  ) : null}
                  <Button title={t('handle.sub.button')} onPress={() => void onAddSubname()} />
                </>
              )}
              <Note
                text={t('handle.sub.reverseNote', { sub: `${subLabel.trim() || HANDLE_SUB_LABEL_DEFAULT}.${parentName}`, target: shownSmartAddress })}
                spoken={spokenWithShortAddresses(t('handle.sub.reverseNote', { sub: `${subLabel.trim() || HANDLE_SUB_LABEL_DEFAULT}.${parentName}`, target: shownSmartAddress }))}
                theme={theme}
              />
              <Button title={t('handle.sub.reverseButton')} variant="secondary" onPress={() => void onTargetReverse()} />
            </>
          ) : (
            <Note text={t('handle.sub.unavailable')} theme={theme} />
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}

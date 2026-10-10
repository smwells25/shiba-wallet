import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import {
  SUBSCRIPTION_NATIVE,
  httpTransport,
  describePeriod,
  parseSessionKeyGrant,
  subscriptionPeriodCount,
  toHex,
  type JsonRpcTransport,
  type KernelPermissionInstall,
  type SessionKeyGrant,
  type SubscriptionGrant,
} from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, ImportedKeyNotice, screenStyle, TestNetworksOnlyCard, WarningBox } from '../components';
import { ContactPicker, RecipientContactNotice } from '../components/Contacts';
import { GrantReview } from '../components/SessionGrantViews';
import { PayloadQr } from '../components/RecoveryViews';
import { SubscriptionKeyHandoverActions } from '../components/SubscriptionKeyHandover';
import { activeEvmNodeRunner, useClockTick, useOnAppActive } from '../components/RecurringDueBanner';
import { useTheme, type Theme } from '../theme';
import { getEndpoint, withEndpoint } from '../config/networks';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits, parseUnits } from '../wallet/balances';
import { EVM_CHAIN_ID, describeSendError } from '../wallet/send';
import {
  checkAaQuoteBeforeApproval,
  createAaClientFromConfig,
  getAaConfig,
  sendAa,
  summarizeAaReceipt,
  type AaClientBundle,
  type AaSendQuote,
} from '../wallet/aa';
import { AaDepositNote } from '../components/AaDepositNote';
import { findExactContact, listContacts, matchRecipient, type Contact } from '../wallet/contacts';
import { sessionKeyVault } from '../wallet/storage';
import { readinessGate } from '../config/readiness';
import {
  SESSIONS_AUDIT_NOTE,
  SESSIONS_INSTALL_MODE_NOTE,
  SESSIONS_WIPE_WARNING,
  SESSION_EXPIRY_PRESETS,
  buildManualGrant,
  describeSessionError,
  finalizeSessionInstall,
  finalizeSessionRevoke,
  forgetSession,
  installSession,
  isNodeEndpointFailure,
  isTransportFailure,
  loadSessionsFor,
  newSessionKey,
  pendingSessionOperation,
  prepareSessionInstall,
  prepareSessionRevoke,
  readSessionStatus,
  resetSessions,
  resolveSessionAccount,
  revokeSession,
  sendSessionCalls,
  sessionCanBeTested,
  sessionLocalStatusText,
  sessionProgressTitle,
  sessionRecordKey,
  sessionRevokeKeySentence,
  sessionStatusText,
  sessionTestCall,
  sessionTransportFor,
  revokeApprovalPrompt,
  revokeConfirmCopy,
  sessionCarriesTerms,
  unknownStatusFrom,
  validateGrantForAccount,
  type AllowedCallDraft,
  type SessionAccountResolution,
  type SessionChainStatus,
  type SessionProgressKind,
  type SessionRecord,
} from '../wallet/sessions';
import {
  SUBSCRIPTION_AUDIT_NOTE,
  SUBSCRIPTION_KEY_HOLDER_TEXT,
  SUBSCRIPTION_KEY_WARNING,
  SUBSCRIPTION_EXPIRED_UNHANDED_TEXT,
  SUBSCRIPTION_MAX_PAYMENTS,
  SUBSCRIPTION_PERIOD_PRESETS,
  SUBSCRIPTION_PERIOD_UNITS,
  SUBSCRIPTION_MAX_PERIOD_SECONDS,
  SUBSCRIPTION_REQUOTE_FEE_TOLERANCE_PERCENT,
  SUBSCRIPTION_REQUOTE_MESSAGE,
  SUBSCRIPTION_REQUOTE_TITLE,
  SUBSCRIPTION_START_NOTE,
  buildSubscription,
  buildSubscriptionKeyExport,
  customPeriodSeconds,
  cardShowsBatchingWarning,
  feeBudgetCapNote,
  feeBudgetPricingNote,
  feeBudgetSuggestionHint,
  fitFeeBudgetToInstall,
  type SubscriptionFeeSource,
  markSubscriptionKeyExported,
  readSubscriptionFeeFacts,
  readSubscriptionStatus,
  restartSubscriptionAt,
  sortSubscriptionRecords,
  subscriptionDisplayTitle,
  subscriptionFinalDatesLine,
  subscriptionGrantFor,
  subscriptionHandoverOffer,
  subscriptionInstallFeeCeiling,
  subscriptionInstallFunding,
  subscriptionKeyFileName,
  subscriptionKeyStatusText,
  subscriptionMeta,
  subscriptionNames,
  subscriptionMinPeriodSeconds,
  subscriptionPeriodPresets,
  subscriptionRequoteNeedsReview,
  subscriptionReview,
  subscriptionShortWindowWarning,
  subscriptionStatusLines,
  subscriptionSummary,
  subscriptionTokenChoices,
  loadSubscriptionTokenChoices,
  suggestedFeeBudget,
  termsOf,
  withSubscriptionFeeCeiling,
  type SubscriptionStatus,
  type SubscriptionTokenChoice,
} from '../wallet/subscriptions';
import {
  RECURRING_AUDIT_NOTE,
  RECURRING_CARD_NOTE,
  RECURRING_COMPLETED_TEXT,
  RECURRING_FORM_INTRO,
  RECURRING_KEY_HOLDER_TEXT,
  RECURRING_LATER_SLICE_NOTE,
  RECURRING_PAY_PROMPT_NOTE,
  RECURRING_SPENDING_NOTE,
  RECURRING_START_NOTE,
  RECURRING_WHILE_OPEN_NOTE,
  describeRecurringPaymentError,
  isRecurringNodeFailure,
  payRecurringPayment,
  planRecurringPayment,
  runRecurringPayment,
  recurringConfirmMessage,
  recurringDueHeadline,
  recurringAttemptLine,
  recurringDueState,
  recurringEndsAt,
  recurringFeeBudgetHint,
  recurringFinalDatesLine,
  recurringGrantFor,
  recurringKeyStatusText,
  recurringMeta,
  recurringNames,
  recurringReview,
  recurringShortWindowWarning,
  recurringStatusLines,
  recurringSummary,
  readStatusWithFailover,
  type RecurringPaymentPlan,
} from '../wallet/recurring';

type Props = NativeStackScreenProps<RootStackParamList, 'Sessions'>;

type Phase =
  | 'list'
  | 'form'
  | 'quoting'
  | 'confirm'
  | 'sending'
  | 'revoke-confirm'
  | 'progress'
  | 'sub-form'
  | 'sub-quoting'
  | 'sub-confirm'
  | 'sub-sending'
  | 'key-export';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** The native amount typed into the subscription form, in wei (0 when it does not parse). */
function safeParseNative(text: string): bigint {
  try {
    return parseUnits(text.trim(), 18);
  } catch {
    return 0n;
  }
}
const EMPTY_DRAFT: AllowedCallDraft = { target: '', selector: '', valueCapEth: '' };

interface PendingInstall {
  /** In memory only until the install is submitted (then in the vault) or discarded (zeroed). */
  privateKey: Uint8Array;
  grant: SessionKeyGrant;
  install: KernelPermissionInstall;
  quote: AaSendQuote;
  /**
   * The bundle the quote was made through (its node may differ from the
   * screen's after an endpoint failover); the install is sent through it.
   */
  bundle: AaClientBundle;
}

/** A reviewed subscription waiting for the owner's approval (same lifetime rules as PendingInstall). */
interface PendingSubscription extends PendingInstall {
  subscription: SubscriptionGrant;
  choice: SubscriptionTokenChoice;
  /** The list card's title ("Subscription: <name>" or "Subscription to 0x…"; "Recurring payment …" for a recurring payment). */
  recordLabel: string;
  /** A merchant-pulled subscription, or a recurring payment this phone sends (same grant template). */
  mode: 'subscription' | 'recurring';
  /**
   * Set when Review lowered the unedited fee-budget pre-fill so that the
   * install's own worst-case fee is kept back (wei).
   */
  feeBudgetLowered?: { from: bigint; to: bigint; keptBack: bigint } | null;
  /**
   * What the fee budget was priced at when Review ran (readSubscriptionFeeFacts):
   * the fee the payments will be signed at, or the node's fee as a labelled
   * fallback; `edited` when the user typed the budget.
   */
  feePricing: { maxFeePerGas: bigint | null; source: SubscriptionFeeSource | null; edited: boolean };
}

interface SubscriptionFormState {
  merchant: string;
  choiceIndex: number;
  amount: string;
  /** The chosen preset period (used while periodCustom is false). */
  periodSeconds: number;
  /** True when the custom period field (a number of minutes, hours or days) is used. */
  periodCustom: boolean;
  customCount: string;
  /** One of SUBSCRIPTION_PERIOD_UNITS' seconds. */
  customUnit: number;
  payments: string;
  feeBudget: string;
  /**
   * True once the user typed a fee budget. Until then the field shows the
   * suggestion for the CURRENT payment count and period (suggestedFeeBudget),
   * so changing the number of payments changes the budget too.
   */
  feeEdited: boolean;
  label: string;
}

const EMPTY_SUBSCRIPTION_FORM: SubscriptionFormState = {
  merchant: '',
  choiceIndex: 0,
  amount: '',
  periodSeconds: SUBSCRIPTION_PERIOD_PRESETS[0]!.seconds,
  periodCustom: false,
  customCount: '',
  customUnit: 86400,
  payments: '3',
  feeBudget: '',
  feeEdited: false,
  label: '',
};

interface Progress {
  kind: SessionProgressKind;
  /** Subscriptions: the final dates the install carries (subscriptionFinalDatesLine). */
  finalTerms?: string | null;
  userOpHash: string;
  state: 'pending' | 'done' | 'failed' | 'timeout';
  txHash: string | null;
  detail: string | null;
}

/**
 * Sessions (phase 8 item 2, app half): grant, test and revoke session keys
 * on the active account's Kernel account (a deployed Kernel v3.3 smart
 * account, or the EOA upgraded to Kernel v3.3 with EIP-7702) on the active
 * EVM chain. See ../wallet/sessions.ts for the storage and signing rules:
 * session private keys live only in expo-secure-store; the install and the
 * revocation are ordinary root-signed smart-account operations through the
 * normal confirm idioms (bundler estimate gate, network badge, fee,
 * biometric gate, signWith with expectAddress = the owner EOA); a session
 * operation is signed by the session key alone and never touches the owner
 * key.
 */
export function SessionsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, activeAccount, signWith } = useWallet();
  const { evmChain } = usePrefs();
  const owner = accounts.find((a) => a.chainId === EVM_CHAIN_ID)?.address ?? null;
  const symbol = evmChain.displaySymbol;
  // Mainnet readiness (config/readiness.ts): session keys are test-network
  // only. Status reads, revoking and forgetting stay available; sessions.ts
  // refuses granting and using a session too.
  const readiness = readinessGate('session-keys', evmChain.caip2);

  const [bundle, setBundle] = useState<AaClientBundle | null>(null);
  const [resolution, setResolution] = useState<SessionAccountResolution | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [listFlags, setListFlags] = useState<{ corrupt: boolean; unreadable: boolean }>({ corrupt: false, unreadable: false });
  const [statuses, setStatuses] = useState<Record<string, SessionChainStatus | 'loading'>>({});
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsNetworkId, setContactsNetworkId] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('list');
  const [drafts, setDrafts] = useState<AllowedCallDraft[]>([{ ...EMPTY_DRAFT }]);
  const [expirySeconds, setExpirySeconds] = useState(SESSION_EXPIRY_PRESETS[1]!.seconds);
  const [gasBudgetEth, setGasBudgetEth] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const pending = useRef<PendingInstall | null>(null);
  const [pendingView, setPendingView] = useState<PendingInstall | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{
    record: SessionRecord;
    quote: AaSendQuote;
    bundle: AaClientBundle;
    /** "Revoke and forget" of a completed recurring payment: forgotten once the revocation is read back. */
    forgetAfter?: boolean;
  } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [subForm, setSubForm] = useState<SubscriptionFormState>(EMPTY_SUBSCRIPTION_FORM);
  const [subPickerOpen, setSubPickerOpen] = useState(false);
  const subPending = useRef<PendingSubscription | null>(null);
  const [subPendingView, setSubPendingView] = useState<PendingSubscription | null>(null);
  const [subStatuses, setSubStatuses] = useState<Record<string, SubscriptionStatus | 'loading'>>({});
  /** Which grant the subscription form builds: a merchant-pulled subscription, or a recurring payment this phone sends. */
  const [subMode, setSubMode] = useState<'subscription' | 'recurring'>('subscription');
  /** The last refused payment attempt per recurring card (plain sentence; the card stays). */
  const [payRefusals, setPayRefusals] = useState<Record<string, string>>({});
  /** The recurring card whose payment is being checked or sent (its buttons are disabled meanwhile). */
  const [payingKey, setPayingKey] = useState<string | null>(null);
  /**
   * Facts for the fee-budget suggestion (null until read): the fee the
   * payments will be signed at (the bundler's floor plus headroom; the node's
   * fee only as a labelled fallback), the Kernel account's balance and its
   * EntryPoint deposit.
   */
  // The part of the install's worst-case fee the balance pays, from the last
  // review quote (null before the first review): the fee-budget pre-fill
  // keeps it back.
  const [subInstallKeepBack, setSubInstallKeepBack] = useState<bigint | null>(null);
  const [subFeeFacts, setSubFeeFacts] = useState<{
    maxFeePerGas: bigint | null;
    feeSource: SubscriptionFeeSource | null;
    balance: bigint | null;
    deposit: bigint | null;
  }>({
    maxFeePerGas: null,
    feeSource: null,
    balance: null,
    deposit: null,
  });
  /** What the subscription confirm's spinner is doing: re-quoting with the restarted clock, or signing. */
  const [subSendStage, setSubSendStage] = useState<'requote' | 'signing'>('signing');
  /** The key hand-over payload: in memory only while the export screen is open. */
  const [keyExport, setKeyExport] = useState<{ record: SessionRecord; text: string; fileName: string } | null>(null);
  // Native, the chain's known tokens, then the user's tracked tokens on the
  // same chain (loaded asynchronously; the synchronous list is its prefix,
  // so a choice made before the load completes keeps its meaning).
  const baseTokenChoices = useMemo(() => subscriptionTokenChoices(evmChain.caip2, symbol), [evmChain.caip2, symbol]);
  const tokenChoicesKey = `${evmChain.caip2}|${symbol}`;
  const [loadedTokenChoices, setLoadedTokenChoices] = useState<{ key: string; list: SubscriptionTokenChoice[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadSubscriptionTokenChoices(evmChain.caip2, symbol).then(
      (list) => {
        if (!cancelled) setLoadedTokenChoices({ key: tokenChoicesKey, list });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [evmChain.caip2, symbol, tokenChoicesKey]);
  const tokenChoices =
    loadedTokenChoices && loadedTokenChoices.key === tokenChoicesKey ? loadedTokenChoices.list : baseTokenChoices;

  // The subscription key on screen must not end up in screenshots or the
  // app switcher (same guard as the recovery-phrase screens).
  useEffect(() => {
    if (phase !== 'key-export') return undefined;
    preventScreenCaptureAsync('subscription-key').catch(() => {});
    return () => {
      allowScreenCaptureAsync('subscription-key').catch(() => {});
    };
  }, [phase]);

  useEffect(() => {
    navigation.setOptions({ title: 'Sessions' });
  }, [navigation]);

  /** Zeroes and drops an unsubmitted session key. */
  const discardPending = useCallback(() => {
    pending.current?.privateKey.fill(0);
    pending.current = null;
    setPendingView(null);
    subPending.current?.privateKey.fill(0);
    subPending.current = null;
    setSubPendingView(null);
  }, []);
  useEffect(() => discardPending, [discardPending]);

  const account = resolution?.ok ? resolution.account : null;

  // Resolve the active account's Kernel account through the AA bundle.
  // State is set only from promise callbacks (never synchronously in the
  // effect), per the react-hooks lint rules this app follows.
  const setup = useCallback(() => {
    if (!owner || !activeAccount) return;
    loadSessionContext(owner, activeAccount.index, evmChain.caip2, BigInt(evmChain.chainIdDecimal)).then(
      (ctx) => {
        setSetupError(null);
        setContactsNetworkId(ctx.contactsNetworkId);
        setBundle(ctx.bundle);
        setResolution(ctx.resolution);
      },
      (e: unknown) => {
        // An endpoint that did not answer is described in plain words with
        // the sanitized detail, never as a raw platform exception.
        const { title, detail } = describeSessionError(e, { accountType: 'kernel-v3.3', symbol: '', stage: 'quote' }, (err) => ({
          title: err instanceof Error ? err.message : String(err),
          detail: '',
        }));
        setSetupError(detail ? `${title}\n${detail}` : title);
      },
    );
  }, [owner, activeAccount, evmChain.caip2, evmChain.chainIdDecimal]);
  useEffect(setup, [setup]);

  // Operations this screen instance is already waiting for (its own sends,
  // and ones resumed from the stored list below), by userOpHash.
  const waitingFor = useRef(new Set<string>());
  const reloadRef = useRef<() => void>(() => undefined);
  /**
   * Runs a status read on the RPC endpoint in use now, under the endpoint
   * failover rule (networks.ts withEndpoint, through recurring.ts
   * readStatusWithFailover): a read that came back 'unknown' because a
   * default endpoint did not answer is repeated once on the next healthy
   * default (the other screens' rule; bug 4 of the 2026-10-04 emulator run).
   * Without any resolvable endpoint the read goes through the screen's
   * bundle, as before.
   */
  const readWithFailover = useCallback(
    async <S extends { kind: string; endpointFailure?: boolean }>(read: (node: JsonRpcTransport) => Promise<S>): Promise<S> => {
      try {
        return await readStatusWithFailover(activeEvmNodeRunner, read);
      } catch (e) {
        if (bundle) return read(bundle.node);
        throw e;
      }
    },
    [bundle],
  );
  /** Re-reads one record's on-chain status (and its subscription counters), and resumes an unsettled operation. */
  const refreshRecord = useCallback(
    (r: SessionRecord) => {
      if (!bundle) return;
      const key = sessionRecordKey(r.chain, r.account, r.permissionId);
      setStatuses((prev) => ({ ...prev, [key]: 'loading' }));
      void readWithFailover((node) => readSessionStatus(node, r))
        .catch((e: unknown) => unknownStatusFrom(e))
        .then((st) => setStatuses((prev) => ({ ...prev, [key]: st })));
      if (sessionCarriesTerms(r.source) && r.subscription) {
        setSubStatuses((prev) => ({ ...prev, [key]: 'loading' }));
        void readWithFailover((node) => readSubscriptionStatus(node, r))
          .catch((e: unknown): SubscriptionStatus => unknownStatusFrom(e))
          .then((st) => setSubStatuses((prev) => ({ ...prev, [key]: st })));
      }
      // An install or revocation that was sent but never settled — the
      // screen that sent it was closed or remounted while it waited (the
      // phase 10 emulator run lost the install's success screen that way) —
      // is resumed from the stored record, so its hash and outcome are never
      // lost.
      const op = pendingSessionOperation(r);
      if (op && !waitingFor.current.has(op.userOpHash)) {
        waitingFor.current.add(op.userOpHash);
        const settle = op.kind === 'install' ? finalizeSessionInstall : finalizeSessionRevoke;
        void settle(bundle, r, AsyncStorage).then(
          () => reloadRef.current(),
          // Not included yet (or unreadable): "Refresh status" tries again.
          () => waitingFor.current.delete(op.userOpHash),
        );
      }
    },
    [bundle, readWithFailover],
  );
  const reloadList = useCallback(() => {
    if (!account) return;
    loadSessionsFor(evmChain.caip2, account).then(
      (load) => {
        setRecords(load.records);
        setListFlags({ corrupt: load.corrupt, unreadable: load.unreadable });
        for (const r of load.records) refreshRecord(r);
      },
      () => setListFlags({ corrupt: true, unreadable: true }),
    );
  }, [account, evmChain.caip2, refreshRecord]);
  useEffect(() => {
    reloadRef.current = reloadList;
  }, [reloadList]);
  // Loads on mount and again every time the screen comes back into focus
  // (finding 5 of the rehearsal: counts stayed stale until a manual refresh).
  useFocusEffect(reloadList);
  // Finding 2 of the 2026-10-09 recurring-payments rehearsal: after the app
  // came back (and was unlocked) the card still said "Payment due now (since
  // 01:55)" until Refresh, because the screen kept its focus and the due
  // state was worked out only when it rendered. Now, while this screen is
  // focused, the due state is re-evaluated every 30 seconds from the facts
  // already read (useClockTick: local arithmetic only, no network), and a
  // return to the foreground re-reads every record (a full read, like focus
  // and Refresh status) and refreshes the clock.
  const isFocused = useIsFocused();
  useOnAppActive(reloadList, isFocused);
  const nowTick = useClockTick(30_000, isFocused);

  useEffect(() => {
    if (!contactsNetworkId) return;
    listContacts(contactsNetworkId).then(setContacts, () => setContacts([]));
  }, [contactsNetworkId]);
  const nameFor = useCallback(
    (address: string) => (contactsNetworkId ? (findExactContact(contactsNetworkId, address, contacts)?.name ?? null) : null),
    [contacts, contactsNetworkId],
  );

  /** Plain-language error for this screen's steps (sessions.ts describeSessionError). */
  const describe = useCallback(
    (e: unknown, stage: 'quote' | 'send') =>
      describeSessionError(e, { accountType: bundle?.accountType ?? 'kernel-v3.3', symbol, stage }, describeSendError),
    [bundle, symbol],
  );

  /**
   * Runs a quote on a bundle built for the RPC endpoint in use NOW, under
   * the endpoint failover rule (networks.ts withEndpoint): when the node of
   * a default endpoint does not answer, the quote is repeated once on the
   * next healthy default. Only node failures move it (a bundler that does
   * not answer is not a reason to change the RPC endpoint). The bundle is
   * returned with the result: the operation is later sent through the same
   * bundle it was quoted on. A recurring payment's send runs through it too
   * (onPayNow): its node requests all precede the submission.
   */
  const quoteOnNode = useCallback(
    async <T,>(op: (b: AaClientBundle) => Promise<T>): Promise<{ value: T; bundle: AaClientBundle }> => {
      if (!owner || !activeAccount) throw new Error('No Ethereum address for this account.');
      const config = await getAaConfig(evmChain.caip2);
      const outcome = await withEndpoint(
        EVM_CHAIN_ID,
        async (endpoint) => {
          const b = createAaClientFromConfig(config, {
            nodeUrl: endpoint.url,
            chainId: BigInt(evmChain.chainIdDecimal),
            accountIndex: activeAccount.index,
            ownerAddress: owner,
            transportFor: sessionTransportFor(endpoint.url, httpTransport, {
              paymasterUrl: config.paymasterUrl,
              plainHttp: true,
            }),
          });
          return { value: await op(b), bundle: b };
        },
        { isFailure: isNodeEndpointFailure },
      );
      return outcome.value;
    },
    [owner, activeAccount, evmChain.caip2, evmChain.chainIdDecimal],
  );

  /**
   * Reads the subscription form's fee facts (the fee the payments will be
   * signed at, Kernel balance and EntryPoint deposit) from the endpoint in
   * use now, failing over once when a default endpoint did not answer. The
   * fee is priced exactly as the payments are (sessions.ts sendSessionCalls:
   * the node's suggestion raised to the bundler's floor plus headroom), so
   * the screen's bundler is passed; without one the node's fee is used and
   * labelled. Returns null when nothing could be read.
   */
  const refreshSubFeeFacts = useCallback(async () => {
    if (!account) return null;
    const bundler = bundle?.bundler ?? null;
    try {
      const { value } = await withEndpoint(
        EVM_CHAIN_ID,
        async (endpoint) => {
          const facts = await readSubscriptionFeeFacts(httpTransport(endpoint.url), account, { bundler });
          const unreachable = facts.failures.find((f) => isTransportFailure(f));
          if (unreachable && facts.maxFeePerGas === null && facts.balance === null) throw unreachable;
          return facts;
        },
        // Also Expo's "fetch failed: …" errors (sessions.ts isTransportFailure).
        { isFailure: isTransportFailure },
      );
      const facts = {
        maxFeePerGas: value.maxFeePerGas,
        feeSource: value.feeSource,
        balance: value.balance,
        deposit: value.deposit,
      };
      setSubFeeFacts(facts);
      return facts;
    } catch {
      return null;
    }
  }, [account, bundle]);

  // Finding 2 of the 2026-10-04 emulator run: the fee facts are read when
  // the subscription form opens AND every time it comes back into focus
  // (for example after funding the account from the Send screen), not once.
  useFocusEffect(
    useCallback(() => {
      if (phase === 'sub-form') void refreshSubFeeFacts();
    }, [phase, refreshSubFeeFacts]),
  );

  // ------------------------------------------------------------ actions

  const onReview = async () => {
    if (!bundle || !account || !owner) return;
    setFormError(null);
    discardPending();
    const key = newSessionKey();
    let grant: SessionKeyGrant;
    const now = Math.floor(Date.now() / 1000);
    try {
      grant = buildManualGrant({ sessionKey: key.address, drafts, expirySeconds, gasBudgetEth, now });
    } catch (e) {
      key.privateKey.fill(0);
      setFormError(e instanceof Error ? e.message : String(e));
      return;
    }
    // The engine's refusal (self-calls, wildcard targets, duplicates, the
    // window) is shown verbatim.
    const refusal = validateGrantForAccount(grant, account, now);
    if (refusal) {
      key.privateKey.fill(0);
      setFormError(refusal);
      return;
    }
    setPhase('quoting');
    try {
      const {
        value: { install, quote },
        bundle: quotedOn,
      } = await quoteOnNode((b) => prepareSessionInstall(b, owner, account, grant, { now }));
      pending.current = { privateKey: key.privateKey, grant, install, quote, bundle: quotedOn };
      setPendingView(pending.current);
      setPhase('confirm');
    } catch (e) {
      key.privateKey.fill(0);
      const { title, detail } = describe(e, 'quote');
      setFormError(`${title}\n${detail}`);
      setPhase('form');
    }
  };

  const onInstall = async () => {
    const p = pending.current;
    if (!p || !account || !owner || !resolution?.ok || !activeAccount) return;
    const sendBundle = p.bundle;
    // The bundler's fee floor, BEFORE the device check (aa.ts
    // checkAaQuoteBeforeApproval): when it rose above the reviewed fees, back
    // to the form, where Review creates a fresh key and quote; nothing was
    // approved or stored.
    try {
      await checkAaQuoteBeforeApproval(sendBundle.bundler, p.quote);
    } catch (e) {
      const { title, detail } = describe(e, 'send');
      Alert.alert(title, detail);
      discardPending();
      setPhase('form');
      return;
    }
    const auth = await requireLocalAuth('Approve granting this session');
    if (!auth.ok) {
      Alert.alert('Not granted', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const { record, userOpHash } = await installSession({
        quote: p.quote,
        install: p.install,
        grant: p.grant,
        chain: evmChain.caip2,
        account,
        owner,
        accountIndex: activeAccount.index,
        accountKind: resolution.kind,
        label: 'Manual',
        source: 'manual',
        sessionPrivateKey: p.privateKey,
        store: AsyncStorage,
        vault: sessionKeyVault,
        // The OWNER key signs the install (root validator), only for the
        // owner EOA the quote was prepared for.
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(sendBundle, signer, q)),
      });
      discardPending();
      waitingFor.current.add(userOpHash);
      setProgress({ kind: 'install', userOpHash, state: 'pending', txHash: null, detail: null });
      setPhase('progress');
      void finalizeSessionInstall(sendBundle, record, AsyncStorage).then(
        ({ receipt, status }) =>
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash
              ? {
                  ...prev,
                  state: receipt.success === false ? 'failed' : 'done',
                  txHash: receipt.txHash,
                  detail: sessionStatusText(status),
                }
              : prev,
          ),
        () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
      reloadList();
    } catch (e) {
      const { title, detail } = describe(e, 'send');
      Alert.alert(title, detail);
      // The quote went out once and is used up (aa.ts
      // claimQuoteForSubmission): back to the form, where Review creates a
      // fresh key and quote. The failed attempt stays in the list as a
      // "failed" record until the chain shows it can be forgotten.
      discardPending();
      setPhase('form');
      reloadList();
    }
  };

  // ------------------------------------------------------------ subscriptions

  const onSubOpen = (mode: 'subscription' | 'recurring') => {
    setFormError(null);
    setSubMode(mode);
    // "2 minutes (testing)" exists only on test networks: start from the
    // first preset this network offers.
    setSubForm({ ...EMPTY_SUBSCRIPTION_FORM, periodSeconds: subscriptionPeriodPresets(evmChain.testnet)[0]!.seconds });
    setSubFeeFacts({ maxFeePerGas: null, feeSource: null, balance: null, deposit: null });
    setSubInstallKeepBack(null);
    // The fee facts for the suggestion (shown and editable) are read by the
    // focus effect above as soon as the form is on screen, and again
    // whenever it regains focus and at Review.
    setPhase('sub-form');
  };

  /**
   * The fee budget the form shows: the user's own figure once typed, else
   * the suggestion for the current payment count, capped at what the
   * account can spare (findings 3 of the rehearsal).
   */
  const subChoice = tokenChoices[subForm.choiceIndex];
  const subNativeAmount = subChoice?.token === SUBSCRIPTION_NATIVE ? safeParseNative(subForm.amount) : 0n;
  const feeSuggestion = suggestedFeeBudget({
    payments: Number(subForm.payments.trim()),
    maxFeePerGas: subFeeFacts.maxFeePerGas,
    balance: subFeeFacts.balance,
    nativeAmountPerPayment: subNativeAmount,
    installFeeFromBalance: subInstallKeepBack,
  });
  const subFeeBudgetText = subForm.feeEdited
    ? subForm.feeBudget
    : feeSuggestion.wei !== null
      ? formatUnits(feeSuggestion.wei, 18, 18)
      : '';

  /** The fee-budget note's facts for a subscription paid in a token (null for the native currency). */
  const tokenNoteContext = (
    choice: SubscriptionTokenChoice | undefined,
    facts: { balance: bigint | null; deposit: bigint | null },
    installFee: bigint | null,
  ) =>
    choice && choice.token !== SUBSCRIPTION_NATIVE
      ? { tokenSymbol: choice.symbol, balance: facts.balance, deposit: facts.deposit, installFee }
      : null;

  const onSubReview = async () => {
    if (!bundle || !account || !owner) return;
    setFormError(null);
    discardPending();
    const choice = tokenChoices[subForm.choiceIndex];
    if (!choice) return;
    let periodSeconds = subForm.periodSeconds;
    if (subForm.periodCustom) {
      const custom = customPeriodSeconds(subForm.customCount, subForm.customUnit, evmChain.testnet);
      if (!custom.ok) {
        setFormError(custom.error);
        return;
      }
      periodSeconds = custom.seconds;
    }
    setPhase('sub-quoting');
    // Finding 2 of the 2026-10-04 emulator run: the suggestion is built on
    // the balance, deposit and fee as they are NOW, not as they were when the
    // form opened. A typed budget is used as typed.
    const facts = (await refreshSubFeeFacts()) ?? subFeeFacts;
    let feeBudgetText = subForm.feeBudget;
    if (!subForm.feeEdited) {
      const fresh = suggestedFeeBudget({
        payments: Number(subForm.payments.trim()),
        maxFeePerGas: facts.maxFeePerGas,
        balance: facts.balance,
        nativeAmountPerPayment: choice.token === SUBSCRIPTION_NATIVE ? safeParseNative(subForm.amount) : 0n,
        installFeeFromBalance: subInstallKeepBack,
      });
      feeBudgetText = fresh.wei !== null ? formatUnits(fresh.wei, 18, 18) : '';
    }
    const key = newSessionKey();
    const now = Math.floor(Date.now() / 1000);
    let subscription: SubscriptionGrant;
    let grant: SessionKeyGrant;
    const mode = subMode;
    const names =
      mode === 'recurring'
        ? recurringNames(subForm.label, subForm.merchant, nameFor(subForm.merchant.trim()))
        : subscriptionNames(subForm.label, subForm.merchant, nameFor(subForm.merchant.trim()));
    // The same engine grant for both (recurringGrantFor is subscriptionGrantFor).
    const grantFor = mode === 'recurring' ? recurringGrantFor : subscriptionGrantFor;
    try {
      subscription = buildSubscription(
        {
          merchant: subForm.merchant,
          choice,
          amount: subForm.amount,
          periodSeconds,
          payments: subForm.payments,
          feeBudget: feeBudgetText,
          label: names.termsLabel,
        },
        { now, account, testnet: evmChain.testnet, recipientLabel: mode === 'recurring' ? 'Payee' : 'Merchant' },
      );
      // The engine's refusal (validateSubscription / validateSessionKeyGrant) verbatim.
      grant = grantFor(subscription, key.address, { account, now });
    } catch (e) {
      key.privateKey.fill(0);
      setFormError(e instanceof Error ? e.message : String(e));
      setPhase('sub-form');
      return;
    }
    try {
      let {
        value: { install, quote },
        bundle: quotedOn,
      } = await quoteOnNode((b) => prepareSessionInstall(b, owner, account, grant, { now }));
      // Finding 2 of the 2026-10-04 verification: an UNEDITED fee-budget
      // pre-fill must keep back the install's own worst-case fee. The install
      // is quoted first (its fee barely depends on the budget), the pre-fill
      // is recomputed with that fee kept back, and when it no longer fits the
      // budget is lowered and the install quoted again (the budget is part of
      // the GasPolicy data the install writes). A typed budget is never
      // changed; the review's funding lines cover it. The worst case kept
      // back is the one the review displays (withSubscriptionFeeCeiling).
      let feeBudgetLowered: PendingSubscription['feeBudgetLowered'] = null;
      if (!subForm.feeEdited) {
        // Finding 4 of the 2026-10-09 recurring-payments rehearsal: the
        // lowering used to be computed from the FIRST quote only, and the
        // re-quote after lowering came back higher, so the review's funding
        // warning fired for the app's own suggestion. fitFeeBudgetToInstall
        // re-checks the keep-back against every new quote and lowers again
        // when needed (at most SUBSCRIPTION_FEE_BUDGET_REFIT_ROUNDS times).
        const sub0 = subscription;
        const fit = await fitFeeBudgetToInstall({
          feeBudgetWei: sub0.feeBudgetWei,
          attempt: { install, quote, bundle: quotedOn },
          payments: subscriptionPeriodCount(sub0),
          maxFeePerGas: facts.maxFeePerGas,
          nativeAmountPerPayment: sub0.token === SUBSCRIPTION_NATIVE ? sub0.amountPerPeriod : 0n,
          requote: async (feeBudgetWei) => {
            const lowered = grantFor({ ...sub0, feeBudgetWei }, key.address, { account, now });
            const r = await quoteOnNode((b) => prepareSessionInstall(b, owner, account, lowered, { now }));
            return { install: r.value.install, quote: r.value.quote, bundle: r.bundle };
          },
        });
        setSubInstallKeepBack(fit.keptBack);
        if (fit.kind === 'cannot-fit') {
          key.privateKey.fill(0);
          setFormError(
            fit.spare !== null && fit.uncapped !== null
              ? feeBudgetCapNote(
                  fit.spare,
                  fit.uncapped,
                  symbol,
                  fit.keptBack,
                  tokenNoteContext(
                    choice,
                    { balance: fit.attempt.quote.senderBalance, deposit: fit.attempt.quote.deposit ?? null },
                    subscriptionInstallFeeCeiling(fit.attempt.quote),
                  ),
                )
              : 'The fee budget could not be suggested: the network fee is not known yet. Enter a budget by hand.',
          );
          setPhase('sub-form');
          return;
        }
        if (fit.lowered) {
          feeBudgetLowered = fit.lowered;
          subscription = { ...sub0, feeBudgetWei: fit.feeBudgetWei };
          grant = grantFor(subscription, key.address, { account, now });
          ({ install, quote, bundle: quotedOn } = fit.attempt);
        }
      }
      subPending.current = {
        privateKey: key.privateKey,
        grant,
        install,
        quote,
        bundle: quotedOn,
        subscription,
        choice,
        recordLabel: names.recordLabel,
        mode,
        feeBudgetLowered,
        feePricing: { maxFeePerGas: facts.maxFeePerGas, source: facts.feeSource, edited: subForm.feeEdited },
      };
      setSubPendingView(subPending.current);
      setPhase('sub-confirm');
    } catch (e) {
      key.privateKey.fill(0);
      const { title, detail } = describe(e, 'quote');
      setFormError(`${title}\n${detail}`);
      setPhase('sub-form');
    }
  };

  const onSubInstall = async () => {
    const reviewed = subPending.current;
    if (!reviewed || !account || !owner || !resolution?.ok || !activeAccount) return;
    // Finding 1 of the rehearsal: the clock starts NOW, when Start was tapped,
    // not when Review opened. The restarted terms change the policy data and
    // the permission id, so the install is quoted again (same session key,
    // same calls and sizes); only a fee rise beyond the tolerance sends the
    // user back to the review. Done before the biometric gate, so the
    // approval prompt is followed directly by signing. The tolerance is part
    // of the worst case the review displayed (subscriptionInstallFeeCeiling),
    // so the signed fee never exceeds it.
    setSubSendStage('requote');
    setPhase('sub-sending');
    let p: PendingSubscription;
    try {
      const now = Math.floor(Date.now() / 1000);
      const restarted = restartSubscriptionAt(reviewed.subscription, now);
      const grantFor = reviewed.mode === 'recurring' ? recurringGrantFor : subscriptionGrantFor;
      const grant = grantFor(restarted, reviewed.grant.sessionKey, { account, now });
      const {
        value: { install, quote },
        bundle: quotedOn,
      } = await quoteOnNode((b) => prepareSessionInstall(b, owner, account, grant, { now }));
      p = { ...reviewed, subscription: restarted, grant, install, quote, bundle: quotedOn };
    } catch (e) {
      const { title, detail } = describe(e, 'quote');
      Alert.alert(title, detail);
      setPhase('sub-confirm');
      return;
    }
    // The review was left (Back) while the quote ran: nothing to install.
    if (subPending.current !== reviewed) return;
    subPending.current = p;
    setSubPendingView(p);
    if (subscriptionRequoteNeedsReview(reviewed.quote, p.quote)) {
      Alert.alert(SUBSCRIPTION_REQUOTE_TITLE, SUBSCRIPTION_REQUOTE_MESSAGE);
      setPhase('sub-confirm');
      return;
    }
    const auth =
      p.mode === 'recurring'
        ? await requireLocalAuth('Approve this recurring payment')
        : await requireLocalAuth('Approve this subscription');
    if (!auth.ok) {
      Alert.alert('Not granted', auth.message);
      setPhase('sub-confirm');
      return;
    }
    setSubSendStage('signing');
    const sendBundle = p.bundle;
    try {
      const { record, userOpHash } = await installSession({
        quote: p.quote,
        install: p.install,
        grant: p.grant,
        chain: evmChain.caip2,
        account,
        owner,
        accountIndex: activeAccount.index,
        accountKind: resolution.kind,
        label: p.recordLabel,
        ...(p.mode === 'recurring'
          ? // A recurring payment's key stays in the vault for its whole life
            // (never handed over); this wallet sends each payment with it.
            { source: 'recurring' as const, subscription: recurringMeta(p.subscription, p.choice) }
          : { source: 'subscription' as const, subscription: subscriptionMeta(p.subscription, p.choice) }),
        // A subscription's key is kept in the vault only until it is handed to the merchant.
        sessionPrivateKey: p.privateKey,
        store: AsyncStorage,
        vault: sessionKeyVault,
        // Same explicit, owner-signed install as every session.
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(sendBundle, signer, q)),
      });
      const finalTerms =
        p.mode === 'recurring' ? recurringFinalDatesLine(p.subscription) : subscriptionFinalDatesLine(p.subscription);
      discardPending();
      waitingFor.current.add(userOpHash);
      setProgress({
        kind: p.mode === 'recurring' ? 'recurring' : 'subscription',
        userOpHash,
        state: 'pending',
        txHash: null,
        detail: null,
        finalTerms,
      });
      setPhase('progress');
      void finalizeSessionInstall(sendBundle, record, AsyncStorage).then(
        ({ receipt, status }) =>
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash
              ? {
                  ...prev,
                  state: receipt.success === false ? 'failed' : 'done',
                  txHash: receipt.txHash,
                  detail: sessionStatusText(status),
                }
              : prev,
          ),
        () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
      reloadList();
    } catch (e) {
      const { title, detail } = describe(e, 'send');
      Alert.alert(title, detail);
      // The review stays: its next Start quotes the install again (the clock
      // restarts), so the used-up quote is never sent a second time.
      setPhase('sub-confirm');
      reloadList();
    }
  };

  const onShowKey = async (record: SessionRecord) => {
    const auth = await requireLocalAuth('Show the subscription key for the merchant');
    if (!auth.ok) {
      Alert.alert('Not shown', auth.message);
      return;
    }
    try {
      const payload = await buildSubscriptionKeyExport(record, sessionKeyVault);
      setKeyExport({ record, text: JSON.stringify(payload), fileName: subscriptionKeyFileName(payload) });
      setPhase('key-export');
    } catch (e) {
      Alert.alert('Key not available', e instanceof Error ? e.message : String(e));
    }
  };

  const onKeyHandedOver = () => {
    const current = keyExport;
    if (!current) return;
    Alert.alert(
      'Delete the key from this device?',
      'Only do this once the merchant has the key. It cannot be shown again; if it was lost, revoke the ' +
        'subscription and create a new one.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'The merchant has it',
          style: 'destructive',
          onPress: () => {
            markSubscriptionKeyExported(current.record, AsyncStorage, sessionKeyVault).then(
              () => {
                setKeyExport(null);
                setPhase('list');
                reloadList();
              },
              (e: unknown) => Alert.alert('Not changed', e instanceof Error ? e.message : String(e)),
            );
          },
        },
      ],
    );
  };

  const onTest = async (record: SessionRecord, callIndex: number) => {
    if (!bundle) return;
    const grant = parseSessionKeyGrant(record.grant);
    const allowed = grant.calls[callIndex];
    if (!allowed) return;
    const call = sessionTestCall(allowed);
    Alert.alert(
      'Test this session?',
      `The SESSION key (not your account key) signs one operation: call ${call.to} with ` +
        `${call.data.length === 0 ? 'no data' : `only the selector ${toHex(call.data)} (no arguments)`} and 0 ${symbol}. ` +
        `Gas is paid by ${record.account}. A call with a selector but no arguments may be refused by the ` +
        'target contract; the bundler’s message is shown as returned.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send test',
          onPress: () => {
            void (async () => {
              const auth = await requireLocalAuth('Approve a session-key test operation');
              if (!auth.ok) {
                Alert.alert('Not sent', auth.message);
                return;
              }
              try {
                const { userOpHash, client } = await sendSessionCalls({
                  bundle,
                  record,
                  calls: [call],
                  vault: sessionKeyVault,
                });
                setProgress({ kind: 'test', userOpHash, state: 'pending', txHash: null, detail: null });
                setPhase('progress');
                void client.waitForReceipt(userOpHash, { timeoutMs: 120_000, pollMs: 3_000 }).then(
                  (raw) => {
                    const s = summarizeAaReceipt(raw);
                    setProgress((prev) =>
                      prev && prev.userOpHash === userOpHash
                        ? { ...prev, state: s.success === false ? 'failed' : 'done', txHash: s.txHash }
                        : prev,
                    );
                  },
                  () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
                );
              } catch (e) {
                const { title, detail } = describe(e, 'send');
                Alert.alert(title === 'The transaction could not be sent.' ? 'Session test refused' : title, detail);
                refreshRecord(record);
              }
            })();
          },
        },
      ],
    );
  };

  // ------------------------------------------------------------ recurring payments

  /** Shows a refused payment in plain words and keeps it on the card (the card stays). */
  const showPayRefusal = (record: SessionRecord, e: unknown) => {
    const key = sessionRecordKey(record.chain, record.account, record.permissionId);
    const { title, detail, outcome } = describeRecurringPaymentError(
      e,
      { accountType: bundle?.accountType ?? 'kernel-v3.3', symbol },
      describeSendError,
    );
    Alert.alert(title, detail);
    // Only an actual refusal is called "refused" on the card (finding 1 of the 2026-10-09 rehearsal).
    setPayRefusals((prev) => ({ ...prev, [key]: recurringAttemptLine(outcome, detail) }));
    refreshRecord(record);
  };

  /**
   * The confirmation dialog of a payment: resolves true ONLY when the user
   * taps "Send payment"; Cancel, the back button or tapping outside resolve
   * false.
   */
  const confirmPaymentDialog = (plan: RecurringPaymentPlan) =>
    new Promise<boolean>((resolve) => {
      Alert.alert(
        'Send this payment now?',
        recurringConfirmMessage(plan, { nativeSymbol: symbol, payeeName: nameFor(plan.terms.merchant) }),
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Send payment', onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    });

  /**
   * A due recurring payment (phase 15 item 1). NEVER automatic: through
   * runRecurringPayment, the plan re-reads the chain (no key, no bundler),
   * then the confirmation dialog opens, and only "Send payment" sends.
   * There is deliberately no requireLocalAuth here: that gate opens the
   * recovery phrase when it is protected, and a payment must never read the
   * phrase. The payment key's own vault read shows the system prompt "Use
   * the session key" when that key is stored with biometric protection.
   */
  const onPayNow = async (record: SessionRecord) => {
    if (!bundle) return;
    const key = sessionRecordKey(record.chain, record.account, record.permissionId);
    setPayingKey(key);
    try {
      // Endpoint failover (finding 1 of the 2026-10-09 rehearsal): the plan's
      // status read and the payment's node requests run on the RPC endpoint
      // in use now and move ONCE to the next healthy default when that node
      // does not answer (isRecurringNodeFailure / quoteOnNode's
      // isNodeEndpointFailure) — the rule of the session and subscription
      // quotes. Every node request of a payment precedes its submission
      // (sessions.ts sendSessionCalls), so repeating it cannot send twice; a
      // bundler failure is never failed over. When the node fails after the
      // payment key was read, the retry reads the key again (one more system
      // prompt when the key is protected).
      const run = await runRecurringPayment({
        plan: () => activeEvmNodeRunner((node) => planRecurringPayment({ node, record }), { isFailure: isRecurringNodeFailure }),
        confirm: (plan) => {
          setPayingKey(null);
          return confirmPaymentDialog(plan);
        },
        pay: (plan) => {
          setPayingKey(key);
          return quoteOnNode((b) => payRecurringPayment({ bundle: b, plan, vault: sessionKeyVault })).then(({ value }) => value);
        },
      });
      if (run.outcome !== 'sent') return;
      const { userOpHash, client } = run.result;
      setPayRefusals((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setProgress({ kind: 'recurring-payment', userOpHash, state: 'pending', txHash: null, detail: null });
      setPhase('progress');
      void client.waitForReceipt(userOpHash, { timeoutMs: 120_000, pollMs: 3_000 }).then(
        (raw) => {
          const summary = summarizeAaReceipt(raw);
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash
              ? { ...prev, state: summary.success === false ? 'failed' : 'done', txHash: summary.txHash }
              : prev,
          );
        },
        () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
    } catch (e) {
      showPayRefusal(record, e);
    } finally {
      setPayingKey(null);
    }
  };

  const onRevokeQuote = async (record: SessionRecord, options: { forgetAfter?: boolean } = {}) => {
    if (!owner) return;
    try {
      const { value: quote, bundle: quotedOn } = await quoteOnNode((b) => prepareSessionRevoke(b, owner, record));
      setRevokeTarget({ record, quote, bundle: quotedOn, ...(options.forgetAfter ? { forgetAfter: true } : {}) });
      setPhase('revoke-confirm');
    } catch (e) {
      const { title, detail } = describe(e, 'quote');
      Alert.alert(title, detail);
      // Finding 8: the card re-reads its status after any failed action.
      refreshRecord(record);
    }
  };

  const onRevoke = async () => {
    if (!revokeTarget || !owner) return;
    const target = revokeTarget;
    const sendBundle = target.bundle;
    // The bundler's fee floor, BEFORE the device check (see onInstall): back
    // to the list, where Revoke quotes again.
    try {
      await checkAaQuoteBeforeApproval(sendBundle.bundler, target.quote);
    } catch (e) {
      const { title, detail } = describe(e, 'send');
      Alert.alert(title, detail);
      setRevokeTarget(null);
      setPhase('list');
      return;
    }
    const auth = await requireLocalAuth(revokeApprovalPrompt(target.record));
    if (!auth.ok) {
      Alert.alert('Not revoked', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const { record, userOpHash } = await revokeSession({
        record: target.record,
        quote: target.quote,
        store: AsyncStorage,
        vault: sessionKeyVault,
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(sendBundle, signer, q)),
      });
      setRevokeTarget(null);
      waitingFor.current.add(userOpHash);
      setProgress({
        kind:
          target.record.source === 'subscription'
            ? 'subscription-revoke'
            : target.record.source === 'recurring'
              ? 'recurring-revoke'
              : 'revoke',
        userOpHash,
        state: 'pending',
        txHash: null,
        detail: null,
      });
      setPhase('progress');
      void finalizeSessionRevoke(sendBundle, record, AsyncStorage).then(
        ({ record: settled, receipt, status }) => {
          setProgress((prev) =>
            prev && prev.userOpHash === userOpHash
              ? {
                  ...prev,
                  state: receipt.success === false ? 'failed' : 'done',
                  txHash: receipt.txHash,
                  detail: sessionStatusText(status),
                }
              : prev,
          );
          // "Revoke and forget" (a completed recurring payment): forgotten only
          // once the chain shows the permission removed (forgetSession checks
          // again and refuses otherwise).
          if (target.forgetAfter && receipt.success !== false && status.kind === 'revoked') {
            forgetSession({ record: settled, node: sendBundle.node, store: AsyncStorage, vault: sessionKeyVault }).then(
              () => {
                setProgress((prev) =>
                  prev && prev.userOpHash === userOpHash ? { ...prev, detail: 'Revoked and forgotten' } : prev,
                );
                reloadList();
              },
              () => reloadList(),
            );
          }
        },
        () => setProgress((prev) => (prev && prev.userOpHash === userOpHash ? { ...prev, state: 'timeout' } : prev)),
      );
      reloadList();
    } catch (e) {
      const { title, detail } = describe(e, 'send');
      Alert.alert(title, detail);
      // The quote went out once and is used up (aa.ts
      // claimQuoteForSubmission): back to the list, where Revoke quotes
      // again with fresh fees, and the card re-reads its status so its
      // "Next payment" line is current (finding 8).
      setRevokeTarget(null);
      setPhase('list');
      refreshRecord(target.record);
    }
  };

  const onForget = (record: SessionRecord) => {
    if (!bundle) return;
    Alert.alert('Forget this session?', 'It is removed from this list (and its key from this device).', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: () => {
          forgetSession({ record, node: bundle.node, store: AsyncStorage, vault: sessionKeyVault }).then(
            () => reloadList(),
            (e: unknown) => {
              Alert.alert('Kept', e instanceof Error ? e.message : String(e));
              // A failed action re-reads the card (finding 8).
              refreshRecord(record);
            },
          );
        },
      },
    ]);
  };

  const onResetList = () => {
    Alert.alert(
      'Reset the session list?',
      'The unreadable list is cleared. This does NOT revoke anything on-chain: grants stay active until ' +
        'they expire, and the session keys the old list referenced stay unused in secure storage.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: () => void resetSessions().then(reloadList, reloadList) },
      ],
    );
  };

  const draftMatches = useMemo(
    () =>
      drafts.map((d) =>
        contactsNetworkId && d.target.trim() ? matchRecipient(contactsNetworkId, d.target, contacts) : null,
      ),
    [drafts, contacts, contactsNetworkId],
  );

  // ------------------------------------------------------------ render

  const header = (
    <>
      <Text style={[styles.networkLine, { color: theme.textMuted }]}>
        {evmChain.label}
        {evmChain.testnet ? ' · TESTNET' : ''} · chain id {evmChain.chainIdDecimal}
      </Text>
      <Row label="Owner account (installs and revokes)" value={activeAccount?.name ?? 'Account'} sub={owner} theme={theme} />
      <ImportedKeyNotice show={activeAccount?.imported === true} />
      {resolution?.ok ? (
        <Row
          label={resolution.kind === 'kernel-7702' ? 'Kernel account (your upgraded address)' : 'Kernel smart account'}
          value={resolution.account}
          mono
          theme={theme}
        />
      ) : null}
    </>
  );

  // Every phase's ScrollView carries its own key, so React mounts a fresh
  // one (scrolled to the top) instead of reusing the previous phase's
  // native view with its scroll offset — the subscription review opened
  // scrolled to the middle in the rehearsal (finding 2).
  if (phase === 'progress' && progress) {
    return (
      <ScrollView key="progress" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.success }]}>{sessionProgressTitle(progress.kind)}</Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>UserOperation hash</Text>
        <Text selectable style={[styles.monoText, { color: theme.text }]}>
          {progress.userOpHash}
        </Text>
        {progress.kind === 'test' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>Signed by the session key only.</Text>
        ) : null}
        {progress.kind === 'recurring-payment' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Signed by this recurring payment’s own key only, not by your account key.
          </Text>
        ) : null}
        {progress.finalTerms ? <Text style={[styles.hint, { color: theme.text }]}>{progress.finalTerms}</Text> : null}
        {progress.state === 'pending' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Bundling… waiting for the receipt.</Text>
          </View>
        ) : null}
        {progress.state === 'done' ? (
          <Text style={[styles.ok, { color: theme.success }]}>
            Included on-chain — succeeded.{progress.detail ? ` Status: ${progress.detail}.` : ''}
          </Text>
        ) : null}
        {progress.state === 'failed' ? (
          <WarningBox>
            Included, but the operation reverted.{progress.detail ? ` Status: ${progress.detail}.` : ''}
          </WarningBox>
        ) : null}
        {progress.state === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Not included within two minutes. It may still be included; the list reads the status from the chain.
          </Text>
        ) : null}
        {progress.txHash && evmChain.explorerTxBase ? (
          <Button
            title="View bundle transaction"
            variant="secondary"
            onPress={() => void Linking.openURL(`${evmChain.explorerTxBase}${progress.txHash}`)}
          />
        ) : null}
        <Button
          title="Done"
          onPress={() => {
            setProgress(null);
            setPhase('list');
            reloadList();
          }}
        />
      </ScrollView>
    );
  }

  if ((phase === 'confirm' || phase === 'sending') && pendingView && account) {
    const q = pendingView.quote;
    return (
      <ScrollView key="confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.title, { color: theme.text }]}>Grant this session?</Text>
        {header}
        <GrantReview
          grant={pendingView.grant}
          account={account}
          symbol={symbol}
          nameFor={nameFor}
          sessionKeyHolder="this device (secure storage)"
          permissionId={toHex(pendingView.install.permissionId)}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>{SESSIONS_INSTALL_MODE_NOTE}</Text>
        {!evmChain.testnet ? <WarningBox>{SESSIONS_AUDIT_NOTE}</WarningBox> : null}
        <Row
          label="Install operation"
          value={`2 calls to your own account (installValidations, grantAccess), 0 ${symbol}`}
          sub="Signed by your account key as the account's root validator."
          theme={theme}
        />
        <Row
          label={q.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={q.sponsored ? 'Sponsored — the account pays 0' : `${formatUnits(q.fee, 18, 18)} ${symbol}`}
          theme={theme}
        />
        <Row label="Account balance" value={`${formatUnits(q.senderBalance, 18, 18)} ${symbol}`} theme={theme} />
        <AaDepositNote fee={q.fee} deposit={q.deposit} sponsored={q.sponsored} symbol={symbol} />
        <Text style={[styles.ok, { color: theme.success }]}>
          Bundler gas estimate passed (eth_estimateUserOperationGas simulated the install).
        </Text>
        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Signing and sending…</Text>
          </View>
        ) : (
          <>
            <Button title="Grant session" onPress={() => void onInstall()} />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                discardPending();
                setPhase('form');
              }}
            />
          </>
        )}
      </ScrollView>
    );
  }

  if (phase === 'key-export' && keyExport) {
    const terms = termsOf(keyExport.record);
    return (
      <ScrollView key="key-export" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: theme.text }]}>Hand the key to the merchant</Text>
        <WarningBox>{SUBSCRIPTION_KEY_WARNING}</WarningBox>
        <Row label="Subscription" value={subscriptionSummary(keyExport.record, nameFor(terms.merchant))} theme={theme} />
        <PayloadQr value={keyExport.text} caption="Subscription key and terms (JSON) for the merchant's keeper." />
        <Text selectable style={[styles.monoText, { color: theme.text }]}>
          {keyExport.text}
        </Text>
        <SubscriptionKeyHandoverActions text={keyExport.text} fileName={keyExport.fileName} />
        <Button title="The merchant has the key — delete it here" variant="destructive" onPress={onKeyHandedOver} />
        <Button
          title="Not now (keep it on this device)"
          variant="secondary"
          onPress={() => {
            setKeyExport(null);
            setPhase('list');
          }}
        />
      </ScrollView>
    );
  }

  if ((phase === 'sub-confirm' || phase === 'sub-sending') && subPendingView && account) {
    const q = subPendingView.quote;
    const sub = subPendingView.subscription;
    // A recurring payment (phase 15 item 1) shares the grant, the install
    // and every funding rule with a subscription; only its words differ.
    const recurring = subPendingView.mode === 'recurring';
    const review = recurring
      ? recurringReview(sub, {
          tokenSymbol: subPendingView.choice.symbol,
          tokenDecimals: subPendingView.choice.decimals,
          nativeSymbol: symbol,
          payeeName: nameFor(sub.merchant),
        })
      : subscriptionReview(sub, {
          tokenSymbol: subPendingView.choice.symbol,
          tokenDecimals: subPendingView.choice.decimals,
          nativeSymbol: symbol,
          merchantName: nameFor(sub.merchant),
        });
    const [batchCaveat, ...otherCaveats] = review.caveats;
    const shortWindow = recurring ? recurringShortWindowWarning(sub) : subscriptionShortWindowWarning(sub);
    const startButton = recurring ? 'Start recurring payment' : 'Start subscription';
    // The displayed worst case includes the re-quote tolerance of Start
    // (subscriptionInstallFeeCeiling), and the funding lines use it too.
    const shown = withSubscriptionFeeCeiling(q);
    const funding = subscriptionInstallFunding(shown, sub, symbol, recurring ? 'recurring' : 'subscription');
    const lowered = subPendingView.feeBudgetLowered;
    return (
      <ScrollView key="sub-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.title, { color: theme.text }]}>
          {recurring ? 'Start this recurring payment?' : 'Start this subscription?'}
        </Text>
        {header}
        {/* Order as recorded for phase 12 item 2 and DEMO step 10: the batch
            warning FIRST, then the plain sentence, then the on-chain lines. */}
        {batchCaveat ? <WarningBox>{batchCaveat}</WarningBox> : null}
        <Text style={[styles.ok, { color: theme.text }]}>{review.sentence}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{recurring ? RECURRING_START_NOTE : SUBSCRIPTION_START_NOTE}</Text>
        {recurring ? (
          <>
            <Text style={[styles.hint, { color: theme.text }]}>{RECURRING_WHILE_OPEN_NOTE}</Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{RECURRING_PAY_PROMPT_NOTE}</Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{RECURRING_SPENDING_NOTE}</Text>
          </>
        ) : null}
        {shortWindow ? <WarningBox>{shortWindow}</WarningBox> : null}
        <Text style={[styles.label, { color: theme.textMuted }]}>Your account enforces on-chain:</Text>
        {review.enforced.map((line) => (
          <Text key={line} style={[styles.hint, { color: theme.text }]}>
            • {line}
          </Text>
        ))}
        {otherCaveats.map((line) => (
          <Text key={line} style={[styles.hint, { color: theme.textMuted }]}>
            {line}
          </Text>
        ))}
        <Text style={[styles.hint, { color: theme.textMuted }]}>{recurring ? RECURRING_AUDIT_NOTE : SUBSCRIPTION_AUDIT_NOTE}</Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>Technical details (the grant as installed)</Text>
        <GrantReview
          grant={subPendingView.grant}
          account={account}
          symbol={symbol}
          nameFor={nameFor}
          sessionKeyHolder={recurring ? RECURRING_KEY_HOLDER_TEXT : SUBSCRIPTION_KEY_HOLDER_TEXT}
          permissionId={toHex(subPendingView.install.permissionId)}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>{SESSIONS_INSTALL_MODE_NOTE}</Text>
        <Row
          label="Install operation"
          value={`2 calls to your own account (installValidations, grantAccess), 0 ${symbol}`}
          sub="Signed by your account key as the account's root validator."
          theme={theme}
        />
        <Row
          label={q.sponsored ? 'Network fee' : 'Max network fee'}
          value={q.sponsored ? 'Sponsored — the account pays 0' : `${formatUnits(shown.fee, 18, 18)} ${symbol}`}
          sub={
            q.sponsored
              ? null
              : `The bundler's estimate (${formatUnits(q.fee, 18, 18)} ${symbol}) plus up to ` +
                `${SUBSCRIPTION_REQUOTE_FEE_TOLERANCE_PERCENT}% for the new quote taken when you tap ${startButton} ` +
                '(the clock restarts then). Nothing above this is ever signed; a higher fee brings you back here.'
          }
          theme={theme}
        />
        <Row label="Account balance" value={`${formatUnits(q.senderBalance, 18, 18)} ${symbol}`} theme={theme} />
        {q.deposit !== undefined && q.deposit > 0n ? (
          <Row label="EntryPoint deposit (pays fees first)" value={`${formatUnits(q.deposit, 18, 18)} ${symbol}`} theme={theme} />
        ) : null}
        {funding.depositNote ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{funding.depositNote}</Text>
        ) : null}
        {lowered ? (
          <WarningBox>
            {`The suggested fee budget was lowered from ${formatUnits(lowered.from, 18, 18)} to ` +
              `${formatUnits(lowered.to, 18, 18)} ${symbol} so that ${formatUnits(lowered.keptBack, 18, 18)} ` +
              `${symbol} stays in the account for this install's own worst-case network fee.`}
          </WarningBox>
        ) : null}
        {funding.shortfall ? <WarningBox>{funding.shortfall}</WarningBox> : null}
        {funding.block ? <WarningBox>{funding.block}</WarningBox> : null}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {feeBudgetPricingNote({
            budgetWei: sub.feeBudgetWei,
            payments: subscriptionPeriodCount(sub),
            maxFeePerGas: subPendingView.feePricing.maxFeePerGas,
            source: subPendingView.feePricing.source,
            edited: subPendingView.feePricing.edited,
            nativeSymbol: symbol,
          })}
        </Text>
        <Text style={[styles.ok, { color: theme.success }]}>
          Bundler gas estimate passed (eth_estimateUserOperationGas simulated the install).
        </Text>
        {phase === 'sub-sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              {subSendStage === 'requote'
                ? 'Starting the clock now and asking the bundler again…'
                : 'Signing and sending…'}
            </Text>
          </View>
        ) : (
          <>
            {funding.canStart ? <Button title={startButton} onPress={() => void onSubInstall()} /> : null}
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                discardPending();
                setPhase('sub-form');
              }}
            />
          </>
        )}
      </ScrollView>
    );
  }

  if ((phase === 'sub-form' || phase === 'sub-quoting') && account) {
    const customPeriod = customPeriodSeconds(subForm.customCount, subForm.customUnit, evmChain.testnet);
    const customPeriodHint = customPeriod.ok
      ? `One payment at most every ${describePeriod(customPeriod.seconds)}.`
      : subForm.customCount.trim() === ''
        ? `From ${describePeriod(subscriptionMinPeriodSeconds(evmChain.testnet))} to ` +
          `${describePeriod(SUBSCRIPTION_MAX_PERIOD_SECONDS)}.`
        : customPeriod.error;
    const merchantMatch =
      contactsNetworkId && subForm.merchant.trim() ? matchRecipient(contactsNetworkId, subForm.merchant, contacts) : null;
    const choice = tokenChoices[subForm.choiceIndex];
    const recurringForm = subMode === 'recurring';
    return (
      <ScrollView key="sub-form" style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: theme.text }]}>{recurringForm ? 'New recurring payment' : 'New subscription'}</Text>
        {header}
        {recurringForm ? (
          <>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{RECURRING_FORM_INTRO}</Text>
            <WarningBox>{RECURRING_WHILE_OPEN_NOTE}</WarningBox>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{RECURRING_LATER_SLICE_NOTE}</Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{RECURRING_SPENDING_NOTE}</Text>
          </>
        ) : (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Lets one merchant take up to a fixed amount once per period, until the payments run out or you
            revoke. A new key is created for the merchant; your account enforces the limits on-chain.
          </Text>
        )}
        <Text style={[styles.label, { color: theme.textMuted }]}>
          {recurringForm ? 'Pay to (receives the payments)' : 'Merchant (receives the payments)'}
        </Text>
        <TextInput
          value={subForm.merchant}
          onChangeText={(t) => setSubForm((prev) => ({ ...prev, merchant: t }))}
          placeholder={recurringForm ? 'Recipient address (0x…)' : 'Merchant address (0x…)'}
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={recurringForm ? 'Recipient address' : 'Merchant address'}
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        {merchantMatch && merchantMatch.kind !== 'none' ? (
          <RecipientContactNotice match={merchantMatch} address={subForm.merchant.trim()} />
        ) : null}
        <Button title="Pick from contacts" variant="secondary" onPress={() => setSubPickerOpen(true)} />
        <Text style={[styles.label, { color: theme.textMuted }]}>Paid in</Text>
        <View style={styles.rowButtons}>
          {tokenChoices.map((c, i) => (
            <Button
              key={c.token}
              title={`${subForm.choiceIndex === i ? '✓ ' : ''}${c.symbol}${c.token.startsWith('0x') ? ` (${c.token.slice(0, 6)}…${c.token.slice(-4)})` : ''}`}
              variant={subForm.choiceIndex === i ? 'primary' : 'secondary'}
              onPress={() => setSubForm((prev) => ({ ...prev, choiceIndex: i }))}
            />
          ))}
        </View>
        <Text style={[styles.label, { color: theme.textMuted }]}>Most per payment</Text>
        <TextInput
          value={subForm.amount}
          onChangeText={(t) => setSubForm((prev) => ({ ...prev, amount: t }))}
          placeholder={`Amount in ${choice?.symbol ?? ''}`}
          placeholderTextColor={theme.textMuted}
          keyboardType="decimal-pad"
          accessibilityLabel="Most per payment"
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        <Text style={[styles.label, { color: theme.textMuted }]}>Once every</Text>
        <View style={styles.rowButtons}>
          {subscriptionPeriodPresets(evmChain.testnet).map((p) => {
            const chosen = !subForm.periodCustom && subForm.periodSeconds === p.seconds;
            return (
              <Button
                key={p.seconds}
                title={chosen ? `✓ ${p.label}` : p.label}
                variant={chosen ? 'primary' : 'secondary'}
                selected={chosen}
                onPress={() => setSubForm((prev) => ({ ...prev, periodSeconds: p.seconds, periodCustom: false }))}
              />
            );
          })}
          <Button
            title={subForm.periodCustom ? '✓ Custom' : 'Custom'}
            variant={subForm.periodCustom ? 'primary' : 'secondary'}
            selected={subForm.periodCustom}
            onPress={() => setSubForm((prev) => ({ ...prev, periodCustom: true }))}
          />
        </View>
        {subForm.periodCustom ? (
          <>
            <TextInput
              value={subForm.customCount}
              onChangeText={(t) => setSubForm((prev) => ({ ...prev, customCount: t }))}
              placeholder="How many"
              placeholderTextColor={theme.textMuted}
              keyboardType="number-pad"
              accessibilityLabel="Custom period length"
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            <View style={styles.rowButtons}>
              {SUBSCRIPTION_PERIOD_UNITS.map((u) => (
                <Button
                  key={u.seconds}
                  title={subForm.customUnit === u.seconds ? `✓ ${u.label}` : u.label}
                  variant={subForm.customUnit === u.seconds ? 'primary' : 'secondary'}
                  selected={subForm.customUnit === u.seconds}
                  onPress={() => setSubForm((prev) => ({ ...prev, customUnit: u.seconds }))}
                />
              ))}
            </View>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{customPeriodHint}</Text>
          </>
        ) : null}
        <Text style={[styles.label, { color: theme.textMuted }]}>Number of payments (1–{SUBSCRIPTION_MAX_PAYMENTS}; sets the expiry)</Text>
        <TextInput
          value={subForm.payments}
          onChangeText={(t) => setSubForm((prev) => ({ ...prev, payments: t }))}
          keyboardType="number-pad"
          accessibilityLabel="Number of payments"
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        <Text style={[styles.label, { color: theme.textMuted }]}>Fee budget ({symbol}, all payments together)</Text>
        <TextInput
          value={subFeeBudgetText}
          // Typing makes the figure the user's own; clearing the field goes
          // back to the suggestion that follows the payment count.
          onChangeText={(t) => setSubForm((prev) => ({ ...prev, feeBudget: t, feeEdited: t.trim() !== '' }))}
          placeholder={
            recurringForm
              ? `Total ${symbol} the payments may spend on network fees`
              : `Total ${symbol} the merchant's payments may spend on network fees`
          }
          placeholderTextColor={theme.textMuted}
          keyboardType="decimal-pad"
          accessibilityLabel="Fee budget"
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        {recurringForm ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{recurringFeeBudgetHint(symbol)}</Text>
        ) : (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Each payment’s network fee is paid by your account. The budget caps the total; without it a merchant
            could pay itself high fees from your {symbol}.
          </Text>
        )}
        {!subForm.feeEdited ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{feeBudgetSuggestionHint(subFeeFacts.feeSource)}</Text>
        ) : null}
        {!subForm.feeEdited && feeSuggestion.capped && feeSuggestion.spare !== null && feeSuggestion.uncapped !== null ? (
          <WarningBox>
            {feeBudgetCapNote(
              feeSuggestion.spare,
              feeSuggestion.uncapped,
              symbol,
              0n,
              tokenNoteContext(choice, subFeeFacts, null),
            )}
          </WarningBox>
        ) : null}
        {subFeeFacts.balance !== null ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {`The smart account holds ${formatUnits(subFeeFacts.balance, 18, 18)} ${symbol}` +
              (subFeeFacts.deposit !== null && subFeeFacts.deposit > 0n
                ? ` plus an EntryPoint deposit of ${formatUnits(subFeeFacts.deposit, 18, 18)} ${symbol}`
                : '') +
              ' (read just now).'}
          </Text>
        ) : null}
        <Text style={[styles.label, { color: theme.textMuted }]}>Name (optional)</Text>
        <TextInput
          value={subForm.label}
          onChangeText={(t) => setSubForm((prev) => ({ ...prev, label: t }))}
          placeholder={recurringForm ? 'e.g. rent' : 'e.g. the service’s name'}
          placeholderTextColor={theme.textMuted}
          maxLength={64}
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        {formError ? <WarningBox>{formError}</WarningBox> : null}
        {phase === 'sub-quoting' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Reading the account and asking the bundler…</Text>
          </View>
        ) : (
          <>
            <Button title="Review" onPress={() => void onSubReview()} />
            <Button title="Cancel" variant="secondary" onPress={() => setPhase('list')} />
          </>
        )}
        <ContactPicker
          visible={subPickerOpen}
          contacts={contacts}
          networkLabel={evmChain.label}
          onPick={(c) => {
            setSubPickerOpen(false);
            setSubForm((prev) => ({ ...prev, merchant: c.address }));
          }}
          onClose={() => setSubPickerOpen(false)}
        />
      </ScrollView>
    );
  }

  if ((phase === 'revoke-confirm' || phase === 'sending') && revokeTarget) {
    const q = revokeTarget.quote;
    let revokeTitle = revokeTarget.record.label;
    if (revokeTarget.record.source === 'subscription' && revokeTarget.record.subscription) {
      try {
        revokeTitle = subscriptionDisplayTitle(revokeTarget.record, nameFor(termsOf(revokeTarget.record).merchant));
      } catch {
        // Unreadable terms: the stored label stays.
      }
    }
    const revokeCopy = revokeConfirmCopy(revokeTarget.record, revokeTitle);
    return (
      <ScrollView key="revoke-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.title, { color: theme.text }]}>{revokeCopy.heading}</Text>
        {header}
        <Row label="Permission id" value={revokeTarget.record.permissionId} mono theme={theme} />
        <Row
          label="Operation"
          value="One call to your own account: uninstallValidation for this permission"
          sub={sessionRevokeKeySentence(revokeTarget.record)}
          theme={theme}
        />
        <Row
          label={q.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={q.sponsored ? 'Sponsored — the account pays 0' : `${formatUnits(q.fee, 18, 18)} ${symbol}`}
          theme={theme}
        />
        <AaDepositNote fee={q.fee} deposit={q.deposit} sponsored={q.sponsored} symbol={symbol} />
        <Text style={[styles.ok, { color: theme.success }]}>Bundler gas estimate passed.</Text>
        {phase === 'sending' ? (
          <ActivityIndicator size="large" color={theme.accent} />
        ) : (
          <>
            <Button title={revokeCopy.button} variant="destructive" onPress={() => void onRevoke()} />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                setRevokeTarget(null);
                setPhase('list');
              }}
            />
          </>
        )}
      </ScrollView>
    );
  }

  if ((phase === 'form' || phase === 'quoting') && account) {
    return (
      <ScrollView key="form" style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: theme.text }]}>Grant a session</Text>
        {header}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          A session key is a new key on this device that may make ONLY the calls you list, until it
          expires. Your account enforces the limits on-chain. Each value cap is per call, not a total.
        </Text>
        {drafts.map((d, i) => (
          <View key={i} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.label, { color: theme.textMuted }]}>Allowed call {i + 1}</Text>
            <TextInput
              value={d.target}
              onChangeText={(t) => setDrafts((prev) => prev.map((x, j) => (j === i ? { ...x, target: t } : x)))}
              placeholder="Target address (0x…)"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            {draftMatches[i] && draftMatches[i]!.kind !== 'none' ? (
              <RecipientContactNotice match={draftMatches[i]!} address={d.target.trim()} />
            ) : null}
            <Button title="Pick from contacts" variant="secondary" onPress={() => setPickerFor(i)} />
            <TextInput
              value={d.selector}
              onChangeText={(t) => setDrafts((prev) => prev.map((x, j) => (j === i ? { ...x, selector: t } : x)))}
              placeholder="Function (optional): 0xa9059cbb or transfer(address,uint256)"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            <TextInput
              value={d.valueCapEth}
              onChangeText={(t) => setDrafts((prev) => prev.map((x, j) => (j === i ? { ...x, valueCapEth: t } : x)))}
              placeholder={`Max ${symbol} per call (empty = 0)`}
              placeholderTextColor={theme.textMuted}
              keyboardType="decimal-pad"
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            {drafts.length > 1 ? (
              <Button
                title="Remove this call"
                variant="secondary"
                onPress={() => setDrafts((prev) => prev.filter((_, j) => j !== i))}
              />
            ) : null}
          </View>
        ))}
        <Button title="Add another allowed call" variant="secondary" onPress={() => setDrafts((p) => [...p, { ...EMPTY_DRAFT }])} />
        <Text style={[styles.label, { color: theme.textMuted }]}>Expires after (required)</Text>
        <View style={styles.rowButtons}>
          {SESSION_EXPIRY_PRESETS.map((p) => (
            <Button
              key={p.seconds}
              title={expirySeconds === p.seconds ? `✓ ${p.label}` : p.label}
              variant={expirySeconds === p.seconds ? 'primary' : 'secondary'}
              onPress={() => setExpirySeconds(p.seconds)}
            />
          ))}
        </View>
        <Text style={[styles.label, { color: theme.textMuted }]}>Gas budget (optional)</Text>
        <TextInput
          value={gasBudgetEth}
          onChangeText={setGasBudgetEth}
          placeholder={`Total ${symbol} the session may spend on fees`}
          placeholderTextColor={theme.textMuted}
          keyboardType="decimal-pad"
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        {formError ? <WarningBox>{formError}</WarningBox> : null}
        {phase === 'quoting' ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Reading the account and asking the bundler…</Text>
          </View>
        ) : (
          <>
            <Button title="Review" onPress={() => void onReview()} />
            <Button title="Cancel" variant="secondary" onPress={() => setPhase('list')} />
          </>
        )}
        <ContactPicker
          visible={pickerFor !== null}
          contacts={contacts}
          networkLabel={evmChain.label}
          onPick={(c) => {
            const index = pickerFor;
            setPickerFor(null);
            if (index !== null) setDrafts((prev) => prev.map((x, j) => (j === index ? { ...x, target: c.address } : x)));
          }}
          onClose={() => setPickerFor(null)}
        />
      </ScrollView>
    );
  }

  // ------------------------------------------------------------ list
  // Recurring payments (phase 15 item 1): their due state comes from the
  // on-chain reads refreshRecord makes on every focus; a due one is only
  // OFFERED (the card's button, then a confirmation), never sent here.
  const recurringList = sortSubscriptionRecords(records.filter((r) => r.source === 'recurring' && r.subscription)).map(
    (record) => {
      const key = sessionRecordKey(record.chain, record.account, record.permissionId);
      const subStatus = subStatuses[key];
      return {
        record,
        key,
        // nowTick (above) re-evaluates this every 30 seconds while the screen is focused.
        due: subStatus === undefined || subStatus === 'loading' ? null : recurringDueState(record, subStatus, nowTick),
      };
    },
  );
  const dueHeadline = recurringDueHeadline(recurringList.filter((x) => x.due?.kind === 'due').length);
  return (
    <ScrollView key="list" style={screenStyle(theme)} contentContainerStyle={styles.content}>
      {readiness ? <TestNetworksOnlyCard feature={readiness.feature} hint={readiness.hint} /> : null}
      {header}
      <WarningBox>{SESSIONS_WIPE_WARNING}</WarningBox>
      {!owner ? <Text style={[styles.error, { color: theme.danger }]}>No Ethereum address for this account.</Text> : null}
      {setupError ? <Text style={[styles.error, { color: theme.danger }]}>{setupError}</Text> : null}
      {resolution === null && !setupError && owner ? <ActivityIndicator color={theme.accent} /> : null}
      {resolution && !resolution.ok ? <WarningBox>{resolution.reason}</WarningBox> : null}
      {resolution?.ok ? (
        <>
          {!evmChain.testnet ? <Text style={[styles.hint, { color: theme.textMuted }]}>{SESSIONS_AUDIT_NOTE}</Text> : null}
          <Button
            title="Grant a new session"
            onPress={() => {
              setFormError(null);
              setPhase('form');
            }}
            disabled={listFlags.unreadable || readiness !== null}
          />
          <Button
            title="New subscription"
            variant="secondary"
            onPress={() => onSubOpen('subscription')}
            disabled={listFlags.unreadable || readiness !== null}
          />
          <Button
            title="New recurring payment"
            variant="secondary"
            onPress={() => onSubOpen('recurring')}
            disabled={listFlags.unreadable || readiness !== null}
          />
          {dueHeadline ? <WarningBox>{dueHeadline}</WarningBox> : null}
          {listFlags.unreadable ? (
            <>
              <WarningBox>
                The saved session list could not be read. Nothing was changed. Grants on-chain are not
                affected.
              </WarningBox>
              <Button title="Reset session list" variant="destructive" onPress={onResetList} />
            </>
          ) : listFlags.corrupt ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Some saved sessions could not be read and are not shown.
            </Text>
          ) : null}
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Recurring payments</Text>
          {recurringList.length === 0 ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>None on this device.</Text>
          ) : (
            <Text style={[styles.hint, { color: theme.textMuted }]}>{RECURRING_CARD_NOTE}</Text>
          )}
          {recurringList.map(({ record: r, key, due }) => {
            const status = statuses[key];
            const settled = status !== undefined && status !== 'loading';
            const terms = termsOf(r);
            const review = recurringReview(terms, {
              tokenSymbol: r.subscription!.tokenSymbol,
              tokenDecimals: r.subscription!.tokenDecimals,
              nativeSymbol: symbol,
              payeeName: nameFor(terms.merchant),
              endsAt: recurringEndsAt(r),
            });
            const busy = payingKey !== null;
            const statusLine = settled ? sessionStatusText(status) : 'Reading status…';
            return (
              <View key={key} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <Text style={[styles.cardTitle, { color: theme.text }]}>{r.label}</Text>
                <Text style={[styles.hint, { color: theme.text }]}>{recurringSummary(r, nameFor(terms.merchant))}</Text>
                <Text style={[styles.status, { color: settled && status.kind === 'active' ? theme.success : theme.text }]}>
                  {statusLine}
                </Text>
                {due
                  ? recurringStatusLines(r, due, symbol, statusLine).map((line) => (
                      <Text key={line} style={[styles.hint, { color: theme.text }]}>
                        {line}
                      </Text>
                    ))
                  : null}
                <Text style={[styles.hint, { color: theme.textMuted }]}>{recurringKeyStatusText(r)}</Text>
                <Text style={[styles.hint, { color: theme.textMuted }]}>{sessionLocalStatusText(r)}</Text>
                {pendingSessionOperation(r) || payingKey === key ? <ActivityIndicator color={theme.accent} /> : null}
                {payRefusals[key] ? <WarningBox>{payRefusals[key]}</WarningBox> : null}
                {due?.kind === 'due' ? (
                  <Button
                    title="Send the payment now"
                    accessibilityHint="Checks the payment with the network, then asks you to confirm before anything is sent."
                    onPress={() => void onPayNow(r)}
                    disabled={busy || readiness !== null}
                  />
                ) : null}
                <Button
                  title="Refresh status"
                  variant="secondary"
                  accessibilityLabel={`Refresh the status of ${r.label}`}
                  onPress={() => refreshRecord(r)}
                />
                {review.caveats[0] && cardShowsBatchingWarning(r, status, due?.kind === 'completed') ? (
                  <WarningBox>{review.caveats[0]}</WarningBox>
                ) : null}
                <Text style={[styles.hint, { color: theme.text }]}>{review.sentence}</Text>
                <Row label="Permission id" value={r.permissionId} mono theme={theme} />
                {r.installUserOpHash ? (
                  <Row label="Set-up UserOperation hash" value={r.installUserOpHash} mono theme={theme} />
                ) : null}
                {r.revokeUserOpHash ? (
                  <Row label="Revocation UserOperation hash" value={r.revokeUserOpHash} mono theme={theme} />
                ) : null}
                {due?.kind === 'completed' && settled && status.kind === 'active' ? (
                  <>
                    <WarningBox>{RECURRING_COMPLETED_TEXT}</WarningBox>
                    <Button
                      title="Revoke and forget"
                      variant="destructive"
                      onPress={() => void onRevokeQuote(r, { forgetAfter: true })}
                      disabled={busy}
                    />
                  </>
                ) : settled && (status.kind === 'active' || status.kind === 'unknown') ? (
                  <Button
                    title="Revoke (stop the recurring payment)"
                    variant="destructive"
                    onPress={() => void onRevokeQuote(r)}
                    disabled={busy}
                  />
                ) : null}
                {settled && (status.kind === 'revoked' || status.kind === 'not-installed') ? (
                  <Button title="Forget" variant="secondary" onPress={() => onForget(r)} />
                ) : null}
              </View>
            );
          })}
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Subscriptions</Text>
          {records.filter((r) => r.source === 'subscription').length === 0 ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>None on this device.</Text>
          ) : null}
          {sortSubscriptionRecords(records.filter((r) => r.source === 'subscription' && r.subscription)).map(
            (r) => {
              const key = sessionRecordKey(r.chain, r.account, r.permissionId);
              const status = statuses[key];
              const subStatus = subStatuses[key];
              const terms = termsOf(r);
              const review = subscriptionReview(terms, {
                tokenSymbol: r.subscription!.tokenSymbol,
                tokenDecimals: r.subscription!.tokenDecimals,
                nativeSymbol: symbol,
                merchantName: nameFor(terms.merchant),
              });
              const settled = status !== undefined && status !== 'loading';
              // Old records keep their stored label; the title is derived here.
              const title = subscriptionDisplayTitle(r, nameFor(terms.merchant));
              const handover = subscriptionHandoverOffer(r, status);
              return (
                <View key={key} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
                  <Text style={[styles.cardTitle, { color: theme.text }]}>{title}</Text>
                  <Text style={[styles.hint, { color: theme.text }]}>{subscriptionSummary(r, nameFor(terms.merchant))}</Text>
                  <Text style={[styles.status, { color: settled && status.kind === 'active' ? theme.success : theme.text }]}>
                    {settled ? sessionStatusText(status) : 'Reading status…'}
                  </Text>
                  {subStatus === undefined || subStatus === 'loading'
                    ? null
                    : subscriptionStatusLines(r, subStatus, symbol).map((line) => (
                        <Text key={line} style={[styles.hint, { color: theme.text }]}>
                          {line}
                        </Text>
                      ))}
                  <Text style={[styles.hint, { color: theme.textMuted }]}>{subscriptionKeyStatusText(r, handover)}</Text>
                  <Text style={[styles.hint, { color: theme.textMuted }]}>{sessionLocalStatusText(r)}</Text>
                  {pendingSessionOperation(r) ? <ActivityIndicator color={theme.accent} /> : null}
                  <Button
                    title="Refresh status"
                    variant="secondary"
                    accessibilityLabel={`Refresh the status of ${title}`}
                    onPress={() => refreshRecord(r)}
                  />
                  {review.caveats[0] &&
                  cardShowsBatchingWarning(
                    r,
                    status,
                    subStatus !== undefined &&
                      subStatus !== 'loading' &&
                      subStatus.kind === 'ok' &&
                      (subStatus.next.kind === 'used-up' || subStatus.next.kind === 'ended'),
                  ) ? (
                    <WarningBox>{review.caveats[0]}</WarningBox>
                  ) : null}
                  <Text style={[styles.hint, { color: theme.text }]}>{review.sentence}</Text>
                  <Row label="Permission id" value={r.permissionId} mono theme={theme} />
                  {r.installUserOpHash ? (
                    <Row label="Install UserOperation hash" value={r.installUserOpHash} mono theme={theme} />
                  ) : null}
                  {r.revokeUserOpHash ? (
                    <Row label="Revocation UserOperation hash" value={r.revokeUserOpHash} mono theme={theme} />
                  ) : null}
                  {handover === 'offer' ? (
                    <Button title="Hand the key to the merchant (shown once)" onPress={() => void onShowKey(r)} />
                  ) : null}
                  {handover === 'expired' ? <WarningBox>{SUBSCRIPTION_EXPIRED_UNHANDED_TEXT}</WarningBox> : null}
                  {settled && (status.kind === 'active' || status.kind === 'unknown') ? (
                    <Button title="Revoke (stop the subscription)" variant="destructive" onPress={() => void onRevokeQuote(r)} />
                  ) : null}
                  {settled && (status.kind === 'revoked' || status.kind === 'not-installed') ? (
                    <Button title="Forget" variant="secondary" onPress={() => onForget(r)} />
                  ) : null}
                </View>
              );
            },
          )}
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Sessions on this account</Text>
          {records.filter((r) => !sessionCarriesTerms(r.source)).length === 0 ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>None on this device.</Text>
          ) : null}
          {records.filter((r) => !sessionCarriesTerms(r.source)).map((r) => {
            const key = sessionRecordKey(r.chain, r.account, r.permissionId);
            const status = statuses[key];
            const grant = parseSessionKeyGrant(r.grant);
            const active = status !== undefined && status !== 'loading' && status.kind === 'active';
            const usable = active && !(status as { expired: boolean }).expired;
            return (
              <View key={key} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <Text style={[styles.cardTitle, { color: theme.text }]}>
                  {r.label}
                  {r.source === 'erc7715' ? ' · requested over WalletConnect (ERC-7715)' : ''}
                </Text>
                <Text style={[styles.hint, { color: theme.textMuted }]}>
                  Created {new Date(r.createdAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} ·
                  key {r.keyHeld ? 'on this device' : r.source === 'erc7715' ? 'held by the dApp' : 'deleted'}
                </Text>
                <Text
                  style={[
                    styles.status,
                    { color: active ? theme.success : status === 'loading' || status === undefined ? theme.textMuted : theme.text },
                  ]}
                >
                  {status === undefined || status === 'loading' ? 'Reading status…' : sessionStatusText(status)}
                </Text>
                <Text style={[styles.hint, { color: theme.textMuted }]}>{sessionLocalStatusText(r)}</Text>
                {pendingSessionOperation(r) ? <ActivityIndicator color={theme.accent} /> : null}
                {r.installUserOpHash ? (
                  <Row label="Install UserOperation hash" value={r.installUserOpHash} mono theme={theme} />
                ) : null}
                {r.revokeUserOpHash ? (
                  <Row label="Revocation UserOperation hash" value={r.revokeUserOpHash} mono theme={theme} />
                ) : null}
                <GrantReview
                  grant={grant}
                  account={r.account}
                  symbol={symbol}
                  nameFor={nameFor}
                  sessionKeyHolder={r.keyHeld ? 'this device' : r.source === 'erc7715' ? r.label : 'nobody (deleted)'}
                  permissionId={r.permissionId}
                />
                {usable && sessionCanBeTested(r)
                  ? grant.calls.map((c, i) => (
                      <Button
                        key={`t${i}`}
                        title={`Test this session (allowed call ${i + 1})`}
                        variant="secondary"
                        onPress={() => void onTest(r, i)}
                        disabled={readiness !== null}
                      />
                    ))
                  : null}
                {status !== undefined && status !== 'loading' && (status.kind === 'active' || status.kind === 'unknown') ? (
                  <Button title="Revoke" variant="destructive" onPress={() => void onRevokeQuote(r)} />
                ) : null}
                {status !== undefined && status !== 'loading' && (status.kind === 'revoked' || status.kind === 'not-installed') ? (
                  <Button title="Forget" variant="secondary" onPress={() => onForget(r)} />
                ) : null}
              </View>
            );
          })}
          <Button title="Refresh status" variant="secondary" onPress={() => reloadList()} />
        </>
      ) : null}
    </ScrollView>
  );
}

/**
 * The active account's session context: its AA bundle (from the verified
 * configuration, with the owner so an EIP-7702-upgraded account gets the
 * kernel-7702 bundle), whether a session can live there, and the contacts
 * network id for name lookups.
 */
async function loadSessionContext(
  owner: string,
  accountIndex: number,
  caip2: string,
  chainId: bigint,
): Promise<{ bundle: AaClientBundle | null; resolution: SessionAccountResolution; contactsNetworkId: string }> {
  const endpoint = await getEndpoint(EVM_CHAIN_ID);
  if (!endpoint?.url) throw new Error('No RPC endpoint is configured for this network.');
  const config = await getAaConfig(caip2);
  let bundle: AaClientBundle;
  try {
    bundle = createAaClientFromConfig(config, { nodeUrl: endpoint.url, chainId, accountIndex, ownerAddress: owner });
  } catch (e) {
    return {
      bundle: null,
      resolution: {
        ok: false,
        reason: `${e instanceof Error ? e.message : String(e)} Sessions need a verified bundler and a Kernel v3.3 account.`,
      },
      contactsNetworkId: endpoint.network.chainId,
    };
  }
  return { bundle, resolution: await resolveSessionAccount(bundle, owner), contactsNetworkId: endpoint.network.chainId };
}

function NetworkBadge({ label, testnet, theme }: { label: string; testnet: boolean; theme: Theme }) {
  if (testnet) {
    return (
      <View style={[styles.badge, { backgroundColor: theme.testnetFill, borderColor: theme.testnetFill }]}>
        <Text style={[styles.badgeText, { color: theme.onTestnetFill }]}>{label} TESTNET — test funds only</Text>
      </View>
    );
  }
  return (
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
      <Text selectable style={[styles.rowValue, { color: theme.text }, monoFont ? { fontFamily: mono, fontSize: 13 } : null]}>
        {value}
      </Text>
      {sub ? (
        <Text selectable style={[styles.rowSub, { color: theme.textMuted }]}>
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 14 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 10, padding: 12 },
  title: { fontSize: 18, fontWeight: '700' },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginTop: 8 },
  networkLine: { fontSize: 13 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 4 },
  hint: { fontSize: 13, lineHeight: 19 },
  ok: { fontSize: 15, fontWeight: '600' },
  status: { fontSize: 15, fontWeight: '600' },
  error: { fontSize: 14, lineHeight: 20 },
  monoText: { fontFamily: mono, fontSize: 13 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  rowButtons: { gap: 8 },
  badge: { borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  badgeText: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8, gap: 2 },
  rowLabel: { fontSize: 12, fontWeight: '600' },
  rowValue: { fontSize: 15 },
  rowSub: { fontSize: 12, lineHeight: 17 },
});

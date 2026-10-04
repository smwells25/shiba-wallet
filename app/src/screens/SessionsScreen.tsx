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
import { useFocusEffect } from '@react-navigation/native';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import {
  NodeClient,
  SUBSCRIPTION_NATIVE,
  describePeriod,
  parseSessionKeyGrant,
  subscriptionPeriodCount,
  toHex,
  type KernelPermissionInstall,
  type SessionKeyGrant,
  type SubscriptionGrant,
} from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, TestNetworksOnlyCard, WarningBox, screenStyle } from '../components';
import { ContactPicker, RecipientContactNotice } from '../components/Contacts';
import { GrantReview } from '../components/SessionGrantViews';
import { PayloadQr } from '../components/RecoveryViews';
import { SubscriptionKeyHandoverActions } from '../components/SubscriptionKeyHandover';
import { useTheme, type Theme } from '../theme';
import { getEndpoint } from '../config/networks';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits, parseUnits } from '../wallet/balances';
import { EVM_CHAIN_ID, describeSendError } from '../wallet/send';
import {
  createAaClientFromConfig,
  describeAaError,
  getAaConfig,
  retitleQuoteFailure,
  sendAa,
  summarizeAaReceipt,
  type AaClientBundle,
  type AaSendQuote,
} from '../wallet/aa';
import { findExactContact, listContacts, matchRecipient, type Contact } from '../wallet/contacts';
import { sessionKeyVault } from '../wallet/storage';
import { readinessGate } from '../config/readiness';
import {
  SESSIONS_AUDIT_NOTE,
  SESSIONS_INSTALL_MODE_NOTE,
  SESSIONS_WIPE_WARNING,
  SESSION_EXPIRY_PRESETS,
  buildManualGrant,
  finalizeSessionInstall,
  finalizeSessionRevoke,
  forgetSession,
  installSession,
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
  SUBSCRIPTION_REQUOTE_MESSAGE,
  SUBSCRIPTION_REQUOTE_TITLE,
  SUBSCRIPTION_START_NOTE,
  buildSubscription,
  buildSubscriptionKeyExport,
  customPeriodSeconds,
  feeBudgetCapNote,
  markSubscriptionKeyExported,
  readSubscriptionStatus,
  restartSubscriptionAt,
  sortSubscriptionRecords,
  subscriptionDisplayTitle,
  subscriptionFinalDatesLine,
  subscriptionGrantFor,
  subscriptionHandoverOffer,
  subscriptionInstallFunding,
  subscriptionInstallKeepBack,
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
  suggestedFeeBudget,
  termsOf,
  type SubscriptionStatus,
  type SubscriptionTokenChoice,
} from '../wallet/subscriptions';

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
const EMPTY_DRAFT: AllowedCallDraft = { target: '', selector: '', valueCapEth: '' };

interface PendingInstall {
  /** In memory only until the install is submitted (then in the vault) or discarded (zeroed). */
  privateKey: Uint8Array;
  grant: SessionKeyGrant;
  install: KernelPermissionInstall;
  quote: AaSendQuote;
}

/** A reviewed subscription waiting for the owner's approval (same lifetime rules as PendingInstall). */
interface PendingSubscription extends PendingInstall {
  subscription: SubscriptionGrant;
  choice: SubscriptionTokenChoice;
  /** The list card's title ("Subscription: <name>" or "Subscription to 0x…"). */
  recordLabel: string;
  /**
   * Set when Review lowered the unedited fee-budget pre-fill so that the
   * install's own worst-case fee is kept back (wei).
   */
  feeBudgetLowered?: { from: bigint; to: bigint; keptBack: bigint } | null;
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
  const [revokeTarget, setRevokeTarget] = useState<{ record: SessionRecord; quote: AaSendQuote } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [subForm, setSubForm] = useState<SubscriptionFormState>(EMPTY_SUBSCRIPTION_FORM);
  const [subPickerOpen, setSubPickerOpen] = useState(false);
  const subPending = useRef<PendingSubscription | null>(null);
  const [subPendingView, setSubPendingView] = useState<PendingSubscription | null>(null);
  const [subStatuses, setSubStatuses] = useState<Record<string, SubscriptionStatus | 'loading'>>({});
  /** Facts for the fee-budget suggestion: the node's fee and the Kernel account's balance (null until read). */
  // The part of the install's worst-case fee the balance pays, from the last
  // review quote (null before the first review): the fee-budget pre-fill
  // keeps it back.
  const [subInstallKeepBack, setSubInstallKeepBack] = useState<bigint | null>(null);
  const [subFeeFacts, setSubFeeFacts] = useState<{ maxFeePerGas: bigint | null; balance: bigint | null }>({
    maxFeePerGas: null,
    balance: null,
  });
  /** What the subscription confirm's spinner is doing: re-quoting with the restarted clock, or signing. */
  const [subSendStage, setSubSendStage] = useState<'requote' | 'signing'>('signing');
  /** The key hand-over payload: in memory only while the export screen is open. */
  const [keyExport, setKeyExport] = useState<{ record: SessionRecord; text: string; fileName: string } | null>(null);
  const tokenChoices = useMemo(() => subscriptionTokenChoices(evmChain.caip2, symbol), [evmChain.caip2, symbol]);

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
      (e: unknown) => setSetupError(e instanceof Error ? e.message : String(e)),
    );
  }, [owner, activeAccount, evmChain.caip2, evmChain.chainIdDecimal]);
  useEffect(setup, [setup]);

  // Operations this screen instance is already waiting for (its own sends,
  // and ones resumed from the stored list below), by userOpHash.
  const waitingFor = useRef(new Set<string>());
  const reloadRef = useRef<() => void>(() => undefined);
  /** Re-reads one record's on-chain status (and its subscription counters), and resumes an unsettled operation. */
  const refreshRecord = useCallback(
    (r: SessionRecord) => {
      if (!bundle) return;
      const key = sessionRecordKey(r.chain, r.account, r.permissionId);
      setStatuses((prev) => ({ ...prev, [key]: 'loading' }));
      void readSessionStatus(bundle.node, r).then((st) => setStatuses((prev) => ({ ...prev, [key]: st })));
      if (r.source === 'subscription' && r.subscription) {
        setSubStatuses((prev) => ({ ...prev, [key]: 'loading' }));
        void readSubscriptionStatus(bundle.node, r).then((st) => setSubStatuses((prev) => ({ ...prev, [key]: st })));
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
    [bundle],
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

  useEffect(() => {
    if (!contactsNetworkId) return;
    listContacts(contactsNetworkId).then(setContacts, () => setContacts([]));
  }, [contactsNetworkId]);
  const nameFor = useCallback(
    (address: string) => (contactsNetworkId ? (findExactContact(contactsNetworkId, address, contacts)?.name ?? null) : null),
    [contacts, contactsNetworkId],
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
      const { install, quote } = await prepareSessionInstall(bundle, owner, account, grant, { now });
      pending.current = { privateKey: key.privateKey, grant, install, quote };
      setPendingView(pending.current);
      setPhase('confirm');
    } catch (e) {
      key.privateKey.fill(0);
      const { title, detail } =
        describeAaError(e, { accountType: bundle.accountType, deployed: true }) ?? describeSendError(e, symbol);
      setFormError(`${title}\n${detail}`);
      setPhase('form');
    }
  };

  const onInstall = async () => {
    const p = pending.current;
    if (!p || !bundle || !account || !owner || !resolution?.ok || !activeAccount) return;
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
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(bundle, signer, q)),
      });
      discardPending();
      waitingFor.current.add(userOpHash);
      setProgress({ kind: 'install', userOpHash, state: 'pending', txHash: null, detail: null });
      setPhase('progress');
      void finalizeSessionInstall(bundle, record, AsyncStorage).then(
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
      const { title, detail } =
        describeAaError(e, { accountType: bundle.accountType, deployed: true }) ?? describeSendError(e, symbol);
      Alert.alert(title, detail);
      setPhase('confirm');
      reloadList();
    }
  };

  // ------------------------------------------------------------ subscriptions

  const onSubOpen = () => {
    setFormError(null);
    // "2 minutes (testing)" exists only on test networks: start from the
    // first preset this network offers.
    setSubForm({ ...EMPTY_SUBSCRIPTION_FORM, periodSeconds: subscriptionPeriodPresets(evmChain.testnet)[0]!.seconds });
    setSubFeeFacts({ maxFeePerGas: null, balance: null });
    setSubInstallKeepBack(null);
    setPhase('sub-form');
    if (!bundle || !account) return;
    // Facts for the fee-budget suggestion (shown and editable): the node's
    // current fee and what the Kernel account holds.
    const node = new NodeClient(bundle.node);
    node.suggestFees().then(
      (fees) => setSubFeeFacts((prev) => ({ ...prev, maxFeePerGas: fees.maxFeePerGas })),
      () => undefined,
    );
    node.getBalance(account).then(
      (balance) => setSubFeeFacts((prev) => ({ ...prev, balance })),
      () => undefined,
    );
  };

  /**
   * The fee budget the form shows: the user's own figure once typed, else
   * the suggestion for the current payment count, capped at what the
   * account can spare (findings 3 of the rehearsal).
   */
  const subChoice = tokenChoices[subForm.choiceIndex];
  let subNativeAmount = 0n;
  if (subChoice?.token === SUBSCRIPTION_NATIVE) {
    try {
      subNativeAmount = parseUnits(subForm.amount.trim(), 18);
    } catch {
      subNativeAmount = 0n;
    }
  }
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
    const key = newSessionKey();
    const now = Math.floor(Date.now() / 1000);
    let subscription: SubscriptionGrant;
    let grant: SessionKeyGrant;
    const names = subscriptionNames(subForm.label, subForm.merchant, nameFor(subForm.merchant.trim()));
    try {
      subscription = buildSubscription(
        {
          merchant: subForm.merchant,
          choice,
          amount: subForm.amount,
          periodSeconds,
          payments: subForm.payments,
          feeBudget: subFeeBudgetText,
          label: names.termsLabel,
        },
        { now, account, testnet: evmChain.testnet },
      );
      // The engine's refusal (validateSubscription / validateSessionKeyGrant) verbatim.
      grant = subscriptionGrantFor(subscription, key.address, { account, now });
    } catch (e) {
      key.privateKey.fill(0);
      setFormError(e instanceof Error ? e.message : String(e));
      return;
    }
    setPhase('sub-quoting');
    try {
      let { install, quote } = await prepareSessionInstall(bundle, owner, account, grant, { now });
      // Finding 2 of the 2026-10-04 verification: an UNEDITED fee-budget
      // pre-fill must keep back the install's own worst-case fee. The install
      // is quoted first (its fee barely depends on the budget), the pre-fill
      // is recomputed with that fee kept back, and when it no longer fits the
      // budget is lowered and the install quoted again (the budget is part of
      // the GasPolicy data the install writes). A typed budget is never
      // changed; the review's funding lines cover it.
      let feeBudgetLowered: PendingSubscription['feeBudgetLowered'] = null;
      if (!subForm.feeEdited) {
        const keptBack = subscriptionInstallKeepBack(quote);
        setSubInstallKeepBack(keptBack);
        const refit = suggestedFeeBudget({
          payments: subscriptionPeriodCount(subscription),
          maxFeePerGas: subFeeFacts.maxFeePerGas,
          balance: quote.senderBalance,
          nativeAmountPerPayment: subscription.token === SUBSCRIPTION_NATIVE ? subscription.amountPerPeriod : 0n,
          installFeeFromBalance: keptBack,
        });
        if (refit.wei === null) {
          key.privateKey.fill(0);
          setFormError(
            refit.spare !== null && refit.uncapped !== null
              ? feeBudgetCapNote(refit.spare, refit.uncapped, symbol, keptBack)
              : 'The fee budget could not be suggested: the network fee is not known yet. Enter a budget by hand.',
          );
          setPhase('sub-form');
          return;
        }
        if (refit.wei < subscription.feeBudgetWei) {
          feeBudgetLowered = { from: subscription.feeBudgetWei, to: refit.wei, keptBack };
          subscription = { ...subscription, feeBudgetWei: refit.wei };
          grant = subscriptionGrantFor(subscription, key.address, { account, now });
          ({ install, quote } = await prepareSessionInstall(bundle, owner, account, grant, { now }));
        }
      }
      subPending.current = {
        privateKey: key.privateKey,
        grant,
        install,
        quote,
        subscription,
        choice,
        recordLabel: names.recordLabel,
        feeBudgetLowered,
      };
      setSubPendingView(subPending.current);
      setPhase('sub-confirm');
    } catch (e) {
      key.privateKey.fill(0);
      const { title, detail } =
        describeAaError(e, { accountType: bundle.accountType, deployed: true }) ?? describeSendError(e, symbol);
      setFormError(`${title}\n${detail}`);
      setPhase('sub-form');
    }
  };

  const onSubInstall = async () => {
    const reviewed = subPending.current;
    if (!reviewed || !bundle || !account || !owner || !resolution?.ok || !activeAccount) return;
    // Finding 1 of the rehearsal: the clock starts NOW, when Start was tapped,
    // not when Review opened. The restarted terms change the policy data and
    // the permission id, so the install is quoted again (same session key,
    // same calls and sizes); only a fee rise beyond the tolerance sends the
    // user back to the review. Done before the biometric gate, so the
    // approval prompt is followed directly by signing.
    setSubSendStage('requote');
    setPhase('sub-sending');
    let p: PendingSubscription;
    try {
      const now = Math.floor(Date.now() / 1000);
      const restarted = restartSubscriptionAt(reviewed.subscription, now);
      const grant = subscriptionGrantFor(restarted, reviewed.grant.sessionKey, { account, now });
      const { install, quote } = await prepareSessionInstall(bundle, owner, account, grant, { now });
      p = { ...reviewed, subscription: restarted, grant, install, quote };
    } catch (e) {
      const { title, detail } = retitleQuoteFailure(
        describeAaError(e, { accountType: bundle.accountType, deployed: true }) ?? describeSendError(e, symbol),
      );
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
    const auth = await requireLocalAuth('Approve this subscription');
    if (!auth.ok) {
      Alert.alert('Not granted', auth.message);
      setPhase('sub-confirm');
      return;
    }
    setSubSendStage('signing');
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
        source: 'subscription',
        subscription: subscriptionMeta(p.subscription, p.choice),
        // Kept in the vault only until it is handed to the merchant.
        sessionPrivateKey: p.privateKey,
        store: AsyncStorage,
        vault: sessionKeyVault,
        // Same explicit, owner-signed install as every session.
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(bundle, signer, q)),
      });
      const finalTerms = subscriptionFinalDatesLine(p.subscription);
      discardPending();
      waitingFor.current.add(userOpHash);
      setProgress({ kind: 'subscription', userOpHash, state: 'pending', txHash: null, detail: null, finalTerms });
      setPhase('progress');
      void finalizeSessionInstall(bundle, record, AsyncStorage).then(
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
      const { title, detail } =
        describeAaError(e, { accountType: bundle.accountType, deployed: true }) ?? describeSendError(e, symbol);
      Alert.alert(title, detail);
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
                Alert.alert('Session test refused', e instanceof Error ? e.message : String(e));
              }
            })();
          },
        },
      ],
    );
  };

  const onRevokeQuote = async (record: SessionRecord) => {
    if (!bundle || !owner) return;
    try {
      const quote = await prepareSessionRevoke(bundle, owner, record);
      setRevokeTarget({ record, quote });
      setPhase('revoke-confirm');
    } catch (e) {
      const { title, detail } =
        describeAaError(e, { accountType: bundle.accountType, deployed: true }) ?? describeSendError(e, symbol);
      Alert.alert(title, detail);
    }
  };

  const onRevoke = async () => {
    if (!revokeTarget || !bundle || !owner) return;
    const auth = await requireLocalAuth('Approve revoking this session');
    if (!auth.ok) {
      Alert.alert('Not revoked', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const { record, userOpHash } = await revokeSession({
        record: revokeTarget.record,
        quote: revokeTarget.quote,
        store: AsyncStorage,
        vault: sessionKeyVault,
        submit: (q) => signWith(EVM_CHAIN_ID, owner, (signer) => sendAa(bundle, signer, q)),
      });
      setRevokeTarget(null);
      waitingFor.current.add(userOpHash);
      setProgress({ kind: 'revoke', userOpHash, state: 'pending', txHash: null, detail: null });
      setPhase('progress');
      void finalizeSessionRevoke(bundle, record, AsyncStorage).then(
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
      const { title, detail } =
        describeAaError(e, { accountType: bundle.accountType, deployed: true }) ?? describeSendError(e, symbol);
      Alert.alert(title, detail);
      setPhase('revoke-confirm');
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
            (e: unknown) => Alert.alert('Kept', e instanceof Error ? e.message : String(e)),
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
        {progress.txHash ? (
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
    const review = subscriptionReview(sub, {
      tokenSymbol: subPendingView.choice.symbol,
      tokenDecimals: subPendingView.choice.decimals,
      nativeSymbol: symbol,
      merchantName: nameFor(sub.merchant),
    });
    const [batchCaveat, ...otherCaveats] = review.caveats;
    const shortWindow = subscriptionShortWindowWarning(sub);
    const funding = subscriptionInstallFunding(q, sub, symbol);
    const lowered = subPendingView.feeBudgetLowered;
    return (
      <ScrollView key="sub-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.title, { color: theme.text }]}>Start this subscription?</Text>
        {header}
        {/* Order as recorded for phase 12 item 2 and DEMO step 10: the batch
            warning FIRST, then the plain sentence, then the on-chain lines. */}
        {batchCaveat ? <WarningBox>{batchCaveat}</WarningBox> : null}
        <Text style={[styles.ok, { color: theme.text }]}>{review.sentence}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{SUBSCRIPTION_START_NOTE}</Text>
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
        <Text style={[styles.hint, { color: theme.textMuted }]}>{SUBSCRIPTION_AUDIT_NOTE}</Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>Technical details (the grant as installed)</Text>
        <GrantReview
          grant={subPendingView.grant}
          account={account}
          symbol={symbol}
          nameFor={nameFor}
          sessionKeyHolder={SUBSCRIPTION_KEY_HOLDER_TEXT}
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
          label={q.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={q.sponsored ? 'Sponsored — the account pays 0' : `${formatUnits(q.fee, 18, 18)} ${symbol}`}
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
            {funding.canStart ? (
              <Button title="Start subscription" onPress={() => void onSubInstall()} />
            ) : null}
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
    return (
      <ScrollView key="sub-form" style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: theme.text }]}>New subscription</Text>
        {header}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Lets one merchant take up to a fixed amount once per period, until the payments run out or you
          revoke. A new key is created for the merchant; your account enforces the limits on-chain.
        </Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>Merchant (receives the payments)</Text>
        <TextInput
          value={subForm.merchant}
          onChangeText={(t) => setSubForm((prev) => ({ ...prev, merchant: t }))}
          placeholder="Merchant address (0x…)"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Merchant address"
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
          placeholder={`Total ${symbol} the merchant's payments may spend on network fees`}
          placeholderTextColor={theme.textMuted}
          keyboardType="decimal-pad"
          accessibilityLabel="Fee budget"
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Each payment’s network fee is paid by your account. The budget caps the total; without it a merchant
          could pay itself high fees from your {symbol}.
        </Text>
        {!subForm.feeEdited ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Suggested from today’s network fee for the number of payments above; it follows that number until you
            type your own figure.
          </Text>
        ) : null}
        {!subForm.feeEdited && feeSuggestion.capped && feeSuggestion.spare !== null && feeSuggestion.uncapped !== null ? (
          <WarningBox>{feeBudgetCapNote(feeSuggestion.spare, feeSuggestion.uncapped, symbol)}</WarningBox>
        ) : null}
        <Text style={[styles.label, { color: theme.textMuted }]}>Name (optional)</Text>
        <TextInput
          value={subForm.label}
          onChangeText={(t) => setSubForm((prev) => ({ ...prev, label: t }))}
          placeholder="e.g. the service’s name"
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
    return (
      <ScrollView key="revoke-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.title, { color: theme.text }]}>Revoke session “{revokeTitle}”</Text>
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
        <Text style={[styles.ok, { color: theme.success }]}>Bundler gas estimate passed.</Text>
        {phase === 'sending' ? (
          <ActivityIndicator size="large" color={theme.accent} />
        ) : (
          <>
            <Button title="Revoke session" variant="destructive" onPress={() => void onRevoke()} />
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
            onPress={onSubOpen}
            disabled={listFlags.unreadable || readiness !== null}
          />
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
                  <Text style={[styles.hint, { color: theme.textMuted }]}>{subscriptionKeyStatusText(r)}</Text>
                  <Text style={[styles.hint, { color: theme.textMuted }]}>{sessionLocalStatusText(r)}</Text>
                  {pendingSessionOperation(r) ? <ActivityIndicator color={theme.accent} /> : null}
                  <Button
                    title="Refresh status"
                    variant="secondary"
                    accessibilityLabel={`Refresh the status of ${title}`}
                    onPress={() => refreshRecord(r)}
                  />
                  {review.caveats[0] ? <WarningBox>{review.caveats[0]}</WarningBox> : null}
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
          {records.filter((r) => r.source !== 'subscription').length === 0 ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>None on this device.</Text>
          ) : null}
          {records.filter((r) => r.source !== 'subscription').map((r) => {
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

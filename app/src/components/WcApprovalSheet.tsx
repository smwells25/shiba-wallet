import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import {
  classifyRecipient,
  type KernelPermissionInstall,
  type RecipientClass,
  type SessionKeyGrant,
} from '@shiba-wallet/chains-evm';
import { Button, WarningBox } from '../components';
import { BalanceChangePreview } from './BalanceChangePreview';
import { GrantReview } from './SessionGrantViews';
import { RiskWarnings } from './RiskWarnings';
import { getEndpoint } from '../config/networks';
import type { EvmChainProfile } from '../config/evm-chain';
import { useTheme, type Theme } from '../theme';
import { formatUnits } from '../wallet/balances';
import { usePrefs } from '../wallet/PrefsContext';
import { listTokens } from '../wallet/tokens';
import { listContacts, matchRecipient, type Contact } from '../wallet/contacts';
import {
  spenderRiskWarnings,
  summarizeTypedData,
  type TrackedTokenRef,
  type TypedDataSummary,
} from '../wallet/typed-data-summary';
import { RecipientContactNotice } from './Contacts';
import { EVM_CHAIN_ID, describeSendError, type EvmSendQuote } from '../wallet/send';
import {
  KERNEL_BUNDLER_NOTE,
  PREVIEW_AA_BATCH_NOTE,
  aaAccountTypeLabel,
  describeAaError,
  prepareAaCalls,
  type AaAccountType,
  type AaClientBundle,
  type AaSendQuote,
} from '../wallet/aa';
import { PREVIEW_AA_NOTE, simulationTransport } from '../wallet/simulation';
import {
  ERC7715_LIMITATION_NOTE,
  SESSIONS_AUDIT_NOTE,
  SESSIONS_INSTALL_MODE_NOTE,
  SESSION_EXPIRY_PRESETS,
  narrowGrant,
  prepareSessionInstall,
} from '../wallet/sessions';
import {
  IDENTITY_RISK_SWITCH_LABEL,
  WC_REQUOTED_NOTE,
  WC_SUPPORTED_METHODS,
  decideProposal,
  identityApprovalAllowed,
  quoteWcTransaction,
  requoteWcTransactionIfMoved,
  smartAccountMethodsFor,
  describeChain,
  type ParsedWcRequest,
  type WcProposalSummary,
  type WcRequestEvent,
  type WcSmartBinding,
  type WcDappIdentity,
  type WcTxParams,
  type WcTypedData,
} from '../wallet/walletconnect';
import type { WcQueueItem } from '../wallet/wc-controller';
import { passkeyRecordForAccount } from '../wallet/passkeys';
import { passkeyGateNow } from '../wallet/passkey-native';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

export type TxQuoteState =
  | { status: 'loading' }
  /**
   * Regular-account transaction: `url` is the endpoint that produced the
   * quote (after any failover); the preview, the risk checks and the send
   * all use it. `note` is set after an automatic re-quote at approval time
   * (WC_REQUOTED_NOTE).
   */
  | { status: 'ready'; quote: EvmSendQuote; url: string; from: string; note?: string }
  /**
   * Smart-account session (phase 7): the transaction or ERC-5792 batch
   * quoted as ONE UserOperation. Reaching this state means the bundler's
   * gas estimate (its simulation of the whole operation) passed — the AA
   * path's pre-flight gate.
   */
  | { status: 'ready-aa'; quote: AaSendQuote; bundle: AaClientBundle; url: string; owner: string }
  /**
   * ERC-7715 permission request (phase 8 item 2): the explicit, root-signed
   * session install for `grant` (possibly narrowed by the user), quoted as
   * ONE UserOperation — the bundler estimate passed.
   */
  | {
      status: 'ready-permission';
      quote: AaSendQuote;
      bundle: AaClientBundle;
      url: string;
      owner: string;
      install: KernelPermissionInstall;
      grant: SessionKeyGrant;
    }
  | { status: 'error'; message: string };

/**
 * The quote state a request starts in, decided synchronously from the
 * request and the current account: null when the item needs no quote, an
 * error for the refusals that need no network call, otherwise loading (the
 * quote effect then fills in the result). The branches mirror the quote
 * effect in WcApprovalSheet one for one; keep the two in step.
 */
function initialTxQuote(
  item: WcQueueItem,
  address: string | null,
  permissionGrant: SessionKeyGrant | null,
): TxQuoteState | null {
  if (item.type === 'request' && item.parsed.kind === 'permissions') {
    if (!item.smart || !permissionGrant) {
      return { status: 'error', message: 'Permission requests are served only on Kernel smart-account connections.' };
    }
    return { status: 'loading' };
  }
  if (
    item.type !== 'request' ||
    (item.parsed.kind !== 'transaction' && item.parsed.kind !== 'calls')
  ) {
    return null;
  }
  if (!address) return { status: 'error', message: 'Wallet account unavailable.' };
  if (!item.smart && item.parsed.kind !== 'transaction') {
    return { status: 'error', message: 'Batches are only served on smart-account connections.' };
  }
  return { status: 'loading' };
}

/** What the proposal sheet offers when a verified smart account exists. */
export interface SmartAccountOption {
  address: string;
  accountType: AaAccountType;
  signsMessages: boolean;
}

/** How the user chose to connect a proposal. */
export type ConnectAs = 'eoa' | 'smart';

/**
 * Who signs a message request on a Kernel smart-account session (phase 8
 * item 3): the owner key (default) or this device's passkey installed on
 * that smart account.
 */
export type MessageSigner = 'owner' | 'passkey';

/** Loads the ACTIVE chain's verified smart-account bundle for an account index. */
export type AaBundleLoader = (
  accountIndex: number,
) => Promise<{ bundle: AaClientBundle; url: string } | null>;

/**
 * The app-level WalletConnect approval sheet (phase 6, item 5): the
 * connection-request, sign-message, sign-typed-data and transaction
 * approval UIs, moved unchanged from the Connections screen so requests
 * surface on ANY screen. Rendered by WalletConnectContext as an in-tree,
 * absolutely positioned overlay rather than an RN Modal: a Modal is a
 * separate native window that would draw ABOVE LockGate's lock overlay,
 * while this view sits inside LockGate's children and is covered by it.
 * The provider additionally renders nothing while locked (useAppLock), so
 * the sheet is neither visible nor actionable behind the lock.
 *
 * The Android hardware back button is consumed while the sheet is up: a
 * request must be answered with an explicit button, never dismissed by
 * navigating the screen underneath.
 */
export function WcApprovalSheet({
  item,
  dappName,
  busy,
  evmChain,
  address,
  accountLabel,
  smartOption,
  loadAaBundle,
  onApprove,
  onReject,
}: {
  item: WcQueueItem;
  dappName: string;
  busy: boolean;
  /** Active EVM chain profile (badge, amount labels, namespace decision). */
  evmChain: EvmChainProfile;
  /**
   * The EVM address involved: for a proposal, the ACTIVE account's (the
   * one the connection would be bound to); for a request, the session's
   * bound account (equal to the active one, or the request is declined).
   * Null when unavailable.
   */
  address: string | null;
  /** "Account 2 (0x6Fac…b9C0)" for `address`, shown on every approval. */
  accountLabel: string | null;
  /**
   * Proposals only: resolves the active account's smart account when a
   * verified AA configuration exists for the active chain (else null).
   */
  smartOption: () => Promise<SmartAccountOption | null>;
  /** Smart-account requests: builds the bundle the quote runs through. */
  loadAaBundle: AaBundleLoader;
  /**
   * txQuote/override are null/false for everything but transactions;
   * connectAs is set for proposals only.
   */
  onApprove: (
    txQuote: TxQuoteState | null,
    overrideSimulation: boolean,
    connectAs?: ConnectAs,
    signer?: MessageSigner,
    /** The WalletConnect Verify risk switch (required for scam / mismatch). */
    identityAcknowledged?: boolean,
  ) => void;
  onReject: () => void;
}) {
  const theme = useTheme();
  // WalletConnect Verify (N-06): scam-flagged or origin-mismatched items
  // need this switch before any approve button works. Cleared per item.
  const [identityAck, setIdentityAck] = useState(false);
  const [identityKey, setIdentityKey] = useState(item.key);
  if (identityKey !== item.key) {
    setIdentityKey(item.key);
    setIdentityAck(false);
  }
  const approveLocked = !identityApprovalAllowed(item.identity, identityAck);
  const [messageSigner, setMessageSigner] = useState<MessageSigner>('owner');
  const [txQuote, setTxQuote] = useState<TxQuoteState | null>(null);
  const [overrideSimulation, setOverrideSimulation] = useState(false);
  // ERC-7715: the grant being reviewed — the dApp's, or a narrowed copy
  // when the dApp allowed adjustment. Re-quoted whenever it changes.
  const requestedGrant =
    item.type === 'request' && item.parsed.kind === 'permissions' ? item.parsed.grant : null;
  const [permissionGrant, setPermissionGrant] = useState<SessionKeyGrant | null>(requestedGrant);
  const permissionGrantKey = permissionGrant
    ? `${permissionGrant.validUntil}:${permissionGrant.calls.map((c) => `${c.target}/${c.selector}`).join(',')}`
    : '';

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  // Transaction requests need a fee quote (the same machinery as the Send
  // screen: chain-id verification, estimateGas with the dApp's calldata,
  // eth_call simulation) before the user can see what they would approve.
  // On a smart-account session, transactions and ERC-5792 batches are
  // quoted as one UserOperation through the bundler estimate instead.
  //
  // Whenever the inputs of the quote change (another item, account, chain
  // or a narrowed grant), the simulation override switch is cleared and the
  // quote restarts from initialTxQuote. That happens while rendering
  // (React's "adjust state when a prop changes" pattern, which also covers
  // the first render); the effect below only runs the asynchronous quote.
  const [quotedInputs, setQuotedInputs] = useState<{
    itemKey: string;
    address: string | null;
    caip2: string;
    grantKey: string;
  } | null>(null);
  if (
    quotedInputs === null ||
    quotedInputs.itemKey !== item.key ||
    quotedInputs.address !== address ||
    quotedInputs.caip2 !== evmChain.caip2 ||
    quotedInputs.grantKey !== permissionGrantKey
  ) {
    setQuotedInputs({ itemKey: item.key, address, caip2: evmChain.caip2, grantKey: permissionGrantKey });
    setOverrideSimulation(false);
    setTxQuote(initialTxQuote(item, address, permissionGrant));
  }

  useEffect(() => {
    if (item.type === 'request' && item.parsed.kind === 'permissions') {
      const smart = item.smart;
      const grant = permissionGrant;
      // initialTxQuote already showed the refusal.
      if (!smart || !grant) return;
      let cancelled = false;
      (async (): Promise<TxQuoteState> => {
        const loaded = await loadAaBundle(smart.accountIndex);
        if (!loaded) {
          throw new Error(
            'No verified smart-account configuration exists for the active chain any more ' +
              '(Settings → Account Abstraction).',
          );
        }
        if (
          loaded.bundle.accountType !== 'kernel-v3.3' ||
          loaded.bundle.accountType !== smart.accountType ||
          loaded.bundle.factory.toLowerCase() !== smart.factory.toLowerCase()
        ) {
          throw new Error(
            'The smart-account settings changed since this connection was made, so no session can be ' +
              'installed into the connected account. Reconnect the dApp.',
          );
        }
        const { install, quote } = await prepareSessionInstall(loaded.bundle, smart.owner, smart.address, grant);
        return {
          status: 'ready-permission',
          quote,
          bundle: loaded.bundle,
          url: loaded.url,
          owner: smart.owner,
          install,
          grant,
        };
      })().then(
        (r) => {
          if (!cancelled) setTxQuote(r);
        },
        (e) => {
          if (!cancelled) setTxQuote({ status: 'error', message: e instanceof Error ? e.message : String(e) });
        },
      );
      return () => {
        cancelled = true;
      };
    }
    // No quote needed, or a refusal initialTxQuote already showed.
    if (
      item.type !== 'request' ||
      (item.parsed.kind !== 'transaction' && item.parsed.kind !== 'calls')
    ) {
      return;
    }
    if (!address) return;
    let cancelled = false;
    if (item.smart) {
      const smart = item.smart;
      const txs: WcTxParams[] =
        item.parsed.kind === 'calls' ? item.parsed.batch.calls : [item.parsed.tx];
      (async (): Promise<TxQuoteState> => {
        const loaded = await loadAaBundle(smart.accountIndex);
        if (!loaded) {
          throw new Error(
            'No verified smart-account configuration exists for the active chain any more ' +
              '(Settings → Account Abstraction).',
          );
        }
        if (
          loaded.bundle.accountType !== smart.accountType ||
          loaded.bundle.factory.toLowerCase() !== smart.factory.toLowerCase()
        ) {
          throw new Error(
            'The smart-account settings changed since this connection was made, so this ' +
              'request cannot be sent from the connected smart account. Reconnect the dApp.',
          );
        }
        const quote = await prepareAaCalls(
          loaded.bundle,
          smart.owner,
          txs.map((t) => ({ to: t.to, value: t.valueWei, data: t.data })),
        );
        if (quote.sender.toLowerCase() !== smart.address.toLowerCase()) {
          throw new Error(
            `The configured smart account is ${quote.sender}, not the connected ${smart.address}. ` +
              'Reconnect the dApp.',
          );
        }
        return { status: 'ready-aa', quote, bundle: loaded.bundle, url: loaded.url, owner: smart.owner };
      })().then(
        (r) => {
          if (!cancelled) setTxQuote(r);
        },
        (e) => {
          if (!cancelled) {
            const { title, detail } =
              describeAaError(e, { accountType: smart.accountType as AaAccountType, deployed: null }) ?? {
                title: 'The bundler could not estimate this operation (it would fail or cannot be sent).',
                detail: e instanceof Error ? e.message : String(e),
              };
            setTxQuote({ status: 'error', message: `${title}\n${detail}` });
          }
        },
      );
      return () => {
        cancelled = true;
      };
    }
    // Batches outside smart-account sessions: initialTxQuote showed the refusal.
    if (item.parsed.kind !== 'transaction') return;
    const { tx } = item.parsed;
    // The EVM slot resolves to the active network (Sepolia in test mode);
    // the quote verifies the endpoint's eth_chainId against the same active
    // profile, fails over once on a transport failure of a default
    // endpoint, and names the endpoint that answered.
    quoteWcTransaction(tx, address, evmChain.caip2).then(
      (r) => {
        if (!cancelled) setTxQuote({ status: 'ready', quote: r.quote, url: r.url, from: r.from });
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
    // The item key identifies the request; the chain and address are part
    // of what the quote was computed for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.key, address, evmChain.caip2, permissionGrantKey]);

  // Approval-time quote pinning for regular-account transactions: the
  // quote is one endpoint's answer, and the wallet may have moved to
  // another endpoint (a failover elsewhere, or a Settings change) while the
  // sheet was open. The dApp's request is still pending, so instead of
  // refusing, the sheet re-quotes on the endpoint now in use, shows the
  // refreshed numbers with WC_REQUOTED_NOTE and clears the simulation
  // override (it was given for the old simulation); the user then approves
  // the new quote, whose eth_call gate, balance-change preview and risk
  // checks all ran against its own endpoint. Nothing is signed in between.
  // The provider re-checks once more after the biometric gate.
  const [requoting, setRequoting] = useState(false);
  // The item on screen, for dropping a re-quote that finishes after the
  // sheet moved on to another request.
  const currentItemKey = useRef(item.key);
  useEffect(() => {
    currentItemKey.current = item.key;
  }, [item.key]);
  const approveRequest = async () => {
    if (
      txQuote?.status === 'ready' &&
      item.type === 'request' &&
      item.parsed.kind === 'transaction' &&
      !item.smart
    ) {
      const key = item.key;
      const { tx } = item.parsed;
      setRequoting(true);
      try {
        const result = await requoteWcTransactionIfMoved(txQuote, tx, evmChain.caip2);
        if (currentItemKey.current !== key) return;
        if (result.moved) {
          setOverrideSimulation(false);
          setTxQuote({ status: 'ready', ...result.next, note: WC_REQUOTED_NOTE });
          return;
        }
      } catch (e) {
        if (currentItemKey.current !== key) return;
        const { title, detail } = describeSendError(e, 'ETH');
        setOverrideSimulation(false);
        setTxQuote({
          status: 'error',
          message: `The network endpoint changed and a fresh quote could not be prepared.\n${title}\n${detail}`,
        });
        return;
      } finally {
        setRequoting(false);
      }
    }
    onApprove(txQuote, overrideSimulation, undefined, messageSigner, identityAck);
  };

  return (
    <View style={styles.backdrop}>
      <View style={[styles.card, { backgroundColor: theme.background, borderColor: theme.border }]}>
        <ScrollView key={item.key} contentContainerStyle={styles.content}>
          <IdentityBanner identity={item.identity} acknowledged={identityAck} setAcknowledged={setIdentityAck} theme={theme} />
          {item.type === 'proposal' ? (
            <ProposalBody
              event={item.event}
              summary={item.summary}
              address={address}
              accountLabel={accountLabel}
              theme={theme}
              busy={busy}
              activeChain={evmChain.caip2}
              smartOption={smartOption}
              approveLocked={approveLocked}
              onApprove={(connectAs) => onApprove(null, false, connectAs, undefined, identityAck)}
              onReject={onReject}
            />
          ) : (
            <RequestBody
              item={item}
              smart={item.smart}
              dappName={dappName}
              accountLabel={accountLabel}
              theme={theme}
              busy={busy || requoting}
              evmChain={evmChain}
              txQuote={txQuote}
              overrideSimulation={overrideSimulation}
              setOverrideSimulation={setOverrideSimulation}
              permissionGrant={permissionGrant}
              setPermissionGrant={setPermissionGrant}
              messageSigner={messageSigner}
              setMessageSigner={setMessageSigner}
              approveLocked={approveLocked}
              onApprove={() => void approveRequest()}
              onReject={onReject}
            />
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function ProposalBody({
  event,
  summary,
  address,
  accountLabel,
  theme,
  busy,
  activeChain,
  smartOption,
  approveLocked,
  onApprove,
  onReject,
}: {
  event: { id: number; params: unknown };
  summary: WcProposalSummary;
  address: string | null;
  accountLabel: string | null;
  theme: Theme;
  busy: boolean;
  /** CAIP-2 id of the active EVM chain (mainnet or Sepolia test mode). */
  activeChain: string;
  smartOption: () => Promise<SmartAccountOption | null>;
  /** True while the WalletConnect Verify risk switch is required and off. */
  approveLocked: boolean;
  onApprove: (connectAs: ConnectAs) => void;
  onReject: () => void;
}) {
  // Smart-account choice (phase 7 item 3): offered only when a verified AA
  // configuration exists for the active chain. undefined = still resolving.
  const [smart, setSmart] = useState<SmartAccountOption | null | undefined>(undefined);
  const [smartError, setSmartError] = useState<string | null>(null);
  const [connectAs, setConnectAs] = useState<ConnectAs>('eoa');
  useEffect(() => {
    let cancelled = false;
    smartOption().then(
      (option) => {
        if (!cancelled) setSmart(option);
      },
      (e) => {
        if (!cancelled) {
          setSmart(null);
          setSmartError(e instanceof Error ? e.message : String(e));
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, activeChain, address]);
  const asSmart = connectAs === 'smart' && smart;
  // Recomputed against the CURRENT active chain, so the sheet always shows
  // what approving would actually do right now.
  const decision = useMemo(
    () =>
      asSmart
        ? decideProposal(event.params, smart.address, activeChain, smartAccountMethodsFor(smart.accountType))
        : decideProposal(event.params, address ?? '', activeChain, WC_SUPPORTED_METHODS),
    [event, address, activeChain, asSmart, smart],
  );
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
      {smart === undefined ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>Checking for a smart account…</Text>
      ) : smart ? (
        <>
          <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>Connect as</Text>
          <Button
            title={connectAs === 'eoa' ? '✓ Regular account (EOA)' : 'Regular account (EOA)'}
            variant={connectAs === 'eoa' ? 'primary' : 'secondary'}
            onPress={() => setConnectAs('eoa')}
            disabled={busy}
          />
          <Button
            title={
              connectAs === 'smart'
                ? `✓ Smart account (${aaAccountTypeLabel(smart.accountType)})`
                : `Smart account (${aaAccountTypeLabel(smart.accountType)})`
            }
            variant={connectAs === 'smart' ? 'primary' : 'secondary'}
            onPress={() => setConnectAs('smart')}
            disabled={busy}
          />
          {connectAs === 'smart' ? (
            <>
              <Field label="Smart account address" value={smart.address} monoValue theme={theme} />
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                The dApp sees the smart account (it may not be deployed yet — that is
                fine; it deploys with its first transaction). Transactions and
                batches (ERC-5792) run as UserOperations paid from the smart
                account. {smart.signsMessages
                  ? 'Messages and logins are signed with ERC-1271 by the smart account ' +
                    '(ERC-6492-wrapped while it is not deployed); dApps that only accept ' +
                    'plain account signatures will reject them.'
                  : ''}
              </Text>
              {!smart.signsMessages ? (
                <WarningBox>
                  This smart account type (SimpleAccount) cannot sign messages: it has no
                  ERC-1271 support. Logins (sign-in with Ethereum) and every message or
                  typed-data signature request from this dApp will be refused. Connect with
                  the regular account if the dApp needs signatures.
                </WarningBox>
              ) : null}
            </>
          ) : null}
        </>
      ) : smartError ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Smart account unavailable for this connection: {smartError}
        </Text>
      ) : null}
      {decision.ok ? (
        <>
          <Field label="Will connect on" value={describeChain(activeChain)} theme={theme} />
          {asSmart ? (
            <Field
              label="Will connect"
              value={`Smart account ${smart.address}${accountLabel ? ` (owner: ${accountLabel})` : ''}`}
              theme={theme}
            />
          ) : accountLabel ? (
            <Field label="Will connect account" value={accountLabel} theme={theme} />
          ) : null}
          {decision.droppedChains.length > 0 ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              The dApp also offered {decision.droppedChains.map(describeChain).join(', ')}.
              The wallet connects only on its active chain, so those are not
              included.
            </Text>
          ) : null}
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Approving shares this account&apos;s Ethereum address with this dApp and
            lets it send signature and transaction requests. The connection
            stays bound to this account: while another account is active, its
            requests are declined. Every request still needs your explicit
            approval here — nothing is ever signed automatically.
          </Text>
        </>
      ) : (
        <WarningBox>{decision.reason}</WarningBox>
      )}
      {busy ? (
        <ActivityIndicator color={theme.accent} />
      ) : decision.ok ? (
        <>
          <Button
            title="Approve connection"
            onPress={() => onApprove(asSmart ? 'smart' : 'eoa')}
            disabled={smart === undefined || approveLocked}
          />
          <Button title="Reject" variant="secondary" onPress={onReject} />
        </>
      ) : (
        <Button title="Decline" variant="secondary" onPress={onReject} />
      )}
    </>
  );
}

function RequestBody({
  item,
  smart,
  dappName,
  accountLabel,
  theme,
  busy,
  evmChain,
  txQuote,
  overrideSimulation,
  setOverrideSimulation,
  permissionGrant,
  setPermissionGrant,
  messageSigner,
  setMessageSigner,
  approveLocked,
  onApprove,
  onReject,
}: {
  item: { event: WcRequestEvent; parsed: ParsedWcRequest; address: string };
  /** Set for a smart-account session. */
  smart: WcSmartBinding | null;
  dappName: string;
  /** The account that would sign ("Account 2 (0x6Fac…b9C0)"). */
  accountLabel: string | null;
  theme: Theme;
  busy: boolean;
  /** Active EVM chain profile (badge, amount labels, testnet state). */
  evmChain: EvmChainProfile;
  txQuote: TxQuoteState | null;
  overrideSimulation: boolean;
  setOverrideSimulation: (v: boolean) => void;
  /** ERC-7715 only: the grant under review and its (narrowing-only) setter. */
  permissionGrant: SessionKeyGrant | null;
  setPermissionGrant: (grant: SessionKeyGrant) => void;
  /** Message requests on Kernel smart-account sessions: owner key (default) or passkey. */
  messageSigner: MessageSigner;
  setMessageSigner: (signer: MessageSigner) => void;
  /** True while the WalletConnect Verify risk switch is required and off. */
  approveLocked: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { parsed } = item;

  if (parsed.kind === 'permissions') {
    return (
      <PermissionRequestBody
        parsed={parsed}
        smart={smart}
        dappName={dappName}
        accountLabel={accountLabel}
        theme={theme}
        busy={busy}
        evmChain={evmChain}
        txQuote={txQuote}
        grant={permissionGrant ?? parsed.grant}
        setGrant={setPermissionGrant}
        approveLocked={approveLocked}
        onApprove={onApprove}
        onReject={onReject}
      />
    );
  }

  if (parsed.kind === 'personal_sign') {
    return (
      <>
        <Text style={[styles.modalTitle, { color: theme.text }]}>Sign message</Text>
        <Field label="From dApp" value={dappName} theme={theme} />
        {accountLabel ? <Field label="Signing account" value={accountLabel} theme={theme} /> : null}
        <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>
          {parsed.messageText !== null ? 'Message' : 'Message (hex — not printable text)'}
        </Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {parsed.messageText ?? parsed.messageHex}
          </Text>
        </View>
        {smart ? <SmartSigningNote smart={smart} theme={theme} /> : null}
        {smart ? (
          <PasskeySignerChoice smart={smart} theme={theme} signer={messageSigner} setSigner={setMessageSigner} />
        ) : null}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Signing proves account ownership to the dApp (EIP-191). It costs
          nothing and moves no funds, but only sign messages from dApps you
          trust.
        </Text>
        {busy ? (
          <ActivityIndicator color={theme.accent} />
        ) : (
          <>
            <Button title="Sign" onPress={onApprove} disabled={approveLocked} />
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
        {accountLabel ? <Field label="Signing account" value={accountLabel} theme={theme} /> : null}
        <TypedDataSummaryCard typedData={typedData} signer={item.address} evmChain={evmChain} theme={theme} />
        <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>Exactly what is signed</Text>
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
        {smart ? <SmartSigningNote smart={smart} theme={theme} /> : null}
        {smart ? (
          <PasskeySignerChoice smart={smart} theme={theme} signer={messageSigner} setSigner={setMessageSigner} />
        ) : null}
        <WarningBox>
          Typed-data signatures can authorize on-chain actions later (token
          permits, orders). Only approve if you understand what this dApp
          does with it.
        </WarningBox>
        {busy ? (
          <ActivityIndicator color={theme.accent} />
        ) : (
          <>
            <Button title="Sign" onPress={onApprove} disabled={approveLocked} />
            <Button title="Reject" variant="secondary" onPress={onReject} />
          </>
        )}
      </>
    );
  }

  if (smart || parsed.kind === 'calls') {
    return (
      <SmartAccountTxBody
        parsed={parsed}
        smart={smart}
        dappName={dappName}
        accountLabel={accountLabel}
        theme={theme}
        busy={busy}
        evmChain={evmChain}
        txQuote={txQuote}
        approveLocked={approveLocked}
        onApprove={onApprove}
        onReject={onReject}
      />
    );
  }

  // Transaction request (EOA session) — the same confirm presentation as the Send screen.
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
      {accountLabel ? <Field label="Sending account" value={accountLabel} theme={theme} /> : null}
      {parsed.kind === 'transaction' ? (
        <TxFields tx={parsed.tx} evmChain={evmChain} theme={theme} />
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
          {txQuote.note ? (
            <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.textMuted }]}>
              {txQuote.note}
            </Text>
          ) : null}
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
          <BalanceChangePreview
            url={txQuote.url}
            request={{
              from: txQuote.from,
              to: txQuote.quote.to,
              value: txQuote.quote.amount,
              ...(txQuote.quote.data ? { data: txQuote.quote.data } : {}),
            }}
          />
          <RiskWarnings url={txQuote.url} wallet={txQuote.from} to={txQuote.quote.to} data={txQuote.quote.data} />
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
          <Button title="Approve & send" onPress={onApprove} disabled={approveBlocked || approveLocked} />
          <Button title="Reject" variant="secondary" onPress={onReject} />
        </>
      )}
    </>
  );
}

/**
 * Approve-gate for a transaction request, shared by the sheet's button
 * state and the provider's approve handler (defense in depth: the handler
 * refuses even if a stale render let the press through).
 */
export function txApprovalAllowed(txQuote: TxQuoteState | null, overrideSimulation: boolean): boolean {
  // Smart-account path: a ready quote means the bundler's estimate (its
  // simulation of the whole operation) passed; there is no override.
  if (txQuote?.status === 'ready-aa' || txQuote?.status === 'ready-permission') return true;
  if (txQuote?.status !== 'ready') return false;
  return txQuote.quote.simulation.ok || overrideSimulation;
}

/** To / amount / calldata rows for one call. */
function TxFields({
  tx,
  evmChain,
  theme,
  index,
}: {
  tx: WcTxParams;
  evmChain: EvmChainProfile;
  theme: Theme;
  /** "Call 2 of 3" prefix for batches. */
  index?: { n: number; of: number };
}) {
  const prefix = index ? `Call ${index.n} of ${index.of} · ` : '';
  return (
    <>
      <Field label={`${prefix}To`} value={tx.to} monoValue theme={theme} />
      <Field
        label={`${prefix}Amount`}
        value={`${formatUnits(tx.valueWei, 18, 18)} ${evmChain.displaySymbol}`}
        theme={theme}
      />
      {tx.data.length > 0 ? (
        <Field
          label={`${prefix}Calldata (${tx.data.length} bytes)`}
          value={truncateHex(tx.data)}
          monoValue
          theme={theme}
        />
      ) : null}
    </>
  );
}

/**
 * The note on message/typed-data requests of a smart-account session: the
 * ORIGINAL request is shown above, because Kernel's ERC-1271 wrapper means
 * the owner key itself signs only a hash.
 */
/**
 * Signer choice for a message request on a Kernel smart-account session:
 * shown only when this device installed a passkey on exactly the session's
 * smart account (on its chain) and the passkey gate is open. The account
 * key stays the default.
 */
function PasskeySignerChoice({
  smart,
  theme,
  signer,
  setSigner,
}: {
  smart: WcSmartBinding;
  theme: Theme;
  signer: MessageSigner;
  setSigner: (s: MessageSigner) => void;
}) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (smart.accountType !== 'kernel-v3.3' || !passkeyGateNow().ok) return;
    passkeyRecordForAccount(smart.chain, smart.address).then(
      (r) => {
        if (!cancelled) setAvailable(r !== null && r.localStatus === 'installed');
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [smart.accountType, smart.chain, smart.address]);
  if (!available) return null;
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>Sign with</Text>
      <Button
        title={signer === 'owner' ? '✓ Account key (default)' : 'Account key (default)'}
        variant={signer === 'owner' ? 'primary' : 'secondary'}
        onPress={() => setSigner('owner')}
      />
      <Button
        title={signer === 'passkey' ? '✓ This phone’s passkey' : 'This phone’s passkey'}
        variant={signer === 'passkey' ? 'primary' : 'secondary'}
        onPress={() => setSigner('passkey')}
      />
      {signer === 'passkey' ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The passkey signs as the smart account (ERC-1271 through the WebAuthn validator). A passkey
          prompt follows the approval.
        </Text>
      ) : null}
    </View>
  );
}

function SmartSigningNote({ smart, theme }: { smart: WcSmartBinding; theme: Theme }) {
  return (
    <Text style={[styles.hint, { color: theme.textMuted }]}>
      Signed by your smart account {smart.address} through its validator (ERC-1271
      {smart.accountType === 'kernel-v3.3' ? '; ERC-6492-wrapped if the account is not deployed yet' : ''}).
      Your account key signs Kernel&apos;s wrapper — a hash of this exact request bound to
      the smart account and this chain — so a hardware or external signer would show only
      that hash. What you are approving is the content shown above.
    </Text>
  );
}

/**
 * Smart-account transaction / ERC-5792 batch approval: every call listed,
 * the bundler-estimated fee, deployment state, the batch simulated as the
 * smart account in the balance-change preview. The bundler estimate is the
 * gate: approval is possible only once it succeeded.
 */
function SmartAccountTxBody({
  parsed,
  smart,
  dappName,
  accountLabel,
  theme,
  busy,
  evmChain,
  txQuote,
  approveLocked,
  onApprove,
  onReject,
}: {
  parsed: ParsedWcRequest;
  smart: WcSmartBinding | null;
  dappName: string;
  accountLabel: string | null;
  theme: Theme;
  busy: boolean;
  evmChain: EvmChainProfile;
  txQuote: TxQuoteState | null;
  approveLocked: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const txs: WcTxParams[] =
    parsed.kind === 'calls' ? parsed.batch.calls : parsed.kind === 'transaction' ? [parsed.tx] : [];
  const batch = parsed.kind === 'calls';
  const ready = txQuote?.status === 'ready-aa' ? txQuote : null;
  return (
    <>
      <Text style={[styles.modalTitle, { color: theme.text }]}>
        {batch ? `Batch request (${txs.length} call${txs.length === 1 ? '' : 's'})` : 'Transaction request'}
      </Text>
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
      {smart ? (
        <>
          <Field label="Sending smart account" value={smart.address} monoValue theme={theme} />
          {accountLabel ? <Field label="Owner (signs)" value={accountLabel} theme={theme} /> : null}
        </>
      ) : null}
      {batch ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The dApp asked for {txs.length} call{txs.length === 1 ? '' : 's'} (ERC-5792
          wallet_sendCalls{parsed.kind === 'calls' && parsed.batch.atomicRequired ? ', atomic required' : ''}).
          They run in this order as ONE smart-account operation: all succeed, or none take
          effect.
          {parsed.kind === 'calls' && parsed.batch.ignoredCapabilities.length > 0
            ? ` Optional capabilities this wallet does not support were ignored: ${parsed.batch.ignoredCapabilities.join(', ')}.`
            : ''}
        </Text>
      ) : null}
      {txs.map((tx, i) => (
        <TxFields
          key={`${i}-${tx.to}`}
          tx={tx}
          evmChain={evmChain}
          theme={theme}
          {...(batch ? { index: { n: i + 1, of: txs.length } } : {})}
        />
      ))}
      {txQuote?.status === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Asking the bundler to estimate the operation…
          </Text>
        </View>
      ) : null}
      {txQuote?.status === 'error' ? <WarningBox>{txQuote.message}</WarningBox> : null}
      {ready ? (
        <>
          <Field
            label="Deployment"
            value={ready.quote.deployed ? 'Already deployed' : 'Will deploy with this operation'}
            theme={theme}
          />
          {!ready.quote.deployed && ready.quote.accountType === 'kernel-v3.3' ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>{KERNEL_BUNDLER_NOTE}</Text>
          ) : null}
          <Field
            label={ready.quote.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
            value={
              ready.quote.sponsored
                ? 'Sponsored — the smart account pays 0'
                : `${formatUnits(ready.quote.fee, 18, 18)} ${evmChain.displaySymbol}`
            }
            theme={theme}
          />
          <Field
            label="Total from the smart account (worst case)"
            value={`${formatUnits(ready.quote.total, 18, 18)} ${evmChain.displaySymbol}`}
            theme={theme}
          />
          <Field
            label="Smart account balance"
            value={`${formatUnits(ready.quote.senderBalance, 18, 18)} ${evmChain.displaySymbol}`}
            theme={theme}
          />
          <BalanceChangePreview
            url={ready.url}
            request={{
              from: ready.quote.sender,
              to: ready.quote.calls[0]!.to,
              value: ready.quote.calls[0]!.value,
              data: ready.quote.calls[0]!.data,
            }}
            batch={ready.quote.calls.map((c) => ({
              from: ready.quote.sender,
              to: c.to,
              value: c.value,
              data: c.data,
            }))}
            note={ready.quote.calls.length > 1 ? PREVIEW_AA_BATCH_NOTE : PREVIEW_AA_NOTE}
          />
          <RiskWarnings
            url={ready.url}
            wallet={ready.quote.sender}
            to={ready.quote.calls[0]!.to}
            data={ready.quote.calls[0]!.data}
          />
          <Text style={[styles.simulationOk, { color: theme.success }]}>
            Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).
          </Text>
          {!batch ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              The dApp expects a transaction hash, so after approving the wallet waits (up to
              two minutes) for the bundler to include the operation.
            </Text>
          ) : null}
        </>
      ) : null}
      {busy ? (
        <ActivityIndicator color={theme.accent} />
      ) : (
        <>
          <Button title={batch ? 'Approve & send batch' : 'Approve & send'} onPress={onApprove} disabled={!ready || approveLocked} />
          <Button title="Reject" variant="secondary" onPress={onReject} />
        </>
      )}
    </>
  );
}

/**
 * ERC-7715 wallet_requestExecutionPermissions approval (phase 8 item 2): the
 * SAME plain-language grant review as the Sessions screen, the dApp's name,
 * the honest ERC-7710 limitation, narrowing only when the dApp set
 * isAdjustmentAllowed (otherwise: grant exactly as shown, or decline), and
 * the explicit install quoted through the bundler like any smart-account
 * operation.
 */
function PermissionRequestBody({
  parsed,
  smart,
  dappName,
  accountLabel,
  theme,
  busy,
  evmChain,
  txQuote,
  grant,
  setGrant,
  approveLocked,
  onApprove,
  onReject,
}: {
  parsed: Extract<ParsedWcRequest, { kind: 'permissions' }>;
  smart: WcSmartBinding | null;
  dappName: string;
  accountLabel: string | null;
  theme: Theme;
  busy: boolean;
  evmChain: EvmChainProfile;
  txQuote: TxQuoteState | null;
  grant: SessionKeyGrant;
  setGrant: (grant: SessionKeyGrant) => void;
  approveLocked: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const requested = parsed.grant;
  const [keep, setKeep] = useState<boolean[]>(() => requested.calls.map(() => true));
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const ready = txQuote?.status === 'ready-permission' ? txQuote : null;
  // Read once per sheet (lazy initializer keeps render pure).
  const [nowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const shorter = SESSION_EXPIRY_PRESETS.filter((p) => nowSeconds + p.seconds < requested.validUntil);
  const apply = (next: { keep?: boolean[]; validUntil?: number }) => {
    try {
      const k = next.keep ?? keep;
      const narrowed = narrowGrant(requested, { keep: k, validUntil: next.validUntil ?? grant.validUntil });
      setKeep(k);
      setAdjustError(null);
      setGrant(narrowed);
    } catch (e) {
      setAdjustError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <Text style={[styles.modalTitle, { color: theme.text }]}>Session permission request</Text>
      {evmChain.testnet ? (
        <View style={[styles.mainnetBadge, { backgroundColor: '#e07800', borderColor: '#e07800' }]}>
          <Text style={[styles.mainnetBadgeText, { color: '#ffffff' }]}>
            {evmChain.label} TESTNET — test funds only
          </Text>
        </View>
      ) : (
        <View style={[styles.mainnetBadge, { backgroundColor: theme.dangerSurface, borderColor: theme.danger }]}>
          <Text style={[styles.mainnetBadgeText, { color: theme.danger }]}>Ethereum Mainnet — real funds</Text>
        </View>
      )}
      <Field label="From dApp" value={dappName} theme={theme} />
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        {dappName} asks for a session key it holds ({grant.sessionKey}) to act for your smart account
        without asking you again, within the limits below, until the session expires (ERC-7715
        wallet_requestExecutionPermissions).
      </Text>
      {smart ? <Field label="Smart account" value={smart.address} monoValue theme={theme} /> : null}
      {accountLabel ? <Field label="Owner (signs the install)" value={accountLabel} theme={theme} /> : null}
      <WarningBox>{ERC7715_LIMITATION_NOTE}</WarningBox>
      <GrantReview
        grant={grant}
        account={smart?.address ?? ''}
        symbol={evmChain.displaySymbol}
        sessionKeyHolder={dappName}
        permissionId={ready ? `0x${[...ready.install.permissionId].map((b) => b.toString(16).padStart(2, '0')).join('')}` : null}
      />
      {parsed.isAdjustmentAllowed ? (
        <>
          <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>Narrow this grant (optional)</Text>
          {requested.calls.map((c, i) => (
            <Button
              key={`k${i}`}
              title={`${keep[i] ? '✓ Keep' : '✗ Drop'} allowed call ${i + 1} (${c.target.slice(0, 6)}…${c.target.slice(-4)})`}
              variant={keep[i] ? 'primary' : 'secondary'}
              onPress={() => apply({ keep: keep.map((v, j) => (j === i ? !v : v)) })}
              disabled={busy}
            />
          ))}
          <Button
            title={grant.validUntil === requested.validUntil ? '✓ Expiry as requested' : 'Expiry as requested'}
            variant={grant.validUntil === requested.validUntil ? 'primary' : 'secondary'}
            onPress={() => apply({ validUntil: requested.validUntil })}
            disabled={busy}
          />
          {shorter.map((p) => (
            <Button
              key={p.seconds}
              title={`Expire in ${p.label} instead`}
              variant="secondary"
              onPress={() => apply({ validUntil: Math.floor(Date.now() / 1000) + p.seconds })}
              disabled={busy}
            />
          ))}
          {adjustError ? <WarningBox>{adjustError}</WarningBox> : null}
        </>
      ) : (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The dApp does not allow changes (isAdjustmentAllowed is false): grant exactly what is shown,
          or decline.
        </Text>
      )}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{SESSIONS_INSTALL_MODE_NOTE}</Text>
      {!evmChain.testnet ? <WarningBox>{SESSIONS_AUDIT_NOTE}</WarningBox> : null}
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        You can revoke this session at any time in Settings → Session keys. The wallet answers the dApp
        only after the install is included on-chain (up to two minutes).
      </Text>
      {txQuote?.status === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}>Reading the account and asking the bundler…</Text>
        </View>
      ) : null}
      {txQuote?.status === 'error' ? <WarningBox>{txQuote.message}</WarningBox> : null}
      {ready ? (
        <>
          <Field
            label={ready.quote.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
            value={
              ready.quote.sponsored
                ? 'Sponsored — the smart account pays 0'
                : `${formatUnits(ready.quote.fee, 18, 18)} ${evmChain.displaySymbol}`
            }
            theme={theme}
          />
          <Text style={[styles.simulationOk, { color: theme.success }]}>
            Bundler gas estimate passed (eth_estimateUserOperationGas simulated the install).
          </Text>
        </>
      ) : null}
      {busy ? (
        <ActivityIndicator color={theme.accent} />
      ) : (
        <>
          <Button title="Grant & install" onPress={onApprove} disabled={!ready || approveLocked} />
          <Button title="Decline" variant="secondary" onPress={onReject} />
        </>
      )}
    </>
  );
}

/**
 * WalletConnect Verify result (threat-model N-06; see walletconnect.ts
 * describeVerifyContext). Verified origins get a calm line; everything else
 * uses the warning style, and scam / mismatch add the explicit risk switch
 * that unlocks the approve buttons (same pattern as the simulation
 * override).
 */
function IdentityBanner({
  identity,
  acknowledged,
  setAcknowledged,
  theme,
}: {
  identity: WcDappIdentity;
  acknowledged: boolean;
  setAcknowledged: (v: boolean) => void;
  theme: Theme;
}) {
  if (identity.status === 'verified') {
    return <Text style={[styles.simulationOk, { color: theme.success }]}>{identity.message}</Text>;
  }
  return (
    <>
      <WarningBox>{identity.message}</WarningBox>
      {identity.requiresAcknowledgement ? (
        <View style={styles.overrideRow}>
          <Switch value={acknowledged} onValueChange={setAcknowledged} />
          <Text style={[styles.overrideLabel, { color: theme.text }]}>{IDENTITY_RISK_SWITCH_LABEL}</Text>
        </View>
      ) : null}
    </>
  );
}

/**
 * Decoded summary of an EIP-712 request (threat-model N-07; logic in
 * wallet/typed-data-summary.ts). Informational only: it never blocks or
 * unblocks signing, and the full raw message stays below it. Spenders are
 * shown with the contacts exact-match rule (RecipientContactNotice: name
 * plus full address for an exact match, the look-alike warning otherwise)
 * and checked with the engine's classifyRecipient on the active chain's
 * endpoint; a failed lookup raises nothing.
 */
function TypedDataSummaryCard({
  typedData,
  signer,
  evmChain,
  theme,
}: {
  typedData: WcTypedData;
  signer: string;
  evmChain: EvmChainProfile;
  theme: Theme;
}) {
  const { hideAmounts } = usePrefs();
  const [tracked, setTracked] = useState<TrackedTokenRef[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [classes, setClasses] = useState<Record<string, RecipientClass | null>>({});
  const [nowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let cancelled = false;
    listTokens().then(
      (list) => {
        if (!cancelled) setTracked(list);
      },
      () => undefined,
    );
    listContacts(evmChain.caip2).then(
      (list) => {
        if (!cancelled) setContacts(list);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [evmChain.caip2]);

  const summary: TypedDataSummary = useMemo(
    () =>
      summarizeTypedData(typedData, {
        signer,
        nowSec,
        chainCaip2: evmChain.caip2,
        trackedTokens: tracked,
        hidden: hideAmounts,
      }),
    [typedData, signer, nowSec, evmChain.caip2, tracked, hideAmounts],
  );

  const spenderKey = summary.spenders.join(',');
  useEffect(() => {
    if (!spenderKey) return;
    let cancelled = false;
    (async () => {
      const endpoint = await getEndpoint(EVM_CHAIN_ID);
      const out: Record<string, RecipientClass | null> = {};
      if (!endpoint?.url) return out;
      const transport = simulationTransport(endpoint.url);
      for (const spender of spenderKey.split(',')) {
        try {
          out[spender.toLowerCase()] = await classifyRecipient(transport, spender);
        } catch {
          out[spender.toLowerCase()] = null;
        }
      }
      return out;
    })().then(
      (result) => {
        if (!cancelled) setClasses(result);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [spenderKey, evmChain.caip2]);

  const networkWarnings = spenderRiskWarnings(summary.spenders, classes);
  return (
    <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border, gap: 10 }]}>
      <Text style={[styles.summaryTitle, { color: theme.text }]}>{summary.title}</Text>
      <Text style={[styles.hint, { color: theme.text }]}>{summary.explanation}</Text>
      {summary.rows.map((row, i) => (
        <View key={`${i}-${row.label}`} style={[styles.fieldRow, { borderColor: theme.border }]}>
          <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>{row.label}</Text>
          <Text
            selectable
            style={[
              styles.fieldValue,
              { color: row.emphasis ? theme.danger : theme.text },
              row.mono ? { fontFamily: mono, fontSize: 13 } : null,
            ]}
          >
            {row.value}
          </Text>
        </View>
      ))}
      {summary.spenders.map((spender) => (
        <RecipientContactNotice
          key={spender}
          match={matchRecipient(evmChain.caip2, spender, contacts)}
          address={spender}
        />
      ))}
      {[...summary.warnings, ...networkWarnings].map((w) => (
        <WarningBox key={w}>{w}</WarningBox>
      ))}
    </View>
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
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  card: {
    maxHeight: '88%',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
  },
  content: {
    padding: 24,
    gap: 14,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 12,
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  summaryTitle: {
    fontSize: 16,
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

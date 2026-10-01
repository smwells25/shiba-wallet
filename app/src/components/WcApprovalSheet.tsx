import React, { useEffect, useMemo, useState } from 'react';
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
import { Button, WarningBox } from '../components';
import { BalanceChangePreview } from './BalanceChangePreview';
import { RiskWarnings } from './RiskWarnings';
import { getEndpoint } from '../config/networks';
import type { EvmChainProfile } from '../config/evm-chain';
import { useTheme, type Theme } from '../theme';
import { formatUnits } from '../wallet/balances';
import { EVM_CHAIN_ID, describeSendError, prepareEvmSend, type EvmSendQuote } from '../wallet/send';
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
import { PREVIEW_AA_NOTE } from '../wallet/simulation';
import {
  WC_SMART_ACCOUNT_METHODS,
  WC_SUPPORTED_METHODS,
  decideProposal,
  describeChain,
  type ParsedWcRequest,
  type WcProposalSummary,
  type WcRequestEvent,
  type WcSmartBinding,
  type WcTxParams,
} from '../wallet/walletconnect';
import type { WcQueueItem } from '../wallet/wc-controller';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

export type TxQuoteState =
  | { status: 'loading' }
  | { status: 'ready'; quote: EvmSendQuote; url: string; from: string }
  /**
   * Smart-account session (phase 7): the transaction or ERC-5792 batch
   * quoted as ONE UserOperation. Reaching this state means the bundler's
   * gas estimate (its simulation of the whole operation) passed — the AA
   * path's pre-flight gate.
   */
  | { status: 'ready-aa'; quote: AaSendQuote; bundle: AaClientBundle; url: string; owner: string }
  | { status: 'error'; message: string };

/** What the proposal sheet offers when a verified smart account exists. */
export interface SmartAccountOption {
  address: string;
  accountType: AaAccountType;
  signsMessages: boolean;
}

/** How the user chose to connect a proposal. */
export type ConnectAs = 'eoa' | 'smart';

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
  onApprove: (txQuote: TxQuoteState | null, overrideSimulation: boolean, connectAs?: ConnectAs) => void;
  onReject: () => void;
}) {
  const theme = useTheme();
  const [txQuote, setTxQuote] = useState<TxQuoteState | null>(null);
  const [overrideSimulation, setOverrideSimulation] = useState(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  // Transaction requests need a fee quote (the same machinery as the Send
  // screen: chain-id verification, estimateGas with the dApp's calldata,
  // eth_call simulation) before the user can see what they would approve.
  // On a smart-account session, transactions and ERC-5792 batches are
  // quoted as one UserOperation through the bundler estimate instead.
  useEffect(() => {
    setOverrideSimulation(false);
    if (
      item.type !== 'request' ||
      (item.parsed.kind !== 'transaction' && item.parsed.kind !== 'calls')
    ) {
      setTxQuote(null);
      return;
    }
    if (!address) {
      setTxQuote({ status: 'error', message: 'Wallet account unavailable.' });
      return;
    }
    let cancelled = false;
    setTxQuote({ status: 'loading' });
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
    if (item.parsed.kind !== 'transaction') {
      setTxQuote({ status: 'error', message: 'Batches are only served on smart-account connections.' });
      return;
    }
    const { tx } = item.parsed;
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
        evmChain.caip2,
      );
      return { quote, url: endpoint.url, from: address };
    })().then(
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
  }, [item.key, address, evmChain.caip2]);

  return (
    <View style={styles.backdrop}>
      <View style={[styles.card, { backgroundColor: theme.background, borderColor: theme.border }]}>
        <ScrollView key={item.key} contentContainerStyle={styles.content}>
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
              onApprove={(connectAs) => onApprove(null, false, connectAs)}
              onReject={onReject}
            />
          ) : (
            <RequestBody
              item={item}
              smart={item.smart}
              dappName={dappName}
              accountLabel={accountLabel}
              theme={theme}
              busy={busy}
              evmChain={evmChain}
              txQuote={txQuote}
              overrideSimulation={overrideSimulation}
              setOverrideSimulation={setOverrideSimulation}
              onApprove={() => onApprove(txQuote, overrideSimulation)}
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
        ? decideProposal(event.params, smart.address, activeChain, WC_SMART_ACCOUNT_METHODS)
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
            Approving shares this account's Ethereum address with this dApp and
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
            disabled={smart === undefined}
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
  onApprove,
  onReject,
}: {
  item: { event: WcRequestEvent; parsed: ParsedWcRequest };
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
  onApprove: () => void;
  onReject: () => void;
}) {
  const { parsed } = item;

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
        {accountLabel ? <Field label="Signing account" value={accountLabel} theme={theme} /> : null}
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
          <Button title="Approve & send" onPress={onApprove} disabled={approveBlocked} />
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
  if (txQuote?.status === 'ready-aa') return true;
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
          <Button title={batch ? 'Approve & send batch' : 'Approve & send'} onPress={onApprove} disabled={!ready} />
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

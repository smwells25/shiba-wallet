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
import { getEndpoint } from '../config/networks';
import type { EvmChainProfile } from '../config/evm-chain';
import { useTheme, type Theme } from '../theme';
import { formatUnits } from '../wallet/balances';
import { EVM_CHAIN_ID, describeSendError, prepareEvmSend, type EvmSendQuote } from '../wallet/send';
import {
  decideProposal,
  describeChain,
  type ParsedWcRequest,
  type WcProposalSummary,
  type WcRequestEvent,
} from '../wallet/walletconnect';
import type { WcQueueItem } from '../wallet/wc-controller';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

export type TxQuoteState =
  | { status: 'loading' }
  | { status: 'ready'; quote: EvmSendQuote; url: string; from: string }
  | { status: 'error'; message: string };

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
  /** txQuote/override are null/false for everything but transactions. */
  onApprove: (txQuote: TxQuoteState | null, overrideSimulation: boolean) => void;
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
  useEffect(() => {
    setOverrideSimulation(false);
    if (item.type !== 'request' || item.parsed.kind !== 'transaction') {
      setTxQuote(null);
      return;
    }
    if (!address) {
      setTxQuote({ status: 'error', message: 'Wallet account unavailable.' });
      return;
    }
    let cancelled = false;
    setTxQuote({ status: 'loading' });
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
              onApprove={() => onApprove(null, false)}
              onReject={onReject}
            />
          ) : (
            <RequestBody
              item={item}
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
  onApprove: () => void;
  onReject: () => void;
}) {
  // Recomputed against the CURRENT active chain, so the sheet always shows
  // what approving would actually do right now.
  const decision = useMemo(
    () => decideProposal(event.params, address ?? '', activeChain),
    [event, address, activeChain],
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
      {decision.ok ? (
        <>
          <Field label="Will connect on" value={describeChain(activeChain)} theme={theme} />
          {accountLabel ? (
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
          <Button title="Approve connection" onPress={onApprove} />
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
      {accountLabel ? <Field label="Sending account" value={accountLabel} theme={theme} /> : null}
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
          <BalanceChangePreview
            url={txQuote.url}
            request={{
              from: txQuote.from,
              to: txQuote.quote.to,
              value: txQuote.quote.amount,
              ...(txQuote.quote.data ? { data: txQuote.quote.data } : {}),
            }}
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

/**
 * Approve-gate for a transaction request, shared by the sheet's button
 * state and the provider's approve handler (defense in depth: the handler
 * refuses even if a stale render let the press through).
 */
export function txApprovalAllowed(txQuote: TxQuoteState | null, overrideSimulation: boolean): boolean {
  if (txQuote?.status !== 'ready') return false;
  return txQuote.quote.simulation.ok || overrideSimulation;
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

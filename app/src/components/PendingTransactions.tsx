import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Button } from '../components';
import { withShortAddresses } from '../a11y';
import { useTheme } from '../theme';
import { httpTransport } from '@shiba-wallet/chains-evm';
import { getEndpoint } from '../config/networks';
import { requireLocalAuth } from '../wallet/biometric';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { getAaConfig } from '../wallet/aa';
import { formatUnits } from '../wallet/balances';
import { TechnicalDetail } from '../wallet/connectivity';
import { evaluateBeforeSigning, recordAcceptedSpend } from '../wallet/spending-policy';
import { confirmSpendingCheck } from './SpendingPolicyViews';
import { RiskWarnings } from './RiskWarnings';
import {
  EVM_CHAIN_ID,
  ReplacementRefusedError,
  checkReplacementBeforeApproval,
  describeSendError,
  prepareEvmReplacement,
  quoteEndpointChange,
  sendEvmReplacement,
  type EvmReplacementQuote,
} from '../wallet/send';
import {
  CANCEL_EXPLAINER,
  PENDING_POLL_MS,
  PENDING_READ_ONLY_MESSAGE,
  REPLACEMENT_SPENDING_NOTE,
  SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE,
  SPEED_UP_EXPLAINER,
  USEROP_RESEND_LINE,
  cancelRiskLine,
  checkUserOperation,
  feeLine,
  forgetUserOperation,
  groupForHash,
  loadPendingRegistry,
  nodeReader,
  nonceGroups,
  pendingGroupSentence,
  poolSentence,
  refreshAccountPending,
  replacementPromptTitle,
  replacementSpendingInput,
  resetPendingRegistry,
  resolvedNotices,
  resolvedSentence,
  settleNonce,
  shortHash,
  userOpCanBeSentAgain,
  userOpCardTitle,
  userOpShowsNoReplacementSentence,
  userOpStatusSentence,
  userOpsFor,
  type GroupStatus,
  type NonceGroup,
  type PendingRegistry,
  type PendingUserOpRecord,
  type ReplacementAction,
  type ResolvedRecord,
  type UserOpStatus,
} from '../wallet/pending-transactions';

/**
 * Pending transactions on this phone (feature 95, wallet/pending-transactions.ts):
 * the regular account's transactions that are not yet included, with
 * "Speed up" and "Cancel"; what happened to a nonce that had a replacement;
 * and the smart-account operations the bundler accepted from any screen
 * (phase 20 item 3: Send, Swap, Staking, Sessions, WalletConnect, the in-app
 * browser, multisig submits), which the wallet cannot replace ("Check
 * status" for all; "Send again" once the bundler has had no record of one
 * for 10 minutes, only for the Send screen's own operations — the others'
 * status line says where to try again).
 *
 * Shown at the top of Activity (EVM slot, regular accounts) and on the Send
 * success view for the transaction just sent (`onlyHash`). Re-read on focus
 * and every PENDING_POLL_MS while shown.
 *
 * A replacement goes through the same steps as every send, in the same
 * order: a quote on the endpoint the wallet uses now (fees, gas, balance,
 * the eth_call pre-flight), the confirm block with the new worst case and
 * the risk card, then on Approve: the endpoint is still the quoted one
 * (quote pinning), the nonce is still pending and the fees still clear the
 * bump (checkReplacementBeforeApproval), the spending limits (the fee
 * counts, the value does not), the device check titled with the action,
 * signing and broadcast (a quote goes out at most once).
 */

type GroupView = { group: NonceGroup; status: GroupStatus | { state: 'error'; message: string } | null };

interface ReplacementDraft {
  group: NonceGroup;
  action: ReplacementAction;
  state:
    | { kind: 'quoting' }
    | { kind: 'ready'; quote: EvmReplacementQuote; url: string }
    | { kind: 'sending'; quote: EvmReplacementQuote; url: string }
    | { kind: 'failed'; title: string; detail: string; technical: string | null };
}

function describeReplacementError(e: unknown, symbol: string): { title: string; detail: string; technical: string | null } {
  if (e instanceof ReplacementRefusedError || (e as { name?: unknown } | null)?.name === 'ReplacementRefusedError') {
    const err = e as ReplacementRefusedError;
    return { title: 'Not replaced', detail: err.message, technical: err.technical ?? null };
  }
  const d = describeSendError(e, symbol, symbol);
  return { title: d.title, detail: d.detail, technical: d.technical ?? null };
}

export function PendingTransactionsSection({
  from,
  onlyHash,
  onSendAgain,
  onChanged,
}: {
  /** Called after a re-read that may have settled a nonce (Activity re-reads its replacement lines). */
  onChanged?: () => void;
  /** The regular account's own EVM address (the sender of the transactions). */
  from: string;
  /** Show only the nonce this hash belongs to (the Send success view). */
  onlyHash?: string | null;
  /** Opens Send pre-filled for a dropped smart-account operation (Activity only). */
  onSendAgain?: (record: PendingUserOpRecord) => void;
}) {
  const theme = useTheme();
  const { evmChain } = usePrefs();
  const { signWith } = useWallet();
  const chain = evmChain.caip2;
  const symbol = evmChain.displaySymbol;
  const [registry, setRegistry] = useState<PendingRegistry | null>(null);
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [notices, setNotices] = useState<ResolvedRecord[]>([]);
  const [userOps, setUserOps] = useState<{ record: PendingUserOpRecord; status: UserOpStatus | null; checking: boolean; error: string | null }[]>([]);
  const [draft, setDraft] = useState<ReplacementDraft | null>(null);
  const draftOpen = useRef(false);
  draftOpen.current = draft !== null;
  const [nowMs, setNowMs] = useState(Date.now());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    let reg: PendingRegistry;
    try {
      reg = await loadPendingRegistry();
    } catch {
      reg = { records: [], readOnly: true };
    }
    if (!mounted.current) return;
    setRegistry(reg);
    setNowMs(Date.now());
    const base = nonceGroups(reg.records, chain, from);
    setGroups((prev) => base.map((group) => ({ group, status: prev.find((p) => p.group.nonce === group.nonce)?.status ?? null })));
    setUserOps((prev) =>
      userOpsFor(reg.records, chain, from).map((record) => {
        const old = prev.find((p) => p.record.userOpHash === record.userOpHash);
        return { record, status: old?.status ?? null, checking: false, error: old?.error ?? null };
      }),
    );
    if (base.length === 0) {
      setNotices(resolvedNotices(reg.records, chain, from));
      return;
    }
    let url: string | null = null;
    try {
      url = (await getEndpoint(EVM_CHAIN_ID))?.url ?? null;
    } catch {
      url = null;
    }
    if (!url) return;
    const results = await refreshAccountPending({ reader: nodeReader(httpTransport(url)), chain, from });
    if (!mounted.current) return;
    setGroups(results.filter((r) => r.status.state !== 'mined').map((r) => ({ group: r.group, status: r.status })));
    try {
      const after = await loadPendingRegistry();
      if (mounted.current) {
        setRegistry(after);
        setNotices(resolvedNotices(after.records, chain, from));
        onChanged?.();
      }
    } catch {
      // Keep the notices already shown.
    }
  }, [chain, from, onChanged]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      const timer = setInterval(() => {
        // Not while a replacement is priced or confirmed: the confirm block
        // stays as quoted (Approve re-reads everything it relies on).
        if (!draftOpen.current) void refresh();
      }, PENDING_POLL_MS);
      return () => clearInterval(timer);
    }, [refresh]),
  );

  const startReplacement = async (group: NonceGroup, action: ReplacementAction) => {
    setDraft({ group, action, state: { kind: 'quoting' } });
    try {
      const url = (await getEndpoint(EVM_CHAIN_ID))?.url ?? null;
      if (!url) throw new Error('No network endpoint is configured for this network.');
      const quote = await prepareEvmReplacement(url, group, action, chain);
      if (mounted.current) setDraft({ group, action, state: { kind: 'ready', quote, url } });
    } catch (e) {
      const d = describeReplacementError(e, symbol);
      if (mounted.current) setDraft({ group, action, state: { kind: 'failed', ...d } });
    }
  };

  const approve = async () => {
    if (!draft || draft.state.kind !== 'ready') return;
    const { quote, url } = draft.state;
    const action = draft.action;
    const fail = (e: unknown) => {
      const d = describeReplacementError(e, symbol);
      if (mounted.current) setDraft((prev) => (prev ? { ...prev, state: { kind: 'failed', ...d } } : prev));
    };
    // Quote pinning, as on the Send screen: the quote is one endpoint's answer.
    let currentUrl: string | null = null;
    try {
      currentUrl = (await getEndpoint(EVM_CHAIN_ID))?.url ?? null;
    } catch {
      currentUrl = null;
    }
    const changed = quoteEndpointChange(url, currentUrl);
    if (changed) {
      fail(new ReplacementRefusedError(changed));
      return;
    }
    // Still pending, nonce unused, fees still above every broadcast for this
    // nonce (re-read from the registry now), quote not used: before any prompt.
    try {
      const reg = await loadPendingRegistry();
      const fresh = groupForHash(nonceGroups(reg.records, chain, from), quote.replacement.replaces) ?? draft.group;
      await checkReplacementBeforeApproval(url, quote, fresh);
    } catch (e) {
      fail(e);
      return;
    }
    // Spending limits: the fee counts, the value does not (already counted).
    const input = replacementSpendingInput({ fee: quote.fee, from: quote.replacement.from });
    let allowed = false;
    try {
      const check = await evaluateBeforeSigning({
        scope: { chain, owner: from },
        spender: input.spender,
        calls: input.calls,
        fee: input.fee,
        url: null,
      });
      allowed = await confirmSpendingCheck(check);
    } catch (e) {
      Alert.alert('Spending limits could not be checked', `Nothing was signed. ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!allowed) return;
    const auth = await requireLocalAuth(replacementPromptTitle(action));
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setDraft((prev) => (prev ? { ...prev, state: { kind: 'sending', quote, url } } : prev));
    try {
      const sent = await signWith(EVM_CHAIN_ID, from, (signer) =>
        sendEvmReplacement(url, signer, quote, evmChain.explorerTxBase),
      );
      void recordAcceptedSpend({
        scope: { chain, owner: from },
        spender: input.spender,
        calls: input.calls,
        fee: input.fee,
        ref: sent.txid,
      });
      if (mounted.current) setDraft(null);
      Alert.alert(
        action === 'speed-up' ? 'Speed-up sent' : 'Cancellation sent',
        `Replacement ${shortHash(sent.txid)} was accepted by the network endpoint. Activity shows which transaction ` +
          'is included once a block includes one of them.',
      );
      void refresh();
    } catch (e) {
      fail(e);
    }
  };

  const checkOp = async (record: PendingUserOpRecord) => {
    setUserOps((prev) => prev.map((p) => (p.record.userOpHash === record.userOpHash ? { ...p, checking: true, error: null } : p)));
    try {
      const aa = await getAaConfig(chain);
      if (!aa.bundlerUrl) throw new Error('No bundler is configured for this network, so the status cannot be read.');
      const status = await checkUserOperation(httpTransport(aa.bundlerUrl), record, Date.now());
      if (status.state === 'included') {
        // Activity lists the bundle transaction from now on.
        await forgetUserOperation({ chain, userOpHash: record.userOpHash }).catch(() => undefined);
      }
      if (mounted.current) {
        setUserOps((prev) =>
          prev.map((p) => (p.record.userOpHash === record.userOpHash ? { ...p, status, checking: false } : p)),
        );
      }
    } catch (e) {
      if (mounted.current) {
        setUserOps((prev) =>
          prev.map((p) =>
            p.record.userOpHash === record.userOpHash
              ? { ...p, checking: false, error: e instanceof Error ? e.message : String(e) }
              : p,
          ),
        );
      }
    }
  };

  const sendAgain = async (record: PendingUserOpRecord) => {
    // One more look first: an operation that was included after all must
    // not be sent twice.
    try {
      const aa = await getAaConfig(chain);
      if (aa.bundlerUrl) {
        const status = await checkUserOperation(httpTransport(aa.bundlerUrl), record, Date.now());
        if (status.state !== 'unknown' || !status.resendOffered) {
          setUserOps((prev) => prev.map((p) => (p.record.userOpHash === record.userOpHash ? { ...p, status } : p)));
          return;
        }
      }
    } catch {
      Alert.alert('Not opened', 'The bundler could not be asked about the operation just now, so it was not sent again. Try again in a moment.');
      return;
    }
    await forgetUserOperation({ chain, userOpHash: record.userOpHash }).catch(() => undefined);
    onSendAgain?.(record);
  };

  const shownGroups = onlyHash
    ? groups.filter((g) => g.group.txs.some((t) => t.hash === onlyHash.toLowerCase()))
    : groups;
  const shownNotices = onlyHash ? notices.filter((n) => n.hashes.includes(onlyHash.toLowerCase())) : notices;
  const shownOps = onlyHash ? [] : userOps;
  if (!registry) return null;
  if (!registry.readOnly && shownGroups.length === 0 && shownNotices.length === 0 && shownOps.length === 0) return null;

  const card = [styles.card, { backgroundColor: theme.card, borderColor: theme.border }];
  return (
    <View style={styles.section}>
      {onlyHash ? null : (
        <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>
          Pending on this phone
        </Text>
      )}
      {registry.readOnly && !onlyHash ? (
        <View style={card}>
          <Text style={[styles.text, { color: theme.warningText }]}>{PENDING_READ_ONLY_MESSAGE}</Text>
          <Button
            title="Reset the pending list"
            variant="secondary"
            onPress={() =>
              Alert.alert(
                'Reset the pending list?',
                'This forgets every pending transaction this phone remembers, on every network. Nothing on the network changes; you can no longer speed them up from here.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Reset', style: 'destructive', onPress: () => void resetPendingRegistry().then(refresh) },
                ],
              )
            }
          />
        </View>
      ) : null}
      {shownGroups.map(({ group, status }) => {
        const editing = draft && draft.group.nonce === group.nonce ? draft : null;
        const latestIsCancel = group.latest.action === 'cancel';
        return (
          <View key={`${group.chain}:${group.nonce}`} style={card}>
            <Text
              accessibilityLabel={withShortAddresses(pendingGroupSentence(group, { nativeSymbol: symbol, nowMs }))}
              style={[styles.text, { color: theme.text }]}
            >
              {pendingGroupSentence(group, { nativeSymbol: symbol, nowMs })}
            </Text>
            <Text style={[styles.muted, { color: theme.textMuted }]}>
              Newest version {shortHash(group.latest.hash)}
              {latestIsCancel ? ' (a cancellation)' : ''}: {feeLine(BigInt(group.latest.maxFeePerGas), BigInt(group.latest.maxPriorityFeePerGas))}.
            </Text>
            {status === null ? (
              <Text style={[styles.muted, { color: theme.textMuted }]}>Checking with the network endpoint…</Text>
            ) : status.state === 'pending' ? (
              <Text style={[styles.muted, { color: theme.textMuted }]}>{poolSentence(status, group)}</Text>
            ) : status.state === 'nonce-used' ? (
              <>
                <Text style={[styles.text, { color: theme.warningText }]}>
                  No longer pending: this account has already used nonce {group.nonce}, but the endpoint returned no receipt
                  for any version this wallet sent. It may have been replaced outside this wallet.
                </Text>
                <Button
                  title="Remove from this list"
                  variant="secondary"
                  onPress={() => void settleNonce(group, null).then(refresh, refresh)}
                />
              </>
            ) : status.state === 'error' ? (
              <>
                <Text style={[styles.muted, { color: theme.textMuted }]}>
                  Its status could not be read right now. Pull down to refresh.
                </Text>
                <TechnicalDetail text={status.message} />
              </>
            ) : null}
            {status?.state === 'pending' && !editing ? (
              <View style={styles.actions}>
                <Button
                  title={latestIsCancel ? 'Speed up the cancellation' : 'Speed up'}
                  variant="secondary"
                  accessibilityHint="Prices the same transaction again with higher fees; nothing is signed until you approve"
                  onPress={() => void startReplacement(group, 'speed-up')}
                />
                {latestIsCancel ? null : (
                  <Button
                    title="Cancel"
                    variant="secondary"
                    accessibilityLabel="Cancel this transaction"
                    accessibilityHint="Prices a zero-value transfer to yourself with the same nonce; nothing is signed until you approve"
                    onPress={() => void startReplacement(group, 'cancel')}
                  />
                )}
              </View>
            ) : null}
            {editing ? <ReplacementConfirm draft={editing} from={from} onApprove={() => void approve()} onBack={() => setDraft(null)} /> : null}
          </View>
        );
      })}
      {shownNotices.map((n) => (
        <View key={`resolved:${n.nonce}:${n.minedHash}`} style={card}>
          <Text style={[styles.text, { color: theme.text }]}>{resolvedSentence(n)}</Text>
          <Button
            title="Dismiss"
            variant="secondary"
            onPress={() => void settleNonce(n, null).then(refresh, refresh)}
          />
        </View>
      ))}
      {shownOps.map(({ record, status, checking, error }) => (
        <View key={record.userOpHash} style={card}>
          {/* The title can carry a full recipient address (a multisig's, for
              one); it is spoken short (pass p20d finding 7). */}
          <Text accessibilityLabel={withShortAddresses(userOpCardTitle(record))} style={[styles.text, { color: theme.text }]}>
            {userOpCardTitle(record)}
          </Text>
          {userOpShowsNoReplacementSentence(status) ? (
            <Text style={[styles.muted, { color: theme.textMuted }]}>{SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE}</Text>
          ) : null}
          {status ? <Text style={[styles.text, { color: theme.text }]}>{userOpStatusSentence(status, record)}</Text> : null}
          <TechnicalDetail text={error} />
          <View style={styles.actions}>
            {checking ? (
              <ActivityIndicator color={theme.accent} accessibilityLabel="Checking the operation's status" />
            ) : (
              <Button title="Check status" variant="secondary" onPress={() => void checkOp(record)} />
            )}
            {status?.state === 'unknown' && status.resendOffered && userOpCanBeSentAgain(record) && onSendAgain ? (
              <Button title="Send again" variant="secondary" onPress={() => void sendAgain(record)} />
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function ReplacementConfirm({
  draft,
  from,
  onApprove,
  onBack,
}: {
  draft: ReplacementDraft;
  from: string;
  onApprove: () => void;
  onBack: () => void;
}) {
  const theme = useTheme();
  const { evmChain } = usePrefs();
  const symbol = evmChain.displaySymbol;
  const s = draft.state;
  if (s.kind === 'quoting') {
    return <ActivityIndicator color={theme.accent} accessibilityLabel="Pricing the replacement" />;
  }
  if (s.kind === 'failed') {
    return (
      <View style={styles.confirm}>
        <Text accessibilityLiveRegion="polite" style={[styles.text, { color: theme.danger }]}>
          {s.title}
        </Text>
        <Text style={[styles.text, { color: theme.text }]}>{s.detail}</Text>
        <TechnicalDetail text={s.technical} />
        <Button title="Back" variant="secondary" onPress={onBack} />
      </View>
    );
  }
  const q = s.quote;
  const r = q.replacement;
  const cancel = r.recordedAction === 'cancel';
  const fmt = (wei: bigint) => formatUnits(wei, 18, 18);
  return (
    <View style={styles.confirm}>
      <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>{draft.action === 'speed-up' ? 'Speed up' : 'Cancel the transaction'}</Text>
      <Text style={[styles.muted, { color: theme.textMuted }]}>{cancel ? CANCEL_EXPLAINER : SPEED_UP_EXPLAINER}</Text>
      <Text style={[styles.text, { color: theme.text }]}>
        Replaces {shortHash(r.replaces)} (nonce {q.nonce.toString()}).
      </Text>
      <Text style={[styles.text, { color: theme.text }]}>
        {cancel ? `Sends 0 ${symbol} to ${q.to}` : `Sends ${fmt(q.amount)} ${symbol} to ${q.to}`}
        {q.data && q.data.length > 0 ? ` with ${q.data.length} bytes of calldata (unchanged)` : ''}; gas limit {q.gasLimit.toString()}.
      </Text>
      <Text style={[styles.text, { color: theme.text }]}>
        New fees: {feeLine(q.maxFeePerGas, q.maxPriorityFeePerGas)} (was {feeLine(r.pooled.maxFeePerGas, r.pooled.maxPriorityFeePerGas)};
        the network requires at least {feeLine(r.fees.minimum.maxFeePerGas, r.fees.minimum.maxPriorityFeePerGas)}).
      </Text>
      <Text style={[styles.text, { color: theme.text }]}>
        Network fee (worst case): {fmt(q.fee)} {symbol}
        {q.opStack ? ' (including the layer 1 data fee)' : ''}. Total (worst case): {fmt(q.total)} {symbol}.
      </Text>
      {cancel ? (
        <Text style={[styles.text, { color: theme.text }]}>{cancelRiskLine(from)}</Text>
      ) : (
        <RiskWarnings url={s.url} wallet={from} to={q.to} data={q.data} />
      )}
      {q.simulation.ok ? (
        <Text style={[styles.text, { color: theme.success }]}>Pre-flight simulation passed (eth_call).</Text>
      ) : (
        <Text style={[styles.text, { color: theme.danger }]}>
          Pre-flight simulation failed: {q.simulation.reason}. A speed-up is not offered while it fails; cancelling is.
        </Text>
      )}
      <Text style={[styles.muted, { color: theme.textMuted }]}>{REPLACEMENT_SPENDING_NOTE}</Text>
      {s.kind === 'sending' ? (
        <ActivityIndicator color={theme.accent} accessibilityLabel="Sending the replacement" />
      ) : (
        <View style={styles.actions}>
          <Button
            title={draft.action === 'speed-up' ? 'Approve speed-up' : 'Approve cancellation'}
            disabled={!q.simulation.ok}
            onPress={onApprove}
          />
          <Button title="Back" variant="secondary" onPress={onBack} />
        </View>
      )}
    </View>
  );
}

/** The Send screen's "Send again" pre-fill for a dropped smart-account operation. */
export function resendPrefill(record: PendingUserOpRecord): { recipient: string; amountText: string; lines: string[]; tokenId: string | null } | null {
  if (!record.resend) return null;
  return {
    recipient: record.resend.recipient,
    amountText: formatUnits(BigInt(record.resend.amount), record.resend.decimals, record.resend.decimals),
    lines: [USEROP_RESEND_LINE],
    tokenId: record.resend.tokenId,
  };
}

const styles = StyleSheet.create({
  section: { gap: 10, marginBottom: 12 },
  heading: { fontSize: 16, fontWeight: '700' },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  text: { fontSize: 14, lineHeight: 20 },
  muted: { fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  confirm: { gap: 8, marginTop: 4 },
});

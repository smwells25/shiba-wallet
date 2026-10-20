import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { formatAssetId, type FungibleAsset } from '@shiba-wallet/core';
import { randomBytes } from '@noble/hashes/utils.js';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, WatchOnlyNotice, screenStyle, switchColors, useFieldLabels } from '../components';
import { ShareActions } from '../components/RecoveryViews';
import { QrScanner } from '../components/QrScanner';
import { BalanceChangePreview } from '../components/BalanceChangePreview';
import { RiskWarnings } from '../components/RiskWarnings';
import { SpendingPolicyNotice, confirmSpendingCheck, spendingGateForQuote } from '../components/SpendingPolicyViews';
import { PendingTransactionsSection } from '../components/PendingTransactions';
import { PaymentRequestNotice } from '../components/PaymentRequestViews';
import { NOTE_VIEW_SCROLL_PROPS, TransactionNoteField, dismissKeyboardThenClose } from '../components/TransactionNoteField';
import { getEndpoint, withEndpoint } from '../config/networks';
import { useTheme, type Theme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { formatUnits, parseUnits } from '../wallet/balances';
import {
  EVM_CHAIN_ID,
  MINIMUM_FEE_REHEARSAL_WARNING,
  amountIsLastMax,
  maxAdjustmentSentence,
  maxEvmSend,
  checkReplacementBeforeApproval,
  consumeMinimumFeeRehearsal,
  minimumFeeRehearsalArmed,
  minimumFeeRehearsalFeeLine,
  minimumFeeRehearsalOf,
  describeSendError,
  prepareEvmReplacement,
  prepareEvmSend,
  quoteEndpointChange,
  sendEvmReplacementWithSignature,
  sendEvmWithSignature,
  validateRecipient,
  QUOTE_ENDPOINT_CHANGED_TITLE,
  ReplacementRefusedError,
  type EvmReplacementQuote,
  type EvmSendQuote,
  type LastMaxResult,
  type SendResult,
} from '../wallet/send';
import { maxErc20Send, prepareErc20Send, type Erc20SendQuote } from '../wallet/send-erc20';
import { listTokens } from '../wallet/tokens';
import { extractScannedAddress } from '../wallet/scan';
import {
  CANCEL_EXPLAINER,
  SPEED_UP_EXPLAINER,
  cancelRiskLine,
  feeLine,
  groupForHash,
  loadPendingRegistry,
  nonceGroups,
  replacementSpendingInput,
  shortHash,
} from '../wallet/pending-transactions';
import { evaluateBeforeSigning, recordAcceptedSpend } from '../wallet/spending-policy';
import {
  COLD_SIGN_BROADCAST_BUTTON,
  COLD_SIGN_CHECK_ON_SIGNER,
  COLD_SIGN_CHECK_PASTED_BUTTON,
  COLD_SIGN_FORMAT_NOTE,
  COLD_SIGN_INTRO,
  COLD_SIGN_PASTE_LABEL,
  COLD_SIGN_QR_CONTENTS,
  COLD_SIGN_REVIEW_AGAIN_NOTE,
  COLD_SIGN_SCAN_BUTTON,
  COLD_SIGN_SCAN_NOTE,
  COLD_SIGN_SCAN_RATIONALE,
  COLD_SIGN_SCREEN_TITLE,
  COLD_SIGN_SHOW_BUTTON,
  buildColdSignRequest,
  coldSignAccountRefusal,
  coldSignBroadcastQuote,
  coldSignSummary,
  coldSignTxFromQuote,
  coldSignVerifiedLine,
  newColdSignRequestId,
  serializeColdSignRequest,
  verifyColdSignSignature,
  type ColdSignRequest,
  type ColdSignVerified,
} from '../wallet/cold-signing';
import { ColdSignPayloadQr, ColdSignScanButton } from './ColdSignViews';

type Props = NativeStackScreenProps<RootStackParamList, 'ColdSign'>;

type Phase = 'form' | 'quoting' | 'review' | 'show' | 'sending' | 'success';

type ColdQuote = EvmSendQuote | Erc20SendQuote | EvmReplacementQuote;

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/**
 * A failure as the screen shows it: a replacement refusal by its own
 * sentence, anything else as the Send screen words it — including, for a
 * broadcast of a minimum-fee rehearsal quote that the node refused as
 * underpriced, the rehearsal note the Send screen adds (pass p22b:
 * describeSendError's minimumFeeRehearsal option, which this screen did not
 * pass).
 */
function describeColdError(
  e: unknown,
  sendSymbol: string,
  feeSymbol: string,
  options: { minimumFeeRehearsal?: boolean } = {},
): { title: string; detail: string } {
  if (e instanceof ReplacementRefusedError || (e as { name?: unknown } | null)?.name === 'ReplacementRefusedError') {
    return { title: 'Not replaced', detail: (e as Error).message };
  }
  const d = describeSendError(e, sendSymbol, feeSymbol, options);
  return { title: d.title, detail: d.detail };
}

function Row({ label, value, monoValue = false, theme }: { label: string; value: string; monoValue?: boolean; theme: Theme }) {
  return (
    <View style={styles.rowBlock}>
      <Text style={[styles.label, { color: theme.textMuted }]}>{label}</Text>
      <Text selectable style={[monoValue ? styles.monoText : styles.body, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

function isReplacement(q: ColdQuote | null): q is EvmReplacementQuote {
  return q !== null && q.kind === 'evm' && 'replacement' in q;
}

/**
 * Cold signing, the QR half (feature 11, phase 22 item 3). For a WATCH-ONLY
 * account only: the send is prepared exactly as on the Send screen (the same
 * validateRecipient, prepareEvmSend / prepareErc20Send quote through the
 * same endpoint and failover rule, the same balance-change preview, risk
 * card, pre-flight gate and spending-limit gate), and then, instead of
 * signing, the unsigned transaction is shown as QR codes for an off-line
 * signer. Its signature is scanned (or pasted) back and checked against the
 * request STORED here (wallet/cold-signing.ts verifyColdSignSignature); only
 * then is it broadcast, through send.ts sendEvmWithSignature, which notifies
 * the same listeners as every regular send (the pending registry, so
 * Activity's card shows it; the spending recorder). With `replace` the
 * same flow speeds up or cancels the watched address's pending transaction
 * (prepareEvmReplacement / checkReplacementBeforeApproval /
 * sendEvmReplacementWithSignature).
 *
 * This screen never signs: it never calls signWith, never asks for the
 * device check and never reads the recovery phrase, an imported key or any
 * secure storage. Every other account is refused (coldSignAccountRefusal).
 */
export function ColdSignScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const field = useFieldLabels();
  const { accounts, activeAccount } = useWallet();
  const { evmChain } = usePrefs();
  const refusal = coldSignAccountRefusal(activeAccount);
  const account = accounts.find((a) => a.chainId === EVM_CHAIN_ID) ?? null;
  const from = account?.address ?? null;
  const symbol = evmChain.displaySymbol;
  const replace = route.params?.replace ?? null;

  const [phase, setPhase] = useState<Phase>(replace ? 'quoting' : 'form');
  const [tokens, setTokens] = useState<FungibleAsset[]>([]);
  const [tokenId, setTokenId] = useState<string | null>(route.params?.tokenId ?? null);
  const token = tokenId ? (tokens.find((t) => formatAssetId(t.assetId) === tokenId) ?? null) : null;
  // A payment link opened while this watch-only account was active (pass
  // p22b, deep-links.ts 'cold-sign'): its values only pre-fill the editable
  // fields, and its lines (DEEP_LINK_PAY_LINE first) show in the "Payment
  // request" box, as on the Send screen.
  const requestPrefill = route.params?.request ?? null;
  const [recipient, setRecipient] = useState(requestPrefill?.recipient ?? '');
  const [amountText, setAmountText] = useState(requestPrefill?.amountText ?? '');
  // The amount text Max last wrote (and for which address): Review passes
  // fromMax to prepareEvmSend only while the form still holds exactly it, as
  // on the Send screen (a fee rise lowers a Max amount with a note; a typed
  // amount is never changed).
  const lastMax = useRef<LastMaxResult | null>(null);
  const [maxBusy, setMaxBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [quote, setQuote] = useState<ColdQuote | null>(null);
  const [quotedUrl, setQuotedUrl] = useState<string | null>(null);
  const [overrideSimulation, setOverrideSimulation] = useState(false);
  const [request, setRequest] = useState<ColdSignRequest | null>(null);
  const [verified, setVerified] = useState<ColdSignVerified | null>(null);
  const [signatureText, setSignatureText] = useState('');
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    navigation.setOptions({ title: COLD_SIGN_SCREEN_TITLE });
  }, [navigation]);

  // The active network's tracked tokens (the same list the Send screen reads).
  useEffect(() => {
    let cancelled = false;
    listTokens(evmChain.caip2).then(
      (list) => {
        if (!cancelled) setTokens(list);
      },
      () => {
        if (!cancelled) setTokens([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [evmChain.caip2]);

  const fail = (e: unknown, sym: string) => setError(describeColdError(e, sym, symbol));

  // Replacement mode: price the speed-up or cancellation of the pending
  // transaction with this hash, exactly as Activity's card does.
  const replaceHash = replace?.hash ?? null;
  const replaceAction = replace?.action ?? null;
  useEffect(() => {
    if (!replaceHash || !replaceAction || !from || refusal) return;
    let cancelled = false;
    void (async () => {
      try {
        const reg = await loadPendingRegistry();
        const group = groupForHash(nonceGroups(reg.records, evmChain.caip2, from), replaceHash);
        if (!group) throw new ReplacementRefusedError('This transaction is no longer listed as pending on this phone. Nothing was prepared.');
        const url = (await getEndpoint(EVM_CHAIN_ID))?.url ?? null;
        if (!url) throw new Error('No network endpoint is configured for this network.');
        const q = await prepareEvmReplacement(url, group, replaceAction, evmChain.caip2);
        if (cancelled) return;
        setQuote(q);
        setQuotedUrl(url);
        setPhase('review');
      } catch (e) {
        if (cancelled) return;
        setError(describeColdError(e, symbol, symbol));
        setPhase('form');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replaceHash, replaceAction, from, refusal, evmChain.caip2, symbol]);

  if (refusal || !from) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <WarningBox>{refusal ?? 'This account has no Ethereum address.'}</WarningBox>
      </ScrollView>
    );
  }

  const recipientField = field('cold-recipient', 'Recipient address');
  const amountField = field('cold-amount', `Amount (${token ? token.symbol : symbol})`);
  const signatureField = field('cold-signature', COLD_SIGN_PASTE_LABEL);
  const decimals = token ? token.decimals : 18;
  const sendSymbol = token ? token.symbol : symbol;
  const fmt = (wei: bigint) => formatUnits(wei, 18, 18);

  const onReview = async () => {
    setError(null);
    const validation = validateRecipient(EVM_CHAIN_ID, recipient);
    if (!validation.ok) {
      setError({ title: 'Check the recipient', detail: validation.error });
      return;
    }
    let amount: bigint;
    try {
      amount = parseUnits(amountText, decimals);
      if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
    } catch (e) {
      setError({ title: 'Check the amount', detail: e instanceof Error ? e.message : 'Invalid amount.' });
      return;
    }
    setPhase('quoting');
    try {
      // The Send screen's quotes, through the same endpoint and failover rule.
      const outcome = await withEndpoint<EvmSendQuote | Erc20SendQuote>(EVM_CHAIN_ID, (ep) =>
        token
          ? prepareErc20Send({
              url: ep.url,
              from,
              to: validation.normalized,
              contract: token.assetId.reference,
              amount,
              symbol: token.symbol,
              decimals: token.decimals,
              chainCaip2: token.assetId.chainId,
            })
          : // Settings → Developer's one-shot minimum-fee rehearsal (test networks
            // only; prepareEvmSend ignores it elsewhere), so a cold-signed send
            // can be left pending to rehearse a cold-signed Speed up / Cancel.
            prepareEvmSend(ep.url, from, validation.normalized, amount, undefined, evmChain.caip2, {
              fromMax: amountIsLastMax(lastMax.current, { text: amountText, from, chainId: EVM_CHAIN_ID }),
              ...(minimumFeeRehearsalArmed(evmChain.caip2) ? { minimumFee: true } : {}),
            }),
      );
      if (!mounted.current) return;
      setQuote(outcome.value);
      setQuotedUrl(outcome.endpoint.url);
      setOverrideSimulation(false);
      setPhase('review');
    } catch (e) {
      if (!mounted.current) return;
      fail(e, sendSymbol);
      setPhase('form');
    }
  };

  // Max, with the Send screen's own rule and functions (pass p22b): the
  // native coin = the balance minus the worst-case fee (send.ts maxEvmSend);
  // a token = its full balance, refused when the ETH balance cannot cover
  // the fee (send-erc20.ts maxErc20Send). The recipient, when valid, is used
  // for the estimate, as on the Send screen.
  const onMax = async () => {
    setError(null);
    lastMax.current = null;
    setMaxBusy(true);
    try {
      const validation = validateRecipient(EVM_CHAIN_ID, recipient);
      const to = validation.ok ? validation.normalized : undefined;
      let max: bigint;
      if (token) {
        max = (
          await withEndpoint(EVM_CHAIN_ID, (ep) => maxErc20Send(ep.url, from, token.assetId.reference, to, token.assetId.chainId))
        ).value;
        if (max <= 0n) throw new Error(`Your ${token.symbol} balance is zero.`);
      } else {
        max = (await withEndpoint(EVM_CHAIN_ID, (ep) => maxEvmSend(ep.url, from, to))).value;
      }
      if (max <= 0n) throw new Error('Balance is too small to cover the network fee.');
      const text = formatUnits(max, decimals, decimals);
      if (!mounted.current) return;
      if (!token) lastMax.current = { text, from, chainId: EVM_CHAIN_ID };
      setAmountText(text);
    } catch (e) {
      if (!mounted.current) return;
      fail(e, sendSymbol);
    } finally {
      if (mounted.current) setMaxBusy(false);
    }
  };

  const onShow = async () => {
    if (!quote || !quotedUrl) return;
    setError(null);
    // Spending limits, as on the Send screen and Activity's card: BEFORE the
    // request exists (the off-line signer signs what it is shown).
    let allowed: boolean;
    if (isReplacement(quote)) {
      const input = replacementSpendingInput({ fee: quote.fee, from: quote.replacement.from });
      try {
        const check = await evaluateBeforeSigning({
          scope: { chain: evmChain.caip2, owner: from },
          spender: input.spender,
          calls: input.calls,
          fee: input.fee,
          url: null,
        });
        allowed = await confirmSpendingCheck(check);
      } catch (e) {
        Alert.alert('Spending limits could not be checked', `Nothing was prepared. ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    } else {
      allowed = await spendingGateForQuote({ chain: evmChain.caip2, owner: from, from, quote, url: quotedUrl });
    }
    if (!allowed) return;
    try {
      const tx = coldSignTxFromQuote(quote);
      const summary = coldSignSummary({
        tx,
        from,
        nativeSymbol: symbol,
        ...(quote.kind === 'erc20' ? { token: { symbol: quote.symbol, decimals: quote.decimals } } : {}),
        fee: quote.fee,
        ...(isReplacement(quote)
          ? { replacement: { action: quote.replacement.recordedAction, replaces: quote.replacement.replaces } }
          : {}),
      });
      const built = buildColdSignRequest({ tx, from, summary, requestId: newColdSignRequestId((n) => randomBytes(n)) });
      setRequest(built);
      setVerified(null);
      setSignatureText('');
      setSignatureError(null);
      setPhase('show');
    } catch (e) {
      setError({ title: 'The request could not be prepared', detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const onSignatureText = (text: string) => {
    if (!request) return;
    setSignatureError(null);
    try {
      setVerified(verifyColdSignSignature(text, request));
    } catch (e) {
      setVerified(null);
      setSignatureError(e instanceof Error ? e.message : String(e));
    }
  };

  const onBroadcast = async () => {
    if (!quote || !quotedUrl || !verified || !request) return;
    setError(null);
    // Quote pinning, as on the Send screen: the broadcast goes out through
    // the endpoint the quote came from, and only while it is still the one
    // the wallet would use.
    let currentUrl: string | null = null;
    try {
      currentUrl = (await getEndpoint(EVM_CHAIN_ID))?.url ?? null;
    } catch {
      currentUrl = null;
    }
    const changed = quoteEndpointChange(quotedUrl, currentUrl);
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      setPhase('form');
      setQuote(null);
      setRequest(null);
      setVerified(null);
      return;
    }
    setPhase('sending');
    try {
      let sent: SendResult;
      if (isReplacement(quote)) {
        // Still pending, nonce unused, fees still above every broadcast for
        // this nonce (re-read now): the same checks as Activity's card.
        const reg = await loadPendingRegistry();
        const group = groupForHash(nonceGroups(reg.records, evmChain.caip2, from), quote.replacement.replaces);
        if (!group) throw new ReplacementRefusedError('This transaction is no longer listed as pending on this phone. Nothing was sent.');
        await checkReplacementBeforeApproval(quotedUrl, quote, group);
        sent = await sendEvmReplacementWithSignature(quotedUrl, from, quote, verified.signature, evmChain.explorerTxBase);
        const input = replacementSpendingInput({ fee: quote.fee, from: quote.replacement.from });
        void recordAcceptedSpend({
          scope: { chain: evmChain.caip2, owner: from },
          spender: input.spender,
          calls: input.calls,
          fee: input.fee,
          ref: sent.txid,
        });
      } else {
        sent = await sendEvmWithSignature(quotedUrl, from, coldSignBroadcastQuote(quote), verified.signature, evmChain.explorerTxBase);
      }
      // One-shot: a minimum-fee rehearsal quote that was just sent turns the
      // Developer option off, as on the Send screen.
      consumeMinimumFeeRehearsal(quote);
      if (!mounted.current) return;
      setResult(sent);
      setPhase('success');
    } catch (e) {
      if (!mounted.current) return;
      setError(describeColdError(e, sendSymbol, symbol, { minimumFeeRehearsal: minimumFeeRehearsalOf(quote) !== null }));
      setPhase('show');
    }
  };

  // ---------------------------------------------------------------- success
  if (phase === 'success' && result) {
    return (
      <ScrollView key="cold-success" style={screenStyle(theme)} contentContainerStyle={styles.content} {...NOTE_VIEW_SCROLL_PROPS}>
        <Text accessibilityRole="header" style={[styles.heading, { color: theme.success }]}>Sent ✓</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The signed transaction was accepted by the network endpoint.
        </Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>Transaction id</Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>{result.txid}</Text>
        </View>
        {result.explorerUrl ? (
          <Button title="View on block explorer" variant="secondary" onPress={() => void Linking.openURL(result.explorerUrl!)} />
        ) : null}
        <TransactionNoteField network={evmChain.caip2} txid={result.txid} userOpHash={null} />
        <PendingTransactionsSection from={from} onlyHash={result.txid} />
        <Button title="Done" onPress={() => dismissKeyboardThenClose(() => navigation.popToTop())} />
      </ScrollView>
    );
  }

  // ------------------------------------------------------- show / signature
  if ((phase === 'show' || phase === 'sending') && request && quote) {
    const payload = serializeColdSignRequest(request);
    return (
      <ScrollView key="cold-show" style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <WatchOnlyNotice />
        <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>For the off-line signer</Text>
        <Text style={[styles.body, { color: theme.text }]}>{request.summary}</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{COLD_SIGN_QR_CONTENTS}</Text>
        <WarningBox>{COLD_SIGN_CHECK_ON_SIGNER}</WarningBox>
        <ColdSignPayloadQr payload={payload} caption="Unsigned transaction for the off-line signer" />
        <Text style={[styles.hint, { color: theme.textMuted }]}>{COLD_SIGN_FORMAT_NOTE}</Text>
        <ShareActions text={payload} shareTitle="Unsigned transaction" />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Request {request.requestId} · signing hash {request.signingHash}
        </Text>

        <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>The signature</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{COLD_SIGN_SCAN_NOTE}</Text>
        <ColdSignScanButton
          title={COLD_SIGN_SCAN_BUTTON}
          rationale={COLD_SIGN_SCAN_RATIONALE}
          onComplete={onSignatureText}
          onError={(message) => {
            setVerified(null);
            setSignatureError(message);
          }}
        />
        <Text {...signatureField.label} style={[styles.label, { color: theme.textMuted }]}>{signatureField.text}</Text>
        <TextInput
          {...signatureField.input}
          value={signatureText}
          onChangeText={(t) => {
            setSignatureText(t);
            setSignatureError(null);
          }}
          placeholder="Paste the signature JSON"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[styles.input, styles.multiline, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.card }]}
        />
        <Button
          title={COLD_SIGN_CHECK_PASTED_BUTTON}
          variant="secondary"
          disabled={signatureText.trim() === ''}
          onPress={() => onSignatureText(signatureText)}
        />
        {signatureError ? (
          <Text accessibilityLiveRegion="polite" style={[styles.body, { color: theme.danger }]}>{signatureError}</Text>
        ) : null}
        {verified ? (
          <>
            <Text accessibilityLiveRegion="polite" style={[styles.body, { color: theme.success }]}>{coldSignVerifiedLine(request.from)}</Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>Transaction id once broadcast: {verified.signed.txHash}</Text>
          </>
        ) : null}
        {error ? (
          <View style={styles.stack}>
            <Text style={[styles.body, { color: theme.danger }]}>{error.title}</Text>
            <Text style={[styles.body, { color: theme.text }]}>{error.detail}</Text>
          </View>
        ) : null}
        {phase === 'sending' ? (
          <ActivityIndicator color={theme.accent} accessibilityLabel="Broadcasting the signed transaction" />
        ) : (
          <>
            <Button title={COLD_SIGN_BROADCAST_BUTTON} disabled={!verified} onPress={() => void onBroadcast()} />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                setRequest(null);
                setVerified(null);
                setPhase('review');
              }}
            />
          </>
        )}
        <Text style={[styles.hint, { color: theme.textMuted }]}>{COLD_SIGN_REVIEW_AGAIN_NOTE}</Text>
      </ScrollView>
    );
  }

  // ----------------------------------------------------------------- review
  if (phase === 'review' && quote) {
    const replacement = isReplacement(quote) ? quote : null;
    const cancel = replacement?.replacement.recordedAction === 'cancel';
    const tx = coldSignTxFromQuote(quote);
    const simulationFailed = !quote.simulation.ok || (quote.kind === 'erc20' && quote.returnedFalse);
    return (
      <ScrollView key="cold-review" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <WatchOnlyNotice />
        <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>
          {replacement ? (cancel ? 'Cancel the transaction' : 'Speed up') : 'Review'}
        </Text>
        {replacement ? (
          <>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{cancel ? CANCEL_EXPLAINER : SPEED_UP_EXPLAINER}</Text>
            <Text style={[styles.body, { color: theme.text }]}>
              Replaces {shortHash(replacement.replacement.replaces)} (nonce {replacement.nonce.toString()}). New fees:{' '}
              {feeLine(replacement.maxFeePerGas, replacement.maxPriorityFeePerGas)} (was{' '}
              {feeLine(replacement.replacement.pooled.maxFeePerGas, replacement.replacement.pooled.maxPriorityFeePerGas)}).
            </Text>
          </>
        ) : null}
        <Row label="Network" value={`${evmChain.label} (chain id ${quote.chainId.toString()})`} theme={theme} />
        <Row label="From (watched address)" value={from} monoValue theme={theme} />
        {quote.kind === 'erc20' ? (
          <>
            <Row label="To" value={quote.to} monoValue theme={theme} />
            <Row label="Amount" value={`${formatUnits(quote.amount, quote.decimals, quote.decimals)} ${quote.symbol}`} theme={theme} />
            <Row label="Token contract" value={quote.contract} monoValue theme={theme} />
          </>
        ) : (
          <>
            <Row label="To" value={quote.to} monoValue theme={theme} />
            <Row label="Amount" value={`${fmt(quote.amount)} ${symbol}`} theme={theme} />
          </>
        )}
        {quote.kind === 'evm' && quote.maxAdjustment ? (
          <WarningBox>{maxAdjustmentSentence(quote, (v) => `${fmt(v)} ${symbol}`)}</WarningBox>
        ) : null}
        <Row label="Nonce" value={quote.nonce.toString()} theme={theme} />
        <Row label="Network fee (worst case)" value={`${fmt(quote.fee)} ${symbol}`} theme={theme} />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Worst case at {formatUnits(quote.maxFeePerGas, 9, 9)} gwei max fee × {quote.gasLimit.toString()} gas
          {quote.opStack ? ', plus the layer 1 data fee' : ''}; the actual fee is usually lower.
        </Text>
        {quote.kind === 'evm' && minimumFeeRehearsalOf(quote) ? (
          <>
            <WarningBox>{MINIMUM_FEE_REHEARSAL_WARNING}</WarningBox>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{minimumFeeRehearsalFeeLine(quote)}</Text>
          </>
        ) : null}
        <BalanceChangePreview url={quotedUrl} request={{ from, to: tx.to!, value: tx.value, ...(tx.data ? { data: tx.data } : {}) }} />
        {cancel ? (
          <Text style={[styles.body, { color: theme.text }]}>{cancelRiskLine(from)}</Text>
        ) : (
          <RiskWarnings
            url={quotedUrl}
            wallet={from}
            to={tx.to!}
            {...(quote.kind === 'erc20' ? { counterparty: quote.to } : {})}
            {...(tx.data ? { data: tx.data } : {})}
          />
        )}
        {replacement ? null : <SpendingPolicyNotice owner={from} quote={quote} from={from} />}
        {!simulationFailed ? (
          <Text style={[styles.body, { color: theme.success }]}>Pre-flight simulation passed (eth_call).</Text>
        ) : (
          <View style={styles.stack}>
            <WarningBox>
              {quote.simulation.ok
                ? 'The token contract reports the transfer would not go through: it returned false instead of reverting.'
                : `Pre-flight simulation failed: ${quote.simulation.reason}. This transaction would very likely fail on-chain and still cost the fee.`}
            </WarningBox>
            <View style={styles.overrideRow}>
              <Switch {...switchColors(theme)}
                accessibilityLabel="Prepare it anyway, although the pre-flight simulation failed"
                value={overrideSimulation}
                onValueChange={setOverrideSimulation}
              />
              <Text importantForAccessibility="no" style={[styles.body, { color: theme.text, flex: 1 }]}>
                Prepare it anyway (I understand it will probably fail)
              </Text>
            </View>
          </View>
        )}
        {error ? (
          <View style={styles.stack}>
            <Text style={[styles.body, { color: theme.danger }]}>{error.title}</Text>
            <Text style={[styles.body, { color: theme.text }]}>{error.detail}</Text>
          </View>
        ) : null}
        <Button title={COLD_SIGN_SHOW_BUTTON} disabled={simulationFailed && !overrideSimulation} onPress={() => void onShow()} />
        <Button
          title="Back"
          variant="secondary"
          onPress={() => (replacement ? navigation.goBack() : setPhase('form'))}
        />
      </ScrollView>
    );
  }

  // ------------------------------------------------------------------ form
  if (phase === 'quoting') {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator color={theme.accent} accessibilityLabel="Preparing the quote" />
      </View>
    );
  }
  return (
    <ScrollView key="cold-form" style={screenStyle(theme)} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <WatchOnlyNotice />
      <Text style={[styles.body, { color: theme.text }]}>{COLD_SIGN_INTRO}</Text>
      {requestPrefill && !replace ? <PaymentRequestNotice lines={requestPrefill.lines} /> : null}
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        {evmChain.label} · from {activeAccount?.name ?? ''} ({from})
      </Text>
      {replace ? null : (
        <>
          <Text accessibilityRole="header" style={[styles.heading, { color: theme.text }]}>What to send</Text>
          {/* Choice chips (pass p22a finding 2): the chosen asset is drawn
              like every other chip row in the app (Settings → Developer's
              network chips): a leading "✓" and the primary fill, with
              accessibilityState selected for screen readers (Button drops
              the "✓" from the spoken label). */}
          <View style={styles.row}>
            <Button
              title={assetChipTitle(symbol, tokenId === null)}
              variant={tokenId === null ? 'primary' : 'secondary'}
              selected={tokenId === null}
              onPress={() => setTokenId(null)}
            />
            {tokens.map((t) => {
              const id = formatAssetId(t.assetId);
              return (
                <Button
                  key={id}
                  title={assetChipTitle(t.symbol, tokenId === id)}
                  variant={tokenId === id ? 'primary' : 'secondary'}
                  selected={tokenId === id}
                  onPress={() => setTokenId(id)}
                />
              );
            })}
          </View>
          {token ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Sending {token.symbol} (token contract {token.assetId.reference}); the network fee is paid in {symbol}.
            </Text>
          ) : null}
          <Text {...recipientField.label} style={[styles.label, { color: theme.textMuted }]}>{recipientField.text}</Text>
          <TextInput
            {...recipientField.input}
            value={recipient}
            onChangeText={(t) => {
              setRecipient(t);
              setError(null);
            }}
            placeholder="0x…"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.card }]}
          />
          <Button title="Scan an address" variant="secondary" onPress={() => setScannerOpen(true)} />
          <QrScanner
            visible={scannerOpen}
            rationale="The camera reads the recipient's address from a QR code."
            onScanned={(data) => {
              setScannerOpen(false);
              setRecipient(extractScannedAddress(EVM_CHAIN_ID, data));
            }}
            onClose={() => setScannerOpen(false)}
          />
          <Text {...amountField.label} style={[styles.label, { color: theme.textMuted }]}>{amountField.text}</Text>
          <TextInput
            {...amountField.input}
            value={amountText}
            onChangeText={(t) => {
              setAmountText(t);
              setError(null);
            }}
            placeholder="0.0"
            placeholderTextColor={theme.textMuted}
            keyboardType="decimal-pad"
            style={[styles.input, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.card }]}
          />
          <Button
            title={maxBusy ? '…' : 'Max'}
            variant="secondary"
            onPress={() => void onMax()}
            disabled={maxBusy}
          />
        </>
      )}
      {error ? (
        <View style={styles.stack}>
          <Text accessibilityLiveRegion="polite" style={[styles.body, { color: theme.danger }]}>{error.title}</Text>
          <Text style={[styles.body, { color: theme.text }]}>{error.detail}</Text>
        </View>
      ) : null}
      {replace ? (
        <Button title="Back" variant="secondary" onPress={() => navigation.goBack()} />
      ) : (
        <Button title="Review" onPress={() => void onReview()} />
      )}
    </ScrollView>
  );

}

/** A choice chip's visible title: "✓ " before the chosen one (as Settings' network chips). */
function assetChipTitle(label: string, chosen: boolean): string {
  return chosen ? `✓ ${label}` : label;
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    gap: 12,
    paddingBottom: 48,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  stack: {
    gap: 6,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  rowBlock: {
    gap: 2,
  },
  overrideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  heading: {
    fontSize: 18,
    fontWeight: '700',
  },
  body: {
    fontSize: 15,
    lineHeight: 21,
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
  },
  box: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  },
  monoText: {
    fontFamily: mono,
    fontSize: 13,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
});

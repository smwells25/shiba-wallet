import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { formatAssetId } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle, useFieldLabels } from '../components';
import { NoEndpointError, getEndpoint, type NetworkEndpoint } from '../config/networks';
import { endpointHost } from '../config/endpoint-probe';
import { describeNetworkError, TechnicalDetail } from '../wallet/connectivity';
import { requireLocalAuth } from '../wallet/biometric';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { SOLANA_CHAIN_ID, notifySendAccepted } from '../wallet/send';
import { SolanaDevnetBanner } from '../components/SolanaDevnetBanner';
import { NOTE_VIEW_SCROLL_PROPS, TransactionNoteField, dismissKeyboardThenClose } from '../components/TransactionNoteField';
import { listSolanaTokens } from '../wallet/tokens';
import { pendingSolanaBroadcastRecorder } from '../wallet/pending-transactions';
import { SolanaPendingTransactionsSection } from '../components/PendingTransactions';
import {
  SOLANA_SLOT_CHAIN_ID,
  SPL_SPENDING_LIMITS_NOTE,
  SplBroadcastOutcomeUnknownError,
  quoteSplSend,
  readSplMaxRow,
  runSplSend,
  secondReadUrl,
  solanaClient,
  solanaNetworkLabel,
  splConfirmRows,
  splMaxAmountText,
  splMaxUnavailableLine,
  splSendFormIntro,
  splSendScreenTitle,
  splOutcomeLines,
  splSendGate,
  type SplSendOutcome,
  type SplSendQuote,
} from '../wallet/spl-tokens';

type Props = NativeStackScreenProps<RootStackParamList, 'SolanaTokenSend'>;

/**
 * Sends one tracked Solana token (phase 24 item 1, feature 43): a form
 * (recipient, amount), the confirm (every row and note from the engine's
 * quote, quoteSplTokenTransfer through wallet/spl-tokens.ts quoteSplSend;
 * every refusal shown in the engine's own words before any device check),
 * then ONE device check titled like the SOL send and ONE signWith with the
 * active account's Solana key (wallet/spl-tokens.ts runSplSend). The
 * transaction goes to the endpoint the quote was read from; the result is
 * read again on a second endpoint when the network has one. Refused where
 * the readiness row 'spl-tokens' refuses it (everywhere but Solana devnet).
 */
export function SolanaTokenSendScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const fieldLabel = useFieldLabels();
  const { accounts, signWith } = useWallet();
  const owner = accounts.find((a) => a.chainId === SOLANA_CHAIN_ID)?.address ?? null;
  const [endpoint, setEndpoint] = useState<NetworkEndpoint | null | undefined>(undefined);
  const [token, setToken] = useState<FungibleAsset | null | undefined>(undefined);
  const [recipient, setRecipient] = useState('');
  const [amountText, setAmountText] = useState('');
  const [phase, setPhase] = useState<'form' | 'quoting' | 'confirm' | 'sending' | 'success'>('form');
  const [quote, setQuote] = useState<SplSendQuote | null>(null);
  const [error, setError] = useState<{ message: string; technical: string | null } | null>(null);
  const [outcome, setOutcome] = useState<SplSendOutcome | null>(null);
  // The network the transaction was sent on, captured when it was sent, so
  // the private note is filed under that network even if the Solana slot is
  // switched afterwards (the Bridge and Staking success views do the same).
  const [sentNetwork, setSentNetwork] = useState<string | null>(null);
  // Max: reading the balance, and the sentence when it could not be used.
  const [maxBusy, setMaxBusy] = useState(false);
  const [maxNote, setMaxNote] = useState<string | null>(null);
  // A send whose broadcast got no usable answer (phase 25 item 0b): its
  // signature, so the form shows that transfer's pending card.
  const [unknownSignature, setUnknownSignature] = useState<string | null>(null);

  // The endpoint serving the Solana slot now, and the token from ITS list.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ep = (await getEndpoint(SOLANA_SLOT_CHAIN_ID)) ?? null;
      const list = ep ? await listSolanaTokens(ep.network.chainId) : [];
      if (cancelled) return;
      setEndpoint(ep);
      setToken(list.find((t) => formatAssetId(t.assetId) === route.params.assetId) ?? null);
    })().catch(() => {
      if (!cancelled) {
        setEndpoint(null);
        setToken(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [route.params.assetId]);

  useEffect(() => {
    navigation.setOptions({ title: token ? splSendScreenTitle(token.symbol, token.assetId.chainId) : 'Send token' });
  }, [navigation, token]);

  if (endpoint === undefined || token === undefined) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator color={theme.textMuted} />
      </View>
    );
  }
  const network = endpoint?.network.chainId ?? null;
  const refusal = network ? splSendGate(network) : null;
  if (endpoint === null || endpoint.url === null || token === null || owner === null || refusal !== null || token.assetId.chainId !== network) {
    const message =
      endpoint === null || endpoint.url === null
        ? 'No Solana endpoint is configured. Set one in Settings first.'
        : owner === null
          ? 'The active account has no Solana address in this wallet.'
          : refusal !== null
            ? refusal
            : token === null
              ? 'This token is not on the tracked list of the Solana network in use now. Track it on the Solana tokens screen first.'
              : `This token belongs to ${solanaNetworkLabel(token.assetId.chainId)}, but the Solana row is on ${solanaNetworkLabel(network ?? '')} now. Switch in Settings → Developer first.`;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <SolanaDevnetBanner chainId={SOLANA_CHAIN_ID} />
        <WarningBox>{message}</WarningBox>
        <Button title="Back" variant="secondary" onPress={() => navigation.goBack()} />
      </ScrollView>
    );
  }
  const url = endpoint.url;
  const label = solanaNetworkLabel(endpoint.network.chainId);

  // Max fills in the whole associated-account balance, read fresh from the
  // same row Home shows (wallet/spl-tokens.ts splMaxAmountText): the fee and
  // any rent are paid in SOL, so nothing is held back from the token amount.
  const fillMax = async () => {
    setMaxNote(null);
    setMaxBusy(true);
    try {
      const row = await readSplMaxRow(solanaClient(url), owner, token, endpoint.network.chainId);
      const text = splMaxAmountText(row);
      if (text === null) setMaxNote(splMaxUnavailableLine(row));
      else setAmountText(text);
    } finally {
      setMaxBusy(false);
    }
  };

  const review = async () => {
    setError(null);
    setPhase('quoting');
    try {
      const q = await quoteSplSend(solanaClient(url), {
        caip2: endpoint.network.chainId,
        url,
        owner,
        recipient,
        token,
        amountText,
      });
      setQuote(q);
      setPhase('confirm');
    } catch (e) {
      setPhase('form');
      if (e instanceof NoEndpointError) setError({ message: e.message, technical: null });
      else if (e instanceof Error && (e.name === 'SplTokenRefusal' || e.name === 'SplSendNotAllowedError')) {
        // The engine's refusals, the readiness refusal and the amount
        // parser's sentences are shown exactly as written.
        setError({ message: e.message, technical: null });
      } else {
        const d = describeNetworkError(e, 'the transfer details');
        setError({ message: `${d.title}\n${d.detail}`, technical: d.technical });
      }
    }
  };

  const send = async () => {
    if (!quote) return;
    setError(null);
    setPhase('sending');
    const secondUrl = secondReadUrl(quote.url, endpoint.network.defaultUrls);
    try {
      const result = await runSplSend(
        {
          requireAuth: (title) => requireLocalAuth(title),
          signWith,
          client: solanaClient(quote.url),
          second: secondUrl ? { url: secondUrl, client: solanaClient(secondUrl) } : null,
          notifyAccepted: notifySendAccepted,
          pending: pendingSolanaBroadcastRecorder(),
        },
        quote,
      );
      setOutcome(result);
      setSentNetwork(quote.caip2);
      setPhase('success');
    } catch (e) {
      if (e instanceof SplBroadcastOutcomeUnknownError) {
        // The transaction may have gone through: back to the form with the
        // quote dropped (runSplSend never hands the same quote over again,
        // and refuses a send exactly like one still listed as pending).
        setQuote(null);
        setUnknownSignature(e.signature);
        setPhase('form');
        setError({ message: e.message, technical: e.technical });
        return;
      }
      setPhase('confirm');
      const refusedBeforeSigning = e instanceof Error && (e.name === 'SplSendStillPendingError' || e.name === 'SplSendAlreadyHandedOverError');
      setError({
        message: e instanceof Error ? (refusedBeforeSigning ? e.message : `Not sent. ${e.message}`) : 'Not sent.',
        technical: null,
      });
    }
  };

  if (phase === 'success' && outcome && quote) {
    return (
      <ScrollView key="spl-send-success" style={screenStyle(theme)} contentContainerStyle={styles.content} {...NOTE_VIEW_SCROLL_PROPS}>
        <SolanaDevnetBanner chainId={SOLANA_CHAIN_ID} />
        <Text accessibilityRole="header" style={[styles.title, { color: theme.success }]}>Sent ✓</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>Transaction signature</Text>
        <Text selectable style={[styles.mono, { color: theme.text }]}>{outcome.signature}</Text>
        {splOutcomeLines(outcome, endpointHost).map((line) => (
          <Text key={line} style={[styles.hint, { color: theme.text }]}>{line}</Text>
        ))}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {quote.caip2 === SOLANA_CHAIN_ID
            ? 'Look the signature up in a Solana block explorer.'
            : 'No devnet block explorer link has been verified for this wallet; the signature above identifies the transaction.'}
        </Text>
        <SolanaPendingTransactionsSection owner={quote.owner} onlySignature={outcome.signature} />
        {sentNetwork ? <TransactionNoteField network={sentNetwork} txid={outcome.signature} userOpHash={null} /> : null}
        <Button title="Done" onPress={() => dismissKeyboardThenClose(() => navigation.goBack())} />
      </ScrollView>
    );
  }

  if ((phase === 'confirm' || phase === 'sending') && quote) {
    return (
      <ScrollView key="spl-send-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <SolanaDevnetBanner chainId={SOLANA_CHAIN_ID} />
        <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
          Send {quote.symbol} on {label}
        </Text>
        {splConfirmRows(quote, endpoint.network.symbol).map((row) => (
          <View key={row.label} style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{row.label}</Text>
            <Text selectable style={[styles.rowValue, { color: theme.text }]}>{row.value}</Text>
          </View>
        ))}
        {quote.quote.notes.map((note) => (
          <Text key={note} style={[styles.hint, { color: theme.text }]}>{note}</Text>
        ))}
        <Text style={[styles.hint, { color: theme.textMuted }]}>{SPL_SPENDING_LIMITS_NOTE}</Text>
        {error ? (
          <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.danger }]}>{error.message}</Text>
        ) : null}
        {phase === 'sending' ? (
          <ActivityIndicator color={theme.textMuted} />
        ) : (
          <>
            <Button title={`Send ${quote.symbol}`} onPress={() => void send()} />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => {
                setQuote(null);
                setError(null);
                setPhase('form');
              }}
            />
          </>
        )}
      </ScrollView>
    );
  }

  return (
    <ScrollView key="spl-send-form" style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <SolanaDevnetBanner chainId={SOLANA_CHAIN_ID} />
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        {splSendFormIntro(token.symbol, token.assetId.reference, label, endpoint.network.symbol)}
      </Text>
      <Text {...fieldLabel('spl-recipient', 'Recipient (Solana address)').label} style={[styles.hint, { color: theme.textMuted }]}>
        {fieldLabel('spl-recipient', 'Recipient (Solana address)').text}
      </Text>
      <TextInput
        {...fieldLabel('spl-recipient', 'Recipient (Solana address)').input}
        value={recipient}
        onChangeText={setRecipient}
        placeholder="Base58 text"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.card }]}
      />
      <Text {...fieldLabel('spl-amount', `Amount (${token.symbol})`).label} style={[styles.hint, { color: theme.textMuted }]}>
        {fieldLabel('spl-amount', `Amount (${token.symbol})`).text}
      </Text>
      <TextInput
        {...fieldLabel('spl-amount', `Amount (${token.symbol})`).input}
        value={amountText}
        onChangeText={setAmountText}
        placeholder="0.0"
        placeholderTextColor={theme.textMuted}
        keyboardType="decimal-pad"
        style={[styles.input, { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.card }]}
      />
      {maxBusy ? (
        <ActivityIndicator color={theme.textMuted} />
      ) : (
        <Button title="Max" variant="secondary" onPress={() => void fillMax()} disabled={phase === 'quoting'} />
      )}
      {maxNote ? (
        <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.textMuted }]}>{maxNote}</Text>
      ) : null}
      {error ? (
        <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.danger }]}>{error.message}</Text>
      ) : null}
      {error ? <TechnicalDetail text={error.technical} /> : null}
      {unknownSignature ? <SolanaPendingTransactionsSection owner={owner} onlySignature={unknownSignature} /> : null}
      {phase === 'quoting' ? (
        <ActivityIndicator color={theme.textMuted} />
      ) : (
        <Button title="Review" onPress={() => void review()} disabled={recipient.trim() === '' || amountText.trim() === ''} />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  hint: { fontSize: 13, lineHeight: 19 },
  mono: { fontSize: 12, fontVariant: ['tabular-nums'] },
  row: { gap: 2 },
  rowLabel: { fontSize: 12 },
  rowValue: { fontSize: 14 },
  input: { borderRadius: 10, borderWidth: 1, paddingVertical: 10, paddingHorizontal: 12, fontSize: 14 },
});

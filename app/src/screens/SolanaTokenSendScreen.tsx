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
import { SOLANA_CHAIN_ID } from '../wallet/send';
import { SolanaDevnetBanner } from '../components/SolanaDevnetBanner';
import { listSolanaTokens } from '../wallet/tokens';
import {
  SOLANA_SLOT_CHAIN_ID,
  quoteSplSend,
  runSplSend,
  secondReadUrl,
  solanaClient,
  solanaNetworkLabel,
  splConfirmRows,
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
    navigation.setOptions({ title: token ? `Send ${token.symbol}` : 'Send token' });
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
        },
        quote,
      );
      setOutcome(result);
      setPhase('success');
    } catch (e) {
      setPhase('confirm');
      setError({ message: e instanceof Error ? `Not sent. ${e.message}` : 'Not sent.', technical: null });
    }
  };

  if (phase === 'success' && outcome && quote) {
    return (
      <ScrollView key="spl-send-success" style={screenStyle(theme)} contentContainerStyle={styles.content}>
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
        <Button title="Done" onPress={() => navigation.goBack()} />
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
        Sends {token.symbol} (mint {token.assetId.reference}) on {label} from your associated token account. The network
        fee is paid in SOL; if the recipient does not hold this token yet, this transaction also creates their token
        account and you pay its rent. Review shows every figure before anything is signed.
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
      {error ? (
        <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.danger }]}>{error.message}</Text>
      ) : null}
      {error ? <TechnicalDetail text={error.technical} /> : null}
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

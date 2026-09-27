import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { getEndpoint, type NetworkEndpoint } from '../config/networks';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits, parseUnits } from '../wallet/balances';
import {
  BITCOIN_CHAIN_ID,
  describeSendError,
  maxEvmSend,
  maxSolSend,
  maxUtxoSend,
  prepareEvmSend,
  prepareSolSend,
  prepareUtxoSend,
  sendEvm,
  sendSol,
  sendUtxo,
  validateRecipient,
  type SendQuote,
  type SendResult,
} from '../wallet/send';
import { BITCOIN, DOGECOIN } from '@shiba-wallet/chains-utxo';

type Props = NativeStackScreenProps<RootStackParamList, 'Send'>;

type Phase = 'form' | 'quoting' | 'confirm' | 'sending' | 'success';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Full-precision base-unit display (never truncates a payment amount). */
function exact(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals, decimals);
}

/**
 * Send flow for one chain: form (recipient + amount + fee preview via
 * Review), confirm (recipient / amount / fee / total, mainnet warning,
 * EVM pre-flight simulation, biometric gate), success (txid + explorer
 * link). All amounts are bigints in base units; the two text inputs are
 * converted exactly through parseUnits and never touch floating point.
 */
export function SendScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { accounts, signWith } = useWallet();
  const account = accounts.find((a) => a.chainId === route.params.chainId);

  const [endpoint, setEndpoint] = useState<NetworkEndpoint | null | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>('form');
  const [recipient, setRecipient] = useState('');
  const [amountText, setAmountText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [maxBusy, setMaxBusy] = useState(false);
  const [quote, setQuote] = useState<SendQuote | null>(null);
  const [overrideSimulation, setOverrideSimulation] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: account ? `Send ${account.symbol}` : 'Send' });
  }, [navigation, account]);

  useEffect(() => {
    let cancelled = false;
    getEndpoint(route.params.chainId).then(
      (e) => {
        if (!cancelled) setEndpoint(e ?? null);
      },
      () => {
        if (!cancelled) setEndpoint(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [route.params.chainId]);

  const validation = useMemo(
    () => (recipient.trim() ? validateRecipient(route.params.chainId, recipient) : null),
    [route.params.chainId, recipient],
  );

  if (!account) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted }}>Unknown chain.</Text>
      </View>
    );
  }
  if (endpoint === undefined) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  const network = endpoint?.network;
  const url = endpoint?.url ?? null;
  const decimals = network?.decimals ?? 8;
  const symbol = account.symbol;
  const isUtxo = network?.kind === 'esplora';
  const utxoNetwork = route.params.chainId === BITCOIN_CHAIN_ID ? BITCOIN : DOGECOIN;

  const parseAmount = (): bigint => {
    const amount = parseUnits(amountText, decimals);
    if (amount <= 0n) throw new Error('Amount must be greater than zero');
    return amount;
  };

  const onMax = async () => {
    if (!url) return;
    setMaxBusy(true);
    setFormError(null);
    try {
      let max: bigint;
      if (network!.kind === 'evm-jsonrpc') {
        max = await maxEvmSend(
          url,
          account.address,
          validation?.ok ? validation.normalized : undefined,
        );
      } else if (network!.kind === 'solana-jsonrpc') {
        max = await maxSolSend(url, account.address);
      } else {
        // UTXO max depends on the recipient's output size, so it needs a
        // valid recipient first.
        if (!validation?.ok) {
          throw new Error('Enter a valid recipient first — the max depends on it.');
        }
        const swept = await maxUtxoSend(url, utxoNetwork, account.address, validation.normalized);
        max = swept.amount;
      }
      if (max <= 0n) throw new Error('Balance is too small to cover the network fee.');
      setAmountText(exact(max, decimals));
    } catch (e) {
      const { title, detail } = describeSendError(e, symbol);
      setFormError(`${title}\n${detail}`);
    } finally {
      setMaxBusy(false);
    }
  };

  const onReview = async () => {
    if (!url || !network) return;
    setFormError(null);
    if (!validation?.ok) {
      setFormError(validation ? validation.error : 'Enter a recipient address.');
      return;
    }
    let amount: bigint;
    try {
      amount = parseAmount();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Invalid amount.');
      return;
    }
    setPhase('quoting');
    try {
      let next: SendQuote;
      if (network.kind === 'evm-jsonrpc') {
        next = await prepareEvmSend(url, account.address, validation.normalized, amount);
      } else if (network.kind === 'solana-jsonrpc') {
        next = await prepareSolSend(url, account.address, validation.normalized, amount);
      } else {
        next = await prepareUtxoSend(url, utxoNetwork, account.address, validation.normalized, amount);
      }
      setQuote(next);
      setOverrideSimulation(false);
      setPhase('confirm');
    } catch (e) {
      const { title, detail } = describeSendError(e, symbol);
      setFormError(`${title}\n${detail}`);
      setPhase('form');
    }
  };

  const onSend = async () => {
    if (!url || !quote) return;
    // Biometric gate (task 7): the final send confirmation requires local
    // authentication whenever the device has enrolled biometrics.
    const auth = await requireLocalAuth(`Approve sending ${amountText} ${symbol}`);
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const sent = await signWith(route.params.chainId, async (signer) => {
        if (quote.kind === 'evm') return sendEvm(url, signer, quote);
        if (quote.kind === 'sol') return sendSol(url, signer, quote);
        return sendUtxo(url, route.params.chainId, signer, quote);
      });
      setResult(sent);
      setPhase('success');
    } catch (e) {
      const { title, detail } = describeSendError(e, symbol);
      Alert.alert(title, detail);
      setPhase('confirm');
    }
  };

  const inputStyle = [
    styles.input,
    { color: theme.text, borderColor: theme.border, backgroundColor: theme.card },
  ];

  // -------------------------------------------------------------- success
  if (phase === 'success' && result) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.successTitle, { color: theme.success }]}>Sent ✓</Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>Transaction id</Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {result.txid}
          </Text>
        </View>
        {result.explorerUrl ? (
          <Button
            title="View on block explorer"
            variant="secondary"
            onPress={() => void Linking.openURL(result.explorerUrl!)}
          />
        ) : (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            No verified block explorer is configured for this chain; look the
            transaction id up in an explorer you trust.
          </Text>
        )}
        <Button title="Done" onPress={() => navigation.popToTop()} />
      </ScrollView>
    );
  }

  // -------------------------------------------------------------- confirm
  if ((phase === 'confirm' || phase === 'sending') && quote && network) {
    const simulationFailed = quote.kind === 'evm' && !quote.simulation.ok;
    const sendBlocked = simulationFailed && !overrideSimulation;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <View
          style={[
            styles.mainnetBadge,
            { backgroundColor: theme.dangerSurface, borderColor: theme.danger },
          ]}
        >
          <Text style={[styles.mainnetBadgeText, { color: theme.danger }]}>
            {network.label} Mainnet — real funds
          </Text>
        </View>

        <Row label="To" value={quote.to} mono theme={theme} />
        <Row label="Amount" value={`${exact(quote.amount, decimals)} ${symbol}`} theme={theme} />
        <Row
          label={quote.kind === 'evm' ? 'Max network fee' : 'Network fee'}
          value={`${exact(quote.fee, decimals)} ${symbol}`}
          theme={theme}
        />
        {quote.kind === 'utxo' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {quote.feeRate} sat/vB (target: {quote.feeTarget} block
            {quote.feeTarget === 1 ? '' : 's'})
          </Text>
        ) : null}
        {quote.kind === 'sol' && quote.feeIsFallback ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Estimated at the default 5000 lamports per signature — the RPC
            fee query returned no value.
          </Text>
        ) : null}
        {quote.kind === 'evm' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Worst case at {exact(quote.maxFeePerGas, 9)} gwei max fee ×{' '}
            {quote.gasLimit.toString()} gas; the actual fee is usually lower,
            and the unused part is not charged.
          </Text>
        ) : null}
        <Row
          label={quote.kind === 'evm' ? 'Total (worst case)' : 'Total'}
          value={`${exact(quote.total, decimals)} ${symbol}`}
          theme={theme}
        />
        <Row label="Balance" value={`${exact(quote.balance, decimals)} ${symbol}`} theme={theme} />

        {quote.kind === 'evm' ? (
          quote.simulation.ok ? (
            <Text style={[styles.simulationOk, { color: theme.success }]}>
              Pre-flight simulation passed (eth_call).
            </Text>
          ) : (
            <View style={styles.simulationBlock}>
              <WarningBox>
                Pre-flight simulation failed: {quote.simulation.reason}. This
                transaction would very likely fail on-chain and still cost
                the fee.
              </WarningBox>
              <View style={styles.overrideRow}>
                <Switch value={overrideSimulation} onValueChange={setOverrideSimulation} />
                <Text style={[styles.overrideLabel, { color: theme.text }]}>
                  Send anyway (I understand it will probably fail)
                </Text>
              </View>
            </View>
          )
        ) : null}

        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Signing and broadcasting…</Text>
          </View>
        ) : (
          <>
            <Button
              title={`Send ${symbol}`}
              onPress={() => void onSend()}
              disabled={sendBlocked}
            />
            <Button title="Back" variant="secondary" onPress={() => setPhase('form')} />
          </>
        )}
      </ScrollView>
    );
  }

  // ----------------------------------------------------------------- form
  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.networkLine, { color: theme.textMuted }]}>
        {network ? `${network.label} · Mainnet` : 'Unknown network'} · from{' '}
        {account.address.slice(0, 10)}…
      </Text>

      {!url ? (
        <WarningBox>
          Sending unavailable — no configured endpoint.
          {network?.note ? ` ${network.note}` : ''}
        </WarningBox>
      ) : null}

      <Text style={[styles.label, { color: theme.textMuted }]}>Recipient</Text>
      <TextInput
        value={recipient}
        onChangeText={(t) => {
          setRecipient(t);
          setFormError(null);
        }}
        placeholder={`${symbol} address`}
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={inputStyle}
      />
      {validation && !validation.ok ? (
        <Text style={[styles.fieldError, { color: theme.danger }]}>{validation.error}</Text>
      ) : null}
      {validation?.ok && validation.note ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {validation.note} Will send to {validation.normalized}
        </Text>
      ) : null}

      <Text style={[styles.label, { color: theme.textMuted }]}>Amount ({symbol})</Text>
      <View style={styles.amountRow}>
        <TextInput
          value={amountText}
          onChangeText={(t) => {
            setAmountText(t);
            setFormError(null);
          }}
          placeholder="0.0"
          placeholderTextColor={theme.textMuted}
          keyboardType="decimal-pad"
          style={[...inputStyle, styles.amountInput]}
        />
        <Button
          title={maxBusy ? '…' : 'Max'}
          variant="secondary"
          onPress={() => void onMax()}
          disabled={!url || maxBusy}
          style={styles.maxButton}
        />
      </View>

      {formError ? (
        <Text style={[styles.fieldError, { color: theme.danger }]}>{formError}</Text>
      ) : null}

      {phase === 'quoting' ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}>Fetching fee quote…</Text>
        </View>
      ) : (
        <Button title="Review" onPress={() => void onReview()} disabled={!url} />
      )}

      <Text style={[styles.hint, { color: theme.textMuted }]}>
        You will see the network fee and total on the next screen before
        anything is signed or sent.
      </Text>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  mono: monoFont,
  theme,
}: {
  label: string;
  value: string;
  mono?: boolean;
  theme: ReturnType<typeof useTheme>;
}) {
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text
        selectable
        style={[
          styles.rowValue,
          { color: theme.text },
          monoFont ? { fontFamily: mono, fontSize: 13 } : null,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
  networkLine: {
    fontSize: 13,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  amountRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  amountInput: {
    flex: 1,
  },
  maxButton: {
    paddingHorizontal: 16,
  },
  fieldError: {
    fontSize: 13,
    lineHeight: 18,
  },
  hint: {
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
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 10,
    gap: 4,
  },
  rowLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowValue: {
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  simulationOk: {
    fontSize: 14,
    fontWeight: '600',
  },
  simulationBlock: {
    gap: 10,
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
  successTitle: {
    fontSize: 26,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 8,
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
});

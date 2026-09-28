import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { formatAssetId } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { getEndpoint, type NetworkEndpoint } from '../config/networks';
import { useTheme, type Theme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
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
import {
  createAaClient,
  maxAaSend,
  getAaConfig,
  isAaConfigured,
  prepareAaSend,
  sendAa,
  waitForAaReceipt,
  type AaChainConfig,
  type AaClientBundle,
  type AaSendQuote,
} from '../wallet/aa';
import {
  maxErc20Send,
  prepareErc20Send,
  sendErc20,
  type Erc20SendQuote,
} from '../wallet/send-erc20';
import { listTokens } from '../wallet/tokens';
import { extractScannedAddress } from '../wallet/scan';
import { QrScanner } from '../components/QrScanner';
import { BITCOIN, DOGECOIN } from '@shiba-wallet/chains-utxo';

type Props = NativeStackScreenProps<RootStackParamList, 'Send'>;

type Phase = 'form' | 'quoting' | 'confirm' | 'sending' | 'success';

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Full-precision base-unit display (never truncates a payment amount). */
function exact(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals, decimals);
}

/**
 * The confirm-screen network badge. Mainnet keeps the red "real funds"
 * warning; in Sepolia test mode (EVM only) an orange TESTNET badge
 * replaces it, per phase 4 item 6.
 */
function NetworkBadge({ label, testnet, theme }: { label: string; testnet: boolean; theme: Theme }) {
  if (testnet) {
    return (
      <View style={[styles.mainnetBadge, { backgroundColor: '#e07800', borderColor: '#e07800' }]}>
        <Text style={[styles.mainnetBadgeText, { color: '#ffffff' }]}>
          {label} TESTNET — test funds only
        </Text>
      </View>
    );
  }
  return (
    <View
      style={[
        styles.mainnetBadge,
        { backgroundColor: theme.dangerSurface, borderColor: theme.danger },
      ]}
    >
      <Text style={[styles.mainnetBadgeText, { color: theme.danger }]}>
        {label} Mainnet — real funds
      </Text>
    </View>
  );
}

/**
 * Send flow for one chain: form (recipient + amount + fee preview via
 * Review), confirm (recipient / amount / fee / total, mainnet warning,
 * EVM pre-flight simulation, biometric gate), success (txid + explorer
 * link). All amounts are bigints in base units; the two text inputs are
 * converted exactly through parseUnits and never touch floating point.
 *
 * ERC-20 token mode (route.params.tokenId set, phase 4 item 3): the same
 * form/confirm/success flow sends a tracked token instead of the native
 * coin. Recipient validation is identical to native EVM, the amount is
 * parsed with the token's on-chain decimals, and the fee is quoted — and
 * displayed — in ETH, because gas for a token transfer is paid in ETH.
 * The smart-account toggle is hidden in token mode (see the note in the
 * form); the send always takes the EOA path via send-erc20.ts.
 */
export function SendScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { accounts, signWith } = useWallet();
  // The active EVM chain profile (config/evm-chain.ts): chain-id checks,
  // explorer links, badges and the AA config key all come from it, so
  // Sepolia test mode switches every EVM-touching piece of this screen
  // at once and the two modes never mix.
  const { evmChain } = usePrefs();
  const account = accounts.find((a) => a.chainId === route.params.chainId);
  const tokenId = route.params.tokenId;
  const tokenMode = tokenId !== undefined;

  const [endpoint, setEndpoint] = useState<NetworkEndpoint | null | undefined>(undefined);
  // undefined = still loading the token list; null = tokenId not tracked.
  const [token, setToken] = useState<FungibleAsset | null | undefined>(
    tokenMode ? undefined : null,
  );
  const [phase, setPhase] = useState<Phase>('form');
  const [recipient, setRecipient] = useState('');
  const [amountText, setAmountText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [maxBusy, setMaxBusy] = useState(false);
  const [quote, setQuote] = useState<SendQuote | AaSendQuote | Erc20SendQuote | null>(null);
  const [overrideSimulation, setOverrideSimulation] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);

  // ERC-4337 experimental path (see ../wallet/aa.ts). The toggle only
  // renders when both bundler and factory are configured (= verified at
  // save time) for this chain; it defaults to off, and with it off the EOA
  // path below runs exactly as before.
  const [aaConfig, setAaConfig] = useState<AaChainConfig | null>(null);
  const [aaEnabled, setAaEnabled] = useState(false);
  const aaBundle = useRef<AaClientBundle | null>(null);
  const [aaResult, setAaResult] = useState<{
    userOpHash: string;
    receiptState: 'pending' | 'found' | 'timeout';
    success: boolean | null;
    txHash: string | null;
  } | null>(null);

  useEffect(() => {
    const title = token
      ? `Send ${token.symbol}`
      : account
        ? `Send ${account.symbol}`
        : 'Send';
    navigation.setOptions({ title });
  }, [navigation, account, token]);

  // Token mode: resolve the CAIP-19 id against the tracked-token store. The
  // store is the single source of the token's contract address, symbol and
  // on-chain decimals (all verified when the token was added).
  useEffect(() => {
    if (!tokenId) return;
    let cancelled = false;
    listTokens().then(
      (list) => {
        if (cancelled) return;
        setToken(list.find((t) => formatAssetId(t.assetId) === tokenId) ?? null);
      },
      () => {
        if (!cancelled) setToken(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tokenId]);

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
    // evmChain.caip2 in the deps: flipping Sepolia test mode re-resolves
    // the endpoint (getEndpoint translates the EVM slot to the active
    // network) if this screen is somehow still mounted across the flip.
  }, [route.params.chainId, evmChain.caip2]);

  useEffect(() => {
    let cancelled = false;
    // AA configuration is keyed by the ACTIVE chain's CAIP-2 id (the
    // endpoint's network.chainId — 'eip155:11155111' in Sepolia test
    // mode), so mainnet and Sepolia AA setups are separate by key.
    const aaKey = endpoint?.network.chainId ?? route.params.chainId;
    getAaConfig(aaKey).then(
      (c) => {
        if (!cancelled) setAaConfig(c);
      },
      () => {
        if (!cancelled) setAaConfig(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [route.params.chainId, endpoint]);

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
  if (endpoint === undefined || (tokenMode && token === undefined)) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }
  if (tokenMode && token === null) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted }}>
          This token is no longer in your tracked list.
        </Text>
      </View>
    );
  }
  if (tokenMode && evmChain.testnet) {
    // Defensive: every token entry point is hidden in Sepolia test mode
    // (tracked tokens are mainnet assets), and prepareErc20Send would
    // refuse the Sepolia endpoint anyway. State this plainly instead of
    // quoting a mainnet token against a testnet chain.
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted, textAlign: 'center', padding: 24 }}>
          Token sending is an Ethereum mainnet feature. Turn off Sepolia
          test mode in Settings → Developer to send tokens.
        </Text>
      </View>
    );
  }

  const network = endpoint?.network;
  const url = endpoint?.url ?? null;
  const isEvmKind = network?.kind === 'evm-jsonrpc';
  // Orange TESTNET presentation whenever the active EVM chain is a
  // testnet and this screen is on the EVM slot.
  const testnet = isEvmKind && evmChain.testnet;
  // Token mode: amounts are in the token's on-chain decimals and carry the
  // token's symbol; the fee stays in the native coin (see nativeDecimals).
  const decimals = token ? token.decimals : network?.decimals ?? 8;
  // EVM native amounts are labeled per the active profile ("test ETH" on
  // Sepolia) so a test send can never read like a real one.
  const symbol = token ? token.symbol : isEvmKind ? evmChain.displaySymbol : account.symbol;
  // For displaying the ETH fee of a token send (EVM native decimals).
  const nativeDecimals = network?.decimals ?? 18;
  const isUtxo = network?.kind === 'esplora' || network?.kind === 'blockbook';
  const utxoNetwork = route.params.chainId === BITCOIN_CHAIN_ID ? BITCOIN : DOGECOIN;
  // Backend selection for the UTXO engine calls: Dogecoin's endpoint is a
  // Blockbook instance (config/defaults.ts) whose optional API key rides
  // along as the api-key header resolved by config/networks.ts; Bitcoin
  // keeps the Esplora default.
  const utxoOptions =
    network?.kind === 'blockbook'
      ? { backend: 'blockbook' as const, ...(endpoint?.headers ? { headers: endpoint.headers } : {}) }
      : undefined;
  // The smart-account toggle appears only when both AA endpoints are
  // configured for this EVM chain — configured means verified, because the
  // Settings save path refuses anything that fails verification. Token
  // mode hides it: ERC-20 sends through the smart account (batched
  // approve+transfer) are a later slice, so tokens always take the EOA path.
  const aaAvailable =
    !tokenMode && network?.kind === 'evm-jsonrpc' && aaConfig !== null && isAaConfigured(aaConfig);
  const aaActive = aaAvailable && aaEnabled;

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
      if (aaActive && aaConfig?.bundlerUrl && aaConfig.factory) {
        // AA Max (phase 5): full smart-account balance under sponsorship,
        // else balance minus the worst-case fee of a zero-value probe.
        if (!validation?.ok) {
          throw new Error('Enter a valid recipient first — the max depends on it.');
        }
        const bundle = createAaClient({
          nodeUrl: url,
          bundlerUrl: aaConfig.bundlerUrl,
          factory: aaConfig.factory,
          chainId: BigInt(evmChain.chainIdDecimal),
          ...(aaConfig.paymasterUrl
            ? {
                paymaster: {
                  url: aaConfig.paymasterUrl,
                  contextJson: aaConfig.paymasterContext,
                },
              }
            : {}),
        });
        max = await maxAaSend(bundle, account.address, validation.normalized);
        if (max <= 0n) throw new Error('The smart account balance cannot cover the network fee.');
      } else if (token) {
        // Token max = the full token balance: the fee is paid in ETH, so
        // it never reduces the token amount. maxErc20Send refuses (with a
        // plain "Not enough ETH" error) when the ETH balance cannot cover
        // the worst-case fee for transferring that balance.
        max = await maxErc20Send(
          url,
          account.address,
          token.assetId.reference,
          validation?.ok ? validation.normalized : undefined,
        );
        if (max <= 0n) throw new Error(`Your ${token.symbol} balance is zero.`);
      } else if (network!.kind === 'evm-jsonrpc') {
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
        const swept = await maxUtxoSend(
          url,
          utxoNetwork,
          account.address,
          validation.normalized,
          utxoOptions,
        );
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
      let next: SendQuote | AaSendQuote | Erc20SendQuote;
      if (token) {
        // ERC-20 token mode: EOA path only (the smart-account toggle is
        // hidden in token mode). Quote checks the token balance, checks
        // the ETH balance against the fee, and pre-flights the transfer
        // calldata through eth_call.
        next = await prepareErc20Send({
          url,
          from: account.address,
          to: validation.normalized,
          contract: token.assetId.reference,
          amount,
          symbol: token.symbol,
          decimals: token.decimals,
        });
      } else if (aaActive && aaConfig?.bundlerUrl && aaConfig.factory) {
        // Experimental ERC-4337 path: quote from the smart account through
        // the bundler estimate (see ../wallet/aa.ts). The bundle is kept
        // for the send + receipt poll so all three use the same transports.
        const bundle = createAaClient({
          nodeUrl: url,
          bundlerUrl: aaConfig.bundlerUrl,
          factory: aaConfig.factory,
          // Active chain id (11155111 in Sepolia test mode): prepareAaSend
          // verifies the node endpoint reports exactly this chain.
          chainId: BigInt(evmChain.chainIdDecimal),
          // Verified ERC-7677 paymaster, when configured: gas becomes
          // sponsored and the fee rows below say so.
          ...(aaConfig.paymasterUrl
            ? {
                paymaster: {
                  url: aaConfig.paymasterUrl,
                  contextJson: aaConfig.paymasterContext,
                },
              }
            : {}),
        });
        aaBundle.current = bundle;
        next = await prepareAaSend(bundle, account.address, validation.normalized, amount);
      } else if (network.kind === 'evm-jsonrpc') {
        // The endpoint's eth_chainId must match the ACTIVE EVM chain
        // (mainnet 1 / Sepolia 11155111) — the modes can never mix.
        next = await prepareEvmSend(
          url,
          account.address,
          validation.normalized,
          amount,
          undefined,
          evmChain.caip2,
        );
      } else if (network.kind === 'solana-jsonrpc') {
        next = await prepareSolSend(url, account.address, validation.normalized, amount);
      } else {
        next = await prepareUtxoSend(
          url,
          utxoNetwork,
          account.address,
          validation.normalized,
          amount,
          utxoOptions,
        );
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
      if (quote.kind === 'aa') {
        const bundle = aaBundle.current;
        if (!bundle) {
          throw new Error('Smart-account session expired; go back and review again.');
        }
        const { userOpHash } = await signWith(route.params.chainId, (signer) =>
          sendAa(bundle, signer, quote),
        );
        setAaResult({ userOpHash, receiptState: 'pending', success: null, txHash: null });
        setPhase('success');
        // Poll for the receipt in the background; the success screen shows
        // "bundling…" until it lands (or the poll times out — the op may
        // still be included later, the userOpHash stays the lookup key).
        void waitForAaReceipt(bundle, userOpHash, { timeoutMs: 120_000, pollMs: 3_000 }).then(
          ({ summary }) =>
            setAaResult((prev) =>
              prev && prev.userOpHash === userOpHash
                ? {
                    ...prev,
                    receiptState: 'found',
                    success: summary.success,
                    txHash: summary.txHash,
                  }
                : prev,
            ),
          () =>
            setAaResult((prev) =>
              prev && prev.userOpHash === userOpHash
                ? { ...prev, receiptState: 'timeout' }
                : prev,
            ),
        );
        return;
      }
      const sent = await signWith(route.params.chainId, async (signer) => {
        // Token transfer: value 0, to = token contract, data = transfer
        // calldata — through the same sendEvm signing/broadcast path.
        if (quote.kind === 'erc20') return sendErc20(url, signer, quote);
        if (quote.kind === 'evm') return sendEvm(url, signer, quote, evmChain.explorerTxBase);
        if (quote.kind === 'sol') return sendSol(url, signer, quote);
        return sendUtxo(url, route.params.chainId, signer, quote, utxoOptions);
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

  // ------------------------------------------------ success (smart account)
  if (phase === 'success' && aaResult) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.successTitle, { color: theme.success }]}>Sent to bundler ✓</Text>
        <Text style={[styles.label, { color: theme.textMuted }]}>UserOperation hash</Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {aaResult.userOpHash}
          </Text>
        </View>
        {aaResult.receiptState === 'pending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Bundling… waiting for the UserOperation receipt.
            </Text>
          </View>
        ) : null}
        {aaResult.receiptState === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            No receipt yet. The operation may still be included — keep the
            UserOperation hash above to look it up later.
          </Text>
        ) : null}
        {aaResult.receiptState === 'found' ? (
          <>
            {aaResult.success === false ? (
              <WarningBox>
                The bundler reports the operation was included but reverted
                on-chain. The gas was still charged to the smart account.
              </WarningBox>
            ) : (
              <Text style={[styles.simulationOk, { color: theme.success }]}>
                Included on-chain{aaResult.success === true ? ' — succeeded.' : '.'}
              </Text>
            )}
            {aaResult.txHash ? (
              <>
                <Text style={[styles.label, { color: theme.textMuted }]}>Transaction</Text>
                <View
                  style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}
                >
                  <Text selectable style={[styles.monoText, { color: theme.text }]}>
                    {aaResult.txHash}
                  </Text>
                </View>
                <Button
                  title="View on block explorer"
                  variant="secondary"
                  onPress={() =>
                    void Linking.openURL(`${evmChain.explorerTxBase}${aaResult.txHash}`)
                  }
                />
              </>
            ) : (
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                The bundler's receipt did not include a recognizable
                transaction hash; look the UserOperation hash up in an
                ERC-4337 explorer you trust.
              </Text>
            )}
          </>
        ) : null}
        <Button title="Done" onPress={() => navigation.popToTop()} />
      </ScrollView>
    );
  }

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

  // ------------------------------------------------ confirm (smart account)
  if ((phase === 'confirm' || phase === 'sending') && quote?.kind === 'aa' && network) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={network.label} testnet={testnet} theme={theme} />

        <View style={[styles.aaTag, { borderColor: theme.accent }]}>
          <Text style={[styles.aaTagText, { color: theme.accent }]}>
            EXPERIMENTAL · ERC-4337 smart account
          </Text>
        </View>

        <Row label="To" value={quote.to} mono theme={theme} />
        <Row label="Amount" value={`${exact(quote.amount, decimals)} ${symbol}`} theme={theme} />
        <Row label="From smart account" value={quote.sender} mono theme={theme} />
        <Row
          label="Smart account balance"
          value={`${exact(quote.senderBalance, decimals)} ${symbol}`}
          theme={theme}
        />
        <Row
          label="Deployment"
          value={quote.deployed ? 'Already deployed' : 'Will deploy with this send'}
          theme={theme}
        />
        <Row
          label={quote.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={quote.sponsored ? 'Sponsored — you pay 0' : `${exact(quote.fee, decimals)} ${symbol}`}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {quote.sponsored
            ? 'An ERC-7677 paymaster sponsors this operation\u2019s gas: the ' +
              'smart account pays only the amount. The paymaster may still ' +
              'decline at send time; that shows up as a bundler error, not a charge.'
            : `Worst case at ${exact(quote.maxFeePerGas, 9)} gwei max fee \u00d7 ` +
              `${(quote.callGasLimit + quote.verificationGasLimit + quote.preVerificationGas).toString()} ` +
              'gas (bundler eth_estimateUserOperationGas). The smart account pays ' +
              'its own gas from its own balance.'}
        </Text>
        <Row
          label="Total (worst case)"
          value={`${exact(quote.total, decimals)} ${symbol}`}
          theme={theme}
        />

        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Signing and submitting to the bundler…
            </Text>
          </View>
        ) : (
          <>
            <Button title={`Send ${symbol} from smart account`} onPress={() => void onSend()} />
            <Button title="Back" variant="secondary" onPress={() => setPhase('form')} />
          </>
        )}
      </ScrollView>
    );
  }

  // ------------------------------------------------- confirm (ERC-20 token)
  if ((phase === 'confirm' || phase === 'sending') && quote?.kind === 'erc20' && network) {
    const simulationFailed = !quote.simulation.ok;
    // A zero-word return blocks exactly like a revert: the transaction
    // would be mined, charge the full fee, and move no tokens.
    const blocked = (simulationFailed || quote.returnedFalse) && !overrideSimulation;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={network.label} testnet={testnet} theme={theme} />

        <Row label="To" value={quote.to} mono theme={theme} />
        <Row
          label="Amount"
          value={`${exact(quote.amount, quote.decimals)} ${quote.symbol}`}
          theme={theme}
        />
        <Row label="Token contract" value={quote.contract} mono theme={theme} />
        <Row
          label="Max network fee (paid in ETH)"
          value={`${exact(quote.fee, nativeDecimals)} ETH`}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Worst case at {exact(quote.maxFeePerGas, 9)} gwei max fee ×{' '}
          {quote.gasLimit.toString()} gas; the actual fee is usually lower,
          and the unused part is not charged. The fee comes out of your ETH
          balance — the full token amount reaches the recipient.
          {quote.gasIsFallback
            ? ' Gas estimation failed, so a conservative default gas limit is shown.'
            : ''}
        </Text>
        <Row
          label={`${quote.symbol} balance`}
          value={`${exact(quote.tokenBalance, quote.decimals)} ${quote.symbol}`}
          theme={theme}
        />
        <Row
          label="ETH balance"
          value={`${exact(quote.ethBalance, nativeDecimals)} ETH`}
          theme={theme}
        />

        {!simulationFailed && !quote.returnedFalse ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}>
            Pre-flight simulation passed (eth_call).
          </Text>
        ) : (
          <View style={styles.simulationBlock}>
            <WarningBox>
              {simulationFailed
                ? `Pre-flight simulation failed: ${
                    quote.simulation.ok ? '' : quote.simulation.reason
                  }. This transaction would very likely fail on-chain and still cost the fee.`
                : 'The token contract reports the transfer would not go through: ' +
                  'it returned false instead of reverting (some tokens do this ' +
                  'when paused, blocklisted, or short of balance). Sending anyway ' +
                  'would cost the full fee and move no tokens.'}
            </WarningBox>
            <View style={styles.overrideRow}>
              <Switch value={overrideSimulation} onValueChange={setOverrideSimulation} />
              <Text style={[styles.overrideLabel, { color: theme.text }]}>
                Send anyway (I understand it will probably fail)
              </Text>
            </View>
          </View>
        )}

        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>Signing and broadcasting…</Text>
          </View>
        ) : (
          <>
            <Button
              title={`Send ${quote.symbol}`}
              onPress={() => void onSend()}
              disabled={blocked}
            />
            <Button title="Back" variant="secondary" onPress={() => setPhase('form')} />
          </>
        )}
      </ScrollView>
    );
  }

  // -------------------------------------------------------------- confirm
  if (
    (phase === 'confirm' || phase === 'sending') &&
    quote &&
    quote.kind !== 'aa' &&
    quote.kind !== 'erc20' &&
    network
  ) {
    const simulationFailed = quote.kind === 'evm' && !quote.simulation.ok;
    const sendBlocked = simulationFailed && !overrideSimulation;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={network.label} testnet={testnet} theme={theme} />

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
      <Text style={[styles.networkLine, { color: testnet ? '#e07800' : theme.textMuted }]}>
        {network ? `${network.label} · ${testnet ? 'TESTNET' : 'Mainnet'}` : 'Unknown network'}{' '}
        · from {account.address.slice(0, 10)}…
      </Text>

      {!url ? (
        <WarningBox>
          Sending unavailable — no configured endpoint.
          {network?.note ? ` ${network.note}` : ''}
        </WarningBox>
      ) : null}

      {token ? (
        <View
          style={[styles.aaToggleBox, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Sending {token.symbol} (ERC-20 token, contract{' '}
            {token.assetId.reference.slice(0, 10)}…{token.assetId.reference.slice(-8)}) from
            your Ethereum address. The network fee is paid in ETH, not in{' '}
            {token.symbol}. Smart-account sends are not available for tokens
            yet — batching approve + transfer through the smart account is a
            later release, so token sends always go from your regular address.
          </Text>
        </View>
      ) : null}

      {aaAvailable ? (
        <View
          style={[styles.aaToggleBox, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <View style={styles.overrideRow}>
            <Switch value={aaEnabled} onValueChange={setAaEnabled} disabled={!url} />
            <Text style={[styles.overrideLabel, { color: theme.text }]}>
              Send from smart account
            </Text>
            <View style={[styles.aaTag, { borderColor: theme.accent }]}>
              <Text style={[styles.aaTagText, { color: theme.accent }]}>EXPERIMENTAL</Text>
            </View>
          </View>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Sends as an ERC-4337 UserOperation from your smart account — a
            separate address controlled by this wallet's key — through the
            bundler configured in Settings. The smart account pays the
            amount and its own gas from its own balance (no paymaster in
            this pass), so fund the smart account address first. The Max
            button applies to the regular send only.
          </Text>
        </View>
      ) : null}

      <Text style={[styles.label, { color: theme.textMuted }]}>Recipient</Text>
      <View style={styles.amountRow}>
        <TextInput
          value={recipient}
          onChangeText={(t) => {
            setRecipient(t);
            setFormError(null);
          }}
          placeholder={token ? 'Ethereum address' : `${account.symbol} address`}
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[...inputStyle, styles.amountInput]}
        />
        <Button
          title="Scan"
          variant="secondary"
          onPress={() => setScannerOpen(true)}
          style={styles.maxButton}
        />
      </View>
      {/*
        Scanned payloads go through extractScannedAddress (strips only the
        ACTIVE chain's own payment-URI scheme, conservatively — see
        ../wallet/scan.ts) and then land in the recipient field, where the
        exact same engine-backed validation as typed/pasted input runs.
        Scanning can never bypass or widen validation.
      */}
      <QrScanner
        visible={scannerOpen}
        rationale={`Point the camera at a ${token ? 'Ethereum' : account.name} address QR code. The camera is only used to read the code.`}
        onScanned={(data) => {
          setScannerOpen(false);
          setRecipient(extractScannedAddress(route.params.chainId, data));
          setFormError(null);
        }}
        onClose={() => setScannerOpen(false)}
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
  aaToggleBox: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  aaTag: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: 'center',
  },
  aaTagText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
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

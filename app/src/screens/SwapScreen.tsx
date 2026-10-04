import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
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
import type { SwapQuote } from '@shiba-wallet/chains-evm';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import {
  callWithFailover,
  getEndpoint,
  reportEndpointFailure,
  withEndpoint,
  type NetworkEndpoint,
  type UsableEndpoint,
} from '../config/networks';
import { OfflineNotice, TechnicalDetail } from '../wallet/connectivity';
import { sanitizeEndpointMessage } from '../config/endpoint-probe';
import { useTheme, type Theme } from '../theme';
import { BalanceChangePreview } from '../components/BalanceChangePreview';
import { RiskWarnings } from '../components/RiskWarnings';
import { SpendingPolicyNotice, spendingGateForQuote } from '../components/SpendingPolicyViews';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { fetchNativeBalance, formatUnits, parseUnits } from '../wallet/balances';
import { fetchErc20Balance } from '../wallet/erc20';
import { listTokens } from '../wallet/tokens';
import {
  EVM_CHAIN_ID,
  QUOTE_ENDPOINT_CHANGED_TITLE,
  describeSendError,
  quoteEndpointChange,
  sendEvm,
  type EvmSendQuote,
  type SendResult,
} from '../wallet/send';
import {
  DEFAULT_SLIPPAGE_BPS,
  NATIVE_TOKEN_ADDRESS,
  SLIPPAGE_CHOICES_BPS,
  assertSellBalance,
  checkAllowance,
  describeSwapFailure,
  estimateSwapFee,
  fetchSwapQuote,
  getSwapConfig,
  impliedRate,
  isQuoteStale,
  prepareAaSwap,
  prepareApproveSend,
  prepareSwapSend,
  validateSlippageBps,
  waitForAllowance,
  type SwapConfig,
  type SwapQuoteView,
} from '../wallet/swap';
import {
  KERNEL_BUNDLER_NOTE,
  PREVIEW_AA_BATCH_NOTE,
  aaAccountTypeLabel,
  aaSenderLabel,
  createAaClientFromConfig,
  describeAaError,
  effectiveAaAccountType,
  getAaConfig,
  isAaConfigured,
  resolveAaSender,
  sendAa,
  waitForAaReceipt,
  type AaChainConfig,
  type AaClientBundle,
  type AaSendQuote,
} from '../wallet/aa';
import { PREVIEW_AA_NOTE } from '../wallet/simulation';
import { Eip7702QuoteNotice } from '../components/DelegationViews';
import { usePrices } from '../wallet/usePrices';
import { fiatLine, formatFiat, nativePriceAssetId, tokenPriceAssetId } from '../wallet/prices';

type Props = NativeStackScreenProps<RootStackParamList, 'Swap'>;

type Phase =
  | 'form'
  | 'quoting'
  | 'review'
  | 'preparing'
  | 'approve'
  | 'approving'
  | 'confirm'
  | 'sending'
  | 'aa-confirm'
  | 'aa-sending'
  | 'success';

/** 'native' is the chain's own coin (ETH); tokens come from the tracked list. */
type SwapAsset = 'native' | FungibleAsset;

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Full-precision base-unit display (never truncates a traded amount). */
function exact(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals, decimals);
}

/** Same confirm-screen badge as the send flow (mainnet warning / TESTNET). */
function NetworkBadge({ label, testnet, theme }: { label: string; testnet: boolean; theme: Theme }) {
  if (testnet) {
    return (
      <View style={[styles.badge, { backgroundColor: theme.testnetFill, borderColor: theme.testnetFill }]}>
        <Text style={[styles.badgeText, { color: theme.onTestnetFill }]}>
          {label} TESTNET — test funds only
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.badge, { backgroundColor: theme.dangerSurface, borderColor: theme.danger }]}>
      <Text style={[styles.badgeText, { color: theme.danger }]}>{label} Mainnet — real funds</Text>
    </View>
  );
}

/**
 * Swap flow (phase 5, item 1 — Tier 1 feature 34) on the engine's
 * SwapQuoteProvider seam: pick a sell and a buy asset (ETH or any tracked
 * ERC-20 on the ACTIVE chain), quote through 0x with the active chain id
 * and the wallet as taker, then execute the quoted {to, data, value}
 * through the EXISTING EVM send machinery (prepareEvmSend simulation gate,
 * biometric, sendEvm broadcast). ERC-20 sells get a two-step UX when the
 * 0x spender's allowance is short: an exact-amount approve first, through
 * the same machinery. Quotes older than ~60 s are refreshed — never acted
 * on — and the refresh is said out loud.
 *
 * SMART-ACCOUNT MODE (phase 7 item 2): with a verified AA configuration for
 * the active chain, a "Swap from smart account" toggle quotes with the
 * SMART ACCOUNT as the 0x taker and executes ONE UserOperation: for ERC-20
 * sells the atomic batch [approve(exact sell amount), swap], for native
 * sells [swap] (swap.ts aaSwapCalls). Balances are the smart account's;
 * the fee is the bundler's estimate, which is also the pre-flight gate.
 *
 * The whole feature is off with a plain explanation until a 0x API key is
 * verified and saved in Settings → Swaps.
 */
export function SwapScreen({ navigation }: Props) {
  const theme = useTheme();
  const { accounts, signWith, activeAccount } = useWallet();
  const { evmChain, hideAmounts } = usePrefs();
  const account = accounts.find((a) => a.chainId === EVM_CHAIN_ID);

  const [endpoint, setEndpoint] = useState<NetworkEndpoint | null | undefined>(undefined);
  const [config, setConfig] = useState<SwapConfig | null | undefined>(undefined);
  const [tokens, setTokens] = useState<FungibleAsset[]>([]);

  const [phase, setPhase] = useState<Phase>('form');
  const [sellAsset, setSellAsset] = useState<SwapAsset>('native');
  const [buyAsset, setBuyAsset] = useState<SwapAsset | null>(null);
  const [amountText, setAmountText] = useState('');
  const [slippageMode, setSlippageMode] = useState<'preset' | 'custom'>('preset');
  const [presetBps, setPresetBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [customBpsText, setCustomBpsText] = useState('');
  const [sellBalance, setSellBalance] = useState<bigint | null>(null);
  // The sell-side balance read failed (shown as a sentence with Retry);
  // bumping sellBalanceTry re-runs the read.
  const [sellBalanceFailed, setSellBalanceFailed] = useState(false);
  // Sanitised text of the failed balance read, shown as a technical-detail
  // line under the plain sentence (same rule as the Activity screen).
  const [sellBalanceDetail, setSellBalanceDetail] = useState<string | null>(null);
  const [sellBalanceTry, setSellBalanceTry] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [quoteView, setQuoteView] = useState<SwapQuoteView | null>(null);
  const [feeInfo, setFeeInfo] = useState<{
    zeroExGas: bigint | null;
    worstCaseFee: bigint | null;
  } | null>(null);
  const [approveQuote, setApproveQuote] = useState<EvmSendQuote | null>(null);
  const [approveTxid, setApproveTxid] = useState<string | null>(null);
  const [sendQuote, setSendQuote] = useState<EvmSendQuote | null>(null);
  // The endpoint URL the current approve or swap quote was prepared
  // through; it is signed and broadcast only through this URL, and only
  // while the wallet would still use it (send.ts quoteEndpointChange).
  const [quotedUrl, setQuotedUrl] = useState<string | null>(null);
  const [overrideSimulation, setOverrideSimulation] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  // The address the approve/swap transactions were prepared for (nonce,
  // balance, simulation). signWith refuses to sign unless the active
  // account's key controls exactly this address. On the smart-account path
  // this is the OWNER EOA (the key that signs the UserOperation).
  const preparedFrom = useRef<string | null>(null);
  // The same address as state, for display on the confirm screens (a ref
  // must not be read while rendering). Both are written together by
  // markPreparedFrom; the signing path keeps reading the ref.
  const [preparedFromShown, setPreparedFromShown] = useState<string | null>(null);
  const markPreparedFrom = (address: string) => {
    preparedFrom.current = address;
    setPreparedFromShown(address);
  };

  // Smart-account mode (see the component comment).
  const [aaConfig, setAaConfig] = useState<AaChainConfig | null>(null);
  const [aaEnabled, setAaEnabled] = useState(false);
  const [aaSender, setAaSender] = useState<string | null>(null);
  const [aaQuote, setAaQuote] = useState<AaSendQuote | null>(null);
  const aaBundle = useRef<AaClientBundle | null>(null);
  // The node URL the smart-account bundle was built with (its quotes come
  // from it, so the send is pinned to it like the EOA path).
  const aaBundleUrl = useRef<string | null>(null);
  const [aaResult, setAaResult] = useState<{
    userOpHash: string;
    receiptState: 'pending' | 'found' | 'timeout';
    success: boolean | null;
    txHash: string | null;
  } | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: 'Swap' });
  }, [navigation]);

  useEffect(() => {
    let cancelled = false;
    getEndpoint(EVM_CHAIN_ID).then(
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
  }, [evmChain.caip2]);

  useEffect(() => {
    let cancelled = false;
    getSwapConfig().then(
      (c) => {
        if (!cancelled) setConfig(c);
      },
      () => {
        if (!cancelled) setConfig(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Tracked tokens on the ACTIVE chain only. The tracked list holds
  // Ethereum-mainnet assets today, so in Sepolia test mode this filter
  // yields none and the screen says why — but nothing here hardcodes
  // mainnet, so tokens for another chain would light up without changes.
  useEffect(() => {
    let cancelled = false;
    listTokens().then(
      (list) => {
        if (cancelled) return;
        const active = list.filter((t) => t.assetId.chainId === evmChain.caip2);
        setTokens(active);
        setBuyAsset((prev) => prev ?? active[0] ?? null);
      },
      () => {
        if (!cancelled) setTokens([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [evmChain.caip2]);

  useEffect(() => {
    let cancelled = false;
    getAaConfig(evmChain.caip2).then(
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
  }, [evmChain.caip2]);

  const url = endpoint?.url ?? null;
  // The EOA confirm screens' preview and risk checks read the URL the shown
  // quote came from; the smart-account confirm keeps `url`, which is the
  // URL its bundle was built from (a change rebuilds the bundle).
  const confirmUrl = quotedUrl ?? url;
  const aaAvailable =
    aaConfig !== null && isAaConfigured(aaConfig, account?.address) && url !== null;
  // 'kernel-7702' for an account upgraded with EIP-7702 (the account at its
  // own address), else the chain's configured type.
  const aaType = aaConfig ? effectiveAaAccountType(aaConfig, account?.address) : null;
  const aaActive = aaAvailable && aaEnabled;

  // Resolve the smart-account address when the toggle goes on: it is the
  // 0x taker and the holder whose balances count on this path. The toggle
  // handler clears the previous address; nothing is set synchronously here.
  useEffect(() => {
    if (!aaActive || !url || !aaConfig || !activeAccount || !account) {
      aaBundle.current = null;
      aaBundleUrl.current = null;
      return;
    }
    let cancelled = false;
    Promise.resolve()
      .then(() => {
        const bundle = createAaClientFromConfig(aaConfig, {
          nodeUrl: url,
          chainId: BigInt(evmChain.chainIdDecimal),
          accountIndex: activeAccount.index,
          ownerAddress: account.address,
        });
        aaBundle.current = bundle;
        aaBundleUrl.current = url;
        return resolveAaSender(bundle, account.address);
      })
      .then(
        (sender) => {
          if (!cancelled) setAaSender(sender);
        },
        (e) => {
          if (!cancelled) {
            setAaSender(null);
            setFormError(
              `Could not resolve the smart-account address: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [aaActive, url, aaConfig, activeAccount, account, evmChain.chainIdDecimal]);

  // The 0x taker and balance holder: the smart account on the AA path.
  const holder = aaActive ? aaSender : (account?.address ?? null);

  const symbolOf = (a: SwapAsset): string => (a === 'native' ? evmChain.displaySymbol : a.symbol);
  const decimalsOf = (a: SwapAsset): number => (a === 'native' ? 18 : a.decimals);
  const addressOf = (a: SwapAsset): string =>
    a === 'native' ? NATIVE_TOKEN_ADDRESS : a.assetId.reference;
  const assetKey = (a: SwapAsset): string => (a === 'native' ? 'native' : formatAssetId(a.assetId));

  // Sell-side balance, refreshed whenever the sell asset (or endpoint)
  // changes; used for the display line and the pre-quote refusal. The shown
  // balance is cleared while rendering as soon as one of its inputs changes
  // (React's "adjust state when a prop changes" pattern), so no frame ever
  // shows the previous asset's balance; the effect below then fetches the
  // new one.
  const [sellBalanceInputs, setSellBalanceInputs] = useState({ url, holder, sellAsset });
  if (
    sellBalanceInputs.url !== url ||
    sellBalanceInputs.holder !== holder ||
    sellBalanceInputs.sellAsset !== sellAsset
  ) {
    setSellBalanceInputs({ url, holder, sellAsset });
    setSellBalance(null);
    setSellBalanceFailed(false);
  }

  useEffect(() => {
    if (!url || !holder) return;
    let cancelled = false;
    void (async () => {
      try {
        // Resolved at call time with the shared failover rule, so a dead
        // default endpoint does not leave the balance line blank.
        const { value: balance } = await withEndpoint(EVM_CHAIN_ID, (ep) =>
          sellAsset === 'native'
            ? fetchNativeBalance('evm-jsonrpc', ep.url, holder)
            : fetchErc20Balance(ep.url, sellAsset.assetId.reference, holder),
        );
        if (!cancelled) setSellBalance(balance);
      } catch (err) {
        if (!cancelled) {
          setSellBalance(null);
          setSellBalanceFailed(true);
          const text = sanitizeEndpointMessage(err instanceof Error ? err.message : String(err));
          setSellBalanceDetail(text === '' ? null : text);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, holder, sellAsset, sellBalanceTry]);

  // Fiat values for the sell and buy amounts (phase 6 item 2). Ids are
  // derived against the ACTIVE chain, so in Sepolia test mode both are null
  // and nothing is priced or shown.
  const priceIdOf = (a: SwapAsset | null): string | null =>
    a === null
      ? null
      : a === 'native'
        ? nativePriceAssetId(EVM_CHAIN_ID, evmChain.caip2)
        : tokenPriceAssetId(a, evmChain.caip2);
  const sellPriceId = priceIdOf(sellAsset);
  const buyPriceId = priceIdOf(buyAsset);
  const { quotes: priceQuotes } = usePrices([sellPriceId, buyPriceId]);
  /** Secondary fiat line for an exact amount, or null (render nothing). */
  const fiatOf = (priceId: string | null, amount: bigint, amountDecimals: number) =>
    priceId
      ? fiatLine(
          formatFiat(priceQuotes.get(priceId), amount, amountDecimals, { hidden: hideAmounts }),
        )
      : null;

  if (!account) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted }}>No Ethereum account.</Text>
      </View>
    );
  }
  if (endpoint === undefined || config === undefined) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  // ------------------------------------------------- feature off (no key)
  if (!config?.apiKey) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Swapping trades one asset for another directly from this wallet,
          priced by the 0x aggregator. It is off because no 0x API key is
          configured. Create a free key at dashboard.0x.org, then save it
          under Settings → Swaps — saving verifies the key with one live
          quote request. The key is stored only on this device and sent
          only to api.0x.org.
        </Text>
        <Button title="Open Settings" onPress={() => navigation.navigate('Settings')} />
      </ScrollView>
    );
  }

  const apiKey = config.apiKey;
  const sellSymbol = symbolOf(sellAsset);
  const sellDecimals = decimalsOf(sellAsset);
  const quote: SwapQuote | null =
    quoteView && quoteView.result.ok ? quoteView.result.quote : null;
  const buySymbol = buyAsset ? symbolOf(buyAsset) : '';
  const buyDecimals = buyAsset ? decimalsOf(buyAsset) : 0;

  const currentSlippageBps = (): number =>
    slippageMode === 'custom' ? validateSlippageBps(customBpsText) : presetBps;

  const requote = async (): Promise<SwapQuoteView | null> => {
    if (!url || !buyAsset) return null;
    if (!holder) {
      throw new Error('The smart-account address is not resolved yet; try again in a moment.');
    }
    const amount = parseUnits(amountText, sellDecimals);
    const view = await fetchSwapQuote({
      apiKey,
      // ACTIVE chain id from the profile — 11155111 in Sepolia test mode.
      chainIdDecimal: evmChain.chainIdDecimal,
      sellToken: addressOf(sellAsset),
      buyToken: addressOf(buyAsset),
      sellAmount: amount,
      // The wallet address, or the smart account on the AA path (it holds
      // the sell asset and executes the call).
      taker: holder,
      slippageBps: currentSlippageBps(),
    });
    setQuoteView(view);
    if (view.result.ok) {
      const quoted = view.result.quote;
      try {
        const { value: fee } = await withEndpoint(EVM_CHAIN_ID, (ep) => estimateSwapFee(ep.url, quoted));
        setFeeInfo({ zeroExGas: fee.zeroExGas, worstCaseFee: fee.worstCaseFee });
      } catch {
        setFeeInfo(null);
      }
    } else {
      setFeeInfo(null);
    }
    return view;
  };

  /**
   * The node endpoint to prepare an approve or swap transaction through,
   * resolved NOW (failover elsewhere or a Settings change may have moved
   * it since this screen opened). The screen follows it.
   */
  const currentEndpoint = async (): Promise<UsableEndpoint> => {
    const fresh = await getEndpoint(EVM_CHAIN_ID);
    if (!fresh || fresh.url === null) {
      setEndpoint(fresh ?? null);
      throw new Error('No Ethereum endpoint is configured. Set one in Settings → Network endpoints.');
    }
    if (fresh.network.chainId !== evmChain.caip2) {
      throw new Error('The network changed while this screen was open. Start the swap again.');
    }
    if (fresh.url !== url) setEndpoint(fresh);
    return { ...fresh, url: fresh.url };
  };

  /**
   * Prepares through `start` with the shared failover rule; the whole
   * preparation runs again from scratch on the next healthy candidate when
   * a default endpoint fails. Returns the value and the URL that produced
   * it (the URL the transaction must later be sent through).
   */
  const prepareVia = async <T,>(
    start: UsableEndpoint,
    operation: (ep: UsableEndpoint) => Promise<T>,
  ): Promise<{ value: T; url: string }> => {
    const outcome = await callWithFailover(start, operation);
    if (outcome.switched) setEndpoint(outcome.endpoint);
    return { value: outcome.value, url: outcome.endpoint.url };
  };

  /**
   * Quote pinning before any signature: null when `pinned` is still the
   * URL the wallet would use, else the plain refusal to show.
   */
  const pinnedEndpointProblem = async (pinned: string): Promise<string | null> => {
    let current: string | null = null;
    try {
      current = (await getEndpoint(EVM_CHAIN_ID))?.url ?? null;
    } catch {
      current = null;
    }
    return quoteEndpointChange(pinned, current);
  };

  /** Each allowance poll asks the endpoint the wallet would use right now. */
  const allowancePollUrl = async (): Promise<string> => {
    const ep = await getEndpoint(EVM_CHAIN_ID);
    if (!ep || ep.url === null || ep.network.chainId !== evmChain.caip2) {
      throw new Error('No usable Ethereum endpoint for this network right now.');
    }
    return ep.url;
  };

  const onGetQuote = async () => {
    if (!url) return;
    setFormError(null);
    setNotice(null);
    if (!buyAsset) {
      setFormError('Pick an asset to receive.');
      return;
    }
    let amount: bigint;
    let bps: number;
    try {
      amount = parseUnits(amountText, sellDecimals);
      if (amount <= 0n) throw new Error('Amount must be greater than zero');
      bps = currentSlippageBps();
      void bps;
      if (sellBalance !== null) assertSellBalance(amount, sellBalance, sellSymbol);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Invalid input.');
      return;
    }
    setPhase('quoting');
    try {
      const view = await requote();
      if (view && !view.result.ok) {
        setFormError(describeSwapFailure(view.result));
        setPhase('form');
        return;
      }
      setPhase('review');
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'The quote request failed.');
      setPhase('form');
    }
  };

  /**
   * Review → the execute pipeline. A stale quote is refreshed and the user
   * stays on review to see the new numbers; a fresh one proceeds to the
   * allowance check (token sells; native ETH needs no approval per the 0x
   * docs) and then to the standard send confirm.
   */
  const onContinue = async () => {
    if (!url || !quoteView || !quote) return;
    setNotice(null);
    if (isQuoteStale(quoteView.quotedAt)) {
      setPhase('quoting');
      try {
        const view = await requote();
        if (view && !view.result.ok) {
          setFormError(describeSwapFailure(view.result));
          setPhase('form');
          return;
        }
        setNotice(
          'The quote was older than 60 seconds, so it was refreshed with ' +
            'current prices. Review the updated numbers before continuing.',
        );
        setPhase('review');
      } catch (e) {
        setFormError(e instanceof Error ? e.message : 'The quote refresh failed.');
        setPhase('form');
      }
      return;
    }
    setPhase('preparing');
    if (aaActive) {
      try {
        const bundle = aaBundle.current;
        if (!bundle) throw new Error('Smart-account session expired; go back and quote again.');
        markPreparedFrom(account.address);
        const prepared = await prepareAaSwap(
          bundle,
          account.address,
          sellAsset === 'native'
            ? null
            : { token: sellAsset.assetId.reference, symbol: sellAsset.symbol },
          quote,
        );
        setAaQuote(prepared);
        setPhase('aa-confirm');
      } catch (e) {
        const { title, detail } =
          (aaType ? describeAaError(e, { accountType: aaType, deployed: null }) : null) ??
          describeSendError(e, sellSymbol);
        setFormError(`${title}\n${detail}`);
        setPhase('review');
      }
      return;
    }
    try {
      const start = await currentEndpoint();
      // The allowance check and the transaction it leads to come from the
      // same endpoint (one failover-wrapped preparation).
      const { value: next, url: preparedUrl } = await prepareVia(start, async (ep) => {
        if (sellAsset !== 'native') {
          const amount = quote.sellAmount;
          const { sufficient } = await checkAllowance(
            ep.url,
            sellAsset.assetId.reference,
            account.address,
            quote.transaction.to,
            amount,
          );
          if (!sufficient) {
            const prepared = await prepareApproveSend(
              ep.url,
              account.address,
              sellAsset.assetId.reference,
              quote.transaction.to,
              amount, // exactly the sell amount — never unlimited
              evmChain.caip2,
            );
            return { kind: 'approve' as const, prepared };
          }
        }
        const prepared = await prepareSwapSend(ep.url, account.address, quote, evmChain.caip2);
        return { kind: 'swap' as const, prepared };
      });
      markPreparedFrom(account.address);
      setQuotedUrl(preparedUrl);
      setOverrideSimulation(false);
      if (next.kind === 'approve') {
        setApproveQuote(next.prepared);
        setPhase('approve');
        return;
      }
      setSendQuote(next.prepared);
      setPhase('confirm');
    } catch (e) {
      const { title, detail } = describeSendError(e, sellSymbol);
      setFormError(`${title}\n${detail}`);
      setPhase('review');
    }
  };

  /** Step 1 of 2 (token sells only): sign+broadcast the exact approve. */
  const onApprove = async () => {
    if (!quotedUrl || !approveQuote || !quote || sellAsset === 'native') return;
    const approveUrl = quotedUrl;
    const changed = await pinnedEndpointProblem(approveUrl);
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      setApproveQuote(null);
      setPhase('review');
      return;
    }
    const auth = await requireLocalAuth(
      `Approve ${exact(quote.sellAmount, sellDecimals)} ${sellSymbol} for the swap contract`,
    );
    if (!auth.ok) {
      Alert.alert('Not approved', auth.message);
      return;
    }
    setPhase('approving');
    try {
      const sent = await signWith(EVM_CHAIN_ID, preparedFrom.current ?? '', (signer) =>
        sendEvm(approveUrl, signer, approveQuote, evmChain.explorerTxBase),
      );
      setApproveTxid(sent.txid);
      // Polls follow the endpoint the wallet would use NOW: a default that
      // fails a poll is reported, so the next poll goes to a healthy one.
      const confirmed = await waitForAllowance(
        allowancePollUrl,
        sellAsset.assetId.reference,
        account.address,
        quote.transaction.to,
        quote.sellAmount,
        {
          onPollError: (_error, pollUrl) => {
            if (pollUrl) reportEndpointFailure(evmChain.caip2, pollUrl);
          },
        },
      );
      if (!confirmed) {
        Alert.alert(
          'Approval not confirmed yet',
          `The approval was broadcast (transaction ${sent.txid}) but has not ` +
            'taken effect on-chain within the waiting window. Nothing further ' +
            'was sent. Wait for it to confirm, then start the swap again — ' +
            'the allowance will already be in place.',
        );
        setPhase('review');
        return;
      }
      // The wait can take a while, so the swap calldata is re-quoted
      // rather than reusing what was priced before the approval.
      const view = await requote();
      if (!view || !view.result.ok) {
        setFormError(
          view && view.result.ok === false
            ? describeSwapFailure(view.result)
            : 'The post-approval quote failed.',
        );
        setPhase('form');
        return;
      }
      const fresh = view.result.quote;
      if (fresh.transaction.to.toLowerCase() !== quote.transaction.to.toLowerCase()) {
        // The spender the user approved is not the one the new quote pulls
        // through — do not silently chain another approval.
        setFormError(
          'The refreshed quote uses a different swap contract than the one ' +
            'just approved. Start the swap again to review the new approval.',
        );
        setPhase('form');
        return;
      }
      const start = await currentEndpoint();
      const { value: prepared, url: preparedUrl } = await prepareVia(start, (ep) =>
        prepareSwapSend(ep.url, account.address, fresh, evmChain.caip2),
      );
      markPreparedFrom(account.address);
      setQuotedUrl(preparedUrl);
      setSendQuote(prepared);
      setOverrideSimulation(false);
      setNotice(
        'Approval confirmed. The quote was refreshed after the approval — ' +
          'these are the final numbers.',
      );
      setPhase('confirm');
    } catch (e) {
      const { title, detail } = describeSendError(e, sellSymbol);
      Alert.alert(title, detail);
      setPhase('approve');
    }
  };

  /** Final step: sign+broadcast the 0x transaction via the existing path. */
  const onSwap = async () => {
    if (!quotedUrl || !sendQuote || !quoteView || !quote) return;
    if (isQuoteStale(quoteView.quotedAt)) {
      setPhase('preparing');
      try {
        const view = await requote();
        if (!view || !view.result.ok) {
          setFormError(
            view && view.result.ok === false
              ? describeSwapFailure(view.result)
              : 'The quote refresh failed.',
          );
          setPhase('form');
          return;
        }
        const refreshed = view.result.quote;
        const start = await currentEndpoint();
        const { value: prepared, url: preparedUrl } = await prepareVia(start, (ep) =>
          prepareSwapSend(ep.url, account.address, refreshed, evmChain.caip2),
        );
        markPreparedFrom(account.address);
        setQuotedUrl(preparedUrl);
        setSendQuote(prepared);
        setOverrideSimulation(false);
        setNotice(
          'The quote was older than 60 seconds, so it was refreshed and ' +
            're-checked. Review the updated numbers, then confirm again.',
        );
        setPhase('confirm');
      } catch (e) {
        const { title, detail } = describeSendError(e, sellSymbol);
        setFormError(`${title}\n${detail}`);
        setPhase('review');
      }
      return;
    }
    const swapUrl = quotedUrl;
    const changed = await pinnedEndpointProblem(swapUrl);
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      setSendQuote(null);
      setPhase('review');
      return;
    }
    // App-enforced spending limits (phase 12 item 3): sell side, after the
    // eth_call gate, before the biometric gate.
    const swapFrom = preparedFrom.current ?? account.address;
    const withinLimits = await spendingGateForQuote({
      chain: evmChain.caip2,
      owner: swapFrom,
      from: swapFrom,
      quote: sendQuote,
      url: swapUrl,
      ...(sellAsset === 'native' ? {} : { quoteOutflows: [{ token: sellAsset.assetId.reference, amount: quote.sellAmount }] }),
    });
    if (!withinLimits) return;
    const auth = await requireLocalAuth(
      `Swap ${exact(quote.sellAmount, sellDecimals)} ${sellSymbol} for ${buySymbol}`,
    );
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('sending');
    try {
      const sent = await signWith(EVM_CHAIN_ID, preparedFrom.current ?? '', (signer) =>
        sendEvm(swapUrl, signer, sendQuote, evmChain.explorerTxBase),
      );
      setResult(sent);
      setPhase('success');
    } catch (e) {
      const { title, detail } = describeSendError(e, sellSymbol);
      Alert.alert(title, detail);
      setPhase('confirm');
    }
  };

  /**
   * Smart-account execute: ONE UserOperation carrying the whole batch. A
   * stale quote is refreshed (with the smart account as taker) and
   * re-prepared, and the user reviews again; otherwise biometric gate, then
   * the owner key signs through signWith (expectAddress = the owner EOA the
   * operation was prepared for).
   */
  const onAaSwap = async () => {
    if (!url || !aaQuote || !quoteView || !quote) return;
    const bundle = aaBundle.current;
    if (!bundle) {
      Alert.alert('Not sent', 'Smart-account session expired; go back and quote again.');
      return;
    }
    if (isQuoteStale(quoteView.quotedAt)) {
      setPhase('preparing');
      try {
        const view = await requote();
        if (!view || !view.result.ok) {
          setFormError(
            view && view.result.ok === false
              ? describeSwapFailure(view.result)
              : 'The quote refresh failed.',
          );
          setPhase('form');
          return;
        }
        markPreparedFrom(account.address);
        const prepared = await prepareAaSwap(
          bundle,
          account.address,
          sellAsset === 'native'
            ? null
            : { token: sellAsset.assetId.reference, symbol: sellAsset.symbol },
          view.result.quote,
        );
        setAaQuote(prepared);
        setNotice(
          'The quote was older than 60 seconds, so it was refreshed and ' +
            're-estimated. Review the updated numbers, then confirm again.',
        );
        setPhase('aa-confirm');
      } catch (e) {
        const { title, detail } =
          describeAaError(e, { accountType: bundle.accountType, deployed: null }) ??
          describeSendError(e, sellSymbol);
        setFormError(`${title}\n${detail}`);
        setPhase('review');
      }
      return;
    }
    const bundleUrl = aaBundleUrl.current;
    const changed = bundleUrl ? await pinnedEndpointProblem(bundleUrl) : null;
    if (changed) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, changed);
      setAaQuote(null);
      setPhase('review');
      return;
    }
    // App-enforced spending limits (phase 12 item 3): the batch's sell side,
    // after the bundler-estimate gate, before the biometric gate.
    const withinLimits = await spendingGateForQuote({
      chain: evmChain.caip2,
      owner: preparedFrom.current ?? account.address,
      from: preparedFrom.current ?? account.address,
      quote: aaQuote,
      url: bundleUrl ?? url,
      ...(sellAsset === 'native' ? {} : { quoteOutflows: [{ token: sellAsset.assetId.reference, amount: quote.sellAmount }] }),
    });
    if (!withinLimits) return;
    const auth = await requireLocalAuth(
      `Swap ${exact(quote.sellAmount, sellDecimals)} ${sellSymbol} for ${buySymbol} from your smart account`,
    );
    if (!auth.ok) {
      Alert.alert('Not sent', auth.message);
      return;
    }
    setPhase('aa-sending');
    try {
      const { userOpHash } = await signWith(EVM_CHAIN_ID, preparedFrom.current ?? '', (signer) =>
        sendAa(bundle, signer, aaQuote),
      );
      setAaResult({ userOpHash, receiptState: 'pending', success: null, txHash: null });
      setPhase('success');
      void waitForAaReceipt(bundle, userOpHash, { timeoutMs: 120_000, pollMs: 3_000 }).then(
        ({ summary }) =>
          setAaResult((prev) =>
            prev && prev.userOpHash === userOpHash
              ? { ...prev, receiptState: 'found', success: summary.success, txHash: summary.txHash }
              : prev,
          ),
        () =>
          setAaResult((prev) =>
            prev && prev.userOpHash === userOpHash ? { ...prev, receiptState: 'timeout' } : prev,
          ),
      );
    } catch (e) {
      const { title, detail } =
        describeAaError(e, { accountType: aaQuote.accountType, deployed: aaQuote.deployed }) ??
        describeSendError(e, sellSymbol);
      Alert.alert(title, detail);
      setPhase('aa-confirm');
    }
  };

  const inputStyle = [
    styles.input,
    { color: theme.text, borderColor: theme.border, backgroundColor: theme.card },
  ];

  // ------------------------------------------- success (smart account)
  if (phase === 'success' && aaResult) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.successTitle, { color: theme.success }]}>Swap sent to bundler ✓</Text>
        {quote ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Selling {exact(quote.sellAmount, sellDecimals)} {sellSymbol} from your smart account
            for at least {exact(quote.minBuyAmount, buyDecimals)} {buySymbol} (guaranteed
            minimum after slippage), as one operation.
          </Text>
        ) : null}
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
          aaResult.success === false ? (
            <WarningBox>
              The bundler reports the operation was included but reverted
              on-chain: none of the batch took effect, and the gas was still
              charged to the smart account.
            </WarningBox>
          ) : (
            <Text style={[styles.simulationOk, { color: theme.success }]}>
              Included on-chain{aaResult.success === true ? ' — succeeded.' : '.'}
            </Text>
          )
        ) : null}
        {aaResult.txHash ? (
          <Button
            title="View on block explorer"
            variant="secondary"
            onPress={() => void Linking.openURL(`${evmChain.explorerTxBase}${aaResult.txHash}`)}
          />
        ) : null}
        <Button title="Done" onPress={() => navigation.popToTop()} />
      </ScrollView>
    );
  }

  // ------------------------------------ smart-account confirm (one batch)
  if ((phase === 'aa-confirm' || phase === 'aa-sending') && aaQuote && quote) {
    const batch = aaQuote.calls.length > 1;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.stepTitle, { color: theme.text }]}>
          Smart-account swap · {aaAccountTypeLabel(aaQuote.accountType)}
        </Text>
        {notice ? <Text style={[styles.notice, { color: theme.accent }]}>{notice}</Text> : null}
        <Row
          label="Owner account (signs)"
          value={activeAccount?.name ?? '—'}
          sub={account.address}
          theme={theme}
        />
        <Row
          label={aaSenderLabel(aaQuote)}
          value={aaQuote.sender}
          mono
          theme={theme}
        />
        <Row
          label="You sell"
          value={`${exact(quote.sellAmount, sellDecimals)} ${sellSymbol}`}
          sub={fiatOf(sellPriceId, quote.sellAmount, sellDecimals)}
          theme={theme}
        />
        <Row
          label="You receive (estimated)"
          value={`${exact(quote.buyAmount, buyDecimals)} ${buySymbol}`}
          sub={fiatOf(buyPriceId, quote.buyAmount, buyDecimals)}
          theme={theme}
        />
        <Row
          label="Guaranteed minimum"
          value={`${exact(quote.minBuyAmount, buyDecimals)} ${buySymbol}`}
          sub={fiatOf(buyPriceId, quote.minBuyAmount, buyDecimals)}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {batch
            ? `One operation, two calls, all-or-nothing: (1) approve exactly ` +
              `${exact(quote.sellAmount, sellDecimals)} ${sellSymbol} — not unlimited — for the ` +
              `swap contract, (2) the swap. If the swap would fail, the approval is undone ` +
              'with it.'
            : 'One operation with a single call: the swap (selling the native coin needs no approval).'}
        </Text>
        {aaQuote.calls.map((c, i) => (
          <Row
            key={`${i}-${c.to}`}
            label={`Call ${i + 1} of ${aaQuote.calls.length}${batch && i === 0 ? ' — approve' : ' — swap'}`}
            value={c.to}
            sub={`${c.data.length} bytes of calldata${c.value > 0n ? `, value ${exact(c.value, 18)} ${evmChain.displaySymbol}` : ''}`}
            mono
            theme={theme}
          />
        ))}
        {aaQuote.tokenSpend ? (
          <Row
            label={`Smart account ${sellSymbol} balance`}
            value={`${exact(aaQuote.tokenSpend.balance, sellDecimals)} ${sellSymbol}`}
            theme={theme}
          />
        ) : null}
        <Row
          label={`Smart account ${evmChain.displaySymbol} balance`}
          value={`${exact(aaQuote.senderBalance, 18)} ${evmChain.displaySymbol}`}
          theme={theme}
        />
        {aaQuote.eip7702 ? (
          <Eip7702QuoteNotice eip7702={aaQuote.eip7702} noun="swap" />
        ) : (
          <Row
            label="Deployment"
            value={aaQuote.deployed ? 'Already deployed' : 'Will deploy with this swap'}
            theme={theme}
          />
        )}
        {!aaQuote.deployed && aaQuote.accountType === 'kernel-v3.3' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{KERNEL_BUNDLER_NOTE}</Text>
        ) : null}
        <Row
          label={aaQuote.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={
            aaQuote.sponsored
              ? 'Sponsored — you pay 0'
              : `${exact(aaQuote.fee, 18)} ${evmChain.displaySymbol}`
          }
          theme={theme}
        />
        <BalanceChangePreview
          url={url}
          request={{
            from: aaQuote.sender,
            to: aaQuote.calls[0]!.to,
            value: aaQuote.calls[0]!.value,
            data: aaQuote.calls[0]!.data,
          }}
          batch={aaQuote.calls.map((c) => ({
            from: aaQuote.sender,
            to: c.to,
            value: c.value,
            data: c.data,
          }))}
          note={batch ? PREVIEW_AA_BATCH_NOTE : PREVIEW_AA_NOTE}
        />
        <RiskWarnings url={url} wallet={aaQuote.sender} to={aaQuote.calls[0]!.to} data={aaQuote.calls[0]!.data} />
        <SpendingPolicyNotice
          owner={account.address}
          quote={aaQuote}
          from={preparedFromShown ?? account.address}
          {...(sellAsset === 'native' ? {} : { quoteOutflows: [{ token: sellAsset.assetId.reference, amount: quote.sellAmount }] })}
        />
        <Text style={[styles.simulationOk, { color: theme.success }]}>
          Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).
        </Text>
        {phase === 'aa-sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Signing and submitting to the bundler…
            </Text>
          </View>
        ) : (
          <>
            <Button
              title={`Swap ${sellSymbol} for ${buySymbol} from smart account`}
              onPress={() => void onAaSwap()}
            />
            <Button title="Back" variant="secondary" onPress={() => setPhase('review')} />
          </>
        )}
      </ScrollView>
    );
  }

  // -------------------------------------------------------------- success
  if (phase === 'success' && result) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <Text style={[styles.successTitle, { color: theme.success }]}>Swap sent ✓</Text>
        {quote ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Sold {exact(quote.sellAmount, sellDecimals)} {sellSymbol} for at least{' '}
            {exact(quote.minBuyAmount, buyDecimals)} {buySymbol} (guaranteed minimum after
            slippage). The exact amount received is on the transaction.
          </Text>
        ) : null}
        {approveTxid ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Approval transaction: {approveTxid}
          </Text>
        ) : null}
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
        ) : null}
        <Button title="Done" onPress={() => navigation.popToTop()} />
      </ScrollView>
    );
  }

  // ------------------------------------------- approve (step 1 of 2) UI
  if ((phase === 'approve' || phase === 'approving') && approveQuote && quote) {
    const simulationFailed = !approveQuote.simulation.ok;
    const blocked = simulationFailed && !overrideSimulation;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        <Text style={[styles.stepTitle, { color: theme.text }]}>Step 1 of 2 — Approve</Text>
        <Row
          label="From account"
          value={activeAccount?.name ?? '—'}
          sub={preparedFromShown}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Before the swap contract can take your {sellSymbol}, it needs a
          spending allowance. This approves exactly{' '}
          {exact(quote.sellAmount, sellDecimals)} {sellSymbol} — the amount you
          are swapping, not an unlimited allowance — for this swap&apos;s contract.
          The swap itself is a second transaction you confirm afterwards.
        </Text>
        <Row
          label="Approve amount"
          value={`${exact(quote.sellAmount, sellDecimals)} ${sellSymbol} (exact, not unlimited)`}
          theme={theme}
        />
        <Row label="Token contract" value={approveQuote.to} mono theme={theme} />
        <Row label="Spender (swap contract)" value={quote.transaction.to} mono theme={theme} />
        <Row
          label={`Max network fee (paid in ${evmChain.displaySymbol})`}
          value={`${exact(approveQuote.fee, 18)} ${evmChain.displaySymbol}`}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Worst case at {exact(approveQuote.maxFeePerGas, 9)} gwei max fee ×{' '}
          {approveQuote.gasLimit.toString()} gas; the actual fee is usually
          lower, and the unused part is not charged.
        </Text>

        <BalanceChangePreview
          url={confirmUrl}
          request={{
            from: account.address,
            to: approveQuote.to,
            value: approveQuote.amount,
            ...(approveQuote.data ? { data: approveQuote.data } : {}),
          }}
        />
        <RiskWarnings url={confirmUrl} wallet={account.address} to={approveQuote.to} data={approveQuote.data} />

        {approveQuote.simulation.ok ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}>
            Pre-flight simulation passed (eth_call).
          </Text>
        ) : (
          <View style={styles.simulationBlock}>
            <WarningBox>
              Pre-flight simulation failed:{' '}
              {approveQuote.simulation.ok ? '' : approveQuote.simulation.reason}. This
              transaction would very likely fail on-chain and still cost the fee.
            </WarningBox>
            <View style={styles.overrideRow}>
              <Switch
                accessibilityLabel="Send anyway, although the pre-flight simulation failed"
                value={overrideSimulation}
                onValueChange={setOverrideSimulation}
              />
              <Text style={[styles.overrideLabel, { color: theme.text }]}>
                Send anyway (I understand it will probably fail)
              </Text>
            </View>
          </View>
        )}

        {phase === 'approving' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              {approveTxid
                ? `Approval broadcast (${approveTxid.slice(0, 18)}…). Waiting for it to take effect on-chain…`
                : 'Signing and broadcasting the approval…'}
            </Text>
          </View>
        ) : (
          <>
            <Button
              title={`Approve ${sellSymbol}`}
              onPress={() => void onApprove()}
              disabled={blocked}
            />
            <Button title="Back" variant="secondary" onPress={() => setPhase('review')} />
          </>
        )}
      </ScrollView>
    );
  }

  // -------------------------------------------- swap confirm (final step)
  if ((phase === 'confirm' || phase === 'sending') && sendQuote && quote) {
    const simulationFailed = !sendQuote.simulation.ok;
    const blocked = simulationFailed && !overrideSimulation;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        {sellAsset !== 'native' ? (
          <Text style={[styles.stepTitle, { color: theme.text }]}>Step 2 of 2 — Swap</Text>
        ) : null}
        <Row
          label="From account"
          value={activeAccount?.name ?? '—'}
          sub={preparedFromShown}
          theme={theme}
        />
        {notice ? (
          <Text style={[styles.notice, { color: theme.accent }]}>{notice}</Text>
        ) : null}
        <Row
          label="You sell"
          value={`${exact(quote.sellAmount, sellDecimals)} ${sellSymbol}`}
          sub={fiatOf(sellPriceId, quote.sellAmount, sellDecimals)}
          theme={theme}
        />
        <Row
          label="You receive (estimated)"
          value={`${exact(quote.buyAmount, buyDecimals)} ${buySymbol}`}
          sub={fiatOf(buyPriceId, quote.buyAmount, buyDecimals)}
          theme={theme}
        />
        <Row
          label="Guaranteed minimum"
          value={`${exact(quote.minBuyAmount, buyDecimals)} ${buySymbol}`}
          sub={fiatOf(buyPriceId, quote.minBuyAmount, buyDecimals)}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The guaranteed minimum is enforced by the swap transaction itself:
          if the market moves past your slippage setting, the transaction
          fails instead of filling for less.
        </Text>
        <Row label="Swap contract" value={sendQuote.to} mono theme={theme} />
        <Row
          label={`Max network fee (paid in ${evmChain.displaySymbol})`}
          value={`${exact(sendQuote.fee, 18)} ${evmChain.displaySymbol}`}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Worst case at {exact(sendQuote.maxFeePerGas, 9)} gwei max fee ×{' '}
          {sendQuote.gasLimit.toString()} gas; the actual fee is usually lower,
          and the unused part is not charged.
        </Text>
        {sellAsset === 'native' ? (
          <Row
            label="Total spent (worst case)"
            value={`${exact(sendQuote.total, 18)} ${evmChain.displaySymbol}`}
            theme={theme}
          />
        ) : null}

        <BalanceChangePreview
          url={confirmUrl}
          request={{
            from: account.address,
            to: sendQuote.to,
            value: sendQuote.amount,
            ...(sendQuote.data ? { data: sendQuote.data } : {}),
          }}
        />
        <RiskWarnings url={confirmUrl} wallet={account.address} to={sendQuote.to} data={sendQuote.data} />
        <SpendingPolicyNotice
          owner={account.address}
          quote={sendQuote}
          from={preparedFromShown ?? account.address}
          {...(sellAsset === 'native' ? {} : { quoteOutflows: [{ token: sellAsset.assetId.reference, amount: quote.sellAmount }] })}
        />

        {sendQuote.simulation.ok ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}>
            Pre-flight simulation passed (eth_call).
          </Text>
        ) : (
          <View style={styles.simulationBlock}>
            <WarningBox>
              Pre-flight simulation failed:{' '}
              {sendQuote.simulation.ok ? '' : sendQuote.simulation.reason}. This
              transaction would very likely fail on-chain and still cost the fee.
            </WarningBox>
            <View style={styles.overrideRow}>
              <Switch
                accessibilityLabel="Send anyway, although the pre-flight simulation failed"
                value={overrideSimulation}
                onValueChange={setOverrideSimulation}
              />
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
              title={`Swap ${sellSymbol} for ${buySymbol}`}
              onPress={() => void onSwap()}
              disabled={blocked}
            />
            <Button title="Back" variant="secondary" onPress={() => setPhase('review')} />
          </>
        )}
      </ScrollView>
    );
  }

  // ------------------------------------------------------ review (quote)
  if ((phase === 'review' || phase === 'preparing') && quoteView && quote && buyAsset) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={evmChain.label} testnet={evmChain.testnet} theme={theme} />
        {notice ? (
          <Text style={[styles.notice, { color: theme.accent }]}>{notice}</Text>
        ) : null}
        {formError ? (
          <Text accessibilityLiveRegion="polite" style={[styles.fieldError, { color: theme.danger }]}>
            {formError}
          </Text>
        ) : null}
        <Row
          label="You sell"
          value={`${exact(quote.sellAmount, sellDecimals)} ${sellSymbol}`}
          sub={fiatOf(sellPriceId, quote.sellAmount, sellDecimals)}
          theme={theme}
        />
        <Row
          label="You receive (estimated)"
          value={`${exact(quote.buyAmount, buyDecimals)} ${buySymbol}`}
          sub={fiatOf(buyPriceId, quote.buyAmount, buyDecimals)}
          theme={theme}
        />
        <Row
          label="Guaranteed minimum"
          value={`${exact(quote.minBuyAmount, buyDecimals)} ${buySymbol}`}
          sub={fiatOf(buyPriceId, quote.minBuyAmount, buyDecimals)}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The guaranteed minimum is the least you can receive after your
          slippage setting ({currentSlippageBps()} bps); the swap fails
          rather than fill below it.
        </Text>
        <Row
          label="Rate"
          value={`1 ${sellSymbol} ≈ ${impliedRate(
            quote.sellAmount,
            quote.buyAmount,
            sellDecimals,
            buyDecimals,
          )} ${buySymbol}`}
          theme={theme}
        />
        {feeInfo ? (
          <Row
            label={`Network fee estimate (paid in ${evmChain.displaySymbol})`}
            value={
              feeInfo.worstCaseFee !== null && feeInfo.zeroExGas !== null
                ? `~${exact(feeInfo.worstCaseFee, 18)} ${evmChain.displaySymbol} (0x gas estimate ${feeInfo.zeroExGas.toString()} × our current max fee)`
                : 'The quote carried no gas estimate; the exact fee is shown at the confirm step.'
            }
            theme={theme}
          />
        ) : null}
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Our own worst-case fee — priced exactly like a regular send — is
          shown on the confirm screen before anything is signed.
          {sellAsset !== 'native'
            ? ` Selling ${sellSymbol} may need a one-time approval first; if so, the next step explains it.`
            : ''}
        </Text>

        {phase === 'preparing' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Checking allowance and preparing the transaction…
            </Text>
          </View>
        ) : (
          <>
            <Button title="Continue" onPress={() => void onContinue()} />
            <Button
              title="Refresh quote"
              variant="secondary"
              onPress={() => {
                setNotice(null);
                setFormError(null);
                setPhase('quoting');
                void requote()
                  .then((view) => {
                    if (view && !view.result.ok) {
                      setFormError(describeSwapFailure(view.result));
                      setPhase('form');
                    } else {
                      setPhase('review');
                    }
                  })
                  .catch((e) => {
                    setFormError(e instanceof Error ? e.message : 'The quote refresh failed.');
                    setPhase('form');
                  });
              }}
            />
            <Button title="Back" variant="secondary" onPress={() => setPhase('form')} />
          </>
        )}
      </ScrollView>
    );
  }

  // ----------------------------------------------------------------- form
  const pickable: SwapAsset[] = ['native', ...tokens];
  const buyChoices = pickable.filter((a) => assetKey(a) !== assetKey(sellAsset));

  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.networkLine, { color: evmChain.testnet ? theme.testnetFill : theme.textMuted }]}>
        {evmChain.label} · {evmChain.testnet ? 'TESTNET' : 'Mainnet'} · powered by 0x · from{' '}
        {aaActive ? `smart account ${aaSender ? `${aaSender.slice(0, 10)}…` : '(resolving…)'}` : `${account.address.slice(0, 10)}…`}
      </Text>

      {aaAvailable && aaConfig ? (
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border, gap: 8 }]}>
          <View style={styles.overrideRow}>
            <Switch
              accessibilityLabel="Swap from smart account"
              value={aaEnabled}
              onValueChange={(v) => {
                // The taker (and therefore the quote) changes with the path.
                setAaEnabled(v);
                setAaSender(null);
                setQuoteView(null);
                setAaQuote(null);
                setFormError(null);
              }}
            />
            <Text style={[styles.overrideLabel, { color: theme.text }]}>
              Swap from smart account (experimental)
            </Text>
          </View>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Swaps the smart account&apos;s own funds ({aaAccountTypeLabel(aaType ?? aaConfig.accountType)})
            as ONE operation: for a token sale, approve exactly the amount and swap in a single
            all-or-nothing batch — no separate approval step. Gas comes from the smart account
            (or the paymaster when sponsored).
          </Text>
        </View>
      ) : null}

      <OfflineNotice />

      {!url ? (
        <WarningBox>Swapping unavailable — no configured Ethereum endpoint.</WarningBox>
      ) : null}

      {tokens.length === 0 ? (
        <WarningBox>
          {evmChain.testnet
            ? 'No tracked tokens exist on the Sepolia test chain — the ' +
              'tracked list holds mainnet assets, so there is nothing to ' +
              'swap ETH against in test mode. (Note: 0x\'s published ' +
              'supported-chain list covers mainnets only.) Turn off test ' +
              'mode in Settings to swap.'
            : 'Swapping needs at least one tracked token as the other side ' +
              'of the pair. Add one under Settings → Tokens.'}
        </WarningBox>
      ) : null}

      <Text style={[styles.label, { color: theme.textMuted }]}>You sell</Text>
      <View style={styles.choiceRow}>
        {pickable.map((a) => (
          <Button
            key={assetKey(a)}
            title={assetKey(a) === assetKey(sellAsset) ? `✓ ${symbolOf(a)}` : symbolOf(a)}
            variant={assetKey(a) === assetKey(sellAsset) ? 'primary' : 'secondary'}
            selected={assetKey(a) === assetKey(sellAsset)}
            onPress={() => {
              setSellAsset(a);
              setAmountText('');
              setFormError(null);
              // Keep the buy side valid: it must always differ from sell.
              setBuyAsset((prev) => {
                if (prev && assetKey(prev) !== assetKey(a)) return prev;
                return ['native' as SwapAsset, ...tokens].find((c) => assetKey(c) !== assetKey(a)) ?? null;
              });
            }}
            style={styles.choiceButton}
          />
        ))}
      </View>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Balance:{' '}
        {sellBalance !== null
          ? `${formatUnits(sellBalance, sellDecimals)} ${sellSymbol}`
          : sellBalanceFailed
            ? 'could not be loaded right now.'
            : '…'}
      </Text>
      {sellBalanceFailed ? <TechnicalDetail text={sellBalanceDetail} /> : null}
      {sellBalanceFailed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading the balance"
          onPress={() => {
            setSellBalanceFailed(false);
            setSellBalanceDetail(null);
            setSellBalanceTry((n) => n + 1);
          }}
          hitSlop={8}
        >
          <Text style={[styles.hint, { color: theme.accent }]}>Retry</Text>
        </Pressable>
      ) : null}

      <Text style={[styles.label, { color: theme.textMuted }]}>You receive</Text>
      <View style={styles.choiceRow}>
        {buyChoices.map((a) => (
          <Button
            key={assetKey(a)}
            title={buyAsset && assetKey(a) === assetKey(buyAsset) ? `✓ ${symbolOf(a)}` : symbolOf(a)}
            variant={buyAsset && assetKey(a) === assetKey(buyAsset) ? 'primary' : 'secondary'}
            selected={buyAsset !== null && assetKey(a) === assetKey(buyAsset)}
            onPress={() => {
              setBuyAsset(a);
              setFormError(null);
            }}
            style={styles.choiceButton}
          />
        ))}
      </View>

      <Text style={[styles.label, { color: theme.textMuted }]}>Amount ({sellSymbol})</Text>
      <TextInput
        value={amountText}
        onChangeText={(t) => {
          setAmountText(t);
          setFormError(null);
        }}
        accessibilityLabel={`Amount of ${sellSymbol} to sell`}
        placeholder="0.0"
        placeholderTextColor={theme.textMuted}
        keyboardType="decimal-pad"
        style={inputStyle}
      />

      <Text style={[styles.label, { color: theme.textMuted }]}>Max slippage</Text>
      <View style={styles.choiceRow}>
        {SLIPPAGE_CHOICES_BPS.map((bps) => (
          <Button
            key={bps}
            title={
              slippageMode === 'preset' && presetBps === bps
                ? `✓ ${bps / 100}%`
                : `${bps / 100}%`
            }
            variant={slippageMode === 'preset' && presetBps === bps ? 'primary' : 'secondary'}
            selected={slippageMode === 'preset' && presetBps === bps}
            onPress={() => {
              setSlippageMode('preset');
              setPresetBps(bps);
              setFormError(null);
            }}
            style={styles.choiceButton}
          />
        ))}
        <Button
          title={slippageMode === 'custom' ? '✓ Custom' : 'Custom'}
          variant={slippageMode === 'custom' ? 'primary' : 'secondary'}
          selected={slippageMode === 'custom'}
          onPress={() => {
            setSlippageMode('custom');
            setFormError(null);
          }}
          style={styles.choiceButton}
        />
      </View>
      {slippageMode === 'custom' ? (
        <>
          <TextInput
            value={customBpsText}
            onChangeText={(t) => {
              setCustomBpsText(t);
              setFormError(null);
            }}
            accessibilityLabel="Custom maximum slippage in basis points"
            placeholder="basis points, e.g. 75 (= 0.75%)"
            placeholderTextColor={theme.textMuted}
            keyboardType="number-pad"
            style={inputStyle}
          />
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            100 bps = 1%. Allowed range: 1–1000 bps (0.01%–10%).
          </Text>
        </>
      ) : null}

      {formError ? (
        <Text accessibilityLiveRegion="polite" style={[styles.fieldError, { color: theme.danger }]}>
            {formError}
          </Text>
      ) : null}

      {phase === 'quoting' ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}>Fetching quote…</Text>
        </View>
      ) : (
        <Button
          title="Get quote"
          onPress={() => void onGetQuote()}
          disabled={!url || !buyAsset || tokens.length === 0}
        />
      )}

      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Quotes come from the 0x aggregator using your API key (Settings →
        Swaps). Nothing is signed or sent until you confirm on the next
        screens; a quote older than a minute is refreshed before anything
        executes.
      </Text>
    </ScrollView>
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
  /** Secondary line under the value (the fiat value); nothing when null. */
  sub?: string | null;
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
      {sub ? <Text style={[styles.rowSub, { color: theme.textMuted }]}>{sub}</Text> : null}
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
  choiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  choiceButton: {
    paddingHorizontal: 16,
  },
  fieldError: {
    fontSize: 13,
    lineHeight: 18,
  },
  notice: {
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  badge: {
    borderRadius: 12,
    borderWidth: 1.5,
    padding: 12,
    alignItems: 'center',
  },
  badgeText: {
    fontSize: 15,
    fontWeight: '700',
  },
  stepTitle: {
    fontSize: 17,
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
  rowSub: {
    fontSize: 13,
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

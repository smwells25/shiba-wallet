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
import { formatAssetId, nonFungibleTokenId, parseAssetId } from '@shiba-wallet/core';
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
  KERNEL_BUNDLER_NOTE,
  PREVIEW_AA_BATCH_NOTE,
  aaAccountTypeLabel,
  createAaClientFromConfig,
  describeAaError,
  maxAaErc20Send,
  maxAaSend,
  getAaConfig,
  isAaConfigured,
  prepareAaErc20Send,
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
import {
  describeNftSendError,
  maxNft1155Send,
  parseNftAmount,
  prepareNftSend,
  sendNft,
  type NftSendQuote,
} from '../wallet/send-nft';
import { invalidateNftCache, standardLabel } from '../wallet/nfts';
import { extractScannedAddress } from '../wallet/scan';
import { QrScanner } from '../components/QrScanner';
import {
  ContactPicker,
  RecipientContactNotice,
  SaveContactInline,
} from '../components/Contacts';
import { listContacts, matchRecipient, type Contact } from '../wallet/contacts';
import { BalanceChangePreview } from '../components/BalanceChangePreview';
import { RiskWarnings } from '../components/RiskWarnings';
import { PREVIEW_AA_NOTE } from '../wallet/simulation';
import { usePrices } from '../wallet/usePrices';
import { fiatLine, formatFiat, nativePriceAssetId, tokenPriceAssetId } from '../wallet/prices';
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
 * With the smart-account toggle on (phase 7 item 2), a token send is ONE
 * transfer call executed by the smart account (aa.ts prepareAaErc20Send):
 * the token balance and the gas are checked against the smart account,
 * and the bundler's gas estimate is the pre-flight gate.
 */
export function SendScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { accounts, signWith, activeAccount } = useWallet();
  // The active EVM chain profile (config/evm-chain.ts): chain-id checks,
  // explorer links, badges and the AA config key all come from it, so
  // Sepolia test mode switches every EVM-touching piece of this screen
  // at once and the two modes never mix.
  const { evmChain, hideAmounts } = usePrefs();
  const account = accounts.find((a) => a.chainId === route.params.chainId);
  const tokenId = route.params.tokenId;
  const tokenMode = tokenId !== undefined;
  // NFT mode (phase 7 item 4): ERC-721 / ERC-1155 safeTransferFrom on the
  // ACTIVE EVM chain. The route carries the CAIP-19 id (decimal token id);
  // contract and token id are parsed from it through core, never from the
  // display strings. The indexer balance only bounds the ERC-1155 input —
  // the quote re-checks ownership on-chain.
  const nftParams = route.params.nft;
  const nftMode = nftParams !== undefined && !tokenMode;
  const nftTarget = useMemo(() => {
    if (!nftParams) return null;
    try {
      const parsed = parseAssetId(nftParams.assetId);
      if (parsed.namespace !== nftParams.standard) return 'invalid' as const;
      if (!/^[0-9]{1,78}$/.test(nftParams.balance)) return 'invalid' as const;
      return {
        chainId: parsed.chainId,
        contract: parsed.reference,
        tokenId: nonFungibleTokenId(parsed),
        standard: nftParams.standard,
        indexedBalance: BigInt(nftParams.balance),
      };
    } catch {
      return 'invalid' as const;
    }
  }, [nftParams]);
  const nft = nftMode && nftTarget !== 'invalid' ? nftTarget : null;

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
  const [quote, setQuote] = useState<
    SendQuote | AaSendQuote | Erc20SendQuote | NftSendQuote | null
  >(null);
  // The address the quote was prepared for (the confirm screen's "From"
  // account; the smart account's owner on the AA path). signWith refuses
  // to sign unless the active account's key controls exactly this address.
  const [quotedFrom, setQuotedFrom] = useState<string | null>(null);
  const [overrideSimulation, setOverrideSimulation] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  // Contacts (phase 6 item 4) for the ACTIVE network of this slot (the
  // endpoint's network.chainId — 'eip155:11155111' in Sepolia test mode),
  // so a contact saved in one mode never labels a recipient in the other.
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsOpen, setContactsOpen] = useState(false);
  // The last scanned recipient candidate: on the form, "Save as contact"
  // is offered only while the field still holds a freshly scanned address
  // that is not already a contact. The success screen offers it for every
  // non-contact recipient, however it was entered.
  const [scannedRecipient, setScannedRecipient] = useState<string | null>(null);

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
      : nftMode
        ? 'Send NFT'
        : account
          ? `Send ${account.symbol}`
          : 'Send';
    navigation.setOptions({ title });
  }, [navigation, account, token, nftMode]);

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

  const contactsNetworkId = endpoint?.network.chainId ?? null;
  const reloadContacts = useCallback(() => {
    if (!contactsNetworkId) {
      setContacts([]);
      return;
    }
    listContacts(contactsNetworkId).then(setContacts, () => setContacts([]));
  }, [contactsNetworkId]);
  useEffect(reloadContacts, [reloadContacts]);
  // Reload when returning from the Contacts screen (opened from the picker).
  useEffect(() => navigation.addListener('focus', reloadContacts), [navigation, reloadContacts]);

  /**
   * Exact-match / look-alike classification of an address against the
   * active network's contacts (see ../wallet/contacts.ts for the rules).
   */
  const contactMatchFor = (address: string) =>
    contactsNetworkId
      ? matchRecipient(contactsNetworkId, address, contacts)
      : ({ kind: 'none' } as const);
  const formMatch = validation?.ok ? contactMatchFor(validation.normalized) : null;

  /**
   * Success-screen contact line: an exact match shows the name with the
   * full address, a look-alike shows the warning (useful after the fact:
   * it flags a possibly poisoned address), and an unknown recipient gets
   * the unobtrusive "Save as contact" link. A plain render function, not a
   * nested component, so the inline name field keeps its state across
   * re-renders.
   */
  const renderSuccessContact = (address: string) => {
    if (!contactsNetworkId) return null;
    const match = contactMatchFor(address);
    if (match.kind !== 'none') return <RecipientContactNotice match={match} address={address} />;
    return (
      <SaveContactInline
        key={address}
        networkId={contactsNetworkId}
        address={address}
        onSaved={reloadContacts}
      />
    );
  };

  // Fiat values on the confirm screens (phase 6 item 2): the native coin's
  // price for amounts, fees and totals in the native coin, the token's
  // price for token amounts. Ids come from the network that serves this
  // screen, so on Sepolia both are null and nothing is priced or shown.
  const activeNetworkId = endpoint?.network.chainId ?? null;
  const nativePriceId = activeNetworkId
    ? nativePriceAssetId(route.params.chainId, activeNetworkId)
    : null;
  const tokenPriceId = token && activeNetworkId ? tokenPriceAssetId(token, activeNetworkId) : null;
  const { quotes: priceQuotes } = usePrices([nativePriceId, tokenPriceId]);
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

  if (nftMode && nftTarget === 'invalid') {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted, textAlign: 'center', padding: 24 }}>
          This NFT reference is not valid. Go back to the NFTs screen and try again.
        </Text>
      </View>
    );
  }
  if (nft && nft.chainId !== evmChain.caip2) {
    // The NFT was listed in the other network mode; never quote it here.
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted, textAlign: 'center', padding: 24 }}>
          This NFT belongs to the other network mode. Switch Sepolia test
          mode in Settings → Developer to send it.
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
  // mode offers it too (one transfer call from the smart account); NFT mode
  // still hides it (smart-account NFT sends are a later slice).
  const aaAvailable =
    !nftMode &&
    network?.kind === 'evm-jsonrpc' &&
    aaConfig !== null &&
    isAaConfigured(aaConfig);
  /** NFT sends get NFT-specific error titles; everything else is unchanged. */
  const describeError = (e: unknown) =>
    nftMode ? describeNftSendError(e) : describeSendError(e, symbol);
  const nftLabel = nftParams ? `${nftParams.name} (${nftParams.collection})` : '';
  const aaActive = aaAvailable && aaEnabled;

  /**
   * The smart-account bundle for this screen: the ACTIVE chain's verified
   * configuration (account type, factory, Kernel addresses, paymaster),
   * CREATE2 salt = the active account's index (ADR D8), owner = the same
   * account's EOA (passed at quote time).
   */
  const buildAaBundle = (): AaClientBundle => {
    if (!url || !aaConfig) throw new Error('Smart-account settings are not loaded.');
    if (!activeAccount) throw new Error('No active account.');
    return createAaClientFromConfig(aaConfig, {
      nodeUrl: url,
      // Active chain id (11155111 in Sepolia test mode): the quote verifies
      // the node endpoint reports exactly this chain.
      chainId: BigInt(evmChain.chainIdDecimal),
      accountIndex: activeAccount.index,
    });
  };

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
      if (nft) {
        // ERC-1155 Max = the on-chain balance (gas is paid in ETH, so it
        // never reduces the number of copies). ERC-721 has no amount field.
        const held = await maxNft1155Send(url, account.address, nft.contract, nft.tokenId);
        if (held <= 0n) throw new Error('This account holds none of this item on-chain.');
        setAmountText(held.toString());
        return;
      }
      if (aaActive) {
        // AA Max (phase 5): full smart-account balance under sponsorship,
        // else balance minus the worst-case fee of a zero-value probe. In
        // token mode: the smart account's full token balance, refused when
        // its ETH cannot cover the fee.
        if (!validation?.ok) {
          throw new Error('Enter a valid recipient first — the max depends on it.');
        }
        const bundle = buildAaBundle();
        if (token) {
          max = await maxAaErc20Send(bundle, account.address, {
            contract: token.assetId.reference,
            recipient: validation.normalized,
            symbol: token.symbol,
            decimals: token.decimals,
          });
          if (max <= 0n) throw new Error(`The smart account's ${token.symbol} balance is zero.`);
        } else {
          max = await maxAaSend(bundle, account.address, validation.normalized);
          if (max <= 0n) throw new Error('The smart account balance cannot cover the network fee.');
        }
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
      const { title, detail } = describeError(e);
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
      amount = nft
        ? parseNftAmount(amountText, nft.standard, nft.indexedBalance)
        : parseAmount();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Invalid amount.');
      return;
    }
    setPhase('quoting');
    try {
      let next: SendQuote | AaSendQuote | Erc20SendQuote | NftSendQuote;
      if (nft) {
        // NFT mode: EOA path only, ACTIVE chain. The quote re-checks
        // ownership on-chain, checks the ETH balance against the fee, and
        // pre-flights the exact safeTransferFrom calldata via eth_call.
        next = await prepareNftSend({
          url,
          from: account.address,
          to: validation.normalized,
          contract: nft.contract,
          tokenId: nft.tokenId,
          standard: nft.standard,
          amount,
          expectedCaip2: evmChain.caip2,
          nftCaip2: nft.chainId,
        });
      } else if (aaActive) {
        // Experimental ERC-4337 path: quote from the smart account through
        // the bundler estimate (see ../wallet/aa.ts) — a native transfer,
        // or in token mode ONE transfer call executed by the smart account
        // (no approve: the account moves its own tokens). The bundle is kept
        // for the send + receipt poll so all three use the same transports.
        const bundle = buildAaBundle();
        aaBundle.current = bundle;
        next = token
          ? await prepareAaErc20Send(bundle, account.address, {
              contract: token.assetId.reference,
              recipient: validation.normalized,
              amount,
              symbol: token.symbol,
              decimals: token.decimals,
            })
          : await prepareAaSend(bundle, account.address, validation.normalized, amount);
      } else if (token) {
        // ERC-20 token mode, EOA path. Quote checks the token balance,
        // checks the ETH balance against the fee, and pre-flights the
        // transfer calldata through eth_call.
        next = await prepareErc20Send({
          url,
          from: account.address,
          to: validation.normalized,
          contract: token.assetId.reference,
          amount,
          symbol: token.symbol,
          decimals: token.decimals,
        });
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
      setQuotedFrom(account.address);
      setOverrideSimulation(false);
      setPhase('confirm');
    } catch (e) {
      const { title, detail } =
        (aaActive && aaConfig
          ? describeAaError(e, { accountType: aaConfig.accountType, deployed: null })
          : null) ?? describeError(e);
      setFormError(`${title}\n${detail}`);
      setPhase('form');
    }
  };

  const onSend = async () => {
    if (!url || !quote || !quotedFrom) return;
    // Biometric gate (task 7): the final send confirmation requires local
    // authentication whenever the device has enrolled biometrics.
    const auth = await requireLocalAuth(
      nftMode && nftParams
        ? `Approve sending ${quote.kind === 'nft' && quote.standard === 'erc1155' ? `${quote.amount.toString()} × ` : ''}${nftParams.name}`
        : `Approve sending ${amountText} ${symbol}`,
    );
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
        const { userOpHash } = await signWith(route.params.chainId, quotedFrom, (signer) =>
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
      const sent = await signWith(route.params.chainId, quotedFrom, async (signer) => {
        // Token transfer: value 0, to = token contract, data = transfer
        // calldata — through the same sendEvm signing/broadcast path.
        if (quote.kind === 'erc20') return sendErc20(url, signer, quote);
        // NFT transfer: value 0, to = NFT contract, data = safeTransferFrom
        // calldata — through the same sendEvm signing/broadcast path.
        if (quote.kind === 'nft') return sendNft(url, signer, quote, evmChain.explorerTxBase);
        if (quote.kind === 'evm') return sendEvm(url, signer, quote, evmChain.explorerTxBase);
        if (quote.kind === 'sol') return sendSol(url, signer, quote);
        return sendUtxo(url, route.params.chainId, signer, quote, utxoOptions);
      });
      setResult(sent);
      // The gallery's cached list is stale once an NFT left the account.
      if (quote.kind === 'nft' && activeAccount) {
        invalidateNftCache(activeAccount.index, evmChain.caip2);
      }
      setPhase('success');
    } catch (e) {
      const { title, detail } =
        (quote.kind === 'aa'
          ? describeAaError(e, { accountType: quote.accountType, deployed: quote.deployed })
          : null) ?? describeError(e);
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
        {quote ? renderSuccessContact(quote.to) : null}
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
        {quote ? renderSuccessContact(quote.to) : null}
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
            EXPERIMENTAL · ERC-4337 smart account · {aaAccountTypeLabel(quote.accountType)}
          </Text>
        </View>

        <Row label="To" value={quote.to} mono theme={theme} />
        <RecipientContactNotice match={contactMatchFor(quote.to)} address={quote.to} />
        {quote.token ? (
          <>
            <Row
              label="Amount"
              value={`${exact(quote.token.amount, quote.token.decimals)} ${quote.token.symbol}`}
              sub={fiatOf(tokenPriceId, quote.token.amount, quote.token.decimals)}
              theme={theme}
            />
            <Row label="Token contract" value={quote.token.contract} mono theme={theme} />
            {quote.tokenSpend ? (
              <Row
                label={`Smart account ${quote.token.symbol} balance`}
                value={`${exact(quote.tokenSpend.balance, quote.token.decimals)} ${quote.token.symbol}`}
                theme={theme}
              />
            ) : null}
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              One transfer call executed by the smart account: it sends its
              own {quote.token.symbol}, so no approval is needed. Gas is paid
              in {evmChain.displaySymbol} by the smart account (or the
              paymaster, when sponsored).
            </Text>
          </>
        ) : (
          <Row
            label="Amount"
            value={`${exact(quote.amount, nativeDecimals)} ${evmChain.displaySymbol}`}
            sub={fiatOf(nativePriceId, quote.amount, nativeDecimals)}
            theme={theme}
          />
        )}
        <Row
          label="Owner account (signs)"
          value={activeAccount?.name ?? '—'}
          sub={quotedFrom}
          theme={theme}
        />
        <Row label="From smart account" value={quote.sender} mono theme={theme} />
        <Row
          label={`Smart account ${evmChain.displaySymbol} balance`}
          value={`${exact(quote.senderBalance, nativeDecimals)} ${evmChain.displaySymbol}`}
          theme={theme}
        />
        <Row
          label="Deployment"
          value={quote.deployed ? 'Already deployed' : 'Will deploy with this send'}
          theme={theme}
        />
        {!quote.deployed && quote.accountType === 'kernel-v3.3' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{KERNEL_BUNDLER_NOTE}</Text>
        ) : null}
        <Row
          label={quote.sponsored ? 'Network fee' : 'Max network fee (bundler estimate)'}
          value={
            quote.sponsored
              ? 'Sponsored — you pay 0'
              : `${exact(quote.fee, nativeDecimals)} ${evmChain.displaySymbol}`
          }
          sub={quote.sponsored ? null : fiatOf(nativePriceId, quote.fee, nativeDecimals)}
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
          label={quote.token ? `Total ${evmChain.displaySymbol} (worst case)` : 'Total (worst case)'}
          value={`${exact(quote.total, nativeDecimals)} ${evmChain.displaySymbol}`}
          sub={fiatOf(nativePriceId, quote.total, nativeDecimals)}
          theme={theme}
        />

        <BalanceChangePreview
          url={url}
          request={{
            from: quote.sender,
            to: quote.calls[0]!.to,
            value: quote.calls[0]!.value,
            data: quote.calls[0]!.data,
          }}
          batch={quote.calls.map((c) => ({ from: quote.sender, to: c.to, value: c.value, data: c.data }))}
          note={quote.calls.length > 1 ? PREVIEW_AA_BATCH_NOTE : PREVIEW_AA_NOTE}
        />
        <RiskWarnings
          url={url}
          wallet={quote.sender}
          to={quote.calls[0]!.to}
          data={quote.calls[0]!.data}
        />
        <Text style={[styles.simulationOk, { color: theme.success }]}>
          Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).
        </Text>

        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Signing and submitting to the bundler…
            </Text>
          </View>
        ) : (
          <>
            <Button
              title={`Send ${quote.token ? quote.token.symbol : symbol} from smart account`}
              onPress={() => void onSend()}
            />
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

        <Row label="From account" value={activeAccount?.name ?? '—'} sub={quotedFrom} theme={theme} />
        <Row label="To" value={quote.to} mono theme={theme} />
        <RecipientContactNotice match={contactMatchFor(quote.to)} address={quote.to} />
        <Row
          label="Amount"
          value={`${exact(quote.amount, quote.decimals)} ${quote.symbol}`}
          sub={fiatOf(tokenPriceId, quote.amount, quote.decimals)}
          theme={theme}
        />
        <Row label="Token contract" value={quote.contract} mono theme={theme} />
        <Row
          label="Max network fee (paid in ETH)"
          value={`${exact(quote.fee, nativeDecimals)} ETH`}
          sub={fiatOf(nativePriceId, quote.fee, nativeDecimals)}
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

        <BalanceChangePreview
          url={url}
          request={{ from: account.address, to: quote.contract, value: 0n, data: quote.data }}
        />
        <RiskWarnings
          url={url}
          wallet={account.address}
          to={quote.contract}
          counterparty={quote.to}
          data={quote.data}
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

  // --------------------------------------------------- confirm (NFT, EOA)
  if ((phase === 'confirm' || phase === 'sending') && quote?.kind === 'nft' && network) {
    const simulationFailed = !quote.simulation.ok;
    const blocked = simulationFailed && !overrideSimulation;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={network.label} testnet={testnet} theme={theme} />

        <Row label="From account" value={activeAccount?.name ?? '—'} sub={quotedFrom} theme={theme} />
        <Row label="To" value={quote.to} mono theme={theme} />
        <RecipientContactNotice match={contactMatchFor(quote.to)} address={quote.to} />
        <Row label="NFT" value={nftParams?.name ?? '—'} sub={nftParams?.collection ?? null} theme={theme} />
        <Row label="Token ID" value={quote.tokenId.toString()} mono theme={theme} />
        <Row label="Contract" value={quote.contract} mono theme={theme} />
        <Row label="Standard" value={standardLabel(quote.standard)} theme={theme} />
        {quote.standard === 'erc1155' ? (
          <Row
            label="Copies to send"
            value={`${quote.amount.toString()} of ${hideAmounts ? '••••' : quote.ownedBalance.toString()} held`}
            theme={theme}
          />
        ) : null}
        <Row
          label={`Max network fee (paid in ${evmChain.displaySymbol})`}
          value={`${exact(quote.fee, nativeDecimals)} ${evmChain.displaySymbol}`}
          sub={fiatOf(nativePriceId, quote.fee, nativeDecimals)}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Worst case at {exact(quote.maxFeePerGas, 9)} gwei max fee ×{' '}
          {quote.gasLimit.toString()} gas; the actual fee is usually lower,
          and the unused part is not charged. Sent with safeTransferFrom: if
          the recipient is a contract that cannot accept NFTs, the transfer
          reverts instead of locking the NFT away.
          {quote.gasIsFallback
            ? ' Gas estimation failed, so a conservative default gas limit is shown.'
            : ''}
        </Text>
        <Row
          label={`${evmChain.displaySymbol} balance`}
          value={`${exact(quote.ethBalance, nativeDecimals)} ${evmChain.displaySymbol}`}
          theme={theme}
        />

        <BalanceChangePreview
          url={url}
          request={{ from: account.address, to: quote.contract, value: 0n, data: quote.data }}
        />
        <RiskWarnings
          url={url}
          wallet={account.address}
          to={quote.contract}
          counterparty={quote.to}
          data={quote.data}
        />

        {!simulationFailed ? (
          <Text style={[styles.simulationOk, { color: theme.success }]}>
            Pre-flight simulation passed (eth_call).
          </Text>
        ) : (
          <View style={styles.simulationBlock}>
            <WarningBox>
              Pre-flight simulation failed: {quote.simulation.ok ? '' : quote.simulation.reason}.
              This transaction would very likely fail on-chain and still cost the fee.
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
            <Button title="Send NFT" onPress={() => void onSend()} disabled={blocked} />
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
    quote.kind !== 'nft' &&
    network
  ) {
    const simulationFailed = quote.kind === 'evm' && !quote.simulation.ok;
    const sendBlocked = simulationFailed && !overrideSimulation;
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={network.label} testnet={testnet} theme={theme} />

        <Row label="From account" value={activeAccount?.name ?? '—'} sub={quotedFrom} theme={theme} />
        <Row label="To" value={quote.to} mono theme={theme} />
        <RecipientContactNotice match={contactMatchFor(quote.to)} address={quote.to} />
        <Row
          label="Amount"
          value={`${exact(quote.amount, decimals)} ${symbol}`}
          sub={fiatOf(nativePriceId, quote.amount, decimals)}
          theme={theme}
        />
        <Row
          label={quote.kind === 'evm' ? 'Max network fee' : 'Network fee'}
          value={`${exact(quote.fee, decimals)} ${symbol}`}
          sub={fiatOf(nativePriceId, quote.fee, decimals)}
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
          sub={fiatOf(nativePriceId, quote.total, decimals)}
          theme={theme}
        />
        <Row label="Balance" value={`${exact(quote.balance, decimals)} ${symbol}`} theme={theme} />

        {quote.kind === 'evm' ? (
          <BalanceChangePreview
            url={url}
            request={{ from: account.address, to: quote.to, value: quote.amount, data: quote.data }}
          />
        ) : null}
        {quote.kind === 'evm' ? (
          <RiskWarnings url={url} wallet={account.address} to={quote.to} data={quote.data} />
        ) : null}

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
        · from {activeAccount ? `${activeAccount.name} ` : ''}({account.address.slice(0, 10)}…)
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
            {aaActive ? ' your smart account' : ' your Ethereum address'}. The network
            fee is paid in ETH, not in {token.symbol}.
            {aaAvailable
              ? ' With "Send from smart account" on, the smart account sends its own ' +
                `${token.symbol} in one transfer call (no approval needed).`
              : ''}
          </Text>
        </View>
      ) : null}

      {nftMode && nft && nftParams ? (
        <View
          style={[styles.aaToggleBox, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <Text style={[styles.overrideLabel, { color: theme.text }]}>{nftParams.name}</Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {nftParams.collection} · {standardLabel(nft.standard)} · contract{' '}
            {nft.contract.slice(0, 10)}…{nft.contract.slice(-8)} · token ID{' '}
            {nft.tokenId.toString()}
          </Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Sending this NFT from your {evmChain.label} address with
            safeTransferFrom. The network fee is paid in {evmChain.displaySymbol}.
            Smart-account sends are not available for NFTs yet, so NFT sends
            always go from your regular address. Ownership is re-checked
            on-chain before you confirm.
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
            Sends as an ERC-4337 UserOperation from your smart account
            ({aaConfig ? aaAccountTypeLabel(aaConfig.accountType) : 'smart account'}) — a
            separate address controlled by this account&apos;s key — through the
            bundler configured in Settings. The smart account pays the
            amount{token ? ` (its own ${token.symbol})` : ''} and its gas from
            its own balance unless a paymaster sponsors the gas, so fund the
            smart account address first. Max uses the smart account&apos;s balance.
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
          placeholder={token || nftMode ? 'Ethereum address' : `${account.symbol} address`}
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
        <Button
          title="Contacts"
          variant="secondary"
          onPress={() => setContactsOpen(true)}
          disabled={!contactsNetworkId}
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
        rationale={`Point the camera at a ${token || nftMode ? 'Ethereum' : account.name} address QR code. The camera is only used to read the code.`}
        onScanned={(data) => {
          setScannerOpen(false);
          const scanned = extractScannedAddress(route.params.chainId, data);
          setRecipient(scanned);
          setScannedRecipient(scanned);
          setFormError(null);
        }}
        onClose={() => setScannerOpen(false)}
      />
      {/*
        Picking a contact only fills the recipient field: the address then
        runs through the same validation as typed input, and the name is
        shown only via the exact-match notice below (name + full address).
      */}
      <ContactPicker
        visible={contactsOpen}
        contacts={contacts}
        networkLabel={network?.label ?? account.name}
        onPick={(contact) => {
          setContactsOpen(false);
          setRecipient(contact.address);
          setScannedRecipient(null);
          setFormError(null);
        }}
        onClose={() => setContactsOpen(false)}
        onManage={() => {
          setContactsOpen(false);
          navigation.navigate('Contacts');
        }}
      />
      {validation && !validation.ok ? (
        <Text style={[styles.fieldError, { color: theme.danger }]}>{validation.error}</Text>
      ) : null}
      {validation?.ok && validation.note ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {validation.note} Will send to {validation.normalized}
        </Text>
      ) : null}
      {validation?.ok && formMatch ? (
        <RecipientContactNotice match={formMatch} address={validation.normalized} />
      ) : null}
      {validation?.ok &&
      formMatch?.kind === 'none' &&
      contactsNetworkId &&
      scannedRecipient !== null &&
      scannedRecipient === recipient ? (
        <SaveContactInline
          key={validation.normalized}
          networkId={contactsNetworkId}
          address={validation.normalized}
          onSaved={reloadContacts}
        />
      ) : null}

      {nft && nft.standard === 'erc721' ? null : (
        <>
          <Text style={[styles.label, { color: theme.textMuted }]}>
            {nft
              ? `Amount (copies — you hold ${hideAmounts ? '••••' : nft.indexedBalance.toString()})`
              : `Amount (${symbol})`}
          </Text>
          <View style={styles.amountRow}>
            <TextInput
              value={amountText}
              onChangeText={(t) => {
                setAmountText(t);
                setFormError(null);
              }}
              placeholder={nft ? '1' : '0.0'}
              placeholderTextColor={theme.textMuted}
              keyboardType={nft ? 'number-pad' : 'decimal-pad'}
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
        </>
      )}

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

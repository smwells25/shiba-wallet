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
import * as Clipboard from 'expo-clipboard';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { formatAssetId, nonFungibleTokenId, parseAssetId } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import {
  callWithFailover,
  getEndpoint,
  type NetworkEndpoint,
  type UsableEndpoint,
} from '../config/networks';
import { useTheme, type Theme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { formatUnits, parseUnits } from '../wallet/balances';
import {
  BITCOIN_CHAIN_ID,
  EVM_CHAIN_ID,
  QUOTE_ENDPOINT_CHANGED_TITLE,
  describeSendError,
  amountIsLastMax,
  maxAdjustmentSentence,
  maxEvmSend,
  maxSolSend,
  maxUtxoSend,
  prepareEvmSend,
  prepareSolSend,
  prepareUtxoSend,
  quoteEndpointChange,
  sendEvm,
  sendSol,
  sendUtxo,
  validateRecipient,
  L1_DATA_FEE_HEADROOM_PERCENT,
  type LastMaxResult,
  type OpStackFees,
  type SendQuote,
  type SendResult,
} from '../wallet/send';
import {
  PREVIEW_AA_BATCH_NOTE,
  aaAccountTypeLabel,
  aaMaxAdjustmentSentence,
  aaSendApprovalPrompt,
  aaSenderLabel,
  kernelDeploymentNote,
  loadSmartAccountAddress,
  retitleQuoteFailure,
  showsSmartAccountAddressOnSend,
  smartAccountAddressLabel,
  smartAccountDeploymentNote,
  createAaClientFromConfig,
  describeAaError,
  effectiveAaAccountType,
  maxAaErc20Send,
  maxAaSend,
  getAaConfig,
  isAaConfigured,
  prepareAaErc20Send,
  prepareAaSend,
  sendAa,
  waitForAaReceipt,
  aaErc20TransferCalls,
  resolveAaSender,
  type AaChainConfig,
  type AaClientBundle,
  type AaSendQuote,
  type SmartAccountAddressInfo,
} from '../wallet/aa';
import { TokenGasChargeAboveLimitError } from '@shiba-wallet/chains-evm';
import {
  TOKEN_GAS_CHOICE_HINT,
  TOKEN_GAS_ESTIMATE_AFTER_APPROVAL,
  TOKEN_GAS_NO_CHARGE_EVENT,
  TOKEN_GAS_SPREAD_NOTE,
  checkTokenGasPaymaster,
  describeTokenGasError,
  maxAaTokenGasErc20Send,
  maxAaTokenGasSend,
  prepareAaTokenGasErc20Send,
  prepareAaTokenGasSend,
  tokenGasChargeFromReceipt,
  tokenGasChargedSentence,
  tokenGasFeeSentence,
  tokenGasGrantSentence,
  tokenGasMaxAdjustmentSentence,
  tokenGasOffer,
  tokenGasOracleNote,
  tokenGasPaymasterFor,
  tokenGasRateSentence,
  tokenGasSpreadText,
  tokenGasWorstCaseHint,
  type TokenGasCheck,
} from '../wallet/token-gas';
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
import { SpendingPolicyNotice, spendingGateForQuote } from '../components/SpendingPolicyViews';
import { useOwnEvmAddresses } from '../wallet/useOwnAddresses';
import { findOwnAddress } from '../wallet/risk';
import { recordAcceptedSpend, spendingInputForQuote } from '../wallet/spending-policy';
import { PREVIEW_AA_NOTE } from '../wallet/simulation';
import { useAccountDelegation } from '../wallet/useDelegation';
import { delegationLabelSuffix, invalidateAccountDelegation } from '../wallet/delegation';
import { Eip7702QuoteNotice } from '../components/DelegationViews';
import { usePrices } from '../wallet/usePrices';
import { fiatLine, formatFiat, nativePriceAssetId, tokenPriceAssetId } from '../wallet/prices';
import { BITCOIN, DOGECOIN } from '@shiba-wallet/chains-utxo';
import { usePasskeyInfo } from '../wallet/usePasskeyInfo';
import { OfflineNotice } from '../wallet/connectivity';
import { loadPasskeyNative } from '../wallet/passkey-native';
import {
  createPasskeyBundle,
  makePasskeyAssert,
  preparePasskeyCalls,
  sendPasskeyCalls,
  type PasskeyBundle,
} from '../wallet/passkeys';

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
      <View style={[styles.mainnetBadge, { backgroundColor: theme.testnetFill, borderColor: theme.testnetFill }]}>
        <Text style={[styles.mainnetBadgeText, { color: theme.onTestnetFill }]}>
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
  // The wallet's own EVM addresses (accounts and their smart accounts): the
  // success screen names them instead of offering "Save as contact".
  const ownAddresses = useOwnEvmAddresses();
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
  // The endpoint URL the quote was prepared through. The send goes out
  // through exactly this URL, and only while it is still the URL the
  // wallet would use (send.ts quoteEndpointChange); the confirm screen's
  // preview and risk checks read the same URL.
  const [quotedUrl, setQuotedUrl] = useState<string | null>(null);
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
  // The amount text the Max button last wrote on the plain EOA native path
  // (and for which account and chain). Review passes fromMax to
  // prepareEvmSend only while the form still holds exactly this text, so a
  // rise in the fee between the Max tap and Review lowers the Max amount
  // with a plain note instead of refusing it, and a typed amount is never
  // changed.
  const lastEvmMax = useRef<LastMaxResult | null>(null);
  // The same record for the smart-account native Max (aa.ts maxAaSend), kept
  // apart so an EOA Max figure can never be lowered on the smart-account
  // path or the other way round.
  const lastAaMax = useRef<LastMaxResult | null>(null);
  // Passkey signer (phase 8 item 3): offered on smart-account sends when this
  // device installed a passkey on the active account's Kernel account. Off
  // by default; the owner key stays the default signer.
  const [passkeySigner, setPasskeySigner] = useState(false);
  const passkeyInfo = usePasskeyInfo(
    route.params.chainId === EVM_CHAIN_ID ? (account?.address ?? null) : null,
    activeAccount?.index ?? null,
  );
  const [aaResult, setAaResult] = useState<{
    userOpHash: string;
    receiptState: 'pending' | 'found' | 'timeout';
    success: boolean | null;
    txHash: string | null;
    /**
     * USDC-fee sends only: the charge read from Circle's
     * UserOperationSponsored event once the receipt arrived (null when the
     * receipt had no such event; undefined for every other send).
     */
    tokenGasCharge?: bigint | null;
  } | null>(null);
  // Pay the network fee in USDC (phase 13 item 2, ../wallet/token-gas.ts):
  // the user's choice on the form; it takes effect only where the choice is
  // offered and Circle's paymaster passed its on-chain check. ETH is the
  // default.
  const [feeInUsdc, setFeeInUsdc] = useState(false);
  // The Max record for the USDC-fee path, kept apart from the ETH-fee one so
  // a Max figure from one fee mode is never trimmed by the other.
  const lastTokenGasMax = useRef<LastMaxResult | null>(null);

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

  // Token mode: resolve the CAIP-19 id against the ACTIVE chain's tracked
  // list (tokens are per chain since phase 13 item 1). The store is the
  // single source of the token's contract address, symbol and on-chain
  // decimals (all verified when the token was added). A token id from
  // another network is not in this list, so it resolves to null and the
  // screen says so instead of quoting it on the wrong chain.
  useEffect(() => {
    if (!tokenId) return;
    let cancelled = false;
    listTokens(evmChain.caip2).then(
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
  }, [tokenId, evmChain.caip2]);

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

  // EIP-7702 status of the sending account (phase 8 item 1): the "From"
  // rows read "Account 1 · upgraded (Kernel v3.3)" when it runs Kernel.
  const delegation = useAccountDelegation(
    route.params.chainId === EVM_CHAIN_ID ? (account?.address ?? null) : null,
  );
  const fromName = activeAccount
    ? `${activeAccount.name}${delegationLabelSuffix(delegation.status)}`
    : '—';

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
  // Load the list whenever the network changes. Losing the network clears
  // the list while rendering (React's "adjust state when a prop changes"
  // pattern) rather than inside the effect; the effect only does the
  // asynchronous load.
  const [contactsLoadedFor, setContactsLoadedFor] = useState(contactsNetworkId);
  if (contactsLoadedFor !== contactsNetworkId) {
    setContactsLoadedFor(contactsNetworkId);
    if (!contactsNetworkId) setContacts([]);
  }
  useEffect(() => {
    if (!contactsNetworkId) return;
    listContacts(contactsNetworkId).then(setContacts, () => setContacts([]));
  }, [contactsNetworkId]);
  // Reload when returning from the Contacts screen (opened from the picker).
  useEffect(() => navigation.addListener('focus', reloadContacts), [navigation, reloadContacts]);

  // The smart account's own address (counterfactual until its first send
  // deploys it), shown beside the "Send from smart account" toggle so a new
  // account can be funded before it is used. Read-only and node-only
  // (../wallet/aa.ts loadSmartAccountAddress, cached per account + chain).
  // The state carries the key it was read for, and the form shows it only
  // while that key is still current.
  const aaOwner = route.params.chainId === EVM_CHAIN_ID ? (account?.address ?? null) : null;
  const aaNodeUrl = endpoint?.network.kind === 'evm-jsonrpc' ? endpoint.url : null;
  const aaAccountIndex = activeAccount?.index ?? null;
  const aaAddressKey =
    !nftMode && aaConfig && aaOwner && aaNodeUrl && aaAccountIndex !== null &&
    showsSmartAccountAddressOnSend(aaConfig, aaOwner)
      ? `${evmChain.chainIdDecimal}|${aaAccountIndex}|${aaOwner}|${aaNodeUrl}`
      : null;
  const [aaAddressState, setAaAddressState] = useState<{
    key: string;
    info: SmartAccountAddressInfo | null;
    error: string | null;
  } | null>(null);
  const [aaAddressCopied, setAaAddressCopied] = useState(false);
  useEffect(() => {
    if (!aaAddressKey || !aaConfig || !aaOwner || !aaNodeUrl || aaAccountIndex === null) return;
    let cancelled = false;
    loadSmartAccountAddress(aaConfig, {
      nodeUrl: aaNodeUrl,
      chainId: BigInt(evmChain.chainIdDecimal),
      accountIndex: aaAccountIndex,
      ownerAddress: aaOwner,
    }).then(
      (info) => {
        if (!cancelled) setAaAddressState({ key: aaAddressKey, info, error: null });
      },
      (e: unknown) => {
        if (!cancelled) {
          setAaAddressState({
            key: aaAddressKey,
            info: null,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [aaAddressKey, aaConfig, aaOwner, aaNodeUrl, aaAccountIndex, evmChain.chainIdDecimal]);
  const aaAddressView = aaAddressState && aaAddressState.key === aaAddressKey ? aaAddressState : null;
  const aaAddressInfo = aaAddressView?.info ?? null;
  useEffect(() => {
    if (!aaAddressCopied) return;
    const t = setTimeout(() => setAaAddressCopied(false), 2000);
    return () => clearTimeout(t);
  }, [aaAddressCopied]);

  // Circle's paymaster, checked on-chain against the ACTIVE endpoint before
  // the USDC-fee choice is shown (cached briefly by checkTokenGasPaymaster).
  // Only on a network that has a verified paymaster, and only while the
  // smart-account toggle is on; the state carries the key it was read for.
  const tokenGasCheckKey =
    aaEnabled && !nftMode && aaConfig && aaOwner && aaNodeUrl && tokenGasPaymasterFor(evmChain.caip2)
      ? `${evmChain.caip2}|${aaNodeUrl}`
      : null;
  const [tokenGasCheckState, setTokenGasCheckState] = useState<{ key: string; result: TokenGasCheck } | null>(null);
  useEffect(() => {
    if (!tokenGasCheckKey || !aaNodeUrl) return;
    let cancelled = false;
    checkTokenGasPaymaster(aaNodeUrl, evmChain.caip2).then(
      (result) => {
        if (!cancelled) setTokenGasCheckState({ key: tokenGasCheckKey, result });
      },
      (e: unknown) => {
        if (!cancelled) {
          setTokenGasCheckState({
            key: tokenGasCheckKey,
            result: { ok: false, reason: e instanceof Error ? e.message : String(e) },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tokenGasCheckKey, aaNodeUrl, evmChain.caip2]);
  const tokenGasCheck =
    tokenGasCheckState && tokenGasCheckState.key === tokenGasCheckKey ? tokenGasCheckState.result : null;

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
    // One of the wallet's own accounts (finding 13): named as such, never
    // offered as a new contact.
    const own = route.params.chainId === EVM_CHAIN_ID ? findOwnAddress(address, ownAddresses) : null;
    if (own) {
      return (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {`This is one of your own accounts in this wallet: ${own.label}.`}
        </Text>
      );
    }
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
        <Text style={{ color: theme.textMuted, textAlign: 'center', padding: 24 }}>
          This token is not in your tracked list on {evmChain.label}. Tokens are
          tracked per network: switch back to the token&apos;s network under
          Settings → Developer, or add it under Manage tokens.
        </Text>
      </View>
    );
  }
  if (tokenMode && token && token.assetId.chainId !== evmChain.caip2) {
    // Defensive: the list above is the active chain's, so this cannot
    // happen; if it ever did, nothing is quoted on the wrong chain.
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted, textAlign: 'center', padding: 24 }}>
          This token belongs to another network. Switch networks under
          Settings → Developer to send it.
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
  const utxoNetwork = route.params.chainId === BITCOIN_CHAIN_ID ? BITCOIN : DOGECOIN;
  // Backend selection for the UTXO engine calls: Dogecoin's endpoint is a
  // Blockbook instance (config/defaults.ts) whose optional API key rides
  // along as the api-key header resolved by config/networks.ts; Bitcoin
  // keeps the Esplora default.
  const utxoOptionsFor = (ep: NetworkEndpoint | null | undefined) =>
    ep?.network.kind === 'blockbook'
      ? { backend: 'blockbook' as const, ...(ep.headers ? { headers: ep.headers } : {}) }
      : undefined;
  const utxoOptions = utxoOptionsFor(endpoint);
  // The URL the confirm screen's preview and risk checks use: the quote's.
  const confirmUrl = quotedUrl ?? url;

  /**
   * The endpoint to quote through, resolved NOW (another screen's failure
   * report may have moved the wallet to another default since this screen
   * opened; Settings may have changed an override). The form follows it.
   */
  const currentEndpoint = async (): Promise<UsableEndpoint> => {
    const fresh = await getEndpoint(route.params.chainId);
    if (!fresh || fresh.url === null) {
      setEndpoint(fresh ?? null);
      throw new Error('No endpoint is configured for this network. Set one in Settings → Network endpoints.');
    }
    if (fresh.network.chainId !== network?.chainId) {
      setEndpoint(fresh);
      throw new Error('The network changed while this screen was open. Review the details and try again.');
    }
    if (fresh.url !== url) setEndpoint(fresh);
    return { ...fresh, url: fresh.url };
  };

  /**
   * Runs an EOA quote (or Max) through `start` with the shared failover rule
   * (config/networks.ts callWithFailover): a failing default endpoint is
   * reported and the whole operation runs again, from scratch, on the next
   * healthy candidate. Returns the value with the endpoint that produced it.
   */
  const viaFailover = async <T,>(
    start: UsableEndpoint,
    operation: (ep: UsableEndpoint) => Promise<T>,
  ): Promise<{ value: T; used: UsableEndpoint }> => {
    const outcome = await callWithFailover(start, operation);
    if (outcome.switched) setEndpoint(outcome.endpoint);
    return { value: outcome.value, used: outcome.endpoint };
  };
  // The smart-account toggle appears only when both AA endpoints are
  // configured for this EVM chain — configured means verified, because the
  // Settings save path refuses anything that fails verification. Token
  // mode offers it too (one transfer call from the smart account); NFT mode
  // still hides it (smart-account NFT sends are a later slice).
  const aaAvailable =
    !nftMode &&
    network?.kind === 'evm-jsonrpc' &&
    aaConfig !== null &&
    isAaConfigured(aaConfig, account.address);
  // 'kernel-7702' for an account upgraded through "Upgrade this account",
  // else the chain's configured type.
  const aaType = aaConfig ? effectiveAaAccountType(aaConfig, account.address) : null;
  /** NFT sends get NFT-specific error titles; everything else is unchanged. */
  const describeError = (e: unknown) =>
    nftMode ? describeNftSendError(e) : describeSendError(e, symbol);
  const aaActive = aaAvailable && aaEnabled;
  // The passkey signs only for a Kernel v3.3 smart account (not SimpleAccount,
  // not an EIP-7702 upgrade) whose passkey this device installed.
  const passkeyRecord = aaType === 'kernel-v3.3' ? passkeyInfo.record : null;
  const passkeyActive = aaActive && passkeySigner && passkeyRecord !== null;
  // Pay the network fee in USDC: offered by configuration (tokenGasOffer),
  // then shown only once Circle's paymaster passed its on-chain check, and
  // used only when the user turned it on. Never together with the passkey
  // signer (tokenGasOffer refuses that combination).
  const tokenGasOfferNow = aaActive
    ? tokenGasOffer({ chainCaip2: evmChain.caip2, config: aaConfig, owner: account.address, passkeySigner: passkeyActive })
    : null;
  const tokenGasReady = tokenGasOfferNow?.kind === 'available' && tokenGasCheck?.ok === true;
  const tokenGasActive = aaActive && tokenGasReady && feeInUsdc && !passkeyActive;

  /**
   * The passkey-signing bundle over the same verified configuration: the
   * smart account must be the one the passkey was installed in, and the
   * native passkey module must be present with a configured rpId (the gate).
   */
  const buildPasskeyBundle = async (nodeUrl: string | null = url): Promise<PasskeyBundle> => {
    if (!passkeyRecord) throw new Error('No passkey is installed for this account on this network.');
    const base = buildAaBundle(nodeUrl);
    const sender = await resolveAaSender(base, account.address);
    if (sender.toLowerCase() !== passkeyRecord.account.toLowerCase()) {
      throw new Error(`The passkey belongs to ${passkeyRecord.account}, not this smart account (${sender}).`);
    }
    const { gate, native } = await loadPasskeyNative();
    if (!gate.ok || !native) throw new Error(gate.ok ? 'The passkey module is not available.' : gate.reason);
    return createPasskeyBundle(base, passkeyRecord, makePasskeyAssert(native, passkeyRecord));
  };

  /**
   * The smart-account bundle for this screen: the ACTIVE chain's verified
   * configuration (account type, factory, Kernel addresses, paymaster),
   * CREATE2 salt = the active account's index (ADR D8), owner = the same
   * account's EOA (passed at quote time).
   */
  const buildAaBundle = (nodeUrl: string | null = url): AaClientBundle => {
    if (!nodeUrl || !aaConfig) throw new Error('Smart-account settings are not loaded.');
    if (!activeAccount) throw new Error('No active account.');
    return createAaClientFromConfig(aaConfig, {
      nodeUrl,
      // Active chain id (11155111 in Sepolia test mode): the quote verifies
      // the node endpoint reports exactly this chain.
      chainId: BigInt(evmChain.chainIdDecimal),
      accountIndex: activeAccount.index,
      // An owner upgraded with EIP-7702 gets the 'kernel-7702' bundle (the
      // account at its own address); everyone else the chain's type.
      ownerAddress: account.address,
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
    lastEvmMax.current = null;
    lastAaMax.current = null;
    lastTokenGasMax.current = null;
    try {
      const start = await currentEndpoint();
      let max: bigint;
      if (nft) {
        // ERC-1155 Max = the on-chain balance (gas is paid in ETH, so it
        // never reduces the number of copies). ERC-721 has no amount field.
        const { value: held } = await viaFailover(start, (ep) =>
          maxNft1155Send(ep.url, account.address, nft.contract, nft.tokenId),
        );
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
        if (tokenGasActive) {
          // Network fee in USDC: native Max = the smart account's full ETH
          // balance (no ETH pays for gas); USDC Max = its USDC balance minus
          // the worst-case fee; another token's Max = its full balance.
          const tbundle = buildAaBundle(start.url);
          if (token) {
            max = await maxAaTokenGasErc20Send(tbundle, account.address, {
              contract: token.assetId.reference,
              recipient: validation.normalized,
              symbol: token.symbol,
              decimals: token.decimals,
              chainCaip2: token.assetId.chainId,
            });
            if (max <= 0n) {
              throw new Error(`The smart account's ${token.symbol} balance cannot cover the amount and the network fee.`);
            }
          } else {
            max = await maxAaTokenGasSend(tbundle, account.address);
            if (max <= 0n) throw new Error('The smart account holds no ETH to send.');
          }
          const tgText = exact(max, decimals);
          lastTokenGasMax.current = { text: tgText, from: account.address, chainId: route.params.chainId };
          setAmountText(tgText);
          return;
        }
        if (passkeyActive) {
          // Passkey path: the passkey's own quote (nonce key, stub, padding)
          // prices the fee; tokens use the full token balance.
          const pbundle = await buildPasskeyBundle(start.url);
          const pkAccount = pbundle.passkey.record.account;
          if (token) {
            max = await maxAaErc20Send(pbundle, pkAccount, {
              contract: token.assetId.reference,
              recipient: validation.normalized,
              symbol: token.symbol,
              decimals: token.decimals,
              chainCaip2: token.assetId.chainId,
            });
            if (max <= 0n) throw new Error(`The smart account's ${token.symbol} balance is zero.`);
          } else {
            const probe = await preparePasskeyCalls(pbundle, [
              { to: validation.normalized, value: 0n, data: new Uint8Array(0) },
            ]);
            max = probe.senderBalance > probe.fee ? probe.senderBalance - probe.fee : 0n;
            if (max <= 0n) throw new Error('The smart account balance cannot cover the network fee.');
          }
          setAmountText(exact(max, decimals));
          return;
        }
        const bundle = buildAaBundle(start.url);
        if (token) {
          max = await maxAaErc20Send(bundle, account.address, {
            contract: token.assetId.reference,
            recipient: validation.normalized,
            symbol: token.symbol,
            decimals: token.decimals,
            chainCaip2: token.assetId.chainId,
          });
          if (max <= 0n) throw new Error(`The smart account's ${token.symbol} balance is zero.`);
        } else {
          max = await maxAaSend(bundle, account.address, validation.normalized);
          if (max <= 0n) throw new Error('The smart account balance cannot cover the network fee.');
          lastAaMax.current = { text: exact(max, decimals), from: account.address, chainId: route.params.chainId };
        }
      } else if (token) {
        // Token max = the full token balance: the fee is paid in ETH, so
        // it never reduces the token amount. maxErc20Send refuses (with a
        // plain "Not enough ETH" error) when the ETH balance cannot cover
        // the worst-case fee for transferring that balance.
        max = (
          await viaFailover(start, (ep) =>
            maxErc20Send(
              ep.url,
              account.address,
              token.assetId.reference,
              validation?.ok ? validation.normalized : undefined,
              token.assetId.chainId,
            ),
          )
        ).value;
        if (max <= 0n) throw new Error(`Your ${token.symbol} balance is zero.`);
      } else if (start.network.kind === 'evm-jsonrpc') {
        max = (
          await viaFailover(start, (ep) =>
            maxEvmSend(ep.url, account.address, validation?.ok ? validation.normalized : undefined),
          )
        ).value;
      } else if (start.network.kind === 'solana-jsonrpc') {
        max = (await viaFailover(start, (ep) => maxSolSend(ep.url, account.address))).value;
      } else {
        // UTXO max depends on the recipient's output size, so it needs a
        // valid recipient first.
        if (!validation?.ok) {
          throw new Error('Enter a valid recipient first — the max depends on it.');
        }
        const normalized = validation.normalized;
        const { value: swept } = await viaFailover(start, (ep) =>
          maxUtxoSend(ep.url, utxoNetwork, account.address, normalized, utxoOptionsFor(ep)),
        );
        max = swept.amount;
      }
      if (max <= 0n) throw new Error('Balance is too small to cover the network fee.');
      const maxText = exact(max, decimals);
      if (!aaActive && !token && start.network.kind === 'evm-jsonrpc') {
        lastEvmMax.current = { text: maxText, from: account.address, chainId: route.params.chainId };
      }
      setAmountText(maxText);
    } catch (e) {
      const { title, detail } = retitleQuoteFailure(
        (tokenGasActive ? describeTokenGasError(e) : null) ??
          (aaActive && aaType
            ? describeAaError(e, { accountType: aaType, deployed: null, bundlerUrl: aaConfig?.bundlerUrl ?? null })
            : null) ??
          describeError(e),
      );
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
      const start = await currentEndpoint();
      const recipientAddress = validation.normalized;
      let next: SendQuote | AaSendQuote | Erc20SendQuote | NftSendQuote;
      // The URL the quote comes from; the send must go out through it.
      let quoteUrl = start.url;
      if (nft) {
        // NFT mode: EOA path only, ACTIVE chain. The quote re-checks
        // ownership on-chain, checks the ETH balance against the fee, and
        // pre-flights the exact safeTransferFrom calldata via eth_call.
        const quoted = await viaFailover(start, (ep) =>
          prepareNftSend({
            url: ep.url,
            from: account.address,
            to: recipientAddress,
            contract: nft.contract,
            tokenId: nft.tokenId,
            standard: nft.standard,
            amount,
            expectedCaip2: evmChain.caip2,
            nftCaip2: nft.chainId,
          }),
        );
        next = quoted.value;
        quoteUrl = quoted.used.url;
      } else if (aaActive) {
        // Experimental ERC-4337 path: quote from the smart account through
        // the bundler estimate (see ../wallet/aa.ts) — a native transfer,
        // or in token mode ONE transfer call executed by the smart account
        // (no approve: the account moves its own tokens). The bundle is kept
        // for the send + receipt poll so all three use the same transports.
        // The smart-account paths are not failed over: their errors can come
        // from the bundler as well as the node, and charging a bundler
        // refusal to the node endpoint would be wrong. They quote through
        // the endpoint resolved just now and are pinned to it like the rest.
        if (tokenGasActive) {
          // Network fee in USDC through Circle's paymaster: quoted WITHOUT a
          // bundler estimate (the estimation stub needs a permit signed by
          // the account, so estimation runs after the biometric gate); the
          // confirm shows the worst case, which caps every permit signed.
          const tbundle = buildAaBundle(start.url);
          aaBundle.current = tbundle;
          const tgFromMax = amountIsLastMax(lastTokenGasMax.current, {
            text: amountText,
            from: account.address,
            chainId: route.params.chainId,
          });
          next = token
            ? await prepareAaTokenGasErc20Send(
                tbundle,
                account.address,
                {
                  contract: token.assetId.reference,
                  recipient: validation.normalized,
                  amount,
                  symbol: token.symbol,
                  decimals: token.decimals,
                  chainCaip2: token.assetId.chainId,
                },
                { fromMax: tgFromMax },
              )
            : await prepareAaTokenGasSend(tbundle, account.address, validation.normalized, amount, {
                fromMax: tgFromMax,
              });
          setQuote(next);
          setQuotedFrom(account.address);
          setQuotedUrl(quoteUrl);
          setOverrideSimulation(false);
          setPhase('confirm');
          return;
        }
        if (passkeyActive) {
          // Passkey-signed operation from the SAME smart account: quoted with
          // the passkey nonce key and stub signature (passkeys.ts).
          const pbundle = await buildPasskeyBundle(start.url);
          aaBundle.current = pbundle;
          next = token
            ? await preparePasskeyCalls(
                pbundle,
                aaErc20TransferCalls(token.assetId.reference, validation.normalized, amount),
                {
                  tokenSpend: { contract: token.assetId.reference, amount, symbol: token.symbol },
                  displayTo: validation.normalized,
                  token: {
                    contract: token.assetId.reference,
                    recipient: validation.normalized,
                    amount,
                    symbol: token.symbol,
                    decimals: token.decimals,
                  },
                },
              )
            : await preparePasskeyCalls(pbundle, [
                { to: validation.normalized, value: amount, data: new Uint8Array(0) },
              ]);
          setQuote(next);
          setQuotedFrom(account.address);
          setQuotedUrl(quoteUrl);
          setOverrideSimulation(false);
          setPhase('confirm');
          return;
        }
        const bundle = buildAaBundle(start.url);
        aaBundle.current = bundle;
        next = token
          ? await prepareAaErc20Send(bundle, account.address, {
              contract: token.assetId.reference,
              recipient: validation.normalized,
              amount,
              symbol: token.symbol,
              decimals: token.decimals,
              chainCaip2: token.assetId.chainId,
            })
          : await prepareAaSend(bundle, account.address, validation.normalized, amount, {
              fromMax: amountIsLastMax(lastAaMax.current, {
                text: amountText,
                from: account.address,
                chainId: route.params.chainId,
              }),
            });
      } else if (token) {
        // ERC-20 token mode, EOA path. Quote checks the token balance,
        // checks the ETH balance against the fee, and pre-flights the
        // transfer calldata through eth_call.
        const quoted = await viaFailover(start, (ep) =>
          prepareErc20Send({
            url: ep.url,
            from: account.address,
            to: recipientAddress,
            contract: token.assetId.reference,
            amount,
            symbol: token.symbol,
            decimals: token.decimals,
            chainCaip2: token.assetId.chainId,
          }),
        );
        next = quoted.value;
        quoteUrl = quoted.used.url;
      } else if (start.network.kind === 'evm-jsonrpc') {
        // The endpoint's eth_chainId must match the ACTIVE EVM chain
        // (mainnet 1 / Sepolia 11155111) — the modes can never mix.
        const fromMax = amountIsLastMax(lastEvmMax.current, {
          text: amountText,
          from: account.address,
          chainId: route.params.chainId,
        });
        const quoted = await viaFailover(start, (ep) =>
          prepareEvmSend(ep.url, account.address, recipientAddress, amount, undefined, evmChain.caip2, {
            fromMax,
          }),
        );
        next = quoted.value;
        quoteUrl = quoted.used.url;
      } else if (start.network.kind === 'solana-jsonrpc') {
        const quoted = await viaFailover(start, (ep) =>
          prepareSolSend(ep.url, account.address, recipientAddress, amount),
        );
        next = quoted.value;
        quoteUrl = quoted.used.url;
      } else {
        const quoted = await viaFailover(start, (ep) =>
          prepareUtxoSend(ep.url, utxoNetwork, account.address, recipientAddress, amount, utxoOptionsFor(ep)),
        );
        next = quoted.value;
        quoteUrl = quoted.used.url;
      }
      setQuote(next);
      setQuotedFrom(account.address);
      setQuotedUrl(quoteUrl);
      setOverrideSimulation(false);
      setPhase('confirm');
    } catch (e) {
      // Nothing has been signed or sent while a quote is prepared: the
      // generic failure title says so (retitleQuoteFailure).
      const { title, detail } = retitleQuoteFailure(
        (tokenGasActive ? describeTokenGasError(e) : null) ??
          (aaActive && aaType
            ? describeAaError(e, { accountType: aaType, deployed: null, bundlerUrl: aaConfig?.bundlerUrl ?? null })
            : null) ??
          describeError(e),
      );
      setFormError(`${title}\n${detail}`);
      setPhase('form');
    }
  };

  const onSend = async () => {
    if (!quote || !quotedFrom || !quotedUrl) return;
    // Quote pinning: the quote is one endpoint's answer. If the wallet would
    // now use a different endpoint (failover elsewhere in the app, or a
    // Settings change), refuse and ask for a fresh quote — never patch it.
    let currentUrl: string | null = null;
    try {
      currentUrl = (await getEndpoint(route.params.chainId))?.url ?? null;
    } catch {
      currentUrl = null;
    }
    const endpointChanged = quoteEndpointChange(quotedUrl, currentUrl);
    if (endpointChanged) {
      Alert.alert(QUOTE_ENDPOINT_CHANGED_TITLE, endpointChanged);
      setQuote(null);
      setQuotedUrl(null);
      setPhase('form');
      return;
    }
    const sendUrl = quotedUrl;
    // App-enforced spending limits (phase 12 item 3): after the eth_call or
    // bundler-estimate gate (the button stays disabled until it passed or was
    // overridden) and before the biometric gate. EVM sends only.
    if (quote.kind === 'evm' || quote.kind === 'erc20' || quote.kind === 'nft' || quote.kind === 'aa') {
      const withinLimits = await spendingGateForQuote({
        chain: evmChain.caip2,
        owner: quotedFrom,
        from: quotedFrom,
        quote,
        url: sendUrl,
        authenticateOverride: quote.kind === 'aa' && quote.passkey === true,
      });
      if (!withinLimits) return;
    }
    if (quote.kind === 'aa' && quote.passkey) {
      // Passkey-signed: no app-level biometric gate and no owner key. The
      // platform passkey prompt that runs at submission IS the user
      // verification, and the validator rejects assertions without the UV
      // flag on-chain.
      const bundle = aaBundle.current as PasskeyBundle | null;
      if (!bundle?.passkey) {
        Alert.alert('Not sent', 'Passkey session expired; go back and review again.');
        return;
      }
      setPhase('sending');
      try {
        const { userOpHash } = await sendPasskeyCalls(bundle, quote);
        // The passkey path bypasses sendAa's listeners: record the accepted
        // operation for the spending limits here.
        void recordAcceptedSpend({
          scope: { chain: evmChain.caip2, owner: quotedFrom },
          ...spendingInputForQuote(quote, quotedFrom),
          ref: userOpHash,
        });
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
          describeAaError(e, { accountType: 'kernel-v3.3', deployed: true }) ?? describeError(e);
        Alert.alert(title, detail);
        setPhase('confirm');
      }
      return;
    }
    // Biometric gate (task 7): the final send confirmation requires local
    // authentication whenever the device has enrolled biometrics.
    const auth = await requireLocalAuth(
      nftMode && nftParams
        ? `Approve sending ${quote.kind === 'nft' && quote.standard === 'erc1155' ? `${quote.amount.toString()} × ` : ''}${nftParams.name}`
        : quote.kind === 'aa'
          ? aaSendApprovalPrompt(quote, `${amountText} ${symbol}`)
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
          ({ raw, summary }) => {
            // The operation carried the EIP-7702 upgrade: re-read the
            // account's status now that it is included.
            if (quote.eip7702?.upgrade) invalidateAccountDelegation(quote.sender);
            // USDC fee: the actual charge from Circle's event in the receipt.
            const tokenGasCharge = quote.tokenGas
              ? (tokenGasChargeFromReceipt(raw, {
                  userOpHash,
                  paymaster: quote.tokenGas.paymaster,
                  token: quote.tokenGas.token,
                  sender: quote.sender,
                })?.actualTokenNeeded ?? null)
              : undefined;
            setAaResult((prev) =>
              prev && prev.userOpHash === userOpHash
                ? {
                    ...prev,
                    receiptState: 'found',
                    success: summary.success,
                    txHash: summary.txHash,
                    ...(tokenGasCharge !== undefined ? { tokenGasCharge } : {}),
                  }
                : prev,
            );
          },
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
        if (quote.kind === 'erc20') return sendErc20(sendUrl, signer, quote);
        // NFT transfer: value 0, to = NFT contract, data = safeTransferFrom
        // calldata — through the same sendEvm signing/broadcast path.
        if (quote.kind === 'nft') return sendNft(sendUrl, signer, quote, evmChain.explorerTxBase);
        if (quote.kind === 'evm') return sendEvm(sendUrl, signer, quote, evmChain.explorerTxBase);
        if (quote.kind === 'sol') return sendSol(sendUrl, signer, quote);
        return sendUtxo(sendUrl, route.params.chainId, signer, quote, utxoOptions);
      });
      setResult(sent);
      // The gallery's cached list is stale once an NFT left the account.
      if (quote.kind === 'nft' && activeAccount) {
        invalidateNftCache(activeAccount.index, evmChain.caip2);
      }
      setPhase('success');
    } catch (e) {
      // USDC fee: the charge would now exceed the amount the user approved.
      // Nothing was signed above that amount and nothing was sent; back to
      // the form so Review shows the new worst case.
      if (quote.kind === 'aa' && quote.tokenGas && e instanceof TokenGasChargeAboveLimitError) {
        const described = describeTokenGasError(e, quote.tokenGas);
        setQuote(null);
        setQuotedUrl(null);
        setFormError(described ? `${described.title}\n${described.detail}` : e.message);
        setPhase('form');
        return;
      }
      const { title, detail } =
        (quote.kind === 'aa' && quote.tokenGas ? describeTokenGasError(e, quote.tokenGas) : null) ??
        (quote.kind === 'aa'
          ? describeAaError(e, {
              accountType: quote.accountType,
              deployed: quote.deployed,
              sender: quote.sender,
              bundlerUrl: aaConfig?.bundlerUrl ?? null,
            })
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
            {quote?.kind === 'aa' && quote.tokenGas && aaResult.tokenGasCharge !== undefined ? (
              <Text style={[styles.hint, { color: theme.text }]}>
                {aaResult.tokenGasCharge === null
                  ? TOKEN_GAS_NO_CHARGE_EVENT
                  : tokenGasChargedSentence(
                      exact(aaResult.tokenGasCharge, quote.tokenGas.decimals),
                      exact(quote.tokenGas.maxTokenCharge, quote.tokenGas.decimals),
                      quote.tokenGas.symbol,
                    )}
              </Text>
            ) : null}
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
                The bundler&apos;s receipt did not include a recognizable
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
              {quote.tokenGas
                ? `One transfer call executed by the smart account: it sends its own ${quote.token.symbol}, ` +
                  `so no approval is needed. The network fee is paid in ${quote.tokenGas.symbol} through ` +
                  'Circle\u2019s paymaster (see below).'
                : `One transfer call executed by the smart account: it sends its own ${quote.token.symbol}, ` +
                  `so no approval is needed. Gas is paid in ${evmChain.displaySymbol} by the smart account ` +
                  '(or the paymaster, when sponsored).'}
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
        {quote.kind === 'aa' && quote.maxAdjustment ? (
          <WarningBox>
            {!quote.tokenGas
              ? aaMaxAdjustmentSentence(quote, (v) => `${exact(v, nativeDecimals)} ${evmChain.displaySymbol}`)
              : tokenGasMaxAdjustmentSentence(quote, (v) =>
                  quote.token
                    ? `${exact(v, quote.token.decimals)} ${quote.token.symbol}`
                    : `${exact(v, nativeDecimals)} ${evmChain.displaySymbol}`,
                )}
          </WarningBox>
        ) : null}
        {quote.passkey ? (
          <Row
            label="Signer"
            value="This phone's passkey (platform prompt follows)"
            sub={`An additional signer on this smart account; your recovery phrase is not used. Owner account: ${fromName}`}
            theme={theme}
          />
        ) : (
          <Row
            label="Owner account (signs)"
            value={fromName}
            sub={quotedFrom}
            theme={theme}
          />
        )}
        <Row
          label={aaSenderLabel(quote)}
          value={quote.sender}
          mono
          theme={theme}
        />
        <Row
          label={`Smart account ${evmChain.displaySymbol} balance`}
          value={`${exact(quote.senderBalance, nativeDecimals)} ${evmChain.displaySymbol}`}
          theme={theme}
        />
        {quote.eip7702 ? (
          <Eip7702QuoteNotice eip7702={quote.eip7702} noun="send" />
        ) : (
          <Row
            label="Deployment"
            value={quote.deployed ? 'Already deployed' : 'Will deploy with this send'}
            theme={theme}
          />
        )}
        {!quote.deployed && quote.accountType === 'kernel-v3.3' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {kernelDeploymentNote(aaConfig?.bundlerUrl ?? null)}
          </Text>
        ) : null}
        {quote.tokenGas ? (
          <>
            <Row
              label={`Network fee (paid in ${quote.tokenGas.symbol})`}
              value={
                `up to ${exact(quote.tokenGas.maxTokenCharge, quote.tokenGas.decimals)} ${quote.tokenGas.symbol}`
              }
              theme={theme}
            />
            <Text style={[styles.hint, { color: theme.text }]}>
              {tokenGasFeeSentence(
                exact(quote.tokenGas.maxTokenCharge, quote.tokenGas.decimals),
                quote.tokenGas.symbol,
              )}
            </Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              {tokenGasWorstCaseHint(quote.tokenGas, quote.maxFeePerGas)}
            </Text>
            <Row
              label="Rate"
              value={tokenGasRateSentence(
                quote.tokenGas.nativeTokenPrice,
                quote.tokenGas.decimals,
                evmChain.displaySymbol,
                quote.tokenGas.symbol,
              )}
              sub={tokenGasOracleNote(evmChain.caip2)}
              theme={theme}
            />
            <Row
              label="Paymaster fee spread"
              value={tokenGasSpreadText(quote.tokenGas.feeSpreadBips)}
              sub={TOKEN_GAS_SPREAD_NOTE}
              theme={theme}
            />
            <Row label="Paymaster (Circle)" value={quote.tokenGas.paymaster} mono theme={theme} />
            <Row
              label={`Smart account ${quote.tokenGas.symbol} balance`}
              value={
                `${exact(quote.tokenGas.tokenBalance, quote.tokenGas.decimals)} ${quote.tokenGas.symbol}`
              }
              theme={theme}
            />
            <WarningBox>
              {tokenGasGrantSentence(
                exact(quote.tokenGas.maxTokenCharge, quote.tokenGas.decimals),
                quote.tokenGas.symbol,
              )}
            </WarningBox>
            {quote.token && quote.token.contract.toLowerCase() === quote.tokenGas.token.toLowerCase() ? (
              <Row
                label={`Total ${quote.tokenGas.symbol} (worst case)`}
                value={
                  `${exact(quote.token.amount + quote.tokenGas.maxTokenCharge, quote.tokenGas.decimals)} ${quote.tokenGas.symbol}`
                }
                theme={theme}
              />
            ) : !quote.token ? (
              <Row
                label={`Total ${evmChain.displaySymbol}`}
                value={`${exact(quote.total, nativeDecimals)} ${evmChain.displaySymbol}`}
                sub={fiatOf(nativePriceId, quote.total, nativeDecimals)}
                theme={theme}
              />
            ) : null}
          </>
        ) : (
          <>
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
          </>
        )}

        <BalanceChangePreview
          url={confirmUrl}
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
          url={confirmUrl}
          wallet={quote.sender}
          to={quote.calls[0]!.to}
          data={quote.calls[0]!.data}
        />
        <SpendingPolicyNotice owner={quotedFrom} quote={quote} from={quotedFrom} />
        {quote.tokenGas ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{TOKEN_GAS_ESTIMATE_AFTER_APPROVAL}</Text>
        ) : (
          <Text style={[styles.simulationOk, { color: theme.success }]}>
            Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).
          </Text>
        )}

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
              title={
                quote.passkey
                  ? `Sign with passkey and send ${quote.token ? quote.token.symbol : symbol}`
                  : `Send ${quote.token ? quote.token.symbol : symbol} from smart account`
              }
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

        <Row label="From account" value={fromName} sub={quotedFrom} theme={theme} />
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
          label={`Max network fee (paid in ${evmChain.displaySymbol})`}
          value={`${exact(quote.fee, nativeDecimals)} ${evmChain.displaySymbol}`}
          sub={fiatOf(nativePriceId, quote.fee, nativeDecimals)}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Worst case at {exact(quote.maxFeePerGas, 9)} gwei max fee ×{' '}
          {quote.gasLimit.toString()} gas
          {quote.opStack ? ', plus the layer 1 data fee below' : ''}; the actual fee is usually lower,
          and the unused part is not charged. The fee comes out of your{' '}
          {evmChain.displaySymbol} balance — the full token amount reaches the recipient.
          {quote.gasIsFallback
            ? ' Gas estimation failed, so a conservative default gas limit is shown.'
            : ''}
        </Text>
        <OpStackFeeRows fees={quote.opStack} symbol={evmChain.displaySymbol} theme={theme} />
        <Row
          label={`${quote.symbol} balance`}
          value={`${exact(quote.tokenBalance, quote.decimals)} ${quote.symbol}`}
          theme={theme}
        />
        <Row
          label={`${evmChain.displaySymbol} balance`}
          value={`${exact(quote.ethBalance, nativeDecimals)} ${evmChain.displaySymbol}`}
          theme={theme}
        />

        <BalanceChangePreview
          url={confirmUrl}
          request={{ from: account.address, to: quote.contract, value: 0n, data: quote.data }}
        />
        <RiskWarnings
          url={confirmUrl}
          wallet={account.address}
          to={quote.contract}
          counterparty={quote.to}
          data={quote.data}
        />
        <SpendingPolicyNotice owner={quotedFrom} quote={quote} from={quotedFrom} />

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

        <Row label="From account" value={fromName} sub={quotedFrom} theme={theme} />
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
          {quote.gasLimit.toString()} gas
          {quote.opStack ? ', plus the layer 1 data fee below' : ''}; the actual fee is usually lower,
          and the unused part is not charged. Sent with safeTransferFrom: if
          the recipient is a contract that cannot accept NFTs, the transfer
          reverts instead of locking the NFT away.
          {quote.gasIsFallback
            ? ' Gas estimation failed, so a conservative default gas limit is shown.'
            : ''}
        </Text>
        <OpStackFeeRows fees={quote.opStack} symbol={evmChain.displaySymbol} theme={theme} />
        <Row
          label={`${evmChain.displaySymbol} balance`}
          value={`${exact(quote.ethBalance, nativeDecimals)} ${evmChain.displaySymbol}`}
          theme={theme}
        />

        <BalanceChangePreview
          url={confirmUrl}
          request={{ from: account.address, to: quote.contract, value: 0n, data: quote.data }}
        />
        <RiskWarnings
          url={confirmUrl}
          wallet={account.address}
          to={quote.contract}
          counterparty={quote.to}
          data={quote.data}
        />
        <SpendingPolicyNotice owner={quotedFrom} quote={quote} from={quotedFrom} />

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

        <Row label="From account" value={fromName} sub={quotedFrom} theme={theme} />
        <Row label="To" value={quote.to} mono theme={theme} />
        <RecipientContactNotice match={contactMatchFor(quote.to)} address={quote.to} />
        <Row
          label="Amount"
          value={`${exact(quote.amount, decimals)} ${symbol}`}
          sub={fiatOf(nativePriceId, quote.amount, decimals)}
          theme={theme}
        />
        {quote.kind === 'evm' && quote.maxAdjustment ? (
          <WarningBox>{maxAdjustmentSentence(quote, (v) => `${exact(v, decimals)} ${symbol}`)}</WarningBox>
        ) : null}
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
            {quote.gasLimit.toString()} gas
            {quote.opStack ? ', plus the layer 1 data fee below' : ''}; the actual fee is usually lower,
            and the unused part is not charged.
          </Text>
        ) : null}
        {quote.kind === 'evm' ? (
          <OpStackFeeRows fees={quote.opStack} symbol={symbol} theme={theme} />
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
            url={confirmUrl}
            request={{ from: account.address, to: quote.to, value: quote.amount, data: quote.data }}
          />
        ) : null}
        {quote.kind === 'evm' ? (
          <RiskWarnings url={confirmUrl} wallet={account.address} to={quote.to} data={quote.data} />
        ) : null}
        {quote.kind === 'evm' ? <SpendingPolicyNotice owner={quotedFrom} quote={quote} from={quotedFrom} /> : null}

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
      <Text style={[styles.networkLine, { color: testnet ? theme.testnetFill : theme.textMuted }]}>
        {network ? `${network.label} · ${testnet ? 'TESTNET' : 'Mainnet'}` : 'Unknown network'}{' '}
        · from {activeAccount ? `${activeAccount.name} ` : ''}({account.address.slice(0, 10)}…)
      </Text>

      <OfflineNotice />

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
            {aaActive ? ' your smart account' : ` your address on ${evmChain.label}`}. The network
            fee is paid in {evmChain.displaySymbol}, not in {token.symbol}.
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
            <Switch
              accessibilityLabel="Send from smart account"
              value={aaEnabled}
              onValueChange={setAaEnabled}
              disabled={!url}
            />
            <Text style={[styles.overrideLabel, { color: theme.text }]}>
              Send from smart account
            </Text>
            <View style={[styles.aaTag, { borderColor: theme.accent }]}>
              <Text style={[styles.aaTagText, { color: theme.accent }]}>EXPERIMENTAL</Text>
            </View>
          </View>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {aaType === 'kernel-7702'
              ? 'Sends as an ERC-4337 UserOperation from this account itself, upgraded with ' +
                'EIP-7702 to Kernel v3.3 (same address), through the bundler configured in ' +
                'Settings. It pays the amount and its gas from its own balance unless a ' +
                'paymaster sponsors the gas.' +
                (delegation.status?.kind === 'plain'
                  ? ' This account is not upgraded yet: the first such send carries the upgrade, ' +
                    'and the confirm screen says so.'
                  : '')
              : `Sends as an ERC-4337 UserOperation from your smart account (${
                  aaType ? aaAccountTypeLabel(aaType) : 'smart account'
                }) — a separate address controlled by this account\u2019s key — through the ` +
                'bundler configured in Settings. The smart account pays the amount' +
                (token ? ` (its own ${token.symbol})` : '') +
                ' and its gas from its own balance unless a paymaster sponsors the gas, so fund ' +
                'the smart account address first. Max uses the smart account\u2019s balance.'}
          </Text>
          {aaAddressInfo ? (
            <>
              <Row
                label={`${smartAccountAddressLabel(aaAddressInfo)} address`}
                value={aaAddressInfo.address}
                sub={smartAccountDeploymentNote(aaAddressInfo.deployed)}
                mono
                theme={theme}
              />
              <Button
                title={aaAddressCopied ? 'Copied \u2713' : 'Copy smart-account address'}
                variant="secondary"
                onPress={async () => {
                  await Clipboard.setStringAsync(aaAddressInfo.address);
                  setAaAddressCopied(true);
                }}
              />
              {aaAddressCopied ? (
                <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.textMuted }]}>
                  Copied {'\u2014'} note that the clipboard can be read by other apps.
                </Text>
              ) : null}
            </>
          ) : aaAddressView?.error ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              The smart-account address could not be read: {aaAddressView.error}
            </Text>
          ) : null}
        </View>
      ) : null}

      {aaActive && tokenGasOfferNow ? (
        <View
          style={[styles.aaToggleBox, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          {tokenGasOfferNow.kind === 'unavailable' ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>{tokenGasOfferNow.reason}</Text>
          ) : tokenGasCheck === null ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              Checking Circle{'\u2019'}s token paymaster on-chain before offering to pay the network fee in USDC…
            </Text>
          ) : !tokenGasCheck.ok ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>{tokenGasCheck.reason}</Text>
          ) : (
            <>
              <View style={styles.overrideRow}>
                <Switch
                  accessibilityLabel="Pay the network fee in USDC"
                  value={feeInUsdc}
                  onValueChange={(v) => {
                    // A Max figure from one fee mode must not be trimmed by the other.
                    lastAaMax.current = null;
                    lastTokenGasMax.current = null;
                    setFeeInUsdc(v);
                  }}
                  disabled={!url}
                />
                <Text style={[styles.overrideLabel, { color: theme.text }]}>Pay the network fee in USDC</Text>
              </View>
              <Text style={[styles.hint, { color: theme.textMuted }]}>{TOKEN_GAS_CHOICE_HINT}</Text>
            </>
          )}
        </View>
      ) : null}

      {aaActive && passkeyRecord ? (
        <View
          style={[styles.aaToggleBox, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <View style={styles.overrideRow}>
            <Switch
              accessibilityLabel="Sign with passkey"
              value={passkeySigner}
              onValueChange={setPasskeySigner}
              disabled={!url}
            />
            <Text style={[styles.overrideLabel, { color: theme.text }]}>Sign with passkey</Text>
          </View>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Signs with this phone{'\u2019'}s passkey instead of your account key. The smart account (the
            sender) and its address stay the same, and it pays the gas from its own balance as
            usual. Off by default; the account key signs otherwise.
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
          accessibilityLabel="Recipient address"
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
      !(route.params.chainId === EVM_CHAIN_ID && findOwnAddress(validation.normalized, ownAddresses)) &&
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
              accessibilityLabel={nft ? 'Number of copies' : `Amount in ${symbol}`}
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
        <Text accessibilityLiveRegion="polite" style={[styles.fieldError, { color: theme.danger }]}>
          {formError}
        </Text>
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

/**
 * OP-stack fee lines (Base Sepolia; send.ts quoteOpStackFees): the layer 1
 * data fee reserve and, when the chain charges one, the operator fee. Both
 * are already part of the max fee and total shown on the same screen.
 * Renders nothing on chains without them, so Ethereum mainnet and Sepolia
 * confirm screens are unchanged.
 */
function OpStackFeeRows({
  fees,
  symbol,
  theme,
}: {
  fees: OpStackFees | undefined;
  symbol: string;
  theme: ReturnType<typeof useTheme>;
}) {
  if (!fees) return null;
  return (
    <>
      <Row label="Layer 1 data fee (estimate)" value={`${exact(fees.l1DataFee, 18)} ${symbol}`} theme={theme} />
      {fees.operatorFee > 0n ? (
        <Row label="Operator fee (worst case)" value={`${exact(fees.operatorFee, 18)} ${symbol}`} theme={theme} />
      ) : null}
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        This is a layer-2 network: every transaction also pays for publishing
        its data on Ethereum. The network&apos;s fee oracle estimates{' '}
        {exact(fees.l1DataFeeEstimate, 18)} {symbol} for this transaction;{' '}
        {L1_DATA_FEE_HEADROOM_PERCENT.toString()}% more is reserved because
        this fee follows Ethereum&apos;s fees and cannot be capped. It is
        included in the max network fee and the total.
      </Text>
    </>
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
        // "—" is a visual placeholder; screen readers hear "not available".
        {...(value === '—' ? { accessibilityLabel: 'not available' } : {})}
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

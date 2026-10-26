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
import { Button, ImportedKeyNotice, WarningBox, screenStyle, switchColors, useFieldLabels } from '../components';
import { T } from '../i18n/T';
import { localize, t, tx } from '../i18n/index';
import { useI18n } from '../i18n/useI18n';
import { IMPORTED_KEY_NO_CHAIN } from '../wallet/account-ids';
import {
  callWithFailover,
  getEndpoint,
  withEndpoint,
  type NetworkEndpoint,
  type UsableEndpoint,
} from '../config/networks';
import { useTheme, type Theme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { usePrefs } from '../wallet/PrefsContext';
import { requireLocalAuth } from '../wallet/biometric';
import { parseUnits } from '../wallet/balances';
import {
  BITCOIN_CHAIN_ID,
  EVM_CHAIN_ID,
  MINIMUM_FEE_REHEARSAL_WARNING,
  QUOTE_ENDPOINT_CHANGED_TITLE,
  consumeMinimumFeeRehearsal,
  describeSendError,
  minimumFeeRehearsalArmed,
  minimumFeeRehearsalFeeLine,
  minimumFeeRehearsalOf,
  repriceTokenQuoteAtMinimumFee,
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
import { isBroadcastOutcomeUnknown } from '../wallet/broadcast-outcome';
import {
  AA_SELF_PAID_FEE_SENTENCE,
  aaAccountTypeLabel,
  aaMaxAdjustmentSentence,
  checkAaQuoteBeforeApproval,
  aaPreviewNote,
  aaRiskWarningTarget,
  aaSenderLabel,
  exactAmountText,
  sendApprovalPromptTitle,
  sendFormTokenFeeSentence,
  tokenGasThroughPhrase,
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
  TOKEN_GAS_SYMBOL,
  checkTokenGasPaymaster,
  describeTokenGasError,
  erc7677CheckingSentence,
  erc7677ChoiceHint,
  maxAaTokenGasErc20Send,
  maxAaTokenGasSend,
  prepareAaTokenGasErc20Send,
  prepareAaTokenGasSend,
  tokenGasChargeFromReceipt,
  tokenGasChargedLine,
  tokenGasConfirmLines,
  tokenGasMaxAdjustmentSentence,
  tokenGasOffer,
  tokenGasSourceFor,
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
import {
  describeParsedRequest,
  foreignPaymentFamily,
  foreignPaymentRequestSentence,
  isPaymentUriFor,
  parsePaymentRequest,
} from '../wallet/payment-request';
import {
  NAME_NOT_USABLE_SENTENCE,
  describeNameError,
  ensPrivacyNote,
  ensRegistryFor,
  formErrorBesideName,
  localNameRefusal,
  looksLikeName,
  lookUpRecipientName,
  recheckRecipientName,
  resolvedNameLine,
  SEND_RECIPIENT_NAMES_HINT,
  sendRecipientPlaceholder,
} from '../wallet/ens-names';
import { simulationTransport } from '../wallet/simulation';
import {
  EnsNameStatus,
  PaymentRequestNotice,
  type EnsNameView,
} from '../components/PaymentRequestViews';
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
import { useAccountDelegation } from '../wallet/useDelegation';
import { delegationLabelSuffix, invalidateAccountDelegation } from '../wallet/delegation';
import { Eip7702QuoteNotice } from '../components/DelegationViews';
import { AaDepositNote } from '../components/AaDepositNote';
import { usePrices } from '../wallet/usePrices';
import { fiatLine, formatFiat, nativePriceAssetId, tokenPriceAssetId } from '../wallet/prices';
import { BITCOIN, DOGECOIN } from '@shiba-wallet/chains-utxo';
import { usePasskeyInfo } from '../wallet/usePasskeyInfo';
import { NOTE_VIEW_SCROLL_PROPS, TransactionNoteField, dismissKeyboardThenClose } from '../components/TransactionNoteField';
import { OfflineNotice, TechnicalDetail } from '../wallet/connectivity';
import { PendingTransactionsSection } from '../components/PendingTransactions';
import { recordPendingUserOperation, userOpResendFor } from '../wallet/pending-transactions';
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

/**
 * Full-precision base-unit display (never truncates a payment amount). The
 * biometric prompt (sendApprovalPromptTitle) uses the same function, so the
 * confirm's Amount row and the prompt always show the same figure.
 */
function exact(amount: bigint, decimals: number): string {
  return exactAmountText(amount, decimals);
}

/**
 * The confirm-screen network badge. Mainnet keeps the red "real funds"
 * warning; in Sepolia test mode (EVM only) an orange TESTNET badge
 * replaces it, per phase 4 item 6.
 */
function NetworkBadge({ label, testnet, theme }: { label: string; testnet: boolean; theme: Theme }) {
  useI18n();
  if (testnet) {
    return (
      <View style={[styles.mainnetBadge, { backgroundColor: theme.testnetFill, borderColor: theme.testnetFill }]}>
        <Text style={[styles.mainnetBadgeText, { color: theme.onTestnetFill }]}>
          {t('send.badge.testnet', { label })}
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
        {t('send.badge.mainnet', { label })}
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
  // Localisation (phase 22 item 6): the form and the confirm screens follow the language.
  const { language } = useI18n();
  const field = useFieldLabels();
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
  // A payment request that switched this screen between the native coin and
  // a token (navigation.replace) arrives as route.params.request; its values
  // only pre-fill the editable fields.
  const [recipient, setRecipient] = useState(route.params.request?.recipient ?? '');
  const [amountText, setAmountText] = useState(route.params.request?.amountText ?? '');
  // The "Payment request" box (lines describing what the request asked
  // for), and a refusal sentence when a scanned or pasted request was
  // refused (nothing is filled in then).
  const [requestLines, setRequestLines] = useState<string[] | null>(route.params.request?.lines ?? null);
  const [requestError, setRequestError] = useState<string | null>(null);
  // ENS (phase 14 item 2): the lookup result for the name in the recipient
  // field, keyed by network and name; the name the confirm screen shows.
  const [nameState, setNameState] = useState<{ key: string; view: EnsNameView; url: string | null } | null>(null);
  const [quotedName, setQuotedName] = useState<{ name: string; address: string; registryLabel: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // The technical line under a quote failure (finding 3 of the phase 14
  // emulator pass): shown only while the form error it belongs to is the one
  // on screen, so every existing setFormError(null) also hides it.
  const [formTechnical, setFormTechnical] = useState<{ forError: string; text: string } | null>(null);
  const showQuoteFailure = (described: { title: string; detail: string; technical?: string }) => {
    const message = `${described.title}\n${described.detail}`;
    setFormError(message);
    setFormTechnical(described.technical ? { forError: message, text: described.technical } : null);
  };
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
     * USDC-fee sends only: the charge read from the paymaster's
     * UserOperationSponsored event (Circle's or Pimlico's, matched by
     * tokenGasChargeFromReceipt) once the receipt arrived (null when the
     * receipt had no such event; undefined for every other send).
     */
    tokenGasCharge?: bigint | null;
  } | null>(null);
  // Pay the network fee in USDC (phase 13 item 2, ../wallet/token-gas.ts):
  // the user's choice on the form; it takes effect only where the choice is
  // offered and its source (Circle's paymaster, or the ERC-7677 paymaster
  // on Ethereum Sepolia) passed its check. ETH is the default.
  const [feeInUsdc, setFeeInUsdc] = useState(false);
  // The Max record for the USDC-fee path, kept apart from the ETH-fee one so
  // a Max figure from one fee mode is never trimmed by the other.
  const lastTokenGasMax = useRef<LastMaxResult | null>(null);

  useEffect(() => {
    const title = token
      ? t('home.token.send', { symbol: token.symbol })
      : nftMode
        ? tx('Send NFT')
        : account
          ? t('home.token.send', { symbol: account.symbol })
          : tx('Send');
    navigation.setOptions({ title });
  }, [navigation, account, token, nftMode, language]);

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

  // A name in the EVM recipient field (anything with a dot that does not
  // start with 0x; ../wallet/ens-names.ts) is looked up, never sent to: the
  // resolved address is what the validation below, the contact and
  // own-account checks, the risk card and the quote all see.
  const nameKey =
    route.params.chainId === EVM_CHAIN_ID && looksLikeName(recipient)
      ? `${evmChain.caip2}|${recipient.trim()}`
      : null;
  // A name refused without any request (outside the supported characters,
  // or a network where names are not looked up) is shown at once, with no
  // "Looking up…" and no privacy line, because nothing goes out.
  const nameLocalRefusal = nameKey ? localNameRefusal(recipient.trim(), evmChain) : null;
  const nameView: EnsNameView | null = nameKey
    ? nameLocalRefusal !== null
      ? { status: 'refused', name: recipient.trim(), message: nameLocalRefusal }
      : nameState && nameState.key === nameKey
        ? nameState.view
        : { status: 'resolving', name: recipient.trim() }
    : null;
  const nameRegistry = ensRegistryFor(evmChain);
  // ENS names are offered in the recipient field only on the EVM slot of a
  // profile whose registry answers (Ethereum mainnet and Sepolia); on Base
  // Sepolia and Arbitrum Sepolia the placeholder does not mention names.
  const namesOffered = route.params.chainId === EVM_CHAIN_ID && nameRegistry.ok;
  useEffect(() => {
    if (!nameKey || nameLocalRefusal !== null) return;
    const input = nameKey.slice(nameKey.indexOf('|') + 1);
    let cancelled = false;
    // A short pause so a name is looked up once typing stops, not per key.
    const timer = setTimeout(() => {
      withEndpoint(EVM_CHAIN_ID, (ep) => lookUpRecipientName(simulationTransport(ep.url), input, evmChain)).then(
        (outcome) => {
          if (cancelled) return;
          const found = outcome.value;
          setNameState({
            key: nameKey,
            url: outcome.endpoint.url,
            view:
              found.kind === 'resolved'
                ? {
                    status: 'resolved',
                    name: found.resolution.name,
                    address: found.resolution.address,
                    registryLabel: found.registryLabel,
                  }
                : { status: 'refused', name: input, message: found.message },
          });
        },
        (e: unknown) => {
          if (cancelled) return;
          setNameState({
            key: nameKey,
            url: null,
            view: { status: 'refused', name: input, message: describeNameError(e, input, '') },
          });
        },
      );
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [nameKey, nameLocalRefusal, evmChain]);
  const nameResolvedAddress = nameView?.status === 'resolved' ? nameView.address : null;
  // The form error line never repeats the name panel's refusal (shown just
  // above it), e.g. after a Review-time re-check refused the name.
  const shownFormError = formErrorBesideName(formError, nameView?.status === 'refused' ? nameView.message : null);

  const validation = useMemo(() => {
    if (nameKey) {
      return nameResolvedAddress ? validateRecipient(route.params.chainId, nameResolvedAddress) : null;
    }
    return recipient.trim() ? validateRecipient(route.params.chainId, recipient) : null;
  }, [route.params.chainId, recipient, nameKey, nameResolvedAddress]);

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

  // The USDC-fee source, checked against the ACTIVE endpoint before the
  // choice is shown (cached briefly by checkTokenGasPaymaster): Circle's
  // paymaster on-chain where it exists, else the ERC-7677 source (Pimlico's
  // paymaster, on-chain plus a stub request to the saved bundler). This
  // screen renders tokenGasConfirmLines, so it accepts the ERC-7677 source.
  // Only on a network that has a verified source, and only while the
  // smart-account toggle is on; the state carries the key it was read for,
  // which includes the saved bundler because the ERC-7677 check asks it.
  const aaBundlerUrl = aaConfig?.bundlerUrl ?? null;
  const tokenGasCheckKey =
    aaEnabled && !nftMode && aaConfig && aaOwner && aaNodeUrl &&
    tokenGasSourceFor(evmChain.caip2, { acceptsErc7677: true })
      ? `${evmChain.caip2}|${aaNodeUrl}|${aaBundlerUrl ?? ''}`
      : null;
  const [tokenGasCheckState, setTokenGasCheckState] = useState<{ key: string; result: TokenGasCheck } | null>(null);
  useEffect(() => {
    if (!tokenGasCheckKey || !aaNodeUrl) return;
    let cancelled = false;
    checkTokenGasPaymaster(aaNodeUrl, evmChain.caip2, { acceptsErc7677: true, bundlerUrl: aaBundlerUrl }).then(
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
  }, [tokenGasCheckKey, aaNodeUrl, evmChain.caip2, aaBundlerUrl]);
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
  /**
   * Confirm-screen line for a recipient entered as an ENS name: the name,
   * the registry that answered and the full address it resolved to (shown
   * only when that address is exactly the quote's recipient).
   */
  const renderNameNote = (to: string) =>
    quotedName && quotedName.address.toLowerCase() === to.toLowerCase() ? (
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        {resolvedNameLine(
          { name: quotedName.name, address: quotedName.address },
          quotedName.registryLabel,
        )}
      </Text>
    ) : null;

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
        <Text style={{ color: theme.textMuted }}>
          {activeAccount?.imported ? localize(IMPORTED_KEY_NO_CHAIN) : tx('Unknown chain.')}
        </Text>
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
          {t('send.token.notTracked', { network: evmChain.label })}
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
          <T>
          This token belongs to another network. Switch networks under
          Settings → Developer to send it.
          </T>
        </Text>
      </View>
    );
  }

  if (nftMode && nftTarget === 'invalid') {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted, textAlign: 'center', padding: 24 }}>
          <T>This NFT reference is not valid. Go back to the NFTs screen and try again.</T>
        </Text>
      </View>
    );
  }
  if (nft && nft.chainId !== evmChain.caip2) {
    // The NFT was listed in the other network mode; never quote it here.
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={{ color: theme.textMuted, textAlign: 'center', padding: 24 }}>
          <T>
          This NFT belongs to the other network mode. Switch Sepolia test
          mode in Settings → Developer to send it.
          </T>
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
  // The form's visible labels, tied to their fields for screen readers
  // (pass p20c finding 1; components.tsx useFieldLabels).
  const recipientField = field(
    'recipient',
    'Recipient',
    namesOffered ? SEND_RECIPIENT_NAMES_HINT : undefined,
  );
  const amountField = field(
    'amount',
    nft
      ? t('send.field.copies', { held: hideAmounts ? '••••' : nft.indexedBalance.toString() })
      : t('send.field.amount', { symbol }),
  );
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
  const describeError = (e: unknown, minimumFeeRehearsal = false) =>
    nftMode
      ? describeNftSendError(e, evmChain.displaySymbol)
      : describeSendError(e, symbol, evmChain.displaySymbol, { minimumFeeRehearsal });
  const aaActive = aaAvailable && aaEnabled;
  // The passkey signs only for a Kernel v3.3 smart account (not SimpleAccount,
  // not an EIP-7702 upgrade) whose passkey this device installed.
  const passkeyRecord = aaType === 'kernel-v3.3' ? passkeyInfo.record : null;
  const passkeyActive = aaActive && passkeySigner && passkeyRecord !== null;
  // Pay the network fee in USDC: offered by configuration (tokenGasOffer),
  // then shown only once the source passed its check (Circle's paymaster
  // on-chain, or the ERC-7677 paymaster on-chain plus the bundler), and
  // used only when the user turned it on. Never together with the passkey
  // signer (tokenGasOffer refuses that combination).
  const tokenGasOfferNow = aaActive
    ? tokenGasOffer({
        chainCaip2: evmChain.caip2,
        config: aaConfig,
        owner: account.address,
        passkeySigner: passkeyActive,
        acceptsErc7677: true,
      })
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
            max = await maxAaTokenGasErc20Send(
              tbundle,
              account.address,
              {
                contract: token.assetId.reference,
                recipient: validation.normalized,
                symbol: token.symbol,
                decimals: token.decimals,
                chainCaip2: token.assetId.chainId,
              },
              { acceptsErc7677: true },
            );
            if (max <= 0n) {
              throw new Error(`The smart account's ${token.symbol} balance cannot cover the amount and the network fee.`);
            }
          } else {
            max = await maxAaTokenGasSend(tbundle, account.address, { acceptsErc7677: true });
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
      showQuoteFailure(
        retitleQuoteFailure(
          (tokenGasActive ? describeTokenGasError(e) : null) ??
            (aaActive && aaType
              ? describeAaError(e, { accountType: aaType, deployed: null, bundlerUrl: aaConfig?.bundlerUrl ?? null })
              : null) ??
            describeError(e),
        ),
      );
    } finally {
      setMaxBusy(false);
    }
  };

  /**
   * A scanned or pasted payload that starts with THIS slot's payment-URI
   * scheme (../wallet/payment-request.ts). Returns false when it is not
   * one; the caller then refuses another family's request with one sentence
   * (foreignPaymentFamily) and leaves anything else to the normal address
   * validation. A refused request fills in
   * nothing and shows the reason. An accepted one fills the editable
   * recipient and amount fields; when it asks for a token while this
   * screen sends the native coin (or the other way round), the screen is
   * replaced by the matching mode with the same values. Nothing switches
   * the network and nothing adds a token: those requests are refused.
   */
  const handlePaymentPayload = async (data: string, scanned: boolean): Promise<boolean> => {
    if (!isPaymentUriFor(route.params.chainId, data)) return false;
    if (nftMode) {
      setRequestLines(null);
      setRequestError(
        'This is a payment request, which cannot fill in an NFT send. Open Send from the Home screen to pay it.',
      );
      return true;
    }
    const isEvm = route.params.chainId === EVM_CHAIN_ID;
    const tracked = isEvm ? await listTokens(evmChain.caip2).catch(() => []) : [];
    const parsed = parsePaymentRequest(data, {
      slotChainId: route.params.chainId,
      evmProfile: evmChain,
      trackedTokens: tracked,
    });
    if (parsed.kind === 'not-a-request') return false;
    setFormError(null);
    if (parsed.kind === 'refused') {
      setRequestLines(null);
      setRequestError(parsed.message);
      return true;
    }
    const lines = describeParsedRequest(parsed, {
      nativeSymbol: isEvm ? evmChain.displaySymbol : account.symbol,
      networkLabel: isEvm ? evmChain.label : account.name,
    });
    const wantedToken = parsed.token?.assetId ?? null;
    if (wantedToken !== (tokenId ?? null)) {
      navigation.replace('Send', {
        chainId: route.params.chainId,
        ...(wantedToken ? { tokenId: wantedToken } : {}),
        request: { recipient: parsed.recipient, amountText: parsed.amountText, lines },
      });
      return true;
    }
    lastEvmMax.current = null;
    lastAaMax.current = null;
    lastTokenGasMax.current = null;
    setRequestError(null);
    setRequestLines(lines);
    setRecipient(parsed.recipient);
    setAmountText(parsed.amountText ?? '');
    setScannedRecipient(scanned ? parsed.recipient : null);
    return true;
  };

  const onReview = async () => {
    if (!url || !network) return;
    setFormError(null);
    setQuotedName(null);
    // A name: it must have resolved (the full address is on screen), and it
    // is resolved again now; a different answer stops the review and shows
    // the new address instead (ens-names.ts recheckRecipientName).
    let reviewedName: { name: string; address: string; registryLabel: string } | null = null;
    if (nameKey) {
      if (!nameView || nameView.status !== 'resolved' || !nameRegistry.ok) {
        // The refusal itself is already under the recipient field; repeating
        // it here would show the same sentence twice.
        setFormError(
          nameView?.status === 'refused'
            ? NAME_NOT_USABLE_SENTENCE
            : 'Wait until the name has been looked up and its address is shown.',
        );
        return;
      }
      const shown = nameView;
      const registryChainId = nameRegistry.chainId;
      setPhase('quoting');
      try {
        const { value: recheck } = await withEndpoint(EVM_CHAIN_ID, (ep) =>
          recheckRecipientName(
            simulationTransport(ep.url),
            { name: shown.name, address: shown.address, chainId: registryChainId },
            shown.registryLabel,
          ),
        );
        if (recheck.kind !== 'same') {
          setNameState({
            key: nameKey,
            url: nameState?.url ?? null,
            view:
              recheck.kind === 'changed'
                ? {
                    status: 'resolved',
                    name: recheck.resolution.name,
                    address: recheck.resolution.address,
                    registryLabel: shown.registryLabel,
                  }
                : { status: 'refused', name: shown.name, message: recheck.message },
          });
          setFormError(recheck.message);
          setPhase('form');
          return;
        }
      } catch (e) {
        setFormError(describeNameError(e, shown.name, shown.registryLabel));
        setPhase('form');
        return;
      }
      // Back to the form state; the quote below sets 'quoting' again.
      setPhase('form');
      reviewedName = { name: shown.name, address: shown.address, registryLabel: shown.registryLabel };
    }
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
          // Network fee in USDC. Circle's paymaster is quoted WITHOUT a
          // bundler estimate (the estimation stub needs a permit signed by
          // the account, so estimation runs after the biometric gate); the
          // ERC-7677 source (Pimlico's paymaster) needs no permit, so its
          // quote runs the stub and the bundler estimate now. Either way the
          // confirm shows the worst case, which caps what can be charged.
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
                { fromMax: tgFromMax, acceptsErc7677: true },
              )
            : await prepareAaTokenGasSend(tbundle, account.address, validation.normalized, amount, {
                fromMax: tgFromMax,
                acceptsErc7677: true,
              });
          setQuotedName(reviewedName);
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
          setQuotedName(reviewedName);
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
        // Settings → Developer's minimum-fee rehearsal (test networks only,
        // one-shot): the token quote is re-priced at a max fee and a priority
        // fee of 1 wei, below the base fee (send.ts repriceTokenQuoteAtMinimumFee,
        // which returns the quote unchanged on any other network).
        const rehearse = minimumFeeRehearsalArmed(evmChain.caip2);
        const quoted = await viaFailover(start, async (ep) => {
          const tokenQuote = await prepareErc20Send({
            url: ep.url,
            from: account.address,
            to: recipientAddress,
            contract: token.assetId.reference,
            amount,
            symbol: token.symbol,
            decimals: token.decimals,
            chainCaip2: token.assetId.chainId,
          });
          return rehearse
            ? repriceTokenQuoteAtMinimumFee(ep.url, tokenQuote, { to: tokenQuote.contract, value: 0n, data: tokenQuote.data })
            : tokenQuote;
        });
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
        // minimumFee: Settings → Developer's one-shot rehearsal (prepareEvmSend
        // honours it only on a verified test network).
        const minimumFee = minimumFeeRehearsalArmed(evmChain.caip2);
        const quoted = await viaFailover(start, (ep) =>
          prepareEvmSend(ep.url, account.address, recipientAddress, amount, undefined, evmChain.caip2, {
            fromMax,
            ...(minimumFee ? { minimumFee } : {}),
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
      setQuotedName(reviewedName);
      setQuote(next);
      setQuotedFrom(account.address);
      setQuotedUrl(quoteUrl);
      setOverrideSimulation(false);
      setPhase('confirm');
    } catch (e) {
      // Nothing has been signed or sent while a quote is prepared: the
      // generic failure title says so (retitleQuoteFailure).
      showQuoteFailure(
        retitleQuoteFailure(
          (tokenGasActive ? describeTokenGasError(e) : null) ??
            (aaActive && aaType
              ? describeAaError(e, { accountType: aaType, deployed: null, bundlerUrl: aaConfig?.bundlerUrl ?? null })
              : null) ??
            describeError(e),
        ),
      );
      setPhase('form');
    }
  };

  // Smart-account operations accepted by the bundler are remembered on this
  // phone (feature 95, wallet/pending-transactions.ts) so Activity can show
  // them while they wait, check their status and, once the bundler has
  // dropped one, offer "Send again". Best effort; never blocks the send.
  // The sendAa path records through the listener WalletContext registers
  // (aa.ts notifyAaOperationSent, with this pre-fill in sendAa's meta); the
  // passkey path does not go through sendAa and records here.
  const resendFor = (q: AaSendQuote) =>
    userOpResendFor(q, {
      nativeSymbol: evmChain.displaySymbol,
      nativeDecimals,
      tokenId: tokenId ?? null,
      nft: nftMode,
    });
  const rememberUserOperation = (q: AaSendQuote, userOpHash: string) => {
    if (!quotedFrom) return;
    void recordPendingUserOperation({
      chain: evmChain.caip2,
      userOpHash,
      sender: q.sender,
      owner: quotedFrom,
      resend: resendFor(q),
      origin: 'send',
    });
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
    if (quote.kind === 'aa') {
      // The bundler's fee floor is re-read BEFORE any device check or
      // passkey prompt (aa.ts checkAaQuoteBeforeApproval): when it rose
      // above the reviewed fees, the user is told so and Review quotes
      // again at once, without having approved anything. sendAa and
      // sendPasskeyCalls repeat the check at send time.
      const preBundle = aaBundle.current;
      if (preBundle) {
        try {
          await checkAaQuoteBeforeApproval(preBundle.bundler, quote);
        } catch (e) {
          const { title, detail } =
            describeAaError(e, {
              accountType: quote.accountType,
              deployed: quote.deployed,
              sender: quote.sender,
              bundlerUrl: aaConfig?.bundlerUrl ?? null,
            }) ?? describeError(e);
          Alert.alert(title, detail);
          setQuote(null);
          setQuotedUrl(null);
          setPhase('form');
          void onReview();
          return;
        }
      }
    }
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
        const { userOpHash } = await sendPasskeyCalls(bundle, quote, {
          chain: evmChain.caip2,
          sender: quote.sender,
          owner: quotedFrom,
          bundler: bundle.bundler,
          kind: 'send',
          resend: resendFor(quote),
        });
        // The passkey path bypasses sendAa's listeners: record the accepted
        // operation for the spending limits here.
        void recordAcceptedSpend({
          scope: { chain: evmChain.caip2, owner: quotedFrom },
          ...spendingInputForQuote(quote, quotedFrom),
          ref: userOpHash,
        });
        setAaResult({ userOpHash, receiptState: 'pending', success: null, txHash: null });
        rememberUserOperation(quote, userOpHash);
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
        // A smart-account quote goes out at most once (aa.ts
        // claimQuoteForSubmission): back to the form, where Review quotes
        // again with fresh fees, instead of a confirm whose button would
        // re-send the old figures.
        setQuote(null);
        setQuotedUrl(null);
        setPhase('form');
      }
      return;
    }
    // Biometric gate (task 7): the final send confirmation requires local
    // authentication whenever the device has enrolled biometrics. The title
    // names the QUOTED amount, which is what gets signed: a Max amount the
    // quote lowered (maxAdjustment) differs from the form's text.
    const auth = await requireLocalAuth(
      // An NFT quote exists only in NFT mode (the EOA path), where the
      // route always carries the item's name; the token-id wording is a
      // type-level fallback only.
      quote.kind === 'nft'
        ? `Approve sending ${quote.standard === 'erc1155' ? `${quote.amount.toString()} × ` : ''}${nftParams?.name ?? `token ${quote.tokenId.toString()} of ${quote.contract}`}`
        : quote.kind === 'aa'
          ? sendApprovalPromptTitle(quote, evmChain.displaySymbol, nativeDecimals)
          : sendApprovalPromptTitle(quote, symbol, decimals),
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
          sendAa(bundle, signer, quote, { kind: 'send', resend: resendFor(quote) }),
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
            // USDC fee: the actual charge from the paymaster's event in the receipt.
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
      // One-shot: a minimum-fee rehearsal quote that was just sent turns the
      // Developer option off (a cancelled confirm never gets here).
      consumeMinimumFeeRehearsal(quote);
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
          : null) ?? describeError(e, minimumFeeRehearsalOf(quote) !== null);
      Alert.alert(title, detail);
      if (quote.kind === 'aa' || isBroadcastOutcomeUnknown(e)) {
        // The smart-account quote was used up by this attempt (a bundler
        // refusal, or the fee rose since the review): the retry must
        // re-quote, so return to the form rather than to a confirm whose
        // button would send the same figures again. The same for a regular
        // transaction whose broadcast got no answer in time (phase 23 item
        // 8): its quote is never broadcast again (send.ts broadcastRecorded)
        // and Activity's pending list says what happened.
        setQuote(null);
        setQuotedUrl(null);
        setPhase('form');
        return;
      }
      setPhase('confirm');
    }
  };

  const inputStyle = [
    styles.input,
    { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.card },
  ];

  // ------------------------------------------------ success (smart account)
  if (phase === 'success' && aaResult) {
    return (
      <ScrollView key="send-aa-success" style={screenStyle(theme)} contentContainerStyle={styles.content} {...NOTE_VIEW_SCROLL_PROPS}>
        <Text accessibilityRole="header" style={[styles.successTitle, { color: theme.success }]}><T>Sent to bundler ✓</T></Text>
        <Text style={[styles.label, { color: theme.textMuted }]}><T>UserOperation hash</T></Text>
        <View style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {aaResult.userOpHash}
          </Text>
        </View>
        {aaResult.receiptState === 'pending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              <T>Bundling… waiting for the UserOperation receipt.</T>
            </Text>
          </View>
        ) : null}
        {aaResult.receiptState === 'timeout' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            <T>
            No receipt yet. The operation may still be included — keep the
            UserOperation hash above to look it up later.
            </T>
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
                {aaResult.success === true ? tx('Included on-chain — succeeded.') : tx('Included on-chain.')}
              </Text>
            )}
            {quote?.kind === 'aa' && quote.tokenGas && aaResult.tokenGasCharge !== undefined ? (
              <Text style={[styles.hint, { color: theme.text }]}>
                {tokenGasChargedLine(quote.tokenGas, aaResult.tokenGasCharge)}
              </Text>
            ) : null}
            {aaResult.txHash ? (
              <>
                <Text style={[styles.label, { color: theme.textMuted }]}><T>Transaction</T></Text>
                <View
                  style={[styles.box, { backgroundColor: theme.card, borderColor: theme.border }]}
                >
                  <Text selectable style={[styles.monoText, { color: theme.text }]}>
                    {aaResult.txHash}
                  </Text>
                </View>
                {evmChain.explorerTxBase ? (
                  <Button
                    title="View on block explorer"
                    variant="secondary"
                    onPress={() =>
                      void Linking.openURL(`${evmChain.explorerTxBase}${aaResult.txHash}`)
                    }
                  />
                ) : null}
              </>
            ) : (
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                <T>
                The bundler&apos;s receipt did not include a recognizable
                transaction hash; look the UserOperation hash up in an
                ERC-4337 explorer you trust.
                </T>
              </Text>
            )}
          </>
        ) : null}
        {endpoint?.network.chainId ? (
          <TransactionNoteField
            network={endpoint.network.chainId}
            txid={aaResult.txHash}
            userOpHash={aaResult.userOpHash}
          />
        ) : null}
        {quote ? renderSuccessContact(quote.to) : null}
        <Button title="Done" onPress={() => dismissKeyboardThenClose(() => navigation.popToTop())} />
      </ScrollView>
    );
  }

  // -------------------------------------------------------------- success
  if (phase === 'success' && result) {
    return (
      <ScrollView key="send-success" style={screenStyle(theme)} contentContainerStyle={styles.content} {...NOTE_VIEW_SCROLL_PROPS}>
        <Text accessibilityRole="header" style={[styles.successTitle, { color: theme.success }]}><T>Sent ✓</T></Text>
        <Text style={[styles.label, { color: theme.textMuted }]}><T>Transaction id</T></Text>
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
            <T>
            No verified block explorer is configured for this chain; look the
            transaction id up in an explorer you trust.
            </T>
          </Text>
        )}
        {endpoint?.network.chainId ? (
          <TransactionNoteField network={endpoint.network.chainId} txid={result.txid} userOpHash={null} />
        ) : null}
        {/* While it waits to be included: Speed up and Cancel (feature 95). */}
        {quotedFrom && (quote?.kind === 'evm' || quote?.kind === 'erc20' || quote?.kind === 'nft') ? (
          <PendingTransactionsSection from={quotedFrom} onlyHash={result.txid} />
        ) : null}
        {quote ? renderSuccessContact(quote.to) : null}
        <Button title="Done" onPress={() => dismissKeyboardThenClose(() => navigation.popToTop())} />
      </ScrollView>
    );
  }

  // ------------------------------------------------ confirm (smart account)
  if ((phase === 'confirm' || phase === 'sending') && quote?.kind === 'aa' && network) {
    // Every USDC-fee line comes from the source that will charge it (Circle
    // or the ERC-7677 paymaster); for Circle the strings are the earlier ones.
    const tgLines = quote.tokenGas
      ? tokenGasConfirmLines(quote.tokenGas, {
          chainCaip2: evmChain.caip2,
          nativeSymbol: evmChain.displaySymbol,
          maxFeePerGas: quote.maxFeePerGas,
        })
      : null;
    return (
      <ScrollView key="send-aa-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={network.label} testnet={testnet} theme={theme} />

        <View style={[styles.aaTag, { borderColor: theme.accent }]}>
          <Text style={[styles.aaTagText, { color: theme.accent }]}>
            {t('send.aa.confirm.tag', { type: localize(aaAccountTypeLabel(quote.accountType)) })}
          </Text>
        </View>

        <Row label="To" value={quote.to} mono theme={theme} />
        <RecipientContactNotice match={contactMatchFor(quote.to)} address={quote.to} />
        {renderNameNote(quote.to)}
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
                label={t('send.aa.row.smartBalance', { symbol: quote.token.symbol })}
                value={`${exact(quote.tokenSpend.balance, quote.token.decimals)} ${quote.token.symbol}`}
                theme={theme}
              />
            ) : null}
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              {quote.tokenGas && tgLines
                ? t('send.aa.token.noteTokenGas', { symbol: quote.token.symbol, feeSymbol: quote.tokenGas.symbol, through: tgLines.throughPhrase })
                : t('send.aa.token.note', { symbol: quote.token.symbol, native: evmChain.displaySymbol })}
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
            sub={t('send.aa.passkey.sub', { name: fromName })}
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
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        <Row
          label={aaSenderLabel(quote)}
          value={quote.sender}
          mono
          theme={theme}
        />
        <Row
          label={t('send.aa.row.smartBalance', { symbol: evmChain.displaySymbol })}
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
            {localize(kernelDeploymentNote(aaConfig?.bundlerUrl ?? null))}
          </Text>
        ) : null}
        {quote.tokenGas && tgLines ? (
          <>
            <Row label={tgLines.feeLabel} value={tgLines.feeValue} theme={theme} />
            <Text style={[styles.hint, { color: theme.text }]}>{tgLines.feeSentence}</Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{tgLines.worstCaseHint}</Text>
            <Row label="Rate" value={tgLines.rateValue} sub={tgLines.rateNote} theme={theme} />
            <Row label={tgLines.spreadLabel} value={tgLines.spreadValue} sub={tgLines.spreadNote} theme={theme} />
            <Row label={tgLines.paymasterLabel} value={tgLines.paymasterValue} mono theme={theme} />
            <Row label={tgLines.balanceLabel} value={tgLines.balanceValue} theme={theme} />
            <WarningBox>{tgLines.grantSentence}</WarningBox>
            {tgLines.notes.map((n) => (
              <Text key={n} style={[styles.hint, { color: theme.textMuted }]}>
                {n}
              </Text>
            ))}
            {quote.token && quote.token.contract.toLowerCase() === quote.tokenGas.token.toLowerCase() ? (
              <Row
                label={t('send.aa.row.totalOfWorst', { symbol: quote.tokenGas.symbol })}
                value={
                  `${exact(quote.token.amount + quote.tokenGas.maxTokenCharge, quote.tokenGas.decimals)} ${quote.tokenGas.symbol}`
                }
                theme={theme}
              />
            ) : !quote.token ? (
              <Row
                label={t('send.aa.row.totalOf', { symbol: evmChain.displaySymbol })}
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
                ? t('send.aa.sponsoredNote')
                : t('send.aa.worstCase', {
                    gwei: exact(quote.maxFeePerGas, 9),
                    gas: (quote.callGasLimit + quote.verificationGasLimit + quote.preVerificationGas).toString(),
                  }) +
                  // With an EntryPoint deposit the deposit pays first:
                  // AaDepositNote below says so instead of this sentence.
                  (quote.deposit !== undefined && quote.deposit > 0n ? '' : ` ${localize(AA_SELF_PAID_FEE_SENTENCE)}`)}
            </Text>
            <AaDepositNote
              fee={quote.fee}
              deposit={quote.deposit}
              sponsored={quote.sponsored}
              symbol={evmChain.displaySymbol}
            />
            <Row
              label={quote.token ? t('send.aa.row.totalOfWorst', { symbol: evmChain.displaySymbol }) : 'Total (worst case)'}
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
          note={aaPreviewNote(quote)}
        />
        <RiskWarnings url={confirmUrl} wallet={quote.sender} {...aaRiskWarningTarget(quote)} />
        <SpendingPolicyNotice owner={quotedFrom} quote={quote} from={quotedFrom} />
        {tgLines && quote.tokenGas?.source === 'erc7677' ? (
          // The ERC-7677 quote ran the bundler estimate before the gate, with
          // the paymaster's stub terms, so it reports a pass like other quotes.
          <Text style={[styles.simulationOk, { color: theme.success }]}>{tgLines.estimateSentence}</Text>
        ) : tgLines ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>{tgLines.estimateSentence}</Text>
        ) : (
          <Text style={[styles.simulationOk, { color: theme.success }]}>
            <T>Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).</T>
          </Text>
        )}

        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              <T>Signing and submitting to the bundler…</T>
            </Text>
          </View>
        ) : (
          <>
            <Button
              title={
                quote.passkey
                  ? t('send.aa.button.passkey', { symbol: quote.token ? quote.token.symbol : symbol })
                  : t('send.aa.button.send', { symbol: quote.token ? quote.token.symbol : symbol })
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
      <ScrollView key="send-erc20-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={network.label} testnet={testnet} theme={theme} />

        <Row label="From account" value={fromName} sub={quotedFrom} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        <Row label="To" value={quote.to} mono theme={theme} />
        <RecipientContactNotice match={contactMatchFor(quote.to)} address={quote.to} />
        {renderNameNote(quote.to)}
        <Row
          label="Amount"
          value={`${exact(quote.amount, quote.decimals)} ${quote.symbol}`}
          sub={fiatOf(tokenPriceId, quote.amount, quote.decimals)}
          theme={theme}
        />
        <Row label="Token contract" value={quote.contract} mono theme={theme} />
        <Row
          label={t('send.row.maxFeePaidIn', { symbol: evmChain.displaySymbol })}
          value={`${exact(quote.fee, nativeDecimals)} ${evmChain.displaySymbol}`}
          sub={fiatOf(nativePriceId, quote.fee, nativeDecimals)}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {t('send.worstCase.token', {
            gwei: exact(quote.maxFeePerGas, 9),
            gas: quote.gasLimit.toString(),
            l1: quote.opStack ? t('send.worstCase.l1') : '',
            symbol: evmChain.displaySymbol,
          })}
          {quote.gasIsFallback ? ` ${t('send.gasFallback')}` : ''}
        </Text>
        <OpStackFeeRows fees={quote.opStack} symbol={evmChain.displaySymbol} theme={theme} />
        {minimumFeeRehearsalOf(quote) ? (
          <>
            <WarningBox>{MINIMUM_FEE_REHEARSAL_WARNING}</WarningBox>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{minimumFeeRehearsalFeeLine(quote)}</Text>
          </>
        ) : null}
        <Row
          label={t('send.row.balanceOf', { symbol: quote.symbol })}
          value={`${exact(quote.tokenBalance, quote.decimals)} ${quote.symbol}`}
          theme={theme}
        />
        <Row
          label={t('send.row.balanceOf', { symbol: evmChain.displaySymbol })}
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
            <T>Pre-flight simulation passed (eth_call).</T>
          </Text>
        ) : (
          <View style={styles.simulationBlock}>
            <WarningBox>
              {simulationFailed
                ? t('send.simulation.failed', { reason: quote.simulation.ok ? '' : quote.simulation.reason })
                : tx('The token contract reports the transfer would not go through: it returned false instead of reverting (some tokens do this when paused, blocklisted, or short of balance). Sending anyway would cost the full fee and move no tokens.')}
            </WarningBox>
            <View style={styles.overrideRow}>
              <Switch {...switchColors(theme)}
                accessibilityLabel={tx('Send anyway, although the pre-flight simulation failed')}
                value={overrideSimulation}
                onValueChange={setOverrideSimulation}
              />
              <Text style={[styles.overrideLabel, { color: theme.text }]}>
                <T>Send anyway (I understand it will probably fail)</T>
              </Text>
            </View>
          </View>
        )}

        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}><T>Signing and broadcasting…</T></Text>
          </View>
        ) : (
          <>
            <Button
              title={t('home.token.send', { symbol: quote.symbol })}
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
      <ScrollView key="send-nft-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={network.label} testnet={testnet} theme={theme} />

        <Row label="From account" value={fromName} sub={quotedFrom} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        <Row label="To" value={quote.to} mono theme={theme} />
        <RecipientContactNotice match={contactMatchFor(quote.to)} address={quote.to} />
        {renderNameNote(quote.to)}
        <Row label="NFT" value={nftParams?.name ?? '—'} sub={nftParams?.collection ?? null} theme={theme} />
        <Row label="Token ID" value={quote.tokenId.toString()} mono theme={theme} />
        <Row label="Contract" value={quote.contract} mono theme={theme} />
        <Row label="Standard" value={standardLabel(quote.standard)} theme={theme} />
        {quote.standard === 'erc1155' ? (
          <Row
            label="Copies to send"
            value={t('send.row.copies', { count: quote.amount.toString(), held: hideAmounts ? '••••' : quote.ownedBalance.toString() })}
            theme={theme}
          />
        ) : null}
        <Row
          label={t('send.row.maxFeePaidIn', { symbol: evmChain.displaySymbol })}
          value={`${exact(quote.fee, nativeDecimals)} ${evmChain.displaySymbol}`}
          sub={fiatOf(nativePriceId, quote.fee, nativeDecimals)}
          theme={theme}
        />
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {t('send.worstCase.nft', {
            gwei: exact(quote.maxFeePerGas, 9),
            gas: quote.gasLimit.toString(),
            l1: quote.opStack ? t('send.worstCase.l1') : '',
          })}
          {quote.gasIsFallback ? ` ${t('send.gasFallback')}` : ''}
        </Text>
        <OpStackFeeRows fees={quote.opStack} symbol={evmChain.displaySymbol} theme={theme} />
        <Row
          label={t('send.row.balanceOf', { symbol: evmChain.displaySymbol })}
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
            <T>Pre-flight simulation passed (eth_call).</T>
          </Text>
        ) : (
          <View style={styles.simulationBlock}>
            <WarningBox>
              {t('send.simulation.failed', { reason: quote.simulation.ok ? '' : quote.simulation.reason })}
            </WarningBox>
            <View style={styles.overrideRow}>
              <Switch {...switchColors(theme)}
                accessibilityLabel={tx('Send anyway, although the pre-flight simulation failed')}
                value={overrideSimulation}
                onValueChange={setOverrideSimulation}
              />
              <Text style={[styles.overrideLabel, { color: theme.text }]}>
                <T>Send anyway (I understand it will probably fail)</T>
              </Text>
            </View>
          </View>
        )}

        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}><T>Signing and broadcasting…</T></Text>
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
      <ScrollView key="send-confirm" style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <NetworkBadge label={network.label} testnet={testnet} theme={theme} />

        <Row label="From account" value={fromName} sub={quotedFrom} theme={theme} />
        <ImportedKeyNotice show={activeAccount?.imported === true} />
        <Row label="To" value={quote.to} mono theme={theme} />
        <RecipientContactNotice match={contactMatchFor(quote.to)} address={quote.to} />
        {renderNameNote(quote.to)}
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
            {quote.feeTarget === 1
              ? t('send.utxo.feeRate.one', { rate: quote.feeRate })
              : t('send.utxo.feeRate', { rate: quote.feeRate, blocks: quote.feeTarget })}
          </Text>
        ) : null}
        {quote.kind === 'sol' && quote.feeIsFallback ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            <T>
            Estimated at the default 5000 lamports per signature — the RPC
            fee query returned no value.
            </T>
          </Text>
        ) : null}
        {quote.kind === 'evm' ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {t('send.worstCase', {
              gwei: exact(quote.maxFeePerGas, 9),
              gas: quote.gasLimit.toString(),
              l1: quote.opStack ? t('send.worstCase.l1') : '',
            })}
          </Text>
        ) : null}
        {quote.kind === 'evm' ? (
          <OpStackFeeRows fees={quote.opStack} symbol={symbol} theme={theme} />
        ) : null}
        {quote.kind === 'evm' && minimumFeeRehearsalOf(quote) ? (
          <>
            <WarningBox>{MINIMUM_FEE_REHEARSAL_WARNING}</WarningBox>
            <Text style={[styles.hint, { color: theme.textMuted }]}>{minimumFeeRehearsalFeeLine(quote)}</Text>
          </>
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
              <T>Pre-flight simulation passed (eth_call).</T>
            </Text>
          ) : (
            <View style={styles.simulationBlock}>
              <WarningBox>
                {t('send.simulation.failed', { reason: quote.simulation.reason })}
              </WarningBox>
              <View style={styles.overrideRow}>
                <Switch {...switchColors(theme)}
                accessibilityLabel={tx('Send anyway, although the pre-flight simulation failed')}
                value={overrideSimulation}
                onValueChange={setOverrideSimulation}
              />
                <Text style={[styles.overrideLabel, { color: theme.text }]}>
                  <T>Send anyway (I understand it will probably fail)</T>
                </Text>
              </View>
            </View>
          )
        ) : null}

        {phase === 'sending' ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={[styles.hint, { color: theme.textMuted }]}><T>Signing and broadcasting…</T></Text>
          </View>
        ) : (
          <>
            <Button
              title={t('home.token.send', { symbol })}
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
    <ScrollView key="send-form"
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.networkLine, { color: testnet ? theme.testnetFill : theme.textMuted }]}>
        {network ? `${network.label} · ${testnet ? tx('TESTNET') : tx('Mainnet')}` : tx('Unknown network')}{' '}
        {t('send.from', { account: activeAccount ? `${activeAccount.name} ` : '', address: account.address.slice(0, 10) })}
      </Text>

      <OfflineNotice />

      {!url ? (
        <WarningBox>
          {`${tx('Sending unavailable — no configured endpoint.')}${network?.note ? ` ${network.note}` : ''}`}
        </WarningBox>
      ) : null}

      {token ? (
        <View
          style={[styles.aaToggleBox, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {t('send.token.intro', {
              symbol: token.symbol,
              contract: `${token.assetId.reference.slice(0, 10)}…${token.assetId.reference.slice(-8)}`,
              from: aaActive ? t('send.token.fromSmart') : t('send.token.fromAddress', { network: evmChain.label }),
            })}{' '}
            {sendFormTokenFeeSentence({
              nativeSymbol: evmChain.displaySymbol,
              tokenSymbol: token.symbol,
              // The fee mode Review will quote: the USDC fee only while the
              // choice is offered, checked and switched on (tokenGasActive).
              feeToken:
                tokenGasActive && tokenGasOfferNow?.kind === 'available'
                  ? { symbol: TOKEN_GAS_SYMBOL, throughPhrase: tokenGasThroughPhrase(tokenGasOfferNow.source) }
                  : null,
            })}
            {aaAvailable ? ` ${t('send.token.aaNote', { symbol: token.symbol })}` : ''}
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
            {t('send.nft.intro', { network: evmChain.label, symbol: evmChain.displaySymbol })}
          </Text>
        </View>
      ) : null}

      {aaAvailable ? (
        <View
          style={[styles.aaToggleBox, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <View style={styles.overrideRow}>
            <Switch {...switchColors(theme)}
              accessibilityLabel={tx('Send from smart account')}
              value={aaEnabled}
              onValueChange={setAaEnabled}
              disabled={!url}
            />
            <Text importantForAccessibility="no" accessibilityElementsHidden style={[styles.overrideLabel, { color: theme.text }]}>
              <T>Send from smart account</T>
            </Text>
            <View style={[styles.aaTag, { borderColor: theme.accent }]}>
              <Text style={[styles.aaTagText, { color: theme.accent }]}><T>EXPERIMENTAL</T></Text>
            </View>
          </View>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {aaType === 'kernel-7702'
              ? t('send.aa.hint7702') + (delegation.status?.kind === 'plain' ? ` ${t('send.aa.hint7702.notUpgraded')}` : '')
              : t('send.aa.hint', {
                  type: aaType ? localize(aaAccountTypeLabel(aaType)) : tx('smart account'),
                  own: token ? t('send.aa.hint.own', { symbol: token.symbol }) : '',
                })}
          </Text>
          {aaAddressInfo ? (
            <>
              <Row
                label={t('send.aa.addressLabel', { label: localize(smartAccountAddressLabel(aaAddressInfo)) })}
                value={aaAddressInfo.address}
                sub={localize(smartAccountDeploymentNote(aaAddressInfo.deployed))}
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
                  <T>Copied — note that the clipboard can be read by other apps.</T>
                </Text>
              ) : null}
            </>
          ) : aaAddressView?.error ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              {t('send.aa.addressUnreadable', { error: aaAddressView.error })}
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
              {tokenGasOfferNow.source.kind === 'erc7677'
                ? erc7677CheckingSentence(tokenGasOfferNow.source.vendor)
                : 'Checking Circle\u2019s token paymaster on-chain before offering to pay the network fee in USDC\u2026'}
            </Text>
          ) : !tokenGasCheck.ok ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>{tokenGasCheck.reason}</Text>
          ) : (
            <>
              <View style={styles.overrideRow}>
                <Switch {...switchColors(theme)}
                  accessibilityLabel={tx('Pay the network fee in USDC')}
                  value={feeInUsdc}
                  onValueChange={(v) => {
                    // A Max figure from one fee mode must not be trimmed by the other.
                    lastAaMax.current = null;
                    lastTokenGasMax.current = null;
                    setFeeInUsdc(v);
                  }}
                  disabled={!url}
                />
                <Text importantForAccessibility="no" accessibilityElementsHidden style={[styles.overrideLabel, { color: theme.text }]}><T>Pay the network fee in USDC</T></Text>
              </View>
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                {tokenGasOfferNow.source.kind === 'erc7677'
                  ? erc7677ChoiceHint(tokenGasOfferNow.source.vendor)
                  : TOKEN_GAS_CHOICE_HINT}
              </Text>
            </>
          )}
        </View>
      ) : null}

      {aaActive && passkeyRecord ? (
        <View
          style={[styles.aaToggleBox, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <View style={styles.overrideRow}>
            <Switch {...switchColors(theme)}
              accessibilityLabel={tx('Sign with passkey')}
              value={passkeySigner}
              onValueChange={setPasskeySigner}
              disabled={!url}
            />
            <Text importantForAccessibility="no" accessibilityElementsHidden style={[styles.overrideLabel, { color: theme.text }]}><T>Sign with passkey</T></Text>
          </View>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {t('send.passkey.hint')}
          </Text>
        </View>
      ) : null}

      {requestLines ? <PaymentRequestNotice lines={requestLines} /> : null}
      <Text {...recipientField.label} style={[styles.label, { color: theme.textMuted }]}>{recipientField.text}</Text>
      <View style={styles.amountRow}>
        <TextInput
          {...recipientField.input}
          value={recipient}
          onChangeText={(t) => {
            setFormError(null);
            // A pasted payment request for this slot fills the form instead
            // of landing in the field as text (handlePaymentPayload); a
            // refused one leaves the field as it was and says why.
            if (isPaymentUriFor(route.params.chainId, t)) {
              void handlePaymentPayload(t, false);
              return;
            }
            // Another family's payment request (bitcoin:, dogecoin:,
            // solana: or ethereum:): one sentence naming it; nothing filled.
            const foreign = foreignPaymentFamily(route.params.chainId, t);
            if (foreign) {
              setRequestLines(null);
              setRequestError(foreignPaymentRequestSentence(foreign));
              return;
            }
            setRequestError(null);
            setRecipient(t);
          }}
          placeholder={localize(sendRecipientPlaceholder({ namesOffered, ethereum: Boolean(token || nftMode), symbol: account.symbol }))}
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
      {namesOffered ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}><T>{SEND_RECIPIENT_NAMES_HINT}</T></Text>
      ) : null}
      {/*
        Scanned payloads go through extractScannedAddress (strips only the
        ACTIVE chain's own payment-URI scheme, conservatively — see
        ../wallet/scan.ts) and then land in the recipient field, where the
        exact same engine-backed validation as typed/pasted input runs.
        Scanning can never bypass or widen validation.
      */}
      <QrScanner
        visible={scannerOpen}
        rationale={t('send.scan.rationale', { network: token || nftMode ? 'Ethereum' : account.name })}
        onScanned={(data) => {
          setScannerOpen(false);
          setFormError(null);
          void handlePaymentPayload(data, true).then((handled) => {
            if (handled) return;
            const foreign = foreignPaymentFamily(route.params.chainId, data);
            if (foreign) {
              setRequestLines(null);
              setRequestError(foreignPaymentRequestSentence(foreign));
              return;
            }
            // Not a payment request of any family: the old behaviour, so a
            // plain address (or a URI of some other scheme, left untouched)
            // meets the normal validation.
            const scanned = extractScannedAddress(route.params.chainId, data);
            setRequestError(null);
            setRecipient(scanned);
            setScannedRecipient(scanned);
          });
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
          setRequestError(null);
          setFormError(null);
        }}
        onClose={() => setContactsOpen(false)}
        onManage={() => {
          setContactsOpen(false);
          navigation.navigate('Contacts');
        }}
      />
      {requestError ? (
        <Text accessibilityLiveRegion="polite" style={[styles.fieldError, { color: theme.danger }]}>
          {requestError}
        </Text>
      ) : null}
      {nameView ? (
        <EnsNameStatus
          view={nameView}
          privacyNote={nameRegistry.ok && nameLocalRefusal === null ? ensPrivacyNote(nameState?.url ?? url) : null}
        />
      ) : null}
      {validation && !validation.ok ? (
        <Text style={[styles.fieldError, { color: theme.danger }]}>{validation.error}</Text>
      ) : null}
      {validation?.ok && validation.note ? (
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {validation.note} {t('send.willSendTo', { address: validation.normalized })}
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
          <Text {...amountField.label} style={[styles.label, { color: theme.textMuted }]}>
            {amountField.text}
          </Text>
          <View style={styles.amountRow}>
            <TextInput
              {...amountField.input}
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

      {shownFormError ? (
        <Text accessibilityLiveRegion="polite" style={[styles.fieldError, { color: theme.danger }]}>
          {shownFormError}
        </Text>
      ) : null}
      {formError && formTechnical?.forError === formError ? <TechnicalDetail text={formTechnical.text} /> : null}

      {phase === 'quoting' ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}><T>Fetching fee quote…</T></Text>
        </View>
      ) : (
        <Button title="Review" onPress={() => void onReview()} disabled={!url} />
      )}

      <Text style={[styles.hint, { color: theme.textMuted }]}>
        <T>
        You will see the network fee and total on the next screen before
        anything is signed or sent.
        </T>
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
  useI18n();
  if (!fees) return null;
  return (
    <>
      <Row label="Layer 1 data fee (estimate)" value={`${exact(fees.l1DataFee, 18)} ${symbol}`} theme={theme} />
      {fees.operatorFee > 0n ? (
        <Row label="Operator fee (worst case)" value={`${exact(fees.operatorFee, 18)} ${symbol}`} theme={theme} />
      ) : null}
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        {t('send.l1.note', {
          estimate: exact(fees.l1DataFeeEstimate, 18),
          symbol,
          percent: L1_DATA_FEE_HEADROOM_PERCENT.toString(),
        })}
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
  // The label (and a value that is a table sentence, such as "Will deploy
  // with this send") in the active language (phase 22 item 6); amounts,
  // addresses and names are not table entries and are shown as given.
  const { localize } = useI18n();
  const shownLabel = localize(label);
  return (
    <View style={[styles.row, { borderColor: theme.border }]}>
      <Text accessibilityLabel={shownLabel} style={[styles.rowLabel, { color: theme.textMuted }]}>{shownLabel}</Text>
      <Text
        selectable
        // "—" is a visual placeholder; screen readers hear "not available".
        {...(value === '—' ? { accessibilityLabel: localize('not available') } : {})}
        style={[
          styles.rowValue,
          { color: theme.text },
          monoFont ? { fontFamily: mono, fontSize: 13 } : null,
        ]}
      >
        {localize(value)}
      </Text>
      {sub ? <Text style={[styles.rowSub, { color: theme.textMuted }]}>{localize(sub)}</Text> : null}
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

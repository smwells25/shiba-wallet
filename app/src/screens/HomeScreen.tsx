import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { formatAssetId } from '@shiba-wallet/core';
import type { FungibleAsset } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { ImportedKeyNotice, WarningBox, WatchOnlyNotice, screenStyle } from '../components';
import { T } from '../i18n/T';
import { localize, t, tx } from '../i18n/index';
import { useI18n } from '../i18n/useI18n';
import { CHAINS } from '../wallet/chains';
import { IMPORTED_KEY_NO_CHAIN, MULTISIG_NO_CHAIN, WATCH_ONLY_NO_CHAIN } from '../wallet/account-ids';
import { useTheme } from '../theme';
import { textOnFill } from '../theme-palette';
import { sendLinkHint, spokenLinkText, tokenRowSpokenLabel } from '../a11y';
import { EVM_CHAIN_ID, addSendAcceptedListener } from '../wallet/send';
import { addAaSentListener } from '../wallet/aa';
import { createSendRefreshTracker, reloadNowAndLater } from '../wallet/home-refresh';
import { ChainAccount, useWallet } from '../wallet/WalletContext';
import { AccountSwitcher } from '../components/AccountSwitcher';
import {
  MULTISIG_ACCOUNT_NOTICE,
  multisigFooterText,
  multisigOtherNetworkNote,
  watchOnlyFooterText,
} from '../wallet/watch-only';
import { COLD_SIGN_HOME_LINK, COLD_SIGN_LINK_HINT } from '../wallet/cold-signing';
import { httpTransport } from '@shiba-wallet/chains-evm';
import { MULTISIG_DEPOSIT_ROW_LABEL, readMultisigFunds } from '../wallet/multisig';
import { getEndpoint } from '../config/networks';
import { OfflineNotice } from '../wallet/connectivity';
import { usePrefs } from '../wallet/PrefsContext';
import { maskAmount } from '../config/prefs';
import { BalanceState, useBalances } from '../wallet/useBalances';
import { formatBalanceDisplay, spokenAmount } from '../wallet/balances';
import { useTokenBalances } from '../wallet/useTokenBalances';
import { useAccountDelegation } from '../wallet/useDelegation';
import { useSessionEligibility } from '../wallet/useSessionEligibility';
import { useRecoveryInfo } from '../wallet/useRecoveryInfo';
import { usePasskeyInfo } from '../wallet/usePasskeyInfo';
import { shortAccountAddress } from '../wallet/accounts';
import { delegationLabelSuffix, FOREIGN_DELEGATE_WARNING, upgradeLinkShown, walletDelegateDeployed } from '../wallet/delegation';
import { isFeatureAllowed } from '../config/readiness';
import { stakingOfferFor } from '../wallet/staking';
import { bridgeOfferFor } from '../wallet/bridge';
import { evmProfileByCaip2, multisigNetworkVerified } from '../config/evm-chain';
import { usePrices } from '../wallet/usePrices';
import { tokenSendFeeSentence } from '../wallet/token-gas';
import { rebasingTokenNote, tokenRowSubtitle } from '../wallet/tokens';
import { inboxLinkText } from '../wallet/inbox';
import { useInboxUnreadCount } from './InboxScreen';
import {
  formatFiat,
  nativePriceAssetId,
  nativePriceIds,
  tokenPriceAssetId,
  type FiatDisplay,
} from '../wallet/prices';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

/**
 * Height reserved for one line of card links at the default text size (the
 * links are 14 px semibold text, about 19 px tall), before the eligibility
 * checks behind the account-tools row finish.
 */
const TOOLS_ROW_HEIGHT = 20;

function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}

/**
 * Right-hand side of a chain row: the native balance in coin units, a
 * spinner while loading, a subtle tap-to-retry error state, or a muted
 * "unavailable" marker for chains with no configured endpoint. Each chain's
 * state is independent — one endpoint failing never blanks the others.
 * The fiat value (phase 6 item 2) is secondary text under the exact crypto
 * amount; when there is no price, nothing is rendered in its place.
 */
/**
 * What a screen reader says for a balance (BalanceCell, and the token rows'
 * one composed label): "Balance 0.5 ETH, about $1,234.56", "Balance hidden",
 * "Loading balance", "Balance unavailable…", "Balance could not be loaded".
 */
// Through the string table (phase 22 item 6); in English exactly the old
// sentences ("Balance 0.5 ETH, about $1,234.56", "Balance hidden", …),
// checked by scripts/check-i18n.mjs. The fiat text and its stale note come
// from the price module and stay as they are.
function balanceSpokenText(state: BalanceState | undefined, hidden: boolean, fiat: FiatDisplay | null): string {
  if (!state || state.status === 'loading') return tx('Loading balance');
  if (state.status === 'ok') {
    if (hidden) return tx('Balance hidden');
    const spokenFiat = fiat ? t('home.balance.about', { fiat: fiat.text.replace(/^≈\s*/, '') }) : '';
    const spokenStale = fiat?.staleNote ? `, ${fiat.staleNote}` : '';
    return t('home.balance.spoken', { amount: spokenAmount(state.display), symbol: state.symbol, fiat: spokenFiat, stale: spokenStale });
  }
  if (state.status === 'unavailable') return tx('Balance unavailable: no endpoint is configured for this chain');
  return tx('Balance could not be loaded');
}

function BalanceCell({
  state,
  onRetry,
  hidden = false,
  fiat = null,
}: {
  state: BalanceState | undefined;
  onRetry: () => void;
  /** Balance privacy (phase 4 item 5.2): mask the amount as ••••. */
  hidden?: boolean;
  /** Formatted fiat value (already masked when hidden), or null for none. */
  fiat?: FiatDisplay | null;
}) {
  const theme = useTheme();
  useI18n();

  if (!state || state.status === 'loading') {
    return <ActivityIndicator size="small" color={theme.textMuted} />;
  }
  if (state.status === 'ok') {
    // Read as one element: "Balance 0.5 ETH, about $1,234.56" (or "Balance
    // hidden" under Hide amounts, where the fiat line is masked too).
    return (
      <View
        style={styles.balanceCell}
        accessible
        accessibilityLabel={balanceSpokenText(state, hidden, fiat)}
      >
        <Text style={[styles.balance, { color: theme.text }]} numberOfLines={1}>
          {maskAmount(state.display, hidden)}
        </Text>
        <Text style={[styles.balanceSymbol, { color: theme.textMuted }]}>{state.symbol}</Text>
        {fiat ? (
          <Text style={[styles.fiat, { color: theme.textMuted }]} numberOfLines={1}>
            {fiat.text}
          </Text>
        ) : null}
        {fiat?.staleNote ? (
          <Text style={[styles.fiatStale, { color: theme.textMuted }]} numberOfLines={1}>
            {fiat.staleNote}
          </Text>
        ) : null}
      </View>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <View
        style={styles.balanceCell}
        accessible
        accessibilityLabel={tx('Balance unavailable: no endpoint is configured for this chain')}
      >
        <Text style={[styles.balance, { color: theme.textMuted }]}>—</Text>
        <Text style={[styles.balanceSymbol, { color: theme.textMuted }]}><T>no endpoint</T></Text>
      </View>
    );
  }
  // status === 'error': subtle, retryable. The full message would not fit a
  // row; the row communicates "couldn't load" and offers a retry.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tx('Balance could not be loaded. Retry')}
      accessibilityHint={tx('Asks the network endpoint for this balance again')}
      onPress={onRetry}
      hitSlop={8}
    >
      <View style={styles.balanceCell}>
        <Text style={[styles.balance, { color: theme.textMuted }]}>—</Text>
        <Text style={[styles.balanceSymbol, { color: theme.danger }]}><T>retry</T></Text>
      </View>
    </Pressable>
  );
}

/**
 * One tracked ERC-20 token under the Ethereum row: symbol, name, its
 * balance with the exact per-row loading/error/retry discipline of the
 * native rows (BalanceCell is shared), and a Send link into the send
 * screen's token mode (phase 4 item 3).
 */
function TokenRow({
  token,
  state,
  onRetry,
  onSend,
  hidden,
  fiat,
}: {
  token: FungibleAsset;
  state: BalanceState | undefined;
  onRetry: () => void;
  /** Absent for a watch-only account (feature 10): no Send link is offered. */
  onSend?: () => void;
  hidden: boolean;
  fiat: FiatDisplay | null;
}) {
  const theme = useTheme();
  useI18n();
  // One accessible element per row (pass p20c finding 3): the symbol, the
  // second line and the balance in that order, then the row's action — Send
  // on a double tap, or Retry when the balance failed to load. TalkBack used
  // to read the badge's symbol as its own item and, on the two-line wstETH
  // row, the balance before Send. The visible pieces below are hidden from
  // screen readers (importantForAccessibility "no-hide-descendants",
  // Android; accessibilityElementsHidden, iOS — RN 0.86.3
  // Libraries/Components/View/ViewAccessibility.d.ts :258–275 and :287–291),
  // so they are not reached a second time.
  const retry = state?.status === 'error';
  const action = retry ? onRetry : onSend;
  const hideChildren = { importantForAccessibility: 'no-hide-descendants' as const, accessibilityElementsHidden: true };
  return (
    <View
      style={[styles.tokenRow, { backgroundColor: theme.card, borderColor: theme.border }]}
      accessible
      accessibilityLabel={tokenRowSpokenLabel({
        symbol: token.symbol,
        subtitle: tokenRowSubtitle(token),
        balance: balanceSpokenText(state, hidden, fiat),
      })}
      {...(action
        ? {
            accessibilityRole: 'button' as const,
            accessibilityHint: retry ? tx('Asks the network endpoint for this balance again') : sendLinkHint(token.symbol),
            accessibilityActions: [{ name: 'activate', label: retry ? tx('Retry') : t('home.token.send', { symbol: token.symbol }) }],
            onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
              if (e.nativeEvent.actionName === 'activate') action();
            },
          }
        : {})}
    >
      {/* The whole symbol, on one line: the badge grows from a 36-px circle
          into a pill (up to 72 px) instead of cutting "wstETH" to "wstE";
          a symbol longer than that ends in an ellipsis. */}
      <View style={[styles.tokenBadge, { borderColor: theme.border }]} {...hideChildren}>
        <Text style={[styles.tokenBadgeText, { color: theme.textMuted }]} numberOfLines={1}>
          {token.symbol}
        </Text>
      </View>
      <View style={styles.cardBody} {...hideChildren}>
        <Text style={[styles.tokenName, { color: theme.text }]} numberOfLines={1}>
          {token.symbol}
        </Text>
        {/* Two lines: "Wrapped liquid staked Ether 2.0 · ERC-20" was cut off
            on one (2026-10-11 re-check, finding 8). */}
        <Text style={[styles.tokenKind, { color: theme.textMuted }]} numberOfLines={2}>
          {tokenRowSubtitle(token)}
        </Text>
        {onSend ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('home.token.send', { symbol: token.symbol })}
            onPress={onSend}
            hitSlop={8}
          >
            <Text style={[styles.sendLink, { color: theme.accent }]}><T>Send ↗</T></Text>
          </Pressable>
        ) : null}
      </View>
      <View {...hideChildren}>
        <BalanceCell state={state} onRetry={onRetry} hidden={hidden} fiat={fiat} />
      </View>
    </View>
  );
}

/**
 * The networks an account has no address on (an imported key or a watched
 * address has an Ethereum address only), each shown as a muted card with
 * the plain reason instead of being left out silently.
 */
function UnavailableChains({ accounts, sentence: englishSentence }: { accounts: ChainAccount[]; sentence: string }) {
  const theme = useTheme();
  const { localize } = useI18n();
  const sentence = localize(englishSentence);
  return (
    <View style={styles.unavailableList}>
      {CHAINS.filter((c) => !accounts.some((a) => a.chainId === c.provider.chainId)).map((c) => (
        <View
          key={c.provider.chainId}
          accessible
          accessibilityLabel={`${c.provider.name}: ${sentence}`}
          style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <View style={styles.cardTop}>
            <View style={[styles.badge, { backgroundColor: c.accent, opacity: 0.4 }]}>
              <Text style={[styles.badgeText, { color: textOnFill(c.accent) }]}>{c.symbol}</Text>
            </View>
            <View style={styles.cardBody}>
              <Text style={[styles.chainName, { color: theme.text }]}>{c.provider.name}</Text>
              <Text style={[styles.address, { color: theme.textMuted }]}>{sentence}</Text>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

/** The four launch chains: address, live native balance, tap to receive. */
export function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  // Localisation (phase 22 item 6): Home re-renders when the language changes.
  useI18n();
  // The reserved account-tools row scales with the system text size, so a
  // larger font does not bring the layout shift back.
  const { fontScale } = useWindowDimensions();
  // `accounts` holds the ACTIVE account's addresses (phase 6 item 3);
  // switching accounts remounts the navigator (App.tsx), so this screen
  // never shows one account's balances under another's name.
  const { accounts, activeAccount } = useWallet();
  // The notifications inbox's unread count for its link (phase 22 item 5).
  const inboxUnread = useInboxUnreadCount();
  // Watch-only accounts (feature 10): the wallet holds no key, so Home
  // offers only what reads public data by address (balances, tokens,
  // Activity, NFTs) and none of the links that lead to signing (Send, Swap,
  // Upgrade, Approvals' revoke, Sessions, Guardians, Passkey, Receive's
  // Send and proof of ownership, the guardian recovery link).
  const watchOnly = activeAccount?.watchOnly === true;
  // Multi-signature accounts (feature 24; listed since phase 18 item 3): no
  // single key of this wallet signs for it, so Home offers the same
  // read-only links as for a watch-only account plus the Multisig screen,
  // where its operations are built and the co-signers' approvals collected.
  const multisig = activeAccount?.multisig === true;
  // No key of this wallet signs alone for the active account.
  const noKey = watchOnly || multisig;
  const { hideAmounts, setHideAmounts, evmChain, sepolia, showFiat } = usePrefs();
  // The active EVM chain is passed so a mode flip (mainnet <-> Sepolia)
  // re-fetches the EVM row (useBalances handles it).
  const { balances, refreshing, refreshAll, refreshOne } = useBalances(accounts, evmChain.caip2);
  const evmAccount = accounts.find((a) => a.chainId === EVM_CHAIN_ID);
  // Grows on every focus after the first and on every pull-to-refresh, so
  // the eligibility checks behind the account-tools row (sessions,
  // guardians, passkey) run again: an account deployed by a send from
  // another screen, or a bundler saved in Settings, then shows its links
  // without a relaunch. The hooks also re-check on their own when the AA
  // configuration is written or an operation is accepted
  // (useAaStateRevision). The previous answer stays on screen meanwhile.
  const [toolsRefresh, setToolsRefresh] = useState(0);
  // EIP-7702 status of the active account on the active EVM chain (phase 8
  // item 1): shown under the account switcher so the user always knows
  // which code runs at the address.
  const delegation = useAccountDelegation(noKey ? undefined : evmAccount?.address);
  // Session keys (phase 8 item 2): linked only when the active account has
  // a deployed Kernel account or an active EIP-7702 upgrade.
  // The three account-tool checks are not run at all for a watch-only
  // account (null owner and index): no smart-account bundle is built for an
  // address the wallet cannot sign for.
  // The same for a multisig account: its smart account is not built from
  // an owner key and index (createAaClientFromConfig refuses its id).
  const toolsOwner = noKey ? null : evmAccount?.address;
  const toolsIndex = noKey ? null : (activeAccount?.index ?? null);
  const sessionsEligible = useSessionEligibility(toolsOwner, toolsIndex, toolsRefresh);
  // Guardians (phase 8 item 4): linked only for a deployed Kernel v3.3
  // account the active account owns; a recovered account gets a label; a
  // recovery in progress gets a "continue" line.
  const recovery = useRecoveryInfo(toolsOwner, toolsIndex, toolsRefresh);
  // Passkey signer (phase 8 item 3): linked only for a deployed Kernel v3.3
  // account the active account owns; the screen shows the development-build
  // note when the native module or the rpId is missing.
  const passkey = usePasskeyInfo(toolsOwner, toolsIndex, toolsRefresh);
  // Tracked tokens are per chain (phase 13 item 1): the section lists the
  // ACTIVE profile's own list (mainnet, Ethereum Sepolia or Base Sepolia),
  // and each balance is read only from an endpoint on the token's chain.
  const { tokens, tokenBalances, reloadTokens, refreshToken } = useTokenBalances(
    evmAccount?.address,
    evmChain.caip2,
  );

  // USD prices for the natives (all four in one request; null for the EVM
  // slot in a test mode) and the tracked tokens on the ACTIVE chain
  // (tokenPriceAssetId returns null for every test-network token, so test
  // tokens are never priced). The hook requests nothing while "Show fiat
  // values" is off.
  const priceIds = [
    ...nativePriceIds(sepolia),
    ...tokens.map((t) => tokenPriceAssetId(t, evmChain.caip2)),
  ];
  const { quotes, refresh: refreshPrices } = usePrices(priceIds);

  /**
   * Fiat for a loaded balance. The price id is re-derived from the network
   * that actually produced the balance, so a Sepolia balance can never
   * pick up a mainnet price even for one render across a mode flip.
   */
  const fiatFor = (state: BalanceState | undefined, priceId: string | null) =>
    state?.status === 'ok' && priceId
      ? formatFiat(quotes.get(priceId), state.amount, state.decimals, { hidden: hideAmounts })
      : null;

  // Re-read the token list whenever Home regains focus, so tokens added or
  // removed on the Tokens screen appear without an app restart. Balances
  // also re-resolve their endpoints per refresh, so flipping the Sepolia
  // toggle in Settings takes effect on the next focus/refresh.
  useFocusEffect(
    useCallback(() => {
      void reloadTokens();
    }, [reloadTokens]),
  );

  // Balances after a send (Base Sepolia finding 7): Home stays mounted
  // under Send, Swap and the other screens, so it only notes that a
  // transaction or smart-account operation was accepted, and reloads every
  // row when it regains focus — once at once and once more a little later,
  // because the balance moves at inclusion, not at acceptance
  // (wallet/home-refresh.ts). Each row keeps its own loading, error and
  // retry state (useBalances refreshOne).
  const sendTracker = useRef(createSendRefreshTracker([addSendAcceptedListener, addAaSentListener]));
  useEffect(() => sendTracker.current.start(), []);
  const reloadNativeRows = useCallback(() => {
    for (const account of accounts) void refreshOne(account.chainId);
  }, [accounts, refreshOne]);
  const reloadAllRows = useCallback(() => {
    reloadNativeRows();
    void reloadTokens();
  }, [reloadNativeRows, reloadTokens]);
  // Read through refs so the focus effect below runs once per focus, not
  // again whenever these callbacks change identity while Home is focused.
  const reloaders = useRef({ now: reloadNativeRows, later: reloadAllRows });
  useEffect(() => {
    reloaders.current = { now: reloadNativeRows, later: reloadAllRows };
  }, [reloadNativeRows, reloadAllRows]);
  const focusedBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      // The first focus is the initial mount, where every hook loads anyway.
      if (focusedBefore.current) setToolsRefresh((value) => value + 1);
      focusedBefore.current = true;
      if (!sendTracker.current.takeStale()) return undefined;
      // Tokens are already reloaded on every focus by the effect above, so
      // the immediate pass reloads the native rows only; the follow-up pass
      // reloads both. It is cancelled when Home loses focus or unmounts.
      return reloadNowAndLater(
        () => reloaders.current.now(),
        () => reloaders.current.later(),
      );
    }, []),
  );

  // A multisig's EntryPoint deposit (it pays network fees first), read with
  // the Multisig screen's own reader on the active network; re-read on every
  // focus and pull-to-refresh (toolsRefresh). null = could not be read.
  const multisigAddress = multisig ? (evmAccount?.address ?? null) : null;
  const [multisigDeposit, setMultisigDeposit] = useState<{ key: string; deposit: bigint | null } | null>(null);
  const multisigDepositKey = multisigAddress ? `${evmChain.caip2}|${multisigAddress}` : null;
  useEffect(() => {
    if (!multisigDepositKey || !multisigAddress) return undefined;
    let cancelled = false;
    void (async () => {
      const endpoint = await getEndpoint(EVM_CHAIN_ID);
      const funds = endpoint?.url ? await readMultisigFunds(httpTransport(endpoint.url), multisigAddress) : null;
      if (!cancelled) setMultisigDeposit({ key: multisigDepositKey, deposit: funds?.deposit ?? null });
    })().catch(() => {
      if (!cancelled) setMultisigDeposit({ key: multisigDepositKey, deposit: null });
    });
    return () => {
      cancelled = true;
    };
  }, [multisigDepositKey, multisigAddress, toolsRefresh]);
  const shownDeposit = multisigDeposit && multisigDeposit.key === multisigDepositKey ? multisigDeposit : null;
  const multisigInfo = multisig ? (activeAccount?.multisigInfo ?? null) : null;
  // The record's network, when it is not the active one: the Multisig
  // screen lists and builds its operations only there.
  const multisigNetworkNote =
    multisigInfo && multisigInfo.chain !== evmChain.caip2
      ? multisigOtherNetworkNote(multisigInfo.label, evmProfileByCaip2(multisigInfo.chain)?.label ?? multisigInfo.chain, evmChain.label)
      : null;

  /**
   * One text link in a chain card's link rows. Its spoken name is its
   * visible text (pass p20c finding 13: "Inheritance" was spoken for the
   * visible "Inheritance (demonstration)"), with only the decorative ↗ and ✓
   * left out (spokenLinkText, ../a11y.ts); anything more goes in the hint.
   */
  const cardLink = (key: string, text: string, onPress: () => void, hint?: string) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={spokenLinkText(text)}
      {...(hint !== undefined ? { accessibilityHint: localize(hint) } : {})}
      onPress={onPress}
      hitSlop={8}
    >
      <Text style={[styles.sendLink, { color: theme.accent }]}><T>{text}</T></Text>
    </Pressable>
  );

  // A chain card is a plain View holding SIBLING controls (phase 12 item 4):
  // the Receive area (badge, name and address), the balance cell and the
  // link rows. It used to be one Pressable wrapping the link Pressables,
  // which screen readers can merge into a single element so the inner
  // links were hard to reach; now every link is its own focusable button.
  const renderChainCard = ({ item }: { item: ChainAccount }) => {
    const isEvm = item.chainId === EVM_CHAIN_ID;
    // The EVM row is titled with the ACTIVE profile's network ("Ethereum",
    // "Ethereum Sepolia", "Base Sepolia", "Arbitrum Sepolia"); the account's
    // own name (item.name, the key provider's "Ethereum") is left unchanged
    // because other screens use it. Only this card's visible title and its
    // screen-reader labels use the profile label.
    const title = isEvm ? evmChain.label : item.name;
    // Account tools that appear only after asynchronous eligibility checks
    // (session keys, guardians, passkey). They get their own row with its
    // height reserved from the start, so nothing above or below moves when
    // they appear (finding F11: a tap aimed at Approvals once opened
    // Guardians because a link was inserted before it).
    const tools = isEvm && !noKey
      ? [
          sessionsEligible
            ? cardLink('sessions', 'Sessions', () => navigation.navigate('Sessions'))
            : null,
          recovery.guardiansEligible
            ? cardLink('guardians', 'Guardians', () => navigation.navigate('Guardians'))
            : null,
          // Inheritance is a test-network demonstration built on the guardian
          // module, so it is offered under the same eligibility, on test
          // networks only.
          recovery.guardiansEligible && evmChain.testnet
            ? cardLink('inheritance', 'Inheritance (demonstration)', () => navigation.navigate('Inheritance'))
            : null,
          // The in-app browser (feature 79): test networks only, enforced
          // by its readiness row; never for a watch-only account (this list
          // is empty for one).
          evmChain.testnet
            ? cardLink('apps', 'Apps', () => navigation.navigate('Apps'), 'Opens the in-app browser')
            : null,
          // Multi-signature accounts (feature 24): test networks only,
          // enforced by the readiness row `multisig`, and only where the
          // Kernel v3.3 contracts and the weighted signer module are known to
          // exist (config/evm-chain.ts multisigNetworkVerified: a built-in
          // test network, or a network the multisig check passed on).
          evmChain.testnet && multisigNetworkVerified(evmChain)
            ? cardLink('multisig', 'Multisig', () => navigation.navigate('Multisig'), 'Opens the multi-signature accounts')
            : null,
          // Staking (features 57/58): test networks only, and only where a
          // staking protocol is set up for the active chain (Lido on
          // Ethereum Sepolia and Hoodi; Rocket Pool on Hoodi).
          isFeatureAllowed('staking', evmChain.caip2) && stakingOfferFor(evmChain.caip2).unavailable === null
            ? cardLink('staking', 'Staking', () => navigation.navigate('Staking'))
            : null,
          // Bridging (feature 35): test networks only (readiness row
          // 'bridge', enforced), and only where a provider lists a route
          // from the active network (Ethereum, Arbitrum, OP and Base
          // Sepolia; on Base Sepolia only Circle CCTP, shown as not offered
          // yet).
          isFeatureAllowed('bridge', evmChain.caip2) && bridgeOfferFor(evmChain.caip2).destinations.length > 0
            ? cardLink('bridge', 'Bridge', () => navigation.navigate('Bridge'), 'Opens bridging between test networks')
            : null,
          passkey.eligible
            ? cardLink(
                'passkey',
                passkey.record ? 'Passkey ✓' : 'Passkey',
                () => navigation.navigate('Passkey'),
                passkey.record ? 'A passkey is added to this smart account' : undefined,
              )
            : null,
        ].filter((link) => link !== null)
      : [];
    return (
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <View style={styles.cardTop}>
          {/* A watch-only address opens Receive too, which shows it in a
              plain read-only form (the address, its QR code and the
              watch-only notice; no Send, payment request, proof of
              ownership or smart-account box). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${title}, ${watchOnly ? t('home.card.watchedAddress', { address: item.address }) : shortAddress(item.address)}`}
            accessibilityHint={
              watchOnly ? tx('Opens the watched address and its QR code') : t('home.card.receive.hint', { title })
            }
            onPress={() => navigation.navigate('Receive', { chainId: item.chainId })}
            style={({ pressed }) => [styles.receiveArea, { opacity: pressed ? 0.7 : 1 }]}
          >
            <View style={[styles.badge, { backgroundColor: item.accent }]}>
              <Text style={[styles.badgeText, { color: textOnFill(item.accent) }]}>{item.symbol}</Text>
            </View>
            <View style={styles.cardBody}>
              <Text style={[styles.chainName, { color: theme.text }]}>{title}</Text>
              <Text style={[styles.address, { color: theme.textMuted }]}>
                {shortAddress(item.address)}
              </Text>
            </View>
          </Pressable>
          <BalanceCell
            state={balances[item.chainId]}
            onRetry={() => void refreshOne(item.chainId)}
            hidden={hideAmounts}
            fiat={(() => {
              const state = balances[item.chainId];
              return state?.status === 'ok'
                ? fiatFor(state, nativePriceAssetId(item.chainId, state.networkChainId))
                : null;
            })()}
          />
        </View>
        <View style={styles.linkRow}>
          {/* Cold signing (feature 11, phase 22 item 3): a watch-only account
              sends only through an off-line signer that holds its key. */}
          {watchOnly && isEvm
            ? cardLink('cold-sign', COLD_SIGN_HOME_LINK, () => navigation.navigate('ColdSign'), COLD_SIGN_LINK_HINT)
            : null}
          {noKey
            ? null
            : cardLink('send', 'Send ↗', () =>
                navigation.navigate('Send', { chainId: item.chainId }),
                // The coin as this network names it ("test ETH" on a test
                // network; pass p20d finding 6).
                sendLinkHint(isEvm ? evmChain.displaySymbol : item.symbol),
              )}
          {cardLink('activity', 'Activity', () =>
            navigation.navigate('Activity', { chainId: item.chainId }),
            t('home.link.activity.hint', { title }),
          )}
          {/* Swaps are an EVM feature (0x, phase 5 item 1); the screen
              itself explains and stays off until a key is configured. Not
              linked on profiles where swaps are not offered (Base Sepolia:
              config/evm-chain.ts swapsOffered). */}
          {isEvm && evmChain.swapsOffered && !noKey
            ? cardLink('swap', 'Swap', () => navigation.navigate('Swap'))
            : null}
          {/* NFT gallery (phase 7 item 4) for the active EVM chain; the
              screen explains itself until an NFT indexer is configured. */}
          {isEvm ? cardLink('nfts', 'NFTs', () => navigation.navigate('Nfts')) : null}
          {/* EIP-7702 account upgrade (phase 8 item 1) for the active
              account on the active EVM chain. Hidden where the Kernel v3.3
              delegate is known to have no code (a network the user added)
              unless the account has a delegation to review or undo. */}
          {upgradeLinkShown({ delegateDeployed: walletDelegateDeployed(evmChain.chainIdDecimal), status: delegation.status }) ? (
            <>
              {isEvm && !noKey
                ? cardLink(
                    'upgrade',
                    delegation.status?.kind === 'kernel-v3.3' ? 'Upgraded ✓' : 'Upgrade',
                    () => navigation.navigate('UpgradeAccount'),
                    delegation.status?.kind === 'kernel-v3.3' ? 'This account is upgraded; opens its details' : 'Upgrades this account to a smart account',
                  )
                : null}
            </>
          ) : null}
          {/* Token approvals manager (phase 7 item 5) for the active EVM
              chain; the screen explains what it can and cannot see. */}
          {/* Linked for a watch-only account too: the Approvals screen is
              read-only there (no Revoke buttons). */}
          {isEvm
            ? cardLink('approvals', 'Approvals', () => navigation.navigate('Approvals'), 'Opens the token approvals')
            : null}
          {/* A multisig account's operations (sends included) are built on
              the Multisig screen, where the co-signers' approvals are
              collected; it is the only route to them. */}
          {isEvm && multisig
            ? cardLink('multisig-operations', 'Multisig', () => navigation.navigate('Multisig'), 'Opens this multisig’s operations')
            : null}
        </View>
        {isEvm && multisig ? (
          <Text
            style={[styles.address, { color: theme.textMuted }]}
            accessibilityLabel={
              hideAmounts
                ? `${MULTISIG_DEPOSIT_ROW_LABEL}: hidden`
                : `${MULTISIG_DEPOSIT_ROW_LABEL}: ${
                    shownDeposit === null
                      ? 'loading'
                      : shownDeposit.deposit === null
                        ? 'could not be read'
                        : `${spokenAmount(formatBalanceDisplay(shownDeposit.deposit, 18))} ${evmChain.displaySymbol}`
                  }`
            }
          >
            {MULTISIG_DEPOSIT_ROW_LABEL}:{' '}
            {shownDeposit === null
              ? 'loading…'
              : shownDeposit.deposit === null
                ? 'could not be read'
                : `${maskAmount(formatBalanceDisplay(shownDeposit.deposit, 18), hideAmounts)} ${evmChain.displaySymbol}`}
          </Text>
        ) : null}
        {/* Session keys (phase 8 item 2: a deployed Kernel account or an
            EIP-7702 upgrade), guardians (phase 8 item 4: a deployed Kernel
            v3.3 account, never a 7702 upgrade) and the passkey signer
            (phase 8 item 3: a deployed Kernel v3.3 account). The row is
            always present on the EVM card, empty until (unless) the checks
            pass, and hidden from screen readers while empty. */}
        {isEvm ? (
          <View
            style={[styles.toolsRow, { minHeight: Math.ceil(TOOLS_ROW_HEIGHT * fontScale) }]}
            {...(tools.length === 0
              ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const }
              : {})}
          >
            {tools}
          </View>
        ) : null}
      </View>
    );
  };

  // The EVM row carries the active network's tracked ERC-20 tokens beneath
  // it, plus the entry point to the token management screen.
  const renderItem = ({ item }: { item: ChainAccount }) => {
    const card = renderChainCard({ item });
    if (item.chainId !== EVM_CHAIN_ID) return card;
    return (
      <View style={styles.evmGroup}>
        {card}
        <View style={styles.tokenSection}>
          {tokens.map((token) => {
            const id = formatAssetId(token.assetId);
            const tokenState = tokenBalances[id];
            const priceId =
              tokenState?.status === 'ok' && tokenState.networkChainId === evmChain.caip2
                ? tokenPriceAssetId(token, evmChain.caip2)
                : null;
            // A rebasing token (stETH) changes balance by itself; the note is
            // decided by tokens.ts's own table, never by a stored entry.
            const rebasing = rebasingTokenNote(evmChain.caip2, token.assetId.reference);
            return (
              <View key={id}>
                <TokenRow
                  token={token}
                  state={tokenBalances[id]}
                  onRetry={() => void refreshToken(id)}
                  {...(noKey
                    ? {}
                    : { onSend: () => navigation.navigate('Send', { chainId: EVM_CHAIN_ID, tokenId: id }) })}
                  hidden={hideAmounts}
                  fiat={fiatFor(tokenState, priceId)}
                />
                {rebasing ? (
                  <Text style={[styles.manageTokens, { color: theme.textMuted }]} accessibilityLabel={t('home.note', { note: localize(rebasing) })}>
                    {localize(rebasing)}
                  </Text>
                ) : null}
              </View>
            );
          })}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tx('Manage tokens')}
            onPress={() => navigation.navigate('Tokens')}
            hitSlop={8}
          >
            <Text style={[styles.manageTokens, { color: theme.accent }]}><T>Manage tokens</T></Text>
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <View style={screenStyle(theme)}>
      <FlatList
        data={accounts}
        keyExtractor={(item) => item.chainId}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.headerStack}>
            {/* Account switcher (phase 6 item 3): active account name and
                short EVM address; opens the account list. */}
            <AccountSwitcher
              onManage={() => navigation.navigate('Settings')}
              onImportKey={() => navigation.navigate('ImportKey')}
            />
            {/* Feature 12 (ADR D9): an imported account says, every time it is
                shown, that the recovery phrase does not back it up. */}
            <ImportedKeyNotice show={activeAccount?.imported === true} />
            {/* Feature 10: a watch-only account says, every time it is
                shown, that the wallet holds no key for it. */}
            <WatchOnlyNotice show={watchOnly} />
            {/* A multisig account says, every time it is shown, that its
                operations need the co-signers (and where it is recorded). */}
            {multisig ? <WarningBox>{MULTISIG_ACCOUNT_NOTICE}</WarningBox> : null}
            {multisigNetworkNote ? <WarningBox>{multisigNetworkNote}</WarningBox> : null}
            <OfflineNotice />
            {activeAccount && delegation.status?.kind === 'kernel-v3.3' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Opens the account upgrade screen"
                onPress={() => navigation.navigate('UpgradeAccount')}
                hitSlop={8}
              >
                <Text style={[styles.delegationLine, { color: theme.success }]}>
                  {activeAccount.name}
                  {delegationLabelSuffix(delegation.status)} on {evmChain.label}
                </Text>
              </Pressable>
            ) : null}
            {activeAccount &&
            (delegation.status?.kind === 'other' || delegation.status?.kind === 'contract') ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  `Warning: ${activeAccount.name}${delegationLabelSuffix(delegation.status)} on ${evmChain.label}. ` +
                  (delegation.status.kind === 'other' ? `${FOREIGN_DELEGATE_WARNING} ` : '') +
                  'Tap to review.'
                }
                accessibilityHint="Opens the account upgrade screen to review this"
                onPress={() => navigation.navigate('UpgradeAccount')}
                hitSlop={8}
                style={[
                  styles.delegationWarning,
                  { backgroundColor: theme.warningSurface, borderColor: theme.warningBorder },
                ]}
              >
                <Text style={[styles.delegationLine, { color: theme.warningText }]}>
                  ⚠ {activeAccount.name}
                  {delegationLabelSuffix(delegation.status)} on {evmChain.label}.{' '}
                  {delegation.status.kind === 'other' ? FOREIGN_DELEGATE_WARNING : ''} Tap to review.
                </Text>
              </Pressable>
            ) : null}
            {activeAccount && recovery.recoveredAccount ? (
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Opens the guardians screen"
                onPress={() => navigation.navigate('Guardians')}
                hitSlop={8}
              >
                <Text style={[styles.delegationLine, { color: theme.text }]}>
                  {activeAccount.name} · recovered account {shortAccountAddress(recovery.recoveredAccount)} on{' '}
                  {evmChain.label} (not found from your recovery phrase alone; keep its record backed up)
                </Text>
              </Pressable>
            ) : null}
            {activeAccount && recovery.recoveryInProgress ? (
              <Pressable
                accessibilityRole="button"
                accessibilityHint={tx('Continues the recovery in progress')}
                onPress={() => navigation.navigate('RecoverAccount')}
                hitSlop={8}
              >
                <Text style={[styles.delegationLine, { color: theme.accent }]}>
                  <T>Recovering an account with guardians — tap to continue</T>
                </Text>
              </Pressable>
            ) : null}
            {/* Quick balance-privacy toggle (the same setting lives in
                Settings -> Privacy & security); the eye glyph masks every
                amount on this screen and on Activity as ••••. */}
            <View style={styles.privacyRow}>
              {/* A switch for screen readers (pass p20c finding 4: it was a plain
                  button with no on/off state): "Hide amounts, switch, on/off"
                  (accessibilityRole "switch" and accessibilityState.checked,
                  RN 0.86.3 ViewAccessibility.d.ts :44 and :48). */}
              <Pressable
                accessibilityRole="switch"
                accessibilityLabel={tx('Hide amounts')}
                accessibilityState={{ checked: hideAmounts }}
                accessibilityHint={tx('Masks or reveals every amount on this screen and on Activity')}
                onPress={() => void setHideAmounts(!hideAmounts)}
                hitSlop={8}
              >
                <Text style={[styles.privacyToggle, { color: theme.accent }]}>
                  {hideAmounts ? tx('👁 Show amounts') : tx('👁 Hide amounts')}
                </Text>
              </Pressable>
            </View>
          </View>
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void refreshAll();
              void reloadTokens();
              void refreshPrices();
              setToolsRefresh((value) => value + 1);
            }}
            tintColor={theme.textMuted}
            colors={[theme.accent]}
          />
        }
        ListFooterComponent={
          <View>
          {/* Phase 20 item 1: the portfolio (net worth, profit and loss) and
              the price alerts, read-only for every kind of account. */}
          <View style={styles.linkRow}>
            {cardLink('portfolio', 'Portfolio', () => navigation.navigate('Portfolio'), 'Net worth and profit and loss')}
            {cardLink('price-alerts', 'Price alerts', () => navigation.navigate('PriceAlerts'), 'Price alerts and watchlist')}
            {cardLink('inbox', inboxLinkText(inboxUnread), () => navigation.navigate('Inbox'), 'Reminders, alerts and sent transactions')}
          </View>
          {/* Feature 12 (ADR D9): an imported Ethereum key has no Bitcoin,
              Dogecoin or Solana address; those networks are shown as not
              available rather than left out silently. Feature 10: neither
              has a watched Ethereum address. */}
          {activeAccount?.imported ? (
            <UnavailableChains accounts={accounts} sentence={IMPORTED_KEY_NO_CHAIN} />
          ) : watchOnly ? (
            <UnavailableChains accounts={accounts} sentence={WATCH_ONLY_NO_CHAIN} />
          ) : multisig ? (
            <UnavailableChains accounts={accounts} sentence={MULTISIG_NO_CHAIN} />
          ) : null}
          {/* Not offered from an imported account: a recovery onto an
              imported key is refused (recovery.ts
              RECOVERY_IMPORTED_OWNER_REFUSAL), so the link would lead to a
              refusal. Not offered from a watch-only account either (no key
              to become the new owner). Not offered on a network whose
              profile has no verified Kernel v3.3 stack (kernelV33Verified
              false: Hoodi and every network you added), because guardian
              recovery runs on the Kernel guardian modules and RecoveryAction,
              which are not known to exist there. */}
          {!evmChain.kernelV33Verified ? null : (
            <>
          {noKey ? null : (
            <>
          {activeAccount?.imported ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={tx('Recover an account with guardians')}
              onPress={() => navigation.navigate('RecoverAccount')}
              hitSlop={8}
            >
              <Text style={[styles.manageTokens, styles.recoverLink, { color: theme.accent }]}>
                <T>Lost a recovery phrase? Recover an account with guardians</T>
              </Text>
            </Pressable>
          )}
            </>
          )}
            </>
          )}
          {watchOnly && activeAccount ? (
            <Text style={[styles.footer, { color: theme.textMuted }]}>
              {watchOnlyFooterText(activeAccount.name)}
              {showFiat ? ` ${t('home.footer.usd')}` : ''}
            </Text>
          ) : multisig && activeAccount ? (
            <Text style={[styles.footer, { color: theme.textMuted }]}>
              {multisigFooterText(activeAccount.name)}
              {showFiat ? ` ${t('home.footer.usd')}` : ''}
            </Text>
          ) : (
          <Text style={[styles.footer, { color: theme.textMuted }]}>
            {activeAccount?.imported
              ? t('home.footer.imported', { name: activeAccount.name })
              : activeAccount
                ? t('home.footer.derived', { name: activeAccount.name })
                : t('home.footer.derivedYours')}{' '}
            {t('home.footer.balances')} {tokenSendFeeSentence(evmChain.caip2)}
            {showFiat ? ` ${t('home.footer.usd')}` : ''}
          </Text>
          )}
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    padding: 16,
    gap: 12,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  receiveArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  badge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The colour comes from textOnFill (theme-palette.ts), chosen per fill.
  badgeText: {
    fontWeight: '700',
    fontSize: 12,
  },
  cardBody: {
    flex: 1,
    gap: 4,
  },
  unavailableList: {
    gap: 12,
    marginBottom: 12,
  },
  chainName: {
    fontSize: 17,
    fontWeight: '600',
  },
  address: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  linkRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 16,
    rowGap: 10,
  },
  // minHeight is set inline: TOOLS_ROW_HEIGHT x the system font scale.
  toolsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 16,
    rowGap: 10,
  },
  sendLink: {
    fontSize: 14,
    fontWeight: '600',
  },
  balanceCell: {
    alignItems: 'flex-end',
    gap: 2,
    maxWidth: 140,
  },
  balance: {
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  balanceSymbol: {
    fontSize: 12,
  },
  fiat: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  fiatStale: {
    fontSize: 10,
    fontStyle: 'italic',
  },
  evmGroup: {
    gap: 8,
  },
  tokenSection: {
    marginLeft: 20,
    gap: 8,
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 12,
  },
  tokenBadge: {
    minWidth: 36,
    maxWidth: 72,
    height: 36,
    paddingHorizontal: 5,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tokenBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  tokenName: {
    fontSize: 15,
    fontWeight: '600',
  },
  tokenKind: {
    fontSize: 12,
  },
  manageTokens: {
    fontSize: 14,
    fontWeight: '600',
    paddingVertical: 2,
  },
  headerStack: {
    gap: 8,
  },
  delegationLine: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  delegationWarning: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
  },
  privacyRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingBottom: 4,
  },
  privacyToggle: {
    fontSize: 13,
    fontWeight: '600',
  },
  recoverLink: {
    textAlign: 'center',
    marginTop: 12,
  },
  footer: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 16,
  },
});

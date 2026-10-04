import React, { useCallback } from 'react';
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
import { screenStyle } from '../components';
import { useTheme } from '../theme';
import { EVM_CHAIN_ID } from '../wallet/send';
import { ChainAccount, useWallet } from '../wallet/WalletContext';
import { AccountSwitcher } from '../components/AccountSwitcher';
import { OfflineNotice } from '../wallet/connectivity';
import { usePrefs } from '../wallet/PrefsContext';
import { maskAmount } from '../config/prefs';
import { BalanceState, useBalances } from '../wallet/useBalances';
import { useTokenBalances } from '../wallet/useTokenBalances';
import { useAccountDelegation } from '../wallet/useDelegation';
import { useSessionEligibility } from '../wallet/useSessionEligibility';
import { useRecoveryInfo } from '../wallet/useRecoveryInfo';
import { usePasskeyInfo } from '../wallet/usePasskeyInfo';
import { shortAccountAddress } from '../wallet/accounts';
import { delegationLabelSuffix, FOREIGN_DELEGATE_WARNING } from '../wallet/delegation';
import { usePrices } from '../wallet/usePrices';
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

  if (!state || state.status === 'loading') {
    return <ActivityIndicator size="small" color={theme.textMuted} />;
  }
  if (state.status === 'ok') {
    // Read as one element: "Balance 0.5 ETH, about $1,234.56" (or "Balance
    // hidden" under Hide amounts, where the fiat line is masked too).
    const spokenFiat = fiat && !hidden ? `, about ${fiat.text.replace(/^≈\s*/, '')}` : '';
    const spokenStale = fiat?.staleNote && !hidden ? `, ${fiat.staleNote}` : '';
    return (
      <View
        style={styles.balanceCell}
        accessible
        accessibilityLabel={
          hidden ? 'Balance hidden' : `Balance ${state.display} ${state.symbol}${spokenFiat}${spokenStale}`
        }
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
        accessibilityLabel="Balance unavailable: no endpoint is configured for this chain"
      >
        <Text style={[styles.balance, { color: theme.textMuted }]}>—</Text>
        <Text style={[styles.balanceSymbol, { color: theme.textMuted }]}>no endpoint</Text>
      </View>
    );
  }
  // status === 'error': subtle, retryable. The full message would not fit a
  // row; the row communicates "couldn't load" and offers a retry.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Balance could not be loaded. Retry"
      accessibilityHint="Asks the network endpoint for this balance again"
      onPress={onRetry}
      hitSlop={8}
    >
      <View style={styles.balanceCell}>
        <Text style={[styles.balance, { color: theme.textMuted }]}>—</Text>
        <Text style={[styles.balanceSymbol, { color: theme.danger }]}>retry</Text>
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
  onSend: () => void;
  hidden: boolean;
  fiat: FiatDisplay | null;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.tokenRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={[styles.tokenBadge, { borderColor: theme.border }]}>
        <Text style={[styles.tokenBadgeText, { color: theme.textMuted }]}>
          {token.symbol.slice(0, 4)}
        </Text>
      </View>
      <View style={styles.cardBody}>
        <Text style={[styles.tokenName, { color: theme.text }]} numberOfLines={1}>
          {token.name}
        </Text>
        <Text style={[styles.tokenKind, { color: theme.textMuted }]}>ERC-20</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Send ${token.symbol}`}
          onPress={onSend}
          hitSlop={8}
        >
          <Text style={[styles.sendLink, { color: theme.accent }]}>Send ↗</Text>
        </Pressable>
      </View>
      <BalanceCell state={state} onRetry={onRetry} hidden={hidden} fiat={fiat} />
    </View>
  );
}

/** The four launch chains: address, live native balance, tap to receive. */
export function HomeScreen({ navigation }: Props) {
  const theme = useTheme();
  // The reserved account-tools row scales with the system text size, so a
  // larger font does not bring the layout shift back.
  const { fontScale } = useWindowDimensions();
  // `accounts` holds the ACTIVE account's addresses (phase 6 item 3);
  // switching accounts remounts the navigator (App.tsx), so this screen
  // never shows one account's balances under another's name.
  const { accounts, activeAccount } = useWallet();
  const { hideAmounts, setHideAmounts, evmChain, sepolia, showFiat } = usePrefs();
  // The active EVM chain is passed so a mode flip (mainnet <-> Sepolia)
  // re-fetches the EVM row (useBalances handles it).
  const { balances, refreshing, refreshAll, refreshOne } = useBalances(accounts, evmChain.caip2);
  const evmAccount = accounts.find((a) => a.chainId === EVM_CHAIN_ID);
  // EIP-7702 status of the active account on the active EVM chain (phase 8
  // item 1): shown under the account switcher so the user always knows
  // which code runs at the address.
  const delegation = useAccountDelegation(evmAccount?.address);
  // Session keys (phase 8 item 2): linked only when the active account has
  // a deployed Kernel account or an active EIP-7702 upgrade.
  const sessionsEligible = useSessionEligibility(evmAccount?.address, activeAccount?.index ?? null);
  // Guardians (phase 8 item 4): linked only for a deployed Kernel v3.3
  // account the active account owns; a recovered account gets a label; a
  // recovery in progress gets a "continue" line.
  const recovery = useRecoveryInfo(evmAccount?.address, activeAccount?.index ?? null);
  // Passkey signer (phase 8 item 3): linked only for a deployed Kernel v3.3
  // account the active account owns; the screen shows the development-build
  // note when the native module or the rpId is missing.
  const passkey = usePasskeyInfo(evmAccount?.address, activeAccount?.index ?? null);
  // Tracked tokens are Ethereum-mainnet assets; in Sepolia test mode the
  // token section is hidden entirely (fetching a mainnet contract's
  // balanceOf against a Sepolia endpoint would be wrong-chain noise).
  const showTokens = !evmChain.testnet;
  const { tokens, tokenBalances, reloadTokens, refreshToken } = useTokenBalances(
    showTokens ? evmAccount?.address : undefined,
  );

  // USD prices for the natives (all four in one request; null for the EVM
  // slot in Sepolia test mode) and the tracked tokens on the ACTIVE chain
  // (null for every token in test mode). The hook requests nothing while
  // "Show fiat values" is off.
  const priceIds = [
    ...nativePriceIds(sepolia),
    ...tokens.map((t) => (showTokens ? tokenPriceAssetId(t, evmChain.caip2) : null)),
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
      if (showTokens) void reloadTokens();
    }, [reloadTokens, showTokens]),
  );

  /** One text link in a chain card's link rows. */
  const cardLink = (key: string, label: string, text: string, onPress: () => void, hint?: string) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(hint !== undefined ? { accessibilityHint: hint } : {})}
      onPress={onPress}
      hitSlop={8}
    >
      <Text style={[styles.sendLink, { color: theme.accent }]}>{text}</Text>
    </Pressable>
  );

  // A chain card is a plain View holding SIBLING controls (phase 12 item 4):
  // the Receive area (badge, name and address), the balance cell and the
  // link rows. It used to be one Pressable wrapping the link Pressables,
  // which screen readers can merge into a single element so the inner
  // links were hard to reach; now every link is its own focusable button.
  const renderChainCard = ({ item }: { item: ChainAccount }) => {
    const isEvm = item.chainId === EVM_CHAIN_ID;
    // Account tools that appear only after asynchronous eligibility checks
    // (session keys, guardians, passkey). They get their own row with its
    // height reserved from the start, so nothing above or below moves when
    // they appear (finding F11: a tap aimed at Approvals once opened
    // Guardians because a link was inserted before it).
    const tools = isEvm
      ? [
          sessionsEligible
            ? cardLink('sessions', 'Sessions', 'Sessions', () => navigation.navigate('Sessions'))
            : null,
          recovery.guardiansEligible
            ? cardLink('guardians', 'Guardians', 'Guardians', () => navigation.navigate('Guardians'))
            : null,
          passkey.eligible
            ? cardLink(
                'passkey',
                passkey.record ? 'Passkey, added' : 'Passkey',
                passkey.record ? 'Passkey ✓' : 'Passkey',
                () => navigation.navigate('Passkey'),
              )
            : null,
        ].filter((link) => link !== null)
      : [];
    return (
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <View style={styles.cardTop}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${shortAddress(item.address)}`}
            accessibilityHint={`Opens the ${item.name} receive screen`}
            onPress={() => navigation.navigate('Receive', { chainId: item.chainId })}
            style={({ pressed }) => [styles.receiveArea, { opacity: pressed ? 0.7 : 1 }]}
          >
            <View style={[styles.badge, { backgroundColor: item.accent }]}>
              <Text style={styles.badgeText}>{item.symbol}</Text>
            </View>
            <View style={styles.cardBody}>
              <Text style={[styles.chainName, { color: theme.text }]}>{item.name}</Text>
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
          {cardLink('send', `Send ${item.symbol}`, 'Send ↗', () =>
            navigation.navigate('Send', { chainId: item.chainId }),
          )}
          {cardLink('activity', `${item.name} activity`, 'Activity', () =>
            navigation.navigate('Activity', { chainId: item.chainId }),
          )}
          {/* Swaps are an EVM feature (0x, phase 5 item 1); the screen
              itself explains and stays off until a key is configured. */}
          {isEvm ? cardLink('swap', 'Swap', 'Swap', () => navigation.navigate('Swap')) : null}
          {/* NFT gallery (phase 7 item 4) for the active EVM chain; the
              screen explains itself until an NFT indexer is configured. */}
          {isEvm ? cardLink('nfts', 'NFTs', 'NFTs', () => navigation.navigate('Nfts')) : null}
          {/* EIP-7702 account upgrade (phase 8 item 1) for the active
              account on the active EVM chain. */}
          {isEvm
            ? cardLink(
                'upgrade',
                delegation.status?.kind === 'kernel-v3.3' ? 'Account upgraded' : 'Upgrade this account',
                delegation.status?.kind === 'kernel-v3.3' ? 'Upgraded ✓' : 'Upgrade',
                () => navigation.navigate('UpgradeAccount'),
              )
            : null}
          {/* Token approvals manager (phase 7 item 5) for the active EVM
              chain; the screen explains what it can and cannot see. */}
          {isEvm
            ? cardLink('approvals', 'Token approvals', 'Approvals', () => navigation.navigate('Approvals'))
            : null}
        </View>
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

  // The Ethereum row carries its tracked ERC-20 tokens beneath it, plus the
  // entry point to the token management screen.
  const renderItem = ({ item }: { item: ChainAccount }) => {
    const card = renderChainCard({ item });
    if (item.chainId !== EVM_CHAIN_ID) return card;
    if (!showTokens) {
      return (
        <View style={styles.evmGroup}>
          {card}
          <Text style={[styles.testnetNote, { color: theme.textMuted }]}>
            Sepolia test mode — tracked tokens are mainnet assets and are
            hidden until test mode is turned off in Settings.
          </Text>
        </View>
      );
    }
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
            return (
              <TokenRow
                key={id}
                token={token}
                state={tokenBalances[id]}
                onRetry={() => void refreshToken(id)}
                onSend={() =>
                  navigation.navigate('Send', { chainId: EVM_CHAIN_ID, tokenId: id })
                }
                hidden={hideAmounts}
                fiat={fiatFor(tokenState, priceId)}
              />
            );
          })}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Manage tokens"
            onPress={() => navigation.navigate('Tokens')}
            hitSlop={8}
          >
            <Text style={[styles.manageTokens, { color: theme.accent }]}>Manage tokens</Text>
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
            <AccountSwitcher onManage={() => navigation.navigate('Settings')} />
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
                accessibilityHint="Continues the recovery in progress"
                onPress={() => navigation.navigate('RecoverAccount')}
                hitSlop={8}
              >
                <Text style={[styles.delegationLine, { color: theme.accent }]}>
                  Recovering an account with guardians — tap to continue
                </Text>
              </Pressable>
            ) : null}
            {/* Quick balance-privacy toggle (the same setting lives in
                Settings -> Privacy & security); the eye glyph masks every
                amount on this screen and on Activity as ••••. */}
            <View style={styles.privacyRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={hideAmounts ? 'Show amounts' : 'Hide amounts'}
                accessibilityHint="Masks or reveals every amount on this screen and on Activity"
                onPress={() => void setHideAmounts(!hideAmounts)}
                hitSlop={8}
              >
                <Text style={[styles.privacyToggle, { color: theme.accent }]}>
                  {hideAmounts ? '👁 Show amounts' : '👁 Hide amounts'}
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
            }}
            tintColor={theme.textMuted}
            colors={[theme.accent]}
          />
        }
        ListFooterComponent={
          <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Recover an account with guardians"
            onPress={() => navigation.navigate('RecoverAccount')}
            hitSlop={8}
          >
            <Text style={[styles.manageTokens, styles.recoverLink, { color: theme.accent }]}>
              Lost a recovery phrase? Recover an account with guardians
            </Text>
          </Pressable>
          <Text style={[styles.footer, { color: theme.textMuted }]}>
            {activeAccount ? `${activeAccount.name}'s` : 'Your'} addresses, derived on
            this device from your recovery phrase (one phrase backs up every
            account). Balances come from the RPC endpoints in Settings; pull
            down to refresh. Tap a chain to receive, or use its Send link —
            tokens have their own Send link and pay their network fee in ETH.
            {showFiat
              ? ' USD values are indicative prices from CoinGecko (Settings → Prices).'
              : ''}
          </Text>
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
  badgeText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  cardBody: {
    flex: 1,
    gap: 4,
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
    width: 36,
    height: 36,
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
  testnetNote: {
    fontSize: 12,
    lineHeight: 17,
    marginLeft: 20,
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

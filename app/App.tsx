import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  NavigationContainerRefContext,
  StackActions,
  Theme as NavTheme,
  type NavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { RootStackParamList } from './src/navigation';
import { useTheme } from './src/theme';
import { WalletProvider, useWallet } from './src/wallet/WalletContext';
import { PrefsProvider, usePrefs } from './src/wallet/PrefsContext';
import { LockGate } from './src/components/LockGate';
import { WalletConnectProvider } from './src/wallet/WalletConnectContext';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { BackupScreen } from './src/screens/BackupScreen';
import { ConfirmBackupScreen } from './src/screens/ConfirmBackupScreen';
import { ImportScreen } from './src/screens/ImportScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { ReceiveScreen } from './src/screens/ReceiveScreen';
import { SendScreen } from './src/screens/SendScreen';
import { ActivityScreen } from './src/screens/ActivityScreen';
import { SwapScreen } from './src/screens/SwapScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TokensScreen } from './src/screens/TokensScreen';
import { ConnectionsScreen } from './src/screens/ConnectionsScreen';
import { ContactsScreen } from './src/screens/ContactsScreen';
import { NftsScreen } from './src/screens/NftsScreen';
import { NftDetailScreen } from './src/screens/NftDetailScreen';
import { ApprovalsScreen } from './src/screens/ApprovalsScreen';
import { UpgradeAccountScreen } from './src/screens/UpgradeAccountScreen';
import { SessionsScreen } from './src/screens/SessionsScreen';
import { GuardiansScreen } from './src/screens/GuardiansScreen';
import { RecoverAccountScreen } from './src/screens/RecoverAccountScreen';
import { ApproveRecoveryScreen } from './src/screens/ApproveRecoveryScreen';
import { OwnerRotationScreen } from './src/screens/OwnerRotationScreen';
import { InheritanceScreen } from './src/screens/InheritanceScreen';
import { PasskeyScreen } from './src/screens/PasskeyScreen';
import { ProveOwnershipScreen } from './src/screens/ProveOwnershipScreen';
import { SpendingLimitsScreen } from './src/screens/SpendingLimitsScreen';
import { ImportKeyScreen } from './src/screens/ImportKeyScreen';
import { BrowserScreen } from './src/screens/BrowserScreen';
import { MultisigScreen } from './src/screens/MultisigScreen';
import { StakingScreen } from './src/screens/StakingScreen';
import { BridgeScreen } from './src/screens/BridgeScreen';
import { watchOnlyScreenLayout } from './src/components/WatchOnlyGate';
import { RecurringDueBanner } from './src/components/RecurringDueBanner';
import { NotificationScheduler } from './src/components/NotificationScheduler';
import { PriceAlertMonitor } from './src/components/PriceAlertMonitor';
import { PortfolioScreen } from './src/screens/PortfolioScreen';
import { PriceAlertsScreen } from './src/screens/PriceAlertsScreen';
import { ColdSignScreen } from './src/screens/ColdSignScreen';
import { HandleScreen } from './src/screens/HandleScreen';
import { appScreenProtection } from './src/wallet/screen-protection';
import { applyNavigationBarStyle, loadNavigationBarNative } from './src/wallet/navigation-bar';
import { appLanguage } from './src/i18n/app-language';
import { testnetBannerText } from './src/i18n/banner';
import { tx } from './src/i18n/index';
import { useI18n } from './src/i18n/useI18n';
import { InboxScreen } from './src/screens/InboxScreen';
import { Button } from './src/components';
import { useAppLock } from './src/components/LockGate';
import { appInbox, wcSentInboxEvent } from './src/wallet/inbox';
import { onWcSentShown } from './src/wallet/wc-sent';
import { listTokens } from './src/wallet/tokens';
import { EVM_CHAIN_ID } from './src/wallet/send';
import {
  DEEP_LINK_NO_WALLET_SENTENCE,
  DEEP_LINK_UNKNOWN_SENTENCE,
  appDeepLinks,
  deepLinkGate,
  parseDeepLink,
  planDeepLink,
} from './src/wallet/deep-links';

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * App-wide screen protection (phase 17 item 0; src/wallet/screen-protection.ts).
 * Mounted first inside PrefsProvider: its first effect runs before the stored
 * preference is loaded and therefore protects at once; once the preference is
 * known, a stored "off" releases the app-wide protection. Renders nothing.
 */
function ScreenProtection() {
  const { ready, screenProtection } = usePrefs();
  React.useEffect(() => {
    void appScreenProtection().update({ prefsLoaded: ready, enabled: screenProtection });
  }, [ready, screenProtection]);
  return null;
}

/**
 * The Android navigation bar's button style, set from the app's colour scheme
 * at launch and again on every scheme change (phase 23 item 2; pass p20c
 * finding 15: a white strip under the TESTNET banner in dark mode). React
 * Native sets the bar's appearance only once, when the window is created
 * (react-native 0.86.3 ReactAndroid views/view/WindowUtil.kt
 * enableEdgeToEdge, lines 164-190, with enforceNavigationBarContrast on by
 * default), so a scheme switched while the app runs left the light
 * appearance in place. src/wallet/navigation-bar.ts does the work through
 * the wallet's own local Expo module ShibaNavigationBar
 * (app/modules/shiba-navigation-bar), which sets the appearance through the
 * platform API on Android 12 and up, and falls back to expo-navigation-bar
 * 57.0.3's setStyle where that module is absent (Expo Go). Pass p23-navbar
 * established why setStyle alone did not follow a runtime scheme change: on
 * API 30-34 it writes only a deprecated view flag, which Android ignores once
 * React Native's StatusBar has set the window's appearance through the
 * platform API (see navigation-bar.ts). Android only, nothing when both
 * modules are absent, and a failure is one log line, never a crash. The
 * bar's background cannot be set; it stays transparent. Mounted beside the
 * status bar's own component; it needs no wallet or preference state.
 * Renders nothing. Each attempt's outcome, with the path that ran, is shown
 * in Settings → Developer.
 */
function NavigationBarStyle() {
  const theme = useTheme();
  React.useEffect(() => {
    // __DEV__: a development bundle also logs a missing module (pass
    // p23-build finding 3); every outcome is recorded for Settings → Developer.
    void applyNavigationBarStyle(loadNavigationBarNative, theme.dark, undefined, { dev: __DEV__ });
  }, [theme.dark]);
  return null;
}

/**
 * Persistent orange TESTNET banner (phase 4, item 6), shown whenever the
 * Settings test mode is on (Ethereum Sepolia or Base Sepolia). Anchored at the bottom of the window
 * (respecting the home-indicator inset) so it never fights the native
 * stack headers for the status-bar area, and rendered outside the
 * navigator so it stays visible on every screen.
 */
function TestnetBanner() {
  const insets = useSafeAreaInsets();
  // The active test profile carries its own banner sentence (Ethereum
  // Sepolia or Base Sepolia); the Sepolia wording is kept verbatim.
  const { evmChain } = usePrefs();
  // Colours come from the theme tokens like every other TESTNET badge
  // (theme-palette.ts): the light palette's darker orange with white text,
  // and the dark palette's orange with dark text, both above 4.5:1.
  const theme = useTheme();
  // In the active language (phase 22 item 6; src/i18n/banner.ts reads the
  // network name back out of the profile's English sentence).
  useI18n();
  const text = testnetBannerText(evmChain.bannerText ?? 'TESTNET — Sepolia test mode is on. Amounts are test ETH, not real funds.');
  return (
    <View style={[styles.testnetBanner, { backgroundColor: theme.testnetFill, paddingBottom: Math.max(insets.bottom, 8) }]}>
      <Text style={[styles.testnetBannerText, { color: theme.onTestnetFill }]}>{text}</Text>
    </View>
  );
}

/**
 * Deep links into the wallet's own screens (feature 80; src/wallet/deep-links.ts).
 * Mounted once inside the navigation container, after the banners. A link
 * waits in the app's link source (appDeepLinks, started in App below so a
 * link arriving behind the PIN pad is not lost) until deepLinkGate allows
 * acting on it: never while the wallet is loading or locked. Then it opens
 * an allow-listed screen, or a NEW Send screen pre-filled from a payment
 * request through the same parser as a scanned one; anything else gets a
 * plain notice. Nothing here signs, prompts or makes a network request; the
 * opened screen's own gates apply. React Navigation's `linking` option is
 * not used: it builds the container's state synchronously from the path and
 * dispatches a link the moment it arrives (@react-navigation/native 7.4.1
 * src/useLinking.native.tsx lines 157-182 and 186-222), with no way to hold
 * a link behind the lock or to read the tracked tokens a payment request is
 * checked against, and it would read the launch link again on every
 * remount of this keyed container (getInitialURL, lines 27-35).
 */
function DeepLinkHandler() {
  const theme = useTheme();
  const nav = React.useContext(NavigationContainerRefContext) as NavigationContainerRef<RootStackParamList> | undefined;
  const { status, accounts, activeAccount } = useWallet();
  const { evmChain } = usePrefs();
  const { locked } = useAppLock();
  const watchOnly = activeAccount?.watchOnly === true;
  const [notice, setNotice] = React.useState<string | null>(null);
  const [arrivals, setArrivals] = React.useState(0);
  const [navReady, setNavReady] = React.useState(false);

  React.useEffect(() => appDeepLinks().subscribe(() => setArrivals((n) => n + 1)), []);
  React.useEffect(() => {
    if (!nav) return undefined;
    const ready = () => setNavReady(nav.isReady());
    ready();
    return nav.addListener('ready', ready);
  }, [nav]);

  React.useEffect(() => {
    if (!nav) return;
    const gate = deepLinkGate({ status, locked, navReady });
    if (gate === 'wait' || appDeepLinks().peek() === null) return;
    const url = appDeepLinks().take();
    const link = parseDeepLink(url);
    if (gate === 'no-wallet') {
      if (link.kind !== 'ignore') setNotice(DEEP_LINK_NO_WALLET_SENTENCE);
      return;
    }
    void planDeepLink(link, {
      evmProfile: evmChain,
      trackedTokens: (caip2) => listTokens(caip2),
      nativeFor: (slot) => {
        const account = accounts.find((a) => a.chainId === slot);
        return account ? { symbol: account.symbol, networkLabel: account.name } : null;
      },
      hasEvmAccount: accounts.some((a) => a.chainId === EVM_CHAIN_ID),
      watchOnly,
    }).then(
      (action) => {
        if (!nav.isReady()) return;
        switch (action.kind) {
          case 'none':
            return;
          case 'notice':
            setNotice(action.text);
            return;
          case 'home':
            setNotice(null);
            if (nav.getCurrentRoute()?.name !== 'Home') nav.dispatch(StackActions.popTo('Home'));
            return;
          case 'navigate':
            setNotice(null);
            if (action.params) nav.navigate(action.route as 'Activity', action.params);
            else nav.navigate(action.route as 'Inbox');
            return;
          case 'send':
            setNotice(null);
            nav.dispatch(StackActions.push('Send', action.params));
            return;
          case 'cold-sign':
            // A watch-only account: the cold-signing screen (pass p22b).
            setNotice(null);
            nav.dispatch(StackActions.push('ColdSign', action.params));
            return;
        }
      },
      () => setNotice(DEEP_LINK_UNKNOWN_SENTENCE),
    );
  }, [nav, status, locked, navReady, arrivals, evmChain, accounts, watchOnly]);

  if (!notice) return null;
  return (
    <View style={[styles.linkNotice, { backgroundColor: theme.card, borderColor: theme.accent }]}>
      <Text accessibilityLiveRegion="polite" style={[styles.linkNoticeText, { color: theme.text }]}>
        {notice}
      </Text>
      <Button title="Dismiss" variant="secondary" onPress={() => setNotice(null)} />
    </View>
  );
}

/**
 * Renders the onboarding stack while no wallet exists and the main stack
 * once one does. Because the two sets are mutually exclusive, completing
 * onboarding (or wiping the wallet) switches stacks automatically — no
 * manual "reset navigation" calls needed.
 */
function Root() {
  const theme = useTheme();
  // The header's Settings button label follows the language (phase 22 item 6).
  useI18n();
  const { status, activeAccount } = useWallet();
  const { sepolia } = usePrefs();

  if (status === 'loading') {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.background,
        }}
      >
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  const navTheme: NavTheme = {
    ...(theme.dark ? DarkTheme : DefaultTheme),
    colors: {
      ...(theme.dark ? DarkTheme : DefaultTheme).colors,
      background: theme.background,
      card: theme.card,
      text: theme.text,
      border: theme.border,
      primary: theme.accent,
    },
  };

  return (
    <View style={styles.fill}>
      {/* Keyed on the active account (phase 6 item 3): switching accounts
          remounts the whole navigator, back to Home, so no screen keeps a
          quote, balance, history page or form prepared for the previous
          account. Signing is additionally guarded in WalletContext.signWith. */}
      <NavigationContainer key={`account-${activeAccount?.index ?? 0}`} theme={navTheme}>
        {/* Every route outside the watch-only allow list renders a refusal
            instead of its screen while a watch-only account is active. */}
        <Stack.Navigator screenLayout={watchOnlyScreenLayout}>
        {status === 'no-wallet' ? (
          <>
            <Stack.Screen
              name="Welcome"
              component={WelcomeScreen}
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="Backup"
              component={BackupScreen}
              options={{ title: 'Back up' }}
            />
            <Stack.Screen
              name="ConfirmBackup"
              component={ConfirmBackupScreen}
              options={{ title: 'Confirm' }}
            />
            <Stack.Screen
              name="Import"
              component={ImportScreen}
              options={{ title: 'Import' }}
            />
          </>
        ) : (
          <>
            <Stack.Screen
              name="Home"
              component={HomeScreen}
              options={({ navigation }) => ({
                title: 'Shiba Wallet',
                headerRight: () => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={tx('Settings')}
                    onPress={() => navigation.navigate('Settings')}
                    hitSlop={8}
                  >
                    <Text style={{ fontSize: 20, color: theme.accent }}>⚙︎</Text>
                  </Pressable>
                ),
              })}
            />
            <Stack.Screen name="Receive" component={ReceiveScreen} />
            <Stack.Screen name="Send" component={SendScreen} />
            <Stack.Screen name="Activity" component={ActivityScreen} />
            <Stack.Screen name="Swap" component={SwapScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="Tokens" component={TokensScreen} />
            <Stack.Screen
              name="Connections"
              component={ConnectionsScreen}
              options={{ title: 'Connected apps' }}
            />
            <Stack.Screen name="Contacts" component={ContactsScreen} />
            <Stack.Screen name="Nfts" component={NftsScreen} options={{ title: 'NFTs' }} />
            <Stack.Screen name="NftDetail" component={NftDetailScreen} options={{ title: 'NFT' }} />
            <Stack.Screen
              name="Approvals"
              component={ApprovalsScreen}
              options={{ title: 'Token approvals' }}
            />
            <Stack.Screen
              name="UpgradeAccount"
              component={UpgradeAccountScreen}
              options={{ title: 'Upgrade this account' }}
            />
            <Stack.Screen name="Sessions" component={SessionsScreen} options={{ title: 'Sessions' }} />
            <Stack.Screen name="Guardians" component={GuardiansScreen} options={{ title: 'Guardians' }} />
            <Stack.Screen
              name="RecoverAccount"
              component={RecoverAccountScreen}
              options={{ title: 'Recover an account' }}
            />
            <Stack.Screen
              name="ApproveRecovery"
              component={ApproveRecoveryScreen}
              options={{ title: 'Approve a recovery' }}
            />
            <Stack.Screen name="Passkey" component={PasskeyScreen} options={{ title: 'Passkey' }} />
            <Stack.Screen name="OwnerRotation" component={OwnerRotationScreen} options={{ title: 'Change owner' }} />
            <Stack.Screen name="Inheritance" component={InheritanceScreen} options={{ title: 'Inheritance (demonstration)' }} />
            <Stack.Screen name="ProveOwnership" component={ProveOwnershipScreen} options={{ title: 'Prove ownership' }} />
            <Stack.Screen
              name="SpendingLimits"
              component={SpendingLimitsScreen}
              options={{ title: 'Spending limits' }}
            />
            <Stack.Screen name="ImportKey" component={ImportKeyScreen} options={{ title: 'Import a private key' }} />
            {/* The in-app browser (feature 79): outside the watch-only allow list. */}
            <Stack.Screen name="Apps" component={BrowserScreen} options={{ title: 'Apps (test networks)' }} />
            <Stack.Screen name="Multisig" component={MultisigScreen} options={{ title: 'Multi-signature accounts' }} />
            <Stack.Screen name="Staking" component={StakingScreen} options={{ title: 'Staking (test networks)' }} />
            <Stack.Screen name="Bridge" component={BridgeScreen} options={{ title: 'Bridge (test networks)' }} />
            <Stack.Screen name="Portfolio" component={PortfolioScreen} options={{ title: 'Portfolio' }} />
            <Stack.Screen name="PriceAlerts" component={PriceAlertsScreen} options={{ title: 'Price alerts' }} />
            <Stack.Screen name="ColdSign" component={ColdSignScreen} options={{ title: 'Send with an off-line signer' }} />
            <Stack.Screen name="Handle" component={HandleScreen} options={{ title: 'Wallet handle (ENS)' }} />
            <Stack.Screen name="Inbox" component={InboxScreen} options={{ title: 'Inbox' }} />
          </>
        )}
        </Stack.Navigator>
        <PriceAlertMonitor />
        <NotificationScheduler />
        {/* Recurring payments (phase 15 item 1): on start and on every return to
            the foreground, shows which are due; never sends anything. */}
        <RecurringDueBanner />
        <DeepLinkHandler />
      </NavigationContainer>
      {sepolia && status === 'ready' ? <TestnetBanner /> : null}
    </View>
  );
}

export default function App() {
  // Deep links (src/wallet/deep-links.ts): listen from the first render, so a
  // link that arrives while the PIN pad or the lock holds the wallet waits
  // instead of being lost. The inbox (src/wallet/inbox.ts) lists every sent
  // view of a WalletConnect or in-app-browser request once.
  // Localisation (phase 22 item 6): the device's language is applied during
  // this first render, before any screen renders text, then the choice
  // stored under Settings → Language (src/i18n/app-language.ts; one
  // AsyncStorage read). start() runs once whatever React does with the
  // initializer.
  React.useState(() => appLanguage().start());
  React.useEffect(() => {
    appDeepLinks().start();
    return onWcSentShown((result) => void appInbox().record(wcSentInboxEvent(result, Date.now())));
  }, []);
  return (
    <SafeAreaProvider>
      <PrefsProvider>
        <ScreenProtection />
        <WalletProvider>
          <StatusBar style="auto" />
          <NavigationBarStyle />
          {/* LockGate sits inside both providers (it needs wallet status and
              the auto-lock preference) and wraps the whole navigator so the
              lock overlay covers every screen without resetting navigation. */}
          <LockGate>
            {/* WalletConnect lives INSIDE LockGate: its approval sheet is an
                in-tree overlay that the lock overlay covers, and it reads
                the lock state to hold approvals until unlock. Mounted once,
                so dApp requests surface on every screen. */}
            <WalletConnectProvider>
              <Root />
            </WalletConnectProvider>
          </LockGate>
        </WalletProvider>
      </PrefsProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  testnetBanner: {
    paddingTop: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  linkNotice: { borderTopWidth: 2, paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  linkNoticeText: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  testnetBannerText: {
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
});

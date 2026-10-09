import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  Theme as NavTheme,
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
import { watchOnlyScreenLayout } from './src/components/WatchOnlyGate';
import { RecurringDueBanner } from './src/components/RecurringDueBanner';

const Stack = createNativeStackNavigator<RootStackParamList>();

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
  const text = evmChain.bannerText ?? 'TESTNET — Sepolia test mode is on. Amounts are test ETH, not real funds.';
  return (
    <View style={[styles.testnetBanner, { backgroundColor: theme.testnetFill, paddingBottom: Math.max(insets.bottom, 8) }]}>
      <Text style={[styles.testnetBannerText, { color: theme.onTestnetFill }]}>{text}</Text>
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
                    accessibilityLabel="Settings"
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
              options={{ title: 'WalletConnect' }}
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
          </>
        )}
        </Stack.Navigator>
        {/* Recurring payments (phase 15 item 1): on start and on every return to
            the foreground, shows which are due; never sends anything. */}
        <RecurringDueBanner />
      </NavigationContainer>
      {sepolia && status === 'ready' ? <TestnetBanner /> : null}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <PrefsProvider>
        <WalletProvider>
          <StatusBar style="auto" />
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
  testnetBannerText: {
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
});

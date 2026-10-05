import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { WatchOnlyNotice, screenStyle } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import { watchOnlyRouteRefusal } from '../wallet/watch-only';

/**
 * Route gate for watch-only accounts (feature 10). While the active account
 * is watch-only, every route outside watch-only.ts WATCH_ONLY_ALLOWED_ROUTES
 * renders this refusal INSTEAD of the screen: the screen never mounts, so
 * it makes no network request and raises no prompt. For any other account
 * the screen renders unchanged.
 *
 * Wired into the navigator with React Navigation 7's `screenLayout` prop
 * (watchOnlyScreenLayout below), which wraps every screen of the stack;
 * App.tsx's NavigationContainer is keyed on the active account, so a switch
 * re-evaluates the gate for every screen.
 */
export function WatchOnlyRouteGate({ routeName, children }: { routeName: string; children: React.ReactNode }) {
  const theme = useTheme();
  const { activeAccount } = useWallet();
  const refusal = activeAccount?.watchOnly ? watchOnlyRouteRefusal(routeName) : null;
  if (refusal === null) return <>{children}</>;
  return (
    <View style={screenStyle(theme)}>
      <ScrollView contentContainerStyle={styles.body}>
        <WatchOnlyNotice />
        <Text style={[styles.refusal, { color: theme.text }]} accessibilityRole="text">
          {refusal}
        </Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          {activeAccount ? `Active account: ${activeAccount.name}.` : ''} Use the account switcher on Home to
          change accounts.
        </Text>
      </ScrollView>
    </View>
  );
}

/** For `<Stack.Navigator screenLayout={watchOnlyScreenLayout}>` (React Navigation 7). */
export function watchOnlyScreenLayout({
  route,
  children,
}: {
  route: { name: string };
  children: React.ReactNode;
}): React.ReactElement {
  return <WatchOnlyRouteGate routeName={route.name}>{children}</WatchOnlyRouteGate>;
}

const styles = StyleSheet.create({
  body: {
    padding: 16,
    gap: 12,
  },
  refusal: {
    fontSize: 15,
    lineHeight: 21,
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
});

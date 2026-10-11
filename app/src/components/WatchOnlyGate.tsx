import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, WarningBox, WatchOnlyNotice, screenStyle } from '../components';
import { useTheme } from '../theme';
import { useWallet } from '../wallet/WalletContext';
import {
  MULTISIG_ACCOUNT_NOTICE,
  MULTISIG_OPEN_SCREEN_BUTTON,
  multisigRouteRefusal,
  multisigSignerHint,
  watchOnlyRouteRefusal,
} from '../wallet/watch-only';

/**
 * The route gate for accounts no key of this wallet can sign for alone:
 *  - a WATCH-ONLY account (feature 10): every route outside watch-only.ts
 *    WATCH_ONLY_ALLOWED_ROUTES renders the watch-only refusal;
 *  - a MULTI-SIGNATURE account (feature 24; phase 18 item 3): every route
 *    outside MULTISIG_ALLOWED_ROUTES renders the multisig refusal (Send gets
 *    its own sentence, MULTISIG_SEND_REFUSAL), with a button to the Multisig
 *    screen and the account that builds its operations.
 * The refusal renders INSTEAD of the screen: the screen never mounts, so it
 * makes no network request and raises no prompt. For any other account the
 * screen renders unchanged.
 *
 * Wired into the navigator with React Navigation 7's `screenLayout` prop
 * (watchOnlyScreenLayout below), which wraps every screen of the stack;
 * App.tsx's NavigationContainer is keyed on the active account, so a switch
 * re-evaluates the gate for every screen.
 */
export function WatchOnlyRouteGate({
  routeName,
  children,
  onOpenMultisig,
}: {
  routeName: string;
  children: React.ReactNode;
  /** Opens the Multisig screen (from the navigator); the button is shown only when given. */
  onOpenMultisig?: () => void;
}) {
  const theme = useTheme();
  const { activeAccount, accountForEvmAddress } = useWallet();
  const multisig = activeAccount?.multisig === true;
  const refusal = activeAccount?.watchOnly
    ? watchOnlyRouteRefusal(routeName)
    : multisig
      ? multisigRouteRefusal(routeName)
      : null;
  if (refusal === null) return <>{children}</>;
  const info = multisig ? (activeAccount?.multisigInfo ?? null) : null;
  return (
    <View style={screenStyle(theme)}>
      <ScrollView contentContainerStyle={styles.body}>
        {multisig ? <WarningBox>{MULTISIG_ACCOUNT_NOTICE}</WarningBox> : <WatchOnlyNotice />}
        <Text style={[styles.refusal, { color: theme.text }]} accessibilityRole="text">
          {refusal}
        </Text>
        {info ? (
          <Text style={[styles.hint, { color: theme.text }]}>
            {multisigSignerHint(info.label, accountForEvmAddress(info.localSigner)?.name ?? null, info.localSigner)}
          </Text>
        ) : null}
        {multisig && onOpenMultisig ? <Button title={MULTISIG_OPEN_SCREEN_BUTTON} onPress={onOpenMultisig} /> : null}
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
  navigation,
  children,
}: {
  route: { name: string };
  navigation?: { navigate: (name: 'Multisig') => void };
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <WatchOnlyRouteGate
      routeName={route.name}
      {...(navigation ? { onOpenMultisig: () => navigation.navigate('Multisig') } : {})}
    >
      {children}
    </WatchOnlyRouteGate>
  );
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

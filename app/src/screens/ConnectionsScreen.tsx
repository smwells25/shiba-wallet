import React, { useEffect, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { QrScanner } from '../components/QrScanner';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { describeChain, validatePairingUri } from '../wallet/walletconnect';
import { useWalletConnect, type WcSessionView } from '../wallet/WalletConnectContext';
import { OfflineNotice, TechnicalDetail, describeNetworkError } from '../wallet/connectivity';
import { sanitizeEndpointMessage } from '../config/endpoint-probe';
import { isBrowserTopic } from '../wallet/browser-bridge';

type Props = NativeStackScreenProps<RootStackParamList, 'Connections'>;

/** The screen's title: it lists WalletConnect AND in-app browser connections. */
export const CONNECTIONS_SCREEN_TITLE = 'Connected apps';

/**
 * "Connected apps": in-app browser connections, then WalletConnect —
 * QR-scan or paste-URI pairing, the active session list, and recent
 * automatic declines. Scanning (phase 4 item 4)
 * goes through the shared QrScanner (expo-camera, bundled in Expo Go SDK
 * 57 — see ../components/QrScanner.tsx for the verification notes) and
 * feeds the exact same pairing path as pasting: validatePairingUri, then
 * walletKit.pair. Pasting remains fully supported — scanning is only a
 * convenience and a denied camera permission blocks nothing.
 *
 * Proposals and sign/transaction requests are NOT handled here any more:
 * the app-level WalletConnectProvider (../wallet/WalletConnectContext)
 * listens for them on every screen and shows the approval sheet. Opening
 * this screen starts the SDK if it is not running yet (the lazy path for
 * devices where WalletConnect has not been used).
 *
 * In-app browser connections (feature 79) are listed in their own section,
 * labelled with the site's origin, and can be disconnected here whether or
 * not WalletConnect is configured or running (they do not use the relay).
 */
export function ConnectionsScreen({ navigation }: Props) {
  const theme = useTheme();
  const { evmChain } = usePrefs();
  const wc = useWalletConnect();
  const { ensureStarted } = wc;
  const [uri, setUri] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);

  // The route is registered with the older title "WalletConnect" (App.tsx);
  // the screen names itself before the first paint, like other screens do.
  useLayoutEffect(() => {
    navigation.setOptions({ title: CONNECTIONS_SCREEN_TITLE });
  }, [navigation]);

  useEffect(() => {
    ensureStarted();
  }, [ensureStarted]);

  // One pairing path for both entry points: the paste field's Connect
  // button and the QR scanner both come through here, so validation
  // (validatePairingUri) and the SDK call are identical either way.
  const pairWith = async (candidate: string) => {
    if (!wc.client) return;
    const checked = validatePairingUri(candidate);
    if (!checked.ok) {
      Alert.alert('Invalid pairing URI', checked.error);
      return;
    }
    setPairBusy(true);
    try {
      await wc.pair(checked.uri);
      setUri('');
      // The session_proposal event opens the app-level approval sheet.
    } catch (e) {
      // Same wording rules as the other network screens: a calm sentence,
      // then the cleaned technical text (an Alert cannot host the
      // TechnicalDetail component, so it is appended as a labelled line).
      const { detail, technical } = describeNetworkError(e, 'the pairing');
      Alert.alert(
        'Pairing failed',
        technical ? `${detail}\n\nTechnical detail: ${technical}` : detail,
      );
    } finally {
      setPairBusy(false);
    }
  };

  const wcSessions = wc.sessions.filter((session) => !isBrowserTopic(session.topic));
  const browserSessions = wc.sessions.filter((session) => isBrowserTopic(session.topic));

  const onDisconnect = (session: WcSessionView) => {
    Alert.alert('Disconnect?', `End the connection with ${session.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => void wc.disconnect(session.topic),
      },
    ]);
  };

  // ------------------------------------------------------------- gates
  if (wc.projectId === undefined) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  const browserSection =
    browserSessions.length > 0 ? (
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>In-app browser connections</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Sites opened from Apps (test networks only). Each is connected for one account on one network; disconnecting
          stops it from seeing your address until you connect again. A site that is open in Apps can also be
          disconnected from the Connection button on its browser bar.
        </Text>
        {browserSessions.map((session) => (
          <SessionCard key={session.topic} session={session} onDisconnect={onDisconnect} />
        ))}
      </View>
    ) : null;

  if (wc.projectId === null) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        {browserSection}
        <Text style={[styles.sectionTitle, { color: theme.text }]}>WalletConnect is off</Text>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          Connecting to dApps uses the WalletConnect relay network, which
          requires a project id. Create one for free at dashboard.reown.com
          (no personal data from this wallet is involved — the id only
          identifies the app to the relay), then save it in Settings under
          &quot;WalletConnect&quot;.
        </Text>
        <Button title="Open Settings" onPress={() => navigation.navigate('Settings')} />
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {wc.initBusy ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Connecting to the WalletConnect relay…
          </Text>
        </View>
      ) : null}

      <OfflineNotice />

      {browserSection}

      {wc.initError ? (
        <>
          <WarningBox>
            WalletConnect could not start. Check the project id in Settings and
            the network connection, then try again. If you changed the project
            id, restart the app.
          </WarningBox>
          {/* WalletConnectContext keeps only the error's message; it gets
              the same cleaning as describeNetworkFailure's technical text. */}
          <TechnicalDetail text={sanitizeEndpointMessage(wc.initError) || null} />
          {/* ensureStarted re-runs a failed start (WalletConnectContext). */}
          <Button
            title="Try again"
            variant="secondary"
            onPress={ensureStarted}
            disabled={wc.initBusy}
          />
        </>
      ) : null}

      {wc.client ? (
        <>
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Connect a dApp with WalletConnect</Text>
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              In the dApp, choose WalletConnect, then scan its QR code — or
              copy the pairing link (wc:…) and paste it here. The wallet
              connects on {describeChain(evmChain.caip2)} (the active chain;
              change it in Settings → Developer). Requests from connected
              dApps appear on whatever screen you are on. When a smart
              account is set up for this chain (Settings → Account
              Abstraction), the connection request lets you connect the
              smart account instead of the regular account.
            </Text>
            <Button
              title="Scan QR code"
              accessibilityLabel="Scan a WalletConnect QR code"
              variant="secondary"
              onPress={() => setScannerOpen(true)}
              disabled={pairBusy}
            />
            <TextInput
              value={uri}
              onChangeText={setUri}
              accessibilityLabel="WalletConnect pairing link"
              placeholder="wc:…"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.input,
                { color: theme.text, borderColor: theme.border, backgroundColor: theme.card },
              ]}
            />
            <Button
              title={pairBusy ? 'Connecting…' : 'Connect'}
              onPress={() => void pairWith(uri)}
              disabled={pairBusy || uri.trim() === ''}
            />
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>WalletConnect connections</Text>
            {wcSessions.length === 0 ? (
              <Text style={[styles.hint, { color: theme.textMuted }]}>
                No dApps are connected through WalletConnect.
              </Text>
            ) : (
              wcSessions.map((session) => (
                <SessionCard key={session.topic} session={session} onDisconnect={onDisconnect} />
              ))
            )}
          </View>

          {wc.notices.length > 0 ? (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Recent activity</Text>
              {wc.notices.map((n) => (
                <Text key={n.id} style={[styles.hint, { color: theme.textMuted }]}>
                  {n.text}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      <QrScanner
        visible={scannerOpen}
        rationale="Point the camera at the dApp's WalletConnect QR code. The camera is only used to read the code."
        onScanned={(data) => {
          setScannerOpen(false);
          // Show what was scanned in the field, then run the same
          // validate-and-pair path as the Connect button.
          setUri(data);
          void pairWith(data);
        }}
        onClose={() => setScannerOpen(false)}
      />
    </ScrollView>
  );
}

/** One connection: name, URL, chains, account, pause notes and Disconnect. */
function SessionCard({
  session,
  onDisconnect,
}: {
  session: WcSessionView;
  onDisconnect: (session: WcSessionView) => void;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.cardTitle, { color: theme.text }]}>{session.name}</Text>
      {session.url ? (
        <Text style={[styles.cardLine, { color: theme.textMuted }]} numberOfLines={1}>
          {session.url}
        </Text>
      ) : null}
      <Text style={[styles.cardLine, { color: theme.textMuted }]}>
        {session.chains.join(', ') || 'no chains'} ·{' '}
        {session.methods.length} method{session.methods.length === 1 ? '' : 's'}
      </Text>
      {session.accountLabel || session.addresses[0] ? (
        <Text style={[styles.cardLine, { color: theme.textMuted }]}>
          Account: {session.accountLabel ?? session.addresses[0]}
        </Text>
      ) : null}
      {session.modeNote ? (
        <Text style={[styles.cardLine, { color: theme.warningText }]}>{session.modeNote}</Text>
      ) : null}
      {session.accountNote ? (
        <Text style={[styles.cardLine, { color: theme.warningText }]}>{session.accountNote}</Text>
      ) : null}
      <Button
        title="Disconnect"
        accessibilityLabel={`Disconnect ${session.name}`}
        variant="secondary"
        onPress={() => onDisconnect(session)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 20,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 12,
  },
  section: {
    gap: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 14,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  cardLine: {
    fontSize: 13,
  },
});

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type {
  ShouldStartLoadRequest,
  WebViewNavigationEvent,
  WebViewErrorEvent,
  WebViewOpenWindowEvent,
} from 'react-native-webview/lib/WebViewTypes';
import type { RootStackParamList } from '../navigation';
import { Button, TestNetworksOnlyCard, WarningBox, screenStyle } from '../components';
import { useAppLock } from '../components/LockGate';
import { useTheme } from '../theme';
import { readinessGate } from '../config/readiness';
import { usePrefs } from '../wallet/PrefsContext';
import { useWallet } from '../wallet/WalletContext';
import { accountLabel } from '../wallet/accounts';
import { ConnectedAppsNotice, useWalletConnect } from '../wallet/WalletConnectContext';
import { hexChainIdOf, describeChain } from '../wallet/walletconnect';
import {
  BROWSER_SITES,
  decideNavigation,
  externalLinkMessage,
  parseWebOrigin,
  siteForOrigin,
  siteForUrl,
  type BrowserSite,
} from '../wallet/browser-sites';
import { buildProviderScript, deliverToPageScript, uuidV4FromBytes } from '../wallet/browser-provider-script';
import { browserBarConnection, browserTopicFor } from '../wallet/browser-bridge';

type Props = NativeStackScreenProps<RootStackParamList, 'Apps'>;

/**
 * The in-app browser, "Apps" (feature 79; the allowlisted-sites slice of
 * docs/DAPP_BROWSER.md section 5). A FIXED list of sites (browser-sites.ts
 * BROWSER_SITES) and no address field: the user can only open a listed
 * site, and the web view only loads pages whose exact origin is on the
 * list. Test networks only (readiness row 'dapp-browser', enforced here and
 * in the bridge). Connections and requests go through the app's single
 * WalletConnect queue and approval sheet (browser-bridge.ts), so this
 * screen never signs anything itself and imports no key storage.
 *
 * How each react-native-webview 13.16.1 finding of section 3.3 is handled
 * on this screen (the bridge handles B2 and B3):
 *  - B1 (prefix-matching originWhitelist): originWhitelist={['*']}, whose
 *    expression `^.*` matches every string, so the library ALWAYS defers to
 *    onShouldStartLoadWithRequest, where browser-sites.ts decideNavigation
 *    compares exact origins. The first URL, which Android never passes to
 *    that callback ("On Android, is not called on the first load", the
 *    library's reference), is checked before the web view is rendered.
 *  - B6 (the library hands URLs that fail its allowlist to Linking): never
 *    reached, because nothing fails `^.*`. Refused URLs are simply not
 *    loaded; an off-list https link is offered in the system browser only
 *    after the user confirms (the one Linking call below).
 *  - Android's 250 ms limit: the library's Android client waits at most
 *    250 ms for the JavaScript answer and then ALLOWS the load
 *    (RNCWebViewClient.java SHOULD_OVERRIDE_URL_LOADING_TIMEOUT, "defaulting
 *    to allow loading"), so a slow answer can let an off-list page load.
 *    The decision here is synchronous, and as a second line every load
 *    start re-checks the URL: an off-list top-level page detaches the
 *    bridge (its messages are dropped) and is stopped and replaced by the
 *    refusal panel.
 *  - B4 (unreliable injection before content on Android): the provider is
 *    injected before content AND again when each load ends; the shim
 *    installs once per document and the second run announces it again
 *    through EIP-6963.
 *  - B5 (Android grants a page's camera request at once when the app holds
 *    the camera permission) and B7 (Android downloads go to the system
 *    download manager with the site's cookies): not fixable from
 *    JavaScript in 13.16.1 — there is no prop for either on Android — so
 *    they are stated on this screen as residuals. iOS: camera and
 *    microphone requests are denied (mediaCapturePermissionGrantType
 *    'deny'), and downloads are not handled (no onFileDownload).
 *  - B8 (setSupportMultipleWindows must stay true, CVE-2020-6506): left at
 *    its default (true); every new-window request goes to onOpenWindow,
 *    which loads an allowlisted page in this view and otherwise refuses or
 *    asks before opening the system browser.
 *  - File upload: the library has no prop to switch it off; a page can
 *    open the file or photo picker (stated on screen).
 *  - incognito: on iOS a non-persistent website data store; on Android the
 *    library removes all cookies and clears the cache when the view is
 *    created, but leaves DOM storage (localStorage) in place
 *    (RNCWebViewManagerImpl.kt setIncognito; domStorageEnabled defaults to
 *    true), which is stated on screen.
 *
 * Keeping the page open while the wallet changes (live-pass finding 1): the
 * bar's Connection button opens a panel IN this screen (no navigation), so
 * a Disconnect there reaches the page that is on screen at once
 * (accountsChanged with no accounts). The panel's "Open Settings" and "All
 * connected apps" PUSH those screens on top of this one: the native stack
 * keeps the screens below the top one mounted, and this app does not
 * freeze them (no enableFreeze call; native-stack 7.19.2 documents
 * freezeOnBlur as "Defaults to `false`"), so the page stays loaded and the
 * effect below tells it about a network change while Settings is still
 * showing; on return a focus effect repeats the check (only differences are
 * ever sent, so nothing is sent twice). A switch to mainnet closes the page
 * (the readiness card replaces it); an account switch rebuilds the whole
 * navigator (App.tsx), which closes it too.
 *
 * Under the app lock (live-pass finding 4) the whole page — bar, panel and
 * web view — is display: 'none' and the web view is marked
 * no-hide-descendants, on top of LockGate's own hiding. The web view stays
 * MOUNTED: unmounting it would detach the page from the bridge and withdraw
 * the requests it has waiting in the approval queue, which the lock hold is
 * meant to keep for after the unlock.
 */
export function BrowserScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const { evmChain } = usePrefs();
  const { accountForEvmAddress } = useWallet();
  const { browser } = useWalletConnect();
  const gate = readinessGate('dapp-browser', evmChain.caip2);

  const requested = route.params?.origin ? siteForOrigin(route.params.origin) : null;
  const [site, setSite] = useState<BrowserSite | null>(requested);
  const close = useCallback(() => setSite(null), []);

  useBrowserVersion(browser);

  if (gate) {
    return (
      <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
        <TestNetworksOnlyCard feature={gate.feature} hint={gate.hint} />
      </ScrollView>
    );
  }

  if (site) {
    // Keyed on the site only: a switch between test networks keeps the page
    // and reaches it as chainChanged (EIP-1193), while requests queued
    // before the switch are declined by the controller's chain re-check.
    return <SiteView key={site.origin} site={site} onClose={close} navigation={navigation} />;
  }

  return (
    <ScrollView style={screenStyle(theme)} contentContainerStyle={styles.content}>
      <Text style={[styles.title, { color: theme.text }]}>Apps on {describeChain(evmChain.caip2)}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        A short, fixed list of apps that work on test networks. They open inside the wallet and connect through the
        same approval sheet as WalletConnect: nothing is signed or sent without the sheet and your device check. There
        is no address field: only the sites below can be opened here.
      </Text>
      {BROWSER_SITES.map((s) => {
        const served = browser.servedAccounts(s.origin)[0] ?? null;
        const owner = served ? (browser.records.get(s.origin)?.owner ?? served) : null;
        const label = owner ? (accountForEvmAddress(owner)?.name ?? null) : null;
        return (
          <View key={s.origin} style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.cardTitle, { color: theme.text }]}>{s.name}</Text>
            <Text style={[styles.cardLine, { color: theme.textMuted }]}>{s.origin}</Text>
            <Text style={[styles.cardLine, { color: theme.text }]}>{s.description}</Text>
            <Text style={[styles.cardLine, { color: theme.textMuted }]}>Why it is listed: {s.reason}</Text>
            {served ? (
              <Text style={[styles.cardLine, { color: theme.text }]}>
                Connected: {label ? accountLabel(label, served) : served}
              </Text>
            ) : null}
            <Button title={`Open ${s.name}`} onPress={() => setSite(s)} />
          </View>
        );
      })}
      <Button title="Manage connections" variant="secondary" onPress={() => navigation.navigate('Connections')} />
      <WarningBox>{BROWSER_RESIDUALS}</WarningBox>
    </ScrollView>
  );
}

/**
 * What this build cannot prevent (docs/DAPP_BROWSER.md section 3.3, B5 and
 * B7, and the storage and file-picker notes above). Plain text for the
 * Apps list.
 */
export const BROWSER_RESIDUALS =
  'What this test build cannot yet prevent. On Android, a page opened here can use the camera without asking, ' +
  'because the wallet already holds the camera permission for QR scanning. Files a page downloads on Android are ' +
  'saved by the system download manager, which sends the site’s cookies with the download. A page can open the ' +
  'file or photo picker. Cookies and the cache are cleared each time a site opens, but on Android a site’s own ' +
  'saved data (local storage) stays between visits. Fixing these needs a native build of the wallet.';

/** Re-renders when browser connections change (the connected-as lines). */
function useBrowserVersion(browser: ReturnType<typeof useWalletConnect>['browser']): number {
  return useSyncExternalStore(
    useCallback((listener: () => void) => browser.subscribe(listener), [browser]),
    useCallback(() => browser.version, [browser]),
  );
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * The network sentence of the bar's Connection panel (what a switch made in
 * Settings does to the open page).
 */
export function browserNetworkNote(chainLabel: string): string {
  return (
    `Network: ${chainLabel}. To change it, open Settings; this page stays open behind it. After a switch to ` +
    'another test network the page is told about the new network, and its connection is not used there until ' +
    'it connects on that network. Switching to mainnet closes the page, because Apps works on test networks only.'
  );
}

function SiteView({
  site,
  onClose,
  navigation,
}: {
  site: BrowserSite;
  onClose: () => void;
  navigation: Props['navigation'];
}) {
  const theme = useTheme();
  const { evmChain } = usePrefs();
  const { activeAccount, accountForEvmAddress } = useWallet();
  const { browser, disconnect, visibleNotice, dismissVisibleNotice, claimInlineNotices } = useWalletConnect();
  const { locked } = useAppLock();
  useBrowserVersion(browser);
  const [panelOpen, setPanelOpen] = useState(false);
  const webView = useRef<WebView>(null);

  // One nonce and one EIP-6963 uuid per web view (this component is keyed
  // on the site, so opening another site makes a fresh view).
  const [{ nonce, uuid }] = useState(() => {
    const raw = new Uint8Array(16);
    globalThis.crypto.getRandomValues(raw);
    return { nonce: randomHex(16), uuid: uuidV4FromBytes(raw) };
  });
  const script = useMemo(
    () => buildProviderScript({ nonce, uuid, chainIdHex: hexChainIdOf(evmChain.caip2) }),
    [nonce, uuid, evmChain.caip2],
  );

  // The first URL is checked before the web view exists (Android never
  // asks onShouldStartLoadWithRequest about it).
  const [uri, setUri] = useState(`${site.origin}/`);
  const firstDecision = useMemo(() => decideNavigation(`${site.origin}/`, { isTopFrame: true }), [site.origin]);

  // The page's top-level origin, from the wallet's parser. Null while a
  // navigation to an off-list origin is in progress (then no message is
  // accepted) — see the bridge's frame rule.
  const [topOrigin, setTopOrigin] = useState<string | null>(site.origin);
  const topRef = useRef<string | null>(site.origin);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [bridgeNote, setBridgeNote] = useState<string | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const confirmOpen = useRef(false);

  const deliver = useCallback((payload: Parameters<typeof deliverToPageScript>[0]) => {
    webView.current?.injectJavaScript(deliverToPageScript(payload));
  }, []);

  const attach = useCallback(
    (origin: string) => {
      detachRef.current?.();
      detachRef.current = browser.attachPage({
        origin,
        nonce,
        deliver,
        onHello: ({ hasListener }) => {
          // Informational only (the page could say anything): Android's
          // newer message channel exposes addEventListener on the bridge
          // object, the fallback one does not (finding B3).
          if (Platform.OS !== 'android') return;
          setBridgeNote(
            hasListener
              ? 'This phone’s web view uses the newer message channel, which tells the wallet which frame of the page sent each request.'
              : 'This phone’s web view uses the older message channel: the wallet cannot tell a request from an embedded frame apart from the page’s own here.',
          );
        },
      });
    },
    [browser, nonce, deliver],
  );

  const detach = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
  }, []);

  // The first page's origin is the listed site's own (checked above), so
  // the bridge serves it from the start: the provider's first requests can
  // arrive before the web view reports the load. Leaving the screen
  // withdraws whatever the page still has waiting.
  useEffect(() => {
    if (firstDecision.kind === 'allow') attach(site.origin);
    return detach;
  }, [attach, detach, firstDecision.kind, site.origin]);

  // Mode or account changes reach the page as chainChanged / accountsChanged.
  // This also runs while Settings, opened from the panel, is on top (the
  // stack keeps this screen mounted and unfrozen).
  useEffect(() => {
    browser.notifyContextChanged();
  }, [browser, evmChain.caip2, activeAccount?.index]);

  // Back on this screen: the same check again, before the page is used.
  // notifyContextChanged sends only what differs from what the page was
  // last told, so a repeat after the effect above sends nothing.
  //
  // The bridge serves ONE page at a time. If another Apps page was opened
  // on top meanwhile (Settings → Open Apps), it took the bridge over and
  // this page was detached, so its messages are now dropped and the bridge
  // no longer knows what this document was last told. It is attached again
  // and reloaded, so a fresh document starts with the current network and
  // connection.
  useFocusEffect(
    useCallback(() => {
      const top = topRef.current;
      if (firstDecision.kind === 'allow' && !blocked && top && browser.page?.nonce !== nonce) {
        attach(top);
        webView.current?.reload();
        return;
      }
      browser.notifyContextChanged();
    }, [browser, firstDecision.kind, blocked, nonce, attach]),
  );

  // While this screen is focused, the "Connected apps" notice is drawn below
  // the bar instead of floating over it (live-pass finding 2: the floating
  // notice covered Back / Reload / Close). Other screens keep the floating
  // notice; the claim is released on blur and on unmount.
  useFocusEffect(useCallback(() => claimInlineNotices(), [claimInlineNotices]));

  const confirmDisconnect = useCallback(
    (origin: string) => {
      const host = parseWebOrigin(origin)?.host ?? origin;
      Alert.alert('Disconnect?', `End the connection with ${host}?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          // The same path as the Connected apps screen: the bridge deletes
          // the record, answers anything waiting with "disconnected", and
          // tells the open page accountsChanged with no accounts.
          onPress: () => void disconnect(browserTopicFor(origin)),
        },
      ]);
    },
    [disconnect],
  );

  /** Offers an off-list https link in the system browser, after a confirmation. */
  const offerExternal = useCallback((url: string, host: string) => {
    if (confirmOpen.current) return;
    confirmOpen.current = true;
    setTimeout(() => {
      Alert.alert('Open outside the wallet?', externalLinkMessage(host, url), [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => {
            confirmOpen.current = false;
          },
        },
        {
          text: 'Open in browser',
          onPress: () => {
            confirmOpen.current = false;
            // The ONLY Linking call of the in-app browser: an https URL with
            // no user-info part (decideNavigation 'external'), after the user
            // read it in full and confirmed.
            void Linking.openURL(url).catch(() => undefined);
          },
        },
      ], {
        cancelable: true,
        onDismiss: () => {
          confirmOpen.current = false;
        },
      });
    }, 0);
  }, []);

  const onShouldStart = useCallback(
    (request: ShouldStartLoadRequest): boolean => {
      // Synchronous on purpose: Android allows the load after 250 ms.
      const decision = decideNavigation(request.url, { isTopFrame: request.isTopFrame });
      if (decision.kind === 'allow') return true;
      if (decision.kind === 'external') offerExternal(decision.url, decision.host);
      else setNote(decision.reason);
      return false;
    },
    [offerExternal],
  );

  const onLoadStart = useCallback(
    (event: WebViewNavigationEvent) => {
      setLoading(true);
      const url = event.nativeEvent.url;
      const parsed = parseWebOrigin(url);
      const listed = siteForUrl(url);
      if (listed && parsed) {
        if (topRef.current !== parsed.origin) {
          // A different allowlisted origin: the bar changes now, and the
          // bridge serves only that origin from here on.
          topRef.current = parsed.origin;
          setTopOrigin(parsed.origin);
          attach(parsed.origin);
        }
        setBlocked(null);
        return;
      }
      // Off the list (only reachable if the library let a load through):
      // nothing from this page is accepted, and the load is stopped.
      topRef.current = null;
      setTopOrigin(null);
      detach();
      webView.current?.stopLoading();
      setBlocked(
        `The page tried to load ${parsed ? parsed.origin : 'an address that could not be read'}, which is not on ` +
          'this wallet’s list, so it was stopped and is not connected to the wallet.',
      );
    },
    [attach, detach],
  );

  const onLoadEnd = useCallback(
    (event: WebViewNavigationEvent | WebViewErrorEvent) => {
      setLoading(false);
      const url = event.nativeEvent.url;
      const listed = siteForUrl(url);
      if (!listed) {
        // Same second line as onLoadStart, for a load that ended off the list.
        if (parseWebOrigin(url)) onLoadStart(event as WebViewNavigationEvent);
        return;
      }
      if (topRef.current !== listed.origin) {
        topRef.current = listed.origin;
        setTopOrigin(listed.origin);
        attach(listed.origin);
      }
      // B4: inject again once the document has loaded; the shim installs
      // once per document and otherwise only announces itself again.
      webView.current?.injectJavaScript(script);
    },
    [script, attach, onLoadStart],
  );

  const onOpenWindow = useCallback(
    (event: WebViewOpenWindowEvent) => {
      const target = event.nativeEvent.targetUrl;
      const decision = decideNavigation(target, { isTopFrame: true });
      if (decision.kind === 'allow') setUri(target);
      else if (decision.kind === 'external') offerExternal(decision.url, decision.host);
      else setNote(decision.reason);
    },
    [offerExternal],
  );

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      // The bridge applies the frame rule (reported origin = top origin,
      // allowlisted) and drops anything else without an answer.
      void browser.handleMessage(event.nativeEvent.url, event.nativeEvent.data);
    },
    [browser],
  );

  const shownOrigin = topOrigin ?? site.origin;
  const served = topOrigin ? browser.servedAccounts(topOrigin)[0] ?? null : null;
  const connection = topOrigin ? browserBarConnection(browser, topOrigin) : ({ kind: 'none' } as const);
  const labelOf = (address: string) => {
    const name = accountForEvmAddress(address)?.name ?? null;
    return name ? accountLabel(name, address) : address;
  };

  return (
    // While locked: display 'none' (native INVISIBLE / hidden), so nothing on
    // this page is reported to accessibility at all; the page stays mounted.
    <View style={[locked ? styles.hiddenWhileLocked : styles.fill, { backgroundColor: theme.background }]}>
      <View style={[styles.bar, { borderColor: theme.border, backgroundColor: theme.card }]}>
        <Text style={[styles.barOrigin, { color: theme.text }]} numberOfLines={1} accessibilityLabel={`Site ${shownOrigin}`}>
          {loading && !topOrigin ? `Loading ${parseWebOrigin(shownOrigin)?.host ?? shownOrigin}…` : shownOrigin}
        </Text>
        <Text style={[styles.barLine, { color: theme.textMuted }]}>
          {served ? `Connected as ${served}` : 'Not connected'} · {describeChain(evmChain.caip2)}
        </Text>
        <View style={styles.barButtons}>
          <Button title="Back" variant="secondary" onPress={() => webView.current?.goBack()} />
          <Button title="Reload" variant="secondary" onPress={() => webView.current?.reload()} />
          <Button
            title="Connection"
            variant="secondary"
            selected={panelOpen}
            accessibilityHint="Shows or hides this site's connection and the network"
            onPress={() => setPanelOpen((open) => !open)}
          />
          <Button title="Close" variant="secondary" onPress={onClose} />
        </View>
        {note ? (
          <Text style={[styles.barLine, { color: theme.warningText }]} onPress={() => setNote(null)}>
            {note} (tap to hide)
          </Text>
        ) : null}
        {bridgeNote ? <Text style={[styles.barLine, { color: theme.textMuted }]}>{bridgeNote}</Text> : null}
      </View>
      {panelOpen ? (
        <View style={[styles.panel, { borderColor: theme.border, backgroundColor: theme.card }]}>
          <Text style={[styles.barLine, { color: theme.text }]}>
            {connection.kind === 'served'
              ? `Connected as ${labelOf(connection.address)} on ${describeChain(connection.chain)}. Disconnecting ` +
                'ends this site’s access to your address now: the open page is told at once and has to ask again, ' +
                'through the approval sheet, to reconnect.'
              : connection.kind === 'elsewhere'
                ? `This site has a stored connection for ${labelOf(connection.address)} on ` +
                  `${describeChain(connection.chain)}. It is not used here, because another account or network is ` +
                  'active. Disconnecting deletes it.'
                : 'Not connected. If the site asks to connect, the approval sheet opens; nothing is shared before you approve.'}
          </Text>
          {connection.kind !== 'none' && topOrigin ? (
            <Button
              title={`Disconnect ${parseWebOrigin(topOrigin)?.host ?? topOrigin}`}
              variant="secondary"
              onPress={() => confirmDisconnect(topOrigin)}
            />
          ) : null}
          <Text style={[styles.barLine, { color: theme.textMuted }]}>{browserNetworkNote(describeChain(evmChain.caip2))}</Text>
          <View style={styles.barButtons}>
            <Button title="Open Settings" variant="secondary" onPress={() => navigation.navigate('Settings')} />
            <Button title="All connected apps" variant="secondary" onPress={() => navigation.navigate('Connections')} />
          </View>
        </View>
      ) : null}
      {/* The "Connected apps" notice, in the layout below the bar (claimed
          above), so it never covers the bar's buttons. */}
      {visibleNotice ? (
        <ConnectedAppsNotice text={visibleNotice.text} onDismiss={dismissVisibleNotice} placement="inline" />
      ) : null}
      {firstDecision.kind !== 'allow' ? (
        <WarningBox>
          {firstDecision.kind === 'refuse' ? firstDecision.reason : 'This site is not on the list.'}
        </WarningBox>
      ) : blocked ? (
        <View style={styles.content}>
          <WarningBox>{blocked}</WarningBox>
          <Button title="Close" onPress={onClose} />
        </View>
      ) : (
        <WebView
          ref={webView}
          source={{ uri }}
          // B1/B6: `^.*` matches everything, so every decision is ours.
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={onShouldStart}
          onLoadStart={onLoadStart}
          onLoadEnd={onLoadEnd}
          onOpenWindow={onOpenWindow}
          onMessage={onMessage}
          injectedJavaScriptBeforeContentLoaded={script}
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly
          // Privacy and attack surface (docs/DAPP_BROWSER.md sections 3.2 and 3.4).
          incognito
          cacheEnabled={false}
          thirdPartyCookiesEnabled={false}
          sharedCookiesEnabled={false}
          javaScriptCanOpenWindowsAutomatically={false}
          setSupportMultipleWindows
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never"
          geolocationEnabled={false}
          saveFormDataDisabled
          allowsLinkPreview={false}
          mediaCapturePermissionGrantType="deny"
          mediaPlaybackRequiresUserAction
          fraudulentWebsiteWarningEnabled
          webviewDebuggingEnabled={false}
          paymentRequestEnabled={false}
          // Also hidden on the web view itself while locked (the page
          // container above is display 'none' then as well).
          importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}
          accessibilityElementsHidden={locked}
          style={styles.fill}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hiddenWhileLocked: { flex: 1, display: 'none' },
  panel: { borderBottomWidth: 1, paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  content: { padding: 24, gap: 16 },
  title: { fontSize: 18, fontWeight: '700' },
  hint: { fontSize: 13, lineHeight: 19 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardLine: { fontSize: 13, lineHeight: 18 },
  bar: { borderBottomWidth: 1, paddingHorizontal: 12, paddingVertical: 8, gap: 6 },
  barOrigin: { fontSize: 14, fontWeight: '600' },
  barLine: { fontSize: 12, lineHeight: 16 },
  barButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});

import { createElement, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useNetInfoInstance, type NetInfoConfiguration } from '@react-native-community/netinfo';
import { forgetDefaultEndpointChoices } from '../config/networks';
import { describeNetworkFailure } from '../config/endpoint-probe';
import { useTheme } from '../theme';

/**
 * Offline detection for the screens that read the network (phase 9 item
 * 5). It only INFORMS: nothing in the app is blocked on it, because the
 * operating system's connectivity report can be wrong (captive portals,
 * VPNs, a network that is up but cannot reach the endpoint). Requests still
 * run and fail or succeed on their own; the notice explains a cascade of
 * failures before the user reads them one by one.
 *
 * Library: @react-native-community/netinfo 12.0.1 (the version
 * docs.expo.dev/versions/v57.0.0/sdk/netinfo recommends and lists as
 * included in Expo Go). API checked against the installed typings
 * (lib/typescript/src/index.d.ts): useNetInfoInstance(isPaused,
 * configuration) runs an isolated checker and returns { netInfo, refresh },
 * where netInfo.isConnected is boolean | null (null = not known yet).
 *
 * PRIVACY: the library's default configuration
 * (src/internal/defaultConfiguration.ts) probes
 * https://clients3.google.com/generate_204 to decide isInternetReachable
 * whenever the platform does not report reachability natively (iOS). The
 * wallet does not want an extra third party learning when it is opened, so
 * this checker turns that probe off (reachabilityShouldRun returns false)
 * and uses ONLY isConnected, which comes from the operating system without
 * any request. With the probe off isInternetReachable would read false on
 * iOS, so it is deliberately ignored. The isolated instance leaves the
 * global NetInfo singleton (which the WalletConnect stack configures and
 * uses) untouched.
 */
const NETINFO_CONFIG: Partial<NetInfoConfiguration> = {
  reachabilityShouldRun: () => false,
};

/** The notice's sentence (one place, so screens stay consistent). */
export const OFFLINE_NOTE =
  'You appear to be offline. Balances, history and quotes need a connection, ' +
  'so what you see may be out of date and new requests may fail. You can ' +
  'still try: this check is not always right.';

/**
 * A calm sentence for a failed network read. `title` names the thing that
 * could not be loaded (`what`, e.g. "the token details"); `detail` is a
 * plain sentence — never a raw exception: for a transport-level failure
 * (endpoint-probe.ts isEndpointFailure) it says the request got no answer,
 * otherwise it is the endpoint's own first sentence with links and
 * advertisements removed (sanitizeEndpointMessage). `technical`, when not
 * null, is the cleaned raw text for a muted detail line (TechnicalDetail
 * below). The logic lives in config/endpoint-probe.ts describeNetworkFailure
 * so the offline scripts can pin it.
 */
export function describeNetworkError(
  error: unknown,
  what: string,
): { title: string; detail: string; technical: string | null } {
  return describeNetworkFailure(error, what);
}

/**
 * The muted technical line under a calm error: selectable, and exposed to
 * screen readers as one element ("Technical detail: …") so it is in the
 * accessibility tree rather than skipped. Renders nothing for null/empty.
 */
export function TechnicalDetail({ text }: { text: string | null | undefined }) {
  const theme = useTheme();
  if (!text) return null;
  return createElement(
    Text,
    {
      selectable: true,
      accessible: true,
      accessibilityRole: 'text',
      accessibilityLabel: `Technical detail: ${text}`,
      style: [styles.technical, { color: theme.textMuted }],
    },
    text,
  );
}

/**
 * True only when the operating system reports no connection at all
 * (isConnected === false); unknown counts as online. When the device comes
 * back online, the in-memory default-endpoint choices are forgotten so the
 * next request probes each chain's candidates afresh (choices made while
 * offline say nothing about which endpoint is healthy now).
 */
export function useOffline(): boolean {
  const { netInfo } = useNetInfoInstance(false, NETINFO_CONFIG);
  const offline = netInfo.isConnected === false;
  const wasOffline = useRef(false);
  useEffect(() => {
    if (wasOffline.current && !offline) forgetDefaultEndpointChoices();
    wasOffline.current = offline;
  }, [offline]);
  return offline;
}

/**
 * A calm, non-blocking notice shown at the top of network-reading screens
 * while the device appears to be offline; renders nothing otherwise (so
 * `style`, e.g. outer margins, only applies while it is visible). It is
 * announced to screen readers when it appears (accessibilityLiveRegion on
 * Android, the "alert" role on iOS).
 */
export function OfflineNotice({ style }: { style?: StyleProp<ViewStyle> } = {}) {
  const theme = useTheme();
  const offline = useOffline();
  if (!offline) return null;
  return createElement(
    View,
    {
      accessibilityRole: 'alert',
      accessibilityLiveRegion: 'polite',
      style: [styles.box, { backgroundColor: theme.card, borderColor: theme.border }, style],
    },
    createElement(Text, { style: [styles.text, { color: theme.textMuted }] }, OFFLINE_NOTE),
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  text: {
    fontSize: 13,
    lineHeight: 18,
  },
  technical: {
    fontSize: 12,
    lineHeight: 17,
  },
});

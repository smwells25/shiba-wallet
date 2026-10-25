import React, { useCallback, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { readEnsPrimaryName, type EnsPrimaryName } from '@shiba-wallet/chains-evm';
import { getEndpoint } from '../config/networks';
import { EVM_CHAIN_ID } from '../wallet/send';
import { simulationTransport } from '../wallet/simulation';
import { createPrimaryNameCache, primaryNameChainId, primaryNameLine } from '../wallet/handle';
import { useI18n } from '../i18n/useI18n';
import type { Theme } from '../theme';

/**
 * Views shared by the Handle screen and the name line Home and Receive show
 * (phase 23 item 6). The primary name is read through the Universal
 * Resolver's reverse() (the engine's readEnsPrimaryName: strict decode; the
 * resolver already checked the name resolves back to the address) on
 * Ethereum mainnet and Sepolia only, through the active network's endpoint,
 * with the JSON-RPC error data kept (simulationTransport) so an off-chain
 * name is told apart from a failure. The answers live in memory only and
 * are read again whenever the screen gains focus; a failed read keeps the
 * previous answer (or shows nothing).
 */
export const primaryNames = createPrimaryNameCache(async (caip2, address) => {
  const chainId = primaryNameChainId(caip2);
  if (chainId === null) return { status: 'none' };
  const endpoint = await getEndpoint(EVM_CHAIN_ID);
  if (!endpoint || endpoint.url === null || endpoint.network.chainId !== caip2) throw new Error('No endpoint for this network.');
  return readEnsPrimaryName(simulationTransport(endpoint.url), address, chainId);
});

/**
 * The name line for `address` on `caip2` ("ENS name: alice.eth", a short
 * note for an off-chain or unsupported name, or null), re-read on focus.
 */
export function usePrimaryNameLine(address: string | null, caip2: string): string | null {
  // Re-renders on a language change and on a new answer.
  useI18n();
  return primaryNameLine(usePrimaryName(address, caip2));
}

/** The primary name answer for `address` on `caip2` (null until read, or on a network without names), re-read on focus. */
export function usePrimaryName(address: string | null, caip2: string): EnsPrimaryName | null {
  const answer = useSyncExternalStore(
    primaryNames.subscribe,
    () => (address ? primaryNames.get(caip2, address) : null),
    () => null,
  );
  useFocusEffect(
    useCallback(() => {
      if (address) void primaryNames.refresh(caip2, address);
      return undefined;
    }, [address, caip2]),
  );
  return answer;
}

/** The calls a step sends, one numbered line each (full addresses, as on the other confirm screens). */
export function CallLines({ lines, theme }: { lines: string[]; theme: Theme }) {
  return (
    <View style={styles.lines}>
      {lines.map((line, i) => (
        <Text key={`${i}-${line.slice(0, 24)}`} selectable style={[styles.line, { color: theme.text }]}>
          {`${i + 1}. ${line}`}
        </Text>
      ))}
    </View>
  );
}

/** A muted paragraph. */
export function Note({ text, theme, style }: { text: string; theme: Theme; style?: TextStyle }) {
  return <Text style={[styles.note, { color: theme.textMuted }, style]}>{text}</Text>;
}

export const handleStyles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  cardTitle: { fontSize: 15, fontWeight: '700' },
});

const styles = StyleSheet.create({
  lines: { gap: 8 },
  line: { fontSize: 13, lineHeight: 19 },
  note: { fontSize: 13, lineHeight: 19 },
});

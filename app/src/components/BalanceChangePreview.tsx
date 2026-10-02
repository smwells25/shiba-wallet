import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { toHex } from '@shiba-wallet/chains-evm';
import { useTheme, type Theme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { listTokens } from '../wallet/tokens';
import {
  PREVIEW_FOOTNOTE,
  PREVIEW_NO_CHANGES,
  PREVIEW_TITLE,
  describeAssetChanges,
  errorNote,
  revertedNote,
  runBalancePreview,
  skippedLogsNote,
  type PreviewState,
  type PreviewTone,
} from '../wallet/simulation';

export interface PreviewRequest {
  /** The simulated sender: the wallet EOA, or the smart account on the AA path. */
  from: string;
  to: string;
  value: bigint;
  data?: Uint8Array;
}

/**
 * The "Balance changes (preview)" card on EVM confirm screens. Purely
 * informational and additive: it never blocks or unblocks a send — the
 * eth_call revert gate next to it stays the only gate. Runs once per
 * distinct request against `url` (the same endpoint the quote used) and
 * degrades to a muted note when no endpoint is configured or the endpoint
 * does not serve eth_simulateV1. Amounts respect the Hide amounts
 * preference; toggling it re-renders without re-simulating.
 */
export function BalanceChangePreview({
  url,
  request,
  batch,
  note,
}: {
  url: string | null;
  request: PreviewRequest;
  /**
   * Optional: the full list of calls of a smart-account batch, all from
   * `request.from` (phase 7 item 2). When given it replaces the single
   * request; the engine simulates the calls in order in one block
   * (eth_simulateV1), each seeing the previous call's state.
   */
  batch?: PreviewRequest[];
  /** Optional extra context line (e.g. the smart-account note). */
  note?: string;
}) {
  const theme = useTheme();
  const { hideAmounts, evmChain } = usePrefs();
  const [state, setState] = useState<PreviewState | null>(null);

  const requests = batch && batch.length > 0 ? batch : [request];
  const key =
    `${url ?? ''}|${evmChain.caip2}|${request.from}|` +
    requests
      .map((r) => `${r.from}>${r.to}:${r.value}:${r.data && r.data.length > 0 ? toHex(r.data) : '0x'}`)
      .join(',');

  // A new simulation input clears the shown result while rendering (React's
  // "adjust state when a prop changes" pattern), so the card goes back to
  // its loading state before the effect below starts the new simulation.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setState(null);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let trackedTokens: Awaited<ReturnType<typeof listTokens>> = [];
      try {
        trackedTokens = await listTokens();
      } catch {
        trackedTokens = [];
      }
      return runBalancePreview({
        url,
        wallet: request.from,
        calls: requests.map((r) => ({
          from: r.from,
          to: r.to,
          value: r.value,
          ...(r.data && r.data.length > 0 ? { data: r.data } : {}),
        })),
        chainCaip2: evmChain.caip2,
        trackedTokens,
      });
    })().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
    // `key` captures every input of the simulation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const lines = useMemo(
    () =>
      state?.status === 'ok'
        ? describeAssetChanges(state.changes, state.meta, {
            nativeSymbol: evmChain.displaySymbol,
            hidden: hideAmounts,
          })
        : [],
    [state, evmChain.displaySymbol, hideAmounts],
  );

  if (state?.status === 'unavailable') {
    return <Text style={[styles.muted, { color: theme.textMuted }]}>{state.note}</Text>;
  }

  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.title, { color: theme.text }]}>{PREVIEW_TITLE}</Text>
      {state === null ? (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color={theme.accent} />
          <Text style={[styles.muted, { color: theme.textMuted }]}>Simulating…</Text>
        </View>
      ) : null}
      {state?.status === 'error' ? (
        <Text style={[styles.line, { color: theme.danger }]}>{errorNote(state.message)}</Text>
      ) : null}
      {state?.status === 'reverted' ? (
        <Text style={[styles.line, { color: theme.danger }]}>{revertedNote(state.reason)}</Text>
      ) : null}
      {state?.status === 'ok' && lines.length === 0 ? (
        <Text style={[styles.line, { color: theme.text }]}>{PREVIEW_NO_CHANGES}</Text>
      ) : null}
      {lines.map((line, i) => (
        <PreviewLineView key={`${i}-${line.text}`} text={line.text} tone={line.tone} theme={theme} />
      ))}
      {state?.status === 'ok' && state.skippedLogs > 0 ? (
        <Text style={[styles.muted, { color: theme.textMuted }]}>{skippedLogsNote(state.skippedLogs)}</Text>
      ) : null}
      {note ? <Text style={[styles.muted, { color: theme.textMuted }]}>{note}</Text> : null}
      <Text style={[styles.muted, { color: theme.textMuted }]}>{PREVIEW_FOOTNOTE}</Text>
    </View>
  );
}

function PreviewLineView({ text, tone, theme }: { text: string; tone: PreviewTone; theme: Theme }) {
  if (tone === 'warning') {
    // Unlimited / collection-wide approvals: the visible warning style.
    return (
      <View
        style={[styles.warning, { backgroundColor: theme.warningSurface, borderColor: theme.warningBorder }]}
      >
        <Text style={[styles.line, styles.bold, { color: theme.warningText }]}>⚠ {text}</Text>
      </View>
    );
  }
  const color =
    tone === 'out' ? theme.danger : tone === 'in' ? theme.success : tone === 'approval' ? theme.accent : theme.text;
  return <Text style={[styles.line, { color }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  loading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  line: {
    fontSize: 15,
    lineHeight: 21,
  },
  bold: {
    fontWeight: '700',
  },
  muted: {
    fontSize: 12,
    lineHeight: 17,
  },
  warning: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
  },
});

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components';
import { useTheme } from '../theme';
import {
  PIN_COST_BUTTON,
  PIN_COST_HINT,
  PIN_COST_RESULT_NOTE,
  PIN_COST_STOP_BUTTON,
  measurePinHashCost,
  pinCostFailedText,
  pinCostPlatform,
  pinCostPlatformText,
  pinCostRowText,
  pinCostRunningText,
  pinCostTotalText,
  type PinCostReport,
  type PinCostRow,
} from '../wallet/pin-cost';

/**
 * Settings → Developer → "Measure the PIN hashing cost" (rendered by
 * SettingsScreen on test networks only; ../wallet/pin-cost.ts says what is
 * timed and what is never touched). The result exists only in this
 * component's state: nothing is stored, logged or sent. Leaving the screen
 * stops a run in progress.
 */
export function PinCostMeasurement() {
  const theme = useTheme();
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [rows, setRows] = useState<readonly PinCostRow[]>([]);
  const [report, setReport] = useState<PinCostReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const cancel = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel.current = true;
    };
  }, []);

  const start = () => {
    if (running) return;
    cancel.current = false;
    setRunning(true);
    setReport(null);
    setFailure(null);
    setRows([]);
    const platform = pinCostPlatform(Platform.OS, globalThis, __DEV__);
    measurePinHashCost(platform, {
      isCancelled: () => cancel.current,
      onUpdate: (r, size) => {
        if (!mounted.current) return;
        setRows(r);
        setCurrent(size);
      },
    }).then(
      (result) => {
        if (!mounted.current) return;
        setReport(result);
        setRows(result.rows);
        setCurrent(null);
        setRunning(false);
      },
      (e: unknown) => {
        if (!mounted.current) return;
        setFailure(pinCostFailedText(e instanceof Error ? e.message : String(e)));
        setCurrent(null);
        setRunning(false);
      },
    );
  };

  return (
    <View style={styles.box}>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{PIN_COST_HINT}</Text>
      {running ? (
        <Button title={PIN_COST_STOP_BUTTON} variant="secondary" onPress={() => (cancel.current = true)} />
      ) : (
        <Button title={PIN_COST_BUTTON} variant="secondary" onPress={start} />
      )}
      {rows.map((row) => (
        <Text key={row.log2N} style={[styles.hint, { color: theme.text }]}>{pinCostRowText(row)}</Text>
      ))}
      {running && current !== null ? (
        <View style={styles.running}>
          <ActivityIndicator color={theme.accent} />
          <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.text }]}>{pinCostRunningText(current)}</Text>
        </View>
      ) : null}
      {report ? (
        <>
          <Text style={[styles.hint, { color: theme.text }]}>{pinCostTotalText(report.totalMs)}</Text>
          <Text style={[styles.hint, { color: theme.text }]}>{pinCostPlatformText(report.platform)}</Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>{PIN_COST_RESULT_NOTE}</Text>
        </>
      ) : null}
      {failure ? <Text style={[styles.hint, { color: theme.danger }]}>{failure}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: 8,
    marginTop: 8,
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  running: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});

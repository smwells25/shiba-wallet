import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components';
import { useTheme } from '../theme';
import {
  PIN_COST_BUTTON,
  PIN_COST_RESULT_NOTE,
  PIN_COST_STOP_BUTTON,
  measurePinHashCost,
  pinCostFailedText,
  pinCostHint,
  pinCostPlatform,
  pinCostPlatformText,
  pinCostRowText,
  pinCostRunningText,
  pinCostTotalText,
  type PinCostReport,
  type PinCostRow,
} from '../wallet/pin-cost';
import { currentPinHashPath, pinHashPathLine, resolvePinHashPath, type PinHashPath } from '../wallet/pin-native-scrypt';

/**
 * Settings → Developer → "Measure the PIN hashing cost" (rendered by
 * SettingsScreen on test networks only; ../wallet/pin-cost.ts says what is
 * timed and what is never touched). The result exists only in this
 * component's state: nothing is stored, logged or sent. Leaving the screen
 * stops a run in progress (between sizes when the native scrypt is in use).
 *
 * Above the button it shows, read-only, which scrypt the app PIN uses in
 * this session ("PIN hashing path: …", ../wallet/pin-native-scrypt.ts).
 * Finding it out loads the native module and runs its RFC 7914 self-check
 * once per session (no PIN, no record, nothing stored).
 */
export function PinCostMeasurement() {
  const theme = useTheme();
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [rows, setRows] = useState<readonly PinCostRow[]>([]);
  const [report, setReport] = useState<PinCostReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [hashPath, setHashPath] = useState<PinHashPath | null>(() => currentPinHashPath());
  const cancel = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel.current = true;
    };
  }, []);
  useEffect(() => {
    let live = true;
    resolvePinHashPath().then((p) => {
      if (live) setHashPath(p);
    });
    return () => {
      live = false;
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
        setHashPath(result.hashPath.end);
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
      <Text style={[styles.hint, { color: theme.text }]}>{pinHashPathLine(hashPath)}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{pinCostHint(hashPath)}</Text>
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
          <Text style={[styles.hint, { color: theme.text }]}>{pinCostPlatformText(report.platform, report.hashPath)}</Text>
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

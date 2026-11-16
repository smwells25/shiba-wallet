import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { useI18n } from '../i18n/useI18n';
import { createPrePromptGuard, prePromptStageText, type PrePromptGuard, type PrePromptStage } from '../wallet/pre-prompt-guard';

/**
 * One pre-prompt guard per confirm screen (wallet/pre-prompt-guard.ts) and
 * its current stage. The guard is made once (useState's initializer) and
 * read through useSyncExternalStore, so the stage the screen draws is the
 * guard's own, and the second-tap test lives in the guard, not in state.
 */
export function usePrePromptGuard(): { guard: PrePromptGuard; stage: PrePromptStage } {
  const [guard] = useState<PrePromptGuard>(createPrePromptGuard);
  const stage = useSyncExternalStore(guard.subscribe, guard.stage, guard.stage);
  return { guard, stage };
}

/**
 * The busy line under a smart-account confirm's Approve button while the
 * checks before the device prompt run (phase 27 item 2; pass p27-emu1
 * finding 3: the bundler check took 19–26 s with nothing on screen).
 *
 * Screen readers, the AccountSwitcher's pattern (pass p21e): on Android the
 * wrapper is an always-mounted live region ("polite"; RN 0.86.3
 * ViewAccessibility.d.ts:245, Android only) whose text appears when a
 * stage starts — a content change TalkBack announces, as it did for the
 * switcher's line in passes p21b and p21e; collapsable={false} keeps the
 * wrapper a real native view, and while idle it is taken out of the flow.
 * iOS has no live regions, so VoiceOver gets AccessibilityInfo
 * .announceForAccessibility when the line changes (RN 0.86.3
 * AccessibilityInfo.js:474–480). The line is one accessible element, so it
 * is read once as a stop too.
 */
export function PrePromptCheckNote({ stage }: { stage: PrePromptStage }) {
  const theme = useTheme();
  // Re-render on a language change; the line comes from the table.
  useI18n();
  const text = prePromptStageText(stage);
  useEffect(() => {
    if (text !== null && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
  return (
    <View collapsable={false} accessibilityLiveRegion="polite" style={text === null ? styles.idle : null}>
      {text !== null ? (
        <View accessible accessibilityLabel={text} style={styles.row}>
          <ActivityIndicator color={theme.accent} />
          <Text style={[styles.text, { color: theme.textMuted }]}>{text}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  idle: { position: 'absolute', width: 0, height: 0, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  text: { flex: 1, fontSize: 14, lineHeight: 20 },
});

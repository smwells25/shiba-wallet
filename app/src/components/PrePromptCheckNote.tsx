import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { useI18n } from '../i18n/useI18n';
import {
  createPrePromptAnnouncer,
  createPrePromptGuard,
  prePromptStageText,
  type PrePromptGuard,
  type PrePromptStage,
} from '../wallet/pre-prompt-guard';

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
 * Screen readers (pass p27-emu2 finding 2: TalkBack announced the line twice
 * per check through the Android live region this note used until then): the
 * line is announced once per distinct sentence on BOTH platforms through
 * AccessibilityInfo.announceForAccessibility (RN 0.86.3 AccessibilityInfo.js
 * 474–480; on Android AccessibilityInfoModule.kt 282–292 sends one
 * TYPE_ANNOUNCEMENT per call), decided by createPrePromptAnnouncer in
 * wallet/pre-prompt-guard.ts, and there is no live region any more, so no
 * second path can speak it. The line is still one accessible element, read
 * once as a stop when the person swipes to it. The announcement on
 * Android in place of the live region is NOT yet heard on a device.
 */
export function PrePromptCheckNote({ stage }: { stage: PrePromptStage }) {
  const theme = useTheme();
  // Re-render on a language change; the line comes from the table.
  useI18n();
  const text = prePromptStageText(stage);
  const [announce] = useState(() =>
    createPrePromptAnnouncer((sentence) => AccessibilityInfo.announceForAccessibility(sentence)),
  );
  useEffect(() => {
    announce(text);
  }, [announce, text]);
  if (text === null) return null;
  return (
    <View accessible accessibilityLabel={text} style={styles.row}>
      <ActivityIndicator color={theme.accent} />
      <Text style={[styles.text, { color: theme.textMuted }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  text: { flex: 1, fontSize: 14, lineHeight: 20 },
});

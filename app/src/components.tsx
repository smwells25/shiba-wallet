import React, { useCallback, useEffect, useId, useRef } from 'react';
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
  type SwitchProps,
} from 'react-native';
import { Theme, useTheme } from './theme';
import type { FeatureReadiness } from './config/readiness';
import { IMPORTED_KEY_NOT_BACKED_UP, WATCH_ONLY_NOTICE } from './wallet/account-ids';

/** Primary / secondary / destructive button built from plain components. */
export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  selected,
  accessibilityLabel,
  accessibilityHint,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'destructive';
  disabled?: boolean;
  /**
   * For buttons used as choice chips (one of several options): whether this
   * option is the chosen one. Exposed to screen readers through
   * accessibilityState. Leave undefined for ordinary action buttons, so no
   * selection state is announced for them.
   */
  selected?: boolean;
  /** Spoken label when the visible title is not enough on its own. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const background =
    variant === 'primary' ? theme.accent : variant === 'destructive' ? theme.danger : 'transparent';
  const color =
    variant === 'secondary' ? theme.accent : variant === 'destructive' ? theme.onDanger : theme.onAccent;
  // Choice chips mark the chosen option with a leading "✓" for sighted
  // users. Screen readers get the selected state instead, so the mark is
  // left out of the spoken label rather than read aloud as "check mark".
  const spokenLabel =
    accessibilityLabel ?? (selected !== undefined ? title.replace(/^✓\s*/, '') : undefined);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, ...(selected !== undefined ? { selected } : {}) }}
      {...(spokenLabel !== undefined ? { accessibilityLabel: spokenLabel } : {})}
      {...(accessibilityHint !== undefined ? { accessibilityHint } : {})}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: variant === 'secondary' ? theme.accent : background,
          opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      <Text style={[styles.buttonLabel, { color }]}>{title}</Text>
    </Pressable>
  );
}

/**
 * Prominent warning panel used for every seed-phrase security notice.
 *
 * `announce` (pass p20c finding 8) is for a box that appears because an
 * action was refused (a form's Review blocked by a funding check): the box
 * becomes one accessible element, Android announces later changes of its
 * text (accessibilityLiveRegion "polite"; Android only — RN 0.86.3
 * Libraries/Components/View/ViewAccessibility.d.ts:245, "Works for Android
 * API >= 19 only"), and the screen reader's focus is moved onto it when it
 * appears or its text changes (AccessibilityInfo.sendAccessibilityEvent with
 * "focus", AccessibilityInfo.d.ts:174–177 and the event types at :41; it
 * takes the view itself, so no findNodeHandle is needed), so a person who
 * activated Review hears why nothing happened instead of staying on the
 * button.
 */
export function WarningBox({ children, announce = false }: { children: React.ReactNode; announce?: boolean }) {
  const theme = useTheme();
  const ref = useRef<View>(null);
  // Re-focus when the text changes (a second refusal with other figures).
  const spoken = typeof children === 'string' ? children : null;
  useEffect(() => {
    if (!announce || !ref.current) return;
    AccessibilityInfo.sendAccessibilityEvent(ref.current, 'focus');
  }, [announce, spoken]);
  return (
    <View
      ref={ref}
      {...(announce ? { accessible: true, accessibilityLiveRegion: 'polite' as const } : {})}
      style={[
        styles.warning,
        { backgroundColor: theme.warningSurface, borderColor: theme.warningBorder },
      ]}
    >
      <Text style={[styles.warningText, { color: theme.warningText }]}>{children}</Text>
    </View>
  );
}

/**
 * The colours of every Switch in the app (pass p20c finding 14: in dark
 * mode a switch that was off showed only its white thumb, because the
 * platform's default off track nearly matches the dark background). The
 * off track uses the palette's controlBorder (at least 3:1 against the
 * background and a card), the on track the accent. Props from RN 0.86.3
 * Libraries/Components/Switch/Switch.d.ts: thumbColor (:55), trackColor
 * {false, true} (:62–67) and ios_backgroundColor (:103, the colour shown
 * behind an iOS switch that is off). scripts/check-devmode.mjs fails on any
 * <Switch in app/src that does not spread this.
 */
export function switchColors(
  theme: Theme,
): Required<Pick<SwitchProps, 'trackColor' | 'thumbColor' | 'ios_backgroundColor'>> {
  return {
    trackColor: { false: theme.controlBorder, true: theme.accent },
    thumbColor: theme.switchThumb,
    ios_backgroundColor: theme.controlBorder,
  };
}

/**
 * What a screen reader needs to name a text field (pass p20c finding 1).
 *
 * TalkBack read every field's PLACEHOLDER (or, once filled, its value) and
 * never its visible label, even where an accessibilityLabel was set: React
 * Native gives the placeholder to Android as the EditText's hint
 * (ReactEditText.kt setPlaceholder, `hint = placeholder`, :563–568) and its
 * own accessibility code notes that an EditText's text wins over a content
 * description (ReactAccessibilityDelegate.kt :964–965). Android's way to
 * name a field after a visible label is "labeled by": TextInput passes
 * accessibilityLabelledBy to the native view (TextInput.js :729–730, :770),
 * BaseViewManager stores it (BaseViewManager.java :315–327) and the
 * delegate calls AccessibilityNodeInfo.setLabeledBy with the view whose
 * nativeID matches (ReactAccessibilityDelegate.kt :91–97). The typing says
 * "When the assistive technology focuses on the component with this
 * props, the text is read aloud" (ViewAccessibility.d.ts :221–227,
 * Android only). accessibilityLabel stays the name for VoiceOver on iOS.
 * accessibilityHint becomes the Android tooltip (ReactAccessibilityDelegate.kt
 * :86–89) and the iOS hint.
 */
export interface FieldA11y {
  accessibilityLabel: string;
  accessibilityLabelledBy?: string;
  accessibilityHint?: string;
}

/** The field props for a label; `labelId` is the nativeID of the visible label, when there is one. */
export function fieldA11y(label: string, opts: { labelId?: string; hint?: string } = {}): FieldA11y {
  return {
    accessibilityLabel: label,
    ...(opts.labelId !== undefined ? { accessibilityLabelledBy: opts.labelId } : {}),
    ...(opts.hint !== undefined ? { accessibilityHint: opts.hint } : {}),
  };
}

/**
 * Ties visible labels to their fields: `field(key, label, hint?)` returns
 * the props for the label's <Text> (a nativeID unique to this mounted
 * screen, from React's useId, so a second copy of the same screen further
 * down the stack cannot be found instead — Android looks the id up from the
 * window's root view, depth first, and takes the first match —
 * ReactAccessibilityDelegate.kt :93, ReactFindViewUtil.kt :48–60) and for the
 * <TextInput>. `key` only has to be unique within the component (for
 * example `guardian-${i}-weight`). Adds no view, so the layout is unchanged.
 */
export interface FieldLabel {
  /** The visible label text (render it inside the label's <Text>). */
  text: string;
  /** Spread on the visible label's <Text>. */
  label: { nativeID: string };
  /** Spread on the <TextInput>. */
  input: FieldA11y;
}

export function useFieldLabels(): (key: string, label: string, hint?: string) => FieldLabel {
  const base = useId();
  return useCallback(
    (key: string, label: string, hint?: string): FieldLabel => {
      const nativeID = `field-${base}-${key}`;
      return {
        text: label,
        label: { nativeID },
        input: fieldA11y(label, { labelId: nativeID, ...(hint !== undefined ? { hint } : {}) }),
      };
    },
    [base],
  );
}

/**
 * The Chairperson's condition for imported private keys (ADR D9), in one
 * place: every screen that shows or uses an imported account renders this
 * warning (Home, Receive, every confirm's "From account", the WalletConnect
 * sheet, Settings → Accounts and the backup and reveal views). Renders
 * nothing when `show` is false, so callers can pass the account's flag.
 */
export function ImportedKeyNotice({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return <WarningBox>{IMPORTED_KEY_NOT_BACKED_UP}</WarningBox>;
}

/**
 * Watch-only accounts (feature 10): the notice every screen that shows a
 * watch-only account renders (Home under the switcher, the account lists,
 * the route gate's refusal). Renders nothing when `show` is false, so
 * callers can pass the account's flag.
 */
export function WatchOnlyNotice({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return <WarningBox>{WATCH_ONLY_NOTICE}</WarningBox>;
}

/**
 * The "test networks only" card shown by the smart-account feature screens
 * (guardians, recovery, owner change, session keys, passkeys, the EIP-7702
 * upgrade) when the mainnet readiness table (config/readiness.ts) does not
 * allow the feature on the active network: the feature's title, the plain
 * reason, and the hint pointing at Settings → Developer.
 *
 * The screens had grown their own copies with slightly different
 * typography. The optional style props let each screen keep its existing
 * look exactly; without them the card uses the session-key and passkey
 * screens' look.
 */
export function TestNetworksOnlyCard({
  feature,
  hint,
  style,
  titleStyle,
  bodyStyle,
  hintStyle,
}: {
  feature: FeatureReadiness;
  hint: string;
  style?: ViewStyle;
  titleStyle?: TextStyle;
  bodyStyle?: TextStyle;
  hintStyle?: TextStyle;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        style ?? styles.readinessCard,
        { backgroundColor: theme.card, borderColor: theme.border },
      ]}
    >
      <Text accessibilityRole="header" style={[titleStyle ?? styles.readinessTitle, { color: theme.text }]}>
        {feature.title}: test networks only
      </Text>
      <Text style={[bodyStyle ?? styles.readinessBody, { color: theme.text }]}>{feature.reason}</Text>
      <Text style={[hintStyle ?? styles.readinessHint, { color: theme.textMuted }]}>{hint}</Text>
    </View>
  );
}

/** Numbered two-column grid of mnemonic words. */
export function WordGrid({ words }: { words: string[] }) {
  const theme = useTheme();
  return (
    <View style={styles.grid}>
      {words.map((word, i) => (
        <View
          key={`${i}-${word}`}
          style={[styles.wordChip, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <Text style={[styles.wordIndex, { color: theme.textMuted }]}>{i + 1}</Text>
          <Text style={[styles.word, { color: theme.text }]}>{word}</Text>
        </View>
      ))}
    </View>
  );
}

export function screenStyle(theme: Theme): ViewStyle {
  return { flex: 1, backgroundColor: theme.background };
}

const styles = StyleSheet.create({
  button: {
    borderRadius: 12,
    borderWidth: 1.5,
    paddingVertical: 14,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: '600',
    // A label that wraps (a long choice chip at phone width) stays centred
    // like a one-line label, instead of two left-aligned lines (pass p20c
    // finding 20).
    textAlign: 'center',
  },
  warning: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
  },
  warningText: {
    fontSize: 14,
    lineHeight: 20,
  },
  readinessCard: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  readinessTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  readinessBody: {
    fontSize: 14,
    lineHeight: 20,
  },
  readinessHint: {
    fontSize: 13,
    lineHeight: 19,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  wordChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    width: '48%',
    gap: 8,
  },
  wordIndex: {
    fontSize: 12,
    width: 18,
    textAlign: 'right',
  },
  word: {
    fontSize: 15,
    fontWeight: '500',
  },
});

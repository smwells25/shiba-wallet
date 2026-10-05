import React from 'react';
import { Pressable, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
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

/** Prominent warning panel used for every seed-phrase security notice. */
export function WarningBox({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View
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
      <Text style={[titleStyle ?? styles.readinessTitle, { color: theme.text }]}>
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

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import {
  INBOX_EMPTY,
  INBOX_INTRO,
  INBOX_MARK_ALL_READ,
  INBOX_PIN_NOTE,
  INBOX_READ_ONLY_MESSAGE,
  INBOX_RESET_BODY,
  INBOX_RESET_TITLE,
  INBOX_SCHEDULED_NOTE,
  INBOX_TARGET_BY_KIND,
  appInbox,
  inboxKindLabel,
  inboxTargetHint,
  inboxTimeText,
  inboxUnreadCount,
  inboxUnreadText,
  inboxViaLabel,
  visibleInboxEntries,
  type InboxEntry,
  type InboxState,
} from '../wallet/inbox';

type Props = NativeStackScreenProps<RootStackParamList, 'Inbox'>;

const EMPTY_STATE: InboxState = { entries: [], readOnly: false };

/**
 * The inbox's state for a screen: read on mount and after every write, and
 * again whenever the screen is focused (a scheduled reminder whose time has
 * come appears then). Shared by this screen and the Home link's unread count.
 */
export function useInbox(): { state: InboxState; now: number; loaded: boolean; reload: () => void } {
  const [state, setState] = useState<InboxState>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const reload = useCallback(() => {
    appInbox()
      .load()
      .then(
        (s) => {
          setState(s);
          setNow(Date.now());
          setLoaded(true);
        },
        () => setLoaded(true),
      );
  }, []);
  useEffect(() => {
    reload();
    return appInbox().subscribe(reload);
  }, [reload]);
  useFocusEffect(reload);
  return { state, now, loaded, reload };
}

/** The unread count shown on Home's Inbox link. */
export function useInboxUnreadCount(): number {
  const { state, now } = useInbox();
  return inboxUnreadCount(state.entries, now);
}

/**
 * The notifications inbox (feature 83; ../wallet/inbox.ts): what the wallet
 * has told the user, newest first. Opening an entry marks it read and opens
 * the same screen its banner or notification opens. Read-only for every
 * kind of account (nothing here signs); the opened screen applies its own
 * gates (a watch-only or multisig account is refused where it cannot act).
 */
export function InboxScreen({ navigation }: Props) {
  const theme = useTheme();
  const { appPinOn } = usePrefs();
  const { state, now, loaded, reload } = useInbox();
  const entries = visibleInboxEntries(state.entries, now);
  const unread = inboxUnreadCount(state.entries, now);

  const open = (entry: InboxEntry) => {
    void appInbox().markRead(entry.id);
    const target = INBOX_TARGET_BY_KIND[entry.kind];
    // Activity opens on the Ethereum slot (the active EVM network), like the
    // sent views' explorer rows; the other targets take no parameters.
    if (target === 'Activity') navigation.navigate('Activity', { chainId: 'eip155:1' });
    else navigation.navigate(target);
  };

  const confirmReset = () =>
    Alert.alert(INBOX_RESET_TITLE, INBOX_RESET_BODY, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: () => void appInbox().reset().then(reload, reload) },
    ]);

  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={theme.textMuted} colors={[theme.accent]} />}
    >
      <Text style={[styles.body, { color: theme.text }]}>{INBOX_INTRO}</Text>
      {appPinOn ? <Text style={[styles.hint, { color: theme.textMuted }]}>{INBOX_PIN_NOTE}</Text> : null}
      {state.readOnly ? (
        <View style={styles.section}>
          <WarningBox>{INBOX_READ_ONLY_MESSAGE}</WarningBox>
          <Button title="Reset the inbox" variant="destructive" onPress={confirmReset} />
        </View>
      ) : null}
      <View style={styles.section}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>
          Messages
        </Text>
        <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.textMuted }]}>
          {inboxUnreadText(unread)}
        </Text>
        {unread > 0 && !state.readOnly ? (
          <Button title={INBOX_MARK_ALL_READ} variant="secondary" onPress={() => void appInbox().markAllRead()} />
        ) : null}
        {loaded && entries.length === 0 ? <Text style={[styles.hint, { color: theme.textMuted }]}>{INBOX_EMPTY}</Text> : null}
        {entries.map((entry) => {
          const label = `${entry.read ? '' : 'Unread. '}${inboxKindLabel(entry.kind)}, ${inboxViaLabel(entry.via)}, ${inboxTimeText(entry.at)}. ${entry.title}. ${entry.text}`;
          return (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityHint={inboxTargetHint(INBOX_TARGET_BY_KIND[entry.kind])}
              onPress={() => open(entry)}
              style={[styles.card, { borderColor: entry.read ? theme.border : theme.accent, backgroundColor: theme.card }]}
            >
              <Text style={[styles.meta, { color: theme.textMuted }]}>
                {entry.read ? '' : '● '}
                {inboxKindLabel(entry.kind)} · {inboxViaLabel(entry.via)} · {inboxTimeText(entry.at)}
              </Text>
              <Text style={[styles.entryTitle, { color: theme.text }]}>{entry.title}</Text>
              <Text style={[styles.entryText, { color: theme.text }]}>{entry.text}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{INBOX_SCHEDULED_NOTE}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 24 },
  section: { gap: 12 },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  hint: { fontSize: 13, lineHeight: 19 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 6 },
  meta: { fontSize: 13 },
  entryTitle: { fontSize: 16, fontWeight: '600' },
  entryText: { fontSize: 14, lineHeight: 20 },
});

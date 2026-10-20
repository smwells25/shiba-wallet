import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { T } from '../i18n/T';
import { useI18n } from '../i18n/useI18n';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { appLockKind } from '../wallet/duress';
import { TechnicalDetail } from '../wallet/connectivity';
import {
  INBOX_EMPTY,
  INBOX_INTRO,
  INBOX_LOAD_FAILED_MESSAGE,
  INBOX_MARK_ALL_READ,
  INBOX_PASSPHRASE_NOTE,
  INBOX_PIN_NOTE,
  INBOX_READ_ONLY_MESSAGE,
  INBOX_RECORD_FAILED_MESSAGE,
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
  loadInboxView,
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
 *
 * Pass p22b: a load the store rejected used to look exactly like an empty
 * inbox (the rejection only set `loaded`). It now comes back as
 * `loadFailure` (loadInboxView), and a failed write of an entry as
 * `recordFailure`, so the screen says so with the technical detail.
 */
export function useInbox(): {
  state: InboxState;
  now: number;
  loaded: boolean;
  loadFailure: string | null;
  recordFailure: string | null;
  reload: () => void;
} {
  const [state, setState] = useState<InboxState>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [recordFailure, setRecordFailure] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reload = useCallback(() => {
    void loadInboxView(appInbox()).then((view) => {
      setState(view.state);
      setLoadFailure(view.loadFailure);
      setRecordFailure(view.recordFailure);
      setNow(Date.now());
      setLoaded(true);
    });
  }, []);
  useEffect(() => {
    reload();
    return appInbox().subscribe(reload);
  }, [reload]);
  useFocusEffect(reload);
  return { state, now, loaded, loadFailure, recordFailure, reload };
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
  // Localisation (phase 22 item 6): the screen and its title follow the language.
  const { language, t, tx, localize } = useI18n();
  React.useLayoutEffect(() => {
    navigation.setOptions({ title: t('inbox.title') });
  }, [navigation, language, t]);
  const { appPinOn } = usePrefs();
  // The app lock's kind (a device fact): the note names the PIN or the passphrase.
  const inboxLockKind = React.useSyncExternalStore(appLockKind.subscribe, appLockKind.get);
  const { state, now, loaded, loadFailure, recordFailure, reload } = useInbox();
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
    Alert.alert(localize(INBOX_RESET_TITLE), localize(INBOX_RESET_BODY), [
      { text: tx('Cancel'), style: 'cancel' },
      { text: tx('Reset'), style: 'destructive', onPress: () => void appInbox().reset().then(reload, reload) },
    ]);

  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={theme.textMuted} colors={[theme.accent]} />}
    >
      <Text style={[styles.body, { color: theme.text }]}><T>{INBOX_INTRO}</T></Text>
      {appPinOn ? <Text style={[styles.hint, { color: theme.textMuted }]}><T>{inboxLockKind === 'phr' ? INBOX_PASSPHRASE_NOTE : INBOX_PIN_NOTE}</T></Text> : null}
      {loadFailure !== null ? (
        <View style={styles.section}>
          <WarningBox>{INBOX_LOAD_FAILED_MESSAGE}</WarningBox>
          <TechnicalDetail text={loadFailure} />
          <Button title="Try again" variant="secondary" onPress={reload} />
        </View>
      ) : null}
      {recordFailure !== null && loadFailure === null ? (
        <View style={styles.section}>
          <WarningBox>{INBOX_RECORD_FAILED_MESSAGE}</WarningBox>
          <TechnicalDetail text={recordFailure} />
        </View>
      ) : null}
      {state.readOnly ? (
        <View style={styles.section}>
          <WarningBox>{INBOX_READ_ONLY_MESSAGE}</WarningBox>
          <Button title="Reset the inbox" variant="destructive" onPress={confirmReset} />
        </View>
      ) : null}
      <View style={styles.section}>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: theme.text }]}>
          <T>Messages</T>
        </Text>
        <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.textMuted }]}>
          {inboxUnreadText(unread)}
        </Text>
        {unread > 0 && !state.readOnly ? (
          <Button title={INBOX_MARK_ALL_READ} variant="secondary" onPress={() => void appInbox().markAllRead()} />
        ) : null}
        {loaded && loadFailure === null && entries.length === 0 ? <Text style={[styles.hint, { color: theme.textMuted }]}><T>{INBOX_EMPTY}</T></Text> : null}
        {entries.map((entry) => {
          // An entry keeps the English sentence shown at the time; it is shown
          // translated when it is exactly a table entry (localize).
          const title = localize(entry.title);
          const text = localize(entry.text);
          const label = `${entry.read ? '' : `${t('inbox.entry.unread')} `}${t('inbox.entry.spoken', {
            kind: inboxKindLabel(entry.kind),
            via: inboxViaLabel(entry.via),
            time: inboxTimeText(entry.at),
            title,
            text,
          })}`;
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
              <Text style={[styles.entryTitle, { color: theme.text }]}>{title}</Text>
              <Text style={[styles.entryText, { color: theme.text }]}>{text}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.hint, { color: theme.textMuted }]}><T>{INBOX_SCHEDULED_NOTE}</T></Text>
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

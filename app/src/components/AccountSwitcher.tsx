import React, { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Button } from '../components';
import {
  SWITCHER_IMPORTED_LINE,
  createOverflowAnnouncer,
  spokenShortAddress,
  switcherRowSpokenLabel,
  type OverflowAnnouncer,
} from '../a11y';
import { useTheme } from '../theme';
import { shortAccountAddress } from '../wallet/accounts';
import {
  PHRASE_ACCOUNT_WAS_IMPORTED_TITLE,
  accountsBackupHint,
  phraseAccountSameAsImportedNote,
} from '../wallet/imported-keys';
import { useWallet, type AccountView } from '../wallet/WalletContext';
import { multisigSwitcherA11yLabel, multisigSwitcherNetworkLine } from '../wallet/multisig';
import {
  MULTISIG_LIST_HINT,
  MULTISIG_SWITCHER_LINE,
  PHRASE_ACCOUNT_WAS_WATCHED_TITLE,
  SWITCHER_INTRO_TOGGLE,
  SWITCHER_SCROLL_HINT,
  WATCH_ONLY_LIST_HINT,
  phraseAccountSameAsWatchedNote,
  switcherListOverflows,
} from '../wallet/watch-only';

/**
 * Home-screen account switcher (phase 6 item 3): a header row showing the
 * active account's name and short EVM address; tapping it opens a list of
 * the visible accounts. Choosing one makes it active — App.tsx keys the
 * navigator on the active index, so every screen restarts on the new
 * account and nothing prepared for the previous one (quotes, history,
 * balances) survives the switch. "Add account" creates the next index and
 * switches to it; renaming and hiding live in Settings → Accounts.
 * Imported accounts (feature 12, ADR D9) are listed with a line saying the
 * recovery phrase does not back them up. Watch-only accounts (feature 10)
 * are listed after them with a "Watch-only" label; choosing one shows its
 * balances, tokens, activity and NFTs, and every signing path refuses it.
 * Multi-signature accounts (feature 24; phase 18 item 3) come last, named
 * with their shape ("Multisig 2 (2-of-3)") and a "Multisig" chip; choosing
 * one shows its balance and EntryPoint deposit, and its operations are
 * built on the Multisig screen (every signing route refuses it).
 */
export function AccountSwitcher({ onManage, onImportKey }: { onManage: () => void; onImportKey: () => void }) {
  const theme = useTheme();
  const { activeAccount, accountList, watchOnlyAccounts, multisigAccounts, switchAccount, addAccount } = useWallet();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The "What is backed up?" expander (closed each time the list opens) and
  // the sizes the scroll hint is computed from.
  const [introOpen, setIntroOpen] = useState(false);
  const [listHeight, setListHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  // "More accounts below" spoken once per open when the list opens with
  // rows below the fold (pass p21a finding 7). ONE path per platform (pass
  // p21e finding B2c: on Android the line was spoken twice on open):
  // - Android: the polite live region below ALONE. The sizes are reset when
  //   the switcher opens (the onPress below), so the line is always absent
  //   at first and appears once the list is measured; that appearance is a
  //   content change the live region announces (passes p21b and p21e heard
  //   it on open — p21a, before the reset existed, did not, because the
  //   line was present from the window's first frame). The same live region
  //   speaks the line when it reappears after scrolling back up. The
  //   delayed announcement (a11y.ts createOverflowAnnouncer) is NOT used on
  //   Android: it repeated the line 500 ms later, and TalkBack then did not
  //   read "Accounts. Heading" on open (inferred from the p21e order).
  // - iOS: accessibilityLiveRegion is Android-only, so VoiceOver gets the
  //   announcement (AccessibilityInfo.announceForAccessibility posts a
  //   VoiceOver announcement; RN 0.86.3 AccessibilityInfo.js:474–480).
  const announceOnOpen = Platform.OS === 'ios';
  const [announcer] = useState<OverflowAnnouncer>(() =>
    createOverflowAnnouncer({
      message: SWITCHER_SCROLL_HINT,
      announce: (message) => AccessibilityInfo.announceForAccessibility(message),
      schedule: (run, ms) => setTimeout(run, ms),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }),
  );
  useEffect(() => {
    if (!announceOnOpen) return;
    if (open) announcer.opened();
    else announcer.closed();
  }, [announcer, announceOnOpen, open]);
  useEffect(() => {
    if (!announceOnOpen || !open) return;
    announcer.update({
      measured: listHeight > 0 && contentHeight > 0,
      overflows: switcherListOverflows({ listHeight, contentHeight, scrollY }),
    });
  }, [announcer, announceOnOpen, open, listHeight, contentHeight, scrollY]);
  // Unmounting drops a scheduled announcement (closed, not disposed, so a
  // development-mode effect re-run leaves the announcer usable).
  useEffect(() => () => announcer.closed(), [announcer]);

  if (!activeAccount) return null;
  // Accounts with a key first, then the watch-only ones and the multisigs
  // (neither is ever hidden).
  const visible = [...accountList.filter((a) => !a.hidden), ...watchOnlyAccounts, ...multisigAccounts];
  const anyImported = accountList.some((a) => a.imported);
  const anyWatched = watchOnlyAccounts.length > 0;
  const anyMultisig = multisigAccounts.length > 0;

  const choose = async (account: AccountView) => {
    if (account.index === activeAccount.index) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      setOpen(false);
      await switchAccount(account.index);
    } catch (e) {
      Alert.alert('Could not switch account', e instanceof Error ? e.message : 'Unknown error.');
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    try {
      const created = await addAccount();
      setOpen(false);
      await switchAccount(created.index);
      const sameKey = phraseAccountSameAsImportedNote(created, accountList);
      if (sameKey) Alert.alert(PHRASE_ACCOUNT_WAS_IMPORTED_TITLE, sameKey);
      const watched = phraseAccountSameAsWatchedNote(created, watchOnlyAccounts);
      if (watched) Alert.alert(PHRASE_ACCOUNT_WAS_WATCHED_TITLE, watched);
    } catch (e) {
      Alert.alert('Could not add account', e instanceof Error ? e.message : 'Unknown error.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Active account: ${activeAccount.name}${activeAccount.watchOnly ? ', watch-only, no key in this wallet' : ''}${activeAccount.multisig ? ', multi-signature account, operations need co-signers' : ''}. Switch account`}
        onPress={() => {
          setIntroOpen(false);
          setScrollY(0);
          // The list is mounted afresh (Android's Modal renders nothing while
          // hidden — Modal.js:278–289), so the sizes are measured again; the
          // old ones must not decide the announcement.
          setListHeight(0);
          setContentHeight(0);
          setOpen(true);
        }}
        style={({ pressed }) => [
          styles.header,
          { backgroundColor: theme.card, borderColor: theme.border, opacity: pressed ? 0.8 : 1 },
        ]}
      >
        <View style={styles.headerBody}>
          <Text style={[styles.headerName, { color: theme.text }]} numberOfLines={1}>
            {activeAccount.name}
          </Text>
          {activeAccount.evmAddress ? (
            <Text style={[styles.headerAddress, { color: theme.textMuted }]}>
              {shortAccountAddress(activeAccount.evmAddress)}
            </Text>
          ) : null}
          {activeAccount.watchOnly ? (
            <Text style={[styles.headerAddress, { color: theme.warningText }]}>Watch-only — no key in this wallet</Text>
          ) : null}
          {activeAccount.multisig ? (
            <Text style={[styles.headerAddress, { color: theme.warningText }]}>{MULTISIG_SWITCHER_LINE}</Text>
          ) : null}
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={theme.textMuted} />
        ) : (
          <Text style={[styles.chevron, { color: theme.accent }]}>Switch ▾</Text>
        )}
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={[styles.modal, { backgroundColor: theme.background }]}>
          <Text accessibilityRole="header" style={[styles.modalTitle, { color: theme.text }]}>Accounts</Text>
          {/*
            The account list is the one scrolling area between the title and
            the buttons (FlatList, flex 1). The intro used to sit above it
            and, with a multisig listed, took about eight lines at phone
            width, so the last row was cut off with no sign that the list
            scrolls. It is now a one-line "What is backed up?" expander in
            the list's header (collapsed by default, so it scrolls with the
            rows when opened); every row the phrase does not back up
            (imported, watch-only, multisig) keeps its own line saying so,
            and a scroll hint appears under the list while rows are still
            below.
          */}
          <FlatList
            data={visible}
            keyExtractor={(a) => String(a.index)}
            style={styles.listArea}
            contentContainerStyle={styles.list}
            persistentScrollbar
            // A light scroll indicator on the dark background (pass p20c
            // finding 18). indicatorStyle is iOS-only (RN 0.86.3
            // ScrollView.d.ts :433, in ScrollViewPropsIOS); Android has no
            // prop for the scrollbar colour (ReactScrollViewManager.kt lists
            // none), so there it stays the platform default and the scroll
            // hint below says when rows are hidden.
            indicatorStyle={theme.dark ? 'white' : 'black'}
            onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}
            onContentSizeChange={(_w, h) => setContentHeight(h)}
            onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}
            scrollEventThrottle={100}
            ListHeaderComponent={
              <View style={styles.introBlock}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={SWITCHER_INTRO_TOGGLE}
                  accessibilityState={{ expanded: introOpen }}
                  accessibilityHint="Shows which accounts your recovery phrase backs up"
                  onPress={() => setIntroOpen((v) => !v)}
                  hitSlop={8}
                >
                  <Text style={[styles.introToggle, { color: theme.accent }]} numberOfLines={1}>
                    {introOpen ? `${SWITCHER_INTRO_TOGGLE} ▾` : `${SWITCHER_INTRO_TOGGLE} ▸`}
                  </Text>
                </Pressable>
                {introOpen ? (
                  <Text style={[styles.hint, { color: theme.textMuted }]}>
                    {accountsBackupHint(anyImported, { watchOnly: anyWatched, multisig: anyMultisig })}
                    {anyWatched ? ` ${WATCH_ONLY_LIST_HINT}` : ''}
                    {anyMultisig ? ` ${MULTISIG_LIST_HINT}` : ''} To watch an address, use Manage accounts.
                  </Text>
                ) : null}
              </View>
            }
            renderItem={({ item }) => {
              const active = item.index === activeAccount.index;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  // Every row has an explicit label (pass p20c finding 5):
                  // the selected state is spoken from accessibilityState, so
                  // the visible ✓ is not read again, and addresses are spoken
                  // in the short form the row shows.
                  {...(item.watchOnly
                    ? { accessibilityLabel: `${item.name}, watch-only, ${item.evmAddress ? spokenShortAddress(item.evmAddress) : 'unknown address'}` }
                    : item.multisig
                      ? { accessibilityLabel: multisigSwitcherA11yLabel(item) }
                      : { accessibilityLabel: switcherRowSpokenLabel(item) })}
                  onPress={() => void choose(item)}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      backgroundColor: theme.card,
                      borderColor: active ? theme.accent : theme.border,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <View style={styles.headerBody}>
                    <View style={styles.nameRow}>
                      <Text style={[styles.rowName, styles.nameText, { color: theme.text }]} numberOfLines={1}>
                        {item.name}
                      </Text>
                      {item.multisig ? (
                        <Text style={[styles.chip, { color: theme.accent, borderColor: theme.accent }]}>Multisig</Text>
                      ) : null}
                    </View>
                    {item.evmAddress ? (
                      <Text style={[styles.headerAddress, { color: theme.textMuted }]}>
                        {shortAccountAddress(item.evmAddress)}
                      </Text>
                    ) : null}
                    {item.imported ? (
                      <Text style={[styles.headerAddress, { color: theme.warningText }]}>{SWITCHER_IMPORTED_LINE}</Text>
                    ) : null}
                    {item.watchOnly ? (
                      <Text style={[styles.headerAddress, { color: theme.warningText }]}>
                        Watch-only — the wallet holds no key; it cannot send or sign
                      </Text>
                    ) : null}
                    {item.multisig ? (
                      <Text style={[styles.headerAddress, { color: theme.warningText }]}>{MULTISIG_SWITCHER_LINE}</Text>
                    ) : null}
                    {item.multisig ? (
                      // The same signer set has the same address on every
                      // network, so the row names its network (pass p20b finding 9).
                      <Text style={[styles.headerAddress, { color: theme.textMuted }]}>
                        {multisigSwitcherNetworkLine(item.multisigInfo)}
                      </Text>
                    ) : null}
                  </View>
                  {active ? (
                    <Text
                      importantForAccessibility="no"
                      accessibilityElementsHidden
                      style={[styles.check, { color: theme.accent }]}
                    >
                      ✓
                    </Text>
                  ) : null}
                </Pressable>
              );
            }}
          />
          {/* "More accounts below" is spoken when it appears (pass p20d
              finding 8: TalkBack never reached it — swiping through the rows
              scrolls the list to its end, which removes the line first). An
              always-mounted polite live region (Android; RN 0.86.3
              ViewAccessibility.d.ts:245) whose content changes from nothing
              to the line, so the change is announced; collapsable={false}
              keeps the wrapper a real native view (Fabric flattens a plain
              View, ViewShadowNode.cpp:49), and while empty it is taken out of
              the flow so the modal's gap does not open around it. A focusable
              line at the list's end was not chosen: a person would reach it
              only after every row, when "more below" is no longer true. */}
          {(() => {
            const overflows = switcherListOverflows({ listHeight, contentHeight, scrollY });
            return (
              <View collapsable={false} accessibilityLiveRegion="polite" style={overflows ? null : styles.liveRegionIdle}>
                {overflows ? (
                  <Text style={[styles.scrollHint, { color: theme.textMuted }]}>{SWITCHER_SCROLL_HINT}</Text>
                ) : null}
              </View>
            );
          })()}
          <Button title="Add account" onPress={() => void add()} disabled={busy} />
          <Button
            title="Import a private key"
            variant="secondary"
            onPress={() => {
              setOpen(false);
              onImportKey();
            }}
          />
          <Button
            title="Manage accounts"
            variant="secondary"
            onPress={() => {
              setOpen(false);
              onManage();
            }}
          />
          <Button title="Close" variant="secondary" onPress={() => setOpen(false)} />
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  headerBody: {
    flex: 1,
    gap: 2,
  },
  headerName: {
    fontSize: 17,
    fontWeight: '700',
  },
  headerAddress: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  chevron: {
    fontSize: 14,
    fontWeight: '600',
  },
  modal: {
    flex: 1,
    padding: 24,
    paddingTop: 48,
    gap: 12,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '700',
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  introBlock: {
    gap: 6,
  },
  introToggle: {
    fontSize: 14,
    fontWeight: '600',
    paddingVertical: 2,
  },
  // Explicit, although a vertical ScrollView already grows and shrinks by
  // default: the list takes the space between the title and the buttons
  // and scrolls inside it.
  listArea: {
    flexGrow: 1,
    flexShrink: 1,
  },
  list: {
    gap: 10,
    paddingVertical: 8,
  },
  scrollHint: {
    fontSize: 12,
    textAlign: 'center',
  },
  // The empty live region: out of the flow (no gap around it), no size.
  liveRegionIdle: {
    position: 'absolute',
    width: 0,
    height: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  rowName: {
    fontSize: 16,
    fontWeight: '600',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  nameText: {
    flexShrink: 1,
  },
  chip: {
    fontSize: 11,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  check: {
    fontSize: 18,
    fontWeight: '700',
  },
});

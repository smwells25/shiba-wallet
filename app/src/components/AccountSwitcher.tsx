import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Button } from '../components';
import { useTheme } from '../theme';
import { shortAccountAddress } from '../wallet/accounts';
import {
  PHRASE_ACCOUNT_WAS_IMPORTED_TITLE,
  accountsBackupHint,
  phraseAccountSameAsImportedNote,
} from '../wallet/imported-keys';
import { useWallet, type AccountView } from '../wallet/WalletContext';

/**
 * Home-screen account switcher (phase 6 item 3): a header row showing the
 * active account's name and short EVM address; tapping it opens a list of
 * the visible accounts. Choosing one makes it active — App.tsx keys the
 * navigator on the active index, so every screen restarts on the new
 * account and nothing prepared for the previous one (quotes, history,
 * balances) survives the switch. "Add account" creates the next index and
 * switches to it; renaming and hiding live in Settings → Accounts.
 * Imported accounts (feature 12, ADR D9) are listed with a line saying the
 * recovery phrase does not back them up.
 */
export function AccountSwitcher({ onManage, onImportKey }: { onManage: () => void; onImportKey: () => void }) {
  const theme = useTheme();
  const { activeAccount, accountList, switchAccount, addAccount } = useWallet();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!activeAccount) return null;
  const visible = accountList.filter((a) => !a.hidden);
  const anyImported = accountList.some((a) => a.imported);

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
        accessibilityLabel={`Active account: ${activeAccount.name}. Switch account`}
        onPress={() => setOpen(true)}
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
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={theme.textMuted} />
        ) : (
          <Text style={[styles.chevron, { color: theme.accent }]}>Switch ▾</Text>
        )}
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={[styles.modal, { backgroundColor: theme.background }]}>
          <Text style={[styles.modalTitle, { color: theme.text }]}>Accounts</Text>
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            {accountsBackupHint(anyImported)}
          </Text>
          <FlatList
            data={visible}
            keyExtractor={(a) => String(a.index)}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => {
              const active = item.index === activeAccount.index;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
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
                    <Text style={[styles.rowName, { color: theme.text }]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {item.evmAddress ? (
                      <Text style={[styles.headerAddress, { color: theme.textMuted }]}>
                        {shortAccountAddress(item.evmAddress)}
                      </Text>
                    ) : null}
                    {item.imported ? (
                      <Text style={[styles.headerAddress, { color: theme.warningText }]}>
                        Imported key, Ethereum only — not backed up by your recovery phrase
                      </Text>
                    ) : null}
                  </View>
                  {active ? <Text style={[styles.check, { color: theme.accent }]}>✓</Text> : null}
                </Pressable>
              );
            }}
          />
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
  list: {
    gap: 10,
    paddingVertical: 8,
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
  check: {
    fontSize: 18,
    fontWeight: '700',
  },
});

import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../components';
import { useTheme } from '../theme';
import { MAX_ACCOUNT_NAME_LENGTH, shortAccountAddress } from '../wallet/accounts';
import { useWallet, type AccountView } from '../wallet/WalletContext';

/**
 * Settings → Accounts (phase 6 item 3): list, add, rename, hide and show
 * again. Every account derives from the one recovery phrase (ADR D8 in
 * docs/ARCHITECTURE.md); hiding never deletes anything and never frees the
 * index, so a later "Add account" can never land on a key that was
 * already used under another name.
 */
export function AccountsSection() {
  const theme = useTheme();
  const {
    activeAccount,
    accountList,
    addAccount,
    renameAccount,
    hideAccount,
    unhideAccount,
    switchAccount,
  } = useWallet();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const visible = accountList.filter((a) => !a.hidden);
  const hidden = accountList.filter((a) => a.hidden);

  const run = async (title: string, task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
      return true;
    } catch (e) {
      Alert.alert(title, e instanceof Error ? e.message : 'Unknown error.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onAdd = async () => {
    const ok = await run('Could not add account', () => addAccount(newName.trim() || null));
    if (ok) setNewName('');
  };

  const onRename = async (account: AccountView) => {
    const ok = await run('Could not rename account', () => renameAccount(account.index, draft));
    if (ok) setEditing(null);
  };

  const onHide = (account: AccountView) => {
    Alert.alert(
      `Hide ${account.name}?`,
      'Hiding only removes it from the lists. Its addresses, funds and keys are ' +
        'unchanged, it stays recoverable from your recovery phrase, and you can ' +
        'show it again here at any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Hide',
          onPress: () => void run('Could not hide account', () => hideAccount(account.index)),
        },
      ],
    );
  };

  const renderRow = (account: AccountView) => {
    const active = account.index === activeAccount?.index;
    const isEditing = editing === account.index;
    return (
      <View
        key={account.index}
        style={[
          styles.row,
          { backgroundColor: theme.card, borderColor: active ? theme.accent : theme.border },
        ]}
      >
        <View style={styles.rowHeader}>
          <Text style={[styles.rowName, { color: theme.text }]} numberOfLines={1}>
            {account.name}
          </Text>
          <Text style={[styles.tag, { color: active ? theme.accent : theme.textMuted }]}>
            {active ? 'Active' : account.hidden ? 'Hidden' : `#${account.index}`}
          </Text>
        </View>
        {account.evmAddress ? (
          <Text style={[styles.address, { color: theme.textMuted }]}>
            {shortAccountAddress(account.evmAddress)} · derivation index {account.index}
          </Text>
        ) : null}
        {isEditing ? (
          <View style={styles.editor}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              autoFocus
              maxLength={MAX_ACCOUNT_NAME_LENGTH * 2}
              placeholder="Account name"
              placeholderTextColor={theme.textMuted}
              style={[
                styles.input,
                { color: theme.text, borderColor: theme.border, backgroundColor: theme.background },
              ]}
            />
            <View style={styles.buttons}>
              <Button
                title="Save"
                onPress={() => void onRename(account)}
                disabled={busy}
                style={styles.flex}
              />
              <Button
                title="Cancel"
                variant="secondary"
                onPress={() => setEditing(null)}
                style={styles.flex}
              />
            </View>
          </View>
        ) : account.hidden ? (
          <Button
            title="Show again"
            variant="secondary"
            disabled={busy}
            onPress={() => void run('Could not show account', () => unhideAccount(account.index))}
          />
        ) : (
          <View style={styles.links}>
            {!active ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() =>
                  void run('Could not switch account', () => switchAccount(account.index))
                }
                hitSlop={8}
              >
                <Text style={[styles.link, { color: theme.accent }]}>Use</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setDraft(account.name);
                setEditing(account.index);
              }}
              hitSlop={8}
            >
              <Text style={[styles.link, { color: theme.accent }]}>Rename</Text>
            </Pressable>
            {account.index !== 0 && !active ? (
              <Pressable accessibilityRole="button" onPress={() => onHide(account)} hitSlop={8}>
                <Text style={[styles.link, { color: theme.accent }]}>Hide</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.text }]}>Accounts</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Every account comes from your one recovery phrase, so the phrase backs
        up all of them. Account addresses follow the common conventions:
        Ethereum m/44'/60'/0'/0/N (as MetaMask), Solana m/44'/501'/N'/0' (as
        Phantom), Bitcoin m/84'/0'/N'/0/0 and Dogecoin m/44'/3'/N'/0/0. After
        restoring the phrase on a new device, add accounts again in the same
        order to get the same addresses back.
      </Text>
      {visible.map(renderRow)}
      <View style={styles.editor}>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          maxLength={MAX_ACCOUNT_NAME_LENGTH * 2}
          placeholder="New account name (optional)"
          placeholderTextColor={theme.textMuted}
          style={[
            styles.input,
            { color: theme.text, borderColor: theme.border, backgroundColor: theme.card },
          ]}
        />
        <Button title="Add account" onPress={() => void onAdd()} disabled={busy} />
      </View>
      {hidden.length > 0 ? (
        <>
          <Pressable accessibilityRole="button" onPress={() => setShowHidden((v) => !v)} hitSlop={8}>
            <Text style={[styles.link, { color: theme.accent }]}>
              {showHidden ? 'Hide hidden accounts' : `Show hidden accounts (${hidden.length})`}
            </Text>
          </Pressable>
          {showHidden ? hidden.map(renderRow) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  row: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  tag: {
    fontSize: 12,
    fontWeight: '600',
  },
  address: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  links: {
    flexDirection: 'row',
    gap: 20,
  },
  link: {
    fontSize: 14,
    fontWeight: '600',
  },
  editor: {
    gap: 10,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  buttons: {
    flexDirection: 'row',
    gap: 10,
  },
  flex: {
    flex: 1,
  },
});

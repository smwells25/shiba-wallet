import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../components';
import { useTheme } from '../theme';
import { MAX_ACCOUNT_NAME_LENGTH, shortAccountAddress } from '../wallet/accounts';
import { importedSlotOf } from '../wallet/account-ids';
import { requireLocalAuth } from '../wallet/biometric';
import {
  REMOVE_IMPORTED_CONFIRM_MESSAGE,
  REMOVE_IMPORTED_CONFIRM_TITLE,
  REMOVE_IMPORTED_TITLE,
  REVEAL_IMPORTED_MESSAGE,
  REVEAL_IMPORTED_TITLE,
  removeImportedMessage,
} from '../wallet/imported-keys';
import { PROMPTS } from '../wallet/storage';
import { useWallet, type AccountView } from '../wallet/WalletContext';
import { ImportedKeyReveal } from './ImportedKeyReveal';

/**
 * Settings → Accounts (phase 6 item 3): list, add, rename, hide and show
 * again. Every account derives from the one recovery phrase (ADR D8 in
 * docs/ARCHITECTURE.md); hiding never deletes anything and never frees the
 * index, so a later "Add account" can never land on a key that was
 * already used under another name.
 *
 * Imported accounts (feature 12, ADR D9) are listed with the others but
 * labelled as NOT backed up by the recovery phrase; they cannot be hidden,
 * only removed, which deletes their key after two confirmations that state
 * the consequence. "Show private key" uses the same confirmation, biometric
 * gate and screenshot block as the recovery-phrase reveal.
 */
export function AccountsSection({ onImportKey }: { onImportKey: () => void }) {
  const theme = useTheme();
  const {
    activeAccount,
    accountList,
    addAccount,
    renameAccount,
    hideAccount,
    unhideAccount,
    switchAccount,
    removeImportedAccount,
    revealImportedKey,
  } = useWallet();
  const [revealed, setRevealed] = useState<{ name: string; address: string; key: string } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  const visible = accountList.filter((a) => !a.hidden);
  const hidden = accountList.filter((a) => a.hidden);
  const importedCount = accountList.filter((a) => a.imported).length;

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

  const onRemoveImported = (account: AccountView) => {
    Alert.alert(REMOVE_IMPORTED_TITLE, removeImportedMessage(account.name, account.evmAddress ?? 'unknown address'), [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Continue',
        style: 'destructive',
        onPress: () =>
          Alert.alert(REMOVE_IMPORTED_CONFIRM_TITLE, REMOVE_IMPORTED_CONFIRM_MESSAGE, [
            { text: 'Keep it', style: 'cancel' },
            {
              text: 'Delete the key',
              style: 'destructive',
              onPress: () => void run('Could not remove account', () => removeImportedAccount(account.index)),
            },
          ]),
      },
    ]);
  };

  const onRevealImported = (account: AccountView) => {
    Alert.alert(REVEAL_IMPORTED_TITLE, REVEAL_IMPORTED_MESSAGE, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Show it',
        style: 'destructive',
        onPress: async () => {
          // The same gate as the phrase reveal, opening THIS key (one prompt
          // when it is protected).
          const auth = await requireLocalAuth(PROMPTS.importedKeyReveal, {
            kind: 'imported',
            slot: importedSlotOf(account.index),
          });
          if (!auth.ok) {
            Alert.alert('Not revealed', auth.message);
            return;
          }
          try {
            const key = await revealImportedKey(account.index);
            setRevealed({ name: account.name, address: account.evmAddress ?? '', key });
          } catch (e) {
            Alert.alert('Not revealed', e instanceof Error ? e.message : 'The key could not be opened.');
          }
        },
      },
    ]);
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
            {active ? 'Active' : account.hidden ? 'Hidden' : account.imported ? 'Imported' : `#${account.index}`}
          </Text>
        </View>
        {account.imported ? (
          <Text style={[styles.address, { color: theme.warningText }]}>
            {account.evmAddress ? `${shortAccountAddress(account.evmAddress)} · ` : 'Key record unreadable · '}
            imported private key, Ethereum only — NOT backed up by your recovery phrase
          </Text>
        ) : account.evmAddress ? (
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
                setDraft(account.storedName);
                setEditing(account.index);
              }}
              hitSlop={8}
            >
              <Text style={[styles.link, { color: theme.accent }]}>Rename</Text>
            </Pressable>
            {account.imported ? (
              <Pressable accessibilityRole="button" onPress={() => onRevealImported(account)} hitSlop={8}>
                <Text style={[styles.link, { color: theme.accent }]}>Show private key</Text>
              </Pressable>
            ) : null}
            {account.imported && !active ? (
              <Pressable accessibilityRole="button" onPress={() => onRemoveImported(account)} hitSlop={8}>
                <Text style={[styles.link, { color: theme.danger }]}>Remove</Text>
              </Pressable>
            ) : null}
            {!account.imported && account.index !== 0 && !active ? (
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
        Ethereum m/44&apos;/60&apos;/0&apos;/0/N (as MetaMask), Solana m/44&apos;/501&apos;/N&apos;/0&apos; (as
        Phantom), Bitcoin m/84&apos;/0&apos;/N&apos;/0/0 and Dogecoin m/44&apos;/3&apos;/N&apos;/0/0. After
        restoring the phrase on a new device, add accounts again in the same
        order to get the same addresses back.
        {importedCount > 0
          ? ' Imported accounts are the exception: they come from a private key you imported, so the ' +
            'recovery phrase does NOT back them up and restoring the phrase does not bring them back.'
          : ''}
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
        <Button
          title="Import a private key (Ethereum only)"
          variant="secondary"
          onPress={onImportKey}
          disabled={busy}
          accessibilityHint="Adds an account from a single Ethereum private key. It is not backed up by your recovery phrase."
        />
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
      {revealed ? (
        <ImportedKeyReveal
          accountName={revealed.name}
          address={revealed.address}
          privateKey={revealed.key}
          onClose={() => setRevealed(null)}
        />
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

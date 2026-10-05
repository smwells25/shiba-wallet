import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../components';
import { useTheme } from '../theme';
import { MAX_ACCOUNT_NAME_LENGTH, shortAccountAddress } from '../wallet/accounts';
import { importedSlotOf } from '../wallet/account-ids';
import { requireLocalAuth } from '../wallet/biometric';
import {
  accountsBackupHint,
  PHRASE_ACCOUNT_WAS_IMPORTED_TITLE,
  phraseAccountSameAsImportedNote,
  REMOVE_IMPORTED_CONFIRM_MESSAGE,
  REMOVE_IMPORTED_CONFIRM_TITLE,
  REMOVE_IMPORTED_TITLE,
  REVEAL_IMPORTED_MESSAGE,
  REVEAL_IMPORTED_TITLE,
  importedRemovalStrandedSentence,
  removeImportedMessage,
} from '../wallet/imported-keys';
import { PROMPTS, dropPhraseTicket } from '../wallet/storage';
import { getEndpoint } from '../config/networks';
import { usePrefs } from '../wallet/PrefsContext';
import { getAaConfig, readOwnerSmartAccountHoldings } from '../wallet/aa';
import { formatUnits } from '../wallet/balances';
import { EVM_CHAIN_ID } from '../wallet/send';
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
  const { evmChain } = usePrefs();
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
    const out: { created: AccountView | null } = { created: null };
    const ok = await run('Could not add account', async () => {
      out.created = await addAccount(newName.trim() || null);
    });
    if (ok) setNewName('');
    const sameKey = out.created ? phraseAccountSameAsImportedNote(out.created, accountList) : null;
    if (sameKey) Alert.alert(PHRASE_ACCOUNT_WAS_IMPORTED_TITLE, sameKey);
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

  const onRemoveImported = async (account: AccountView) => {
    // What else this key controls on the network in use (its smart account
    // and EntryPoint deposit), best effort and bounded in time: a failed or
    // slow read is named as such in the dialog and never blocks it.
    setBusy(true);
    let stranded: string | null = null;
    try {
      stranded = await removalStrandedSentence(account, evmChain);
    } finally {
      setBusy(false);
    }
    Alert.alert(
      REMOVE_IMPORTED_TITLE,
      removeImportedMessage(account.name, account.evmAddress ?? 'unknown address', stranded),
      [
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
                onPress: async () => {
                  // Deleting the only copy of a key needs the device check
                  // (finding 4 of the 2026-10-04 private-key run), after both
                  // dialogs; a cancel leaves everything untouched. The prompt
                  // targets THIS key, so a protected key is opened by its own
                  // system prompt; the held copy is dropped right after.
                  const auth = await requireLocalAuth(PROMPTS.importedKeyRemove, {
                    kind: 'imported',
                    slot: importedSlotOf(account.index),
                  });
                  if (!auth.ok) {
                    Alert.alert('Not removed', `${auth.message} Nothing was deleted.`);
                    return;
                  }
                  void run('Could not remove account', async () => {
                    try {
                      await removeImportedAccount(account.index);
                    } finally {
                      dropPhraseTicket();
                    }
                  });
                },
              },
            ]),
        },
      ],
    );
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
              <Pressable accessibilityRole="button" onPress={() => void onRemoveImported(account)} hitSlop={8}>
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
        {accountsBackupHint(importedCount > 0)} Account addresses from the
        phrase follow the common conventions: Ethereum m/44&apos;/60&apos;/0&apos;/0/N (as
        MetaMask), Solana m/44&apos;/501&apos;/N&apos;/0&apos; (as Phantom), Bitcoin
        m/84&apos;/0&apos;/N&apos;/0/0 and Dogecoin m/44&apos;/3&apos;/N&apos;/0/0. After restoring the
        phrase on a new device, add accounts again in the same order to get the
        same addresses back.
        {importedCount > 0 ? ' Restoring the phrase does not bring imported accounts back.' : ''}
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

/** How long the removal dialog waits for the smart-account read before naming it as unchecked. */
const REMOVAL_READ_TIMEOUT_MS = 6_000;

/**
 * The removal dialog's sentence about the key's smart account on the
 * network in use (wallet/imported-keys.ts importedRemovalStrandedSentence),
 * read through aa.ts readOwnerSmartAccountHoldings. Never throws; a read
 * that fails or takes longer than REMOVAL_READ_TIMEOUT_MS is reported as
 * "could not be checked" when smart-account settings exist, and nothing is
 * said when they do not.
 */
async function removalStrandedSentence(
  account: AccountView,
  evmChain: { chainIdDecimal: string; displaySymbol: string; label: string },
): Promise<string | null> {
  const owner = account.evmAddress;
  if (!owner) return null;
  try {
    const endpoint = await getEndpoint(EVM_CHAIN_ID);
    if (!endpoint?.url || endpoint.network.kind !== 'evm-jsonrpc') return null;
    const config = await getAaConfig(endpoint.network.chainId);
    const chainId = BigInt(evmChain.chainIdDecimal);
    const read = readOwnerSmartAccountHoldings(config, {
      nodeUrl: endpoint.url,
      chainId,
      accountIndex: account.index,
      ownerAddress: owner,
    });
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), REMOVAL_READ_TIMEOUT_MS));
    const holdings = await Promise.race([read, timeout]);
    const format = (wei: bigint) => `${formatUnits(wei, 18, 18)} ${evmChain.displaySymbol}`;
    if (holdings === 'timeout') {
      // readOwnerSmartAccountHoldings returns 'none' quickly when there are no
      // settings, so a timeout means settings exist and the read was slow.
      return importedRemovalStrandedSentence({ kind: 'unknown', network: evmChain.label }, format);
    }
    return importedRemovalStrandedSentence(holdings, format);
  } catch {
    return null;
  }
}

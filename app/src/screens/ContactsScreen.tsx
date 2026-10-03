import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation';
import { Button, WarningBox, screenStyle } from '../components';
import { QrScanner } from '../components/QrScanner';
import { resolveActiveNetworks } from '../config/defaults';
import { useTheme } from '../theme';
import { usePrefs } from '../wallet/PrefsContext';
import { extractScannedAddress } from '../wallet/scan';
import {
  LookalikeContactError,
  MAX_CONTACT_NAME_LENGTH,
  addContact,
  deleteContact,
  loadContacts,
  renameContact,
  resetContacts,
  validateContactAddress,
  type Contact,
} from '../wallet/contacts';

type Props = NativeStackScreenProps<RootStackParamList, 'Contacts'>;

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** One chain section: the slot id (for scanning) and the ACTIVE network. */
interface NetworkSection {
  slot: string;
  networkId: string;
  label: string;
  contacts: Contact[];
}

/**
 * Contacts management (phase 6 item 4): the saved contacts of every
 * ACTIVE network (the Ethereum section is Sepolia while test mode is on,
 * and shows only Sepolia contacts), plus add / rename / delete. Every
 * address is validated by the same engine-backed path the send screen
 * uses before anything is saved (see ../wallet/contacts.ts). Addresses
 * are always shown in full: a contact list that showed names or shortened
 * addresses alone would invite exactly the look-alike confusion that
 * address poisoning relies on.
 */
export function ContactsScreen(_props: Props) {
  const theme = useTheme();
  const { sepolia } = usePrefs();
  const networks = useMemo(() => resolveActiveNetworks(sepolia), [sepolia]);

  const [sections, setSections] = useState<NetworkSection[]>([]);
  const [corrupt, setCorrupt] = useState(false);
  const [unreadable, setUnreadable] = useState(false);

  // Add form.
  const [addSlot, setAddSlot] = useState<string>(networks[0]?.slot ?? '');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);

  // Inline rename: the address of the contact being renamed.
  const [renaming, setRenaming] = useState<{ networkId: string; address: string } | null>(null);
  const [renameText, setRenameText] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const reload = useCallback(() => {
    let cancelled = false;
    Promise.all(
      networks.map(async ({ slot, network }) => ({
        slot,
        networkId: network.chainId,
        label: network.label,
        load: await loadContacts(network.chainId),
      })),
    ).then(
      (loaded) => {
        if (cancelled) return;
        setSections(
          loaded.map(({ slot, networkId, label, load }) => ({
            slot,
            networkId,
            label,
            contacts: load.contacts,
          })),
        );
        setCorrupt(loaded.some((l) => l.load.corrupt));
        setUnreadable(loaded.some((l) => l.load.unreadable));
      },
      () => {
        if (!cancelled) setSections([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [networks]);

  useEffect(reload, [reload]);

  const addNetwork = networks.find((n) => n.slot === addSlot) ?? networks[0];
  const addNetworkId = addNetwork?.network.chainId ?? '';
  const addressCheck = address.trim() ? validateContactAddress(addNetworkId, address) : null;

  const resetAddForm = () => {
    setName('');
    setAddress('');
    setAddError(null);
  };

  const onAdd = async (acknowledgeLookalike = false) => {
    if (!addNetwork) return;
    setBusy(true);
    setAddError(null);
    try {
      await addContact(addNetworkId, name, address, { acknowledgeLookalike });
      resetAddForm();
      reload();
    } catch (e) {
      if (e instanceof LookalikeContactError) {
        Alert.alert('Similar to an existing contact', e.message, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save anyway', style: 'destructive', onPress: () => void onAdd(true) },
        ]);
      } else {
        setAddError(e instanceof Error ? e.message : 'Could not save this contact.');
      }
    } finally {
      setBusy(false);
    }
  };

  const onRenameSave = async () => {
    if (!renaming) return;
    setRenameError(null);
    try {
      await renameContact(renaming.networkId, renaming.address, renameText);
      setRenaming(null);
      setRenameText('');
      reload();
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : 'Could not rename this contact.');
    }
  };

  const onDelete = (contact: Contact) => {
    Alert.alert(
      `Delete “${contact.name}”?`,
      `${contact.address}\n\nThis only removes the saved name from this app. ` +
        'Nothing on the blockchain changes.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteContact(contact.networkId, contact.address);
            } catch (e) {
              Alert.alert('Not deleted', e instanceof Error ? e.message : 'Could not delete.');
            }
            reload();
          },
        },
      ],
    );
  };

  const onReset = () => {
    Alert.alert(
      'Reset contacts?',
      'The saved contacts could not be read. Resetting replaces them with an ' +
        'empty list on every network. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await resetContacts();
            reload();
          },
        },
      ],
    );
  };

  const inputStyle = [
    styles.input,
    { color: theme.text, borderColor: theme.border, backgroundColor: theme.card },
  ];

  return (
    <ScrollView
      style={screenStyle(theme)}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.hint, { color: theme.textMuted }]}>
        Named addresses for sending. A contact name is shown only when a
        recipient matches a saved address exactly, and always together with
        the full address. Addresses that merely look similar to a contact
        get a warning instead — a common scam sends you tiny amounts from a
        look-alike address, hoping you copy it later.
        {sepolia ? ' Sepolia test mode is on: the Ethereum list below is your Sepolia contacts.' : ''}
      </Text>

      {unreadable ? (
        <View style={styles.section}>
          <WarningBox>
            Your saved contacts could not be read (the stored data is damaged
            or from a newer app version). Nothing is shown and nothing will be
            overwritten until you reset the list.
          </WarningBox>
          <Button title="Reset contacts" variant="destructive" onPress={onReset} />
        </View>
      ) : corrupt ? (
        <WarningBox>
          Some saved contacts failed validation and are hidden. They will not
          be used to label any address.
        </WarningBox>
      ) : null}

      {sections.map((section) => (
        <View key={section.networkId} style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>{section.label}</Text>
          {section.contacts.length === 0 ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>No contacts.</Text>
          ) : (
            section.contacts.map((contact) => {
              const isRenaming =
                renaming?.networkId === contact.networkId && renaming.address === contact.address;
              return (
                <View
                  key={contact.address}
                  style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
                >
                  {isRenaming ? (
                    <>
                      <TextInput
                        value={renameText}
                        accessibilityLabel={`New name for ${contact.name}`}
                        onChangeText={(t) => {
                          setRenameText(t);
                          setRenameError(null);
                        }}
                        autoCorrect={false}
                        maxLength={MAX_CONTACT_NAME_LENGTH * 2}
                        style={[
                          styles.input,
                          {
                            color: theme.text,
                            borderColor: theme.border,
                            backgroundColor: theme.background,
                          },
                        ]}
                      />
                      {renameError ? (
                        <Text style={[styles.error, { color: theme.danger }]}>{renameError}</Text>
                      ) : null}
                    </>
                  ) : (
                    <Text style={[styles.contactName, { color: theme.text }]}>{contact.name}</Text>
                  )}
                  <Text selectable style={[styles.address, { color: theme.textMuted }]}>
                    {contact.address}
                  </Text>
                  <View style={styles.buttonRow}>
                    {isRenaming ? (
                      <>
                        <Button
                          title="Save"
                          onPress={() => void onRenameSave()}
                          style={styles.smallButton}
                        />
                        <Button
                          title="Cancel"
                          variant="secondary"
                          onPress={() => {
                            setRenaming(null);
                            setRenameError(null);
                          }}
                          style={styles.smallButton}
                        />
                      </>
                    ) : (
                      <>
                        <Button
                          title="Rename"
                          variant="secondary"
                          disabled={unreadable}
                          onPress={() => {
                            setRenaming({ networkId: contact.networkId, address: contact.address });
                            setRenameText(contact.name);
                            setRenameError(null);
                          }}
                          style={styles.smallButton}
                        />
                        <Button
                          title="Delete"
                          variant="destructive"
                          disabled={unreadable}
                          onPress={() => onDelete(contact)}
                          style={styles.smallButton}
                        />
                      </>
                    )}
                  </View>
                </View>
              );
            })
          )}
        </View>
      ))}

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Add a contact</Text>
        <View style={styles.chainRow}>
          {networks.map(({ slot, network }) => (
            <Button
              key={slot}
              title={slot === addSlot ? `✓ ${network.label}` : network.label}
              variant={slot === addSlot ? 'primary' : 'secondary'}
              onPress={() => {
                setAddSlot(slot);
                setAddError(null);
              }}
              style={styles.chainButton}
            />
          ))}
        </View>
        <TextInput
          value={name}
          onChangeText={(t) => {
            setName(t);
            setAddError(null);
          }}
          accessibilityLabel="Contact name"
          placeholder="Name"
          placeholderTextColor={theme.textMuted}
          autoCorrect={false}
          maxLength={MAX_CONTACT_NAME_LENGTH * 2}
          style={inputStyle}
        />
        <View style={styles.addressRow}>
          <TextInput
            value={address}
            onChangeText={(t) => {
              setAddress(t);
              setAddError(null);
            }}
            accessibilityLabel={`${addNetwork?.network.label ?? ''} address`}
            placeholder={`${addNetwork?.network.label ?? ''} address`}
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[...inputStyle, styles.flex]}
          />
          <Button
            title="Scan"
            variant="secondary"
            onPress={() => setScannerOpen(true)}
            style={styles.smallButton}
          />
        </View>
        <QrScanner
          visible={scannerOpen}
          rationale={`Point the camera at a ${addNetwork?.network.label ?? ''} address QR code. The camera is only used to read the code.`}
          onScanned={(data) => {
            setScannerOpen(false);
            // Same conservative extraction as the send screen: only the
            // chosen chain's own URI scheme is stripped, and the result
            // is validated like typed input before anything is saved.
            setAddress(extractScannedAddress(addSlot, data));
            setAddError(null);
          }}
          onClose={() => setScannerOpen(false)}
        />
        {addressCheck && !addressCheck.ok ? (
          <Text style={[styles.error, { color: theme.danger }]}>{addressCheck.error}</Text>
        ) : null}
        {addressCheck?.ok && addressCheck.address !== address.trim() ? (
          <Text style={[styles.hint, { color: theme.textMuted }]}>
            Will be saved as {addressCheck.address}
          </Text>
        ) : null}
        {addError ? <Text style={[styles.error, { color: theme.danger }]}>{addError}</Text> : null}
        <Button
          title="Save contact"
          onPress={() => void onAdd()}
          disabled={busy || unreadable || name.trim() === '' || !addressCheck?.ok}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 24,
    gap: 24,
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  error: {
    fontSize: 13,
    lineHeight: 19,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 8,
  },
  contactName: {
    fontSize: 16,
    fontWeight: '700',
  },
  address: {
    fontFamily: mono,
    fontSize: 13,
    lineHeight: 19,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  smallButton: {
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  chainRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chainButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  addressRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
});


import React, { useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Button, WarningBox } from '../components';
import { useTheme } from '../theme';
import {
  LookalikeContactError,
  MAX_CONTACT_NAME_LENGTH,
  addContact,
  lookalikeWarning,
  type Contact,
  type RecipientContactMatch,
} from '../wallet/contacts';

/**
 * Shared contact UI for the send flow (phase 6 item 4). The anti-poisoning
 * presentation rules from ../wallet/contacts.ts are enforced here: a
 * matched contact is always rendered as its name TOGETHER with the full
 * address, and a look-alike match is only ever rendered as a warning.
 */

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/**
 * The recipient's contact status: the name plus the full address for an
 * exact match, the look-alike warning for a near miss, nothing otherwise.
 */
export function RecipientContactNotice({
  match,
  address,
}: {
  match: RecipientContactMatch;
  /** The full recipient address being sent to (always rendered in full). */
  address: string;
}) {
  const theme = useTheme();
  if (match.kind === 'lookalike') {
    return <WarningBox>{lookalikeWarning(match.contacts)}</WarningBox>;
  }
  if (match.kind !== 'exact') return null;
  return (
    <View style={[styles.contactBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.contactLabel, { color: theme.textMuted }]}>Saved contact</Text>
      <Text style={[styles.contactName, { color: theme.text }]}>{match.contact.name}</Text>
      <Text selectable style={[styles.address, { color: theme.text }]}>
        {address}
      </Text>
    </View>
  );
}

/** Modal list of the active network's contacts; picking fills the recipient. */
export function ContactPicker({
  visible,
  contacts,
  networkLabel,
  onPick,
  onClose,
  onManage,
}: {
  visible: boolean;
  contacts: readonly Contact[];
  networkLabel: string;
  onPick: (contact: Contact) => void;
  onClose: () => void;
  /** Opens the Contacts management screen (omitted: no link shown). */
  onManage?: () => void;
}) {
  const theme = useTheme();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.modal, { backgroundColor: theme.background }]}>
        <Text style={[styles.modalTitle, { color: theme.text }]}>{networkLabel} contacts</Text>
        <ScrollView contentContainerStyle={styles.list}>
          {contacts.length === 0 ? (
            <Text style={[styles.hint, { color: theme.textMuted }]}>
              No saved {networkLabel} contacts yet. Add them in Settings → Contacts.
            </Text>
          ) : (
            contacts.map((contact) => (
              <Pressable
                key={contact.address}
                accessibilityRole="button"
                onPress={() => onPick(contact)}
                style={({ pressed }) => [
                  styles.contactBox,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <Text style={[styles.contactName, { color: theme.text }]}>{contact.name}</Text>
                <Text style={[styles.address, { color: theme.textMuted }]}>{contact.address}</Text>
              </Pressable>
            ))
          )}
        </ScrollView>
        <Text style={[styles.hint, { color: theme.textMuted }]}>
          The picked address is checked exactly like a typed one. Compare the
          full address on the next screens before you send.
        </Text>
        {onManage ? <Button title="Manage contacts" variant="secondary" onPress={onManage} /> : null}
        <Button title="Close" variant="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}

/**
 * Unobtrusive "Save as contact" link that expands into an inline name
 * field (Alert.prompt is iOS-only, so the entry is inline). The address is
 * validated again by addContact; a look-alike of an existing contact asks
 * for explicit confirmation before it is saved.
 */
export function SaveContactInline({
  networkId,
  address,
  onSaved,
}: {
  networkId: string;
  address: string;
  onSaved: (contact: Contact) => void;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (acknowledgeLookalike = false) => {
    setBusy(true);
    setError(null);
    try {
      const contact = await addContact(networkId, name, address, { acknowledgeLookalike });
      setOpen(false);
      setName('');
      onSaved(contact);
    } catch (e) {
      if (e instanceof LookalikeContactError) {
        Alert.alert('Similar to an existing contact', e.message, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save anyway', style: 'destructive', onPress: () => void save(true) },
        ]);
      } else {
        setError(e instanceof Error ? e.message : 'Could not save this contact.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={styles.link}>
        <Text style={[styles.linkText, { color: theme.accent }]}>Save as contact</Text>
      </Pressable>
    );
  }
  return (
    <View style={[styles.contactBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.contactLabel, { color: theme.textMuted }]}>Save as contact</Text>
      <Text selectable style={[styles.address, { color: theme.text }]}>
        {address}
      </Text>
      <TextInput
        value={name}
        onChangeText={(t) => {
          setName(t);
          setError(null);
        }}
        placeholder="Name"
        placeholderTextColor={theme.textMuted}
        autoCorrect={false}
        maxLength={MAX_CONTACT_NAME_LENGTH * 2}
        style={[
          styles.input,
          { color: theme.text, borderColor: theme.border, backgroundColor: theme.background },
        ]}
      />
      {error ? <Text style={[styles.hint, { color: theme.danger }]}>{error}</Text> : null}
      <View style={styles.buttonRow}>
        <Button
          title="Save"
          onPress={() => void save()}
          disabled={busy || name.trim() === ''}
          style={styles.flexButton}
        />
        <Button
          title="Cancel"
          variant="secondary"
          onPress={() => {
            setOpen(false);
            setName('');
            setError(null);
          }}
          style={styles.flexButton}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  contactBox: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 6,
  },
  contactLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
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
  modal: {
    flex: 1,
    padding: 24,
    paddingTop: 64,
    gap: 16,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  list: {
    gap: 10,
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
  link: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  linkText: {
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  flexButton: {
    flex: 1,
  },
});

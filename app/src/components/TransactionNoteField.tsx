import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';
import { useTheme } from '../theme';
import { linkUserOperation, NOTE_PRIVACY_LINE, sanitizeNote, saveNote } from '../wallet/notes';

/**
 * "Note (private, this phone only)" on the success screens (feature 87,
 * wallet/notes.ts): Send (both success views), Swap (both success views),
 * Sessions (the progress view after an install, a revoke, a test operation
 * or a recurring payment) and the WalletConnect sent view.
 *
 * Saved when the field loses focus, on the keyboard's Done and when the
 * screen goes away; an unchanged text is not saved again. A smart-account
 * note is saved against the UserOperation hash until the bundle
 * transaction's hash arrives, then moved to it (linkUserOperation), so
 * Activity — which lists the bundle transaction — shows it.
 *
 * Moved unchanged from SendScreen.tsx (where it was SuccessNoteField) so
 * the other success views share one implementation; only the style sheet is
 * now this file's own, with the same values as SendScreen's label, input and
 * hint styles.
 */
export function TransactionNoteField({
  network,
  txid,
  userOpHash,
}: {
  /** CAIP-2 id of the network the transaction is on. */
  network: string;
  txid: string | null;
  userOpHash: string | null;
}) {
  const theme = useTheme();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<{ kind: 'idle' | 'saved' } | { kind: 'error'; message: string }>({
    kind: 'idle',
  });
  const [savedCount, setSavedCount] = useState(0);
  // What is stored now (cleaned), and the latest inputs for the save on unmount.
  const stored = useRef('');
  const latest = useRef({ text, network, txid, userOpHash });
  useEffect(() => {
    latest.current = { text, network, txid, userOpHash };
  });

  const save = useCallback((onDone?: (outcome: { ok: true } | { ok: false; message: string }) => void) => {
    const { text: value, network: net, txid: tx, userOpHash: op } = latest.current;
    const clean = sanitizeNote(value);
    if (!clean.ok) {
      onDone?.({ ok: false, message: clean.error });
      return;
    }
    if (clean.note === stored.current) return;
    const previous = stored.current;
    stored.current = clean.note;
    saveNote(net, { txid: tx, userOpHash: op }, value).then(
      () => onDone?.({ ok: true }),
      (e: unknown) => {
        stored.current = previous;
        onDone?.({ ok: false, message: e instanceof Error ? e.message : String(e) });
      },
    );
  }, []);
  const saveWithStatus = () =>
    save((outcome) => {
      if (outcome.ok) {
        setStatus({ kind: 'saved' });
        setSavedCount((n) => n + 1);
      } else {
        setStatus({ kind: 'error', message: outcome.message });
      }
    });
  // The screen is left (Done, back): save what was typed.
  useEffect(() => () => save(), [save]);
  // The bundle transaction's hash arrived after a note was saved under the
  // UserOperation hash: move the note to the transaction id.
  useEffect(() => {
    if (!txid || !userOpHash || savedCount === 0) return;
    linkUserOperation(network, userOpHash, txid).catch(() => undefined);
  }, [network, txid, userOpHash, savedCount]);

  return (
    <>
      <Text style={[styles.label, { color: theme.textMuted }]}>Note (private, this phone only)</Text>
      <TextInput
        value={text}
        onChangeText={(value) => {
          setText(value);
          if (status.kind !== 'idle') setStatus({ kind: 'idle' });
        }}
        onBlur={saveWithStatus}
        onSubmitEditing={saveWithStatus}
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        placeholder="For example: rent for October"
        placeholderTextColor={theme.textMuted}
        accessibilityLabel="Note (private, this phone only)"
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.card }]}
      />
      {status.kind === 'saved' ? (
        <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.success }]}>
          Note saved.
        </Text>
      ) : null}
      {status.kind === 'error' ? (
        <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: theme.danger }]}>
          {status.message}
        </Text>
      ) : null}
      <Text style={[styles.hint, { color: theme.textMuted }]}>{NOTE_PRIVACY_LINE}</Text>
    </>
  );
}

// The same values as SendScreen's label, input and hint styles, where this
// field used to live.
const styles = StyleSheet.create({
  label: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
  },
});

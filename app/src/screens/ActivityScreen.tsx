import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewToken,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { HistoryEntry } from '@shiba-wallet/core';
import type { RootStackParamList } from '../navigation';
import { Button, screenStyle } from '../components';
import { Theme, useTheme } from '../theme';
import { networkDefaultFor } from '../config/defaults';
import { maskAmount } from '../config/prefs';
import {
  formatBalanceDisplay,
  formatUnits,
  signedDisplay,
  spokenAmount as spokenDisplayAmount,
} from '../wallet/balances';
import { directionLabel, explorerTxUrl, timestampLabel } from '../wallet/history';
import { EVM_CHAIN_ID } from '../wallet/send';
import { useHistory } from '../wallet/useHistory';
import { usePrefs } from '../wallet/PrefsContext';
import { useWallet } from '../wallet/WalletContext';
import { OfflineNotice, TechnicalDetail } from '../wallet/connectivity';
import { sanitizeEndpointMessage } from '../config/endpoint-probe';
import {
  createActivityDecoder,
  renderActivitySentence,
  walletAddressesFor,
  type ActivityDecoder,
  type DecodedActivity,
} from '../wallet/activity-sentences';
import { listContacts, type Contact } from '../wallet/contacts';
import { listTokens } from '../wallet/tokens';
import { getAaConfig } from '../wallet/aa';
import {
  ACTIVITY_CSV_MIME_TYPE,
  ACTIVITY_CSV_UTI,
  ACTIVITY_EXPORT_DIRECTORY,
  MAX_NOTE_LENGTH,
  NOTE_PRIVACY_LINE,
  activityCsv,
  activityExportFileName,
  activityExportNote,
  findNote,
  indexNotes,
  loadNotes,
  normalizeTxId,
  resetNotes,
  sanitizeNote,
  saveNote,
  type NoteBook,
  type TransactionNote,
} from '../wallet/notes';
import { shareTextFile } from '../components/RecordFileActions';

type Props = NativeStackScreenProps<RootStackParamList, 'Activity'>;

/**
 * Small round badge carrying the direction glyph: down-arrow for received
 * (success color), up-arrow for sent, loop for self-transfers (muted).
 */
function DirectionBadge({ entry, theme }: { entry: HistoryEntry; theme: Theme }) {
  const glyph = entry.direction === 'in' ? '↓' : entry.direction === 'out' ? '↑' : '↺';
  const color =
    entry.direction === 'in' ? theme.success : entry.direction === 'out' ? theme.text : theme.textMuted;
  return (
    <View style={[styles.dirBadge, { borderColor: theme.border }]}>
      <Text style={[styles.dirGlyph, { color }]}>{glyph}</Text>
    </View>
  );
}

function StatusChip({ label, color, theme }: { label: string; color: string; theme: Theme }) {
  return (
    <View style={[styles.chip, { borderColor: color, backgroundColor: theme.card }]}>
      <Text style={[styles.chipText, { color }]}>{label}</Text>
    </View>
  );
}

/**
 * One transaction row: direction badge, label + time + optional fee on the
 * left, signed amount (em-dash when the provider supplied none) and status
 * chips on the right. Tapping opens the chain's verified block explorer;
 * rows stay inert when no explorer is verified (Dogecoin).
 */
function EntryRow({
  entry,
  chainId,
  decimals,
  symbol,
  hidden,
  evmExplorerTxBase,
  sentence,
  note,
  onEditNote,
}: {
  entry: HistoryEntry;
  chainId: string;
  decimals: number;
  symbol: string;
  /** Balance privacy (phase 4 item 5.2): mask amounts and fees as ••••. */
  hidden: boolean;
  /** Active EVM chain's explorer (sepolia.etherscan.io in test mode). */
  evmExplorerTxBase: string;
  /**
   * Plain-English description decoded from the transaction and its receipt
   * (wallet/activity-sentences.ts), already masked for Hide amounts; null
   * while unknown or when decoding failed — the row then looks as before.
   */
  sentence: string | null;
  /**
   * The user's private note for this transaction (wallet/notes.ts). Notes
   * are the user's own words, so Hide amounts never masks them.
   */
  note: TransactionNote | null;
  /** Opens the note editor; null when notes cannot be written (unsupported id or a damaged store). */
  onEditNote: (() => void) | null;
}) {
  const theme = useTheme();
  const url = explorerTxUrl(chainId, entry.id, evmExplorerTxBase);

  // Token entries carry the asset symbol; when the provider also knows
  // the exact token amount and decimals (log data, indexer raw values),
  // render it in the TOKEN's units — the chain's native decimals never
  // touch non-native amounts. Otherwise fall back to the native amount
  // or an em-dash.
  const rowSymbol = entry.assetSymbol ?? symbol;
  const sign = entry.direction === 'in' ? '+' : entry.direction === 'out' ? '−' : '';
  // formatBalanceDisplay, not formatUnits: a non-zero dust amount reads
  // "< 0.000001" instead of a misleading "0" (phase 12 follow-up). The sign
  // goes in front of the "<" ("+<0.000001").
  const display =
    entry.assetAmount !== undefined && entry.assetDecimals !== undefined
      ? formatBalanceDisplay(entry.assetAmount, entry.assetDecimals)
      : entry.amount === undefined
        ? null
        : formatBalanceDisplay(entry.amount, decimals);
  const amountText =
    display === null ? '—' : maskAmount(signedDisplay(sign, display), hidden);
  const hasAmount = entry.assetAmount !== undefined || entry.amount !== undefined;
  const amountColor =
    entry.failed || !hasAmount
      ? theme.textMuted
      : entry.direction === 'in'
        ? theme.success
        : theme.text;

  // Screen readers get the whole row as one sentence (the label replaces
  // the children's text), so it must carry the amount, time and status.
  const spokenAmount =
    !hasAmount || display === null
      ? 'no amount'
      : hidden
        ? 'amount hidden'
        : // The row's direction is already spoken; a dust amount reads
          // "less than 0.000001" without a sign in front of "less".
          `${display.startsWith('< ') ? '' : sign}${spokenDisplayAmount(display)} ${rowSymbol}`;
  const spokenStatus = [entry.failed ? 'failed' : null, !entry.confirmed ? 'pending' : null]
    .filter(Boolean)
    .join(', ');
  return (
    <View style={[styles.rowCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
    <Pressable
      accessibilityRole={url ? 'button' : undefined}
      accessibilityLabel={
        (sentence ? `${sentence}. ` : '') +
        `${directionLabel(entry.direction)} transaction, ${spokenAmount}, ${timestampLabel(entry)}` +
        (spokenStatus ? `, ${spokenStatus}` : '')
      }
      accessibilityHint={url ? 'Opens the transaction in the block explorer' : undefined}
      disabled={!url}
      onPress={() => {
        if (url) void Linking.openURL(url);
      }}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.8 : 1 }]}
    >
      <DirectionBadge entry={entry} theme={theme} />
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: theme.text }]}>
          {directionLabel(entry.direction)}
        </Text>
        {sentence ? (
          <Text style={[styles.rowSentence, { color: theme.text }]}>{sentence}</Text>
        ) : null}
        <Text style={[styles.rowTime, { color: theme.textMuted }]}>
          {timestampLabel(entry)}
        </Text>
        {entry.fee !== undefined ? (
          <Text style={[styles.rowFee, { color: theme.textMuted }]}>
            fee {maskAmount(formatUnits(entry.fee, decimals, decimals), hidden)} {symbol}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.amount, { color: amountColor }]} numberOfLines={1}>
          {amountText}
        </Text>
        <Text style={[styles.amountSymbol, { color: theme.textMuted }]}>{rowSymbol}</Text>
        <View style={styles.chips}>
          {entry.failed ? <StatusChip label="failed" color={theme.danger} theme={theme} /> : null}
          {!entry.confirmed ? (
            <StatusChip label="pending" color={theme.warningText} theme={theme} />
          ) : null}
        </View>
      </View>
    </Pressable>
    {note || onEditNote ? (
      // Outside the row's Pressable, so the note and its action are their
      // own elements for screen readers and taps on them never open the
      // explorer.
      <View style={[styles.noteBar, { borderTopColor: theme.border }]}>
        {note ? (
          <Text selectable style={[styles.noteText, { color: theme.text }]}>
            <Text style={{ color: theme.textMuted }}>Note: </Text>
            {note.text}
          </Text>
        ) : null}
        {onEditNote ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={note ? 'Edit note' : 'Add note'}
            accessibilityHint="Opens a private note for this transaction, kept only on this phone"
            onPress={onEditNote}
            hitSlop={8}
            style={styles.noteAction}
          >
            <Text style={[styles.noteActionText, { color: theme.accent }]}>
              {note ? 'Edit note' : 'Add note'}
            </Text>
          </Pressable>
        ) : null}
      </View>
    ) : null}
    </View>
  );
}

/**
 * The note editor: one text field (line breaks become spaces when saved),
 * a live count of the cleaned length, Save, Remove note (when one exists)
 * and Cancel. Saving an empty note removes it. Mounted with a key per
 * transaction by the screen.
 */
function NoteEditor({
  target,
  onClose,
  onSaved,
}: {
  target: { network: string; txid: string; userOpHash: string | null; current: TransactionNote | null } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const theme = useTheme();
  // The parent mounts a fresh editor per transaction (key), so the field
  // starts from that transaction's note.
  const [text, setText] = useState(target?.current?.text ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleaned = sanitizeNote(text);
  const length = cleaned.ok ? Array.from(cleaned.note).length : Array.from(text).length;
  const save = (value: string) => {
    if (!target) return;
    setBusy(true);
    setError(null);
    saveNote(target.network, { txid: target.txid, userOpHash: target.userOpHash }, value).then(
      () => {
        setBusy(false);
        onSaved();
        onClose();
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const titleStyle = [styles.modalTitle, { color: theme.text }];
  const labelStyle = [styles.modalLabel, { color: theme.textMuted }];
  return (
    <Modal visible={target !== null} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.modalBackdrop}
      >
        <View style={[styles.modalSheet, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <Text accessibilityRole="header" style={titleStyle}>
            {target?.current ? 'Edit note' : 'Add note'}
          </Text>
          <Text style={labelStyle}>Note (private, this phone only)</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            editable={!busy}
            multiline
            autoFocus
            placeholder="For example: rent for October"
            placeholderTextColor={theme.textMuted}
            accessibilityLabel="Note (private, this phone only)"
            style={[
              styles.noteInput,
              { color: theme.text, borderColor: theme.border, backgroundColor: theme.card },
            ]}
          />
          <Text style={[styles.modalHint, { color: cleaned.ok ? theme.textMuted : theme.danger }]}>
            {cleaned.ok ? `${length} / ${MAX_NOTE_LENGTH}` : cleaned.error}
          </Text>
          <Text style={[styles.modalHint, { color: theme.textMuted }]}>{NOTE_PRIVACY_LINE}</Text>
          {error ? (
            <Text accessibilityLiveRegion="polite" style={[styles.modalHint, { color: theme.danger }]}>
              {error}
            </Text>
          ) : null}
          <Button
            title={busy ? 'Saving…' : 'Save note'}
            disabled={busy || !cleaned.ok || (cleaned.note === '' && !target?.current)}
            onPress={() => save(text)}
          />
          {target?.current ? (
            <Button title="Remove note" variant="secondary" disabled={busy} onPress={() => save('')} />
          ) : null}
          <Button title="Cancel" variant="secondary" disabled={busy} onPress={onClose} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * Decoded sentences for the EVM rows the user can see. A decoder is built
 * once the wallet's addresses (EOA plus a Kernel or recovered smart account
 * when configured), tracked tokens and contacts are loaded; it then decodes
 * the visible rows' transactions in bounded batches (at most
 * MAX_DECODES_PER_CALL new decodes per batch) through the active endpoint.
 * Failures leave rows unchanged; a pull-to-refresh lets failed rows be
 * tried again. Rendering happens on every render, so Hide amounts and
 * contact names apply without new requests.
 */
function useActivitySentences(options: {
  enabled: boolean;
  chainCaip2: string;
  chainIdDecimal: string;
  eoa: string | null;
  accountIndex: number | null;
  refreshing: boolean;
}): {
  /** The decoded transaction for a row id, or undefined. */
  lookup: (id: string) => DecodedActivity | undefined;
  contacts: Contact[];
  /** Changes whenever new decodes arrived (for memoization). */
  version: number;
  onViewableItemsChanged: (info: { viewableItems: ViewToken[] }) => void;
} {
  const { enabled, chainCaip2, chainIdDecimal, eoa, accountIndex, refreshing } = options;
  const setupKey =
    enabled && eoa && accountIndex !== null ? `${chainCaip2}|${chainIdDecimal}|${eoa}|${accountIndex}` : null;
  const [setup, setSetup] = useState<{ key: string; decoder: ActivityDecoder; contacts: Contact[] } | null>(null);
  const [version, setVersion] = useState(0);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  // A decoder built for another chain/account is never used.
  const current = setup && setup.key === setupKey ? setup : null;
  const decoder = current?.decoder ?? null;

  useEffect(() => {
    if (!setupKey || !eoa || accountIndex === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [tokens, savedContacts, aa] = await Promise.all([
          listTokens(chainCaip2),
          listContacts(chainCaip2),
          getAaConfig(chainCaip2).catch(() => null),
        ]);
        if (cancelled) return;
        setSetup({
          key: setupKey,
          contacts: savedContacts,
          decoder: createActivityDecoder({
            chainCaip2,
            evmChainId: BigInt(chainIdDecimal),
            wallet: walletAddressesFor(eoa, accountIndex, aa),
            trackedTokens: tokens,
          }),
        });
      } catch {
        // No decoder: rows stay as they are.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setupKey, chainCaip2, chainIdDecimal, eoa, accountIndex]);

  // A pull-to-refresh retries rows whose decode failed earlier.
  useEffect(() => {
    if (refreshing) decoder?.reset();
  }, [refreshing, decoder]);

  // Keyed by the joined ids: viewability callbacks hand out a fresh array
  // each time, but only a different set of rows needs a new batch.
  const visibleKey = visibleIds.join(',');
  useEffect(() => {
    const ids = visibleKey ? visibleKey.split(',') : [];
    if (!decoder || ids.length === 0) return;
    let cancelled = false;
    void decoder.decodeEntries(ids).then((decoded) => {
      if (!cancelled && decoded.size > 0) setVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [decoder, visibleKey, refreshing]);

  // FlatList requires a stable callback for onViewableItemsChanged (the
  // state setter is stable, so no dependencies).
  const onViewableItemsChanged = useCallback((info: { viewableItems: ViewToken[] }) => {
    const ids = info.viewableItems
      .map((v) => (v.item as HistoryEntry | undefined)?.id)
      .filter((id): id is string => typeof id === 'string');
    setVisibleIds((prev) => {
      const next = [...new Set(ids)];
      return next.join(',') === prev.join(',') ? prev : next;
    });
  }, []);

  const lookup = useCallback(
    (id: string) => (decoder ? decoder.cachedFor([id]).get(id) : undefined),
    [decoder],
  );
  return { lookup, contacts: current?.contacts ?? EMPTY_CONTACTS, version, onViewableItemsChanged };
}

const EMPTY_CONTACTS: Contact[] = [];

/**
 * The muted technical line for a history failure. useHistory keeps only the
 * error's message string, so this applies the same cleaning that
 * describeNetworkFailure uses for its `technical` text
 * (sanitizeEndpointMessage: JSON-RPC code kept, Java class names, links and
 * advertisements removed, first sentence only); null when nothing readable
 * is left.
 */
function historyTechnicalText(message: string | null | undefined): string | null {
  if (!message) return null;
  const text = sanitizeEndpointMessage(message);
  return text === '' ? null : text;
}

/** Newest-first transaction list for one chain, entered from a Home row. */
export function ActivityScreen({ navigation, route }: Props) {
  const theme = useTheme();
  const { chainId } = route.params;
  const { accounts, activeAccount } = useWallet();
  const { hideAmounts, evmChain } = usePrefs();
  const account = accounts.find((a) => a.chainId === chainId);
  const network = networkDefaultFor(chainId);
  const { state, refreshing, reload, loadMore } = useHistory(chainId, account?.address ?? '');
  // The EVM slot's symbol/explorer follow the active chain profile
  // (test ETH + sepolia.etherscan.io in Sepolia test mode). useHistory
  // already resolves the endpoint and indexer config through the same
  // active-chain translation in config/networks.ts.
  const isEvmSlot = chainId === EVM_CHAIN_ID;
  const symbol = isEvmSlot ? evmChain.displaySymbol : network?.symbol ?? '';
  const sentences = useActivitySentences({
    enabled: isEvmSlot,
    chainCaip2: evmChain.caip2,
    chainIdDecimal: evmChain.chainIdDecimal,
    eoa: isEvmSlot ? account?.address ?? null : null,
    accountIndex: activeAccount?.index ?? null,
    refreshing,
  });
  // Rendered on every render (cheap: cached decodes only), so Hide amounts
  // and contact names apply at once.
  const sentenceOptions = {
    nativeSymbol: evmChain.displaySymbol,
    hidden: hideAmounts,
    contacts: sentences.contacts,
    networkId: evmChain.caip2,
  };
  const sentenceFor = (id: string): string | null => {
    const decoded = sentences.lookup(id);
    if (!decoded) return null;
    try {
      return renderActivitySentence(decoded, sentenceOptions);
    } catch {
      return null;
    }
  };

  useEffect(() => {
    navigation.setOptions({ title: account ? `${account.name} activity` : 'Activity' });
  }, [navigation, account]);

  // Transaction notes (feature 87, wallet/notes.ts) are keyed by the network
  // the transaction is on: the active EVM profile for the EVM slot (as the
  // contacts and the decoder), the chain itself otherwise. Re-read on focus
  // so a note saved on the Send success screen shows on return.
  const noteNetwork = isEvmSlot ? evmChain.caip2 : chainId;
  const [noteBook, setNoteBook] = useState<NoteBook | null>(null);
  const [notesVersion, setNotesVersion] = useState(0);
  const reloadNotes = useCallback(() => {
    loadNotes().then(
      (book) => {
        setNoteBook(book);
        setNotesVersion((v) => v + 1);
      },
      () => setNoteBook({ notes: [], readOnly: true }),
    );
  }, []);
  useFocusEffect(reloadNotes);
  const noteIndex = useMemo(() => indexNotes(noteBook?.notes ?? []), [noteBook]);
  const [noteTarget, setNoteTarget] = useState<{
    network: string;
    txid: string;
    userOpHash: string | null;
    current: TransactionNote | null;
  } | null>(null);
  // UserOperation hashes a decoded row carries: a note saved on the success
  // screen under its UserOperation hash (before the bundle transaction was
  // known) is found through them.
  const userOpHashesFor = (id: string): string[] =>
    sentences.lookup(id)?.description.userOps.map((op) => op.userOpHash) ?? [];
  const noteFor = (id: string): TransactionNote | null =>
    findNote(noteIndex, noteNetwork, id, isEvmSlot ? userOpHashesFor(id) : []);
  const [exporting, setExporting] = useState(false);

  // The "network · account" line the other network screens open with
  // (Send, NFTs, Approvals): which network this history comes from and
  // whose address it is. The EVM slot follows the active chain profile.
  const networkLabel = isEvmSlot ? evmChain.label : network?.label ?? chainId;
  const testnet = isEvmSlot && evmChain.testnet;
  const networkHeader = account ? (
    <View style={styles.headerBlock}>
      <Text style={[styles.networkLine, { color: testnet ? theme.testnetFill : theme.textMuted }]}>
        {networkLabel} · {testnet ? 'TESTNET' : 'Mainnet'}
        {activeAccount ? ` · ${activeAccount.name}` : ''}
      </Text>
      <Text selectable style={[styles.addressLine, { color: theme.textMuted }]}>
        {account.address}
      </Text>
    </View>
  ) : null;

  if (!account || !network) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={[styles.note, { color: theme.textMuted }]}>Unknown chain.</Text>
      </View>
    );
  }

  if (state.status === 'loading') {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <ActivityIndicator size="large" color={theme.accent} />
      </View>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        {networkHeader}
        {/* Decorative dash: the note below says what is unavailable. */}
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={[styles.unavailableMark, { color: theme.textMuted }]}
        >
          —
        </Text>
        <Text style={[styles.note, { color: theme.textMuted }]}>{state.note}</Text>
      </View>
    );
  }

  if (state.status === 'error') {
    // A calm sentence first; the endpoint's own message, cleaned, stays
    // available as the muted technical line for anyone diagnosing it.
    return (
      <View style={[screenStyle(theme), styles.center]}>
        {networkHeader}
        <OfflineNotice />
        <Text accessibilityLiveRegion="polite" style={[styles.note, { color: theme.text }]}>
          The history could not be loaded right now. Check your connection
          and try again.
        </Text>
        <TechnicalDetail text={historyTechnicalText(state.message)} />
        <Button title="Retry" onPress={() => void reload()} style={styles.retry} />
      </View>
    );
  }

  // status === 'ok'
  const loadedEntries = state.entries;
  // The CSV holds exactly the entries loaded on this screen, with the notes
  // and the decoded counterparties already in memory; it makes no request.
  const exportActivity = () => {
    setExporting(true);
    const contents = activityCsv({
      network: noteNetwork,
      networkLabel,
      entries: loadedEntries,
      nativeSymbol: symbol,
      nativeDecimals: network.decimals,
      notes: noteIndex,
      explorerUrlFor: (id) => explorerTxUrl(chainId, id, evmChain.explorerTxBase),
      counterpartyFor: (id) => (isEvmSlot ? sentences.lookup(id)?.description.counterparty ?? null : null),
      userOpHashesFor: (id) => (isEvmSlot ? userOpHashesFor(id) : []),
    });
    shareTextFile({
      directory: ACTIVITY_EXPORT_DIRECTORY,
      fileName: () => activityExportFileName(noteNetwork, account.address),
      contents: () => contents,
      mimeType: ACTIVITY_CSV_MIME_TYPE,
      UTI: ACTIVITY_CSV_UTI,
      dialogTitle: 'Save the activity export',
      unavailableMessage: 'Sharing files is not available on this device, so the activity could not be exported.',
    }).then(
      () => setExporting(false),
      (e: unknown) => {
        setExporting(false);
        Alert.alert('File not shared', e instanceof Error ? e.message : String(e));
      },
    );
  };
  const confirmResetNotes = () => {
    Alert.alert(
      'Reset notes?',
      'This deletes every transaction note on this phone, on every network, including the ones that could still be read. It cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset notes',
          style: 'destructive',
          onPress: () => {
            resetNotes().then(reloadNotes, (e: unknown) =>
              Alert.alert('Notes not reset', e instanceof Error ? e.message : String(e)),
            );
          },
        },
      ],
    );
  };
  // The tracked-token logs fallback reports how far back it searched; when
  // paging stopped short of block 0 (endpoint refusal or the wallet's own
  // lookback bound), the end of the list is the end of the SEARCHED range,
  // not the end of history.
  const coverage = state.coverage;
  const rangeLimited =
    coverage !== undefined && (coverage.stop === 'refused' || coverage.stop === 'lookback-limit');
  const nothingAnswered = coverage !== undefined && coverage.answeredFromBlock === null;
  const footer = (
    <View style={styles.footer}>
      {state.loadMoreError ? (
        <>
          <Text accessibilityLiveRegion="polite" style={[styles.note, { color: theme.text }]}>
            Older entries could not be loaded. The entries above are unchanged.
          </Text>
          <TechnicalDetail text={historyTechnicalText(state.loadMoreError)} />
        </>
      ) : null}
      {state.loadingMore ? (
        <ActivityIndicator size="small" color={theme.textMuted} />
      ) : state.nextCursor ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={state.loadMoreError ? 'Try loading older transactions again' : 'Load more transactions'}
          accessibilityHint="Loads older transactions"
          onPress={() => void loadMore()}
          hitSlop={8}
        >
          <Text style={[styles.loadMore, { color: theme.accent }]}>
            {state.loadMoreError ? 'Try again' : 'Load more'}
          </Text>
        </Pressable>
      ) : state.entries.length > 0 ? (
        <Text style={[styles.note, { color: theme.textMuted }]}>
          {rangeLimited ? 'End of the searched blocks (see the note above).' : 'End of history.'}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={screenStyle(theme)}>
      <OfflineNotice style={styles.notice} />
      <FlatList
        data={state.entries}
        // uid distinguishes several entries born from one EVM transaction
        // (e.g. a token transfer plus an internal native movement).
        keyExtractor={(entry) => entry.uid ?? entry.id}
        renderItem={({ item }) => (
          <EntryRow
            entry={item}
            chainId={chainId}
            decimals={network.decimals}
            symbol={symbol}
            hidden={hideAmounts}
            evmExplorerTxBase={evmChain.explorerTxBase}
            sentence={isEvmSlot ? sentenceFor(item.id) : null}
            note={noteFor(item.id)}
            onEditNote={
              noteBook && !noteBook.readOnly && normalizeTxId(noteNetwork, item.id)
                ? () => {
                    const current = noteFor(item.id);
                    setNoteTarget({
                      network: noteNetwork,
                      txid: item.id,
                      // Editing a note found through its UserOperation hash
                      // moves it to this transaction id (notes.ts saveNote).
                      userOpHash: current?.userOpHash ?? null,
                      current,
                    });
                  }
                : null
            }
          />
        )}
        onViewableItemsChanged={isEvmSlot ? sentences.onViewableItemsChanged : undefined}
        // New decodes, Hide amounts and contact edits re-render the visible rows.
        extraData={`${sentences.version}|${hideAmounts}|${sentences.contacts.length}|${notesVersion}`}
        contentContainerStyle={styles.list}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void reload()}
            tintColor={theme.textMuted}
            colors={[theme.accent]}
          />
        }
        ListHeaderComponent={
          <View style={styles.listHeader}>
            {networkHeader}
            {state.note ? (
              <Text style={[styles.note, { color: theme.textMuted }]}>{state.note}</Text>
            ) : null}
            {/* Already cleaned by history.ts (sanitizeEndpointMessage). */}
            <TechnicalDetail text={state.noteDetail} />
            {noteBook?.readOnly ? (
              <View style={[styles.notesDamaged, { borderColor: theme.warningBorder, backgroundColor: theme.warningSurface }]}>
                <Text style={[styles.notesDamagedText, { color: theme.warningText }]}>
                  Some of your transaction notes could not be read. The notes that could be read are shown;
                  adding or changing notes is off until the notes are reset.
                </Text>
                <Button title="Reset notes" variant="secondary" onPress={confirmResetNotes} />
              </View>
            ) : null}
            {state.entries.length > 0 ? (
              <View style={styles.exportBlock}>
                <Button
                  title={exporting ? 'Preparing the file…' : 'Export activity (.csv)'}
                  variant="secondary"
                  disabled={exporting}
                  onPress={exportActivity}
                />
                <Text style={[styles.exportNote, { color: theme.textMuted }]}>
                  {activityExportNote(state.entries.length)}
                </Text>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <Text style={[styles.note, { color: theme.textMuted }]}>
            {nothingAnswered
              ? 'No blocks could be searched with the current endpoint.'
              : coverage
                ? 'No tracked-token transfers found in the searched blocks.'
                : 'No transactions found for this address.'}
          </Text>
        }
        ListFooterComponent={footer}
      />
      <NoteEditor
        key={noteTarget ? `${noteTarget.network}|${noteTarget.txid}` : 'closed'}
        target={noteTarget}
        onClose={() => setNoteTarget(null)}
        onSaved={reloadNotes}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  list: {
    padding: 16,
    gap: 10,
    flexGrow: 1,
  },
  rowCard: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  noteBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 4,
  },
  noteText: {
    fontSize: 13,
    lineHeight: 18,
  },
  noteAction: {
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  noteActionText: {
    fontSize: 13,
    fontWeight: '600',
  },
  notesDamaged: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  notesDamagedText: {
    fontSize: 13,
    lineHeight: 19,
  },
  exportBlock: {
    gap: 6,
    marginTop: 4,
  },
  exportNote: {
    fontSize: 12,
    lineHeight: 17,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  modalSheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    padding: 20,
    gap: 10,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  modalHint: {
    fontSize: 12,
    lineHeight: 17,
  },
  noteInput: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  dirBadge: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dirGlyph: {
    fontSize: 18,
    fontWeight: '700',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowSentence: {
    fontSize: 13,
    lineHeight: 18,
  },
  rowTime: {
    fontSize: 12,
  },
  rowFee: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: 2,
    maxWidth: 150,
  },
  amount: {
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  amountSymbol: {
    fontSize: 12,
  },
  chips: {
    flexDirection: 'row',
    gap: 4,
  },
  chip: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  chipText: {
    fontSize: 10,
    fontWeight: '600',
  },
  note: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
  notice: {
    marginHorizontal: 16,
    marginTop: 8,
  },
  listHeader: {
    gap: 6,
  },
  headerBlock: {
    gap: 2,
    alignSelf: 'stretch',
  },
  networkLine: {
    fontSize: 13,
  },
  addressLine: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  unavailableMark: {
    fontSize: 32,
  },
  retry: {
    minWidth: 140,
  },
  footer: {
    alignItems: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  loadMore: {
    fontSize: 14,
    fontWeight: '600',
    paddingVertical: 4,
  },
});

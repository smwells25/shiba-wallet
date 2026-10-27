import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Button, screenStyle, useFieldLabels } from '../components';
import { T } from '../i18n/T';
import { useI18n } from '../i18n/useI18n';
import { localTimestampLabel } from '../i18n/format';
import { activityRowSpokenLead, spokenShortAddress } from '../a11y';
import { Theme, useTheme } from '../theme';
import { networkDefaultFor } from '../config/defaults';
import { maskAmount } from '../config/prefs';
import {
  formatBalanceDisplay,
  formatUnits,
  signedDisplay,
  spokenAmount as spokenDisplayAmount,
} from '../wallet/balances';
import {
  amountSign,
  directionLabel,
  explorerTxUrl,
  hidesZeroNativeAmount,
  transactionsWithTokenAmounts,
} from '../wallet/history';
import { EVM_CHAIN_ID } from '../wallet/send';
import { useHistory } from '../wallet/useHistory';
import { usePrefs } from '../wallet/PrefsContext';
import { useWallet } from '../wallet/WalletContext';
import { OfflineNotice, TechnicalDetail } from '../wallet/connectivity';
import { sanitizeEndpointMessage } from '../config/endpoint-probe';
import {
  FAILED_INCOMING_TITLE,
  ROW_DETAILS_LOADING_LABEL,
  ROW_DETAILS_UNAVAILABLE_LINE,
  activityAddressSets,
  activityRowText,
  createActivityDecoder,
  entryPointRowSentence,
  entryWithReceiptStatus,
  isFailedIncoming,
  historySmartAccountFor,
  renderActivitySentence,
  rowsWithoutDetailsFooter,
  unavailableDiagnosticDetail,
  type AccountLabel,
  type ActivityDecoder,
  type ActivityDecoderDiagnostics,
  type DecodedActivity,
} from '../wallet/activity-sentences';
import { involvesSmartAccount, isSmartAccountEntry, smartAccountHistoryNote } from '../wallet/smart-account-history';
import { LOAD_MORE_RETRY_FOOTER } from '../wallet/history-controller';
import { listContacts, type Contact } from '../wallet/contacts';
import { listTokens } from '../wallet/tokens';
import { getAaConfig } from '../wallet/aa';
import { ownMultisigAddresses } from '../wallet/multisig';
import { stakingContractAt } from '../wallet/risk';
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
import { PendingTransactionsSection, resendPrefill } from '../components/PendingTransactions';
import { loadPendingRegistry, replacementRowLine, type PendingRecord } from '../wallet/pending-transactions';

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
  // The chip's English label is looked up in the string table (phase 22 item 6).
  const { localize } = useI18n();
  return (
    <View style={[styles.chip, { borderColor: color, backgroundColor: theme.card }]}>
      <Text style={[styles.chipText, { color }]}>{localize(label)}</Text>
    </View>
  );
}

/** "Received transaction" / "Sent transaction" / "Self transaction" (the spoken row start), in the active language. */
function directionTransactionText(direction: HistoryEntry['direction'], t: ReturnType<typeof useI18n>['t']): string {
  return direction === 'in' ? t('activity.row.received') : direction === 'out' ? t('activity.row.sent') : t('activity.row.self');
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
  noAmount = false,
  loading = false,
  unavailable = false,
  replacementLine = null,
  sameAsAbove = false,
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
  /**
   * True for a zero-value native entry of a transaction whose token
   * movement is on another row (history.ts hidesZeroNativeAmount): the row
   * then shows no amount instead of "−0".
   */
  noAmount?: boolean;
  /**
   * True while the row's sentence may still arrive (activityRowText): a
   * screen reader then hears that the details are loading first, instead of
   * a shorter label that changes later (emulator pass of 2026-10-11,
   * finding F5).
   */
  loading?: boolean;
  /**
   * True when no endpoint returned the row's transaction or receipt, even
   * after the asks elsewhere (activityRowText): the row then shows
   * ROW_DETAILS_UNAVAILABLE_LINE as a muted line and ends its label with it
   * (phase 19 item 4).
   */
  unavailable?: boolean;
  /**
   * For a row whose transaction replaced (or was replaced by) another one
   * this phone sent with the same nonce (wallet/pending-transactions.ts
   * replacementRowLine): "Speed-up of transaction 0x…", "Cancellation of …".
   */
  replacementLine?: string | null;
  /**
   * True when the row above is another row of the same transaction (a token
   * transfer and its native leg): the spoken label then says so instead of
   * repeating the transaction's sentence (pass p20c finding 12).
   */
  sameAsAbove?: boolean;
}) {
  // Localisation (phase 22 item 6): the row's own words follow the language.
  const { t, tx, localize } = useI18n();
  const theme = useTheme();
  const url = explorerTxUrl(chainId, entry.id, evmExplorerTxBase);
  // A failed incoming row received nothing (entryWithReceiptStatus): it
  // says so in its title and shows no amount (emulator pass of 2026-10-11,
  // finding 2).
  const failedIncoming = isFailedIncoming(entry);
  const showAmount = !noAmount && !failedIncoming;
  const title = failedIncoming ? FAILED_INCOMING_TITLE : directionLabel(entry.direction);

  // Token entries carry the asset symbol; when the provider also knows
  // the exact token amount and decimals (log data, indexer raw values),
  // render it in the TOKEN's units — the chain's native decimals never
  // touch non-native amounts. Otherwise fall back to the native amount
  // or an em-dash.
  const rowSymbol = entry.assetSymbol ?? symbol;
  // No sign in front of an amount of exactly zero: never "−0" (phase 19 item 4).
  const sign = amountSign(entry);
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
  const hasAmount = showAmount && (entry.assetAmount !== undefined || entry.amount !== undefined);
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
      ? tx('no amount')
      : hidden
        ? tx('amount hidden')
        : // The row's direction is already spoken; a dust amount reads
          // "less than 0.000001" without a sign in front of "less".
          `${display.startsWith('< ') ? '' : sign}${spokenDisplayAmount(display)} ${rowSymbol}`;
  // Rows from the smart account's history (smart-account-history.ts): the
  // direction and amount are the smart account's, so the row says so.
  const smartAccountRow = isSmartAccountEntry(entry);
  // The account's own row of a transaction the smart account's history
  // also lists; that mirror row is not shown (smart-account-history.ts).
  const withSmartAccount = involvesSmartAccount(entry);
  const spokenStatus = [
    smartAccountRow ? 'smart account' : null,
    withSmartAccount ? 'with your smart account' : null,
    entry.failed ? 'failed' : null,
    !entry.confirmed ? 'pending' : null,
  ]
    .filter((word): word is string => word !== null)
    .map((word) => localize(word))
    .join(', ');
  // The row's title in the active language (the direction label and the
  // failed-incoming title stay English in history.ts / activity-sentences.ts,
  // which also feed the CSV export).
  const shownTitle = localize(title);
  return (
    <View style={[styles.rowCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
    <Pressable
      accessibilityRole={url ? 'button' : undefined}
      accessibilityLabel={
        activityRowSpokenLead({ sentence, loading, sameAsAbove, loadingLabel: ROW_DETAILS_LOADING_LABEL }) +
        (replacementLine ? `${replacementLine} ` : '') +
        (failedIncoming ? `${shownTitle}, ` : `${directionTransactionText(entry.direction, t)}, `) +
        `${spokenAmount}, ${localTimestampLabel(entry)}` +
        (spokenStatus ? `, ${spokenStatus}` : '') +
        (unavailable ? `. ${localize(ROW_DETAILS_UNAVAILABLE_LINE)}` : '')
      }
      accessibilityHint={url ? tx('Opens the transaction in the block explorer') : undefined}
      disabled={!url}
      onPress={() => {
        if (url) void Linking.openURL(url);
      }}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.8 : 1 }]}
    >
      <DirectionBadge entry={entry} theme={theme} />
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, { color: theme.text }]}>
          {shownTitle}
        </Text>
        {sentence ? (
          <Text style={[styles.rowSentence, { color: theme.text }]}>{sentence}</Text>
        ) : unavailable ? (
          <Text style={[styles.rowSentence, { color: theme.textMuted }]}><T>{ROW_DETAILS_UNAVAILABLE_LINE}</T></Text>
        ) : null}
        {replacementLine ? (
          <Text style={[styles.rowSentence, { color: theme.textMuted }]}>{replacementLine}</Text>
        ) : null}
        <Text style={[styles.rowTime, { color: theme.textMuted }]}>
          {localTimestampLabel(entry)}
        </Text>
        {entry.fee !== undefined ? (
          <Text style={[styles.rowFee, { color: theme.textMuted }]}>
            {tx('fee')} {maskAmount(formatUnits(entry.fee, decimals, decimals), hidden)} {symbol}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        {!showAmount ? null : (
          <>
            <Text style={[styles.amount, { color: amountColor }]} numberOfLines={1}>
              {amountText}
            </Text>
            <Text style={[styles.amountSymbol, { color: theme.textMuted }]}>{rowSymbol}</Text>
          </>
        )}
        <View style={styles.chips}>
          {smartAccountRow ? <StatusChip label="smart account" color={theme.accent} theme={theme} /> : null}
          {withSmartAccount ? <StatusChip label="with smart account" color={theme.textMuted} theme={theme} /> : null}
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
            <Text style={{ color: theme.textMuted }}>{`${tx('Note:')} `}</Text>
            {note.text}
          </Text>
        ) : null}
        {onEditNote ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={note ? tx('Edit note') : tx('Add note')}
            accessibilityHint={tx('Opens a private note for this transaction, kept only on this phone')}
            onPress={onEditNote}
            hitSlop={8}
            style={styles.noteAction}
          >
            <Text style={[styles.noteActionText, { color: theme.accent }]}>
              {note ? tx('Edit note') : tx('Add note')}
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
  const { tx, localize } = useI18n();
  const fieldLabel = useFieldLabels();
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
            {target?.current ? tx('Edit note') : tx('Add note')}
          </Text>
          <Text {...fieldLabel('note', 'Note (private, this phone only)').label} style={labelStyle}>{fieldLabel('note', 'Note (private, this phone only)').text}</Text>
          <TextInput
            {...fieldLabel('note', 'Note (private, this phone only)').input}
            value={text}
            onChangeText={setText}
            editable={!busy}
            multiline
            autoFocus
            placeholder={tx('For example: rent for October')}
            placeholderTextColor={theme.textMuted}
            style={[
              styles.noteInput,
              { color: theme.text, borderColor: theme.controlBorder, backgroundColor: theme.card },
            ]}
          />
          <Text style={[styles.modalHint, { color: cleaned.ok ? theme.textMuted : theme.danger }]}>
            {cleaned.ok ? `${length} / ${MAX_NOTE_LENGTH}` : cleaned.error}
          </Text>
          <Text style={[styles.modalHint, { color: theme.textMuted }]}>{localize(NOTE_PRIVACY_LINE)}</Text>
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
  /** The accounts the wallet holds a key for (their smart accounts are labelled). */
  accounts: readonly { name: string; evmAddress: string | null; index: number }[];
  refreshing: boolean;
}): {
  /** The decoded transaction for a row id, or undefined. */
  lookup: (id: string) => DecodedActivity | undefined;
  contacts: Contact[];
  /** Changes whenever new decodes arrived (for memoization). */
  version: number;
  onViewableItemsChanged: (info: { viewableItems: ViewToken[] }) => void;
  /**
   * The labels of the wallet's own accounts, their smart accounts and the
   * network's stored multisigs (activityAddressSets().labels).
   */
  labels: AccountLabel[];
  /** The addresses that read "yourself" (activityAddressSets().self). */
  self: string[];
  /** How "yourself" addresses other than the account's own are named (activityAddressSets().selfNames). */
  selfNames: { address: string; name: string }[];
  /** True while a decode may still give `id` a sentence (also while the decoder is being set up). */
  mayDecode: (id: string) => boolean;
  /** True when no endpoint returned `id`'s transaction or receipt (until a pull-to-refresh). */
  isUnavailable: (id: string) => boolean;
  /** The decoder's counts for the footer's technical line (null without a decoder). */
  diagnostics: ActivityDecoderDiagnostics | null;
} {
  const { enabled, chainCaip2, chainIdDecimal, eoa, accountIndex, accounts, refreshing } = options;
  // Every account's index, name and address: a rename or a new account
  // rebuilds the labels and the decode set.
  const accountsKey = accounts.map((a) => `${a.index}:${a.name}:${a.evmAddress ?? ''}`).join(',');
  const setupKey =
    enabled && eoa && accountIndex !== null
      ? `${chainCaip2}|${chainIdDecimal}|${eoa}|${accountIndex}|${accountsKey}`
      : null;
  const [setup, setSetup] = useState<DecoderSetup | null>(null);
  const [setupFailedKey, setSetupFailedKey] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  // Ids of rows a history listed as mined (confirmed): only these get the
  // decoder's one retry on another endpoint when the first answers null
  // (finding 3 of the emulator pass of 2026-10-11).
  const listedIds = useRef(new Set<string>());
  // A decoder built for another chain/account is never used. On a return to
  // the screen the last setup for the same key is used at once (its decodes
  // are cached in memory), so the rows decoded before have their sentence
  // on the first render (finding F5); the effect below still rebuilds it
  // with fresh contacts and tokens.
  const current =
    setup && setup.key === setupKey ? setup : setupKey ? (DECODER_SETUPS.get(setupKey) ?? null) : null;
  const decoder = current?.decoder ?? null;
  // The screen's decoder, for answers that arrive after the visible rows
  // changed (see the decode effect below).
  const decoderRef = useRef<ActivityDecoder | null>(null);
  useEffect(() => {
    decoderRef.current = decoder;
    return () => {
      decoderRef.current = null;
    };
  }, [decoder]);

  useEffect(() => {
    if (!setupKey || !eoa || accountIndex === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const [tokens, savedContacts, aa, multisigs] = await Promise.all([
          listTokens(chainCaip2),
          listContacts(chainCaip2),
          getAaConfig(chainCaip2).catch(() => null),
          // The wallet's own multisigs on this network are decoded as its
          // own addresses (phase 18 item 3) and named by their labels.
          ownMultisigAddresses(chainCaip2),
        ]);
        if (cancelled) return;
        // "Yourself" is only this account (and its own smart account); the
        // wallet's other smart accounts and its multisigs are decoded as
        // the wallet's own but named (emulator re-check of 2026-10-11,
        // findings 2 and 3).
        const sets = activityAddressSets({ eoa, accountIndex, aa, accounts, multisigs });
        const built: DecoderSetup = {
          key: setupKey,
          contacts: savedContacts,
          labels: sets.labels,
          self: sets.self,
          selfNames: sets.selfNames,
          decoder: createActivityDecoder({
            chainCaip2,
            evmChainId: BigInt(chainIdDecimal),
            wallet: sets.wallet,
            trackedTokens: tokens,
          }),
        };
        rememberDecoderSetup(built);
        setSetup(built);
      } catch {
        // No decoder: rows stay as they are (and stop saying they are loading).
        if (!cancelled) setSetupFailedKey(setupKey);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `setupKey` covers every account's index, name and address; `accounts` is a new array on every wallet-context render.
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
    const before = decoder.revision();
    void decoder.decodeEntries(ids, { listed: (id) => listedIds.current.has(id) }).then((decoded) => {
      // Re-render when anything changed, including a row that went
      // unavailable with nothing new cached (it then says why). Not tied to
      // this effect run still being current: a batch that finishes after
      // the visible rows changed would otherwise leave its rows unrendered
      // until something else re-rendered (phase 19 item 4); only answers of
      // a decoder the screen no longer uses are ignored.
      if (decoderRef.current !== decoder) return;
      if (decoded.size > 0 || decoder.revision() !== before) setVersion((v) => v + 1);
    });
  }, [decoder, visibleKey, refreshing]);

  // FlatList requires a stable callback for onViewableItemsChanged (the
  // state setter is stable, so no dependencies).
  const onViewableItemsChanged = useCallback((info: { viewableItems: ViewToken[] }) => {
    const items = info.viewableItems
      .map((v) => v.item as HistoryEntry | undefined)
      .filter((item): item is HistoryEntry => typeof item?.id === 'string');
    for (const item of items) if (item.confirmed) listedIds.current.add(item.id);
    const ids = items.map((item) => item.id);
    setVisibleIds((prev) => {
      const next = [...new Set(ids)];
      return next.join(',') === prev.join(',') ? prev : next;
    });
  }, []);

  const lookup = useCallback(
    (id: string) => (decoder ? decoder.cachedFor([id]).get(id) : undefined),
    [decoder],
  );
  const settingUp = setupKey !== null && decoder === null && setupFailedKey !== setupKey;
  const mayDecode = useCallback(
    (id: string) => (decoder ? decoder.mayDecode(id) : settingUp),
    [decoder, settingUp],
  );
  const isUnavailable = useCallback((id: string) => (decoder ? decoder.isUnavailable(id) : false), [decoder]);
  return {
    lookup,
    contacts: current?.contacts ?? EMPTY_CONTACTS,
    version,
    onViewableItemsChanged,
    labels: current?.labels ?? EMPTY_LABELS,
    self: current?.self ?? EMPTY_SELF,
    selfNames: current?.selfNames ?? EMPTY_SELF_NAMES,
    mayDecode,
    isUnavailable,
    // Read on every render (cheap counts); `version` changes with them.
    diagnostics: decoder ? decoder.diagnostics() : null,
  };
}

interface DecoderSetup {
  key: string;
  decoder: ActivityDecoder;
  contacts: Contact[];
  labels: AccountLabel[];
  self: string[];
  selfNames: { address: string; name: string }[];
}

/** The last decoder setups by key (chain, account, every account's name and address), newest last. */
const DECODER_SETUPS = new Map<string, DecoderSetup>();
const DECODER_SETUPS_KEPT = 8;

function rememberDecoderSetup(setup: DecoderSetup): void {
  DECODER_SETUPS.delete(setup.key);
  DECODER_SETUPS.set(setup.key, setup);
  while (DECODER_SETUPS.size > DECODER_SETUPS_KEPT) {
    const oldest = DECODER_SETUPS.keys().next().value;
    if (oldest === undefined) break;
    DECODER_SETUPS.delete(oldest);
  }
}

const EMPTY_CONTACTS: Contact[] = [];
const EMPTY_LABELS: AccountLabel[] = [];
const EMPTY_SELF: string[] = [];
const EMPTY_SELF_NAMES: { address: string; name: string }[] = [];

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
  // Localisation (phase 22 item 6): the screen and its title follow the language.
  const { language, t, tx, localize } = useI18n();
  const { chainId } = route.params;
  const { accounts, activeAccount, accountList } = useWallet();
  const { hideAmounts, evmChain } = usePrefs();
  const account = accounts.find((a) => a.chainId === chainId);
  const network = networkDefaultFor(chainId);
  // The active regular account's smart account is listed too, when the
  // network's smart-account settings give one without a network request
  // (activity-sentences.ts historySmartAccountFor; not for a watch-only or
  // multisig account). The history waits until the settings are read, so
  // it is fetched once with its final address set.
  const isEvmSlot = chainId === EVM_CHAIN_ID;
  const smartOwner = account?.address ?? null;
  const smartOwnerIndex = activeAccount?.index ?? null;
  // Only a regular account on the EVM slot has a smart account to list.
  const smartCandidate =
    isEvmSlot &&
    smartOwner !== null &&
    smartOwnerIndex !== null &&
    activeAccount?.watchOnly !== true &&
    activeAccount?.multisig !== true;
  const smartKey = `${evmChain.caip2}|${smartOwner ?? ''}|${smartOwnerIndex ?? ''}`;
  const [historySmart, setHistorySmart] = useState<{ key: string; address: string | null } | null>(null);
  useEffect(() => {
    if (!smartCandidate || smartOwner === null || smartOwnerIndex === null) return;
    let cancelled = false;
    getAaConfig(evmChain.caip2)
      .catch(() => null)
      .then((aa) => {
        if (cancelled) return;
        let address: string | null = null;
        try {
          address = historySmartAccountFor(smartOwner, smartOwnerIndex, aa);
        } catch {
          address = null;
        }
        setHistorySmart({ key: smartKey, address });
      });
    return () => {
      cancelled = true;
    };
  }, [smartCandidate, smartKey, smartOwner, smartOwnerIndex, evmChain.caip2]);
  const smartReady = !smartCandidate || (historySmart !== null && historySmart.key === smartKey);
  const historySmartAccount = smartCandidate && smartReady && historySmart ? historySmart.address : null;
  const { state, refreshing, reload, loadMore } = useHistory(chainId, account?.address ?? '', {
    smartAccount: historySmartAccount,
    ready: smartReady,
  });
  // The EVM slot's symbol/explorer follow the active chain profile
  // (test ETH + sepolia.etherscan.io in Sepolia test mode). useHistory
  // already resolves the endpoint and indexer config through the same
  // active-chain translation in config/networks.ts.
  const symbol = isEvmSlot ? evmChain.displaySymbol : network?.symbol ?? '';
  const sentences = useActivitySentences({
    enabled: isEvmSlot,
    chainCaip2: evmChain.caip2,
    chainIdDecimal: evmChain.chainIdDecimal,
    eoa: isEvmSlot ? account?.address ?? null : null,
    accountIndex: activeAccount?.index ?? null,
    accounts: accountList,
    refreshing,
  });
  // Rendered on every render (cheap: cached decodes only), so Hide amounts
  // and contact names apply at once.
  // The wallet's own accounts are named by their labels ("Account 1",
  // "Multisig 2 (2-of-3)") where a sentence mentions one that is not the
  // decoded account itself, and calls to the staking contracts the wallet
  // pins on this network are described by what they do (phase 18 item 3
  // emulator findings 4 and 7e).
  // "Yourself" only for this account's own addresses (sentences.self); the
  // labels name every other account, smart account and multisig.
  const accountLabels = sentences.labels;
  const pinnedStakingAt = useCallback(
    (address: string) => stakingContractAt(evmChain.caip2, address),
    [evmChain.caip2],
  );
  const sentenceOptions = {
    nativeSymbol: evmChain.displaySymbol,
    hidden: hideAmounts,
    contacts: sentences.contacts,
    networkId: evmChain.caip2,
    accountLabels,
    stakingContractAt: pinnedStakingAt,
    selfAddresses: sentences.self,
    selfNames: sentences.selfNames,
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
  // What a row says (finding F5): an EntryPoint deposit or payout row of a
  // smart account says so from the row itself (finding F4), so a top-up in
  // a staking bundle never reads as an amount staked; else the decoded
  // transaction's sentence; a row still waiting for it says it is loading.
  const activeIsMultisig = activeAccount?.multisig === true;
  const rowTextFor = (entry: HistoryEntry): { sentence: string | null; loading: boolean; unavailable: boolean } => {
    if (!isEvmSlot) return { sentence: null, loading: false, unavailable: false };
    return activityRowText({
      entryPoint: entryPointRowSentence(entry, {
        smartAccountRow: isSmartAccountEntry(entry) || activeIsMultisig,
        nativeSymbol: evmChain.displaySymbol,
        hidden: hideAmounts,
      }),
      sentence: sentenceFor(entry.id),
      mayDecode: sentences.mayDecode(entry.id),
      unavailable: sentences.isUnavailable(entry.id),
    });
  };

  useEffect(() => {
    // The EVM slot is named after the active network ("Ethereum Sepolia
    // activity"), as on Home; the other slots by their chain.
    navigation.setOptions({
      title: account ? t('activity.title.network', { network: isEvmSlot ? evmChain.label : account.name }) : tx('Activity'),
    });
  }, [navigation, account, isEvmSlot, evmChain.label, language, t, tx]);

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
  // Transactions this phone replaced (feature 95): the rows of included
  // replacements say what they were. Re-read on focus and when the pending
  // section settles a nonce.
  const [pendingRecords, setPendingRecords] = useState<PendingRecord[]>([]);
  const reloadPendingRecords = useCallback(() => {
    loadPendingRegistry().then(
      (r) => setPendingRecords(r.records),
      () => setPendingRecords([]),
    );
  }, []);
  useFocusEffect(reloadPendingRecords);
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
        {networkLabel} · {testnet ? tx('TESTNET') : tx('Mainnet')}
        {activeAccount ? ` · ${activeAccount.name}` : ''}
      </Text>
      {/* The full address stays on screen (and selectable); a screen reader
          hears the short form, "0x772e…F44F", as on the multisig rows (pass
          p21a: TalkBack read all 42 characters). */}
      <Text
        selectable
        accessibilityLabel={spokenShortAddress(account.address)}
        style={[styles.addressLine, { color: theme.textMuted }]}
      >
        {account.address}
      </Text>
    </View>
  ) : null;

  // Pending transactions on this phone (feature 95): a regular or a
  // watch-only account on the EVM slot (a multisig sends nothing from this
  // phone through sendEvm). A watch-only account's sends are prepared on the
  // cold-signing screen (phase 22 item 3) and recorded like every send; its
  // card's Speed up / Cancel open that screen in replacement mode
  // (PendingTransactions coldReplace), so a stuck cold-signed transaction can
  // be replaced after its success view was closed (pass p22b: this section
  // was hidden for watch-only accounts, so it could not). Shown above every
  // state of the history, because a pending transaction is in no history yet.
  const pendingSection =
    isEvmSlot && account && activeAccount?.multisig !== true ? (
      <PendingTransactionsSection
        from={account.address}
        onChanged={reloadPendingRecords}
        onSendAgain={(record) => {
          const prefill = resendPrefill(record);
          if (!prefill) return;
          navigation.navigate('Send', {
            chainId: EVM_CHAIN_ID,
            ...(prefill.tokenId ? { tokenId: prefill.tokenId } : {}),
            request: { recipient: prefill.recipient, amountText: prefill.amountText, lines: prefill.lines },
          });
        }}
      />
    ) : null;

  if (!account || !network) {
    return (
      <View style={[screenStyle(theme), styles.center]}>
        <Text style={[styles.note, { color: theme.textMuted }]}><T>Unknown chain.</T></Text>
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
        {pendingSection}
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
        {pendingSection}
        <OfflineNotice />
        <Text accessibilityLiveRegion="polite" style={[styles.note, { color: theme.text }]}>
          <T>
          The history could not be loaded right now. Check your connection
          and try again.
          </T>
        </Text>
        <TechnicalDetail text={historyTechnicalText(state.message)} />
        <Button title="Retry" onPress={() => void reload()} style={styles.retry} />
      </View>
    );
  }

  // status === 'ok'
  const loadedEntries = state.entries;
  const tokenTxIds = transactionsWithTokenAmounts(loadedEntries);
  const smartHistoryNote = smartAccountHistoryNote(state.smartAccount, historySmartAccount);
  // The CSV holds exactly the entries loaded on this screen, with the notes
  // and the decoded counterparties already in memory; it makes no request.
  const exportActivity = () => {
    setExporting(true);
    const contents = activityCsv({
      network: noteNetwork,
      networkLabel,
      // Each row with its decoded receipt's status, as on screen ("Received
      // (failed)" with no amount for a reverted incoming transfer).
      entries: isEvmSlot ? loadedEntries.map((e) => entryWithReceiptStatus(e, sentences.lookup(e.id))) : loadedEntries,
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
      dialogTitle: tx('Save the activity export'),
      unavailableMessage: tx('Sharing files is not available on this device, so the activity could not be exported.'),
    }).then(
      () => setExporting(false),
      (e: unknown) => {
        setExporting(false);
        Alert.alert(tx('File not shared'), e instanceof Error ? e.message : String(e));
      },
    );
  };
  const confirmResetNotes = () => {
    Alert.alert(
      tx('Reset notes?'),
      tx('This deletes every transaction note on this phone, on every network, including the ones that could still be read. It cannot be undone.'),
      [
        { text: tx('Cancel'), style: 'cancel' },
        {
          text: tx('Reset notes'),
          style: 'destructive',
          onPress: () => {
            resetNotes().then(reloadNotes, (e: unknown) =>
              Alert.alert(tx('Notes not reset'), e instanceof Error ? e.message : String(e)),
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
  // The footer is always one of: a spinner while a page loads (the
  // controller ends every load within 60 s, history-controller.ts), "Could
  // not load more — tap to retry" after a failure or timeout, "Load more",
  // or the end of the list (finding F3).
  // Rows left without details by the decoder (no endpoint returned their
  // transaction or receipt): counted for the footer so a tester sees how
  // many and why (phase 19 item 4). Only rows that would show the line.
  const rowsWithoutDetails = isEvmSlot
    ? state.entries.filter((entry) => sentences.isUnavailable(entry.id) && rowTextFor(entry).unavailable).length
    : 0;
  const withoutDetailsFooter = rowsWithoutDetailsFooter(rowsWithoutDetails);
  const footer = (
    <View style={styles.footer}>
      {withoutDetailsFooter ? (
        <>
          <Text style={[styles.note, { color: theme.textMuted }]} accessibilityLiveRegion="polite">
            {withoutDetailsFooter}
          </Text>
          <TechnicalDetail text={sentences.diagnostics ? unavailableDiagnosticDetail(sentences.diagnostics) : null} />
        </>
      ) : null}
      {state.loadingMore ? (
        <ActivityIndicator size="small" color={theme.textMuted} accessibilityLabel={tx('Loading older transactions')} />
      ) : state.loadMoreError ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={localize(LOAD_MORE_RETRY_FOOTER)}
            accessibilityHint={tx('Tries again to load older transactions; the entries above are unchanged')}
            accessibilityLiveRegion="polite"
            onPress={() => void loadMore()}
            hitSlop={8}
          >
            <Text style={[styles.loadMore, { color: theme.accent }]}><T>{LOAD_MORE_RETRY_FOOTER}</T></Text>
          </Pressable>
          <TechnicalDetail text={historyTechnicalText(state.loadMoreError)} />
        </>
      ) : state.hasMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tx('Load more transactions')}
          accessibilityHint={tx('Loads older transactions')}
          onPress={() => void loadMore()}
          hitSlop={8}
        >
          <Text style={[styles.loadMore, { color: theme.accent }]}><T>Load more</T></Text>
        </Pressable>
      ) : state.entries.length > 0 ? (
        <Text style={[styles.note, { color: theme.textMuted }]}>
          {rangeLimited ? tx('End of the searched blocks (see the note above).') : tx('End of history.')}
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
        renderItem={({ item: listed, index }) => {
          // The row with its decoded receipt's status (a reverted
          // transaction moved nothing).
          const item = isEvmSlot ? entryWithReceiptStatus(listed, sentences.lookup(listed.id)) : listed;
          const rowText = rowTextFor(item);
          return (
          <EntryRow
            entry={item}
            chainId={chainId}
            decimals={network.decimals}
            symbol={symbol}
            hidden={hideAmounts}
            evmExplorerTxBase={evmChain.explorerTxBase}
            sentence={rowText.sentence}
            loading={rowText.loading}
            unavailable={rowText.unavailable}
            replacementLine={isEvmSlot && account ? replacementRowLine(pendingRecords, evmChain.caip2, item.id, account.address) : null}
            sameAsAbove={index > 0 && state.entries[index - 1]?.id === listed.id}
            noAmount={hidesZeroNativeAmount(item, tokenTxIds, sentences.lookup(item.id)?.description)}
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
          );
        }}
        onViewableItemsChanged={isEvmSlot ? sentences.onViewableItemsChanged : undefined}
        // New decodes, Hide amounts and contact edits re-render the visible rows.
        extraData={`${sentences.version}|${hideAmounts}|${sentences.contacts.length}|${notesVersion}|${pendingRecords.length}`}
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
            {pendingSection}
            {state.note ? (
              <Text style={[styles.note, { color: theme.textMuted }]}>{state.note}</Text>
            ) : null}
            {/* Already cleaned by history.ts (sanitizeEndpointMessage). */}
            <TechnicalDetail text={state.noteDetail} />
            {smartHistoryNote ? (
              <Text style={[styles.note, { color: theme.textMuted }]}>{smartHistoryNote}</Text>
            ) : null}
            {noteBook?.readOnly ? (
              <View style={[styles.notesDamaged, { borderColor: theme.warningBorder, backgroundColor: theme.warningSurface }]}>
                <Text style={[styles.notesDamagedText, { color: theme.warningText }]}>
                  <T>
                  Some of your transaction notes could not be read. The notes that could be read are shown;
                  adding or changing notes is off until the notes are reset.
                  </T>
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
              ? tx('No blocks could be searched with the current endpoint.')
              : coverage
                ? tx('No tracked-token transfers found in the searched blocks.')
                : tx('No transactions found for this address.')}
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

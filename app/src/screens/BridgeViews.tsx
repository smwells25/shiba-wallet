import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { BridgeTrustStatement } from '@shiba-wallet/chains-evm';
import type { Theme } from '../theme';
import { WarningBox } from '../components';
import {
  BRIDGE_FEE_BEFORE_QUOTE,
  bridgeStatusHeading,
  bridgeStatusSentence,
  exactNative,
  providerRowSpokenLabel,
  type BridgeProviderRow,
  type BridgeTransferRecord,
} from '../wallet/bridge';

/**
 * Presentational pieces of the Bridge screen (feature 35, phase 21 item 1):
 * a provider as one radio row (label, what it moves, its trust statement
 * verbatim, the fee once quoted, the measured time with the provider's own
 * "not a promise" sentence, and why it cannot be chosen when it cannot),
 * the trust card for the confirm, and the tracking card of one transfer.
 */

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** The live figures of a provider row, once "Get quotes" or Review read them. */
export interface ProviderRowQuote {
  fee: string;
  arrives: string;
}

/** The three parts of a trust statement, labelled, verbatim. */
export function TrustStatementCard({ trust, theme, title }: { trust: BridgeTrustStatement; theme: Theme; title: string }) {
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.body, { color: theme.text }]}>
        <Text style={styles.strong}>Who verifies: </Text>
        {trust.verification}
      </Text>
      <Text style={[styles.body, { color: theme.text }]}>
        <Text style={styles.strong}>Who controls: </Text>
        {trust.control}
      </Text>
      <Text style={[styles.body, { color: theme.text }]}>
        <Text style={styles.strong}>If it does not arrive: </Text>
        {trust.refundRule}
      </Text>
    </View>
  );
}

/** The provider row body's touch handlers (see ProviderRadioRow below). */
function claimBodyTouch(): boolean {
  return true;
}

function allowBodyTouchTermination(): boolean {
  return true;
}

/**
 * One provider as a radio row. A provider that cannot be chosen is shown
 * all the same (dimmed, with the reason), so the user sees every provider
 * the wallet knows and who each would trust.
 *
 * Screen readers (emulator pass p21b, finding 3): the card used to be ONE
 * Pressable, which makes one accessibility node, so TalkBack read only its
 * label ("LayerZero (Stargate), moves test ETH. Radio button") and the
 * trust statement, fee and measured time inside it were never reached
 * before Review. Now the radio control is the card's head only
 * (accessibilityRole "radio", its checked / disabled state and
 * providerRowSpokenLabel), and every line of the card body is its own Text,
 * so TalkBack stops on each one right after the control: who verifies, who
 * controls, the refund rule, the fee, the measured time. The choice decides
 * which provider you trust, so those sentences are separate items you can
 * hear one by one rather than one long label.
 *
 * The body stays tappable for sighted users, but it is NOT a Pressable
 * (pass p21g finding B2b, below): it is a plain View that claims the touch
 * through React Native's JavaScript responder system and selects the row
 * on release. The responder props are no-ops on the native side
 * (BaseViewManager.java :914–975), so they add nothing to the
 * accessibility node; a row that cannot be chosen gets no responder
 * handlers at all. Unlike Pressable, the release is not cancelled when the
 * finger slides off the body before lifting; a scroll still cancels it,
 * because the native scroll view cancels the JavaScript touch when it
 * starts scrolling (NativeGestureUtil.kt :26).
 *
 * Pass p21e finding B2b: TalkBack still read the body as ONE stop, its
 * sentences joined by ", " ("…sent., Who controls: …") and, on the CCTP
 * row, ending "…at any time.. disabled". That body was a Pressable with a
 * `disabled` prop, which Pressable turns into an accessibilityState with
 * disabled set (Pressable.js :235–236), and the state's "disabled" was
 * spoken after the joined text. Since then every sentence is an
 * `accessible` Text, each its own stop, read exactly as written.
 *
 * Pass p21g finding B2b: with `disabled` gone, the selectable LayerZero
 * body (and the disabled one on Base Sepolia) still carried a content
 * description joining its sentences, spoken once as a single stop when
 * focus wrapped past the top of a scrolled page. The cause was the
 * Pressable itself, not any prop this file set: Pressable ALWAYS hands
 * View an accessibilityState object, whose keys may all be undefined
 * (Pressable.js :227–236 and :257), whereas a plain View sends one only
 * when a state or an aria state prop is given (View.js :86–101). JSI drops
 * the undefined keys (JSIDynamic.cpp :186), so Android receives an empty
 * but non-null map, BaseViewManager.setViewState stores it as the view's
 * accessibility_state tag (BaseViewManager.java :363–386), and the
 * delegate's rule then applies: a view with no text and no content
 * description of its own is given a description made of its children's
 * text joined by ", " (getTalkbackDescription, ReactAccessibilityDelegate.kt
 * :944–1007, delimiter at :578) whenever it has an accessibilityState, an
 * accessibilityRole, accessibilityActions or an accessibilityLabelledBy
 * (:177–187). The joining skips the children it counts as focusable, but a
 * child scrolled off the screen is not visible to the user and so not
 * focusable (:862–874), which is most likely why the description held the
 * sentences once part of the card was scrolled away, and why the CCTP body,
 * read with its sentences on the screen, showed none (inferred, not
 * observed). So the body carries none of
 * those four: no Pressable, no state, role, label, actions or labelled-by.
 */
export function ProviderRadioRow({
  row,
  selected,
  quote,
  onSelect,
  theme,
}: {
  row: BridgeProviderRow;
  selected: boolean;
  quote: ProviderRowQuote | null;
  onSelect: () => void;
  theme: Theme;
}) {
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.card,
          borderColor: selected ? theme.accent : theme.border,
          borderWidth: selected ? 2 : 1,
          opacity: row.selectable ? 1 : 0.6,
        },
      ]}
    >
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: selected, disabled: !row.selectable }}
        accessibilityLabel={providerRowSpokenLabel(row, quote)}
        disabled={!row.selectable}
        onPress={onSelect}
        style={({ pressed }) => [styles.radioHead, { opacity: pressed ? 0.8 : 1 }]}
      >
        <View style={[styles.radioOuter, { borderColor: row.selectable ? theme.accent : theme.textMuted }]}>
          {selected ? <View style={[styles.radioInner, { backgroundColor: theme.accent }]} /> : null}
        </View>
        <Text style={[styles.providerLabel, { color: theme.text }]}>
          {row.label}
          {row.asset ? ` · moves ${row.asset}` : ''}
        </Text>
      </Pressable>
      <View
        accessible={false}
        onStartShouldSetResponder={row.selectable ? claimBodyTouch : undefined}
        onResponderTerminationRequest={allowBodyTouchTermination}
        onResponderRelease={row.selectable ? onSelect : undefined}
        style={styles.radioBody}
      >
        {row.note ? <Text accessible style={[styles.body, { color: theme.textMuted }]}>{row.note}</Text> : null}
        <Text accessible style={[styles.body, { color: theme.text }]}>
          <Text style={styles.strong}>Who verifies: </Text>
          {row.trust.verification}
        </Text>
        <Text accessible style={[styles.body, { color: theme.text }]}>
          <Text style={styles.strong}>Who controls: </Text>
          {row.trust.control}
        </Text>
        <Text accessible style={[styles.body, { color: theme.text }]}>
          <Text style={styles.strong}>If it does not arrive: </Text>
          {row.trust.refundRule}
        </Text>
        {row.selectable ? (
          quote ? (
            <Text accessible style={[styles.body, { color: theme.text }]}>
              <Text style={styles.strong}>Fee (quoted just now): </Text>
              {quote.fee}. {quote.arrives}
            </Text>
          ) : (
            <Text accessible style={[styles.body, { color: theme.textMuted }]}>{BRIDGE_FEE_BEFORE_QUOTE}</Text>
          )
        ) : null}
        {row.measured ? <Text accessible style={[styles.body, { color: theme.text }]}>{row.measured}</Text> : null}
        {row.timeSource ? <Text accessible style={[styles.body, { color: theme.textMuted }]}>{row.timeSource}</Text> : null}
      </View>
    </View>
  );
}

/** One transfer of this session: where it is, from the chains' own events. */
export function TransferStatusCard({
  record,
  symbol,
  checking,
  theme,
  children,
}: {
  record: BridgeTransferRecord;
  symbol: string;
  checking: boolean;
  theme: Theme;
  children?: React.ReactNode;
}) {
  const heading = bridgeStatusHeading(record.status, record.destinationLabel);
  const failed = record.status?.state === 'failed';
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
        {exactNative(record.amountIn)} {symbol} · {record.sourceLabel} → {record.destinationLabel}
      </Text>
      <Text style={[styles.body, { color: theme.textMuted }]}>
        Through {record.providerLabel}, to {record.recipient}, sent {new Date(record.sentAt).toISOString().slice(11, 19)} UTC
        {record.senderKind === 'smart-account' ? ' from your smart account' : ''}.
      </Text>
      <Text accessibilityLiveRegion="polite" style={[styles.status, { color: failed ? theme.danger : theme.text }]}>
        {heading}
        {checking ? ' (checking…)' : ''}
      </Text>
      <Text style={[styles.body, { color: theme.text }]}>{bridgeStatusSentence(record)}</Text>
      {record.status && record.checkError ? (
        <Text style={[styles.body, { color: theme.textMuted }]}>The last check failed: {record.checkError}</Text>
      ) : null}
      <Text style={[styles.label, { color: theme.textMuted }]}>Sending transaction</Text>
      <Text selectable style={[styles.monoText, { color: theme.text }]}>
        {record.sourceTxHash ?? (record.userOpHash ? `not known yet (UserOperation ${record.userOpHash})` : 'not known yet')}
      </Text>
      {record.status?.destinationTxHash ? (
        <>
          <Text style={[styles.label, { color: theme.textMuted }]}>Receiving transaction</Text>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {record.status.destinationTxHash}
          </Text>
        </>
      ) : null}
      {record.retryTxHash ? (
        <>
          <Text style={[styles.label, { color: theme.textMuted }]}>Delivery transaction sent from this wallet</Text>
          <Text selectable style={[styles.monoText, { color: theme.text }]}>
            {record.retryTxHash}
          </Text>
        </>
      ) : null}
      {children}
    </View>
  );
}

/** A refusal or an error, shown in the shared warning panel. */
export function BridgeWarning({ text, announce = false }: { text: string; announce?: boolean }) {
  return <WarningBox announce={announce}>{text}</WarningBox>;
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  providerLabel: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  radioHead: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  radioBody: { gap: 8 },
  radioOuter: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 10, height: 10, borderRadius: 5 },
  body: { fontSize: 13, lineHeight: 19 },
  strong: { fontWeight: '700' },
  status: { fontSize: 15, fontWeight: '700' },
  label: { fontSize: 13, fontWeight: '600', marginTop: 4 },
  monoText: { fontFamily: mono, fontSize: 13, lineHeight: 19 },
});

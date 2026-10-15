/**
 * Pure helpers for what screen readers say (pass p20c, TalkBack findings).
 * No React Native imports, so scripts/check-devmode.mjs and the other
 * offline checks can load this file directly.
 */

/**
 * The spoken name of a text link: its visible text without the decorative
 * arrow and check mark ("Send ↗" → "Send", "Passkey ✓" → "Passkey"), so the
 * name a screen reader says is the text a sighted person sees (WCAG 2.2
 * success criterion 2.5.3 "Label in Name"); anything more goes in the hint.
 */
export function spokenLinkText(text: string): string {
  return text.replace(/\s*[↗✓]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * An address as the wallet shows it and as a screen reader should say it:
 * "0x772e…F44F" (the first six and last four characters). TalkBack read the
 * full 42 characters of a multisig address (pass p20c finding 5).
 */
export function spokenShortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * The one spoken label of a Home token row (pass p20c finding 3): the
 * symbol, the row's second line, then the balance, in that order on every
 * row (TalkBack read the badge's symbol as a separate item, and wstETH's
 * balance before its Send link). The Send action follows as the row's
 * action, not as a separate element.
 */
export function tokenRowSpokenLabel(p: { symbol: string; subtitle: string; balance: string }): string {
  return `${p.symbol}, ${p.subtitle.replace(/ · /g, ', ')}. ${p.balance}`;
}

/**
 * A token symbol for speech, with its full name when the wallet knows one
 * that differs ("Liquid staked Ether 2.0 (stETH)"): TalkBack spelled
 * "STETH" and "WSTETH" letter by letter (pass p20c finding 6).
 */
export function spokenTokenName(symbol: string, name: string | null | undefined): string {
  const n = (name ?? '').trim();
  return n !== '' && n.toLowerCase() !== symbol.toLowerCase() ? `${n} (${symbol})` : symbol;
}

/**
 * The spoken label of a source link: the site's name, not the raw URL
 * ("https: 2 Slashapp.uniswap.org"). `https://docs.lido.fi/guides/x` →
 * "docs.lido.fi". An unparseable string is returned unchanged.
 */
export function spokenSiteName(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:@]+)/i.exec(url.trim());
  return m ? m[1]!.toLowerCase().replace(/^www\./, '') : url;
}

/**
 * The spoken label of an Apps site card (pass p20c finding 10): the host,
 * then what activating it does.
 */
export function appSiteCardSpokenLabel(origin: string): string {
  return `${spokenSiteName(origin)}, opens in the wallet's browser`;
}

/** The account switcher's line under an imported account's row. */
export const SWITCHER_IMPORTED_LINE = 'Imported key, Ethereum only — not backed up by your recovery phrase';

/**
 * The spoken label of a recovery-phrase or imported account's row in the
 * account switcher (pass p20c finding 5): the name, the short address the
 * row shows and, for an imported key, the row's warning line. The selected
 * row's ✓ is not part of it — "selected" comes from accessibilityState.
 */
export function switcherRowSpokenLabel(account: { name: string; evmAddress: string | null; imported?: boolean }): string {
  const parts = [account.name];
  if (account.evmAddress) parts.push(spokenShortAddress(account.evmAddress));
  if (account.imported) parts.push(SWITCHER_IMPORTED_LINE);
  return parts.join(', ');
}

/**
 * A saved contact's row as a screen reader says it: the name, then the short
 * address ("Burn, 0x0000…dEaD"); the row itself shows the full address
 * (pass p21a: TalkBack read all 42 characters of the Burn contact).
 */
export function contactRowSpokenLabel(contact: { name: string; address: string }): string {
  return `${contact.name}, ${spokenShortAddress(contact.address)}`;
}

/**
 * A sentence with every full Ethereum address in it shortened for speech
 * ("Balances of your regular account 0x772e…F44F"); TalkBack read the
 * 42-character address on the Staking screen (pass p20c finding 6).
 */
export function withShortAddresses(text: string): string {
  return text.replace(/0x[0-9a-fA-F]{40}\b/g, (a) => spokenShortAddress(a));
}

/**
 * The spoken label of a payload QR code (recovery records, guardian
 * approvals, multisig requests, approvals and records, the multisig
 * address): "QR code: Multisig signing request — part 1 of 2".
 */
export function payloadQrSpokenLabel(caption: string, label?: string): string {
  return `QR code: ${label ?? caption}`;
}

/**
 * The start of an Activity row's spoken label (pass p20c finding 12): the
 * transaction's sentence; or, for the second row of the same transaction
 * (a token transfer and its native leg are listed as two rows), "Same
 * transaction as the row above." instead of the same sentence again; or
 * the loading label while the sentence may still arrive.
 */
export function activityRowSpokenLead(p: {
  sentence: string | null;
  loading: boolean;
  sameAsAbove: boolean;
  loadingLabel: string;
}): string {
  if (p.sameAsAbove) return 'Same transaction as the row above. ';
  if (p.sentence) return `${p.sentence}. `;
  return p.loading ? `${p.loadingLabel}. ` : '';
}

/**
 * The style of a field label that is present for screen readers but not
 * drawn (pass p20d finding 1): the "visually hidden" pattern — a 1×1 box out
 * of the layout flow (absolutely positioned, so a parent's gap ignores it), clipping its text,
 * with transparent text.
 *
 * Why not opacity 0, zero size or display "none": Android resolves a
 * field's accessibilityLabelledBy by searching the native view hierarchy
 * for the view whose nativeID matches (RN 0.86.3
 * ReactAccessibilityDelegate.kt:91–97 → ReactFindViewUtil.kt findView,
 * :48–62, which walks every child whatever its visibility) and hands that
 * view to AccessibilityNodeInfo.setLabeledBy, so the label must exist as a
 * native view — a Text always forms one (ConcreteViewShadowNode.h:73 sets
 * FormsView and ParagraphShadowNode.h:42–57 keeps it, so Fabric never
 * flattens it away), and nativeID is stored on it by
 * BaseViewManager.setNativeId (:309–314). What TalkBack then does with the
 * labelling view is Android's and TalkBack's code, not React Native's: RN
 * maps display "none" to View.INVISIBLE (SurfaceMountingManager.kt:863–864), and a
 * view that is invisible, fully transparent (alpha 0, BaseViewManager.setOpacity
 * :268–271 sets View.alpha) or of zero size may be treated as not shown to
 * the user. Keeping alpha 1, a real 1×1 size and VISIBLE is the
 * conservative choice; the text is hidden by the clip and the transparent
 * colour instead. (Pass p21a confirmed on the emulator that a field
 * labelled by such a view reads "Edit box for <label>". Pass p21b showed
 * that marking the view importantForAccessibility "no" loses that name, so
 * the view keeps the default importance and reads as the field's caption —
 * components.tsx HiddenFieldLabel.)
 */
export const HIDDEN_FIELD_LABEL_STYLE = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  color: 'transparent',
} as const;

/**
 * When a refusal box should take the screen reader's focus (pass p20d
 * finding 2). The pass found the focus moved for a refusal shown at once
 * (the Review button stays on screen) but not for one shown after the
 * asynchronous review: while the review runs the form replaces Review with
 * a spinner, the screen reader's focus is lost with it, and a focus event
 * sent the moment the box is committed is overtaken by the screen reader
 * placing its focus again. So the focus is sent only after the box has
 * been laid out (its onLayout), and then after a short settle delay
 * (ANNOUNCE_FOCUS_SETTLE_MS, a judgement, not a documented figure), never
 * at commit time. A text change on a box that is already laid out (a second
 * refusal with other figures; the size may not change, so no new onLayout)
 * schedules the focus at once.
 *
 * Pure (no React Native): `send` moves the focus, `schedule` / `cancel`
 * wrap setTimeout, so the checks drive it with fakes.
 */
export const ANNOUNCE_FOCUS_SETTLE_MS = 250;

export interface AnnounceFocus {
  /** The box's spoken text is now `text` (null: the box is gone). */
  textChanged(text: string | null): void;
  /** The box has been laid out (its onLayout ran). */
  laidOut(): void;
  /** The box unmounts: nothing more is sent. */
  dispose(): void;
}

export function createAnnounceFocus(deps: {
  send: () => void;
  schedule: (run: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  settleMs?: number;
}): AnnounceFocus {
  const settle = deps.settleMs ?? ANNOUNCE_FOCUS_SETTLE_MS;
  let text: string | null = null;
  let laidOutOnce = false;
  let pending = false;
  let handle: unknown = null;
  let disposed = false;
  const clear = () => {
    if (handle !== null) deps.cancel(handle);
    handle = null;
  };
  const fire = () => {
    clear();
    pending = false;
    handle = deps.schedule(() => {
      handle = null;
      if (!disposed && text !== null) deps.send();
    }, settle);
  };
  return {
    textChanged(next) {
      if (disposed || next === text) return;
      text = next;
      if (next === null) {
        pending = false;
        laidOutOnce = false;
        clear();
        return;
      }
      if (laidOutOnce) fire();
      else pending = true;
    },
    laidOut() {
      if (disposed) return;
      laidOutOnce = true;
      if (pending && text !== null) fire();
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

/**
 * The hint of a chain card's Send link on Home (pass p20d finding 6): the
 * coin as the wallet names it on that network — "Sends test ETH" on a test
 * network, never a hard-coded "ETH".
 */
export function sendLinkHint(displaySymbol: string): string {
  return `Sends ${displaySymbol}`;
}

/**
 * "More accounts below — scroll the list." spoken ONCE each time the account
 * switcher opens with rows below the fold (pass p21a finding 7). The
 * always-mounted live region under the list (AccountSwitcher.tsx) was not
 * spoken when the switcher opened — its content arrives with the new
 * window, so TalkBack reports it only as part of the window-state event —
 * nor when the expander opened (the overflow state does not change); it was
 * spoken only when the line reappeared after scrolling back up. The live
 * region stays for that reappearance; this adds one announcement per open.
 *
 * The decision is taken at the first MEASURED state after `opened()` (the
 * list's height and its content's height both known): with overflow, one
 * announcement is scheduled after SWITCHER_OVERFLOW_ANNOUNCE_DELAY_MS, and
 * sent only if the list still overflows and is still open then; without
 * overflow, nothing — and nothing later in the same open either (the
 * expander or a scroll changing the overflow is the live region's job).
 * The delay is a judgement, not a documented figure: it lets the screen
 * reader's own reading of the newly opened window start first.
 *
 * Pure (no React Native): `announce` is
 * AccessibilityInfo.announceForAccessibility in the app, a counter in the
 * checks; `schedule` / `cancel` wrap setTimeout.
 */
export const SWITCHER_OVERFLOW_ANNOUNCE_DELAY_MS = 500;

export interface OverflowAnnouncer {
  /** The switcher opened: the next measured state decides. */
  opened(): void;
  /** The latest sizes: `measured` once both heights are known. */
  update(state: { measured: boolean; overflows: boolean }): void;
  /** The switcher closed: a scheduled announcement is dropped. */
  closed(): void;
  /** The component unmounts. */
  dispose(): void;
}

export function createOverflowAnnouncer(deps: {
  message: string;
  announce: (message: string) => void;
  schedule: (run: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  delayMs?: number;
}): OverflowAnnouncer {
  const delay = deps.delayMs ?? SWITCHER_OVERFLOW_ANNOUNCE_DELAY_MS;
  let deciding = false;
  let overflowsNow = false;
  let handle: unknown = null;
  let disposed = false;
  const clear = () => {
    if (handle !== null) deps.cancel(handle);
    handle = null;
  };
  const close = () => {
    deciding = false;
    overflowsNow = false;
    clear();
  };
  return {
    opened() {
      close();
      deciding = !disposed;
    },
    update({ measured, overflows }) {
      overflowsNow = measured && overflows;
      if (!deciding || !measured) return;
      deciding = false;
      if (!overflows) return;
      handle = deps.schedule(() => {
        handle = null;
        if (!disposed && overflowsNow) deps.announce(deps.message);
      }, delay);
    },
    closed: close,
    dispose() {
      disposed = true;
      close();
    },
  };
}

import {
  assertCallsAllowed,
  describePeriod,
  formatBaseUnits,
  formatUtc,
  isNativeSubscription,
  nextPullAllowedAt,
  parseSessionKeyGrant,
  selector as abiSelector,
  subscriptionPeriodCount,
  subscriptionPullCall,
  toHex,
  type Call,
  type JsonRpcTransport,
  type SessionKeyGrant,
  type SmartAccountClient,
  type SubscriptionChainState,
  type SubscriptionGrant,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by
// scripts/check-recurring.mjs under Node's type stripping.
import {
  DCA_SOURCE,
  SESSION_UNREACHABLE_TITLE,
  dcaTermsOf,
  describeSessionError,
  isBundlerTransportFailureBeforeSubmit,
  isNodeEndpointFailure,
  isTransportFailure,
  loadSessions,
  recurringGraceSeconds,
  sendSessionCalls,
  type SessionKeyVault,
  type SessionRecord,
  type SessionSubscriptionMeta,
} from './sessions.ts';
import {
  readSubscriptionStatus,
  shortAddress,
  subscriptionGrantFor,
  subscriptionMeta,
  termsOf,
  type SubscriptionStatus,
  type SubscriptionTokenChoice,
} from './subscriptions.ts';
import {
  SPENDING_BLOCK_TITLE,
  SPENDING_HONESTY_SENTENCE,
  evaluateBeforeSigning,
  overLimitSentence,
  recordAcceptedSpend,
  type SpendingScope,
} from './spending-policy.ts';
import type { AaAccountType } from './aa.ts';
import type { KeyValueStore } from './tokens.ts';
import { assertFeatureAllowed, isFeatureAllowed } from '../config/readiness.ts';
import { NO_ANSWER_SENTENCE, sanitizeEndpointMessage } from '../config/endpoint-probe.ts';
import { isBroadcastOutcomeUnknown } from './broadcast-outcome.ts';
import { BROADCAST_TIMEOUT_MS } from '@shiba-wallet/chains-evm';

/**
 * Recurring payments pushed by this phone (phase 15 item 1; the slice
 * recommended in docs/SCHEDULED_PAYMENTS.md section 5.1): "pay X every N to Y".
 *
 * THE GRANT. The subscription template (engine kernel-subscription: one
 * allowed call — a transfer of at most X to Y — plus TimestampPolicy, a
 * mandatory GasPolicy fee budget and RateLimitPolicy {interval = period,
 * count = payments, startAt = the moment Start was tapped}), produced by the
 * same function the subscription form uses (subscriptionGrantFor), with ONE
 * difference: the grant's validUntil is one period later than the terms'
 * (a grace period for a late last payment; recurringGrantFor says why it
 * cannot add a payment). Only the roles change: the payee is the
 * "merchant", and the session key is generated on this phone, stored in the
 * same secure vault as every session key and NEVER handed over
 * (sessions.ts installSession / releaseSessionKey and subscriptions.ts
 * buildSubscriptionKeyExport refuse it).
 *
 * WHO SENDS. This app, and only while it is open: React Native has no
 * reliable background execution, so no payment is ever sent in the
 * background. (Since phase 17 item 2 the wallet can REMIND the user when a
 * payment falls due, with a local notification scheduled on the phone —
 * notifications.ts, Settings → Privacy → Notifications, off by default,
 * working in the wallet's own build but not inside Expo Go; a reminder
 * never sends anything.) When the wallet comes to the foreground (components/RecurringDueBanner) or the
 * Sessions screen gains focus, it reads each recurring payment's on-chain
 * RateLimitPolicy / GasPolicy state (read-only eth_calls) and SHOWS the due
 * ones. A due payment is sent only after the user confirms it in a dialog:
 * planRecurringPayment (re-reads the chain, refuses one that is not due)
 * → the confirmation → payRecurringPayment (spending limits, then
 * sendSessionCalls with the payment key). The due check itself never reads
 * a key and never contacts a bundler (findDueRecurringPayments).
 *
 * WHAT SIGNS. The payment key alone, through sessions.ts sendSessionCalls
 * (engine kernelSessionSpec). The owner key and the recovery phrase are
 * never read for a payment: this module has no access to signWith, the
 * phrase vault or the biometric gate. If the payment key was stored with
 * biometric protection (it is when the recovery phrase is protected at the
 * time of the set-up), reading it shows ONE system prompt, "Use the session
 * key"; otherwise there is no system prompt — only the wallet's own
 * confirmation dialog.
 *
 * WHAT IS NOT CLOSED. Everything the subscription module header says about
 * batching applies: one operation may batch several transfers, each under
 * the cap, so anyone who obtained the payment key could take up to the
 * account's whole balance of the token, to the payee only. The review
 * states it first.
 *
 * LATER SLICE (not built, deliberately): SENDING while the app is closed
 * needs background execution (expo-background-task / expo-task-manager), an
 * OS-scheduled task whose timing the OS decides, and a product decision on
 * how a payment may be sent without the user present (today every payment
 * follows a confirmation). Reminders exist (see WHO SENDS); sending does
 * not. See RECURRING_LATER_SLICE_NOTE.
 */

/** The SessionRecord source of a recurring payment. */
export const RECURRING_SOURCE = 'recurring' as const;

// ---------------------------------------------------------------------------
// User-facing sentences
// ---------------------------------------------------------------------------

export const RECURRING_FORM_INTRO =
  'Pays one recipient up to a fixed amount once per period from your smart account, until the payments ' +
  'run out or you revoke. A new payment key is created on this phone and never leaves it; your account ' +
  'enforces the limits on-chain.';

/** Shown on the form, the review and every recurring-payment card. */
export const RECURRING_WHILE_OPEN_NOTE =
  'Payments are sent only while this wallet is open. When one is due, the wallet shows it on this screen ' +
  '(and in a banner when you open the app) and sends it only after you confirm. Nothing is sent in the ' +
  'background or while the wallet is closed. A payment missed while the wallet was closed is not lost: ' +
  'your account allows it to be sent later, until the end date.';

/**
 * The prompts of a payment, stated exactly. The system prompt's title is
 * the vault's session-key read prompt (storage.ts PROMPTS.sessionKeyRead,
 * pinned by scripts/check-recurring.mjs).
 */
export const RECURRING_PAY_PROMPT_NOTE =
  'You confirm each payment in the wallet. The payment key signs it, not your account key, so your ' +
  'recovery phrase is never opened for it. If the payment key is protected by biometrics (it is when your ' +
  'recovery phrase was protected at set-up), the phone also asks once: "Use the session key".';

/** Judgement (phase 15 item 1): the app-only spending check runs before each payment; see payRecurringPayment. */
export const RECURRING_SPENDING_NOTE =
  'Your spending limits (this app only) are checked before each payment, by the payment amount: a payment ' +
  'that would go over a limit is not sent. The network fee of a recurring payment is not counted against ' +
  'limits; the fee budget caps it on-chain.';

/**
 * The short form of RECURRING_WHILE_OPEN_NOTE above the recurring cards.
 * Finding 5 of the development-build pass (2026-10-10): it used to end
 * "Nothing runs in the background.", which became false once reminders
 * existed (a reminder can arrive while the wallet is closed); what stays
 * true is that no payment is ever sent in the background.
 */
export const RECURRING_CARD_NOTE =
  'Sent only while this wallet is open, and only after you confirm each payment; no payment is ever sent in ' +
  'the background. With reminders on (Settings → Privacy → Notifications), this phone can remind you when a ' +
  'payment falls due, even while the wallet is closed; the payment still waits for you.';

export const RECURRING_START_NOTE =
  'The schedule starts when you tap Start recurring payment, not when this screen opened: the dates above ' +
  'move forward by the time you spend here, and the final dates are shown once the bundler accepts the ' +
  'set-up. The first payment is due right away.';

/** GrantReview's key-holder phrase ("Session key (held by …)"): one parenthesis only. */
export const RECURRING_KEY_HOLDER_TEXT = 'this phone’s secure storage only, never shown or exported';

export const RECURRING_KEY_STATUS_TEXT =
  'Payment key on this phone only (never shown or exported); deleted from this phone when you revoke.';
export const RECURRING_KEY_GONE_TEXT = 'Payment key no longer on this phone, so this wallet cannot send payments for it.';

export const RECURRING_AUDIT_NOTE =
  'Recurring payments use ZeroDev’s ECDSASigner, CallPolicy v0.0.4, TimestampPolicy, GasPolicy and ' +
  'RateLimitPolicy. No published security audit names these modules, so treat recurring payments as ' +
  'experimental with real funds.';

/**
 * Reminders versus sending (form note; the module header has the detail).
 * Finding 5 of the development-build pass: the old note said notifications
 * would need a development build; reminders now exist and were proven in the
 * wallet's own build, while Expo Go refuses their channels
 * (notifications.ts NOTIFICATIONS_EXPO_GO_TEXT).
 */
export const RECURRING_LATER_SLICE_NOTE =
  'Reminders: with "Remind me when something is due" on (Settings → Privacy → Notifications), this phone ' +
  'shows a reminder when a payment falls due, even while the wallet is closed. Reminders need the wallet’s ' +
  'own build of the app; they do not work inside Expo Go. A reminder never sends anything: sending while the ' +
  'wallet is closed would need a decision on whether a payment may ever go out without you confirming it, so ' +
  'this version always asks you first.';

export function recurringFeeBudgetHint(nativeSymbol: string): string {
  return (
    `Each payment’s network fee is paid by your smart account in ${nativeSymbol}. The budget caps the ` +
    'total on-chain, including what anyone holding the payment key could spend on fees.'
  );
}

export const RECURRING_COMPLETED_TEXT =
  'No more payments can be sent. Revoke it to remove the permission from your account (the payment key is ' +
  'deleted from this phone too); it is then forgotten here.';

// ---------------------------------------------------------------------------
// Names, grant and review
// ---------------------------------------------------------------------------

/**
 * The names of a new recurring payment: the terms' label (stored with the
 * grant) and the card title. A typed name or the payee's exact-match contact
 * name gives "Recurring payment: <name>"; with neither, "Recurring payment
 * to 0x69F0…7E8a".
 */
export function recurringNames(
  typedLabel: string,
  payee: string,
  payeeName: string | null,
): { termsLabel: string; recordLabel: string } {
  const named = typedLabel.trim() || (payeeName ?? '').trim();
  if (named) return { termsLabel: named, recordLabel: `Recurring payment: ${named}` };
  const short = shortAddress(payee.trim());
  return { termsLabel: `to ${short}`, recordLabel: `Recurring payment to ${short}` };
}

/**
 * The engine grant of a recurring payment: deliberately the very function the
 * subscription form uses, so the two templates can never drift apart
 * (scripts/check-recurring.mjs compares them field by field), with a grace
 * period of ONE PERIOD added to the grant's validUntil
 * (sessions.ts recurringGraceSeconds).
 *
 * WHY. The terms end at start + payments × period, so without a grace the
 * LAST payment could be sent during a single period only: a late last
 * payment plus one transient error lost it for good (finding 3 of the
 * 2026-10-09 recurring-payments rehearsal), which contradicted "a missed
 * payment is not lost". With the grace the last payment can be sent during
 * two periods, until start + (payments + 1) × period.
 *
 * WHY IT CANNOT ADD A PAYMENT. The grace moves only TimestampPolicy's
 * validUntil (engine kernel-permissions.ts kernelPermissionFromGrant
 * encodes TimestampPolicy from grant.validAfter / grant.validUntil, line 547,
 * and RateLimitPolicy from grant.rateLimit's interval, count and startAt,
 * lines 553–557). The count stays subscriptionPeriodCount(terms) = payments
 * (subscriptionGrantFor changes nothing else, and check-recurring pins it).
 * RateLimitPolicy's count is the TOTAL number of operations: each operation
 * decrements it and, once it is 0, the policy returns a failure, which
 * Kernel turns into PolicyFailed (engine kernel-subscription.ts module
 * header, lines 44–56, and the Kernel v3.3 note at lines 66–69: every
 * policy runs once per operation and their validity windows are
 * intersected). So a longer TimestampPolicy window still allows at most
 * `payments` operations; the extra period only keeps the slots that are
 * already allowed open for longer. (Those engine notes record the policy
 * sources as read for the engine; they were not re-read for this change.)
 */
export function recurringGrantFor(
  sub: SubscriptionGrant,
  sessionKey: string,
  context: { account: string; now: number },
): SessionKeyGrant {
  return subscriptionGrantFor(sub, sessionKey, { ...context, graceSeconds: recurringGraceSeconds(sub) });
}

/**
 * The end of a recurring payment that is about to be set up: the terms' end
 * plus the grace period, i.e. exactly the validUntil recurringGrantFor puts
 * in the grant (after it no payment can be sent).
 */
export function recurringEndOf(sub: Pick<SubscriptionGrant, 'validUntil' | 'periodSeconds'>): number {
  return sub.validUntil + recurringGraceSeconds(sub);
}

/**
 * The end of an INSTALLED recurring payment: its stored grant's validUntil
 * (what TimestampPolicy enforces). Recurring payments set up before the
 * grace period existed end at the terms' end; newer ones one period later.
 */
export function recurringEndsAt(record: SessionRecord): number {
  return parseSessionKeyGrant(record.grant).validUntil;
}

/** When the last of `sub`'s payments falls due: start + (payments − 1) × period. */
function lastPaymentDueAt(sub: Pick<SubscriptionGrant, 'startAt' | 'validUntil' | 'periodSeconds'>): number {
  return sub.startAt + Math.max(0, subscriptionPeriodCount(sub) - 1) * sub.periodSeconds;
}

/** The meta stored with the record; keyExportedAt stays null for the record's whole life. */
export function recurringMeta(sub: SubscriptionGrant, choice: SubscriptionTokenChoice): SessionSubscriptionMeta {
  return subscriptionMeta(sub, choice);
}

/** The recurring-payment records of a session list. */
export function recurringRecords(records: readonly SessionRecord[]): SessionRecord[] {
  return records.filter((r) => r.source === RECURRING_SOURCE && r.subscription);
}

export interface RecurringDescription {
  sentence: string;
  /** What the account enforces on-chain. */
  enforced: string[];
  /** caveats[0] is the batching residual and is always shown first, in a warning box. */
  caveats: string[];
}

/**
 * The plain-language review of a recurring payment (own wording; the facts
 * are the subscription module's). Every date printed as the end is the
 * grant's validUntil: `context.endsAt` for an installed record
 * (recurringEndsAt), else the end the set-up will install (recurringEndOf).
 */
export function recurringReview(
  sub: SubscriptionGrant,
  context: { tokenSymbol: string; tokenDecimals: number; nativeSymbol: string; payeeName?: string | null; endsAt?: number },
): RecurringDescription {
  const end = context.endsAt ?? recurringEndOf(sub);
  const graced = end > sub.validUntil;
  const payee = context.payeeName ? `${context.payeeName} (${sub.merchant})` : sub.merchant;
  const amount = `${formatBaseUnits(sub.amountPerPeriod, context.tokenDecimals)} ${context.tokenSymbol}`;
  const period = describePeriod(sub.periodSeconds);
  const count = subscriptionPeriodCount(sub);
  const fee = `${formatBaseUnits(sub.feeBudgetWei, 18)} ${context.nativeSymbol}`;
  const sentence =
    `Pays ${payee} up to ${amount} every ${period} until ${formatUtc(end)}: at most one payment ` +
    'per period, each sent by this wallet after you confirm it.';
  const enforced = [
    isNativeSubscription(sub)
      ? `Only plain ${context.tokenSymbol} transfers to ${sub.merchant}, at most ${amount} each.`
      : `Only ${context.tokenSymbol} (contract ${sub.token}) transfers to ${sub.merchant}, at most ${amount} each.`,
    `At most ${count} payment${count === 1 ? '' : 's'} in total: the first from ${formatUtc(sub.startAt)}, ` +
      `then one more every ${period}.`,
    `Nothing after ${formatUtc(end)}. The last payment falls due ${formatUtc(lastPaymentDueAt(sub))} and can be ` +
      'sent until then.',
    `Network fees for the payments are paid by your account, at most ${fee} in total.`,
    'The payment key cannot sign messages, logins or permits for your account.',
  ];
  const caveats = [
    'ONE PAYMENT OPERATION CAN HOLD SEVERAL TRANSFERS. Your account checks each transfer against the cap but ' +
      'does not add them up, and it cannot refuse a batch. This wallet sends exactly one transfer per payment, ' +
      `but anyone who got the payment key off this phone could send several times ${amount} in one operation — ` +
      `up to everything this account holds in ${context.tokenSymbol} — though only to ${sub.merchant}. Keep ` +
      'only what you are willing to pay in this account.',
    'Missed payments are not lost: a payment whose period passed while the wallet was closed can still be sent ' +
      'later, even right before the next one, until the end date.' +
      (graced
        ? // The grant ends at start + (payments + 1) × period and the last
          // payment falls due at start + (payments − 1) × period: the end is
          // TWO periods after it (one the terms give every payment, one of
          // grace). Finding 5 of the development-build pass: this said "one
          // period", which disagreed with the dates shown.
          ' The end date is two periods after the last payment falls due (one period more than the terms alone ' +
          'would allow, as a grace period), so a late last payment can still be sent too; this does not allow any ' +
          'extra payment.'
        : ''),
    'The payment key lives in this phone’s secure storage. Wiping the wallet or restoring it from the recovery ' +
      'phrase deletes it: payments then stop, while the permission stays on-chain until its end date. Revoke ' +
      'before wiping.',
    'Stop at any time with Revoke (one operation signed by your account key). Payments already sent are not ' +
      'returned.',
  ];
  return { sentence, enforced, caveats };
}

/**
 * Warning for terms shorter than ten minutes in total (the subscription
 * form's threshold, a judgement): every payment needs the wallet open and a
 * confirmation, so short terms can end before some payments are sent.
 * The total is from the start to the end the set-up installs
 * (recurringEndOf: start + (payments + 1) × period), and the sentence splits
 * it the way the review does: (payments − 1) periods until the last payment
 * falls due, then two periods in which it can still be sent. Finding 5 of the
 * development-build pass: "8 minutes in total (3 payments of 2 minutes)" did
 * not add up on its face.
 */
export function recurringShortWindowWarning(sub: Pick<SubscriptionGrant, 'startAt' | 'validUntil' | 'periodSeconds'>): string | null {
  // From the start to the end the set-up installs (the grace period included).
  const total = recurringEndOf(sub) - sub.startAt;
  if (!(total < 600)) return null;
  const count = subscriptionPeriodCount(sub);
  const untilLast = recurringEndOf(sub) - lastPaymentDueAt(sub);
  return (
    `These terms last only ${describePeriod(total)} in total: ${count} payment${count === 1 ? '' : 's'}, one ` +
    `every ${describePeriod(sub.periodSeconds)}, and the last one can still be sent for ` +
    `${describePeriod(untilLast)} after it falls due. Payments are sent only while the wallet is open and after you ` +
    'confirm each one, so some may not be sent before the end date. Choose a longer period or more payments ' +
    'unless this is a quick test.'
  );
}

/** The success screen's line with the dates the set-up actually carries. */
export function recurringFinalDatesLine(sub: SubscriptionGrant): string {
  const count = subscriptionPeriodCount(sub);
  return (
    `Final terms: the first payment is due from ${formatUtc(sub.startAt)}, then one more every ` +
    `${describePeriod(sub.periodSeconds)} (${count} in total); nothing after ${formatUtc(recurringEndOf(sub))}.`
  );
}

/** One-line summary for a card: "0.001 test ETH every 1 day to <payee>". */
export function recurringSummary(record: SessionRecord, payeeName?: string | null): string {
  const terms = termsOf(record);
  const meta = record.subscription!;
  const amount = `${formatBaseUnits(terms.amountPerPeriod, meta.tokenDecimals)} ${meta.tokenSymbol}`;
  const who = payeeName ? `${payeeName} (${terms.merchant})` : terms.merchant;
  return `${amount} every ${describePeriod(terms.periodSeconds)} to ${who}${isNativeSubscription(terms) ? '' : ` (token ${terms.token})`}`;
}

export function recurringKeyStatusText(record: SessionRecord): string {
  return record.keyHeld ? RECURRING_KEY_STATUS_TEXT : RECURRING_KEY_GONE_TEXT;
}

// ---------------------------------------------------------------------------
// Due detection (read-only)
// ---------------------------------------------------------------------------

export type RecurringDue =
  /** One or more payments can be sent now; `openSlots` > 1 means missed periods can be caught up. */
  | { kind: 'due'; since: number; openSlots: number; remaining: number; sent: number; total: number; feeBudgetLeftWei: bigint }
  | { kind: 'later'; at: number; remaining: number; sent: number; total: number; feeBudgetLeftWei: bigint }
  /** No payment can be sent any more: all were sent, or the end date passed. */
  | { kind: 'completed'; reason: 'all-sent' | 'ended'; sent: number; total: number; feeBudgetLeftWei: bigint }
  /** The permission is not installed (revoked, or never installed). */
  | { kind: 'inactive' }
  | { kind: 'unknown'; reason: string }
  /** The local record cannot pay (set-up not confirmed, revoking, or the key is gone). */
  | { kind: 'not-ready'; reason: string };

/**
 * How many payments RateLimitPolicy would accept right now: slot k opens at
 * nextSlotAt + k × interval (the policy returns the current startAt as
 * validAfter and moves it forward one interval per operation), and every
 * slot must open no later than validUntil and before `now`; at most the
 * remaining count.
 */
export function openSlotCount(state: Pick<SubscriptionChainState, 'nextSlotAt' | 'intervalSeconds' | 'remainingPulls' | 'validUntil'>, now: number): number {
  if (state.remainingPulls <= 0 || state.nextSlotAt > now) return 0;
  const last = Math.min(now, state.validUntil);
  if (state.nextSlotAt > last) return 0;
  const interval = state.intervalSeconds > 0 ? state.intervalSeconds : 1;
  return Math.min(state.remainingPulls, Math.floor((last - state.nextSlotAt) / interval) + 1);
}

/** The due state of one recurring record from its on-chain status. Pure; no network, no key. */
export function recurringDueState(record: SessionRecord, status: SubscriptionStatus, now: number): RecurringDue {
  if (record.source !== RECURRING_SOURCE || !record.subscription) return { kind: 'not-ready', reason: 'Not a recurring payment.' };
  if (record.localStatus === 'installing') return { kind: 'not-ready', reason: 'The set-up is not confirmed on-chain yet.' };
  if (record.localStatus === 'failed') return { kind: 'not-ready', reason: 'The set-up was refused or reverted.' };
  if (record.localStatus === 'revoking' || record.localStatus === 'revoked') {
    return { kind: 'not-ready', reason: 'This recurring payment was revoked.' };
  }
  if (!record.keyHeld) return { kind: 'not-ready', reason: RECURRING_KEY_GONE_TEXT };
  if (status.kind === 'unknown') return { kind: 'unknown', reason: status.reason };
  return dueFromChainState(status.state, subscriptionPeriodCount(termsOf(record)), now);
}

/** Shown on a recurring swap's card when its key is no longer on this phone. */
export const DCA_KEY_GONE_TEXT = 'Swap key no longer on this phone, so this wallet cannot send swaps for it.';

/**
 * The due state of one recurring SWAP (./dca.ts) from its on-chain status:
 * the same RateLimitPolicy rules as a recurring payment (a "payment" below is
 * one swap). Pure; no network, no key.
 */
export function dcaDueState(record: SessionRecord, status: SubscriptionStatus, now: number): RecurringDue {
  if (record.source !== DCA_SOURCE || !record.dca) return { kind: 'not-ready', reason: 'Not a recurring swap.' };
  if (record.localStatus === 'installing') return { kind: 'not-ready', reason: 'The set-up is not confirmed on-chain yet.' };
  if (record.localStatus === 'failed') return { kind: 'not-ready', reason: 'The set-up was refused or reverted.' };
  if (record.localStatus === 'revoking' || record.localStatus === 'revoked') {
    return { kind: 'not-ready', reason: 'This recurring swap was revoked.' };
  }
  if (!record.keyHeld) return { kind: 'not-ready', reason: DCA_KEY_GONE_TEXT };
  if (status.kind === 'unknown') return { kind: 'unknown', reason: status.reason };
  return dueFromChainState(status.state, dcaTermsOf(record).count, now);
}

/** recurringDueState or dcaDueState, by the record's source. */
export function scheduledDueState(record: SessionRecord, status: SubscriptionStatus, now: number): RecurringDue {
  return record.source === DCA_SOURCE ? dcaDueState(record, status, now) : recurringDueState(record, status, now);
}

/**
 * The shared part of the due state: what RateLimitPolicy / GasPolicy say
 * (engine nextPullAllowedAt), for `total` operations in all.
 */
function dueFromChainState(state: SubscriptionChainState, total: number, now: number): RecurringDue {
  const sent = Math.max(0, total - state.remainingPulls);
  const next = nextPullAllowedAt(state, now);
  switch (next.kind) {
    case 'inactive':
      return { kind: 'inactive' };
    case 'used-up':
      return { kind: 'completed', reason: 'all-sent', sent, total, feeBudgetLeftWei: state.feeBudgetLeftWei };
    case 'ended':
      return { kind: 'completed', reason: 'ended', sent, total, feeBudgetLeftWei: state.feeBudgetLeftWei };
    case 'later':
      return { kind: 'later', at: next.at, remaining: state.remainingPulls, sent, total, feeBudgetLeftWei: state.feeBudgetLeftWei };
    case 'now':
      return {
        kind: 'due',
        since: next.at,
        openSlots: Math.max(1, openSlotCount(state, now)),
        remaining: state.remainingPulls,
        sent,
        total,
        feeBudgetLeftWei: state.feeBudgetLeftWei,
      };
  }
}

/**
 * Status lines for a recurring-payment card. `shownStatus` is the session
 * status line the card already shows above these lines (sessions.ts
 * sessionStatusText); when the due state is 'unknown' for the same reason,
 * its line is not repeated (finding 1 of the 2026-10-09 rehearsal: the card
 * showed "Status unknown: …" twice).
 */
export function recurringStatusLines(
  record: SessionRecord,
  due: RecurringDue,
  nativeSymbol: string,
  shownStatus?: string | null,
): string[] {
  const lines: string[] = [];
  switch (due.kind) {
    case 'due':
      lines.push(
        due.openSlots > 1
          ? `${due.openSlots} payments due now (the first since ${formatUtc(due.since)}). ${due.openSlots - 1} ` +
              `${due.openSlots - 1 === 1 ? 'was' : 'were'} missed; your account allows them to be sent now, one at a time.`
          : `Payment due now (since ${formatUtc(due.since)}).`,
      );
      break;
    case 'later':
      lines.push(`Next payment: not before ${formatUtc(due.at)}.`);
      break;
    case 'completed':
      lines.push(
        due.reason === 'all-sent'
          ? `Completed: all ${due.total} payment${due.total === 1 ? ' was' : 's were'} sent.`
          : recurringEndedLine(record, due),
      );
      break;
    case 'inactive':
      lines.push('Not active on-chain (revoked or never installed).');
      return lines;
    case 'unknown': {
      const line = `Status unknown: ${due.reason}`;
      if (line !== shownStatus) lines.push(line);
      return lines;
    }
    case 'not-ready':
      lines.push(due.reason);
      return lines;
  }
  if (due.kind !== 'completed') lines.push(`${due.sent} of ${due.total} payment${due.total === 1 ? '' : 's'} sent.`);
  lines.push(`Fee budget left: ${formatBaseUnits(due.feeBudgetLeftWei, 18)} ${nativeSymbol}.`);
  return lines;
}

/**
 * The card line of a recurring payment whose end date passed: how many were
 * sent and, when some were not, how many (finding 5 of the 2026-10-09
 * rehearsal: "Completed: ended …; 2 of 3 payments were sent." hid the unsent
 * one). The date is the installed grant's end (recurringEndsAt).
 */
export function recurringEndedLine(record: SessionRecord, due: { sent: number; total: number }): string {
  const unsent = Math.max(0, due.total - due.sent);
  const head =
    `Ended ${formatUtc(recurringEndsAt(record))}: ${due.sent} of ${due.total} ` +
    `payment${due.total === 1 ? ' was' : 's were'} sent`;
  return unsent === 0 ? `${head}.` : `${head}; ${unsent} ${unsent === 1 ? 'was' : 'were'} not sent before the end date.`;
}

/** The headline above the list (and the banner's sentence) for `count` due payments, or null. */
export function recurringDueHeadline(count: number): string | null {
  if (count <= 0) return null;
  return (
    (count === 1 ? '1 recurring payment is due.' : `${count} recurring payments are due.`) +
    ' Each is sent only after you confirm it on the Sessions screen.'
  );
}

/**
 * The headline for due recurring payments and recurring swaps together
 * (the banner and the Sessions list): exactly recurringDueHeadline when no
 * swap is due.
 */
export function scheduledDueHeadline(payments: number, swaps: number): string | null {
  if (swaps <= 0) return recurringDueHeadline(payments);
  const swapPart = swaps === 1 ? '1 recurring swap' : `${swaps} recurring swaps`;
  if (payments <= 0) {
    return `${swapPart} ${swaps === 1 ? 'is' : 'are'} due. Each is sent only after you confirm it on the Sessions screen.`;
  }
  const payPart = payments === 1 ? '1 recurring payment' : `${payments} recurring payments`;
  return `${payPart} and ${swapPart} are due. Each is sent only after you confirm it on the Sessions screen.`;
}

/**
 * The recurring records of `owner` on `chain` that could pay: set-up
 * confirmed on-chain ('installed') and the payment key on this phone. The
 * single definition shared by findDueRecurringPayments and
 * readRecurringDueStates. Pure; no network, no key.
 */
export function recurringCandidates(records: readonly SessionRecord[], chain: string, owner: string): SessionRecord[] {
  return recurringRecords(records).filter(
    (r) => r.chain === chain && r.owner.toLowerCase() === owner.toLowerCase() && r.localStatus === 'installed' && r.keyHeld,
  );
}

/** The recurring-swap records of a session list (source 'dca' with valid terms). */
export function dcaRecords(records: readonly SessionRecord[]): SessionRecord[] {
  return records.filter((r) => r.source === DCA_SOURCE && r.dca);
}

/**
 * The recurring payments AND recurring swaps of `owner` on `chain` that
 * could be sent (same rule as recurringCandidates). Pure; no network, no key.
 */
export function scheduledCandidates(records: readonly SessionRecord[], chain: string, owner: string): SessionRecord[] {
  const swaps = dcaRecords(records).filter(
    (r) => r.chain === chain && r.owner.toLowerCase() === owner.toLowerCase() && r.localStatus === 'installed' && r.keyHeld,
  );
  return [...recurringCandidates(records, chain, owner), ...swaps];
}

/**
 * Whether this phone checks (the due banner) or reads for reminders (the
 * local reminders' status read) the recurring payments of the ACTIVE
 * account: only with a ready wallet, an EVM address, and an account that
 * can sign its own payments. Not for a watch-only account (the wallet holds
 * no key for it) and not for a multi-signature account (no single key of
 * this wallet signs for it; its operations are built on the Multisig
 * screen). When false, the callers make no network request at all.
 */
export function recurringChecksApplyTo(args: {
  status: string;
  owner: string | null;
  account: { watchOnly: boolean; multisig: boolean } | null;
}): boolean {
  return (
    args.status === 'ready' &&
    args.owner !== null &&
    args.account !== null &&
    !args.account.watchOnly &&
    !args.account.multisig
  );
}

/**
 * The due state of EVERY candidate (recurringCandidates) of `owner` on
 * `chain`, not only the due ones: used by the local reminders
 * (notifications.ts) to schedule the moment the next payment falls due.
 * READ-ONLY like findDueRecurringPayments (same candidates, same status
 * reads, no vault, no bundler); a status read that throws gives `due: null`
 * so the caller can leave an earlier reminder in place instead of guessing.
 * Nothing is read where session keys are not allowed (mainnet readiness).
 */
export async function readRecurringDueStates(args: {
  chain: string;
  owner: string;
  readStatus: (record: SessionRecord) => Promise<SubscriptionStatus>;
  store?: KeyValueStore;
  now?: number;
}): Promise<{ records: SessionRecord[]; states: { record: SessionRecord; due: RecurringDue | null }[] }> {
  if (!isFeatureAllowed('session-keys', args.chain)) return { records: [], states: [] };
  const load = args.store ? await loadSessions(args.store) : await loadSessions();
  // Recurring swaps (./dca.ts) are reminded like recurring payments.
  const candidates = scheduledCandidates(load.records, args.chain, args.owner);
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const states: { record: SessionRecord; due: RecurringDue | null }[] = [];
  for (const record of candidates) {
    try {
      states.push({ record, due: scheduledDueState(record, await args.readStatus(record), now) });
    } catch {
      states.push({ record, due: null });
    }
  }
  return { records: load.records, states };
}

/**
 * The foreground check: which recurring payments of `owner` on `chain` are
 * due now. READ-ONLY by construction: it loads the public session list,
 * keeps the recurring records that could pay (set-up confirmed, key on this
 * phone) and asks `readStatus` (read-only eth_calls in the app) for each.
 * It has no vault and no bundler, so it cannot read a key or send anything;
 * the user sends a due payment from the Sessions screen after confirming it.
 * With no such record it makes no network request at all, and nothing is
 * checked where session keys are not allowed (mainnet readiness).
 */
export async function findDueRecurringPayments(args: {
  chain: string;
  owner: string;
  readStatus: (record: SessionRecord) => Promise<SubscriptionStatus>;
  store?: KeyValueStore;
  now?: number;
}): Promise<{ due: { record: SessionRecord; due: Extract<RecurringDue, { kind: 'due' }> }[]; checked: number }> {
  if (!isFeatureAllowed('session-keys', args.chain)) return { due: [], checked: 0 };
  const load = args.store ? await loadSessions(args.store) : await loadSessions();
  // Recurring swaps (./dca.ts) are checked the same way: the same policies
  // and the same read-only status read; nothing here can sign or submit.
  const candidates = scheduledCandidates(load.records, args.chain, args.owner);
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const due: { record: SessionRecord; due: Extract<RecurringDue, { kind: 'due' }> }[] = [];
  for (const record of candidates) {
    let status: SubscriptionStatus;
    try {
      status = await args.readStatus(record);
    } catch {
      continue;
    }
    const state = scheduledDueState(record, status, now);
    if (state.kind === 'due') due.push({ record, due: state });
  }
  return { due, checked: candidates.length };
}

// ---------------------------------------------------------------------------
// Paying (only after the user's confirmation)
// ---------------------------------------------------------------------------

/** A payment checked against the chain and ready to be confirmed by the user. */
export interface RecurringPaymentPlan {
  record: SessionRecord;
  terms: SubscriptionGrant;
  /** The single transfer to send: the full amount per period to the payee. */
  call: Call;
  due: Extract<RecurringDue, { kind: 'due' }>;
}

export class RecurringNotDueError extends Error {
  readonly due: RecurringDue;
  constructor(message: string, due: RecurringDue) {
    super(message);
    this.name = 'RecurringNotDueError';
    this.due = due;
  }
}

export class RecurringSpendingError extends Error {
  readonly title: string;
  constructor(title: string, message: string) {
    super(message);
    this.name = 'RecurringSpendingError';
    this.title = title;
  }
}

function notDueMessage(record: SessionRecord, due: RecurringDue): string {
  switch (due.kind) {
    case 'later':
      return `This payment is not due yet: the next one can be sent from ${formatUtc(due.at)}. Nothing was sent.`;
    case 'completed':
      return due.reason === 'all-sent'
        ? 'Every payment of this recurring payment was already sent. Nothing was sent.'
        : `This recurring payment ended ${formatUtc(recurringEndsAt(record))}. Nothing was sent.`;
    case 'inactive':
      return 'This recurring payment is not active on-chain (it was revoked). Nothing was sent.';
    case 'unknown':
      return `Its on-chain status could not be read (${due.reason}), so nothing was sent.`;
    case 'not-ready':
      return `${due.reason} Nothing was sent.`;
    case 'due':
      return '';
  }
}

/**
 * The status read could not get an answer from the network endpoint (the
 * read returned 'unknown' with endpointFailure). Thrown by
 * planRecurringPayment and readStatusWithFailover so the read can be failed
 * over to another default endpoint, and described as a network failure,
 * never as a refusal.
 */
export class RecurringStatusUnreachableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`The on-chain status could not be read: ${reason}.`);
    this.name = 'RecurringStatusUnreachableError';
    this.reason = reason;
  }
}

/**
 * The local check of a payment's single call: one transfer, allowed by the
 * INSTALLED grant at `now` (engine assertCallsAllowed: target, value cap,
 * parameter rules and the grant's window). The installed grant is used, not
 * a grant rebuilt from the terms (engine assertSubscriptionPull), because a
 * recurring payment's grant ends one grace period after the terms
 * (recurringGrantFor): a payment sent during the grace period is allowed
 * on-chain and must not be refused here.
 */
function assertRecurringCall(record: SessionRecord, calls: Call[], now: number): void {
  if (calls.length !== 1) throw new Error(`A recurring payment is exactly one transfer; refusing ${calls.length} calls.`);
  assertCallsAllowed(parseSessionKeyGrant(record.grant), calls, now);
}

/**
 * Step 1 of a payment, BEFORE the confirmation: re-reads the on-chain state
 * (never trusting the card), refuses a payment that is not due, and builds
 * the single transfer (engine subscriptionPullCall, full amount), which is
 * checked locally against the installed grant (assertRecurringCall). Reads
 * no key and contacts no bundler. A read the endpoint did not answer throws
 * RecurringStatusUnreachableError (so the caller can fail over once and
 * describe it as a network failure).
 */
export async function planRecurringPayment(args: {
  node: JsonRpcTransport;
  record: SessionRecord;
  now?: number;
}): Promise<RecurringPaymentPlan> {
  const { record } = args;
  if (record.source !== RECURRING_SOURCE || !record.subscription) throw new Error('Not a recurring payment.');
  // Mainnet readiness: refused before any request where session keys are not allowed.
  assertFeatureAllowed('session-keys', record.chain);
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const status = await readSubscriptionStatus(args.node, record, now);
  if (status.kind === 'unknown' && status.endpointFailure) throw new RecurringStatusUnreachableError(status.reason);
  const due = recurringDueState(record, status, now);
  if (due.kind !== 'due') throw new RecurringNotDueError(notDueMessage(record, due), due);
  const terms = termsOf(record);
  const call = subscriptionPullCall(terms);
  assertRecurringCall(record, [call], now);
  return { record, terms, call, due };
}

/**
 * Runs a node operation through the caller's endpoint failover (the screen
 * and the banner pass config/networks.ts withEndpoint, i.e.
 * runWithEndpointFailover): `isFailure` says which errors may move the
 * operation ONCE to the next healthy default endpoint.
 */
export type NodeFailoverRunner = <T>(
  operation: (node: JsonRpcTransport) => Promise<T>,
  options: { isFailure: (error: unknown) => boolean },
) => Promise<T>;

/**
 * True for the errors a recurring payment's NODE work may fail over on: a
 * status read the endpoint did not answer (RecurringStatusUnreachableError)
 * and a transport failure of a marked node transport (sessions.ts
 * isNodeEndpointFailure). A bundler failure never qualifies: the bundler is
 * not an RPC endpoint the wallet can switch, and a submission that may have
 * reached it must never be repeated blindly.
 */
export function isRecurringNodeFailure(error: unknown): boolean {
  return error instanceof RecurringStatusUnreachableError || isNodeEndpointFailure(error);
}

/**
 * A status read under the failover rule (the phase 13 rule for session and
 * subscription quotes, applied to reads): the read's 'unknown' answer for an
 * endpoint that did not answer is turned into an error the runner fails over
 * on, so the read is repeated ONCE on the next healthy default endpoint.
 * When the runner cannot fail over (an override, no other healthy default,
 * or the second endpoint fails too), the last answer is returned as it is —
 * 'unknown' with the plain reason — never thrown.
 */
export async function readStatusWithFailover<S extends { kind: string; endpointFailure?: boolean }>(
  run: NodeFailoverRunner,
  read: (node: JsonRpcTransport) => Promise<S>,
): Promise<S> {
  const box: { last: S | null } = { last: null };
  try {
    return await run(
      async (node) => {
        const status = await read(node);
        box.last = status;
        if (status.kind === 'unknown' && status.endpointFailure) throw new RecurringStatusUnreachableError('unreachable');
        return status;
      },
      { isFailure: (e) => e instanceof RecurringStatusUnreachableError },
    );
  } catch (e) {
    if (box.last) return box.last;
    throw e;
  }
}

/**
 * The confirm-before-submit rule, in one place the Sessions screen uses for
 * every payment: plan (chain re-read; no key, no bundler) → `confirm` (the
 * dialog; resolves true only when the user tapped "Send payment") → `pay`.
 * `pay` is never called unless `confirm` resolved exactly true, and a plan
 * that fails never reaches the dialog. Nothing in the wallet sends a
 * recurring payment any other way (scripts/check-recurring.mjs pins it).
 */
export async function runRecurringPayment<T>(steps: {
  plan: () => Promise<RecurringPaymentPlan>;
  confirm: (plan: RecurringPaymentPlan) => Promise<boolean>;
  pay: (plan: RecurringPaymentPlan) => Promise<T>;
}): Promise<{ outcome: 'sent'; plan: RecurringPaymentPlan; result: T } | { outcome: 'cancelled'; plan: RecurringPaymentPlan }> {
  const plan = await steps.plan();
  const confirmed = await steps.confirm(plan);
  if (confirmed !== true) return { outcome: 'cancelled', plan };
  const result = await steps.pay(plan);
  return { outcome: 'sent', plan, result };
}

/** The confirmation dialog's message for a plan (exact amount, payee, signer, fee source, prompts). */
export function recurringConfirmMessage(
  plan: RecurringPaymentPlan,
  context: { nativeSymbol: string; payeeName?: string | null },
): string {
  const meta = plan.record.subscription!;
  const amount = `${formatBaseUnits(plan.terms.amountPerPeriod, meta.tokenDecimals)} ${meta.tokenSymbol}`;
  const payee = context.payeeName ? `${context.payeeName} (${plan.terms.merchant})` : plan.terms.merchant;
  const extra =
    plan.due.openSlots > 1 ? ` ${plan.due.openSlots} payments are due; this sends one of them.` : '';
  // Who signs is said once, by RECURRING_PAY_PROMPT_NOTE at the end (finding
  // 5 of the 2026-10-09 rehearsal: the dialog used to say it twice).
  return (
    `Send ${amount} to ${payee} from your smart account ${plan.record.account}.${extra} The network fee ` +
    'comes from your smart account and counts against the fee budget ' +
    `(${formatBaseUnits(plan.due.feeBudgetLeftWei, 18)} ${context.nativeSymbol} left). ${RECURRING_PAY_PROMPT_NOTE}`
  );
}

/**
 * Step 2, ONLY after the user confirmed the plan: the app-only spending
 * check, then the payment through sessions.ts sendSessionCalls (the payment
 * key alone signs; the vault read is the only secret read), then the
 * spending history. Order:
 *   1. the plan's single call is checked against the terms again (no
 *      network);
 *   2. spending limits (judgement, phase 15 item 1: a small addition, so
 *      recurring payments are not a way around the user's own limits):
 *      evaluateBeforeSigning on the transfer itself, without a simulation
 *      and with fee 0 (the fee budget caps fees on-chain). Unreadable limits
 *      FAIL CLOSED, as everywhere; a payment over a limit is NOT sent and
 *      no "send anyway" is offered for recurring payments;
 *   3. sendSessionCalls (readiness, local grant check, key read, sign,
 *      submit);
 *   4. recordAcceptedSpend once the bundler accepted the operation.
 */
export async function payRecurringPayment(args: {
  bundle: Parameters<typeof sendSessionCalls>[0]['bundle'];
  plan: RecurringPaymentPlan;
  vault: SessionKeyVault;
  store?: KeyValueStore;
  now?: number;
}): Promise<{ userOpHash: string; client: SmartAccountClient }> {
  const { plan } = args;
  const record = plan.record;
  if (record.source !== RECURRING_SOURCE) throw new Error('Not a recurring payment.');
  // Mainnet readiness first (sendSessionCalls checks again before the key is read).
  assertFeatureAllowed('session-keys', record.chain);
  const now = args.now ?? Math.floor(Date.now() / 1000);
  assertRecurringCall(record, [plan.call], now);
  const scope: SpendingScope = { chain: record.chain, owner: record.owner };
  const check = await evaluateBeforeSigning({
    scope,
    spender: record.account,
    calls: [plan.call],
    fee: 0n,
    now,
    ...(args.store ? { store: args.store } : {}),
  });
  if (check.status === 'unreadable') throw new RecurringSpendingError(check.title, `${check.message} Nothing was sent.`);
  if (check.status === 'blocked') {
    const lines = check.results.filter((r) => r.entry.exceeds).map((r) => overLimitSentence(r.policy, r.entry));
    throw new RecurringSpendingError(
      SPENDING_BLOCK_TITLE,
      [
        ...lines,
        SPENDING_HONESTY_SENTENCE,
        'Recurring payments are never sent over a limit. Raise or remove the limit in Settings → Spending ' +
          'limits (this app only), or revoke the recurring payment. Nothing was sent.',
      ].join('\n\n'),
    );
  }
  const sent = await sendSessionCalls({
    bundle: args.bundle,
    record,
    calls: [plan.call],
    vault: args.vault,
    now,
  });
  await recordAcceptedSpend({
    scope,
    spender: record.account,
    calls: [plan.call],
    fee: 0n,
    ref: sent.userOpHash,
    now,
    ...(args.store ? { store: args.store } : {}),
  });
  return sent;
}

// ---------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------

/** Kernel v3.3 / CallPolicy v0.0.4 custom errors a payment can hit (selectors computed, pinned in the check). */
const ERR = {
  callValue: toHex(abiSelector('CallViolatesValueRule()')),
  callParam: toHex(abiSelector('CallViolatesParamRule()')),
  policyFailed: toHex(abiSelector('PolicyFailed(uint256)')),
};

/** Policy order of a subscription-template permission (engine kernelPermissionFromGrant). */
const POLICY_MEANING = [
  'the payment is not one this recurring payment allows (recipient, token or amount)',
  'the recurring payment is outside its dates',
  'the fee budget is used up',
  'every payment this recurring payment allows was already sent, or the next one is not due yet',
];

export const RECURRING_REFUSED_TITLE = 'Payment not sent';
export const RECURRING_OUTCOME_UNKNOWN_TITLE = 'Payment status unknown';

/**
 * What happened to a payment attempt (finding 1 of the 2026-10-09
 * recurring-payments rehearsal: a DNS failure was shown as the raw platform
 * exception and labelled "refused").
 */
export type RecurringAttemptOutcome =
  /** The wallet or the account refused it (not due, a spending limit, AA22, a policy). Nothing was paid. */
  | 'refused'
  /** The network endpoint or the bundler could not be reached BEFORE the payment was submitted. Nothing was sent. */
  | 'not-sent'
  /** The connection failed in a way that leaves open whether the bundler received the signed payment. */
  | 'outcome-unknown'
  /** Any other failure, in the session wording. */
  | 'failed';

/**
 * After a transport failure on the node (the status read, the chain check,
 * the fees, the nonce) or on a bundler request made before the submission.
 * Exact because every such request precedes eth_sendUserOperation (sessions.ts
 * sendSessionCalls and the engine's SmartAccountClient.sendCalls submit last),
 * and RateLimitPolicy counts only operations that execute.
 */
export const RECURRING_NOT_SENT_SENTENCE =
  'The payment was not handed to the bundler, so nothing was sent and none of the allowed payments was used ' +
  'up. Try again once the connection is back.';

/**
 * The bundler did not answer eth_sendUserOperation within the engine's
 * BROADCAST_TIMEOUT_MS (phase 23 item 8): the payment may or may not have
 * reached it. Never worded as "not sent"; the operation is also listed
 * under Pending on this phone.
 */
export const RECURRING_NO_ANSWER_SENTENCE =
  `The bundler did not answer within ${Math.round(BROADCAST_TIMEOUT_MS / 1000)} seconds, so this wallet does ` +
  'not know whether it received the payment. The account’s nonce for this payment key decides: if the bundler ' +
  'received the payment, it will be included and this card will count it as sent; if not, nothing was paid. ' +
  'Wait a minute, then tap Refresh status before sending again: if the first one went through, sending again ' +
  'would pay the next due payment as well. It is also listed under Pending on this phone in Activity.';

/**
 * After a transport failure during the submission itself (or one the wallet
 * cannot place): the bundler may have received the signed payment.
 */
export const RECURRING_OUTCOME_UNKNOWN_SENTENCE =
  'The connection failed while the payment was being sent, so this wallet cannot tell whether the bundler ' +
  'received it. The account’s nonce for this payment key decides: if the bundler received the payment, it ' +
  'will be included and this card will count it as sent; if not, nothing was paid. Wait a minute, then tap ' +
  'Refresh status before sending again: if the first one went through, sending again would pay the next due ' +
  'payment as well.';

/** The technical detail of a status read the endpoint did not answer (the parenthesis unknownStatusFrom adds). */
function unreachableTechnical(reason: string): string {
  const m = /\((.+)\)$/.exec(reason);
  return m ? `${m[1]}.` : '';
}

/**
 * The plain sentence for an account/bundler refusal of a payment, or null
 * when the message is not one of the known refusals. The bundler's own text
 * is kept as the technical detail (endpoint links removed).
 */
export function recurringRefusalSentence(message: string): string | null {
  const m = message.toLowerCase();
  if (/aa22 expired or not due/.test(m)) {
    return 'Your account refused this payment: it is not due yet, or the recurring payment has ended. Nothing was paid.';
  }
  if (m.includes(ERR.callValue)) return 'Your account refused this payment: the amount is above the cap per payment. Nothing was paid.';
  if (m.includes(ERR.callParam)) {
    return 'Your account refused this payment: the recipient or the amount is outside the terms. Nothing was paid.';
  }
  const policy = new RegExp(`${ERR.policyFailed}([0-9a-f]{64})`).exec(m);
  if (policy) {
    const index = Number(BigInt(`0x${policy[1]}`));
    return `Your account refused this payment: ${POLICY_MEANING[index] ?? `policy ${index} refused it`}. Nothing was paid.`;
  }
  if (/aa23 reverted 0x(?![0-9a-f])/.test(m)) {
    return 'Your account refused this payment: the permission is not installed any more (it was revoked). Nothing was paid.';
  }
  if (/aa21 didn.t pay prefund/.test(m)) {
    return 'Your smart account cannot pay this payment’s network fee. Fund the smart account, then try again. Nothing was paid.';
  }
  return null;
}

/**
 * Every error of the payment steps in plain words, with what happened to
 * the payment (`outcome`). Never a raw platform exception: a transport
 * failure is described by the shared no-answer sentence plus what it means
 * for the payment, with the cleaned text (sanitizeEndpointMessage, which
 * removes Java exception class names and links) as the technical detail.
 * In order:
 *  - not due / spending limits: their own words ('refused');
 *  - no answer to the submission within the engine's BROADCAST_TIMEOUT_MS
 *    (phase 23 item 8): 'outcome-unknown' (RECURRING_NO_ANSWER_SENTENCE);
 *  - a status read the endpoint did not answer, a NODE transport failure,
 *    or a bundler transport failure before the submission: 'not-sent'
 *    (never "refused");
 *  - any other transport failure — during eth_sendUserOperation, or one the
 *    wallet cannot place — 'outcome-unknown': the nonce decides;
 *  - the account's own refusals (recurringRefusalSentence, with the
 *    bundler's text kept as the technical detail): 'refused';
 *  - else the session wording (sessions.ts describeSessionError): 'failed'.
 */
export function describeRecurringPaymentError(
  error: unknown,
  context: { accountType: AaAccountType; symbol: string },
  describeSend: (error: unknown, symbol: string) => { title: string; detail: string },
): { title: string; detail: string; outcome: RecurringAttemptOutcome } {
  if (error instanceof RecurringNotDueError) {
    // A status that could not be read for another reason (not an endpoint
    // failure) is not a refusal either.
    return { title: RECURRING_REFUSED_TITLE, detail: error.message, outcome: error.due.kind === 'unknown' ? 'failed' : 'refused' };
  }
  if (error instanceof RecurringSpendingError) return { title: error.title, detail: error.message, outcome: 'refused' };
  const withTechnical = (sentence: string, technical: string) =>
    technical ? `${sentence}\n\nTechnical detail: ${technical}` : sentence;
  if (error instanceof RecurringStatusUnreachableError) {
    return {
      title: SESSION_UNREACHABLE_TITLE,
      detail: withTechnical(`${NO_ANSWER_SENTENCE} ${RECURRING_NOT_SENT_SENTENCE}`, unreachableTechnical(error.reason)),
      outcome: 'not-sent',
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  // No answer to the submission itself in time (phase 23 item 8): checked
  // first, because the outcome is open whatever else the error says.
  if (isBroadcastOutcomeUnknown(error)) {
    const technical = (error as { technical?: unknown }).technical;
    return {
      title: RECURRING_OUTCOME_UNKNOWN_TITLE,
      detail: withTechnical(RECURRING_NO_ANSWER_SENTENCE, sanitizeEndpointMessage(typeof technical === 'string' ? technical : message)),
      outcome: 'outcome-unknown',
    };
  }
  if (isTransportFailure(error)) {
    const technical = sanitizeEndpointMessage(message);
    if (isNodeEndpointFailure(error) || isBundlerTransportFailureBeforeSubmit(error)) {
      return {
        title: SESSION_UNREACHABLE_TITLE,
        detail: withTechnical(`${NO_ANSWER_SENTENCE} ${RECURRING_NOT_SENT_SENTENCE}`, technical),
        outcome: 'not-sent',
      };
    }
    return {
      title: RECURRING_OUTCOME_UNKNOWN_TITLE,
      detail: withTechnical(RECURRING_OUTCOME_UNKNOWN_SENTENCE, technical),
      outcome: 'outcome-unknown',
    };
  }
  const refusal = recurringRefusalSentence(message);
  if (refusal) {
    return { title: RECURRING_REFUSED_TITLE, detail: withTechnical(refusal, sanitizeEndpointMessage(message)), outcome: 'refused' };
  }
  return {
    ...describeSessionError(error, { accountType: context.accountType, symbol: context.symbol, stage: 'send' }, describeSend),
    outcome: 'failed',
  };
}

/**
 * The card's one-line note after a payment attempt that did not go through
 * (the card stays). Only an actual refusal is called "refused".
 */
export function recurringAttemptLine(outcome: RecurringAttemptOutcome, detail: string): string {
  const first = detail.split('\n\n')[0];
  switch (outcome) {
    case 'refused':
      return `Last payment attempt refused: ${first}`;
    case 'not-sent':
      return 'Last payment attempt not sent: the network could not be reached before the payment was handed to the ' +
        'bundler, so nothing was sent. Try again once the connection is back.';
    case 'outcome-unknown':
      return 'Last payment attempt: outcome unknown (the connection failed while it was being sent). Tap Refresh ' +
        'status and wait for the count before sending again.';
    case 'failed':
      return `Last payment attempt failed: ${first}`;
  }
}

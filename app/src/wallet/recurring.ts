import {
  assertSubscriptionPull,
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
  describeSessionError,
  loadSessions,
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
import { sanitizeEndpointMessage } from '../config/endpoint-probe.ts';

/**
 * Recurring payments pushed by this phone (phase 15 item 1; the slice
 * recommended in docs/SCHEDULED_PAYMENTS.md section 5.1): "pay X every N to Y".
 *
 * THE GRANT. Exactly the subscription template (engine kernel-subscription:
 * one allowed call — a transfer of at most X to Y — plus TimestampPolicy,
 * a mandatory GasPolicy fee budget and RateLimitPolicy {interval = period,
 * count = payments, startAt = the moment Start was tapped}), produced by the
 * same function the subscription form uses (recurringGrantFor ==
 * subscriptionGrantFor). Only the roles change: the payee is the
 * "merchant", and the session key is generated on this phone, stored in the
 * same secure vault as every session key and NEVER handed over
 * (sessions.ts installSession / releaseSessionKey and subscriptions.ts
 * buildSubscriptionKeyExport refuse it).
 *
 * WHO SENDS. This app, and only while it is open: React Native in Expo Go
 * has no reliable background execution, so nothing is scheduled. When the
 * wallet comes to the foreground (components/RecurringDueBanner) or the
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
 * LATER SLICE (not built, deliberately): sending while the app is closed
 * needs background execution (expo-background-task / expo-task-manager) or
 * notifications (expo-notifications), which need a development build, an
 * OS-scheduled task whose timing the OS decides, and a product decision on
 * how a payment may be sent without the user present (today every payment
 * follows a confirmation). See RECURRING_LATER_SLICE_NOTE.
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

/** The short form of RECURRING_WHILE_OPEN_NOTE on every card. */
export const RECURRING_CARD_NOTE =
  'Sent only while this wallet is open, and only after you confirm each payment. Nothing runs in the background.';

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

/** Why nothing runs in the background (form note; the module header has the detail). */
export const RECURRING_LATER_SLICE_NOTE =
  'Sending while the wallet is closed would need a background task or notifications, which need a ' +
  'development build of the app and a decision on whether a payment may ever go out without you ' +
  'confirming it. This version always asks you first.';

export function recurringFeeBudgetHint(nativeSymbol: string): string {
  return (
    `Each payment’s network fee is paid by your smart account in ${nativeSymbol}. The budget caps the ` +
    'total on-chain, including what anyone holding the payment key could spend on fees.'
  );
}

export const RECURRING_COMPLETED_TEXT =
  'Completed: no more payments can be sent. Revoke it to remove the permission from your account (the ' +
  'payment key is deleted from this phone too); it is then forgotten here.';

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
 * (scripts/check-recurring.mjs compares them field by field).
 */
export function recurringGrantFor(
  sub: SubscriptionGrant,
  sessionKey: string,
  context: { account: string; now: number },
): SessionKeyGrant {
  return subscriptionGrantFor(sub, sessionKey, context);
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

/** The plain-language review of a recurring payment (own wording; the facts are the subscription module's). */
export function recurringReview(
  sub: SubscriptionGrant,
  context: { tokenSymbol: string; tokenDecimals: number; nativeSymbol: string; payeeName?: string | null },
): RecurringDescription {
  const payee = context.payeeName ? `${context.payeeName} (${sub.merchant})` : sub.merchant;
  const amount = `${formatBaseUnits(sub.amountPerPeriod, context.tokenDecimals)} ${context.tokenSymbol}`;
  const period = describePeriod(sub.periodSeconds);
  const count = subscriptionPeriodCount(sub);
  const fee = `${formatBaseUnits(sub.feeBudgetWei, 18)} ${context.nativeSymbol}`;
  const sentence =
    `Pays ${payee} up to ${amount} every ${period} until ${formatUtc(sub.validUntil)}: at most one payment ` +
    'per period, each sent by this wallet after you confirm it.';
  const enforced = [
    isNativeSubscription(sub)
      ? `Only plain ${context.tokenSymbol} transfers to ${sub.merchant}, at most ${amount} each.`
      : `Only ${context.tokenSymbol} (contract ${sub.token}) transfers to ${sub.merchant}, at most ${amount} each.`,
    `At most ${count} payment${count === 1 ? '' : 's'} in total: the first from ${formatUtc(sub.startAt)}, ` +
      `then one more every ${period}.`,
    `Nothing after ${formatUtc(sub.validUntil)}.`,
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
      'later, even right before the next one, until the end date.',
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
 */
export function recurringShortWindowWarning(sub: Pick<SubscriptionGrant, 'startAt' | 'validUntil' | 'periodSeconds'>): string | null {
  const total = sub.validUntil - sub.startAt;
  if (!(total < 600)) return null;
  const count = subscriptionPeriodCount(sub);
  return (
    `These terms last only ${describePeriod(total)} in total (${count} payment${count === 1 ? '' : 's'} of ` +
    `${describePeriod(sub.periodSeconds)}). Payments are sent only while the wallet is open and after you ` +
    'confirm each one, so some may not be sent before the end date. Choose a longer period or more payments ' +
    'unless this is a quick test.'
  );
}

/** The success screen's line with the dates the set-up actually carries. */
export function recurringFinalDatesLine(sub: SubscriptionGrant): string {
  const count = subscriptionPeriodCount(sub);
  return (
    `Final terms: the first payment is due from ${formatUtc(sub.startAt)}, then one more every ` +
    `${describePeriod(sub.periodSeconds)} (${count} in total); nothing after ${formatUtc(sub.validUntil)}.`
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
  const total = subscriptionPeriodCount(termsOf(record));
  const state = status.state;
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

/** recurringDueState at the current time (for render code, which must not read the clock itself). */
export function recurringDueStateNow(record: SessionRecord, status: SubscriptionStatus): RecurringDue {
  return recurringDueState(record, status, Math.floor(Date.now() / 1000));
}

/** Status lines for a recurring-payment card. */
export function recurringStatusLines(record: SessionRecord, due: RecurringDue, nativeSymbol: string): string[] {
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
          : `Completed: ended ${formatUtc(termsOf(record).validUntil)}; ${due.sent} of ${due.total} ` +
              `payment${due.total === 1 ? ' was' : 's were'} sent.`,
      );
      break;
    case 'inactive':
      lines.push('Not active on-chain (revoked or never installed).');
      return lines;
    case 'unknown':
      lines.push(`Status unknown: ${due.reason}`);
      return lines;
    case 'not-ready':
      lines.push(due.reason);
      return lines;
  }
  if (due.kind !== 'completed') lines.push(`${due.sent} of ${due.total} payment${due.total === 1 ? '' : 's'} sent.`);
  lines.push(`Fee budget left: ${formatBaseUnits(due.feeBudgetLeftWei, 18)} ${nativeSymbol}.`);
  return lines;
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
  const candidates = recurringRecords(load.records).filter(
    (r) => r.chain === args.chain && r.owner.toLowerCase() === args.owner.toLowerCase() && r.localStatus === 'installed' && r.keyHeld,
  );
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const due: { record: SessionRecord; due: Extract<RecurringDue, { kind: 'due' }> }[] = [];
  for (const record of candidates) {
    let status: SubscriptionStatus;
    try {
      status = await args.readStatus(record);
    } catch {
      continue;
    }
    const state = recurringDueState(record, status, now);
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
        : `This recurring payment ended ${formatUtc(termsOf(record).validUntil)}. Nothing was sent.`;
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
 * Step 1 of a payment, BEFORE the confirmation: re-reads the on-chain state
 * (never trusting the card), refuses a payment that is not due, and builds
 * the single transfer (engine subscriptionPullCall, full amount), which is
 * checked locally against the terms (engine assertSubscriptionPull: exactly
 * one call, within the grant). Reads no key and contacts no bundler.
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
  const due = recurringDueState(record, status, now);
  if (due.kind !== 'due') throw new RecurringNotDueError(notDueMessage(record, due), due);
  const terms = termsOf(record);
  const call = subscriptionPullCall(terms);
  assertSubscriptionPull(terms, parseSessionKeyGrant(record.grant).sessionKey, [call], now);
  return { record, terms, call, due };
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
  return (
    `Send ${amount} to ${payee} from your smart account ${plan.record.account}.${extra} This recurring ` +
    'payment’s own key signs it, not your account key. The network fee comes from your smart account ' +
    `and counts against the fee budget (${formatBaseUnits(plan.due.feeBudgetLeftWei, 18)} ` +
    `${context.nativeSymbol} left). ${RECURRING_PAY_PROMPT_NOTE}`
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
  assertSubscriptionPull(plan.terms, parseSessionKeyGrant(record.grant).sessionKey, [plan.call], now);
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

export const RECURRING_REFUSED_TITLE = 'Payment not sent';

/**
 * Every error of the payment steps in plain words: not due, spending limits,
 * the account's own refusals (recurringRefusalSentence, with the bundler's
 * text kept as the technical detail), else the session wording
 * (sessions.ts describeSessionError, which keeps bundler texts verbatim and
 * never shows a raw platform exception).
 */
export function describeRecurringPaymentError(
  error: unknown,
  context: { accountType: AaAccountType; symbol: string },
  describeSend: (error: unknown, symbol: string) => { title: string; detail: string },
): { title: string; detail: string } {
  if (error instanceof RecurringNotDueError) return { title: RECURRING_REFUSED_TITLE, detail: error.message };
  if (error instanceof RecurringSpendingError) return { title: error.title, detail: error.message };
  const message = error instanceof Error ? error.message : String(error);
  const refusal = recurringRefusalSentence(message);
  if (refusal) {
    const technical = sanitizeEndpointMessage(message);
    return { title: RECURRING_REFUSED_TITLE, detail: technical ? `${refusal}\n\nTechnical detail: ${technical}` : refusal };
  }
  return describeSessionError(error, { accountType: context.accountType, symbol: context.symbol, stage: 'send' }, describeSend);
}

/** The card's one-line reason after a refused payment (the card stays). */
export function recurringRefusalLine(detail: string): string {
  return `Last payment attempt refused: ${detail.split('\n\n')[0]}`;
}


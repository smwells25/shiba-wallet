import {
  ENTRYPOINT_V07,
  KERNEL_PERMISSION_MODULES,
  NodeClient,
  SUBSCRIPTION_MIN_PERIOD_SECONDS,
  SUBSCRIPTION_NATIVE,
  describePeriod,
  describeSubscription,
  isNativeSubscription,
  nextPullAllowedAt,
  parseSessionKeyGrant,
  parseSubscription,
  readSubscriptionState,
  serializeSubscription,
  sessionNonceKey,
  subscriptionPeriodCount,
  subscriptionToGrant,
  type JsonRpcTransport,
  type NextPull,
  type SessionKeyGrant,
  type SubscriptionChainState,
  type SubscriptionDescription,
  type SubscriptionGrant,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by
// scripts/check-subscriptions.mjs under Node's type stripping.
import { formatUnits, parseUnits } from './balances.ts';
import { EVM_CHAIN_ID, validateRecipient } from './send.ts';
import { knownTokensForChain, listTokens, type KeyValueStore } from './tokens.ts';
import { aaCanPaySelf, aaFeeFromBalance, fetchTokenBalanceVia, type AaSendQuote } from './aa.ts';
import {
  eip155Decimal,
  releaseSessionKey,
  sessionVaultId,
  unknownStatusFrom,
  type SessionChainStatus,
  type SessionKeyVault,
  type SessionRecord,
  type SessionSubscriptionMeta,
} from './sessions.ts';
import { suggestFeesRetryingOnce } from './fee-read.ts';

/**
 * Subscriptions (phase 12 item 2, app half): a grant TEMPLATE on the
 * Sessions screen, on the engine's kernel-subscription.ts. A subscription is
 * an ordinary session (./sessions.ts) whose single allowed call pays one
 * merchant at most X of one token (or the native currency), with a rate limit
 * of one operation per period, a fee budget and an expiry, all enforced by
 * the subscriber's Kernel account on-chain. It is installed through the SAME
 * explicit, owner-signed path as any session (prepareSessionInstall →
 * installSession → the normal confirm with the biometric gate), and revoked
 * the same way.
 *
 * WHO HOLDS THE KEY. The session key is generated on this device and kept in
 * the secure vault only until the subscriber hands it to the merchant: the
 * key is shown ONCE (QR and text, buildSubscriptionKeyExport) and, when the
 * subscriber confirms the hand-over, deleted from the device
 * (markSubscriptionKeyExported → releaseSessionKey). After that the wallet
 * can no longer pull — only revoke. This mirrors the ERC-7715 pattern, where
 * the dApp holds its session key and the wallet keeps the public grant.
 *
 * WHAT IS AND IS NOT ENFORCED: see the engine's module header. The review
 * always shows the engine's caveats, first among them that one pull can hold
 * several transfers (the account checks each transfer against the cap but
 * cannot refuse a batch), so the per-period amount is NOT a hard on-chain
 * total.
 */

/** The testing-only preset period (offered on test networks only, subscriptionPeriodPresets). */
export const SUBSCRIPTION_TEST_PERIOD_SECONDS = 120;

/** Every period preset; the screen offers subscriptionPeriodPresets(testnet), which drops the testing one off test networks. */
export const SUBSCRIPTION_PERIOD_PRESETS: readonly { label: string; seconds: number }[] = [
  { label: '2 minutes (testing)', seconds: SUBSCRIPTION_TEST_PERIOD_SECONDS },
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 7 * 86400 },
  { label: '30 days', seconds: 30 * 86400 },
];

/** The presets the form offers on this network: "2 minutes (testing)" only on a test network. */
export function subscriptionPeriodPresets(testnet: boolean): readonly { label: string; seconds: number }[] {
  return testnet ? SUBSCRIPTION_PERIOD_PRESETS : SUBSCRIPTION_PERIOD_PRESETS.filter((p) => p.seconds !== SUBSCRIPTION_TEST_PERIOD_SECONDS);
}

/** Units of the custom period field. */
export const SUBSCRIPTION_PERIOD_UNITS: readonly { label: string; seconds: number }[] = [
  { label: 'minutes', seconds: 60 },
  { label: 'hours', seconds: 3600 },
  { label: 'days', seconds: 86400 },
];

/**
 * Longest period the form accepts: 365 days. A wallet policy (a judgement,
 * not a standard): the engine only requires the period to fit in a uint48,
 * but a subscription that pays less than once a year is better granted
 * again when it is due.
 */
export const SUBSCRIPTION_MAX_PERIOD_SECONDS = 365 * 86400;

/**
 * Shortest period the form accepts. On a test network it is the engine's
 * own minimum (SUBSCRIPTION_MIN_PERIOD_SECONDS, 60 s — the live run used
 * 120 s periods); elsewhere one hour, because short periods exist only for
 * testing (the same rule that keeps the "2 minutes (testing)" preset off
 * other networks). Subscriptions are test-network-only today anyway
 * (config/readiness.ts session-keys row).
 */
export function subscriptionMinPeriodSeconds(testnet: boolean): number {
  return testnet ? SUBSCRIPTION_MIN_PERIOD_SECONDS : 3600;
}

/** Bounds of a period in seconds, with the form's plain sentences. Whole minutes only. */
export function checkSubscriptionPeriod(seconds: number, testnet: boolean): string | null {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds % 60 !== 0) return 'Choose a period.';
  const min = subscriptionMinPeriodSeconds(testnet);
  if (seconds < min || seconds > SUBSCRIPTION_MAX_PERIOD_SECONDS) {
    return `Period: from ${describePeriod(min)} to ${describePeriod(SUBSCRIPTION_MAX_PERIOD_SECONDS)}.`;
  }
  return null;
}

/**
 * The custom period field: a whole number of minutes, hours or days.
 * Returns the seconds, or the sentence to show under the field.
 */
export function customPeriodSeconds(
  countText: string,
  unitSeconds: number,
  testnet: boolean,
): { ok: true; seconds: number } | { ok: false; error: string } {
  const text = countText.trim();
  if (!SUBSCRIPTION_PERIOD_UNITS.some((u) => u.seconds === unitSeconds)) return { ok: false, error: 'Choose a unit.' };
  if (!/^[0-9]{1,6}$/.test(text) || Number(text) < 1) {
    return { ok: false, error: 'Custom period: enter a whole number (1 or more).' };
  }
  const seconds = Number(text) * unitSeconds;
  const problem = checkSubscriptionPeriod(seconds, testnet);
  return problem ? { ok: false, error: problem } : { ok: true, seconds };
}

/**
 * Below this total length (period × payments, in seconds) the review warns:
 * the key hand-over and the merchant's first pull happen inside the first
 * period, so on very short terms some payments can never be taken (the
 * 2 min × 2 test of 2026-10-04 expired before a hand-over and a pull were
 * possible). Ten minutes is a judgement, not a measured bound.
 */
export const SUBSCRIPTION_SHORT_WINDOW_SECONDS = 600;

/** The review's warning for terms shorter than SUBSCRIPTION_SHORT_WINDOW_SECONDS, else null. */
export function subscriptionShortWindowWarning(sub: Pick<SubscriptionGrant, 'startAt' | 'validUntil' | 'periodSeconds'>): string | null {
  const total = sub.validUntil - sub.startAt;
  if (!(total < SUBSCRIPTION_SHORT_WINDOW_SECONDS)) return null;
  const payments = subscriptionPeriodCount(sub);
  return (
    `These terms last only ${describePeriod(total)} in total (${payments} payment${payments === 1 ? '' : 's'} ` +
    `of ${describePeriod(sub.periodSeconds)}). Handing the key to the merchant and the merchant's first pull ` +
    'happen inside the first period, so some payments may never be taken. Choose a longer period or more payments ' +
    'unless this is a quick test.'
  );
}

/** Most payments one subscription may allow from the form (the engine allows more). */
export const SUBSCRIPTION_MAX_PAYMENTS = 120;

/**
 * Gas units budgeted per pull for the default fee budget. Measured on Sepolia
 * on 2026-10-03 (subscription-keeper.mjs live run through ZeroDev's bundler):
 * the three native pulls were signed with preVerificationGas +
 * verificationGasLimit + callGasLimit — what GasPolicy charges — of 367,706,
 * 302,094 and 302,094 gas (keeper padding included). An ERC-20 pull adds the
 * token transfer and two parameter checks (not measured live), so the default
 * rounds up to 500,000. A default, shown and editable, not a guarantee.
 */
export const SUBSCRIPTION_PULL_GAS_ALLOWANCE = 500_000n;

export const SUBSCRIPTION_KEY_EXPORT_TYPE = 'shiba-wallet:subscription-key';

export const SUBSCRIPTION_KEY_WARNING =
  'This is the subscription key. Whoever holds it can take payments from your account within the ' +
  'limits above until you revoke or it expires. Give it only to the merchant, over a channel you trust. ' +
  'It is shown once: after you confirm the hand-over it is deleted from this device.';

export const SUBSCRIPTION_AUDIT_NOTE =
  'Subscriptions use ZeroDev’s ECDSASigner, CallPolicy v0.0.4, TimestampPolicy, GasPolicy and ' +
  'RateLimitPolicy. No published security audit names these modules, so treat subscriptions as ' +
  'experimental with real funds.';

/** A token the form offers: the native currency, or a known ERC-20 on the active chain. */
export interface SubscriptionTokenChoice {
  /** SUBSCRIPTION_NATIVE or the ERC-20 address. */
  token: string;
  symbol: string;
  decimals: number;
}

/** Native first, then the chain's known tokens (tokens.ts: Circle-documented and on-chain checked). */
export function subscriptionTokenChoices(chainCaip2: string, nativeSymbol: string): SubscriptionTokenChoice[] {
  return [
    { token: SUBSCRIPTION_NATIVE, symbol: nativeSymbol, decimals: 18 },
    ...knownTokensForChain(chainCaip2).map((t) => ({ token: t.assetId.reference, symbol: t.symbol, decimals: t.decimals })),
  ];
}

/**
 * The form's full list: subscriptionTokenChoices (native, then the known
 * tokens) followed by the user's tracked tokens on the SAME chain
 * (tokens.ts listTokens(chainCaip2), whose decimals were read from the chain
 * when the token was added) that are not already in it. The prefix is
 * exactly subscriptionTokenChoices, so an index chosen before this list
 * loaded still names the same token afterwards. Duplicates are matched on
 * the contract address, case-insensitively; a tracked token that is not an
 * ERC-20 on this chain never appears (listTokens filters by chain). An
 * unreadable token store degrades to the synchronous list.
 */
export async function loadSubscriptionTokenChoices(
  chainCaip2: string,
  nativeSymbol: string,
  store?: KeyValueStore,
): Promise<SubscriptionTokenChoice[]> {
  const base = subscriptionTokenChoices(chainCaip2, nativeSymbol);
  let tracked: Awaited<ReturnType<typeof listTokens>> = [];
  try {
    tracked = await listTokens(chainCaip2, store);
  } catch {
    return base;
  }
  const seen = new Set(base.map((c) => c.token.toLowerCase()));
  const extra: SubscriptionTokenChoice[] = [];
  for (const t of tracked) {
    if (t.assetId.chainId !== chainCaip2) continue;
    const address = t.assetId.reference;
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    extra.push({ token: address, symbol: t.symbol, decimals: t.decimals });
  }
  return [...base, ...extra];
}

/**
 * Default fee budget: payments × SUBSCRIPTION_PULL_GAS_ALLOWANCE × the
 * node's current maxFeePerGas × 2 (fees move). GasPolicy refuses a pull
 * that would exceed what is left, so the merchant then needs a new grant.
 */
export function defaultFeeBudgetWei(payments: number, maxFeePerGas: bigint): bigint {
  return BigInt(payments) * SUBSCRIPTION_PULL_GAS_ALLOWANCE * maxFeePerGas * 2n;
}

export interface SubscriptionDraft {
  merchant: string;
  /** One of subscriptionTokenChoices(). */
  choice: SubscriptionTokenChoice;
  /** Decimal amount per period in the token's units. */
  amount: string;
  periodSeconds: number;
  /** How many payments (periods) the grant covers. */
  payments: string;
  /** Total fee budget in the native currency (decimal). */
  feeBudget: string;
  label: string;
}

/**
 * Form → SubscriptionGrant. Input errors get plain messages; the engine's
 * validateSubscription then checks everything else and its text is shown
 * verbatim. `context.testnet` decides the period bounds (checkSubscriptionPeriod;
 * absent counts as not a test network, the stricter side). The first period
 * starts at `context.now`. The Sessions screen
 * calls this when Review opens and then moves the start to the moment the
 * user taps Start (restartSubscriptionAt), so the time spent reading the
 * review does not eat into the subscription's window.
 */
export function buildSubscription(
  draft: SubscriptionDraft,
  context: { now: number; account?: string; testnet?: boolean },
): SubscriptionGrant {
  const merchant = validateRecipient(EVM_CHAIN_ID, draft.merchant);
  if (!merchant.ok) throw new Error(`Merchant: ${merchant.error}`);
  let amountPerPeriod: bigint;
  try {
    amountPerPeriod = parseUnits(draft.amount, draft.choice.decimals);
  } catch (e) {
    throw new Error(`Amount: ${(e as Error).message}`);
  }
  if (amountPerPeriod <= 0n) throw new Error('Amount: enter more than zero.');
  const periodProblem = checkSubscriptionPeriod(draft.periodSeconds, context.testnet === true);
  if (periodProblem) throw new Error(periodProblem);
  const payments = Number(draft.payments.trim());
  if (!Number.isInteger(payments) || payments < 1 || payments > SUBSCRIPTION_MAX_PAYMENTS) {
    throw new Error(`Number of payments: a whole number from 1 to ${SUBSCRIPTION_MAX_PAYMENTS}.`);
  }
  let feeBudgetWei: bigint;
  try {
    feeBudgetWei = parseUnits(draft.feeBudget, 18);
  } catch (e) {
    throw new Error(`Fee budget: ${(e as Error).message}`);
  }
  const sub: SubscriptionGrant = {
    merchant: merchant.normalized,
    token: draft.choice.token,
    amountPerPeriod,
    periodSeconds: draft.periodSeconds,
    startAt: context.now,
    validUntil: context.now + payments * draft.periodSeconds,
    feeBudgetWei,
    label: draft.label.trim(),
  };
  return sub;
}

/**
 * The same subscription with its clock restarted at `now`: the start moves
 * to `now` and the expiry moves by the same amount, so the number of
 * payments (ceil((validUntil − startAt) / period), engine
 * subscriptionPeriodCount) and every other term stay exactly as reviewed.
 *
 * Why (phase 12 emulator rehearsal, finding 1): the terms used to be fixed
 * when Review opened, so the minutes spent on the review and the approval
 * were taken out of the window — on a 2-minute test period only one of three
 * payments fitted. The Sessions screen now restarts the clock when the user
 * taps Start, re-quotes the install with the restarted terms (the permission
 * id and the policy data change with the start), and shows the final dates
 * once the bundler accepted the install. The engine's validation still runs
 * on the restarted terms (subscriptionGrantFor).
 */
export function restartSubscriptionAt(sub: SubscriptionGrant, now: number): SubscriptionGrant {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('The start must be a unix time (seconds).');
  return { ...sub, startAt: now, validUntil: now + (sub.validUntil - sub.startAt) };
}

/** Shown on the review under the plain sentence. */
export const SUBSCRIPTION_START_NOTE =
  'The subscription starts when you tap Start subscription, not when this screen opened: the dates above ' +
  'move forward by the time you spend here, and the final dates are shown once the bundler accepts the install.';

/**
 * How much the re-quoted install's worst-case fee may exceed the reviewed one
 * before the user is asked to review again (percent). A judgement call, not a
 * standard: the restarted install has the same calls and sizes, so only the
 * network's fee moves between the two quotes, and a small rise should not send
 * the user back through the review.
 */
export const SUBSCRIPTION_REQUOTE_FEE_TOLERANCE_PERCENT = 20n;

/**
 * True when the re-quoted install must be reviewed again (fee rose beyond the
 * tolerance, or sponsorship ended). The tolerance is part of the displayed
 * worst case (subscriptionInstallFeeCeiling), so a re-quote that passes here
 * never exceeds what the review showed; sendAa's signing check then holds
 * the signed operation to the re-quote.
 */
export function subscriptionRequoteNeedsReview(
  reviewed: { fee: bigint; sponsored: boolean },
  requoted: { fee: bigint; sponsored: boolean },
): boolean {
  if (reviewed.sponsored && !requoted.sponsored) return true;
  if (requoted.sponsored) return false;
  return requoted.fee > subscriptionInstallFeeCeiling(reviewed);
}

export const SUBSCRIPTION_REQUOTE_TITLE = 'Please review again';
export const SUBSCRIPTION_REQUOTE_MESSAGE =
  'The network fee for the install rose since you opened the review. Nothing was signed. The review now ' +
  'shows the new fee.';

/** "0x69F0…7E8a". */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * The names of a new subscription: the terms' label (stored with the grant)
 * and the list card's title. A typed name or the merchant's exact-match
 * contact name gives "Subscription: <name>"; with neither, the card says
 * "Subscription to 0x69F0…7E8a" (the rehearsal showed "Subscription:
 * Subscription", finding 4).
 */
export function subscriptionNames(
  typedLabel: string,
  merchant: string,
  merchantName: string | null,
): { termsLabel: string; recordLabel: string } {
  const named = typedLabel.trim() || (merchantName ?? '').trim();
  if (named) return { termsLabel: named, recordLabel: `Subscription: ${named}` };
  const short = shortAddress(merchant.trim());
  return { termsLabel: `to ${short}`, recordLabel: `Subscription to ${short}` };
}

/**
 * List order for subscription cards: live ones (installing, installed,
 * revoking) first, then failed installs, then revoked ones; newest first
 * within each group. Only the stored local status is used, never the
 * on-chain read, so cards do not jump while their statuses load.
 */
export function sortSubscriptionRecords(records: readonly SessionRecord[]): SessionRecord[] {
  const rank = (r: SessionRecord) => (r.localStatus === 'revoked' ? 2 : r.localStatus === 'failed' ? 1 : 0);
  return [...records].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
}

/**
 * The fee-budget pre-fill: defaultFeeBudgetWei for the CURRENT payment count,
 * capped at what the account can spare. "Can spare" is a judgement: the
 * account's current balance minus, for a native-currency subscription, every
 * payment it would make (payments × amount), minus the part of the install
 * operation's own worst-case fee that the balance must pay
 * (`installFeeFromBalance`, aa.ts aaFeeFromBalance of the review's quote; the
 * EntryPoint deposit pays the rest). Before the first review no install
 * quote exists yet and nothing is kept back; Review then lowers an
 * unedited pre-fill that no longer fits (SessionsScreen onSubReview) and
 * says so. `wei` null means nothing can be suggested (the account cannot
 * even cover the payments, or the balance or fee is not known yet).
 */
export function suggestedFeeBudget(p: {
  payments: number;
  maxFeePerGas: bigint | null;
  balance: bigint | null;
  /** Native amount per payment (0 for an ERC-20 subscription). */
  nativeAmountPerPayment: bigint;
  /** The part of the install's worst-case fee the balance pays (null or absent = not known yet). */
  installFeeFromBalance?: bigint | null;
}): { wei: bigint | null; capped: boolean; uncapped: bigint | null; spare: bigint | null } {
  if (!Number.isInteger(p.payments) || p.payments < 1 || p.maxFeePerGas === null) {
    return { wei: null, capped: false, uncapped: null, spare: null };
  }
  const uncapped = defaultFeeBudgetWei(p.payments, p.maxFeePerGas);
  if (p.balance === null) return { wei: uncapped, capped: false, uncapped, spare: null };
  const committed = BigInt(p.payments) * p.nativeAmountPerPayment + (p.installFeeFromBalance ?? 0n);
  const spare = p.balance > committed ? p.balance - committed : 0n;
  if (uncapped <= spare) return { wei: uncapped, capped: false, uncapped, spare };
  return { wei: spare > 0n ? spare : null, capped: true, uncapped, spare };
}

/**
 * What the account holds, for the fee-budget note of a subscription paid in
 * a TOKEN (finding 2 of the 2026-10-04 emulator run: a USDC subscription
 * was told "cannot spare anything for fees after the payments themselves",
 * which is wrong when the payments are not in the native currency).
 */
export interface FeeBudgetTokenContext {
  /** The payment token's symbol ("USDC"). */
  tokenSymbol: string;
  /** The smart account's native balance (wei), when read. */
  balance: bigint | null;
  /** Its EntryPoint deposit (wei), when read. */
  deposit: bigint | null;
  /** The install's worst-case network fee (wei), once a review quote exists. */
  installFee: bigint | null;
}

/**
 * The note under the fee-budget field when the pre-fill was capped. With
 * `installKeptBack` (wei) above zero the note also says that the install's
 * own fee was kept back; without it the text is unchanged. `token` is given
 * for a subscription paid in a token: when nothing can be spared, the note
 * then says what is actually short (the install's fee against the balance
 * and the EntryPoint deposit) instead of blaming the payments.
 */
export function feeBudgetCapNote(
  spare: bigint,
  uncapped: bigint,
  nativeSymbol: string,
  installKeptBack: bigint = 0n,
  token: FeeBudgetTokenContext | null = null,
): string {
  if (spare <= 0n && token) return feeBudgetTokenShortNote(uncapped, nativeSymbol, token);
  const kept =
    installKeptBack > 0n
      ? ` ${formatUnits(installKeptBack, 18, 18)} ${nativeSymbol} is kept back for the install's own worst-case network fee.`
      : '';
  return feeBudgetCapNoteBase(spare, uncapped, nativeSymbol) + kept;
}

function feeBudgetTokenShortNote(uncapped: bigint, nativeSymbol: string, token: FeeBudgetTokenContext): string {
  const fmt = (wei: bigint) => `${formatUnits(wei, 18, 18)} ${nativeSymbol}`;
  const deposit = token.deposit ?? 0n;
  const held =
    token.balance === null
      ? 'The smart account’s balance could not be read'
      : `The smart account holds ${fmt(token.balance)}${deposit > 0n ? ` plus an EntryPoint deposit of ${fmt(deposit)}` : ''}`;
  const install =
    token.installFee !== null
      ? `, and this install's worst-case network fee is ${fmt(token.installFee)}, so nothing is left for the payments' network fees`
      : ', so nothing is left for the payments’ network fees';
  return (
    `${held}${install}. The payments themselves are in ${token.tokenSymbol}; their network fees are paid in ` +
    `${nativeSymbol}. The usual budget for this many payments would be ${fmt(uncapped)}. Fund the smart account ` +
    `with ${nativeSymbol}, or enter a budget by hand.`
  );
}

/**
 * The fee facts behind the fee-budget suggestion, read fresh (when the form
 * opens, when it comes back into focus and at Review — finding 2 of the
 * 2026-10-04 emulator run: a balance read once at opening went stale after
 * funding): the node's current maxFeePerGas, the smart account's native
 * balance and its EntryPoint deposit (EntryPoint balanceOf, the same read
 * aa.ts uses). Each read that fails is null; nothing throws.
 */
export async function readSubscriptionFeeFacts(
  node: JsonRpcTransport,
  account: string,
): Promise<{ maxFeePerGas: bigint | null; balance: bigint | null; deposit: bigint | null; failures: unknown[] }> {
  const client = new NodeClient(node);
  const failures: unknown[] = [];
  const keep = <T,>(p: Promise<T>): Promise<T | null> =>
    p.catch((e: unknown) => {
      failures.push(e);
      return null;
    });
  const [fees, balance, deposit] = await Promise.all([
    keep(suggestFeesRetryingOnce(client)),
    keep(client.getBalance(account)),
    keep(fetchTokenBalanceVia(node, ENTRYPOINT_V07, account)),
  ]);
  return { maxFeePerGas: fees ? fees.maxFeePerGas : null, balance, deposit, failures };
}

/**
 * The worst-case install fee the subscription REVIEW shows and the most
 * that Start may sign (finding 3 of the 2026-10-04 emulator run: the user
 * must never sign a fee above the one displayed). Start restarts the clock,
 * which changes the grant and so the operation, and quotes it again; that
 * re-quote may be higher by up to SUBSCRIPTION_REQUOTE_FEE_TOLERANCE_PERCENT
 * before the review is shown again (subscriptionRequoteNeedsReview), so the
 * review displays the reviewed quote's fee plus that tolerance as the bound.
 * Zero when sponsored. Exact bigint, rounded up.
 */
export function subscriptionInstallFeeCeiling(quote: Pick<AaSendQuote, 'fee' | 'sponsored'>): bigint {
  if (quote.sponsored) return 0n;
  return (quote.fee * (100n + SUBSCRIPTION_REQUOTE_FEE_TOLERANCE_PERCENT) + 99n) / 100n;
}

/**
 * The review quote as the review shows and checks it: `fee` (and `total`)
 * replaced by subscriptionInstallFeeCeiling, so the funding lines and the
 * fee-budget keep-back use the same worst case as the displayed row.
 */
export function withSubscriptionFeeCeiling<Q extends Pick<AaSendQuote, 'fee' | 'sponsored' | 'amount' | 'total'>>(quote: Q): Q {
  if (quote.sponsored) return quote;
  const fee = subscriptionInstallFeeCeiling(quote);
  return { ...quote, fee, total: quote.amount + fee };
}

function feeBudgetCapNoteBase(spare: bigint, uncapped: bigint, nativeSymbol: string): string {
  return spare > 0n
    ? `Lowered to what your account can spare (${formatUnits(spare, 18, 18)} ${nativeSymbol}); the usual ` +
        `budget for this many payments would be ${formatUnits(uncapped, 18, 18)} ${nativeSymbol}. Fund the account ` +
        'or enter a budget by hand.'
    : `Your account cannot spare anything for fees after the payments themselves; the usual budget for this ` +
        `many payments would be ${formatUnits(uncapped, 18, 18)} ${nativeSymbol}. Fund the account first.`;
}

/**
 * What the review says about paying for the install (finding 2 of the
 * 2026-10-04 emulator verification: the review offered Start with an
 * install fee above the balance, payable only through the EntryPoint
 * deposit, and said nothing). Uses aa.ts's own rule (aaCanPaySelf /
 * aaFeeFromBalance: the EntryPoint takes the fee from the deposit first).
 *  - canStart false: the balance plus the deposit cannot cover the install's
 *    worst-case fee; the screen shows `block` and offers no Start button.
 *  - depositNote: the fee is above the balance, and the deposit pays the
 *    difference.
 *  - shortfall: after the install's worst case, what the account keeps
 *    (balance + deposit − fee) is less than the payments (native only) plus
 *    the fee budget, so pulls can fail later. A warning; Start stays offered.
 */
export function subscriptionInstallFunding(
  quote: Pick<AaSendQuote, 'amount' | 'fee' | 'senderBalance' | 'deposit' | 'sponsored' | 'sender'>,
  sub: Pick<SubscriptionGrant, 'startAt' | 'validUntil' | 'periodSeconds' | 'feeBudgetWei' | 'amountPerPeriod' | 'token'>,
  nativeSymbol: string,
): { canStart: boolean; block: string | null; depositNote: string | null; shortfall: string | null } {
  const fmt = (wei: bigint) => `${formatUnits(wei, 18, 18)} ${nativeSymbol}`;
  const deposit = quote.deposit ?? 0n;
  const fee = quote.sponsored ? 0n : quote.fee;
  if (!quote.sponsored && !aaCanPaySelf({ amount: quote.amount, fee, balance: quote.senderBalance, deposit })) {
    return {
      canStart: false,
      block:
        `The smart account cannot pay for the install: its worst-case network fee is ${fmt(fee)}, and the ` +
        `account holds ${fmt(quote.senderBalance)} plus an EntryPoint deposit of ${fmt(deposit)}. Fund the smart ` +
        `account address ${quote.sender} first, then review again. Nothing was signed.`,
      depositNote: null,
      shortfall: null,
    };
  }
  const depositNote =
    !quote.sponsored && fee > quote.senderBalance
      ? `The install's worst-case fee (${fmt(fee)}) is more than the account's balance (${fmt(quote.senderBalance)}); ` +
        `its EntryPoint deposit (${fmt(deposit)}) pays the difference, because the EntryPoint takes the fee from ` +
        'the deposit first.'
      : null;
  const payments = BigInt(subscriptionPeriodCount(sub));
  const nativePayments = isNativeSubscription(sub as SubscriptionGrant) ? payments * sub.amountPerPeriod : 0n;
  const need = nativePayments + sub.feeBudgetWei;
  // The install takes at most its worst-case fee from the deposit and the
  // balance together (the unused part is refunded to the deposit), so this
  // is a lower bound of what remains for the pulls.
  const left = quote.senderBalance + deposit - fee;
  const shortfall =
    need > left
      ? `After the install the account keeps at most ${fmt(left > 0n ? left : 0n)} (balance plus EntryPoint deposit, ` +
        `minus the install's worst-case fee), but ${nativePayments > 0n ? 'the payments and ' : ''}the fee budget ` +
        `can use up to ${fmt(need)}. Pulls the account cannot pay for will fail; fund the smart account to cover them.`
      : null;
  return { canStart: true, block: null, depositNote, shortfall };
}

/**
 * What the fee-budget pre-fill keeps back for the install, from a review
 * quote: the part of the install's worst-case fee that the balance must pay
 * (aa.ts aaFeeFromBalance; zero when sponsored or when the deposit covers it).
 */
export function subscriptionInstallKeepBack(quote: Pick<AaSendQuote, 'fee' | 'deposit' | 'sponsored'>): bigint {
  return quote.sponsored ? 0n : aaFeeFromBalance(quote.fee, quote.deposit ?? null);
}

/**
 * The card title. Records created before the naming fix (2026-10-04) were
 * stored as "Subscription: Subscription" with the terms label
 * "Subscription" when no name was typed and the merchant was not a contact;
 * they are titled at render time like new ones ("Subscription to 0x…", or
 * the merchant's contact name), without rewriting storage.
 */
export function subscriptionDisplayTitle(record: SessionRecord, merchantName: string | null): string {
  if (record.label !== 'Subscription: Subscription' || !record.subscription) return record.label;
  let terms: SubscriptionGrant;
  try {
    terms = termsOf(record);
  } catch {
    return record.label;
  }
  if (terms.label !== 'Subscription') return record.label;
  return subscriptionNames('', terms.merchant, merchantName).recordLabel;
}

/** Shown on a card whose subscription expired while its key was still on this device. */
export const SUBSCRIPTION_EXPIRED_UNHANDED_TEXT =
  'This subscription expired before its key was handed to the merchant, so there is nothing left to hand ' +
  'over: no payment can be taken any more. Revoke it to remove the permission from your account (the key is ' +
  'deleted from this device too), then Forget it.';

/**
 * Whether a card offers the one-time key hand-over: only for a subscription
 * confirmed on-chain, active and NOT expired, whose key is still on this
 * device and was never handed over. 'expired' means the key is still here
 * but the terms ended (by the stored expiry or the on-chain read): the card
 * says so (SUBSCRIPTION_EXPIRED_UNHANDED_TEXT) and offers only Revoke /
 * Forget.
 */
export function subscriptionHandoverOffer(
  record: SessionRecord,
  status: SessionChainStatus | 'loading' | undefined,
  now: number = Math.floor(Date.now() / 1000),
): 'offer' | 'expired' | 'none' {
  if (!record.subscription || !record.keyHeld || record.subscription.keyExportedAt !== null) return 'none';
  if (record.localStatus !== 'installed') return 'none';
  let validUntil: number;
  try {
    validUntil = termsOf(record).validUntil;
  } catch {
    return 'none';
  }
  const settled = status !== undefined && status !== 'loading';
  if (validUntil <= now || (settled && status.kind === 'active' && status.expired)) return 'expired';
  return settled && status.kind === 'active' ? 'offer' : 'none';
}

/** GrantReview's key-holder phrase for a subscription ("Session key (held by …)"), one parenthesis only. */
export const SUBSCRIPTION_KEY_HOLDER_TEXT = 'the merchant once you hand it over; until then, this device’s secure storage';

/** The success screen's line with the dates the install actually carries. */
export function subscriptionFinalDatesLine(sub: SubscriptionGrant): string {
  const count = subscriptionPeriodCount(sub);
  return (
    `Final terms: the first payment can be taken from ${utc(sub.startAt)}, then one more every ` +
    `${describePeriod(sub.periodSeconds)} (${count} in total); nothing after ${utc(sub.validUntil)}.`
  );
}

/** The engine's grant for the subscription (validates; throws the engine's sentence). */
export function subscriptionGrantFor(
  sub: SubscriptionGrant,
  sessionKey: string,
  context: { account: string; now: number },
): SessionKeyGrant {
  return subscriptionToGrant(sub, sessionKey, { account: context.account, now: context.now });
}

/** The meta stored with the session record (keyExportedAt null until the hand-over). */
export function subscriptionMeta(sub: SubscriptionGrant, choice: SubscriptionTokenChoice): SessionSubscriptionMeta {
  return { terms: serializeSubscription(sub), tokenSymbol: choice.symbol, tokenDecimals: choice.decimals, keyExportedAt: null };
}

/** The plain-language review: the engine's sentence, on-chain limits and caveats. */
export function subscriptionReview(
  sub: SubscriptionGrant,
  context: { tokenSymbol: string; tokenDecimals: number; nativeSymbol: string; merchantName?: string | null },
): SubscriptionDescription {
  return describeSubscription(sub, {
    symbol: context.tokenSymbol,
    decimals: context.tokenDecimals,
    nativeSymbol: context.nativeSymbol,
    merchantName: context.merchantName ?? null,
  });
}

/** The subscription records of a session list (source 'subscription' with valid terms). */
export function subscriptionRecords(records: readonly SessionRecord[]): SessionRecord[] {
  return records.filter((r) => r.source === 'subscription' && r.subscription);
}

export function termsOf(record: SessionRecord): SubscriptionGrant {
  if (!record.subscription) throw new Error('Not a subscription.');
  return parseSubscription(record.subscription.terms);
}

// ---------------------------------------------------------------------------
// Key hand-over (shown once)
// ---------------------------------------------------------------------------

export interface SubscriptionKeyExport {
  type: typeof SUBSCRIPTION_KEY_EXPORT_TYPE;
  version: 1;
  chainId: string;
  /** The subscriber's Kernel account (the sender of every pull). */
  account: string;
  entryPoint: string;
  kernelVersion: '0.3.3';
  permissionId: string;
  /** EntryPoint nonce key of the permission (hex). */
  nonceKey: string;
  signerModule: string;
  signatureFormat: string;
  /** The session private key (0x + 64 hex). */
  sessionPrivateKey: string;
  sessionKey: string;
  /** The terms (public), so the merchant's keeper can check every pull locally. */
  subscription: ReturnType<typeof serializeSubscription>;
}

/**
 * Reads the key from the vault and builds the hand-over payload. Refused when
 * the key was already handed over (it is no longer on the device) or the
 * install has not been confirmed on-chain yet.
 */
export async function buildSubscriptionKeyExport(
  record: SessionRecord,
  vault: SessionKeyVault,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SubscriptionKeyExport> {
  if (record.source !== 'subscription' || !record.subscription) throw new Error('Not a subscription.');
  if (!record.keyHeld || record.subscription.keyExportedAt !== null) {
    throw new Error('The key was already handed over and is no longer on this device. Revoke and create a new subscription if it was lost.');
  }
  if (record.localStatus !== 'installed') {
    throw new Error('Wait until the subscription is confirmed on-chain before handing over its key.');
  }
  if (termsOf(record).validUntil <= now) {
    throw new Error('This subscription has expired, so its key can no longer take payments. Revoke it instead of handing it over.');
  }
  const stored = await vault.load(sessionVaultId(record.chain, record.account, record.permissionId));
  if (!stored || !/^0x[0-9a-fA-F]{64}$/.test(stored)) throw new Error('The subscription key is not on this device.');
  const grant = parseSessionKeyGrant(record.grant);
  return {
    type: SUBSCRIPTION_KEY_EXPORT_TYPE,
    version: 1,
    chainId: eip155Decimal(record.chain).toString(),
    account: record.account,
    entryPoint: ENTRYPOINT_V07,
    kernelVersion: '0.3.3',
    permissionId: record.permissionId,
    nonceKey: '0x' + sessionNonceKey(record.permissionId).toString(16),
    signerModule: KERNEL_PERMISSION_MODULES.ecdsaSigner,
    signatureFormat: '0xff || 65-byte EIP-191 signature of the userOpHash by the session key',
    sessionPrivateKey: stored.toLowerCase(),
    sessionKey: grant.sessionKey,
    subscription: record.subscription.terms,
  };
}

// ---------------------------------------------------------------------------
// Hand-over channels: a .json file through the share sheet, or the clipboard
// ---------------------------------------------------------------------------

/**
 * The hand-over used to offer React Native's plain-text Share, which put the
 * private key into the share sheet's preview and into whatever the target
 * app does with shared text (finding 9 of the rehearsal). It is now a file:
 * the payload is written to a .json file in the app's cache directory and the
 * FILE is shared (the same mechanism as components/RecordFileActions.tsx),
 * then deleted. The orchestration lives here with injected file operations so
 * scripts/check-subscriptions.mjs can test it under Node; the screen wires in
 * expo-file-system and expo-sharing (components/SubscriptionKeyHandover.tsx).
 */
export const SUBSCRIPTION_KEY_FILE_DIRECTORY = 'subscription-key-handover';
export const SUBSCRIPTION_KEY_FILE_MIME_TYPE = 'application/json';
export const SUBSCRIPTION_KEY_FILE_UTI = 'public.json';

/**
 * How long the shared key file stays after the share sheet closes. Shorter
 * than the recovery record's 60 s because this file holds a private key; not
 * zero because on Android the share promise resolves when the target app's
 * activity returns and some apps finish reading the shared content a moment
 * later. A judgement call. Leftovers are also swept when the key screen
 * closes and before the next hand-over.
 */
export const SUBSCRIPTION_KEY_FILE_DELETE_DELAY_MS = 10_000;

/** "shiba-subscription-key_11155111_0x762fb3f6.json" (public data only). */
export function subscriptionKeyFileName(payload: Pick<SubscriptionKeyExport, 'chainId' | 'permissionId'>): string {
  const chain = /^[0-9]+$/.test(payload.chainId) ? payload.chainId : 'chain';
  const pid = /^0x[0-9a-fA-F]{8}$/.test(payload.permissionId) ? payload.permissionId.toLowerCase() : 'permission';
  return `shiba-subscription-key_${chain}_${pid}.json`;
}

/** The file operations the share flow needs (expo-file-system + expo-sharing in the app, fakes in scripts). */
export interface SecretFileShareDeps {
  /** Deletes every leftover file of earlier hand-overs. */
  sweep: () => void;
  /** Writes the text to a new file named `name` and returns its handle. */
  write: (name: string, text: string) => { uri: string; remove: () => void };
  /** Opens the share sheet for the file; resolves when the sheet closes. */
  share: (uri: string) => Promise<void>;
  /** Schedules the delayed deletion. */
  schedule: (fn: () => void, ms: number) => void;
  /** False when the platform cannot share files (the flow then refuses before writing anything). */
  available: () => Promise<boolean>;
}

/**
 * Writes the key payload to a .json file and shares the file: leftovers are
 * swept first, the file is deleted SUBSCRIPTION_KEY_FILE_DELETE_DELAY_MS after
 * the sheet closes, and at once if sharing fails. Nothing is written when file
 * sharing is not available.
 */
export async function shareSubscriptionKeyFile(text: string, name: string, deps: SecretFileShareDeps): Promise<void> {
  if (!(await deps.available())) {
    throw new Error('Sharing files is not available on this device. Show the QR code to the merchant instead.');
  }
  deps.sweep();
  const file = deps.write(name, text);
  try {
    await deps.share(file.uri);
  } catch (e) {
    file.remove();
    throw e;
  }
  deps.schedule(() => file.remove(), SUBSCRIPTION_KEY_FILE_DELETE_DELAY_MS);
}

/** How long a copied key stays on the clipboard before the wallet overwrites it. */
export const SUBSCRIPTION_KEY_CLIPBOARD_CLEAR_MS = 60_000;

/**
 * Shown with the Copy button. expo-clipboard 57.0.2 has no "clear" call (its
 * Android setStringAsync is ClipData.newPlainText + setPrimaryClip; iOS sets
 * UIPasteboard.general.string), so "clearing" means overwriting the clipboard
 * with an empty string. It does not mark the clip as sensitive either (no
 * ClipDescription extras are set), so a keyboard's own clipboard history is
 * out of the wallet's reach; the warning says so. JavaScript timers do not
 * run while the app is in the background, so the overwrite happens 60
 * seconds after copying or as soon as the wallet is back in the foreground
 * after that.
 */
export const SUBSCRIPTION_KEY_CLIPBOARD_WARNING =
  'The clipboard can be read by other apps on this phone. The wallet empties it 60 seconds after you copy ' +
  '(or when you come back to the wallet after that), and when you leave this screen. Keyboards that keep a ' +
  'clipboard history of their own may still hold a copy; prefer the file or the QR code.';

export interface ClipboardAutoClear {
  /** Copies `text` and schedules the overwrite (a newer copy replaces the schedule). */
  copy: (text: string) => Promise<void>;
  /** Overwrites the clipboard now if this helper put something there that is still pending. */
  clearNow: () => Promise<void>;
  /** True while a copied secret is waiting to be overwritten. */
  pending: () => boolean;
  /**
   * Calls `listener` whenever pending() changes: after a copy, and after the
   * wallet emptied the clipboard (timer, foreground return or screen close).
   * Returns the unsubscribe function (React useSyncExternalStore shape), so a
   * "Copied ✓" mark can follow pending() instead of staying after the
   * clipboard was emptied.
   */
  subscribe: (listener: () => void) => () => void;
}

/**
 * Copy-then-overwrite for secrets. `setString` is expo-clipboard's
 * setStringAsync in the app; the timer functions are injectable for tests.
 * clearNow overwrites only if a copy made by this helper is still pending, so
 * leaving the screen without copying never touches the user's clipboard.
 */
export function createClipboardAutoClear(deps: {
  setString: (text: string) => Promise<unknown>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  delayMs?: number;
}): ClipboardAutoClear {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const delay = deps.delayMs ?? SUBSCRIPTION_KEY_CLIPBOARD_CLEAR_MS;
  let handle: unknown = null;
  let isPending = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A display listener never affects the clipboard handling.
      }
    }
  };
  const clearNow = async () => {
    if (handle !== null) clearTimer(handle);
    handle = null;
    if (!isPending) return;
    isPending = false;
    try {
      await deps.setString('');
    } finally {
      // Told after the overwrite was attempted: the mark goes when the
      // clipboard was emptied (or the attempt failed — the copy is no longer
      // tracked either way).
      notify();
    }
  };
  return {
    copy: async (text: string) => {
      if (handle !== null) clearTimer(handle);
      await deps.setString(text);
      isPending = true;
      handle = setTimer(() => {
        handle = null;
        void clearNow().catch(() => undefined);
      }, delay);
      notify();
    },
    clearNow,
    pending: () => isPending,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * After the subscriber confirms the hand-over: deletes the key from the vault
 * and records the time. From then on the wallet cannot pull or show the key
 * again; it can only revoke.
 */
export async function markSubscriptionKeyExported(
  record: SessionRecord,
  store: KeyValueStore,
  vault: SessionKeyVault,
  now: number = Date.now(),
): Promise<SessionRecord> {
  if (record.source !== 'subscription' || !record.subscription) throw new Error('Not a subscription.');
  return releaseSessionKey(record, store, vault, { subscription: { ...record.subscription, keyExportedAt: now } });
}

/**
 * The key line of a subscription card whose key is still on this device but
 * can no longer be handed over (subscriptionHandoverOffer 'expired'): the
 * card shows SUBSCRIPTION_EXPIRED_UNHANDED_TEXT below it, so this line only
 * says where the key is and when it goes (2026-10-04 emulator run, bug 5:
 * the card still said "hand it to the merchant" above the expired box).
 */
export const SUBSCRIPTION_KEY_EXPIRED_STATUS_TEXT =
  'Key still on this device. It can no longer be used for payments; it is deleted from this device when you revoke.';

/**
 * Key status in plain words. `handover` is the card's
 * subscriptionHandoverOffer answer: 'expired' gives
 * SUBSCRIPTION_KEY_EXPIRED_STATUS_TEXT; omitted (or any other answer) keeps
 * the previous wording.
 */
export function subscriptionKeyStatusText(record: SessionRecord, handover?: 'offer' | 'expired' | 'none'): string {
  if (!record.subscription) return '';
  if (record.subscription.keyExportedAt !== null) {
    return `Key handed to the merchant ${new Date(record.subscription.keyExportedAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} and deleted from this device.`;
  }
  if (record.keyHeld && handover === 'expired') return SUBSCRIPTION_KEY_EXPIRED_STATUS_TEXT;
  if (record.keyHeld) return 'Key still on this device: hand it to the merchant (shown once).';
  return 'Key no longer on this device.';
}

// ---------------------------------------------------------------------------
// On-chain status: next pull, pulls left, fee budget left
// ---------------------------------------------------------------------------

export type SubscriptionStatus =
  | { kind: 'ok'; state: SubscriptionChainState; next: NextPull }
  | { kind: 'unknown'; reason: string; endpointFailure?: boolean };

export async function readSubscriptionStatus(
  node: JsonRpcTransport,
  record: SessionRecord,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SubscriptionStatus> {
  try {
    const terms = termsOf(record);
    const state = await readSubscriptionState(node, record.account, record.permissionId, terms);
    return { kind: 'ok', state, next: nextPullAllowedAt(state, now) };
  } catch (e) {
    // Same wording as a session's status: an endpoint that did not answer
    // is described in plain words (never a raw platform exception).
    return unknownStatusFrom(e);
  }
}

function utc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** Status lines for the Subscriptions list. */
export function subscriptionStatusLines(record: SessionRecord, status: SubscriptionStatus, nativeSymbol: string): string[] {
  if (status.kind === 'unknown') return [`Status unknown: ${status.reason}`];
  const terms = termsOf(record);
  const total = subscriptionPeriodCount(terms);
  const used = total - status.state.remainingPulls;
  const lines: string[] = [];
  switch (status.next.kind) {
    case 'now':
      lines.push(`Next payment: due now (open since ${utc(status.next.at)}).`);
      break;
    case 'later':
      lines.push(`Next payment: not before ${utc(status.next.at)}.`);
      break;
    case 'used-up':
      lines.push('All payments taken.');
      break;
    case 'ended':
      lines.push(`Ended ${utc(terms.validUntil)}.`);
      break;
    case 'inactive':
      lines.push('Not active on-chain (revoked or never installed).');
      break;
  }
  if (status.next.kind !== 'inactive') {
    lines.push(`${used} of ${total} payment${total === 1 ? '' : 's'} taken.`);
    lines.push(`Fee budget left: ${formatUnits(status.state.feeBudgetLeftWei, 18, 18)} ${nativeSymbol}.`);
  }
  return lines;
}

/** One-line summary for a list card: "5 USDC every 30 days to <merchant>". */
export function subscriptionSummary(record: SessionRecord, merchantName?: string | null): string {
  const terms = termsOf(record);
  const meta = record.subscription!;
  const amount = `${formatUnits(terms.amountPerPeriod, meta.tokenDecimals, meta.tokenDecimals)} ${meta.tokenSymbol}`;
  const who = merchantName ? `${merchantName} (${terms.merchant})` : terms.merchant;
  return `${amount} every ${describePeriod(terms.periodSeconds)} to ${who}${isNativeSubscription(terms) ? '' : ` (token ${terms.token})`}`;
}

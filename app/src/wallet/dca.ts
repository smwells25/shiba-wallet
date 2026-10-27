import {
  BROADCAST_TIMEOUT_MS,
  DCA_NATIVE,
  DCA_PINNED_POOLS,
  DCA_UNSUPPORTED_CHAIN_REFUSAL,
  SUBSCRIPTION_MAX_LABEL,
  UNISWAP_V3_SEPOLIA,
  assertDcaSwap,
  buildDcaSwapCalls,
  dcaDeploymentFor,
  dcaFloorFromQuote,
  dcaGrantFor,
  dcaMinimumOutFor,
  dcaValidUntil,
  decodeDcaOutcome,
  describeDca,
  describePeriod,
  formatBaseUnits,
  formatUtc,
  parseSessionKeyGrant,
  quoteDcaSwap,
  readDcaPool,
  selector as abiSelector,
  serializeDcaTerms,
  toHex,
  validateDcaTerms,
  type Call,
  type DcaLog,
  type DcaPinnedPool,
  type DcaPoolState,
  type DcaQuote,
  type DcaTerms,
  type JsonRpcTransport,
  type SessionKeyGrant,
  type SmartAccountClient,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by
// scripts/check-dca.mjs under Node's type stripping.
import {
  DCA_SOURCE,
  SESSION_UNREACHABLE_TITLE,
  dcaTermsOf,
  describeSessionError,
  eip155Decimal,
  isBundlerTransportFailureBeforeSubmit,
  isNodeEndpointFailure,
  isTransportFailure,
  sendSessionCalls,
  type DcaLastSwap,
  type SessionDcaMeta,
  type SessionKeyVault,
  type SessionRecord,
} from './sessions.ts';
import { SUBSCRIPTION_MAX_PAYMENTS, readSubscriptionStatus, type SubscriptionFeeSource } from './subscriptions.ts';
import {
  RecurringNotDueError,
  RecurringSpendingError,
  RecurringStatusUnreachableError,
  dcaDueState,
  openOutcomeParenthesis,
  recurringOutcomeCause,
  type RecurringAttemptOutcome,
  type RecurringDue,
  type RecurringOutcomeCause,
} from './recurring.ts';
import {
  SPENDING_BLOCK_TITLE,
  SPENDING_HONESTY_SENTENCE,
  evaluateBeforeSigning,
  overLimitSentence,
  recordAcceptedSpend,
  type SpendingScope,
} from './spending-policy.ts';
import { AA_FEE_FLOOR_HEADROOM_PERCENT, aaCanPaySelf, type AaAccountType, type AaSendQuote } from './aa.ts';
import { formatUnits, parseUnits } from './balances.ts';
import type { KeyValueStore } from './tokens.ts';
import { assertFeatureAllowed } from '../config/readiness.ts';
import { NO_ANSWER_SENTENCE, sanitizeEndpointMessage } from '../config/endpoint-probe.ts';
import { isBroadcastOutcomeUnknown } from './broadcast-outcome.ts';
import { t } from '../i18n/index.ts';
import { periodText } from './period-text.ts';

/**
 * Recurring swaps — dollar-cost averaging — on a session key held by this
 * phone (phase 19 item 2, app half; feature 63, "only with AA"). "Swap X test
 * ETH for USDC every N", on Ethereum Sepolia, from the smart account only.
 *
 * THE GRANT is the engine's (packages/chains-evm/src/kernel-dca.ts
 * dcaGrantFor, whose header cites every source): the subscription template
 * (CallPolicy v0.0.4, TimestampPolicy, GasPolicy, RateLimitPolicy, signer
 * SKIP_SIGNATURE) with ONE allowed call — Uniswap's SwapRouter02
 * exactInputSingle on Sepolia, every argument pinned: WETH9 in, USDC out, the
 * 0.05% pool, the account as the recipient, exactly the plan's amount, at
 * least the STATIC floor out, no price limit, and at most the amount as
 * value. The terms carry a grace of one period (graceSeconds), like a
 * recurring payment's grant: the last swap can be sent during two periods;
 * the RateLimitPolicy count stays the number of swaps.
 *
 * THE FLOOR is fixed at set-up from a live QuoterV2 quote at a visible
 * percentage (default 95%) and does NOT follow the price afterwards. Each
 * swap asks for more when it can: the engine's dcaMinimumOutFor(fresh quote
 * less 1%), never less than the floor.
 *
 * WHO SENDS: this app, only while it is open, and only after the user
 * confirms each swap in a dialog — the recurring-payment rules
 * (./recurring.ts), reused: the same due check (findDueRecurringPayments
 * now includes recurring swaps; read-only, no key, no bundler), the same
 * banner, the same reminders (notifications.ts), the same key rules (the
 * key never leaves the phone: no export, no hand-over, no test operation),
 * the same revoke-and-forget. The swap key alone signs a swap, through
 * sessions.ts sendSessionCalls, which for a recurring swap runs the engine's
 * assertDcaSwap before any request and signs through kernelDcaSpec (which
 * checks again before encoding). The owner key and the recovery phrase are
 * never read for a swap.
 *
 * WHAT IS NOT CLOSED (stated on the review and every card, in this order):
 * the batching residual (one operation can hold several in-rule swaps, each
 * at no less than the floor — up to everything the account holds), the
 * static floor, no deadline, a reverting swap uses up its period, ETH left
 * in the router on a partial fill, and what the key can do at all.
 *
 * PER-OPERATION GAS PADDING: the engine run used 110% call-gas padding for
 * the install (DCA_INSTALL_CALL_PADDING in dca-smoke.mjs). The app's AA
 * client has no per-operation padding: aa.ts prepareAaCalls takes no padding
 * option and the bundle's SmartAccountClient is built with fixed
 * gasPaddingPct (none for Kernel bundles), and sendAa re-estimates at
 * signing. The install is therefore signed at the bundler's own estimate
 * (the live run's estimate, 7,478,405 call gas, was above the 7,015,028 gas
 * used). Adding per-operation padding needs an aa.ts change (an option on
 * prepareAaCalls and on the signed-fee guard), recorded for the CTO.
 */

// ---------------------------------------------------------------------------
// Pinned facts
// ---------------------------------------------------------------------------

/** The only network recurring swaps are offered on (the engine pins nothing else). */
export const DCA_CHAIN = 'eip155:11155111';

/** The pool the app uses: USDC/WETH 0.05% (the engine's pinned list; chosen in the engine run, within 0.9% of the best quote). */
export const DCA_POOL: DcaPinnedPool = DCA_PINNED_POOLS.find((p) => p.fee === 500)!;

/** USDC on Sepolia (Circle), the token bought: the pinned pool's token0. */
export const DCA_TOKEN_OUT = DCA_POOL.token0;
export const DCA_TOKEN_OUT_SYMBOL = 'USDC';
export const DCA_TOKEN_OUT_DECIMALS = 6;

/** The default floor: 95% of the quote at review (the design note's default). */
export const DCA_DEFAULT_FLOOR_PERCENT = '95';

/** Each swap asks for the fresh quote less this much (1%), never less than the floor. */
export const DCA_SWAP_SLIPPAGE_BPS = 100;

/**
 * Declared gas per swap: the fee-budget suggestion (doubled by
 * defaultFeeBudgetWei because fees move), the smallest budget a plan may
 * keep back (subscriptions.ts minimumViableFeeBudgetWei: one swap's worst
 * case, below which Review blocks an auto-fitted budget and warns on a typed
 * one) and the review's coverage sentence.
 *
 * GasPolicy charges each operation (preVerificationGas +
 * verificationGasLimit + callGasLimit) × maxFeePerGas — the SIGNED limits,
 * not the gas used (packages/chains-evm/src/kernel-permissions.ts
 * SessionKeyGrant.gasBudgetWei) — so this must be at least the largest
 * signed-limit sum a swap has carried. The three live swaps on Ethereum
 * Sepolia, their signed limits read back from each bundle transaction's
 * handleOps input (read-only, 2026-10-13):
 *  - script swap 1 (tx 0xb7a50c1c…a60f1, block 11,893,108): vGL 987,890 +
 *    cGL 379,444 + pVG 52,779 = 1,420,113 gas, charged 1,640,230,520,680,452
 *    wei at 1.155000004 gwei (the "~1.64e15" of AGENTS.md phase 19 item 2);
 *  - script swap 2 (tx 0x93c17899…a7d7, block 11,893,119): 772,557 + 379,444
 *    + 52,792 = 1,204,793 gas;
 *  - in-app swap (tx 0x1f43c9aa…6ba9, block 11,894,126): 863,242 + 291,880 +
 *    50,266 = 1,205,388 gas at 2.310000004 gwei.
 * The previous figure, 1,000,000, was below all three, so a budget between
 * 1.0 and 1.42 million gas × the fee passed the check and could still be
 * refused on-chain at the first swap. 1,800,000 covers the largest recorded
 * charge (1,420,113) with about 27% to spare — a margin, not a guarantee:
 * the bundler's estimate (and so the signed limits) moves with the chain.
 */
export const DCA_SWAP_GAS_ALLOWANCE = 1_800_000n;

/** The largest signed-limit sum a live swap carried (see DCA_SWAP_GAS_ALLOWANCE). */
export const DCA_SWAP_LARGEST_RECORDED_CHARGE_GAS = 1_420_113n;

/** Gas the live install of 2026-10-11 used (AGENTS.md phase 19 item 2). */
export const DCA_INSTALL_GAS_RECORDED = 7_015_028n;

/**
 * Gas the bundler appeared to reserve before it would estimate the install
 * (AGENTS.md phase 19 item 2, finding 2: AA21 unless balance + deposit
 * covered about 7.3 to 8 million gas × maxFeePerGas). The upper end is used.
 */
export const DCA_ESTIMATE_RESERVATION_GAS = 8_000_000n;

// ---------------------------------------------------------------------------
// User-facing sentences
// ---------------------------------------------------------------------------

export const DCA_FORM_INTRO =
  'Swaps a fixed amount of test ETH from your smart account for USDC once per period, always through the same ' +
  'Uniswap pool, until the swaps run out or you revoke. A new swap key is created on this phone and never leaves ' +
  'it; your account enforces the limits on-chain.';

/** Shown on the form, the review and every recurring-swap card list. */
export const DCA_WHILE_OPEN_NOTE =
  'Swaps are sent only while this wallet is open. When one is due, the wallet shows it on this screen (and in a ' +
  'banner when you open the app) and sends it only after you confirm. Nothing is swapped in the background or ' +
  'while the wallet is closed. A swap missed while the wallet was closed is not lost: your account allows it to ' +
  'be sent later, until the end date.';

export const DCA_CARD_NOTE =
  'Sent only while this wallet is open, and only after you confirm each swap; no swap is ever sent in the ' +
  'background. With reminders on (Settings → Privacy → Notifications), this phone can remind you when a swap ' +
  'falls due, even while the wallet is closed; the swap still waits for you.';

/** The prompts of a swap, stated exactly (storage.ts PROMPTS.sessionKeyRead is "Use the session key"). */
export const DCA_PAY_PROMPT_NOTE =
  'You confirm each swap in the wallet. The swap key signs it, not your account key, so your recovery phrase is ' +
  'never opened for it. If the swap key is protected by biometrics (it is when your recovery phrase was protected ' +
  'at set-up), the phone also asks once: "Use the session key".';

export const DCA_SPENDING_NOTE =
  'Your spending limits (this app only) are checked before each swap, by the test ETH it sells: a swap that would ' +
  'go over a limit is not sent. The network fee of a swap is not counted against limits; the fee budget caps it ' +
  'on-chain.';

export const DCA_START_NOTE =
  'The schedule starts when you tap Start recurring swap, not when this screen opened: the dates above move ' +
  'forward by the time you spend here, and the final dates are shown once the bundler accepts the set-up. The ' +
  'first swap is due right away. The minimum to receive stays exactly as shown.';

/** GrantReview's key-holder phrase ("Session key (held by …)"): one parenthesis only. */
export const DCA_KEY_HOLDER_TEXT = 'this phone’s secure storage only, never shown or exported';

export const DCA_KEY_STATUS_TEXT =
  'Swap key on this phone only (never shown or exported); deleted from this phone when you revoke.';

export const DCA_AUDIT_NOTE =
  'Recurring swaps use ZeroDev’s ECDSASigner, CallPolicy v0.0.4, TimestampPolicy, GasPolicy and RateLimitPolicy, ' +
  'and Uniswap’s SwapRouter02 and pool contracts. No published security audit names these permission modules, and ' +
  'the pool’s code is not verified against published source (this wallet checks the pool against Uniswap’s ' +
  'factory on every read), so treat recurring swaps as experimental.';

export const DCA_COMPLETED_TEXT =
  'No more swaps can be sent. Revoke it to remove the permission from your account (the swap key is deleted from ' +
  'this phone too); it is then forgotten here.';

/** The set-up is signed at the bundler's own estimate (see the module header on padding). */
export const DCA_INSTALL_PADDING_NOTE =
  'The set-up is signed at the bundler’s own gas estimate; this wallet adds no extra call-gas margin for it. The ' +
  'fee shown is that estimate plus up to 20% for the new quote taken when you tap Start recurring swap.';

/** Offered only on Ethereum Sepolia: the engine's sentence, verbatim. */
export function dcaNetworkRefusal(caip2: string): string | null {
  let chainId: bigint;
  try {
    chainId = eip155Decimal(caip2);
  } catch {
    return DCA_UNSUPPORTED_CHAIN_REFUSAL;
  }
  return dcaDeploymentFor(chainId) ? null : DCA_UNSUPPORTED_CHAIN_REFUSAL;
}

/** "95%", "97.5%" from basis points. */
export function bpsText(bps: number): string {
  return `${formatBaseUnits(BigInt(bps), 2)}%`;
}

function thousands(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function gweiText(wei: bigint): string {
  return `${formatUnits(wei, 9, 9)} gwei`;
}

function eth(wei: bigint, symbol: string): string {
  return `${formatUnits(wei, 18, 18)} ${symbol}`;
}

function usdc(units: bigint): string {
  return `${formatBaseUnits(units, DCA_TOKEN_OUT_DECIMALS)} ${DCA_TOKEN_OUT_SYMBOL}`;
}

/**
 * What a set-up costs, with the recorded figures and, when the fee the
 * wallet signs at is known, today's equivalent (the design note: state the
 * ~7M-gas / ~0.008 ETH install and the ~0.012 ETH needed to be estimated).
 */
export function dcaSetupCostNote(maxFeePerGas: bigint | null, nativeSymbol: string): string {
  const recorded =
    'Setting up a recurring swap is expensive on Sepolia since its Glamsterdam upgrade, because the set-up writes ' +
    'seven call rules into fresh storage. The one set up on 2026-10-11 used 7,015,028 gas (about 0.0081 ETH at ' +
    'about 1.155 gwei), and the bundler refused even to estimate it until the smart account held about 0.012 ETH ' +
    '(balance plus EntryPoint deposit).';
  if (maxFeePerGas === null || maxFeePerGas <= 0n) return recorded;
  return (
    `${recorded} At the fee this wallet signs at today (${gweiText(maxFeePerGas)} per gas), ` +
    `${thousands(DCA_INSTALL_GAS_RECORDED)} gas is about ${eth(DCA_INSTALL_GAS_RECORDED * maxFeePerGas, nativeSymbol)}, ` +
    `and the bundler’s reservation of about ${thousands(DCA_ESTIMATE_RESERVATION_GAS)} gas is about ` +
    `${eth(DCA_ESTIMATE_RESERVATION_GAS * maxFeePerGas, nativeSymbol)}.`
  );
}

/** The balance the bundler is likely to require before it estimates the set-up (reservation × signed fee). */
export function dcaEstimateReservationWei(maxFeePerGas: bigint): bigint {
  return DCA_ESTIMATE_RESERVATION_GAS * maxFeePerGas;
}

/**
 * A warning when the smart account (balance + EntryPoint deposit) holds less
 * than the bundler's likely reservation at today's signed fee; null when it
 * holds enough or a figure is unknown. A warning only: the review asks the
 * bundler anyway, and an AA21 from the estimate is described in full.
 */
export function dcaSetupFundingWarning(facts: {
  maxFeePerGas: bigint | null;
  balance: bigint | null;
  deposit: bigint | null;
  account: string;
  nativeSymbol: string;
}): string | null {
  if (facts.maxFeePerGas === null || facts.balance === null || facts.maxFeePerGas <= 0n) return null;
  const need = dcaEstimateReservationWei(facts.maxFeePerGas);
  const held = facts.balance + (facts.deposit ?? 0n);
  if (held >= need) return null;
  return (
    `The smart account holds ${eth(facts.balance, facts.nativeSymbol)}` +
    (facts.deposit !== null && facts.deposit > 0n ? ` plus an EntryPoint deposit of ${eth(facts.deposit, facts.nativeSymbol)}` : '') +
    `, less than the about ${eth(need, facts.nativeSymbol)} the bundler is likely to require before it even ` +
    `estimates the set-up. Fund the smart account address ${facts.account} first (plus what the swaps themselves ` +
    'sell), then review.'
  );
}

/** Appended to an AA21 the bundler gave while estimating the set-up. */
export const DCA_ESTIMATE_RESERVATION_NOTE =
  'A recurring swap’s set-up is unusually large (about 7 million gas), and the bundler asks the smart account to ' +
  'hold its worst-case fee before it will estimate it — about 0.012 ETH on 2026-10-11, more when fees are higher. ' +
  'Fund the smart account, then review again.';

export function dcaFeeBudgetHint(nativeSymbol: string): string {
  return (
    `Each swap’s network fee is paid by your smart account in ${nativeSymbol}. The budget caps the total on-chain, ` +
    'including what anyone holding the swap key could spend on fees.'
  );
}

/** The hint under an unedited fee-budget pre-fill (what it is priced at). */
export function dcaFeeBudgetSuggestionHint(source: SubscriptionFeeSource | null): string {
  if (source === 'node') {
    return (
      'Suggested from the network node’s current fee, because the bundler’s fee could not be read; the swaps are ' +
      'signed at the bundler’s fee, which can be much higher. It follows the number of swaps above until you type ' +
      'your own figure.'
    );
  }
  return (
    `Suggested from the fee each swap is signed at today (the bundler’s current fee plus ` +
    `${AA_FEE_FLOOR_HEADROOM_PERCENT}% headroom): ${thousands(DCA_SWAP_GAS_ALLOWANCE)} gas per swap, doubled because ` +
    'fees move, for the number of swaps above; it follows that number until you type your own figure.'
  );
}

/**
 * The note when the fee-budget pre-fill was capped at what the account can
 * spare after every swap's amount (and, after a review, the set-up's own
 * worst-case fee): the subscription form's rule in swap words.
 */
export function dcaFeeBudgetCapNote(spare: bigint, uncapped: bigint, nativeSymbol: string, installKeptBack: bigint = 0n): string {
  const kept =
    installKeptBack > 0n ? ` ${eth(installKeptBack, nativeSymbol)} is kept back for the set-up’s own worst-case network fee.` : '';
  return (
    (spare > 0n
      ? `Lowered to what your account can spare (${eth(spare, nativeSymbol)}); the usual budget for this many swaps ` +
        `would be ${eth(uncapped, nativeSymbol)}. Fund the account or enter a budget by hand.`
      : `Your account cannot spare anything for fees after the ${nativeSymbol} the swaps themselves sell; the usual ` +
        `budget for this many swaps would be ${eth(uncapped, nativeSymbol)}. Fund the account first.`) + kept
  );
}

/** Added to the form's capped-budget note: what clearing a typed figure brings back. */
export const DCA_FEE_BUDGET_CLEAR_NOTE =
  'The field shows this lowered figure; clearing a figure you typed brings it back, not the usual budget.';

/**
 * The hint under the recurring-swap form's fee-budget field while the user
 * has not typed a budget (finding 1 of the phase 20 item 0 pass: after a
 * review was blocked, the field showed the budget lowered to what the
 * account could keep back while the hint still said it followed the
 * suggestion for the number of swaps, and clearing the field brought the
 * lowered figure back). Not capped: the suggestion hint
 * (dcaFeeBudgetSuggestionHint). Capped: the cap note (dcaFeeBudgetCapNote,
 * naming what can be spared, the usual budget and any set-up fee kept back)
 * and DCA_FEE_BUDGET_CLEAR_NOTE, so the hint describes the figure actually
 * shown.
 */
export function dcaFeeBudgetFormHint(p: {
  source: SubscriptionFeeSource | null;
  suggestion: { capped: boolean; spare: bigint | null; uncapped: bigint | null };
  installKeptBack: bigint | null;
  nativeSymbol: string;
}): string {
  return dcaFeeBudgetFormNote(p).text;
}

/**
 * dcaFeeBudgetFormHint with how to show it (pass p20c findings 8 and 17):
 * the cap note says the account cannot fund the usual budget, so the form
 * shows it as a warning (the warning colours of a WarningBox), never in the
 * muted hint grey; the plain suggestion stays a muted hint. While Review's
 * own refusal is on screen the form shows neither (formFeeHintShown), so
 * the shortfall is stated once, by the refusal.
 */
export function dcaFeeBudgetFormNote(p: {
  source: SubscriptionFeeSource | null;
  suggestion: { capped: boolean; spare: bigint | null; uncapped: bigint | null };
  installKeptBack: bigint | null;
  nativeSymbol: string;
}): { text: string; warning: boolean } {
  const { capped, spare, uncapped } = p.suggestion;
  if (!capped || spare === null || uncapped === null) return { text: dcaFeeBudgetSuggestionHint(p.source), warning: false };
  const note = dcaFeeBudgetCapNote(spare, uncapped, p.nativeSymbol, p.installKeptBack ?? 0n);
  return { text: spare > 0n ? `${note} ${DCA_FEE_BUDGET_CLEAR_NOTE}` : note, warning: true };
}

/** The review's sentence on what the fee budget is priced at and how many swaps it covers. */
export function dcaFeeBudgetPricingNote(p: {
  budgetWei: bigint;
  count: number;
  maxFeePerGas: bigint | null;
  source: SubscriptionFeeSource | null;
  edited: boolean;
  nativeSymbol: string;
}): string {
  const recorded =
    ' The three swaps run on 2026-10-11 were charged 1,420,113, 1,204,793 and 1,205,388 gas (their signed gas ' +
    'limits) against their budget.';
  if (p.maxFeePerGas === null || p.source === null || p.maxFeePerGas <= 0n) {
    return (
      'The network fee could not be read, so the fee budget is not compared with what the swaps will cost. Each ' +
      'swap is charged its signed gas limits × its signed fee against the budget.' +
      recorded
    );
  }
  const perSwap = DCA_SWAP_GAS_ALLOWANCE * p.maxFeePerGas;
  const covers = perSwap > 0n ? p.budgetWei / perSwap : 0n;
  const basis =
    p.source === 'bundler'
      ? `${gweiText(p.maxFeePerGas)} per gas — the fee each swap is signed at today (the bundler’s current fee plus ` +
        `${AA_FEE_FLOOR_HEADROOM_PERCENT}% headroom)`
      : `${gweiText(p.maxFeePerGas)} per gas — the network node’s fee, because the bundler’s fee could not be read; ` +
        'the swaps are signed at the bundler’s fee, which can be much higher, so this budget may run out sooner';
  const each = eth(perSwap, p.nativeSymbol);
  const head = p.edited
    ? `You entered this fee budget. Priced at ${basis}, ${thousands(DCA_SWAP_GAS_ALLOWANCE)} gas of one swap costs ` +
      `about ${each}`
    : `Fee budget priced at ${basis}: ${thousands(DCA_SWAP_GAS_ALLOWANCE)} gas per swap (${each}), doubled because ` +
      'fees move';
  const coverage =
    covers >= BigInt(p.count)
      ? `; at ${thousands(DCA_SWAP_GAS_ALLOWANCE)} gas each it covers all ${p.count} swap${p.count === 1 ? '' : 's'}.`
      : `; at ${thousands(DCA_SWAP_GAS_ALLOWANCE)} gas each it covers about ${covers} of the ${p.count} swap` +
        `${p.count === 1 ? '' : 's'}, after which the account refuses further swaps until a new plan replaces this one.`;
  return head + coverage + recorded;
}

// ---------------------------------------------------------------------------
// Terms, names and the grant
// ---------------------------------------------------------------------------

export interface DcaDraft {
  /** Decimal test ETH sold per swap. */
  amount: string;
  periodSeconds: number;
  /** Number of swaps. */
  count: string;
  /** Total fee budget in test ETH (decimal); empty means none, which the engine refuses. */
  feeBudget: string;
  /** The floor as a percentage of the quote (decimal, at most two decimals). */
  floorPercent: string;
  /** The name typed (optional). */
  label: string;
}

/** Refusal when the floor percentage does not parse. */
export const DCA_FLOOR_PERCENT_REFUSAL =
  'Enter the minimum to receive as a percentage of the quote, from 0.01 to 100 (for example 95).';

/** The floor percentage in basis points ("95" → 9500, "97.5" → 9750); throws DCA_FLOOR_PERCENT_REFUSAL. */
export function parseFloorPercent(text: string): number {
  const t = text.trim();
  if (!/^[0-9]{1,3}(\.[0-9]{1,2})?$/.test(t)) throw new Error(DCA_FLOOR_PERCENT_REFUSAL);
  const bps = Number(parseUnits(t, 2));
  if (bps < 1 || bps > 10_000) throw new Error(DCA_FLOOR_PERCENT_REFUSAL);
  return bps;
}

/** The terms' label and the card title: "Recurring swap: <name>" or "Recurring swap: 0.001 test ETH to USDC". */
export function dcaNames(typedLabel: string, amountText: string, nativeSymbol: string): { termsLabel: string; recordLabel: string } {
  const typed = typedLabel.trim();
  const fallback = `${amountText.trim()} ${nativeSymbol} to ${DCA_TOKEN_OUT_SYMBOL}`;
  const termsLabel = (typed || fallback).slice(0, SUBSCRIPTION_MAX_LABEL);
  return { termsLabel, recordLabel: `Recurring swap: ${termsLabel}` };
}

/**
 * The plan's terms from the form and a fresh quote. The network is checked
 * first; refusals the engine makes are thrown with the engine's DCA_*
 * sentences verbatim (validateDcaTerms, dcaFloorFromQuote): a zero amount
 * (DCA_AMOUNT_REFUSAL), a zero floor (DCA_FLOOR_ZERO_REFUSAL), no fee budget
 * (DCA_FEE_BUDGET_REFUSAL), another network (DCA_UNSUPPORTED_CHAIN_REFUSAL).
 * The terms always name the pinned router, WETH9 in (DCA_NATIVE), USDC out,
 * the 0.05% pool, the account as the recipient and a grace of one period.
 */
export function buildDcaTerms(
  draft: DcaDraft,
  context: { now: number; account: string; chainId: bigint; quotedOut: bigint; nativeSymbol: string },
): { terms: DcaTerms; floorBps: number } {
  const deployment = dcaDeploymentFor(context.chainId);
  if (!deployment) throw new Error(DCA_UNSUPPORTED_CHAIN_REFUSAL);
  if (draft.amount.trim() === '') throw new Error(`Enter the amount of ${context.nativeSymbol} to swap each period.`);
  let amountIn: bigint;
  try {
    amountIn = parseUnits(draft.amount, 18);
  } catch {
    throw new Error(`The amount to swap is not a valid number of ${context.nativeSymbol}.`);
  }
  const countText = draft.count.trim();
  const count = /^[0-9]+$/.test(countText) ? Number(countText) : Number.NaN;
  if (Number.isSafeInteger(count) && count > SUBSCRIPTION_MAX_PAYMENTS) {
    throw new Error(`This wallet offers at most ${SUBSCRIPTION_MAX_PAYMENTS} swaps per plan.`);
  }
  let feeBudgetWei = 0n;
  if (draft.feeBudget.trim() !== '') {
    try {
      feeBudgetWei = parseUnits(draft.feeBudget, 18);
    } catch {
      throw new Error(`The fee budget is not a valid number of ${context.nativeSymbol}.`);
    }
  }
  const floorBps = parseFloorPercent(draft.floorPercent);
  // A zero amount reaches the engine, which refuses it in its own words.
  if (amountIn <= 0n) validateDcaTerms({ ...placeholderTerms(context, deployment.swapRouter02), amountIn });
  const minimumOut = dcaFloorFromQuote(context.quotedOut, floorBps);
  const names = dcaNames(draft.label, draft.amount, context.nativeSymbol);
  const terms: DcaTerms = {
    chainId: context.chainId,
    account: context.account,
    router: deployment.swapRouter02,
    tokenIn: DCA_NATIVE,
    tokenOut: DCA_TOKEN_OUT,
    fee: DCA_POOL.fee,
    amountIn,
    minimumOut,
    periodSeconds: draft.periodSeconds,
    count,
    startAt: context.now,
    graceSeconds: draft.periodSeconds,
    feeBudgetWei,
    label: names.termsLabel,
    recipient: context.account,
  };
  validateDcaTerms(terms, { now: context.now });
  return { terms, floorBps };
}

/** Terms with everything valid, so validateDcaTerms reaches the field under test (the amount). */
function placeholderTerms(context: { now: number; account: string; chainId: bigint }, router: string): DcaTerms {
  return {
    chainId: context.chainId,
    account: context.account,
    router,
    tokenIn: DCA_NATIVE,
    tokenOut: DCA_TOKEN_OUT,
    fee: DCA_POOL.fee,
    amountIn: 1n,
    minimumOut: 1n,
    periodSeconds: 3600,
    count: 1,
    startAt: context.now,
    feeBudgetWei: 1n,
    label: 'x',
  };
}

/** The engine's grant for the terms (validates; throws the engine's sentence). */
export function dcaGrantForTerms(terms: DcaTerms, sessionKey: string, now: number): SessionKeyGrant {
  return dcaGrantFor(terms, sessionKey, { now });
}

/** Start restarts the clock: the same terms from `now` (same floor, same amount, same grace). */
export function restartDcaAt(terms: DcaTerms, now: number): DcaTerms {
  return { ...terms, startAt: now };
}

/** The meta stored with the record (no key material; keyExportedAt always null). */
export function dcaMeta(
  terms: DcaTerms,
  context: { nativeSymbol: string; floorBps: number; quoteAtReview: bigint },
): SessionDcaMeta {
  return {
    terms: serializeDcaTerms(terms),
    symbolIn: context.nativeSymbol,
    decimalsIn: 18,
    symbolOut: DCA_TOKEN_OUT_SYMBOL,
    decimalsOut: DCA_TOKEN_OUT_DECIMALS,
    floorBps: context.floorBps,
    quoteAtReview: context.quoteAtReview.toString(10),
    keyExportedAt: null,
    lastSwap: null,
  };
}

// ---------------------------------------------------------------------------
// Pool, router and quote
// ---------------------------------------------------------------------------

export interface DcaMarket {
  pool: DcaPoolState;
  quote: DcaQuote;
}

/**
 * The pinned pool re-checked against Uniswap's factory (engine readDcaPool:
 * getPool, the pool's factory, tokens, fee, in-range liquidity) and a live
 * QuoterV2 quote for `amountIn`. Read-only eth_calls.
 */
export async function readDcaMarket(node: JsonRpcTransport, chainId: bigint, amountIn: bigint): Promise<DcaMarket> {
  if (!dcaDeploymentFor(chainId)) throw new Error(DCA_UNSUPPORTED_CHAIN_REFUSAL);
  const pair = { chainId, tokenIn: DCA_NATIVE, tokenOut: DCA_TOKEN_OUT, fee: DCA_POOL.fee };
  const pool = await readDcaPool(node, pair);
  const quote = await quoteDcaSwap(node, { ...pair, amountIn });
  return { pool, quote };
}

/** The pool, router and quote lines of the form and the review (full addresses, exact USDC). */
export function dcaMarketLines(args: {
  amountIn: bigint;
  quotedOut: bigint | null;
  floorBps: number | null;
  nativeSymbol: string;
}): string[] {
  // Through the string table (phase 23 item 8, fourth pass); in English
  // exactly the lines this function built before.
  const lines = [
    t('dca.market.pool', { label: DCA_POOL.label, pool: DCA_POOL.pool, factory: UNISWAP_V3_SEPOLIA.factory }),
    t('dca.market.router', { router: UNISWAP_V3_SEPOLIA.swapRouter02 }),
  ];
  if (args.quotedOut !== null) {
    lines.push(
      t('dca.market.quote', {
        quoter: UNISWAP_V3_SEPOLIA.quoterV2,
        amount: formatBaseUnits(args.amountIn, 18),
        symbol: args.nativeSymbol,
        out: usdc(args.quotedOut),
      }),
    );
    if (args.floorBps !== null) {
      let floor: bigint | null = null;
      try {
        floor = dcaFloorFromQuote(args.quotedOut, args.floorBps);
      } catch {
        floor = null;
      }
      lines.push(
        floor === null
          ? t('dca.market.minimumZero', { percent: bpsText(args.floorBps) })
          : t('dca.market.minimum', { percent: bpsText(args.floorBps), floor: usdc(floor) }),
      );
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface DcaReview {
  sentence: string;
  /** What the account enforces on-chain. */
  enforced: string[];
  /** The batching residual: always shown FIRST, in a warning box. */
  batching: string;
  /**
   * The rest, in the design note's order: the static floor ("THE MINIMUM
   * DOES NOT FOLLOW THE PRICE"), no deadline, a reverting swap uses up its
   * period, ETH left in the router on a partial fill, the key can only buy
   * USDC for this account, catch-up (with the grace), revoke, the key's home.
   */
  caveats: string[];
}

/** Picks one of the engine's caveats by its opening words (never paraphrased). */
function engineCaveat(caveats: readonly string[], start: string): string {
  const found = caveats.find((c) => c.startsWith(start));
  if (!found) throw new Error(`The engine's recurring-swap caveat "${start}…" is missing.`);
  return found;
}

/** The line stating what the swap key can do at all. */
export function dcaKeyOnlyLine(account: string): string {
  // Through the string table (phase 23 item 8, fourth pass); in English
  // exactly the line this function built before.
  return t('dca.review.keyOnly', { symbol: DCA_TOKEN_OUT_SYMBOL, account });
}

/**
 * The plain-language review: the engine's describeDca (sentence, on-chain
 * lines, caveats verbatim), arranged in the design note's order, plus the
 * key line, the grace sentence and where the key lives.
 */
/** The engine's past-tense clause about the floor ("…per swap was fixed when the plan was set up."). */
export const DCA_FLOOR_FIXED_PAST = 'was fixed when the plan was set up.';
/** The same clause on the review, before the plan exists (finding 3 of the phase 20 item 0 pass). */
export const DCA_FLOOR_FIXED_FUTURE = 'will be fixed when the plan is set up.';

/**
 * The engine's "THE MINIMUM DOES NOT FOLLOW THE PRICE" caveat in the tense of
 * `stage`: unchanged once the plan is set up (the cards), and "will be fixed
 * when the plan is set up" on the review before Start. Throws when the
 * engine's wording no longer carries the clause, so a reworded caveat cannot
 * silently keep the wrong tense.
 */
export function floorCaveatForStage(caveat: string, stage: 'review' | 'set-up'): string {
  if (stage === 'set-up') return caveat;
  if (!caveat.includes(DCA_FLOOR_FIXED_PAST)) {
    throw new Error(`The engine's floor caveat no longer says "${DCA_FLOOR_FIXED_PAST}"`);
  }
  return caveat.replace(DCA_FLOOR_FIXED_PAST, DCA_FLOOR_FIXED_FUTURE);
}

export function dcaReview(
  terms: DcaTerms,
  context: {
    nativeSymbol: string;
    /** 'review' before Start (future tense); 'set-up' for an installed plan's card. Default 'set-up'. */
    stage?: 'review' | 'set-up';
  },
): DcaReview {
  const d = describeDca(terms, {
    symbolIn: context.nativeSymbol,
    decimalsIn: 18,
    symbolOut: DCA_TOKEN_OUT_SYMBOL,
    decimalsOut: DCA_TOKEN_OUT_DECIMALS,
    nativeSymbol: context.nativeSymbol,
  });
  const end = dcaValidUntil(terms);
  const lastDue = terms.startAt + Math.max(0, terms.count - 1) * terms.periodSeconds;
  const graced = (terms.graceSeconds ?? 0) > 0;
  // The engine's caveats stay English by rule; the wallet's own sentences
  // go through the string table (phase 23 item 8, fourth pass).
  const catchUp =
    engineCaveat(d.caveats, 'Missed periods are not lost') +
    (graced ? ` ${t('dca.review.grace', { lastDue: formatUtc(lastDue), end: formatUtc(end) })}` : '');
  const caveats = [
    floorCaveatForStage(engineCaveat(d.caveats, 'THE MINIMUM DOES NOT FOLLOW THE PRICE'), context.stage ?? 'set-up'),
    engineCaveat(d.caveats, 'There is no deadline'),
    engineCaveat(d.caveats, 'A swap that reverts still uses up its period'),
    ...d.caveats.filter((c) => c.includes('stays in the router')),
    dcaKeyOnlyLine(terms.account),
    catchUp,
    engineCaveat(d.caveats, 'Revoke at any time'),
    t('dca.review.keyLives'),
  ];
  return {
    sentence: d.sentence,
    enforced: d.enforced,
    batching: engineCaveat(d.caveats, 'ONE OPERATION CAN HOLD SEVERAL SWAPS'),
    caveats,
  };
}

/** Warning for a plan shorter than ten minutes in total (the recurring form's threshold). */
export function dcaShortWindowWarning(terms: DcaTerms): string | null {
  const total = dcaValidUntil(terms) - terms.startAt;
  if (!(total < 600)) return null;
  // Through the string table (phase 23 item 8, fourth pass); in English
  // exactly the sentence this function built before.
  const params = { total: periodText(total), count: terms.count, period: periodText(terms.periodSeconds) };
  return terms.count === 1 ? t('dca.shortOne', params) : t('dca.shortMany', params);
}

/** The success screen's line with the dates the set-up actually carries. */
export function dcaFinalDatesLine(terms: DcaTerms): string {
  // Through the string table (phase 23 item 8, fourth pass); in English
  // exactly the line this function built before.
  return t('dca.finalTerms', {
    start: formatUtc(terms.startAt),
    period: periodText(terms.periodSeconds),
    count: terms.count,
    end: formatUtc(dcaValidUntil(terms)),
    minimum: usdc(terms.minimumOut),
  });
}

/**
 * What the review says about paying for the set-up (the subscription form's
 * rule, subscriptions.ts subscriptionInstallFunding, in swap words): no
 * Start when the balance plus the deposit cannot cover the set-up's
 * worst-case fee; a note when the deposit pays part of it; a warning when
 * what is left cannot cover every swap's amount plus the fee budget.
 */
export function dcaInstallFunding(
  quote: Pick<AaSendQuote, 'amount' | 'fee' | 'senderBalance' | 'deposit' | 'sponsored' | 'sender'>,
  terms: Pick<DcaTerms, 'amountIn' | 'count' | 'feeBudgetWei'>,
  nativeSymbol: string,
): { canStart: boolean; block: string | null; depositNote: string | null; shortfall: string | null } {
  const deposit = quote.deposit ?? 0n;
  const fee = quote.sponsored ? 0n : quote.fee;
  if (!quote.sponsored && !aaCanPaySelf({ amount: quote.amount, fee, balance: quote.senderBalance, deposit })) {
    return {
      canStart: false,
      block:
        `The smart account cannot pay for the set-up: its worst-case network fee is ${eth(fee, nativeSymbol)}, and the ` +
        `account holds ${eth(quote.senderBalance, nativeSymbol)} plus an EntryPoint deposit of ${eth(deposit, nativeSymbol)}. ` +
        `Fund the smart account address ${quote.sender} first, then review again. Nothing was signed.`,
      depositNote: null,
      shortfall: null,
    };
  }
  const depositNote =
    !quote.sponsored && fee > quote.senderBalance
      ? `The set-up’s worst-case fee (${eth(fee, nativeSymbol)}) is more than the account’s balance ` +
        `(${eth(quote.senderBalance, nativeSymbol)}); its EntryPoint deposit (${eth(deposit, nativeSymbol)}) pays the ` +
        'difference, because the EntryPoint takes the fee from the deposit first.'
      : null;
  const sells = BigInt(terms.count) * terms.amountIn;
  const need = sells + terms.feeBudgetWei;
  const left = quote.senderBalance + deposit - fee;
  const shortfall =
    need > left
      ? `After the set-up the account keeps at most ${eth(left > 0n ? left : 0n, nativeSymbol)} (balance plus ` +
        `EntryPoint deposit, minus the set-up’s worst-case fee), but the swaps (${terms.count} × ` +
        `${eth(terms.amountIn, nativeSymbol)}) and the fee budget can use up to ${eth(need, nativeSymbol)}. Swaps the ` +
        'account cannot pay for will fail; fund the smart account to cover them.'
      : null;
  return { canStart: true, block: null, depositNote, shortfall };
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** One-line card summary: "0.00001 test ETH → USDC every 5 minutes (at least 0.445076 USDC each)". */
export function dcaSummary(record: SessionRecord): string {
  const terms = dcaTermsOf(record);
  const meta = record.dca!;
  return (
    `${formatBaseUnits(terms.amountIn, meta.decimalsIn)} ${meta.symbolIn} → ${meta.symbolOut} every ` +
    `${describePeriod(terms.periodSeconds)} (at least ${formatBaseUnits(terms.minimumOut, meta.decimalsOut)} ` +
    `${meta.symbolOut} each, ${bpsText(meta.floorBps)} of the quote at set-up)`
  );
}

export function dcaKeyStatusText(record: SessionRecord): string {
  return record.keyHeld
    ? DCA_KEY_STATUS_TEXT
    : 'Swap key no longer on this phone, so this wallet cannot send swaps for it.';
}

/** Status lines for a recurring-swap card from its due state (recurring.ts dcaDueState). */
export function dcaStatusLines(record: SessionRecord, due: RecurringDue, nativeSymbol: string, shownStatus?: string | null): string[] {
  const lines: string[] = [];
  switch (due.kind) {
    case 'due':
      lines.push(
        due.openSlots > 1
          ? `${due.openSlots} swaps due now (the first since ${formatUtc(due.since)}). ${due.openSlots - 1} ` +
              `${due.openSlots - 1 === 1 ? 'was' : 'were'} missed; your account allows them to be sent now, one at a time.`
          : `Swap due now (since ${formatUtc(due.since)}).`,
      );
      break;
    case 'later':
      lines.push(`Next swap: not before ${formatUtc(due.at)}.`);
      break;
    case 'completed': {
      if (due.reason === 'all-sent') {
        lines.push(`Completed: all ${due.total} swap${due.total === 1 ? ' was' : 's were'} sent.`);
      } else {
        const unsent = Math.max(0, due.total - due.sent);
        const head =
          `Ended ${formatUtc(parseSessionKeyGrant(record.grant).validUntil)}: ${due.sent} of ${due.total} ` +
          `swap${due.total === 1 ? ' was' : 's were'} sent`;
        lines.push(unsent === 0 ? `${head}.` : `${head}; ${unsent} ${unsent === 1 ? 'was' : 'were'} not sent before the end date.`);
      }
      break;
    }
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
  if (due.kind !== 'completed') lines.push(`${due.sent} of ${due.total} swap${due.total === 1 ? '' : 's'} sent.`);
  lines.push(`Fee budget left: ${formatBaseUnits(due.feeBudgetLeftWei, 18)} ${nativeSymbol}.`);
  return lines;
}

/** The card's lines about the last swap (decoded from its receipt), or none. */
export function dcaLastSwapLines(record: SessionRecord): string[] {
  const meta = record.dca;
  if (!meta || !meta.lastSwap) return [];
  const last = meta.lastSwap;
  const terms = dcaTermsOf(record);
  const amount = `${formatBaseUnits(terms.amountIn, meta.decimalsIn)} ${meta.symbolIn}`;
  const quoted = usdc(BigInt(last.quotedOut));
  const asked = usdc(BigInt(last.askedMinimum));
  const floor = usdc(terms.minimumOut);
  const when = formatUtc(last.at);
  const lines: string[] = [];
  switch (last.outcome) {
    case 'swapped':
      lines.push(
        `Last swap (${when}): received ${last.received !== null ? usdc(BigInt(last.received)) : 'an unknown amount of USDC'} ` +
          `for ${amount}; the quote just before sending was ${quoted}, and the swap asked for at least ${asked} ` +
          `(the plan’s minimum is ${floor}).`,
      );
      break;
    case 'reverted':
      lines.push(
        `Last swap (${when}) reverted on-chain and used its period: nothing was swapped and no ${meta.symbolIn} left ` +
          `the account except the network fee. It asked for at least ${asked}; the quote just before sending was ${quoted}.`,
      );
      break;
    case 'pending':
      lines.push(`Last swap (${when}) was handed to the bundler; its outcome is not known yet. Tap Refresh status.`);
      break;
  }
  if (last.batched) {
    lines.push(
      'That operation held more than one swap of the pinned pool, and this wallet sends one per operation. If you did ' +
        'not send it, revoke this plan now.',
    );
  }
  return lines;
}


// ---------------------------------------------------------------------------
// Each period: plan (chain re-read) → confirm → swap
// ---------------------------------------------------------------------------

export interface DcaSwapPlan {
  record: SessionRecord;
  terms: DcaTerms;
  /** Exactly one exactInputSingle call (selling ETH), checked by assertDcaSwap. */
  calls: Call[];
  quote: DcaQuote;
  /** dcaMinimumOutFor(fresh quote, 1%): never below the plan's floor. */
  minimumOut: bigint;
  due: Extract<RecurringDue, { kind: 'due' }>;
  /** Unix seconds when the plan was made (the chain re-read), shown as the swap's time on the card. */
  plannedAt: number;
}

function dcaNotDueMessage(record: SessionRecord, due: RecurringDue): string {
  switch (due.kind) {
    case 'later':
      return `This swap is not due yet: the next one can be sent from ${formatUtc(due.at)}. Nothing was swapped.`;
    case 'completed':
      return due.reason === 'all-sent'
        ? 'Every swap of this plan was already sent. Nothing was swapped.'
        : `This recurring swap ended ${formatUtc(parseSessionKeyGrant(record.grant).validUntil)}. Nothing was swapped.`;
    case 'inactive':
      return 'This recurring swap is not active on-chain (it was revoked). Nothing was swapped.';
    case 'unknown':
      return `Its on-chain status could not be read (${due.reason}), so nothing was swapped.`;
    case 'not-ready':
      return `${due.reason} Nothing was swapped.`;
    case 'due':
      return '';
  }
}

/**
 * Step 1, BEFORE the confirmation: re-reads the on-chain state (never the
 * card), refuses a swap that is not due (a swap before its slot), re-checks
 * the pinned pool against the factory, takes a fresh QuoterV2 quote, asks for
 * dcaMinimumOutFor(quote, 1%) — never below the floor — and builds exactly
 * one swap, checked locally with the engine's assertDcaSwap. Reads no key
 * and contacts no bundler.
 */
export async function planDcaSwap(args: { node: JsonRpcTransport; record: SessionRecord; now?: number }): Promise<DcaSwapPlan> {
  const { record } = args;
  if (record.source !== DCA_SOURCE || !record.dca) throw new Error('Not a recurring swap.');
  assertFeatureAllowed('session-keys', record.chain);
  assertFeatureAllowed('dca', record.chain);
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const status = await readSubscriptionStatus(args.node, record, now);
  if (status.kind === 'unknown' && status.endpointFailure) throw new RecurringStatusUnreachableError(status.reason);
  const due = dcaDueState(record, status, now);
  if (due.kind !== 'due') throw new RecurringNotDueError(dcaNotDueMessage(record, due), due);
  const terms = dcaTermsOf(record);
  const { quote } = await readDcaMarket(args.node, terms.chainId, terms.amountIn);
  const minimumOut = dcaMinimumOutFor(terms, quote.amountOut, DCA_SWAP_SLIPPAGE_BPS);
  const calls = buildDcaSwapCalls(terms, { minimumOut });
  assertDcaSwap(terms, parseSessionKeyGrant(record.grant).sessionKey, calls, now);
  return { record, terms, calls, quote, minimumOut, due, plannedAt: now };
}

/** The confirmation dialog's message for a swap (amounts exact, the minimum and where it comes from, fees, prompts). */
export function dcaConfirmMessage(plan: DcaSwapPlan, context: { nativeSymbol: string }): string {
  const meta = plan.record.dca!;
  const amount = `${formatBaseUnits(plan.terms.amountIn, meta.decimalsIn)} ${meta.symbolIn}`;
  const extra = plan.due.openSlots > 1 ? ` ${plan.due.openSlots} swaps are due; this sends one of them.` : '';
  return (
    `Swap ${amount} for at least ${usdc(plan.minimumOut)} from your smart account ${plan.record.account}.${extra} ` +
    `The quote just now is ${usdc(plan.quote.amountOut)}; this swap asks for that less ` +
    `${bpsText(DCA_SWAP_SLIPPAGE_BPS)}, never less than the plan’s minimum of ${usdc(plan.terms.minimumOut)}. If the ` +
    'pool pays less when the swap runs, it reverts and that period’s swap is used up (only the network fee is lost). ' +
    'The network fee comes from your smart account and counts against the fee budget ' +
    `(${formatBaseUnits(plan.due.feeBudgetLeftWei, 18)} ${context.nativeSymbol} left). ${DCA_PAY_PROMPT_NOTE}`
  );
}

/**
 * The confirm-before-submit rule for swaps: plan → `confirm` (resolves true
 * only for "Swap now") → `pay`. `pay` never runs unless `confirm` resolved
 * exactly true, and a plan that fails never reaches the dialog.
 */
export async function runDcaSwap<T>(steps: {
  plan: () => Promise<DcaSwapPlan>;
  confirm: (plan: DcaSwapPlan) => Promise<boolean>;
  pay: (plan: DcaSwapPlan) => Promise<T>;
}): Promise<{ outcome: 'sent'; plan: DcaSwapPlan; result: T } | { outcome: 'cancelled'; plan: DcaSwapPlan }> {
  const plan = await steps.plan();
  const confirmed = await steps.confirm(plan);
  if (confirmed !== true) return { outcome: 'cancelled', plan };
  const result = await steps.pay(plan);
  return { outcome: 'sent', plan, result };
}

/**
 * Step 2, ONLY after the user confirmed: the swap is checked again (engine
 * assertDcaSwap, no network), then the app-only spending limits on the test
 * ETH it sells (fail closed; no "swap anyway"), then sessions.ts
 * sendSessionCalls (the swap key alone signs through kernelDcaSpec), then
 * the spending history once the bundler accepted it.
 */
export async function payDcaSwap(args: {
  bundle: Parameters<typeof sendSessionCalls>[0]['bundle'];
  plan: DcaSwapPlan;
  vault: SessionKeyVault;
  store?: KeyValueStore;
  now?: number;
}): Promise<{ userOpHash: string; client: SmartAccountClient }> {
  const { plan } = args;
  const record = plan.record;
  if (record.source !== DCA_SOURCE) throw new Error('Not a recurring swap.');
  assertFeatureAllowed('session-keys', record.chain);
  assertFeatureAllowed('dca', record.chain);
  const now = args.now ?? Math.floor(Date.now() / 1000);
  assertDcaSwap(plan.terms, parseSessionKeyGrant(record.grant).sessionKey, plan.calls, now);
  const scope: SpendingScope = { chain: record.chain, owner: record.owner };
  const check = await evaluateBeforeSigning({
    scope,
    spender: record.account,
    calls: plan.calls,
    fee: 0n,
    now,
    ...(args.store ? { store: args.store } : {}),
  });
  if (check.status === 'unreadable') throw new RecurringSpendingError(check.title, `${check.message} Nothing was swapped.`);
  if (check.status === 'blocked') {
    const lines = check.results.filter((r) => r.entry.exceeds).map((r) => overLimitSentence(r.policy, r.entry));
    throw new RecurringSpendingError(
      SPENDING_BLOCK_TITLE,
      [
        ...lines,
        SPENDING_HONESTY_SENTENCE,
        'Recurring swaps are never sent over a limit. Raise or remove the limit in Settings → Spending limits (this ' +
          'app only), or revoke the recurring swap. Nothing was swapped.',
      ].join('\n\n'),
    );
  }
  const sent = await sendSessionCalls({
    bundle: args.bundle,
    record,
    calls: plan.calls,
    vault: args.vault,
    now,
    // Counted before the broadcast (./broadcast-spend.ts), as recordAcceptedSpend below counts it.
    spend: { chain: scope.chain, owner: scope.owner, spender: record.account, calls: plan.calls, fee: 0n, now, ...(args.store ? { store: args.store } : {}) },
  });
  await recordAcceptedSpend({
    scope,
    spender: record.account,
    calls: plan.calls,
    fee: 0n,
    ref: sent.userOpHash,
    now,
    ...(args.store ? { store: args.store } : {}),
  });
  return sent;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/** The logs of a bundler's UserOperation receipt: the bundle transaction's logs, else the op's own. */
export function dcaLogsFromReceipt(receipt: unknown): DcaLog[] {
  if (typeof receipt !== 'object' || receipt === null) return [];
  const r = receipt as { receipt?: { logs?: unknown }; logs?: unknown };
  const raw = Array.isArray(r.receipt?.logs) ? r.receipt!.logs : Array.isArray(r.logs) ? r.logs : [];
  const logs: DcaLog[] = [];
  for (const l of raw as unknown[]) {
    if (typeof l !== 'object' || l === null) continue;
    const x = l as { address?: unknown; topics?: unknown; data?: unknown };
    if (typeof x.address !== 'string' || !Array.isArray(x.topics) || typeof x.data !== 'string') continue;
    if (!x.topics.every((t) => typeof t === 'string')) continue;
    logs.push({ address: x.address, topics: x.topics as string[], data: x.data });
  }
  return logs;
}

/**
 * The card's record of a swap, from the plan and (when there is one) the
 * receipt, decoded with the engine's decodeDcaOutcome: 'swapped' when the
 * EntryPoint reported success, 'reverted' when the operation was included
 * but the swap reverted (it used its period), 'pending' without a receipt.
 */
export function dcaLastSwapFrom(args: {
  terms: DcaTerms;
  /** The fresh quote just before sending and the minimum the swap asked for (base units). */
  quotedOut: bigint;
  minimumOut: bigint;
  userOpHash: string;
  at: number;
  receipt: unknown | null;
  txHash: string | null;
  /** The receipt summary's success flag (aa.ts summarizeAaReceipt), used when the logs carry no UserOperationEvent. */
  success: boolean | null;
}): DcaLastSwap {
  const base = {
    userOpHash: args.userOpHash,
    txHash: args.txHash,
    at: args.at,
    quotedOut: args.quotedOut.toString(10),
    askedMinimum: args.minimumOut.toString(10),
  };
  if (args.receipt === null) return { ...base, outcome: 'pending', received: null, batched: false };
  const outcome = decodeDcaOutcome(args.terms, dcaLogsFromReceipt(args.receipt), { userOpHash: args.userOpHash });
  const success = outcome.userOpSuccess ?? args.success;
  if (success === true) {
    return { ...base, outcome: 'swapped', received: outcome.tokenOutReceived.toString(10), batched: outcome.batched };
  }
  if (success === false) return { ...base, outcome: 'reverted', received: null, batched: outcome.batched };
  return { ...base, outcome: 'pending', received: null, batched: outcome.batched };
}

/** The progress screen's line for a settled swap. */
export function dcaOutcomeLine(last: DcaLastSwap, terms: DcaTerms, nativeSymbol: string): string {
  const amount = `${formatBaseUnits(terms.amountIn, 18)} ${nativeSymbol}`;
  if (last.outcome === 'swapped') {
    return (
      `Received ${last.received !== null ? usdc(BigInt(last.received)) : 'an unknown amount of USDC'} for ${amount} ` +
      `(the quote just before sending was ${usdc(BigInt(last.quotedOut))}; the swap asked for at least ` +
      `${usdc(BigInt(last.askedMinimum))}).`
    );
  }
  if (last.outcome === 'reverted') {
    return (
      'The swap reverted on-chain and used its period: nothing was swapped and no test ETH left the account except ' +
      'the network fee.'
    );
  }
  return 'The outcome is not known yet; the card reads it again when you tap Refresh status.';
}

// ---------------------------------------------------------------------------
// Refusals in plain words
// ---------------------------------------------------------------------------

const ERR = {
  callValue: toHex(abiSelector('CallViolatesValueRule()')),
  callParam: toHex(abiSelector('CallViolatesParamRule()')),
  policyFailed: toHex(abiSelector('PolicyFailed(uint256)')),
};

/** Policy order of a DCA permission (the subscription template: engine kernelPermissionFromGrant). */
const POLICY_MEANING = [
  'the swap is not one this plan allows (pair, pool, amount, recipient or minimum)',
  'the recurring swap is outside its dates',
  'the fee budget is used up',
  'every swap this plan allows was already sent, or the next one is not due yet',
];

export const DCA_REFUSED_TITLE = 'Swap not sent';
export const DCA_OUTCOME_UNKNOWN_TITLE = 'Swap status unknown';

export const DCA_NOT_SENT_SENTENCE =
  'The swap was not handed to the bundler, so nothing was swapped and none of the allowed swaps was used up. Try ' +
  'again once the connection is back.';

export const DCA_OUTCOME_UNKNOWN_SENTENCE =
  'No usable answer came back from the bundler while the swap was being sent, so this wallet cannot tell whether ' +
  'the bundler received it. ' +
  'The account’s nonce for this swap key decides: if the bundler received the swap, it will be included and this ' +
  'card will count it as sent; if not, nothing was swapped. Wait a minute, then tap Refresh status before sending ' +
  'again: if the first one went through, sending again would send the next due swap as well.';

/**
 * The bundler answered eth_sendUserOperation with an HTTP 5xx (the
 * bounded-broadcast follow-ups): it may have accepted the swap. Never worded
 * as "not sent".
 */
export const DCA_SERVER_ERROR_SENTENCE =
  'The bundler answered with a server error while the swap was being sent, so this wallet does not know whether ' +
  'it received the swap: it may have accepted it. The account’s nonce for this swap key decides: if the bundler ' +
  'received the swap, it will be included and this card will count it as sent; if not, nothing was swapped. Wait ' +
  'a minute, then tap Refresh status before sending again: if the first one went through, sending again would ' +
  'send the next due swap as well. It is also listed under Pending on this phone in Activity.';

/**
 * The bundler did not answer eth_sendUserOperation within the engine's
 * BROADCAST_TIMEOUT_MS (phase 23 item 8): the swap may or may not have
 * reached it. Never worded as "not sent".
 */
export const DCA_NO_ANSWER_SENTENCE =
  `The bundler did not answer within ${Math.round(BROADCAST_TIMEOUT_MS / 1000)} seconds, so this wallet does not ` +
  'know whether it received the swap. The account’s nonce for this swap key decides: if the bundler received the ' +
  'swap, it will be included and this card will count it as sent; if not, nothing was swapped. Wait a minute, then ' +
  'tap Refresh status before sending again: if the first one went through, sending again would send the next due ' +
  'swap as well. It is also listed under Pending on this phone in Activity.';

/** The plain sentence for an account or bundler refusal of a swap, or null. */
export function dcaRefusalSentence(message: string): string | null {
  const m = message.toLowerCase();
  if (/aa22 expired or not due/.test(m)) {
    return 'Your account refused this swap: it is not due yet, or the recurring swap has ended. Nothing was swapped.';
  }
  if (m.includes(ERR.callValue)) {
    return 'Your account refused this swap: it would send more test ETH than the plan’s amount. Nothing was swapped.';
  }
  if (m.includes(ERR.callParam)) {
    return 'Your account refused this swap: its pair, pool, amount, recipient or minimum is outside the plan. Nothing was swapped.';
  }
  const policy = new RegExp(`${ERR.policyFailed}([0-9a-f]{64})`).exec(m);
  if (policy) {
    const index = Number(BigInt(`0x${policy[1]}`));
    return `Your account refused this swap: ${POLICY_MEANING[index] ?? `policy ${index} refused it`}. Nothing was swapped.`;
  }
  if (/aa23 reverted 0x(?![0-9a-f])/.test(m)) {
    return 'Your account refused this swap: the permission is not installed any more (it was revoked). Nothing was swapped.';
  }
  if (/aa21 didn.t pay prefund/.test(m)) {
    return 'Your smart account cannot pay this swap’s amount and network fee. Fund the smart account, then try again. Nothing was swapped.';
  }
  if (/too little received/.test(m)) {
    return (
      'The pool would pay less than this swap’s minimum right now (the price moved), so the bundler did not accept ' +
      'it. Nothing was swapped and the period was not used; you can try again later.'
    );
  }
  return null;
}

/**
 * Every error of the swap steps in plain words, with what happened to the
 * swap (the recurring-payment rules of describeRecurringPaymentError, in swap
 * words): not due / spending limits → 'refused'; a status read the endpoint
 * did not answer, a node failure, or a bundler failure before the submission
 * → 'not-sent'; any other transport failure → 'outcome-unknown'; the
 * account's own refusals → 'refused'; else the session wording → 'failed'.
 * Never a raw platform exception.
 */
export function describeDcaSwapError(
  error: unknown,
  context: { accountType: AaAccountType; symbol: string },
  describeSend: (error: unknown, symbol: string) => { title: string; detail: string },
): { title: string; detail: string; outcome: RecurringAttemptOutcome; cause?: RecurringOutcomeCause } {
  if (error instanceof RecurringNotDueError) {
    return { title: DCA_REFUSED_TITLE, detail: error.message, outcome: error.due.kind === 'unknown' ? 'failed' : 'refused' };
  }
  if (error instanceof RecurringSpendingError) return { title: error.title, detail: error.message, outcome: 'refused' };
  const withTechnical = (sentence: string, technical: string) => (technical ? `${sentence}\n\nTechnical detail: ${technical}` : sentence);
  if (error instanceof RecurringStatusUnreachableError) {
    const m = /\((.+)\)$/.exec(error.reason);
    return {
      title: SESSION_UNREACHABLE_TITLE,
      detail: withTechnical(`${NO_ANSWER_SENTENCE} ${DCA_NOT_SENT_SENTENCE}`, m ? `${m[1]}.` : ''),
      outcome: 'not-sent',
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  // No answer to the submission itself in time (phase 23 item 8).
  if (isBroadcastOutcomeUnknown(error)) {
    // No answer in time, a server error, or a connection that failed while it
    // was handed over (the bounded-broadcast follow-ups): none "not sent".
    const technical = (error as { technical?: unknown }).technical;
    const cause = recurringOutcomeCause(error);
    const sentence =
      cause === 'no-answer'
        ? DCA_NO_ANSWER_SENTENCE
        : cause === 'server-error'
          ? DCA_SERVER_ERROR_SENTENCE
          : `${DCA_OUTCOME_UNKNOWN_SENTENCE} It is also listed under Pending on this phone in Activity.`;
    return {
      title: DCA_OUTCOME_UNKNOWN_TITLE,
      detail: withTechnical(sentence, sanitizeEndpointMessage(typeof technical === 'string' ? technical : message)),
      outcome: 'outcome-unknown',
      cause,
    };
  }
  if (isTransportFailure(error)) {
    const technical = sanitizeEndpointMessage(message);
    if (isNodeEndpointFailure(error) || isBundlerTransportFailureBeforeSubmit(error)) {
      return { title: SESSION_UNREACHABLE_TITLE, detail: withTechnical(`${NO_ANSWER_SENTENCE} ${DCA_NOT_SENT_SENTENCE}`, technical), outcome: 'not-sent' };
    }
    return { title: DCA_OUTCOME_UNKNOWN_TITLE, detail: withTechnical(DCA_OUTCOME_UNKNOWN_SENTENCE, technical), outcome: 'outcome-unknown', cause: 'connection' };
  }
  const refusal = dcaRefusalSentence(message);
  if (refusal) return { title: DCA_REFUSED_TITLE, detail: withTechnical(refusal, sanitizeEndpointMessage(message)), outcome: 'refused' };
  return {
    ...describeSessionError(error, { accountType: context.accountType, symbol: context.symbol, stage: 'send' }, describeSend),
    outcome: 'failed',
  };
}

/**
 * The card's one-line note after a swap attempt that did not go through.
 * `cause` (describeDcaSwapError's) names why an open outcome is open; the
 * line without it says that no usable answer came back (recurring.ts
 * OPEN_OUTCOME_NO_USABLE_ANSWER).
 */
export function dcaAttemptLine(outcome: RecurringAttemptOutcome, detail: string, cause?: RecurringOutcomeCause): string {
  const first = detail.split('\n\n')[0];
  switch (outcome) {
    case 'refused':
      return `Last swap attempt refused: ${first}`;
    case 'not-sent':
      return 'Last swap attempt not sent: the network could not be reached before the swap was handed to the bundler, ' +
        'so nothing was swapped. Try again once the connection is back.';
    case 'outcome-unknown':
      return `Last swap attempt: outcome unknown (${openOutcomeParenthesis(cause)}). Tap Refresh status ` +
        'and wait for the count before sending again.';
    case 'failed':
      return `Last swap attempt failed: ${first}`;
  }
}


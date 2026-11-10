import {
  AAVE_RAY,
  LENDING_REFUSALS,
  LendingStateError,
  checkLendingCalls,
  decodeLendingReceipt,
  describeAaveError,
  encodeFunctionCall,
  formatLendingUnits,
  httpTransport as evmHttpTransport,
  lendingDeploymentFor,
  quoteLendingSupply,
  quoteLendingWithdraw,
  readLendingPosition,
  readReserveState,
  toHex,
  type Call,
  type JsonRpcTransport,
  type LendingDeployment,
  type LendingPosition,
  type LendingQuote,
  type LendingReceipt,
  type ReceiptLog,
  type ReserveState,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is loaded by scripts/check-lending.mjs
// under Node's type stripping, which resolves relative specifiers literally
// (the staking.ts / swap.ts precedent).
import { describeSendError, prepareEvmSend, type EvmSendQuote } from './send.ts';
import { prepareAaCalls, type AaClientBundle, type AaSendQuote } from './aa.ts';
import { assertFeatureAllowed, isFeatureAllowed, readinessRefusal } from '../config/readiness.ts';
import { evmProfileByCaip2, isBuiltInEvmChain } from '../config/evm-chain.ts';
import { t, translateIn, type Params, type StringId } from '../i18n/index.ts';

/**
 * Lending glue (feature 61, phase 26 item 2, the app half; design in
 * docs/LENDING_VAULTS.md sections 7 and 10). Everything protocol-specific
 * lives in the engine (packages/chains-evm/src/lending.ts: Aave v3's pinned
 * Arbitrum Sepolia addresses, the reserve reader that re-checks every pinned
 * fact, the quotes with their refusals, the check before signing, Aave's
 * error sentences and the receipt decoder). This module decides what is
 * OFFERED where and for whom, reads the live reserve and the position, and
 * reshapes a quote into the EXISTING send paths — prepareEvmSend for the
 * regular account (an exact approve first when the allowance is short, then
 * the supply: the Staking wrap's two steps) and prepareAaCalls for a Kernel
 * smart account (one all-or-nothing batch). There is no second signing or
 * broadcast path here, and no engine function is re-implemented: every call
 * comes from the engine's quote and passes the engine's checkLendingCalls
 * before anything is shown or quoted.
 *
 * WHAT IS OFFERED: supply and withdraw of Circle's test USDC on Aave v3's
 * Arbitrum Sepolia test market only (the one LENDING_DEPLOYMENTS entry), on
 * a built-in profile, behind the readiness row 'lending' (test networks
 * only, enforced). No borrowing. The supply is always credited to the
 * sending account and a withdrawal always paid to it (the engine refuses
 * anything else; Aave itself would accept another address, section 10.4).
 *
 * WHO: the regular account (a phrase-derived or imported key); the smart
 * account only when it is a Kernel v3.3 account set up for the network
 * (factory-derived or recovered) on a profile whose Kernel contracts were
 * verified. Refused with a plain sentence: a watch-only address, a
 * multi-signature account, an EIP-7702-upgraded owner (its smart account is
 * the regular address itself, so the regular path serves it), SimpleAccount.
 *
 * Sentences built by the engine (the quote refusals, LendingStateError's
 * problems, Aave's error sentences, checkLendingCalls' problems) are shown as
 * the engine wrote them, in English, as on the Bridge and Staking screens;
 * this module's own sentences go through the string table.
 */

/** A plain refusal from this module: its message is the whole sentence to show; nothing was quoted, signed or sent. */
export class LendingRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LendingRefusal';
  }
}

/** The one network lending is offered on in this version (LENDING_DEPLOYMENTS). */
export const LENDING_CHAIN = 'eip155:421614';

/** Exact base units of the reserve's asset or aToken (every digit). */
export function formatLending(units: bigint, deployment: LendingDeployment): string {
  return formatLendingUnits(units, deployment.asset.decimals);
}

// ---------------------------------------------------------------------------
// What is offered where, and for whom
// ---------------------------------------------------------------------------

export type LendingOffer =
  | { ok: true; deployment: LendingDeployment }
  | { ok: false; reason: 'readiness' | 'network'; text: string };

/**
 * Whether lending is offered on `caip2`: the readiness row first (a main
 * network gets the readiness refusal), then a deployment the engine pins
 * for a BUILT-IN profile (a network the user added is offered nothing: the
 * pinned addresses were checked for the built-in network). No request.
 */
export function lendingOfferFor(caip2: string): LendingOffer {
  if (!isFeatureAllowed('lending', caip2)) return { ok: false, reason: 'readiness', text: readinessRefusal('lending') };
  const deployment = isBuiltInEvmChain(caip2) ? lendingDeploymentFor(caip2) : null;
  if (!deployment) {
    return { ok: false, reason: 'network', text: LENDING_REFUSALS.notOffered(evmProfileByCaip2(caip2)?.label ?? caip2) };
  }
  return { ok: true, deployment };
}

/** The offer's deployment, or a LendingRefusal with the offer's sentence (the gate every entry point passes). */
export function requireLendingDeployment(caip2: string): LendingDeployment {
  assertFeatureAllowed('lending', caip2);
  const offer = lendingOfferFor(caip2);
  if (!offer.ok) throw new LendingRefusal(offer.text);
  return offer.deployment;
}

export interface LendingAccountFacts {
  watchOnly: boolean;
  multisig?: boolean;
}

/** The refusal for an account that cannot lend from this wallet, or null. */
export function lendingAccountRefusal(account: LendingAccountFacts | null): string | null {
  if (!account) return t('lend.refusal.noAccount');
  if (account.watchOnly) return t('lend.refusal.watchOnly');
  if (account.multisig === true) return t('lend.refusal.multisig');
  return null;
}

/** Whether Home shows the "Lend (Aave)" link (the screen refuses everything else again). */
export function lendingLinkShown(caip2: string, account: LendingAccountFacts | null): boolean {
  return lendingAccountRefusal(account) === null && lendingOfferFor(caip2).ok;
}

/**
 * Null when the smart account may lend on `caip2`; else the sentence. Only a
 * Kernel v3.3 account (factory-derived or recovered: aa.ts
 * effectiveAaAccountType gives 'kernel-v3.3' for both) that is configured
 * for the network, on a profile whose Kernel contracts were verified.
 */
export function lendingSmartAccountRefusal(caip2: string, accountType: string | null, configured: boolean): string | null {
  const profile = evmProfileByCaip2(caip2);
  if (!profile || !isBuiltInEvmChain(caip2) || profile.kernelV33Verified !== true) return t('lend.smart.notVerified');
  if (accountType === 'kernel-7702') return t('lend.smart.refused7702');
  if (accountType === 'simple') return t('lend.smart.refusedSimple');
  if (accountType === 'kernel-multisig') return t('lend.refusal.multisig');
  if (!configured || accountType !== 'kernel-v3.3') return t('lend.smart.unavailable');
  return null;
}

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

export interface LendingView {
  deployment: LendingDeployment;
  state: ReserveState;
  /** The holder's position and USDC, read at the reserve's block. */
  position: LendingPosition;
}

/** Throws a LendingRefusal unless the endpoint serves `caip2`. */
async function assertEndpointChain(node: JsonRpcTransport, caip2: string): Promise<void> {
  const raw = await node('eth_chainId', []);
  const chainId = typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw) ? BigInt(raw) : null;
  if (chainId === null || `eip155:${chainId}` !== caip2) {
    throw new LendingRefusal(t('lend.refusal.wrongChain', { chain: chainId === null ? '?' : chainId.toString() }));
  }
}

/**
 * The reserve (every pinned fact re-checked by the engine at one block) and
 * the holder's position at the same block. A changed pinned fact throws a
 * LendingRefusal carrying the engine's sentences.
 */
export async function readLendingView(node: JsonRpcTransport, caip2: string, holder: string): Promise<LendingView> {
  const deployment = requireLendingDeployment(caip2);
  await assertEndpointChain(node, caip2);
  let state: ReserveState;
  try {
    state = await readReserveState(node, deployment);
  } catch (e) {
    if (e instanceof LendingStateError) throw new LendingRefusal(t('lend.refusal.stateChanged', { problems: e.message }));
    throw e;
  }
  const position = await readLendingPosition(node, deployment, holder, { blockTag: state.block });
  return { deployment, state, position };
}

/** The supply rate as "4.29" (percent a year, two decimals, rounded down), from the ray the data provider reports. */
export function supplyRatePercent(liquidityRateRay: bigint): string {
  const hundredths = (liquidityRateRay * 10_000n) / AAVE_RAY;
  const whole = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

/** The reserve card's lines, each a plain sentence (docs/LENDING_VAULTS.md section 7.4 asks for these). */
export function reserveStateLines(view: { deployment: LendingDeployment; state: ReserveState }): string[] {
  const { deployment: d, state: s } = view;
  const fmt = (u: bigint) => formatLending(u, d);
  const status = !s.active
    ? t('lend.reserve.inactive', { symbol: d.asset.symbol })
    : s.paused
      ? t('lend.reserve.paused', { symbol: d.asset.symbol })
      : s.frozen
        ? t('lend.reserve.frozen', { symbol: d.asset.symbol })
        : t('lend.reserve.open', { symbol: d.asset.symbol });
  const lines = [t('lend.reserve.readAt', { block: s.block.toString() }), status];
  if (s.supplyCapBaseUnits === null) {
    lines.push(t('lend.reserve.noCap'));
  } else {
    const room = s.supplyCapBaseUnits > s.suppliedForCap ? s.supplyCapBaseUnits - s.suppliedForCap : 0n;
    lines.push(t('lend.reserve.cap', { cap: s.supplyCap.toString(), supplied: fmt(s.suppliedForCap), room: fmt(room), symbol: d.asset.symbol }));
  }
  lines.push(t('lend.reserve.liquidity', { liquidity: fmt(s.availableLiquidity), symbol: d.asset.symbol }));
  lines.push(t('lend.reserve.rate', { rate: supplyRatePercent(s.liquidityRateRay) }));
  return lines;
}

// ---------------------------------------------------------------------------
// Plans: an action → the engine's quote, checked before anything is shown
// ---------------------------------------------------------------------------

export type LendingAction = { kind: 'supply'; amount: bigint } | { kind: 'withdraw'; amount: bigint | 'all' };

export interface LendingPlan {
  caip2: string;
  deployment: LendingDeployment;
  /** The address the plan was read and quoted for (the EOA, or the smart account). */
  holder: string;
  action: LendingAction;
  /** The engine's quote (calls non-empty: a refused quote never becomes a plan). */
  quote: LendingQuote;
  state: ReserveState;
  position: LendingPosition;
  /** Every call, in order (a smart account runs them as one batch). */
  calls: Call[];
  /** The call that does the work (the last one). */
  main: Call;
  /** The exact approval a supply needs first (null for a withdrawal). */
  approval: { token: string; spender: string; amount: bigint; symbol: string } | null;
  /** The USDC leaving the holder (a supply), for the spending-limit gate. */
  tokenOutflow: { token: string; amount: bigint } | null;
}

/**
 * Plans one action: reads the reserve and the position, asks the engine for
 * the quote (its refusals become one LendingRefusal), then runs the engine's
 * checkLendingCalls on the quoted calls BEFORE the plan exists, so nothing
 * unchecked is ever shown or quoted.
 */
export async function planLending(node: JsonRpcTransport, caip2: string, holder: string, action: LendingAction): Promise<LendingPlan> {
  const view = await readLendingView(node, caip2, holder);
  const { deployment: d, state, position } = view;
  const quote =
    action.kind === 'supply'
      ? quoteLendingSupply({ deployment: d, state, account: holder, amount: action.amount, walletBalance: position.walletBalance })
      : quoteLendingWithdraw({ deployment: d, state, account: holder, amount: action.amount, supplied: position.supplied });
  if (quote.refusals.length > 0) throw new LendingRefusal(quote.refusals.join(' '));
  const problems = checkLendingCalls(quote.calls, d, holder);
  if (problems.length > 0) throw new LendingRefusal(t('lend.refusal.checkFailed', { problems: problems.join(' ') }));
  const main = quote.calls[quote.calls.length - 1]!;
  return {
    caip2,
    deployment: d,
    holder,
    action,
    quote,
    state,
    position,
    calls: quote.calls,
    main,
    approval: action.kind === 'supply' ? { token: d.asset.address, spender: d.pool, amount: quote.amount, symbol: d.asset.symbol } : null,
    tokenOutflow: action.kind === 'supply' ? { token: d.asset.address, amount: quote.amount } : null,
  };
}

// ---------------------------------------------------------------------------
// Reshaping into the existing send paths
// ---------------------------------------------------------------------------

export type LendingEoaQuote = { step: 'approve'; quote: EvmSendQuote; allowance: bigint } | { step: 'main'; quote: EvmSendQuote };

/** allowance(owner, spender) on `token`, at the latest block. */
export async function readLendingAllowance(node: JsonRpcTransport, token: string, owner: string, spender: string): Promise<bigint> {
  const data = encodeFunctionCall('allowance(address,address)', [
    { kind: 'address', value: owner },
    { kind: 'address', value: spender },
  ]);
  const raw = await node('eth_call', [{ to: token, data: toHex(data) }, 'latest']);
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error('The node returned no allowance.');
  return BigInt(raw);
}

/** Re-runs the engine's check on exactly the calls about to be quoted; a problem refuses. */
function checkBeforeQuote(calls: readonly Call[], plan: LendingPlan): void {
  const problems = checkLendingCalls(calls, plan.deployment, plan.holder);
  if (problems.length > 0) throw new LendingRefusal(t('lend.refusal.checkFailed', { problems: problems.join(' ') }));
}

/**
 * The regular-account quote through prepareEvmSend (chain-id check, fee,
 * balance, eth_call pre-flight). A supply whose allowance is short is quoted
 * as its EXACT approve first (the plan's first call, never unlimited); the
 * caller quotes again once the approval has taken effect and gets the
 * supply. A withdrawal is one call.
 */
export async function prepareLendingSend(url: string, from: string, plan: LendingPlan): Promise<LendingEoaQuote> {
  assertFeatureAllowed('lending', plan.caip2);
  if (plan.holder.toLowerCase() !== from.toLowerCase()) throw new LendingRefusal(t('lend.refusal.otherAddress'));
  if (plan.approval) {
    const allowance = await readLendingAllowance(evmHttpTransport(url), plan.approval.token, from, plan.approval.spender);
    if (allowance < plan.approval.amount) {
      const approve = plan.calls[0]!;
      checkBeforeQuote([approve], plan);
      const quote = await prepareEvmSend(url, from, approve.to, approve.value, approve.data, plan.caip2);
      return { step: 'approve', quote, allowance };
    }
  }
  checkBeforeQuote([plan.main], plan);
  const quote = await prepareEvmSend(url, from, plan.main.to, plan.main.value, plan.main.data, plan.caip2);
  return { step: 'main', quote };
}

/**
 * The smart-account quote through prepareAaCalls: the plan's calls as ONE
 * operation ([exact approve, supply] or [withdraw]), checked again first.
 * Refused where the smart account may not lend, for another network's
 * setup, and when the plan was read for another address than the account.
 */
export async function prepareLendingAa(
  bundle: AaClientBundle,
  ownerAddress: string,
  plan: LendingPlan,
  accountType: string | null,
  configured: boolean,
): Promise<AaSendQuote> {
  assertFeatureAllowed('lending', plan.caip2);
  const refusal = lendingSmartAccountRefusal(plan.caip2, accountType, configured);
  if (refusal) throw new LendingRefusal(refusal);
  if (`eip155:${bundle.chainId}` !== plan.caip2) throw new LendingRefusal(t('lend.refusal.otherNetworkSetup'));
  checkBeforeQuote(plan.calls, plan);
  const quote = await prepareAaCalls(bundle, ownerAddress, plan.calls, {
    displayTo: plan.main.to,
    ...(plan.tokenOutflow
      ? { tokenSpend: { contract: plan.tokenOutflow.token, amount: plan.tokenOutflow.amount, symbol: plan.deployment.asset.symbol } }
      : {}),
  });
  if (quote.sender.toLowerCase() !== plan.holder.toLowerCase()) throw new LendingRefusal(t('lend.refusal.otherSmartAccount'));
  return quote;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function actionText(plan: Pick<LendingPlan, 'action' | 'quote' | 'deployment'>, text: (id: StringId, params?: Params) => string): string {
  const d = plan.deployment;
  if (plan.action.kind === 'supply') return text('lend.action.supply', { amount: formatLending(plan.quote.amount, d), symbol: d.asset.symbol });
  if (plan.quote.all) return text('lend.action.withdrawAll', { symbol: d.asset.symbol });
  return text('lend.action.withdraw', { amount: formatLending(plan.quote.amount, d), symbol: d.asset.symbol });
}

/** The device prompt's title: always English (the localisation passes keep prompt titles English by rule). */
export function lendingActionTitle(plan: Pick<LendingPlan, 'action' | 'quote' | 'deployment'>): string {
  return actionText(plan, (id, params) => translateIn('en', id, params));
}

/** The same label for buttons and the success line, in the chosen language. */
export function lendingActionLabel(plan: Pick<LendingPlan, 'action' | 'quote' | 'deployment'>): string {
  return actionText(plan, t);
}

/** The calls in words, for the confirm (one sentence per call). */
export function lendingCallLines(plan: Pick<LendingPlan, 'calls' | 'deployment' | 'holder' | 'quote' | 'action'>): string[] {
  const d = plan.deployment;
  const network = d.networkName;
  return plan.calls.map((call, i) => {
    const n = plan.calls.length > 1 ? `${i + 1}. ` : '';
    const sel = toHex(call.data.slice(0, 4));
    if (call.to.toLowerCase() === d.asset.address.toLowerCase()) {
      return n + t('lend.call.approve', { amount: formatLending(plan.quote.amount, d), symbol: d.asset.symbol, pool: d.pool, network, token: d.asset.address });
    }
    if (plan.action.kind === 'supply') {
      return n + t('lend.call.supply', { amount: formatLending(plan.quote.amount, d), symbol: d.asset.symbol, pool: d.pool, network, holder: plan.holder, aSymbol: d.aToken.symbol, selector: sel });
    }
    return n + (plan.quote.all
      ? t('lend.call.withdrawAll', { symbol: d.asset.symbol, pool: d.pool, network, holder: plan.holder, selector: sel })
      : t('lend.call.withdraw', { amount: formatLending(plan.quote.amount, d), symbol: d.asset.symbol, pool: d.pool, network, holder: plan.holder, selector: sel }));
  });
}

/**
 * An error as the Send screen's title and detail. A refusal of this module,
 * a readiness refusal or the engine's state check is its own sentence; an
 * Aave revert (numeric code, custom error or a node's "execution reverted:
 * 51") becomes the engine's describeAaveError sentence under its own title;
 * anything else is the Send screen's wording (describeSendError).
 */
export function describeLendingError(e: unknown, symbol: string): { title: string; detail: string } {
  const message = e instanceof Error ? e.message : String(e);
  const name = (e as { name?: unknown } | null)?.name;
  if (e instanceof LendingRefusal || name === 'FeatureNotAllowedError' || e instanceof LendingStateError) {
    return { title: t('lend.error.notQuoted'), detail: message };
  }
  const data = (e as { data?: unknown } | null)?.data;
  const reason = (e as { reason?: unknown } | null)?.reason;
  const aave =
    (typeof data === 'string' ? describeAaveError(data) : null) ??
    (typeof reason === 'string' ? describeAaveError(`execution reverted: ${reason}`) : null) ??
    describeAaveError(message);
  if (aave) return { title: t('lend.error.aaveTitle'), detail: `${aave}\n${t('lend.error.technical', { detail: message })}` };
  return describeSendError(e, symbol, symbol);
}

/** A failed pre-flight's reason, with Aave's sentence in front when the reason carries an Aave code. */
export function lendingSimulationText(reason: string): string {
  const aave = describeAaveError(reason);
  return aave ? `${aave} (${reason})` : reason;
}

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

function asLog(x: unknown): ReceiptLog | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as Record<string, unknown>;
  if (typeof r.address !== 'string' || !Array.isArray(r.topics) || typeof r.data !== 'string') return null;
  if (!r.topics.every((t) => typeof t === 'string')) return null;
  return { address: r.address, topics: r.topics as string[], data: r.data };
}

/**
 * The logs of a receipt: a transaction receipt's `logs`, or for a bundler's
 * eth_getUserOperationReceipt the nested transaction receipt's logs (else
 * the operation's own `logs`). Malformed entries are skipped.
 */
export function receiptLogsOf(receipt: unknown): ReceiptLog[] {
  if (typeof receipt !== 'object' || receipt === null) return [];
  const r = receipt as Record<string, unknown>;
  const inner = typeof r.receipt === 'object' && r.receipt !== null ? (r.receipt as Record<string, unknown>).logs : undefined;
  const list = Array.isArray(inner) ? inner : Array.isArray(r.logs) ? r.logs : [];
  return list.map(asLog).filter((l): l is ReceiptLog => l !== null);
}

/** Polls eth_getTransactionReceipt until it answers (null on timeout). */
export async function waitForTransactionReceipt(
  node: JsonRpcTransport,
  hash: string,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Record<string, unknown> | null> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 3_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
    try {
      const receipt = await node('eth_getTransactionReceipt', [hash]);
      if (typeof receipt === 'object' && receipt !== null) return receipt as Record<string, unknown>;
    } catch {
      // a failed read is "not yet"
    }
    if (waited + pollMs > timeoutMs) break;
    await sleep(pollMs);
  }
  return null;
}

/**
 * The success view's sentences from the receipt's logs (the engine's
 * decodeLendingReceipt: only the pinned Pool's events) and the position read
 * after it. Only events for the holder are described; none is said plainly.
 */
export function lendingOutcomeLines(logs: readonly ReceiptLog[], plan: Pick<LendingPlan, 'deployment' | 'holder'>, positionAfter: bigint | null): string[] {
  const d = plan.deployment;
  const fmt = (u: bigint) => formatLending(u, d);
  let decoded: LendingReceipt;
  try {
    decoded = decodeLendingReceipt(logs, d);
  } catch (e) {
    return [t('lend.outcome.unreadable', { detail: e instanceof Error ? e.message : String(e) })];
  }
  const me = plan.holder.toLowerCase();
  const position = positionAfter === null ? t('lend.outcome.positionUnread') : t('lend.outcome.position', { position: fmt(positionAfter), symbol: d.asset.symbol, aSymbol: d.aToken.symbol });
  const lines: string[] = [];
  for (const s of decoded.supplies) {
    if (s.onBehalfOf.toLowerCase() === me) lines.push(t('lend.outcome.supplied', { amount: fmt(s.amount), symbol: d.asset.symbol, position }));
  }
  for (const w of decoded.withdrawals) {
    if (w.to.toLowerCase() === me) lines.push(t('lend.outcome.withdrawn', { amount: fmt(w.amount), symbol: d.asset.symbol, position }));
  }
  if (lines.length === 0) lines.push(t('lend.outcome.none'));
  return lines;
}

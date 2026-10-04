import { encodeFunctionCall, selector as abiSelector } from './abi.js';
import { toBytes, toHex, toWord } from './encoding.js';
import {
  KERNEL_PERMISSION_MODULES,
  assertCallsAllowed,
  kernelSessionSpec,
  validateSessionKeyGrant,
  type KernelPermissionModules,
  type KernelSessionSpec,
  type SessionAllowedCall,
  type SessionKeyGrant,
} from './kernel-permissions.js';
import type { JsonRpcTransport } from './rpc.js';
import type { Call } from './smart-account.js';

/**
 * Non-custodial subscriptions on Kernel v3.3 session keys (phase 12 item 2).
 *
 * A subscription is an ordinary session-key grant (kernel-permissions.ts)
 * with exactly ONE allowed call — "pay this merchant at most X of this token"
 * — plus a rate limit of one operation per period, a validity window and a
 * fee budget. The merchant (or a keeper acting for it) holds only the session
 * key; the subscriber's account enforces the limits on-chain, and the seed
 * owner can revoke the grant at any time (permissionRevokeCall).
 *
 * POLICY FACTS, from the deployed sources (Sourcify full matches on chain 1,
 * fetched 2026-10-03 from sourcify.dev/server/v2/contract/1/{address}; the
 * runtime code is identical on Sepolia — see kernel-permissions.ts [P]):
 *
 *  CallPolicy v0.0.4 (0x9a52283276A0ec8740DF50bF01B28A80D880eaf2),
 *  src/CallPolicy.sol:
 *   - ParamCondition has LESS_THAN_OR_EQUAL (4); _checkPermission returns
 *     false when `param > rule.params[0]`, comparing the raw bytes32 word
 *     (unsigned, big-endian). So "amount <= amountPerPeriod" on the uint256
 *     argument of transfer(address,uint256) is enforceable, and the amount is
 *     NOT fixed to exactly amountPerPeriod.
 *   - EQUAL compares the full 32-byte word, so the recipient argument must be
 *     exactly the zero-padded merchant address.
 *   - checkUserOpPolicy decodes the ERC-7579 mode and, for CALLTYPE_BATCH,
 *     checks EVERY execution against the CALLTYPE_SINGLE permission entries.
 *     A permission cannot forbid batch mode (the Permission struct's callType
 *     only distinguishes single/batch calls from delegatecall), and each call
 *     is checked on its own: the policy never adds amounts up.
 *  RateLimitPolicy (0xf63d4139B25c836334edD76641356c6b74C86873),
 *  src/RateLimitPolicy.sol:
 *   - init data is packed uint48 interval || uint48 count || uint48 startAt
 *     (same as the SDK's toRateLimitPolicy, byte-pinned in the tests);
 *   - checkUserOpPolicy runs once per UserOperation: if count == 0 it
 *     returns 1 (Kernel reverts PolicyFailed), else it decrements count,
 *     advances startAt by interval and returns validAfter = the OLD startAt.
 *     `count` is therefore the TOTAL number of operations, not a per-interval
 *     count, and an operation is valid only from `startAt + k * interval`
 *     (EntryPoint v0.7 rejects block.timestamp < validAfter, AA22). Missed
 *     slots are not lost: after a gap, several operations can be valid at
 *     once (catch-up).
 *   - With startAt = 0 (the SDK default) every slot lies in 1970, so the
 *     policy would only cap the total count. subscriptionToGrant always sets
 *     startAt to the subscription's start.
 *  GasPolicy (0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23), src/GasPolicy.sol:
 *   charges (preVerificationGas + verificationGasLimit + callGasLimit) *
 *   maxFeePerGas per operation against a cumulative budget and returns 1
 *   (Kernel: PolicyFailed) when an operation would exceed it. Without it, a
 *   key holder who bundles its own operations could set a high fee and
 *   collect the difference from the subscriber's ETH (the account pays the
 *   bundler's beneficiary). Subscriptions therefore REQUIRE a fee budget.
 *  Kernel v3.3 (cd697c7e) ValidationManager._checkUserOpPolicy calls each
 *  policy once per operation, reverts PolicyFailed(i) when a policy returns a
 *  failure, and intersects the validity windows (latest validAfter, earliest
 *  validUntil; KernelValidationResult.sol).
 *
 * WHAT THIS ENFORCES ON-CHAIN: only `token` (or ETH), only to `merchant`, at
 * most amountPerPeriod per transfer, at most N operations in total with
 * operation k not valid before startAt + k * period, nothing after
 * validUntil, at most feeBudgetWei of network fees in total, and no ERC-1271
 * signatures (SKIP_SIGNATURE on the signer, kernel-permissions.ts).
 *
 * RESIDUAL RISK (cannot be closed with the deployed modules): one operation
 * may be an ERC-7579 batch of several transfers, each within the cap, so a
 * key holder that ignores this module's local single-call rule can take
 * several times amountPerPeriod in one period — up to the account's whole
 * balance of the token, bounded only by gas. CallPolicy cannot forbid batch
 * mode, no deployed Kernel v3.3 hook or policy restricts the execution mode
 * (phase 11 item 1: ZeroDev's hooks implement the Kernel v3.0 hook interface
 * and revert on v3.3), and the GasPolicy budget is accounted at the declared
 * maxFeePerGas, which the key holder chooses, so it is not a reliable bound
 * on call count. The local refusal (assertSubscriptionPull,
 * kernelSubscriptionSpec) binds only an honest keeper. The practical
 * mitigation is to keep in the subscribing account only what you are willing
 * to pay (for example a separate smart account for subscriptions). The batch
 * hole was demonstrated against the real contracts by
 * scripts/testnet/subscription-keeper.mjs --dry-run (eth_simulateV1).
 */

/** `token` value for subscriptions paid in the chain's native currency. */
export const SUBSCRIPTION_NATIVE = 'native';

/** transfer(address,uint256) — EIP-20; selector computed, not hard-coded. */
export const ERC20_TRANSFER_SELECTOR = toHex(abiSelector('transfer(address,uint256)'));

/** Wallet policy: shortest period accepted (the live run compresses periods to 120 s). */
export const SUBSCRIPTION_MIN_PERIOD_SECONDS = 60;
/** Wallet policy: most pulls a single grant may allow. */
export const SUBSCRIPTION_MAX_PERIODS = 10_000;
/** Wallet policy: label length in characters. */
export const SUBSCRIPTION_MAX_LABEL = 64;

const MAX_UINT48 = (1n << 48n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface SubscriptionGrant {
  /** The only recipient. */
  merchant: string;
  /** ERC-20 contract address, or SUBSCRIPTION_NATIVE for the chain's native currency. */
  token: string;
  /** Most the merchant may take in one transfer, in base units (wei for native). */
  amountPerPeriod: bigint;
  /** Length of one period. */
  periodSeconds: number;
  /**
   * Unix seconds at which the first period starts (the first pull is valid
   * from then). Becomes TimestampPolicy validAfter and RateLimitPolicy startAt.
   */
  startAt: number;
  /** Unix seconds after which no pull is valid (TimestampPolicy validUntil). */
  validUntil: number;
  /**
   * Total network fees, in wei, that all pulls together may charge to the
   * subscribing account (GasPolicy, worst-case accounting). Mandatory.
   */
  feeBudgetWei: bigint;
  /** Display name chosen by the subscriber (not used on-chain). */
  label: string;
}

/** JSON-safe form (bigints as decimal strings). */
export interface SerializedSubscriptionGrant {
  version: 1;
  merchant: string;
  token: string;
  amountPerPeriod: string;
  periodSeconds: number;
  startAt: number;
  validUntil: number;
  feeBudgetWei: string;
  label: string;
}

export function serializeSubscription(sub: SubscriptionGrant): SerializedSubscriptionGrant {
  return {
    version: 1,
    merchant: sub.merchant,
    token: sub.token,
    amountPerPeriod: sub.amountPerPeriod.toString(10),
    periodSeconds: sub.periodSeconds,
    startAt: sub.startAt,
    validUntil: sub.validUntil,
    feeBudgetWei: sub.feeBudgetWei.toString(10),
    label: sub.label,
  };
}

/** Parses and re-validates a stored subscription (no clock check). */
export function parseSubscription(value: unknown): SubscriptionGrant {
  const v = value as Partial<SerializedSubscriptionGrant> | null;
  if (!v || typeof v !== 'object' || v.version !== 1) throw new Error('Not a version-1 serialized subscription');
  const decimal = (s: unknown, what: string): bigint => {
    if (typeof s !== 'string' || !/^(0|[1-9][0-9]*)$/.test(s)) throw new Error(`${what} must be a decimal string`);
    return BigInt(s);
  };
  const sub: SubscriptionGrant = {
    merchant: String(v.merchant),
    token: String(v.token),
    amountPerPeriod: decimal(v.amountPerPeriod, 'amountPerPeriod'),
    periodSeconds: Number(v.periodSeconds),
    startAt: Number(v.startAt),
    validUntil: Number(v.validUntil),
    feeBudgetWei: decimal(v.feeBudgetWei, 'feeBudgetWei'),
    label: String(v.label),
  };
  validateSubscription(sub, { now: null });
  return sub;
}

export function isNativeSubscription(sub: Pick<SubscriptionGrant, 'token'>): boolean {
  return sub.token === SUBSCRIPTION_NATIVE;
}

/**
 * Number of pulls the grant allows: one per period that STARTS before
 * validUntil, i.e. ceil((validUntil - startAt) / periodSeconds). This is the
 * RateLimitPolicy count.
 */
export function subscriptionPeriodCount(sub: Pick<SubscriptionGrant, 'startAt' | 'validUntil' | 'periodSeconds'>): number {
  const span = sub.validUntil - sub.startAt;
  if (!(span > 0) || !(sub.periodSeconds > 0)) return 0;
  return Math.ceil(span / sub.periodSeconds);
}

export interface SubscriptionValidationOptions {
  /** The subscribing Kernel account (refuses it as merchant or token). */
  account?: string | undefined;
  /** Unix seconds for the expiry check; null skips it; default the local clock. */
  now?: number | null | undefined;
}

/** Local, network-free validation; throws a plain sentence on the first problem. */
export function validateSubscription(sub: SubscriptionGrant, options: SubscriptionValidationOptions = {}): void {
  if (!isAddress(sub.merchant)) throw new Error('The merchant must be a 20-byte hex address.');
  if (sameAddress(sub.merchant, ZERO_ADDRESS)) throw new Error('The merchant must not be the zero address.');
  const native = isNativeSubscription(sub);
  if (!native) {
    if (!isAddress(sub.token)) throw new Error(`The token must be a contract address or "${SUBSCRIPTION_NATIVE}".`);
    if (sameAddress(sub.token, ZERO_ADDRESS)) {
      // CallPolicy treats a zero-address target as "any contract".
      throw new Error('The token must not be the zero address (the call policy would treat it as any contract).');
    }
    if (sameAddress(sub.token, sub.merchant)) throw new Error('The merchant must not be the token contract itself.');
  }
  if (options.account !== undefined) {
    if (sameAddress(sub.merchant, options.account)) throw new Error('The merchant must not be your own account.');
    if (!native && sameAddress(sub.token, options.account)) throw new Error('The token must not be your own account.');
  }
  if (typeof sub.amountPerPeriod !== 'bigint' || sub.amountPerPeriod <= 0n || sub.amountPerPeriod > MAX_UINT256) {
    throw new Error('The amount per period must be a positive whole number of base units.');
  }
  if (!Number.isSafeInteger(sub.periodSeconds) || sub.periodSeconds < SUBSCRIPTION_MIN_PERIOD_SECONDS) {
    throw new Error(`The period must be a whole number of seconds, at least ${SUBSCRIPTION_MIN_PERIOD_SECONDS}.`);
  }
  if (BigInt(sub.periodSeconds) > MAX_UINT48) throw new Error('The period is too long.');
  const isUint48 = (n: number) => Number.isSafeInteger(n) && n >= 0 && BigInt(n) <= MAX_UINT48;
  if (!isUint48(sub.startAt) || sub.startAt === 0) throw new Error('The start must be a unix time (seconds).');
  if (!isUint48(sub.validUntil)) throw new Error('The expiry must be a unix time (seconds).');
  if (sub.validUntil <= sub.startAt) throw new Error('The expiry must be after the start.');
  const periods = subscriptionPeriodCount(sub);
  if (periods > SUBSCRIPTION_MAX_PERIODS) {
    throw new Error(`At most ${SUBSCRIPTION_MAX_PERIODS} periods per subscription; shorten it or lengthen the period.`);
  }
  if (typeof sub.feeBudgetWei !== 'bigint' || sub.feeBudgetWei <= 0n || sub.feeBudgetWei > MAX_UINT128) {
    throw new Error('A fee budget (total network fees the pulls may charge, in wei) is required.');
  }
  if (typeof sub.label !== 'string' || sub.label.trim().length === 0 || [...sub.label].length > SUBSCRIPTION_MAX_LABEL) {
    throw new Error(`Give the subscription a name of 1 to ${SUBSCRIPTION_MAX_LABEL} characters.`);
  }
  // Control characters and bidi overrides would make the review misleading.
  if (/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/.test(sub.label)) {
    throw new Error('The name contains control or direction characters.');
  }
  const now = options.now === undefined ? Math.floor(Date.now() / 1000) : options.now;
  if (now !== null && sub.validUntil <= now) throw new Error('The subscription would already have expired.');
}

/**
 * The single allowed call of a subscription:
 *  - ERC-20: target = token, selector = transfer(address,uint256), no value,
 *    rules [recipient (offset 0) EQUAL merchant, amount (offset 32)
 *    LESS_THAN_OR_EQUAL amountPerPeriod];
 *  - native: target = merchant, no function (empty calldata — CallPolicy
 *    keys it as selector 0x00000000, so calldata starting with four zero
 *    bytes also matches; harmless for an EOA merchant), value cap =
 *    amountPerPeriod.
 */
export function subscriptionAllowedCall(sub: SubscriptionGrant): SessionAllowedCall {
  if (isNativeSubscription(sub)) {
    return { target: sub.merchant, selector: null, valueLimit: sub.amountPerPeriod };
  }
  return {
    target: sub.token,
    selector: ERC20_TRANSFER_SELECTOR,
    valueLimit: 0n,
    rules: [
      { condition: 'equal', offset: 0, params: [toHex(toWord(BigInt(sub.merchant.toLowerCase())))] },
      { condition: 'lessThanOrEqual', offset: 32, params: [toHex(toWord(sub.amountPerPeriod))] },
    ],
  };
}

/**
 * Maps a subscription onto a session grant for `sessionKey`: the single
 * allowed call, TimestampPolicy [startAt, validUntil], GasPolicy
 * feeBudgetWei, RateLimitPolicy {interval = period, count = periods,
 * startAt}. Validates first (throws a plain sentence).
 */
export function subscriptionToGrant(
  sub: SubscriptionGrant,
  sessionKey: string,
  options: SubscriptionValidationOptions = {},
): SessionKeyGrant {
  validateSubscription(sub, options);
  const grant: SessionKeyGrant = {
    sessionKey,
    calls: [subscriptionAllowedCall(sub)],
    validAfter: sub.startAt,
    validUntil: sub.validUntil,
    gasBudgetWei: sub.feeBudgetWei,
    rateLimit: { count: subscriptionPeriodCount(sub), intervalSeconds: sub.periodSeconds, startAt: sub.startAt },
  };
  validateSessionKeyGrant(grant, { account: options.account, now: options.now });
  return grant;
}

/**
 * True when `grant` is exactly what subscriptionToGrant(sub, grant.sessionKey)
 * produces, so stored subscription metadata can never describe a different
 * on-chain grant.
 */
export function subscriptionMatchesGrant(sub: SubscriptionGrant, grant: SessionKeyGrant): boolean {
  let expected: SessionKeyGrant;
  try {
    expected = subscriptionToGrant(sub, grant.sessionKey, { now: null });
  } catch {
    return false;
  }
  const norm = (g: SessionKeyGrant) =>
    JSON.stringify({
      ...g,
      sessionKey: g.sessionKey.toLowerCase(),
      calls: g.calls.map((c) => ({
        target: c.target.toLowerCase(),
        selector: c.selector?.toLowerCase() ?? null,
        valueLimit: c.valueLimit.toString(),
        rules: (c.rules ?? []).map((r) => ({ ...r, params: r.params.map((p) => p.toLowerCase()) })),
      })),
      gasBudgetWei: g.gasBudgetWei?.toString() ?? null,
      rateLimit: g.rateLimit ? { ...g.rateLimit, startAt: g.rateLimit.startAt ?? 0 } : null,
    });
  return norm(expected) === norm(grant);
}

/** The call a keeper submits to pull `amount` (default: the full amountPerPeriod). */
export function subscriptionPullCall(sub: SubscriptionGrant, amount: bigint = sub.amountPerPeriod): Call {
  if (amount < 0n) throw new Error('Amount must not be negative');
  if (isNativeSubscription(sub)) return { to: sub.merchant, value: amount, data: new Uint8Array(0) };
  return {
    to: sub.token,
    value: 0n,
    data: encodeFunctionCall('transfer(address,uint256)', [
      { kind: 'address', value: sub.merchant },
      { kind: 'uint256', value: amount },
    ]),
  };
}

/**
 * Local check of a pull before anything is signed: EXACTLY one call (a batch
 * is refused — see the module header for why the account cannot refuse it
 * itself), and that call within the grant (engine assertCallsAllowed: target,
 * selector, value cap, recipient and amount rules, window).
 */
export function assertSubscriptionPull(
  sub: SubscriptionGrant,
  sessionKey: string,
  calls: Call[],
  now: number = Math.floor(Date.now() / 1000),
): void {
  if (calls.length !== 1) {
    throw new Error(
      `A subscription pull is exactly one transfer; refusing ${calls.length} calls (the account checks each ` +
        'transfer against the cap but cannot add a batch up, so batches are refused here).',
    );
  }
  assertCallsAllowed(subscriptionToGrant(sub, sessionKey, { now: null }), calls, now);
}

export interface KernelSubscriptionSpecConfig {
  /** The subscriber's deployed Kernel account. */
  account: string;
  sessionKey: string;
  permissionId: Uint8Array | string;
  subscription: SubscriptionGrant;
  parallelKey?: number;
  entryPoint?: string;
  now?: () => number;
}

/**
 * kernelSessionSpec for a subscription keeper: signs only with the session
 * key, routes the permission's nonce key, and refuses (before encoding,
 * hence before signing) anything but a single in-grant pull.
 */
export function kernelSubscriptionSpec(config: KernelSubscriptionSpecConfig): KernelSessionSpec {
  const grant = subscriptionToGrant(config.subscription, config.sessionKey, { now: null });
  const inner = kernelSessionSpec({
    account: config.account,
    sessionKey: config.sessionKey,
    permissionId: config.permissionId,
    grant,
    ...(config.parallelKey !== undefined ? { parallelKey: config.parallelKey } : {}),
    ...(config.entryPoint !== undefined ? { entryPoint: config.entryPoint } : {}),
    ...(config.now !== undefined ? { now: config.now } : {}),
  });
  return {
    ...inner,
    encodeCalls(calls: Call[]): Uint8Array {
      assertSubscriptionPull(
        config.subscription,
        config.sessionKey,
        calls,
        config.now ? config.now() : Math.floor(Date.now() / 1000),
      );
      return inner.encodeCalls(calls);
    },
  };
}

// ---------------------------------------------------------------------------
// On-chain state and the next pull
// ---------------------------------------------------------------------------

export interface SubscriptionChainState {
  /** RateLimitPolicy status(id, account): 0 never installed, 1 live, 2 uninstalled. */
  rateLimitStatus: 'not-installed' | 'live' | 'deprecated';
  /** Pulls left (RateLimitPolicy count). */
  remainingPulls: number;
  /** Earliest unix time of the next pull (RateLimitPolicy startAt). */
  nextSlotAt: number;
  /** RateLimitPolicy interval (the period). */
  intervalSeconds: number;
  /** GasPolicy fee budget left, in wei. */
  feeBudgetLeftWei: bigint;
  /** The grant's validUntil (from the subscription, not read on-chain). */
  validUntil: number;
}

/**
 * Reads the subscription's RateLimitPolicy and GasPolicy state with
 * read-only eth_calls: rateLimitConfigs(bytes32 id, address) returns
 * (uint48 interval, uint48 count, uint48 startAt) and gasPolicyConfig(bytes32,
 * address) returns (uint128 allowed, bool, address) [P sources above]; the
 * policy id is the 4-byte permission id left-aligned in a bytes32 (Kernel
 * passes bytes32(PermissionId) to every policy).
 */
export async function readSubscriptionState(
  node: JsonRpcTransport,
  account: string,
  permissionId: Uint8Array | string,
  sub: Pick<SubscriptionGrant, 'validUntil'>,
  modules: KernelPermissionModules = KERNEL_PERMISSION_MODULES,
  block: string = 'latest',
): Promise<SubscriptionChainState> {
  const pid = typeof permissionId === 'string' ? toBytes(permissionId) : permissionId;
  if (pid.length !== 4) throw new Error('A Kernel permission id is 4 bytes');
  const id = new Uint8Array(32);
  id.set(pid, 0);
  const args = [
    { kind: 'fixedBytes' as const, value: id },
    { kind: 'address' as const, value: account },
  ];
  const call = async (to: string, signature: string): Promise<Uint8Array> =>
    toBytes((await node('eth_call', [{ to, data: toHex(encodeFunctionCall(signature, args)) }, block])) as string);
  const word = (bytes: Uint8Array, i: number): bigint => {
    if (bytes.length < (i + 1) * 32) throw new Error('Policy getter returned an unexpected shape');
    return BigInt(toHex(bytes.slice(i * 32, (i + 1) * 32)));
  };
  const [statusWords, rateWords, gasWords] = await Promise.all([
    call(modules.rateLimitPolicy, 'status(bytes32,address)'),
    call(modules.rateLimitPolicy, 'rateLimitConfigs(bytes32,address)'),
    call(modules.gasPolicy, 'gasPolicyConfig(bytes32,address)'),
  ]);
  const status = word(statusWords, 0);
  if (status > 2n) throw new Error('RateLimitPolicy status out of range');
  return {
    rateLimitStatus: status === 0n ? 'not-installed' : status === 1n ? 'live' : 'deprecated',
    intervalSeconds: Number(word(rateWords, 0)),
    remainingPulls: Number(word(rateWords, 1)),
    nextSlotAt: Number(word(rateWords, 2)),
    feeBudgetLeftWei: word(gasWords, 0),
    validUntil: sub.validUntil,
  };
}

export type NextPull =
  /** A pull would be valid now (from `at`, which is in the past). */
  | { kind: 'now'; at: number; remainingPulls: number }
  /** The next pull is valid from `at`. */
  | { kind: 'later'; at: number; remainingPulls: number }
  /** Every pull the grant allowed has been made. */
  | { kind: 'used-up' }
  /** The window closed (or the next slot starts after it). */
  | { kind: 'ended' }
  /** The grant is not installed (revoked, or never installed). */
  | { kind: 'inactive' };

/**
 * When the next pull is allowed, from the on-chain state: EntryPoint v0.7
 * accepts an operation when validAfter <= block.timestamp <= validUntil
 * (core/EntryPoint.sol _getValidationData), RateLimitPolicy's validAfter is
 * its current startAt, and TimestampPolicy's validUntil is the grant's.
 */
export function nextPullAllowedAt(state: SubscriptionChainState, now: number = Math.floor(Date.now() / 1000)): NextPull {
  if (state.rateLimitStatus !== 'live') return { kind: 'inactive' };
  if (state.remainingPulls <= 0) return { kind: 'used-up' };
  if (now > state.validUntil || state.nextSlotAt > state.validUntil) return { kind: 'ended' };
  return state.nextSlotAt <= now
    ? { kind: 'now', at: state.nextSlotAt, remainingPulls: state.remainingPulls }
    : { kind: 'later', at: state.nextSlotAt, remainingPulls: state.remainingPulls };
}

// ---------------------------------------------------------------------------
// Plain language
// ---------------------------------------------------------------------------

export interface SubscriptionDescription {
  /** One sentence, e.g. "Lets Netflix take up to 5 USDC every 30 days until 2026-11-02 00:00 UTC; at most one pull per period." */
  sentence: string;
  /** What the account enforces on-chain. */
  enforced: string[];
  /** What it does NOT enforce, and other things to know. Always shown. */
  caveats: string[];
}

/** "30 days", "2 minutes", "1 hour", "90 seconds". */
export function describePeriod(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds % 86400 === 0) return unit(seconds / 86400, 'day');
  if (seconds % 3600 === 0) return unit(seconds / 3600, 'hour');
  if (seconds % 60 === 0) return unit(seconds / 60, 'minute');
  return unit(seconds, 'second');
}

/** "2026-11-02 14:05 UTC". */
export function formatUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** Exact decimal rendering of base units (no rounding, trailing zeros trimmed). */
export function formatBaseUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function describeSubscription(
  sub: SubscriptionGrant,
  context: {
    /** Token symbol, or the native symbol for native subscriptions. */
    symbol: string;
    decimals: number;
    /** Exact-match contact name for the merchant, or null. */
    merchantName?: string | null;
    /** Native symbol, for the fee lines (e.g. "ETH", "test ETH"). */
    nativeSymbol?: string;
  },
): SubscriptionDescription {
  const merchant = context.merchantName ? `${context.merchantName} (${sub.merchant})` : sub.merchant;
  const amount = `${formatBaseUnits(sub.amountPerPeriod, context.decimals)} ${context.symbol}`;
  const period = describePeriod(sub.periodSeconds);
  const periods = subscriptionPeriodCount(sub);
  const native = context.nativeSymbol ?? 'ETH';
  const fee = `${formatBaseUnits(sub.feeBudgetWei, 18)} ${native}`;
  const sentence =
    `Lets ${merchant} take up to ${amount} every ${period} until ${formatUtc(sub.validUntil)}; ` +
    'at most one pull per period.';
  const enforced = [
    isNativeSubscription(sub)
      ? `Only plain ${context.symbol} transfers to ${sub.merchant}, at most ${amount} each.`
      : `Only ${context.symbol} (contract ${sub.token}) transfers to ${sub.merchant}, at most ${amount} each.`,
    `At most ${periods} pull${periods === 1 ? '' : 's'} in total: the first from ${formatUtc(sub.startAt)}, ` +
      `then one more every ${period}.`,
    `Nothing after ${formatUtc(sub.validUntil)}.`,
    `Network fees for the pulls are paid by your account, at most ${fee} in total.`,
    'The key cannot sign messages, logins or permits for your account.',
  ];
  const caveats = [
    'ONE PULL CAN HOLD SEVERAL TRANSFERS. Your account checks each transfer against the cap but does not add ' +
      'them up, and it cannot refuse a batch. A merchant that ignores this wallet’s rules could take several ' +
      `times ${amount} in one pull — up to everything this account holds in ${context.symbol}. Keep only what ` +
      'you are willing to pay in this account.',
    'Missed pulls are not lost: if the merchant skips a period, it can take that period’s pull later, even ' +
      'right before the next one.',
    'Whoever holds the subscription key can pull within these limits. Give it only to the merchant.',
    'Cancel at any time with Revoke (one operation signed by your account key). Pulls already made are not ' +
      'returned.',
  ];
  return { sentence, enforced, caveats };
}

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

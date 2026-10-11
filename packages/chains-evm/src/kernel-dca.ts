import { utf8ToBytes } from '@noble/hashes/utils.js';
import { encodeFunctionCall, selector as abiSelector } from './abi.js';
import { keccak, toHex, toWord } from './encoding.js';
import { encodeErc20Approve } from './erc20.js';
import {
  KERNEL_PERMISSION_MODULES,
  assertCallsAllowed,
  kernelSessionSpec,
  validateSessionKeyGrant,
  type KernelPermissionModules,
  type KernelSessionSpec,
  type SessionAllowedCall,
  type SessionKeyGrant,
  type SessionParamRule,
} from './kernel-permissions.js';
import {
  SUBSCRIPTION_MAX_LABEL,
  SUBSCRIPTION_MAX_PERIODS,
  SUBSCRIPTION_MIN_PERIOD_SECONDS,
  describePeriod,
  formatBaseUnits,
  formatUtc,
  readSubscriptionState,
  type SubscriptionChainState,
} from './kernel-subscription.js';
import type { JsonRpcTransport } from './rpc.js';
import type { Call } from './smart-account.js';
import { ENTRYPOINT_V07 } from './userop.js';

/**
 * Dollar-cost averaging (recurring swaps) on a Kernel v3.3 session key
 * (phase 19 item 2, feature 63).
 *
 * A DCA grant is an ordinary session-key grant built on EXACTLY the same
 * template as a subscription (kernel-subscription.ts subscriptionToGrant):
 * the same kernelPermissionFromGrant mapping, so the policy list is
 * [CallPolicy v0.0.4, TimestampPolicy, GasPolicy, RateLimitPolicy] with flag
 * 0x0000 each, and the ECDSASigner entry carries SKIP_SIGNATURE (the key can
 * never produce an ERC-1271 signature for the account). Only the CallPolicy
 * permissions differ: instead of one transfer, the key may call Uniswap's
 * SwapRouter02 exactInputSingle with every argument pinned.
 *
 * SOURCES (fetched 2026-10-11):
 *  [R] SwapRouter02 on Sepolia, 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E
 *      (docs.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments
 *      lists it as "SwapRouter02 … Sepolia"); Sourcify FULL match (creation and
 *      runtime) on chain 11155111, solc 0.7.6+commit.7338295f, optimizer
 *      1,000,000 runs, deployed in tx 0x472b2240…ff02 (block 3,518,296) by
 *      0x3344BBDC…432A, the same deployer as the factory and QuoterV2 below.
 *      Read on-chain: factory() = 0x0227628f…DaC1c, WETH9() = 0xfFf99767…6B14.
 *      - contracts/interfaces/IV3SwapRouter.sol: ExactInputSingleParams
 *        {address tokenIn; address tokenOut; uint24 fee; address recipient;
 *        uint256 amountIn; uint256 amountOutMinimum; uint160
 *        sqrtPriceLimitX96} — NO deadline (the deadline of SwapRouter02 lives
 *        only in multicall(uint256 deadline, bytes[]) of MulticallExtended,
 *        whose arguments are dynamic and cannot be pinned). Every field is
 *        static, so the struct is encoded in place: the fields sit at byte
 *        offsets 0, 32, …, 192 after the selector, and the selector of
 *        exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
 *        is 0x04e45aaf (computed; the router's dispatch table contains it).
 *        The interface comment: "Setting `amountIn` to 0 will cause the
 *        contract to look up its own balance, and swap the entire amount".
 *      - contracts/V3SwapRouter.sol exactInputSingle: amountIn ==
 *        Constants.CONTRACT_BALANCE (0) swaps the ROUTER's balance; recipient
 *        address(1) means msg.sender and address(2) the router
 *        (Constants.MSG_SENDER / ADDRESS_THIS); otherwise the pool pays the
 *        recipient directly; `require(amountOut >= params.amountOutMinimum,
 *        'Too little received')`. sqrtPriceLimitX96 == 0 means "no limit"
 *        (MIN_SQRT_RATIO + 1 / MAX_SQRT_RATIO − 1).
 *      - @uniswap/v3-periphery PeripheryPayments.pay: `if (token == WETH9 &&
 *        address(this).balance >= value)` the router wraps exactly `value`
 *        of its ETH (msg.value) and pays the pool in WETH; otherwise it pulls
 *        the token from the payer (msg.sender) with transferFrom. So selling
 *        ETH needs NO separate wrap: the call sends amountIn as msg.value
 *        with tokenIn = WETH9. ETH the pool does not take (a partial fill)
 *        stays in the router, where refundETH() hands it to whoever calls it
 *        next — the account cannot pin a refundETH call (it would need
 *        multicall). See the caveats in describeDca.
 *  [C] CallPolicy v0.0.4 (0x9a52283276A0ec8740DF50bF01B28A80D880eaf2),
 *      Sourcify full match on chain 1, identical runtime on Sepolia
 *      (kernel-permissions.ts [P]): enum ParamCondition {EQUAL,
 *      GREATER_THAN, LESS_THAN, GREATER_THAN_OR_EQUAL, LESS_THAN_OR_EQUAL,
 *      NOT_EQUAL, ONE_OF}; _checkPermission reads `bytes32
 *      param = bytes32(data[4 + rule.offset : 4 + rule.offset + 32])` and
 *      compares the raw word; `if (value > allowedValue) revert
 *      CallViolatesValueRule()`; a failed rule reverts CallViolatesParamRule().
 *  [F] UniswapV3Factory 0x0227628f3F023bb0B980b67D528571c95c6DaC1c and
 *      QuoterV2 0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3 (same docs page;
 *      both Sourcify full matches on chain 11155111). The pools are not on
 *      Sourcify; they are tied to the verified factory by getPool(…) and are
 *      re-checked at read time (readDcaPool).
 *
 * PARAMETER RULES, and why each condition was chosen:
 *  - tokenIn (offset 0) EQUAL the token sold (WETH9 when selling ETH);
 *  - tokenOut (offset 32) EQUAL the token bought;
 *  - fee (offset 64) EQUAL the pinned pool's fee tier;
 *  - recipient (offset 96) EQUAL the account itself, so the bought tokens can
 *    go nowhere else (this also excludes the router's address(1) /
 *    address(2) shortcuts);
 *  - amountIn (offset 128) EQUAL the per-period amount. EQUAL rather than
 *    LESS_THAN_OR_EQUAL because (a) 0 is the router's "swap the router's own
 *    balance" flag, (b) when selling ETH an amountIn below the ETH sent
 *    would leave the difference in the router for anyone to take with
 *    refundETH, and (c) a DCA plan buys a fixed amount by definition;
 *  - amountOutMinimum (offset 160) GREATER_THAN_OR_EQUAL the STATIC floor;
 *  - sqrtPriceLimitX96 (offset 192) EQUAL 0, because a price limit makes the
 *    pool stop early (a deliberate partial fill), which for an ETH sale
 *    leaves ETH in the router;
 *  - value: at most amountIn when selling ETH (CallPolicy can only cap the
 *    value, not fix it; with amountIn pinned, a smaller value makes the
 *    router fall back to transferFrom of WETH, which reverts without an
 *    allowance), 0 when selling an ERC-20.
 * Selling an ERC-20 additionally allows approve(router, amount) with the
 * spender EQUAL the router and the amount EQUAL amountIn; approve SETS the
 * allowance, so the standing allowance never exceeds one period's amount,
 * and the router spends it only from msg.sender, i.e. only inside the
 * account's own calls (PeripheryPayments.pay).
 *
 * WHAT THIS ENFORCES ON-CHAIN: only this router and selector; only this
 * pair and pool fee; the output only to the account; exactly amountIn per
 * swap; at least the floor out per swap (or the swap reverts); at most
 * `count` operations, operation k not before startAt + k·period; nothing
 * after validUntil; at most feeBudgetWei of declared fees; no ERC-1271.
 *
 * WHAT IT CANNOT ENFORCE (stated on every screen, see describeDca):
 *  - A fair price: the floor is a fixed number written at install time and
 *    does not follow the market; a swap at the floor price is allowed.
 *  - A deadline: an operation executes whenever it is included.
 *  - The batching limit of every session grant (kernel-subscription.ts):
 *    one operation may hold several swaps, each within the rules, so a key
 *    holder ignoring assertDcaSwap could sell up to the account's whole
 *    balance at the floor price in one slot.
 *  - A swap that reverts (for example because the price fell below the
 *    floor) still uses up its slot: RateLimitPolicy counts it during
 *    validation, which the execution revert does not undo. Nothing is
 *    lost except the network fee.
 */

/** `tokenIn` value for a plan that sells the chain's native currency (sent as msg.value, tokenIn = WETH9). */
export const DCA_NATIVE = 'native';

/** SwapRouter02 single-pool exact-input swap [R IV3SwapRouter.sol]. */
export const DCA_EXACT_INPUT_SINGLE_SIGNATURE =
  'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))';
/** 0x04e45aaf (computed from the signature). */
export const DCA_EXACT_INPUT_SINGLE_SELECTOR = toHex(abiSelector(DCA_EXACT_INPUT_SINGLE_SIGNATURE));
/**
 * The ORIGINAL SwapRouter's exactInputSingle, whose struct carries a
 * `uint256 deadline` after the recipient (0x414bf389, computed). Refused.
 */
export const SWAP_ROUTER_V1_EXACT_INPUT_SINGLE_SELECTOR = toHex(
  abiSelector('exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))'),
);
/** approve(address,uint256) — EIP-20. */
export const DCA_APPROVE_SELECTOR = toHex(abiSelector('approve(address,uint256)'));

/** Byte offsets (after the selector) of the ExactInputSingleParams fields. */
export const DCA_PARAM_OFFSETS = {
  tokenIn: 0,
  tokenOut: 32,
  fee: 64,
  recipient: 96,
  amountIn: 128,
  amountOutMinimum: 160,
  sqrtPriceLimitX96: 192,
} as const;
/** Selector + seven static words; longer or shorter calldata is refused locally. */
export const DCA_SWAP_CALLDATA_LENGTH = 4 + 7 * 32;
/** Uniswap v3 fee tiers enabled by the factory (hundredths of a basis point). */
export const UNISWAP_V3_FEE_TIERS: readonly number[] = [100, 500, 3000, 10000];

/** Pool Swap event [@uniswap/v3-core IUniswapV3PoolEvents.sol, in the router's verified sources]. */
export const UNISWAP_V3_SWAP_TOPIC = toHex(keccak(utf8ToBytes('Swap(address,address,int256,int256,uint160,uint128,int24)')));
const TRANSFER_TOPIC = toHex(keccak(utf8ToBytes('Transfer(address,address,uint256)')));
const USER_OPERATION_EVENT_TOPIC = toHex(
  keccak(utf8ToBytes('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')),
);
const USER_OPERATION_REVERT_REASON_TOPIC = toHex(
  keccak(utf8ToBytes('UserOperationRevertReason(bytes32,address,uint256,bytes)')),
);

export interface UniswapV3Deployment {
  chainId: bigint;
  networkName: string;
  factory: string;
  swapRouter02: string;
  quoterV2: string;
  weth9: string;
}

/** Uniswap v3 on Ethereum Sepolia [R][F]; every address read back on-chain 2026-10-11. */
export const UNISWAP_V3_SEPOLIA: UniswapV3Deployment = {
  chainId: 11155111n,
  networkName: 'Ethereum Sepolia',
  factory: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
  swapRouter02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
  quoterV2: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
  weth9: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
};

/** Test networks only in this slice; nothing is pinned for a main network. */
export const DCA_DEPLOYMENTS: readonly UniswapV3Deployment[] = [UNISWAP_V3_SEPOLIA];

export interface DcaPinnedPool {
  chainId: bigint;
  /** The lower token address (Uniswap's token0). */
  token0: string;
  token1: string;
  fee: number;
  pool: string;
  label: string;
}

const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

/**
 * Pools a DCA plan may use. Sepolia USDC (Circle) / WETH9, all four fee
 * tiers, from factory.getPool on 2026-10-11 (each had in-range liquidity
 * then: 0.01% 7.9e14, 0.05% 1.3e16, 0.3% 8.8e15, 1% 1.07e17). USDC is
 * token0 (0x1c7D… < 0xfFf9…).
 */
export const DCA_PINNED_POOLS: readonly DcaPinnedPool[] = [
  { fee: 100, pool: '0xFeEd501c2B21D315F04946F85fC6416B640240b5', label: 'USDC/WETH 0.01%' },
  { fee: 500, pool: '0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1', label: 'USDC/WETH 0.05%' },
  { fee: 3000, pool: '0x6Ce0896eAE6D4BD668fDe41BB784548fb8F59b50', label: 'USDC/WETH 0.3%' },
  { fee: 10000, pool: '0x6418EEC70f50913ff0d756B48d32Ce7C02b47C47', label: 'USDC/WETH 1%' },
].map((p) => ({ chainId: 11155111n, token0: SEPOLIA_USDC, token1: UNISWAP_V3_SEPOLIA.weth9, ...p }));

/** Routers refused by name, with the reason [docs.uniswap.org deployments page, read 2026-10-11]. */
export const DCA_REFUSED_ROUTERS: readonly { address: string; name: string; reason: 'deadline' | 'unpinnable' }[] = [
  // The original SwapRouter (Ethereum mainnet and most networks; not deployed on Sepolia per the docs).
  { address: '0xE592427A0AEce92De3Edee1F18E0157C05861564', name: 'Uniswap SwapRouter (v1)', reason: 'deadline' },
  // Universal Router: execute(bytes commands, bytes[] inputs, uint256 deadline).
  { address: '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b', name: 'Uniswap Universal Router (Sepolia)', reason: 'unpinnable' },
  { address: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af', name: 'Uniswap Universal Router (mainnet)', reason: 'unpinnable' },
];

// ---------------------------------------------------------------------------
// Refusals (plain sentences; the app shows them verbatim)
// ---------------------------------------------------------------------------

export const DCA_UNSUPPORTED_CHAIN_REFUSAL =
  'Recurring swaps are offered only on Ethereum Sepolia in this version: no swap router or pool is pinned for this network.';
export const DCA_DEADLINE_ROUTER_REFUSAL =
  "This router's single-swap call carries a deadline inside its arguments, so its argument positions differ from " +
  'SwapRouter02 and a session grant could only fix one deadline for every swap. Recurring swaps use SwapRouter02 only.';
export const DCA_UNPINNABLE_ROUTER_REFUSAL =
  "This router takes its swap instructions as variable-length data, which an account's call policy cannot check. " +
  'Recurring swaps use SwapRouter02 only.';
export const DCA_UNKNOWN_ROUTER_REFUSAL =
  "Recurring swaps can only use Uniswap's SwapRouter02 at the address this wallet pinned for this network.";
export const DCA_UNKNOWN_POOL_REFUSAL =
  'This token pair and fee tier is not a pool this wallet has pinned for this network, so it is refused.';
export const DCA_SAME_TOKEN_REFUSAL = 'The token bought must differ from the token sold.';
export const DCA_NATIVE_OUT_REFUSAL =
  'Buying the native currency would need an unwrap step that a session grant cannot pin; buy WETH instead.';
export const DCA_FEE_TIER_REFUSAL = 'The pool fee must be one of the Uniswap v3 tiers 0.01%, 0.05%, 0.3% or 1%.';
export const DCA_AMOUNT_REFUSAL = 'The amount to sell per period must be a positive whole number of base units.';
export const DCA_FLOOR_ZERO_REFUSAL =
  'The minimum to receive per swap must be more than zero: a zero floor would let every swap through at any price.';
export const DCA_RECIPIENT_REFUSAL =
  'The bought tokens must go to this smart account itself; any other recipient is refused.';
export const DCA_FEE_BUDGET_REFUSAL =
  'A fee budget (total network fees the swaps may charge, in wei) is required.';
export const DCA_BATCH_REFUSAL =
  'A recurring swap is exactly one swap (plus its one approval when selling a token); anything else is refused here, ' +
  'because the account checks each call on its own and cannot refuse a batch.';
export const DCA_PRICE_LIMIT_REFUSAL =
  'The swap must not set a price limit: a limit stops the swap early and, when selling ETH, leaves the rest in the router.';
export const DCA_MINIMUM_BELOW_FLOOR_REFUSAL = 'The swap asks for less than the plan’s minimum to receive.';
export const DCA_PAIR_MISMATCH_REFUSAL = 'The swap trades a different token pair or pool fee than the plan.';
export const DCA_AMOUNT_MISMATCH_REFUSAL = 'The swap must sell exactly the plan’s amount per period.';

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export interface DcaTerms {
  chainId: bigint;
  /** The deployed Kernel account that sells and receives. */
  account: string;
  /** Must be the pinned SwapRouter02 of the chain. */
  router: string;
  /** DCA_NATIVE (sell ETH; the call sends it as value with tokenIn = WETH9) or an ERC-20 address. */
  tokenIn: string;
  /** ERC-20 bought (never DCA_NATIVE). */
  tokenOut: string;
  /** Pool fee tier (100, 500, 3000, 10000) of a pinned pool. */
  fee: number;
  /** Exactly this much is sold per swap, in base units of tokenIn (wei for ETH). */
  amountIn: bigint;
  /** STATIC floor: every swap must ask for at least this much tokenOut (base units). */
  minimumOut: bigint;
  periodSeconds: number;
  /** Number of swaps (RateLimitPolicy count). */
  count: number;
  /** Unix seconds of the first slot (TimestampPolicy validAfter and RateLimitPolicy startAt). */
  startAt: number;
  /**
   * Extra seconds after the last slot's period during which it can still be
   * sent (default 0). The rate limit's count is unchanged, so no extra swap
   * becomes possible.
   */
  graceSeconds?: number;
  /** GasPolicy budget in wei across all swaps. Mandatory. */
  feeBudgetWei: bigint;
  /** Display name (not used on-chain). */
  label: string;
  /** Optional; when present it must equal `account` (the grant always pins the account). */
  recipient?: string;
}

const MAX_UINT48 = (1n << 48n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function dcaDeploymentFor(chainId: bigint): UniswapV3Deployment | null {
  return DCA_DEPLOYMENTS.find((d) => d.chainId === chainId) ?? null;
}

/** The ERC-20 the router actually takes: WETH9 for a native sale. */
export function dcaTokenInAddress(terms: Pick<DcaTerms, 'chainId' | 'tokenIn'>): string {
  if (terms.tokenIn !== DCA_NATIVE) return terms.tokenIn;
  const deployment = dcaDeploymentFor(terms.chainId);
  if (!deployment) throw new Error(DCA_UNSUPPORTED_CHAIN_REFUSAL);
  return deployment.weth9;
}

export function isNativeDca(terms: Pick<DcaTerms, 'tokenIn'>): boolean {
  return terms.tokenIn === DCA_NATIVE;
}

/** The pinned pool for (chain, pair, fee), or null. */
export function dcaPinnedPool(chainId: bigint, tokenA: string, tokenB: string, fee: number): DcaPinnedPool | null {
  return (
    DCA_PINNED_POOLS.find(
      (p) =>
        p.chainId === chainId &&
        p.fee === fee &&
        ((sameAddress(p.token0, tokenA) && sameAddress(p.token1, tokenB)) ||
          (sameAddress(p.token0, tokenB) && sameAddress(p.token1, tokenA))),
    ) ?? null
  );
}

/** End of the grant: startAt + count × period + grace. */
export function dcaValidUntil(terms: Pick<DcaTerms, 'startAt' | 'count' | 'periodSeconds' | 'graceSeconds'>): number {
  return terms.startAt + terms.count * terms.periodSeconds + (terms.graceSeconds ?? 0);
}

export interface DcaValidationOptions {
  /** Unix seconds for the expiry check; null skips it; default the local clock. */
  now?: number | null | undefined;
}

/** Local, network-free validation; throws a plain sentence on the first problem. */
export function validateDcaTerms(terms: DcaTerms, options: DcaValidationOptions = {}): void {
  const deployment = dcaDeploymentFor(terms.chainId);
  if (!deployment) throw new Error(DCA_UNSUPPORTED_CHAIN_REFUSAL);
  if (!isAddress(terms.account) || sameAddress(terms.account, ZERO_ADDRESS)) {
    throw new Error('The account must be a 20-byte hex address.');
  }
  if (!isAddress(terms.router)) throw new Error(DCA_UNKNOWN_ROUTER_REFUSAL);
  const refused = DCA_REFUSED_ROUTERS.find((r) => sameAddress(r.address, terms.router));
  if (refused) throw new Error(refused.reason === 'deadline' ? DCA_DEADLINE_ROUTER_REFUSAL : DCA_UNPINNABLE_ROUTER_REFUSAL);
  if (!sameAddress(terms.router, deployment.swapRouter02)) throw new Error(DCA_UNKNOWN_ROUTER_REFUSAL);
  if (terms.recipient !== undefined && !sameAddress(terms.recipient, terms.account)) {
    throw new Error(DCA_RECIPIENT_REFUSAL);
  }
  if (terms.tokenOut === DCA_NATIVE) throw new Error(DCA_NATIVE_OUT_REFUSAL);
  if (!isAddress(terms.tokenOut) || sameAddress(terms.tokenOut, ZERO_ADDRESS)) {
    throw new Error('The token bought must be a contract address.');
  }
  if (!isNativeDca(terms) && (!isAddress(terms.tokenIn) || sameAddress(terms.tokenIn, ZERO_ADDRESS))) {
    throw new Error(`The token sold must be a contract address or "${DCA_NATIVE}".`);
  }
  const tokenIn = dcaTokenInAddress(terms);
  if (sameAddress(tokenIn, terms.tokenOut)) throw new Error(DCA_SAME_TOKEN_REFUSAL);
  for (const a of [tokenIn, terms.tokenOut, terms.router]) {
    if (sameAddress(a, terms.account)) throw new Error('Your own account cannot be a token or the router.');
  }
  if (!Number.isInteger(terms.fee) || !UNISWAP_V3_FEE_TIERS.includes(terms.fee)) throw new Error(DCA_FEE_TIER_REFUSAL);
  if (!dcaPinnedPool(terms.chainId, tokenIn, terms.tokenOut, terms.fee)) throw new Error(DCA_UNKNOWN_POOL_REFUSAL);
  if (typeof terms.amountIn !== 'bigint' || terms.amountIn <= 0n || terms.amountIn > MAX_UINT256) {
    throw new Error(DCA_AMOUNT_REFUSAL);
  }
  if (typeof terms.minimumOut !== 'bigint' || terms.minimumOut <= 0n) throw new Error(DCA_FLOOR_ZERO_REFUSAL);
  if (terms.minimumOut > MAX_UINT256) throw new Error('The minimum to receive is too large.');
  if (!Number.isSafeInteger(terms.periodSeconds) || terms.periodSeconds < SUBSCRIPTION_MIN_PERIOD_SECONDS) {
    throw new Error(`The period must be a whole number of seconds, at least ${SUBSCRIPTION_MIN_PERIOD_SECONDS}.`);
  }
  if (BigInt(terms.periodSeconds) > MAX_UINT48) throw new Error('The period is too long.');
  if (!Number.isSafeInteger(terms.count) || terms.count < 1 || terms.count > SUBSCRIPTION_MAX_PERIODS) {
    throw new Error(`The number of swaps must be between 1 and ${SUBSCRIPTION_MAX_PERIODS}.`);
  }
  const grace = terms.graceSeconds ?? 0;
  if (!Number.isSafeInteger(grace) || grace < 0) throw new Error('The grace period must be a whole number of seconds.');
  const isUint48 = (n: number) => Number.isSafeInteger(n) && n >= 0 && BigInt(n) <= MAX_UINT48;
  if (!isUint48(terms.startAt) || terms.startAt === 0) throw new Error('The start must be a unix time (seconds).');
  const validUntil = dcaValidUntil(terms);
  if (!isUint48(validUntil)) throw new Error('The end of the plan is too far in the future.');
  if (typeof terms.feeBudgetWei !== 'bigint' || terms.feeBudgetWei <= 0n || terms.feeBudgetWei > MAX_UINT128) {
    throw new Error(DCA_FEE_BUDGET_REFUSAL);
  }
  if (typeof terms.label !== 'string' || terms.label.trim().length === 0 || [...terms.label].length > SUBSCRIPTION_MAX_LABEL) {
    throw new Error(`Give the plan a name of 1 to ${SUBSCRIPTION_MAX_LABEL} characters.`);
  }
  if (/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/.test(terms.label)) {
    throw new Error('The name contains control or direction characters.');
  }
  const now = options.now === undefined ? Math.floor(Date.now() / 1000) : options.now;
  if (now !== null && validUntil <= now) throw new Error('The plan would already have ended.');
}

const word = (value: bigint | string): string =>
  toHex(toWord(typeof value === 'string' ? BigInt(value.toLowerCase()) : value));

/** The seven parameter rules on exactInputSingle (see the module header for each condition). */
export function dcaSwapRules(terms: DcaTerms): SessionParamRule[] {
  return [
    { condition: 'equal', offset: DCA_PARAM_OFFSETS.tokenIn, params: [word(dcaTokenInAddress(terms))] },
    { condition: 'equal', offset: DCA_PARAM_OFFSETS.tokenOut, params: [word(terms.tokenOut)] },
    { condition: 'equal', offset: DCA_PARAM_OFFSETS.fee, params: [word(BigInt(terms.fee))] },
    { condition: 'equal', offset: DCA_PARAM_OFFSETS.recipient, params: [word(terms.account)] },
    { condition: 'equal', offset: DCA_PARAM_OFFSETS.amountIn, params: [word(terms.amountIn)] },
    { condition: 'greaterThanOrEqual', offset: DCA_PARAM_OFFSETS.amountOutMinimum, params: [word(terms.minimumOut)] },
    { condition: 'equal', offset: DCA_PARAM_OFFSETS.sqrtPriceLimitX96, params: [word(0n)] },
  ];
}

/**
 * The allowed calls: [swap] when selling ETH (value cap = amountIn), or
 * [approve(router, amountIn), swap] when selling an ERC-20 (value 0).
 */
export function dcaAllowedCalls(terms: DcaTerms): SessionAllowedCall[] {
  const swap: SessionAllowedCall = {
    target: terms.router,
    selector: DCA_EXACT_INPUT_SINGLE_SELECTOR,
    valueLimit: isNativeDca(terms) ? terms.amountIn : 0n,
    rules: dcaSwapRules(terms),
  };
  if (isNativeDca(terms)) return [swap];
  return [
    {
      target: terms.tokenIn,
      selector: DCA_APPROVE_SELECTOR,
      valueLimit: 0n,
      rules: [
        { condition: 'equal', offset: 0, params: [word(terms.router)] },
        { condition: 'equal', offset: 32, params: [word(terms.amountIn)] },
      ],
    },
    swap,
  ];
}

/**
 * Maps DCA terms onto a session grant for `sessionKey`, on the subscription
 * template: the allowed calls, TimestampPolicy [startAt, validUntil],
 * GasPolicy feeBudgetWei, RateLimitPolicy {interval = period, count,
 * startAt}. Validates first (throws a plain sentence).
 */
export function dcaGrantFor(terms: DcaTerms, sessionKey: string, options: DcaValidationOptions = {}): SessionKeyGrant {
  validateDcaTerms(terms, options);
  const grant: SessionKeyGrant = {
    sessionKey,
    calls: dcaAllowedCalls(terms),
    validAfter: terms.startAt,
    validUntil: dcaValidUntil(terms),
    gasBudgetWei: terms.feeBudgetWei,
    rateLimit: { count: terms.count, intervalSeconds: terms.periodSeconds, startAt: terms.startAt },
  };
  validateSessionKeyGrant(grant, { account: terms.account, now: options.now });
  return grant;
}

/** True when `grant` is exactly what dcaGrantFor(terms, grant.sessionKey) produces. */
export function dcaTermsMatchGrant(terms: DcaTerms, grant: SessionKeyGrant): boolean {
  let expected: SessionKeyGrant;
  try {
    expected = dcaGrantFor(terms, grant.sessionKey, { now: null });
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

// ---------------------------------------------------------------------------
// The swap call
// ---------------------------------------------------------------------------

export interface DcaSwapParams {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
}

/**
 * The minimum to ask for in one swap: the larger of the plan's floor and a
 * fresh quote less `slippageBps` (rounded down). Asking for more than the
 * floor protects an honest submitter better; it can only make the swap
 * revert (and use up the slot), never make it worse.
 */
export function dcaMinimumOutFor(terms: Pick<DcaTerms, 'minimumOut'>, quotedOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error('Slippage must be a whole number of basis points below 10000.');
  }
  if (quotedOut < 0n) throw new Error('A quote cannot be negative.');
  const fromQuote = (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  return fromQuote > terms.minimumOut ? fromQuote : terms.minimumOut;
}

/** The static floor from a quote: quotedOut × floorBps / 10000, rounded down; refuses 0. */
export function dcaFloorFromQuote(quotedOut: bigint, floorBps: number): bigint {
  if (!Number.isInteger(floorBps) || floorBps <= 0 || floorBps > 10_000) {
    throw new Error('The floor must be a whole number of basis points from 1 to 10000 of the quote.');
  }
  const floor = (quotedOut * BigInt(floorBps)) / 10_000n;
  if (floor <= 0n) throw new Error(DCA_FLOOR_ZERO_REFUSAL);
  return floor;
}

/**
 * The exact exactInputSingle call for one period: the pinned pair, fee and
 * amount, recipient = the account, no price limit, value = amountIn when
 * selling ETH. `minimumOut` defaults to the plan's floor and may only be
 * higher (use dcaMinimumOutFor with a fresh quote).
 */
export function buildDcaSwapCall(terms: DcaTerms, options: { minimumOut?: bigint } = {}): Call {
  validateDcaTerms(terms, { now: null });
  const minimumOut = options.minimumOut ?? terms.minimumOut;
  if (minimumOut < terms.minimumOut) throw new Error(DCA_MINIMUM_BELOW_FLOOR_REFUSAL);
  if (minimumOut > MAX_UINT256) throw new Error('The minimum to receive is too large.');
  return {
    to: terms.router,
    value: isNativeDca(terms) ? terms.amountIn : 0n,
    data: encodeDcaSwapData({
      tokenIn: dcaTokenInAddress(terms),
      tokenOut: terms.tokenOut,
      fee: terms.fee,
      recipient: terms.account,
      amountIn: terms.amountIn,
      amountOutMinimum: minimumOut,
      sqrtPriceLimitX96: 0n,
    }),
  };
}

/** The calls one period needs: [swap] (ETH) or [approve(router, amountIn), swap] (ERC-20). */
export function buildDcaSwapCalls(terms: DcaTerms, options: { minimumOut?: bigint } = {}): Call[] {
  const swap = buildDcaSwapCall(terms, options);
  if (isNativeDca(terms)) return [swap];
  return [{ to: terms.tokenIn, value: 0n, data: encodeErc20Approve(terms.router, terms.amountIn) }, swap];
}

/** ABI encoding of exactInputSingle(params) (no range checks beyond the field widths). */
export function encodeDcaSwapData(params: DcaSwapParams): Uint8Array {
  if (!Number.isInteger(params.fee) || params.fee < 0 || params.fee >= 1 << 24) throw new Error('fee must be a uint24');
  if (params.sqrtPriceLimitX96 < 0n || params.sqrtPriceLimitX96 >= 1n << 160n) {
    throw new Error('sqrtPriceLimitX96 must be a uint160');
  }
  return encodeFunctionCall(DCA_EXACT_INPUT_SINGLE_SIGNATURE, [
    {
      kind: 'tuple',
      items: [
        { kind: 'address', value: params.tokenIn },
        { kind: 'address', value: params.tokenOut },
        { kind: 'uint256', value: BigInt(params.fee) },
        { kind: 'address', value: params.recipient },
        { kind: 'uint256', value: params.amountIn },
        { kind: 'uint256', value: params.amountOutMinimum },
        { kind: 'uint256', value: params.sqrtPriceLimitX96 },
      ],
    },
  ]);
}

/** Decodes exactInputSingle calldata; refuses another selector, another length or dirty high bits. */
export function decodeDcaSwapData(data: Uint8Array): DcaSwapParams {
  if (data.length !== DCA_SWAP_CALLDATA_LENGTH) {
    throw new Error(`The swap calldata must be exactly ${DCA_SWAP_CALLDATA_LENGTH} bytes.`);
  }
  if (toHex(data.slice(0, 4)).toLowerCase() !== DCA_EXACT_INPUT_SINGLE_SELECTOR) {
    throw new Error('Not a SwapRouter02 exactInputSingle call.');
  }
  const w = (i: number) => BigInt(toHex(data.slice(4 + i * 32, 4 + (i + 1) * 32)));
  const address = (i: number) => {
    const v = w(i);
    if (v >= 1n << 160n) throw new Error(`Argument ${i} is not a clean address word.`);
    return '0x' + v.toString(16).padStart(40, '0');
  };
  const fee = w(2);
  if (fee >= 1n << 24n) throw new Error('The fee word has bits above uint24.');
  const limit = w(6);
  if (limit >= 1n << 160n) throw new Error('The price-limit word has bits above uint160.');
  return {
    tokenIn: address(0),
    tokenOut: address(1),
    fee: Number(fee),
    recipient: address(3),
    amountIn: w(4),
    amountOutMinimum: w(5),
    sqrtPriceLimitX96: limit,
  };
}

/**
 * Local check of one period's calls before anything is signed: exactly the
 * expected shape ([swap], or [approve, swap] when selling a token — a batch
 * of anything else is refused), every swap field equal to the plan (amount
 * exactly, minimum at least the floor, recipient the account, no price
 * limit, value exactly amountIn or 0, no trailing calldata), the approval
 * exactly (router, amountIn), and then the grant's own rules and window
 * (assertCallsAllowed, which mirrors CallPolicy).
 */
export function assertDcaSwap(
  terms: DcaTerms,
  sessionKey: string,
  calls: Call[],
  now: number = Math.floor(Date.now() / 1000),
): void {
  const native = isNativeDca(terms);
  if (calls.length !== (native ? 1 : 2)) throw new Error(DCA_BATCH_REFUSAL);
  if (!native) {
    const approve = calls[0]!;
    const expected = encodeErc20Approve(terms.router, terms.amountIn);
    if (!sameAddress(approve.to, terms.tokenIn) || approve.value !== 0n || toHex(approve.data) !== toHex(expected)) {
      throw new Error(DCA_BATCH_REFUSAL);
    }
  }
  const swap = calls[calls.length - 1]!;
  if (!sameAddress(swap.to, terms.router)) throw new Error(DCA_UNKNOWN_ROUTER_REFUSAL);
  const p = decodeDcaSwapData(swap.data);
  if (!sameAddress(p.tokenIn, dcaTokenInAddress(terms)) || !sameAddress(p.tokenOut, terms.tokenOut) || p.fee !== terms.fee) {
    throw new Error(DCA_PAIR_MISMATCH_REFUSAL);
  }
  if (!sameAddress(p.recipient, terms.account)) throw new Error(DCA_RECIPIENT_REFUSAL);
  if (p.amountIn !== terms.amountIn) throw new Error(DCA_AMOUNT_MISMATCH_REFUSAL);
  if (p.amountOutMinimum < terms.minimumOut) throw new Error(DCA_MINIMUM_BELOW_FLOOR_REFUSAL);
  if (p.sqrtPriceLimitX96 !== 0n) throw new Error(DCA_PRICE_LIMIT_REFUSAL);
  if (swap.value !== (native ? terms.amountIn : 0n)) {
    throw new Error(
      native ? 'The swap must send exactly the amount sold as value.' : 'A token sale must not send any ETH with the swap.',
    );
  }
  assertCallsAllowed(dcaGrantFor(terms, sessionKey, { now: null }), calls, now);
}

export interface KernelDcaSpecConfig {
  account: string;
  sessionKey: string;
  permissionId: Uint8Array | string;
  terms: DcaTerms;
  parallelKey?: number;
  entryPoint?: string;
  now?: () => number;
}

/**
 * kernelSessionSpec for a DCA submitter (the phone): signs only with the
 * session key and refuses, before encoding and hence before signing,
 * anything but one in-plan period (assertDcaSwap).
 */
export function kernelDcaSpec(config: KernelDcaSpecConfig): KernelSessionSpec {
  if (!sameAddress(config.account, config.terms.account)) throw new Error('The plan is for another account.');
  const grant = dcaGrantFor(config.terms, config.sessionKey, { now: null });
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
      assertDcaSwap(config.terms, config.sessionKey, calls, config.now ? config.now() : Math.floor(Date.now() / 1000));
      return inner.encodeCalls(calls);
    },
  };
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

export interface DcaPoolState {
  pool: string;
  token0: string;
  token1: string;
  fee: number;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
}

/**
 * Reads the pinned pool and checks it against the factory: factory.getPool
 * must return the pinned address, and the pool must report that factory,
 * the pinned tokens and fee, and non-zero in-range liquidity.
 */
export async function readDcaPool(
  node: JsonRpcTransport,
  terms: Pick<DcaTerms, 'chainId' | 'tokenIn' | 'tokenOut' | 'fee'>,
  block: string = 'latest',
): Promise<DcaPoolState> {
  const deployment = dcaDeploymentFor(terms.chainId);
  if (!deployment) throw new Error(DCA_UNSUPPORTED_CHAIN_REFUSAL);
  const tokenIn = dcaTokenInAddress(terms);
  const pinned = dcaPinnedPool(terms.chainId, tokenIn, terms.tokenOut, terms.fee);
  if (!pinned) throw new Error(DCA_UNKNOWN_POOL_REFUSAL);
  const call = async (to: string, signature: string, args: Parameters<typeof encodeFunctionCall>[1] = []) => {
    const out = (await node('eth_call', [{ to, data: toHex(encodeFunctionCall(signature, args)) }, block])) as string;
    if (typeof out !== 'string' || !/^0x([0-9a-fA-F]{64})+$/.test(out)) throw new Error(`${signature} returned an unexpected shape`);
    return out;
  };
  const addressWord = (hex: string, i = 0) => '0x' + hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);
  const fromFactory = addressWord(
    await call(deployment.factory, 'getPool(address,address,uint24)', [
      { kind: 'address', value: tokenIn },
      { kind: 'address', value: terms.tokenOut },
      { kind: 'uint256', value: BigInt(terms.fee) },
    ]),
  );
  if (!sameAddress(fromFactory, pinned.pool)) {
    throw new Error(`The factory reports pool ${fromFactory} for this pair and fee, not the pinned ${pinned.pool}; refused.`);
  }
  const [factory, token0, token1, feeWord, liquidityWord, slot0] = await Promise.all([
    call(pinned.pool, 'factory()'),
    call(pinned.pool, 'token0()'),
    call(pinned.pool, 'token1()'),
    call(pinned.pool, 'fee()'),
    call(pinned.pool, 'liquidity()'),
    call(pinned.pool, 'slot0()'),
  ]);
  if (!sameAddress(addressWord(factory), deployment.factory)) throw new Error('The pool does not report the pinned factory.');
  if (!sameAddress(addressWord(token0), pinned.token0) || !sameAddress(addressWord(token1), pinned.token1)) {
    throw new Error('The pool does not report the pinned tokens.');
  }
  if (Number(BigInt(feeWord)) !== pinned.fee) throw new Error('The pool does not report the pinned fee.');
  const liquidity = BigInt(liquidityWord);
  if (liquidity === 0n) throw new Error('The pinned pool has no liquidity at its current price; a swap would fail.');
  const sqrtPriceX96 = BigInt('0x' + slot0.slice(2, 66));
  const tick = Number(BigInt.asIntN(24, BigInt('0x' + slot0.slice(66, 130))));
  return { pool: pinned.pool, token0: pinned.token0, token1: pinned.token1, fee: pinned.fee, liquidity, sqrtPriceX96, tick };
}

export interface DcaQuote {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
}

/**
 * QuoterV2.quoteExactInputSingle((tokenIn, tokenOut, amountIn, fee,
 * sqrtPriceLimitX96 = 0)) through eth_call. The quoter simulates the swap
 * and reverts internally; the eth_call returns
 * (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate).
 * A quote is a reading at one block, not a promise.
 */
export async function quoteDcaSwap(
  node: JsonRpcTransport,
  terms: Pick<DcaTerms, 'chainId' | 'tokenIn' | 'tokenOut' | 'fee' | 'amountIn'>,
  block: string = 'latest',
): Promise<DcaQuote> {
  const deployment = dcaDeploymentFor(terms.chainId);
  if (!deployment) throw new Error(DCA_UNSUPPORTED_CHAIN_REFUSAL);
  const data = encodeFunctionCall('quoteExactInputSingle((address,address,uint256,uint24,uint160))', [
    {
      kind: 'tuple',
      items: [
        { kind: 'address', value: dcaTokenInAddress(terms) },
        { kind: 'address', value: terms.tokenOut },
        { kind: 'uint256', value: terms.amountIn },
        { kind: 'uint256', value: BigInt(terms.fee) },
        { kind: 'uint256', value: 0n },
      ],
    },
  ]);
  const out = (await node('eth_call', [{ to: deployment.quoterV2, data: toHex(data) }, block])) as string;
  if (typeof out !== 'string' || out.length !== 2 + 4 * 64) throw new Error('QuoterV2 returned an unexpected shape');
  const w = (i: number) => BigInt('0x' + out.slice(2 + i * 64, 2 + (i + 1) * 64));
  return { amountOut: w(0), sqrtPriceX96After: w(1), initializedTicksCrossed: Number(w(2)), gasEstimate: w(3) };
}

/**
 * The plan's on-chain RateLimitPolicy / GasPolicy state: the same policies
 * and getters as a subscription (kernel-subscription.ts
 * readSubscriptionState); nextPullAllowedAt applies unchanged.
 */
export async function readDcaState(
  node: JsonRpcTransport,
  terms: DcaTerms,
  permissionId: Uint8Array | string,
  modules: KernelPermissionModules = KERNEL_PERMISSION_MODULES,
  block: string = 'latest',
): Promise<SubscriptionChainState> {
  return readSubscriptionState(node, terms.account, permissionId, { validUntil: dcaValidUntil(terms) }, modules, block);
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export interface DcaLog {
  address: string;
  topics: string[];
  data: string;
}

export interface DcaSwapEvent {
  pool: string;
  sender: string;
  recipient: string;
  /** tokenIn the pool received (positive pool delta), base units. */
  amountIn: bigint;
  /** tokenOut the pool paid (negated pool delta), base units. */
  amountOut: bigint;
  sqrtPriceX96: bigint;
  tick: number;
}

export interface DcaOutcome {
  /** Pool Swap events of the pinned pool paying this account. More than one means a batched operation. */
  swaps: DcaSwapEvent[];
  /** tokenOut Transfer events from the pool to the account, summed. */
  tokenOutReceived: bigint;
  amountIn: bigint;
  amountOut: bigint;
  batched: boolean;
  /** True when every swap returned at least the floor. */
  atOrAboveFloor: boolean;
  /** UserOperationEvent success for `userOpHash` when given and found; null otherwise. */
  userOpSuccess: boolean | null;
  /** Raw revert data from UserOperationRevertReason for `userOpHash`, when present. */
  revertReason: string | null;
}

/**
 * Decodes a receipt's logs: the pinned pool's Swap events whose recipient is
 * the account, the tokenOut Transfers from that pool to the account, and,
 * when `userOpHash` is given, the EntryPoint's UserOperationEvent success
 * flag and UserOperationRevertReason data.
 */
export function decodeDcaOutcome(
  terms: DcaTerms,
  logs: DcaLog[],
  options: { userOpHash?: string; entryPoint?: string } = {},
): DcaOutcome {
  const tokenIn = dcaTokenInAddress(terms);
  const pinned = dcaPinnedPool(terms.chainId, tokenIn, terms.tokenOut, terms.fee);
  if (!pinned) throw new Error(DCA_UNKNOWN_POOL_REFUSAL);
  const outIsToken0 = sameAddress(pinned.token0, terms.tokenOut);
  const entryPoint = options.entryPoint ?? ENTRYPOINT_V07;
  const topicAddress = (t: string | undefined) => (t ? '0x' + t.slice(26) : '');
  const signed = (hex: string) => BigInt.asIntN(256, BigInt('0x' + hex));
  const swaps: DcaSwapEvent[] = [];
  let tokenOutReceived = 0n;
  let userOpSuccess: boolean | null = null;
  let revertReason: string | null = null;
  for (const log of logs) {
    const t0 = log.topics[0]?.toLowerCase();
    if (sameAddress(log.address, pinned.pool) && t0 === UNISWAP_V3_SWAP_TOPIC && log.topics.length === 3) {
      if (!sameAddress(topicAddress(log.topics[2]), terms.account)) continue;
      const d = log.data.slice(2);
      if (d.length !== 5 * 64) continue;
      const amount0 = signed(d.slice(0, 64));
      const amount1 = signed(d.slice(64, 128));
      const delta = { in: outIsToken0 ? amount1 : amount0, out: outIsToken0 ? amount0 : amount1 };
      swaps.push({
        pool: pinned.pool,
        sender: topicAddress(log.topics[1]),
        recipient: topicAddress(log.topics[2]),
        amountIn: delta.in,
        amountOut: -delta.out,
        sqrtPriceX96: BigInt('0x' + d.slice(128, 192)),
        tick: Number(BigInt.asIntN(24, BigInt('0x' + d.slice(256, 320)))),
      });
    } else if (sameAddress(log.address, terms.tokenOut) && t0 === TRANSFER_TOPIC && log.topics.length === 3) {
      if (sameAddress(topicAddress(log.topics[1]), pinned.pool) && sameAddress(topicAddress(log.topics[2]), terms.account)) {
        tokenOutReceived += BigInt(log.data);
      }
    } else if (options.userOpHash && sameAddress(log.address, entryPoint)) {
      if (log.topics[1]?.toLowerCase() !== options.userOpHash.toLowerCase()) continue;
      if (t0 === USER_OPERATION_EVENT_TOPIC) {
        userOpSuccess = BigInt('0x' + log.data.slice(2 + 64, 2 + 128)) === 1n;
      } else if (t0 === USER_OPERATION_REVERT_REASON_TOPIC) {
        const d = log.data.slice(2);
        const offset = Number(BigInt('0x' + d.slice(64, 128))) * 2;
        const length = Number(BigInt('0x' + d.slice(offset, offset + 64))) * 2;
        revertReason = '0x' + d.slice(offset + 64, offset + 64 + length);
      }
    }
  }
  const amountIn = swaps.reduce((s, x) => s + x.amountIn, 0n);
  const amountOut = swaps.reduce((s, x) => s + x.amountOut, 0n);
  return {
    swaps,
    tokenOutReceived,
    amountIn,
    amountOut,
    batched: swaps.length > 1,
    atOrAboveFloor: swaps.length > 0 && swaps.every((s) => s.amountOut >= terms.minimumOut),
    userOpSuccess,
    revertReason,
  };
}

// ---------------------------------------------------------------------------
// Storage and plain language
// ---------------------------------------------------------------------------

export interface SerializedDcaTerms {
  version: 1;
  chainId: string;
  account: string;
  router: string;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: string;
  minimumOut: string;
  periodSeconds: number;
  count: number;
  startAt: number;
  graceSeconds: number;
  feeBudgetWei: string;
  label: string;
}

export function serializeDcaTerms(terms: DcaTerms): SerializedDcaTerms {
  return {
    version: 1,
    chainId: terms.chainId.toString(10),
    account: terms.account,
    router: terms.router,
    tokenIn: terms.tokenIn,
    tokenOut: terms.tokenOut,
    fee: terms.fee,
    amountIn: terms.amountIn.toString(10),
    minimumOut: terms.minimumOut.toString(10),
    periodSeconds: terms.periodSeconds,
    count: terms.count,
    startAt: terms.startAt,
    graceSeconds: terms.graceSeconds ?? 0,
    feeBudgetWei: terms.feeBudgetWei.toString(10),
    label: terms.label,
  };
}

/** Parses and re-validates stored terms (no clock check). */
export function parseDcaTerms(value: unknown): DcaTerms {
  const v = value as Partial<SerializedDcaTerms> | null;
  if (!v || typeof v !== 'object' || v.version !== 1) throw new Error('Not version-1 serialized recurring-swap terms');
  const decimal = (s: unknown, what: string): bigint => {
    if (typeof s !== 'string' || !/^(0|[1-9][0-9]*)$/.test(s)) throw new Error(`${what} must be a decimal string`);
    return BigInt(s);
  };
  const terms: DcaTerms = {
    chainId: decimal(v.chainId, 'chainId'),
    account: String(v.account),
    router: String(v.router),
    tokenIn: String(v.tokenIn),
    tokenOut: String(v.tokenOut),
    fee: Number(v.fee),
    amountIn: decimal(v.amountIn, 'amountIn'),
    minimumOut: decimal(v.minimumOut, 'minimumOut'),
    periodSeconds: Number(v.periodSeconds),
    count: Number(v.count),
    startAt: Number(v.startAt),
    graceSeconds: Number(v.graceSeconds ?? 0),
    feeBudgetWei: decimal(v.feeBudgetWei, 'feeBudgetWei'),
    label: String(v.label),
  };
  validateDcaTerms(terms, { now: null });
  return terms;
}

export interface DcaDescription {
  sentence: string;
  enforced: string[];
  /** Always shown, the static-floor caveat first. */
  caveats: string[];
}

export function describeDca(
  terms: DcaTerms,
  context: { symbolIn: string; decimalsIn: number; symbolOut: string; decimalsOut: number; nativeSymbol?: string },
): DcaDescription {
  const sell = `${formatBaseUnits(terms.amountIn, context.decimalsIn)} ${context.symbolIn}`;
  const floor = `${formatBaseUnits(terms.minimumOut, context.decimalsOut)} ${context.symbolOut}`;
  const period = describePeriod(terms.periodSeconds);
  const native = context.nativeSymbol ?? 'ETH';
  const fee = `${formatBaseUnits(terms.feeBudgetWei, 18)} ${native}`;
  const pool = dcaPinnedPool(terms.chainId, dcaTokenInAddress(terms), terms.tokenOut, terms.fee);
  const sentence =
    `Swaps ${sell} for ${context.symbolOut} every ${period}, ${terms.count} time${terms.count === 1 ? '' : 's'}, ` +
    `until ${formatUtc(dcaValidUntil(terms))}; each swap must return at least ${floor}.`;
  const enforced = [
    `Only Uniswap's SwapRouter02 (${terms.router}), only the ${pool?.label ?? 'pinned'} pool (${pool?.pool ?? '?'}).`,
    `Exactly ${sell} per swap; at least ${floor} back per swap, or the swap reverts.`,
    `The ${context.symbolOut} bought goes only to this account (${terms.account}).`,
    `At most ${terms.count} swap${terms.count === 1 ? '' : 's'}: the first from ${formatUtc(terms.startAt)}, then one more every ${period}.`,
    `Nothing after ${formatUtc(dcaValidUntil(terms))}.`,
    `Network fees for the swaps are paid by your account, at most ${fee} in total.`,
    'The key cannot sign messages, logins or permits for your account.',
  ];
  const caveats = [
    `THE MINIMUM DOES NOT FOLLOW THE PRICE. ${floor} per swap was fixed when the plan was set up. If the market ` +
      'falls, a swap can still go through at that minimum; if the price drops below it, the swap reverts.',
    'There is no deadline: a swap executes whenever the network includes it, at the price at that moment, subject only to the minimum.',
    `ONE OPERATION CAN HOLD SEVERAL SWAPS. Your account checks each swap on its own and cannot refuse a batch, so ` +
      `whoever holds the key could sell more than ${sell} in one period, up to everything this account holds, ` +
      'each swap at no less than the minimum. Keep only what you are willing to swap in this account.',
    'A swap that reverts still uses up its period: nothing is lost except the network fee, but that period’s swap is gone.',
    ...(isNativeDca(terms)
      ? [
          `${context.symbolIn} that the pool does not take in a swap (only possible when the pool runs out of ` +
            'liquidity) stays in the router, where anyone can take it; the minimum still applies to what you receive.',
        ]
      : []),
    'Missed periods are not lost: a period not used can be used later, even right before the next one.',
    'Revoke at any time (one operation signed by your account key). Swaps already made are not undone.',
  ];
  return { sentence, enforced, caveats };
}

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}


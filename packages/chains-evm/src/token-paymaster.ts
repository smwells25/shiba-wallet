import { concatBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { encodeFunctionCall } from './abi.js';
import { domainSeparator, typedDataDigest, type TypedDataDomain, type TypedDataTypes } from './eip712.js';
import { bigintToHex, keccak, toBytes, toHex, toWord } from './encoding.js';
import { decodeUint256, encodeErc20Approve } from './erc20.js';
import type { JsonRpcTransport } from './rpc.js';
import type { Call } from './smart-account.js';
import { ENTRYPOINT_V07 } from './userop.js';

/**
 * Paying a smart-account operation's network fee in an ERC-20 token, through
 * Circle's permissionless token paymaster for EntryPoint v0.7 (phase 13,
 * feature 16).
 *
 * WHY THIS PAYMASTER. It is the only candidate found (2026-10-04) that works
 * with EntryPoint v0.7 and a Kernel v3.3 account WITHOUT an off-chain
 * service, an API key or a vendor dashboard policy: the exchange rate comes
 * from an on-chain oracle the paymaster reads during validation, and the
 * token is pulled with an ordinary ERC-20 allowance (or an EIP-2612 permit
 * carried in paymasterData). Sources, all fetched 2026-10-04:
 *  - [C1] developers.circle.com/paymaster.md: "Circle has a network of
 *    permissionless token paymasters"; "You don't need to sign up for a
 *    Circle Developer account or generate any API keys. The Paymaster has no
 *    dependency on offchain APIs"; v0.7 is supported on "Arbitrum and Base"
 *    only (v0.8 adds Ethereum and others); "There is a 10% surcharge on gas
 *    fees ... The 10% surcharge only applies to Arbitrum and Base (and their
 *    testnets)".
 *  - [C2] developers.circle.com/paymaster/addresses-and-events.md: Paymaster
 *    v0.7 testnet address 0x31BE08D380A21fc740883c0BC434FcFc88740b58 on
 *    Arbitrum Sepolia and Base Sepolia (NOT Ethereum Sepolia; both checked
 *    on-chain, see `tokens` below); mainnet
 *    0x6C973eBe80dCD8660841D4356bf15c32460271C9 on Arbitrum and Base; the
 *    UserOperationSponsored event.
 *  - [C3] developers.circle.com/paymaster/pay-gas-fees-usdc.md: paymasterData
 *    = encodePacked(uint8 0, address token, uint256 permitAmount, bytes
 *    permitSignature); permit deadline MAX_UINT256 because "The paymaster
 *    cannot access block.timestamp due to 4337 opcode restrictions";
 *    example limits paymasterVerificationGasLimit 200000,
 *    paymasterPostOpGasLimit 35000.
 *  - [S] The deployed implementation's verified source (Sourcify exact
 *    match, chain 84532, implementation
 *    0x1E42055dECF050828AfE8bA0A374bC5F44CbFC8d behind the ERC-1967 proxy
 *    0x31BE...0b58, verified 2026-07-17; solc 0.8.28, GPL-3.0-or-later):
 *    src/paymaster/TokenPaymasterV07.sol, src/paymaster/BaseTokenPaymaster.sol,
 *    src/utils/FeeLib.sol, src/utils/PriceOracleHelper.sol. Everything below
 *    about offsets, the fee formula and the permit path is read from those
 *    files, not from the documentation.
 *
 * HOW IT CHARGES ([S] TokenPaymasterV07.validatePaymasterUserOp / postOp):
 *  1. If paymasterAndData is longer than 53 bytes (20 paymaster + 32 gas
 *     limits + 1 reserved byte), bytes 53..73 are the token, 73..105 the
 *     permit amount and 105.. the permit signature; the paymaster calls
 *     token.permit(sender, paymaster, amount, type(uint256).max, signature)
 *     inside try/catch (a failed permit is ignored, "expecting the permit
 *     was already run").
 *  2. price = oracle.latestRoundData().answer scaled to the token's
 *     decimals ("price of 1 ether = 1e18 wei, denominated in token");
 *     prefund = ((additionalGasCharge * maxFeePerGas + maxCost) * price
 *     / 1e18 + 1) * (1 + feeSpread / 10000), where maxCost is the
 *     EntryPoint's required prefund; it pulls the prefund with
 *     transferFrom(sender, paymaster) DURING VALIDATION.
 *  3. postOp recomputes the charge from the actual gas (plus additional gas
 *     and EntryPoint v0.7's 10 percent unused-execution-gas penalty) and
 *     refunds prefund - actual to the sender. It never takes more than the
 *     prefund, so the prefund IS the worst case the user can be charged.
 *
 * ON-CHAIN FACTS (Base Sepolia, read 2026-10-04, block ~47,682,466):
 * entryPoint() = EntryPoint v0.7; token() = USDC
 * 0x036CbD53842c5426634e7929541eC2318f3dCF7e; EntryPoint deposit ~1.007 ETH,
 * staked 0.25 ETH with an 86,400 s unstake delay; additionalGasCharge
 * 35,000; feeSpread 0 (the documented 10 percent surcharge is NOT applied
 * on this testnet deployment); not paused; oracle
 * 0x74479c39dDAFb0549ED6c26080c6e5D155300a89 answers a fixed 3000.00000000
 * (8 decimals, roundId 1, updatedAt 2): a static test price, not a market
 * feed. fetchPrice() ignores updatedAt, so the paymaster has no staleness
 * check of its own. The proxy is UUPS-upgradeable by its owner
 * 0x86665ff7bb7dd39e136cb7838117ca63dcd51461, which can also pause it,
 * change the oracle, the fee spread (fee controller role) and the
 * additional gas charge. On Ethereum Sepolia the same proxy address holds
 * code but entryPoint() reverts and its EntryPoint v0.7 deposit is zero, so
 * it is unusable there.
 *
 * WHAT THE ACCOUNT GRANTS. Either (a) an EIP-2612 permit carried in
 * paymasterData, signed by the ACCOUNT (an ERC-1271 signature for a
 * contract account — USDC's permit(address,address,uint256,uint256,bytes)
 * checks it with SignatureChecker, circlefin/stablecoin-evm
 * contracts/v2/EIP2612.sol, which also skips the TIMESTAMP check when the
 * deadline is type(uint256).max), or (b) a prior ERC-20 approve. A permit
 * SETS the allowance (it does not add), so this module always permits
 * exactly the worst-case prefund of the operation being signed; the
 * paymaster pulls exactly that prefund and refunds the unused part as a
 * token transfer, leaving an allowance of zero. Nothing here ever grants an
 * unlimited allowance.
 *
 * ERC-7562 (bundler rules). The paymaster is staked, so it may keep a
 * context for postOp and read its own and the oracle's storage during
 * validation. The token calls touch only storage keyed by the sender
 * (balance, allowance, permit nonce) and the account's own ERC-1271 check,
 * which the rules treat as the sender's associated storage once the account
 * exists. Whether a given bundler accepts the permit path for a Kernel
 * account is an empirical question, answered per bundler by
 * scripts/testnet/token-gas-smoke.mjs. ZeroDev's Base Sepolia bundler
 * accepted it on 2026-10-04 (userOpHash 0x49f93a11...f7f6, bundle tx
 * 0x83f56b31...b4cb, block 47,682,905); other bundlers are untested.
 */

/** Circle's token paymaster for EntryPoint v0.7 on the test networks [C2]. */
export const CIRCLE_TOKEN_PAYMASTER_V07 = {
  /** Same address on Arbitrum Sepolia and Base Sepolia [C2]. */
  testnetAddress: '0x31BE08D380A21fc740883c0BC434FcFc88740b58',
  /** Documented mainnet address on Arbitrum and Base [C2]; NOT verified on-chain by this project. */
  mainnetAddress: '0x6C973eBe80dCD8660841D4356bf15c32460271C9',
  entryPoint: ENTRYPOINT_V07,
  /**
   * Tokens verified on-chain per chain id (token() of the paymaster).
   * 84532 = Base Sepolia, read 2026-10-04. 421614 = Arbitrum Sepolia, read
   * 2026-10-04 (phase 14 item 3): token() = Circle's Arbitrum Sepolia USDC
   * (developers.circle.com/stablecoins/usdc-contract-addresses: "| Arbitrum
   * Sepolia | 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d |"), entryPoint()
   * v0.7, not paused, feeSpread 0, additionalGasCharge 35,000, a fixed test
   * oracle (0x66B5…bf52, answer 3,000.00000000, roundId 1, updatedAt 2),
   * staked 0.25 ETH / 86,400 s with a deposit of about 1.05 ETH;
   * readCirclePaymasterState + circlePaymasterProblems pass. Its ERC-1967
   * implementation 0xD9d18FD662B5B2F567545C13fd1e902008beD755 is a Sourcify
   * exact match (TokenPaymasterV07, solc 0.8.28) and differs from Base
   * Sepolia's only in immutable address slots (token, wrapped native token,
   * its own address).
   */
  tokens: {
    '84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    '421614': '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  } as Record<string, string>,
  /** The documented example's paymasterVerificationGasLimit [C3]. */
  defaultVerificationGasLimit: 200_000n,
  /** The documented example's paymasterPostOpGasLimit [C3]. */
  defaultPostOpGasLimit: 35_000n,
} as const;

/** 20 bytes paymaster + 32 bytes gas limits + 1 reserved byte [S BaseTokenPaymaster]. */
export const CIRCLE_PAYMASTER_TOKEN_ADDRESS_OFFSET = 53;
/** Start of the permit signature inside paymasterAndData [S]. */
export const CIRCLE_PAYMASTER_PERMIT_SIGNATURE_OFFSET = 53 + 20 + 32;
/** FeeLib.BIPS_DENOMINATOR [S]. */
export const CIRCLE_FEE_BIPS_DENOMINATOR = 10_000n;
/** The only deadline the paymaster ever passes to permit [S, C3]. */
export const PERMIT_DEADLINE_MAX = (1n << 256n) - 1n;

const MAX_UINT256 = (1n << 256n) - 1n;
const ONE_ETHER = 10n ** 18n;

/**
 * keccak256("UserOperationSponsored(address,address,bytes32,uint256,uint256,uint256)"):
 * the event Circle's paymaster emits from postOp [S BaseTokenPaymaster, C2].
 * The first two parameters are indexed (token, sender).
 */
export const CIRCLE_USER_OPERATION_SPONSORED_TOPIC = toHex(
  keccak(new TextEncoder().encode('UserOperationSponsored(address,address,bytes32,uint256,uint256,uint256)')),
);

// ---------------------------------------------------------------------------
// paymasterData encoding
// ---------------------------------------------------------------------------

export type CirclePaymasterData =
  /** No permit: the paymaster relies on an existing allowance. */
  | { mode: 'allowance' }
  /** An EIP-2612 permit the paymaster runs before pulling the prefund. */
  | { mode: 'permit'; token: string; permitAmount: bigint; permitSignature: Uint8Array };

/**
 * paymasterData (the bytes after paymaster + gas limits) for Circle's
 * paymaster: the reserved byte 0x00 alone in allowance mode, or
 * 0x00 || token (20) || permitAmount (uint256) || signature in permit mode,
 * i.e. viem's encodePacked(["uint8","address","uint256","bytes"], ...) [C3].
 */
export function encodeCirclePaymasterData(data: CirclePaymasterData): Uint8Array {
  if (data.mode === 'allowance') return new Uint8Array([0]);
  if (data.permitAmount < 0n || data.permitAmount > MAX_UINT256) {
    throw new Error('Permit amount must be a uint256');
  }
  if (data.permitSignature.length === 0) throw new Error('A permit needs a signature');
  return concatBytes(new Uint8Array([0]), toBytes(data.token), toWord(data.permitAmount), data.permitSignature);
}

/**
 * Inverse of encodeCirclePaymasterData, applying the contract's own length
 * rules [S TokenPaymasterV07]: total paymasterAndData length <= 53 means no
 * permit; between 54 and 104 is "MalformedPaymasterData".
 */
export function parseCirclePaymasterData(paymasterData: Uint8Array): CirclePaymasterData {
  const total = 52 + paymasterData.length;
  if (total <= CIRCLE_PAYMASTER_TOKEN_ADDRESS_OFFSET) return { mode: 'allowance' };
  if (total < CIRCLE_PAYMASTER_PERMIT_SIGNATURE_OFFSET) {
    throw new Error('Malformed Circle paymaster data: too short for a permit');
  }
  const token = toChecksumAddress(paymasterData.slice(1, 21));
  const permitAmount = BigInt(toHex(paymasterData.slice(21, 53)));
  return { mode: 'permit', token, permitAmount, permitSignature: paymasterData.slice(53) };
}

// ---------------------------------------------------------------------------
// Fee math (exact bigint mirrors of FeeLib and the EntryPoint)
// ---------------------------------------------------------------------------

/** The gas fields that decide an operation's EntryPoint v0.7 required prefund. */
export interface PrefundGasFields {
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  maxFeePerGas: bigint;
}

/**
 * EntryPoint v0.7 _getRequiredPrefund (eth-infinitism/account-abstraction
 * v0.7.0 contracts/core/EntryPoint.sol): the sum of the five gas limits
 * times maxFeePerGas. This is the `maxCost` the paymaster receives.
 */
export function entryPointRequiredPrefund(gas: PrefundGasFields): bigint {
  return (
    (gas.verificationGasLimit +
      gas.callGasLimit +
      gas.paymasterVerificationGasLimit +
      gas.paymasterPostOpGasLimit +
      gas.preVerificationGas) *
    gas.maxFeePerGas
  );
}

/** FeeLib.calculateTokenCost: wei * price / 1e18, plus one base unit (rounding up) [S]. */
export function circleTokenCost(nativeTokenPrice: bigint, weiCost: bigint): bigint {
  return (weiCost * nativeTokenPrice) / ONE_ETHER + 1n;
}

/**
 * FeeLib.calculateUserChargeWithSpread [S]: base = tokenCost(additionalGas *
 * gasPrice + gasCost); fee = base * spreadBips / 10000 (rounded down).
 */
export function circleUserCharge(
  nativeTokenPrice: bigint,
  additionalGasCharge: bigint,
  gasPrice: bigint,
  gasCostWei: bigint,
  feeSpreadBips: bigint,
): { baseTokenAmount: bigint; feeTokenAmount: bigint; total: bigint } {
  const baseTokenAmount = circleTokenCost(nativeTokenPrice, additionalGasCharge * gasPrice + gasCostWei);
  const feeTokenAmount = (baseTokenAmount * feeSpreadBips) / CIRCLE_FEE_BIPS_DENOMINATOR;
  return { baseTokenAmount, feeTokenAmount, total: baseTokenAmount + feeTokenAmount };
}

/** The paymaster parameters that decide the token charge. */
export interface CirclePricing {
  /** fetchPrice(): price of 1e18 wei in token base units. */
  nativeTokenPrice: bigint;
  /** additionalGasCharge(): gas added per operation for postOp. */
  additionalGasCharge: bigint;
  /** feeSpread(): spread in basis points. */
  feeSpreadBips: bigint;
}

export interface CircleTokenQuote extends CirclePricing {
  /** The EntryPoint's required prefund in wei (maxCost). */
  requiredPrefundWei: bigint;
  /** additionalGasCharge * maxFeePerGas + requiredPrefund: the wei the token covers in the worst case. */
  worstCaseWei: bigint;
  baseTokenAmount: bigint;
  feeTokenAmount: bigint;
  /**
   * The prefund the paymaster pulls during validation: the most the
   * operation can cost in token base units (postOp only ever refunds).
   */
  maxTokenCharge: bigint;
}

/** Worst-case token charge of an operation with these gas fields, exactly as validation computes it [S]. */
export function quoteCircleTokenCharge(pricing: CirclePricing, gas: PrefundGasFields): CircleTokenQuote {
  if (pricing.nativeTokenPrice <= 0n) throw new Error('The paymaster price must be positive');
  const requiredPrefundWei = entryPointRequiredPrefund(gas);
  const charge = circleUserCharge(
    pricing.nativeTokenPrice,
    pricing.additionalGasCharge,
    gas.maxFeePerGas,
    requiredPrefundWei,
    pricing.feeSpreadBips,
  );
  return {
    ...pricing,
    requiredPrefundWei,
    worstCaseWei: pricing.additionalGasCharge * gas.maxFeePerGas + requiredPrefundWei,
    baseTokenAmount: charge.baseTokenAmount,
    feeTokenAmount: charge.feeTokenAmount,
    maxTokenCharge: charge.total,
  };
}

/**
 * The amount postOp keeps (actualTokenNeeded in UserOperationSponsored),
 * recomputed from the operation's facts [S TokenPaymasterV07.postOp]. Used
 * to check a receipt independently; the user is never charged more than the
 * prefund even if this exceeds it (postOp only refunds).
 */
export function circlePostOpCharge(args: {
  pricing: CirclePricing;
  /** actualGasCost passed to postOp (wei, before the paymaster's own penalty estimate). */
  actualGasCost: bigint;
  /** actualUserOpFeePerGas passed to postOp. */
  actualUserOpFeePerGas: bigint;
  /** preVerificationGas + verificationGasLimit + paymasterVerificationGasLimit. */
  preOpGasApproximation: bigint;
  /** callGasLimit + paymasterPostOpGasLimit. */
  executionGasLimit: bigint;
}): { actualTokenNeeded: bigint; feeTokenAmount: bigint; expectedPenaltyGas: bigint } {
  const { pricing, actualGasCost, actualUserOpFeePerGas, preOpGasApproximation, executionGasLimit } = args;
  if (actualUserOpFeePerGas <= 0n) throw new Error('actualUserOpFeePerGas must be positive');
  const actualGas = actualGasCost / actualUserOpFeePerGas;
  let executionGasUsed = 0n;
  if (actualGas + pricing.additionalGasCharge > preOpGasApproximation) {
    executionGasUsed = actualGas + pricing.additionalGasCharge - preOpGasApproximation;
  }
  let expectedPenaltyGas = 0n;
  if (executionGasLimit > executionGasUsed) {
    expectedPenaltyGas = ((executionGasLimit - executionGasUsed) * 10n) / 100n;
  }
  const charge = circleUserCharge(
    pricing.nativeTokenPrice,
    pricing.additionalGasCharge + expectedPenaltyGas,
    actualUserOpFeePerGas,
    actualGasCost,
    pricing.feeSpreadBips,
  );
  return { actualTokenNeeded: charge.total, feeTokenAmount: charge.feeTokenAmount, expectedPenaltyGas };
}

// ---------------------------------------------------------------------------
// On-chain state
// ---------------------------------------------------------------------------

export interface CirclePaymasterState extends CirclePricing {
  paymaster: string;
  entryPoint: string;
  token: string;
  tokenDecimals: number;
  paused: boolean;
  owner: string;
  oracle: string;
  /** ERC-1967 implementation slot of the proxy. */
  implementation: string;
  /** EntryPoint deposit (wei). */
  deposit: bigint;
  staked: boolean;
  stake: bigint;
  unstakeDelaySec: bigint;
}

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

async function ethCall(node: JsonRpcTransport, to: string, data: Uint8Array, block = 'latest'): Promise<string> {
  return (await node('eth_call', [{ to, data: toHex(data) }, block])) as string;
}

function word(result: string, index: number): string {
  const body = result.startsWith('0x') ? result.slice(2) : result;
  const w = body.slice(index * 64, index * 64 + 64);
  if (w.length !== 64) throw new Error('Short eth_call result');
  return '0x' + w;
}

function wordAddress(result: string, index = 0): string {
  const w = word(result, index);
  if (!/^0x0{24}/.test(w)) throw new Error('Expected an address word');
  return toChecksumAddress(toBytes('0x' + w.slice(26)));
}

/**
 * Reads everything the quote and the safety checks need from the paymaster
 * and the EntryPoint (getDepositInfo is StakeManager's v0.7 view:
 * deposit uint256, staked bool, stake uint112, unstakeDelaySec uint32,
 * withdrawTime uint48).
 */
export async function readCirclePaymasterState(
  node: JsonRpcTransport,
  paymaster: string,
  entryPoint: string = ENTRYPOINT_V07,
): Promise<CirclePaymasterState> {
  const read = (signature: string) => ethCall(node, paymaster, encodeFunctionCall(signature, []));
  const [ep, token, tokenDecimals, price, extra, spread, paused, owner, oracle, impl, info] = await Promise.all([
    read('entryPoint()'),
    read('token()'),
    read('tokenDecimals()'),
    read('fetchPrice()'),
    read('additionalGasCharge()'),
    read('feeSpread()'),
    read('paused()'),
    read('owner()'),
    read('oracle()'),
    node('eth_getStorageAt', [paymaster, IMPLEMENTATION_SLOT, 'latest']) as Promise<string>,
    ethCall(node, entryPoint, encodeFunctionCall('getDepositInfo(address)', [{ kind: 'address', value: paymaster }])),
  ]);
  return {
    paymaster: toChecksumAddress(toBytes(paymaster)),
    entryPoint: wordAddress(ep),
    token: wordAddress(token),
    tokenDecimals: Number(decodeUint256(word(tokenDecimals, 0))),
    nativeTokenPrice: decodeUint256(word(price, 0)),
    additionalGasCharge: decodeUint256(word(extra, 0)),
    feeSpreadBips: decodeUint256(word(spread, 0)),
    paused: decodeUint256(word(paused, 0)) !== 0n,
    owner: wordAddress(owner),
    oracle: wordAddress(oracle),
    implementation: wordAddress(impl),
    deposit: BigInt(word(info, 0)),
    staked: BigInt(word(info, 1)) !== 0n,
    stake: BigInt(word(info, 2)),
    unstakeDelaySec: BigInt(word(info, 3)),
  };
}

/**
 * Plain-language problems that make the paymaster unusable or unsafe for
 * this operation; an empty list means usable. `minDeposit` lets a caller
 * require the deposit to cover the operation's required prefund.
 */
export function circlePaymasterProblems(
  state: CirclePaymasterState,
  expected: { entryPoint?: string; token: string; minDeposit?: bigint },
): string[] {
  const problems: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(state.entryPoint, expected.entryPoint ?? ENTRYPOINT_V07)) {
    problems.push(`The paymaster serves EntryPoint ${state.entryPoint}, not ${expected.entryPoint ?? ENTRYPOINT_V07}.`);
  }
  if (!same(state.token, expected.token)) {
    problems.push(`The paymaster accepts only ${state.token}, not ${expected.token}.`);
  }
  if (state.paused) problems.push('The paymaster is paused by its operator.');
  if (state.nativeTokenPrice <= 0n) problems.push('The paymaster reports no usable price.');
  if (!state.staked) problems.push('The paymaster is not staked in the EntryPoint, so bundlers may refuse it.');
  if (state.deposit === 0n) problems.push('The paymaster has no EntryPoint deposit.');
  if (expected.minDeposit !== undefined && state.deposit < expected.minDeposit) {
    problems.push('The paymaster deposit is below this operation’s required prefund.');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// EIP-2612 permit for the token
// ---------------------------------------------------------------------------

export const EIP2612_PERMIT_TYPES: TypedDataTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export interface PermitRequest {
  domain: Required<Pick<TypedDataDomain, 'name' | 'version' | 'chainId' | 'verifyingContract'>>;
  types: TypedDataTypes;
  primaryType: 'Permit';
  message: { owner: string; spender: string; value: bigint; nonce: bigint; deadline: bigint };
  /** The EIP-712 digest the account signs (as ERC-1271 for a contract account). */
  digest: Uint8Array;
}

/**
 * The exact EIP-2612 permit the paymaster will run: deadline is always
 * type(uint256).max because that is the only deadline the paymaster passes
 * [S TokenPaymasterV07], so the signature must commit to it.
 */
export function buildTokenPermit(args: {
  token: string;
  name: string;
  version: string;
  chainId: bigint;
  owner: string;
  spender: string;
  value: bigint;
  nonce: bigint;
}): PermitRequest {
  if (args.value < 0n || args.value > MAX_UINT256) throw new Error('Permit value must be a uint256');
  const domain = {
    name: args.name,
    version: args.version,
    chainId: args.chainId,
    verifyingContract: args.token,
  };
  const message = {
    owner: args.owner,
    spender: args.spender,
    value: args.value,
    nonce: args.nonce,
    deadline: PERMIT_DEADLINE_MAX,
  };
  return {
    domain,
    types: EIP2612_PERMIT_TYPES,
    primaryType: 'Permit',
    message,
    digest: typedDataDigest(domain, EIP2612_PERMIT_TYPES, 'Permit', message),
  };
}

/** Strict ABI string decoding (offset 32, length, UTF-8). */
function decodeAbiString(result: string): string {
  const bytes = toBytes(result);
  if (bytes.length < 64) throw new Error('Short ABI string');
  const offset = Number(BigInt(toHex(bytes.slice(0, 32))));
  if (offset !== 32) throw new Error('Unexpected ABI string offset');
  const length = Number(BigInt(toHex(bytes.slice(32, 64))));
  if (64 + length > bytes.length) throw new Error('ABI string longer than the result');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(64, 64 + length));
}

export interface TokenPermitInfo {
  name: string;
  version: string;
  nonce: bigint;
  /** DOMAIN_SEPARATOR() as reported by the token. */
  domainSeparator: string;
}

/**
 * Reads name(), version(), nonces(owner) and DOMAIN_SEPARATOR(), and REFUSES
 * when the reported separator differs from the one computed from name,
 * version, chain id and address, because a permit signed under the wrong
 * domain would silently fail inside the paymaster's try/catch.
 */
export async function readTokenPermitInfo(
  node: JsonRpcTransport,
  token: string,
  owner: string,
  chainId: bigint,
): Promise<TokenPermitInfo> {
  const [name, version, nonce, separator] = await Promise.all([
    ethCall(node, token, encodeFunctionCall('name()', [])),
    ethCall(node, token, encodeFunctionCall('version()', [])),
    ethCall(node, token, encodeFunctionCall('nonces(address)', [{ kind: 'address', value: owner }])),
    ethCall(node, token, encodeFunctionCall('DOMAIN_SEPARATOR()', [])),
  ]);
  const info: TokenPermitInfo = {
    name: decodeAbiString(name),
    version: decodeAbiString(version),
    nonce: decodeUint256(word(nonce, 0)),
    domainSeparator: word(separator, 0),
  };
  const expected = toHex(domainSeparator({ name: info.name, version: info.version, chainId, verifyingContract: token }));
  if (expected.toLowerCase() !== info.domainSeparator.toLowerCase()) {
    throw new Error(
      `The token's DOMAIN_SEPARATOR ${info.domainSeparator} does not match the EIP-712 domain ` +
        `(name "${info.name}", version "${info.version}", chain ${chainId}); refusing to sign a permit.`,
    );
  }
  return info;
}

/** balanceOf and allowance(owner, spender) of a token, in base units. */
export async function readTokenBalanceAndAllowance(
  node: JsonRpcTransport,
  token: string,
  owner: string,
  spender: string,
  block = 'latest',
): Promise<{ balance: bigint; allowance: bigint }> {
  const [balance, allowance] = await Promise.all([
    ethCall(node, token, encodeFunctionCall('balanceOf(address)', [{ kind: 'address', value: owner }]), block),
    ethCall(
      node,
      token,
      encodeFunctionCall('allowance(address,address)', [
        { kind: 'address', value: owner },
        { kind: 'address', value: spender },
      ]),
      block,
    ),
  ]);
  return { balance: decodeUint256(word(balance, 0)), allowance: decodeUint256(word(allowance, 0)) };
}

/**
 * The approve call for allowance mode: EXACTLY `amount` (the quote's
 * maxTokenCharge, or a total the user chose for several operations), never
 * unlimited. It must be executed BEFORE the operation it pays for, because
 * the paymaster pulls the prefund during validation, before the account's
 * calls run; an approve batched into the same operation is too late.
 */
export function circlePaymasterApproveCall(token: string, paymaster: string, amount: bigint): Call {
  if (amount <= 0n || amount >= MAX_UINT256) {
    throw new Error('Approve an exact, finite amount for the paymaster');
  }
  return { to: token, value: 0n, data: encodeErc20Approve(paymaster, amount) };
}

// ---------------------------------------------------------------------------
// Errors a caller can show in plain words
// ---------------------------------------------------------------------------

export class TokenGasInsufficientBalanceError extends Error {
  constructor(
    readonly required: bigint,
    readonly balance: bigint,
  ) {
    super(
      `The account holds ${balance} token base units but the network fee may cost up to ${required}; ` +
        'add tokens or pay the fee in ETH.',
    );
    this.name = 'TokenGasInsufficientBalanceError';
  }
}

export class TokenGasAllowanceError extends Error {
  constructor(
    readonly required: bigint,
    readonly allowance: bigint,
  ) {
    super(
      `The paymaster may take up to ${required} token base units but is approved for only ${allowance}; ` +
        'approve the paymaster for that exact amount first (in a separate operation) or use a permit.',
    );
    this.name = 'TokenGasAllowanceError';
  }
}

export class TokenGasChargeAboveLimitError extends Error {
  constructor(
    readonly required: bigint,
    readonly limit: bigint,
  ) {
    super(
      `The network fee may now cost up to ${required} token base units, above the ${limit} you approved; ` +
        'review the new fee.',
    );
    this.name = 'TokenGasChargeAboveLimitError';
  }
}

// ---------------------------------------------------------------------------
// A local ERC-7677 transport for SmartAccountClient
// ---------------------------------------------------------------------------

export interface CirclePaymasterTransportConfig {
  /** Node RPC for the paymaster, token and EntryPoint reads. */
  node: JsonRpcTransport;
  chainId: bigint;
  /** The smart account (UserOperation sender) that pays. */
  account: string;
  /** Defaults to CIRCLE_TOKEN_PAYMASTER_V07.testnetAddress. */
  paymaster?: string;
  /** The token the paymaster accepts (checked against token() on-chain). */
  token: string;
  entryPoint?: string;
  /**
   * 'permit': sign an exact EIP-2612 permit per operation (needs signPermit);
   * 'allowance': rely on an existing approve (see circlePaymasterApproveCall).
   */
  mode: 'permit' | 'allowance';
  /**
   * Signs the permit digest AS THE ACCOUNT, e.g. a Kernel spec's
   * signErc1271(owner, digest, { chainId, account }). Required in permit mode.
   */
  signPermit?: (digest: Uint8Array, permit: PermitRequest) => Uint8Array | Promise<Uint8Array>;
  /**
   * Gas assumed for verification + call + preVerification when the STUB
   * permit is sized (the stub is used only for the bundler's estimation, but
   * its permit is a real signature the bundler sees). Default 1,500,000.
   */
  estimationGasCeiling?: bigint;
  /** Defaults to CIRCLE_TOKEN_PAYMASTER_V07.defaultVerificationGasLimit. */
  verificationGasLimit?: bigint;
  /** Defaults to max(documented 35,000, the on-chain additionalGasCharge). */
  postOpGasLimit?: bigint;
  /**
   * Refuse the final data when the worst-case token charge exceeds this
   * (the amount the user saw on the confirm screen). Optional.
   */
  maxTokenCharge?: bigint;
  /** Called with every quote the transport computes (stub and final). */
  onQuote?: (quote: CircleTokenQuote & { phase: 'stub' | 'final'; permitAmount: bigint | null }) => void;
}

interface RpcOpGasFields {
  sender?: string;
  callGasLimit?: string;
  verificationGasLimit?: string;
  preVerificationGas?: string;
  maxFeePerGas?: string;
  paymasterVerificationGasLimit?: string;
}

/**
 * A JsonRpcTransport answering the two ERC-7677 methods
 * (pm_getPaymasterStubData, pm_getPaymasterData) LOCALLY for Circle's
 * on-chain paymaster, so it plugs into SmartAccountClient's existing
 * `paymaster: { transport }` seam with no change to the client. Nothing is
 * sent to any paymaster service; only `node` is contacted.
 *
 * Stub: the documented gas limits and, in permit mode, a real permit sized
 * for `estimationGasCeiling` (the bundler simulates validation, which runs
 * the permit and the transferFrom, so an invalid stub would fail
 * estimation). Final: the operation's estimated limits, the exact worst-case
 * charge, a balance (and in allowance mode, allowance) check, and a permit
 * for exactly that charge. Both permits use the same token nonce, so at most
 * one of them can ever take effect.
 */
export function createCirclePaymasterTransport(config: CirclePaymasterTransportConfig): JsonRpcTransport {
  const paymaster = config.paymaster ?? CIRCLE_TOKEN_PAYMASTER_V07.testnetAddress;
  const entryPoint = config.entryPoint ?? ENTRYPOINT_V07;
  const ceiling = config.estimationGasCeiling ?? 1_500_000n;
  if (config.mode === 'permit' && !config.signPermit) throw new Error('Permit mode needs signPermit');
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  return async (method, params) => {
    if (method !== 'pm_getPaymasterStubData' && method !== 'pm_getPaymasterData') {
      throw new Error(`The local Circle paymaster transport does not serve ${method}`);
    }
    const [rpcOp, ep, chainIdHex] = params as [RpcOpGasFields, string, string];
    if (!same(ep, entryPoint)) throw new Error(`Refusing EntryPoint ${ep}: this paymaster serves ${entryPoint}`);
    if (BigInt(chainIdHex) !== config.chainId) throw new Error(`Refusing chain ${chainIdHex}`);
    if (!rpcOp.sender || !same(rpcOp.sender, config.account)) {
      throw new Error('Refusing an operation from a different sender');
    }
    const state = await readCirclePaymasterState(config.node, paymaster, entryPoint);
    const problems = circlePaymasterProblems(state, { entryPoint, token: config.token });
    if (problems.length > 0) throw new Error(problems.join(' '));

    const postOpGasLimit =
      config.postOpGasLimit ??
      (state.additionalGasCharge > CIRCLE_TOKEN_PAYMASTER_V07.defaultPostOpGasLimit
        ? state.additionalGasCharge
        : CIRCLE_TOKEN_PAYMASTER_V07.defaultPostOpGasLimit);
    if (postOpGasLimit < state.additionalGasCharge) {
      // TokenPaymasterV07 reverts PostOpGasLimitTooLow below this.
      throw new Error(`paymasterPostOpGasLimit must be at least ${state.additionalGasCharge}`);
    }
    const maxFeePerGas = BigInt(rpcOp.maxFeePerGas ?? '0x0');
    const stub = method === 'pm_getPaymasterStubData';
    const verificationGasLimit = stub
      ? (config.verificationGasLimit ?? CIRCLE_TOKEN_PAYMASTER_V07.defaultVerificationGasLimit)
      : rpcOp.paymasterVerificationGasLimit !== undefined
        ? BigInt(rpcOp.paymasterVerificationGasLimit)
        : (config.verificationGasLimit ?? CIRCLE_TOKEN_PAYMASTER_V07.defaultVerificationGasLimit);

    const quote = quoteCircleTokenCharge(
      state,
      stub
        ? {
            verificationGasLimit: ceiling,
            callGasLimit: 0n,
            preVerificationGas: 0n,
            paymasterVerificationGasLimit: verificationGasLimit,
            paymasterPostOpGasLimit: postOpGasLimit,
            maxFeePerGas,
          }
        : {
            verificationGasLimit: BigInt(rpcOp.verificationGasLimit ?? '0x0'),
            callGasLimit: BigInt(rpcOp.callGasLimit ?? '0x0'),
            preVerificationGas: BigInt(rpcOp.preVerificationGas ?? '0x0'),
            paymasterVerificationGasLimit: verificationGasLimit,
            paymasterPostOpGasLimit: postOpGasLimit,
            maxFeePerGas,
          },
    );

    if (!stub) {
      if (config.maxTokenCharge !== undefined && quote.maxTokenCharge > config.maxTokenCharge) {
        throw new TokenGasChargeAboveLimitError(quote.maxTokenCharge, config.maxTokenCharge);
      }
      const { balance, allowance } = await readTokenBalanceAndAllowance(
        config.node,
        config.token,
        config.account,
        paymaster,
      );
      if (balance < quote.maxTokenCharge) throw new TokenGasInsufficientBalanceError(quote.maxTokenCharge, balance);
      if (config.mode === 'allowance' && allowance < quote.maxTokenCharge) {
        throw new TokenGasAllowanceError(quote.maxTokenCharge, allowance);
      }
    }

    let paymasterData: Uint8Array;
    let permitAmount: bigint | null = null;
    if (config.mode === 'allowance') {
      paymasterData = encodeCirclePaymasterData({ mode: 'allowance' });
    } else {
      const info = await readTokenPermitInfo(config.node, config.token, config.account, config.chainId);
      permitAmount = quote.maxTokenCharge;
      const permit = buildTokenPermit({
        token: config.token,
        name: info.name,
        version: info.version,
        chainId: config.chainId,
        owner: config.account,
        spender: paymaster,
        value: permitAmount,
        nonce: info.nonce,
      });
      const permitSignature = await config.signPermit!(permit.digest, permit);
      paymasterData = encodeCirclePaymasterData({
        mode: 'permit',
        token: config.token,
        permitAmount,
        permitSignature,
      });
    }
    config.onQuote?.({ ...quote, phase: stub ? 'stub' : 'final', permitAmount });
    return {
      paymaster,
      paymasterData: toHex(paymasterData),
      paymasterVerificationGasLimit: bigintToHex(verificationGasLimit),
      paymasterPostOpGasLimit: bigintToHex(postOpGasLimit),
      ...(stub ? {} : { isFinal: true }),
    };
  };
}

// ---------------------------------------------------------------------------
// Receipt checks
// ---------------------------------------------------------------------------

export interface CircleSponsoredEvent {
  paymaster: string;
  token: string;
  sender: string;
  userOpHash: string;
  nativeTokenPrice: bigint;
  actualTokenNeeded: bigint;
  feeTokenAmount: bigint;
}

/** Decodes UserOperationSponsored logs (token and sender indexed) from a receipt's logs. */
export function decodeCircleSponsoredEvents(
  logs: { address: string; topics: string[]; data: string }[],
): CircleSponsoredEvent[] {
  const out: CircleSponsoredEvent[] = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== CIRCLE_USER_OPERATION_SPONSORED_TOPIC || log.topics.length !== 3) continue;
    const data = log.data.slice(2);
    if (data.length !== 64 * 4) continue;
    out.push({
      paymaster: toChecksumAddress(toBytes(log.address)),
      token: toChecksumAddress(toBytes('0x' + log.topics[1]!.slice(26))),
      sender: toChecksumAddress(toBytes('0x' + log.topics[2]!.slice(26))),
      userOpHash: '0x' + data.slice(0, 64),
      nativeTokenPrice: BigInt('0x' + data.slice(64, 128)),
      actualTokenNeeded: BigInt('0x' + data.slice(128, 192)),
      feeTokenAmount: BigInt('0x' + data.slice(192, 256)),
    });
  }
  return out;
}

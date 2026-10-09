import { concatBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { encodeFunctionCall } from './abi.js';
import { bigintToHex, keccak, packUint128Pair, toBytes, toHex, toWord } from './encoding.js';
import { encodeErc20Approve } from './erc20.js';
import { gasLimitProblems, ImpossibleGasEstimateError, type JsonRpcTransport } from './rpc.js';
import type { Call } from './smart-account.js';
import { TokenGasChargeAboveLimitError } from './token-paymaster.js';
import { ENTRYPOINT_V07 } from './userop.js';

/**
 * Paying a smart-account operation's network fee in an ERC-20 token through
 * a PERMISSIONED token paymaster reached over ERC-7677 (pm_getPaymasterStubData
 * / pm_getPaymasterData with a `{ token }` context) on the bundler endpoint
 * the user already configured (phase 14 item 3, the second source for Tier 1
 * feature 16, after Circle's on-chain paymaster in ./token-paymaster.ts).
 *
 * The transport below is vendor-neutral in shape: it forwards the two
 * ERC-7677 methods to any endpoint and refuses every answer it cannot bound.
 * What it can bound is decided by the paymaster CONTRACT, so only contracts
 * whose deployed code this project has read are accepted. Today that is one:
 * Pimlico's ERC-20 paymaster for EntryPoint v0.7.
 *
 * SOURCES (all fetched 2026-10-04):
 *  - [P1] docs.pimlico.io/references/paymaster/erc20-paymaster/contract-addresses.md:
 *    "v0.7 | 0x777777777777AeC03fd955926DbF81597e66834C"; "All currently
 *    deployed paymasters have the same contract address on all chains".
 *  - [P2] docs.pimlico.io/references/paymaster/erc20-paymaster/architecture.md:
 *    the paymaster "relies on an offchain API, powered by Pimlico, to supply
 *    the user with an up-to-date token price, alongside a signature from a
 *    valid signer address"; "we can not guarantee that using the paymaster is
 *    risk-free".
 *  - [P3] docs.pimlico.io/references/paymaster/erc20-paymaster/faqs.md:
 *    "Does Pimlico take a fee? Yes, the owner takes a fee that is baked into
 *    the `exchangeRate` returned by the API."
 *  - [P4] docs.pimlico.io/references/paymaster/erc20-paymaster/endpoints/
 *    pm_getPaymasterStubData.md and pm_getPaymasterData.md: the fourth
 *    parameter (context) may be "An object with a `token` field containing
 *    the ERC-20 token address for token payments".
 *  - [Z1] docs.zerodev.app/smart-accounts/pay-gas-with-erc20s.md: "we add a
 *    5% premium to the exchange rate"; "Ensure that enough ERC20 tokens have
 *    been approved for the ERC20 paymaster"; "it's possible to batch the
 *    approval with the UserOp you want to send". The page links Pimlico's
 *    separate erc20-paymaster repository as "audited"; that is a DIFFERENT
 *    contract (ERC20PaymasterV07) from the singleton deployed at [P1], and no
 *    published audit of the singleton was found.
 *  - [S] The deployed contract's verified source: Sourcify exact match
 *    (creation and runtime) of SingletonPaymasterV7 at [P1] on chains 1,
 *    11155111 (verified 2025-04-17), 84532 and 421614; solc 0.8.26, MIT;
 *    files src/SingletonPaymasterV7.sol and src/base/BaseSingletonPaymaster.sol.
 *    Everything below about the data layout and the charge is read from those
 *    files. The contract is NOT a proxy (constructor-initialised, no
 *    upgrade function); its runtime code is 15,118 bytes with keccak256
 *    PIMLICO_ERC20_PAYMASTER_V07.runtimeCodeKeccak, identical on Ethereum
 *    Sepolia, Base Sepolia and Arbitrum Sepolia (eth_getCode, 2026-10-04).
 *
 * HOW IT CHARGES ([S] SingletonPaymasterV7._validateERC20Mode / _postOp,
 * BaseSingletonPaymaster._parseErc20Config / getCostInToken):
 *  1. paymasterData = one byte (mode << 1 | allowAllBundlers; ERC-20 mode
 *     is 1), one flags byte (bit 0 constantFee present, bit 1 recipient
 *     present, bit 2 preFund present), validUntil (6), validAfter (6), token
 *     (20), postOpGas (16), exchangeRate (32), paymasterValidationGasLimit
 *     (16), treasury (20), then the optional preFund (16), constantFee (16)
 *     and recipient (20), then Pimlico's 64- or 65-byte signature over the
 *     operation and every paymaster field except the signature.
 *  2. Validation checks that signature against the contract's signer set.
 *     If preFund is present it pulls preFund tokens from the sender DURING
 *     VALIDATION (before the account's calls run).
 *  3. postOp computes costInToken = ((actualGasCost + penalty +
 *     postOpGas × actualUserOpFeePerGas) × exchangeRate) / 1e18 + constantFee
 *     and moves it from the sender to the treasury with transferFrom
 *     (refunding from the treasury if a preFund exceeded it). If a recipient
 *     is present it ALSO moves (prefund in tokens − cost) from the sender to
 *     that recipient. exchangeRate is "how many tokens one full ETH (1e18 wei)
 *     is worth", in token base units.
 *
 * THE BOUND THIS MODULE ENFORCES. The wallet accepts only paymaster data with
 * no preFund, no recipient (both refused), the expected token and a valid
 * signature length; the constant fee, if any, is included in the bound.
 * EntryPoint v0.7 (account-abstraction v0.7.0 EntryPoint._postExecution)
 * calls postOp with actualGasCost before postOp's own gas and the unused-gas
 * penalty are added, and reverts the whole execution (postOp included) when
 * the final cost exceeds the prefund, so whenever postOp's transfer takes
 * effect, actualGasCost ≤ the required prefund (sum of the five gas limits ×
 * maxFeePerGas). The paymaster's own penalty is at most 10% of
 * (callGasLimit + paymasterPostOpGasLimit) gas, and actualUserOpFeePerGas ≤
 * maxFeePerGas. Hence the most postOp can take is erc7677MaxTokenCharge below,
 * computed from the signed fields, exact bigint, rounding the same way the
 * contract does. Independently of that arithmetic, the account approves the
 * paymaster for EXACTLY the displayed maximum in the same operation, so the
 * token contract itself refuses any transferFrom above it: the approval is the
 * on-chain bound, the arithmetic is the reason the wallet expects to stay
 * below it, and pm_getPaymasterData answers above it are refused before
 * signing.
 *
 * WHAT STAYS APPROVED. postOp runs after the account's calls, so the
 * approval cannot be reset in the same operation: afterwards the paymaster
 * keeps an allowance of (approved − charged). It can be used only inside
 * later operations signed by this account that again name this paymaster
 * (transferFrom is called only from postOp/validation with ctx.sender =
 * userOp.sender, and both functions require msg.sender == EntryPoint); the
 * next operation through this path approves a new exact amount, which
 * replaces it.
 */

/** Pimlico's ERC-20 paymaster for EntryPoint v0.7 [P1, S]. */
export const PIMLICO_ERC20_PAYMASTER_V07 = {
  address: '0x777777777777AeC03fd955926DbF81597e66834C',
  entryPoint: ENTRYPOINT_V07,
  /**
   * keccak256 of the deployed runtime code, read with eth_getCode on
   * Ethereum Sepolia, Base Sepolia and Arbitrum Sepolia on 2026-10-04 (same
   * value on all three; the Sourcify exact match [S] binds it to the source).
   */
  runtimeCodeKeccak: '0x337b6e1b6c2167c0528c5240c028ead407c673595b2820029b69741b76d98fbc',
  /**
   * Tokens this wallet asks the paymaster for, per chain id. 11155111 =
   * Ethereum Sepolia: Circle's test USDC, the token Pimlico's stub answer
   * named when asked through ZeroDev's endpoint with context {token} on
   * 2026-10-04 (paymasterData token field 0x1c7d…7238).
   */
  tokens: {
    '11155111': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  } as Record<string, string>,
} as const;

/** ERC-20 mode in the mode byte [S BaseSingletonPaymaster: ERC20_MODE = 1]. */
export const PIMLICO_ERC20_MODE = 1;
/** Fixed ERC-20 config length without the optional fields and the signature [S: 117]. */
export const PIMLICO_ERC20_CONFIG_LENGTH = 117;
/** [S SingletonPaymasterV7: PENALTY_PERCENT = 10]. */
export const PIMLICO_PENALTY_PERCENT = 10n;

const ONE_ETHER = 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;

/** The decoded paymasterData (the bytes after paymaster + the two gas limits). */
export interface PimlicoErc20PaymasterData {
  mode: number;
  allowAllBundlers: boolean;
  constantFeePresent: boolean;
  recipientPresent: boolean;
  preFundPresent: boolean;
  validUntil: bigint;
  validAfter: bigint;
  token: string;
  postOpGas: bigint;
  /** Token base units per 1e18 wei, signed by Pimlico. */
  exchangeRate: bigint;
  paymasterValidationGasLimit: bigint;
  treasury: string;
  preFundInToken: bigint;
  constantFee: bigint;
  recipient: string | null;
  signature: Uint8Array;
}

function readUint(bytes: Uint8Array, start: number, length: number): bigint {
  if (start + length > bytes.length) throw new Error('Paymaster data is too short');
  let value = 0n;
  for (let i = start; i < start + length; i++) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}

function readAddress(bytes: Uint8Array, start: number): string {
  if (start + 20 > bytes.length) throw new Error('Paymaster data is too short');
  return toChecksumAddress(bytes.slice(start, start + 20));
}

/**
 * Decodes Pimlico's ERC-20-mode paymasterData exactly as
 * BaseSingletonPaymaster._parsePaymasterAndData and _parseErc20Config do
 * [S], and applies the same refusals (short data, zero token, zero rate, a
 * recipient flag with a zero recipient, a signature that is not 64 or 65
 * bytes). Refuses any mode other than ERC-20 (verifying mode is sponsorship,
 * not a token payment).
 */
export function parsePimlicoErc20PaymasterData(paymasterData: Uint8Array): PimlicoErc20PaymasterData {
  if (paymasterData.length < 1) throw new Error('Paymaster data is empty');
  const modeByte = paymasterData[0]!;
  const mode = modeByte >> 1;
  if (mode !== PIMLICO_ERC20_MODE) {
    throw new Error(`Paymaster data is in mode ${mode}, not the ERC-20 mode (${PIMLICO_ERC20_MODE})`);
  }
  const config = paymasterData.slice(1);
  if (config.length < PIMLICO_ERC20_CONFIG_LENGTH) throw new Error('Paymaster data is too short for ERC-20 mode');
  const flags = config[0]!;
  const constantFeePresent = (flags & 0x01) !== 0;
  const recipientPresent = (flags & 0x02) !== 0;
  const preFundPresent = (flags & 0x04) !== 0;
  let p = 1;
  const validUntil = readUint(config, p, 6);
  p += 6;
  const validAfter = readUint(config, p, 6);
  p += 6;
  const token = readAddress(config, p);
  p += 20;
  const postOpGas = readUint(config, p, 16);
  p += 16;
  const exchangeRate = readUint(config, p, 32);
  p += 32;
  const paymasterValidationGasLimit = readUint(config, p, 16);
  p += 16;
  const treasury = readAddress(config, p);
  p += 20;
  let preFundInToken = 0n;
  if (preFundPresent) {
    preFundInToken = readUint(config, p, 16);
    p += 16;
  }
  let constantFee = 0n;
  if (constantFeePresent) {
    constantFee = readUint(config, p, 16);
    p += 16;
  }
  let recipient: string | null = null;
  if (recipientPresent) {
    recipient = readAddress(config, p);
    p += 20;
  }
  const signature = config.slice(p);
  if (/^0x0{40}$/i.test(token)) throw new Error('Paymaster data names the zero token');
  if (exchangeRate === 0n) throw new Error('Paymaster data carries a zero exchange rate');
  if (recipientPresent && recipient !== null && /^0x0{40}$/i.test(recipient)) {
    throw new Error('Paymaster data names the zero recipient');
  }
  if (signature.length !== 64 && signature.length !== 65) {
    throw new Error(`Paymaster signature is ${signature.length} bytes, not 64 or 65`);
  }
  return {
    mode,
    allowAllBundlers: (modeByte & 0x01) !== 0,
    constantFeePresent,
    recipientPresent,
    preFundPresent,
    validUntil,
    validAfter,
    token,
    postOpGas,
    exchangeRate,
    paymasterValidationGasLimit,
    treasury,
    preFundInToken,
    constantFee,
    recipient,
    signature,
  };
}

/** Inverse of parsePimlicoErc20PaymasterData (tests and the dry run). */
export function encodePimlicoErc20PaymasterData(d: Omit<PimlicoErc20PaymasterData, 'mode'>): Uint8Array {
  const fitsBytes = (v: bigint, n: number) => v >= 0n && v < 1n << BigInt(8 * n);
  if (!fitsBytes(d.validUntil, 6) || !fitsBytes(d.validAfter, 6)) throw new Error('validUntil/validAfter must be uint48');
  if (!fitsBytes(d.postOpGas, 16) || !fitsBytes(d.paymasterValidationGasLimit, 16)) throw new Error('Gas fields must be uint128');
  if (d.exchangeRate <= 0n || d.exchangeRate > MAX_UINT256) throw new Error('exchangeRate must be a positive uint256');
  const uintBytes = (v: bigint, n: number) => toBytes('0x' + v.toString(16).padStart(n * 2, '0'));
  const flags = (d.constantFeePresent ? 1 : 0) | (d.recipientPresent ? 2 : 0) | (d.preFundPresent ? 4 : 0);
  return concatBytes(
    new Uint8Array([(PIMLICO_ERC20_MODE << 1) | (d.allowAllBundlers ? 1 : 0), flags]),
    uintBytes(d.validUntil, 6),
    uintBytes(d.validAfter, 6),
    toBytes(d.token),
    uintBytes(d.postOpGas, 16),
    toWord(d.exchangeRate),
    uintBytes(d.paymasterValidationGasLimit, 16),
    toBytes(d.treasury),
    d.preFundPresent ? uintBytes(d.preFundInToken, 16) : new Uint8Array(0),
    d.constantFeePresent ? uintBytes(d.constantFee, 16) : new Uint8Array(0),
    d.recipientPresent ? toBytes(d.recipient ?? '0x') : new Uint8Array(0),
    d.signature,
  );
}

/** The operation fields Pimlico's signer signs over ([S] _getHash). */
export interface PimlicoHashedFields {
  sender: string;
  nonce: bigint;
  factory?: string;
  factoryData?: Uint8Array;
  callData: Uint8Array;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster: string;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  paymasterData: Uint8Array;
}

/**
 * SingletonPaymasterV7.getHash(ERC20_MODE, op) [S]: keccak256(abi.encode(
 * keccak256(abi.encode(sender, nonce, accountGasLimits, preVerificationGas,
 * gasFees, keccak256(initCode), keccak256(callData), keccak256(
 * paymasterAndData[:52 + 1 + 117 + optional fields]))), chainid)). The
 * signer signs its EIP-191 personal-message hash. Used by the dry run (which
 * substitutes a local signer) and by tests; the wallet never signs it.
 */
export function pimlicoErc20PaymasterHash(op: PimlicoHashedFields, chainId: bigint): Uint8Array {
  const parsed = parsePimlicoErc20PaymasterData(op.paymasterData);
  const covered =
    1 +
    PIMLICO_ERC20_CONFIG_LENGTH +
    (parsed.preFundPresent ? 16 : 0) +
    (parsed.constantFeePresent ? 16 : 0) +
    (parsed.recipientPresent ? 20 : 0);
  const paymasterAndDataPrefix = concatBytes(
    toBytes(op.paymaster),
    packUint128Pair(op.paymasterVerificationGasLimit, op.paymasterPostOpGasLimit),
    op.paymasterData.slice(0, covered),
  );
  const inner = keccak(
    concatBytes(
      toWord(toBytes(op.sender)),
      toWord(op.nonce),
      packUint128Pair(op.verificationGasLimit, op.callGasLimit),
      toWord(op.preVerificationGas),
      packUint128Pair(op.maxPriorityFeePerGas, op.maxFeePerGas),
      keccak(op.factory ? concatBytes(toBytes(op.factory), op.factoryData ?? new Uint8Array(0)) : new Uint8Array(0)),
      keccak(op.callData),
      keccak(paymasterAndDataPrefix),
    ),
  );
  return keccak(concatBytes(inner, toWord(chainId)));
}

/** [S] BaseSingletonPaymaster.getCostInToken, exact. */
export function pimlicoCostInToken(
  actualGasCost: bigint,
  postOpGas: bigint,
  actualUserOpFeePerGas: bigint,
  exchangeRate: bigint,
): bigint {
  return ((actualGasCost + postOpGas * actualUserOpFeePerGas) * exchangeRate) / ONE_ETHER;
}

/** The gas fields of a signed operation that decide the worst case. */
export interface Erc7677ChargeGasFields {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  maxFeePerGas: bigint;
}

/**
 * The most the paymaster's postOp can take from the sender for an operation
 * with these gas fields and this (signed) paymaster data, per the reasoning
 * in the file comment: actualGasCost at most the EntryPoint's required
 * prefund, the paymaster's penalty at most 10% of (callGasLimit +
 * paymasterPostOpGasLimit) gas, every fee per gas at most maxFeePerGas, then
 * the contract's own getCostInToken plus the constant fee. Refuses data with
 * a preFund or a recipient (the wallet never accepts them).
 */
export function erc7677MaxTokenCharge(gas: Erc7677ChargeGasFields, data: PimlicoErc20PaymasterData): bigint {
  if (data.preFundPresent) throw new Error('Refusing paymaster data that pulls tokens during validation (preFund)');
  if (data.recipientPresent) throw new Error('Refusing paymaster data that pays part of the fee to a third party (recipient)');
  const requiredPrefund =
    (gas.verificationGasLimit +
      gas.callGasLimit +
      gas.preVerificationGas +
      gas.paymasterVerificationGasLimit +
      gas.paymasterPostOpGasLimit) *
    gas.maxFeePerGas;
  const penaltyGas = ((gas.callGasLimit + gas.paymasterPostOpGasLimit) * PIMLICO_PENALTY_PERCENT) / 100n;
  return (
    pimlicoCostInToken(requiredPrefund + penaltyGas * gas.maxFeePerGas, data.postOpGas, gas.maxFeePerGas, data.exchangeRate) +
    data.constantFee
  );
}

/**
 * Plain-language problems that make an answer unacceptable; empty = usable.
 * `now` (unix seconds) refuses data whose validUntil has passed.
 */
export function erc7677PaymasterDataProblems(
  paymaster: string,
  data: PimlicoErc20PaymasterData,
  expected: { paymaster?: string; token: string; now?: bigint },
): string[] {
  const problems: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const pinned = expected.paymaster ?? PIMLICO_ERC20_PAYMASTER_V07.address;
  if (!same(paymaster, pinned)) problems.push(`The endpoint named paymaster ${paymaster}, not ${pinned}.`);
  if (!same(data.token, expected.token)) problems.push(`The paymaster data charges ${data.token}, not ${expected.token}.`);
  if (data.preFundPresent) problems.push('The paymaster data pulls tokens during validation (preFund), which this wallet does not accept.');
  if (data.recipientPresent) problems.push('The paymaster data pays part of the fee to a third party (recipient), which this wallet does not accept.');
  if (expected.now !== undefined && data.validUntil !== 0n && data.validUntil <= expected.now) {
    problems.push('The paymaster data has already expired.');
  }
  return problems;
}

/**
 * The approve call this path puts FIRST in the operation: approve(paymaster,
 * amount) for EXACTLY the displayed maximum. Refuses 0 and the unlimited
 * value. It must ride in the same operation as the calls it pays for: the
 * paymaster pulls the token in postOp (never in validation, since data with a
 * preFund is refused), after the account's calls have run.
 */
export function erc7677TokenApproveCall(token: string, paymaster: string, amount: bigint): Call {
  if (amount <= 0n) throw new Error('The paymaster approval must be a positive amount');
  if (amount >= MAX_UINT256) throw new Error('Refusing an unlimited paymaster approval');
  return { to: token, value: 0n, data: encodeErc20Approve(paymaster, amount) };
}

// ---------------------------------------------------------------------------
// On-chain checks
// ---------------------------------------------------------------------------

export interface PimlicoPaymasterState {
  paymaster: string;
  runtimeCodeKeccak: string;
  entryPoint: string;
  deposit: bigint;
  staked: boolean;
  stake: bigint;
  unstakeDelaySec: bigint;
}

function wordAt(result: string, index: number): string {
  const hex = result.slice(2);
  return '0x' + hex.slice(index * 64, index * 64 + 64);
}

/** Reads the paymaster's code hash, entryPoint() and EntryPoint getDepositInfo. */
export async function readPimlicoPaymasterState(
  node: JsonRpcTransport,
  paymaster: string = PIMLICO_ERC20_PAYMASTER_V07.address,
  entryPoint: string = ENTRYPOINT_V07,
): Promise<PimlicoPaymasterState> {
  const call = (to: string, data: Uint8Array) => node('eth_call', [{ to, data: toHex(data) }, 'latest']) as Promise<string>;
  const [code, ep, info] = await Promise.all([
    node('eth_getCode', [paymaster, 'latest']) as Promise<string>,
    call(paymaster, encodeFunctionCall('entryPoint()', [])),
    call(entryPoint, encodeFunctionCall('getDepositInfo(address)', [{ kind: 'address', value: paymaster }])),
  ]);
  return {
    paymaster: toChecksumAddress(toBytes(paymaster)),
    runtimeCodeKeccak: toHex(keccak(toBytes(code))),
    entryPoint: toChecksumAddress(toBytes('0x' + wordAt(ep, 0).slice(26))),
    deposit: BigInt(wordAt(info, 0)),
    staked: BigInt(wordAt(info, 1)) !== 0n,
    stake: BigInt(wordAt(info, 2)),
    unstakeDelaySec: BigInt(wordAt(info, 3)),
  };
}

/**
 * Problems with the deployed paymaster; empty = usable. Unlike Circle's
 * check, an unstaked paymaster is NOT refused here: Pimlico's v0.7
 * paymaster is unstaked on Ethereum Sepolia (getDepositInfo, 2026-10-04) and
 * whether a bundler accepts it is that bundler's decision, answered by its
 * estimate; `staked` is reported so the screen can say so.
 */
export function pimlicoPaymasterProblems(
  state: PimlicoPaymasterState,
  expected: { minDeposit?: bigint } = {},
): string[] {
  const problems: string[] = [];
  if (state.runtimeCodeKeccak.toLowerCase() !== PIMLICO_ERC20_PAYMASTER_V07.runtimeCodeKeccak) {
    problems.push('The paymaster’s deployed code is not the version this wallet has checked.');
  }
  if (state.entryPoint.toLowerCase() !== PIMLICO_ERC20_PAYMASTER_V07.entryPoint.toLowerCase()) {
    problems.push(`The paymaster serves EntryPoint ${state.entryPoint}, not ${PIMLICO_ERC20_PAYMASTER_V07.entryPoint}.`);
  }
  if (state.deposit === 0n) problems.push('The paymaster has no EntryPoint deposit.');
  if (expected.minDeposit !== undefined && state.deposit < expected.minDeposit) {
    problems.push('The paymaster deposit is below this operation’s required prefund.');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The ERC-7677 transport
// ---------------------------------------------------------------------------

/** One answer the transport accepted, with the bound it computed. */
export interface Erc7677TokenQuote {
  phase: 'stub' | 'final';
  paymaster: string;
  data: PimlicoErc20PaymasterData;
  paymasterVerificationGasLimit: bigint | null;
  paymasterPostOpGasLimit: bigint;
  /**
   * The bound for the operation's gas fields as sent (stub: the fields the
   * caller had at that moment, often zero gas limits, so only the final
   * bound is meaningful).
   */
  maxTokenCharge: bigint;
}

export interface Erc7677TokenPaymasterConfig {
  /** The ERC-7677 endpoint (the bundler URL the user configured). */
  upstream: JsonRpcTransport;
  chainId: bigint;
  /** The smart account (UserOperation sender) that pays. */
  account: string;
  token: string;
  /** Defaults to PIMLICO_ERC20_PAYMASTER_V07.address. */
  paymaster?: string;
  entryPoint?: string;
  /**
   * The approval the operation carries and the displayed maximum: final data
   * whose bound exceeds it is refused with TokenGasChargeAboveLimitError.
   * Required for pm_getPaymasterData.
   */
  maxTokenCharge?: bigint;
  /** Unix seconds; refuses expired data. Defaults to the system clock. */
  now?: () => bigint;
  onQuote?: (quote: Erc7677TokenQuote) => void;
}

interface RpcOpFields {
  sender?: string;
  callGasLimit?: string;
  verificationGasLimit?: string;
  preVerificationGas?: string;
  maxFeePerGas?: string;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
}

/**
 * A JsonRpcTransport for SmartAccountClient's `paymaster: { transport }`
 * seam. It forwards pm_getPaymasterStubData and pm_getPaymasterData to the
 * configured ERC-7677 endpoint with the context `{ token }` (any context the
 * caller passes is replaced), and checks every answer before the client can
 * use it: the pinned paymaster address, ERC-20 mode, the expected token, no
 * preFund and no recipient, not expired; for the final answer the bound
 * (erc7677MaxTokenCharge) over the operation's signed gas fields must not
 * exceed maxTokenCharge. Nothing is signed here.
 */
export function createErc7677TokenPaymasterTransport(config: Erc7677TokenPaymasterConfig): JsonRpcTransport {
  const paymaster = config.paymaster ?? PIMLICO_ERC20_PAYMASTER_V07.address;
  const entryPoint = config.entryPoint ?? ENTRYPOINT_V07;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const now = config.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  return async (method, params) => {
    if (method !== 'pm_getPaymasterStubData' && method !== 'pm_getPaymasterData') {
      throw new Error(`The token paymaster transport does not serve ${method}`);
    }
    const [rpcOp, ep, chainIdHex] = params as [RpcOpFields, string, string];
    if (!same(ep, entryPoint)) throw new Error(`Refusing EntryPoint ${ep}: this paymaster serves ${entryPoint}`);
    if (BigInt(chainIdHex) !== config.chainId) throw new Error(`Refusing chain ${chainIdHex}`);
    if (!rpcOp.sender || !same(rpcOp.sender, config.account)) {
      throw new Error('Refusing an operation from a different sender');
    }
    const stub = method === 'pm_getPaymasterStubData';
    if (!stub && config.maxTokenCharge === undefined) {
      throw new Error('The final paymaster data needs the displayed maximum (maxTokenCharge)');
    }
    const answer = (await config.upstream(method, [
      rpcOp,
      entryPoint,
      bigintToHex(config.chainId),
      { token: config.token },
    ])) as Record<string, unknown> | null;
    if (!answer || typeof answer.paymaster !== 'string' || typeof answer.paymasterData !== 'string') {
      throw new Error(`${method} returned no paymaster data`);
    }
    const data = parsePimlicoErc20PaymasterData(toBytes(answer.paymasterData));
    const problems = erc7677PaymasterDataProblems(answer.paymaster, data, {
      paymaster,
      token: config.token,
      now: now(),
    });
    if (problems.length > 0) throw new Error(problems.join(' '));
    const hexOrNull = (v: unknown) => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null);
    const pmVerification = hexOrNull(answer.paymasterVerificationGasLimit);
    // ERC-7677 lets pm_getPaymasterData omit the gas limits (ZeroDev's
    // Sepolia endpoint did on 2026-10-04); the operation's own limits, set
    // from the stub or the estimate, then stay and are what gets signed.
    const pmPostOp = hexOrNull(answer.paymasterPostOpGasLimit) ?? hexOrNull(rpcOp.paymasterPostOpGasLimit);
    if (pmPostOp === null) throw new Error(`${method} returned no paymasterPostOpGasLimit and the operation has none`);
    const field = (v: string | undefined) => (v === undefined ? 0n : BigInt(v));
    // The final data must never leave a zero paymasterVerificationGasLimit
    // to be signed (EntryPoint v0.7 runs validatePaymasterUserOp with
    // exactly that much gas; see gasLimitProblems in ./rpc.ts): neither an
    // answer of 0 nor, when the answer omits it, an operation carrying 0
    // (a bundler estimate answered 0x0 in bursts on Arbitrum Sepolia,
    // 2026-10-09). The stub is not checked: its limits are replaced by the
    // bundler's estimate, which the client checks itself.
    if (!stub && (pmVerification ?? field(rpcOp.paymasterVerificationGasLimit)) === 0n) {
      const fields = {
        callGasLimit: field(rpcOp.callGasLimit),
        verificationGasLimit: field(rpcOp.verificationGasLimit),
        preVerificationGas: field(rpcOp.preVerificationGas),
        paymasterVerificationGasLimit: 0n,
        paymasterPostOpGasLimit: pmPostOp,
      };
      throw new ImpossibleGasEstimateError(
        gasLimitProblems(fields, true).filter((p) => p.startsWith('paymasterVerificationGasLimit')),
        fields,
        { source: 'paymaster' },
      );
    }
    const maxTokenCharge = erc7677MaxTokenCharge(
      {
        callGasLimit: field(rpcOp.callGasLimit),
        verificationGasLimit: field(rpcOp.verificationGasLimit),
        preVerificationGas: field(rpcOp.preVerificationGas),
        // The answer's limit wins when given (it is what the client signs);
        // otherwise the operation's own (the estimate's) limit.
        paymasterVerificationGasLimit: pmVerification ?? field(rpcOp.paymasterVerificationGasLimit),
        paymasterPostOpGasLimit: pmPostOp,
        maxFeePerGas: field(rpcOp.maxFeePerGas),
      },
      data,
    );
    if (!stub && maxTokenCharge > config.maxTokenCharge!) {
      throw new TokenGasChargeAboveLimitError(maxTokenCharge, config.maxTokenCharge!);
    }
    config.onQuote?.({
      phase: stub ? 'stub' : 'final',
      paymaster: toChecksumAddress(toBytes(answer.paymaster)),
      data,
      paymasterVerificationGasLimit: pmVerification,
      paymasterPostOpGasLimit: pmPostOp,
      maxTokenCharge,
    });
    return {
      paymaster: answer.paymaster,
      paymasterData: answer.paymasterData,
      ...(pmVerification !== null ? { paymasterVerificationGasLimit: bigintToHex(pmVerification) } : {}),
      ...(hexOrNull(answer.paymasterPostOpGasLimit) !== null ? { paymasterPostOpGasLimit: bigintToHex(pmPostOp) } : {}),
    };
  };
}

// ---------------------------------------------------------------------------
// Receipt checks
// ---------------------------------------------------------------------------

/**
 * keccak256("UserOperationSponsored(bytes32,address,uint8,address,uint256,uint256)"):
 * the event the singleton emits from validation (verifying mode) and postOp
 * (ERC-20 mode) [S BaseSingletonPaymaster]; userOpHash and user are indexed.
 */
export const PIMLICO_USER_OPERATION_SPONSORED_TOPIC = toHex(
  keccak(new TextEncoder().encode('UserOperationSponsored(bytes32,address,uint8,address,uint256,uint256)')),
);

export interface PimlicoSponsoredEvent {
  paymaster: string;
  userOpHash: string;
  sender: string;
  mode: number;
  token: string;
  tokenAmountPaid: bigint;
  exchangeRate: bigint;
}

/** Decodes the singleton's UserOperationSponsored logs. */
export function decodePimlicoSponsoredEvents(
  logs: { address: string; topics: string[]; data: string }[],
): PimlicoSponsoredEvent[] {
  const out: PimlicoSponsoredEvent[] = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== PIMLICO_USER_OPERATION_SPONSORED_TOPIC || log.topics.length !== 3) continue;
    const data = log.data.slice(2);
    if (data.length !== 64 * 4) continue;
    const mode = BigInt('0x' + data.slice(0, 64));
    if (mode > 255n) continue;
    out.push({
      paymaster: toChecksumAddress(toBytes(log.address)),
      userOpHash: log.topics[1]!.toLowerCase(),
      sender: toChecksumAddress(toBytes('0x' + log.topics[2]!.slice(26))),
      mode: Number(mode),
      token: toChecksumAddress(toBytes('0x' + data.slice(64 + 24, 128))),
      tokenAmountPaid: BigInt('0x' + data.slice(128, 192)),
      exchangeRate: BigInt('0x' + data.slice(192, 256)),
    });
  }
  return out;
}

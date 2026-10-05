import { toChecksumAddress } from '@shiba-wallet/core';
import {
  BundlerClient,
  CIRCLE_TOKEN_PAYMASTER_V07,
  ENTRYPOINT_V07,
  NodeClient,
  PIMLICO_ERC20_PAYMASTER_V07,
  TokenGasChargeAboveLimitError,
  TokenGasInsufficientBalanceError,
  circlePaymasterProblems,
  createErc7677TokenPaymasterTransport,
  decodeCircleSponsoredEvents,
  decodePimlicoSponsoredEvents,
  decodeUint256,
  encodeFunctionCall,
  erc7677MaxTokenCharge,
  erc7677TokenApproveCall,
  httpTransport,
  parsePimlicoErc20PaymasterData,
  pimlicoPaymasterProblems,
  readPimlicoPaymasterState,
  readTokenBalanceAndAllowance,
  toHex,
  toRpcUserOperation,
  quoteCircleTokenCharge,
  readCirclePaymasterState,
  readTokenPermitInfo,
  toBytes,
  type Call,
  type CirclePaymasterState,
  type JsonRpcTransport,
  type PimlicoErc20PaymasterData,
  type PimlicoPaymasterState,
  type UserOperation,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by
// scripts/check-token-gas.mjs under Node's type stripping.
import {
  AA_FUNDING_TITLE,
  AaFundingError,
  aaAmountShortfallTitle,
  TOKEN_GAS_ACCOUNT_REFUSAL,
  TOKEN_GAS_ESTIMATION_CEILING,
  aaErc20TransferCalls,
  addressOnlyOwner,
  assertAaTokenChain,
  bundlerFeeFloor,
  effectiveAaAccountType,
  fetchTokenBalanceVia,
  isAaConfigured,
  quoteFeesOverFloor,
  TOKEN_GAS_PADDING_PCT,
  getAaConfig,
  isPrefundError,
  type AaChainConfig,
  type AaClientBundle,
  type AaErc20Target,
  type AaSendQuote,
  type AaTokenGas,
  type TransportFactory,
} from './aa.ts';
import type { KeyValueStore } from './tokens.ts';
import { formatUnits } from './balances.ts';
import { assertFeatureAllowed, eip155Caip2, isFeatureAllowed, readinessRefusal } from '../config/readiness.ts';
import { EVM_PROFILES, evmProfileByCaip2 } from '../config/evm-chain.ts';

/**
 * Paying a smart-account send's network fee in USDC (phase 13 item 2, app
 * half; Tier 1 feature 16), through Circle's permissionless token paymaster
 * for EntryPoint v0.7. The engine does the work
 * (packages/chains-evm/src/token-paymaster.ts): it reads the paymaster's
 * on-chain state and price, computes the exact worst-case token charge,
 * answers the two ERC-7677 methods locally (createCirclePaymasterTransport)
 * and signs an EIP-2612 permit AS THE ACCOUNT. This module decides where the
 * choice is offered, checks the paymaster on-chain before offering it,
 * builds the confirm-screen quote, and words every sentence.
 *
 * WHERE IT IS OFFERED (all must hold):
 *  - The active network has a VERIFIED Circle paymaster: the chains in
 *    CIRCLE_TOKEN_PAYMASTER_V07.tokens (Base Sepolia 84532 and, since phase
 *    14 item 3, Arbitrum Sepolia 421614, each checked on-chain); the engine
 *    notes record that on Ethereum Sepolia the same address's entryPoint()
 *    reverts and its EntryPoint v0.7 deposit is zero, and Circle documents
 *    v0.7 only for Arbitrum and Base. Mainnet addresses were never verified
 *    on-chain. OR (phase 14 item 3) the chain has the ERC-7677 source — see
 *    tokenGasSourceFor: Pimlico's ERC-20 paymaster through the saved bundler
 *    on Ethereum Sepolia, offered only to a confirm screen that renders
 *    tokenGasConfirmLines.
 *  - The readiness switchboard allows 'token-gas' (test networks only).
 *  - The account is a Kernel v3.3 smart account at its own address (factory
 *    deployed or still counterfactual, or a recovered Kernel account): the
 *    paymaster needs a USDC permit signed by the account through ERC-1271,
 *    which Kernel's spec provides (signErc1271) and SimpleAccount v0.7.0
 *    does not (smart-account.ts, the signErc1271 doc comment).
 *  - NOT an EIP-7702-upgraded account: the engine's live proof used a
 *    factory Kernel account and lists "7702 and passkey accounts" as
 *    UNVERIFIED (AGENTS.md phase 13 item 2). A 7702 account's ERC-1271
 *    envelope is different (0x00 prefix, kernel-account.ts
 *    KERNEL_7702_SIGNATURE_PREFIX), and whether USDC's signature check
 *    accepts it for an upgraded EOA has not been run.
 *  - NOT with the passkey signer and never for session keys: session keys
 *    cannot sign ERC-1271 at all (their signer is installed with
 *    SKIP_SIGNATURE, AGENTS.md phase 8 item 2), and the passkey path is
 *    unverified like 7702. Session-key operations go through sessions.ts,
 *    which never builds a token-gas quote.
 *  - NO ERC-7677 sponsorship paymaster is configured for the chain: then the
 *    gas is already free, and the sponsored path stays exactly as it was.
 *
 * WHY THE QUOTE HAS NO BUNDLER ESTIMATE. The paymaster's estimation stub
 * must carry a real permit (the bundler simulates the permit and the
 * transferFrom; token-paymaster.ts lines 688-695), and that permit is an
 * ERC-1271 signature by the owner key, which the app never loads at quote
 * time (aa.ts addressOnlyOwner). So the confirm screen shows the worst case
 * the engine's stub itself uses: verification + call + preVerification gas
 * = TOKEN_GAS_ESTIMATION_CEILING (1,500,000, the engine default), plus the
 * paymaster's own verification (200,000) and postOp limits, at the quote's
 * maxFeePerGas, converted with the paymaster's on-chain price and spread
 * exactly as validation does (quoteCircleTokenCharge). After the biometric
 * gate, sendAa runs estimation and signing with maxTokenCharge = that
 * displayed amount, and refuses to sign any permit above it, so the final
 * charge can never exceed what the user saw. The real operation's limits are
 * far smaller than the ceiling, so the final prefund (and the permit) is
 * normally well below it, and postOp refunds the unused part.
 *
 * SPENDING LIMITS. The USDC fee does NOT count toward any app spending
 * limit. Spending limits count network fees only under countFees, and
 * countFees is allowed only on a limit for the network's own coin
 * (spending-policy.ts validatePolicyList: "Network fees can only be counted
 * in a limit on the network’s own coin."); the fee a quote reports to the
 * limits is its ETH fee, which is 0n here because no ETH pays for gas. The
 * USDC AMOUNT of a USDC send counts as usual (it is in the calls).
 */

/** The fee token's symbol as the screens show it (Circle's USDC). */
export const TOKEN_GAS_SYMBOL = 'USDC';

/** How long a successful (or problem-reporting) paymaster check is reused. */
export const TOKEN_GAS_CHECK_TTL_MS = 60_000;

/** The verified Circle paymaster and its token for a CAIP-2 chain, or null. */
export function tokenGasPaymasterFor(chainCaip2: string): { paymaster: string; token: string } | null {
  const m = /^eip155:(\d+)$/.exec(chainCaip2);
  if (!m) return null;
  const token = CIRCLE_TOKEN_PAYMASTER_V07.tokens[m[1]!];
  if (!token) return null;
  return { paymaster: CIRCLE_TOKEN_PAYMASTER_V07.testnetAddress, token };
}

/**
 * Where a USDC fee can come from on a chain:
 *  - 'circle': Circle's permissionless on-chain paymaster (the chains in
 *    CIRCLE_TOKEN_PAYMASTER_V07.tokens);
 *  - 'erc7677': a permissioned token paymaster reached over ERC-7677 on the
 *    bundler endpoint the user configured, with the paymaster pinned to a
 *    contract whose deployed code this wallet has checked (Pimlico's ERC-20
 *    paymaster; the chains in PIMLICO_ERC20_PAYMASTER_V07.tokens, today only
 *    Ethereum Sepolia). Offered only when the caller says its confirm screen
 *    renders this source's sentences (`acceptsErc7677`), because the older
 *    confirm layout describes Circle's paymaster only.
 * Circle wins where both exist (it needs no service and no key).
 */
export type TokenGasSource =
  | { kind: 'circle'; paymaster: string; token: string }
  | { kind: 'erc7677'; vendor: string; paymaster: string; token: string };

export function tokenGasSourceFor(chainCaip2: string, options: { acceptsErc7677?: boolean } = {}): TokenGasSource | null {
  const circle = tokenGasPaymasterFor(chainCaip2);
  if (circle) return { kind: 'circle', ...circle };
  if (!options.acceptsErc7677) return null;
  const m = /^eip155:(\d+)$/.exec(chainCaip2);
  const token = m ? PIMLICO_ERC20_PAYMASTER_V07.tokens[m[1]!] : undefined;
  if (!token) return null;
  return { kind: 'erc7677', vendor: ERC7677_TOKEN_GAS_VENDOR, paymaster: PIMLICO_ERC20_PAYMASTER_V07.address, token };
}

/** The vendor whose ERC-20 paymaster the ERC-7677 source pins (packages/chains-evm erc7677-token-paymaster.ts). */
export const ERC7677_TOKEN_GAS_VENDOR = 'Pimlico';

/**
 * Headroom (percent) added to the ERC-7677 worst case at quote time. A
 * judgement, not a standard: the rate in the stub answer can move before the
 * final answer (two stubs 20 minutes apart on 2026-10-04 read 2,999.83 and
 * 3,001.84 USDC per ETH, +0.07%), and the bundler re-estimates the gas when
 * the operation is sent. The displayed maximum and the approval include it;
 * a final answer above it is refused before signing.
 */
export const ERC7677_TOKEN_GAS_HEADROOM_PERCENT = 25n;

// ---------------------------------------------------------------------------
// Sentences (pinned by scripts/check-token-gas.mjs)
// ---------------------------------------------------------------------------

/**
 * The networks (by label) where a smart-account send can pay its network fee
 * in USDC: the app profiles with a verified token paymaster.
 */
export function tokenGasNetworkLabels(): string[] {
  return EVM_PROFILES.filter((p) => tokenGasPaymasterFor(p.caip2) !== null).map((p) => p.label);
}

/**
 * Tokens screen: how a token send's network fee is paid on `chainCaip2`.
 * "Normally" because a configured gas sponsor (ERC-7677 paymaster) can pay
 * a smart-account send's fee instead; the USDC sentence appears only where
 * a token paymaster exists, and says the Send screen must offer the choice
 * (it needs a verified Kernel smart account, tokenGasOffer).
 */
export function tokenSendFeeSentence(chainCaip2: string): string {
  const profile = evmProfileByCaip2(chainCaip2);
  const native = profile?.displaySymbol ?? 'ETH';
  const base = `The network fee for a token send is normally paid in ${native}, not in the token.`;
  if (!tokenGasPaymasterFor(chainCaip2)) return base;
  return (
    `${base} On ${profile?.label ?? chainCaip2}, a smart-account send can pay it in ${TOKEN_GAS_SYMBOL} ` +
    'instead when the Send screen offers that choice.'
  );
}

/** Settings → Tokens: the same rule for every network the app knows. */
export function settingsTokensFeeSentence(): string {
  const labels = tokenGasNetworkLabels();
  const base = 'The network fee for a token send is normally paid in ETH (test ETH on test networks), not in the token';
  return labels.length === 0
    ? `${base}.`
    : `${base}; on ${labels.join(' and ')}, a smart-account send can pay it in ${TOKEN_GAS_SYMBOL} instead ` +
        'when the Send screen offers that choice.';
}

/** Where a user looks for the choice on a network without a verified paymaster. */
export function tokenGasNotOnNetworkSentence(chainCaip2: string): string {
  const label = evmProfileByCaip2(chainCaip2)?.label ?? chainCaip2;
  const sepolia =
    chainCaip2 === 'eip155:11155111'
      ? ' On Ethereum Sepolia the same paymaster address does not serve EntryPoint v0.7 (its ' +
        'entryPoint() call reverts and it holds no deposit there).'
      : '';
  // The networks come from the profiles (tokenGasNetworkLabels), never a
  // hard-coded list, so a new profile with a verified paymaster joins it.
  const where = tokenGasNetworkLabels().join(' and ') || 'no network';
  return (
    `Paying the network fee in USDC is offered only on ${where}, where Circle’s token paymaster ` +
    `for EntryPoint v0.7 has been checked on-chain. It is not available on ${label}.${sepolia}`
  );
}

export const TOKEN_GAS_SPONSORED_NOTE =
  'The paymaster saved in Settings already sponsors this smart account’s gas, so there is no network ' +
  'fee to pay in USDC.';

export const TOKEN_GAS_SIMPLE_ACCOUNT_NOTE =
  'SimpleAccount cannot pay the network fee in USDC: Circle’s paymaster needs a USDC permit signed by ' +
  'the account itself (ERC-1271), and SimpleAccount cannot sign one.';

export const TOKEN_GAS_7702_NOTE =
  'Not offered for an account upgraded with EIP-7702: paying the network fee in USDC has only been ' +
  'tested with a Kernel smart account at its own address, and whether USDC accepts a permit signed by ' +
  'an upgraded account has not been verified.';

export const TOKEN_GAS_PASSKEY_NOTE =
  'Not offered while “Sign with passkey” is on: the USDC permit is signed with your account key, and ' +
  'the passkey signer has not been tested with Circle’s paymaster.';

export const TOKEN_GAS_NOT_CONFIGURED_NOTE =
  'Paying the network fee in USDC needs a Kernel v3.3 smart account set up in Settings → Account ' +
  'Abstraction.';

/** The form's one-line explanation under the choice. */
export const TOKEN_GAS_CHOICE_HINT =
  'Circle’s token paymaster pays the gas and takes USDC from your smart account instead. The confirm ' +
  'screen shows the most it can take before you approve; ETH stays the default.';

/** Confirm: the fee line. `max` is the exact worst case already formatted. */
export function tokenGasFeeSentence(max: string, symbol = TOKEN_GAS_SYMBOL): string {
  return (
    `Network fee paid in ${symbol}: up to ${max} ${symbol}; the unused part is refunded in the same ` +
    'transaction; no ETH is needed for the fee.'
  );
}

/**
 * Confirm: what the account grants.
 *
 * The sentence says "normally" on purpose. The estimation permit is sent to
 * the bundler before the final one, and both share one USDC permit nonce. If
 * a third party submitted the estimation permit to USDC first, the final
 * permit would fail and the paymaster would be left with an allowance of up
 * to the displayed amount minus the charge. That allowance is usable only
 * inside operations this account signs, but it would remain until spent or
 * replaced, so the screen must not promise that nothing can ever stay
 * approved.
 */
export function tokenGasGrantSentence(max: string, symbol = TOKEN_GAS_SYMBOL): string {
  return `A one-time permit letting Circle’s paymaster take at most ${max} ${symbol}. The permit is used up by this operation, so normally nothing stays approved.`;
}

/** Confirm: the rate and its source. `price` = base units of the token per 1 ETH (1e18 wei). */
export function tokenGasRateSentence(
  price: bigint,
  decimals: number,
  nativeSymbol: string,
  symbol = TOKEN_GAS_SYMBOL,
): string {
  return `1 ${nativeSymbol} = ${formatUnits(price, decimals, decimals)} ${symbol}, from the paymaster’s on-chain oracle.`;
}

/** Base Sepolia only: the test oracle is a fixed price (token-paymaster.ts lines 73-76). */
export const TOKEN_GAS_FIXED_ORACLE_NOTE =
  'On Base Sepolia the paymaster’s test oracle returns a fixed price; it is not a market rate.';

export function tokenGasOracleNote(chainCaip2: string): string | null {
  if (chainCaip2 === 'eip155:84532') return TOKEN_GAS_FIXED_ORACLE_NOTE;
  // Arbitrum Sepolia's oracle (0x66B5…bf52) is fixed too: latestRoundData()
  // answered 3,000.00000000 with roundId 1 and updatedAt 2 on 2026-10-04.
  if (chainCaip2 === 'eip155:421614') {
    return 'On Arbitrum Sepolia the paymaster’s test oracle returns a fixed price; it is not a market rate.';
  }
  return null;
}

/** Confirm: the fee spread as the paymaster reports it (basis points, exact). */
export function tokenGasSpreadText(bips: bigint): string {
  return `${formatUnits(bips, 2, 2)}% (${bips} basis points), read from the paymaster`;
}

export const TOKEN_GAS_SPREAD_NOTE =
  'Circle’s documentation mentions a 10% surcharge on Arbitrum and Base; this is the figure the ' +
  'paymaster contract itself reports, and it is the one it charges.';

/** Confirm: how the worst case was computed. */
export function tokenGasWorstCaseHint(tokenGas: AaTokenGas, maxFeePerGas: bigint): string {
  const gas = tokenGas.estimationGasCeiling + tokenGas.paymasterVerificationGasLimit + tokenGas.paymasterPostOpGasLimit;
  return (
    `Worst case at ${formatUnits(maxFeePerGas, 9, 9)} gwei max fee for up to ${gas} gas, plus the ` +
    `paymaster’s fixed ${tokenGas.additionalGasCharge} gas, converted at the rate below. The exact gas ` +
    'is estimated after you approve, and the charge can never exceed this amount.'
  );
}

/** Confirm: replaces "Bundler gas estimate passed" on the USDC-fee path. */
export const TOKEN_GAS_ESTIMATE_AFTER_APPROVAL =
  'The bundler’s gas estimate runs after you approve, because Circle’s paymaster needs a permit signed ' +
  'by your smart account first. If the estimate fails, nothing is sent.';

export const TOKEN_GAS_FEE_ROSE_TITLE = 'The network fee changed.';

/** Back to the form after TokenGasChargeAboveLimitError. Amounts are exact base units formatted. */
export function tokenGasAboveLimitSentence(required: string, limit: string, symbol = TOKEN_GAS_SYMBOL): string {
  return (
    `The network fee in ${symbol} would now be up to ${required} ${symbol}, above the ${limit} ${symbol} ` +
    'you approved. Nothing was sent. Review the send again to see the new fee.'
  );
}

export const TOKEN_GAS_UNAVAILABLE_TITLE = 'Circle’s paymaster cannot be used right now.';
export const TOKEN_GAS_REFUSED_TITLE = 'Circle’s paymaster refused the operation.';

/** Success screen. */
export function tokenGasChargedSentence(actual: string, max: string, symbol = TOKEN_GAS_SYMBOL): string {
  return (
    `Network fee charged: ${actual} ${symbol} (up to ${max} ${symbol} was permitted; the rest was ` +
    'refunded in the same transaction).'
  );
}

export const TOKEN_GAS_NO_CHARGE_EVENT =
  'The receipt did not include Circle’s fee event, so the USDC charge could not be read from it.';

// ---------------------------------------------------------------------------
// ERC-7677 source sentences (Pimlico's paymaster; phase 14 item 3)
//
// Every sentence below is about THAT source and was checked against its
// deployed code (packages/chains-evm/src/erc7677-token-paymaster.ts): the
// rate is set and signed by Pimlico's service, not read from an oracle; the
// markup is inside the rate; the service can decline; the account approves
// the paymaster for exactly the displayed maximum in the same operation and
// postOp takes the actual fee after the calls run, so (approval − fee)
// stays approved afterwards; only operations from this account that use
// this paymaster can draw on it, and the next approval replaces it.
// ---------------------------------------------------------------------------

/** The paymaster's name on screen. */
export function erc7677PaymasterName(vendor: string = ERC7677_TOKEN_GAS_VENDOR): string {
  return `${vendor}’s token paymaster`;
}

/** The form's one-line explanation under the choice. */
export function erc7677ChoiceHint(vendor: string = ERC7677_TOKEN_GAS_VENDOR): string {
  return (
    `${erc7677PaymasterName(vendor)} pays the gas and takes USDC from your smart account instead. It is a ` +
    `permissioned service: ${vendor} sets the rate, must sign each operation, and can decline. The confirm ` +
    'screen shows the most it can take before you approve; ETH stays the default.'
  );
}

/** While the on-chain and bundler checks run. */
export function erc7677CheckingSentence(vendor: string = ERC7677_TOKEN_GAS_VENDOR): string {
  return (
    `Checking ${erc7677PaymasterName(vendor)} on-chain and asking the configured bundler for its terms before ` +
    'offering to pay the network fee in USDC…'
  );
}

export function erc7677NeedsBundlerSentence(networkLabel: string, vendor: string = ERC7677_TOKEN_GAS_VENDOR): string {
  return (
    `On ${networkLabel}, paying the network fee in USDC goes through ${erc7677PaymasterName(vendor)}, which is ` +
    'reached through the bundler saved in Settings → Account Abstraction. No bundler is saved for this network.'
  );
}

/** Confirm: the fee line's explanation. `max` is the exact worst case already formatted. */
export function erc7677FeeSentence(max: string, symbol = TOKEN_GAS_SYMBOL, vendor = ERC7677_TOKEN_GAS_VENDOR): string {
  return (
    `Network fee paid in ${symbol}: up to ${max} ${symbol}. This operation first approves ${vendor}’s paymaster ` +
    `for exactly ${max} ${symbol}; after your calls run, it takes the actual fee, which can be less. No ETH is ` +
    'needed for the fee.'
  );
}

/** Confirm: how the worst case was computed. */
export function erc7677WorstCaseHint(tokenGas: AaTokenGas, maxFeePerGas: bigint): string {
  const vendor = tokenGas.erc7677?.vendor ?? ERC7677_TOKEN_GAS_VENDOR;
  const headroom = tokenGas.erc7677?.headroomPercent ?? ERC7677_TOKEN_GAS_HEADROOM_PERCENT;
  const gas = tokenGas.estimationGasCeiling + tokenGas.paymasterVerificationGasLimit + tokenGas.paymasterPostOpGasLimit;
  return (
    `Worst case at ${formatUnits(maxFeePerGas, 9, 9)} gwei max fee for the bundler’s padded gas estimate ` +
    `(${gas} gas), plus the paymaster’s fixed ${tokenGas.additionalGasCharge} gas and the 10% charge on unused ` +
    `execution gas, converted at the rate below, plus ${headroom}% headroom in case ${vendor}’s rate moves ` +
    `before the operation is signed. If ${vendor}’s final terms would cost more than this, nothing is signed.`
  );
}

/** Confirm: the rate and who sets it. `rate` = token base units per 1 ETH (1e18 wei). */
export function erc7677RateSentence(
  rate: bigint,
  decimals: number,
  nativeSymbol: string,
  symbol = TOKEN_GAS_SYMBOL,
  vendor = ERC7677_TOKEN_GAS_VENDOR,
): string {
  return (
    `1 ${nativeSymbol} = ${formatUnits(rate, decimals, decimals)} ${symbol}, set by ${vendor}’s service and ` +
    'signed into the operation; it is not read from an on-chain oracle.'
  );
}

export const ERC7677_MARKUP_LABEL = 'Paymaster markup';
export const ERC7677_MARKUP_VALUE = 'Included in the rate; not shown as a separate figure';
export function erc7677MarkupNote(vendor = ERC7677_TOKEN_GAS_VENDOR): string {
  return (
    `${vendor} says its fee is built into the exchange rate it returns, and services that resell its paymaster ` +
    'may add their own (ZeroDev documents a 5% premium on the rate).'
  );
}

export function erc7677PermissionedNote(vendor = ERC7677_TOKEN_GAS_VENDOR): string {
  return (
    `${vendor}’s paymaster is a permissioned service: its server signs each operation and can decline any of ` +
    'them. If it declines, nothing is sent.'
  );
}

export function erc7677UnstakedNote(networkLabel: string): string {
  return (
    `This paymaster is not staked in the EntryPoint on ${networkLabel}, so some bundlers may refuse operations ` +
    'that use it.'
  );
}

/** Confirm: what the account grants, and what stays approved afterwards. */
export function erc7677GrantSentence(
  max: string,
  symbol = TOKEN_GAS_SYMBOL,
  vendor = ERC7677_TOKEN_GAS_VENDOR,
  replaces: string | null = null,
): string {
  return (
    `This operation approves ${vendor}’s paymaster to take up to ${max} ${symbol} from your smart account` +
    (replaces !== null ? `, replacing an earlier approval of ${replaces} ${symbol}` : '') +
    '. It takes only the actual fee; the rest of the approval (up to ' +
    `${max} ${symbol} minus the fee) stays in place afterwards. Only operations from this smart account that ` +
    'use this paymaster can draw on it, and the next one replaces it with a new exact approval.'
  );
}

export function erc7677EstimatePassedSentence(vendor = ERC7677_TOKEN_GAS_VENDOR): string {
  return `Bundler gas estimate passed with ${vendor}’s paymaster terms.`;
}

/** Success screen. */
export function erc7677ChargedSentence(actual: string, max: string, symbol = TOKEN_GAS_SYMBOL, vendor = ERC7677_TOKEN_GAS_VENDOR): string {
  return (
    `Network fee charged: ${actual} ${symbol}. The approval allowed up to ${max} ${symbol}; what was not ` +
    `charged stays approved for ${vendor}’s paymaster until a later operation through it replaces the approval.`
  );
}

export function erc7677NoChargeEventSentence(vendor = ERC7677_TOKEN_GAS_VENDOR): string {
  return `The receipt did not include ${vendor}’s fee event, so the USDC charge could not be read from it.`;
}

export function tokenGasUnavailableTitle(paymasterName: string): string {
  return `${paymasterName} cannot be used right now.`;
}

export function tokenGasRefusedTitle(paymasterName: string): string {
  return `${paymasterName} refused the operation.`;
}

/**
 * Every confirm-screen line for a USDC-fee quote, for either source, so a
 * screen renders one structure and every sentence matches the source that
 * will actually charge. `chainCaip2` and `nativeSymbol` describe the active
 * profile. For Circle the strings are exactly the existing ones.
 */
export interface TokenGasConfirmLines {
  paymasterName: string;
  feeLabel: string;
  feeValue: string;
  feeSentence: string;
  worstCaseHint: string;
  rateValue: string;
  rateNote: string | null;
  /** Circle: the on-chain spread; ERC-7677: the markup row. */
  spreadLabel: string;
  spreadValue: string;
  spreadNote: string;
  paymasterLabel: string;
  paymasterValue: string;
  balanceLabel: string;
  balanceValue: string;
  grantSentence: string;
  /** Extra notes shown under the grant (ERC-7677: permissioned, unstaked). */
  notes: string[];
  /** Replaces "Bundler gas estimate passed" / TOKEN_GAS_ESTIMATE_AFTER_APPROVAL. */
  estimateSentence: string;
  /** Short phrase for "…paid in USDC through <this>" sentences elsewhere on the confirm. */
  throughPhrase: string;
}

export function tokenGasConfirmLines(
  tokenGas: AaTokenGas,
  ctx: { chainCaip2: string; nativeSymbol: string; maxFeePerGas: bigint },
): TokenGasConfirmLines {
  const d = tokenGas.decimals;
  const sym = tokenGas.symbol;
  const max = exact(tokenGas.maxTokenCharge, d);
  const balanceLabel = `Smart account ${sym} balance`;
  const balanceValue = `${exact(tokenGas.tokenBalance, d)} ${sym}`;
  const feeLabel = `Network fee (paid in ${sym})`;
  const feeValue = `up to ${max} ${sym}`;
  if (tokenGas.source === 'erc7677') {
    const e = tokenGas.erc7677;
    const vendor = e?.vendor ?? ERC7677_TOKEN_GAS_VENDOR;
    const label = evmProfileByCaip2(ctx.chainCaip2)?.label ?? ctx.chainCaip2;
    const notes = [erc7677PermissionedNote(vendor)];
    if (e && !e.staked) notes.push(erc7677UnstakedNote(label));
    return {
      paymasterName: erc7677PaymasterName(vendor),
      feeLabel,
      feeValue,
      feeSentence: erc7677FeeSentence(max, sym, vendor),
      worstCaseHint: erc7677WorstCaseHint(tokenGas, ctx.maxFeePerGas),
      rateValue: erc7677RateSentence(tokenGas.nativeTokenPrice, d, ctx.nativeSymbol, sym, vendor),
      rateNote: null,
      spreadLabel: ERC7677_MARKUP_LABEL,
      spreadValue: ERC7677_MARKUP_VALUE,
      spreadNote: erc7677MarkupNote(vendor),
      paymasterLabel: `Paymaster (${vendor})`,
      paymasterValue: tokenGas.paymaster,
      balanceLabel,
      balanceValue,
      grantSentence: erc7677GrantSentence(
        max,
        sym,
        vendor,
        e && e.allowanceBefore > 0n ? exact(e.allowanceBefore, d) : null,
      ),
      notes,
      estimateSentence: erc7677EstimatePassedSentence(vendor),
      throughPhrase: `${vendor}’s paymaster`,
    };
  }
  return {
    paymasterName: 'Circle’s token paymaster',
    feeLabel,
    feeValue,
    feeSentence: tokenGasFeeSentence(max, sym),
    worstCaseHint: tokenGasWorstCaseHint(tokenGas, ctx.maxFeePerGas),
    rateValue: tokenGasRateSentence(tokenGas.nativeTokenPrice, d, ctx.nativeSymbol, sym),
    rateNote: tokenGasOracleNote(ctx.chainCaip2),
    spreadLabel: 'Paymaster fee spread',
    spreadValue: tokenGasSpreadText(tokenGas.feeSpreadBips),
    spreadNote: TOKEN_GAS_SPREAD_NOTE,
    paymasterLabel: 'Paymaster (Circle)',
    paymasterValue: tokenGas.paymaster,
    balanceLabel,
    balanceValue,
    grantSentence: tokenGasGrantSentence(max, sym),
    notes: [],
    estimateSentence: TOKEN_GAS_ESTIMATE_AFTER_APPROVAL,
    throughPhrase: 'Circle’s paymaster',
  };
}

/** Success line for either source; `actual` null = no fee event found. */
export function tokenGasChargedLine(tokenGas: AaTokenGas, actual: bigint | null): string {
  const vendor = tokenGas.erc7677?.vendor ?? ERC7677_TOKEN_GAS_VENDOR;
  if (actual === null) return tokenGas.source === 'erc7677' ? erc7677NoChargeEventSentence(vendor) : TOKEN_GAS_NO_CHARGE_EVENT;
  const a = exact(actual, tokenGas.decimals);
  const m = exact(tokenGas.maxTokenCharge, tokenGas.decimals);
  return tokenGas.source === 'erc7677'
    ? erc7677ChargedSentence(a, m, tokenGas.symbol, vendor)
    : tokenGasChargedSentence(a, m, tokenGas.symbol);
}

// ---------------------------------------------------------------------------
// Where the choice is offered
// ---------------------------------------------------------------------------

export type TokenGasOffer =
  | { kind: 'available'; paymaster: string; token: string; source: TokenGasSource }
  | { kind: 'unavailable'; reason: string };

/**
 * Whether the USDC fee may be offered for this account on this network, from
 * configuration alone (no request). The on-chain paymaster check
 * (checkTokenGasPaymaster) still has to pass before the choice is shown.
 */
export function tokenGasOffer(p: {
  chainCaip2: string;
  config: AaChainConfig | null;
  owner: string | null;
  passkeySigner: boolean;
  /** The caller's confirm screen renders tokenGasConfirmLines (both sources). */
  acceptsErc7677?: boolean;
}): TokenGasOffer {
  if (!p.config || !p.owner || !isAaConfigured(p.config, p.owner)) {
    return { kind: 'unavailable', reason: TOKEN_GAS_NOT_CONFIGURED_NOTE };
  }
  if (!isFeatureAllowed('token-gas', p.chainCaip2)) {
    return { kind: 'unavailable', reason: readinessRefusal('token-gas') };
  }
  const source = tokenGasSourceFor(p.chainCaip2, { acceptsErc7677: p.acceptsErc7677 === true });
  if (!source) return { kind: 'unavailable', reason: tokenGasNotOnNetworkSentence(p.chainCaip2) };
  if (p.config.paymasterUrl) return { kind: 'unavailable', reason: TOKEN_GAS_SPONSORED_NOTE };
  const type = effectiveAaAccountType(p.config, p.owner);
  // The account-type refusals name the source that would have been used.
  if (source.kind === 'erc7677') {
    // No ERC-1271 permit on this path, but only Kernel v3.3 at its own
    // address has been run live with it (2026-10-04, dev index-2 account).
    if (type === 'simple') return { kind: 'unavailable', reason: ERC7677_SIMPLE_ACCOUNT_NOTE };
    if (type === 'kernel-7702') return { kind: 'unavailable', reason: ERC7677_7702_NOTE };
    if (p.passkeySigner) return { kind: 'unavailable', reason: ERC7677_PASSKEY_NOTE };
  } else {
    if (type === 'simple') return { kind: 'unavailable', reason: TOKEN_GAS_SIMPLE_ACCOUNT_NOTE };
    if (type === 'kernel-7702') return { kind: 'unavailable', reason: TOKEN_GAS_7702_NOTE };
    if (p.passkeySigner) return { kind: 'unavailable', reason: TOKEN_GAS_PASSKEY_NOTE };
  }
  return { kind: 'available', paymaster: source.paymaster, token: source.token, source };
}

export const ERC7677_SIMPLE_ACCOUNT_NOTE =
  'Paying the network fee in USDC through Pimlico’s paymaster has only been tested with a Kernel v3.3 smart ' +
  'account, so it is not offered for SimpleAccount.';

export const ERC7677_7702_NOTE =
  'Not offered for an account upgraded with EIP-7702: paying the network fee in USDC through Pimlico’s ' +
  'paymaster has only been tested with a Kernel smart account at its own address.';

export const ERC7677_PASSKEY_NOTE =
  'Not offered while “Sign with passkey” is on: paying the network fee in USDC through Pimlico’s paymaster has ' +
  'not been tested with the passkey signer.';

/** Thrown when the paymaster fails its on-chain checks (the reason is plain text). */
export class TokenGasUnavailableError extends Error {
  /** The paymaster the message is about (titles name it); Circle's when absent. */
  paymasterName: string | undefined;
  // No TS parameter properties: Node's strip-only type stripping rejects them.
  constructor(message: string, paymasterName?: string) {
    super(message);
    this.name = 'TokenGasUnavailableError';
    this.paymasterName = paymasterName;
  }
}

/**
 * The ERC-7677 paymaster (or the bundler simulating it) refused the
 * operation while it was being quoted; the message is the endpoint's own.
 */
export class TokenGasPaymasterRefusalError extends Error {
  paymasterName: string;
  constructor(message: string, paymasterName: string) {
    super(message);
    this.name = 'TokenGasPaymasterRefusalError';
    this.paymasterName = paymasterName;
  }
}

export type TokenGasCheck =
  | { ok: true; state: CirclePaymasterState }
  | {
      ok: true;
      source: 'erc7677';
      paymaster: PimlicoPaymasterState;
      /** The terms the bundler's stub answer offered (rate, postOpGas, …). */
      stub: PimlicoErc20PaymasterData;
    }
  | { ok: false; reason: string };

const checkCache = new Map<string, { at: number; result: TokenGasCheck }>();

/** Drops cached paymaster checks (tests, or after a refusal at send time). */
export function forgetTokenGasChecks(): void {
  checkCache.clear();
}

/**
 * Reads Circle's paymaster on the ACTIVE endpoint and applies the engine's
 * circlePaymasterProblems (wrong EntryPoint, another token, paused, no
 * stake, no deposit). Read-only and node-only; the endpoint must report the
 * expected chain id. A result (usable, or with problems) is reused for
 * TOKEN_GAS_CHECK_TTL_MS per chain + endpoint; a failed read is not cached,
 * so the next render retries.
 */
export async function checkTokenGasPaymaster(
  nodeUrl: string,
  chainCaip2: string,
  options: {
    transportFor?: TransportFactory;
    now?: () => number;
    force?: boolean;
    /** Check the ERC-7677 source where it is the chain's source (see tokenGasSourceFor). */
    acceptsErc7677?: boolean;
    /** The bundler to ask (ERC-7677 source); default: the one saved for the chain. */
    bundlerUrl?: string | null;
    /** Store for reading the saved bundler (tests). */
    store?: KeyValueStore;
  } = {},
): Promise<TokenGasCheck> {
  const source = tokenGasSourceFor(chainCaip2, { acceptsErc7677: options.acceptsErc7677 === true });
  if (source?.kind === 'erc7677') return checkErc7677TokenGas(nodeUrl, chainCaip2, source, options);
  const pm = tokenGasPaymasterFor(chainCaip2);
  if (!pm) return { ok: false, reason: tokenGasNotOnNetworkSentence(chainCaip2) };
  const now = options.now ?? Date.now;
  const key = `${chainCaip2}|${nodeUrl}`;
  const cached = checkCache.get(key);
  if (!options.force && cached && now() - cached.at < TOKEN_GAS_CHECK_TTL_MS) return cached.result;
  const node = (options.transportFor ?? httpTransport)(nodeUrl);
  let result: TokenGasCheck;
  try {
    const chainId = await new NodeClient(node).chainId();
    if (eip155Caip2(chainId) !== chainCaip2) {
      return {
        ok: false,
        reason: `The endpoint serves chain id ${chainId}, not ${chainCaip2}, so Circle’s paymaster was not checked.`,
      };
    }
    const state = await readCirclePaymasterState(node, pm.paymaster);
    const problems = circlePaymasterProblems(state, { token: pm.token });
    result = problems.length === 0 ? { ok: true, state } : { ok: false, reason: `${TOKEN_GAS_UNAVAILABLE_TITLE} ${problems.join(' ')}` };
  } catch (e) {
    return {
      ok: false,
      reason: `Circle’s paymaster could not be checked on this endpoint: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  checkCache.set(key, { at: now(), result });
  return result;
}

/** A placeholder sender for the bundler probe (the stub answer does not depend on it). */
const PROBE_SENDER = '0x0000000000000000000000000000000000000001';

/**
 * The ERC-7677 source's check: the node serves the chain; the pinned
 * paymaster's deployed code, EntryPoint and deposit pass
 * pimlicoPaymasterProblems; a bundler is saved (or given), serves the same
 * chain (eth_chainId), and answers pm_getPaymasterStubData with the context
 * { token } with data the engine accepts (the pinned paymaster, ERC-20 mode,
 * the expected token, no preFund, no recipient). Read-only; nothing is
 * signed. Cached like the Circle check.
 */
async function checkErc7677TokenGas(
  nodeUrl: string,
  chainCaip2: string,
  source: Extract<TokenGasSource, { kind: 'erc7677' }>,
  options: { transportFor?: TransportFactory; now?: () => number; force?: boolean; bundlerUrl?: string | null; store?: KeyValueStore },
): Promise<TokenGasCheck> {
  const label = evmProfileByCaip2(chainCaip2)?.label ?? chainCaip2;
  const name = erc7677PaymasterName(source.vendor);
  let bundlerUrl = options.bundlerUrl;
  if (bundlerUrl === undefined) {
    try {
      bundlerUrl = (await getAaConfig(chainCaip2, options.store)).bundlerUrl;
    } catch {
      bundlerUrl = null;
    }
  }
  if (!bundlerUrl) return { ok: false, reason: erc7677NeedsBundlerSentence(label, source.vendor) };
  const now = options.now ?? Date.now;
  const key = `${chainCaip2}|${nodeUrl}|${bundlerUrl}`;
  const cached = checkCache.get(key);
  if (!options.force && cached && now() - cached.at < TOKEN_GAS_CHECK_TTL_MS) return cached.result;
  const transportFor = options.transportFor ?? httpTransport;
  const node = transportFor(nodeUrl);
  const bundler = transportFor(bundlerUrl);
  let result: TokenGasCheck;
  try {
    const chainId = await new NodeClient(node).chainId();
    if (eip155Caip2(chainId) !== chainCaip2) {
      return { ok: false, reason: `The endpoint serves chain id ${chainId}, not ${chainCaip2}, so ${name} was not checked.` };
    }
    const bundlerChain = BigInt((await bundler('eth_chainId', [])) as string);
    if (bundlerChain !== chainId) {
      return { ok: false, reason: `The saved bundler serves chain id ${bundlerChain}, not ${chainId}, so ${name} was not asked.` };
    }
    const paymaster = await readPimlicoPaymasterState(node, source.paymaster);
    const problems = pimlicoPaymasterProblems(paymaster);
    if (problems.length > 0) {
      result = { ok: false, reason: `${tokenGasUnavailableTitle(name)} ${problems.join(' ')}` };
    } else {
      const transport = createErc7677TokenPaymasterTransport({
        upstream: bundler,
        chainId,
        account: PROBE_SENDER,
        token: source.token,
        paymaster: source.paymaster,
      });
      const probe: UserOperation = {
        sender: PROBE_SENDER,
        nonce: 0n,
        callData: new Uint8Array(0),
        callGasLimit: 0n,
        verificationGasLimit: 0n,
        preVerificationGas: 0n,
        maxFeePerGas: 0n,
        maxPriorityFeePerGas: 0n,
        signature: new Uint8Array(0),
      };
      const answer = (await transport('pm_getPaymasterStubData', [
        toRpcUserOperation(probe),
        ENTRYPOINT_V07,
        '0x' + chainId.toString(16),
        null,
      ])) as { paymasterData: string };
      const stub = parsePimlicoErc20PaymasterData(toBytes(answer.paymasterData));
      result = { ok: true, source: 'erc7677', paymaster, stub };
    }
  } catch (e) {
    return {
      ok: false,
      reason: `The bundler saved for ${label} did not offer ${name} for ${TOKEN_GAS_SYMBOL}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  checkCache.set(key, { at: now(), result });
  return result;
}

// ---------------------------------------------------------------------------
// Quote (no key, no bundler estimate)
// ---------------------------------------------------------------------------

interface TokenGasFacts {
  sender: string;
  deployed: boolean;
  senderBalance: bigint;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  tokenGas: AaTokenGas;
  /** Balance of the token the send spends, when it is not the fee token. */
  spendBalance: bigint | null;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function exact(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals, decimals);
}

/**
 * Everything a USDC-fee quote needs, read from the node (and the bundler's
 * fee floor), with every refusal that can be decided before the gate.
 * Throws before any request when the feature is not allowed on the chain,
 * the chain has no verified paymaster, or the bundle is of a type the choice
 * is not offered for.
 */
async function tokenGasFacts(
  bundle: AaClientBundle,
  ownerAddress: string,
  spendContract: string | null,
): Promise<TokenGasFacts> {
  const chainCaip2 = eip155Caip2(bundle.chainId);
  assertFeatureAllowed('token-gas', chainCaip2);
  const pm = tokenGasPaymasterFor(chainCaip2);
  if (!pm) throw new TokenGasUnavailableError(tokenGasNotOnNetworkSentence(chainCaip2));
  if (bundle.accountType !== 'kernel-v3.3' || bundle.eip7702 || bundle.sponsored || !bundle.spec.signErc1271) {
    throw new Error(TOKEN_GAS_ACCOUNT_REFUSAL);
  }
  const nodeClient = new NodeClient(bundle.node);
  const chainId = await nodeClient.chainId();
  if (chainId !== bundle.chainId) {
    throw new Error(`Endpoint is chain id ${chainId}, expected ${bundle.chainId}. Check the RPC endpoint in Settings.`);
  }
  const owner = addressOnlyOwner(ownerAddress);
  const sender = toChecksumAddress(toBytes((await bundle.client.getAddress(owner)).toLowerCase()));
  const spendsOther = spendContract !== null && !same(spendContract, pm.token);
  const [senderBalance, deployed, suggestedFees, state, feeTokenBalance, spendBalance] = await Promise.all([
    nodeClient.getBalance(sender),
    bundle.client.isDeployed(owner),
    nodeClient.suggestFees(),
    readCirclePaymasterState(bundle.node, pm.paymaster),
    fetchTokenBalanceVia(bundle.node, pm.token, sender),
    spendsOther && spendContract ? fetchTokenBalanceVia(bundle.node, spendContract, sender) : Promise.resolve(null),
    // The permit's EIP-712 domain: the engine refuses a token whose reported
    // DOMAIN_SEPARATOR differs from the computed one (a permit under a wrong
    // domain would silently fail inside the paymaster's try/catch). Checked
    // now so the refusal comes before the gate, not after it.
    readTokenPermitInfo(bundle.node, pm.token, sender, bundle.chainId),
  ]);
  // The same quote fees as every smart-account quote (aa.ts
  // quoteFeesOverFloor: the bundler's floor plus the stated headroom). The
  // worst case below is priced at them, sendAa signs exactly them, and the
  // engine's permit cap (maxTokenCharge) holds because the fees are never
  // raised after the review.
  const fees = quoteFeesOverFloor(suggestedFees, await bundlerFeeFloor(bundle.bundler));
  const paymasterVerificationGasLimit = CIRCLE_TOKEN_PAYMASTER_V07.defaultVerificationGasLimit;
  // The same rule as the engine's transport (token-paymaster.ts lines
  // 717-721): the documented 35,000, or the on-chain additionalGasCharge
  // when it is larger (TokenPaymasterV07 reverts below it).
  const paymasterPostOpGasLimit =
    state.additionalGasCharge > CIRCLE_TOKEN_PAYMASTER_V07.defaultPostOpGasLimit
      ? state.additionalGasCharge
      : CIRCLE_TOKEN_PAYMASTER_V07.defaultPostOpGasLimit;
  // Exactly the engine stub's figure (token-paymaster.ts lines 734-744).
  const worst = quoteCircleTokenCharge(state, {
    verificationGasLimit: TOKEN_GAS_ESTIMATION_CEILING,
    callGasLimit: 0n,
    preVerificationGas: 0n,
    paymasterVerificationGasLimit,
    paymasterPostOpGasLimit,
    maxFeePerGas: fees.maxFeePerGas,
  });
  const problems = circlePaymasterProblems(state, { token: pm.token, minDeposit: worst.requiredPrefundWei });
  if (problems.length > 0) throw new TokenGasUnavailableError(problems.join(' '));
  return {
    sender,
    deployed,
    senderBalance,
    fees,
    spendBalance,
    tokenGas: {
      paymaster: state.paymaster,
      token: toChecksumAddress(toBytes(pm.token.toLowerCase())),
      symbol: TOKEN_GAS_SYMBOL,
      decimals: state.tokenDecimals,
      maxTokenCharge: worst.maxTokenCharge,
      requiredPrefundWei: worst.requiredPrefundWei,
      worstCaseWei: worst.worstCaseWei,
      nativeTokenPrice: state.nativeTokenPrice,
      feeSpreadBips: state.feeSpreadBips,
      additionalGasCharge: state.additionalGasCharge,
      oracle: state.oracle,
      tokenBalance: feeTokenBalance,
      estimationGasCeiling: TOKEN_GAS_ESTIMATION_CEILING,
      paymasterVerificationGasLimit,
      paymasterPostOpGasLimit,
    },
  };
}

/** The funding refusal for the USDC fee (title AA_FUNDING_TITLE via AaFundingError). */
export function tokenGasFundingMessage(p: {
  sender: string;
  tokenGas: AaTokenGas;
  /** The USDC the send itself moves (0n unless the send is USDC). */
  amount: bigint;
}): string {
  const s = p.tokenGas.symbol;
  const d = p.tokenGas.decimals;
  const needs =
    p.amount > 0n
      ? `${exact(p.amount, d)} ${s} plus a network fee of up to ${exact(p.tokenGas.maxTokenCharge, d)} ${s}`
      : `a network fee of up to ${exact(p.tokenGas.maxTokenCharge, d)} ${s}`;
  return (
    `The smart account ${p.sender} holds ${exact(p.tokenGas.tokenBalance, d)} ${s}, but this send needs ` +
    `${needs}. Fund the smart account address ${p.sender} with ${s} (not the owner address), or pay the ` +
    'fee in ETH.'
  );
}

function assembleQuote(
  bundle: AaClientBundle,
  facts: Pick<TokenGasFacts, 'sender' | 'senderBalance' | 'deployed' | 'fees' | 'tokenGas'>,
  calls: Call[],
  extra: Pick<AaSendQuote, 'to' | 'tokenSpend' | 'token' | 'maxAdjustment'>,
  gas: { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint } = {
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
  },
): AaSendQuote {
  const amount = calls.reduce((sum, c) => sum + c.value, 0n);
  return {
    kind: 'aa',
    calls,
    to: extra.to,
    amount,
    sender: facts.sender,
    senderBalance: facts.senderBalance,
    deployed: facts.deployed,
    // Circle: not estimated before the gate (see the file comment), so 0n;
    // ERC-7677: the bundler's padded estimate. The worst case is
    // tokenGas.maxTokenCharge either way.
    callGasLimit: gas.callGasLimit,
    verificationGasLimit: gas.verificationGasLimit,
    preVerificationGas: gas.preVerificationGas,
    maxFeePerGas: facts.fees.maxFeePerGas,
    maxPriorityFeePerGas: facts.fees.maxPriorityFeePerGas,
    // No ETH pays for gas on this path.
    fee: 0n,
    total: amount,
    sponsored: false,
    accountType: bundle.accountType,
    ...(extra.tokenSpend ? { tokenSpend: extra.tokenSpend } : {}),
    ...(extra.token ? { token: extra.token } : {}),
    ...(bundle.recovered ? { recovered: true } : {}),
    ...(extra.maxAdjustment ? { maxAdjustment: extra.maxAdjustment } : {}),
    tokenGas: facts.tokenGas,
  };
}

// ---------------------------------------------------------------------------
// ERC-7677 source: quote (no key; the bundler estimate runs before the gate)
// ---------------------------------------------------------------------------

/**
 * What an ERC-7677 USDC-fee quote reads before pricing. Unlike Circle's
 * path, this one CAN be estimated before the biometric gate: the stub answer
 * needs no signature from the account (the paymaster pulls the token with an
 * ordinary approval that rides in the operation), so the confirm screen shows
 * a figure derived from the bundler's own estimate.
 */
interface Erc7677Facts {
  source: Extract<TokenGasSource, { kind: 'erc7677' }>;
  sender: string;
  deployed: boolean;
  senderBalance: bigint;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  feeTokenBalance: bigint;
  allowanceBefore: bigint;
  spendBalance: bigint | null;
  decimals: number;
  paymaster: PimlicoPaymasterState;
}

async function erc7677Facts(
  bundle: AaClientBundle,
  ownerAddress: string,
  spendContract: string | null,
): Promise<Erc7677Facts> {
  const chainCaip2 = eip155Caip2(bundle.chainId);
  assertFeatureAllowed('token-gas', chainCaip2);
  const source = tokenGasSourceFor(chainCaip2, { acceptsErc7677: true });
  if (!source || source.kind !== 'erc7677') throw new TokenGasUnavailableError(tokenGasNotOnNetworkSentence(chainCaip2));
  const name = erc7677PaymasterName(source.vendor);
  if (bundle.accountType !== 'kernel-v3.3' || bundle.eip7702 || bundle.sponsored || !bundle.spec.signErc1271) {
    throw new Error(TOKEN_GAS_ACCOUNT_REFUSAL);
  }
  const nodeClient = new NodeClient(bundle.node);
  const chainId = await nodeClient.chainId();
  if (chainId !== bundle.chainId) {
    throw new Error(`Endpoint is chain id ${chainId}, expected ${bundle.chainId}. Check the RPC endpoint in Settings.`);
  }
  const owner = addressOnlyOwner(ownerAddress);
  const sender = toChecksumAddress(toBytes((await bundle.client.getAddress(owner)).toLowerCase()));
  const spendsOther = spendContract !== null && !same(spendContract, source.token);
  const [senderBalance, deployed, suggestedFees, paymaster, feeToken, spendBalance, decimals] = await Promise.all([
    nodeClient.getBalance(sender),
    bundle.client.isDeployed(owner),
    nodeClient.suggestFees(),
    readPimlicoPaymasterState(bundle.node, source.paymaster),
    readTokenBalanceAndAllowance(bundle.node, source.token, sender, source.paymaster),
    spendsOther && spendContract ? fetchTokenBalanceVia(bundle.node, spendContract, sender) : Promise.resolve(null),
    readTokenDecimals(bundle.node, source.token),
  ]);
  const problems = pimlicoPaymasterProblems(paymaster);
  if (problems.length > 0) throw new TokenGasUnavailableError(problems.join(' '), name);
  // The same quote fees as every smart-account quote (aa.ts
  // quoteFeesOverFloor). sendAa signs exactly them, so the bound below is
  // over the fees that will be signed.
  const fees = quoteFeesOverFloor(suggestedFees, await bundlerFeeFloor(bundle.bundler));
  return {
    source,
    sender,
    deployed,
    senderBalance,
    fees,
    feeTokenBalance: feeToken.balance,
    allowanceBefore: feeToken.allowance,
    spendBalance,
    decimals,
    paymaster,
  };
}

/** decimals() of a token, strictly (0–255). */
async function readTokenDecimals(node: JsonRpcTransport, token: string): Promise<number> {
  const result = (await node('eth_call', [{ to: token, data: toHex(encodeFunctionCall('decimals()', [])) }, 'latest'])) as string;
  const value = decodeUint256(result);
  if (value > 255n) throw new Error(`${token} reports ${value} decimals`);
  return Number(value);
}

/**
 * Prices `userCalls` behind an approval: asks the bundler's ERC-7677
 * endpoint for the stub (context { token }), estimates the operation
 * [approve(paymaster, placeholder), ...userCalls] with the bundler, pads the
 * estimate exactly as the send-time client does (TOKEN_GAS_PADDING_PCT; the
 * client keeps the stub's postOp limit and pads the estimate's paymaster
 * verification limit with the verification percentage), and computes the
 * engine's bound (erc7677MaxTokenCharge) at the quote's fees and the stub's
 * terms, plus ERC7677_TOKEN_GAS_HEADROOM_PERCENT. The placeholder approval
 * (the account's whole fee-token balance) only lets the bundler's
 * simulation run postOp; the real operation approves the result.
 */
async function erc7677Price(
  bundle: AaClientBundle,
  ownerAddress: string,
  facts: Erc7677Facts,
  userCalls: Call[],
): Promise<{ tokenGas: AaTokenGas; gas: { callGasLimit: bigint; verificationGasLimit: bigint; preVerificationGas: bigint } }> {
  const name = erc7677PaymasterName(facts.source.vendor);
  const owner = addressOnlyOwner(ownerAddress);
  const placeholder = facts.feeTokenBalance;
  const [nonce, factoryArgs] = await Promise.all([
    bundle.client.getNonce(owner),
    facts.deployed ? Promise.resolve(undefined) : bundle.spec.getFactoryArgs(owner),
  ]);
  let op: UserOperation = {
    sender: facts.sender,
    nonce,
    ...(factoryArgs ? { factory: factoryArgs.factory, factoryData: factoryArgs.factoryData } : {}),
    callData: bundle.spec.encodeCalls([
      erc7677TokenApproveCall(facts.source.token, facts.source.paymaster, placeholder),
      ...userCalls,
    ]),
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: facts.fees.maxFeePerGas,
    maxPriorityFeePerGas: facts.fees.maxPriorityFeePerGas,
    signature: bundle.spec.stubSignature(),
  };
  const transport = createErc7677TokenPaymasterTransport({
    upstream: bundle.bundler,
    chainId: bundle.chainId,
    account: facts.sender,
    token: facts.source.token,
    paymaster: facts.source.paymaster,
    entryPoint: ENTRYPOINT_V07,
  });
  let estimated: Awaited<ReturnType<BundlerClient['estimateUserOperationGas']>>;
  let stub: PimlicoErc20PaymasterData;
  let postOpLimit: bigint;
  try {
    const answer = (await transport('pm_getPaymasterStubData', [
      toRpcUserOperation(op),
      ENTRYPOINT_V07,
      '0x' + bundle.chainId.toString(16),
      null,
    ])) as { paymaster: string; paymasterData: string; paymasterVerificationGasLimit?: string; paymasterPostOpGasLimit?: string };
    stub = parsePimlicoErc20PaymasterData(toBytes(answer.paymasterData));
    postOpLimit = BigInt(answer.paymasterPostOpGasLimit ?? '0x0');
    op = {
      ...op,
      paymaster: answer.paymaster,
      paymasterData: toBytes(answer.paymasterData),
      paymasterPostOpGasLimit: postOpLimit,
      ...(answer.paymasterVerificationGasLimit !== undefined
        ? { paymasterVerificationGasLimit: BigInt(answer.paymasterVerificationGasLimit) }
        : {}),
    };
    estimated = await new BundlerClient(bundle.bundler, ENTRYPOINT_V07).estimateUserOperationGas(op);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (isPrefundError(raw)) throw e;
    throw new TokenGasPaymasterRefusalError(raw, name);
  }
  const pad = (value: bigint, pct: number) => (value * BigInt(pct)) / 100n;
  const gas = {
    callGasLimit: pad(estimated.callGasLimit, TOKEN_GAS_PADDING_PCT.call),
    verificationGasLimit: pad(estimated.verificationGasLimit, TOKEN_GAS_PADDING_PCT.verification),
    preVerificationGas: pad(estimated.preVerificationGas, TOKEN_GAS_PADDING_PCT.preVerification),
  };
  const paymasterVerificationGasLimit =
    estimated.paymasterVerificationGasLimit !== undefined
      ? pad(estimated.paymasterVerificationGasLimit, TOKEN_GAS_PADDING_PCT.verification)
      : (op.paymasterVerificationGasLimit ?? 0n);
  const bound = erc7677MaxTokenCharge(
    { ...gas, paymasterVerificationGasLimit, paymasterPostOpGasLimit: postOpLimit, maxFeePerGas: facts.fees.maxFeePerGas },
    stub,
  );
  const maxTokenCharge = (bound * (100n + ERC7677_TOKEN_GAS_HEADROOM_PERCENT) + 99n) / 100n;
  const limits = gas.callGasLimit + gas.verificationGasLimit + gas.preVerificationGas;
  const requiredPrefundWei = (limits + paymasterVerificationGasLimit + postOpLimit) * facts.fees.maxFeePerGas;
  const penaltyGas = ((gas.callGasLimit + postOpLimit) * 10n) / 100n;
  return {
    gas,
    tokenGas: {
      paymaster: toChecksumAddress(toBytes(facts.source.paymaster.toLowerCase())),
      token: toChecksumAddress(toBytes(facts.source.token.toLowerCase())),
      symbol: TOKEN_GAS_SYMBOL,
      decimals: facts.decimals,
      maxTokenCharge,
      requiredPrefundWei,
      worstCaseWei: requiredPrefundWei + (penaltyGas + stub.postOpGas) * facts.fees.maxFeePerGas,
      nativeTokenPrice: stub.exchangeRate,
      feeSpreadBips: 0n,
      additionalGasCharge: stub.postOpGas,
      oracle: '',
      tokenBalance: facts.feeTokenBalance,
      estimationGasCeiling: limits,
      paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: postOpLimit,
      source: 'erc7677',
      erc7677: {
        vendor: facts.source.vendor,
        boundAtQuote: bound,
        headroomPercent: ERC7677_TOKEN_GAS_HEADROOM_PERCENT,
        postOpGas: stub.postOpGas,
        constantFee: stub.constantFee,
        treasury: stub.treasury,
        staked: facts.paymaster.staked,
        allowanceBefore: facts.allowanceBefore,
      },
    },
  };
}

/** The calls the ERC-7677 quote carries: the exact approval first. */
function erc7677Calls(tokenGas: AaTokenGas, userCalls: Call[]): Call[] {
  return [erc7677TokenApproveCall(tokenGas.token, tokenGas.paymaster, tokenGas.maxTokenCharge), ...userCalls];
}

function erc7677FundingError(facts: Erc7677Facts, tokenGas: AaTokenGas | null, amount: bigint): AaFundingError {
  const s = TOKEN_GAS_SYMBOL;
  const d = facts.decimals;
  const needs =
    tokenGas === null
      ? amount > 0n
        ? `${exact(amount, d)} ${s} plus a network fee in ${s}`
        : `a network fee in ${s}`
      : amount > 0n
        ? `${exact(amount, d)} ${s} plus a network fee of up to ${exact(tokenGas.maxTokenCharge, d)} ${s}`
        : `a network fee of up to ${exact(tokenGas.maxTokenCharge, d)} ${s}`;
  return new AaFundingError(
    facts.sender,
    `The smart account ${facts.sender} holds ${exact(facts.feeTokenBalance, d)} ${s}, but this send needs ${needs}. ` +
      `Fund the smart account address ${facts.sender} with ${s} (not the owner address), or pay the fee in ETH.`,
    amount > 0n && tokenGas !== null && facts.feeTokenBalance >= tokenGas.maxTokenCharge
      ? aaAmountShortfallTitle(s, true)
      : AA_FUNDING_TITLE,
  );
}

async function prepareErc7677NativeSend(
  bundle: AaClientBundle,
  ownerAddress: string,
  to: string,
  amount: bigint,
  options: { fromMax?: boolean },
): Promise<AaSendQuote> {
  const facts = await erc7677Facts(bundle, ownerAddress, null);
  let value = amount;
  if (options.fromMax === true && value > facts.senderBalance && facts.senderBalance > 0n) value = facts.senderBalance;
  if (value > facts.senderBalance) {
    throw new AaFundingError(
      facts.sender,
      `Insufficient funds: sending ${value} wei exceeds the balance of ${facts.senderBalance} wei held by the ` +
        `smart account ${facts.sender}. The network fee is paid in USDC, so no ETH is needed for it. Fund ` +
        `the smart account address ${facts.sender} (not the owner address), then review again.`,
      aaAmountShortfallTitle(evmProfileByCaip2(eip155Caip2(bundle.chainId))?.displaySymbol ?? 'ETH', false),
    );
  }
  if (facts.feeTokenBalance === 0n) throw erc7677FundingError(facts, null, 0n);
  const userCalls: Call[] = [{ to, value, data: new Uint8Array(0) }];
  const { tokenGas, gas } = await erc7677Price(bundle, ownerAddress, facts, userCalls);
  if (facts.feeTokenBalance < tokenGas.maxTokenCharge) throw erc7677FundingError(facts, tokenGas, 0n);
  return assembleQuote(
    bundle,
    { ...facts, tokenGas },
    erc7677Calls(tokenGas, userCalls),
    { to, ...(value !== amount ? { maxAdjustment: { requested: amount } } : {}) },
    gas,
  );
}

async function prepareErc7677Erc20Send(
  bundle: AaClientBundle,
  ownerAddress: string,
  token: AaErc20Target & { amount: bigint },
  options: { fromMax?: boolean },
): Promise<AaSendQuote> {
  const facts = await erc7677Facts(bundle, ownerAddress, token.contract);
  const isFeeToken = same(token.contract, facts.source.token);
  let amount = token.amount;
  if (isFeeToken) {
    // The bundler's simulation runs postOp, which needs the fee left after
    // the transfer; an amount that takes everything cannot be estimated.
    if (amount >= facts.feeTokenBalance && !(options.fromMax === true && facts.feeTokenBalance > 0n)) {
      throw erc7677FundingError(facts, null, amount);
    }
  } else {
    const held = facts.spendBalance ?? 0n;
    if (amount > held) {
      throw new Error(
        `Sending ${amount} base units of ${token.symbol} exceeds the token balance of ${held} base units held by ` +
          `the smart account ${facts.sender}. Smart-account sends spend the smart account’s tokens, not the ` +
          'owner address’s.',
      );
    }
    if (facts.feeTokenBalance === 0n) throw erc7677FundingError(facts, null, 0n);
  }
  // A Max of the fee token is priced with a 1-unit transfer (the gas does not
  // depend on the amount beyond a few calldata bytes, which the headroom
  // covers), then lowered to balance − worst case and priced again.
  const priceAmount = isFeeToken && amount >= facts.feeTokenBalance ? 1n : amount;
  let priced = await erc7677Price(bundle, ownerAddress, facts, aaErc20TransferCalls(token.contract, token.recipient, priceAmount));
  if (isFeeToken) {
    const room = facts.feeTokenBalance > priced.tokenGas.maxTokenCharge ? facts.feeTokenBalance - priced.tokenGas.maxTokenCharge : 0n;
    if (options.fromMax === true && amount > room && room > 0n) {
      amount = room;
      priced = await erc7677Price(bundle, ownerAddress, facts, aaErc20TransferCalls(token.contract, token.recipient, amount));
    }
    if (amount + priced.tokenGas.maxTokenCharge > facts.feeTokenBalance) throw erc7677FundingError(facts, priced.tokenGas, amount);
  } else if (facts.feeTokenBalance < priced.tokenGas.maxTokenCharge) {
    throw erc7677FundingError(facts, priced.tokenGas, 0n);
  }
  const userCalls = aaErc20TransferCalls(token.contract, token.recipient, amount);
  return assembleQuote(
    bundle,
    { ...facts, tokenGas: priced.tokenGas },
    erc7677Calls(priced.tokenGas, userCalls),
    {
      to: token.recipient,
      tokenSpend: {
        contract: token.contract,
        amount,
        symbol: token.symbol,
        balance: isFeeToken ? facts.feeTokenBalance : (facts.spendBalance ?? 0n),
      },
      token: { contract: token.contract, recipient: token.recipient, amount, symbol: token.symbol, decimals: token.decimals },
      ...(amount !== token.amount ? { maxAdjustment: { requested: token.amount } } : {}),
    },
    priced.gas,
  );
}

/** True when the ERC-7677 source applies to this bundle's chain (and the caller accepts it). */
function usesErc7677(bundle: AaClientBundle, acceptsErc7677: boolean | undefined): boolean {
  return tokenGasSourceFor(eip155Caip2(bundle.chainId), { acceptsErc7677: acceptsErc7677 === true })?.kind === 'erc7677';
}

/**
 * USDC-fee quote for a plain native transfer from the smart account. The
 * ETH balance must cover the amount only; the USDC balance must cover the
 * worst-case fee. `fromMax` (the amount came from the Max button): an amount
 * above the ETH balance is lowered to the balance, never raised.
 */
export async function prepareAaTokenGasSend(
  bundle: AaClientBundle,
  ownerAddress: string,
  to: string,
  amount: bigint,
  options: { fromMax?: boolean; acceptsErc7677?: boolean } = {},
): Promise<AaSendQuote> {
  if (usesErc7677(bundle, options.acceptsErc7677)) return prepareErc7677NativeSend(bundle, ownerAddress, to, amount, options);
  const facts = await tokenGasFacts(bundle, ownerAddress, null);
  let value = amount;
  if (options.fromMax === true && value > facts.senderBalance && facts.senderBalance > 0n) value = facts.senderBalance;
  if (value > facts.senderBalance) {
    // The fee is paid in USDC, so only the amount is short in ETH (title
    // without "plus the network fee"; the USDC fee is checked next).
    throw new AaFundingError(
      facts.sender,
      `Insufficient funds: sending ${value} wei exceeds the balance of ${facts.senderBalance} wei held by the ` +
        `smart account ${facts.sender}. The network fee is paid in USDC, so no ETH is needed for it. Fund ` +
        `the smart account address ${facts.sender} (not the owner address), then review again.`,
      aaAmountShortfallTitle(evmProfileByCaip2(eip155Caip2(bundle.chainId))?.displaySymbol ?? 'ETH', false),
    );
  }
  if (facts.tokenGas.tokenBalance < facts.tokenGas.maxTokenCharge) {
    throw new AaFundingError(facts.sender, tokenGasFundingMessage({ sender: facts.sender, tokenGas: facts.tokenGas, amount: 0n }));
  }
  return assembleQuote(bundle, facts, [{ to, value, data: new Uint8Array(0) }], {
    to,
    ...(value !== amount ? { maxAdjustment: { requested: amount } } : {}),
  });
}

/**
 * USDC-fee quote for an ERC-20 send from the smart account (one transfer
 * call). When the token IS the fee token, its balance must cover the amount
 * plus the worst-case fee; otherwise the token balance covers the amount and
 * the USDC balance the fee. `fromMax` lowers a fee-token amount that no
 * longer fits beside the fee to balance − worst case (the worst case does not
 * depend on the calldata, so one step is exact). A token from another chain
 * (`chainCaip2`) is refused before any request.
 */
export async function prepareAaTokenGasErc20Send(
  bundle: AaClientBundle,
  ownerAddress: string,
  token: AaErc20Target & { amount: bigint },
  options: { fromMax?: boolean; acceptsErc7677?: boolean } = {},
): Promise<AaSendQuote> {
  assertAaTokenChain(bundle, token);
  if (usesErc7677(bundle, options.acceptsErc7677)) return prepareErc7677Erc20Send(bundle, ownerAddress, token, options);
  const facts = await tokenGasFacts(bundle, ownerAddress, token.contract);
  const tg = facts.tokenGas;
  const isFeeToken = same(token.contract, tg.token);
  let amount = token.amount;
  if (isFeeToken) {
    const room = tg.tokenBalance > tg.maxTokenCharge ? tg.tokenBalance - tg.maxTokenCharge : 0n;
    if (options.fromMax === true && amount > room && room > 0n) amount = room;
    if (amount + tg.maxTokenCharge > tg.tokenBalance) {
      // A balance that covers the worst-case fee alone is short only for
      // this amount plus the fee; one that cannot cover even the fee could
      // not pay for any send in USDC and keeps AA_FUNDING_TITLE.
      throw new AaFundingError(
        facts.sender,
        tokenGasFundingMessage({ sender: facts.sender, tokenGas: tg, amount }),
        amount > 0n && tg.tokenBalance >= tg.maxTokenCharge ? aaAmountShortfallTitle(tg.symbol, true) : AA_FUNDING_TITLE,
      );
    }
  } else {
    const held = facts.spendBalance ?? 0n;
    if (amount > held) {
      throw new Error(
        `Sending ${amount} base units of ${token.symbol} exceeds the token balance of ${held} base units held by ` +
          `the smart account ${facts.sender}. Smart-account sends spend the smart account’s tokens, not the ` +
          'owner address’s.',
      );
    }
    if (tg.tokenBalance < tg.maxTokenCharge) {
      throw new AaFundingError(facts.sender, tokenGasFundingMessage({ sender: facts.sender, tokenGas: tg, amount: 0n }));
    }
  }
  const calls = aaErc20TransferCalls(token.contract, token.recipient, amount);
  return assembleQuote(bundle, facts, calls, {
    to: token.recipient,
    tokenSpend: {
      contract: token.contract,
      amount,
      symbol: token.symbol,
      balance: isFeeToken ? tg.tokenBalance : (facts.spendBalance ?? 0n),
    },
    token: {
      contract: token.contract,
      recipient: token.recipient,
      amount,
      symbol: token.symbol,
      decimals: token.decimals,
    },
    ...(amount !== token.amount ? { maxAdjustment: { requested: token.amount } } : {}),
  });
}

/**
 * Native Max with the USDC fee: the smart account's full ETH balance (no ETH
 * pays for gas). Refuses, with the funding message, when the USDC balance
 * cannot cover the worst-case fee. Returns 0n for an empty ETH balance.
 */
export async function maxAaTokenGasSend(
  bundle: AaClientBundle,
  ownerAddress: string,
  options: { acceptsErc7677?: boolean } = {},
): Promise<bigint> {
  if (usesErc7677(bundle, options.acceptsErc7677)) {
    // The full ETH balance (no ETH pays for gas), once the USDC covers the
    // worst case of a zero-value transfer to the owner (a stand-in recipient:
    // the gas of a plain transfer does not depend on it).
    const facts = await erc7677Facts(bundle, ownerAddress, null);
    if (facts.feeTokenBalance === 0n) throw erc7677FundingError(facts, null, 0n);
    const { tokenGas } = await erc7677Price(bundle, ownerAddress, facts, [{ to: ownerAddress, value: 0n, data: new Uint8Array(0) }]);
    if (facts.feeTokenBalance < tokenGas.maxTokenCharge) throw erc7677FundingError(facts, tokenGas, 0n);
    return facts.senderBalance;
  }
  const facts = await tokenGasFacts(bundle, ownerAddress, null);
  if (facts.tokenGas.tokenBalance < facts.tokenGas.maxTokenCharge) {
    throw new AaFundingError(facts.sender, tokenGasFundingMessage({ sender: facts.sender, tokenGas: facts.tokenGas, amount: 0n }));
  }
  return facts.senderBalance;
}

/**
 * Token Max with the USDC fee: for USDC itself, balance − worst-case fee
 * (0n when the fee takes all of it); for another token, its full balance,
 * refused when the USDC cannot cover the fee.
 */
export async function maxAaTokenGasErc20Send(
  bundle: AaClientBundle,
  ownerAddress: string,
  token: AaErc20Target,
  options: { acceptsErc7677?: boolean } = {},
): Promise<bigint> {
  assertAaTokenChain(bundle, token);
  if (usesErc7677(bundle, options.acceptsErc7677)) {
    const facts = await erc7677Facts(bundle, ownerAddress, token.contract);
    if (facts.feeTokenBalance === 0n) throw erc7677FundingError(facts, null, 0n);
    const isFeeToken = same(token.contract, facts.source.token);
    const { tokenGas } = await erc7677Price(
      bundle,
      ownerAddress,
      facts,
      aaErc20TransferCalls(token.contract, ownerAddress, isFeeToken ? 1n : (facts.spendBalance ?? 0n)),
    );
    if (isFeeToken) return facts.feeTokenBalance > tokenGas.maxTokenCharge ? facts.feeTokenBalance - tokenGas.maxTokenCharge : 0n;
    if (facts.feeTokenBalance < tokenGas.maxTokenCharge) throw erc7677FundingError(facts, tokenGas, 0n);
    return facts.spendBalance ?? 0n;
  }
  const facts = await tokenGasFacts(bundle, ownerAddress, token.contract);
  const tg = facts.tokenGas;
  if (same(token.contract, tg.token)) {
    return tg.tokenBalance > tg.maxTokenCharge ? tg.tokenBalance - tg.maxTokenCharge : 0n;
  }
  if (tg.tokenBalance < tg.maxTokenCharge) {
    throw new AaFundingError(facts.sender, tokenGasFundingMessage({ sender: facts.sender, tokenGas: tg, amount: 0n }));
  }
  return facts.spendBalance ?? 0n;
}

/** The confirm sentence for a fee-token Max lowered at quote time. */
export function tokenGasMaxAdjustmentSentence(
  quote: Pick<AaSendQuote, 'amount' | 'maxAdjustment' | 'token'>,
  format: (value: bigint) => string,
): string | null {
  if (!quote.maxAdjustment) return null;
  const now = quote.token ? quote.token.amount : quote.amount;
  return (
    `The amount was lowered from ${format(quote.maxAdjustment.requested)} to ${format(now)} because the ` +
    'balance changed or the worst-case network fee rose after you tapped Max.'
  );
}

// ---------------------------------------------------------------------------
// Errors and receipts
// ---------------------------------------------------------------------------

/**
 * Plain wording for the USDC-fee path's own errors, or null for anything
 * else (the caller then uses describeAaError / describeSendError). Amounts
 * are formatted in the fee token's decimals.
 */
export function describeTokenGasError(
  error: unknown,
  tokenGas: Pick<AaTokenGas, 'decimals' | 'symbol' | 'source' | 'erc7677'> = { decimals: 6, symbol: TOKEN_GAS_SYMBOL },
): { title: string; detail: string } | null {
  const fmt = (v: bigint) => exact(v, tokenGas.decimals);
  // The paymaster the error is about: the error's own name when it carries
  // one, else the quote's source; Circle's when neither says otherwise.
  const quoteName =
    tokenGas.source === 'erc7677' ? erc7677PaymasterName(tokenGas.erc7677?.vendor ?? ERC7677_TOKEN_GAS_VENDOR) : null;
  if (error instanceof TokenGasPaymasterRefusalError) {
    return {
      title: tokenGasRefusedTitle(error.paymasterName),
      detail:
        `${error.message}\n\nThe bundler’s message is shown exactly as returned. Nothing was sent; you can pay the ` +
        'fee in ETH instead.',
    };
  }
  if (error instanceof TokenGasChargeAboveLimitError) {
    return {
      title: TOKEN_GAS_FEE_ROSE_TITLE,
      detail: tokenGasAboveLimitSentence(fmt(error.required), fmt(error.limit), tokenGas.symbol),
    };
  }
  if (error instanceof TokenGasInsufficientBalanceError) {
    return {
      title: AA_FUNDING_TITLE,
      detail:
        `The smart account holds ${fmt(error.balance)} ${tokenGas.symbol}, but the network fee may cost up to ` +
        `${fmt(error.required)} ${tokenGas.symbol}. Nothing was sent. Add ${tokenGas.symbol} to the smart account ` +
        'or pay the fee in ETH.',
    };
  }
  if (error instanceof TokenGasUnavailableError) {
    const name = error.paymasterName ?? quoteName;
    return { title: name ? tokenGasUnavailableTitle(name) : TOKEN_GAS_UNAVAILABLE_TITLE, detail: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  // EntryPoint v0.7 paymaster failure codes (AA30–AA36: account-abstraction
  // v0.7.0 EntryPoint._validatePaymasterPrepayment and its callers). The
  // ERC-7677 source also counts AA50 (postOp reverted: its fee is taken in
  // postOp) and its endpoint's own refusals arrive as TokenGasPaymasterRefusalError.
  if (/\bAA3[0-9]\b/.test(message) || (quoteName !== null && /\bAA5[0-9]\b/.test(message))) {
    return {
      title: quoteName ? tokenGasRefusedTitle(quoteName) : TOKEN_GAS_REFUSED_TITLE,
      detail:
        `${message}\n\nThe bundler’s message is shown exactly as returned. Nothing was sent; you can pay the ` +
        'fee in ETH instead.',
    };
  }
  return null;
}

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
}

function asLogs(value: unknown): RpcLog[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (l): l is RpcLog =>
      typeof l === 'object' &&
      l !== null &&
      typeof (l as RpcLog).address === 'string' &&
      Array.isArray((l as RpcLog).topics) &&
      (l as RpcLog).topics.every((t) => typeof t === 'string') &&
      typeof (l as RpcLog).data === 'string',
  );
}

/**
 * The USDC actually charged, from a bundler's eth_getUserOperationReceipt
 * answer: Circle's UserOperationSponsored event (engine
 * decodeCircleSponsoredEvents) for exactly this userOpHash, paymaster, token
 * and sender, searched in the operation's own logs and the transaction
 * receipt's logs (bundlers differ in which they fill). Null when no such
 * event is found; never a guessed value.
 */
export function tokenGasChargeFromReceipt(
  raw: unknown,
  expected: { userOpHash: string; paymaster: string; token: string; sender: string },
): { actualTokenNeeded: bigint; feeTokenAmount: bigint; nativeTokenPrice: bigint } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const inner = typeof r.receipt === 'object' && r.receipt !== null ? (r.receipt as Record<string, unknown>).logs : undefined;
  const logs = [...asLogs(r.logs), ...asLogs(inner)];
  // Pimlico's paymaster (the ERC-7677 source) emits its own
  // UserOperationSponsored (engine decodePimlicoSponsoredEvents): the
  // ERC-20-mode event for exactly this operation, sender and token, from the
  // pinned paymaster address. Its tokenAmountPaid is the charge; there is no
  // prefund or refund on this path, so both amounts are that figure.
  if (same(expected.paymaster, PIMLICO_ERC20_PAYMASTER_V07.address)) {
    let pimlico;
    try {
      pimlico = decodePimlicoSponsoredEvents(logs);
    } catch {
      return null;
    }
    const hit = pimlico.find(
      (e) =>
        e.mode === 1 &&
        same(e.userOpHash, expected.userOpHash) &&
        same(e.paymaster, expected.paymaster) &&
        same(e.token, expected.token) &&
        same(e.sender, expected.sender),
    );
    return hit ? { actualTokenNeeded: hit.tokenAmountPaid, feeTokenAmount: hit.tokenAmountPaid, nativeTokenPrice: hit.exchangeRate } : null;
  }
  let events;
  try {
    events = decodeCircleSponsoredEvents(logs);
  } catch {
    return null;
  }
  const hit = events.find(
    (e) =>
      same(e.userOpHash, expected.userOpHash) &&
      same(e.paymaster, expected.paymaster) &&
      same(e.token, expected.token) &&
      same(e.sender, expected.sender),
  );
  return hit
    ? { actualTokenNeeded: hit.actualTokenNeeded, feeTokenAmount: hit.feeTokenAmount, nativeTokenPrice: hit.nativeTokenPrice }
    : null;
}

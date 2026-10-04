import { toChecksumAddress } from '@shiba-wallet/core';
import {
  CIRCLE_TOKEN_PAYMASTER_V07,
  NodeClient,
  TokenGasChargeAboveLimitError,
  TokenGasInsufficientBalanceError,
  circlePaymasterProblems,
  decodeCircleSponsoredEvents,
  httpTransport,
  quoteCircleTokenCharge,
  readCirclePaymasterState,
  readTokenPermitInfo,
  toBytes,
  type Call,
  type CirclePaymasterState,
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
  type AaChainConfig,
  type AaClientBundle,
  type AaErc20Target,
  type AaSendQuote,
  type AaTokenGas,
  type TransportFactory,
} from './aa.ts';
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
 *  - The active network has a VERIFIED Circle paymaster: Base Sepolia only.
 *    CIRCLE_TOKEN_PAYMASTER_V07.tokens lists only chain 84532; the engine
 *    notes record that on Ethereum Sepolia the same address's entryPoint()
 *    reverts and its EntryPoint v0.7 deposit is zero (token-paymaster.ts
 *    lines 79-81), and Circle documents v0.7 only for Arbitrum and Base
 *    (lines 25-33). Mainnet addresses were never verified on-chain (line 111).
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
  return (
    'Paying the network fee in USDC is offered only on Base Sepolia, where Circle’s token paymaster ' +
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
  return chainCaip2 === 'eip155:84532' ? TOKEN_GAS_FIXED_ORACLE_NOTE : null;
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
// Where the choice is offered
// ---------------------------------------------------------------------------

export type TokenGasOffer =
  | { kind: 'available'; paymaster: string; token: string }
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
}): TokenGasOffer {
  if (!p.config || !p.owner || !isAaConfigured(p.config, p.owner)) {
    return { kind: 'unavailable', reason: TOKEN_GAS_NOT_CONFIGURED_NOTE };
  }
  if (!isFeatureAllowed('token-gas', p.chainCaip2)) {
    return { kind: 'unavailable', reason: readinessRefusal('token-gas') };
  }
  const pm = tokenGasPaymasterFor(p.chainCaip2);
  if (!pm) return { kind: 'unavailable', reason: tokenGasNotOnNetworkSentence(p.chainCaip2) };
  if (p.config.paymasterUrl) return { kind: 'unavailable', reason: TOKEN_GAS_SPONSORED_NOTE };
  const type = effectiveAaAccountType(p.config, p.owner);
  if (type === 'simple') return { kind: 'unavailable', reason: TOKEN_GAS_SIMPLE_ACCOUNT_NOTE };
  if (type === 'kernel-7702') return { kind: 'unavailable', reason: TOKEN_GAS_7702_NOTE };
  if (p.passkeySigner) return { kind: 'unavailable', reason: TOKEN_GAS_PASSKEY_NOTE };
  return { kind: 'available', ...pm };
}

/** Thrown when the paymaster fails its on-chain checks (the reason is plain text). */
export class TokenGasUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenGasUnavailableError';
  }
}

export type TokenGasCheck = { ok: true; state: CirclePaymasterState } | { ok: false; reason: string };

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
  options: { transportFor?: TransportFactory; now?: () => number; force?: boolean } = {},
): Promise<TokenGasCheck> {
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
  facts: TokenGasFacts,
  calls: Call[],
  extra: Pick<AaSendQuote, 'to' | 'tokenSpend' | 'token' | 'maxAdjustment'>,
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
    // Not estimated before the gate (see the file comment); the worst case
    // is tokenGas.maxTokenCharge.
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
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
  options: { fromMax?: boolean } = {},
): Promise<AaSendQuote> {
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
  options: { fromMax?: boolean } = {},
): Promise<AaSendQuote> {
  assertAaTokenChain(bundle, token);
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
export async function maxAaTokenGasSend(bundle: AaClientBundle, ownerAddress: string): Promise<bigint> {
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
): Promise<bigint> {
  assertAaTokenChain(bundle, token);
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
  tokenGas: Pick<AaTokenGas, 'decimals' | 'symbol'> = { decimals: 6, symbol: TOKEN_GAS_SYMBOL },
): { title: string; detail: string } | null {
  const fmt = (v: bigint) => exact(v, tokenGas.decimals);
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
    return { title: TOKEN_GAS_UNAVAILABLE_TITLE, detail: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  // EntryPoint v0.7 paymaster failure codes (AA30–AA36: account-abstraction
  // v0.7.0 EntryPoint._validatePaymasterPrepayment and its callers).
  if (/\bAA3[0-9]\b/.test(message)) {
    return {
      title: TOKEN_GAS_REFUSED_TITLE,
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

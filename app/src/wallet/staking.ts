import {
  LIDO_MAX_WITHDRAWAL_WEI,
  encodeErc20Approve,
  encodeErc20BalanceOf,
  encodeFunctionCall,
  httpTransport as evmHttpTransport,
  lidoDeploymentFor,
  lidoPreviewTokens,
  lidoStakeCall,
  lidoWithdrawalAmountProblem,
  planLidoClaim,
  readLidoBalances,
  readLidoState,
  readLidoWithdrawalRequests,
  readRethDepositLock,
  readRethEthValue,
  readRethValue,
  readRocketPoolState,
  requestWithdrawalCall,
  resolveRocketPool,
  rethBurnCall,
  rethBurnProblems,
  rocketDepositCall,
  rocketDepositProblems,
  rocketDepositSplit,
  rocketPoolDeploymentFor,
  rocketPreviewTokens,
  stakeOutcomePreview,
  toHex,
  verifyLidoDeployment,
  withdrawalApproveCall,
  wstethUnwrapCall,
  wstethWrapApproveCall,
  wstethWrapCall,
  type Call,
  type JsonRpcTransport,
  type LidoBalances,
  type LidoClaimPlan,
  type LidoDeployment,
  type LidoState,
  type RethDepositLock,
  type RocketPoolContracts,
  type RocketPoolDeployment,
  type RocketPoolState,
  type StakeOutcomePreview,
  type StakingPreviewToken,
  type WithdrawalRequestStatus,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is loaded by scripts/check-staking.mjs
// under Node's type stripping, which resolves relative specifiers literally
// (the swap.ts / aa.ts precedent).
import { prepareEvmSend, type EvmSendQuote } from './send.ts';
import { prepareAaCalls, type AaClientBundle, type AaSendQuote } from './aa.ts';
import { formatUnits } from './balances.ts';
import { assertFeatureAllowed } from '../config/readiness.ts';
import { evmProfileByCaip2, isBuiltInEvmChain } from '../config/evm-chain.ts';

/**
 * Staking glue (features 57 and 58, phase 18 item 2; design in
 * docs/STAKING.md section 6). Everything protocol-specific lives in the
 * engine (packages/chains-evm/src/staking.ts, with its sources); this
 * module decides what is OFFERED on which network, reads the live state
 * that can refuse an action, and reshapes each action's calls into the
 * EXISTING send paths — prepareEvmSend for the regular account (the
 * swap.ts prepareSwapSend precedent) and prepareAaCalls for a Kernel smart
 * account. There is no second signing or broadcast path here.
 *
 * WHAT IS OFFERED (test networks only; readiness row 'staking', enforced):
 *  - Ethereum Sepolia: Lido, STAKE ONLY in practice (stake to stETH or
 *    wstETH, wrap and unwrap). Lido calls the deployment deprecated and
 *    its oracle stopped reporting on 2025-07-02, so it pays no rewards;
 *    unstaking is refused after a LIVE isPaused() read of the queue.
 *  - Hoodi (eip155:560048), once the wallet has a built-in Hoodi profile:
 *    Lido in full (stake, wrap, unwrap, withdrawal request, claim) and
 *    Rocket Pool (deposit for rETH, burn rETH). Regular account only: the
 *    Kernel contracts have no code on Hoodi (docs/STAKING.md section 8).
 *  - Nothing anywhere else, and nothing on a main network.
 *
 * Every entry point calls assertFeatureAllowed('staking', chain) before any
 * network request. Deliberately free of React Native imports (beyond what
 * aa.ts already brings) so check-staking.mjs runs this exact code under
 * Node with fakes. Amounts are bigints in wei / token base units.
 */

/**
 * A plain refusal from this module (paused, over a limit, not offered,
 * nothing to claim…): its message is the whole sentence to show, and
 * nothing was quoted, signed or sent. Errors from the send paths keep
 * their own types (describeSendError / describeAaError word them).
 */
export class StakingRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StakingRefusal';
  }
}

export const STAKING_SEPOLIA = 'eip155:11155111';
export const STAKING_HOODI = 'eip155:560048';

// ---------------------------------------------------------------------------
// Copy (quoted statements carry their source and the date they were read)
// ---------------------------------------------------------------------------

/** A protocol's own words, quoted verbatim, with where and when they were read. */
export interface QuotedStatement {
  sentences: readonly string[];
  source: string;
  url: string;
  read: string;
  /** The wallet's one-line framing shown above the quote. */
  intro: string;
}

/**
 * Lido help centre, "What are the risks of staking with Lido?"
 * (https://help.lido.fi/en/articles/5230603-what-is-lido redirects to the
 * URL below), fetched 2026-10-11 UTC: the first sentence under "Smart
 * contract security", "Technical risk", "Slashing risk" and "stETH price
 * risk", copied verbatim.
 */
export const LIDO_RISK_STATEMENT: QuotedStatement = {
  intro: 'Lido’s own statement of the risks of staking with Lido:',
  sentences: [
    'There is an inherent risk that Lido Protocol could contain a smart contract vulnerability or bug.',
    'Lido Protocol is built atop experimental technology under active development, and there is no guarantee that ETH has been developed error-free.',
    'ETH validators risk staking penalties, with up to 100% of staked funds at risk if validators fail.',
    'Users risk an exchange price of stTokens which is lower than inherent value due to withdrawal restrictions on Lido, making arbitrage and risk-free market-making impossible.',
  ],
  source: 'Lido help centre, “What are the risks of staking with Lido?”',
  url: 'https://help.lido.fi/en/articles/5230603-what-are-the-risks-of-staking-with-lido',
  read: '2026-10-11',
};

/**
 * Rocket Pool has no page dedicated to the risks of holding rETH (its
 * documentation repository rocket-pool/docs.rocketpool.net at commit
 * ff739116, 2026-10-09, was searched for "risk"; the liquid-staking pages
 * mention risk only for the third-party CoW Swap route). These are its own
 * FAQ's words on losses and redemption (docs/en/protocol/faq.mdx, "How
 * does the protocol protect the value of rETH?" and "How can I access my
 * deposit and rewards?"), copied verbatim on 2026-10-11 UTC.
 */
export const ROCKET_POOL_RISK_STATEMENT: QuotedStatement = {
  intro:
    'Rocket Pool’s documentation has no page on the risks of holding rETH. Its FAQ says this about losses and about redeeming rETH:',
  sentences: [
    'If this does not completely make up for the loss, the rest is spread across the entire network through a reduction in the relative value of rETH, rather than one user taking large losses just due to bad luck that their deposit ended up on a bad node.',
    'You can also trade them back to the protocol for ETH + rewards gained if there is liquidity available in the protocol to cover the exchange.',
  ],
  source: 'Rocket Pool documentation, Protocol FAQ',
  url: 'https://docs.rocketpool.net/protocol/faq',
  read: '2026-10-11',
};

/** The rebasing caveat (docs/STAKING.md section 5.3; Lido's integration guide). */
export const STETH_REBASING_NOTE =
  'stETH is a rebasing token: its balance changes when Lido’s oracle reports, without any transfer. ' +
  'Because stETH is accounted in shares, a stake or a transfer often arrives 1 or 2 wei below the amount, ' +
  'and the figure shown here comes from the token’s own event, so it can be 1 or 2 wei above what really arrives.';

/**
 * The success screen's note about where the stETH balance can be read
 * (shown when the plan involves stETH). Home's token rows read the REGULAR
 * account's address (HomeScreen useTokenBalances) and only for tracked
 * tokens; the Staking screen tracks the token a stake gives, but the store
 * can refuse, so the note says "on Home" only when stETH was found on this
 * network's tracked list after the send (stethTracked true) and the stake
 * came from the regular account. Phase 18 emulator finding 2: the old
 * sentence named Home while Home had no stETH row.
 */
export function stakingSuccessBalanceNote(p: { smartAccount: boolean; stethTracked: boolean | null }): string {
  if (p.smartAccount) {
    return (
      'The stETH balance on this screen is your smart account’s, read from the token itself, so it is exact ' +
      'whenever it is read. Home’s token rows show your regular account’s balances, not the smart account’s.'
    );
  }
  if (p.stethTracked === true) {
    return 'The stETH balance on this screen and on Home is read from the token itself, so it is exact whenever it is read.';
  }
  return (
    'The stETH balance on this screen is read from the token itself, so it is exact whenever it is read. Home ' +
    'shows it once stETH is on this network’s tracked tokens (Manage tokens).'
  );
}

/**
 * The line under "Your staking balances" naming whose balances they are:
 * the smart account's when the smart-account toggle is on, else the
 * regular account's (phase 18 emulator finding 7).
 */
export function stakingBalancesHolderLine(smartAccount: boolean, address: string): string {
  return smartAccount ? `Balances of your smart account ${address}` : `Balances of your regular account ${address}`;
}

/** Why the smart account is not offered on Hoodi (docs/STAKING.md section 8, read 2026-10-10). */
export const HOODI_NO_SMART_ACCOUNT =
  'Hoodi has no Kernel smart-account contracts: the account factory, the account implementation and the ' +
  'permission module have no code there. Staking from a smart account is therefore not offered on Hoodi; ' +
  'use your regular account.';

/** Shown when Unstake is asked for on Sepolia, after the live isPaused() read said true. */
export const SEPOLIA_UNSTAKE_PAUSED =
  'Unstaking through Lido is paused on Sepolia: its withdrawal queue reports that it is paused (read just now) ' +
  'and has never accepted a request. On Ethereum mainnet, unstaking is a request that waits in Lido’s queue ' +
  'before the ETH can be claimed.';

/** The irreversibility of a Lido withdrawal request (Lido's integration guide: "Once requested, withdrawal cannot be canceled"). */
export const LIDO_REQUEST_NOTE =
  'A withdrawal request cannot be cancelled. Your stETH goes into Lido’s queue now; when an oracle report ' +
  'finalizes the request, Claim pays the ETH to this account. The ETH paid can be lower than the stETH sent ' +
  'if the protocol had losses in the meantime, and never more than the rate at the time of the request.';

/** Oracle silence after which the screen says rewards have stopped (judgement: Lido's report frame is 24 hours on Hoodi). */
export const LIDO_STALE_REPORT_SECONDS = 7n * 24n * 60n * 60n;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2 July 2025" (UTC) for a timestamp in seconds. */
export function utcDate(seconds: bigint): string {
  const d = new Date(Number(seconds) * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The "deprecated, no rewards" line for a Lido deployment, or null when neither applies. */
export function lidoHonestyLine(deployment: LidoDeployment, lastReportTime: bigint, nowSeconds: bigint): string | null {
  const stale = nowSeconds - lastReportTime > LIDO_STALE_REPORT_SECONDS;
  const parts: string[] = [];
  if (deployment.status === 'deprecated') {
    parts.push('Lido calls its deployment on this network deprecated.');
  }
  if (stale) {
    parts.push(
      `Test stETH here does not earn rewards: Lido’s oracle has not reported since ${utcDate(lastReportTime)}.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

// ---------------------------------------------------------------------------
// What is offered where
// ---------------------------------------------------------------------------

export type StakingProtocolId = 'lido' | 'rocket-pool';

export interface StakingOffer {
  caip2: string;
  lido: LidoDeployment | null;
  rocketPool: RocketPoolDeployment | null;
  /** Null when staking from a smart account may be offered here; else the sentence to show. */
  smartAccountRefusal: string | null;
  /** Null when at least one protocol is offered; else the sentence to show. */
  unavailable: string | null;
}

/**
 * The protocols offered on `caip2`. Throws FeatureNotAllowedError on a main
 * network (before any request). A network without a BUILT-IN profile (a
 * user-added network, or Hoodi before its profile exists) is offered
 * nothing: the pinned addresses were checked for the built-in networks.
 */
export function stakingOfferFor(caip2: string): StakingOffer {
  assertFeatureAllowed('staking', caip2);
  const builtIn = isBuiltInEvmChain(caip2) && evmProfileByCaip2(caip2) !== undefined;
  const lido = builtIn ? lidoDeploymentFor(caip2) : null;
  const rocketPool = builtIn ? rocketPoolDeploymentFor(caip2) : null;
  const hoodiReady = isBuiltInEvmChain(STAKING_HOODI);
  const where = hoodiReady
    ? 'Staking is offered on Ethereum Sepolia (Lido, staking only) and on Hoodi (Lido and Rocket Pool).'
    : 'Staking is offered on Ethereum Sepolia (Lido, staking only).';
  return {
    caip2,
    lido,
    rocketPool,
    smartAccountRefusal: stakingSmartAccountRefusal(caip2),
    unavailable: lido || rocketPool ? null : `No staking protocol is set up for this network in this wallet. ${where}`,
  };
}

/**
 * Null when the smart account may stake on `caip2`: only where the Kernel
 * v3.3 contracts were verified for the built-in profile. Hoodi gets its own
 * sentence (no Kernel code there).
 */
export function stakingSmartAccountRefusal(caip2: string): string | null {
  if (caip2 === STAKING_HOODI) return HOODI_NO_SMART_ACCOUNT;
  const profile = evmProfileByCaip2(caip2);
  if (!profile || !isBuiltInEvmChain(caip2) || profile.kernelV33Verified !== true) {
    return 'Staking from a smart account is offered only where the wallet has verified the Kernel smart-account contracts.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live availability
// ---------------------------------------------------------------------------

export interface LidoAvailability {
  deployment: LidoDeployment;
  state: LidoState;
  /** verifyLidoDeployment's problems; any problem refuses every Lido action. */
  problems: string[];
  /** The "deprecated, no rewards" line, or null. */
  honestyLine: string | null;
  stakeRefusal: string | null;
  unstakeRefusal: string | null;
}

/** Reads Lido's live state on the offer's network. Null when Lido is not offered there. */
export async function readLidoAvailability(
  node: JsonRpcTransport,
  caip2: string,
  nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<LidoAvailability | null> {
  const { lido } = stakingOfferFor(caip2);
  if (!lido) return null;
  const problems = await verifyLidoDeployment(node, lido);
  if (problems.length > 0) {
    const refusal = `Lido’s contracts on this network are not what the wallet expects, so nothing is offered. ${problems.join(' ')}`;
    return {
      deployment: lido,
      state: {
        stakingPaused: true,
        currentStakeLimit: 0n,
        queuePaused: true,
        lastRequestId: 0n,
        lastFinalizedRequestId: 0n,
        lastCheckpointIndex: 0n,
        oracleLastRefSlot: 0n,
        oracleLastReportTime: 0n,
      },
      problems,
      honestyLine: null,
      stakeRefusal: refusal,
      unstakeRefusal: refusal,
    };
  }
  const state = await readLidoState(node, lido);
  return {
    deployment: lido,
    state,
    problems,
    honestyLine: lidoHonestyLine(lido, state.oracleLastReportTime, nowSeconds),
    stakeRefusal: state.stakingPaused ? 'Lido has staking paused on this network right now (read just now).' : null,
    unstakeRefusal: state.queuePaused
      ? caip2 === STAKING_SEPOLIA
        ? SEPOLIA_UNSTAKE_PAUSED
        : 'Lido’s withdrawal queue is paused on this network right now (read just now), so no withdrawal request can be made.'
      : null,
  };
}

export interface RocketPoolAvailability {
  deployment: RocketPoolDeployment;
  contracts: RocketPoolContracts;
  state: RocketPoolState;
  depositRefusal: string | null;
}

/** Reads Rocket Pool's live state (registry resolution first). Null when it is not offered there. */
export async function readRocketPoolAvailability(node: JsonRpcTransport, caip2: string): Promise<RocketPoolAvailability | null> {
  const { rocketPool } = stakingOfferFor(caip2);
  if (!rocketPool) return null;
  const contracts = await resolveRocketPool(node, rocketPool);
  const state = await readRocketPoolState(node, contracts);
  return {
    deployment: rocketPool,
    contracts,
    state,
    depositRefusal: state.depositEnabled ? null : 'Rocket Pool has deposits switched off on this network right now (read just now).',
  };
}

export interface StakingBalances {
  lido: LidoBalances | null;
  /** Open (unclaimed) Lido withdrawal requests, ascending ids. */
  requests: WithdrawalRequestStatus[];
  rETH: bigint | null;
  rethEthValue: bigint | null;
  rethLock: RethDepositLock | null;
}

/** The holder's staking balances on the offer's network. */
export async function readStakingBalances(
  node: JsonRpcTransport,
  caip2: string,
  holder: string,
  rocket: RocketPoolAvailability | null = null,
): Promise<StakingBalances> {
  const offer = stakingOfferFor(caip2);
  const lido = offer.lido ? await readLidoBalances(node, offer.lido, holder) : null;
  // Sepolia's queue has never taken a request; reading it is harmless but
  // pointless, so only an active deployment is asked.
  const requests = offer.lido && offer.lido.status === 'active' ? await readLidoWithdrawalRequests(node, offer.lido, holder) : [];
  let rETH: bigint | null = null;
  let rethEthValue: bigint | null = null;
  let rethLock: RethDepositLock | null = null;
  if (rocket) {
    rETH = BigInt(
      (await node('eth_call', [{ to: rocket.contracts.rETH, data: toHex(encodeErc20BalanceOf(holder)) }, 'latest'])) as string,
    );
    rethEthValue = rETH === 0n ? 0n : await readRethEthValue(node, rocket.contracts.rETH, rETH);
    rethLock = await readRethDepositLock(node, rocket.contracts.storage, holder, rocket.state.depositDelayBlocks);
  }
  return { lido, requests, rETH, rethEthValue, rethLock };
}

// ---------------------------------------------------------------------------
// Plans: an action → the calls, the approval it needs, and what to show
// ---------------------------------------------------------------------------

export type StakingAction =
  | { kind: 'stake'; protocol: 'lido'; receive: 'stETH' | 'wstETH'; amount: bigint }
  | { kind: 'stake'; protocol: 'rocket-pool'; amount: bigint }
  | { kind: 'wrap'; amount: bigint }
  | { kind: 'unwrap'; amount: bigint }
  | { kind: 'unstake'; amount: bigint }
  | { kind: 'claim' }
  | { kind: 'burn'; amount: bigint };

/** An exact amount of something, for the confirm's "You send / You receive" lines. */
export interface StakingAmount {
  amount: bigint;
  symbol: string;
  decimals: number;
  /** True when the figure is a protocol-rate estimate, not an exact transfer. */
  approximate: boolean;
}

export interface StakingPlan {
  caip2: string;
  protocol: StakingProtocolId;
  action: StakingAction;
  /** The address the plan's balances were read for (the EOA, or the smart account). */
  holder: string;
  /** Every call, in order (a smart account runs them as one batch). */
  calls: Call[];
  /** The call that does the work (the last one). */
  main: Call;
  /** The exact token approval the main call needs first, when it needs one. */
  approval: { token: string; spender: string; amount: bigint; symbol: string } | null;
  youSend: StakingAmount | null;
  youReceive: StakingAmount | null;
  /** What the main call goes to, in words (shown above the address). */
  contractLabel: string;
  /** Tokens the outcome preview may name. */
  previewTokens: StakingPreviewToken[];
  /** True when stETH is involved (the rebasing note is shown). */
  rebasing: boolean;
  /** A token leaving the holder, for the spending-limit gate. */
  tokenOutflow: { token: string; amount: bigint } | null;
  /** Extra plain sentences for the confirm. */
  notes: string[];
  /** Present for a claim. */
  claim?: LidoClaimPlan;
}

const ETH = (amount: bigint, symbol: string): StakingAmount => ({ amount, symbol, decimals: 18, approximate: false });

async function tokenBalance(node: JsonRpcTransport, token: string, holder: string): Promise<bigint> {
  return BigInt((await node('eth_call', [{ to: token, data: toHex(encodeErc20BalanceOf(holder)) }, 'latest'])) as string);
}

async function uintView(node: JsonRpcTransport, to: string, signature: string, value: bigint): Promise<bigint> {
  const data = encodeFunctionCall(signature, [{ kind: 'uint256', value }]);
  return BigInt((await node('eth_call', [{ to, data: toHex(data) }, 'latest'])) as string);
}

function requireLido(caip2: string): LidoDeployment {
  const { lido, unavailable } = stakingOfferFor(caip2);
  if (!lido) throw new StakingRefusal(unavailable ?? 'Lido is not offered on this network in this wallet.');
  return lido;
}

/**
 * Builds the plan for one action, reading the live state that can refuse
 * it (paused staking or queue, the stake limit, Rocket Pool's minimum and
 * capacity, balances, the rETH lock). Every refusal is a plain sentence and
 * happens before any quote. `nativeSymbol` labels ETH ("test ETH").
 */
export async function planStakingAction(
  node: JsonRpcTransport,
  caip2: string,
  holder: string,
  action: StakingAction,
  nativeSymbol: string,
): Promise<StakingPlan> {
  assertFeatureAllowed('staking', caip2);
  const chainId = BigInt((await node('eth_chainId', [])) as string);
  if (`eip155:${chainId}` !== caip2) {
    throw new StakingRefusal(`The endpoint is chain id ${chainId}, not the network this screen is on. Nothing was quoted.`);
  }
  const base = { caip2, holder, action, notes: [] as string[] };

  if (action.kind === 'stake' && action.protocol === 'rocket-pool') {
    const rocket = await readRocketPoolAvailability(node, caip2);
    if (!rocket) throw new StakingRefusal(stakingOfferFor(caip2).unavailable ?? 'Rocket Pool is not offered on this network in this wallet.');
    const problems = rocketDepositProblems(rocket.state, action.amount);
    if (problems.length > 0) throw new StakingRefusal(problems.join(' '));
    const { fee, net } = rocketDepositSplit(action.amount, rocket.state.depositFee);
    const rETH = await readRethValue(node, rocket.contracts.rETH, net);
    const main = rocketDepositCall(rocket.contracts.depositPool, action.amount);
    const notes = [
      `Rocket Pool keeps a deposit fee of ${formatUnits(fee, 18, 18)} ${nativeSymbol} from this amount (read from its settings just now).`,
    ];
    if (rocket.state.depositDelayBlocks > 0n) {
      notes.push(
        `Rocket Pool’s rETH contract can refuse moving or redeeming rETH for ${rocket.state.depositDelayBlocks} blocks after a deposit; ` +
          'the wallet checks this before any redemption.',
      );
    }
    return {
      ...base,
      protocol: 'rocket-pool',
      calls: [main],
      main,
      approval: null,
      youSend: ETH(action.amount, nativeSymbol),
      youReceive: { amount: rETH, symbol: 'rETH', decimals: 18, approximate: true },
      contractLabel: 'Rocket Pool deposit pool (resolved from RocketStorage just now)',
      previewTokens: rocketPreviewTokens(rocket.contracts.rETH),
      rebasing: false,
      tokenOutflow: null,
      notes,
    };
  }

  if (action.kind === 'burn') {
    const rocket = await readRocketPoolAvailability(node, caip2);
    if (!rocket) throw new StakingRefusal(stakingOfferFor(caip2).unavailable ?? 'Rocket Pool is not offered on this network in this wallet.');
    const [balance, ethValue, lock] = await Promise.all([
      tokenBalance(node, rocket.contracts.rETH, holder),
      readRethEthValue(node, rocket.contracts.rETH, action.amount),
      readRethDepositLock(node, rocket.contracts.storage, holder, rocket.state.depositDelayBlocks),
    ]);
    const problems = rethBurnProblems({ amount: action.amount, balance, ethValue, totalCollateral: rocket.state.totalCollateral, lock });
    if (problems.length > 0) throw new StakingRefusal(problems.join(' '));
    const main = rethBurnCall(rocket.contracts.rETH, action.amount);
    return {
      ...base,
      protocol: 'rocket-pool',
      calls: [main],
      main,
      approval: null,
      youSend: { amount: action.amount, symbol: 'rETH', decimals: 18, approximate: false },
      youReceive: { ...ETH(ethValue, nativeSymbol), approximate: true },
      contractLabel: 'Rocket Pool rETH contract',
      previewTokens: rocketPreviewTokens(rocket.contracts.rETH),
      rebasing: false,
      tokenOutflow: { token: rocket.contracts.rETH, amount: action.amount },
      notes: [],
    };
  }

  // Lido actions.
  const lido = requireLido(caip2);
  const availability = await readLidoAvailability(node, caip2);
  if (!availability) throw new StakingRefusal('Lido is not offered on this network in this wallet.');
  if (availability.problems.length > 0) throw new StakingRefusal(availability.stakeRefusal!);
  const notes = availability.honestyLine ? [availability.honestyLine] : [];

  if (action.kind === 'stake') {
    if (action.amount <= 0n) throw new StakingRefusal('Enter an amount greater than zero.');
    if (availability.stakeRefusal) throw new StakingRefusal(availability.stakeRefusal);
    if (action.amount > availability.state.currentStakeLimit) {
      throw new StakingRefusal(
        `The amount is above Lido’s current stake limit on this network (${formatUnits(availability.state.currentStakeLimit, 18, 18)} ${nativeSymbol}).`,
      );
    }
    const main = lidoStakeCall(lido, action.amount, action.receive);
    const receive =
      action.receive === 'stETH'
        ? { amount: action.amount, symbol: 'stETH', decimals: 18, approximate: true }
        : { amount: await uintView(node, lido.wstETH, 'getWstETHByStETH(uint256)', action.amount), symbol: 'wstETH', decimals: 18, approximate: true };
    return {
      ...base,
      protocol: 'lido',
      calls: [main],
      main,
      approval: null,
      youSend: ETH(action.amount, nativeSymbol),
      youReceive: receive,
      contractLabel: action.receive === 'stETH' ? 'Lido stETH contract (submit)' : 'Lido wstETH contract (stake and wrap in one step)',
      previewTokens: lidoPreviewTokens(lido),
      rebasing: action.receive === 'stETH',
      tokenOutflow: null,
      notes,
    };
  }

  if (action.kind === 'wrap') {
    const balance = await tokenBalance(node, lido.stETH, holder);
    if (action.amount <= 0n) throw new StakingRefusal('Enter an amount greater than zero.');
    if (action.amount > balance) throw new StakingRefusal('The amount is more stETH than this account holds.');
    const approve = wstethWrapApproveCall(lido, action.amount);
    const main = wstethWrapCall(lido, action.amount);
    return {
      ...base,
      protocol: 'lido',
      calls: [approve, main],
      main,
      approval: { token: lido.stETH, spender: lido.wstETH, amount: action.amount, symbol: 'stETH' },
      youSend: { amount: action.amount, symbol: 'stETH', decimals: 18, approximate: false },
      youReceive: { amount: await uintView(node, lido.wstETH, 'getWstETHByStETH(uint256)', action.amount), symbol: 'wstETH', decimals: 18, approximate: true },
      contractLabel: 'Lido wstETH contract (wrap)',
      previewTokens: lidoPreviewTokens(lido),
      rebasing: true,
      tokenOutflow: { token: lido.stETH, amount: action.amount },
      notes,
    };
  }

  if (action.kind === 'unwrap') {
    const balance = await tokenBalance(node, lido.wstETH, holder);
    if (action.amount <= 0n) throw new StakingRefusal('Enter an amount greater than zero.');
    if (action.amount > balance) throw new StakingRefusal('The amount is more wstETH than this account holds.');
    const main = wstethUnwrapCall(lido, action.amount);
    return {
      ...base,
      protocol: 'lido',
      calls: [main],
      main,
      approval: null,
      youSend: { amount: action.amount, symbol: 'wstETH', decimals: 18, approximate: false },
      youReceive: { amount: await uintView(node, lido.wstETH, 'getStETHByWstETH(uint256)', action.amount), symbol: 'stETH', decimals: 18, approximate: true },
      contractLabel: 'Lido wstETH contract (unwrap)',
      previewTokens: lidoPreviewTokens(lido),
      rebasing: true,
      tokenOutflow: { token: lido.wstETH, amount: action.amount },
      notes,
    };
  }

  if (action.kind === 'unstake') {
    // The live isPaused() read above decides: on Sepolia it is true.
    if (availability.unstakeRefusal) throw new StakingRefusal(availability.unstakeRefusal);
    const problem = lidoWithdrawalAmountProblem(action.amount);
    if (problem) throw new StakingRefusal(problem);
    const balance = await tokenBalance(node, lido.stETH, holder);
    if (action.amount > balance) throw new StakingRefusal('The amount is more stETH than this account holds.');
    const approve = withdrawalApproveCall(lido, action.amount);
    const main = requestWithdrawalCall(lido, action.amount, holder);
    return {
      ...base,
      protocol: 'lido',
      calls: [approve, main],
      main,
      approval: { token: lido.stETH, spender: lido.withdrawalQueue, amount: action.amount, symbol: 'stETH' },
      youSend: { amount: action.amount, symbol: 'stETH', decimals: 18, approximate: false },
      youReceive: null,
      contractLabel: 'Lido withdrawal queue (request)',
      previewTokens: lidoPreviewTokens(lido),
      rebasing: true,
      tokenOutflow: { token: lido.stETH, amount: action.amount },
      notes: [...notes, LIDO_REQUEST_NOTE],
    };
  }

  // claim
  const requests = await readLidoWithdrawalRequests(node, lido, holder);
  const claim = await planLidoClaim(node, lido, holder, requests);
  if (!claim) {
    const pending = requests.filter((r) => !r.isFinalized).length;
    throw new StakingRefusal(
      pending > 0
        ? `Nothing to claim yet: ${pending === 1 ? 'your request is' : `${pending} requests are`} still waiting in Lido’s queue.`
        : 'Nothing to claim: this account has no finalized withdrawal request.',
    );
  }
  return {
    ...base,
    protocol: 'lido',
    calls: [claim.call],
    main: claim.call,
    approval: null,
    youSend: null,
    youReceive: ETH(claim.total, nativeSymbol),
    contractLabel: 'Lido withdrawal queue (claim)',
    previewTokens: lidoPreviewTokens(lido),
    rebasing: false,
    tokenOutflow: null,
    notes: [
      `Claims ${claim.requestIds.length === 1 ? 'request' : 'requests'} ${claim.requestIds.join(', ')}; the ETH is paid to this account.`,
    ],
    claim,
  };
}

/** The upper bound of one Lido request, for the form's hint. */
export const LIDO_MAX_REQUEST_WEI = LIDO_MAX_WITHDRAWAL_WEI;

// ---------------------------------------------------------------------------
// Reshaping into the existing send paths
// ---------------------------------------------------------------------------

export type StakingEoaQuote =
  | { step: 'approve'; quote: EvmSendQuote; allowance: bigint }
  | { step: 'main'; quote: EvmSendQuote };

/** allowance(owner, spender) on `token`. */
export async function readStakingAllowance(node: JsonRpcTransport, token: string, owner: string, spender: string): Promise<bigint> {
  const data = encodeFunctionCall('allowance(address,address)', [
    { kind: 'address', value: owner },
    { kind: 'address', value: spender },
  ]);
  return BigInt((await node('eth_call', [{ to: token, data: toHex(data) }, 'latest'])) as string);
}

/**
 * The regular-account quote for a plan, through prepareEvmSend (chain-id
 * check, fee, balance, eth_call pre-flight). When the plan needs a token
 * approval that is not in place yet, the quote is the EXACT approve
 * (never unlimited), and the caller quotes the main call again once the
 * approval has taken effect — the swap flow's two steps.
 */
export async function prepareStakingSend(url: string, from: string, plan: StakingPlan): Promise<StakingEoaQuote> {
  assertFeatureAllowed('staking', plan.caip2);
  if (plan.holder.toLowerCase() !== from.toLowerCase()) {
    throw new StakingRefusal('This plan was prepared for another address. Nothing was quoted.');
  }
  if (plan.approval) {
    const allowance = await readStakingAllowance(evmHttpTransport(url), plan.approval.token, from, plan.approval.spender);
    if (allowance < plan.approval.amount) {
      const quote = await prepareEvmSend(
        url,
        from,
        plan.approval.token,
        0n,
        encodeErc20Approve(plan.approval.spender, plan.approval.amount),
        plan.caip2,
      );
      return { step: 'approve', quote, allowance };
    }
  }
  const quote = await prepareEvmSend(url, from, plan.main.to, plan.main.value, plan.main.data, plan.caip2);
  return { step: 'main', quote };
}

/**
 * The smart-account quote for a plan, through prepareAaCalls: all the
 * plan's calls in ONE operation (the approval, when needed, and the main
 * call, all-or-nothing). Refused where the smart account is not offered
 * (Hoodi), and when the plan was read for another address than the
 * account that will send.
 */
export async function prepareStakingAa(bundle: AaClientBundle, ownerAddress: string, plan: StakingPlan): Promise<AaSendQuote> {
  assertFeatureAllowed('staking', plan.caip2);
  const refusal = stakingSmartAccountRefusal(plan.caip2);
  if (refusal) throw new StakingRefusal(refusal);
  if (`eip155:${bundle.chainId}` !== plan.caip2) {
    throw new StakingRefusal('The smart-account setup is for another network than this plan. Nothing was quoted.');
  }
  const quote = await prepareAaCalls(bundle, ownerAddress, plan.calls, {
    displayTo: plan.main.to,
    ...(plan.tokenOutflow && plan.youSend
      ? { tokenSpend: { contract: plan.tokenOutflow.token, amount: plan.tokenOutflow.amount, symbol: plan.youSend.symbol } }
      : {}),
  });
  if (quote.sender.toLowerCase() !== plan.holder.toLowerCase()) {
    throw new StakingRefusal('This plan was read for another address than the smart account. Nothing was quoted.');
  }
  return quote;
}

/** The outcome preview (ETH out, stETH / wstETH / rETH in) for a plan, from the holder. */
export async function previewStakingPlan(node: JsonRpcTransport, plan: StakingPlan): Promise<StakeOutcomePreview> {
  return stakeOutcomePreview(node, plan.holder, plan.calls, plan.previewTokens);
}

/** "You send …" / "You receive ≈ …" lines (full precision; never rounded away). */
export function stakingSummaryLines(plan: StakingPlan): string[] {
  const line = (label: string, a: StakingAmount) =>
    `${label} ${a.approximate ? '≈ ' : ''}${formatUnits(a.amount, a.decimals, a.decimals)} ${a.symbol}`;
  const out: string[] = [];
  if (plan.youSend) out.push(line('You send', plan.youSend));
  if (plan.youReceive) out.push(line('You receive', plan.youReceive));
  if (plan.action.kind === 'unstake') out.push('You receive a withdrawal request (an NFT) to claim the ETH later.');
  return out;
}

/** The labels of the actions, for buttons and the device prompt. */
export function stakingActionTitle(action: StakingAction, nativeSymbol: string): string {
  switch (action.kind) {
    case 'stake':
      return action.protocol === 'lido'
        ? `Stake ${formatUnits(action.amount, 18, 18)} ${nativeSymbol} with Lido for ${action.receive}`
        : `Stake ${formatUnits(action.amount, 18, 18)} ${nativeSymbol} with Rocket Pool for rETH`;
    case 'wrap':
      return `Wrap ${formatUnits(action.amount, 18, 18)} stETH into wstETH`;
    case 'unwrap':
      return `Unwrap ${formatUnits(action.amount, 18, 18)} wstETH into stETH`;
    case 'unstake':
      return `Request to unstake ${formatUnits(action.amount, 18, 18)} stETH with Lido`;
    case 'claim':
      return 'Claim finished Lido withdrawals';
    case 'burn':
      return `Redeem ${formatUnits(action.amount, 18, 18)} rETH with Rocket Pool`;
  }
}

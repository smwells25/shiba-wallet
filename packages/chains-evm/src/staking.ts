import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress } from '@shiba-wallet/core';
import { encodeFunctionCall, selector } from './abi.js';
import { simulateAssetChanges } from './asset-diff.js';
// The zero address: Lido's submit(_referral) takes it for "no referral".
import { ZERO_ADDRESS } from './eip7702.js';
import { toBytes, toHex } from './encoding.js';
import { encodeErc20Approve, encodeErc20BalanceOf } from './erc20.js';
import type { JsonRpcTransport } from './rpc.js';
import type { Call } from './smart-account.js';

/**
 * Liquid staking on test networks (features 57 and 58; phase 18 item 2;
 * design in docs/STAKING.md): calldata encoders, read-only state readers
 * and a balance-change preview for Lido (stETH, wstETH, the withdrawal
 * queue) and Rocket Pool (rETH). Every amount is an exact bigint in wei
 * or token base units; nothing here signs or sends — the app reshapes the
 * calls built here through its existing send paths.
 *
 * SOURCES (all read 2026-10-11 UTC unless stated otherwise):
 *  - [L] lidofinance/core tag v4.0.1 = commit
 *    2da0f48f1a2a103a394dcf8760810fe9165697fb (the version Lido's Hoodi
 *    page names): contracts/0.4.24/Lido.sol (submit lines 508–510, the
 *    fallback 497–501, isStakingPaused 421, getCurrentStakeLimit 431,
 *    getLidoLocator 715), contracts/0.4.24/StETH.sol (sharesOf 308,
 *    getPooledEthByShares 329), contracts/0.6.12/WstETH.sol (wrap 53–59,
 *    unwrap 69–75, receive 80–83 "Shortcut to stake ETH and auto-wrap
 *    returned stETH", stEthPerToken), contracts/0.8.9/WithdrawalQueue.sol
 *    (MIN/MAX_STETH_WITHDRAWAL_AMOUNT 52/57, requestWithdrawals 125–136,
 *    getWithdrawalRequests 201, getWithdrawalStatus 207, getClaimableEther
 *    223, claimWithdrawals 266–275, claimWithdrawal 284–287,
 *    findCheckpointHints 298–311), contracts/0.8.9/WithdrawalQueueBase.sol
 *    (WithdrawalRequestStatus 68–81, getLastCheckpointIndex 133,
 *    _findCheckpointHint 418–452 with NOT_FOUND = 0),
 *    contracts/0.8.9/utils/PausableUntil.sol (isPaused 51).
 *  - [LS] Sourcify exact matches: the Sepolia Lido implementation
 *    0x3e7e93bA66d26608c2Ffe1630F445D8D29aC6C92 (Lido.sol, solc 0.4.24;
 *    submit at line 465, the fallback at 454), wstETH on Sepolia
 *    0xB82381A3fBD3FaFA77B3a7bE693342618240067b and on Hoodi
 *    0x7E99eE3C66636DE415D2d7C880938F2f40f94De4 (WstETH.sol, solc 0.6.12,
 *    receive at line 80), the Sepolia withdrawal-queue implementation
 *    0x0220A1cF6C3a548BE75aEabCdA509CaB08CDe063 (WithdrawalQueueERC721,
 *    solc 0.8.9). The Hoodi Lido implementation 0xB9A2…7352 and the Hoodi
 *    queue implementation 0xD0a60e52837e045F4567193Cf8921191C486eCD5 are
 *    not on Sourcify; the Hoodi queue implementation's runtime code was
 *    compared byte for byte with the verified Sepolia one: same length
 *    (24,190 bytes), and the only differences are the nine 20-byte
 *    immutable slots holding the stETH and wstETH addresses.
 *  - [LD] lidofinance/docs commit 140c583d8dc64c9dd842fede3e53c499d44b7796,
 *    docs/deployed-contracts/sepolia.md (lines 4, 22, 23, 30: "The Sepolia
 *    deployment is now fully deprecated") and hoodi.md (lines 19, 21, 30).
 *  - [R] rocket-pool/rocketpool commit
 *    fef41a4f7cf99d7d66313c0ba04deb8ba2dabf88:
 *    contracts/contract/RocketBase.sol line 106 (contract addresses live in
 *    RocketStorage under keccak256(abi.encodePacked("contract.address",
 *    name))), contracts/contract/RocketStorage.sol (getAddress 153,
 *    getUint 158), contracts/contract/deposit/RocketDepositPool.sol
 *    (deposit 114–156: enabled and minimum checks, the fee, rETH minted to
 *    msg.sender; onlyThisLatestContract 59–63; getMaximumDepositAmount
 *    160–180), contracts/contract/token/RocketTokenRETH.sol (getEthValue
 *    39, getRethValue 51, getExchangeRate 66, getTotalCollateral 72, burn
 *    106–123, _beforeTokenTransfer 157–172: the "user.deposit.block" lock),
 *    contracts/contract/dao/protocol/settings/RocketDAOProtocolSettings.sol
 *    line 25 (the namespace keccak256("dao.protocol.setting." + name)),
 *    RocketDAOProtocolSettingsDeposit.sol (getDepositEnabled 54,
 *    getMinimumDeposit 64, getDepositFee 84) and
 *    RocketDAOProtocolSettingsNetwork.sol (getRethDepositDelay 196:
 *    "network.reth.deposit.delay").
 *  - [RN] rocket-pool/smartnode commit
 *    8c1dad70a62ff8d36b64da85e664b10d8b91cf46,
 *    shared/services/rocketpool/assets/install/networks-default.yml, the
 *    "Hoodi Testnet" entry (chainID 560048): storage
 *    0x594Fb75D3dc2DFa0150Ad03F99F97817747dd4E1, reth
 *    0x7322c24752f79c05FFD1E2a6FCB97020C1C264F1.
 *  - [RD] rocket-pool/docs.rocketpool.net commit ff739116 (2026-10-09),
 *    docs/en/protocol/contracts-usage.md line 54 (the same getAddress
 *    pattern) and line 126 ("the RocketDepositPool contract address should
 *    not be hard-coded … but retrieved from RocketStorage dynamically").
 *
 * THE rETH DEPOSIT LOCK. RocketTokenRETH._beforeTokenTransfer refuses a
 * transfer or burn while block.number − user.deposit.block ≤ the
 * "network.reth.deposit.delay" setting (5,760 blocks on Hoodi, read
 * 2026-10-11). At commit fef41a4f NOTHING in the repository writes
 * "user.deposit.block" (searched across contracts/), and the deployed
 * Hoodi deposit pool (Sourcify match, RocketDepositPool v4) does not
 * either, so a deposit made today does not start the lock. The wallet
 * still reads the stored block (readRethDepositLock) and refuses a burn
 * while a lock recorded by an older deposit pool is running, so the rule
 * holds whichever contract version wrote it. The deployed Hoodi rETH
 * (Sourcify match, solc 0.7.6) has the same lock at lines 189–195 of its
 * verified RocketTokenRETH.sol. A simulated deposit followed by a burn in
 * the next block succeeded on Hoodi on 2026-10-11 (scripts/testnet/
 * staking-smoke.mjs), confirming no lock was started.
 *
 * rETH burn() pays ETH with Solidity transfer() (a 2,300-gas stipend; line
 * 148 of the deployed source). In the same simulation the burn REVERTED for
 * an address carrying an EIP-7702 delegation (account 0 of the public test
 * mnemonic is delegated on Hoodi) and succeeded for a plain EOA; the
 * 2,300-gas payout is the likely cause (inferred, not traced). A holder
 * with code may therefore be unable to redeem; the send path's eth_call
 * pre-flight blocks such a burn before anything is signed.
 *
 * ON-CHAIN CHECKS of the pinned addresses (2026-10-11, PublicNode
 * endpoints, Sepolia block 11,888,676, Hoodi block 3,792,945): stETH
 * symbol() "stETH", name() "Liquid staked Ether 2.0", 18 decimals, 1,007
 * bytes of proxy code; wstETH symbol() "wstETH", stETH() equals the stETH
 * address; the queue symbol() "unstETH", name() "Lido: stETH Withdrawal
 * NFT", and the Lido locator's withdrawalQueue() equals it; RocketStorage
 * getDeployedStatus() true and its rocketTokenRETH entry equals the pinned
 * rETH (symbol() "rETH", name() "Rocket Pool ETH"). The test fixtures
 * (test/fixtures/staking-*.json) hold these reads.
 */


/** MIN_STETH_WITHDRAWAL_AMOUNT = 100 [L WithdrawalQueue.sol line 52]. */
export const LIDO_MIN_WITHDRAWAL_WEI = 100n;
/** MAX_STETH_WITHDRAWAL_AMOUNT = 1000 * 1e18 [L WithdrawalQueue.sol line 57]. */
export const LIDO_MAX_WITHDRAWAL_WEI = 1000n * 10n ** 18n;
/** RocketDepositPool's calcBase for the deposit fee (1 ether) [R]. */
export const ROCKET_CALC_BASE = 10n ** 18n;

/** One Lido deployment, pinned per CAIP-2 chain id. */
export interface LidoDeployment {
  /** CAIP-2 id of the chain. */
  chain: string;
  /** Lido proxy, which is also the stETH token. */
  stETH: string;
  wstETH: string;
  /** WithdrawalQueueERC721 proxy (the "unstETH" NFT). */
  withdrawalQueue: string;
  /** Lido's own status of the deployment [LD]. */
  status: 'deprecated' | 'active';
  /** Where the addresses come from. */
  source: string;
}

/**
 * The Lido deployments the wallet knows, keyed by CAIP-2 id. Addresses are
 * copied from Lido's deployed-contracts pages [LD] and checked on-chain
 * (see the file comment). Mainnet is deliberately absent: staking is a
 * test-network feature in this build.
 */
export const LIDO_DEPLOYMENTS: Readonly<Record<string, LidoDeployment>> = {
  'eip155:11155111': {
    chain: 'eip155:11155111',
    stETH: '0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af',
    wstETH: '0xB82381A3fBD3FaFA77B3a7bE693342618240067b',
    withdrawalQueue: '0x1583C7b3f4C3B008720E6BcE5726336b0aB25fdd',
    status: 'deprecated',
    source: 'lidofinance/docs 140c583d docs/deployed-contracts/sepolia.md lines 22, 23, 30',
  },
  'eip155:560048': {
    chain: 'eip155:560048',
    stETH: '0x3508A952176b3c15387C97BE809eaffB1982176a',
    wstETH: '0x7E99eE3C66636DE415D2d7C880938F2f40f94De4',
    withdrawalQueue: '0xfe56573178f1bcdf53F01A6E9977670dcBBD9186',
    status: 'active',
    source: 'lidofinance/docs 140c583d docs/deployed-contracts/hoodi.md lines 19, 21, 30',
  },
};

/** One Rocket Pool deployment, pinned per CAIP-2 chain id. */
export interface RocketPoolDeployment {
  chain: string;
  /** RocketStorage: the registry every other address is read from [R, RD]. */
  storage: string;
  /** rETH as the official network file lists it; the registry must agree. */
  rETH: string;
  source: string;
}

/** The Rocket Pool deployments the wallet knows (Hoodi only; none on Sepolia [RN]). */
export const ROCKET_POOL_DEPLOYMENTS: Readonly<Record<string, RocketPoolDeployment>> = {
  'eip155:560048': {
    chain: 'eip155:560048',
    storage: '0x594Fb75D3dc2DFa0150Ad03F99F97817747dd4E1',
    rETH: '0x7322c24752f79c05FFD1E2a6FCB97020C1C264F1',
    source: 'rocket-pool/smartnode 8c1dad70 shared/services/rocketpool/assets/install/networks-default.yml, "Hoodi Testnet"',
  },
};

export function lidoDeploymentFor(caip2: string): LidoDeployment | null {
  return LIDO_DEPLOYMENTS[caip2] ?? null;
}

export function rocketPoolDeploymentFor(caip2: string): RocketPoolDeployment | null {
  return ROCKET_POOL_DEPLOYMENTS[caip2] ?? null;
}

// ---------------------------------------------------------------------------
// Signatures and selectors (each signature copied from the cited source)
// ---------------------------------------------------------------------------

/** Canonical signatures of every state-changing call the wallet builds. */
export const STAKING_SIGNATURES = {
  /** Lido.sol line 508 [L]; Sepolia's verified source line 465 [LS]. */
  lidoSubmit: 'submit(address)',
  /** WstETH.sol line 53 [L, LS]. */
  wstethWrap: 'wrap(uint256)',
  /** WstETH.sol line 69 [L, LS]. */
  wstethUnwrap: 'unwrap(uint256)',
  /** WithdrawalQueue.sol line 125 [L, LS]. */
  requestWithdrawals: 'requestWithdrawals(uint256[],address)',
  /** WithdrawalQueue.sol line 144 [L]. */
  requestWithdrawalsWstETH: 'requestWithdrawalsWstETH(uint256[],address)',
  /** WithdrawalQueue.sol line 266 [L, LS]. */
  claimWithdrawals: 'claimWithdrawals(uint256[],uint256[])',
  /** WithdrawalQueue.sol line 284 [L]. */
  claimWithdrawal: 'claimWithdrawal(uint256)',
  /** RocketDepositPool.sol line 114 [R]. */
  rocketDeposit: 'deposit()',
  /** RocketTokenRETH.sol line 106 [R]. */
  rethBurn: 'burn(uint256)',
  /** The ERC-20 approve the stETH approval steps use. */
  approve: 'approve(address,uint256)',
} as const;

/** 4-byte selectors of STAKING_SIGNATURES, as 0x-hex (pinned against ethers in the tests). */
export const STAKING_SELECTORS: Readonly<Record<keyof typeof STAKING_SIGNATURES, string>> = Object.fromEntries(
  Object.entries(STAKING_SIGNATURES).map(([k, sig]) => [k, toHex(selector(sig))]),
) as Record<keyof typeof STAKING_SIGNATURES, string>;

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

const uints = (values: readonly bigint[]) => ({
  kind: 'array' as const,
  items: values.map((value) => ({ kind: 'uint256' as const, value })),
});

/** Lido submit(address _referral); the referral defaults to none (the zero address). */
export function encodeLidoSubmit(referral: string = ZERO_ADDRESS): Uint8Array {
  return encodeFunctionCall(STAKING_SIGNATURES.lidoSubmit, [{ kind: 'address', value: referral }]);
}

export function encodeWstethWrap(stETHAmount: bigint): Uint8Array {
  return encodeFunctionCall(STAKING_SIGNATURES.wstethWrap, [{ kind: 'uint256', value: stETHAmount }]);
}

export function encodeWstethUnwrap(wstETHAmount: bigint): Uint8Array {
  return encodeFunctionCall(STAKING_SIGNATURES.wstethUnwrap, [{ kind: 'uint256', value: wstETHAmount }]);
}

export function encodeRequestWithdrawals(amounts: readonly bigint[], owner: string): Uint8Array {
  return encodeFunctionCall(STAKING_SIGNATURES.requestWithdrawals, [uints(amounts), { kind: 'address', value: owner }]);
}

export function encodeRequestWithdrawalsWstETH(amounts: readonly bigint[], owner: string): Uint8Array {
  return encodeFunctionCall(STAKING_SIGNATURES.requestWithdrawalsWstETH, [uints(amounts), { kind: 'address', value: owner }]);
}

export function encodeClaimWithdrawals(requestIds: readonly bigint[], hints: readonly bigint[]): Uint8Array {
  return encodeFunctionCall(STAKING_SIGNATURES.claimWithdrawals, [uints(requestIds), uints(hints)]);
}

export function encodeClaimWithdrawal(requestId: bigint): Uint8Array {
  return encodeFunctionCall(STAKING_SIGNATURES.claimWithdrawal, [{ kind: 'uint256', value: requestId }]);
}

export function encodeRocketDeposit(): Uint8Array {
  return encodeFunctionCall(STAKING_SIGNATURES.rocketDeposit, []);
}

export function encodeRethBurn(rethAmount: bigint): Uint8Array {
  return encodeFunctionCall(STAKING_SIGNATURES.rethBurn, [{ kind: 'uint256', value: rethAmount }]);
}

// Read-only views (eth_call payloads).

export function encodeFindCheckpointHints(requestIds: readonly bigint[], firstIndex: bigint, lastIndex: bigint): Uint8Array {
  return encodeFunctionCall('findCheckpointHints(uint256[],uint256,uint256)', [
    uints(requestIds),
    { kind: 'uint256', value: firstIndex },
    { kind: 'uint256', value: lastIndex },
  ]);
}

export function encodeGetWithdrawalStatus(requestIds: readonly bigint[]): Uint8Array {
  return encodeFunctionCall('getWithdrawalStatus(uint256[])', [uints(requestIds)]);
}

export function encodeGetWithdrawalRequests(owner: string): Uint8Array {
  return encodeFunctionCall('getWithdrawalRequests(address)', [{ kind: 'address', value: owner }]);
}

export function encodeGetClaimableEther(requestIds: readonly bigint[], hints: readonly bigint[]): Uint8Array {
  return encodeFunctionCall('getClaimableEther(uint256[],uint256[])', [uints(requestIds), uints(hints)]);
}

/** keccak256(abi.encodePacked("contract.address", name)) [R RocketBase.sol line 106]. */
export function rocketContractAddressKey(name: string): Uint8Array {
  return keccak_256(utf8ToBytes(`contract.address${name}`));
}

/**
 * keccak256(abi.encodePacked(keccak256("dao.protocol.setting." + namespace), path))
 * [R RocketDAOProtocolSettings.sol lines 25 and 32; RocketTokenRETH.sol line 165].
 */
export function rocketProtocolSettingKey(namespace: string, path: string): Uint8Array {
  return keccak_256(concatBytes(keccak_256(utf8ToBytes(`dao.protocol.setting.${namespace}`)), utf8ToBytes(path)));
}

/** keccak256(abi.encodePacked("user.deposit.block", user)) [R RocketTokenRETH.sol line 161]. */
export function rocketUserDepositBlockKey(user: string): Uint8Array {
  return keccak_256(concatBytes(utf8ToBytes('user.deposit.block'), toBytes(user)));
}

// ---------------------------------------------------------------------------
// Calls (what the app reshapes through its send paths)
// ---------------------------------------------------------------------------

/** Which token a Lido stake returns. */
export type LidoStakeReceipt = 'stETH' | 'wstETH';

/**
 * The single call that stakes `amount` wei with Lido:
 *  - 'stETH': submit(address(0)) on the Lido proxy; stETH is minted to
 *    msg.sender [L Lido.sol _submit];
 *  - 'wstETH': a plain ETH transfer to wstETH, whose receive() submits and
 *    mints wstETH to msg.sender [L WstETH.sol lines 80–83].
 */
export function lidoStakeCall(deployment: LidoDeployment, amount: bigint, receive: LidoStakeReceipt = 'stETH'): Call {
  if (amount <= 0n) throw new Error('The amount to stake must be greater than zero (Lido refuses ZERO_DEPOSIT).');
  return receive === 'stETH'
    ? { to: deployment.stETH, value: amount, data: encodeLidoSubmit() }
    : { to: deployment.wstETH, value: amount, data: new Uint8Array(0) };
}

/** approve(wstETH, exactly amount) on stETH: what wrap() needs first [L WstETH.sol line 47]. */
export function wstethWrapApproveCall(deployment: LidoDeployment, stETHAmount: bigint): Call {
  return { to: deployment.stETH, value: 0n, data: encodeErc20Approve(deployment.wstETH, stETHAmount) };
}

export function wstethWrapCall(deployment: LidoDeployment, stETHAmount: bigint): Call {
  if (stETHAmount <= 0n) throw new Error('The amount to wrap must be greater than zero.');
  return { to: deployment.wstETH, value: 0n, data: encodeWstethWrap(stETHAmount) };
}

export function wstethUnwrapCall(deployment: LidoDeployment, wstETHAmount: bigint): Call {
  if (wstETHAmount <= 0n) throw new Error('The amount to unwrap must be greater than zero.');
  return { to: deployment.wstETH, value: 0n, data: encodeWstethUnwrap(wstETHAmount) };
}

/** Plain-language problem with a withdrawal amount, or null [L lines 395–402]. */
export function lidoWithdrawalAmountProblem(amount: bigint): string | null {
  if (amount < LIDO_MIN_WITHDRAWAL_WEI) {
    return 'Lido accepts a withdrawal request of at least 100 wei of stETH.';
  }
  if (amount > LIDO_MAX_WITHDRAWAL_WEI) {
    return 'Lido accepts at most 1,000 stETH in one withdrawal request.';
  }
  return null;
}

/** approve(queue, exactly amount) on stETH: requestWithdrawals pulls with transferFrom [L line 374]. */
export function withdrawalApproveCall(deployment: LidoDeployment, amount: bigint): Call {
  return { to: deployment.stETH, value: 0n, data: encodeErc20Approve(deployment.withdrawalQueue, amount) };
}

/**
 * requestWithdrawals([amount], owner) on the queue: one request, owned by
 * `owner` (the zero address would also mean msg.sender [L line 128]; the
 * wallet always names the owner explicitly).
 */
export function requestWithdrawalCall(deployment: LidoDeployment, amount: bigint, owner: string): Call {
  const problem = lidoWithdrawalAmountProblem(amount);
  if (problem) throw new Error(problem);
  if (owner.toLowerCase() === ZERO_ADDRESS) throw new Error('The request owner must be an address.');
  return { to: deployment.withdrawalQueue, value: 0n, data: encodeRequestWithdrawals([amount], owner) };
}

/** claimWithdrawals(ids, hints): pays msg.sender [L lines 266–275]. Never claimWithdrawalsTo. */
export function claimWithdrawalsCall(deployment: LidoDeployment, requestIds: readonly bigint[], hints: readonly bigint[]): Call {
  if (requestIds.length === 0) throw new Error('There is nothing to claim.');
  if (requestIds.length !== hints.length) throw new Error('Each request needs exactly one checkpoint hint.');
  return { to: deployment.withdrawalQueue, value: 0n, data: encodeClaimWithdrawals(requestIds, hints) };
}

/** deposit() with value on the CURRENT deposit pool (resolve it first: resolveRocketPool). */
export function rocketDepositCall(depositPool: string, amount: bigint): Call {
  if (amount <= 0n) throw new Error('The amount to stake must be greater than zero.');
  return { to: depositPool, value: amount, data: encodeRocketDeposit() };
}

/** burn(amount) on rETH: pays ETH to msg.sender [R RocketTokenRETH.sol lines 106–123]. */
export function rethBurnCall(rETH: string, amount: bigint): Call {
  if (amount <= 0n) throw new Error('The amount to redeem must be greater than zero.');
  return { to: rETH, value: 0n, data: encodeRethBurn(amount) };
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

function hexBody(result: unknown): string {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result) || result.length % 2 !== 0) {
    throw new Error('The node returned a malformed eth_call result.');
  }
  return result.slice(2);
}

function wordAt(body: string, index: number): bigint {
  const w = body.slice(index * 64, index * 64 + 64);
  if (w.length !== 64) throw new Error('The node returned a short eth_call result.');
  return BigInt('0x' + w);
}

function wordAsIndex(body: string, index: number): number {
  const value = wordAt(body, index);
  if (value > 1_000_000n) throw new Error('The node returned an implausible array offset or length.');
  return Number(value);
}

export function decodeStakingUint(result: unknown): bigint {
  const body = hexBody(result);
  if (body.length !== 64) throw new Error('Expected one 32-byte word.');
  return wordAt(body, 0);
}

export function decodeStakingBool(result: unknown): boolean {
  const value = decodeStakingUint(result);
  if (value > 1n) throw new Error('Expected a boolean word.');
  return value === 1n;
}

export function decodeStakingAddress(result: unknown): string {
  const body = hexBody(result);
  if (body.length !== 64 || !/^0{24}/.test(body)) throw new Error('Expected an address word.');
  return toChecksumAddress(toBytes('0x' + body.slice(24)));
}

/** A returned uint256[] (offset word, length, items). */
export function decodeUint256Array(result: unknown): bigint[] {
  const body = hexBody(result);
  const offset = wordAsIndex(body, 0);
  if (offset % 32 !== 0) throw new Error('Unaligned array offset.');
  const start = offset / 32;
  const length = wordAsIndex(body, start);
  const out: bigint[] = [];
  for (let i = 0; i < length; i++) out.push(wordAt(body, start + 1 + i));
  return out;
}

/** A returned string (offset word, length, bytes). */
export function decodeAbiString(result: unknown): string {
  const body = hexBody(result);
  const offset = wordAsIndex(body, 0);
  const start = (offset / 32) | 0;
  const length = wordAsIndex(body, start);
  const bytes = toBytes('0x' + body.slice((start + 1) * 64, (start + 1) * 64 + length * 2));
  if (bytes.length !== length) throw new Error('Short string in eth_call result.');
  return new TextDecoder().decode(bytes);
}

/** WithdrawalRequestStatus [L WithdrawalQueueBase.sol lines 68–81]. */
export interface WithdrawalRequestStatus {
  requestId: bigint;
  amountOfStETH: bigint;
  amountOfShares: bigint;
  owner: string;
  /** Seconds since the epoch. */
  timestamp: bigint;
  isFinalized: boolean;
  isClaimed: boolean;
}

/**
 * Decodes getWithdrawalStatus's WithdrawalRequestStatus[] (a dynamic array
 * of a static six-word tuple) and pairs each entry with its request id.
 */
export function decodeWithdrawalStatuses(result: unknown, requestIds: readonly bigint[]): WithdrawalRequestStatus[] {
  const body = hexBody(result);
  const start = wordAsIndex(body, 0) / 32;
  const length = wordAsIndex(body, start);
  if (length !== requestIds.length) throw new Error('The queue returned a different number of statuses than requested.');
  const out: WithdrawalRequestStatus[] = [];
  for (let i = 0; i < length; i++) {
    const base = start + 1 + i * 6;
    const ownerWord = body.slice(base * 64 + 128, base * 64 + 192);
    if (!/^0{24}/.test(ownerWord)) throw new Error('Malformed owner in a withdrawal status.');
    const finalized = wordAt(body, base + 4);
    const claimed = wordAt(body, base + 5);
    if (finalized > 1n || claimed > 1n) throw new Error('Malformed flags in a withdrawal status.');
    out.push({
      requestId: requestIds[i]!,
      amountOfStETH: wordAt(body, base),
      amountOfShares: wordAt(body, base + 1),
      owner: toChecksumAddress(toBytes('0x' + ownerWord.slice(24))),
      timestamp: wordAt(body, base + 3),
      isFinalized: finalized === 1n,
      isClaimed: claimed === 1n,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

async function ethCall(node: JsonRpcTransport, to: string, data: Uint8Array): Promise<string> {
  const result = await node('eth_call', [{ to, data: toHex(data) }, 'latest']);
  if (typeof result !== 'string') throw new Error('The node returned no eth_call result.');
  return result;
}

const view = (node: JsonRpcTransport, to: string, signature: string) => ethCall(node, to, encodeFunctionCall(signature, []));

async function hasCode(node: JsonRpcTransport, address: string): Promise<boolean> {
  const code = await node('eth_getCode', [address, 'latest']);
  return typeof code === 'string' && !/^0x0*$/i.test(code);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Checks a Lido deployment on the connected chain before anything is
 * quoted: code at all three addresses, the token symbols, wstETH.stETH()
 * and the Lido locator's withdrawalQueue() pointing at the pinned queue.
 * Returns plain problems; an empty list means the pinned addresses are
 * what the chain says they are.
 */
export async function verifyLidoDeployment(node: JsonRpcTransport, deployment: LidoDeployment): Promise<string[]> {
  const problems: string[] = [];
  const [codeS, codeW, codeQ] = await Promise.all([
    hasCode(node, deployment.stETH),
    hasCode(node, deployment.wstETH),
    hasCode(node, deployment.withdrawalQueue),
  ]);
  if (!codeS) problems.push(`No contract code at Lido's stETH address ${deployment.stETH} on this network.`);
  if (!codeW) problems.push(`No contract code at Lido's wstETH address ${deployment.wstETH} on this network.`);
  if (!codeQ) problems.push(`No contract code at Lido's withdrawal queue ${deployment.withdrawalQueue} on this network.`);
  if (problems.length > 0) return problems;
  const [symS, symW, symQ, wstStETH, locator] = await Promise.all([
    view(node, deployment.stETH, 'symbol()').then(decodeAbiString),
    view(node, deployment.wstETH, 'symbol()').then(decodeAbiString),
    view(node, deployment.withdrawalQueue, 'symbol()').then(decodeAbiString),
    view(node, deployment.wstETH, 'stETH()').then(decodeStakingAddress),
    view(node, deployment.stETH, 'getLidoLocator()').then(decodeStakingAddress),
  ]);
  if (symS !== 'stETH') problems.push(`The stETH contract reports the symbol "${symS}", not "stETH".`);
  if (symW !== 'wstETH') problems.push(`The wstETH contract reports the symbol "${symW}", not "wstETH".`);
  if (symQ !== 'unstETH') problems.push(`The withdrawal queue reports the symbol "${symQ}", not "unstETH".`);
  if (!same(wstStETH, deployment.stETH)) problems.push(`wstETH wraps ${wstStETH}, not Lido's stETH ${deployment.stETH}.`);
  const queue = decodeStakingAddress(await view(node, locator, 'withdrawalQueue()'));
  if (!same(queue, deployment.withdrawalQueue)) {
    problems.push(`Lido's locator names the withdrawal queue ${queue}, not the pinned ${deployment.withdrawalQueue}.`);
  }
  return problems;
}

/** What the wallet reads about a Lido deployment before offering an action. */
export interface LidoState {
  /** Lido.isStakingPaused() [L line 421]. */
  stakingPaused: boolean;
  /** Lido.getCurrentStakeLimit() in wei [L line 431]. */
  currentStakeLimit: bigint;
  /** WithdrawalQueue.isPaused() [L PausableUntil.sol line 51]. */
  queuePaused: boolean;
  lastRequestId: bigint;
  lastFinalizedRequestId: bigint;
  lastCheckpointIndex: bigint;
  /** The accounting oracle's last processed reference slot. */
  oracleLastRefSlot: bigint;
  /** That slot's time, seconds since the epoch: genesisTime + slot × secondsPerSlot (HashConsensus getChainConfig). */
  oracleLastReportTime: bigint;
}

/**
 * Reads a Lido deployment's live state. The oracle's report age comes from
 * the locator's accountingOracle(): getLastProcessingRefSlot() and its
 * HashConsensus getChainConfig() (slotsPerEpoch, secondsPerSlot,
 * genesisTime) — read 2026-10-11: Sepolia's last report refers to
 * 2025-07-02 12:17:24 UTC (so Sepolia stETH earns nothing), Hoodi's to
 * 2026-10-10 12:03:24 UTC.
 */
export async function readLidoState(node: JsonRpcTransport, deployment: LidoDeployment): Promise<LidoState> {
  const [stakingPaused, limit, queuePaused, lastRequestId, lastFinalizedRequestId, lastCheckpointIndex, locator] = await Promise.all([
    view(node, deployment.stETH, 'isStakingPaused()').then(decodeStakingBool),
    view(node, deployment.stETH, 'getCurrentStakeLimit()').then(decodeStakingUint),
    view(node, deployment.withdrawalQueue, 'isPaused()').then(decodeStakingBool),
    view(node, deployment.withdrawalQueue, 'getLastRequestId()').then(decodeStakingUint),
    view(node, deployment.withdrawalQueue, 'getLastFinalizedRequestId()').then(decodeStakingUint),
    view(node, deployment.withdrawalQueue, 'getLastCheckpointIndex()').then(decodeStakingUint),
    view(node, deployment.stETH, 'getLidoLocator()').then(decodeStakingAddress),
  ]);
  const oracle = decodeStakingAddress(await view(node, locator, 'accountingOracle()'));
  const [refSlot, consensus] = await Promise.all([
    view(node, oracle, 'getLastProcessingRefSlot()').then(decodeStakingUint),
    view(node, oracle, 'getConsensusContract()').then(decodeStakingAddress),
  ]);
  const config = hexBody(await view(node, consensus, 'getChainConfig()'));
  const secondsPerSlot = wordAt(config, 1);
  const genesisTime = wordAt(config, 2);
  return {
    stakingPaused,
    currentStakeLimit: limit,
    queuePaused,
    lastRequestId,
    lastFinalizedRequestId,
    lastCheckpointIndex,
    oracleLastRefSlot: refSlot,
    oracleLastReportTime: genesisTime + refSlot * secondsPerSlot,
  };
}

/** Lido balances of one holder. */
export interface LidoBalances {
  /** stETH.balanceOf (rebasing: it changes with each oracle report). */
  stETH: bigint;
  /** stETH.sharesOf: the non-rebasing amount behind the balance. */
  shares: bigint;
  wstETH: bigint;
  /** wstETH.getStETHByWstETH(wstETH balance): its value in stETH now. */
  wstETHInStETH: bigint;
}

export async function readLidoBalances(node: JsonRpcTransport, deployment: LidoDeployment, holder: string): Promise<LidoBalances> {
  const [stETH, shares, wstETH] = await Promise.all([
    ethCall(node, deployment.stETH, encodeErc20BalanceOf(holder)).then(decodeStakingUint),
    ethCall(node, deployment.stETH, encodeFunctionCall('sharesOf(address)', [{ kind: 'address', value: holder }])).then(decodeStakingUint),
    ethCall(node, deployment.wstETH, encodeErc20BalanceOf(holder)).then(decodeStakingUint),
  ]);
  const wstETHInStETH =
    wstETH === 0n
      ? 0n
      : decodeStakingUint(
          await ethCall(node, deployment.wstETH, encodeFunctionCall('getStETHByWstETH(uint256)', [{ kind: 'uint256', value: wstETH }])),
        );
  return { stETH, shares, wstETH, wstETHInStETH };
}

/** The holder's open withdrawal requests (unclaimed ones; claimed requests leave the owner's set). */
export async function readLidoWithdrawalRequests(
  node: JsonRpcTransport,
  deployment: LidoDeployment,
  owner: string,
): Promise<WithdrawalRequestStatus[]> {
  const ids = decodeUint256Array(await ethCall(node, deployment.withdrawalQueue, encodeGetWithdrawalRequests(owner)));
  if (ids.length === 0) return [];
  const statuses = decodeWithdrawalStatuses(await ethCall(node, deployment.withdrawalQueue, encodeGetWithdrawalStatus(ids)), ids);
  return statuses.sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
}

/**
 * The checks the claim makes on the hints findCheckpointHints returned
 * [L lines 298–311, WithdrawalQueueBase.sol 418–452]: ids strictly
 * ascending, one hint per id, every hint in [1, lastCheckpointIndex] (0 is
 * NOT_FOUND: the request is not finalized or the range was wrong), and
 * hints never decreasing (the search for id i starts at hint i−1). Returns
 * a plain problem or null.
 */
export function claimHintsProblem(requestIds: readonly bigint[], hints: readonly bigint[], lastCheckpointIndex: bigint): string | null {
  if (requestIds.length === 0) return 'There is nothing to claim.';
  if (hints.length !== requestIds.length) return 'The withdrawal queue returned a different number of hints than requests.';
  for (let i = 0; i < requestIds.length; i++) {
    if (i > 0 && requestIds[i]! <= requestIds[i - 1]!) return 'Request ids must be strictly ascending.';
    const hint = hints[i]!;
    if (hint === 0n) return `Request ${requestIds[i]} has no checkpoint yet: it is not finalized.`;
    if (hint > lastCheckpointIndex) return `The hint for request ${requestIds[i]} is past the last checkpoint.`;
    if (i > 0 && hint < hints[i - 1]!) return 'The checkpoint hints are out of order.';
  }
  return null;
}

/** A ready claim: which requests, their hints, what each pays, and the call. */
export interface LidoClaimPlan {
  requestIds: bigint[];
  hints: bigint[];
  /** getClaimableEther per request, wei. */
  claimable: bigint[];
  total: bigint;
  lastCheckpointIndex: bigint;
  call: Call;
}

/**
 * Plans claiming every finalized, unclaimed request of `owner`
 * (claimWithdrawals pays msg.sender, and the queue reverts unless
 * msg.sender owns each request [L lines 259–275], so the caller must send
 * from `owner`). The flow is the one the source documents: ids sorted
 * ascending → findCheckpointHints(ids, 1, getLastCheckpointIndex()) →
 * getClaimableEther(ids, hints) → claimWithdrawals(ids, hints). Returns
 * null when nothing is claimable.
 */
export async function planLidoClaim(
  node: JsonRpcTransport,
  deployment: LidoDeployment,
  owner: string,
  requests?: readonly WithdrawalRequestStatus[],
): Promise<LidoClaimPlan | null> {
  const open = requests ?? (await readLidoWithdrawalRequests(node, deployment, owner));
  const ready = open
    .filter((r) => r.isFinalized && !r.isClaimed && same(r.owner, owner))
    .map((r) => r.requestId)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (ready.length === 0) return null;
  const lastCheckpointIndex = decodeStakingUint(await view(node, deployment.withdrawalQueue, 'getLastCheckpointIndex()'));
  if (lastCheckpointIndex === 0n) return null;
  const hints = decodeUint256Array(
    await ethCall(node, deployment.withdrawalQueue, encodeFindCheckpointHints(ready, 1n, lastCheckpointIndex)),
  );
  const problem = claimHintsProblem(ready, hints, lastCheckpointIndex);
  if (problem) throw new Error(problem);
  const claimable = decodeUint256Array(await ethCall(node, deployment.withdrawalQueue, encodeGetClaimableEther(ready, hints)));
  if (claimable.length !== ready.length) throw new Error('The withdrawal queue returned a different number of amounts than requests.');
  if (claimable.some((c) => c === 0n)) throw new Error('A finalized request reports nothing to claim; read the queue again.');
  return {
    requestIds: ready,
    hints,
    claimable,
    total: claimable.reduce((a, b) => a + b, 0n),
    lastCheckpointIndex,
    call: claimWithdrawalsCall(deployment, ready, hints),
  };
}

/** Rocket Pool contracts resolved from RocketStorage. */
export interface RocketPoolContracts {
  storage: string;
  depositPool: string;
  rETH: string;
  settingsDeposit: string;
}

/**
 * Resolves the current deposit pool, rETH and the deposit settings from
 * RocketStorage [R, RD]. Refuses when the registry's rETH differs from the
 * pinned one, when an entry is empty, or when a resolved address holds no
 * code. The deposit pool is resolved at every quote because deposit()
 * refuses from an outdated pool ("Invalid or outdated contract").
 */
export async function resolveRocketPool(node: JsonRpcTransport, deployment: RocketPoolDeployment): Promise<RocketPoolContracts> {
  if (!(await hasCode(node, deployment.storage))) {
    throw new Error(`No contract code at RocketStorage ${deployment.storage} on this network.`);
  }
  const lookup = async (name: string) =>
    decodeStakingAddress(
      await ethCall(node, deployment.storage, encodeFunctionCall('getAddress(bytes32)', [{ kind: 'fixedBytes', value: rocketContractAddressKey(name) }])),
    );
  const [depositPool, rETH, settingsDeposit] = await Promise.all([
    lookup('rocketDepositPool'),
    lookup('rocketTokenRETH'),
    lookup('rocketDAOProtocolSettingsDeposit'),
  ]);
  for (const [name, address] of [
    ['rocketDepositPool', depositPool],
    ['rocketTokenRETH', rETH],
    ['rocketDAOProtocolSettingsDeposit', settingsDeposit],
  ] as const) {
    if (same(address, ZERO_ADDRESS)) throw new Error(`RocketStorage has no ${name} entry on this network.`);
  }
  if (!same(rETH, deployment.rETH)) {
    throw new Error(`RocketStorage names rETH ${rETH}, not the pinned ${deployment.rETH}. Nothing was quoted.`);
  }
  const codes = await Promise.all([hasCode(node, depositPool), hasCode(node, rETH), hasCode(node, settingsDeposit)]);
  if (codes.some((c) => !c)) throw new Error('A Rocket Pool contract named by RocketStorage has no code on this network.');
  return { storage: deployment.storage, depositPool, rETH, settingsDeposit };
}

/** What the wallet reads about Rocket Pool before offering a deposit or a burn. */
export interface RocketPoolState {
  depositEnabled: boolean;
  /** getMinimumDeposit(), wei (0.01 ETH on Hoodi, 2026-10-11). */
  minimumDeposit: bigint;
  /** getDepositFee() as a fraction of 1e18 (0.0005e18 = 0.05% on Hoodi). */
  depositFee: bigint;
  /** depositPool.getMaximumDepositAmount(), wei. */
  maximumDepositAmount: bigint;
  /** rETH.getExchangeRate(): ETH per 1 rETH, 18 decimals. */
  exchangeRate: bigint;
  /** rETH.getTotalCollateral(): ETH available for burns, wei. */
  totalCollateral: bigint;
  /** "network.reth.deposit.delay" in blocks, read from RocketStorage (5,760 on Hoodi). */
  depositDelayBlocks: bigint;
}

export async function readRocketPoolState(node: JsonRpcTransport, contracts: RocketPoolContracts): Promise<RocketPoolState> {
  const [depositEnabled, minimumDeposit, depositFee, maximumDepositAmount, exchangeRate, totalCollateral, depositDelayBlocks] =
    await Promise.all([
      view(node, contracts.settingsDeposit, 'getDepositEnabled()').then(decodeStakingBool),
      view(node, contracts.settingsDeposit, 'getMinimumDeposit()').then(decodeStakingUint),
      view(node, contracts.settingsDeposit, 'getDepositFee()').then(decodeStakingUint),
      view(node, contracts.depositPool, 'getMaximumDepositAmount()').then(decodeStakingUint),
      view(node, contracts.rETH, 'getExchangeRate()').then(decodeStakingUint),
      view(node, contracts.rETH, 'getTotalCollateral()').then(decodeStakingUint),
      ethCall(
        node,
        contracts.storage,
        encodeFunctionCall('getUint(bytes32)', [
          { kind: 'fixedBytes', value: rocketProtocolSettingKey('network', 'network.reth.deposit.delay') },
        ]),
      ).then(decodeStakingUint),
    ]);
  if (depositFee > ROCKET_CALC_BASE) throw new Error('Rocket Pool reports a deposit fee above 100%.');
  return { depositEnabled, minimumDeposit, depositFee, maximumDepositAmount, exchangeRate, totalCollateral, depositDelayBlocks };
}

/** The fee and net amount of a deposit, exactly as deposit() computes them [R lines 146–150]. */
export function rocketDepositSplit(amount: bigint, depositFee: bigint): { fee: bigint; net: bigint } {
  const fee = (amount * depositFee) / ROCKET_CALC_BASE;
  return { fee, net: amount - fee };
}

/** Plain problems with a deposit of `amount`, from the live state (empty = acceptable). */
export function rocketDepositProblems(state: RocketPoolState, amount: bigint): string[] {
  const problems: string[] = [];
  if (!state.depositEnabled) problems.push('Rocket Pool has deposits switched off on this network right now.');
  if (amount < state.minimumDeposit) problems.push('The amount is below Rocket Pool’s minimum deposit.');
  if (amount > state.maximumDepositAmount) problems.push('The amount is above what Rocket Pool’s deposit pool can accept right now.');
  return problems;
}

/** rETH.getRethValue(ethAmount): the rETH a net deposit mints at the current rate. */
export async function readRethValue(node: JsonRpcTransport, rETH: string, ethAmount: bigint): Promise<bigint> {
  return decodeStakingUint(await ethCall(node, rETH, encodeFunctionCall('getRethValue(uint256)', [{ kind: 'uint256', value: ethAmount }])));
}

/** rETH.getEthValue(rethAmount): the ETH a burn pays at the current rate. */
export async function readRethEthValue(node: JsonRpcTransport, rETH: string, rethAmount: bigint): Promise<bigint> {
  return decodeStakingUint(await ethCall(node, rETH, encodeFunctionCall('getEthValue(uint256)', [{ kind: 'uint256', value: rethAmount }])));
}

/** The rETH deposit lock of one holder (see the file comment). */
export interface RethDepositLock {
  /** The stored "user.deposit.block"; 0 when none is recorded. */
  lastDepositBlock: bigint;
  delayBlocks: bigint;
  currentBlock: bigint;
  /** True while transfers and burns from the holder revert. */
  locked: boolean;
  /** First block at which a transfer or burn passes (blocksPassed > delay); null when not locked. */
  unlockBlock: bigint | null;
}

/** Pure rule of RocketTokenRETH._beforeTokenTransfer [R lines 157–172]. */
export function rethLockAt(lastDepositBlock: bigint, delayBlocks: bigint, currentBlock: bigint): RethDepositLock {
  const locked = lastDepositBlock > 0n && currentBlock - lastDepositBlock <= delayBlocks;
  return {
    lastDepositBlock,
    delayBlocks,
    currentBlock,
    locked,
    unlockBlock: locked ? lastDepositBlock + delayBlocks + 1n : null,
  };
}

export async function readRethDepositLock(
  node: JsonRpcTransport,
  storage: string,
  holder: string,
  delayBlocks: bigint,
): Promise<RethDepositLock> {
  const [last, block] = await Promise.all([
    ethCall(node, storage, encodeFunctionCall('getUint(bytes32)', [{ kind: 'fixedBytes', value: rocketUserDepositBlockKey(holder) }])).then(
      decodeStakingUint,
    ),
    node('eth_blockNumber', []).then((b) => {
      if (typeof b !== 'string') throw new Error('The node returned no block number.');
      return BigInt(b);
    }),
  ]);
  return rethLockAt(last, delayBlocks, block);
}

/** Plain problems with burning `amount` rETH (empty = acceptable). */
export function rethBurnProblems(args: {
  amount: bigint;
  balance: bigint;
  ethValue: bigint;
  totalCollateral: bigint;
  lock: RethDepositLock;
}): string[] {
  const problems: string[] = [];
  if (args.amount <= 0n) problems.push('The amount to redeem must be greater than zero.');
  if (args.amount > args.balance) problems.push('The amount is more rETH than this account holds.');
  if (args.ethValue > args.totalCollateral) {
    problems.push('Rocket Pool does not hold enough ETH right now to pay for this amount of rETH.');
  }
  if (args.lock.locked) {
    problems.push(
      `Rocket Pool blocks moving or redeeming rETH for ${args.lock.delayBlocks} blocks after a deposit; this account can redeem from block ${args.lock.unlockBlock}.`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** A token the preview may name (pinned addresses only, never a self-reported symbol). */
export interface StakingPreviewToken {
  address: string;
  symbol: string;
  decimals: number;
  /** True for stETH: balances rebase and transfers can arrive 1–2 wei short. */
  rebasing: boolean;
}

export interface StakeOutcomePreview {
  /** True when the simulated calls succeeded. */
  ok: boolean;
  revertReason?: string;
  /** Native wei leaving the wallet (sum of 'out' native changes). */
  sent: bigint;
  /** Native wei arriving (for burns and claims). */
  receivedNative: bigint;
  /** Known tokens arriving at the wallet, exact base units from the events. */
  received: { token: string; symbol: string; decimals: number; amount: bigint }[];
  /** Known tokens leaving the wallet. */
  spent: { token: string; symbol: string; decimals: number; amount: bigint }[];
  /**
   * True when a rebasing token (stETH) is involved: the amount shown comes
   * from the token's own event and can differ from the real balance change
   * by 1–2 wei, and the balance changes daily afterwards (docs/STAKING.md
   * section 5.3; Lido's integration guide).
   */
  rebasingCaveat: boolean;
  /** Events the decoder could not read (non-zero: the preview may be incomplete). */
  skippedLogs: number;
}

/**
 * Previews what staking calls change for `wallet` with the existing
 * asset-diff simulation (eth_simulateV1 with traceTransfers): ETH out, the
 * stETH / wstETH / rETH in. Only the listed tokens are named; anything
 * else is counted in skippedLogs-like terms by the caller via the full
 * asset-diff preview the confirm screen shows anyway. Throws
 * SimulationUnsupportedError when the endpoint lacks eth_simulateV1.
 */
export async function stakeOutcomePreview(
  node: JsonRpcTransport,
  wallet: string,
  calls: readonly Call[],
  tokens: readonly StakingPreviewToken[],
): Promise<StakeOutcomePreview> {
  const diff = await simulateAssetChanges(
    node,
    calls.map((c) => ({ from: wallet, to: c.to, value: c.value, data: c.data })),
    wallet,
  );
  const failed = diff.calls.find((c) => !c.ok);
  const known = (address: string) => tokens.find((t) => same(t.address, address));
  const received = new Map<string, bigint>();
  const spent = new Map<string, bigint>();
  let sent = 0n;
  let receivedNative = 0n;
  let rebasingCaveat = false;
  for (const change of diff.changes) {
    if (change.type === 'native') {
      if (change.direction === 'out') sent += change.amount;
      if (change.direction === 'in') receivedNative += change.amount;
      continue;
    }
    if (change.type !== 'erc20') continue;
    const token = known(change.token);
    if (!token) continue;
    if (token.rebasing) rebasingCaveat = true;
    const key = token.address.toLowerCase();
    if (change.direction === 'in') received.set(key, (received.get(key) ?? 0n) + change.amount);
    if (change.direction === 'out') spent.set(key, (spent.get(key) ?? 0n) + change.amount);
  }
  const list = (m: Map<string, bigint>) =>
    [...m.entries()].map(([address, amount]) => {
      const t = known(address)!;
      return { token: t.address, symbol: t.symbol, decimals: t.decimals, amount };
    });
  return {
    ok: diff.ok,
    ...(failed?.revertReason ? { revertReason: failed.revertReason } : {}),
    sent,
    receivedNative,
    received: list(received),
    spent: list(spent),
    rebasingCaveat,
    skippedLogs: diff.skippedLogs,
  };
}

/** The tokens of a Lido deployment for the preview (stETH rebases, wstETH does not). */
export function lidoPreviewTokens(deployment: LidoDeployment): StakingPreviewToken[] {
  return [
    { address: deployment.stETH, symbol: 'stETH', decimals: 18, rebasing: true },
    { address: deployment.wstETH, symbol: 'wstETH', decimals: 18, rebasing: false },
  ];
}

/** rETH for the preview (it does not rebase; its value per token changes instead). */
export function rocketPreviewTokens(rETH: string): StakingPreviewToken[] {
  return [{ address: rETH, symbol: 'rETH', decimals: 18, rebasing: false }];
}

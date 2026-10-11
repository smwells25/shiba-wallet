import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, getAddress, keccak256, solidityPacked, toUtf8Bytes } from 'ethers';
import {
  LIDO_DEPLOYMENTS,
  LIDO_MAX_WITHDRAWAL_WEI,
  LIDO_MIN_WITHDRAWAL_WEI,
  ROCKET_POOL_DEPLOYMENTS,
  STAKING_SELECTORS,
  claimHintsProblem,
  claimWithdrawalsCall,
  decodeAbiString,
  decodeUint256Array,
  decodeWithdrawalStatuses,
  encodeClaimWithdrawal,
  encodeClaimWithdrawals,
  encodeFindCheckpointHints,
  encodeGetClaimableEther,
  encodeGetWithdrawalRequests,
  encodeGetWithdrawalStatus,
  encodeLidoSubmit,
  encodeRequestWithdrawals,
  encodeRequestWithdrawalsWstETH,
  encodeRethBurn,
  encodeRocketDeposit,
  encodeWstethUnwrap,
  encodeWstethWrap,
  lidoPreviewTokens,
  lidoStakeCall,
  lidoWithdrawalAmountProblem,
  planLidoClaim,
  readLidoState,
  readLidoWithdrawalRequests,
  readRocketPoolState,
  requestWithdrawalCall,
  resolveRocketPool,
  rethBurnProblems,
  rethLockAt,
  rocketContractAddressKey,
  rocketDepositCall,
  rocketDepositProblems,
  rocketDepositSplit,
  rocketProtocolSettingKey,
  rocketUserDepositBlockKey,
  stakeOutcomePreview,
  verifyLidoDeployment,
  withdrawalApproveCall,
  wstethWrapApproveCall,
  wstethWrapCall,
  type RocketPoolState,
} from '../src/staking.js';
import { toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

/**
 * Staking engine tests (phase 18 item 2). Every encoder is compared byte
 * for byte with ethers 6 (an independent implementation); the selectors are
 * pinned to the values docs/STAKING.md section 4.5 computed from the cited
 * sources; the address tables are compared with the lines of the official
 * pages; and the readers run against JSON-RPC answers captured read-only
 * from Sepolia and Hoodi on 2026-10-11 (test/fixtures/staking-2026-10-11.json).
 */

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/staking-2026-10-11.json', import.meta.url), 'utf8'));
const SEPOLIA = 'eip155:11155111';
const HOODI = 'eip155:560048';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

const lidoAbi = new Interface([
  'function submit(address _referral) payable returns (uint256)',
  'function wrap(uint256 _stETHAmount) returns (uint256)',
  'function unwrap(uint256 _wstETHAmount) returns (uint256)',
  'function requestWithdrawals(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWstETH(uint256[] _amounts, address _owner) returns (uint256[])',
  'function claimWithdrawals(uint256[] _requestIds, uint256[] _hints)',
  'function claimWithdrawal(uint256 _requestId)',
  'function findCheckpointHints(uint256[] _requestIds, uint256 _firstIndex, uint256 _lastIndex) view returns (uint256[])',
  'function getWithdrawalStatus(uint256[] _requestIds) view returns (tuple(uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[])',
  'function getWithdrawalRequests(address _owner) view returns (uint256[])',
  'function getClaimableEther(uint256[] _requestIds, uint256[] _hints) view returns (uint256[])',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const rocketAbi = new Interface(['function deposit() payable', 'function burn(uint256 _rethAmount)']);

/** Replays the captured answers: method and params must match exactly (so the engine's calldata must too). */
function replay(calls: { method: string; params: unknown[]; result: unknown }[], overrides: Record<string, unknown> = {}): JsonRpcTransport {
  const table = new Map<string, unknown>();
  for (const c of calls) table.set(JSON.stringify([c.method, c.params]), c.result);
  return async (method, params) => {
    const key = JSON.stringify([method, params]);
    if (key in overrides) return overrides[key];
    if (!table.has(key)) throw new Error(`fixture has no answer for ${key.slice(0, 200)}`);
    return table.get(key);
  };
}

describe('staking selectors (pinned against ethers and docs/STAKING.md section 4.5)', () => {
  const pinned = {
    lidoSubmit: '0xa1903eab',
    wstethWrap: '0xea598cb0',
    wstethUnwrap: '0xde0e9a3e',
    requestWithdrawals: '0xd6681042',
    requestWithdrawalsWstETH: '0x19aa6257',
    claimWithdrawals: '0xe3afe0a3',
    claimWithdrawal: '0xf8444436',
    rocketDeposit: '0xd0e30db0',
    rethBurn: '0x42966c68',
    approve: '0x095ea7b3',
  } as const;
  it('every selector equals the documented value', () => {
    expect(STAKING_SELECTORS).toEqual(pinned);
  });
  it('every selector equals ethers Interface.getFunction(...).selector', () => {
    expect(lidoAbi.getFunction('submit')!.selector).toBe(pinned.lidoSubmit);
    expect(lidoAbi.getFunction('wrap')!.selector).toBe(pinned.wstethWrap);
    expect(lidoAbi.getFunction('unwrap')!.selector).toBe(pinned.wstethUnwrap);
    expect(lidoAbi.getFunction('requestWithdrawals')!.selector).toBe(pinned.requestWithdrawals);
    expect(lidoAbi.getFunction('requestWithdrawalsWstETH')!.selector).toBe(pinned.requestWithdrawalsWstETH);
    expect(lidoAbi.getFunction('claimWithdrawals')!.selector).toBe(pinned.claimWithdrawals);
    expect(lidoAbi.getFunction('claimWithdrawal')!.selector).toBe(pinned.claimWithdrawal);
    expect(rocketAbi.getFunction('deposit')!.selector).toBe(pinned.rocketDeposit);
    expect(rocketAbi.getFunction('burn')!.selector).toBe(pinned.rethBurn);
    expect(lidoAbi.getFunction('approve')!.selector).toBe(pinned.approve);
  });
});

describe('staking calldata is byte-identical to ethers', () => {
  const ids = [2387n, 2388n, 5268n];
  const hints = [542n, 542n, 1030n];
  it('Lido and wstETH', () => {
    expect(toHex(encodeLidoSubmit())).toBe(lidoAbi.encodeFunctionData('submit', ['0x0000000000000000000000000000000000000000']));
    expect(toHex(encodeLidoSubmit(A))).toBe(lidoAbi.encodeFunctionData('submit', [A]));
    expect(toHex(encodeWstethWrap(10n ** 15n))).toBe(lidoAbi.encodeFunctionData('wrap', [10n ** 15n]));
    expect(toHex(encodeWstethUnwrap((1n << 256n) - 1n))).toBe(lidoAbi.encodeFunctionData('unwrap', [(1n << 256n) - 1n]));
  });
  it('the withdrawal queue (writes and views)', () => {
    expect(toHex(encodeRequestWithdrawals([10n ** 15n], A))).toBe(lidoAbi.encodeFunctionData('requestWithdrawals', [[10n ** 15n], A]));
    expect(toHex(encodeRequestWithdrawals([], A))).toBe(lidoAbi.encodeFunctionData('requestWithdrawals', [[], A]));
    expect(toHex(encodeRequestWithdrawals([1n, 2n, 3n], B))).toBe(lidoAbi.encodeFunctionData('requestWithdrawals', [[1n, 2n, 3n], B]));
    expect(toHex(encodeRequestWithdrawalsWstETH([7n], B))).toBe(lidoAbi.encodeFunctionData('requestWithdrawalsWstETH', [[7n], B]));
    expect(toHex(encodeClaimWithdrawals(ids, hints))).toBe(lidoAbi.encodeFunctionData('claimWithdrawals', [ids, hints]));
    expect(toHex(encodeClaimWithdrawal(5268n))).toBe(lidoAbi.encodeFunctionData('claimWithdrawal', [5268n]));
    expect(toHex(encodeFindCheckpointHints(ids, 1n, 1033n))).toBe(lidoAbi.encodeFunctionData('findCheckpointHints', [ids, 1n, 1033n]));
    expect(toHex(encodeGetWithdrawalStatus(ids))).toBe(lidoAbi.encodeFunctionData('getWithdrawalStatus', [ids]));
    expect(toHex(encodeGetWithdrawalRequests(A))).toBe(lidoAbi.encodeFunctionData('getWithdrawalRequests', [A]));
    expect(toHex(encodeGetClaimableEther(ids, hints))).toBe(lidoAbi.encodeFunctionData('getClaimableEther', [ids, hints]));
  });
  it('Rocket Pool', () => {
    expect(toHex(encodeRocketDeposit())).toBe(rocketAbi.encodeFunctionData('deposit', []));
    expect(toHex(encodeRethBurn(123n))).toBe(rocketAbi.encodeFunctionData('burn', [123n]));
  });
  it('RocketStorage keys equal keccak256(abi.encodePacked(...)) computed with ethers', () => {
    expect(toHex(rocketContractAddressKey('rocketDepositPool'))).toBe(keccak256(solidityPacked(['string', 'string'], ['contract.address', 'rocketDepositPool'])));
    expect(toHex(rocketContractAddressKey('rocketTokenRETH'))).toBe(keccak256(solidityPacked(['string', 'string'], ['contract.address', 'rocketTokenRETH'])));
    expect(toHex(rocketProtocolSettingKey('network', 'network.reth.deposit.delay'))).toBe(
      keccak256(solidityPacked(['bytes32', 'string'], [keccak256(toUtf8Bytes('dao.protocol.setting.network')), 'network.reth.deposit.delay'])),
    );
    expect(toHex(rocketUserDepositBlockKey(A))).toBe(keccak256(solidityPacked(['string', 'address'], ['user.deposit.block', A])));
  });
});

describe('address tables match the official sources', () => {
  // Lines copied from lidofinance/docs 140c583d and rocket-pool/smartnode 8c1dad70.
  const sepoliaMd = [
    '- Lido and stETH token: [`0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af`](https://sepolia.etherscan.io/address/0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af) (proxy)',
    '- wstETH token: [`0xB82381A3fBD3FaFA77B3a7bE693342618240067b`](https://sepolia.etherscan.io/address/0xB82381A3fBD3FaFA77B3a7bE693342618240067b)',
    '- Withdrawal Queue ERC721: [`0x1583C7b3f4C3B008720E6BcE5726336b0aB25fdd`](https://sepolia.etherscan.io/address/0x1583C7b3f4C3B008720E6BcE5726336b0aB25fdd) (proxy)',
  ];
  const hoodiMd = [
    '- Lido and stETH token: [`0x3508A952176b3c15387C97BE809eaffB1982176a`](https://hoodi.etherscan.io/address/0x3508A952176b3c15387C97BE809eaffB1982176a) (proxy)',
    '- wstETH token: [`0x7E99eE3C66636DE415D2d7C880938F2f40f94De4`](https://hoodi.etherscan.io/address/0x7E99eE3C66636DE415D2d7C880938F2f40f94De4)',
    '- Withdrawal Queue ERC721: [`0xfe56573178f1bcdf53F01A6E9977670dcBBD9186`](https://hoodi.etherscan.io/address/0xfe56573178f1bcdf53F01A6E9977670dcBBD9186) (proxy)',
  ];
  const addressIn = (line: string) => /`(0x[0-9a-fA-F]{40})`/.exec(line)![1]!;
  it('Lido Sepolia and Hoodi', () => {
    const s = LIDO_DEPLOYMENTS[SEPOLIA]!;
    expect([s.stETH, s.wstETH, s.withdrawalQueue]).toEqual(sepoliaMd.map(addressIn));
    expect(s.status).toBe('deprecated');
    const h = LIDO_DEPLOYMENTS[HOODI]!;
    expect([h.stETH, h.wstETH, h.withdrawalQueue]).toEqual(hoodiMd.map(addressIn));
    expect(h.status).toBe('active');
  });
  it('Rocket Pool Hoodi', () => {
    const r = ROCKET_POOL_DEPLOYMENTS[HOODI]!;
    expect(r.storage).toBe('0x594Fb75D3dc2DFa0150Ad03F99F97817747dd4E1');
    expect(r.rETH).toBe('0x7322c24752f79c05FFD1E2a6FCB97020C1C264F1');
    expect(ROCKET_POOL_DEPLOYMENTS[SEPOLIA]).toBeUndefined();
  });
  it('every pinned address is EIP-55 checksummed, and no mainnet entry exists', () => {
    for (const d of Object.values(LIDO_DEPLOYMENTS)) for (const a of [d.stETH, d.wstETH, d.withdrawalQueue]) expect(getAddress(a)).toBe(a);
    for (const d of Object.values(ROCKET_POOL_DEPLOYMENTS)) for (const a of [d.storage, d.rETH]) expect(getAddress(a)).toBe(a);
    expect(LIDO_DEPLOYMENTS['eip155:1']).toBeUndefined();
    expect(ROCKET_POOL_DEPLOYMENTS['eip155:1']).toBeUndefined();
  });
});

describe('on-chain checks replayed from the 2026-10-11 capture', () => {
  it('verifyLidoDeployment finds no problem on either network', async () => {
    for (const caip2 of [SEPOLIA, HOODI]) {
      expect(await verifyLidoDeployment(replay(FIXTURE[caip2].calls), LIDO_DEPLOYMENTS[caip2]!)).toEqual([]);
    }
  });
  it('verifyLidoDeployment reports a wrong symbol and a missing contract', async () => {
    const d = LIDO_DEPLOYMENTS[SEPOLIA]!;
    const symbolCall = JSON.stringify(['eth_call', [{ to: d.wstETH, data: '0x95d89b41' }, 'latest']]);
    const fake = AbiCoder.defaultAbiCoder().encode(['string'], ['FAKE']);
    expect(await verifyLidoDeployment(replay(FIXTURE[SEPOLIA].calls, { [symbolCall]: fake }), d)).toEqual([
      'The wstETH contract reports the symbol "FAKE", not "wstETH".',
    ]);
    const noCode = JSON.stringify(['eth_getCode', [d.withdrawalQueue, 'latest']]);
    const problems = await verifyLidoDeployment(replay(FIXTURE[SEPOLIA].calls, { [noCode]: '0x' }), d);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/No contract code at Lido's withdrawal queue/);
  });
  it('readLidoState: Sepolia is paused for withdrawals and its oracle stopped on 2025-07-02', async () => {
    const s = await readLidoState(replay(FIXTURE[SEPOLIA].calls), LIDO_DEPLOYMENTS[SEPOLIA]!);
    expect(s.stakingPaused).toBe(false);
    expect(s.currentStakeLimit).toBe(150_000n * 10n ** 18n);
    expect(s.queuePaused).toBe(true);
    expect(s.lastRequestId).toBe(0n);
    expect(new Date(Number(s.oracleLastReportTime) * 1000).toISOString()).toBe('2025-07-02T12:17:24.000Z');
  });
  it('readLidoState: Hoodi is open and reported on 2026-10-10', async () => {
    const s = await readLidoState(replay(FIXTURE[HOODI].calls), LIDO_DEPLOYMENTS[HOODI]!);
    expect(s.queuePaused).toBe(false);
    expect(s.stakingPaused).toBe(false);
    expect(s.lastFinalizedRequestId).toBe(5320n);
    expect(s.lastCheckpointIndex).toBe(1033n);
    expect(new Date(Number(s.oracleLastReportTime) * 1000).toISOString()).toBe('2026-10-10T12:03:24.000Z');
  });
});

describe('the claim flow against the Hoodi queue (captured read-only)', () => {
  const claim = FIXTURE[HOODI].claim;
  const deployment = LIDO_DEPLOYMENTS[HOODI]!;
  it('readLidoWithdrawalRequests + planLidoClaim reproduce the captured plan', async () => {
    const node = replay(claim.calls);
    const requests = await readLidoWithdrawalRequests(node, deployment, claim.owner);
    expect(requests.map((r) => r.requestId.toString())).toEqual(claim.requests.map((r: { requestId: string }) => r.requestId));
    const plan = await planLidoClaim(node, deployment, getAddress(claim.owner), requests);
    expect(plan).not.toBeNull();
    expect(plan!.requestIds.map(String)).toEqual(claim.plan.requestIds);
    expect(plan!.hints.map(String)).toEqual(claim.plan.hints);
    expect(plan!.claimable.map(String)).toEqual(claim.plan.claimable);
    expect(plan!.total).toBe(BigInt(claim.plan.total));
    expect(toHex(plan!.call.data)).toBe(lidoAbi.encodeFunctionData('claimWithdrawals', [plan!.requestIds, plan!.hints]));
    expect(plan!.call.to).toBe(deployment.withdrawalQueue);
    expect(plan!.call.value).toBe(0n);
  });
  it('the planned claim succeeded as an eth_call from the owner and reverted from another address', () => {
    expect(FIXTURE[HOODI].extra.claimSimulationFromOwner).toBe('0x');
    expect(FIXTURE[HOODI].extra.claimSimulationFromOther).toMatch(/execution reverted/);
  });
  it('a finalized request gets a hint and the first unfinalized one gets NOT_FOUND (0)', () => {
    const hintsCall = FIXTURE[HOODI].extra.calls.find((c: { params: [{ data: string }] }) => c.params[0].data.startsWith('0x62abe3fa'));
    const hints = decodeUint256Array(hintsCall.result);
    expect(hints).toEqual([1033n, 0n]);
    expect(claimHintsProblem([5320n, 5321n], hints, 1033n)).toMatch(/not finalized/);
    expect(claimHintsProblem([5320n], [1033n], 1033n)).toBeNull();
  });
  it('claimHintsProblem refuses every malformed answer', () => {
    expect(claimHintsProblem([], [], 5n)).toMatch(/nothing to claim/);
    expect(claimHintsProblem([1n, 2n], [1n], 5n)).toMatch(/different number/);
    expect(claimHintsProblem([2n, 1n], [1n, 1n], 5n)).toMatch(/strictly ascending/);
    expect(claimHintsProblem([1n, 1n], [1n, 1n], 5n)).toMatch(/strictly ascending/);
    expect(claimHintsProblem([1n], [6n], 5n)).toMatch(/past the last checkpoint/);
    expect(claimHintsProblem([1n, 2n], [3n, 2n], 5n)).toMatch(/out of order/);
  });
  it('a pending request is not claimed; no finalized request means no plan', async () => {
    const pending = [
      { requestId: 9n, amountOfStETH: 1n, amountOfShares: 1n, owner: getAddress(A), timestamp: 1n, isFinalized: false, isClaimed: false },
      { requestId: 8n, amountOfStETH: 1n, amountOfShares: 1n, owner: getAddress(A), timestamp: 1n, isFinalized: true, isClaimed: true },
    ];
    const never: JsonRpcTransport = async () => {
      throw new Error('no read expected');
    };
    expect(await planLidoClaim(never, deployment, getAddress(A), pending)).toBeNull();
  });
  it('decodeWithdrawalStatuses matches ethers for the status tuple array', () => {
    const encoded = lidoAbi.encodeFunctionResult('getWithdrawalStatus', [
      [
        [5n, 4n, A, 1700000000n, true, false],
        [7n, 6n, B, 1700000001n, false, false],
      ],
    ]);
    const decoded = decodeWithdrawalStatuses(encoded, [11n, 12n]);
    expect(decoded).toEqual([
      { requestId: 11n, amountOfStETH: 5n, amountOfShares: 4n, owner: getAddress(A), timestamp: 1700000000n, isFinalized: true, isClaimed: false },
      { requestId: 12n, amountOfStETH: 7n, amountOfShares: 6n, owner: getAddress(B), timestamp: 1700000001n, isFinalized: false, isClaimed: false },
    ]);
    expect(() => decodeWithdrawalStatuses(encoded, [11n])).toThrow(/different number/);
    expect(decodeUint256Array(lidoAbi.encodeFunctionResult('getWithdrawalRequests', [[3n, 1n]]))).toEqual([3n, 1n]);
    expect(decodeAbiString(AbiCoder.defaultAbiCoder().encode(['string'], ['unstETH']))).toBe('unstETH');
    expect(() => decodeUint256Array('0x12')).toThrow();
  });
});

describe('call builders', () => {
  const lido = LIDO_DEPLOYMENTS[SEPOLIA]!;
  it('stake to stETH is submit(address(0)) with value; to wstETH is a plain transfer', () => {
    const s = lidoStakeCall(lido, 10n ** 15n);
    expect(s.to).toBe(lido.stETH);
    expect(s.value).toBe(10n ** 15n);
    expect(toHex(s.data)).toBe('0xa1903eab' + '0'.repeat(64));
    const w = lidoStakeCall(lido, 10n ** 15n, 'wstETH');
    expect(w.to).toBe(lido.wstETH);
    expect(w.data.length).toBe(0);
    expect(() => lidoStakeCall(lido, 0n)).toThrow(/ZERO_DEPOSIT/);
  });
  it('wrap needs an exact approval to wstETH; requests an exact approval to the queue', () => {
    const approve = wstethWrapApproveCall(lido, 5n);
    expect(approve.to).toBe(lido.stETH);
    expect(toHex(approve.data)).toBe(lidoAbi.encodeFunctionData('approve', [lido.wstETH, 5n]));
    expect(toHex(wstethWrapCall(lido, 5n).data)).toBe(lidoAbi.encodeFunctionData('wrap', [5n]));
    expect(toHex(withdrawalApproveCall(lido, 500n).data)).toBe(lidoAbi.encodeFunctionData('approve', [lido.withdrawalQueue, 500n]));
    const req = requestWithdrawalCall(lido, 500n, A);
    expect(req.to).toBe(lido.withdrawalQueue);
    expect(toHex(req.data)).toBe(lidoAbi.encodeFunctionData('requestWithdrawals', [[500n], A]));
  });
  it('withdrawal bounds are the contract constants (100 wei to 1,000 stETH)', () => {
    expect(LIDO_MIN_WITHDRAWAL_WEI).toBe(100n);
    expect(LIDO_MAX_WITHDRAWAL_WEI).toBe(1000n * 10n ** 18n);
    expect(lidoWithdrawalAmountProblem(99n)).toMatch(/at least 100 wei/);
    expect(lidoWithdrawalAmountProblem(100n)).toBeNull();
    expect(lidoWithdrawalAmountProblem(LIDO_MAX_WITHDRAWAL_WEI)).toBeNull();
    expect(lidoWithdrawalAmountProblem(LIDO_MAX_WITHDRAWAL_WEI + 1n)).toMatch(/at most 1,000/);
    expect(() => requestWithdrawalCall(lido, 99n, A)).toThrow(/at least 100 wei/);
    expect(() => requestWithdrawalCall(lido, 100n, '0x0000000000000000000000000000000000000000')).toThrow(/owner/);
    expect(() => claimWithdrawalsCall(lido, [1n], [])).toThrow(/one checkpoint hint/);
  });
  it('Rocket Pool deposit and burn', () => {
    const d = rocketDepositCall(B, 10n ** 16n);
    expect(d.to).toBe(B);
    expect(d.value).toBe(10n ** 16n);
    expect(toHex(d.data)).toBe('0xd0e30db0');
    expect(() => rocketDepositCall(B, 0n)).toThrow();
  });
});

describe('Rocket Pool reads replayed from the Hoodi capture', () => {
  const rp = FIXTURE[HOODI].rocketPool;
  it('resolveRocketPool resolves the deposit pool and agrees with the pinned rETH', async () => {
    const c = await resolveRocketPool(replay(rp.calls), ROCKET_POOL_DEPLOYMENTS[HOODI]!);
    expect(c).toEqual(rp.contracts);
    expect(c.depositPool).toBe('0x425E6f83e27f1676AD78BC39dA79C2C7b33d3Fd8');
  });
  it('resolveRocketPool refuses a registry whose rETH differs from the pinned one', async () => {
    await expect(
      resolveRocketPool(replay(rp.calls), { ...ROCKET_POOL_DEPLOYMENTS[HOODI]!, rETH: '0x' + '12'.repeat(20) }),
    ).rejects.toThrow(/not the pinned/);
  });
  it('readRocketPoolState: deposits on, minimum 0.01 ETH, fee 0.05%, delay 5,760 blocks', async () => {
    const c = await resolveRocketPool(replay(rp.calls), ROCKET_POOL_DEPLOYMENTS[HOODI]!);
    const s = await readRocketPoolState(replay(rp.calls), c);
    expect(s.depositEnabled).toBe(true);
    expect(s.minimumDeposit).toBe(10n ** 16n);
    expect(s.depositFee).toBe(5n * 10n ** 14n);
    expect(s.depositDelayBlocks).toBe(5760n);
    expect(s.exchangeRate).toBe(BigInt(rp.state.exchangeRate));
  });
  it('deposit split, problems, and the deposit lock rule', () => {
    expect(rocketDepositSplit(10n ** 16n, 5n * 10n ** 14n)).toEqual({ fee: 5n * 10n ** 12n, net: 10n ** 16n - 5n * 10n ** 12n });
    const state: RocketPoolState = {
      depositEnabled: true,
      minimumDeposit: 10n ** 16n,
      depositFee: 5n * 10n ** 14n,
      maximumDepositAmount: 10n ** 18n,
      exchangeRate: 10n ** 18n,
      totalCollateral: 10n ** 18n,
      depositDelayBlocks: 5760n,
    };
    expect(rocketDepositProblems(state, 10n ** 16n)).toEqual([]);
    expect(rocketDepositProblems(state, 10n ** 16n - 1n)).toEqual(['The amount is below Rocket Pool’s minimum deposit.']);
    expect(rocketDepositProblems({ ...state, depositEnabled: false }, 10n ** 16n)[0]).toMatch(/switched off/);
    expect(rocketDepositProblems(state, 10n ** 18n + 1n)[0]).toMatch(/above what/);
    // blocksPassed > delay passes: last 100, delay 5760 → locked through block 5860, free at 5861.
    expect(rethLockAt(100n, 5760n, 5860n)).toMatchObject({ locked: true, unlockBlock: 5861n });
    expect(rethLockAt(100n, 5760n, 5861n)).toMatchObject({ locked: false, unlockBlock: null });
    expect(rethLockAt(0n, 5760n, 10n)).toMatchObject({ locked: false });
    const lock = rethLockAt(100n, 5760n, 200n);
    expect(rethBurnProblems({ amount: 1n, balance: 1n, ethValue: 1n, totalCollateral: 1n, lock })[0]).toMatch(/from block 5861/);
    expect(rethBurnProblems({ amount: 2n, balance: 1n, ethValue: 5n, totalCollateral: 1n, lock: rethLockAt(0n, 5760n, 1n) })).toEqual([
      'The amount is more rETH than this account holds.',
      'Rocket Pool does not hold enough ETH right now to pay for this amount of rETH.',
    ]);
  });
});

describe('stakeOutcomePreview over the asset-diff simulation', () => {
  const lido = LIDO_DEPLOYMENTS[SEPOLIA]!;
  const wallet = getAddress(A);
  const pad = (a: string) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  const transferTopic = keccak256(toUtf8Bytes('Transfer(address,address,uint256)'));
  const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
  const simulation = (logs: unknown[], status = '0x1') => async (method: string) => {
    if (method !== 'eth_simulateV1') throw new Error(method);
    return [{ calls: [{ status, returnData: '0x', gasUsed: '0x1', logs }] }];
  };
  it('names the stETH minted, the ETH sent, and flags the rebasing caveat', async () => {
    const logs = [
      { address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', topics: [transferTopic, pad(wallet), pad(lido.stETH)], data: word(10n ** 15n) },
      { address: lido.stETH, topics: [transferTopic, pad('0x0000000000000000000000000000000000000000'), pad(wallet)], data: word(10n ** 15n - 1n) },
      { address: B, topics: [transferTopic, pad('0x0000000000000000000000000000000000000000'), pad(wallet)], data: word(5n) },
    ];
    const p = await stakeOutcomePreview(simulation(logs), wallet, [lidoStakeCall(lido, 10n ** 15n)], lidoPreviewTokens(lido));
    expect(p.ok).toBe(true);
    expect(p.sent).toBe(10n ** 15n);
    expect(p.received).toEqual([{ token: lido.stETH, symbol: 'stETH', decimals: 18, amount: 10n ** 15n - 1n }]);
    expect(p.rebasingCaveat).toBe(true);
  });
  it('a wstETH receipt carries no rebasing caveat; a revert is reported', async () => {
    const logs = [{ address: lido.wstETH, topics: [transferTopic, pad('0x0000000000000000000000000000000000000000'), pad(wallet)], data: word(9n) }];
    const p = await stakeOutcomePreview(simulation(logs), wallet, [lidoStakeCall(lido, 10n, 'wstETH')], lidoPreviewTokens(lido));
    expect(p.received[0]!.symbol).toBe('wstETH');
    expect(p.rebasingCaveat).toBe(false);
    const failing = async () => [{ calls: [{ status: '0x0', returnData: '0x', gasUsed: '0x1', logs: [], error: { code: 3, message: 'execution reverted: STAKING_PAUSED' } }] }];
    const r = await stakeOutcomePreview(failing, wallet, [lidoStakeCall(lido, 10n)], lidoPreviewTokens(lido));
    expect(r.ok).toBe(false);
    expect(r.received).toEqual([]);
  });
});

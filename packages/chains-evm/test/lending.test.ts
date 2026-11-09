import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, getAddress, id } from 'ethers';
import {
  AAVE_CUSTOM_ERRORS,
  AAVE_ERROR_SENTENCES,
  AAVE_RAY,
  AAVE_WITHDRAW_ALL,
  LENDING_DEPLOYMENTS,
  LENDING_EVENT_TOPICS,
  LENDING_REFUSALS,
  LENDING_SELECTORS,
  LendingStateError,
  aaveRayMul,
  checkLendingCalls,
  decodeLendingReceipt,
  describeAaveError,
  encodeAaveSupply,
  encodeAaveWithdraw,
  formatLendingUnits,
  lendingApproveCall,
  lendingDeploymentFor,
  lendingSupplyCall,
  lendingWithdrawCall,
  quoteLendingSupply,
  quoteLendingWithdraw,
  readLendingPosition,
  readReserveState,
  type ReserveState,
} from '../src/lending.js';
import { toBytes, toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

/**
 * Lending engine tests (phase 26 item 2). The encoders, selectors and event
 * topics are compared with ethers 6 (an independent implementation); the
 * deployment table with the address book's lines (src/lending.ts header,
 * [B]); the readers run against JSON-RPC answers recorded read-only on
 * Arbitrum Sepolia on 2026-11-09
 * (test/fixtures/lending-arbitrum-sepolia-2026-11-09.json).
 */

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/lending-arbitrum-sepolia-2026-11-09.json', import.meta.url), 'utf8'));
const ARB = 'eip155:421614';
const D = LENDING_DEPLOYMENTS[ARB]!;
const BLOCK = BigInt(FIXTURE.block);
const TAG = '0x' + BLOCK.toString(16);
const DEV = '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C';
const OTHER = '0x2222222222222222222222222222222222222222';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const pool = new Interface([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
  'event ReserveUsedAsCollateralEnabled(address indexed reserve, address indexed user)',
  'event ReserveUsedAsCollateralDisabled(address indexed reserve, address indexed user)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const reads = new Interface([
  'function getPool() view returns (address)',
  'function getPoolDataProvider() view returns (address)',
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function POOL_REVISION() view returns (uint256)',
  'function getReserveTokensAddresses(address) view returns (address,address,address)',
  'function getReserveConfigurationData(address) view returns (uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)',
  'function getReserveCaps(address) view returns (uint256,uint256)',
  'function getPaused(address) view returns (bool)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function decimals() view returns (uint8)',
]);
const coder = AbiCoder.defaultAbiCoder();

/** Replays the recorded answers; method and params must match exactly (so the engine's calldata must too). */
function replay(overrides: Record<string, unknown> = {}): JsonRpcTransport {
  const table = new Map<string, unknown>();
  for (const c of FIXTURE.calls) table.set(JSON.stringify([c.method, c.params]), c.result);
  return async (method, params) => {
    const key = JSON.stringify([method, params]);
    if (key in overrides) return overrides[key];
    if (!table.has(key)) throw new Error(`fixture has no answer for ${key.slice(0, 200)}`);
    return table.get(key);
  };
}
const callKey = (to: string, data: string) => JSON.stringify(['eth_call', [{ to, data }, TAG]]);
const word = (v: bigint | string) => coder.encode([typeof v === 'string' ? 'address' : 'uint256'], [v]);

function state(over: Partial<ReserveState> = {}): ReserveState {
  return {
    chain: ARB,
    block: BLOCK,
    active: true,
    frozen: false,
    paused: false,
    decimals: 6,
    supplyCap: 10_500_000n,
    supplyCapBaseUnits: 10_500_000_000_000n,
    totalAToken: 5_539_443_671_059n,
    accruedToTreasuryScaled: 33_356_510_761n,
    normalizedIncome: 1_123_074_306_002_958_775_180_660_175n,
    suppliedForCap: 5_576_905_511_233n,
    availableLiquidity: 855_825_783_201n,
    aToken: D.aToken.address,
    aTokenDecimals: 6,
    usageAsCollateralEnabled: true,
    borrowingEnabled: true,
    liquidityRateRay: 0n,
    ...over,
  };
}

describe('selectors and topics (pinned against ethers)', () => {
  it('pins the three call selectors', () => {
    expect(LENDING_SELECTORS).toEqual({ supply: '0x617ba037', withdraw: '0x69328dec', approve: '0x095ea7b3' });
    expect(LENDING_SELECTORS.supply).toBe(pool.getFunction('supply')!.selector);
    expect(LENDING_SELECTORS.withdraw).toBe(pool.getFunction('withdraw')!.selector);
  });
  it('pins the event topics', () => {
    expect(LENDING_EVENT_TOPICS.supply).toBe(pool.getEvent('Supply')!.topicHash);
    expect(LENDING_EVENT_TOPICS.withdraw).toBe(pool.getEvent('Withdraw')!.topicHash);
    expect(LENDING_EVENT_TOPICS.collateralEnabled).toBe(id('ReserveUsedAsCollateralEnabled(address,address)'));
    expect(LENDING_EVENT_TOPICS.collateralEnabled.slice(0, 10)).toBe('0x00058a56');
    expect(LENDING_EVENT_TOPICS.collateralDisabled).toBe(pool.getEvent('ReserveUsedAsCollateralDisabled')!.topicHash);
  });
  it('maps the aave-v3-origin custom errors to the deployed numeric codes', () => {
    for (const [sig, code] of [
      ['InvalidAmount()', '26'],
      ['ReserveInactive()', '27'],
      ['ReserveFrozen()', '28'],
      ['ReservePaused()', '29'],
      ['NotEnoughAvailableUserBalance()', '32'],
      ['SupplyCapExceeded()', '51'],
    ]) {
      expect(AAVE_CUSTOM_ERRORS[id(sig!).slice(0, 10)]).toBe(code);
    }
  });
});

describe('the deployment table', () => {
  it('pins the address book lines (d4c2848e src/AaveV3ArbitrumSepolia.sol)', () => {
    expect(D.addressesProvider).toBe('0xB25a5D144626a0D488e52AE717A051a2E9997076');
    expect(D.pool).toBe('0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff');
    expect(D.poolImplementation).toBe('0x82405D1a189bd6cE4667809C35B37fBE136A4c5B');
    expect(D.dataProvider).toBe('0x12373B5085e3b42D42C1D4ABF3B3Cf4Df0E0Fa01');
    expect(D.oracle).toBe('0xEf95A6B9e88Bd509Fd67BA741cf2b263DaC65c00');
    expect(D.asset).toEqual({ address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', symbol: 'USDC', decimals: 6 });
    expect(D.aToken).toEqual({ address: '0x460b97BD498E1157530AEb3086301d5225b91216', symbol: 'aArbSepUSDC', decimals: 6 });
    for (const a of [D.addressesProvider, D.pool, D.poolImplementation, D.dataProvider, D.oracle, D.asset.address, D.aToken.address]) {
      expect(getAddress(a)).toBe(a);
    }
  });
  it('knows only Arbitrum Sepolia', () => {
    expect(Object.keys(LENDING_DEPLOYMENTS)).toEqual([ARB]);
    expect(lendingDeploymentFor('eip155:1')).toBeNull();
    expect(lendingDeploymentFor('eip155:11155111')).toBeNull();
  });
});

describe('encoders and call builders (byte for byte against ethers)', () => {
  it('encodes supply and withdraw', () => {
    for (const amount of [1n, 100_000n, 10n ** 18n, (1n << 255n) + 7n]) {
      expect(toHex(encodeAaveSupply(D.asset.address, amount, DEV))).toBe(pool.encodeFunctionData('supply', [D.asset.address, amount, DEV, 0]));
      expect(toHex(encodeAaveSupply(D.asset.address, amount, OTHER, 65535n))).toBe(pool.encodeFunctionData('supply', [D.asset.address, amount, OTHER, 65535]));
      expect(toHex(encodeAaveWithdraw(D.asset.address, amount, DEV))).toBe(pool.encodeFunctionData('withdraw', [D.asset.address, amount, DEV]));
    }
    expect(() => encodeAaveSupply(D.asset.address, 1n, DEV, 65536n)).toThrow(/16 bits/);
  });
  it('builds exact calls credited and paid to the account only', () => {
    expect(lendingApproveCall(D, 100_000n)).toEqual({ to: D.asset.address, value: 0n, data: toBytes(pool.encodeFunctionData('approve', [D.pool, 100_000n])) });
    expect(lendingSupplyCall(D, 100_000n, DEV)).toEqual({ to: D.pool, value: 0n, data: toBytes(pool.encodeFunctionData('supply', [D.asset.address, 100_000n, DEV, 0])) });
    expect(toHex(lendingWithdrawCall(D, 'all', DEV).data)).toBe(pool.encodeFunctionData('withdraw', [D.asset.address, AAVE_WITHDRAW_ALL, DEV]));
    expect(AAVE_WITHDRAW_ALL).toBe(2n ** 256n - 1n);
    expect(() => lendingApproveCall(D, 0n)).toThrow();
    expect(() => lendingApproveCall(D, AAVE_WITHDRAW_ALL)).toThrow(/unlimited/);
    expect(() => lendingSupplyCall(D, 0n, DEV)).toThrow();
    expect(() => lendingSupplyCall(D, 1n, 'not an address')).toThrow();
    expect(() => lendingWithdrawCall(D, 0n, DEV)).toThrow();
  });
});

describe('readReserveState replayed from the 2026-11-09 recording', () => {
  it('reads the reserve at the pinned block', async () => {
    const s = await readReserveState(replay(), D, { blockTag: BLOCK });
    expect(s.block).toBe(BLOCK);
    expect(s).toMatchObject({ active: true, frozen: false, paused: false, decimals: 6, supplyCap: 10_500_000n, aToken: D.aToken.address, aTokenDecimals: 6 });
    expect(s.supplyCapBaseUnits).toBe(10_500_000n * 10n ** 6n);
    expect(s.totalAToken.toString()).toBe(FIXTURE.state.totalAToken);
    expect(s.availableLiquidity.toString()).toBe(FIXTURE.state.availableLiquidity);
    expect(s.suppliedForCap).toBe(s.totalAToken + aaveRayMul(s.accruedToTreasuryScaled, s.normalizedIncome));
    expect(s.suppliedForCap.toString()).toBe(FIXTURE.state.suppliedForCap);
  });
  it('reads the latest block when none is given', async () => {
    const s = await readReserveState(replay({ [JSON.stringify(['eth_blockNumber', []])]: TAG }), D);
    expect(s.block).toBe(BLOCK);
  });
  it('reads the position', async () => {
    const p = await readLendingPosition(replay(), D, DEV, { blockTag: BLOCK });
    expect(p).toEqual({ account: DEV, block: BLOCK, supplied: 0n, walletBalance: 38_000_000n });
  });
  const refuse = async (overrides: Record<string, unknown>, pattern: RegExp) => {
    const err = await readReserveState(replay(overrides), D, { blockTag: BLOCK }).catch((e) => e);
    expect(err).toBeInstanceOf(LendingStateError);
    expect(err.message).toMatch(pattern);
  };
  it('refuses a replaced Pool implementation', () =>
    refuse({ [JSON.stringify(['eth_getStorageAt', [D.pool, IMPL_SLOT, TAG]])]: word(OTHER) }, /now runs the implementation 0x2222.*not the 0x82405D1a/));
  it('refuses a provider naming another Pool', () =>
    refuse({ [callKey(D.addressesProvider, reads.encodeFunctionData('getPool'))]: word(OTHER) }, /names the Pool 0x2222/));
  it('refuses a provider naming another data provider', () =>
    refuse({ [callKey(D.addressesProvider, reads.encodeFunctionData('getPoolDataProvider'))]: word(OTHER) }, /names the data provider 0x2222/));
  it('refuses a Pool naming another provider', () =>
    refuse({ [callKey(D.pool, reads.encodeFunctionData('ADDRESSES_PROVIDER'))]: word(OTHER) }, /names the provider 0x2222/));
  it('refuses another revision', () => refuse({ [callKey(D.pool, reads.encodeFunctionData('POOL_REVISION'))]: word(4n) }, /revision 4, not 3/));
  it('refuses another aToken', () =>
    refuse(
      { [callKey(D.dataProvider, reads.encodeFunctionData('getReserveTokensAddresses', [D.asset.address]))]: coder.encode(['address', 'address', 'address'], [OTHER, OTHER, OTHER]) },
      /uses the aToken 0x2222/,
    ));
  it('refuses an aToken holding another underlying', () =>
    refuse({ [callKey(D.aToken.address, reads.encodeFunctionData('UNDERLYING_ASSET_ADDRESS'))]: word(OTHER) }, /holds 0x2222/));
  it('refuses disagreeing decimals', () => refuse({ [callKey(D.aToken.address, reads.encodeFunctionData('decimals'))]: word(18n) }, /decimals disagree/));
  it('refuses missing code', () => refuse({ [JSON.stringify(['eth_getCode', [D.pool, TAG]])]: '0x' }, /No contract code at Aave's Pool/));
  it('refuses a malformed answer', async () => {
    const err = await readReserveState(replay({ [callKey(D.dataProvider, reads.encodeFunctionData('getPaused', [D.asset.address]))]: word(2n) }), D, { blockTag: BLOCK }).catch((e) => e);
    expect(err.message).toMatch(/boolean/);
  });
  it('reads paused and frozen flags', async () => {
    const cfg = reads.encodeFunctionData('getReserveConfigurationData', [D.asset.address]);
    const frozenCfg = coder.encode(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool', 'bool', 'bool', 'bool', 'bool'], [6, 7700, 8000, 10500, 1000, true, true, false, true, true]);
    const s = await readReserveState(replay({ [callKey(D.dataProvider, cfg)]: frozenCfg, [callKey(D.dataProvider, reads.encodeFunctionData('getPaused', [D.asset.address]))]: word(1n) }), D, { blockTag: BLOCK });
    expect(s.frozen).toBe(true);
    expect(s.paused).toBe(true);
  });
});

describe('quotes and refusals', () => {
  it('quotes a supply as an exact approve then the supply', () => {
    const q = quoteLendingSupply({ deployment: D, state: state(), account: DEV, amount: 100_000n, walletBalance: 38_000_000n });
    expect(q.refusals).toEqual([]);
    expect(q.calls).toEqual([lendingApproveCall(D, 100_000n), lendingSupplyCall(D, 100_000n, DEV)]);
    expect(checkLendingCalls(q.calls, D, DEV)).toEqual([]);
  });
  const supply = (over: Partial<ReserveState>, amount: bigint, extra: { walletBalance?: bigint; onBehalfOf?: string } = {}) =>
    quoteLendingSupply({ deployment: D, state: state(over), account: DEV, amount, walletBalance: extra.walletBalance ?? 38_000_000n, onBehalfOf: extra.onBehalfOf });
  it('refuses a frozen, paused or inactive reserve', () => {
    expect(supply({ frozen: true }, 1n).refusals).toEqual([LENDING_REFUSALS.frozen('USDC', 'Arbitrum Sepolia')]);
    expect(supply({ paused: true }, 1n).refusals).toEqual([LENDING_REFUSALS.paused('USDC', 'Arbitrum Sepolia')]);
    expect(supply({ active: false }, 1n).refusals).toEqual([LENDING_REFUSALS.inactive('USDC', 'Arbitrum Sepolia')]);
    expect(supply({ frozen: true }, 1n).calls).toEqual([]);
  });
  it('refuses 0, more than the balance and another beneficiary', () => {
    expect(supply({}, 0n).refusals).toEqual([LENDING_REFUSALS.zero]);
    expect(supply({}, 38_000_001n).refusals).toEqual([
      "This account holds 38 USDC, less than the 38.000001 USDC to supply. Nothing was signed.",
    ]);
    expect(supply({}, 1n, { onBehalfOf: OTHER }).refusals).toEqual([LENDING_REFUSALS.supplyRecipient(OTHER)]);
    expect(supply({}, 1n, { onBehalfOf: DEV.toLowerCase() }).refusals).toEqual([]);
  });
  it('refuses a supply over the cap, with the room left', () => {
    const near = state({ suppliedForCap: 10_499_999_900_000n });
    expect(quoteLendingSupply({ deployment: D, state: near, account: DEV, amount: 100_000n, walletBalance: 38_000_000n }).refusals).toEqual([]);
    expect(quoteLendingSupply({ deployment: D, state: near, account: DEV, amount: 100_001n, walletBalance: 38_000_000n }).refusals).toEqual([
      "Aave's USDC reserve on Arbitrum Sepolia would go over its supply cap of 10500000 USDC: about 10499999.9 USDC is supplied already, so at most 0.1 USDC more can be supplied now. Nothing was signed.",
    ]);
    expect(supply({ supplyCap: 0n, supplyCapBaseUnits: null, suppliedForCap: 10n ** 20n }, 1n).refusals).toEqual([]);
  });
  it('refuses a state read for another network', () => {
    expect(supply({ chain: 'eip155:11155420' }, 1n).refusals).toEqual([LENDING_REFUSALS.wrongState]);
  });
  const withdraw = (over: Partial<ReserveState>, amount: bigint | 'all', supplied: bigint, to?: string) =>
    quoteLendingWithdraw({ deployment: D, state: state(over), account: DEV, amount, supplied, to });
  it('quotes a withdrawal of part or all, paid to the account', () => {
    const part = withdraw({}, 40_000n, 100_000n);
    expect(part.calls).toEqual([lendingWithdrawCall(D, 40_000n, DEV)]);
    const all = withdraw({}, 'all', 100_002n);
    expect(all).toMatchObject({ amount: 100_002n, all: true, refusals: [] });
    expect(all.calls).toEqual([lendingWithdrawCall(D, 'all', DEV)]);
    expect(checkLendingCalls(all.calls, D, DEV)).toEqual([]);
  });
  it('allows a withdrawal from a frozen reserve but not from a paused one', () => {
    expect(withdraw({ frozen: true }, 'all', 1n).refusals).toEqual([]);
    expect(withdraw({ paused: true }, 'all', 1n).refusals).toEqual([LENDING_REFUSALS.paused('USDC', 'Arbitrum Sepolia')]);
  });
  it('refuses no position, more than the position, more than the liquidity, and another recipient', () => {
    expect(withdraw({}, 'all', 0n).refusals).toEqual([LENDING_REFUSALS.noPosition('USDC', 'Arbitrum Sepolia')]);
    expect(withdraw({}, 5n, 0n).refusals).toEqual([LENDING_REFUSALS.noPosition('USDC', 'Arbitrum Sepolia')]);
    expect(withdraw({}, 0n, 5n).refusals).toEqual([LENDING_REFUSALS.zero]);
    expect(withdraw({}, 100_001n, 100_000n).refusals).toEqual([
      'This account has 0.1 USDC supplied to Aave (its aArbSepUSDC balance), less than the 0.100001 USDC to withdraw. Nothing was signed.',
    ]);
    expect(withdraw({ availableLiquidity: 50_000n }, 'all', 100_000n).refusals).toEqual([
      "Aave's USDC pool on Arbitrum Sepolia holds only 0.05 USDC that can be withdrawn right now (the rest is lent out), less than the 0.1 USDC asked. Withdraw less, or try again later. Nothing was signed.",
    ]);
    expect(withdraw({}, 'all', 1n, OTHER).refusals).toEqual([LENDING_REFUSALS.withdrawRecipient(OTHER)]);
  });
});

describe('checkLendingCalls (the check before signing)', () => {
  const ok = [lendingApproveCall(D, 100_000n), lendingSupplyCall(D, 100_000n, DEV)];
  const tamper = (data: string) => toBytes(data);
  it('accepts the shapes the wallet builds', () => {
    expect(checkLendingCalls(ok, D, DEV)).toEqual([]);
    expect(checkLendingCalls([ok[0]!], D, DEV)).toEqual([]);
    expect(checkLendingCalls([ok[1]!], D, DEV)).toEqual([]);
    expect(checkLendingCalls([lendingWithdrawCall(D, 5n, DEV)], D, DEV)).toEqual([]);
  });
  it('refuses every changed word', () => {
    const sup = (a: string, amt: bigint, who: string, ref: number) => ({ to: D.pool, value: 0n, data: tamper(pool.encodeFunctionData('supply', [a, amt, who, ref])) });
    expect(checkLendingCalls([sup(D.asset.address, 1n, OTHER, 0)], D, DEV)).toEqual([LENDING_REFUSALS.supplyRecipient(OTHER.toLowerCase())]);
    expect(checkLendingCalls([sup(OTHER, 1n, DEV, 0)], D, DEV)).toEqual(['Call 1 supplies another asset than USDC.']);
    expect(checkLendingCalls([sup(D.asset.address, 1n, DEV, 7)], D, DEV)).toEqual(['Call 1 carries a referral code; this wallet sends 0.']);
    expect(checkLendingCalls([sup(D.asset.address, 0n, DEV, 0)], D, DEV)).toEqual(['Call 1 supplies 0 or the maximum amount.']);
    const wd = { to: D.pool, value: 0n, data: tamper(pool.encodeFunctionData('withdraw', [D.asset.address, 5n, OTHER])) };
    expect(checkLendingCalls([wd], D, DEV)).toEqual([LENDING_REFUSALS.withdrawRecipient(OTHER.toLowerCase())]);
    const ap = { to: D.asset.address, value: 0n, data: tamper(pool.encodeFunctionData('approve', [OTHER, 5n])) };
    expect(checkLendingCalls([ap], D, DEV)).toEqual(["Call 1 approves a spender other than Aave's Pool."]);
    const unlimited = { to: D.asset.address, value: 0n, data: tamper(pool.encodeFunctionData('approve', [D.pool, AAVE_WITHDRAW_ALL])) };
    expect(checkLendingCalls([unlimited], D, DEV)).toEqual(['Call 1 approves 0 or an unlimited amount.']);
    expect(checkLendingCalls([{ ...ok[1]!, to: OTHER }], D, DEV)).toEqual([`Call 1 supplies to ${OTHER}, not to Aave's Pool.`]);
    expect(checkLendingCalls([{ ...ok[1]!, value: 1n }], D, DEV)).toEqual(['Call 1 carries a value; lending calls never do.']);
    expect(checkLendingCalls([ok[0]!, lendingSupplyCall(D, 99_999n, DEV)], D, DEV)).toEqual(['The approval and the supply are for different amounts.']);
    expect(checkLendingCalls([ok[1]!, ok[0]!], D, DEV)).toEqual(['The calls (supply,approve) are not a shape this wallet builds.']);
    expect(checkLendingCalls([{ ...ok[1]!, data: ok[1]!.data.slice(0, 100) }], D, DEV)).toEqual(['Call 1 is not a well-formed supply.']);
    expect(checkLendingCalls([], D, DEV)).toHaveLength(1);
  });
});

describe("Aave's errors", () => {
  const errorString = (s: string) => '0x08c379a0' + coder.encode(['string'], [s]).slice(2);
  it('maps the deployed numeric strings, the origin custom errors and a node message', () => {
    expect(describeAaveError(errorString('51'))).toBe(AAVE_ERROR_SENTENCES['51']);
    expect(describeAaveError(errorString('28'))).toBe(AAVE_ERROR_SENTENCES['28']);
    expect(describeAaveError(id('SupplyCapExceeded()').slice(0, 10))).toBe(AAVE_ERROR_SENTENCES['51']);
    expect(describeAaveError('RPC error 3: execution reverted: 51 (eth_call)')).toBe(AAVE_ERROR_SENTENCES['51']);
    expect(describeAaveError('execution reverted: 32')).toBe(AAVE_ERROR_SENTENCES['32']);
    expect(describeAaveError(errorString('77'))).toBe("Aave refused the call with its error 77.");
  });
  it('leaves other reverts alone', () => {
    expect(describeAaveError(errorString('ERC20: transfer amount exceeds balance'))).toBeNull();
    expect(describeAaveError('execution reverted: ERC20: transfer amount exceeds allowance')).toBeNull();
    expect(describeAaveError('execution reverted: 510')).toBeNull();
    expect(describeAaveError('0x')).toBeNull();
    expect(describeAaveError('0x12345678')).toBeNull();
  });
});

describe('receipts', () => {
  const log = (name: string, args: unknown[], address = D.pool) => {
    const e = pool.encodeEventLog(pool.getEvent(name)!, args);
    return { address, topics: e.topics, data: e.data };
  };
  it('decodes Supply, Withdraw and the collateral events of the pinned Pool only', () => {
    const r = decodeLendingReceipt(
      [
        log('ReserveUsedAsCollateralEnabled', [D.asset.address, DEV]),
        log('Supply', [D.asset.address, DEV, DEV, 100_000n, 0]),
        log('Supply', [D.asset.address, DEV, DEV, 1n, 0], OTHER),
        log('Withdraw', [D.asset.address, DEV, DEV, 100_002n]),
        log('ReserveUsedAsCollateralDisabled', [D.asset.address, DEV]),
      ],
      D,
    );
    expect(r.supplies).toEqual([{ reserve: D.asset.address, user: DEV, onBehalfOf: DEV, amount: 100_000n, referralCode: 0n }]);
    expect(r.withdrawals).toEqual([{ reserve: D.asset.address, user: DEV, to: DEV, amount: 100_002n }]);
    expect(r.collateralEnabled).toEqual([{ reserve: D.asset.address, user: DEV }]);
    expect(r.collateralDisabled).toEqual([{ reserve: D.asset.address, user: DEV }]);
  });
  it('decodes the live supply and withdrawal of 2026-11-09', () => {
    const sup = decodeLendingReceipt(FIXTURE.liveReceipts.supply.logs, D);
    expect(sup.supplies).toEqual([{ reserve: D.asset.address, user: DEV, onBehalfOf: DEV, amount: 100_000n, referralCode: 0n }]);
    expect(sup.collateralEnabled).toEqual([{ reserve: D.asset.address, user: DEV }]);
    expect(sup.withdrawals).toEqual([]);
    const wd = decodeLendingReceipt(FIXTURE.liveReceipts.withdraw.logs, D);
    expect(wd.withdrawals).toEqual([{ reserve: D.asset.address, user: DEV, to: DEV, amount: 100_000n }]);
    expect(wd.collateralDisabled).toEqual([{ reserve: D.asset.address, user: DEV }]);
    expect(wd.supplies).toEqual([]);
  });
  it('throws on a malformed event', () => {
    const bad = log('Withdraw', [D.asset.address, DEV, DEV, 1n]);
    expect(() => decodeLendingReceipt([{ ...bad, topics: bad.topics.slice(0, 3) }], D)).toThrow(/topics/);
    expect(() => decodeLendingReceipt([{ ...bad, data: '0x1234' }], D)).toThrow();
  });
});

describe('arithmetic', () => {
  it('rayMul rounds half up like WadRayMath', () => {
    expect(aaveRayMul(1n, AAVE_RAY)).toBe(1n);
    expect(aaveRayMul(3n, AAVE_RAY / 2n)).toBe(2n);
    expect(aaveRayMul(1n, AAVE_RAY / 2n - 1n)).toBe(0n);
    expect(aaveRayMul(33_356_510_761n, 1_123_074_306_002_958_775_180_660_175n)).toBe(37_461_840_174n);
  });
  it('formats exact base units', () => {
    expect(formatLendingUnits(100_000n, 6)).toBe('0.1');
    expect(formatLendingUnits(38_000_000n, 6)).toBe('38');
    expect(formatLendingUnits(855_825_783_201n, 6)).toBe('855825.783201');
    expect(formatLendingUnits(0n, 6)).toBe('0');
    expect(formatLendingUnits(-5n, 6)).toBe('-0.000005');
  });
});

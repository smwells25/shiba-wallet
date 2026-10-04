import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, keccak256, recoverAddress, hashMessage, getBytes } from 'ethers';
import {
  ERC20_TRANSFER_SELECTOR,
  SUBSCRIPTION_NATIVE,
  assertSubscriptionPull,
  describePeriod,
  describeSubscription,
  formatBaseUnits,
  kernelSubscriptionSpec,
  nextPullAllowedAt,
  parseSubscription,
  readSubscriptionState,
  serializeSubscription,
  subscriptionMatchesGrant,
  subscriptionPeriodCount,
  subscriptionPullCall,
  subscriptionToGrant,
  validateSubscription,
  type SubscriptionChainState,
  type SubscriptionGrant,
} from '../src/kernel-subscription.js';
import {
  KERNEL_PERMISSION_MODULES,
  assertCallsAllowed,
  createSessionKeyAccount,
  encodePermissionInstall,
  kernelPermissionFromGrant,
  sessionNonceKey,
} from '../src/kernel-permissions.js';
import { encodeKernelExecute } from '../src/kernel-account.js';
import { ENTRYPOINT_V07, getUserOpHash } from '../src/userop.js';
import { toBytes, toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

/*
 * Reference vectors produced 2026-10-03 with the ZeroDev SDK's own encoders —
 * @zerodev/permissions 5.6.3 (toPermissionValidator with flag 0x0002,
 * toECDSASigner, toCallPolicy V0_0_4 with ABI args [EQUAL merchant,
 * LESS_THAN_OR_EQUAL amount] on erc20Abi.transfer, toTimestampPolicy,
 * toGasPolicy, toRateLimitPolicy {interval, count, startAt}), @zerodev/sdk
 * 5.5.10 and viem 2.57.2 — installed in a scratchpad only, never in this
 * repository. Policy order [call, timestamp, gas, rateLimit] as in
 * kernelPermissionFromGrant.
 */
const SESSION_PRIVATE_KEY = '0x0d04b3f51f6e0c7b0ccfb9aef76421285a08cba424e2a684ca1a664da32650a4';
const SESSION_ADDRESS = '0x484B87B8D4D73d88ccF7D39C006cC1b078384640';
const ACCOUNT = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const MERCHANT = '0x000000000000000000000000000000000000bEEF';
const S = 1790000000;
const MONTH = 2592000;
const CHAIN_ID = 11155111n;

const SDK = {
  erc20: {
    permissionId: '0x869d0c9f',
    validatorDataHash: '0x23ba027a7294f71aa7b37d5eedf5da6ed974fbc117a617efec49908e06112107',
    callPolicyDataHash: '0xc441f13d2fbbc7caebcc3968e82e8238ea02e0be46021a669ca07f1ff2721813',
    timestampData:
      '0x000000000000000000000000000000000000000000000000000000006ab13b80000000000000000000000000000000000000000000000000000000006b27e280',
    gasData:
      '0x000000000000000000000000000000000000000000000000000aa87bee53800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    rateLimitData: '0x000000278d0000000000000300006ab13b80',
  },
  native: {
    permissionId: '0x07457bcc',
    validatorDataHash: '0x2f5f64edcb130f92261f5b31203c89106da0a3e55fbd17f037ae2bb5e240b3ac',
    callPolicyDataHash: '0x77f200cb168e23ef871ee1b379907e72bfaba5342723f9fc97b23da8c0998764',
    timestampData:
      '0x000000000000000000000000000000000000000000000000000000006ab13b80000000000000000000000000000000000000000000000000000000006ab13ce8',
    gasData:
      '0x000000000000000000000000000000000000000000000000001550f7dca7000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    rateLimitData: '0x00000000007800000000000300006ab13b80',
  },
  /** viem encodeFunctionData(erc20Abi, 'transfer', [MERCHANT, 5000000n]). */
  pullData:
    '0xa9059cbb000000000000000000000000000000000000000000000000000000000000beef00000000000000000000000000000000000000000000000000000000004c4b40',
};

function usdcSub(): SubscriptionGrant {
  return {
    merchant: MERCHANT,
    token: USDC,
    amountPerPeriod: 5_000_000n,
    periodSeconds: MONTH,
    startAt: S,
    validUntil: S + 3 * MONTH,
    feeBudgetWei: 3_000_000_000_000_000n,
    label: 'Streaming',
  };
}

function nativeSub(): SubscriptionGrant {
  return {
    merchant: MERCHANT,
    token: SUBSCRIPTION_NATIVE,
    amountPerPeriod: 1000n,
    periodSeconds: 120,
    startAt: S,
    validUntil: S + 360,
    feeBudgetWei: 6_000_000_000_000_000n,
    label: 'Keeper test',
  };
}

function installFor(sub: SubscriptionGrant) {
  return encodePermissionInstall(subscriptionToGrant(sub, SESSION_ADDRESS, { now: null }), {
    chainId: CHAIN_ID,
    account: ACCOUNT,
    currentNonce: 3,
    validationNonce: 0,
    now: S - 10,
  });
}

describe.each([
  ['erc20', usdcSub, SDK.erc20],
  ['native', nativeSub, SDK.native],
] as const)('%s subscription grant byte-identical to the ZeroDev SDK', (_name, make, sdk) => {
  it('permission id and validatorData', () => {
    const inst = installFor(make());
    expect(toHex(inst.permissionId)).toBe(sdk.permissionId);
    expect(keccak256(inst.validatorData)).toBe(sdk.validatorDataHash);
    expect(inst.policyCount).toBe(4);
  });

  it('each policy entry: call, timestamp, gas, rate limit (startAt = the subscription start)', () => {
    const permission = kernelPermissionFromGrant(subscriptionToGrant(make(), SESSION_ADDRESS, { now: null }));
    expect(permission.policies.map((p) => p.module)).toEqual([
      KERNEL_PERMISSION_MODULES.callPolicy,
      KERNEL_PERMISSION_MODULES.timestampPolicy,
      KERNEL_PERMISSION_MODULES.gasPolicy,
      KERNEL_PERMISSION_MODULES.rateLimitPolicy,
    ]);
    expect(keccak256(permission.policies[0]!.data)).toBe(sdk.callPolicyDataHash);
    expect(toHex(permission.policies[1]!.data)).toBe(sdk.timestampData);
    expect(toHex(permission.policies[2]!.data)).toBe(sdk.gasData);
    expect(toHex(permission.policies[3]!.data)).toBe(sdk.rateLimitData);
    expect(permission.signer.flag).toBe(0x0002);
  });
});

describe('grant mapping', () => {
  it('ERC-20: one call to the token, transfer selector, recipient EQUAL and amount LESS_THAN_OR_EQUAL', () => {
    const grant = subscriptionToGrant(usdcSub(), SESSION_ADDRESS, { now: null });
    expect(ERC20_TRANSFER_SELECTOR).toBe(new Interface(['function transfer(address,uint256)']).getFunction('transfer')!.selector);
    expect(grant.calls).toHaveLength(1);
    const call = grant.calls[0]!;
    expect(call.target).toBe(USDC);
    expect(call.selector).toBe('0xa9059cbb');
    expect(call.valueLimit).toBe(0n);
    const coder = AbiCoder.defaultAbiCoder();
    expect(call.rules).toEqual([
      { condition: 'equal', offset: 0, params: [coder.encode(['address'], [MERCHANT]).toLowerCase()] },
      { condition: 'lessThanOrEqual', offset: 32, params: [coder.encode(['uint256'], [5_000_000n])] },
    ]);
    expect(grant.validAfter).toBe(S);
    expect(grant.validUntil).toBe(S + 3 * MONTH);
    expect(grant.gasBudgetWei).toBe(3_000_000_000_000_000n);
    expect(grant.rateLimit).toEqual({ count: 3, intervalSeconds: MONTH, startAt: S });
  });

  it('native: one call to the merchant, no function, value cap = amount', () => {
    const grant = subscriptionToGrant(nativeSub(), SESSION_ADDRESS, { now: null });
    expect(grant.calls).toEqual([{ target: MERCHANT, selector: null, valueLimit: 1000n }]);
    expect(grant.rateLimit).toEqual({ count: 3, intervalSeconds: 120, startAt: S });
  });

  it('period count is one per period that starts before the expiry', () => {
    expect(subscriptionPeriodCount({ startAt: 100, validUntil: 460, periodSeconds: 120 })).toBe(3);
    expect(subscriptionPeriodCount({ startAt: 100, validUntil: 461, periodSeconds: 120 })).toBe(4);
    expect(subscriptionPeriodCount({ startAt: 100, validUntil: 101, periodSeconds: 120 })).toBe(1);
  });

  it('pull calldata equals viem encodeFunctionData(transfer)', () => {
    const call = subscriptionPullCall(usdcSub());
    expect(call.to).toBe(USDC);
    expect(call.value).toBe(0n);
    expect(toHex(call.data)).toBe(SDK.pullData);
    expect(subscriptionPullCall(nativeSub())).toEqual({ to: MERCHANT, value: 1000n, data: new Uint8Array(0) });
  });

  it('subscriptionMatchesGrant accepts the mapped grant and rejects any change', () => {
    const sub = usdcSub();
    const grant = subscriptionToGrant(sub, SESSION_ADDRESS, { now: null });
    expect(subscriptionMatchesGrant(sub, grant)).toBe(true);
    expect(subscriptionMatchesGrant({ ...sub, amountPerPeriod: 5_000_001n }, grant)).toBe(false);
    expect(subscriptionMatchesGrant(sub, { ...grant, rateLimit: { count: 3, intervalSeconds: MONTH, startAt: 0 } })).toBe(false);
    expect(subscriptionMatchesGrant(sub, { ...grant, gasBudgetWei: undefined })).toBe(false);
    expect(
      subscriptionMatchesGrant(sub, { ...grant, calls: [...grant.calls, { target: MERCHANT, selector: null, valueLimit: 1n }] }),
    ).toBe(false);
  });

  it('serialize / parse round trip re-validates', () => {
    const sub = usdcSub();
    expect(parseSubscription(JSON.parse(JSON.stringify(serializeSubscription(sub))))).toEqual(sub);
    expect(() => parseSubscription({ ...serializeSubscription(sub), amountPerPeriod: '0' })).toThrow(/positive/);
    expect(() => parseSubscription({ ...serializeSubscription(sub), version: 2 })).toThrow(/version-1/);
  });
});

describe('refusals', () => {
  const now = S - 100;
  const bad: Array<[string, Partial<SubscriptionGrant>, RegExp]> = [
    ['zero merchant', { merchant: '0x0000000000000000000000000000000000000000' }, /zero address/],
    ['malformed merchant', { merchant: '0x1234' }, /20-byte/],
    ['zero-address token (CallPolicy wildcard)', { token: '0x0000000000000000000000000000000000000000' }, /any contract/],
    ['token = merchant', { token: MERCHANT }, /token contract itself/],
    ['zero amount', { amountPerPeriod: 0n }, /positive/],
    ['period too short', { periodSeconds: 59 }, /at least 60/],
    ['fractional period', { periodSeconds: 120.5 }, /whole number/],
    ['expiry before start', { validUntil: S }, /after the start/],
    ['no fee budget', { feeBudgetWei: 0n }, /fee budget/],
    ['empty label', { label: '  ' }, /name/],
    ['bidi label', { label: 'abc‮def' }, /direction/],
    ['too many periods', { periodSeconds: 60, validUntil: S + 60 * 10_001 }, /At most 10000/],
  ];
  it.each(bad)('%s', (_n, patch, pattern) => {
    expect(() => validateSubscription({ ...usdcSub(), ...patch }, { now })).toThrow(pattern);
  });

  it('refuses the account itself as merchant or token, and expired windows', () => {
    expect(() => validateSubscription({ ...usdcSub(), merchant: ACCOUNT }, { account: ACCOUNT, now })).toThrow(/own account/);
    expect(() => validateSubscription({ ...usdcSub(), token: ACCOUNT }, { account: ACCOUNT, now })).toThrow(/own account/);
    expect(() => validateSubscription(usdcSub(), { now: S + 3 * MONTH })).toThrow(/expired/);
  });
});

describe('local pull checks (client-side only; the account cannot refuse batches)', () => {
  const sub = usdcSub();
  const at = S + 10;

  it('accepts one in-cap transfer to the merchant, including less than the cap', () => {
    expect(() => assertSubscriptionPull(sub, SESSION_ADDRESS, [subscriptionPullCall(sub)], at)).not.toThrow();
    expect(() => assertSubscriptionPull(sub, SESSION_ADDRESS, [subscriptionPullCall(sub, 1n)], at)).not.toThrow();
  });

  it('refuses a batch even when every call is within the cap', () => {
    const one = subscriptionPullCall(sub);
    expect(() => assertSubscriptionPull(sub, SESSION_ADDRESS, [one, one], at)).toThrow(/exactly one transfer/);
    // The on-chain mirror (assertCallsAllowed = CallPolicy's per-call rule)
    // accepts the same batch: this is the residual the module documents.
    expect(() => assertCallsAllowed(subscriptionToGrant(sub, SESSION_ADDRESS, { now: null }), [one, one], at)).not.toThrow();
  });

  it('refuses over-cap amounts, another recipient, another token, and pulls outside the window', () => {
    expect(() => assertSubscriptionPull(sub, SESSION_ADDRESS, [subscriptionPullCall(sub, 5_000_001n)], at)).toThrow(
      /violates rule 1 \(lessThanOrEqual\)/,
    );
    const other = { ...sub, merchant: '0x000000000000000000000000000000000000dEaD' };
    expect(() => assertSubscriptionPull(sub, SESSION_ADDRESS, [subscriptionPullCall(other)], at)).toThrow(
      /violates rule 0 \(equal\)/,
    );
    expect(() =>
      assertSubscriptionPull(sub, SESSION_ADDRESS, [{ ...subscriptionPullCall(sub), to: MERCHANT }], at),
    ).toThrow(/not allowed/);
    expect(() => assertSubscriptionPull(sub, SESSION_ADDRESS, [subscriptionPullCall(sub)], S - 1)).toThrow(/not valid until/);
    expect(() => assertSubscriptionPull(sub, SESSION_ADDRESS, [subscriptionPullCall(sub)], S + 3 * MONTH)).toThrow(/expired/);
  });

  it('kernelSubscriptionSpec signs single pulls with the session key and refuses batches before signing', () => {
    const session = createSessionKeyAccount(toBytes(SESSION_PRIVATE_KEY));
    expect(session.address).toBe(SESSION_ADDRESS);
    const inst = installFor(sub);
    const spec = kernelSubscriptionSpec({
      account: ACCOUNT,
      sessionKey: SESSION_ADDRESS,
      permissionId: inst.permissionId,
      subscription: sub,
      now: () => at,
    });
    expect(spec.getNonceKey()).toBe(sessionNonceKey(inst.permissionId));
    const callData = spec.encodeCalls([subscriptionPullCall(sub)]);
    expect(toHex(callData)).toBe(toHex(encodeKernelExecute([subscriptionPullCall(sub)])));
    expect(() => spec.encodeCalls([subscriptionPullCall(sub), subscriptionPullCall(sub)])).toThrow(/exactly one/);
    const op = {
      sender: ACCOUNT,
      nonce: spec.getNonceKey() << 64n,
      callData,
      callGasLimit: 100000n,
      verificationGasLimit: 400000n,
      preVerificationGas: 60000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      signature: new Uint8Array(0),
    };
    const hash = getUserOpHash(op, ENTRYPOINT_V07, CHAIN_ID);
    const sig = spec.signUserOpHash(session, hash);
    expect(sig[0]).toBe(0xff);
    expect(recoverAddress(hashMessage(getBytes(toHex(hash))), toHex(sig.slice(1)))).toBe(SESSION_ADDRESS);
  });
});

describe('on-chain state and the next pull', () => {
  function fakeNode(words: { status: bigint; interval: bigint; count: bigint; startAt: bigint; allowed: bigint }): {
    node: JsonRpcTransport;
    calls: Array<{ to: string; data: string }>;
  } {
    const calls: Array<{ to: string; data: string }> = [];
    const coder = AbiCoder.defaultAbiCoder();
    const iface = new Interface([
      'function status(bytes32,address) view returns (uint8)',
      'function rateLimitConfigs(bytes32,address) view returns (uint48,uint48,uint48)',
      'function gasPolicyConfig(bytes32,address) view returns (uint128,bool,address)',
    ]);
    const node: JsonRpcTransport = async (method, params) => {
      expect(method).toBe('eth_call');
      const tx = params[0] as { to: string; data: string };
      calls.push(tx);
      const fn = iface.parseTransaction({ data: tx.data })!;
      expect(fn.args[0]).toBe('0x869d0c9f' + '00'.repeat(28));
      expect(fn.args[1]).toBe(ACCOUNT);
      if (fn.name === 'status') return coder.encode(['uint8'], [words.status]);
      if (fn.name === 'rateLimitConfigs') {
        return coder.encode(['uint48', 'uint48', 'uint48'], [words.interval, words.count, words.startAt]);
      }
      return coder.encode(['uint128', 'bool', 'address'], [words.allowed, false, '0x' + '00'.repeat(20)]);
    };
    return { node, calls };
  }

  it('reads RateLimitPolicy and GasPolicy getters for the permission id', async () => {
    const { node, calls } = fakeNode({ status: 1n, interval: 120n, count: 2n, startAt: BigInt(S + 120), allowed: 5n });
    const state = await readSubscriptionState(node, ACCOUNT, '0x869d0c9f', { validUntil: S + 360 });
    expect(state).toEqual({
      rateLimitStatus: 'live',
      intervalSeconds: 120,
      remainingPulls: 2,
      nextSlotAt: S + 120,
      feeBudgetLeftWei: 5n,
      validUntil: S + 360,
    });
    expect(calls.map((c) => c.to)).toEqual([
      KERNEL_PERMISSION_MODULES.rateLimitPolicy,
      KERNEL_PERMISSION_MODULES.rateLimitPolicy,
      KERNEL_PERMISSION_MODULES.gasPolicy,
    ]);
  });

  it('nextPullAllowedAt follows EntryPoint validAfter <= now <= validUntil', () => {
    const base: SubscriptionChainState = {
      rateLimitStatus: 'live',
      intervalSeconds: 120,
      remainingPulls: 2,
      nextSlotAt: S + 120,
      feeBudgetLeftWei: 1n,
      validUntil: S + 360,
    };
    expect(nextPullAllowedAt(base, S + 119)).toEqual({ kind: 'later', at: S + 120, remainingPulls: 2 });
    expect(nextPullAllowedAt(base, S + 120)).toEqual({ kind: 'now', at: S + 120, remainingPulls: 2 });
    expect(nextPullAllowedAt({ ...base, remainingPulls: 0 }, S)).toEqual({ kind: 'used-up' });
    expect(nextPullAllowedAt(base, S + 361)).toEqual({ kind: 'ended' });
    expect(nextPullAllowedAt({ ...base, nextSlotAt: S + 480 }, S + 200)).toEqual({ kind: 'ended' });
    expect(nextPullAllowedAt({ ...base, rateLimitStatus: 'deprecated' }, S)).toEqual({ kind: 'inactive' });
  });
});

describe('plain language', () => {
  it('the sentence, the on-chain limits and the caveats (batch first)', () => {
    const d = describeSubscription(
      { ...usdcSub(), validUntil: Date.UTC(2026, 10, 2) / 1000, startAt: Date.UTC(2026, 7, 4) / 1000 },
      { symbol: 'USDC', decimals: 6, merchantName: 'Streamy', nativeSymbol: 'test ETH' },
    );
    expect(d.sentence).toBe(
      `Lets Streamy (${MERCHANT}) take up to 5 USDC every 30 days until 2026-11-02 00:00 UTC; at most one pull per period.`,
    );
    expect(d.enforced[0]).toContain(`Only USDC (contract ${USDC}) transfers to ${MERCHANT}, at most 5 USDC each.`);
    expect(d.enforced[1]).toBe('At most 3 pulls in total: the first from 2026-08-04 00:00 UTC, then one more every 30 days.');
    expect(d.enforced[3]).toBe('Network fees for the pulls are paid by your account, at most 0.003 test ETH in total.');
    expect(d.caveats[0]).toMatch(/^ONE PULL CAN HOLD SEVERAL TRANSFERS/);
    expect(d.caveats[0]).toContain('up to everything this account holds in USDC');
    expect(d.caveats[1]).toMatch(/Missed pulls are not lost/);
  });

  it('native wording, periods and exact amounts', () => {
    const d = describeSubscription(nativeSub(), { symbol: 'test ETH', decimals: 18, nativeSymbol: 'test ETH' });
    expect(d.sentence).toMatch(new RegExp(`^Lets ${MERCHANT} take up to 0.000000000000001 test ETH every 2 minutes until `));
    expect(d.enforced[0]).toBe(`Only plain test ETH transfers to ${MERCHANT}, at most 0.000000000000001 test ETH each.`);
    expect(describePeriod(86400)).toBe('1 day');
    expect(describePeriod(7200)).toBe('2 hours');
    expect(describePeriod(90)).toBe('90 seconds');
    expect(formatBaseUnits(5_000_000n, 6)).toBe('5');
    expect(formatBaseUnits(1_234_500n, 6)).toBe('1.2345');
    expect(formatBaseUnits(7n, 0)).toBe('7');
  });
});

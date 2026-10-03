import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, id as ethersId, keccak256 } from 'ethers';
import {
  HOOK_POSTCHECK_KERNEL_V3_0,
  HOOK_POSTCHECK_KERNEL_V3_1,
  KERNEL_EXECUTE_USER_OP_SELECTOR,
  KERNEL_HOOK_NONE,
  KERNEL_MODULE_TYPE_HOOK,
  KERNEL_V3_3,
  SPENDING_LIMIT_NATIVE_TOKEN,
  SpendingLimitHookIncompatibleError,
  ZERODEV_SPENDING_LIMIT_HOOK,
  assessHookInterface,
  balanceDeltasFromAssetChanges,
  checkSpendingAgainstHook,
  ecdsaRootValidationId,
  encodeKernelExecute,
  encodeRootSpendingLimitInstall,
  encodeSpendingLimitHookData,
  encodeSpendingLimitHookInitData,
  encodeSpendingLimitHookRemoval,
  evaluateSpendingPolicy,
  kernelHookedCallData,
  outflowsFromDeltas,
  prepareRootSpendingLimitInstall,
  readSpendingLimitHookState,
  rootSpendingLimitInstallCalls,
  spendingLimitHookRemovalCall,
  spendingLimitUpdateCalls,
  toBytes,
  toHex,
  validateSpendingLimits,
  validateSpendingPolicy,
  type AssetChange,
  type JsonRpcTransport,
  type SpendingLimit,
} from '../src/index.js';

/*
 * Reference values:
 *  - SDK_* were produced in a scratchpad with @zerodev/hooks 5.3.4
 *    toSpendingLimitHook(...).getEnableData() and viem 2.57.2
 *    encodeFunctionData / encodeAbiParameters for installModule and
 *    uninstallModule (not dependencies of this repository).
 *  - Selectors are recomputed here with ethers' keccak (independent of the
 *    engine's @noble keccak).
 *  - fixtures/zerodev-spending-limit-hook.runtime.hex is the runtime code of
 *    0xb6D6B30C9E1A28E8044F4cCB48A63A423Ee3D70E read from Sepolia (identical
 *    on Ethereum mainnet), 2026-10-03.
 */

const here = dirname(fileURLToPath(import.meta.url));
const HOOK_RUNTIME = readFileSync(join(here, 'fixtures', 'zerodev-spending-limit-hook.runtime.hex'), 'utf8').trim();

const USDC_SEPOLIA = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const OWNER = '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C';
const ACCOUNT = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const NATIVE = SPENDING_LIMIT_NATIVE_TOKEN;
const LIMITS: SpendingLimit[] = [
  { token: NATIVE, allowance: 1_000_000_000_000_000n },
  { token: USDC_SEPOLIA, allowance: 25_000_000n },
];

const SDK_ENABLE_TWO =
  '0xaa00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000034000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000038d7ea4c6800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000341c7d4b196cb0c7b01d743fbc6116a902379c723800000000000000000000000000000000000000000000000000000000017d7840000000000000000000000000';
const SDK_ENABLE_SINGLE =
  '0xaa000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005000000000000000000000000';
const VIEM_INSTALL =
  '0x9517e29f0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000845adb2c711129d4f3966735ed98a9f09fc4ce5700000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000254b6D6B30C9E1A28E8044F4cCB48A63A423Ee3D70E000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000001416DA2CAeaDa26516F919C6872F6C38AB378CaC5C0000000000000000000000000000000000000000000000000000000000000000000000000000000000000141aa00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000034000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000038d7ea4c6800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000341c7d4b196cb0c7b01d743fbc6116a902379c723800000000000000000000000000000000000000000000000000000000017d7840000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
const VIEM_UNINSTALL =
  '0xa71763a80000000000000000000000000000000000000000000000000000000000000004000000000000000000000000b6d6b30c9e1a28e8044f4ccb48a63a423ee3d70e00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000';

const sel = (sig: string) => ethersId(sig).slice(0, 10);
const lower = (hex: string) => hex.toLowerCase();

describe('selectors and constants', () => {
  it('pins every selector against an independent keccak', () => {
    expect(HOOK_POSTCHECK_KERNEL_V3_1).toBe(sel('postCheck(bytes)'));
    expect(HOOK_POSTCHECK_KERNEL_V3_1).toBe('0x173bf7da');
    expect(HOOK_POSTCHECK_KERNEL_V3_0).toBe(sel('postCheck(bytes,bool,bytes)'));
    expect(HOOK_POSTCHECK_KERNEL_V3_0).toBe('0xaacbd72a');
    expect(KERNEL_EXECUTE_USER_OP_SELECTOR).toBe(
      sel('executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)'),
    );
    expect(KERNEL_EXECUTE_USER_OP_SELECTOR).toBe('0x8dd7712f');
    expect(toHex(encodeSpendingLimitHookRemoval()).slice(0, 10)).toBe(sel('uninstallModule(uint256,address,bytes)'));
    expect(toHex(encodeRootSpendingLimitInstall(OWNER, LIMITS)).slice(0, 10)).toBe(sel('installModule(uint256,address,bytes)'));
    expect(KERNEL_MODULE_TYPE_HOOK).toBe(4);
    expect(KERNEL_HOOK_NONE).toBe('0x0000000000000000000000000000000000000001');
  });

  it('pins the deployed hook runtime code (keccak and length) from the fixture', () => {
    const bytes = toBytes(HOOK_RUNTIME);
    expect(bytes.length).toBe(ZERODEV_SPENDING_LIMIT_HOOK.runtimeCodeLength);
    expect(keccak256(HOOK_RUNTIME)).toBe(ZERODEV_SPENDING_LIMIT_HOOK.runtimeCodeKeccak);
  });

  it('the deployed hook dispatches the Kernel v3.0 postCheck and not the v3.1+ one', () => {
    const code = lower(HOOK_RUNTIME);
    expect(code.includes('63' + HOOK_POSTCHECK_KERNEL_V3_0.slice(2))).toBe(true);
    expect(code.includes('63' + HOOK_POSTCHECK_KERNEL_V3_1.slice(2))).toBe(false);
    for (const s of ['preCheck(address,uint256,bytes)', 'onInstall(bytes)', 'onUninstall(bytes)', 'isInitialized(address)', 'listLength(address)', 'spendingLimit(uint256,address)']) {
      expect(code.includes('63' + sel(s).slice(2)), s).toBe(true);
    }
  });
});

describe('encodings (byte-pinned to @zerodev/hooks 5.3.4 and viem 2.57.2)', () => {
  it('hook data equals the SDK getEnableData', () => {
    expect(toHex(encodeSpendingLimitHookData(LIMITS))).toBe(SDK_ENABLE_TWO);
    expect(toHex(encodeSpendingLimitHookData([{ token: NATIVE, allowance: 5n }]))).toBe(SDK_ENABLE_SINGLE);
  });

  it('init data is abi.encode(bytes[]) of token || allowance (ethers decode)', () => {
    const [arr] = AbiCoder.defaultAbiCoder().decode(['bytes[]'], encodeSpendingLimitHookInitData(LIMITS));
    expect(arr).toHaveLength(2);
    expect(lower(arr[1])).toBe(lower(USDC_SEPOLIA) + (25_000_000n).toString(16).padStart(64, '0'));
  });

  it('root install and hook removal equal the viem encodings', () => {
    expect(lower(toHex(encodeRootSpendingLimitInstall(OWNER, LIMITS)))).toBe(lower(VIEM_INSTALL));
    expect(toHex(encodeSpendingLimitHookRemoval())).toBe(VIEM_UNINSTALL);
  });

  it('root install decodes with ethers to the Kernel InstallValidatorDataFormat', () => {
    const iface = new Interface(['function installModule(uint256,address,bytes)']);
    const [type, module, initData] = iface.decodeFunctionData('installModule', encodeRootSpendingLimitInstall(OWNER, LIMITS));
    expect(type).toBe(1n);
    expect(module).toBe(KERNEL_V3_3.ecdsaValidator);
    const hookAddr = '0x' + (initData as string).slice(2, 42);
    expect(lower(hookAddr)).toBe(lower(ZERODEV_SPENDING_LIMIT_HOOK.address));
    const [validatorData, hookData, selectorData] = AbiCoder.defaultAbiCoder().decode(
      ['bytes', 'bytes', 'bytes'],
      '0x' + (initData as string).slice(42),
    );
    expect(lower(validatorData)).toBe(lower(OWNER));
    expect(hookData).toBe(SDK_ENABLE_TWO);
    expect(selectorData).toBe('0x');
  });

  it('root install batch: clear the ECDSA owner, then re-install with the hook', () => {
    const calls = rootSpendingLimitInstallCalls(ACCOUNT, OWNER, LIMITS);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.to).toBe(KERNEL_V3_3.ecdsaValidator);
    expect(toHex(calls[0]!.data)).toBe(new Interface(['function onUninstall(bytes)']).encodeFunctionData('onUninstall', ['0x']));
    expect(calls[1]!.to).toBe(ACCOUNT);
    expect(lower(toHex(calls[1]!.data))).toBe(lower(VIEM_INSTALL));
    expect(() => rootSpendingLimitInstallCalls(ACCOUNT, ACCOUNT, LIMITS)).toThrow(/account itself/);
  });

  it('update = removal + install batch; removal call targets the account', () => {
    const calls = spendingLimitUpdateCalls(ACCOUNT, OWNER, LIMITS);
    expect(calls.map((c) => c.to)).toEqual([ACCOUNT, KERNEL_V3_3.ecdsaValidator, ACCOUNT]);
    expect(toHex(calls[0]!.data)).toBe(VIEM_UNINSTALL);
    expect(spendingLimitHookRemovalCall(ACCOUNT)).toEqual({ to: ACCOUNT, value: 0n, data: toBytes(VIEM_UNINSTALL) });
  });

  it('hooked callData is executeUserOp selector || execute(...)', () => {
    const inner = encodeKernelExecute([{ to: OWNER, value: 1n, data: new Uint8Array(0) }]);
    const wrapped = kernelHookedCallData(inner);
    expect(toHex(wrapped.slice(0, 4))).toBe('0x8dd7712f');
    expect(toHex(wrapped.slice(4))).toBe(toHex(inner));
    expect(() => kernelHookedCallData(new Uint8Array(3))).toThrow();
  });

  it('ecdsaRootValidationId is 0x01 || validator', () => {
    expect(ecdsaRootValidationId()).toBe('0x01' + KERNEL_V3_3.ecdsaValidator.slice(2).toLowerCase());
  });
});

describe('validateSpendingLimits refusals', () => {
  const ok = () => validateSpendingLimits(LIMITS, { account: ACCOUNT });
  it('accepts a sane list', () => expect(ok).not.toThrow());
  it.each([
    ['empty list', [], /At least one/],
    ['zero allowance', [{ token: NATIVE, allowance: 0n }], /positive uint256/],
    ['negative allowance', [{ token: NATIVE, allowance: -1n }], /positive uint256/],
    ['allowance above uint256', [{ token: NATIVE, allowance: 1n << 256n }], /positive uint256/],
    ['non-bigint allowance', [{ token: NATIVE, allowance: 5 as unknown as bigint }], /positive uint256/],
    ['malformed token', [{ token: '0x1234', allowance: 1n }], /20-byte/],
    ['the account as token', [{ token: ACCOUNT.toLowerCase(), allowance: 1n }], /account itself/],
    [
      'duplicate token (case-insensitive)',
      [
        { token: USDC_SEPOLIA, allowance: 1n },
        { token: USDC_SEPOLIA.toLowerCase(), allowance: 2n },
      ],
      /twice/,
    ],
    ['too many entries', Array.from({ length: 9 }, (_, i) => ({ token: '0x' + (i + 1).toString(16).padStart(40, '0'), allowance: 1n })), /At most 8/],
  ])('refuses %s', (_label, limits, pattern) => {
    expect(() => validateSpendingLimits(limits as SpendingLimit[], { account: ACCOUNT })).toThrow(pattern);
  });
  it('refuses tokens outside knownTokens but always knows native ETH', () => {
    expect(() => validateSpendingLimits(LIMITS, { knownTokens: [] })).toThrow(/not a known token/);
    expect(() => validateSpendingLimits([{ token: NATIVE, allowance: 1n }], { knownTokens: [] })).not.toThrow();
    expect(() => validateSpendingLimits(LIMITS, { knownTokens: [USDC_SEPOLIA.toLowerCase()] })).not.toThrow();
  });
  it('encoders validate too', () => {
    expect(() => encodeSpendingLimitHookData([])).toThrow();
    expect(() => encodeRootSpendingLimitInstall('0x0000000000000000000000000000000000000000', LIMITS)).toThrow(/zero/);
  });
});

describe('checkSpendingAgainstHook mirrors SpendingLimit.postCheck', () => {
  it('within, equal, over, increase, net and unlisted tokens', () => {
    const limits = [
      { token: NATIVE, allowance: 1000n },
      { token: USDC_SEPOLIA, allowance: 50n },
    ];
    const within = checkSpendingAgainstHook(limits, [{ token: NATIVE, delta: -600n }]);
    expect(within.exceeds).toBe(false);
    expect(within.entries[0]).toMatchObject({ used: 600n, remainingAfter: 400n, exceeds: false });
    expect(within.entries[1]).toMatchObject({ used: 0n, remainingAfter: 50n });
    expect(checkSpendingAgainstHook(limits, [{ token: NATIVE, delta: -1000n }]).exceeds).toBe(false);
    const over = checkSpendingAgainstHook(limits, [{ token: USDC_SEPOLIA.toLowerCase(), delta: -51n }]);
    expect(over.exceeds).toBe(true);
    expect(over.entries[1]).toMatchObject({ used: 51n, exceeds: true });
    // A balance increase is skipped, exactly like the hook's `continue`.
    expect(checkSpendingAgainstHook(limits, [{ token: NATIVE, delta: 5000n }]).entries[0]!.used).toBe(0n);
    // Net over the execution: -1500 out, +700 in = 800 used.
    const net = checkSpendingAgainstHook(limits, [
      { token: NATIVE, delta: -1500n },
      { token: NATIVE, delta: 700n },
    ]);
    expect(net.entries[0]).toMatchObject({ used: 800n, exceeds: false });
    // Unlisted tokens are ignored, as on-chain.
    expect(checkSpendingAgainstHook(limits, [{ token: OWNER, delta: -(10n ** 30n) }]).exceeds).toBe(false);
  });

  it('balanceDeltasFromAssetChanges keeps only fungible balance moves of the account', () => {
    const changes: AssetChange[] = [
      { callIndex: 0, type: 'native', direction: 'out', from: ACCOUNT, to: OWNER, amount: 300n },
      { callIndex: 0, type: 'erc20', direction: 'in', token: USDC_SEPOLIA, from: OWNER, to: ACCOUNT, amount: 7n },
      { callIndex: 0, type: 'erc20', direction: 'out', token: USDC_SEPOLIA, from: ACCOUNT, to: OWNER, amount: 10n },
      { callIndex: 0, type: 'native', direction: 'self', from: ACCOUNT, to: ACCOUNT, amount: 99n },
      { callIndex: 0, type: 'erc721', direction: 'out', token: USDC_SEPOLIA, from: ACCOUNT, to: OWNER, tokenId: 1n },
    ];
    const deltas = balanceDeltasFromAssetChanges(changes, ACCOUNT);
    expect(deltas).toEqual([
      { token: NATIVE, delta: -300n },
      { token: USDC_SEPOLIA, delta: -3n },
    ]);
    expect(outflowsFromDeltas([...deltas, { token: OWNER, delta: 5n }])).toEqual([
      { token: NATIVE, amount: 300n },
      { token: USDC_SEPOLIA, amount: 3n },
    ]);
  });
});

describe('client-side spending policy', () => {
  const DAY = 86_400;
  const rules = [
    { token: NATIVE, cap: 1000n, windowSeconds: DAY },
    { token: NATIVE, cap: 5000n, windowSeconds: 7 * DAY },
    { token: USDC_SEPOLIA, cap: 100n, windowSeconds: DAY },
  ];
  const now = 1_800_000_000;

  it('validates rules', () => {
    expect(() => validateSpendingPolicy(rules, { account: ACCOUNT })).not.toThrow();
    expect(() => validateSpendingPolicy([])).toThrow(/At least one/);
    expect(() => validateSpendingPolicy([{ token: NATIVE, cap: 0n, windowSeconds: DAY }])).toThrow(/cap/);
    expect(() => validateSpendingPolicy([{ token: NATIVE, cap: 1n, windowSeconds: 59 }])).toThrow(/windowSeconds/);
    expect(() => validateSpendingPolicy([{ token: NATIVE, cap: 1n, windowSeconds: 367 * DAY }])).toThrow(/windowSeconds/);
    expect(() => validateSpendingPolicy([{ token: NATIVE, cap: 1n, windowSeconds: 1.5 }])).toThrow(/windowSeconds/);
    expect(() => validateSpendingPolicy([{ token: ACCOUNT, cap: 1n, windowSeconds: DAY }], { account: ACCOUNT })).toThrow(/account itself/);
    expect(() => validateSpendingPolicy([{ token: USDC_SEPOLIA, cap: 1n, windowSeconds: DAY }], { knownTokens: [] })).toThrow(/known/);
    expect(() =>
      validateSpendingPolicy([
        { token: NATIVE, cap: 1n, windowSeconds: DAY },
        { token: NATIVE, cap: 2n, windowSeconds: DAY },
      ]),
    ).toThrow(/duplicates/);
  });

  it('sums the rolling window per rule and flags the first breach', () => {
    const history = [
      { token: NATIVE, amount: 700n, at: now - 100 },
      { token: NATIVE, amount: 2000n, at: now - DAY }, // exactly one day old: outside the 1-day window
      { token: NATIVE, amount: 1000n, at: now - 3 * DAY },
      { token: NATIVE, amount: 9999n, at: now - 8 * DAY }, // outside both windows
      { token: USDC_SEPOLIA, amount: 90n, at: now - 10 },
    ];
    const ok = evaluateSpendingPolicy(rules, history, [{ token: NATIVE, amount: 300n }], now);
    expect(ok.enforcement).toBe('client-side');
    expect(ok.allowed).toBe(true);
    expect(ok.entries[0]).toMatchObject({ spentInWindow: 700n, proposed: 300n, remainingAfter: 0n, exceeds: false });
    expect(ok.entries[1]).toMatchObject({ spentInWindow: 3700n, remainingAfter: 1000n });
    const breach = evaluateSpendingPolicy(rules, history, [{ token: NATIVE, amount: 301n }], now);
    expect(breach.allowed).toBe(false);
    expect(breach.entries[0]!.exceeds).toBe(true);
    expect(breach.entries[1]!.exceeds).toBe(false);
    const token = evaluateSpendingPolicy(rules, history, [{ token: USDC_SEPOLIA.toLowerCase(), amount: 11n }], now);
    expect(token.allowed).toBe(false);
    expect(token.entries[2]).toMatchObject({ spentInWindow: 90n, proposed: 11n, exceeds: true });
  });

  it('counts future-dated records (clock skew) and refuses malformed input', () => {
    const d = evaluateSpendingPolicy(rules, [{ token: NATIVE, amount: 1000n, at: now + 60 }], [{ token: NATIVE, amount: 1n }], now);
    expect(d.allowed).toBe(false);
    expect(() => evaluateSpendingPolicy(rules, [], [{ token: NATIVE, amount: -1n }], now)).toThrow();
    expect(() => evaluateSpendingPolicy(rules, [{ token: NATIVE, amount: 1n, at: 1.5 }], [], now)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Readers and prepare, over a fake node
// ---------------------------------------------------------------------------

const COMPATIBLE_HOOK = '0x00000000000000000000000000000000000c0ffe';
const TOKEN_NO_CODE = '0x000000000000000000000000000000000000beef';
const coder = AbiCoder.defaultAbiCoder();

interface FakeState {
  rootHook: string;
  owner: string;
  rootValidator: string;
  list: SpendingLimit[];
  code: Record<string, string>;
}

function fakeNode(state: FakeState): JsonRpcTransport {
  return async (method, params) => {
    if (method === 'eth_getCode') return state.code[lower(params[0] as string)] ?? '0x';
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const { to, data } = params[0] as { to: string; data: string };
    const s = data.slice(0, 10);
    const t = lower(to);
    if (t === lower(ACCOUNT) && s === sel('rootValidator()')) return state.rootValidator.padEnd(66, '0');
    if (t === lower(ACCOUNT) && s === sel('validationConfig(bytes21)')) return coder.encode(['uint32', 'address'], [1, state.rootHook]);
    if (t === lower(KERNEL_V3_3.ecdsaValidator) && s === sel('ecdsaValidatorStorage(address)')) return coder.encode(['address'], [state.owner]);
    if (s === sel('listLength(address)')) return coder.encode(['uint256'], [state.list.length]);
    if (s === sel('spendingLimit(uint256,address)')) {
      const [i] = coder.decode(['uint256', 'address'], '0x' + data.slice(10));
      const e = state.list[Number(i)]!;
      return coder.encode(['address', 'uint256'], [e.token, e.allowance]);
    }
    if (s === sel('balanceOf(address)')) return coder.encode(['uint256'], [0]);
    throw new Error(`unexpected eth_call ${to} ${s}`);
  };
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    rootHook: KERNEL_HOOK_NONE,
    owner: OWNER,
    rootValidator: ecdsaRootValidationId(),
    list: [],
    code: {
      [lower(ZERODEV_SPENDING_LIMIT_HOOK.address)]: HOOK_RUNTIME,
      // A synthetic contract whose dispatcher has PUSH4 postCheck(bytes).
      [lower(COMPATIBLE_HOOK)]: '0x60' + '00' + '63' + HOOK_POSTCHECK_KERNEL_V3_1.slice(2) + '14',
      [lower(USDC_SEPOLIA)]: '0x6001',
    },
    ...overrides,
  };
}

describe('assessHookInterface', () => {
  it('identifies the pinned ZeroDev hook as incompatible with Kernel v3.3', async () => {
    const a = await assessHookInterface(fakeNode(baseState()), ZERODEV_SPENDING_LIMIT_HOOK.address);
    expect(a).toMatchObject({
      hasCode: true,
      isZeroDevSpendingLimit: true,
      implementsKernelV31PostCheck: false,
      implementsKernelV30PostCheck: true,
      compatibleWithKernelV3_3: false,
    });
  });
  it('accepts a contract dispatching postCheck(bytes); refuses no code', async () => {
    expect((await assessHookInterface(fakeNode(baseState()), COMPATIBLE_HOOK)).compatibleWithKernelV3_3).toBe(true);
    const none = await assessHookInterface(fakeNode(baseState()), TOKEN_NO_CODE);
    expect(none).toMatchObject({ hasCode: false, compatibleWithKernelV3_3: false });
  });
});

describe('readSpendingLimitHookState', () => {
  it('decodes the list and the root hook', async () => {
    const st = await readSpendingLimitHookState(
      fakeNode(baseState({ rootHook: ZERODEV_SPENDING_LIMIT_HOOK.address, list: [{ token: NATIVE, allowance: 400n }] })),
      ACCOUNT,
    );
    expect(st).toMatchObject({ initialized: true, attachedToRoot: true, limits: [{ token: NATIVE, allowance: 400n }] });
    expect(st.rootValidator).toBe(ecdsaRootValidationId());
    const empty = await readSpendingLimitHookState(fakeNode(baseState()), ACCOUNT);
    expect(empty).toMatchObject({ initialized: false, attachedToRoot: false, rootHook: KERNEL_HOOK_NONE });
  });
});

describe('prepareRootSpendingLimitInstall', () => {
  const params = { account: ACCOUNT, owner: OWNER, limits: LIMITS };
  it('REFUSES the deployed ZeroDev hook (Kernel v3.3 cannot call its postCheck)', async () => {
    await expect(prepareRootSpendingLimitInstall(fakeNode(baseState()), params)).rejects.toBeInstanceOf(
      SpendingLimitHookIncompatibleError,
    );
    await expect(prepareRootSpendingLimitInstall(fakeNode(baseState()), params)).rejects.toThrow(/0x173bf7da/);
  });
  it('builds the batch for a compatible hook after all read-only checks', async () => {
    const p = await prepareRootSpendingLimitInstall(fakeNode(baseState()), { ...params, hook: COMPATIBLE_HOOK });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0]!.to).toBe(KERNEL_V3_3.ecdsaValidator);
    expect(toHex(p.calls[1]!.data)).toBe(toHex(encodeRootSpendingLimitInstall(OWNER, LIMITS, { hook: COMPATIBLE_HOOK })));
  });
  it.each([
    ['a different stored owner', { owner: '0x000000000000000000000000000000000000dEaD' }, /hand over the account/],
    ['a non-ECDSA root', { rootValidator: '0x02deadbeef' }, /not the ECDSA validator/],
    ['an existing root hook', { rootHook: COMPATIBLE_HOOK }, /already has hook/],
    ['a stale list in the hook', { list: [{ token: NATIVE, allowance: 1n }] }, /already holds/],
  ])('refuses %s', async (_label, overrides, pattern) => {
    await expect(
      prepareRootSpendingLimitInstall(fakeNode(baseState(overrides as Partial<FakeState>)), { ...params, hook: COMPATIBLE_HOOK }),
    ).rejects.toThrow(pattern);
  });
  it('refuses a token without code (the hook would revert in every operation)', async () => {
    await expect(
      prepareRootSpendingLimitInstall(fakeNode(baseState()), {
        ...params,
        hook: COMPATIBLE_HOOK,
        limits: [{ token: TOKEN_NO_CODE, allowance: 1n }],
      }),
    ).rejects.toThrow(/no contract code/);
  });
  it('refuses tokens outside knownTokens before any network access', async () => {
    const node: JsonRpcTransport = async () => {
      throw new Error('network touched');
    };
    await expect(
      prepareRootSpendingLimitInstall(node, { ...params, hook: COMPATIBLE_HOOK, knownTokens: [] }),
    ).rejects.toThrow(/not a known token/);
  });
});

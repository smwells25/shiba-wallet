import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, getAddress, id, keccak256 } from 'ethers';
import {
  DCA_AMOUNT_MISMATCH_REFUSAL,
  DCA_AMOUNT_REFUSAL,
  DCA_APPROVE_SELECTOR,
  DCA_BATCH_REFUSAL,
  DCA_DEADLINE_ROUTER_REFUSAL,
  DCA_EXACT_INPUT_SINGLE_SELECTOR,
  DCA_FEE_BUDGET_REFUSAL,
  DCA_FEE_TIER_REFUSAL,
  DCA_FLOOR_ZERO_REFUSAL,
  DCA_MINIMUM_BELOW_FLOOR_REFUSAL,
  DCA_NATIVE,
  DCA_NATIVE_OUT_REFUSAL,
  DCA_PAIR_MISMATCH_REFUSAL,
  DCA_PARAM_OFFSETS,
  DCA_PINNED_POOLS,
  DCA_PRICE_LIMIT_REFUSAL,
  DCA_RECIPIENT_REFUSAL,
  DCA_SAME_TOKEN_REFUSAL,
  DCA_UNKNOWN_POOL_REFUSAL,
  DCA_UNKNOWN_ROUTER_REFUSAL,
  DCA_UNPINNABLE_ROUTER_REFUSAL,
  DCA_UNSUPPORTED_CHAIN_REFUSAL,
  SWAP_ROUTER_V1_EXACT_INPUT_SINGLE_SELECTOR,
  UNISWAP_V3_SEPOLIA,
  UNISWAP_V3_SWAP_TOPIC,
  assertDcaSwap,
  buildDcaSwapCall,
  buildDcaSwapCalls,
  dcaFloorFromQuote,
  dcaGrantFor,
  dcaMinimumOutFor,
  dcaPinnedPool,
  dcaTermsMatchGrant,
  dcaValidUntil,
  decodeDcaOutcome,
  decodeDcaSwapData,
  describeDca,
  encodeDcaSwapData,
  kernelDcaSpec,
  parseDcaTerms,
  quoteDcaSwap,
  readDcaPool,
  serializeDcaTerms,
  validateDcaTerms,
  type DcaLog,
  type DcaTerms,
} from '../src/kernel-dca.js';
import {
  KERNEL_PERMISSION_MODULES,
  assertCallsAllowed,
  encodePermissionInstall,
  kernelPermissionFromGrant,
} from '../src/kernel-permissions.js';
import { SUBSCRIPTION_NATIVE, subscriptionToGrant } from '../src/kernel-subscription.js';
import { encodeKernelExecute } from '../src/kernel-account.js';
import { ENTRYPOINT_V07 } from '../src/userop.js';
import { toBytes, toHex } from '../src/encoding.js';
import type { Call } from '../src/smart-account.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const ACCOUNT = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const SESSION = '0x484B87B8D4D73d88ccF7D39C006cC1b078384640';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const WETH = UNISWAP_V3_SEPOLIA.weth9;
const ROUTER = UNISWAP_V3_SEPOLIA.swapRouter02;
const POOL_500 = '0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1';
const S = 1790000000;
const OTHER = '0x000000000000000000000000000000000000bEEF';

function nativeTerms(over: Partial<DcaTerms> = {}): DcaTerms {
  return {
    chainId: 11155111n,
    account: ACCOUNT,
    router: ROUTER,
    tokenIn: DCA_NATIVE,
    tokenOut: USDC,
    fee: 500,
    amountIn: 10_000_000_000_000n,
    minimumOut: 445_000n,
    periodSeconds: 120,
    count: 2,
    startAt: S,
    feeBudgetWei: 4_000_000_000_000_000n,
    label: 'DCA test',
    ...over,
  };
}

function usdcInTerms(over: Partial<DcaTerms> = {}): DcaTerms {
  return nativeTerms({ tokenIn: USDC, tokenOut: WETH, amountIn: 1_000_000n, minimumOut: 20_000_000_000_000n, ...over });
}

/** SwapRouter02's ABI fragment, written out independently for ethers. */
const ROUTER_IFACE = new Interface([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);

const PERMISSION_TUPLE = 'tuple(bytes1,address,bytes4,uint256,tuple(uint8,uint64,bytes32[])[])[]';
const pad = (v: bigint | string) =>
  '0x' + (typeof v === 'string' ? BigInt(v.toLowerCase()) : v).toString(16).padStart(64, '0');

describe('SwapRouter02 call shape', () => {
  it('selectors are computed from the signatures (SwapRouter02 vs the deadline-bearing v1)', () => {
    expect(DCA_EXACT_INPUT_SINGLE_SELECTOR).toBe('0x04e45aaf');
    expect(DCA_EXACT_INPUT_SINGLE_SELECTOR).toBe(ROUTER_IFACE.getFunction('exactInputSingle')!.selector);
    expect(SWAP_ROUTER_V1_EXACT_INPUT_SINGLE_SELECTOR).toBe('0x414bf389');
    expect(SWAP_ROUTER_V1_EXACT_INPUT_SINGLE_SELECTOR).toBe(
      id('exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))').slice(0, 10),
    );
    expect(DCA_APPROVE_SELECTOR).toBe('0x095ea7b3');
  });

  it('encodeDcaSwapData is byte-identical to ethers and decodes back; fields sit at the pinned offsets', () => {
    const params = {
      tokenIn: WETH,
      tokenOut: USDC,
      fee: 500,
      recipient: ACCOUNT,
      amountIn: 10_000_000_000_000n,
      amountOutMinimum: 445_000n,
      sqrtPriceLimitX96: 0n,
    };
    const ours = encodeDcaSwapData(params);
    expect(toHex(ours)).toBe(ROUTER_IFACE.encodeFunctionData('exactInputSingle', [params]));
    expect(ours.length).toBe(4 + 7 * 32);
    const back = decodeDcaSwapData(ours);
    expect(getAddress(back.tokenIn)).toBe(WETH);
    expect(getAddress(back.recipient)).toBe(ACCOUNT);
    expect(back.amountOutMinimum).toBe(445_000n);
    const wordAt = (offset: number) => toHex(ours.slice(4 + offset, 4 + offset + 32));
    expect(wordAt(DCA_PARAM_OFFSETS.tokenIn)).toBe(pad(WETH));
    expect(wordAt(DCA_PARAM_OFFSETS.tokenOut)).toBe(pad(USDC));
    expect(wordAt(DCA_PARAM_OFFSETS.fee)).toBe(pad(500n));
    expect(wordAt(DCA_PARAM_OFFSETS.recipient)).toBe(pad(ACCOUNT));
    expect(wordAt(DCA_PARAM_OFFSETS.amountIn)).toBe(pad(10_000_000_000_000n));
    expect(wordAt(DCA_PARAM_OFFSETS.amountOutMinimum)).toBe(pad(445_000n));
    expect(wordAt(DCA_PARAM_OFFSETS.sqrtPriceLimitX96)).toBe(pad(0n));
  });

  it('decodeDcaSwapData refuses another selector, another length and dirty words', () => {
    const good = buildDcaSwapCall(nativeTerms()).data;
    const other = good.slice();
    other[0] = 0x41;
    expect(() => decodeDcaSwapData(other)).toThrow(/Not a SwapRouter02/);
    expect(() => decodeDcaSwapData(new Uint8Array([...good, 0]))).toThrow(/exactly 228 bytes/);
    const dirtyFee = good.slice();
    dirtyFee[4 + 64 + 28] = 0x01; // bit above uint24
    expect(() => decodeDcaSwapData(dirtyFee)).toThrow(/uint24/);
    const dirtyAddress = good.slice();
    dirtyAddress[4 + 96] = 0x01;
    expect(() => decodeDcaSwapData(dirtyAddress)).toThrow(/clean address/);
  });
});

describe('pinned deployment and pools', () => {
  it('addresses are checksummed and every pool lists token0 < token1', () => {
    for (const a of Object.values(UNISWAP_V3_SEPOLIA).filter((v) => typeof v === 'string' && v.startsWith('0x'))) {
      expect(getAddress(a as string)).toBe(a);
    }
    for (const p of DCA_PINNED_POOLS) {
      expect(getAddress(p.pool)).toBe(p.pool);
      expect(BigInt(p.token0) < BigInt(p.token1)).toBe(true);
    }
    expect(dcaPinnedPool(11155111n, WETH, USDC, 500)?.pool).toBe(POOL_500);
    expect(dcaPinnedPool(11155111n, USDC, WETH, 500)?.pool).toBe(POOL_500);
    expect(dcaPinnedPool(11155111n, USDC, WETH, 2500)).toBeNull();
    expect(dcaPinnedPool(1n, USDC, WETH, 500)).toBeNull();
  });
});

describe('the grant: the subscription template with a pinned swap', () => {
  it('every policy except CallPolicy, and the signer entry, are byte-identical to a subscription with the same window, budget and rate', () => {
    const terms = nativeTerms();
    const dca = kernelPermissionFromGrant(dcaGrantFor(terms, SESSION, { now: null }));
    const sub = kernelPermissionFromGrant(
      subscriptionToGrant(
        {
          merchant: OTHER,
          token: SUBSCRIPTION_NATIVE,
          amountPerPeriod: 1000n,
          periodSeconds: terms.periodSeconds,
          startAt: terms.startAt,
          validUntil: dcaValidUntil(terms),
          feeBudgetWei: terms.feeBudgetWei,
          label: 'same template',
        },
        SESSION,
        { now: null },
      ),
    );
    expect(dca.policies.map((p) => [p.flag, p.module])).toEqual(sub.policies.map((p) => [p.flag, p.module]));
    expect(dca.policies.map((p) => p.module)).toEqual([
      KERNEL_PERMISSION_MODULES.callPolicy,
      KERNEL_PERMISSION_MODULES.timestampPolicy,
      KERNEL_PERMISSION_MODULES.gasPolicy,
      KERNEL_PERMISSION_MODULES.rateLimitPolicy,
    ]);
    for (const i of [1, 2, 3]) expect(toHex(dca.policies[i]!.data)).toBe(toHex(sub.policies[i]!.data));
    expect(toHex(dca.policies[0]!.data)).not.toBe(toHex(sub.policies[0]!.data));
    expect(dca.signer).toEqual(sub.signer);
    expect(dca.signer.flag).toBe(0x0002); // SKIP_SIGNATURE
    // RateLimitPolicy: interval 120, count 2, startAt S (packed uint48 x3).
    expect(toHex(dca.policies[3]!.data)).toBe(
      '0x' + [120n, 2n, BigInt(S)].map((n) => n.toString(16).padStart(12, '0')).join(''),
    );
  });

  it('native CallPolicy data equals an independent ethers encoding of the Permission[]', () => {
    const terms = nativeTerms();
    const data = kernelPermissionFromGrant(dcaGrantFor(terms, SESSION, { now: null })).policies[0]!.data;
    const expected = AbiCoder.defaultAbiCoder().encode(
      [PERMISSION_TUPLE],
      [
        [
          [
            '0x00',
            ROUTER,
            '0x04e45aaf',
            10_000_000_000_000n,
            [
              [0, 0, [pad(WETH)]],
              [0, 32, [pad(USDC)]],
              [0, 64, [pad(500n)]],
              [0, 96, [pad(ACCOUNT)]],
              [0, 128, [pad(10_000_000_000_000n)]],
              [3, 160, [pad(445_000n)]],
              [0, 192, [pad(0n)]],
            ],
          ],
        ],
      ],
    );
    expect(toHex(data)).toBe(expected);
    // Pinned hash of the bytes above, so any drift in the encoder is visible.
    expect(keccak256(data)).toBe('0xafdbb2979ee4da05916447ef271bb7de0456db4359b3ba83447d981805dbd433');
  });

  it('ERC-20 sale: approve(router, amountIn) EQUAL both words, then the swap with value 0', () => {
    const terms = usdcInTerms();
    const grant = dcaGrantFor(terms, SESSION, { now: null });
    expect(grant.calls).toHaveLength(2);
    const [approve, swap] = grant.calls;
    expect(approve!.target).toBe(USDC);
    expect(approve!.selector).toBe(DCA_APPROVE_SELECTOR);
    expect(approve!.valueLimit).toBe(0n);
    expect(approve!.rules).toEqual([
      { condition: 'equal', offset: 0, params: [pad(ROUTER)] },
      { condition: 'equal', offset: 32, params: [pad(1_000_000n)] },
    ]);
    expect(swap!.valueLimit).toBe(0n);
    expect(swap!.rules![0]!.params[0]).toBe(pad(USDC));
    expect(swap!.rules![1]!.params[0]).toBe(pad(WETH));
    const data = kernelPermissionFromGrant(grant).policies[0]!.data;
    const expected = AbiCoder.defaultAbiCoder().encode(
      [PERMISSION_TUPLE],
      [
        [
          ['0x00', USDC, '0x095ea7b3', 0n, [[0, 0, [pad(ROUTER)]], [0, 32, [pad(1_000_000n)]]]],
          [
            '0x00',
            ROUTER,
            '0x04e45aaf',
            0n,
            [
              [0, 0, [pad(USDC)]],
              [0, 32, [pad(WETH)]],
              [0, 64, [pad(500n)]],
              [0, 96, [pad(ACCOUNT)]],
              [0, 128, [pad(1_000_000n)]],
              [3, 160, [pad(20_000_000_000_000n)]],
              [0, 192, [pad(0n)]],
            ],
          ],
        ],
      ],
    );
    expect(toHex(data)).toBe(expected);
  });

  it('window, rate limit and budget: validUntil = start + count x period (+ grace); the count never grows', () => {
    const g = dcaGrantFor(nativeTerms({ graceSeconds: 120 }), SESSION, { now: null });
    expect(g.validAfter).toBe(S);
    expect(g.validUntil).toBe(S + 2 * 120 + 120);
    expect(g.rateLimit).toEqual({ count: 2, intervalSeconds: 120, startAt: S });
    expect(g.gasBudgetWei).toBe(4_000_000_000_000_000n);
  });

  it('permission install builds (4 policies) and dcaTermsMatchGrant ties terms to a grant', () => {
    const grant = dcaGrantFor(nativeTerms(), SESSION, { now: null });
    const inst = encodePermissionInstall(grant, {
      chainId: 11155111n,
      account: ACCOUNT,
      currentNonce: 1,
      validationNonce: 0,
      now: S - 10,
    });
    expect(inst.policyCount).toBe(4);
    expect(dcaTermsMatchGrant(nativeTerms(), grant)).toBe(true);
    expect(dcaTermsMatchGrant(nativeTerms({ minimumOut: 444_999n }), grant)).toBe(false);
    expect(dcaTermsMatchGrant(nativeTerms({ count: 3 }), grant)).toBe(false);
  });
});

describe('validateDcaTerms refusals', () => {
  const cases: Array<[string, Partial<DcaTerms>, string | RegExp]> = [
    ['a floor of 0', { minimumOut: 0n }, DCA_FLOOR_ZERO_REFUSAL],
    ['a recipient other than the account', { recipient: OTHER }, DCA_RECIPIENT_REFUSAL],
    ['the deadline-bearing SwapRouter v1', { router: '0xE592427A0AEce92De3Edee1F18E0157C05861564' }, DCA_DEADLINE_ROUTER_REFUSAL],
    ['the Universal Router', { router: '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b' }, DCA_UNPINNABLE_ROUTER_REFUSAL],
    ['an unknown router', { router: OTHER }, DCA_UNKNOWN_ROUTER_REFUSAL],
    ['an unknown pool (another token)', { tokenOut: '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4' }, DCA_UNKNOWN_POOL_REFUSAL],
    ['an unsupported chain', { chainId: 1n }, DCA_UNSUPPORTED_CHAIN_REFUSAL],
    ['the same token in and out', { tokenOut: WETH }, DCA_SAME_TOKEN_REFUSAL],
    ['buying the native currency', { tokenOut: DCA_NATIVE }, DCA_NATIVE_OUT_REFUSAL],
    ['a fee that is not a tier', { fee: 2500 }, DCA_FEE_TIER_REFUSAL],
    ['an amount of 0 (the router-balance flag)', { amountIn: 0n }, DCA_AMOUNT_REFUSAL],
    ['no fee budget', { feeBudgetWei: 0n }, DCA_FEE_BUDGET_REFUSAL],
    ['a period under 60 s', { periodSeconds: 30 }, /at least 60/],
    ['zero swaps', { count: 0 }, /number of swaps/],
    ['an empty name', { label: ' ' }, /name of 1 to/],
    ['a direction override in the name', { label: 'ab‮cd' }, /control or direction/],
    ['the account as the token bought', { tokenOut: ACCOUNT }, /own account/],
  ];
  it.each(cases)('refuses %s', (_name, over, message) => {
    expect(() => validateDcaTerms(nativeTerms(over), { now: null })).toThrow(message);
    expect(() => dcaGrantFor(nativeTerms(over), SESSION, { now: null })).toThrow(message);
  });

  it('refuses a plan that has already ended, and accepts the defaults', () => {
    expect(() => validateDcaTerms(nativeTerms(), { now: S + 241 })).toThrow(/already have ended/);
    expect(() => validateDcaTerms(nativeTerms(), { now: S })).not.toThrow();
    expect(() => validateDcaTerms(usdcInTerms(), { now: S })).not.toThrow();
  });
});

describe('assertDcaSwap and the CallPolicy mirror', () => {
  const swapWith = (over: Partial<Parameters<typeof encodeDcaSwapData>[0]>, value = 10_000_000_000_000n): Call => ({
    to: ROUTER,
    value,
    data: encodeDcaSwapData({
      tokenIn: WETH,
      tokenOut: USDC,
      fee: 500,
      recipient: ACCOUNT,
      amountIn: 10_000_000_000_000n,
      amountOutMinimum: 445_000n,
      sqrtPriceLimitX96: 0n,
      ...over,
    }),
  });

  it('accepts the built call at the floor and above it', () => {
    const t = nativeTerms();
    expect(() => assertDcaSwap(t, SESSION, buildDcaSwapCalls(t), S)).not.toThrow();
    expect(() => assertDcaSwap(t, SESSION, buildDcaSwapCalls(t, { minimumOut: 460_000n }), S + 1)).not.toThrow();
    expect(() => assertDcaSwap(usdcInTerms(), SESSION, buildDcaSwapCalls(usdcInTerms()), S)).not.toThrow();
  });

  const refusals: Array<[string, Call[], string | RegExp, RegExp]> = [
    ['a lower floor', [swapWith({ amountOutMinimum: 444_999n })], DCA_MINIMUM_BELOW_FLOOR_REFUSAL, /offset 160 violates/],
    ['another recipient', [swapWith({ recipient: OTHER })], DCA_RECIPIENT_REFUSAL, /offset 96 violates/],
    ['another tokenOut', [swapWith({ tokenOut: '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4' })], DCA_PAIR_MISMATCH_REFUSAL, /offset 32 violates/],
    ['another fee tier', [swapWith({ fee: 3000 })], DCA_PAIR_MISMATCH_REFUSAL, /offset 64 violates/],
    ['a larger amountIn', [swapWith({ amountIn: 10_000_000_000_001n }, 10_000_000_000_001n)], DCA_AMOUNT_MISMATCH_REFUSAL, /exceeds the session's cap/],
    ['a smaller amountIn', [swapWith({ amountIn: 1n })], DCA_AMOUNT_MISMATCH_REFUSAL, /offset 128 violates/],
    ['a price limit', [swapWith({ sqrtPriceLimitX96: 1n })], DCA_PRICE_LIMIT_REFUSAL, /offset 192 violates/],
    ['more value than amountIn', [swapWith({}, 10_000_000_000_001n)], /exactly the amount sold/, /exceeds the session's cap/],
    ['a batch of two swaps', [swapWith({}), swapWith({})], DCA_BATCH_REFUSAL, /^$/],
  ];
  it.each(refusals)('refuses %s locally, and the CallPolicy mirror agrees where the account would refuse', (_n, calls, local, mirror) => {
    const t = nativeTerms();
    expect(() => assertDcaSwap(t, SESSION, calls, S)).toThrow(local);
    const grant = dcaGrantFor(t, SESSION, { now: null });
    if (mirror.source === '^$') {
      // The account itself ACCEPTS a batch of in-rule swaps (the batching limit); only the local check refuses.
      expect(() => assertCallsAllowed(grant, calls, S)).not.toThrow();
    } else {
      expect(() => assertCallsAllowed(grant, calls, S)).toThrow(mirror);
    }
  });

  it('refuses trailing calldata, another router, a stray approve, and outside the window', () => {
    const t = nativeTerms();
    const good = buildDcaSwapCall(t);
    expect(() => assertDcaSwap(t, SESSION, [{ ...good, data: new Uint8Array([...good.data, 0]) }], S)).toThrow(/228 bytes/);
    expect(() => assertDcaSwap(t, SESSION, [{ ...good, to: OTHER }], S)).toThrow(DCA_UNKNOWN_ROUTER_REFUSAL);
    expect(() => assertDcaSwap(t, SESSION, [good], S - 1)).toThrow(/not valid until/);
    expect(() => assertDcaSwap(t, SESSION, [good], dcaValidUntil(t))).toThrow(/expired/);
    const u = usdcInTerms();
    const [approve, swap] = buildDcaSwapCalls(u);
    expect(() => assertDcaSwap(u, SESSION, [swap!], S)).toThrow(DCA_BATCH_REFUSAL);
    expect(() =>
      assertDcaSwap(u, SESSION, [{ ...approve!, data: buildDcaSwapCalls(usdcInTerms({ amountIn: 2_000_000n }))[0]!.data }, swap!], S),
    ).toThrow(DCA_BATCH_REFUSAL);
    expect(() => assertDcaSwap(u, SESSION, [approve!, { ...swap!, value: 1n }], S)).toThrow(/must not send any ETH/);
  });

  it('buildDcaSwapCall refuses a minimum below the floor; dcaMinimumOutFor never goes below it', () => {
    expect(() => buildDcaSwapCall(nativeTerms(), { minimumOut: 1n })).toThrow(DCA_MINIMUM_BELOW_FLOOR_REFUSAL);
    expect(dcaMinimumOutFor(nativeTerms(), 468_502n, 100)).toBe(463_816n);
    expect(dcaMinimumOutFor(nativeTerms(), 400_000n, 100)).toBe(445_000n);
    expect(() => dcaMinimumOutFor(nativeTerms(), 1n, 10_000)).toThrow(/below 10000/);
    expect(dcaFloorFromQuote(468_502n, 9_500)).toBe(445_076n);
    expect(() => dcaFloorFromQuote(1n, 9_500)).toThrow(DCA_FLOOR_ZERO_REFUSAL);
    expect(() => dcaFloorFromQuote(1000n, 0)).toThrow(/basis points/);
  });

  it('kernelDcaSpec refuses before encoding; an in-plan period encodes as Kernel execute', () => {
    const t = nativeTerms();
    const spec = kernelDcaSpec({ account: ACCOUNT, sessionKey: SESSION, permissionId: '0x11223344', terms: t, now: () => S });
    const calls = buildDcaSwapCalls(t);
    expect(toHex(spec.encodeCalls(calls))).toBe(toHex(encodeKernelExecute(calls)));
    expect(() => spec.encodeCalls([...calls, ...calls])).toThrow(DCA_BATCH_REFUSAL);
    expect(() => kernelDcaSpec({ account: OTHER, sessionKey: SESSION, permissionId: '0x11223344', terms: t })).toThrow(
      /another account/,
    );
  });
});

describe('decodeDcaOutcome', () => {
  const swapLog = (recipient: string, amount0: bigint, amount1: bigint, pool = POOL_500): DcaLog => ({
    address: pool,
    topics: [UNISWAP_V3_SWAP_TOPIC, pad(ROUTER), pad(recipient)],
    data:
      '0x' +
      [BigInt.asUintN(256, amount0), BigInt.asUintN(256, amount1), 2n ** 96n, 10n ** 16n, BigInt.asUintN(256, 168766n)]
        .map((n) => n.toString(16).padStart(64, '0'))
        .join(''),
  });
  const transferLog = (from: string, to: string, value: bigint): DcaLog => ({
    address: USDC,
    topics: [id('Transfer(address,address,uint256)'), pad(from), pad(to)],
    data: pad(value),
  });
  const USER_OP_HASH = '0x' + 'ab'.repeat(32);
  const userOpEvent = (success: boolean): DcaLog => ({
    address: ENTRYPOINT_V07,
    topics: [id('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'), USER_OP_HASH, pad(ACCOUNT), pad(0n)],
    data: '0x' + [0n, success ? 1n : 0n, 1n, 1n].map((n) => n.toString(16).padStart(64, '0')).join(''),
  });

  it('reads the Swap event (USDC is token0, so amount0 < 0 is the output) and the USDC Transfer', () => {
    expect(UNISWAP_V3_SWAP_TOPIC).toBe(id('Swap(address,address,int256,int256,uint160,uint128,int24)'));
    const t = nativeTerms();
    const out = decodeDcaOutcome(
      t,
      [
        swapLog(ACCOUNT, -468_502n, 10_000_000_000_000n),
        transferLog(POOL_500, ACCOUNT, 468_502n),
        swapLog(OTHER, -1n, 1n), // someone else's swap in the same bundle
        swapLog(ACCOUNT, -5n, 5n, '0xFeEd501c2B21D315F04946F85fC6416B640240b5'), // another pool
        transferLog(OTHER, ACCOUNT, 7n),
        userOpEvent(true),
      ],
      { userOpHash: USER_OP_HASH },
    );
    expect(out.swaps).toHaveLength(1);
    expect(out.amountIn).toBe(10_000_000_000_000n);
    expect(out.amountOut).toBe(468_502n);
    expect(out.tokenOutReceived).toBe(468_502n);
    expect(out.swaps[0]!.tick).toBe(168766);
    expect(out.batched).toBe(false);
    expect(out.atOrAboveFloor).toBe(true);
    expect(out.userOpSuccess).toBe(true);
  });

  it('flags a batched operation, a below-floor swap, and a reverted operation with its reason', () => {
    const t = nativeTerms();
    const batched = decodeDcaOutcome(t, [swapLog(ACCOUNT, -445_000n, 1n), swapLog(ACCOUNT, -444_000n, 1n)]);
    expect(batched.batched).toBe(true);
    expect(batched.atOrAboveFloor).toBe(false);
    // "Too little received" as Error(string), inside UserOperationRevertReason(bytes32,address,uint256,bytes).
    const reason = new Interface(['function Error(string)']).encodeFunctionData('Error', ['Too little received']);
    const revertData = AbiCoder.defaultAbiCoder().encode(['uint256', 'bytes'], [0n, reason]);
    const reverted = decodeDcaOutcome(
      t,
      [
        userOpEvent(false),
        {
          address: ENTRYPOINT_V07,
          topics: [id('UserOperationRevertReason(bytes32,address,uint256,bytes)'), USER_OP_HASH, pad(ACCOUNT)],
          data: revertData,
        },
      ],
      { userOpHash: USER_OP_HASH },
    );
    expect(reverted.userOpSuccess).toBe(false);
    expect(reverted.revertReason).toBe(reason);
    expect(reverted.swaps).toHaveLength(0);
    expect(reverted.atOrAboveFloor).toBe(false);
  });
});

describe('chain reads with a fake node', () => {
  const word = (v: bigint) => v.toString(16).padStart(64, '0');
  function fakeNode(overrides: { getPool?: string; liquidity?: bigint } = {}): JsonRpcTransport {
    return async (method, params) => {
      if (method !== 'eth_call') throw new Error(method);
      const [{ to, data }] = params as [{ to: string; data: string }];
      const sel = data.slice(0, 10);
      const is = (sig: string) => sel === id(sig).slice(0, 10);
      if (to.toLowerCase() === UNISWAP_V3_SEPOLIA.factory.toLowerCase() && is('getPool(address,address,uint24)')) {
        return '0x' + word(BigInt(overrides.getPool ?? POOL_500));
      }
      if (to.toLowerCase() === POOL_500.toLowerCase()) {
        if (is('factory()')) return '0x' + word(BigInt(UNISWAP_V3_SEPOLIA.factory));
        if (is('token0()')) return '0x' + word(BigInt(USDC));
        if (is('token1()')) return '0x' + word(BigInt(WETH));
        if (is('fee()')) return '0x' + word(500n);
        if (is('liquidity()')) return '0x' + word(overrides.liquidity ?? 13_156_596_607_651_858n);
        if (is('slot0()')) return '0x' + word(365944358770364464240144831924066n) + word(168766n) + word(0n).repeat(5);
      }
      if (to.toLowerCase() === UNISWAP_V3_SEPOLIA.quoterV2.toLowerCase()) {
        expect(sel).toBe(id('quoteExactInputSingle((address,address,uint256,uint24,uint160))').slice(0, 10));
        return '0x' + word(468_502n) + word(1n) + word(1n) + word(98_332n);
      }
      throw new Error(`unexpected call to ${to} ${sel}`);
    };
  }

  it('readDcaPool checks the factory and the pool facts; quoteDcaSwap decodes QuoterV2', async () => {
    const state = await readDcaPool(fakeNode(), nativeTerms());
    expect(state.pool).toBe(POOL_500);
    expect(state.tick).toBe(168766);
    await expect(readDcaPool(fakeNode({ getPool: OTHER }), nativeTerms())).rejects.toThrow(/not the pinned/);
    await expect(readDcaPool(fakeNode({ liquidity: 0n }), nativeTerms())).rejects.toThrow(/no liquidity/);
    const q = await quoteDcaSwap(fakeNode(), nativeTerms());
    expect(q.amountOut).toBe(468_502n);
    expect(q.gasEstimate).toBe(98_332n);
  });
});

describe('storage and plain language', () => {
  it('serialize / parse round-trips and re-validates', () => {
    const t = nativeTerms({ graceSeconds: 60 });
    const back = parseDcaTerms(JSON.parse(JSON.stringify(serializeDcaTerms(t))));
    expect(back).toEqual(t);
    expect(() => parseDcaTerms({ ...serializeDcaTerms(t), minimumOut: '0' })).toThrow(DCA_FLOOR_ZERO_REFUSAL);
    expect(() => parseDcaTerms({ ...serializeDcaTerms(t), version: 2 })).toThrow(/version-1/);
  });

  it('describeDca puts the static-floor caveat first and states no deadline and the batching limit', () => {
    const d = describeDca(nativeTerms(), { symbolIn: 'test ETH', decimalsIn: 18, symbolOut: 'USDC', decimalsOut: 6, nativeSymbol: 'test ETH' });
    expect(d.sentence).toBe(
      'Swaps 0.00001 test ETH for USDC every 2 minutes, 2 times, until 2026-09-21 14:17 UTC; each swap must return at least 0.445 USDC.',
    );
    expect(d.caveats[0]).toMatch(/^THE MINIMUM DOES NOT FOLLOW THE PRICE/);
    expect(d.caveats.join(' ')).toMatch(/no deadline/);
    expect(d.caveats.join(' ')).toMatch(/ONE OPERATION CAN HOLD SEVERAL SWAPS/);
    expect(d.caveats.join(' ')).toMatch(/stays in the router/);
    expect(d.enforced[0]).toContain(POOL_500);
    const e = describeDca(usdcInTerms(), { symbolIn: 'USDC', decimalsIn: 6, symbolOut: 'WETH', decimalsOut: 18 });
    expect(e.caveats.join(' ')).not.toMatch(/stays in the router/);
    expect(toBytes(DCA_EXACT_INPUT_SINGLE_SELECTOR)).toHaveLength(4);
  });
});

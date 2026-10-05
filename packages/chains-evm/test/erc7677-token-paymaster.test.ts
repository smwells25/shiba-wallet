import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, getAddress, id, keccak256, solidityPacked } from 'ethers';
import {
  PIMLICO_ERC20_PAYMASTER_V07,
  PIMLICO_USER_OPERATION_SPONSORED_TOPIC,
  createErc7677TokenPaymasterTransport,
  decodePimlicoSponsoredEvents,
  encodePimlicoErc20PaymasterData,
  erc7677MaxTokenCharge,
  erc7677PaymasterDataProblems,
  erc7677TokenApproveCall,
  parsePimlicoErc20PaymasterData,
  pimlicoCostInToken,
  pimlicoErc20PaymasterHash,
  pimlicoPaymasterProblems,
  type PimlicoErc20PaymasterData,
} from '../src/erc7677-token-paymaster.js';
import { TokenGasChargeAboveLimitError } from '../src/token-paymaster.js';
import { ENTRYPOINT_V07 } from '../src/userop.js';
import { toBytes, toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const PAYMASTER = PIMLICO_ERC20_PAYMASTER_V07.address;
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const ACCOUNT = '0x1D723b78e1D0D84Fd0531e2686285fb1B6414106';
const CHAIN = 11155111n;

/**
 * The stub paymasterData ZeroDev's Ethereum Sepolia endpoint returned on
 * 2026-10-04 for pm_getPaymasterStubData with context {token: USDC}
 * (paymaster 0x7777…834C, paymasterPostOpGasLimit 0x10d7e). Its signature
 * is the same dummy value Pimlico's documentation example shows.
 */
const LIVE_STUB =
  '0x03000000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c723800000000000000000000000000004a2e' +
  '00000000000000000000000000000000000000000000000000000000b2cdc40300000000000000000000000000000001d8baa1' +
  '07006c93a030d1455a2ef43261b384f21ccd91f19f0f19ce862d7bec7b7d9b95457145afc6f639c28fd0360f488937bfa41e6e' +
  'edcd3a46054fd95fcd0e3ef6b0bc0a615c4d975eef55c8a3517257904d5b1c';

function base(overrides: Partial<PimlicoErc20PaymasterData> = {}): Omit<PimlicoErc20PaymasterData, 'mode'> {
  return {
    allowAllBundlers: true,
    constantFeePresent: false,
    recipientPresent: false,
    preFundPresent: false,
    validUntil: 0n,
    validAfter: 0n,
    token: USDC,
    postOpGas: 18_990n,
    exchangeRate: 2_999_829_507n,
    paymasterValidationGasLimit: 1n,
    treasury: '0xd8baa107006c93a030d1455a2ef43261b384f21c',
    preFundInToken: 0n,
    constantFee: 0n,
    recipient: null,
    signature: new Uint8Array(65).fill(7),
    ...overrides,
  };
}

describe('Pimlico ERC-20 paymasterData', () => {
  it('decodes the live ZeroDev stub field by field', () => {
    const d = parsePimlicoErc20PaymasterData(toBytes(LIVE_STUB));
    expect(d.mode).toBe(1);
    expect(d.allowAllBundlers).toBe(true);
    expect([d.constantFeePresent, d.recipientPresent, d.preFundPresent]).toEqual([false, false, false]);
    expect(d.validUntil).toBe(0n);
    expect(d.validAfter).toBe(0n);
    expect(d.token).toBe(USDC);
    expect(d.postOpGas).toBe(18_990n);
    expect(d.exchangeRate).toBe(2_999_829_507n);
    expect(d.paymasterValidationGasLimit).toBe(1n);
    expect(d.treasury).toBe(getAddress('0xd8baa107006c93a030d1455a2ef43261b384f21c'));
    expect(d.signature.length).toBe(65);
  });

  it('round-trips with every optional field and matches ethers solidityPacked', () => {
    const fields = base({
      preFundPresent: true,
      preFundInToken: 12_345n,
      constantFeePresent: true,
      constantFee: 777n,
      recipientPresent: true,
      recipient: '0x00000000000000000000000000000000000000AA',
      validUntil: 1_900_000_000n,
      validAfter: 5n,
      allowAllBundlers: false,
    });
    const bytes = encodePimlicoErc20PaymasterData(fields);
    const packed = solidityPacked(
      ['uint8', 'uint8', 'uint48', 'uint48', 'address', 'uint128', 'uint256', 'uint128', 'address', 'uint128', 'uint128', 'address', 'bytes'],
      [2, 7, 1_900_000_000n, 5n, USDC, 18_990n, 2_999_829_507n, 1n, fields.treasury, 12_345n, 777n, fields.recipient, toHex(fields.signature)],
    );
    expect(toHex(bytes)).toBe(packed.toLowerCase());
    const back = parsePimlicoErc20PaymasterData(bytes);
    expect(back.preFundInToken).toBe(12_345n);
    expect(back.constantFee).toBe(777n);
    expect(back.recipient).toBe(getAddress(fields.recipient!));
    expect(back.allowAllBundlers).toBe(false);
  });

  it('applies the contract’s own refusals and refuses verifying mode', () => {
    const ok = encodePimlicoErc20PaymasterData(base());
    const verifying = ok.slice();
    verifying[0] = 0x01; // mode 0, allowAllBundlers
    expect(() => parsePimlicoErc20PaymasterData(verifying)).toThrow(/mode 0/);
    expect(() => parsePimlicoErc20PaymasterData(ok.slice(0, 100))).toThrow(/too short/);
    expect(() => parsePimlicoErc20PaymasterData(encodePimlicoErc20PaymasterData(base({ signature: new Uint8Array(63) })))).toThrow(/63 bytes/);
    const zeroRate = ok.slice();
    zeroRate.fill(0, 1 + 1 + 6 + 6 + 20 + 16, 1 + 1 + 6 + 6 + 20 + 16 + 32);
    expect(() => parsePimlicoErc20PaymasterData(zeroRate)).toThrow(/zero exchange rate/);
  });

  it('getHash matches an independent ethers computation of SingletonPaymasterV7._getHash', () => {
    const data = encodePimlicoErc20PaymasterData(base({ constantFeePresent: true, constantFee: 9n }));
    const op = {
      sender: ACCOUNT,
      nonce: 0x1234n,
      factory: '0xd703aaE79538628d27099B8c4f621bE4CCd142d5',
      factoryData: toBytes('0xabcdef'),
      callData: toBytes('0xe9ae5c53'),
      callGasLimit: 100_000n,
      verificationGasLimit: 200_000n,
      preVerificationGas: 50_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 200_000_000n,
      paymaster: PAYMASTER,
      paymasterVerificationGasLimit: 60_000n,
      paymasterPostOpGasLimit: 69_000n,
      paymasterData: data,
    };
    const coder = AbiCoder.defaultAbiCoder();
    const accountGasLimits = solidityPacked(['uint128', 'uint128'], [op.verificationGasLimit, op.callGasLimit]);
    const gasFees = solidityPacked(['uint128', 'uint128'], [op.maxPriorityFeePerGas, op.maxFeePerGas]);
    const covered = 1 + 117 + 16; // mode byte, config, constant fee
    const pad = solidityPacked(
      ['address', 'uint128', 'uint128', 'bytes'],
      [op.paymaster, op.paymasterVerificationGasLimit, op.paymasterPostOpGasLimit, toHex(data.slice(0, covered))],
    );
    const inner = keccak256(
      coder.encode(
        ['address', 'uint256', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
        [op.sender, op.nonce, accountGasLimits, op.preVerificationGas, gasFees, keccak256('0xd703aae79538628d27099b8c4f621be4ccd142d5abcdef'), keccak256('0xe9ae5c53'), keccak256(pad)],
      ),
    );
    const expected = keccak256(coder.encode(['bytes32', 'uint256'], [inner, CHAIN]));
    expect(toHex(pimlicoErc20PaymasterHash(op, CHAIN))).toBe(expected);
  });
});

describe('the worst-case bound', () => {
  const gas = {
    callGasLimit: 150_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 60_000n,
    paymasterVerificationGasLimit: 60_000n,
    paymasterPostOpGasLimit: 69_000n,
    maxFeePerGas: 3_000_000_000n,
  };
  const data = parsePimlicoErc20PaymasterData(encodePimlicoErc20PaymasterData(base()));

  it('is the contract’s getCostInToken over prefund + 10% penalty + postOpGas, at maxFeePerGas', () => {
    const prefund = (150_000n + 200_000n + 60_000n + 60_000n + 69_000n) * 3_000_000_000n;
    const penalty = ((150_000n + 69_000n) * 10n) / 100n;
    const expected = ((prefund + penalty * 3_000_000_000n + 18_990n * 3_000_000_000n) * 2_999_829_507n) / 10n ** 18n;
    expect(erc7677MaxTokenCharge(gas, data)).toBe(expected);
    expect(pimlicoCostInToken(prefund, 0n, 0n, 2_999_829_507n)).toBe((prefund * 2_999_829_507n) / 10n ** 18n);
  });

  it('adds the constant fee and refuses preFund and recipient data', () => {
    const withFee = { ...data, constantFeePresent: true, constantFee: 5_000n };
    expect(erc7677MaxTokenCharge(gas, withFee)).toBe(erc7677MaxTokenCharge(gas, data) + 5_000n);
    expect(() => erc7677MaxTokenCharge(gas, { ...data, preFundPresent: true })).toThrow(/preFund/);
    expect(() => erc7677MaxTokenCharge(gas, { ...data, recipientPresent: true })).toThrow(/recipient/);
  });

  it('never falls below what postOp can take (random operations within the EntryPoint’s limits)', () => {
    // Mirror of SingletonPaymasterV7._postOp for ERC-20 mode without preFund:
    // actualGasCost ≤ prefund (EntryPoint v0.7 reverts postOp otherwise),
    // fee per gas ≤ maxFeePerGas, any execution gas used.
    let seed = 12345n;
    const rand = (max: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return seed % (max + 1n);
    };
    const bound = erc7677MaxTokenCharge(gas, data);
    const prefund = (150_000n + 200_000n + 60_000n + 60_000n + 69_000n) * gas.maxFeePerGas;
    for (let i = 0; i < 2000; i++) {
      const fee = 1n + rand(gas.maxFeePerGas - 1n);
      const actualGasCost = rand(prefund);
      const executionGasLimit = gas.callGasLimit + gas.paymasterPostOpGasLimit;
      const preOp = gas.preVerificationGas + gas.verificationGasLimit + data.paymasterValidationGasLimit;
      const actualGas = actualGasCost / fee + data.postOpGas;
      const used = actualGas > preOp ? actualGas - preOp : 0n;
      const penalty = executionGasLimit > used ? ((executionGasLimit - used) * 10n) / 100n : 0n;
      const cost = pimlicoCostInToken(actualGasCost + penalty * fee, data.postOpGas, fee, data.exchangeRate);
      expect(cost <= bound).toBe(true);
    }
  });
});

describe('the approve call', () => {
  it('is approve(paymaster, exact amount), byte-identical to ethers, never zero or unlimited', () => {
    const call = erc7677TokenApproveCall(USDC, PAYMASTER, 123_456n);
    const iface = new Interface(['function approve(address,uint256)']);
    expect(call.to).toBe(USDC);
    expect(call.value).toBe(0n);
    expect(toHex(call.data)).toBe(iface.encodeFunctionData('approve', [PAYMASTER, 123_456n]));
    expect(() => erc7677TokenApproveCall(USDC, PAYMASTER, 0n)).toThrow(/positive/);
    expect(() => erc7677TokenApproveCall(USDC, PAYMASTER, (1n << 256n) - 1n)).toThrow(/unlimited/);
  });
});

describe('createErc7677TokenPaymasterTransport', () => {
  const rpcOp = {
    sender: ACCOUNT,
    nonce: '0x0',
    callData: '0x',
    callGasLimit: '0x249f0',
    verificationGasLimit: '0x30d40',
    preVerificationGas: '0xea60',
    maxFeePerGas: '0xb2d05e00',
    maxPriorityFeePerGas: '0xbebc200',
    paymasterVerificationGasLimit: '0xea60',
    signature: '0x',
  };
  function upstream(answer: (method: string) => unknown): JsonRpcTransport & { calls: unknown[][] } {
    const calls: unknown[][] = [];
    const t = (async (method: string, params: unknown[]) => {
      calls.push([method, ...params]);
      return answer(method);
    }) as JsonRpcTransport & { calls: unknown[][] };
    t.calls = calls;
    return t;
  }
  const good = () => ({ paymaster: PAYMASTER, paymasterData: LIVE_STUB, paymasterPostOpGasLimit: '0x10d7e' });

  it('forwards both methods with the context {token}, replacing the caller’s context', async () => {
    const up = upstream(good);
    const t = createErc7677TokenPaymasterTransport({ upstream: up, chainId: CHAIN, account: ACCOUNT, token: USDC, maxTokenCharge: 10n ** 9n });
    await t('pm_getPaymasterStubData', [rpcOp, ENTRYPOINT_V07, '0xaa36a7', { sponsorshipPolicyId: 'x' }]);
    await t('pm_getPaymasterData', [rpcOp, ENTRYPOINT_V07, '0xaa36a7', null]);
    expect(up.calls.map((c) => c[0])).toEqual(['pm_getPaymasterStubData', 'pm_getPaymasterData']);
    for (const c of up.calls) expect(c[4]).toEqual({ token: USDC });
  });

  it('refuses the final answer when its bound exceeds the displayed maximum, one unit at a time', async () => {
    const up = upstream(good);
    const quotes: bigint[] = [];
    const probe = createErc7677TokenPaymasterTransport({
      upstream: up, chainId: CHAIN, account: ACCOUNT, token: USDC, maxTokenCharge: 10n ** 12n,
      onQuote: (q) => quotes.push(q.maxTokenCharge),
    });
    await probe('pm_getPaymasterData', [rpcOp, ENTRYPOINT_V07, '0xaa36a7', null]);
    const bound = quotes[0]!;
    const at = createErc7677TokenPaymasterTransport({ upstream: up, chainId: CHAIN, account: ACCOUNT, token: USDC, maxTokenCharge: bound });
    await expect(at('pm_getPaymasterData', [rpcOp, ENTRYPOINT_V07, '0xaa36a7', null])).resolves.toBeTruthy();
    const below = createErc7677TokenPaymasterTransport({ upstream: up, chainId: CHAIN, account: ACCOUNT, token: USDC, maxTokenCharge: bound - 1n });
    await expect(below('pm_getPaymasterData', [rpcOp, ENTRYPOINT_V07, '0xaa36a7', null])).rejects.toBeInstanceOf(TokenGasChargeAboveLimitError);
    // The stub is never refused for the limit (its gas fields are not final).
    await expect(below('pm_getPaymasterStubData', [rpcOp, ENTRYPOINT_V07, '0xaa36a7', null])).resolves.toBeTruthy();
  });

  it('refuses another paymaster, another token, preFund or recipient data, expired data and malformed answers', async () => {
    const make = (answer: () => unknown, now?: bigint) =>
      createErc7677TokenPaymasterTransport({
        upstream: upstream(answer), chainId: CHAIN, account: ACCOUNT, token: USDC, maxTokenCharge: 10n ** 12n,
        ...(now !== undefined ? { now: () => now } : {}),
      });
    const call = (t: JsonRpcTransport) => t('pm_getPaymasterData', [rpcOp, ENTRYPOINT_V07, '0xaa36a7', null]);
    await expect(call(make(() => ({ ...good(), paymaster: '0x0000000000000000000000000000000000000001' })))).rejects.toThrow(/not 0x7777/);
    const other = toHex(encodePimlicoErc20PaymasterData(base({ token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' })));
    await expect(call(make(() => ({ ...good(), paymasterData: other })))).rejects.toThrow(/charges/);
    const pre = toHex(encodePimlicoErc20PaymasterData(base({ preFundPresent: true, preFundInToken: 1n })));
    await expect(call(make(() => ({ ...good(), paymasterData: pre })))).rejects.toThrow(/preFund/);
    const rec = toHex(encodePimlicoErc20PaymasterData(base({ recipientPresent: true, recipient: '0x00000000000000000000000000000000000000AA' })));
    await expect(call(make(() => ({ ...good(), paymasterData: rec })))).rejects.toThrow(/recipient/);
    const exp = toHex(encodePimlicoErc20PaymasterData(base({ validUntil: 1000n })));
    await expect(call(make(() => ({ ...good(), paymasterData: exp }), 1000n))).rejects.toThrow(/expired/);
    await expect(call(make(() => ({ ...good(), paymasterData: exp }), 999n))).resolves.toBeTruthy();
    // No postOp limit in the answer: the operation's own limit is used; with neither, refused.
    await expect(call(make(() => ({ paymaster: PAYMASTER, paymasterData: LIVE_STUB })))).rejects.toThrow(/paymasterPostOpGasLimit/);
    const withOwn = make(() => ({ paymaster: PAYMASTER, paymasterData: LIVE_STUB }));
    const answered = (await withOwn('pm_getPaymasterData', [{ ...rpcOp, paymasterPostOpGasLimit: '0x10d7e' }, ENTRYPOINT_V07, '0xaa36a7', null])) as Record<string, unknown>;
    expect(answered.paymasterPostOpGasLimit).toBeUndefined();
    await expect(call(make(() => null))).rejects.toThrow(/no paymaster data/);
  });

  it('refuses another sender, chain or EntryPoint before contacting the endpoint', async () => {
    const up = upstream(good);
    const t = createErc7677TokenPaymasterTransport({ upstream: up, chainId: CHAIN, account: ACCOUNT, token: USDC, maxTokenCharge: 1n });
    await expect(t('pm_getPaymasterData', [{ ...rpcOp, sender: USDC }, ENTRYPOINT_V07, '0xaa36a7', null])).rejects.toThrow(/sender/);
    await expect(t('pm_getPaymasterData', [rpcOp, ENTRYPOINT_V07, '0x1', null])).rejects.toThrow(/chain/);
    await expect(t('pm_getPaymasterData', [rpcOp, '0x0000000000000000000000000000000000000001', '0xaa36a7', null])).rejects.toThrow(/EntryPoint/);
    await expect(t('eth_chainId', [])).rejects.toThrow(/does not serve/);
    expect(up.calls.length).toBe(0);
  });
});

describe('receipts and on-chain checks', () => {
  it('decodes UserOperationSponsored (topic equals ethers id())', () => {
    expect(PIMLICO_USER_OPERATION_SPONSORED_TOPIC).toBe(id('UserOperationSponsored(bytes32,address,uint8,address,uint256,uint256)'));
    const hash = '0x' + 'ab'.repeat(32);
    const data = AbiCoder.defaultAbiCoder().encode(['uint8', 'address', 'uint256', 'uint256'], [1, USDC, 5_776n, 2_999_829_507n]);
    const [e] = decodePimlicoSponsoredEvents([
      { address: PAYMASTER.toLowerCase(), topics: [PIMLICO_USER_OPERATION_SPONSORED_TOPIC, hash, '0x' + '00'.repeat(12) + ACCOUNT.slice(2).toLowerCase()], data },
    ]);
    expect(e).toEqual({ paymaster: PAYMASTER, userOpHash: hash, sender: ACCOUNT, mode: 1, token: USDC, tokenAmountPaid: 5_776n, exchangeRate: 2_999_829_507n });
    expect(decodePimlicoSponsoredEvents([{ address: PAYMASTER, topics: [id('Other()')], data }])).toEqual([]);
  });

  it('reports a code-hash mismatch, a wrong EntryPoint and an empty deposit; not the missing stake', () => {
    const ok = {
      paymaster: PAYMASTER,
      runtimeCodeKeccak: PIMLICO_ERC20_PAYMASTER_V07.runtimeCodeKeccak,
      entryPoint: ENTRYPOINT_V07,
      deposit: 1n,
      staked: false,
      stake: 0n,
      unstakeDelaySec: 0n,
    };
    expect(pimlicoPaymasterProblems(ok)).toEqual([]);
    expect(pimlicoPaymasterProblems({ ...ok, runtimeCodeKeccak: '0x' + '00'.repeat(32) }).join(' ')).toMatch(/deployed code/);
    expect(pimlicoPaymasterProblems({ ...ok, entryPoint: PAYMASTER }).join(' ')).toMatch(/EntryPoint/);
    expect(pimlicoPaymasterProblems({ ...ok, deposit: 0n }).join(' ')).toMatch(/no EntryPoint deposit/);
    expect(pimlicoPaymasterProblems(ok, { minDeposit: 2n }).join(' ')).toMatch(/below/);
    expect(erc7677PaymasterDataProblems(PAYMASTER, parsePimlicoErc20PaymasterData(toBytes(LIVE_STUB)), { token: USDC })).toEqual([]);
  });
});

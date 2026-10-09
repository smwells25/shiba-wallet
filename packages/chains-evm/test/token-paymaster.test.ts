import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Interface, TypedDataEncoder, recoverAddress, solidityPacked, getAddress, Signature } from 'ethers';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '@shiba-wallet/core';
import {
  CIRCLE_PAYMASTER_PERMIT_SIGNATURE_OFFSET,
  CIRCLE_PAYMASTER_TOKEN_ADDRESS_OFFSET,
  CIRCLE_TOKEN_PAYMASTER_V07,
  CIRCLE_USER_OPERATION_SPONSORED_TOPIC,
  PERMIT_DEADLINE_MAX,
  TokenGasAllowanceError,
  TokenGasChargeAboveLimitError,
  TokenGasInsufficientBalanceError,
  buildTokenPermit,
  circlePaymasterApproveCall,
  circlePaymasterProblems,
  circlePostOpCharge,
  circleTokenCost,
  circleUserCharge,
  createCirclePaymasterTransport,
  decodeCircleSponsoredEvents,
  encodeCirclePaymasterData,
  entryPointRequiredPrefund,
  parseCirclePaymasterData,
  quoteCircleTokenCharge,
  readCirclePaymasterState,
  readTokenPermitInfo,
  type CirclePaymasterState,
} from '../src/token-paymaster.js';
import { SmartAccountClient, requiredPrefund, toEthSignedMessageHash, withEthereumV, type SmartAccountSpec } from '../src/smart-account.js';
import { ENTRYPOINT_V07, getUserOpHash, type UserOperation } from '../src/userop.js';
import { toBytes, toHex } from '../src/encoding.js';
import { selector } from '../src/abi.js';
import { ImpossibleGasEstimateError, type JsonRpcTransport } from '../src/rpc.js';

const PAYMASTER = CIRCLE_TOKEN_PAYMASTER_V07.testnetAddress;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ACCOUNT = '0xc995E49acA5C888F4FF1E50E8467E9fFc31CC5AC';
const CHAIN = 84532n;
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function owner() {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(TEST_MNEMONIC, registry).getAccount('eip155:1');
}

const word = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const addrWord = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const abiString = (s: string) => {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return '0x' + word(32n).slice(2) + word(BigInt(hex.length / 2)).slice(2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
};
const sel = (sig: string) => toHex(selector(sig));

/** The values read from the real Base Sepolia deployment on 2026-10-04. */
const LIVE_STATE = {
  price: 3_000_000_000n,
  additionalGasCharge: 35_000n,
  feeSpread: 0n,
  deposit: 1_007_679_253_455_854_133n,
  stake: 250_000_000_000_000_000n,
  unstakeDelay: 86_400n,
};

interface FakeChain {
  balance: bigint;
  allowance: bigint;
  nonce: bigint;
  paused?: boolean;
  token?: string;
  entryPoint?: string;
  domainSeparator?: string;
  staked?: boolean;
}

/** A fake node answering exactly the reads token-paymaster.ts performs. */
function fakeNode(chain: FakeChain): { node: JsonRpcTransport; calls: string[] } {
  const calls: string[] = [];
  const usdcDomain = TypedDataEncoder.hashDomain({ name: 'USDC', version: '2', chainId: CHAIN, verifyingContract: USDC });
  const node: JsonRpcTransport = async (method, params) => {
    if (method === 'eth_getStorageAt') return addrWord('0x1E42055dECF050828AfE8bA0A374bC5F44CbFC8d');
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const { to, data } = params[0] as { to: string; data: string };
    const s = data.slice(0, 10);
    calls.push(`${to.toLowerCase()}:${s}`);
    if (to.toLowerCase() === PAYMASTER.toLowerCase()) {
      const answers: Record<string, string> = {
        [sel('entryPoint()')]: addrWord(chain.entryPoint ?? ENTRYPOINT_V07),
        [sel('token()')]: addrWord(chain.token ?? USDC),
        [sel('tokenDecimals()')]: word(6n),
        [sel('fetchPrice()')]: word(LIVE_STATE.price),
        [sel('additionalGasCharge()')]: word(LIVE_STATE.additionalGasCharge),
        [sel('feeSpread()')]: word(LIVE_STATE.feeSpread),
        [sel('paused()')]: word(chain.paused ? 1n : 0n),
        [sel('owner()')]: addrWord('0x86665ff7bb7dd39e136cb7838117ca63dcd51461'),
        [sel('oracle()')]: addrWord('0x74479c39ddafb0549ed6c26080c6e5d155300a89'),
      };
      if (!answers[s]) throw new Error(`unexpected paymaster call ${s}`);
      return answers[s];
    }
    if (to.toLowerCase() === ENTRYPOINT_V07.toLowerCase() && s === sel('getDepositInfo(address)')) {
      return (
        '0x' +
        [LIVE_STATE.deposit, chain.staked === false ? 0n : 1n, LIVE_STATE.stake, LIVE_STATE.unstakeDelay, 0n]
          .map((v) => word(v).slice(2))
          .join('')
      );
    }
    if (to.toLowerCase() === USDC.toLowerCase()) {
      if (s === sel('balanceOf(address)')) return word(chain.balance);
      if (s === sel('allowance(address,address)')) return word(chain.allowance);
      if (s === sel('nonces(address)')) return word(chain.nonce);
      if (s === sel('name()')) return abiString('USDC');
      if (s === sel('version()')) return abiString('2');
      if (s === sel('DOMAIN_SEPARATOR()')) return chain.domainSeparator ?? usdcDomain;
    }
    throw new Error(`unexpected call ${to} ${s}`);
  };
  return { node, calls };
}

const rpcOp = (over: Record<string, string> = {}) => ({
  sender: ACCOUNT,
  nonce: '0x2',
  callData: '0x',
  callGasLimit: '0x0',
  verificationGasLimit: '0x0',
  preVerificationGas: '0x0',
  maxFeePerGas: '0x7026f0', // 7,350,000 wei, the live run's fee
  maxPriorityFeePerGas: '0x100590', // 1,050,000 wei
  signature: '0x',
  ...over,
});

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/circle-paymaster-base-sepolia.json', import.meta.url), 'utf8'),
) as { input: string; logs: { address: string; topics: string[]; data: string }[] };

describe('Circle paymasterData encoding', () => {
  it('matches Solidity encodePacked(uint8, address, uint256, bytes) as the documentation builds it', () => {
    const signature = new Uint8Array(86).map((_, i) => i);
    const ours = encodeCirclePaymasterData({ mode: 'permit', token: USDC, permitAmount: 15_291n, permitSignature: signature });
    const theirs = solidityPacked(['uint8', 'address', 'uint256', 'bytes'], [0, USDC, 15_291n, signature]);
    expect(toHex(ours)).toBe(theirs.toLowerCase());
  });

  it('places token, amount and signature at the contract offsets', () => {
    expect(CIRCLE_PAYMASTER_TOKEN_ADDRESS_OFFSET).toBe(53);
    expect(CIRCLE_PAYMASTER_PERMIT_SIGNATURE_OFFSET).toBe(105);
    const data = encodeCirclePaymasterData({ mode: 'permit', token: USDC, permitAmount: 7n, permitSignature: new Uint8Array([9, 9]) });
    const paymasterAndData = new Uint8Array(52 + data.length);
    paymasterAndData.set(data, 52);
    expect(toHex(paymasterAndData.slice(53, 73))).toBe(USDC.toLowerCase());
    expect(BigInt(toHex(paymasterAndData.slice(73, 105)))).toBe(7n);
    expect([...paymasterAndData.slice(105)]).toEqual([9, 9]);
  });

  it('round-trips and applies the contract length rules', () => {
    expect(parseCirclePaymasterData(new Uint8Array(0))).toEqual({ mode: 'allowance' });
    expect(parseCirclePaymasterData(encodeCirclePaymasterData({ mode: 'allowance' }))).toEqual({ mode: 'allowance' });
    expect(() => parseCirclePaymasterData(new Uint8Array(20))).toThrow(/Malformed/);
    const parsed = parseCirclePaymasterData(
      encodeCirclePaymasterData({ mode: 'permit', token: USDC, permitAmount: 1n, permitSignature: new Uint8Array([1]) }),
    );
    expect(parsed).toMatchObject({ mode: 'permit', token: USDC, permitAmount: 1n });
  });

  it('refuses an empty signature and out-of-range amounts', () => {
    expect(() => encodeCirclePaymasterData({ mode: 'permit', token: USDC, permitAmount: 1n, permitSignature: new Uint8Array(0) })).toThrow();
    expect(() => encodeCirclePaymasterData({ mode: 'permit', token: USDC, permitAmount: -1n, permitSignature: new Uint8Array(1) })).toThrow();
  });
});

describe('fee math (FeeLib and EntryPoint v0.7 mirrors)', () => {
  it('reproduces the prefund the paymaster pulled in the live Base Sepolia run', () => {
    // Live run 2026-10-04: required prefund 4,839,732,450,000 wei at
    // maxFeePerGas 7,350,000 (658,467 gas), price 3,000,000,000 per ETH,
    // additionalGasCharge 35,000, spread 0 -> the USDC Transfer to the
    // paymaster in tx 0x83f56b31... was 15,291 base units.
    const gas = {
      verificationGasLimit: 400_000n,
      callGasLimit: 23_467n,
      preVerificationGas: 0n,
      paymasterVerificationGasLimit: 200_000n,
      paymasterPostOpGasLimit: 35_000n,
      maxFeePerGas: 7_350_000n,
    };
    expect(entryPointRequiredPrefund(gas)).toBe(4_839_732_450_000n);
    const quote = quoteCircleTokenCharge(
      { nativeTokenPrice: 3_000_000_000n, additionalGasCharge: 35_000n, feeSpreadBips: 0n },
      gas,
    );
    expect(quote.maxTokenCharge).toBe(15_291n);
    expect(quote.worstCaseWei).toBe(35_000n * 7_350_000n + 4_839_732_450_000n);
  });

  it('agrees with the client requiredPrefund helper', () => {
    const op = {
      sender: ACCOUNT, nonce: 0n, callData: new Uint8Array(0), signature: new Uint8Array(0),
      callGasLimit: 11n, verificationGasLimit: 22n, preVerificationGas: 33n,
      paymasterVerificationGasLimit: 44n, paymasterPostOpGasLimit: 55n,
      maxFeePerGas: 1_000n, maxPriorityFeePerGas: 1n, paymaster: PAYMASTER,
    } as UserOperation;
    expect(entryPointRequiredPrefund(op as never)).toBe(requiredPrefund(op));
  });

  it('rounds the token cost down then adds one base unit, and applies the spread in basis points', () => {
    expect(circleTokenCost(3_000_000_000n, 0n)).toBe(1n);
    expect(circleTokenCost(3_000_000_000n, 10n ** 18n)).toBe(3_000_000_001n);
    expect(circleTokenCost(3_000_000_000n, 333_333_333_333n)).toBe(999n + 1n);
    const c = circleUserCharge(3_000_000_000n, 35_000n, 1_000_000_000n, 10n ** 15n, 1_000n);
    expect(c.baseTokenAmount).toBe(((35_000n * 1_000_000_000n + 10n ** 15n) * 3_000_000_000n) / 10n ** 18n + 1n);
    expect(c.feeTokenAmount).toBe((c.baseTokenAmount * 1_000n) / 10_000n);
    expect(c.total).toBe(c.baseTokenAmount + c.feeTokenAmount);
  });

  it('postOp charge follows the contract: penalty on unused execution gas, plus additional gas', () => {
    const r = circlePostOpCharge({
      pricing: { nativeTokenPrice: 3_000_000_000n, additionalGasCharge: 35_000n, feeSpreadBips: 0n },
      actualGasCost: 200_000n * 6_050_000n,
      actualUserOpFeePerGas: 6_050_000n,
      preOpGasApproximation: 180_000n,
      executionGasLimit: 100_000n,
    });
    // executionGasUsed = 200,000 + 35,000 - 180,000 = 55,000; penalty = 10% of 45,000.
    expect(r.expectedPenaltyGas).toBe(4_500n);
    expect(r.actualTokenNeeded).toBe((((35_000n + 4_500n) * 6_050_000n + 200_000n * 6_050_000n) * 3_000_000_000n) / 10n ** 18n + 1n);
  });

  it('refuses a non-positive price', () => {
    expect(() =>
      quoteCircleTokenCharge({ nativeTokenPrice: 0n, additionalGasCharge: 0n, feeSpreadBips: 0n }, {
        verificationGasLimit: 1n, callGasLimit: 1n, preVerificationGas: 1n, paymasterVerificationGasLimit: 1n, paymasterPostOpGasLimit: 1n, maxFeePerGas: 1n,
      }),
    ).toThrow();
  });
});

describe('EIP-2612 permit', () => {
  it('digest equals ethers TypedDataEncoder with deadline type(uint256).max', () => {
    const permit = buildTokenPermit({
      token: USDC, name: 'USDC', version: '2', chainId: CHAIN, owner: ACCOUNT, spender: PAYMASTER, value: 15_291n, nonce: 0n,
    });
    expect(permit.message.deadline).toBe(PERMIT_DEADLINE_MAX);
    const expected = TypedDataEncoder.hash(
      { name: 'USDC', version: '2', chainId: CHAIN, verifyingContract: USDC },
      { Permit: permit.types.Permit! },
      { owner: ACCOUNT, spender: PAYMASTER, value: 15_291n, nonce: 0n, deadline: (1n << 256n) - 1n },
    );
    expect(toHex(permit.digest)).toBe(expected);
  });

  it('reads the token domain and refuses a DOMAIN_SEPARATOR that does not match', async () => {
    const ok = fakeNode({ balance: 0n, allowance: 0n, nonce: 4n });
    const info = await readTokenPermitInfo(ok.node, USDC, ACCOUNT, CHAIN);
    expect(info).toMatchObject({ name: 'USDC', version: '2', nonce: 4n });
    const bad = fakeNode({ balance: 0n, allowance: 0n, nonce: 4n, domainSeparator: word(1n) });
    await expect(readTokenPermitInfo(bad.node, USDC, ACCOUNT, CHAIN)).rejects.toThrow(/DOMAIN_SEPARATOR/);
  });
});

describe('the live Base Sepolia operation (fixture)', () => {
  const entryPoint = new Interface([
    'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)',
  ]);
  const [ops] = entryPoint.decodeFunctionData('handleOps', fixture.input) as unknown as [
    { sender: string; accountGasLimits: string; preVerificationGas: bigint; gasFees: string; paymasterAndData: string }[],
  ];
  const op = ops[0]!;
  const pad = toBytes(op.paymasterAndData);

  it('carries Circle paymasterAndData that our encoder reproduces byte for byte', () => {
    expect(getAddress(toHex(pad.slice(0, 20)))).toBe(PAYMASTER);
    const parsed = parseCirclePaymasterData(pad.slice(52));
    expect(parsed.mode).toBe('permit');
    if (parsed.mode !== 'permit') return;
    expect(parsed.token).toBe(USDC);
    expect(parsed.permitAmount).toBe(15_291n);
    expect(toHex(encodeCirclePaymasterData(parsed))).toBe(toHex(pad.slice(52)));
  });

  it('permits exactly the worst-case charge recomputed from the signed gas fields', () => {
    const limits = BigInt(op.accountGasLimits);
    const fees = BigInt(op.gasFees);
    const pmLimits = BigInt(toHex(pad.slice(20, 52)));
    const gas = {
      verificationGasLimit: limits >> 128n,
      callGasLimit: limits & ((1n << 128n) - 1n),
      preVerificationGas: op.preVerificationGas,
      paymasterVerificationGasLimit: pmLimits >> 128n,
      paymasterPostOpGasLimit: pmLimits & ((1n << 128n) - 1n),
      maxFeePerGas: fees & ((1n << 128n) - 1n),
    };
    expect(gas.paymasterPostOpGasLimit).toBeGreaterThanOrEqual(35_000n);
    const quote = quoteCircleTokenCharge(
      { nativeTokenPrice: 3_000_000_000n, additionalGasCharge: 35_000n, feeSpreadBips: 0n },
      gas,
    );
    const parsed = parseCirclePaymasterData(pad.slice(52));
    expect(parsed.mode === 'permit' && parsed.permitAmount).toBe(quote.maxTokenCharge);
  });

  it('permit signature is a Kernel ERC-1271 envelope whose ECDSA part recovers to the account owner (ethers)', () => {
    const parsed = parseCirclePaymasterData(pad.slice(52));
    if (parsed.mode !== 'permit') throw new Error('expected a permit');
    const sig = parsed.permitSignature;
    expect(sig.length).toBe(1 + 20 + 65);
    expect(sig[0]).toBe(0x01); // Kernel validator-mode prefix
    expect(getAddress(toHex(sig.slice(1, 21)))).toBe('0x845ADb2C711129d4f3966735eD98a9F09fC4cE57');
    const permitDigest = TypedDataEncoder.hash(
      { name: 'USDC', version: '2', chainId: CHAIN, verifyingContract: USDC },
      { Permit: [
        { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      ] },
      { owner: ACCOUNT, spender: PAYMASTER, value: 15_291n, nonce: 0n, deadline: (1n << 256n) - 1n },
    );
    const kernelDigest = TypedDataEncoder.hash(
      { name: 'Kernel', version: '0.3.3', chainId: CHAIN, verifyingContract: ACCOUNT },
      { Kernel: [{ name: 'hash', type: 'bytes32' }] },
      { hash: permitDigest },
    );
    const recovered = recoverAddress(kernelDigest, Signature.from(toHex(sig.slice(21))));
    expect(recovered).toBe('0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C');
  });

  it('decodes UserOperationSponsored from the receipt', () => {
    expect(CIRCLE_USER_OPERATION_SPONSORED_TOPIC).toBe(
      new Interface(['event UserOperationSponsored(address indexed token, address indexed sender, bytes32 userOpHash, uint256 nativeTokenPrice, uint256 actualTokenNeeded, uint256 feeTokenAmount)']).getEvent('UserOperationSponsored')!.topicHash,
    );
    const events = decodeCircleSponsoredEvents(fixture.logs);
    expect(events).toEqual([
      {
        paymaster: PAYMASTER,
        token: USDC,
        sender: ACCOUNT,
        userOpHash: '0x49f93a1111f3fc4af130f091f417b66f648dfd86d67bc5e0c76b1a1bcf77b7f6',
        nativeTokenPrice: 3_000_000_000n,
        actualTokenNeeded: 5_392n,
        feeTokenAmount: 0n,
      },
    ]);
  });
});

describe('paymaster state and safety checks', () => {
  it('reads the deployment and reports no problems for the live values', async () => {
    const { node } = fakeNode({ balance: 0n, allowance: 0n, nonce: 0n });
    const state = await readCirclePaymasterState(node, PAYMASTER);
    expect(state).toMatchObject({
      entryPoint: ENTRYPOINT_V07, token: USDC, tokenDecimals: 6, nativeTokenPrice: 3_000_000_000n,
      additionalGasCharge: 35_000n, feeSpreadBips: 0n, paused: false, staked: true, deposit: LIVE_STATE.deposit,
      implementation: '0x1E42055dECF050828AfE8bA0A374bC5F44CbFC8d', unstakeDelaySec: 86_400n,
    });
    expect(circlePaymasterProblems(state, { token: USDC })).toEqual([]);
  });

  it('flags a wrong EntryPoint, a different token, a pause, a missing stake and a thin deposit', async () => {
    const { node } = fakeNode({
      balance: 0n, allowance: 0n, nonce: 0n, paused: true, staked: false,
      entryPoint: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108', token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    });
    const state = await readCirclePaymasterState(node, PAYMASTER);
    const problems = circlePaymasterProblems(state, { token: USDC, minDeposit: LIVE_STATE.deposit + 1n });
    expect(problems).toHaveLength(5);
    expect(problems.join(' ')).toMatch(/EntryPoint/);
    expect(problems.join(' ')).toMatch(/paused/);
  });
});

describe('approve call for allowance mode', () => {
  it('encodes approve(paymaster, exact amount) and refuses zero or unlimited', () => {
    const call = circlePaymasterApproveCall(USDC, PAYMASTER, 15_291n);
    expect(call.to).toBe(USDC);
    expect(call.value).toBe(0n);
    expect(toHex(call.data)).toBe(new Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [PAYMASTER, 15_291n]));
    expect(() => circlePaymasterApproveCall(USDC, PAYMASTER, 0n)).toThrow();
    expect(() => circlePaymasterApproveCall(USDC, PAYMASTER, (1n << 256n) - 1n)).toThrow();
  });
});

describe('createCirclePaymasterTransport (local ERC-7677)', () => {
  const signer = owner();
  const signPermit = (digest: Uint8Array) => withEthereumV(signer.sign(digest));

  it('answers the stub with a real permit sized for the estimation ceiling and the documented limits', async () => {
    const { node } = fakeNode({ balance: 1_000_000n, allowance: 0n, nonce: 3n });
    const quotes: { phase: string; permitAmount: bigint | null; maxTokenCharge: bigint }[] = [];
    const transport = createCirclePaymasterTransport({
      node, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit', signPermit, onQuote: (q) => quotes.push(q),
    });
    const r = (await transport('pm_getPaymasterStubData', [rpcOp(), ENTRYPOINT_V07, '0x14a34', null])) as Record<string, string>;
    expect(r.paymaster).toBe(PAYMASTER);
    expect(BigInt(r.paymasterVerificationGasLimit!)).toBe(200_000n);
    expect(BigInt(r.paymasterPostOpGasLimit!)).toBe(35_000n);
    const expected = quoteCircleTokenCharge(
      { nativeTokenPrice: 3_000_000_000n, additionalGasCharge: 35_000n, feeSpreadBips: 0n },
      { verificationGasLimit: 1_500_000n, callGasLimit: 0n, preVerificationGas: 0n, paymasterVerificationGasLimit: 200_000n, paymasterPostOpGasLimit: 35_000n, maxFeePerGas: 7_350_000n },
    ).maxTokenCharge;
    const parsed = parseCirclePaymasterData(toBytes(r.paymasterData!));
    expect(parsed.mode === 'permit' && parsed.permitAmount).toBe(expected);
    expect(quotes[0]).toMatchObject({ phase: 'stub', permitAmount: expected });
  });

  it('final data permits exactly the worst case for the estimated limits, signed over nonce N by the account', async () => {
    const { node } = fakeNode({ balance: 1_000_000n, allowance: 0n, nonce: 3n });
    const transport = createCirclePaymasterTransport({ node, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit', signPermit });
    const op = rpcOp({
      verificationGasLimit: '0x61a80', callGasLimit: '0x5bab', preVerificationGas: '0x0', paymasterVerificationGasLimit: '0x30d40',
    });
    const r = (await transport('pm_getPaymasterData', [op, ENTRYPOINT_V07, '0x14a34', null])) as Record<string, unknown>;
    expect(r.isFinal).toBe(true);
    const parsed = parseCirclePaymasterData(toBytes(r.paymasterData as string));
    if (parsed.mode !== 'permit') throw new Error('expected a permit');
    expect(parsed.permitAmount).toBe(15_291n); // same gas as the live run
    const digest = buildTokenPermit({ token: USDC, name: 'USDC', version: '2', chainId: CHAIN, owner: ACCOUNT, spender: PAYMASTER, value: 15_291n, nonce: 3n }).digest;
    expect(recoverAddress(toHex(digest), Signature.from(toHex(parsed.permitSignature)))).toBe(signer.address);
  });

  it('uses the bundler-estimated paymaster verification limit in the quote it signs', async () => {
    const { node } = fakeNode({ balance: 1_000_000n, allowance: 0n, nonce: 0n });
    const transport = createCirclePaymasterTransport({ node, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit', signPermit });
    const r = (await transport('pm_getPaymasterData', [rpcOp({ paymasterVerificationGasLimit: '0x186a0' }), ENTRYPOINT_V07, '0x14a34', null])) as Record<string, string>;
    expect(BigInt(r.paymasterVerificationGasLimit!)).toBe(100_000n);
  });

  it('refuses before signing when the balance is short, naming the exact amounts', async () => {
    const { node } = fakeNode({ balance: 15_290n, allowance: 0n, nonce: 0n });
    let signed = 0;
    const transport = createCirclePaymasterTransport({
      node, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit', signPermit: (d) => { signed++; return signPermit(d); },
    });
    const op = rpcOp({ verificationGasLimit: '0x61a80', callGasLimit: '0x5bab' });
    const err = await transport('pm_getPaymasterData', [op, ENTRYPOINT_V07, '0x14a34', null]).catch((e) => e);
    expect(err).toBeInstanceOf(TokenGasInsufficientBalanceError);
    expect(err).toMatchObject({ required: 15_291n, balance: 15_290n });
    expect(signed).toBe(0);
  });

  it('allowance mode sends only the reserved byte and refuses an allowance below the worst case', async () => {
    const op = rpcOp({ verificationGasLimit: '0x61a80', callGasLimit: '0x5bab' });
    const low = fakeNode({ balance: 1_000_000n, allowance: 15_290n, nonce: 0n });
    const t1 = createCirclePaymasterTransport({ node: low.node, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'allowance' });
    await expect(t1('pm_getPaymasterData', [op, ENTRYPOINT_V07, '0x14a34', null])).rejects.toBeInstanceOf(TokenGasAllowanceError);
    const enough = fakeNode({ balance: 1_000_000n, allowance: 15_291n, nonce: 0n });
    const t2 = createCirclePaymasterTransport({ node: enough.node, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'allowance' });
    const r = (await t2('pm_getPaymasterData', [op, ENTRYPOINT_V07, '0x14a34', null])) as Record<string, string>;
    expect(r.paymasterData).toBe('0x00');
    expect(enough.calls.some((c) => c.endsWith(sel('nonces(address)')))).toBe(false);
  });

  it('refuses a charge above the amount the user confirmed', async () => {
    const { node } = fakeNode({ balance: 1_000_000n, allowance: 0n, nonce: 0n });
    const transport = createCirclePaymasterTransport({
      node, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit', signPermit, maxTokenCharge: 15_290n,
    });
    const op = rpcOp({ verificationGasLimit: '0x61a80', callGasLimit: '0x5bab' });
    await expect(transport('pm_getPaymasterData', [op, ENTRYPOINT_V07, '0x14a34', null])).rejects.toBeInstanceOf(TokenGasChargeAboveLimitError);
  });

  it('refuses another EntryPoint, chain, sender, method, a paused paymaster, a different token and a too-small postOp limit', async () => {
    const good = fakeNode({ balance: 1_000_000n, allowance: 0n, nonce: 0n }).node;
    const t = createCirclePaymasterTransport({ node: good, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit', signPermit });
    await expect(t('pm_getPaymasterStubData', [rpcOp(), '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108', '0x14a34', null])).rejects.toThrow(/EntryPoint/);
    await expect(t('pm_getPaymasterStubData', [rpcOp(), ENTRYPOINT_V07, '0xaa36a7', null])).rejects.toThrow(/chain/);
    await expect(t('pm_getPaymasterStubData', [rpcOp({ sender: PAYMASTER }), ENTRYPOINT_V07, '0x14a34', null])).rejects.toThrow(/sender/);
    await expect(t('pm_sponsorUserOperation', [rpcOp(), ENTRYPOINT_V07, '0x14a34', null])).rejects.toThrow(/does not serve/);
    const paused = fakeNode({ balance: 1n, allowance: 0n, nonce: 0n, paused: true }).node;
    await expect(createCirclePaymasterTransport({ node: paused, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit', signPermit })('pm_getPaymasterStubData', [rpcOp(), ENTRYPOINT_V07, '0x14a34', null])).rejects.toThrow(/paused/);
    const other = fakeNode({ balance: 1n, allowance: 0n, nonce: 0n, token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' }).node;
    await expect(createCirclePaymasterTransport({ node: other, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit', signPermit })('pm_getPaymasterStubData', [rpcOp(), ENTRYPOINT_V07, '0x14a34', null])).rejects.toThrow(/accepts only/);
    await expect(createCirclePaymasterTransport({ node: good, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit', signPermit, postOpGasLimit: 34_999n })('pm_getPaymasterStubData', [rpcOp(), ENTRYPOINT_V07, '0x14a34', null])).rejects.toThrow(/at least 35000/);
    expect(() => createCirclePaymasterTransport({ node: good, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit' })).toThrow(/signPermit/);
  });
});

describe('SmartAccountClient integration through the unchanged ERC-7677 seam', () => {
  it('signs and submits an operation whose permit equals the worst case of the signed gas fields', async () => {
    const signer = owner();
    const spec: SmartAccountSpec = {
      getAddress: async () => ACCOUNT,
      getFactoryArgs: async () => { throw new Error('deployed'); },
      encodeCalls: () => new Uint8Array([0xab]),
      signUserOpHash: (o, h) => withEthereumV(o.sign(toEthSignedMessageHash(h))),
      stubSignature: () => new Uint8Array(65).fill(1),
    };
    const fake = fakeNode({ balance: 1_000_000n, allowance: 0n, nonce: 9n });
    const node: JsonRpcTransport = async (method, params) => {
      if (method === 'eth_getCode') return '0x6001';
      const { to, data } = (params[0] ?? {}) as { to?: string; data?: string };
      if (method === 'eth_call' && to?.toLowerCase() === ENTRYPOINT_V07.toLowerCase() && data?.startsWith(sel('getNonce(address,uint192)'))) return word(2n);
      return fake.node(method, params);
    };
    let sent: Record<string, string> | undefined;
    const bundler: JsonRpcTransport = async (method, params) => {
      if (method === 'eth_estimateUserOperationGas') {
        const op = params[0] as Record<string, string>;
        // The stub reached the bundler with a permit sized for the ceiling.
        expect(parseCirclePaymasterData(toBytes(op.paymasterData!)).mode).toBe('permit');
        // The live run's 658,467 gas, split so that preVerificationGas is not
        // 0 (a zero estimate is now refused as impossible): 350,000 + 50,000
        // replaces 400,000 + 0, so the prefund and the permit are unchanged.
        return { callGasLimit: '0x5bab', verificationGasLimit: '0x55730', preVerificationGas: '0xc350', paymasterVerificationGasLimit: '0x30d40' };
      }
      if (method === 'eth_sendUserOperation') {
        sent = params[0] as Record<string, string>;
        return '0x' + '11'.repeat(32);
      }
      throw new Error(method);
    };
    const client = new SmartAccountClient({
      chainId: CHAIN, entryPoint: ENTRYPOINT_V07, bundler, node, spec,
      paymaster: { transport: createCirclePaymasterTransport({ node, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit', signPermit: (d) => withEthereumV(signer.sign(d)) }) },
    });
    const { userOp } = await client.sendCalls(signer, [{ to: signer.address, value: 0n, data: new Uint8Array(0) }], {
      maxFeePerGas: 7_350_000n, maxPriorityFeePerGas: 1_050_000n,
    });
    expect(sent).toBeDefined();
    expect(userOp.paymaster).toBe(PAYMASTER);
    const parsed = parseCirclePaymasterData(userOp.paymasterData!);
    expect(parsed.mode === 'permit' && parsed.permitAmount).toBe(15_291n);
    // The owner's operation signature covers the final paymaster data.
    const hash = getUserOpHash(userOp, ENTRYPOINT_V07, CHAIN);
    expect(recoverAddress(toHex(toEthSignedMessageHash(hash)), Signature.from(toHex(userOp.signature)))).toBe(signer.address);
  });
});

describe('createCirclePaymasterTransport never hands back a zero paymaster verification limit', () => {
  const signer = owner();
  it('refuses final data when the estimate set paymasterVerificationGasLimit to 0, before any permit is signed', async () => {
    const { node } = fakeNode({ balance: 1_000_000n, allowance: 0n, nonce: 0n });
    let signed = 0;
    const transport = createCirclePaymasterTransport({
      node, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit',
      signPermit: (d) => { signed++; return withEthereumV(signer.sign(d)); },
    });
    const op = rpcOp({ verificationGasLimit: '0x0', callGasLimit: '0xcb36', preVerificationGas: '0xdae9', paymasterVerificationGasLimit: '0x0' });
    const err = await transport('pm_getPaymasterData', [op, ENTRYPOINT_V07, '0x14a34', null]).catch((e) => e);
    expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
    expect(err.source).toBe('paymaster');
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]).toMatch(/^paymasterVerificationGasLimit is 0/);
    expect(err.fields).toMatchObject({ callGasLimit: 0xcb36n, paymasterVerificationGasLimit: 0n, paymasterPostOpGasLimit: 35_000n });
    expect(signed).toBe(0);
  });

  it('refuses a configured verification limit of 0 for the stub too; a non-zero estimate is still used as before', async () => {
    const { node } = fakeNode({ balance: 1_000_000n, allowance: 0n, nonce: 0n });
    const zero = createCirclePaymasterTransport({
      node, chainId: CHAIN, account: ACCOUNT, token: USDC, mode: 'permit', verificationGasLimit: 0n,
      signPermit: (d) => withEthereumV(signer.sign(d)),
    });
    await expect(zero('pm_getPaymasterStubData', [rpcOp(), ENTRYPOINT_V07, '0x14a34', null])).rejects.toBeInstanceOf(ImpossibleGasEstimateError);
    // With no estimate value the configured (zero) limit would be used: refused.
    await expect(zero('pm_getPaymasterData', [rpcOp(), ENTRYPOINT_V07, '0x14a34', null])).rejects.toBeInstanceOf(ImpossibleGasEstimateError);
    // An estimate value replaces it, as before.
    const r = (await zero('pm_getPaymasterData', [rpcOp({ paymasterVerificationGasLimit: '0x1' }), ENTRYPOINT_V07, '0x14a34', null])) as Record<string, string>;
    expect(BigInt(r.paymasterVerificationGasLimit!)).toBe(1n);
  });
});

import { describe, expect, it } from 'vitest';
import { Interface, hashMessage, recoverAddress } from 'ethers';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  ChainRegistry,
  HdKeyring,
  evmKeyProvider,
  type DerivedAccount,
} from '@shiba-wallet/core';
import {
  SmartAccountClient,
  needsDepositTopUp,
  requiredPrefund,
  toEthSignedMessageHash,
  withDepositTopUpHeadroom,
  withEthereumV,
  type Call,
  type SmartAccountSpec,
} from '../src/smart-account.js';
import { ENTRYPOINT_V07, getUserOpHash, type UserOperation } from '../src/userop.js';
import { toHex } from '../src/encoding.js';
import {
  BundlerClient,
  DEFAULT_ESTIMATE_RETRIES,
  ImpossibleGasEstimateError,
  gasEstimateProblems,
  gasLimitProblems,
  type JsonRpcTransport,
} from '../src/rpc.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function ownerAccount(): DerivedAccount {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  return HdKeyring.fromMnemonic(TEST_MNEMONIC, registry).getAccount('eip155:1');
}

const ACCOUNT_ADDRESS = '0x4444444444444444444444444444444444444444';
const FACTORY = '0x5555555555555555555555555555555555555555';

/** A minimal fake account implementation exercising every spec hook. */
const spec: SmartAccountSpec = {
  getAddress: async () => ACCOUNT_ADDRESS,
  getFactoryArgs: async () => ({ factory: FACTORY, factoryData: utf8ToBytes('init') }),
  encodeCalls: (calls: Call[]) =>
    utf8ToBytes(calls.map((c) => `${c.to}:${c.value}`).join(',')),
  signUserOpHash: (owner, userOpHash) =>
    withEthereumV(owner.sign(toEthSignedMessageHash(userOpHash))),
  stubSignature: () => new Uint8Array(65).fill(1),
};

interface RecordedCall {
  method: string;
  params: unknown[];
}

function makeTransports(options: { deployed: boolean; sponsored: boolean }) {
  const calls: RecordedCall[] = [];
  const node: JsonRpcTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_getCode') return options.deployed ? '0x6001' : '0x';
    if (method === 'eth_call') return '0x05'; // EntryPoint.getNonce -> 5
    throw new Error(`unexpected node method ${method}`);
  };
  const bundler: JsonRpcTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_estimateUserOperationGas') {
      return {
        callGasLimit: '0x111',
        verificationGasLimit: '0x222',
        preVerificationGas: '0x333',
        ...(options.sponsored ? { paymasterVerificationGasLimit: '0x444' } : {}),
      };
    }
    if (method === 'eth_sendUserOperation') return '0xuserophash';
    if (method === 'eth_getUserOperationReceipt') return { success: true };
    throw new Error(`unexpected bundler method ${method}`);
  };
  const paymaster: JsonRpcTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'pm_getPaymasterStubData') {
      return { paymaster: '0x' + '66'.repeat(20), paymasterData: '0x00' };
    }
    if (method === 'pm_getPaymasterData') {
      return {
        paymaster: '0x' + '66'.repeat(20),
        paymasterData: '0xf1a1',
        paymasterPostOpGasLimit: '0x50',
      };
    }
    throw new Error(`unexpected paymaster method ${method}`);
  };
  return { calls, node, bundler, paymaster };
}

const FEES = { maxFeePerGas: 100n, maxPriorityFeePerGas: 2n };

describe('SmartAccountClient pipeline', () => {
  it('runs stub -> estimate -> final paymaster -> sign -> send, in order', async () => {
    const { calls, node, bundler, paymaster } = makeTransports({
      deployed: false,
      sponsored: true,
    });
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      paymaster: { transport: paymaster, context: { policy: 'p1' } },
      spec,
    });
    const owner = ownerAccount();
    const { userOpHash, userOp } = await client.sendCalls(
      owner,
      [{ to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', value: 1n, data: new Uint8Array(0) }],
      FEES,
    );

    expect(userOpHash).toBe('0xuserophash');
    const order = calls.map((c) => c.method);
    expect(order).toEqual([
      'eth_getCode',
      'eth_call',
      'pm_getPaymasterStubData',
      'eth_estimateUserOperationGas',
      'pm_getPaymasterData',
      'eth_sendUserOperation',
    ]);
    // Undeployed account includes factory args; nonce came from EntryPoint.
    expect(userOp.factory).toBe(FACTORY);
    expect(userOp.nonce).toBe(5n);
    expect(userOp.callGasLimit).toBe(0x111n);
    expect(userOp.paymasterVerificationGasLimit).toBe(0x444n);
    expect(userOp.paymasterPostOpGasLimit).toBe(0x50n);
  });

  it('skips factory args when deployed and paymaster when unsponsored', async () => {
    const { calls, node, bundler, paymaster } = makeTransports({
      deployed: true,
      sponsored: false,
    });
    void paymaster;
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec,
    });
    const { userOp } = await client.sendCalls(ownerAccount(), [], FEES);
    expect(userOp.factory).toBeUndefined();
    expect(userOp.paymaster).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual([
      'eth_getCode',
      'eth_call',
      'eth_estimateUserOperationGas',
      'eth_sendUserOperation',
    ]);
  });

  it('signs the v0.7 userOpHash so the owner address recovers (EIP-191 form)', async () => {
    const { node, bundler } = makeTransports({ deployed: true, sponsored: false });
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec,
    });
    const owner = ownerAccount();
    const { userOp } = await client.sendCalls(owner, [], FEES);
    const digest = getUserOpHash(userOp, ENTRYPOINT_V07, 1n);
    // ethers.recoverAddress over the EIP-191 wrapped digest must yield the
    // owner EOA — proving signature bytes, v handling, and hash all line up
    // with an independent implementation.
    const recovered = recoverAddress(hashMessage(digest), toHex(userOp.signature));
    expect(recovered).toBe(owner.address);
  });
});

describe('SmartAccountClient asynchronous signing and nonce keys', () => {
  it('awaits an async signUserOpHash, after estimation, with the exact operation as context', async () => {
    const { calls, node, bundler } = makeTransports({ deployed: true, sponsored: false });
    const seen: Array<{ hash: string; context: unknown; callsSoFar: string[] }> = [];
    const asyncSpec: SmartAccountSpec = {
      ...spec,
      signUserOpHash: async (owner, userOpHash, context) => {
        seen.push({ hash: toHex(userOpHash), context, callsSoFar: calls.map((c) => c.method) });
        await new Promise((resolve) => setTimeout(resolve, 1));
        return withEthereumV(owner.sign(toEthSignedMessageHash(userOpHash)));
      },
    };
    const client = new SmartAccountClient({ chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler, node, spec: asyncSpec });
    const owner = ownerAccount();
    const { userOp } = await client.sendCalls(owner, [], FEES);
    expect(seen).toHaveLength(1);
    // Signing happened after estimation and before submission.
    expect(seen[0]!.callsSoFar).toEqual(['eth_getCode', 'eth_call', 'eth_estimateUserOperationGas']);
    const sent = calls.find((c) => c.method === 'eth_sendUserOperation')!;
    expect((sent.params[0] as { signature: string }).signature).toBe(toHex(userOp.signature));
    const digest = getUserOpHash(userOp, ENTRYPOINT_V07, 1n);
    expect(seen[0]!.hash).toBe(toHex(digest));
    const context = seen[0]!.context as { userOp: UserOperation; entryPoint: string; chainId: bigint };
    expect(context.entryPoint).toBe(ENTRYPOINT_V07);
    expect(context.chainId).toBe(1n);
    expect(toHex(getUserOpHash(context.userOp, ENTRYPOINT_V07, 1n))).toBe(toHex(digest));
    expect(recoverAddress(hashMessage(digest), toHex(userOp.signature))).toBe(owner.address);
  });

  it('a rejected async signature submits nothing', async () => {
    const { calls, node, bundler } = makeTransports({ deployed: true, sponsored: false });
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec: { ...spec, signUserOpHash: async () => Promise.reject(new Error('user cancelled')) },
    });
    await expect(client.sendCalls(ownerAccount(), [], FEES)).rejects.toThrow(/user cancelled/);
    expect(calls.map((c) => c.method)).not.toContain('eth_sendUserOperation');
  });

  it('beforeSign sees the final operation before the spec signs, and a throw stops the send', async () => {
    const { calls, node, bundler, paymaster } = makeTransports({ deployed: true, sponsored: true });
    const seen: UserOperation[] = [];
    let signedBeforeHook = false;
    let signed = false;
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      paymaster: { transport: paymaster },
      spec: {
        ...spec,
        signUserOpHash: (owner, hash) => {
          signed = true;
          return spec.signUserOpHash(owner, hash);
        },
      },
    });
    const { userOp } = await client.sendCalls(ownerAccount(), [], FEES, {
      beforeSign: (op) => {
        signedBeforeHook = signed;
        seen.push(op);
      },
    });
    expect(signedBeforeHook).toBe(false);
    expect(seen).toHaveLength(1);
    // The hook got the operation exactly as it was then signed (final
    // paymaster data included), apart from the signature itself.
    expect({ ...seen[0]!, signature: userOp.signature }).toEqual(userOp);
    expect(seen[0]!.paymasterPostOpGasLimit).toBe(0x50n);
    expect(requiredPrefund(seen[0]!)).toBe(requiredPrefund(userOp));

    calls.length = 0;
    signed = false;
    await expect(
      client.sendCalls(ownerAccount(), [], FEES, {
        beforeSign: () => {
          throw new Error('fee above the reviewed worst case');
        },
      }),
    ).rejects.toThrow(/fee above the reviewed worst case/);
    expect(signed).toBe(false);
    expect(calls.map((c) => c.method)).not.toContain('eth_sendUserOperation');
  });

  it('reads the nonce for getNonceKey and refuses an answer for another key', async () => {
    const key = 0x010203040506070809101112131415161718192021222324n; // 24 bytes, < 2^192
    const reads: string[] = [];
    let answerKey = key;
    const node: JsonRpcTransport = async (method, params) => {
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const data = (params[0] as { data: string }).data;
      reads.push(data);
      return '0x' + ((answerKey << 64n) | 9n).toString(16).padStart(64, '0');
    };
    const bundler: JsonRpcTransport = async () => {
      throw new Error('unexpected');
    };
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec: { ...spec, getNonceKey: () => key },
    });
    expect(await client.getNonce(ownerAccount())).toBe((key << 64n) | 9n);
    // getNonce(address,uint192): selector, the address word, then the key word.
    const iface = new Interface(['function getNonce(address sender, uint192 key)']);
    expect(reads[0]).toBe(iface.encodeFunctionData('getNonce', [ACCOUNT_ADDRESS, key]));
    answerKey = key + 1n;
    await expect(client.getNonce(ownerAccount())).rejects.toThrow(/different key/);
    const tooBig = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec: { ...spec, getNonceKey: () => 1n << 192n },
    });
    await expect(tooBig.getNonce(ownerAccount())).rejects.toThrow(/uint192/);
  });

  it('without getNonceKey the read is key 0, byte-identical to before', async () => {
    const reads: string[] = [];
    const node: JsonRpcTransport = async (_method, params) => {
      reads.push((params[0] as { data: string }).data);
      return '0x05';
    };
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler: async () => null,
      node,
      spec,
    });
    expect(await client.getNonce(ownerAccount())).toBe(5n);
    const iface = new Interface(['function getNonce(address sender, uint192 key)']);
    expect(reads[0]).toBe(iface.encodeFunctionData('getNonce', [ACCOUNT_ADDRESS, 0n]));
  });
});

describe('EIP-191 helper', () => {
  it('matches ethers.hashMessage for a 32-byte digest', () => {
    const digest = keccak_256(utf8ToBytes('doge'));
    expect(toHex(toEthSignedMessageHash(digest))).toBe(hashMessage(digest));
  });

  it('withEthereumV maps recid to 27/28 and rejects junk', () => {
    const sig = new Uint8Array(65);
    sig[64] = 1;
    expect(withEthereumV(sig)[64]).toBe(28);
    sig[64] = 27;
    expect(withEthereumV(sig)[64]).toBe(27);
    sig[64] = 9;
    expect(() => withEthereumV(sig)).toThrow(/recovery byte/);
  });
});

describe('waitForReceipt', () => {
  it('polls until a receipt appears', async () => {
    let attempts = 0;
    const bundler: JsonRpcTransport = async (method) => {
      if (method === 'eth_getUserOperationReceipt') {
        attempts += 1;
        return attempts < 3 ? null : { done: true };
      }
      throw new Error('unexpected');
    };
    const node: JsonRpcTransport = async () => '0x';
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec,
    });
    const receipt = await client.waitForReceipt('0xhash', { timeoutMs: 5_000, pollMs: 1 });
    expect(receipt).toEqual({ done: true });
    expect(attempts).toBe(3);
  });
});

describe('EntryPoint deposit top-up headroom', () => {
  // Estimates from makeTransports: call 0x111, verification 0x222, pre 0x333.
  const ESTIMATED_TOTAL = 0x111n + 0x222n + 0x333n;
  const balanceOfSelector = toHex(keccak_256(utf8ToBytes('balanceOf(address)')).slice(0, 4));
  const getNonceSelector = toHex(keccak_256(utf8ToBytes('getNonce(address,uint192)')).slice(0, 4));

  function base(): UserOperation {
    return {
      sender: ACCOUNT_ADDRESS,
      nonce: 0n,
      callData: new Uint8Array(0),
      callGasLimit: 10n,
      verificationGasLimit: 20n,
      preVerificationGas: 30n,
      maxFeePerGas: 7n,
      maxPriorityFeePerGas: 1n,
      signature: new Uint8Array(0),
    };
  }

  it('requiredPrefund follows EntryPoint v0.7 _getRequiredPrefund', () => {
    expect(requiredPrefund(base())).toBe(60n * 7n);
    expect(
      requiredPrefund({ ...base(), paymasterVerificationGasLimit: 5n, paymasterPostOpGasLimit: 4n }),
    ).toBe(69n * 7n);
  });

  it('needsDepositTopUp mirrors `bal > requiredPrefund ? 0 : requiredPrefund - bal` and skips paymaster ops', () => {
    const op = base();
    expect(needsDepositTopUp(op, 0n)).toBe(true);
    expect(needsDepositTopUp(op, 419n)).toBe(true);
    // Equal: missingAccountFunds = 420 - 420 = 0, so no top-up call happens.
    expect(needsDepositTopUp(op, 420n)).toBe(false);
    expect(needsDepositTopUp({ ...op, paymaster: '0x' + '66'.repeat(20) }, 0n)).toBe(false);
    expect(withDepositTopUpHeadroom(op, 0n, 40_000n)).toBe(40_020n);
    expect(withDepositTopUpHeadroom(op, 420n, 40_000n)).toBe(20n);
    expect(withDepositTopUpHeadroom(op, 0n, 0n)).toBe(20n);
  });

  function transportsWithDeposit(deposit: bigint) {
    const t = makeTransports({ deployed: true, sponsored: false });
    const reads: string[] = [];
    const node: JsonRpcTransport = async (method, params) => {
      if (method === 'eth_call') {
        const data = (params[0] as { data: string }).data;
        reads.push(data.slice(0, 10));
        if (data.startsWith(balanceOfSelector)) {
          // the sender argument is the account itself
          expect(data.slice(-40)).toBe(ACCOUNT_ADDRESS.slice(2));
          return '0x' + deposit.toString(16);
        }
        if (data.startsWith(getNonceSelector)) return '0x05';
      }
      return t.node(method, params);
    };
    return { ...t, node, reads };
  }

  it('adds the headroom to the SIGNED operation when the deposit does not cover the prefund', async () => {
    const { node, bundler, calls, reads } = transportsWithDeposit(0n);
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec,
      depositTopUpVerificationGas: 40_000n,
    });
    const owner = ownerAccount();
    expect(client.depositTopUpVerificationGas).toBe(40_000n);
    const { userOp } = await client.sendCalls(owner, [], FEES);
    expect(userOp.verificationGasLimit).toBe(0x222n + 40_000n);
    expect(reads).toEqual([getNonceSelector, balanceOfSelector]);
    // The submitted operation is the one with the headroom, and the
    // signature covers it.
    const sent = calls.find((c) => c.method === 'eth_sendUserOperation')!.params[0] as {
      verificationGasLimit: string;
    };
    expect(BigInt(sent.verificationGasLimit)).toBe(0x222n + 40_000n);
    const recovered = recoverAddress(
      hashMessage(getUserOpHash(userOp, ENTRYPOINT_V07, 1n)),
      toHex(userOp.signature),
    );
    expect(recovered).toBe(owner.address);
  });

  it('leaves the estimate unchanged when the deposit already covers the prefund', async () => {
    const { node, bundler } = transportsWithDeposit(ESTIMATED_TOTAL * FEES.maxFeePerGas);
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec,
      depositTopUpVerificationGas: 40_000n,
    });
    const { userOp } = await client.sendCalls(ownerAccount(), [], FEES);
    expect(userOp.verificationGasLimit).toBe(0x222n);
  });

  it('decides on the padded limits (gasPaddingPct applies first)', async () => {
    // Deposit exactly covers the UNPADDED prefund but not the padded one.
    const { node, bundler } = transportsWithDeposit(ESTIMATED_TOTAL * FEES.maxFeePerGas);
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec,
      gasPaddingPct: { verification: 200 },
      depositTopUpVerificationGas: 40_000n,
    });
    const { userOp } = await client.sendCalls(ownerAccount(), [], FEES);
    expect(userOp.verificationGasLimit).toBe(0x222n * 2n + 40_000n);
  });

  it('never reads the deposit for paymaster-sponsored operations', async () => {
    const t = makeTransports({ deployed: true, sponsored: true });
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler: t.bundler,
      node: t.node,
      paymaster: { transport: t.paymaster },
      spec,
      depositTopUpVerificationGas: 40_000n,
    });
    const { userOp } = await client.sendCalls(ownerAccount(), [], FEES);
    expect(userOp.verificationGasLimit).toBe(0x222n);
    expect(t.calls.filter((c) => c.method === 'eth_call')).toHaveLength(1); // getNonce only
  });

  it('falls back to the estimate when the deposit cannot be read', async () => {
    const t = makeTransports({ deployed: true, sponsored: false });
    const node: JsonRpcTransport = async (method, params) => {
      const data = method === 'eth_call' ? (params[0] as { data: string }).data : '';
      if (data.startsWith(balanceOfSelector)) throw new Error('node refused');
      return t.node(method, params);
    };
    const client = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler: t.bundler,
      node,
      spec,
      depositTopUpVerificationGas: 40_000n,
    });
    const { userOp } = await client.sendCalls(ownerAccount(), [], FEES);
    expect(userOp.verificationGasLimit).toBe(0x222n);
  });
});

describe('impossible gas estimates (zero limits) are refused before signing', () => {
  const REAL = { callGasLimit: '0x111', verificationGasLimit: '0x222', preVerificationGas: '0x333' };
  const TO = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const NO_WAIT = { attempts: 3, delayMs: 0 };

  /** A bundler answering `answers` in turn (the last one repeats), counting estimates and sends. */
  function scriptedBundler(answers: Record<string, string>[]) {
    let estimates = 0;
    let sends = 0;
    const bundler: JsonRpcTransport = async (method) => {
      if (method === 'eth_estimateUserOperationGas') {
        const answer = answers[Math.min(estimates, answers.length - 1)]!;
        estimates++;
        return answer;
      }
      if (method === 'eth_sendUserOperation') {
        sends++;
        return '0xuserophash';
      }
      throw new Error(`unexpected bundler method ${method}`);
    };
    return { bundler, counts: () => ({ estimates, sends }) };
  }

  function countingSpec() {
    let signed = 0;
    const counted: SmartAccountSpec = {
      ...spec,
      signUserOpHash: (owner, hash) => {
        signed++;
        return spec.signUserOpHash(owner, hash);
      },
    };
    return { spec: counted, signed: () => signed };
  }

  const baseOp = (over: Partial<UserOperation> = {}): UserOperation => ({
    sender: ACCOUNT_ADDRESS,
    nonce: 0n,
    callData: new Uint8Array([1]),
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    signature: new Uint8Array(0),
    ...over,
  });

  it('names each zero field, and accepts a zero paymasterPostOpGasLimit', () => {
    const ok = { callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n };
    expect(gasLimitProblems(ok, false)).toEqual([]);
    expect(gasLimitProblems({ ...ok, verificationGasLimit: 0n }, false)[0]).toMatch(/^verificationGasLimit is 0/);
    expect(gasLimitProblems({ ...ok, callGasLimit: 0n }, false)[0]).toMatch(/^callGasLimit is 0/);
    expect(gasLimitProblems({ ...ok, preVerificationGas: 0n }, false)[0]).toMatch(/^preVerificationGas is 0/);
    // A paymaster needs a non-zero verification limit; absent counts as 0.
    expect(gasLimitProblems(ok, true)[0]).toMatch(/^paymasterVerificationGasLimit is 0/);
    expect(gasLimitProblems({ ...ok, paymasterVerificationGasLimit: 0n }, true)).toHaveLength(1);
    expect(gasLimitProblems({ ...ok, paymasterVerificationGasLimit: 1n, paymasterPostOpGasLimit: 0n }, true)).toEqual([]);
    // Without a paymaster its limits are not judged.
    expect(gasLimitProblems({ ...ok, paymasterVerificationGasLimit: 0n }, false)).toEqual([]);
    // All at once: one reason per field.
    expect(gasLimitProblems({ callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n }, true)).toHaveLength(4);
  });

  it('judges an estimate that omits the paymaster limit by the limit the operation already carries', () => {
    const estimate = { callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n };
    const pm = '0x' + '66'.repeat(20);
    expect(gasEstimateProblems(estimate, baseOp({ paymaster: pm, paymasterVerificationGasLimit: 5n }))).toEqual([]);
    expect(gasEstimateProblems(estimate, baseOp({ paymaster: pm }))).toHaveLength(1);
    expect(gasEstimateProblems({ ...estimate, paymasterVerificationGasLimit: 0n }, baseOp({ paymaster: pm, paymasterVerificationGasLimit: 5n }))).toHaveLength(1);
  });

  it('the default retry policy is 4 attempts, 2 s apart', () => {
    expect(DEFAULT_ESTIMATE_RETRIES).toEqual({ attempts: 4, delayMs: 2_000 });
  });

  for (const field of ['verificationGasLimit', 'callGasLimit', 'preVerificationGas'] as const) {
    it(`refuses an estimate with ${field} 0 on every attempt: nothing signed or sent`, async () => {
      const { bundler, counts } = scriptedBundler([{ ...REAL, [field]: '0x0' }]);
      const { node } = makeTransports({ deployed: true, sponsored: false });
      const counted = countingSpec();
      const client = new SmartAccountClient({ chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler, node, spec: counted.spec, estimateRetries: NO_WAIT });
      const err = await client.sendCalls(ownerAccount(), [{ to: TO, value: 1n, data: new Uint8Array(0) }], FEES).catch((e) => e);
      expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
      expect(err.name).toBe('ImpossibleGasEstimateError');
      expect(err.attempts).toBe(3);
      expect(err.source).toBe('estimate');
      expect(err.fields[field]).toBe(0n);
      expect(err.problems).toHaveLength(1);
      expect(err.problems[0]).toMatch(new RegExp(`^${field} is 0`));
      expect(err.message).toMatch(/on all 3 attempts/);
      expect(err.message).toMatch(/not signed or submitted/);
      expect(counts()).toEqual({ estimates: 3, sends: 0 });
      expect(counted.signed()).toBe(0);
    });
  }

  it('refuses a sponsored estimate whose paymasterVerificationGasLimit is 0 (the Arbitrum Sepolia answer)', async () => {
    // The shape ZeroDev's Arbitrum Sepolia endpoint answered on 2026-10-09.
    const zero = { callGasLimit: '0xcb36', verificationGasLimit: '0x0', preVerificationGas: '0xdae9', paymasterVerificationGasLimit: '0x0' };
    const { bundler, counts } = scriptedBundler([zero]);
    const { node, paymaster } = makeTransports({ deployed: true, sponsored: true });
    const counted = countingSpec();
    const client = new SmartAccountClient({
      chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler, node, spec: counted.spec,
      paymaster: { transport: paymaster }, estimateRetries: { attempts: 2, delayMs: 0 },
    });
    const err = await client.sendCalls(ownerAccount(), [{ to: TO, value: 1n, data: new Uint8Array(0) }], FEES).catch((e) => e);
    expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
    expect(err.problems.map((p: string) => p.split(' ')[0])).toEqual(['verificationGasLimit', 'paymasterVerificationGasLimit']);
    expect(err.fields).toMatchObject({ callGasLimit: 0xcb36n, verificationGasLimit: 0n, paymasterVerificationGasLimit: 0n });
    expect(counts()).toEqual({ estimates: 2, sends: 0 });
    expect(counted.signed()).toBe(0);
  });

  it('asks again after an impossible answer and then sends exactly what a clean first answer would have produced', async () => {
    const owner = ownerAccount();
    const calls = [{ to: TO, value: 1n, data: new Uint8Array(0) }];
    const clean = scriptedBundler([REAL]);
    const reference = await new SmartAccountClient({
      chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler: clean.bundler, node: makeTransports({ deployed: true, sponsored: false }).node, spec,
    }).sendCalls(owner, calls, FEES);
    const flaky = scriptedBundler([{ ...REAL, verificationGasLimit: '0x0' }, { ...REAL, preVerificationGas: '0x0' }, REAL]);
    const retried = await new SmartAccountClient({
      chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler: flaky.bundler, node: makeTransports({ deployed: true, sponsored: false }).node, spec,
      estimateRetries: NO_WAIT,
    }).sendCalls(owner, calls, FEES);
    expect(flaky.counts()).toEqual({ estimates: 3, sends: 1 });
    expect(retried.userOp).toEqual(reference.userOp);
  });

  it('waits delayMs between attempts and not after the last', async () => {
    const { bundler } = scriptedBundler([{ ...REAL, verificationGasLimit: '0x0' }]);
    const started = Date.now();
    const err = await new BundlerClient(bundler, ENTRYPOINT_V07)
      .estimateUserOperationGasChecked(baseOp(), { attempts: 3, delayMs: 60 })
      .catch((e) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
    expect(elapsed).toBeGreaterThanOrEqual(110); // two waits of 60 ms (timer slack allowed)
    expect(elapsed).toBeLessThan(1_000);
  });

  it('a single attempt asks once; a bundler error is thrown at once, not retried', async () => {
    const once = scriptedBundler([{ ...REAL, callGasLimit: '0x0' }]);
    const err = await new BundlerClient(once.bundler, ENTRYPOINT_V07)
      .estimateUserOperationGasChecked(baseOp(), { attempts: 1, delayMs: 0 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
    expect(err.message).not.toMatch(/attempts/);
    expect(once.counts().estimates).toBe(1);
    let asked = 0;
    const failing: JsonRpcTransport = async () => {
      asked++;
      throw new Error('RPC error -32500: AA23 reverted (eth_estimateUserOperationGas)');
    };
    await expect(
      new BundlerClient(failing, ENTRYPOINT_V07).estimateUserOperationGasChecked(baseOp(), NO_WAIT),
    ).rejects.toThrow(/AA23 reverted/);
    expect(asked).toBe(1);
  });

  it('refuses the final operation when padding below 100 percent would leave a zero limit', async () => {
    const { bundler, counts } = scriptedBundler([{ ...REAL, verificationGasLimit: '0x1' }]);
    const counted = countingSpec();
    const client = new SmartAccountClient({
      chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler, node: makeTransports({ deployed: true, sponsored: false }).node, spec: counted.spec,
      gasPaddingPct: { verification: 50 },
    });
    let beforeSign = 0;
    const err = await client
      .sendCalls(ownerAccount(), [{ to: TO, value: 1n, data: new Uint8Array(0) }], FEES, { beforeSign: () => { beforeSign++; } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
    expect(err.source).toBe('operation');
    expect(err.message).toMatch(/^The operation would carry an impossible gas limit/);
    expect(beforeSign).toBe(0);
    expect(counted.signed()).toBe(0);
    expect(counts().sends).toBe(0);
  });

  it('refuses final paymaster data that sets the paymaster verification limit to 0', async () => {
    // The stub gives a limit and the estimate omits one (so the estimate
    // passes on the stub's); the final data then answers 0, which would be
    // packed into the signed paymasterAndData.
    const { bundler, counts } = scriptedBundler([REAL]);
    const { node } = makeTransports({ deployed: true, sponsored: true });
    const pm = '0x' + '66'.repeat(20);
    const paymaster: JsonRpcTransport = async (method) => {
      if (method === 'pm_getPaymasterStubData') return { paymaster: pm, paymasterData: '0x00', paymasterVerificationGasLimit: '0x4444' };
      if (method === 'pm_getPaymasterData') return { paymaster: pm, paymasterData: '0xf1a1', paymasterVerificationGasLimit: '0x0', paymasterPostOpGasLimit: '0x0' };
      throw new Error(method);
    };
    const counted = countingSpec();
    const client = new SmartAccountClient({ chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler, node, spec: counted.spec, paymaster: { transport: paymaster } });
    const err = await client.sendCalls(ownerAccount(), [{ to: TO, value: 1n, data: new Uint8Array(0) }], FEES).catch((e) => e);
    expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
    expect(err.source).toBe('operation');
    // Only the verification limit is named: a zero postOp limit is allowed.
    expect(err.problems).toHaveLength(1);
    expect(err.problems[0]).toMatch(/^paymasterVerificationGasLimit is 0/);
    expect(counts()).toEqual({ estimates: 1, sends: 0 });
    expect(counted.signed()).toBe(0);
  });

  it('refuses at the estimate when neither the stub nor the estimate gives a paymaster verification limit', async () => {
    const { bundler, counts } = scriptedBundler([REAL]);
    const { node, paymaster } = makeTransports({ deployed: true, sponsored: true });
    const client = new SmartAccountClient({
      chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler, node, spec, paymaster: { transport: paymaster }, estimateRetries: NO_WAIT,
    });
    const err = await client.sendCalls(ownerAccount(), [{ to: TO, value: 1n, data: new Uint8Array(0) }], FEES).catch((e) => e);
    expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
    expect(err.source).toBe('estimate');
    expect(err.problems[0]).toMatch(/^paymasterVerificationGasLimit is 0/);
    expect(counts()).toEqual({ estimates: 3, sends: 0 });
  });
});

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
  ESTIMATE_BEFORE_SIGNING_7702_REFUSAL,
  PRE_CHECKED_ESTIMATE_MAX_AGE_MS,
  SmartAccountClient,
  addressOnlyOwner,
  needsDepositTopUp,
  preCheckedEstimateMismatch,
  requiredPrefund,
  toEthSignedMessageHash,
  withDepositTopUpHeadroom,
  withEthereumV,
  type Call,
  type PreCheckedGasEstimate,
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

describe('beforeSend: the signed operation and its hash, right before eth_sendUserOperation (phase 23 item 8)', () => {
  it('runs once, after the signature, with the local userOpHash, before the bundler is asked', async () => {
    const { calls, node, bundler } = makeTransports({ deployed: true, sponsored: false });
    let signed = false;
    const client = new SmartAccountClient({
      chainId: 11155111n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec: {
        ...spec,
        signUserOpHash: (owner, hash) => {
          signed = true;
          return spec.signUserOpHash(owner, hash);
        },
      },
    });
    const seen: Array<{ op: UserOperation; hash: string; signedThen: boolean; methodsThen: string[] }> = [];
    const { userOp } = await client.sendCalls(ownerAccount(), [], FEES, {
      beforeSend: (op, hash) => {
        seen.push({ op, hash, signedThen: signed, methodsThen: calls.map((c) => c.method) });
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signedThen).toBe(true);
    expect(seen[0]!.methodsThen).not.toContain('eth_sendUserOperation');
    expect(seen[0]!.op).toEqual(userOp);
    expect(seen[0]!.hash).toBe(toHex(getUserOpHash(userOp, ENTRYPOINT_V07, 11155111n)));
    expect(calls.filter((c) => c.method === 'eth_sendUserOperation')).toHaveLength(1);
  });

  it('a throwing hook stops the send before the bundler; a failed signature never reaches it', async () => {
    const { calls, node, bundler } = makeTransports({ deployed: true, sponsored: false });
    const client = new SmartAccountClient({ chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler, node, spec });
    await expect(
      client.sendCalls(ownerAccount(), [], FEES, {
        beforeSend: () => {
          throw new Error('could not record');
        },
      }),
    ).rejects.toThrow(/could not record/);
    expect(calls.map((c) => c.method)).not.toContain('eth_sendUserOperation');

    let hookCalls = 0;
    const refusing = new SmartAccountClient({
      chainId: 1n,
      entryPoint: ENTRYPOINT_V07,
      bundler,
      node,
      spec: { ...spec, signUserOpHash: () => Promise.reject(new Error('user cancelled')) },
    });
    await expect(
      refusing.sendCalls(ownerAccount(), [], FEES, { beforeSend: () => void hookCalls++ }),
    ).rejects.toThrow(/user cancelled/);
    expect(hookCalls).toBe(0);
  });

  it('without a hook the requests are exactly as before', async () => {
    const a = makeTransports({ deployed: true, sponsored: false });
    const b = makeTransports({ deployed: true, sponsored: false });
    const make = (t: ReturnType<typeof makeTransports>) =>
      new SmartAccountClient({ chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler: t.bundler, node: t.node, spec });
    await make(a).sendCalls(ownerAccount(), [], FEES);
    await make(b).sendCalls(ownerAccount(), [], FEES, { beforeSend: () => undefined });
    expect(b.calls).toEqual(a.calls);
  });
});

describe('a pre-checked estimate stands in for an impossible send-time estimate (pass p27-emu2 finding 1)', () => {
  const REAL = { callGasLimit: '0x111', verificationGasLimit: '0x222', preVerificationGas: '0x333' };
  const ZERO = { callGasLimit: '0xcb36', verificationGasLimit: '0x0', preVerificationGas: '0xdae9' };
  const TO = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const CALLS: Call[] = [{ to: TO, value: 1n, data: new Uint8Array(0) }];
  const NO_WAIT = { attempts: 3, delayMs: 0 };
  const NOW = 1_800_000_000_000;

  /** Answers the first estimate with `first`, every later one with `rest`; counts estimates and sends. */
  function burstBundler(first: Record<string, string>, rest: Record<string, string> | Error) {
    let estimates = 0;
    let sends = 0;
    const seen: unknown[] = [];
    const bundler: JsonRpcTransport = async (method, params) => {
      if (method === 'eth_estimateUserOperationGas') {
        seen.push(params[0]);
        estimates++;
        if (estimates === 1) return first;
        if (rest instanceof Error) throw rest;
        return rest;
      }
      if (method === 'eth_sendUserOperation') {
        sends++;
        return '0xuserophash';
      }
      throw new Error(`unexpected bundler method ${method}`);
    };
    return { bundler, seen, counts: () => ({ estimates, sends }) };
  }

  /** The stub operation sendCalls builds for CALLS on the deployed fake account (nonce 5). */
  const stubOp = (over: Partial<UserOperation> = {}): UserOperation => ({
    sender: ACCOUNT_ADDRESS,
    nonce: 5n,
    callData: spec.encodeCalls(CALLS),
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: FEES.maxFeePerGas,
    maxPriorityFeePerGas: FEES.maxPriorityFeePerGas,
    signature: spec.stubSignature(),
    ...over,
  });

  /** The pre-prompt step: one checked estimate of the stub op through the same bundler. */
  async function prePrompt(bundler: JsonRpcTransport, op = stubOp(), at = NOW): Promise<PreCheckedGasEstimate> {
    const estimate = await new BundlerClient(bundler, ENTRYPOINT_V07).estimateUserOperationGasChecked(op, { attempts: 1, delayMs: 0 });
    return { op, estimate, checkedAtMs: at, chainId: 1n, entryPoint: ENTRYPOINT_V07 };
  }

  function client(bundler: JsonRpcTransport, over: Record<string, unknown> = {}) {
    let signed = 0;
    const counted: SmartAccountSpec = {
      ...spec,
      signUserOpHash: (owner, hash) => {
        signed++;
        return spec.signUserOpHash(owner, hash);
      },
    };
    const c = new SmartAccountClient({
      chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler, node: makeTransports({ deployed: true, sponsored: false }).node,
      spec: counted, estimateRetries: NO_WAIT, ...over,
    });
    return { client: c, signed: () => signed };
  }

  it('the age bound is 90 seconds', () => {
    expect(PRE_CHECKED_ESTIMATE_MAX_AGE_MS).toBe(90_000);
  });

  it('good once, zeros forever after: the send succeeds with the pre-checked limits, asking the bundler once', async () => {
    const b = burstBundler(REAL, ZERO);
    const pre = await prePrompt(b.bundler);
    const { client: c, signed } = client(b.bundler);
    const seenBySign: UserOperation[] = [];
    const { userOp } = await c.sendCalls(ownerAccount(), CALLS, FEES, {
      preCheckedEstimate: pre,
      nowMs: () => NOW + 15_000,
      beforeSign: (op) => void seenBySign.push(op),
    });
    // 1 pre-prompt estimate + exactly 1 send-time estimate (no retries), 1 send.
    expect(b.counts()).toEqual({ estimates: 2, sends: 1 });
    expect(signed()).toBe(1);
    expect(userOp.callGasLimit).toBe(0x111n);
    expect(userOp.verificationGasLimit).toBe(0x222n);
    expect(userOp.preVerificationGas).toBe(0x333n);
    expect(userOp.maxFeePerGas).toBe(FEES.maxFeePerGas);
    expect(userOp.maxPriorityFeePerGas).toBe(FEES.maxPriorityFeePerGas);
    expect(seenBySign[0]!.callGasLimit).toBe(0x111n);
    // The send-time request was the same operation the pre-prompt estimate saw.
    expect(b.seen[1]).toEqual(b.seen[0]);
  });

  it('beforeSign still decides: a worst case above the displayed fee is refused, nothing signed or sent', async () => {
    const b = burstBundler(REAL, ZERO);
    const pre = await prePrompt(b.bundler);
    const { client: c, signed } = client(b.bundler);
    const displayed = requiredPrefund({ ...stubOp(), callGasLimit: 0x111n, verificationGasLimit: 0x222n, preVerificationGas: 0x333n }) - 1n;
    const err = await c
      .sendCalls(ownerAccount(), CALLS, FEES, {
        preCheckedEstimate: pre,
        nowMs: () => NOW,
        beforeSign: (op) => {
          if (requiredPrefund(op) > displayed) throw new Error('above the displayed fee');
        },
      })
      .catch((e) => e);
    expect(err.message).toBe('above the displayed fee');
    expect(signed()).toBe(0);
    expect(b.counts().sends).toBe(0);
  });

  it('the final impossible-limit check still applies to the pre-checked limits', async () => {
    const b = burstBundler({ ...REAL, verificationGasLimit: '0x1' }, ZERO);
    const pre = await prePrompt(b.bundler);
    const { client: c, signed } = client(b.bundler, { gasPaddingPct: { verification: 50 } });
    const err = await c.sendCalls(ownerAccount(), CALLS, FEES, { preCheckedEstimate: pre, nowMs: () => NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
    expect(err.source).toBe('operation');
    expect(signed()).toBe(0);
    expect(b.counts().sends).toBe(0);
  });

  it('a usable send-time answer is preferred to the pre-checked one', async () => {
    const fresh = { callGasLimit: '0x999', verificationGasLimit: '0x888', preVerificationGas: '0x777' };
    const b = burstBundler(REAL, fresh);
    const pre = await prePrompt(b.bundler);
    const { client: c } = client(b.bundler);
    const { userOp } = await c.sendCalls(ownerAccount(), CALLS, FEES, { preCheckedEstimate: pre, nowMs: () => NOW });
    expect(userOp.callGasLimit).toBe(0x999n);
    expect(userOp.verificationGasLimit).toBe(0x888n);
    expect(b.counts()).toEqual({ estimates: 2, sends: 1 });
  });

  it('a bundler error at send time is thrown, never replaced by the pre-checked estimate', async () => {
    const b = burstBundler(REAL, new Error('RPC error -32500: AA23 reverted (eth_estimateUserOperationGas)'));
    const pre = await prePrompt(b.bundler);
    const { client: c, signed } = client(b.bundler);
    await expect(c.sendCalls(ownerAccount(), CALLS, FEES, { preCheckedEstimate: pre, nowMs: () => NOW })).rejects.toThrow(/AA23 reverted/);
    expect(signed()).toBe(0);
    expect(b.counts()).toEqual({ estimates: 2, sends: 0 });
  });

  const refusedCases: Array<[string, (pre: PreCheckedGasEstimate) => PreCheckedGasEstimate, Record<string, unknown>?]> = [
    ['a changed nonce', (p) => ({ ...p, op: stubOp({ nonce: 6n }) })],
    ['changed callData', (p) => ({ ...p, op: stubOp({ callData: spec.encodeCalls([{ to: TO, value: 2n, data: new Uint8Array(0) }]) }) })],
    ['another deployment state (a factory)', (p) => ({ ...p, op: stubOp({ factory: FACTORY, factoryData: utf8ToBytes('init') }) })],
    ['other fees', (p) => ({ ...p, op: stubOp({ maxFeePerGas: FEES.maxFeePerGas + 1n }) })],
    ['another sender', (p) => ({ ...p, op: stubOp({ sender: '0x' + '77'.repeat(20) }) })],
    ['another chain', (p) => ({ ...p, chainId: 2n })],
    ['another EntryPoint', (p) => ({ ...p, entryPoint: '0x' + '88'.repeat(20) })],
    ['a stale estimate (one millisecond past the bound)', (p) => ({ ...p, checkedAtMs: NOW - PRE_CHECKED_ESTIMATE_MAX_AGE_MS - 1 })],
    ['an estimate from the future', (p) => ({ ...p, checkedAtMs: NOW + 1 })],
    ['an impossible pre-checked estimate', (p) => ({ ...p, estimate: { ...p.estimate, verificationGasLimit: 0n } })],
  ];
  for (const [what, alter] of refusedCases) {
    it(`no reuse with ${what}: the old retries run and the old refusal stands`, async () => {
      const b = burstBundler(REAL, ZERO);
      const pre = alter(await prePrompt(b.bundler));
      const { client: c, signed } = client(b.bundler);
      const err = await c.sendCalls(ownerAccount(), CALLS, FEES, { preCheckedEstimate: pre, nowMs: () => NOW }).catch((e) => e);
      expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
      expect(err.attempts).toBe(NO_WAIT.attempts);
      expect(b.counts()).toEqual({ estimates: 1 + NO_WAIT.attempts, sends: 0 });
      expect(signed()).toBe(0);
    });
  }

  it('the bound itself is inclusive: exactly 90 s old is still used', async () => {
    const b = burstBundler(REAL, ZERO);
    const pre = await prePrompt(b.bundler, stubOp(), NOW - PRE_CHECKED_ESTIMATE_MAX_AGE_MS);
    const { client: c } = client(b.bundler);
    const { userOp } = await c.sendCalls(ownerAccount(), CALLS, FEES, { preCheckedEstimate: pre, nowMs: () => NOW });
    expect(userOp.verificationGasLimit).toBe(0x222n);
  });

  it('never with a paymaster: the client with a paymaster retries and refuses as before', async () => {
    const b = burstBundler({ ...REAL, paymasterVerificationGasLimit: '0x444' }, { ...ZERO, paymasterVerificationGasLimit: '0x0' });
    const pre = await prePrompt(b.bundler);
    const { paymaster } = makeTransports({ deployed: true, sponsored: true });
    const { client: c, signed } = client(b.bundler, { paymaster: { transport: paymaster } });
    const err = await c.sendCalls(ownerAccount(), CALLS, FEES, { preCheckedEstimate: pre, nowMs: () => NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
    expect(err.attempts).toBe(NO_WAIT.attempts);
    expect(signed()).toBe(0);
    expect(preCheckedEstimateMismatch(pre, stubOp(), { chainId: 1n, entryPoint: ENTRYPOINT_V07, nowMs: NOW, clientHasPaymaster: true })).toMatch(/paymaster/);
    expect(preCheckedEstimateMismatch({ ...pre, op: stubOp({ paymaster: '0x' + '66'.repeat(20) }) }, stubOp(), { chainId: 1n, entryPoint: ENTRYPOINT_V07, nowMs: NOW, clientHasPaymaster: false })).toMatch(/paymaster/);
  });

  it('never with an EIP-7702 authorization', () => {
    const auth = { chainId: 1n, address: '0x' + '99'.repeat(20), nonce: 0n, yParity: 0, r: 1n, s: 1n };
    const op = stubOp({ eip7702Auth: auth } as Partial<UserOperation>);
    const pre: PreCheckedGasEstimate = { op, estimate: { callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n }, checkedAtMs: NOW, chainId: 1n, entryPoint: ENTRYPOINT_V07 };
    expect(preCheckedEstimateMismatch(pre, op, { chainId: 1n, entryPoint: ENTRYPOINT_V07, nowMs: NOW, clientHasPaymaster: false })).toMatch(/EIP-7702/);
  });

  it('a matching estimate gives null; the EntryPoint is compared without regard to case', () => {
    const pre: PreCheckedGasEstimate = { op: stubOp(), estimate: { callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n }, checkedAtMs: NOW, chainId: 1n, entryPoint: ENTRYPOINT_V07.toUpperCase().replace('0X', '0x') };
    expect(preCheckedEstimateMismatch(pre, stubOp(), { chainId: 1n, entryPoint: ENTRYPOINT_V07, nowMs: NOW, clientHasPaymaster: false })).toBeNull();
  });

  it('without the option: the same requests and the same refusal as before', async () => {
    const a = burstBundler(ZERO, ZERO);
    const errA = await client(a.bundler).client.sendCalls(ownerAccount(), CALLS, FEES).catch((e) => e);
    const b = burstBundler(ZERO, ZERO);
    const errB = await client(b.bundler).client.sendCalls(ownerAccount(), CALLS, FEES, { nowMs: () => NOW }).catch((e) => e);
    expect(errA).toBeInstanceOf(ImpossibleGasEstimateError);
    expect(errA.message).toBe(errB.message);
    expect(a.counts()).toEqual({ estimates: NO_WAIT.attempts, sends: 0 });
    expect(b.counts()).toEqual(a.counts());
    expect(b.seen).toEqual(a.seen);
    // And a clean answer gives the same signed operation with or without an unused option.
    const c1 = burstBundler(REAL, REAL);
    const c2 = burstBundler(REAL, REAL);
    const r1 = await client(c1.bundler).client.sendCalls(ownerAccount(), CALLS, FEES);
    const r2 = await client(c2.bundler).client.sendCalls(ownerAccount(), CALLS, FEES, {
      preCheckedEstimate: { op: stubOp({ nonce: 99n }), estimate: { callGasLimit: 7n, verificationGasLimit: 7n, preVerificationGas: 7n }, checkedAtMs: NOW, chainId: 1n, entryPoint: ENTRYPOINT_V07 },
      nowMs: () => NOW,
    });
    expect(r2.userOp).toEqual(r1.userOp);
  });
});

describe('estimateBeforeSigning: the estimate sendCalls would ask for, signing nothing (phase 28 item 1)', () => {
  const REAL = { callGasLimit: '0x111', verificationGasLimit: '0x222', preVerificationGas: '0x333' };
  const ZERO = { callGasLimit: '0xcb36', verificationGasLimit: '0x0', preVerificationGas: '0xdae9' };
  const TO = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const CALLS: Call[] = [{ to: TO, value: 1n, data: new Uint8Array(0) }];
  const NO_WAIT = { attempts: 3, delayMs: 0 };
  const NOW = 1_800_000_000_000;

  function recording(answers: Array<Record<string, string>>, deployed = true) {
    const { node, paymaster, calls } = makeTransports({ deployed, sponsored: false });
    const seen: unknown[] = [];
    let sends = 0;
    const bundler: JsonRpcTransport = async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_estimateUserOperationGas') {
        seen.push(params[0]);
        return answers[Math.min(seen.length - 1, answers.length - 1)];
      }
      if (method === 'eth_sendUserOperation') {
        sends++;
        return '0xuserophash';
      }
      throw new Error(`unexpected bundler method ${method}`);
    };
    return { node, paymaster, bundler, calls, seen, sends: () => sends };
  }

  function signCounting() {
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

  it('asks the bundler for exactly the stub operation sendCalls asks for, with an address-only owner, and signs and sends nothing', async () => {
    const a = recording([REAL]);
    const sa = signCounting();
    const c = new SmartAccountClient({ chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler: a.bundler, node: a.node, spec: sa.spec, estimateRetries: NO_WAIT });
    const pre = await c.estimateBeforeSigning(addressOnlyOwner(ownerAccount().address, 1n), CALLS, FEES, { nowMs: () => NOW });
    expect(sa.signed()).toBe(0);
    expect(a.sends()).toBe(0);
    expect(pre.checkedAtMs).toBe(NOW);
    expect(pre.chainId).toBe(1n);
    expect(pre.entryPoint).toBe(ENTRYPOINT_V07);
    expect(pre.estimate.verificationGasLimit).toBe(0x222n);
    const b = recording([REAL]);
    const sb = signCounting();
    const c2 = new SmartAccountClient({ chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler: b.bundler, node: b.node, spec: sb.spec, estimateRetries: NO_WAIT });
    await c2.sendCalls(ownerAccount(), CALLS, FEES);
    // The same estimate request, and the same node requests in the same order before it.
    expect(a.seen).toEqual([b.seen[0]]);
    const until = (cs: RecordedCall[]) => cs.slice(0, cs.findIndex((x) => x.method === 'eth_estimateUserOperationGas') + 1);
    expect(until(a.calls)).toEqual(until(b.calls));
    expect(preCheckedEstimateMismatch(pre, pre.op, { chainId: 1n, entryPoint: ENTRYPOINT_V07, nowMs: NOW, clientHasPaymaster: false })).toBeNull();
  });

  it('an undeployed account: the factory arguments are in the estimated operation, as in sendCalls', async () => {
    const a = recording([REAL], false);
    const c = new SmartAccountClient({ chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler: a.bundler, node: a.node, spec, estimateRetries: NO_WAIT });
    const pre = await c.estimateBeforeSigning(addressOnlyOwner(ownerAccount().address, 1n), CALLS, FEES);
    expect(pre.op.factory).toBe(FACTORY);
    expect(toHex(pre.op.factoryData!)).toBe(toHex(utf8ToBytes('init')));
  });

  it('an impossible answer is asked for again under the client\'s policy and then thrown, before anything is signed', async () => {
    const a = recording([ZERO]);
    const sa = signCounting();
    const c = new SmartAccountClient({ chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler: a.bundler, node: a.node, spec: sa.spec, estimateRetries: NO_WAIT });
    const err = await c.estimateBeforeSigning(addressOnlyOwner(ownerAccount().address, 1n), CALLS, FEES).catch((e) => e);
    expect(err).toBeInstanceOf(ImpossibleGasEstimateError);
    expect(err.attempts).toBe(NO_WAIT.attempts);
    expect(a.seen.length).toBe(NO_WAIT.attempts);
    expect(sa.signed()).toBe(0);
    expect(a.sends()).toBe(0);
  });

  it('with a paymaster: the stub data is asked for and carried, the final data is not', async () => {
    const a = recording([{ ...REAL, paymasterVerificationGasLimit: '0x444' }]);
    const c = new SmartAccountClient({
      chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler: a.bundler, node: a.node, spec, estimateRetries: NO_WAIT,
      paymaster: { transport: a.paymaster },
    });
    const pre = await c.estimateBeforeSigning(addressOnlyOwner(ownerAccount().address, 1n), CALLS, FEES);
    expect(a.calls.map((x) => x.method)).toContain('pm_getPaymasterStubData');
    expect(a.calls.map((x) => x.method)).not.toContain('pm_getPaymasterData');
    expect(pre.op.paymaster).toBe('0x' + '66'.repeat(20));
    // …and such an estimate never stands in at send time.
    expect(preCheckedEstimateMismatch(pre, pre.op, { chainId: 1n, entryPoint: ENTRYPOINT_V07, nowMs: pre.checkedAtMs, clientHasPaymaster: true })).toMatch(/paymaster/);
  });

  it('refuses an EIP-7702 spec before any request', async () => {
    const a = recording([REAL]);
    let authorizations = 0;
    const s7702: SmartAccountSpec = {
      ...spec,
      getEip7702Authorization: async () => {
        authorizations++;
        return undefined;
      },
    };
    const c = new SmartAccountClient({ chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler: a.bundler, node: a.node, spec: s7702, estimateRetries: NO_WAIT });
    const err = await c.estimateBeforeSigning(addressOnlyOwner(ownerAccount().address, 1n), CALLS, FEES).catch((e) => e);
    expect(err?.message).toBe(ESTIMATE_BEFORE_SIGNING_7702_REFUSAL);
    expect(authorizations).toBe(0);
    expect(a.calls).toEqual([]);
  });

  it('its estimate stands in at send time for a zero burst that starts after it (good once, zeros after)', async () => {
    const a = recording([REAL, ZERO]);
    const sa = signCounting();
    const c = new SmartAccountClient({ chainId: 1n, entryPoint: ENTRYPOINT_V07, bundler: a.bundler, node: a.node, spec: sa.spec, estimateRetries: NO_WAIT });
    const pre = await c.estimateBeforeSigning(addressOnlyOwner(ownerAccount().address, 1n), CALLS, FEES, { nowMs: () => NOW });
    const { userOp } = await c.sendCalls(ownerAccount(), CALLS, FEES, { preCheckedEstimate: pre, nowMs: () => NOW + 10_000 });
    expect(a.seen.length).toBe(2);
    expect(a.sends()).toBe(1);
    expect(sa.signed()).toBe(1);
    expect(userOp.verificationGasLimit).toBe(0x222n);
  });
});

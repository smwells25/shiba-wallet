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
import type { JsonRpcTransport } from '../src/rpc.js';

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

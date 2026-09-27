import { describe, expect, it } from 'vitest';
import { hashMessage, recoverAddress } from 'ethers';
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
  toEthSignedMessageHash,
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
  getAddress: () => ACCOUNT_ADDRESS,
  getFactoryArgs: () => ({ factory: FACTORY, factoryData: utf8ToBytes('init') }),
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

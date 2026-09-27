import { describe, expect, it } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ENTRYPOINT_V07, type UserOperation } from '../src/userop.js';
import {
  BundlerClient,
  PaymasterClient,
  toRpcUserOperation,
  type JsonRpcTransport,
} from '../src/rpc.js';

const op: UserOperation = {
  sender: '0x1111111111111111111111111111111111111111',
  nonce: 1n,
  callData: utf8ToBytes('call'),
  callGasLimit: 1n,
  verificationGasLimit: 2n,
  preVerificationGas: 3n,
  maxFeePerGas: 4n,
  maxPriorityFeePerGas: 5n,
  signature: new Uint8Array([0xaa]),
};

function fakeTransport(
  handler: (method: string, params: unknown[]) => unknown,
): { transport: JsonRpcTransport; calls: Array<{ method: string; params: unknown[] }> } {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  return {
    calls,
    transport: async (method, params) => {
      calls.push({ method, params });
      return handler(method, params);
    },
  };
}

describe('toRpcUserOperation', () => {
  it('hex-encodes numeric fields and omits absent optionals', () => {
    const rpc = toRpcUserOperation(op);
    expect(rpc.nonce).toBe('0x1');
    expect(rpc.maxFeePerGas).toBe('0x4');
    expect(rpc.callData).toBe('0x63616c6c');
    expect(rpc.signature).toBe('0xaa');
    expect('factory' in rpc).toBe(false);
    expect('paymaster' in rpc).toBe(false);
  });
});

describe('BundlerClient', () => {
  it('sends the op and entry point, returns the userOpHash', async () => {
    const { transport, calls } = fakeTransport(() => '0xhash');
    const bundler = new BundlerClient(transport, ENTRYPOINT_V07);
    const hash = await bundler.sendUserOperation(op);
    expect(hash).toBe('0xhash');
    expect(calls[0]!.method).toBe('eth_sendUserOperation');
    expect(calls[0]!.params[1]).toBe(ENTRYPOINT_V07);
  });

  it('parses gas estimates into bigints', async () => {
    const { transport } = fakeTransport(() => ({
      callGasLimit: '0x100',
      verificationGasLimit: '0x200',
      preVerificationGas: '0x300',
    }));
    const bundler = new BundlerClient(transport, ENTRYPOINT_V07);
    const estimate = await bundler.estimateUserOperationGas(op);
    expect(estimate).toEqual({
      callGasLimit: 256n,
      verificationGasLimit: 512n,
      preVerificationGas: 768n,
    });
  });
});

describe('PaymasterClient (ERC-7677)', () => {
  it('passes chain id and opaque context through and decodes the result', async () => {
    const { transport, calls } = fakeTransport(() => ({
      paymaster: '0x3333333333333333333333333333333333333333',
      paymasterData: '0xdeadbeef',
      paymasterPostOpGasLimit: '0x10',
    }));
    const paymaster = new PaymasterClient(transport, ENTRYPOINT_V07);
    const result = await paymaster.getPaymasterData(op, 8453n, { policyId: 'sponsor-1' });
    expect(calls[0]!.method).toBe('pm_getPaymasterData');
    expect(calls[0]!.params[2]).toBe('0x2105');
    expect(calls[0]!.params[3]).toEqual({ policyId: 'sponsor-1' });
    expect(result.paymaster).toBe('0x3333333333333333333333333333333333333333');
    expect([...result.paymasterData]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(result.paymasterPostOpGasLimit).toBe(16n);
  });

  it('throws when the service returns no paymaster data', async () => {
    const { transport } = fakeTransport(() => ({}));
    const paymaster = new PaymasterClient(transport, ENTRYPOINT_V07);
    await expect(paymaster.getPaymasterStubData(op, 1n)).rejects.toThrow(
      /returned no paymaster data/,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { AbiCoder, concat } from 'ethers';
import { decodeRevertReason, simulateCall } from '../src/simulate.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const coder = AbiCoder.defaultAbiCoder();

/** Builds an Error(string) revert payload the way Solidity does. */
function errorString(message: string): string {
  return concat(['0x08c379a0', coder.encode(['string'], [message])]);
}

function panic(code: number): string {
  return concat(['0x4e487b71', coder.encode(['uint256'], [code])]);
}

describe('decodeRevertReason', () => {
  it('decodes Error(string) payloads built by ethers', () => {
    expect(decodeRevertReason(errorString('ERC20: transfer amount exceeds balance'))).toBe(
      'reverted: ERC20: transfer amount exceeds balance',
    );
  });

  it('decodes Panic codes', () => {
    expect(decodeRevertReason(panic(0x12))).toBe('panic: division by zero');
    expect(decodeRevertReason(panic(0x99))).toBe('panic: code 0x99');
  });

  it('labels bare and custom-error reverts', () => {
    expect(decodeRevertReason('0x')).toBe('reverted without a reason');
    expect(decodeRevertReason('0xdeadbeef00')).toMatch(/custom error data 0xdeadbeef/);
  });
});

describe('simulateCall', () => {
  const request = {
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: 1n,
    data: new Uint8Array([0xaa, 0xbb]),
  };

  it('returns ok with the return data when the call succeeds', async () => {
    const transport: JsonRpcTransport = async (method, params) => {
      expect(method).toBe('eth_call');
      const call = (params as [Record<string, string>, string])[0];
      expect(call.data).toBe('0xaabb');
      expect(call.value).toBe('0x1');
      return '0x1234';
    };
    expect(await simulateCall(transport, request)).toEqual({ ok: true, returnData: '0x1234' });
  });

  it('decodes a revert carried on the thrown error', async () => {
    const transport: JsonRpcTransport = async () => {
      const error = new Error('execution reverted') as Error & { data: string };
      error.data = errorString('insufficient balance');
      throw error;
    };
    const result = await simulateCall(transport, request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('reverted: insufficient balance');
  });

  it('falls back to the error message when no revert data exists', async () => {
    const transport: JsonRpcTransport = async () => {
      throw new Error('RPC error -32000: nonce too low (eth_call)');
    };
    const result = await simulateCall(transport, request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/nonce too low/);
  });
});

import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import { SolanaRpcClient, type JsonRpcTransport, type SignatureStatus } from '../src/rpc.js';

/**
 * RPC client tests with fake transports, mirroring the pattern in
 * chains-evm/test/rpc.test.ts: record every call and assert the exact
 * method names and parameter shapes from the solana.com/docs/rpc reference.
 */

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

const noSleep = async (): Promise<void> => {};

describe('getLatestBlockhash', () => {
  it('unwraps the nested value and passes commitment config', async () => {
    const { transport, calls } = fakeTransport(() => ({
      context: { slot: 100 },
      value: { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 3090 },
    }));
    const client = new SolanaRpcClient(transport);
    const result = await client.getLatestBlockhash('confirmed');
    expect(calls[0]!.method).toBe('getLatestBlockhash');
    expect(calls[0]!.params).toEqual([{ commitment: 'confirmed' }]);
    expect(result.blockhash).toBe('EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N');
    expect(result.lastValidBlockHeight).toBe(3090n);
  });

  it('sends no config when no commitment is given', async () => {
    const { transport, calls } = fakeTransport(() => ({
      value: { blockhash: 'x', lastValidBlockHeight: 1 },
    }));
    await new SolanaRpcClient(transport).getLatestBlockhash();
    expect(calls[0]!.params).toEqual([]);
  });
});

describe('getBalance', () => {
  it('sends the base58 pubkey and returns lamports as bigint', async () => {
    const { transport, calls } = fakeTransport(() => ({
      context: { slot: 1 },
      value: 2_500_000_000,
    }));
    const client = new SolanaRpcClient(transport);
    const balance = await client.getBalance('83astBRguLMdt2h5U1Tpdq5tjFoJ6noeGwaY3mDLVcri');
    expect(calls[0]!.method).toBe('getBalance');
    expect(calls[0]!.params).toEqual(['83astBRguLMdt2h5U1Tpdq5tjFoJ6noeGwaY3mDLVcri']);
    expect(balance).toBe(2_500_000_000n);
  });
});

describe('sendTransaction', () => {
  it('base64-encodes the wire bytes and passes { encoding: "base64" }', async () => {
    const { transport, calls } = fakeTransport(() => '5SignatureBase58');
    const client = new SolanaRpcClient(transport);
    const wire = Uint8Array.from([1, 2, 3, 4]);
    const signature = await client.sendTransaction(wire, { skipPreflight: true });
    expect(signature).toBe('5SignatureBase58');
    expect(calls[0]!.method).toBe('sendTransaction');
    expect(calls[0]!.params[0]).toBe(base64.encode(wire));
    expect(calls[0]!.params[1]).toEqual({ encoding: 'base64', skipPreflight: true });
  });
});

describe('getSignatureStatuses', () => {
  it('wraps signatures in an array param and unwraps value', async () => {
    const status: SignatureStatus = {
      slot: 5,
      confirmations: 3,
      err: null,
      confirmationStatus: 'confirmed',
    };
    const { transport, calls } = fakeTransport(() => ({ value: [status] }));
    const client = new SolanaRpcClient(transport);
    const result = await client.getSignatureStatuses(['sig1']);
    expect(calls[0]!.method).toBe('getSignatureStatuses');
    expect(calls[0]!.params).toEqual([['sig1']]);
    expect(result).toEqual([status]);
  });

  it('passes searchTransactionHistory when asked', async () => {
    const { transport, calls } = fakeTransport(() => ({ value: [null] }));
    await new SolanaRpcClient(transport).getSignatureStatuses(['sig1'], true);
    expect(calls[0]!.params).toEqual([['sig1'], { searchTransactionHistory: true }]);
  });
});

describe('confirmTransaction', () => {
  it('polls until the requested commitment is reached', async () => {
    // First poll: unknown. Second: processed. Third: confirmed.
    const responses: Array<SignatureStatus | null> = [
      null,
      { slot: 5, confirmations: 0, err: null, confirmationStatus: 'processed' },
      { slot: 5, confirmations: 4, err: null, confirmationStatus: 'confirmed' },
    ];
    let call = 0;
    const { transport, calls } = fakeTransport(() => ({ value: [responses[call++] ?? null] }));
    const client = new SolanaRpcClient(transport);
    const status = await client.confirmTransaction('sig1', {
      commitment: 'confirmed',
      pollIntervalMs: 0,
      sleep: noSleep,
    });
    expect(calls.length).toBe(3);
    expect(status.confirmationStatus).toBe('confirmed');
  });

  it('treats null confirmations as finalized', async () => {
    const { transport } = fakeTransport(() => ({
      value: [{ slot: 5, confirmations: null, err: null, confirmationStatus: 'finalized' }],
    }));
    const status = await new SolanaRpcClient(transport).confirmTransaction('sig1', {
      commitment: 'finalized',
      sleep: noSleep,
    });
    expect(status.confirmations).toBeNull();
  });

  it('throws when the transaction failed on-chain', async () => {
    const { transport } = fakeTransport(() => ({
      value: [
        {
          slot: 5,
          confirmations: 1,
          err: { InstructionError: [0, 'Custom'] },
          confirmationStatus: 'confirmed',
        },
      ],
    }));
    await expect(
      new SolanaRpcClient(transport).confirmTransaction('sig1', { sleep: noSleep }),
    ).rejects.toThrow(/failed/);
  });

  it('times out when the signature never lands', async () => {
    const { transport } = fakeTransport(() => ({ value: [null] }));
    await expect(
      new SolanaRpcClient(transport).confirmTransaction('sig1', {
        timeoutMs: 0,
        pollIntervalMs: 0,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

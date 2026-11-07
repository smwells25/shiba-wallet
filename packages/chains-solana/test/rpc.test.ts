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

describe('getTokenBalances', () => {
  it('queries jsonParsed token accounts and parses string amounts', async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const client = new SolanaRpcClient(async (method, params) => {
      calls.push({ method, params: params as unknown[] });
      return {
        value: [
          {
            account: {
              data: {
                parsed: {
                  info: {
                    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                    tokenAmount: { amount: '123456789012345678901', decimals: 6 },
                  },
                },
              },
            },
          },
        ],
      };
    });
    const balances = await client.getTokenBalances(
      'ownerPubkey',
      { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      'confirmed',
    );
    expect(balances).toEqual([
      {
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        amount: 123456789012345678901n, // exceeds double precision: string parse matters
        decimals: 6,
      },
    ]);
    expect(calls[0]!.method).toBe('getTokenAccountsByOwner');
    expect(calls[0]!.params[1]).toEqual({ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
    expect((calls[0]!.params[2] as { encoding: string }).encoding).toBe('jsonParsed');
  });
});

describe('token-layer RPC methods', () => {
  it('getAccountInfoBase64 asks for base64, decodes bytes and returns null for a missing account', async () => {
    const { transport, calls } = fakeTransport((_m, params) =>
      params[0] === 'missing'
        ? { context: { slot: 1 }, value: null }
        : { context: { slot: 1 }, value: { data: [base64.encode(Uint8Array.of(1, 2, 3)), 'base64'], executable: false, lamports: 7, owner: 'Own' } },
    );
    const client = new SolanaRpcClient(transport);
    const found = await client.getAccountInfoBase64('Addr', 'confirmed');
    expect(calls[0]).toEqual({ method: 'getAccountInfo', params: ['Addr', { encoding: 'base64', commitment: 'confirmed' }] });
    expect(found).toEqual({ address: 'Addr', owner: 'Own', lamports: 7n, executable: false, data: Uint8Array.of(1, 2, 3) });
    expect(await client.getAccountInfoBase64('missing')).toBeNull();
  });

  it('getAccountInfoBase64 refuses an answer in another encoding', async () => {
    const { transport } = fakeTransport(() => ({ context: { slot: 1 }, value: { data: { parsed: {} }, executable: false, lamports: 1, owner: 'x' } }));
    await expect(new SolanaRpcClient(transport).getAccountInfoBase64('A')).rejects.toThrow('not returned in base64');
  });

  it('getTokenAccountsByOwnerBase64 filters by program id', async () => {
    const { transport, calls } = fakeTransport(() => ({
      context: { slot: 1 },
      value: [{ pubkey: 'Acc', account: { data: [base64.encode(Uint8Array.of(9)), 'base64'], executable: false, lamports: 2, owner: 'Prog' } }],
    }));
    const listed = await new SolanaRpcClient(transport).getTokenAccountsByOwnerBase64('Owner', 'Prog');
    expect(calls[0]).toEqual({ method: 'getTokenAccountsByOwner', params: ['Owner', { programId: 'Prog' }, { encoding: 'base64' }] });
    expect(listed[0]!.address).toBe('Acc');
  });

  it('getEpoch and getMinimumBalanceForRentExemption pass and check their values', async () => {
    const { transport, calls } = fakeTransport((m) => (m === 'getEpochInfo' ? { epoch: 1203, absoluteSlot: 5 } : 2039280));
    const client = new SolanaRpcClient(transport);
    expect(await client.getEpoch()).toBe(1203n);
    expect(await client.getMinimumBalanceForRentExemption(165)).toBe(2039280n);
    expect(calls[1]).toEqual({ method: 'getMinimumBalanceForRentExemption', params: [165] });
    const bad = new SolanaRpcClient(fakeTransport(() => ({ epoch: -1 })).transport);
    await expect(bad.getEpoch()).rejects.toThrow('valid epoch');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ENTRYPOINT_V07, type UserOperation } from '../src/userop.js';
import {
  BROADCAST_METHODS,
  BROADCAST_TIMEOUT_MS,
  BroadcastTimeoutError,
  BroadcastUnansweredError,
  BundlerClient,
  NodeClient,
  httpTransport,
  isBroadcastTimeoutError,
  isBroadcastUnansweredError,
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

describe('NodeClient', () => {
  const responses: Record<string, unknown> = {
    eth_getBalance: '0xde0b6b3a7640000',
    eth_getTransactionCount: '0x5',
    eth_chainId: '0x2105',
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
    eth_maxPriorityFeePerGas: '0x5f5e100',
    eth_estimateGas: '0x5208',
    eth_sendRawTransaction: '0xtxhash',
  };
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const node = new NodeClient(async (method, params) => {
    calls.push({ method, params });
    if (method in responses) return responses[method];
    throw new Error(`unexpected ${method}`);
  });

  it('parses balances, nonces, and chain id as bigints', async () => {
    expect(await node.getBalance('0xabc')).toBe(1_000_000_000_000_000_000n);
    expect(await node.getTransactionCount('0xabc')).toBe(5n);
    expect(await node.chainId()).toBe(8453n);
    expect(calls.find((c) => c.method === 'eth_getTransactionCount')!.params[1]).toBe(
      'pending',
    );
  });

  it('suggests fees as 2x base fee plus priority', async () => {
    const fees = await node.suggestFees();
    expect(fees.maxPriorityFeePerGas).toBe(100_000_000n);
    expect(fees.maxFeePerGas).toBe(2_000_000_000n + 100_000_000n);
  });

  it('estimates gas and broadcasts raw transactions', async () => {
    expect(await node.estimateGas({ from: '0xabc', to: '0xdef', value: 1n })).toBe(21_000n);
    expect(await node.sendRawTransaction('0x02f8...')).toBe('0xtxhash');
  });
});


describe('httpTransport: only broadcasts are bounded in time (phase 23 item 8)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch that never answers; records each request's method and whether it carried a signal. */
  function silentFetch() {
    const requests: Array<{ method: string; signal: AbortSignal | undefined; aborted: () => boolean }> = [];
    const fetchFn = ((_url: string, init: RequestInit) => {
      const { method } = JSON.parse(String(init.body)) as { method: string };
      const signal = init.signal ?? undefined;
      requests.push({ method, signal, aborted: () => signal?.aborted === true });
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    return { fetchFn, requests };
  }

  async function settledWithin(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
    let state: 'pending' | 'resolved' | 'rejected' = 'pending';
    promise.then(
      () => (state = 'resolved'),
      () => (state = 'rejected'),
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return state;
  }

  it('names the two broadcast methods and 60 seconds', () => {
    expect([...BROADCAST_METHODS]).toEqual(['eth_sendRawTransaction', 'eth_sendUserOperation']);
    expect(BROADCAST_TIMEOUT_MS).toBe(60_000);
  });

  for (const method of ['eth_sendRawTransaction', 'eth_sendUserOperation']) {
    it(`${method}: rejects with BroadcastTimeoutError at 60 s and aborts the request`, async () => {
      vi.useFakeTimers();
      const { fetchFn, requests } = silentFetch();
      const call = httpTransport('https://node.example', fetchFn)(method, ['0x00']);
      const caught = call.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(BROADCAST_TIMEOUT_MS - 1);
      expect(await settledWithin(call)).toBe('pending');
      expect(requests[0]!.aborted()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await caught;
      expect(error).toBeInstanceOf(BroadcastTimeoutError);
      expect(isBroadcastTimeoutError(error)).toBe(true);
      expect((error as BroadcastTimeoutError).method).toBe(method);
      // Never worded as a failure the endpoint classifier would retry elsewhere.
      expect((error as Error).message).not.toMatch(/timed out|timeout|aborted|not sent|nothing was sent/i);
      expect(requests[0]!.signal).toBeDefined();
      expect(requests[0]!.aborted()).toBe(true);
    });
  }

  it('reads carry no signal and no timer: still waiting after ten minutes', async () => {
    vi.useFakeTimers();
    const { fetchFn, requests } = silentFetch();
    const transport = httpTransport('https://node.example', fetchFn);
    const reads = ['eth_call', 'eth_getTransactionReceipt', 'eth_estimateUserOperationGas', 'eth_chainId'].map((m) =>
      transport(m, []),
    );
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    for (const r of reads) expect(await settledWithin(r)).toBe('pending');
    expect(requests.every((r) => r.signal === undefined)).toBe(true);
  });

  it('an answer before the limit passes through and clears the timer', async () => {
    vi.useFakeTimers();
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const { id } = JSON.parse(String(init.body)) as { id: number };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result: '0xabc' }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await httpTransport('https://node.example', fetchFn)('eth_sendRawTransaction', ['0x00']);
    expect(result).toBe('0xabc');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a node refusal before the limit is the node error, not a timeout', async () => {
    vi.useFakeTimers();
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const { id } = JSON.parse(String(init.body)) as { id: number };
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'transaction underpriced' } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const error = await httpTransport('https://node.example', fetchFn)('eth_sendRawTransaction', ['0x00']).catch((e) => e);
    expect(isBroadcastTimeoutError(error)).toBe(false);
    expect((error as Error).message).toBe('RPC error -32000: transaction underpriced (eth_sendRawTransaction)');
  });

  it('a shorter limit can be set per transport', async () => {
    vi.useFakeTimers();
    const { fetchFn } = silentFetch();
    const call = httpTransport('https://node.example', fetchFn, { broadcastTimeoutMs: 5_000 })('eth_sendUserOperation', []);
    const caught = call.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(isBroadcastTimeoutError(await caught)).toBe(true);
  });
});

describe('httpTransport: a broadcast whose answer never arrives intact is an open outcome', () => {
  /** A fetch answering every request with `answer` (a Response-like object, or a rejection). */
  function fetchAnswering(answer: () => Promise<unknown>) {
    const methods: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      methods.push((JSON.parse(String(init.body)) as { method: string }).method);
      return answer();
    }) as unknown as typeof fetch;
    return { fetchFn, methods };
  }
  const status = (code: number) => async () =>
    ({ ok: code >= 200 && code < 300, status: code, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'upstream' } }) });

  for (const method of ['eth_sendRawTransaction', 'eth_sendUserOperation']) {
    for (const code of [500, 502, 503, 504, 599]) {
      it(`${method}: HTTP ${code} is BroadcastUnansweredError (server-error), not a refusal`, async () => {
        const { fetchFn } = fetchAnswering(status(code));
        const error = await httpTransport('https://node.example', fetchFn)(method, ['0x00']).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BroadcastUnansweredError);
        expect(isBroadcastUnansweredError(error)).toBe(true);
        expect(isBroadcastTimeoutError(error)).toBe(false);
        const e = error as BroadcastUnansweredError;
        expect(e.reason).toBe('server-error');
        expect(e.status).toBe(code);
        expect(e.method).toBe(method);
        expect(e.causeText).toBe(`RPC HTTP error ${code} for ${method}`);
        expect(e.message).toBe(
          `No usable answer to ${method} (the endpoint answered with a server error; cause: RPC HTTP error ${code} for ${method}), so whether it was accepted is unknown.`,
        );
        expect(e.message).not.toMatch(/^fetch failed|not sent|nothing was sent/i);
      });
    }
    it(`${method}: a rejected fetch (a dropped connection) is BroadcastUnansweredError (connection) with the raw cause`, async () => {
      const dropped = Object.assign(new Error('fetch failed: java.net.SocketException: Connection reset'), { name: 'FetchError' });
      const { fetchFn } = fetchAnswering(async () => {
        throw dropped;
      });
      const e = (await httpTransport('https://node.example', fetchFn)(method, ['0x00']).catch((x: unknown) => x)) as BroadcastUnansweredError;
      expect(isBroadcastUnansweredError(e)).toBe(true);
      expect(e.reason).toBe('connection');
      expect(e.status).toBeNull();
      expect(e.causeText).toBe('FetchError: fetch failed: java.net.SocketException: Connection reset');
      expect(e.message).toBe(
        `No usable answer to ${method} (the connection failed; cause: FetchError: fetch failed: java.net.SocketException: Connection reset), so whether it was accepted is unknown.`,
      );
      expect(/^fetch failed/.test(e.message)).toBe(false);
    });
    it(`${method}: an answer that is not JSON is BroadcastUnansweredError (connection)`, async () => {
      const { fetchFn } = fetchAnswering(async () => ({ ok: true, status: 200, json: async () => JSON.parse('<html>') }));
      const e = (await httpTransport('https://node.example', fetchFn)(method, ['0x00']).catch((x: unknown) => x)) as BroadcastUnansweredError;
      expect(isBroadcastUnansweredError(e)).toBe(true);
      expect(e.reason).toBe('connection');
      expect(e.causeText.startsWith('the answer could not be read: SyntaxError')).toBe(true);
    });
    it(`${method}: an HTTP 4xx and a parsed JSON-RPC error stay definite refusals, worded as before`, async () => {
      for (const code of [400, 403, 429]) {
        const { fetchFn } = fetchAnswering(status(code));
        const e = await httpTransport('https://node.example', fetchFn)(method, ['0x00']).catch((x: unknown) => x);
        expect(isBroadcastUnansweredError(e)).toBe(false);
        expect((e as Error).message).toBe(`RPC HTTP error ${code} for ${method}`);
      }
      const { fetchFn } = fetchAnswering(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nonce too low' } }),
      }));
      const e = await httpTransport('https://node.example', fetchFn)(method, ['0x00']).catch((x: unknown) => x);
      expect(isBroadcastUnansweredError(e)).toBe(false);
      expect((e as Error).message).toBe(`RPC error -32000: nonce too low (${method})`);
    });
  }

  it('every other method keeps its old errors: a 502 and a dropped connection are thrown unchanged', async () => {
    const dropped = new TypeError('fetch failed');
    for (const method of ['eth_call', 'eth_getTransactionReceipt', 'eth_estimateUserOperationGas', 'eth_chainId']) {
      const { fetchFn } = fetchAnswering(status(502));
      const e = await httpTransport('https://node.example', fetchFn)(method, []).catch((x: unknown) => x);
      expect(isBroadcastUnansweredError(e)).toBe(false);
      expect((e as Error).message).toBe(`RPC HTTP error 502 for ${method}`);
      const drop = fetchAnswering(async () => {
        throw dropped;
      });
      expect(await httpTransport('https://node.example', drop.fetchFn)(method, []).catch((x: unknown) => x)).toBe(dropped);
      const html = fetchAnswering(async () => ({ ok: true, status: 200, json: async () => JSON.parse('<html>') }));
      const syntax = await httpTransport('https://node.example', html.fetchFn)(method, []).catch((x: unknown) => x);
      expect(syntax).toBeInstanceOf(SyntaxError);
    }
  });
});

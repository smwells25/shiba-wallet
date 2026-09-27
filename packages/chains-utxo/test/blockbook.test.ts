import { describe, expect, it } from 'vitest';
import { blockbookTransport } from '../src/blockbook.js';

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return { ok: status === 200, status, json: async () => body } as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('blockbookTransport', () => {
  const base = 'https://doge.example/';

  it('parses string UTXO values into bigints and passes headers', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      status: 200,
      body: [
        { txid: 'a'.repeat(64), vout: 0, value: '1422303206539', confirmations: 0 },
        { txid: 'b'.repeat(64), vout: 1, value: '39748685', height: 2648043, confirmations: 47 },
      ],
    }));
    const transport = blockbookTransport(base, {
      fetchFn,
      headers: { 'api-key': 'k' },
    });
    const utxos = await transport.getUtxos('DAddr');
    expect(utxos).toEqual([
      { txid: 'a'.repeat(64), vout: 0, value: 1_422_303_206_539n },
      { txid: 'b'.repeat(64), vout: 1, value: 39_748_685n },
    ]);
    expect(calls[0]!.url).toBe('https://doge.example/api/v2/utxo/DAddr');
    expect((calls[0]!.init!.headers as Record<string, string>)['api-key']).toBe('k');
  });

  it('POSTs raw hex to sendtx and returns the result txid', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      status: 200,
      body: { result: '7c3be24063f268aa' },
    }));
    const transport = blockbookTransport(base, { fetchFn });
    const txid = await transport.broadcastTx('0200deadbeef');
    expect(txid).toBe('7c3be24063f268aa');
    expect(calls[0]!.url).toBe('https://doge.example/api/v2/sendtx/');
    expect(calls[0]!.init!.method).toBe('POST');
    expect(calls[0]!.init!.body).toBe('0200deadbeef');
  });

  it('surfaces Blockbook error messages on rejection', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 400,
      body: { error: { message: 'txn-mempool-conflict' } },
    }));
    const transport = blockbookTransport(base, { fetchFn });
    await expect(transport.broadcastTx('00')).rejects.toThrow(/txn-mempool-conflict/);
    const missing = blockbookTransport(base, {
      fetchFn: fakeFetch(() => ({ status: 200, body: {} })).fetchFn,
    });
    await expect(missing.broadcastTx('00')).rejects.toThrow(/Blockbook broadcast rejected/);
  });
});

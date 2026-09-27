import { describe, expect, it } from 'vitest';
import { esploraHistoryProvider } from '../src/history.js';

const ME = 'tb1qme';
const OTHER = 'tb1qother';

function tx(overrides: Record<string, unknown>) {
  return {
    txid: 'tx',
    fee: 200,
    status: { confirmed: true, block_height: 100, block_time: 1700000000 },
    vin: [],
    vout: [],
    ...overrides,
  };
}

function fakeFetch(pages: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    const body = pages[url];
    if (!body) return { ok: false, status: 404 } as Response;
    return { ok: true, json: async () => body } as Response;
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('esploraHistoryProvider', () => {
  const base = 'https://esplora.test/api';

  it('classifies incoming, outgoing, and self transactions', async () => {
    const incoming = tx({
      txid: 'in1',
      vin: [{ prevout: { scriptpubkey_address: OTHER, value: 5000 } }],
      vout: [{ scriptpubkey_address: ME, value: 4800 }],
    });
    const outgoing = tx({
      txid: 'out1',
      vin: [{ prevout: { scriptpubkey_address: ME, value: 10000 } }],
      vout: [
        { scriptpubkey_address: OTHER, value: 7000 },
        { scriptpubkey_address: ME, value: 2800 }, // change
      ],
    });
    const selfSend = tx({
      txid: 'self1',
      vin: [{ prevout: { scriptpubkey_address: ME, value: 3000 } }],
      vout: [{ scriptpubkey_address: ME, value: 2800 }],
    });
    const { fetchFn } = fakeFetch({
      [`${base}/address/${ME}/txs`]: [incoming, outgoing, selfSend],
    });

    const page = await esploraHistoryProvider(base, fetchFn).getHistory(ME);
    expect(page.entries).toEqual([
      {
        id: 'in1',
        timestamp: 1700000000,
        confirmed: true,
        blockHeight: 100,
        direction: 'in',
        amount: 4800n,
      },
      {
        id: 'out1',
        timestamp: 1700000000,
        confirmed: true,
        blockHeight: 100,
        direction: 'out',
        amount: 7000n, // excludes the 200 sat fee
        fee: 200n,
      },
      {
        id: 'self1',
        timestamp: 1700000000,
        confirmed: true,
        blockHeight: 100,
        direction: 'self',
        amount: 0n,
        fee: 200n,
      },
    ]);
    expect(page.nextCursor).toBeUndefined(); // short page: history exhausted
  });

  it('treats unconfirmed transactions and paginates by last confirmed txid', async () => {
    const mempoolTx = tx({
      txid: 'mem1',
      status: { confirmed: false },
      vin: [{ prevout: { scriptpubkey_address: OTHER, value: 900 } }],
      vout: [{ scriptpubkey_address: ME, value: 800 }],
    });
    // A full page (25 entries) signals more history behind it.
    const confirmed = Array.from({ length: 24 }, (_, i) =>
      tx({
        txid: `c${i}`,
        vin: [{ prevout: { scriptpubkey_address: OTHER, value: 600 } }],
        vout: [{ scriptpubkey_address: ME, value: 500 }],
      }),
    );
    const { fetchFn, calls } = fakeFetch({
      [`${base}/address/${ME}/txs`]: [mempoolTx, ...confirmed],
      [`${base}/address/${ME}/txs/chain/c23`]: [],
    });
    const provider = esploraHistoryProvider(base, fetchFn);

    const first = await provider.getHistory(ME);
    expect(first.entries[0]).toMatchObject({ id: 'mem1', confirmed: false, timestamp: null });
    expect(first.nextCursor).toBe('c23');

    const second = await provider.getHistory(ME, first.nextCursor);
    expect(second.entries).toEqual([]);
    expect(second.nextCursor).toBeUndefined();
    expect(calls[1]).toBe(`${base}/address/${ME}/txs/chain/c23`);
  });
});

import { describe, expect, it } from 'vitest';
import { blockbookHistoryProvider } from '../src/blockbook-history.js';

const ME = 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC';
const OTHER = 'D8jY1JJ5V8xX8QqQqQqQqQqQqQqQqQqQqQ';

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

const base = 'https://doge.example';
const url = (page: number) =>
  `${base}/api/v2/address/${ME}?details=txs&page=${page}&pageSize=25`;

describe('blockbookHistoryProvider', () => {
  it('classifies directions from string values and paginates by page number', async () => {
    const incoming = {
      txid: 'in1',
      vin: [{ addresses: [OTHER], isAddress: true, value: '500000000' }],
      vout: [{ addresses: [ME], isAddress: true, value: '450000000' }],
      fees: '50000000',
      blockTime: 1_700_000_000,
      blockHeight: 5_500_000,
      confirmations: 12,
    };
    const outgoing = {
      txid: 'out1',
      vin: [{ addresses: [ME], isAddress: true, value: '1000000000' }],
      vout: [
        { addresses: [OTHER], isAddress: true, value: '700000000' },
        { addresses: [ME], isAddress: true, value: '250000000' },
      ],
      fees: '50000000',
      blockTime: 1_700_000_100,
      blockHeight: 5_500_001,
      confirmations: 11,
    };
    const mempoolSelf = {
      txid: 'self1',
      vin: [{ addresses: [ME], isAddress: true, value: '300000000' }],
      vout: [{ addresses: [ME], isAddress: true, value: '250000000' }],
      fees: '50000000',
      confirmations: 0,
      blockHeight: -1,
    };
    const { fetchFn, calls } = fakeFetch({
      [url(1)]: { page: 1, totalPages: 2, transactions: [mempoolSelf, outgoing, incoming] },
      [url(2)]: { page: 2, totalPages: 2, transactions: [] },
    });

    const provider = blockbookHistoryProvider(base, { fetchFn });
    const first = await provider.getHistory(ME);
    expect(first.entries).toEqual([
      {
        id: 'self1',
        timestamp: null,
        confirmed: false,
        direction: 'self',
        amount: 0n,
        fee: 50_000_000n,
      },
      {
        id: 'out1',
        timestamp: 1_700_000_100,
        confirmed: true,
        blockHeight: 5_500_001,
        direction: 'out',
        amount: 700_000_000n, // excludes the fee
        fee: 50_000_000n,
      },
      {
        id: 'in1',
        timestamp: 1_700_000_000,
        confirmed: true,
        blockHeight: 5_500_000,
        direction: 'in',
        amount: 450_000_000n,
      },
    ]);
    expect(first.nextCursor).toBe('2');

    const second = await provider.getHistory(ME, first.nextCursor);
    expect(second.entries).toEqual([]);
    expect(second.nextCursor).toBeUndefined();
    expect(calls).toEqual([url(1), url(2)]);
  });

  it('ignores non-address ios (coinbase, op_return) and rejects bad cursors', async () => {
    const coinbaseIn = {
      txid: 'cb1',
      vin: [{ isAddress: false }],
      vout: [
        { addresses: [ME], isAddress: true, value: '1000000' },
        { addresses: ['OP_RETURN dummy'], isAddress: false, value: '0' },
      ],
      confirmations: 100,
      blockTime: 1_690_000_000,
      blockHeight: 5_000_000,
    };
    const { fetchFn } = fakeFetch({
      [url(1)]: { page: 1, totalPages: 1, transactions: [coinbaseIn] },
    });
    const provider = blockbookHistoryProvider(base, { fetchFn });
    const page = await provider.getHistory(ME);
    expect(page.entries[0]).toMatchObject({ direction: 'in', amount: 1_000_000n });
    await expect(provider.getHistory(ME, 'zero')).rejects.toThrow(/Invalid Blockbook/);
    await expect(provider.getHistory(ME, '0')).rejects.toThrow(/Invalid Blockbook/);
  });
});

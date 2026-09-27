import { describe, expect, it } from 'vitest';
import { isValidSolanaAddress, solanaHistoryProvider } from '../src/history.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const ME = '6TgSKzjg3SQSeqrDR95D7RNncYh63FPzRcDWX6T4455t';
const OTHER = '11111111111111111111111111111111';

function sig(signature: string, overrides: Record<string, unknown> = {}) {
  return {
    signature,
    slot: 1,
    err: null,
    memo: null,
    blockTime: 1700000100,
    confirmationStatus: 'finalized',
    ...overrides,
  };
}

describe('solanaHistoryProvider', () => {
  it('enriches entries with direction, amount, and fee-payer fee', async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const transport: JsonRpcTransport = async (method, params) => {
      calls.push({ method, params: params as unknown[] });
      if (method === 'getSignaturesForAddress') return [sig('sent'), sig('received')];
      if (method === 'getTransaction') {
        const signature = (params as unknown[])[0];
        if (signature === 'sent') {
          // ME is fee payer (index 0): paid 5000 fee and sent 1000 lamports.
          return {
            meta: { fee: 5000, preBalances: [100_000, 50_000], postBalances: [94_000, 51_000] },
            transaction: { message: { accountKeys: [ME, OTHER] } },
          };
        }
        // ME received 7000; OTHER paid the fee.
        return {
          meta: { fee: 5000, preBalances: [90_000, 10_000], postBalances: [83_000, 17_000] },
          transaction: { message: { accountKeys: [OTHER, ME] } },
        };
      }
      throw new Error(`unexpected ${method}`);
    };

    const page = await solanaHistoryProvider(transport).getHistory(ME);
    expect(page.entries[0]).toEqual({
      id: 'sent',
      timestamp: 1700000100,
      confirmed: true,
      direction: 'out',
      amount: 1000n, // 100000 -> 94000 is -6000; +5000 fee separated = -1000
      fee: 5000n,
    });
    expect(page.entries[1]).toEqual({
      id: 'received',
      timestamp: 1700000100,
      confirmed: true,
      direction: 'in',
      amount: 7000n,
    });
    expect(page.nextCursor).toBeUndefined(); // short page
    expect(calls.filter((c) => c.method === 'getTransaction').length).toBe(2);
  });

  it('marks failed transactions, respects enrichLimit, and pages with before', async () => {
    const infos = Array.from({ length: 3 }, (_, i) =>
      sig(`s${i}`, i === 0 ? { err: { InstructionError: [0, 'Custom'] } } : {}),
    );
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const transport: JsonRpcTransport = async (method, params) => {
      calls.push({ method, params: params as unknown[] });
      if (method === 'getSignaturesForAddress') return infos;
      if (method === 'getTransaction') return null; // enrichment finds nothing
      throw new Error(`unexpected ${method}`);
    };

    const provider = solanaHistoryProvider(transport, { pageSize: 3, enrichLimit: 1 });
    const page = await provider.getHistory(ME);
    expect(page.entries[0]!.failed).toBe(true);
    expect(page.entries[2]!.amount).toBeUndefined();
    // Full page implies more behind it; cursor is the oldest signature.
    expect(page.nextCursor).toBe('s2');
    expect(calls.filter((c) => c.method === 'getTransaction').length).toBe(1);

    await provider.getHistory(ME, 's2');
    const paged = calls.filter((c) => c.method === 'getSignaturesForAddress').pop()!;
    expect((paged.params[1] as { before: string }).before).toBe('s2');
  });

  it('validates addresses', () => {
    expect(isValidSolanaAddress(ME)).toBe(true);
    expect(isValidSolanaAddress('not-base58-0OIl')).toBe(false);
    expect(isValidSolanaAddress('abc')).toBe(false);
  });
});

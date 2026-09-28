import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSFER_CATEGORIES,
  indexerHistoryProvider,
  verifyTransfersEndpoint,
} from '../src/indexer-history.js';
import type { JsonRpcTransport } from '../src/rpc.js';

/**
 * All fixtures follow the response shape documented at
 * https://www.alchemy.com/docs/reference/alchemy-getassettransfers and
 * confirmed by a live probe on 2026-09-27 (uniqueId "<hash>:log:<n>" /
 * "<hash>:internal:<n>", rawContract.value as exact hex, pageKey a UUID
 * string present only while more results exist).
 */

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const OTHER = '0x1111111111111111111111111111111111111111';

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** Routes each query by its fromAddress/toAddress filter. */
function fakeTransport(
  handler: (params: Record<string, unknown>) => unknown,
): { transport: JsonRpcTransport; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    transport: async (method, params) => {
      const p = params[0] as Record<string, unknown>;
      calls.push({ method, params: p });
      if (method !== 'alchemy_getAssetTransfers') {
        throw new Error(`unexpected method ${method}`);
      }
      return handler(p);
    },
  };
}

function transfer(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    blockNum: '0x100',
    hash: '0x' + 'aa'.repeat(32),
    from: OTHER.toLowerCase(),
    to: ME.toLowerCase(),
    value: 1,
    asset: 'ETH',
    category: 'external',
    uniqueId: `0x${'aa'.repeat(32)}:external`,
    rawContract: { value: '0xde0b6b3a7640000', address: null, decimal: '0x12' },
    metadata: { blockTimestamp: '2026-09-27T19:36:23.000Z' },
    ...overrides,
  };
}

describe('indexerHistoryProvider', () => {
  it('issues one fromAddress and one toAddress query with documented params', async () => {
    const { transport, calls } = fakeTransport(() => ({ transfers: [] }));
    await indexerHistoryProvider(transport, { pageSize: 25 }).getHistory(ME);

    expect(calls).toHaveLength(2);
    const out = calls.find((c) => c.params.fromAddress === ME)!;
    const incoming = calls.find((c) => c.params.toAddress === ME)!;
    expect(out).toBeDefined();
    expect(incoming).toBeDefined();
    for (const call of [out, incoming]) {
      expect(call.params.fromBlock).toBe('0x0');
      expect(call.params.toBlock).toBe('latest');
      expect(call.params.category).toEqual(DEFAULT_TRANSFER_CATEGORIES);
      expect(call.params.withMetadata).toBe(true);
      expect(call.params.excludeZeroValue).toBe(false);
      expect(call.params.maxCount).toBe('0x19'); // 25 in hex
      expect(call.params.order).toBe('desc');
      expect('pageKey' in call.params).toBe(false);
    }
  });

  it('classifies direction and merges newest-first across both queries', async () => {
    const sent = transfer({
      hash: '0x' + '11'.repeat(32),
      uniqueId: `0x${'11'.repeat(32)}:external`,
      from: ME.toLowerCase(),
      to: OTHER.toLowerCase(),
      blockNum: '0x200',
    });
    const received = transfer({
      hash: '0x' + '22'.repeat(32),
      uniqueId: `0x${'22'.repeat(32)}:external`,
      blockNum: '0x300',
    });
    const oldReceived = transfer({
      hash: '0x' + '33'.repeat(32),
      uniqueId: `0x${'33'.repeat(32)}:external`,
      blockNum: '0x100',
    });
    const { transport } = fakeTransport((p) =>
      p.fromAddress === ME ? { transfers: [sent] } : { transfers: [received, oldReceived] },
    );
    const page = await indexerHistoryProvider(transport).getHistory(ME);

    expect(page.entries.map((e) => e.blockHeight)).toEqual([0x300, 0x200, 0x100]);
    expect(page.entries.map((e) => e.direction)).toEqual(['in', 'out', 'in']);
    expect(page.entries.every((e) => e.confirmed)).toBe(true);
    expect(page.entries[0]!.timestamp).toBe(Math.floor(Date.parse('2026-09-27T19:36:23.000Z') / 1000));
    expect(page.nextCursor).toBeUndefined();
  });

  it('deduplicates a self-transfer returned by both queries, direction self', async () => {
    const self = transfer({
      from: ME.toLowerCase(),
      to: ME.toLowerCase(),
      uniqueId: `0x${'aa'.repeat(32)}:external`,
    });
    const { transport } = fakeTransport(() => ({ transfers: [self] }));
    const page = await indexerHistoryProvider(transport).getHistory(ME);

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.direction).toBe('self');
    expect(page.entries[0]!.uid).toBe(self.uniqueId);
  });

  it('keeps two entries born from one transaction distinct by uid', async () => {
    const hash = '0x' + '44'.repeat(32);
    const erc20 = transfer({
      hash,
      category: 'erc20',
      asset: 'USDT',
      uniqueId: `${hash}:log:391`,
      rawContract: { value: '0xde0b6b3a7640000', address: OTHER, decimal: '0x12' },
    });
    const internal = transfer({
      hash,
      category: 'internal',
      uniqueId: `${hash}:internal:0`,
      rawContract: { value: '0x04', address: null, decimal: '0x12' },
    });
    const { transport } = fakeTransport((p) =>
      p.toAddress === ME ? { transfers: [erc20, internal] } : { transfers: [] },
    );
    const page = await indexerHistoryProvider(transport).getHistory(ME);

    expect(page.entries).toHaveLength(2);
    expect(page.entries.map((e) => e.id)).toEqual([hash, hash]);
    expect(new Set(page.entries.map((e) => e.uid)).size).toBe(2);
  });

  it('takes exact native amounts from rawContract.value, never the float', async () => {
    // Live probe: value 1.0 ETH arrives as rawContract.value 0xde0b6b3a7640000
    // (exactly 10^18 wei) and value 4e-18 as 0x04 (4 wei).
    const oneEth = transfer({ value: 1 });
    const fourWei = transfer({
      hash: '0x' + '55'.repeat(32),
      uniqueId: `0x${'55'.repeat(32)}:internal:0`,
      category: 'internal',
      value: 4e-18,
      rawContract: { value: '0x04', address: null, decimal: '0x12' },
      blockNum: '0xff',
    });
    const noRaw = transfer({
      hash: '0x' + '66'.repeat(32),
      uniqueId: `0x${'66'.repeat(32)}:external`,
      value: 2,
      rawContract: { value: null, address: null, decimal: '0x12' },
      blockNum: '0xfe',
    });
    const { transport } = fakeTransport((p) =>
      p.toAddress === ME ? { transfers: [oneEth, fourWei, noRaw] } : { transfers: [] },
    );
    const page = await indexerHistoryProvider(transport).getHistory(ME);

    expect(page.entries[0]!.amount).toBe(1000000000000000000n);
    expect(page.entries[1]!.amount).toBe(4n);
    // No exact value available: honestly no amount, never a float round-trip.
    expect(page.entries[2]!.amount).toBeUndefined();
  });

  it('maps token categories to amount-less entries carrying the asset symbol', async () => {
    const erc20 = transfer({
      category: 'erc20',
      asset: 'USDC',
      uniqueId: `0x${'aa'.repeat(32)}:log:1`,
      rawContract: { value: '0xf4240', address: OTHER, decimal: '0x6' },
    });
    const erc721 = transfer({
      hash: '0x' + '77'.repeat(32),
      category: 'erc721',
      asset: 'PUNK',
      uniqueId: `0x${'77'.repeat(32)}:log:2`,
      value: null,
      rawContract: { value: null, address: OTHER, decimal: null },
      blockNum: '0xf0',
    });
    const { transport } = fakeTransport((p) =>
      p.toAddress === ME ? { transfers: [erc20, erc721] } : { transfers: [] },
    );
    const page = await indexerHistoryProvider(transport).getHistory(ME);

    for (const entry of page.entries) {
      expect(entry.amount).toBeUndefined();
      expect(entry.direction).toBe('in');
      expect(entry.timestamp).not.toBeNull();
    }
    expect(page.entries[0]!.assetSymbol).toBe('USDC');
    expect(page.entries[1]!.assetSymbol).toBe('PUNK');
  });

  it('round-trips the pageKey pair through the opaque cursor', async () => {
    const first = fakeTransport((p) =>
      p.fromAddress === ME
        ? { transfers: [transfer({ from: ME.toLowerCase(), to: OTHER })], pageKey: 'out-key-uuid' }
        : { transfers: [transfer({})], pageKey: 'in-key-uuid' },
    );
    const provider = indexerHistoryProvider(first.transport);
    const page1 = await provider.getHistory(ME);
    expect(page1.nextCursor).toBeDefined();

    const second = fakeTransport((p) => {
      if (p.fromAddress === ME) {
        expect(p.pageKey).toBe('out-key-uuid');
        return { transfers: [] }; // out direction now exhausted
      }
      expect(p.pageKey).toBe('in-key-uuid');
      return { transfers: [transfer({ blockNum: '0x50' })], pageKey: 'in-key-2' };
    });
    const page2 = await indexerHistoryProvider(second.transport).getHistory(
      ME,
      page1.nextCursor,
    );
    expect(second.calls).toHaveLength(2);
    expect(page2.nextCursor).toBeDefined();

    // Page 3: only the in-direction survives in the cursor; the exhausted
    // out-direction must not be queried again (it would restart from the top).
    const third = fakeTransport((p) => {
      expect(p.toAddress).toBe(ME);
      expect(p.pageKey).toBe('in-key-2');
      return { transfers: [] };
    });
    const page3 = await indexerHistoryProvider(third.transport).getHistory(
      ME,
      page2.nextCursor,
    );
    expect(third.calls).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
  });

  it('treats an empty-string pageKey as exhausted (documented empty form)', async () => {
    const { transport } = fakeTransport(() => ({ transfers: [], pageKey: '' }));
    const page = await indexerHistoryProvider(transport).getHistory(ME);
    expect(page.nextCursor).toBeUndefined();
  });

  it('rejects an unrecognized cursor instead of silently restarting', async () => {
    const { transport } = fakeTransport(() => ({ transfers: [] }));
    await expect(
      indexerHistoryProvider(transport).getHistory(ME, 'garbage'),
    ).rejects.toThrow('Unrecognized history cursor');
  });

  it('throws when the endpoint returns no transfers array', async () => {
    const { transport } = fakeTransport(() => ({ oops: true }));
    await expect(indexerHistoryProvider(transport).getHistory(ME)).rejects.toThrow(
      'no transfers array',
    );
  });
});

describe('verifyTransfersEndpoint', () => {
  it('accepts a well-formed response and reports the sample count', async () => {
    const { transport, calls } = fakeTransport(() => ({
      transfers: [transfer({})],
      pageKey: '',
    }));
    const result = await verifyTransfersEndpoint(transport, ME);
    expect(result.sampleCount).toBe(1);
    expect(calls[0]!.params.maxCount).toBe('0x1');
    expect(calls[0]!.params.toAddress).toBe(ME);
  });

  it('rejects an endpoint without the transfers namespace', async () => {
    const transport: JsonRpcTransport = async () => {
      throw new Error('RPC error -32601: Method not found (alchemy_getAssetTransfers)');
    };
    await expect(verifyTransfersEndpoint(transport, ME)).rejects.toThrow('-32601');
  });

  it('rejects a malformed transfers payload', async () => {
    const { transport } = fakeTransport(() => ({ transfers: [{ nonsense: 1 }] }));
    await expect(verifyTransfersEndpoint(transport, ME)).rejects.toThrow('malformed');
  });
});

describe('erc20 asset amounts', () => {
  it('fills assetAmount/assetDecimals from rawContract for erc20 entries', async () => {
    const transport: JsonRpcTransport = async (_m, params) => {
      const filter = (params as [Record<string, unknown>])[0];
      if (filter.toAddress) {
        return {
          transfers: [
            {
              hash: '0xtok', blockNum: '0x10', uniqueId: '0xtok:log:1',
              category: 'erc20', from: '0x' + '22'.repeat(20),
              to: '0x9858effd232b4033e47d90003d41ec34ecaeda94',
              value: 1.5, asset: 'USDC',
              rawContract: { value: '0x16e360', decimal: '0x6' },
              metadata: { blockTimestamp: '2026-09-28T00:00:00.000Z' },
            },
          ],
        };
      }
      return { transfers: [] };
    };
    const page = await indexerHistoryProvider(transport).getHistory(
      '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
    );
    expect(page.entries[0]).toMatchObject({
      assetSymbol: 'USDC',
      assetAmount: 1_500_000n,
      assetDecimals: 6,
      direction: 'in',
    });
    expect(page.entries[0]!.amount).toBeUndefined();
  });
});

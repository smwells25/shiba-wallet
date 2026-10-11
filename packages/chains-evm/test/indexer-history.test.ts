import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EIP7708_TRANSFER_LOG_ADDRESS } from '../src/asset-diff.js';
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

  it("direction 'sent' / 'received' issue only that side's query and page it alone", async () => {
    const handler = (p: Record<string, unknown>) =>
      p.fromAddress === ME
        ? { transfers: [transfer({ from: ME.toLowerCase(), to: OTHER, blockNum: '0x90', uniqueId: 'out:1' })], pageKey: 'out-key' }
        : { transfers: [transfer({ blockNum: '0x80', uniqueId: 'in:1' })], pageKey: 'in-key' };
    const sent = fakeTransport(handler);
    const sentPage = await indexerHistoryProvider(sent.transport, { direction: 'sent' }).getHistory(ME);
    expect(sent.calls.map((c) => Object.keys(c.params).filter((k) => k.endsWith('Address')))).toEqual([['fromAddress']]);
    expect(sentPage.entries.map((e) => [e.uid, e.direction])).toEqual([['out:1', 'out']]);
    expect(JSON.parse(sentPage.nextCursor!)).toEqual({ v: 1, out: 'out-key' });

    const received = fakeTransport(handler);
    const receivedPage = await indexerHistoryProvider(received.transport, { direction: 'received' }).getHistory(ME);
    expect(received.calls.map((c) => c.params.toAddress)).toEqual([ME]);
    expect(receivedPage.entries.map((e) => [e.uid, e.direction])).toEqual([['in:1', 'in']]);
    expect(JSON.parse(receivedPage.nextCursor!)).toEqual({ v: 1, in: 'in-key' });

    // A cursor that also holds the other side's key never makes a one-sided
    // provider query that side.
    const later = fakeTransport((p) => {
      expect(p.pageKey).toBe('out-key');
      return { transfers: [] };
    });
    const both = JSON.stringify({ v: 1, out: 'out-key', in: 'in-key' });
    const done = await indexerHistoryProvider(later.transport, { direction: 'sent' }).getHistory(ME, both);
    expect(later.calls).toHaveLength(1);
    expect(later.calls[0]!.params.fromAddress).toBe(ME);
    expect(done.nextCursor).toBeUndefined();
  });

  it('reports the counterparty: the recipient of a sent entry, the sender of a received one', async () => {
    const { transport } = fakeTransport((p) =>
      p.fromAddress === ME
        ? { transfers: [transfer({ from: ME.toLowerCase(), to: OTHER.toLowerCase(), blockNum: '0x90', uniqueId: 'out:1' })] }
        : { transfers: [transfer({ blockNum: '0x80', uniqueId: 'in:1' }), transfer({ from: ME.toLowerCase(), to: ME.toLowerCase(), blockNum: '0x70', uniqueId: 'self:1' }), transfer({ to: null, blockNum: '0x60', uniqueId: 'create:1' })] },
    );
    const page = await indexerHistoryProvider(transport).getHistory(ME);
    expect(page.entries.map((e) => [e.uid, e.direction, e.counterparty])).toEqual([
      ['out:1', 'out', OTHER.toLowerCase()],
      ['in:1', 'in', OTHER.toLowerCase()],
      ['self:1', 'self', ME.toLowerCase()],
      ['create:1', 'in', OTHER.toLowerCase()],
    ]);
  });

  it("the default ('both') is unchanged: two queries per first page", async () => {
    const { transport, calls } = fakeTransport(() => ({ transfers: [] }));
    await indexerHistoryProvider(transport, { direction: 'both' }).getHistory(ME);
    await indexerHistoryProvider(transport).getHistory(ME);
    expect(calls).toHaveLength(4);
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

describe('EIP-7708 protocol logs (Glamsterdam; the indexer reports them as "erc20")', () => {
  /**
   * A REAL raw answer (test/fixtures/indexer-history/, read 2026-10-11):
   * the sent side of the Kernel account 0xD31c…D8FA for the block of the
   * staking bundle 0x65d23913…7204. Each ETH movement is listed twice: as
   * "internal" (asset "ETH", exact wei in rawContract.value) and as "erc20"
   * from 0xff…fe (value null, asset "", decimal null, the same wei in
   * rawContract.value). Before the fix the two "erc20" records became two
   * token entries with no amount and an empty symbol ("no amount" rows).
   */
  const FIXTURE = JSON.parse(
    readFileSync(new URL('./fixtures/indexer-history/sepolia-staking-bundle-sent.json', import.meta.url), 'utf8'),
  ) as { request: { fromAddress: string }; result: { transfers: Record<string, unknown>[] } };
  const KERNEL = FIXTURE.request.fromAddress;
  const HASH = '0x65d23913c0c8af86e779f529f335d9b833d223fbfe7461a876beabe92ddf7204';
  const ENTRYPOINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
  const STETH = '0x3e3fe7dbc6b4c189e7128855dd526361c49b40af';
  const raw = () => FIXTURE.result.transfers.map((t) => structuredClone(t));
  const internals = () => raw().filter((t) => t.category === 'internal');
  const logs = () => raw().filter((t) => t.category === 'erc20');

  it('the fixture is what the indexer answered: two internal transfers and their two protocol logs', () => {
    expect(raw().map((t) => [t.category, (t.rawContract as { address: string | null }).address, t.value, t.asset])).toEqual([
      ['internal', null, 0.000747174110161719, 'ETH'],
      ['internal', null, 0.0001, 'ETH'],
      ['erc20', EIP7708_TRANSFER_LOG_ADDRESS, null, ''],
      ['erc20', EIP7708_TRANSFER_LOG_ADDRESS, null, ''],
    ]);
  });

  for (const direction of ['sent', 'both'] as const) {
    it(`lists each ETH movement of the real bundle once, as native (${direction})`, async () => {
      const { transport } = fakeTransport((p) => (p.fromAddress ? { transfers: raw() } : { transfers: [] }));
      const page = await indexerHistoryProvider(transport, { direction }).getHistory(KERNEL);
      expect(page.entries.map((e) => [e.uid, e.direction, e.amount, e.assetSymbol, e.counterparty])).toEqual([
        [`${HASH}:internal:1_0_0_0`, 'out', 100_000_000_000_000n, undefined, STETH],
        [`${HASH}:internal:0_0_1`, 'out', 747_174_110_161_719n, undefined, ENTRYPOINT],
      ]);
      expect(page.entries.some((e) => e.uid?.includes(':log:'))).toBe(false);
      expect(page.omitted).toEqual({ 'eip7708-duplicate': 2 });
      expect(page.nextCursor).toBeUndefined();
    });
  }

  it('turns a protocol log without a native twin into a native entry (amount from rawContract.value)', async () => {
    // As if the native categories had missed the stETH call's value.
    const answer = [internals()[0]!, ...logs()];
    const { transport } = fakeTransport(() => ({ transfers: answer }));
    const page = await indexerHistoryProvider(transport, { direction: 'sent' }).getHistory(KERNEL);
    expect(page.entries.map((e) => [e.uid, e.direction, e.amount, e.assetSymbol, e.assetAmount, e.counterparty])).toEqual([
      [`${HASH}:log:21`, 'out', 100_000_000_000_000n, undefined, undefined, STETH],
      [`${HASH}:internal:0_0_1`, 'out', 747_174_110_161_719n, undefined, undefined, ENTRYPOINT],
    ]);
    expect(page.omitted).toEqual({ 'eip7708-duplicate': 1 });
  });

  it('drops an unmatched protocol log without a readable amount and counts it', async () => {
    const unreadable = logs().map((t) => ({ ...t, rawContract: { value: null, address: EIP7708_TRANSFER_LOG_ADDRESS, decimal: null } }));
    const { transport } = fakeTransport(() => ({ transfers: unreadable }));
    const page = await indexerHistoryProvider(transport, { direction: 'sent' }).getHistory(KERNEL);
    expect(page.entries).toEqual([]);
    expect(page.omitted).toEqual({ 'eip7708-unreadable': 2 });
  });

  it('matches one to one: a second identical movement without its own native record is kept', async () => {
    const twin = { ...logs()[0]!, uniqueId: `${HASH}:log:99` };
    const { transport } = fakeTransport(() => ({ transfers: [...raw(), twin] }));
    const page = await indexerHistoryProvider(transport, { direction: 'sent' }).getHistory(KERNEL);
    expect(page.entries.map((e) => [e.uid, e.amount])).toEqual([
      [`${HASH}:log:99`, 100_000_000_000_000n],
      [`${HASH}:internal:1_0_0_0`, 100_000_000_000_000n],
      [`${HASH}:internal:0_0_1`, 747_174_110_161_719n],
    ]);
    expect(page.omitted).toEqual({ 'eip7708-duplicate': 2 });
  });

  it('a protocol log never matches a native transfer of another transaction, sender, recipient or amount', async () => {
    const native = internals()[1]!; // Kernel → stETH, 1e14
    const variants = [
      { ...logs()[0]!, hash: '0x' + '12'.repeat(32), uniqueId: 'x:log:1' },
      { ...logs()[0]!, to: OTHER.toLowerCase(), uniqueId: 'x:log:2' },
      { ...logs()[0]!, rawContract: { value: '0x5af3107a4001', address: EIP7708_TRANSFER_LOG_ADDRESS, decimal: null }, uniqueId: 'x:log:3' },
    ];
    for (const log of variants) {
      const { transport } = fakeTransport(() => ({ transfers: [native, log] }));
      const page = await indexerHistoryProvider(transport, { direction: 'sent' }).getHistory(KERNEL);
      expect(page.entries).toHaveLength(2);
      expect(page.entries.every((e) => e.amount !== undefined && e.assetSymbol === undefined)).toBe(true);
      expect(page.omitted).toBeUndefined();
    }
  });

  it('matches across a page boundary: natives at the end of one page, their logs at the start of the next', async () => {
    const newer = { ...internals()[0]!, hash: '0x' + '34'.repeat(32), blockNum: '0xb56c80', uniqueId: 'newer:internal:0' };
    const newerLog = { ...logs()[1]!, hash: newer.hash, blockNum: '0xb56c80', uniqueId: 'newer:log:1' };
    const older = { ...internals()[0]!, hash: '0x' + '56'.repeat(32), blockNum: '0xb56c00', uniqueId: 'older:internal:0' };
    const pages: Record<string, { transfers: Record<string, unknown>[]; pageKey?: string }> = {
      first: { transfers: [newer, newerLog, ...internals()], pageKey: 'k2' },
      k2: { transfers: [...logs(), older], pageKey: 'k3' },
      k3: { transfers: [] },
    };
    const { transport } = fakeTransport((p) => pages[(p.pageKey as string | undefined) ?? 'first']);
    const provider = indexerHistoryProvider(transport, { direction: 'sent' });
    const page1 = await provider.getHistory(KERNEL);
    const page2 = await provider.getHistory(KERNEL, page1.nextCursor);
    const page3 = await provider.getHistory(KERNEL, page2.nextCursor);
    const all = [...page1.entries, ...page2.entries, ...page3.entries];
    expect(all.map((e) => e.uid)).toEqual([
      'newer:internal:0',
      `${HASH}:internal:1_0_0_0`,
      `${HASH}:internal:0_0_1`,
      'older:internal:0',
    ]);
    expect(page2.omitted).toEqual({ 'eip7708-duplicate': 2 });
    // Page 1's carry held the bundle's two natives (its oldest block);
    // page 2's holds only its own oldest block's unmatched native.
    expect(JSON.parse(page1.nextCursor!).co.map((c: { h: string; k: string }) => [c.h, c.k])).toEqual([
      [HASH, 'n'],
      [HASH, 'n'],
    ]);
    expect(JSON.parse(page2.nextCursor!).co.map((c: { h: string; b: string }) => [c.h, c.b])).toEqual([
      ['0x' + '56'.repeat(32), BigInt('0xb56c00').toString()],
    ]);
  });

  it('matches across a page boundary the other way: a log converted on one page absorbs its native on the next', async () => {
    const pages: Record<string, { transfers: Record<string, unknown>[]; pageKey?: string }> = {
      first: { transfers: [logs()[0]!], pageKey: 'k2' },
      k2: { transfers: [internals()[1]!] },
    };
    const { transport } = fakeTransport((p) => pages[(p.pageKey as string | undefined) ?? 'first']);
    const provider = indexerHistoryProvider(transport, { direction: 'sent' });
    const page1 = await provider.getHistory(KERNEL);
    const page2 = await provider.getHistory(KERNEL, page1.nextCursor);
    expect(page1.entries.map((e) => [e.uid, e.amount])).toEqual([[`${HASH}:log:21`, 100_000_000_000_000n]]);
    expect(page2.entries).toEqual([]);
    expect(page2.omitted).toEqual({ 'eip7708-duplicate': 1 });
  });

  it('an answer without protocol logs keeps its cursor and entries exactly as before', async () => {
    const usdc = transfer({
      category: 'erc20', asset: 'USDC', uniqueId: 'usdc:log:1', value: 1,
      rawContract: { value: '0xf4240', address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', decimal: '0x6' },
    });
    const { transport } = fakeTransport(() => ({ transfers: [transfer({ uniqueId: 'eth:external' }), usdc], pageKey: 'k' }));
    const page = await indexerHistoryProvider(transport, { direction: 'received' }).getHistory(ME);
    expect(JSON.parse(page.nextCursor!)).toEqual({ v: 1, in: 'k' });
    expect(page.omitted).toBeUndefined();
    expect(page.entries.find((e) => e.uid === 'usdc:log:1')).toMatchObject({ assetSymbol: 'USDC', assetAmount: 1_000_000n, assetDecimals: 6 });
  });

  it('refuses a cursor whose carry is malformed', async () => {
    const { transport } = fakeTransport(() => ({ transfers: [] }));
    const bad = JSON.stringify({ v: 1, out: 'k', co: [{ h: 1 }] });
    await expect(indexerHistoryProvider(transport, { direction: 'sent' }).getHistory(ME, bad)).rejects.toThrow(
      'Unrecognized history cursor',
    );
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isValidSolanaAddress, solanaHistoryProvider, solanaTokenMoves } from '../src/history.js';
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

  // Pass p24-unblock finding 2: token transfers. Plain SOL transfers must
  // come out exactly as before (key for key, in the same order).
  it('a plain SOL transfer is unchanged when the node reports empty or absent token-balance arrays', async () => {
    const answer = (meta: Record<string, unknown>) => async (method: string) => {
      if (method === 'getSignaturesForAddress') return [sig('sent')];
      return { meta: { fee: 5000, preBalances: [100_000, 50_000], postBalances: [94_000, 51_000], ...meta }, transaction: { message: { accountKeys: [ME, OTHER] } } };
    };
    const old = { id: 'sent', timestamp: 1700000100, confirmed: true, direction: 'out', amount: 1000n, fee: 5000n };
    for (const meta of [{}, { preTokenBalances: [], postTokenBalances: [] }, { preTokenBalances: null, postTokenBalances: null }]) {
      const page = await solanaHistoryProvider(answer(meta) as JsonRpcTransport).getHistory(ME);
      expect(page.entries).toHaveLength(1);
      // Same keys in the same order as the provider produced before.
      expect(Object.keys(page.entries[0]!)).toEqual(Object.keys(old));
      expect(page.entries[0]).toStrictEqual(old);
    }
    // A token balance of SOMEONE ELSE changing leaves this address's entry as it was.
    const others = {
      preTokenBalances: [{ accountIndex: 1, mint: OTHER, owner: OTHER, uiTokenAmount: { amount: '5', decimals: 0 } }],
      postTokenBalances: [{ accountIndex: 1, mint: OTHER, owner: OTHER, uiTokenAmount: { amount: '4', decimals: 0 } }],
    };
    const page = await solanaHistoryProvider(answer(others) as JsonRpcTransport).getHistory(ME);
    expect(page.entries).toStrictEqual([old]);
  });

  describe('token transfers, from the recorded devnet answers of 2026-11-08', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/devnet-token-history-2026-11-08.json', import.meta.url), 'utf8'),
    ) as { owner: string; signatures: Array<Record<string, unknown>>; transactions: Record<string, unknown> };
    const OWNER = fixture.owner;
    const RECIPIENT = '9WMgKdmRJBZy8WQ6Q9T6VjJN4wyT9jQenDvfvLFe471n';
    const FAUCET = 'H3sjyipQtXAJkvWNkXhDgped7k323kAba8QMwCLcV79w';
    const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
    const EURC = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
    const SEND_USDC = '3vPay79jwsm4PkEb9hBsKSKeMuRyVwWGAJUH3cUaLVRrtCbSXNjA5LDW961cV6di65aoREu7YYNW312QEA3zjFXV';
    const SEND_EURC = '2C9aCLXNnk1oYWRYQshq21b3JjEXpTGzHZTFoJYbkf8MrTYiRNE5UnNuCZvrY1GNoLGRS6k9g5iwejett5jhP5pg';
    const recorded: JsonRpcTransport = async (method, params) => {
      if (method === 'getSignaturesForAddress') return fixture.signatures.slice(0, 4);
      if (method === 'getTransaction') return fixture.transactions[(params as string[])[0]!] ?? null;
      throw new Error(`unexpected ${method}`);
    };

    it('an outgoing USDC send that created the recipient\'s token account: the token entry first, then the rent the account paid', async () => {
      const page = await solanaHistoryProvider(recorded).getHistory(OWNER);
      const [eurcToken, eurcNative, usdcToken, usdcNative] = page.entries;
      expect(usdcToken).toStrictEqual({
        id: SEND_USDC,
        timestamp: 1794113707,
        confirmed: true,
        direction: 'out',
        uid: `${SEND_USDC}:token:${USDC}`,
        assetAmount: 1_000_000n,
        assetDecimals: 6,
        contract: USDC,
        counterparty: RECIPIENT,
      });
      // 50,000,000 → 48,506,560 lamports = 5,000 fee + 1,488,440 rent.
      expect(usdcNative).toStrictEqual({
        id: SEND_USDC,
        timestamp: 1794113707,
        confirmed: true,
        direction: 'out',
        amount: 1_488_440n,
        fee: 5000n,
        uid: `${SEND_USDC}:native`,
      });
      expect(eurcToken).toMatchObject({ id: SEND_EURC, direction: 'out', assetAmount: 1_000_000n, contract: EURC, counterparty: RECIPIENT });
      expect(eurcNative).toMatchObject({ id: SEND_EURC, direction: 'out', amount: 1_488_440n, fee: 5000n });
    });

    it('the faucet deposits read as received from the faucet\'s owner, never as "self 0": one token entry, no native entry, no fee', async () => {
      const page = await solanaHistoryProvider(recorded).getHistory(OWNER);
      const deposits = page.entries.slice(4);
      expect(deposits).toHaveLength(2);
      for (const [entry, mint] of [[deposits[0]!, EURC], [deposits[1]!, USDC]] as const) {
        expect(entry.direction).toBe('in');
        expect(entry.assetAmount).toBe(20_000_000n);
        expect(entry.assetDecimals).toBe(6);
        expect(entry.contract).toBe(mint); // base-58, exactly as reported, not lowercased
        expect(entry.counterparty).toBe(FAUCET);
        expect(entry.amount).toBeUndefined();
        expect(entry.fee).toBeUndefined();
      }
      expect(page.entries.some((e) => e.direction === 'self')).toBe(false);
      expect(new Set(page.entries.map((e) => e.uid ?? e.id)).size).toBe(page.entries.length);
    });

    it('the recipient sees the same transfer as received from the sender', async () => {
      const moves = (fixture.transactions[SEND_USDC] as { meta: { preTokenBalances: never; postTokenBalances: never } }).meta;
      expect(solanaTokenMoves(moves.preTokenBalances, moves.postTokenBalances, RECIPIENT)).toStrictEqual([
        { mint: USDC, change: 1_000_000n, decimals: 6, counterparty: OWNER },
      ]);
    });
  });

  it('a token transfer to an account that already holds the token: one token entry carrying the fee, no native entry of 0', async () => {
    const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
    const transport: JsonRpcTransport = async (method) => {
      if (method === 'getSignaturesForAddress') return [sig('tok')];
      // ME paid exactly the fee in lamports; its token account sent 3 to OTHER's.
      return {
        meta: {
          fee: 5000,
          preBalances: [100_000, 2_039_280, 2_039_280],
          postBalances: [95_000, 2_039_280, 2_039_280],
          preTokenBalances: [
            { accountIndex: 1, mint: MINT, owner: ME, uiTokenAmount: { amount: '10', decimals: 6 } },
            { accountIndex: 2, mint: MINT, owner: OTHER, uiTokenAmount: { amount: '0', decimals: 6 } },
          ],
          postTokenBalances: [
            { accountIndex: 1, mint: MINT, owner: ME, uiTokenAmount: { amount: '7', decimals: 6 } },
            { accountIndex: 2, mint: MINT, owner: OTHER, uiTokenAmount: { amount: '3', decimals: 6 } },
          ],
        },
        transaction: { message: { accountKeys: [ME, 'acc1', 'acc2'] } },
      };
    };
    const page = await solanaHistoryProvider(transport).getHistory(ME);
    expect(page.entries).toStrictEqual([
      {
        id: 'tok',
        timestamp: 1700000100,
        confirmed: true,
        direction: 'out',
        uid: `tok:token:${MINT}`,
        assetAmount: 3n,
        assetDecimals: 6,
        contract: MINT,
        counterparty: OTHER,
        fee: 5000n,
      },
    ]);
  });

  describe('solanaTokenMoves refuses to guess', () => {
    const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
    const bal = (accountIndex: number, owner: string | undefined, amount: string, decimals = 6, mint = MINT) => ({
      accountIndex,
      mint,
      ...(owner !== undefined ? { owner } : {}),
      uiTokenAmount: { amount, decimals },
    });
    it('a balance with no recorded owner is never attributed', () => {
      expect(solanaTokenMoves([bal(1, undefined, '5')], [bal(1, undefined, '1')], ME)).toEqual([]);
    });
    it('malformed elements (non-integer amount, bad decimals, a non-address mint, a repeated account) make the answer uninterpreted', () => {
      expect(solanaTokenMoves([bal(1, ME, '5')], [bal(1, ME, '1.5')], ME)).toEqual([]);
      expect(solanaTokenMoves([bal(1, ME, '5')], [bal(1, ME, '1', 256)], ME)).toEqual([]);
      expect(solanaTokenMoves([bal(1, ME, '5', 6, 'not-a-mint')], [bal(1, ME, '1', 6, 'not-a-mint')], ME)).toEqual([]);
      expect(solanaTokenMoves([], [bal(1, ME, '1'), bal(1, ME, '2')], ME)).toEqual([]);
    });
    it('a mint reported with two decimals, or an account whose owner changed, is not interpreted', () => {
      expect(solanaTokenMoves([bal(1, ME, '5', 6)], [bal(1, ME, '1', 9)], ME)).toEqual([]);
      expect(solanaTokenMoves([bal(1, ME, '5')], [bal(1, OTHER, '5')], ME)).toEqual([]);
    });
    it('no single counterparty when two other owners moved the opposite way', () => {
      const THIRD = '9WMgKdmRJBZy8WQ6Q9T6VjJN4wyT9jQenDvfvLFe471n';
      expect(
        solanaTokenMoves([bal(1, ME, '10'), bal(2, OTHER, '0'), bal(3, THIRD, '0')], [bal(1, ME, '4'), bal(2, OTHER, '3'), bal(3, THIRD, '3')], ME),
      ).toEqual([{ mint: MINT, change: -6n, decimals: 6, counterparty: null }]);
    });
    it('a closed token account counts as 0 after the transaction', () => {
      expect(solanaTokenMoves([bal(1, ME, '7'), bal(2, OTHER, '0')], [bal(2, OTHER, '7')], ME)).toEqual([
        { mint: MINT, change: -7n, decimals: 6, counterparty: OTHER },
      ]);
    });
  });
});

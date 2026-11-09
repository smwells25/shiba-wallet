import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SOLANA_HISTORY_MAX_FOLLOWED_MINTS,
  SOLANA_HISTORY_MAX_SIGNATURE_REQUESTS,
  isValidSolanaAddress,
  solanaFollowedTokenAccounts,
  solanaHistoryProvider,
  solanaTokenMoves,
} from '../src/history.js';
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
      // Pass p24-solfix2 finding E: OTHER is the one account that gained 1000.
      counterparty: OTHER,
    });
    expect(page.entries[1]).toEqual({
      id: 'received',
      timestamp: 1700000100,
      confirmed: true,
      direction: 'in',
      amount: 7000n,
      // No counterparty (finding E): OTHER, the fee payer, lost 7000 in all,
      // i.e. 2000 besides the 5000 fee, not the 7000 ME received, so the
      // figures do not name one sender and nothing is guessed.
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
  // come out exactly as before (key for key, in the same order) — since pass
  // p24-solfix2 finding E with the one counterparty added last, the only
  // change.
  it('a plain SOL transfer is unchanged when the node reports empty or absent token-balance arrays (bar finding E\'s counterparty)', async () => {
    const answer = (meta: Record<string, unknown>) => async (method: string) => {
      if (method === 'getSignaturesForAddress') return [sig('sent')];
      return { meta: { fee: 5000, preBalances: [100_000, 50_000], postBalances: [94_000, 51_000], ...meta }, transaction: { message: { accountKeys: [ME, OTHER] } } };
    };
    const old = { id: 'sent', timestamp: 1700000100, confirmed: true, direction: 'out', amount: 1000n, fee: 5000n, counterparty: OTHER };
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

// Pass p24-solfix2: the recipient's history missed every incoming token
// transfer into a token account that already existed, because
// getSignaturesForAddress lists only transactions whose account keys name the
// address, and such a transfer names the token account, not the wallet.
describe('followed token accounts (pass p24-solfix2)', () => {
  const newer = JSON.parse(
    readFileSync(new URL('./fixtures/devnet-token-account-history-2026-11-08.json', import.meta.url), 'utf8'),
  ) as { signatures: Record<string, Array<Record<string, unknown>>>; transactions: Record<string, unknown> };
  const older = JSON.parse(
    readFileSync(new URL('./fixtures/devnet-token-history-2026-11-08.json', import.meta.url), 'utf8'),
  ) as { transactions: Record<string, unknown> };
  const WALLET2 = '9WMgKdmRJBZy8WQ6Q9T6VjJN4wyT9jQenDvfvLFe471n';
  const WALLET1 = 'EK5jKrBRwvQXXsSERGN6jEoYaofE2PNiZWQoaCLtrYPv';
  const DEV = '6TgSKzjg3SQSeqrDR95D7RNncYh63FPzRcDWX6T4455t';
  const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  const EURC = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
  const USDC_ATA = 'FfqpujQvP1pjUEthwcdHSqmwrYVUteNrDdNJLe9Qeedc';
  const USDC_ATA_2022 = '8DLAfMQdmVp27M8sFmSmQDCBRijeVZi3paWQGQ9ZPj2Q';
  const EURC_ATA = 'H64rT5SUGgaE81ButXjtxvCpbBZMPyQavgCyK8dENrWK';
  const EURC_ATA_2022 = 'HsSRGjzScRJ19Wm33JiEMeT5XwDBAiqMeoaDN4RDfqXF';
  const INCOMING = '4abaH22978MmD5yX8PE32kLoRFQrZtAD1j147fkxJ5E241iTQ9M1hgZAouhHGhpXprZTw595eVXQf6pBkUZh442f';
  const SEND_USDC = '3vPay79jwsm4PkEb9hBsKSKeMuRyVwWGAJUH3cUaLVRrtCbSXNjA5LDW961cV6di65aoREu7YYNW312QEA3zjFXV';
  const SEND_EURC = '2C9aCLXNnk1oYWRYQshq21b3JjEXpTGzHZTFoJYbkf8MrTYiRNE5UnNuCZvrY1GNoLGRS6k9g5iwejett5jhP5pg';
  const FUNDING = '3PdTyWyJR2qXKgBdzFMJzFaiCjUpk1G9hh2gS4zKzcsnYr7iUqMeVxjGtvN4bhyXzj9BujpRbMK7iPtzAiiYJzmE';

  const recorded = (log: Array<{ method: string; params: unknown[] }>): JsonRpcTransport => async (method, params) => {
    log.push({ method, params: params as unknown[] });
    if (method === 'getSignaturesForAddress') {
      const answer = newer.signatures[(params as string[])[0]!];
      if (!answer) throw new Error('no recorded answer for that address');
      return answer;
    }
    if (method === 'getTransaction') {
      const id = (params as string[])[0]!;
      return newer.transactions[id] ?? older.transactions[id] ?? null;
    }
    throw new Error(`unexpected ${method}`);
  };

  it('derives the associated token accounts of both programs, with no request, matching the recorded devnet accounts', () => {
    expect(solanaFollowedTokenAccounts(WALLET2, [USDC, EURC])).toEqual([USDC_ATA, USDC_ATA_2022, EURC_ATA, EURC_ATA_2022]);
    // Duplicates and invalid mints are skipped; an invalid owner follows nothing.
    expect(solanaFollowedTokenAccounts(WALLET2, [USDC, 'not-a-mint', USDC])).toEqual([USDC_ATA, USDC_ATA_2022]);
    expect(solanaFollowedTokenAccounts('not-an-address', [USDC])).toEqual([]);
    // At most SOLANA_HISTORY_MAX_FOLLOWED_MINTS mints, two accounts each.
    const many = [USDC, EURC, WALLET1, DEV, OTHER, ME];
    expect(solanaFollowedTokenAccounts(WALLET2, many)).toHaveLength(2 * SOLANA_HISTORY_MAX_FOLLOWED_MINTS);
  });

  it('without followed accounts the recipient misses the incoming 1 USDC (the gap as found); with them it is listed once, attributed to its sender', async () => {
    const before: Array<{ method: string; params: unknown[] }> = [];
    const gap = await solanaHistoryProvider(recorded(before)).getHistory(WALLET2);
    expect(gap.entries.some((e) => e.id === INCOMING)).toBe(false);

    const log: Array<{ method: string; params: unknown[] }> = [];
    const page = await solanaHistoryProvider(recorded(log), { followTokenMints: [USDC, EURC] }).getHistory(WALLET2);
    expect(page.entries).toStrictEqual([
      {
        id: INCOMING,
        timestamp: 1794162670,
        confirmed: true,
        direction: 'in',
        uid: `${INCOMING}:token:${USDC}`,
        assetAmount: 1_000_000n,
        assetDecimals: 6,
        contract: USDC,
        counterparty: WALLET1,
      },
      expect.objectContaining({ id: SEND_EURC, direction: 'in', assetAmount: 1_000_000n, contract: EURC, counterparty: WALLET1 }),
      expect.objectContaining({ id: SEND_USDC, direction: 'in', assetAmount: 1_000_000n, contract: USDC, counterparty: WALLET1 }),
    ]);
    // The wallet pays no fee for an incoming transfer it did not send.
    expect(page.entries.every((e) => e.fee === undefined)).toBe(true);
    // 3vPay and 2C9a are in the wallet's list AND in a token account's list: once each.
    expect(new Set(page.entries.map((e) => e.id)).size).toBe(3);
    // Every stream answered a short page: no next page.
    expect(page.nextCursor).toBeUndefined();
    // One request per stream (the wallet, then the four derived accounts), then one getTransaction per listed signature.
    expect(log.filter((c) => c.method === 'getSignaturesForAddress').map((c) => (c.params[0] as string))).toEqual([
      WALLET2, USDC_ATA, USDC_ATA_2022, EURC_ATA, EURC_ATA_2022,
    ]);
    expect(log.filter((c) => c.method === 'getTransaction').map((c) => c.params[0])).toEqual([INCOMING, SEND_EURC, SEND_USDC]);
  });

  it('the sender\'s side of the recorded incoming transfer is unchanged (Account 1 is a key and paid the fee)', async () => {
    const log: Array<{ method: string; params: unknown[] }> = [];
    const page = await solanaHistoryProvider(recorded(log)).getHistory(WALLET1);
    expect(page.entries[0]).toStrictEqual({
      id: INCOMING,
      timestamp: 1794162670,
      confirmed: true,
      direction: 'out',
      uid: `${INCOMING}:token:${USDC}`,
      assetAmount: 1_000_000n,
      assetDecimals: 6,
      contract: USDC,
      counterparty: WALLET2,
      fee: 5000n,
    });
  });

  it('finding E: the recorded 0.05 SOL funding names the other side on both accounts', async () => {
    const one = (who: string): JsonRpcTransport => async (method) =>
      method === 'getSignaturesForAddress' ? [{ signature: FUNDING, slot: 519736028, err: null, blockTime: 1794072707, confirmationStatus: 'finalized' }] : newer.transactions[FUNDING];
    const received = await solanaHistoryProvider(one(WALLET1)).getHistory(WALLET1);
    expect(received.entries).toStrictEqual([
      { id: FUNDING, timestamp: 1794072707, confirmed: true, direction: 'in', amount: 50_000_000n, counterparty: DEV },
    ]);
    const sent = await solanaHistoryProvider(one(DEV)).getHistory(DEV);
    expect(sent.entries).toStrictEqual([
      { id: FUNDING, timestamp: 1794072707, confirmed: true, direction: 'out', amount: 50_000_000n, fee: 5000n, counterparty: WALLET1 },
    ]);
  });

  it('finding E: no counterparty when two other accounts received the same amount, or when nothing but the fee moved', async () => {
    const page = await solanaHistoryProvider(async (method) =>
      method === 'getSignaturesForAddress'
        ? [sig('split')]
        : { meta: { fee: 5000, preBalances: [100_000, 0, 0], postBalances: [93_000, 1_000, 1_000] }, transaction: { message: { accountKeys: [ME, OTHER, WALLET1] } } },
    ).getHistory(ME);
    // ME sent 2000 in total; neither recipient received exactly 2000.
    expect(page.entries[0]).toStrictEqual({ id: 'split', timestamp: 1700000100, confirmed: true, direction: 'out', amount: 2000n, fee: 5000n });
    const twins = await solanaHistoryProvider(async (method) =>
      method === 'getSignaturesForAddress'
        ? [sig('twins')]
        : { meta: { fee: 5000, preBalances: [100_000, 0, 9_000], postBalances: [94_000, 1_000, 10_000] }, transaction: { message: { accountKeys: [ME, OTHER, WALLET1] } } },
    ).getHistory(ME);
    // ME lost 6000 = the 5000 fee + 1000, and BOTH other accounts gained exactly 1000: ambiguous.
    expect(twins.entries[0]!.counterparty).toBeUndefined();
    const feeOnly = await solanaHistoryProvider(async (method) =>
      method === 'getSignaturesForAddress'
        ? [sig('fee')]
        : { meta: { fee: 5000, preBalances: [100_000, 0], postBalances: [95_000, 0] }, transaction: { message: { accountKeys: [ME, OTHER] } } },
    ).getHistory(ME);
    expect(feeOnly.entries[0]).toStrictEqual({ id: 'fee', timestamp: 1700000100, confirmed: true, direction: 'self', amount: 0n, fee: 5000n });
  });

  it('with no followed mint (absent or empty) the requests, pages and cursors are exactly the single-stream ones; a bare cursor continues the address alone', async () => {
    const infos = Array.from({ length: 3 }, (_, i) => sig(`s${i}`, { slot: 10 - i }));
    const run = async (options: Record<string, unknown>, cursor?: string) => {
      const log: string[] = [];
      const transport: JsonRpcTransport = async (method, params) => {
        log.push(JSON.stringify([method, params]));
        return method === 'getSignaturesForAddress' ? infos : null;
      };
      const page = await solanaHistoryProvider(transport, { pageSize: 3, enrichLimit: 1, ...options }).getHistory(ME, cursor);
      return { page, log };
    };
    const base = await run({});
    expect(base.page.nextCursor).toBe('s2');
    expect(base.log).toEqual([
      JSON.stringify(['getSignaturesForAddress', [ME, { limit: 3, commitment: 'confirmed' }]]),
      JSON.stringify(['getTransaction', ['s0', { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]]),
    ]);
    for (const options of [{ followTokenMints: [] }, { followTokenMints: undefined }]) {
      const again = await run(options);
      expect(again.page).toStrictEqual(base.page);
      expect(again.log).toEqual(base.log);
    }
    // A bare (old-format) cursor with mints now followed: the address's own stream only, as before.
    const bare = await run({ followTokenMints: [USDC] }, 's2');
    const bareBase = await run({}, 's2');
    expect(bare.page).toStrictEqual(bareBase.page);
    expect(bare.log).toEqual(bareBase.log);
    expect(JSON.parse(bare.log[0]!)[1][1]).toEqual({ limit: 3, commitment: 'confirmed', before: 's2' });
  });

  it('refuses a malformed JSON cursor and one for another address; drops an account no longer followed', async () => {
    const empty: JsonRpcTransport = async () => [];
    const provider = solanaHistoryProvider(empty, { followTokenMints: [USDC] });
    for (const bad of ['{', '{"v":2,"s":[]}', '{"v":1,"s":[]}', `{"v":1,"s":[["${WALLET1}",null,0]]}`, `{"v":1,"s":[["${WALLET2}","0OIl",0]]}`, `{"v":1,"s":[["${WALLET2}",null,2]]}`, `{"v":1,"s":[["${WALLET2}",null,0]],"x":1}`]) {
      await expect(provider.getHistory(WALLET2, bad)).rejects.toThrow('Unrecognized history cursor');
    }
    const log: string[] = [];
    const watching: JsonRpcTransport = async (method, params) => {
      log.push((params as string[])[0]!);
      return [];
    };
    // EURC's account is in the cursor but EURC is no longer followed: it is not asked.
    const cursor = JSON.stringify({ v: 1, s: [[WALLET2, null, 0], [USDC_ATA, null, 0], [EURC_ATA, null, 0]] });
    const page = await solanaHistoryProvider(watching, { followTokenMints: [USDC] }).getHistory(WALLET2, cursor);
    expect(log).toEqual([WALLET2, USDC_ATA]);
    expect(page).toStrictEqual({ entries: [] });
  });

  // A synthetic chain: streams of signatures with slots, paged with `before`
  // exactly as getSignaturesForAddress does (newest first, `limit`).
  type Fake = { signature: string; slot: number };
  // Signatures in a cursor must be base-58 text, which has no 0 and no l.
  const safe = (name: string) => name.replace(/0/g, 'Z').replace(/l/g, 'L');
  const fakeChain = (lists: Record<string, Fake[]>, counter: { signatures: number }): JsonRpcTransport => async (method, params) => {
    if (method === 'getTransaction') return null;
    const [address, config] = params as [string, { limit: number; before?: string }];
    counter.signatures++;
    const list = lists[address] ?? [];
    const start = config.before === undefined ? 0 : list.findIndex((x) => x.signature === config.before) + 1;
    if (config.before !== undefined && start === 0) throw new Error('unknown before');
    return list.slice(start, start + config.limit).map((x) => sig(x.signature, { slot: x.slot, blockTime: x.slot }));
  };

  async function readAll(lists: Record<string, Fake[]>, pageSize: number) {
    const counter = { signatures: 0 };
    const provider = solanaHistoryProvider(fakeChain(lists, counter), { pageSize, enrichLimit: 0, followTokenMints: [USDC, EURC] });
    const seen: string[] = [];
    const perPage: number[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 200; n++) {
      const before = counter.signatures;
      const page = await provider.getHistory(WALLET2, cursor);
      perPage.push(counter.signatures - before);
      seen.push(...page.entries.map((e) => e.id));
      if (!page.nextCursor) return { seen, perPage };
      cursor = page.nextCursor;
    }
    throw new Error('did not finish');
  }

  it('merges the streams in slot order across pages, every signature exactly once, within the request bound', async () => {
    // The wallet and its USDC account interleave; one transaction (t95) is in
    // both; the EURC account is older than both; the Token-2022 accounts are empty.
    const at = (name: string, slot: number): Fake => ({ signature: safe(name), slot });
    const lists = {
      [WALLET2]: [at('w100', 100), at('t95', 95), at('w90', 90), at('w85', 85), at('w80', 80), at('w70', 70)],
      [USDC_ATA]: [at('u99', 99), at('t95', 95), at('u60', 60), at('u50', 50)],
      [EURC_ATA]: [at('e40', 40), at('e30', 30), at('e20', 20)],
    };
    const { seen, perPage } = await readAll(lists, 2);
    expect(seen).toEqual(['w100', 'u99', 't95', 'w90', 'w85', 'w80', 'w70', 'u60', 'u50', 'e40', 'e30', 'e20'].map(safe));
    expect(perPage.every((n) => n <= SOLANA_HISTORY_MAX_SIGNATURE_REQUESTS)).toBe(true);
  });

  it('a random stress: every page in slot order, nothing missed, nothing twice, one slot never split', async () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 30; round++) {
      const accounts = [WALLET2, USDC_ATA, USDC_ATA_2022, EURC_ATA, EURC_ATA_2022];
      const lists: Record<string, Fake[]> = Object.fromEntries(accounts.map((a) => [a, [] as Fake[]]));
      const all = new Map<string, number>();
      let slot = 1000;
      for (let i = 0; i < 40; i++) {
        slot -= Math.floor(rand() * 3); // several transactions can share a slot
        const name = safe(`x${round}n${i}`);
        all.set(name, slot);
        const touched = accounts.filter(() => rand() < 0.35);
        for (const a of touched.length > 0 ? touched : [accounts[Math.floor(rand() * accounts.length)]!]) lists[a]!.push({ signature: name, slot });
      }
      const pageSize = 1 + Math.floor(rand() * 4);
      const { seen, perPage } = await readAll(lists, pageSize);
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual([...all.keys()].sort());
      for (let i = 1; i < seen.length; i++) expect(all.get(seen[i]!)!).toBeLessThanOrEqual(all.get(seen[i - 1]!)!);
      expect(perPage.every((n) => n <= SOLANA_HISTORY_MAX_SIGNATURE_REQUESTS)).toBe(true);
    }
  }, 20_000); // 30 rounds: 4.3 s with a host load average of 76 (verify run, 2026-11-08); the 5 s default timed out once under three concurrent runners
});

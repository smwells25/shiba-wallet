import type { HistoryEntry, HistoryPage, HistoryProvider } from '@shiba-wallet/core';
import { getErc20Transfers, httpTransport } from '@shiba-wallet/chains-evm';
import type { JsonRpcTransport } from '@shiba-wallet/chains-evm';

/**
 * Tracked-token transfer history over a plain JSON-RPC endpoint — the
 * no-indexer fallback for the EVM Activity screen (phase 5, item 4). A
 * standard node cannot list transactions by address, but it CAN serve
 * per-contract Transfer logs, so when the user tracks tokens we show
 * those transfers even without an indexer. Native-ETH history still
 * requires the indexer, and the screen says so.
 *
 * Paging walks block windows backwards. The engine's live probe of the
 * free public endpoint (packages/chains-evm/src/erc20-logs.ts) pinned
 * the practical constraints: a contract filter is required and a
 * 10,000-block window succeeds, so pages use 9,000-block windows and a
 * bounded lookback (8 windows ~ 72k blocks) with an honest end-of-range
 * cursor stop rather than an unbounded crawl of chain history.
 */

export interface TrackedTokenRef {
  /** ERC-20 contract address. */
  address: string;
  symbol: string;
  decimals: number;
}

export interface TokenLogsConfig {
  rpcUrl: string;
  walletAddress: string;
  tokens: TrackedTokenRef[];
  /** Injectable for scripts/tests. */
  transport?: JsonRpcTransport;
  windowBlocks?: bigint;
  maxWindows?: number;
}

interface Cursor {
  v: 1;
  /** Inclusive upper block of the NEXT (older) window, as a decimal string. */
  to: string;
  /** Windows already served, for the bounded-lookback stop. */
  served: number;
}

export function tokenLogsHistoryProvider(config: TokenLogsConfig): HistoryProvider {
  const transport = config.transport ?? httpTransport(config.rpcUrl);
  const windowBlocks = config.windowBlocks ?? 9_000n;
  const maxWindows = config.maxWindows ?? 8;
  const me = config.walletAddress.toLowerCase();

  return {
    async getHistory(_address: string, cursorRaw?: string): Promise<HistoryPage> {
      let toBlock: bigint;
      let served: number;
      if (cursorRaw) {
        const cursor = parseCursor(cursorRaw);
        toBlock = BigInt(cursor.to);
        served = cursor.served;
      } else {
        toBlock = BigInt((await transport('eth_blockNumber', [])) as string);
        served = 0;
      }
      const fromBlock = toBlock >= windowBlocks ? toBlock - windowBlocks + 1n : 0n;

      // One windowed query per tracked token; merged newest-first. Token
      // count is user-curated and small, and each query is contract-
      // filtered per the endpoint's requirements.
      const perToken = await Promise.all(
        config.tokens.map(async (token) => {
          const transfers = await getErc20Transfers(transport, {
            address: config.walletAddress,
            token: token.address,
            fromBlock,
            toBlock,
          });
          return transfers.map((t): HistoryEntry => {
            const from = t.from.toLowerCase();
            const to = t.to.toLowerCase();
            return {
              id: t.txHash,
              uid: `${t.txHash}:log:${t.logIndex}`,
              // Log queries carry block numbers, not timestamps; the
              // Activity renderer shows "block N" for confirmed
              // timestamp-less entries instead of implying pending.
              timestamp: null,
              confirmed: true,
              blockHeight: Number(t.blockNumber),
              direction: from === me && to === me ? 'self' : from === me ? 'out' : 'in',
              assetSymbol: token.symbol,
              assetAmount: t.value,
              assetDecimals: token.decimals,
            };
          });
        }),
      );

      const entries = perToken
        .flat()
        .sort((a, b) => (b.blockHeight ?? 0) - (a.blockHeight ?? 0));

      const nextServed = served + 1;
      const exhausted = fromBlock === 0n || nextServed >= maxWindows;
      return {
        entries,
        ...(exhausted
          ? {}
          : {
              nextCursor: JSON.stringify({
                v: 1,
                to: (fromBlock - 1n).toString(),
                served: nextServed,
              } satisfies Cursor),
            }),
      };
    },
  };
}

function parseCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(raw) as Cursor;
    if (parsed.v === 1 && typeof parsed.to === 'string' && /^[0-9]+$/.test(parsed.to)) {
      return { v: 1, to: parsed.to, served: Number(parsed.served) || 0 };
    }
  } catch {
    // fall through
  }
  throw new Error(`Unrecognized token-history cursor: ${raw}`);
}

import type { HistoryEntry, HistoryPage, HistoryProvider } from '@shiba-wallet/core';
import { getErc20Transfers } from '@shiba-wallet/chains-evm';
import type { JsonRpcTransport } from '@shiba-wallet/chains-evm';

/**
 * Tracked-token transfer history over a plain JSON-RPC endpoint — the
 * no-indexer fallback for the EVM Activity screen (phase 5, item 4). A
 * standard node cannot list transactions by address, but it CAN serve
 * per-contract Transfer logs, so when the user tracks tokens we show
 * those transfers even without an indexer. Native-ETH history still
 * requires the indexer, and the screen says so.
 *
 * Paging walks block windows backwards, one window per page. The engine's
 * live probe of the free public endpoint (packages/chains-evm/src/
 * erc20-logs.ts) pinned the practical constraints: a contract filter is
 * required and a 10,000-block window succeeds, so pages use 9,000-block
 * windows and a bounded lookback (8 windows ~ 72k blocks) with an honest
 * end-of-range cursor stop rather than an unbounded crawl of chain history.
 *
 * ENDPOINT DEPTH. Free endpoints also limit how far BACK they serve logs,
 * independently of the window size. Live probe 2026-10-02 against
 * https://ethereum.publicnode.com: eth_getLogs with fromBlock 8,999 and
 * 9,999 blocks behind the head answered (HTTP 200), while 10,100 and
 * 17,999 blocks behind were refused with HTTP 403 and the JSON-RPC error
 * -32602 "Archive requests require a personal token. Get one at:
 * https://www.allnodes.com/publicnode" (the same refusal approvals.ts
 * records from its 2026-10-01 probe; the Sepolia default served 50,000
 * blocks). So on that endpoint the second 9,000-block window is refused.
 *
 * The provider follows approvals.ts's discipline for such refusals: a
 * window counts only when every query in it succeeded; the first window
 * that fails stops paging (the page carries no cursor), the failing
 * window's partial results are discarded so the answered range stays
 * exact, and the page reports the deepest block that WAS answered plus
 * the endpoint's own error text verbatim. Any error on a window counts,
 * not only a recognised wording: refusal messages differ between
 * providers, and a deeper window failing after a shallower one succeeded
 * is the depth limit in practice. The wallet does not retry with smaller
 * windows: the refusal above depends on how far back fromBlock lies, so a
 * halved second window (fromBlock 13,499 behind the head) would be refused
 * just the same and would only add load on a free public endpoint. Only
 * eth_blockNumber failing on the first page is thrown, because then the
 * endpoint answered nothing at all and the screen's retryable error state
 * is the honest answer.
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
  /** Injectable for scripts/tests. Defaults to tokenLogsTransport(rpcUrl). */
  transport?: JsonRpcTransport;
  windowBlocks?: bigint;
  maxWindows?: number;
}

/** A window the endpoint did not answer, with its reason as received. */
export interface TokenLogsRefusal {
  fromBlock: bigint;
  toBlock: bigint;
  /**
   * The endpoint's own error message, verbatim, when it answered with a
   * JSON-RPC error object; otherwise the transport's error message (for
   * example a network failure).
   */
  message: string;
  /** The JSON-RPC error code, when the endpoint sent one. */
  code?: number;
}

/** What block range a page sequence has covered so far, and why it stopped. */
export interface TokenLogsCoverage {
  /** Head block when the first page was fetched (upper end, inclusive). */
  headBlock: bigint;
  /**
   * Lowest block of the answered range (inclusive), or null when the
   * endpoint did not answer even the newest window.
   */
  answeredFromBlock: bigint | null;
  /**
   * Why paging ended; absent while older pages remain. 'refused': a window
   * failed (see refusal). 'lookback-limit': the wallet's own bounded
   * lookback was reached. 'genesis': block 0 was reached.
   */
  stop?: 'refused' | 'lookback-limit' | 'genesis';
  refusal?: TokenLogsRefusal;
  /** The wallet's lookback bound, in blocks (windowBlocks × maxWindows). */
  lookbackBlocks: bigint;
}

/** A HistoryPage that also reports the covered block range. */
export interface TokenLogsPage extends HistoryPage {
  tokenLogsCoverage: TokenLogsCoverage;
}

export interface TokenLogsHistoryProvider extends HistoryProvider {
  getHistory(address: string, cursor?: string): Promise<TokenLogsPage>;
}

/** The coverage report of a page produced by this provider, if it is one. */
export function tokenLogsCoverageOf(page: HistoryPage): TokenLogsCoverage | undefined {
  const coverage = (page as Partial<TokenLogsPage>).tokenLogsCoverage;
  return coverage && typeof coverage === 'object' ? coverage : undefined;
}

interface Cursor {
  v: 1;
  /** Inclusive upper block of the NEXT (older) window, as a decimal string. */
  to: string;
  /** Windows already served, for the bounded-lookback stop. */
  served: number;
  /** Head block of the first page, as a decimal string. */
  head?: string;
}

/**
 * JSON-RPC transport that keeps the endpoint's error object even when the
 * HTTP status is not 2xx. The engine's httpTransport
 * (packages/chains-evm/src/rpc.ts) throws "RPC HTTP error 403" before
 * reading the body, which would lose the refusal reason: publicnode sends
 * its archive refusal with HTTP 403 (probe above). This mirrors
 * simulation.ts's simulationTransport, which approvals.ts uses for the same
 * reason; it is duplicated rather than imported because simulation.ts
 * imports config/prefs.ts, which pulls in AsyncStorage, and this module must
 * stay free of React Native imports. The thrown Error carries `rpcMessage`
 * (the endpoint's text, verbatim) and `code` when the body held an error.
 */
export function tokenLogsTransport(url: string, fetchFn?: typeof fetch): JsonRpcTransport {
  let id = 0;
  return async (method, params) => {
    const doFetch = fetchFn ?? globalThis.fetch;
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const error =
      body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    if (error && typeof error === 'object') {
      const { code, message } = error as { code?: unknown; message?: unknown };
      const text = typeof message === 'string' ? message : 'unknown error';
      const thrown = new Error(
        `RPC error ${typeof code === 'number' ? code : '?'}: ${text} (${method})`,
      ) as Error & { code?: number; rpcMessage?: string };
      if (typeof code === 'number') thrown.code = code;
      thrown.rpcMessage = text;
      throw thrown;
    }
    if (!response.ok) throw new Error(`RPC HTTP error ${response.status} for ${method}`);
    if (!body || typeof body !== 'object' || !('result' in body)) {
      throw new Error(`RPC response without a result for ${method}`);
    }
    return (body as { result: unknown }).result;
  };
}

function refusalFrom(error: unknown, fromBlock: bigint, toBlock: bigint): TokenLogsRefusal {
  if (error instanceof Error) {
    const { rpcMessage, code } = error as Error & { rpcMessage?: unknown; code?: unknown };
    return {
      fromBlock,
      toBlock,
      message: typeof rpcMessage === 'string' ? rpcMessage : error.message,
      ...(typeof code === 'number' ? { code } : {}),
    };
  }
  return { fromBlock, toBlock, message: String(error) };
}

export function tokenLogsHistoryProvider(config: TokenLogsConfig): TokenLogsHistoryProvider {
  const transport = config.transport ?? tokenLogsTransport(config.rpcUrl);
  const windowBlocks = config.windowBlocks ?? 9_000n;
  const maxWindows = config.maxWindows ?? 8;
  const lookbackBlocks = windowBlocks * BigInt(maxWindows);
  const me = config.walletAddress.toLowerCase();

  return {
    async getHistory(_address: string, cursorRaw?: string): Promise<TokenLogsPage> {
      let toBlock: bigint;
      let served: number;
      let headBlock: bigint;
      if (cursorRaw) {
        const cursor = parseCursor(cursorRaw);
        toBlock = BigInt(cursor.to);
        served = cursor.served;
        // Cursors from before the head was recorded: the window above this
        // one is the best available upper bound.
        headBlock = cursor.head !== undefined ? BigInt(cursor.head) : toBlock + windowBlocks;
      } else {
        // Thrown on failure: with no head block the endpoint answered
        // nothing, and the screen's retryable error state is the honest one.
        const head = await transport('eth_blockNumber', []);
        if (typeof head !== 'string' || !/^0x[0-9a-fA-F]+$/.test(head)) {
          throw new Error('eth_blockNumber returned a malformed result');
        }
        toBlock = BigInt(head);
        headBlock = toBlock;
        served = 0;
      }
      const fromBlock = toBlock >= windowBlocks ? toBlock - windowBlocks + 1n : 0n;
      // Lowest block answered by the windows already served (null on the
      // first page, where nothing has been answered yet).
      const answeredBefore = cursorRaw ? toBlock + 1n : null;

      // One windowed query per tracked token; merged newest-first. Token
      // count is user-curated and small, and each query is contract-
      // filtered per the endpoint's requirements. allSettled so that every
      // query has finished before the window is judged.
      const outcomes = await Promise.allSettled(
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

      const failure = outcomes.find(
        (o): o is PromiseRejectedResult => o.status === 'rejected',
      );
      if (failure) {
        // The window does not count: its partial results are dropped so
        // that "answered from block N" stays exactly true, and paging stops
        // here (no cursor) instead of surfacing an error on a later page.
        return {
          entries: [],
          tokenLogsCoverage: {
            headBlock,
            answeredFromBlock: answeredBefore,
            stop: 'refused',
            refusal: refusalFrom(failure.reason, fromBlock, toBlock),
            lookbackBlocks,
          },
        };
      }

      const entries = outcomes
        .flatMap((o) => (o.status === 'fulfilled' ? o.value : []))
        .sort((a, b) => (b.blockHeight ?? 0) - (a.blockHeight ?? 0));

      const nextServed = served + 1;
      const reachedGenesis = fromBlock === 0n;
      const exhausted = reachedGenesis || nextServed >= maxWindows;
      const coverage: TokenLogsCoverage = {
        headBlock,
        answeredFromBlock: fromBlock,
        lookbackBlocks,
        ...(exhausted ? { stop: reachedGenesis ? ('genesis' as const) : ('lookback-limit' as const) } : {}),
      };
      return {
        entries,
        tokenLogsCoverage: coverage,
        ...(exhausted
          ? {}
          : {
              nextCursor: JSON.stringify({
                v: 1,
                to: (fromBlock - 1n).toString(),
                served: nextServed,
                head: headBlock.toString(),
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
      const head =
        typeof parsed.head === 'string' && /^[0-9]+$/.test(parsed.head) ? parsed.head : undefined;
      return {
        v: 1,
        to: parsed.to,
        served: Number(parsed.served) || 0,
        ...(head !== undefined ? { head } : {}),
      };
    }
  } catch {
    // fall through
  }
  throw new Error(`Unrecognized token-history cursor: ${raw}`);
}

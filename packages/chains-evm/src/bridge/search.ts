import type {
  BridgeBlockHeader,
  BridgeBlockReader,
  BridgeDestinationSearch,
  BridgeEventLogReader,
  BridgeLog,
} from './types.js';

/**
 * Where on the receiving chain to look for a bridge transfer's delivery
 * (pass p23-cctp-recheck, 2026-10-26). Shared by the CCTP and LayerZero
 * adapters. Pure apart from the reads the app injects.
 *
 * Why time and not a block count: the receiving chains produce blocks at
 * very different rates (measured 2026-10-27 over 20,000-block spans on two
 * endpoints each: Base Sepolia 0.2000 s per block, Arbitrum Sepolia about
 * 0.258-0.263 s; Ethereum Sepolia 12 s slots), so a fixed number of blocks
 * is six hours on one chain and two weeks on another. The app's earlier
 * search refused anything older than 108,000 blocks (12 windows of 9,000)
 * from the receiving head at quote time, which on Base Sepolia is six
 * hours: an attested CCTP transfer older than that could never be minted
 * from the wallet again. Here the search starts at the receiving chain's
 * block at (or just before) the sending transaction's time, found from
 * block timestamps (findBlockAtOrBefore), and runs forward to the head or
 * to the receiving block at a bound expressed in TIME
 * (BRIDGE_SEARCH_BOUND_SECONDS) after it, found the same way.
 *
 * The search assumes that a chain's block timestamps never decrease from
 * one block to the next (each EVM chain's block rules; not re-read for
 * this module). If a node broke that, the search would still end after at
 * most BRIDGE_BLOCK_SEARCH_MAX_PROBES reads, at a block whose timestamp is
 * at or before the target, so it would start too late or too early but
 * never loop.
 */

/** eth_getLogs window, in blocks (the same judgement as the app's earlier reader and risk.ts RISK_LOG_WINDOW_BLOCKS). */
export const BRIDGE_SEARCH_WINDOW_BLOCKS = 9_000n;
/**
 * How long after the sending transaction the receiving chain is searched:
 * 7 days (a judgement). A CCTP mint can be sent any time after Circle's
 * attestation (about 17 minutes in the measured runs) and LayerZero
 * delivered in 30-90 s in the measured runs, so a week covers a mint sent
 * days late; past it the wallet says how far it searched instead of
 * guessing.
 */
export const BRIDGE_SEARCH_BOUND_SECONDS = 7n * 86_400n;
/**
 * The search starts this long before the sending transaction's time (a
 * judgement): the two chains' clocks are set by different block producers,
 * so the receiving chain's block "at" a moment can be a little late.
 */
export const BRIDGE_SEARCH_START_MARGIN_SECONDS = 600n;
/**
 * The most block reads one search for a block may make (a guard against a
 * node whose timestamps do not behave; a near-linear chain needs about 5 to
 * 15, see findBlockAtOrBefore).
 */
export const BRIDGE_BLOCK_SEARCH_MAX_PROBES = 128;
/** The first step back from the head when no block rate is known yet (blocks; judgement). */
export const BRIDGE_BLOCK_SEARCH_FIRST_STEP = 1_000n;

/**
 * Block headers a search found for a time, kept by the caller between
 * tracking passes (key: chain id and target time). Optional.
 */
export type BridgeSearchCache = Map<string, BridgeBlockHeader>;

async function readHeader(readBlock: BridgeBlockReader, chainId: number, block: bigint | 'latest'): Promise<BridgeBlockHeader> {
  const h = await readBlock({ chainId, block });
  if (!h || typeof h.number !== 'bigint' || typeof h.timestamp !== 'bigint' || h.number < 0n || h.timestamp < 0n) {
    throw new Error('The block reader answered without a block number and timestamp.');
  }
  if (block !== 'latest' && h.number !== block) throw new Error(`The node answered block ${h.number} when block ${block} was asked for.`);
  return h;
}

/**
 * The highest block whose timestamp is at or before `timestamp`.
 *
 * The search walks back from the head and never asks for blocks much older
 * than the answer, because public endpoints prune old blocks: on
 * 2026-10-27 base-sepolia-rpc.publicnode.com refused block 33,554,432 with
 * "pruned history unavailable: requested 33554432, earliest available
 * 46500000" (code 4444), so a search that bisects from block 0 fails there.
 * First it steps back from the head by the distance the local block rate
 * suggests, plus a quarter (BRIDGE_BLOCK_SEARCH_FIRST_STEP blocks when no
 * rate is known yet, doubling across equal timestamps), until it passes the
 * target; then it narrows the bracket by interpolating on the two ends'
 * timestamps, bisecting whenever an interpolation did not halve it, so it
 * ends in a few reads on a chain with a steady block time and in about
 * 2 x log2(range) reads at worst. A target at or after the head gives the
 * head; one before the chain's first block, block 0.
 */
export async function findBlockAtOrBefore(
  readBlock: BridgeBlockReader,
  chainId: number,
  timestamp: bigint,
  head?: BridgeBlockHeader,
  cache?: BridgeSearchCache,
): Promise<{ block: BridgeBlockHeader; reads: number }> {
  let reads = 0;
  const top = head ?? (await readHeader(readBlock, chainId, 'latest'));
  if (head === undefined) reads += 1;
  if (top.timestamp <= timestamp) return { block: top, reads };
  const key = `${chainId}:${timestamp}`;
  const cached = cache?.get(key);
  if (cached && cached.number < top.number) return { block: cached, reads };
  let probes = 0;
  const probe = async (n: bigint): Promise<BridgeBlockHeader> => {
    probes += 1;
    if (probes > BRIDGE_BLOCK_SEARCH_MAX_PROBES) throw new Error('The block search did not end within its limit.');
    reads += 1;
    return readHeader(readBlock, chainId, n);
  };
  // Walk back until a block at or before the target is found.
  let hi = top; // timestamp > target
  let above: BridgeBlockHeader | null = null; // a block after hi, for the local rate
  let lo: BridgeBlockHeader | null = null; // timestamp <= target
  let step = BRIDGE_BLOCK_SEARCH_FIRST_STEP;
  while (lo === null) {
    if (hi.number === 0n) return { block: hi, reads };
    let back: bigint;
    if (above !== null && above.timestamp > hi.timestamp) {
      // Blocks per second from (hi, above), the distance to the target, plus a quarter.
      back = ((hi.timestamp - timestamp) * (above.number - hi.number) * 5n) / (4n * (above.timestamp - hi.timestamp)) + 1n;
    } else {
      back = step;
      step *= 2n;
    }
    const h = await probe(hi.number > back ? hi.number - back : 0n);
    if (h.timestamp <= timestamp) lo = h;
    else {
      above = hi;
      hi = h;
    }
  }
  // Narrow (lo, hi): interpolate, and bisect after an interpolation that did not halve the bracket.
  let bisect = false;
  while (hi.number - lo.number > 1n) {
    const width = hi.number - lo.number;
    let mid: bigint;
    if (!bisect && hi.timestamp > lo.timestamp) {
      mid = lo.number + ((timestamp - lo.timestamp) * width) / (hi.timestamp - lo.timestamp);
      if (mid <= lo.number) mid = lo.number + 1n;
      if (mid >= hi.number) mid = hi.number - 1n;
    } else mid = (lo.number + hi.number) >> 1n;
    const h = await probe(mid);
    if (h.timestamp <= timestamp) lo = h;
    else hi = h;
    bisect = !bisect && (hi.number - lo.number) * 2n > width;
  }
  if (cache && lo.number < top.number) cache.set(key, lo);
  return { block: lo, reads };
}

/**
 * Plans the search of the receiving chain for a transfer sent at
 * `sinceTimestamp` (the sending block's timestamp): from the receiving
 * block at that time less the margin, to the head, or, when the head is
 * more than `boundSeconds` after the start block, to the receiving block at
 * the start block's time plus `boundSeconds` (found the same way, so the
 * span stated is the span searched). With a cache, a later pass for the
 * same transfer reads only the head.
 */
export async function planDestinationSearch(
  readBlock: BridgeBlockReader,
  request: { chainId: number; sinceTimestamp: bigint; boundSeconds?: bigint; marginSeconds?: bigint; cache?: BridgeSearchCache | undefined },
): Promise<BridgeDestinationSearch & { reads: number }> {
  const bound = request.boundSeconds ?? BRIDGE_SEARCH_BOUND_SECONDS;
  const margin = request.marginSeconds ?? BRIDGE_SEARCH_START_MARGIN_SECONDS;
  if (bound <= 0n || margin < 0n) throw new Error('The search bound must be positive and the margin not negative.');
  const head = await readHeader(readBlock, request.chainId, 'latest');
  const target = request.sinceTimestamp > margin ? request.sinceTimestamp - margin : 0n;
  const found = await findBlockAtOrBefore(readBlock, request.chainId, target, head, request.cache);
  let reads = 1 + found.reads;
  const start = found.block;
  if (head.timestamp - start.timestamp <= bound || head.number <= start.number) {
    return { fromBlock: start.number, toBlock: head.number, fromTimestamp: start.timestamp, toTimestamp: head.timestamp, bounded: false, boundSeconds: bound, reads };
  }
  const end = await findBlockAtOrBefore(readBlock, request.chainId, start.timestamp + bound, head, request.cache);
  reads += end.reads;
  return { fromBlock: start.number, toBlock: end.block.number, fromTimestamp: start.timestamp, toTimestamp: end.block.timestamp, bounded: true, boundSeconds: bound, reads };
}

/**
 * eth_getLogs over a planned search, in windows of BRIDGE_SEARCH_WINDOW_BLOCKS
 * from its first block forward; stops after the first window for which
 * `stopWhen` (given every log so far) is true.
 */
export async function searchPlannedLogs(
  readLogs: BridgeEventLogReader,
  plan: Pick<BridgeDestinationSearch, 'fromBlock' | 'toBlock'>,
  query: { chainId: number; address: string; topics: readonly (string | readonly string[] | null)[] },
  stopWhen?: (logs: readonly BridgeLog[]) => boolean,
): Promise<BridgeLog[]> {
  const out: BridgeLog[] = [];
  let start = plan.fromBlock;
  while (start <= plan.toBlock) {
    const end = start + BRIDGE_SEARCH_WINDOW_BLOCKS - 1n < plan.toBlock ? start + BRIDGE_SEARCH_WINDOW_BLOCKS - 1n : plan.toBlock;
    const logs = await readLogs({ ...query, fromBlock: start, toBlock: end });
    out.push(...logs);
    if (stopWhen && stopWhen(out)) break;
    start = end + 1n;
  }
  return out;
}

/** "2026-10-26 12:13 UTC" for a block timestamp. */
export function searchTimeText(timestamp: bigint): string {
  return `${new Date(Number(timestamp) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A span of seconds in words: minutes under two hours, else whole hours. */
export function searchSpanText(seconds: bigint): string {
  const s = seconds < 0n ? 0n : seconds;
  if (s < 7_200n) {
    const m = Number((s + 30n) / 60n);
    return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  }
  const h = Number((s + 1_800n) / 3_600n);
  return `${h} hours`;
}

/** "blocks A to B, from <time> to <time>", the part of a sentence that says what was searched. */
export function searchRangeText(search: BridgeDestinationSearch): string {
  return `blocks ${search.fromBlock} to ${search.toBlock}, from ${searchTimeText(search.fromTimestamp)} to ${searchTimeText(search.toTimestamp)}`;
}

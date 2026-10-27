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
 * JSON-RPC error code of a node that no longer serves the asked-for history:
 * reth answers 4444 (EthRpcErrorCode::PrunedHistory, named after EIP-4444)
 * with the message "pruned history unavailable: requested {requested},
 * earliest available {earliest_available}" — paradigmxyz/reth at
 * f1cc50e4fcb958ad18007c0fe7c0e49cb1f75e19 (main on 2026-10-27),
 * crates/rpc/rpc-eth-types/src/error/mod.rs lines 81–82 (the message),
 * 392–393 (the code mapping) and 1207–1214 (the test asserting 4444 and the
 * message). Observed live on 2026-10-27 from base-sepolia-rpc.publicnode.com
 * (requested 33554432, earliest available 46500000); which reth version that
 * endpoint runs was not read, and no JSON-RPC standard reserves 4444 (it is
 * a node's own code), so the check below requires BOTH the code and the
 * word "pruned".
 */
export const PRUNED_HISTORY_ERROR_CODE = 4444;

/**
 * True for an error that says the node refused a read because that history
 * is pruned: the JSON-RPC code PRUNED_HISTORY_ERROR_CODE (a numeric `code`
 * property, or the "RPC error 4444:" prefix the engine's httpTransport puts
 * in its message, rpc.ts) AND a message containing "pruned". Anything else —
 * a timeout, another code, 4444 without "pruned" — is not.
 */
export function isPrunedHistoryError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const message = typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : '';
  const code = (error as { code?: unknown }).code;
  const coded = code === PRUNED_HISTORY_ERROR_CODE || /(?:^|\b)RPC error 4444:/.test(message);
  return coded && /pruned/i.test(message);
}

/**
 * The first block reth's pruned-history message says is still available
 * ("…, earliest available 46500000"), or null. Only a hint: the search
 * reads that block before relying on it.
 */
export function prunedEarliestAvailable(error: unknown): bigint | null {
  const message = error !== null && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  if (typeof message !== 'string') return null;
  const m = /earliest available (\d{1,30})\b/.exec(message);
  return m ? BigInt(m[1]!) : null;
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
 *
 * A read the node refuses as pruned history (isPrunedHistoryError, phase 23
 * item 8, the hygiene slice) means the chain's reachable history on that
 * endpoint begins above that block. The search then looks for the oldest
 * block the endpoint still serves, between the refused block and the
 * oldest one it read (the message's "earliest available" block is read
 * first as a hint, then halving): if that block is still after the target,
 * the target lies in the pruned part and the answer is that oldest readable
 * block with `prunedBelow` set to its number, so the caller can say the
 * search could not start at the sending time; if a readable block at or
 * before the target is met on the way, the search goes on as usual. Any
 * other error is thrown as before.
 */
export async function findBlockAtOrBefore(
  readBlock: BridgeBlockReader,
  chainId: number,
  timestamp: bigint,
  head?: BridgeBlockHeader,
  cache?: BridgeSearchCache,
): Promise<{ block: BridgeBlockHeader; reads: number; prunedBelow?: bigint }> {
  let reads = 0;
  const top = head ?? (await readHeader(readBlock, chainId, 'latest'));
  if (head === undefined) reads += 1;
  if (top.timestamp <= timestamp) return { block: top, reads };
  const key = `${chainId}:${timestamp}`;
  const cached = cache?.get(key);
  if (cached && cached.number < top.number) return { block: cached, reads };
  let probes = 0;
  // The highest block the node refused as pruned, and the hint its message gave.
  let floor: bigint | null = null;
  let hint: bigint | null = null;
  // A read; null when the node refused it as pruned history (recorded in floor).
  const probe = async (n: bigint): Promise<BridgeBlockHeader | null> => {
    probes += 1;
    if (probes > BRIDGE_BLOCK_SEARCH_MAX_PROBES) throw new Error('The block search did not end within its limit.');
    reads += 1;
    try {
      return await readHeader(readBlock, chainId, n);
    } catch (e) {
      if (!isPrunedHistoryError(e)) throw e;
      if (floor === null || n > floor) floor = n;
      hint = prunedEarliestAvailable(e);
      return null;
    }
  };
  let hi = top; // readable, timestamp > target
  let above: BridgeBlockHeader | null = null; // a block after hi, for the local rate
  let lo: BridgeBlockHeader | null = null; // readable, timestamp <= target
  let step = BRIDGE_BLOCK_SEARCH_FIRST_STEP;
  for (;;) {
    // Walk back until a readable block at or before the target is found.
    while (lo === null) {
      if (hi.number === 0n) return { block: hi, reads };
      let n: bigint;
      if (floor !== null) {
        // Above a pruned block: the oldest readable block lies in (floor, hi].
        if (hi.number - floor <= 1n) return { block: hi, reads, prunedBelow: hi.number };
        const h0 = hint as bigint | null;
        n = h0 !== null && h0 > floor && h0 < hi.number ? h0 : floor + (hi.number - floor) / 2n;
        hint = null;
      } else {
        let back: bigint;
        if (above !== null && above.timestamp > hi.timestamp) {
          // Blocks per second from (hi, above), the distance to the target, plus a quarter.
          back = ((hi.timestamp - timestamp) * (above.number - hi.number) * 5n) / (4n * (above.timestamp - hi.timestamp)) + 1n;
        } else {
          back = step;
          step *= 2n;
        }
        n = hi.number > back ? hi.number - back : 0n;
      }
      const h = await probe(n);
      if (h === null) continue;
      if (h.timestamp <= timestamp) lo = h;
      else {
        above = hi;
        hi = h;
      }
    }
    // Narrow (lo, hi): interpolate, and bisect after an interpolation that did not halve the bracket.
    let bisect = false;
    let refused = false;
    while (hi.number - lo.number > 1n) {
      const width = hi.number - lo.number;
      let mid: bigint;
      if (!bisect && hi.timestamp > lo.timestamp) {
        mid = lo.number + ((timestamp - lo.timestamp) * width) / (hi.timestamp - lo.timestamp);
        if (mid <= lo.number) mid = lo.number + 1n;
        if (mid >= hi.number) mid = hi.number - 1n;
      } else mid = (lo.number + hi.number) >> 1n;
      const h = await probe(mid);
      if (h === null) {
        // The node pruned past lo while the search ran: lo is no longer
        // readable either, so look for the oldest readable block again.
        refused = true;
        break;
      }
      if (h.timestamp <= timestamp) lo = h;
      else hi = h;
      bisect = !bisect && (hi.number - lo.number) * 2n > width;
    }
    if (refused) {
      lo = null;
      continue;
    }
    if (cache && lo.number < top.number) cache.set(key, lo);
    return { block: lo, reads };
  }
}

/**
 * Plans the search of the receiving chain for a transfer sent at
 * `sinceTimestamp` (the sending block's timestamp): from the receiving
 * block at that time less the margin, to the head, or, when the head is
 * more than `boundSeconds` after the start block, to the receiving block at
 * the start block's time plus `boundSeconds` (found the same way, so the
 * span stated is the span searched). With a cache, a later pass for the
 * same transfer reads only the head. When the endpoint refuses the blocks
 * at the sending time as pruned history, the plan starts at the oldest
 * block it serves and carries `prunedBelow` (findBlockAtOrBefore).
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
  // The endpoint no longer serves the receiving chain's blocks from the
  // sending time: the plan starts at the oldest block it serves and says so.
  const pruned = found.prunedBelow !== undefined ? { prunedBelow: found.prunedBelow } : {};
  if (head.timestamp - start.timestamp <= bound || head.number <= start.number) {
    return { fromBlock: start.number, toBlock: head.number, fromTimestamp: start.timestamp, toTimestamp: head.timestamp, bounded: false, boundSeconds: bound, ...pruned, reads };
  }
  const end = await findBlockAtOrBefore(readBlock, request.chainId, start.timestamp + bound, head, request.cache);
  reads += end.reads;
  return { fromBlock: start.number, toBlock: end.block.number, fromTimestamp: start.timestamp, toTimestamp: end.block.timestamp, bounded: true, boundSeconds: bound, ...pruned, reads };
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

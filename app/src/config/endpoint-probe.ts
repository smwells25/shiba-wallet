// Explicit .ts extension: this module is loaded directly by Node scripts
// under type stripping (scripts/check-rpc-fallback.mjs, check-tokens.mjs,
// check-balances.mjs), which resolve relative specifiers literally. The
// import is type-only, so nothing from ./defaults.ts is evaluated here.
import type { NetworkDefault, NetworkKind } from './defaults.ts';

/**
 * Default-endpoint fallback: health probing and in-memory selection among a
 * chain's ordered list of keyless public default endpoints
 * (NetworkDefault.defaultUrls in ./defaults.ts).
 *
 * Why: a single dead default hostname used to blank that chain everywhere
 * (INFRA FINDING 2026-10-01 in AGENTS.md: ethereum-rpc.publicnode.com
 * failing its TLS handshake while ethereum.publicnode.com answered). Each
 * chain now ships several verified candidates, and the first one that
 * passes a short, chain-identity-verified probe is used.
 *
 * Rules this module enforces:
 *
 *  - A user override always wins and is never probed around
 *    (resolveNetworkUrl returns it untouched; the send flow's own chain-id
 *    check still guards it at quote time).
 *  - Candidates are probed strictly in their listed order, one at a time,
 *    each with a short timeout; the first healthy one is chosen.
 *  - "Healthy" means the endpoint answered AND identified itself as the
 *    expected chain. A candidate that answers for a different chain is
 *    never used, not even as a last resort, mirroring the chain-id refusal
 *    semantics of the send flow (send.ts) and the Settings save paths.
 *    The chain identity checks follow the CAIP-2 definitions of each
 *    namespace:
 *      eip155  - eth_chainId must equal the CAIP-2 reference
 *                (https://namespaces.chainagnostic.org/eip155/caip2);
 *      bip122  - the first 32 hex characters of the genesis block hash,
 *                read via Esplora GET /block-height/0
 *                (https://namespaces.chainagnostic.org/bip122/caip2;
 *                endpoint documented in
 *                https://github.com/Blockstream/esplora/blob/master/API.md);
 *      solana  - the first 32 characters of getGenesisHash
 *                (https://namespaces.chainagnostic.org/solana/caip2).
 *  - "Healthy" also means the endpoint's chain is not frozen: the newest
 *    block it reports must be no older than a per-namespace bound measured
 *    against the device clock (see "Freshness" below; finding F-66 in
 *    docs/THREAT_MODEL.md). A candidate that is behind is skipped like a
 *    wrong-chain one, but it may still be returned as a flagged last
 *    resort (see probeAll) because a wrong device clock makes every
 *    candidate look behind.
 *  - The choice is cached in memory only (never persisted) for the app
 *    session. reportFailure() drops a cached choice when a real request
 *    through it fails, so the next resolution probes again from the top of
 *    the list; a fresh app launch always starts from the primary again,
 *    which lets a recovered primary take over automatically.
 *  - When no candidate is healthy, the resolver still returns the first
 *    candidate that merely failed to answer (never a wrong-chain one), so
 *    requests fail with a visible, retryable network error instead of the
 *    chain silently looking "not configured". That unhealthy result is
 *    cached only briefly (failureRetryMs) so concurrent screens do not
 *    each wait through every timeout, and is re-probed after that.
 *
 * CALL-TIME FAILOVER (phase 9 item 5): runWithEndpointFailover at the end
 * of this file is the one rule every network-using path applies (through
 * config/networks.ts callWithFailover / withEndpoint): a request that fails
 * at the transport level through a DEFAULT endpoint is reported and
 * repeated once on the next healthy candidate; overrides are never probed
 * around.
 *
 * This module has no React Native imports so the Node scripts can run the
 * exact code the app runs against a fake fetch.
 */

/** The subset of fetch this module uses; injectable for offline tests. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type ProbeResult =
  | {
      ok: true;
      /**
       * Outcome of the freshness check (absent when it was switched off):
       * 'fresh' when the newest block is within the bound, 'unknown' when
       * the freshness request failed, timed out or returned something
       * unreadable. 'unknown' is accepted on purpose; see probeEndpoint.
       */
      freshness?: 'fresh' | 'unknown';
      /** Why the freshness is unknown, or the measured age; for diagnostics only. */
      freshnessDetail?: string;
    }
  | {
      ok: false;
      /**
       * 'unreachable': no usable answer; 'wrong-chain': answered as another
       * chain; 'stale': answered as the right chain, but its newest block is
       * older than the freshness bound (the chain it serves looks frozen).
       */
      kind: 'unreachable' | 'wrong-chain' | 'stale';
      reason: string;
      /** Only for 'stale': the newest block's timestamp, in Unix seconds. */
      headTimestamp?: number;
      /** Only for 'stale': how old that block was by the device clock, in seconds. */
      ageSeconds?: number;
    };

/** Per-candidate probe timeout. Short on purpose: a healthy RPC answers in well under a second. */
export const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

/** How long an all-candidates-failed result is reused before probing again. */
export const DEFAULT_FAILURE_RETRY_MS = 10_000;

// ---------------------------------------------------------------------------
// Freshness (finding F-66)
// ---------------------------------------------------------------------------
//
// Why: on 2026-10-09 the third Sepolia default (https://0xrpc.io/sep) was
// found stuck at block 11856335 (timestamp 1791294792, 24 seconds before the
// Glamsterdam activation) while reporting eth_syncing false. It still
// answered eth_chainId correctly, so the identity probe alone accepted it,
// and a balance, quote or simulation taken through it would have been
// silently out of date.
//
// What is checked: the newest block's own timestamp, compared with the
// device clock. A self-reported health or sync flag is NOT used, because
// the frozen endpoint above reported itself as synced. Per namespace:
//
//  eip155 (EVM): eth_getBlockByNumber("latest", false) and the block's
//    `timestamp` (a hex quantity, seconds since the Unix epoch). Method,
//    the "latest" tag and the field are defined in the Ethereum execution
//    API specification (github.com/ethereum/execution-apis, main at
//    34151926: src/eth/block.yaml and src/schemas/block.yaml).
//
//  bip122 (Esplora): GET /blocks, documented as "Returns the 10 newest
//    blocks starting at the tip", each in the block format whose fields
//    include `timestamp` (github.com/Blockstream/esplora, API.md at master
//    cfcb22c4). One request gives the tip's timestamp, where /blocks/tip/hash
//    followed by /block/:hash would need two in sequence. The newest
//    timestamp among the returned blocks is used, because Bitcoin block
//    timestamps are not strictly increasing.
//
//  solana: getSlot with commitment "finalized", then getBlockTime for that
//    slot (solana.com/docs/rpc/http/getslot and /getblocktime, fetched
//    2026-10-09). getBlockTime returns "Estimated production time, as Unix
//    timestamp", the stake-weighted mean of validators' vote timestamps; a
//    finalized slot always holds a block, and null ("no block time has been
//    recorded") counts as unknown. getHealth was not chosen: it is the
//    node's own judgement of whether it is behind, which is exactly the kind
//    of self-report that failed in F-66.
//
// The bounds below are JUDGEMENTS, not protocol constants. Each must
// tolerate a legitimately slow chain plus a device clock that is a minute or
// two off, while still catching an endpoint stuck for much longer:
//
//  eip155 600 s (10 minutes): Ethereum and Sepolia have 12-second slots,
//    Base and other OP-stack chains 2-second blocks, Arbitrum Sepolia about
//    0.25 seconds per block (measured in phase 14). Ten minutes is 50
//    Ethereum slots, far beyond any run of missed slots a healthy testnet
//    shows, and leaves room for a clock a minute or more off. The same bound
//    serves every EVM profile because the slowest one (12 s) sets it.
//
//  bip122 10,800 s (3 hours): Bitcoin targets one block per 10 minutes and
//    block discovery is random, so hour-long gaps occur; a block's timestamp
//    is only required to exceed the median of the previous 11 blocks and to
//    be below network time plus 2 hours, so "block times are accurate only
//    to within an hour or two" (en.bitcoin.it/wiki/Block_timestamp, fetched
//    2026-10-09). Three hours covers a long gap plus a timestamp that lags
//    real time; anything shorter would skip healthy endpoints.
//
//  solana 300 s (5 minutes): slots are about 400 ms and the finalized slot
//    trails the newest one (a read of api.mainnet.solana.com on 2026-10-09
//    gave a finalized block time about 5 s behind the device clock); five
//    minutes leaves room for the vote-based time estimate and a clock that
//    is off. During a cluster halt every candidate is stale at once, which
//    the last-resort rule in probeAll handles.
//
// A freshness request that ERRORS (method not supported, HTTP error, a
// malformed or null answer, or no answer before the probe's deadline) is NOT
// treated as stale: the result is 'unknown' and the candidate is accepted,
// because its chain identity was still proven and an endpoint that merely
// lacks one read method must not be skipped. Only a well-formed timestamp
// that is older than the bound marks a candidate stale. A timestamp AHEAD
// of the device clock (a clock that runs slow) is never stale.
//
// Budget: the freshness request is sent AFTER the identity request has
// proven the right chain, and both share the one per-candidate deadline
// (DEFAULT_PROBE_TIMEOUT_MS): the freshness read gets whatever is left of
// it, never a new timeout, so a candidate still costs at most 4 seconds.
// Sequential rather than parallel because (1) a candidate that is down or
// answers for another chain receives exactly the one request it received
// before this check existed, so nothing is asked of an endpoint the wallet
// will not use and the request pattern other code and checks rely on is
// unchanged; (2) keyless public endpoints rate-limit bursts (public.1rpc.io
// answered HTTP 400 to one of three sequential reads on 2026-10-09), and
// two simultaneous requests per candidate would add to that. The cost is
// one extra round trip for a healthy candidate, typically well under a
// second, paid once per session per chain because the choice is cached.

/** Freshness bounds per network kind, in seconds (judgements; see above). */
export const FRESHNESS_BOUND_SECONDS: Readonly<Record<Exclude<NetworkKind, 'blockbook'>, number>> = {
  'evm-jsonrpc': 600,
  esplora: 10_800,
  'solana-jsonrpc': 300,
};

/**
 * Pure freshness rule: a head block is stale when it is MORE than
 * `boundSeconds` older than the device clock (exactly at the bound is still
 * fresh). A head ahead of the clock gives a negative age and is fresh.
 */
export function assessHeadFreshness(
  headTimestampSeconds: number,
  nowMs: number,
  boundSeconds: number,
): { stale: boolean; ageSeconds: number } {
  const ageSeconds = nowMs / 1000 - headTimestampSeconds;
  return { stale: ageSeconds > boundSeconds, ageSeconds };
}

function caip2Reference(chainId: string): { namespace: string; reference: string } {
  const separator = chainId.indexOf(':');
  if (separator <= 0) throw new Error(`Not a CAIP-2 chain id: ${chainId}`);
  return { namespace: chainId.slice(0, separator), reference: chainId.slice(separator + 1) };
}

async function postJsonRpc(
  fetchFn: FetchLike,
  url: string,
  method: string,
  signal: AbortSignal | undefined,
  params: unknown[] = [],
): Promise<unknown> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = JSON.parse(await response.text()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC error: ${body.error.message ?? 'unknown'}`);
  return body.result;
}

/** A non-negative whole number of seconds that fits a JavaScript number exactly. */
function asUnixSeconds(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} is not a usable timestamp`);
  }
  return value;
}

/** The chain identity each namespace reports (compared with the CAIP-2 reference). */
async function readIdentity(
  kind: NetworkKind,
  fetchFn: FetchLike,
  base: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  switch (kind) {
    case 'evm-jsonrpc': {
      const result = await postJsonRpc(fetchFn, base, 'eth_chainId', signal);
      if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) {
        throw new Error('eth_chainId returned a malformed value');
      }
      return BigInt(result).toString();
    }
    case 'esplora': {
      const response = await fetchFn(`${base}/block-height/0`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const hash = (await response.text()).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('genesis block hash is malformed');
      return hash.slice(0, 32);
    }
    case 'solana-jsonrpc': {
      const result = await postJsonRpc(fetchFn, base, 'getGenesisHash', signal);
      if (typeof result !== 'string' || result.length < 32) {
        throw new Error('getGenesisHash returned a malformed value');
      }
      return result.slice(0, 32);
    }
    case 'blockbook':
      // Blockbook chains have no shipped defaults; their endpoint is
      // verified at save time in ../wallet/blockbook.ts instead.
      throw new Error('Blockbook endpoints are not probed');
  }
}

/**
 * The newest block's timestamp in Unix seconds, by the per-namespace method
 * documented under "Freshness" above. Throws for anything it cannot read;
 * the caller turns a throw into 'unknown', never into 'stale'.
 */
async function readHeadTimestamp(
  kind: NetworkKind,
  fetchFn: FetchLike,
  base: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  switch (kind) {
    case 'evm-jsonrpc': {
      const block = await postJsonRpc(fetchFn, base, 'eth_getBlockByNumber', signal, ['latest', false]);
      const timestamp = (block as { timestamp?: unknown } | null)?.timestamp;
      if (typeof timestamp !== 'string' || !/^0x[0-9a-fA-F]{1,13}$/.test(timestamp)) {
        throw new Error('eth_getBlockByNumber returned no readable timestamp');
      }
      return asUnixSeconds(Number(BigInt(timestamp)), 'the latest block timestamp');
    }
    case 'esplora': {
      const response = await fetchFn(`${base}/blocks`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blocks = JSON.parse(await response.text()) as unknown;
      if (!Array.isArray(blocks)) throw new Error('GET /blocks did not return a list');
      let newest = -1;
      for (const block of blocks) {
        const timestamp = (block as { timestamp?: unknown } | null)?.timestamp;
        if (typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp > newest) {
          newest = timestamp;
        }
      }
      return asUnixSeconds(newest, 'the newest Esplora block timestamp');
    }
    case 'solana-jsonrpc': {
      const slot = await postJsonRpc(fetchFn, base, 'getSlot', signal, [{ commitment: 'finalized' }]);
      if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0) {
        throw new Error('getSlot returned a malformed value');
      }
      const time = await postJsonRpc(fetchFn, base, 'getBlockTime', signal, [slot]);
      return asUnixSeconds(time, 'getBlockTime');
    }
    case 'blockbook':
      throw new Error('Blockbook endpoints are not probed');
  }
}

function errorText(e: unknown): string {
  // fetch implementations often wrap the real cause (TLS, DNS) in a
  // generic "fetch failed"; include its code when one is present.
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  const message = e instanceof Error ? e.message : String(e);
  return typeof cause === 'string' ? `${message} (${cause})` : message;
}

/** Options shared by probeEndpoint and the helpers that call it. */
export interface ProbeOptions {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  /** Device clock in milliseconds since the epoch; injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Set false to check chain identity only (default true). */
  checkFreshness?: boolean;
  /** Overrides FRESHNESS_BOUND_SECONDS for this probe (tests only). */
  freshnessBoundSeconds?: number;
}

const TIMED_OUT = Symbol('timed out');
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/**
 * Checks one endpoint: does it answer, is it the expected chain, and is
 * the chain it serves recent (see "Freshness" above)? Never throws; every
 * failure is reported in the result.
 *
 * Identity decides 'unreachable' / 'wrong-chain' exactly as before. Only
 * for the right chain is the freshness read sent, within what is left of
 * the same `timeoutMs` deadline; a missing or unreadable answer leaves the
 * candidate accepted with freshness 'unknown'.
 */
export async function probeEndpoint(
  kind: NetworkKind,
  url: string,
  chainId: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const { reference } = caip2Reference(chainId);
  const base = url.replace(/\/+$/, '');
  const checkFreshness = options.checkFreshness !== false && kind !== 'blockbook';
  const bound = options.freshnessBoundSeconds ?? (kind === 'blockbook' ? 0 : FRESHNESS_BOUND_SECONDS[kind]);

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const signal = controller?.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  // Each request is settled so that it can never become an unhandled
  // rejection after the deadline has decided the result, and is started
  // inside an async wrapper so that a fetch which throws synchronously is
  // caught too.
  const identity = settle((async () => readIdentity(kind, fetchFn, base, signal))());

  try {
    const id = await Promise.race([identity, expired]);
    if (id === TIMED_OUT) {
      return { ok: false, kind: 'unreachable', reason: `no answer within ${timeoutMs} ms` };
    }
    if (!id.ok) return { ok: false, kind: 'unreachable', reason: errorText(id.error) };

    const expected = kind === 'evm-jsonrpc' ? BigInt(reference).toString() : reference;
    if (id.value !== expected) {
      return {
        ok: false,
        kind: 'wrong-chain',
        reason: `endpoint identifies as ${id.value}, expected ${expected}`,
      };
    }
    if (!checkFreshness) return { ok: true };

    const freshness = settle((async () => readHeadTimestamp(kind, fetchFn, base, signal))());
    const head = await Promise.race([freshness, expired]);
    if (head === TIMED_OUT) {
      return { ok: true, freshness: 'unknown', freshnessDetail: `no head block within ${timeoutMs} ms` };
    }
    if (!head.ok) return { ok: true, freshness: 'unknown', freshnessDetail: errorText(head.error) };
    const { stale, ageSeconds } = assessHeadFreshness(head.value, now(), bound);
    const age = Math.round(ageSeconds);
    if (stale) {
      return {
        ok: false,
        kind: 'stale',
        reason: `the newest block is ${age} s old (timestamp ${head.value}), more than the ${bound} s allowed`,
        headTimestamp: head.value,
        ageSeconds,
      };
    }
    return { ok: true, freshness: 'fresh', freshnessDetail: `newest block ${age} s old` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Cancels whichever request is still open (a no-op for finished ones).
    controller?.abort();
  }
}

/** Which default candidate is in use for one chain, and why. */
export interface DefaultChoice {
  /**
   * The candidate to use. When no candidate passed its probe this is the
   * first candidate that merely failed to answer (so requests surface a
   * real, retryable error); null only when the list is empty or every
   * candidate answered as the wrong chain.
   */
  url: string | null;
  /** 0-based position of `url` in the candidate list, or -1 when url is null. */
  index: number;
  /** Number of default candidates for the chain. */
  total: number;
  /** True when `url` passed the chain-verified probe (identity and freshness). */
  healthy: boolean;
  /** True when the first-listed (primary) candidate failed its probe in this pass. */
  primaryUnreachable: boolean;
  /** The primary's probe failure, for display/diagnostics. */
  primaryFailure?: string;
  /** How the primary failed (absent when it passed or when nothing was probed). */
  primaryFailureKind?: 'unreachable' | 'wrong-chain' | 'stale';
  /**
   * True when `url` is a last-resort candidate that answered as the right
   * chain but failed the freshness check (healthy is then false). See
   * probeAll for when this happens.
   */
  stale?: boolean;
}

export interface DefaultEndpointResolver {
  /** The current choice for this network, probing when nothing usable is cached. */
  resolve(network: NetworkDefault): Promise<DefaultChoice>;
  /**
   * Reports that a real request through `url` failed for `chainId` (the
   * network's own CAIP-2 id). Drops the cached choice when it is that URL,
   * so the next resolve() probes again. Returns true when it dropped one.
   */
  reportFailure(chainId: string, url: string): boolean;
  /** The cached choice without probing (undefined when none is cached). */
  peek(chainId: string): DefaultChoice | undefined;
  /** Forgets every cached choice. */
  clear(): void;
}

export interface DefaultEndpointResolverOptions {
  /** Defaults to the global fetch, read at probe time. */
  fetchFn?: FetchLike;
  timeoutMs?: number;
  failureRetryMs?: number;
  /**
   * Clock, injectable for tests. Used for the cache timing and, as the
   * device clock, for the probe's freshness check.
   */
  now?: () => number;
}

export function createDefaultEndpointResolver(
  options: DefaultEndpointResolverOptions = {},
): DefaultEndpointResolver {
  const failureRetryMs = options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { choice: DefaultChoice; at: number }>();
  const inFlight = new Map<string, Promise<DefaultChoice>>();

  /**
   * Probes the candidates in order and returns the first healthy one.
   *
   * When none is healthy, a last resort is returned flagged unhealthy:
   *  1. the STALE candidate with the newest head block, when any candidate
   *     answered as the right chain but failed only the freshness check.
   *     Reasons: a device clock that is wrong by more than the bound makes
   *     EVERY candidate look stale, and a halted chain does the same; in
   *     both cases refusing them all would blank the chain, while the newest
   *     head among them is the best data available (a frozen endpoint, being
   *     older, loses to any live one). The choice carries stale: true, the
   *     Settings note says balances may be out of date, and like every
   *     unhealthy result it is re-probed after failureRetryMs;
   *  2. otherwise the first candidate that merely failed to answer, so
   *     requests fail with a visible, retryable error;
   *  3. never a wrong-chain candidate (url null when nothing else is left).
   * Known limit of rule 1: if every live candidate is unreachable at that
   * moment and only a frozen one answers, the frozen one is used (flagged)
   * until the next probe.
   */
  async function probeAll(network: NetworkDefault): Promise<DefaultChoice> {
    const candidates = network.defaultUrls;
    const total = candidates.length;
    let primaryFailure: string | undefined;
    let primaryFailureKind: DefaultChoice['primaryFailureKind'];
    let firstUnreachable = -1;
    let newestStale: { index: number; headTimestamp: number } | undefined;
    const primaryFields = () => ({
      ...(primaryFailure !== undefined ? { primaryFailure } : {}),
      ...(primaryFailureKind !== undefined ? { primaryFailureKind } : {}),
    });
    for (let i = 0; i < total; i += 1) {
      const result = await probeEndpoint(network.kind, candidates[i], network.chainId, {
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
        now: options.now,
      });
      if (result.ok) {
        return {
          url: candidates[i],
          index: i,
          total,
          healthy: true,
          primaryUnreachable: i > 0,
          ...primaryFields(),
        };
      }
      if (i === 0) {
        primaryFailure = result.reason;
        primaryFailureKind = result.kind;
      }
      if (result.kind === 'unreachable' && firstUnreachable === -1) firstUnreachable = i;
      if (result.kind === 'stale') {
        const headTimestamp = result.headTimestamp ?? -1;
        if (newestStale === undefined || headTimestamp > newestStale.headTimestamp) {
          newestStale = { index: i, headTimestamp };
        }
      }
    }
    if (newestStale !== undefined) {
      return {
        url: candidates[newestStale.index],
        index: newestStale.index,
        total,
        healthy: false,
        primaryUnreachable: total > 0,
        stale: true,
        ...primaryFields(),
      };
    }
    return {
      url: firstUnreachable >= 0 ? candidates[firstUnreachable] : null,
      index: firstUnreachable,
      total,
      healthy: false,
      primaryUnreachable: total > 0,
      ...primaryFields(),
    };
  }

  return {
    resolve(network) {
      const key = network.chainId;
      const cached = cache.get(key);
      if (cached && (cached.choice.healthy || now() - cached.at < failureRetryMs)) {
        return Promise.resolve(cached.choice);
      }
      const pending = inFlight.get(key);
      if (pending) return pending;
      const probe = probeAll(network)
        .then((choice) => {
          cache.set(key, { choice, at: now() });
          return choice;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, probe);
      return probe;
    },
    reportFailure(chainId, url) {
      const cached = cache.get(chainId);
      if (cached && cached.choice.url === url) {
        cache.delete(chainId);
        return true;
      }
      return false;
    },
    peek(chainId) {
      return cache.get(chainId)?.choice;
    },
    clear() {
      cache.clear();
    },
  };
}

/** The URL a network should use right now, given the user's override (if any). */
export interface ResolvedNetworkUrl {
  url: string | null;
  isOverride: boolean;
  /** Present only when a default was chosen (no override). */
  defaultChoice?: DefaultChoice;
}

/**
 * Applies the override-wins rule: a user override is returned as is and
 * NOTHING is probed; otherwise the resolver picks among the defaults.
 */
export async function resolveNetworkUrl(
  network: NetworkDefault,
  override: string | undefined,
  resolver: DefaultEndpointResolver,
): Promise<ResolvedNetworkUrl> {
  if (override !== undefined) return { url: override, isOverride: true };
  if (network.defaultUrls.length === 0) return { url: null, isOverride: false };
  const defaultChoice = await resolver.resolve(network);
  return { url: defaultChoice.url, isOverride: false, defaultChoice };
}

/** Host part of an http(s) URL without relying on a URL polyfill. */
export function endpointHost(url: string): string {
  const match = /^https?:\/\/([^/?#:]+)/i.exec(url);
  return match ? match[1] : url;
}

/**
 * Settings tag text, e.g. "default (2 of 2: ethereum.publicnode.com)", or
 * "default (3 of 4: 0xrpc.io, behind the chain)" for a stale last resort.
 */
export function describeDefaultChoice(choice: DefaultChoice): string {
  if (choice.url === null || choice.index < 0) return 'default';
  const behind = choice.stale === true ? ', behind the chain' : '';
  return `default (${choice.index + 1} of ${choice.total}: ${endpointHost(choice.url)}${behind})`;
}

/**
 * Plain-language Settings note when the primary default is not the one in
 * use (or nothing answered), else null.
 */
export function describeDefaultFallbackNote(
  choice: DefaultChoice,
  candidates: readonly string[],
): string | null {
  if (!choice.primaryUnreachable || candidates.length === 0) return null;
  const primary = endpointHost(candidates[0]);
  if (!choice.healthy && choice.stale === true && choice.url !== null) {
    return (
      `None of the ${choice.total} default endpoints passed the last check. ` +
      `The one in use (${endpointHost(choice.url)}) answers, but its newest block ` +
      'looked older than expected, so balances and quotes may be out of date. ' +
      "If this phone's date and time are wrong, correcting them fixes this; " +
      'otherwise you can set a custom endpoint with Edit.'
    );
  }
  if (!choice.healthy) {
    return (
      `None of the ${choice.total} default endpoints answered the last check ` +
      `(the primary is ${primary}). Requests may fail until one recovers; ` +
      'you can set a custom endpoint with Edit.'
    );
  }
  if (choice.primaryFailureKind === 'stale') {
    return (
      `The primary default (${primary}) is behind the chain right now (its ` +
      'newest block is older than expected), so a fallback default is in use. ' +
      'The primary is tried again on the next app launch or whenever the ' +
      'fallback fails.'
    );
  }
  return (
    `The primary default (${primary}) is unreachable right now, so a ` +
    'fallback default is in use. The primary is tried again on the next ' +
    'app launch or whenever the fallback fails.'
  );
}

// ---------------------------------------------------------------------------
// Call-time failover (phase 9 item 5)
// ---------------------------------------------------------------------------

/**
 * The parts of a resolved endpoint the failover runner needs. NetworkEndpoint
 * in ./networks.ts satisfies it; the runner is generic so the offline checks
 * can drive it with plain objects.
 */
export interface FailoverTarget {
  url: string | null;
  isOverride: boolean;
  defaultChoice?: DefaultChoice;
  network: { chainId: string };
}

/** A target whose URL is known to be set. */
export type WithUrl<E extends FailoverTarget> = E & { url: string };

/** What a failover-wrapped call produced, and through which endpoint. */
export interface FailoverOutcome<E extends FailoverTarget, T> {
  value: T;
  /** The endpoint that answered (the second candidate when `switched`). */
  endpoint: WithUrl<E>;
  /** True when the first endpoint failed and the call was repeated on another one. */
  switched: boolean;
}

export interface FailoverDeps<E extends FailoverTarget> {
  /** Resolves the chain's endpoint again (after the failure was reported). */
  reResolve: () => Promise<E | undefined>;
  /** Reports a failed request (networks.ts reportEndpointFailure). */
  report: (networkChainId: string, url: string) => boolean;
  /** Which errors count as "the endpoint failed" (default: isEndpointFailure). */
  isFailure?: (error: unknown) => boolean;
}

/** HTTP statuses that say "this endpoint cannot serve you right now". */
function isEndpointHttpStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

/**
 * Decides whether an error means the ENDPOINT failed (so another default
 * candidate might succeed) rather than that the endpoint answered and the
 * answer was unwelcome. Deliberately conservative: only transport-level
 * failures and explicit rate limiting count.
 *
 * Counted as endpoint failures:
 *  - fetch rejections: React Native's fetch throws TypeError("Network
 *    request failed"), Node's undici TypeError("fetch failed");
 *  - aborts and timeouts;
 *  - SyntaxError (an HTML error page where JSON was expected);
 *  - an HTTP status in the engine transports' messages ("RPC HTTP error
 *    503 for eth_call", "UTXO fetch failed: HTTP 502 …") that signals an
 *    unavailable or refusing service: 401, 403, 404, 408, 425, 429, 5xx;
 *  - JSON-RPC rate limiting: code -32005 or wording such as "rate limit"
 *    or "too many requests".
 *
 * NOT counted (the endpoint answered): reverts, "insufficient funds",
 * other JSON-RPC errors (including archive-depth refusals, which
 * token-history.ts and approvals.ts report verbatim as a depth limit),
 * HTTP 400, and every error the app's own code throws after reading an
 * answer. Retrying those elsewhere would only repeat the same answer.
 */
export function isEndpointFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const e = error as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (error instanceof SyntaxError) return true;
  if (error instanceof TypeError && /network request failed|fetch failed|failed to fetch|load failed/i.test(message)) {
    return true;
  }
  if (/\b(timed out|timeout|aborted)\b/i.test(message)) return true;
  if (e.code === -32005) return true;
  if (/RPC error -32005\b/.test(message)) return true;
  if (/rate.?limit|too many requests/i.test(message)) return true;
  const http = /\bHTTP (?:error )?(\d{3})\b/.exec(message);
  if (http && isEndpointHttpStatus(Number(http[1]))) return true;
  return false;
}

/**
 * Runs `operation` against `endpoint`; when it fails with an endpoint
 * failure on a DEFAULT endpoint, reports the failure (which drops the
 * cached choice), resolves the chain again and repeats the operation ONCE
 * on the newly chosen candidate — only when that candidate is a different
 * URL that passed its chain-identity probe. Every other case surfaces the
 * original error unchanged:
 *
 *  - a user override is never probed around and never reported (rule
 *    shared with resolveNetworkUrl above);
 *  - errors that are answers, not failures (see isEndpointFailure);
 *  - the re-resolution lands on the same URL, on an unhealthy candidate, on
 *    an override, or on a different network (the Sepolia toggle flipped
 *    mid-call);
 *  - the retry itself fails (its failure is reported too, so the next call
 *    probes again, but there is no third attempt).
 *
 * The operation receives the endpoint it runs against and must build
 * everything from it (a quote prepared on the second candidate is entirely
 * that candidate's answer; nothing from the failed attempt is reused). The
 * outcome names the endpoint that answered so callers can pin it.
 */
export async function runWithEndpointFailover<E extends FailoverTarget, T>(
  endpoint: WithUrl<E>,
  operation: (endpoint: WithUrl<E>) => Promise<T>,
  deps: FailoverDeps<E>,
): Promise<FailoverOutcome<E, T>> {
  const isFailure = deps.isFailure ?? isEndpointFailure;
  try {
    return { value: await operation(endpoint), endpoint, switched: false };
  } catch (error) {
    if (endpoint.isOverride || !endpoint.defaultChoice) throw error;
    if (!isFailure(error)) throw error;
    deps.report(endpoint.network.chainId, endpoint.url);
    let next: E | undefined;
    try {
      next = await deps.reResolve();
    } catch {
      throw error;
    }
    if (
      !next ||
      next.url === null ||
      next.isOverride ||
      next.defaultChoice?.healthy !== true ||
      next.network.chainId !== endpoint.network.chainId ||
      next.url === endpoint.url
    ) {
      throw error;
    }
    const second = next as WithUrl<E>;
    try {
      return { value: await operation(second), endpoint: second, switched: true };
    } catch (retryError) {
      if (isFailure(retryError)) deps.report(second.network.chainId, second.url);
      throw retryError;
    }
  }
}

// ---------------------------------------------------------------------------
// User-facing endpoint error text (phase 11 item 6 follow-ups F4 and F9)
// ---------------------------------------------------------------------------

/** Longest technical detail shown to a user; anything longer is cut with "…". */
export const ENDPOINT_MESSAGE_MAX_LENGTH = 200;

/**
 * Reduces an endpoint's error text to what a user can act on, for display
 * only (the raw text is never changed where it is recorded):
 *
 *  - the JSON-RPC error code is kept ("JSON-RPC error -32602: …"), taken
 *    from `code` or from the engine's "RPC error <code>: <message> (<method>)"
 *    wording;
 *  - Java / Kotlin exception class names that React Native's Android
 *    networking puts in front of a message ("java.net.UnknownHostException:")
 *    are removed: the class name means nothing to a user;
 *  - everything from "Get one at" onwards is dropped, and so is every URL:
 *    providers append advertisements to their refusals (publicnode's
 *    archive refusal ends "Get one at: https://www.allnodes.com/publicnode",
 *    live probe 2026-10-02 recorded in ../wallet/token-history.ts), and the
 *    wallet does not show third-party advertising;
 *  - only the first sentence is kept, ended with a full stop, and the
 *    result is capped at ENDPOINT_MESSAGE_MAX_LENGTH characters.
 *
 * Returns '' when nothing readable is left.
 */
export function sanitizeEndpointMessage(raw: string, code?: number): string {
  let text = String(raw ?? '');
  let foundCode = code;
  const rpc = /^\s*RPC error (-?\d+|\?):\s*/.exec(text);
  if (rpc) {
    if (foundCode === undefined && rpc[1] !== '?') foundCode = Number(rpc[1]);
    text = text.slice(rpc[0].length);
  }
  // A trailing "(eth_getLogs)" method tag from the engine transports.
  text = text.replace(/\s*\((?:eth|net|web3|alchemy|pimlico|rundler|wallet)_[A-Za-z0-9_]+\)\s*$/, '');
  // Java / Kotlin exception class prefixes, e.g. "java.net.SocketTimeoutException: ".
  text = text.replace(/\b(?:[a-z_][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error)\b:?\s*/g, '');
  // Advertisements and links.
  text = text.replace(/\bget (?:one|a key|yours|it) (?:at|from)\b[\s\S]*$/i, '');
  text = text.replace(/\b(?:https?|wss?):\/\/\S+/gi, '');
  text = text.replace(/\bwww\.\S+/gi, '');
  text = text.replace(/\s+/g, ' ').trim();
  // First sentence only: a full stop, question or exclamation mark
  // followed by a space ends it (dots inside host names do not).
  const end = /[.!?](?=\s)/.exec(text);
  if (end) text = text.slice(0, end.index + 1);
  text = text.replace(/[\s:;,–—-]+$/, '').trim();
  if (text !== '' && !/[.!?]$/.test(text)) text += '.';
  if (text.length > ENDPOINT_MESSAGE_MAX_LENGTH) {
    text = `${text.slice(0, ENDPOINT_MESSAGE_MAX_LENGTH - 1).trimEnd()}…`;
  }
  if (foundCode !== undefined && Number.isFinite(foundCode)) {
    return text === '' ? `JSON-RPC error ${foundCode}.` : `JSON-RPC error ${foundCode}: ${text}`;
  }
  return text;
}

/** The plain sentence shown when a request got no answer at all. */
export const NO_ANSWER_SENTENCE =
  'The request got no answer from the network endpoint. This usually means the phone has no ' +
  'internet connection right now, or the endpoint is down.';

/**
 * A calm sentence for a failed network read (pure; ../wallet/connectivity.ts
 * describeNetworkError wraps it for the screens):
 *  - title: one sentence naming `what` could not be loaded;
 *  - detail: a plain sentence — never raw exception text. For a
 *    transport-level failure (isEndpointFailure) it is NO_ANSWER_SENTENCE;
 *    for an answer from the endpoint it is the endpoint's first sentence,
 *    cleaned by sanitizeEndpointMessage;
 *  - technical: the cleaned raw text for a muted, accessible detail line,
 *    or null when it would only repeat `detail` or nothing readable is left.
 */
export function describeNetworkFailure(
  error: unknown,
  what: string,
): { title: string; detail: string; technical: string | null } {
  const raw = error instanceof Error ? error.message : String(error);
  const code =
    error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'number'
      ? ((error as { code: number }).code)
      : undefined;
  const technical = sanitizeEndpointMessage(raw, code);
  if (isEndpointFailure(error)) {
    return {
      title: `Could not reach the network endpoint, so ${what} could not be loaded. Check your connection and try again.`,
      detail: NO_ANSWER_SENTENCE,
      technical: technical === '' ? null : technical,
    };
  }
  return {
    title: `${what.charAt(0).toUpperCase()}${what.slice(1)} could not be loaded.`,
    detail: technical === '' ? 'The endpoint answered with an error.' : technical,
    technical: null,
  };
}

// ---------------------------------------------------------------------------
// Another default candidate for a deeper read (phase 11 item 6 follow-up F4)
// ---------------------------------------------------------------------------

/**
 * The OTHER default candidates of a network, in the order to try them for a
 * read the current one refused (for example older logs): the candidates
 * listed after `currentUrl` first, then the ones before it. Empty when the
 * current endpoint is a user override (overrides are never worked around:
 * the user chose that endpoint) or when the network has no other default.
 */
export function otherDefaultCandidates(
  defaultUrls: readonly string[],
  currentUrl: string | null,
  isOverride: boolean,
): string[] {
  if (isOverride) return [];
  const index = currentUrl === null ? -1 : defaultUrls.indexOf(currentUrl);
  const after = defaultUrls.slice(index + 1);
  const before = index > 0 ? defaultUrls.slice(0, index) : [];
  return [...after, ...before].filter((u) => u !== currentUrl);
}

/**
 * The first of otherDefaultCandidates that passes the same chain-identity
 * and freshness probe as the default choice (probeEndpoint), or null. Used
 * only for READ-ONLY searches of chain history; quotes and sends never move
 * to it.
 */
export async function findAlternateDefaultUrl(
  network: Pick<NetworkDefault, 'kind' | 'chainId' | 'defaultUrls'>,
  currentUrl: string | null,
  isOverride: boolean,
  options: ProbeOptions = {},
): Promise<string | null> {
  for (const candidate of otherDefaultCandidates(network.defaultUrls, currentUrl, isOverride)) {
    const result = await probeEndpoint(network.kind, candidate, network.chainId, options);
    if (result.ok) return candidate;
  }
  return null;
}

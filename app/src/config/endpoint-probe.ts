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
  | { ok: true }
  | {
      ok: false;
      /** 'unreachable': no usable answer; 'wrong-chain': answered as another chain. */
      kind: 'unreachable' | 'wrong-chain';
      reason: string;
    };

/** Per-candidate probe timeout. Short on purpose: a healthy RPC answers in well under a second. */
export const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

/** How long an all-candidates-failed result is reused before probing again. */
export const DEFAULT_FAILURE_RETRY_MS = 10_000;

function caip2Reference(chainId: string): { namespace: string; reference: string } {
  const separator = chainId.indexOf(':');
  if (separator <= 0) throw new Error(`Not a CAIP-2 chain id: ${chainId}`);
  return { namespace: chainId.slice(0, separator), reference: chainId.slice(separator + 1) };
}

/** Runs `operation` with an overall deadline, aborting the request on expiry. */
async function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`no answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller?.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function postJsonRpc(
  fetchFn: FetchLike,
  url: string,
  method: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = JSON.parse(await response.text()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`RPC error: ${body.error.message ?? 'unknown'}`);
  return body.result;
}

/**
 * Checks one endpoint: does it answer, and is it the expected chain?
 * Never throws; every failure is reported in the result.
 */
export async function probeEndpoint(
  kind: NetworkKind,
  url: string,
  chainId: string,
  options: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const { reference } = caip2Reference(chainId);
  const base = url.replace(/\/+$/, '');

  let observed: string;
  try {
    observed = await withDeadline(timeoutMs, async (signal) => {
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
    });
  } catch (e) {
    // fetch implementations often wrap the real cause (TLS, DNS) in a
    // generic "fetch failed"; include its code when one is present.
    const cause = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      kind: 'unreachable',
      reason: typeof cause === 'string' ? `${message} (${cause})` : message,
    };
  }

  const expected = kind === 'evm-jsonrpc' ? BigInt(reference).toString() : reference;
  if (observed !== expected) {
    return {
      ok: false,
      kind: 'wrong-chain',
      reason: `endpoint identifies as ${observed}, expected ${expected}`,
    };
  }
  return { ok: true };
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
  /** True when `url` passed the chain-verified probe. */
  healthy: boolean;
  /** True when the first-listed (primary) candidate failed its probe in this pass. */
  primaryUnreachable: boolean;
  /** The primary's probe failure, for display/diagnostics. */
  primaryFailure?: string;
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
  /** Clock, injectable for tests. */
  now?: () => number;
}

export function createDefaultEndpointResolver(
  options: DefaultEndpointResolverOptions = {},
): DefaultEndpointResolver {
  const failureRetryMs = options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, { choice: DefaultChoice; at: number }>();
  const inFlight = new Map<string, Promise<DefaultChoice>>();

  async function probeAll(network: NetworkDefault): Promise<DefaultChoice> {
    const candidates = network.defaultUrls;
    const total = candidates.length;
    let primaryFailure: string | undefined;
    let firstUnreachable = -1;
    for (let i = 0; i < total; i += 1) {
      const result = await probeEndpoint(network.kind, candidates[i], network.chainId, {
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
      });
      if (result.ok) {
        return {
          url: candidates[i],
          index: i,
          total,
          healthy: true,
          primaryUnreachable: i > 0,
          ...(primaryFailure !== undefined ? { primaryFailure } : {}),
        };
      }
      if (i === 0) primaryFailure = result.reason;
      if (result.kind === 'unreachable' && firstUnreachable === -1) firstUnreachable = i;
    }
    return {
      url: firstUnreachable >= 0 ? candidates[firstUnreachable] : null,
      index: firstUnreachable,
      total,
      healthy: false,
      primaryUnreachable: total > 0,
      ...(primaryFailure !== undefined ? { primaryFailure } : {}),
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

/** Settings tag text, e.g. "default (2 of 2: ethereum.publicnode.com)". */
export function describeDefaultChoice(choice: DefaultChoice): string {
  if (choice.url === null || choice.index < 0) return 'default';
  return `default (${choice.index + 1} of ${choice.total}: ${endpointHost(choice.url)})`;
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
  if (!choice.healthy) {
    return (
      `None of the ${choice.total} default endpoints answered the last check ` +
      `(the primary is ${primary}). Requests may fail until one recovers; ` +
      'you can set a custom endpoint with Edit.'
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

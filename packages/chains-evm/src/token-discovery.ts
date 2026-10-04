import { toChecksumAddress } from '@shiba-wallet/core';
import { toBytes } from './encoding.js';
import type { JsonRpcTransport } from './rpc.js';

/**
 * Token discovery: which ERC-20 contracts hold a balance for an address,
 * through an indexer endpoint that serves the `alchemy_getTokenBalances`
 * method (Alchemy's Token API; the method name is vendor-coined, but any
 * endpoint that implements it works — the provider takes an injected
 * transport and hardcodes no vendor URL, ADR D5).
 *
 * Request and response shapes verified 2026-10-04 against the official
 * reference and live read-only probes:
 *   https://www.alchemy.com/docs/data/token-api/token-api-endpoints/alchemy-get-token-balances
 *   (markdown form of the same page with its OpenRPC specification; the
 *    older URL www.alchemy.com/docs/reference/alchemy-gettokenbalances
 *    serves the same reference)
 *   https://www.alchemy.com/docs/reference/token-api-overview ("Returns
 *    ERC20 token balances for all tokens the given address has ever
 *    transacted in with. Optionally accepts a list of contracts.")
 *
 * Documented facts this module relies on:
 *  - Params, positional: [address, tokenSpec, options]. tokenSpec is the
 *    string "erc20", "NATIVE_TOKEN", "DEFAULT_TOKENS" (deprecated) or an
 *    array of contract addresses; this module always sends "erc20" (every
 *    ERC-20 the address has interacted with). options is
 *    { pageKey?: string, maxCount?: integer } with maxCount "capped at 100"
 *    (default 100).
 *  - Result: { address, tokenBalances: [{ contractAddress, tokenBalance,
 *    error }] }. tokenBalance is a "Hex-encoded string of the token
 *    balance, or null if error is present", and "Exactly one of
 *    tokenBalance or error is non-null".
 *
 * Observed live (2026-10-04) but NOT in the documented result schema, so
 * the parser treats it defensively:
 *  - `pageKey` appears in the result when more balances exist (it was the
 *    last contract address of the page) and is absent on the last page;
 *    passing it back as options.pageKey returned the next page.
 *  - Zero balances are included (the documented example shows one too):
 *    an address that once held a token keeps a 0x00…00 entry. Callers that
 *    want only holdings filter with `balance > 0n`.
 *  - Addresses come back lower-case; tokenBalance was always a 32-byte
 *    (64 hex digit) word.
 *  - maxCount above 100 was accepted without an error (150 returned all 27
 *    entries of the probe address); this module never asks for more than
 *    the documented cap anyway.
 *
 * PRECISION: balances are parsed from the hex string straight into bigint.
 * A value longer than 64 hex digits is not a uint256 and is rejected for
 * that entry, never truncated. Nothing here passes through a JS number.
 *
 * WHAT THIS DOES NOT DO: it reports contract addresses and raw balances
 * only. Token metadata (symbol, name, decimals) must come from the chain
 * itself (the app reads symbol()/name()/decimals() with eth_call), because
 * the vendor's alchemy_getTokenMetadata answered a plain address with
 * {"decimals":0,"name":"","symbol":""} in the live probe rather than an
 * error, and a discovery list must never present guessed metadata.
 */

/** The documented per-call cap on maxCount. */
export const TOKEN_BALANCES_MAX_PAGE_SIZE = 100;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A uint256 as hex: 1 to 64 digits after 0x. */
const UINT256_HEX = /^0x[0-9a-fA-F]{1,64}$/;

/** One discovered token contract and its exact balance. */
export interface DiscoveredTokenBalance {
  /** Token contract, EIP-55 checksummed. */
  contract: string;
  /** Exact balance in the token's base units. */
  balance: bigint;
}

/** One entry the indexer could not answer for, or answered malformed. */
export interface DiscoveryEntryFailure {
  /** Contract address when one was readable (EIP-55), else null. */
  contract: string | null;
  reason: string;
}

export interface TokenDiscoveryPage {
  /** Every well-formed entry of this page, zero balances included. */
  balances: DiscoveredTokenBalance[];
  /** Entries with an indexer-side error or a malformed shape. */
  failures: DiscoveryEntryFailure[];
  /** Cursor for the next page, or null when this was the last one. */
  nextCursor: string | null;
}

export interface TokenBalanceDiscoveryProvider {
  /** One page of the owner's ERC-20 balances. */
  page(owner: string, options?: { cursor?: string; pageSize?: number }): Promise<TokenDiscoveryPage>;
}

/**
 * Thrown when the endpoint does not serve the method at all (JSON-RPC
 * -32601, or an "unsupported method" / "method not found" message as some
 * providers answer with HTTP 400 and -32600). The app turns it into a
 * plain "this indexer does not offer token discovery" note.
 */
export class TokenDiscoveryUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenDiscoveryUnsupportedError';
  }
}

/** True for an error that means "this endpoint does not serve the method". */
export function isMethodUnsupportedError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === -32601) return true;
  const message = e instanceof Error ? e.message : String(e);
  return /-32601|unsupported method|method not found|method .{0,80} does not exist/i.test(message);
}

function checksum(address: string): string {
  return toChecksumAddress(toBytes(address.toLowerCase()));
}

/**
 * Parses one documented result object. Throws on a top-level shape that is
 * not the documented one, or when the answer names a different address
 * than the one asked about; malformed entries are reported per entry.
 */
export function parseTokenBalancesResult(result: unknown, owner: string): TokenDiscoveryPage {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('alchemy_getTokenBalances returned no result object.');
  }
  const r = result as { address?: unknown; tokenBalances?: unknown; pageKey?: unknown };
  if (!Array.isArray(r.tokenBalances)) {
    throw new Error('alchemy_getTokenBalances returned no tokenBalances array.');
  }
  if (typeof r.address === 'string' && r.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `The indexer answered for ${r.address}, not for ${owner}; the answer was discarded.`,
    );
  }
  const balances: DiscoveredTokenBalance[] = [];
  const failures: DiscoveryEntryFailure[] = [];
  for (const raw of r.tokenBalances as unknown[]) {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as {
      contractAddress?: unknown;
      tokenBalance?: unknown;
      error?: unknown;
    };
    const contract =
      typeof entry.contractAddress === 'string' && ADDRESS.test(entry.contractAddress)
        ? checksum(entry.contractAddress)
        : null;
    if (contract === null) {
      failures.push({ contract: null, reason: 'The entry has no valid contract address.' });
      continue;
    }
    const hasError = entry.error !== undefined && entry.error !== null;
    const hasBalance = entry.tokenBalance !== undefined && entry.tokenBalance !== null;
    if (hasError) {
      // Documented: exactly one of tokenBalance or error is non-null. An
      // entry that carries both is not trusted for its balance either.
      const text =
        typeof entry.error === 'string'
          ? entry.error
          : typeof (entry.error as { message?: unknown }).message === 'string'
            ? (entry.error as { message: string }).message
            : 'the indexer reported an error for this token';
      failures.push({ contract, reason: text.slice(0, 200) });
      continue;
    }
    if (!hasBalance || typeof entry.tokenBalance !== 'string' || !UINT256_HEX.test(entry.tokenBalance)) {
      failures.push({ contract, reason: 'The balance is not a hex uint256.' });
      continue;
    }
    balances.push({ contract, balance: BigInt(entry.tokenBalance) });
  }
  const nextCursor = typeof r.pageKey === 'string' && r.pageKey !== '' ? r.pageKey : null;
  return { balances, failures, nextCursor };
}

/** A discovery provider over any transport serving alchemy_getTokenBalances. */
export function indexerTokenBalanceProvider(transport: JsonRpcTransport): TokenBalanceDiscoveryProvider {
  return {
    async page(owner, options = {}) {
      if (!ADDRESS.test(owner)) throw new Error(`Not an EVM address: ${owner}`);
      const pageSize = Math.min(
        Math.max(1, Math.floor(options.pageSize ?? TOKEN_BALANCES_MAX_PAGE_SIZE)),
        TOKEN_BALANCES_MAX_PAGE_SIZE,
      );
      const params: unknown[] = [
        owner,
        'erc20',
        { maxCount: pageSize, ...(options.cursor ? { pageKey: options.cursor } : {}) },
      ];
      let result: unknown;
      try {
        result = await transport('alchemy_getTokenBalances', params);
      } catch (e) {
        if (isMethodUnsupportedError(e)) {
          throw new TokenDiscoveryUnsupportedError(e instanceof Error ? e.message : String(e));
        }
        throw e;
      }
      return parseTokenBalancesResult(result, owner);
    },
  };
}

export interface CollectedTokenBalances {
  /** Distinct contracts with a NON-ZERO balance, in the indexer's order. */
  holdings: DiscoveredTokenBalance[];
  /** How many distinct contracts were reported with a zero balance. */
  zeroCount: number;
  failures: DiscoveryEntryFailure[];
  /** False when maxPages was reached with more pages left. */
  complete: boolean;
  pages: number;
}

/**
 * Walks the pages (at most maxPages, default 5 = up to 500 contracts) and
 * returns the non-zero holdings, deduplicated by contract (the first entry
 * wins; a repeated cursor stops the walk instead of looping).
 */
export async function collectTokenBalances(
  provider: TokenBalanceDiscoveryProvider,
  owner: string,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<CollectedTokenBalances> {
  const maxPages = Math.max(1, options.maxPages ?? 5);
  const seen = new Set<string>();
  const holdings: DiscoveredTokenBalance[] = [];
  const failures: DiscoveryEntryFailure[] = [];
  const cursors = new Set<string>();
  let zeroCount = 0;
  let cursor: string | null = null;
  let pages = 0;
  let repeated = false;
  do {
    const page: TokenDiscoveryPage = await provider.page(owner, {
      ...(cursor ? { cursor } : {}),
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    });
    pages += 1;
    for (const b of page.balances) {
      const key = b.contract.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (b.balance > 0n) holdings.push(b);
      else zeroCount += 1;
    }
    failures.push(...page.failures);
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (cursors.has(cursor)) {
        // The indexer repeated a cursor: stop rather than loop, and report
        // the walk as incomplete.
        repeated = true;
        break;
      }
      cursors.add(cursor);
    }
  } while (cursor !== null && pages < maxPages);
  return { holdings, zeroCount, failures, complete: cursor === null && !repeated, pages };
}

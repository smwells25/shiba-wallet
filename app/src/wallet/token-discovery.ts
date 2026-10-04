import AsyncStorage from '@react-native-async-storage/async-storage';
import type { FungibleAsset } from '@shiba-wallet/core';
import {
  NodeClient,
  TokenDiscoveryUnsupportedError,
  collectTokenBalances,
  indexerTokenBalanceProvider,
  type JsonRpcTransport,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: scripts/check-tokens.mjs loads this module under
// Node's type stripping, which resolves relative specifiers literally.
import { getIndexerConfig } from './indexer.ts';
import { knownTokensForChain, listTokens, type KeyValueStore } from './tokens.ts';
import { Erc20NotATokenError, fetchErc20Metadata, type Erc20Metadata } from './erc20.ts';
import { simulationTransport } from './simulation.ts';
import { formatBalanceDisplay } from './balances.ts';
import { sanitizeEndpointMessage } from '../config/endpoint-probe.ts';
import { evmProfileByCaip2 } from '../config/evm-chain.ts';

/**
 * "Find my tokens" (phase 13 item 1, Tier 1 feature 37): lists the ERC-20
 * tokens the active account holds on the ACTIVE EVM chain that are NOT yet
 * tracked, so the user can pick which ones to track. Nothing is ever added
 * automatically.
 *
 * Source of the list: the history indexer the user configured for this
 * chain (./indexer.ts; the stored URL passed eth_chainId and Transfers API
 * checks when it was saved), asked for alchemy_getTokenBalances through the
 * engine's vendor-neutral provider (packages/chains-evm
 * src/token-discovery.ts, where the documented request and response shapes
 * and the live probes are cited). The indexer is asked again for
 * eth_chainId before every discovery, so a URL can never answer for a
 * different network than the one on screen. Without an indexer the feature
 * says plainly that it is unavailable; an indexer that does not serve the
 * method gets its own plain note.
 *
 * Anti-spoofing rules (the same ones the balance-change preview and the
 * contacts screen follow):
 *  - metadata comes from the CHAIN, never from the indexer: decimals(),
 *    symbol() and name() are read with eth_call through erc20.ts
 *    fetchErc20Metadata against the active RPC endpoint; a contract that
 *    answered decimals() unlike an ERC-20 (a revert or malformed return
 *    data) is counted as not answering like a token and cannot be tracked
 *    from here (balances could not be shown honestly). A read that failed
 *    without such an answer (the endpoint did not respond, refused, or
 *    returned nothing) is counted separately as "could not be read right
 *    now": a network failure is never evidence about the contract;
 *  - the on-chain symbol and name are cleaned with the preview's rule
 *    (control, bidirectional-override and zero-width characters stripped;
 *    simulation.ts sanitizeSymbol) and capped like the add-token form;
 *  - every result is marked untracked and carries its FULL contract
 *    address; a discovered token whose symbol equals a tracked or known
 *    token's symbol on this chain but whose contract differs is flagged as
 *    a look-alike (exact comparison only, never fuzzy);
 *  - zero balances are hidden (counted), and metadata is read for at most
 *    MAX_DISCOVERY_METADATA contracts per run so an address sprayed with
 *    airdrop spam cannot make the screen issue hundreds of calls.
 */

/** Same caps as the add-token form (TokensScreen MAX_SYMBOL_LENGTH / MAX_NAME_LENGTH). */
export const TOKEN_SYMBOL_MAX = 16;
export const TOKEN_NAME_MAX = 48;

/** At most this many untracked holdings get an on-chain metadata read per run. */
export const MAX_DISCOVERY_METADATA = 25;

/**
 * The characters the balance-change preview strips from on-chain symbols
 * (simulation.ts sanitizeSymbol): C0/C1 controls, zero-width and
 * directional marks (U+200B–U+200F), bidirectional embeddings and
 * overrides (U+202A–U+202E) and isolates (U+2066–U+2069). Kept identical to
 * that rule; scripts/check-tokens.mjs compares the two on the same inputs.
 */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

/**
 * Cleans attacker-controlled token text for display AND storage: strips the
 * unsafe characters above, trims, and caps the length (no ellipsis, so the
 * stored symbol is exactly what is shown). Null when nothing is left.
 */
export function cleanTokenText(raw: string | null | undefined, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(UNSAFE_TEXT, '').trim().slice(0, max).trim();
  return cleaned === '' ? null : cleaned;
}

export const FIND_TOKENS_WARNING =
  'Anyone can send any token to your address, including fakes that copy the name of a real ' +
  'token. A token in this list is not a sign that it is genuine or has any value. Nothing is ' +
  'added until you pick it — check the contract address against a source you trust first.';

/** The note when this chain has no history indexer configured. */
export function discoveryUnavailableNote(networkLabel: string): string {
  return (
    `Finding tokens needs a history indexer for ${networkLabel} (Settings → Ethereum history ` +
    'indexer). Without one the wallet cannot list which tokens your address holds. You can ' +
    'still add a token by its contract address below.'
  );
}

export const DISCOVERY_UNSUPPORTED_NOTE =
  'The configured history indexer does not offer token discovery (it does not answer ' +
  'alchemy_getTokenBalances). You can still add a token by its contract address below.';

export interface DiscoveredToken {
  /** Token contract, EIP-55 checksummed (from the engine). */
  contract: string;
  /** Exact balance in base units, as the indexer reported it. */
  balance: bigint;
  /** From decimals() on chain. */
  decimals: number;
  /** Cleaned on-chain symbol, or null when symbol() gave no readable text. */
  symbol: string | null;
  /** Cleaned on-chain name, or null. */
  name: string | null;
  /** formatBalanceDisplay(balance, decimals): never "0" for a non-zero dust balance. */
  display: string;
  /**
   * The symbol of a tracked or known token on this chain that this token's
   * symbol equals (case-insensitively) although the contract differs, or
   * null. Shown as a look-alike warning.
   */
  lookalikeOf: string | null;
  /**
   * The asset to track, built for the ACTIVE chain, or null when the symbol
   * is unreadable (the user then adds it through the address form, which
   * offers manual symbol entry).
   */
  asset: FungibleAsset | null;
  /** Why symbol/name are missing (from fetchErc20Metadata), or null. */
  note: string | null;
}

/**
 * The one-tap confirmation before a discovered token is tracked (the manual
 * add flow also shows the full contract before adding). The contract is
 * shown in full because a look-alike token copies the symbol and name, never
 * the address; a look-alike gets the warning again.
 */
export function trackDiscoveredPrompt(
  found: Pick<DiscoveredToken, 'contract' | 'lookalikeOf'> & { asset: Pick<FungibleAsset, 'symbol'> },
  networkLabel: string,
): { title: string; message: string; confirm: string } {
  return {
    title: `Track ${found.asset.symbol}?`,
    message:
      `Contract ${found.contract} on ${networkLabel}.` +
      (found.lookalikeOf
        ? ` Warning: its symbol equals the ${found.lookalikeOf} you track or the wallet knows, but the contract is DIFFERENT. It may be a fake.`
        : '') +
      ' Anyone can create a token with any name and symbol; track it only if this is the contract you expect.',
    confirm: `Track ${found.asset.symbol}`,
  };
}

export type DiscoveryOutcome =
  | { status: 'unavailable'; note: string }
  | { status: 'unsupported'; note: string; technical: string }
  | {
      status: 'ok';
      /** Untracked holdings with readable decimals, in the indexer's order. */
      tokens: DiscoveredToken[];
      /** Untracked holdings whose decimals() answer was not an ERC-20's (revert, malformed data). */
      unreadable: { contract: string; reason: string }[];
      /**
       * Untracked holdings whose metadata read failed without an answer from
       * the contract (transport or endpoint failure): nothing is known about
       * them, and searching again may list them.
       */
      readFailed: { contract: string; reason: string }[];
      /** Holdings already in the tracked list (not shown). */
      alreadyTracked: number;
      /** Contracts the indexer reported with a zero balance (hidden). */
      zeroHidden: number;
      /** Entries the indexer itself could not answer (per-entry errors). */
      indexerFailures: number;
      /** Untracked holdings beyond MAX_DISCOVERY_METADATA, not looked up. */
      notChecked: number;
      /** False when the indexer had more pages than the walk read. */
      complete: boolean;
    };

/**
 * Discovers untracked token holdings of `owner` on `chainCaip2`.
 * `rpc` is the endpoint the metadata is read from; it must serve the same
 * chain (the screen passes the endpoint withEndpoint answered with). Throws
 * for transport failures and a wrong-chain indexer or RPC (the screen shows
 * them through describeNetworkError); returns 'unavailable' / 'unsupported'
 * for the two expected "cannot do this here" cases.
 */
export async function discoverUntrackedTokens(options: {
  chainCaip2: string;
  owner: string;
  rpc: { url: string; chainId: string };
  store?: KeyValueStore;
  transportFor?: (url: string) => JsonRpcTransport;
  fetchMetadata?: (url: string, contract: string) => Promise<Erc20Metadata>;
  maxPages?: number;
  maxMetadata?: number;
}): Promise<DiscoveryOutcome> {
  const { chainCaip2, owner, rpc } = options;
  const store = options.store ?? AsyncStorage;
  const profile = evmProfileByCaip2(chainCaip2);
  if (!profile) throw new Error(`No EVM network profile for ${chainCaip2}.`);
  if (rpc.chainId !== chainCaip2) {
    throw new Error(
      `The RPC endpoint serves ${rpc.chainId}, not ${chainCaip2}; token details were not read.`,
    );
  }
  const config = await getIndexerConfig(chainCaip2, store);
  if (config.url === null) return { status: 'unavailable', note: discoveryUnavailableNote(profile.label) };

  const transport = (options.transportFor ?? ((url: string) => simulationTransport(url)))(config.url);
  const expected = BigInt(profile.chainIdDecimal);
  const actual = await new NodeClient(transport).chainId();
  if (actual !== expected) {
    throw new Error(
      `The history indexer answers for chain id ${actual}, not ${expected} (${profile.label}); ` +
        'nothing was listed. Check Settings → Ethereum history indexer.',
    );
  }

  let collected;
  try {
    collected = await collectTokenBalances(indexerTokenBalanceProvider(transport), owner, {
      maxPages: options.maxPages ?? 5,
    });
  } catch (e) {
    if (e instanceof TokenDiscoveryUnsupportedError) {
      return {
        status: 'unsupported',
        note: DISCOVERY_UNSUPPORTED_NOTE,
        technical: sanitizeEndpointMessage(e.message),
      };
    }
    throw e;
  }

  const tracked = await listTokens(chainCaip2, store);
  const trackedContracts = new Set(tracked.map((t) => t.assetId.reference.toLowerCase()));
  // Symbols a look-alike would imitate: the tracked list and the tokens the
  // wallet knows on this chain (they are on this chain by construction).
  const referenceTokens = [...tracked, ...knownTokensForChain(chainCaip2)];

  const untracked = collected.holdings.filter((h) => !trackedContracts.has(h.contract.toLowerCase()));
  const alreadyTracked = collected.holdings.length - untracked.length;
  const maxMetadata = options.maxMetadata ?? MAX_DISCOVERY_METADATA;
  const toRead = untracked.slice(0, maxMetadata);
  const fetchMetadata = options.fetchMetadata ?? fetchErc20Metadata;

  const results = await Promise.all(
    toRead.map(async (holding) => {
      try {
        return { holding, metadata: await fetchMetadata(rpc.url, holding.contract) };
      } catch (e) {
        return { holding, error: e instanceof Error ? e.message : String(e), notAToken: isNotATokenError(e) };
      }
    }),
  );

  const tokens: DiscoveredToken[] = [];
  const unreadable: { contract: string; reason: string }[] = [];
  const readFailed: { contract: string; reason: string }[] = [];
  for (const r of results) {
    if (!('metadata' in r) || r.metadata === undefined) {
      // Only an answer from the contract counts as "not an ERC-20"; any
      // other failure (including an unrecognized one from an injected
      // reader) is a read that did not happen.
      const entry = { contract: r.holding.contract, reason: r.error ?? 'unknown error' };
      if (r.notAToken) unreadable.push(entry);
      else readFailed.push(entry);
      continue;
    }
    const { holding, metadata } = r;
    const symbol = cleanTokenText(metadata.symbol, TOKEN_SYMBOL_MAX);
    const name = cleanTokenText(metadata.name, TOKEN_NAME_MAX);
    const lookalike =
      symbol === null
        ? undefined
        : referenceTokens.find(
            (t) =>
              t.symbol.toLowerCase() === symbol.toLowerCase() &&
              t.assetId.reference.toLowerCase() !== holding.contract.toLowerCase(),
          );
    tokens.push({
      contract: holding.contract,
      balance: holding.balance,
      decimals: metadata.decimals,
      symbol,
      name,
      display: formatBalanceDisplay(holding.balance, metadata.decimals),
      lookalikeOf: lookalike ? lookalike.symbol : null,
      asset:
        symbol === null
          ? null
          : {
              kind: 'fungible',
              assetId: { chainId: chainCaip2, namespace: 'erc20', reference: holding.contract },
              symbol,
              // A missing name is the symbol, as in the add-token form.
              name: name ?? symbol,
              decimals: metadata.decimals,
            },
      note: metadata.note,
    });
  }

  return {
    status: 'ok',
    tokens,
    unreadable,
    readFailed,
    alreadyTracked,
    zeroHidden: collected.zeroCount,
    indexerFailures: collected.failures.length,
    notChecked: untracked.length - toRead.length,
    complete: collected.complete,
  };
}

/**
 * True for fetchErc20Metadata's "answered, but not like an ERC-20" failure
 * (checked by name too, so an equivalent error from an injected reader in
 * another module instance counts).
 */
export function isNotATokenError(error: unknown): boolean {
  return (
    error instanceof Erc20NotATokenError ||
    (error instanceof Error && error.name === 'Erc20NotATokenError')
  );
}

/** The one-line summary under the results ("3 found · 1 already tracked · …"). */
export function discoverySummary(outcome: Extract<DiscoveryOutcome, { status: 'ok' }>): string {
  const parts = [
    `${outcome.tokens.length} untracked token${outcome.tokens.length === 1 ? '' : 's'} found`,
  ];
  if (outcome.alreadyTracked > 0) parts.push(`${outcome.alreadyTracked} already tracked`);
  if (outcome.zeroHidden > 0) parts.push(`${outcome.zeroHidden} with a zero balance hidden`);
  if (outcome.unreadable.length > 0) {
    parts.push(`${outcome.unreadable.length} that do not answer like an ERC-20 token not shown`);
  }
  if (outcome.readFailed.length > 0) {
    parts.push(`${outcome.readFailed.length} could not be read right now — search again`);
  }
  if (outcome.notChecked > 0) parts.push(`${outcome.notChecked} more not looked up (limit ${MAX_DISCOVERY_METADATA})`);
  if (outcome.indexerFailures > 0) parts.push(`${outcome.indexerFailures} the indexer could not answer`);
  if (!outcome.complete) parts.push('the indexer has more pages than were read');
  return `${parts.join(' · ')}.`;
}

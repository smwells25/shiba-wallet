import type { FungibleAsset } from '@shiba-wallet/core';
import {
  activitySentence,
  activityTokenContracts,
  decodeActivity,
  httpTransport,
  predictKernelAddress,
} from '@shiba-wallet/chains-evm';
import type { ActivityDescription, AssetChange } from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: scripts/check-activity.mjs loads this module
// under Node's type stripping, which resolves relative specifiers literally.
import { withEndpoint } from '../config/networks.ts';
import { maskAmount } from '../config/prefs.ts';
import { findExactContact, type Contact } from './contacts.ts';
import { resolveTokenMeta, type TokenMetaMap } from './simulation.ts';
import type { Erc20Metadata } from './erc20.ts';
import { smartAccountSaltFor } from './account-ids.ts';

/**
 * Human-readable Activity rows (phase 11 item 4): app glue around the
 * engine's activity decoder (packages/chains-evm/src/activity-decode.ts),
 * which turns a transaction hash into a structured description and a plain
 * sentence built only from the transaction and its receipt.
 *
 * What this module adds:
 *  - Endpoint: every decode runs through config/networks.ts withEndpoint,
 *    i.e. the ACTIVE network's endpoint with the shared failover rule (a
 *    failing default endpoint is reported and the decode is repeated once
 *    on the next healthy candidate).
 *  - Bounds: at most `maxPerCall` new decodes per call (the screen calls
 *    once per page it shows), one at a time, so a long history never
 *    triggers a burst of requests against a public endpoint.
 *  - Cache: successful decodes are kept in memory (bounded, oldest out
 *    first) per network + wallet addresses + hash, so revisiting the
 *    screen costs nothing. Failures and "not available yet" answers are
 *    NOT cached; they are remembered per decoder so the same row is not
 *    retried on every render, and a pull-to-refresh (reset()) tries again.
 *  - Failure policy: any failure leaves the row exactly as it was — no
 *    sentence, no error text. The sentence is an addition to the row, never
 *    a replacement for the amount/fee line.
 *  - Token metadata: the balance-change preview's own resolver
 *    (./simulation.ts resolveTokenMeta: tracked-token list for this exact
 *    network first, else on-chain symbol()/decimals(), capped, sanitized).
 *  - Rendering: contacts' EXACT-match names for counterparties
 *    (./contacts.ts findExactContact — never a prefix/suffix match), and
 *    Hide amounts through config/prefs.ts maskAmount. Rendering is separate
 *    from decoding, so toggling Hide amounts or editing a contact changes
 *    the sentence immediately without a new network request.
 *
 * Deliberately free of React Native imports so scripts/check-activity.mjs
 * runs the exact code the screen runs.
 */

/** New decodes per decodeEntries call (one Activity page). */
export const MAX_DECODES_PER_CALL = 8;
/** Successful decodes kept in memory across screen visits. */
export const ACTIVITY_CACHE_LIMIT = 300;

export interface DecodedActivity {
  description: ActivityDescription;
  /** Token metadata by lowercase contract address. */
  tokens: TokenMetaMap;
}

const cache = new Map<string, DecodedActivity>();

function remember(key: string, value: DecodedActivity): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > ACTIVITY_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Drops every cached decode (wallet wipe; tests). */
export function clearActivityCache(): void {
  cache.clear();
}

/** Number of cached decodes (tests). */
export function activityCacheSize(): number {
  return cache.size;
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Runs `operation` against an RPC URL. The default goes through
 * withEndpoint for `chainId`; checks inject a fixed URL.
 */
export type EndpointRunner = <T>(operation: (url: string) => Promise<T>) => Promise<T>;

export function activeEndpointRunner(chainId: string): EndpointRunner {
  return async (operation) => (await withEndpoint(chainId, (ep) => operation(ep.url))).value;
}

export interface ActivityDecoderOptions {
  /** CAIP-2 id of the active EVM network (e.g. 'eip155:11155111'). */
  chainCaip2: string;
  /** Its EIP-155 chain id. */
  evmChainId: bigint;
  /** The wallet's addresses on this network (EOA first; smart accounts if known). */
  wallet: string[];
  /** Tracked tokens (filtered to this network by the metadata resolver). */
  trackedTokens: FungibleAsset[];
  /** Where requests go; defaults to activeEndpointRunner(chainCaip2). */
  run?: EndpointRunner;
  maxPerCall?: number;
  /** Metadata reader override (tests). */
  fetchMetadata?: (url: string, contract: string) => Promise<Erc20Metadata>;
}

export interface ActivityDecoder {
  /**
   * Decodes up to maxPerCall of `ids` (transaction hashes) that are not
   * cached and have not failed in this decoder, in the given order, then
   * returns every cached result for `ids`. Never throws.
   */
  decodeEntries(ids: string[]): Promise<Map<string, DecodedActivity>>;
  /** Cached results for `ids`, without any request. */
  cachedFor(ids: string[]): Map<string, DecodedActivity>;
  /** Forgets this decoder's failures so they are tried again. */
  reset(): void;
  /** Hashes that failed in this decoder (tests). */
  failedIds(): string[];
}

export function createActivityDecoder(options: ActivityDecoderOptions): ActivityDecoder {
  const walletKey = options.wallet.map((a) => a.toLowerCase()).sort().join(',');
  const keyFor = (hash: string) => `${options.chainCaip2}|${walletKey}|${hash.toLowerCase()}`;
  const run = options.run ?? activeEndpointRunner(options.chainCaip2);
  const maxPerCall = options.maxPerCall ?? MAX_DECODES_PER_CALL;
  const failed = new Set<string>();
  const inFlight = new Set<string>();

  const cachedFor = (ids: string[]) => {
    const out = new Map<string, DecodedActivity>();
    for (const id of ids) {
      const hit = cache.get(keyFor(id));
      if (hit) out.set(id, hit);
    }
    return out;
  };

  async function decodeOne(hash: string): Promise<DecodedActivity | null> {
    return run(async (url) => {
      const outcome = await decodeActivity(httpTransport(url), hash, {
        wallet: options.wallet,
        chainId: options.evmChainId,
      });
      if (outcome.status !== 'ok') return null;
      const description = outcome.description;
      // The preview's resolver takes balance changes; present each contract
      // the sentence may name as a zero-amount change so the same tracked-
      // list matching, eth_call reads, cap and sanitizing apply.
      const contracts = activityTokenContracts(description);
      const asChanges: AssetChange[] = contracts.map((token) => ({
        type: 'erc20',
        callIndex: 0,
        direction: 'in',
        token,
        from: token,
        to: token,
        amount: 0n,
      }));
      const tokens = contracts.length
        ? await resolveTokenMeta(asChanges, {
            url,
            chainCaip2: options.chainCaip2,
            trackedTokens: options.trackedTokens,
            ...(options.fetchMetadata ? { fetchMetadata: options.fetchMetadata } : {}),
          })
        : {};
      return { description, tokens };
    });
  }

  return {
    cachedFor,
    reset() {
      failed.clear();
    },
    failedIds() {
      return [...failed];
    },
    async decodeEntries(ids) {
      const unique = [...new Set(ids)];
      const todo = unique
        .filter((id) => HASH_RE.test(id) && !cache.has(keyFor(id)) && !failed.has(id) && !inFlight.has(id))
        .slice(0, maxPerCall);
      for (const id of todo) {
        inFlight.add(id);
        try {
          const decoded = await decodeOne(id);
          if (decoded) remember(keyFor(id), decoded);
          else failed.add(id);
        } catch {
          failed.add(id);
        } finally {
          inFlight.delete(id);
        }
      }
      return cachedFor(unique);
    },
  };
}

export interface SentenceRenderOptions {
  /** Native currency label of the active network ("ETH", "test ETH"). */
  nativeSymbol: string;
  /** Hide amounts. */
  hidden: boolean;
  /** Contacts of the active network (exact matches only are used). */
  contacts: readonly Contact[];
  /** The contacts network id (the active EVM network's CAIP-2 id). */
  networkId: string;
}

/** The sentence for one decoded transaction, rendered for the current preferences. */
export function renderActivitySentence(decoded: DecodedActivity, options: SentenceRenderOptions): string {
  return activitySentence(decoded.description, {
    nativeSymbol: options.nativeSymbol,
    tokens: decoded.tokens,
    nameFor: (address) => findExactContact(options.networkId, address, options.contacts)?.name ?? null,
    maskAmount: (text) => maskAmount(text, options.hidden),
  });
}

/** The parts of an AA chain configuration (./aa.ts AaChainConfig) this module reads. */
export interface AaAddressFacts {
  accountType: string;
  factory: string | null;
  factoryImplementation: string | null;
  kernelValidator: string | null;
  recoveredAccounts?: { owner: string; account: string }[];
}

/**
 * The wallet's addresses for decoding on one network: the account's EOA,
 * plus the smart-account addresses that are known WITHOUT a network
 * request — the Kernel v3.3 counterfactual address (engine
 * predictKernelAddress with the verified factory, the account's salt
 * (smartAccountSaltFor: the index, or 0 for an imported key), the
 * configured validator) when Kernel is the chain's account type,
 * and a recovered account attached to this owner. SimpleAccount addresses
 * need a factory call and are not included, so their operations read as
 * "from other accounts".
 */
export function walletAddressesFor(eoa: string, accountIndex: number, aa: AaAddressFacts | null): string[] {
  const out = [eoa];
  if (!aa) return out;
  if (aa.accountType === 'kernel-v3.3' && aa.factory) {
    try {
      out.push(
        predictKernelAddress(eoa, {
          // The account's CREATE2 salt: its derivation index, or 0 for an
          // imported key's account (account-ids.ts, ADR D9).
          index: BigInt(smartAccountSaltFor(accountIndex)),
          factory: aa.factory,
          ...(aa.factoryImplementation ? { implementation: aa.factoryImplementation } : {}),
          ...(aa.kernelValidator ? { ecdsaValidator: aa.kernelValidator } : {}),
        }),
      );
    } catch {
      // A malformed stored value adds nothing.
    }
  }
  const recovered = aa.recoveredAccounts?.find((l) => l.owner.toLowerCase() === eoa.toLowerCase());
  if (recovered) out.push(recovered.account);
  return [...new Set(out)];
}

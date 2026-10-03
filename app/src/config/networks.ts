import AsyncStorage from '@react-native-async-storage/async-storage';
// Explicit .ts extensions: scripts/check-failover.mjs loads this module
// directly under Node's type stripping, which resolves relative specifiers
// literally (Metro accepts both forms).
import type { NetworkDefault } from './defaults.ts';
import { networkDefaultFor, resolveActiveNetworks } from './defaults.ts';
import { loadPrefs } from './prefs.ts';
import { blockbookHeaders, getBlockbookConfig } from '../wallet/blockbook.ts';
import type { KeyValueStore } from '../wallet/tokens.ts';
import { assertSecureEndpointUrl } from './endpoint-url.ts';
import {
  createDefaultEndpointResolver,
  resolveNetworkUrl,
  runWithEndpointFailover,
  type DefaultChoice,
  type FailoverOutcome,
} from './endpoint-probe.ts';

/**
 * Per-chain RPC/REST endpoint configuration: verified public defaults (see
 * ./defaults.ts) plus user overrides.
 *
 * Overrides live in AsyncStorage, NOT expo-secure-store: endpoint URLs are
 * public configuration, not secrets, and keeping them out of secure storage
 * preserves the invariant that src/wallet/storage.ts is the only module
 * touching the secure store (which holds only the mnemonic).
 *
 * TEST NETWORKS (phase 4, item 6; phase 10, item 3): the resolvers below
 * are the single place where the app's EVM "slot" ('eip155:1', the id
 * accounts and routes carry) is translated to the ACTIVE EVM network. With
 * a test network chosen in Settings → Developer, the Ethereum slot resolves
 * to that network (Sepolia or Base Sepolia; see resolveActiveNetworks in
 * ./defaults.ts); overrides are keyed by the ACTIVE chain's CAIP-2 id, so a
 * custom Sepolia, Base Sepolia or mainnet RPC is stored under its own key
 * and can never bleed into another mode.
 *
 * DEFAULT FALLBACK (2026-10-01): without an override, the URL is chosen
 * from the network's ordered default candidates by ./endpoint-probe.ts —
 * probed in order with a short timeout and a chain-identity check, the
 * first healthy one used and cached in memory for the session (never in
 * AsyncStorage). Callers that see a request fail through a default can
 * call reportEndpointFailure() so the next resolution probes again. A user
 * override always wins and is never probed around.
 *
 * CALL-TIME FAILOVER (phase 9 item 5): every network-using path resolves
 * its endpoint when it makes the call (getEndpoint, or withEndpoint below)
 * and runs the request through callWithFailover, the single place where a
 * failed DEFAULT endpoint is reported and the request is repeated once on
 * the next healthy candidate (endpoint-probe.ts runWithEndpointFailover).
 * Quotes are never patched across endpoints: a quote names the endpoint
 * that produced it, and the send paths refuse to sign when the wallet would
 * now use a different one (send.ts quoteEndpointChange).
 */

/** Session-lifetime, in-memory choice among each chain's default candidates. */
const defaultResolver = createDefaultEndpointResolver();

const OVERRIDES_KEY = 'shiba-wallet.rpc-endpoints.v1';

type OverrideMap = Record<string, string>;

async function loadOverrides(store: KeyValueStore = AsyncStorage): Promise<OverrideMap> {
  try {
    const raw = await store.getItem(OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const map: OverrideMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') map[k] = v;
      }
      return map;
    }
    return {};
  } catch {
    // Corrupt JSON or unavailable storage: fall back to defaults rather
    // than break balance display.
    return {};
  }
}

/**
 * Splits a stored override into the URL the app may use and, when the
 * stored value fails today's https rule (./endpoint-url.ts), the reason it
 * is ignored. Overrides saved before the rule existed (dev/emulator installs
 * only) can hold a plain http:// URL; such a value is treated as "no
 * override" — the chain falls back to its verified defaults — and is left
 * in storage untouched, so Settings can show why it is not used and the
 * user removes it explicitly with "Reset to default".
 */
function checkStoredOverride(stored: string | undefined): { url?: string; ignoredReason?: string } {
  if (stored === undefined) return {};
  try {
    // The stored value is used exactly as saved; the check only decides
    // whether it may be used at all.
    assertSecureEndpointUrl(stored);
    return { url: stored };
  } catch (e) {
    return { ignoredReason: e instanceof Error ? e.message : String(e) };
  }
}

async function saveOverrides(map: OverrideMap, store: KeyValueStore = AsyncStorage): Promise<void> {
  await store.setItem(OVERRIDES_KEY, JSON.stringify(map));
}

/** Resolved endpoint state for one chain, ready for display or fetching. */
export interface NetworkEndpoint {
  /**
   * The stable slot id callers query by (an account/route chain id, e.g.
   * 'eip155:1'). Equals network.chainId except for the EVM slot in Sepolia
   * test mode, where network is the Sepolia entry.
   */
  forChainId: string;
  network: NetworkDefault;
  /** The URL balance fetches should use right now (override or default). */
  url: string | null;
  /** True when the URL comes from a user override. */
  isOverride: boolean;
  /**
   * Extra request headers for the endpoint. Only 'blockbook' chains carry
   * any: the configured API key as the api-key header (see
   * ../wallet/blockbook.ts). Passed through to the engine transports by
   * balances/history/send callers; absent for every other kind.
   */
  headers?: Record<string, string>;
  /**
   * Which default candidate is in use (position, total, whether the primary
   * failed its probe). Present only when the URL is a default, i.e. no
   * override is set and the network has default candidates.
   */
  defaultChoice?: DefaultChoice;
  /**
   * Set when a stored endpoint (an RPC override, or the Blockbook URL for
   * Blockbook chains) exists but fails the https rule on read: the reason,
   * for Settings' status line. The stored value is NOT used — `url` is the
   * default (or null) — and it stays stored until the user clears it.
   */
  ignoredReason?: string;
}

/** Resolves one active network (slot) to its effective endpoint. */
async function resolveSlot(
  slot: string,
  network: NetworkDefault,
  overrides: OverrideMap,
  store: KeyValueStore,
): Promise<NetworkEndpoint> {
  if (network.kind === 'blockbook') {
    // Blockbook chains (Dogecoin) resolve from their own verified
    // config store (URL + optional API key, ../wallet/blockbook.ts),
    // not the plain URL-override map: a stored URL there passed the
    // save-time UTXO-query verification by construction.
    // getBlockbookConfig already applies the https rule on read.
    const config = await getBlockbookConfig(network.chainId, store);
    const headers = blockbookHeaders(config.apiKey);
    return {
      forChainId: slot,
      network,
      url: config.url,
      isOverride: config.url !== null,
      ...(headers ? { headers } : {}),
      ...(config.ignoredUrlReason ? { ignoredReason: config.ignoredUrlReason } : {}),
    };
  }
  // Keyed by the ACTIVE chain id: mainnet and Sepolia overrides live
  // under different keys and never mix. An override that passes the https
  // rule is used as is; otherwise (none stored, or an old http:// value
  // that is now ignored) the first healthy default candidate is chosen.
  const override = checkStoredOverride(overrides[network.chainId]);
  const resolved = await resolveNetworkUrl(network, override.url, defaultResolver);
  return {
    forChainId: slot,
    network,
    url: resolved.url,
    isOverride: resolved.isOverride,
    ...(resolved.defaultChoice ? { defaultChoice: resolved.defaultChoice } : {}),
    ...(override.ignoredReason ? { ignoredReason: override.ignoredReason } : {}),
  };
}

/**
 * Resolves the effective endpoint for one chain. Accepts either a slot id
 * (the mainnet CAIP-2 ids accounts and routes carry) or the active
 * network's own chain id (e.g. 'eip155:11155111' while Sepolia is the test
 * network, 'eip155:84532' while Base Sepolia is).
 * Only the requested chain is resolved (and, if needed, probed).
 * `options.store` (endpoint overrides, the Blockbook config and the
 * preferences all live in it; AsyncStorage in the app) exists for the
 * offline check scripts.
 */
export async function getEndpoint(
  chainId: string,
  options: { store?: KeyValueStore } = {},
): Promise<NetworkEndpoint | undefined> {
  const store = options.store ?? AsyncStorage;
  const [overrides, prefs] = await Promise.all([loadOverrides(store), loadPrefs(store)]);
  const match = resolveActiveNetworks(prefs.testNetwork).find(
    (e) => e.slot === chainId || e.network.chainId === chainId,
  );
  return match ? resolveSlot(match.slot, match.network, overrides, store) : undefined;
}

/** Resolves every chain's effective endpoint (Settings list, Home refresh). */
export async function getAllEndpoints(
  options: { store?: KeyValueStore } = {},
): Promise<NetworkEndpoint[]> {
  const store = options.store ?? AsyncStorage;
  const [overrides, prefs] = await Promise.all([loadOverrides(store), loadPrefs(store)]);
  return Promise.all(
    resolveActiveNetworks(prefs.testNetwork).map(({ slot, network }) =>
      resolveSlot(slot, network, overrides, store),
    ),
  );
}

/**
 * Reports that a real request through a DEFAULT endpoint failed, so the
 * next getEndpoint/getAllEndpoints call re-probes that chain's candidates
 * from the top. `networkChainId` is the network's own CAIP-2 id
 * (endpoint.network.chainId). No effect for overrides or when `url` is not
 * the cached choice. Returns true when the cached choice was dropped.
 */
export function reportEndpointFailure(networkChainId: string, url: string): boolean {
  return defaultResolver.reportFailure(networkChainId, url);
}

/**
 * Forgets every in-memory default choice, so the next resolution probes
 * each chain's candidates from the top. Called when the device regains
 * connectivity (../wallet/connectivity.ts): choices made while offline say
 * nothing about which endpoint is healthy now.
 */
export function forgetDefaultEndpointChoices(): void {
  defaultResolver.clear();
}

/** An endpoint whose URL is set (the only kind a request can use). */
export type UsableEndpoint = NetworkEndpoint & { url: string };

/** Thrown by withEndpoint when the chain has no endpoint to call. */
export class NoEndpointError extends Error {
  /** The resolved (URL-less) endpoint, when the chain is known at all. */
  readonly endpoint: NetworkEndpoint | undefined;
  constructor(endpoint: NetworkEndpoint | undefined) {
    super(
      endpoint
        ? `No endpoint is configured for ${endpoint.network.label}.`
        : 'No network configuration for this chain.',
    );
    this.name = 'NoEndpointError';
    this.endpoint = endpoint;
  }
}

/**
 * Runs `operation` through `endpoint` with the shared failover rule: a
 * DEFAULT endpoint that fails at the transport level is reported and the
 * operation is repeated once on the next healthy candidate; an override is
 * used as is. The outcome names the endpoint that answered — callers that
 * build a quote must keep that endpoint and send through it.
 */
export function callWithFailover<T>(
  endpoint: UsableEndpoint,
  operation: (endpoint: UsableEndpoint) => Promise<T>,
  options: { isFailure?: (error: unknown) => boolean } = {},
): Promise<FailoverOutcome<NetworkEndpoint, T>> {
  return runWithEndpointFailover<NetworkEndpoint, T>(endpoint, operation, {
    reResolve: () => getEndpoint(endpoint.forChainId),
    report: reportEndpointFailure,
    ...(options.isFailure ? { isFailure: options.isFailure } : {}),
  });
}

/**
 * Resolves the chain's endpoint NOW (override or current default choice)
 * and runs `operation` through callWithFailover. Throws NoEndpointError
 * when the chain has no usable URL.
 */
export async function withEndpoint<T>(
  chainId: string,
  operation: (endpoint: UsableEndpoint) => Promise<T>,
  options: { isFailure?: (error: unknown) => boolean } = {},
): Promise<FailoverOutcome<NetworkEndpoint, T>> {
  const endpoint = await getEndpoint(chainId);
  if (!endpoint || endpoint.url === null) throw new NoEndpointError(endpoint);
  return callWithFailover(endpoint as UsableEndpoint, operation, options);
}

/**
 * Sets a user override. Throws on invalid input so Settings can surface
 * the message: the URL must be https:// (plain http:// only for a loopback
 * development host; see ./endpoint-url.ts), checked before anything is
 * stored. `options.store` exists for the offline check scripts.
 */
export async function setEndpointOverride(
  chainId: string,
  url: string,
  options: { store?: KeyValueStore } = {},
): Promise<void> {
  const store = options.store ?? AsyncStorage;
  if (networkDefaultFor(chainId)?.kind === 'blockbook') {
    // Blockbook chains are configured (URL + API key, with save-time
    // verification) through ../wallet/blockbook.ts; an override written
    // here would be silently ignored by getAllEndpoints, so refuse loudly.
    throw new Error('This chain uses a Blockbook endpoint; configure it in its own section.');
  }
  const normalized = assertSecureEndpointUrl(url);
  const overrides = await loadOverrides(store);
  overrides[chainId] = normalized;
  await saveOverrides(overrides, store);
}

/**
 * Removes the override so the chain returns to its verified default. Also
 * the way to remove a stored override that is ignored because it fails the
 * https rule. `options.store` exists for the offline check scripts.
 */
export async function resetEndpoint(
  chainId: string,
  options: { store?: KeyValueStore } = {},
): Promise<void> {
  const store = options.store ?? AsyncStorage;
  const overrides = await loadOverrides(store);
  if (chainId in overrides) {
    delete overrides[chainId];
    await saveOverrides(overrides, store);
  }
}

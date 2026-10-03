import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  NodeClient,
  httpTransport,
  verifyTransfersEndpoint,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extension: this module is imported by scripts/check-indexer.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import type { KeyValueStore } from './tokens.ts';
import { assertSecureEndpointUrl } from '../config/endpoint-url.ts';
import type { TransportFactory } from './aa.ts';

/**
 * Per-EVM-chain transaction-history indexer configuration: the URL of an
 * endpoint that serves Alchemy's Transfers API (alchemy_getAssetTransfers;
 * see packages/chains-evm/src/indexer-history.ts for the verified API
 * shapes). Same verify-before-save discipline as ./aa.ts: the setter
 * refuses to persist a URL that fails verification, so a configured URL is
 * a verified one by construction.
 *
 * The URL is user-pasted runtime configuration and usually embeds the
 * user's own API key (e.g. https://<host>/v2/<key>). It lives in
 * AsyncStorage on this device only — like the other endpoint overrides in
 * config/networks.ts it is never bundled, committed, or sent anywhere
 * except to the endpoint itself. It stays out of expo-secure-store on
 * purpose: wallet/storage.ts remains the only module touching the secure
 * store, which holds only the mnemonic.
 */

const INDEXER_CONFIG_KEY = 'shiba-wallet.evm-indexer.v1';

export interface IndexerConfig {
  url: string | null;
  /** ISO timestamp of the successful save-time verification. */
  verifiedAt: string | null;
  /**
   * Non-null when a URL is stored but fails the https rule on read
   * (../config/endpoint-url.ts): the reason, for Settings' status line.
   * The stored URL is then NOT used (`url` reads as null, so history shows
   * the unconfigured state) and stays stored until the user clears it.
   */
  ignoredUrlReason: string | null;
}

type ConfigMap = Record<string, { url?: unknown; verifiedAt?: unknown }>;

/**
 * Applies the https rule to a stored URL. Values saved before the rule
 * existed (dev/emulator installs only) may be plain http://; those are
 * reported as ignored rather than used or silently deleted.
 */
function checkStoredUrl(stored: string | null): { url: string | null; ignoredUrlReason: string | null } {
  if (stored === null) return { url: null, ignoredUrlReason: null };
  try {
    assertSecureEndpointUrl(stored);
    return { url: stored, ignoredUrlReason: null };
  } catch (e) {
    return { url: null, ignoredUrlReason: e instanceof Error ? e.message : String(e) };
  }
}

async function loadConfigMap(store: KeyValueStore): Promise<ConfigMap> {
  try {
    const raw = await store.getItem(INDEXER_CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ConfigMap;
    }
    return {};
  } catch {
    // Corrupt JSON or unavailable storage: behave as unconfigured rather
    // than break Settings or the Activity screen (aa.ts discipline).
    return {};
  }
}

async function saveConfigMap(map: ConfigMap, store: KeyValueStore): Promise<void> {
  await store.setItem(INDEXER_CONFIG_KEY, JSON.stringify(map));
}

/** The stored indexer configuration for one chain (nulls when unset). */
export async function getIndexerConfig(
  chainId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<IndexerConfig> {
  const map = await loadConfigMap(store);
  const entry = map[chainId];
  const { url, ignoredUrlReason } = checkStoredUrl(
    typeof entry?.url === 'string' && entry.url !== '' ? entry.url : null,
  );
  return {
    url,
    verifiedAt:
      url && typeof entry?.verifiedAt === 'string' && entry.verifiedAt !== ''
        ? entry.verifiedAt
        : null,
    ignoredUrlReason,
  };
}

/**
 * Verifies and saves an indexer URL for one chain; throws (persisting
 * nothing) when any check fails. Checks, in order:
 *  1. the URL is https:// (plain http:// only for a loopback development
 *     host; ../config/endpoint-url.ts), before any request is made;
 *  2. eth_chainId on the endpoint matches the chain being configured, so a
 *     pasted testnet URL cannot silently serve wrong-chain history (the
 *     same guard the send flow applies to RPC endpoints; Alchemy-style
 *     endpoints serve node methods and the transfers namespace on one URL);
 *  3. alchemy_getAssetTransfers with maxCount 0x1 for the wallet's own
 *     address returns a well-formed response
 *     (packages/chains-evm verifyTransfersEndpoint).
 */
export async function setIndexerUrl(
  chainId: string,
  url: string,
  walletAddress: string,
  options: { store?: KeyValueStore; transportFor?: TransportFactory } = {},
): Promise<void> {
  const store = options.store ?? AsyncStorage;
  const transportFor = options.transportFor ?? httpTransport;
  const trimmed = assertSecureEndpointUrl(url);
  const expected = BigInt(chainId.split(':')[1] ?? '');
  const transport = transportFor(trimmed);
  const actual = await new NodeClient(transport).chainId();
  if (actual !== expected) {
    throw new Error(
      `Endpoint is chain id ${actual}, expected ${expected}. ` +
        'Paste the indexer URL for this chain, not another network.',
    );
  }
  await verifyTransfersEndpoint(transport, walletAddress);
  const map = await loadConfigMap(store);
  map[chainId] = { url: trimmed, verifiedAt: new Date().toISOString() };
  await saveConfigMap(map, store);
}

/** Removes the stored indexer URL for one chain. */
export async function clearIndexerUrl(
  chainId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<void> {
  const map = await loadConfigMap(store);
  if (map[chainId]) {
    delete map[chainId];
    await saveConfigMap(map, store);
  }
}

import AsyncStorage from '@react-native-async-storage/async-storage';
// Explicit .ts extension: this module is imported by scripts/check-doge.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import type { KeyValueStore } from './tokens.ts';

/**
 * Per-chain Blockbook endpoint configuration (Dogecoin in this pass): the
 * base URL of a Trezor Blockbook instance plus an optional API key. Same
 * verify-before-save discipline as ./aa.ts and ./indexer.ts: the setter
 * refuses to persist anything that fails a live verification, so a
 * configured endpoint is a verified one by construction.
 *
 * The URL and the API key are user-pasted runtime configuration. They live
 * in AsyncStorage on this device only — like the endpoint overrides in
 * config/networks.ts they are never bundled, committed, or sent anywhere
 * except to the configured host itself (the key travels solely as the
 * BLOCKBOOK_API_KEY_HEADER request header on calls to that base URL). They
 * stay out of expo-secure-store on purpose: wallet/storage.ts remains the
 * only module touching the secure store, which holds only the mnemonic.
 */

const BLOCKBOOK_CONFIG_KEY = 'shiba-wallet.blockbook.v1';

/**
 * The request-header name the API key is sent under. NOWNodes — the hosted
 * Blockbook provider verified live for Dogecoin on 2026-09-27 (see
 * AGENTS.md, phase 2 task 8) — authenticates with an `api-key` header
 * (documented at nownodes.io; confirmed by live requests: getUtxos answers
 * with the header and returns 401 without it). Blockbook itself has no
 * standard auth, so self-hosted instances simply ignore the header.
 */
export const BLOCKBOOK_API_KEY_HEADER = 'api-key';

/** Headers for the engine's blockbookTransport/blockbookHistoryProvider. */
export function blockbookHeaders(apiKey: string | null): Record<string, string> | undefined {
  return apiKey ? { [BLOCKBOOK_API_KEY_HEADER]: apiKey } : undefined;
}

export interface BlockbookConfig {
  /** Base URL (no /api/v2 suffix), or null when unconfigured. */
  url: string | null;
  /** Optional API key sent as the BLOCKBOOK_API_KEY_HEADER header. */
  apiKey: string | null;
  /** ISO timestamp of the successful save-time verification. */
  verifiedAt: string | null;
}

type ConfigMap = Record<string, { url?: unknown; apiKey?: unknown; verifiedAt?: unknown }>;

async function loadConfigMap(store: KeyValueStore): Promise<ConfigMap> {
  try {
    const raw = await store.getItem(BLOCKBOOK_CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ConfigMap;
    }
    return {};
  } catch {
    // Corrupt JSON or unavailable storage: behave as unconfigured rather
    // than break Settings, Home or the send flow (aa.ts discipline).
    return {};
  }
}

async function saveConfigMap(map: ConfigMap, store: KeyValueStore): Promise<void> {
  await store.setItem(BLOCKBOOK_CONFIG_KEY, JSON.stringify(map));
}

/** The stored Blockbook configuration for one chain (nulls when unset). */
export async function getBlockbookConfig(
  chainId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<BlockbookConfig> {
  const map = await loadConfigMap(store);
  const entry = map[chainId];
  const url = typeof entry?.url === 'string' && entry.url !== '' ? entry.url : null;
  return {
    url,
    apiKey:
      url && typeof entry?.apiKey === 'string' && entry.apiKey !== '' ? entry.apiKey : null,
    verifiedAt:
      url && typeof entry?.verifiedAt === 'string' && entry.verifiedAt !== ''
        ? entry.verifiedAt
        : null,
  };
}

const URL_PATTERN = /^https?:\/\/.+/;

/**
 * Verifies and saves a Blockbook endpoint (URL + optional API key) for one
 * chain; throws (persisting nothing) when any check fails. Checks:
 *  1. the URL is well-formed http(s);
 *  2. a live GET {url}/api/v2/utxo/{walletAddress} — the exact request the
 *     engine's blockbookTransport.getUtxos makes for balances and coin
 *     selection, with the API key attached — answers HTTP 2xx with a JSON
 *     array (the documented Blockbook UTXO shape; an auth failure, an HTML
 *     browser-check page, or a non-Blockbook API all fail this). The
 *     wallet's own address is used, so verification doubles as the first
 *     balance read.
 */
export async function setBlockbookEndpoint(
  chainId: string,
  url: string,
  apiKey: string,
  walletAddress: string,
  options: { store?: KeyValueStore; fetchFn?: typeof fetch } = {},
): Promise<void> {
  const store = options.store ?? AsyncStorage;
  const fetchFn = options.fetchFn ?? fetch;
  const trimmedUrl = url.trim().replace(/\/+$/, '');
  const trimmedKey = apiKey.trim();
  if (!URL_PATTERN.test(trimmedUrl)) {
    throw new Error('Blockbook endpoint must be an http(s):// URL');
  }
  if (!walletAddress) {
    throw new Error('No wallet address is available to verify the endpoint with.');
  }
  let response: Response;
  try {
    response = await fetchFn(`${trimmedUrl}/api/v2/utxo/${walletAddress}`, {
      headers: blockbookHeaders(trimmedKey || null),
    });
  } catch (e) {
    throw new Error(
      `Could not reach the endpoint: ${e instanceof Error ? e.message : 'network error'}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Endpoint rejected the UTXO query: HTTP ${response.status}` +
        (response.status === 401 || response.status === 403
          ? ' — check the API key.'
          : '.'),
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Endpoint did not answer with JSON — not a Blockbook API.');
  }
  if (!Array.isArray(body)) {
    throw new Error(
      'Endpoint answered, but not with the Blockbook UTXO array shape ' +
        '(GET /api/v2/utxo/{address} must return a JSON array).',
    );
  }
  const map = await loadConfigMap(store);
  map[chainId] = {
    url: trimmedUrl,
    ...(trimmedKey ? { apiKey: trimmedKey } : {}),
    verifiedAt: new Date().toISOString(),
  };
  await saveConfigMap(map, store);
}

/** Removes the stored Blockbook configuration for one chain. */
export async function clearBlockbookConfig(
  chainId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<void> {
  const map = await loadConfigMap(store);
  if (map[chainId]) {
    delete map[chainId];
    await saveConfigMap(map, store);
  }
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NetworkDefault } from './defaults';
import { networkDefaultFor, resolveActiveNetworks } from './defaults';
import { loadPrefs } from './prefs';
import { blockbookHeaders, getBlockbookConfig } from '../wallet/blockbook';

/**
 * Per-chain RPC/REST endpoint configuration: verified public defaults (see
 * ./defaults.ts) plus user overrides.
 *
 * Overrides live in AsyncStorage, NOT expo-secure-store: endpoint URLs are
 * public configuration, not secrets, and keeping them out of secure storage
 * preserves the invariant that src/wallet/storage.ts is the only module
 * touching the secure store (which holds only the mnemonic).
 *
 * SEPOLIA TEST MODE (phase 4, item 6): the resolvers below are the single
 * place where the app's EVM "slot" ('eip155:1', the id accounts and routes
 * carry) is translated to the ACTIVE EVM network. With the Settings
 * developer toggle on, the Ethereum slot resolves to the Sepolia network
 * (see resolveActiveNetworks in ./defaults.ts); overrides are keyed by the
 * ACTIVE chain's CAIP-2 id, so a custom Sepolia RPC and a custom mainnet
 * RPC are stored under different keys and can never bleed into each other.
 */

const OVERRIDES_KEY = 'shiba-wallet.rpc-endpoints.v1';

type OverrideMap = Record<string, string>;

async function loadOverrides(): Promise<OverrideMap> {
  try {
    const raw = await AsyncStorage.getItem(OVERRIDES_KEY);
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

async function saveOverrides(map: OverrideMap): Promise<void> {
  await AsyncStorage.setItem(OVERRIDES_KEY, JSON.stringify(map));
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
}

/**
 * Resolves the effective endpoint for one chain. Accepts either a slot id
 * (the mainnet CAIP-2 ids accounts and routes carry) or the active
 * network's own chain id (e.g. 'eip155:11155111' while Sepolia mode is on).
 */
export async function getEndpoint(chainId: string): Promise<NetworkEndpoint | undefined> {
  const all = await getAllEndpoints();
  return all.find((e) => e.forChainId === chainId || e.network.chainId === chainId);
}

/** Resolves every chain's effective endpoint (Settings list, Home refresh). */
export async function getAllEndpoints(): Promise<NetworkEndpoint[]> {
  const [overrides, prefs] = await Promise.all([loadOverrides(), loadPrefs()]);
  return Promise.all(
    resolveActiveNetworks(prefs.sepolia).map(async ({ slot, network }) => {
      if (network.kind === 'blockbook') {
        // Blockbook chains (Dogecoin) resolve from their own verified
        // config store (URL + optional API key, ../wallet/blockbook.ts),
        // not the plain URL-override map: a stored URL there passed the
        // save-time UTXO-query verification by construction.
        const config = await getBlockbookConfig(network.chainId);
        const headers = blockbookHeaders(config.apiKey);
        return {
          forChainId: slot,
          network,
          url: config.url,
          isOverride: config.url !== null,
          ...(headers ? { headers } : {}),
        };
      }
      // Keyed by the ACTIVE chain id: mainnet and Sepolia overrides live
      // under different keys and never mix.
      const override = overrides[network.chainId];
      return {
        forChainId: slot,
        network,
        url: override ?? network.defaultUrl,
        isOverride: override !== undefined,
      };
    }),
  );
}

/**
 * Sets a user override. Throws on obviously invalid input so Settings can
 * surface the message; only http(s) URLs make sense for these transports.
 */
export async function setEndpointOverride(chainId: string, url: string): Promise<void> {
  if (networkDefaultFor(chainId)?.kind === 'blockbook') {
    // Blockbook chains are configured (URL + API key, with save-time
    // verification) through ../wallet/blockbook.ts; an override written
    // here would be silently ignored by getAllEndpoints, so refuse loudly.
    throw new Error('This chain uses a Blockbook endpoint; configure it in its own section.');
  }
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(trimmed)) {
    throw new Error('Endpoint must be an http(s):// URL');
  }
  const overrides = await loadOverrides();
  overrides[chainId] = trimmed;
  await saveOverrides(overrides);
}

/** Removes the override so the chain returns to its verified default. */
export async function resetEndpoint(chainId: string): Promise<void> {
  const overrides = await loadOverrides();
  if (chainId in overrides) {
    delete overrides[chainId];
    await saveOverrides(overrides);
  }
}

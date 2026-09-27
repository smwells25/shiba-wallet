import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NetworkDefault } from './defaults';
import { DEFAULT_NETWORKS, networkDefaultFor } from './defaults';

/**
 * Per-chain RPC/REST endpoint configuration: verified public defaults (see
 * ./defaults.ts) plus user overrides.
 *
 * Overrides live in AsyncStorage, NOT expo-secure-store: endpoint URLs are
 * public configuration, not secrets, and keeping them out of secure storage
 * preserves the invariant that src/wallet/storage.ts is the only module
 * touching the secure store (which holds only the mnemonic).
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
  network: NetworkDefault;
  /** The URL balance fetches should use right now (override or default). */
  url: string | null;
  /** True when the URL comes from a user override. */
  isOverride: boolean;
}

/** Resolves the effective endpoint for one chain. */
export async function getEndpoint(chainId: string): Promise<NetworkEndpoint | undefined> {
  const network = networkDefaultFor(chainId);
  if (!network) return undefined;
  const overrides = await loadOverrides();
  const override = overrides[chainId];
  return {
    network,
    url: override ?? network.defaultUrl,
    isOverride: override !== undefined,
  };
}

/** Resolves every chain's effective endpoint (Settings list, Home refresh). */
export async function getAllEndpoints(): Promise<NetworkEndpoint[]> {
  const overrides = await loadOverrides();
  return DEFAULT_NETWORKS.map((network) => {
    const override = overrides[network.chainId];
    return {
      network,
      url: override ?? network.defaultUrl,
      isOverride: override !== undefined,
    };
  });
}

/**
 * Sets a user override. Throws on obviously invalid input so Settings can
 * surface the message; only http(s) URLs make sense for these transports.
 */
export async function setEndpointOverride(chainId: string, url: string): Promise<void> {
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

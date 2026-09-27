import AsyncStorage from '@react-native-async-storage/async-storage';
import { AssetRegistry, formatAssetId } from '@shiba-wallet/core';
import type { Asset, FungibleAsset } from '@shiba-wallet/core';
// Explicit .ts extensions: this module is imported by scripts/check-tokens.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import { EVM_CHAIN_ID } from './send.ts';
import { USDC_MAINNET } from './erc20.ts';

/**
 * The user's tracked ERC-20 token list, persisted in AsyncStorage as the
 * JSON produced by core's AssetRegistry.toJSON and rehydrated with
 * AssetRegistry.fromJSON. Tokens are identified by CAIP-19 ids (e.g.
 * "eip155:1/erc20:0xA0b8...eB48"), so the store is chain-agnostic even
 * though this phase only tracks Ethereum-mainnet ERC-20s.
 *
 * AsyncStorage, not expo-secure-store: like RPC endpoints (see
 * config/networks.ts), the token list is public configuration, not secret
 * key material, and keeping it out of secure storage preserves the
 * invariant that wallet/storage.ts is the only module touching the secure
 * store.
 *
 * Persistence semantics: a MISSING key means "never customized" and yields
 * the default list (exactly one token, USDC — see USDC_MAINNET in
 * ./erc20.ts for the address verification). A PRESENT key — even an empty
 * array — is the user's list verbatim, so removing USDC sticks across
 * restarts instead of being resurrected by the default.
 *
 * Every function takes an injectable KeyValueStore (AsyncStorage satisfies
 * the interface directly) so scripts/check-tokens.mjs can exercise the
 * exact store logic under Node with an in-memory map.
 */

const TOKENS_KEY = 'shiba-wallet.tokens.v1';

/** The subset of the AsyncStorage API the store needs (injectable). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Type guard for one persisted entry; malformed entries are dropped. */
function isFungibleAsset(value: unknown): value is FungibleAsset {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Partial<FungibleAsset>;
  return (
    a.kind === 'fungible' &&
    typeof a.symbol === 'string' &&
    typeof a.name === 'string' &&
    typeof a.decimals === 'number' &&
    Number.isInteger(a.decimals) &&
    a.decimals >= 0 &&
    a.decimals <= 255 &&
    typeof a.assetId === 'object' &&
    a.assetId !== null &&
    typeof a.assetId.chainId === 'string' &&
    typeof a.assetId.namespace === 'string' &&
    typeof a.assetId.reference === 'string'
  );
}

/**
 * Loads the tracked-token registry. Corrupt JSON falls back to the default
 * list without overwriting the stored value (same discipline as
 * config/networks.ts: never let a bad read break the UI, never destroy
 * data on a possibly-transient failure).
 */
export async function loadTokenRegistry(store: KeyValueStore = AsyncStorage): Promise<AssetRegistry> {
  let raw: string | null = null;
  try {
    raw = await store.getItem(TOKENS_KEY);
  } catch {
    raw = null;
  }
  if (raw === null) {
    return AssetRegistry.fromJSON([USDC_MAINNET]);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return AssetRegistry.fromJSON([USDC_MAINNET]);
    // fromJSON validates each CAIP-19 id (formatAssetId throws on bad
    // ids); the guard above drops entries with wrong shapes/decimals.
    return AssetRegistry.fromJSON(parsed.filter(isFungibleAsset));
  } catch {
    return AssetRegistry.fromJSON([USDC_MAINNET]);
  }
}

async function saveTokenRegistry(registry: AssetRegistry, store: KeyValueStore): Promise<void> {
  await store.setItem(TOKENS_KEY, JSON.stringify(registry.toJSON()));
}

/** The tracked ERC-20 tokens (this phase: Ethereum mainnet only). */
export async function listTokens(store: KeyValueStore = AsyncStorage): Promise<FungibleAsset[]> {
  const registry = await loadTokenRegistry(store);
  return registry
    .list(EVM_CHAIN_ID)
    .filter((a): a is FungibleAsset => a.kind === 'fungible' && a.assetId.namespace === 'erc20');
}

/**
 * Adds a token. Rejects duplicates by CAIP-19 id — contract addresses are
 * normalized to their EIP-55 checksummed form before the asset is built
 * (see validateErc20ContractAddress), so the same contract can never slip
 * in twice under different casings.
 */
export async function addToken(
  asset: FungibleAsset,
  store: KeyValueStore = AsyncStorage,
): Promise<void> {
  const registry = await loadTokenRegistry(store);
  const id = formatAssetId(asset.assetId);
  if (registry.get(id)) {
    throw new Error(`This token is already in your list (${id}).`);
  }
  registry.add(asset as Asset);
  await saveTokenRegistry(registry, store);
}

/**
 * Removes a token by CAIP-19 id. Nothing is special-cased: the default
 * USDC entry is removable like any other, and stays removed (see the
 * persistence semantics above).
 */
export async function removeToken(
  assetId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<boolean> {
  const registry = await loadTokenRegistry(store);
  const removed = registry.remove(assetId);
  if (removed) await saveTokenRegistry(registry, store);
  return removed;
}

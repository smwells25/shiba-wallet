import AsyncStorage from '@react-native-async-storage/async-storage';
import { AssetRegistry, formatAssetId, parseAssetId } from '@shiba-wallet/core';
import type { Asset, FungibleAsset } from '@shiba-wallet/core';
// Explicit .ts extensions: this module is imported by scripts/check-tokens.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import { USDC_MAINNET } from './erc20.ts';
import { EVM_MAINNET, EVM_PROFILES, evmProfileByCaip2, evmProfileFor } from '../config/evm-chain.ts';
import { loadPrefs } from '../config/prefs.ts';

/**
 * The user's tracked ERC-20 token lists, ONE PER EVM CHAIN (phase 13 item
 * 1): Ethereum mainnet (eip155:1), Ethereum Sepolia (eip155:11155111) and
 * Base Sepolia (eip155:84532) — every profile in config/evm-chain.ts. Each
 * list is persisted in AsyncStorage as the JSON produced by core's
 * AssetRegistry.toJSON and rehydrated with AssetRegistry.fromJSON. Tokens
 * are identified by CAIP-19 ids (e.g. "eip155:1/erc20:0xA0b8...eB48"), and
 * every consumer reads the list of the ACTIVE profile only, so a Sepolia
 * token can never appear (or be priced, or be sent) in mainnet mode and a
 * mainnet token never in a test mode.
 *
 * STORAGE KEYS AND THE MIGRATION RULE. Ethereum mainnet keeps the original
 * key, shiba-wallet.tokens.v1, byte for byte: an existing user's stored
 * list IS the mainnet list, nothing is copied or rewritten, and the value
 * is only written again when the user adds or removes a mainnet token
 * (which writes the same JSON shape as before). Every other chain has its
 * own key, shiba-wallet.tokens.v1.<CAIP-2> (for example
 * "shiba-wallet.tokens.v1.eip155:11155111"), so editing a test-network list
 * never touches the mainnet value. Each key's list is filtered to its own
 * chain when read; an entry for another chain inside a key (never written
 * by this app) is kept in storage but never shown.
 *
 * AsyncStorage, not expo-secure-store: like RPC endpoints (see
 * config/networks.ts), the token list is public configuration, not secret
 * key material, and keeping it out of secure storage preserves the
 * invariant that wallet/storage.ts is the only module touching the secure
 * store.
 *
 * Persistence semantics, per chain: a MISSING key means "never customized"
 * and yields that chain's defaults — on mainnet exactly one token, USDC
 * (see USDC_MAINNET in ./erc20.ts for the address verification), and on a
 * test network the tokens the wallet knows there (Circle's test USDC and
 * EURC, KNOWN_TEST_NETWORK_TOKENS below). A PRESENT key — even an empty
 * array — is the user's list verbatim, so removing a default sticks across
 * restarts instead of being resurrected.
 *
 * Every function takes an injectable KeyValueStore (AsyncStorage satisfies
 * the interface directly) so scripts/check-tokens.mjs can exercise the
 * exact store logic under Node with an in-memory map.
 */

/** The mainnet key: unchanged since phase 3, so existing lists stay as they are. */
export const MAINNET_TOKENS_KEY = 'shiba-wallet.tokens.v1';

/** The AsyncStorage key holding one chain's tracked list. */
export function tokenStoreKey(chainCaip2: string): string {
  return chainCaip2 === EVM_MAINNET.caip2 ? MAINNET_TOKENS_KEY : `${MAINNET_TOKENS_KEY}.${chainCaip2}`;
}

/** The subset of the AsyncStorage API the store needs (injectable). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** True when the app has an EVM profile for this CAIP-2 id (only those chains hold tokens). */
export function isTokenChain(chainCaip2: string): boolean {
  return evmProfileByCaip2(chainCaip2) !== undefined;
}

/**
 * The list a chain starts with before the user edits it: USDC on mainnet,
 * the known test-network tokens on a test network, nothing elsewhere.
 */
export function defaultTokensForChain(chainCaip2: string): FungibleAsset[] {
  if (chainCaip2 === EVM_MAINNET.caip2) return [USDC_MAINNET];
  return knownTokensForChain(chainCaip2);
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
 * Loads the registry stored under one chain's key. Corrupt JSON falls back
 * to that chain's defaults without overwriting the stored value (same
 * discipline as config/networks.ts: never let a bad read break the UI,
 * never destroy data on a possibly-transient failure). The registry may
 * contain entries for other chains (see the key rule above); callers list
 * it with the chain filter.
 */
export async function loadTokenRegistry(
  chainCaip2: string,
  store: KeyValueStore = AsyncStorage,
): Promise<AssetRegistry> {
  const defaults = () => AssetRegistry.fromJSON(defaultTokensForChain(chainCaip2));
  let raw: string | null = null;
  try {
    raw = await store.getItem(tokenStoreKey(chainCaip2));
  } catch {
    raw = null;
  }
  if (raw === null) return defaults();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return defaults();
    // fromJSON validates each CAIP-19 id (formatAssetId throws on bad
    // ids); the guard above drops entries with wrong shapes/decimals.
    return AssetRegistry.fromJSON(parsed.filter(isFungibleAsset));
  } catch {
    return defaults();
  }
}

async function saveTokenRegistry(
  chainCaip2: string,
  registry: AssetRegistry,
  store: KeyValueStore,
): Promise<void> {
  await store.setItem(tokenStoreKey(chainCaip2), JSON.stringify(registry.toJSON()));
}

/**
 * The CAIP-2 id of the ACTIVE EVM profile, read from the stored preferences
 * (config/prefs.ts testNetwork) in the same store. Used when a caller does
 * not name a chain, so a module that cannot reach React state (for example
 * a component another slice owns) still gets the active profile's list.
 */
export async function activeTokenChain(store: KeyValueStore = AsyncStorage): Promise<string> {
  const prefs = await loadPrefs(store);
  return evmProfileFor(prefs.testNetwork).caip2;
}

/**
 * The tracked ERC-20 tokens on one chain, in stored order. `chainCaip2`
 * defaults to the ACTIVE profile's chain (activeTokenChain); screens pass
 * their own `evmChain.caip2` explicitly so the list always matches the
 * chain they render.
 */
export async function listTokens(
  chainCaip2?: string,
  store: KeyValueStore = AsyncStorage,
): Promise<FungibleAsset[]> {
  const chain = chainCaip2 ?? (await activeTokenChain(store));
  if (!isTokenChain(chain)) return [];
  const registry = await loadTokenRegistry(chain, store);
  return registry
    .list(chain)
    .filter((a): a is FungibleAsset => a.kind === 'fungible' && a.assetId.namespace === 'erc20');
}

/**
 * Adds a token to the list of ITS OWN chain (the asset's CAIP-19 chain id).
 * Refuses chains the app has no profile for, non-ERC-20 assets, and
 * duplicates by CAIP-19 id — contract addresses are normalized to their
 * EIP-55 checksummed form before the asset is built (see
 * validateErc20ContractAddress), so the same contract can never slip in
 * twice under different casings.
 */
export async function addToken(
  asset: FungibleAsset,
  store: KeyValueStore = AsyncStorage,
): Promise<void> {
  const chain = asset.assetId.chainId;
  if (!isTokenChain(chain)) {
    throw new Error(`Tokens can only be tracked on ${EVM_PROFILES.map((p) => p.label).join(', ')} (got ${chain}).`);
  }
  if (asset.kind !== 'fungible' || asset.assetId.namespace !== 'erc20') {
    throw new Error('Only ERC-20 tokens can be tracked.');
  }
  const registry = await loadTokenRegistry(chain, store);
  const id = formatAssetId(asset.assetId);
  if (registry.get(id)) {
    throw new Error(`This token is already in your list (${id}).`);
  }
  registry.add(asset as Asset);
  await saveTokenRegistry(chain, registry, store);
}

/**
 * Removes a token by CAIP-19 id from the list of the chain the id names.
 * Nothing is special-cased: the default entries are removable like any
 * other, and stay removed (see the persistence semantics above).
 */
export async function removeToken(
  assetId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<boolean> {
  let chain: string;
  try {
    chain = parseAssetId(assetId).chainId;
  } catch {
    return false;
  }
  if (!isTokenChain(chain)) return false;
  const registry = await loadTokenRegistry(chain, store);
  const removed = registry.remove(assetId);
  if (removed) await saveTokenRegistry(chain, registry, store);
  return removed;
}

// ---------------------------------------------------------------------------
// Known test-network tokens (phase 11 item 6 follow-up F1)
// ---------------------------------------------------------------------------

/**
 * Tokens the wallet KNOWS on each test network. Since phase 13 item 1 they
 * are a test network's DEFAULT tracked list (defaultTokensForChain above),
 * and they stay read-only reference data for the approvals manager and the
 * first-interaction risk check (approvals.ts, risk.ts) and the subscription
 * token list (subscriptions.ts), which consult them even when the user has
 * removed them from the tracked list: the live Sepolia USDC → Permit2
 * allowance left by the Uniswap swaps must stay visible either way
 * (emulator pass finding F1, 2026-10-03).
 *
 * Every address was checked against the issuer's documentation AND the
 * chain:
 *  - Circle, "USDC contract addresses"
 *    (https://developers.circle.com/stablecoins/usdc-contract-addresses,
 *    fetched 2026-10-03 and again 2026-10-04): Ethereum Sepolia
 *    0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 and Base Sepolia
 *    0x036CbD53842c5426634e7929541eC2318f3dCF7e;
 *  - Circle, "EURC contract addresses"
 *    (https://developers.circle.com/stablecoins/eurc-contract-addresses,
 *    fetched 2026-10-03 and again 2026-10-04): Ethereum Sepolia
 *    0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4 (also recorded in AGENTS.md,
 *    2026-10-02 WalletConnect retest) and, listed on the page as fetched
 *    2026-10-04 (it was not on the page the day before), Base Sepolia
 *    0x808456652fdb597867f38412077A9182bf77359F;
 *  - live eth_call reads on 2026-10-04 (ethereum-sepolia-rpc.publicnode.com,
 *    which answered eth_chainId 0xaa36a7, and both
 *    base-sepolia-rpc.publicnode.com and sepolia.base.org, which answered
 *    0x14a34): symbol() and name() "USDC" / "EURC", decimals() 6 for all
 *    four.
 */
export const KNOWN_TEST_NETWORK_TOKENS: Readonly<Record<string, readonly FungibleAsset[]>> = {
  'eip155:11155111': [
    {
      kind: 'fungible',
      assetId: {
        chainId: 'eip155:11155111',
        namespace: 'erc20',
        reference: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      },
      symbol: 'USDC',
      name: 'USDC',
      decimals: 6,
    },
    {
      kind: 'fungible',
      assetId: {
        chainId: 'eip155:11155111',
        namespace: 'erc20',
        reference: '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4',
      },
      symbol: 'EURC',
      name: 'EURC',
      decimals: 6,
    },
  ],
  'eip155:84532': [
    {
      kind: 'fungible',
      assetId: {
        chainId: 'eip155:84532',
        namespace: 'erc20',
        reference: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      symbol: 'USDC',
      name: 'USDC',
      decimals: 6,
    },
    {
      kind: 'fungible',
      assetId: {
        chainId: 'eip155:84532',
        namespace: 'erc20',
        reference: '0x808456652fdb597867f38412077A9182bf77359F',
      },
      symbol: 'EURC',
      name: 'EURC',
      decimals: 6,
    },
  ],
};

/** The known tokens on one CAIP-2 chain (empty for mainnet and unknown chains). */
export function knownTokensForChain(chainCaip2: string): FungibleAsset[] {
  return [...(KNOWN_TEST_NETWORK_TOKENS[chainCaip2] ?? [])];
}

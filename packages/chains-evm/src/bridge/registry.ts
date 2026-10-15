import type { BridgeProvider, BridgeProviderId, BridgeRoute } from './types.js';
import { checksumAddress } from './util.js';

/**
 * The bridge provider registry, keyed by provider id (the D3 pattern of
 * docs/ARCHITECTURE.md section 7, applied to bridges). It holds providers
 * and answers lookups; it never makes a network request and never chooses
 * a provider for the user: the Bridge screen lists every provider that
 * serves a route and the user picks one (the Chairperson's decision of
 * 2026-10-14, recorded in AGENTS.md).
 */

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

export class BridgeRegistryError extends Error {
  override name = 'BridgeRegistryError';
}

function validateRoute(provider: BridgeProvider, route: BridgeRoute): void {
  if (route.providerId !== provider.id) {
    throw new BridgeRegistryError(
      `Provider ${provider.id} lists a route that belongs to ${route.providerId}; nothing was registered.`,
    );
  }
  for (const chainId of [route.sourceChainId, route.destinationChainId]) {
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new BridgeRegistryError(`Provider ${provider.id} lists a route with an invalid chain id; nothing was registered.`);
    }
  }
  if (route.sourceChainId === route.destinationChainId) {
    throw new BridgeRegistryError(
      `Provider ${provider.id} lists a route from chain ${route.sourceChainId} to itself; nothing was registered.`,
    );
  }
  for (const asset of [route.sourceAsset, route.destinationAsset]) {
    if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 77) {
      throw new BridgeRegistryError(`Provider ${provider.id} lists an asset with invalid decimals; nothing was registered.`);
    }
    if (asset.kind === 'erc20') checksumAddress(asset.address, `${provider.id} route token`);
  }
}

export class BridgeRegistry {
  private readonly providers = new Map<BridgeProviderId, BridgeProvider>();

  /** Adds a provider. Refuses a malformed id, a duplicate id and malformed routes. */
  register(provider: BridgeProvider): void {
    if (typeof provider.id !== 'string' || !PROVIDER_ID.test(provider.id)) {
      throw new BridgeRegistryError(
        `A bridge provider id must be 2 to 40 lower-case letters, digits or hyphens; got ${JSON.stringify(provider.id)}.`,
      );
    }
    if (this.providers.has(provider.id)) {
      throw new BridgeRegistryError(`A bridge provider with id ${provider.id} is already registered.`);
    }
    if (!provider.label || !provider.trust?.verification || !provider.trust.control || !provider.trust.refundRule) {
      throw new BridgeRegistryError(
        `Provider ${provider.id} must state a label, who verifies transfers, who controls the contracts and its refund rule.`,
      );
    }
    for (const route of provider.supportedRoutes()) validateRoute(provider, route);
    this.providers.set(provider.id, provider);
  }

  has(id: BridgeProviderId): boolean {
    return this.providers.has(id);
  }

  /** The provider registered under `id`, or undefined. */
  get(id: BridgeProviderId): BridgeProvider | undefined {
    return this.providers.get(id);
  }

  /** The provider registered under `id`; throws when none is. */
  require(id: BridgeProviderId): BridgeProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new BridgeRegistryError(`No bridge provider is registered with id ${id}.`);
    return provider;
  }

  /** Every provider, in registration order. */
  list(): BridgeProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Every route, across providers, that goes from `sourceChainId` to
   * `destinationChainId` (either may be omitted to list all). The app shows
   * each matching route with its provider so the user chooses.
   */
  routes(filter: { sourceChainId?: number; destinationChainId?: number } = {}): BridgeRoute[] {
    const out: BridgeRoute[] = [];
    for (const provider of this.providers.values()) {
      for (const route of provider.supportedRoutes()) {
        if (filter.sourceChainId !== undefined && route.sourceChainId !== filter.sourceChainId) continue;
        if (filter.destinationChainId !== undefined && route.destinationChainId !== filter.destinationChainId) continue;
        out.push(route);
      }
    }
    return out;
  }
}

export function createBridgeRegistry(providers: BridgeProvider[] = []): BridgeRegistry {
  const registry = new BridgeRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}

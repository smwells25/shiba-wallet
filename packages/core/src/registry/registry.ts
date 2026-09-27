import type { ChainKeyProvider } from '../chains/types.js';

/**
 * Runtime registry of chain integrations, keyed by CAIP-2 chain id. New
 * chains — potentially thousands — register here without any change to core.
 * Registration is explicit rather than automatic so an application controls
 * exactly which chain code it ships and trusts (supply-chain surface stays
 * opt-in per chain).
 */
export class ChainRegistry {
  private providers = new Map<string, ChainKeyProvider>();

  register(provider: ChainKeyProvider): void {
    if (this.providers.has(provider.chainId)) {
      throw new Error(`Chain already registered: ${provider.chainId}`);
    }
    this.providers.set(provider.chainId, provider);
  }

  get(chainId: string): ChainKeyProvider {
    const provider = this.providers.get(chainId);
    if (!provider) throw new Error(`Chain not registered: ${chainId}`);
    return provider;
  }

  has(chainId: string): boolean {
    return this.providers.has(chainId);
  }

  list(): ChainKeyProvider[] {
    return [...this.providers.values()];
  }
}

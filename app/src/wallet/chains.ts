import type { ChainKeyProvider } from '@shiba-wallet/core';
import {
  bitcoinKeyProvider,
  dogecoinKeyProvider,
  evmKeyProvider,
  solanaKeyProvider,
} from '@shiba-wallet/core';

/**
 * The four launch chains. Each entry pairs a core ChainKeyProvider (the
 * pure, offline key/address half of a chain integration) with app-level
 * display metadata. Adding a chain later means registering another provider
 * here — no screen code changes.
 */
export interface ChainInfo {
  provider: ChainKeyProvider;
  /** Ticker shown in the UI, e.g. "ETH". */
  symbol: string;
  /** Brand accent color for the chain badge. */
  accent: string;
}

export const CHAINS: ChainInfo[] = [
  { provider: evmKeyProvider, symbol: 'ETH', accent: '#627eea' },
  { provider: bitcoinKeyProvider, symbol: 'BTC', accent: '#f7931a' },
  { provider: dogecoinKeyProvider, symbol: 'DOGE', accent: '#c2a633' },
  { provider: solanaKeyProvider, symbol: 'SOL', accent: '#9945ff' },
];

export function chainByCaip2(chainId: string): ChainInfo | undefined {
  return CHAINS.find((c) => c.provider.chainId === chainId);
}

import type { ChainKeyProvider } from '@shiba-wallet/core';
import {
  bitcoinKeyProvider,
  bitcoinSignetKeyProvider,
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

/**
 * Bitcoin signet (phase 28 item 2): NOT a launch chain (it is not in CHAINS,
 * so the public-cache hydration, Home's cards and every per-chain list stay
 * the four launch chains); it is the network the Bitcoin slot uses while
 * Settings → Developer → "Use Bitcoin signet" is on. Listed here only so
 * signing (WalletContext signWith) can find its key provider by its CAIP-2 id.
 */
export const BITCOIN_SIGNET_CHAIN: ChainInfo = { provider: bitcoinSignetKeyProvider, symbol: 'BTC', accent: '#f7931a' };

export function chainByCaip2(chainId: string): ChainInfo | undefined {
  if (chainId === BITCOIN_SIGNET_CHAIN.provider.chainId) return BITCOIN_SIGNET_CHAIN;
  return CHAINS.find((c) => c.provider.chainId === chainId);
}

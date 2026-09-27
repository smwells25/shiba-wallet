/**
 * Shared testnet endpoints. All verified answering on 2026-09-27:
 * Sepolia eth_chainId returned 0xaa36a7 (11155111); both Bitcoin Esplora
 * endpoints returned a live /blocks/tip/height; Solana devnet getVersion
 * answered.
 *
 * Bitcoin test networks share address parameters (HRP "tb", same key
 * derivation), so the same dev-wallet address exists on all of them. The
 * smoke test checks each endpoint below and spends wherever the coins
 * actually are — the Chairperson's faucet funded testnet3.
 */
export const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
export const BTC_ESPLORAS = [
  { name: 'Bitcoin testnet3', url: 'https://blockstream.info/testnet/api' },
  { name: 'Bitcoin signet', url: 'https://mempool.space/signet/api' },
];
export const SOLANA_DEVNET = 'https://api.devnet.solana.com';

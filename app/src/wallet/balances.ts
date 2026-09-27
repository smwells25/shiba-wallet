import { httpTransport as evmHttpTransport } from '@shiba-wallet/chains-evm';
import { esploraTransport } from '@shiba-wallet/chains-utxo';
import { SolanaRpcClient, httpTransport as solanaHttpTransport } from '@shiba-wallet/chains-solana';
import type { NetworkKind } from '../config/defaults';

/**
 * Native-coin balance fetching over the engine's injected transports.
 *
 * This module is deliberately free of React Native imports so the Node
 * verification script (scripts/check-balances.mjs) can import it directly
 * and exercise the exact code the app runs. It contains no engine logic of
 * its own: each branch is a thin call into the corresponding engine
 * package's client, per ADR D5 (vendors are configuration, not code).
 */

/**
 * eth_getBalance over chains-evm's JSON-RPC transport. Method and params
 * per the Ethereum JSON-RPC spec (https://ethereum.org/en/developers/docs/
 * apis/json-rpc/#eth_getbalance): address + block tag, returns the wei
 * balance as a hex quantity.
 */
async function fetchEvmBalance(url: string, address: string): Promise<bigint> {
  const transport = evmHttpTransport(url);
  const result = (await transport('eth_getBalance', [address, 'latest'])) as string;
  return BigInt(result);
}

/**
 * Confirmed + mempool spendable balance as the sum of the address's UTXOs,
 * via chains-utxo's Esplora transport (GET /address/:addr/utxo). Summing
 * UTXOs equals what the wallet can actually spend, and reuses the exact
 * call the send flow will make for coin selection.
 */
async function fetchUtxoBalance(url: string, address: string): Promise<bigint> {
  const utxos = await esploraTransport(url).getUtxos(address);
  return utxos.reduce((sum, u) => sum + u.value, 0n);
}

/** Lamport balance via chains-solana's SolanaRpcClient.getBalance. */
async function fetchSolanaBalance(url: string, address: string): Promise<bigint> {
  const client = new SolanaRpcClient(solanaHttpTransport(url));
  return client.getBalance(address, 'confirmed');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches one chain's native balance in base units (wei/sat/lamports).
 * Retries once after a short delay: public endpoints flake, and a single
 * retry absorbs most transient failures without hammering anyone.
 */
export async function fetchNativeBalance(
  kind: NetworkKind,
  url: string,
  address: string,
  retryDelayMs = 750,
): Promise<bigint> {
  const attempt = (): Promise<bigint> => {
    switch (kind) {
      case 'evm-jsonrpc':
        return fetchEvmBalance(url, address);
      case 'esplora':
        return fetchUtxoBalance(url, address);
      case 'solana-jsonrpc':
        return fetchSolanaBalance(url, address);
    }
  };
  try {
    return await attempt();
  } catch {
    await sleep(retryDelayMs);
    return attempt();
  }
}

/**
 * Formats a base-unit amount as a decimal coin-unit string, e.g.
 * formatUnits(1234500000000000000n, 18) === '1.2345'. Pure bigint/string
 * arithmetic — no floating point, so 18-decimal amounts stay exact.
 * Fractional digits are capped (default 6) for display; trailing zeros are
 * trimmed. Capping truncates toward zero, which for balances is the honest
 * direction (never display more than is spendable).
 */
export function formatUnits(amount: bigint, decimals: number, maxFractionDigits = 6): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  // Multiplication loop instead of 10n ** BigInt(decimals): every bigint
  // operator used in this app has then been exercised by the engine's test
  // suite, whereas bigint exponentiation would be novel on Hermes.
  let base = 1n;
  for (let i = 0; i < decimals; i++) base *= 10n;
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(decimals, '0');
  if (fraction.length > maxFractionDigits) {
    fraction = fraction.slice(0, maxFractionDigits);
  }
  fraction = fraction.replace(/0+$/, '');
  const sign = negative ? '-' : '';
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

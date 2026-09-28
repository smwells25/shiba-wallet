import { httpTransport as evmHttpTransport } from '@shiba-wallet/chains-evm';
import { blockbookTransport, esploraTransport } from '@shiba-wallet/chains-utxo';
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

/**
 * Same UTXO-sum balance through chains-utxo's Blockbook transport
 * (GET /api/v2/utxo/{address} — Dogecoin's endpoint kind; see
 * config/defaults.ts). `headers` carries the configured API key as the
 * api-key header (wallet/blockbook.ts) for hosted providers like NOWNodes.
 */
async function fetchBlockbookBalance(
  url: string,
  address: string,
  headers?: Record<string, string>,
): Promise<bigint> {
  const utxos = await blockbookTransport(url, headers ? { headers } : {}).getUtxos(address);
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
 * `headers` is only meaningful for 'blockbook' endpoints (the API key
 * header resolved by config/networks.ts); other kinds ignore it.
 */
export async function fetchNativeBalance(
  kind: NetworkKind,
  url: string,
  address: string,
  headers?: Record<string, string>,
  retryDelayMs = 750,
): Promise<bigint> {
  const attempt = (): Promise<bigint> => {
    switch (kind) {
      case 'evm-jsonrpc':
        return fetchEvmBalance(url, address);
      case 'esplora':
        return fetchUtxoBalance(url, address);
      case 'blockbook':
        return fetchBlockbookBalance(url, address, headers);
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

/**
 * Inserts thousands separators into the whole part of a plain decimal
 * string ("1234567.891" -> "1,234,567.891"). Pure string manipulation
 * rather than Intl/toLocaleString, whose support on Hermes is limited; the
 * fraction digits are never touched. Shared by the balance-change preview
 * (./simulation.ts) and the fiat display (./prices.ts).
 */
export function groupThousands(decimal: string): string {
  const negative = decimal.startsWith('-');
  const body = negative ? decimal.slice(1) : decimal;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const rest = dot === -1 ? '' : body.slice(dot);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${rest}`;
}

/**
 * Parses a user-typed decimal coin amount into base units (wei/sat/lamports)
 * as an exact bigint — the inverse of formatUnits, with the same discipline:
 * pure bigint/string arithmetic, no floating point anywhere, so amounts like
 * "1.000000000000000001" ETH survive to the last wei.
 *
 * Accepted: plain non-negative decimals ("1", "0.5", ".5", "5.", "12.3400").
 * Rejected with a specific error: empty input, a lone ".", any character
 * outside [0-9.], more than one decimal point, negative amounts, and more
 * fractional digits than the asset has (silently rounding a payment amount
 * would be lying to the user, so excess precision is an error, never a
 * truncation). Exercised edge-by-edge in scripts/test-units.mjs.
 */
export function parseUnits(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('Enter an amount');
  if (trimmed.startsWith('-')) throw new Error('Amount cannot be negative');
  if (!/^[0-9]*\.?[0-9]*$/.test(trimmed)) {
    throw new Error('Amount must be a plain decimal number (digits and one "." only)');
  }
  const dot = trimmed.indexOf('.');
  const whole = dot === -1 ? trimmed : trimmed.slice(0, dot);
  const fraction = dot === -1 ? '' : trimmed.slice(dot + 1);
  if (whole === '' && fraction === '') throw new Error('Enter an amount'); // lone "."
  if (fraction.length > decimals) {
    throw new Error(
      `Too many decimal places: this asset supports at most ${decimals}, got ${fraction.length}`,
    );
  }
  // Same multiplication-loop rationale as formatUnits above: avoid bigint
  // exponentiation as a novel operation on Hermes.
  let base = 1n;
  for (let i = 0; i < decimals; i++) base *= 10n;
  const wholePart = whole === '' ? 0n : BigInt(whole);
  const fractionPart = fraction === '' ? 0n : BigInt(fraction.padEnd(decimals, '0'));
  return wholePart * base + fractionPart;
}

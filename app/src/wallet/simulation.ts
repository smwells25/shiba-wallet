import type { FungibleAsset } from '@shiba-wallet/core';
import {
  SimulationUnsupportedError,
  simulateAssetChanges,
} from '@shiba-wallet/chains-evm';
import type {
  AssetChange,
  AssetDiffCall,
  JsonRpcTransport,
} from '@shiba-wallet/chains-evm';
// Explicit .ts extensions: this module is imported by
// scripts/check-simulation.mjs under Node's type stripping, which resolves
// relative specifiers literally.
import { formatUnits } from './balances.ts';
import { fetchErc20Metadata, type Erc20Metadata } from './erc20.ts';
import { maskAmount } from '../config/prefs.ts';

/**
 * Balance-change preview (asset-diff simulation) for the EVM confirm
 * screens: SendScreen (native, ERC-20, smart account), SwapScreen (approve
 * and swap) and the WalletConnect eth_sendTransaction approval.
 *
 * The simulation itself is the engine's simulateAssetChanges over the
 * standard eth_simulateV1 method (packages/chains-evm/src/asset-diff.ts,
 * which cites the execution-apis specification). It runs against the SAME
 * node endpoint the send flow already uses (config/networks.ts getEndpoint
 * for the ACTIVE chain), so there is no separate simulation-endpoint
 * setting: the verified public defaults (publicnode mainnet and Sepolia)
 * serve eth_simulateV1, and an endpoint that does not is reported plainly.
 *
 * The preview is ADDITIVE: the eth_call revert gate on each confirm screen
 * is unchanged and remains the only blocking check. Nothing here signs,
 * broadcasts, or blocks anything.
 *
 * Deliberately free of React Native imports so scripts/check-simulation.mjs
 * exercises the exact code the screens run.
 */

// ---------------------------------------------------------------------------
// User-facing strings (also asserted by scripts/check-simulation.mjs)
// ---------------------------------------------------------------------------

export const PREVIEW_TITLE = 'Balance changes (preview)';
export const PREVIEW_UNSUPPORTED_NOTE =
  'Balance-change preview unavailable: this RPC endpoint does not support eth_simulateV1.';
export const PREVIEW_MALFORMED_NOTE =
  'Balance-change preview unavailable: this RPC endpoint returned an unrecognized eth_simulateV1 response.';
export const PREVIEW_NO_ENDPOINT_NOTE =
  'Balance-change preview unavailable: no RPC endpoint is configured for this network.';
export const PREVIEW_NO_CHANGES = 'No balance changes for your address, apart from the network fee.';
export const PREVIEW_FOOTNOTE =
  'Simulated against the latest block with eth_simulateV1. This is a preview, not a guarantee: ' +
  'balances, prices and contract state can change before the transaction is included. ' +
  'The network fee is shown separately and is not part of this list.';
export const PREVIEW_AA_NOTE =
  'Simulated as a direct call from your smart account. The gas the smart account pays ' +
  'through the EntryPoint is shown separately above and is not part of this list.';

export function skippedLogsNote(count: number): string {
  return count === 1
    ? '1 token event used a non-standard format and is not shown, so this preview may be incomplete.'
    : `${count} token events used a non-standard format and are not shown, so this preview may be incomplete.`;
}

export function revertedNote(reason: string): string {
  return (
    `The simulation reverts (${reason}). If sent anyway, no balances would change ` +
    'apart from the network fee.'
  );
}

export function errorNote(message: string): string {
  return `Balance-change preview failed: ${message}`;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * JSON-RPC over fetch that keeps the JSON-RPC error object even when the
 * HTTP status is not 2xx. The engine's httpTransport throws on the status
 * alone, which hides the error body; some providers answer an unknown
 * method with HTTP 400 plus {"error":{"code":-32600,"message":"Unsupported
 * method: …"}} (Alchemy, observed live 2026-09-28), and that message is what
 * lets the engine tell "unsupported" apart from a real failure. The thrown
 * Error carries `code` (and `data` when present) as properties.
 *
 * `fetchFn` is resolved at call time so offline checks can replace
 * globalThis.fetch.
 */
export function simulationTransport(url: string, fetchFn?: typeof fetch): JsonRpcTransport {
  let id = 0;
  return async (method, params) => {
    const doFetch = fetchFn ?? globalThis.fetch;
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const error =
      body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    if (error && typeof error === 'object') {
      const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown };
      const thrown = new Error(
        `RPC error ${typeof code === 'number' ? code : '?'}: ${
          typeof message === 'string' ? message : 'unknown error'
        } (${method})`,
      ) as Error & { code?: number; data?: unknown };
      if (typeof code === 'number') thrown.code = code;
      if (data !== undefined) thrown.data = data;
      throw thrown;
    }
    if (!response.ok) throw new Error(`RPC HTTP error ${response.status} for ${method}`);
    if (!body || typeof body !== 'object' || !('result' in body)) {
      throw new Error(`RPC response without a result for ${method}`);
    }
    return (body as { result: unknown }).result;
  };
}

// ---------------------------------------------------------------------------
// Token metadata
// ---------------------------------------------------------------------------

export interface TokenMeta {
  /** Display symbol (sanitized), or null when unknown. */
  symbol: string | null;
  /** Decimals, or null when they could not be read (amounts shown raw). */
  decimals: number | null;
  /** True when the token is in the user's tracked list for this chain. */
  tracked: boolean;
}

/** Keyed by lowercase contract address. */
export type TokenMetaMap = Record<string, TokenMeta>;

/** Max distinct untracked contracts whose metadata is read per preview. */
export const MAX_METADATA_LOOKUPS = 12;

/**
 * Makes an on-chain symbol safe to show: printable characters only, at
 * most 16 of them. A contract controls its own symbol() answer, so a
 * hostile token could otherwise inject line breaks or a paragraph of text
 * into the confirm screen.
 */
export function sanitizeSymbol(symbol: string | null): string | null {
  if (symbol === null) return null;
  const cleaned = symbol.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();
  if (cleaned === '') return null;
  return cleaned.length > 16 ? `${cleaned.slice(0, 16)}…` : cleaned;
}

/**
 * Resolves symbol/decimals for every fungible token contract in `changes`:
 * first from the user's tracked-token list for the ACTIVE chain (matched by
 * exact contract address and CAIP-2 chain id, so a mainnet entry can never
 * label a Sepolia contract), otherwise via eth_call (decimals()/symbol()
 * through erc20.ts fetchErc20Metadata). When decimals cannot be read the
 * entry has decimals null and amounts are shown as raw base units — never
 * with guessed decimals.
 */
export async function resolveTokenMeta(
  changes: AssetChange[],
  options: {
    url: string;
    chainCaip2: string;
    trackedTokens: FungibleAsset[];
    fetchMetadata?: (url: string, contract: string) => Promise<Erc20Metadata>;
    maxLookups?: number;
  },
): Promise<TokenMetaMap> {
  const fetchMetadata = options.fetchMetadata ?? fetchErc20Metadata;
  const maxLookups = options.maxLookups ?? MAX_METADATA_LOOKUPS;
  const contracts: string[] = [];
  for (const change of changes) {
    if (change.type === 'erc20' || change.type === 'erc20-approval') {
      const key = change.token.toLowerCase();
      if (!contracts.includes(key)) contracts.push(key);
    }
  }
  const meta: TokenMetaMap = {};
  const lookups: string[] = [];
  for (const contract of contracts) {
    const tracked = options.trackedTokens.find(
      (t) =>
        t.assetId.chainId === options.chainCaip2 &&
        t.assetId.namespace === 'erc20' &&
        t.assetId.reference.toLowerCase() === contract,
    );
    if (tracked) {
      meta[contract] = { symbol: sanitizeSymbol(tracked.symbol), decimals: tracked.decimals, tracked: true };
    } else if (lookups.length < maxLookups) {
      lookups.push(contract);
    } else {
      meta[contract] = { symbol: null, decimals: null, tracked: false };
    }
  }
  await Promise.all(
    lookups.map(async (contract) => {
      try {
        const m = await fetchMetadata(options.url, contract);
        meta[contract] = { symbol: sanitizeSymbol(m.symbol), decimals: m.decimals, tracked: false };
      } catch {
        meta[contract] = { symbol: null, decimals: null, tracked: false };
      }
    }),
  );
  return meta;
}

// ---------------------------------------------------------------------------
// Preview orchestration
// ---------------------------------------------------------------------------

export type PreviewState =
  | { status: 'unavailable'; note: string }
  | { status: 'error'; message: string }
  | { status: 'reverted'; reason: string }
  | { status: 'ok'; changes: AssetChange[]; meta: TokenMetaMap; skippedLogs: number };

/**
 * Runs the simulation and resolves token metadata. Never throws: every
 * outcome maps to a PreviewState the component renders honestly.
 */
export async function runBalancePreview(options: {
  url: string | null;
  /** Address whose balances the preview describes (EOA, or the smart account). */
  wallet: string;
  calls: AssetDiffCall[];
  chainCaip2: string;
  trackedTokens: FungibleAsset[];
  fetchFn?: typeof fetch;
  fetchMetadata?: (url: string, contract: string) => Promise<Erc20Metadata>;
}): Promise<PreviewState> {
  if (!options.url) return { status: 'unavailable', note: PREVIEW_NO_ENDPOINT_NOTE };
  try {
    const transport = simulationTransport(options.url, options.fetchFn);
    const result = await simulateAssetChanges(transport, options.calls, options.wallet);
    const failed = result.calls.find((c) => !c.ok);
    if (failed) return { status: 'reverted', reason: failed.revertReason ?? 'reverted' };
    const meta = await resolveTokenMeta(result.changes, {
      url: options.url,
      chainCaip2: options.chainCaip2,
      trackedTokens: options.trackedTokens,
      ...(options.fetchMetadata ? { fetchMetadata: options.fetchMetadata } : {}),
    });
    return { status: 'ok', changes: result.changes, meta, skippedLogs: result.skippedLogs };
  } catch (error) {
    if (error instanceof SimulationUnsupportedError) {
      return {
        status: 'unavailable',
        note: error.reason === 'method-not-found' ? PREVIEW_UNSUPPORTED_NOTE : PREVIEW_MALFORMED_NOTE,
      };
    }
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Plain-language lines
// ---------------------------------------------------------------------------

export type PreviewTone = 'out' | 'in' | 'neutral' | 'approval' | 'warning';

export interface PreviewLine {
  text: string;
  tone: PreviewTone;
}

/** 0x1234…abcd — enough to recognize, never enough to be mistaken for the full value. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Inserts thousands separators into the whole part of a plain decimal string. */
export function groupThousands(decimal: string): string {
  const negative = decimal.startsWith('-');
  const body = negative ? decimal.slice(1) : decimal;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const rest = dot === -1 ? '' : body.slice(dot);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${rest}`;
}

/** Exact, full-precision amount with separators (never truncated). */
function exactAmount(amount: bigint, decimals: number): string {
  return groupThousands(formatUnits(amount, decimals, decimals));
}

/** Approvals at or above this are "effectively unlimited" (far beyond any real supply). */
const EFFECTIVELY_UNLIMITED = 1n << 128n;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** "USDC", "PEPE (untracked token 0x1234…abcd)", or "token 0x1234…abcd". */
function tokenLabel(token: string, meta: TokenMeta | undefined): string {
  const short = shortAddress(token);
  if (meta?.tracked && meta.symbol) return meta.symbol;
  if (meta?.symbol) return `${meta.symbol} (untracked token ${short})`;
  return `token ${short}`;
}

/** "3,412.18 USDC" / "1000000 raw units of token 0x… (decimals unreadable)". */
function tokenAmountPhrase(amount: bigint, token: string, meta: TokenMeta | undefined, hidden: boolean): string {
  if (!meta || meta.decimals === null) {
    return `${maskAmount(amount.toString(), hidden)} raw units of token ${shortAddress(token)} (decimals unreadable)`;
  }
  return `${maskAmount(exactAmount(amount, meta.decimals), hidden)} ${tokenLabel(token, meta)}`;
}

/**
 * Turns the engine's wallet-relative changes into plain-language lines.
 * Fungible transfers of the same asset in the same direction are summed
 * (exact bigint) so a multi-hop swap reads as one "You send"/"You
 * receive" pair; NFTs and approvals stay one line each. Order: outgoing,
 * incoming, self-transfers, then approvals. With `hidden` (the Hide
 * amounts preference) every amount is masked via maskAmount; NFT ids and
 * the UNLIMITED marker stay visible because they are not balances and the
 * warning must not be hidden.
 */
export function describeAssetChanges(
  changes: AssetChange[],
  meta: TokenMetaMap,
  options: { nativeSymbol: string; hidden: boolean },
): PreviewLine[] {
  const { nativeSymbol, hidden } = options;
  type Bucket = {
    direction: 'out' | 'in' | 'self';
    type: 'native' | 'erc20';
    /** Lowercase contract (lookup key), or null for native. */
    key: string | null;
    /** Checksummed contract for display, or null for native. */
    token: string | null;
    amount: bigint;
  };
  const buckets: Bucket[] = [];
  const nftLines: { direction: 'out' | 'in' | 'self'; line: PreviewLine }[] = [];
  const approvalLines: PreviewLine[] = [];

  for (const change of changes) {
    switch (change.type) {
      case 'native':
      case 'erc20': {
        const token = change.type === 'erc20' ? change.token : null;
        const key = token ? token.toLowerCase() : null;
        const bucket = buckets.find(
          (b) => b.type === change.type && b.key === key && b.direction === change.direction,
        );
        if (bucket) bucket.amount += change.amount;
        else buckets.push({ direction: change.direction, type: change.type, key, token, amount: change.amount });
        break;
      }
      case 'erc721': {
        const nft = `NFT #${change.tokenId.toString()} (${shortAddress(change.token)})`;
        const text =
          change.direction === 'out'
            ? `You send ${nft}`
            : change.direction === 'in'
              ? `You receive ${nft}`
              : `${nft} moves to yourself (no net change)`;
        nftLines.push({
          direction: change.direction,
          line: { text, tone: change.direction === 'self' ? 'neutral' : change.direction },
        });
        break;
      }
      case 'erc1155': {
        const nft = `${maskAmount(change.amount.toString(), hidden)} × NFT #${change.tokenId.toString()} (${shortAddress(change.token)})`;
        const text =
          change.direction === 'out'
            ? `You send ${nft}`
            : change.direction === 'in'
              ? `You receive ${nft}`
              : `${nft} moves to yourself (no net change)`;
        nftLines.push({
          direction: change.direction,
          line: { text, tone: change.direction === 'self' ? 'neutral' : change.direction },
        });
        break;
      }
      case 'erc20-approval': {
        const m = meta[change.token.toLowerCase()];
        const spender = shortAddress(change.spender);
        if (change.amount === 0n) {
          approvalLines.push({
            text: `Approval revoked: ${spender} may no longer spend ${tokenLabel(change.token, m)}`,
            tone: 'neutral',
          });
        } else if (change.unlimited) {
          approvalLines.push({
            text: `Approval: ${spender} may spend UNLIMITED ${tokenLabel(change.token, m)}`,
            tone: 'warning',
          });
        } else if (change.amount >= EFFECTIVELY_UNLIMITED) {
          approvalLines.push({
            text: `Approval: ${spender} may spend up to ${tokenAmountPhrase(change.amount, change.token, m, hidden)} (effectively unlimited)`,
            tone: 'warning',
          });
        } else {
          approvalLines.push({
            text: `Approval: ${spender} may spend up to ${tokenAmountPhrase(change.amount, change.token, m, hidden)}`,
            tone: 'approval',
          });
        }
        break;
      }
      case 'erc721-approval': {
        const nft = `NFT #${change.tokenId.toString()} (${shortAddress(change.token)})`;
        approvalLines.push(
          change.approved.toLowerCase() === ZERO_ADDRESS
            ? { text: `Approval cleared for your ${nft}`, tone: 'neutral' }
            : { text: `Approval: ${shortAddress(change.approved)} may transfer your ${nft}`, tone: 'approval' },
        );
        break;
      }
      case 'approval-for-all': {
        const operator = shortAddress(change.operator);
        const collection = shortAddress(change.token);
        approvalLines.push(
          change.approved
            ? { text: `Approval: ${operator} may transfer ALL your NFTs in ${collection}`, tone: 'warning' }
            : { text: `Approval revoked: ${operator} may no longer transfer your NFTs in ${collection}`, tone: 'neutral' },
        );
        break;
      }
    }
  }

  const fungibleLine = (b: Bucket): PreviewLine => {
    const phrase =
      b.type === 'native'
        ? `${maskAmount(exactAmount(b.amount, 18), hidden)} ${nativeSymbol}`
        : tokenAmountPhrase(b.amount, b.token!, meta[b.key!], hidden);
    if (b.direction === 'out') return { text: `You send ${phrase}`, tone: 'out' };
    if (b.direction === 'in') return { text: `You receive ${phrase}`, tone: 'in' };
    return { text: `You send ${phrase} to yourself (no net change)`, tone: 'neutral' };
  };

  const lines: PreviewLine[] = [];
  for (const direction of ['out', 'in', 'self'] as const) {
    for (const b of buckets) if (b.direction === direction) lines.push(fungibleLine(b));
    for (const n of nftLines) if (n.direction === direction) lines.push(n.line);
  }
  lines.push(...approvalLines);
  return lines;
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import { base64 } from '@scure/base';
import {
  alchemyNftOwnershipProvider,
  httpTransport,
  normalizeNftBaseUrl,
  substituteErc1155Id,
  verifyNftOwnershipEndpoint,
  type JsonRpcTransport,
  type NftHttpFetch,
  type NftValidAt,
  type OwnedNft,
} from '@shiba-wallet/chains-evm';
import { formatAssetId, nonFungibleAssetId } from '@shiba-wallet/core';
// Explicit .ts extensions: this module is imported by scripts/check-nfts.mjs
// under Node's type stripping, which resolves relative specifiers literally.
import type { KeyValueStore } from './tokens.ts';
import { assertSecureEndpointUrl } from '../config/endpoint-url.ts';
import type { TransportFactory } from './aa.ts';
import { utf8Decode } from './erc20.ts';
import { STRIPPED_NAME_CHARS } from './names.ts';

/**
 * NFT gallery glue (phase 7 item 4): the NFT-indexer configuration store,
 * ownership loading for the ACTIVE account on the ACTIVE EVM chain with a
 * per-account in-memory cache, collection grouping, and the metadata /
 * image rules. Free of React Native imports so scripts/check-nfts.mjs runs
 * this exact code under Node with fake transports.
 *
 * INDEXER CONFIGURATION. Ownership needs an indexer (a node cannot list
 * NFTs by owner). The engine's NftOwnershipProvider is vendor-neutral; the
 * configured URL is fed to its Alchemy NFT API v3 adapter. The URL is a
 * SEPARATE setting from the history indexer: Alchemy documents the NFT API
 * as REST under https://eth-mainnet.g.alchemy.com/nft/v3/{apiKey} and the
 * Transfers API as JSON-RPC under https://eth-mainnet.g.alchemy.com/v2/
 * {apiKey}, but its documentation does not state that one key or URL
 * implies the other, so the app never derives one from the other. (A live
 * probe on 2026-10-01 showed the same key serving both; that is an
 * observation, not a documented contract, and a different vendor may not
 * work that way at all.) Like the history indexer URL, it embeds the
 * user's key, lives only in AsyncStorage on this device, and is sent only
 * to that host.
 *
 * VERIFY-BEFORE-SAVE (the aa.ts / indexer.ts discipline): saving runs one
 * single-entry getNFTsForOwner probe for the wallet's own address and then
 * binds the answer to the ACTIVE chain, because a REST indexer has no
 * eth_chainId to compare. The indexer reports the block its answer is
 * valid at (validAt); the active chain's own RPC node must have that block
 * with the same hash (when the indexer reports one) or the same timestamp
 * (when it does not — Alchemy's mainnet answer carried a null blockHash in
 * the live probe). A mainnet URL saved in Sepolia mode fails this check
 * (Sepolia has no block at mainnet heights), and vice versa. Nothing
 * persists unless every check passes, so configured == verified.
 */

const NFT_INDEXER_CONFIG_KEY = 'shiba-wallet.nft-indexer.v1';

export interface NftIndexerConfig {
  url: string | null;
  /** ISO timestamp of the successful save-time verification. */
  verifiedAt: string | null;
  /** Decimal block number the save-time chain binding was checked at. */
  verifiedBlock: string | null;
  /**
   * Non-null when a URL is stored but fails the https rule on read
   * (../config/endpoint-url.ts): the reason, for Settings' status line.
   * The stored URL is then NOT used (`url` reads as null, so the gallery
   * shows the unconfigured state) and stays stored until the user clears it.
   */
  ignoredUrlReason: string | null;
}

/**
 * Applies the https rule to a stored URL. Values saved before the rule
 * existed (dev/emulator installs only) may be plain http://; those are
 * reported as ignored rather than used or silently deleted.
 */
function checkStoredUrl(stored: string | null): { url: string | null; ignoredUrlReason: string | null } {
  if (stored === null) return { url: null, ignoredUrlReason: null };
  try {
    assertSecureEndpointUrl(stored);
    return { url: stored, ignoredUrlReason: null };
  } catch (e) {
    return { url: null, ignoredUrlReason: e instanceof Error ? e.message : String(e) };
  }
}

type ConfigMap = Record<string, { url?: unknown; verifiedAt?: unknown; verifiedBlock?: unknown }>;

async function loadConfigMap(store: KeyValueStore): Promise<ConfigMap> {
  try {
    const raw = await store.getItem(NFT_INDEXER_CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ConfigMap;
    }
    return {};
  } catch {
    // Corrupt JSON or unavailable storage: behave as unconfigured.
    return {};
  }
}

/** The stored NFT indexer configuration for one chain (nulls when unset). */
export async function getNftIndexerConfig(
  chainId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<NftIndexerConfig> {
  const map = await loadConfigMap(store);
  const entry = map[chainId];
  const { url, ignoredUrlReason } = checkStoredUrl(
    typeof entry?.url === 'string' && entry.url !== '' ? entry.url : null,
  );
  const text = (v: unknown) => (url && typeof v === 'string' && v !== '' ? v : null);
  return {
    url,
    verifiedAt: text(entry?.verifiedAt),
    verifiedBlock: text(entry?.verifiedBlock),
    ignoredUrlReason,
  };
}

/**
 * Confirms that an indexer answer valid at `validAt` belongs to the chain
 * served by `node` (the active chain's RPC). Throws a plain-language error
 * otherwise. Exported for the check script.
 */
export async function confirmIndexerChain(
  validAt: NftValidAt,
  node: JsonRpcTransport,
  chainLabel: string,
): Promise<void> {
  const block = (await node('eth_getBlockByNumber', [
    '0x' + validAt.blockNumber.toString(16),
    false,
  ])) as { hash?: unknown; timestamp?: unknown } | null;
  if (!block) {
    const head = BigInt((await node('eth_blockNumber', [])) as string);
    // Within a few minutes of blocks the indexer may simply be ahead of the
    // node; far beyond the node's head it is another network.
    if (validAt.blockNumber > head + 64n) {
      throw new Error(
        `This NFT indexer serves a different network: it answered as of block ` +
          `${validAt.blockNumber}, but ${chainLabel} is only at block ${head}. ` +
          'Paste the NFT API URL for this network.',
      );
    }
    throw new Error(
      `Your ${chainLabel} RPC endpoint has not seen block ${validAt.blockNumber} yet, ` +
        'so the indexer’s network cannot be confirmed. Try again in a minute.',
    );
  }
  if (validAt.blockHash) {
    if (typeof block.hash !== 'string' || block.hash.toLowerCase() !== validAt.blockHash) {
      throw new Error(
        `This NFT indexer serves a different network: block ${validAt.blockNumber} ` +
          `has a different hash on ${chainLabel}. Paste the NFT API URL for this network.`,
      );
    }
    return;
  }
  const isoMs = validAt.blockTimestamp ? Date.parse(validAt.blockTimestamp) : NaN;
  if (!Number.isFinite(isoMs) || typeof block.timestamp !== 'string') {
    throw new Error(
      'The NFT indexer reported neither a block hash nor a readable timestamp, ' +
        'so its network cannot be confirmed.',
    );
  }
  if (BigInt(Math.floor(isoMs / 1000)) !== BigInt(block.timestamp)) {
    throw new Error(
      `This NFT indexer serves a different network: block ${validAt.blockNumber} ` +
        `has a different timestamp on ${chainLabel}. Paste the NFT API URL for this network.`,
    );
  }
}

/**
 * Verifies and saves the NFT indexer URL for one chain; throws (persisting
 * nothing) when any check fails: an https:// URL (plain http:// only for a
 * loopback development host; ../config/endpoint-url.ts — checked for both
 * the indexer and `rpcUrl` before any request), a well-formed
 * single-entry getNFTsForOwner answer for the wallet's own address with a
 * validAt block, and the chain binding above against `rpcUrl` (the active
 * chain's configured RPC endpoint).
 */
export async function setNftIndexerUrl(
  chainId: string,
  url: string,
  walletAddress: string,
  rpcUrl: string,
  options: {
    store?: KeyValueStore;
    fetchFn?: NftHttpFetch;
    transportFor?: TransportFactory;
    chainLabel?: string;
  } = {},
): Promise<void> {
  const store = options.store ?? AsyncStorage;
  const transportFor = options.transportFor ?? httpTransport;
  const trimmed = assertSecureEndpointUrl(normalizeNftBaseUrl(url));
  // The RPC URL is only checked here (it is the app's configured endpoint
  // and is passed on unchanged).
  assertSecureEndpointUrl(rpcUrl);
  const provider = alchemyNftOwnershipProvider(trimmed, {
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });
  let validAt: NftValidAt;
  try {
    ({ validAt } = await verifyNftOwnershipEndpoint(provider, walletAddress));
  } catch (e) {
    // Observed live 2026-10-01: Alchemy's JSON-RPC URL (…/v2/<key>) also
    // answers getNFTsForOwner, but with the older response shape (no
    // validAt), so it fails verification; say what to paste instead.
    const message = e instanceof Error ? e.message : String(e);
    if (/\/v2\/[^/]+$/.test(trimmed)) {
      throw new Error(
        `${message} This looks like a JSON-RPC URL (…/v2/…); paste the NFT API v3 base URL (…/nft/v3/…).`,
      );
    }
    throw e;
  }
  await confirmIndexerChain(validAt, transportFor(rpcUrl), options.chainLabel ?? chainId);
  const map = await loadConfigMap(store);
  map[chainId] = {
    url: trimmed,
    verifiedAt: new Date().toISOString(),
    verifiedBlock: validAt.blockNumber.toString(),
  };
  await store.setItem(NFT_INDEXER_CONFIG_KEY, JSON.stringify(map));
  clearNftCache();
}

/** Removes the stored NFT indexer URL for one chain. */
export async function clearNftIndexerUrl(
  chainId: string,
  store: KeyValueStore = AsyncStorage,
): Promise<void> {
  const map = await loadConfigMap(store);
  if (map[chainId]) {
    delete map[chainId];
    await store.setItem(NFT_INDEXER_CONFIG_KEY, JSON.stringify(map));
  }
  clearNftCache();
}

// ---------------------------------------------------------------------------
// Ownership loading with a per-account cache
// ---------------------------------------------------------------------------

/**
 * In-memory cache, keyed by account index + CAIP-2 chain id. Memory only
 * (never persisted): the list is public on-chain data, but persisting it
 * would keep a record of an account's holdings on the device after the
 * account is hidden or the wallet wiped. Each entry remembers the owner
 * address and indexer URL it was loaded for and is ignored when either
 * differs (e.g. a wiped and re-imported wallet reusing index 0, or a
 * changed indexer URL).
 */
interface CacheEntry {
  owner: string;
  url: string;
  nfts: OwnedNft[];
  nextCursor?: string;
  skipped: number;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Cached lists are reused for this long before the screen refetches. */
export const NFT_CACHE_TTL_MS = 5 * 60_000;

/** Page size per indexer request (Alchemy's documented maximum is 100). */
export const NFT_PAGE_SIZE = 100;

export function nftCacheKey(accountIndex: number, chainId: string): string {
  return `${accountIndex}|${chainId}`;
}

export function clearNftCache(): void {
  cache.clear();
}

/** Drops one account's cached list (e.g. after it sent an NFT). */
export function invalidateNftCache(accountIndex: number, chainId: string): void {
  cache.delete(nftCacheKey(accountIndex, chainId));
}

export type NftLoadResult =
  | { status: 'unconfigured' }
  | {
      status: 'ok';
      nfts: OwnedNft[];
      nextCursor?: string;
      /** Entries the indexer returned that could not be represented exactly. */
      skipped: number;
      fetchedAt: number;
      fromCache: boolean;
    };

export interface NftLoadOptions {
  /** The ACTIVE EVM chain's CAIP-2 id (config/evm-chain.ts). */
  chainId: string;
  /** The ACTIVE account's index (wallet/accounts.ts). */
  accountIndex: number;
  /** The active account's EVM address. */
  owner: string;
  /** Bypass the cache (pull-to-refresh). */
  refresh?: boolean;
  store?: KeyValueStore;
  fetchFn?: NftHttpFetch;
  now?: () => number;
}

function nftKey(nft: OwnedNft): string {
  return `${nft.contract.toLowerCase()}/${nft.tokenId.toString()}`;
}

function resultFrom(entry: CacheEntry, fromCache: boolean): NftLoadResult {
  return {
    status: 'ok',
    nfts: entry.nfts,
    ...(entry.nextCursor ? { nextCursor: entry.nextCursor } : {}),
    skipped: entry.skipped,
    fetchedAt: entry.fetchedAt,
    fromCache,
  };
}

/** First page of the active account's NFTs on the active chain (cached). */
export async function loadNfts(options: NftLoadOptions): Promise<NftLoadResult> {
  const now = options.now ?? Date.now;
  const config = await getNftIndexerConfig(options.chainId, options.store ?? AsyncStorage);
  if (!config.url) return { status: 'unconfigured' };
  const key = nftCacheKey(options.accountIndex, options.chainId);
  const owner = options.owner.toLowerCase();
  const cached = cache.get(key);
  if (
    !options.refresh &&
    cached &&
    cached.owner === owner &&
    cached.url === config.url &&
    now() - cached.fetchedAt < NFT_CACHE_TTL_MS
  ) {
    return resultFrom(cached, true);
  }
  const provider = alchemyNftOwnershipProvider(config.url, {
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });
  const page = await provider.getOwnedNfts(options.owner, { pageSize: NFT_PAGE_SIZE });
  const entry: CacheEntry = {
    owner,
    url: config.url,
    nfts: dedupe(page.nfts),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    skipped: page.skipped,
    fetchedAt: now(),
  };
  cache.set(key, entry);
  return resultFrom(entry, false);
}

/** Appends the next page to the cached list (requires a prior loadNfts). */
export async function loadMoreNfts(options: NftLoadOptions): Promise<NftLoadResult> {
  const config = await getNftIndexerConfig(options.chainId, options.store ?? AsyncStorage);
  if (!config.url) return { status: 'unconfigured' };
  const key = nftCacheKey(options.accountIndex, options.chainId);
  const cached = cache.get(key);
  if (!cached || cached.owner !== options.owner.toLowerCase() || cached.url !== config.url) {
    return loadNfts({ ...options, refresh: true });
  }
  if (!cached.nextCursor) return resultFrom(cached, true);
  const provider = alchemyNftOwnershipProvider(config.url, {
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });
  const page = await provider.getOwnedNfts(options.owner, {
    cursor: cached.nextCursor,
    pageSize: NFT_PAGE_SIZE,
  });
  const entry: CacheEntry = {
    ...cached,
    nfts: dedupe([...cached.nfts, ...page.nfts]),
    skipped: cached.skipped + page.skipped,
  };
  if (page.nextCursor) entry.nextCursor = page.nextCursor;
  else delete entry.nextCursor;
  cache.set(key, entry);
  return resultFrom(entry, false);
}

function dedupe(nfts: OwnedNft[]): OwnedNft[] {
  const seen = new Set<string>();
  const out: OwnedNft[] = [];
  for (const nft of nfts) {
    const k = nftKey(nft);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(nft);
  }
  return out;
}

/** The CAIP-19 id of an owned NFT (decimal token id). */
export function nftAssetIdString(chainId: string, nft: OwnedNft): string {
  return formatAssetId(nonFungibleAssetId(chainId, nft.standard, nft.contract, nft.tokenId));
}

/** Looks an NFT up in the cached list for the detail screen. */
export function getCachedNft(
  accountIndex: number,
  chainId: string,
  owner: string,
  assetId: string,
): OwnedNft | null {
  const entry = cache.get(nftCacheKey(accountIndex, chainId));
  if (!entry || entry.owner !== owner.toLowerCase()) return null;
  return entry.nfts.find((n) => nftAssetIdString(chainId, n) === assetId) ?? null;
}

// ---------------------------------------------------------------------------
// Display text and grouping
// ---------------------------------------------------------------------------

/**
 * Makes indexer/contract-supplied text safe to show: NFC, control, bidi
 * and zero-width characters stripped (the same set as user-chosen names,
 * see ./names.ts), whitespace collapsed, at most `max` code points. NFT
 * names and descriptions are attacker-controlled; spam collections
 * routinely embed phishing URLs, so text is never rendered as a link.
 */
export function sanitizeNftText(raw: string | null | undefined, max = 80): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.normalize('NFC').replace(STRIPPED_NAME_CHARS, '').replace(/\s+/gu, ' ').trim();
  if (cleaned === '') return null;
  const chars = Array.from(cleaned);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : cleaned;
}

export function shortContract(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The token id for display. Ids are shown in full (never abbreviated with
 * an ellipsis, which would make two different ids look alike); very long
 * ids wrap on screen.
 */
export function formatTokenId(tokenId: bigint): string {
  return tokenId.toString(10);
}

/** "Name", else "Collection #id", else "#id". */
export function nftDisplayName(nft: OwnedNft): string {
  const name = sanitizeNftText(nft.name);
  if (name) return name;
  const collection = nftCollectionTitle(nft);
  return `${collection} #${formatTokenId(nft.tokenId)}`;
}

export function nftCollectionTitle(nft: OwnedNft): string {
  return (
    sanitizeNftText(nft.collectionName) ??
    sanitizeNftText(nft.contractName) ??
    `Unnamed collection (${shortContract(nft.contract)})`
  );
}

export function standardLabel(standard: OwnedNft['standard']): string {
  return standard === 'erc721' ? 'ERC-721' : 'ERC-1155';
}

export interface NftCollectionGroup {
  /** Lowercase contract address (stable key). */
  key: string;
  contract: string;
  title: string;
  /** True when the indexer flagged the contract as spam. */
  spam: boolean;
  items: OwnedNft[];
}

/**
 * Groups NFTs by contract. Spam-flagged collections sort last (the screen
 * hides them behind an explicit toggle); others sort by title, then
 * contract. Items sort by token id, compared as exact bigints.
 */
export function groupNftsByCollection(nfts: OwnedNft[]): NftCollectionGroup[] {
  const groups = new Map<string, NftCollectionGroup>();
  for (const nft of nfts) {
    const key = nft.contract.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { key, contract: nft.contract, title: nftCollectionTitle(nft), spam: false, items: [] };
      groups.set(key, group);
    }
    if (nft.spam === true) group.spam = true;
    group.items.push(nft);
  }
  const list = [...groups.values()];
  for (const g of list) g.items.sort((a, b) => (a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0));
  list.sort((a, b) => {
    if (a.spam !== b.spam) return a.spam ? 1 : -1;
    const t = a.title.localeCompare(b.title);
    return t !== 0 ? t : a.key < b.key ? -1 : 1;
  });
  return list;
}

/**
 * Block-explorer page for one NFT. Etherscan serves per-token pages at
 * /nft/{contract}/{decimal token id} on mainnet and on Sepolia (checked
 * 2026-10-01 against Etherscan's own indexed pages, e.g.
 * etherscan.io/nft/0x57f1…ea85/8468… and sepolia.etherscan.io/nft/
 * 0xff78…3220/1, covering ERC-721 and ERC-1155 tokens). Unknown chains get
 * no link rather than a guessed one.
 *
 * Base Sepolia (phase 11 item 5): the explorer host sepolia.basescan.org is
 * the one Base documents ("Block explorer | basescan.org |
 * sepolia.basescan.org", https://docs.base.org/get-started/connect-to-base,
 * read 2026-10-03). The /nft/{contract}/{token id} path — like the /tx/ and
 * /address/ paths used elsewhere — is the Etherscan-family convention
 * BaseScan shares, not something Base documents. A headless request on
 * 2026-10-03 for /nft/{address}/1 returned BaseScan's NFT page template
 * (a "Token ID" field, site name "Base Sepolia Network Explorer"), while
 * /tx/ pages answered with a Cloudflare challenge; the path has not been
 * checked against a real indexed Base Sepolia NFT.
 *
 * Arbitrum Sepolia (phase 14 integration): the explorer host
 * sepolia.arbiscan.io is the one the profile records (Arbitrum's pages link
 * Arbiscan in the /address/<addr> form; see EVM_ARBITRUM_SEPOLIA in
 * config/evm-chain.ts). The /nft/{contract}/{token id} path is the
 * Etherscan-family convention Arbiscan shares; Arbitrum does not document
 * it, and it has not been checked against a real indexed Arbitrum Sepolia
 * NFT.
 */
const NFT_EXPLORER_BASE: Record<string, string> = {
  'eip155:1': 'https://etherscan.io/nft/',
  'eip155:11155111': 'https://sepolia.etherscan.io/nft/',
  'eip155:84532': 'https://sepolia.basescan.org/nft/',
  'eip155:421614': 'https://sepolia.arbiscan.io/nft/',
};

export function nftExplorerUrl(chainId: string, nft: Pick<OwnedNft, 'contract' | 'tokenId'>): string | null {
  const base = NFT_EXPLORER_BASE[chainId];
  return base ? `${base}${nft.contract}/${formatTokenId(nft.tokenId)}` : null;
}

// ---------------------------------------------------------------------------
// Metadata and media URI rules
// ---------------------------------------------------------------------------

/**
 * IPFS gateway for ipfs:// URIs: the IPFS Foundation's public path gateway,
 * https://ipfs.io/ipfs/{cid}/{path} (docs.ipfs.tech/concepts/
 * public-utilities, checked 2026-10-01).
 *
 * PRIVACY: a gateway is a third-party HTTP server. Whoever operates it (and
 * its CDN) sees this device's IP address and exactly which CIDs it asks
 * for, which can link the IP to the NFTs this wallet holds. The IPFS
 * Foundation's page states the public gateways are rate-limited and "not
 * intended to be part of your critical path or production
 * infrastructure"; a production release should offer a user-chosen or
 * self-hosted gateway. The same exposure applies to http(s) image and
 * metadata hosts, which is why the indexer's own image cache is always
 * tried first (the indexer already knows which address is being viewed)
 * and why spam-flagged NFTs never load from their original hosts — an
 * airdropped NFT with a unique image URL is a known way to learn a
 * holder's IP address.
 */
export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

/** Images larger than this are never downloaded or decoded. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Metadata JSON larger than this is refused. */
export const MAX_METADATA_BYTES = 512 * 1024;
/** Per-request timeout for image and metadata fetches. */
export const MEDIA_TIMEOUT_MS = 15_000;

export type ResolvedUri =
  | { kind: 'remote'; url: string; viaGateway: boolean }
  | { kind: 'inline'; mime: string; bytes: Uint8Array }
  | { kind: 'unsupported'; reason: string };

const CID_PATH = /^[A-Za-z0-9]+(\/[^\s?#]*)?([?#].*)?$/;

/**
 * Data-URI decoding (RFC 2397: data:[<mediatype>][;base64],<data>) done
 * locally, without any network request. Base64 payloads are decoded with
 * @scure/base (whitespace removed, missing padding restored); other
 * payloads are percent-decoded and UTF-8 encoded.
 */
function decodeDataUri(uri: string): ResolvedUri {
  const comma = uri.indexOf(',');
  if (comma === -1) return { kind: 'unsupported', reason: 'Malformed data: URI (no comma).' };
  const header = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const parts = header.split(';').map((p) => p.trim());
  const isBase64 = parts.some((p) => p.toLowerCase() === 'base64');
  const mime = (parts[0] || 'text/plain').toLowerCase();
  try {
    if (isBase64) {
      let clean = payload.replace(/\s+/g, '');
      while (clean.length % 4 !== 0) clean += '=';
      return { kind: 'inline', mime, bytes: base64.decode(clean) };
    }
    const text = decodeURIComponent(payload);
    return { kind: 'inline', mime, bytes: utf8Encode(text) };
  } catch {
    return { kind: 'unsupported', reason: 'The data: URI could not be decoded.' };
  }
}

/** Minimal UTF-8 encoder (the inverse of erc20.ts utf8Decode). */
function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return Uint8Array.from(out);
}

/**
 * Resolution rules for tokenURI and image URIs:
 *  - ipfs://{cid}[/path] (and the legacy ipfs://ipfs/{cid} form) → the
 *    public gateway above;
 *  - data: → decoded locally, no request;
 *  - http(s):// → passed through unchanged;
 *  - anything else (ar://, javascript:, file:, relative paths) → refused.
 */
export function resolveMediaUri(raw: string): ResolvedUri {
  const uri = raw.trim();
  const lower = uri.toLowerCase();
  if (lower.startsWith('data:')) return decodeDataUri(uri);
  if (lower.startsWith('https://') || lower.startsWith('http://')) {
    return { kind: 'remote', url: uri, viaGateway: false };
  }
  if (lower.startsWith('ipfs://')) {
    let rest = uri.slice('ipfs://'.length);
    if (rest.toLowerCase().startsWith('ipfs/')) rest = rest.slice('ipfs/'.length);
    if (!CID_PATH.test(rest)) {
      return { kind: 'unsupported', reason: 'Malformed ipfs:// URI.' };
    }
    return { kind: 'remote', url: `${IPFS_GATEWAY}${rest}`, viaGateway: true };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1];
  return {
    kind: 'unsupported',
    reason: scheme ? `The ${scheme}: scheme is not supported.` : 'Not an absolute URI.',
  };
}

export type RasterMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/**
 * Identifies a raster image by its leading magic bytes — the declared
 * content type is never trusted. PNG: 89 50 4E 47 0D 0A 1A 0A; JPEG:
 * FF D8 FF; GIF: "GIF87a"/"GIF89a"; WebP: "RIFF" ???? "WEBP".
 */
export function sniffRaster(bytes: Uint8Array): RasterMime | null {
  const b = bytes;
  const at = (i: number, ...vals: number[]) => vals.every((v, k) => b[i + k] === v);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) {
    return 'image/gif';
  }
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/**
 * True when the bytes look like markup (SVG/XML/HTML): first non-
 * whitespace character "<" after an optional UTF-8 BOM.
 */
export function looksLikeMarkup(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  return bytes[i] === 0x3c;
}

/**
 * Image candidates for one NFT, best first. The indexer's own cache comes
 * first (thumbnail for the grid, its PNG conversion for the detail view —
 * a server-side rasterization, so even SVG artwork arrives as pixels and
 * no SVG is ever interpreted on the device), then the token's original
 * image. Indexer-cached originals whose reported type is SVG are skipped.
 * Spam-flagged NFTs get indexer-hosted candidates only (see the privacy
 * note on IPFS_GATEWAY). ERC-1155 {id} placeholders are substituted.
 */
export function imageCandidates(nft: OwnedNft, variant: 'thumb' | 'full'): string[] {
  const m = nft.media;
  const cachedIsSvg = (m.contentType ?? '').toLowerCase().includes('svg');
  const hosted = variant === 'thumb'
    ? [m.thumbnailUrl, m.pngUrl, cachedIsSvg ? null : m.cachedUrl]
    : [m.pngUrl, cachedIsSvg ? null : m.cachedUrl, m.thumbnailUrl];
  const origin = nft.spam === true ? [] : [m.originalUrl, m.metadataImage];
  const out: string[] = [];
  for (const candidate of [...hosted, ...origin]) {
    if (!candidate) continue;
    const value = nft.standard === 'erc1155' ? substituteErc1155Id(candidate, nft.tokenId) : candidate;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

export type ImageLoad =
  | { ok: true; dataUri: string; mime: RasterMime; byteLength: number; source: string }
  | {
      ok: false;
      /** 'svg': only vector/markup images were offered (never rendered). */
      reason: 'svg' | 'none' | 'unavailable';
      detail: string;
    };

async function fetchCapped(
  url: string,
  fetchFn: typeof fetch,
  maxBytes: number,
  accept: string,
  timeoutMs: number,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { accept },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`too large (${declared} bytes, limit ${maxBytes})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A server can omit or understate Content-Length; the decoded size is
    // checked again before anything is rendered or parsed.
    if (bytes.length > maxBytes) throw new Error(`too large (${bytes.length} bytes, limit ${maxBytes})`);
    return { bytes, contentType: (response.headers.get('content-type') ?? '').toLowerCase() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Loads the first candidate that is a raster image within the size cap
 * and returns it as a base64 data: URI for React Native's Image. Every
 * byte is fetched by this function (never handed to an image view as a
 * URL), so the size cap and the raster-only rule are enforced before
 * anything is decoded. SVG is refused outright, whatever the URL or
 * declared type says: SVG is a document format that can carry scripts and
 * external references, and rendering it would execute or fetch whatever
 * the NFT's author embedded. The screen shows a placeholder instead
 * (the indexer's PNG conversion, tried first, usually covers SVG art).
 */
export async function loadNftImage(
  candidates: string[],
  options: { fetchFn?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<ImageLoad> {
  const fetchFn = options.fetchFn ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? MEDIA_TIMEOUT_MS;
  if (candidates.length === 0) return { ok: false, reason: 'none', detail: 'No image is listed for this NFT.' };
  let sawSvg = false;
  const problems: string[] = [];
  for (const candidate of candidates.slice(0, 4)) {
    const resolved = resolveMediaUri(candidate);
    if (resolved.kind === 'unsupported') {
      problems.push(resolved.reason);
      continue;
    }
    let bytes: Uint8Array;
    let declared: string;
    if (resolved.kind === 'inline') {
      bytes = resolved.bytes;
      declared = resolved.mime;
      if (bytes.length > maxBytes) {
        problems.push('Inline image is too large.');
        continue;
      }
    } else {
      try {
        const got = await fetchCapped(
          resolved.url,
          fetchFn,
          maxBytes,
          'image/png,image/jpeg,image/gif,image/webp',
          timeoutMs,
        );
        bytes = got.bytes;
        declared = got.contentType;
      } catch (e) {
        problems.push(`Image host: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }
    const mime = sniffRaster(bytes);
    if (mime) {
      return {
        ok: true,
        dataUri: `data:${mime};base64,${base64.encode(bytes)}`,
        mime,
        byteLength: bytes.length,
        source: candidate,
      };
    }
    if (declared.includes('svg') || looksLikeMarkup(bytes)) {
      sawSvg = true;
      problems.push('SVG image refused.');
    } else {
      problems.push('Not a supported raster image.');
    }
  }
  if (sawSvg) {
    return {
      ok: false,
      reason: 'svg',
      detail: 'This NFT’s image is SVG, which the wallet does not render (SVG can carry scripts).',
    };
  }
  return { ok: false, reason: 'unavailable', detail: problems.join(' ') || 'Image unavailable.' };
}

export interface NftMetadataFields {
  name: string | null;
  description: string | null;
  /** The metadata's image URI, {id}-substituted for ERC-1155. */
  image: string | null;
}

export type MetadataLoad = { ok: true; fields: NftMetadataFields } | { ok: false; detail: string };

/**
 * Reads the token's own metadata JSON from its tokenURI — used only when
 * the indexer had none. Same resolution rules as images; at most
 * MAX_METADATA_BYTES; must be strict UTF-8 JSON with an object at the top.
 * Only name/description/image are read (the ERC-721 Metadata JSON Schema
 * fields), as plain strings; nothing in the document is executed or
 * followed except the image URI, which goes through loadNftImage.
 */
export async function fetchNftMetadata(
  nft: Pick<OwnedNft, 'tokenUri' | 'standard' | 'tokenId'>,
  options: { fetchFn?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<MetadataLoad> {
  if (!nft.tokenUri) return { ok: false, detail: 'This NFT has no metadata URI.' };
  const uri =
    nft.standard === 'erc1155' ? substituteErc1155Id(nft.tokenUri, nft.tokenId) : nft.tokenUri;
  const resolved = resolveMediaUri(uri);
  if (resolved.kind === 'unsupported') return { ok: false, detail: resolved.reason };
  const maxBytes = options.maxBytes ?? MAX_METADATA_BYTES;
  let bytes: Uint8Array;
  if (resolved.kind === 'inline') {
    bytes = resolved.bytes;
    if (bytes.length > maxBytes) return { ok: false, detail: 'Metadata is too large.' };
  } else {
    try {
      bytes = (
        await fetchCapped(
          resolved.url,
          options.fetchFn ?? fetch,
          maxBytes,
          'application/json',
          options.timeoutMs ?? MEDIA_TIMEOUT_MS,
        )
      ).bytes;
    } catch (e) {
      return {
        ok: false,
        detail: `Metadata unreachable: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(bytes));
  } catch {
    return { ok: false, detail: 'Metadata is not valid UTF-8 JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, detail: 'Metadata is not a JSON object.' };
  }
  const doc = parsed as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const image = text(doc.image);
  return {
    ok: true,
    fields: {
      name: sanitizeNftText(text(doc.name)),
      description: sanitizeNftText(text(doc.description), 600),
      image:
        image && nft.standard === 'erc1155' ? substituteErc1155Id(image, nft.tokenId) : image,
    },
  };
}

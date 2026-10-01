import { toChecksumAddress } from '@shiba-wallet/core';
import { toBytes } from './encoding.js';

/**
 * NFT ownership discovery through an indexer.
 *
 * A plain JSON-RPC node cannot list the NFTs an address owns: ERC-721's
 * enumeration extension is optional and ERC-1155 has none, so discovery
 * needs an indexer that has followed every Transfer/TransferSingle/
 * TransferBatch event. The wallet talks to indexers through the
 * vendor-neutral NftOwnershipProvider interface below; each vendor gets an
 * adapter that maps its documented response into OwnedNft. The first (and
 * so far only) adapter targets Alchemy's NFT API v3, and the base URL is
 * runtime configuration pasted by the user (it embeds the user's own API
 * key and is never compiled into the app).
 *
 * ALCHEMY NFT API v3 — shapes verified 2026-10-01 against the official
 * reference (markdown variant of the page) and one live read-only probe:
 *   https://www.alchemy.com/docs/reference/nft-api-endpoints/nft-api-endpoints/nft-ownership-endpoints/get-nf-ts-for-owner-v-3
 *   https://www.alchemy.com/docs/reference/nft-api-quickstart
 *
 *  - Request: GET {base}/getNFTsForOwner where the documented base is
 *    https://eth-mainnet.g.alchemy.com/nft/v3/{apiKey}. Query parameters
 *    used here: owner (required), withMetadata (default true), pageSize
 *    (default 100, max 100), pageKey (cursor from the previous response).
 *    Paid-tier-only filters (excludeFilters[]=SPAM, spamConfidenceLevel)
 *    are deliberately not sent.
 *  - Response: { ownedNfts: [...], totalCount, pageKey, validAt }. pageKey
 *    is a string while more results exist and null when exhausted (both
 *    observed live). validAt is { blockNumber, blockHash, blockTimestamp };
 *    live, blockHash came back null on mainnet and as a hash on Sepolia,
 *    so it is treated as optional.
 *  - Each owned NFT (withMetadata=true): contract { address, name, symbol,
 *    tokenType, isSpam, openSeaMetadata { collectionName, ... } }, tokenId,
 *    tokenType ("ERC721" | "ERC1155"; the contract-level tokenType can also
 *    be "NO_SUPPORTED_NFT_STANDARD" or "NOT_A_CONTRACT"), name,
 *    description, image { cachedUrl, thumbnailUrl, pngUrl, contentType,
 *    size, originalUrl }, raw { tokenUri, metadata { image, name, ... },
 *    error }, collection { name, slug, ... }, tokenUri, balance.
 *
 * Observed live, beyond the reference text:
 *  - tokenId is a DECIMAL string, including values far above 2^53 (e.g.
 *    3445436196967010480258345834651740054207471236845090380051889710107
 *    0583190115). It is parsed with BigInt from the string and never via a
 *    JavaScript number.
 *  - balance is a decimal string ("1", "26"); the reference lists it only
 *    in the examples, not in the schema.
 *  - contract.isSpam is a JSON boolean, although the schema text calls it
 *    a string "true"/"false"; both forms are accepted.
 *  - The schema names the OpenSea object `openseaMetadata` while examples
 *    and live responses use `openSeaMetadata`; both spellings are read.
 *
 * PRECISION: token ids and balances are exact bigints from the decimal
 * strings. An entry whose id or balance is not a plain decimal string in
 * uint256 range is skipped and counted, never approximated or guessed.
 * Entries whose token type is not ERC721/ERC1155 are skipped and counted
 * too (the wallet can only send those two standards).
 */

export type NftStandard = 'erc721' | 'erc1155';

/** Media references for one NFT, as reported by the indexer (unfetched). */
export interface NftMediaRefs {
  /** Indexer-hosted thumbnail (Alchemy: image.thumbnailUrl). */
  thumbnailUrl: string | null;
  /** Indexer-hosted PNG conversion (Alchemy: image.pngUrl). */
  pngUrl: string | null;
  /** Indexer-cached original (Alchemy: image.cachedUrl). */
  cachedUrl: string | null;
  /** Content type of the cached original as reported (e.g. "image/svg+xml"). */
  contentType: string | null;
  /** The original image URL from the token's metadata (image.originalUrl). */
  originalUrl: string | null;
  /** raw.metadata.image verbatim (may be ipfs://, data:, http(s)). */
  metadataImage: string | null;
}

export interface OwnedNft {
  /** Contract address, EIP-55 checksummed. */
  contract: string;
  /** Exact token id. */
  tokenId: bigint;
  standard: NftStandard;
  /** Exact balance: always 1n for ERC-721; the owned amount for ERC-1155. */
  balance: bigint;
  /** Token name from the indexer's metadata (unsanitized; sanitize to display). */
  name: string | null;
  description: string | null;
  /** Collection name (collection.name, then OpenSea collectionName). */
  collectionName: string | null;
  /** Contract name()/symbol() as reported by the indexer. */
  contractName: string | null;
  contractSymbol: string | null;
  /** The token's metadata URI (tokenUri, then raw.tokenUri). */
  tokenUri: string | null;
  /** True when the indexer's metadata object is empty or reported an error. */
  metadataMissing: boolean;
  media: NftMediaRefs;
  /** Indexer's spam classification: true / false, or null when not reported. */
  spam: boolean | null;
}

/** The block the indexer's answer is valid at (used to bind it to a chain). */
export interface NftValidAt {
  blockNumber: bigint;
  /** 0x-prefixed 32-byte hash, or null when the indexer omitted it. */
  blockHash: string | null;
  /** ISO-8601 timestamp string, or null when omitted. */
  blockTimestamp: string | null;
}

export interface NftOwnershipPage {
  nfts: OwnedNft[];
  /** Opaque cursor for the next page; absent when exhausted. */
  nextCursor?: string;
  /** Entries dropped as unparseable or unsupported (see the precision note). */
  skipped: number;
  /** Indexer-reported total distinct token ids, when provided. */
  totalCount?: number;
  validAt: NftValidAt | null;
}

export interface NftOwnershipQuery {
  cursor?: string;
  /** Page size; adapters clamp it to their documented maximum. */
  pageSize?: number;
}

/** Vendor-neutral NFT ownership lookup. */
export interface NftOwnershipProvider {
  getOwnedNfts(owner: string, query?: NftOwnershipQuery): Promise<NftOwnershipPage>;
}

/** The fetch subset the adapter needs; the global fetch satisfies it. */
export type NftHttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Thrown for non-2xx answers so callers can tell auth failures apart. */
export class NftIndexerHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'NftIndexerHttpError';
  }
}

export interface AlchemyNftProviderOptions {
  fetchFn?: NftHttpFetch;
  /** Default page size (documented default 100, maximum 100). */
  pageSize?: number;
}

/** Documented maximum and default page size for getNFTsForOwner. */
export const ALCHEMY_NFT_MAX_PAGE_SIZE = 100;

const MAX_UINT256 = (1n << 256n) - 1n;
const DECIMAL = /^[0-9]{1,78}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** Parses a plain decimal uint256 string exactly; null when it is not one. */
export function parseDecimalUint256(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_UINT256 ? parsed : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function standardOf(tokenType: unknown): NftStandard | null {
  if (tokenType === 'ERC721') return 'erc721';
  if (tokenType === 'ERC1155') return 'erc1155';
  return null;
}

function spamOf(value: unknown): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

/**
 * Normalizes the user-pasted base URL: trailing slashes and a pasted
 * "/getNFTsForOwner" suffix are removed. Nothing else is rewritten — in
 * particular a JSON-RPC URL is never turned into an NFT API URL by
 * guessing (see the probe hint in alchemyNftOwnershipProvider).
 */
export function normalizeNftBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/getNFTsForOwner$/i, '')
    .replace(/\/+$/, '');
}

/** Maps one documented ownedNfts entry; null when it must be skipped. */
export function mapAlchemyOwnedNft(raw: unknown): OwnedNft | null {
  const nft = obj(raw);
  if (!nft) return null;
  const contract = obj(nft.contract);
  const address = contract ? str(contract.address) : str(nft.contractAddress);
  if (!address || !ADDRESS.test(address)) return null;

  const tokenId = parseDecimalUint256(nft.tokenId);
  if (tokenId === null) return null;

  const standard = standardOf(nft.tokenType) ?? standardOf(contract?.tokenType);
  if (!standard) return null;

  let balance: bigint;
  const reported = nft.balance === undefined ? undefined : parseDecimalUint256(nft.balance);
  if (standard === 'erc721') {
    // An ERC-721 token id has exactly one owner, so ownership means a
    // balance of one by the standard itself. A reported balance other
    // than "1" is inconsistent data and the entry is skipped.
    if (reported !== undefined && reported !== 1n) return null;
    balance = 1n;
  } else {
    if (reported === undefined || reported === null || reported === 0n) return null;
    balance = reported;
  }

  const image = obj(nft.image);
  const rawPart = obj(nft.raw);
  const rawMetadata = obj(rawPart?.metadata);
  const collection = obj(nft.collection);
  const openSea = obj(contract?.openSeaMetadata) ?? obj(contract?.openseaMetadata);

  return {
    contract: toChecksumAddress(toBytes(address.toLowerCase())),
    tokenId,
    standard,
    balance,
    name: str(nft.name) ?? str(rawMetadata?.name),
    description: str(nft.description) ?? str(rawMetadata?.description),
    collectionName: str(collection?.name) ?? str(openSea?.collectionName),
    contractName: str(contract?.name),
    contractSymbol: str(contract?.symbol),
    tokenUri: str(nft.tokenUri) ?? str(rawPart?.tokenUri),
    metadataMissing:
      !rawMetadata || Object.keys(rawMetadata).length === 0 || str(rawPart?.error) !== null,
    media: {
      thumbnailUrl: str(image?.thumbnailUrl),
      pngUrl: str(image?.pngUrl),
      cachedUrl: str(image?.cachedUrl),
      contentType: str(image?.contentType),
      originalUrl: str(image?.originalUrl),
      metadataImage: str(rawMetadata?.image),
    },
    spam: spamOf(contract?.isSpam),
  };
}

function parseValidAt(raw: unknown): NftValidAt | null {
  const v = obj(raw);
  if (!v) return null;
  let blockNumber: bigint | null = null;
  if (typeof v.blockNumber === 'number' && Number.isSafeInteger(v.blockNumber) && v.blockNumber >= 0) {
    blockNumber = BigInt(v.blockNumber);
  } else if (typeof v.blockNumber === 'string') {
    blockNumber = parseDecimalUint256(v.blockNumber);
  }
  if (blockNumber === null) return null;
  const hash = str(v.blockHash);
  return {
    blockNumber,
    blockHash: hash && HASH.test(hash) ? hash.toLowerCase() : null,
    blockTimestamp: str(v.blockTimestamp),
  };
}

/**
 * NftOwnershipProvider over Alchemy's getNFTsForOwner (NFT API v3).
 * `baseUrl` is the user's pasted endpoint, e.g.
 * https://eth-mainnet.g.alchemy.com/nft/v3/<key>. The cursor is the
 * documented pageKey passed through verbatim.
 */
export function alchemyNftOwnershipProvider(
  baseUrl: string,
  options: AlchemyNftProviderOptions = {},
): NftOwnershipProvider {
  const fetchFn: NftHttpFetch = options.fetchFn ?? (fetch as unknown as NftHttpFetch);
  const base = normalizeNftBaseUrl(baseUrl);
  const defaultPageSize = options.pageSize ?? ALCHEMY_NFT_MAX_PAGE_SIZE;

  return {
    async getOwnedNfts(owner, query = {}) {
      if (!ADDRESS.test(owner)) throw new Error('NFT owner must be a 0x address');
      const pageSize = Math.max(
        1,
        Math.min(ALCHEMY_NFT_MAX_PAGE_SIZE, Math.floor(query.pageSize ?? defaultPageSize)),
      );
      const params = [
        `owner=${encodeURIComponent(owner)}`,
        'withMetadata=true',
        `pageSize=${pageSize}`,
        ...(query.cursor ? [`pageKey=${encodeURIComponent(query.cursor)}`] : []),
      ];
      const response = await fetchFn(`${base}/getNFTsForOwner?${params.join('&')}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        const hint = /\/v2\/[^/]+$/.test(base)
          ? ' This looks like a JSON-RPC URL (…/v2/…); the NFT API is served under a different path (…/nft/v3/…).'
          : '';
        throw new NftIndexerHttpError(
          response.status,
          response.status === 401 || response.status === 403
            ? `The NFT indexer rejected the request (HTTP ${response.status}); check the API key in the URL.`
            : `The NFT indexer answered HTTP ${response.status} for getNFTsForOwner.${hint}`,
        );
      }
      const body = obj(await response.json());
      if (!body || !Array.isArray(body.ownedNfts)) {
        throw new Error(
          'The endpoint did not return an ownedNfts array from getNFTsForOwner; ' +
            'it does not appear to serve the NFT API.',
        );
      }
      const nfts: OwnedNft[] = [];
      let skipped = 0;
      for (const entry of body.ownedNfts) {
        const mapped = mapAlchemyOwnedNft(entry);
        if (mapped) nfts.push(mapped);
        else skipped += 1;
      }
      const pageKey = str(body.pageKey);
      return {
        nfts,
        skipped,
        ...(pageKey ? { nextCursor: pageKey } : {}),
        ...(typeof body.totalCount === 'number' && Number.isSafeInteger(body.totalCount)
          ? { totalCount: body.totalCount }
          : {}),
        validAt: parseValidAt(body.validAt),
      };
    },
  };
}

/**
 * Save-time verification for Settings: one single-entry ownership query
 * for the wallet's own address must answer with a well-formed page that
 * carries validAt (the block the answer is valid at). The caller binds
 * that block to the active chain through its own node — see the app's
 * wallet/nfts.ts — because a REST indexer has no eth_chainId to compare.
 * Throws (so nothing is persisted) on any failure.
 */
export async function verifyNftOwnershipEndpoint(
  provider: NftOwnershipProvider,
  owner: string,
): Promise<{ sampleCount: number; validAt: NftValidAt }> {
  const page = await provider.getOwnedNfts(owner, { pageSize: 1 });
  if (!page.validAt) {
    throw new Error(
      'The NFT indexer did not report which block its answer is valid at (validAt), ' +
        'so its network cannot be confirmed.',
    );
  }
  return { sampleCount: page.nfts.length + page.skipped, validAt: page.validAt };
}

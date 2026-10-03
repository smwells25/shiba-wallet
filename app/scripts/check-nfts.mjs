// Exercises the NFT gallery and send glue (src/wallet/nfts.ts and
// src/wallet/send-nft.ts) entirely OFFLINE: a fake NFT indexer (Alchemy
// NFT API v3 getNFTsForOwner shapes), fake media hosts and a fake JSON-RPC
// node answer every request the real code makes. Covered: ownership
// parsing incl. token ids above 2^53 and ERC-1155 balances above 2^64, the
// verify-before-save config store (every reject case persists nothing), the
// per-account cache, collection grouping and text sanitizing, the metadata
// and image URI rules incl. SVG refusal and size caps, calldata equal to
// ethers-encoded bytes, the balance-change preview's NFT line, and an
// offline sign+broadcast whose raw transaction is decoded by ethers (target
// contract, calldata, value 0, recovered sender). Nothing here touches a
// real endpoint and nothing is broadcast.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-nfts.mjs
//
// The signing key derives from the standard BIP-39 test mnemonic
// ("abandon ... about"), which is public knowledge.

import { Interface, Transaction, AbiCoder, zeroPadValue, id as ethersId } from 'ethers';
import { evmKeyProvider, mnemonicToSeed, formatAssetId, nonFungibleAssetId, nonFungibleTokenId } from '@shiba-wallet/core';
import { toHex } from '@shiba-wallet/chains-evm';
import {
  IPFS_GATEWAY,
  MAX_IMAGE_BYTES,
  NFT_CACHE_TTL_MS,
  clearNftCache,
  clearNftIndexerUrl,
  confirmIndexerChain,
  fetchNftMetadata,
  getCachedNft,
  getNftIndexerConfig,
  groupNftsByCollection,
  imageCandidates,
  invalidateNftCache,
  loadMoreNfts,
  loadNftImage,
  loadNfts,
  looksLikeMarkup,
  nftAssetIdString,
  nftDisplayName,
  nftExplorerUrl,
  resolveMediaUri,
  sanitizeNftText,
  setNftIndexerUrl,
  sniffRaster,
} from '../src/wallet/nfts.ts';
import {
  NFT_TRANSFER_GAS_FALLBACK,
  describeNftSendError,
  maxNft1155Send,
  nftTransferCalldata,
  parseNftAmount,
  prepareNftSend,
  sendNft,
} from '../src/wallet/send-nft.ts';
import { describeAssetChanges, runBalancePreview } from '../src/wallet/simulation.ts';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}` : ''}`);
  }
}

async function rejects(name, fn, pattern) {
  try {
    const value = await fn();
    check(name, false, `expected a rejection, got ${String(value)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, pattern.test(message), `error was: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const signer = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);
const ME = signer.address; // 0x9858EfFD232B4033E47d90003D41EC34EcaEda94
const OTHER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const C721 = '0x0bEed7099AF7514cCEDF642CfEA435731176Fb02';
const C1155 = '0x209cE666978779756Ae1E747608cD93e4dFf45fD';
const CSPAM = '0x5193Ecd0D1D059F094861434eD98a39e4297CAD1';
const BIG_ID = 34454361969670104802583458346517400542074712368450903800518897101070583190115n;
const BIG_1155 = 18446744073709551617n; // 2^64 + 1
const MAINNET = 'eip155:1';
const SEPOLIA = 'eip155:11155111';
const NFT_BASE = 'https://nft.fake/nft/v3/KEY';
const RPC = 'https://rpc.fake/';
// A developer's local NFT API over plain http:// on a loopback host (the one
// allowed exception to the https rule).
const LOCAL_NFT_BASE = 'http://127.0.0.1:8080/nft/v3/KEY';
const TINY_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const SVG_BYTES = new TextEncoder().encode(SVG_TEXT);

const VALID_AT = { blockNumber: 26100003, blockHash: null, blockTimestamp: '2026-10-01T20:57:35Z' };
const BLOCK_TS = '0x' + (Date.parse('2026-10-01T20:57:35Z') / 1000).toString(16);
const SEPOLIA_HASH = '0x7b2f9a2f66d7c7c0dd718d84d84ebc6027f864d780a97f04b12634459b9321b6';

function entry({ contract, id, type, balance, name = null, spam = null, image = {}, raw = {}, collection = null }) {
  return {
    contract: { address: contract, name: `${name ?? 'C'} contract`, tokenType: type, isSpam: spam },
    tokenId: id,
    tokenType: type,
    name,
    description: null,
    image: { cachedUrl: null, thumbnailUrl: null, pngUrl: null, contentType: null, originalUrl: null, ...image },
    raw: { tokenUri: null, metadata: {}, error: null, ...raw },
    collection: collection ? { name: collection } : undefined,
    tokenUri: raw.tokenUri ?? null,
    balance,
  };
}

const PAGE1 = [
  entry({
    contract: C721.toLowerCase(), id: BIG_ID.toString(), type: 'ERC721', balance: '1', name: 'Big\u202Eid\u0000 token',
    collection: 'Duskish', image: { thumbnailUrl: 'https://cdn.fake/thumb/1', pngUrl: 'https://cdn.fake/png/1', originalUrl: 'https://origin.fake/1.png' },
    raw: { metadata: { name: 'Big id token' } },
  }),
  entry({ contract: C721, id: '28', type: 'ERC721', balance: '1', name: 'Dusk #28', collection: 'Duskish', raw: { metadata: { name: 'x' } } }),
  entry({
    contract: C1155, id: '97', type: 'ERC1155', balance: BIG_1155.toString(), collection: 'Knights',
    raw: { tokenUri: 'https://meta.fake/{id}.json', metadata: {} },
  }),
  entry({ contract: CSPAM, id: '5', type: 'ERC1155', balance: '3', name: 'Visit claim-site.example to claim', spam: true, collection: 'AAA spam',
    image: { thumbnailUrl: 'https://cdn.fake/thumb/spam', originalUrl: 'https://tracker.fake/pixel.png' } }),
  entry({ contract: C721, id: '0x1c', type: 'ERC721', balance: '1' }), // hex id: skipped
  entry({ contract: C721, id: '7', type: 'NO_SUPPORTED_NFT_STANDARD', balance: '1' }), // skipped
  entry({ contract: C721, id: '8', type: 'ERC721', balance: '26' }), // live-observed spam shape: skipped
];
const PAGE2 = [entry({ contract: C721, id: '29', type: 'ERC721', balance: '1', name: 'Dusk #29', collection: 'Duskish', raw: { metadata: { name: 'y' } } })];

// ---------------------------------------------------------------------------
// Fake network: one router behind global fetch.
// ---------------------------------------------------------------------------

const requests = [];
let indexer = {};
let node = {};
let media = {};
let lastRawTx = null;

function defaultIndexer() {
  return { status: 200, pages: { first: { ownedNfts: PAGE1, totalCount: 5, validAt: VALID_AT, pageKey: 'page-2-key' }, 'page-2-key': { ownedNfts: PAGE2, validAt: VALID_AT, pageKey: null } } };
}

const coder = AbiCoder.defaultAbiCoder();
const word = (v) => coder.encode(['uint256'], [v]);
const erc721 = new Interface([
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);
const erc1155 = new Interface([
  'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
]);
const SEL_OWNER_OF = erc721.getFunction('ownerOf').selector;
const SEL_BALANCE_OF = erc1155.getFunction('balanceOf').selector;
const SEL_721_SAFE = erc721.getFunction('safeTransferFrom(address,address,uint256)').selector;
const SEL_1155_SAFE = erc1155.getFunction('safeTransferFrom').selector;

function defaultNode() {
  return {
    chainId: '0x1',
    head: 26100010n,
    block: { hash: '0x' + 'ab'.repeat(32), timestamp: BLOCK_TS },
    ethBalance: 10n ** 17n,
    owner: ME,
    ownerOfError: null,
    balance1155: 5n,
    estimateGas: 85000n,
    estimateGasError: null,
    transferError: null,
    txid: '0x' + 'cd'.repeat(32),
  };
}

function rpc(method, params) {
  const s = node;
  switch (method) {
    case 'eth_chainId': return s.chainId;
    case 'eth_blockNumber': return '0x' + s.head.toString(16);
    case 'eth_getBlockByNumber':
      if (params[0] === 'latest') return { baseFeePerGas: '0x' + (10n ** 9n).toString(16) };
      return BigInt(params[0]) <= s.head ? s.block : null;
    case 'eth_maxPriorityFeePerGas': return '0x' + (10n ** 9n).toString(16);
    case 'eth_getBalance': return '0x' + s.ethBalance.toString(16);
    case 'eth_getTransactionCount': return '0x7';
    case 'eth_estimateGas':
      if (s.estimateGasError) throw { code: 3, message: s.estimateGasError };
      return '0x' + s.estimateGas.toString(16);
    case 'eth_call': {
      const data = params[0].data;
      if (data.startsWith(SEL_OWNER_OF)) {
        if (s.ownerOfError) throw { code: 3, message: s.ownerOfError };
        return zeroPadValue(s.owner, 32);
      }
      if (data.startsWith(SEL_BALANCE_OF)) return word(s.balance1155);
      if (data.startsWith(SEL_721_SAFE) || data.startsWith(SEL_1155_SAFE)) {
        if (s.transferError) throw { code: 3, message: s.transferError, data: '0x' };
        return '0x';
      }
      throw { code: -32000, message: `unexpected eth_call ${data.slice(0, 10)}` };
    }
    case 'eth_sendRawTransaction':
      lastRawTx = params[0];
      return s.txid;
    case 'eth_simulateV1': {
      // One ERC-721 Transfer(from=ME, to=OTHER, id=BIG_ID) log, as the
      // balance-change preview would see for the 721 send.
      const topic0 = ethersId('Transfer(address,address,uint256)');
      return [{ number: '0x1', calls: [{ returnData: '0x', gasUsed: '0x1', status: '0x1', logs: [{
        address: C721.toLowerCase(),
        topics: [topic0, zeroPadValue(ME, 32).toLowerCase(), zeroPadValue(OTHER, 32).toLowerCase(), word(BIG_ID)],
        data: '0x',
      }] }] }];
    }
    default: throw { code: -32601, message: `unexpected method ${method}` };
  }
}

function headersOf(map) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (k) => lower[k.toLowerCase()] ?? null };
}

globalThis.fetch = async (url, init = {}) => {
  requests.push({ url, init });
  if (url.startsWith(NFT_BASE) || url.startsWith('https://nft.fake/') || url.startsWith(LOCAL_NFT_BASE)) {
    if (indexer.status !== 200) return { ok: false, status: indexer.status, headers: headersOf({}), json: async () => ({ error: { message: 'Must be authenticated!' } }) };
    const key = new URL(url).searchParams.get('pageKey') ?? 'first';
    return { ok: true, status: 200, headers: headersOf({}), json: async () => indexer.pages[key] };
  }
  if (url === RPC) {
    const { method, params, id } = JSON.parse(init.body);
    let body;
    try {
      body = { jsonrpc: '2.0', id, result: rpc(method, params) };
    } catch (e) {
      body = { jsonrpc: '2.0', id, error: { code: e.code ?? -32000, message: e.message, ...(e.data ? { data: e.data } : {}) } };
    }
    return { ok: true, status: 200, headers: headersOf({}), json: async () => body };
  }
  const m = media[url];
  if (!m) return { ok: false, status: 404, headers: headersOf({}), arrayBuffer: async () => new ArrayBuffer(0) };
  return {
    ok: m.status ? m.status < 300 : true,
    status: m.status ?? 200,
    headers: headersOf(m.headers ?? {}),
    arrayBuffer: async () => m.bytes.buffer.slice(m.bytes.byteOffset, m.bytes.byteOffset + m.bytes.byteLength),
  };
};

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: async (k) => (k in data ? data[k] : null),
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Config store: verify-before-save
// ---------------------------------------------------------------------------

console.log('config store (verify-before-save):');
{
  indexer = defaultIndexer();
  node = defaultNode();
  const store = memoryStore();
  const nothing = async () => JSON.stringify(store.data);

  const before = await nothing();
  await rejects('non-http URL refused', () => setNftIndexerUrl(MAINNET, 'ftp://x', ME, RPC, { store }), /^Endpoints must use https:\/\//);
  {
    const sentBefore = requests.length;
    await rejects(
      'plain http:// NFT indexer refused with the https sentence',
      () => setNftIndexerUrl(MAINNET, 'http://nft.fake/nft/v3/KEY', ME, RPC, { store }),
      /^Endpoints must use https:\/\/ \(plain http:\/\/ is accepted only for localhost or 10\.0\.2\.2 during development\)\.$/,
    );
    await rejects(
      'plain http:// RPC URL for the chain check refused',
      () => setNftIndexerUrl(MAINNET, NFT_BASE, ME, 'http://rpc.fake/', { store }),
      /^Endpoints must use https:\/\//,
    );
    check('http refusals made no request at all', requests.length === sentBefore);
  }
  indexer = { ...defaultIndexer(), status: 401 };
  await rejects('HTTP 401 (bad key) refused', () => setNftIndexerUrl(MAINNET, NFT_BASE, ME, RPC, { store }), /API key/);
  indexer = { status: 200, pages: { first: { jsonrpc: '2.0', result: '0x1' } } };
  await rejects('non-NFT endpoint refused', () => setNftIndexerUrl(MAINNET, NFT_BASE, ME, RPC, { store }), /ownedNfts/);
  indexer = { status: 200, pages: { first: { ownedNfts: [] } } };
  await rejects('missing validAt refused', () => setNftIndexerUrl(MAINNET, NFT_BASE, ME, RPC, { store }), /validAt/);
  // Observed live: the JSON-RPC URL (/v2/<key>) answers getNFTsForOwner in
  // the older shape without validAt; it is refused with a pointer to /nft/v3/.
  await rejects('JSON-RPC (/v2/) URL refused with a hint', () => setNftIndexerUrl(MAINNET, 'https://nft.fake/v2/KEY', ME, RPC, { store }), /validAt.*JSON-RPC URL.*nft\/v3/);
  indexer = defaultIndexer();
  node = { ...defaultNode(), head: 11824347n };
  await rejects('mainnet indexer against a Sepolia-height node refused (different network)', () => setNftIndexerUrl(SEPOLIA, NFT_BASE, ME, RPC, { store, chainLabel: 'Ethereum Sepolia' }), /different network/);
  node = { ...defaultNode(), head: 26100000n };
  await rejects('indexer slightly ahead of the node -> retry message, nothing saved', () => setNftIndexerUrl(MAINNET, NFT_BASE, ME, RPC, { store }), /Try again in a minute/);
  node = { ...defaultNode(), block: { hash: '0x' + 'ab'.repeat(32), timestamp: '0x1' } };
  await rejects('timestamp mismatch refused', () => setNftIndexerUrl(MAINNET, NFT_BASE, ME, RPC, { store }), /different timestamp/);
  indexer = { status: 200, pages: { first: { ownedNfts: [], validAt: { blockNumber: 11824347, blockHash: SEPOLIA_HASH, blockTimestamp: '2026-10-01T20:58:00Z' }, pageKey: null } } };
  node = defaultNode();
  await rejects('block hash mismatch refused', () => setNftIndexerUrl(SEPOLIA, NFT_BASE, ME, RPC, { store }), /different hash/);
  check('every reject case persisted nothing', (await nothing()) === before, await nothing());
  check('still unconfigured', (await getNftIndexerConfig(MAINNET, store)).url === null);

  // Hash match (Sepolia-style answer) is accepted.
  node = { ...defaultNode(), block: { hash: SEPOLIA_HASH.toUpperCase().replace('0X', '0x'), timestamp: '0x0' } };
  await setNftIndexerUrl(SEPOLIA, `${NFT_BASE}/getNFTsForOwner/`, ME, RPC, { store });
  const sep = await getNftIndexerConfig(SEPOLIA, store);
  check('hash-bound save persisted (pasted suffix normalized away)', sep.url === NFT_BASE && sep.verifiedBlock === '11824347', sep);
  // Timestamp match (mainnet-style answer with null blockHash) is accepted.
  indexer = defaultIndexer();
  node = defaultNode();
  await setNftIndexerUrl(MAINNET, NFT_BASE, ME, RPC, { store });
  const main = await getNftIndexerConfig(MAINNET, store);
  check('timestamp-bound save persisted', main.url === NFT_BASE && typeof main.verifiedAt === 'string', main);
  check('modes stay separate (two keys)', sep.url !== null && main.url !== null);
  await clearNftIndexerUrl(SEPOLIA, store);
  check('clear removes only that chain', (await getNftIndexerConfig(SEPOLIA, store)).url === null && (await getNftIndexerConfig(MAINNET, store)).url === NFT_BASE);
  // Loopback development exception: a local NFT API over http:// verifies
  // and saves like any other.
  {
    const local = memoryStore();
    indexer = defaultIndexer();
    node = defaultNode();
    await setNftIndexerUrl(MAINNET, `${LOCAL_NFT_BASE}/`, ME, RPC, { store: local });
    check(
      'loopback http://127.0.0.1 NFT indexer accepted after verification',
      (await getNftIndexerConfig(MAINNET, local)).url === LOCAL_NFT_BASE,
    );
  }
  const corrupt = memoryStore({ 'shiba-wallet.nft-indexer.v1': '{not json' });
  check('corrupt storage reads as unconfigured', (await getNftIndexerConfig(MAINNET, corrupt)).url === null);

  // The chain-binding helper on its own: no hash and no timestamp.
  await rejects('neither hash nor timestamp -> cannot confirm', () => confirmIndexerChain({ blockNumber: 1n, blockHash: null, blockTimestamp: null }, async (m) => (m === 'eth_getBlockByNumber' ? { hash: '0x', timestamp: '0x1' } : '0x5'), 'X'), /cannot be confirmed/);
  globalThis.__store = store;
}

// ---------------------------------------------------------------------------
// 2. Ownership loading, cache, grouping, sanitizing
// ---------------------------------------------------------------------------

console.log('ownership + cache:');
{
  const store = globalThis.__store;
  clearNftCache();
  indexer = defaultIndexer();
  const unconfigured = await loadNfts({ chainId: SEPOLIA, accountIndex: 0, owner: ME, store });
  check('unconfigured chain -> unconfigured state', unconfigured.status === 'unconfigured');

  let t = 1_000_000;
  const now = () => t;
  const first = await loadNfts({ chainId: MAINNET, accountIndex: 0, owner: ME, store, now });
  check('first page loaded', first.status === 'ok' && !first.fromCache && first.nfts.length === 4, first.status === 'ok' ? first.nfts.length : first);
  check('unrepresentable entries skipped and counted', first.skipped === 3, first.skipped);
  const big = first.nfts.find((n) => n.tokenId === BIG_ID);
  check('token id above 2^53 is exact', big !== undefined && big.tokenId.toString() === BIG_ID.toString());
  const k1155 = first.nfts.find((n) => n.standard === 'erc1155' && n.tokenId === 97n);
  check('ERC-1155 balance above 2^64 is exact', k1155?.balance === BIG_1155, k1155?.balance?.toString());
  check('lowercase contract normalized to EIP-55', big?.contract === C721);
  check('cursor present', first.nextCursor === 'page-2-key');
  const indexerCalls = () => requests.filter((r) => r.url.startsWith(NFT_BASE)).length;
  const callsBefore = indexerCalls();
  const again = await loadNfts({ chainId: MAINNET, accountIndex: 0, owner: ME, store, now });
  check('second load within TTL served from cache', again.fromCache && indexerCalls() === callsBefore);
  const other = await loadNfts({ chainId: MAINNET, accountIndex: 1, owner: OTHER, store, now });
  check('another account index is a separate cache entry', !other.fromCache && indexerCalls() === callsBefore + 1);
  check('request was for that account’s owner', requests.at(-1).url.includes(`owner=${OTHER}`));
  const reimported = await loadNfts({ chainId: MAINNET, accountIndex: 0, owner: OTHER, store, now });
  check('same index, different owner (re-import) never reuses the cache', !reimported.fromCache);
  await loadNfts({ chainId: MAINNET, accountIndex: 0, owner: ME, store, now, refresh: true });
  t += NFT_CACHE_TTL_MS + 1;
  const expired = await loadNfts({ chainId: MAINNET, accountIndex: 0, owner: ME, store, now });
  check('expired entry refetched', !expired.fromCache);
  const more = await loadMoreNfts({ chainId: MAINNET, accountIndex: 0, owner: ME, store, now });
  check('load more appends page 2 and ends', more.status === 'ok' && more.nfts.length === 5 && more.nextCursor === undefined, more.status === 'ok' ? more.nfts.length : more);
  check('page 2 request carried the pageKey verbatim', requests.at(-1).url.includes('pageKey=page-2-key'));
  const assetId = nftAssetIdString(MAINNET, big);
  check('CAIP-19 id is canonical decimal', assetId === `eip155:1/erc721:${C721}/${BIG_ID}` && nonFungibleTokenId(assetId) === BIG_ID, assetId);
  check('detail lookup finds the cached NFT', getCachedNft(0, MAINNET, ME, assetId)?.tokenId === BIG_ID);
  check('detail lookup refuses another owner', getCachedNft(0, MAINNET, OTHER, assetId) === null);
  invalidateNftCache(0, MAINNET);
  check('invalidate drops the entry', getCachedNft(0, MAINNET, ME, assetId) === null);

  const groups = groupNftsByCollection(more.nfts);
  check('grouped by contract (3 collections)', groups.length === 3, groups.map((g) => g.title));
  check('spam collection sorts last even though its title sorts first', groups.at(-1).spam === true && groups.at(-1).contract === CSPAM);
  const dusk = groups.find((g) => g.contract === C721);
  check('items sorted by exact bigint id', dusk.items.map((n) => n.tokenId.toString()).join(',') === `28,29,${BIG_ID}`);
  check('bidi/control characters stripped from names', nftDisplayName(big) === 'Bigid token', nftDisplayName(big));
  check('nameless ERC-1155 falls back to "Collection #id"', nftDisplayName(k1155) === 'Knights #97', nftDisplayName(k1155));
  check('sanitize truncates long text', sanitizeNftText('x'.repeat(100), 10) === 'xxxxxxxxxx…');
  check('explorer link (mainnet)', nftExplorerUrl(MAINNET, big) === `https://etherscan.io/nft/${C721}/${BIG_ID}`);
  check('explorer link (Sepolia)', nftExplorerUrl(SEPOLIA, big) === `https://sepolia.etherscan.io/nft/${C721}/${BIG_ID}`);
  check('no guessed explorer for unknown chains', nftExplorerUrl('eip155:10', big) === null);
  globalThis.__nfts = more.nfts;
}

// ---------------------------------------------------------------------------
// 3. Metadata and media rules
// ---------------------------------------------------------------------------

console.log('metadata + media rules:');
{
  const r1 = resolveMediaUri('ipfs://QmV4s7NMmDh64Z2GkuqbUmRM7XyN5WcbTn9sSAVvCsK4xQ/1001.gif');
  check('ipfs:// -> public gateway', r1.kind === 'remote' && r1.viaGateway && r1.url === `${IPFS_GATEWAY}QmV4s7NMmDh64Z2GkuqbUmRM7XyN5WcbTn9sSAVvCsK4xQ/1001.gif`, r1);
  const r2 = resolveMediaUri('ipfs://ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
  check('legacy ipfs://ipfs/ form', r2.kind === 'remote' && r2.url === `${IPFS_GATEWAY}bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`);
  check('https passed through', resolveMediaUri(' https://a.example/x.png ').url === 'https://a.example/x.png');
  check('http passed through', resolveMediaUri('http://a.example/x.png').kind === 'remote');
  check('ar:// refused', resolveMediaUri('ar://abc').kind === 'unsupported');
  check('javascript: refused', resolveMediaUri('javascript:alert(1)').kind === 'unsupported');
  check('relative path refused', resolveMediaUri('/img/1.png').kind === 'unsupported');
  check('malformed ipfs refused', resolveMediaUri('ipfs://../etc').kind === 'unsupported');
  const d1 = resolveMediaUri('data:application/json;base64,' + Buffer.from('{"name":"x"}').toString('base64').replace(/=+$/, ''));
  check('data: base64 decoded locally (padding restored)', d1.kind === 'inline' && new TextDecoder().decode(d1.bytes) === '{"name":"x"}', d1);
  const d2 = resolveMediaUri('data:application/json,%7B%22name%22%3A%22caf%C3%A9%22%7D');
  check('data: percent-encoded decoded locally', d2.kind === 'inline' && new TextDecoder().decode(d2.bytes) === '{"name":"café"}');

  check('PNG sniffed', sniffRaster(TINY_PNG) === 'image/png');
  check('JPEG sniffed', sniffRaster(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])) === 'image/jpeg');
  check('GIF sniffed', sniffRaster(new TextEncoder().encode('GIF89a....')) === 'image/gif');
  check('WebP sniffed', sniffRaster(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')) === 'image/webp');
  check('SVG is not raster', sniffRaster(SVG_BYTES) === null && looksLikeMarkup(SVG_BYTES));
  check('BOM + whitespace markup detected', looksLikeMarkup(Uint8Array.from([0xef, 0xbb, 0xbf, 0x20, 0x0a, 0x3c])));

  media = {
    'https://cdn.fake/png/ok': { bytes: TINY_PNG, headers: { 'content-type': 'image/png', 'content-length': String(TINY_PNG.length) } },
    'https://cdn.fake/svg-lying': { bytes: SVG_BYTES, headers: { 'content-type': 'image/png' } },
    'https://cdn.fake/huge-declared': { bytes: TINY_PNG, headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } },
    'https://cdn.fake/huge-actual': { bytes: new Uint8Array(MAX_IMAGE_BYTES + 1).fill(0x89), headers: {} },
    'https://cdn.fake/html': { bytes: new TextEncoder().encode('<!doctype html><html></html>'), headers: { 'content-type': 'text/html' } },
    [`${IPFS_GATEWAY}QmPng/1.png`]: { bytes: TINY_PNG, headers: {} },
    ['https://meta.fake/' + (97n).toString(16).padStart(64, '0') + '.json']: { bytes: new TextEncoder().encode(JSON.stringify({ name: 'Knight\u202E 97', description: 'd', image: 'ipfs://QmPng/{id}.png' })), headers: {} },
    'https://meta.fake/bad.json': { bytes: new TextEncoder().encode('{nope'), headers: {} },
    'https://meta.fake/big.json': { bytes: new Uint8Array(600 * 1024).fill(0x20), headers: {} },
  };
  const ok = await loadNftImage(['https://cdn.fake/png/ok']);
  check('raster image -> base64 data URI', ok.ok && ok.dataUri === `data:image/png;base64,${Buffer.from(TINY_PNG).toString('base64')}`, ok);
  const svgInline = await loadNftImage(['data:image/svg+xml;base64,' + Buffer.from(SVG_TEXT).toString('base64')]);
  check('SVG data URI refused (placeholder reason svg)', !svgInline.ok && svgInline.reason === 'svg', svgInline);
  const svgUtf8 = await loadNftImage(['data:image/svg+xml;utf8,' + encodeURIComponent(SVG_TEXT)]);
  check('percent-encoded SVG data URI refused', !svgUtf8.ok && svgUtf8.reason === 'svg');
  const lying = await loadNftImage(['https://cdn.fake/svg-lying']);
  check('SVG served as image/png refused by sniffing', !lying.ok && lying.reason === 'svg', lying);
  const html = await loadNftImage(['https://cdn.fake/html']);
  check('HTML refused', !html.ok);
  const huge1 = await loadNftImage(['https://cdn.fake/huge-declared']);
  check('declared size over the cap refused', !huge1.ok && /too large/.test(huge1.detail), huge1);
  const huge2 = await loadNftImage(['https://cdn.fake/huge-actual']);
  check('actual size over the cap refused', !huge2.ok && /too large/.test(huge2.detail), huge2);
  const fallthrough = await loadNftImage(['data:image/svg+xml;base64,PHN2Zz4=', 'https://cdn.fake/missing', 'https://cdn.fake/png/ok']);
  check('falls through SVG and 404 to the raster candidate', fallthrough.ok && fallthrough.source === 'https://cdn.fake/png/ok');
  const none = await loadNftImage([]);
  check('no candidates -> honest none', !none.ok && none.reason === 'none');
  const unreachable = await loadNftImage(['https://cdn.fake/missing']);
  check('unreachable -> unavailable placeholder', !unreachable.ok && unreachable.reason === 'unavailable');

  const nfts = globalThis.__nfts;
  const big = nfts.find((n) => n.tokenId === BIG_ID);
  check('grid candidates: indexer thumbnail first, origin last', JSON.stringify(imageCandidates(big, 'thumb')) === JSON.stringify(['https://cdn.fake/thumb/1', 'https://cdn.fake/png/1', 'https://origin.fake/1.png']), imageCandidates(big, 'thumb'));
  check('detail candidates: PNG conversion first', imageCandidates(big, 'full')[0] === 'https://cdn.fake/png/1');
  const spam = nfts.find((n) => n.spam === true);
  check('spam NFTs never load from their original hosts', JSON.stringify(imageCandidates(spam, 'full')) === JSON.stringify(['https://cdn.fake/thumb/spam']), imageCandidates(spam, 'full'));
  const svgCached = { ...big, media: { ...big.media, thumbnailUrl: null, pngUrl: null, cachedUrl: 'https://cdn.fake/c', contentType: 'image/svg+xml' } };
  check('indexer-cached SVG originals are skipped', !imageCandidates(svgCached, 'full').includes('https://cdn.fake/c'));
  const k = nfts.find((n) => n.tokenId === 97n);
  const k2 = { ...k, media: { ...k.media, metadataImage: 'https://img.fake/{id}.png' } };
  check('ERC-1155 {id} substituted in image candidates', imageCandidates(k2, 'full')[0] === `https://img.fake/${(97n).toString(16).padStart(64, '0')}.png`);

  const meta = await fetchNftMetadata(k);
  check('ERC-1155 metadata fetched via {id}-substituted URI, text sanitized', meta.ok && meta.fields.name === 'Knight 97' && meta.fields.image === `ipfs://QmPng/${(97n).toString(16).padStart(64, '0')}.png`, meta);
  const inlineMeta = await fetchNftMetadata({ tokenUri: 'data:application/json;base64,' + Buffer.from(JSON.stringify({ name: 'On-chain', image: 'data:image/svg+xml;base64,PHN2Zz4=' })).toString('base64'), standard: 'erc721', tokenId: 1n });
  check('data: metadata decoded locally', inlineMeta.ok && inlineMeta.fields.name === 'On-chain');
  check('a bad JSON document gives an honest failure', !(await fetchNftMetadata({ tokenUri: 'https://meta.fake/bad.json', standard: 'erc721', tokenId: 1n })).ok);
  check('oversized metadata refused', !(await fetchNftMetadata({ tokenUri: 'https://meta.fake/big.json', standard: 'erc721', tokenId: 1n })).ok);
  check('array JSON refused', !(await fetchNftMetadata({ tokenUri: 'data:application/json,[1]', standard: 'erc721', tokenId: 1n })).ok);
  check('no tokenUri -> honest failure', !(await fetchNftMetadata({ tokenUri: null, standard: 'erc721', tokenId: 1n })).ok);
  check('unreachable metadata -> honest failure', !(await fetchNftMetadata({ tokenUri: 'https://meta.fake/404', standard: 'erc721', tokenId: 1n })).ok);
}

// ---------------------------------------------------------------------------
// 4. Calldata vs ethers, amount parsing
// ---------------------------------------------------------------------------

console.log('calldata vs ethers:');
check('ERC-721 safeTransferFrom == ethers', toHex(nftTransferCalldata('erc721', ME, OTHER, BIG_ID, 1n)) === erc721.encodeFunctionData('safeTransferFrom(address,address,uint256)', [ME, OTHER, BIG_ID]));
check('ERC-1155 safeTransferFrom == ethers', toHex(nftTransferCalldata('erc1155', ME, OTHER, 97n, BIG_1155)) === erc1155.encodeFunctionData('safeTransferFrom', [ME, OTHER, 97n, BIG_1155, '0x']));
await rejects('ERC-721 amount other than 1 refused', async () => nftTransferCalldata('erc721', ME, OTHER, 1n, 2n), /exactly one/);
check('ERC-721 amount is always 1', parseNftAmount('', 'erc721', 1n) === 1n);
check('ERC-1155 whole numbers parsed exactly', parseNftAmount(' 18446744073709551617 ', 'erc1155', BIG_1155) === BIG_1155);
await rejects('ERC-1155 decimals refused', async () => parseNftAmount('1.5', 'erc1155', 5n), /whole number/);
await rejects('ERC-1155 zero refused', async () => parseNftAmount('0', 'erc1155', 5n), /at least 1/);
await rejects('ERC-1155 above balance refused', async () => parseNftAmount('6', 'erc1155', 5n), /hold 5/);

// ---------------------------------------------------------------------------
// 5. Quotes, preview line, offline sign + broadcast
// ---------------------------------------------------------------------------

console.log('quotes + sign/broadcast:');
{
  node = defaultNode();
  const base = { url: RPC, from: ME, to: OTHER, contract: C721, tokenId: BIG_ID, standard: 'erc721', amount: 1n, expectedCaip2: MAINNET, nftCaip2: MAINNET };
  const q = await prepareNftSend(base);
  check('721 quote: ownership confirmed on-chain', q.ownedBalance === 1n && q.kind === 'nft');
  check('721 quote: fee = gas x maxFee (3 gwei)', q.fee === 85000n * 3n * 10n ** 9n, q.fee.toString());
  check('721 quote: simulation passed', q.simulation.ok === true);
  check('721 quote: calldata == ethers', toHex(q.data) === erc721.encodeFunctionData('safeTransferFrom(address,address,uint256)', [ME, OTHER, BIG_ID]));

  node = { ...defaultNode(), owner: OTHER };
  await rejects('721 not owned on-chain refused', () => prepareNftSend(base), /no longer owns/);
  check('ownership error gets the NFT title', describeNftSendError(new Error('This account no longer owns this NFT (x)')).title === 'This account cannot send this NFT right now.');
  node = { ...defaultNode(), ownerOfError: 'execution reverted: ERC721: invalid token ID' };
  await rejects('721 ownerOf revert -> plain message', () => prepareNftSend(base), /did not report an owner/);
  node = { ...defaultNode(), chainId: '0xaa36a7' };
  await rejects('endpoint on the wrong chain refused', () => prepareNftSend(base), /expected 1/);
  node = defaultNode();
  await rejects('NFT from the other mode refused', () => prepareNftSend({ ...base, nftCaip2: SEPOLIA }), /This NFT is on eip155:11155111/);
  node = { ...defaultNode(), ethBalance: 1n };
  await rejects('ETH cannot cover the fee', () => prepareNftSend(base), /Not enough ETH to pay the network fee/);
  check('fee shortfall titled with ETH', describeNftSendError(new Error('Not enough ETH to pay the network fee: x')).title === 'Not enough ETH to pay the network fee.');
  node = { ...defaultNode(), estimateGasError: 'execution reverted', transferError: 'execution reverted: ERC721: transfer to non ERC721Receiver implementer' };
  const fb = await prepareNftSend(base);
  check('estimation revert -> documented fallback gas', fb.gasIsFallback && fb.gasLimit === NFT_TRANSFER_GAS_FALLBACK);
  check('...and the pre-flight failure blocks (simulation not ok)', fb.simulation.ok === false && /non ERC721Receiver/.test(fb.simulation.reason), fb.simulation);

  node = defaultNode();
  const b1155 = { ...base, contract: C1155, tokenId: 97n, standard: 'erc1155', amount: 3n };
  const q2 = await prepareNftSend(b1155);
  check('1155 quote: on-chain balance read', q2.ownedBalance === 5n);
  await rejects('1155 amount above on-chain balance refused', () => prepareNftSend({ ...b1155, amount: 6n }), /holds 5/);
  check('1155 Max = on-chain balance', (await maxNft1155Send(RPC, ME, C1155, 97n)) === 5n);

  // Balance-change preview for the 721 send: the unchanged preview glue
  // decodes the simulated Transfer into an NFT line.
  const preview = await runBalancePreview({ url: RPC, wallet: ME, calls: [{ from: ME, to: C721, value: 0n, data: q.data }], chainCaip2: MAINNET, trackedTokens: [] });
  const lines = preview.status === 'ok' ? describeAssetChanges(preview.changes, preview.meta, { nativeSymbol: 'ETH', hidden: false }).map((l) => l.text) : [];
  check('preview shows the NFT line', lines.includes(`You send NFT #${BIG_ID} (0x0bEe…Fb02)`), { preview, lines });

  // Offline sign + broadcast through the single sendEvm path.
  lastRawTx = null;
  const sent = await sendNft(RPC, signer, q, 'https://etherscan.io/tx/');
  check('txid from eth_sendRawTransaction', sent.txid === node.txid);
  check('explorer link from the active profile', sent.explorerUrl === `https://etherscan.io/tx/${node.txid}`);
  const tx = Transaction.from(lastRawTx);
  check('raw tx targets the NFT contract', tx.to === C721, tx.to);
  check('raw tx value is 0', tx.value === 0n);
  check('raw tx calldata == ethers safeTransferFrom', tx.data === erc721.encodeFunctionData('safeTransferFrom(address,address,uint256)', [ME, OTHER, BIG_ID]));
  check('recovered sender is the signing account', tx.from === ME, tx.from);
  check('chain id and nonce from the quote', tx.chainId === 1n && tx.nonce === 7);
  check('type-2 fees from the quote', tx.type === 2 && tx.maxFeePerGas === q.maxFeePerGas && tx.gasLimit === q.gasLimit);

  lastRawTx = null;
  node = { ...defaultNode(), chainId: '0xaa36a7' };
  const qs = await prepareNftSend({ ...b1155, expectedCaip2: SEPOLIA, nftCaip2: SEPOLIA });
  const sentS = await sendNft(RPC, signer, qs, 'https://sepolia.etherscan.io/tx/');
  const txs = Transaction.from(lastRawTx);
  const decoded = erc1155.decodeFunctionData('safeTransferFrom', txs.data);
  check('Sepolia 1155: chain id 11155111 signed', txs.chainId === 11155111n);
  check('Sepolia 1155: calldata decodes to (me, recipient, 97, 3, 0x)', decoded[0] === ME && decoded[1] === OTHER && decoded[2] === 97n && decoded[3] === 3n && decoded[4] === '0x');
  check('Sepolia 1155: recovered sender', txs.from === ME && txs.to === C1155);
  check('Sepolia explorer link', sentS.explorerUrl?.startsWith('https://sepolia.etherscan.io/tx/'));
}

// CAIP-19 helpers round-trip with the send route's ids.
check('route asset id round-trips through core', nonFungibleTokenId(formatAssetId(nonFungibleAssetId(SEPOLIA, 'erc1155', C1155, BIG_1155))) === BIG_1155);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

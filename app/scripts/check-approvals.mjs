// Exercises the approvals manager and risk-warning glue
// (src/wallet/approvals.ts and src/wallet/risk.ts) entirely OFFLINE: a fake
// JSON-RPC node behind global fetch answers every request the real code
// makes (eth_blockNumber, eth_getLogs with the documented filter shape,
// eth_call for allowance()/isApprovedForAll()/approve()/setApprovalForAll(),
// eth_getCode at latest and at historical blocks, eth_getTransactionByHash,
// the fee/nonce/gas queries of the send flow, eth_sendRawTransaction).
//
// Covered: Approval and ApprovalForAll discovery over newest-first windows;
// the live allowance()/isApprovedForAll re-read overriding stale logs;
// "Unlimited" exactly at type(uint256).max vs exact amounts in the token's
// decimals; the active / could-not-confirm / revoked partition; the
// endpoint-depth refusal (publicnode's -32602 "Archive requests require a
// personal token") keeping newer results and stopping the scan; revoke
// calldata equal to ethers' encoding; an offline revoke sign+broadcast
// decoded field by field with ethers; the approve-returned-false gate and
// the Tether zero-first note; classifyRecipient tags incl. an EIP-7702
// delegated EOA; the first-interaction evidence rules (zero-value and
// foreign-sender Transfer logs never count); the archive-unavailable rule
// (no historical eth_getCode -> never a "new contract" line); the contacts
// exact-match display; and the balance-change preview line for a revoke.
// Nothing here touches a real endpoint and nothing is broadcast.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-approvals.mjs
//
// The signing key derives from the standard BIP-39 test mnemonic
// ("abandon ... about"), which is public knowledge.

import { Interface, Transaction, id as ethersId, zeroPadValue, getAddress } from 'ethers';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { MAX_UINT256, toHex } from '@shiba-wallet/chains-evm';
import {
  APPROVAL_WINDOW_BLOCKS,
  USDT_MAINNET,
  ZERO_FIRST_NOTE,
  collectionsFromNfts,
  describeApprovalAmount,
  extendApprovalScan,
  formatAllowance,
  isUnlimitedNow,
  partitionApprovals,
  prepareRevoke,
  readLiveApprovals,
  refusedNote,
  revokeAssetChange,
  revokeCalldata,
  revokedReason,
  scannedRangeNote,
  sendRevoke,
  spenderDisplay,
  startApprovalScan,
  tokensForChain,
  zeroFirstNoteFor,
  approvalsTransport,
} from '../src/wallet/approvals.ts';
import {
  ERC20_APPROVE_SELECTOR_HEX,
  FIRST_INTERACTION_FALLBACK_BLOCKS,
  NEW_CONTRACT_THRESHOLD_BLOCKS,
  SET_APPROVAL_FOR_ALL_SELECTOR_HEX,
  approvalChangesFromCalldata,
  approxDuration,
  classifyAddresses,
  computeRiskLines,
  gatherRiskFacts,
} from '../src/wallet/risk.ts';
import { describeAssetChanges } from '../src/wallet/simulation.ts';
import { USDC_MAINNET } from '../src/wallet/erc20.ts';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function checkRejects(name, promiseFn, pattern) {
  try {
    const value = await promiseFn();
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

const MAINNET = 'eip155:1';
const SEPOLIA = 'eip155:11155111';
const RPC = 'http://offline.fake/rpc';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT = USDT_MAINNET;
const COLL = getAddress('0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85'); // a collection address
// EIP-55 test-vector addresses from the EIP text, used as spenders/operators.
const ROUTER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'; // "contract"
const DRAINER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'; // EOA
const DELEGATED = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB'; // 7702-delegated EOA
const MARKET = '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'; // NFT operator (contract)
const DELEGATE_TARGET = '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';

const APPROVAL_TOPIC = ethersId('Approval(address,address,uint256)');
const APPROVAL_FOR_ALL_TOPIC = ethersId('ApprovalForAll(address,address,bool)');
const TRANSFER_TOPIC = ethersId('Transfer(address,address,uint256)');
const topicOf = (a) => zeroPadValue(a, 32).toLowerCase();
const word = (n) => '0x' + n.toString(16).padStart(64, '0');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');

const erc20Iface = new Interface([
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const nftIface = new Interface([
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);
const SEL = {
  allowance: erc20Iface.getFunction('allowance').selector,
  approve: erc20Iface.getFunction('approve').selector,
  setApprovalForAll: nftIface.getFunction('setApprovalForAll').selector,
  isApprovedForAll: nftIface.getFunction('isApprovedForAll').selector,
};

const HEAD = 1_000_000n;
const GWEI = 1_000_000_000n;
const ARCHIVE_ERROR = 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode';

// ---------------------------------------------------------------------------
// Fake JSON-RPC node behind global fetch
// ---------------------------------------------------------------------------

let node;
let lastRawTx = null;
let calls = [];

function defaultNode() {
  return {
    chainId: '0x1',
    head: HEAD,
    /** Blocks behind head that eth_getLogs / historical eth_getCode will serve (null = archive). */
    depth: null,
    logs: [],
    allowances: {}, // `${token}|${owner}|${spender}` lowercase -> bigint
    allowanceRevert: new Set(), // tokens whose allowance() reverts
    operators: {}, // `${coll}|${owner}|${op}` -> boolean
    codes: {}, // address -> code at latest
    deployedAt: {}, // address -> first block with code
    txFrom: {}, // tx hash -> from
    approveResult: word(1n),
    ethBalance: 10n ** 17n,
    nonce: '0x7',
  };
}

function refuseIfTooDeep(block) {
  if (node.depth !== null && node.head - block > node.depth) {
    throw { code: -32602, message: ARCHIVE_ERROR };
  }
}

function logMatches(log, filter) {
  const from = BigInt(filter.fromBlock);
  const to = BigInt(filter.toBlock);
  if (log.blockNumber < from || log.blockNumber > to) return false;
  if (filter.address) {
    const addrs = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a) => a.toLowerCase());
    if (!addrs.includes(log.address.toLowerCase())) return false;
  }
  return filter.topics.every((t, i) => t === null || t === undefined || log.topics[i]?.toLowerCase() === t.toLowerCase());
}

function blockArg(tag) {
  return tag === 'latest' || tag === undefined ? node.head : BigInt(tag);
}

function rpcResult(method, params) {
  switch (method) {
    case 'eth_chainId':
      return node.chainId;
    case 'eth_blockNumber':
      return '0x' + node.head.toString(16);
    case 'eth_getBalance':
      return '0x' + node.ethBalance.toString(16);
    case 'eth_getTransactionCount':
      return node.nonce;
    case 'eth_getBlockByNumber':
      return { baseFeePerGas: '0x' + GWEI.toString(16) };
    case 'eth_maxPriorityFeePerGas':
      return '0x' + GWEI.toString(16);
    case 'eth_estimateGas':
      return '0xb000'; // 45056
    case 'eth_getLogs': {
      const filter = params[0];
      refuseIfTooDeep(BigInt(filter.fromBlock));
      return node.logs
        .filter((l) => logMatches(l, filter))
        .map((l) => ({
          address: l.address.toLowerCase(),
          topics: l.topics,
          data: l.data,
          blockNumber: '0x' + l.blockNumber.toString(16),
          logIndex: '0x' + l.logIndex.toString(16),
          transactionHash: l.txHash,
          removed: false,
        }));
    }
    case 'eth_getCode': {
      const [address, tag] = params;
      const block = blockArg(tag);
      if (tag !== 'latest') refuseIfTooDeep(block);
      const a = address.toLowerCase();
      const deployed = node.deployedAt[a];
      if (deployed !== undefined && block < deployed) return '0x';
      return node.codes[a] ?? '0x';
    }
    case 'eth_getTransactionByHash':
      return node.txFrom[params[0]] ? { hash: params[0], from: node.txFrom[params[0]] } : null;
    case 'eth_call': {
      const { to, data } = params[0];
      const sel = data.slice(0, 10);
      if (sel === SEL.allowance) {
        if (node.allowanceRevert.has(to.toLowerCase())) throw { code: 3, message: 'execution reverted' };
        const [owner, spender] = erc20Iface.decodeFunctionData('allowance', data);
        return word(node.allowances[`${to}|${owner}|${spender}`.toLowerCase()] ?? 0n);
      }
      if (sel === SEL.isApprovedForAll) {
        const [owner, op] = nftIface.decodeFunctionData('isApprovedForAll', data);
        return word(node.operators[`${to}|${owner}|${op}`.toLowerCase()] ? 1n : 0n);
      }
      if (sel === SEL.approve) return node.approveResult;
      if (sel === SEL.setApprovalForAll) return '0x';
      throw { code: -32000, message: `unexpected eth_call ${sel}` };
    }
    case 'eth_sendRawTransaction':
      lastRawTx = params[0];
      return '0x' + 'cd'.repeat(32);
    default:
      throw { code: -32601, message: `unexpected method ${method}` };
  }
}

globalThis.fetch = async (_url, init) => {
  const { method, params, id } = JSON.parse(init.body);
  calls.push({ method, params });
  let body;
  try {
    body = { jsonrpc: '2.0', id, result: rpcResult(method, params) };
  } catch (e) {
    body = { jsonrpc: '2.0', id, error: { code: e.code ?? -32000, message: e.message } };
  }
  return { ok: true, status: 200, json: async () => body };
};

let logIndexCounter = 0;
function approvalLog(token, spender, value, block, txNo) {
  return {
    address: token,
    topics: [APPROVAL_TOPIC, topicOf(ME), topicOf(spender)],
    data: word(value),
    blockNumber: block,
    logIndex: logIndexCounter++,
    txHash: hash(txNo),
  };
}
function operatorLog(coll, operator, approved, block, txNo) {
  return {
    address: coll,
    topics: [APPROVAL_FOR_ALL_TOPIC, topicOf(ME), topicOf(operator)],
    data: word(approved ? 1n : 0n),
    blockNumber: block,
    logIndex: logIndexCounter++,
    txHash: hash(txNo),
  };
}
function transferLog(token, from, to, value, block, txNo) {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)],
    data: word(value),
    blockNumber: block,
    logIndex: logIndexCounter++,
    txHash: hash(txNo),
  };
}
const allowanceKey = (token, spender) => `${token}|${ME}|${spender}`.toLowerCase();

const TOKENS = [
  { address: USDC, symbol: 'USDC', decimals: 6 },
  { address: USDT, symbol: 'USDT', decimals: 6 },
];
const COLLECTIONS = [{ address: COLL, title: 'Test Collection' }];

// ---------------------------------------------------------------------------
// 1. Inputs: tracked tokens per chain, collections from the NFT list
// ---------------------------------------------------------------------------

console.log('inputs:');
{
  const mainnetTokens = tokensForChain([USDC_MAINNET], MAINNET);
  check('tracked USDC is a mainnet approval token', mainnetTokens.length === 1 && mainnetTokens[0].address === USDC && mainnetTokens[0].decimals === 6);
  check('Sepolia: mainnet tokens never scanned (tokens hidden in test mode)', tokensForChain([USDC_MAINNET], SEPOLIA).length === 0);
  const nft = (contract, spam, name) => ({
    contract, tokenId: 1n, standard: 'erc721', balance: 1n, spam, collectionName: name, contractName: null,
    name: null, description: null, media: {}, tokenUri: null,
  });
  const { collections, spamSkipped } = collectionsFromNfts([
    nft(COLL, false, 'Test Collection'),
    nft(COLL, false, 'Test Collection'),
    nft(DRAINER, true, 'FREE CLAIM'),
  ]);
  check('collections deduplicated, spam left out and counted', collections.length === 1 && collections[0].address === COLL && spamSkipped === 1);
}

// ---------------------------------------------------------------------------
// 2. Scan + live re-read
// ---------------------------------------------------------------------------

console.log('scan and live state:');
node = defaultNode();
node.logs = [
  // USDC: unlimited approval to ROUTER, still live.
  approvalLog(USDC, ROUTER, MAX_UINT256, HEAD - 100n, 1),
  // USDC: DRAINER logged 500 USDC in an OLDER window, then nothing — but the
  // live allowance is 0 (spent down without an Approval event).
  approvalLog(USDC, DRAINER, 500_000_000n, HEAD - 12_000n, 2),
  // USDT: logged 100 then re-approved to 40 later; live 25 (partly spent).
  approvalLog(USDT, DELEGATED, 100_000_000n, HEAD - 5_000n, 3),
  approvalLog(USDT, DELEGATED, 40_000_000n, HEAD - 4_000n, 4),
  // USDT: approved then revoked (latest log 0).
  approvalLog(USDT, ROUTER, 7n, HEAD - 3_000n, 5),
  approvalLog(USDT, ROUTER, 0n, HEAD - 2_000n, 6),
  // NFT collection: operator approval live; a second one revoked.
  operatorLog(COLL, MARKET, true, HEAD - 50n, 7),
  operatorLog(COLL, DRAINER, true, HEAD - 60n, 8),
  operatorLog(COLL, DRAINER, false, HEAD - 40n, 9),
  // Another owner's approval must never show up (owner topic filter).
  { ...approvalLog(USDC, ROUTER, 1n, HEAD - 10n, 10), topics: [APPROVAL_TOPIC, topicOf(DRAINER), topicOf(ROUTER)] },
];
node.allowances[allowanceKey(USDC, ROUTER)] = MAX_UINT256;
node.allowances[allowanceKey(USDC, DRAINER)] = 0n;
node.allowances[allowanceKey(USDT, DELEGATED)] = 25_000_000n;
node.operators[`${COLL}|${ME}|${MARKET}`.toLowerCase()] = true;
node.codes[ROUTER.toLowerCase()] = '0x6080604052';
node.codes[MARKET.toLowerCase()] = '0x60806040';
node.codes[DELEGATED.toLowerCase()] = '0xef0100' + DELEGATE_TARGET.slice(2);

calls = [];
const transport = approvalsTransport(RPC);
let scan = await startApprovalScan({ transport, owner: ME, chainCaip2: MAINNET, tokens: TOKENS, collections: COLLECTIONS, windows: 2 });
const getLogs = calls.filter((c) => c.method === 'eth_getLogs');
check('windows are 9,000 blocks', APPROVAL_WINDOW_BLOCKS === 9000n);
check('first window is the newest (head-8999..head)', BigInt(getLogs[0].params[0].toBlock) === HEAD && BigInt(getLogs[0].params[0].fromBlock) === HEAD - 8999n);
check('second window directly below the first', getLogs.some((c) => BigInt(c.params[0].toBlock) === HEAD - 9000n && BigInt(c.params[0].fromBlock) === HEAD - 17999n));
check('Approval filter = [topic0, owner topic], per token address', getLogs.some((c) => c.params[0].address === USDC.toLowerCase() && c.params[0].topics[0] === APPROVAL_TOPIC && c.params[0].topics[1] === topicOf(ME)));
check('ApprovalForAll filter on the collection', getLogs.some((c) => c.params[0].address === COLL.toLowerCase() && c.params[0].topics[0] === APPROVAL_FOR_ALL_TOPIC));
check('2 windows x 3 contracts = 6 log queries', getLogs.length === 6, String(getLogs.length));
check('range covers 18,000 blocks, nothing refused', scan.scannedFromBlock === HEAD - 17999n && scan.refused === null);
check('latest record per (token, spender): USDT/DELEGATED is the 40 USDT log', scan.erc20.find((r) => r.spender === DELEGATED)?.value === 40_000_000n);
check('another owner\'s Approval log never discovered', scan.erc20.length === 4, String(scan.erc20.length));
check('operator latest record wins (DRAINER revoked)', scan.operators.find((r) => r.operator === DRAINER)?.approved === false);
check('scanned-range note names the blocks and an approximate duration', scannedRangeNote(scan).includes(`${HEAD - 17999n}–${HEAD}`) && scannedRangeNote(scan).includes('the last 18,000 blocks') && scannedRangeNote(scan).includes('about 3 days'), scannedRangeNote(scan));

calls = [];
let items = await readLiveApprovals(transport, scan);
check('every discovered pair re-read live (4 allowance + 2 isApprovedForAll eth_calls)', calls.filter((c) => c.method === 'eth_call').length === 6);
let part = partitionApprovals(items);
const byKey = (list, contract, who) => list.find((i) => i.contract === contract && (i.kind === 'erc20' ? i.spender : i.operator) === who);
const usdcRouter = byKey(part.active, USDC, ROUTER);
check('unlimited USDC approval is active and shown "Unlimited USDC"', usdcRouter && describeApprovalAmount(usdcRouter, false) === 'Unlimited USDC' && isUnlimitedNow(usdcRouter));
const usdtDelegated = byKey(part.active, USDT, DELEGATED);
check('live allowance overrides the logged value (25, not 40)', usdtDelegated && usdtDelegated.loggedValue === 40_000_000n && describeApprovalAmount(usdtDelegated, false) === '25 USDT');
check('operator approval active with the whole-collection wording', byKey(part.active, COLL, MARKET) && describeApprovalAmount(byKey(part.active, COLL, MARKET), false) === 'Can transfer ALL your items in this collection');
check('3 active approvals', part.active.length === 3, String(part.active.length));
check('3 in the revoked section (logged revoke, used-up, operator revoked)', part.revoked.length === 3 && part.unconfirmed.length === 0);
check('USDC/DRAINER: logged 500 but live 0 -> revoked section, "used up" reason', byKey(part.revoked, USDC, DRAINER) && /used up/.test(revokedReason(byKey(part.revoked, USDC, DRAINER))));
check('USDT/ROUTER logged revoke -> "Revoked"', revokedReason(byKey(part.revoked, USDT, ROUTER)) === 'Revoked');
check('Tether zero-first note on USDT items only', zeroFirstNoteFor(usdtDelegated) === ZERO_FIRST_NOTE && zeroFirstNoteFor(usdcRouter) === null);
check('zero-first note never on Sepolia', zeroFirstNoteFor({ ...usdtDelegated, chainCaip2: SEPOLIA }) === null);

// Formatting
check('exact amount in token decimals with grouping', formatAllowance(1_234_567_890_123n, 6, 'USDC', false) === '1,234,567.890123 USDC');
check('MAX-1 is NOT "unlimited" (no invented threshold)', formatAllowance(MAX_UINT256 - 1n, 6, 'USDC', false).startsWith('115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457,584,007,913,129.639934'));
check('Hide amounts masks finite allowances', formatAllowance(5_000_000n, 6, 'USDC', true) === '•••• USDC');
check('Hide amounts never hides "Unlimited"', formatAllowance(MAX_UINT256, 6, 'USDC', true) === 'Unlimited USDC');

// Failed live read: shown as could-not-confirm, never as active, logged value labeled.
node.allowanceRevert.add(USDT.toLowerCase());
items = await readLiveApprovals(transport, scan);
part = partitionApprovals(items);
const unconf = byKey(part.unconfirmed, USDT, DELEGATED);
check('failed allowance() read -> "could not confirm", not active', unconf && !byKey(part.active, USDT, DELEGATED));
check('could-not-confirm shows the logged value labeled as such', /could not be read \(last logged: 40 USDT\)/.test(describeApprovalAmount(unconf, false)), describeApprovalAmount(unconf, false));
node.allowanceRevert.clear();

// ---------------------------------------------------------------------------
// 3. Endpoint depth refusal (publicnode-like)
// ---------------------------------------------------------------------------

console.log('endpoint depth refusal:');
node.depth = 10_000n;
scan = await startApprovalScan({ transport, owner: ME, chainCaip2: MAINNET, tokens: TOKENS, collections: COLLECTIONS });
check('newest window scanned, second refused', scan.scannedFromBlock === HEAD - 8999n && scan.refused?.fromBlock === HEAD - 17999n);
check('refusal message carried verbatim', scan.refused?.message.includes('Archive requests require a personal token'));
check('newer results kept (USDC/ROUTER found)', scan.erc20.some((r) => r.spender === ROUTER && r.token === USDC));
check('approval in the refused range NOT invented (USDC/DRAINER at head-12000 absent)', !scan.erc20.some((r) => r.spender === DRAINER));
const note = refusedNote(scan);
check('refused note says older approvals are not shown and points to Settings', /NOT shown/.test(note) && /Settings → Network endpoints/.test(note));
const before = scan.scannedFromBlock;
scan = await extendApprovalScan(scan, { transport });
check('extending against the same endpoint stays refused, range unchanged', scan.scannedFromBlock === before && scan.refused !== null);
node.depth = 0n;
await checkRejects('unusable endpoint (head unreadable) throws', () => startApprovalScan({ transport: async () => 'nope', owner: ME, chainCaip2: MAINNET, tokens: TOKENS, collections: [] }), /malformed/);
const none = await startApprovalScan({ transport, owner: ME, chainCaip2: MAINNET, tokens: TOKENS, collections: [] });
check('nothing scannable -> "No blocks could be searched yet."', scannedRangeNote(none) === 'No blocks could be searched yet.' && none.refused !== null);
node.depth = null;

// Whole-history exhaustion on a short chain
{
  const short = defaultNode();
  short.head = 12_000n;
  node = short;
  const s = await startApprovalScan({ transport, owner: ME, chainCaip2: SEPOLIA, tokens: [], collections: COLLECTIONS });
  check('scan reaching block 0 is marked exhausted', s.exhausted && s.scannedFromBlock === 0n && /whole history/.test(scannedRangeNote(s)));
}

// ---------------------------------------------------------------------------
// 4. Revoke: calldata, quote, gate, sign + broadcast
// ---------------------------------------------------------------------------

console.log('revoke:');
node = defaultNode();
node.allowances[allowanceKey(USDC, ROUTER)] = MAX_UINT256;
node.operators[`${COLL}|${ME}|${MARKET}`.toLowerCase()] = true;
node.logs = [approvalLog(USDC, ROUTER, MAX_UINT256, HEAD - 1n, 11), operatorLog(COLL, MARKET, true, HEAD - 2n, 12)];
scan = await startApprovalScan({ transport, owner: ME, chainCaip2: MAINNET, tokens: TOKENS, collections: COLLECTIONS, windows: 1 });
items = await readLiveApprovals(transport, scan);
const erc20Item = items.find((i) => i.kind === 'erc20');
const opItem = items.find((i) => i.kind === 'operator');
check('ERC-20 revoke calldata == ethers approve(spender, 0)', toHex(revokeCalldata(erc20Item)) === erc20Iface.encodeFunctionData('approve', [ROUTER, 0n]));
check('operator revoke calldata == ethers setApprovalForAll(operator, false)', toHex(revokeCalldata(opItem)) === nftIface.encodeFunctionData('setApprovalForAll', [MARKET, false]));
check('preview line for an ERC-20 revoke', describeAssetChanges([revokeAssetChange(erc20Item)], {}, { nativeSymbol: 'ETH', hidden: false })[0]?.text.startsWith('Approval revoked: 0x5aAe…eAed may no longer spend'));
check('preview line for an operator revoke', describeAssetChanges([revokeAssetChange(opItem)], {}, { nativeSymbol: 'ETH', hidden: false })[0]?.text === 'Approval revoked: 0xD122…9aDb may no longer transfer your NFTs in 0x57f1…eA85');

const rq = await prepareRevoke({ url: RPC, from: ME, item: erc20Item, expectedCaip2: MAINNET });
check('quote targets the token contract with value 0 and the revoke calldata', rq.quote.to === USDC && rq.quote.amount === 0n && toHex(rq.quote.data) === toHex(revokeCalldata(erc20Item)));
check('eth_call gate ran and passed (true word)', rq.quote.simulation.ok && rq.returnedFalse === false);
check('fee = gas x maxFee (45056 x 3 gwei)', rq.quote.fee === 45056n * 3n * GWEI);

node.approveResult = word(0n);
const rqFalse = await prepareRevoke({ url: RPC, from: ME, item: erc20Item, expectedCaip2: MAINNET });
check('approve() returning false blocks like a revert', rqFalse.returnedFalse === true);
node.approveResult = '0x';
const rqEmpty = await prepareRevoke({ url: RPC, from: ME, item: erc20Item, expectedCaip2: MAINNET });
check('Tether-style empty return data passes', rqEmpty.returnedFalse === false && rqEmpty.quote.simulation.ok);
node.approveResult = word(1n);
const rqOp = await prepareRevoke({ url: RPC, from: ME, item: opItem, expectedCaip2: MAINNET });
check('operator revoke: returnedFalse never applies', rqOp.returnedFalse === false && rqOp.quote.to === COLL);

await checkRejects('chain mismatch refused before any quote', () => prepareRevoke({ url: RPC, from: ME, item: erc20Item, expectedCaip2: SEPOLIA }), /eip155:1, but the wallet is on eip155:11155111/);
await checkRejects('another account refused', () => prepareRevoke({ url: RPC, from: DRAINER, item: erc20Item, expectedCaip2: MAINNET }), /different account/);
node.chainId = '0xaa36a7';
await checkRejects('endpoint on the wrong chain refused (prepareEvmSend check)', () => prepareRevoke({ url: RPC, from: ME, item: erc20Item, expectedCaip2: MAINNET }), /chain id 11155111, expected 1/);
node.chainId = '0x1';

const sent = await sendRevoke(RPC, signer, rq, 'https://etherscan.io/tx/');
const tx = Transaction.from(lastRawTx);
check('raw tx: to = token contract', tx.to === USDC, tx.to);
check('raw tx: value 0', tx.value === 0n);
check('raw tx: calldata decodes to approve(ROUTER, 0)', (() => { const d = erc20Iface.decodeFunctionData('approve', tx.data); return d[0] === ROUTER && d[1] === 0n; })());
check('raw tx: recovered sender is the wallet', tx.from === ME, tx.from);
check('raw tx: chain id 1, nonce 7, type 2, quoted fees and gas', tx.chainId === 1n && tx.nonce === 7 && tx.type === 2 && tx.maxFeePerGas === rq.quote.maxFeePerGas && tx.gasLimit === 45056n);
check('success: txid + etherscan link', sent.txid === '0x' + 'cd'.repeat(32) && sent.explorerUrl === `https://etherscan.io/tx/${sent.txid}`);

lastRawTx = null;
await sendRevoke(RPC, signer, rqOp, 'https://etherscan.io/tx/');
const txOp = Transaction.from(lastRawTx);
check('operator raw tx decodes to setApprovalForAll(MARKET, false) on the collection', (() => { const d = nftIface.decodeFunctionData('setApprovalForAll', txOp.data); return txOp.to === COLL && d[0] === MARKET && d[1] === false && txOp.from === ME; })());

// ---------------------------------------------------------------------------
// 5. Address tags and contacts display
// ---------------------------------------------------------------------------

console.log('tags and contacts:');
node = defaultNode();
node.codes[ROUTER.toLowerCase()] = '0x6080604052';
node.codes[DELEGATED.toLowerCase()] = '0xef0100' + DELEGATE_TARGET.slice(2);
const tags = await classifyAddresses(transport, [ROUTER, DRAINER, DELEGATED, ROUTER.toLowerCase()]);
check('contract tag', tags[ROUTER.toLowerCase()] === 'contract');
check('EOA tag', tags[DRAINER.toLowerCase()] === 'EOA');
check('EIP-7702 delegated EOA tag', tags[DELEGATED.toLowerCase()] === 'delegated EOA');
const failing = await classifyAddresses(async () => { throw new Error('down'); }, [ROUTER]);
check('failed lookup -> no tag (null), never guessed', failing[ROUTER.toLowerCase()] === null);

const contacts = [{ networkId: MAINNET, name: 'Uniswap router', address: ROUTER, createdAt: '' }];
const exact = spenderDisplay(MAINNET, ROUTER.toLowerCase(), contacts, tags);
check('exact contact match (case-insensitive) -> name WITH full address, no tag', exact.name === 'Uniswap router' && exact.address === ROUTER.toLowerCase() && exact.tag === null);
const near = spenderDisplay(MAINNET, '0x5aae' + '0'.repeat(32) + 'eaed', contacts, {});
check('look-alike address never labeled with the contact name', near.name === null, JSON.stringify(near));
check('Sepolia contact never labels a mainnet spender', spenderDisplay(SEPOLIA, ROUTER, contacts, tags).name === null);
const plain = spenderDisplay(MAINNET, DELEGATED, contacts, tags);
check('non-contact -> full address + code tag', plain.name === null && plain.address === DELEGATED && plain.tag === 'delegated EOA');

// ---------------------------------------------------------------------------
// 6. Risk lines
// ---------------------------------------------------------------------------

console.log('risk lines:');
check('approve selector derived from the engine = ethers', ERC20_APPROVE_SELECTOR_HEX === SEL.approve);
check('setApprovalForAll selector from the engine = ethers', SET_APPROVAL_FOR_ALL_SELECTOR_HEX === SEL.setApprovalForAll);
{
  const unlimitedData = erc20Iface.encodeFunctionData('approve', [ROUTER, MAX_UINT256]);
  const changes = approvalChangesFromCalldata(USDC, ME, unlimitedData);
  check('calldata decode: unlimited approve', changes.length === 1 && changes[0].type === 'erc20-approval' && changes[0].unlimited && changes[0].spender === ROUTER);
  check('calldata decode: finite approve is not unlimited', approvalChangesFromCalldata(USDC, ME, erc20Iface.encodeFunctionData('approve', [ROUTER, 5n]))[0].unlimited === false);
  check('calldata decode: setApprovalForAll(true)', approvalChangesFromCalldata(COLL, ME, nftIface.encodeFunctionData('setApprovalForAll', [MARKET, true]))[0]?.approved === true);
  check('calldata decode: trailing bytes -> nothing decoded', approvalChangesFromCalldata(USDC, ME, unlimitedData + '00').length === 0);
  check('calldata decode: dirty address word -> nothing', approvalChangesFromCalldata(USDC, ME, SEL.approve + 'ff'.repeat(12) + ROUTER.slice(2).toLowerCase() + 'ff'.repeat(32)).length === 0);
  check('calldata decode: non-bool flag -> nothing', approvalChangesFromCalldata(COLL, ME, SEL.setApprovalForAll + word(BigInt(MARKET)).slice(2) + word(2n).slice(2)).length === 0);

  // Calldata-only (no endpoint): the unlimited warning still appears.
  const offline = await gatherRiskFacts({ url: null, wallet: ME, to: USDC, data: unlimitedData, chainCaip2: MAINNET, trackedTokens: [] });
  const offLines = computeRiskLines(offline);
  check('no endpoint: unlimited-approval warning from calldata alone', offLines.length === 1 && offLines[0].type === 'unlimited-approval' && offLines[0].tone === 'warning');

  // Preview changes take precedence over calldata decoding.
  const pre = await gatherRiskFacts({ url: null, wallet: ME, to: USDC, data: unlimitedData, assetChanges: [], chainCaip2: MAINNET, trackedTokens: [] });
  check('preview changes ([]) take precedence over calldata', computeRiskLines(pre).length === 0);

  const opFacts = await gatherRiskFacts({ url: null, wallet: ME, to: COLL, data: nftIface.encodeFunctionData('setApprovalForAll', [MARKET, true]), chainCaip2: MAINNET, trackedTokens: [] });
  check('operator approval warning', computeRiskLines(opFacts).some((l) => l.type === 'operator-approval' && l.tone === 'warning'));
}

// Network-backed facts
node = defaultNode();
node.codes[ROUTER.toLowerCase()] = '0x6080604052';
node.codes[DELEGATED.toLowerCase()] = '0xef0100' + DELEGATE_TARGET.slice(2);
{
  const facts = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: DELEGATED, chainCaip2: MAINNET, trackedTokens: [] });
  const lines = computeRiskLines(facts);
  check('delegated EOA -> notice naming the delegate', lines.length === 1 && lines[0].type === 'delegated-eoa' && lines[0].tone === 'notice' && lines[0].text.includes(getAddress(DELEGATE_TARGET)));
  check('no tracked tokens -> no first-interaction search, no notice', facts.firstInteraction === undefined && !calls.some((c) => c.method === 'eth_getLogs' && Array.isArray(c.params[0].address)));
}
{
  const facts = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: DRAINER, data: '0xa9059cbb' + '00'.repeat(64), chainCaip2: MAINNET, trackedTokens: [] });
  check('calldata to an address with no code -> warning', computeRiskLines(facts).some((l) => l.type === 'no-code-recipient-with-calldata' && l.tone === 'warning'));
  const plainSend = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: DRAINER, chainCaip2: MAINNET, trackedTokens: [] });
  check('plain ETH send to an EOA -> no lines', computeRiskLines(plainSend).length === 0);
}

// Contract age: archive unavailable -> never "new contract".
{
  node = defaultNode();
  node.codes[ROUTER.toLowerCase()] = '0x6080604052';
  node.deployedAt[ROUTER.toLowerCase()] = HEAD - 100n; // genuinely young
  node.depth = 64n; // publicnode-like: historical eth_getCode refused beyond 64 blocks
  const facts = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: ROUTER, data: '0x12345678', chainCaip2: MAINNET, trackedTokens: [] });
  check('archive refused -> contract age unknown, no "new contract" line', facts.contractAge === undefined && !computeRiskLines(facts).some((l) => l.type === 'new-contract'));
  check('class still known (contract) when only the age check failed', facts.recipientClass?.kind === 'contract');

  node.depth = null; // archive-capable endpoint
  const young = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: ROUTER, data: '0x12345678', chainCaip2: MAINNET, trackedTokens: [] });
  const youngLine = computeRiskLines(young).find((l) => l.type === 'new-contract');
  check('archive available + 100-block-old contract -> "new contract" warning', youngLine && youngLine.tone === 'warning' && /deployed only 100 blocks ago/.test(youngLine.text), youngLine?.text);
  check('age search bounded to the chain threshold (50,400 blocks)', NEW_CONTRACT_THRESHOLD_BLOCKS[MAINNET] === 50_400n && calls.some((c) => c.method === 'eth_getCode' && c.params[1] === '0x' + (HEAD - 50_400n).toString(16)));

  node.deployedAt[ROUTER.toLowerCase()] = HEAD - 60_000n; // older than the threshold
  const old = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: ROUTER, data: '0x12345678', chainCaip2: MAINNET, trackedTokens: [] });
  check('contract older than the threshold -> no "new contract" line', old.contractAge?.result.atOrBefore === true && !computeRiskLines(old).some((l) => l.type === 'new-contract'));

  const otherChain = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: ROUTER, data: '0x12345678', chainCaip2: 'eip155:999', trackedTokens: [] });
  check('chain without a threshold -> no age check at all', otherChain.contractAge === undefined);
}

// First interaction evidence rules.
{
  node = defaultNode();
  const TRACKED = [{ address: USDC, symbol: 'USDC' }];
  // Spoofed: zero-value Transfer naming me, and a non-zero one from a tx I did not send.
  node.logs = [
    transferLog(USDC, ME, DRAINER, 0n, HEAD - 10n, 20),
    transferLog(USDC, ME, DRAINER, 5n, HEAD - 20n, 21),
  ];
  node.txFrom[hash(21)] = ROUTER; // someone else sent it
  const spoofed = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: DRAINER, chainCaip2: MAINNET, trackedTokens: TRACKED });
  check('zero-value and foreign-sender Transfer logs are not evidence', spoofed.firstInteraction?.known === false && spoofed.firstInteraction.rejectedCandidates === 2);
  const notice = computeRiskLines(spoofed).find((l) => l.type === 'first-interaction-unknown');
  check('first-interaction notice names what was searched', notice && notice.tone === 'notice' && notice.text.includes('Searched: USDC transfers in blocks') && notice.text.includes(`the last 72,000 blocks`), notice?.text);
  const q = calls.find((c) => c.method === 'eth_getLogs' && c.params[0].topics[0] === TRANSFER_TOPIC);
  check('first-interaction query is contract-filtered with [Transfer, me, target]', q && q.params[0].address === USDC.toLowerCase() && q.params[0].topics[1] === topicOf(ME) && q.params[0].topics[2] === topicOf(DRAINER));

  // Genuine: non-zero transfer in a tx I sent.
  node.logs.push(transferLog(USDC, ME, DRAINER, 7n, HEAD - 30n, 22));
  node.txFrom[hash(22)] = ME;
  const real = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: DRAINER, chainCaip2: MAINNET, trackedTokens: TRACKED });
  check('confirmed earlier transfer -> known, no notice', real.firstInteraction?.known === true && !computeRiskLines(real).some((l) => l.type === 'first-interaction-unknown'));

  // Counterparty differs from `to` (token transfer): search uses the counterparty.
  calls = [];
  await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: USDC, counterparty: DRAINER, data: '0xa9059cbb' + '00'.repeat(64), chainCaip2: MAINNET, trackedTokens: TRACKED });
  check('token transfer: first-interaction searches the counterparty, not the token', calls.some((c) => c.method === 'eth_getLogs' && c.params[0].topics[2] === topicOf(DRAINER)));

  // Endpoint depth: the 72k lookback is refused, the 9k fallback answers.
  node.logs = [];
  node.depth = 10_000n;
  const shallow = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: DRAINER, chainCaip2: MAINNET, trackedTokens: TRACKED });
  const scanned = shallow.firstInteraction ? shallow.firstInteraction.scannedToBlock - shallow.firstInteraction.scannedFromBlock + 1n : null;
  check('refused 72k lookback falls back to a 9,000-block search', scanned === FIRST_INTERACTION_FALLBACK_BLOCKS, String(scanned));
  check('fallback notice states the smaller range', computeRiskLines(shallow).some((l) => l.text.includes('the last 9,000 blocks, about 30 hours')));
  node.depth = 0n;
  const blind = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: DRAINER, chainCaip2: MAINNET, trackedTokens: TRACKED });
  check('every search refused -> no first-interaction notice (never a guess)', blind.firstInteraction === undefined && computeRiskLines(blind).length === 0);
  node.depth = null;

  const self = await gatherRiskFacts({ transport, url: RPC, wallet: ME, to: ME, chainCaip2: MAINNET, trackedTokens: TRACKED });
  check('self-send -> no first-interaction search', self.firstInteraction === undefined);
}

// Ordering: warnings before notices.
{
  node = defaultNode();
  node.codes[DELEGATED.toLowerCase()] = '0xef0100' + DELEGATE_TARGET.slice(2);
  const facts = await gatherRiskFacts({
    transport, url: RPC, wallet: ME, to: DELEGATED,
    assetChanges: [{ type: 'erc20-approval', callIndex: 0, token: USDC, owner: ME, spender: ROUTER, amount: MAX_UINT256, unlimited: true }],
    chainCaip2: MAINNET, trackedTokens: [],
  });
  const lines = computeRiskLines(facts);
  check('warnings first, then notices', lines.map((l) => l.tone).join(',') === 'warning,notice', lines.map((l) => l.type).join(','));
}

check('approximate durations', approxDuration(9000n) === 'about 30 hours' && approxDuration(72000n) === 'about 10 days' && approxDuration(1n) === 'about 1 hour');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

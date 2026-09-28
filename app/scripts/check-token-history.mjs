/**
 * Verification for the tracked-token history fallback (phase 5, item 4):
 * the windowed logs provider, the source-selection branches, and the
 * timestamp labeling. Fakes only — no network.
 *
 * Run from app/: node scripts/check-token-history.mjs
 */
import { tokenLogsHistoryProvider } from '../src/wallet/token-history.ts';
import {
  TOKEN_LOGS_NOTE,
  historySourceFor,
  timestampLabel,
} from '../src/wallet/history.ts';
import { TRANSFER_TOPIC, addressTopic } from '@shiba-wallet/chains-evm';

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log('  FAIL', name);
  }
}

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';

function makeLog(token, blockNum, logIndex, from, to, valueHex) {
  return {
    transactionHash: `0xtx${blockNum}${logIndex}`,
    blockNumber: '0x' + blockNum.toString(16),
    logIndex: '0x' + logIndex.toString(16),
    address: token,
    topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
    data: valueHex,
  };
}

// Fake node: latest block 100_000; per-token logs planted per window.
const OTHER = '0x2222222222222222222222222222222222222222';
const calls = [];
const transport = async (method, params) => {
  calls.push({ method, params });
  if (method === 'eth_blockNumber') return '0x186a0'; // 100000
  if (method === 'eth_getLogs') {
    const filter = params[0];
    const from = BigInt(filter.fromBlock);
    const to = BigInt(filter.toBlock);
    const topics = filter.topics;
    const inWindow = (n) => BigInt(n) >= from && BigInt(n) <= to;
    const out = [];
    if (filter.address === USDC && topics[1] === addressTopic(ME)) {
      if (inWindow(99_950)) out.push(makeLog(USDC, 99_950, 3, ME, OTHER, '0xf4240')); // 1 USDC out
    }
    if (filter.address === USDC && topics[2] === addressTopic(ME)) {
      if (inWindow(99_990)) out.push(makeLog(USDC, 99_990, 1, OTHER, ME, '0x1e8480')); // 2 USDC in
    }
    if (filter.address === DAI && topics[2] === addressTopic(ME)) {
      if (inWindow(90_500)) out.push(makeLog(DAI, 90_500, 7, OTHER, ME, '0xde0b6b3a7640000')); // 1 DAI in (older window)
    }
    return out;
  }
  throw new Error(`unexpected ${method}`);
};

const provider = tokenLogsHistoryProvider({
  rpcUrl: 'http://fake',
  walletAddress: ME,
  tokens: [
    { address: USDC, symbol: 'USDC', decimals: 6 },
    { address: DAI, symbol: 'DAI', decimals: 18 },
  ],
  transport,
  windowBlocks: 9_000n,
  maxWindows: 3,
});

console.log('check-token-history: provider');
const page1 = await provider.getHistory(ME);
check('page1 has the two USDC entries newest-first', page1.entries.length === 2
  && page1.entries[0].blockHeight === 99_990 && page1.entries[1].blockHeight === 99_950);
check('directions classified', page1.entries[0].direction === 'in' && page1.entries[1].direction === 'out');
check('asset fields exact', page1.entries[0].assetSymbol === 'USDC'
  && page1.entries[0].assetAmount === 2_000_000n && page1.entries[0].assetDecimals === 6);
check('uid carries log position', page1.entries[1].uid === '0xtx99950' + '3'.padStart(0) + ':log:3'.replace(':log:3', ':log:3') || page1.entries[1].uid.endsWith(':log:3'));
check('timestamps null but confirmed', page1.entries[0].timestamp === null && page1.entries[0].confirmed === true);
check('cursor present after window 1', typeof page1.nextCursor === 'string');

const page2 = await provider.getHistory(ME, page1.nextCursor);
check('page2 finds the older DAI entry', page2.entries.length === 1
  && page2.entries[0].assetSymbol === 'DAI' && page2.entries[0].assetAmount === 10n ** 18n);
check('cursor present after window 2', typeof page2.nextCursor === 'string');

const page3 = await provider.getHistory(ME, page2.nextCursor);
check('bounded lookback stops at maxWindows', page3.nextCursor === undefined);

let cursorRejected = false;
try { await provider.getHistory(ME, '{"v":9}'); } catch { cursorRejected = true; }
check('bad cursor rejected', cursorRejected);

check('window filters carried contract address', calls.some((c) =>
  c.method === 'eth_getLogs' && c.params[0].address === DAI));

console.log('check-token-history: source selection');
const tokens = [{ address: USDC, symbol: 'USDC', decimals: 6 }];
const viaIndexer = historySourceFor('evm-jsonrpc', 'http://rpc', 'http://indexer', undefined,
  { walletAddress: ME, tokens });
check('indexer preferred when configured', viaIndexer.status === 'available' && viaIndexer.note === undefined);
const viaLogs = historySourceFor('evm-jsonrpc', 'http://rpc', null, undefined,
  { walletAddress: ME, tokens });
check('token fallback labeled with the note', viaLogs.status === 'available' && viaLogs.note === TOKEN_LOGS_NOTE);
const unavailable = historySourceFor('evm-jsonrpc', 'http://rpc', null, undefined,
  { walletAddress: ME, tokens: [] });
check('no tokens means honestly unavailable', unavailable.status === 'unavailable');

console.log('check-token-history: timestamp labels');
check('confirmed log entry shows its block', timestampLabel(
  { timestamp: null, confirmed: true, blockHeight: 12345 }) === 'block 12345');
check('unconfirmed stays pending', timestampLabel(
  { timestamp: null, confirmed: false }) === 'pending');
check('real timestamps unchanged', timestampLabel(
  { timestamp: 1_700_000_000, confirmed: true, blockHeight: 5 },
  1_700_000_030_000) === 'just now');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

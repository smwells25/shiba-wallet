/**
 * Verification for the tracked-token history fallback (phase 5, item 4):
 * the windowed logs provider, the source-selection branches, and the
 * timestamp labeling, plus (phase 8 follow-up) the endpoint-depth handling:
 * a refused window stops paging honestly with the answered depth and the
 * endpoint's own text. Fakes only — no network — unless --live is passed.
 *
 * Run from app/: node scripts/check-token-history.mjs [--live]
 *   --live adds a READ-ONLY run through the app glue against
 *   https://ethereum.publicnode.com (eth_blockNumber + eth_getLogs only;
 *   nothing is signed or sent).
 */
import {
  tokenLogsCoverageOf,
  tokenLogsHistoryProvider,
  tokenLogsTransport,
} from '../src/wallet/token-history.ts';
import {
  TOKEN_LOGS_NOTE,
  historyNotesAfterPage,
  historySourceFor,
  timestampLabel,
  tokenLogsCoverageNote,
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

// Coverage on the success path: reported without changing entries/cursors.
const cov1 = tokenLogsCoverageOf(page1);
check('success page 1 reports head and answered depth', cov1 !== undefined
  && cov1.headBlock === 100_000n && cov1.answeredFromBlock === 91_001n
  && cov1.stop === undefined && cov1.refusal === undefined);
const cov2 = tokenLogsCoverageOf(page2);
check('success page 2 carries the head through the cursor', cov2.headBlock === 100_000n
  && cov2.answeredFromBlock === 82_001n && cov2.stop === undefined);
const cov3 = tokenLogsCoverageOf(page3);
check('lookback bound reported as lookback-limit', cov3.stop === 'lookback-limit'
  && cov3.answeredFromBlock === 73_001n && cov3.lookbackBlocks === 27_000n);
check('success-path note while paging is the original note',
  tokenLogsCoverageNote(cov1).note === TOKEN_LOGS_NOTE && tokenLogsCoverageNote(cov1).detail === null);
const limitNote = tokenLogsCoverageNote(cov3).note;
check('lookback-limit note names the block and the indexer', limitNote.includes('from block 73001 to 100000')
  && limitNote.includes('most recent 27000 blocks')
  && limitNote.includes('Settings → Ethereum history indexer'));
check('foreign pages carry no coverage', tokenLogsCoverageOf({ entries: [] }) === undefined);

let cursorRejected = false;
try { await provider.getHistory(ME, '{"v":9}'); } catch { cursorRejected = true; }
check('bad cursor rejected', cursorRejected);

check('window filters carried contract address', calls.some((c) =>
  c.method === 'eth_getLogs' && c.params[0].address === DAI));

// ---------------------------------------------------------------------------
// Endpoint depth: refusals, through the real transport over a fake fetch
// that answers like publicnode did in the 2026-10-02 probe (HTTP 403 with a
// JSON-RPC error body for fromBlock deeper than 10,000 behind the head).
// ---------------------------------------------------------------------------
console.log('check-token-history: endpoint depth');

const REFUSAL_TEXT =
  'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode';
const HEAD = 100_000n;
function depthLimitedFetch({ maxDepth, failAll = false, throwNetwork = false, onlyToken = null }) {
  const log = [];
  const fetchFn = async (_url, init) => {
    const req = JSON.parse(init.body);
    log.push(req);
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    if (req.method === 'eth_blockNumber') return reply(200, { jsonrpc: '2.0', id: req.id, result: '0x' + HEAD.toString(16) });
    if (req.method === 'eth_getLogs') {
      const filter = req.params[0];
      const from = BigInt(filter.fromBlock);
      const deep = failAll || HEAD - from > maxDepth;
      const applies = onlyToken === null || filter.address === onlyToken;
      if (deep && applies) {
        if (throwNetwork) throw new TypeError('fetch failed');
        return reply(403, { jsonrpc: '2.0', error: { code: -32602, message: REFUSAL_TEXT }, id: req.id });
      }
      const to = BigInt(filter.toBlock);
      const out = [];
      const topics = filter.topics;
      if (filter.address === USDC && topics[2] === addressTopic(ME)) {
        for (const n of [99_990, 95_000, 85_000]) {
          if (BigInt(n) >= from && BigInt(n) <= to) out.push(makeLog(USDC, n, 1, OTHER, ME, '0x1e8480'));
        }
      }
      if (filter.address === DAI && topics[2] === addressTopic(ME)) {
        if (from <= 85_500n && to >= 85_500n) out.push(makeLog(DAI, 85_500, 2, OTHER, ME, '0x01'));
      }
      return reply(200, { jsonrpc: '2.0', id: req.id, result: out });
    }
    return reply(200, { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
  };
  return { fetchFn, log };
}
const twoTokens = [
  { address: USDC, symbol: 'USDC', decimals: 6 },
  { address: DAI, symbol: 'DAI', decimals: 18 },
];

// (a) Refusal on page 2: the publicnode case (9,000-block windows, 10,000 deep).
{
  const { fetchFn, log } = depthLimitedFetch({ maxDepth: 10_000n });
  const p = tokenLogsHistoryProvider({
    rpcUrl: 'http://fake', walletAddress: ME, tokens: twoTokens,
    transport: tokenLogsTransport('http://fake', fetchFn),
  });
  const first = await p.getHistory(ME);
  check('depth: page 1 answered normally', first.entries.length === 2
    && typeof first.nextCursor === 'string');
  const before = log.length;
  const second = await p.getHistory(ME, first.nextCursor); // must not throw
  const cov = tokenLogsCoverageOf(second);
  check('depth: refused page 2 resolves (no thrown error) with no entries', second.entries.length === 0);
  check('depth: refused page 2 ends paging', second.nextCursor === undefined);
  check('depth: stop reason is refused', cov.stop === 'refused');
  check('depth: answered depth is the deepest answered block', cov.answeredFromBlock === 91_001n
    && cov.headBlock === 100_000n);
  check('depth: refused window recorded', cov.refusal.fromBlock === 82_001n && cov.refusal.toBlock === 91_000n);
  check('depth: endpoint text kept verbatim despite HTTP 403', cov.refusal.message === REFUSAL_TEXT
    && cov.refusal.code === -32602);
  check('depth: exactly one window queried on the refused page (no halving or retry loop)',
    log.length - before === 4 && log.slice(before).every((r) => r.method === 'eth_getLogs'));
  const { note, detail } = tokenLogsCoverageNote(cov);
  check('depth: note says older than block N is not available',
    note.includes('History older than block 91001 is not available from the current endpoint'));
  check('depth: note points at the history indexer in Settings',
    note.includes('Settings → Ethereum history indexer') && note.includes('full history'));
  // F4 (phase 11 item 6): the recorded refusal stays verbatim (above), but
  // the user sees only the code and first sentence — no link, no advert.
  check('depth: detail shows the code and first sentence only',
    detail === "The endpoint's response: JSON-RPC error -32602: Archive requests require a personal token.", detail);
  check('depth: detail carries no URL and no "Get one at" advertisement',
    !/https?:|www\.|get one at/i.test(detail), detail);
  // The hook's transition: load-more keeps entries and swaps in the depth note.
  const afterFirst = historyNotesAfterPage({ note: TOKEN_LOGS_NOTE }, first);
  check('depth: page-1 notes keep the general caveat', afterFirst.note === TOKEN_LOGS_NOTE
    && afterFirst.noteDetail === undefined && afterFirst.coverage.answeredFromBlock === 91_001n);
  const afterSecond = historyNotesAfterPage(afterFirst, second);
  check('depth: load-more notes become the depth note + verbatim detail',
    afterSecond.note === note && afterSecond.noteDetail === detail && afterSecond.coverage.stop === 'refused');
  check('depth: non-logs pages leave notes untouched',
    historyNotesAfterPage(afterSecond, { entries: [] }) === afterSecond);
}

// (b) Refusal on the very first window: honest empty state, not an error.
{
  const { fetchFn } = depthLimitedFetch({ maxDepth: 0n, failAll: true });
  const p = tokenLogsHistoryProvider({
    rpcUrl: 'http://fake', walletAddress: ME, tokens: twoTokens,
    transport: tokenLogsTransport('http://fake', fetchFn),
  });
  const page = await p.getHistory(ME);
  const cov = tokenLogsCoverageOf(page);
  check('first-window refusal: no entries, no cursor', page.entries.length === 0 && page.nextCursor === undefined);
  check('first-window refusal: nothing answered', cov.answeredFromBlock === null && cov.stop === 'refused'
    && cov.refusal.fromBlock === 91_001n && cov.refusal.toBlock === 100_000n);
  const { note, detail } = tokenLogsCoverageNote(cov);
  check('first-window refusal: plain note naming the window',
    note.startsWith('No token history is available from the current endpoint')
    && note.includes('(91001–100000)') && note.includes('Settings → Ethereum history indexer'));
  check('first-window refusal: cleaned detail (code + first sentence)',
    detail.endsWith('JSON-RPC error -32602: Archive requests require a personal token.') && !/allnodes/i.test(detail), detail);
}

// (c) Any error counts (not only a recognised wording): a network failure
// on a deeper window stops paging the same way, with the transport's text.
{
  const { fetchFn } = depthLimitedFetch({ maxDepth: 10_000n, throwNetwork: true });
  const p = tokenLogsHistoryProvider({
    rpcUrl: 'http://fake', walletAddress: ME, tokens: twoTokens,
    transport: tokenLogsTransport('http://fake', fetchFn),
  });
  const first = await p.getHistory(ME);
  const second = await p.getHistory(ME, first.nextCursor);
  const cov = tokenLogsCoverageOf(second);
  check('network error on page 2: honest stop, answered depth kept', cov.stop === 'refused'
    && cov.answeredFromBlock === 91_001n && cov.refusal.message === 'fetch failed'
    && cov.refusal.code === undefined);
  check('network error detail has no invented code',
    tokenLogsCoverageNote(cov).detail === "The endpoint's response: fetch failed.");
}

// (d) A window counts only if EVERY query succeeded: one token refused, the
// other answered (with a real log in that window) → the window is dropped.
{
  const { fetchFn } = depthLimitedFetch({ maxDepth: 10_000n, onlyToken: DAI });
  const p = tokenLogsHistoryProvider({
    rpcUrl: 'http://fake', walletAddress: ME, tokens: twoTokens,
    transport: tokenLogsTransport('http://fake', fetchFn),
  });
  const first = await p.getHistory(ME);
  const second = await p.getHistory(ME, first.nextCursor);
  check('partial window discarded (USDC log at 85,000 not shown)', second.entries.length === 0
    && tokenLogsCoverageOf(second).answeredFromBlock === 91_001n);
}

// (e) eth_blockNumber failing on page 1 is still a thrown, retryable error.
{
  const fetchFn = async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('not json'); } });
  const p = tokenLogsHistoryProvider({
    rpcUrl: 'http://fake', walletAddress: ME, tokens: twoTokens,
    transport: tokenLogsTransport('http://fake', fetchFn),
  });
  let message = null;
  try { await p.getHistory(ME); } catch (e) { message = e.message; }
  check('unreachable endpoint on page 1 throws (Retry state)', message === 'RPC HTTP error 503 for eth_blockNumber');
}

// (f) The transport keeps 2xx JSON-RPC errors and plain results intact.
{
  const t = tokenLogsTransport('http://fake', async () => ({
    ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit exceeded' } }),
  }));
  let err = null;
  try { await t('eth_getLogs', []); } catch (e) { err = e; }
  check('transport: 200 + error object throws with code and verbatim text',
    err && err.code === -32005 && err.rpcMessage === 'limit exceeded'
    && err.message === 'RPC error -32005: limit exceeded (eth_getLogs)');
  const ok = tokenLogsTransport('http://fake', async () => ({
    ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x10' }),
  }));
  check('transport: result returned', (await ok('eth_blockNumber', [])) === '0x10');
}

// (g) Cursors from before the head field existed still parse.
{
  const p = tokenLogsHistoryProvider({ rpcUrl: 'http://fake', walletAddress: ME, tokens: twoTokens, transport });
  const legacy = await p.getHistory(ME, JSON.stringify({ v: 1, to: '90999', served: 1 }));
  check('legacy cursor accepted', Array.isArray(legacy.entries)
    && tokenLogsCoverageOf(legacy).answeredFromBlock === 82_000n);
}

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

// ---------------------------------------------------------------------------
// Optional LIVE pass (read-only): the exact app glue (historySourceFor →
// tokenLogsHistoryProvider → tokenLogsTransport) against the working
// keyless mainnet default. Only eth_blockNumber and eth_getLogs are sent.
// ---------------------------------------------------------------------------
if (process.argv.includes('--live')) {
  const LIVE_URL = 'https://ethereum.publicnode.com';
  console.log(`\nlive (read-only) against ${LIVE_URL}:`);
  const source = historySourceFor('evm-jsonrpc', LIVE_URL, null, undefined, {
    walletAddress: ME,
    tokens: [{ address: '0xA0b86991c6218b36c1d19D4a2e9eB0cE3606eB48', symbol: 'USDC', decimals: 6 }],
  });
  check('live: logs fallback selected', source.status === 'available' && source.note === TOKEN_LOGS_NOTE);
  let notes = { note: source.note };
  let page = await source.provider.getHistory(ME);
  notes = historyNotesAfterPage(notes, page);
  let pages = 1;
  let entries = page.entries.length;
  let threw = null;
  console.log(`  page 1: ${page.entries.length} entries, answered from block ${notes.coverage.answeredFromBlock} (head ${notes.coverage.headBlock}), cursor ${page.nextCursor ? 'present' : 'absent'}`);
  while (page.nextCursor && pages < 8) {
    try {
      page = await source.provider.getHistory(ME, page.nextCursor);
    } catch (e) {
      threw = e;
      break;
    }
    pages += 1;
    entries += page.entries.length;
    notes = historyNotesAfterPage(notes, page);
    const c = notes.coverage;
    console.log(`  page ${pages}: ${page.entries.length} entries, stop=${c.stop ?? 'none'}, answered from block ${c.answeredFromBlock}`);
  }
  check('live: no page threw', threw === null);
  const c = notes.coverage;
  console.log(`  pages fetched: ${pages}; entries: ${entries}`);
  console.log(`  answered depth: blocks ${c.answeredFromBlock}–${c.headBlock} (${c.answeredFromBlock === null ? 0n : c.headBlock - c.answeredFromBlock + 1n} blocks)`);
  console.log(`  stop: ${c.stop ?? 'none'}`);
  if (c.refusal) console.log(`  refused window: ${c.refusal.fromBlock}–${c.refusal.toBlock}`);
  console.log(`  note: ${notes.note}`);
  if (notes.noteDetail) console.log(`  detail: ${notes.noteDetail}`);
  check('live: paging ended in an honest stop', page.nextCursor === undefined && c.stop !== undefined);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

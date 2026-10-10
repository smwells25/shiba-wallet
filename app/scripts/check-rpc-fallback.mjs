// Default-endpoint fallback checks, entirely OFFLINE: the ordered default
// candidate lists (src/config/defaults.ts, src/config/evm-chain.ts) and the
// probe/resolver that picks among them (src/config/endpoint-probe.ts), run
// against a fake fetch. No network request leaves the process.
//
// Covered: first candidate down -> second used; a wrong-chain candidate is
// skipped and never used, not even as a last resort (including Sepolia
// candidates that answer with mainnet's chain id); a user override
// bypasses probing entirely; the choice is cached in memory, and a reported
// request failure drops it so the next resolution re-probes from the top
// (a recovered primary takes over again); a hanging candidate is abandoned
// after the probe timeout; concurrent resolutions share one probe pass;
// the freshness check (finding F-66): a candidate whose newest block is older
// than the bound is skipped with a "behind the chain" note, a candidate that
// cannot answer the freshness read is still accepted, the bound is inclusive,
// a device clock behind or ahead of the chain, and the last-resort rule when
// every candidate looks stale.
//
// Like check-devmode.mjs, it imports the actual TypeScript modules the app
// runs via Node's native type stripping. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-rpc-fallback.mjs           # offline only
//   node scripts/check-rpc-fallback.mjs --live    # plus live candidate probes
//
// The --live pass runs the app's probe (chain identity and freshness against
// the device clock) on every shipped candidate, then compares every test
// network candidate's head with the freshest one (eth_blockNumber) and
// records whether it serves eth_simulateV1 (used by the balance-change
// preview). A candidate the probe calls stale is printed, not failed: the
// app skips it, which is the behaviour under test.

import { EVM_ARBITRUM_SEPOLIA, EVM_BASE_SEPOLIA, EVM_MAINNET, EVM_SEPOLIA } from '../src/config/evm-chain.ts';
import { BASE_SEPOLIA_NETWORK, DEFAULT_NETWORKS, SEPOLIA_NETWORK, TEST_EVM_NETWORKS, networkDefaultFor } from '../src/config/defaults.ts';
const ARBITRUM_SEPOLIA_NETWORK = networkDefaultFor('eip155:421614');
import {
  FRESHNESS_BOUND_SECONDS,
  assessHeadFreshness,
  createDefaultEndpointResolver,
  describeDefaultChoice,
  describeDefaultFallbackNote,
  endpointHost,
  findAlternateDefaultUrl,
  probeEndpoint,
  resolveNetworkUrl,
} from '../src/config/endpoint-probe.ts';
import { assertSecureEndpointUrl } from '../src/config/endpoint-url.ts';

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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Chain identities the fake endpoints answer with. The mainnet values are
// the references inside the app's own CAIP-2 ids; "OTHER_*" values are
// arbitrary stand-ins for "some other chain".
const BTC_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const SOL_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const OTHER_BTC_GENESIS = 'ab'.repeat(32);
const OTHER_SOL_GENESIS = 'Z'.repeat(44);

const ETH = networkDefaultFor('eip155:1');
const BTC = networkDefaultFor('bip122:000000000019d6689c085ae165831e93');
const SOL = networkDefaultFor('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
const DOGE = networkDefaultFor('bip122:1a91e3dace36e2be3bf030a65679fe82');

// ---------------------------------------------------------------------------
// Fake fetch: per-URL behavior, every call recorded.
// ---------------------------------------------------------------------------

/**
 * behaviors: { [baseUrl]: 'down' | 'hang' | 'http500' | 'rpc-error' | 'malformed'
 *                        | { evmChainId, head? } | { genesis, head? } | { solGenesis, head? } }
 *
 * A string behavior applies to every request to that URL. For an object
 * behavior, the identity request (eth_chainId, GET /block-height/0,
 * getGenesisHash) answers with the given chain, and the probe's freshness
 * read (eth_getBlockByNumber, GET /blocks, getSlot + getBlockTime) answers
 * according to `head`:
 *   - a number: the newest block's timestamp in Unix seconds;
 *   - undefined: a block made 5 seconds ago by the real clock (fresh);
 *   - 'unsupported': a JSON-RPC "method not found" error (HTTP 404 for Esplora);
 *   - 'hang': never answers;
 *   - 'null': a null result (EVM block, Solana block time) or [] for Esplora;
 *   - 'down': the request fails at the transport level.
 *
 * `calls` records the identity requests only (so the ordering checks read as
 * before: one entry per probed candidate); `headCalls` records the freshness
 * reads; `all` records both, in order.
 */
const FRESH_HEAD = () => Math.floor(Date.now() / 1000) - 5;

function fakeFetch(behaviors) {
  const calls = [];
  const headCalls = [];
  const all = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const isHead =
      (body !== null && ['eth_getBlockByNumber', 'getSlot', 'getBlockTime'].includes(body.method)) ||
      (body === null && url.endsWith('/blocks'));
    (isHead ? headCalls : calls).push(url);
    all.push(url);
    const base = Object.keys(behaviors).find((b) => url === b || url.startsWith(`${b}/`));
    const behavior = base ? behaviors[base] : 'down';
    if (behavior === 'down') throw new TypeError('fetch failed (simulated TLS failure)');
    if (behavior === 'hang') return new Promise(() => {});
    if (behavior === 'http500') return { ok: false, status: 500, text: async () => 'oops' };
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (behavior === 'rpc-error') {
      return json({ jsonrpc: '2.0', id: body?.id ?? 1, error: { code: -32603, message: 'internal' } });
    }
    if (behavior === 'malformed') return json({ jsonrpc: '2.0', id: 1, result: 42 });
    if (isHead) {
      const head = behavior.head ?? FRESH_HEAD();
      if (head === 'down') throw new TypeError('fetch failed (simulated)');
      if (head === 'hang') return new Promise(() => {});
      if (head === 'unsupported') {
        if (body === null) return { ok: false, status: 404, text: async () => 'Not Found' };
        return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `the method ${body.method} does not exist/is not available` } });
      }
      if (body === null) {
        // Esplora GET /blocks: the 10 newest blocks, newest first.
        if (head === 'null') return json([]);
        return json(Array.from({ length: 10 }, (_, i) => ({ height: 900_000 - i, timestamp: head - 600 * i })));
      }
      if (body.method === 'eth_getBlockByNumber') {
        if (JSON.stringify(body.params) !== JSON.stringify(['latest', false])) throw new Error(`unexpected params ${JSON.stringify(body.params)}`);
        return json({ jsonrpc: '2.0', id: body.id, result: head === 'null' ? null : { number: '0xab12cd', timestamp: `0x${head.toString(16)}` } });
      }
      if (body.method === 'getSlot') {
        if (JSON.stringify(body.params) !== JSON.stringify([{ commitment: 'finalized' }])) throw new Error(`unexpected params ${JSON.stringify(body.params)}`);
        return json({ jsonrpc: '2.0', id: body.id, result: 455_074_738 });
      }
      if (JSON.stringify(body.params) !== JSON.stringify([455_074_738])) throw new Error(`unexpected params ${JSON.stringify(body.params)}`);
      return json({ jsonrpc: '2.0', id: body.id, result: head === 'null' ? null : head });
    }
    if (behavior.evmChainId !== undefined) {
      if (body?.method !== 'eth_chainId') throw new Error(`unexpected method ${body?.method}`);
      return json({ jsonrpc: '2.0', id: body.id, result: behavior.evmChainId });
    }
    if (behavior.solGenesis !== undefined) {
      if (body?.method !== 'getGenesisHash') throw new Error(`unexpected method ${body?.method}`);
      return json({ jsonrpc: '2.0', id: body.id, result: behavior.solGenesis });
    }
    if (behavior.genesis !== undefined) {
      if (!url.endsWith('/block-height/0')) throw new Error(`unexpected path ${url}`);
      return { ok: true, status: 200, text: async () => `${behavior.genesis}\n` };
    }
    throw new Error(`no behavior for ${url}`);
  };
  return { fn, calls, headCalls, all };
}

// ---------------------------------------------------------------------------
// 1. Candidate lists (pinned; every entry live-verified 2026-10-01, and the
//    Sepolia fallbacks 2026-10-02, per the comments in defaults.ts /
//    evm-chain.ts)
// ---------------------------------------------------------------------------

console.log('default candidate lists:');

check(
  'mainnet EVM: documented ethereum-rpc first, ethereum.publicnode.com second',
  same(EVM_MAINNET.defaultRpcUrls, [
    'https://ethereum-rpc.publicnode.com',
    'https://ethereum.publicnode.com',
  ]),
);
check(
  'Sepolia EVM: publicnode primary, then Pocket, 0xRPC, 1RPC public',
  same(EVM_SEPOLIA.defaultRpcUrls, [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://eth-sepolia-testnet.api.pocket.network',
    'https://0xrpc.io/sep',
    'https://public.1rpc.io/sepolia',
  ]),
);
{
  // Candidates rejected in evm-chain.ts must not creep back in silently.
  const rejected = [
    'https://ethereum-sepolia.publicnode.com',
    'https://sepolia.drpc.org',
    'https://rpc.sepolia.org',
    'https://rpc2.sepolia.org',
    'https://rpc.ankr.com/eth_sepolia',
  ];
  check(
    'Sepolia EVM: none of the recorded rejected candidates is listed',
    EVM_SEPOLIA.defaultRpcUrls.every((u) => !rejected.includes(u)),
  );
  check(
    'Sepolia EVM: no candidate is shared with the mainnet list',
    EVM_SEPOLIA.defaultRpcUrls.every((u) => !EVM_MAINNET.defaultRpcUrls.includes(u)),
  );
}
check(
  'Base Sepolia EVM: publicnode primary, then sepolia.base.org, then Pocket (phase 10 item 3)',
  same(EVM_BASE_SEPOLIA.defaultRpcUrls, [
    'https://base-sepolia-rpc.publicnode.com',
    'https://sepolia.base.org',
    'https://base-sepolia-testnet.api.pocket.network',
  ]),
);
{
  // Checked and rejected in evm-chain.ts (2026-10-03): 1RPC answers
  // "unknown network"; the sequencer URL is transaction-submission only and
  // refuses eth_chainId; dRPC's keyless status was not documented.
  const rejected = [
    'https://public.1rpc.io/base-sepolia',
    'https://sepolia-sequencer.base.org',
    'https://base-sepolia.drpc.org',
  ];
  check('Base Sepolia EVM: none of the recorded rejected candidates is listed', EVM_BASE_SEPOLIA.defaultRpcUrls.every((u) => !rejected.includes(u)));
  check(
    'Base Sepolia EVM: no candidate is shared with the mainnet or Sepolia lists',
    EVM_BASE_SEPOLIA.defaultRpcUrls.every((u) => !EVM_MAINNET.defaultRpcUrls.includes(u) && !EVM_SEPOLIA.defaultRpcUrls.includes(u)),
  );
}
check(
  'Arbitrum Sepolia EVM: publicnode primary, then Arbitrum’s own RPC, then Pocket (phase 14 item 3)',
  same(EVM_ARBITRUM_SEPOLIA.defaultRpcUrls, [
    'https://arbitrum-sepolia-rpc.publicnode.com',
    'https://sepolia-rollup.arbitrum.io/rpc',
    'https://arb-sepolia-testnet.api.pocket.network',
  ]),
);
{
  // Recorded in evm-chain.ts (2026-10-04): the sequencer URL serves only
  // eth_sendRawTransaction(Conditional); dRPC shows no keyless URL.
  check('Arbitrum Sepolia EVM: the send-only sequencer URL is not listed', EVM_ARBITRUM_SEPOLIA.defaultRpcUrls.every((u) => u !== 'https://sepolia-rollup-sequencer.arbitrum.io/rpc'));
  check(
    'Arbitrum Sepolia EVM: no candidate is shared with another profile',
    EVM_ARBITRUM_SEPOLIA.defaultRpcUrls.every((u) => ![EVM_MAINNET, EVM_SEPOLIA, EVM_BASE_SEPOLIA].some((p) => p.defaultRpcUrls.includes(u))),
  );
  check('Arbitrum Sepolia row list is the profile list (no drift)', ARBITRUM_SEPOLIA_NETWORK?.defaultUrls === EVM_ARBITRUM_SEPOLIA.defaultRpcUrls);
}
check(
  'Bitcoin Esplora: blockstream.info then mempool.space',
  same(BTC.defaultUrls, ['https://blockstream.info/api', 'https://mempool.space/api']),
);
check(
  'Solana: api.mainnet, api.mainnet-beta, solana.publicnode.com',
  same(SOL.defaultUrls, [
    'https://api.mainnet.solana.com',
    'https://api.mainnet-beta.solana.com',
    'https://solana.publicnode.com',
  ]),
);
check('Dogecoin: still no default (empty list, null primary)', DOGE.defaultUrls.length === 0 && DOGE.defaultUrl === null);
check('Ethereum row list is the mainnet profile list (no drift)', ETH.defaultUrls === EVM_MAINNET.defaultRpcUrls);
check('Sepolia row list is the Sepolia profile list (no drift)', SEPOLIA_NETWORK.defaultUrls === EVM_SEPOLIA.defaultRpcUrls);
check('Base Sepolia row list is the Base Sepolia profile list (no drift)', BASE_SEPOLIA_NETWORK.defaultUrls === EVM_BASE_SEPOLIA.defaultRpcUrls);
check('networkDefaultFor(eip155:84532) is the Base Sepolia row', networkDefaultFor('eip155:84532') === BASE_SEPOLIA_NETWORK);
{
  const all = [...DEFAULT_NETWORKS, ...TEST_EVM_NETWORKS];
  check(
    'every defaultUrl equals defaultUrls[0] (or null when empty)',
    all.every((n) => n.defaultUrl === (n.defaultUrls[0] ?? null)),
  );
  check(
    'profile defaultRpcUrl equals defaultRpcUrls[0]',
    EVM_MAINNET.defaultRpcUrl === EVM_MAINNET.defaultRpcUrls[0] &&
      EVM_SEPOLIA.defaultRpcUrl === EVM_SEPOLIA.defaultRpcUrls[0] &&
      EVM_BASE_SEPOLIA.defaultRpcUrl === EVM_BASE_SEPOLIA.defaultRpcUrls[0] &&
      EVM_ARBITRUM_SEPOLIA.defaultRpcUrl === EVM_ARBITRUM_SEPOLIA.defaultRpcUrls[0],
  );
  const urls = all.flatMap((n) => n.defaultUrls);
  check('every candidate is https:// with no trailing slash', urls.every((u) => /^https:\/\/[^\s]+[^/]$/.test(u)));
  // The same rule user-entered endpoints must pass (src/config/endpoint-url.ts):
  // every built-in default is https (no loopback http exception is used by
  // a default) and passes the shared helper unchanged.
  check(
    'every default candidate passes assertSecureEndpointUrl unchanged',
    urls.length > 0 && urls.every((u) => {
      try {
        return assertSecureEndpointUrl(u) === u;
      } catch {
        return false;
      }
    }),
  );
  check(
    'no default candidate uses plain http:// (not even loopback)',
    urls.every((u) => u.startsWith('https://')) &&
      [...EVM_MAINNET.defaultRpcUrls, ...EVM_SEPOLIA.defaultRpcUrls, ...EVM_BASE_SEPOLIA.defaultRpcUrls].every((u) => u.startsWith('https://')),
  );
  check('no candidate carries a key-like query or path secret', urls.every((u) => !/[?#]|\/v[23]\/|key/i.test(u)));
  check('no duplicate candidates within a chain', all.every((n) => new Set(n.defaultUrls).size === n.defaultUrls.length));
}

// ---------------------------------------------------------------------------
// 2. probeEndpoint: chain identity per namespace
// ---------------------------------------------------------------------------

console.log('probeEndpoint:');

{
  const U = 'https://evm.fake';
  const ok = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fakeFetch({ [U]: { evmChainId: '0x1' } }).fn });
  check('EVM: eth_chainId 0x1 passes for eip155:1', ok.ok === true);
  const sep = await probeEndpoint('evm-jsonrpc', U, 'eip155:11155111', { fetchFn: fakeFetch({ [U]: { evmChainId: '0xaa36a7' } }).fn });
  check('EVM: eth_chainId 0xaa36a7 passes for eip155:11155111', sep.ok === true);
  const wrong = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fakeFetch({ [U]: { evmChainId: '0xaa36a7' } }).fn });
  check('EVM: a Sepolia node is wrong-chain for mainnet', !wrong.ok && wrong.kind === 'wrong-chain', JSON.stringify(wrong));
  const wrong2 = await probeEndpoint('evm-jsonrpc', U, 'eip155:11155111', { fetchFn: fakeFetch({ [U]: { evmChainId: '0x1' } }).fn });
  check('EVM: a mainnet node is wrong-chain for Sepolia', !wrong2.ok && wrong2.kind === 'wrong-chain');
  const base = await probeEndpoint('evm-jsonrpc', U, 'eip155:84532', { fetchFn: fakeFetch({ [U]: { evmChainId: '0x14a34' } }).fn });
  check('EVM: eth_chainId 0x14a34 passes for eip155:84532 (Base Sepolia)', base.ok === true);
  const sepForBase = await probeEndpoint('evm-jsonrpc', U, 'eip155:84532', { fetchFn: fakeFetch({ [U]: { evmChainId: '0xaa36a7' } }).fn });
  check('EVM: a Sepolia node is wrong-chain for Base Sepolia', !sepForBase.ok && sepForBase.kind === 'wrong-chain' && /identifies as 11155111, expected 84532/.test(sepForBase.reason), JSON.stringify(sepForBase));
  const baseForSep = await probeEndpoint('evm-jsonrpc', U, 'eip155:11155111', { fetchFn: fakeFetch({ [U]: { evmChainId: '0x14a34' } }).fn });
  check('EVM: a Base Sepolia node is wrong-chain for Sepolia', !baseForSep.ok && baseForSep.kind === 'wrong-chain' && /identifies as 84532, expected 11155111/.test(baseForSep.reason), JSON.stringify(baseForSep));
  const baseMain = await probeEndpoint('evm-jsonrpc', U, 'eip155:84532', { fetchFn: fakeFetch({ [U]: { evmChainId: '0x2105' } }).fn });
  check('EVM: a Base MAINNET node (0x2105 = 8453) is wrong-chain for Base Sepolia', !baseMain.ok && baseMain.kind === 'wrong-chain');
  for (const behavior of ['down', 'http500', 'rpc-error', 'malformed']) {
    const r = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fakeFetch({ [U]: behavior }).fn });
    check(`EVM: '${behavior}' is unreachable (not usable)`, !r.ok && r.kind === 'unreachable', JSON.stringify(r));
  }
  const started = Date.now();
  const hung = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fakeFetch({ [U]: 'hang' }).fn, timeoutMs: 50 });
  const elapsed = Date.now() - started;
  check('EVM: a hanging endpoint times out as unreachable', !hung.ok && hung.kind === 'unreachable' && /50 ms/.test(hung.reason));
  check('EVM: the timeout is honored (well under 1 s)', elapsed < 1000, `${elapsed} ms`);
}
{
  const U = 'https://esplora.fake/api';
  const { fn, calls } = fakeFetch({ [U]: { genesis: BTC_GENESIS } });
  const ok = await probeEndpoint('esplora', U, BTC.chainId, { fetchFn: fn });
  check('Esplora: mainnet genesis passes for the Bitcoin CAIP-2 id', ok.ok === true);
  check('Esplora: probes GET /block-height/0', calls[0] === `${U}/block-height/0`);
  const wrong = await probeEndpoint('esplora', U, BTC.chainId, { fetchFn: fakeFetch({ [U]: { genesis: OTHER_BTC_GENESIS } }).fn });
  check('Esplora: another chain\'s genesis is wrong-chain', !wrong.ok && wrong.kind === 'wrong-chain');
  const junk = await probeEndpoint('esplora', U, BTC.chainId, { fetchFn: fakeFetch({ [U]: { genesis: '<html>' } }).fn });
  check('Esplora: a non-hash body is unreachable', !junk.ok && junk.kind === 'unreachable');
}
{
  const U = 'https://solana.fake';
  const ok = await probeEndpoint('solana-jsonrpc', U, SOL.chainId, { fetchFn: fakeFetch({ [U]: { solGenesis: SOL_GENESIS } }).fn });
  check('Solana: mainnet genesis passes (first 32 chars = CAIP-2 reference)', ok.ok === true);
  const wrong = await probeEndpoint('solana-jsonrpc', U, SOL.chainId, { fetchFn: fakeFetch({ [U]: { solGenesis: OTHER_SOL_GENESIS } }).fn });
  check('Solana: another cluster\'s genesis is wrong-chain', !wrong.ok && wrong.kind === 'wrong-chain');
}

// ---------------------------------------------------------------------------
// 2b. Freshness (finding F-66): the newest block against the device clock
// ---------------------------------------------------------------------------

console.log('freshness:');

// The figures recorded for F-66 (AGENTS.md phase 15, "SEPOLIA FORK FINDINGS
// RESOLVED"): https://0xrpc.io/sep stuck at block 11856335 with timestamp
// 1791294792, re-read on 2026-10-09 when the device clock said 1791595910.
const F66_STUCK_HEAD = 1791294792;
const F66_DEVICE_NOW_MS = 1791595910 * 1000;

check(
  'bounds are the documented judgements: EVM 10 min, Esplora 3 h, Solana 5 min',
  FRESHNESS_BOUND_SECONDS['evm-jsonrpc'] === 600 && FRESHNESS_BOUND_SECONDS.esplora === 10_800 && FRESHNESS_BOUND_SECONDS['solana-jsonrpc'] === 300,
  JSON.stringify(FRESHNESS_BOUND_SECONDS),
);
{
  const head = 1_800_000_000;
  check('rule: exactly at the bound is fresh (inclusive)', assessHeadFreshness(head, (head + 600) * 1000, 600).stale === false);
  check('rule: one millisecond past the bound is stale', assessHeadFreshness(head, (head + 600) * 1000 + 1, 600).stale === true);
  check('rule: a head ahead of the device clock is fresh (negative age)', assessHeadFreshness(head, (head - 3600) * 1000, 600).stale === false && assessHeadFreshness(head, (head - 3600) * 1000, 600).ageSeconds === -3600);
  check('rule: the F-66 head is about 83.6 hours old by that clock', Math.round(assessHeadFreshness(F66_STUCK_HEAD, F66_DEVICE_NOW_MS, 600).ageSeconds) === 301_118);
}
{
  const U = 'https://evm.fake';
  const head = 1_800_000_000;
  const at = (offsetSeconds) => () => (head + offsetSeconds) * 1000;
  const fresh = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fakeFetch({ [U]: { evmChainId: '0x1' } }).fn });
  check('EVM: a block made 5 s ago passes as fresh', fresh.ok === true && fresh.freshness === 'fresh', JSON.stringify(fresh));
  const { fn, calls, headCalls, all } = fakeFetch({ [U]: { evmChainId: '0x1', head } });
  const atBound = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fn, now: at(600) });
  check('EVM: a head exactly 600 s old is accepted', atBound.ok === true && atBound.freshness === 'fresh', JSON.stringify(atBound));
  check('EVM: one identity request and one freshness request per probe', calls.length === 1 && headCalls.length === 1);
  check('EVM: identity first, then the freshness read', same(all, [U, U]) && calls.length === 1);
  const past = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fn, now: at(601) });
  check('EVM: a head 601 s old is stale', !past.ok && past.kind === 'stale' && past.headTimestamp === head && /^the newest block is 601 s old \(timestamp 1800000000\), more than the 600 s allowed$/.test(past.reason), JSON.stringify(past));
  const ahead = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fn, now: at(-120) });
  check('EVM: device clock 2 minutes BEHIND the chain (head in the future) is fresh', ahead.ok === true && ahead.freshness === 'fresh');
  const clockAhead = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fn, now: at(12 + 90) });
  check('EVM: device clock 90 s AHEAD of a 12 s-old block is still fresh', clockAhead.ok === true && clockAhead.freshness === 'fresh');
  const clockFarAhead = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fn, now: at(12 * 3600) });
  check('EVM: device clock 12 hours ahead makes a live chain look stale (handled by the resolver)', !clockFarAhead.ok && clockFarAhead.kind === 'stale');
  const custom = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fn, now: at(61), freshnessBoundSeconds: 60 });
  check('EVM: freshnessBoundSeconds overrides the bound', !custom.ok && custom.kind === 'stale');
  const off = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fakeFetch({ [U]: { evmChainId: '0x1', head } }).fn, now: at(10_000), checkFreshness: false });
  check('EVM: checkFreshness false checks identity only', off.ok === true && off.freshness === undefined);
  const f66 = await probeEndpoint('evm-jsonrpc', 'https://0xrpc.io/sep', 'eip155:11155111', {
    fetchFn: fakeFetch({ 'https://0xrpc.io/sep': { evmChainId: '0xaa36a7', head: F66_STUCK_HEAD } }).fn,
    now: () => F66_DEVICE_NOW_MS,
  });
  check('EVM: the recorded F-66 endpoint (right chain id, frozen head) is stale', !f66.ok && f66.kind === 'stale' && f66.headTimestamp === F66_STUCK_HEAD, JSON.stringify(f66));
  const wrongAndOld = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fakeFetch({ [U]: { evmChainId: '0xaa36a7', head } }).fn, now: at(10_000) });
  check('EVM: identity is decided first (wrong chain AND old head -> wrong-chain)', !wrongAndOld.ok && wrongAndOld.kind === 'wrong-chain');
  {
    const wrongFake = fakeFetch({ [U]: { evmChainId: '0xaa36a7' } });
    await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: wrongFake.fn });
    check('EVM: a wrong-chain candidate gets no freshness read (sequential)', wrongFake.headCalls.length === 0 && wrongFake.calls.length === 1);
  }
  const downFake = fakeFetch({ [U]: 'down' });
  const downAndFresh = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: downFake.fn });
  check('EVM: a dead endpoint stays unreachable (not stale)', !downAndFresh.ok && downAndFresh.kind === 'unreachable');
  check('EVM: a dead endpoint receives only the one identity request', downFake.all.length === 1);

  // A freshness read that errors is UNKNOWN, never stale: the candidate is accepted.
  for (const [what, headBehavior] of [
    ['method not supported (-32601)', 'unsupported'],
    ['a null block', 'null'],
    ['a transport failure on the freshness read only', 'down'],
  ]) {
    const r = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fakeFetch({ [U]: { evmChainId: '0x1', head: headBehavior } }).fn });
    check(`EVM: ${what} -> accepted with freshness unknown`, r.ok === true && r.freshness === 'unknown' && typeof r.freshnessDetail === 'string', JSON.stringify(r));
  }
  const started = Date.now();
  const slowHead = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: fakeFetch({ [U]: { evmChainId: '0x1', head: 'hang' } }).fn, timeoutMs: 50 });
  const elapsed = Date.now() - started;
  check('EVM: a freshness read with no answer by the deadline -> accepted, unknown', slowHead.ok === true && slowHead.freshness === 'unknown' && /50 ms/.test(slowHead.freshnessDetail ?? ''), JSON.stringify(slowHead));
  check('EVM: the shared per-candidate deadline is honoured (well under 1 s)', elapsed < 1000, `${elapsed} ms`);
  // The freshness read gets only what the identity answer left of the same
  // deadline: identity answers after ~150 ms of a 250 ms budget and the
  // freshness read never answers, so the probe ends at ~250 ms, not ~400 ms.
  const inner = fakeFetch({ [U]: { evmChainId: '0x1', head: 'hang' } }).fn;
  const slowIdentity = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (body?.method === 'eth_chainId') await new Promise((resolve) => setTimeout(resolve, 150));
    return inner(url, init);
  };
  const t0 = Date.now();
  const shared = await probeEndpoint('evm-jsonrpc', U, 'eip155:1', { fetchFn: slowIdentity, timeoutMs: 250 });
  const sharedElapsed = Date.now() - t0;
  check('EVM: identity + freshness together stay within one timeout (shared deadline)', shared.ok === true && shared.freshness === 'unknown' && sharedElapsed >= 240 && sharedElapsed < 380, `${sharedElapsed} ms`);
}
{
  const U = 'https://esplora.fake/api';
  const head = 1_800_000_000;
  const { fn, calls, headCalls } = fakeFetch({ [U]: { genesis: BTC_GENESIS, head } });
  const ok = await probeEndpoint('esplora', U, BTC.chainId, { fetchFn: fn, now: () => (head + 10_800) * 1000 });
  check('Esplora: a tip exactly 3 hours old is accepted', ok.ok === true && ok.freshness === 'fresh', JSON.stringify(ok));
  check('Esplora: freshness reads GET /blocks (one request)', same(headCalls, [`${U}/blocks`]) && same(calls, [`${U}/block-height/0`]));
  const old = await probeEndpoint('esplora', U, BTC.chainId, { fetchFn: fn, now: () => (head + 10_801) * 1000 });
  check('Esplora: a tip 3 hours and 1 second old is stale', !old.ok && old.kind === 'stale' && old.headTimestamp === head, JSON.stringify(old));
  const hourGap = await probeEndpoint('esplora', U, BTC.chainId, { fetchFn: fn, now: () => (head + 75 * 60) * 1000 });
  check('Esplora: a 75-minute gap since the last block is still fresh', hourGap.ok === true);
  // Timestamps are not strictly increasing: the newest among the 10 counts.
  const unordered = async (url, init) => {
    if (url.endsWith('/blocks')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ height: 2, timestamp: head - 100 }, { height: 1, timestamp: head }]) };
    }
    return fn(url, init);
  };
  const newest = await probeEndpoint('esplora', U, BTC.chainId, { fetchFn: unordered, now: () => (head + 10_800) * 1000 });
  check('Esplora: the newest timestamp among the returned blocks is used', newest.ok === true && newest.freshness === 'fresh');
  for (const [what, headBehavior] of [['HTTP 404 for /blocks', 'unsupported'], ['an empty list', 'null']]) {
    const r = await probeEndpoint('esplora', U, BTC.chainId, { fetchFn: fakeFetch({ [U]: { genesis: BTC_GENESIS, head: headBehavior } }).fn });
    check(`Esplora: ${what} -> accepted with freshness unknown`, r.ok === true && r.freshness === 'unknown', JSON.stringify(r));
  }
}
{
  const U = 'https://solana.fake';
  const head = 1_800_000_000;
  const { fn, headCalls } = fakeFetch({ [U]: { solGenesis: SOL_GENESIS, head } });
  const ok = await probeEndpoint('solana-jsonrpc', U, SOL.chainId, { fetchFn: fn, now: () => (head + 300) * 1000 });
  check('Solana: a finalized block time exactly 5 minutes old is accepted', ok.ok === true && ok.freshness === 'fresh', JSON.stringify(ok));
  check('Solana: freshness reads getSlot (finalized) then getBlockTime for that slot', headCalls.length === 2);
  const old = await probeEndpoint('solana-jsonrpc', U, SOL.chainId, { fetchFn: fn, now: () => (head + 301) * 1000 });
  check('Solana: 301 s old is stale', !old.ok && old.kind === 'stale', JSON.stringify(old));
  for (const [what, headBehavior] of [['getBlockTime null (no time recorded)', 'null'], ['method not supported', 'unsupported']]) {
    const r = await probeEndpoint('solana-jsonrpc', U, SOL.chainId, { fetchFn: fakeFetch({ [U]: { solGenesis: SOL_GENESIS, head: headBehavior } }).fn });
    check(`Solana: ${what} -> accepted with freshness unknown`, r.ok === true && r.freshness === 'unknown', JSON.stringify(r));
  }
}
{
  // Resolver: a stale PRIMARY is skipped, the second candidate is chosen,
  // and Settings says the primary is behind the chain.
  const [SEP1, SEP2, SEP3, SEP4] = SEPOLIA_NETWORK.defaultUrls;
  const now = () => F66_DEVICE_NOW_MS;
  const fresh = 1791595900;
  const { fn, calls } = fakeFetch({
    [SEP1]: { evmChainId: '0xaa36a7', head: F66_STUCK_HEAD },
    [SEP2]: { evmChainId: '0xaa36a7', head: fresh },
    [SEP3]: { evmChainId: '0xaa36a7', head: fresh },
    [SEP4]: { evmChainId: '0xaa36a7', head: fresh },
  });
  const choice = await createDefaultEndpointResolver({ fetchFn: fn, now }).resolve(SEPOLIA_NETWORK);
  check('stale primary -> second candidate chosen, healthy', choice.url === SEP2 && choice.index === 1 && choice.healthy === true && choice.stale === undefined, JSON.stringify(choice));
  check('stale primary: probing stopped at the second candidate', same(calls, [SEP1, SEP2]));
  check('stale primary: the reason and kind are recorded', choice.primaryFailureKind === 'stale' && /^the newest block is 301118 s old/.test(choice.primaryFailure ?? ''), JSON.stringify(choice));
  check('stale primary: the tag names the fallback in use', describeDefaultChoice(choice) === 'default (2 of 4: eth-sepolia-testnet.api.pocket.network)', describeDefaultChoice(choice));
  const note = describeDefaultFallbackNote(choice, SEPOLIA_NETWORK.defaultUrls);
  check(
    'stale primary: the note says the primary is behind the chain (not unreachable)',
    note === 'The primary default (ethereum-sepolia-rpc.publicnode.com) is behind the chain right now (its newest block is older than expected), so a fallback default is in use. The primary is tried again on the next app launch or whenever the fallback fails.',
    note,
  );
}
{
  // The F-66 situation itself: publicnode and Pocket unreachable, 0xRPC
  // answering as Sepolia with its frozen head -> skipped for 1RPC.
  const [SEP1, SEP2, SEP3, SEP4] = SEPOLIA_NETWORK.defaultUrls;
  check('the third Sepolia candidate is the F-66 endpoint', SEP3 === 'https://0xrpc.io/sep');
  const { fn, calls } = fakeFetch({
    [SEP1]: 'down',
    [SEP2]: 'down',
    [SEP3]: { evmChainId: '0xaa36a7', head: F66_STUCK_HEAD },
    [SEP4]: { evmChainId: '0xaa36a7', head: 1791595900 },
  });
  const choice = await createDefaultEndpointResolver({ fetchFn: fn, now: () => F66_DEVICE_NOW_MS }).resolve(SEPOLIA_NETWORK);
  check('F-66 replay: the frozen 0xrpc.io/sep is skipped, 1RPC chosen', choice.url === SEP4 && choice.healthy === true, JSON.stringify(choice));
  check('F-66 replay: all four probed in order', same(calls, [SEP1, SEP2, SEP3, SEP4]));
}
{
  // A candidate that cannot answer the freshness read is still accepted.
  const [ETH1A, ETH2A] = EVM_MAINNET.defaultRpcUrls;
  const { fn, calls } = fakeFetch({ [ETH1A]: { evmChainId: '0x1', head: 'unsupported' }, [ETH2A]: { evmChainId: '0x1' } });
  const choice = await createDefaultEndpointResolver({ fetchFn: fn }).resolve(ETH);
  check('primary without eth_getBlockByNumber is accepted (not skipped as stale)', choice.url === ETH1A && choice.healthy === true && choice.primaryUnreachable === false && same(calls, [ETH1A]), JSON.stringify(choice));
}
{
  // Device clock far ahead (2 days): EVERY candidate looks stale. The
  // newest head among them is used, flagged unhealthy and stale, so the
  // chain is not blanked; the note points at the phone's date and time.
  const [SEP1, SEP2, SEP3, SEP4] = SEPOLIA_NETWORK.defaultUrls;
  const live = 1791595900;
  const { fn } = fakeFetch({
    [SEP1]: { evmChainId: '0xaa36a7', head: live - 3 },
    [SEP2]: { evmChainId: '0xaa36a7', head: live },
    [SEP3]: { evmChainId: '0xaa36a7', head: F66_STUCK_HEAD },
    [SEP4]: { evmChainId: '0xaa36a7', head: live - 1 },
  });
  const choice = await createDefaultEndpointResolver({ fetchFn: fn, now: () => (live + 2 * 86_400) * 1000 }).resolve(SEPOLIA_NETWORK);
  check('clock 2 days ahead: the candidate with the newest head is used, flagged', choice.url === SEP2 && choice.index === 1 && choice.healthy === false && choice.stale === true, JSON.stringify(choice));
  check('clock 2 days ahead: the frozen candidate is never the one chosen', choice.url !== SEP3);
  check('clock 2 days ahead: the tag says behind the chain', describeDefaultChoice(choice) === 'default (2 of 4: eth-sepolia-testnet.api.pocket.network, behind the chain)', describeDefaultChoice(choice));
  const note = describeDefaultFallbackNote(choice, SEPOLIA_NETWORK.defaultUrls);
  check(
    'clock 2 days ahead: the note says data may be out of date and names the phone clock',
    note !== null && /None of the 4 default endpoints passed the last check/.test(note) && /may be out of date/.test(note) && /date and time are wrong/.test(note) && note.includes('eth-sepolia-testnet.api.pocket.network'),
    note,
  );
}
{
  // Mixed: wrong chain, unreachable and stale only -> the stale one with
  // the newest head (it answers as the right chain); never the wrong chain.
  const [SEP1, SEP2, SEP3, SEP4] = SEPOLIA_NETWORK.defaultUrls;
  const now = 1791595910;
  const { fn } = fakeFetch({
    [SEP1]: { evmChainId: '0x1', head: now },
    [SEP2]: { evmChainId: '0xaa36a7', head: now - 3_000 },
    [SEP3]: 'down',
    [SEP4]: { evmChainId: '0xaa36a7', head: now - 2_000 },
  });
  const choice = await createDefaultEndpointResolver({ fetchFn: fn, now: () => now * 1000 }).resolve(SEPOLIA_NETWORK);
  check('no healthy candidate: the newest stale one beats unreachable and wrong-chain', choice.url === SEP4 && choice.stale === true && !choice.healthy, JSON.stringify(choice));
  check('no healthy candidate: the wrong-chain primary is recorded as such', choice.primaryFailureKind === 'wrong-chain');
}
{
  // Unhealthy (stale) results are cached only briefly, then re-probed.
  let clock = 1791595910 * 1000;
  const [ETH1A, ETH2A] = EVM_MAINNET.defaultRpcUrls;
  const behaviors = { [ETH1A]: { evmChainId: '0x1', head: 1791590000 }, [ETH2A]: 'down' };
  const { fn, calls } = fakeFetch(behaviors);
  const resolver = createDefaultEndpointResolver({ fetchFn: fn, failureRetryMs: 10_000, now: () => clock });
  const first = await resolver.resolve(ETH);
  check('only a stale candidate answers -> it is returned unhealthy and stale', first.url === ETH1A && first.stale === true && !first.healthy);
  clock += 5_000;
  await resolver.resolve(ETH);
  check('stale result reused within the retry window', calls.length === 2);
  behaviors[ETH1A] = { evmChainId: '0x1', head: 1791595910 };
  clock += 6_000;
  const later = await resolver.resolve(ETH);
  check('after the window the caught-up primary is healthy again', later.url === ETH1A && later.healthy === true && later.stale === undefined && calls.length === 3);
}
{
  // Read-only history search: a stale alternate is not offered.
  const list = ['https://a.example', 'https://b.example', 'https://c.example'];
  const now = 1791595910;
  const { fn } = fakeFetch({
    'https://a.example': { evmChainId: '0x1', head: now },
    'https://b.example': { evmChainId: '0x1', head: now - 3_600 },
    'https://c.example': { evmChainId: '0x1', head: now },
  });
  const alt = await findAlternateDefaultUrl({ kind: 'evm-jsonrpc', chainId: 'eip155:1', defaultUrls: list }, 'https://a.example', false, { fetchFn: fn, now: () => now * 1000 });
  check('alternate search skips a stale candidate', alt === 'https://c.example', String(alt));
}

// ---------------------------------------------------------------------------
// 3. Resolver: ordering, wrong-chain refusal, caching, re-probe
// ---------------------------------------------------------------------------

console.log('resolver:');

const [ETH1, ETH2] = EVM_MAINNET.defaultRpcUrls;

{
  // First candidate down -> second used.
  const { fn, calls } = fakeFetch({ [ETH1]: 'down', [ETH2]: { evmChainId: '0x1' } });
  const resolver = createDefaultEndpointResolver({ fetchFn: fn });
  const choice = await resolver.resolve(ETH);
  check('primary down -> second candidate chosen', choice.url === ETH2 && choice.index === 1 && choice.healthy);
  check('primaryUnreachable is flagged', choice.primaryUnreachable === true && typeof choice.primaryFailure === 'string');
  check('probed strictly in order (primary first)', same(calls, [ETH1, ETH2]));
  check(
    'Settings tag names the active default',
    describeDefaultChoice(choice) === 'default (2 of 2: ethereum.publicnode.com)',
    describeDefaultChoice(choice),
  );
  const note = describeDefaultFallbackNote(choice, ETH.defaultUrls);
  check('Settings note names the unreachable primary', note !== null && note.includes('ethereum-rpc.publicnode.com') && /fallback/.test(note), note);

  // Cached: no further requests.
  const again = await resolver.resolve(ETH);
  check('second resolve uses the in-memory cache (no new probes)', again === choice && calls.length === 2);
  check('peek returns the cached choice', resolver.peek(ETH.chainId) === choice);

  // A request through the cached fallback fails; the primary has recovered.
  check('reportFailure for a different URL is ignored', resolver.reportFailure(ETH.chainId, ETH1) === false);
  check('reportFailure for another chain is ignored', resolver.reportFailure(SEPOLIA_NETWORK.chainId, ETH2) === false);
  check('reportFailure for the cached URL drops it', resolver.reportFailure(ETH.chainId, ETH2) === true);
  check('nothing cached after the drop', resolver.peek(ETH.chainId) === undefined);
}
{
  // Re-probe starts from the top: a recovered primary takes over.
  const behaviors = { [ETH1]: 'down', [ETH2]: { evmChainId: '0x1' } };
  const { fn, calls } = fakeFetch(behaviors);
  const resolver = createDefaultEndpointResolver({ fetchFn: fn });
  await resolver.resolve(ETH);
  behaviors[ETH1] = { evmChainId: '0x1' }; // primary recovers
  const cached = await resolver.resolve(ETH);
  check('while cached, the fallback stays in use (session cache)', cached.url === ETH2 && calls.length === 2);
  behaviors[ETH2] = 'down'; // the fallback then fails a real request
  resolver.reportFailure(ETH.chainId, ETH2);
  const reprobed = await resolver.resolve(ETH);
  check('after a reported failure the re-probe picks the recovered primary', reprobed.url === ETH1 && reprobed.index === 0);
  check('re-probe went back to the top of the list', calls[2] === ETH1 && calls.length === 3);
  check('primary healthy -> no fallback note', describeDefaultFallbackNote(reprobed, ETH.defaultUrls) === null);
  check('primary in use -> tag says 1 of 2', describeDefaultChoice(reprobed) === 'default (1 of 2: ethereum-rpc.publicnode.com)');
}
{
  // Wrong-chain candidate skipped (never used), next healthy one chosen.
  const { fn } = fakeFetch({ [ETH1]: { evmChainId: '0xaa36a7' }, [ETH2]: { evmChainId: '0x1' } });
  const resolver = createDefaultEndpointResolver({ fetchFn: fn });
  const choice = await resolver.resolve(ETH);
  check('wrong-chain primary is skipped for the next healthy candidate', choice.url === ETH2 && choice.healthy);
  check('the wrong-chain reason is recorded', /expected 1/.test(choice.primaryFailure ?? ''), choice.primaryFailure);
}
{
  // Wrong-chain and unreachable only: the unreachable one is returned
  // (unhealthy) so requests fail visibly; the wrong-chain one never is.
  const { fn } = fakeFetch({ [ETH1]: { evmChainId: '0x5' }, [ETH2]: 'down' });
  const resolver = createDefaultEndpointResolver({ fetchFn: fn });
  const choice = await resolver.resolve(ETH);
  check('no healthy candidate -> first merely-unreachable one, flagged unhealthy', choice.url === ETH2 && !choice.healthy);
  check('a wrong-chain candidate is never returned', choice.url !== ETH1);
  const note = describeDefaultFallbackNote(choice, ETH.defaultUrls);
  check('all-down note says none answered', note !== null && /None of the 2 default endpoints/.test(note), note);
}
{
  // Every candidate wrong-chain -> null (nothing usable).
  const { fn } = fakeFetch({ [ETH1]: { evmChainId: '0x5' }, [ETH2]: { evmChainId: '0x89' } });
  const resolver = createDefaultEndpointResolver({ fetchFn: fn });
  const choice = await resolver.resolve(ETH);
  check('all candidates wrong-chain -> url null', choice.url === null && choice.index === -1 && !choice.healthy);
  check('null choice tag falls back to plain "default"', describeDefaultChoice(choice) === 'default');
}
{
  // Unhealthy results are cached only briefly, then re-probed.
  let clock = 1_000_000;
  const behaviors = { [ETH1]: 'down', [ETH2]: 'down' };
  const { fn, calls } = fakeFetch(behaviors);
  const resolver = createDefaultEndpointResolver({ fetchFn: fn, failureRetryMs: 10_000, now: () => clock });
  const first = await resolver.resolve(ETH);
  check('all down -> primary returned unhealthy', first.url === ETH1 && !first.healthy && calls.length === 2);
  clock += 5_000;
  await resolver.resolve(ETH);
  check('within the retry window the unhealthy result is reused', calls.length === 2);
  behaviors[ETH2] = { evmChainId: '0x1' };
  clock += 6_000;
  const later = await resolver.resolve(ETH);
  check('after the window it re-probes and finds the recovered candidate', later.url === ETH2 && later.healthy && calls.length === 4);
}
{
  // Hanging primary: abandoned after the timeout, fallback chosen.
  const { fn } = fakeFetch({ [ETH1]: 'hang', [ETH2]: { evmChainId: '0x1' } });
  const resolver = createDefaultEndpointResolver({ fetchFn: fn, timeoutMs: 50 });
  const started = Date.now();
  const choice = await resolver.resolve(ETH);
  check('hanging primary -> fallback chosen after the timeout', choice.url === ETH2 && Date.now() - started < 1000);
}
{
  // Concurrent resolutions share one probe pass.
  const { fn, calls } = fakeFetch({ [ETH1]: 'down', [ETH2]: { evmChainId: '0x1' } });
  const resolver = createDefaultEndpointResolver({ fetchFn: fn });
  const [a, b, c] = await Promise.all([resolver.resolve(ETH), resolver.resolve(ETH), resolver.resolve(ETH)]);
  check('three concurrent resolves -> one probe pass', a === b && b === c && calls.length === 2);
}
{
  // Mainnet and Sepolia choices are cached under different keys.
  const SEP = SEPOLIA_NETWORK.defaultUrls[0];
  const { fn } = fakeFetch({ [ETH1]: { evmChainId: '0x1' }, [SEP]: { evmChainId: '0xaa36a7' } });
  const resolver = createDefaultEndpointResolver({ fetchFn: fn });
  const main = await resolver.resolve(ETH);
  const sep = await resolver.resolve(SEPOLIA_NETWORK);
  check('mainnet and Sepolia resolve independently', main.url === ETH1 && sep.url === SEP);
  check(
    'Sepolia primary in use: tag says 1 of 4',
    describeDefaultChoice(sep) === 'default (1 of 4: ethereum-sepolia-rpc.publicnode.com)',
    describeDefaultChoice(sep),
  );
}
{
  // Sepolia ordering: primary down -> the second candidate (Pocket).
  const [SEP1, SEP2, SEP3, SEP4] = SEPOLIA_NETWORK.defaultUrls;
  const { fn, calls } = fakeFetch({
    [SEP1]: 'down',
    [SEP2]: { evmChainId: '0xaa36a7' },
    [SEP3]: { evmChainId: '0xaa36a7' },
    [SEP4]: { evmChainId: '0xaa36a7' },
  });
  const resolver = createDefaultEndpointResolver({ fetchFn: fn });
  const choice = await resolver.resolve(SEPOLIA_NETWORK);
  check('Sepolia: primary down -> second candidate chosen', choice.url === SEP2 && choice.index === 1 && choice.healthy);
  check('Sepolia: probing stopped at the first healthy candidate, in order', same(calls, [SEP1, SEP2]));
  check(
    'Sepolia: Settings tag names the Pocket fallback',
    describeDefaultChoice(choice) === 'default (2 of 4: eth-sepolia-testnet.api.pocket.network)',
    describeDefaultChoice(choice),
  );
  const note = describeDefaultFallbackNote(choice, SEPOLIA_NETWORK.defaultUrls);
  check('Sepolia: fallback note names the publicnode primary', note !== null && note.includes('ethereum-sepolia-rpc.publicnode.com'), note);
}
{
  // Sepolia wrong-chain refusal: a candidate answering with MAINNET's
  // chain id (0x1) is skipped and never used, even when it is the only
  // one that answers at all.
  const [SEP1, SEP2, SEP3, SEP4] = SEPOLIA_NETWORK.defaultUrls;
  {
    const { fn, calls } = fakeFetch({
      [SEP1]: { evmChainId: '0x1' },
      [SEP2]: { evmChainId: '0xaa36a7' },
      [SEP3]: { evmChainId: '0xaa36a7' },
      [SEP4]: { evmChainId: '0xaa36a7' },
    });
    const choice = await createDefaultEndpointResolver({ fetchFn: fn }).resolve(SEPOLIA_NETWORK);
    check('Sepolia: a primary answering 0x1 (mainnet) is skipped for the next candidate', choice.url === SEP2 && choice.healthy);
    check('Sepolia: the mainnet-answer reason is recorded', /identifies as 1, expected 11155111/.test(choice.primaryFailure ?? ''), choice.primaryFailure);
    check('Sepolia: only the first two candidates were probed', same(calls, [SEP1, SEP2]));
  }
  {
    const { fn, calls } = fakeFetch({
      [SEP1]: 'down',
      [SEP2]: { evmChainId: '0x1' },
      [SEP3]: 'hang',
      [SEP4]: { evmChainId: '0xaa36a7' },
    });
    const choice = await createDefaultEndpointResolver({ fetchFn: fn, timeoutMs: 50 }).resolve(SEPOLIA_NETWORK);
    check('Sepolia: down + mainnet-answering + hanging -> fourth candidate chosen', choice.url === SEP4 && choice.index === 3 && choice.healthy);
    check('Sepolia: all four probed strictly in order', same(calls, [SEP1, SEP2, SEP3, SEP4]));
    check('Sepolia: tag says 4 of 4: public.1rpc.io', describeDefaultChoice(choice) === 'default (4 of 4: public.1rpc.io)', describeDefaultChoice(choice));
  }
  {
    const { fn } = fakeFetch({
      [SEP1]: { evmChainId: '0x1' },
      [SEP2]: { evmChainId: '0x1' },
      [SEP3]: 'down',
      [SEP4]: { evmChainId: '0x1' },
    });
    const choice = await createDefaultEndpointResolver({ fetchFn: fn }).resolve(SEPOLIA_NETWORK);
    check(
      'Sepolia: only mainnet answers + one unreachable -> the unreachable one, flagged unhealthy',
      choice.url === SEP3 && !choice.healthy,
    );
    check('Sepolia: a mainnet-answering candidate is never returned', ![SEP1, SEP2, SEP4].includes(choice.url));
  }
  {
    const behaviors = Object.fromEntries(SEPOLIA_NETWORK.defaultUrls.map((u) => [u, { evmChainId: '0x1' }]));
    const choice = await createDefaultEndpointResolver({ fetchFn: fakeFetch(behaviors).fn }).resolve(SEPOLIA_NETWORK);
    check('Sepolia: every candidate answering mainnet -> url null', choice.url === null && !choice.healthy);
  }
  {
    // A reported failure on the Pocket fallback re-probes from the top.
    const behaviors = {
      [SEP1]: 'down',
      [SEP2]: { evmChainId: '0xaa36a7' },
      [SEP3]: { evmChainId: '0xaa36a7' },
      [SEP4]: { evmChainId: '0xaa36a7' },
    };
    const { fn, calls } = fakeFetch(behaviors);
    const resolver = createDefaultEndpointResolver({ fetchFn: fn });
    await resolver.resolve(SEPOLIA_NETWORK);
    behaviors[SEP2] = 'down';
    check('Sepolia: reportFailure drops the cached Pocket choice', resolver.reportFailure(SEPOLIA_NETWORK.chainId, SEP2) === true);
    const next = await resolver.resolve(SEPOLIA_NETWORK);
    check('Sepolia: re-probe falls through to the third candidate (0xRPC)', next.url === SEP3 && next.index === 2);
    check('Sepolia: the re-probe started again at the primary', same(calls, [SEP1, SEP2, SEP1, SEP2, SEP3]));
  }
}
{
  // Base Sepolia ordering and wrong-chain refusal (phase 10 item 3): a
  // candidate answering with ANOTHER TEST NETWORK's chain id is skipped and
  // never used; candidates are probed strictly in order.
  const [BS1, BS2, BS3] = BASE_SEPOLIA_NETWORK.defaultUrls;
  {
    const { fn, calls } = fakeFetch({
      [BS1]: { evmChainId: '0xaa36a7' },
      [BS2]: { evmChainId: '0x14a34' },
      [BS3]: { evmChainId: '0x14a34' },
    });
    const choice = await createDefaultEndpointResolver({ fetchFn: fn }).resolve(BASE_SEPOLIA_NETWORK);
    check('Base Sepolia: a primary answering Sepolia (0xaa36a7) is skipped for sepolia.base.org', choice.url === BS2 && choice.healthy && choice.index === 1);
    check('Base Sepolia: the Sepolia-answer reason is recorded', /identifies as 11155111, expected 84532/.test(choice.primaryFailure ?? ''), choice.primaryFailure);
    check('Base Sepolia: only the first two candidates were probed', same(calls, [BS1, BS2]));
    check('Base Sepolia: Settings tag names sepolia.base.org', describeDefaultChoice(choice) === 'default (2 of 3: sepolia.base.org)', describeDefaultChoice(choice));
  }
  {
    const { fn, calls } = fakeFetch({ [BS1]: 'down', [BS2]: 'hang', [BS3]: { evmChainId: '0x14a34' } });
    const choice = await createDefaultEndpointResolver({ fetchFn: fn, timeoutMs: 50 }).resolve(BASE_SEPOLIA_NETWORK);
    check('Base Sepolia: down + hanging -> third candidate (Pocket) chosen', choice.url === BS3 && choice.index === 2 && choice.healthy);
    check('Base Sepolia: all three probed strictly in order', same(calls, [BS1, BS2, BS3]));
  }
  {
    const { fn } = fakeFetch({ [BS1]: { evmChainId: '0xaa36a7' }, [BS2]: 'down', [BS3]: { evmChainId: '0x1' } });
    const choice = await createDefaultEndpointResolver({ fetchFn: fn }).resolve(BASE_SEPOLIA_NETWORK);
    check('Base Sepolia: only other chains answer + one unreachable -> the unreachable one, unhealthy', choice.url === BS2 && !choice.healthy);
  }
  {
    // One resolver, both test networks: choices are cached under separate keys.
    const behaviors = {
      [BS1]: { evmChainId: '0x14a34' },
      [SEPOLIA_NETWORK.defaultUrls[0]]: { evmChainId: '0xaa36a7' },
    };
    const resolver = createDefaultEndpointResolver({ fetchFn: fakeFetch(behaviors).fn });
    const b = await resolver.resolve(BASE_SEPOLIA_NETWORK);
    const sp = await resolver.resolve(SEPOLIA_NETWORK);
    check('Sepolia and Base Sepolia resolve independently', b.url === BS1 && sp.url === SEPOLIA_NETWORK.defaultUrls[0]);
    check('reportFailure on Base Sepolia leaves the Sepolia choice cached', resolver.reportFailure(BASE_SEPOLIA_NETWORK.chainId, BS1) === true && resolver.peek(SEPOLIA_NETWORK.chainId)?.url === SEPOLIA_NETWORK.defaultUrls[0] && resolver.peek(BASE_SEPOLIA_NETWORK.chainId) === undefined);
  }
}
{
  // Other chain kinds go through the same ordering.
  const [B1, B2] = BTC.defaultUrls;
  const [S1, S2, S3] = SOL.defaultUrls;
  const { fn } = fakeFetch({
    [B1]: 'http500',
    [B2]: { genesis: BTC_GENESIS },
    [S1]: { solGenesis: OTHER_SOL_GENESIS },
    [S2]: 'down',
    [S3]: { solGenesis: SOL_GENESIS },
  });
  const resolver = createDefaultEndpointResolver({ fetchFn: fn });
  const btc = await resolver.resolve(BTC);
  check('Bitcoin: blockstream down -> mempool.space chosen', btc.url === B2 && btc.healthy);
  const sol = await resolver.resolve(SOL);
  check('Solana: wrong-cluster + down skipped -> third candidate chosen', sol.url === S3 && sol.index === 2);
  check('Solana tag', describeDefaultChoice(sol) === 'default (3 of 3: solana.publicnode.com)');
}

// ---------------------------------------------------------------------------
// 4. Override always wins and is never probed around
// ---------------------------------------------------------------------------

console.log('override precedence:');

{
  const { fn, calls } = fakeFetch({ [ETH1]: 'down', [ETH2]: { evmChainId: '0x1' } });
  const resolver = createDefaultEndpointResolver({ fetchFn: fn });
  const custom = 'https://my-node.example/rpc';
  const resolved = await resolveNetworkUrl(ETH, custom, resolver);
  check('override is returned as is', resolved.url === custom && resolved.isOverride === true);
  check('override carries no defaultChoice', resolved.defaultChoice === undefined);
  check('override triggers zero probe requests', calls.length === 0);
  const fallback = await resolveNetworkUrl(ETH, undefined, resolver);
  check('without an override the default resolver is used', fallback.url === ETH2 && !fallback.isOverride && fallback.defaultChoice?.index === 1);
}
{
  const { fn, calls } = fakeFetch({});
  const resolver = createDefaultEndpointResolver({ fetchFn: fn });
  const doge = await resolveNetworkUrl(DOGE, undefined, resolver);
  check('empty default list -> null URL without probing', doge.url === null && !doge.isOverride && calls.length === 0);
}

check('endpointHost strips scheme and path', endpointHost('https://mempool.space/api') === 'mempool.space');

// ---------------------------------------------------------------------------
// 5. Optional LIVE pass (`node scripts/check-rpc-fallback.mjs --live`):
//    probes every shipped candidate with the real fetch through the exact
//    probe code. Informational per candidate (a public host can be down,
//    as ethereum-rpc.publicnode.com was on 2026-10-01); it fails only when
//    a chain has NO healthy candidate. Read-only requests only.
// ---------------------------------------------------------------------------

if (process.argv.includes('--live')) {
  console.log('\nlive candidate probes (read-only):');
  for (const network of [...DEFAULT_NETWORKS, ...TEST_EVM_NETWORKS]) {
    if (network.defaultUrls.length === 0) {
      console.log(`  ${network.label}: no defaults (by design)`);
      continue;
    }
    let healthy = 0;
    for (const url of network.defaultUrls) {
      const result = await probeEndpoint(network.kind, url, network.chainId);
      if (result.ok) healthy += 1;
      console.log(`  ${network.label.padEnd(17)} ${url.padEnd(45)} ${result.ok ? `healthy (freshness ${result.freshness}${result.freshnessDetail ? `: ${result.freshnessDetail}` : ''})` : `${result.kind}: ${result.reason}`}`);
    }
    check(`${network.label}: at least one live default is healthy`, healthy > 0);
  }

  // Test-network detail (Sepolia, and Base Sepolia since phase 10 item 3):
  // every candidate must identify as its own chain when it answers (never
  // as another chain), healthy candidates must be near the freshest head,
  // and eth_simulateV1 support is recorded. The expected simulation status
  // is what evm-chain.ts documents (Sepolia 2026-10-02, Base Sepolia
  // 2026-10-03); a difference is printed as a note rather than failing,
  // because a provider can change its method list at any time. Base
  // Sepolia makes a block every 2 s, so its head tolerance is wider.
  const EXPECTED_SIMULATE = {
    'https://ethereum-sepolia-rpc.publicnode.com': 'supported',
    'https://eth-sepolia-testnet.api.pocket.network': 'supported',
    'https://0xrpc.io/sep': 'supported',
    'https://public.1rpc.io/sepolia': 'intermittent',
    'https://base-sepolia-rpc.publicnode.com': 'supported',
    'https://sepolia.base.org': 'supported',
    'https://base-sepolia-testnet.api.pocket.network': 'supported',
    // Probed 2026-10-04 (phase 14 item 3): all three returned the ETH
    // pseudo-Transfer log with traceTransfers.
    'https://arbitrum-sepolia-rpc.publicnode.com': 'supported',
    'https://sepolia-rollup.arbitrum.io/rpc': 'supported',
    'https://arb-sepolia-testnet.api.pocket.network': 'supported',
  };
  const liveRpc = async (url, method, params = []) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return { status: response.status, error: `non-JSON body (HTTP ${response.status})` };
      }
      if (body.error) return { status: response.status, error: `${body.error.code}: ${body.error.message}` };
      return { status: response.status, result: body.result };
    } catch (e) {
      return { status: 0, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  };
  for (const [network, headTolerance] of [[SEPOLIA_NETWORK, 5n], [BASE_SEPOLIA_NETWORK, 15n], [ARBITRUM_SEPOLIA_NETWORK, 240n]]) {
    console.log(`\nlive ${network.label} candidate detail (read-only):`);
    check(
      `every ${network.label} candidate has a documented eth_simulateV1 status`,
      network.defaultUrls.every((u) => EXPECTED_SIMULATE[u] !== undefined),
    );
    const heads = new Map();
    for (const url of network.defaultUrls) {
      const probe = await probeEndpoint('evm-jsonrpc', url, network.chainId);
      check(`${network.label} ${endpointHost(url)}: never answers as another chain`, probe.ok || probe.kind !== 'wrong-chain', JSON.stringify(probe));
      if (!probe.ok) {
        // A stale candidate (finding F-66) is skipped by the app, so it is
        // left out of the head comparison below as well.
        console.log(`  ${endpointHost(url).padEnd(40)} ${probe.kind}: ${probe.reason}`);
        continue;
      }
      const head = await liveRpc(url, 'eth_blockNumber');
      if (typeof head.result === 'string') heads.set(url, BigInt(head.result));
      // The same shape wallet/simulation.ts sends: one plain ETH transfer
      // with traceTransfers, so a supporting node returns the ETH
      // pseudo-Transfer log from 0xeeee...eeee.
      const sim = await liveRpc(url, 'eth_simulateV1', [
        {
          blockStateCalls: [
            {
              calls: [
                {
                  from: '0x0000000000000000000000000000000000000001',
                  to: '0x000000000000000000000000000000000000dEaD',
                  value: '0x1',
                },
              ],
            },
          ],
          traceTransfers: true,
        },
        'latest',
      ]);
      let simStatus;
      if (Array.isArray(sim.result)) {
        const logs = sim.result[0]?.calls?.[0]?.logs ?? [];
        const traced = logs.some((l) => String(l.address).toLowerCase() === '0x' + 'e'.repeat(40));
        simStatus = traced ? 'supported' : 'answered without the traceTransfers log';
      } else if (sim.status === 429 || /rate limit/i.test(sim.error ?? '')) {
        simStatus = `rate-limited (${sim.error})`;
      } else {
        simStatus = `unsupported or failed (${sim.error})`;
      }
      const expected = EXPECTED_SIMULATE[url];
      // 'intermittent' means any outcome is consistent with the documentation.
      const matches = expected === 'intermittent' || (expected !== undefined && simStatus.startsWith(expected));
      console.log(
        `  ${endpointHost(url).padEnd(40)} head ${head.result ?? head.error}  eth_simulateV1: ${simStatus}` +
          (matches ? '' : `  [note: documented as "${expected}"]`),
      );
    }
    if (heads.size > 0) {
      const freshest = [...heads.values()].reduce((a, b) => (a > b ? a : b));
      for (const [url, head] of heads) {
        const lag = freshest - head;
        check(`${network.label} ${endpointHost(url)}: head within ${headTolerance} blocks of the freshest candidate`, lag <= headTolerance, `${lag} blocks behind`);
      }
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

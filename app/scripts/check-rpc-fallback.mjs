// Default-endpoint fallback checks, entirely OFFLINE: the ordered default
// candidate lists (src/config/defaults.ts, src/config/evm-chain.ts) and the
// probe/resolver that picks among them (src/config/endpoint-probe.ts), run
// against a fake fetch. No network request leaves the process.
//
// Covered: first candidate down -> second used; a wrong-chain candidate is
// skipped and never used, not even as a last resort; a user override
// bypasses probing entirely; the choice is cached in memory, and a reported
// request failure drops it so the next resolution re-probes from the top
// (a recovered primary takes over again); a hanging candidate is abandoned
// after the probe timeout; concurrent resolutions share one probe pass.
//
// Like check-devmode.mjs, it imports the actual TypeScript modules the app
// runs via Node's native type stripping. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-rpc-fallback.mjs           # offline only
//   node scripts/check-rpc-fallback.mjs --live    # plus live candidate probes

import { EVM_MAINNET, EVM_SEPOLIA } from '../src/config/evm-chain.ts';
import { DEFAULT_NETWORKS, SEPOLIA_NETWORK, networkDefaultFor } from '../src/config/defaults.ts';
import {
  createDefaultEndpointResolver,
  describeDefaultChoice,
  describeDefaultFallbackNote,
  endpointHost,
  probeEndpoint,
  resolveNetworkUrl,
} from '../src/config/endpoint-probe.ts';

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
 * behaviors: { [baseUrl]: 'down' | 'hang' | 'http500' | 'rpc-error' | 'malformed' | { evmChainId } | { genesis } | { solGenesis } }
 */
function fakeFetch(behaviors) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push(url);
    const base = Object.keys(behaviors).find((b) => url === b || url.startsWith(`${b}/`));
    const behavior = base ? behaviors[base] : 'down';
    if (behavior === 'down') throw new TypeError('fetch failed (simulated TLS failure)');
    if (behavior === 'hang') return new Promise(() => {});
    if (behavior === 'http500') return { ok: false, status: 500, text: async () => 'oops' };
    const body = init.body ? JSON.parse(init.body) : null;
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (behavior === 'rpc-error') {
      return json({ jsonrpc: '2.0', id: body?.id ?? 1, error: { code: -32603, message: 'internal' } });
    }
    if (behavior === 'malformed') return json({ jsonrpc: '2.0', id: 1, result: 42 });
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
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// 1. Candidate lists (pinned; every entry live-verified 2026-10-01 per the
//    comments in defaults.ts / evm-chain.ts)
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
  'Sepolia EVM: ethereum-sepolia-rpc.publicnode.com only',
  same(EVM_SEPOLIA.defaultRpcUrls, ['https://ethereum-sepolia-rpc.publicnode.com']),
);
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
{
  const all = [...DEFAULT_NETWORKS, SEPOLIA_NETWORK];
  check(
    'every defaultUrl equals defaultUrls[0] (or null when empty)',
    all.every((n) => n.defaultUrl === (n.defaultUrls[0] ?? null)),
  );
  check(
    'profile defaultRpcUrl equals defaultRpcUrls[0]',
    EVM_MAINNET.defaultRpcUrl === EVM_MAINNET.defaultRpcUrls[0] &&
      EVM_SEPOLIA.defaultRpcUrl === EVM_SEPOLIA.defaultRpcUrls[0],
  );
  const urls = all.flatMap((n) => n.defaultUrls);
  check('every candidate is https:// with no trailing slash', urls.every((u) => /^https:\/\/[^\s]+[^/]$/.test(u)));
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
  check('Sepolia single candidate: tag says 1 of 1', describeDefaultChoice(sep) === 'default (1 of 1: ethereum-sepolia-rpc.publicnode.com)');
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
  for (const network of [...DEFAULT_NETWORKS, SEPOLIA_NETWORK]) {
    if (network.defaultUrls.length === 0) {
      console.log(`  ${network.label}: no defaults (by design)`);
      continue;
    }
    let healthy = 0;
    for (const url of network.defaultUrls) {
      const result = await probeEndpoint(network.kind, url, network.chainId);
      if (result.ok) healthy += 1;
      console.log(`  ${network.label.padEnd(17)} ${url.padEnd(45)} ${result.ok ? 'healthy' : `${result.kind}: ${result.reason}`}`);
    }
    check(`${network.label}: at least one live default is healthy`, healthy > 0);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

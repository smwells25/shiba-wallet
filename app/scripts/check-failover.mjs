// Mid-session endpoint failover checks (phase 9 item 5), entirely OFFLINE:
// every request goes to a fake fetch installed on globalThis, so nothing
// leaves the process.
//
// Covered:
//  - the pure rule (src/config/endpoint-probe.ts runWithEndpointFailover):
//    a failing DEFAULT endpoint is reported and the operation repeated ONCE
//    on the next healthy candidate; overrides are never probed around or
//    reported; answers (reverts, insufficient funds, archive refusals) are
//    not failures; no retry onto the same URL, an unhealthy candidate, an
//    override or another network; never a third attempt;
//  - the error classifier isEndpointFailure;
//  - the app's real call paths through the app's real resolver
//    (src/config/networks.ts): native balances (useBalances.ts
//    loadNativeBalance), history (useHistory.ts loadHistoryPage, Esplora and
//    the tracked-token logs fallback), an EVM send quote (prepareEvmSend via
//    callWithFailover) that comes ENTIRELY from the second candidate, and
//    the swap allowance poll that follows the healthy endpoint;
//  - quote pinning (send.ts quoteEndpointChange): a quote whose endpoint is
//    no longer the one in use is refused with a plain sentence;
//  - the balance-change preview stays on the quote's endpoint and only
//    reports its failure (simulation.ts onEndpointFailure);
//  - (follow-ups) Home token rows (useTokenBalances.ts loadTokenBalance)
//    fail over like the native row; the Upgrade screen's set-code quote
//    carries its endpoint and is refused through any other one
//    (delegation.ts prepareSetCodeTx / sendSetCodeTx + the screen's pin
//    check before the biometric gate); WalletConnect eth_sendTransaction
//    quotes fail over and, when the endpoint moved before approval, are
//    re-quoted on the new endpoint (walletconnect.ts quoteWcTransaction /
//    requoteWcTransactionIfMoved) whose eth_call gate and preview then run
//    there.
//
// Like check-rpc-fallback.mjs it imports the actual TypeScript modules via
// Node's native type stripping. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-failover.mjs

import { DEFAULT_NETWORKS } from '../src/config/defaults.ts';
import {
  NO_ANSWER_SENTENCE,
  describeNetworkFailure,
  isEndpointFailure,
  runWithEndpointFailover,
  sanitizeEndpointMessage,
} from '../src/config/endpoint-probe.ts';
import {
  NoEndpointError,
  callWithFailover,
  forgetDefaultEndpointChoices,
  getEndpoint,
  reportEndpointFailure,
  withEndpoint,
} from '../src/config/networks.ts';
import { loadNativeBalance } from '../src/wallet/useBalances.ts';
import { loadHistoryPage } from '../src/wallet/useHistory.ts';
import { describeEndpointHttpAnswer, describeSendError, prepareEvmSend, quoteEndpointChange } from '../src/wallet/send.ts';
import { isRetryableFeeReadError, suggestFeesRetryingOnce } from '../src/wallet/fee-read.ts';
import { QUOTE_FAILED_TITLE, retitleQuoteFailure } from '../src/wallet/aa.ts';
import { waitForAllowance } from '../src/wallet/swap.ts';
import { runBalancePreview } from '../src/wallet/simulation.ts';
import { loadTokenBalance } from '../src/wallet/useTokenBalances.ts';
import { WALLET_7702_DELEGATE, prepareSetCodeTx, sendSetCodeTx } from '../src/wallet/delegation.ts';
import {
  WC_REQUOTED_NOTE,
  quoteWcTransaction,
  requoteWcTransactionIfMoved,
} from '../src/wallet/walletconnect.ts';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

const ETH_CHAIN = 'eip155:1';
const BTC_CHAIN = 'bip122:000000000019d6689c085ae165831e93';
const DOGE_CHAIN = 'bip122:1a91e3dace36e2be3bf030a65679fe82';
const ETH = DEFAULT_NETWORKS.find((n) => n.chainId === ETH_CHAIN);
const BTC = DEFAULT_NETWORKS.find((n) => n.chainId === BTC_CHAIN);
const [ETH_A, ETH_B] = ETH.defaultUrls;
const [BTC_A, BTC_B] = BTC.defaultUrls;
const BTC_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const WALLET = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const BTC_ADDRESS = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

check('mainnet ETH has two default candidates to fail over between', ETH_A && ETH_B && ETH_A !== ETH_B);
check('Bitcoin has two default candidates to fail over between', BTC_A && BTC_B && BTC_A !== BTC_B);

// ---------------------------------------------------------------------------
// 1. The pure rule
// ---------------------------------------------------------------------------

console.log('runWithEndpointFailover (pure rule):');

const choice = (url, healthy = true) => ({ url, index: 0, total: 2, healthy, primaryUnreachable: false });
const target = (url, extra = {}) => ({
  url,
  isOverride: false,
  defaultChoice: choice(url),
  network: { chainId: ETH_CHAIN },
  ...extra,
});
const netFail = () => new TypeError('Network request failed');

function harness(next) {
  const log = { reports: [], reResolves: 0, attempts: [] };
  const deps = {
    report: (chainId, url) => {
      log.reports.push(`${chainId} ${url}`);
      return true;
    },
    reResolve: async () => {
      log.reResolves += 1;
      return next;
    },
  };
  return { log, deps };
}

{
  const { log, deps } = harness(target('https://b.example'));
  const outcome = await runWithEndpointFailover(
    target('https://a.example'),
    async (ep) => {
      log.attempts.push(ep.url);
      if (ep.url === 'https://a.example') throw netFail();
      return `answer from ${ep.url}`;
    },
    deps,
  );
  check('a failing default is reported once', log.reports.length === 1 && log.reports[0] === `${ETH_CHAIN} https://a.example`, log.reports);
  check('the operation is repeated on the next healthy candidate', log.attempts.join(',') === 'https://a.example,https://b.example');
  check('the outcome is the second candidate\'s answer', outcome.value === 'answer from https://b.example');
  check('the outcome names the endpoint that answered', outcome.endpoint.url === 'https://b.example' && outcome.switched === true);
}

{
  const { log, deps } = harness(target('https://b.example'));
  const error = await rejects(
    runWithEndpointFailover(
      target('https://a.example'),
      async (ep) => {
        log.attempts.push(ep.url);
        throw new TypeError(`fetch failed (${ep.url})`);
      },
      deps,
    ),
  );
  check('retry ONCE only: two attempts when both candidates fail', log.attempts.length === 2, log.attempts);
  check('the retry\'s own error is surfaced', error instanceof TypeError && error.message.includes('b.example'));
  check('the second failure is reported too (next call re-probes)', log.reports.length === 2);
}

{
  const { log, deps } = harness(target('https://b.example'));
  const error = await rejects(
    runWithEndpointFailover(
      target('https://my-node.example', { isOverride: true, defaultChoice: undefined }),
      async (ep) => {
        log.attempts.push(ep.url);
        throw netFail();
      },
      deps,
    ),
  );
  check('override: the original error surfaces', error instanceof TypeError);
  check('override: never reported and never re-resolved (no probing around it)', log.reports.length === 0 && log.reResolves === 0);
  check('override: one attempt only', log.attempts.length === 1);
}

{
  const { log, deps } = harness(target('https://b.example'));
  const answer = new Error('Insufficient funds: sending 5 wei plus a worst-case fee of 1 wei exceeds the balance of 0 wei');
  const error = await rejects(
    runWithEndpointFailover(target('https://a.example'), async () => {
      throw answer;
    }, deps),
  );
  check('an answer (insufficient funds) is not a failure: surfaced unchanged', error === answer);
  check('an answer is never reported', log.reports.length === 0 && log.reResolves === 0);
}

for (const [label, next] of [
  ['the same URL', target('https://a.example')],
  ['an unhealthy candidate', target('https://b.example', { defaultChoice: choice('https://b.example', false) })],
  ['an override', target('https://b.example', { isOverride: true })],
  ['another network (mode flipped)', target('https://b.example', { network: { chainId: 'eip155:11155111' } })],
  ['nothing', undefined],
]) {
  const { log, deps } = harness(next);
  const first = netFail();
  const error = await rejects(
    runWithEndpointFailover(target('https://a.example'), async (ep) => {
      log.attempts.push(ep.url);
      throw first;
    }, deps),
  );
  check(`no retry when re-resolution yields ${label}`, error === first && log.attempts.length === 1, log.attempts);
}

console.log('\nisEndpointFailure (classifier):');
const abort = new Error('The operation was aborted');
abort.name = 'AbortError';
const rateLimited = new Error('limit exceeded');
rateLimited.code = -32005;
for (const [label, error, expected] of [
  ['React Native fetch failure', new TypeError('Network request failed'), true],
  ['Node fetch failure', new TypeError('fetch failed'), true],
  ['abort', abort, true],
  ['timeout wording', new Error('no answer within 4000 ms (timed out)'), true],
  ['HTML instead of JSON', new SyntaxError('Unexpected token < in JSON'), true],
  ['engine HTTP 503', new Error('RPC HTTP error 503 for eth_getBalance'), true],
  ['engine HTTP 429', new Error('RPC HTTP error 429 for eth_call'), true],
  ['Esplora HTTP 502', new Error('UTXO fetch failed: HTTP 502 for bc1q…'), true],
  ['JSON-RPC rate limit code', rateLimited, true],
  ['JSON-RPC rate limit text', new Error('RPC error -32005: daily request count exceeded (eth_call)'), true],
  ['HTTP 400 (an answer)', new Error('RPC HTTP error 400 for eth_simulateV1'), false],
  ['archive refusal (a depth answer)', new Error('RPC error -32602: Archive requests require a personal token (eth_getLogs)'), false],
  ['revert', new Error('RPC error 3: execution reverted (eth_estimateGas)'), false],
  ['insufficient funds', new Error('Insufficient funds: …'), false],
  ['a TypeError that is a bug, not the network', new TypeError("Cannot read properties of undefined (reading 'x')"), false],
  ['null', null, false],
  ['a string', 'fetch failed', false],
]) {
  check(`${label} -> ${expected}`, isEndpointFailure(error) === expected);
}

// ---------------------------------------------------------------------------
// 2. The app's call paths through the app's resolver (networks.ts)
// ---------------------------------------------------------------------------

/**
 * Fake network. `rpc[base]` decides each JSON-RPC answer for an EVM base URL
 * (return a value, or throw to simulate a dead endpoint); `rest[base]` the
 * same for Esplora paths. Every request is recorded.
 *
 * `probe` marks the endpoint probe's own requests (endpoint-probe.ts): its
 * eth_chainId, and the eth_getBlockByNumber freshness read the probe sends
 * right after a correct chain id. The freshness read is the next request to
 * the same URL after its eth_chainId; that is how it is told apart from a
 * fee read with the same parameters.
 */
function installFake({ rpc = {}, rest = {} }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const method = body?.method ?? init.method ?? 'GET';
    const previous = calls.findLast((c) => c.url === url);
    const probe =
      method === 'eth_chainId' ||
      (method === 'eth_getBlockByNumber' && previous?.url === url && previous?.method === 'eth_chainId');
    calls.push({ url, method, probe });
    const rpcBase = Object.keys(rpc).find((b) => url === b);
    if (rpcBase) {
      const result = rpc[rpcBase](body.method, body.params);
      const text = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    }
    const restBase = Object.keys(rest).find((b) => url.startsWith(`${b}/`));
    if (restBase) {
      const result = rest[restBase](url.slice(restBase.length));
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    }
    throw new TypeError(`fetch failed (no fake for ${url})`);
  };
  return calls;
}

/** A healthy mainnet node; `overrides` replaces individual methods. */
function evmNode(overrides = {}) {
  return (method, params) => {
    if (method in overrides) return overrides[method](params);
    switch (method) {
      case 'eth_chainId':
        return '0x1';
      case 'eth_getBalance':
        return '0xde0b6b3a7640000'; // 1 ETH
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_blockNumber':
        return '0x1000000';
      case 'eth_getBlockByNumber':
        // timestamp: the probe's freshness check reads it (a block made now).
        return { baseFeePerGas: '0x3b9aca00', number: '0x1000000', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` };
      case 'eth_maxPriorityFeePerGas':
        return '0x5f5e100';
      case 'eth_estimateGas':
        return '0x5208';
      case 'eth_call':
        return '0x';
      case 'eth_getLogs':
        return [];
      default:
        throw new Error(`fake node: unexpected ${method}`);
    }
  };
}
const dead = () => {
  throw new TypeError('fetch failed (simulated dead endpoint)');
};

/**
 * Primary answers the endpoint probe once (its eth_chainId and the
 * freshness read sent right after it), then dies for everything.
 */
function dyingPrimary(overrides = {}) {
  let alive = true;
  let probing = false;
  const node = evmNode(overrides);
  return {
    kill: () => {
      alive = false;
    },
    handler: (method, params) => {
      if (!alive) dead();
      if (method === 'eth_chainId') {
        probing = true;
        return node(method, params);
      }
      if (probing && method === 'eth_getBlockByNumber') {
        probing = false;
        return node(method, params);
      }
      alive = false; // the first real request finds it dead
      return dead();
    },
  };
}

console.log('\nNative balance (useBalances.ts loadNativeBalance):');
{
  forgetDefaultEndpointChoices();
  const primary = dyingPrimary();
  const calls = installFake({
    rpc: { [ETH_A]: primary.handler, [ETH_B]: evmNode({ eth_getBalance: () => '0x2a' }) },
  });
  const load = await loadNativeBalance(ETH_CHAIN, WALLET, { retryDelayMs: 0 });
  check('balance loads although the chosen default died mid-session', load.status === 'ok', load);
  check('the amount is the second candidate\'s answer', load.status === 'ok' && load.amount === 42n);
  check('the result names the endpoint that answered', load.status === 'ok' && load.endpoint.url === ETH_B);
  const balanceCalls = calls.filter((c) => c.method === 'eth_getBalance').map((c) => c.url);
  check(
    'requests: primary (its own one-off retry included), then exactly one more endpoint',
    balanceCalls.filter((u) => u === ETH_A).length >= 1 && balanceCalls.filter((u) => u === ETH_B).length === 1,
    balanceCalls,
  );
  const now = await getEndpoint(ETH_CHAIN);
  check('the wallet now uses the healthy candidate for later calls', now?.url === ETH_B);
}
{
  forgetDefaultEndpointChoices();
  installFake({ rpc: { [ETH_A]: (m) => (m === 'eth_chainId' ? '0x1' : dead()), [ETH_B]: (m) => (m === 'eth_chainId' ? '0x1' : dead()) } });
  const error = await rejects(loadNativeBalance(ETH_CHAIN, WALLET, { retryDelayMs: 0 }));
  check('both candidates failing: a retryable error surfaces (no endless loop)', isEndpointFailure(error), error);
}

console.log('\nHistory (useHistory.ts loadHistoryPage):');
{
  forgetDefaultEndpointChoices();
  let primaryAlive = true;
  const calls = installFake({
    rest: {
      [BTC_A]: (path) => {
        if (path === '/block-height/0' && primaryAlive) return BTC_GENESIS;
        primaryAlive = false;
        throw new TypeError('Network request failed');
      },
      [BTC_B]: (path) => (path === '/block-height/0' ? BTC_GENESIS : []),
    },
  });
  const load = await loadHistoryPage(BTC_CHAIN, BTC_ADDRESS);
  check('Bitcoin history loads after the chosen default died', load.status === 'ok', load);
  check(
    'the page came from the second candidate',
    calls.some((c) => c.url === `${BTC_B}/address/${BTC_ADDRESS}/txs`),
    calls.map((c) => c.url),
  );
}
{
  // EVM without an indexer + tracked tokens (the default USDC) = the
  // tracked-token logs fallback over the node endpoint.
  forgetDefaultEndpointChoices();
  const primary = dyingPrimary();
  const calls = installFake({ rpc: { [ETH_A]: primary.handler, [ETH_B]: evmNode() } });
  const load = await loadHistoryPage(ETH_CHAIN, WALLET);
  check('logs-fallback history loads after the chosen default died', load.status === 'ok', load);
  check(
    'eth_blockNumber and eth_getLogs were answered by the second candidate',
    calls.some((c) => c.url === ETH_B && c.method === 'eth_blockNumber') &&
      calls.some((c) => c.url === ETH_B && c.method === 'eth_getLogs'),
  );
  check('the logs-fallback note is kept', load.status === 'ok' && typeof load.note === 'string' && load.note.length > 0);
}

console.log('\nSend quote (prepareEvmSend through callWithFailover):');
let quotedOn = null;
{
  forgetDefaultEndpointChoices();
  // The primary answers the probe AND the balance, then fails the nonce
  // read: a half-answered quote that must be thrown away, not patched.
  let alive = true;
  const primaryNode = evmNode({ eth_getBalance: () => '0x1111' });
  const calls = installFake({
    rpc: {
      [ETH_A]: (method, params) => {
        if (!alive) dead();
        if (method === 'eth_getTransactionCount') {
          alive = false;
          dead();
        }
        return primaryNode(method, params);
      },
      [ETH_B]: evmNode({ eth_getBalance: () => '0xde0b6b3a7640000', eth_getTransactionCount: () => '0x9' }),
    },
  });
  const start = await getEndpoint(ETH_CHAIN);
  check('the screen starts on the primary', start?.url === ETH_A);
  const outcome = await callWithFailover({ ...start, url: start.url }, (ep) =>
    prepareEvmSend(ep.url, WALLET, RECIPIENT, 1000n),
  );
  const quote = outcome.value;
  quotedOn = outcome.endpoint.url;
  check('the quote is prepared on the second candidate', outcome.switched && quotedOn === ETH_B);
  check('balance comes from the second candidate (nothing from the failed attempt)', quote.balance === 10n ** 18n);
  check('nonce comes from the second candidate', quote.nonce === 9n);
  check('the primary\'s half answer (balance 0x1111) is not in the quote', quote.balance !== 0x1111n);
  check('the pre-flight simulation ran on the second candidate', calls.some((c) => c.url === ETH_B && c.method === 'eth_call'));

  console.log('\nQuote pinning (send.ts quoteEndpointChange):');
  const current = await getEndpoint(ETH_CHAIN);
  check('same endpoint at send time -> no refusal', quoteEndpointChange(quotedOn, current?.url) === null);
  const refusal = quoteEndpointChange(ETH_A, current?.url);
  check(
    'a quote from another endpoint is refused, naming both hosts',
    typeof refusal === 'string' && refusal.includes('ethereum-rpc.publicnode.com') && refusal.includes('ethereum.publicnode.com'),
    refusal,
  );
  check('the refusal says nothing was signed or sent and asks for a fresh quote', /Nothing was signed or sent/.test(refusal) && /fresh quote/.test(refusal));
  check('no endpoint at send time is refused too', /use no endpoint at all/.test(quoteEndpointChange(ETH_B, null) ?? ''));
  check('the refusal never prints a full URL (overrides can embed keys)', !refusal.includes('https://'));
}
{
  // A quote made on the primary; meanwhile another screen's request fails
  // and the wallet moves to the fallback: the old quote must be refused.
  forgetDefaultEndpointChoices();
  const primary = dyingPrimary();
  installFake({ rpc: { [ETH_A]: primary.handler, [ETH_B]: evmNode() } });
  const atQuote = await getEndpoint(ETH_CHAIN);
  primary.kill();
  reportEndpointFailure(ETH_CHAIN, atQuote.url);
  const atSend = await getEndpoint(ETH_CHAIN);
  check('after a failover elsewhere the wallet uses the fallback', atSend?.url === ETH_B);
  check('the stale quote is refused at send time', quoteEndpointChange(atQuote.url, atSend?.url) !== null);
}

console.log('\nOverrides through the app path (never probed around):');
{
  forgetDefaultEndpointChoices();
  const calls = installFake({ rpc: { [ETH_A]: evmNode(), [ETH_B]: evmNode() } });
  const override = {
    forChainId: ETH_CHAIN,
    network: ETH,
    url: 'https://my-own-node.example/rpc',
    isOverride: true,
  };
  const error = await rejects(
    callWithFailover(override, (ep) => prepareEvmSend(ep.url, WALLET, RECIPIENT, 1n)),
  );
  check('an override that fails surfaces its error', isEndpointFailure(error), error);
  check(
    'no default candidate was contacted (no probe, no retry elsewhere)',
    calls.every((c) => c.url.startsWith('https://my-own-node.example')),
    calls.map((c) => c.url),
  );
}

console.log('\nwithEndpoint without a URL:');
{
  forgetDefaultEndpointChoices();
  installFake({});
  const error = await rejects(withEndpoint(DOGE_CHAIN, async () => 'never'));
  check('a chain with no endpoint throws NoEndpointError (shown as "not configured")', error instanceof NoEndpointError, error);
}

console.log('\nSwap allowance poll (swap.ts waitForAllowance with a resolving URL):');
{
  forgetDefaultEndpointChoices();
  const primary = dyingPrimary();
  const allowance = `0x${(5000n).toString(16).padStart(64, '0')}`;
  const calls = installFake({ rpc: { [ETH_A]: primary.handler, [ETH_B]: evmNode({ eth_call: () => allowance }) } });
  const reported = [];
  const ok = await waitForAllowance(
    async () => (await getEndpoint(ETH_CHAIN)).url,
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    WALLET,
    RECIPIENT,
    5000n,
    {
      timeoutMs: 5_000,
      pollMs: 1,
      sleepFn: async () => {},
      onPollError: (_e, url) => {
        if (url) {
          reported.push(url);
          reportEndpointFailure(ETH_CHAIN, url);
        }
      },
    },
  );
  check('the poll confirms through the healthy candidate', ok === true);
  check('the dead endpoint\'s failed poll was reported', reported.length === 1 && reported[0] === ETH_A, reported);
  check('the confirming read went to the second candidate', calls.some((c) => c.url === ETH_B && c.method === 'eth_call'));
}

console.log('\nBalance-change preview stays on the quote\'s endpoint:');
{
  const calls = installFake({});
  const reported = [];
  const state = await runBalancePreview({
    url: ETH_A,
    wallet: WALLET,
    calls: [{ from: WALLET, to: RECIPIENT, value: 1n }],
    chainCaip2: ETH_CHAIN,
    trackedTokens: [],
    onEndpointFailure: (url) => reported.push(url),
  });
  check('an unreachable endpoint gives the calm "unreachable" error state', state.status === 'error' && state.unreachable === true, state);
  check('its failure is reported with the quote\'s URL', reported.length === 1 && reported[0] === ETH_A);
  check('the preview never tried another endpoint', calls.every((c) => c.url === ETH_A));
}
{
  installFake({
    rpc: {
      [ETH_A]: () => {
        throw new Error('fake node: something unexpected');
      },
    },
  });
  // The fake throws inside the handler, which surfaces as a rejected fetch
  // with a plain Error: not a transport failure.
  const reported = [];
  const state = await runBalancePreview({
    url: ETH_A,
    wallet: WALLET,
    calls: [{ from: WALLET, to: RECIPIENT, value: 1n }],
    chainCaip2: ETH_CHAIN,
    trackedTokens: [],
    onEndpointFailure: (url) => reported.push(url),
  });
  check('other preview errors are not reported as endpoint failures', state.status === 'error' && !state.unreachable && reported.length === 0, state);
}

// ---------------------------------------------------------------------------
// 3. Follow-ups: token rows, the Upgrade screen, WalletConnect quotes
// ---------------------------------------------------------------------------

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const word = (n) => `0x${n.toString(16).padStart(64, '0')}`;

console.log('\nToken balance (useTokenBalances.ts loadTokenBalance):');
{
  forgetDefaultEndpointChoices();
  const primary = dyingPrimary();
  const calls = installFake({
    rpc: { [ETH_A]: primary.handler, [ETH_B]: evmNode({ eth_call: () => word(1_234_567n) }) },
  });
  const load = await loadTokenBalance(USDC, WALLET, { retryDelayMs: 0 }).catch((error) => ({ status: 'threw', error }));
  check('token balance loads although the chosen default died mid-session', load.status === 'ok', load);
  check('the amount is the second candidate\'s balanceOf answer', load.status === 'ok' && load.amount === 1_234_567n);
  check('the result names the endpoint that answered', load.status === 'ok' && load.endpoint.url === ETH_B);
  check(
    'the row\'s network is the answering endpoint\'s network',
    load.status === 'ok' && load.endpoint.network.chainId === ETH_CHAIN,
  );
  check(
    'the balanceOf call reached the second candidate exactly once',
    calls.filter((c) => c.url === ETH_B && c.method === 'eth_call').length === 1,
  );
  check('the dead default was reported (the wallet now uses the fallback)', (await getEndpoint(ETH_CHAIN))?.url === ETH_B);
}
{
  forgetDefaultEndpointChoices();
  installFake({ rpc: { [ETH_A]: (m) => (m === 'eth_chainId' ? '0x1' : dead()), [ETH_B]: (m) => (m === 'eth_chainId' ? '0x1' : dead()) } });
  const error = await rejects(loadTokenBalance(USDC, WALLET, { retryDelayMs: 0 }));
  check('token row: both candidates failing surfaces a retryable error (no loop)', isEndpointFailure(error), error);
}
{
  // An answer (a revert from balanceOf) is not a transport failure: no
  // switch, the row shows the error for its own retry button.
  forgetDefaultEndpointChoices();
  const calls = installFake({
    rpc: {
      [ETH_A]: evmNode({
        eth_call: () => {
          throw new Error('fake node: execution reverted');
        },
      }),
      [ETH_B]: evmNode(),
    },
  });
  const error = await rejects(loadTokenBalance(USDC, WALLET, { retryDelayMs: 0 }));
  check('token row: a non-transport error is surfaced, not failed over', error !== null && !calls.some((c) => c.url === ETH_B && c.method === 'eth_call'));
}

{
  // Phase 13 item 1: a token is only ever read on its own chain. The
  // mainnet endpoint answers; a Sepolia token row gets an "unavailable"
  // state with NO balanceOf call, and the control (expectedChain = the
  // endpoint's chain) reads normally.
  forgetDefaultEndpointChoices();
  const calls = installFake({ rpc: { [ETH_A]: evmNode({ eth_call: () => word(7n) }), [ETH_B]: evmNode() } });
  const SEPOLIA_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
  const other = await loadTokenBalance(SEPOLIA_USDC, WALLET, { retryDelayMs: 0, expectedChain: 'eip155:11155111' });
  check('token row: a Sepolia token is never read on the mainnet endpoint', other.status === 'unavailable' && /another network/.test(other.note) && !calls.some((c) => c.method === 'eth_call'), other);
  const same = await loadTokenBalance(USDC, WALLET, { retryDelayMs: 0, expectedChain: ETH_CHAIN });
  check('control: the same call with the endpoint\'s own chain reads the balance', same.status === 'ok' && same.amount === 7n && calls.some((c) => c.method === 'eth_call'));
}

console.log('\nUpgrade screen quote pinning (delegation.ts set-code quote):');
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
const delegatedCode = `0xef0100${WALLET_7702_DELEGATE.slice(2).toLowerCase()}`;
{
  // A revocation quote (never readiness-gated, so it runs on mainnet ids):
  // made through withEndpoint while the primary dies -> the whole quote
  // comes from the second candidate and records it.
  forgetDefaultEndpointChoices();
  const primary = dyingPrimary();
  installFake({
    rpc: {
      [ETH_A]: primary.handler,
      [ETH_B]: evmNode({ eth_getCode: () => delegatedCode, eth_getTransactionCount: () => '0x3' }),
    },
  });
  const outcome = await withEndpoint(ETH_CHAIN, (ep) =>
    prepareSetCodeTx({ url: ep.url, from: owner.address, action: 'revoke', expectedChainId: 1n }),
  );
  check('set-code quote fails over to the second candidate', outcome.switched && outcome.endpoint.url === ETH_B);
  check('the quote records the endpoint it came from', outcome.value.url === ETH_B);
  check('the quote\'s nonce is the second candidate\'s', outcome.value.nonce === 3n && outcome.value.authorizationNonce === 4n);
}
{
  // Quote on the primary; then the wallet moves to the fallback (a failure
  // elsewhere in the app). The screen's pin check and sendSetCodeTx itself
  // both refuse; nothing is signed or broadcast.
  forgetDefaultEndpointChoices();
  const primary = dyingPrimary();
  const node = evmNode({ eth_getCode: () => delegatedCode });
  let primaryAnswersQuote = true;
  const calls = installFake({
    rpc: {
      [ETH_A]: (method, params) => (primaryAnswersQuote ? node(method, params) : primary.handler(method, params)),
      [ETH_B]: evmNode({ eth_getCode: () => delegatedCode, eth_sendRawTransaction: () => `0x${'42'.repeat(32)}` }),
    },
  });
  const start = await getEndpoint(ETH_CHAIN);
  const quote = await prepareSetCodeTx({ url: start.url, from: owner.address, action: 'revoke', expectedChainId: 1n });
  check('the screen quotes on the primary', quote.url === ETH_A);
  primaryAnswersQuote = false;
  primary.kill();
  reportEndpointFailure(ETH_CHAIN, ETH_A);
  const atConfirm = await getEndpoint(ETH_CHAIN);
  check('meanwhile the wallet moved to the fallback', atConfirm?.url === ETH_B);
  const refusal = quoteEndpointChange(quote.url, atConfirm?.url);
  check(
    'the screen\'s pin check refuses, naming both hosts and nothing else',
    typeof refusal === 'string' && refusal.includes('ethereum-rpc.publicnode.com') && refusal.includes('ethereum.publicnode.com') && !refusal.includes('https://'),
    refusal,
  );
  const sendError = await rejects(sendSetCodeTx(ETH_B, owner, quote, null));
  check(
    'sendSetCodeTx refuses to send a quote through another endpoint',
    sendError instanceof Error && /Nothing was signed or sent/.test(sendError.message),
    sendError,
  );
  check('nothing was broadcast anywhere', !calls.some((c) => c.method === 'eth_sendRawTransaction'));
  check('the refusal happened before any request to the new endpoint', !calls.some((c) => c.url === ETH_B && !c.probe));
}
{
  // Same endpoint at send time: the pinned send goes through the quote's URL.
  forgetDefaultEndpointChoices();
  const txid = `0x${'42'.repeat(32)}`;
  const calls = installFake({
    rpc: { [ETH_A]: evmNode({ eth_getCode: () => delegatedCode, eth_sendRawTransaction: () => txid }), [ETH_B]: evmNode() },
  });
  const start = await getEndpoint(ETH_CHAIN);
  const quote = await prepareSetCodeTx({ url: start.url, from: owner.address, action: 'revoke', expectedChainId: 1n });
  check('unchanged endpoint -> no refusal at confirm', quoteEndpointChange(quote.url, (await getEndpoint(ETH_CHAIN))?.url) === null);
  const sent = await sendSetCodeTx(quote.url, owner, quote, null);
  check('the revocation is sent through the quote\'s endpoint', sent.txid === txid && calls.some((c) => c.url === ETH_A && c.method === 'eth_sendRawTransaction'));
}
{
  const screen = readFileSync(new URL('../src/screens/UpgradeAccountScreen.tsx', import.meta.url), 'utf8');
  const confirmStart = screen.indexOf('const onConfirm = async');
  const confirm = screen.slice(confirmStart, screen.indexOf('if (!address) {', confirmStart));
  const pin = confirm.indexOf('quoteEndpointChange(quote.url, currentUrl)');
  const gate = confirm.indexOf('requireLocalAuth(');
  check('UpgradeAccountScreen: the pin check runs before the biometric gate', pin > 0 && gate > pin);
  check(
    'UpgradeAccountScreen: a moved endpoint shows the shared title and returns to the overview',
    /Alert\.alert\(QUOTE_ENDPOINT_CHANGED_TITLE, endpointChanged\);\s*setQuote\(null\);\s*setPhase\('overview'\);\s*return;/.test(confirm),
  );
  check('UpgradeAccountScreen: signs, sends and polls through quote.url only', /const url = quote\.url;/.test(confirm) && !/delegation\.url/.test(confirm));
  check('UpgradeAccountScreen: quotes through withEndpoint (failover)', /withEndpoint\(EVM_CHAIN_ID, \(ep\) =>\s*prepareSetCodeTx\(\{\s*url: ep\.url,/.test(screen));
}

console.log('\nWalletConnect eth_sendTransaction quotes (walletconnect.ts):');
const DAPP_TX = {
  to: RECIPIENT,
  valueWei: 1000n,
  data: new Uint8Array([0xa9, 0x05, 0x9c, 0xbb, ...new Array(64).fill(0x11)]),
};
const DAPP_DATA_HEX = `0x${Buffer.from(DAPP_TX.data).toString('hex')}`;
{
  forgetDefaultEndpointChoices();
  const primary = dyingPrimary();
  const calls = installFake({
    rpc: { [ETH_A]: primary.handler, [ETH_B]: evmNode({ eth_getTransactionCount: () => '0x9' }) },
  });
  const quoted = await quoteWcTransaction(DAPP_TX, WALLET, ETH_CHAIN).catch((error) => ({ error }));
  check('a dApp transaction quote fails over when the first endpoint fails', quoted.url === ETH_B, quoted.url ?? quoted.error);
  check('the quote is entirely the second candidate\'s (nonce)', quoted.quote?.nonce === 9n);
  check('the dApp calldata is carried into the quote', `0x${Buffer.from(quoted.quote?.data ?? []).toString('hex')}` === DAPP_DATA_HEX);
  check('the eth_call gate ran on the second candidate', calls.some((c) => c.url === ETH_B && c.method === 'eth_call') && quoted.quote?.simulation.ok === true);
  check('the sender is the session account', quoted.from === WALLET);
}
{
  // Re-quote on move: quoted on the primary, then the wallet moves to the
  // fallback before the user approves. The sheet's approval-time check
  // re-quotes on the fallback instead of refusing.
  forgetDefaultEndpointChoices();
  const primary = dyingPrimary();
  let primaryServes = true;
  const healthyPrimary = evmNode({ eth_getTransactionCount: () => '0x7', eth_maxPriorityFeePerGas: () => '0x5f5e100' });
  const calls = installFake({
    rpc: {
      [ETH_A]: (method, params) => (primaryServes ? healthyPrimary(method, params) : primary.handler(method, params)),
      [ETH_B]: evmNode({ eth_getTransactionCount: () => '0x8', eth_maxPriorityFeePerGas: () => '0x77359400' }),
    },
  });
  const first = await quoteWcTransaction(DAPP_TX, WALLET, ETH_CHAIN);
  check('the request is first quoted on the primary', first.url === ETH_A && first.quote.nonce === 7n);
  const unchanged = await requoteWcTransactionIfMoved(first, DAPP_TX, ETH_CHAIN);
  check('approval with the same endpoint: no re-quote', unchanged.moved === false);
  primaryServes = false;
  primary.kill();
  reportEndpointFailure(ETH_CHAIN, ETH_A);
  const before = calls.length;
  const moved = await requoteWcTransactionIfMoved(first, DAPP_TX, ETH_CHAIN);
  check('approval after a move: re-quoted automatically (not refused)', moved.moved === true);
  check('the fresh quote names the new endpoint', moved.moved && moved.next.url === ETH_B);
  check('the fresh quote\'s numbers are the new endpoint\'s (nonce, fee)', moved.moved && moved.next.quote.nonce === 8n && moved.next.quote.fee !== first.quote.fee);
  check('the fresh quote keeps the dApp\'s request (to, value, calldata, sender)', moved.moved && moved.next.quote.to === first.quote.to && moved.next.quote.amount === 1000n && moved.next.from === WALLET && `0x${Buffer.from(moved.next.quote.data ?? []).toString('hex')}` === DAPP_DATA_HEX);
  const requoteCalls = calls.slice(before);
  check('the re-quote\'s eth_call gate ran against the new endpoint', requoteCalls.some((c) => c.url === ETH_B && c.method === 'eth_call') && moved.next.quote.simulation.ok === true);
  check('nothing from the old endpoint was used for the re-quote', !requoteCalls.some((c) => c.url === ETH_A && !c.probe));
  check('the one-line note is the agreed sentence', WC_REQUOTED_NOTE === 'The network endpoint changed; the fee was re-quoted.');
  // The balance-change preview runs on the URL the sheet holds, which is now
  // the fresh quote's.
  if (moved.moved) {
    const previewStart = calls.length;
    await runBalancePreview({
      url: moved.next.url,
      wallet: WALLET,
      calls: [{ from: WALLET, to: moved.next.quote.to, value: moved.next.quote.amount, data: moved.next.quote.data }],
      chainCaip2: ETH_CHAIN,
      trackedTokens: [],
    });
    const previewCalls = calls.slice(previewStart);
    check('the balance-change preview runs against the final quoted endpoint', previewCalls.length > 0 && previewCalls.every((c) => c.url === ETH_B), previewCalls.map((c) => c.url));
  } else {
    check('the balance-change preview runs against the final quoted endpoint', false, 'no re-quote happened');
  }
}
{
  // Moved, and the fresh quote cannot be made (every endpoint dead): the
  // error surfaces for the sheet to show; nothing is reused.
  forgetDefaultEndpointChoices();
  const node = evmNode();
  let alive = true;
  installFake({
    rpc: {
      [ETH_A]: (m, p) => (alive ? node(m, p) : dead()),
      [ETH_B]: (m, p) => (m === 'eth_chainId' ? '0x1' : dead()),
    },
  });
  const first = await quoteWcTransaction(DAPP_TX, WALLET, ETH_CHAIN);
  alive = false;
  reportEndpointFailure(ETH_CHAIN, ETH_A);
  const error = await rejects(requoteWcTransactionIfMoved(first, DAPP_TX, ETH_CHAIN));
  check('a failed re-quote surfaces its error (the old quote is never reused)', isEndpointFailure(error), error);
}
{
  const sheet = readFileSync(new URL('../src/components/WcApprovalSheet.tsx', import.meta.url), 'utf8');
  const provider = readFileSync(new URL('../src/wallet/WalletConnectContext.tsx', import.meta.url), 'utf8');
  const approve = sheet.slice(sheet.indexOf('const approveRequest = async'));
  check('sheet: the EOA quote goes through quoteWcTransaction', /quoteWcTransaction\(tx, address, evmChain\.caip2\)/.test(sheet) && !/prepareEvmSend\(/.test(sheet));
  check(
    'sheet: approval re-checks the endpoint before handing over to the provider',
    approve.indexOf('requoteWcTransactionIfMoved(') > 0 && approve.indexOf('requoteWcTransactionIfMoved(') < approve.indexOf('onApprove(txQuote'),
  );
  check(
    'sheet: a moved endpoint shows the fresh quote with the note and clears the override, without approving',
    /if \(result\.moved\) \{\s*setOverrideSimulation\(false\);\s*setTxQuote\(\{ status: 'ready', \.\.\.result\.next, note: WC_REQUOTED_NOTE \}\);\s*return;/.test(approve),
  );
  check('sheet: the note is rendered on the transaction confirm', /\{txQuote\.note \? \(/.test(sheet));
  const txBranch = provider.slice(provider.indexOf('const { quote, url } = txQuote;'));
  check(
    'provider: after the biometric gate, the quote\'s endpoint is re-checked before signing',
    txBranch.indexOf('quoteEndpointChange(url, currentUrl)') > 0 && txBranch.indexOf('quoteEndpointChange(url, currentUrl)') < txBranch.indexOf('signWith('),
  );
  check('provider: a moved endpoint releases the request back to the sheet (not declined)', /if \(endpointChanged\) \{\s*controller\.release\(item\.key\);/.test(txBranch));
}

seed.fill(0);

// F4 / F9 (phase 11 item 6): what a user reads from an endpoint error.
console.log('endpoint error text (F4, F9):');
{
  const ad = 'RPC error -32602: Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode (eth_getLogs)';
  check('publicnode refusal -> code + first sentence, no advert, no URL',
    sanitizeEndpointMessage(ad) === 'JSON-RPC error -32602: Archive requests require a personal token.', sanitizeEndpointMessage(ad));
  check('code passed separately is kept',
    sanitizeEndpointMessage('Archive requests require a personal token. Get one at: https://x.example', -32602) === 'JSON-RPC error -32602: Archive requests require a personal token.');
  check('"Get one at" removed even inside the first sentence',
    sanitizeEndpointMessage('Rate limited, get one at https://vendor.example/pricing') === 'Rate limited.');
  check('bare URLs and www links removed', !/https?:|www\./.test(sanitizeEndpointMessage('Upgrade at www.vendor.example or https://vendor.example now')));
  const java = 'java.net.UnknownHostException: Unable to resolve host "eth-sepolia.g.alchemy.com": No address associated with hostname';
  const cleanedJava = sanitizeEndpointMessage(java);
  check('Java exception class removed, the readable part kept',
    !/java\.|Exception/.test(cleanedJava) && cleanedJava.startsWith('Unable to resolve host'), cleanedJava);
  check('only the first sentence is kept', sanitizeEndpointMessage('First thing. Second thing.') === 'First thing.');
  check('long text capped', sanitizeEndpointMessage('x'.repeat(500)).length <= 200);
  check('nothing readable -> empty string', sanitizeEndpointMessage('https://only.example') === '');

  const offline = new TypeError('Network request failed');
  const d = describeNetworkFailure(offline, 'your NFTs');
  check('offline: calm title naming the thing', d.title.startsWith('Could not reach the network endpoint, so your NFTs could not be loaded'));
  check('offline: the detail is a plain sentence, not the exception', d.detail === NO_ANSWER_SENTENCE);
  check('offline: technical line is the cleaned text', d.technical === 'Network request failed.');
  const javaTimeout = Object.assign(new Error('java.net.SocketTimeoutException: timeout'), {});
  const t = describeNetworkFailure(javaTimeout, 'your NFTs');
  check('a raw Java timeout never reaches the user verbatim', t.detail === NO_ANSWER_SENTENCE && t.technical !== null && !/java\.|Exception/.test(t.technical), JSON.stringify(t));
  const answer = describeNetworkFailure(new Error(ad), 'older approvals');
  check('an endpoint answer: detail is its cleaned first sentence', answer.title === 'Older approvals could not be loaded.' && answer.detail === 'JSON-RPC error -32602: Archive requests require a personal token.' && answer.technical === null);
}

// ---------------------------------------------------------------------------
// Fee read: one same-endpoint retry on HTTP 400 (phase 14 emulator finding 3)
// ---------------------------------------------------------------------------
{
  console.log('\nFee read retry (fee-read.ts) and the quote-failure wording (send.ts):');
  const http400Block = new Error('RPC HTTP error 400 for eth_getBlockByNumber');
  for (const [label, error, expected] of [
    ['HTTP 400 for eth_getBlockByNumber', http400Block, true],
    ['HTTP 400 for eth_maxPriorityFeePerGas', new Error('RPC HTTP error 400 for eth_maxPriorityFeePerGas'), true],
    ['HTTP 400 for eth_call (an answer: not retried)', new Error('RPC HTTP error 400 for eth_call'), false],
    ['HTTP 503 for eth_getBlockByNumber (left to failover)', new Error('RPC HTTP error 503 for eth_getBlockByNumber'), false],
    ['a JSON-RPC error for eth_getBlockByNumber', new Error('RPC error -32602: invalid argument (eth_getBlockByNumber)'), false],
  ]) {
    check(`retryable fee read: ${label} -> ${expected}`, isRetryableFeeReadError(error) === expected);
  }
  check('the global rule is unchanged: HTTP 400 is still not an endpoint failure', isEndpointFailure(http400Block) === false);

  const FEES = { maxFeePerGas: 3n, maxPriorityFeePerGas: 1n };
  const flaky = (errors) => {
    const client = { calls: 0, async suggestFees() { client.calls += 1; const e = errors.shift(); if (e) throw e; return FEES; } };
    return client;
  };
  const once = flaky([http400Block]);
  const got = await suggestFeesRetryingOnce(once);
  check('one HTTP 400 on the block read: retried once on the same client, fees returned', got === FEES && once.calls === 2);
  const twice = flaky([http400Block, http400Block]);
  const second = await suggestFeesRetryingOnce(twice).then(() => null, (e) => e);
  check('a second HTTP 400: thrown, never a third attempt', second === http400Block && twice.calls === 2);
  const other = flaky([new Error('RPC HTTP error 400 for eth_call')]);
  const notRetried = await suggestFeesRetryingOnce(other).then(() => null, (e) => e);
  check('any other error: thrown at once without a retry', notRetried !== null && other.calls === 1);

  // End to end through prepareEvmSend and the engine transport: the first
  // eth_getBlockByNumber answers HTTP 400, the second answers normally.
  const FLAKY_URL = 'https://flaky-400.example';
  const node = evmNode();
  let blockReads = 0;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    if (url !== FLAKY_URL) throw new TypeError(`fetch failed (no fake for ${url})`);
    if (body.method === 'eth_getBlockByNumber' && ++blockReads === 1) {
      return { ok: false, status: 400, json: async () => ({}), text: async () => '' };
    }
    const text = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: node(body.method, body.params) });
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  };
  const quote = await prepareEvmSend(FLAKY_URL, WALLET, RECIPIENT, 1000n).then((q) => q, (e) => e);
  check('a quote whose first block read answers HTTP 400 is prepared on the same endpoint (2 block reads)',
    !(quote instanceof Error) && quote.maxFeePerGas === 2n * 0x3b9aca00n + 0x5f5e100n && blockReads === 2, quote instanceof Error ? quote.message : '');

  // The wording when it fails twice: a plain sentence and a technical line.
  const described = describeSendError(http400Block, 'ETH');
  const retitled = retitleQuoteFailure(described);
  check('quote failure title: "The quote could not be prepared."', retitled.title === QUOTE_FAILED_TITLE && retitled.title === 'The quote could not be prepared.');
  check('quote failure detail: a plain sentence, never the raw transport text',
    retitled.detail === 'The network endpoint answered a request for network data with an error (HTTP 400) instead of the data. This is usually brief; try again in a moment.' &&
      !/RPC HTTP error/.test(retitled.detail), retitled.detail);
  check('quote failure technical line: the cleaned original text, carried through retitleQuoteFailure',
    retitled.technical === 'RPC HTTP error 400 for eth_getBlockByNumber.', retitled.technical);
  const broadcast = describeSendError(new Error('RPC HTTP error 400 for eth_sendRawTransaction'), 'ETH');
  check('a broadcast HTTP 400 keeps the old wording (it does not tell whether the transaction went out)',
    broadcast.title === 'The transaction could not be sent.' && broadcast.detail === 'RPC HTTP error 400 for eth_sendRawTransaction' && broadcast.technical === undefined);
  check('an unreachable endpoint keeps its own title', describeSendError(new Error('RPC HTTP error 503 for eth_getBlockByNumber'), 'ETH').title === 'Could not reach the network endpoint. Check your connection.');
  check('describeEndpointHttpAnswer ignores other errors', describeEndpointHttpAnswer(new Error('RPC error 3: execution reverted (eth_estimateGas)')) === null);

  // Source checks: every quote's fee read goes through the retry, and the
  // Send screen shows the technical line under the form error it belongs to.
  const walletDir = new URL('../src/wallet/', import.meta.url);
  const direct = readdirSync(walletDir)
    .filter((f) => f.endsWith('.ts') && f !== 'fee-read.ts')
    .filter((f) => /\.suggestFees\(\)/.test(readFileSync(new URL(f, walletDir), 'utf8')));
  check('no app module calls NodeClient.suggestFees() directly (all through suggestFeesRetryingOnce)', direct.length === 0, direct.join(', '));
  const sendScreen = readFileSync(new URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8');
  check('Send: quote failures (Review and Max) go through showQuoteFailure, which keeps the technical line',
    (sendScreen.match(/showQuoteFailure\(\n\s*retitleQuoteFailure\(/g) ?? []).length === 2 &&
      sendScreen.includes('{formError && formTechnical?.forError === formError ? <TechnicalDetail text={formTechnical.text} /> : null}'));

  // Mutation: fee-read.ts without the retry must fail the checks above.
  const feeSrc = readFileSync(new URL('../src/wallet/fee-read.ts', import.meta.url), 'utf8');
  const anchor = '    if (!isRetryableFeeReadError(error)) throw error;\n    return client.suggestFees();';
  check('mutation anchor present (fee read retry)', feeSrc.includes(anchor));
  const mutantDir = join(dirname(fileURLToPath(import.meta.url)), `.mutants-failover-${process.pid}`);
  mkdirSync(mutantDir, { recursive: true });
  const mutantFile = join(mutantDir, 'fee-read.ts');
  writeFileSync(mutantFile, feeSrc.replace(anchor, '    throw error;'));
  try {
    const mutant = await import(pathToFileURL(mutantFile).href);
    const m = flaky([http400Block]);
    const r = await mutant.suggestFeesRetryingOnce(m).then(() => 'ok', () => 'threw');
    check('M-f1 caught: without the retry a single HTTP 400 fails the quote', r === 'threw' && m.calls === 1);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

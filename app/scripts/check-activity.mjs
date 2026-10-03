/**
 * Verification for human-readable Activity rows (phase 11 item 4): the app
 * glue in src/wallet/activity-sentences.ts over the engine's activity
 * decoder (packages/chains-evm/src/activity-decode.ts).
 *
 * Fully offline. A fake JSON-RPC node behind globalThis.fetch serves the
 * real Sepolia transactions and receipts pinned in
 * packages/chains-evm/test/fixtures/activity-sepolia/ (fetched read-only on
 * 2026-10-03; see the engine test for the list) plus the recorded
 * symbol()/decimals() answers of Sepolia USDC and EURC. Nothing is signed
 * or broadcast.
 *
 * Covered: the sentences through the exact app glue (swap, Permit2
 * approval, smart-account send, EIP-7702 revoke), the contact label (exact
 * match only — a look-alike contact never labels), Hide amounts masking,
 * tracked-token labels, the per-call decode bound, the cache (no requests
 * on a second visit, bounded size), the failure policy (null receipts,
 * dead endpoints, wrong chain → no sentence, not cached, retried only
 * after reset()), the wallet's Kernel counterfactual address, the default
 * runner through config/networks.ts withEndpoint in Sepolia test mode, and
 * source checks on ActivityScreen (sentence above the time/fee line, Hide
 * amounts passed, tap-to-explorer unchanged).
 *
 * Run from app/: node scripts/check-activity.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'ethers';
import { KERNEL_V3_3, encodeFunctionCall, toHex } from '@shiba-wallet/chains-evm';
import {
  ACTIVITY_CACHE_LIMIT,
  MAX_DECODES_PER_CALL,
  activeEndpointRunner,
  activityCacheSize,
  clearActivityCache,
  createActivityDecoder,
  renderActivitySentence,
  walletAddressesFor,
} from '../src/wallet/activity-sentences.ts';
import { EVM_MAINNET } from '../src/config/evm-chain.ts';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log('  FAIL', name, detail !== undefined ? `\n       got: ${JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}` : '');
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '..', 'packages', 'chains-evm', 'test', 'fixtures', 'activity-sepolia');
const fixtures = new Map();
for (const file of readdirSync(FIXTURES).filter((f) => f.startsWith('0x'))) {
  const j = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
  fixtures.set(j.transaction.hash.toLowerCase(), j);
}
const TOKEN_CALLS = JSON.parse(readFileSync(join(FIXTURES, 'tokens.json'), 'utf8')).tokens;

const SEPOLIA = 'eip155:11155111';
const SEPOLIA_ID = 11155111n;
const URL = 'https://fake-sepolia.invalid/rpc';
const ACCOUNT_1 = getAddress('0x772eaa1d3bef14c0bd5cee980b90db3fc680f44f');
const ACCOUNT_2 = getAddress('0xb6997390e1e3cde9bf035af75830ae00c29781fe');
const KERNEL_OF_ACCOUNT_1 = getAddress('0xd31c2c54f21684ee2026a6c41e391130bdeed8fa');
const BURN = getAddress('0x000000000000000000000000000000000000dead');
const USDC = getAddress('0x1c7d4b196cb0c7b01d743fbc6116a902379c7238');

const H = {
  swapEurc: '0x5396a4935274947f7be7ead1804aabd3a47082bc06c193d30073fd01b54e5fe2',
  swapEth1: '0x5ab4c38b409b0665a909aad2259d3a15e89c639258dec579a8be5ff9d0221714',
  swapEth2: '0x3c55113b646015e7b394a2b3df7377b8abcd3c926dd5472ac8ec3a99c13d8437',
  approve: '0xa41da70aab0b1b84106a18ab1db3252e6d6ee8bf1a6833f7a804a6359e36b39c',
  handleOps: '0xe18921543ac17a0e7e9167bb6a3f07755dd5d80eb9ae281a5aa92b09fc066e9a',
  upgrade: '0xbd14fbeb79ed95b2b43876b5d56cb1521ed5c0d6092704cc647706053da4a7ec',
  revoke: '0x1287e768f04b039934090660f74616dd8fff2c2e6b36da2eb667369f83c9594f',
};
check('all seven fixtures present', Object.values(H).every((h) => fixtures.has(h)), [...fixtures.keys()]);

const SEL = {
  'decimals()': toHex(encodeFunctionCall('decimals()', [])),
  'symbol()': toHex(encodeFunctionCall('symbol()', [])),
  'name()': toHex(encodeFunctionCall('name()', [])),
};

/**
 * Fake node. `mode.receiptNull` (a Set of hashes) answers null receipts,
 * `mode.dead` throws a transport error, `extraTx(hash)` can serve synthetic
 * transactions. Every request is recorded.
 */
let requests = [];
let mode = { receiptNull: new Set(), dead: false, chainId: '0xaa36a7', extraTx: null, revertDecimals: false };
function installFakeNode(url = URL) {
  globalThis.fetch = async (target, init = {}) => {
    const body = JSON.parse(init.body);
    requests.push({ url: target, method: body.method, params: body.params });
    if (mode.dead || target !== url) throw new TypeError('fetch failed (simulated dead endpoint)');
    const reply = (result) => {
      const text = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    };
    const error = (message) => {
      const text = JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: 3, message } });
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    };
    switch (body.method) {
      case 'eth_chainId':
        return reply(mode.chainId);
      case 'eth_getTransactionByHash': {
        const hash = body.params[0].toLowerCase();
        const extra = mode.extraTx?.(hash);
        if (extra) return reply(extra.transaction);
        return reply(fixtures.get(hash)?.transaction ?? null);
      }
      case 'eth_getTransactionReceipt': {
        const hash = body.params[0].toLowerCase();
        if (mode.receiptNull.has(hash)) return reply(null);
        const extra = mode.extraTx?.(hash);
        if (extra) return reply(extra.receipt);
        return reply(fixtures.get(hash)?.receipt ?? null);
      }
      case 'eth_call': {
        const { to, data } = body.params[0];
        const calls = TOKEN_CALLS[to.toLowerCase()];
        const name = Object.keys(SEL).find((k) => SEL[k] === data);
        if (!calls || !name) return error('execution reverted');
        if (name === 'decimals()' && mode.revertDecimals) return error('execution reverted');
        return reply(calls[name]);
      }
      default:
        throw new Error(`fake node: unexpected ${body.method}`);
    }
  };
}
function reset(over = {}) {
  requests = [];
  mode = { receiptNull: new Set(), dead: false, chainId: '0xaa36a7', extraTx: null, revertDecimals: false, ...over };
  clearActivityCache();
}
const count = (method) => requests.filter((r) => r.method === method).length;
const fixedRun = (operation) => operation(URL);

const contact = (name, address, networkId = SEPOLIA) => ({ networkId, name, address, createdAt: '2026-10-03T00:00:00Z' });
const BURN_CONTACT = contact('Burn', BURN);
const render = (decoded, over = {}) =>
  renderActivitySentence(decoded, {
    nativeSymbol: 'test ETH',
    hidden: false,
    contacts: [BURN_CONTACT],
    networkId: SEPOLIA,
    ...over,
  });

installFakeNode();

// ---------------------------------------------------------------------------
console.log('Wallet addresses:');
{
  const kernelConfig = {
    accountType: 'kernel-v3.3',
    factory: KERNEL_V3_3.factory,
    factoryImplementation: KERNEL_V3_3.implementation,
    kernelValidator: KERNEL_V3_3.ecdsaValidator,
    recoveredAccounts: [],
  };
  const w = walletAddressesFor(ACCOUNT_1, 0, kernelConfig);
  check(
    "Kernel counterfactual of Account 1 is the emulator's deployed account 0xD31c…D8FA",
    w.length === 2 && w[0] === ACCOUNT_1 && w[1] === KERNEL_OF_ACCOUNT_1,
    w,
  );
  check('no AA config: EOA only', walletAddressesFor(ACCOUNT_1, 0, null).length === 1);
  check(
    'SimpleAccount config adds nothing (needs a factory call)',
    walletAddressesFor(ACCOUNT_1, 0, { ...kernelConfig, accountType: 'simple' }).length === 1,
  );
  const rec = walletAddressesFor(ACCOUNT_1, 0, {
    ...kernelConfig,
    accountType: 'simple',
    recoveredAccounts: [{ owner: ACCOUNT_1.toLowerCase(), account: BURN }],
  });
  check('recovered account of this owner is included', rec.includes(BURN), rec);
  const other = walletAddressesFor(ACCOUNT_2, 0, { ...kernelConfig, accountType: 'simple', recoveredAccounts: [{ owner: ACCOUNT_1, account: BURN }] });
  check("another owner's recovered account is not", !other.includes(BURN), other);
}

// ---------------------------------------------------------------------------
console.log('Sentences through the app glue:');
reset();
const wallet1 = [ACCOUNT_1, KERNEL_OF_ACCOUNT_1];
{
  const decoder = createActivityDecoder({
    chainCaip2: SEPOLIA,
    evmChainId: SEPOLIA_ID,
    wallet: wallet1,
    trackedTokens: [],
    run: fixedRun,
  });
  const ids = [H.swapEurc, H.swapEth1, H.swapEth2, H.approve, H.handleOps];
  const out = await decoder.decodeEntries(ids);
  check('five decodes in one call (bound is 8)', out.size === 5 && MAX_DECODES_PER_CALL === 8, out.size);
  check('two RPC reads per transaction', count('eth_getTransactionByHash') === 5 && count('eth_getTransactionReceipt') === 5);
  check('USDC→EURC swap', render(out.get(H.swapEurc)) === 'Swapped 1 USDC for 0.991829 EURC on Uniswap', render(out.get(H.swapEurc)));
  check('USDC→ETH swap names test ETH, no invented amount', render(out.get(H.swapEth1)) === 'Swapped 1 USDC for test ETH on Uniswap', render(out.get(H.swapEth1)));
  check('second USDC→ETH swap', render(out.get(H.swapEth2)) === 'Swapped 1 USDC for test ETH on Uniswap');
  check('unlimited Permit2 approval', render(out.get(H.approve)) === 'Approved USDC for Permit2 (unlimited)', render(out.get(H.approve)));
  check(
    'smart-account send with the contact label',
    render(out.get(H.handleOps)) === 'Smart-account operation: sent 0.0001 test ETH to Burn',
    render(out.get(H.handleOps)),
  );
  // Decimals came from on-chain metadata (USDC and EURC are not tracked on Sepolia).
  check('metadata read via eth_call (decimals, symbol, name for 2 tokens)', count('eth_call') > 0, count('eth_call'));
  const eurcMeta = out.get(H.swapEurc).tokens['0x08210f9170f89ab7658f0b5e3ff39b0e03c594d4'];
  check('EURC decimals 6 from chain, untracked', eurcMeta?.decimals === 6 && eurcMeta.tracked === false, eurcMeta);

  // Masking.
  const hidden = { hidden: true };
  check('Hide amounts: swap', render(out.get(H.swapEurc), hidden) === 'Swapped •••• USDC for •••• EURC on Uniswap', render(out.get(H.swapEurc), hidden));
  check('Hide amounts: smart-account send', render(out.get(H.handleOps), hidden) === 'Smart-account operation: sent •••• test ETH to Burn');
  check('Hide amounts keeps "unlimited"', render(out.get(H.approve), hidden) === 'Approved USDC for Permit2 (unlimited)');

  // Contact rules: exact match only, right network only.
  check('no contacts: short address', render(out.get(H.handleOps), { contacts: [] }) === 'Smart-account operation: sent 0.0001 test ETH to 0x0000…dEaD');
  const lookalike = contact('Burnish', getAddress('0x000000000000000000000000000000000001dead'));
  check(
    'a look-alike contact (same first/last 4) never labels',
    render(out.get(H.handleOps), { contacts: [lookalike] }) === 'Smart-account operation: sent 0.0001 test ETH to 0x0000…dEaD',
    render(out.get(H.handleOps), { contacts: [lookalike] }),
  );
  check(
    "a mainnet contact does not label a Sepolia address",
    render(out.get(H.handleOps), { contacts: [contact('Burn mainnet', BURN, 'eip155:1')] }) ===
      'Smart-account operation: sent 0.0001 test ETH to 0x0000…dEaD',
  );
  check(
    'lowercase stored contact address still matches exactly',
    render(out.get(H.handleOps), { contacts: [contact('Burn', BURN.toLowerCase())] }).endsWith('to Burn'),
  );

  // Second visit: cache hit, no requests.
  requests = [];
  const again = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [...wallet1].reverse(), trackedTokens: [], run: fixedRun });
  const cached = await again.decodeEntries(ids);
  check('second visit: all from cache, zero requests', cached.size === 5 && requests.length === 0, requests.length);
  check('cachedFor answers without requests', again.cachedFor([H.approve]).size === 1 && requests.length === 0);
  // Different wallet set: separate cache key.
  const eoaOnly = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1], trackedTokens: [], run: fixedRun });
  const eoaOut = await eoaOnly.decodeEntries([H.handleOps]);
  check(
    "EOA-only wallet: the Kernel account's op is someone else's",
    render(eoaOut.get(H.handleOps)) === 'Smart-account bundle with 1 operation from other accounts',
    render(eoaOut.get(H.handleOps)),
  );
}

console.log('EIP-7702 rows:');
reset();
{
  const decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_2], trackedTokens: [], run: fixedRun });
  const out = await decoder.decodeEntries([H.revoke, H.upgrade]);
  check('self-sent revoke', render(out.get(H.revoke)) === 'Revoked the account upgrade (EIP-7702)', render(out.get(H.revoke)));
  check(
    'sponsored upgrade bundle',
    render(out.get(H.upgrade)) ===
      'Authorized the account upgrade to Kernel v3.3 (EIP-7702); smart-account operation: sent 0.0001 test ETH to 0x16DA…aC5C',
    render(out.get(H.upgrade)),
  );
}

console.log('Tracked tokens and metadata:');
reset();
{
  const tracked = [
    { kind: 'fungible', assetId: { chainId: SEPOLIA, namespace: 'erc20', reference: USDC }, symbol: 'tUSDC', name: 'Test USDC', decimals: 6 },
  ];
  const decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1], trackedTokens: tracked, run: fixedRun });
  const out = await decoder.decodeEntries([H.swapEurc]);
  check('tracked symbol wins', render(out.get(H.swapEurc)) === 'Swapped 1 tUSDC for 0.991829 EURC on Uniswap', render(out.get(H.swapEurc)));
  const usdcCalls = requests.filter((r) => r.method === 'eth_call' && r.params[0].to.toLowerCase() === USDC.toLowerCase());
  check('tracked token: no metadata eth_call for it', usdcCalls.length === 0, usdcCalls.length);

  reset({ revertDecimals: true });
  const mainnetTracked = [{ ...tracked[0], assetId: { ...tracked[0].assetId, chainId: 'eip155:1' } }];
  const d2 = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1], trackedTokens: mainnetTracked, run: fixedRun });
  const out2 = await d2.decodeEntries([H.swapEurc]);
  check(
    'unreadable decimals → raw units; a mainnet tracked entry never labels a Sepolia contract',
    render(out2.get(H.swapEurc)) === 'Swapped 1000000 raw units of USDC for 991829 raw units of EURC on Uniswap',
    render(out2.get(H.swapEurc)),
  );
}

console.log('Bounds, failures and the cache limit:');
reset();
{
  const decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1], trackedTokens: [], run: fixedRun, maxPerCall: 2 });
  const ids = [H.swapEurc, H.swapEth1, H.swapEth2, H.approve, H.handleOps];
  const first = await decoder.decodeEntries(ids);
  check('maxPerCall 2: two decoded', first.size === 2 && count('eth_getTransactionByHash') === 2, first.size);
  const second = await decoder.decodeEntries(ids);
  check('next call decodes the next two', second.size === 4 && count('eth_getTransactionByHash') === 4, second.size);
  check('ids that are not hashes are ignored', (await decoder.decodeEntries(['not-a-hash'])).size === 0);
}
reset({ receiptNull: new Set([H.approve]) });
{
  const decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1], trackedTokens: [], run: fixedRun });
  const out = await decoder.decodeEntries([H.approve]);
  check('null receipt (publicnode quirk) → no sentence, not cached', out.size === 0 && activityCacheSize() === 0);
  check('remembered as failed', decoder.failedIds().includes(H.approve));
  const before = requests.length;
  await decoder.decodeEntries([H.approve]);
  check('not retried on the next render', requests.length === before, requests.length - before);
  mode.receiptNull.clear();
  decoder.reset();
  const retried = await decoder.decodeEntries([H.approve]);
  check('retried after reset() (pull-to-refresh) and succeeds', retried.size === 1 && render(retried.get(H.approve)) === 'Approved USDC for Permit2 (unlimited)');
}
reset({ dead: true });
{
  const decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1], trackedTokens: [], run: fixedRun });
  let threw = false;
  let out;
  try {
    out = await decoder.decodeEntries([H.swapEurc]);
  } catch {
    threw = true;
  }
  check('dead endpoint: never throws, no sentence', !threw && out.size === 0 && decoder.failedIds().length === 1);
}
reset();
{
  const decoder = createActivityDecoder({ chainCaip2: 'eip155:1', evmChainId: 1n, wallet: [ACCOUNT_1], trackedTokens: [], run: fixedRun });
  const out = await decoder.decodeEntries([H.swapEurc]);
  check('a Sepolia transaction is refused by a mainnet decoder', out.size === 0 && decoder.failedIds().length === 1);
}
reset();
{
  // Synthetic plain transfers, one per hash, to fill the cache past its limit.
  const synthetic = (hash) => ({
    transaction: {
      hash,
      from: ACCOUNT_1,
      to: BURN,
      input: '0x',
      value: '0x1',
      nonce: '0x1',
      type: '0x2',
      chainId: '0xaa36a7',
      blockNumber: '0x10',
      blockHash: '0x' + 'cd'.repeat(32),
    },
    receipt: { transactionHash: hash, blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32), status: '0x1', logs: [] },
  });
  mode.extraTx = (hash) => (fixtures.has(hash) ? null : synthetic(hash));
  const hashes = Array.from({ length: ACTIVITY_CACHE_LIMIT + 5 }, (_, i) => '0x' + (i + 1).toString(16).padStart(64, '0'));
  const decoder = createActivityDecoder({
    chainCaip2: SEPOLIA,
    evmChainId: SEPOLIA_ID,
    wallet: [ACCOUNT_1],
    trackedTokens: [],
    run: fixedRun,
    maxPerCall: hashes.length,
  });
  const out = await decoder.decodeEntries(hashes);
  check('cache stays bounded', activityCacheSize() === ACTIVITY_CACHE_LIMIT, activityCacheSize());
  check('oldest entries were evicted', !decoder.cachedFor([hashes[0]]).size && decoder.cachedFor([hashes.at(-1)]).size === 1);
  check(
    'plain ETH send sentence (contact)',
    render(out.get(hashes.at(-1))) === 'Sent 0.000000000000000001 test ETH to Burn',
    render(out.get(hashes.at(-1))),
  );
}

console.log('Default runner (config/networks.ts withEndpoint, mainnet defaults with failover):');
reset({ chainId: '0x1' });
{
  // Under Node the app's AsyncStorage holds nothing, so the resolver sees
  // the default preferences (mainnet) and the default candidates. The
  // primary candidate is dead; the shared failover rule must move the
  // decode to the second candidate after its eth_chainId identity probe.
  const [primary, secondary] = EVM_MAINNET.defaultRpcUrls;
  installFakeNode(secondary);
  const hash = '0x' + 'ee'.repeat(32);
  mode.extraTx = (h) =>
    h === hash
      ? {
          transaction: {
            hash,
            from: ACCOUNT_1,
            to: BURN,
            input: '0x',
            value: '0x2386f26fc10000',
            nonce: '0x1',
            type: '0x2',
            chainId: '0x1',
            blockNumber: '0x10',
            blockHash: '0x' + 'cd'.repeat(32),
          },
          receipt: { transactionHash: hash, blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32), status: '0x1', logs: [] },
        }
      : null;
  const decoder = createActivityDecoder({ chainCaip2: 'eip155:1', evmChainId: 1n, wallet: [ACCOUNT_1], trackedTokens: [] });
  const out = await decoder.decodeEntries([hash]);
  check('decodes through withEndpoint', out.size === 1, out.size);
  check(
    'mainnet sentence with a mainnet contact',
    out.size === 1 &&
      renderActivitySentence(out.get(hash), {
        nativeSymbol: 'ETH',
        hidden: false,
        contacts: [contact('Burn', BURN, 'eip155:1')],
        networkId: 'eip155:1',
      }) === 'Sent 0.01 ETH to Burn',
  );
  const decodeUrls = new Set(requests.filter((r) => r.method !== 'eth_chainId').map((r) => r.url));
  check('the decode ran on the healthy second candidate only', decodeUrls.size === 1 && decodeUrls.has(secondary), [...decodeUrls]);
  check('the dead primary was tried first', requests.some((r) => r.url === primary), requests.map((r) => r.url));
  check('runner is exported for the screen', typeof activeEndpointRunner('eip155:1') === 'function');
}

console.log('ActivityScreen source:');
{
  const screen = readFileSync(join(here, '..', 'src', 'screens', 'ActivityScreen.tsx'), 'utf8');
  check('rows render the sentence', /styles\.rowSentence/.test(screen) && /sentence=\{isEvmSlot \? sentenceFor\(item\.id\) : null\}/.test(screen));
  check(
    'sentence sits above the time and fee lines',
    screen.indexOf('styles.rowSentence') < screen.indexOf('styles.rowTime') &&
      screen.indexOf('styles.rowSentence') < screen.indexOf('styles.rowFee'),
  );
  check('Hide amounts reaches the renderer', /hidden: hideAmounts,/.test(screen) && /renderActivitySentence\(decoded, sentenceOptions\)/.test(screen));
  check(
    'tap-to-explorer unchanged',
    /const url = explorerTxUrl\(chainId, entry\.id, evmExplorerTxBase\);/.test(screen) && /if \(url\) void Linking\.openURL\(url\);/.test(screen),
  );
  check('the amount/fee line is still rendered', /fee \{maskAmount\(formatUnits\(entry\.fee, decimals, decimals\), hidden\)\}/.test(screen));
  check('screen readers hear the sentence first', /\(sentence \? `\$\{sentence\}\. ` : ''\)/.test(screen));
}

console.log(`\ncheck-activity: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

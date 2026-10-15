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
 * amounts passed, tap-to-explorer unchanged), and (phase 18 item 3) the
 * wallet's stored multisigs counted as its own addresses: their operations
 * inside an EntryPoint bundle and transfers to them read as the wallet's own.
 *
 * Run from app/: node scripts/check-activity.mjs
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Interface, getAddress } from 'ethers';
import {
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  USER_OPERATION_EVENT_TOPIC,
  encodeFunctionCall,
  encodeKernelExecute,
  indexerHistoryProvider,
  rocketContractAddressKey,
  toHex,
} from '@shiba-wallet/chains-evm';
import {
  activityAddressSets,
  historySmartAccountFor,
  activityAccountLabels,
  ACTIVITY_CACHE_LIMIT,
  MAX_DECODES_PER_CALL,
  activeEndpointRunner,
  activityCacheSize,
  clearActivityCache,
  createActivityDecoder,
  renderActivitySentence,
  rocketDepositPhrase,
  rocketDepositPoolForDescription,
  walletAddressesFor,
} from '../src/wallet/activity-sentences.ts';
import * as sentencesModule from '../src/wallet/activity-sentences.ts';
import { EVM_MAINNET } from '../src/config/evm-chain.ts';

// Phase 19 item 4 constants, read from the namespace so this script still
// runs (and fails the checks that need them) against an older module.
const { MAX_ALTERNATE_ASKS, ALTERNATE_REFIND_AFTER_MS } = sentencesModule;

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
    const hooked = mode.rpc?.(body.method, body.params);
    if (hooked !== undefined) return reply(hooked);
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
  mode = { receiptNull: new Set(), dead: false, chainId: '0xaa36a7', extraTx: null, revertDecimals: false, rpc: null, ...over };
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

console.log('EIP-7708 protocol ETH-transfer logs (Sepolia after Glamsterdam, 2026-10-06):');
reset();
installFakeNode(); // the previous section served another URL
{
  // Since EIP-7708 every receipt that moves ETH carries a Transfer-shaped log
  // from the system address 0xff…fe. It is ETH, never a token: no token
  // metadata read for that address, no token row, and the sentence reads
  // exactly as before the fork. Real receipt: the CTO's funding transaction
  // of 2026-10-09 (fixture 0x0293…, captured verbatim). Fake receipt: the
  // pinned smart-account send (H.handleOps) with a protocol log added for
  // the ETH it moves inside the operation.
  const SYSTEM = '0xfffffffffffffffffffffffffffffffffffffffe';
  const FUNDING = '0x0293867adea984c67d62dfff3e9d8f704ed789071e220fc67c441a51a2a83b1d';
  check('the funding fixture carries a 0xff…fe log', fixtures.get(FUNDING)?.receipt.logs[0].address === SYSTEM);
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  const FAKE = '0x' + '77'.repeat(32);
  const base = fixtures.get(H.handleOps);
  const fake = structuredClone(base);
  fake.transaction.hash = FAKE;
  fake.receipt.transactionHash = FAKE;
  fake.receipt.logs = [
    {
      address: SYSTEM,
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(KERNEL_OF_ACCOUNT_1), pad(BURN)],
      data: '0x' + (100_000_000_000_000n).toString(16).padStart(64, '0'),
    },
    ...fake.receipt.logs,
  ];
  mode.extraTx = (h) => (h === FAKE ? fake : null);
  const decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: wallet1, trackedTokens: [], run: fixedRun });
  const out = await decoder.decodeEntries([FUNDING, FAKE]);
  check('real receipt: "Received 0.01 test ETH from 0x16DA…aC5C"', render(out.get(FUNDING)) === 'Received 0.01 test ETH from 0x16DA…aC5C', render(out.get(FUNDING)));
  check('fake receipt with the protocol log: the smart-account sentence is unchanged',
    render(out.get(FAKE)) === 'Smart-account operation: sent 0.0001 test ETH to Burn', render(out.get(FAKE)));
  check('no token row and no "token 0xffff…" anywhere', ![render(out.get(FUNDING)), render(out.get(FAKE))].some((t) => /token|0xffff/i.test(t ?? '')));
  check('no token metadata read for 0xff…fe',
    !requests.some((r) => r.method === 'eth_call' && r.params[0].to.toLowerCase() === SYSTEM), requests.filter((r) => r.method === 'eth_call').map((r) => r.params[0].to));
}

console.log("Multi-signature accounts read as the wallet's own (phase 18 item 3):");
reset();
installFakeNode();
{
  // The handleOps fixture's operation sender (the emulator's Kernel account
  // 0xD31c…D8FA) stands in for a stored multisig: the decoder keys a bundle's
  // operations on the sender address only, so the same transaction shows
  // whether a multisig in the wallet set is described as the wallet's own.
  const MULTISIG = KERNEL_OF_ACCOUNT_1;
  const LABEL = 'Multisig 1 (2-of-3)';
  const MULTISIG_ID = 0xd0000000;
  const stored = [{ address: MULTISIG, label: LABEL }];
  const kernelConfig = {
    accountType: 'kernel-v3.3',
    factory: KERNEL_V3_3.factory,
    factoryImplementation: KERNEL_V3_3.implementation,
    kernelValidator: KERNEL_V3_3.ecdsaValidator,
    recoveredAccounts: [],
  };
  const w = walletAddressesFor(ACCOUNT_2, 1, null, stored);
  check('walletAddressesFor adds every stored multisig of the network (the EOA stays first)', w.length === 2 && w[0] === ACCOUNT_2 && w[1] === MULTISIG, w);
  const wk = walletAddressesFor(ACCOUNT_2, 1, kernelConfig, stored);
  check('…next to the Kernel counterfactual (EOA, multisig, Kernel)', wk.length === 3 && wk[0] === ACCOUNT_2 && wk[1] === MULTISIG, wk);
  check('…listed once when the multisig is the active account itself (compared over the 20 bytes)',
    JSON.stringify(walletAddressesFor(MULTISIG, MULTISIG_ID, null, [{ address: MULTISIG.toLowerCase(), label: LABEL }])) === JSON.stringify([MULTISIG]));
  check('…a multisig as the active account gets no Kernel counterfactual (its id has no salt)', walletAddressesFor(MULTISIG, MULTISIG_ID, kernelConfig).length === 1);
  check('…a malformed stored address is skipped', walletAddressesFor(ACCOUNT_2, 1, null, [{ address: '0x1234', label: LABEL }]).length === 1);
  check('…and without multisigs the result is unchanged (default argument)', JSON.stringify(walletAddressesFor(ACCOUNT_1, 0, kernelConfig)) === JSON.stringify([ACCOUNT_1, KERNEL_OF_ACCOUNT_1]));

  const decodeWith = async (wallet, hashes) => {
    clearActivityCache();
    const decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet, trackedTokens: [], run: fixedRun });
    return decoder.decodeEntries(hashes);
  };
  // A plain transfer from Account 2 to the multisig, and one from a third
  // party (Burn) to the multisig.
  const TO_MULTISIG = '0x' + '5a'.repeat(32);
  const FROM_OTHER = '0x' + '5b'.repeat(32);
  const plain = (hash, from, to) => ({
    transaction: { hash, from, to, input: '0x', value: '0x1', nonce: '0x1', type: '0x2', chainId: '0xaa36a7', blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32) },
    receipt: { transactionHash: hash, blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32), status: '0x1', logs: [] },
  });
  mode.extraTx = (h) => (h === TO_MULTISIG ? plain(h, ACCOUNT_2, MULTISIG) : h === FROM_OTHER ? plain(h, BURN, MULTISIG) : null);
  const ids = [H.handleOps, TO_MULTISIG, FROM_OTHER];
  const withMs = await decodeWith(w, ids);
  const without = await decodeWith([ACCOUNT_2], ids);
  check("the multisig's operation in an EntryPoint bundle is the wallet's own, with the multisig as sender",
    render(withMs.get(H.handleOps)) === 'Smart-account operation: sent 0.0001 test ETH to Burn' &&
      withMs.get(H.handleOps).description.userOps.length === 1 && withMs.get(H.handleOps).description.userOps[0].sender === MULTISIG,
    render(withMs.get(H.handleOps)));
  check('…which without the multisig reads as other accounts\' operation', render(without.get(H.handleOps)) === 'Smart-account bundle with 1 operation from other accounts', render(without.get(H.handleOps)));
  check('a transfer to the multisig reads as to "yourself"', render(withMs.get(TO_MULTISIG)) === 'Sent 0.000000000000000001 test ETH to yourself', render(withMs.get(TO_MULTISIG)));
  check('…which without the multisig names a stranger\'s short address', render(without.get(TO_MULTISIG)) === 'Sent 0.000000000000000001 test ETH to 0xD31c…D8FA', render(without.get(TO_MULTISIG)));
  check("a third party's transfer to the multisig reads as received by the wallet", render(withMs.get(FROM_OTHER)) === 'Received 0.000000000000000001 test ETH from Burn', render(withMs.get(FROM_OTHER)));
  check('…which without the multisig is a stranger\'s transaction', render(without.get(FROM_OTHER)) === 'Transaction by Burn to 0xD31c…D8FA', render(without.get(FROM_OTHER)));

  // Mutation: walletAddressesFor without the multisig loop.
  const srcPath = join(here, '..', 'src', 'wallet', 'activity-sentences.ts');
  const original = readFileSync(srcPath, 'utf8');
  const anchor = '    if (/^0x[0-9a-fA-F]{40}$/.test(m.address)) out.push(m.address);\n';
  check('mutation anchor present (multisig loop)', original.includes(anchor));
  const mutantDir = join(here, `.mutants-activity-${process.pid}`);
  mkdirSync(mutantDir, { recursive: true });
  try {
    const rewritten = original
      .replace(anchor, '')
      .replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(dirname(srcPath), spec)).href}'`);
    const file = join(mutantDir, 'activity-sentences.ts');
    writeFileSync(file, rewritten);
    const mutant = await import(pathToFileURL(file).href);
    const mw = mutant.walletAddressesFor(ACCOUNT_2, 1, null, stored);
    const mout = await decodeWith(mw, [H.handleOps]);
    check('M-activity caught: without the multisig loop the multisig\'s operation is "from other accounts"',
      render(mout.get(H.handleOps)) !== render(withMs.get(H.handleOps)), render(mout.get(H.handleOps)));
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

console.log('Pinned staking contracts and account labels (phase 18 item 3 emulator findings 4 and 7e):');
reset();
installFakeNode();
{
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  const word = (v) => '0x' + v.toString(16).padStart(64, '0');
  const ZERO = '0x0000000000000000000000000000000000000000';
  const SEP_STETH = '0x3e3FE7dBc6B4C189E7128855dD526361c49b40Af';
  const SEP_WSTETH = '0xB82381A3fBD3FaFA77B3a7bE693342618240067b';
  const SEP_QUEUE = '0x1583C7b3f4C3B008720E6BcE5726336b0aB25fdd';
  const LOOK_ALIKE = SEP_STETH.slice(0, -1) + 'e';
  const MULTISIG = getAddress('0x944caa404e389b18b2fe251e969edd7a220d0d38');
  const transfer = (token, from, to, amount) => ({ address: token, topics: [TRANSFER, pad(from), pad(to)], data: word(amount) });
  let n = 0;
  const synth = new Map();
  const add = ({ from = ACCOUNT_1, to, input = '0x', value = 0n, logs = [], status = '0x1' }) => {
    n += 1;
    const hash = '0x' + n.toString(16).padStart(2, '0').repeat(32);
    synth.set(hash, {
      transaction: { hash, from: from.toLowerCase(), to, input, value: '0x' + value.toString(16), nonce: '0x1', type: '0x2', chainId: '0xaa36a7', blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32) },
      receipt: { transactionHash: hash, blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32), status, logs },
    });
    return hash;
  };
  const sel = (sig) => toHex(encodeFunctionCall(sig, [])).slice(0, 10);
  const SUBMIT = sel('submit(address)') + '00'.repeat(32);
  const WRAP = toHex(encodeFunctionCall('wrap(uint256)', [{ kind: 'uint256', value: 5n * 10n ** 14n }]));
  const UNWRAP = toHex(encodeFunctionCall('unwrap(uint256)', [{ kind: 'uint256', value: 4n * 10n ** 14n }]));
  const APPROVE = toHex(encodeFunctionCall('approve(address,uint256)', [{ kind: 'address', value: SEP_WSTETH }, { kind: 'uint256', value: 5n * 10n ** 14n }]));
  const CLAIM = toHex(encodeFunctionCall('claimWithdrawal(uint256)', [{ kind: 'uint256', value: 7n }]));
  const stake = add({ to: SEP_STETH, input: SUBMIT, value: 2n * 10n ** 14n, logs: [transfer(SEP_STETH, ZERO, ACCOUNT_1, 199_999_999_999_999n)] });
  const shortcut = add({ to: SEP_WSTETH, value: 5n * 10n ** 14n, logs: [transfer(SEP_WSTETH, ZERO, ACCOUNT_1, 481_826_550_135_307n)] });
  const wrap = add({ to: SEP_WSTETH, input: WRAP, logs: [transfer(SEP_STETH, ACCOUNT_1, SEP_WSTETH, 5n * 10n ** 14n), transfer(SEP_WSTETH, ZERO, ACCOUNT_1, 481_826_550_135_307n)] });
  const unwrap = add({ to: SEP_WSTETH, input: UNWRAP, logs: [transfer(SEP_WSTETH, ACCOUNT_1, ZERO, 4n * 10n ** 14n), transfer(SEP_STETH, SEP_WSTETH, ACCOUNT_1, 415_087_130_304_122n)] });
  const approve = add({ to: SEP_STETH, input: APPROVE });
  const claim = add({ to: SEP_QUEUE, input: CLAIM });
  const lookAlike = add({ to: LOOK_ALIKE, input: SUBMIT, value: 2n * 10n ** 14n });
  const wrongSelector = add({ to: SEP_STETH, input: '0xdeadbeef', value: 2n * 10n ** 14n });
  const failedStake = add({ to: SEP_STETH, input: SUBMIT, value: 2n * 10n ** 14n, status: '0x0' });
  const fromMultisig = add({ from: MULTISIG, to: ACCOUNT_1, value: 10n ** 14n });
  mode.extraTx = (h) => synth.get(h) ?? null;

  const { knownStakingTokensForChain } = await import('../src/wallet/tokens.ts');
  const { stakingContractAt } = await import('../src/wallet/risk.ts');
  const decodeAll = async (wallet, ids) => {
    clearActivityCache();
    const decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet, trackedTokens: knownStakingTokensForChain(SEPOLIA), run: fixedRun, maxPerCall: 20 });
    return decoder.decodeEntries(ids);
  };
  const out = await decodeAll([ACCOUNT_1], [stake, shortcut, wrap, unwrap, approve, claim, lookAlike, wrongSelector, failedStake]);
  const pinned = { stakingContractAt: (a) => stakingContractAt(SEPOLIA, a) };
  const exact = (name, id, want, over = pinned) => check(name, render(out.get(id), over) === want, render(out.get(id), over));
  exact('stake → stETH: "Staked … with Lido (stETH contract …): received … stETH"', stake,
    'Staked 0.0002 test ETH with Lido (stETH contract 0x3e3F…40Af): received 0.000199999999999999 stETH');
  exact('…without the lookup the old generic sentence (the emulator pass\'s wording)', stake,
    'Called 0x3e3F…40Af with 0.0002 test ETH: received 0.000199999999999999 stETH', {});
  exact('stake → wstETH (the plain transfer to the wstETH contract)', shortcut,
    'Staked 0.0005 test ETH with Lido and wrapped it into wstETH (wstETH contract 0xB823…067b): received 0.000481826550135307 wstETH');
  exact('wrap', wrap, 'Wrapped stETH into wstETH with Lido (wstETH contract 0xB823…067b): sent 0.0005 stETH, received 0.000481826550135307 wstETH');
  exact('unwrap', unwrap, 'Unwrapped wstETH into stETH with Lido (wstETH contract 0xB823…067b): sent 0.0004 wstETH, received 0.000415087130304122 stETH');
  exact('the exact approval before a wrap names the pinned spender', approve, 'Approved stETH for Lido wstETH contract 0xB823…067b (up to 0.0005 stETH)');
  // Phase 19 item 4 (the merged-history pass's row 21): the indexer lists
  // this approval as a zero-value native row with no token movement; once
  // decoded it shows no amount instead of "−0 test ETH".
  {
    const hist = await import('../src/wallet/history.ts');
    const row = { id: approve, uid: `${approve}:external`, direction: 'out', amount: 0n, timestamp: null, confirmed: true };
    const none = new Set();
    check('LIVE SENTENCE row 21 — "Approved stETH for Lido wstETH contract …": its zero-value native row shows no amount once decoded',
      hist.hidesZeroNativeAmount(row, none, out.get(approve).description) === true && hist.hidesZeroNativeAmount(row, none) === false);
    check('…the stake (value 0.0002) and the stETH-paying calls keep their amount rules (a stake row is not zero)',
      hist.hidesZeroNativeAmount({ ...row, id: stake, amount: 2n * 10n ** 14n }, none, out.get(stake).description) === false);
  }
  exact('claim from the withdrawal queue', claim, 'Claimed withdrawn test ETH from Lido (withdrawal queue contract 0x1583…5fdd)');
  exact('a look-alike address (last digit changed) keeps the generic sentence', lookAlike, 'Called 0x3E3F…40AE with 0.0002 test ETH');
  exact('an unpinned selector on the pinned contract keeps the generic wording (the contract still named)', wrongSelector,
    'Called Lido stETH contract 0x3e3F…40Af with 0.0002 test ETH');
  exact('a failed stake: "tried to stake"', failedStake,
    'Failed: tried to stake 0.0002 test ETH with Lido (stETH contract 0x3e3F…40Af); only the network fee was paid');
  exact('the pinned address on another network (Hoodi lookup) is not described', stake,
    'Called 0x3e3F…40Af with 0.0002 test ETH: received 0.000199999999999999 stETH', { stakingContractAt: (a) => stakingContractAt('eip155:560048', a) });
  exact('Hide amounts masks the staked amount too', stake,
    'Staked •••• test ETH with Lido (stETH contract 0x3e3F…40Af): received •••• stETH', { ...pinned, hidden: true });

  // Phase 20 follow-up: an UNTRACKED pinned staking token reads as the Send
  // preview names it ("stETH (pinned staking token)", simulation.ts), not
  // "stETH (untracked token 0x…)". The decoder's metadata comes from
  // simulation.ts resolveTokenMeta, which sets `pinned` by exact address on
  // the decoder's own network; the engine labels it.
  {
    const erc20Abi = new Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function transfer(address,uint256)']);
    const decodeWith = async (trackedTokens, ids, chainCaip2 = SEPOLIA) => {
      clearActivityCache();
      const decoder = createActivityDecoder({ chainCaip2, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1], trackedTokens, run: fixedRun, maxPerCall: 20 });
      return decoder.decodeEntries(ids);
    };
    const FOO = getAddress('0x4444444444444444444444444444444444444444');
    const fooSend = add({ to: FOO, input: erc20Abi.encodeFunctionData('transfer', [BURN, 10n ** 18n]), logs: [transfer(FOO, ACCOUNT_1, BURN, 10n ** 18n)] });
    const lookAlikeSend = add({ to: LOOK_ALIKE, input: erc20Abi.encodeFunctionData('transfer', [BURN, 10n ** 18n]), logs: [transfer(LOOK_ALIKE, ACCOUNT_1, BURN, 10n ** 18n)] });
    // The look-alike contract answers symbol() "stETH" and decimals() 18, as a
    // spoof would; so does the real address when it is read on-chain. FOO is
    // an ordinary unknown token. (Sepolia USDC and EURC are not usable here:
    // the engine names them from its own known-contract table.)
    const fakeMeta = new Map([[LOOK_ALIKE.toLowerCase(), 'stETH'], [SEP_STETH.toLowerCase(), 'stETH'], [FOO.toLowerCase(), 'FOO']]);
    mode.rpc = (method, params) => {
      const symbol = method === 'eth_call' ? fakeMeta.get(String(params[0].to).toLowerCase()) : undefined;
      if (symbol === undefined) return undefined;
      const data = params[0].data;
      if (data === SEL['symbol()']) return erc20Abi.encodeFunctionResult('symbol', [symbol]);
      if (data === SEL['decimals()']) return erc20Abi.encodeFunctionResult('decimals', [18]);
      return undefined;
    };
    try {
      const untracked = await decodeWith([], [stake, fooSend, lookAlikeSend]);
      check('PINNED, UNTRACKED: the decoder marks Sepolia stETH pinned (resolveTokenMeta, exact address on this network)',
        untracked.get(stake).tokens[SEP_STETH.toLowerCase()]?.pinned === true && untracked.get(stake).tokens[SEP_STETH.toLowerCase()]?.tracked === false,
        untracked.get(stake).tokens);
      check('PINNED, UNTRACKED: "stETH (pinned staking token)", as the Send preview names it',
        render(untracked.get(stake), pinned) === 'Staked 0.0002 test ETH with Lido (stETH contract 0x3e3F…40Af): received 0.000199999999999999 stETH (pinned staking token)',
        render(untracked.get(stake), pinned));
      check('…the same sentence never says "untracked token" for the pinned address',
        !render(untracked.get(stake), pinned).includes('untracked token'), render(untracked.get(stake), pinned));
      const tracked = await decodeWith(knownStakingTokensForChain(SEPOLIA), [stake]);
      check('PINNED, TRACKED: the plain symbol "stETH" (tracking wins over the pinned tag)',
        render(tracked.get(stake), pinned) === 'Staked 0.0002 test ETH with Lido (stETH contract 0x3e3F…40Af): received 0.000199999999999999 stETH',
        render(tracked.get(stake), pinned));
      check('NOT PINNED, UNTRACKED: an ordinary unknown token keeps "(untracked token 0x…)"',
        render(untracked.get(fooSend)) === 'Sent 1 FOO (untracked token 0x4444…4444) to Burn', render(untracked.get(fooSend)));
      check('…a look-alike contract answering symbol() "stETH" is never pinned by its symbol (one digit off the pinned address)',
        untracked.get(lookAlikeSend).tokens[LOOK_ALIKE.toLowerCase()]?.pinned !== true &&
          render(untracked.get(lookAlikeSend)) === 'Sent 1 stETH (untracked token 0x3E3F…40AE) to Burn',
        render(untracked.get(lookAlikeSend)));
      const otherNetwork = await decodeWith([], [stake], 'eip155:560048');
      check('…the Sepolia stETH address is not pinned under another network\'s table (Hoodi): read on-chain, labelled untracked',
        otherNetwork.get(stake).tokens[SEP_STETH.toLowerCase()]?.pinned !== true &&
          render(otherNetwork.get(stake)).endsWith('received 0.000199999999999999 stETH (untracked token 0x3e3F…40Af)'),
        render(otherNetwork.get(stake)));
    } finally {
      mode.rpc = null;
    }
  }

  // Finding 7e: a multisig's Activity named Account 1 by its short address.
  const labels = activityAccountLabels(
    [{ name: 'Account 1', evmAddress: ACCOUNT_1 }, { name: 'Imported 1 (imported key)', evmAddress: ACCOUNT_2 }, { name: 'Watched? no address', evmAddress: null }],
    [{ address: MULTISIG, label: 'Multisig 2 (2-of-3)' }, { address: '0x1234', label: 'bad' }],
  );
  check('activityAccountLabels: phrase and imported accounts, then multisigs; null and malformed addresses skipped',
    JSON.stringify(labels) === JSON.stringify([
      { address: ACCOUNT_1, label: 'Account 1' },
      { address: ACCOUNT_2, label: 'Imported 1 (imported key)' },
      { address: MULTISIG, label: 'Multisig 2 (2-of-3)' },
    ]), labels);
  check('…an address listed twice keeps its first label',
    activityAccountLabels([{ name: 'Account 1', evmAddress: ACCOUNT_1 }], [{ address: ACCOUNT_1.toLowerCase(), label: 'Multisig X' }]).length === 1);
  const ms = await decodeAll([MULTISIG], [fromMultisig]);
  check('the multisig\'s send to Account 1 names Account 1 with the labels', render(ms.get(fromMultisig), { accountLabels: labels }) === 'Sent 0.0001 test ETH to Account 1',
    render(ms.get(fromMultisig), { accountLabels: labels }));
  check('…and the short address without them (the old wording)', render(ms.get(fromMultisig)) === 'Sent 0.0001 test ETH to 0x772e…F44F', render(ms.get(fromMultisig)));
  check('…a contact saved for that address is still used first',
    render(ms.get(fromMultisig), { accountLabels: labels, contacts: [contact('Main wallet', ACCOUNT_1)] }) === 'Sent 0.0001 test ETH to Main wallet');
  check('…the decoded account itself still reads "yourself" (its label is not used for it)',
    render((await decodeAll([ACCOUNT_1], [fromMultisig])).get(fromMultisig), { accountLabels: labels }) === 'Received 0.0001 test ETH from Multisig 2 (2-of-3)');

  // Mutations of activity-sentences.ts: each must change a pinned sentence.
  const srcPath = join(here, '..', 'src', 'wallet', 'activity-sentences.ts');
  const original = readFileSync(srcPath, 'utf8');
  const mutantDir = join(here, `.mutants-activity-staking-${process.pid}`);
  mkdirSync(mutantDir, { recursive: true });
  let k = 0;
  const mutant = async (from, to) => {
    if (!original.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
    k += 1;
    const file = join(mutantDir, `m${k}-activity-sentences.ts`);
    writeFileSync(file, original.replace(from, to).replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(dirname(srcPath), spec)).href}'`));
    return import(pathToFileURL(file).href);
  };
  try {
    const m1 = await mutant("if (is('lidoSubmit') && call.value > 0n)", 'if (call.value > 0n)');
    check('M-stake-1 caught: without the selector check an unknown call to stETH reads "Staked"',
      /^Staked/.test(m1.renderActivitySentence(out.get(wrongSelector), { nativeSymbol: 'test ETH', hidden: false, contacts: [], networkId: SEPOLIA, ...pinned })));
    const m2 = await mutant('    if (own) return own.label;\n', '');
    check('M-labels caught: without the account labels the multisig\'s send names a short address',
      m2.renderActivitySentence(ms.get(fromMultisig), { nativeSymbol: 'test ETH', hidden: false, contacts: [], networkId: SEPOLIA, accountLabels: labels }) === 'Sent 0.0001 test ETH to 0x772e…F44F');
    const m3 = await mutant("    if (call.value !== 0n) return null;\n    if (is('wstethWrap'))", "    if (is('wstethWrap'))");
    const valued = await decodeAll([ACCOUNT_1], [add({ to: SEP_WSTETH, input: WRAP, value: 1n })]);
    const valuedId = [...valued.keys()][0];
    check('M-stake-2 caught: a wrap carrying a value (cannot happen on the real contract) keeps the generic sentence; the mutant calls it a wrap',
      /^Called/.test(render(valued.get(valuedId), pinned)) &&
        /^Wrapped/.test(m3.renderActivitySentence(valued.get(valuedId), { nativeSymbol: 'test ETH', hidden: false, contacts: [], networkId: SEPOLIA, ...pinned })));
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

console.log('Rocket Pool deposits read from the deposit pool RocketStorage names at the decode (phase 20 item 0 finding 4):');
reset({ chainId: '0x88bb0' });
installFakeNode();
{
  const HOODI = 'eip155:560048';
  const RS = '0x594Fb75D3dc2DFa0150Ad03F99F97817747dd4E1';
  const RETH = '0x7322c24752f79c05FFD1E2a6FCB97020C1C264F1';
  const POOL = '0x425E6f83e27f1676AD78BC39dA79C2C7b33d3Fd8';
  const SETTINGS = '0x86B455e24A9B5541D7703d07A8CE634f0309d2D2';
  const OTHER_POOL = getAddress('0x' + '5a'.repeat(20));
  const ZERO = '0x0000000000000000000000000000000000000000';
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  const word = (v) => '0x' + v.toString(16).padStart(64, '0');
  const keyOf = (name) => toHex(rocketContractAddressKey(name)).slice(2).toLowerCase();
  let registryPool = POOL;
  let registryDown = false;
  mode.rpc = (method, params) => {
    if (method === 'eth_getCode' && [RS, RETH, POOL, SETTINGS, OTHER_POOL].some((a) => a.toLowerCase() === params[0].toLowerCase())) return '0x6080604052';
    if (method === 'eth_call' && params[0].to.toLowerCase() === RS.toLowerCase()) {
      if (registryDown) return undefined; // falls through to the fake's revert
      const key = params[0].data.slice(10).toLowerCase();
      const answer = key === keyOf('rocketDepositPool') ? registryPool : key === keyOf('rocketTokenRETH') ? RETH : key === keyOf('rocketDAOProtocolSettingsDeposit') ? SETTINGS : null;
      return answer ? pad(answer) : undefined;
    }
    return undefined;
  };
  // The live in-app deposit (block 3,799,804): deposit() with 0.01 test ETH
  // to the deposit pool, 9,640,047,229,956,784 rETH minted to the account.
  const DEP = '0x' + 'd0'.repeat(32);
  const depTx = {
    transaction: { hash: DEP, from: ACCOUNT_1.toLowerCase(), to: POOL.toLowerCase(), input: '0xd0e30db0', value: '0x' + (10n ** 16n).toString(16), nonce: '0x1', type: '0x2', chainId: '0x88bb0', blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32) },
    receipt: { transactionHash: DEP, blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32), status: '0x1', logs: [{ address: RETH, topics: [TRANSFER, pad(ZERO), pad(ACCOUNT_1)], data: word(9_640_047_229_956_784n) }] },
  };
  mode.extraTx = (h) => (h === DEP ? depTx : null);
  const { knownStakingTokensForChain } = await import('../src/wallet/tokens.ts');
  const { stakingContractAt } = await import('../src/wallet/risk.ts');
  const decode = async () => {
    clearActivityCache();
    const decoder = createActivityDecoder({ chainCaip2: HOODI, evmChainId: 560048n, wallet: [ACCOUNT_1], trackedTokens: knownStakingTokensForChain(HOODI), run: fixedRun, maxPerCall: 5 });
    return (await decoder.decodeEntries([DEP])).get(DEP);
  };
  const opts = { networkId: HOODI, contacts: [], stakingContractAt: (a) => stakingContractAt(HOODI, a) };
  const WANT = 'Staked 0.01 test ETH with Rocket Pool (deposit pool 0x425E…3Fd8, resolved from RocketStorage): received 0.009640047229956784 rETH';
  const live = await decode();
  check('the decode records the deposit pool RocketStorage names now', live?.rocketDepositPool === POOL, live?.rocketDepositPool);
  check('LIVE SENTENCE — the Hoodi deposit: "Staked 0.01 test ETH with Rocket Pool (deposit pool 0x425E…3Fd8, resolved from RocketStorage): received … rETH"',
    render(live, opts) === WANT, render(live, opts));
  check('…also without the pinned-contract lookup (the resolved pool alone names it)', render(live, { networkId: HOODI, contacts: [] }) === WANT);
  registryPool = OTHER_POOL;
  const moved = await decode();
  check('control: RocketStorage names a DIFFERENT pool at the decode → no pool recorded, the generic "Called 0x425E…3Fd8" sentence',
    moved?.rocketDepositPool === undefined && render(moved, opts) === 'Called 0x425E…3Fd8 with 0.01 test ETH: received 0.009640047229956784 rETH', render(moved, opts));
  registryPool = POOL;
  registryDown = true;
  const down = await decode();
  check('control: the registry unreadable → the generic sentence (never a remembered value)', down?.rocketDepositPool === undefined && /^Called 0x425E…3Fd8/.test(render(down, opts)));
  registryDown = false;
  check('rocketDepositPoolForDescription: null on a chain without a Rocket Pool deployment (no request)',
    (await rocketDepositPoolForDescription(async () => { throw new Error('no request expected'); }, 'eip155:11155111', live.description)) === null);
  const fmt = { native: (v) => `${v} wei` };
  check('rocketDepositPhrase: only deposit() with a value to exactly that pool',
    rocketDepositPhrase(POOL, { to: POOL.toLowerCase(), selector: '0xd0e30db0', value: 1n }, fmt) !== null &&
      rocketDepositPhrase(POOL, { to: OTHER_POOL, selector: '0xd0e30db0', value: 1n }, fmt) === null &&
      rocketDepositPhrase(POOL, { to: POOL, selector: '0xd0e30db1', value: 1n }, fmt) === null &&
      rocketDepositPhrase(POOL, { to: POOL, selector: '0xd0e30db0', value: 0n }, fmt) === null &&
      rocketDepositPhrase(null, { to: POOL, selector: '0xd0e30db0', value: 1n }, fmt) === null);
  // Mutant: the phrase without its address comparison describes a deposit to
  // a pool other than the one RocketStorage named.
  const srcPath = join(here, '..', 'src', 'wallet', 'activity-sentences.ts');
  const original = readFileSync(srcPath, 'utf8');
  const from = 'if (!pool || call.to.toLowerCase() !== pool.toLowerCase() || call.value <= 0n) return null;';
  check('mutation anchor present (deposit pool comparison)', original.includes(from));
  const mutantDir = join(here, `.mutants-activity-rocket-${process.pid}`);
  mkdirSync(mutantDir, { recursive: true });
  try {
    const file = join(mutantDir, 'activity-sentences.ts');
    writeFileSync(file, original.replace(from, 'if (!pool || call.value <= 0n) return null;').replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(dirname(srcPath), spec)).href}'`));
    const m = await import(pathToFileURL(file).href);
    const stale = { ...live, rocketDepositPool: OTHER_POOL };
    check('M-rocket caught: a pool other than the call target is not described (real) but is by the mutant',
      /^Called 0x425E…3Fd8/.test(render(stale, opts)) && /^Staked/.test(m.renderActivitySentence(stale, { nativeSymbol: 'test ETH', hidden: false, ...opts })));
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

console.log("Whose Activity it is: \"yourself\" only for the account's own addresses (2026-10-11 re-check, findings 2 and 3):");
reset();
installFakeNode();
{
  // The recorded addresses of the emulator pass (AGENTS.md, phase 17 item 1
  // and the 2026-10-11 re-check): Account 1 0x772e…F44F, its Kernel smart
  // account 0xD31c…D8FA, Account 2 0xb699…81fE, and Multisig 2 (2-of-3)
  // 0x944c…0d38. The two transactions are rebuilt from the recorded facts
  // (sender, recipient, 0.0006 test ETH) — their receipts are not among the
  // pinned fixtures, so they are synthetic with the real addresses.
  const MULTISIG = getAddress('0x944caa404e389b18b2fe251e969edd7a220d0d38');
  const MULTISIG_ID = 0xd0000000;
  const kernelConfig = {
    accountType: 'kernel-v3.3',
    factory: KERNEL_V3_3.factory,
    factoryImplementation: KERNEL_V3_3.implementation,
    kernelValidator: KERNEL_V3_3.ecdsaValidator,
    recoveredAccounts: [],
  };
  const accounts = [
    { index: 0, name: 'Account 1', evmAddress: ACCOUNT_1 },
    { index: 1, name: 'Account 2', evmAddress: ACCOUNT_2 },
  ];
  const multisigs = [{ address: MULTISIG, label: 'Multisig 2 (2-of-3)' }];
  const KERNEL_OF_ACCOUNT_2 = walletAddressesFor(ACCOUNT_2, 1, kernelConfig)[1];

  const a1 = activityAddressSets({ eoa: ACCOUNT_1, accountIndex: 0, aa: kernelConfig, accounts, multisigs });
  check('Account 1: "yourself" is its address and its own smart account', JSON.stringify(a1.self) === JSON.stringify([ACCOUNT_1, KERNEL_OF_ACCOUNT_1]), a1.self);
  check("…decoded as the wallet's own: those, Account 2's smart account and the multisig — never Account 2's own address",
    JSON.stringify(a1.wallet) === JSON.stringify([ACCOUNT_1, KERNEL_OF_ACCOUNT_1, KERNEL_OF_ACCOUNT_2, MULTISIG]) && !a1.wallet.includes(ACCOUNT_2), a1.wallet);
  check('…labels: every account, then their smart accounts ("Account 1’s smart account"), then the multisig',
    JSON.stringify(a1.labels) === JSON.stringify([
      { address: ACCOUNT_1, label: 'Account 1' },
      { address: ACCOUNT_2, label: 'Account 2' },
      { address: KERNEL_OF_ACCOUNT_1, label: 'Account 1’s smart account' },
      { address: KERNEL_OF_ACCOUNT_2, label: 'Account 2’s smart account' },
      { address: MULTISIG, label: 'Multisig 2 (2-of-3)' },
    ]), a1.labels);
  const ms = activityAddressSets({ eoa: MULTISIG, accountIndex: MULTISIG_ID, aa: kernelConfig, accounts, multisigs });
  check('Multisig 2 active: "yourself" is only the multisig; both Kernel accounts are decoded and named',
    JSON.stringify(ms.self) === JSON.stringify([MULTISIG]) &&
      JSON.stringify(ms.wallet) === JSON.stringify([MULTISIG, KERNEL_OF_ACCOUNT_1, KERNEL_OF_ACCOUNT_2]), ms);
  const noAa = activityAddressSets({ eoa: ACCOUNT_1, accountIndex: 0, aa: null, accounts, multisigs });
  check('without smart-account settings: the account and the multisigs; labels as before (no smart accounts)',
    JSON.stringify(noAa.wallet) === JSON.stringify([ACCOUNT_1, MULTISIG]) &&
      JSON.stringify(noAa.labels) === JSON.stringify(activityAccountLabels(accounts, multisigs)), noAa);
  check('activityAccountLabels without aa is unchanged by the index field', activityAccountLabels(accounts, multisigs).length === 3);

  const ETH_0_0006 = 600_000_000_000_000n;
  const hex = (v) => '0x' + v.toString(16);
  const SEND_TO_MS = '0x' + '6a'.repeat(32);
  const TOPUP_BY_KERNEL = '0x' + '6b'.repeat(32);
  const plain = (hash, from, to, value) => ({
    transaction: { hash, from: from.toLowerCase(), to: to.toLowerCase(), input: '0x', value: hex(value), nonce: '0x1', type: '0x2', chainId: '0xaa36a7', blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32) },
    receipt: { transactionHash: hash, blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32), status: '0x1', logs: [] },
  });
  // Account 1's Kernel account sends 0.0006 test ETH to the multisig in an
  // EntryPoint bundle submitted by a bundler (a stranger's EOA).
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  const word = (v) => v.toString(16).padStart(64, '0');
  const kernelTopUp = (() => {
    const callData = toHex(encodeKernelExecute([{ to: MULTISIG, value: ETH_0_0006, data: new Uint8Array() }]));
    // The same encoding the engine test uses (ethers' ABI coder).
    const op = [KERNEL_OF_ACCOUNT_1, 32n, '0x', callData, '0x' + '00'.repeat(32), 0n, '0x' + '00'.repeat(32), '0x', '0x'];
    let input;
    try {
      input = new Interface(['function handleOps((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)[],address)'])
        .encodeFunctionData('handleOps', [[op], BURN]);
    } catch {
      input = null;
    }
    return {
      transaction: { hash: TOPUP_BY_KERNEL, from: BURN.toLowerCase(), to: ENTRYPOINT_V07.toLowerCase(), input, value: '0x0', nonce: '0x2', type: '0x2', chainId: '0xaa36a7', blockNumber: '0x11', blockHash: '0x' + 'ce'.repeat(32) },
      receipt: {
        transactionHash: TOPUP_BY_KERNEL, blockNumber: '0x11', blockHash: '0x' + 'ce'.repeat(32), status: '0x1',
        logs: [{
          address: ENTRYPOINT_V07,
          topics: [USER_OPERATION_EVENT_TOPIC, '0x' + '90'.repeat(32), pad(KERNEL_OF_ACCOUNT_1), pad('0x0000000000000000000000000000000000000000')],
          data: '0x' + word(32n) + word(1n) + word(1234n) + word(99n),
        }],
      },
    };
  })();
  check('the synthetic bundle encodes (engine encoder)', typeof kernelTopUp.transaction.input === 'string');
  mode.extraTx = (h) => (h === SEND_TO_MS ? plain(h, ACCOUNT_1, MULTISIG, ETH_0_0006) : h === TOPUP_BY_KERNEL ? kernelTopUp : null);
  const decodeWith = async (wallet, hashes) => {
    clearActivityCache();
    const decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet, trackedTokens: [], run: fixedRun });
    return decoder.decodeEntries(hashes);
  };
  const renderAs = (decoded, sets) => render(decoded, { contacts: [], accountLabels: sets.labels, selfAddresses: sets.self });

  const fromA1 = await decodeWith(a1.wallet, [SEND_TO_MS]);
  check('LIVE CASE 1 — Account 1\'s side: "Sent 0.0006 test ETH to Multisig 2 (2-of-3)" (was "…to yourself")',
    renderAs(fromA1.get(SEND_TO_MS), a1) === 'Sent 0.0006 test ETH to Multisig 2 (2-of-3)', renderAs(fromA1.get(SEND_TO_MS), a1));
  check('…without the self list (the old wording) it read "to yourself"',
    render(fromA1.get(SEND_TO_MS), { contacts: [], accountLabels: a1.labels }) === 'Sent 0.0006 test ETH to yourself');
  const fromMs = await decodeWith(ms.wallet, [SEND_TO_MS, TOPUP_BY_KERNEL]);
  check("…the multisig's side: \"Received 0.0006 test ETH from Account 1\"",
    renderAs(fromMs.get(SEND_TO_MS), ms) === 'Received 0.0006 test ETH from Account 1', renderAs(fromMs.get(SEND_TO_MS), ms));
  check('LIVE CASE 2 — the multisig\'s side of a top-up from Account 1\'s smart account names it, with the amount',
    renderAs(fromMs.get(TOPUP_BY_KERNEL), ms) === 'Smart-account operation by Account 1’s smart account: sent 0.0006 test ETH to yourself',
    renderAs(fromMs.get(TOPUP_BY_KERNEL), ms));
  const oldWallet = walletAddressesFor(MULTISIG, MULTISIG_ID, kernelConfig, multisigs);
  const oldMs = await decodeWith(oldWallet, [TOPUP_BY_KERNEL]);
  check('…which the old decode set read as "Smart-account bundle with 1 operation from other accounts"',
    render(oldMs.get(TOPUP_BY_KERNEL), { contacts: [], accountLabels: ms.labels }) === 'Smart-account bundle with 1 operation from other accounts');
  const fromA1Bundle = await decodeWith(a1.wallet, [TOPUP_BY_KERNEL]);
  check("…and Account 1's own side of the same bundle is its own operation, to the multisig by name",
    renderAs(fromA1Bundle.get(TOPUP_BY_KERNEL), a1) === 'Smart-account operation: sent 0.0006 test ETH to Multisig 2 (2-of-3)',
    renderAs(fromA1Bundle.get(TOPUP_BY_KERNEL), a1));
  check('…a contact saved for the multisig address is still used first',
    render(fromA1.get(SEND_TO_MS), { contacts: [contact('Team vault', MULTISIG)], accountLabels: a1.labels, selfAddresses: a1.self }) === 'Sent 0.0006 test ETH to Team vault');
  check('…the decoded row carries the operation\'s UserOperation hash (a note saved under it is found on this row)',
    fromA1Bundle.get(TOPUP_BY_KERNEL)?.description.userOps.map((o) => o.userOpHash).join() === '0x' + '90'.repeat(32));

  // Finding F1 (pass of 2026-10-11): tx 0x341db91c…, Account 1 → its own
  // Kernel account, 0.0015 test ETH. Listed once (the account's own row);
  // its sentence names the smart account instead of "yourself".
  check('Account 1: its own smart account is named "your smart account"; a multisig has no such name',
    JSON.stringify(a1.selfNames) === JSON.stringify([{ address: KERNEL_OF_ACCOUNT_1, name: 'your smart account' }]) &&
      JSON.stringify(ms.selfNames) === '[]', a1.selfNames);
  const TOPUP_0X341 = '0x341db91c' + '00'.repeat(28);
  const ETH_0_0015 = 1_500_000_000_000_000n;
  mode.extraTx = (hh) => (hh === TOPUP_0X341 ? plain(hh, ACCOUNT_1, KERNEL_OF_ACCOUNT_1, ETH_0_0015) : null);
  const topUp = await decodeWith(a1.wallet, [TOPUP_0X341]);
  const withNames = render(topUp.get(TOPUP_0X341), { contacts: [], accountLabels: a1.labels, selfAddresses: a1.self, selfNames: a1.selfNames });
  check('LIVE CASE 0x341db91c… — "Sent 0.0015 test ETH to your smart account" (was "…to yourself")',
    withNames === 'Sent 0.0015 test ETH to your smart account', withNames);
  check('…without the names (the previous wording) it read "to yourself"',
    render(topUp.get(TOPUP_0X341), { contacts: [], accountLabels: a1.labels, selfAddresses: a1.self }) === 'Sent 0.0015 test ETH to yourself');
  check("…the smart account's own operations still read \"Smart-account operation\" with the names on",
    render(fromA1Bundle.get(TOPUP_BY_KERNEL), { contacts: [], accountLabels: a1.labels, selfAddresses: a1.self, selfNames: a1.selfNames }) ===
      'Smart-account operation: sent 0.0006 test ETH to Multisig 2 (2-of-3)');
  mode.extraTx = (h) => (h === SEND_TO_MS ? plain(h, ACCOUNT_1, MULTISIG, ETH_0_0006) : h === TOPUP_BY_KERNEL ? kernelTopUp : null);
  const screenSrc = readFileSync(join(here, '..', 'src', 'screens', 'ActivityScreen.tsx'), 'utf8');
  check('…the screen passes the names to the renderer (source)',
    screenSrc.includes('selfNames: sentences.selfNames,') && screenSrc.includes('selfNames: sets.selfNames,'));

  // Mutation of the app glue: the renderer without selfAddresses.
  const srcPath = join(here, '..', 'src', 'wallet', 'activity-sentences.ts');
  const original = readFileSync(srcPath, 'utf8');
  const anchorSelf = "    ...(options.selfAddresses ? { selfAddresses: options.selfAddresses } : {}),\n";
  const anchorSets = "      others.push(...walletAddressesFor(a.evmAddress, a.index, input.aa).slice(1));\n";
  check('mutation anchors present (self list, other smart accounts)', original.includes(anchorSelf) && original.includes(anchorSets));
  const mutantDir = join(here, `.mutants-activity-self-${process.pid}`);
  mkdirSync(mutantDir, { recursive: true });
  try {
    const load = async (name, from, to) => {
      const file = join(mutantDir, `${name}-activity-sentences.ts`);
      writeFileSync(file, original.replace(from, to).replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(dirname(srcPath), spec)).href}'`));
      return import(pathToFileURL(file).href);
    };
    const m1 = await load('m1', anchorSelf, '');
    check('M-self-1 caught: without the self list the send to the multisig reads "to yourself" again',
      m1.renderActivitySentence(fromA1.get(SEND_TO_MS), { nativeSymbol: 'test ETH', hidden: false, contacts: [], networkId: SEPOLIA, accountLabels: a1.labels, selfAddresses: a1.self }) === 'Sent 0.0006 test ETH to yourself');
    const m2 = await load('m2', anchorSets, '');
    const mSets = m2.activityAddressSets({ eoa: MULTISIG, accountIndex: MULTISIG_ID, aa: kernelConfig, accounts, multisigs });
    const mOut = await decodeWith(mSets.wallet, [TOPUP_BY_KERNEL]);
    check("M-self-2 caught: without the other accounts' smart accounts the top-up is \"from other accounts\" again",
      renderAs(mOut.get(TOPUP_BY_KERNEL), mSets) === 'Smart-account bundle with 1 operation from other accounts', renderAs(mOut.get(TOPUP_BY_KERNEL), mSets));
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }

  // The smart account whose history Activity lists next to the account (finding 4).
  check('historySmartAccountFor: the Kernel counterfactual of a regular account',
    historySmartAccountFor(ACCOUNT_1, 0, kernelConfig) === KERNEL_OF_ACCOUNT_1);
  check('…none without settings, for SimpleAccount, for an EIP-7702 owner, for a multisig or a watch-only id',
    historySmartAccountFor(ACCOUNT_1, 0, null) === null &&
      historySmartAccountFor(ACCOUNT_1, 0, { ...kernelConfig, accountType: 'simple' }) === null &&
      historySmartAccountFor(ACCOUNT_1, 0, { ...kernelConfig, eip7702Owners: [ACCOUNT_1.toLowerCase()] }) === null &&
      historySmartAccountFor(MULTISIG, MULTISIG_ID, kernelConfig) === null &&
      historySmartAccountFor(ACCOUNT_2, 0xc0000000, kernelConfig) === null);
  check('…a recovered account attached to this owner wins over the counterfactual',
    historySmartAccountFor(ACCOUNT_1, 0, { ...kernelConfig, recoveredAccounts: [{ owner: ACCOUNT_1.toLowerCase(), account: BURN }] }) === BURN);
  check('…an imported account (id 2^31) uses salt 0',
    historySmartAccountFor(ACCOUNT_2, 0x80000000, kernelConfig) === walletAddressesFor(ACCOUNT_2, 0, kernelConfig)[1]);
}

console.log("The smart account's history next to the account's own, merged in time order (2026-10-11 pass, findings F1 and F2):");
{
  const sah = await import('../src/wallet/smart-account-history.ts');
  const hist = await import('../src/wallet/history.ts');
  const notes = await import('../src/wallet/notes.ts');
  const SMART = KERNEL_OF_ACCOUNT_1;
  const h = (n) => '0x' + n.toString(16).padStart(64, '0');
  const big = (v) => (typeof v === 'bigint' ? v.toString() : v);
  /** A history entry as the engine's indexer provider makes it. */
  const e = (n, block, direction, amount, uid = `${h(n)}:external`) => ({
    id: h(n), uid, timestamp: 1_790_000_000 + block * 12, confirmed: true, blockHeight: block, direction, amount,
  });
  /** A cursored stream over fixed pages; `failAt` makes that fetch (0-based) reject once. */
  const streamOf = (group, pages, { failAt = -1, log = [] } = {}) => {
    let calls = 0;
    return {
      group,
      log,
      async fetch(cursor) {
        const n = calls++;
        log.push(`${group}:${cursor ?? 'first'}`);
        if (n === failAt) throw new TypeError(`fetch failed: simulated ${group} failure`);
        const index = cursor === undefined ? 0 : Number(cursor);
        return { entries: pages[index] ?? [], ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}) };
      },
    };
  };
  /** Every page of a feed until it has no more (bounded). */
  const drain = async (feed, max = 40) => {
    const pages = [];
    for (let i = 0; i < max; i++) {
      await feed.fill();
      const page = feed.take();
      pages.push(page);
      if (!page.hasMore) break;
    }
    return pages;
  };
  const heights = (entries) => entries.map((x) => x.blockHeight);
  const nonIncreasing = (entries) => entries.every((x, i) => i === 0 || entries[i - 1].blockHeight >= x.blockHeight);
  const keyOf = (x) => `${sah.isSmartAccountEntry(x) ? 'sa' : 'own'}:${x.uid}`;

  // Case A — the account's own pages end EARLIER (older) than the smart
  // account's: own sent [100, 60] then [50, 5]; own received [95, 94] (one
  // page); smart sent [99, 98] then [70, 20]; smart received EMPTY.
  const ownSent = [[e(1, 100, 'out', 1n), e(2, 60, 'out', 2n)], [e(3, 50, 'out', 3n), e(4, 5, 'out', 4n)]];
  const ownReceived = [[e(5, 95, 'in', 5n), e(6, 94, 'in', 6n)]];
  const smartSent = [[e(7, 99, 'out', 7n), e(8, 98, 'out', 8n)], [e(9, 70, 'out', 9n), e(10, 20, 'out', 10n)]];
  const all = [...ownSent.flat(), ...ownReceived.flat(), ...smartSent.flat()];
  const feedA = sah.createMergedHistoryFeed(
    [streamOf('own', ownSent), streamOf('own', ownReceived), streamOf('smart', smartSent), streamOf('smart', [[]])],
    { pageTarget: 3 },
  );
  const pagesA = await drain(feedA);
  const listedA = pagesA.flatMap((p) => p.entries);
  check('A (own pages end earlier): the whole list is in time order across pages', nonIncreasing(listedA), heights(listedA));
  check('…every entry listed exactly once, nothing skipped', listedA.length === all.length && new Set(listedA.map(keyOf)).size === all.length, listedA.map(keyOf));
  check('…several pages, each in time order, each older than the one before',
    pagesA.length > 1 && pagesA.every((p) => nonIncreasing(p.entries)) &&
      pagesA.every((p, i) => i === 0 || p.entries.length === 0 || pagesA.slice(0, i).flatMap((q) => q.entries).every((x) => x.blockHeight >= p.entries[0].blockHeight)),
    pagesA.map((p) => heights(p.entries)));
  check("…the account's own entries are the provider's own objects; the smart account's are marked copies",
    listedA.filter((x) => !sah.isSmartAccountEntry(x)).every((x) => all.includes(x)) &&
      listedA.filter(sah.isSmartAccountEntry).every((x) => x.uid.startsWith('smart-account:') && !all.includes(x)));
  check('…the last page says there is no more, and the feed reports the smart account as included',
    pagesA.at(-1).hasMore === false && pagesA.every((p) => p.smartAccount === 'included'));

  // Case B — vice versa: the smart account's pages end earlier; the own
  // received stream is empty and the own sent stream ends first.
  const feedB = sah.createMergedHistoryFeed(
    [
      streamOf('own', [[e(21, 200, 'out', 1n), e(22, 199, 'out', 1n)]]),
      streamOf('own', [[]]),
      streamOf('smart', [[e(23, 210, 'out', 1n), e(24, 150, 'out', 1n)], [e(25, 100, 'out', 1n)], [e(26, 10, 'out', 1n)]]),
      streamOf('smart', [[e(27, 205, 'in', 1n), e(28, 120, 'in', 1n)], [e(29, 11, 'in', 1n)]]),
    ],
    { pageTarget: 2 },
  );
  const listedB = (await drain(feedB)).flatMap((p) => p.entries);
  check('B (smart pages end earlier, one stream ends first, one is empty): time order and completeness',
    nonIncreasing(listedB) && listedB.length === 9 && new Set(listedB.map(keyOf)).size === 9, heights(listedB));

  // Case C — THE LIVE CASE (tx 0x341db91c…, Account 1 → its Kernel account,
  // 0.0015): the smart account's page 1 holds the transfer while Account
  // 1's own row arrives only on its page 2. Listed ONCE, as Account 1's own
  // row (the same object), marked as involving the smart account.
  const TOPUP = 0x341db91c;
  const ownTopUp = e(TOPUP, 300, 'out', 1_500_000_000_000_000n);
  const smartTopUp = e(TOPUP, 300, 'in', 1_500_000_000_000_000n);
  const feedC = sah.createMergedHistoryFeed(
    [
      streamOf('own', [[e(31, 400, 'out', 1n), e(32, 350, 'out', 1n)], [ownTopUp, e(33, 100, 'out', 1n)]]),
      streamOf('own', [[]]),
      streamOf('smart', [[e(34, 380, 'out', 1n)]]),
      streamOf('smart', [[smartTopUp, e(35, 200, 'in', 1n)]]),
    ],
    { pageTarget: 1 },
  );
  const pagesC = await drain(feedC);
  const listedC = pagesC.flatMap((p) => p.entries);
  const topUpRows = listedC.filter((x) => x.id === h(TOPUP));
  check('LIVE CASE 0x341db91c…: listed once, even though the smart account fetched it a page earlier',
    topUpRows.length === 1, listedC.map(keyOf));
  check("…as Account 1's own row, the provider's own object (−0.0015), not the smart account's mirror (+0.0015)",
    topUpRows[0] === ownTopUp && !sah.isSmartAccountEntry(topUpRows[0]) && topUpRows[0].direction === 'out');
  check('…marked as involving the smart account (the row shows "with smart account"); other own rows are not',
    sah.involvesSmartAccount(ownTopUp) && !sah.involvesSmartAccount(smartTopUp) &&
      listedC.filter((x) => x !== ownTopUp && !sah.isSmartAccountEntry(x)).every((x) => !sah.involvesSmartAccount(x)));
  check('…and the list stays in time order across its pages', nonIncreasing(listedC) && pagesC.length > 1, pagesC.map((p) => heights(p.entries)));

  // Within one block: the account's own entries first; a self-transfer
  // (listed by both of its streams with one uid) once.
  const selfT = e(41, 500, 'self', 7n);
  const feedD = sah.createMergedHistoryFeed([
    streamOf('own', [[selfT]]),
    streamOf('own', [[{ ...selfT }]]),
    streamOf('smart', [[e(42, 500, 'out', 1n)]]),
    streamOf('smart', [[]]),
  ]);
  const listedD = (await drain(feedD)).flatMap((p) => p.entries);
  check('a self-transfer listed by both one-sided streams appears once; within a block own rows come first',
    listedD.map(keyOf).join(',') === `own:${h(41)}:external,sa:smart-account:${h(42)}:external`, listedD.map(keyOf));

  // A smart-account stream failing MID-WAY: its second fetch fails.
  const log = [];
  const feedE = sah.createMergedHistoryFeed(
    [
      streamOf('own', [[e(51, 100, 'out', 1n), e(52, 80, 'out', 1n)], [e(53, 40, 'out', 1n)]], { log }),
      streamOf('own', [[]], { log }),
      streamOf('smart', [[e(54, 90, 'out', 1n)], [e(55, 60, 'out', 1n)], [e(56, 30, 'out', 1n)]], { failAt: 1, log }),
      streamOf('smart', [[e(57, 95, 'in', 1n)]], { log }),
    ],
    { pageTarget: 2 },
  );
  const pagesE = await drain(feedE);
  const listedE = pagesE.flatMap((p) => p.entries);
  check("a smart-account stream failing mid-way: the account's own entries are all listed, in time order",
    nonIncreasing(listedE) && [51, 52, 53].every((n) => listedE.some((x) => x.id === h(n) && !sah.isSmartAccountEntry(x))), listedE.map(keyOf));
  check('…the smart account is reported failed from that page on, and its streams are not queried again',
    pagesE.at(-1).smartAccount === 'failed' && !listedE.some((x) => x.id === h(55) || x.id === h(56)) &&
      log.filter((l) => l.startsWith('smart:')).length === 3, { log, status: pagesE.map((p) => p.smartAccount) });

  // The account's own stream failing: the page fails; the next call tries
  // again and nothing is listed twice or skipped.
  const ownLog = [];
  const feedF = sah.createMergedHistoryFeed(
    [
      streamOf('own', [[e(61, 100, 'out', 1n)], [e(62, 50, 'out', 1n)], [e(63, 20, 'out', 1n)]], { failAt: 2, log: ownLog }),
      streamOf('own', [[]]),
    ],
    { pageTarget: 1 },
  );
  await feedF.fill();
  const f1 = feedF.take();
  const f2error = await feedF.fill().then(() => null, (err) => err.message);
  await feedF.fill();
  const f2 = feedF.take();
  check("the account's own stream failing fails the page; the retry lists the rest once",
    f2error === 'fetch failed: simulated own failure' && f1.entries.map((x) => x.id).join() === h(61) &&
      f2.entries.map((x) => x.id).join() === `${h(62)},${h(63)}` && f2.hasMore === false && ownLog.length === 4, { f2error, f1, f2, ownLog });
  check('…a fill() while one is loading returns the same promise', (() => {
    const feed = sah.createMergedHistoryFeed([streamOf('own', [[e(71, 1, 'out', 1n)]])]);
    return feed.fill() === feed.fill();
  })());

  // The real engine provider, one-sided, through indexerHistoryStreams
  // (fake alchemy_getAssetTransfers answers per address and side).
  const t = (hash, block, from, to, category, value, extra = {}) => ({
    hash, blockNum: '0x' + block.toString(16), from: from.toLowerCase(), to: to?.toLowerCase() ?? null, category,
    uniqueId: `${hash}:${category}`, asset: 'ETH', rawContract: { value: '0x' + value.toString(16), decimal: '0x12' },
    metadata: { blockTimestamp: new Date(1_790_000_000_000 + block * 12_000).toISOString() }, ...extra,
  });
  const STAKE_TOP_UP = 747_174_110_161_719n; // the staking bundle's Deposited figure (block 11889779)
  const book = {
    // Account 1: the top-up of its smart account at block 100 and a receive at block 90.
    [`${ACCOUNT_1.toLowerCase()}|fromAddress`]: [[t(h(1), 100, ACCOUNT_1, SMART, 'external', 5n)]],
    [`${ACCOUNT_1.toLowerCase()}|toAddress`]: [[t(h(2), 90, BURN, ACCOUNT_1, 'external', 7n)]],
    // The smart account: a bundle at block 110 (an internal send and the
    // EntryPoint top-up), the top-up from Account 1 at block 100, and on
    // page 2 an internal send at block 95.
    [`${SMART.toLowerCase()}|fromAddress`]: [
      [t(h(3), 110, SMART, BURN, 'internal', 3n, { uniqueId: `${h(3)}:internal:0` }), t(h(3), 110, SMART, ENTRYPOINT_V07, 'internal', STAKE_TOP_UP, { uniqueId: `${h(3)}:internal:1` })],
      [t(h(4), 95, SMART, ACCOUNT_2, 'internal', 2n, { uniqueId: `${h(4)}:internal:0` })],
    ],
    [`${SMART.toLowerCase()}|toAddress`]: [[t(h(1), 100, ACCOUNT_1, SMART, 'external', 5n)]],
  };
  const requests = [];
  const transport = async (method, [params]) => {
    if (method !== 'alchemy_getAssetTransfers') throw new Error(`unexpected ${method}`);
    const side = params.fromAddress ? 'fromAddress' : 'toAddress';
    const address = (params.fromAddress ?? params.toAddress).toLowerCase();
    requests.push(`${address.slice(0, 6)}|${side}|${params.pageKey ?? ''}`);
    const pages = book[`${address}|${side}`] ?? [[]];
    const index = params.pageKey ? Number(params.pageKey) : 0;
    return { transfers: pages[index] ?? [], ...(index + 1 < pages.length ? { pageKey: String(index + 1) } : {}) };
  };
  const streams = hist.indexerHistoryStreams('https://indexer.invalid', ACCOUNT_1, SMART, transport);
  check('indexerHistoryStreams: four one-sided streams (own sent, own received, smart sent, smart received); two without a smart account',
    streams.map((s) => s.group).join() === 'own,own,smart,smart' &&
      hist.indexerHistoryStreams('https://indexer.invalid', ACCOUNT_1, null, transport).length === 2);
  const live = sah.createMergedHistoryFeed(streams);
  await live.fill();
  const livePage = live.take();
  check('the first page queries each stream once (four requests, each ONE side of ONE address), then only the stream holding the others back (the smart account\'s sent side, its page 2)',
    requests.length === 5 && new Set(requests.slice(0, 4)).size === 4 && requests.slice(0, 4).every((r) => r.endsWith('|')) &&
      requests[4] === `${SMART.toLowerCase().slice(0, 6)}|fromAddress|1`, requests);
  check("…the list: the bundle's two smart-account rows (block 110), Account 1's top-up once (block 100, own row), the smart account's send (95), the receive (90)",
    livePage.entries.map((x) => `${x.id.slice(-2)}:${sah.isSmartAccountEntry(x) ? 'sa' : 'own'}:${x.direction}`).join(',') === '03:sa:out,03:sa:out,01:own:out,04:sa:out,02:own:in' &&
      livePage.hasMore === false,
    livePage.entries.map((x) => `${x.id.slice(-2)}:${sah.isSmartAccountEntry(x) ? 'sa' : 'own'}:${x.direction}`));
  const ownTopUpRow = livePage.entries.find((x) => x.id === h(1));
  check('…the top-up row is Account 1\'s own (out, 5 wei), marked as involving the smart account', ownTopUpRow.direction === 'out' && sah.involvesSmartAccount(ownTopUpRow));
  const realTopUp = livePage.entries.find((x) => x.uid === `smart-account:${h(3)}:internal:1`);
  const realSend = livePage.entries.find((x) => x.uid === `smart-account:${h(3)}:internal:0`);
  check('…the engine reports the counterparty of each row (the EntryPoint for the top-up)',
    realTopUp?.counterparty === ENTRYPOINT_V07.toLowerCase() && realSend?.counterparty === BURN.toLowerCase(), livePage.entries.map((x) => x.counterparty));

  // The CSV follows the list's order and has no duplicate rows.
  const csvRows = notes.activityExportRows({
    network: SEPOLIA, networkLabel: 'Ethereum Sepolia', entries: livePage.entries, nativeSymbol: 'test ETH', nativeDecimals: 18,
    notes: notes.indexNotes([]), explorerUrlFor: () => null,
  });
  const csvKeys = csvRows.map((r) => `${r[8]}|${r[2]}|${r[3]}`);
  check('the CSV export: the same order as the list, no duplicate transaction + direction + amount rows',
    csvRows.map((r) => r[8]).join() === livePage.entries.map((x) => x.id).join() && new Set(csvKeys).size === csvKeys.length, csvKeys);
  check('…the direction cell says "(smart account)" on the smart account\'s rows only',
    csvRows.map((r) => r[2]).join(',') === 'Sent (smart account),Sent (smart account),Sent,Sent (smart account),Received', csvRows.map((r) => r[2]));

  // Over several pages of the merged list (case A), no duplicates either.
  const csvA = notes.activityExportRows({
    network: SEPOLIA, networkLabel: 'Ethereum Sepolia', entries: listedA, nativeSymbol: 'test ETH', nativeDecimals: 18,
    notes: notes.indexNotes([]), explorerUrlFor: () => null,
  });
  const keysA = csvA.map((r) => `${r[8]}|${r[2]}|${r[3]}`);
  check('…and across the pages of case A', new Set(keysA).size === keysA.length && csvA.map((r) => r[8]).join() === listedA.map((x) => x.id).join());

  check('the notes: included / failed / skipped (exact)',
    sah.smartAccountHistoryNote('included', SMART) === 'Your smart account (0xD31c…D8FA) is listed too. Its rows are marked "smart account", and their direction and amount are what the smart account sent or received.' &&
      sah.smartAccountHistoryNote('failed', SMART) === 'Your smart account’s transactions (0xD31c…D8FA) could not be loaded right now, so only this account’s own address is listed. Pull down to try again.' &&
      sah.smartAccountHistoryNote('skipped', SMART) === 'Your smart account’s transactions (0xD31c…D8FA) are not listed: without a history indexer the wallet searches only this account’s own address. A history indexer (Settings → Ethereum history indexer) lists both.' &&
      sah.smartAccountHistoryNote(undefined, SMART) === null && sah.smartAccountHistoryNote('included', null) === null);
  // A note saved under the UserOperation hash shows on the smart account's row.
  const OP = '0x' + '90'.repeat(32);
  const index = notes.indexNotes([{ network: SEPOLIA, txid: null, userOpHash: OP, text: 'smart note', updatedAt: '2026-10-11T00:00:00Z' }]);
  check("a note saved under op:<userOpHash> resolves on the smart account's bundle row through its decoded UserOperation",
    notes.findNote(index, SEPOLIA, h(3), [OP])?.text === 'smart note');

  // EntryPoint deposit and payout rows (finding F4), with the two live figures.
  const as = await import('../src/wallet/activity-sentences.ts');
  const epRow = (amount, direction = 'out', over = {}) => ({ ...e(81, 11889779, direction, amount), counterparty: ENTRYPOINT_V07.toLowerCase(), ...over });
  const opts = { smartAccountRow: true, nativeSymbol: 'test ETH', hidden: false };
  check('LIVE FIGURE 1 — the staking bundle\'s top-up (747,174,110,161,719 wei) reads as an EntryPoint deposit',
    as.entryPointRowSentence(epRow(STAKE_TOP_UP), opts) === 'EntryPoint deposit: 0.000747174110161719 test ETH set aside for this smart account’s network fees',
    as.entryPointRowSentence(epRow(STAKE_TOP_UP), opts));
  // The pass recorded only the rounded display "−0.000923"; the exact wei
  // amount of that row is not recorded, so 0.000923 ETH stands in for it.
  check('LIVE FIGURE 2 — the "−0.000923" row (exact amount not recorded; 0.000923 used)',
    as.entryPointRowSentence(epRow(923_000_000_000_000n), opts) === 'EntryPoint deposit: 0.000923 test ETH set aside for this smart account’s network fees');
  check('…ETH from the EntryPoint back to the smart account reads as a payout',
    as.entryPointRowSentence(epRow(1_000n, 'in'), opts) === 'EntryPoint payout: 0.000000000000001 test ETH paid to this smart account by the EntryPoint');
  check('…Hide amounts masks the amount',
    as.entryPointRowSentence(epRow(STAKE_TOP_UP), { ...opts, hidden: true }) === 'EntryPoint deposit: •••• test ETH set aside for this smart account’s network fees');
  check('…not for a regular account\'s own row, a token row, another counterparty, a zero amount or a self row',
    as.entryPointRowSentence(epRow(STAKE_TOP_UP), { ...opts, smartAccountRow: false }) === null &&
      as.entryPointRowSentence(epRow(STAKE_TOP_UP, 'out', { assetSymbol: 'USDC', assetAmount: 1n, assetDecimals: 6 }), opts) === null &&
      as.entryPointRowSentence(epRow(STAKE_TOP_UP, 'out', { counterparty: BURN.toLowerCase() }), opts) === null &&
      as.entryPointRowSentence(epRow(0n), opts) === null && as.entryPointRowSentence(epRow(5n, 'self'), opts) === null);
  const staked = 'Smart-account operation: staked 0.0001 test ETH with Lido (stETH contract 0x3e3F…40Af): received 0.000099999999999999 stETH';
  const topUpText = as.activityRowText({ entryPoint: as.entryPointRowSentence(epRow(STAKE_TOP_UP), opts), sentence: staked, mayDecode: false });
  check("…so the staking bundle's −0.000747 row no longer carries the bundle's \"staked\" sentence",
    topUpText.sentence.startsWith('EntryPoint deposit: 0.000747174110161719') && !topUpText.sentence.includes('staked') && topUpText.loading === false);
  check('…its other rows keep the bundle\'s sentence',
    as.activityRowText({ entryPoint: null, sentence: staked, mayDecode: false }).sentence === staked);
  check('…end to end: the indexer row of the top-up (smart-account stream) gets the deposit sentence',
    as.entryPointRowSentence(realTopUp, { ...opts, smartAccountRow: sah.isSmartAccountEntry(realTopUp) }) === 'EntryPoint deposit: 0.000747174110161719 test ETH set aside for this smart account’s network fees');

  // Rows before their sentence (finding F5): the decoder says which rows may still get one.
  installFakeNode();
  clearActivityCache();
  const known = [...fixtures.keys()][0];
  const decoderF5 = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1, KERNEL_OF_ACCOUNT_1], trackedTokens: [], run: fixedRun });
  const before = decoderF5.mayDecode(known);
  await decoderF5.decodeEntries([known]);
  const deadDecoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1], trackedTokens: [], run: async () => { throw new Error('down'); } });
  await deadDecoder.decodeEntries([known]);
  check('decoder.mayDecode: true before a decode, false once decoded or failed, false for a non-hash id',
    before === true && decoderF5.cachedFor([known]).size === 1 && decoderF5.mayDecode(known) === false &&
      deadDecoder.mayDecode(known) === false && decoderF5.mayDecode('not-a-hash') === false);
  // Rows before their sentence (finding F5).
  check('a row with no sentence yet says it is loading while a decode may bring one, and not after',
    JSON.stringify(as.activityRowText({ entryPoint: null, sentence: null, mayDecode: true })) === JSON.stringify({ sentence: null, loading: true, unavailable: false }) &&
      JSON.stringify(as.activityRowText({ entryPoint: null, sentence: null, mayDecode: false })) === JSON.stringify({ sentence: null, loading: false, unavailable: false }) &&
      as.ROW_DETAILS_LOADING_LABEL === 'Transaction, details loading');
  // Phase 19 item 4: a row the decoder left unavailable says so instead.
  check('a row left unavailable: no sentence, not loading, unavailable (it shows ROW_DETAILS_UNAVAILABLE_LINE)',
    JSON.stringify(as.activityRowText({ entryPoint: null, sentence: null, mayDecode: false, unavailable: true })) === JSON.stringify({ sentence: null, loading: false, unavailable: true }) &&
      as.ROW_DETAILS_UNAVAILABLE_LINE === 'Details could not be loaded from the network endpoints; pull down to try again.');
  check('…a row with its own sentence (a decode, or an EntryPoint row) never shows the line',
    as.activityRowText({ entryPoint: null, sentence: 'Sent 1 test ETH', mayDecode: false, unavailable: true }).unavailable === false &&
      as.activityRowText({ entryPoint: 'EntryPoint deposit: …', sentence: null, mayDecode: false, unavailable: true }).unavailable === false);
  check('footer: "N rows without details — pull down to retry" (singular for one; none for zero)',
    as.rowsWithoutDetailsFooter?.(5) === '5 rows without details — pull down to retry' &&
      as.rowsWithoutDetailsFooter?.(1) === '1 row without details — pull down to retry' &&
      as.rowsWithoutDetailsFooter?.(0) === null && as.rowsWithoutDetailsFooter?.(-1) === null && as.rowsWithoutDetailsFooter?.(1.5) === null);
  check('footer technical line names the reasons; none when nothing is unavailable',
    as.unavailableDiagnosticDetail?.({ unavailable: 5, noAlternate: 0, alternateMissing: 4, alternateFailed: 1, failed: 2 }) ===
      'No other endpoint to ask: 0; other endpoints answered without it: 4; other endpoints did not answer: 1; other failed decodes: 2.' &&
      as.unavailableDiagnosticDetail?.({ unavailable: 0, noAlternate: 0, alternateMissing: 0, alternateFailed: 0, failed: 3 }) === null);
  const screenSrc = readFileSync(join(here, '..', 'src', 'screens', 'ActivityScreen.tsx'), 'utf8');
  const unavailableWired = (src) => {
    const flat = src.replace(/\s+/g, ' ');
    return (
      flat.includes("(unavailable ? `. ${ROW_DETAILS_UNAVAILABLE_LINE}` : '')") &&
      flat.includes(') : unavailable ? ( <Text style={[styles.rowSentence, { color: theme.textMuted }]}>{ROW_DETAILS_UNAVAILABLE_LINE}</Text> ) : null}') &&
      flat.includes('unavailable: sentences.isUnavailable(entry.id),') &&
      flat.includes('unavailable={rowText.unavailable}') &&
      flat.includes('const withoutDetailsFooter = rowsWithoutDetailsFooter(rowsWithoutDetails);') &&
      flat.includes('state.entries.filter((entry) => sentences.isUnavailable(entry.id) && rowTextFor(entry).unavailable).length') &&
      flat.includes('{withoutDetailsFooter}') &&
      flat.includes('<TechnicalDetail text={sentences.diagnostics ? unavailableDiagnosticDetail(sentences.diagnostics) : null} />') &&
      // A row that went unavailable re-renders even with nothing new cached.
      flat.includes('if (decoded.size > 0 || decoder.revision() !== before) setVersion((v) => v + 1);') &&
      flat.includes('if (decoderRef.current !== decoder) return;')
    );
  };
  check('the screen draws the muted line under such a row, ends its label with it, counts the rows in the footer with the reasons, and re-renders when a row goes unavailable (source)',
    unavailableWired(screenSrc));
  check('…mutant caught: the line left out of the label', !unavailableWired(screenSrc.replace("(unavailable ? `. ${ROW_DETAILS_UNAVAILABLE_LINE}` : '')", "''")));
  check('…mutant caught: the row without the line', !unavailableWired(screenSrc.replace('{ROW_DETAILS_UNAVAILABLE_LINE}</Text>', '{null}</Text>')));
  check('…mutant caught: the old re-render rule (only when something new was cached)',
    !unavailableWired(screenSrc.replace('if (decoded.size > 0 || decoder.revision() !== before) setVersion((v) => v + 1);', 'if (decoded.size > 0) setVersion((v) => v + 1);')));
}

console.log('The Activity list state machine (2026-10-11 pass, finding F3):');
{
  const hc = await import('../src/wallet/history-controller.ts');
  /** A session like the real ones: one load at a time, the page kept until taken. */
  const fakeSession = () => {
    const loads = [];
    let ready = null;
    let inflight = null;
    const session = {
      loads,
      fill() {
        if (ready) return Promise.resolve();
        if (inflight) return inflight;
        let resolve;
        let reject;
        const p = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
        const load = {
          answer: (page) => {
            ready = page;
            inflight = null;
            resolve();
          },
          fail: (message) => {
            inflight = null;
            reject(new Error(message));
          },
        };
        loads.push(load);
        inflight = p;
        return p;
      },
      take() {
        const page = ready;
        ready = null;
        return page;
      },
    };
    return session;
  };
  const okPage = (ids, hasMore) => ({ status: 'ok', page: { entries: ids.map((id) => ({ id, uid: id, timestamp: null, confirmed: true, direction: 'in' })) }, hasMore });
  const timers = [];
  const make = () => {
    const sessions = [];
    const changes = [];
    const controller = hc.createHistoryController({
      open: () => {
        const s = fakeSession();
        sessions.push(s);
        return s;
      },
      onChange: (snap) => changes.push(snap),
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        timer.cleared = true;
      },
    });
    return { controller, sessions, changes, state: () => controller.snapshot().state };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const fireTimeouts = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
  };

  const c = make();
  const first = c.controller.reload();
  check('reload: loading at once, then the first page', c.state().status === 'loading' && c.controller.snapshot().refreshing === true);
  c.sessions[0].loads[0].answer(okPage(['a', 'b'], true));
  await first;
  check('…ok, two entries, more to load, the 60-second timer cleared',
    c.state().status === 'ok' && c.state().entries.length === 2 && c.state().hasMore && !c.controller.snapshot().refreshing &&
      hc.HISTORY_PAGE_TIMEOUT_MS === 60_000 && timers.every((t) => t.cleared || t.ms === 60_000));
  // In-flight guard: two calls while one page loads list that page once.
  const g1 = c.controller.loadMore();
  const g2 = c.controller.loadMore();
  c.sessions[0].loads[1].answer(okPage(['b2'], true));
  await Promise.all([g1, g2]);
  check('load more twice while one is in flight: one load, its page listed once, no error',
    c.sessions[0].loads.length === 2 && c.state().entries.map((x) => x.id).join() === 'a,b,b2' && c.state().loadMoreError === null, c.state());
  const more1 = c.controller.loadMore();
  const more2 = c.controller.loadMore();
  check('load more: the spinner shows and a second call while one is in flight starts nothing',
    c.state().loadingMore === true && c.sessions[0].loads.length === 3);
  c.sessions[0].loads[2].fail('fetch failed: simulated');
  await Promise.all([more1, more2]);
  check('…a failure ends the spinner with the retry footer ("Could not load more — tap to retry"), entries kept',
    c.state().loadingMore === false && c.state().loadMoreError === 'fetch failed: simulated' && c.state().entries.length === 3 &&
      hc.LOAD_MORE_RETRY_FOOTER === 'Could not load more — tap to retry');
  const retry = c.controller.loadMore();
  c.sessions[0].loads[3].answer(okPage(['c'], true));
  await retry;
  check('…the retry appends the page and clears the footer', c.state().entries.map((x) => x.id).join() === 'a,b,b2,c' && c.state().loadMoreError === null);
  // Timeout.
  const slow = c.controller.loadMore();
  await tick();
  fireTimeouts();
  await slow;
  check('a page that takes longer than 60 s ends the spinner with the retry footer and the timeout line',
    c.state().loadingMore === false && c.state().loadMoreError === hc.HISTORY_PAGE_TIMEOUT_MESSAGE &&
      hc.HISTORY_PAGE_TIMEOUT_MESSAGE === 'The history endpoint did not answer within 60 seconds.');
  // The late answer is kept by the session; the retry takes it without a new load.
  c.sessions[0].loads[4].answer(okPage(['d'], false));
  await tick();
  check('…the late answer is not listed by itself', c.state().entries.length === 4);
  await c.controller.loadMore();
  check('…the retry lists it once, with no new request, and the list ends ("End of history.")',
    c.state().entries.map((x) => x.id).join() === 'a,b,b2,c,d' && c.sessions[0].loads.length === 5 && c.state().hasMore === false);
  const beforeEnd = c.sessions[0].loads.length;
  await c.controller.loadMore();
  check('…at the end, load more does nothing', c.sessions[0].loads.length === beforeEnd && c.state().loadingMore === false);

  // A reload while a load more is in flight drops the old answer.
  const c2 = make();
  const r1 = c2.controller.reload();
  c2.sessions[0].loads[0].answer(okPage(['x'], true));
  await r1;
  const stale = c2.controller.loadMore();
  const r2 = c2.controller.reload();
  check('a reload during a load more ends the old spinner at once', c2.state().loadingMore === false && c2.sessions.length === 2);
  c2.sessions[0].loads[1].answer(okPage(['stale'], true));
  await stale;
  check('…the old session\'s late answer is never listed', !c2.state().entries.some((x) => x.id === 'stale'), c2.state());
  c2.sessions[1].loads[0].answer(okPage(['y'], true));
  await r2;
  check('…the old session\'s answer is dropped; the new first page is shown', c2.state().entries.map((x) => x.id).join() === 'y');
  const after = c2.controller.loadMore();
  check('…and a load more works again in the new session', c2.state().loadingMore === true && c2.sessions[1].loads.length === 2);
  c2.sessions[1].loads[1].answer(okPage(['z'], false));
  await after;
  check('…appending to the new list', c2.state().entries.map((x) => x.id).join() === 'y,z');

  // The first page timing out is an error with Retry; dispose stops updates.
  const c3 = make();
  const r3 = c3.controller.reload();
  await tick();
  fireTimeouts();
  await r3;
  check('a first page that takes longer than 60 s shows the error with Retry (never a spinner)',
    c3.state().status === 'error' && c3.state().message === hc.HISTORY_PAGE_TIMEOUT_MESSAGE && !c3.controller.snapshot().refreshing);
  const c4 = make();
  void c4.controller.reload();
  c4.controller.dispose();
  const count = c4.changes.length;
  c4.sessions[0].loads[0].answer(okPage(['q'], false));
  await tick();
  await c4.controller.reload();
  await c4.controller.loadMore();
  check('after dispose (the screen left) nothing is published and nothing new is loaded', c4.changes.length === count && c4.sessions.length === 1);
}

console.log('Zero-value native rows next to token rows (2026-10-11 re-check, finding 8):');
{
  const hist = await import('../src/wallet/history.ts');
  const WRAP = '0x' + 'a1'.repeat(32);
  const APPROVE = '0x' + 'a2'.repeat(32);
  const native0 = { id: WRAP, uid: `${WRAP}:external`, direction: 'out', amount: 0n, timestamp: null, confirmed: true };
  const tokenOut = { id: WRAP, uid: `${WRAP}:log:1`, direction: 'out', assetSymbol: 'stETH', assetAmount: 5n * 10n ** 14n, assetDecimals: 18, timestamp: null, confirmed: true };
  const approve0 = { id: APPROVE, uid: `${APPROVE}:external`, direction: 'out', amount: 0n, timestamp: null, confirmed: true };
  const paid = { id: WRAP.toUpperCase().replace('0X', '0x'), uid: 'x', direction: 'out', amount: 1n, timestamp: null, confirmed: true };
  const ids = hist.transactionsWithTokenAmounts([native0, tokenOut, approve0]);
  check('a wrap\'s zero-value native row shows no amount when its token row is loaded', hist.hidesZeroNativeAmount(native0, ids) === true);
  check('…an approval with no token row keeps its amount (what the indexer reported)', hist.hidesZeroNativeAmount(approve0, ids) === false);
  check('…the token row itself and a non-zero native row keep theirs (ids compared case-insensitively)',
    hist.hidesZeroNativeAmount(tokenOut, ids) === false && hist.hidesZeroNativeAmount(paid, ids) === false && ids.has(WRAP));
  check('…without the token row loaded the zero row keeps its amount', hist.hidesZeroNativeAmount(native0, hist.transactionsWithTokenAmounts([native0])) === false);

  // Phase 19 item 4: a zero-value native row of a transaction DECODED as a
  // contract call with no value (an approval) shows no amount either. The
  // live Permit2 approval (fixture 0xa41da70a…, the pass's row 112).
  reset();
  clearActivityCache();
  const decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1], trackedTokens: [], run: fixedRun });
  const decodedApprove = (await decoder.decodeEntries([H.approve])).get(H.approve);
  check('the fixture decodes to the live sentence "Approved USDC for Permit2 (unlimited)"', render(decodedApprove) === 'Approved USDC for Permit2 (unlimited)', render(decodedApprove));
  const row112 = { id: H.approve, uid: `${H.approve}:external`, direction: 'out', amount: 0n, timestamp: null, confirmed: true };
  const noTokens = hist.transactionsWithTokenAmounts([row112]);
  check('LIVE SENTENCE row 112 — "Approved USDC for Permit2 (unlimited)": no amount once decoded (was "−0 test ETH")',
    hist.hidesZeroNativeAmount(row112, noTokens, decodedApprove.description) === true);
  check('…before the decode arrives it keeps the indexer\'s amount (unchanged rule)', hist.hidesZeroNativeAmount(row112, noTokens) === false && hist.hidesZeroNativeAmount(row112, noTokens, null) === false);
  const facts = (over) => ({ hash: H.approve, value: 0n, call: { kind: 'approve' }, ...over });
  check('…any decoded contract call with no value counts (generic call, Permit2, a bundle)',
    ['contract-call', 'permit2-approve', 'handle-ops', 'universal-router'].every((kind) => hist.hidesZeroNativeAmount(row112, noTokens, facts({ call: { kind } }))));
  check('…but not a plain zero-value transfer (a cancellation did send 0)', hist.hidesZeroNativeAmount(row112, noTokens, facts({ call: { kind: 'native-transfer' } })) === false);
  check('…nor a call that carried value, nor another transaction\'s decode, nor a non-zero or token row',
    hist.hidesZeroNativeAmount(row112, noTokens, facts({ value: 1n })) === false &&
      hist.hidesZeroNativeAmount(row112, noTokens, facts({ hash: WRAP })) === false &&
      hist.hidesZeroNativeAmount({ ...row112, amount: 5n }, noTokens, facts({})) === false &&
      hist.hidesZeroNativeAmount(tokenOut, noTokens, facts({ hash: WRAP })) === false);
  check('…the hash is compared case-insensitively', hist.hidesZeroNativeAmount(row112, noTokens, facts({ hash: H.approve.toUpperCase().replace('0X', '0x') })) === true);
  // No row ever reads "−0": the sign is dropped for an amount of exactly zero.
  check('amountSign: "+" in, "−" out, none for self and none for exactly zero (never "−0")',
    hist.amountSign({ direction: 'in', amount: 1n }) === '+' && hist.amountSign({ direction: 'out', amount: 1n }) === '−' &&
      hist.amountSign({ direction: 'self', amount: 1n }) === '' && hist.amountSign({ direction: 'out', amount: 0n }) === '' &&
      hist.amountSign({ direction: 'in', amount: 0n }) === '' &&
      hist.amountSign({ direction: 'out', amount: 0n, assetAmount: 5n, assetDecimals: 6 }) === '−' &&
      hist.amountSign({ direction: 'out', amount: 7n, assetAmount: 0n, assetDecimals: 6 }) === '');
  const screen = readFileSync(join(here, '..', 'src', 'screens', 'ActivityScreen.tsx'), 'utf8');
  const wired = (src) =>
    src.includes('const tokenTxIds = transactionsWithTokenAmounts(loadedEntries);') &&
    src.includes('noAmount={hidesZeroNativeAmount(item, tokenTxIds, sentences.lookup(item.id)?.description)}') &&
    src.includes('const sign = amountSign(entry);') && !src.includes("const sign = entry.direction === 'in' ? '+'") &&
    // Since 2026-10-11 (finding 2) a failed incoming row hides its amount
    // the same way: showAmount = !noAmount && !failedIncoming.
    src.includes('const showAmount = !noAmount && !failedIncoming;') &&
    src.includes('const hasAmount = showAmount && (entry.assetAmount !== undefined || entry.amount !== undefined);') &&
    /\{!showAmount \? null : \(\s*<>\s*<Text style=\{\[styles\.amount/.test(src);
  check('the Activity row renders no amount line for such an entry, and says "no amount" to a screen reader (source)', wired(screen));
  check('…a row that always renders the amount fails the check', !wired(screen.replace('{!showAmount ? null : (', '{false ? null : (')));
  check('…the screen before phase 19 item 4 (no decoded call passed) fails the check',
    !wired(screen.replace('noAmount={hidesZeroNativeAmount(item, tokenTxIds, sentences.lookup(item.id)?.description)}', 'noAmount={hidesZeroNativeAmount(item, tokenTxIds)}')));
  check('…a row signing zero amounts ("−0") fails the check',
    !wired(screen.replace('const sign = amountSign(entry);', "const sign = entry.direction === 'in' ? '+' : entry.direction === 'out' ? '−' : '';")));
  check('…a failed incoming row that keeps its amount fails the check', !wired(screen.replace('const showAmount = !noAmount && !failedIncoming;', 'const showAmount = !noAmount;')));
}

console.log('ActivityScreen source:');
{
  const screen = readFileSync(join(here, '..', 'src', 'screens', 'ActivityScreen.tsx'), 'utf8');
  check('rows render the sentence (the row text: EntryPoint sentence, else the decoded one, else loading)',
    /styles\.rowSentence/.test(screen) && screen.includes('const rowText = rowTextFor(item);') &&
      screen.includes('sentence={rowText.sentence}') && screen.includes('loading={rowText.loading}') &&
      screen.includes('smartAccountRow: isSmartAccountEntry(entry) || activeIsMultisig,') &&
      screen.includes('sentence: sentenceFor(entry.id),') && screen.includes('mayDecode: sentences.mayDecode(entry.id),'));
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
  // Since pass p20c finding 12 the lead is built by activityRowSpokenLead
  // (../a11y.ts), which also says "Same transaction as the row above." for
  // the second row of one transaction.
  const { activityRowSpokenLead } = await import('../src/a11y.ts');
  const lead = (sentence, loading, sameAsAbove = false) => activityRowSpokenLead({ sentence, loading, sameAsAbove, loadingLabel: 'Transaction, details loading' });
  const loadingLabel = (src) =>
    src.includes('activityRowSpokenLead({ sentence, loading, sameAsAbove, loadingLabel: ROW_DETAILS_LOADING_LABEL }) +') &&
    lead('Sent 1 USDC to Account 2', true) === 'Sent 1 USDC to Account 2. ' &&
    lead(null, true) === 'Transaction, details loading. ' && lead(null, false) === '';
  check('screen readers hear the sentence first, or "Transaction, details loading" while it may still come (finding F5)', loadingLabel(screen));
  check('…a row label without the lead is caught', !loadingLabel(screen.replace('activityRowSpokenLead({ sentence, loading, sameAsAbove, loadingLabel: ROW_DETAILS_LOADING_LABEL }) +', "(sentence ? `${sentence}. ` : '') +")));
  check('pass p20c finding 12: the second row of one transaction says "Same transaction as the row above." instead of the sentence again (exact)',
    lead('Sent 1 USDC to Account 2', false, true) === 'Same transaction as the row above. ' && lead(null, true, true) === 'Same transaction as the row above. ');
  check('…and the list marks a row whose previous row has the same transaction id (source)',
    screen.includes('sameAsAbove={index > 0 && state.entries[index - 1]?.id === listed.id}') && screen.includes('renderItem={({ item: listed, index }) => {'));
  const memo = (src) =>
    src.includes('setup && setup.key === setupKey ? setup : setupKey ? (DECODER_SETUPS.get(setupKey) ?? null) : null;') &&
    src.includes('rememberDecoderSetup(built);') && src.includes('if (!cancelled) setSetupFailedKey(setupKey);');
  check('…a return to the screen uses the last decoder setup at once, so decoded rows have their sentence on the first render (source)', memo(screen));
  const marker = (src) =>
    src.includes('const withSmartAccount = involvesSmartAccount(entry);') &&
    src.includes('{withSmartAccount ? <StatusChip label="with smart account" color={theme.textMuted} theme={theme} /> : null}') &&
    src.includes("withSmartAccount ? 'with your smart account' : null,");
  check('the account\'s own row of a transaction its smart account also lists shows "with smart account" (finding F1, source)', marker(screen));
  const footerOk = (src) =>
    /state\.loadingMore \? \(\s*<ActivityIndicator[^>]*\/>\s*\) : state\.loadMoreError \? \(/.test(src) &&
    src.includes('accessibilityLabel={LOAD_MORE_RETRY_FOOTER}') &&
    src.includes('{LOAD_MORE_RETRY_FOOTER}</Text>') &&
    src.includes(') : state.hasMore ? (') && !src.includes('state.nextCursor');
  check('the footer: spinner while loading, else "Could not load more — tap to retry", else Load more, else the end (finding F3, source)', footerOk(screen));
  check('…the old footer (spinner over the error, keyed on nextCursor) is caught',
    !footerOk(screen.replace(') : state.hasMore ? (', ') : state.nextCursor ? (')));
  check('the screen passes the account labels and the pinned-staking lookup for the active network, and names the EVM slot by the network (findings 4, 7e, 7f)',
    /accountLabels,\n\s*stakingContractAt: pinnedStakingAt,/.test(screen) && screen.includes('const accountLabels = sentences.labels;') &&
      screen.includes('(address: string) => stakingContractAt(evmChain.caip2, address)') &&
      screen.includes('title: account ? `${isEvmSlot ? evmChain.label : account.name} activity` : \'Activity\''));
  // Emulator re-check of 2026-10-11, findings 2 and 3: the decode set holds
  // the wallet's other smart accounts and the network's multisigs, but only
  // the account's own addresses read "yourself".
  const setsOk = (src) =>
    /ownMultisigAddresses\(chainCaip2\),/.test(src) &&
    src.includes('const sets = activityAddressSets({ eoa, accountIndex, aa, accounts, multisigs });') &&
    src.includes('wallet: sets.wallet,') && src.includes('self: sets.self,') && src.includes('labels: sets.labels,') &&
    src.includes('selfAddresses: sentences.self,') && src.includes('accounts: accountList,') &&
    !src.includes('walletAddressesFor(eoa, accountIndex, aa, multisigs)');
  check("the decoder's wallet set comes from activityAddressSets and the renderer gets the account's own addresses as \"yourself\" (source)", setsOk(screen));
  check('…the old wiring (multisigs in walletAddressesFor, no self list) fails the check',
    !setsOk(screen.replace('selfAddresses: sentences.self,', '')));
  // Finding 4: the active account's smart-account history is listed too.
  const smartOk = (src) =>
    src.includes('address = historySmartAccountFor(smartOwner, smartOwnerIndex, aa);') &&
    src.includes('activeAccount?.watchOnly !== true &&') && src.includes('activeAccount?.multisig !== true;') &&
    src.includes('const smartReady = !smartCandidate || (historySmart !== null && historySmart.key === smartKey);') &&
    /useHistory\(chainId, account\?\.address \?\? '', \{\s*smartAccount: historySmartAccount,\s*ready: smartReady,\s*\}\)/.test(src) &&
    src.includes('{smartAccountRow ? <StatusChip label="smart account" color={theme.accent} theme={theme} /> : null}') &&
    src.includes("smartAccountRow ? 'smart account' : null,") &&
    src.includes('const smartHistoryNote = smartAccountHistoryNote(state.smartAccount, historySmartAccount);');
  check('the screen lists the smart account next to the account (not for watch-only or multisig), waits for the settings, marks its rows and says what it did (source)', smartOk(screen));
  const useHistorySrc = readFileSync(join(here, '..', 'src', 'wallet', 'useHistory.ts'), 'utf8');
  const hookOk = (src) =>
    src.includes('const feed = createMergedHistoryFeed(streamsFor(first.indexerUrl, address, smartAccount));') &&
    src.includes("...(smartAccount && !first.viaIndexer ? { smartAccount: 'skipped' as const } : {}),") &&
    src.includes('if (!ready) return;') &&
    src.includes('open: () => openHistorySession(chainId, address, { smartAccount }),') &&
    // The cursor is never read from React state (finding F3).
    !/setState\(\(prev\)/.test(src) && !src.includes('cursor = prev.nextCursor');
  check('the hook: an indexer is read through the time-ordered merge, the logs fallback reports the smart account skipped, the state machine is the controller (no cursor in a state updater) (source)',
    hookOk(useHistorySrc));
}

console.log('A null answer for a listed transaction: one retry on another endpoint (2026-10-11 pass, finding 3):');
{
  // ethereum-sepolia-rpc.publicnode.com balances a reth backend that answers
  // null for old receipts (2026-10-11: 4 of 8 batched reads of 0x8b7463c4…
  // answered null on reth/v2.7.0, 4 served status 0x0 on Geth/v1.17.7).
  // Two fake endpoints: A (the active one) and B (another default).
  const A = URL;
  const B = 'https://fake-sepolia-2.invalid/rpc';
  const C = 'https://fake-sepolia-3.invalid/rpc';
  const blankNode = () => ({ receiptNull: new Set(), txNull: new Set(), garbled: new Set(), pending: new Set(), dead: false, flaky: new Set(), reads: new Map() });
  const nodes = { [A]: blankNode(), [B]: blankNode(), [C]: blankNode() };
  // Synthetic mined transactions for the long-history cases (phase 19 item 4).
  const synth = new Map();
  const lookup = (hash) => fixtures.get(hash) ?? synth.get(hash);
  const seen = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    const body = JSON.parse(init.body);
    seen.push({ url: target, method: body.method, hash: typeof body.params?.[0] === 'string' ? body.params[0] : null });
    const node = nodes[target];
    if (!node || node.dead) throw new TypeError('fetch failed (unknown or dead fake endpoint)');
    const reply = (result) => {
      const text = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    };
    const hash = String(body.params?.[0] ?? '').toLowerCase();
    if (body.method === 'eth_getTransactionByHash') {
      if (node.txNull.has(hash)) return reply(null);
      const f = lookup(hash);
      if (f && node.garbled.has(hash)) return reply({ ...f.transaction, hash: '0x' + '00'.repeat(32) });
      if (f && node.pending.has(hash)) return reply({ ...f.transaction, blockNumber: null, blockHash: null });
      return reply(f?.transaction ?? null);
    }
    if (body.method === 'eth_getTransactionReceipt') {
      if (node.receiptNull.has(hash)) return reply(null);
      // `flaky`: a load-balanced pool (Pocket's Sepolia endpoint, read-only
      // probe of 2026-10-11): the first read of a receipt reaches a backend
      // without it (null), the next one a backend that has it.
      const reads = (node.reads.get(hash) ?? 0) + 1;
      node.reads.set(hash, reads);
      if (node.flaky.has(hash) && reads === 1) return reply(null);
      return reply(lookup(hash)?.receipt ?? null);
    }
    if (body.method === 'eth_call') return reply('0x');
    throw new Error(`fake node: unexpected ${body.method}`);
  };
  const runOn = (url) => (operation) => operation(url);
  let finderCalls = [];
  const finder = (answer) => async (current) => {
    finderCalls.push(current);
    return answer;
  };
  const make = (alternate) =>
    createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1, KERNEL_OF_ACCOUNT_1], trackedTokens: [], run: runOn(A), alternate });
  const listedAll = { listed: () => true };
  const onB = (hash) => seen.filter((r) => r.url === B && r.hash?.toLowerCase() === hash);
  const fresh = () => {
    clearActivityCache();
    seen.length = 0;
    finderCalls = [];
    for (const n of Object.values(nodes)) {
      n.receiptNull.clear();
      n.txNull.clear();
      n.garbled.clear();
      n.pending.clear();
      n.flaky.clear();
      n.reads.clear();
      n.dead = false;
    }
  };

  // 1. Null receipt on A, served on B.
  fresh();
  nodes[A].receiptNull.add(H.approve);
  let decoder = make(finder(B));
  let out = await decoder.decodeEntries([H.approve], listedAll);
  check('a listed transaction whose receipt A answers null is decoded on B', out.size === 1 && render(out.get(H.approve)) === 'Approved USDC for Permit2 (unlimited)', out.size);
  check('…B was asked once for it (transaction + receipt) and the finder once', onB(H.approve).length === 2 && finderCalls.length === 1 && finderCalls[0] === A, [onB(H.approve).length, finderCalls]);
  check('…nothing is left failed or unavailable', decoder.failedIds().length === 0 && decoder.unavailableIds().length === 0);

  // 2. A null transaction (not-found) on A is retried the same way.
  fresh();
  nodes[A].txNull.add(H.swapEurc);
  decoder = make(finder(B));
  out = await decoder.decodeEntries([H.swapEurc], listedAll);
  check('a listed transaction A does not know at all is decoded on B', out.size === 1 && onB(H.swapEurc).length >= 2);

  // 3. Both null: unavailable (not failed), no third endpoint, not retried
  // until a pull-to-refresh, then retried and served.
  fresh();
  nodes[A].receiptNull.add(H.approve);
  nodes[B].receiptNull.add(H.approve);
  decoder = make(finder(B));
  out = await decoder.decodeEntries([H.approve], listedAll);
  check('null on both: no sentence, remembered as unavailable (not failed)', out.size === 0 && decoder.unavailableIds().includes(H.approve) && !decoder.failedIds().includes(H.approve));
  // Phase 19 item 4: with only one other endpoint (this finder always names
  // B) it is asked again, up to MAX_ALTERNATE_ASKS times in all — a
  // load-balanced endpoint can serve on its next read — and nothing else.
  check('…only the one alternate: B asked MAX_ALTERNATE_ASKS (3) times (2 reads each), no other endpoint',
    MAX_ALTERNATE_ASKS === 3 && onB(H.approve).length === 2 * MAX_ALTERNATE_ASKS && seen.every((r) => r.url === A || r.url === B), onB(H.approve).length);
  check('…the reason is recorded: the other endpoint answered without it',
    JSON.stringify(decoder.diagnostics?.()) === JSON.stringify({ unavailable: 1, noAlternate: 0, alternateMissing: 1, alternateFailed: 0, failed: 0 }) && decoder.isUnavailable?.(H.approve),
    decoder.diagnostics?.());
  check('…the row stops saying its details are loading', decoder.mayDecode(H.approve) === false);
  const before = seen.length;
  await decoder.decodeEntries([H.approve], listedAll);
  check('…not asked again on the next render', seen.length === before, seen.length - before);
  nodes[B].receiptNull.clear();
  decoder.reset();
  check('…a pull-to-refresh makes it decodable again', decoder.mayDecode(H.approve) === true && decoder.unavailableIds().length === 0);
  out = await decoder.decodeEntries([H.approve], listedAll);
  // Finder calls: (A, []) and (A, [B]) before the refresh, (A, []) again after it.
  check('…and the retry after the refresh is served (A null again, B now answers)', out.size === 1 && finderCalls.length === 3, [out.size, finderCalls.length]);
  check('…and the diagnostics are cleared by the refresh', decoder.diagnostics?.().unavailable === 0 && !decoder.isUnavailable?.(H.approve));

  // 4. The finder is asked once per decoder for the same failing endpoint.
  fresh();
  nodes[A].receiptNull.add(H.approve);
  nodes[A].receiptNull.add(H.swapEth1);
  decoder = make(finder(B));
  out = await decoder.decodeEntries([H.approve, H.swapEth1], listedAll);
  check('two null receipts on A: both served on B, the alternate found once', out.size === 2 && finderCalls.length === 1, [out.size, finderCalls.length]);

  // 5. No alternate (an override, or no other healthy default): unavailable after one try.
  fresh();
  nodes[A].receiptNull.add(H.approve);
  decoder = make(finder(null));
  out = await decoder.decodeEntries([H.approve], listedAll);
  check('no alternate endpoint: unavailable, nothing asked elsewhere', out.size === 0 && decoder.unavailableIds().includes(H.approve) && seen.every((r) => r.url === A));

  // 6. A row the history did not list as mined: the old rule (failed, no alternate).
  fresh();
  nodes[A].receiptNull.add(H.approve);
  decoder = make(finder(B));
  out = await decoder.decodeEntries([H.approve]);
  check('not listed: failed as before, no alternate asked', out.size === 0 && decoder.failedIds().includes(H.approve) && finderCalls.length === 0 && onB(H.approve).length === 0);

  // 7. A reverted transaction is an answer: never retried elsewhere.
  fresh();
  const REVERTED = '0x8b7463c415b02061f43ab15d852531a34b835afb5c8ae717eef72d06b0a8871e';
  decoder = make(finder(B));
  out = await decoder.decodeEntries([REVERTED], listedAll);
  check('a reverted transaction (status 0x0) is decoded on A and never retried on B', out.size === 1 && out.get(REVERTED).description.status === 'failed' && finderCalls.length === 0 && onB(REVERTED).length === 0);

  // 8. A malformed answer is a failure: never retried elsewhere.
  fresh();
  nodes[A].garbled.add(H.approve);
  decoder = make(finder(B));
  out = await decoder.decodeEntries([H.approve], listedAll);
  check('a malformed answer (another transaction) fails without an alternate', out.size === 0 && decoder.failedIds().includes(H.approve) && finderCalls.length === 0 && onB(H.approve).length === 0);

  // 8b. A "pending" answer (no block) is not a missing answer: no alternate.
  fresh();
  nodes[A].pending.add(H.approve);
  decoder = make(finder(B));
  out = await decoder.decodeEntries([H.approve], listedAll);
  check('a pending answer for a listed row fails as before, without an alternate', out.size === 0 && decoder.failedIds().includes(H.approve) && finderCalls.length === 0 && onB(H.approve).length === 0);

  // 8c. The alternate endpoint itself is down: unavailable (retried after a refresh), never throws.
  fresh();
  nodes[A].receiptNull.add(H.approve);
  nodes[B].dead = true;
  decoder = make(finder(B));
  let threw = false;
  try {
    out = await decoder.decodeEntries([H.approve], listedAll);
  } catch {
    threw = true;
  }
  check('a dead alternate: unavailable (not failed), never throws', !threw && out.size === 0 && decoder.unavailableIds().includes(H.approve) && !decoder.failedIds().includes(H.approve));
  check('…reason: the other endpoint did not answer (a dead endpoint is not asked again)',
    decoder.diagnostics?.().alternateFailed === 1 && decoder.diagnostics?.().alternateMissing === 0 && seen.filter((r) => r.url === B).length === 1, decoder.diagnostics?.());

  // 9. A finder that throws counts as no alternate.
  fresh();
  nodes[A].receiptNull.add(H.approve);
  decoder = make(async () => {
    throw new Error('probe failed');
  });
  out = await decoder.decodeEntries([H.approve], listedAll);
  check('a failing finder: unavailable, never throws', out.size === 0 && decoder.unavailableIds().includes(H.approve));
  check('…reason: no other endpoint to ask', decoder.diagnostics?.().noAlternate === 1 && decoder.diagnostics?.().unavailable === 1, decoder.diagnostics?.());

  // 10. With an injected runner and no finder there is never an alternate.
  fresh();
  nodes[A].receiptNull.add(H.approve);
  decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1], trackedTokens: [], run: runOn(A) });
  out = await decoder.decodeEntries([H.approve], listedAll);
  check('injected runner without a finder: no alternate, unavailable', out.size === 0 && decoder.unavailableIds().includes(H.approve) && seen.every((r) => r.url === A));

  // ---------------------------------------------------------------------
  // Phase 19 item 4: why the first-load retry did not recover the five
  // oldest rows of the 2026-10-11 pass (they sat about 115 rows down, the
  // 15th page of 8 decodes). The screen decodes one visible batch at a time
  // through one decoder, so a row "20 pages old" is decoded after 20
  // earlier decodeEntries calls of the same decoder.
  const mined = (k) => {
    const hash = '0x' + (0xf000 + k).toString(16).padStart(64, '0');
    if (!synth.has(hash)) {
      synth.set(hash, {
        transaction: { hash, from: ACCOUNT_2.toLowerCase(), to: ACCOUNT_1.toLowerCase(), input: '0x', value: '0x38d7ea4c68000', nonce: '0x' + k.toString(16), type: '0x2', chainId: '0xaa36a7', blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32) },
        receipt: { transactionHash: hash, blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32), status: '0x1', logs: [] },
      });
    }
    return hash;
  };
  const PAGES = 21; // pages 0..20: the last one is 20 pages after the first
  const pages = Array.from({ length: PAGES }, (_, p) => Array.from({ length: 8 }, (_, i) => mined(p * 8 + i)));
  const oldRow = pages[PAGES - 1][7];
  const RECEIVED = 'Received 0.001 test ETH from 0xb699…81fE';
  /** A finder that honours `exclude`, like the real one: the first of `list` not yet asked. */
  const finderOver = (list) => async (current, exclude = []) => {
    finderCalls.push(current);
    return list.find((u) => u !== current && !exclude.includes(u)) ?? null;
  };
  const decodePages = async (decoder, between) => {
    for (let p = 0; p < PAGES; p += 1) {
      for (const h of pages[p]) nodes[A].receiptNull.add(h);
      await decoder.decodeEntries(pages[p], listedAll);
      if (between) between(p);
    }
  };

  // R1. The pass as first described: A (publicnode's reth) null, the
  // alternate B serves every read. Decodes on every page, 20 pages later too.
  fresh();
  decoder = make(finderOver([B]));
  await decodePages(decoder);
  out = decoder.cachedFor([oldRow]);
  check('R1 (two steady fakes): a row 20 pages old whose receipt A answers null is decoded on B',
    out.size === 1 && render(out.get(oldRow)) === RECEIVED, out.size === 1 ? render(out.get(oldRow)) : decoder.diagnostics?.());
  check('…every one of the 168 rows decoded, the alternate found once, nothing unavailable — NOT reproduced: no per-page limit and no retry budget',
    decoder.cachedFor(pages.flat()).size === PAGES * 8 && finderCalls.length === 1 && decoder.unavailableIds().length === 0,
    [decoder.cachedFor(pages.flat()).size, finderCalls.length]);

  // R2. What a read-only probe of 2026-10-11 found instead: the alternate
  // (Pocket) is itself a load-balanced pool whose reth / erigon backends
  // answered null for the 27 September receipts in 5 of 8 reads. One ask
  // there left the row unavailable until a pull-to-refresh (the old code);
  // a second ask reaches a backend that has it.
  fresh();
  for (const h of pages.flat()) nodes[B].flaky.add(h);
  decoder = make(finderOver([B]));
  await decodePages(decoder);
  out = decoder.cachedFor([oldRow]);
  check('R2 (REPRODUCED, the alternate load-balanced: null on its first read): the row 20 pages old is decoded by a second ask on B',
    out.size === 1 && render(out.get(oldRow)) === RECEIVED, decoder.diagnostics?.());
  check('…all 168 rows decoded, each with exactly two asks on B (4 reads), the finder asked twice in all ((A) and (A, [B]))',
    decoder.cachedFor(pages.flat()).size === PAGES * 8 && onB(oldRow).length === 4 && finderCalls.length === 2, [onB(oldRow).length, finderCalls.length]);

  // R2b. The alternate keeps answering null (a pruned pool) but the
  // network's third default serves (0xrpc.io / public.1rpc.io served both
  // receipts in the same probe): the next default is asked.
  fresh();
  for (const h of pages.flat()) nodes[B].receiptNull.add(h);
  decoder = make(finderOver([B, C]));
  await decodePages(decoder);
  out = decoder.cachedFor([oldRow]);
  check('R2b (the alternate null on every read, a third default serves): the row 20 pages old is decoded on C',
    out.size === 1 && render(out.get(oldRow)) === RECEIVED && seen.some((r) => r.url === C && r.hash === oldRow), decoder.diagnostics?.());
  check('…B asked once per row (2 reads), then C (no repeat ask on B while a new endpoint exists)', onB(oldRow).length === 2, onB(oldRow).length);

  // R3. A probe that failed once (every candidate timed out within its 4 s
  // deadline) was remembered as "no other endpoint" for the decoder's whole
  // life (the old code), so every later null row went unavailable until a
  // pull-to-refresh. Now a "none" answer is probed again after
  // ALTERNATE_REFIND_AFTER_MS; a found endpoint is kept.
  fresh();
  let clock = 1_000_000;
  let probes = 0;
  const flakyFinder = async (current) => {
    finderCalls.push(current);
    probes += 1;
    return probes === 1 ? null : B;
  };
  decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1, KERNEL_OF_ACCOUNT_1], trackedTokens: [], run: runOn(A), alternate: flakyFinder, now: () => clock });
  await decodePages(decoder, (p) => {
    if (p === 0) clock += ALTERNATE_REFIND_AFTER_MS; // the next pages come a minute later
  });
  out = decoder.cachedFor([oldRow]);
  check('R3 (REPRODUCED, the first probe failed): the first page is unavailable ("no other endpoint"), the row 20 pages old a minute later is decoded on B',
    out.size === 1 && pages[0].every((h) => decoder.isUnavailable?.(h)) && decoder.diagnostics?.().noAlternate === 8 && decoder.cachedFor(pages.slice(1).flat()).size === (PAGES - 1) * 8,
    decoder.diagnostics?.());
  check('…the probe ran twice in all (once failed, once found; the found endpoint kept)', probes === 2, probes);
  check('…ALTERNATE_REFIND_AFTER_MS is one minute', ALTERNATE_REFIND_AFTER_MS === 60_000);
  // Within the minute the "none" answer is reused (no probe per row).
  fresh();
  clock = 5_000_000;
  probes = 0;
  decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: [ACCOUNT_1], trackedTokens: [], run: runOn(A), alternate: async () => { probes += 1; return null; }, now: () => clock });
  await decodePages(decoder);
  check('…while every probe finds nothing, at most one probe a minute (21 pages within the minute: one probe)', probes === 1 && decoder.diagnostics?.().noAlternate === PAGES * 8, [probes, decoder.diagnostics?.()]);
  clock += ALTERNATE_REFIND_AFTER_MS;
  nodes[A].receiptNull.add(mined(999));
  await decoder.decodeEntries([mined(999)], listedAll);
  check('…and one more after the minute', probes === 2, probes);

  // The revision a screen re-renders on: it moves when a row goes unavailable
  // with nothing new cached (the row then says why).
  fresh();
  nodes[A].receiptNull.add(H.approve);
  decoder = make(finder(null));
  const r0 = decoder.revision?.();
  out = await decoder.decodeEntries([H.approve], listedAll);
  const r1 = decoder.revision?.();
  decoder.reset();
  check('revision(): moves when a row goes unavailable (nothing cached) and on reset()', out.size === 0 && r1 > r0 && decoder.revision?.() > r1, [r0, r1, decoder.revision?.()]);

  globalThis.fetch = savedFetch;
  const screen = readFileSync(join(here, '..', 'src', 'screens', 'ActivityScreen.tsx'), 'utf8');
  check('the screen passes the listed (confirmed) rows to the decoder (source)',
    screen.includes('for (const item of items) if (item.confirmed) listedIds.current.add(item.id);') &&
      screen.includes('decoder.decodeEntries(ids, { listed: (id) => listedIds.current.has(id) })') &&
      screen.includes('if (refreshing) decoder?.reset();'));
  const sentencesSrc = readFileSync(join(here, '..', 'src', 'wallet', 'activity-sentences.ts'), 'utf8');
  check('the default finder is the read-only alternate-default probe (source)',
    sentencesSrc.includes('defaultUrls: endpoint.network.defaultUrls.filter((u) => u === currentUrl || !exclude.includes(u)),') &&
      sentencesSrc.includes('return findAlternateDefaultUrl(network, currentUrl, endpoint.isOverride);') &&
      sentencesSrc.includes('const alternate = options.alternate ?? (options.run ? null : activeAlternateEndpoint(options.chainCaip2));'));
}

console.log('Default finder through config/networks.ts (mainnet defaults; primary answers null, secondary serves):');
reset({ chainId: '0x1' });
{
  const { forgetDefaultEndpointChoices } = await import('../src/config/networks.ts');
  forgetDefaultEndpointChoices();
  const [primary, secondary] = EVM_MAINNET.defaultRpcUrls;
  const hash = '0x' + 'ab'.repeat(32);
  const tx = { hash, from: ACCOUNT_2, to: ACCOUNT_1, input: '0x', value: '0x2386f26fc10000', nonce: '0x1', type: '0x2', chainId: '0x1', blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32) };
  const receipt = { transactionHash: hash, blockNumber: '0x10', blockHash: '0x' + 'cd'.repeat(32), status: '0x1', logs: [] };
  const log = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    const body = JSON.parse(init.body);
    log.push({ url: target, method: body.method });
    const reply = (result) => {
      const text = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    };
    if (target !== primary && target !== secondary) throw new TypeError('fetch failed (other candidate)');
    switch (body.method) {
      case 'eth_chainId':
        return reply('0x1');
      case 'eth_getBlockByNumber':
        return reply({ number: '0x20', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) });
      case 'eth_getTransactionByHash':
        return reply(tx);
      case 'eth_getTransactionReceipt':
        return reply(target === primary ? null : receipt);
      default:
        throw new Error(`unexpected ${body.method}`);
    }
  };
  const decoder = createActivityDecoder({ chainCaip2: 'eip155:1', evmChainId: 1n, wallet: [ACCOUNT_1], trackedTokens: [] });
  const out = await decoder.decodeEntries([hash], { listed: () => true });
  globalThis.fetch = savedFetch;
  check('the default decoder retried the null receipt on the next default and decoded it',
    out.size === 1 && render(out.get(hash), { networkId: 'eip155:1', nativeSymbol: 'ETH', contacts: [] }) === 'Received 0.01 ETH from 0xb699…81fE',
    out.size === 1 ? render(out.get(hash), { networkId: 'eip155:1', nativeSymbol: 'ETH', contacts: [] }) : log);
  check('…the receipt was read on the primary, then on the secondary after its identity probe',
    log.some((r) => r.url === primary && r.method === 'eth_getTransactionReceipt') &&
      log.some((r) => r.url === secondary && r.method === 'eth_chainId') &&
      log.some((r) => r.url === secondary && r.method === 'eth_getTransactionReceipt'),
    log);
  forgetDefaultEndpointChoices();
}

console.log('A reverted incoming transfer (2026-10-11 pass, finding 2):');
reset();
{
  const REVERTED = '0x8b7463c415b02061f43ab15d852531a34b835afb5c8ae717eef72d06b0a8871e';
  const f = fixtures.get(REVERTED);
  check('the fixture is the real status-0 receipt of an incoming 0.003 test ETH transfer',
    f?.receipt.status === '0x0' && f.transaction.to.toLowerCase() === KERNEL_OF_ACCOUNT_1.toLowerCase() && BigInt(f.transaction.value) === 3_000_000_000_000_000n);
  const {
    entryWithReceiptStatus,
    isFailedIncoming,
    FAILED_INCOMING_TITLE,
    entryPointRowSentence,
  } = await import('../src/wallet/activity-sentences.ts');
  const decoder = createActivityDecoder({ chainCaip2: SEPOLIA, evmChainId: SEPOLIA_ID, wallet: wallet1, trackedTokens: [], run: fixedRun });
  const out = await decoder.decodeEntries([REVERTED]);
  const decoded = out.get(REVERTED);
  const sets = { selfAddresses: wallet1, selfNames: [{ address: KERNEL_OF_ACCOUNT_1.toLowerCase(), name: 'your smart account' }] };
  const sentence = render(decoded, sets);
  check('the sentence names the outside sender and says nothing was received',
    sentence === 'Failed: an incoming transaction from 0x16DA…aC5C to your smart account (0.003 test ETH) was reverted, so nothing was received', sentence);
  check('…never "tried to send"', !sentence.includes('tried to'));
  check('…Hide amounts masks its value',
    render(decoded, { ...sets, hidden: true }) === 'Failed: an incoming transaction from 0x16DA…aC5C to your smart account (•••• test ETH) was reverted, so nothing was received');
  // The row as the indexer listed it (Alchemy listed this reverted transfer as "external").
  const row = { id: REVERTED, uid: `${REVERTED}:external`, timestamp: 0x6abedc9c, confirmed: true, blockHeight: 11824758, direction: 'in', amount: 3_000_000_000_000_000n, counterparty: '0x16da2caeada26516f919c6872f6c38ab378cac5c', smartAccount: true };
  const shown = entryWithReceiptStatus(row, decoded);
  check('the decoded status 0 marks the row failed', shown.failed === true && shown !== row && row.failed === undefined);
  check('…a failed incoming row: "Failed — nothing was received", no amount', isFailedIncoming(shown) && FAILED_INCOMING_TITLE === 'Failed — nothing was received');
  const okRow = { ...row, id: H.approve };
  const okDecoded = (await decoder.decodeEntries([H.approve])).get(H.approve);
  check('…an undecoded row and a successful one are returned unchanged',
    entryWithReceiptStatus(row, undefined) === row && okDecoded?.description.status === 'success' && entryWithReceiptStatus(okRow, okDecoded) === okRow);
  check('…a decode of another hash never marks the row', entryWithReceiptStatus({ ...row, id: H.approve }, decoded).failed === undefined);
  check('…an outgoing row of a reverted transaction stays a sent row (failed chip), not "nothing received"',
    isFailedIncoming(entryWithReceiptStatus({ ...row, direction: 'out' }, decoded)) === false && entryWithReceiptStatus({ ...row, direction: 'out' }, decoded).failed === true);
  check('…an EntryPoint row of a reverted transaction says no deposit',
    entryPointRowSentence({ ...row, direction: 'out', counterparty: ENTRYPOINT_V07.toLowerCase(), failed: true }, { smartAccountRow: true, nativeSymbol: 'test ETH', hidden: false }) === null &&
      entryPointRowSentence({ ...row, direction: 'out', counterparty: ENTRYPOINT_V07.toLowerCase() }, { smartAccountRow: true, nativeSymbol: 'test ETH', hidden: false }) !== null);
  const notes = await import('../src/wallet/notes.ts');
  const csvRows = notes.activityExportRows({
    network: SEPOLIA,
    networkLabel: 'Ethereum Sepolia',
    entries: [shown, row],
    nativeSymbol: 'test ETH',
    nativeDecimals: 18,
    notes: notes.indexNotes([]),
    explorerUrlFor: () => null,
  });
  const [failedRow, oldRow] = csvRows;
  check('the export: "Received (smart account) (failed)" with an empty amount and the asset named',
    failedRow[2] === 'Received (smart account) (failed)' && failedRow[3] === '' && failedRow[4] === 'test ETH', failedRow);
  check('…the same row without the decoded status still exports its amount (old behaviour, the control)',
    oldRow[2] === 'Received (smart account)' && oldRow[3] === '0.003', oldRow);
  const screen = readFileSync(join(here, '..', 'src', 'screens', 'ActivityScreen.tsx'), 'utf8');
  check('the screen applies the decoded status to every row and to the export, and a failed incoming row shows its title and no amount (source)',
    screen.includes('const item = isEvmSlot ? entryWithReceiptStatus(listed, sentences.lookup(listed.id)) : listed;') &&
      screen.includes('entries: isEvmSlot ? loadedEntries.map((e) => entryWithReceiptStatus(e, sentences.lookup(e.id))) : loadedEntries,') &&
      screen.includes('const title = failedIncoming ? FAILED_INCOMING_TITLE : directionLabel(entry.direction);') &&
      screen.includes('const showAmount = !noAmount && !failedIncoming;') &&
      screen.includes('{!showAmount ? null : ('));
}

// Pass p21a (noted): the header read Account 1's full 42-character address.
// The full address stays on screen; a screen reader hears the short form.
{
  const { spokenShortAddress } = await import('../src/a11y.ts');
  const screen = readFileSync(join(here, '..', 'src', 'screens', 'ActivityScreen.tsx'), 'utf8');
  const headerOk = (src) =>
    /<Text\s+selectable\s+accessibilityLabel=\{spokenShortAddress\(account\.address\)\}\s+style=\{\[styles\.addressLine, \{ color: theme\.textMuted \}\]\}\s*>\s*\{account\.address\}\s*<\/Text>/.test(src);
  check('p21a: the Activity header shows the full address and speaks the short one, "0x772e…F44F" (source + exact)',
    headerOk(screen) && spokenShortAddress('0x772eF8c0b0A9E1d3b2C4D5e6F7a8B9c0d1E2F44F') === '0x772e…F44F');
  check('…mutant caught: the header address spoken in full again (no label)',
    !headerOk(screen.replace('accessibilityLabel={spokenShortAddress(account.address)}', '')));
}

console.log(`\ncheck-activity: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

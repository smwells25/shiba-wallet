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
import { getAddress } from 'ethers';
import { KERNEL_V3_3, encodeFunctionCall, toHex } from '@shiba-wallet/chains-evm';
import {
  activityAccountLabels,
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
  check('the screen passes the account labels and the pinned-staking lookup for the active network, and names the EVM slot by the network (findings 4, 7e, 7f)',
    /accountLabels,\n\s*stakingContractAt: pinnedStakingAt,/.test(screen) && screen.includes('activityAccountLabels(accountList, sentences.multisigs)') &&
      screen.includes('(address: string) => stakingContractAt(evmChain.caip2, address)') &&
      screen.includes('title: account ? `${isEvmSlot ? evmChain.label : account.name} activity` : \'Activity\''));
  check("the decoder's wallet set includes the network's stored multisigs (phase 18 item 3)",
    /ownMultisigAddresses\(chainCaip2\),/.test(screen) && /wallet: walletAddressesFor\(eoa, accountIndex, aa, multisigs\),/.test(screen));
}

console.log(`\ncheck-activity: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

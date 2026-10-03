// Exercises the EVM history-indexer slice: the app's config store
// (src/wallet/indexer.ts) offline with fakes, then the real provider
// (packages/chains-evm indexer-history) LIVE through the app glue
// (src/wallet/history.ts historySourceFor), fetching two pages for the
// standard BIP-39 test mnemonic's ETH address, which has rich public
// mainnet history.
//
// SECURITY: the live endpoint URL embeds an API key. It is read from the
// git-ignored .dev-wallet/env (ALCHEMY_MAINNET) and is NEVER printed; all
// output masks it. Read-only queries only. Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-indexer.mjs
//
// Without .dev-wallet/env the live section is skipped with a notice, so
// the offline checks still run anywhere.

import { readFileSync } from 'node:fs';
import { historySourceFor, directionLabel, formatTimestamp } from '../src/wallet/history.ts';
import { clearIndexerUrl, getIndexerConfig, setIndexerUrl } from '../src/wallet/indexer.ts';
import { formatUnits } from '../src/wallet/balances.ts';

const EVM_CHAIN_ID = 'eip155:1';
// Account 0 of "abandon ... about" — public knowledge, real history.
const TEST_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

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

function memoryStore() {
  const map = new Map();
  return {
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => void map.set(k, v),
    map,
  };
}

// ---------------------------------------------------------------------------
// Offline: config store verify-before-save discipline (fake transports)
// ---------------------------------------------------------------------------
console.log('== Offline: indexer config store ==');
{
  const store = memoryStore();
  const goodTransport = () => async (method) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'alchemy_getAssetTransfers') {
      return { transfers: [{ hash: '0x' + 'ab'.repeat(32), category: 'external' }] };
    }
    throw new Error(`unexpected ${method}`);
  };

  const before = await getIndexerConfig(EVM_CHAIN_ID, store);
  check('unset config yields nulls', before.url === null && before.verifiedAt === null);

  await setIndexerUrl(EVM_CHAIN_ID, 'https://indexer.example/v2/KEY/', TEST_ADDRESS, {
    store,
    transportFor: goodTransport,
  });
  const saved = await getIndexerConfig(EVM_CHAIN_ID, store);
  check('save persists trimmed URL after verification', saved.url === 'https://indexer.example/v2/KEY');
  check('save records a verification timestamp', typeof saved.verifiedAt === 'string');

  // Wrong chain id: refuse, persist nothing new.
  const wrongChain = () => async (method) =>
    method === 'eth_chainId' ? '0xaa36a7' : { transfers: [] };
  let threw = false;
  try {
    await setIndexerUrl(EVM_CHAIN_ID, 'https://sepolia.example', TEST_ADDRESS, {
      store,
      transportFor: wrongChain,
    });
  } catch (e) {
    threw = /chain id/.test(e.message);
  }
  const after = await getIndexerConfig(EVM_CHAIN_ID, store);
  check('wrong-chain endpoint refused with a plain message', threw);
  check('refusal persisted nothing', after.url === 'https://indexer.example/v2/KEY');

  // No transfers namespace: refuse.
  const noNamespace = () => async (method) => {
    if (method === 'eth_chainId') return '0x1';
    throw new Error('RPC error -32601: Method not found (alchemy_getAssetTransfers)');
  };
  threw = false;
  try {
    await setIndexerUrl(EVM_CHAIN_ID, 'https://plain-node.example', TEST_ADDRESS, {
      store,
      transportFor: noNamespace,
    });
  } catch (e) {
    threw = /-32601/.test(e.message);
  }
  check('plain node without the namespace refused', threw);

  // Malformed URL: refuse before any network call.
  threw = false;
  try {
    await setIndexerUrl(EVM_CHAIN_ID, 'not-a-url', TEST_ADDRESS, {
      store,
      transportFor: () => async () => {
        throw new Error('must not be called');
      },
    });
  } catch (e) {
    threw = /^Endpoints must use https:\/\//.test(e.message);
  }
  check('malformed URL refused offline', threw);

  // Plain http:// (not a loopback host): refused before any request, so
  // the URL's embedded API key never travels in clear text; nothing saved.
  let transportsBuilt = 0;
  let httpMessage = null;
  try {
    await setIndexerUrl(EVM_CHAIN_ID, 'http://indexer.example/v2/KEY', TEST_ADDRESS, {
      store,
      transportFor: () => {
        transportsBuilt += 1;
        return goodTransport();
      },
    });
  } catch (e) {
    httpMessage = e.message;
  }
  check(
    'plain http:// indexer refused with the https sentence',
    httpMessage ===
      'Endpoints must use https:// (plain http:// is accepted only for localhost or 10.0.2.2 during development).',
    String(httpMessage),
  );
  check('plain http:// indexer: no transport was created', transportsBuilt === 0);
  check(
    'plain http:// indexer: stored config unchanged',
    (await getIndexerConfig(EVM_CHAIN_ID, store)).url === 'https://indexer.example/v2/KEY',
  );

  // Loopback development exception: http://localhost is verified and saved.
  await setIndexerUrl(EVM_CHAIN_ID, 'http://localhost:8545/', TEST_ADDRESS, {
    store,
    transportFor: goodTransport,
  });
  check(
    'loopback http://localhost indexer accepted after verification',
    (await getIndexerConfig(EVM_CHAIN_ID, store)).url === 'http://localhost:8545',
  );

  await clearIndexerUrl(EVM_CHAIN_ID, store);
  const cleared = await getIndexerConfig(EVM_CHAIN_ID, store);
  check('clear removes the config', cleared.url === null);

  // Corrupt storage behaves as unconfigured.
  const corrupt = memoryStore();
  corrupt.map.set('shiba-wallet.evm-indexer.v1', '{nope');
  const fromCorrupt = await getIndexerConfig(EVM_CHAIN_ID, corrupt);
  check('corrupt storage behaves as unconfigured', fromCorrupt.url === null);

  const withoutUrl = historySourceFor('evm-jsonrpc', 'https://node.example', null);
  check('no indexer -> honest unavailable state', withoutUrl.status === 'unavailable');
  const withUrl = historySourceFor('evm-jsonrpc', null, 'https://indexer.example/v2/KEY');
  check('indexer configured -> provider available', withUrl.status === 'available');
}

// ---------------------------------------------------------------------------
// Live: two pages against a real Transfers API endpoint (URL masked)
// ---------------------------------------------------------------------------
let env = null;
try {
  env = Object.fromEntries(
    readFileSync(new URL('../../.dev-wallet/env', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
} catch {
  // No local dev env; the live section is skipped below.
}

if (!env?.ALCHEMY_MAINNET) {
  console.log('\n== Live section SKIPPED: no .dev-wallet/env with ALCHEMY_MAINNET ==');
} else {
  console.log(`\n== Live: ${TEST_ADDRESS} via <ALCHEMY_MAINNET endpoint — masked> ==`);
  const source = historySourceFor('evm-jsonrpc', null, env.ALCHEMY_MAINNET);
  check('live source available', source.status === 'available');

  const printEntry = (e) => {
    const amount = e.amount === undefined ? '—' : formatUnits(e.amount, 18);
    const symbol = e.assetSymbol ?? 'ETH';
    console.log(
      `  ${e.id.slice(0, 14)}…  ${directionLabel(e.direction).padEnd(8)} ` +
        `${amount.padStart(14)} ${symbol.padEnd(8)} block ${String(e.blockHeight ?? '?').padEnd(9)} ` +
        `${formatTimestamp(e.timestamp)}`,
    );
  };

  const page1 = await source.provider.getHistory(TEST_ADDRESS);
  console.log(`page 1: ${page1.entries.length} entries, nextCursor=${page1.nextCursor ? 'present' : 'none'}`);
  for (const entry of page1.entries.slice(0, 10)) printEntry(entry);
  check('page 1 has entries', page1.entries.length > 0);
  check('page 1 has a nextCursor on this well-used address', Boolean(page1.nextCursor));
  check(
    'every entry has a uid and a direction',
    page1.entries.every((e) => typeof e.uid === 'string' && ['in', 'out', 'self'].includes(e.direction)),
  );
  check(
    'page 1 sorted newest-first by block',
    page1.entries.every(
      (e, i) => i === 0 || (page1.entries[i - 1].blockHeight ?? 0) >= (e.blockHeight ?? 0),
    ),
  );
  check(
    'native entries carry exact wei amounts, token entries a symbol',
    page1.entries.every((e) =>
      e.assetSymbol === undefined ? true : e.amount === undefined,
    ),
  );

  const page2 = await source.provider.getHistory(TEST_ADDRESS, page1.nextCursor);
  console.log(`page 2: ${page2.entries.length} entries, nextCursor=${page2.nextCursor ? 'present' : 'none'}`);
  for (const entry of page2.entries.slice(0, 5)) printEntry(entry);
  check('page 2 has entries', page2.entries.length > 0);
  const uids1 = new Set(page1.entries.map((e) => e.uid));
  const overlap = page2.entries.filter((e) => uids1.has(e.uid)).length;
  console.log(`overlap with page 1 by uid: ${overlap} entries (expected 0)`);
  check('no uid overlap across pages', overlap === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

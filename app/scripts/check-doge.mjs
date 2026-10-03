// Exercises the Dogecoin-via-Blockbook slice (phase 5, item 3): the
// endpoint config store with its verify-before-save discipline
// (src/wallet/blockbook.ts), the Blockbook estimatefee → sat/vB conversion
// and the whole quote → sign → broadcast send path (src/wallet/send.ts,
// backend 'blockbook'), the balance and history glue (src/wallet/
// balances.ts, src/wallet/history.ts), all OFFLINE against fake endpoints
// first — the signed raw transaction is independently decoded with
// bitcoinjs-lib and checked field by field — and then LIVE (read-only,
// never broadcasting) against a hosted Dogecoin-mainnet Blockbook when
// .dev-wallet/env provides NOWNODES_KEY. The key is never printed; live
// endpoint URLs are masked in all output.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-doge.mjs
//
// Addresses derive from the standard BIP-39 test mnemonic ("abandon ...
// about"), whose addresses are public knowledge.

import { readFileSync } from 'node:fs';
import { dogecoinKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  DOGECOIN,
  addressToScriptPubKey,
  blockbookHistoryProvider,
  dsha256,
  estimateVsize,
  feeForVsize,
} from '@shiba-wallet/chains-utxo';
import { Transaction } from 'bitcoinjs-lib';
import {
  BLOCKBOOK_API_KEY_HEADER,
  blockbookHeaders,
  clearBlockbookConfig,
  getBlockbookConfig,
  setBlockbookEndpoint,
} from '../src/wallet/blockbook.ts';
import {
  DOGECOIN_CHAIN_ID,
  fetchBlockbookFeeRate,
  maxUtxoSend,
  prepareUtxoSend,
  sendUtxo,
  validateRecipient,
} from '../src/wallet/send.ts';
import { fetchNativeBalance, formatUnits } from '../src/wallet/balances.ts';
import { historySourceFor } from '../src/wallet/history.ts';
import { DEFAULT_NETWORKS } from '../src/config/defaults.ts';

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

async function checkRejects(name, promiseFn, messagePattern) {
  try {
    const value = await promiseFn();
    check(name, false, `expected a rejection, got ${JSON.stringify(value)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, messagePattern.test(message), `error was: ${message}`);
  }
}

function memoryStore() {
  const map = new Map();
  return {
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => {
      map.set(k, v);
    },
    map,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(TEST_MNEMONIC);
const account = dogecoinKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);

// A second derived address as the recipient (index 1 of the same seed —
// the mnemonic is public knowledge, nothing here holds funds).
const seed2 = mnemonicToSeed(TEST_MNEMONIC);
const recipient = dogecoinKeyProvider.deriveAccount(seed2, 0, 1);
seed2.fill(0);

const FAKE_URL = 'https://blockbook.example';
const FAKE_KEY = 'test-api-key-value';

// ---------------------------------------------------------------------------
// Sanity pins: chain wiring and validation still line up
// ---------------------------------------------------------------------------

console.log('== Wiring pins ==');
check('derived DOGE chain id matches send.ts constant', account.chainId === DOGECOIN_CHAIN_ID);
const dogeNet = DEFAULT_NETWORKS.find((n) => n.chainId === DOGECOIN_CHAIN_ID);
check('defaults: Dogecoin kind is blockbook', dogeNet?.kind === 'blockbook');
check('defaults: Dogecoin still ships no default URL', dogeNet?.defaultUrl === null);
check('defaults: note names Blockbook', /blockbook/i.test(dogeNet?.note ?? ''));
check(
  'recipient still validates through the engine decode',
  validateRecipient(DOGECOIN_CHAIN_ID, recipient.address).ok === true,
);
check('api-key header constant (NOWNodes)', BLOCKBOOK_API_KEY_HEADER === 'api-key');
check('blockbookHeaders(null) is undefined', blockbookHeaders(null) === undefined);
check(
  'blockbookHeaders carries the key under api-key',
  blockbookHeaders('k')?.[BLOCKBOOK_API_KEY_HEADER] === 'k',
);

// ---------------------------------------------------------------------------
// Config store discipline (offline, in-memory store)
// ---------------------------------------------------------------------------

console.log('\n== Blockbook config store ==');
{
  const store = memoryStore();
  const empty = await getBlockbookConfig(DOGECOIN_CHAIN_ID, store);
  check(
    'empty store yields nulls',
    empty.url === null && empty.apiKey === null && empty.verifiedAt === null,
  );

  store.map.set('shiba-wallet.blockbook.v1', '{not json');
  const corrupt = await getBlockbookConfig(DOGECOIN_CHAIN_ID, store);
  check('corrupt storage behaves as unconfigured', corrupt.url === null && corrupt.apiKey === null);
  store.map.delete('shiba-wallet.blockbook.v1');

  const okFetch = async () => jsonResponse([]);
  await setBlockbookEndpoint(DOGECOIN_CHAIN_ID, `${FAKE_URL}///`, ` ${FAKE_KEY} `, account.address, {
    store,
    fetchFn: okFetch,
  });
  const saved = await getBlockbookConfig(DOGECOIN_CHAIN_ID, store);
  check('saved URL is trimmed of trailing slashes', saved.url === FAKE_URL);
  check('saved key is trimmed', saved.apiKey === FAKE_KEY);
  check('verifiedAt is an ISO timestamp', /^\d{4}-\d{2}-\d{2}T/.test(saved.verifiedAt ?? ''));

  await setBlockbookEndpoint(DOGECOIN_CHAIN_ID, FAKE_URL, '', account.address, {
    store,
    fetchFn: okFetch,
  });
  const noKey = await getBlockbookConfig(DOGECOIN_CHAIN_ID, store);
  check('empty key saves as null (key is optional)', noKey.url === FAKE_URL && noKey.apiKey === null);

  await clearBlockbookConfig(DOGECOIN_CHAIN_ID, store);
  const cleared = await getBlockbookConfig(DOGECOIN_CHAIN_ID, store);
  check('clear removes the config', cleared.url === null && cleared.verifiedAt === null);

  // Loopback development exception: a local Blockbook over plain http://.
  let localUrl = null;
  await setBlockbookEndpoint(DOGECOIN_CHAIN_ID, 'http://10.0.2.2:9130/', '', account.address, {
    store,
    fetchFn: async (url) => {
      localUrl = url;
      return jsonResponse([]);
    },
  });
  const local = await getBlockbookConfig(DOGECOIN_CHAIN_ID, store);
  check(
    'loopback http://10.0.2.2 (Android emulator host) is accepted and verified',
    local.url === 'http://10.0.2.2:9130' && localUrl === `http://10.0.2.2:9130/api/v2/utxo/${account.address}`,
  );
  await clearBlockbookConfig(DOGECOIN_CHAIN_ID, store);
}

// ---------------------------------------------------------------------------
// Verify-before-save: every reject case persists nothing
// ---------------------------------------------------------------------------

console.log('\n== Verify-before-save ==');
{
  const store = memoryStore();
  const nothingPersisted = async (name) => {
    const config = await getBlockbookConfig(DOGECOIN_CHAIN_ID, store);
    check(`${name}: nothing persisted`, config.url === null && config.apiKey === null);
  };

  await checkRejects(
    'non-http URL refused',
    () =>
      setBlockbookEndpoint(DOGECOIN_CHAIN_ID, 'ftp://x', FAKE_KEY, account.address, {
        store,
        fetchFn: async () => jsonResponse([]),
      }),
    /^Endpoints must use https:\/\//,
  );
  await nothingPersisted('non-http URL');

  // Plain http:// is refused before any request (no fetch call at all), so
  // nothing is persisted and no API key is ever sent in clear text.
  {
    let fetches = 0;
    await checkRejects(
      'plain http:// URL refused (not a loopback host)',
      () =>
        setBlockbookEndpoint(DOGECOIN_CHAIN_ID, 'http://blockbook.example', FAKE_KEY, account.address, {
          store,
          fetchFn: async () => {
            fetches += 1;
            return jsonResponse([]);
          },
        }),
      /^Endpoints must use https:\/\/ \(plain http:\/\/ is accepted only for localhost or 10\.0\.2\.2 during development\)\.$/,
    );
    check('plain http:// URL: no request was made', fetches === 0);
    await nothingPersisted('plain http:// URL');
    await checkRejects(
      'http://localhost@evil host trick refused (the host is the part after @)',
      () =>
        setBlockbookEndpoint(DOGECOIN_CHAIN_ID, 'http://localhost@blockbook.example', FAKE_KEY, account.address, {
          store,
          fetchFn: async () => {
            fetches += 1;
            return jsonResponse([]);
          },
        }),
      /^Endpoints must use https:\/\//,
    );
    check('userinfo trick: no request was made', fetches === 0);
    await nothingPersisted('userinfo trick');
  }

  await checkRejects(
    'missing wallet address refused',
    () =>
      setBlockbookEndpoint(DOGECOIN_CHAIN_ID, FAKE_URL, FAKE_KEY, '', {
        store,
        fetchFn: async () => jsonResponse([]),
      }),
    /wallet address/i,
  );

  await checkRejects(
    'HTTP 401 refused with an API-key hint',
    () =>
      setBlockbookEndpoint(DOGECOIN_CHAIN_ID, FAKE_URL, FAKE_KEY, account.address, {
        store,
        fetchFn: async () => jsonResponse({ error: 'unauthorized' }, 401),
      }),
    /HTTP 401.*API key/i,
  );
  await nothingPersisted('HTTP 401');

  await checkRejects(
    'HTTP 500 refused',
    () =>
      setBlockbookEndpoint(DOGECOIN_CHAIN_ID, FAKE_URL, FAKE_KEY, account.address, {
        store,
        fetchFn: async () => jsonResponse({}, 500),
      }),
    /HTTP 500/,
  );
  await nothingPersisted('HTTP 500');

  await checkRejects(
    'non-JSON body refused',
    () =>
      setBlockbookEndpoint(DOGECOIN_CHAIN_ID, FAKE_URL, FAKE_KEY, account.address, {
        store,
        fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }),
      }),
    /not a Blockbook API/i,
  );
  await nothingPersisted('non-JSON');

  await checkRejects(
    'JSON non-array refused (a JSON array is required)',
    () =>
      setBlockbookEndpoint(DOGECOIN_CHAIN_ID, FAKE_URL, FAKE_KEY, account.address, {
        store,
        fetchFn: async () => jsonResponse({ page: 1 }),
      }),
    /JSON array/i,
  );
  await nothingPersisted('non-array');

  await checkRejects(
    'unreachable endpoint refused',
    () =>
      setBlockbookEndpoint(DOGECOIN_CHAIN_ID, FAKE_URL, FAKE_KEY, account.address, {
        store,
        fetchFn: async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        },
      }),
    /Could not reach/i,
  );
  await nothingPersisted('unreachable');

  // The passing save must have queried the exact engine-transport URL with
  // the key under the documented header.
  let requested = null;
  await setBlockbookEndpoint(DOGECOIN_CHAIN_ID, FAKE_URL, FAKE_KEY, account.address, {
    store,
    fetchFn: async (url, init) => {
      requested = { url, headers: init?.headers };
      return jsonResponse([{ txid: 'ab', vout: 0, value: '1' }]);
    },
  });
  check(
    'verification queries GET /api/v2/utxo/{own address}',
    requested?.url === `${FAKE_URL}/api/v2/utxo/${account.address}`,
  );
  check(
    'verification sends the key as the api-key header',
    requested?.headers?.[BLOCKBOOK_API_KEY_HEADER] === FAKE_KEY,
  );
  const config = await getBlockbookConfig(DOGECOIN_CHAIN_ID, store);
  check('successful verification persists the config', config.url === FAKE_URL && config.apiKey === FAKE_KEY);
}

// ---------------------------------------------------------------------------
// estimatefee → sat/vB conversion (Blockbook returns COIN per KILOBYTE as
// a decimal string; see fetchBlockbookFeeRate in src/wallet/send.ts)
// ---------------------------------------------------------------------------

console.log('\n== Fee conversion ==');
{
  let requested = null;
  const feeFetch = (result) => async (url, init) => {
    requested = { url, headers: init?.headers };
    return jsonResponse({ result });
  };

  // Live-observed value: 0.01002934 DOGE/kB = 1,002,934 sat/kB →
  // ceil(1002934 / 1000) = 1003 sat/vB (above the 1000 floor).
  const observed = await fetchBlockbookFeeRate(FAKE_URL, {
    headers: blockbookHeaders(FAKE_KEY),
    fetchFn: feeFetch('0.01002934'),
  });
  check('0.01002934 DOGE/kB → 1003 sat/vB (exact, ceil)', observed.feeRate === 1003);
  check('fee target is 6 blocks', observed.target === 6);
  check(
    'fee query hits GET /api/v2/estimatefee/6',
    requested?.url === `${FAKE_URL}/api/v2/estimatefee/6`,
  );
  check(
    'fee query carries the api-key header',
    requested?.headers?.[BLOCKBOOK_API_KEY_HEADER] === FAKE_KEY,
  );

  const spiked = await fetchBlockbookFeeRate(FAKE_URL, { fetchFn: feeFetch('0.50727168') });
  check('0.50727168 DOGE/kB → 50728 sat/vB (rounded up)', spiked.feeRate === 50728);

  const whole = await fetchBlockbookFeeRate(FAKE_URL, { fetchFn: feeFetch('1') });
  check('1 DOGE/kB → 100000 sat/vB', whole.feeRate === 100000);

  const relayMin = await fetchBlockbookFeeRate(FAKE_URL, { fetchFn: feeFetch('0.001') });
  check('0.001 DOGE/kB (relay min, 100 sat/vB) floors to 1000', relayMin.feeRate === 1000);

  const zero = await fetchBlockbookFeeRate(FAKE_URL, { fetchFn: feeFetch('0') });
  check('a zero estimate floors to 1000 sat/vB', zero.feeRate === 1000);

  const tiny = await fetchBlockbookFeeRate(FAKE_URL, { fetchFn: feeFetch('0.00000001') });
  check('1 sat/kB rounds up to 1 then floors to 1000', tiny.feeRate === 1000);

  await checkRejects(
    'negative estimate (backend "no estimate" sentinel) rejected',
    () => fetchBlockbookFeeRate(FAKE_URL, { fetchFn: feeFetch('-1') }),
    /unusable fee estimate/i,
  );
  await checkRejects(
    'missing result rejected',
    () => fetchBlockbookFeeRate(FAKE_URL, { fetchFn: async () => jsonResponse({}) }),
    /no usable fee estimate/i,
  );
  await checkRejects(
    'HTTP error rejected',
    () => fetchBlockbookFeeRate(FAKE_URL, { fetchFn: async () => jsonResponse({}, 429) }),
    /HTTP 429/,
  );
  await checkRejects(
    'non-numeric result rejected',
    () => fetchBlockbookFeeRate(FAKE_URL, { fetchFn: feeFetch('fast') }),
    /unusable fee estimate/i,
  );
}

// ---------------------------------------------------------------------------
// Quote → sign → broadcast, fully offline against a fake Blockbook. The
// fake serves utxo/estimatefee/sendtx exactly per the shapes verified in
// packages/chains-utxo (values as strings — Dogecoin amounts overflow
// doubles); the broadcast answer echoes the correct txid (double-SHA256 of
// the raw tx, reversed), which signAndBroadcast cross-checks.
// ---------------------------------------------------------------------------

console.log('\n== Send path (offline fake Blockbook) ==');
{
  const utxos = [
    { txid: '11'.repeat(32), vout: 0, value: '10000000000' }, // 100 DOGE
    { txid: '22'.repeat(32), vout: 1, value: '500000000' }, // 5 DOGE
  ];
  let broadcast = null;
  const fakeFetch = async (url, init) => {
    if (url === `${FAKE_URL}/api/v2/utxo/${account.address}`) return jsonResponse(utxos);
    if (url === `${FAKE_URL}/api/v2/estimatefee/6`) return jsonResponse({ result: '0.01002934' });
    if (url === `${FAKE_URL}/api/v2/sendtx/`) {
      broadcast = { body: init.body, headers: init.headers };
      const raw = Buffer.from(init.body, 'hex');
      const txid = Buffer.from(dsha256(raw)).reverse().toString('hex');
      return jsonResponse({ result: txid });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const options = { backend: 'blockbook', headers: blockbookHeaders(FAKE_KEY), fetchFn: fakeFetch };

  const amount = 5000000000n; // 50 DOGE
  const quote = await prepareUtxoSend(
    FAKE_URL,
    DOGECOIN,
    account.address,
    recipient.address,
    amount,
    options,
  );
  check('quote balance sums both UTXOs (105 DOGE)', quote.balance === 10500000000n);
  check('quote fee rate is the converted 1003 sat/vB', quote.feeRate === 1003 && quote.feeTarget === 6);
  const expectedFee = feeForVsize(
    estimateVsize(
      'p2pkh',
      quote.built.tx.inputs.length,
      quote.built.tx.outputs.map((o) => o.scriptPubKey),
    ),
    1003,
  );
  check(
    `quote fee equals the engine size × rate arithmetic (${quote.fee} sat)`,
    quote.fee === expectedFee && quote.fee > 0n,
  );
  check('quote total = amount + fee (exact bigint)', quote.total === amount + quote.fee);

  await checkRejects(
    'sub-dust amount refused before building',
    () =>
      prepareUtxoSend(FAKE_URL, DOGECOIN, account.address, recipient.address, 500n, options),
    /dust/i,
  );
  await checkRejects(
    'amount above balance refused',
    () =>
      prepareUtxoSend(
        FAKE_URL,
        DOGECOIN,
        account.address,
        recipient.address,
        20000000000n,
        options,
      ),
    /insufficient|cover/i,
  );

  const swept = await maxUtxoSend(FAKE_URL, DOGECOIN, account.address, recipient.address, options);
  const maxQuote = await prepareUtxoSend(
    FAKE_URL,
    DOGECOIN,
    account.address,
    recipient.address,
    swept.amount,
    options,
  );
  check(
    'max send consumes the full balance exactly (amount + fee = balance)',
    maxQuote.total === maxQuote.balance,
  );

  const sent = await sendUtxo(FAKE_URL, DOGECOIN_CHAIN_ID, account, quote, options);
  check('broadcast POSTs to /api/v2/sendtx/ with the api-key header',
    broadcast !== null && broadcast.headers?.[BLOCKBOOK_API_KEY_HEADER] === FAKE_KEY);
  check('sendUtxo returns the cross-checked txid', /^[0-9a-f]{64}$/.test(sent.txid));
  check('no explorer link is invented for Dogecoin', sent.explorerUrl === null);

  // Independent decode of the raw transaction with bitcoinjs-lib.
  const tx = Transaction.fromHex(broadcast.body);
  check('decoded: version 2, no segwit data (legacy P2PKH)', tx.version === 2 && !tx.hasWitnesses());
  check('decoded: spends the selected UTXO(s)', tx.ins.length === quote.built.tx.inputs.length);
  const inTxid = Buffer.from(tx.ins[0].hash).reverse().toString('hex');
  check(
    'decoded: input outpoint matches the fake UTXO',
    inTxid === quote.built.tx.inputs[0].txid && tx.ins[0].index === quote.built.tx.inputs[0].vout,
  );
  check(
    'decoded: output 0 pays the recipient scriptPubKey exactly',
    Buffer.from(tx.outs[0].script).toString('hex') ===
      Buffer.from(addressToScriptPubKey(recipient.address, DOGECOIN)).toString('hex'),
  );
  check('decoded: output 0 value is the amount', BigInt(tx.outs[0].value) === amount);
  check(
    'decoded: change returns to the sender',
    tx.outs.length === 2 &&
      Buffer.from(tx.outs[1].script).toString('hex') ===
        Buffer.from(addressToScriptPubKey(account.address, DOGECOIN)).toString('hex'),
  );
  const inputTotal = quote.built.tx.inputs.reduce((s, i) => s + i.value, 0n);
  const outputTotal = tx.outs.reduce((s, o) => s + BigInt(o.value), 0n);
  check('decoded: inputs − outputs = the quoted fee exactly', inputTotal - outputTotal === quote.fee);
  check('decoded: input carries a signature script', tx.ins[0].script.length > 0);
}

// ---------------------------------------------------------------------------
// Balance + history glue (fake global fetch: these paths read the ambient
// fetch, exactly as the app does)
// ---------------------------------------------------------------------------

console.log('\n== Balance and history glue (offline) ==');
{
  const realFetch = globalThis.fetch;
  try {
    let utxoCalls = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/api/v2/utxo/')) {
        utxoCalls += 1;
        if (utxoCalls === 1) return jsonResponse({}, 503); // first attempt flakes
        check(
          'balance fetch carries the api-key header',
          init?.headers?.[BLOCKBOOK_API_KEY_HEADER] === FAKE_KEY,
        );
        return jsonResponse([
          { txid: 'aa'.repeat(32), vout: 0, value: '123456789012345' },
          { txid: 'bb'.repeat(32), vout: 1, value: '1' },
        ]);
      }
      if (String(url).includes('/api/v2/address/')) {
        const page = Number(new URL(String(url)).searchParams.get('page'));
        const mk = (txid, vin, vout) => ({ txid, vin, vout, fees: '22600000', blockTime: 1750000000, blockHeight: 5000000 + page, confirmations: 3 });
        const mine = (v) => ({ isAddress: true, addresses: [account.address], value: v });
        const other = (v) => ({ isAddress: true, addresses: [recipient.address], value: v });
        return jsonResponse({
          page,
          totalPages: 2,
          transactions:
            page === 1
              ? [
                  mk('c1'.repeat(32), [], [mine('500000000')]), // incoming 5 DOGE
                  mk('c2'.repeat(32), [mine('1000000000')], [other('900000000'), mine('77400000')]), // outgoing
                ]
              : [mk('c3'.repeat(32), [mine('300000000')], [mine('277400000')])], // self
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const balance = await fetchNativeBalance(
      'blockbook',
      FAKE_URL,
      account.address,
      blockbookHeaders(FAKE_KEY),
      1, // retry delay: keep the offline run fast
    );
    check('balance sums UTXO strings exactly (survives a flaky first try)', balance === 123456789012346n);
    check('display formatting stays exact', formatUnits(balance, 8) === '1234567.890123');

    const unconfigured = historySourceFor('blockbook', null);
    check(
      'unconfigured Dogecoin history is honestly unavailable',
      unconfigured.status === 'unavailable' && /Blockbook/.test(unconfigured.note),
    );

    const source = historySourceFor('blockbook', FAKE_URL, null, blockbookHeaders(FAKE_KEY));
    check('configured Dogecoin history resolves a provider', source.status === 'available');
    const page1 = await source.provider.getHistory(account.address);
    check('page 1 has 2 entries and a numeric page cursor', page1.entries.length === 2 && page1.nextCursor === '2');
    check(
      'incoming entry classified with the exact amount',
      page1.entries[0].direction === 'in' && page1.entries[0].amount === 500000000n,
    );
    check(
      'outgoing entry: amount excludes fee, fee reported separately',
      page1.entries[1].direction === 'out' &&
        page1.entries[1].amount === 900000000n &&
        page1.entries[1].fee === 22600000n,
    );
    const page2 = await source.provider.getHistory(account.address, page1.nextCursor);
    check('page 2 (via cursor) exhausts pagination', page2.entries.length === 1 && page2.nextCursor === undefined);
    check('self-send classified as self', page2.entries[0].direction === 'self');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// LIVE (read-only): hosted Dogecoin-mainnet Blockbook through the exact
// app glue, when .dev-wallet/env provides NOWNODES_KEY. No broadcasts.
// ---------------------------------------------------------------------------

let env = null;
try {
  env = Object.fromEntries(
    readFileSync(new URL('../../.dev-wallet/env', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
  );
} catch {
  // No local dev env; the live section is skipped below.
}

if (!env?.NOWNODES_KEY) {
  console.log('\n== Live section SKIPPED: no .dev-wallet/env with NOWNODES_KEY ==');
} else {
  console.log('\n== Live: Dogecoin mainnet via <NOWNodes Blockbook — endpoint masked> ==');
  const LIVE_URL = 'https://dogebook.nownodes.io';
  const headers = blockbookHeaders(env.NOWNODES_KEY);

  // Save-time verification, live, through the exact Settings code path
  // (in-memory store; the on-device path only differs in the store).
  const store = memoryStore();
  await setBlockbookEndpoint(DOGECOIN_CHAIN_ID, LIVE_URL, env.NOWNODES_KEY, account.address, {
    store,
  });
  const liveConfig = await getBlockbookConfig(DOGECOIN_CHAIN_ID, store);
  check('live verify-before-save passes and persists', liveConfig.url === LIVE_URL);

  await checkRejects(
    'live save with a wrong API key is refused (nothing persisted)',
    () =>
      setBlockbookEndpoint('bip122:live-badkey-test', LIVE_URL, 'wrong-key', account.address, {
        store,
      }),
    /HTTP|JSON|array|reach/i,
  );
  const badKey = await getBlockbookConfig('bip122:live-badkey-test', store);
  check('wrong-key save persisted nothing', badKey.url === null);

  const balance = await fetchNativeBalance('blockbook', LIVE_URL, account.address, headers);
  console.log(`  balance of ${account.address}: ${formatUnits(balance, 8)} DOGE`);
  check('live balance is a non-negative bigint', typeof balance === 'bigint' && balance >= 0n);

  const { feeRate, target } = await fetchBlockbookFeeRate(LIVE_URL, { headers });
  console.log(`  live fee estimate: ${feeRate} sat/vB (target ${target} blocks)`);
  check(
    'live fee rate is an integer at or above the 1000 sat/vB floor',
    Number.isInteger(feeRate) && feeRate >= 1000,
  );

  // History through the exact app glue (default page size).
  const source = historySourceFor('blockbook', LIVE_URL, null, headers);
  check('live history source resolves', source.status === 'available');
  const page = await source.provider.getHistory(account.address);
  console.log(`  page 1: ${page.entries.length} entries, nextCursor=${page.nextCursor ?? 'none'}`);
  check('live history returns entries for the test address', page.entries.length > 0);
  check(
    'every live entry is classified and exact',
    page.entries.every(
      (e) =>
        ['in', 'out', 'self'].includes(e.direction) &&
        typeof e.amount === 'bigint' &&
        typeof e.confirmed === 'boolean',
    ),
  );
  for (const entry of page.entries.slice(0, 3)) {
    console.log(
      `    ${entry.id.slice(0, 16)}…  ${entry.direction.padEnd(4)} ` +
        `${formatUnits(entry.amount, 8)} DOGE  ${entry.confirmed ? 'confirmed' : 'pending'}`,
    );
  }

  // Two-page pagination proof: the same engine provider the glue
  // constructs, at pageSize 5 so the 13-transaction test address spans
  // pages (the glue's default of 25 fits it on one page — asserted above
  // implicitly by nextCursor).
  const paged = blockbookHistoryProvider(LIVE_URL, { headers, pageSize: 5 });
  const p1 = await paged.getHistory(account.address);
  check('paged: page 1 has 5 entries and cursor "2"', p1.entries.length === 5 && p1.nextCursor === '2');
  const p2 = await paged.getHistory(account.address, p1.nextCursor);
  console.log(`  paged (size 5): page 2 has ${p2.entries.length} entries, nextCursor=${p2.nextCursor ?? 'none'}`);
  check('paged: page 2 arrives via the numeric cursor', p2.entries.length > 0);
  const ids1 = new Set(p1.entries.map((e) => e.id));
  check('paged: zero overlap between pages', p2.entries.every((e) => !ids1.has(e.id)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

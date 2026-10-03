/**
 * Dogecoin MAINNET demonstration: one real self-send, built and signed by
 * the wallet engine through exactly the code path the app's Send screen
 * uses for Dogecoin.
 *
 * Why this exists: the Chairperson decided (2026-10-02) that Dogecoin needs
 * a prototype-level demonstration rather than extensive testing, namely one
 * real mainnet broadcast of a tiny self-send. Every public Dogecoin testnet
 * faucet was dead, so mainnet is the only way to prove the end-to-end path.
 * The dev wallet's mainnet Dogecoin address is
 * DEQ788Pe98Z97Le6feBa2P49JL7ETGSMNf (m/44'/3'/0'/0/0 from
 * .dev-wallet/mnemonic.txt). The script derives it and refuses to run if
 * the derived address differs.
 *
 * Code path (nothing here re-implements wallet logic):
 *   - Key derivation: @shiba-wallet/core HdKeyring with dogecoinKeyProvider
 *     (BIP-44, coin type 3, P2PKH version byte 0x1e).
 *   - Quote: app/src/wallet/send.ts prepareUtxoSend with backend
 *     'blockbook', the same call SendScreen makes. It fetches UTXOs through
 *     the engine's blockbookTransport, converts Blockbook's
 *     GET /api/v2/estimatefee/6 answer (coin per kB as a decimal string)
 *     exactly to sat/vB with a 1000 sat/vB floor (fetchBlockbookFeeRate),
 *     and runs the engine's buildTransfer (largest-first coin selection,
 *     change back to the sender).
 *   - Signing: chains-utxo signTransaction (legacy P2PKH sighash, DER
 *     low-S, SIGHASH_ALL). Signatures are deterministic (RFC 6979), so the
 *     transaction signed for the dry-run printout is byte-identical to the
 *     one the broadcast signs; the script checks this.
 *   - Broadcast: app/src/wallet/send.ts sendUtxo, i.e. the engine's
 *     signAndBroadcast over blockbookTransport.broadcastTx, which POSTs the
 *     raw hex to /api/v2/sendtx/ and cross-checks the returned txid against
 *     the locally computed one.
 *
 * The Blockbook host is NOWNodes' Dogecoin mainnet instance
 * (https://dogebook.nownodes.io). The API key comes from NOWNODES_KEY in the
 * git-ignored .dev-wallet/env and travels only in the api-key request
 * header (the header the app uses, app/src/wallet/blockbook.ts). The key is
 * never printed.
 *
 * Behaviour:
 *   1. Default is a DRY RUN. It checks the backend's chain identity, fetches
 *      UTXOs and the fee estimate, builds and signs a self-send of 1 DOGE
 *      with change back to the same address, prints the txid, size, fee
 *      and the inputs and outputs, independently decodes the signed raw
 *      transaction with bitcoinjs-lib (outputs, amounts, fee, address
 *      version byte, signatures checked against bitcoinjs's own legacy
 *      sighash), and stops without broadcasting. With zero balance it
 *      prints the funding instruction and exits 0.
 *   2. Broadcast happens ONLY when DOGE_MAINNET_BROADCAST=1 is set AND the
 *      operator types the exact txid printed by the dry run on stdin. After
 *      broadcasting, the script polls GET /api/v2/tx/{txid} until the
 *      transaction is confirmed or a bounded timeout passes (default 20
 *      minutes, DOGE_DEMO_POLL_MINUTES to change), reporting "not yet
 *      seen", "seen in mempool" or "confirmed N".
 *   3. Safety rails, all checked before anything is signed for broadcast:
 *      the derived address must be the expected one; the backend must
 *      report coin "Dogecoin" on chain "main" and the Dogecoin genesis
 *      block hash; the fee must not exceed 2 DOGE or 5% of the amount; a
 *      change output must not be below Dogecoin Core's soft dust limit of
 *      0.01 DOGE (see DOGE_SOFT_DUST_LIMIT below); every input and output
 *      must belong to the dev address and no other address is ever used.
 *   4. `--fake-utxos` runs fully OFFLINE: a fake Blockbook (served through
 *      the same injectable fetch the app's checks use) offers one fake
 *      10 DOGE UTXO, and the identical build, sign and decode path runs
 *      against it. Broadcasting is refused in this mode.
 *
 * Usage, from the repository root after `npm run build`:
 *   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
 *   node scripts/testnet/doge-mainnet-demo.mjs                 # dry run
 *   node scripts/testnet/doge-mainnet-demo.mjs --fake-utxos    # offline proof
 *   DOGE_MAINNET_BROADCAST=1 node scripts/testnet/doge-mainnet-demo.mjs
 *
 * This script spends REAL Dogecoin from a development seed that is stored
 * in plain text on one laptop. Fund it with only a few DOGE.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  Transaction,
  address as btcAddress,
  crypto as btcCrypto,
  opcodes,
  script as btcScript,
} from 'bitcoinjs-lib';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  ChainRegistry,
  HdKeyring,
  dogecoinKeyProvider,
} from '../../packages/core/dist/index.js';
import {
  DOGECOIN,
  DUST_P2PKH,
  addressToScriptPubKey,
  blockbookTransport,
  serializeTransaction,
  signTransaction,
  transactionId,
} from '../../packages/chains-utxo/dist/index.js';
// The app's own send glue, loaded under Node type stripping exactly as the
// app's offline checks (app/scripts/check-doge.mjs) load it.
import { DOGECOIN_CHAIN_ID, prepareUtxoSend, sendUtxo } from '../../app/src/wallet/send.ts';
import { blockbookHeaders } from '../../app/src/wallet/blockbook.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPECTED_ADDRESS = 'DEQ788Pe98Z97Le6feBa2P49JL7ETGSMNf';
const EXPECTED_PATH = "m/44'/3'/0'/0/0";
const BLOCKBOOK_BASE = 'https://dogebook.nownodes.io';

/** 1 DOGE = 10^8 base units ("koinu"). */
const COIN = 100_000_000n;
/** The self-send amount: 1 DOGE. */
const AMOUNT = 1n * COIN;
/** Suggested funding for the demonstration. */
const SUGGESTED_FUNDING_DOGE = '5';

/** Fee rail 1: never pay more than 2 DOGE. */
const MAX_FEE = 2n * COIN;
/** Fee rail 2: never pay more than 5% of the amount (checked as fee*100 <= amount*5). */
const MAX_FEE_PERCENT = 5n;

/**
 * Dogecoin Core 1.14.9 (the version this Blockbook's backend reports,
 * "/Shibetoshi:1.14.9/") dust policy, from dogecoin/dogecoin at tag v1.14.9:
 *   src/policy/policy.h: RECOMMENDED_MIN_TX_FEE = COIN / 100 (0.01 DOGE);
 *     DEFAULT_DUST_LIMIT = RECOMMENDED_MIN_TX_FEE (the "soft" limit);
 *     DEFAULT_HARD_DUST_LIMIT = DEFAULT_DUST_LIMIT / 10 (0.001 DOGE).
 *   src/policy/policy.cpp IsStandardTx: an output below the hard limit
 *     makes the transaction non-standard ("dust"), so it is not relayed.
 *   src/dogecoin-fees.cpp GetDogecoinDustFee: every output below the soft
 *     limit adds the soft limit (0.01 DOGE) to the minimum relay fee.
 * The engine's generic DUST_P2PKH (546 sat, Bitcoin Core's number) is far
 * below both, so this script enforces the Dogecoin soft limit on change.
 */
const DOGE_SOFT_DUST_LIMIT = COIN / 100n; // 1,000,000 base units = 0.01 DOGE

const FAKE_MODE = process.argv.includes('--fake-utxos');
const BROADCAST = process.env.DOGE_MAINNET_BROADCAST === '1';
const POLL_MINUTES = Number(process.env.DOGE_DEMO_POLL_MINUTES ?? '20');
const POLL_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let secretKey = '';

/** Removes the API key from any text before it is printed. */
function scrub(text) {
  const s = String(text);
  return secretKey ? s.split(secretKey).join('***') : s;
}

function fail(message) {
  console.error(`\nREFUSED: ${scrub(message)}`);
  process.exit(1);
}

/** Exact base-unit amount as a DOGE decimal string (no floats). */
function doge(units) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / COIN;
  const frac = (abs % COIN).toString().padStart(8, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''} DOGE`;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function devEnv(name) {
  try {
    const text = readFileSync(new URL('../../.dev-wallet/env', import.meta.url), 'utf8');
    const line = text.split('\n').find((l) => l.startsWith(name + '='));
    return line ? line.slice(name.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Offline stand-in for the Blockbook host, used only with --fake-utxos.
 * Shapes follow the live answers recorded on 2026-10-02 (status page,
 * block-index/0, utxo list, estimatefee/6 = "0.01002525").
 */
function fakeBlockbookFetch(ownAddress) {
  const fakeTxid = toHex(btcCrypto.sha256(Buffer.from('shiba-wallet doge demo fake utxo')));
  const routes = {
    '/api': {
      blockbook: { coin: 'Dogecoin', network: 'DOGE', inSync: true, decimals: 8 },
      backend: { chain: 'main', subversion: '/Shibetoshi:1.14.9/' },
    },
    '/api/v2/block-index/0': {
      blockHash: '1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691',
    },
    [`/api/v2/utxo/${ownAddress}`]: [
      { txid: fakeTxid, vout: 0, value: (10n * COIN).toString(), height: 6399000, confirmations: 267 },
    ],
    '/api/v2/estimatefee/6': { result: '0.01002525' },
  };
  return async (url, init = {}) => {
    if (!url.startsWith(BLOCKBOOK_BASE)) throw new Error(`fake fetch: unexpected host ${url}`);
    if ((init.method ?? 'GET') !== 'GET') {
      throw new Error('fake fetch: only GET is served offline; broadcasting is impossible in --fake-utxos mode');
    }
    const body = routes[url.slice(BLOCKBOOK_BASE.length)];
    if (body === undefined) {
      return new Response(JSON.stringify({ error: 'not found (fake)' }), { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

async function getJson(fetchFn, headers, path) {
  const response = await fetchFn(`${BLOCKBOOK_BASE}${path}`, { headers });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body };
}

async function readLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(prompt, resolve));
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// 1. Key derivation and the address check
// ---------------------------------------------------------------------------

console.log(`Dogecoin mainnet demonstration — ${FAKE_MODE ? 'OFFLINE (--fake-utxos)' : 'LIVE'} ${BROADCAST && !FAKE_MODE ? 'BROADCAST MODE' : 'dry run'}\n`);

if (FAKE_MODE && BROADCAST) fail('--fake-utxos never broadcasts; unset DOGE_MAINNET_BROADCAST.');

let mnemonic;
try {
  mnemonic = readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim();
} catch {
  fail('.dev-wallet/mnemonic.txt is missing (run scripts/testnet/setup.mjs on the dev machine).');
}
const registry = new ChainRegistry();
registry.register(dogecoinKeyProvider);
const keyring = HdKeyring.fromMnemonic(mnemonic, registry);
const account = keyring.getAccount(dogecoinKeyProvider.chainId, 0, 0);

if (dogecoinKeyProvider.chainId !== DOGECOIN_CHAIN_ID) {
  fail(`core's Dogecoin chain id ${dogecoinKeyProvider.chainId} differs from the app's ${DOGECOIN_CHAIN_ID}.`);
}
if (account.path !== EXPECTED_PATH) fail(`derivation path is ${account.path}, expected ${EXPECTED_PATH}.`);
if (account.address !== EXPECTED_ADDRESS) {
  fail(`the derived address ${account.address} is not the expected ${EXPECTED_ADDRESS}. Wrong seed file?`);
}
const ownScript = addressToScriptPubKey(account.address, DOGECOIN);
console.log(`Address  ${account.address}  (${account.path}, derived and matched)`);

// ---------------------------------------------------------------------------
// 2. Backend and chain identity
// ---------------------------------------------------------------------------

let fetchFn;
let headers;
if (FAKE_MODE) {
  fetchFn = fakeBlockbookFetch(account.address);
  headers = undefined;
} else {
  secretKey = devEnv('NOWNODES_KEY') ?? '';
  if (!secretKey) fail('NOWNODES_KEY is not set in .dev-wallet/env.');
  fetchFn = fetch;
  headers = blockbookHeaders(secretKey);
}
const backendLabel = FAKE_MODE ? 'fake Blockbook (offline)' : `${BLOCKBOOK_BASE} (api-key header, key not shown)`;
console.log(`Backend  ${backendLabel}`);

try {
  const status = await getJson(fetchFn, headers, '/api');
  if (!status.ok) fail(`Blockbook status page answered HTTP ${status.status}.`);
  const coin = status.body?.blockbook?.coin;
  const chain = status.body?.backend?.chain;
  if (coin !== 'Dogecoin') fail(`Blockbook reports coin "${coin}", expected "Dogecoin".`);
  if (chain !== 'main') fail(`Blockbook backend reports chain "${chain}", expected "main".`);
  if (status.body?.blockbook?.inSync === false) fail('Blockbook reports it is not in sync; UTXOs could be stale.');
  const genesis = await getJson(fetchFn, headers, '/api/v2/block-index/0');
  const hash = genesis.body?.blockHash;
  const reference = DOGECOIN_CHAIN_ID.split(':')[1];
  if (typeof hash !== 'string' || !hash.startsWith(reference)) {
    fail(`genesis block hash ${hash} does not match the Dogecoin CAIP-2 reference ${reference}.`);
  }
  console.log(`Chain    coin "Dogecoin", chain "main", genesis ${hash.slice(0, 16)}… matches ${DOGECOIN_CHAIN_ID}`);
} catch (e) {
  fail(`chain identity check failed: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 3. Balance, then the app's quote
// ---------------------------------------------------------------------------

const transport = blockbookTransport(BLOCKBOOK_BASE, { ...(headers ? { headers } : {}), fetchFn });
let utxos;
try {
  utxos = await transport.getUtxos(account.address);
} catch (e) {
  fail(`UTXO fetch failed: ${e.message}`);
}
const balance = utxos.reduce((sum, u) => sum + u.value, 0n);
console.log(`Balance  ${doge(balance)} across ${utxos.length} UTXO(s)\n`);

if (utxos.length === 0) {
  console.log('The address holds no DOGE yet, so there is nothing to sign.');
  console.log('To run the demonstration, send about');
  console.log(`  ${SUGGESTED_FUNDING_DOGE} DOGE  to  ${account.address}`);
  console.log('(Dogecoin MAINNET). The self-send moves 1 DOGE back to the same address;');
  console.log('only the network fee (well under 0.01 DOGE at current rates) is spent.');
  console.log('Then re-run this script for the dry run, and set DOGE_MAINNET_BROADCAST=1 to broadcast.');
  process.exit(0);
}

const utxoOptions = { backend: 'blockbook', ...(headers ? { headers } : {}), fetchFn };
let quote;
try {
  quote = await prepareUtxoSend(BLOCKBOOK_BASE, DOGECOIN, account.address, account.address, AMOUNT, utxoOptions);
} catch (e) {
  console.error(scrub(e.message));
  fail(
    `could not build the 1 DOGE self-send. If funds are insufficient, add DOGE to ${account.address} ` +
      `(about ${SUGGESTED_FUNDING_DOGE} DOGE is plenty).`,
  );
}
const { built } = quote;

// ---------------------------------------------------------------------------
// 4. Safety rails on the quote
// ---------------------------------------------------------------------------

if (quote.fee > MAX_FEE) fail(`fee ${doge(quote.fee)} exceeds the 2 DOGE ceiling.`);
if (quote.fee * 100n > AMOUNT * MAX_FEE_PERCENT) {
  fail(`fee ${doge(quote.fee)} exceeds ${MAX_FEE_PERCENT}% of the ${doge(AMOUNT)} amount.`);
}
for (const input of built.tx.inputs) {
  if (!bytesEqual(input.scriptPubKey, ownScript)) fail(`input ${input.txid}:${input.vout} is not locked to ${account.address}.`);
  if (!utxos.some((u) => u.txid === input.txid && u.vout === input.vout && u.value === input.value)) {
    fail(`input ${input.txid}:${input.vout} is not in the UTXO list fetched for ${account.address}.`);
  }
}
for (const [i, output] of built.tx.outputs.entries()) {
  if (!bytesEqual(output.scriptPubKey, ownScript)) fail(`output ${i} pays a script other than ${account.address}.`);
}
if (built.tx.outputs[0].value !== AMOUNT) fail('output 0 does not carry exactly the 1 DOGE amount.');
const change = built.tx.outputs[1];
if (built.tx.outputs.length > 2) fail('unexpected extra outputs.');
if (change && change.value < DOGE_SOFT_DUST_LIMIT) {
  fail(
    `change ${doge(change.value)} is below Dogecoin's soft dust limit of ${doge(DOGE_SOFT_DUST_LIMIT)} ` +
      `(the engine's generic floor is ${DUST_P2PKH} base units; Dogecoin's is higher).`,
  );
}

// ---------------------------------------------------------------------------
// 5. Sign (engine) and print
// ---------------------------------------------------------------------------

function signRaw() {
  const signed = signTransaction(built.tx, account);
  return {
    rawHex: toHex(serializeTransaction(signed.tx, signed.signedInputs)),
    txid: transactionId(signed.tx, signed.signedInputs),
  };
}
const first = signRaw();
const second = signRaw();
if (first.rawHex !== second.rawHex) fail('signing is not deterministic; the dry-run txid would not match the broadcast.');
const { rawHex, txid } = first;
const size = rawHex.length / 2;
const inputTotal = built.tx.inputs.reduce((s, i) => s + i.value, 0n);
const outputTotal = built.tx.outputs.reduce((s, o) => s + o.value, 0n);

console.log('Signed self-send (engine-built):');
console.log(`  txid        ${txid}`);
console.log(`  size        ${size} bytes (legacy, so vsize == size)`);
console.log(`  fee         ${doge(quote.fee)} = ${quote.fee} base units`);
console.log(`  fee rate    quoted ${quote.feeRate} sat/vB (Blockbook estimatefee/${quote.feeTarget}, 1000 sat/vB floor); ` +
  `effective ${(Number(quote.fee) / size).toFixed(1)} sat/vB on the signed size`);
console.log(`  version     ${built.tx.version}, locktime ${built.tx.locktime}`);
for (const [i, input] of built.tx.inputs.entries()) {
  console.log(`  input ${i}     ${input.txid}:${input.vout}  ${doge(input.value)}`);
}
for (const [i, output] of built.tx.outputs.entries()) {
  console.log(`  output ${i}    ${doge(output.value)} -> ${account.address}${i === 0 ? ' (amount)' : ' (change)'}`);
}
console.log(`  in − out    ${doge(inputTotal - outputTotal)}`);

// ---------------------------------------------------------------------------
// 6. Independent decode with bitcoinjs-lib
// ---------------------------------------------------------------------------

console.log('\nIndependent decode (bitcoinjs-lib):');
let decodeFailures = 0;
function check(name, condition, detail = '') {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${!condition && detail ? ` — ${detail}` : ''}`);
  if (!condition) decodeFailures += 1;
}

const decoded = Transaction.fromHex(rawHex);
const addrInfo = btcAddress.fromBase58Check(EXPECTED_ADDRESS);
const expectedScript = btcScript.compile([
  opcodes.OP_DUP,
  opcodes.OP_HASH160,
  addrInfo.hash,
  opcodes.OP_EQUALVERIFY,
  opcodes.OP_CHECKSIG,
]);

check('address version byte is 0x1e (Dogecoin mainnet P2PKH)', addrInfo.version === 0x1e, `got 0x${addrInfo.version.toString(16)}`);
check('txid recomputed by bitcoinjs equals the engine txid', decoded.getId() === txid, decoded.getId());
check('serialized size equals the raw length', decoded.byteLength() === size);
check('no witness data (legacy P2PKH)', !decoded.hasWitnesses());
check(`version ${built.tx.version} and locktime ${built.tx.locktime}`, decoded.version === built.tx.version && decoded.locktime === built.tx.locktime);
check('input count matches the selection', decoded.ins.length === built.tx.inputs.length);
check('output count matches (amount + change)', decoded.outs.length === built.tx.outputs.length);

for (const [i, input] of decoded.ins.entries()) {
  const expected = built.tx.inputs[i];
  const outpointTxid = toHex(Buffer.from(input.hash).reverse());
  check(`input ${i} outpoint ${outpointTxid.slice(0, 12)}…:${input.index}`, outpointTxid === expected.txid && input.index === expected.vout);
  check(`input ${i} sequence 0xffffffff`, input.sequence === 0xffffffff);
  const chunks = btcScript.decompile(input.script) ?? [];
  const ok = chunks.length === 2 && Buffer.isBuffer(chunks[0]) && Buffer.isBuffer(chunks[1]);
  check(`input ${i} scriptSig is <signature> <pubkey>`, ok);
  if (!ok) continue;
  const pubkey = chunks[1];
  check(`input ${i} pubkey is the account's compressed key`, pubkey.length === 33 && bytesEqual(pubkey, account.publicKey));
  check(`input ${i} hash160(pubkey) equals the address hash`, bytesEqual(btcCrypto.hash160(pubkey), addrInfo.hash));
  const { signature, hashType } = btcScript.signature.decode(chunks[0]);
  check(`input ${i} sighash type is SIGHASH_ALL`, hashType === Transaction.SIGHASH_ALL);
  const sighash = decoded.hashForSignature(i, expectedScript, Transaction.SIGHASH_ALL);
  const sOk = BigInt('0x' + toHex(signature.subarray(32))) <= secp256k1.Point.CURVE().n / 2n;
  check(`input ${i} signature is low-S`, sOk);
  check(
    `input ${i} signature verifies over bitcoinjs's legacy sighash`,
    secp256k1.verify(signature, sighash, pubkey, { prehash: false }),
  );
}

let decodedOutTotal = 0n;
for (const [i, out] of decoded.outs.entries()) {
  const value = BigInt(out.value);
  decodedOutTotal += value;
  check(`output ${i} value ${doge(value)} equals the build`, value === built.tx.outputs[i].value);
  check(`output ${i} script is P2PKH to ${EXPECTED_ADDRESS}`, bytesEqual(out.script, expectedScript));
  const chunks = btcScript.decompile(out.script) ?? [];
  const hash = Buffer.isBuffer(chunks[2]) ? chunks[2] : Buffer.alloc(0);
  check(`output ${i} re-encodes (version 0x1e) to the dev address only`, hash.length === 20 && btcAddress.toBase58Check(hash, 0x1e) === EXPECTED_ADDRESS);
}
check(`output 0 is exactly ${doge(AMOUNT)}`, BigInt(decoded.outs[0].value) === AMOUNT);
check(`inputs − decoded outputs = quoted fee ${doge(quote.fee)}`, inputTotal - decodedOutTotal === quote.fee);
check('fee within rails (<= 2 DOGE and <= 5% of the amount)', quote.fee <= MAX_FEE && quote.fee * 100n <= AMOUNT * MAX_FEE_PERCENT);
check('change, if any, >= 0.01 DOGE (Dogecoin soft dust limit)', !change || change.value >= DOGE_SOFT_DUST_LIMIT);

if (decodeFailures > 0) fail(`${decodeFailures} decode check(s) failed; nothing will be broadcast.`);
console.log('  all decode checks passed');

// ---------------------------------------------------------------------------
// 7. Stop here unless explicitly armed
// ---------------------------------------------------------------------------

if (FAKE_MODE || !BROADCAST) {
  console.log(`\nDRY RUN complete. Nothing was broadcast.`);
  if (!FAKE_MODE) {
    console.log('To broadcast this exact transaction, run:');
    console.log('  DOGE_MAINNET_BROADCAST=1 node scripts/testnet/doge-mainnet-demo.mjs');
    console.log('and type the txid it prints when asked.');
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 8. Broadcast (armed + typed txid)
// ---------------------------------------------------------------------------

console.log('\nThis will broadcast a REAL Dogecoin mainnet transaction.');
if (!process.stdin.isTTY) console.log('(stdin is not a terminal; the confirmation is being read from a pipe.)');
const typed = (await readLine(`Type the txid exactly to broadcast (anything else aborts):\n> `)).trim();
if (typed !== txid) fail('the typed text does not match the txid. Nothing was broadcast.');

let result;
try {
  // Re-signs the same BuiltTransfer (deterministic, checked above) and
  // POSTs it to /api/v2/sendtx/; the engine compares the backend's txid
  // with the local one and throws on a mismatch.
  result = await sendUtxo(BLOCKBOOK_BASE, DOGECOIN_CHAIN_ID, account, quote, utxoOptions);
} catch (e) {
  fail(`broadcast failed: ${e.message}`);
}
if (result.txid !== txid) fail(`broadcast returned txid ${result.txid}, expected ${txid}.`);
console.log(`\nBROADCAST accepted by Blockbook: ${txid}`);

// ---------------------------------------------------------------------------
// 9. Poll until seen and confirmed (bounded)
// ---------------------------------------------------------------------------

const deadline = Date.now() + POLL_MINUTES * 60_000;
let state = 'not yet seen';
let confirmations = 0;
let blockHeight;
while (Date.now() < deadline) {
  try {
    const tx = await getJson(fetchFn, headers, `/api/v2/tx/${txid}`);
    if (tx.ok && tx.body?.txid === txid) {
      // Blockbook omits empty fields, so a mempool transaction may lack
      // `confirmations` entirely; blockHeight is -1 while unconfirmed.
      confirmations = Number(tx.body.confirmations ?? 0);
      blockHeight = tx.body.blockHeight;
      const next = confirmations > 0 ? `confirmed ${confirmations}` : 'seen in mempool';
      if (next !== state) console.log(`  ${new Date().toISOString()}  ${next}${confirmations > 0 ? ` (block ${blockHeight})` : ''}`);
      state = next;
      if (confirmations > 0) break;
    }
  } catch (e) {
    console.log(`  poll error (will retry): ${scrub(e.message)}`);
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

console.log(`\nFinal status after polling: ${state}${confirmations > 0 ? ` (block ${blockHeight})` : ''}`);
if (confirmations === 0) {
  console.log(`Polling stopped after ${POLL_MINUTES} minutes; the transaction may still confirm. Re-check below.`);
}
console.log('\nHow to verify independently (no explorer link is used by this wallet):');
console.log(`  Public txid: ${txid}`);
console.log(`  Blockbook:   ${BLOCKBOOK_BASE}/api/v2/tx/${txid}`);
console.log('               (send the NOWNodes key in the api-key header; the key is not shown here)');
console.log('               e.g. curl -H "api-key: $NOWNODES_KEY" <the URL above>');
console.log(`  Any Dogecoin Core node: dogecoin-cli getrawtransaction ${txid} 1`);
console.log('  Expect: two outputs (or one) paying only DEQ788Pe98Z97Le6feBa2P49JL7ETGSMNf,');
console.log(`          output 0 = 1 DOGE, fee = ${doge(quote.fee)}.`);

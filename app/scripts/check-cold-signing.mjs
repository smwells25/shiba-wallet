// Cold signing, the QR half (feature 11, phase 22 item 3), fully OFFLINE. It
// loads the exact app modules under Node's type stripping and checks:
//
//  - the multi-part QR codec (src/wallet/qr-parts.ts) with the "SW-CS:"
//    prefix: every payload round-trips through its parts in ANY order, the
//    refusals (another code's part, a contradicting part, a damaged part, a
//    whole code mid-collection, an empty code), and — with the multisig's
//    "SW-MS:" prefix — output identical to src/wallet/multisig.ts
//    splitMultisigQrParts / acceptMultisigQrScan (the lifted algorithm);
//  - the request (src/wallet/cold-signing.ts): built from real
//    prepareEvmSend / prepareErc20Send quotes against a fake node, parsed
//    strictly, refused for a type-0x04 transaction, an authorizationList
//    key, any changed field (an inconsistent signing hash) and malformed
//    values;
//  - the signature check against the STORED request: success, another
//    request, a tampered transaction, a wrong signer (stated or recovered),
//    high s, the request scanned instead of its signature, a pasted part;
//  - the raw transaction: equal to ethers' Transaction.serialized for three
//    generated cases, and byte-identical to what send.ts sendEvm and
//    send-erc20.ts sendErc20 broadcast for the same quote and key;
//  - the broadcast (send.ts sendEvmWithSignature and
//    sendEvmReplacementWithSignature): the pending registry records it, the
//    sent listeners receive it, a wrong signature is refused before any
//    request, a replacement quote is used once;
//  - who may use it: only a watch-only account (coldSignAccountRefusal), the
//    route gate (watch-only allowed, multisig refused by name), the
//    read-only allow list unchanged;
//  - ZERO secure-store reads: the whole flow run beside a key vault over a
//    counting secure-store backend (holding the very phrase whose key the
//    watched address is) reads nothing, and no module of the flow can reach
//    secure storage (import closure) or signing (source pins on the screen);
//  - the off-line half: scripts/testnet/cold-signer.mjs signs a request
//    with the public test phrase (MNEMONIC_FILE) and the app accepts the
//    result;
//  - the exact user-facing strings;
//  - mutation checks: deliberately broken copies must fail the checks.
//
// Every key is disposable: the public BIP-39 test mnemonic ("abandon ...
// about"). Nothing touches the network.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-cold-signing.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { eip1559SigningHash, encodeErc20Transfer, toBytes, toHex } from '@shiba-wallet/chains-evm';
import * as cs from '../src/wallet/cold-signing.ts';
import * as send from '../src/wallet/send.ts';
import * as pending from '../src/wallet/pending-transactions.ts';
import * as wo from '../src/wallet/watch-only.ts';
import { createQrPartCodec } from '../src/wallet/qr-parts.ts';
import { acceptMultisigQrScan, splitMultisigQrParts } from '../src/wallet/multisig.ts';
import { prepareErc20Send, sendErc20 } from '../src/wallet/send-erc20.ts';
import { createKeyVault } from '../src/wallet/storage.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolvePath(HERE, '..');
const REPO_ROOT = resolvePath(APP_ROOT, '..');
const source = (rel) => readFileSync(join(APP_ROOT, rel), 'utf8');

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
function thrown(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}
async function rejection(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
function memoryStore() {
  const map = new Map();
  return {
    map,
    async getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
    async removeItem(k) {
      map.delete(k);
    },
  };
}

// Mutants: a deliberately broken copy of an app module, loaded from a
// scratch directory with its relative imports rewritten to the real files
// (the check-bridge.mjs pattern). Removed on exit.
const MUTANT_DIR = join(HERE, `.mutants-cold-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
async function mutant(rel, ...pairs) {
  let text = source(rel);
  for (let i = 0; i < pairs.length; i += 2) {
    if (!text.includes(pairs[i])) throw new Error(`mutation anchor not found in ${rel}: ${pairs[i]}`);
    text = text.replace(pairs[i], pairs[i + 1]);
  }
  const dir = dirname(join(APP_ROOT, rel));
  const rewritten = text.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(dir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-${rel.split('/').pop()}`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// Keys and a fake node
// ---------------------------------------------------------------------------

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(TEST_MNEMONIC);
const watchedKey = evmKeyProvider.deriveAccount(seed, 0, 3); // the off-line signer's key
const strangerKey = evmKeyProvider.deriveAccount(seed, 0, 4);
seed.fill(0);
const WATCHED = watchedKey.address;
const TO = '0x69F0B8C9b3a0d6B5f5e1fE8a2E5D3b0F2C17E8aA';
const TO_CS = ethers.getAddress(TO.toLowerCase());
const USDC = ethers.getAddress('0x1c7d4b196cb0c7b01d743fbc6116a902379c7238');
const SEPOLIA = 'eip155:11155111';
const URL_A = 'https://cold-node.example/rpc';
const WORD = '0x' + (10n ** 24n).toString(16).padStart(64, '0');

function fakeNode(over = {}) {
  const state = {
    chainId: 11155111n,
    latestNonce: 5n,
    pendingNonce: 5n,
    baseFee: 14n,
    priority: 1_000_004n,
    balance: 10n ** 18n,
    estimate: 21_000n,
    callResult: WORD,
    receipts: new Map(),
    txs: new Map(),
    sent: [],
    sendRaw: (raw) => ethers.Transaction.from(raw).hash,
    ...over,
  };
  const calls = [];
  const transport = async (method, params) => {
    calls.push(method);
    switch (method) {
      case 'eth_chainId':
        return '0x' + state.chainId.toString(16);
      case 'eth_getTransactionCount':
        return '0x' + (params[1] === 'latest' ? state.latestNonce : state.pendingNonce).toString(16);
      case 'eth_getBlockByNumber':
        return { number: '0x10', baseFeePerGas: '0x' + state.baseFee.toString(16) };
      case 'eth_maxPriorityFeePerGas':
        return '0x' + state.priority.toString(16);
      case 'eth_estimateGas':
        return '0x' + state.estimate.toString(16);
      case 'eth_getBalance':
        return '0x' + state.balance.toString(16);
      case 'eth_call':
        return state.callResult;
      case 'eth_getTransactionReceipt': {
        const r = state.receipts.get(params[0]);
        return r ? { blockNumber: '0x' + r.toString(16), status: '0x1' } : null;
      }
      case 'eth_getTransactionByHash':
        return state.txs.has(params[0]) ? { hash: params[0], blockNumber: null } : null;
      case 'eth_sendRawTransaction':
        state.sent.push(params[0]);
        return state.sendRaw(params[0]);
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { state, calls, transport };
}
function useNode(node) {
  globalThis.fetch = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    let body;
    try {
      body = { jsonrpc: '2.0', id, result: await node.transport(method, params) };
    } catch (e) {
      body = { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } };
    }
    return { ok: true, status: 200, json: async () => body };
  };
}

/** What an off-line signer returns: core's own signature over the request's signing hash. */
function signAs(key, request, mutate = (x) => x) {
  const tx = cs.coldSignTxFromRequest(request);
  const sig = key.sign(eip1559SigningHash(mutate(tx)));
  return { yParity: sig[64], r: sig.slice(0, 32), s: sig.slice(32, 64) };
}
const RID = (n) => '0x' + n.toString(16).padStart(32, '0');

// ===========================================================================
console.log('check-cold-signing: the multi-part QR codec ("SW-CS:")');
// ===========================================================================
function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p]));
}
function joinParts(parts, accept = cs.acceptColdSignQrScan) {
  let scan = null;
  for (const p of parts) {
    const r = accept(scan, p);
    if (r.kind === 'complete') return r.text;
    scan = r.scan;
  }
  return null;
}
{
  const small = '{"a":1}';
  check('a payload that fits one code is ONE plain code (no prefix)', JSON.stringify(cs.splitColdSignQrParts(small)) === JSON.stringify([small]));
  const payloads = [
    'x'.repeat(2000),
    'é'.repeat(900) + 'ü'.repeat(333), // multi-byte characters, never cut inside one
    JSON.stringify({ long: '0x' + 'ab'.repeat(1500) }),
  ];
  let allOrders = true;
  let fits = true;
  for (const p of payloads) {
    const parts = cs.splitColdSignQrParts(p);
    if (!parts || parts.length < 2) {
      allOrders = false;
      continue;
    }
    if (parts.some((x) => new TextEncoder().encode(x).length > cs.COLD_SIGN_QR_PART_MAX_BYTES || !x.startsWith('SW-CS:'))) fits = false;
    const orders = parts.length <= 5 ? permutations(parts) : [parts, [...parts].reverse()];
    for (const order of orders) if (joinParts(order) !== p) allOrders = false;
    // Repeats are tolerated.
    if (joinParts([parts[0], parts[0], ...parts.slice(1)]) !== p) allOrders = false;
  }
  check('every payload round-trips through its parts in every order (incl. a repeated part)', allOrders);
  check('every part fits 858 bytes and carries the "SW-CS:" prefix', fits);
  check('a payload needing more than 20 parts is refused (null)', cs.splitColdSignQrParts('y'.repeat(858 * 21)) === null && cs.splitColdSignQrParts('') === null);
  const a = cs.splitColdSignQrParts('a'.repeat(2000));
  const b = cs.splitColdSignQrParts('b'.repeat(2000));
  const three = cs.splitColdSignQrParts('c'.repeat(3000));
  const first = cs.acceptColdSignQrScan(null, a[0]);
  check('a part of another code with the same total but different contents is refused',
    /already read with different contents/.test(thrown(() => cs.acceptColdSignQrScan(first.scan, b[0]))?.message ?? ''));
  check('a part of a code with another total is refused',
    a.length !== three.length &&
      thrown(() => cs.acceptColdSignQrScan(first.scan, three[0]))?.message ===
        `This part belongs to a code in ${three.length} parts, but the code being read has ${a.length}. Tap Start over to read a different code.`);
  check('a whole code while parts are being collected is refused',
    thrown(() => cs.acceptColdSignQrScan(first.scan, '{"x":1}'))?.message ===
      `This QR code is not part of the code being read (1 of ${a.length} parts read so far). Scan the next part of the same code, or tap Start over.`);
  check('a damaged part is refused with the cold-signing sentence',
    thrown(() => cs.acceptColdSignQrScan(null, 'SW-CS:3/2:abc'))?.message === cs.COLD_SIGN_QR_DAMAGED &&
      thrown(() => cs.acceptColdSignQrScan(null, 'SW-CS:1/1:abc'))?.message === cs.COLD_SIGN_QR_DAMAGED);
  check('an empty code is refused', thrown(() => cs.acceptColdSignQrScan(null, '   '))?.message === 'The QR code was empty.');
  check('a repeated part is reported as such in the progress line',
    cs.acceptColdSignQrScan(first.scan, a[0]).repeated === true && cs.coldSignQrProgressLine(1, 2, true) === 'That part was already read. 1 of 2 parts read. Show the next part on the signer and scan it; 1 part is still missing.' &&
      cs.coldSignQrProgressLine(1, 3) === '1 of 3 parts read. Show the next part on the signer and scan it; 2 parts are still missing.');
  // The lifted algorithm with the multisig prefix behaves exactly like the multisig's own copy.
  const ms = createQrPartCodec({ prefix: 'SW-MS:', maxBytes: 858, maxParts: 20, damagedSentence: 'This QR code looks like part of a Shiba Wallet multisig code, but it is damaged. Scan it again.' });
  const samples = ['short', 'z'.repeat(1700), 'é'.repeat(1300), JSON.stringify({ k: 'v'.repeat(5000) }), 'w'.repeat(858 * 21)];
  check('with the "SW-MS:" prefix the shared codec splits byte-identically to multisig.ts splitMultisigQrParts',
    samples.every((p) => JSON.stringify(ms.split(p)) === JSON.stringify(splitMultisigQrParts(p))));
  const msParts = splitMultisigQrParts('q'.repeat(1700));
  const sameAccept = (() => {
    const x = ms.accept(null, msParts[1]);
    const y = acceptMultisigQrScan(null, msParts[1]);
    return JSON.stringify(x) === JSON.stringify(y) && ms.accept(x.scan, msParts[0]).text === acceptMultisigQrScan(y.scan, msParts[0]).text;
  })();
  check('…and joins identically to acceptMultisigQrScan, with the same damaged-part sentence',
    sameAccept && thrown(() => ms.accept(null, 'SW-MS:3/2:x'))?.message === thrown(() => acceptMultisigQrScan(null, 'SW-MS:3/2:x'))?.message);
}

// ===========================================================================
console.log('check-cold-signing: the request, from real quotes');
// ===========================================================================
const nodeA = fakeNode();
useNode(nodeA);
const nativeQuote = await send.prepareEvmSend(URL_A, WATCHED, TO_CS, 10n ** 15n, undefined, SEPOLIA);
const erc20Quote = await prepareErc20Send({ url: URL_A, from: WATCHED, to: TO_CS, contract: USDC, amount: 1_500_000n, symbol: 'USDC', decimals: 6, chainCaip2: SEPOLIA });
function requestFor(quote, id = 1, extra = {}) {
  const tx = cs.coldSignTxFromQuote(quote);
  const summary = cs.coldSignSummary({
    tx,
    from: WATCHED,
    nativeSymbol: 'test ETH',
    ...(quote.kind === 'erc20' ? { token: { symbol: quote.symbol, decimals: quote.decimals } } : {}),
    fee: quote.fee,
    ...extra,
  });
  return cs.buildColdSignRequest({ tx, from: WATCHED, summary, requestId: RID(id) });
}
const req = requestFor(nativeQuote, 1);
const reqToken = requestFor(erc20Quote, 2);
{
  const text = cs.serializeColdSignRequest(req);
  const parsed = cs.parseColdSignRequest(text);
  check('a native request round-trips through its text unchanged', JSON.stringify(parsed) === JSON.stringify(req) && cs.serializeColdSignRequest(parsed) === text);
  check('the request carries version 1, the chain id, the watched address (EIP-55), type 0x2 and an empty access list',
    req.version === 1 && req.chainId === '11155111' && req.from === WATCHED && req.tx.type === '0x2' && req.tx.accessList.length === 0 && req.type === 'shiba-wallet/cold-sign-request');
  check('the native request\'s fields are the quote\'s (nonce, fees, gas, recipient, value, no data)',
    req.tx.nonce === nativeQuote.nonce.toString() && req.tx.maxFeePerGas === nativeQuote.maxFeePerGas.toString() && req.tx.maxPriorityFeePerGas === nativeQuote.maxPriorityFeePerGas.toString() &&
      req.tx.gasLimit === nativeQuote.gasLimit.toString() && req.tx.to === TO_CS && req.tx.value === (10n ** 15n).toString() && req.tx.data === '0x');
  check('the token request goes to the token contract with value 0 and the exact transfer calldata',
    reqToken.tx.to === USDC && reqToken.tx.value === '0' && reqToken.tx.data === toHex(encodeErc20Transfer(TO_CS, 1_500_000n)));
  const unsigned = ethers.Transaction.from({ type: 2, chainId: 11155111n, nonce: Number(req.tx.nonce), maxFeePerGas: BigInt(req.tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(req.tx.maxPriorityFeePerGas), gasLimit: BigInt(req.tx.gasLimit), to: req.tx.to, value: BigInt(req.tx.value) });
  check('the request\'s signingHash equals ethers\' unsignedHash for the same fields', req.signingHash === unsigned.unsignedHash);
  check('the summaries name every address in full and the exact amounts',
    req.summary === `Send 0.001 test ETH from ${WATCHED} to ${TO_CS} on Ethereum Sepolia (chain id 11155111), nonce 5; network fee at most ${ethers.formatUnits(nativeQuote.fee, 18).replace(/\.0$/, '')} test ETH.` &&
      reqToken.summary.startsWith(`Send 1.5 USDC (token contract ${USDC}) from ${WATCHED} to ${TO_CS} on Ethereum Sepolia (chain id 11155111), nonce 5;`),
    `${req.summary} | ${reqToken.summary}`);
  check('decodeColdSignCall: native, ERC-20 transfer, and a dirty-padded transfer is NOT called a transfer',
    cs.decodeColdSignCall(cs.coldSignTxFromRequest(req)).kind === 'native' &&
      JSON.stringify(cs.decodeColdSignCall(cs.coldSignTxFromRequest(reqToken)), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ===
        JSON.stringify({ kind: 'erc20-transfer', token: USDC, recipient: TO_CS, amount: '1500000' }) &&
      (() => {
        const dirty = toBytes(reqToken.tx.data);
        dirty[4] = 0xff; // a high byte inside the address word
        return cs.decodeColdSignCall({ ...cs.coldSignTxFromRequest(reqToken), data: dirty }).kind === 'contract-call';
      })());
  // Refusals on the signer side's parser.
  const obj = () => JSON.parse(cs.serializeColdSignRequest(req));
  const as = (o) => JSON.stringify(o);
  const t4 = obj();
  t4.tx.type = '0x4';
  check('a type-0x04 request is refused (D6)', thrown(() => cs.parseColdSignRequest(as(t4)))?.message === cs.COLD_SIGN_TYPE_REFUSAL);
  const auth = obj();
  auth.tx.authorizationList = [];
  check('a request carrying an authorizationList is refused (D6)', thrown(() => cs.parseColdSignRequest(as(auth)))?.message === cs.COLD_SIGN_TYPE_REFUSAL);
  check('…and the builder refuses a transaction object with an authorizationList',
    thrown(() => cs.buildColdSignRequest({ tx: { ...cs.coldSignTxFromRequest(req), authorizationList: [] }, from: WATCHED, summary: 's', requestId: RID(9) }))?.message === cs.COLD_SIGN_TYPE_REFUSAL);
  const tampered = obj();
  tampered.tx.value = '2000000000000000';
  check('a changed field (value) makes the request inconsistent and it is refused',
    /signing hash does not match its transaction fields/.test(thrown(() => cs.parseColdSignRequest(as(tampered)))?.message ?? ''));
  const tamperedTo = obj();
  tamperedTo.tx.to = ethers.getAddress('0x' + '12'.repeat(20));
  check('a changed recipient is refused the same way', /signing hash does not match/.test(thrown(() => cs.parseColdSignRequest(as(tamperedTo)))?.message ?? ''));
  const extra = obj();
  extra.note = 'x';
  check('an unexpected field is refused', /malformed \(unexpected or missing fields\)/.test(thrown(() => cs.parseColdSignRequest(as(extra)))?.message ?? ''));
  const lower = obj();
  lower.from = lower.from.toLowerCase();
  check('a non-EIP-55 address is refused', /malformed \(sending address\)/.test(thrown(() => cs.parseColdSignRequest(as(lower)))?.message ?? ''));
  const lead = obj();
  lead.tx.nonce = '05';
  check('a non-canonical integer is refused', /malformed \(nonce\)/.test(thrown(() => cs.parseColdSignRequest(as(lead)))?.message ?? ''));
  const list = obj();
  list.tx.accessList = [{ address: WATCHED, storageKeys: [] }];
  check('a non-empty access list is refused', /malformed \(access list\)/.test(thrown(() => cs.parseColdSignRequest(as(list)))?.message ?? ''));
  check('other JSON is not a request', thrown(() => cs.parseColdSignRequest('{"type":"x"}'))?.message === cs.COLD_SIGN_NOT_A_REQUEST);
  const parts = cs.splitColdSignQrParts(cs.serializeColdSignRequest(reqToken)) ?? [];
  check('a single pasted part is refused with its number',
    parts.length === 2 && /^This is part 1 of \d+ of a multi-part QR code, not the whole text\./.test(thrown(() => cs.parseColdSignRequest(parts[0]))?.message ?? ''));
  console.log(`  (sizes: native ${cs.serializeColdSignRequest(req).length} B, token ${cs.serializeColdSignRequest(reqToken).length} B, token parts ${parts.length})`);
  check('both requests are under 1,000 bytes (one or two QR codes)',
    cs.serializeColdSignRequest(req).length < 1000 && cs.serializeColdSignRequest(reqToken).length < 1100,
    `${cs.serializeColdSignRequest(req).length} / ${cs.serializeColdSignRequest(reqToken).length}`);
}

// ===========================================================================
console.log('check-cold-signing: the signature, checked against the STORED request');
// ===========================================================================
const goodPayload = cs.buildColdSignSignature(req, WATCHED, signAs(watchedKey, req));
{
  const v = cs.verifyColdSignSignature(goodPayload, req);
  check('a signature by the watched key over this request passes; the signer is the watched address', v.signer === WATCHED);
  const otherReq = requestFor(nativeQuote, 7);
  const forOther = cs.buildColdSignSignature(otherReq, WATCHED, signAs(watchedKey, otherReq));
  check('a signature for ANOTHER request (another request id) is refused', thrown(() => cs.verifyColdSignSignature(forOther, req))?.message === cs.COLD_SIGN_OTHER_REQUEST);
  // The signer signed a tampered transaction and reported its hash.
  const tamperedSig = signAs(watchedKey, req, (tx) => ({ ...tx, value: tx.value + 1n }));
  const tamperedHash = toHex(eip1559SigningHash({ ...cs.coldSignTxFromRequest(req), value: BigInt(req.tx.value) + 1n }));
  const p1 = JSON.parse(cs.buildColdSignSignature(req, WATCHED, tamperedSig));
  p1.signingHash = tamperedHash;
  check('a signature over changed transaction details (its own hash) is refused as a hash mismatch', thrown(() => cs.verifyColdSignSignature(JSON.stringify(p1), req))?.message === cs.COLD_SIGN_HASH_MISMATCH);
  // …and the same signature presented with OUR hash still recovers to someone else.
  const p2 = JSON.parse(cs.buildColdSignSignature(req, WATCHED, tamperedSig));
  const e2 = thrown(() => cs.verifyColdSignSignature(JSON.stringify(p2), req));
  check('…and with this request\'s hash it recovers to another address and is refused', /^This signature was made by 0x[0-9a-fA-F]{40}, not by the watched address/.test(e2?.message ?? ''), e2?.message);
  const byStranger = cs.buildColdSignSignature(req, strangerKey.address, signAs(strangerKey, req));
  check('a signature by another key (stated honestly) is refused naming both addresses',
    thrown(() => cs.verifyColdSignSignature(byStranger, req))?.message === cs.coldSignWrongSigner(strangerKey.address, WATCHED));
  const lying = cs.buildColdSignSignature(req, WATCHED, signAs(strangerKey, req));
  check('a signature by another key that CLAIMS to be the watched address is refused by recovery',
    thrown(() => cs.verifyColdSignSignature(lying, req))?.message === cs.coldSignWrongSigner(strangerKey.address, WATCHED));
  // High s: n − s with the other parity is a valid ECDSA signature that EIP-2 forbids.
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const g = JSON.parse(goodPayload);
  const high = { ...g, yParity: g.yParity === 0 ? 1 : 0, s: '0x' + (n - BigInt(g.s)).toString(16).padStart(64, '0') };
  check('a high-s signature is refused (EIP-2)', /EIP-2/.test(thrown(() => cs.verifyColdSignSignature(JSON.stringify(high), req))?.message ?? ''));
  check('yParity 27 is refused (the payload carries 0 or 1)',
    /yParity must be 0 or 1/.test(thrown(() => cs.verifyColdSignSignature(JSON.stringify({ ...g, yParity: 27 }), req))?.message ?? ''));
  check('the request scanned instead of its signature is refused', thrown(() => cs.verifyColdSignSignature(cs.serializeColdSignRequest(req), req))?.message === cs.COLD_SIGN_IS_THE_REQUEST);
  check('other text is not a signature', thrown(() => cs.verifyColdSignSignature('0x' + 'ab'.repeat(65), req))?.message === cs.COLD_SIGN_NOT_A_SIGNATURE);
  check('a signature with an extra field is refused', /unexpected or missing fields/.test(thrown(() => cs.verifyColdSignSignature(JSON.stringify({ ...g, extra: 1 }), req))?.message ?? ''));
  const sigParts = cs.splitColdSignQrParts(goodPayload.padEnd(goodPayload.length));
  check('a signature payload fits one QR code', sigParts?.length === 1, String(goodPayload.length));
  check('the signed transaction is rebuilt from the STORED request: a scanned payload cannot change a field',
    v.signed.rawHex === cs.verifyColdSignSignature(goodPayload, cs.parseColdSignRequest(cs.serializeColdSignRequest(req))).signed.rawHex &&
      ethers.Transaction.from(v.signed.rawHex).to === TO_CS && ethers.Transaction.from(v.signed.rawHex).from === WATCHED);
}

// ===========================================================================
console.log('check-cold-signing: the raw transaction equals ethers and the regular send path');
// ===========================================================================
{
  // Three generated cases (deterministic), signed by ethers as an independent off-line signer.
  let x = 0x2545f4914f6cdd1dn;
  const next = (bits) => {
    x ^= (x << 13n) & ((1n << 64n) - 1n);
    x ^= x >> 7n;
    x ^= (x << 17n) & ((1n << 64n) - 1n);
    return x % (1n << bits);
  };
  const wallet = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)));
  let allEqual = true;
  for (let i = 0; i < 3; i++) {
    const to = ethers.getAddress('0x' + next(64n).toString(16).padStart(16, '0') + next(64n).toString(16).padStart(16, '0') + next(32n).toString(16).padStart(8, '0'));
    const dataLen = i === 0 ? 0 : Number(next(6n)) + 1;
    const data = new Uint8Array(dataLen).map(() => Number(next(8n)));
    const tx = {
      chainId: [11155111n, 84532n, 11155420n][i],
      nonce: next(20n),
      maxPriorityFeePerGas: next(30n),
      maxFeePerGas: next(36n) + (1n << 30n),
      gasLimit: 21_000n + next(18n),
      to,
      value: next(60n),
      ...(dataLen > 0 ? { data } : {}),
    };
    const request = cs.buildColdSignRequest({ tx, from: wallet.address, summary: `case ${i}`, requestId: RID(100 + i) });
    const unsigned = ethers.Transaction.from({ type: 2, chainId: tx.chainId, nonce: Number(tx.nonce), maxPriorityFeePerGas: tx.maxPriorityFeePerGas, maxFeePerGas: tx.maxFeePerGas, gasLimit: tx.gasLimit, to, value: tx.value, data: dataLen > 0 ? ethers.hexlify(data) : '0x' });
    const sig = wallet.signingKey.sign(unsigned.unsignedHash);
    unsigned.signature = sig;
    const payload = cs.buildColdSignSignature(request, wallet.address, { yParity: sig.yParity, r: ethers.getBytes(sig.r), s: ethers.getBytes(sig.s) });
    const v = cs.verifyColdSignSignature(payload, request);
    if (v.signed.rawHex !== unsigned.serialized || v.signed.txHash !== unsigned.hash) allEqual = false;
  }
  check('three generated transactions: the verified raw transaction equals ethers\' Transaction.serialized (and its hash)', allEqual);

  // Byte-identical to what the regular send path broadcasts for the same quote and key.
  const nodeB = fakeNode();
  useNode(nodeB);
  send.setPendingRecordStore(memoryStore());
  await send.sendEvm(URL_A, watchedKey, nativeQuote, null);
  await sendErc20(URL_A, watchedKey, erc20Quote);
  const [sendEvmRaw, sendErc20Raw] = nodeB.state.sent;
  const vNative = cs.verifyColdSignSignature(goodPayload, req);
  const vToken = cs.verifyColdSignSignature(cs.buildColdSignSignature(reqToken, WATCHED, signAs(watchedKey, reqToken)), reqToken);
  check('native: the cold-signed raw transaction is byte-identical to what sendEvm broadcasts for the same quote and key', vNative.signed.rawHex === sendEvmRaw);
  check('token: the cold-signed raw transaction is byte-identical to what sendErc20 broadcasts for the same quote and key', vToken.signed.rawHex === sendErc20Raw);
  send.setPendingRecordStore(null);
}

// ===========================================================================
console.log('check-cold-signing: the broadcast (send.ts sendEvmWithSignature)');
// ===========================================================================
{
  const node = fakeNode();
  useNode(node);
  const store = memoryStore();
  send.setPendingRecordStore(store);
  const events = [];
  const off = send.addEvmSentListener((e) => events.push(e));
  const v = cs.verifyColdSignSignature(goodPayload, req);
  const res = await send.sendEvmWithSignature(URL_A, WATCHED, cs.coldSignBroadcastQuote(nativeQuote), v.signature, 'https://sepolia.etherscan.io/tx/');
  await new Promise((r) => setTimeout(r, 10));
  const reg = await pending.loadPendingRegistry(store);
  const rec = reg.records[0];
  check('the broadcast bytes are the verified raw transaction', node.state.sent[0] === v.signed.rawHex && res.txid === v.signed.txHash);
  check('the pending registry records it (hash, nonce, fees, gas, the watched sender, action send) — Activity\'s card applies',
    reg.records.length === 1 && rec.hash === res.txid.toLowerCase() && rec.nonce === nativeQuote.nonce.toString() && rec.from === WATCHED.toLowerCase() && rec.action === 'send' && rec.gasLimit === nativeQuote.gasLimit.toString());
  check('the sent listeners (the spending recorder\'s source) receive it with the watched address and the quote',
    events.length === 1 && events[0].from === WATCHED && events[0].txid === res.txid && events[0].quote === nativeQuote);
  check('the explorer link uses the profile\'s base', res.explorerUrl === `https://sepolia.etherscan.io/tx/${res.txid}`);
  const before = node.calls.length;
  const badSig = signAs(strangerKey, req);
  const e = await rejection(() => send.sendEvmWithSignature(URL_A, WATCHED, nativeQuote, badSig, null));
  check('a signature by another key is refused BEFORE any request to the node', e?.message === send.PRESIGNED_WRONG_SIGNER_SENTENCE && node.calls.length === before);
  // The token quote goes out as sendErc20 sends it (to = contract, value 0).
  const vt = cs.verifyColdSignSignature(cs.buildColdSignSignature(reqToken, WATCHED, signAs(watchedKey, reqToken)), reqToken);
  const resT = await send.sendEvmWithSignature(URL_A, WATCHED, cs.coldSignBroadcastQuote(erc20Quote), vt.signature, null);
  const regT = await pending.loadPendingRegistry(store);
  const recT = regT.records.find((r) => r.hash === resT.txid.toLowerCase());
  check('a token send is recorded to the token contract with value 0 and its calldata', recT?.to === USDC.toLowerCase() && recT?.value === '0' && recT?.data === reqToken.tx.data);
  off();
  send.setPendingRecordStore(null);
}

// ===========================================================================
console.log('check-cold-signing: a cold-signed speed-up / cancel (sendEvmReplacementWithSignature)');
// ===========================================================================
{
  const node = fakeNode({ pendingNonce: 6n, latestNonce: 5n });
  const store = memoryStore();
  send.setPendingRecordStore(store);
  useNode(node);
  const v = cs.verifyColdSignSignature(goodPayload, req);
  const sent = await send.sendEvmWithSignature(URL_A, WATCHED, nativeQuote, v.signature, null);
  node.state.txs.set(sent.txid.toLowerCase(), true);
  const reg = await pending.loadPendingRegistry(store);
  const group = pending.groupForHash(pending.nonceGroups(reg.records, SEPOLIA, WATCHED), sent.txid);
  const q = await send.prepareEvmReplacement(URL_A, group, 'speed-up', SEPOLIA, { transport: node.transport });
  const rreq = requestFor(q, 11, { replacement: { action: q.replacement.recordedAction, replaces: q.replacement.replaces } });
  check('the replacement request keeps the nonce, recipient and value with the new fees, and its summary says what it replaces',
    rreq.tx.nonce === '5' && rreq.tx.to === TO_CS && rreq.tx.value === (10n ** 15n).toString() && rreq.tx.maxFeePerGas === q.maxFeePerGas.toString() &&
      rreq.summary.startsWith(`Speed-up of transaction ${q.replacement.replaces} (same nonce). Send 0.001 test ETH`));
  await send.checkReplacementBeforeApproval(URL_A, q, group, { transport: node.transport });
  const rv = cs.verifyColdSignSignature(cs.buildColdSignSignature(rreq, WATCHED, signAs(watchedKey, rreq)), rreq);
  const out = await send.sendEvmReplacementWithSignature(URL_A, WATCHED, q, rv.signature, null, { transport: node.transport, store });
  const reg2 = await pending.loadPendingRegistry(store);
  const rec = reg2.records.find((r) => r.hash === out.txid.toLowerCase());
  check('the replacement is broadcast and recorded as a speed-up of the original', rec?.action === 'speed-up' && rec?.replaces === sent.txid.toLowerCase() && node.state.sent.at(-1) === rv.signed.rawHex);
  check('the same replacement quote cannot go out twice', (await rejection(() => send.sendEvmReplacementWithSignature(URL_A, WATCHED, q, rv.signature, null, { transport: node.transport, store })))?.message === pending.REPLACEMENT_QUOTE_USED);
  const q2 = await send.prepareEvmReplacement(URL_A, pending.groupForHash(pending.nonceGroups(reg2.records, SEPOLIA, WATCHED), out.txid), 'cancel', SEPOLIA, { transport: node.transport });
  const creq = requestFor(q2, 12, { replacement: { action: q2.replacement.recordedAction, replaces: q2.replacement.replaces } });
  const before = node.calls.length;
  const wrong = await rejection(() => send.sendEvmReplacementWithSignature(URL_A, WATCHED, q2, signAs(strangerKey, creq), null, { transport: node.transport, store }));
  check('a cancellation request sends 0 to the watched address itself, and its summary says so', creq.tx.to === WATCHED && creq.tx.value === '0' && creq.summary.includes(`Cancel: send 0 test ETH from ${WATCHED} to itself`));
  check('a replacement signed by another key is refused before any request', wrong?.message === send.PRESIGNED_WRONG_SIGNER_SENTENCE && node.calls.length === before);
  send.setPendingRecordStore(null);
}

// ===========================================================================
console.log('check-cold-signing: who may use it');
// ===========================================================================
{
  check('a watch-only account may', cs.coldSignAccountRefusal({ watchOnly: true }) === null && cs.coldSignAccountRefusal({ watchOnly: true, multisig: false }) === null);
  check('an account whose key is in this wallet is refused (phrase or imported)', cs.coldSignAccountRefusal({ watchOnly: false }) === cs.COLD_SIGN_HAS_KEY_REFUSAL);
  check('a multisig is refused', cs.coldSignAccountRefusal({ watchOnly: false, multisig: true }) === cs.COLD_SIGN_MULTISIG_REFUSAL);
  check('no account: refused', cs.coldSignAccountRefusal(null) === cs.COLD_SIGN_NO_ACCOUNT);
  check('the route gate: ColdSign allowed for a watch-only account', wo.watchOnlyRouteRefusal('ColdSign') === null);
  check('…refused for a multisig, by name',
    wo.multisigRouteRefusal('ColdSign') === 'Sending with an off-line signer is not available for a multi-signature account: no single key in this wallet can sign for it. Build its operations on the Multisig screen, where the co-signers approve them, or switch to one of your own accounts.');
  check('the read-only allow list is unchanged, and the cold-signing list holds only ColdSign',
    JSON.stringify(wo.WATCH_ONLY_ALLOWED_ROUTES) === JSON.stringify(['Home', 'Activity', 'Nfts', 'NftDetail', 'Tokens', 'Approvals', 'Settings', 'Contacts', 'ImportKey', 'Receive', 'Portfolio', 'PriceAlerts', 'Inbox']) &&
      JSON.stringify(wo.WATCH_ONLY_COLD_SIGN_ROUTES) === JSON.stringify(['ColdSign']));
  check('Send itself stays refused for a watch-only account', wo.watchOnlyRouteRefusal('Send')?.startsWith('Sending is not available for a watch-only account') === true);
  const app = readFileSync(join(APP_ROOT, 'App.tsx'), 'utf8');
  check('App.tsx registers the route with its title', app.includes('<Stack.Screen name="ColdSign" component={ColdSignScreen} options={{ title: \'Send with an off-line signer\' }} />'));
}

// ===========================================================================
console.log('check-cold-signing: zero secure-store reads, no signing anywhere in the flow');
// ===========================================================================
{
  // A key vault over a counting secure-store backend, holding the very phrase
  // whose index-3 key IS the watched address (the worst case: the key is on
  // this phone). The whole cold flow runs beside it; it must read nothing.
  const calls = { get: 0, set: 0, delete: 0 };
  const items = new Map();
  const backend = {
    whenUnlockedThisDeviceOnly: 5,
    async getItemAsync(k, o) {
      calls.get += 1;
      return items.get(`${o?.keychainService ?? ''}|${k}`) ?? null;
    },
    async setItemAsync(k, v, o) {
      calls.set += 1;
      items.set(`${o?.keychainService ?? ''}|${k}`, v);
    },
    async deleteItemAsync(k, o) {
      calls.delete += 1;
      items.delete(`${o?.keychainService ?? ''}|${k}`);
    },
    canUseBiometricAuthentication: () => false,
  };
  const vault = createKeyVault(backend, { policy: 'off' });
  await vault.saveNewPhrase(TEST_MNEMONIC);
  calls.get = 0;
  calls.set = 0;
  calls.delete = 0;
  const node = fakeNode();
  useNode(node);
  send.setPendingRecordStore(memoryStore());
  const q = await send.prepareEvmSend(URL_A, WATCHED, TO_CS, 10n ** 14n, undefined, SEPOLIA);
  const r = requestFor(q, 21);
  const qrText = joinParts([...(cs.splitColdSignQrParts(cs.serializeColdSignRequest(r)) ?? [])].reverse());
  const signerSide = cs.parseColdSignRequest(qrText);
  const payload = cs.buildColdSignSignature(signerSide, WATCHED, signAs(watchedKey, signerSide));
  const v = cs.verifyColdSignSignature(payload, r);
  await send.sendEvmWithSignature(URL_A, WATCHED, q, v.signature, null);
  send.setPendingRecordStore(null);
  check('the whole flow (quote → request → QR → signature → verify → broadcast): ZERO secure-store reads and writes', calls.get === 0 && calls.set === 0 && calls.delete === 0, JSON.stringify(calls));

  // No module of the flow can reach secure storage: the relative-import closure.
  const closure = (startRel) => {
    const seen = new Set();
    const bare = new Set();
    const visit = (abs) => {
      if (seen.has(abs)) return;
      seen.add(abs);
      const text = readFileSync(abs, 'utf8');
      for (const m of text.matchAll(/(?:^|\n)\s*(import|export)(\s+type\b)?[^'"]*?from\s+'([^']+)'/g)) {
        if (m[2]) continue; // a type-only import loads nothing at run time
        const spec = m[3];
        if (!spec.startsWith('.')) {
          bare.add(spec);
          continue;
        }
        const base = resolvePath(dirname(abs), spec);
        const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
        const found = candidates.find((c) => {
          try {
            return readFileSync(c) && /\.tsx?$/.test(c);
          } catch {
            return false;
          }
        });
        if (found) visit(found);
      }
    };
    visit(join(APP_ROOT, startRel));
    return { files: [...seen].map((f) => f.slice(APP_ROOT.length + 1)), bare: [...bare] };
  };
  const c1 = closure('src/wallet/cold-signing.ts');
  const c2 = closure('src/wallet/send.ts');
  const added = c1.files.filter((f) => !c2.files.includes(f));
  check('cold-signing.ts adds no module to the regular send path\'s import graph except itself and the QR codec',
    JSON.stringify(added.sort()) === JSON.stringify(['src/wallet/cold-signing.ts', 'src/wallet/qr-parts.ts']), added.join(', '));
  const forbidden = (c) => c.files.filter((f) => /wallet\/(storage|WalletContext|biometric)\.tsx?$/.test(f));
  check('…and neither graph loads the key vault (storage.ts), the wallet context or the device check (biometric.ts), nor imports expo-secure-store at run time',
    forbidden(c1).length === 0 && forbidden(c2).length === 0 && !c1.bare.includes('expo-secure-store') && !c2.bare.includes('expo-secure-store'),
    [...forbidden(c1), ...forbidden(c2)].join(', '));
  const screen = source('src/screens/ColdSignScreen.tsx');
  const views = source('src/screens/ColdSignViews.tsx');
  // Comments are stripped first: the screen's own doc comment says what it never calls.
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const screenProblems = (raw) => [/\bsignWith\b/, /requireLocalAuth/, /readPhrase/, /importedKeyVault/, /SecureStore/, /readSecureItem/, /\bvault\b/, /signEip1559/, /deriveAccount/].filter((re) => re.test(code(raw))).map(String);
  check('the screen and its views never sign, never ask for the device check, never read the phrase, a key or secure storage (source)',
    screenProblems(screen).length === 0 && screenProblems(views).length === 0, screenProblems(screen).join(' '));
  check('…mutant caught: a screen that calls signWith', screenProblems(screen.replace('const { accounts, activeAccount } = useWallet();', 'const { accounts, activeAccount, signWith } = useWallet();')).length === 1);
  check('the screen takes only public data from the wallet context', screen.includes('const { accounts, activeAccount } = useWallet();'));
  check('the screen refuses every account but a watch-only one before anything else renders',
    /const refusal = coldSignAccountRefusal\(activeAccount\);[\s\S]*if \(refusal \|\| !from\) \{\s*return \(/.test(screen));
  const onShow = screen.slice(screen.indexOf('const onShow = async'), screen.indexOf('const onSignatureText'));
  check('the spending-limit gate runs BEFORE the request is built (as on Send, before signing)',
    onShow.indexOf('spendingGateForQuote(') > 0 && onShow.indexOf('evaluateBeforeSigning(') > 0 &&
      onShow.indexOf('spendingGateForQuote(') < onShow.indexOf('buildColdSignRequest(') && onShow.indexOf('if (!allowed) return;') < onShow.indexOf('buildColdSignRequest('));
  const onBroadcast = screen.slice(screen.indexOf('const onBroadcast = async'), screen.indexOf('// ---------------------------------------------------------------- success'));
  check('the broadcast needs a verified signature, pins the quote\'s endpoint, re-checks a replacement, then uses the *WithSignature functions with the verified signature',
    onBroadcast.includes('if (!quote || !quotedUrl || !verified || !request) return;') && onBroadcast.indexOf('quoteEndpointChange(') < onBroadcast.indexOf('setPhase(\'sending\')') &&
      onBroadcast.indexOf('checkReplacementBeforeApproval(') < onBroadcast.indexOf('sendEvmReplacementWithSignature(') &&
      onBroadcast.includes('verified.signature') && !/serializeSignedEip1559|signed\.rawHex/.test(onBroadcast));
  check('a signature is checked against the STORED request (verifyColdSignSignature(text, request))', screen.includes('setVerified(verifyColdSignSignature(text, request));'));
  check('the Send screen\'s own quote, preview, risk card, spending notice and pre-flight gate are used (source)',
    ['prepareEvmSend(', 'prepareErc20Send(', '<BalanceChangePreview', '<RiskWarnings', '<SpendingPolicyNotice', 'validateRecipient(EVM_CHAIN_ID, recipient)', 'disabled={simulationFailed && !overrideSimulation}'].every((s) => screen.includes(s)));
  check('the Developer minimum-fee rehearsal applies to a native cold send (armed check, one-shot consume after the broadcast, the same warning)',
    screen.includes('...(minimumFeeRehearsalArmed(evmChain.caip2) ? { minimumFee: true } : {}),') && onBroadcast.includes('consumeMinimumFeeRehearsal(quote);') &&
      screen.includes('<WarningBox>{MINIMUM_FEE_REHEARSAL_WARNING}</WarningBox>'));
  check('the success view shows the pending card (Speed up / Cancel) and the note field', screen.includes('<PendingTransactionsSection from={from} onlyHash={result.txid} />') && screen.includes('<TransactionNoteField'));
  // Pass p22a finding 2: the asset chips showed no chosen state although the
  // amount label followed the chosen asset. Every chip in the "What to send"
  // row is drawn like Settings' network chips: one condition decides the
  // "✓" title, the primary fill and accessibilityState selected together.
  const chipProblems = (raw) => {
    const at = raw.indexOf('>What to send</Text>');
    const row = at < 0 ? '' : raw.slice(at, raw.indexOf('</View>', at));
    const buttons = [...row.matchAll(/<Button\b([\s\S]*?)\/>/g)].map((m) => m[1]);
    const out = [];
    if (buttons.length !== 2) out.push(`${buttons.length} chip Buttons in the row (want the native coin and the token map)`);
    for (const b of buttons) {
      const sel = /selected=\{([^}]+)\}/.exec(b)?.[1];
      if (!sel) { out.push('a chip without selected'); continue; }
      if (!b.includes(`variant={${sel} ? 'primary' : 'secondary'}`)) out.push(`chip ${sel}: its fill does not follow the choice`);
      if (!new RegExp(`title=\\{assetChipTitle\\([^,]+, ${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\}`).test(b)) out.push(`chip ${sel}: its title has no "✓" for the choice`);
    }
    return out;
  };
  check('p22a finding 2: the asset chips mark the chosen one: a "✓" title, the primary fill and accessibilityState selected, from one condition (source)',
    chipProblems(screen).length === 0 && screen.includes('return chosen ? `✓ ${label}` : label;'), chipProblems(screen).join('; '));
  check('…mutant caught: the old chips, all secondary with no mark',
    chipProblems(screen.replace("variant={tokenId === null ? 'primary' : 'secondary'}", 'variant="secondary"')).length === 1 &&
      chipProblems(screen.replace('title={assetChipTitle(t.symbol, tokenId === id)}', 'title={t.symbol}')).length === 1);
  const components = source('src/components.tsx');
  check('…and Button reports selected to screen readers and leaves the "✓" out of the spoken label (components.tsx)',
    components.includes('accessibilityState={{ disabled, ...(selected !== undefined ? { selected } : {}) }}') &&
      components.includes("accessibilityLabel ?? (selected !== undefined ? title.replace(/^✓\\s*/, '') : undefined);"));
}

// ===========================================================================
console.log('check-cold-signing: the off-line half (scripts/testnet/cold-signer.mjs)');
// ===========================================================================
{
  const dir = join(MUTANT_DIR, 'signer');
  mkdirSync(dir, { recursive: true });
  const phraseFile = join(dir, 'public-test-phrase.txt');
  writeFileSync(phraseFile, TEST_MNEMONIC);
  const reqFile = join(dir, 'request.txt');
  // The request as the QR parts, one per line, in reverse order.
  const parts = cs.splitColdSignQrParts(cs.serializeColdSignRequest(reqToken));
  writeFileSync(reqFile, [...parts].reverse().join('\n'));
  const run = (args) =>
    execFileSync(process.execPath, [join(REPO_ROOT, 'scripts/testnet/cold-signer.mjs'), ...args], {
      env: { ...process.env, MNEMONIC_FILE: phraseFile, NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const out = run(['sign', reqFile, '3']).trim();
  let ok = false;
  try {
    ok = cs.verifyColdSignSignature(out, reqToken).signer === WATCHED;
  } catch {
    ok = false;
  }
  check('the scripted signer (dev index 3 of the public phrase) signs the request read from its QR parts, and the app accepts it', ok);
  const wrongIndex = (() => {
    try {
      run(['sign', reqFile, '4']);
      return null;
    } catch (e) {
      return String(e.stderr);
    }
  })();
  check('…it refuses to sign with a key that is not the request\'s sender', /This request is for 0x[0-9a-fA-F]{40}, but the chosen key is 0x[0-9a-fA-F]{40}\. Nothing was signed\./.test(wrongIndex ?? ''));
  const mainReq = cs.buildColdSignRequest({ tx: { ...cs.coldSignTxFromRequest(req), chainId: 1n }, from: WATCHED, summary: 'main', requestId: RID(31) });
  writeFileSync(reqFile, cs.serializeColdSignRequest(mainReq));
  const mainRefusal = (() => {
    try {
      run(['sign', reqFile, '3']);
      return null;
    } catch (e) {
      return String(e.stderr);
    }
  })();
  check('…and refuses a request for a chain outside the test networks', /Chain id 1 is not one of the test networks this script signs for/.test(mainRefusal ?? ''));
  check('its selftest passes offline', /selftest: OK/.test(run(['selftest'])));
}

// ===========================================================================
console.log('check-cold-signing: the exact strings');
// ===========================================================================
{
  const exact = [
    ['COLD_SIGN_CHOICE_TITLE', 'Send with an off-line signer'],
    ['COLD_SIGN_HOME_LINK', 'Send with an off-line signer ↗'],
    ['COLD_SIGN_LINK_HINT', 'Prepares a send for this watched address that an off-line signer holding its key signs'],
    ['COLD_SIGN_INTRO', 'This address is watched: this wallet holds no key for it. You can still prepare a send here and have it signed by an off-line signer that holds the key, such as another device kept away from the internet. The wallet shows the unsigned transaction as QR codes, the signer signs it, and you scan its signature back. Nothing is sent until the wallet has checked that signature.'],
    ['COLD_SIGN_QR_CONTENTS', 'These QR codes contain only the unsigned transaction (the network, the sending address, the nonce, the fees, the recipient, the amount and the call data), a plain summary and a request number. They contain no key and no secret: anyone who sees them learns what you plan to send, but cannot send it.'],
    ['COLD_SIGN_CHECK_ON_SIGNER', 'Before signing, check on the off-line signer that it shows the same recipient, amount, network and fee as this screen. Sign only if they match.'],
    ['COLD_SIGN_FORMAT_NOTE', 'This is Shiba Wallet’s own request format (shiba-wallet/cold-sign-request, version 1), not the EIP-4527 format some hardware signers read, so the off-line signer must understand this format.'],
    ['COLD_SIGN_SCAN_NOTE', 'Scan the signature the off-line signer shows. A signature for a different request, from a different key or over changed transaction details is refused. The wallet broadcasts only after it has checked that the watched address signed exactly the transaction shown above.'],
    ['COLD_SIGN_REVIEW_AGAIN_NOTE', 'The request is kept only while this screen is open. If you leave, review the send again and have the new request signed; an old signature is refused for a new request.'],
    ['COLD_SIGN_OTHER_REQUEST', 'This signature belongs to another signing request, not the one shown on this screen, so it was refused. Nothing was sent. Scan the signature the off-line signer made for this request.'],
    ['COLD_SIGN_HASH_MISMATCH', 'The off-line signer signed different transaction details from the ones shown here (the signing hash differs), so the signature was refused. Nothing was sent. Check that the signer read this request, and compare the recipient and amount it shows with this screen.'],
    ['COLD_SIGN_NOT_A_SIGNATURE', 'This is not a Shiba Wallet cold-signing signature. Nothing was sent. Scan the signature QR code the off-line signer shows after it signs.'],
    ['COLD_SIGN_IS_THE_REQUEST', 'This is the signing request itself, not its signature. Nothing was sent. Scan the code the off-line signer shows after it has signed.'],
    ['COLD_SIGN_TYPE_REFUSAL', 'This request is not an ordinary EIP-1559 transaction (type 0x2). The wallet never asks an off-line signer to sign an EIP-7702 authorization or any other transaction type, so it was refused.'],
    ['COLD_SIGN_HAS_KEY_REFUSAL', 'Signing with an off-line signer is offered only for a watch-only account. This account’s key is in this wallet, so send from the Send screen instead.'],
    ['COLD_SIGN_MULTISIG_REFUSAL', 'Signing with an off-line signer is not offered for a multi-signature account: its operations are signing requests for its co-signers, built on the Multisig screen.'],
    ['COLD_SIGN_QR_DAMAGED', 'This QR code looks like part of a Shiba Wallet cold-signing code, but it is damaged. Scan it again.'],
    ['COLD_SIGN_SHOW_BUTTON', 'Show for the off-line signer'],
    ['COLD_SIGN_SCAN_BUTTON', 'Scan the signature'],
    ['COLD_SIGN_BROADCAST_BUTTON', 'Broadcast the signed transaction'],
  ];
  const wrong = exact.filter(([k, v]) => cs[k] !== v).map(([k]) => k);
  check(`the ${exact.length} fixed sentences and labels are exact`, wrong.length === 0, wrong.join(', '));
  check('coldSignWrongSigner and coldSignVerifiedLine (exact)',
    cs.coldSignWrongSigner('0xA', '0xB') === 'This signature was made by 0xA, not by the watched address 0xB, so it was refused. Nothing was sent. Sign with the key of the watched address.' &&
      cs.coldSignVerifiedLine('0xB') === 'Signature checked: made by the watched address 0xB over exactly the transaction shown above.');
  check('the wrong-signer refusal of a broadcast (exact)', send.PRESIGNED_WRONG_SIGNER_SENTENCE === 'The signature was not made by the sending address over this transaction, so nothing was sent.');
  check('the paged-code sentence and part caption', cs.coldSignQrPagedNote(2) === 'This is too much for one reliable QR code, so it is shown as 2 codes. The off-line signer scans them one at a time; tap Next part after each one is read. The order does not matter.' &&
    cs.coldSignQrPartCaption('Unsigned transaction for the off-line signer', 0, 2) === 'Unsigned transaction for the off-line signer — part 1 of 2');
}

// ===========================================================================
console.log('check-cold-signing: mutation checks (broken copies must fail)');
// ===========================================================================
{
  const forOther = (() => {
    const other = requestFor(nativeQuote, 7);
    return cs.buildColdSignSignature(other, WATCHED, signAs(watchedKey, other));
  })();
  // M1: no request-id check.
  const m1 = await mutant('src/wallet/cold-signing.ts', "if (typeof o.requestId !== 'string' || o.requestId.toLowerCase() !== request.requestId) {", 'if (false) {');
  check('M1 caught: without the request-id check, a signature for another request is not refused as such',
    thrown(() => m1.verifyColdSignSignature(forOther, req))?.message !== cs.COLD_SIGN_OTHER_REQUEST);
  // M2: no signing-hash cross-check.
  const tamperedSig = signAs(watchedKey, req, (tx) => ({ ...tx, value: tx.value + 1n }));
  const p1 = JSON.parse(cs.buildColdSignSignature(req, WATCHED, tamperedSig));
  p1.signingHash = toHex(eip1559SigningHash({ ...cs.coldSignTxFromRequest(req), value: BigInt(req.tx.value) + 1n }));
  const m2 = await mutant('src/wallet/cold-signing.ts', "if (typeof o.signingHash !== 'string' || o.signingHash.toLowerCase() !== expectedHash) {", 'if (false) {');
  check('M2 caught: without the hash cross-check, the tampered-details case loses its own sentence',
    thrown(() => m2.verifyColdSignSignature(JSON.stringify(p1), req))?.message !== cs.COLD_SIGN_HASH_MISMATCH);
  // M3: trusting the stated signer (no recovery).
  const m3 = await mutant('src/wallet/cold-signing.ts', 'if (recovered.toLowerCase() !== request.from.toLowerCase()) {', 'if (false) {');
  const lying = cs.buildColdSignSignature(req, WATCHED, signAs(strangerKey, req));
  check('M3 caught: trusting the stated signer lets another key\'s signature through', thrown(() => m3.verifyColdSignSignature(lying, req)) === null);
  // M4: a type-0x04 request accepted.
  const m4 = await mutant('src/wallet/cold-signing.ts', "(txLoose.type !== COLD_SIGN_TX_TYPE || 'authorizationList' in txLoose)", "('authorizationList' in txLoose)");
  const t4 = JSON.parse(cs.serializeColdSignRequest(req));
  t4.tx.type = '0x4';
  check('M4 caught: without the type check a type-0x04 request parses', thrown(() => m4.parseColdSignRequest(JSON.stringify(t4))) === null);
  // M5: the token transaction built to the recipient instead of the contract.
  const m5 = await mutant('src/wallet/cold-signing.ts', '      to: quote.contract,\n      value: 0n,\n      data: quote.data,', '      to: quote.to,\n      value: 0n,\n      data: quote.data,');
  check('M5 caught: a token transaction sent to the recipient instead of the contract no longer matches sendErc20',
    m5.coldSignTxFromQuote(erc20Quote).to !== cs.coldSignTxFromQuote(erc20Quote).to);
  // M6: send.ts broadcasting without the recovered-signer check.
  const m6 = await mutant('src/wallet/send.ts', "  if (recoverEip1559Signer(tx, signature).toLowerCase() !== from.toLowerCase()) {\n    throw new Error(PRESIGNED_WRONG_SIGNER_SENTENCE);\n  }", '');
  const node = fakeNode();
  useNode(node);
  m6.setPendingRecordStore(memoryStore());
  const e6 = await rejection(() => m6.sendEvmWithSignature(URL_A, WATCHED, nativeQuote, signAs(strangerKey, req), null));
  check('M6 caught: without the signer check a stranger\'s signature reaches the node', e6 === null && node.state.sent.length === 1);
  // M7: the route gate without the cold-signing list.
  const m7 = await mutant('src/wallet/watch-only.ts', ' || WATCH_ONLY_COLD_SIGN_ROUTES.includes(routeName)', '');
  check('M7 caught: without the cold-signing list the watch-only account is refused the screen', m7.watchOnlyRouteRefusal('ColdSign') !== null);
  // M8: the QR codec without the contradiction check.
  const m8 = await mutant('src/wallet/qr-parts.ts', 'if (previous !== null && previous !== undefined && previous !== chunk) {', 'if (false) {');
  const codec = m8.createQrPartCodec({ prefix: 'SW-CS:', maxBytes: 858, maxParts: 20, damagedSentence: 'd' });
  const a = codec.split('a'.repeat(2000));
  const b = codec.split('b'.repeat(2000));
  check('M8 caught: without the contradiction check a part of another code replaces a part already read',
    thrown(() => codec.accept(codec.accept(null, a[0]).scan, b[0])) === null);
}

console.log(`\ncheck-cold-signing: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

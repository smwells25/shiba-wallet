// Exercises stuck and failed transactions (feature 95, the transaction half):
// src/wallet/pending-transactions.ts (the registry, the replacement fee rule,
// the resolution of a nonce, the smart-account status) and the replacement
// path in src/wallet/send.ts (prepareEvmReplacement,
// checkReplacementBeforeApproval, sendEvmReplacement and the recorder every
// sendEvm broadcast feeds), fully offline: a fake JSON-RPC node and an
// in-memory store. Nothing touches the network.
//
// Covered: the 10% bump in exact bigint against both clients' rules
// (go-ethereum: strictly higher and at least floor(old × 110 / 100); reth: at
// least ceil(old × 110 / 100)); the fee choice (max of the bumped minimum and
// the node's suggestion); the registry's strict parse and read-only state;
// the cap; the queue (a read right after a write sees it; a write never
// waits for itself); every nonce outcome (pending, mined, replaced,
// cancelled, the original first, the nonce used elsewhere, a null receipt
// for a listed transaction); the refusal of an included transaction before
// any fee read or prompt; speed-up keeps the transaction, cancel sends 0 to
// self; the claim-once rule; node refusals translated; spending limits
// count the fee and never the value; the smart-account sentence and status;
// the "Send again" pre-fill.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-pending.mjs

import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import * as pending from '../src/wallet/pending-transactions.ts';
import * as send from '../src/wallet/send.ts';
import {
  NATIVE_TOKEN,
  evaluateBeforeSigning,
  saveSpendingPolicy,
} from '../src/wallet/spending-policy.ts';

const {
  CANCEL_EXPLAINER,
  MAX_PENDING_RECORDS,
  ORIGINAL_MINED_FIRST_SENTENCE,
  PENDING_READ_ONLY_MESSAGE,
  PENDING_TX_KEY,
  REPLACEMENT_FEES_STALE,
  REPLACEMENT_QUOTE_USED,
  REPLACEMENT_UNDERPRICED_SENTENCE,
  RESOLVED_KEEP_MS,
  SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE,
  USEROP_RESEND_OFFER,
  USEROP_UNKNOWN_AFTER_MS,
  alreadyIncludedSentence,
  bumpedMinimum,
  cancelRiskLine,
  checkUserOperation,
  groupStatus,
  loadPendingRegistry,
  meetsReplacementRule,
  nodeReader,
  nonceGroups,
  nonceUsedSentence,
  parseRegistry,
  pooledFees,
  pruneRecords,
  recordPendingTransaction,
  recordPendingUserOperation,
  refreshAccountPending,
  replacementFees,
  replacementPromptTitle,
  replacementRowLine,
  replacementSpendingInput,
  resetPendingRegistry,
  resolvedNotices,
  resolvedRecordFor,
  resolvedSentence,
  txRecordFromQuote,
  userOpResendFor,
  userOpStatusSentence,
  userOpsFor,
} = pending;

const shortHashOf = (h) => pending.shortHash(h);
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

async function rejection(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
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

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(TEST_MNEMONIC);
const signer = evmKeyProvider.deriveAccount(seed, 0, 0);
const other = evmKeyProvider.deriveAccount(seed, 1, 0);
seed.fill(0);
const FROM = signer.address;
const FROM_L = FROM.toLowerCase();
const TO = '0x69F0B8C9b3a0d6B5f5e1fE8a2E5D3b0F2C17E8aA'.toLowerCase();
const CHAIN = 'eip155:11155111';
const URL = 'https://pending-node.example/rpc';
const H = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const T0 = 1_791_700_000_000; // ms

function quoteLike(over = {}) {
  return {
    chainId: 11155111n,
    nonce: 5n,
    to: TO,
    amount: 100_000_000_000_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    gasLimit: 21_000n,
    ...over,
  };
}

// A fake node. `state` decides every answer; `calls` lists the methods asked.
function fakeNode(over = {}) {
  const state = {
    chainId: 11155111n,
    receipts: new Map(),
    txs: new Map(),
    latestNonce: 5n,
    pendingNonce: 6n,
    baseFee: 14n,
    priority: 1_000_004n,
    balance: 10n ** 18n,
    estimate: 12_000n,
    callResult: '0x',
    sendRaw: (raw) => ethers.Transaction.from(raw).hash,
    ...over,
  };
  const calls = [];
  const transport = async (method, params) => {
    calls.push(method);
    switch (method) {
      case 'eth_chainId':
        return '0x' + state.chainId.toString(16);
      case 'eth_getTransactionReceipt': {
        const r = state.receipts.get(params[0]);
        return r ? { blockNumber: '0x' + r.block.toString(16), status: r.status ?? '0x1' } : null;
      }
      case 'eth_getTransactionByHash': {
        if (!state.txs.has(params[0])) return null;
        const b = state.txs.get(params[0]);
        return { hash: params[0], blockNumber: b === null ? null : '0x' + b.toString(16) };
      }
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
        if (state.callResult instanceof Error) throw state.callResult;
        return state.callResult;
      case 'eth_sendRawTransaction':
        state.lastRaw = params[0];
        return state.sendRaw(params[0]);
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { state, calls, transport };
}

// ---------------------------------------------------------------------------
console.log('check-pending: the replacement fee rule (exact bigint)');
// ---------------------------------------------------------------------------
{
  const pinned = [
    [0n, 1n],
    [1n, 2n],
    [7n, 8n],
    [9n, 10n],
    [10n, 11n],
    [11n, 13n],
    [100n, 110n],
    [101n, 112n],
    [1_000_004n, 1_100_005n],
    [10n ** 30n, 11n * 10n ** 29n],
  ];
  for (const [old, want] of pinned) {
    check(`bumpedMinimum(${old}) = ${want}`, bumpedMinimum(old) === want, String(bumpedMinimum(old)));
  }
  // The clients' rules, mirrored from their sources (see the module comment).
  const gethAccepts = (old, next) => next > old && next >= (old * 110n) / 100n;
  const rethAccepts = (old, next) => old === 0n || next >= (old * 110n + 99n) / 100n;
  let ok = true;
  let tight = true;
  let rnd = 0x1234567n;
  for (let i = 0; i < 3000; i++) {
    rnd = (rnd * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    const old = i < 200 ? BigInt(i) : rnd % (i % 2 ? 10n ** 12n : 10n ** 24n);
    const m = bumpedMinimum(old);
    if (!(gethAccepts(old, m) && rethAccepts(old, m))) ok = false;
    if (gethAccepts(old, m - 1n) && rethAccepts(old, m - 1n)) tight = false;
  }
  check('3,000 fees: the minimum satisfies go-ethereum AND reth', ok);
  check('3,000 fees: one wei less fails at least one of them (the minimum is tight)', tight);
  check('a geth-only floor (1,100,004 over 1,000,004) is refused by the rule (reth needs 1,100,005)', !meetsReplacementRule({ maxFeePerGas: 1_000_004n, maxPriorityFeePerGas: 1n }, { maxFeePerGas: 1_100_004n, maxPriorityFeePerGas: 2n }));
  check('both fields must clear the bump (max fee only is refused)', !meetsReplacementRule({ maxFeePerGas: 100n, maxPriorityFeePerGas: 100n }, { maxFeePerGas: 110n, maxPriorityFeePerGas: 109n }));
  check('both fields at the minimum is accepted', meetsReplacementRule({ maxFeePerGas: 100n, maxPriorityFeePerGas: 100n }, { maxFeePerGas: 110n, maxPriorityFeePerGas: 110n }));
  check('a negative fee is refused', (() => { try { bumpedMinimum(-1n); return false; } catch { return true; } })());

  const low = replacementFees({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, { maxFeePerGas: 1_000_034n, maxPriorityFeePerGas: 1_000_004n });
  check('fees: the node suggestion wins when it is higher (the live speed-up figures)', low.maxFeePerGas === 1_000_034n && low.maxPriorityFeePerGas === 1_000_004n && low.minimum.maxFeePerGas === 2n && low.minimum.maxPriorityFeePerGas === 2n);
  const high = replacementFees({ maxFeePerGas: 50n * 10n ** 9n, maxPriorityFeePerGas: 2n * 10n ** 9n }, { maxFeePerGas: 30n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n });
  check('fees: the bumped minimum wins when the suggestion is lower', high.maxFeePerGas === 55n * 10n ** 9n && high.maxPriorityFeePerGas === 2_200_000_000n);
  const tipOver = replacementFees({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }, { maxFeePerGas: 20n, maxPriorityFeePerGas: 50n });
  check('fees: the max fee is raised to the priority fee (EIP-1559 tip ≤ cap)', tipOver.maxFeePerGas === 50n && tipOver.maxPriorityFeePerGas === 50n);
  const group = [
    { maxFeePerGas: '7', maxPriorityFeePerGas: '3' },
    { maxFeePerGas: '20', maxPriorityFeePerGas: '2' },
  ];
  const pf = pooledFees(group);
  check('pooledFees: the highest of each field over every broadcast', pf.maxFeePerGas === 20n && pf.maxPriorityFeePerGas === 3n);
  check('prompt titles name the action', replacementPromptTitle('speed-up') === 'Approve speeding up the transaction' && replacementPromptTitle('cancel') === 'Approve cancelling the transaction');
}

// ---------------------------------------------------------------------------
console.log('check-pending: the registry (strict parse, read-only, cap, queue)');
// ---------------------------------------------------------------------------
const rec = (n, over = {}, replacement = null) =>
  txRecordFromQuote(FROM, quoteLike({ nonce: BigInt(n), ...over }), over.hash ?? H(1000 + n), over.sentAt ?? T0 + n, replacement);
{
  const r = rec(5);
  check('a record is secret-free, lower-case and exact', r.kind === 'tx' && r.from === FROM_L && r.to === TO && r.value === '100000000000000' && r.data === '0x' && r.nonce === '5' && r.chain === CHAIN && r.action === 'send' && r.replaces === null);
  check('the record keeps only the 14 transaction fields', Object.keys(r).length === 14 && !JSON.stringify(r).match(/key|seed|mnemonic|sign/i));
  const withData = rec(6, { data: new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]) });
  check('calldata is stored as lower-case hex', withData.data === '0xa9059cbb');
  const doc = (records) => JSON.stringify({ version: 1, records });
  check('an empty store reads as an empty, writable registry', JSON.stringify(parseRegistry(null)) === JSON.stringify({ records: [], readOnly: false }));
  check('a valid document round-trips', parseRegistry(doc([r])).records.length === 1 && !parseRegistry(doc([r])).readOnly);
  check('unparsable JSON → read-only', parseRegistry('{').readOnly);
  check('an unknown version → read-only', parseRegistry(JSON.stringify({ version: 2, records: [] })).readOnly);
  check('an extra top-level key → read-only', parseRegistry(JSON.stringify({ version: 1, records: [], x: 1 })).readOnly);
  const bad = [
    ['an extra field', { ...r, secret: 'x' }],
    ['a short hash', { ...r, hash: '0x12' }],
    ['an upper-case hash', { ...r, hash: r.hash.toUpperCase().replace('0X', '0x') }],
    ['a fractional fee', { ...r, maxFeePerGas: '1.5' }],
    ['a priority above the max fee', { ...r, maxPriorityFeePerGas: '2', maxFeePerGas: '1' }],
    ['an unknown action', { ...r, action: 'boost' }],
    ['a send that replaces something', { ...r, replaces: H(1) }],
    ['a replacement without its link', { ...r, action: 'speed-up', replaces: null }],
    ['a cancellation with a value', { ...r, action: 'cancel', replaces: H(1), to: FROM_L, value: '1', data: '0x' }],
    ['a cancellation to someone else', { ...r, action: 'cancel', replaces: H(1), value: '0', data: '0x' }],
    ['a mainnet-looking chain id string', { ...r, chain: 'eip155:01' }],
  ];
  for (const [what, record] of bad) {
    const p = parseRegistry(doc([r, record]));
    check(`${what} → read-only, the valid record still shown`, p.readOnly && p.records.length === 1, JSON.stringify(p).slice(0, 120));
  }
  check('a duplicate record → read-only', parseRegistry(doc([r, r])).readOnly);
  const okCancel = { ...r, hash: H(9), action: 'cancel', replaces: r.hash, to: FROM_L, value: '0', data: '0x' };
  check('a well-formed cancellation is accepted', !parseRegistry(doc([r, okCancel])).readOnly);

  // Writes refused on a damaged store; nothing overwritten.
  const damaged = memoryStore({ [PENDING_TX_KEY]: doc([r, { ...r, hash: 'nope' }]) });
  const before = damaged.map.get(PENDING_TX_KEY);
  const wrote = await recordPendingTransaction(rec(7), damaged);
  check('a damaged registry refuses the recorder (false) and keeps the stored text', wrote === false && damaged.map.get(PENDING_TX_KEY) === before);
  check('the read-only sentence names the reset', PENDING_READ_ONLY_MESSAGE.includes('Reset the pending list'));
  await resetPendingRegistry(damaged);
  check('reset clears it', (await loadPendingRegistry(damaged)).records.length === 0 && !(await loadPendingRegistry(damaged)).readOnly);

  // Queue: a read right after a fire-and-forget write sees it, and a write
  // never waits for itself (the 2026-10-11 live run deadlocked on that).
  const store = memoryStore();
  void recordPendingTransaction(rec(8), store);
  const raced = await Promise.race([loadPendingRegistry(store), new Promise((res) => setTimeout(() => res('timeout'), 1000))]);
  check('a read queued behind a write sees the record (no deadlock)', raced !== 'timeout' && raced.records.length === 1, String(raced));
  const twice = await Promise.race([
    (async () => {
      await recordPendingTransaction(rec(9), store);
      await recordPendingTransaction(rec(10), store);
      return loadPendingRegistry(store);
    })(),
    new Promise((res) => setTimeout(() => res('timeout'), 1000)),
  ]);
  check('consecutive writes complete', twice !== 'timeout' && twice.records.length === 3);

  // The cap: expired notices go, then resolved notices, then the oldest pending.
  const resolved = (i, at) => ({ kind: 'resolved', chain: CHAIN, from: FROM_L, nonce: String(500 + i), outcome: 'replaced', minedHash: H(2), block: '9', success: true, original: H(1), hashes: [H(1), H(2)], resolvedAt: at });
  const now = T0 + 10 * RESOLVED_KEEP_MS;
  const aged = pruneRecords([resolved(1, now - RESOLVED_KEEP_MS - 1), resolved(2, now - 5)], now);
  check(
    'a notice older than a day stops showing but leaves its marker (pass p21e A1)',
    aged.length === 2 &&
      aged.filter((x) => x.kind === 'resolved').length === 1 &&
      aged.some((x) => x.kind === 'marker' && x.nonce === '501' && x.minedHash === H(2) && x.original === H(1) && x.markedAt === now),
  );
  const many = [];
  for (let i = 0; i < MAX_PENDING_RECORDS; i++) many.push(rec(i, { hash: H(5000 + i), sentAt: now - 1000 + i }));
  const withNotice = pruneRecords([resolved(3, now - 10), ...many], now);
  check(`over the cap (${MAX_PENDING_RECORDS}) the resolved notice goes first`, withNotice.length === MAX_PENDING_RECORDS && withNotice.every((x) => x.kind === 'tx'));
  const marker = { kind: 'marker', chain: CHAIN, from: FROM_L, nonce: '600', outcome: 'replaced', minedHash: H(2), original: H(1), markedAt: now - 10 };
  const withMarker = pruneRecords([marker, ...many], now);
  check('… and so does a replacement marker (eviction drops the row line)', withMarker.length === MAX_PENDING_RECORDS && withMarker.every((x) => x.kind === 'tx') && replacementRowLine(withMarker, CHAIN, H(2)) === null);
  check('a marker is never aged out by itself', pruneRecords([{ ...marker, markedAt: now - 100 * RESOLVED_KEEP_MS }], now).length === 1);
  check('the strict parse accepts a marker and refuses one with an extra or a missing key',
    parseRegistry(JSON.stringify({ version: 1, records: [marker] })).records.length === 1 &&
    parseRegistry(JSON.stringify({ version: 1, records: [{ ...marker, block: '9' }] })).readOnly &&
    parseRegistry(JSON.stringify({ version: 1, records: [{ ...marker, original: undefined }] })).readOnly);
  const overflow = pruneRecords([...many, rec(999, { hash: H(9999), sentAt: now })], now);
  check('then the oldest pending record', overflow.length === MAX_PENDING_RECORDS && !overflow.some((x) => x.hash === H(5000)) && overflow.some((x) => x.hash === H(9999)));
}

// ---------------------------------------------------------------------------
console.log('check-pending: where a nonce stands');
// ---------------------------------------------------------------------------
{
  const orig = rec(5, { hash: H(1) });
  const speed = rec(5, { hash: H(2), sentAt: T0 + 100, maxFeePerGas: 1_000_034n, maxPriorityFeePerGas: 1_000_004n }, { action: 'speed-up', replaces: H(1) });
  const cancel = txRecordFromQuote(FROM, quoteLike({ to: FROM, amount: 0n, maxFeePerGas: 9n, maxPriorityFeePerGas: 9n, gasLimit: 12_000n }), H(3), T0 + 200, { action: 'cancel', replaces: H(2) });
  const records = [orig, speed, cancel];
  const [group] = nonceGroups(records, CHAIN, FROM);
  check('one group per nonce, oldest first, the original found', group.txs.length === 3 && group.original.hash === H(1) && group.latest.hash === H(3));
  check('other accounts and chains are not grouped in', nonceGroups(records, CHAIN, other.address).length === 0 && nonceGroups(records, 'eip155:1', FROM).length === 0);

  const node = fakeNode({ latestNonce: 5n, pendingNonce: 6n });
  node.state.txs.set(H(2), null);
  let st = await groupStatus(nodeReader(node.transport), group);
  check('pending: no receipt, latest nonce not past it; the pool lists the speed-up', st.state === 'pending' && st.inPool.length === 1 && st.inPool[0] === H(2) && st.latestNonce === 5n && st.pendingNonce === 6n);

  node.state.receipts.set(H(2), { block: 77n });
  st = await groupStatus(nodeReader(node.transport), group);
  check('the speed-up included → outcome "replaced"', st.state === 'mined' && st.outcome === 'replaced' && st.block === 77n && st.hash === H(2));
  node.state.receipts.clear();
  node.state.receipts.set(H(3), { block: 78n, status: '0x1' });
  st = await groupStatus(nodeReader(node.transport), group);
  check('the cancellation included → outcome "cancelled"', st.state === 'mined' && st.outcome === 'cancelled');
  node.state.receipts.clear();
  node.state.receipts.set(H(1), { block: 79n, status: '0x0' });
  st = await groupStatus(nodeReader(node.transport), group);
  check('the original included first → outcome "original-first" (reverted reported)', st.state === 'mined' && st.outcome === 'original-first' && st.success === false);
  const n = resolvedRecordFor(group, st, T0 + 999);
  check('… whose notice says the replacement will be rejected, exactly', resolvedSentence(n).startsWith(ORIGINAL_MINED_FIRST_SENTENCE) && ORIGINAL_MINED_FIRST_SENTENCE === 'The original transaction was included before the replacement; the replacement will be rejected by the network.');
  check('… and that it reverted', resolvedSentence(n).endsWith('It reverted, so it changed nothing except the fee it paid.'));

  const single = nonceGroups([orig], CHAIN, FROM)[0];
  st = await groupStatus(nodeReader(node.transport), single);
  check('a lone transaction included → plain "mined", no notice kept', st.state === 'mined' && st.outcome === 'mined' && resolvedRecordFor(single, st, T0) === null);

  // Pass p22b: a FRESH ordinary send that reused a stuck nonce. Live facts:
  // the watched address's cold-signed 1-wei rehearsal at nonce 6
  // (0x23bf…3686) was never included; a second cold-signed send of 0.0001
  // test ETH at nonce 6 (0x9d6f9dc0…) was included in block 11952645. The
  // notice named the stuck one as "the original … included before the
  // replacement" — the reverse of the chain. Rebuilt with full hashes that
  // carry the reported prefixes and suffixes.
  {
    const WATCHED = '0x8E1dEaF5d88e60DBdabcC79d8EFA570f40fb0cDF';
    const STUCK = `0x23bf${'1'.repeat(56)}3686`;
    const FRESH = `0x9d6f9dc0${'2'.repeat(52)}abcd`;
    const stuck = txRecordFromQuote(WATCHED, quoteLike({ nonce: 6n, amount: 10n ** 13n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 21_000n }), STUCK, T0);
    const fresh = txRecordFromQuote(WATCHED, quoteLike({ nonce: 6n, amount: 10n ** 14n, maxFeePerGas: 33n, maxPriorityFeePerGas: 2n, gasLimit: 21_000n }), FRESH, T0 + 60_000);
    const [g6] = nonceGroups([stuck, fresh], CHAIN, WATCHED);
    const live = fakeNode();
    live.state.receipts.set(FRESH, { block: 11952645n });
    const st6 = await groupStatus(nodeReader(live.transport), g6);
    check('p22b: a fresh ordinary send included at a stuck nonce → outcome "superseded" (not "original-first")',
      g6.original.hash === STUCK && st6.state === 'mined' && st6.hash === FRESH && st6.outcome === 'superseded', JSON.stringify(st6, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const n6 = resolvedRecordFor(g6, st6, T0 + 120_000);
    check('…its notice names the included hash as the one that superseded the stuck one (exact)',
      n6.original === STUCK && n6.minedHash === FRESH &&
        resolvedSentence(n6) === 'Transaction 0x23bf…3686 (nonce 6) was superseded by 0x9d6f…abcd, included in block 11952645; 0x23bf…3686 will never be included.' &&
        !resolvedSentence(n6).includes(ORIGINAL_MINED_FIRST_SENTENCE), resolvedSentence(n6));
    check('…and the included row\'s Activity line says it was sent in place of the stuck one',
      replacementRowLine([n6], CHAIN, FRESH) === 'Sent in place of transaction 0x23bf…3686 (nonce 6), which will never be included.' && replacementRowLine([n6], CHAIN, STUCK) === null);
    const stored6 = memoryStore();
    for (const r of [stuck, fresh]) await recordPendingTransaction(r, stored6);
    await refreshAccountPending({ reader: nodeReader(live.transport), chain: CHAIN, from: WATCHED, store: stored6, nowMs: T0 + 120_000 });
    const reg6 = await loadPendingRegistry(stored6);
    check('…refresh stores it (the strict parse accepts "superseded"); Dismiss keeps a marker and the row line',
      !reg6.readOnly && resolvedNotices(reg6.records, CHAIN, WATCHED)[0]?.outcome === 'superseded');
    await pending.dismissResolvedNotice(resolvedNotices(reg6.records, CHAIN, WATCHED)[0], stored6, T0 + 130_000);
    const after6 = await loadPendingRegistry(stored6);
    check('…after Dismiss: no notice, the marker with outcome "superseded", the row line unchanged',
      resolvedNotices(after6.records, CHAIN, WATCHED).length === 0 && after6.records.length === 1 && after6.records[0].kind === 'marker' &&
        after6.records[0].outcome === 'superseded' && replacementRowLine(after6.records, CHAIN, FRESH) === 'Sent in place of transaction 0x23bf…3686 (nonce 6), which will never be included.');
    const inbox6 = await import('../src/wallet/inbox.ts');
    check('…the inbox lists it as "Transaction superseded"',
      inbox6.replacementNoticeInboxEvent({ chain: CHAIN, from: WATCHED, nonce: '6', minedHash: FRESH, outcome: 'superseded', resolvedAt: T0, text: resolvedSentence(n6) }).title === 'Transaction superseded');
    // The other way round: the stuck one (the original) included after all,
    // beside only another ordinary send → the other is superseded.
    const back = fakeNode();
    back.state.receipts.set(STUCK, { block: 11952646n });
    const stBack = await groupStatus(nodeReader(back.transport), g6);
    const nBack = resolvedRecordFor(g6, stBack, T0);
    check('…the original included beside only another ordinary send → "superseded", naming the other send',
      stBack.outcome === 'superseded' && nBack.minedHash === STUCK && nBack.original === FRESH);
    // A speed-up of the SECOND send names the second send, not the first.
    const sp = txRecordFromQuote(WATCHED, quoteLike({ nonce: 6n, amount: 10n ** 14n, maxFeePerGas: 40n, maxPriorityFeePerGas: 3n, gasLimit: 21_000n }), H(0x6006), T0 + 90_000, { action: 'speed-up', replaces: FRESH });
    const [g6b] = nonceGroups([stuck, fresh, sp], CHAIN, WATCHED);
    const spNode = fakeNode();
    spNode.state.receipts.set(H(0x6006), { block: 11952647n });
    const stSp = await groupStatus(nodeReader(spNode.transport), g6b);
    const nSp = resolvedRecordFor(g6b, stSp, T0);
    check('…a speed-up of the second send included → "replaced", naming the send it replaced (its replaces chain), not the stuck one',
      stSp.outcome === 'replaced' && nSp.original === FRESH && resolvedSentence(nSp).startsWith('Sped up: transaction 0x9d6f…abcd (nonce 6) was replaced by'));
    check('…and the original with a real replacement beside it is still "original-first" (unchanged)', pending.minedOutcome(g6b, stuck) === 'original-first');
  }

  // Pass p22b: a pending token send read "calls 0x1c7d…7238" (the token
  // contract). Both paths record a token send the same way — the Send
  // screen's sendErc20 and the cold-signing screen's coldSignBroadcastQuote
  // both hand sendEvm / sendEvmWithSignature a quote whose `to` is the
  // contract, value 0 and data the transfer call — so the line decodes the
  // transfer from the record, for both.
  {
    const erc20Src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/wallet/send-erc20.ts'), 'utf8');
    const coldSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/wallet/cold-signing.ts'), 'utf8');
    const mapping = /to: quote\.contract,\s*amount: 0n,[\s\S]{0,400}?data: quote\.data,/;
    check('p22b: the hot token send (sendErc20) and the cold one (coldSignBroadcastQuote) record the same shape: to = contract, value 0, data = transfer',
      mapping.test(erc20Src) && mapping.test(coldSrc));
    const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
    const RECIP = '0xb6990A39A8B4cD6Fc6a0dC1d2E5dCE4dF27681fE';
    const amountWord = (500_000n).toString(16).padStart(64, '0');
    const data = `0xa9059cbb${'0'.repeat(24)}${RECIP.slice(2).toLowerCase()}${amountWord}`;
    const tokenTx = txRecordFromQuote(FROM, quoteLike({ nonce: 5n, to: USDC, amount: 0n, data: Uint8Array.from(Buffer.from(data.slice(2), 'hex')) }), `0x71bf${'3'.repeat(56)}16d9`, T0);
    const [tg] = nonceGroups([tokenTx], CHAIN, FROM);
    const line = pending.pendingGroupSentence(tg, { nativeSymbol: 'test ETH', nowMs: T0, tokens: [{ contract: USDC, symbol: 'USDC', decimals: 6 }] });
    check('…a pending USDC send reads as its transfer: amount, symbol, recipient, then the contract (exact)',
      line === `Waiting to be included: transaction 0x71bf…16d9 (nonce 5) sends 0.5 USDC to ${RECIP.toLowerCase()} (token contract ${USDC.toLowerCase()}), sent less than a minute ago.`, line);
    const unknown = pending.pendingGroupSentence(tg, { nativeSymbol: 'test ETH', nowMs: T0 });
    check('…a token the network does not track: the amount in base units and the contract, never a guessed symbol',
      unknown === `Waiting to be included: transaction 0x71bf…16d9 (nonce 5) sends 500000 base units of the token at ${USDC.toLowerCase()} to ${RECIP.toLowerCase()}, sent less than a minute ago.`, unknown);
    check('…anything that is not exactly transfer(address,uint256) still reads as a call',
      pending.decodeTokenTransferData(`${data}00`) === null && pending.decodeTokenTransferData(data.replace('a9059cbb', '095ea7b3')) === null &&
        pending.decodeTokenTransferData(`0xa9059cbb${'f'.repeat(24)}${RECIP.slice(2)}${amountWord}`) === null);
    const pcs22 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/components/PendingTransactions.tsx'), 'utf8');
    check('…the card passes the network\'s tracked tokens (listTokens) to the line, on screen and in the spoken label',
      (pcs22.match(/pendingGroupSentence\(group, \{ nativeSymbol: symbol, nowMs, tokens: lineTokens \}\)/g) ?? []).length === 2 && pcs22.includes('listTokens(chain).then('));
  }

  const nullReceipt = fakeNode();
  nullReceipt.state.txs.set(H(1), 80n);
  st = await groupStatus(nodeReader(nullReceipt.transport), single);
  check('a null receipt for a transaction listed in a block still counts as included (success unknown)', st.state === 'mined' && st.block === 80n && st.success === null);

  const used = fakeNode({ latestNonce: 6n });
  st = await groupStatus(nodeReader(used.transport), group);
  check('no receipt but the latest nonce is past it → "nonce-used"', st.state === 'nonce-used' && st.latestNonce === 6n);

  // refreshAccountPending settles and keeps the notice.
  const store = memoryStore();
  for (const r of records) await recordPendingTransaction(r, store);
  const decided = fakeNode();
  decided.state.receipts.set(H(3), { block: 81n });
  const out = await refreshAccountPending({ reader: nodeReader(decided.transport), chain: CHAIN, from: FROM, store, nowMs: T0 + 5000 });
  const after = await loadPendingRegistry(store);
  check('refresh: the decided nonce is settled (its records removed)', out[0].status.state === 'mined' && after.records.every((x) => x.kind !== 'tx'));
  const notices = resolvedNotices(after.records, CHAIN, FROM);
  check('refresh: a "cancelled" notice is kept with every hash', notices.length === 1 && notices[0].outcome === 'cancelled' && notices[0].hashes.join() === [H(1), H(2), H(3)].join());
  check('cancelled sentence', resolvedSentence(notices[0]) === `Cancelled: the cancellation 0x0000…0003 was included in block 81, so transaction 0x0000…0001 (nonce 5) will never be included.`, resolvedSentence(notices[0]));
  check('the included cancellation\'s Activity row says what it was', replacementRowLine(after.records, CHAIN, H(3)) === 'Cancellation of transaction 0x0000…0001 (nonce 5).');
  check('other rows get no line', replacementRowLine(after.records, CHAIN, H(1)) === null && replacementRowLine(after.records, 'eip155:1', H(3)) === null);

  // Pass p21e finding A1: Dismiss hides the notice only; the included
  // transaction's Activity row keeps its line after Activity is reopened.
  await pending.dismissResolvedNotice(notices[0], store, T0 + 6000);
  const dismissed = await loadPendingRegistry(store);
  check('after Dismiss the notice is gone', resolvedNotices(dismissed.records, CHAIN, FROM).length === 0 && !dismissed.readOnly);
  check('after Dismiss the row line is still produced for the cancellation hash', replacementRowLine(dismissed.records, CHAIN, H(3)) === 'Cancellation of transaction 0x0000…0001 (nonce 5).');
  check('the marker is compact: replacement hash, original hash, nonce, kind',
    dismissed.records.length === 1 &&
    JSON.stringify(dismissed.records[0]) === JSON.stringify({ kind: 'marker', chain: CHAIN, from: FROM_L, nonce: '5', outcome: 'cancelled', minedHash: H(3), original: H(1), markedAt: T0 + 6000 }));
  const sped = { ...notices[0], outcome: 'replaced', minedHash: H(2) };
  check('a dismissed speed-up keeps "Speed-up of …"', replacementRowLine([pending.markerFor(sped, T0)], CHAIN, H(2)) === 'Speed-up of transaction 0x0000…0001 (nonce 5).');
  const pcs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/components/PendingTransactions.tsx'), 'utf8');
  check('the notice\'s Dismiss button keeps the marker (dismissResolvedNotice, not settleNonce)',
    pcs.includes('onPress={() => void dismissResolvedNotice(n).then(refresh, refresh)}') && !pcs.includes('settleNonce(n, null)'));
  await resetPendingRegistry(store);
  check('reset drops the marker and its line', replacementRowLine((await loadPendingRegistry(store)).records, CHAIN, H(3)) === null);
}

// ---------------------------------------------------------------------------
console.log('check-pending: pricing a replacement (send.ts prepareEvmReplacement)');
// ---------------------------------------------------------------------------
const orig = rec(5, { hash: H(1), data: new Uint8Array([0xde, 0xad]), gasLimit: 45_000n, amount: 7n });
const group1 = nonceGroups([orig], CHAIN, FROM)[0];
{
  const mined = fakeNode();
  mined.state.receipts.set(H(1), { block: 123n });
  const e = await rejection(() => send.prepareEvmReplacement(URL, group1, 'speed-up', CHAIN, { transport: mined.transport }));
  check('an included transaction is refused with the exact sentence', e?.message === 'This transaction is already included in block 123.' && e.message === alreadyIncludedSentence(123n), String(e?.message));
  check('… before any fee read, estimate, balance or signing', !mined.calls.some((m) => ['eth_maxPriorityFeePerGas', 'eth_getBlockByNumber', 'eth_estimateGas', 'eth_getBalance', 'eth_sendRawTransaction'].includes(m)), mined.calls.join());

  const used = fakeNode({ latestNonce: 6n });
  const u = await rejection(() => send.prepareEvmReplacement(URL, group1, 'cancel', CHAIN, { transport: used.transport }));
  check('a nonce already used is refused as no longer pending', u?.message === nonceUsedSentence(5n) && u.message.startsWith('This transaction is no longer pending:'), String(u?.message));

  const wrong = fakeNode({ chainId: 1n });
  const w = await rejection(() => send.prepareEvmReplacement(URL, group1, 'speed-up', CHAIN, { transport: wrong.transport }));
  check('an endpoint on another chain is refused', w?.name === 'ReplacementRefusedError' && /chain id 1\b/.test(w.message));

  const node = fakeNode();
  const q = await send.prepareEvmReplacement(URL, group1, 'speed-up', CHAIN, { transport: node.transport });
  check('speed-up keeps nonce, recipient, value, calldata and gas limit', q.nonce === 5n && q.to === TO && q.amount === 7n && ethers.hexlify(q.data) === '0xdead' && q.gasLimit === 45_000n);
  check('speed-up fees = max(bumped minimum, node suggestion)', q.maxFeePerGas === 14n * 2n + 1_000_004n && q.maxPriorityFeePerGas === 1_000_004n && q.replacement.fees.minimum.maxFeePerGas === 2n);
  check('worst case = gas limit × max fee; total adds the value', q.fee === 45_000n * q.maxFeePerGas && q.total === q.fee + 7n);
  check('the eth_call pre-flight ran on the replacement', node.calls.includes('eth_call') && q.simulation.ok === true);
  check('the quote names what it replaces', q.replacement.replaces === H(1) && q.replacement.original === H(1) && q.replacement.recordedAction === 'speed-up' && q.replacement.from === FROM_L);

  const c = fakeNode({ estimate: 12_000n });
  const cq = await send.prepareEvmReplacement(URL, group1, 'cancel', CHAIN, { transport: c.transport });
  check('cancel: 0 to the sender itself, no calldata, the estimated gas', cq.to === FROM_L && cq.amount === 0n && cq.data === undefined && cq.gasLimit === 12_000n && cq.replacement.recordedAction === 'cancel');

  const reverting = fakeNode();
  reverting.state.callResult = new Error('execution reverted: nope');
  const rq = await send.prepareEvmReplacement(URL, group1, 'speed-up', CHAIN, { transport: reverting.transport });
  check('a reverting speed-up is priced with the failed pre-flight (the screen blocks Approve)', rq.simulation.ok === false);

  const poor = fakeNode({ balance: 7n + 45_000n * (14n * 2n + 1_000_004n) - 1n });
  const p = await rejection(() => send.prepareEvmReplacement(URL, group1, 'speed-up', CHAIN, { transport: poor.transport }));
  check('a balance one wei short of value + worst case is refused as insufficient funds', /^Insufficient funds/.test(p?.message ?? ''), String(p?.message));
  check('… worded "Not enough … plus the network fee" by describeSendError', send.describeSendError(p, 'test ETH').title === 'Not enough test ETH to cover this amount plus the network fee.');

  // A speed-up of a cancellation stays a cancellation.
  const cancelRec = txRecordFromQuote(FROM, quoteLike({ to: FROM, amount: 0n, maxFeePerGas: 9n, maxPriorityFeePerGas: 9n, gasLimit: 12_000n }), H(4), T0 + 50, { action: 'cancel', replaces: H(1) });
  const g2 = nonceGroups([orig, cancelRec], CHAIN, FROM)[0];
  const sc = await send.prepareEvmReplacement(URL, g2, 'speed-up', CHAIN, { transport: fakeNode({ priority: 1n, baseFee: 1n }).transport });
  check('speed-up of a cancellation: still 0 to self, recorded as a cancellation, bumped over the cancellation', sc.to === FROM_L && sc.amount === 0n && sc.replacement.recordedAction === 'cancel' && sc.maxFeePerGas === 10n && sc.maxPriorityFeePerGas === 10n && sc.replacement.replaces === H(4));
}

// ---------------------------------------------------------------------------
console.log('check-pending: before approval, and the broadcast (sendEvmReplacement)');
// ---------------------------------------------------------------------------
{
  const node = fakeNode();
  const quote = await send.prepareEvmReplacement(URL, group1, 'speed-up', CHAIN, { transport: node.transport });
  await send.checkReplacementBeforeApproval(URL, quote, group1, { transport: node.transport });
  check('the check before approval passes for a fresh quote', true);
  const newer = rec(5, { hash: H(6), sentAt: T0 + 300, maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas }, { action: 'speed-up', replaces: H(1) });
  const grown = nonceGroups([orig, newer], CHAIN, FROM)[0];
  const stale = await rejection(() => send.checkReplacementBeforeApproval(URL, quote, grown, { transport: node.transport }));
  check('a replacement sent meanwhile (same fees) makes the quote stale before the prompt', stale?.message === REPLACEMENT_FEES_STALE);
  const minedNow = fakeNode();
  minedNow.state.receipts.set(H(1), { block: 200n });
  const m = await rejection(() => send.checkReplacementBeforeApproval(URL, quote, group1, { transport: minedNow.transport }));
  check('included in the meantime → refused before the prompt with the block', m?.message === 'This transaction is already included in block 200.');

  // Broadcast: nothing reaches the spending recorder (sent listeners).
  let listenerCalls = 0;
  const off = send.addEvmSentListener(() => {
    listenerCalls += 1;
  });
  const store = memoryStore();
  await recordPendingTransaction(orig, store);
  const sent = await send.sendEvmReplacement(URL, signer, quote, 'https://sepolia.etherscan.io/tx/', { transport: node.transport, store, now: () => T0 + 400 });
  const decoded = ethers.Transaction.from(node.state.lastRaw);
  check('the signed replacement: same nonce, recipient, value, data, gas limit; the quoted fees; type 2', decoded.nonce === 5 && decoded.to.toLowerCase() === TO && decoded.value === 7n && decoded.data === '0xdead' && decoded.gasLimit === 45_000n && decoded.maxFeePerGas === quote.maxFeePerGas && decoded.maxPriorityFeePerGas === quote.maxPriorityFeePerGas && decoded.type === 2 && decoded.chainId === 11155111n);
  check('signed by the original sender', decoded.from.toLowerCase() === FROM_L);
  check('the result carries the hash and the explorer link', sent.txid === decoded.hash && sent.explorerUrl === `https://sepolia.etherscan.io/tx/${decoded.hash}`);
  check('the replacement does NOT fan out to the sent listeners (its value is never counted again)', listenerCalls === 0);
  const reg = await loadPendingRegistry(store);
  const linked = reg.records.find((x) => x.kind === 'tx' && x.hash === decoded.hash.toLowerCase());
  check('the registry links new → old', linked?.action === 'speed-up' && linked.replaces === H(1) && linked.nonce === '5');
  const again = await rejection(() => send.sendEvmReplacement(URL, signer, quote, null, { transport: node.transport, store }));
  check('a quote goes out at most once', again?.message === REPLACEMENT_QUOTE_USED && send.replacementQuoteUsed(quote));
  const usedCheck = await rejection(() => send.checkReplacementBeforeApproval(URL, quote, group1, { transport: node.transport }));
  check('… and the check before approval refuses a used quote', usedCheck?.message === REPLACEMENT_QUOTE_USED);

  const q2 = await send.prepareEvmReplacement(URL, group1, 'cancel', CHAIN, { transport: node.transport });
  const wrongSigner = await rejection(() => send.sendEvmReplacement(URL, other, q2, null, { transport: node.transport, store }));
  check('another account cannot sign it', /not the one that sent this transaction/.test(wrongSigner?.message ?? ''));

  const underpriced = fakeNode({ sendRaw: () => { throw new Error('RPC error -32000: replacement transaction underpriced (eth_sendRawTransaction)'); } });
  const q3 = await send.prepareEvmReplacement(URL, group1, 'speed-up', CHAIN, { transport: underpriced.transport });
  const up = await rejection(() => send.sendEvmReplacement(URL, signer, q3, null, { transport: underpriced.transport, store }));
  check('node "replacement transaction underpriced" → the plain sentence, node text kept', up?.message === REPLACEMENT_UNDERPRICED_SENTENCE && /underpriced/.test(up.technical));
  const tooLow = fakeNode({ sendRaw: () => { throw new Error('RPC error -32000: nonce too low: next nonce 6, tx nonce 5 (eth_sendRawTransaction)'); } });
  const q4 = await send.prepareEvmReplacement(URL, group1, 'cancel', CHAIN, { transport: tooLow.transport });
  const tl = await rejection(() => send.sendEvmReplacement(URL, signer, q4, null, { transport: tooLow.transport, store }));
  check('node "nonce too low" → nonce already used, nothing more sent', /nonce 5 was already used/.test(tl?.message ?? ''));
  off();
}

// ---------------------------------------------------------------------------
console.log('check-pending: every sendEvm broadcast is recorded');
// ---------------------------------------------------------------------------
{
  const node = fakeNode();
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
  const store = memoryStore();
  send.setPendingRecordStore(store);
  const quote = { kind: 'evm', ...quoteLike({ nonce: 9n }), balance: 10n ** 18n, fee: 21_000n, total: 0n, simulation: { ok: true, returnData: '0x' } };
  const res = await send.sendEvm(URL, signer, quote, null);
  const reg = await loadPendingRegistry(store);
  const r = reg.records[0];
  check('sendEvm records the broadcast (hash, nonce, fees, gas, sender)', reg.records.length === 1 && r.hash === res.txid.toLowerCase() && r.nonce === '9' && r.maxFeePerGas === '1' && r.gasLimit === '21000' && r.from === FROM_L && r.action === 'send');
  send.setPendingRecordStore(null);
}

// ---------------------------------------------------------------------------
console.log('check-pending: the bounded broadcast (phase 23 item 8)');
// ---------------------------------------------------------------------------
// eth_sendRawTransaction gets at most BROADCAST_TIMEOUT_MS (engine
// httpTransport); the transaction is recorded BEFORE the request leaves the
// device; no answer = an unknown outcome (never "not sent"), the record
// stays and the quote is never broadcast again; a node refusal removes the
// record this attempt created. Fake timers (node:test mock.timers) and a
// fake fetch that never answers the broadcast.
{
  const { mock } = await import('node:test');
  const { httpTransport, BROADCAST_TIMEOUT_MS } = await import('@shiba-wallet/chains-evm');
  const outcome = await import('../src/wallet/broadcast-outcome.ts');
  const { isEndpointFailure } = await import('../src/config/endpoint-probe.ts');
  const realSetTimeout = globalThis.setTimeout;
  const realDelay = (ms) => new Promise((r) => realSetTimeout(r, ms));
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const NOT_SENT = /not sent|nothing was sent|could not be sent|was not sent/i;

  // A fetch over a fake node: `broadcast` decides eth_sendRawTransaction
  // ('silent' never answers; else a function returning a result or throwing a
  // JSON-RPC error); every request's method and signal are recorded.
  function fetchOver(node, broadcast, store) {
    const seen = [];
    let reachedResolve;
    const reached = new Promise((r) => (reachedResolve = r));
    const fetchFn = async (_url, init) => {
      const { method, params, id } = JSON.parse(init.body);
      const entry = { method, hasSignal: init.signal !== undefined, signal: init.signal, registryAtSend: null, raw: null };
      seen.push(entry);
      if (method === 'eth_sendRawTransaction') {
        entry.registryAtSend = store ? store.map.get(PENDING_TX_KEY) ?? null : null;
        entry.raw = params[0];
        reachedResolve(entry);
        if (broadcast === 'silent') return new Promise(() => undefined);
        let body;
        try {
          body = { jsonrpc: '2.0', id, result: broadcast(params[0]) };
        } catch (e) {
          body = { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } };
        }
        return { ok: true, status: 200, json: async () => body };
      }
      let body;
      try {
        body = { jsonrpc: '2.0', id, result: await node.transport(method, params) };
      } catch (e) {
        body = { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } };
      }
      return { ok: true, status: 200, json: async () => body };
    };
    return { fetchFn, seen, reached };
  }
  const recordsOf = (store) => parseRegistry(store.map.get(PENDING_TX_KEY) ?? null).records;
  const evmQuote = (nonce) => ({ kind: 'evm', ...quoteLike({ nonce }), balance: 10n ** 18n, fee: 21_000n, total: 0n, simulation: { ok: true, returnData: '0x' } });

  check('BROADCAST_TIMEOUT_MS is 60 seconds and every sentence names it',
    BROADCAST_TIMEOUT_MS === 60_000 &&
      [outcome.BROADCAST_TX_UNKNOWN_SENTENCE, outcome.BROADCAST_TX_UNKNOWN_UNLISTED_SENTENCE, outcome.BROADCAST_USEROP_UNKNOWN_SENTENCE, outcome.BROADCAST_USEROP_UNKNOWN_UNLISTED_SENTENCE, outcome.BROADCAST_UNKNOWN_SENTENCE].every((x) => x.includes('within 60 seconds')));
  check('no outcome-unknown sentence says "not sent" or "nothing was sent"',
    [outcome.BROADCAST_OUTCOME_UNKNOWN_TITLE, outcome.BROADCAST_TX_UNKNOWN_SENTENCE, outcome.BROADCAST_TX_UNKNOWN_UNLISTED_SENTENCE, outcome.BROADCAST_USEROP_UNKNOWN_SENTENCE, outcome.BROADCAST_USEROP_UNKNOWN_UNLISTED_SENTENCE, outcome.BROADCAST_UNKNOWN_SENTENCE, outcome.BROADCAST_ALREADY_HANDED_OVER_SENTENCE].every((x) => !NOT_SENT.test(x)));
  check('the listed sentence points at Pending on this phone and its 15-second check',
    outcome.BROADCAST_TX_UNKNOWN_SENTENCE.includes('Pending on this phone') && outcome.BROADCAST_TX_UNKNOWN_SENTENCE.includes('every 15 seconds') && /do not send it again/.test(outcome.BROADCAST_TX_UNKNOWN_SENTENCE));

  // 1. sendEvm, a node that never answers the broadcast.
  const node = fakeNode();
  const store = memoryStore();
  send.setPendingRecordStore(store);
  const events = [];
  const offSent = send.addEvmSentListener((e) => void events.push(e));
  const silent = fetchOver(node, 'silent', store);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = silent.fetchFn;
  const quote = evmQuote(11n);
  mock.timers.enable({ apis: ['setTimeout'] });
  let err;
  let entry;
  try {
    const p = send.sendEvm(URL, signer, quote, null).then(() => null, (e) => e);
    entry = await Promise.race([silent.reached, realDelay(5_000).then(() => null)]);
    const hash = entry ? ethers.Transaction.from(entry.raw).hash.toLowerCase() : null;
    const atSend = entry?.registryAtSend ? parseRegistry(entry.registryAtSend).records : [];
    check('the transaction is recorded BEFORE the broadcast request is sent (the registry at the moment of the fetch)',
      atSend.length === 1 && atSend[0].hash === hash && atSend[0].nonce === '11' && atSend[0].action === 'send');
    check('the broadcast request carries an abort signal; nothing aborted yet', entry?.hasSignal === true && entry.signal.aborted === false);
    mock.timers.tick(BROADCAST_TIMEOUT_MS - 1);
    await flush();
    let settled = false;
    p.then(() => (settled = true));
    await flush();
    check('…still waiting one millisecond before the limit', settled === false);
    mock.timers.tick(1);
    err = await p;
    check('at 60 s: BroadcastOutcomeUnknownError for the transaction, listed', err?.name === 'BroadcastOutcomeUnknownError' && err.kind === 'tx' && err.hash === hash && err.recorded === true && err.chain === CHAIN);
    check('…its message is the outcome-unknown sentence', err?.message === outcome.BROADCAST_TX_UNKNOWN_SENTENCE);
    check('…the request was aborted', entry?.signal.aborted === true);
  } finally {
    mock.timers.reset();
  }
  check('the record stays (the card lists it)', recordsOf(store).length === 1 && recordsOf(store)[0].hash === err?.hash);
  const groups = nonceGroups(recordsOf(store), CHAIN, FROM);
  const shown = pending.pendingSectionView(parseRegistry(store.map.get(PENDING_TX_KEY)), CHAIN, FROM, []);
  check('…Pending on this phone shows its nonce group (Speed up / Cancel offered there)', groups.length === 1 && groups[0].nonce === '11' && shown.groups.length === 1 && shown.groups[0].group.latest.hash === err?.hash);
  const poolNode = fakeNode({ latestNonce: 11n, pendingNonce: 12n });
  poolNode.state.txs.set(err?.hash, null);
  const st = await groupStatus(nodeReader(poolNode.transport), groups[0]);
  check('…and the card\'s poll settles it as usual (here: waiting in the pool)', st.state === 'pending');
  const minedNode = fakeNode({ latestNonce: 12n, pendingNonce: 12n });
  minedNode.state.receipts.set(err?.hash, { block: 77n });
  const st2 = await groupStatus(nodeReader(minedNode.transport), groups[0]);
  check('…(or: included in block 77)', st2.state === 'mined' && st2.block === 77n);
  check('no sent listener fired (the spending recorder counts accepted sends only)', events.length === 0);
  const described = send.describeSendError(err, 'test ETH', 'test ETH');
  check('describeSendError: the outcome-unknown title and sentence, the hash in the technical line',
    described.title === outcome.BROADCAST_OUTCOME_UNKNOWN_TITLE && described.detail.startsWith(outcome.BROADCAST_TX_UNKNOWN_SENTENCE) && described.detail.includes(err?.hash ?? '#'));
  check('…never worded as not sent', !NOT_SENT.test(described.title) && !NOT_SENT.test(described.detail));
  check('isEndpointFailure is false for an unknown outcome (no failover = no second broadcast)', !isEndpointFailure(err) && !isEndpointFailure(new (await import('@shiba-wallet/chains-evm')).BroadcastTimeoutError('eth_sendRawTransaction', 60_000)));
  const worded = Object.assign(new Error('request timed out (aborted)'), { name: 'BroadcastTimeoutError' });
  check('…by name, whatever the wording: an unknown-outcome error that says "timed out" is still never an endpoint failure',
    !isEndpointFailure(worded) && !isEndpointFailure(Object.assign(new Error('timeout'), { name: 'BroadcastOutcomeUnknownError' })) &&
      !isEndpointFailure(Object.assign(new Error('aborted'), { name: 'BroadcastAlreadyHandedOverError' })) && isEndpointFailure(new Error('request timed out')));
  check('isBroadcastOutcomeUnknown recognises the wrapper and the engine\'s bare timeout', outcome.isBroadcastOutcomeUnknown(err) && outcome.isBroadcastOutcomeUnknown(new (await import('@shiba-wallet/chains-evm')).BroadcastTimeoutError('eth_sendRawTransaction', 60_000)) && !outcome.isBroadcastOutcomeUnknown(new Error('x')));

  // 2. The same quote is never broadcast again (nor an identical one).
  const before = silent.seen.filter((x) => x.method === 'eth_sendRawTransaction').length;
  const again = await send.sendEvm(URL, signer, quote, null).then(() => null, (e) => e);
  check('the same quote a second time: refused, no second broadcast request', again?.name === 'BroadcastAlreadyHandedOverError' && silent.seen.filter((x) => x.method === 'eth_sendRawTransaction').length === before);
  const twin = await send.sendEvm(URL, signer, evmQuote(11n), null).then(() => null, (e) => e);
  check('…nor a new quote object for the identical transaction (same signed hash)', twin?.name === 'BroadcastAlreadyHandedOverError' && silent.seen.filter((x) => x.method === 'eth_sendRawTransaction').length === before);
  check('…and the screens can ask before the device check', send.broadcastOutcomeUnknownFor(quote) === true && send.broadcastOutcomeUnknownFor(evmQuote(11n)) === false);
  const dAgain = send.describeSendError(again, 'test ETH', 'test ETH');
  check('…described with its own title, never as not sent', dAgain.title === outcome.BROADCAST_ALREADY_HANDED_OVER_TITLE && dAgain.detail === outcome.BROADCAST_ALREADY_HANDED_OVER_SENTENCE && !NOT_SENT.test(dAgain.detail));
  check('…and the record is untouched', recordsOf(store).length === 1);

  // 3. A node refusal leaves no record of the refused transaction.
  const refStore = memoryStore();
  send.setPendingRecordStore(refStore);
  const refusing = fetchOver(node, () => {
    throw new Error('transaction underpriced');
  }, refStore);
  globalThis.fetch = refusing.fetchFn;
  const q2 = evmQuote(12n);
  const refused = await send.sendEvm(URL, signer, q2, null).then(() => null, (e) => e);
  const rEntry = refusing.seen.find((x) => x.method === 'eth_sendRawTransaction');
  const rHash = ethers.Transaction.from(rEntry.raw).hash.toLowerCase();
  check('a refused broadcast: it WAS recorded before the request…', parseRegistry(rEntry.registryAtSend).records.some((r) => r.hash === rHash));
  check('…and the record is removed after the refusal: no card claims it was sent', recordsOf(refStore).length === 0);
  check('…the node\'s error is unchanged (its existing translation applies)', refused?.message === 'RPC error -32000: transaction underpriced (eth_sendRawTransaction)' && send.describeSendError(refused, 'test ETH', 'test ETH').title === send.TX_UNDERPRICED_TITLE);
  check('…no sent listener fired', events.length === 0);
  const okFetch = fetchOver(node, (raw) => ethers.Transaction.from(raw).hash, refStore);
  globalThis.fetch = okFetch.fetchFn;
  const retried = await send.sendEvm(URL, signer, q2, null);
  check('a refused quote stays usable (the rehearsal retry): accepted on the second approval, recorded once, one sent event',
    retried.txid.toLowerCase() === rHash && recordsOf(refStore).length === 1 && recordsOf(refStore)[0].hash === rHash && events.length === 1);
  check('…and the accepted broadcast also carried the signal; the reads did not', okFetch.seen.every((x) => x.hasSignal === (x.method === 'eth_sendRawTransaction')));

  // 4. A record that already existed (an earlier attempt with an unknown
  // outcome) is never removed by a later refusal of the same transaction.
  const keepStore = memoryStore({ [PENDING_TX_KEY]: store.map.get(PENDING_TX_KEY) });
  send.setPendingRecordStore(keepStore);
  const knownFetch = fetchOver(node, () => {
    throw new Error('already known');
  }, keepStore);
  globalThis.fetch = knownFetch.fetchFn;
  const otherSigner = await send.sendEvmWithSignature(URL, FROM, quote, (() => {
    const tx = ethers.Transaction.from(entry.raw);
    return { yParity: tx.signature.yParity, r: ethers.getBytes(tx.signature.r), s: ethers.getBytes(tx.signature.s) };
  })(), null).then(() => null, (e) => e);
  check('a quote marked unknown is refused on the cold path too (same quote object)', otherSigner?.name === 'BroadcastAlreadyHandedOverError', String(otherSigner?.message));
  const sameTx = (() => {
    const tx = ethers.Transaction.from(entry.raw);
    return { yParity: tx.signature.yParity, r: ethers.getBytes(tx.signature.r), s: ethers.getBytes(tx.signature.s) };
  })();
  const coldTwin = await send.sendEvmWithSignature(URL, FROM, evmQuote(11n), sameTx, null).then(() => null, (e) => e);
  check('…and by its hash with a fresh quote object', coldTwin?.name === 'BroadcastAlreadyHandedOverError' && knownFetch.seen.filter((x) => x.method === 'eth_sendRawTransaction').length === 0);
  const q13 = evmQuote(13n);
  const pre = txRecordFromQuote(FROM, q13, ethers.Transaction.from((await (async () => {
    // The hash sendEvm will produce for q13 (deterministic RFC 6979 signing): from an accepted twin run on a scratch store.
    const scratch = memoryStore();
    send.setPendingRecordStore(scratch);
    const f = fetchOver(node, (raw) => ethers.Transaction.from(raw).hash, scratch);
    globalThis.fetch = f.fetchFn;
    await send.sendEvm(URL, signer, evmQuote(13n), null);
    return f.seen.find((x) => x.method === 'eth_sendRawTransaction').raw;
  })())).hash, T0);
  const existedStore = memoryStore({ [PENDING_TX_KEY]: JSON.stringify({ version: 1, records: [pre] }) });
  send.setPendingRecordStore(existedStore);
  globalThis.fetch = fetchOver(node, () => {
    throw new Error('already known');
  }, existedStore).fetchFn;
  const knownErr = await send.sendEvm(URL, signer, q13, null).then(() => null, (e) => e);
  check('a refusal of a transaction whose record already existed keeps that record (it may be pending)', /already known/.test(knownErr?.message ?? '') && recordsOf(existedStore).length === 1 && recordsOf(existedStore)[0].hash === pre.hash && recordsOf(existedStore)[0].sentAt === T0);

  // 5. A speed-up whose broadcast never gets an answer.
  const rStore = memoryStore();
  const origR = rec(20, { hash: H(20) });
  await recordPendingTransaction(origR, rStore);
  const rGroup = nonceGroups([origR], CHAIN, FROM)[0];
  const rNode = fakeNode({ latestNonce: 20n, pendingNonce: 21n });
  rNode.state.txs.set(H(20), null);
  const rQuote = await send.prepareEvmReplacement(URL, rGroup, 'speed-up', CHAIN, { transport: rNode.transport });
  const rSilent = fetchOver(rNode, 'silent', rStore);
  mock.timers.enable({ apis: ['setTimeout'] });
  let rErr;
  try {
    const p = send.sendEvmReplacement(URL, signer, rQuote, null, { transport: httpTransport(URL, rSilent.fetchFn), store: rStore, now: () => T0 + 900 }).then(() => null, (e) => e);
    const e = await Promise.race([rSilent.reached, realDelay(5_000).then(() => null)]);
    const at = e?.registryAtSend ? parseRegistry(e.registryAtSend).records : [];
    check('a speed-up is recorded, linked to the original, before its broadcast', at.length === 2 && at.some((r) => r.action === 'speed-up' && r.replaces === H(20)));
    mock.timers.tick(BROADCAST_TIMEOUT_MS);
    rErr = await p;
  } finally {
    mock.timers.reset();
  }
  check('…no answer: outcome unknown (not a "Not replaced" refusal), the speed-up stays listed', rErr?.name === 'BroadcastOutcomeUnknownError' && recordsOf(rStore).length === 2);
  check('…the card shows both hashes (the waiting line)', /^Speed-up sent: /.test(pending.replacementWaitingSentence(nonceGroups(recordsOf(rStore), CHAIN, FROM)[0]) ?? ''));
  const rAgain = await send.sendEvmReplacement(URL, signer, rQuote, null, { transport: rNode.transport, store: rStore }).then(() => null, (e) => e);
  check('…and the replacement quote is not sendable again', rAgain?.message === REPLACEMENT_QUOTE_USED);
  // The identical speed-up again (a new quote, the same signed transaction): refused by its hash.
  const rTwin = await send.prepareEvmReplacement(URL, rGroup, 'speed-up', CHAIN, { transport: rNode.transport });
  const rTwinErr = await send.sendEvmReplacement(URL, signer, rTwin, null, { transport: httpTransport(URL, rSilent.fetchFn), store: rStore }).then(() => null, (e) => e);
  check('…nor an identical speed-up from a fresh quote (same signed hash)', rTwinErr?.name === 'BroadcastAlreadyHandedOverError');
  // A refused speed-up leaves the original only.
  const uStore = memoryStore();
  const origU = rec(21, { hash: H(21) });
  await recordPendingTransaction(origU, uStore);
  const uGroup = nonceGroups([origU], CHAIN, FROM)[0];
  const uNode = fakeNode({ latestNonce: 21n, pendingNonce: 22n });
  uNode.state.txs.set(H(21), null);
  const uQuote = await send.prepareEvmReplacement(URL, uGroup, 'speed-up', CHAIN, { transport: uNode.transport });
  const under = fetchOver(uNode, () => {
    throw new Error('replacement transaction underpriced');
  }, uStore);
  const uErr = await send.sendEvmReplacement(URL, signer, uQuote, null, { transport: httpTransport(URL, under.fetchFn), store: uStore }).then(() => null, (e) => e);
  check('a refused speed-up: recorded before the request, removed after, the original kept, "Not replaced" sentence',
    parseRegistry(under.seen.find((x) => x.method === 'eth_sendRawTransaction').registryAtSend).records.length === 2 &&
      recordsOf(uStore).length === 1 && recordsOf(uStore)[0].hash === H(21) && uErr?.message === REPLACEMENT_UNDERPRICED_SENTENCE);

  // 6. Reads keep no time limit: a receipt read that never answers is still
  // waiting after ten minutes, with no signal on its request.
  const readFetch = { seen: [] };
  const neverRead = async (url, init) => {
    readFetch.seen.push({ method: JSON.parse(init.body).method, hasSignal: init.signal !== undefined });
    return new Promise(() => undefined);
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  let readSettled = false;
  try {
    const t = httpTransport(URL, neverRead);
    t('eth_call', [{ to: TO, data: '0x' }, 'latest']).then(() => (readSettled = true), () => (readSettled = true));
    t('eth_getTransactionReceipt', [H(1)]).then(() => (readSettled = true), () => (readSettled = true));
    await flush();
    mock.timers.tick(10 * 60_000);
    await flush();
  } finally {
    mock.timers.reset();
  }
  check('reads (eth_call, a receipt) keep no time limit: still waiting after ten minutes, no signal', readSettled === false && readFetch.seen.length >= 2 && readFetch.seen.every((x) => x.hasSignal === false));

  offSent();
  send.setPendingRecordStore(null);
  globalThis.fetch = savedFetch;
}

// ---------------------------------------------------------------------------
console.log('check-pending: an HTTP 5xx or a dropped connection is an open outcome, and spending limits count before the broadcast (bounded-broadcast follow-ups)');
// ---------------------------------------------------------------------------
// The engine's real httpTransport over a fake fetch: a 502 answer, a fetch
// that rejects (a dropped connection) and an answer that is not JSON on
// eth_sendRawTransaction are open outcomes (the record stays, the spend stays
// counted); a JSON-RPC error and an HTTP 400 stay definite refusals (the
// record and the count this attempt made are removed). The app's spending
// recorder (spending-policy.ts installSpendingRecorder) is installed over an
// in-memory store with a native-coin limit that counts fees.
{
  const outcome = await import('../src/wallet/broadcast-outcome.ts');
  const { isEndpointFailure } = await import('../src/config/endpoint-probe.ts');
  const { httpTransport } = await import('@shiba-wallet/chains-evm');
  const spending = await import('../src/wallet/spending-policy.ts');
  const NOT_SENT = /not sent|nothing was sent|could not be sent|was not sent/i;
  const recordsOf = (store) => parseRegistry(store.map.get(PENDING_TX_KEY) ?? null).records;
  const evmQuote = (nonce) => ({ kind: 'evm', ...quoteLike({ nonce }), balance: 10n ** 18n, fee: 21_000n, total: 0n, simulation: { ok: true, returnData: '0x' } });
  const answer = (id, body) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, ...body }) });
  const spendStore = memoryStore();
  const scope = { chain: CHAIN, owner: FROM };
  await saveSpendingPolicy(scope, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 10n ** 18n, windowSeconds: 86400, countFees: true }, [NATIVE_TOKEN], { store: spendStore });
  const uninstall = spending.installSpendingRecorder(spendStore);
  const spendRecords = async () => (await spending.listSpendRecords(scope, spendStore)).records;
  const countedFor = async (hash) => (await spendRecords()).filter((r) => r.ref.toLowerCase() === hash.toLowerCase());
  // A fetch over a fake node; `onBroadcast(raw, id)` answers eth_sendRawTransaction
  // (a Response-like object, or it throws). The spend history at the moment
  // of the broadcast request is captured.
  function fetchWith(node, onBroadcast) {
    const seen = [];
    const fetchFn = async (_url, init) => {
      const { method, params, id } = JSON.parse(init.body);
      if (method === 'eth_sendRawTransaction') {
        const hash = ethers.Transaction.from(params[0]).hash.toLowerCase();
        seen.push({ raw: params[0], hash, countedAtSend: await countedFor(hash) });
        return onBroadcast(params[0], id);
      }
      try {
        return answer(id, { result: await node.transport(method, params) });
      } catch (e) {
        return answer(id, { error: { code: -32000, message: e.message } });
      }
    };
    return { fetchFn, seen };
  }
  const savedFetch = globalThis.fetch;
  const store = memoryStore();
  send.setPendingRecordStore(store);
  const node = fakeNode();
  const sentEvents = [];
  const offSent = send.addEvmSentListener((e) => void sentEvents.push(e));

  // A. HTTP 502.
  const f502 = fetchWith(node, async () => ({ ok: false, status: 502, json: async () => ({}) }));
  globalThis.fetch = f502.fetchFn;
  const q1 = evmQuote(31n);
  const e1 = await send.sendEvm(URL, signer, q1, null).then(() => null, (e) => e);
  const h1 = f502.seen[0]?.hash;
  check('HTTP 502 on eth_sendRawTransaction: BroadcastOutcomeUnknownError (reason server-error) under the device hash, listed',
    e1?.name === 'BroadcastOutcomeUnknownError' && e1.reason === 'server-error' && e1.hash === h1 && e1.kind === 'tx' && e1.recorded === true, String(e1?.message));
  check('…its message is the open sentence (a server error or a dropped connection; the endpoint may have accepted it), never the 60-second one',
    e1?.message === outcome.BROADCAST_TX_OPEN_SENTENCE && /may have accepted it/.test(e1.message) && !/within 60 seconds/.test(e1.message) && !NOT_SENT.test(e1.message));
  check('…the record stays (Pending on this phone lists it)', recordsOf(store).some((r) => r.hash === h1));
  const d1 = send.describeSendError(e1, 'test ETH', 'test ETH');
  check('describeSendError: "No usable answer from the network.", the open sentence, the hash and the raw cause (HTTP 502) in the technical line, never "not sent"',
    d1.title === outcome.BROADCAST_OUTCOME_OPEN_TITLE && d1.title === 'No usable answer from the network.' && d1.detail.startsWith(outcome.BROADCAST_TX_OPEN_SENTENCE) &&
      d1.detail.includes('RPC HTTP error 502 for eth_sendRawTransaction') && d1.detail.includes(h1 ?? '#') && !NOT_SENT.test(d1.title + d1.detail), d1.detail);
  check('…no endpoint failover (by name, the engine\'s error and the wrapper)', !isEndpointFailure(e1) &&
    !isEndpointFailure(Object.assign(new Error('RPC HTTP error 502 for eth_sendRawTransaction'), { name: 'BroadcastUnansweredError' })));
  const e1again = await send.sendEvm(URL, signer, q1, null).then(() => null, (e) => e);
  check('…and the same quote is never broadcast again', e1again?.name === 'BroadcastAlreadyHandedOverError' && f502.seen.length === 1);
  const c1 = await countedFor(h1);
  check('SPENDING: the open outcome is counted before the broadcast (value and worst-case fee, under the device hash) and stays counted',
    f502.seen[0]?.countedAtSend.length === 2 && c1.length === 2 && c1.find((r) => r.kind === 'transfer')?.amount === q1.amount && c1.find((r) => r.kind === 'fee')?.amount === q1.fee);
  check('…no sent listener fired (the acceptance channel still means "accepted")', sentEvents.length === 0);

  // B. A dropped connection (Expo's FetchError: "fetch failed: …").
  const fDrop = fetchWith(node, async () => {
    throw Object.assign(new Error('fetch failed: java.net.SocketException: Connection reset'), { name: 'FetchError' });
  });
  globalThis.fetch = fDrop.fetchFn;
  const e2 = await send.sendEvm(URL, signer, evmQuote(32n), null).then(() => null, (e) => e);
  const h2 = fDrop.seen[0]?.hash;
  check('a dropped connection on the broadcast: open outcome (reason connection), listed, the raw cause kept', e2?.name === 'BroadcastOutcomeUnknownError' && e2.reason === 'connection' &&
    recordsOf(store).some((r) => r.hash === h2) && /Connection reset/.test(e2.technical) && e2.message === outcome.BROADCAST_TX_OPEN_SENTENCE);
  check('…counted and kept', (await countedFor(h2)).length === 2);
  check('…never an endpoint failure (no second broadcast elsewhere)', !isEndpointFailure(e2));

  // C. An answer that is not JSON (a proxy's HTML page on a 200).
  const fHtml = fetchWith(node, async () => ({ ok: true, status: 200, json: async () => JSON.parse('<html>') }));
  globalThis.fetch = fHtml.fetchFn;
  const e3 = await send.sendEvm(URL, signer, evmQuote(33n), null).then(() => null, (e) => e);
  check('an unreadable answer: open outcome (reason connection), listed, counted', e3?.name === 'BroadcastOutcomeUnknownError' && e3.reason === 'connection' &&
    recordsOf(store).some((r) => r.hash === fHtml.seen[0]?.hash) && (await countedFor(fHtml.seen[0]?.hash ?? '#')).length === 2);

  // D. HTTP 400 and E. a JSON-RPC error stay definite refusals: the record and the count are removed.
  const f400 = fetchWith(node, async () => ({ ok: false, status: 400, json: async () => ({}) }));
  globalThis.fetch = f400.fetchFn;
  const e4 = await send.sendEvm(URL, signer, evmQuote(34n), null).then(() => null, (e) => e);
  const h4 = f400.seen[0]?.hash;
  check('HTTP 400: a definite refusal worded as before (record removed)', e4?.message === 'RPC HTTP error 400 for eth_sendRawTransaction' && e4.name === 'Error' && !recordsOf(store).some((r) => r.hash === h4));
  check('…the spend WAS counted at the broadcast request, and is released after the refusal', f400.seen[0]?.countedAtSend.length === 2 && (await countedFor(h4)).length === 0);
  const fRpc = fetchWith(node, async (_raw, id) => answer(id, { error: { code: -32000, message: 'nonce too low' } }));
  globalThis.fetch = fRpc.fetchFn;
  const e5 = await send.sendEvm(URL, signer, evmQuote(35n), null).then(() => null, (e) => e);
  const h5 = fRpc.seen[0]?.hash;
  check('a parsed JSON-RPC error: a definite refusal (the node answered), record removed, spend released',
    e5?.message === 'RPC error -32000: nonce too low (eth_sendRawTransaction)' && !recordsOf(store).some((r) => r.hash === h5) &&
      fRpc.seen[0]?.countedAtSend.length === 2 && (await countedFor(h5)).length === 0);

  // F. Accepted: counted once although the sent listener records too, also
  // when the node returns the hash in another case or a different hash.
  const fOk = fetchWith(node, async (raw, id) => answer(id, { result: ethers.Transaction.from(raw).hash }));
  globalThis.fetch = fOk.fetchFn;
  const q6 = evmQuote(36n);
  const r6 = await send.sendEvm(URL, signer, q6, null);
  await spending.flushSpendingWrites();
  check('accepted: counted ONCE (before the broadcast; the sent listener finds it and adds nothing)', sentEvents.length === 1 && (await countedFor(r6.txid)).length === 2);
  const fUpper = fetchWith(node, async (raw, id) => answer(id, { result: `0x${ethers.Transaction.from(raw).hash.slice(2).toUpperCase()}` }));
  globalThis.fetch = fUpper.fetchFn;
  const r7 = await send.sendEvm(URL, signer, evmQuote(37n), null);
  await spending.flushSpendingWrites();
  check('…the node\'s hash in upper case: still once', sentEvents.length === 2 && (await countedFor(r7.txid)).length === 2);
  const OTHER = H(424242);
  const fOther = fetchWith(node, async (_raw, id) => answer(id, { result: OTHER }));
  globalThis.fetch = fOther.fetchFn;
  await send.sendEvm(URL, signer, evmQuote(38n), null);
  await spending.flushSpendingWrites();
  check('…a node that returns a DIFFERENT hash: the count moves to it, still once (no record left under the device hash)',
    sentEvents.length === 3 && (await countedFor(OTHER)).length === 2 && (await countedFor(fOther.seen[0]?.hash ?? '#')).length === 0);

  // G. A replacement counts its fee only, before its broadcast, kept on an open outcome.
  const rStore = memoryStore();
  const orig = rec(40, { hash: H(40) });
  await recordPendingTransaction(orig, rStore);
  const rGroup = nonceGroups([orig], CHAIN, FROM)[0];
  const rNode = fakeNode({ latestNonce: 40n, pendingNonce: 41n });
  rNode.state.txs.set(H(40), null);
  const rQuote = await send.prepareEvmReplacement(URL, rGroup, 'speed-up', CHAIN, { transport: rNode.transport });
  const rFetch = fetchWith(rNode, async () => ({ ok: false, status: 503, json: async () => ({}) }));
  const rErr = await send.sendEvmReplacement(URL, signer, rQuote, null, { transport: httpTransport(URL, rFetch.fetchFn), store: rStore }).then(() => null, (e) => e);
  const rHash = rFetch.seen[0]?.hash;
  const rc = await countedFor(rHash ?? '#');
  check('a speed-up answered HTTP 503: open outcome (not "Not replaced"), listed, its FEE counted (never the value again)',
    rErr?.name === 'BroadcastOutcomeUnknownError' && rErr.reason === 'server-error' && recordsOf(rStore).length === 2 &&
      rc.length === 1 && rc[0].kind === 'fee' && rc[0].amount === rQuote.fee);
  const aStore = memoryStore();
  const origA = rec(41, { hash: H(41) });
  await recordPendingTransaction(origA, aStore);
  const aNode = fakeNode({ latestNonce: 41n, pendingNonce: 42n });
  aNode.state.txs.set(H(41), null);
  const aQuote = await send.prepareEvmReplacement(URL, nonceGroups([origA], CHAIN, FROM)[0], 'cancel', CHAIN, { transport: aNode.transport });
  const aSent = await send.sendEvmReplacement(URL, signer, aQuote, null, { transport: aNode.transport, store: aStore });
  const aIn = replacementSpendingInput({ fee: aQuote.fee, from: FROM });
  await spending.recordAcceptedSpend({ scope, spender: aIn.spender, calls: aIn.calls, fee: aIn.fee, ref: aSent.txid, store: spendStore });
  check('an accepted cancellation + the screen\'s own recordAcceptedSpend: its fee counted once', (await countedFor(aSent.txid)).length === 1);

  // H. A settled nonce releases what can never be included (no network read of its own).
  const settle = async (outcomeTx, txs) => {
    const pStore = memoryStore();
    for (const t of txs) await recordPendingTransaction(t, pStore);
    const sNode = fakeNode({ latestNonce: 61n, pendingNonce: 61n });
    sNode.state.receipts.set(outcomeTx, { block: 99n });
    sNode.state.txs.set(outcomeTx, 99n);
    const before = sNode.calls.length;
    await refreshAccountPending({ reader: nodeReader(sNode.transport), chain: CHAIN, from: FROM, store: pStore });
    return sNode.calls.length - before;
  };
  const spendAs = (ref, value, fee) => spending.recordAcceptedSpend({ scope, spender: FROM, calls: value > 0n ? [{ to: TO, value }] : [], fee, ref, store: spendStore });
  // Cancelled: the original (value 7, fee 3) and its cancellation (fee 5) mined.
  await spendAs(H(50), 7n, 3n);
  await spendAs(H(51), 0n, 5n);
  const cOrig = rec(60, { hash: H(50) });
  const cCancel = rec(60, { hash: H(51), to: FROM_L, amount: 0n, sentAt: T0 + 61 }, { action: 'cancel', replaces: H(50) });
  await settle(H(51), [cOrig, cCancel]);
  check('a nonce that went to the CANCELLATION: every record of the original is released, the cancellation\'s fee stays',
    (await countedFor(H(50))).length === 0 && (await countedFor(H(51))).length === 1);
  // Replaced: the original (value 7, fee 3) and a speed-up (fee 5) mined.
  await spendAs(H(52), 7n, 3n);
  await spendAs(H(53), 0n, 5n);
  const sOrig = rec(60, { hash: H(52) });
  const sUp = rec(60, { hash: H(53), sentAt: T0 + 61 }, { action: 'speed-up', replaces: H(52) });
  await settle(H(53), [sOrig, sUp]);
  const kept52 = await countedFor(H(52));
  check('a nonce that went to the SPEED-UP: the original\'s value stays counted (the speed-up re-sent it), only its fee is released',
    kept52.length === 1 && kept52[0].kind === 'transfer' && kept52[0].amount === 7n && (await countedFor(H(53))).length === 1);
  // Superseded: two ordinary sends, the second mined.
  await spendAs(H(54), 7n, 3n);
  await spendAs(H(55), 9n, 3n);
  await settle(H(55), [rec(60, { hash: H(54) }), rec(60, { hash: H(55), sentAt: T0 + 61 })]);
  check('a nonce that went to ANOTHER ordinary send: the losing send is released entirely, the included one stays',
    (await countedFor(H(54))).length === 0 && (await countedFor(H(55))).length === 2);
  // A single broadcast included: nothing released.
  await spendAs(H(56), 7n, 3n);
  await settle(H(56), [rec(60, { hash: H(56) })]);
  check('a nonce with a single broadcast included: nothing released', (await countedFor(H(56))).length === 2);
  check('…the release reads nothing from the network beyond the settle\'s own reads (releaseSettledSpend takes only the event)',
    spending.releaseSettledSpend.length >= 1 && !/fetch|transport|reader/.test(spending.releaseSettledSpend.toString()));

  uninstall();
  offSent();
  send.setPendingRecordStore(null);
  globalThis.fetch = savedFetch;
}

// ---------------------------------------------------------------------------
console.log('check-pending: the minimum-fee rehearsal (Settings → Developer, phase 21 item 3)');
// ---------------------------------------------------------------------------
{
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { resolve: resolvePath } = await import('node:path');
  const evm = await import('../src/config/evm-chain.ts');
  const HERE_M = dirname(fileURLToPath(import.meta.url));
  const SEPOLIA = 'eip155:11155111';
  const MAINNET = 'eip155:1';
  const useNode = (node) => {
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
  };
  const json = (o) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? Array.from(v) : v));
  // Custom networks the user added: one MAIN network, one allow-listed test network.
  const customMain = { ...evm.EVM_SEPOLIA, caip2: 'eip155:59144', chainIdDecimal: '59144', label: 'My chain', testnet: false, kernelV33Verified: false,
    custom: { rpcUrl: 'https://rpc.mychain.example', nativeSymbol: 'ETH', explorerBase: null, blockTimeMs: null, testnetRequested: false } };
  const customTest = { ...evm.EVM_SEPOLIA, caip2: 'eip155:59141', chainIdDecimal: '59141', label: 'Linea Sepolia', testnet: true, kernelV33Verified: false,
    custom: { rpcUrl: 'https://rpc.linea-sepolia.example', nativeSymbol: 'ETH', explorerBase: null, blockTimeMs: null, testnetRequested: true } };
  evm.setCustomEvmProfiles([customMain, customTest]);

  send.setMinimumFeeRehearsal(SEPOLIA, false);
  let notified = 0;
  const unsub = send.subscribeMinimumFeeRehearsal(() => { notified += 1; });
  check('the switch is offered on test networks (Sepolia, a built-in L2 test network, an allow-listed network you added) only',
    send.minimumFeeRehearsalOffered(SEPOLIA) && send.minimumFeeRehearsalOffered('eip155:84532') && send.minimumFeeRehearsalOffered(customTest.caip2) &&
      !send.minimumFeeRehearsalOffered(MAINNET) && !send.minimumFeeRehearsalOffered(customMain.caip2) && !send.minimumFeeRehearsalOffered('eip155:8453'));
  check('turning it on is refused on Ethereum mainnet (stays off)', send.setMinimumFeeRehearsal(MAINNET, true) === false && !send.minimumFeeRehearsalArmed(MAINNET) && notified === 0);
  check('…and on a network the user added as a MAIN network (stays off)', send.setMinimumFeeRehearsal(customMain.caip2, true) === false && !send.minimumFeeRehearsalArmed(customMain.caip2) && notified === 0);
  check('on Sepolia it arms, for Sepolia only (not for another network)', send.setMinimumFeeRehearsal(SEPOLIA, true) === true && send.minimumFeeRehearsalArmed(SEPOLIA) && !send.minimumFeeRehearsalArmed('eip155:84532') && notified === 1);

  // The native quote at the minimum fee (fake node: base fee 16 wei — the
  // live Sepolia figure of pass p21c — and node priority 1,000,004).
  const BASE = 16n;
  const PRIORITY = 1_000_004n;
  const node = fakeNode({ estimate: 21_000n, baseFee: BASE });
  useNode(node);
  const ordinary = await send.prepareEvmSend(URL, FROM, TO, 10n ** 14n, undefined, SEPOLIA);
  const rehearsal = await send.prepareEvmSend(URL, FROM, TO, 10n ** 14n, undefined, SEPOLIA, { minimumFee: true });
  check('an ordinary Sepolia quote is unchanged (2 × base + node priority, no marker)',
    ordinary.maxFeePerGas === 2n * BASE + PRIORITY && ordinary.maxPriorityFeePerGas === PRIORITY && !('minimumFee' in ordinary));
  // EIP-1559: a block may include a transaction only if max_fee_per_gas >= base_fee_per_gas.
  const rehearsalPriced = (q) => q.maxPriorityFeePerGas === 1n && q.maxFeePerGas === 1n && q.minimumFee?.baseFeePerGas === BASE && q.maxFeePerGas < BASE;
  check('the rehearsal quote: max fee exactly 1 wei and priority fee exactly 1 wei, BELOW the 16-wei base fee (no block can include it)',
    rehearsalPriced(rehearsal) && send.MINIMUM_FEE_MAX_FEE_WEI === 1n && send.MINIMUM_FEE_PRIORITY_WEI === 1n, `${rehearsal.maxFeePerGas}/${rehearsal.maxPriorityFeePerGas}`);
  check('…its worst-case fee and total follow (21,000 × 1 wei)', rehearsal.fee === 21_000n && rehearsal.total === 10n ** 14n + 21_000n && rehearsal.gasLimit === 21_000n);
  check('…every other field equals the ordinary quote', json({ ...rehearsal, maxFeePerGas: 0, maxPriorityFeePerGas: 0, fee: 0, total: 0, minimumFee: 0 }) === json({ ...ordinary, maxFeePerGas: 0, maxPriorityFeePerGas: 0, fee: 0, total: 0, minimumFee: 0 }));
  check('preparing (and so cancelling) a rehearsal quote leaves the option on', send.minimumFeeRehearsalArmed(SEPOLIA));
  check('the confirm fee line (exact, the base fee read live)', send.minimumFeeRehearsalFeeLine(rehearsal) ===
    "Priced at the minimum fee: a max fee of 1 wei and a priority fee of 1 wei per gas, below the latest block's base fee (16 wei), so no block can include it until you speed it up or cancel it.",
    send.minimumFeeRehearsalFeeLine(rehearsal));
  {
    // A base fee not above 1 wei: the line must not claim it cannot be included.
    useNode(fakeNode({ estimate: 21_000n, baseFee: 1n }));
    const lowBase = await send.prepareEvmSend(URL, FROM, TO, 10n ** 14n, undefined, SEPOLIA, { minimumFee: true });
    check('…with a base fee of 1 wei the line says a block may include it at once (exact)',
      lowBase.maxFeePerGas === 1n && send.minimumFeeRehearsalFeeLine(lowBase) ===
        "Priced at the minimum fee: a max fee of 1 wei and a priority fee of 1 wei per gas. The latest block's base fee (1 wei) is not above that, so a block may include it at once and it may never show as pending.",
      send.minimumFeeRehearsalFeeLine(lowBase));
    useNode(node);
  }
  check('the confirm warning (exact)', send.MINIMUM_FEE_REHEARSAL_WARNING ===
    'Minimum-fee rehearsal: this transaction offers a max fee of only 1 wei per gas, so while the network’s base fee is above that it stays pending until you speed it up or cancel it from Activity. The node may also refuse it outright.');
  check('the switch label (exact)', send.MINIMUM_FEE_REHEARSAL_SWITCH_LABEL ===
    'Send the next regular-account transaction at the minimum fee (to rehearse Speed up / Cancel)');
  check('the Developer note says a node may refuse it outright ("transaction underpriced") and that this is expected',
    send.MINIMUM_FEE_REHEARSAL_HINT.includes('The node may refuse such an under-priced transaction outright ("transaction underpriced"); that is expected') &&
      send.MINIMUM_FEE_REHEARSAL_HINT.startsWith('Test networks only.'));
  check('the Developer note (exact)', send.MINIMUM_FEE_REHEARSAL_HINT ===
    'Test networks only. The next native-coin or token send from the Send screen, with the smart account off, is priced at a max fee of 1 wei and a priority fee of 1 wei per gas. ' +
    'A block can include a transaction only if its max fee is at least the block’s base fee, so while the base fee is above 1 wei this one stays in the network’s pool until you speed it up or cancel it from Activity; ' +
    'the speed-up or cancellation is priced at the node’s normal fee suggestion, so a block can include it. The option turns itself off once that transaction is sent; going back from the confirm screen leaves it on, ' +
    'and it is off again whenever the app restarts. NFT sends, swaps, staking, app requests and smart-account operations are always priced normally. ' +
    'The node may refuse such an under-priced transaction outright ("transaction underpriced"); that is expected, because the nodes behind one endpoint address can apply different minimums, ' +
    'and the option then stays on until a send goes through or you turn it off. On the layer-2 test networks the transaction goes to the network’s sequencer, which may refuse it rather than hold it; that has not been tried.');
  check('…and no longer says the max fee is the base fee plus 1 wei, nor that Arbitrum includes it anyway',
    !/plus 1 wei|base fee \+ 1|likely to be included/.test(send.MINIMUM_FEE_REHEARSAL_HINT + send.MINIMUM_FEE_REHEARSAL_WARNING));

  // Refused on a main network: the option is ignored and the quote is the ordinary one.
  for (const [label, caip2, chainId] of [['Ethereum mainnet', MAINNET, 1n], ['a network the user added as a main network', customMain.caip2, 59144n]]) {
    useNode(fakeNode({ chainId, estimate: 21_000n }));
    const plain = await send.prepareEvmSend(URL, FROM, TO, 10n ** 14n, undefined, caip2);
    const asked = await send.prepareEvmSend(URL, FROM, TO, 10n ** 14n, undefined, caip2, { minimumFee: true });
    check(`${label}: minimumFee is ignored — the quote is key-for-key the ordinary one, no marker`, json(asked) === json(plain) && !('minimumFee' in asked) && asked.maxPriorityFeePerGas === 1_000_004n);
  }
  // A token quote re-priced (send-erc20.ts prepareErc20Send takes no options).
  useNode(node);
  const tokenQuote = { kind: 'erc20', to: TO, contract: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', symbol: 'USDC', decimals: 6, amount: 5n, tokenBalance: 10n,
    ethBalance: 10n ** 18n, nonce: 7n, chainId: 11155111n, gasLimit: 45_000n, maxFeePerGas: 1_000_032n, maxPriorityFeePerGas: 1_000_004n, fee: 45_000n * 1_000_032n,
    data: new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]), simulation: { ok: true, returnData: '0x' }, returnedFalse: false, gasIsFallback: false };
  const tokenRehearsal = await send.repriceTokenQuoteAtMinimumFee(URL, tokenQuote, { to: tokenQuote.contract, value: 0n, data: tokenQuote.data });
  check('token send: max fee 1 wei and priority 1 wei (below the base fee), fee = gas × 1 wei, marker; every other field unchanged',
    rehearsalPriced(tokenRehearsal) && tokenRehearsal.fee === 45_000n &&
      json({ ...tokenRehearsal, maxFeePerGas: 0, maxPriorityFeePerGas: 0, fee: 0, minimumFee: 0 }) === json({ ...tokenQuote, maxFeePerGas: 0, maxPriorityFeePerGas: 0, fee: 0, minimumFee: 0 }));
  const mainnetToken = { ...tokenQuote, chainId: 1n };
  check('token send on mainnet: returned unchanged (the same object, no request made)',
    (await send.repriceTokenQuoteAtMinimumFee(URL, mainnetToken, { to: tokenQuote.contract, value: 0n, data: tokenQuote.data })) === mainnetToken);

  // One-shot.
  check('an ORDINARY quote that was sent does not turn it off', send.consumeMinimumFeeRehearsal(ordinary) === false && send.minimumFeeRehearsalArmed(SEPOLIA));
  const before = notified;
  check('the rehearsal quote that was sent turns it off (once), and listeners hear it',
    send.consumeMinimumFeeRehearsal(rehearsal) === true && !send.minimumFeeRehearsalArmed(SEPOLIA) && notified === before + 1 &&
      send.consumeMinimumFeeRehearsal(rehearsal) === false);
  send.setMinimumFeeRehearsal(SEPOLIA, true);
  check('a sent token rehearsal quote turns it off too', send.consumeMinimumFeeRehearsal(tokenRehearsal) === true && !send.minimumFeeRehearsalArmed(SEPOLIA));
  send.setMinimumFeeRehearsal(SEPOLIA, true);
  check('switching it off from Settings works for any network', send.setMinimumFeeRehearsal(SEPOLIA, false) === false && !send.minimumFeeRehearsalArmed(SEPOLIA));

  // The broadcast is recorded at those fees, and the replacement rule of
  // 516c023 applies to it unchanged: max(old + 1, ceil(old × 1.1)) per field.
  const store = memoryStore();
  send.setPendingRecordStore(store);
  const sent = await send.sendEvm(URL, signer, rehearsal, null);
  const recorded = (await loadPendingRegistry(store)).records[0];
  check('the rehearsal broadcast is recorded as pending with max fee 1 wei and priority 1 wei',
    recorded?.hash === sent.txid.toLowerCase() && recorded.maxFeePerGas === '1' && recorded.maxPriorityFeePerGas === '1');
  const speedUp = replacementFees(pooledFees([recorded]), { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
  check('…the replacement rule alone would allow 2 / 2 wei — still below the base fee, so never used by itself',
    speedUp.minimum.maxPriorityFeePerGas === 2n && speedUp.minimum.maxFeePerGas === 2n && speedUp.minimum.maxFeePerGas < BASE);
  send.setPendingRecordStore(null);

  // Speed up and Cancel of that 1 / 1 wei broadcast are priced at the node's
  // suggestion (base × 2 + priority), never below the base fee, and still
  // clear the 10% / +1 wei rule against the original.
  const rehearsalGroup = nonceGroups([recorded], SEPOLIA, FROM)[0];
  const includable = (q, base, priority) =>
    q.maxFeePerGas === 2n * base + priority && q.maxPriorityFeePerGas === (priority > 2n ? priority : 2n) &&
    q.maxFeePerGas >= base && pending.meetsReplacementRule({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, q);
  const speedUpQuote = await send.prepareEvmReplacement(URL, rehearsalGroup, 'speed-up', SEPOLIA, { transport: fakeNode({ baseFee: BASE }).transport });
  check('Speed up of the 1 / 1 wei rehearsal: priced at the node suggestion (32 + 1,000,004 / 1,000,004 wei), ≥ the base fee and ≥ the rule',
    includable(speedUpQuote, BASE, PRIORITY) && speedUpQuote.to === TO && speedUpQuote.amount === 10n ** 14n,
    `${speedUpQuote.maxFeePerGas}/${speedUpQuote.maxPriorityFeePerGas}`);
  const cancelQuote = await send.prepareEvmReplacement(URL, rehearsalGroup, 'cancel', SEPOLIA, { transport: fakeNode({ baseFee: BASE }).transport });
  check('Cancel of the 1 / 1 wei rehearsal: likewise priced at the suggestion, 0 to the sender itself',
    includable(cancelQuote, BASE, PRIORITY) && cancelQuote.to === FROM_L && cancelQuote.amount === 0n && cancelQuote.replacement.recordedAction === 'cancel',
    `${cancelQuote.maxFeePerGas}/${cancelQuote.maxPriorityFeePerGas}`);
  const tiplessQuote = await send.prepareEvmReplacement(URL, rehearsalGroup, 'speed-up', SEPOLIA, { transport: fakeNode({ baseFee: BASE, priority: 0n }).transport });
  check('…with a node suggesting a 0 priority fee: max fee 2 × base (32 wei), priority the rule’s 2 wei',
    includable(tiplessQuote, BASE, 0n) && tiplessQuote.maxFeePerGas === 32n && tiplessQuote.maxPriorityFeePerGas === 2n,
    `${tiplessQuote.maxFeePerGas}/${tiplessQuote.maxPriorityFeePerGas}`);

  // Mutant: a consume that never turns the option off must be caught.
  const sendSrc = readFileSync(join(HERE_M, '../src/wallet/send.ts'), 'utf8');
  const RESET = '  minimumFeeArmedFor = null;\n  notifyMinimumFeeListeners();\n  return true;';
  // Inside scripts/ (as check-aa's mutants) so the copy resolves the app's packages.
  const mutantDir = join(HERE_M, `.mutants-pending-${process.pid}`);
  mkdirSync(mutantDir, { recursive: true });
  try {
    const rewritten = sendSrc.replace(RESET, '  notifyMinimumFeeListeners();\n  return true;')
      .replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(join(HERE_M, '../src/wallet'), spec)).href}'`);
    const file = join(mutantDir, 'send-mutant.ts');
    writeFileSync(file, rewritten);
    const mutant = await import(pathToFileURL(file).href);
    mutant.setMinimumFeeRehearsal(SEPOLIA, true);
    mutant.consumeMinimumFeeRehearsal(rehearsal);
    check('mutant caught: the option left on after the rehearsal quote was sent', sendSrc.includes(RESET) && mutant.minimumFeeRehearsalArmed(SEPOLIA) === true);
    mutant.setMinimumFeeRehearsal(SEPOLIA, false);

    // Mutant: the first version's pricing (max fee = base fee + 1 wei), which
    // Sepolia included in the next block (pass p21c).
    const PRICED = '    maxFeePerGas: MINIMUM_FEE_MAX_FEE_WEI,\n';
    const oldPricing = sendSrc.replace(PRICED, '    maxFeePerGas: baseFeePerGas + MINIMUM_FEE_PRIORITY_WEI,\n')
      .replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(join(HERE_M, '../src/wallet'), spec)).href}'`);
    const oldFile = join(mutantDir, 'send-mutant-base-plus-one.ts');
    writeFileSync(oldFile, oldPricing);
    const oldMutant = await import(pathToFileURL(oldFile).href);
    useNode(node);
    const oldQuote = await oldMutant.prepareEvmSend(URL, FROM, TO, 10n ** 14n, undefined, SEPOLIA, { minimumFee: true });
    check('mutant caught: the old base fee + 1 wei pricing (17 wei, includable) fails the 1 / 1 wei pin',
      sendSrc.includes(PRICED) && oldQuote.maxFeePerGas === BASE + 1n && !rehearsalPriced(oldQuote), `${oldQuote.maxFeePerGas}`);

    // Mutant: a speed-up priced at the bare replacement minimum (2 / 2 wei),
    // below the base fee — replacementFees ignoring the node's suggestion.
    const pendingSrc = readFileSync(join(HERE_M, '../src/wallet/pending-transactions.ts'), 'utf8');
    const CHOOSE = '  let maxFeePerGas = suggested.maxFeePerGas > minimum.maxFeePerGas ? suggested.maxFeePerGas : minimum.maxFeePerGas;';
    const PRIORITY_CHOICE = /  const maxPriorityFeePerGas =\n    suggested\.maxPriorityFeePerGas > minimum\.maxPriorityFeePerGas\n      \? suggested\.maxPriorityFeePerGas\n      : minimum\.maxPriorityFeePerGas;/;
    const toUrls = (src, dir) => src.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(join(HERE_M, dir), spec)).href}'`);
    const bareFile = join(mutantDir, 'pending-mutant-bare-minimum.ts');
    writeFileSync(bareFile, toUrls(pendingSrc.replace(CHOOSE, '  let maxFeePerGas = minimum.maxFeePerGas;')
      .replace(PRIORITY_CHOICE, '  const maxPriorityFeePerGas = minimum.maxPriorityFeePerGas;'), '../src/wallet'));
    const bareSendFile = join(mutantDir, 'send-mutant-bare-minimum.ts');
    writeFileSync(bareSendFile, toUrls(sendSrc, '../src/wallet').replace(
      `'${pathToFileURL(resolvePath(join(HERE_M, '../src/wallet'), './pending-transactions.ts')).href}'`, `'${pathToFileURL(bareFile).href}'`));
    const bareSend = await import(pathToFileURL(bareSendFile).href);
    const bareQuote = await bareSend.prepareEvmReplacement(URL, rehearsalGroup, 'speed-up', SEPOLIA, { transport: fakeNode({ baseFee: BASE }).transport });
    check('mutant caught: a speed-up at the bare minimum (2 / 2 wei, below the base fee) fails the suggestion pin',
      pendingSrc.includes(CHOOSE) && PRIORITY_CHOICE.test(pendingSrc) &&
        bareQuote.maxFeePerGas === 2n && bareQuote.maxPriorityFeePerGas === 2n && !includable(bareQuote, BASE, PRIORITY),
      `${bareQuote.maxFeePerGas}/${bareQuote.maxPriorityFeePerGas}`);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }

  // Wiring (source): only the Send screen's regular-account native and token
  // branches ask for it; the sent quote turns it off; the confirm shows the
  // warning and the exact fees; Settings renders the switch on test networks only.
  const sendScreen = readFileSync(join(HERE_M, '../src/screens/SendScreen.tsx'), 'utf8');
  // The Review quote's branches (the Max handler above it has the same shape, so search from the AA branch on).
  const aaAt = sendScreen.indexOf('      } else if (aaActive) {');
  const tokenAt = sendScreen.indexOf('      } else if (token) {', aaAt);
  const nativeAt = sendScreen.indexOf("      } else if (start.network.kind === 'evm-jsonrpc') {", tokenAt);
  const solanaAt = sendScreen.indexOf("      } else if (start.network.kind === 'solana-jsonrpc') {", nativeAt);
  const aaBranch = aaAt > 0 && tokenAt > aaAt ? sendScreen.slice(aaAt, tokenAt) : '';
  const tokenBranch = nativeAt > tokenAt ? sendScreen.slice(tokenAt, nativeAt) : '';
  const nativeBranch = solanaAt > nativeAt ? sendScreen.slice(nativeAt, solanaAt) : '';
  check('Send: the native EOA quote passes minimumFee from the armed state for the active network',
    nativeBranch.includes('const minimumFee = minimumFeeRehearsalArmed(evmChain.caip2);') && nativeBranch.includes('...(minimumFee ? { minimumFee } : {}),'));
  check('Send: the token EOA quote is re-priced only when armed',
    tokenBranch.includes('const rehearse = minimumFeeRehearsalArmed(evmChain.caip2);') && tokenBranch.includes('repriceTokenQuoteAtMinimumFee(ep.url, tokenQuote, { to: tokenQuote.contract, value: 0n, data: tokenQuote.data })'));
  check('Send: the smart-account branch and the NFT branch never read the option',
    aaBranch.length > 0 && !/minimumFee|MinimumFee/.test(aaBranch) && (sendScreen.match(/minimumFeeRehearsalArmed\(/g) ?? []).length === 2 && (sendScreen.match(/repriceTokenQuoteAtMinimumFee\(/g) ?? []).length === 1);
  const successAt = sendScreen.indexOf('      setResult(sent);');
  const consumeAt = sendScreen.indexOf('      consumeMinimumFeeRehearsal(quote);');
  check('Send: the option is consumed exactly once, right after a regular-account send succeeded (never on the error path)',
    (sendScreen.match(/consumeMinimumFeeRehearsal\(/g) ?? []).length === 1 && successAt > 0 && consumeAt > successAt && consumeAt < sendScreen.indexOf('    } catch (e) {', successAt));
  check('Send: both regular-account confirms show the warning and the exact-fee line on a rehearsal quote',
    (sendScreen.match(/<WarningBox>\{MINIMUM_FEE_REHEARSAL_WARNING\}<\/WarningBox>/g) ?? []).length === 2 &&
      (sendScreen.match(/\{minimumFeeRehearsalFeeLine\(quote\)\}/g) ?? []).length === 2 &&
      sendScreen.includes("{quote.kind === 'evm' && minimumFeeRehearsalOf(quote) ? (") && sendScreen.includes('{minimumFeeRehearsalOf(quote) ? ('));
  const settingsSrc = readFileSync(join(HERE_M, '../src/screens/SettingsScreen.tsx'), 'utf8');
  // Phase 23 item 8: the label and the hint are shown through the string table (localize).
  const gateOk = (src) => /\{minimumFeeRehearsalOffered\(evmChain\.caip2\) \? \(\s*<>\s*<View style=\{styles\.toggleRow\}>[\s\S]*?\{localize\(MINIMUM_FEE_REHEARSAL_SWITCH_LABEL\)\}[\s\S]*?onValueChange=\{\(v\) => void setMinimumFeeRehearsal\(evmChain\.caip2, v\)\}[\s\S]*?\{localize\(MINIMUM_FEE_REHEARSAL_HINT\)\}<\/Text>\s*<\/>\s*\) : null\}/.test(src) &&
    (src.match(/MINIMUM_FEE_REHEARSAL_SWITCH_LABEL/g) ?? []).length === 3;
  check('Settings → Developer renders the switch and its note only where minimumFeeRehearsalOffered (test networks)', gateOk(settingsSrc));
  const ungated = settingsSrc.replace('{minimumFeeRehearsalOffered(evmChain.caip2) ? (', '{true ? (');
  check('…mutant caught: the switch rendered on every network', ungated !== settingsSrc && !gateOk(ungated));
  const aaSrc = readFileSync(join(HERE_M, '../src/wallet/aa.ts'), 'utf8');
  check('aa.ts (every smart-account quote) never reads the rehearsal', !/MinimumFee|minimumFee/.test(aaSrc));

  unsub();
  evm.setCustomEvmProfiles([]);
}

// ---------------------------------------------------------------------------
console.log('check-pending: spending limits count the fee, never the value');
// ---------------------------------------------------------------------------
{
  const store = memoryStore();
  const scope = { chain: CHAIN, owner: FROM };
  await saveSpendingPolicy(scope, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 1000n, windowSeconds: 86400, countFees: true }, [NATIVE_TOKEN], { store, now: 1000 });
  const input = replacementSpendingInput({ fee: 500n, from: FROM });
  check('the spending input has no calls (no value) and the full fee', input.calls.length === 0 && input.fee === 500n && input.spender === FROM);
  const ok = await evaluateBeforeSigning({ scope, spender: input.spender, calls: input.calls, fee: input.fee, url: null, store, now: 1001, stage: false });
  check('a replacement of a 10 ETH send under a 1000-wei limit: allowed (the value is not counted)', ok.status === 'allowed', ok.status);
  const overFee = replacementSpendingInput({ fee: 1001n, from: FROM });
  const blocked = await evaluateBeforeSigning({ scope, spender: overFee.spender, calls: overFee.calls, fee: overFee.fee, url: null, store, now: 1001, stage: false });
  check('a replacement whose fee alone exceeds a fee-counting limit is blocked', blocked.status === 'blocked', blocked.status);
  const asSend = await evaluateBeforeSigning({ scope, spender: FROM, calls: [{ to: TO, value: 10n ** 19n }], fee: 500n, url: null, store, now: 1001, stage: false });
  check('control: counting the value (as an ordinary send would) blocks', asSend.status === 'blocked');
}

// ---------------------------------------------------------------------------
console.log('check-pending: smart-account operations');
// ---------------------------------------------------------------------------
{
  check('the sentence says the wallet cannot replace it and why', SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE.startsWith('A smart-account operation cannot be sped up or cancelled from this wallet.') && /same bundler/.test(SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE) && /at least 10% higher/.test(SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE) && /does not attempt/.test(SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE));
  const record = { userOpHash: H(77), sentAt: T0 };
  const calls = [];
  const bundler = (answers) => async (method, params) => {
    calls.push(method);
    if (method in answers) {
      const a = answers[method];
      if (a instanceof Error) throw a;
      return a;
    }
    throw new Error(`unexpected ${method}`);
  };
  let s = await checkUserOperation(bundler({ eth_getUserOperationReceipt: { success: true, receipt: { transactionHash: H(78) } } }), record, T0 + 1);
  check('a receipt → included with the bundle transaction', s.state === 'included' && s.success === true && s.txHash === H(78));
  check('… and no replacement method is ever called', !calls.some((m) => m === 'eth_sendUserOperation'));
  s = await checkUserOperation(bundler({ eth_getUserOperationReceipt: null, eth_getUserOperationByHash: { sender: '0x', blockNumber: null } }), record, T0 + USEROP_UNKNOWN_AFTER_MS * 5);
  check('no receipt but the bundler has it → still in the bundler, never "Send again"', s.state === 'in-bundler');
  s = await checkUserOperation(bundler({ eth_getUserOperationReceipt: null, eth_getUserOperationByHash: null }), record, T0 + USEROP_UNKNOWN_AFTER_MS - 1);
  check('no record before 10 minutes → unknown, no resend offered', s.state === 'unknown' && s.resendOffered === false);
  s = await checkUserOperation(bundler({ eth_getUserOperationReceipt: null, eth_getUserOperationByHash: null }), record, T0 + USEROP_UNKNOWN_AFTER_MS);
  check('no record after 10 minutes → "Send again" offered', s.state === 'unknown' && s.resendOffered === true && userOpStatusSentence(s) === USEROP_RESEND_OFFER);
  s = await checkUserOperation(bundler({ eth_getUserOperationReceipt: null, eth_getUserOperationByHash: new Error('method not found') }), record, T0 + USEROP_UNKNOWN_AFTER_MS);
  check('a bundler without eth_getUserOperationByHash counts as no record', s.state === 'unknown' && s.resendOffered === true);

  const native = userOpResendFor({ to: TO, amount: 5n, calls: [{ to: TO, value: 5n }] }, { nativeSymbol: 'test ETH', nativeDecimals: 18, tokenId: null, nft: false });
  check('Send again pre-fill: a plain native transfer', native?.recipient === TO && native.amount === '5' && native.tokenId === null && native.symbol === 'test ETH');
  const token = userOpResendFor({ to: TO, amount: 0n, calls: [{ to: TO, value: 0n, data: new Uint8Array(68) }], token: { contract: TO, recipient: FROM, amount: 1_500_000n, symbol: 'USDC', decimals: 6 } }, { nativeSymbol: 'test ETH', nativeDecimals: 18, tokenId: 'eip155:11155111/erc20:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', nft: false });
  check('Send again pre-fill: a token transfer keeps the token and its recipient', token?.recipient === FROM && token.amount === '1500000' && token.decimals === 6 && token.tokenId?.startsWith('eip155:'));
  check('no pre-fill for an NFT or a batch', userOpResendFor({ to: TO, amount: 1n, calls: [{ to: TO, value: 1n }] }, { nativeSymbol: 'x', nativeDecimals: 18, tokenId: null, nft: true }) === null && userOpResendFor({ to: TO, amount: 2n, calls: [{ to: TO, value: 1n }, { to: TO, value: 1n }] }, { nativeSymbol: 'x', nativeDecimals: 18, tokenId: null, nft: false }) === null);

  const store = memoryStore();
  const ok = await recordPendingUserOperation({ chain: CHAIN, userOpHash: H(77).toUpperCase().replace('0X', '0x'), sender: TO, owner: FROM, resend: native }, store, T0);
  const listed = userOpsFor((await loadPendingRegistry(store)).records, CHAIN, FROM);
  check('a smart-account operation is recorded under its owner (lower-case, time filled in)', ok && listed.length === 1 && listed[0].userOpHash === H(77) && listed[0].sentAt === T0);
  check("a direct record (the Send screen's passkey path) defaults to origin 'send'", listed[0].origin === 'send');
}

// ---------------------------------------------------------------------------
console.log('check-pending: every smart-account path is recorded (phase 20 item 3)');
// ---------------------------------------------------------------------------
{
  const {
    USEROP_DROPPED_SENTENCE,
    USEROP_ORIGINS,
    USEROP_ORIGIN_PHRASES,
    USEROP_RETRY_SENTENCES,
    pendingUserOpRecorder,
    userOpCanBeSentAgain,
    userOpCardTitle,
    userOpOrigin,
  } = pending;
  const native = { recipient: TO, amount: '5', decimals: 18, symbol: 'test ETH', tokenId: null };
  const event = (n, kind, over = {}) => ({
    chain: CHAIN,
    userOpHash: H(n),
    sender: TO,
    owner: FROM,
    bundler: async () => null,
    sentAt: T0 + n,
    kind,
    resend: null,
    ...over,
  });

  // The strict parse: a pre-phase-20 record (no origin) still reads, as 'send'.
  const legacy = { kind: 'userop', chain: CHAIN, userOpHash: H(90), sender: TO, owner: FROM_L, sentAt: T0, resend: null };
  const legacyReg = parseRegistry(JSON.stringify({ version: 1, records: [legacy] }));
  check('a record stored before phase 20 (no origin) still parses, read as from Send', !legacyReg.readOnly && legacyReg.records.length === 1 && userOpOrigin(legacyReg.records[0]) === 'send');
  for (const origin of USEROP_ORIGINS) {
    const r = parseRegistry(JSON.stringify({ version: 1, records: [{ ...legacy, origin }] }));
    if (r.readOnly || r.records.length !== 1) check(`origin ${origin} parses`, false);
  }
  check('every known origin parses (13, incl. phase 21\'s bridge and phase 23\'s cold-aa)', USEROP_ORIGINS.length === 13 && USEROP_ORIGINS.includes('bridge') && USEROP_ORIGINS.includes('cold-aa'));
  check('an unknown origin makes the registry read-only', parseRegistry(JSON.stringify({ version: 1, records: [{ ...legacy, origin: 'teleport' }] })).readOnly);
  check('a non-string origin makes the registry read-only', parseRegistry(JSON.stringify({ version: 1, records: [{ ...legacy, origin: 7 }] })).readOnly);
  check('an extra unknown key still makes it read-only', parseRegistry(JSON.stringify({ version: 1, records: [{ ...legacy, origin: 'swap', bundlerUrl: 'https://x' }] })).readOnly);

  // The recorder WalletContext registers.
  const store = memoryStore();
  const recorder = pendingUserOpRecorder(store);
  const kinds = ['swap', 'staking', 'session-setup', 'recurring-payment', 'dca-swap', 'session-op', 'walletconnect', 'browser', 'multisig', 'bridge', 'other'];
  for (const [i, kind] of kinds.entries()) await recorder(event(200 + i, kind, { resend: native }));
  let ops = userOpsFor((await loadPendingRegistry(store)).records, CHAIN, FROM);
  check('the recorder stores one record per path, each with its origin', ops.length === kinds.length && kinds.every((k) => ops.some((o) => o.origin === k)), ops.map((o) => o.origin).join());
  check('…and keeps a "Send again" pre-fill only for the Send screen (dropped for every other path)', ops.every((o) => o.resend === null));
  check('…under the event owner, sentAt = the event time, no bundler stored', ops.every((o) => o.owner === FROM_L && o.sentAt === T0 + Number(BigInt(o.userOpHash))) && !store.map.get(PENDING_TX_KEY).includes('bundler'));
  await recorder(event(300, 'send', { resend: native }));
  ops = userOpsFor((await loadPendingRegistry(store)).records, CHAIN, FROM);
  check("a Send operation keeps its pre-fill", ops.find((o) => o.userOpHash === H(300))?.resend?.amount === '5');

  // Merge: whichever write lands last, the pre-fill and a specific origin survive.
  const m1 = memoryStore();
  await pendingUserOpRecorder(m1)(event(310, 'send', { resend: native }));
  await recordPendingUserOperation({ chain: CHAIN, userOpHash: H(310), sender: TO, owner: FROM, resend: null, origin: 'other' }, m1, T0);
  let merged = userOpsFor((await loadPendingRegistry(m1)).records, CHAIN, FROM);
  check('a second record of the same operation never drops the pre-fill or the specific origin', merged.length === 1 && merged[0].resend?.amount === '5' && merged[0].origin === 'send');
  await recordPendingUserOperation({ chain: CHAIN, userOpHash: H(310), sender: TO, owner: FROM, resend: null, origin: 'swap' }, m1, T0);
  merged = userOpsFor((await loadPendingRegistry(m1)).records, CHAIN, FROM);
  check('…but a later specific origin replaces an earlier one', merged.length === 1 && merged[0].origin === 'swap');

  // The cap: the listener can never grow the registry past MAX_PENDING_RECORDS.
  const capStore = memoryStore();
  const capRecorder = pendingUserOpRecorder(capStore);
  for (let i = 0; i < MAX_PENDING_RECORDS + 6; i += 1) await capRecorder(event(1000 + i, 'swap'));
  const capped = (await loadPendingRegistry(capStore)).records;
  check('the registry stays capped (oldest operations dropped first)', capped.length === MAX_PENDING_RECORDS && !capped.some((r) => r.userOpHash === H(1000)) && capped.some((r) => r.userOpHash === H(1000 + MAX_PENDING_RECORDS + 5)), String(capped.length));
  check('a malformed event is not recorded', (await pendingUserOpRecorder(memoryStore())(event(5, 'swap', { userOpHash: '0x12' }))) === false);

  // The card: Check status for all, Send again only where a re-quote exists.
  const dropped = { state: 'unknown', resendOffered: true };
  check('Send with a pre-fill: "Send again" and the old offer sentence', userOpCanBeSentAgain({ origin: 'send', resend: native }) && userOpStatusSentence(dropped, { origin: 'send', resend: native }) === USEROP_RESEND_OFFER);
  check('legacy record with a pre-fill: still "Send again"', userOpCanBeSentAgain({ resend: native }));
  for (const kind of kinds) {
    const line = userOpStatusSentence(dropped, { origin: kind, resend: null });
    if (userOpCanBeSentAgain({ origin: kind, resend: native }) || line !== `${USEROP_DROPPED_SENTENCE} ${USEROP_RETRY_SENTENCES[kind]}` || line.includes('Send screen opens')) {
      check(`no Send again for ${kind}; the line says where to retry`, false, line);
    }
  }
  check('no "Send again" for any non-Send path; each line names where to retry', true);
  check('Send without a pre-fill (an NFT or a batch): no Send again, says to enter it again', !userOpCanBeSentAgain({ origin: 'send', resend: null }) && userOpStatusSentence(dropped, { origin: 'send', resend: null }).endsWith('open Send and enter it again; this operation cannot be filled in again automatically.'));
  check('retry sentences exact (Swap, WalletConnect, browser, multisig)',
    USEROP_RETRY_SENTENCES.swap === 'To try again, open Swap and get a new quote; nothing is resent from here.' &&
    USEROP_RETRY_SENTENCES.walletconnect === 'To try again, ask the app to send the request again; this wallet cannot resend an app’s request from here.' &&
    USEROP_RETRY_SENTENCES.browser === 'To try again, open the app in the in-app browser (Apps) and send it again from there; nothing is resent from here.' &&
    USEROP_RETRY_SENTENCES.multisig === 'To try again, open Multisig and build the operation again; the co-signers approve the new request. Nothing is resent from here.');
  check('pending / included lines are the same for every path', userOpStatusSentence({ state: 'in-bundler' }, { origin: 'swap', resend: null }) === 'The bundler still holds it and has not included it yet.' && userOpStatusSentence({ state: 'unknown', resendOffered: false }, { origin: 'browser', resend: null }).startsWith('The bundler has no record of it right now.'));
  check('card title names the path', userOpCardTitle({ userOpHash: H(200), origin: 'swap', resend: null }) === `Smart-account operation ${shortHashOf(H(200))} from Swap.` &&
    userOpCardTitle({ userOpHash: H(201), origin: 'browser', resend: null }) === `Smart-account operation ${shortHashOf(H(201))} requested by an app in the in-app browser.` &&
    userOpCardTitle({ userOpHash: H(202), origin: 'other', resend: null }) === `Smart-account operation ${shortHashOf(H(202))}.`);
  check('a bridge operation (Bridge screen, phase 21): its title and its retry sentence (exact)',
    userOpCardTitle({ userOpHash: H(204), origin: 'bridge', resend: null }) === `Smart-account operation ${shortHashOf(H(204))} from Bridge.` &&
      USEROP_RETRY_SENTENCES.bridge === 'To try again, open Bridge and get a new quote; nothing is resent from here.' &&
      userOpStatusSentence(dropped, { origin: 'bridge', resend: null }) === `${USEROP_DROPPED_SENTENCE} To try again, open Bridge and get a new quote; nothing is resent from here.`);
  check('card title keeps the Send wording with a pre-fill', userOpCardTitle({ userOpHash: H(203), origin: 'send', resend: native }) === `Smart-account operation ${shortHashOf(H(203))}: 0.000000000000000005 test ETH to ${TO}.`);
  check('every path has a phrase entry and a retry sentence', USEROP_ORIGINS.every((k) => typeof USEROP_ORIGIN_PHRASES[k] === 'string' && USEROP_RETRY_SENTENCES[k].length > 20));
}

// ---------------------------------------------------------------------------
console.log('check-pending: user-facing copy');
// ---------------------------------------------------------------------------
{
  check('cancel explainer says it can fail', CANCEL_EXPLAINER.includes('if the original is included first, the cancellation is rejected'));
  check('the cancel risk line calls the recipient "yourself"', cancelRiskLine(FROM) === `This cancellation sends 0 to yourself (${FROM}), the account it comes from. Only the network fee is paid.`);
}

// ---------------------------------------------------------------------------
console.log('check-pending: the screens wire the gates in order (source)');
// ---------------------------------------------------------------------------
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const view = readFileSync(join(HERE, '../src/components/PendingTransactions.tsx'), 'utf8');
  const approve = view.slice(view.indexOf('const approve = async'), view.indexOf('const checkOp = async'));
  const order = ['quoteEndpointChange(', 'checkReplacementBeforeApproval(', 'evaluateBeforeSigning(', 'confirmSpendingCheck(', 'requireLocalAuth(replacementPromptTitle(action))', 'signWith(', 'sendEvmReplacement(', 'recordAcceptedSpend('];
  const at = order.map((t) => approve.indexOf(t));
  check('Approve: endpoint pinning → still pending + fees → spending limits → device check (titled) → sign → record the fee', at.every((i) => i >= 0) && at.every((i, k) => k === 0 || i > at[k - 1]), at.join());
  check('the spending check passes no URL (no simulation of the value) and the replacement input', /calls: input\.calls,\s*fee: input\.fee,\s*url: null/.test(approve));
  check('Approve is disabled while the pre-flight fails', /disabled=\{!q\.simulation\.ok\}/.test(view));
  check('the cancel confirm shows the "yourself" line, a speed-up the risk card', view.includes('cancelRiskLine(from)') && view.includes('<RiskWarnings url={s.url} wallet={from} to={q.to} data={q.data} />'));
  check('smart-account rows show the sentence and Check status, never a replacement', view.includes('{SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE}') && view.includes('title="Check status"') && !/sendUserOperation/.test(view));
  check('Send again asks the bundler once more first', /const sendAgain = async[\s\S]*checkUserOperation\([\s\S]*onSendAgain\?\.\(record\)/.test(view));
  // Pass p20b finding 10: after "Included in transaction …" the card kept
  // the "cannot be sped up or cancelled…" paragraph, which only applies
  // while the operation may still be pending.
  const show = pending.userOpShowsNoReplacementSentence;
  check('the no-replacement paragraph shows before a status read, while in the bundler and while unknown',
    show(null) && show(undefined) && show({ state: 'in-bundler' }) && show({ state: 'unknown', resendOffered: false }) && show({ state: 'unknown', resendOffered: true }));
  check('…and is dropped once the status reads "Included …" (succeeded or reverted)',
    !show({ state: 'included', success: true, txHash: H(78) }) && !show({ state: 'included', success: false, txHash: null }));
  const gatedOk = (src) => /\{userOpShowsNoReplacementSentence\(status\) \? \(\s*<Text[^>]*>\{SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE\}<\/Text>\s*\) : null\}/.test(src) &&
    (src.match(/\{SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE\}/g) ?? []).length === 1;
  check('the card renders the paragraph only through that rule (source)', gatedOk(view));
  const oldView = view.replace(/\{userOpShowsNoReplacementSentence\(status\) \? \(\s*(<Text[^>]*>\{SMART_ACCOUNT_NO_REPLACEMENT_SENTENCE\}<\/Text>)\s*\) : null\}/, '$1');
  check('mutant caught: the paragraph shown unconditionally (the old card)', oldView !== view && !gatedOk(oldView));
  const sendScreen = readFileSync(join(HERE, '../src/screens/SendScreen.tsx'), 'utf8');
  check('Send success view offers it for the transaction just sent', sendScreen.includes('<PendingTransactionsSection from={quotedFrom} onlyHash={result.txid} />'));
  check('the passkey submit path remembers the operation itself (origin send)', (sendScreen.match(/rememberUserOperation\(quote, userOpHash\)/g) ?? []).length === 1 && sendScreen.includes("origin: 'send',"));
  check('the sendAa submit path hands its pre-fill to the shared listener', sendScreen.includes("sendAa(bundle, signer, quote, { kind: 'send', resend: resendFor(quote) })"));
  check('Activity cards: the path title, the per-path status line, Send again only where a re-quote exists',
    view.includes('{userOpCardTitle(record)}') && view.includes('userOpStatusSentence(status, record)') && view.includes('userOpCanBeSentAgain(record) && onSendAgain'));
  // Pass p20d finding 7: a card title can carry a full 42-character
  // recipient (a multisig's address); it is spoken short, shown in full.
  const { withShortAddresses } = await import('../src/a11y.ts');
  const { userOpCardTitle: cardTitle } = await import('../src/wallet/pending-transactions.ts');
  const MULTISIG = '0x944caA404e389b18b2fe251e969EdD7A220d0d38';
  const multisigTitle = cardTitle({ userOpHash: H(204), origin: 'send', resend: { recipient: MULTISIG, amount: '5', decimals: 18, symbol: 'test ETH', tokenId: null } });
  check('the card title with a multisig recipient is spoken with the short address and nothing else changed (exact)',
    withShortAddresses(multisigTitle) === `Smart-account operation ${shortHashOf(H(204))}: 0.000000000000000005 test ETH to 0x944c…0d38.` && multisigTitle.includes(MULTISIG));
  const spokenOk = (src) =>
    src.includes('<Text accessibilityLabel={withShortAddresses(userOpCardTitle(record))} style={[styles.text, { color: theme.text }]}>') &&
    src.includes('accessibilityLabel={withShortAddresses(pendingGroupSentence(group, { nativeSymbol: symbol, nowMs, tokens: lineTokens }))}');
  check('the user-operation card title and the pending-transaction sentence are spoken through withShortAddresses (source)', spokenOk(view));
  check('…mutant caught: the title spoken in full again',
    !spokenOk(view.replace('<Text accessibilityLabel={withShortAddresses(userOpCardTitle(record))} style=', '<Text style=')));
  const activity = readFileSync(join(HERE, '../src/screens/ActivityScreen.tsx'), 'utf8');
  check('Activity shows the section in the list, the unavailable and the error states', (activity.match(/\{pendingSection\}/g) ?? []).length === 3 && activity.includes('replacementRowLine(pendingRecords'));
  // Pass p22b: a stuck cold-signed transaction could not be sped up or
  // cancelled once its success view was closed, because Activity hid this
  // section for a watch-only account. It is shown for a watch-only account
  // now (a multisig still sends nothing through sendEvm), and its Speed up /
  // Cancel open the cold-signing screen in replacement mode — the same
  // component and routing the cold success view uses.
  const pendingCond = (src) => /const pendingSection =\s*isEvmSlot && account && activeAccount\?\.multisig !== true \? \(\s*<PendingTransactionsSection/.test(src);
  check('p22b: Activity shows "Pending on this phone" for a watch-only account (only a multisig is left out)', pendingCond(activity));
  check('…mutant caught: the old condition that hid it for a watch-only account',
    !pendingCond(activity.replace('isEvmSlot && account && activeAccount?.multisig !== true ? (', 'isEvmSlot && account && activeAccount?.watchOnly !== true && activeAccount?.multisig !== true ? (')));
  check('…its Speed up and Cancel route a watch-only account to the cold-signing screen in replacement mode (as the cold success view, the same component)',
    view.includes('const coldReplace = activeAccount?.watchOnly === true;') &&
      view.includes("? navigation.navigate('ColdSign', { replace: { hash: group.latest.hash, action: 'speed-up' } })") &&
      view.includes("? navigation.navigate('ColdSign', { replace: { hash: group.latest.hash, action: 'cancel' } })") &&
      readFileSync(join(HERE, '../src/screens/ColdSignScreen.tsx'), 'utf8').includes('<PendingTransactionsSection from={from} onlyHash={result.txid} />'));
  // A wipe forgets the registry with the rest of the wallet's on-device state (CTO, phase 19 item 3).
  const walletContext = readFileSync(join(HERE, '../src/wallet/WalletContext.tsx'), 'utf8');
  check('WalletContext registers the pending recorder once on the operation-sent channel', (walletContext.match(/addAaOperationSentListener\(pendingUserOpRecorder\(AsyncStorage\)\)/g) ?? []).length === 1);
  check('the wallet wipe resets the pending-transaction registry', walletContext.includes("import { pendingUserOpBroadcastRecorder, pendingUserOpRecorder, resetPendingRegistry } from './pending-transactions';") && walletContext.includes('await resetPendingRegistry(AsyncStorage).catch(() => undefined);'));
}

// ---------------------------------------------------------------------------
console.log('check-pending: a broadcast refused for its fee is said plainly (pass p21e finding A2)');
// ---------------------------------------------------------------------------
{
  const RAW = 'RPC error -32000: transaction underpriced (eth_sendRawTransaction)';
  const sentence =
    'The network endpoint refused this transaction because its fee is below what that node accepts ' +
    '("transaction underpriced"). Nothing was sent. Try again, or review the transaction again for a fresh fee.';
  const note =
    'The minimum-fee rehearsal is still on and this screen still holds its quote: approve again to retry, ' +
    'or go back and turn the rehearsal off in Settings → Developer to send at the usual fee.';
  check('the exact sentences', send.TX_UNDERPRICED_TITLE === 'The network endpoint refused the fee.' && send.TX_UNDERPRICED_SENTENCE === sentence && send.TX_UNDERPRICED_REHEARSAL_NOTE === note);
  const d = send.describeSendError(new Error(RAW), 'test ETH', 'test ETH');
  check('the live p21e refusal: plain title, the sentence, then the technical line', d.title === send.TX_UNDERPRICED_TITLE && d.detail === `${sentence}\n\nTechnical detail: ${RAW}`, JSON.stringify(d));
  const dr = send.describeSendError(new Error(RAW), 'test ETH', 'test ETH', { minimumFeeRehearsal: true });
  check('a minimum-fee rehearsal adds that the option stays on', dr.detail === `${sentence} ${note}\n\nTechnical detail: ${RAW}`);
  for (const raw of [
    'transaction underpriced: gas tip cap 0, minimum needed 1',
    'gas tip cap 0, minimum needed 1',
    'max fee per gas less than block base fee: address 0x772e, maxFeePerGas: 1, baseFee: 15',
  ]) {
    check(`matched: "${raw}"`, send.describeSendError(new Error(raw), 'ETH').title === send.TX_UNDERPRICED_TITLE);
  }
  const REPL = 'RPC error -32000: replacement transaction underpriced (eth_sendRawTransaction)';
  const rd = send.describeSendError(new Error(REPL), 'test ETH', 'test ETH', { minimumFeeRehearsal: true });
  check('"replacement transaction underpriced" gets its own sentence (no rehearsal note)',
    rd.title === 'Another transaction with the same nonce is waiting.' &&
      rd.detail ===
        'The network endpoint refused this transaction because it already holds a pending transaction from this ' +
          "account with the same nonce, and this one's fee is not high enough to replace it (\"replacement " +
          'transaction underpriced"). Nothing was sent. Wait for the pending transaction to be included, or speed it ' +
          `up or cancel it from Activity.\n\nTechnical detail: ${REPL}`, JSON.stringify(rd));
  // Every other error is worded exactly as before.
  for (const raw of ['RPC error -32000: nonce too low (eth_sendRawTransaction)', 'RPC error -32000: already known', 'execution reverted', 'underpriced']) {
    const x = send.describeSendError(new Error(raw), 'ETH');
    check(`unchanged: "${raw}"`, x.title === 'The transaction could not be sent.' && x.detail === raw, JSON.stringify(x));
  }
  check('unchanged: an insufficient-funds refusal keeps its fee title', send.describeSendError(new Error('insufficient funds for gas * price + value'), 'test ETH', 'test ETH').title === 'Not enough test ETH to pay the network fee.');
  const sendSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/screens/SendScreen.tsx'), 'utf8');
  check('the Send screen passes the rehearsal flag at the broadcast catch (source)',
    sendSrc.includes('?? describeError(e, minimumFeeRehearsalOf(quote) !== null);') &&
      sendSrc.includes('describeSendError(e, symbol, evmChain.displaySymbol, { minimumFeeRehearsal })'));
  const sendTs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/wallet/send.ts'), 'utf8');
  check('a replacement refused as underpriced keeps its own plain sentence (sendEvmReplacement)',
    sendTs.includes('if (/underpriced/i.test(message)) throw new ReplacementRefusedError(REPLACEMENT_UNDERPRICED_SENTENCE, message);'));
}

// ---------------------------------------------------------------------------
console.log('check-pending: the section after a replacement is sent (pass p21g: the card vanished until a pull-to-refresh)');
// ---------------------------------------------------------------------------
{
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { resolve: resolvePath } = await import('node:path');
  const HERE_S = dirname(fileURLToPath(import.meta.url));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const gate = () => {
    let open;
    const p = new Promise((r) => {
      open = r;
    });
    return { p, open };
  };
  // A store whose next write can be made to fail (a settle that is not stored).
  const flakyStore = () => {
    const base = memoryStore();
    return {
      ...base,
      failNext: false,
      async setItem(k, v) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('storage full');
        }
        return base.setItem(k, v);
      },
    };
  };
  // Neither a card nor a notice for nonce 5 while its records are stored is the gap.
  const gapIn = (views) => views.filter((v) => v.groups.length === 0 && v.notices.length === 0 && v.registry.records.some((r) => r.kind === 'tx' && r.nonce === '5'));

  const run = async (mod) => {
    const store = flakyStore();
    const ORIG = H(0x5001);
    await mod.recordPendingTransaction(rec(5, { hash: ORIG }), store);
    const node = fakeNode({ latestNonce: 5n, pendingNonce: 6n });
    node.state.txs.set(ORIG, null);
    const views = [];
    let readerGate = null;
    const refresher = mod.createPendingSectionRefresher({
      chain: CHAIN,
      from: FROM,
      store,
      now: () => T0 + 10_000,
      reader: async () => {
        if (readerGate) await readerGate.p;
        return mod.nodeReader(node.transport);
      },
      apply: (v) => views.push(v),
    });
    await refresher.refresh();
    const before = views.at(-1);
    // Broadcast the speed-up through the real send path (it records it).
    const group = mod.nonceGroups((await mod.loadPendingRegistry(store)).records, CHAIN, FROM)[0];
    const quote = await send.prepareEvmReplacement(URL, group, 'speed-up', CHAIN, { transport: node.transport });
    const sent = await send.sendEvmReplacement(URL, signer, quote, null, { transport: node.transport, store, now: () => T0 + 20_000 });
    node.state.txs.set(sent.txid, null);
    // The re-read right after the broadcast, with the network not answering yet.
    readerGate = gate();
    const drawnBefore = views.length;
    const first = refresher.refresh();
    for (let i = 0; i < 20 && views.length === drawnBefore; i++) await tick();
    const atOnce = views.length > drawnBefore ? views.at(-1) : null;
    readerGate.open();
    readerGate = null;
    await first;
    const waiting = views.at(-1);
    // The 15-second poll after a block included the replacement; the first
    // poll's settle is not stored, the next one's is.
    node.state.receipts.set(sent.txid, { block: 90n });
    node.state.txs.set(sent.txid, 90n);
    node.state.txs.delete(ORIG);
    node.state.latestNonce = 6n;
    store.failNext = true;
    const polled = views.length;
    await refresher.refresh();
    const afterFailedSettle = views.slice(polled);
    await refresher.refresh();
    const final = views.at(-1);
    return { before, sent, atOnce, waiting, afterFailedSettle, final, views, ORIG };
  };

  const r = await run(pending);
  check('before the speed-up: one card, the original read as pending', r.before.groups.length === 1 && r.before.groups[0].status?.state === 'pending' && pending.replacementWaitingSentence(r.before.groups[0].group) === null);
  const g = r.atOnce?.groups[0];
  check('right after the broadcast, BEFORE the network answers, the card shows the replacement (both broadcasts, the new one newest, its status not read yet)',
    r.atOnce !== null && r.atOnce.groups.length === 1 && g.group.txs.length === 2 && g.group.latest.hash === r.sent.txid && g.status === null && r.atOnce.notices.length === 0,
    JSON.stringify(r.atOnce?.groups.map((x) => [x.group.txs.length, x.status])));
  const line = g ? pending.replacementWaitingSentence(g.group) : null;
  check('…with the waiting line naming both hashes and the nonce (exact)',
    line === `Speed-up sent: ${shortHashOf(r.sent.txid)} replaces ${shortHashOf(r.ORIG)} (nonce 5). Waiting for a block to include one of them; this list checks again every 15 seconds and then says which one was included.`,
    String(line));
  check('…then the network answer: still pending, read for the replacement', r.waiting.groups.length === 1 && r.waiting.groups[0].status?.state === 'pending' && r.waiting.groups[0].group.latest.hash === r.sent.txid);
  check('the poll that finds the replacement included but cannot store the result keeps the card (status "mined", its own line), never a view with neither card nor notice',
    r.afterFailedSettle.length > 0 && r.afterFailedSettle.every((v) => v.groups.length === 1 || v.notices.length === 1) &&
      r.afterFailedSettle.at(-1).groups[0]?.status?.state === 'mined' &&
      pending.minedNotRecordedSentence(r.afterFailedSettle.at(-1).groups[0].status) === `A block included transaction ${shortHashOf(r.sent.txid)} (block 90). This list records the result on its next check.`,
    JSON.stringify(r.afterFailedSettle.map((v) => [v.groups.length, v.notices.length])));
  check('the next poll stores the result: the card leaves and the "Sped up" notice appears in the SAME draw, no reload',
    r.final.groups.length === 0 && r.final.notices.length === 1 && r.final.notices[0].outcome === 'replaced' && r.final.notices[0].minedHash === r.sent.txid &&
      resolvedSentence(r.final.notices[0]) === `Sped up: transaction ${shortHashOf(r.ORIG)} (nonce 5) was replaced by ${shortHashOf(r.sent.txid)}, included in block 90.`,
    JSON.stringify([r.final.groups.length, r.final.notices.length]));
  check('in the whole sequence there is no draw with neither the card nor the notice while the nonce is stored', gapIn(r.views).length === 0);

  // Refreshes that overlap: an older network answer is never drawn over a newer one.
  {
    const store = memoryStore();
    const ORIG = H(0x5101);
    await recordPendingTransaction(rec(5, { hash: ORIG }), store);
    const stale = fakeNode({ latestNonce: 5n });
    stale.state.txs.set(ORIG, null);
    const fresh = fakeNode({ latestNonce: 6n });
    fresh.state.receipts.set(ORIG, { block: 91n });
    const slow = gate();
    const views = [];
    let calls = 0;
    const refresher = pending.createPendingSectionRefresher({
      chain: CHAIN,
      from: FROM,
      store,
      now: () => T0,
      reader: async () => {
        calls += 1;
        if (calls === 1) {
          // The first refresh's endpoint answers late, with what it saw before the block.
          return nodeReader(async (m, params) => {
            await slow.p;
            return stale.transport(m, params);
          });
        }
        return nodeReader(fresh.transport);
      },
      apply: (v) => views.push(v),
    });
    const a = refresher.refresh();
    for (let i = 0; i < 20 && calls === 0; i++) await tick();
    await refresher.refresh();
    const drawnAfterB = views.length;
    const bView = views.at(-1);
    slow.open();
    await a;
    check('overlapping refreshes: the later one draws the included transaction (no card; a plain send keeps no notice)', bView.groups.length === 0 && bView.registry.records.length === 0);
    check('…and the earlier one, answering late with "pending", draws nothing over it', views.length === drawnAfterB, `${views.length} vs ${drawnAfterB}`);
  }

  // The component draws through the refresher and renders the new lines (source).
  const pcs = readFileSync(join(HERE_S, '../src/components/PendingTransactions.tsx'), 'utf8');
  check('the section re-reads through createPendingSectionRefresher (no own copy of the old two-step refresh)',
    pcs.includes('createPendingSectionRefresher({') && pcs.includes('const refresh = useCallback(() => refresher.refresh(), [refresher]);') &&
      !pcs.includes('refreshAccountPending(') && !/results\.filter\(\(r\) => r\.status\.state !== 'mined'\)/.test(pcs));
  check('the card renders the waiting line and the included-not-yet-recorded line',
    pcs.includes("{replacementWaitingSentence(group) && status?.state !== 'mined' ? (") && pcs.includes('{minedNotRecordedSentence(status)}'));

  // Mutants of pending-transactions.ts, run through the same sequence.
  const pendingSrc = readFileSync(join(HERE_S, '../src/wallet/pending-transactions.ts'), 'utf8');
  const toUrls = (src) => src.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolvePath(join(HERE_S, '../src/wallet'), spec)).href}'`);
  const mutantDir = join(HERE_S, `.mutants-pending-section-${process.pid}`);
  mkdirSync(mutantDir, { recursive: true });
  try {
    const FINAL = '      draw(pendingSectionView(after, options.chain, options.from, results));';
    const GAP = "      draw({ ...pendingSectionView(after, options.chain, options.from, results), groups: results.filter((x) => x.status.state !== 'mined').map((x) => ({ group: x.group, status: x.status })) });";
    const gapFile = join(mutantDir, 'pending-gap.ts');
    writeFileSync(gapFile, toUrls(pendingSrc.replace(FINAL, GAP)));
    const gapMod = await import(pathToFileURL(gapFile).href);
    const gr = await run(gapMod);
    check('MUTANT caught: the old step order (drop "mined" groups, then read the notice) leaves a draw with neither card nor notice when the settle is not stored',
      pendingSrc.includes(FINAL) && gapIn(gr.views).length > 0, String(gapIn(gr.views).length));

    const FIRST = '        draw(pendingSectionView(registry, options.chain, options.from, shown));';
    const lateFile = join(mutantDir, 'pending-no-first-draw.ts');
    writeFileSync(lateFile, toUrls(pendingSrc.replace(FIRST, '        void shown;')));
    const lateMod = await import(pathToFileURL(lateFile).href);
    const lr = await run(lateMod);
    check('MUTANT caught: without the first draw from the registry the replacement is not shown until the network answers',
      pendingSrc.includes(FIRST) && lr.atOnce === null);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

console.log(`\ncheck-pending: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

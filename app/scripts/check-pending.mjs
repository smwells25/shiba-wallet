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
  check('a notice older than a day is pruned', pruneRecords([resolved(1, now - RESOLVED_KEEP_MS - 1), resolved(2, now - 5)], now).length === 1);
  const many = [];
  for (let i = 0; i < MAX_PENDING_RECORDS; i++) many.push(rec(i, { hash: H(5000 + i), sentAt: now - 1000 + i }));
  const withNotice = pruneRecords([resolved(3, now - 10), ...many], now);
  check(`over the cap (${MAX_PENDING_RECORDS}) the resolved notice goes first`, withNotice.length === MAX_PENDING_RECORDS && withNotice.every((x) => x.kind === 'tx'));
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
  check('every known origin parses', USEROP_ORIGINS.length === 11);
  check('an unknown origin makes the registry read-only', parseRegistry(JSON.stringify({ version: 1, records: [{ ...legacy, origin: 'teleport' }] })).readOnly);
  check('a non-string origin makes the registry read-only', parseRegistry(JSON.stringify({ version: 1, records: [{ ...legacy, origin: 7 }] })).readOnly);
  check('an extra unknown key still makes it read-only', parseRegistry(JSON.stringify({ version: 1, records: [{ ...legacy, origin: 'swap', bundlerUrl: 'https://x' }] })).readOnly);

  // The recorder WalletContext registers.
  const store = memoryStore();
  const recorder = pendingUserOpRecorder(store);
  const kinds = ['swap', 'staking', 'session-setup', 'recurring-payment', 'dca-swap', 'session-op', 'walletconnect', 'browser', 'multisig', 'other'];
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
    src.includes('accessibilityLabel={withShortAddresses(pendingGroupSentence(group, { nativeSymbol: symbol, nowMs }))}');
  check('the user-operation card title and the pending-transaction sentence are spoken through withShortAddresses (source)', spokenOk(view));
  check('…mutant caught: the title spoken in full again',
    !spokenOk(view.replace('<Text accessibilityLabel={withShortAddresses(userOpCardTitle(record))} style=', '<Text style=')));
  const activity = readFileSync(join(HERE, '../src/screens/ActivityScreen.tsx'), 'utf8');
  check('Activity shows the section in the list, the unavailable and the error states', (activity.match(/\{pendingSection\}/g) ?? []).length === 3 && activity.includes('replacementRowLine(pendingRecords'));
  // A wipe forgets the registry with the rest of the wallet's on-device state (CTO, phase 19 item 3).
  const walletContext = readFileSync(join(HERE, '../src/wallet/WalletContext.tsx'), 'utf8');
  check('WalletContext registers the pending recorder once on the operation-sent channel', (walletContext.match(/addAaOperationSentListener\(pendingUserOpRecorder\(AsyncStorage\)\)/g) ?? []).length === 1);
  check('the wallet wipe resets the pending-transaction registry', walletContext.includes("import { pendingUserOpRecorder, resetPendingRegistry } from './pending-transactions';") && walletContext.includes('await resetPendingRegistry(AsyncStorage).catch(() => undefined);'));
}

console.log(`\ncheck-pending: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

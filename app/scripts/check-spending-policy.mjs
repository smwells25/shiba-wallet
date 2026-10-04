// Exercises the app-enforced spending policy (src/wallet/spending-policy.ts)
// entirely OFFLINE: an in-memory key-value store stands in for AsyncStorage
// and a fake JSON-RPC node behind global fetch answers eth_simulateV1 and
// eth_sendRawTransaction. Covers the store and its validation refusals
// (through the engine's validateSpendingPolicy), history appended only for
// sends the node or bundler accepted, window pruning, the block / override
// decision with exact bigint math at the boundary (the engine's
// evaluateSpendingPolicy), the preview-outflow path against the quote path,
// fee exclusion by default, and the Hide-amounts masking of the readouts.
// Nothing is broadcast anywhere; the signer is the public BIP-39 test
// mnemonic ("abandon ... about").
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-spending-policy.mjs

import { AbiCoder, zeroPadValue } from 'ethers';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  NATIVE_TRANSFER_PSEUDO_ADDRESS,
  SPENDING_LIMIT_NATIVE_TOKEN,
  TRANSFER_EVENT_TOPIC,
  encodeErc20Approve,
  encodeErc20Transfer,
  toBytes,
} from '@shiba-wallet/chains-evm';
import {
  MAX_SPENDING_POLICIES,
  NATIVE_TOKEN,
  SPENDING_BLOCK_TITLE,
  SPENDING_HONESTY_SENTENCE,
  SPENDING_OVERRIDE_ALLOWED_SENTENCE,
  SPENDING_OVERRIDE_OFF_SENTENCE,
  SPENDING_QUOTE_BASIS_NOTE,
  SPENDING_SECTION_TITLE,
  SPENDING_UNREADABLE_MESSAGE,
  SpendingStoreError,
  aaSentRecorder,
  clearStagedSpends,
  evaluateBeforeSigning,
  flushSpendingWrites,
  installSpendingRecorder,
  listSpendRecords,
  listSpendingPolicies,
  listSpendingScopes,
  mergeOutflowsMax,
  outflowsFromCalls,
  overLimitPreviewLines,
  overLimitSentence,
  parseCustomWindow,
  policyLooseningReasons,
  SPENDING_LOOSEN_PROMPT,
  SPENDING_REMOVE_PROMPT,
  SPENDING_RESET_PROMPT,
  policySummary,
  pruneRecords,
  recordAcceptedSpend,
  removeSpendingPolicy,
  resetSpendingLimits,
  saveSpendingPolicy,
  spendingInputForQuote,
  spendingReadouts,
  spendingTokenOptions,
  spentReadoutText,
  windowLabel,
} from '../src/wallet/spending-policy.ts';
import { sendEvm } from '../src/wallet/send.ts';
import { USDC_MAINNET } from '../src/wallet/erc20.ts';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail !== '' ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}` : ''}`);
  }
}

async function rejects(name, fn, pattern) {
  try {
    await fn();
    check(name, false, 'expected a rejection');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, pattern.test(message), message);
  }
}

function memoryStore() {
  const map = new Map();
  return {
    map,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => {
      map.set(k, v);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const signer = evmKeyProvider.deriveAccount(seed, 0, 0);
const OWNER = signer.address; // 0x9858EfFD232B4033E47d90003D41EC34EcaEda94
const SMART = '0xB67b8b7cCA718EAC64d2b59ba568585A9FC69a42';
const TO = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const DEX = '0x1111111111111111111111111111111111111111';
const SEPOLIA = 'eip155:11155111';
const SEP_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const SEP_EURC = '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4';
const MAINNET_USDC = USDC_MAINNET.assetId.reference;
const URL = 'https://fake-node.invalid/rpc';
const SCOPE = { chain: SEPOLIA, owner: OWNER };
const KNOWN = [NATIVE_TOKEN, SEP_USDC, SEP_EURC];
const ETH = 10n ** 18n;
const NOW = 1_800_000_000;

const coder = AbiCoder.defaultAbiCoder();
const topicOf = (a) => zeroPadValue(a, 32).toLowerCase();
const word = (v) => coder.encode(['uint256'], [v]);
const log = (address, topics, data) => ({ address: address.toLowerCase(), topics, data });
const okCall = (logs) => ({ returnData: '0x', gasUsed: '0x5208', status: '0x1', logs });

// Fake node: eth_simulateV1 per `sim`, eth_sendRawTransaction per `broadcast`.
let sim = null; // null -> -32601 (unsupported)
let broadcast = { ok: true };
const calls = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  calls.push(body.method);
  const reply = (payload) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, ...payload }) });
  if (body.method === 'eth_simulateV1') {
    if (!sim) return reply({ error: { code: -32601, message: 'Method not found' } });
    return reply({ result: [{ number: '0x1', calls: sim }] });
  }
  if (body.method === 'eth_sendRawTransaction') {
    if (!broadcast.ok) return reply({ error: { code: -32000, message: 'nonce too low' } });
    return reply({ result: '0x' + 'ab'.repeat(32) });
  }
  return reply({ error: { code: -32601, message: `unexpected ${body.method}` } });
};

function evmQuote(overrides = {}) {
  return {
    kind: 'evm',
    to: TO,
    amount: 0n,
    balance: 10n * ETH,
    nonce: 7n,
    chainId: 11155111n,
    gasLimit: 21000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    fee: 21000n * 1_000_000_000n,
    total: 21000n * 1_000_000_000n,
    simulation: { ok: true, returnData: '0x' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
console.log('copy:');
check(
  'honesty sentence exact',
  SPENDING_HONESTY_SENTENCE ===
    'Enforced by this app only. Anyone with your recovery phrase, and keys used outside this app, are not limited.',
);
check('section title exact', SPENDING_SECTION_TITLE === 'Spending limits (this app only)');
check('NATIVE_TOKEN is the engine native token', NATIVE_TOKEN === SPENDING_LIMIT_NATIVE_TOKEN);

// ---------------------------------------------------------------------------
console.log('helpers:');
check('windowLabel 1 h', windowLabel(3600) === '1 hour');
check('windowLabel 24 h', windowLabel(86400) === '24 hours');
check('windowLabel 7 d', windowLabel(604800) === '7 days');
check('windowLabel 30 d', windowLabel(2592000) === '30 days');
check('windowLabel 90 min', windowLabel(5400) === '90 minutes');
check('parseCustomWindow 2 days', parseCustomWindow('2', 'days') === 172800);
check('parseCustomWindow 1 minute (engine minimum)', parseCustomWindow('1', 'minutes') === 60);
await rejects('parseCustomWindow 0 refused', async () => parseCustomWindow('0', 'hours'), /between 1 minute and 366 days/);
await rejects('parseCustomWindow 367 days refused', async () => parseCustomWindow('367', 'days'), /366 days/);
await rejects('parseCustomWindow decimals refused', async () => parseCustomWindow('1.5', 'hours'), /whole number/);

const sepOptions = spendingTokenOptions(SEPOLIA, 'test ETH', [USDC_MAINNET]);
check(
  'Sepolia token options: native + known USDC/EURC, no mainnet USDC',
  JSON.stringify(sepOptions.map((o) => o.symbol)) === JSON.stringify(['test ETH', 'USDC', 'EURC']) &&
    sepOptions[1].token === SEP_USDC,
  sepOptions,
);
const mainOptions = spendingTokenOptions('eip155:1', 'ETH', [USDC_MAINNET]);
check(
  'mainnet token options: native + tracked USDC',
  mainOptions.length === 2 && mainOptions[1].token === MAINNET_USDC && mainOptions[1].decimals === 6,
  mainOptions,
);

// Quote-path decoding.
{
  const r = outflowsFromCalls(
    [
      { to: TO, value: 5n },
      { to: SEP_USDC, value: 0n, data: encodeErc20Transfer(TO, 1234n) },
    ],
    OWNER,
  );
  check(
    'outflowsFromCalls: value + ERC-20 transfer',
    r.unreadable === false &&
      r.outflows.find((o) => o.token === NATIVE_TOKEN)?.amount === 5n &&
      r.outflows.find((o) => o.token === SEP_USDC)?.amount === 1234n,
    r,
  );
  const approve = outflowsFromCalls([{ to: SEP_USDC, value: 0n, data: encodeErc20Approve(DEX, 9n) }], OWNER);
  check('outflowsFromCalls: approve is unreadable, counts nothing', approve.unreadable && approve.outflows.length === 0, approve);
  const tfData = toBytes(
    '0x23b872dd' + coder.encode(['address', 'address', 'uint256'], [OWNER, TO, 77n]).slice(2),
  );
  const tf = outflowsFromCalls([{ to: SEP_USDC, value: 0n, data: tfData }], OWNER);
  check('outflowsFromCalls: transferFrom(spender, …) counts', tf.outflows[0]?.amount === 77n, tf);
  const tfOther = outflowsFromCalls([{ to: SEP_USDC, value: 0n, data: tfData }], TO);
  check('outflowsFromCalls: transferFrom from someone else does not', tfOther.outflows.length === 0, tfOther);
  const merged = mergeOutflowsMax([{ token: NATIVE_TOKEN, amount: 3n }], [{ token: NATIVE_TOKEN, amount: 5n }, { token: SEP_USDC, amount: 1n }]);
  check('mergeOutflowsMax keeps the larger per token', merged.find((o) => o.token === NATIVE_TOKEN)?.amount === 5n && merged.length === 2, merged);
}

// ---------------------------------------------------------------------------
console.log('store round trips:');
let store = memoryStore();
const ethPolicy = await saveSpendingPolicy(
  SCOPE,
  { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 100n, windowSeconds: 86400 },
  KNOWN,
  { store, now: NOW },
);
check('saved policy defaults: override off, fees off', ethPolicy.allowOverride === false && ethPolicy.countFees === false);
const usdcPolicy = await saveSpendingPolicy(
  SCOPE,
  { token: SEP_USDC.toLowerCase(), symbol: 'USDC', decimals: 6, cap: 50_000_000n, windowSeconds: 3600, allowOverride: true },
  KNOWN,
  { store, now: NOW },
);
check('token stored EIP-55', usdcPolicy.token === SEP_USDC, usdcPolicy.token);
{
  const listing = await listSpendingPolicies(SCOPE, store);
  check('two policies listed', listing.policies.length === 2 && !listing.damaged);
  check('cap round-trips as exact bigint', listing.policies[1].cap === 50_000_000n && typeof listing.policies[1].cap === 'bigint');
  const raw = JSON.parse(store.map.get('shiba-wallet.spending-policies.v1'));
  check('stored as versioned JSON with decimal-string caps', raw.version === 1 && Object.values(raw.entries)[0][0].cap === '100');
  const otherScope = await listSpendingPolicies({ chain: 'eip155:1', owner: OWNER }, store);
  check('scopes are separate (mainnet sees none)', otherScope.policies.length === 0);
  const scopes = await listSpendingScopes(store);
  check('listSpendingScopes finds the Sepolia scope', scopes.scopes.length === 1 && scopes.scopes[0].count === 2);
}
{
  const edited = await saveSpendingPolicy(
    SCOPE,
    { id: ethPolicy.id, token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 200n, windowSeconds: 86400 },
    KNOWN,
    { store, now: NOW },
  );
  const listing = await listSpendingPolicies(SCOPE, store);
  check('edit replaces in place (same id, new cap)', edited.id === ethPolicy.id && listing.policies[0].cap === 200n && listing.policies.length === 2);
  // Restore the cap for the decision tests.
  await saveSpendingPolicy(SCOPE, { id: ethPolicy.id, token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 100n, windowSeconds: 86400 }, KNOWN, { store, now: NOW });
}

console.log('validation refusals persist nothing:');
{
  const before = store.map.get('shiba-wallet.spending-policies.v1');
  const base = { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 1n, windowSeconds: 7200 };
  await rejects('zero cap refused (engine)', () => saveSpendingPolicy(SCOPE, { ...base, cap: 0n }, KNOWN, { store }), /cap must be a positive uint256/);
  await rejects('cap above uint256 refused (engine)', () => saveSpendingPolicy(SCOPE, { ...base, cap: 2n ** 256n }, KNOWN, { store }), /cap must be a positive uint256/);
  await rejects('59-second window refused (engine)', () => saveSpendingPolicy(SCOPE, { ...base, windowSeconds: 59 }, KNOWN, { store }), /windowSeconds must be between 60/);
  await rejects('367-day window refused (engine)', () => saveSpendingPolicy(SCOPE, { ...base, windowSeconds: 367 * 86400 }, KNOWN, { store }), /windowSeconds must be between/);
  await rejects('duplicate (token, window) refused (engine)', () => saveSpendingPolicy(SCOPE, { ...base, windowSeconds: 86400 }, KNOWN, { store }), /duplicates an earlier/);
  await rejects('unknown token refused (engine)', () => saveSpendingPolicy(SCOPE, { ...base, token: DEX, symbol: 'X' }, KNOWN, { store }), /is not a known token/);
  await rejects('the account itself refused (engine)', () => saveSpendingPolicy(SCOPE, { ...base, token: OWNER, symbol: 'X' }, [...KNOWN, OWNER], { store }), /the account itself/);
  await rejects('fees on an ERC-20 limit refused (app)', () => saveSpendingPolicy(SCOPE, { ...base, token: SEP_EURC, symbol: 'EURC', decimals: 6, countFees: true }, KNOWN, { store }), /network’s own coin/);
  await rejects('malformed token refused', () => saveSpendingPolicy(SCOPE, { ...base, token: '0x1234' }, KNOWN, { store }), /Choose a token/);
  await rejects('editing a vanished id refused', () => saveSpendingPolicy(SCOPE, { ...base, id: 'nope' }, KNOWN, { store }), /no longer exists/);
  check('store unchanged after every refusal', store.map.get('shiba-wallet.spending-policies.v1') === before);
  const many = memoryStore();
  for (let i = 0; i < MAX_SPENDING_POLICIES; i++) {
    await saveSpendingPolicy(SCOPE, { ...base, windowSeconds: 3600 + i * 60 }, KNOWN, { store: many });
  }
  await rejects(`more than ${MAX_SPENDING_POLICIES} refused (app)`, () => saveSpendingPolicy(SCOPE, { ...base, windowSeconds: 99999 }, KNOWN, { store: many }), /At most 8/);
}

// ---------------------------------------------------------------------------
console.log('decision at the boundary (exact bigint):');
{
  const s = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 100n, windowSeconds: 86400 }, KNOWN, { store: s, now: NOW });
  // 60 already spent inside the window (recorded through the accepted-send path).
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 60n }], fee: 0n, ref: '0x01', store: s, now: NOW - 100 });
  const within = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 40n }], fee: 21n, store: s, now: NOW });
  check('60 spent + 40 proposed = cap 100 → allowed', within.status === 'allowed' && within.results[0].entry.remainingAfter === 0n, within);
  check('decision says client-side', within.decision.enforcement === 'client-side');
  check('no preview URL → quote basis', within.basis === 'quote' && within.note === null);
  const over = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 41n }], fee: 0n, store: s, now: NOW });
  check('60 + 41 > 100 → blocked', over.status === 'blocked' && over.results[0].entry.exceeds, over);
  check('blocked: no override by default', over.overrideAllowed === false);
  check('blocked title', over.title === SPENDING_BLOCK_TITLE);
  const sentence = overLimitSentence(over.results[0].policy, over.results[0].entry);
  check(
    'over-limit sentence exact',
    sentence ===
      'This send would go over your spending limit for test ETH: 0.0000000000000001 test ETH per 24 hours. Already spent in this window: 0.00000000000000006 test ETH; this send: 0.000000000000000041 test ETH.',
    sentence,
  );
  check(
    'blocked message = sentence, honesty, override-off hint',
    over.message === [sentence, SPENDING_HONESTY_SENTENCE, SPENDING_OVERRIDE_OFF_SENTENCE].join('\n\n'),
    over.message,
  );
  // Window edge: a record at exactly now − window is outside (engine: at > now − window).
  const edge = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 100n, windowSeconds: 3600 }, KNOWN, { store: edge, now: NOW });
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 100n }], fee: 0n, ref: '0x02', store: edge, now: NOW - 3600 + 1 });
  const inside = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 1n }], fee: 0n, store: edge, now: NOW });
  check('record at now − window + 1 still counts → blocked', inside.status === 'blocked');
  const outside = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 1n }], fee: 0n, store: edge, now: NOW + 1 });
  check('record at exactly now − window no longer counts → allowed', outside.status === 'allowed', outside);
}

console.log('override semantics:');
{
  const s = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 10n, windowSeconds: 86400, allowOverride: true }, KNOWN, { store: s });
  const one = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 11n }], fee: 0n, store: s, now: NOW });
  check('allowOverride on → overrideAllowed', one.status === 'blocked' && one.overrideAllowed === true);
  check('message ends with the override-allowed sentence', one.message.endsWith(SPENDING_OVERRIDE_ALLOWED_SENTENCE));
  await saveSpendingPolicy(SCOPE, { token: SEP_USDC, symbol: 'USDC', decimals: 6, cap: 5n, windowSeconds: 86400, allowOverride: false }, KNOWN, { store: s });
  const both = await evaluateBeforeSigning({
    scope: SCOPE,
    spender: OWNER,
    calls: [{ to: TO, value: 11n }, { to: SEP_USDC, value: 0n, data: encodeErc20Transfer(TO, 6n) }],
    fee: 0n,
    store: s,
    now: NOW,
  });
  check('two limits exceeded, one without override → no override', both.status === 'blocked' && both.overrideAllowed === false);
  check('both exceeded limits are named', (both.message.match(/This send would go over/g) ?? []).length === 2);
  const onlyEth = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 11n }], fee: 0n, store: s, now: NOW });
  check('only the overridable limit exceeded → override offered', onlyEth.overrideAllowed === true);
}

console.log('fees excluded by default:');
{
  const s = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 100n, windowSeconds: 86400 }, KNOWN, { store: s });
  const r = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 100n }], fee: 5n, store: s, now: NOW });
  check('value = cap with a fee on top → allowed (fee not counted)', r.status === 'allowed' && r.results[0].entry.proposed === 100n, r);
  const ids = (await listSpendingPolicies(SCOPE, s)).policies;
  await saveSpendingPolicy(SCOPE, { id: ids[0].id, token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 100n, windowSeconds: 86400, countFees: true }, KNOWN, { store: s });
  const f = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 100n }], fee: 5n, store: s, now: NOW });
  check('countFees on → fee counted → blocked', f.status === 'blocked' && f.results[0].entry.proposed === 105n, f);
  check('countFees sentence notes the fee', /\(network fee included\)\.$/.test(overLimitSentence(f.results[0].policy, f.results[0].entry)));
  // Fee records: recorded whenever a native policy exists, counted only with countFees.
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 10n }], fee: 7n, ref: '0x03', store: s, now: NOW });
  const recs = (await listSpendRecords(SCOPE, s)).records;
  check('accepted send records transfer + fee', recs.length === 2 && recs.some((x) => x.kind === 'fee' && x.amount === 7n) && recs.some((x) => x.kind === 'transfer' && x.amount === 10n), recs);
  const withFees = await spendingReadouts(SCOPE, { store: s, now: NOW });
  check('readout with countFees includes fee records (17)', withFees.readouts[0].spentInWindow === 17n, withFees.readouts);
  await saveSpendingPolicy(SCOPE, { id: ids[0].id, token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 100n, windowSeconds: 86400, countFees: false }, KNOWN, { store: s });
  const noFees = await spendingReadouts(SCOPE, { store: s, now: NOW });
  check('readout without countFees ignores fee records (10)', noFees.readouts[0].spentInWindow === 10n, noFees.readouts);
}

// ---------------------------------------------------------------------------
console.log('preview path vs quote path:');
{
  const s = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: SEP_USDC, symbol: 'USDC', decimals: 6, cap: 1_000_000n, windowSeconds: 86400 }, KNOWN, { store: s });
  // A dApp call whose calldata the wallet cannot read, but which moves 2 USDC out.
  const opaque = [{ to: DEX, value: 0n, data: toBytes('0xdeadbeef00') }];
  sim = [okCall([log(SEP_USDC, [TRANSFER_EVENT_TOPIC, topicOf(OWNER), topicOf(DEX)], word(2_000_000n))])];
  calls.length = 0;
  const viaPreview = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: opaque, fee: 0n, url: URL, store: s, now: NOW });
  check('preview (eth_simulateV1) sees the hidden USDC outflow → blocked', viaPreview.status === 'blocked' && viaPreview.basis === 'preview', viaPreview);
  check('the check ran the same eth_simulateV1 preview', calls.includes('eth_simulateV1'));
  check('preview basis: no quote-basis note', viaPreview.note === null);
  sim = null; // endpoint answers -32601
  const viaQuote = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: opaque, fee: 0n, url: URL, store: s, now: NOW });
  check('no preview → quote basis, nothing readable → allowed', viaQuote.status === 'allowed' && viaQuote.basis === 'quote', viaQuote);
  check('quote basis with unreadable calldata carries the note', viaQuote.note === SPENDING_QUOTE_BASIS_NOTE);
  // Caller-supplied preview changes are used without a network call.
  calls.length = 0;
  const supplied = await evaluateBeforeSigning({
    scope: SCOPE,
    spender: OWNER,
    calls: opaque,
    fee: 0n,
    previewChanges: [{ type: 'erc20', direction: 'out', token: SEP_USDC, from: OWNER, to: DEX, amount: 3_000_000n, callIndex: 0 }],
    url: URL,
    store: s,
    now: NOW,
  });
  check('supplied previewChanges used, no simulation request', supplied.status === 'blocked' && calls.length === 0 && supplied.outflows[0].amount === 3_000_000n, supplied);
  // A preview can add, never lower: native value 9 vs a preview showing 1.
  const s2 = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 5n, windowSeconds: 86400 }, KNOWN, { store: s2 });
  sim = [okCall([log(NATIVE_TRANSFER_PSEUDO_ADDRESS, [TRANSFER_EVENT_TOPIC, topicOf(OWNER), topicOf(TO)], word(1n))])];
  const lowPreview = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 9n }], fee: 0n, url: URL, store: s2, now: NOW });
  check('preview lower than the value → the value counts (blocked)', lowPreview.status === 'blocked' && lowPreview.results[0].entry.proposed === 9n, lowPreview);
  // Inflows offset outflows of the same token (net, the engine rule).
  sim = [
    okCall([
      log(SEP_USDC, [TRANSFER_EVENT_TOPIC, topicOf(OWNER), topicOf(DEX)], word(2_000_000n)),
      log(SEP_USDC, [TRANSFER_EVENT_TOPIC, topicOf(DEX), topicOf(OWNER)], word(1_500_000n)),
    ]),
  ];
  const net = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: opaque, fee: 0n, url: URL, store: s, now: NOW });
  check('net outflow 0.5 USDC within 1 USDC → allowed', net.status === 'allowed' && net.results[0].entry.proposed === 500_000n, net);
  // Quote outflows from the caller (the swap's sell amount).
  sim = null;
  const swap = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: opaque, fee: 0n, quoteOutflows: [{ token: SEP_USDC, amount: 1_000_001n }], url: URL, store: s, now: NOW });
  check('quoteOutflows (swap sell side) counted on the quote path → blocked', swap.status === 'blocked' && swap.basis === 'quote', swap);
}

console.log('no policy → no work:');
{
  const s = memoryStore();
  calls.length = 0;
  sim = [okCall([])];
  const r = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 1n }], fee: 1n, url: URL, store: s, now: NOW });
  check('no policy → status no-policy, no simulation request', r.status === 'no-policy' && calls.length === 0, r);
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 1n }], fee: 1n, ref: '0x04', store: s, now: NOW });
  check('no policy → nothing recorded', !s.map.has('shiba-wallet.spending-history.v1'));
}

// ---------------------------------------------------------------------------
console.log('history only for accepted sends (sendEvm hook):');
{
  const s = memoryStore();
  clearStagedSpends();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: ETH, windowSeconds: 86400 }, KNOWN, { store: s });
  await saveSpendingPolicy(SCOPE, { token: SEP_USDC, symbol: 'USDC', decimals: 6, cap: 100_000_000n, windowSeconds: 86400 }, KNOWN, { store: s });
  const off = installSpendingRecorder(s);
  broadcast = { ok: true };
  const q = evmQuote({ amount: 1000n });
  const sent = await sendEvm(URL, signer, q, null);
  await flushSpendingWrites();
  await new Promise((r) => setTimeout(r, 10));
  await flushSpendingWrites();
  let recs = (await listSpendRecords(SCOPE, s)).records;
  check('accepted native send recorded (value + worst-case fee)', recs.length === 2 && recs.some((x) => x.kind === 'transfer' && x.amount === 1000n && x.ref === sent.txid) && recs.some((x) => x.kind === 'fee' && x.amount === q.fee), recs);
  broadcast = { ok: false };
  let threw = false;
  try {
    await sendEvm(URL, signer, evmQuote({ amount: 5000n, nonce: 8n }), null);
  } catch {
    threw = true;
  }
  await new Promise((r) => setTimeout(r, 10));
  await flushSpendingWrites();
  recs = (await listSpendRecords(SCOPE, s)).records;
  check('refused send (node error) → nothing recorded', threw && recs.length === 2, recs);
  // An ERC-20 transfer reshaped by sendErc20 (value 0, transfer calldata).
  broadcast = { ok: true };
  await sendEvm(URL, signer, evmQuote({ to: SEP_USDC, amount: 0n, data: encodeErc20Transfer(TO, 2_500_000n), nonce: 9n }), null);
  await new Promise((r) => setTimeout(r, 10));
  await flushSpendingWrites();
  recs = (await listSpendRecords(SCOPE, s)).records;
  check('accepted ERC-20 transfer recorded from its calldata', recs.some((x) => x.token === SEP_USDC && x.amount === 2_500_000n), recs);
  // Staged check: a swap whose calldata the wallet cannot read; the check
  // counted the quoted sell amount, and exactly that is recorded.
  const swapQuote = evmQuote({ to: DEX, amount: 0n, data: toBytes('0xfeedface01'), nonce: 10n });
  const input = spendingInputForQuote(swapQuote, OWNER);
  sim = null;
  const check1 = await evaluateBeforeSigning({ scope: SCOPE, spender: input.spender, calls: input.calls, fee: input.fee, quoteOutflows: [{ token: SEP_USDC, amount: 4_000_000n }], url: URL, store: s });
  check('swap check allowed', check1.status === 'allowed', check1);
  await sendEvm(URL, signer, swapQuote, null);
  await new Promise((r) => setTimeout(r, 10));
  await flushSpendingWrites();
  recs = (await listSpendRecords(SCOPE, s)).records;
  check('staged sell amount recorded for the swap transaction', recs.some((x) => x.token === SEP_USDC && x.amount === 4_000_000n && x.kind === 'transfer'), recs);
  off();
  await sendEvm(URL, signer, evmQuote({ amount: 1n, nonce: 11n }), null);
  await new Promise((r) => setTimeout(r, 10));
  await flushSpendingWrites();
  check('after unsubscribe, nothing more is recorded', (await listSpendRecords(SCOPE, s)).records.length === recs.length);
}

console.log('smart-account mapping (aaSentRecorder):');
{
  const s = memoryStore();
  clearStagedSpends();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: ETH, windowSeconds: 86400 }, KNOWN, { store: s });
  const aaQuote = {
    kind: 'aa',
    calls: [{ to: TO, value: 777n, data: new Uint8Array(0) }],
    sender: SMART,
    fee: 999n,
    sponsored: true,
  };
  await aaSentRecorder(s)({ bundle: { chainId: 11155111n }, owner: { address: OWNER, path: "m/44'/60'/0'/0/0" }, quote: aaQuote, userOpHash: '0x' + 'cd'.repeat(32) });
  const recs = (await listSpendRecords(SCOPE, s)).records;
  check('bundler-accepted op recorded under the OWNER scope', recs.length === 1 && recs[0].amount === 777n && recs[0].ref === '0x' + 'cd'.repeat(32), recs);
  check('sponsored op: no fee record', !recs.some((x) => x.kind === 'fee'));
  const i = spendingInputForQuote(aaQuote, OWNER);
  check('smart-account quotes are evaluated as the smart account', i.spender === SMART && i.fee === 0n);
}

// ---------------------------------------------------------------------------
console.log('pruning:');
{
  const policies = [{ windowSeconds: 3600 }, { windowSeconds: 86400 }];
  const recs = [
    { token: NATIVE_TOKEN, amount: 1n, at: NOW - 86400, kind: 'transfer', ref: 'a' },
    { token: NATIVE_TOKEN, amount: 2n, at: NOW - 86399, kind: 'transfer', ref: 'b' },
    { token: NATIVE_TOKEN, amount: 3n, at: NOW, kind: 'transfer', ref: 'c' },
  ];
  const kept = pruneRecords(recs, policies, NOW);
  check('records older than the longest window dropped', kept.length === 2 && kept[0].ref === 'b', kept);
  check('no policy left → everything dropped', pruneRecords(recs, [], NOW).length === 0);
  const s = memoryStore();
  const p = await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 100n, windowSeconds: 3600 }, KNOWN, { store: s, now: NOW });
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 5n }], fee: 0n, ref: 'old', store: s, now: NOW - 7200 });
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 6n }], fee: 0n, ref: 'new', store: s, now: NOW });
  const after = (await listSpendRecords(SCOPE, s)).records;
  check('append prunes outside the window', after.length === 1 && after[0].ref === 'new', after);
  await removeSpendingPolicy(SCOPE, p.id, { store: s, now: NOW });
  check('removing the last policy clears the scope history', (await listSpendRecords(SCOPE, s)).records.length === 0);
}

// ---------------------------------------------------------------------------
console.log('damaged and unreadable storage fail closed:');
{
  const s = memoryStore();
  s.map.set('shiba-wallet.spending-policies.v1', '{not json');
  check('listing reports damaged', (await listSpendingPolicies(SCOPE, s)).damaged === true);
  const r = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 1n }], fee: 0n, store: s });
  check('evaluate → unreadable (send not signed)', r.status === 'unreadable' && r.message === SPENDING_UNREADABLE_MESSAGE, r);
  await rejects('save refused while damaged', () => saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'ETH', decimals: 18, cap: 1n, windowSeconds: 3600 }, KNOWN, { store: s }), /could not be read/);
  let typed = false;
  try {
    await removeSpendingPolicy(SCOPE, 'x', { store: s });
  } catch (e) {
    typed = e instanceof SpendingStoreError;
  }
  check('remove refused while damaged (SpendingStoreError)', typed);
  s.map.set('shiba-wallet.spending-policies.v1', JSON.stringify({ version: 1, entries: { [`${SEPOLIA}|${OWNER.toLowerCase()}`]: [{ id: 'x', token: NATIVE_TOKEN, symbol: 'ETH', decimals: 18, cap: '-1', windowSeconds: 60, allowOverride: false, countFees: false, createdAt: 0 }] } }));
  check('one malformed entry marks the store damaged', (await listSpendingPolicies(SCOPE, s)).damaged === true);
  const good = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'ETH', decimals: 18, cap: 1n, windowSeconds: 3600 }, KNOWN, { store: good });
  good.map.set('shiba-wallet.spending-history.v1', '[]');
  const h = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 1n }], fee: 0n, store: good });
  check('damaged history with a policy → unreadable', h.status === 'unreadable');
  const throwing = { getItem: async () => { throw new Error('io'); }, setItem: async () => undefined };
  const t = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 1n }], fee: 0n, store: throwing });
  check('storage that throws → unreadable', t.status === 'unreadable');
  await resetSpendingLimits(s);
  check('reset clears the damage', (await listSpendingPolicies(SCOPE, s)).damaged === false);
}

// ---------------------------------------------------------------------------
console.log('readouts and masking:');
{
  const s = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: SEP_USDC, symbol: 'USDC', decimals: 6, cap: 100_000_000n, windowSeconds: 7 * 86400 }, KNOWN, { store: s, now: NOW });
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: [{ to: SEP_USDC, value: 0n, data: encodeErc20Transfer(TO, 12_345_678n) }], fee: 0n, ref: 'r', store: s, now: NOW });
  const { readouts } = await spendingReadouts(SCOPE, { store: s, now: NOW });
  check('readout: spent in window', readouts[0].spentInWindow === 12_345_678n);
  check('readout text', spentReadoutText(readouts[0], false) === 'Spent in the current window: 12.345678 of 100 USDC', spentReadoutText(readouts[0], false));
  check('readout text masked under Hide amounts', spentReadoutText(readouts[0], true) === 'Spent in the current window: •••• of •••• USDC', spentReadoutText(readouts[0], true));
  check('summary', policySummary(readouts[0].policy, false) === '100 USDC per 7 days');
  check('summary masked', policySummary(readouts[0].policy, true) === '•••• USDC per 7 days');
  const later = await spendingReadouts(SCOPE, { store: s, now: NOW + 7 * 86400 });
  check('readout drops to 0 once the window has passed', later.readouts[0].spentInWindow === 0n);
}


// ---------------------------------------------------------------------------
// Phase 12 rehearsal findings 10 and 12
// ---------------------------------------------------------------------------
console.log('loosening asks for the device check (finding 10):');
{
  const saved = { cap: 100n, windowSeconds: 86400, allowOverride: false, countFees: true };
  check('same terms → nothing loosened', policyLooseningReasons(saved, saved).length === 0);
  check('tighter: lower cap, longer window, override off, fees counted → nothing loosened',
    policyLooseningReasons(saved, { cap: 50n, windowSeconds: 7 * 86400, allowOverride: false, countFees: true }).length === 0);
  check('raising the cap loosens', policyLooseningReasons(saved, { ...saved, cap: 101n }).join() === 'raises the limit');
  check('shortening the window loosens', policyLooseningReasons(saved, { ...saved, windowSeconds: 3600 }).join() === 'shortens the time window');
  check('turning on "Send anyway" loosens', policyLooseningReasons(saved, { ...saved, allowOverride: true }).join() === 'allows "Send anyway"');
  check('no longer counting fees loosens', policyLooseningReasons(saved, { ...saved, countFees: false }).join() === 'stops counting network fees');
  const { readFileSync } = await import('node:fs');
  const screen = readFileSync(new globalThis.URL('../src/screens/SpendingLimitsScreen.tsx', import.meta.url), 'utf8');
  const save = screen.slice(screen.indexOf('const onSave = async'), screen.indexOf('const onRemove ='));
  check('onSave: a loosening edit runs requireLocalAuth(SPENDING_LOOSEN_PROMPT) BEFORE saveSpendingPolicy',
    /policyLooseningReasons\(editingPolicy/.test(save) && save.indexOf('requireLocalAuth(SPENDING_LOOSEN_PROMPT)') > 0 &&
      save.indexOf('requireLocalAuth(SPENDING_LOOSEN_PROMPT)') < save.indexOf('saveSpendingPolicy('));
  const remove = screen.slice(screen.indexOf('const onRemove ='), screen.indexOf('const onReset ='));
  check('Remove alert masks the cap under Hide amounts (policySummary(p, hideAmounts))', /policySummary\(p, hideAmounts\)/.test(remove) && !/policySummary\(p, false\)/.test(remove));
  check('Remove asks for the device check before removeSpendingPolicy', remove.indexOf('requireLocalAuth(SPENDING_REMOVE_PROMPT)') > 0 && remove.indexOf('requireLocalAuth(SPENDING_REMOVE_PROMPT)') < remove.indexOf('removeSpendingPolicy('));
  const reset = screen.slice(screen.indexOf('const onReset ='));
  check('Reset (deletes every limit) asks for the same device check', reset.indexOf('requireLocalAuth(SPENDING_RESET_PROMPT)') > 0 && reset.indexOf('requireLocalAuth(SPENDING_RESET_PROMPT)') < reset.indexOf('resetSpendingLimits()'));
  check('prompts are plain sentences', SPENDING_LOOSEN_PROMPT === 'Loosen your spending limit' && SPENDING_REMOVE_PROMPT === 'Remove your spending limit' && SPENDING_RESET_PROMPT === 'Reset your spending limits');
}

console.log('the confirm screen warns before Send (finding 12):');
{
  const s = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 200n, windowSeconds: 3600 }, KNOWN, { store: s, now: NOW });
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 100n }], fee: 0n, ref: '0x0a', store: s, now: NOW - 10 });
  const look = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 150n }], fee: 0n, url: null, stage: false, store: s, now: NOW });
  const lines = overLimitPreviewLines(look, false);
  check('look-ahead over the limit → one warning line with cap, spent and this send',
    lines.length === 1 && lines[0] === 'This send would go over the limit for test ETH (0.0000000000000002 test ETH per 1 hour): already spent 0.0000000000000001 test ETH, this send 0.00000000000000015 test ETH. Tapping Send will stop it; raise or remove the limit first.',
    lines[0]);
  check('…masked under Hide amounts', overLimitPreviewLines(look, true)[0] === 'This send would go over the limit for test ETH (•••• test ETH per 1 hour): already spent •••• test ETH, this send •••• test ETH. Tapping Send will stop it; raise or remove the limit first.', overLimitPreviewLines(look, true)[0]);
  const fits = await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 100n }], fee: 0n, url: null, stage: false, store: s, now: NOW });
  check('a send that fits → no warning line', overLimitPreviewLines(fits, false).length === 0);
  // The look-ahead must not stage: a staged figure would be recorded for the
  // real send instead of what the gate later counts. Here the extra outflow
  // (200) is only in the look-ahead; the accepted send records the calldata's 5.
  const t = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: SEP_USDC, symbol: 'USDC', decimals: 6, cap: 1_000n, windowSeconds: 3600 }, KNOWN, { store: t, now: NOW });
  const sendCalls = [{ to: SEP_USDC, value: 0n, data: encodeErc20Transfer(TO, 5n) }];
  clearStagedSpends();
  await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: sendCalls, fee: 0n, url: null, quoteOutflows: [{ token: SEP_USDC, amount: 200n }], stage: false, store: t, now: NOW });
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: sendCalls, fee: 0n, ref: '0x0b', store: t, now: NOW });
  const recorded = (await listSpendRecords(SCOPE, t)).records.filter((r) => r.kind === 'transfer');
  check('stage:false look-ahead stages nothing (the accepted send records 5, not 200)', recorded.length === 1 && recorded[0].amount === 5n, recorded);
  // Control: the gate's normal call stages, so the same flow records 200.
  const u = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: SEP_USDC, symbol: 'USDC', decimals: 6, cap: 1_000n, windowSeconds: 3600 }, KNOWN, { store: u, now: NOW });
  await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: sendCalls, fee: 0n, url: null, quoteOutflows: [{ token: SEP_USDC, amount: 200n }], store: u, now: NOW });
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: sendCalls, fee: 0n, ref: '0x0c', store: u, now: NOW });
  check('control: the gate (default stage) records the staged 200', (await listSpendRecords(SCOPE, u)).records.some((r) => r.kind === 'transfer' && r.amount === 200n));
  const { readFileSync } = await import('node:fs');
  const views = readFileSync(new globalThis.URL('../src/components/SpendingPolicyViews.tsx', import.meta.url), 'utf8');
  check('SpendingPolicyNotice looks ahead with url null and stage false, and renders overLimitPreviewLines with Hide amounts',
    /url: null,\s*\n\s*quoteOutflows: extra,\s*\n\s*stage: false/.test(views) && /overLimitPreviewLines\(lookAhead, hideAmounts\)/.test(views));
  const send = readFileSync(new globalThis.URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8');
  const swap = readFileSync(new globalThis.URL('../src/screens/SwapScreen.tsx', import.meta.url), 'utf8');
  const wc = readFileSync(new globalThis.URL('../src/components/WcApprovalSheet.tsx', import.meta.url), 'utf8');
  check('every Send confirm passes its quote to the notice (4 sites)', (send.match(/<SpendingPolicyNotice owner=\{quotedFrom\} quote=\{quote\} from=\{quotedFrom\} \/>/g) ?? []).length === 4);
  check('Swap (2) and the WalletConnect sheet (2) pass their quotes too',
    (swap.match(/<SpendingPolicyNotice\s+owner=\{account\.address\}\s+quote=\{(aaQuote|sendQuote)\}/g) ?? []).length === 2 &&
      /<SpendingPolicyNotice owner=\{txQuote\.from\} quote=\{txQuote\.quote\} from=\{txQuote\.from\} \/>/.test(wc) &&
      /<SpendingPolicyNotice owner=\{ready\.owner\} quote=\{ready\.quote\} from=\{ready\.owner\} \/>/.test(wc));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

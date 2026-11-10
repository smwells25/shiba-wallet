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
  // Phase 24 (the masked-amount follow-up to pass p24-solhist finding 1): the
  // screens speak these lines through a11y.ts maskedSpokenProps.
  const a11y = await import('../src/a11y.ts');
  check('…and spoken "(amount hidden)", never "••••": the readout, the summary and the notice line',
    a11y.maskedSpokenProps(spentReadoutText(readouts[0], true)).accessibilityLabel === 'Spent in the current window: (amount hidden) of (amount hidden) USDC' &&
      a11y.maskedSpokenProps(policySummary(readouts[0].policy, true)).accessibilityLabel === '(amount hidden) USDC per 7 days' &&
      a11y.maskedSpokenProps(`${policySummary(readouts[0].policy, true)}. ${spentReadoutText(readouts[0], true)}.`).accessibilityLabel ===
        '(amount hidden) USDC per 7 days. Spent in the current window: (amount hidden) of (amount hidden) USDC.');
  check('…unmasked lines get no label of their own (read exactly as before)',
    Object.keys(a11y.maskedSpokenProps(spentReadoutText(readouts[0], false))).length === 0 &&
      Object.keys(a11y.maskedSpokenProps(policySummary(readouts[0].policy, false))).length === 0);
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
  {
    const a11y = await import('../src/a11y.ts');
    const spokenWarn = a11y.spokenMaskedText(`Warning: ${overLimitPreviewLines(look, true)[0]}`);
    check('…and its warning label (spokenMaskedText(`Warning: ${line}`)) speaks every mask as "(amount hidden)" (phase 24)',
      spokenWarn === 'Warning: This send would go over the limit for test ETH ((amount hidden) test ETH per 1 hour): already spent (amount hidden) test ETH, this send (amount hidden) test ETH. Tapping Send will stop it; raise or remove the limit first.' &&
        !spokenWarn.includes('••••'), spokenWarn);
    check('…unmasked, the warning label is exactly the old "Warning: <line>"',
      a11y.spokenMaskedText(`Warning: ${lines[0]}`) === `Warning: ${lines[0]}`);
  }
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
  // Phase 24: the notice's readout lines and its warning labels speak the mask in words.
  const NOTICE_LINE = '{...maskedSpokenProps(`${policySummary(r.policy, hideAmounts)}. ${spentReadoutText(r, hideAmounts)}.`)}';
  const NOTICE_WARN = 'accessibilityLabel={spokenMaskedText(`Warning: ${line}`)}';
  // Phase 26 item 3b: the Solana confirm card (SolanaSpendingPolicyNotice) renders the same two lines, so each appears twice.
  const count = (src, needle) => src.split(needle).length - 1;
  const viewsPin = (src) => src.includes("import { maskedSpokenProps, spokenMaskedText } from '../a11y';") && count(src, NOTICE_LINE) === 2 && count(src, NOTICE_WARN) === 2;
  check('SpendingPolicyNotice and SolanaSpendingPolicyNotice: each readout line spreads maskedSpokenProps and each warning label goes through spokenMaskedText (source)', viewsPin(views));
  check('…mutant caught: the readout line without the helper', !viewsPin(views.replace(NOTICE_LINE, '')));
  check('…mutant caught: the warning label without spokenMaskedText', !viewsPin(views.replace(NOTICE_WARN, 'accessibilityLabel={`Warning: ${line}`}')));
  const limits = readFileSync(new globalThis.URL('../src/screens/SpendingLimitsScreen.tsx', import.meta.url), 'utf8');
  const LIM_TITLE = '{...maskedSpokenProps(policySummary(r.policy, hideAmounts))}';
  const LIM_BODY = '{...maskedSpokenProps(spentReadoutText(r, hideAmounts))}';
  // Phase 26 item 3b: the Solana section's limit cards spread the same props, so each appears twice.
  const limitsPin = (src) => count(src, LIM_TITLE) === 2 && count(src, LIM_BODY) === 2;
  check('Spending limits screen: the EVM and the Solana card titles and readouts spread maskedSpokenProps (source)', limitsPin(limits));
  check('…mutant caught: the readout without the helper', !limitsPin(limits.replace(LIM_BODY, '')));
  const send = readFileSync(new globalThis.URL('../src/screens/SendScreen.tsx', import.meta.url), 'utf8');
  const swap = readFileSync(new globalThis.URL('../src/screens/SwapScreen.tsx', import.meta.url), 'utf8');
  const wc = readFileSync(new globalThis.URL('../src/components/WcApprovalSheet.tsx', import.meta.url), 'utf8');
  check('every Send confirm passes its quote to the notice (4 sites)', (send.match(/<SpendingPolicyNotice owner=\{quotedFrom\} quote=\{quote\} from=\{quotedFrom\} \/>/g) ?? []).length === 4);
  check('Swap (2) and the WalletConnect sheet (2) pass their quotes too',
    (swap.match(/<SpendingPolicyNotice\s+owner=\{account\.address\}\s+quote=\{(aaQuote|sendQuote)\}/g) ?? []).length === 2 &&
      /<SpendingPolicyNotice owner=\{txQuote\.from\} quote=\{txQuote\.quote\} from=\{txQuote\.from\} \/>/.test(wc) &&
      /<SpendingPolicyNotice owner=\{ready\.owner\} quote=\{ready\.quote\} from=\{ready\.owner\} \/>/.test(wc));
}

// ---------------------------------------------------------------------------
console.log('check-spending-policy: counting before the broadcast (the bounded-broadcast follow-ups)');
// ---------------------------------------------------------------------------
{
  const { broadcastSpendRecorder, releaseSpend, releaseSettledSpend } = await import('../src/wallet/spending-policy.ts');
  const bs = await import('../src/wallet/broadcast-spend.ts');
  const s = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 10n ** 18n, windowSeconds: 3600, countFees: true }, [NATIVE_TOKEN], { store: s, now: NOW });
  const rec = broadcastSpendRecorder(s);
  const spend = { chain: SCOPE.chain, owner: SCOPE.owner, spender: OWNER, calls: [{ to: TO, value: 70n }], fee: 9n, now: NOW };
  const refs = async (ref) => (await listSpendRecords(SCOPE, s)).records.filter((r) => r.ref.toLowerCase() === ref.toLowerCase());
  const R1 = `0x${'a1'.repeat(32)}`;
  check('record: the value and the worst-case fee are counted under the hash (state created)', (await rec.record(spend, R1)) === 'created' && (await refs(R1)).length === 2);
  check('…a second count of the same hash adds nothing (state existed): a send is counted once', (await rec.record(spend, R1)) === 'existed' && (await refs(R1)).length === 2);
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: spend.calls, fee: spend.fee, ref: R1.toUpperCase().replace('0X', '0x'), store: s, now: NOW });
  check('…nor does the acceptance recorder under the same hash in another case', (await refs(R1)).length === 2);
  const R2 = `0x${'a2'.repeat(32)}`;
  await rec.accepted(spend, R1, R2);
  check('accepted under another hash: the records move to it, none left under the first', (await refs(R1)).length === 0 && (await refs(R2)).length === 2);
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: spend.calls, fee: spend.fee, ref: R2, store: s, now: NOW });
  check('…and the acceptance recorder under the returned hash adds nothing', (await refs(R2)).length === 2);
  // A refusal releases the count and puts the staged check back.
  const R3 = `0x${'a3'.repeat(32)}`;
  await evaluateBeforeSigning({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 5n }], fee: 1n, url: null, quoteOutflows: [{ token: NATIVE_TOKEN, amount: 50n }], store: s, now: NOW });
  const staged = { ...spend, calls: [{ to: TO, value: 5n }], fee: 1n };
  await rec.record(staged, R3);
  check('the staged check is what is counted (50 from the quote, not the 5 of the calls)', (await refs(R3)).some((r) => r.kind === 'transfer' && r.amount === 50n));
  await rec.release(staged, R3);
  check('release: the records of that hash are gone', (await refs(R3)).length === 0);
  const R4 = `0x${'a4'.repeat(32)}`;
  await rec.record(staged, R4);
  check('…and the staged check was put back: approving the same calls again counts the same 50', (await refs(R4)).some((r) => r.kind === 'transfer' && r.amount === 50n));
  // The orchestration: only what THIS attempt created is released.
  const bsS = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: 10n ** 18n, windowSeconds: 3600 }, [NATIVE_TOKEN], { store: bsS, now: NOW });
  const off = bs.addBroadcastSpendRecorder(broadcastSpendRecorder(bsS));
  const R5 = `0x${'a5'.repeat(32)}`;
  const first = await bs.countSpendBeforeBroadcast({ ...spend, store: bsS }, R5);
  const second = await bs.countSpendBeforeBroadcast({ ...spend, store: bsS }, R5);
  await bs.releaseSpendAfterRefusal({ ...spend, store: bsS }, R5, second);
  const kept = (await listSpendRecords(SCOPE, bsS)).records.filter((r) => r.ref === R5);
  check('a refused attempt whose count already existed (an earlier attempt, outcome unknown) never releases it',
    first[0]?.[1] === 'created' && second[0]?.[1] === 'existed' && kept.length === 2);
  await bs.releaseSpendAfterRefusal({ ...spend, store: bsS }, R5, first);
  check('…the attempt that created it does', (await listSpendRecords(SCOPE, bsS)).records.filter((r) => r.ref === R5).length === 0);
  check('no limit in the scope: nothing counted (state none), nothing to release', (await bs.countSpendBeforeBroadcast({ ...spend, owner: TO, store: bsS }, R5))[0]?.[1] === 'none');
  check('no spend given (a path that counts nothing): no recorder is asked', (await bs.countSpendBeforeBroadcast(null, R5)).length === 0);
  off();
  check('…with no recorder registered nothing is counted', (await bs.countSpendBeforeBroadcast({ ...spend, store: bsS }, `0x${'a6'.repeat(32)}`)).length === 0);
  // The settled-nonce release.
  const S7 = `0x${'b7'.repeat(32)}`;
  const S8 = `0x${'b8'.repeat(32)}`;
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: [{ to: TO, value: 7n }], fee: 3n, ref: S7, store: s, now: NOW });
  await recordAcceptedSpend({ scope: SCOPE, spender: OWNER, calls: [], fee: 4n, ref: S8, store: s, now: NOW });
  const evt = (outcome) => ({ chain: SCOPE.chain, from: OWNER.toLowerCase(), nonce: '9', minedHash: S8, outcome, txs: [{ hash: S7, action: 'send' }, { hash: S8, action: 'speed-up' }] });
  check('settled as mined (a single broadcast): nothing released', (await releaseSettledSpend(evt('mined'), s)) === 0);
  check('settled as replaced: only the losing broadcast\'s FEE is released (its value was re-sent by the speed-up)',
    (await releaseSettledSpend(evt('replaced'), s)) === 1 && (await refs(S7)).length === 1 && (await refs(S7))[0].kind === 'transfer' && (await refs(S8)).length === 1);
  check('settled as cancelled: everything left of the losing broadcast is released, the included one kept',
    (await releaseSettledSpend(evt('cancelled'), s)) === 1 && (await refs(S7)).length === 0 && (await refs(S8)).length === 1);
  check('releaseSpend of an unknown hash removes nothing', (await releaseSpend({ scope: SCOPE, ref: `0x${'c0'.repeat(32)}`, store: s })) === 0);
}

// ---------------------------------------------------------------------------
console.log('check-spending-policy: phase 26 item 3b — a Solana scope (Solana token limits, keyed by mint)');
// ---------------------------------------------------------------------------
{
  const SP = await import('../src/wallet/spending-policy.ts');
  const { solanaKeyProvider } = await import('@shiba-wallet/core');
  const { base58 } = await import('@scure/base');
  const { readFileSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { dirname, join, resolve } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
  const MAINNET_SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const SOL_OWNER = solanaKeyProvider.deriveAccount(seed, 0, 0).address;
  const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
  const SOL_SCOPE = { chain: DEVNET, owner: SOL_OWNER };
  const SOL_KNOWN = [USDC_MINT, EURC_MINT];
  const sig = (b) => base58.encode(new Uint8Array(64).fill(b));
  const input = (amount, mint = USDC_MINT) => ({ chain: DEVNET, owner: SOL_OWNER, mint, amount });
  const usdcLimit = { token: USDC_MINT, symbol: 'USDC', decimals: 6, cap: 1_000_000n, windowSeconds: 3600 };

  check('scopeKey: Solana devnet and mainnet keep the base58 owner exactly; another Solana id, a bad owner and a hex owner are refused',
    SP.scopeKey(SOL_SCOPE) === `${DEVNET}|${SOL_OWNER}` && SP.scopeKey({ chain: MAINNET_SOL, owner: SOL_OWNER }) === `${MAINNET_SOL}|${SOL_OWNER}` &&
      [
        { chain: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z', owner: SOL_OWNER },
        { chain: DEVNET, owner: SOL_OWNER.toLowerCase() },
        { chain: DEVNET, owner: OWNER },
      ].every((scope) => { try { SP.scopeKey(scope); return false; } catch { return true; } }));
  check('solanaStandIns: one 20-byte stand-in per distinct mint, in order, never the zero address (the engine\'s native coin)',
    (() => { const m = SP.solanaStandIns([USDC_MINT, EURC_MINT, USDC_MINT]); return m.toEngine.size === 2 && m.toEngine.get(USDC_MINT) === `0x${'0'.repeat(39)}1` && m.toEngine.get(EURC_MINT) === `0x${'0'.repeat(39)}2` && m.fromEngine.get(`0x${'0'.repeat(39)}2`) === EURC_MINT; })());

  // One store holding an EVM limit and a Solana limit: both read back; nothing else changes.
  const s = memoryStore();
  await saveSpendingPolicy(SCOPE, { token: NATIVE_TOKEN, symbol: 'test ETH', decimals: 18, cap: ETH, windowSeconds: 3600 }, KNOWN, { store: s, now: NOW });
  const evmBlob = s.map.get('shiba-wallet.spending-policies.v1');
  await saveSpendingPolicy(SOL_SCOPE, usdcLimit, SOL_KNOWN, { store: s, now: NOW });
  const solList = await listSpendingPolicies(SOL_SCOPE, s);
  const evmList = await listSpendingPolicies(SCOPE, s);
  const scopes = await listSpendingScopes(s);
  check('a Solana limit saves and reads back: the mint exactly as written (not lower-cased, not checksummed), no "Send anyway", no fees',
    !solList.damaged && solList.policies.length === 1 && solList.policies[0].token === USDC_MINT && solList.policies[0].allowOverride === false && solList.policies[0].countFees === false);
  check('…beside an EVM limit in the same store: both read back, the EVM entry byte-identical in the stored document',
    !evmList.damaged && evmList.policies.length === 1 && evmList.policies[0].token === NATIVE_TOKEN &&
      JSON.parse(s.map.get('shiba-wallet.spending-policies.v1')).entries[`${SEPOLIA}|${OWNER.toLowerCase()}`].length === 1 &&
      JSON.stringify(JSON.parse(s.map.get('shiba-wallet.spending-policies.v1')).entries[`${SEPOLIA}|${OWNER.toLowerCase()}`]) === JSON.stringify(JSON.parse(evmBlob).entries[`${SEPOLIA}|${OWNER.toLowerCase()}`]));
  check('…and listSpendingScopes lists both scopes, the Solana owner exact',
    !scopes.damaged && scopes.scopes.length === 2 && scopes.scopes.some((x) => x.scope.chain === DEVNET && x.scope.owner === SOL_OWNER && x.count === 1));

  // The app rules of a Solana scope.
  await rejects('a Solana scope refuses a limit on the network coin (no Solana token mint)', () => saveSpendingPolicy(SOL_SCOPE, { ...usdcLimit, token: NATIVE_TOKEN }, [...SOL_KNOWN, NATIVE_TOKEN], { store: memoryStore(), now: NOW }), /^Choose a Solana token tracked on this network: a Solana token limit names the token’s mint\.$/);
  await rejects('…refuses "Send anyway"', () => saveSpendingPolicy(SOL_SCOPE, { ...usdcLimit, allowOverride: true }, SOL_KNOWN, { store: memoryStore(), now: NOW }), /^“Send anyway” is not offered for a Solana token limit: a Solana token send over a limit is refused\.$/);
  await rejects('…refuses counting network fees (they are SOL, not the token)', () => saveSpendingPolicy(SOL_SCOPE, { ...usdcLimit, countFees: true }, SOL_KNOWN, { store: memoryStore(), now: NOW }), /^Network fees cannot be counted in a Solana token limit: they are paid in SOL, not in the token\.$/);
  await rejects('…refuses a mint that is not a tracked token of the network', () => saveSpendingPolicy(SOL_SCOPE, usdcLimit, [EURC_MINT], { store: memoryStore(), now: NOW }), /^Choose a Solana token tracked on this network/);
  await rejects('…refuses the account itself as a token', () => saveSpendingPolicy(SOL_SCOPE, { ...usdcLimit, token: SOL_OWNER }, [SOL_OWNER], { store: memoryStore(), now: NOW }), /^Choose a Solana token tracked on this network/);
  await rejects('…keeps the engine\'s rules on the stand-ins (one rule per token and window)', async () => {
    const d = memoryStore();
    await saveSpendingPolicy(SOL_SCOPE, usdcLimit, SOL_KNOWN, { store: d, now: NOW });
    await saveSpendingPolicy(SOL_SCOPE, { ...usdcLimit, cap: 5n }, SOL_KNOWN, { store: d, now: NOW });
  }, /duplicates an earlier \(token, window\) rule/);
  const restored = memoryStore();
  await saveSpendingPolicy(SOL_SCOPE, usdcLimit, [USDC_MINT], { store: restored, now: NOW });
  check('a records-backup restore (records-backup.ts passes [policy.token] as the known tokens) saves a Solana limit', (await listSpendingPolicies(SOL_SCOPE, restored)).policies.length === 1);

  // Stored data the Solana rules cannot have fails closed.
  const tampered = (mutate) => {
    const t = memoryStore();
    const doc = JSON.parse(s.map.get('shiba-wallet.spending-policies.v1'));
    mutate(doc);
    t.map.set('shiba-wallet.spending-policies.v1', JSON.stringify(doc));
    return t;
  };
  check('a stored Solana limit with "Send anyway" on, or with fees counted, or a hex token, marks the store damaged (fail closed)',
    (await listSpendingPolicies(SOL_SCOPE, tampered((d) => (d.entries[`${DEVNET}|${SOL_OWNER}`][0].allowOverride = true)))).damaged &&
      (await listSpendingPolicies(SOL_SCOPE, tampered((d) => (d.entries[`${DEVNET}|${SOL_OWNER}`][0].countFees = true)))).damaged &&
      (await listSpendingPolicies(SOL_SCOPE, tampered((d) => (d.entries[`${DEVNET}|${SOL_OWNER}`][0].token = SEP_USDC)))).damaged &&
      (await listSpendingPolicies(SCOPE, tampered((d) => (d.entries[`${DEVNET}|${SOL_OWNER.toLowerCase()}`] = d.entries[`${DEVNET}|${SOL_OWNER}`])))).damaged);
  const feeHistory = memoryStore();
  feeHistory.map.set('shiba-wallet.spending-history.v1', JSON.stringify({ version: 1, entries: { [`${DEVNET}|${SOL_OWNER}`]: [{ token: USDC_MINT, amount: '1', at: NOW, kind: 'fee', ref: sig(1) }] } }));
  check('…and a stored Solana FEE record marks the history damaged (a Solana scope never counts a fee)', (await listSpendRecords(SOL_SCOPE, feeHistory)).damaged);

  // The decision.
  const blocked = await SP.evaluateSolanaTokenSend(input(2_000_000n), { store: s, now: NOW });
  check('2 USDC under a 1 USDC per hour limit: blocked, no "Send anyway", the entry named by the mint (the stand-in mapped back), basis quote',
    blocked.status === 'blocked' && blocked.overrideAllowed === false && blocked.basis === 'quote' && blocked.decision.enforcement === 'client-side' &&
      blocked.results.length === 1 && blocked.results[0].entry.token === USDC_MINT && blocked.results[0].entry.proposed === 2_000_000n && blocked.results[0].entry.exceeds &&
      blocked.outflows.length === 1 && blocked.outflows[0].token === USDC_MINT);
  check('…its message: the over-limit sentence, the honesty sentence, the no-"Send anyway" sentence (exact)',
    blocked.title === SPENDING_BLOCK_TITLE &&
      blocked.message === ['This send would go over your spending limit for USDC: 1 USDC per 1 hour. Already spent in this window: 0 USDC; this send: 2 USDC.', SPENDING_HONESTY_SENTENCE, SPENDING_OVERRIDE_OFF_SENTENCE].join('\n\n'));
  check('1 USDC exactly (the cap): allowed; 0.5 USDC: allowed', (await SP.evaluateSolanaTokenSend(input(1_000_000n), { store: s, now: NOW })).status === 'allowed' && (await SP.evaluateSolanaTokenSend(input(500_000n), { store: s, now: NOW })).status === 'allowed');
  check('a mint with no limit (EURC), and an account with no Solana limit at all: no-policy',
    (await SP.evaluateSolanaTokenSend(input(9_000_000n, EURC_MINT), { store: s, now: NOW })).status === 'no-policy' &&
      (await SP.evaluateSolanaTokenSend({ ...input(9_000_000n), owner: solanaKeyProvider.deriveAccount(seed, 1, 0).address }, { store: s, now: NOW })).status === 'no-policy');
  const unreadable = memoryStore();
  unreadable.map.set('shiba-wallet.spending-policies.v1', '{nope');
  check('unreadable stored limits: "unreadable" with the app\'s sentence (fail closed)',
    (await SP.evaluateSolanaTokenSend(input(1n), { store: unreadable, now: NOW })).message === SPENDING_UNREADABLE_MESSAGE);

  // The count: before the broadcast, under the signature, exactly.
  const gate = SP.solanaSpendingGate({ store: s });
  check('record 0.5 USDC under a signature: created; again: existed (counted once)',
    (await gate.record(input(500_000n), sig(1), NOW - 3599)) === 'created' && (await gate.record(input(500_000n), sig(1), NOW)) === 'existed');
  const recs = (await listSpendRecords(SOL_SCOPE, s)).records;
  check('…the record: kind transfer, the mint, 500000, the signature as written', recs.length === 1 && recs[0].kind === 'transfer' && recs[0].token === USDC_MINT && recs[0].amount === 500_000n && recs[0].ref === sig(1) && recs[0].at === NOW - 3599);
  const after = await SP.evaluateSolanaTokenSend(input(600_000n), { store: s, now: NOW });
  check('…then 0.6 USDC in the same hour: blocked, "already spent" 0.5 USDC', after.status === 'blocked' && after.results[0].entry.spentInWindow === 500_000n);
  check('…and an hour after the first (at > now − window is the engine\'s rule): allowed again', (await SP.evaluateSolanaTokenSend(input(600_000n), { store: s, now: NOW + 1 })).status === 'allowed');
  check('readouts: "Spent in the current window: 0.5 of 1 USDC" for the Solana limit (the engine on the stand-in)',
    (await spendingReadouts(SOL_SCOPE, { store: s, now: NOW })).readouts.map((r) => spentReadoutText(r, false)).join('|') === 'Spent in the current window: 0.5 of 1 USDC');
  check('a record of a mint with no limit is not written ("none")', (await gate.record(input(5n, EURC_MINT), sig(2), NOW)) === 'none' && (await listSpendRecords(SOL_SCOPE, s)).records.length === 1);
  // Two limits on two mints: each counts only its own mint.
  await saveSpendingPolicy(SOL_SCOPE, { token: EURC_MINT, symbol: 'EURC', decimals: 6, cap: 100n, windowSeconds: 3600 }, SOL_KNOWN, { store: s, now: NOW });
  check('two limits (USDC, EURC): EURC is not charged with the 0.5 USDC already spent, and USDC still is',
    (await SP.evaluateSolanaTokenSend(input(100n, EURC_MINT), { store: s, now: NOW })).status === 'allowed' &&
      (await SP.evaluateSolanaTokenSend(input(600_000n), { store: s, now: NOW })).status === 'blocked');
  // Release is exact: a base58 signature differing only in letter case is another signature.
  const upper = sig(1).toUpperCase() === sig(1) ? sig(1).toLowerCase() : sig(1).toUpperCase();
  await gate.release(input(500_000n), upper);
  check('release by a signature that differs only in letter case removes nothing (base58 is case-sensitive)', (await listSpendRecords(SOL_SCOPE, s)).records.length === 1);
  await gate.accepted(input(500_000n), sig(1), sig(3));
  check('accepted under another signature: the record moves to it', (await listSpendRecords(SOL_SCOPE, s)).records[0].ref === sig(3));
  await gate.release(input(500_000n), sig(3));
  check('release by the exact signature removes it', (await listSpendRecords(SOL_SCOPE, s)).records.length === 0);
  check('the gate\'s check never throws: a bad owner reads as "unreadable" (fail closed)', (await gate.check({ ...input(1n), owner: 'not-base58!' })).status === 'unreadable');
  await rejects('evaluateBeforeSigning (the EVM check) refuses a Solana scope instead of reading it as EVM calls', () => evaluateBeforeSigning({ scope: SOL_SCOPE, spender: SOL_OWNER, calls: [], fee: 0n, url: null, store: s, now: NOW }), /^Not an EVM chain id: solana:/);
  check('solanaSpendingTokenOptions: the network\'s tracked Solana tokens by mint, never the coin, no duplicates, other chains dropped',
    JSON.stringify(SP.solanaSpendingTokenOptions(DEVNET, [
      { kind: 'fungible', assetId: { chainId: DEVNET, namespace: 'token', reference: USDC_MINT }, symbol: 'USDC', decimals: 6 },
      { kind: 'fungible', assetId: { chainId: DEVNET, namespace: 'token', reference: USDC_MINT }, symbol: 'USDC', decimals: 6 },
      { kind: 'fungible', assetId: { chainId: MAINNET_SOL, namespace: 'token', reference: EURC_MINT }, symbol: 'EURC', decimals: 6 },
    ])) === JSON.stringify([{ token: USDC_MINT, symbol: 'USDC', decimals: 6, label: 'USDC · 4zMM…ncDU' }]));
  check('the screen explainer no longer says Solana is not covered', SP.SPENDING_SCREEN_EXPLAINER.endsWith('Bitcoin and Dogecoin are not covered; Solana tokens have their own section below.'));

  // In-suite mutants: a copy of wallet/spending-policy.ts with one change, its relative imports pinned.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const PATH = resolve(HERE, '../src/wallet/spending-policy.ts');
  const SRC = readFileSync(PATH, 'utf8');
  const DIR = join(HERE, `.mutants-spending-policy-${process.pid}`);
  process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));
  let made = 0;
  let caught = 0;
  const mutant = async (from, to) => {
    if (!SRC.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
    mkdirSync(DIR, { recursive: true });
    made += 1;
    const file = join(DIR, `m${made}-spending-policy.ts`);
    writeFileSync(file, SRC.replace(from, to).replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolve(dirname(PATH), spec)).href}'`));
    return import(pathToFileURL(file).href);
  };
  const verdict = (name, ok) => {
    caught += ok ? 1 : 0;
    check(`mutant caught (3b): ${name}`, ok);
  };
  {
    const M = await mutant('    return `${scope.chain}|${scope.owner}`;', '    return `${scope.chain}|${scope.owner.toLowerCase()}`;');
    const t = memoryStore();
    await M.saveSpendingPolicy(SOL_SCOPE, usdcLimit, SOL_KNOWN, { store: t, now: NOW });
    verdict('the Solana owner lower-cased in the scope key (the store no longer reads back)', (await M.listSpendingPolicies(SOL_SCOPE, t)).damaged);
  }
  {
    const M = await mutant("    .filter((r) => r.kind === 'transfer' && toEngine.has(r.token))", '    .filter(() => false)');
    const t = memoryStore();
    await M.saveSpendingPolicy(SOL_SCOPE, usdcLimit, SOL_KNOWN, { store: t, now: NOW });
    await M.solanaSpendingGate({ store: t }).record(input(500_000n), sig(1), NOW);
    verdict('the recorded sends left out of the decision (0.6 after 0.5 is allowed)', (await M.evaluateSolanaTokenSend(input(600_000n), { store: t, now: NOW })).status === 'allowed');
  }
  {
    const M = await mutant("      if (before.some((r) => r.ref === input.ref)) return 'existed';\n", '');
    const t = memoryStore();
    await M.saveSpendingPolicy(SOL_SCOPE, usdcLimit, SOL_KNOWN, { store: t, now: NOW });
    const g = M.solanaSpendingGate({ store: t });
    await g.record(input(500_000n), sig(1), NOW);
    await g.record(input(500_000n), sig(1), NOW);
    verdict('the same signature counted twice', (await M.listSpendRecords(SOL_SCOPE, t)).records.length === 2);
  }
  {
    const M = await mutant('  return isSolanaScopeChain(scope.chain) ? a === b : a.toLowerCase() === b.toLowerCase();', '  return a.toLowerCase() === b.toLowerCase();');
    const t = memoryStore();
    await M.saveSpendingPolicy(SOL_SCOPE, usdcLimit, SOL_KNOWN, { store: t, now: NOW });
    const g = M.solanaSpendingGate({ store: t });
    await g.record(input(500_000n), sig(1), NOW);
    await g.release(input(500_000n), upper);
    verdict('signatures compared without letter case (another signature releases this one)', (await M.listSpendRecords(SOL_SCOPE, t)).records.length === 0);
  }
  {
    const M = await mutant("      if (input.countFees) throw new Error(t('spendingSol.err.fees'));\n", '');
    let message = '';
    try {
      await M.saveSpendingPolicy(SOL_SCOPE, { ...usdcLimit, countFees: true }, SOL_KNOWN, { store: memoryStore(), now: NOW });
    } catch (e) {
      message = e.message;
    }
    verdict('the Solana fee refusal removed (a fee setting no longer refused with the SOL sentence)', !/they are paid in SOL/.test(message));
  }
  {
    const M = await mutant("  if (isSolanaScopeChain(scope.chain) && r.kind !== 'transfer') return false;\n", '');
    verdict('a stored Solana fee record accepted', !(await M.listSpendRecords(SOL_SCOPE, feeHistory)).damaged);
  }
  {
    const M = await mutant('    if (solana) {', '    if (false) {');
    let threw = false;
    try {
      await M.spendingReadouts(SOL_SCOPE, { store: s, now: NOW });
    } catch {
      threw = true;
    }
    verdict('the readouts of a Solana scope sent to the engine with the mint itself (the engine refuses a non-hex token)', threw);
  }
  check(`phase 26 item 3b: every spending-policy.ts mutant caught (${caught} of ${made})`, made >= 7 && caught === made);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

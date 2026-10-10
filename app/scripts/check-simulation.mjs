/**
 * Verification for the balance-change preview (phase 6, item 1): the app
 * glue in src/wallet/simulation.ts over the engine's eth_simulateV1-based
 * simulateAssetChanges. Fully offline: a fake JSON-RPC node behind
 * globalThis.fetch answers eth_simulateV1 and the eth_call metadata reads.
 * Nothing is signed or broadcast.
 *
 * There is deliberately no simulation-URL store to check: the preview runs
 * against the active chain's existing node endpoint (config/networks.ts),
 * so no new persisted setting exists that could hold a bad value.
 *
 * Run from app/: node scripts/check-simulation.mjs
 */
import { AbiCoder, getAddress, id, zeroPadValue } from 'ethers';
import {
  APPROVAL_EVENT_TOPIC,
  APPROVAL_FOR_ALL_EVENT_TOPIC,
  EIP7708_TRANSFER_LOG_ADDRESS,
  MAX_UINT256,
  NATIVE_TRANSFER_PSEUDO_ADDRESS,
  TRANSFER_EVENT_TOPIC,
  TRANSFER_SINGLE_EVENT_TOPIC,
  encodeFunctionCall,
  toHex,
} from '@shiba-wallet/chains-evm';
import {
  MAX_METADATA_LOOKUPS,
  PREVIEW_MALFORMED_NOTE,
  PREVIEW_NO_ENDPOINT_NOTE,
  PREVIEW_UNSUPPORTED_NOTE,
  describeAssetChanges,
  groupThousands,
  revertedNote,
  runBalancePreview,
  sanitizeSymbol,
  shortAddress,
  simulationTransport,
  skippedLogsNote,
} from '../src/wallet/simulation.ts';
import { USDC_MAINNET } from '../src/wallet/erc20.ts';
import { maskAmount } from '../src/config/prefs.ts';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log('  FAIL', name, detail !== undefined ? `\n       got: ${JSON.stringify(detail)}` : '');
  }
}

const coder = AbiCoder.defaultAbiCoder();
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const DEX = '0x1111111111111111111111111111111111111111';
const SPENDER = getAddress('0xdef1c0ded9bec7f1a1670819833240f027b25eff');
const USDC = USDC_MAINNET.assetId.reference; // tracked by default on eip155:1
const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const BROKEN = '0x3333333333333333333333333333333333333333';
const NFT = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const MAINNET = 'eip155:1';
const SEPOLIA = 'eip155:11155111';
const URL = 'https://fake-node.invalid/rpc';

const topicOf = (a) => zeroPadValue(a, 32).toLowerCase();
const word = (v) => coder.encode(['uint256'], [v]);
const log = (address, topics, data = '0x') => ({ address: address.toLowerCase(), topics, data });
const block = (calls) => [{ number: '0x1', calls }];
const okCall = (logs) => ({ returnData: '0x', gasUsed: '0x5208', status: '0x1', logs });

// Selectors computed by the engine, not pasted.
const SEL_DECIMALS = toHex(encodeFunctionCall('decimals()', []));
const SEL_SYMBOL = toHex(encodeFunctionCall('symbol()', []));
const SEL_NAME = toHex(encodeFunctionCall('name()', []));

/**
 * Fake node. `simulate(params)` returns the eth_simulateV1 JSON-RPC body
 * (result or error) plus an optional HTTP status; eth_call answers token
 * metadata for PEPE and reverts decimals() for BROKEN.
 */
const requests = [];
function installFakeNode(simulate) {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    const reply = (payload, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ jsonrpc: '2.0', id: body.id, ...payload }),
    });
    if (body.method === 'eth_simulateV1') {
      const { status, ...payload } = simulate(body.params);
      return reply(payload, status ?? 200);
    }
    if (body.method === 'eth_call') {
      const { to, data } = body.params[0];
      const token = to.toLowerCase();
      if (token === PEPE.toLowerCase() || token === USDC.toLowerCase()) {
        const sym = token === PEPE.toLowerCase() ? 'PEPE' : 'SEPUSDC';
        if (data === SEL_DECIMALS) return reply({ result: word(token === PEPE.toLowerCase() ? 18n : 6n) });
        if (data === SEL_SYMBOL) return reply({ result: coder.encode(['string'], [sym]) });
        if (data === SEL_NAME) return reply({ result: coder.encode(['string'], [`${sym} token`]) });
      }
      return reply({ error: { code: 3, message: 'execution reverted' } });
    }
    return reply({ error: { code: -32601, message: 'Method not found' } });
  };
}

const TRACKED = [USDC_MAINNET];
const texts = (lines) => lines.map((l) => l.text);

// ---------------------------------------------------------------- helpers
console.log('check-simulation: formatting helpers');
check('groupThousands whole', groupThousands('3412') === '3,412');
check('groupThousands fraction untouched', groupThousands('1234567.123456') === '1,234,567.123456');
check('groupThousands small', groupThousands('0.1') === '0.1');
check('shortAddress', shortAddress(SPENDER) === '0xDef1…5EfF', shortAddress(SPENDER));
check('sanitizeSymbol strips control chars', sanitizeSymbol('US\nDC‮') === 'USDC');
check('sanitizeSymbol truncates', sanitizeSymbol('A'.repeat(40)) === `${'A'.repeat(16)}…`);
check('sanitizeSymbol empty -> null', sanitizeSymbol('\n\t') === null);
check('masking helper', maskAmount('0.1', true) === '••••' && maskAmount('0.1', false) === '0.1');

// ---------------------------------------------------------------- transport
console.log('check-simulation: transport');
installFakeNode(() => ({ status: 400, error: { code: -32600, message: 'Unsupported method: eth_simulateV1 on ETH_MAINNET' } }));
{
  let error;
  try {
    await simulationTransport(URL)('eth_simulateV1', []);
  } catch (e) {
    error = e;
  }
  check('HTTP 400 JSON-RPC error body kept (code)', error?.code === -32600, error?.message);
  check('HTTP 400 JSON-RPC error body kept (message)', /Unsupported method/.test(error?.message ?? ''));
}
globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
{
  let error;
  try {
    await simulationTransport(URL)('eth_simulateV1', []);
  } catch (e) {
    error = e;
  }
  check('HTTP 502 without body -> status error', error?.message === 'RPC HTTP error 502 for eth_simulateV1', error?.message);
}

// ---------------------------------------------------------------- native send
console.log('check-simulation: native ETH send');
requests.length = 0;
installFakeNode(() => ({
  result: block([okCall([log(NATIVE_TRANSFER_PSEUDO_ADDRESS, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(DEX)], word(10n ** 17n))])]),
}));
{
  const state = await runBalancePreview({
    url: URL,
    wallet: ME,
    calls: [{ from: ME, to: DEX, value: 10n ** 17n }],
    chainCaip2: MAINNET,
    trackedTokens: TRACKED,
  });
  check('native: ok', state.status === 'ok', state);
  const sim = requests.find((r) => r.body.method === 'eth_simulateV1');
  check('request: method + latest', sim?.body.params[1] === 'latest');
  check('request: traceTransfers true', sim?.body.params[0].traceTransfers === true);
  check('request: no validation key', !('validation' in (sim?.body.params[0] ?? {})));
  check(
    'request: call object',
    JSON.stringify(sim?.body.params[0].blockStateCalls[0].calls[0]) ===
      JSON.stringify({ from: ME, to: DEX, value: '0x16345785d8a0000' }),
    sim?.body.params[0].blockStateCalls,
  );
  const lines = describeAssetChanges(state.changes, state.meta, { nativeSymbol: 'ETH', hidden: false });
  check('native: "You send 0.1 ETH"', JSON.stringify(texts(lines)) === JSON.stringify(['You send 0.1 ETH']), texts(lines));
  check('native: tone out', lines[0]?.tone === 'out');
  const masked = describeAssetChanges(state.changes, state.meta, { nativeSymbol: 'ETH', hidden: true });
  check('native hidden: masked', masked[0]?.text === 'You send •••• ETH', masked[0]?.text);
  const testnet = describeAssetChanges(state.changes, state.meta, { nativeSymbol: 'test ETH', hidden: false });
  check('native: profile symbol', testnet[0]?.text === 'You send 0.1 test ETH');
}

// ---------------------------------------------------------------- EIP-7708
// Since the Glamsterdam upgrade (Sepolia, 2026-10-06) every ETH movement also
// carries the protocol's own Transfer-shaped log from the system address
// 0xff…fe (EIP-7708). The 2026-10-09 rehearsal saw the preview of a 0.002
// test ETH send show a second, bogus row "You send 2000000000000000 raw units
// of token 0xffff…FFfE (decimals unreadable)". Read-only probes the same day
// (packages/chains-evm/test/fixtures/eip7708-sepolia) found three node
// behaviours for one plain transfer under traceTransfers: the protocol log
// only (reth), the 0xeeee… pseudo-log followed by the protocol log (geth
// 1.17.7), and the pseudo-log only (any node before the fork). The preview
// must read ONE native row in every case and never look the address up as a
// token.
console.log('check-simulation: EIP-7708 protocol ETH-transfer logs (Sepolia after Glamsterdam)');
{
  const KERNEL = '0xD31c2C54F21684eE2026a6C41e391130BdEeD8FA';
  const amount = 2_000_000_000_000_000n; // 0.002 test ETH, the rehearsal's send
  const pseudo = log(NATIVE_TRANSFER_PSEUDO_ADDRESS, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(KERNEL)], word(amount));
  const proto = log(EIP7708_TRANSFER_LOG_ADDRESS, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(KERNEL)], word(amount));
  const received = log(KERNEL, [id('Received(address,uint256)')], coder.encode(['address', 'uint256'], [ME, amount]));
  const behaviours = {
    'protocol log only (reth)': [proto, received],
    'pseudo-log then protocol log (geth 1.17.7)': [pseudo, proto, received],
    'pseudo-log only (before the fork)': [pseudo, received],
  };
  check('EIP7708_TRANSFER_LOG_ADDRESS is the system address', EIP7708_TRANSFER_LOG_ADDRESS === '0xfffffffffffffffffffffffffffffffffffffffe');
  for (const [name, logs] of Object.entries(behaviours)) {
    requests.length = 0;
    installFakeNode(() => ({ result: block([okCall(logs)]) }));
    const state = await runBalancePreview({
      url: URL,
      wallet: ME,
      calls: [{ from: ME, to: KERNEL, value: amount }],
      chainCaip2: SEPOLIA,
      trackedTokens: [],
    });
    const lines = texts(describeAssetChanges(state.changes, state.meta, { nativeSymbol: 'test ETH', hidden: false }));
    check(`7708 ${name}: exactly one row "You send 0.002 test ETH"`, JSON.stringify(lines) === JSON.stringify(['You send 0.002 test ETH']), lines);
    check(`7708 ${name}: no "raw units of token 0xffff…FFfE" row`, !lines.some((l) => /raw units|0xffff/i.test(l)), lines);
    check(`7708 ${name}: no token metadata read for 0xff…fe`,
      !requests.some((r) => r.body.method === 'eth_call' && r.body.params[0].to.toLowerCase() === EIP7708_TRANSFER_LOG_ADDRESS), requests.map((r) => r.body.method));
    check(`7708 ${name}: one native change, no erc20`, state.changes.filter((c) => c.type === 'native').length === 1 && !state.changes.some((c) => c.type === 'erc20'), state.changes.map((c) => c.type));
  }
}

// ---------------------------------------------------------------- swap
console.log('check-simulation: swap (ETH -> tracked USDC, untracked PEPE, broken token)');
installFakeNode(() => ({
  result: block([
    okCall([
      log(NATIVE_TRANSFER_PSEUDO_ADDRESS, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(DEX)], word(10n ** 18n)),
      log(USDC, [TRANSFER_EVENT_TOPIC, topicOf(DEX), topicOf(ME)], word(3_412_180_000n)),
      log(USDC, [TRANSFER_EVENT_TOPIC, topicOf(DEX), topicOf(ME)], word(1n)), // summed with the above
      log(PEPE, [TRANSFER_EVENT_TOPIC, topicOf(DEX), topicOf(ME)], word(123_456_789n * 10n ** 18n + 5n)),
      log(BROKEN, [TRANSFER_EVENT_TOPIC, topicOf(DEX), topicOf(ME)], word(1_000_000n)),
      log(NFT, [TRANSFER_EVENT_TOPIC, topicOf(ME), topicOf(DEX), word(1234n)]),
      log(NFT, [TRANSFER_SINGLE_EVENT_TOPIC, topicOf(DEX), topicOf(DEX), topicOf(ME)], coder.encode(['uint256', 'uint256'], [7n, 5n])),
      log(USDC, [TRANSFER_EVENT_TOPIC], coder.encode(['address', 'address', 'uint256'], [ME, DEX, 1n])), // non-standard
      log(DEX, [id('Swap(address,uint256)'), topicOf(ME)], word(1n)), // unrelated event
    ]),
  ]),
}));
{
  const state = await runBalancePreview({
    url: URL,
    wallet: ME,
    calls: [{ from: ME, to: DEX, value: 10n ** 18n, data: new Uint8Array([1, 2, 3, 4]) }],
    chainCaip2: MAINNET,
    trackedTokens: TRACKED,
  });
  check('swap: ok', state.status === 'ok', state);
  check('swap: tracked USDC meta from store (no eth_call needed)', state.meta[USDC.toLowerCase()]?.tracked === true);
  check('swap: PEPE meta via eth_call', state.meta[PEPE.toLowerCase()]?.symbol === 'PEPE' && state.meta[PEPE.toLowerCase()]?.decimals === 18);
  check('swap: broken decimals -> null (never guessed)', state.meta[BROKEN.toLowerCase()]?.decimals === null);
  check('swap: skipped non-standard log counted', state.skippedLogs === 1);
  const lines = texts(describeAssetChanges(state.changes, state.meta, { nativeSymbol: 'ETH', hidden: false }));
  const expected = [
    'You send 1 ETH',
    `You send NFT #1234 (${shortAddress(NFT)})`,
    'You receive 3,412.180001 USDC',
    `You receive 123,456,789.000000000000000005 PEPE (untracked token ${shortAddress(PEPE)})`,
    `You receive 1000000 raw units of token ${shortAddress(BROKEN)} (decimals unreadable)`,
    `You receive 5 × NFT #7 (${shortAddress(NFT)})`,
  ];
  check('swap: plain-language lines (exact, grouped, summed)', JSON.stringify(lines) === JSON.stringify(expected), lines);
  const hidden = texts(describeAssetChanges(state.changes, state.meta, { nativeSymbol: 'ETH', hidden: true }));
  check(
    'swap hidden: every amount masked, ids visible',
    JSON.stringify(hidden) ===
      JSON.stringify([
        'You send •••• ETH',
        `You send NFT #1234 (${shortAddress(NFT)})`,
        'You receive •••• USDC',
        `You receive •••• PEPE (untracked token ${shortAddress(PEPE)})`,
        `You receive •••• raw units of token ${shortAddress(BROKEN)} (decimals unreadable)`,
        `You receive •••• × NFT #7 (${shortAddress(NFT)})`,
      ]),
    hidden,
  );
  check('skipped note text', skippedLogsNote(1).startsWith('1 token event used a non-standard format'));
}

// ---------------------------------------------------------------- approvals
console.log('check-simulation: approvals');
installFakeNode(() => ({
  result: block([
    okCall([
      log(USDC, [APPROVAL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(MAX_UINT256)),
      log(USDC, [APPROVAL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(12_500_000n)),
      log(USDC, [APPROVAL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(0n)),
      log(USDC, [APPROVAL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(MAX_UINT256 - 1n)),
      log(NFT, [APPROVAL_FOR_ALL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(1n)),
      log(NFT, [APPROVAL_FOR_ALL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER)], word(0n)),
      log(NFT, [APPROVAL_EVENT_TOPIC, topicOf(ME), topicOf(SPENDER), word(42n)]),
      log(NFT, [APPROVAL_EVENT_TOPIC, topicOf(ME), topicOf('0x0000000000000000000000000000000000000000'), word(43n)]),
    ]),
  ]),
}));
{
  const state = await runBalancePreview({
    url: URL,
    wallet: ME,
    calls: [{ from: ME, to: USDC, value: 0n }],
    chainCaip2: MAINNET,
    trackedTokens: TRACKED,
  });
  check('approvals: ok', state.status === 'ok', state);
  const lines = describeAssetChanges(state.changes, state.meta, { nativeSymbol: 'ETH', hidden: false });
  const sp = shortAddress(SPENDER);
  const nft = shortAddress(NFT);
  const expected = [
    [`Approval: ${sp} may spend UNLIMITED USDC`, 'warning'],
    [`Approval: ${sp} may spend up to 12.5 USDC`, 'approval'],
    [`Approval revoked: ${sp} may no longer spend USDC`, 'neutral'],
    [
      `Approval: ${sp} may spend up to ${groupThousands('115792089237316195423570985008687907853269984665640564039457584007913129.639934')} USDC (effectively unlimited)`,
      'warning',
    ],
    [`Approval: ${sp} may transfer ALL your NFTs in ${nft}`, 'warning'],
    [`Approval revoked: ${sp} may no longer transfer your NFTs in ${nft}`, 'neutral'],
    [`Approval: ${sp} may transfer your NFT #42 (${nft})`, 'approval'],
    [`Approval cleared for your NFT #43 (${nft})`, 'neutral'],
  ];
  const got = lines.map((l) => [l.text, l.tone]);
  check('approvals: lines + tones (unlimited flagged as warning)', JSON.stringify(got) === JSON.stringify(expected), got);
  const hidden = texts(describeAssetChanges(state.changes, state.meta, { nativeSymbol: 'ETH', hidden: true }));
  check('approvals hidden: UNLIMITED stays visible', hidden[0] === `Approval: ${sp} may spend UNLIMITED USDC`, hidden[0]);
  check('approvals hidden: finite amount masked', hidden[1] === `Approval: ${sp} may spend up to •••• USDC`, hidden[1]);
}

// ---------------------------------------------------------------- active-chain rule
console.log('check-simulation: Sepolia never borrows mainnet token metadata');
installFakeNode(() => ({
  result: block([okCall([log(USDC, [TRANSFER_EVENT_TOPIC, topicOf(DEX), topicOf(ME)], word(2_000_000n))])]),
}));
{
  requests.length = 0;
  const state = await runBalancePreview({
    url: URL,
    wallet: ME,
    calls: [{ from: ME, to: DEX, value: 0n }],
    chainCaip2: SEPOLIA,
    trackedTokens: TRACKED, // mainnet-only entry at the same address
  });
  check('sepolia: tracked=false for same-address contract', state.meta?.[USDC.toLowerCase()]?.tracked === false, state.meta);
  check('sepolia: metadata read on-chain instead', requests.some((r) => r.body.method === 'eth_call'));
  const lines = texts(describeAssetChanges(state.changes, state.meta, { nativeSymbol: 'test ETH', hidden: false }));
  check('sepolia: labeled untracked with on-chain symbol', lines[0] === `You receive 2 SEPUSDC (untracked token ${shortAddress(USDC)})`, lines);
}

// ---------------------------------------------------------------- metadata cap
console.log('check-simulation: metadata lookup cap');
{
  const many = Array.from({ length: MAX_METADATA_LOOKUPS + 3 }, (_, i) => `0x${(i + 16).toString(16).padStart(40, '0')}`);
  installFakeNode(() => ({
    result: block([okCall(many.map((t) => log(t, [TRANSFER_EVENT_TOPIC, topicOf(DEX), topicOf(ME)], word(1n))))]),
  }));
  requests.length = 0;
  const state = await runBalancePreview({ url: URL, wallet: ME, calls: [{ from: ME, to: DEX }], chainCaip2: MAINNET, trackedTokens: [] });
  const decimalsCalls = requests.filter((r) => r.body.method === 'eth_call' && r.body.params[0].data === SEL_DECIMALS).length;
  check('cap: at most MAX_METADATA_LOOKUPS decimals() reads', decimalsCalls === MAX_METADATA_LOOKUPS, decimalsCalls);
  check('cap: every token still listed (raw units)', state.changes.length === many.length);
}

// ---------------------------------------------------------------- smart account
console.log('check-simulation: smart-account (AA) path');
{
  const SENDER = '0xB8370410CCFc0c8A6069a60ccFBeb6D2e2130fa2';
  installFakeNode(() => ({
    result: block([okCall([log(NATIVE_TRANSFER_PSEUDO_ADDRESS, [TRANSFER_EVENT_TOPIC, topicOf(SENDER), topicOf(DEX)], word(5n * 10n ** 15n))])]),
  }));
  requests.length = 0;
  const state = await runBalancePreview({
    url: URL,
    wallet: SENDER,
    calls: [{ from: SENDER, to: DEX, value: 5n * 10n ** 15n }],
    chainCaip2: SEPOLIA,
    trackedTokens: TRACKED,
  });
  const sim = requests.find((r) => r.body.method === 'eth_simulateV1');
  check('aa: simulated from the smart-account sender', sim?.body.params[0].blockStateCalls[0].calls[0].from === SENDER);
  const lines = texts(describeAssetChanges(state.changes, state.meta, { nativeSymbol: 'test ETH', hidden: false }));
  check('aa: relative to the smart account', lines[0] === 'You send 0.005 test ETH', lines);
}

// ---------------------------------------------------------------- degradation
console.log('check-simulation: honest degradation');
const base = { wallet: ME, calls: [{ from: ME, to: DEX, value: 1n }], chainCaip2: MAINNET, trackedTokens: TRACKED };
{
  const s = await runBalancePreview({ ...base, url: null });
  check('no endpoint -> unavailable note', s.status === 'unavailable' && s.note === PREVIEW_NO_ENDPOINT_NOTE, s);
}
installFakeNode(() => ({ error: { code: -32601, message: 'Method not found' } })); // publicnode's live shape
{
  const s = await runBalancePreview({ ...base, url: URL });
  check('method not found -> unsupported note', s.status === 'unavailable' && s.note === PREVIEW_UNSUPPORTED_NOTE, s);
  check(
    'unsupported note wording',
    PREVIEW_UNSUPPORTED_NOTE === 'Balance-change preview unavailable: this RPC endpoint does not support eth_simulateV1.',
  );
}
installFakeNode(() => ({ status: 400, error: { code: -32600, message: 'Unsupported method: eth_simulateV1 on ETH_MAINNET' } }));
{
  const s = await runBalancePreview({ ...base, url: URL });
  check('HTTP 400 "Unsupported method" -> unsupported note', s.status === 'unavailable' && s.note === PREVIEW_UNSUPPORTED_NOTE, s);
}
installFakeNode(() => ({ result: { not: 'an array' } }));
{
  const s = await runBalancePreview({ ...base, url: URL });
  check('malformed -> malformed note', s.status === 'unavailable' && s.note === PREVIEW_MALFORMED_NOTE, s);
}
installFakeNode(() => ({ error: { code: -38014, message: 'insufficient funds for gas * price + value: have 0 want 1' } }));
{
  const s = await runBalancePreview({ ...base, url: URL });
  check('other RPC error -> error with message', s.status === 'error' && /insufficient funds/.test(s.message), s);
}
installFakeNode(() => ({
  result: block([
    {
      returnData: '0x',
      logs: [],
      gasUsed: '0x8da9',
      status: '0x0',
      error: {
        code: 3,
        message: 'execution reverted: ERC20: transfer amount exceeds balance',
        data: '0x08c379a0' + coder.encode(['string'], ['ERC20: transfer amount exceeds balance']).slice(2),
      },
    },
  ]),
}));
{
  const s = await runBalancePreview({ ...base, url: URL });
  check('revert -> reverted with decoded reason', s.status === 'reverted' && s.reason === 'reverted: ERC20: transfer amount exceeds balance', s);
  check('reverted note mentions the fee', /apart from the network fee/.test(revertedNote('x')));
}
globalThis.fetch = async () => {
  throw new TypeError('Network request failed');
};
{
  const s = await runBalancePreview({ ...base, url: URL });
  check('network failure -> error, never throws', s.status === 'error' && s.message === 'Network request failed', s);
}
installFakeNode(() => ({ result: block([okCall([])]) }));
{
  const s = await runBalancePreview({ ...base, url: URL });
  const lines = describeAssetChanges(s.changes, s.meta, { nativeSymbol: 'ETH', hidden: false });
  check('no wallet-relevant events -> no lines', s.status === 'ok' && lines.length === 0);
}

console.log(`\ncheck-simulation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

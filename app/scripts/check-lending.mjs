// Exercises the lending glue (src/wallet/lending.ts, phase 26 item 2, the
// app half; docs/LENDING_VAULTS.md sections 7 and 10) entirely OFFLINE: the
// engine's own recording of Aave v3's Arbitrum Sepolia market
// (packages/chains-evm/test/fixtures/lending-arbitrum-sepolia-2026-11-09.json,
// 22 read-only JSON-RPC answers at one block plus the logs of the live supply
// and withdrawal) replayed by method and parameters, so the engine's reader
// must ask exactly what it asked live; the fake Kernel node and bundler of
// fakes-kernel.mjs; and the REAL send paths (prepareEvmSend / prepareAaCalls
// / sendAa). Covered: the offer per network and the readiness gate, the
// owner refusals, the reserve and the position read at one block, the
// quotes against the recording, checkLendingCalls before anything is quoted,
// the approve-then-supply order, the one-batch form, the withdrawal, the
// prompt titles, the error wording, the receipt sentences, the screen's
// source pins and the Home link, every sentence of the screen's block in
// both tables, and mutants of lending.ts (each must be caught).
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-lending.mjs
//
// The signing keys derive from the standard BIP-39 test mnemonic
// ("abandon … about"), which is public knowledge.

import { Interface, getBytes } from 'ethers';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import { AAVE_WITHDRAW_ALL, KERNEL_V3_3, LENDING_DEPLOYMENTS, LENDING_REFUSALS, quoteLendingSupply, toHex } from '@shiba-wallet/chains-evm';
import * as L from '../src/wallet/lending.ts';
import { GasEstimateRevertError } from '../src/wallet/send.ts';
import { addAaOperationSentListener, createAaClientFromConfig, sendAa } from '../src/wallet/aa.ts';
import { featureReadiness, isFeatureAllowed, readinessRefusal } from '../src/config/readiness.ts';
import { watchOnlyRouteRefusal } from '../src/wallet/watch-only.ts';
import { en } from '../src/i18n/en.ts';
import { es } from '../src/i18n/es.ts';
import { setActiveLanguage } from '../src/i18n/index.ts';
import { KERNEL_ACCOUNT_0, OWNER_0, TEST_MNEMONIC, decodeKernelExecute, fakeBundler, fakeKernelNode } from './fakes-kernel.mjs';

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
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO = resolve(APP_ROOT, '..');
const read = (rel) => readFileSync(join(APP_ROOT, rel), 'utf8');

// Mutants of src/wallet/lending.ts, loaded from a scratch directory with the
// relative imports rewritten to the real files (the check-staking pattern).
const MUTANT_DIR = join(HERE, `.mutants-lending-${process.pid}`);
let mutantCount = 0;
let mutantsCaught = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
const LENDING_SOURCE = read('src/wallet/lending.ts');
async function lendingMutant(from, to) {
  if (!LENDING_SOURCE.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const mutated = LENDING_SOURCE.replace(from, to);
  const originalDir = join(APP_ROOT, 'src/wallet');
  const rewritten = mutated.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolve(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-lending.ts`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
function caught(name, condition) {
  if (condition) mutantsCaught += 1;
  check(`MUTANT (${name}) is caught`, condition);
}

// ---------------------------------------------------------------------------
// The recording and the fake node
// ---------------------------------------------------------------------------
const FIXTURE = JSON.parse(readFileSync(join(REPO, 'packages/chains-evm/test/fixtures/lending-arbitrum-sepolia-2026-11-09.json'), 'utf8'));
const ARB = 'eip155:421614';
const D = LENDING_DEPLOYMENTS[ARB];
const TAG = '0x' + BigInt(FIXTURE.block).toString(16);
const DEV = '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C'; // the fixture's account (an address only)
const OTHER = '0x2222222222222222222222222222222222222222';
const RECORDED = new Map(FIXTURE.calls.map((c) => [JSON.stringify([c.method, c.params]), c.result]));
const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const balanceKey = (token, holder) =>
  JSON.stringify(['eth_call', [{ to: token, data: '0x70a08231' + holder.toLowerCase().slice(2).padStart(64, '0') }, TAG]]);

/**
 * A node answering the recorded reads (method and params exactly), the
 * head as the recording's block, `overrides` by key, and the send flow's
 * queries (fees, nonce, estimate, the latest-block eth_call pre-flight and
 * the allowance read, broadcasts and receipts).
 */
function lendNode({ chainIdHex = '0x66eee', overrides = {}, allowance = 0n, heads = [TAG], preflight = null } = {}) {
  // `preflight`: the message a node gives for the latest-block eth_call (the send's pre-flight) when it reverts.
  const calls = [];
  let headIndex = 0;
  const transport = async (method, params) => {
    calls.push({ method, params });
    const key = JSON.stringify([method, params]);
    if (key in overrides) return overrides[key];
    switch (method) {
      case 'eth_chainId':
        return chainIdHex;
      case 'eth_blockNumber': {
        const head = heads[Math.min(headIndex, heads.length - 1)];
        headIndex += 1;
        return head;
      }
      case 'eth_getBalance':
        return '0x' + (10n ** 17n).toString(16);
      case 'eth_getTransactionCount':
        return '0x3';
      case 'eth_getBlockByNumber':
        return { baseFeePerGas: '0x1312d00' };
      case 'eth_maxPriorityFeePerGas':
        return '0x0';
      case 'eth_estimateGas':
        return '0x35000';
      case 'eth_sendRawTransaction':
        transport.lastRaw = params[0];
        return '0x' + 'cd'.repeat(32);
      case 'eth_getTransactionReceipt':
        return transport.receipt ?? null;
      case 'eth_call':
        if (params[1] === 'latest') {
          if (String(params[0].data).startsWith('0xdd62ed3e')) return word(allowance);
          if (preflight) throw new Error(preflight);
          return '0x';
        }
        break;
      default:
        break;
    }
    if (!RECORDED.has(key)) throw new Error(`the recording has no answer for ${key.slice(0, 160)}`);
    return RECORDED.get(key);
  };
  transport.calls = calls;
  return transport;
}

// The EOA paths build fetch-based transports from a URL; route them here.
const RPC_URL = 'https://lending-node.example/rpc';
let fetchNode = null;
let fetchCount = 0;
globalThis.fetch = async (_url, init) => {
  fetchCount += 1;
  const { method, params, id } = JSON.parse(init.body);
  let body;
  try {
    if (!fetchNode) throw new Error('no fake node installed');
    body = { jsonrpc: '2.0', id, result: await fetchNode(method, params) };
  } catch (e) {
    body = { jsonrpc: '2.0', id, error: { code: 3, message: e.message, ...(e.data ? { data: e.data } : {}) } };
  }
  return { ok: true, status: 200, json: async () => body };
};

const seed = mnemonicToSeed(TEST_MNEMONIC);
const owner = evmKeyProvider.deriveAccount(seed, 0, 0);
seed.fill(0);

const erc20 = new Interface(['function approve(address,uint256)']);
const pool = new Interface(['function supply(address,uint256,address,uint16)', 'function withdraw(address,uint256,address)']);
const supplyAction = (amount) => ({ kind: 'supply', amount });

// ---------------------------------------------------------------------------
console.log('check-lending: readiness and what is offered where');
// ---------------------------------------------------------------------------
{
  const row = featureReadiness('lending');
  check('readiness row "lending": "Lending (Aave v3 supply and withdraw)", testnet-only, enforced, evidence W1 W2 W9 W13 T-96',
    row.title === 'Lending (Aave v3 supply and withdraw)' && row.status === 'testnet-only' && row.enforced === true && row.evidence.join() === 'W1,W2,W9,W13,T-96');
  check('the row\'s title and reason are the table entries (English)', en['readiness.lending.title'] === row.title && en['readiness.lending.reason'] === row.reason);
  check('lending: refused on mainnet, allowed on Arbitrum Sepolia', !isFeatureAllowed('lending', 'eip155:1') && isFeatureAllowed('lending', ARB));

  const arb = L.lendingOfferFor(ARB);
  check('Arbitrum Sepolia: offered with the engine\'s deployment (Aave v3, the pinned Pool)', arb.ok === true && arb.deployment === D && D.pool === '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff');
  const main = L.lendingOfferFor('eip155:1');
  check('mainnet: the readiness refusal, word for word', main.ok === false && main.reason === 'readiness' && main.text === readinessRefusal('lending'));
  const expectNot = (caip2, label) => {
    const o = L.lendingOfferFor(caip2);
    return o.ok === false && o.reason === 'network' && o.text === LENDING_REFUSALS.notOffered(label) &&
      o.text === `Lending is offered only on Arbitrum Sepolia in this version: no Aave market is pinned for ${label}.`;
  };
  check('Ethereum Sepolia, Base Sepolia, OP Sepolia and Hoodi: the engine\'s "offered only on Arbitrum Sepolia" sentence',
    expectNot('eip155:11155111', 'Ethereum Sepolia') && expectNot('eip155:84532', 'Base Sepolia') && expectNot('eip155:11155420', 'OP Sepolia') && expectNot('eip155:560048', 'Hoodi'));
  check('an unknown network id is offered nothing (its CAIP-2 id named)', (() => {
    const o = L.lendingOfferFor('eip155:999999');
    return o.ok === false && o.reason === 'readiness';
  })());
  fetchCount = 0;
  const e = await rejection(async () => L.requireLendingDeployment('eip155:1'));
  check('requireLendingDeployment on mainnet: FeatureNotAllowedError, before any request', e?.name === 'FeatureNotAllowedError' && fetchCount === 0);
  const e2 = await rejection(async () => L.requireLendingDeployment('eip155:11155111'));
  check('…on Ethereum Sepolia: a LendingRefusal with the offer\'s sentence', e2 instanceof L.LendingRefusal && e2.message === LENDING_REFUSALS.notOffered('Ethereum Sepolia'));
}

// ---------------------------------------------------------------------------
console.log('check-lending: who may lend');
// ---------------------------------------------------------------------------
{
  check('no account: "There is no Ethereum account to lend from."', L.lendingAccountRefusal(null) === 'There is no Ethereum account to lend from.');
  check('a watch-only address is refused (exact)', L.lendingAccountRefusal({ watchOnly: true }) ===
    'A watch-only address cannot lend: supplying and withdrawing sign from the address, and this wallet holds no key for it.');
  check('a multi-signature account is refused (exact)', L.lendingAccountRefusal({ watchOnly: false, multisig: true }) ===
    'A multi-signature account cannot lend from this screen: no single key in this wallet signs for it.');
  check('a regular (phrase or imported) account may lend', L.lendingAccountRefusal({ watchOnly: false, multisig: false }) === null);
  check('the Home link: Arbitrum Sepolia for a regular account only; never on Sepolia or mainnet, never for watch-only or multisig',
    L.lendingLinkShown(ARB, { watchOnly: false }) && !L.lendingLinkShown(ARB, { watchOnly: true }) && !L.lendingLinkShown(ARB, { watchOnly: false, multisig: true }) &&
      !L.lendingLinkShown('eip155:11155111', { watchOnly: false }) && !L.lendingLinkShown('eip155:1', { watchOnly: false }) && !L.lendingLinkShown(ARB, null));
  const smart = (type, configured, chain = ARB) => L.lendingSmartAccountRefusal(chain, type, configured);
  check('the smart account: a configured Kernel v3.3 (factory-derived or recovered) may lend', smart('kernel-v3.3', true) === null);
  check('…an EIP-7702-upgraded owner is refused (exact)', smart('kernel-7702', true) ===
    'This account is upgraded with EIP-7702, so its smart account is the regular address itself: lend from the regular account.');
  check('…SimpleAccount is refused (exact)', smart('simple', true) === 'A SimpleAccount smart account is not offered for lending in this version; only a Kernel v3.3 smart account is.');
  check('…a multisig account type is refused with the multisig sentence', smart('kernel-multisig', true) === L.lendingAccountRefusal({ watchOnly: false, multisig: true }));
  check('…none set up (or not configured) is refused (exact)', smart(null, false) === smart('kernel-v3.3', false) &&
    smart(null, false) === 'Lending from a smart account needs a Kernel v3.3 smart account set up for this network in Settings; the regular account can lend without one.');
  check('…a profile without verified Kernel contracts (Hoodi) is refused first', smart('kernel-v3.3', true, 'eip155:560048') ===
    'Lending from a smart account is offered only where the wallet has verified the Kernel smart-account contracts.');
}

// ---------------------------------------------------------------------------
console.log('check-lending: the reserve and the position, replayed from the 2026-11-09 recording');
// ---------------------------------------------------------------------------
{
  const node = lendNode();
  const view = await L.readLendingView(node, ARB, DEV);
  const s = view.state;
  const f = FIXTURE.state;
  check('the reserve equals the engine\'s recorded state (block, flags, cap, supply counted against the cap, liquidity, rate)',
    s.block === BigInt(f.block) && s.active === f.active && s.frozen === f.frozen && s.paused === f.paused && s.supplyCapBaseUnits === BigInt(f.supplyCapBaseUnits) &&
      s.suppliedForCap === BigInt(f.suppliedForCap) && s.availableLiquidity === BigInt(f.availableLiquidity) && s.liquidityRateRay === BigInt(f.liquidityRateRay));
  check('the position equals the recording (0 supplied, 38 USDC held)', view.position.supplied === 0n && view.position.walletBalance === 38_000_000n);
  check('ONE head read: the position is read at the reserve\'s block, not a later one', node.calls.filter((c) => c.method === 'eth_blockNumber').length === 1 &&
    node.calls.filter((c) => c.method === 'eth_call' && String(c.params[0].data).startsWith('0x70a08231')).every((c) => c.params[1] === TAG));
  check('the chain id is checked before anything else is read', node.calls[0].method === 'eth_chainId');
  const lines = L.reserveStateLines(view);
  const WANT = [
    'Read just now, at block 327688948, with every pinned contract checked first.',
    'Active, not frozen and not paused: it accepts supply and withdrawal.',
    'Supply cap 10500000 USDC; about 5576905.511233 USDC is supplied, so about 4923094.488767 USDC more can be supplied (an estimate at this block).',
    'Withdrawable at once: 855825.783201 USDC (the rest is lent out).',
    'Supply rate when read: about 4.29% a year, variable.',
  ];
  check('the reserve card\'s lines (exact, from the recording)', JSON.stringify(lines) === JSON.stringify(WANT), JSON.stringify(lines));
  check('frozen / paused / inactive wording', L.reserveStateLines({ deployment: D, state: { ...s, frozen: true } })[1] === 'Frozen: it accepts no new supply; withdrawals are still allowed.' &&
    L.reserveStateLines({ deployment: D, state: { ...s, paused: true } })[1] === 'Paused: it accepts no supply and no withdrawal until it is unpaused.' &&
    L.reserveStateLines({ deployment: D, state: { ...s, active: false } })[1] === 'Not active: it accepts no supply and no withdrawal.');
  check('supplyRatePercent rounds down to hundredths', L.supplyRatePercent(42997965653710878940637341n) === '4.29' && L.supplyRatePercent(0n) === '0.00' && L.supplyRatePercent(10n ** 25n) === '1.00');

  const wrong = await rejection(() => L.readLendingView(lendNode({ chainIdHex: '0xaa36a7' }), ARB, DEV));
  check('an endpoint serving another chain is refused before any reserve read (exact)', wrong instanceof L.LendingRefusal &&
    wrong.message === 'The network endpoint serves chain id 11155111, not the network this screen is on. Nothing was quoted.');
  const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const replaced = await rejection(() =>
    L.readLendingView(lendNode({ overrides: { [JSON.stringify(['eth_getStorageAt', [D.pool, IMPL_SLOT, TAG]])]: word(OTHER) } }), ARB, DEV));
  check('a replaced Pool implementation: the engine\'s state check becomes a LendingRefusal naming it', replaced instanceof L.LendingRefusal &&
    replaced.message.startsWith('Aave’s contracts on this network are not what this wallet was checked against, so nothing is offered. ') &&
    replaced.message.includes(`now runs the implementation ${'0x2222222222222222222222222222222222222222'}`));
  const mainnet = await rejection(() => L.readLendingView(lendNode(), 'eip155:1', DEV));
  check('readLendingView on mainnet refuses before any request', mainnet?.name === 'FeatureNotAllowedError');
}

// ---------------------------------------------------------------------------
console.log('check-lending: plans — the engine\'s quotes, checked before anything is quoted');
// ---------------------------------------------------------------------------
{
  const plan = await L.planLending(lendNode(), ARB, DEV, supplyAction(100_000n));
  const view = await L.readLendingView(lendNode(), ARB, DEV);
  const direct = quoteLendingSupply({ deployment: D, state: view.state, account: DEV, amount: 100_000n, walletBalance: view.position.walletBalance });
  check('a 0.1 USDC supply: exactly the engine\'s quote ([exact approve, supply])',
    plan.calls.length === 2 && plan.calls.every((c, i) => c.to === direct.calls[i].to && toHex(c.data) === toHex(direct.calls[i].data) && c.value === 0n));
  check('…approve(Pool, 100000) on USDC and supply(USDC, 100000, the account, 0) on the Pool (ethers)',
    same(plan.calls[0].to, D.asset.address) && toHex(plan.calls[0].data) === erc20.encodeFunctionData('approve', [D.pool, 100_000n]) &&
      same(plan.calls[1].to, D.pool) && toHex(plan.calls[1].data) === pool.encodeFunctionData('supply', [D.asset.address, 100_000n, DEV, 0]));
  check('…the exact approval and the USDC outflow named on the plan', plan.approval?.amount === 100_000n && same(plan.approval?.spender, D.pool) && plan.tokenOutflow?.amount === 100_000n && plan.main === plan.calls[1]);

  const above = await rejection(() => L.planLending(lendNode(), ARB, DEV, supplyAction(39_000_000n)));
  check('more than the account holds: the engine\'s sentence, nothing quoted', above instanceof L.LendingRefusal &&
    above.message === 'This account holds 38 USDC, less than the 39 USDC to supply. Nothing was signed.');
  const zero = await rejection(() => L.planLending(lendNode(), ARB, DEV, supplyAction(0n)));
  check('zero: "Enter an amount greater than zero."', zero instanceof L.LendingRefusal && zero.message === 'Enter an amount greater than zero.');
  const none = await rejection(() => L.planLending(lendNode(), ARB, DEV, { kind: 'withdraw', amount: 'all' }));
  check('withdraw everything with no position: "…no USDC supplied to Aave on Arbitrum Sepolia, so there is nothing to withdraw."',
    none instanceof L.LendingRefusal && none.message === 'This account has no USDC supplied to Aave on Arbitrum Sepolia, so there is nothing to withdraw.');

  const withPosition = { [balanceKey(D.aToken.address, DEV)]: word(100_000n) };
  const w = await L.planLending(lendNode({ overrides: withPosition }), ARB, DEV, { kind: 'withdraw', amount: 40_000n });
  check('a withdrawal of 0.04 USDC with 0.1 supplied: one withdraw(USDC, 40000, the account), no approval', w.calls.length === 1 && w.approval === null && w.tokenOutflow === null &&
    toHex(w.calls[0].data) === pool.encodeFunctionData('withdraw', [D.asset.address, 40_000n, DEV]));
  const all = await L.planLending(lendNode({ overrides: withPosition }), ARB, DEV, { kind: 'withdraw', amount: 'all' });
  check('"Withdraw all": withdraw(USDC, the maximum value, the account), amount shown = the position read now',
    all.quote.all === true && all.quote.amount === 100_000n && toHex(all.calls[0].data) === pool.encodeFunctionData('withdraw', [D.asset.address, AAVE_WITHDRAW_ALL, DEV]));
  const tooMuch = await rejection(() => L.planLending(lendNode({ overrides: withPosition }), ARB, DEV, { kind: 'withdraw', amount: 100_001n }));
  check('more than the position: the engine\'s sentence', tooMuch instanceof L.LendingRefusal &&
    tooMuch.message === 'This account has 0.1 USDC supplied to Aave (its aArbSepUSDC balance), less than the 0.100001 USDC to withdraw. Nothing was signed.');

  // checkLendingCalls in planLending: the plan exists only after it ran (a source pin; the engine's quotes are always well formed).
  const body = LENDING_SOURCE.slice(LENDING_SOURCE.indexOf('export async function planLending'), LENDING_SOURCE.indexOf('// Reshaping into the existing send paths'));
  check('planLending runs checkLendingCalls on the quoted calls BEFORE the plan is returned',
    body.indexOf('checkLendingCalls(quote.calls, d, holder)') > body.indexOf('quoteLendingSupply(') && body.indexOf('checkLendingCalls(quote.calls, d, holder)') < body.indexOf('return {') &&
      /if \(problems\.length > 0\) throw new LendingRefusal/.test(body));
  check('…and its refusals come from the engine\'s quote (no sentence re-built here)', body.includes('if (quote.refusals.length > 0) throw new LendingRefusal(quote.refusals.join(\' \'));'));
  check('the call words: two numbered lines for a supply (exact)', JSON.stringify(L.lendingCallLines(plan)) === JSON.stringify([
    `1. Approve Aave’s Pool on Arbitrum Sepolia (${D.pool}) to take exactly 0.1 USDC from this account, never more (token contract ${D.asset.address}).`,
    `2. Supply 0.1 USDC to Aave’s Pool on Arbitrum Sepolia (${D.pool}), credited to this account ${DEV}, which receives aArbSepUSDC (supply, selector 0x617ba037).`,
  ]), JSON.stringify(L.lendingCallLines(plan)));
  check('…one unnumbered line for "Withdraw all" (exact)', L.lendingCallLines(all)[0] ===
    `Withdraw your whole USDC position from Aave’s Pool on Arbitrum Sepolia (${D.pool}), paid to this account ${DEV} (withdraw with the maximum amount, selector 0x69328dec).`);
}

// ---------------------------------------------------------------------------
console.log('check-lending: the regular account — the exact approve first, then the supply (through prepareEvmSend)');
// ---------------------------------------------------------------------------
{
  const plan = await L.planLending(lendNode(), ARB, DEV, supplyAction(100_000n));
  fetchNode = lendNode({ allowance: 0n });
  const step1 = await L.prepareLendingSend(RPC_URL, DEV, plan);
  check('allowance 0: step 1 is the EXACT approve (to USDC, value 0, approve(Pool, 100000)), pre-flight passed',
    step1.step === 'approve' && same(step1.quote.to, D.asset.address) && step1.quote.amount === 0n &&
      toHex(step1.quote.data) === erc20.encodeFunctionData('approve', [D.pool, 100_000n]) && step1.quote.simulation.ok === true);
  fetchNode = lendNode({ allowance: 99_999n });
  check('an allowance one unit short: still the approve', (await L.prepareLendingSend(RPC_URL, DEV, plan)).step === 'approve');
  fetchNode = lendNode({ allowance: 100_000n });
  const step2 = await L.prepareLendingSend(RPC_URL, DEV, plan);
  check('once the approval is in place: the supply (to the Pool, the supply calldata)',
    step2.step === 'main' && same(step2.quote.to, D.pool) && toHex(step2.quote.data) === toHex(plan.main.data) && step2.quote.amount === 0n);
  const other = await rejection(() => L.prepareLendingSend(RPC_URL, OTHER, plan));
  check('a plan read for another address is refused (exact)', other instanceof L.LendingRefusal && other.message === 'This lending plan was prepared for another address. Nothing was quoted.');
  // A tampered plan: the supply credited to another address. The check before the quote refuses it before any request.
  const tampered = { ...plan, main: { ...plan.main, data: getBytes(pool.encodeFunctionData('supply', [D.asset.address, 100_000n, OTHER, 0])) } };
  tampered.calls = [plan.calls[0], tampered.main];
  fetchNode = lendNode({ allowance: 100_000n });
  const before = fetchNode;
  const refused = await rejection(() => L.prepareLendingSend(RPC_URL, DEV, tampered));
  check('a tampered plan (supply credited to another address) is refused by checkLendingCalls before the quote',
    refused instanceof L.LendingRefusal && refused.message.startsWith('The calls failed the wallet’s check before signing, so nothing was quoted. ') &&
      refused.message.includes(LENDING_REFUSALS.supplyRecipient('0x2222222222222222222222222222222222222222')) &&
      !before.calls.some((c) => c.method === 'eth_estimateGas'));
  const withdraw = await L.planLending(lendNode({ overrides: { [balanceKey(D.aToken.address, DEV)]: word(100_000n) } }), ARB, DEV, { kind: 'withdraw', amount: 'all' });
  fetchNode = lendNode();
  const wq = await L.prepareLendingSend(RPC_URL, DEV, withdraw);
  check('a withdrawal: one step, no allowance read', wq.step === 'main' && same(wq.quote.to, D.pool) && !fetchNode.calls.some((c) => c.method === 'eth_call' && String(c.params[0].data).startsWith('0xdd62ed3e')));
  fetchNode = lendNode({ allowance: 100_000n, preflight: 'execution reverted: 51' });
  const failing = await L.prepareLendingSend(RPC_URL, DEV, plan);
  check('a supply the Pool would refuse with Aave\'s 51: quoted with a FAILED pre-flight, worded by the engine',
    failing.quote.simulation.ok === false && L.lendingSimulationText(failing.quote.simulation.reason).startsWith("Aave refused: the supply would take the reserve over its supply cap (Aave's error 51)."),
    failing.quote.simulation.reason);
  check('the device prompt names the action (English)', L.lendingActionTitle(plan) === 'Supply 0.1 USDC to Aave' && L.lendingActionTitle(withdraw) === 'Withdraw all your USDC from Aave');
  setActiveLanguage('es');
  const es1 = L.lendingActionLabel(plan);
  const esTitle = L.lendingActionTitle(plan);
  setActiveLanguage('en');
  check('…the button label follows the language, the prompt title stays English', es1 === 'Depositar 0.1 USDC en Aave' && esTitle === 'Supply 0.1 USDC to Aave');
  fetchNode = null;
}

// ---------------------------------------------------------------------------
console.log('check-lending: the smart account — one batch through the real prepareAaCalls / sendAa');
// ---------------------------------------------------------------------------
const kernelConfig = {
  bundlerUrl: 'https://bundler.example',
  bundlerVerifiedAt: 'x',
  accountType: 'kernel-v3.3',
  factory: KERNEL_V3_3.factory,
  factoryImplementation: KERNEL_V3_3.implementation,
  kernelMetaFactory: KERNEL_V3_3.metaFactory,
  kernelValidator: KERNEL_V3_3.ecdsaValidator,
  kernelAccountId: KERNEL_V3_3.accountId,
  factoryVerifiedAt: 'x',
  paymasterUrl: null,
  paymasterContext: null,
  paymasterVerifiedAt: null,
  chain: ARB,
  eip7702Owners: [],
  recoveredAccounts: [],
  bundlerUrlIgnoredReason: null,
  paymasterUrlIgnoredReason: null,
};
function arbBundle(overrides = {}) {
  const lend = lendNode({ overrides });
  const kernel = fakeKernelNode({ chainIdHex: '0x66eee', balance: 10n ** 16n, tokenBalances: { [`${D.asset.address.toLowerCase()}|${KERNEL_ACCOUNT_0.toLowerCase()}`]: 745_441n } });
  const node = async (method, params) => {
    if (method === 'eth_blockNumber' || method === 'eth_getStorageAt') return lend(method, params);
    if ((method === 'eth_call' || method === 'eth_getCode') && params[1] === TAG) return lend(method, params);
    return kernel(method, params);
  };
  const bundler = fakeBundler({ chainIdHex: '0x66eee' });
  const bundle = createAaClientFromConfig(kernelConfig, {
    nodeUrl: 'https://node.example',
    chainId: 421614n,
    accountIndex: 0,
    ownerAddress: OWNER_0,
    transportFor: (url) => (url === 'https://node.example' ? node : bundler),
  });
  return { bundle, bundler };
}
{
  const kernelHolds = { [balanceKey(D.asset.address, KERNEL_ACCOUNT_0)]: word(745_441n), [balanceKey(D.aToken.address, KERNEL_ACCOUNT_0)]: word(0n) };
  const { bundle, bundler } = arbBundle(kernelHolds);
  const plan = await L.planLending(bundle.node, ARB, KERNEL_ACCOUNT_0, supplyAction(100_000n));
  check('the Kernel account\'s position read (0.745441 USDC, as the record says it holds on Arbitrum Sepolia)', plan.position.walletBalance === 745_441n);
  const quote = await L.prepareLendingAa(bundle, OWNER_0, plan, 'kernel-v3.3', true);
  check('ONE operation: [approve(Pool, exact), supply(USDC, amount, the Kernel account, 0)], sender = the Kernel account, the USDC spend named',
    quote.calls.length === 2 && same(quote.sender, KERNEL_ACCOUNT_0) && toHex(quote.calls[0].data) === erc20.encodeFunctionData('approve', [D.pool, 100_000n]) &&
      toHex(quote.calls[1].data) === pool.encodeFunctionData('supply', [D.asset.address, 100_000n, KERNEL_ACCOUNT_0, 0]) && quote.tokenSpend?.amount === 100_000n);
  const events = [];
  const off = addAaOperationSentListener((e) => events.push(e));
  await sendAa(bundle, owner, quote, { kind: 'lending' });
  off();
  const exec = decodeKernelExecute(bundler.lastOp.callData);
  check('…submitted as exactly those two calls', exec.calls.length === 2 && exec.calls.every((c, i) => same(c.to, plan.calls[i].to) && c.data === toHex(plan.calls[i].data) && c.value === 0n));
  check('…recorded for the pending card as kind "lending"', events.length === 1 && events[0].kind === 'lending' && same(events[0].sender, KERNEL_ACCOUNT_0));
  const fresh = arbBundle(kernelHolds);
  const n0 = fresh.bundler.calls?.length ?? 0;
  const r7702 = await rejection(() => L.prepareLendingAa(fresh.bundle, OWNER_0, plan, 'kernel-7702', true));
  check('an EIP-7702 owner is refused before any bundler request', r7702 instanceof L.LendingRefusal && r7702.message.startsWith('This account is upgraded with EIP-7702') && (fresh.bundler.calls?.length ?? 0) === n0);
  const mismatch = await rejection(() => L.prepareLendingAa(arbBundle(kernelHolds).bundle, OWNER_0, { ...plan, holder: DEV, calls: plan.calls }, 'kernel-v3.3', true));
  check('a plan read for another address than the smart account is refused', mismatch instanceof L.LendingRefusal &&
    (mismatch.message === 'This lending plan was read for another address than the smart account. Nothing was quoted.' || mismatch.message.startsWith('The calls failed the wallet’s check before signing')));
  const tampered = { ...plan, calls: [plan.calls[0], { ...plan.calls[1], data: getBytes(pool.encodeFunctionData('supply', [D.asset.address, 100_000n, OTHER, 0])) }] };
  const t2 = arbBundle(kernelHolds);
  const tRefused = await rejection(() => L.prepareLendingAa(t2.bundle, OWNER_0, tampered, 'kernel-v3.3', true));
  check('a tampered batch (supply credited to another address) is refused by checkLendingCalls before any estimate',
    tRefused instanceof L.LendingRefusal && tRefused.message.includes(LENDING_REFUSALS.supplyRecipient('0x2222222222222222222222222222222222222222')) && t2.bundler.lastEstimated === undefined);
  const otherNet = await rejection(() => L.prepareLendingAa({ ...arbBundle(kernelHolds).bundle, chainId: 11155111n }, OWNER_0, plan, 'kernel-v3.3', true));
  check('a smart-account setup for another network is refused (exact)', otherNet instanceof L.LendingRefusal && otherNet.message === 'The smart-account setup is for another network than this lending plan. Nothing was quoted.');
}

// ---------------------------------------------------------------------------
console.log('check-lending: errors and the receipt');
// ---------------------------------------------------------------------------
{
  const cap = L.describeLendingError(new GasEstimateRevertError('execution reverted: 51', false, '51'), 'test ETH');
  check('a gas estimate Aave reverted with 51: "Aave refused this" + the engine\'s sentence + the technical line',
    cap.title === 'Aave refused this' && cap.detail.startsWith("Aave refused: the supply would take the reserve over its supply cap (Aave's error 51).\nTechnical detail: "));
  const refusal = L.describeLendingError(new L.LendingRefusal('Plain sentence.'), 'test ETH');
  check('a refusal of this module: "Not quoted" + the sentence as it is', refusal.title === 'Not quoted' && refusal.detail === 'Plain sentence.');
  const gate = await rejection(async () => L.requireLendingDeployment('eip155:1'));
  const gated = L.describeLendingError(gate, 'test ETH');
  check('the readiness refusal: "Not quoted" + the readiness sentence', gated.title === 'Not quoted' && gated.detail === readinessRefusal('lending'));
  const other = L.describeLendingError(new Error('something unrelated happened'), 'test ETH');
  check('anything else keeps the Send screen\'s wording (describeSendError)', other.title !== 'Aave refused this' && other.title !== 'Not quoted');

  const supplyLogs = FIXTURE.liveReceipts.supply.logs;
  const withdrawLogs = FIXTURE.liveReceipts.withdraw.logs;
  check('receiptLogsOf: a transaction receipt\'s logs, and a UserOperation receipt\'s nested receipt logs',
    L.receiptLogsOf({ logs: supplyLogs }).length === supplyLogs.length && L.receiptLogsOf({ logs: [], receipt: { logs: supplyLogs } }).length === supplyLogs.length &&
      L.receiptLogsOf(null).length === 0 && L.receiptLogsOf({ logs: [{ address: 1 }] }).length === 0);
  const holder = { deployment: D, holder: DEV };
  check('the live supply\'s receipt: "Supplied 0.1 USDC; your position is now 0.1 USDC (the aArbSepUSDC balance, read after the transaction)."',
    JSON.stringify(L.lendingOutcomeLines(supplyLogs, holder, 100_000n)) === JSON.stringify(['Supplied 0.1 USDC; your position is now 0.1 USDC (the aArbSepUSDC balance, read after the transaction).']));
  check('the live withdrawal\'s receipt: "Withdrawn 0.1 USDC to this account; your position is now 0 USDC (…)."',
    JSON.stringify(L.lendingOutcomeLines(withdrawLogs, holder, 0n)) === JSON.stringify(['Withdrawn 0.1 USDC to this account; your position is now 0 USDC (the aArbSepUSDC balance, read after the transaction).']));
  check('a position not read after it is said plainly', L.lendingOutcomeLines(supplyLogs, holder, null)[0] === 'Supplied 0.1 USDC; the position after it could not be read just now.');
  check('another holder: no event is claimed for it', JSON.stringify(L.lendingOutcomeLines(supplyLogs, { deployment: D, holder: OTHER }, 0n)) ===
    JSON.stringify(['The receipt holds no Supply or Withdraw event from Aave’s Pool for this account.']));
  let sleeps = 0;
  const answers = [null, null, { logs: supplyLogs }];
  const r = await L.waitForTransactionReceipt(async () => answers.shift(), '0x' + '11'.repeat(32), { pollMs: 1, timeoutMs: 10, sleep: async () => { sleeps += 1; } });
  check('waitForTransactionReceipt: polls until the receipt answers', r !== null && Array.isArray(r.logs) && sleeps === 2);
  const t = await L.waitForTransactionReceipt(async () => { throw new Error('down'); }, '0x' + '11'.repeat(32), { pollMs: 5, timeoutMs: 10, sleep: async () => {} });
  check('…a failed read is "not yet", and the wait ends with null at the limit', t === null);
}

// ---------------------------------------------------------------------------
console.log('check-lending: the screen, the route and the Home link (source pins)');
// ---------------------------------------------------------------------------
{
  const screen = read('src/screens/LendScreen.tsx');
  const views = read('src/screens/LendViews.tsx');
  const home = read('src/screens/HomeScreen.tsx');
  check('the readiness gate card where refused', screen.includes("const gate = readinessGate('lending', caip2);") && screen.includes('<TestNetworksOnlyCard feature={gate.feature} hint={gate.hint} />'));
  check('the regular account: planLending then prepareLendingSend through callWithFailover; the approval waited for, then quoted again',
    screen.includes('const p = await planLending(evmHttpTransport(ep.url), caip2, account.address, action);') && screen.includes('const q = await prepareLendingSend(ep.url, account.address, p);') &&
      screen.includes('await waitForAllowance(') && screen.includes("if (step !== 'main') throw new LendingRefusal(t('lend.approve.notInPlace'));"));
  check('the smart account: prepareLendingAa, then sendAa with kind "lending"', screen.includes('await prepareLendingAa(bundle, account.address, p, aaType, aaConfigured)') &&
    screen.includes("sendAa(bundle, signer, aaQuote, { kind: 'lending' })"));
  check('the device prompts: the English action title (the smart account\'s with "from your smart account")',
    screen.includes('requireLocalAuth(lendingActionTitle(plan))') && screen.includes('requireLocalAuth(`${lendingActionTitle(plan)} from your smart account`)') &&
      screen.includes("translateIn('en', 'lend.prompt.approve'"));
  check('the confirm: the preview, the risk card, the spending limits and the pre-flight gate on every confirm',
    (screen.match(/<BalanceChangePreview/g) ?? []).length === 2 && (screen.match(/<RiskWarnings/g) ?? []).length === 3 && (screen.match(/<SpendingPolicyNotice/g) ?? []).length === 2 &&
      screen.includes('disabled={!eoaQuote.simulation.ok}'));
  check('the success view: the receipt read, the explorer button gated on explorerTxBase, the note field for both paths',
    screen.includes('waitForTransactionReceipt(node, sent.txid)') && screen.includes('lendingOutcomeLines(receiptLogsOf(receipt), p, after)') &&
      screen.includes("result?.explorerUrl && evmChain.explorerTxBase ?") && (screen.match(/<TransactionNoteField/g) ?? []).length === 2);
  check('Max fills the USDC held (exact), "Withdraw all" is a switch for a withdrawal', screen.includes('setAmountText(formatLending(position.walletBalance, deployment))') &&
    screen.includes("action = { kind: 'withdraw', amount: 'all' };"));
  check('the intro and the honesty lines come first on the form (LendIntro) and name the single key, freeze, liquidity, interest, no borrowing, own account, audits',
    screen.includes('<LendIntro deployment={deployment} theme={theme} />') &&
      ['lend.intro', 'lend.honesty.market', 'lend.honesty.frozen', 'lend.honesty.liquidity', 'lend.honesty.interest', 'lend.honesty.noBorrow', 'lend.honesty.ownAccount', 'lend.honesty.audit'].every((id) => views.includes(`t('${id}'`)));
  check('the route Lend: navigation.ts, App.tsx', read('src/navigation.ts').includes('  Lend: undefined;') &&
    read('App.tsx').includes(`<Stack.Screen name="Lend" component={LendScreen} options={{ title: 'Lend (test networks)' }} />`));
  check('the Home link "Lend (Aave)" beside Staking, shown by lendingLinkShown', home.includes("lendingLinkShown(evmChain.caip2, activeAccount ?? null)") &&
    home.includes("cardLink('lend', 'Lend (Aave)', () => navigation.navigate('Lend'), 'Supplies test USDC to Aave on Arbitrum Sepolia, and withdraws it')") &&
    home.indexOf("cardLink('lend'") > home.indexOf("cardLink('staking'"));
  check('a watch-only account is refused the route by name', watchOnlyRouteRefusal('Lend')?.startsWith('Lending (Aave) is not available for a watch-only account'));
  check('the readiness gate in the module names the row (check-readiness scans it)', LENDING_SOURCE.includes("assertFeatureAllowed('lending', "));
}

// ---------------------------------------------------------------------------
console.log('check-lending: every sentence of the screen\'s block, in both tables');
// ---------------------------------------------------------------------------
{
  const ids = Object.keys(en).filter((id) => id.startsWith('lend.') || id === 'readiness.lending.title' || id === 'readiness.lending.reason');
  check(`the Lend block: ${ids.length} ids, each with a Spanish draft that differs from the English`, ids.length >= 80 && ids.every((id) => typeof es[id] === 'string' && es[id] !== en[id]));
  const sources = ['src/wallet/lending.ts', 'src/screens/LendScreen.tsx', 'src/screens/LendViews.tsx'].map(read).join('\n');
  const unnamed = ids.filter((id) => !id.startsWith('readiness.') && !id.startsWith('lend.home.') && id !== 'lend.screenTitle' && !sources.includes(`'${id}'`));
  check('every lend.* id is used by the module or the screen (the Home link\'s two by their English, the title by App.tsx)', unnamed.length === 0, unnamed.join(', '));
  check('the Home link\'s English entries equal the literals Home passes', en['lend.home.link'] === 'Lend (Aave)' && en['lend.home.hint'] === 'Supplies test USDC to Aave on Arbitrum Sepolia, and withdraws it' && en['lend.screenTitle'] === 'Lend (test networks)');
  check('the honesty lines (exact English)',
    en['lend.honesty.frozen'] === 'A frozen reserve accepts no new supply but still allows withdrawals; a paused reserve allows neither.' &&
      en['lend.honesty.noBorrow'] === 'No borrowing is offered. Aave switches supplied USDC on as collateral automatically; with nothing borrowed, nothing can be liquidated.' &&
      en['lend.honesty.market'].startsWith('This is Aave’s {network} test market. One key administers it'));
}

// ---------------------------------------------------------------------------
console.log('check-lending: mutation checks (each mutant must be caught)');
// ---------------------------------------------------------------------------
{
  const plan = await L.planLending(lendNode(), ARB, DEV, supplyAction(100_000n));
  const tampered = { ...plan, calls: [plan.calls[0], { ...plan.calls[1], data: getBytes(pool.encodeFunctionData('supply', [D.asset.address, 100_000n, OTHER, 0])) }] };
  tampered.main = tampered.calls[1];

  const m1 = await lendingMutant('  checkBeforeQuote([plan.main], plan);\n', '');
  fetchNode = lendNode({ allowance: 100_000n });
  const r1 = await rejection(() => m1.prepareLendingSend(RPC_URL, DEV, tampered));
  caught('the check before the regular-account quote removed: a tampered supply is quoted', r1 === null);

  const m2 = await lendingMutant('  checkBeforeQuote(plan.calls, plan);\n', '');
  const b2 = arbBundle({ [balanceKey(D.asset.address, KERNEL_ACCOUNT_0)]: word(745_441n), [balanceKey(D.aToken.address, KERNEL_ACCOUNT_0)]: word(0n) });
  const kPlan = await L.planLending(b2.bundle.node, ARB, KERNEL_ACCOUNT_0, supplyAction(100_000n));
  const kTampered = { ...kPlan, calls: [kPlan.calls[0], { ...kPlan.calls[1], data: getBytes(pool.encodeFunctionData('supply', [D.asset.address, 100_000n, OTHER, 0])) }] };
  await rejection(() => m2.prepareLendingAa(b2.bundle, OWNER_0, kTampered, 'kernel-v3.3', true));
  caught('the check before the smart-account quote removed: a tampered batch reaches the bundler', b2.bundler.lastEstimated !== undefined);

  const m3 = await lendingMutant('    if (allowance < plan.approval.amount) {', '    if (false) {');
  fetchNode = lendNode({ allowance: 0n });
  caught('the approval skipped: the supply quoted with no allowance', (await m3.prepareLendingSend(RPC_URL, DEV, plan)).step === 'main');

  const m4 = await lendingMutant("  if (!isFeatureAllowed('lending', caip2)) return { ok: false, reason: 'readiness', text: readinessRefusal('lending') };\n", '');
  const o4 = m4.lendingOfferFor('eip155:1');
  caught('the readiness check removed from the offer: mainnet no longer gets the readiness sentence', o4.ok === false && o4.text !== readinessRefusal('lending'));

  const m5 = await lendingMutant("  if (accountType === 'kernel-7702') return t('lend.smart.refused7702');\n  if (accountType === 'simple')", "  if (accountType === 'simple')");
  const m5b = await lendingMutant("  if (!configured || accountType !== 'kernel-v3.3') return t('lend.smart.unavailable');", "  if (!configured) return t('lend.smart.unavailable');");
  caught('the EIP-7702 refusal removed: a 7702 owner no longer told to use the regular account',
    m5.lendingSmartAccountRefusal(ARB, 'kernel-7702', true) !== L.lendingSmartAccountRefusal(ARB, 'kernel-7702', true));
  caught('the Kernel v3.3 type test removed: any configured account type accepted', m5b.lendingSmartAccountRefusal(ARB, 'simple-x', true) === null);

  const m6 = await lendingMutant("  if (account.watchOnly) return t('lend.refusal.watchOnly');\n", '');
  caught('the watch-only refusal removed', m6.lendingAccountRefusal({ watchOnly: true }) === null && m6.lendingLinkShown(ARB, { watchOnly: true }));

  const m7 = await lendingMutant('  await assertEndpointChain(node, caip2);\n', '');
  caught('the chain-id check removed: another chain\'s endpoint is read', (await rejection(() => m7.readLendingView(lendNode({ chainIdHex: '0xaa36a7' }), ARB, DEV))) === null);

  const m8 = await lendingMutant('readLendingPosition(node, deployment, holder, { blockTag: state.block })', 'readLendingPosition(node, deployment, holder)');
  const n8 = lendNode();
  await m8.readLendingView(n8, ARB, DEV);
  caught('the position read at a later head instead of the reserve\'s block', n8.calls.filter((c) => c.method === 'eth_blockNumber').length === 2);

  const m9 = await lendingMutant('    if (s.onBehalfOf.toLowerCase() === me) lines.push(', '    if (s.onBehalfOf.toLowerCase() !== "") lines.push(');
  caught('the receipt not filtered to the holder: another account\'s supply claimed', m9.lendingOutcomeLines(FIXTURE.liveReceipts.supply.logs, { deployment: D, holder: OTHER }, 0n)[0].startsWith('Supplied'));

  const m10 = await lendingMutant("  if (aave) return { title: t('lend.error.aaveTitle')", "  if (false) return { title: t('lend.error.aaveTitle')");
  caught('Aave\'s errors no longer worded', m10.describeLendingError(new GasEstimateRevertError('execution reverted: 51', false, '51'), 'test ETH').title !== 'Aave refused this');

  const m11 = await lendingMutant("  return actionText(plan, (id, params) => translateIn('en', id, params));", '  return actionText(plan, t);');
  setActiveLanguage('es');
  const t11 = m11.lendingActionTitle(plan);
  setActiveLanguage('en');
  caught('the prompt title translated (prompt titles stay English)', t11 !== 'Supply 0.1 USDC to Aave');

  const m12 = await lendingMutant('  const deployment = isBuiltInEvmChain(caip2) ? lendingDeploymentFor(caip2) : null;', '  const deployment = lendingDeploymentFor(\'eip155:421614\');');
  const o12 = m12.lendingOfferFor('eip155:11155111');
  caught('the offer not keyed on the network (Sepolia offered Arbitrum\'s market)', o12.ok === true);
  fetchNode = null;
  check(`${mutantsCaught} of ${mutantCount} in-suite mutants caught`, mutantsCaught === mutantCount && mutantCount >= 8);
}

console.log(`\ncheck-lending: ${passed} passed, ${failed} failed (${mutantCount} mutants)`);
process.exit(failed === 0 ? 0 : 1);

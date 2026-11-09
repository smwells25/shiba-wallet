/**
 * Lending smoke test (phase 26 item 2; docs/LENDING_VAULTS.md section 10).
 * Aave v3's Arbitrum Sepolia market, Circle's USDC, SUPPLY AND WITHDRAW ONLY.
 * Test network only.
 *
 * DRY RUN (default), from the dev EOA 0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C
 * (its address only; no key is needed):
 *   A  the engine's readReserveState and readLendingPosition on both
 *      endpoints (every pinned fact checked by the engine), and the same facts
 *      compared between the endpoints;
 *   B  the engine's quote for a 0.1 USDC supply: [exact approve, supply],
 *      re-checked by checkLendingCalls and compared byte for byte with ethers;
 *   C  eth_simulateV1 against the REAL Pool: block 1 approve + supply, block 2
 *      withdraw(everything) — the aToken balance, the USDC balance and the
 *      allowance read inside the simulation after each step, the events
 *      decoded with the engine's decodeLendingReceipt;
 *   D  refusals: a supply above the balance (engine refusal; Aave and USDC
 *      revert); a supply credited to another address and a withdrawal paid to
 *      another address (both refused by the ENGINE although Aave ACCEPTS them —
 *      shown by simulation); a withdrawal above the position (Aave error 32);
 *      and, by overriding the reserve's configuration word in the Pool's
 *      storage (simulation and eth_call only), a frozen reserve (supply
 *      refused 28, withdrawal still allowed), a paused reserve (29) and a
 *      supply cap already reached (51) — each read back through the engine's
 *      readReserveState under the same override and refused by its quote.
 *
 * LIVE (LENDING_LIVE=1), signed with the dev mnemonic's account 0 read from
 * the file named by LENDING_MNEMONIC_FILE (a 0600 copy of the git-ignored
 * .dev-wallet/mnemonic.txt; never printed): approve exactly 0.1 USDC, supply
 * 0.1 USDC, read the aToken balance, withdraw everything back to the dev EOA.
 * Each call is the engine's own (quote*.calls), re-checked by
 * checkLendingCalls and pre-flighted with eth_estimateGas; the script adds
 * only nonce, gas limit (estimate + 20%) and fees. Every receipt is re-read on
 * two endpoints, the USDC, aToken and ETH deltas reconciled at block − 1 and
 * block. Caps: 0.5 USDC supplied per run and 0.002 ETH of worst-case fees per
 * run. The record (public facts only) goes to
 * scripts/testnet/runs/lending-run.json (git-ignored).
 *
 * Run from the repository root after `npm run build`:
 *   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
 *   node scripts/testnet/lending-smoke.mjs
 *   LENDING_LIVE=1 LENDING_MNEMONIC_FILE=/path/to/0600-copy node scripts/testnet/lending-smoke.mjs
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { AbiCoder, Interface, getAddress } from 'ethers';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import * as E from '../../packages/chains-evm/dist/index.js';

const ARB = 'eip155:421614';
const CHAIN = {
  name: 'Arbitrum Sepolia',
  id: 421614n,
  rpc: 'https://arbitrum-sepolia-rpc.publicnode.com',
  second: 'https://sepolia-rollup.arbitrum.io/rpc',
  // History reads (balances at block − 1): PublicNode's Arbitrum endpoint refused historical balances in phase 21.
  history: 'https://sepolia-rollup.arbitrum.io/rpc',
  explorer: 'https://sepolia.arbiscan.io/tx/',
};
const DEV_EOA = '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C';
const OTHER = '0x2222222222222222222222222222222222222222';
const D = E.LENDING_DEPLOYMENTS[ARB];
const AMOUNT = 100_000n; // 0.1 USDC
const USDC_CAP = 500_000n; // 0.5 USDC per run
const FEE_CAP = 2_000_000_000_000_000n; // 0.002 ETH of worst-case fees per run
const RESERVES_SLOT = 52n; // Pool: VersionedInitializable (slots 0, 1, gap 2–51) then PoolStorage._reserves
const RUN_FILE = new URL('./runs/lending-run.json', import.meta.url);
const LIVE = process.env.LENDING_LIVE === '1';

const coder = AbiCoder.defaultAbiCoder();
const iface = new Interface([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);
const hex = (n) => '0x' + n.toString(16);
const host = (url) => new URL(url).host;
const shortHash = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const fmtUsdc = (u) => E.formatLendingUnits(u, 6);
const fmtEth = (w) => E.formatLendingUnits(w, 18);
const lower = (s) => String(s).toLowerCase();
const mask = (text) => String(text).replace(/https?:\/\/[^\s"')]+/g, '<url>').replace(/0x[0-9a-fA-F]{64}/g, (m) => shortHash(m));
const errText = (e) => mask(e?.message ?? e).slice(0, 400);
const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const expect = (ok, text) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failures += 1;
  return !!ok;
};

const transports = {};
function node(which = 'rpc') {
  if (!transports[which]) {
    const url = CHAIN[which];
    const raw = E.httpTransport(url);
    transports[which] = async (method, params) => {
      try {
        return await raw(method, params);
      } catch (e) {
        throw new Error(`${host(url)}: ${errText(e)}`);
      }
    };
  }
  return transports[which];
}

/** A transport that adds a state override to every eth_call (the engine readers then see the overridden reserve). */
function withOverride(base, override) {
  return async (method, params) => (method === 'eth_call' ? base(method, [params[0], params[1], override]) : base(method, params));
}

/** The storage slot of _reserves[asset].configuration in the Pool. */
const configSlot = '0x' + Buffer.from(keccak_256(Buffer.from(coder.encode(['address', 'uint256'], [D.asset.address, RESERVES_SLOT]).slice(2), 'hex'))).toString('hex');

/** eth_simulateV1 of blocks of calls from `from`; returns per block the call results. */
async function simulate(blocks, which = 'rpc') {
  const payload = {
    blockStateCalls: blocks.map((b) => ({
      ...(b.override ? { stateOverrides: b.override } : {}),
      calls: b.calls.map((c) => ({ from: c.from ?? DEV_EOA, to: c.to, ...(c.value ? { value: hex(c.value) } : {}), input: typeof c.data === 'string' ? c.data : E.toHex(c.data) })),
    })),
    validation: false,
  };
  try {
    return await node(which)('eth_simulateV1', [payload, 'latest']);
  } catch (e) {
    if (which === 'rpc') {
      console.log(`  info eth_simulateV1 failed on ${host(CHAIN.rpc)} (${errText(e)}); trying ${host(CHAIN.second)}`);
      return simulate(blocks, 'second');
    }
    throw e;
  }
}
const okCall = (r) => r && (r.status === '0x1' || r.status === 1);
const uintOf = (r) => BigInt(r.returnData);
const revertOf = (r) => {
  const data = r?.error?.data ?? r?.returnData ?? '0x';
  return { data, reason: E.decodeRevertReason(data), aave: E.describeAaveError(data) };
};
const balanceCall = (token, who) => ({ to: token, data: iface.encodeFunctionData('balanceOf', [who]) });
const allowanceCall = () => ({ to: D.asset.address, data: iface.encodeFunctionData('allowance', [DEV_EOA, D.pool]) });

/** Overrides of the reserve's configuration word in the Pool, for the simulated refusals. */
async function configWord(which = 'rpc') {
  return BigInt(await node(which)('eth_getStorageAt', [D.pool, configSlot, 'latest']));
}
const overrideConfig = (word) => ({ [D.pool]: { stateDiff: { [configSlot]: '0x' + word.toString(16).padStart(64, '0') } } });

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

async function dryRun(run) {
  console.log(`\nA. Reserve state and the dev EOA's position (engine readers, both endpoints)`);
  const [s1, s2] = await Promise.all([E.readReserveState(node('rpc'), D), E.readReserveState(node('second'), D)]);
  for (const [s, url] of [[s1, CHAIN.rpc], [s2, CHAIN.second]]) {
    console.log(`  ${host(url)} block ${s.block}: active ${s.active}, frozen ${s.frozen}, paused ${s.paused}, cap ${s.supplyCap} USDC, counted against the cap ${fmtUsdc(s.suppliedForCap)}, liquidity ${fmtUsdc(s.availableLiquidity)}, aToken ${s.aToken}, supply rate ${(Number(s.liquidityRateRay / 10n ** 21n) / 1e4).toFixed(4)}% a year`);
  }
  expect(s1.active === s2.active && s1.frozen === s2.frozen && s1.paused === s2.paused && s1.supplyCap === s2.supplyCap && s1.aToken === s2.aToken && s1.decimals === s2.decimals, 'both endpoints report the same flags, cap, aToken and decimals (every pinned fact passed the engine checks on both)');
  expect(s1.active && !s1.frozen && !s1.paused, 'the USDC reserve is active, not frozen and not paused');
  const pos = await E.readLendingPosition(node('rpc'), D, DEV_EOA);
  console.log(`  dev EOA at block ${pos.block}: ${fmtUsdc(pos.walletBalance)} USDC, ${fmtUsdc(pos.supplied)} aArbSepUSDC`);
  run.dryRun = { at: new Date().toISOString(), block: s1.block, state: s1, position: pos };

  console.log(`\nB. The engine's quote for a ${fmtUsdc(AMOUNT)} USDC supply`);
  const q = E.quoteLendingSupply({ deployment: D, state: s1, account: DEV_EOA, amount: AMOUNT, walletBalance: pos.walletBalance });
  expect(q.refusals.length === 0 && q.calls.length === 2, `quote: ${q.calls.length} calls, refusals ${JSON.stringify(q.refusals)}`);
  expect(E.checkLendingCalls(q.calls, D, DEV_EOA).length === 0, 'checkLendingCalls accepts the quote');
  expect(lower(E.toHex(q.calls[0].data)) === lower(iface.encodeFunctionData('approve', [D.pool, AMOUNT])) && lower(q.calls[0].to) === lower(D.asset.address), 'call 1 = approve(Pool, exactly 0.1 USDC) on USDC, byte for byte as ethers encodes it');
  expect(lower(E.toHex(q.calls[1].data)) === lower(iface.encodeFunctionData('supply', [D.asset.address, AMOUNT, DEV_EOA, 0])) && lower(q.calls[1].to) === lower(D.pool), 'call 2 = supply(USDC, 0.1, dev EOA, 0) on the Pool, byte for byte as ethers encodes it');
  const wq = E.quoteLendingWithdraw({ deployment: D, state: s1, account: DEV_EOA, amount: 'all', supplied: AMOUNT });
  expect(wq.refusals.length === 0 && lower(E.toHex(wq.calls[0].data)) === lower(iface.encodeFunctionData('withdraw', [D.asset.address, E.AAVE_WITHDRAW_ALL, DEV_EOA])), 'the withdraw-everything quote = withdraw(USDC, type(uint256).max, dev EOA)');

  console.log(`\nC. Simulated supply and withdrawal against the real Pool`);
  const sim = await simulate([
    { calls: [q.calls[0], q.calls[1], balanceCall(D.aToken.address, DEV_EOA), balanceCall(D.asset.address, DEV_EOA), allowanceCall()] },
    { calls: [wq.calls[0], balanceCall(D.aToken.address, DEV_EOA), balanceCall(D.asset.address, DEV_EOA)] },
  ]);
  const [b1, b2] = sim.map((b) => b.calls);
  expect(b1.slice(0, 2).every(okCall) && okCall(b2[0]), `approve, supply and withdraw succeed (gas ${b1[0].gasUsed ? BigInt(b1[0].gasUsed) : 'n/a'} / ${b1[1].gasUsed ? BigInt(b1[1].gasUsed) : 'n/a'} / ${b2[0].gasUsed ? BigInt(b2[0].gasUsed) : 'n/a'})`);
  const aAfter = uintOf(b1[2]);
  const usdcAfter = uintOf(b1[3]);
  expect(aAfter >= AMOUNT && aAfter <= AMOUNT + 1n, `aToken balance right after the supply: ${aAfter} base units (0.1 USDC = 100000)`);
  expect(usdcAfter === pos.walletBalance - AMOUNT, `USDC after the supply ${fmtUsdc(usdcAfter)} = before − 0.1`);
  expect(uintOf(b1[4]) === 0n, 'the allowance is back to 0 after the supply (exact approval consumed)');
  const r1 = E.decodeLendingReceipt(b1[1].logs ?? [], D);
  expect(r1.supplies.length === 1 && r1.supplies[0].amount === AMOUNT && lower(r1.supplies[0].onBehalfOf) === lower(DEV_EOA) && lower(r1.supplies[0].user) === lower(DEV_EOA), `Supply event: ${toJson(r1.supplies[0] ?? null).replace(/\s+/g, ' ')}`);
  const withdrawn = BigInt(b2[0].returnData);
  const r2 = E.decodeLendingReceipt(b2[0].logs ?? [], D);
  expect(r2.withdrawals.length === 1 && r2.withdrawals[0].amount === withdrawn && lower(r2.withdrawals[0].to) === lower(DEV_EOA), `Withdraw event amount ${withdrawn} = withdraw()'s return value, paid to the dev EOA`);
  expect(uintOf(b2[1]) === 0n, 'aToken balance after withdrawing everything: 0');
  expect(uintOf(b2[2]) === pos.walletBalance - AMOUNT + withdrawn, `USDC after the withdrawal ${fmtUsdc(uintOf(b2[2]))} = after the supply + ${withdrawn}`);
  console.log(`  info collateral events: enabled ${r1.collateralEnabled.length}, disabled ${r2.collateralDisabled.length} (a first supply switches the asset on as collateral; withdrawing everything switches it off)`);
  run.dryRun.simulated = { supplyGas: b1[1].gasUsed, approveGas: b1[0].gasUsed, withdrawGas: b2[0].gasUsed, aTokenAfterSupply: aAfter, withdrawn };

  console.log(`\nD. Refusals`);
  // D1 above the balance
  const tooMuch = pos.walletBalance + 1n;
  const q1 = E.quoteLendingSupply({ deployment: D, state: s1, account: DEV_EOA, amount: tooMuch, walletBalance: pos.walletBalance });
  expect(q1.calls.length === 0 && q1.refusals[0] === E.LENDING_REFUSALS.aboveBalance(fmtUsdc(pos.walletBalance), fmtUsdc(tooMuch), 'USDC'), `engine refuses ${fmtUsdc(tooMuch)} USDC: "${q1.refusals[0]}"`);
  const sim1 = await simulate([{ calls: [{ to: D.asset.address, data: iface.encodeFunctionData('approve', [D.pool, tooMuch]) }, { to: D.pool, data: iface.encodeFunctionData('supply', [D.asset.address, tooMuch, DEV_EOA, 0]) }] }]);
  const rv1 = revertOf(sim1[0].calls[1]);
  expect(!okCall(sim1[0].calls[1]), `and the chain refuses it too: ${rv1.reason}`);
  // D2 supply credited to another address
  const q2 = E.quoteLendingSupply({ deployment: D, state: s1, account: DEV_EOA, amount: AMOUNT, walletBalance: pos.walletBalance, onBehalfOf: OTHER });
  expect(q2.calls.length === 0 && q2.refusals[0] === E.LENDING_REFUSALS.supplyRecipient(OTHER), `engine refuses a supply credited to ${OTHER}: "${q2.refusals[0]}"`);
  const rawOther = { to: D.pool, data: E.toBytes(iface.encodeFunctionData('supply', [D.asset.address, AMOUNT, OTHER, 0])), value: 0n };
  expect(E.checkLendingCalls([q.calls[0], rawOther], D, DEV_EOA).includes(E.LENDING_REFUSALS.supplyRecipient(lower(OTHER))), 'checkLendingCalls refuses the same call before signing');
  const sim2 = await simulate([{ calls: [balanceCall(D.aToken.address, OTHER), q.calls[0], rawOther, balanceCall(D.aToken.address, OTHER)] }]);
  const otherA = uintOf(sim2[0].calls[3]) - uintOf(sim2[0].calls[0]);
  expect(okCall(sim2[0].calls[2]) && otherA >= AMOUNT - 1n && otherA <= AMOUNT + 1n, `Aave itself ACCEPTS it: ${OTHER}'s aArbSepUSDC balance rose by ${otherA} base units — which is why the engine refuses`);
  // D3 withdrawal paid to another address
  const q3 = E.quoteLendingWithdraw({ deployment: D, state: s1, account: DEV_EOA, amount: 'all', supplied: AMOUNT, to: OTHER });
  expect(q3.calls.length === 0 && q3.refusals[0] === E.LENDING_REFUSALS.withdrawRecipient(OTHER), `engine refuses a withdrawal to ${OTHER}: "${q3.refusals[0]}"`);
  const rawTo = { to: D.pool, data: E.toBytes(iface.encodeFunctionData('withdraw', [D.asset.address, E.AAVE_WITHDRAW_ALL, OTHER])), value: 0n };
  expect(E.checkLendingCalls([rawTo], D, DEV_EOA).includes(E.LENDING_REFUSALS.withdrawRecipient(lower(OTHER))), 'checkLendingCalls refuses the same call before signing');
  const sim3 = await simulate([{ calls: [q.calls[0], q.calls[1]] }, { calls: [balanceCall(D.asset.address, OTHER), rawTo, balanceCall(D.asset.address, OTHER)] }]);
  const paidOther = uintOf(sim3[1].calls[2]) - uintOf(sim3[1].calls[0]);
  expect(okCall(sim3[1].calls[1]) && paidOther === BigInt(sim3[1].calls[1].returnData), `Aave itself ACCEPTS it: ${OTHER}'s USDC balance rose by ${paidOther} base units (the dev EOA's whole position) — which is why the engine refuses`);
  // D4 withdraw more than the position
  const q4 = E.quoteLendingWithdraw({ deployment: D, state: s1, account: DEV_EOA, amount: 2n * AMOUNT, supplied: AMOUNT });
  expect(q4.calls.length === 0 && q4.refusals[0] === E.LENDING_REFUSALS.abovePosition('0.1', '0.2', 'USDC', 'aArbSepUSDC'), `engine refuses 0.2 against a 0.1 position: "${q4.refusals[0]}"`);
  const sim4 = await simulate([{ calls: [q.calls[0], q.calls[1]] }, { calls: [{ to: D.pool, data: iface.encodeFunctionData('withdraw', [D.asset.address, 2n * AMOUNT, DEV_EOA]) }] }]);
  const rv4 = revertOf(sim4[1].calls[0]);
  expect(!okCall(sim4[1].calls[0]) && rv4.aave === E.AAVE_ERROR_SENTENCES['32'], `the Pool refuses it: ${rv4.reason} → "${rv4.aave}"`);

  // D5–D7 the reserve's configuration overridden in simulation only
  const word = await configWord();
  const decimalsBits = (word >> 48n) & 0xffn;
  const capBits = (word >> 116n) & ((1n << 36n) - 1n);
  expect(decimalsBits === 6n && ((word >> 56n) & 1n) === 1n && capBits === s1.supplyCap, `the Pool's _reserves[USDC].configuration word (slot ${shortHash(configSlot)}) decodes to decimals ${decimalsBits}, active ${(word >> 56n) & 1n}, supply cap ${capBits} — the same as the data provider, so the slot is the right one`);
  const frozenWord = word | (1n << 57n);
  const pausedWord = word | (1n << 60n);
  const tinyCapWord = (word & ~(((1n << 36n) - 1n) << 116n)) | (1n << 116n); // supply cap 1 USDC
  const viaOverride = (w) => withOverride(node('rpc'), overrideConfig(w));
  const sFrozen = await E.readReserveState(viaOverride(frozenWord), D);
  const qF = E.quoteLendingSupply({ deployment: D, state: sFrozen, account: DEV_EOA, amount: AMOUNT, walletBalance: pos.walletBalance });
  expect(sFrozen.frozen && qF.refusals[0] === E.LENDING_REFUSALS.frozen('USDC', 'Arbitrum Sepolia'), `frozen (eth_call override): readReserveState reports frozen and the quote refuses: "${qF.refusals[0]}"`);
  const qFw = E.quoteLendingWithdraw({ deployment: D, state: sFrozen, account: DEV_EOA, amount: 'all', supplied: AMOUNT });
  expect(qFw.refusals.length === 0, 'a frozen reserve still quotes a withdrawal');
  const simF = await simulate([{ calls: [q.calls[0], q.calls[1]] }, { override: overrideConfig(frozenWord), calls: [wq.calls[0], q.calls[0], q.calls[1]] }]);
  const rvF = revertOf(simF[1].calls[2]);
  expect(okCall(simF[1].calls[0]) && !okCall(simF[1].calls[2]) && rvF.aave === E.AAVE_ERROR_SENTENCES['28'], `simulated: with the reserve frozen the withdrawal succeeds and a new supply reverts ${rvF.reason} → "${rvF.aave}"`);
  const sPaused = await E.readReserveState(viaOverride(pausedWord), D);
  const qP = E.quoteLendingWithdraw({ deployment: D, state: sPaused, account: DEV_EOA, amount: 'all', supplied: AMOUNT });
  expect(sPaused.paused && qP.refusals[0] === E.LENDING_REFUSALS.paused('USDC', 'Arbitrum Sepolia'), `paused: the withdrawal quote refuses: "${qP.refusals[0]}"`);
  const simP = await simulate([{ calls: [q.calls[0], q.calls[1]] }, { override: overrideConfig(pausedWord), calls: [wq.calls[0]] }]);
  const rvP = revertOf(simP[1].calls[0]);
  expect(!okCall(simP[1].calls[0]) && rvP.aave === E.AAVE_ERROR_SENTENCES['29'], `simulated: a paused reserve refuses the withdrawal ${rvP.reason} → "${rvP.aave}"`);
  const sCap = await E.readReserveState(viaOverride(tinyCapWord), D);
  const qC = E.quoteLendingSupply({ deployment: D, state: sCap, account: DEV_EOA, amount: AMOUNT, walletBalance: pos.walletBalance });
  expect(sCap.supplyCap === 1n && /would go over its supply cap of 1 USDC/.test(qC.refusals[0] ?? ''), `supply cap 1 USDC: the quote refuses: "${qC.refusals[0]}"`);
  const simC = await simulate([{ override: overrideConfig(tinyCapWord), calls: [q.calls[0], q.calls[1]] }]);
  const rvC = revertOf(simC[0].calls[1]);
  expect(!okCall(simC[0].calls[1]) && rvC.aave === E.AAVE_ERROR_SENTENCES['51'], `simulated: the Pool refuses the supply ${rvC.reason} → "${rvC.aave}"`);
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

function loadRun() {
  return existsSync(RUN_FILE) ? JSON.parse(readFileSync(RUN_FILE, 'utf8')) : null;
}
function saveRun(run) {
  mkdirSync(new URL('./runs/', import.meta.url), { recursive: true });
  run.updatedAt = new Date().toISOString();
  writeFileSync(RUN_FILE, toJson(run) + '\n');
}

async function receiptOf(n, hash, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await n('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) return r;
    await sleep(2000);
  }
  throw new Error(`No receipt for ${hash} after ${tries * 2} s`);
}

async function balanceAt(token, who, block) {
  return BigInt(await node('history')('eth_call', [{ to: token, data: iface.encodeFunctionData('balanceOf', [who]) }, hex(block)]));
}

async function sendOne(signer, call, label, run, feeState) {
  const sender = signer.address;
  const n = node('rpc');
  const n2 = node('second');
  const problems = E.checkLendingCalls([call], D, sender);
  if (problems.length > 0) throw new Error(`${label}: checkLendingCalls refused: ${problems.join(' ')} Nothing was sent.`);
  const latest = BigInt(await n('eth_getTransactionCount', [sender, 'latest']));
  const pending = BigInt(await n('eth_getTransactionCount', [sender, 'pending']));
  if (latest !== pending) throw new Error(`The dev EOA has ${pending - latest} pending transaction(s). Nothing was sent.`);
  const chainId = BigInt(await n('eth_chainId', []));
  if (chainId !== CHAIN.id) throw new Error('The endpoint answered another chain. Nothing was sent.');
  const dataHex = E.toHex(call.data);
  const estimate = BigInt(await n('eth_estimateGas', [{ from: sender, to: call.to, value: '0x0', data: dataHex }]));
  const gasLimit = (estimate * 120n) / 100n;
  const fees = await new E.NodeClient(n).suggestFees();
  const worst = gasLimit * fees.maxFeePerGas;
  console.log(`  ${label}: nonce ${latest}, gas estimate ${estimate} → limit ${gasLimit}, maxFee ${fees.maxFeePerGas}, tip ${fees.maxPriorityFeePerGas}; worst-case fee ${worst} wei; this run so far ${feeState.worst} + this = ${feeState.worst + worst} ≤ ${FEE_CAP}`);
  if (feeState.worst + worst > FEE_CAP) throw new Error(`${label} would take this run's worst-case fees above 0.002 ETH. Nothing was sent.`);
  feeState.worst += worst;
  const tx = { chainId, nonce: latest, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, gasLimit, to: call.to, value: 0n, data: call.data };
  const signed = E.signEip1559(tx, signer);
  const entry = { label, nonce: latest, to: call.to, data: dataHex, gasEstimate: estimate, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, worstCaseFee: worst, status: 'sending' };
  run.txs.push(entry);
  saveRun(run);
  const hash = await n('eth_sendRawTransaction', [signed.rawHex]);
  if (lower(hash) !== lower(signed.txHash)) throw new Error(`The node returned ${hash}, not the signed hash ${signed.txHash}.`);
  Object.assign(entry, { hash, status: 'sent', sentAt: new Date().toISOString() });
  saveRun(run);
  console.log(`  SENT ${label}: ${hash} (${CHAIN.explorer}${hash})`);
  let [r1, r2] = await Promise.all([receiptOf(n, hash), receiptOf(n2, hash)]);
  for (let i = 0; i < 6 && r1.blockHash !== r2.blockHash; i++) {
    await sleep(10_000);
    [r1, r2] = await Promise.all([receiptOf(n, hash), receiptOf(n2, hash)]);
  }
  const [t1, t2] = await Promise.all([n('eth_getTransactionByHash', [hash]), n2('eth_getTransactionByHash', [hash])]);
  const same = r1.status === r2.status && r1.blockNumber === r2.blockNumber && r1.blockHash === r2.blockHash && r1.gasUsed === r2.gasUsed && r1.logs.length === r2.logs.length;
  expect(same, `${label}: the receipt agrees on ${host(CHAIN.rpc)} and ${host(CHAIN.second)}: status ${r1.status}, block ${BigInt(r1.blockNumber)} (${shortHash(r1.blockHash)}), gas used ${BigInt(r1.gasUsed)} of ${gasLimit} (L1 part ${r1.gasUsedForL1 ? BigInt(r1.gasUsedForL1) : 'n/a'}), effective price ${BigInt(r1.effectiveGasPrice)}, ${r1.logs.length} logs`);
  expect(lower(t1.input) === lower(dataHex) && lower(t2.input) === lower(dataHex) && lower(t1.to) === lower(call.to) && lower(t1.from) === lower(sender), `${label}: the mined transaction carries exactly the engine-built calldata and target (both endpoints)`);
  const fee = BigInt(r1.gasUsed) * BigInt(r1.effectiveGasPrice);
  Object.assign(entry, { status: r1.status === '0x1' ? 'mined' : 'reverted', block: BigInt(r1.blockNumber), blockHash: r1.blockHash, gasUsed: BigInt(r1.gasUsed), gasUsedForL1: r1.gasUsedForL1 ? BigInt(r1.gasUsedForL1) : null, effectiveGasPrice: BigInt(r1.effectiveGasPrice), fee });
  saveRun(run);
  if (r1.status !== '0x1') throw new Error(`${label} reverted. Stopped; nothing is retried.`);
  return { receipt: r1, block: BigInt(r1.blockNumber), fee, entry };
}

async function deltas(label, block, fee, expectUsdc, expectA) {
  const [u0, u1, a0, a1, e0, e1] = await Promise.all([
    balanceAt(D.asset.address, DEV_EOA, block - 1n),
    balanceAt(D.asset.address, DEV_EOA, block),
    balanceAt(D.aToken.address, DEV_EOA, block - 1n),
    balanceAt(D.aToken.address, DEV_EOA, block),
    node('history')('eth_getBalance', [DEV_EOA, hex(block - 1n)]).then(BigInt),
    node('history')('eth_getBalance', [DEV_EOA, hex(block)]).then(BigInt),
  ]);
  const du = u1 - u0;
  const da = a1 - a0;
  const de = e1 - e0;
  expect(de === -fee, `${label}: ETH ${e0} → ${e1} (−${fee} = gas used × effective price, exact)`);
  if (expectUsdc !== null) expect(du === expectUsdc, `${label}: USDC ${u0} → ${u1} (${du})`);
  else console.log(`  info ${label}: USDC ${u0} → ${u1} (${du})`);
  if (expectA !== null) expect(da === expectA, `${label}: aArbSepUSDC ${a0} → ${a1} (${da})`);
  else console.log(`  info ${label}: aArbSepUSDC ${a0} → ${a1} (${da})`);
  return { usdc: [u0, u1, du], aToken: [a0, a1, da], eth: [e0, e1, de] };
}

async function live(signer, run) {
  console.log(`\nLIVE on ${CHAIN.name}: approve exactly ${fmtUsdc(AMOUNT)} USDC, supply it, withdraw everything back`);
  if (AMOUNT > USDC_CAP) throw new Error('The amount is above the 0.5 USDC cap. Nothing was sent.');
  if (getAddress(signer.address) !== DEV_EOA) throw new Error('The mnemonic file does not give the dev EOA as account 0. Nothing was sent.');
  const feeState = { worst: 0n };
  run.txs = run.txs ?? [];
  const startEth = BigInt(await node('rpc')('eth_getBalance', [DEV_EOA, 'latest']));
  if (startEth < FEE_CAP) throw new Error(`The dev EOA holds ${fmtEth(startEth)} ETH, less than the 0.002 ETH fee cap. Nothing was sent.`);

  let state = await E.readReserveState(node('rpc'), D);
  let pos = await E.readLendingPosition(node('rpc'), D, DEV_EOA);
  const q = E.quoteLendingSupply({ deployment: D, state, account: DEV_EOA, amount: AMOUNT, walletBalance: pos.walletBalance });
  if (q.refusals.length > 0) throw new Error(`The supply quote is refused: ${q.refusals.join(' ')}`);
  run.live = { startedAt: new Date().toISOString(), start: { block: pos.block, usdc: pos.walletBalance, aToken: pos.supplied, eth: startEth } };

  const ap = await sendOne(signer, q.calls[0], 'approve exactly 0.1 USDC', run, feeState);
  const allowance = BigInt(await node('history')('eth_call', [{ to: D.asset.address, data: iface.encodeFunctionData('allowance', [DEV_EOA, D.pool]) }, hex(ap.block)]));
  expect(allowance === AMOUNT, `allowance after the approval: ${allowance} (exactly 0.1 USDC)`);
  run.live.approve = { ...ap.entry, deltas: await deltas('approve', ap.block, ap.fee, 0n, 0n) };
  saveRun(run);

  state = await E.readReserveState(node('rpc'), D);
  pos = await E.readLendingPosition(node('rpc'), D, DEV_EOA);
  const q2 = E.quoteLendingSupply({ deployment: D, state, account: DEV_EOA, amount: AMOUNT, walletBalance: pos.walletBalance });
  if (q2.refusals.length > 0) throw new Error(`The supply quote is refused after the approval: ${q2.refusals.join(' ')}`);
  const sp = await sendOne(signer, q2.calls[1], 'supply 0.1 USDC', run, feeState);
  const spLogs = E.decodeLendingReceipt(sp.receipt.logs, D);
  expect(spLogs.supplies.length === 1 && spLogs.supplies[0].amount === AMOUNT && lower(spLogs.supplies[0].onBehalfOf) === lower(DEV_EOA), `Supply event: reserve ${spLogs.supplies[0]?.reserve}, user ${spLogs.supplies[0]?.user}, onBehalfOf ${spLogs.supplies[0]?.onBehalfOf}, amount ${spLogs.supplies[0]?.amount}, referral ${spLogs.supplies[0]?.referralCode}; collateral enabled ${spLogs.collateralEnabled.length}`);
  const allowanceAfter = BigInt(await node('history')('eth_call', [{ to: D.asset.address, data: iface.encodeFunctionData('allowance', [DEV_EOA, D.pool]) }, hex(sp.block)]));
  expect(allowanceAfter === 0n, 'allowance after the supply: 0');
  run.live.supply = { ...sp.entry, event: spLogs.supplies[0], collateralEnabled: spLogs.collateralEnabled.length, deltas: await deltas('supply', sp.block, sp.fee, -AMOUNT, null) };
  saveRun(run);

  // Read the position, then withdraw everything.
  await sleep(15_000);
  const before = await E.readLendingPosition(node('rpc'), D, DEV_EOA);
  console.log(`  position at block ${before.block}: ${before.supplied} aArbSepUSDC base units (supplied ${AMOUNT})`);
  run.live.positionBeforeWithdraw = { block: before.block, supplied: before.supplied };
  state = await E.readReserveState(node('rpc'), D);
  const wq = E.quoteLendingWithdraw({ deployment: D, state, account: DEV_EOA, amount: 'all', supplied: before.supplied });
  if (wq.refusals.length > 0) throw new Error(`The withdrawal quote is refused: ${wq.refusals.join(' ')}`);
  const wd = await sendOne(signer, wq.calls[0], 'withdraw everything', run, feeState);
  const wdLogs = E.decodeLendingReceipt(wd.receipt.logs, D);
  const got = wdLogs.withdrawals[0]?.amount ?? -1n;
  expect(wdLogs.withdrawals.length === 1 && lower(wdLogs.withdrawals[0].to) === lower(DEV_EOA) && got >= AMOUNT, `Withdraw event: reserve ${wdLogs.withdrawals[0]?.reserve}, user ${wdLogs.withdrawals[0]?.user}, to ${wdLogs.withdrawals[0]?.to}, amount ${got} (${got - AMOUNT} base units of interest over the 0.1 supplied); collateral disabled ${wdLogs.collateralDisabled.length}`);
  run.live.withdraw = { ...wd.entry, event: wdLogs.withdrawals[0], collateralDisabled: wdLogs.collateralDisabled.length, deltas: await deltas('withdraw', wd.block, wd.fee, got, null) };
  const aAfter = await balanceAt(D.aToken.address, DEV_EOA, wd.block);
  expect(aAfter === 0n, `aArbSepUSDC after the withdrawal: ${aAfter}`);
  const end = await E.readLendingPosition(node('rpc'), D, DEV_EOA);
  const endEth = BigInt(await node('rpc')('eth_getBalance', [DEV_EOA, 'latest']));
  const fees = ap.fee + sp.fee + wd.fee;
  run.live.end = { block: end.block, usdc: end.walletBalance, aToken: end.supplied, eth: endEth, feesTotal: fees, usdcNet: end.walletBalance - run.live.start.usdc, interest: got - AMOUNT };
  expect(end.walletBalance - run.live.start.usdc === got - AMOUNT, `USDC over the run: ${run.live.start.usdc} → ${end.walletBalance} (net ${end.walletBalance - run.live.start.usdc} = the interest returned)`);
  expect(startEth - endEth === fees, `ETH over the run: ${startEth} → ${endEth} (−${fees} = the three fees)`);
  run.live.finishedAt = new Date().toISOString();
  saveRun(run);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const run = loadRun() ?? { createdAt: new Date().toISOString() };
run.devEoa = DEV_EOA;
run.deployment = { pool: D.pool, asset: D.asset.address, aToken: D.aToken.address };
run.caps = { usdc: USDC_CAP, fees: FEE_CAP };
console.log(`Lending smoke: ${D.marketId}; dev EOA ${DEV_EOA}; mode ${LIVE ? 'LIVE' : 'dry run'}`);
try {
  await dryRun(run);
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed in the dry run. Nothing live was attempted.`);
    saveRun(run);
    process.exit(1);
  }
  if (LIVE) {
    if (run.live?.finishedAt && process.env.LENDING_REPEAT !== '1') throw new Error('The record says the live leg already ran; set LENDING_REPEAT=1 to run it again.');
    const file = process.env.LENDING_MNEMONIC_FILE;
    if (!file || !existsSync(file)) throw new Error('LENDING_MNEMONIC_FILE does not name a readable file. Nothing was sent.');
    if ((statSync(file).mode & 0o077) !== 0) throw new Error('The mnemonic file must not be readable by group or others (chmod 600). Nothing was sent.');
    const registry = new ChainRegistry();
    registry.register(evmKeyProvider);
    const signer = HdKeyring.fromMnemonic(readFileSync(file, 'utf8').trim(), registry).getAccount('eip155:1');
    await live(signer, run);
  }
} catch (e) {
  console.log(`\nSTOPPED: ${errText(e)}`);
  saveRun(run);
  process.exit(1);
}
saveRun(run);
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`}; record scripts/testnet/runs/lending-run.json`);
process.exit(failures === 0 ? 0 : 1);

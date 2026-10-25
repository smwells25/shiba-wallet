#!/usr/bin/env node
/**
 * ENS handle smoke test on Ethereum Sepolia (phase 23 item 6; the research
 * record is docs/WALLET_HANDLES.md). Drives the engine's ens-register.ts
 * exactly as the app will: the quote, the owner's resolver, the two-step
 * plan, and the sub-name plan. ethers is used only to check the engine's
 * work (independent encodings and decodings).
 *
 * DRY RUN (default; nothing is signed or sent):
 *  - the deployment: code and identity reads on two endpoints (the Universal
 *    Resolver proxy chain to UniversalResolverV2 and its ROOT_REGISTRY, the
 *    root's .eth subregistry and "reverse" resolver, the registrar's roles on
 *    the .eth registry, the factory's proxyLogic, the v1 ReverseRegistrar's
 *    default resolver, the oracle's acceptance of Circle's USDC) and the
 *    registrar's configuration;
 *  - the quote (the registrar's price equal to the engine's mirror), the
 *    sender's USDC and ETH, the commitment equal to the registrar's own
 *    makeCommitment, the resolver address equal to the factory's own
 *    predictProxyAddress;
 *  - eth_simulateV1 of the exact plan in two simulated blocks: block 1 at
 *    time T holds the prepare calls, block 2 holds the register calls. A
 *    simulation cannot wait, so the commitment age is handled with
 *    blockOverrides.time (geth's eth_simulateV1 "blockOverrides"): block 2 at
 *    T + 59 must revert CommitmentTooNew, and at T + 60 (= MIN_COMMITMENT_AGE)
 *    the registration, the reverse record, Universal Resolver forward and
 *    reverse resolution and the remaining allowance are checked in the same
 *    simulation; negatives (an unknown commitment, an approval one unit
 *    short, registering the same name again) must revert;
 *  - both sub-name shapes (registered and record-only) simulated after the
 *    registration, resolved through the Universal Resolver, and the target's
 *    own reverse record when the target has code.
 *
 *   ENS_SENDER=0x… node scripts/testnet/ens-register-smoke.mjs
 *       dry run as that address (no secret read). Without ENS_SENDER the
 *       dev EOA is derived from .dev-wallet/mnemonic.txt (only its address is
 *       printed), as the other smoke scripts do.
 *   ENS_LABEL=<label> chooses the label (default: a fresh probe label).
 *   ENS_SUBNAME_TARGET=0x… the address the sub-name points at (default: the
 *       dev Kernel account 0xc995…C5AC, the same counterfactual address on
 *       every network).
 *
 * LIVE (ENS_LIVE=1; the CTO's step — a registration costs test USDC and test
 * ETH and a name cannot be taken back): requires ENS_LABEL, signs with the
 * dev EOA, and runs the dry run first. Caps: the registration fee at most
 * ENS_MAX_FEE_USDC base units (default 1,000,000 = 1 USDC), the duration
 * ENS_DURATION_SECONDS (default 2,419,200 = 28 days, the minimum), and the
 * gas worst case of all transactions together at most 0.02 ETH. It sends the
 * prepare transactions one by one (each simulated first, each receipt read
 * on two endpoints), waits until a block's time passes the commitment age,
 * simulates and sends register and setName, then checks forward and reverse
 * resolution on two endpoints. ENS_LIVE_SUBNAME=registered|record-only then
 * adds smart.<label>.eth → ENS_SUBNAME_TARGET. The run record (including the
 * secret until register is mined) is scripts/testnet/runs/ens-register-run.json,
 * which is git-ignored; ENS_RESUME=1 continues a run whose prepare step was
 * mined but whose register step was not, or — when the record says
 * "registered" — skips the dry run and the availability quote (the name is
 * now taken, by the sender), checks the deployment again, proves on-chain
 * that the name is registered to the sender with the recorded resolver, and
 * continues with the primary name (if not yet sent), verification and the
 * sub-name. register is sent only once the LATEST BLOCK on both endpoints is
 * at least one slot (12 s) past the commitment's notBefore; a pending-nonce
 * mismatch is read again up to four times 5 s apart (PublicNode's backends
 * disagree for a few seconds after a transaction is mined).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { AbiCoder, Interface, getAddress, dnsEncode, namehash as ethersNamehash, keccak256, id as ethersId } from 'ethers';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import * as E from '../../packages/chains-evm/dist/index.js';

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const RPC2 = 'https://sepolia.drpc.org';
const EXPLORER = 'https://sepolia.etherscan.io/tx/';
const D = E.ENS_V2_SEPOLIA;
const USDC = E.ENS_V2_SEPOLIA_USDC;
const UR_PROXY = E.ENS_UNIVERSAL_RESOLVER;
const MANAGED_URP = '0x6d80F2172CFdEc5730fE683860C33d26fC42e6F1';
const UR_V2 = '0x24E1D8e068620B647CA097f961A61055f4f42D72';
const DEV_KERNEL = '0xc995E49acA5C888F4FF1E50E8467E9fFc31CC5AC';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const MAX_FEE_USDC = BigInt(process.env.ENS_MAX_FEE_USDC ?? 1_000_000);
const DURATION = BigInt(process.env.ENS_DURATION_SECONDS ?? 2_419_200);
const MAX_GAS_WEI = 2n * 10n ** 16n; // 0.02 ETH for every transaction of the run together
/** Seconds beyond the commitment's notBefore that the LATEST BLOCK on both endpoints must reach (one Sepolia slot). */
const READY_MARGIN_SECONDS = 12n;
const PENDING_REREADS = 4;
const PENDING_REREAD_MS = 5_000;
const RUN_FILE = new URL('./runs/ens-register-run.json', import.meta.url);
const coder = AbiCoder.defaultAbiCoder();

const I = new Interface([
  'function implementation() view returns (address)',
  'function ROOT_REGISTRY() view returns (address)',
  'function getSubregistry(string) view returns (address)',
  'function getResolver(string) view returns (address)',
  'function hasRootRoles(uint256,address) view returns (bool)',
  'function proxyLogic() view returns (address)',
  'function predictProxyAddress(address,uint256) view returns (address)',
  'function defaultResolver() view returns (address)',
  'function isPaymentToken(address) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function makeCommitment(string,address,bytes32,address,address,uint64,bytes32) pure returns (bytes32)',
  'function resolve(bytes,bytes) view returns (bytes,address)',
  'function reverse(bytes,uint256) view returns (string,address,address)',
  'function addr(bytes32) view returns (address)',
  'function getState(uint256) view returns ((uint8,uint64,address,uint256,uint256))',
  'function BENEFICIARY() view returns (address)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

let failures = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
  return cond;
};
const lower = (a) => String(a).toLowerCase();
const hex = (n) => '0x' + BigInt(n).toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtUsdc = (n) => `${(Number(n) / 1e6).toFixed(6)} USDC (${n} base units)`;

let rpcId = 1;
function nodeAt(url) {
  return async (method, params) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host} for ${method}`);
    const j = await res.json();
    if (j.error) {
      const e = new Error(`${method}: ${j.error.message}`);
      e.code = j.error.code;
      e.data = j.error.data;
      throw e;
    }
    return j.result;
  };
}
const node = nodeAt(RPC);
const node2 = nodeAt(RPC2);

async function view(n, to, fn, args = []) {
  const data = I.encodeFunctionData(fn, args);
  return I.decodeFunctionResult(fn, await n('eth_call', [{ to, data }, 'latest']));
}

/** eth_simulateV1 over blocks of {from, to, data, value?}; returns per-block per-call results. */
async function simulate(blocks) {
  const payload = {
    blockStateCalls: blocks.map((b) => ({
      ...(b.time !== undefined ? { blockOverrides: { time: hex(b.time) } } : {}),
      calls: b.calls.map((c) => ({ from: c.from, to: c.to, input: typeof c.data === 'string' ? c.data : E.toHex(c.data), ...(c.value ? { value: hex(c.value) } : {}) })),
    })),
    validation: false,
    traceTransfers: true,
  };
  const out = await node('eth_simulateV1', [payload, 'latest']);
  return out.map((b) => b.calls.map((c) => ({ ok: c.status === '0x1', gasUsed: BigInt(c.gasUsed), returnData: c.returnData, revert: c.status === '0x1' ? null : (c.error?.data ?? null), message: c.error?.message ?? null, logs: c.logs ?? [] })));
}

function revertKind(r) {
  return r.revert ? E.classifyEnsRegisterRevert(r.revert) : `no revert data (${r.message})`;
}

function decodeResolveAddr(returnData) {
  const [data, resolver] = I.decodeFunctionResult('resolve', returnData);
  return { address: I.decodeFunctionResult('addr', data)[0], resolver };
}

// ---------------------------------------------------------------------------
// Deployment identity
// ---------------------------------------------------------------------------

async function checkDeployment() {
  console.log('\n-- the ENSv2 Sepolia deployment (contracts-v2 at 07e55a05), two endpoints');
  for (const [n, name] of [[node, new URL(RPC).host], [node2, new URL(RPC2).host]]) {
    ok(BigInt(await n('eth_chainId', [])) === 11155111n, `${name}: chain id 11155111`);
    for (const [k, a] of Object.entries(D)) {
      if (k === 'chainId') continue;
      const code = await n('eth_getCode', [a, 'latest']);
      ok(code !== '0x', `${name}: ${k} ${a} has code (${(code.length - 2) / 2} bytes, keccak ${keccak256(code).slice(0, 18)}…)`);
    }
  }
  const slot1 = await node('eth_getStorageAt', [UR_PROXY, IMPL_SLOT, 'latest']);
  const slot2 = await node('eth_getStorageAt', [MANAGED_URP, IMPL_SLOT, 'latest']);
  ok(lower('0x' + slot1.slice(-40)) === lower(MANAGED_URP), `Universal Resolver proxy → ${MANAGED_URP} (ERC-1967 slot)`);
  ok(lower('0x' + slot2.slice(-40)) === lower(UR_V2), `ManagedUniversalResolverProxy → UniversalResolverV2 ${UR_V2}`);
  ok(lower((await view(node, UR_V2, 'ROOT_REGISTRY'))[0]) === lower(D.rootRegistry), 'UniversalResolverV2.ROOT_REGISTRY() is the pinned root registry');
  ok(lower((await view(node, D.rootRegistry, 'getSubregistry', ['eth']))[0]) === lower(D.ethRegistry), 'root.getSubregistry("eth") is the pinned .eth registry');
  ok(lower((await view(node, D.rootRegistry, 'getResolver', ['reverse']))[0]) === lower(D.reverseMirrorResolver), 'root.getResolver("reverse") is the ENSV1Resolver mirror');
  ok((await view(node, D.ethRegistry, 'hasRootRoles', [1n | (1n << 16n), D.ethRegistrar]))[0] === true, 'the registrar holds REGISTRAR|RENEW on the .eth registry');
  ok(lower((await view(node, D.verifiableFactory, 'proxyLogic'))[0]) === lower(D.verifiableProxyLogic), 'VerifiableFactory.proxyLogic() is the pinned logic');
  ok(lower((await view(node, D.v1ReverseRegistrar, 'defaultResolver'))[0]) === lower(D.v1DefaultResolver), 'v1 ReverseRegistrar.defaultResolver() is the pinned v1 PublicResolver');
  ok((await view(node, D.rentPriceOracle, 'isPaymentToken', [USDC.address]))[0] === true, "the oracle accepts Circle's Sepolia USDC");
  const config = await E.readEnsRegistrarConfig(node);
  ok(true, `registrar: commitment age ${config.minCommitmentAge}–${config.maxCommitmentAge} s, minimum duration ${config.minRegisterDuration} s, grace ${config.gracePeriod} s`);
  return config;
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

async function dryRun(sender, label, target) {
  const config = await checkDeployment();
  console.log(`\n-- quote for ${label}.eth, owner ${sender}, ${DURATION} s`);
  const quote = await E.quoteEnsRegistration(node, { label, owner: sender, duration: DURATION });
  ok(quote.premium === 0n, `registrar price ${fmtUsdc(quote.base)} + premium 0, equal to the engine's mirror (block ${quote.blockNumber})`);
  const usdc = (await view(node, USDC.address, 'balanceOf', [sender]))[0];
  const eth = BigInt(await node('eth_getBalance', [sender, 'latest']));
  ok(usdc >= quote.total, `sender holds ${fmtUsdc(usdc)} ≥ the fee`);
  console.log(`  info sender holds ${eth} wei of test ETH`);

  const resolver = await E.readEnsOwnedResolver(node, sender);
  const onchainPredict = (await view(node, D.verifiableFactory, 'predictProxyAddress', [sender, resolver.salt]))[0];
  ok(lower(onchainPredict) === lower(resolver.address), `owner resolver ${resolver.address} = factory predictProxyAddress (${resolver.deployed ? 'deployed' : 'not deployed yet'})`);

  const secret = E.newEnsCommitSecret();
  const plan = E.planEnsRegistration({ quote, resolver, secret, setReverse: true });
  const onchainCommit = (await view(node, D.ethRegistrar, 'makeCommitment', [label, sender, plan.secret, '0x' + '00'.repeat(20), resolver.address, DURATION, '0x' + '00'.repeat(32)]))[0];
  ok(lower(onchainCommit) === lower(plan.commitment), `commitment ${plan.commitment.slice(0, 18)}… = ETHRegistrar.makeCommitment`);
  for (const line of [...plan.prepare.describe, ...plan.register.describe]) console.log(`  plan: ${line}`);

  const head = await node('eth_getBlockByNumber', ['latest', false]);
  const T = BigInt(head.timestamp) + 12n;
  const from = (calls) => calls.map((c) => ({ ...c, from: sender }));
  const prepareBlock = { time: T, calls: from(plan.prepare.calls) };

  console.log('\n-- eth_simulateV1: register 59 s after the commit (must revert CommitmentTooNew)');
  const early = await simulate([prepareBlock, { time: T + config.minCommitmentAge - 1n, calls: from(plan.register.calls.slice(0, 1)) }]);
  ok(early[0].every((r) => r.ok), `prepare calls succeed (gas ${early[0].map((r) => r.gasUsed).join(' + ')})`);
  ok(!early[1][0].ok && revertKind(early[1][0]) === 'commitmentTooNew', `register at T+59 reverts ${revertKind(early[1][0])}`);

  console.log('\n-- eth_simulateV1: the whole plan with register at T + 60, then the Universal Resolver');
  const reads = [
    { from: sender, to: UR_PROXY, data: I.encodeFunctionData('resolve', [dnsEncode(plan.name, 255), I.encodeFunctionData('addr', [ethersNamehash(plan.name)])]) },
    { from: sender, to: UR_PROXY, data: I.encodeFunctionData('reverse', [sender, 60n]) },
    { from: sender, to: USDC.address, data: I.encodeFunctionData('allowance', [sender, D.ethRegistrar]) },
  ];
  const sim = await simulate([prepareBlock, { time: T + config.minCommitmentAge, calls: [...from(plan.register.calls), ...reads] }]);
  const [reg, rev, fwd, back, allowance] = sim[1];
  ok(reg.ok, `register succeeds (gas ${reg.gasUsed})`);
  const beneficiary = (await view(node, D.ethRegistrar, 'BENEFICIARY'))[0];
  const transfers = reg.logs.filter((l) => lower(l.address) === lower(USDC.address) && l.topics[0] === I.getEvent('Transfer').topicHash).map((l) => I.parseLog(l));
  ok(transfers.length === 1 && lower(transfers[0].args.from) === lower(sender) && lower(transfers[0].args.to) === lower(beneficiary) && transfers[0].args.value === quote.total, `the registrar pulls exactly ${fmtUsdc(quote.total)} from the sender to its beneficiary ${beneficiary}`);
  ok(rev.ok, `v1 ReverseRegistrar.setName succeeds (gas ${rev.gasUsed})`);
  if (ok(fwd.ok, 'Universal Resolver resolve(name, addr) answers')) {
    const r = decodeResolveAddr(fwd.returnData);
    ok(lower(r.address) === lower(sender) && lower(r.resolver) === lower(resolver.address), `${plan.name} → ${r.address} via resolver ${r.resolver}`);
  }
  if (ok(back.ok, 'Universal Resolver reverse(address, 60) answers (it forward-checks the name itself)')) {
    const [primary] = I.decodeFunctionResult('reverse', back.returnData);
    ok(primary === plan.name, `${sender} → ${primary}`);
  }
  ok(allowance.ok && BigInt(allowance.returnData) === 0n, 'no USDC allowance is left for the registrar');
  const totalGas = [...sim[0], reg, rev].reduce((s, r) => s + r.gasUsed, 0n);
  console.log(`  info gas used by the plan: ${totalGas} (prepare ${sim[0].map((r) => r.gasUsed).join(' + ')}; register ${reg.gasUsed}; setName ${rev.gasUsed})`);

  console.log('\n-- negatives (simulated)');
  const otherSecret = E.newEnsCommitSecret();
  const wrong = { ...plan.register.calls[0], data: E.encodeEnsRegister({ label, owner: sender, secret: otherSecret, subregistry: '0x' + '00'.repeat(20), resolver: resolver.address, duration: DURATION, referrer: new Uint8Array(32) }, USDC.address) };
  const shortApprove = { to: USDC.address, value: 0n, data: E.encodeEnsExactApprove(D.ethRegistrar, quote.total - 1n) };
  const neg = await simulate([
    { time: T, calls: from([plan.prepare.calls[0], shortApprove, plan.prepare.calls[2]]) },
    { time: T + config.minCommitmentAge, calls: from([wrong, plan.register.calls[0]]) },
  ]);
  ok(!neg[1][0].ok && revertKind(neg[1][0]) === 'commitmentTooOld', `a register whose secret was never committed reverts ${revertKind(neg[1][0])} (commitmentAt is 0)`);
  ok(!neg[1][1].ok, `register with an approval one unit short reverts (${neg[1][1].message ?? revertKind(neg[1][1])})`);
  const again = await simulate([prepareBlock, { time: T + config.minCommitmentAge, calls: from([plan.register.calls[0], plan.register.calls[0]]) }]);
  ok(again[1][0].ok && !again[1][1].ok, `registering the same commitment twice: the second reverts ${revertKind(again[1][1])}`);

  console.log(`\n-- sub-name smart.${plan.name} → ${target} (both shapes, simulated after the registration)`);
  const parentExpiry = T + config.minCommitmentAge + DURATION;
  const deployedResolver = { ...resolver, deployed: true };
  for (const mode of ['registered', 'record-only']) {
    const userReg = E.predictVerifiableProxyAddress(sender, E.ensUserRegistrySalt(plan.name));
    const userRegDeployed = (await node('eth_getCode', [userReg, 'latest'])) !== '0x';
    const sub = E.planEnsSubname({ parentLabel: label, subLabel: 'smart', owner: sender, target, resolver: deployedResolver, mode, parentExpiry, parentSubregistry: '0x' + '00'.repeat(20), userRegistryDeployed: userRegDeployed, targetReverse: true });
    const targetHasCode = (await node('eth_getCode', [target, 'latest'])) !== '0x';
    const subReads = [
      { from: sender, to: UR_PROXY, data: I.encodeFunctionData('resolve', [dnsEncode(sub.name, 255), I.encodeFunctionData('addr', [ethersNamehash(sub.name)])]) },
      ...(targetHasCode ? [{ ...sub.targetReverseCall, from: target }, { from: sender, to: UR_PROXY, data: I.encodeFunctionData('reverse', [target, 60n]) }] : []),
    ];
    const s = await simulate([prepareBlock, { time: T + config.minCommitmentAge, calls: [...from(plan.register.calls), ...from(sub.step.calls), ...subReads] }]);
    const subResults = s[1].slice(plan.register.calls.length, plan.register.calls.length + sub.step.calls.length);
    ok(subResults.every((r) => r.ok), `${mode}: ${sub.step.calls.length} call(s) succeed (gas ${subResults.map((r) => r.gasUsed).join(' + ')})`);
    const r = s[1][plan.register.calls.length + sub.step.calls.length];
    if (ok(r.ok, `${mode}: the Universal Resolver resolves ${sub.name}`)) {
      const d = decodeResolveAddr(r.returnData);
      ok(lower(d.address) === lower(target), `${mode}: ${sub.name} → ${d.address}`);
    }
    if (targetHasCode) {
      const [setName, reverse] = s[1].slice(-2);
      ok(setName.ok, `${mode}: the target's own setName succeeds (sent by the target; gas ${setName.gasUsed})`);
      if (ok(reverse.ok, `${mode}: reverse(target) answers`)) ok(I.decodeFunctionResult('reverse', reverse.returnData)[0] === sub.name, `${mode}: ${target} → ${sub.name}`);
    } else {
      console.log(`  info the target ${target} has no code on Sepolia, so its own reverse record (a UserOperation) is not simulated`);
    }
  }
  return { quote, resolver, plan };
}

// ---------------------------------------------------------------------------
// Live (the CTO's step)
// ---------------------------------------------------------------------------

function loadRun() {
  if (!existsSync(RUN_FILE)) return null;
  return JSON.parse(readFileSync(RUN_FILE, 'utf8'), (k, v) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
}
function saveRun(run) {
  mkdirSync(new URL('./runs/', import.meta.url), { recursive: true });
  writeFileSync(RUN_FILE, JSON.stringify(run, (k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2));
}

async function receiptOn(n, hash, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const r = await n('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) return r;
    await sleep(4000);
  }
  throw new Error(`No receipt for ${hash} after ${(tries * 4) / 60} minutes`);
}

let gasBudgetUsed = 0n;
async function sendCall(signer, call, label) {
  const sender = getAddress(signer.address);
  const data = E.toHex(call.data);
  const [sim] = await simulate([{ calls: [{ from: sender, to: call.to, data, value: call.value }] }]);
  if (!sim[0].ok) throw new Error(`${label}: the pre-flight simulation reverted (${revertKind(sim[0])}). Nothing was sent.`);
  // PublicNode balances several backends that can disagree about the pending nonce for a
  // few seconds right after a transaction is mined (seen 2026-10-25 straight after setName);
  // the counts are read again a few times before the run stops.
  let latest = 0n;
  let pending = 0n;
  for (let attempt = 0; ; attempt++) {
    latest = BigInt(await node('eth_getTransactionCount', [sender, 'latest']));
    pending = BigInt(await node('eth_getTransactionCount', [sender, 'pending']));
    if (latest === pending) break;
    if (attempt >= PENDING_REREADS) throw new Error(`${label}: the sender has ${pending - latest} pending transaction(s) after ${PENDING_REREADS} re-reads ${PENDING_REREAD_MS / 1000} s apart. Nothing was sent.`);
    console.log(`  ${label}: the endpoint reports ${pending - latest} pending transaction(s); reading again in ${PENDING_REREAD_MS / 1000} s`);
    await sleep(PENDING_REREAD_MS);
  }
  const estimate = BigInt(await node('eth_estimateGas', [{ from: sender, to: call.to, data, value: hex(call.value) }]));
  const gasLimit = (estimate * 120n) / 100n;
  const fees = await new E.NodeClient(node).suggestFees();
  const worst = gasLimit * fees.maxFeePerGas;
  if (gasBudgetUsed + worst > MAX_GAS_WEI) throw new Error(`${label}: the run's gas worst case would exceed 0.02 ETH. Nothing was sent.`);
  gasBudgetUsed += worst;
  const tx = { chainId: 11155111n, nonce: latest, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, gasLimit, to: call.to, value: call.value, data: call.data };
  const signed = E.signEip1559(tx, signer);
  console.log(`  ${label}: nonce ${latest}, gas ${estimate} → limit ${gasLimit}, maxFee ${fees.maxFeePerGas}, worst case ${worst} wei`);
  const hash = await node('eth_sendRawTransaction', [signed.rawHex]);
  if (lower(hash) !== lower(signed.txHash)) throw new Error(`${label}: the node returned ${hash}, not ${signed.txHash}`);
  console.log(`  SENT ${hash} (${EXPLORER}${hash})`);
  const [r1, r2] = await Promise.all([receiptOn(node, hash), receiptOn(node2, hash)]);
  ok(r1.status === '0x1' && r2.status === '0x1' && r1.blockHash === r2.blockHash, `${label}: status 0x1 in block ${BigInt(r1.blockNumber)} on both endpoints, gas used ${BigInt(r1.gasUsed)}`);
  if (r1.status !== '0x1') throw new Error(`${label} reverted on-chain. Stopped.`);
  return { hash, blockNumber: BigInt(r1.blockNumber), gasUsed: BigInt(r1.gasUsed), effectiveGasPrice: BigInt(r1.effectiveGasPrice) };
}

async function live(signer, label, target) {
  const sender = getAddress(signer.address);
  let run = process.env.ENS_RESUME === '1' ? loadRun() : null;
  if (run && (run.label !== label || lower(run.owner) !== lower(sender))) throw new Error('The run record is for another label or sender. Nothing was sent.');
  let plan;
  if (!run) {
    if (existsSync(RUN_FILE) && loadRun()?.status !== 'registered') throw new Error('An unfinished run record exists; use ENS_RESUME=1 or move it away. Nothing was sent.');
    const quote = await E.quoteEnsRegistration(node, { label, owner: sender, duration: DURATION });
    if (quote.total > MAX_FEE_USDC) throw new Error(`The fee ${fmtUsdc(quote.total)} is above the cap ${fmtUsdc(MAX_FEE_USDC)}. Nothing was sent.`);
    const resolver = await E.readEnsOwnedResolver(node, sender);
    plan = E.planEnsRegistration({ quote, resolver, secret: E.newEnsCommitSecret(), setReverse: true });
    run = { label, name: plan.name, owner: sender, duration: DURATION, fee: quote.total, secret: plan.secret, commitment: plan.commitment, resolver: resolver.address, deploysResolver: plan.deploysResolver, status: 'planned', txs: {}, createdAt: new Date().toISOString() };
    saveRun(run);
    console.log(`\n=== LIVE prepare for ${plan.name}: fee ${fmtUsdc(quote.total)} (cap ${fmtUsdc(MAX_FEE_USDC)})`);
    const names = ['resolver', 'approve', 'commit'];
    for (let i = 0; i < plan.prepare.calls.length; i++) {
      run.txs[names[i]] = await sendCall(signer, plan.prepare.calls[i], names[i]);
      saveRun(run);
    }
    run.status = 'committed';
    saveRun(run);
  } else {
    console.log(`\n=== LIVE resume for ${run.name} (status ${run.status})`);
  }
  const resolverState = { address: run.resolver, salt: E.ensOwnedResolverSalt(sender), deployed: true };
  if (run.status === 'registered') {
    await afterRegistration(signer, run, resolverState, target);
    return;
  }
  // Rebuild the plan from the record: the same secret, resolver and fee.
  const quote = await E.quoteEnsRegistration(node, { label, owner: sender, duration: run.duration });
  if (quote.total !== run.fee) throw new Error(`The fee changed from ${run.fee} to ${quote.total}; the approval no longer matches. Nothing was sent.`);
  plan = E.planEnsRegistration({ quote, resolver: resolverState, secret: E.toBytes(run.secret), setReverse: true });
  if (lower(plan.commitment) !== lower(run.commitment)) throw new Error('The rebuilt commitment differs from the recorded one. Nothing was sent.');
  console.log('\n=== waiting for the commitment age');
  // register() checks block.timestamp >= commit time + MIN_COMMITMENT_AGE in the block that
  // includes it. On 2026-10-25 the first live run saw the engine's check pass with the latest
  // block's timestamp exactly equal to notBefore, and the pre-flight eth_simulateV1 against
  // "latest" (PublicNode balances several backends) still reverted CommitmentTooNew. So the run
  // waits until the latest block on BOTH endpoints is at least one slot past notBefore.
  for (;;) {
    let w;
    try {
      w = await E.checkEnsRegisterReady(node, plan);
    } catch (e) {
      if (e?.reason !== 'commitment' || !/too new|not on-chain/.test(e.message)) throw e;
      console.log(`  ${e.message}; waiting 15 s`);
      await sleep(15_000);
      continue;
    }
    const heads = await Promise.all([node, node2].map((n) => n('eth_getBlockByNumber', ['latest', false]).then((b) => BigInt(b.timestamp))));
    const need = w.notBefore + READY_MARGIN_SECONDS;
    if (heads.every((t) => t >= need)) {
      console.log(`  ready: committed at ${w.notBefore - 60n}; latest block times ${heads.join(' / ')} ≥ ${need} (notBefore + ${READY_MARGIN_SECONDS} s); valid until ${w.expiresAt}`);
      break;
    }
    console.log(`  latest block times ${heads.join(' / ')} not yet ≥ ${need} (notBefore + ${READY_MARGIN_SECONDS} s); waiting 6 s`);
    await sleep(6_000);
  }
  console.log('\n=== LIVE register');
  run.txs.register = await sendCall(signer, plan.register.calls[0], 'register');
  run.status = 'registered';
  run.secret = '(used)';
  saveRun(run);
  run.txs.setName = await sendCall(signer, plan.register.calls[1], 'setName');
  saveRun(run);
  await afterRegistration(signer, run, resolverState, target);
}

/**
 * Everything after register(): the primary name if it was not sent yet, verification on two
 * endpoints, and the optional sub-name. Reached directly by ENS_RESUME=1 when the record says
 * "registered" — then no availability quote is made (the name is taken, by the sender), and the
 * registry must show the name REGISTERED to the sender with the recorded resolver.
 */
async function afterRegistration(signer, run, resolverState, target) {
  const sender = getAddress(signer.address);
  const label = run.label;
  const plan = { name: run.name };
  const owned = await E.readEnsNameState(node, label);
  if (owned.status !== 2 || lower(owned.latestOwner) !== lower(sender)) {
    throw new Error(`${run.name} is not registered to the sender (status ${owned.status}, owner ${owned.latestOwner}). Nothing was sent.`);
  }
  const onchainResolver = (await view(node, D.ethRegistry, 'getResolver', [label]))[0];
  if (lower(onchainResolver) !== lower(resolverState.address)) {
    throw new Error(`${run.name} points at resolver ${onchainResolver}, not the recorded ${resolverState.address}. Nothing was sent.`);
  }
  await E.readEnsOwnedResolver(node, sender); // re-proves the resolver (factory proxy, owner holds ROLE_SET_ADDRESS)
  if (!run.txs.setName) {
    const current = await E.readEnsPrimaryName(node, sender, 11155111n);
    if (!(current.status === 'ok' && current.name === run.name)) {
      run.txs.setName = await sendCall(signer, { to: D.v1ReverseRegistrar, value: 0n, data: E.encodeEnsV1ReverseSetName(run.name) }, 'setName');
      saveRun(run);
    }
  }
  console.log('\n=== verification on two endpoints');
  for (const [n, host] of [[node, new URL(RPC).host], [node2, new URL(RPC2).host]]) {
    const fwd = await n('eth_call', [{ to: UR_PROXY, data: I.encodeFunctionData('resolve', [dnsEncode(plan.name, 255), I.encodeFunctionData('addr', [ethersNamehash(plan.name)])]) }, 'latest']);
    ok(lower(decodeResolveAddr(fwd).address) === lower(sender), `${host}: ${plan.name} → ${sender}`);
    const back = await n('eth_call', [{ to: UR_PROXY, data: I.encodeFunctionData('reverse', [sender, 60n]) }, 'latest']);
    ok(I.decodeFunctionResult('reverse', back)[0] === plan.name, `${host}: ${sender} → ${plan.name}`);
  }
  const primary = await E.readEnsPrimaryName(node, sender, 11155111n);
  ok(primary.status === 'ok' && primary.name === plan.name, `the engine's readEnsPrimaryName (what the app will show): ${JSON.stringify(primary)}`);
  const state = await E.readEnsNameState(node, label);
  ok(state.status === 2 && lower(state.latestOwner) === lower(sender), `the .eth registry: REGISTERED to ${state.latestOwner}, expiry ${state.expiry}`);
  const mode = process.env.ENS_LIVE_SUBNAME;
  if (mode === 'registered' || mode === 'record-only') {
    console.log(`\n=== LIVE sub-name smart.${plan.name} → ${target} (${mode})`);
    const userReg = E.predictVerifiableProxyAddress(sender, E.ensUserRegistrySalt(plan.name));
    const sub = E.planEnsSubname({
      parentLabel: label, subLabel: 'smart', owner: sender, target, resolver: resolverState, mode,
      parentExpiry: state.expiry,
      parentSubregistry: (await view(node, D.ethRegistry, 'getSubregistry', [label]))[0],
      userRegistryDeployed: (await node('eth_getCode', [userReg, 'latest'])) !== '0x',
      targetReverse: false,
    });
    const resolveSub = async (n) => {
      const data = I.encodeFunctionData('resolve', [dnsEncode(sub.name, 255), I.encodeFunctionData('addr', [ethersNamehash(sub.name)])]);
      try {
        return decodeResolveAddr(await n('eth_call', [{ to: UR_PROXY, data }, 'latest'])).address;
      } catch {
        return null; // no record yet (the Universal Resolver reverts or answers the zero address)
      }
    };
    const before = await resolveSub(node);
    if (before && lower(before) === lower(target)) {
      console.log(`  ${sub.name} already resolves to ${target}; nothing to send`);
    } else {
      run.txs.subname = [];
      for (let i = 0; i < sub.step.calls.length; i++) {
        run.txs.subname.push(await sendCall(signer, sub.step.calls[i], `subname ${i + 1}/${sub.step.calls.length}`));
        saveRun(run);
      }
    }
    for (const [n, host] of [[node, new URL(RPC).host], [node2, new URL(RPC2).host]]) {
      const got = await resolveSub(n);
      ok(got !== null && lower(got) === lower(target), `${host}: ${sub.name} → ${got}`);
    }
  }
  run.finishedAt = new Date().toISOString();
  saveRun(run);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const LIVE = process.env.ENS_LIVE === '1';
let signer = null;
let sender;
if (process.env.ENS_SENDER && !LIVE) {
  sender = getAddress(process.env.ENS_SENDER);
} else {
  const devPath = new URL('../../.dev-wallet/mnemonic.txt', import.meta.url);
  if (!existsSync(devPath)) {
    console.error('No .dev-wallet/mnemonic.txt: set ENS_SENDER for a dry run, or provide the dev wallet for a live run.');
    process.exit(1);
  }
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  signer = HdKeyring.fromMnemonic(readFileSync(devPath, 'utf8').trim(), registry).getAccount('eip155:1');
  sender = getAddress(signer.address);
}
const label = (process.env.ENS_LABEL ?? `shibadry${Date.now().toString(36)}`).trim();
const labelCheck = E.checkEnsHandleLabel(label);
if (!labelCheck.ok || labelCheck.label !== label) {
  console.error(`ENS_LABEL "${label}" is not a registrable lower-case label (${labelCheck.ok ? 'not normalized' : labelCheck.problem}).`);
  process.exit(1);
}
if (LIVE && !process.env.ENS_LABEL) {
  console.error('ENS_LIVE=1 needs ENS_LABEL: the name is the CTO\'s choice and permanent once registered.');
  process.exit(1);
}
const target = getAddress(process.env.ENS_SUBNAME_TARGET ?? DEV_KERNEL);
console.log(`ENS handle smoke: sender ${sender}; label ${label}.eth; ${DURATION} s; mode ${LIVE ? 'LIVE' : 'dry run'}; ethers id check ${ethersId('OwnedResolver').slice(0, 10)}`);

try {
  const registeredResume = LIVE && process.env.ENS_RESUME === '1' && loadRun()?.status === 'registered';
  if (registeredResume) {
    console.log('\nResuming a run whose name is already registered: the deployment is checked again; the dry run (whose quote refuses a taken name) is skipped.');
    await checkDeployment();
  } else {
    await dryRun(sender, label, target);
  }
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed in the dry run. Nothing live was attempted.`);
    process.exit(1);
  }
  if (LIVE) await live(signer, label, target);
} catch (e) {
  console.log(`\nSTOPPED: ${e?.reason ? `[${e.reason}] ` : ''}${e?.message ?? e}`);
  process.exit(1);
}
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

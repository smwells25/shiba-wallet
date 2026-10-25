// Exercises the wallet handle's glue (src/wallet/handle.ts, phase 23 item 6,
// feature 75; docs/WALLET_HANDLES.md) entirely OFFLINE: the engine's own
// recording of Ethereum Sepolia answers at block 11991433 (captured
// read-only on 2026-10-25 and embedded in packages/chains-evm/test/
// ens-register.test.ts — read from there, not copied) for the quote, plus a
// fake node for everything that changes with time (the latest block, the
// commitment, the allowance, the name's state, the reverse record, the
// register pre-flight). Covered: the offer (mainnet refused by the readiness
// row, other test networks by the network sentence, watch-only and multisig
// accounts), the label refusals, the quote and the USDC shortfall, the plan
// equal to the engine's for a fixed owner and secret, the exact approval and
// the exact-zero revoke, the stored record (strict, wallet-scoped through
// the storage seam, the decoy profile's own copy), the resume path read from
// the chain, the readiness rule from the LATEST BLOCK with one slot of
// margin, the pre-flight before the prompt (a CommitmentTooNew answer is a
// wait), the secret never in a sentence, a source file or a log, the
// record-only sub-name in the live shape smart.shibawalletdemo.eth, the
// primary-name line and its cache, source pins on the screen, Home and
// Receive, and mutation checks.
//
// Run from the app directory:
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-handle.mjs

import { ethers } from 'ethers';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ENS_V2_SEPOLIA,
  ENS_V2_SEPOLIA_USDC,
  ENS_REGISTER_ERROR_SELECTORS,
  ensOwnedResolverSalt,
  ensRegisterWindow,
  planEnsRegistration,
  planEnsSubname,
  predictVerifiableProxyAddress,
  toHex,
} from '@shiba-wallet/chains-evm';
import * as H from '../src/wallet/handle.ts';
import { en } from '../src/i18n/en.ts';
import { es } from '../src/i18n/es.ts';
import { readinessRefusal, featureReadiness } from '../src/config/readiness.ts';
import { multisigRouteRefusal, watchOnlyRouteRefusal, MULTISIG_ALLOWED_ROUTES, WATCH_ONLY_ALLOWED_ROUTES } from '../src/wallet/watch-only.ts';
import { STORE_KEYS, profileBoundStore, scopedStoreKey } from '../src/wallet/store-keys.ts';
import { simulationTransport } from '../src/wallet/simulation.ts';

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
const source = (rel) => readFileSync(join(APP_ROOT, rel), 'utf8');

// Mutation checks load a deliberately broken copy of src/wallet/handle.ts
// from a scratch directory (relative imports rewritten to the real files),
// the check-bridge.mjs pattern. The directory is removed on exit.
const MUTANT_DIR = join(HERE, `.mutants-handle-${process.pid}`);
let mutantCount = 0;
process.on('exit', () => rmSync(MUTANT_DIR, { recursive: true, force: true }));
const HANDLE_SOURCE = source('src/wallet/handle.ts');
async function handleMutant(from, to) {
  if (!HANDLE_SOURCE.includes(from)) throw new Error(`mutation anchor not found: ${from}`);
  const mutated = HANDLE_SOURCE.replace(from, to);
  const originalDir = join(APP_ROOT, 'src/wallet');
  const rewritten = mutated.replace(/(from\s+)'(\.{1,2}\/[^']+)'/g, (_m, kw, spec) => `${kw}'${pathToFileURL(resolve(originalDir, spec)).href}'`);
  mkdirSync(MUTANT_DIR, { recursive: true });
  mutantCount += 1;
  const file = join(MUTANT_DIR, `m${mutantCount}-handle.ts`);
  writeFileSync(file, rewritten);
  return import(pathToFileURL(file).href);
}
let mutantsCaught = 0;
function caught(name, wasCaught) {
  if (wasCaught) mutantsCaught += 1;
  check(`mutant caught: ${name}`, wasCaught);
}

// ---------------------------------------------------------------------------
// The engine's recording (Sepolia, block 11991433), read from its test file
// ---------------------------------------------------------------------------

const TEST_SOURCE = readFileSync(join(APP_ROOT, '../packages/chains-evm/test/ens-register.test.ts'), 'utf8');
const literal = /JSON\.parse\(\s*'((?:[^'\\]|\\.)*)',\s*\)/.exec(TEST_SOURCE);
if (!literal) throw new Error('The engine test recording was not found in ens-register.test.ts');
const RECORDING = JSON.parse(literal[1].replace(/\\(.)/g, '$1'));
check('the engine test recording loads (Sepolia answers at block 0xb6f989)', Object.keys(RECORDING).length >= 20 && RECORDING['eth_chainId []'].result === '0xaa36a7');

const DEV = '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C';
const DEV_RESOLVER = '0x599AE46486BC988C5bA9b98CdB1f7cF167dD6059';
const DEV_KERNEL = '0xc995E49acA5C888F4FF1E50E8467E9fFc31CC5AC';
const LABEL = 'shibawallet-fixture';
const FEE = 613_701n;
const SECRET = new Uint8Array(32).fill(0x5a);
const fixedRandom = (n) => SECRET.slice(0, n);
const coder = ethers.AbiCoder.defaultAbiCoder();
const sel = (sig) => ethers.id(sig).slice(0, 10);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const SEL = {
  balanceOf: sel('balanceOf(address)'),
  allowance: sel('allowance(address,address)'),
  commitmentAt: sel('commitmentAt(bytes32)'),
  getState: sel('getState(uint256)'),
  isAvailable: sel('isAvailable(string)'),
  register: sel('register(string,address,bytes32,address,address,uint64,address,bytes32)'),
  reverse: sel('reverse(bytes,uint256)'),
  verifyContract: sel('verifyContract(address)'),
  hasRootRoles: sel('hasRootRoles(uint256,address)'),
};

/**
 * A fake Sepolia node: the recording for the quote, the state below for
 * everything that moves. `state.now` is the latest block's time.
 */
function fakeNode(over = {}) {
  const state = {
    chainId: '0xaa36a7',
    now: 0x6ade10c4n,
    number: 0xb6f989n,
    usdc: 20_000_000n,
    allowance: 0n,
    commitTime: 0n,
    code: {},
    receipts: {},
    nameState: null, // { status, owner }
    reverse: null, // name string
    registerRevert: null, // revert data or null
    resolverDeployed: false,
    ...over,
  };
  const calls = [];
  const transport = async (method, params) => {
    calls.push(method === 'eth_call' ? `eth_call ${params[0].data.slice(0, 10)}` : method);
    if (method === 'eth_chainId') return state.chainId;
    if (method === 'eth_getBlockByNumber') return { number: '0x' + state.number.toString(16), timestamp: '0x' + state.now.toString(16) };
    if (method === 'eth_getCode') {
      const key = `eth_getCode ${JSON.stringify(params)}`;
      if (state.code[params[0].toLowerCase()] !== undefined) return state.code[params[0].toLowerCase()];
      if (RECORDING[key]) return RECORDING[key].result;
      return '0x';
    }
    if (method === 'eth_getTransactionReceipt') return state.receipts[params[0]] ?? null;
    if (method !== 'eth_call') throw new Error(`fake node: unexpected ${method}`);
    const { to, data } = params[0];
    const s = data.slice(0, 10);
    if (s === SEL.balanceOf && same(to, ENS_V2_SEPOLIA_USDC.address)) return word(state.usdc);
    if (s === SEL.allowance && same(to, ENS_V2_SEPOLIA_USDC.address)) return word(state.allowance);
    if (s === SEL.commitmentAt) return word(state.commitTime);
    if (s === SEL.getState && state.nameState) {
      const ns = state.nameState;
      return coder.encode(['uint256', 'uint256', 'address', 'uint256', 'uint256'], [ns.status, ns.expiry ?? 1_800_000_000n, ns.owner ?? ethers.ZeroAddress, 1n, 1n]);
    }
    if (s === SEL.isAvailable && state.available !== undefined) return word(state.available ? 1n : 0n);
    if (s === SEL.register) {
      if (state.registerRevert) {
        const err = new Error('RPC error 3: execution reverted (eth_call)');
        err.data = state.registerRevert;
        throw err;
      }
      return word(1n);
    }
    if (s === SEL.reverse) return coder.encode(['string', 'address', 'address'], [state.reverse ?? '', ethers.ZeroAddress, ENS_V2_SEPOLIA.reverseMirrorResolver]);
    if (s === SEL.verifyContract) return state.resolverDeployed ? word(BigInt(ENS_V2_SEPOLIA.permissionedResolverImpl)) : word(0n);
    if (s === SEL.hasRootRoles) return word(state.resolverDeployed ? 1n : 0n);
    const key = `eth_call ${JSON.stringify(params)}`;
    if (RECORDING[key]) {
      const hit = RECORDING[key];
      if (hit.error) {
        const e = new Error(hit.error.message);
        if (hit.error.data) e.data = hit.error.data;
        throw e;
      }
      return hit.result;
    }
    throw new Error(`fake node: no answer for ${key.slice(0, 160)}`);
  };
  transport.calls = calls;
  transport.state = state;
  return transport;
}

function memoryStore() {
  const map = new Map();
  return {
    map,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => {
      map.set(k, v);
    },
    removeItem: async (k) => {
      map.delete(k);
    },
  };
}

// ---------------------------------------------------------------------------
console.log('check-handle: where handles are offered, and for whom');
// ---------------------------------------------------------------------------
{
  const main = H.handleOfferFor('eip155:1');
  check('mainnet: refused by the readiness row, with its sentence (readinessRefusal)', !main.ok && main.reason === 'readiness' && main.text === readinessRefusal('wallet-handle'));
  const base = H.handleOfferFor('eip155:84532');
  check('Base Sepolia (a test network the readiness row allows): refused by the network sentence, naming it',
    !base.ok && base.reason === 'network' && base.text === en['handle.refusal.network'].replace('{network}', 'Base Sepolia'), JSON.stringify(base));
  check('Hoodi and OP Sepolia: refused the same way', !H.handleOfferFor('eip155:560048').ok && !H.handleOfferFor('eip155:11155420').ok);
  check('Ethereum Sepolia: offered', H.handleOfferFor('eip155:11155111').ok === true);
  check('the row is testnet-only and enforced', featureReadiness('wallet-handle').status === 'testnet-only' && featureReadiness('wallet-handle').enforced === true);
  check('Home link: Sepolia with a phrase or imported account only',
    H.handleLinkShown('eip155:11155111', { watchOnly: false, multisig: false }) &&
      !H.handleLinkShown('eip155:1', { watchOnly: false }) && !H.handleLinkShown('eip155:84532', { watchOnly: false }) &&
      !H.handleLinkShown('eip155:11155111', { watchOnly: true }) && !H.handleLinkShown('eip155:11155111', { watchOnly: false, multisig: true }));
  check('watch-only and multisig refusals (exact)',
    H.handleAccountRefusal({ watchOnly: true }) === en['handle.refusal.watchOnly'] && H.handleAccountRefusal({ watchOnly: false, multisig: true }) === en['handle.refusal.multisig']);
  check('the route gate refuses Handle for a watch-only and a multisig account, by name',
    !WATCH_ONLY_ALLOWED_ROUTES.includes('Handle') && !MULTISIG_ALLOWED_ROUTES.includes('Handle') &&
      /^Wallet handles \(ENS names\) is not available for a watch-only account/.test(watchOnlyRouteRefusal('Handle')) &&
      /^Wallet handles \(ENS names\) is not available for a multi-signature account/.test(multisigRouteRefusal('Handle')));
  check('the smart account as owner: Kernel v3.3 set up on this network only (not 7702, SimpleAccount, multisig, or unconfigured)',
    H.smartOwnerRefusal('kernel-v3.3', true) === null && H.smartOwnerRefusal('kernel-7702', true) === en['handle.owner.smartUnavailable'] &&
      H.smartOwnerRefusal('simple-account', true) !== null && H.smartOwnerRefusal('kernel-multisig', true) !== null && H.smartOwnerRefusal('kernel-v3.3', false) !== null);
}

// ---------------------------------------------------------------------------
console.log('check-handle: the label refusals (the engine rule, as sentences)');
// ---------------------------------------------------------------------------
{
  const cases = [
    ['', 'handle.label.empty'],
    ['  ', 'handle.label.empty'],
    ['ab', null, en['handle.label.tooShort'].replace('{min}', '3')],
    ['ab.eth', null, en['handle.label.tooShort'].replace('{min}', '3')],
    ['alice.com', 'handle.label.notEth'],
    ['a.b.eth', 'handle.label.notSecondLevel'],
    ['ålice', 'handle.label.notAscii'],
    ['ali ce', 'handle.label.notAscii'],
    ['ab--c', 'handle.label.labelExtension'],
    ['a'.repeat(300), 'handle.label.tooLong'],
  ];
  const bad = cases.filter(([input, id, text]) => {
    const r = H.checkHandleLabel(input);
    return r.ok || r.text !== (text ?? en[id]);
  });
  check(`every refusal is its sentence (${cases.length} inputs)`, bad.length === 0, bad.map((c) => JSON.stringify(H.checkHandleLabel(c[0]))).join('; '));
  const ok = H.checkHandleLabel('  ShibaWalletDemo.ETH ');
  check('"ShibaWalletDemo.ETH" → shibawalletdemo / shibawalletdemo.eth', ok.ok && ok.label === 'shibawalletdemo' && ok.name === 'shibawalletdemo.eth');
  check('sub-label: "smart" ok; "a.b" and "" refused with the sentence',
    H.checkHandleSubLabel('smart').ok && H.checkHandleSubLabel('a.b').text === en['handle.sub.invalid'] && H.checkHandleSubLabel('').text === en['handle.sub.invalid']);
}

// ---------------------------------------------------------------------------
console.log('check-handle: the quote, the plan equal to the engine’s, the exact approval');
// ---------------------------------------------------------------------------
let RECORD;
let QUOTED;
{
  const node = fakeNode();
  QUOTED = await H.quoteHandle(node, { label: LABEL, owner: DEV, ownerLabel: 'Account 1 ' + DEV });
  check('quote: the recorded fee 613,701 base units = 0.613701 USDC for 28 days; resolver not deployed at the conventional address',
    QUOTED.quote.total === FEE && H.formatUsdc(QUOTED.quote.total) === '0.613701' && QUOTED.quote.duration === 2_419_200n &&
      QUOTED.resolver.deployed === false && QUOTED.resolver.address === DEV_RESOLVER && QUOTED.usdcBalance === 20_000_000n);
  check('the term is the registrar minimum, 28 days, grace 28 days', H.HANDLE_DURATION_DAYS === 28 && H.HANDLE_GRACE_DAYS === 28);

  const { plan, record } = H.newHandlePlan({ quoted: QUOTED, signer: DEV, ownerKind: 'regular', createdAt: 1_793_000_000_000, random: fixedRandom });
  const engine = planEnsRegistration({ quote: QUOTED.quote, resolver: QUOTED.resolver, secret: SECRET, setReverse: true });
  const callsHex = (calls) => calls.map((c) => `${c.to}|${c.value}|${toHex(c.data)}`).join(',');
  check('the plan equals the engine’s planEnsRegistration for the fixed owner and secret (both steps, byte for byte)',
    callsHex(plan.prepare.calls) === callsHex(engine.prepare.calls) && callsHex(plan.register.calls) === callsHex(engine.register.calls) && plan.commitment === engine.commitment);
  check('the plan always sets the reverse record (setName in the register step)', plan.setsReverse === true && plan.register.calls.length === 2 && same(plan.register.calls[1].to, ENS_V2_SEPOLIA.v1ReverseRegistrar));
  const approve = new ethers.Interface(['function approve(address,uint256)']).decodeFunctionData('approve', toHex(plan.prepare.calls[1].data));
  check('the approval is EXACTLY the fee to the ENS registrar, on Circle’s USDC, value 0',
    same(plan.prepare.calls[1].to, ENS_V2_SEPOLIA_USDC.address) && same(approve[0], ENS_V2_SEPOLIA.ethRegistrar) && approve[1] === FEE && plan.prepare.calls[1].value === 0n);
  const revoke = H.revokeRegistrarApprovalCall();
  const revoked = new ethers.Interface(['function approve(address,uint256)']).decodeFunctionData('approve', toHex(revoke.data));
  check('the revoke is an approval of EXACTLY 0 to the ENS registrar on USDC', same(revoke.to, ENS_V2_SEPOLIA_USDC.address) && same(revoked[0], ENS_V2_SEPOLIA.ethRegistrar) && revoked[1] === 0n && revoke.value === 0n);
  check('the record: regular owner = signer, the fee, the commitment, no setAddress hash yet',
    record.owner === DEV && record.signer === DEV && record.total === '613701' && record.duration === '2419200' && record.commitment === plan.commitment &&
      record.deploysResolver === true && record.recordTx === null && record.secret === toHex(SECRET));
  const rebuilt = H.planFromPending(record);
  check('planFromPending rebuilds exactly the same calls and commitment from the stored record (the resume path)',
    callsHex(rebuilt.prepare.calls) === callsHex(plan.prepare.calls) && callsHex(rebuilt.register.calls) === callsHex(plan.register.calls) && rebuilt.commitment === plan.commitment);
  const fresh = H.newHandlePlan({ quoted: QUOTED, signer: DEV, ownerKind: 'regular' });
  check('without an injected generator every plan gets a fresh secret (and so another commitment)', fresh.record.secret !== record.secret && fresh.record.commitment !== record.commitment);
  RECORD = record;

  const poor = await rejection(() => H.quoteHandle(fakeNode({ usdc: 500_000n }), { label: LABEL, owner: DEV, ownerLabel: 'Account 1' }));
  check('USDC below the fee: refused with the exact figures (fee, held, short), nothing sent',
    poor instanceof H.HandleRefusal && poor.message === 'Not enough USDC: the registration fee is 0.613701 USDC and Account 1 holds 0.5 USDC (0.113701 USDC short). Nothing was sent.', poor?.message);
  const taken = await rejection(() => H.quoteHandle(fakeNode({ available: false }), { label: LABEL, owner: DEV, ownerLabel: 'x' }));
  check('a taken name: the engine refuses (unavailable) and the screen says so',
    taken?.reason === 'unavailable' && H.describeHandleError(taken, 'shibawallet-fixture.eth') === en['handle.refusal.taken'].replace('{name}', 'shibawallet-fixture.eth'));
  const premiumKey = Object.keys(RECORDING).find((k) => k.includes('0x61907b12') && k.includes('24ea00') && k.includes('736869626177616c6c65742d66697874757265'));
  const premiumNode = fakeNode();
  const savedPrice = RECORDING[premiumKey];
  RECORDING[premiumKey] = { result: word(FEE) + word(5n).slice(2) };
  const premium = await rejection(() => H.quoteHandle(premiumNode, { label: LABEL, owner: DEV, ownerLabel: 'x' }));
  RECORDING[premiumKey] = savedPrice;
  check('a name with a premium: the engine refuses and the screen says so', premium?.reason === 'premium' && H.describeHandleError(premium, 'x.eth') === en['handle.refusal.premium'].replace('{name}', 'x.eth'));
  const wrong = await rejection(() => H.quoteHandle(fakeNode({ chainId: '0x14a34' }), { label: LABEL, owner: DEV, ownerLabel: 'x' }));
  check('an endpoint on another chain: refused (wrong-chain) with the technical detail', wrong?.reason === 'wrong-chain' && H.describeHandleError(wrong).startsWith('The network endpoint does not serve Ethereum Sepolia'));
}

// ---------------------------------------------------------------------------
console.log('check-handle: the stored record (one wallet-scoped key, strict)');
// ---------------------------------------------------------------------------
{
  check('the key is declared wallet-scoped in the storage seam, AsyncStorage-backed',
    H.HANDLE_PENDING_KEY === 'shiba-wallet.handle-pending.v1' && STORE_KEYS.handlePending.scope === 'wallet' && STORE_KEYS.handlePending.backing === 'async-storage');
  const store = memoryStore();
  await H.savePendingHandle(store, RECORD);
  const loaded = await H.loadPendingHandles(store);
  check('save → load round-trips the record exactly', !loaded.damaged && loaded.records.length === 1 && JSON.stringify(loaded.records[0]) === JSON.stringify(RECORD));
  check('pendingFor finds it by signer (any case), and not for another account',
    H.pendingFor(loaded, DEV.toLowerCase())?.name === 'shibawallet-fixture.eth' && H.pendingFor(loaded, DEV_KERNEL) === null);
  check('the stored document is only under the declared key', [...store.map.keys()].join() === 'shiba-wallet.handle-pending.v1');
  const decoy = memoryStore();
  await H.savePendingHandle(profileBoundStore(decoy, { id: 'decoy', keyPrefix: 'w2' }), RECORD);
  check('the decoy profile keeps its own copy under its prefix (scopedStoreKey)',
    [...decoy.map.keys()].join() === scopedStoreKey('shiba-wallet.handle-pending.v1', { id: 'decoy', keyPrefix: 'w2' }) &&
      [...decoy.map.keys()][0].startsWith('shiba-wallet.profile-w2.'));
  const tamper = (patch) => H.parsePendingHandle({ ...RECORD, ...patch });
  check('strict: an extra key, another chain, a regular owner that is not the signer, a zero secret, a changed commitment or secret are refused',
    H.parsePendingHandle({ ...RECORD, extra: 1 }) === null && tamper({ chain: 'eip155:1' }) === null && tamper({ owner: DEV_KERNEL }) === null &&
      tamper({ secret: '0x' + '00'.repeat(32) }) === null && tamper({ commitment: '0x' + '11'.repeat(32) }) === null &&
      tamper({ secret: '0x' + '5b'.repeat(32) }) === null && tamper({ label: 'other-label', name: 'other-label.eth' }) === null);
  check('…and the record itself is accepted', H.parsePendingHandle(RECORD) !== null && H.parsePendingHandle({ ...RECORD, recordTx: '0x' + 'ab'.repeat(32) }) !== null);
  const damaged = memoryStore();
  damaged.map.set('shiba-wallet.handle-pending.v1', '{"v":1,"pending":[{"v":1}]}');
  const d = await H.loadPendingHandles(damaged);
  check('a damaged document reads as damaged, and nothing is written over it', d.damaged === true && (await rejection(() => H.savePendingHandle(damaged, RECORD)))?.message === en['handle.store.damaged']);
  await H.resetPendingHandles(damaged);
  check('reset removes the key (the damaged store’s reset, and the wallet wipe)', !damaged.map.has('shiba-wallet.handle-pending.v1'));
  await H.forgetPendingHandle(store, DEV);
  check('forget deletes the record — and with it the secret', !(store.map.get('shiba-wallet.handle-pending.v1') ?? '').includes(RECORD.secret.slice(2)) && (await H.loadPendingHandles(store)).records.length === 0);
  const full = memoryStore();
  for (let i = 0; i < H.MAX_PENDING_HANDLES; i++) {
    const signer = ethers.getAddress('0x' + (i + 1).toString(16).padStart(40, '0'));
    const { record } = H.newHandlePlan({ quoted: { ...QUOTED, quote: { ...QUOTED.quote, owner: signer }, resolver: { ...QUOTED.resolver, address: predictVerifiableProxyAddress(signer, ensOwnedResolverSalt(signer)), salt: ensOwnedResolverSalt(signer) } }, signer, ownerKind: 'regular', createdAt: 1 });
    await H.savePendingHandle(full, record);
  }
  check(`at most ${H.MAX_PENDING_HANDLES} prepared registrations are kept`, (await rejection(() => H.savePendingHandle(full, RECORD)))?.message === en['handle.store.full'].replace('{max}', '8'));
}

// ---------------------------------------------------------------------------
console.log('check-handle: readiness from the LATEST BLOCK, one slot of margin');
// ---------------------------------------------------------------------------
const C = 1_700_000_000n; // a commitment time far from this computer's clock, on purpose
{
  const w = ensRegisterWindow(C);
  const r = (now) => H.handleRegisterReadiness(w, now);
  check('the margin is one Sepolia slot, 12 s (the smoke script’s READY_MARGIN_SECONDS)', H.HANDLE_READY_MARGIN_SECONDS === 12n);
  check('latest block exactly at notBefore (commit + 60): still waiting, 12 s left — the live run’s case',
    r(C + 60n).state === 'too-new' && r(C + 60n).secondsLeft === 12n && r(C + 60n).readyAt === C + 72n);
  check('notBefore + 11: waiting 1 s; notBefore + 12: ready', r(C + 71n).state === 'too-new' && r(C + 71n).secondsLeft === 1n && r(C + 72n).state === 'ready');
  check('expiry: ready until the next block could fall past commit + 86,400; then expired',
    r(C + 86_400n - 13n).state === 'ready' && r(C + 86_400n - 12n).state === 'expired' && r(C + 90_000n).state === 'expired');
  const record = RECORD;
  const node = fakeNode({ now: C + 60n, commitTime: C, allowance: FEE, code: { [DEV_RESOLVER.toLowerCase()]: '0x6001' }, nameState: { status: 0 } });
  const p = await H.readHandleProgress(node, record);
  check('readHandleProgress: committed, the latest block at commit + 60 → wait, ready from block time commit + 72', p.kind === 'wait' && p.readiness.readyAt === C + 72n && p.latest === C + 60n, JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  check('…it read the latest block on the node it was given', node.calls.includes('eth_getBlockByNumber'));
  check('the waiting sentence (exact): block times, about N s, until',
    H.waitingSentence(record.name, p.readiness) ===
      'Registration prepared: shibawallet-fixture.eth can be registered from block time 2023-11-14 22:14:32 UTC (about 12 s from now) until 2023-11-15 22:13:20 UTC.',
    H.waitingSentence(record.name, p.readiness));
  node.state.now = C + 72n;
  check('the latest block at commit + 72 → ready', (await H.readHandleProgress(node, record)).kind === 'ready');
  const m = await handleMutant('const readiness = handleRegisterReadiness(ensRegisterWindow(committedAt), latest.timestamp);',
    'const readiness = handleRegisterReadiness(ensRegisterWindow(committedAt), BigInt(Math.floor(Date.now() / 1000)));');
  node.state.now = C + 60n;
  caught('readiness from this phone’s clock (Date.now) instead of the latest block', (await m.readHandleProgress(node, record)).kind !== 'wait');
  const m0 = await handleMutant('export const HANDLE_READY_MARGIN_SECONDS = 12n;', 'export const HANDLE_READY_MARGIN_SECONDS = 0n;');
  caught('no margin (ready at exactly notBefore, the live run’s failure)', m0.handleRegisterReadiness(ensRegisterWindow(C), C + 60n).state === 'ready');
}

// ---------------------------------------------------------------------------
console.log('check-handle: the resume path, read from the chain');
// ---------------------------------------------------------------------------
{
  const base = { nameState: { status: 0 } };
  const at = async (over, record = RECORD) => H.readHandleProgress(fakeNode({ ...base, now: C + 100n, ...over }), record);
  let p = await at({});
  check('nothing on-chain yet → prepare, next call 0 (the resolver)', p.kind === 'prepare' && p.next === 0 && p.done === 0);
  p = await at({ code: { [DEV_RESOLVER.toLowerCase()]: '0x6001' } });
  check('resolver deployed → next call 1 (the approval)', p.kind === 'prepare' && p.next === 1 && p.done === 1);
  p = await at({ code: { [DEV_RESOLVER.toLowerCase()]: '0x6001' }, allowance: FEE });
  check('approval in place → next call 2 (the commit)', p.kind === 'prepare' && p.next === 2 && p.done === 2);
  p = await at({ code: { [DEV_RESOLVER.toLowerCase()]: '0x6001' }, allowance: FEE - 1n });
  check('an approval one unit short does not count', p.kind === 'prepare' && p.next === 1);
  p = await at({ code: { [DEV_RESOLVER.toLowerCase()]: '0x6001' }, allowance: FEE, commitTime: C });
  check('committed → the wait (or ready), decided from the latest block', p.kind === 'ready');
  const existing = { ...RECORD, deploysResolver: false };
  const ex = H.newHandlePlan({ quoted: { ...QUOTED, resolver: { ...QUOTED.resolver, deployed: true } }, signer: DEV, ownerKind: 'regular', createdAt: 1, random: fixedRandom }).record;
  check('a resolver that already existed: the record says setAddress', ex.deploysResolver === false && existing.deploysResolver === false);
  const hash = '0x' + 'cd'.repeat(32);
  p = await at({ allowance: 0n }, ex);
  check('…setAddress with no stored hash → next call 0', p.kind === 'prepare' && p.next === 0);
  p = await at({ receipts: { [hash]: { status: '0x1' } } }, { ...ex, recordTx: hash });
  check('…its stored hash mined successfully → next call 1', p.kind === 'prepare' && p.next === 1);
  p = await at({ receipts: { [hash]: { status: '0x0' } } }, { ...ex, recordTx: hash });
  check('…its stored hash reverted → call 0 again', p.kind === 'prepare' && p.next === 0);
  p = await at({ nameState: { status: 2, owner: DEV }, reverse: '' });
  check('registered to the owner, no reverse record → reverse', p.kind === 'reverse');
  p = await at({ nameState: { status: 2, owner: DEV }, reverse: 'shibawallet-fixture.eth' });
  check('registered to the owner and shown for it → done', p.kind === 'done');
  p = await at({ nameState: { status: 2, owner: DEV_KERNEL } });
  check('registered to someone else → taken', p.kind === 'taken');
  p = await at({ nameState: { status: 1 } });
  check('reserved → taken', p.kind === 'taken');
  p = await at({ code: { [DEV_RESOLVER.toLowerCase()]: '0x6001' }, allowance: FEE, commitTime: C, now: C + 86_400n });
  check('committed more than a day ago → expired', p.kind === 'expired');
  const smart = H.newHandlePlan({
    quoted: { ...QUOTED, quote: { ...QUOTED.quote, owner: DEV_KERNEL }, resolver: { address: predictVerifiableProxyAddress(DEV_KERNEL, ensOwnedResolverSalt(DEV_KERNEL)), salt: ensOwnedResolverSalt(DEV_KERNEL), deployed: false } },
    signer: DEV, ownerKind: 'smart', createdAt: 1, random: fixedRandom,
  }).record;
  check('a smart owner’s record: owner = the smart account, signer = the regular account', smart.owner === DEV_KERNEL && smart.signer === DEV && smart.ownerKind === 'smart');
  p = await at({ allowance: FEE }, smart);
  check('…its prepare step is one operation: not committed → prepare from call 0', p.kind === 'prepare' && p.next === 0);
  p = await at({ allowance: FEE, commitTime: C }, smart);
  check('…committed (the whole batch went through) → ready', p.kind === 'ready');
  const m = await handleMutant('approvalDone = (await readRegistrarAllowance(node, record.owner)) >= total;', 'approvalDone = true;');
  caught('the approval assumed instead of read', (await m.readHandleProgress(fakeNode({ ...base, now: C, code: { [DEV_RESOLVER.toLowerCase()]: '0x6001' } }), RECORD)).next !== 1);
}

// ---------------------------------------------------------------------------
console.log('check-handle: the register pre-flight BEFORE the prompt');
// ---------------------------------------------------------------------------
{
  const tooNew = ENS_REGISTER_ERROR_SELECTORS.commitmentTooNew + '0'.repeat(192);
  const tooOld = ENS_REGISTER_ERROR_SELECTORS.commitmentTooOld + '0'.repeat(192);
  const pf = async (revert) => H.preflightRegister(fakeNode({ registerRevert: revert }), RECORD);
  check('pre-flight ok / CommitmentTooNew → too-new / CommitmentTooOld → expired / NameNotAvailable → taken / other → failed',
    (await pf(null)).kind === 'ok' && (await pf(tooNew)).kind === 'too-new' && (await pf(tooOld)).kind === 'expired' &&
      (await pf(ENS_REGISTER_ERROR_SELECTORS.nameNotAvailable + '0'.repeat(64))).kind === 'taken' && (await pf('0xdeadbeef')).kind === 'failed');
  const preNode = fakeNode();
  await H.preflightRegister(preNode, RECORD);
  check('…it is an eth_call of exactly the plan’s register calldata', preNode.calls.includes(`eth_call ${SEL.register}`));
  // Through the app's simulationTransport, which keeps the JSON-RPC error's data.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: tooNew } }) });
  const viaHttp = await H.preflightRegister(simulationTransport('https://sepolia.example/rpc'), RECORD);
  globalThis.fetch = realFetch;
  check('…through simulationTransport a CommitmentTooNew revert (error.data) is recognised as a wait', viaHttp.kind === 'too-new');

  const run = async (progress, preflight) => {
    const order = [];
    const out = await H.gateRegister({
      name: 'x.eth',
      progress: async () => {
        order.push('progress');
        return progress;
      },
      preflight: async () => {
        order.push('preflight');
        return preflight;
      },
      authorize: async () => {
        order.push('prompt');
        return true;
      },
    });
    return { out, order: order.join('>') };
  };
  const wait = { kind: 'wait', readiness: { state: 'too-new', readyAt: 1n, secondsLeft: 1n, expiresAt: 2n }, latest: 0n };
  const ready = { kind: 'ready', expiresAt: 9n, latest: 1n };
  let r = await run(ready, { kind: 'ok' });
  check('ready + pre-flight ok: progress, then pre-flight, THEN the prompt', r.out.kind === 'authorized' && r.order === 'progress>preflight>prompt');
  r = await run(wait, { kind: 'ok' });
  check('the latest block says too new: a wait, no pre-flight, no prompt', r.out.kind === 'wait' && r.order === 'progress');
  r = await run(ready, { kind: 'too-new' });
  check('ready by the block but the pre-flight says CommitmentTooNew: a wait (re-read), never an error, no prompt', r.out.kind === 'wait' && r.order === 'progress>preflight');
  r = await run(ready, { kind: 'failed', reason: 'NotValid' });
  check('a failed pre-flight: stopped with the sentence, no prompt', r.out.kind === 'stopped' && r.out.text === 'The registrar would refuse Register (NotValid). Nothing was signed or sent.' && r.order === 'progress>preflight');
  r = await run({ kind: 'expired', expiresAt: 1n }, { kind: 'ok' });
  check('expired / taken: stopped, no prompt', r.out.kind === 'stopped' && r.order === 'progress' && (await run({ kind: 'taken' }, { kind: 'ok' })).out.kind === 'stopped');
  const m = await handleMutant(
    "  const pre = await deps.preflight();\n  if (pre.kind === 'too-new') return { kind: 'wait', progress };",
    "  if (!(await deps.authorize())) return { kind: 'not-authorized' };\n  const pre = await deps.preflight();\n  if (pre.kind === 'too-new') return { kind: 'wait', progress };",
  );
  const order = [];
  await m.gateRegister({ name: 'x', progress: async () => (order.push('p'), ready), preflight: async () => (order.push('f'), { kind: 'too-new' }), authorize: async () => (order.push('a'), true) });
  caught('the prompt before the pre-flight', order.join('') !== 'pf');
  const m2 = await handleMutant("if (kind === 'commitmentTooNew') return { kind: 'too-new' };", "if (kind === 'commitmentTooNew') return { kind: 'failed', reason: 'too new' };");
  caught('a CommitmentTooNew pre-flight treated as an error', (await m2.preflightRegister(fakeNode({ registerRevert: tooNew }), RECORD)).kind !== 'too-new');
}

// ---------------------------------------------------------------------------
console.log('check-handle: the secret never in a sentence, a source file or a log');
// ---------------------------------------------------------------------------
{
  const secretHex = RECORD.secret.slice(2).toLowerCase();
  const readiness = H.handleRegisterReadiness(ensRegisterWindow(C), C + 60n);
  const sentences = [
    H.waitingSentence(RECORD.name, readiness),
    ...H.handleCallLines(RECORD, 'prepare'),
    ...H.handleCallLines(RECORD, 'register'),
    ...['prepare', 'register', 'reverse', 'subname', 'targetReverse', 'revoke'].flatMap((k) => [H.handlePromptTitle(k, { name: RECORD.name }), H.handlePromptTitle(k, { name: RECORD.name, smart: true })]),
    H.describeHandleError(new Error(`boom ${RECORD.commitment}`)),
    ...['ok', 'none', 'offchain', 'unsupported'].map((s) => H.primaryNameLine({ status: s, name: 'a.eth', resolver: DEV }) ?? ''),
  ];
  check(`no sentence the screen shows carries the secret (${sentences.length} sentences)`, sentences.every((s) => !s.toLowerCase().includes(secretHex)));
  check('the call lines name every pinned contract in full (factory, USDC, registrar, reverse registrar)',
    H.handleCallLines(RECORD, 'prepare').join(' ').includes(ENS_V2_SEPOLIA.verifiableFactory) && H.handleCallLines(RECORD, 'prepare').join(' ').includes(ENS_V2_SEPOLIA.ethRegistrar) &&
      H.handleCallLines(RECORD, 'register').join(' ').includes(ENS_V2_SEPOLIA.v1ReverseRegistrar) && H.handleCallLines(RECORD, 'prepare')[1].includes('0.613701 USDC (613701 base units)'));
  const screen = source('src/screens/HandleScreen.tsx');
  const views = source('src/screens/HandleViews.tsx');
  check('the screen and its views never read `.secret` (nothing renders or passes it on)', !/\.secret\b/.test(screen) && !/\.secret\b/.test(views));
  check('no console call in handle.ts, the screen or its views', ![HANDLE_SOURCE, screen, views].some((s) => /\bconsole\./.test(s)));
  check('no string table entry has a {secret} placeholder', ![...Object.values(en), ...Object.values(es)].some((v) => /\{secret\}/.test(v)));
  const secretLines = HANDLE_SOURCE.split('\n').filter((l) => /\.secret\b/.test(l)).map((l) => l.trim());
  const allowedSecretLines = [
    "if (typeof r.secret !== 'string' || !HASH.test(r.secret) || /^0x0{64}$/.test(r.secret)) return null;",
    'secret: plan.secret,',
    'const secret = toBytes(record.secret);',
  ];
  check('handle.ts reads the secret only in the strict parse, when building the record and when rebuilding the plan — never in a sentence',
    secretLines.length === 3 && secretLines.every((l) => allowedSecretLines.includes(l)) && !/\bt\('[^']*',[^)]*secret/i.test(HANDLE_SOURCE), secretLines.join(' | '));
}

// ---------------------------------------------------------------------------
console.log('check-handle: the record-only sub-name (the live shape smart.shibawalletdemo.eth)');
// ---------------------------------------------------------------------------
{
  const node = fakeNode({ nameState: { status: 2, owner: DEV }, resolverDeployed: true, code: { [DEV_RESOLVER.toLowerCase()]: '0x6001' } });
  const plan = await H.planHandleSubname(node, { parentLabel: 'shibawalletdemo', subLabel: 'smart', owner: DEV, target: DEV_KERNEL });
  const engine = planEnsSubname({
    parentLabel: 'shibawalletdemo', subLabel: 'smart', owner: DEV, target: DEV_KERNEL,
    resolver: { address: DEV_RESOLVER, salt: ensOwnedResolverSalt(DEV), deployed: true }, mode: 'record-only', targetReverse: true,
  });
  const setAddr = new ethers.Interface(['function setAddress(bytes name, uint256 coinType, bytes addressBytes)']).encodeFunctionData('setAddress', [
    ethers.dnsEncode('smart.shibawalletdemo.eth', 255), 60n, DEV_KERNEL.toLowerCase(),
  ]);
  check('one call: setAddress(smart.shibawalletdemo.eth, 60, the Kernel) on the owner’s resolver 0x599A…6059 — the live run’s shape, equal to ethers',
    plan.mode === 'record-only' && plan.name === 'smart.shibawalletdemo.eth' && plan.step.calls.length === 1 && same(plan.step.calls[0].to, DEV_RESOLVER) &&
      toHex(plan.step.calls[0].data) === setAddr && plan.userRegistry === null);
  check('…equal to the engine’s planEnsSubname, with the target’s own setName planned (sent only by the smart account)',
    toHex(plan.step.calls[0].data) === toHex(engine.step.calls[0].data) && same(plan.targetReverseCall.to, ENS_V2_SEPOLIA.v1ReverseRegistrar) &&
      toHex(plan.targetReverseCall.data) === new ethers.Interface(['function setName(string)']).encodeFunctionData('setName', ['smart.shibawalletdemo.eth']));
  const notOwned = await rejection(() => H.planHandleSubname(fakeNode({ nameState: { status: 2, owner: DEV_KERNEL } }), { parentLabel: 'shibawalletdemo', subLabel: 'smart', owner: DEV, target: DEV_KERNEL }));
  check('a parent this account does not own: refused', notOwned instanceof H.HandleRefusal && notOwned.message === 'shibawalletdemo.eth is not registered to this account, so no sub-name can be added under it.');
}

// ---------------------------------------------------------------------------
console.log('check-handle: the primary name on Home and Receive');
// ---------------------------------------------------------------------------
{
  check('the line: "ENS name: …", the off-chain and unsupported notes, nothing for none',
    H.primaryNameLine({ status: 'ok', name: 'shibawalletdemo.eth', resolver: DEV }) === 'ENS name: shibawalletdemo.eth' &&
      H.primaryNameLine({ status: 'offchain' }) === en['handle.primary.offchain'] && H.primaryNameLine({ status: 'unsupported', name: 'x' }) === en['handle.primary.unsupported'] &&
      H.primaryNameLine({ status: 'none' }) === null && H.primaryNameLine(null) === null);
  check('read on mainnet and Ethereum Sepolia only', H.primaryNameChainId('eip155:1') === 1n && H.primaryNameChainId('eip155:11155111') === 11155111n && H.primaryNameChainId('eip155:84532') === null);
  let reads = 0;
  let fail = false;
  const cache = H.createPrimaryNameCache(async () => {
    reads += 1;
    if (fail) throw new Error('down');
    return { status: 'ok', name: 'a.eth', resolver: DEV };
  });
  let notified = 0;
  cache.subscribe(() => (notified += 1));
  await cache.refresh('eip155:11155111', DEV);
  fail = true;
  await cache.refresh('eip155:11155111', DEV.toLowerCase());
  check('a failed re-read keeps the previous answer; addresses are matched in any case', cache.get('eip155:11155111', DEV)?.name === 'a.eth' && reads === 2 && notified === 1);
  await cache.refresh('eip155:84532', DEV);
  check('no read at all on a network without names', reads === 2);
  cache.forget('eip155:11155111', DEV);
  check('forget clears it (after a registration the next focus reads again)', cache.get('eip155:11155111', DEV) === null);
  // readEnsPrimaryName against the fake node, through the cache's own reader shape
  const node = fakeNode({ reverse: 'shibawalletdemo.eth' });
  const { readEnsPrimaryName } = await import('@shiba-wallet/chains-evm');
  check('the engine’s reverse read decodes the fake answer (the shape the Universal Resolver returns)', (await readEnsPrimaryName(node, DEV, 11155111n)).name === 'shibawalletdemo.eth');
}

// ---------------------------------------------------------------------------
console.log('check-handle: waiting for a transaction');
// ---------------------------------------------------------------------------
{
  const h = '0x' + 'ee'.repeat(32);
  const sleep = async () => undefined;
  check('mined → success; reverted → reverted; never → timeout',
    (await H.waitForTx(fakeNode({ receipts: { [h]: { status: '0x1' } } }), h, { sleep })) === 'success' &&
      (await H.waitForTx(fakeNode({ receipts: { [h]: { status: '0x0' } } }), h, { sleep })) === 'reverted' &&
      (await H.waitForTx(fakeNode(), h, { sleep, timeoutMs: 8_000, pollMs: 4_000 })) === 'timeout');
}

// ---------------------------------------------------------------------------
console.log('check-handle: strings (English in en.ts, a Spanish line for each)');
// ---------------------------------------------------------------------------
{
  const ids = [...new Set([...HANDLE_SOURCE.matchAll(/\bt\('([a-zA-Z0-9.-]+)'/g), ...source('src/screens/HandleScreen.tsx').matchAll(/\bt\('([a-zA-Z0-9.-]+)'/g)].map((m) => m[1]))];
  const missing = ids.filter((id) => !(id in en) || !(id in es));
  check(`every t('…') id in handle.ts and the screen is in en.ts and es.ts (${ids.length} ids)`, ids.length >= 80 && missing.length === 0, missing.join(', '));
  check('the intro’s redeploy sentence (exact, from WALLET_HANDLES.md section 1)',
    en['handle.intro.redeploy'] === 'ENS has redeployed its Sepolia test contracts before: a name registered today may not survive a future redeploy by ENS, and nothing this wallet can do prevents that.');
  check('the intro states test networks only, public, rented for the 28-day minimum, paid in USDC',
    /only on Ethereum Sepolia, a test network/.test(en['handle.intro']) && /public on-chain/.test(en['handle.intro.public']) &&
      /\{days\} days, the shortest term the registrar allows/.test(en['handle.intro.term']) && /paid in USDC/.test(en['handle.intro.fee']));
  check('the readiness row’s title and reason are in both tables, the English equal to the row',
    en['readiness.wallet-handle.title'] === featureReadiness('wallet-handle').title && en['readiness.wallet-handle.reason'] === featureReadiness('wallet-handle').reason &&
      typeof es['readiness.wallet-handle.reason'] === 'string');
}

// ---------------------------------------------------------------------------
console.log('check-handle: source pins (screen, Home, Receive, route)');
// ---------------------------------------------------------------------------
{
  const screen = source('src/screens/HandleScreen.tsx');
  const authorize = screen.slice(screen.indexOf('const authorizeJob = async'), screen.indexOf('const onEoaApprove = async'));
  check('the register path goes through gateRegister (progress → pre-flight → spending limits and the prompt)',
    /gateRegister\(\{[\s\S]*progress: \(\) => readHandleProgress\(node, rec\)[\s\S]*preflight: \(\) => preflightRegister\(node, rec\)[\s\S]*authorize: spendingAndPrompt/.test(authorize) &&
      (screen.match(/requireLocalAuth\(/g) ?? []).length === 1 && authorize.includes('requireLocalAuth(j.title)'));
  const prepare = screen.slice(screen.indexOf('const onPrepare = async'), screen.indexOf('const onRegisterOrContinue = async'));
  check('Prepare stores the record (with the secret) BEFORE anything is quoted or sent',
    prepare.indexOf('savePendingHandle(AsyncStorage, rec)') > 0 && prepare.indexOf('savePendingHandle(AsyncStorage, rec)') < prepare.indexOf('openJob('));
  check('the wait polls the latest block every half slot while the card shows it', screen.includes("current?.value?.kind !== 'wait'") && screen.includes('setTimeout(() => setPollTick((n) => n + 1), HANDLE_WAIT_POLL_MS)'));
  check('a regular account sends one call per transaction through prepareEvmSend / sendEvm; a smart account one operation through prepareAaCalls / sendAa',
    screen.includes('prepareEvmSend(start.url, address, call.to, call.value, call.data, caip2)') && screen.includes('sendEvm(sendUrl, signer, eoaQuote') &&
      screen.includes('prepareAaCalls(bundle, address, next.calls') && screen.includes("sendAa(bundle, signer, aaQuote, { kind: 'other' })"));
  check('a setAddress hash is stored with the record at once (the resume path)', screen.includes('{ ...job.record, recordTx: sent.txid }'));
  check('reads keep revert data (simulationTransport), never the bare httpTransport', screen.includes('simulationTransport(url)') && !/httpTransport/.test(screen));
  check('the screen stores through the seam’s AsyncStorage re-export only (no direct storage import)', !/@react-native-async-storage|expo-secure-store/.test(screen + source('src/wallet/handle.ts')));
  const home = source('src/screens/HomeScreen.tsx');
  check('Home: the link "Wallet handle (ENS)" behind handleLinkShown, and the name line under the EVM address',
    home.includes("handleLinkShown(evmChain.caip2, activeAccount ?? null)") && home.includes("cardLink('handle', 'Wallet handle (ENS)', () => navigation.navigate('Handle')") &&
      home.includes('usePrimaryNameLine(evmAccount?.address ?? null, evmChain.caip2)') && home.includes('{isEvm && evmNameLine ? ('));
  check('Receive: the name line under the address', source('src/screens/ReceiveScreen.tsx').includes('{evmNameLine ? <Text style={[styles.path, { color: theme.textMuted }]}>{evmNameLine}</Text> : null}'));
  check('route Handle registered (navigation.ts, App.tsx)', source('src/navigation.ts').includes('  Handle: undefined;') && source('App.tsx').includes('<Stack.Screen name="Handle" component={HandleScreen}'));
}

// ---------------------------------------------------------------------------
console.log('check-handle: more mutants');
// ---------------------------------------------------------------------------
{
  const m1 = await handleMutant("  if (caip2 !== HANDLE_CHAIN) {", '  if (false) {');
  caught('the network check removed (Base Sepolia offered)', m1.handleOfferFor('eip155:84532').ok === true);
  const m2 = await handleMutant("if (!configured || accountType !== 'kernel-v3.3')", 'if (!configured)');
  caught('an EIP-7702 owner accepted as the smart owner', m2.smartOwnerRefusal('kernel-7702', true) === null);
  const m3 = await handleMutant('    if (planFromPending(record).commitment.toLowerCase() !== record.commitment.toLowerCase()) return null;', '');
  caught('the stored commitment trusted without rebuilding it', m3.parsePendingHandle({ ...RECORD, commitment: '0x' + '11'.repeat(32) }) !== null);
  const m4 = await handleMutant('encodeErc20Approve(ENS_V2_SEPOLIA.ethRegistrar, 0n)', 'encodeErc20Approve(ENS_V2_SEPOLIA.ethRegistrar, 1n)');
  const d = new ethers.Interface(['function approve(address,uint256)']).decodeFunctionData('approve', toHex(m4.revokeRegistrarApprovalCall().data));
  caught('a revoke that is not exactly zero', d[1] !== 0n);
  const m5 = await handleMutant('  if (usdcBalance < quote.total) {', '  if (false) {');
  caught('the USDC check removed', (await rejection(() => m5.quoteHandle(fakeNode({ usdc: 1n }), { label: LABEL, owner: DEV, ownerLabel: 'x' }))) === null);
  const m6 = await handleMutant('  await writeAll(store, current.records.filter((r) => !sameAddress(r.signer, signer)));', '  await writeAll(store, current.records);');
  const kept = memoryStore();
  await m6.savePendingHandle(kept, RECORD);
  await m6.forgetPendingHandle(kept, DEV);
  caught('Forget that keeps the record (and its secret)', (kept.map.get('shiba-wallet.handle-pending.v1') ?? '').includes(RECORD.secret.slice(2)));
}

console.log(`\ncheck-handle: ${passed} passed, ${failed} failed (${mutantsCaught} mutants)`);
process.exit(failed === 0 ? 0 : 1);

// Cold signing for a SMART ACCOUNT, the app half (phase 23 item 5), fully
// OFFLINE. It loads the exact app modules under Node's type stripping, runs
// the real engine (SmartAccountClient, the Kernel v3.3 spec, cold-userop.ts)
// against fake node and bundler transports, and checks:
//
//  - the cold-owner client (wallet/aa.ts createColdOwnerAaClient /
//    coldOwnerAaRefusal): refused before ANY request on a main network
//    (readiness 'cold-aa'), for an EIP-7702 owner, a recovered account, a
//    SimpleAccount configuration, unpinned Kernel addresses and incomplete
//    settings; never a paymaster although one is saved; CREATE2 index 0;
//  - assertColdAaBundle: 7702, multisig, passkey, sponsored, recovered and
//    other-index bundles refused before any request;
//  - the quote and the request: the request built by wallet/cold-aa.ts
//    equals the one the engine builds directly for the same quote; the
//    deploying request binds accountIndex 0; a deployed account's ECDSA root
//    is checked first; a quote yields one request (used once); a fee floor
//    above the quote, or a grown estimate, refuses before anything exists;
//  - the QR parts: "SW-CU:" only, never "SW-CS:", any order, the refusals;
//  - the signature: verified against the STORED request (a pasted part,
//    another key, another request, the request itself, an expired request);
//  - the submission: through the engine's submitColdUserOpRequest, the
//    bundler-floor check then signedFeeGuard before eth_sendUserOperation;
//    a floor move after signing refuses with the Send screen's title and
//    "the signature cannot be reused"; the 'cold-aa' operation event and the
//    pending card's title;
//  - ZERO signing: the whole flow beside a key vault over a counting
//    secure-store backend reads nothing; source pins on the module, the
//    screen and its views; the import closure reaches no key storage;
//  - the screen wiring (source), the exact strings, the readiness row;
//  - mutation checks: deliberately broken copies must fail.
//
// Every key is disposable: the public BIP-39 test mnemonic ("abandon ...
// about"). Nothing touches the network.
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-cold-aa.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { evmKeyProvider, mnemonicToSeed } from '@shiba-wallet/core';
import {
  COLD_USEROP_EXPIRED,
  COLD_USEROP_IS_THE_REQUEST,
  COLD_USEROP_OTHER_REQUEST,
  ENTRYPOINT_V07,
  KERNEL_V3_3,
  KERNEL_V3_3_ECDSA_ROOT_SCHEME,
  buildColdUserOpRequest,
  buildColdUserOpSignature,
  coldUserOpFromFields,
  coldUserOpWrongSigner,
  parseColdUserOpRequest,
  predictKernelAddress,
  requiredPrefund,
  serializeColdUserOpRequest,
  toBytes,
} from '@shiba-wallet/chains-evm';
import * as aa from '../src/wallet/aa.ts';
import * as ca from '../src/wallet/cold-aa.ts';
import * as cs from '../src/wallet/cold-signing.ts';
import * as pending from '../src/wallet/pending-transactions.ts';
import { FEATURE_READINESS, featureReadiness, isFeatureAllowed, readinessRefusal } from '../src/config/readiness.ts';
import { createKeyVault } from '../src/wallet/storage.ts';
import { formatUnits } from '../src/wallet/balances.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolvePath(HERE, '..');
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

// Mutants: a broken copy of an app module, loaded from a scratch directory
// with its relative imports rewritten to the real files. Removed on exit.
const MUTANT_DIR = join(HERE, `.mutants-cold-aa-${process.pid}`);
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
// Keys, configuration and fake transports
// ---------------------------------------------------------------------------

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(TEST_MNEMONIC);
const ownerKey = evmKeyProvider.deriveAccount(seed, 0, 8); // the off-line signer's key (index 8, as the emulator pass)
const strangerKey = evmKeyProvider.deriveAccount(seed, 0, 9);
seed.fill(0);
const OWNER = ownerKey.address;
const SENDER = predictKernelAddress(OWNER, { index: 0n });
const TO = ethers.getAddress('0x2222222222222222222222222222222222222222');
const USDC = ethers.getAddress('0x1c7d4b196cb0c7b01d743fbc6116a902379c7238');
const SEPOLIA = 'eip155:11155111';
const NODE_URL = 'https://node.example/sepolia';
const BUNDLER_URL = 'https://bundler.example/sepolia';
const NOW = 1_800_000_000;
const NO_WAIT = { attempts: 1, delayMs: 0 };
const RID = (n) => '0x' + n.toString(16).padStart(32, '0');
const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const sel = (sig) => ethers.id(sig).slice(0, 10);
const GET_NONCE = sel('getNonce(address,uint192)');
const BALANCE_OF = sel('balanceOf(address)');
const GET_ADDRESS = sel('getAddress(bytes,bytes32)');
const ROOT_VALIDATOR = sel('rootValidator()');
const ECDSA_STORAGE = sel('ecdsaValidatorStorage(address)');

function config(over = {}) {
  return {
    bundlerUrl: BUNDLER_URL,
    bundlerVerifiedAt: '2026-10-25T00:00:00.000Z',
    bundlerChainIdVerified: '11155111',
    accountType: 'kernel-v3.3',
    factory: KERNEL_V3_3.factory,
    factoryImplementation: KERNEL_V3_3.implementation,
    kernelMetaFactory: KERNEL_V3_3.metaFactory,
    kernelValidator: KERNEL_V3_3.ecdsaValidator,
    kernelAccountId: KERNEL_V3_3.accountId,
    factoryVerifiedAt: '2026-10-25T00:00:00.000Z',
    paymasterUrl: null,
    paymasterContext: null,
    paymasterVerifiedAt: null,
    bundlerUrlIgnoredReason: null,
    paymasterUrlIgnoredReason: null,
    eip7702Owners: [],
    recoveredAccounts: [],
    chain: SEPOLIA,
    ...over,
  };
}

/**
 * One fake world: the node answers the Kernel v3.3 spec, the EntryPoint and
 * the readers the quote uses; the bundler answers a fee floor, an estimate
 * and eth_sendUserOperation. `state` can be changed between steps.
 */
function world(over = {}) {
  const state = {
    deployed: false,
    nonce: 0n,
    balance: 10n ** 16n,
    deposit: 0n,
    tokenBalance: 5_000_000n,
    rootOwner: OWNER,
    rootValidatorId: '0x01' + KERNEL_V3_3.ecdsaValidator.slice(2).toLowerCase(),
    rootReadFails: false,
    floor: { slowPriority: 1_000_000n, priority: 1_000_000n, maxFee: 2_000_000n },
    estimate: { callGasLimit: 0xc350n, verificationGasLimit: 0x61a80n, preVerificationGas: 0xd6d8n },
    sends: [],
    ...over,
  };
  const calls = { node: [], bundler: [] };
  const node = async (method, params) => {
    calls.node.push(method);
    switch (method) {
      case 'eth_chainId':
        return '0xaa36a7';
      case 'eth_getCode':
        return params[0].toLowerCase() === SENDER.toLowerCase() && state.deployed ? '0x6001' : '0x';
      case 'eth_getBalance':
        return '0x' + state.balance.toString(16);
      case 'eth_getBlockByNumber':
        return { number: '0x10', baseFeePerGas: '0xe' };
      case 'eth_maxPriorityFeePerGas':
        return '0xf4240';
      case 'eth_call': {
        const { to, data } = params[0];
        if (to.toLowerCase() === ENTRYPOINT_V07.toLowerCase() && data.startsWith(GET_NONCE)) return word(state.nonce);
        if (to.toLowerCase() === ENTRYPOINT_V07.toLowerCase() && data.startsWith(BALANCE_OF)) return word(state.deposit);
        if (to.toLowerCase() === KERNEL_V3_3.factory.toLowerCase() && data.startsWith(GET_ADDRESS)) return word(BigInt(SENDER));
        if (to.toLowerCase() === USDC.toLowerCase() && data.startsWith(BALANCE_OF)) return word(state.tokenBalance);
        if (to.toLowerCase() === SENDER.toLowerCase() && data.startsWith(ROOT_VALIDATOR)) {
          if (state.rootReadFails) throw new Error('RPC error -32000: execution reverted (eth_call)');
          return state.rootValidatorId.padEnd(66, '0');
        }
        if (to.toLowerCase() === KERNEL_V3_3.ecdsaValidator.toLowerCase() && data.startsWith(ECDSA_STORAGE)) return word(BigInt(state.rootOwner));
        throw new Error(`unexpected eth_call ${to} ${data.slice(0, 10)}`);
      }
      default:
        throw new Error(`unexpected node method ${method}`);
    }
  };
  const bundler = async (method, params) => {
    calls.bundler.push(method);
    switch (method) {
      case 'rundler_maxPriorityFeePerGas':
        throw new Error('RPC error -32601: Method not found');
      case 'pimlico_getUserOperationGasPrice': {
        const f = state.floor;
        const tier = (p, m) => ({ maxPriorityFeePerGas: '0x' + p.toString(16), maxFeePerGas: '0x' + m.toString(16) });
        return { slow: tier(f.slowPriority, f.maxFee), standard: tier(f.priority, f.maxFee), fast: tier(f.priority, f.maxFee) };
      }
      case 'eth_estimateUserOperationGas':
        return {
          callGasLimit: '0x' + state.estimate.callGasLimit.toString(16),
          verificationGasLimit: '0x' + state.estimate.verificationGasLimit.toString(16),
          preVerificationGas: '0x' + state.estimate.preVerificationGas.toString(16),
        };
      case 'eth_sendUserOperation':
        state.sends.push(params[0]);
        return '0x' + 'ab'.repeat(32);
      case 'eth_getUserOperationReceipt':
        return null;
      default:
        throw new Error(`unexpected bundler method ${method}`);
    }
  };
  const transportFor = (url) => (url === BUNDLER_URL ? bundler : node);
  return { state, calls, node, bundler, transportFor };
}

function bundleFor(w, cfg = config()) {
  return aa.createColdOwnerAaClient(cfg, {
    nodeUrl: NODE_URL,
    chainId: 11155111n,
    ownerAddress: OWNER,
    transportFor: w.transportFor,
    estimateRetries: NO_WAIT,
  });
}

/** The off-line signer: signs the request's digest with `key`, as cold-signer.mjs sign-userop does. */
function signAs(key, request) {
  const sig = key.sign(toBytes(request.signingDigest));
  return buildColdUserOpSignature(request, key.address, { yParity: sig[64], r: sig.slice(0, 32), s: sig.slice(32, 64) });
}

const NATIVE = { kind: 'native', to: TO, amount: 10n ** 14n };

async function quoted(w, target = NATIVE) {
  const bundle = bundleFor(w);
  return { bundle, quote: await ca.quoteColdAa(bundle, OWNER, target) };
}

// ===========================================================================
console.log('check-cold-aa: the cold-owner client (wallet/aa.ts)');
// ===========================================================================
{
  const w = world();
  check('the watched owner\'s account is Kernel v3.3 at CREATE2 index 0 (COLD_AA_ACCOUNT_INDEX)',
    aa.COLD_AA_ACCOUNT_INDEX === 0 && ca.coldAaAccountAddress(OWNER) === predictKernelAddress(OWNER, { index: 0n }));
  check('a pinned Sepolia Kernel configuration is offered (coldOwnerAaRefusal null)', aa.coldOwnerAaRefusal(config(), OWNER) === null);
  const b = bundleFor(w, config({ paymasterUrl: 'https://paymaster.example/rpc', paymasterContext: null }));
  check('a saved paymaster is NOT used: the bundle is self-paid, Kernel v3.3, index 0, and no request was made',
    b.sponsored === false && b.accountType === 'kernel-v3.3' && b.accountIndex === 0 && w.calls.node.length + w.calls.bundler.length === 0);
  const refusals = [
    ['a main network (the readiness refusal of cold-aa)', config({ chain: 'eip155:1' }), readinessRefusal('cold-aa'), 1n],
    ['an EIP-7702 owner', config({ eip7702Owners: [OWNER] }), aa.COLD_AA_7702_REFUSAL],
    ['a recovered account attached', config({ recoveredAccounts: [{ owner: OWNER, account: TO }] }), aa.COLD_AA_RECOVERED_REFUSAL],
    ['a SimpleAccount configuration', config({ accountType: 'simple', kernelValidator: null }), aa.COLD_AA_NOT_KERNEL_REFUSAL],
    ['another factory', config({ factory: TO }), aa.COLD_AA_UNPINNED_KERNEL_REFUSAL],
    ['another ECDSA validator', config({ kernelValidator: TO }), aa.COLD_AA_UNPINNED_KERNEL_REFUSAL],
    ['no bundler', config({ bundlerUrl: null }), aa.COLD_AA_SETTINGS_INCOMPLETE],
  ];
  for (const [what, cfg, sentence, chainId] of refusals) {
    const counted = world();
    const e = thrown(() =>
      aa.createColdOwnerAaClient(cfg, {
        nodeUrl: NODE_URL,
        chainId: chainId ?? 11155111n,
        ownerAddress: OWNER,
        transportFor: counted.transportFor,
      }),
    );
    check(`refused before any request: ${what}`, e?.message === sentence && counted.calls.node.length + counted.calls.bundler.length === 0, e?.message);
  }
  check('…and the pure refusal says the same for the 7702 owner', aa.coldOwnerAaRefusal(config({ eip7702Owners: [OWNER] }), OWNER) === aa.COLD_AA_7702_REFUSAL);
  check('a configuration for another chain is refused', /not eip155:11155111/.test(thrown(() => aa.createColdOwnerAaClient(config({ chain: 'eip155:84532' }), { nodeUrl: NODE_URL, chainId: 11155111n, ownerAddress: OWNER }))?.message ?? ''));
}

// ===========================================================================
console.log('check-cold-aa: only the plain cold-owner bundle (assertColdAaBundle)');
// ===========================================================================
{
  const w = world();
  const base = bundleFor(w);
  const sevenSevenOhTwo = aa.createAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, factory: KERNEL_V3_3.implementation, chainId: 11155111n, accountType: 'kernel-7702', transportFor: w.transportFor });
  const sponsored = aa.createAaClient({ nodeUrl: NODE_URL, bundlerUrl: BUNDLER_URL, factory: KERNEL_V3_3.factory, chainId: 11155111n, accountType: 'kernel-v3.3', paymaster: { url: 'https://paymaster.example/rpc', contextJson: null }, transportFor: w.transportFor });
  const cases = [
    ['an EIP-7702 bundle', sevenSevenOhTwo],
    ['a multisig bundle', { ...base, multisig: { account: TO, config: {}, index: 0n, submitter: OWNER } }],
    ['a passkey bundle', { ...base, passkey: { account: SENDER } }],
    ['a sponsored bundle (a paymaster)', sponsored],
    ['a recovered bundle', { ...base, recovered: { account: TO } }],
    ['another account index (a phrase account\'s salt)', { ...base, accountIndex: 3 }],
  ];
  for (const [what, bundle] of cases) {
    const before = w.calls.node.length + w.calls.bundler.length;
    const e = await rejection(() => ca.quoteColdAa(bundle, OWNER, NATIVE));
    check(`refused before any request: ${what}`, e?.message === ca.COLD_AA_BUNDLE_REFUSAL && w.calls.node.length + w.calls.bundler.length === before, e?.message);
  }
}

// ===========================================================================
console.log('check-cold-aa: the quote and the request');
// ===========================================================================
let deployingRequest;
{
  const w = world();
  const { bundle, quote } = await quoted(w);
  check('the quote is the Send screen\'s smart-account quote: self-paid, not deployed, the predicted sender, fee = gas × max fee',
    quote.kind === 'aa' && !quote.sponsored && quote.deployed === false && quote.sender === SENDER &&
      quote.fee === (quote.callGasLimit + quote.verificationGasLimit + quote.preVerificationGas) * quote.maxFeePerGas);
  check('…priced at the bundler floor + 100% (the Send screen\'s headroom)', quote.maxPriorityFeePerGas === 2_000_000n && quote.maxFeePerGas >= 4_000_000n, `${quote.maxPriorityFeePerGas} / ${quote.maxFeePerGas}`);
  const sendsBefore = w.state.sends.length;
  const request = await ca.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH', requestId: RID(1) });
  deployingRequest = request;
  // The engine, directly, for the same quote (a fresh client on the same world).
  const fees = { maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas };
  const engineBundle = bundleFor(w);
  const prepared = await engineBundle.client.prepareUserOperationForExternalSigner(OWNER, quote.calls, fees, { scheme: KERNEL_V3_3_ECDSA_ROOT_SCHEME });
  const direct = buildColdUserOpRequest(prepared, {
    summary: ca.coldAaSummary({ quote, owner: OWNER, worstCaseFee: requiredPrefund(prepared.userOp), nativeSymbol: 'test ETH' }),
    accountIndex: 0n,
    nowSeconds: NOW,
    requestId: RID(1),
  });
  check('the request equals the one the engine builds directly for the same quote (byte for byte)', serializeColdUserOpRequest(request) === serializeColdUserOpRequest(direct));
  check('…it deploys the account: accountIndex "0", the meta factory, sender = the CREATE2 prediction, nonce key 0',
    request.accountIndex === '0' && request.userOp.factory === KERNEL_V3_3.metaFactory && request.sender === SENDER && request.nonceKey === '0' && request.owner === OWNER);
  check('…no paymaster, the quoted fees exactly, lifetime 30 minutes', request.userOp.paymaster === null && request.userOp.maxFeePerGas === String(quote.maxFeePerGas) &&
    request.userOp.maxPriorityFeePerGas === String(quote.maxPriorityFeePerGas) && Number(request.expiresAt) - Number(request.createdAt) === 30 * 60);
  check('…the signed worst case is at most the reviewed fee', requiredPrefund(prepared.userOp) <= quote.fee);
  check('…it survives the signer\'s strict parser', serializeColdUserOpRequest(parseColdUserOpRequest(serializeColdUserOpRequest(request))) === serializeColdUserOpRequest(request));
  check('…and nothing was sent to the bundler', w.state.sends.length === sendsBefore);
  check('the summary (exact)', request.summary ===
    `Smart-account operation from ${SENDER} (owner ${OWNER}): send 0.0001 test ETH to ${TO}; this operation also deploys the smart account. ` +
      `Network fee at most ${formatUnits(requiredPrefund(prepared.userOp), 18, 18)} test ETH, paid by the smart account.`, request.summary);
  const again = await rejection(() => ca.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH' }));
  check('a quote yields ONE request: the second is refused as already used (aa.ts claimQuoteForSubmission)', again?.message === aa.AA_QUOTE_ALREADY_USED);
  check('the expiry line (exact; 30 minutes after 1,800,000,000)', ca.coldAaExpiryLine(request) === 'Expires at 08:30 UTC. After that the signature is refused and a new request must be prepared.', ca.coldAaExpiryLine(request));
  check('coldAaRequestExpired: false at the expiry second, true one second later', !ca.coldAaRequestExpired(request, NOW + 1800) && ca.coldAaRequestExpired(request, NOW + 1801));

  // A token send.
  const wt = world();
  const tq = await quoted(wt, { kind: 'erc20', token: { contract: USDC, recipient: TO, symbol: 'USDC', decimals: 6, chainCaip2: SEPOLIA, amount: 1_500_000n } });
  const treq = await ca.prepareColdAaRequest({ bundle: tq.bundle, owner: OWNER, quote: tq.quote, nowSeconds: NOW, nativeSymbol: 'test ETH', requestId: RID(2) });
  check('a USDC send: one transfer call, the summary names the token and its contract', tq.quote.token?.symbol === 'USDC' && tq.quote.calls.length === 1 &&
    treq.summary.includes(`send 1.5 USDC (token contract ${USDC}) to ${TO}`));
}
{
  // A deployed account: accountIndex null; the ECDSA root is checked before the bundler.
  const w = world({ deployed: true, nonce: 3n });
  const { bundle, quote } = await quoted(w);
  const request = await ca.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH' });
  check('a deployed account (dev index 8\'s on the emulator): no factory, accountIndex null, "Already deployed", nonce 3',
    quote.deployed === true && request.accountIndex === null && request.userOp.factory === null && request.userOp.nonce === '3');
  check('…and its summary does not say it deploys', !request.summary.includes('deploys'));
  for (const [what, over, sentence] of [
    ['another ECDSA owner', { rootOwner: TO }, ca.coldAaRootChanged(SENDER, OWNER)],
    ['another root validator', { rootValidatorId: '0x01' + '11'.repeat(20) }, ca.coldAaRootChanged(SENDER, OWNER)],
    ['an unreadable root', { rootReadFails: true }, ca.COLD_AA_ROOT_UNREADABLE],
  ]) {
    const wr = world({ deployed: true, ...over });
    const e = await rejection(() => quoted(wr));
    check(`a deployed account with ${what} is refused before any bundler request`, e?.message === sentence && wr.calls.bundler.length === 0, e?.message);
  }
}
{
  // The fee checks before the request exists.
  const w = world();
  const { bundle, quote } = await quoted(w);
  w.state.floor = { slowPriority: 9_000_000n, priority: 9_000_000n, maxFee: 20_000_000n };
  const estimatesBefore = w.calls.bundler.filter((m) => m === 'eth_estimateUserOperationGas').length;
  const e = await rejection(() => ca.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH' }));
  const d = ca.describeColdAaError(e, 'prepare', { deployed: false });
  check('a bundler floor above the quote: AaFeeRoseError("floor") before the engine prepares anything', e instanceof aa.AaFeeRoseError && e.reason === 'floor' &&
    w.calls.bundler.filter((m) => m === 'eth_estimateUserOperationGas').length === estimatesBefore);
  check('…shown with the Send screen\'s title and back to the form', d.title === aa.AA_FEE_ROSE_TITLE && d.back === true && d.detail.endsWith(aa.AA_FEE_ROSE_NEXT_STEP));
  w.state.floor = { slowPriority: 1_000_000n, priority: 1_000_000n, maxFee: 2_000_000n };
  const again = await rejection(() => ca.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH' }));
  check('…the refused quote was not claimed (a floor refusal leaves it usable, as checkAaQuoteBeforeApproval does)', again === null);

  const w2 = world();
  const q2 = await quoted(w2);
  w2.state.estimate = { ...w2.state.estimate, verificationGasLimit: w2.state.estimate.verificationGasLimit * 2n };
  const e2 = await rejection(() => ca.prepareColdAaRequest({ bundle: q2.bundle, owner: OWNER, quote: q2.quote, nowSeconds: NOW, nativeSymbol: 'test ETH' }));
  check('an estimate that grew since the review: refused by signedFeeGuard (title "The gas estimate grew")',
    e2 instanceof aa.AaFeeRoseError && e2.reason === 'gas' && ca.describeColdAaError(e2, 'prepare', { deployed: false }).title === aa.AA_GAS_GREW_TITLE);

  const w3 = world();
  const q3 = await quoted(w3);
  w3.state.deployed = true;
  const e3 = await rejection(() => ca.prepareColdAaRequest({ bundle: q3.bundle, owner: OWNER, quote: q3.quote, nowSeconds: NOW, nativeSymbol: 'test ETH' }));
  check('a deployment that changed between the review and the request is refused (COLD_AA_DEPLOYMENT_CHANGED)', e3?.message === ca.COLD_AA_DEPLOYMENT_CHANGED, e3?.message);

  const e4 = await rejection(() => ca.prepareColdAaRequest({ bundle: q3.bundle, owner: OWNER, quote: { ...q3.quote, sponsored: true }, nowSeconds: NOW, nativeSymbol: 'test ETH' }));
  const e5 = await rejection(() => ca.prepareColdAaRequest({ bundle: q3.bundle, owner: OWNER, quote: { ...q3.quote, tokenGas: { source: 'circle' } }, nowSeconds: NOW, nativeSymbol: 'test ETH' }));
  const e6 = await rejection(() => ca.prepareColdAaRequest({ bundle: q3.bundle, owner: OWNER, quote: { ...q3.quote, passkey: true }, nowSeconds: NOW, nativeSymbol: 'test ETH' }));
  const e7 = await rejection(() => ca.prepareColdAaRequest({ bundle: q3.bundle, owner: OWNER, quote: { ...q3.quote, eip7702: { upgrade: true, delegate: TO } }, nowSeconds: NOW, nativeSymbol: 'test ETH' }));
  check('sponsored and token-fee quotes refused (COLD_AA_SELF_PAID_ONLY); passkey and 7702 quotes refused (COLD_AA_BUNDLE_REFUSAL)',
    e4?.message === ca.COLD_AA_SELF_PAID_ONLY && e5?.message === ca.COLD_AA_SELF_PAID_ONLY && e6?.message === ca.COLD_AA_BUNDLE_REFUSAL && e7?.message === ca.COLD_AA_BUNDLE_REFUSAL);
}

// ===========================================================================
console.log('check-cold-aa: the QR parts ("SW-CU:", never "SW-CS:")');
// ===========================================================================
{
  const payload = serializeColdUserOpRequest(deployingRequest);
  const parts = ca.splitColdAaQrParts(payload) ?? [];
  check(`a deploying request (${payload.length} bytes) is 2–3 parts, every one "SW-CU:<n>/<total>:" within 858 bytes`,
    parts.length >= 2 && parts.length <= 3 && parts.every((p, i) => p.startsWith(`SW-CU:${i + 1}/${parts.length}:`) && Buffer.byteLength(p) <= 858), String(parts.length));
  check('…none uses the regular cold-signing prefix "SW-CS:" or the multisig\'s "SW-MS:"', parts.every((p) => !p.startsWith('SW-CS:') && !p.startsWith('SW-MS:')) && ca.COLD_AA_QR_PART_PREFIX === 'SW-CU:');
  let scan = null;
  let out = null;
  for (const p of [...parts].reverse()) {
    const r = ca.acceptColdAaQrScan(scan, p);
    if (r.kind === 'complete') out = r.text;
    else scan = r.scan;
  }
  check('…read back in reverse order, the parts join to the exact payload', out === payload);
  const csPart = (cs.splitColdSignQrParts('x'.repeat(2000)) ?? [])[0];
  const mid = ca.acceptColdAaQrScan(null, parts[0]);
  check('a regular cold-signing part never joins a smart-account code (refused mid-collection)', mid.kind === 'partial' && /not part of the code being read/.test(thrown(() => ca.acceptColdAaQrScan(mid.scan, csPart))?.message ?? ''));
  const regular = cs.acceptColdSignQrScan(null, parts[0]);
  check('…and the regular scanner treats a "SW-CU:" part as plain text (it never completes as its parts), which the signature check then refuses',
    regular.kind === 'complete' && regular.text === parts[0]);
  check('a damaged "SW-CU:" part has its own sentence', thrown(() => ca.acceptColdAaQrScan(null, 'SW-CU:3/2:abc'))?.message === ca.COLD_AA_QR_DAMAGED);
  check('the part captions (exact)', ca.coldAaQrPartCaption(0, 3) === 'Smart-account signing request — part 1 of 3' && ca.coldAaQrPartCaption(0, 1) === 'Smart-account signing request');
}

// ===========================================================================
console.log('check-cold-aa: the signature and the submission');
// ===========================================================================
{
  const w = world();
  const { bundle, quote } = await quoted(w);
  const request = await ca.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH', requestId: RID(3) });
  const good = signAs(ownerKey, request);
  check('the owner\'s signature passes the local check against the STORED request', ca.verifyColdAaSignature(good, request, NOW).signer === OWNER);
  const part = (ca.splitColdAaQrParts('y'.repeat(2000)) ?? [])[0];
  check('a pasted part is refused', /This is part 1 of \d+ of a multi-part QR code/.test(thrown(() => ca.verifyColdAaSignature(part, request, NOW))?.message ?? ''));
  check('another key\'s signature is refused (the engine\'s sentence)', thrown(() => ca.verifyColdAaSignature(signAs(strangerKey, request), request, NOW))?.message === coldUserOpWrongSigner(strangerKey.address, OWNER));
  const otherReq = await (async () => {
    const wo = world();
    const q = await quoted(wo);
    return ca.prepareColdAaRequest({ bundle: q.bundle, owner: OWNER, quote: q.quote, nowSeconds: NOW, nativeSymbol: 'test ETH', requestId: RID(4) });
  })();
  check('a signature for another request is refused', thrown(() => ca.verifyColdAaSignature(signAs(ownerKey, otherReq), request, NOW))?.message === COLD_USEROP_OTHER_REQUEST);
  check('the request scanned instead of its signature is refused', thrown(() => ca.verifyColdAaSignature(serializeColdUserOpRequest(request), request, NOW))?.message === COLD_USEROP_IS_THE_REQUEST);
  check('after the expiry the check refuses with the engine\'s COLD_USEROP_EXPIRED', thrown(() => ca.verifyColdAaSignature(good, request, NOW + 1801))?.message === COLD_USEROP_EXPIRED);
  check('a bad scan keeps the request (back false); an expired one does not (back true)',
    ca.describeColdAaError(thrown(() => ca.verifyColdAaSignature(signAs(strangerKey, request), request, NOW)), 'submit', { deployed: false }).back === false &&
      ca.describeColdAaError(thrown(() => ca.verifyColdAaSignature(good, request, NOW + 1801)), 'submit', { deployed: false }).back === true);

  // Expired at submission: nothing goes to the bundler.
  const e1 = await rejection(() => ca.submitColdAa({ bundle, request, quote, signatureText: good, nowSeconds: NOW + 1801 }));
  check('an expired request is refused at submission with nothing sent', e1?.message === COLD_USEROP_EXPIRED && w.state.sends.length === 0);
  // Fees that differ from the reviewed quote.
  const e2 = await rejection(() => ca.submitColdAa({ bundle, request, quote: { ...quote, maxFeePerGas: quote.maxFeePerGas + 1n }, signatureText: good, nowSeconds: NOW }));
  check('a request whose fees differ from the reviewed quote is refused (COLD_AA_FEES_DIFFER)', e2?.message === ca.COLD_AA_FEES_DIFFER && w.state.sends.length === 0);
  // The floor rose after signing: a fresh request, never a reprice.
  w.state.floor = { slowPriority: 9_000_000n, priority: 9_000_000n, maxFee: 20_000_000n };
  const e3 = await rejection(() => ca.submitColdAa({ bundle, request, quote, signatureText: good, nowSeconds: NOW }));
  const d3 = ca.describeColdAaError(e3, 'submit', { deployed: false, sender: SENDER });
  check('a floor that rose after signing: refused before eth_sendUserOperation (AaFeeRoseError "floor")', e3 instanceof aa.AaFeeRoseError && e3.reason === 'floor' && w.state.sends.length === 0);
  check('…with the Send screen\'s title, "the signature cannot be reused", never "Nothing was signed", back to the form',
    d3.title === aa.AA_FEE_ROSE_TITLE && d3.detail.endsWith(ca.COLD_AA_FEE_ROSE_AFTER_SIGNING) && !d3.detail.includes(aa.AA_FEE_ROSE_NEXT_STEP) && d3.back === true, d3.detail);
  check('…the bundler\'s own floor refusal reads the same title', ca.describeColdAaError(new Error('RPC error -32602: maxPriorityFeePerGas must be at least 32305086'), 'submit', { deployed: false }).title === aa.AA_FEE_ROSE_TITLE);
  w.state.floor = { slowPriority: 1_000_000n, priority: 1_000_000n, maxFee: 2_000_000n };

  // Success: one eth_sendUserOperation, the 'cold-aa' event, the pending card.
  const events = [];
  const off = aa.addAaOperationSentListener((ev) => {
    events.push(ev);
  });
  const store = memoryStore();
  const offRecorder = aa.addAaOperationSentListener(pending.pendingUserOpRecorder(store));
  const sent = await ca.submitColdAa({ bundle, request, quote, signatureText: good, nowSeconds: NOW });
  off();
  offRecorder();
  const op = w.state.sends[0];
  const sig = ethers.Signature.from(JSON.parse(good));
  check('accepted: exactly one eth_sendUserOperation, signature r‖s‖(27 + yParity), the request\'s fees',
    w.state.sends.length === 1 && op.signature.toLowerCase() === (sig.r + sig.s.slice(2) + (27 + sig.yParity).toString(16)).toLowerCase() &&
      BigInt(op.maxFeePerGas) === quote.maxFeePerGas && sent.userOpHash === '0x' + 'ab'.repeat(32));
  check('…the recovered signer over the signing digest is the owner (ethers)', ethers.recoverAddress(request.signingDigest, sig) === OWNER);
  check('…one operation event with kind "cold-aa", the smart account as sender, the watched owner as owner, on Sepolia',
    events.length === 1 && events[0].kind === 'cold-aa' && events[0].sender === SENDER && events[0].owner === OWNER && events[0].chain === SEPOLIA && events[0].resend === null);
  await new Promise((r) => setTimeout(r, 10));
  const ops = pending.userOpsFor((await pending.loadPendingRegistry(store)).records, SEPOLIA, OWNER);
  check('…the pending card records it: "Smart-account operation 0x… from an off-line signer." (no Speed up / Cancel, no "Send again")',
    ops.length === 1 && ops[0].origin === 'cold-aa' && pending.userOpCardTitle(ops[0]) === `Smart-account operation ${pending.shortHash(sent.userOpHash)} from an off-line signer.` &&
      !pending.userOpCanBeSentAgain(ops[0]), JSON.stringify(ops));
  check('…its retry sentence (exact)', pending.USEROP_RETRY_SENTENCES['cold-aa'] ===
    'To try again, open Send with an off-line signer, review the send again and have the new request signed; nothing is resent from here.');
  // The nonce moved meanwhile (another operation used it): the engine's chain check.
  const w5 = world();
  const q5 = await quoted(w5);
  const r5 = await ca.prepareColdAaRequest({ bundle: q5.bundle, owner: OWNER, quote: q5.quote, nowSeconds: NOW, nativeSymbol: 'test ETH' });
  w5.state.nonce = 1n;
  const e5 = await rejection(() => ca.submitColdAa({ bundle: q5.bundle, request: r5, quote: q5.quote, signatureText: signAs(ownerKey, r5), nowSeconds: NOW }));
  check('a nonce used by another operation: the engine refuses (ExternalSignatureError), nothing sent, back to the form',
    e5?.name === 'ExternalSignatureError' && w5.state.sends.length === 0 && ca.describeColdAaError(e5, 'submit', { deployed: false }).back === true, e5?.message);
}

// ===========================================================================
console.log('check-cold-aa: a submission with no answer from the bundler (phase 23 item 8)');
// ===========================================================================
{
  const { mock } = await import('node:test');
  const { httpTransport, BROADCAST_TIMEOUT_MS } = await import('@shiba-wallet/chains-evm');
  const outcome = await import('../src/wallet/broadcast-outcome.ts');
  const realSetTimeout = globalThis.setTimeout;
  const w = world();
  let reachedResolve;
  const reached = new Promise((r) => (reachedResolve = r));
  const store = memoryStore();
  let atSend = null;
  let sendRequests = 0;
  const silentFetch = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    if (method === 'eth_sendUserOperation') {
      sendRequests += 1;
      atSend = store.map ? store.map.get(pending.PENDING_TX_KEY) ?? null : await store.getItem(pending.PENDING_TX_KEY);
      reachedResolve();
      return new Promise(() => undefined);
    }
    let body;
    try {
      body = { jsonrpc: '2.0', id, result: await w.bundler(method, params) };
    } catch (e) {
      body = { jsonrpc: '2.0', id, error: { code: -32601, message: e.message.replace(/^RPC error -?\d+: /, '') } };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  const httpBundler = httpTransport(BUNDLER_URL, silentFetch);
  w.transportFor = (url) => (url === BUNDLER_URL ? httpBundler : w.node);
  const { bundle, quote } = await quoted(w);
  const request = await ca.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH', requestId: RID(9) });
  const good = signAs(ownerKey, request);
  const offRec = aa.addAaBroadcastRecorder(pending.pendingUserOpBroadcastRecorder(store));
  const events = [];
  const off = aa.addAaOperationSentListener((ev) => void events.push(ev));
  mock.timers.enable({ apis: ['setTimeout'] });
  let err;
  try {
    const p = ca.submitColdAa({ bundle, request, quote, signatureText: good, nowSeconds: NOW }).then(() => null, (e) => e);
    await Promise.race([reached, new Promise((r) => realSetTimeout(r, 5_000))]);
    mock.timers.tick(BROADCAST_TIMEOUT_MS);
    err = await p;
  } finally {
    mock.timers.reset();
  }
  offRec();
  off();
  const listed = atSend ? pending.parseRegistry(atSend).records.filter((r) => r.kind === 'userop') : [];
  check('listed BEFORE eth_sendUserOperation under the request\'s own userOpHash, origin cold-aa, the watched owner',
    listed.length === 1 && listed[0].userOpHash === request.userOpHash.toLowerCase() && listed[0].origin === 'cold-aa' && listed[0].owner === OWNER.toLowerCase());
  check('no answer in 60 s: an unknown outcome under that hash, the record kept, no operation event',
    err?.name === 'BroadcastOutcomeUnknownError' && err.kind === 'userop' && err.hash === request.userOpHash.toLowerCase() && err.recorded === true && events.length === 0);
  const d = ca.describeColdAaError(err, 'submit', { deployed: false, sender: SENDER });
  check('described with the outcome-unknown title and the operation sentence, back to the form, never "not sent"',
    d.title === outcome.BROADCAST_OUTCOME_UNKNOWN_TITLE && d.detail.startsWith(outcome.BROADCAST_USEROP_UNKNOWN_SENTENCE) && d.back === true && !/not sent|nothing was sent/i.test(d.title + d.detail));
  const again = await rejection(() => ca.submitColdAa({ bundle, request, quote, signatureText: good, nowSeconds: NOW }));
  check('the same signed request cannot be submitted again from this phone (no second request)', again?.name === 'BroadcastAlreadyHandedOverError' && sendRequests === 1);
  check('…described with its own title, back to the form', ca.describeColdAaError(again, 'submit', { deployed: false }).title === outcome.BROADCAST_ALREADY_HANDED_OVER_TITLE && ca.describeColdAaError(again, 'submit', { deployed: false }).back === true);
}

// ===========================================================================
console.log('check-cold-aa: zero signing, zero secure-store reads');
// ===========================================================================
{
  const counts = { get: 0, set: 0, delete: 0 };
  const items = new Map();
  const backend = {
    whenUnlockedThisDeviceOnly: 5,
    async getItemAsync(k, o) {
      counts.get += 1;
      return items.get(`${o?.keychainService ?? ''}|${k}`) ?? null;
    },
    async setItemAsync(k, v, o) {
      counts.set += 1;
      items.set(`${o?.keychainService ?? ''}|${k}`, v);
    },
    async deleteItemAsync(k, o) {
      counts.delete += 1;
      items.delete(`${o?.keychainService ?? ''}|${k}`);
    },
    canUseBiometricAuthentication: () => false,
  };
  const keyStore = createKeyVault(backend, { policy: 'off' });
  await keyStore.saveNewPhrase(TEST_MNEMONIC); // the very phrase whose index-8 key is the owner
  counts.get = 0;
  counts.set = 0;
  counts.delete = 0;
  const w = world();
  const { bundle, quote } = await quoted(w);
  const request = await ca.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH' });
  const text = (() => {
    let scan = null;
    for (const p of ca.splitColdAaQrParts(serializeColdUserOpRequest(request)) ?? []) {
      const r = ca.acceptColdAaQrScan(scan, p);
      if (r.kind === 'complete') return r.text;
      scan = r.scan;
    }
    return null;
  })();
  const signerSide = parseColdUserOpRequest(text);
  const signature = signAs(ownerKey, signerSide);
  ca.verifyColdAaSignature(signature, request, NOW);
  await ca.submitColdAa({ bundle, request, quote, signatureText: signature, nowSeconds: NOW });
  check('the whole flow (quote → request → QR → signature → check → submit): ZERO secure-store reads and writes', counts.get === 0 && counts.set === 0 && counts.delete === 0, JSON.stringify(counts));
  check('…the bundle\'s spec never signs: the address-only owner throws if asked', /off-line signer/.test(thrown(() => aa.addressOnlyOwner(OWNER).sign(new Uint8Array(32)))?.message ?? '') || /cannot sign/.test(thrown(() => aa.addressOnlyOwner(OWNER).sign(new Uint8Array(32)))?.message ?? ''));

  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const forbidden = [/\bsignWith\b/, /requireLocalAuth/, /readPhrase/, /importedKeyVault/, /SecureStore/, /readSecureItem/, /\bvault\b/, /signEip1559/, /deriveAccount/, /\.sign\(/];
  const problems = (raw) => forbidden.filter((re) => re.test(code(raw))).map(String);
  for (const rel of ['src/wallet/cold-aa.ts', 'src/screens/ColdSignScreen.tsx', 'src/screens/ColdSignViews.tsx']) {
    check(`${rel}: never signs, never asks for the device check, never reads the phrase, a key or secure storage (source)`, problems(source(rel)).length === 0, problems(source(rel)).join(' '));
  }
  check('…mutant caught: a module that calls signWith', problems(source('src/wallet/cold-aa.ts') + '\nsignWith(x);').length === 1);
  // The import closure of the module reaches no key storage.
  const closure = (startRel) => {
    const seen = new Set();
    const bare = new Set();
    const visit = (abs) => {
      if (seen.has(abs)) return;
      seen.add(abs);
      const text = readFileSync(abs, 'utf8');
      for (const m of text.matchAll(/(?:^|\n)\s*(import|export)(\s+type\b)?[^'"]*?from\s+'([^']+)'/g)) {
        if (m[2]) continue;
        const spec = m[3];
        if (!spec.startsWith('.')) {
          bare.add(spec);
          continue;
        }
        const base = resolvePath(dirname(abs), spec);
        const found = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((c) => {
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
  const c = closure('src/wallet/cold-aa.ts');
  const bad = c.files.filter((f) => /wallet\/(storage|WalletContext|biometric)\.tsx?$/.test(f));
  check('cold-aa.ts\'s import graph loads no key vault (storage.ts), wallet context or device check, nor expo-secure-store at run time',
    bad.length === 0 && !c.bare.includes('expo-secure-store'), bad.join(', '));
}

// ===========================================================================
console.log('check-cold-aa: the screen wiring (source)');
// ===========================================================================
{
  const screen = source('src/screens/ColdSignScreen.tsx');
  const views = source('src/screens/ColdSignViews.tsx');
  const send = source('src/screens/SendScreen.tsx');
  const onAaShow = screen.slice(screen.indexOf('const onAaShow = async'), screen.indexOf('const onAaSignatureText'));
  check('"Show for the off-line signer": endpoint pinning, then the spending limits, then prepareColdAaRequest; a failure goes back to the form',
    onAaShow.indexOf('aaEndpointStillQuoted()') > 0 && onAaShow.indexOf('aaEndpointStillQuoted()') < onAaShow.indexOf('spendingGateForQuote(') &&
      onAaShow.indexOf('if (!allowed) return;') < onAaShow.indexOf('prepareColdAaRequest(') && /catch \(e\) \{[\s\S]*aaBackToForm\(\);/.test(onAaShow));
  const onAaSubmit = screen.slice(screen.indexOf('const onAaSubmit = async'), screen.indexOf('const onReview = async'));
  check('submission needs a checked signature, pins the endpoint, goes through submitColdAa, records the spend after acceptance, waits for the receipt',
    onAaSubmit.includes('if (!aaQuote || !aaRequest || !aaSignature || !bundle || !from) return;') && onAaSubmit.indexOf('aaEndpointStillQuoted()') < onAaSubmit.indexOf('submitColdAa(') &&
      onAaSubmit.indexOf('submitColdAa(') < onAaSubmit.indexOf('recordAcceptedSpend(') && onAaSubmit.includes('waitForAaReceipt(bundle, userOpHash, { timeoutMs: 120_000, pollMs: 3_000 })') &&
      onAaSubmit.includes("if (d.back) aaBackToForm();"));
  check('a scanned or pasted signature is checked against the STORED request', screen.includes('verifyColdAaSignature(text, aaRequest, nowSeconds());'));
  check('the request\'s codes use the smart-account kind ("SW-CU:") and its caption; the scanner too',
    // Phase 23 item 8: the cold-aa sentences are shown through the string table (localize).
    screen.includes('<ColdSignPayloadQr payload={payload} caption={localize(COLD_AA_REQUEST_CAPTION)} kind={COLD_AA_QR_KIND} />') &&
      /<ColdSignScanButton[\s\S]{0,200}onComplete=\{onAaSignatureText\}/.test(screen) && screen.includes('kind={COLD_AA_QR_KIND}'));
  check('…the scanner of the smart-account view passes the SW-CU kind', /rationale=\{localize\(COLD_AA_SCAN_RATIONALE\)\}[\s\S]{0,120}/.test(screen));
  check('the switch is offered only when coldOwnerAaRefusal allows it, never in replacement mode', screen.includes('const aaOffered = aaConfig !== null && from !== null && aaRefusal === null && !replace;') &&
    screen.includes('accessibilityLabel={localize(COLD_AA_SWITCH_LABEL)}'));
  check('Review and Max follow the switch', screen.includes('onPress={() => void (aaActive ? onAaReview() : onReview())}') && screen.includes('if (aaActive) return onAaMax();'));
  check('the confirm shows the Send screen\'s smart-account rows: "Will deploy with this send", the deposit note, the preview with every call, the risk card, the spending notice',
    ['Will deploy with this send', '<AaDepositNote', 'batch={quote.calls.map(', '<RiskWarnings url={url} wallet={quote.sender} {...aaRiskWarningTarget(quote)} />', '<SpendingPolicyNotice owner={owner} quote={quote} from={owner} />', '{localize(COLD_AA_ESTIMATE_PASSED)}'].every((s) => views.includes(s)));
  check('"Bundler gas estimate passed" is byte-identical to the Send screen\'s line', send.includes(ca.COLD_AA_ESTIMATE_PASSED));
  check('the success view: "Sent to bundler ✓", the userOpHash, the receipt states, the note field with the userOpHash',
    screen.includes('Sent to bundler ✓') && screen.includes('<TransactionNoteField network={evmChain.caip2} txid={aaResult.txHash} userOpHash={aaResult.userOpHash} />') &&
      screen.includes('Bundling… waiting for the UserOperation receipt.'));
  check('the request view shows the expiry line, the fixed-fees note and the worst case decoded from the request', screen.includes('{coldAaExpiryLine(aaRequest)}') &&
    screen.includes('{localize(COLD_AA_FEES_FIXED_NOTE)}') && screen.includes('coldUserOpDetails(aaRequest)'));
  check('the regular flow is untouched: its codes keep the default "SW-CS:" kind', screen.includes('<ColdSignPayloadQr payload={payload} caption="Unsigned transaction for the off-line signer" />'));
  check('the views default to the regular kind', views.includes('kind = COLD_SIGN_QR_KIND') && views.includes('split: splitColdSignQrParts,') && views.includes('split: splitColdAaQrParts,'));
}

// ===========================================================================
console.log('check-cold-aa: readiness and the exact strings');
// ===========================================================================
{
  const f = featureReadiness('cold-aa');
  check('the readiness row cold-aa: testnet-only, enforced, evidence C1 C2 C3 W9 T-89', f.status === 'testnet-only' && f.enforced && f.evidence.join() === 'C1,C2,C3,W9,T-89');
  check('…refused on mainnet, allowed on Sepolia, listed once', !isFeatureAllowed('cold-aa', 'eip155:1') && isFeatureAllowed('cold-aa', SEPOLIA) && FEATURE_READINESS.filter((x) => x.id === 'cold-aa').length === 1);
  check('…the reason (exact)', f.reason ===
    'Sending from a watched address’s smart account with an off-line signer runs on the Kernel v3.3 account, which has no published audit, and the signing request is this wallet’s own format, which no hardware signer reads yet. The off-line signature fixes the network fees, so a fee rise before submission means a new request and a new signature. This wallet offers it only on test networks.');
  const exact = [
    [ca.COLD_AA_SWITCH_LABEL, 'Send from the smart account'],
    [ca.COLD_AA_SUBMIT_BUTTON, 'Submit to the bundler'],
    [ca.COLD_AA_REQUEST_CAPTION, 'Smart-account signing request'],
    [ca.COLD_AA_OWNER_ROW_LABEL, 'Owner (signs off-line)'],
    [ca.COLD_AA_ESTIMATE_PASSED, 'Bundler gas estimate passed (eth_estimateUserOperationGas simulated the operation).'],
    [ca.COLD_AA_QR_DAMAGED, 'This QR code looks like part of a Shiba Wallet smart-account signing code, but it is damaged. Scan it again.'],
    [ca.COLD_AA_SELF_PAID_ONLY, 'Signing with an off-line signer from a smart account is offered only when the account pays its own network fee: no paymaster and no fee in a token. Nothing was prepared.'],
    [ca.COLD_AA_BUNDLE_REFUSAL, 'This operation can only be prepared for the watched address’s own Kernel v3.3 smart account, paying its own network fee: not for an EIP-7702 account, a recovered or multi-signature account, a passkey or session key, or with a paymaster. Nothing was prepared.'],
    [ca.COLD_AA_FEE_ROSE_AFTER_SIGNING, 'Nothing was sent. The off-line signature covers the old fees and cannot be reused: review the send again and have the new request signed. The wallet never raises the fees of a signed operation.'],
    [ca.COLD_AA_DEPLOYMENT_CHANGED, 'The smart account’s deployment changed since you reviewed this send (another operation deployed it), so the reviewed fee no longer describes it. Nothing was prepared; review the send again.'],
    [ca.COLD_AA_FORMAT_NOTE, 'This is Shiba Wallet’s own request format (shiba-wallet/cold-sign-userop-request, version 1), not the EIP-4527 format some hardware signers read, so the off-line signer must understand this format.'],
    [ca.COLD_AA_CHECK_ON_SIGNER, 'Before signing, check on the off-line signer that it decodes the same recipient, amount, network, smart account and worst-case fee as this screen. Sign only if they match.'],
    [ca.COLD_AA_FEES_FIXED_NOTE, 'The network fees are fixed now: the owner’s signature covers them, so they cannot be raised after signing. If the bundler’s minimum fee rises above them before you submit, the wallet refuses to submit, and you review the send again and have a new request signed.'],
    [ca.COLD_AA_SCAN_NOTE, 'Scan the signature the off-line signer shows. A signature for a different request, from a key other than the owner’s or over a changed operation is refused. The wallet submits to the bundler only after it has checked that the owner signed exactly the operation shown above.'],
    [ca.COLD_AA_REVIEW_AGAIN_NOTE, 'The request is kept only while this screen is open, and only until it expires. If you leave, review the send again and have the new request signed; an old signature is refused for a new request.'],
    [ca.COLD_AA_PAYMASTER_NOT_USED_NOTE, 'The sponsorship paymaster saved for this network is not used here: with an off-line signer the smart account pays its own network fee.'],
    [aa.COLD_AA_7702_REFUSAL, 'This address is upgraded with EIP-7702 on this network. The wallet never prepares an operation for an off-line signer that could carry an EIP-7702 authorization, so the smart account is not offered here. Nothing was prepared.'],
    [aa.COLD_AA_RECOVERED_REFUSAL, 'A recovered smart account is attached to this address on this network. Signing with an off-line signer is offered only for the address’s own Kernel v3.3 account, whose address follows from the owner alone, so the smart account is not offered here. Nothing was prepared.'],
    [pending.USEROP_ORIGIN_PHRASES['cold-aa'], 'from an off-line signer'],
  ];
  const wrong = exact.filter(([a, b]) => a !== b).map(([a]) => String(a).slice(0, 40));
  check(`the ${exact.length} fixed sentences and labels are exact`, wrong.length === 0, wrong.join(' | '));
  check('coldAaVerifiedLine and coldAaRootChanged (exact)', ca.coldAaVerifiedLine('0xA') === 'Signature checked: made by the owner 0xA over exactly the operation shown above.' &&
    ca.coldAaRootChanged('0xS', '0xO') === 'The smart account 0xS no longer has the watched address 0xO as its signer on-chain (its root validator or its ECDSA owner is different), so a signature from the watched address would be refused. Nothing was prepared.');
}

// ===========================================================================
console.log('check-cold-aa: a checked signature is dropped when its request expires (pass p23-coldaa finding 2)');
// ===========================================================================
{
  // Fake timers and a fake clock: nothing waits.
  const fakeTimers = () => {
    const armed = [];
    let next = 1;
    return {
      armed,
      timers: {
        setTimeout: (fn, ms) => { const h = next++; armed.push({ h, fn, ms, live: true }); return h; },
        clearTimeout: (h) => { const a = armed.find((x) => x.h === h); if (a) a.live = false; },
      },
      fire: () => { const a = armed.filter((x) => x.live).at(-1); if (a) { a.live = false; a.fn(); } return a; },
      live: () => armed.filter((x) => x.live),
    };
  };
  const req = deployingRequest;
  const exp = Number(req.expiresAt);
  check('the fixture request has a lifetime (expiresAt after NOW)', exp > NOW, String(exp));
  // Armed while valid: one timer, due at the first whole second after expiresAt.
  {
    const ft = fakeTimers();
    let clock = NOW * 1000 + 250;
    let calls = 0;
    const cancel = ca.watchColdAaExpiry(req, () => { calls += 1; }, { now: () => clock, timers: ft.timers });
    check('while the request is valid nothing is reported and one timer is armed for the first second after expiresAt',
      calls === 0 && ft.live().length === 1 && ft.live()[0].ms === (exp + 1) * 1000 - clock, JSON.stringify(ft.armed.map((a) => a.ms)));
    // A timer that fires early (the clock still at expiresAt): re-armed, nothing reported.
    clock = exp * 1000 + 999;
    ft.fire();
    check('…a timer that fires while the request is still valid (at expiresAt) re-arms and reports nothing', calls === 0 && ft.live().length === 1 && ft.live()[0].ms === 1);
    clock = (exp + 1) * 1000;
    ft.fire();
    check('…at the first second after expiresAt it reports once and arms nothing more', calls === 1 && ft.live().length === 0 && ca.coldAaRequestExpired(req, Math.floor(clock / 1000)));
    cancel();
    check('…cancelling after it reported changes nothing', calls === 1);
  }
  // Late (a return from the background): reported on the first run.
  {
    const ft = fakeTimers();
    let clock = NOW * 1000;
    let calls = 0;
    ca.watchColdAaExpiry(req, () => { calls += 1; }, { now: () => clock, timers: ft.timers });
    clock = (exp + 3600) * 1000;
    ft.fire();
    check('a timer that fires an hour late reports the expiry once', calls === 1 && ft.live().length === 0);
  }
  // Already expired: at once, no timer.
  {
    const ft = fakeTimers();
    let calls = 0;
    ca.watchColdAaExpiry(req, () => { calls += 1; }, { now: () => (exp + 1) * 1000, timers: ft.timers });
    check('an already expired request is reported at once and no timer is armed', calls === 1 && ft.armed.length === 0);
  }
  // Cancelled before the expiry: never reported.
  {
    const ft = fakeTimers();
    let clock = NOW * 1000;
    let calls = 0;
    const cancel = ca.watchColdAaExpiry(req, () => { calls += 1; }, { now: () => clock, timers: ft.timers });
    cancel();
    clock = (exp + 10) * 1000;
    const a = ft.armed[0];
    check('a cancelled watch clears its timer and never reports (a new request or a cleared signature cancels it)', a && a.live === false && calls === 0);
    a.fn();
    check('…even if the platform runs the cleared callback anyway', calls === 0);
  }
  // A far expiry never arms more than setTimeout's 32-bit limit.
  {
    const ft = fakeTimers();
    ca.watchColdAaExpiry({ ...req, expiresAt: String(NOW + 40 * 86_400) }, () => {}, { now: () => NOW * 1000, timers: ft.timers });
    check('a wait longer than setTimeout\'s limit is armed at the limit and re-armed', ft.live()[0].ms === ca.COLD_AA_EXPIRY_TIMER_MAX_MS);
  }
  // The screen: the watch runs while a checked signature is shown, drops it, shows the expired sentence; Submit re-checks.
  const screen = source('src/screens/ColdSignScreen.tsx');
  check('the screen watches the expiry while a checked signature is shown, then clears it (Submit disabled) and shows the engine\'s expired sentence',
    /useEffect\(\(\) => \{\n    if \(phase !== 'aa-show' \|\| !aaRequest \|\| !aaSignature\) return undefined;\n    return watchColdAaExpiry\(aaRequest, \(\) => \{\n      setAaSignature\(null\);\n      setSignatureError\(COLD_USEROP_EXPIRED\);\n    \}\);\n  \}, \[phase, aaRequest, aaSignature\]\);/.test(screen) &&
      screen.includes('<Button title={COLD_AA_SUBMIT_BUTTON} disabled={!aaSignature} onPress={() => void onAaSubmit()} />'));
  const onAaSubmit = screen.slice(screen.indexOf('const onAaSubmit = async'), screen.indexOf('const onReview = async'));
  check('…and Submit refuses an expired request itself, before the endpoint check and before submitColdAa',
    onAaSubmit.indexOf('if (coldAaRequestExpired(aaRequest, nowSeconds())) {') > 0 &&
      onAaSubmit.indexOf('if (coldAaRequestExpired(aaRequest, nowSeconds())) {') < onAaSubmit.indexOf('aaEndpointStillQuoted()') &&
      onAaSubmit.indexOf('aaEndpointStillQuoted()') < onAaSubmit.indexOf('submitColdAa('));
}

// ===========================================================================
console.log('check-cold-aa: mutation checks (broken copies must fail)');
// ===========================================================================
{
  // M1: the regular prefix.
  const m1 = await mutant('src/wallet/cold-aa.ts', "export const COLD_AA_QR_PART_PREFIX = 'SW-CU:';", "export const COLD_AA_QR_PART_PREFIX = 'SW-CS:';");
  check('M1 caught: with the "SW-CS:" prefix the parts no longer start "SW-CU:"', !(m1.splitColdAaQrParts('z'.repeat(2000)) ?? []).every((p) => p.startsWith('SW-CU:')));
  // M2: no claim (a quote could yield two requests).
  const m2 = await mutant('src/wallet/cold-aa.ts', '  claimQuoteForSubmission(quote);\n', '');
  {
    const w = world();
    const { bundle, quote } = await quoted(w);
    await m2.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH' });
    check('M2 caught: without the claim a second request is built from the same quote', (await rejection(() => m2.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH' }))) === null);
  }
  // M3: no floor check at submission.
  const m3 = await mutant('src/wallet/cold-aa.ts', '      await assertQuoteFeesMeetBundlerFloor(bundle.bundler, fees);\n', '');
  {
    const w = world();
    const { bundle, quote } = await quoted(w);
    const request = await m3.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH' });
    w.state.floor = { slowPriority: 9_000_000n, priority: 9_000_000n, maxFee: 20_000_000n };
    await m3.submitColdAa({ bundle, request, quote, signatureText: signAs(ownerKey, request), nowSeconds: NOW });
    check('M3 caught: without the floor check a signed operation goes out below the bundler\'s floor', w.state.sends.length === 1);
  }
  // M4: no root check for a deployed account.
  const m4 = await mutant('src/wallet/cold-aa.ts', "  if (typeof code === 'string' && !/^0x0*$/i.test(code)) await assertColdAaRoot(bundle, sender, owner);\n", '');
  {
    const w = world({ deployed: true, rootOwner: TO });
    const e = await rejection(() => m4.quoteColdAa(bundleFor(w), OWNER, NATIVE));
    check('M4 caught: without the root check a deployed account owned by another key is quoted', e === null);
  }
  // M5: no expiry check in the local signature check.
  const m5 = await mutant('src/wallet/cold-aa.ts', '  if (coldAaRequestExpired(request, nowSeconds)) throw new ColdAaRefusedError(COLD_USEROP_EXPIRED);\n', '');
  check('M5 caught: without the expiry check an expired request\'s signature is accepted locally', thrown(() => m5.verifyColdAaSignature(signAs(ownerKey, deployingRequest), deployingRequest, NOW + 99_999)) === null);
  // M6: no deployment-state check.
  const m6 = await mutant('src/wallet/cold-aa.ts', '  if (deploys === quote.deployed) throw new ColdAaRefusedError(COLD_AA_DEPLOYMENT_CHANGED);\n', '');
  {
    const w = world();
    const { bundle, quote } = await quoted(w);
    w.state.deployed = true;
    check('M6 caught: without the deployment check a request is built for a reviewed "Will deploy" that no longer deploys',
      (await rejection(() => m6.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH' }))) === null);
  }
  // M7: the readiness gate removed from the factory and the refusal.
  const m7 = await mutant('src/wallet/aa.ts',
    "  if (chain === null || !isFeatureAllowed('cold-aa', chain)) return new FeatureNotAllowedError('cold-aa').message;\n", '',
    "  assertFeatureAllowed('cold-aa', eip155Caip2(options.chainId));\n", '');
  {
    const e = thrown(() => m7.createColdOwnerAaClient(config({ chain: 'eip155:1' }), { nodeUrl: NODE_URL, chainId: 1n, ownerAddress: OWNER }));
    check('M7 caught: without the cold-aa gate mainnet is no longer refused with the cold-aa reason', e?.message !== readinessRefusal('cold-aa'));
  }
  // M8: the factory attaches the saved paymaster.
  const m8 = await mutant('src/wallet/aa.ts',
    "    ...(options.estimateRetries ? { estimateRetries: options.estimateRetries } : {}),\n  });\n}\n",
    "    ...(options.estimateRetries ? { estimateRetries: options.estimateRetries } : {}),\n    ...(config.paymasterUrl ? { paymaster: { url: config.paymasterUrl, contextJson: config.paymasterContext } } : {}),\n  });\n}\n");
  {
    const w = world();
    const b = m8.createColdOwnerAaClient(config({ paymasterUrl: 'https://paymaster.example/rpc' }), { nodeUrl: NODE_URL, chainId: 11155111n, ownerAddress: OWNER, transportFor: w.transportFor });
    check('M8 caught: a factory that attaches the saved paymaster makes a sponsored bundle, which the cold path refuses', b.sponsored === true && thrown(() => ca.assertColdAaBundle(b))?.message === ca.COLD_AA_BUNDLE_REFUSAL);
  }
  // M9: the pending registry without the new origin.
  const m9 = await mutant('src/wallet/pending-transactions.ts', "  'cold-aa',\n  'handle',\n  'other',\n];", "  'handle',\n  'other',\n];");
  {
    const legacy = { kind: 'userop', chain: SEPOLIA, userOpHash: '0x' + 'cd'.repeat(32), sender: SENDER.toLowerCase(), owner: OWNER.toLowerCase(), sentAt: NOW, resend: null, origin: 'cold-aa' };
    check('M9 caught: without "cold-aa" in USEROP_ORIGINS a cold record makes the pending list read-only',
      m9.parseRegistry(JSON.stringify({ version: 1, records: [legacy] })).readOnly === true &&
        pending.parseRegistry(JSON.stringify({ version: 1, records: [legacy] })).readOnly === false);
  }
  // M10: the submission without signedFeeGuard after the floor check.
  const m10 = await mutant('src/wallet/cold-aa.ts', '      guard(op);\n', '');
  {
    // A quote whose displayed fee is one wei below the request's worst case
    // (a tampered quote stands for a grown estimate after preparation).
    const w = world();
    const { bundle, quote } = await quoted(w);
    const request = await m10.prepareColdAaRequest({ bundle, owner: OWNER, quote, nowSeconds: NOW, nativeSymbol: 'test ETH' });
    const lowered = { ...quote, fee: requiredPrefund(coldUserOpFromFields(request.sender, request.userOp)) - 1n };
    await m10.submitColdAa({ bundle, request, quote: lowered, signatureText: signAs(ownerKey, request), nowSeconds: NOW });
    const w2 = world();
    const q2 = await quoted(w2);
    const r2 = await ca.prepareColdAaRequest({ bundle: q2.bundle, owner: OWNER, quote: q2.quote, nowSeconds: NOW, nativeSymbol: 'test ETH' });
    const low2 = { ...q2.quote, fee: requiredPrefund(coldUserOpFromFields(r2.sender, r2.userOp)) - 1n };
    const e = await rejection(() => ca.submitColdAa({ bundle: q2.bundle, request: r2, quote: low2, signatureText: signAs(ownerKey, r2), nowSeconds: NOW }));
    check('M10 caught: without signedFeeGuard at submission a worst case above the displayed fee is sent (the real module refuses it, "gas")',
      w.state.sends.length === 1 && e instanceof aa.AaFeeRoseError && e.reason === 'gas' && w2.state.sends.length === 0);
  }
}

console.log(`\ncheck-cold-aa: ${passed} passed, ${failed} failed (${mutantCount} mutants loaded)`);
process.exit(failed === 0 ? 0 : 1);
